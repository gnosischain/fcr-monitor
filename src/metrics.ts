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

/**
 * Carries the offending block on its labels so a notification can name it.
 * `fcr_reorgs_total` says a reorg happened; this says which block, what we had
 * recorded, and what turned up instead.
 *
 * Hashes as label values are unbounded cardinality — every reorg mints a series
 * that lives for the whole retention window. So an announcement is deliberately
 * short-lived (`REORG_ANNOUNCE_SECONDS`) and the live set is capped
 * (`REORG_ANNOUNCE_MAX`): long enough for an alert to fire and reach Slack,
 * after which the series stops being exported and Prometheus marks it stale.
 * The permanent record is the counter and the Redis history, not this.
 */
export const reorgInfoGauge = new Gauge({
  name: 'fcr_reorg_info',
  help: '1 while a recently detected reorg is being announced; labels carry the offending block',
  labelNames: ['client', 'type', 'block_number', 'recorded_hash', 'observed_hash'] as const,
  registers: [registry],
});

export interface ReorgAnnouncement {
  client: string;
  type: string;
  blockNumber: number;
  /** The hash this client had previously confirmed as safe at blockNumber. */
  recordedHash: string;
  /** What actually turned up: the finalized hash, or the replacement safe hash. */
  observedHash: string;
  /** Unix seconds of detection. The announcement expires relative to this. */
  detectedAt: number;
}

type AnnouncementLabels = Record<string, string>;

const liveAnnouncements = new Map<string, { labels: AnnouncementLabels; detectedAt: number }>();

const announcementLabels = (a: ReorgAnnouncement): AnnouncementLabels => ({
  client: a.client,
  type: a.type,
  block_number: String(a.blockNumber),
  recorded_hash: a.recordedHash,
  observed_hash: a.observedHash,
});

const announcementKey = (a: ReorgAnnouncement): string =>
  `${a.client}|${a.type}|${a.blockNumber}|${a.recordedHash}|${a.observedHash}`;

/** Publishes one reorg for alerting. Re-announcing the same event refreshes its expiry. */
export function announceReorg(a: ReorgAnnouncement, ttlSeconds: number, max: number, now: number): void {
  const labels = announcementLabels(a);
  liveAnnouncements.set(announcementKey(a), { labels, detectedAt: a.detectedAt });
  reorgInfoGauge.set(labels, 1);

  // A chain split can produce reorgs in bursts. Drop the oldest past the cap so
  // a bad hour cannot blow up the series count; Redis keeps the full history.
  if (liveAnnouncements.size > max) {
    const byAge = [...liveAnnouncements.entries()].sort((x, y) => x[1].detectedAt - y[1].detectedAt);
    for (const [key, entry] of byAge.slice(0, liveAnnouncements.size - max)) {
      reorgInfoGauge.remove(entry.labels);
      liveAnnouncements.delete(key);
    }
  }

  sweepReorgAnnouncements(ttlSeconds, now);
}

/** Retires announcements past their TTL. Called every poll so expiry does not wait on the next reorg. */
export function sweepReorgAnnouncements(ttlSeconds: number, now: number): void {
  for (const [key, entry] of liveAnnouncements) {
    if (now - entry.detectedAt < ttlSeconds) continue;
    reorgInfoGauge.remove(entry.labels);
    liveAnnouncements.delete(key);
  }
}

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
