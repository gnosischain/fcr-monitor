import { Redis } from 'ioredis';
import { config } from './config.js';
import type { BlockHeader } from './rpc.js';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  enableOfflineQueue: true,
});

redis.on('error', (error) => console.error('[redis]', error.message));

/** A block that a client reported as `safe`, held until finalization passes it. */
export interface SafeRecord {
  hash: string;
  parentHash: string;
  timestamp: number;
  /** Wall clock (unix seconds) when we first saw this block declared safe. */
  seenAt: number;
}

export type ReorgType = 'finalized_mismatch' | 'safe_reorg' | 'safe_regression';

export interface ReorgEvent {
  id: string;
  client: string;
  type: ReorgType;
  blockNumber: number;
  slot: number | null;
  epoch: number | null;
  /** The hash this client previously told us was safe at blockNumber. */
  recordedSafeHash: string;
  /** What actually turned up: the finalized hash, or the replacement safe hash. */
  observedHash: string;
  /** Unix seconds when the safe block was recorded. */
  recordedAt: number | null;
  /** Unix seconds when the mismatch was detected. */
  detectedAt: number;
  note: string;
}

export interface ClientSnapshot {
  client: string;
  label: string;
  updatedAt: number;
  online: boolean;
  error: string | null;
  safe: BlockHeader | null;
  finalized: BlockHeader | null;
  latest: BlockHeader | null;
  trackedSafeBlocks: number;
}

const safeKey = (client: string) => `fcr:safe:${client}`;
const snapshotKey = (client: string) => `fcr:snapshot:${client}`;
const REORGS_KEY = 'fcr:reorgs';
const STARTED_AT_KEY = 'fcr:started_at';

/**
 * Records the monitor's first-ever start. Deliberately SETNX so that the
 * "no reorg since X" claim survives container restarts — resetting it on every
 * boot would silently shorten the window the claim covers.
 */
export async function initStartedAt(now: number): Promise<number> {
  await redis.setnx(STARTED_AT_KEY, String(now));
  const value = await redis.get(STARTED_AT_KEY);
  return value ? Number(value) : now;
}

export async function getStartedAt(): Promise<number | null> {
  const value = await redis.get(STARTED_AT_KEY);
  return value ? Number(value) : null;
}

export async function putSafeBlock(client: string, block: BlockHeader, seenAt: number): Promise<void> {
  const record: SafeRecord = {
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
    seenAt,
  };
  await redis.hset(safeKey(client), String(block.number), JSON.stringify(record));
}

export async function getSafeBlock(client: string, blockNumber: number): Promise<SafeRecord | null> {
  const raw = await redis.hget(safeKey(client), String(blockNumber));
  return raw ? (JSON.parse(raw) as SafeRecord) : null;
}

export async function getAllSafeBlocks(client: string): Promise<Map<number, SafeRecord>> {
  const entries = await redis.hgetall(safeKey(client));
  const result = new Map<number, SafeRecord>();
  for (const [number, raw] of Object.entries(entries)) {
    result.set(Number(number), JSON.parse(raw) as SafeRecord);
  }
  return result;
}

/** Drops every tracked safe block at or below `blockNumber` — they are finalized and checked. */
export async function pruneSafeBlocksUpTo(client: string, blockNumber: number): Promise<number> {
  const tracked = await redis.hkeys(safeKey(client));
  const stale = tracked.filter((key) => Number(key) <= blockNumber);
  if (stale.length === 0) return 0;
  await redis.hdel(safeKey(client), ...stale);
  return stale.length;
}

export async function countSafeBlocks(client: string): Promise<number> {
  return redis.hlen(safeKey(client));
}

export async function pushReorg(event: ReorgEvent): Promise<void> {
  await redis.lpush(REORGS_KEY, JSON.stringify(event));
  await redis.ltrim(REORGS_KEY, 0, config.reorgHistory - 1);
}

export async function getReorgs(limit = config.reorgHistory): Promise<ReorgEvent[]> {
  const raw = await redis.lrange(REORGS_KEY, 0, limit - 1);
  return raw.map((entry) => JSON.parse(entry) as ReorgEvent);
}

export async function countReorgs(): Promise<number> {
  return redis.llen(REORGS_KEY);
}

export async function saveSnapshot(snapshot: ClientSnapshot): Promise<void> {
  await redis.set(snapshotKey(snapshot.client), JSON.stringify(snapshot));
}

export async function loadSnapshot(client: string): Promise<ClientSnapshot | null> {
  const raw = await redis.get(snapshotKey(client));
  return raw ? (JSON.parse(raw) as ClientSnapshot) : null;
}
