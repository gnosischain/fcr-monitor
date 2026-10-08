import { config } from './config.js';
import {
  analyticsErrorCounter,
  analyticsLastSuccessGauge,
  bridgeSamplesGauge,
  bridgeTimeGauge,
} from './metrics.js';
import { getSafeGaps, loadAnalytics, pushSafeGap, saveAnalytics, type ClientSnapshot } from './store.js';

/**
 * Bridging-time analytics from the Envio indexer, and the head-to-safe gap from our own polls.
 *
 * The browser never talks to Envio. This module fetches on its own timer, writes the
 * computed figures to Redis, and `/api/analytics` serves them from there — so a page view
 * cannot trigger an upstream request, and the indexer URL and token stay on the server.
 * If Envio is down the last good result keeps being served, marked with its age.
 */

export type Direction = 'eth_to_gc' | 'gc_to_eth';
export type BridgeType = 'XDAI' | 'AMB';

const DIRECTIONS: Direction[] = ['eth_to_gc', 'gc_to_eth'];
const BRIDGE_TYPES: BridgeType[] = ['XDAI', 'AMB'];

/** Anything slower than this is a data error, not a slow bridge. */
const MAX_PLAUSIBLE_SECONDS = 7 * 24 * 3600;
const PAGE_SIZE = 1000;
/** Bounds a single refresh at 20k rows per direction; hitting it is logged. */
const MAX_PAGES = 20;

export interface Summary {
  median: number | null;
  p90: number | null;
  min: number | null;
  max: number | null;
  count: number;
}

export interface BridgeStat extends Summary {
  direction: Direction;
  bridgeType: BridgeType;
}

export interface BridgingAnalytics {
  /** Unix seconds of the last successful fetch; null until one succeeds. */
  fetchedAt: number | null;
  lastAttemptAt: number;
  lastError: string | null;
  windowSeconds: number;
  /** Earliest initiation time counted: the window start, or ANALYTICS_START_TIMESTAMP if later. */
  since: number;
  stats: BridgeStat[];
}

/**
 * ETH→GC ends at `AffirmationCompleted`, stored as `execution`.
 * GC→ETH ends at `CollectedSignatures`, which the indexer does not timestamp; the
 * threshold-reaching `SignedForUserRequest` is emitted in the same transaction and is
 * always the last validation, so `max(validations.timestamp)` is that time. `execution`
 * in this direction is the user's Ethereum claim and must not be used.
 *
 * `ERROR` rows are excluded in both directions. The filter goes in as a variable rather
 * than inline literals so the query does not depend on how this Hasura version names the
 * BigInt scalar or spells enum values.
 */
const QUERY = `
query FcrBridgingTime($where: Transaction_bool_exp!, $limit: Int!, $offset: Int!) {
  Transaction(
    where: $where
    order_by: [{ timestamp: desc }, { id: asc }]
    limit: $limit
    offset: $offset
  ) {
    id
    bridgeType
    transactionHash
    timestamp
    execution { timestamp transactionHash }
    validations(order_by: { timestamp: desc }, limit: 1) { timestamp }
  }
}`;

interface Row {
  id: string;
  bridgeType: string;
  transactionHash: string | null;
  timestamp: string | number;
  execution: { timestamp: string | number; transactionHash: string | null } | null;
  validations: Array<{ timestamp: string | number }> | null;
}

function whereFor(direction: Direction, since: number): Record<string, unknown> {
  return direction === 'eth_to_gc'
    ? {
        _and: [
          { initiatorNetwork: { _eq: 1 } },
          { transactionStatus: { _eq: 'COMPLETED' } },
          { timestamp: { _gte: since } },
        ],
      }
    : {
        _and: [
          { initiatorNetwork: { _eq: 100 } },
          { transactionStatus: { _in: ['UNCLAIMED', 'COMPLETED'] } },
          { timestamp: { _gte: since } },
        ],
      };
}

/** Seconds from the source event to the end event, or null if the row cannot be trusted. */
export function durationOf(direction: Direction, row: Row): number | null {
  const start = Number(row.timestamp);
  if (!Number.isFinite(start) || start <= 0) return null;

  let end: number;
  if (direction === 'eth_to_gc') {
    if (!row.execution) return null;
    // Created by AffirmationCompleted itself because the start event predates the
    // indexer: its "start" is really the end, giving a bogus zero.
    if (row.transactionHash && row.transactionHash === row.execution.transactionHash) return null;
    end = Number(row.execution.timestamp);
  } else {
    const last = row.validations?.[0];
    if (!last) return null;
    end = Number(last.timestamp);
  }

  if (!Number.isFinite(end) || end <= start) return null;
  const duration = end - start;
  return duration <= MAX_PLAUSIBLE_SECONDS ? duration : null;
}

