# Indexer resilience and production monitoring

ArcOrigin derives its token, holder, trade, and chart views from confirmed Arc
logs and contract state. Redis is a performance cache, not a source of truth.

## Canonical snapshot rules

Every persisted token-index, holder, and market snapshot records both:

- `indexedBlock`
- `indexedBlockHash`

On restart, the server reads the same block from the canonical RPC before it
trusts the persisted snapshot. A changed hash marks the snapshot as orphaned;
the cache is discarded and the full confirmed state is rebuilt. Temporary RPC
unavailability does not delete the last snapshot.

Snapshots written before block hashes were introduced are upgraded in place by
reading the canonical hash for their existing checkpoint. This preserves the
last confirmed dataset and avoids an unnecessary full-history RPC scan during
deployments.

Event identity includes contract address, transaction hash, log index, and
event name. Overlapping backfills are idempotent. If an overlapping batch
contains a different block hash, the reconciler rolls back the fork block and
all later events before applying the replacement batch.

Run the deterministic resilience suite:

```bash
pnpm test:indexer-resilience
```

It covers duplicate logs, multiple same-name logs in one transaction, out of
order backfills, restart serialization, fork rollback, and canonical checkpoint
validation.

## Health endpoint

`GET /api/health` performs a redacted production check and returns HTTP `503`
only for a hard failure. It checks:

- RPC reachability and chain ID;
- Factory bytecode, owner, launch pause, and migration pause;
- token-index checkpoint canonicality and block lag;
- Redis configuration and reachability.

The response never returns RPC URLs, Redis URLs, webhook URLs, private keys, or
other credentials. Results are coalesced and cached in-process for 10 seconds
to avoid turning health polling into RPC load.

Configure the expected state:

```dotenv
MAINNET_GOVERNANCE_SAFE=0xa6eA2380F98700AD5CA8B9F74dC8861269513779
MAINNET_EXPECT_LAUNCHES_PAUSED=true
MAINNET_EXPECT_MIGRATIONS_PAUSED=true
```

Change an expectation only in the same reviewed release that executes the
corresponding Safe operation.

## External monitor and alerts

Run a one-shot check:

```bash
pnpm monitor:production
```

Recommended production variables:

```dotenv
PRODUCTION_HEALTH_URL=https://arcorigin.xyz/api/health
ALERT_WEBHOOK_URL=https://...
ALERT_WEBHOOK_FORMAT=slack
MONITOR_FAIL_ON_DEGRADED=false
MONITOR_TIMEOUT_MS=10000
```

`ALERT_WEBHOOK_FORMAT` supports `slack`, `discord`, or `generic`. When no
webhook is configured, failures still exit non-zero and print the unsent alert
for Railway, Better Stack, UptimeRobot, or another scheduler to capture.

Run the monitor logic tests:

```bash
pnpm test:production-health
```

For Railway, use a separate cron service pinned to the same commit and run
`pnpm monitor:production` every minute. The web service itself should use
`/api/health` as its deployment health-check path. Test an alert using a
temporary invalid `PRODUCTION_HEALTH_URL`; verify receipt, then restore the real
URL.

## Incident response

1. Do not clear Redis first; preserve the snapshot for investigation.
2. Check `/api/health` and application logs.
3. If the checkpoint is noncanonical, allow the automatic full rebuild.
4. If lag persists, verify the dedicated RPC and explorer fallback separately.
5. If Factory owner or pause state differs, treat it as a governance incident.
6. Keep launches and migrations paused until the mismatch is understood.
