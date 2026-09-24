import { Redis } from 'ioredis';
import { config } from './config.js';
import type { BlockHeader } from './rpc.js';
import { severityOf, type FallbackEventType, type Severity } from './events.js';

export * from './events.js';

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

export interface FallbackEvent {
  id: string;
  client: string;
  type: FallbackEventType;
  /** Derived from `type` via `severityOf`; carried on the record so consumers need no type list. */
  severity: Severity;
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
const FALLBACK_EVENTS_KEY = 'fcr:fallback_events';
const STARTED_AT_KEY = 'fcr:started_at';

/**
 * Records the monitor's first-ever start. Deliberately SETNX so that the
 * "no fallback event since X" claim survives container restarts — resetting it on every
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

/**
 * Drops exactly the heights given — the ones actually compared against the finalized chain.
 *
 * Deliberately a set rather than a range. A finalization sweep verifies downwards from the
 * finalized tip, so when it is cut short the heights it missed are the *lowest* ones; a
 * range prune would delete precisely those, discarding the only evidence that a confirmed
 * block at one of them was reorged out.
 */
export async function pruneSafeBlocks(client: string, blockNumbers: Iterable<number>): Promise<number> {
  const fields = [...blockNumbers].map(String);
  if (fields.length === 0) return 0;
  await redis.hdel(safeKey(client), ...fields);
  return fields.length;
}

export async function countSafeBlocks(client: string): Promise<number> {
  return redis.hlen(safeKey(client));
}

export async function pushFallbackEvent(event: FallbackEvent): Promise<void> {
  await redis.lpush(FALLBACK_EVENTS_KEY, JSON.stringify(event));
  await redis.ltrim(FALLBACK_EVENTS_KEY, 0, config.fallbackEventHistory - 1);
}

export async function getFallbackEvents(limit = config.fallbackEventHistory): Promise<FallbackEvent[]> {
  const raw = await redis.lrange(FALLBACK_EVENTS_KEY, 0, limit - 1);
  return raw.map((entry) => {
    const event = JSON.parse(entry) as FallbackEvent;
    // Records written before `severity` existed are still in the history window.
    return event.severity ? event : { ...event, severity: severityOf(event.type) };
  });
}

export async function countFallbackEvents(): Promise<number> {
  return redis.llen(FALLBACK_EVENTS_KEY);
}

export async function saveSnapshot(snapshot: ClientSnapshot): Promise<void> {
  await redis.set(snapshotKey(snapshot.client), JSON.stringify(snapshot));
}

export async function loadSnapshot(client: string): Promise<ClientSnapshot | null> {
  const raw = await redis.get(snapshotKey(client));
  return raw ? (JSON.parse(raw) as ClientSnapshot) : null;
}
