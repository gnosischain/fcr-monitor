# FCR Monitor

A server-side dashboard that watches whether Ethereum blocks confirmed by the
**fast confirmation rule** ever get reorged out, and records every time a client
withdraws a confirmation, comparing a **Nimbus**-paired and a **Lodestar**-paired
execution client side by side.

Every 12 seconds it reads three tags from each execution client:

| | tag | meaning |
|---|---|---|
| **D1** | `eth_getBlockByNumber("safe", false)` | fast-confirmed head, set by the paired CL |
| **D2** | `eth_getBlockByNumber("finalized", false)` | last finalized checkpoint |
| **D3** | `eth_getBlockByNumber("latest", false)` | chain head |

In a healthy network `D3 > D1 > D2`.

Each card shows the consensus client version, linked to its release notes.
That version cannot be read over the execution RPC — `web3_clientVersion`
reports the *execution* client — so it is configured via `NIMBUS_CL_VERSION` /
`LODESTAR_CL_VERSION` and must be kept in step with what the nodes actually
run. The release link is derived from the version, so bumping one updates the
other. Lighthouse, Prysm and Teku appear as inactive cards pending a later
phase; add them to `config.clients` with an RPC URL to bring them online.

---

## What counts as a fallback event

Three distinct signals are recorded, each as its own event type. They are
collectively the monitor's **fallback events**; only two of the three are
actually chain reorganisations, and **only those two alert**:

| type | severity | proves a confirmed block was lost? |
|---|---|---|
| `safe_reorg` | `critical` — pages | yes |
| `finalized_mismatch` | `critical` — pages | yes |
| `safe_regression` | `warning` — recorded, never notifies | no |

`severityOf` in [`src/events.ts`](src/events.ts) is the single definition of that
split. The metrics carry it as a `severity` label, the alert rules select on the
label, and the dashboard groups by it — so nothing downstream repeats the list.

### Node-local causes are not recorded

Two things drag the `safe` tag backwards with nothing on chain behind them, and
both would otherwise look exactly like a fallback:

| reason | what happened | how it is spotted |
|---|---|---|
| `el_unavailable` | the execution client restarted. Geth does not persist its safe head, so on startup it is reinitialised to the last known finalized block | it served no `safe` block on the previous poll |
| `node_behind` | the node is syncing or lagging, so its consensus client pins the confirmed root to finality until it catches up | the node's own head is older than `NODE_BEHIND_SECONDS` (default 96s, eight slots) |

Neither is recorded as a fallback event. Both are counted in
`fcr_suppressed_regressions_total{client,reason}` so the suppression can be
audited rather than trusted blindly.

Two limits worth knowing. A restart that begins and finishes inside a single
12-second poll interval is invisible to this and will still be recorded. And the
suppression is deliberately narrow: it applies only to `safe_regression`.
`safe_reorg` and `finalized_mismatch` compare hashes at a height already recorded
as safe, so they stay armed throughout and are unaffected.

**`safe_reorg` — the early signal.** The fast confirmation rule promises that
once a block is confirmed it will not revert. So if the hash observed at a
height we already recorded as safe *changes at all*, the rule has been broken —
minutes before finalization would reveal it. This is the most sensitive detector
and usually fires first.

**`safe_regression` — the fallback.** The safe tip moved backwards. Under the
spec this is the fast confirmation rule *withdrawing* a confirmation, which it
does deliberately: `get_latest_confirmed` reverts `confirmed_root` to the
finalized checkpoint when the confirmed block is stale, is no longer an ancestor
of head, or cannot be re-confirmed at an epoch boundary. Only the middle case is
a real reorg, and that one also raises `safe_reorg` or `finalized_mismatch`. A
node syncing, an FCR internal error, or an execution-client restart (geth does
not persist the safe head) produce this signal with nothing on chain behind it,
so on its own it corroborates nothing.

**`finalized_mismatch` — the authoritative signal.** When finalization advances
past a height we recorded as safe, the finalized hash at that height is compared
against the recorded safe hash. A mismatch means the confirmed block was
definitively reorged out. This is the check described in the original spec.