/** Nearest-rank percentile: always a value that actually occurred, which suits block-granular data. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function summarise(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    count: sorted.length,
  };
}

/** Reads the body with a size ceiling, so a misbehaving upstream cannot exhaust memory. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`response of ${declared} bytes exceeds ${maxBytes}`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function queryPage(where: Record<string, unknown>, offset: number): Promise<Row[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.envio.timeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.envio.token) headers.authorization = `Bearer ${config.envio.token}`;
    const response = await fetch(config.envio.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query: QUERY, variables: { where, limit: PAGE_SIZE, offset } }),
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`indexer returned HTTP ${response.status}`);
    const body = JSON.parse(await readCapped(response, config.envio.maxResponseBytes)) as {
      data?: { Transaction?: unknown };
      errors?: Array<{ message?: string }>;
    };
    if (body.errors?.length) {
      throw new Error(`indexer error: ${String(body.errors[0]?.message ?? 'unknown').slice(0, 200)}`);
    }
    const rows = body.data?.Transaction;
    if (!Array.isArray(rows)) throw new Error('indexer response has no Transaction list');
    return rows as Row[];
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`indexer timed out after ${config.envio.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchDirection(direction: Direction, since: number): Promise<BridgeStat[]> {
  const where = whereFor(direction, since);
  const durations: Record<BridgeType, number[]> = { XDAI: [], AMB: [] };

  for (let page = 0; ; page++) {
    if (page === MAX_PAGES) {
      console.warn(`[analytics] ${direction}: stopped at ${MAX_PAGES * PAGE_SIZE} rows; figures cover the newest only`);
      break;
    }
    const rows = await queryPage(where, page * PAGE_SIZE);
    for (const row of rows) {
      if (row?.bridgeType !== 'XDAI' && row?.bridgeType !== 'AMB') continue;
      const duration = durationOf(direction, row);
      if (duration !== null) durations[row.bridgeType].push(duration);
    }
    if (rows.length < PAGE_SIZE) break;
  }

  return BRIDGE_TYPES.map((bridgeType) => ({ direction, bridgeType, ...summarise(durations[bridgeType]) }));
}

function publishMetrics(stats: BridgeStat[]): void {
  for (const stat of stats) {
    const labels = { direction: stat.direction, bridge: stat.bridgeType.toLowerCase() };
    bridgeSamplesGauge.set(labels, stat.count);
    for (const key of ['median', 'p90', 'min', 'max'] as const) {
      const value = stat[key];
      // Cached figures written by an older version can lack a field, and Gauge.set throws on
      // anything but a number -- which, from start(), would take the whole monitor down.
      if (typeof value !== 'number') bridgeTimeGauge.remove({ ...labels, stat: key });
      else bridgeTimeGauge.set({ ...labels, stat: key }, value);
    }
  }
}

export class AnalyticsFetcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  get enabled(): boolean {
    return config.envio.url !== '';
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      console.warn('[analytics] ENVIO_INDEXER_URL is not set; bridging-time analytics disabled');
      return;
    }
    // Restore the gauges from the cache so a restart does not blank them until the first fetch.
    // Best effort: a cache this version cannot read must not stop the monitor starting.
    try {
      const cached = await loadAnalytics<BridgingAnalytics>();
      if (cached?.fetchedAt) {
        publishMetrics(cached.stats);
        analyticsLastSuccessGauge.set(cached.fetchedAt);
      }
    } catch (error) {
      console.warn(`[analytics] ignoring unreadable cache: ${error instanceof Error ? error.message : error}`);
    }
    // Not awaited: a slow indexer must not hold up the monitor's startup.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), config.analyticsIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const now = Math.floor(Date.now() / 1000);
    const windowSeconds = config.analyticsWindowHours * 3600;
    const since = Math.max(now - windowSeconds, config.analyticsStartTimestamp);
    try {
      const results = await Promise.all(DIRECTIONS.map((direction) => fetchDirection(direction, since)));
      const stats = results.flat();
      await saveAnalytics({ fetchedAt: now, lastAttemptAt: now, lastError: null, windowSeconds, since, stats } satisfies BridgingAnalytics);
      publishMetrics(stats);
      analyticsLastSuccessGauge.set(now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      analyticsErrorCounter.inc();
      console.error(`[analytics] fetch failed, serving cached figures: ${message}`);
      // Keep the last good stats; only record that this attempt failed.
      const cached = await loadAnalytics<BridgingAnalytics>().catch(() => null);
      await saveAnalytics({
        fetchedAt: cached?.fetchedAt ?? null,
        lastAttemptAt: now,
        lastError: message,
        windowSeconds: cached?.windowSeconds ?? windowSeconds,
        since: cached?.since ?? since,
        stats: cached?.stats ?? [],
      } satisfies BridgingAnalytics).catch(() => undefined);
    } finally {
      this.running = false;
    }
  }
}

/**
 * Records how far `safe` trails `latest`, by block timestamp, averaged over the clients
 * that returned both tags this poll. Offline clients are left out rather than counted as zero.
 */
export async function recordSafeGap(snapshots: ClientSnapshot[], at: number): Promise<void> {
  const gaps = snapshots.filter((snapshot) => snapshot.safe && snapshot.latest);
  if (gaps.length === 0) return;
  const total = gaps.reduce((sum, snapshot) => sum + (snapshot.latest!.timestamp - snapshot.safe!.timestamp), 0);
  const maxSamples = Math.ceil(config.safeGapWindowSeconds / (config.pollIntervalMs / 1000)) + 10;
  await pushSafeGap({ at, seconds: total / gaps.length, clients: gaps.map((snapshot) => snapshot.client) }, maxSamples);
}

export async function safeGapSummary(now: number): Promise<Summary & { windowSeconds: number; clients: string[] }> {
  const samples = await getSafeGaps(now - config.safeGapWindowSeconds);
  const summary = summarise(samples.map((sample) => sample.seconds));
  return {
    ...summary,
    median: summary.median === null ? null : Math.round(summary.median),
    p90: summary.p90 === null ? null : Math.round(summary.p90),
    windowSeconds: config.safeGapWindowSeconds,
    clients: samples[0]?.clients ?? [],
  };
}
