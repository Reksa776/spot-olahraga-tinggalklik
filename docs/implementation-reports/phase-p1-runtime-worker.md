# Phase P1 — Runtime and Worker Supervision

- **Date:** 2026-11-06
- **Status:** Complete for the approved P1 scope
- **Scope:** Notification worker runtime dependencies, PM2 supervision, restart policy, graceful shutdown, health probe, and deployment/rollback documentation.
- **Out of scope:** WhatsApp Gateway, live WhatsApp, account pairing, message sending, payment logic, ticket issuance logic, notification business logic, production environment changes, and production migrations.

## Guardrails observed

- No production database or production environment was accessed.
- No migration was run against production.
- No WhatsApp account was paired and no message was sent.
- Payment, ticket issuance, and notification business logic were not changed.
- Existing uncommitted user changes were preserved. No commit or push was made.
- P2 was not started.

## Files modified

| File | Change |
|---|---|
| `package.json` | Added `tsx` and `dotenv` as direct production dependencies; added `health:worker`; worker script now invokes `tsx` directly. |
| `package-lock.json` | Lockfile updated by `npm install` for the two production dependencies. |
| `ecosystem.config.cjs` | Added the `tinggalklik-worker` PM2 app and documented its lifecycle/security decisions. |
| `scripts/notification-worker.ts` | Updated the header comment to reflect PM2 supervision. Shutdown/runtime logic was not changed. |
| `scripts/notification-worker-health.ts` | **New.** Read-only health probe for the worker heartbeat/lease. |
| `DEPLOYMENT_RUNBOOK.md` | Documented worker runtime dependencies, PM2 operations, health checks, and rollback. |
| `docs/implementation-reports/phase-p1-runtime-worker.md` | **New.** This report. |

## Changes made

### 1. Runtime dependencies

`tsx` and `dotenv` are required by the worker at runtime:

- `scripts/notification-worker.ts` is TypeScript and is executed by `tsx`.
- The worker loads environment configuration through `dotenv`.
- Production installs use `npm ci` with `NODE_ENV=production`, which omits `devDependencies`. Keeping these packages in `devDependencies` would therefore break a production worker start.

Both were added to `dependencies`:

- `tsx@^4.23.15` (installed: `4.23.15`)
- `dotenv@^16.6.1` (installed: `16.6.1`)

The `worker:notifications` script now runs the locally installed runner:

```text
tsx scripts/notification-worker.ts
```

This avoids `npx` resolving or fetching a runner at process start. A new `health:worker` script runs the read-only probe.

### 2. PM2 supervision

`ecosystem.config.cjs` now declares a second app, `tinggalklik-worker`:

| Setting | Value | Reason |
|---|---|---|
| `script` | `node_modules/tsx/dist/cli.mjs` | PM2 supervises the installed runner directly, not an `npx` resolver. |
| `args` | `scripts/notification-worker.ts` | Existing worker entrypoint. |
| `interpreter` | `node` | Explicit Node runtime. |
| `instances` | `1` | The queue, lease, daily WhatsApp cap, and send cadence assume one poller. |
| `exec_mode` | `fork` | No cluster workers. |
| `autorestart` | `true` | Restart after a crash. |
| `min_uptime` | `30s` | A process that dies sooner counts toward the restart limit. |
| `max_restarts` | `10` | A crash loop becomes visible instead of restarting forever. |
| `restart_delay` | `5000` | Avoid hammering MariaDB during a failure. |
| `kill_timeout` | `30000` | Allow the in-flight claimed batch to finish after SIGTERM/SIGINT. |
| `max_memory_restart` | `256M` | Bound worker memory separately from the web app. |
| Port | none | The worker serves no HTTP and opens no network listener. |

The worker app inherits the host environment. No database URL, notification switch, SMTP credential, or WhatsApp secret is stored in the PM2 config.

### 3. Graceful shutdown

The worker already handles SIGTERM/SIGINT and calls `worker.stop()`, which stops claiming new work and awaits the in-flight batch. That behavior was preserved. PM2's `kill_timeout: 30000` gives that shutdown path time before escalation to SIGKILL.

No shutdown logic was rewritten in this phase.

### 4. Health monitoring

`scripts/notification-worker-health.ts` is a read-only probe over the existing `joblock: notification-dispatch` heartbeat/lease. It does not claim the lease, enqueue work, send anything, or write to the database.

Exit behavior:

- `0` / `status: disabled` when `NOTIFICATIONS_ENABLED` is off.
- `0` / `status: ok` when the heartbeat is recent or a lease is currently held.
- `1` / `status: unhealthy` when the heartbeat is missing, stale, or MariaDB cannot be read.

It prints JSON without a database URL, credential, recipient, phone number, or token.

### 5. Deployment and rollback documentation

`DEPLOYMENT_RUNBOOK.md` now covers:

- why `tsx` and `dotenv` must be production dependencies;
- starting, restarting, stopping, and inspecting `tinggalklik-worker`;
- the health probe and its exit meanings;
- stopping the worker before an application rollback;
- what happens to queued `Notification` / `NotificationDelivery` rows during rollback.

## Tests executed and actual results