A fourth signal, **client divergence**, is surfaced separately: Nimbus and
Lodestar reporting different hashes at the same height means the two consensus
clients disagree, which is worth knowing regardless of what finalizes.

---

## Two subtleties in the detection logic

**Polling only ever shows the safe *tip*.** When `safe` advances by more than one
block between polls — which happens routinely — the intermediate blocks would go
unrecorded, and if one of *those* later finalizes there would be nothing to
compare it against. So on every poll the monitor walks backwards along
`parentHash` from the new safe tip to the previous one, recording each block it
passes. Walking the parent chain rather than re-querying by number matters: it
captures the ancestry the client considered safe *at that instant*, not whatever
is canonical by the time we ask.

**Finalization is verified across the whole gap, not just at the tip.**
Finalization jumps an epoch at a time, so when it advances the monitor walks the
finalized chain back over every newly finalized height and checks each against
the recorded safe hash.

That walk is bounded by `MAX_WALK_BLOCKS`, and because it descends from the tip,
what a truncated walk misses is the *lowest* heights. Those are then verified
directly by number — sound here because a finalized block is immutable, so its
height identifies exactly one block. Only heights actually compared are pruned;
anything still unchecked stays in Redis and the finalized cursor does not advance
past it, so the next sweep picks it up. That matters because `finalized_mismatch`
is the only evidence a confirmed block was reorged out once finality has passed
it — pruning across an unverified height would discard the alert itself.

---

## State

Redis holds only what is in flight, exactly as specified — the window between
the finalized block and the head:

| key | type | contents |
|---|---|---|
| `fcr:safe:{client}` | hash | `blockNumber -> {hash, parentHash, timestamp, seenAt}`, deleted once finalization passes it |
| `fcr:snapshot:{client}` | string | latest D1/D2/D3 snapshot, also used to restore cursors after a restart |
| `fcr:fallback_events` | list | fallback events, capped at `FALLBACK_EVENT_HISTORY` |
| `fcr:started_at` | string | first-ever start, written with `SETNX` |

`fcr:started_at` uses `SETNX` deliberately: resetting it on each boot would
silently shorten the window the "no fallback event since X" claim covers.

---

## Running it

```bash
cp .env.example .env                                  # fill in the two RPC URLs
cp alertmanager/slack_url.example alertmanager/slack_url   # paste your Slack webhook
chmod 600 alertmanager/slack_url
docker compose up -d --build
```

| service | address | notes |
|---|---|---|
| dashboard | `127.0.0.1:3000` | three tabs: FCR monitoring, Alerts, Reference. Also `/api/*` and `/healthz` |
| Prometheus | `127.0.0.1:9090` | scrapes the monitor's `/metrics` on port `9100` |
| Grafana | `127.0.0.1:3001` | dashboard "FCR Monitor" pre-provisioned |
| Alertmanager | `127.0.0.1:9093` | routes `FcrConfirmedBlockReorged` to Slack |
| Redis | not published | reachable only on the compose network |

Every published port is bound to loopback, so nothing is reachable from outside
the host. Reach the UI over an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 -L 3001:localhost:3001 <host>
```

---

## Slack alerting

Create an incoming webhook in Slack (app → Incoming Webhooks → add to the target
channel) and put the URL in `alertmanager/slack_url`. That file is the
credential — anyone holding it can post to the channel — so it is gitignored and
read via `slack_api_url_file` rather than inlined into the config.

**Only `FcrConfirmedBlockReorged` reaches Slack.** Its companion
`FcrConfirmationWithdrawn` fires on every `safe_regression` and is visible at
`:9090/alerts`, but is not routed to a notifier: a withdrawn confirmation is
specified behaviour, not an incident. Every other rule in
`prometheus/alerts.yml` still evaluates and is visible at `:9090/alerts`, but
Alertmanager's default route is a receiver with no notifiers attached, so those
alerts stop there. Making one of them notify is a matter of adding a route.

The message names the offending block:

```
🔴 Confirmed block reorged out — nimbus
finalized_mismatch on nimbus at block 23456789
• block     23456789
• recorded  0xaaaa1111…bbbb8888
• actual    0x9999ffff…22221111
```

Those three fields come from `fcr_fallback_event_info`, a gauge set to 1 for
`FALLBACK_EVENT_ANNOUNCE_SECONDS` (default 900) after detection, carrying the
block on its labels. It is deliberately short-lived and capped at
`FALLBACK_EVENT_ANNOUNCE_MAX`
(default 20) concurrent series: hashes as label values are unbounded
cardinality, so the announcement lives just long enough to alert. The permanent
record is `fcr_fallback_events_total` and the Redis history behind the Alerts
tab.
Announcements still inside their window are re-published on restart.

There is no resolved notification — the announcement expiring means the alerting
window closed, not that the event was undone.

To check the wiring without waiting for a real event:

```bash
docker compose exec alertmanager amtool --alertmanager.url=http://localhost:9093 \
  alert add alertname=FcrConfirmedBlockReorged client=nimbus type=finalized_mismatch severity=critical \
  block_number=1 recorded_safe_hash=0xaaa observed_hash=0xbbb \
  --annotation='summary=pipe test'
