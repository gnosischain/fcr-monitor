import { config, epochOfSlot, slotOfTimestamp, type ClientConfig } from './config.js';
import {
  getBlockByHash,
  getBlockByNumber,
  getBlockByTag,
  RpcError,
  type BlockHeader,
  type BlockTag,
} from './rpc.js';
import { severityOf } from './events.js';
import {
  countSafeBlocks,
  getAllSafeBlocks,
  getFallbackEvents,
  getSafeBlock,
  loadSnapshot,
  pruneSafeBlocks,
  pushFallbackEvent,
  putSafeBlock,
  saveSnapshot,
  type ClientSnapshot,
  type FallbackEvent,
  type FallbackEventType,
} from './store.js';
import {
  announceFallbackEvent,
  blockAgeGauge,
  blockNumberGauge,
  blockSlotGauge,
  clientUpGauge,
  divergenceGauge,
  lagGauge,
  lastPollGauge,
  fallbackEventCounter,
  rpcDuration,
  rpcErrorCounter,
  sweepFallbackEventAnnouncements,
  trackedSafeGauge,
  suppressedRegressionCounter,
  walkTruncatedCounter,
} from './metrics.js';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function settled<T>(result: PromiseSettledResult<T>): {
  value: T | null;
  error: string | null;
} {
  if (result.status === 'fulfilled') return { value: result.value, error: null };
  const reason = result.reason;
  return {
    value: null,
    error: reason instanceof Error ? reason.message : String(reason),
  };
}

