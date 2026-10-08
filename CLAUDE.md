# CLAUDE.md

Notes for working in this repo. Conventions and gotchas that are not obvious
from reading the code.

## Secrets and example files

`alertmanager/slack_url` holds the Slack incoming webhook and is gitignored.
The URL is a credential — anyone holding it can post to the channel.

**Never put a realistic-looking placeholder in a `.example` file.** A dummy that
keeps the real structure — the `/services/` path followed by a `T…` segment, a
`B…` segment and a ~24-character token — is indistinguishable from a live
webhook to a scanner, and GitHub push protection blocks the push (`GH013`).
That literal string is deliberately not reproduced here, because writing it out
would block this file too. Use an angle-bracket shape instead:

```
https://hooks.slack.com/services/<workspace-id>/<channel-id>/<token>
```

The same applies to any credential-shaped string: API keys, tokens, connection
URLs with passwords.

**If push protection does block a push:** it scans the diff of *every commit in
the push range*, not the final tree. Adding a follow-up commit that fixes the
file will not clear it — the string must be removed from the commit that
introduced it, by amending (if it is HEAD) or squashing. Create a backup branch
first, and delete it after the push succeeds, since it still carries the blob.

Do not use GitHub's "allow the secret" unblock URL to get past a false positive.
It permanently marks a credential-shaped string as reviewed, which erodes the
signal for the next one.

## Alerting

Prometheus evaluates all rules in `prometheus/alerts.yml`, but **only
`FcrReorgDetected` reaches Slack.** Alertmanager's default route points at
`blackhole`, a receiver with no notifiers — every other alert is grouped and
then dropped. This is deliberate, not a missing receiver. To make another rule
notify, add a route; do not delete rules to silence them.

`fcr_reorg_info` carries the block number and both hashes on its labels so the
notification can name the offending block. **Hashes as label values are
unbounded cardinality** — each reorg mints a series that lives for the whole
retention window. Hence the TTL (`REORG_ANNOUNCE_SECONDS`, default 900) and the
cap (`REORG_ANNOUNCE_MAX`, default 20): the announcement lives just long enough
to alert, then stops being exported. The durable record is `fcr_reorgs_total`
plus the Redis history. Raising the TTL substantially trades TSDB growth for a
longer alerting window — do it knowingly.

There is no resolved notification for reorgs. The announcement expiring means
the alerting window closed, not that the reorg was undone.

## Bind mounts on macOS

Docker Desktop's file sharing can serve a **truncated** copy of a bind-mounted
config to the container after an edit — the container sees a file that ends
mid-line while the file on disk is valid. It surfaces as a nonsense YAML parse
error from Prometheus or Alertmanager.

Validate the real file first, then recreate the container rather than debugging
the config:

```bash
docker run --rm -v "$PWD/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool prom/prometheus:v2.53.0 check config /etc/prometheus/prometheus.yml
docker compose up -d --force-recreate prometheus
```

Bind-mount config **directories**, not individual files: mounting a file path
that does not exist yet makes Docker silently create a directory there.

## Verifying alert changes

Do not wait for a real reorg. Point the webhook at a local sink on the compose
network and fire a synthetic alert, which exercises routing and templating end
to end:

```bash
docker run -d --rm --name slack-sink --network fcr-monitor_fcr fcr-monitor-monitor \
  node -e "require('http').createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{console.log(b);r.end('ok')})}).listen(8080)"
printf '%s' 'http://slack-sink:8080/hook' > alertmanager/slack_url
docker compose up -d --force-recreate alertmanager

docker compose exec alertmanager amtool --alertmanager.url=http://localhost:9093 \
  alert add alertname=FcrReorgDetected client=nimbus type=finalized_mismatch \
  block_number=1 recorded_hash=0xaaa observed_hash=0xbbb \
  --annotation='summary=pipe test'
docker logs slack-sink
```

Pass alert text as `--annotation`, not as a label — the Slack template reads
`.Annotations.summary`, so passing it as a label renders an empty first line and
looks like a template bug.

Restore the real webhook and recreate Alertmanager afterwards.
