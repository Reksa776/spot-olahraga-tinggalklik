# PHASE 1 — EMAIL/WHATSAPP FOUNDATION + DELIVERY QUEUE
## IMPLEMENTATION REPORT

**Project:** TinggalKlik.Co
**Date:** 2026-11-04 (WIB)
**Branch:** `main` · **HEAD:** `25cbf0c` (unchanged)
**Mode:** IMPLEMENTATION — dry-run only, `NOTIFICATIONS_ENABLED=false`
**Scope:** Phase 1 only. No Phase 2–5 work. No commit, push, reset, rebase, stash, deploy, migration, or production configuration change.

---

## 0. Status

# PASS — PHASE 1 DRY-RUN SCOPE

Phase 1's foundation is implemented and verified: idempotent enqueue, an existing-schema delivery queue, a standalone polling worker with a database lease and CAS claims, dry-run email/WhatsApp transports, a fail-closed SMTP adapter skeleton, a fail-closed Baileys adapter skeleton, retry metadata, ambiguous-delivery recovery that never auto-resends, and structured logging without secrets.

Two **documented deviations** from the pre-implementation audit are recorded in §1.3. Neither weakens a Phase 1 safety property. No migration was created or run.

Evidence in one line: **51/51 Phase 1 tests pass, 17/17 Phase 15 job tests still pass, `tsc` exit 0, `eslint` 0 errors, `next build` exit 0, `prisma migrate status` = up to date (32 migrations), worker `--once` exits 0 reporting `DISABLED`, application DB still 44 notifications / 44 with `category IS NULL` / 0 deliveries / 0 job locks.**

---

## 1. Pre-execution audit

### 1.1 Measured condition at start

| Check | Result |
|---|---|
| `git status` | 10 pre-existing modified files from Phase 0A–0C + 8 untracked Phase reports/guards. **All preserved.** |
| Branch / HEAD | `main` / `25cbf0c` — matches the audit report |
| `notification` rows (application DB) | **44**, all `category IS NULL` |
| `notificationdelivery` / `joblock` rows (application DB) | **0 / 0** |
| Schema | `notification`, `notificationdelivery`, `joblock` present; `idempotencyKey @unique`, `UNIQUE(notificationId, channel)`, `INDEX(status, nextRetryAt)` present |
| `nodemailer` installed | **8.0.11** (exact pin), **zero imports** in `lib/`, `app/`, `scripts/` |
| `@whiskeysockets/baileys` installed | **6.7.24**, **zero imports** |
| `auth.ts` | Google + Credentials only; **no Email provider, no magic link** |
| Existing lease pattern | `lib/jobs/lock.ts` on `joblock`; `JOB_NAMES` deliberately exactly two jobs |
| Tick route | `POST /api/internal/jobs/tick`, machine bearer secret, constant-time, fail-closed |
| Test database | `tinggalklik_test` exists, migrated (32/32) — `npm run test:db:setup` exit 0 |
| Pre-existing notification code | none (`grep` for `prisma.notification*` in `lib/`, `app/`, `scripts/` returned nothing) |

### 1.2 Constraints confirmed before writing code

* No migration (`migrate deploy`, `migrate dev`, `db push`, manual DDL/DML) may run.
* `NOTIFICATIONS_ENABLED` default must be OFF; invalid values must be OFF.
* SMTP and Baileys may exist as structure only; no connection, auth, pairing, session or send.
* `category IS NULL` legacy rows must never be dispatched.
* Worker must be a separate polling process, not request-driven.
* No Auth.js Email provider.

### 1.3 Deviations from `PHASE_1_PRE_IMPLEMENTATION_AUDIT_REPORT.md`