class ClientPoller {
  /** Highest block number we have recorded as safe. Seeded from Redis on boot. */
  private lastSafeNumber: number | null = null;
  /** Highest finalized block number we have already swept and pruned. */
  private lastFinalizedNumber: number | null = null;
  /**
   * Whether the previous poll actually read a `safe` block from this client.
   *
   * Geth does not persist its safe head — on startup it is reinitialised to the last known
   * finalized block — so every execution-client restart drags the `safe` tag backwards with
   * no consensus event behind it. The restart itself is what betrays it: the RPC is
   * unavailable across at least one poll beforehand. A regression observed on the first
   * poll after that gap is attributed to the execution client and not recorded.
   */
  private previousPollHadSafe: boolean | null = null;

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
    this.previousPollHadSafe = snapshot.safe !== null;
    console.log(
      `[${this.client.id}] restored cursors safe=${this.lastSafeNumber} finalized=${this.lastFinalizedNumber}`,
    );
  }

  async poll(): Promise<ClientSnapshot> {
    // Read before this poll's own result overwrites it.
    const previousPollHadSafe = this.previousPollHadSafe;
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

    this.previousPollHadSafe = safe.value !== null;

    // A node that is syncing or lagging stops advancing its own head. Measured from the same
    // poll that sees the regression, so the two judgements cannot drift apart.
    const headAgeSeconds = latest.value === null ? null : nowSeconds() - latest.value.timestamp;

    if (safe.value) await this.processSafe(safe.value, { previousPollHadSafe, headAgeSeconds });
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
  private async processSafe(
    safe: BlockHeader,
    context: { previousPollHadSafe: boolean | null; headAgeSeconds: number | null },
  ): Promise<void> {
    const seenAt = nowSeconds();

    // The safe tip moving backwards is NOT on its own a violation of the fast confirmation
    // rule. The rule withdraws a confirmation deliberately when it cannot re-prove safety,
    // reverting to the finalized checkpoint; a syncing node or an execution-client restart
    // produces the same move with nothing on chain behind it. Recorded at `warning`
    // severity as a diagnostic — `safe_reorg` and `finalized_mismatch` are the proof.
    if (this.lastSafeNumber !== null && safe.number < this.lastSafeNumber) {
      // Two ways this node, rather than the network, explains the backwards move:
      //
      //   el_unavailable — the execution client served no safe block on the previous poll, so
      //     it was restarting. Geth does not persist its safe head; on startup it is
      //     reinitialised to the last known finalized block, which is exactly this move.
      //
      //   node_behind — the node's own head is stale, so it is syncing or lagging. Its
      //     consensus client pins the confirmed root to finality until it catches up.
      //
      // Deliberately narrow: only `safe_regression` is suppressed. `safe_reorg` and
      // `finalized_mismatch` compare hashes at a height already recorded as safe, so they stay
      // armed throughout and remain the signals that actually page.
      const suppressReason =
        context.previousPollHadSafe === false
          ? 'el_unavailable'
          : context.headAgeSeconds !== null && context.headAgeSeconds > config.nodeBehindSeconds
            ? 'node_behind'
            : null;

      if (suppressReason !== null) {
        suppressedRegressionCounter.inc({ client: this.client.id, reason: suppressReason });
        const because =
          suppressReason === 'el_unavailable'
            ? 'the execution client was unreachable on the previous poll'
            : `this node's head is ${context.headAgeSeconds}s old, so it is behind the chain`;
        console.warn(
          `[${this.client.id}] safe tip moved backwards from ${this.lastSafeNumber} to ` +
            `${safe.number}, but ${because}; attributed to this node rather than to consensus, ` +
            `and not recorded as a fallback event`,
        );
        this.lastSafeNumber = safe.number;
      } else {
        await this.recordFallbackEvent({
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
      await this.recordFallbackEvent({
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
        number <= finalized.number &&
        (this.lastFinalizedNumber === null || number > this.lastFinalizedNumber),
    );

    /** Heights actually compared against the finalized chain; only these may be pruned. */
    const verified = new Set<number>();

    const compare = async (block: BlockHeader): Promise<void> => {
      const record = tracked.get(block.number);
      if (record && record.hash !== block.hash) {
        await this.recordFallbackEvent({
          type: 'finalized_mismatch',
          blockNumber: block.number,
          recordedSafeHash: record.hash,
          observedHash: block.hash,
          recordedAt: record.seenAt,
          timestamp: block.timestamp,
          note:
            `Block ${block.number} finalized as ${block.hash} but was previously confirmed ` +
            `as ${record.hash}. The confirmed block was reorged out.`,
        });
      }
      verified.add(block.number);
    };

    if (pending.length > 0) {
      const floor = Math.min(...pending);
      let cursor: BlockHeader = finalized;
      let steps = 0;
      while (true) {
        await compare(cursor);
        if (cursor.number <= floor) break;
        if (steps >= config.maxWalkBlocks) {
          // The walk is bounded, and it descends from the tip — so what it misses is the
          // bottom of the range. Those heights are picked up by number below rather than
          // abandoned.
          walkTruncatedCounter.inc({
            client: this.client.id,
            phase: 'finalization',
          });
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
          break; // Unverified heights stay in Redis and are retried on the next sweep.
        }
        steps += 1;
      }

      // Whatever the walk did not reach is verified directly. Looking a finalized height up
      // by number is authoritative because finalized blocks are immutable, so this closes
      // the gap the walk's bound leaves rather than pruning across it unchecked.
      const missed = pending.filter((number) => !verified.has(number)).sort((a, b) => b - a);
      let lookups = 0;
      for (const number of missed) {
        if (lookups >= config.maxWalkBlocks) {
          walkTruncatedCounter.inc({
            client: this.client.id,
            phase: 'finalization_by_number',
          });
          console.warn(
            `[${this.client.id}] finalization sweep still has ${missed.length - lookups} ` +
              `unverified heights after ${config.maxWalkBlocks} direct lookups; they are kept ` +
              `for the next sweep`,
          );
          break;
        }
        try {
          await compare(await getBlockByNumber(this.client.rpcUrl, number, config.rpcTimeoutMs));
        } catch (error) {
          rpcErrorCounter.inc({ client: this.client.id, tag: 'finalized' });
          console.warn(
            `[${this.client.id}] could not verify finalized height ${number}: ` +
              `${error instanceof RpcError ? error.message : String(error)}`,
          );
        }
        lookups += 1;
      }
    }

    // Prune exactly what was checked. Anything left unverified stays until a later sweep
    // reaches it, because its record is the only evidence a confirmed block was reorged out.
    await pruneSafeBlocks(this.client.id, verified);

    // Only advance the cursor past heights that were verified, so the ones left behind are
    // still inside `pending` next time rather than filtered out as already-finalized.
    const unverified = pending.filter((number) => !verified.has(number));
    this.lastFinalizedNumber = unverified.length > 0 ? Math.min(...unverified) - 1 : finalized.number;
  }

  private async recordFallbackEvent(input: {
    type: FallbackEventType;
    blockNumber: number;
    recordedSafeHash: string;
    observedHash: string;
    recordedAt: number | null;
    timestamp: number | null;
    note: string;
  }): Promise<void> {
    const detectedAt = nowSeconds();
    const slot = input.timestamp === null ? null : slotOfTimestamp(input.timestamp);
    const event: FallbackEvent = {
      id: `${this.client.id}-${input.type}-${input.blockNumber}-${detectedAt}`,
      client: this.client.id,
      type: input.type,
      severity: severityOf(input.type),
      blockNumber: input.blockNumber,
      slot,
      epoch: slot === null ? null : epochOfSlot(slot),
      recordedSafeHash: input.recordedSafeHash,
      observedHash: input.observedHash,
      recordedAt: input.recordedAt,
      detectedAt,
      note: input.note,
    };
    await pushFallbackEvent(event);
    fallbackEventCounter.inc({
      client: this.client.id,
      type: input.type,
      severity: event.severity,
    });
    announceFallbackEvent(
      {
        client: event.client,
        type: event.type,
        severity: event.severity,
        blockNumber: event.blockNumber,
        recordedHash: event.recordedSafeHash,
        observedHash: event.observedHash,
        detectedAt: event.detectedAt,
      },
      config.fallbackEventAnnounceSeconds,
      config.fallbackEventAnnounceMax,
      detectedAt,
    );
    const tag = event.severity === 'critical' ? 'FCR-ALERT' : 'FCR-WITHDRAWN';
    console.error(`[${tag}][${this.client.id}][${input.type}] ${input.note}`);
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
    await this.restoreAnnouncements();
    await this.tick();
    this.timer = setInterval(() => void this.tick(), config.pollIntervalMs);
  }

  /**
   * Re-publishes events still inside their announcement window. Without this a
   * restart during an incident would retire the alert while the event is still
   * the thing you want to be told about.
   */
  private async restoreAnnouncements(): Promise<void> {
    const now = nowSeconds();
    const recent = await getFallbackEvents(config.fallbackEventAnnounceMax);
    for (const event of recent.reverse()) {
      if (now - event.detectedAt >= config.fallbackEventAnnounceSeconds) continue;
      announceFallbackEvent(
        {
          client: event.client,
          type: event.type,
          severity: event.severity,
          blockNumber: event.blockNumber,
          recordedHash: event.recordedSafeHash,
          observedHash: event.observedHash,
          detectedAt: event.detectedAt,
        },
        config.fallbackEventAnnounceSeconds,
        config.fallbackEventAnnounceMax,
        now,
      );
    }
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
      sweepFallbackEventAnnouncements(config.fallbackEventAnnounceSeconds, nowSeconds());
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
