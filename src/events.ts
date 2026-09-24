/**
 * Event taxonomy and severity. Deliberately free of imports so every layer — poller,
 * metrics, store, HTTP — can share one definition without pulling in the Redis client.
 */

export type FallbackEventType = 'finalized_mismatch' | 'safe_reorg' | 'safe_regression';

export const FALLBACK_EVENT_TYPES: readonly FallbackEventType[] = [
  'finalized_mismatch',
  'safe_reorg',
  'safe_regression',
] as const;

export type Severity = 'critical' | 'warning';

/**
 * Single source of truth for what pages and what does not.
 *
 * Only a hash changing at a height we already recorded as safe proves a confirmed block was
 * lost. A backwards `safe` tag does not: the fast confirmation rule withdraws confirmation
 * deliberately when it cannot re-prove safety, and the spec prescribes reverting to the
 * finalized checkpoint. A syncing node, an FCR internal error, or an execution-client
 * restart (geth does not persist the safe head) all produce the same backwards move with
 * nothing on chain behind it.
 *
 * Nor can the consensus client's own fallback reason be used instead. The reasons are
 * evaluated in a short-circuit chain with ancestry tested last, so a genuine reorg is
 * reported as `epoch_too_old` or `confirmed_block_pruned` whenever the confirmed block is
 * also stale or pruned. All three clients work around this by deriving their reorg counter
 * from ancestry and ignoring the reason. Comparing hashes at a height we recorded as safe —
 * which is what `safe_reorg` and `finalized_mismatch` do — tests that same property from
 * the outside, and is the only evidence here that a confirmed block was actually lost.
 */
export const severityOf = (type: FallbackEventType): Severity =>
  type === 'safe_regression' ? 'warning' : 'critical';

export const isAlerting = (type: FallbackEventType): boolean => severityOf(type) === 'critical';