| # | Audit assumption | Actual condition | Decision |
|---|---|---|---|
| **D1** | `notification` can be inserted by Prisma | Live `notification` still has legacy **`notificationType VARCHAR(191) NOT NULL` with no DB default**, while `schema.prisma` had dropped the field. Every INSERT failed with `Null constraint violation on the fields: (notificationType)`. | Mapped the existing column back into the Prisma model with a **client-side** default `"SYSTEM"` and a comment. **No DDL, no migration, no data change.** A future migration should give it a DB default or drop it with the other retail remnants. |
| **D2** | Add `lockedUntil`, `lockedBy`, `lastAttemptAt` + `INDEX(status, lockedUntil)` via a migration file (not run) | A migration **file** alone breaks every integration suite: `__tests__/support/global-setup.ts` refuses to run when the test DB has fewer applied migrations than the files on disk, and Phase 1 forbids applying them. | No schema change. The existing **`nextRetryAt`** is reused as the per-row lease deadline while `status = SENDING`. Documented in `lib/notifications/queue.ts` and §8. |
| **D3** | `EMAIL_TRANSPORT=disabled\|log\|smtp` | The owner's brief names the active Phase 1 transport "dry-run". | Implemented as `disabled \| dry-run \| smtp` (and `disabled \| dry-run \| baileys`). |
| **D4** | Add a second PM2 app to `ecosystem.config.cjs` | `pm2 start ecosystem.config.cjs` would then **activate a new process** on the next deploy. Even in dry-run, starting a process is an operator/owner action, and the realtime suite asserts on that file. | Left `ecosystem.config.cjs` untouched. The exact worker command, process definition and health check are documented in §7. |
| **D5** | `npm run wa:pair` CLI | Pairing is explicitly forbidden in Phase 1. | No pairing CLI was created. |
| **D6** | Template registry | Business templates belong to Phases 2/4/5. | One synthetic template only: `phase1.dry-run.v1`. |

---

## 2. Changed and created files

**Created — foundation (11):**

```
lib/notifications/types.ts                 channel allow-list + transport contract
lib/notifications/config.ts                kill switch, dry-run clamp, tuning
lib/notifications/logger.ts                structured log, secret + recipient redaction
lib/notifications/templates.ts             server-side registry (synthetic template only)
lib/notifications/enqueue.ts               the ONLY queue writer; idempotent
lib/notifications/queue.ts                 CAS claim, retry, terminal states, lease recovery
lib/notifications/worker.ts                polling batch worker, concurrency, shutdown
lib/notifications/worker-lock.ts           joblock lease + heartbeat
lib/notifications/transports/dry-run.ts    active Phase 1 email/WhatsApp transports
lib/notifications/transports/smtp.ts       SMTP structure, always refuses, no nodemailer import
lib/notifications/transports/baileys.ts    Baileys structure, always refuses, no import
```

**Created — entrypoint and tests (5):**

```
scripts/notification-worker.ts             standalone process entrypoint (--once supported)
__tests__/notifications/config.test.ts     flag parsing + transport clamp
__tests__/notifications/transports.test.ts dry-run behaviour + static no-provider guards
__tests__/notifications/queue.test.ts      queue against the real test database
__tests__/notifications/worker.test.ts     worker, concurrency, shutdown, log sanitisation
__tests__/notifications/logging.test.ts    log redaction
```

**Modified (4):**

