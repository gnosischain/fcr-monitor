import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'fcr_' });

export const blockNumberGauge = new Gauge({
  name: 'fcr_block_number',
  help: 'Block number reported by a client for a given tag',
  labelNames: ['client', 'tag'] as const,
  registers: [registry],
});

export const blockSlotGauge = new Gauge({
  name: 'fcr_block_slot',
  help: 'Beacon slot derived from the block timestamp for a given tag',
  labelNames: ['client', 'tag'] as const,
  registers: [registry],
});

export const blockAgeGauge = new Gauge({
  name: 'fcr_block_age_seconds',
  help: 'Wall-clock age of the block a client reports for a given tag',
  labelNames: ['client', 'tag'] as const,
  registers: [registry],
});

export const lagGauge = new Gauge({
  name: 'fcr_lag_blocks',
  help: 'How far a tag trails the latest block, in blocks',
  labelNames: ['client', 'tag'] as const,
  registers: [registry],
});

export const clientUpGauge = new Gauge({
  name: 'fcr_client_up',
  help: '1 when the last poll of this client succeeded, 0 otherwise',
  labelNames: ['client'] as const,
  registers: [registry],
});

export const trackedSafeGauge = new Gauge({
  name: 'fcr_tracked_safe_blocks',
  help: 'Safe blocks currently held in Redis awaiting finalization',
  labelNames: ['client'] as const,
  registers: [registry],
});

export const lastPollGauge = new Gauge({
  name: 'fcr_last_poll_timestamp_seconds',
  help: 'Unix timestamp of the last completed poll',
  labelNames: ['client'] as const,
  registers: [registry],
});

export const reorgCounter = new Counter({
  name: 'fcr_reorgs_total',
  help: 'Reorg events detected, by client and detection type',
  labelNames: ['client', 'type'] as const,
  registers: [registry],
});

export const rpcErrorCounter = new Counter({
  name: 'fcr_rpc_errors_total',
  help: 'Failed JSON-RPC calls',
  labelNames: ['client', 'tag'] as const,
  registers: [registry],
});

export const rpcDuration = new Histogram({
  name: 'fcr_rpc_duration_seconds',
  help: 'Latency of a full poll cycle against one client',
  labelNames: ['client'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const walkTruncatedCounter = new Counter({
  name: 'fcr_walk_truncated_total',
  help: 'Times a backfill or finalization walk hit MAX_WALK_BLOCKS and covered less than the full gap',
  labelNames: ['client', 'phase'] as const,
  registers: [registry],
});

export const divergenceGauge = new Gauge({
  name: 'fcr_client_divergence',
  help: '1 when Nimbus and Lodestar report different hashes for the same block number',
  labelNames: ['tag'] as const,
  registers: [registry],
});

/** Seed counters so a freshly started monitor exports 0 rather than nothing at all. */
export function initClientMetrics(clients: string[]): void {
  for (const client of clients) {
    for (const type of ['finalized_mismatch', 'safe_reorg', 'safe_regression']) {
      reorgCounter.inc({ client, type }, 0);
    }
    clientUpGauge.set({ client }, 0);
  }
  divergenceGauge.set({ tag: 'safe' }, 0);
  divergenceGauge.set({ tag: 'finalized' }, 0);
}
