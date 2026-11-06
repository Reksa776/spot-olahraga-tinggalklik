# Deployment and Monitoring Plan

**Status:** PROPOSED. No process, environment variable, server or PM2 configuration was changed.

---

## 1. Current deployment baseline

**VERIFIED.**

- `ecosystem.config.cjs:62-90` defines one PM2 app: `tinggalklik`, a forked Next.js process on `127.0.0.1:3003`, one instance, `kill_timeout: 10000`, `max_memory_restart: 512M`.
- The single instance is a correctness choice because `lib/rate-limit.ts` is in-memory and per-process (`ecosystem.config.cjs:23-29`).
- The notification worker is **not** in PM2 (`ecosystem.config.cjs` has no second app).
- `npm run worker:notifications` uses `npx tsx scripts/notification-worker.ts` (`package.json:21`); `tsx` and `dotenv` are not direct dependencies.
- The cron tick is documented in `.env.example` and calls `POST /api/internal/jobs/tick`; the route fails closed without `JOBS_TICK_SECRET`.
- Web health endpoints exist: `GET /api/health` (liveness, no dependencies) and `GET /api/health/ready` (database `SELECT 1`).
- The gateway/worker do not exist yet.

---

## 2. Target topology

**PROPOSED.**

```
                    Internet
                       │
                    nginx/TLS
                       │
             127.0.0.1:3003
          ┌────────────┴────────────┐
          │  Next.js web (PM2)      │
          │  tinggalklik            │
          └────────────┬────────────┘
                       │ MySQL/MariaDB
          ┌────────────┴────────────┐
          │  Notification worker    │
          │  tinggalklik-worker     │  separate PM2 fork, no port
          └────────────┬────────────┘
                       │ loopback HTTP + bearer token
          ┌────────────┴────────────┐
          │  WhatsApp gateway       │
          │  tinggalklik-wa         │  separate PM2 fork, 127.0.0.1:3100
          │  one Baileys socket     │
          └────────────┬────────────┘
                       │
              encrypted WA_AUTH_DIR
                       │
                 WhatsApp network

External cron ──POST /api/internal/jobs/tick──> web
```

Only nginx is public. The gateway port is never in the nginx upstream and never allowed through the firewall. The worker and gateway run as the same unprivileged service account, or the gateway gets a narrower account; neither runs as root.

---

## 3. PM2 process definitions

**PROPOSED additions; do not edit `ecosystem.config.cjs` until approved.**

| App | Script | Instances | Port | Notes |
|---|---|---|---|---|
| `tinggalklik` | existing Next binary | 1 fork | 3003 | unchanged |
| `tinggalklik-worker` | `node_modules/.bin/tsx scripts/notification-worker.ts` | 1 fork | none | `kill_timeout: 30000`; restart delay; log timestamps |
| `tinggalklik-wa` | `node_modules/.bin/tsx scripts/whatsapp-gateway.ts` | 1 fork | 3100 loopback | `kill_timeout: 30000`; restart delay; **must not cluster** |

Why one instance for the gateway: two sockets on one credential disconnect each other. Why one worker: the queue is CAS-safe, but one worker makes WhatsApp pacing and logs predictable; two are allowed only by explicit design.

**Runtime dependency (VERIFIED gap).** The scripts currently use `npx tsx`, which may download a package at runtime, and `scripts/notification-worker.ts:25` imports `dotenv/config` without a direct dependency. Before adding these apps:

- Add `tsx` and `dotenv` as explicit runtime dependencies (or compile the scripts to plain JS in the build).
- Verify with `npm ci --omit=dev` that both process entrypoints can start.
- Do not rely on a globally installed `tsx`.

`ecosystem.config.cjs` deliberately has no `env_file` (`:47-55`); keep secrets in the host environment or a host-managed file, not in the repository. Do not put `WA_GATEWAY_TOKEN`, `WA_SESSION_ENCRYPTION_KEY`, `AUTH_SECRET`, SMTP passwords or `JOBS_TICK_SECRET` in the PM2 file.

---

## 4. Environment contract

**PROPOSED.** Names only; values are supplied by the host.

