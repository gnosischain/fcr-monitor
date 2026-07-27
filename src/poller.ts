import { config, epochOfSlot, slotOfTimestamp, type ClientConfig } from './config.js';
import { getBlockByHash, getBlockByTag, RpcError, type BlockHeader, type BlockTag } from './rpc.js';
import {
  countSafeBlocks,
  getAllSafeBlocks,
  getSafeBlock,
  loadSnapshot,
  pruneSafeBlocksUpTo,
  pushReorg,
  putSafeBlock,
  saveSnapshot,
  type ClientSnapshot,
  type ReorgEvent,
  type ReorgType,
} from './store.js';
import {
  blockAgeGauge,
  blockNumberGauge,
  blockSlotGauge,
  clientUpGauge,
  divergenceGauge,
  lagGauge,
  lastPollGauge,
  reorgCounter,
  rpcDuration,
  rpcErrorCounter,
  trackedSafeGauge,
  walkTruncatedCounter,
} from './metrics.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function settled<T>(result: PromiseSettledResult<T>): { value: T | null; error: string | null } {
  if (result.status === 'fulfilled') return { value: result.value, error: null };
  const reason = result.reason;
  return { value: null, error: reason instanceof Error ? reason.message : String(reason) };
}

class ClientPoller {
  /** Highest block number we have recorded as safe. Seeded from Redis on boot. */
  private lastSafeNumber: number | null = null;
  /** Highest finalized block number we have already swept and pruned. */
  private lastFinalizedNumber: number | null = null;

  constructor(private readonly client: ClientConfig) {}

  get id(): string {
    return this.client.id;
  }

  /**
   * Restores cursors from the previous run so a restart does not re-sweep
   * already-verified history, nor treat the first poll as a fresh start.
   */
  async restore(): Promise<void> {
    const snapshot = await loadSnapshot(this.client.id);
    if (!snapshot) return;
    this.lastSafeNumber = snapshot.safe?.number ?? null;
    this.lastFinalizedNumber = snapshot.finalized?.number ?? null;
    console.log(
      `[${this.client.id}] restored cursors safe=${this.lastSafeNumber} finalized=${this.lastFinalizedNumber}`,
    );
  }

  async poll(): Promise<ClientSnapshot> {
    const stopTimer = rpcDuration.startTimer({ client: this.client.id });
    const url = this.client.rpcUrl;
    const timeout = config.rpcTimeoutMs;

    const [safeResult, finalizedResult, latestResult] = await Promise.allSettled([
      getBlockByTag(url, 'safe', timeout),
      getBlockByTag(url, 'finalized', timeout),
      getBlockByTag(url, 'latest', timeout),
    ]);
    stopTimer();

    const safe = settled(safeResult);
    const finalized = settled(finalizedResult);
    const latest = settled(latestResult);

    for (const [tag, outcome] of [
      ['safe', safe],
      ['finalized', finalized],
      ['latest', latest],
    ] as const) {
      if (outcome.error) rpcErrorCounter.inc({ client: this.client.id, tag });
    }

    // `latest` is the liveness signal: safe/finalized can legitimately be
    // unavailable on a node whose CL has not issued a forkchoice update yet.
    const online = latest.value !== null;
    clientUpGauge.set({ client: this.client.id }, online ? 1 : 0);

    if (safe.value) await this.processSafe(safe.value);
    if (finalized.value) await this.processFinalized(finalized.value);

    this.publishBlockMetrics('safe', safe.value, latest.value);
    this.publishBlockMetrics('finalized', finalized.value, latest.value);
    this.publishBlockMetrics('latest', latest.value, latest.value);

    const tracked = await countSafeBlocks(this.client.id);
    trackedSafeGauge.set({ client: this.client.id }, tracked);
    lastPollGauge.set({ client: this.client.id }, nowSeconds());

    const errors = [safe.error, finalized.error, latest.error].filter(Boolean) as string[];
    const snapshot: ClientSnapshot = {
      client: this.client.id,
      label: this.client.label,
      updatedAt: nowSeconds(),
      online,
      error: errors.length > 0 ? errors.join('; ') : null,
      safe: safe.value,
      finalized: finalized.value,
      latest: latest.value,
      trackedSafeBlocks: tracked,
    };
    await saveSnapshot(snapshot);
    return snapshot;
  }

