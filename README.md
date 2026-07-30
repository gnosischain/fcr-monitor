# FCR Monitor

A server-side dashboard that watches whether Ethereum blocks confirmed by the
**fast confirmation rule** ever get reorged out, comparing a **Nimbus**-paired and
a **Lodestar**-paired execution client side by side.

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

## What counts as a reorg

Three distinct signals are recorded, each as its own event type.

**`safe_reorg` — the early signal.** The fast confirmation rule promises that
once a block is confirmed it will not revert. So if the hash observed at a
height we already recorded as safe *changes at all*, the rule has been broken —
minutes before finalization would reveal it. This is the most sensitive detector
and usually fires first.

**`safe_regression`.** The safe tip moved backwards. A confirmed block was
un-confirmed outright; no corroboration needed.

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
finalized chain back over every newly finalized height, checks each against the
recorded safe hash, and only then prunes. Both walks are bounded by
`MAX_WALK_BLOCKS`; when that bound bites it is logged and counted in
`fcr_walk_truncated_total` rather than silently covering less.

---

## State

Redis holds only what is in flight, exactly as specified — the window between
the finalized block and the head:

| key | type | contents |
|---|---|---|
| `fcr:safe:{client}` | hash | `blockNumber -> {hash, parentHash, timestamp, seenAt}`, deleted once finalization passes it |
| `fcr:snapshot:{client}` | string | latest D1/D2/D3 snapshot, also used to restore cursors after a restart |
| `fcr:reorgs` | list | reorg events, capped at `REORG_HISTORY` |
| `fcr:started_at` | string | first-ever start, written with `SETNX` |

`fcr:started_at` uses `SETNX` deliberately: resetting it on each boot would
silently shorten the window the "no reorg since X" claim covers.

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
| dashboard | `127.0.0.1:3000` | two tabs: FCR monitoring, Reorg. Also `/api/*` and `/healthz` |
| Prometheus | `127.0.0.1:9090` | scrapes the monitor's `/metrics` on port `9100` |
| Grafana | `127.0.0.1:3001` | dashboard "FCR Monitor" pre-provisioned |
| Alertmanager | `127.0.0.1:9093` | routes the reorg alert to Slack |
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

**Only `FcrReorgDetected` reaches Slack.** Every other rule in
`prometheus/alerts.yml` still evaluates and is visible at `:9090/alerts`, but
Alertmanager's default route is a receiver with no notifiers attached, so those
alerts stop there. Making one of them notify is a matter of adding a route.

The message names the offending block:

```
🔴 Reorg past the fast confirmation rule — nimbus
finalized_mismatch on nimbus at block 23456789
• block     23456789
• recorded  0xaaaa1111…bbbb8888
• actual    0x9999ffff…22221111
```

Those three fields come from `fcr_reorg_info`, a gauge set to 1 for
`REORG_ANNOUNCE_SECONDS` (default 900) after detection, carrying the block on
its labels. It is deliberately short-lived and capped at `REORG_ANNOUNCE_MAX`
(default 20) concurrent series: hashes as label values are unbounded
cardinality, so the announcement lives just long enough to alert. The permanent
record is `fcr_reorgs_total` and the Redis history behind the Reorg tab.
Announcements still inside their window are re-published on restart.

There is no resolved notification — the announcement expiring means the alerting
window closed, not that the reorg was undone.

To check the wiring without waiting for a real reorg:

```bash
docker compose exec alertmanager amtool --alertmanager.url=http://localhost:9093 \
  alert add alertname=FcrReorgDetected client=nimbus type=finalized_mismatch \
  block_number=1 recorded_hash=0xaaa observed_hash=0xbbb \
  --annotation='summary=pipe test'
```

## Keeping the execution RPC private

The browser never talks to the execution client. The server polls it, and the
page only ever fetches `/api/state` and `/api/reorgs`, which return block
numbers, hashes and reorg records — data that is already public on chain. The
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
| `fcr_reorgs_total` | `client`, `type` | counter per detection type |
| `fcr_reorg_info` | `client`, `type`, `block_number`, `recorded_hash`, `observed_hash` | 1 while a recent reorg is being announced; what the Slack alert reads |
| `fcr_client_divergence` | `tag` | 1 when the two clients disagree |
| `fcr_client_up` | `client` | RPC reachability |
| `fcr_tracked_safe_blocks` | `client` | safe blocks awaiting finalization |
| `fcr_walk_truncated_total` | `client`, `phase` | coverage gaps from hitting `MAX_WALK_BLOCKS` |

`/metrics` is on a **separate listener** from the dashboard, not a path on port
3000. It is unauthenticated and also carries Node process/GC/event-loop
internals, so it must not share a port with anything published to users: an
ingress can then expose 3000 alone, with no edge filtering to get wrong and no
path-normalisation trickery (`/METRICS`, `//metrics`, `/./metrics`) to lose to.
`/healthz` deliberately stays on 3000 so a load balancer needs only one port.

Alert rules for all of these are in `prometheus/alerts.yml`. All of them
evaluate; only the reorg alert is routed to Slack — see [Slack
alerting](#slack-alerting).

---

## Configuration

All optional except the two RPC URLs — see `.env.example`. Chain parameters
default to Ethereum mainnet (`GENESIS_TIME=1606824023`, 12s slots, 32 slots per
epoch); override them for a testnet.

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