| Variable | Process | Secret? | Purpose |
|---|---|---|---|
| `NOTIFICATIONS_ENABLED` | worker | No | Global kill switch; exact `"true"` only |
| `WHATSAPP_TRANSPORT=baileys` | worker | No | Select live transport after approval |
| `EMAIL_TRANSPORT=smtp` | worker | No | Select SMTP after approval |
| `WHATSAPP_LIVE_MODE` / `EMAIL_LIVE_MODE` | worker | No | `dry-run | allowlist | live` staged activation |
| `WHATSAPP_LIVE_ALLOWLIST` | worker | **Yes** (recipient data) | One controlled test recipient |
| `WHATSAPP_DAILY_CAP` | worker | No | Transactional ceiling (current default 20) |
| `WHATSAPP_DOCUMENT_DAILY_CAP` | worker | No | Document blast ceiling; default 0 |
| `WHATSAPP_SEND_DELAY_MS` | worker | No | Pacing |
| `NOTIFICATION_WORKER_POLL_MS`, `_BATCH_SIZE`, `_LEASE_MS` | worker | No | Existing tuning |
| `WA_GATEWAY_URL` | worker | No | `http://127.0.0.1:3100` |
| `WA_GATEWAY_TOKEN` | worker + gateway | **Yes** | Internal bearer auth |
| `WA_GATEWAY_PORT` | gateway | No | Default 3100 |
| `WA_AUTH_DIR` | gateway + pair CLI | No (path) | Absolute path outside checkout |
| `WA_SESSION_ENCRYPTION_KEY` | gateway + pair CLI | **Yes** | AES-256-GCM session key |
| `DOCUMENT_LINK_SECRET` | worker/web | **Yes** | HMAC for document links, when feature 4 exists |
| `SMTP_HOST/PORT/SECURE/USER/PASS/EMAIL_FROM` | worker | **PASS** | SMTP activation; not read while dry-run |
| `UPLOAD_DIR` | web + worker? | No | Persistent storage root; document tree is private |
| `JOBS_TICK_SECRET` | web + cron | **Yes** | Existing tick authentication |

`WA_AUTH_DIR` must not be under the checkout, and must not be included in a git archive, container image or unencrypted backup. The current `.gitignore` only has commented legacy entries (`.gitignore:35-36`); that is not a control.

---

## 5. Startup, restart and shutdown

### 5.1 Start order

**PROPOSED.**

1. MySQL/MariaDB reachable.
2. `tinggalklik` web (readiness 200).
3. `tinggalklik-wa` gateway: acquire `joblock:whatsapp-gateway`, file lock, decrypt session, connect; `/readyz` 200.
4. `tinggalklik-worker`: acquire `joblock:notification-dispatch`; it can start before the gateway, but WhatsApp claims wait for readiness.
5. External cron installed and verified.

The worker must not fail permanently if the gateway is down; it leaves WhatsApp rows `QUEUED` and retries. Email remains independent.

### 5.2 Restart behaviour

| Event | Expected |
|---|---|
| Worker crash | PM2 restarts; lease expires or is reacquired; `SENDING` rows recovered as ambiguous, not resent |
| Gateway crash | PM2 restarts; auth state persists; reconnect with backoff; worker retries transiently |
| Web reload | In-flight requests finish; worker/gateway continue |
| Host reboot | PM2 startup units restore web/worker/gateway; cron remains; session volume mounts before gateway |
| Session logout | Gateway does **not** loop; state `LOGGED_OUT`; alert; operator re-pairs |
| DB down | Web readiness 503; gateway cannot renew lease and closes socket; worker leaves rows queued |
| Disk full | Auth writes/uploads fail; alerts; do not delete queue rows to make space |

`kill_timeout` for worker/gateway must exceed the graceful shutdown deadline (10s send + flush); 30s is proposed. PM2 must send `SIGINT`/`SIGTERM`, not `SIGKILL` first.

### 5.3 Deploy sequence

1. Build and verify.
2. Stop worker (drain current batch).
3. Stop gateway (after worker; flush session).
4. Apply approved migration (only if any).
5. Deploy code; run readiness.
6. Start gateway; wait for `/readyz`.
7. Start worker; run `--once` with notifications disabled.
8. Enable the approved live mode.
9. Watch queue/health for 15 minutes; rollback on failure.

Never deploy web and gateway from different session-key versions without a rekey plan.

---

## 6. Health checks and monitoring

### 6.1 Probes

| Target | Probe | Healthy |
|---|---|---|
| Web liveness | `GET /api/health` | 200 `{"status":"ok"}` |
| Web readiness | `GET /api/health/ready` | 200 and `database: ok` |
| Gateway liveness | `GET 127.0.0.1:3100/healthz` | 200, process alive |
| Gateway readiness | `GET 127.0.0.1:3100/readyz` | 200 only if lease + socket connected |
| Worker heartbeat | DB `joblock` row `notification-dispatch` | `lastRunAt` < 10 minutes |
| Tick heartbeat | DB `joblock` rows for three jobs | `lastRunAt` < 5 minutes |
| Gateway lease | DB `joblock` row `whatsapp-gateway` | `lastRunAt`/`updatedAt` fresh |

Do not make the public web health endpoint depend on WhatsApp. A WhatsApp outage is not a reason to take the whole site out of rotation.

### 6.2 Alert rules

**PROPOSED.**