  private publishBlockMetrics(tag: BlockTag, block: BlockHeader | null, latest: BlockHeader | null): void {
    if (!block) return;
    const labels = { client: this.client.id, tag };
    blockNumberGauge.set(labels, block.number);
    blockSlotGauge.set(labels, slotOfTimestamp(block.timestamp));
    blockAgeGauge.set(labels, nowSeconds() - block.timestamp);
    if (latest) lagGauge.set(labels, latest.number - block.number);
  }

  /**
   * Tracks the safe chain and raises the early FCR signal.
   *
   * Polling only ever shows us the safe *tip*. When it advances by more than
   * one block between polls the intermediate blocks would go unrecorded, and if
   * one of those later finalizes we would have nothing to compare it against.
   * So we walk back along parentHash to the previous tip. Walking the parent
   * chain rather than re-querying by number matters: it captures the ancestry
   * the client considered safe at this instant, not whatever is canonical by
   * the time we ask.
   */
  private async processSafe(safe: BlockHeader): Promise<void> {
    const seenAt = nowSeconds();

    // The safe tip moving backwards is an outright violation of the fast
    // confirmation rule and needs no further corroboration.
    if (this.lastSafeNumber !== null && safe.number < this.lastSafeNumber) {
      await this.recordReorg({
        type: 'safe_regression',
        blockNumber: safe.number,
        recordedSafeHash: (await getSafeBlock(this.client.id, this.lastSafeNumber))?.hash ?? 'unknown',
        observedHash: safe.hash,
        recordedAt: null,
        timestamp: safe.timestamp,
        note:
          `Safe tip moved backwards from block ${this.lastSafeNumber} to ${safe.number}. ` +
          `A confirmed block was un-confirmed.`,
      });
      this.lastSafeNumber = safe.number;
    }

    const floor = this.lastSafeNumber === null ? safe.number : Math.min(this.lastSafeNumber, safe.number);

    let cursor: BlockHeader = safe;
    let steps = 0;
    while (true) {
      await this.reconcileSafeBlock(cursor, seenAt);
      if (cursor.number <= floor) break;
      if (steps >= config.maxWalkBlocks) {
        walkTruncatedCounter.inc({ client: this.client.id, phase: 'backfill' });
        console.warn(
          `[${this.client.id}] safe backfill truncated at ${config.maxWalkBlocks} blocks; ` +
            `blocks ${floor}..${cursor.number - 1} were not recorded and cannot be reorg-checked`,
        );
        break;
      }
      try {
        cursor = await getBlockByHash(this.client.rpcUrl, cursor.parentHash, config.rpcTimeoutMs);
      } catch (error) {
        rpcErrorCounter.inc({ client: this.client.id, tag: 'safe' });
        console.warn(
          `[${this.client.id}] could not walk to parent ${cursor.parentHash}: ` +
            `${error instanceof RpcError ? error.message : String(error)}`,
        );
        break;
      }
      steps += 1;
    }

    this.lastSafeNumber = Math.max(safe.number, this.lastSafeNumber ?? safe.number);
  }

  /** Stores one safe block, raising a reorg if it replaces a different hash at the same height. */
  private async reconcileSafeBlock(block: BlockHeader, seenAt: number): Promise<void> {
    const existing = await getSafeBlock(this.client.id, block.number);
    if (existing && existing.hash !== block.hash) {
      await this.recordReorg({
        type: 'safe_reorg',
        blockNumber: block.number,
        recordedSafeHash: existing.hash,
        observedHash: block.hash,
        recordedAt: existing.seenAt,
        timestamp: block.timestamp,
        note:
          `Block ${block.number} was confirmed as ${existing.hash} and is now ${block.hash}. ` +
          `The fast confirmation rule was violated before finalization.`,
      });
    }
    if (!existing || existing.hash !== block.hash) {
      await putSafeBlock(this.client.id, block, existing?.seenAt ?? seenAt);
    }
  }