| Check | Command / method | Actual result |
|---|---|---|
| Dependency install | `npm install --save tsx@^4.23.15 dotenv@^16.6.1` | Exit `0`; installed `tsx 4.23.15`, `dotenv 16.6.1`. |
| P1 Jest subset | 4 suites: `worker.test.ts`, `queue.test.ts`, `transports.test.ts`, `logging.test.ts` | **4 suites passed, 51 tests passed**, exit `0`. |
| Combined P1 + P7 regression | 14 explicit suites, `--runInBand` | **14 suites passed, 376 tests passed**, exit `0`. |
| PM2 config syntax | `node --check ecosystem.config.cjs` | Exit `0`. |
| PM2 structural assertions | Required app name, runner path, args, one fork instance, restart policy, kill timeout, memory cap, no port | **11/11 assertions true**, exit `0`. |
| TypeScript | `npx tsc --noEmit` | Exit `0`. |
| Diff whitespace check | `git diff --check` | Exit `0`. |
| Worker one-shot, disabled | `NOTIFICATIONS_ENABLED=false ... --once` | Exit `0`; `ran:false`, `reason:"DISABLED"`. No claim, no send. |
| Graceful SIGTERM smoke | Send SIGTERM to the worker process | Exit `0`; emitted `notification.worker.signal` and `notification.worker.stopped`. |
| Health probe, disabled | `NOTIFICATIONS_ENABLED=false npm run health:worker` | Exit `0`; `{"status":"disabled",...}`. |
| Health probe, healthy heartbeat | Probe with `NOTIFICATIONS_ENABLED=true` and a recent test-DB heartbeat | Exit `0`; `status:"ok"`, `leaseActive:false`, `maxAgeMs:240000`. |
| Health probe, stale heartbeat | Same probe with heartbeat aged ~1 hour | Exit `1`; `status:"unhealthy"`, `lastRunAgeMs` ~3,600,404 ms. |

### PM2 limitation

PM2 is **not installed in this environment**, so a real `pm2 start`, `pm2 restart`, `pm2 save`, and live `pm2 status` check were **not executed**. Validation was limited to:

- JavaScript syntax checking of `ecosystem.config.cjs`;
- structural inspection of the worker app definition;
- starting the worker entrypoint directly and exercising its SIGTERM path;
- exercising the health probe against the isolated test database.

This limitation must be closed on the deployment host before claiming PM2 supervision is live.

## Database used for testing

- MariaDB at `127.0.0.1:3306`.
- Isolated schema: `tinggalklik_test`.
- The P1 worker/queue tests use this schema.
- The health probe was exercised against this schema with synthetic heartbeat rows, then cleaned up.
- No production database, production credentials, or production schema was used.

## Remaining risks

1. **PM2 lifecycle is not proven in this environment.** The config is syntactically valid and structurally correct, but real start/restart/save/status behavior must be verified on the host.
2. **No alert delivery is configured.** The health probe returns an exit code; an external scheduler or monitoring system must run it and alert on exit `1`. PM2 restarts alone do not cover a stale worker that remains alive.
3. **The healthy path used a synthetic heartbeat.** It proves the probe's logic against a real joblock row, not a live worker's full polling cycle. The worker tests cover the real queue and shutdown behavior separately.
4. **Single-instance constraint remains.** The existing in-memory rate limiter and daily cap assumptions do not support multiple worker pollers. Scaling out requires a shared limiter/cap design first.
5. **`tsx` is now a production runtime dependency.** This adds a TypeScript runner to production startup. It was already the intended execution path; the change makes the dependency explicit and installable under `NODE_ENV=production`.
6. **Dependency audit was not remediated.** `npm audit` reported 26 vulnerabilities (4 low, 15 moderate, 7 high) after installation. This phase did not assess whether they predate P1 or remediate them; they remain a separate risk.
7. **No performance measurement.** Worker startup overhead and memory behavior were not benchmarked. The `256M` cap is a guardrail, not a measured optimum.

## Rollback instructions

Rollback is application-only; there is no P1 database migration.

1. Stop and remove the supervised worker:

   ```bash
   pm2 stop tinggalklik-worker
   pm2 delete tinggalklik-worker
   pm2 save
   ```

2. Remove the `tinggalklik-worker` block from `ecosystem.config.cjs`.
3. Restore the previous `worker:notifications` script and remove `health:worker` from `package.json`.
4. Remove `tsx` and `dotenv` from `dependencies` **only if no other code still needs them**, then restore `package-lock.json` and run `npm ci`.
5. Delete `scripts/notification-worker-health.ts`.
6. Revert the P1 additions in `DEPLOYMENT_RUNBOOK.md` and the header comment in `scripts/notification-worker.ts`.
7. If the release was committed, prefer `git revert <release-sha>`. Do not run a blanket `git checkout -- .`; the working tree contains unrelated user changes.

Stopping or deleting the worker does **not** delete `Notification` or `NotificationDelivery` rows. Leave queued work in place. Do not reset the queue during rollback. A delivery abandoned in `SENDING` becomes `FAILED/AMBIGUOUS_DELIVERY` after lease expiry and is not retried automatically; investigate it before re-enabling the worker.