```

## Keeping the execution RPC private

The browser never talks to the execution client. The server polls it, and the
page only ever fetches `/api/state` and `/api/fallback-events`, which return
block numbers, hashes and event records — data that is already public on chain. The
RPC URL and any credentials stay in the server process.

Beyond that:

- **Do not publish the EL's `8545` to the host.** If the execution clients run as
  containers on the same host, join their Docker network (see the commented
  block at the bottom of `docker-compose.yml`) and address them as
  `http://<container>:8545`. Container-to-container traffic never touches a host
  port.
- **If the nodes are on another machine**, put the link on WireGuard or a private
  network rather than exposing the RPC port publicly. An IP allowlist on a
  public port is weaker than it looks and gives no confidentiality.
- **If the RPC must traverse an untrusted network**, terminate TLS with a reverse
  proxy in front of the node and restrict it to an allowlist of methods — this
  monitor only needs `eth_getBlockByNumber`, `eth_getBlockByHash` and
  `eth_chainId`.
- **Secrets** live in `.env` (gitignored, `chmod 600`) or Docker secrets, never
  baked into the image.
- **Grafana** ships with anonymous access disabled and sign-up off; set
  `GRAFANA_PASSWORD` before first boot.

---

## Metrics

`GET /metrics` on **port `9100`** (`METRICS_PORT`) exposes, among others:

| metric | labels | |
|---|---|---|
| `fcr_block_number` | `client`, `tag` | block number per tag |
| `fcr_block_slot` | `client`, `tag` | beacon slot derived from block timestamp |
| `fcr_block_age_seconds` | `client`, `tag` | wall-clock age; a rising `safe` means confirmation stalled |
| `fcr_lag_blocks` | `client`, `tag` | distance behind head |
| `fcr_fallback_events_total` | `client`, `type`, `severity` | counter per detection type |
| `fcr_fallback_event_info` | `client`, `type`, `severity`, `block_number`, `recorded_safe_hash`, `observed_hash` | 1 while a recent fallback event is being announced; the alert rules select on `severity` |
| `fcr_client_divergence` | `tag` | 1 when the two clients disagree |
| `fcr_client_up` | `client` | RPC reachability |
| `fcr_tracked_safe_blocks` | `client` | safe blocks awaiting finalization |
| `fcr_walk_truncated_total` | `client`, `phase` | coverage gaps from hitting `MAX_WALK_BLOCKS` |
| `fcr_suppressed_regressions_total` | `client`, `reason` | regressions attributed to the node (`el_unavailable`, `node_behind`) and not recorded |

`/metrics` is on a **separate listener** from the dashboard, not a path on port
3000. It is unauthenticated and also carries Node process/GC/event-loop
internals, so it must not share a port with anything published to users: an
ingress can then expose 3000 alone, with no edge filtering to get wrong and no
path-normalisation trickery (`/METRICS`, `//metrics`, `/./metrics`) to lose to.
`/healthz` deliberately stays on 3000 so a load balancer needs only one port.