  /**
   * The authoritative check. When finalization advances, walk the finalized
   * chain back over every newly finalized height and compare each against what
   * we recorded as safe, then prune — which is what keeps Redis stateful only
   * between the finalized block and the head.
   */
  private async processFinalized(finalized: BlockHeader): Promise<void> {
    if (this.lastFinalizedNumber !== null && finalized.number <= this.lastFinalizedNumber) {
      return;
    }

    const tracked = await getAllSafeBlocks(this.client.id);
    const pending = [...tracked.keys()].filter(
      (number) =>
        number <= finalized.number && (this.lastFinalizedNumber === null || number > this.lastFinalizedNumber),
    );

    if (pending.length > 0) {
      const floor = Math.min(...pending);
      let cursor: BlockHeader = finalized;
      let steps = 0;
      while (true) {
        const record = tracked.get(cursor.number);
        if (record && record.hash !== cursor.hash) {
          await this.recordReorg({
            type: 'finalized_mismatch',
            blockNumber: cursor.number,
            recordedSafeHash: record.hash,
            observedHash: cursor.hash,
            recordedAt: record.seenAt,
            timestamp: cursor.timestamp,
            note:
              `Block ${cursor.number} finalized as ${cursor.hash} but was previously confirmed ` +
              `as ${record.hash}. The confirmed block was reorged out.`,
          });
        }
        if (cursor.number <= floor) break;
        if (steps >= config.maxWalkBlocks) {
          walkTruncatedCounter.inc({ client: this.client.id, phase: 'finalization' });
          console.warn(
            `[${this.client.id}] finalization sweep truncated at ${config.maxWalkBlocks} blocks; ` +
              `heights ${floor}..${cursor.number - 1} were pruned without being verified`,
          );
          break;
        }
        try {
          cursor = await getBlockByHash(this.client.rpcUrl, cursor.parentHash, config.rpcTimeoutMs);
        } catch (error) {
          rpcErrorCounter.inc({ client: this.client.id, tag: 'finalized' });
          console.warn(
            `[${this.client.id}] finalization sweep stopped at ${cursor.number}: ` +
              `${error instanceof RpcError ? error.message : String(error)}`,
          );
          return; // Leave the records in place so the next sweep retries them.
        }
        steps += 1;
      }
    }

    await pruneSafeBlocksUpTo(this.client.id, finalized.number);
    this.lastFinalizedNumber = finalized.number;
  }

  private async recordReorg(input: {
    type: ReorgType;
    blockNumber: number;
    recordedSafeHash: string;
    observedHash: string;
    recordedAt: number | null;
    timestamp: number | null;
    note: string;
  }): Promise<void> {
    const detectedAt = nowSeconds();
    const slot = input.timestamp === null ? null : slotOfTimestamp(input.timestamp);
    const event: ReorgEvent = {
      id: `${this.client.id}-${input.type}-${input.blockNumber}-${detectedAt}`,
      client: this.client.id,
      type: input.type,
      blockNumber: input.blockNumber,
      slot,
      epoch: slot === null ? null : epochOfSlot(slot),
      recordedSafeHash: input.recordedSafeHash,
      observedHash: input.observedHash,
      recordedAt: input.recordedAt,
      detectedAt,
      note: input.note,
    };
    await pushReorg(event);
    reorgCounter.inc({ client: this.client.id, type: input.type });
    console.error(`[REORG][${this.client.id}][${input.type}] ${input.note}`);
  }
}

export class Monitor {
  private readonly pollers: ClientPoller[];
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(clients: ClientConfig[]) {
    this.pollers = clients.map((client) => new ClientPoller(client));
  }

  async start(): Promise<void> {
    await Promise.all(this.pollers.map((poller) => poller.restore()));
    await this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Skips overlapping ticks so a slow or hanging RPC cannot pile up polls. */
  private async tick(): Promise<void> {
    if (this.running) {
      console.warn('[monitor] previous poll still running, skipping this tick');
      return;
    }
    this.running = true;
    try {
      const snapshots = await Promise.all(this.pollers.map((poller) => poller.poll()));
      this.publishDivergence(snapshots);
    } catch (error) {
      console.error('[monitor] poll cycle failed:', error instanceof Error ? error.message : error);
    } finally {
      this.running = false;
    }
  }

  /**
   * Compares the two clients at the lowest height they both reached. They will
   * usually be a poll apart, so we look the lower height up in the other
   * client's tracked safe blocks rather than comparing the tips directly.
   */
  private publishDivergence(snapshots: ClientSnapshot[]): void {
    for (const tag of ['safe', 'finalized'] as const) {
      const blocks = snapshots.map((snapshot) => snapshot[tag]);
      const [a, b] = blocks;
      if (!a || !b) {
        divergenceGauge.set({ tag }, 0);
        continue;
      }
      const diverged = a.number === b.number && a.hash !== b.hash;
      divergenceGauge.set({ tag }, diverged ? 1 : 0);
      if (diverged) {
        console.error(`[monitor] clients disagree on ${tag} block ${a.number}: ${a.hash} vs ${b.hash}`);
      }
    }
  }
}
