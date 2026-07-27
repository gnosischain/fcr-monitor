export interface ClientConfig {
  id: string;
  label: string;
  rpcUrl: string;
  /** Consensus client version. Not discoverable over the EL RPC, so it is configured. */
  version: string;
  releaseUrl: string;
}

/** Consensus clients slated for a later phase; rendered as inactive cards. */
export interface PlannedClient {
  id: string;
  label: string;
  note: string;
}

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable ${key}`);
  return value;
}

function numeric(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`Environment variable ${key} is not a number: ${raw}`);
  return parsed;
}

const REPOSITORIES: Record<string, string> = {
  nimbus: 'https://github.com/status-im/nimbus-eth2',
  lodestar: 'https://github.com/ChainSafe/lodestar',
};

/**
 * The consensus client version cannot be read over the execution RPC — that
 * only reports the EL. It is configured, and the release link is derived from
 * it so bumping the version keeps the link honest.
 */
function client(id: string, label: string, envPrefix: string, defaultVersion: string): ClientConfig {
  const version = process.env[`${envPrefix}_CL_VERSION`] ?? defaultVersion;
  return {
    id,
    label,
    rpcUrl: required(`${envPrefix}_EL_RPC`),
    version,
    releaseUrl:
      process.env[`${envPrefix}_CL_RELEASE_URL`] ?? `${REPOSITORIES[id]}/releases#release-${version}`,
  };
}

export const config = {
  clients: [
    client('nimbus', 'Nimbus', 'NIMBUS', 'v26.7.0'),
    client('lodestar', 'Lodestar', 'LODESTAR', 'v1.44.0'),
  ] as ClientConfig[],

  plannedClients: [
    { id: 'lighthouse', label: 'Lighthouse', note: 'Coming up...' },
    { id: 'prysm', label: 'Prysm', note: 'Coming up...' },
    { id: 'teku', label: 'Teku', note: 'Coming up...' },
  ] as PlannedClient[],

  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  port: numeric('PORT', 3000),
  host: process.env.HOST ?? '0.0.0.0',

  /** One Ethereum slot. Every poll re-reads safe/finalized/latest from both clients. */
  pollIntervalMs: numeric('POLL_INTERVAL_MS', 12_000),
  rpcTimeoutMs: numeric('RPC_TIMEOUT_MS', 5_000),

  /**
   * Upper bound on how many blocks we will walk backwards in a single
   * backfill or finalization sweep. Bounds RPC cost after downtime; when it
   * bites we emit a metric and a log line rather than silently covering less.
   */
  maxWalkBlocks: numeric('MAX_WALK_BLOCKS', 96),

  /** Mainnet post-merge beacon chain parameters. */
  chain: {
    genesisTime: numeric('GENESIS_TIME', 1_606_824_023),
    slotSeconds: numeric('SLOT_SECONDS', 12),
    slotsPerEpoch: numeric('SLOTS_PER_EPOCH', 32),
  },

  /** How many epoch rows the slot grid renders. */
  epochsShown: numeric('EPOCHS_SHOWN', 4),

  /** How many reorg events to retain in Redis. */
  reorgHistory: numeric('REORG_HISTORY', 500),

  /**
   * How long a detected reorg stays on `fcr_reorg_info`. The labels include
   * block hashes, so this is a cardinality budget as much as an alerting one:
   * it must comfortably exceed Prometheus's evaluation interval plus
   * Alertmanager's group_wait, and little more.
   */
  reorgAnnounceSeconds: numeric('REORG_ANNOUNCE_SECONDS', 900),

  /** Ceiling on concurrently announced reorgs, so a chain split cannot flood the TSDB. */
  reorgAnnounceMax: numeric('REORG_ANNOUNCE_MAX', 20),
};

export function slotOfTimestamp(timestamp: number): number {
  return Math.floor((timestamp - config.chain.genesisTime) / config.chain.slotSeconds);
}

export function epochOfSlot(slot: number): number {
  return Math.floor(slot / config.chain.slotsPerEpoch);
}