Alert rules for all of these are in `prometheus/alerts.yml`. All of them
evaluate; only `FcrConfirmedBlockReorged` is routed to Slack — see [Slack
alerting](#slack-alerting).

---

## Configuration

All optional except the two RPC URLs — see `.env.example`. Chain parameters
default to Ethereum mainnet (`GENESIS_TIME=1606824023`, 12s slots, 32 slots per
epoch); override them for a testnet.

## Renamed: `reorg` → `fallback_events` (breaking)

The collection of detected events used to be called "reorgs" throughout. It is
not one — most of what lands in it is the fast confirmation rule withdrawing a
confirmation, which the consensus clients themselves call a **fallback**
(Lodestar `beacon_fast_confirmation_fallbacks_total`, Lighthouse
`beacon_fast_confirmation_fallback_reasons_total`) or a **revert** (Nimbus
`beacon_safe_reverts_epoch_total`, `beacon_safe_reverts_head_total`). The
container is now named for what it holds.

The three event *types* are unchanged. `safe_reorg` and `finalized_mismatch`
really are chain reorganisations that reached a block the CL had already
declared safe, and "reorg" is the word all three clients use for exactly that
condition.

| was | now |
|---|---|
| `fcr_reorgs_total` | `fcr_fallback_events_total` |
| `fcr_reorg_info` | `fcr_fallback_event_info` |
| `recorded_hash` label on `fcr_fallback_event_info` | `recorded_safe_hash` |
| `FcrReorgDetected` | `FcrConfirmedBlockReorged` (critical) and `FcrConfirmationWithdrawn` (warning) |
| `GET /api/reorgs` | `GET /api/fallback-events` |
| `fcr:reorgs` (Redis) | `fcr:fallback_events` |
| `REORG_HISTORY` | `FALLBACK_EVENT_HISTORY` |
| `REORG_ANNOUNCE_SECONDS` | `FALLBACK_EVENT_ANNOUNCE_SECONDS` |
| `REORG_ANNOUNCE_MAX` | `FALLBACK_EVENT_ANNOUNCE_MAX` |
| `reorgCount` (in `/api/state`) | `fallbackEventCount` |
| `reorgs` (in the events payload) | `events` |
| "Reorg" tab | "Alerts" tab |

`prometheus/alerts.yml`, `alertmanager/alertmanager.yml` and
`grafana/dashboards/fcr-monitor.json` in this repo are updated in the same
commit. **Outside this repo you must also update:**

- any panel or alert in the org's Prometheus/Thanos + Grafana that queries
  `fcr_reorgs_total` or `fcr_reorg_info` — see [Deployment](#deployment);
- the env vars in
  `infrastructure-gnosis/production/google/deployments/gnosis-chain/mainnet/tools/fcr-monitor/`
  if any of the three renamed `REORG_*` values are set there. They are optional
  and defaulted, so an unnoticed stale name silently reverts that setting to its
  default rather than failing.

The old Redis key is **not** migrated. `fcr:reorgs` is left in place and simply
stops being read; the history it holds is capped at `FALLBACK_EVENT_HISTORY` and
is a rolling record, not a ledger. Delete it with `DEL fcr:reorgs` once the new
key has data. `fcr:started_at` is untouched, so the "no fallback event since X"
window is preserved across the rename.

---

## Deployment

Production runs on Gnosis' GKE cluster at
<https://fcr.bridge.gnosischain.com>. The Terraform lives in the
`infrastructure-gnosis` repo under
`production/google/deployments/gnosis-chain/mainnet/tools/fcr-monitor/`, and
Grafana is not deployed there — the metrics are scraped into the org's
Prometheus/Thanos, which already has Grafana in front of it.

Images are built by [`.github/workflows/publish-image.yml`](.github/workflows/publish-image.yml)
and pushed to Artifact Registry via Workload Identity Federation. The workflow
never touches the cluster: deploying is a reviewed PR in the infra repo bumping a
digest-pinned tag.

## Local development

```bash
npm install
npm run build
docker run -d --name redis -p 6379:6379 redis:7-alpine
NIMBUS_EL_RPC=... LODESTAR_EL_RPC=... REDIS_URL=redis://127.0.0.1:6379 npm start
```