- Gateway not ready > 2 minutes, or `LOGGED_OUT`/`CONFLICT`/`FENCED` for any duration.
- Worker heartbeat older than 10 minutes.
- Any job `lastStatus = FAILED` for two consecutive ticks.
- `NotificationDelivery` `SENDING` with `nextRetryAt < now - 5 min`.
- `FAILED` rate above an approved threshold in 15 minutes.
- Oldest `QUEUED` WhatsApp row older than the approved SLO.
- Daily cap reached while transactional rows are waiting.
- `WhatsAppGatewayMessage` `AMBIGUOUS` count increases.
- Disk usage > 80%; `WA_AUTH_DIR`/`UPLOAD_DIR` backup age > 24h.
- TLS certificate expiry < 14 days; web 5xx rate.

Alerts contain counts/ids, never recipients or message bodies.

### 6.3 Logs

- Keep PM2 timestamps and merged logs; install `pm2-logrotate` (the existing file intentionally leaves rotation to the operator, `ecosystem.config.cjs:55-58`).
- Structured JSON from the worker/gateway; no token, QR, auth path, full phone/email or message body.
- Retain 14–30 days; restrict access; ship only if the destination is approved.
- Never send WhatsApp auth files to a log or APM.

---

## 7. Backup and restore

**PROPOSED.**

- Database: nightly logical backup plus binlog/point-in-time if available; test restore monthly.
- `UPLOAD_DIR`: event images and private document tree; back up encrypted; document retention must be reflected in restore.
- `WA_AUTH_DIR`: encrypted backup **separately**; access restricted; restore only on the same service account. A restored stale session may be logged out; treat it as `PAIRING_REQUIRED`.
- `DOCUMENT_LINK_SECRET`/`WA_SESSION_ENCRYPTION_KEY`: in the secret manager, not the backup archive.
- Verify restore on a non-production host; record RPO/RTO.
- Do not restore a gateway dispatch table to a state older than sent messages and then replay; that can duplicate. Prefer losing ack metadata over resending.

---

## 8. Security operations

- Dedicated unprivileged OS user for web/worker/gateway.
- Firewall: only 80/443 public; 3003/3100 loopback; SSH restricted.
- `WA_AUTH_DIR` mode 0700, files 0600, encrypted at rest; no world-readable backup.
- Secrets in the host environment/secret store; rotate `WA_GATEWAY_TOKEN`, `WA_SESSION_ENCRYPTION_KEY` (rekey), `DOCUMENT_LINK_SECRET` (invalidates links), SMTP and tick secret on a schedule.
- Gateway token comparison constant-time; body size limit; no proxy route.
- Disable directory listing; nginx must not alias `UPLOAD_DIR`.
- Keep `UPLOAD_DIR` outside the web root; existing public image route only serves `events/` with basename checks (`app/api/uploads/events/[filename]/route.ts:29-67`).
- Monitor dependency advisories (Baileys is unofficial; nodemailer has known advisories in the audit). Pin exact versions and review before upgrades.
- No remote shell/QR pairing over chat; pairing requires host access.

---

## 9. Capacity and failure assumptions

**PROPOSED.**

- One WhatsApp socket, one send at a time, 5s minimum delay (existing default). At 20/day the transactional cap is tiny; a document blast needs an owner-approved cap and will be slow by design.
- Email concurrency 3 (existing `lib/notifications/config.ts:227-228`).
- Worker batch 20; queue age is the primary scaling signal.
- Single VPS, single MariaDB, local disk. No horizontal scale until the rate limiter, session ownership and storage are redesigned.
- A gateway ban/logout is a single point of failure for WhatsApp; email remains independent for proofs/tickets. H-36 is WhatsApp-only and must be communicated as such.

---

## 10. Rollback

**PROPOSED.**

| Change | Rollback |
|---|---|
| Live transport | `WHATSAPP_TRANSPORT=dry-run`, `NOTIFICATIONS_ENABLED=false`; stop worker/gateway; queued rows remain |
| Gateway deployment | Stop `tinggalklik-wa`; worker gets 503 and retries; no socket left |
| Worker deployment | Stop worker; queue remains; restart previous version |
| New PM2 apps | `pm2 delete` after stopping; restore previous `ecosystem.config.cjs` |
| Ack/priority/cap code | Revert code; keep additive columns/tables (unused) until a safe migration rollback |
| Document migration | Disable document routes/job; drop new tables only after export; keep `DOCUMENT` enum value if rows exist |
| Session key rotation | Rekey under the prior key only if the prior key is still in the secret store; otherwise re-pair |

Rollback must never delete `Notification`/`NotificationDelivery` rows or resend terminal failures automatically.

---

## 11. Deployment acceptance

- `npm ci --omit=dev` can start web, worker and gateway.
- PM2 survives a host reboot; all three apps restore; cron runs.
- Web liveness/readiness, gateway liveness/readiness, worker heartbeat and tick heartbeat are observed.
- A stopped worker/gateway triggers an alert within the agreed window.
- A controlled live WhatsApp send is observed once; a replay produces no duplicate.
- Session backup/restore and re-pair procedure are documented and tested on a non-production host.
- No secret appears in `ecosystem.config.cjs`, git, logs or the health response.