```
prisma/schema.prisma        D1: legacy notificationType mapped back with client default (no DDL)
jest.config.js              registers the `__tests__/notifications/*.test.ts` namespace
package.json                adds `worker:notifications` (uses npx tsx, like existing scripts)
.env.example                documents the Phase 1 notification contract (all placeholders)
```

**Not modified:** `auth.ts`, `proxy.ts`, `next.config.ts`, `ecosystem.config.cjs`, all payment/issuance/checkout code, `package-lock.json`, all Phase 0A–0C work, all 44 legacy rows, `prisma/migrations/**`.

---

## 3. Architecture before and after

### Before

```
Next.js (PM2, :3003)
  ├── Google + Credentials auth           (no email provider)
  ├── tick route → event-lifecycle, reservation-reaper   (joblock lease)
  └── NO writer of notification / notificationdelivery
notification      44 legacy rows, category NULL
notificationdelivery  0 rows, constraints ready but unused
joblock           0 rows (tick never ran here)
nodemailer 8.0.11, Baileys 6.7.24 installed, unreferenced
no worker, no provider adapter, no queue library
```

### After

```
Next.js (web process)                    Worker (separate OS process)
  ├── auth unchanged                       ├── poll every 5 s (configurable)
  ├── tick unchanged                       ├── joblock lease + heartbeat
  └── enqueueNotification() only when      ├── recover expired SENDING leases
      a later phase calls it               ├── CAS-claim QUEUED deliveries
                                           ├── render server-side template
                                           └── dry-run transport (email / WhatsApp)
                    │                                      │
                    └───────────────┬──────────────────────┘
                                    ▼
                    notification (intent) 1 ── n notificationdelivery (per channel)
                    status: QUEUED → SENDING → SENT | FAILED | SKIPPED
                    nextRetryAt = retry instant, OR lease deadline while SENDING

SMTP adapter     : structure only, throws, no nodemailer import, never selected
Baileys adapter  : structure only, throws, no import, no pairing, no session, never selected
Dry-run transport: the ONLY transport Phase 1 can instantiate
```

**Boundary rule enforced:** only `lib/notifications/enqueue.ts` writes the queue tables; only the worker reads provider credentials (none exist yet); the web request path imports nothing from `lib/notifications` (asserted by test).

---

## 4. Email foundation — SMTP target, inactive

* `lib/notifications/transports/smtp.ts` contains the adapter **shape**: a validated `SmtpAdapterConfig` (`host`, `port`, `secure`, `user`, `from` — the password is deliberately **not** in the type) and a factory that **always throws** `Phase1TransportRefusedError`.
* The module has **no `nodemailer` import**. Avoiding the import keeps the vulnerable 8.0.11 parser off the worker's import graph entirely (Phase 0C B1), not merely unused.
* The documented Phase 2 contract requires: TLS verification, connection/socket timeouts, `disableFileAccess`, `disableUrlAccess`, no `raw`, plain text, `from` from configuration, recipient from the queue row.
* Configuration can never select SMTP: `resolveNotificationConfig` clamps `smtp` to `dry-run` and records a refusal. The clamp is the code constant `PHASE_1_DRY_RUN_ONLY`, not an environment variable.
* Auth.js Email provider remains absent: `auth.ts` is untouched (Google + Credentials only).

---

## 5. WhatsApp foundation — Baileys prepared, inactive

* `lib/notifications/transports/baileys.ts` contains the adapter shape and the documented Phase 2+ contract (one socket, `joblock` session lease, `WA_AUTH_DIR` outside the checkout, logout = re-pair rather than reconnect loop, one message at a time).
* The module has **no Baileys import**, no `makeWASocket`, no `useMultiFileAuthState`, no QR/pairing code, and **creates no session directory** (asserted by test).
* `createBaileysWhatsAppTransport()` always throws `Phase1WhatsAppRefusedError`.
* Configuration clamps `baileys` to `dry-run` and records a refusal.
* No operator pairing command was added; pairing is explicitly a later-phase, host-only action.

---

## 6. Delivery queue implementation

Uses the existing tables, no new queue table:

| Concern | Implementation |
|---|---|
| Enqueue | `enqueueNotification()` — one atomic nested create of `notification` + `notificationdelivery` |
| Enqueue idempotency | `notification.idempotencyKey @unique`; a duplicate returns the existing pair (`created: false`) and repairs a missing delivery with `skipDuplicates` |
| Fan-out idempotency | `UNIQUE(notificationId, channel)`; duplicate insert raises `P2002` (tested) |
| Channel allow-list | `EMAIL`, `WHATSAPP`; `IN_APP` refused |
| Category requirement | required at enqueue and at claim; `category IS NULL` can never be queued by this writer |
| State | `QUEUED → SENDING → SENT \| FAILED \| SKIPPED` |
| Retry metadata | `attemptCount` incremented by the claim; `maxAttempts`; `nextRetryAt` |
| Transactional enqueue | yes — nested create is atomic. It performs no network I/O, so it is safe to call **after** a payment/issuance commit (and must never be called inside that transaction) |
| Exactly-once claim | "at most one worker sends a claimed row", not exactly-once delivery (§9) |

`enqueue` is **not** wired into payment/issuance in Phase 1 — purchase proof is Phase 2.

---

## 7. Worker execution strategy

* Separate process: `scripts/notification-worker.ts`, started by `npm run worker:notifications` (or `… -- --once`).
* Independent **database polling**, default every 5 s; it never waits for, or is started by, an HTTP request.
* It does **not** replace `runJobsTick`: event lifecycle and reservation reaper remain on the tick route.
* Batch sequence: kill-switch check → worker lease → ambiguous recovery → claim EMAIL → claim WHATSAPP → release lease with heartbeat status.
* Concurrency: **email 3**, **WhatsApp 1** (one future socket must not be parallelised).
* Graceful shutdown: `stop()` stops the loop, wakes the poll sleep, and awaits the in-flight batch; no new row is claimed. The entrypoint maps `SIGTERM`/`SIGINT` to `stop()` and then disconnects Prisma.
* Supported process definition (not added to `ecosystem.config.cjs`, by design):

```js
{
  name: "tinggalklik-worker",
  cwd: __dirname,
  script: "node_modules/.bin/tsx",
  args: "scripts/notification-worker.ts",
  instances: 1,
  exec_mode: "fork",
  autorestart: true,
  kill_timeout: 10000,
  time: true,
  merge_logs: true,
}
```

  `tsx` is currently resolved through `npx` (the same pattern as the repository's existing operator scripts); adding it as a declared devDependency is a follow-up (§15).

**Health check:** `joblock` row `notification-dispatch` — `lastRunAt` should advance every poll; `lastStatus` is `OK`/`FAILED`; `lockedUntil` non-null means a batch is running; a stale `lastRunAt` means the process is not alive.

---

## 8. Lease and concurrency

| Layer | Mechanism | Effect |
|---|---|---|
| Batch single-flight | `joblock.name = "notification-dispatch"`, conditional `updateMany` on `lockedUntil IS NULL OR < now` | overlapping workers are a cheap no-op |
| Heartbeat | `renewNotificationWorkerLease` with `lockedBy = this worker`, between channels | a large batch does not let its own lease expire |
| Row claim | `UPDATE notificationdelivery … WHERE id = ? AND status='QUEUED' AND (nextRetryAt IS NULL OR nextRetryAt <= now)`, setting `SENDING`, `attemptCount+1`, `nextRetryAt = now + lease` | two workers never process one row |
| Stale lease recovery | expired `SENDING` → `FAILED / AMBIGUOUS_DELIVERY` | unblocks the row **without** resending |

`nextRetryAt` carries two meanings by status: retry instant while `QUEUED`, lease deadline while `SENDING`. This is the documented consequence of not adding `lockedUntil` (D2). The row-level CAS remains the correctness guard; the `joblock` lease never substitutes for it.

**Verified:** two concurrent batches claim one row exactly once (`attemptCount = 1`); a live lease prevents a second claim; a held worker lease returns `reason: "LEASE_HELD"`.

---

## 9. Retry and idempotency, including the ambiguous case

Backoff (from `lib/notifications/queue.ts`):

| Attempt | Delay | Notes |
|---|---|---|
| 1 → 2 | 60 s ± 20 % | transient transport/DB errors |
| 2 → 3 | 5 min ± 20 % | transient |
| 3 | terminal `FAILED` | `maxAttempts` reached |

Idempotency layers: enqueue key → per-channel unique → CAS claim → terminal `SENT` is never re-sent.

**Ambiguous outcome policy (owner requirement §7):** if a worker dies after a provider accepted a message but before `SENT` was persisted, the row is left `SENDING` with an expiring lease. Recovery marks it **`FAILED / AMBIGUOUS_DELIVERY`**. It is **never** returned to `QUEUED` automatically, because a resend could duplicate a message. An operator decides. This is why the queue does not promise exactly-once delivery, only at-most-one in-flight worker per row.

Under Phase 1 dry-run the provider cannot have accepted anything, so `AMBIGUOUS_DELIVERY` is reachable only by a crash or by test injection.

---

## 10. Legacy data isolation

* `enqueueNotification` requires `category`, so it cannot create an uncategorised row.
* Every claim query requires **both** `notification.category IS NOT NULL` **and** `notification.templateKey IS NOT NULL`.
* The worker additionally re-checks the row after claiming and skips (`LEGACY_OR_UNCATEGORIZED`) rather than rendering.
* The 44 legacy rows were **read only**; counts before and after implementation are identical: `notification = 44`, `category IS NULL = 44`, `notificationdelivery = 0`, `joblock = 0`.
* Tested: a row with `category NULL` and a `QUEUED` WhatsApp delivery is never claimed and stays `QUEUED, attemptCount 0`.

---

## 11. Migration impact

| Question | Answer |
|---|---|
| Migration created | **NO** |
| Migration run | **NO** |
| `migrate deploy` / `migrate dev` / `db push` / manual DDL-DML | **NONE** |
| Schema file changed | **YES, one field only** — `Notification.notificationType String @default("SYSTEM")` (D1) to match an **already-existing** `NOT NULL` column. No new column, index or table. |
| `prisma generate` | Run (client regeneration only; no database access) |
| `prisma migrate status` | `Database schema is up to date!` — 32 migrations |
| Test DB | Still 32/32 applied; no migration file added, so the global setup guard remains satisfied |

**Recommended future migration (not created):** give `notification.notificationType` a database default, or drop it together with the other retail remnants; then remove the compatibility field from the model. This requires backup + owner approval and is deliberately outside Phase 1.

---

## 12. Environment configuration

Added to `.env.example` (placeholders only — no real credential):

```
NOTIFICATIONS_ENABLED="false"        # OFF unless exactly "true"
EMAIL_TRANSPORT="dry-run"            # disabled | dry-run | smtp (smtp REFUSED in Phase 1)
WHATSAPP_TRANSPORT="dry-run"         # disabled | dry-run | baileys (baileys REFUSED)
# SMTP_HOST / PORT / SECURE / USER / PASS / EMAIL_FROM   commented placeholders
# WA_AUTH_DIR                                            commented placeholder
NOTIFICATION_WORKER_POLL_MS="5000"
NOTIFICATION_BATCH_SIZE="20"
NOTIFICATION_LEASE_MS="120000"
```

Parsing: flag OFF for absent/empty/invalid; transports clamped to `dry-run`/`disabled`; invalid numeric values fall back to documented defaults and are reported at startup. No secret is read by the web process; the web process imports nothing from `lib/notifications`.

---

## 13. Test results

Command: `npx jest __tests__/notifications --runInBand --silent`

```
PASS __tests__/notifications/worker.test.ts
PASS __tests__/notifications/queue.test.ts
PASS __tests__/notifications/transports.test.ts
PASS __tests__/notifications/logging.test.ts

Test Suites: 4 passed, 4 total
Tests:       51 passed, 51 total
```

Coverage against the required minimum:

| Required proof | Test |
|---|---|
| Dry-run email makes no SMTP connection | `transports.test.ts` spies `net.Socket.prototype.connect`; source guard forbids `nodemailer`/`net`/`tls` imports |
| Dry-run WhatsApp does no pairing | `transports.test.ts` (socket spy, no QR/pairing/session source) |
| Feature flag default OFF | `config.test.ts` — 10 absent/invalid values |
| Invalid flag stays OFF | `config.test.ts` |
| No real provider can be called | `transports.test.ts` — SMTP/Baileys factories throw, source guards, worker refuses injected live transport |
| Enqueue idempotent | `queue.test.ts` — same key twice → 1 row, same ids |
| Duplicate delivery rejected | `queue.test.ts` — `P2002` on `UNIQUE(notificationId, channel)` |
| Legacy `category IS NULL` not processed | `queue.test.ts` |
| Worker can poll | `worker.test.ts` — batch claims and completes; lease/heartbeat recorded |
| Lease prevents two workers on one job | `worker.test.ts` — concurrent batches claim 1; live worker lease → `LEASE_HELD` |
| Expired lease recoverable | `queue.test.ts` — recovery only after expiry |
| Retry not before `nextRetryAt` | `queue.test.ts` — 1 s early = not claimable; 61 s = claimable |
| Graceful shutdown | `worker.test.ts` — in-flight row completed, second row never claimed, `STOPPING` afterwards |
| Ambiguous status not auto-resent | `queue.test.ts` — `FAILED/AMBIGUOUS_DELIVERY`, never claimed 24 h later |
| No secret in structured log | `logging.test.ts` + `worker.test.ts` — password/connection string/recipient absent |
| Kill switch performs no work | `worker.test.ts` — `DISABLED`, row untouched, no lease row |
| Dry run is never recorded as `SENT` | `worker.test.ts` + `queue.test.ts` — `SKIPPED / DRY_RUN_SIMULATED`, `sentAt` and `providerMessageId` null |

**Regression check (unmodified suite):** `npx jest __tests__/jobs --runInBand --silent` → **17/17 passed**. The existing `joblock` pattern and `JOB_NAMES` (still exactly two jobs) are unaffected.

---

## 14. Build, lint, typecheck

| Check | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit` | **exit 0** |
| Lint | `npx eslint lib/notifications scripts/notification-worker.ts __tests__/notifications jest.config.js` | **exit 0, 0 errors** |
| Prisma validate | `npx prisma validate` | **exit 0** — schema valid |
| Build | `npm run build` | **exit 0** — Next.js production build completed |
| Runtime smoke test | `npm run worker:notifications -- --once` | **exit 0** — logged `notificationsEnabled:false`, `reason:"DISABLED"`, `claimed:0`, `sent:0` |

The build and `--once` run used the default (OFF) configuration. The `--once` run performed no database write.

---

## 15. Known limitations

1. **No per-delivery lock columns.** `nextRetryAt` is the lease deadline while `SENDING` (D2). There is no stored `lockedBy` per delivery, so "which worker" is only visible at batch level in `joblock`.
2. **`notificationType` is a compatibility mapping** (D1). It is written as `"SYSTEM"` and should be retired by a future migration.
3. **The worker is not in PM2 yet.** Starting it is an operator action (§7). `tsx` is invoked via `npx`, like the repository's other operator scripts; making it a declared devDependency is a follow-up.
4. **No web read surface for delivery status**, and therefore no polling UI. Phase 1 has no status page; the queue status is read from the database. Realtime cross-process propagation remains out of scope (bus is in-process).
5. **Nothing calls `enqueueNotification` in production yet.** Wiring it to settlement is Phase 2, and must happen after commit.
6. **Ambiguous deliveries need a human.** There is no automatic or operator requeue command; a `FAILED/AMBIGUOUS_DELIVERY` row is terminal by design.
7. **One synthetic template only.** Business wording/templates are Phase 2/4/5.
8. **Batch heartbeat is between channels.** A single send longer than `NOTIFICATION_LEASE_MS` (120 s default) could let the batch lease expire; the per-row CAS still prevents a duplicate claim, and the row-level lease would surface the crash as ambiguous rather than silently resending.
9. **No rate limiting per recipient.** Not needed in dry-run; required before real WhatsApp activation.

---

## 16. Security residual risks

| Risk | Status |
|---|---|
| 4 High advisories in the `nodemailer`/`@auth/core`/`next-auth` chain (Phase 0C) | **Unchanged and still accepted.** `nodemailer` remains 8.0.11; **not imported** by Phase 1 code; Auth.js Email provider remains absent. Activation still needs the C1 owner decision. |
| Baileys is an unofficial WhatsApp client (ban/ToS/session risk) | Inactive. No import, socket, pairing, QR or session directory. C4 decision still pending. |
| Credential leakage through logs | Mirrored in `logger.ts`: secret-named keys redacted, recipients masked, connection strings stripped, error messages sanitised (including email/phone-shaped text). Tested. |
| Credential leakage through source/repo | No real credential added; `.env.example` contains placeholders only; no SMTP/WhatsApp env is read by Phase 1 code. |
| SSRF/file-read through a future mail transport | Not reachable now (adapter throws). Phase 2 contract requires `disableFileAccess`, `disableUrlAccess`, no `raw`, TLS verification, timeouts. |
| Duplicate message after a crash | Mitigated by `AMBIGUOUS_DELIVERY` (no automatic resend), not eliminated — exactly-once is impossible over SMTP. |
| Legacy rows accidentally dispatched | Excluded in the query and re-checked in the worker; tested. |
| Worker accidentally started with a live transport | Config clamps to dry-run; the worker throws if an injected transport reports `smtp`/`baileys`; tested. |
| Migration/test-DB inconsistency | No migration created. |

---

## 17. Confirmation: no real provider is active

* `NOTIFICATIONS_ENABLED` default: **false**; invalid/absent → **false** (tested).
* `EMAIL_TRANSPORT`/`WHATSAPP_TRANSPORT`: requested `smtp`/`baileys` are **downgraded to dry-run** with a refusal (tested).
* SMTP connection: **none**. No `nodemailer` import; SMTP factory throws; socket spy asserted.
* SMTP authentication: **none**.
* WhatsApp pairing / QR / session / socket: **none**. Baileys factory throws; no import; no directory created.
* Message transmission: **none**. Dry-run returns `simulated: true`; delivery is recorded `SKIPPED / DRY_RUN_SIMULATED`, never `SENT`; no `providerMessageId` is ever written.
* Worker `--once` with no configuration: `ran:false`, `reason:"DISABLED"`, `claimed:0`, `sent:0` (output captured in §14).
* `auth.ts` unchanged: no Auth.js Email provider / magic link.

---

## 18. Confirmation: no migration was run

* No directory was added under `prisma/migrations` (`git status prisma/migrations` is empty).
* `prisma migrate status` reports **32 migrations, database up to date**.
* No `migrate deploy`, `migrate dev`, `db push`, `ALTER`, `INSERT`, `UPDATE` or `DELETE` was executed against the application database. Application DB counts before/after: **44 / 44 category NULL / 0 deliveries / 0 job locks**.
* The test database was used only by Jest fixtures, which clean up after themselves (post-run counts: 0 legacy / 0 deliveries / 0 job locks in `tinggalklik_test`).
* `prisma generate` regenerated the client from the edited model; it does not touch the database.

---

## 19. Recommendation

**PASS for Phase 1 (dry-run foundation).**

Rationale:
* Every Phase 1 deliverable is implemented inside the stated boundary.
* The safety properties are proven, not asserted: OFF flag, transport clamp, no provider import, no socket/pairing, dry-run never recorded as `SENT`, legacy rows invisible, no automatic ambiguous resend, no secrets in logs.
* The queue uses the existing schema. No migration exists or was run.
* Existing behaviour is intact: Phase 15 job tests pass; auth, proxy, payment and issuance are untouched.

**Conditions the owner should acknowledge (not Phase 1 blockers):**
1. **D1** — `notification.notificationType` was mapped back into the Prisma model to match the live `NOT NULL` column. This is a schema-file-only change; a future migration should retire the column.
2. **D2** — per-delivery lease uses `nextRetryAt`; the audit's proposed lock columns were not added because creating a migration file would break the test-database migration guard while applying it is forbidden.

**Blockers for activation (Phase 2+ only):**
* C1 — nodemailer advisory path and SMTP activation decision.
* C4 — Baileys risk acceptance vs WhatsApp Cloud API.
* Real business templates and the settlement → enqueue wiring (Phase 2).

**STOP.** No Phase 2 work started. Awaiting owner review.
