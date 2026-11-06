# PHASE 2 — POST-ISSUANCE TICKET NOTIFICATION IMPLEMENTATION REPORT

**Repository:** `/home/reksa/tinggalklik`
**Branch:** `main`
**HEAD:** `25cbf0c6893f79292be4580a056003c54753ff12` (`25cbf0c fix landing paaage`)
**Date:** 6 November 2026
**Scope:** Local implementation + isolated tests only. Dry run only. No commit, push, deploy, migration, or provider activation.
**Roadmap:** LOCKED — Phase 3 was not started.

> **Post-implementation correction (6 November 2026):** D-46 was subsequently approved as
> Option A (`code_link`); see `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md`. The
> statements below that describe D-46 as unresolved record the implementation-time state and
> are superseded. The original §14 inventory also omitted `lib/app-origin.ts`; the ticket
> helper requires the added `getConfiguredAppOrigin()`, and the file was included in baseline
> commit `dd6d32d`.

---

## 1. Executive Summary

The post-issuance ticket notification feature is implemented, integrated at exactly one
post-commit point in `issueTicketsForOrder()`, protected by independent email/WhatsApp
idempotency keys, and recoverable through a manual bounded enqueue-only sweep.

The feature was already present as uncommitted work in the working tree when this session
began. This session:

1. Re-audited the repository, branch, HEAD, working tree, and the approved Phase 2 documents.
2. Verified the actual source and tests against the owner decisions (not old line numbers).
3. Found and fixed one real TypeScript defect in the new worker test (untyped `jest.fn`
   mocks caused `TS2352`/`TS2493`); no production code was changed for this.
4. Ran the complete required validation set against the isolated test schema.
5. Produced this report.

No migration, schema, transport, provider, route, issuance-semantics, check-in, D-46, or
purchase-proof behavior was changed. `NOTIFICATIONS_ENABLED` is not set in the local `.env`
(resolves to OFF) and is `"false"` in `.env.example`. `PHASE_1_DRY_RUN_ONLY` remains `true`.

**Final verdict: PASS.**

---

## 2. Final Verdict

**PASS** — every acceptance criterion in section 12 of the directive is satisfied:

| # | Criterion | Evidence |
|---|---|---|
| 1 | Notification only after issuance commit | `issuance.ts` call at line 644, inside `created.length > 0`, after the transaction resolved; commit-visibility test passes |
| 2 | Duplicate issuance creates no duplicate | `ALREADY_ISSUED` path never enters the branch; test confirms identical notification row IDs |
| 3 | Independent per-channel keys | `ticket-issued:{orderNumber}:email:v1` / `:whatsapp:v1`; partial-repair tests pass |
| 4 | Sweep repairs a missing channel | Email-present/WhatsApp-missing and inverse both repaired |
| 5 | `endAt + 30 minutes` applied | Window helper + query predicate; boundary test passes (inclusive) |
| 6 | 120 s grace + bounded limit | `minAgeMs = 120_000`, `limit` 1–100, default 20, oldest first |
| 7 | Sweep enqueues only | No worker/transport/send call in helper or CLI; static guard |
| 8 | Max 20 ticket codes | `MAX_TICKETS = 20`; 25-ticket test prints 20 + wallet note |
| 9 | Wallet link authenticated/ownership-scoped | Existing `/ticketing/tickets` page, origin from `getConfiguredAppOrigin()` only |
| 10 | No QR image created or claimed | Template prints codes + link only; no attachment/media code |
| 11 | No `qrTokenHash` / raw scanner token | Never selected, never in payload/template/log; static guards |
| 12 | No new ticket-code exposure via logs | Structured-log guard test over every log block |
| 13 | D-46 and check-in unchanged | No diff in check-in/validation modules; static guard |
| 14 | Legacy `category IS NULL` untouched | Claim query excludes it; sweep filters by template key |
| 15 | Purchase proof unchanged | Settlement hook untouched by this phase; independence test passes |
| 16 | SMTP/Baileys inactive | Clamped to dry-run; adapters throw on construction |
| 17 | `NOTIFICATIONS_ENABLED=false` | Absent in `.env` (fail-closed OFF), `"false"` in `.env.example` |
| 18 | Dry run never produces `SENT` | Worker test asserts `SKIPPED` / `DRY_RUN_SIMULATED` |
| 19 | No schema/migration change | `prisma validate` passes, `migrate status` up to date, no new migration directory |
| 20 | All required validation passes | See section 12 |
| 21 | No roadmap change | No roadmap file touched |
| 22 | No commit/push/deploy | `git status` unchanged at HEAD; no commit created |

---

## 3. Owner Decisions Applied

| Item | Decision | Implementation |
|---|---|---|
| B1 — QR delivery | `code_link` only | Template prints public `EVT-XXXX-XXXX` codes + authenticated wallet URL |
| B2/B3 — code exposure | Dry-run only; real send awaits D-46 | Queue rows only; worker is dry-run; no provider |
| Recovery window | Up to `endAt + 30 minutes` | `TICKET_NOTIFICATION_WINDOW_MS = 30 * 60_000`, shared by hook and sweep |
| Scope | No migration, provider, real send, Phase 3 | Confirmed |
| Notification unit | One notification per order per channel | One `Notification` row per channel, `ticketId: null` |
| Ticket-code limit | Max 20 codes; wallet for the rest | `MAX_TICKETS = 20`, factual wallet note, no omitted-count claim |
| Recovery execution | Manual, bounded, enqueue-only | `npm run sweep:ticket-issued -- --limit N`; no cron |
| Provider state | SMTP and Baileys inactive | `PHASE_1_DRY_RUN_ONLY = true`; adapters throw |
| Feature flag | `NOTIFICATIONS_ENABLED=false` | `.env.example` false; unset locally → false |

---

## 4. Implementation Overview

```text
issueTicketsForOrder()
  → Prisma $transaction (unchanged)
      create missing ticket slots
      verify complete count
  → COMMIT (dispatched.ok)
  → if (created.length > 0)
      publishTicketIssued()        (existing)
      writeTicketingAudit()        (existing)
      enqueueTicketIssued(order.id)  ← NEW, post-commit, non-throwing
  → return unchanged result
```

`enqueueTicketIssued()`:

1. Loads a minimum projection of the order (event, venue, ISSUED tickets, buyer contact).
2. Refuses non-PAID orders, CANCELLED/ARCHIVED events, missing/closed windows, and orders
   with zero valid ISSUED codes.
3. Builds a pure payload snapshot (`buildTicketIssuedPayload`).
4. Resolves the wallet URL from the trusted configured origin only.
5. Enqueues EMAIL and WHATSAPP sequentially through the existing `enqueueNotification()`.

Nothing in the flow sends. The worker remains the only component that could send, and it is
clamped to dry run.

---

## 5. Issuance Post-Commit Integration

**File:** `lib/ticketing/tickets/issuance.ts`

- Import added: `import { enqueueTicketIssued } from "@/lib/notifications/ticket-issued";`
- One call added at line 644, inside the existing `if (created.length > 0)` block, after the
  realtime publish and the ticketing audit write.
- The enclosing transaction has already resolved at `const { created, tickets } =
  dispatched.value;` (line 596); the call is not inside `$transaction`.
- The transaction body, locking, retry loop, ticket creation, count invariant, unique-slot
  behavior, audit/realtime operations, and the returned object are unchanged.
- The helper is non-throwing by contract and additionally returns a `skipped`/`failed`
  result instead of raising; a queue failure cannot fail a committed issuance or change the
  issue route's status code.
- `created.length === 0` (`ALREADY_ISSUED`) never calls the helper.

Proof of post-commit execution: the hook test spies on the helper, then inside the spy reads
`ticket.count` and `eventOrder.status` through a separate Prisma query and observes
`{ tickets: 2, orderStatus: "PAID" }`. It also asserts the spy is called exactly once across
an `ISSUED` + `ALREADY_ISSUED` sequence.

---

## 6. Notification Idempotency

Keys are built by `ticketIssuedIdempotencyKey(orderNumber, channel)`:

```text
ticket-issued:{orderNumber}:email:v1
ticket-issued:{orderNumber}:whatsapp:v1
```

- `Notification.idempotencyKey @unique` converges a replay on the existing notification.
- `UNIQUE(notificationId, channel)` converges the delivery fan-out.
- `enqueueNotification()` reuses an existing notification and repairs a missing delivery row
  for that channel.
- Metadata: `category = TICKET`, `recipientType = CUSTOMER`, `templateKey =
  ticket-issued.v1`, `eventOrderId`, `userId`, `eventId`, `organizerId`, `ticketId = null`.
- `priority = 20`, `maxAttempts = 3` (order-level business notification, behind the proof's 10).

No schema addition was needed: the existing queue's unique key *is* the outbox.

---

## 7. Email/WhatsApp Channel Independence

- Two separate `enqueueNotification()` calls, one per channel, sequential.
- One channel's exception is caught inside `enqueueOneChannel()` and reported as `failed`;
  the other channel still runs.
- An order with email present and WhatsApp missing is still selected by the sweep because the
  candidate query uses two independent `notifications.none` clauses (one per channel), not a
  single combined clause.
- Tests cover: first enqueue, replay, email-only → WhatsApp repaired, WhatsApp-only → email
  repaired, and coexistence with the purchase proof (`ORDER` / `purchase-proof.v1`).
- The sweep idempotently re-calls the same helper, so an existing channel is returned as
  `existing` and is not duplicated.

---

## 8. Ticket Template and Wallet Link

**File:** `lib/notifications/ticket-issued-template.ts`
**Registered in:** `lib/notifications/templates.ts` as the only new key, `ticket-issued.v1`.

- One renderer serves email and WhatsApp; same body, same facts.
- Indonesian, professional, plain text. Sections: opening, transaction number, event, schedule,
  optional venue/address/city, ticket count, numbered codes, wallet link, entry instruction,
  privacy warning, optional store contact.
- No invented arrival time, dress code, age limit, entry window, event rules, or terms.
  `Event.rules` is not used.
- Wallet URL: `${configuredOrigin}/ticketing/tickets`, using `getConfiguredAppOrigin()` from
  `lib/app-origin.ts`. No request header is read; no absolute URL is built from `Host`.
  When no trusted origin is configured, the template prints a factual "open Tiket Saya"
  instruction instead of a URL.
- The page is the existing authenticated, ownership-scoped wallet. No public route was added.
- QR payload `TICKET:<ticketCode>` is untouched; the template never prints it.
- Privacy sentence matches the wallet UI: “E-tiket ini bersifat pribadi. Jangan bagikan
  tangkapan layarnya.”
- No claim of revocable/rotatable codes, because no reissue/rotation mechanism exists.

---

## 9. Ticket-Code Security

- Selection is `tickets: { where: { status: "ISSUED" }, select: { ticketCode: true } }` with
  deterministic ordering `(orderItemId asc, sequenceNo asc)`.
- `qrTokenHash` is never selected; the raw scanner token is not generated or read.
- Codes are re-filtered at render time by the existing `isTicketCode()` allow-list; malformed,
  duplicate, `VOID`, `REFUNDED`, and `CHECKED_IN` rows are never printed.
- Over 20 codes: the first 20 valid codes are printed, followed by a factual note that all
  tickets are available in the wallet. No "N omitted" number, no truncated pseudo-code.
- Payload contains no internal database IDs, no `qrTokenHash`, no scanner token, no payment
  credentials, no payment URL.
- Structured logs contain order number, channel, outcome, error code, and sanitized message
  only — never a ticket code, recipient, payload, or body.
- Static guards assert all of the above, including the absence of `qrcode`, `TICKET:`,
  `attachments:`, and public QR routes.

---

## 10. Recovery Sweep and `endAt + 30 minutes`

**Helper:** `sweepMissingTicketNotifications(options)` in `lib/notifications/ticket-issued.ts`
**CLI:** `scripts/ticket-issued-sweep.ts`, exposed as `npm run sweep:ticket-issued`

Candidate predicate:

- `EventOrder.status = PAID`
- `EventOrder.paymentStatus = PAID`
- `paidAt IS NOT NULL AND paidAt <= now - 120_000 ms`
- at least one `Ticket.status = ISSUED`
- `Event.status NOT IN (CANCELLED, ARCHIVED)`
- `Event.endAt IS NOT NULL AND Event.endAt >= now - 30 minutes`
- at least one channel has no `ticket-issued.v1` notification

Bounds: `limit` default 20, clamped 1–100; `minAgeMs` default 120 000; oldest first by
`paidAt`. The helper re-checks window and eligibility, so a candidate selected by a slightly
stale query is still refused safely. `endAt = null` is excluded by the query and refused by
the helper with `END_AT_UNKNOWN`.

Boundary semantics: `now <= endAt + 30 minutes` is eligible (inclusive). The test
"exactly endAt + 30 minutes is inside the approved boundary" passes.

Execution: enqueue-only. It does not claim a delivery, does not run the worker, and does not
send. Safe to run repeatedly. Errors are isolated per order; the result reports
`scanned / eligible / emailCreated / whatsappCreated / skipped / failed` with no ticket code
or recipient in the log.

---

## 11. Dry-Run Verification

| Control | State |
|---|---|
| `NOTIFICATIONS_ENABLED` in `.env` | Not present → `readFlag` returns **false** (kill switch OFF) |
| `.env.example` | `NOTIFICATIONS_ENABLED="false"` |
| `PHASE_1_DRY_RUN_ONLY` | `true` (compile-time constant) |
| Requested `smtp` / `baileys` | Recorded as refusal, downgraded to `dry-run` |
| `transports/smtp.ts` | Constructor throws `Phase1TransportRefusedError` |
| `transports/baileys.ts` | Constructor throws `Phase1WhatsAppRefusedError` |
| Value imports of `nodemailer` / Baileys | None in `lib/notifications` or scripts (only comments) |
| Worker outcome | Tests assert `SKIPPED` + `DRY_RUN_SIMULATED`, `providerMessageId = null` |
| `SENT` rows from dry run | Zero asserted |
| Local `.env` modified | No |

No SMTP connection, WhatsApp pairing, session, socket, or message transmission was performed.

---

## 12. Test Results

All database tests ran against the isolated schema `tinggalklik_test`, verified read-only
first.

### 12.1 Environment verification

```bash
npm run test:db:setup
# Verified isolated test schema 'tinggalklik_test'. No data was changed.
# exit 0
```

### 12.2 Focused static / unit tests

```bash
npx jest __tests__/notifications/ticket-issued-template.test.ts \
         __tests__/notifications/ticket-issued-wiring.test.ts \
         __tests__/notifications/purchase-proof-wiring.test.ts
# Test Suites: 3 passed, 3 total
# Tests:       36 passed, 36 total
# exit 0
```

### 12.3 Focused database tests

```bash
npx jest __tests__/notifications/ticket-issued-worker.test.ts \
         __tests__/notifications/ticket-issued.integration.test.ts \
         __tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts
# Test Suites: 3 passed, 3 total
# Tests:       32 passed, 32 total
# exit 0
```

Coverage highlights:

- Issuance: valid issuance, multiple tickets → one notification per channel, duplicate
  `ALREADY_ISSUED`, partial existing ticket slots, queue failure does not fail issuance,
  ineligible/unpaid order, concurrent issuance (1 `ISSUED` + 4 `ALREADY_ISSUED`, 3 tickets,
  2 notifications), and post-commit visibility.
- Notification: first enqueue, replay, both partial-channel repairs, purchase-proof
  independence, invalid email/phone skip, missing contact skip, >20 codes, invalid codes,
  `VOID`/`REFUNDED`/`CHECKED_IN` exclusion.
- Sweep: eligible + repeatable, younger than 120 s skipped, >30 min after end skipped, exact
  boundary eligible, `CANCELLED`/`ARCHIVED` skipped, no ISSUED tickets skipped, partial
  repair, legacy `category NULL` untouched, batch limit bound, one order's failure isolated.
- Worker: TICKET row simulated (never SENT), invalid recipient terminal skip, legacy
  `category NULL` never claimed, WhatsApp cap defers, no ticket code/recipient/body logged.

### 12.4 Full Jest suite

```bash
npm test
# Test Suites: 172 passed, 172 total
# Tests:       3628 passed, 3628 total
# Snapshots:   2 passed, 2 total
# Time:        235.96 s
# exit 0
```

### 12.5 TypeScript

First run **failed** with four errors introduced by the new worker test — the transport
mocks were declared `jest.fn(async () => …)` with no parameters, so `mock.calls[0][0]` was
typed as `undefined`:

```text
__tests__/notifications/ticket-issued-worker.test.ts(144,30): error TS2352
__tests__/notifications/ticket-issued-worker.test.ts(144,54): error TS2493
__tests__/notifications/ticket-issued-worker.test.ts(149,33): error TS2352
__tests__/notifications/ticket-issued-worker.test.ts(149,60): error TS2493
```

Fix: the mocks now declare the real `OutboundEmail`/`OutboundWhatsApp` + `TransportContext`
signature. No production code was involved. Rerun:

```bash
npx tsc --noEmit
# exit 0
```

### 12.6 ESLint

```bash
npm run lint
# ✖ 4 problems (0 errors, 4 warnings)
# exit 0
```

The four warnings are pre-existing and unrelated (`scripts/verify-phase33-live.js` unused
variable and similar); no new warning or error comes from the Phase 2 files.

### 12.7 Prisma validation and migration status (read-only)

```bash
npx prisma validate
# The schema at prisma/schema.prisma is valid 🚀
# exit 0

npx prisma migrate status
# 32 migrations found in prisma/migrations
# Database schema is up to date!
# exit 0
```

No migration was created, edited, or applied.

### 12.8 Production build

```bash
npm run build
# exit 0
```

### 12.9 Diff hygiene

```bash
git diff --check
# exit 0 (no whitespace errors)
```

---

## 13. Database and Migration Safety

- No migration directory exists for this feature; `prisma/migrations` is unchanged.
- No `prisma migrate`, `db push`, seed, or reset command was run.
- `npm run test:db:setup` is read-only by design: it verifies `_prisma_migrations` and the
  applied-migration count.
- Fixture cleanup happened through the existing isolated-test teardown; the application
  database was never targeted by Jest (the guard fails closed without an explicit
  `TEST_DATABASE_URL` on the same host ending in `_test`).
- Post-run read-only inspection of the test schema for `templateKey = 'ticket-issued.v1'`
  returned no rows, confirming test cleanup left no queue artifacts.
- The working tree contains a **pre-existing** `prisma/schema.prisma` modification from
  Phase 1 (mapping the legacy `notificationType` column with a client-side default). It adds
  no DDL, is not part of this phase, and was not modified in this session. Phase 2 introduced
  no schema change.

---

## 14. Files Changed

### Present in the working tree at session start (uncommitted Phase 2 work, verified here)

| File | Change |
|---|---|
| `lib/notifications/ticket-issued.ts` | New: enqueue helper, payload, window, sweep |
| `lib/notifications/ticket-issued-template.ts` | New: `ticket-issued.v1` renderer |
| `lib/notifications/templates.ts` | Modified: register `ticket-issued.v1` |
| `lib/ticketing/tickets/issuance.ts` | Modified: one import + one post-commit call |
| `lib/app-origin.ts` | Modified: adds `getConfiguredAppOrigin()`; required by the ticket helper. **Omitted from the original inventory; corrected here** |
| `scripts/ticket-issued-sweep.ts` | New: manual bounded sweep CLI |
| `package.json` | Modified: `sweep:ticket-issued` script |
| `__tests__/notifications/ticket-issued-template.test.ts` | New |
| `__tests__/notifications/ticket-issued-wiring.test.ts` | New static guards |
| `__tests__/notifications/ticket-issued-worker.test.ts` | New |
| `__tests__/notifications/ticket-issued.integration.test.ts` | New |
| `__tests__/notifications/purchase-proof-wiring.test.ts` | Modified: guard narrowed to allow only the approved helper |
| `__tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts` | New |

### Changed in this session

| File | Change |
|---|---|
| `__tests__/notifications/ticket-issued-worker.test.ts` | Typed transport mocks; fixes `TS2352`/`TS2493`. No assertion weakened. |
| `docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_IMPLEMENTATION_REPORT.md` | This report (new) |

No audit report was modified. No new configuration, environment, migration, or schema file
was created.

---

## 15. Static Guard Results

`__tests__/notifications/purchase-proof-wiring.test.ts` (Phase 2 guards, narrowed):

- Issuance imports only `@/lib/notifications/ticket-issued`, calls it once, and the call is
  after the `created.length > 0` branch.
- Issuance imports no worker, transports, Nodemailer, Baileys, and does not touch
  `prisma.notification`.
- Webhook, webhook route, checkout route, issue route, settlement, and purchase-proof do not
  import `ticket-issued`.
- Proof service and template import no provider SDK; adapters still throw.
- No scanner secret or payment URL in the proof snapshot.
- Kill switch OFF in `.env.example`; no Phase 2 migration or lock column; no public proof route.

`__tests__/notifications/ticket-issued-wiring.test.ts` (new):

- Exactly one helper import and one call, inside the post-commit created-rows branch, after
  `writeTicketingAudit`.
- Helper uses the trusted configured origin, never `next/headers` or request headers.
- Helper selects public codes only, never `qrTokenHash`, and contains no send, provider,
  worker, claim, or attachment path.
- Structured-log blocks contain no `ticketCode`, `recipient`, `payload`, `body`, or `text`.
- Exact key format, `category: "TICKET"`, `templateKey`, and `ticketId: null`.
- 30-minute window, 120-second grace, 20/100 bounds, PAID predicates, ISSUED-ticket predicate,
  CANCELLED/ARCHIVED exclusion.
- Template registered, no image/attachment/`TICKET:` payload, 20-code cap.
- Sweep calls the bounded helper and no sender; npm script is manual.
- No `ticket-issued`/QR route directory, no migration directory.
- Check-in service and wallet route not wired to the feature.
- Kill switch and dry-run transports configured off.

All 36 static/unit tests pass.

---

## 16. Known Limitations

1. **No real delivery is proven.** SMTP and Baileys are inactive; the worker records
   `SKIPPED / DRY_RUN_SIMULATED`. Deliverability, rendering by real clients, and provider
   behavior are untested by design.
2. **Recovery is manual.** There is no cron or scheduler. An enqueue lost after the 30-minute
   window is not recoverable by this sweep, per the owner's window decision.
3. **`endAt = null` produces no ticket notification.** Both the issuance hook and the sweep
   refuse it (`END_AT_UNKNOWN`) because the approved window cannot be computed safely. Such
   events currently get no post-issuance message.
4. **The window also gates the issuance hook**, not only recovery. A legitimate issuance that
   happens more than 30 minutes after the event ended enqueues nothing. This is a deliberate
   reuse of one policy but is worth an owner decision (see section 20).
5. **No outbox table.** Recovery inference relies on "no notification row for this template
   and channel", which is sufficient for the unique-key design but is not a transactional
   outbox.
6. **Codes cannot be rotated or revoked** in the message; the template therefore makes no such
   claim. Reissue is out of scope.
7. **An invalid but non-empty contact is stored raw on the queue row** and terminally skipped
   by the worker, matching the Phase 2 purchase-proof pattern. It creates one durable
   terminal row per channel rather than silently dropping the channel.
8. **Ticket notification metadata sets `ticketId: null`** because it is order-level; this is
   intentional and matches the owner's "one notification per order per channel" unit.

---

## 17. Residual Risks

- **Provider activation remains unproven.** Turning on SMTP/Baileys later requires a separate
  decision, credential handling, and a delivery test.
- **D-46 is unresolved.** Ticket codes are visible in the message body by owner approval
  (`code_link`); if D-46 changes the exposure policy, the template must be revisited.
- **A late-but-valid issuance can be silent** for events more than 30 minutes past `endAt`
  (limitation 4).
- **Club/very-short-window events** have a recovery window shortened by the 120-second grace
  plus the 30-minute tail; an operator may need to run the sweep promptly.
- **Manual sweep depends on an operator.** Without a scheduler, missed enqueues rely on
  someone running `npm run sweep:ticket-issued`.
- **Test-suite interference** is managed by `maxWorkers: 1`; a future parallelism change
  would need per-worker databases.

---

## 18. Explicitly Not Implemented

- QR image generation, attachments, media transport, or any claim that a QR image was sent.
- ASCII QR rendering or a public QR/ticket endpoint.
- Real SMTP/Nodemailer initialization, connection, authentication, or send.
- Baileys pairing, session creation, socket, or send.
- Provider activation, credentials, or `.env` changes.
- Database migration, schema DDL, enum/index change, outbox table.
- Cron, background scheduler, or automated sweep.
- Changes to issuance eligibility, timing, transaction boundary, locking, retries, or return
  values; checkout, webhook, settlement, purchase-proof, check-in, scanner, wallet
  authentication, or D-46.
- Ticket-code reissue/rotation.
- Phase 3 work or roadmap changes.
- Any commit, push, deploy, reset, rebase, or stash.

---

## 19. Phase 2 Completion Assessment

Feature complete **within the approved dry-run scope**. The implementation preserves issuance
integrity, keeps the queue as the only delivery path, converges every replay on the same
per-channel keys, limits ticket-code exposure to 20 public codes plus an authenticated wallet
link, and remains fully recoverable through a manual bounded enqueue-only sweep.

Purchase proof behavior is unchanged and remains independent. No safety boundary was crossed.

Phase 2 is not "live": real delivery, D-46, and provider activation are still open owner
decisions. Phase 3 was not started and must not be inferred as the next automatic step.

---

## 20. Recommended Next Owner Decision

1. **D-46 disposition** — confirm the final ticket-code exposure policy for real messages. The
   current implementation assumes owner approval of `code_link` (codes + authenticated wallet
   link) for dry-run only.
2. **Provider activation** — decide whether/when SMTP and Baileys may leave dry run, including
   credential custody, sending identity, and a controlled delivery test.
3. **Recovery operations** — decide whether `sweep:ticket-issued` should remain operator-run or
   be attached to an existing approved scheduler, and what the 30-minute window should be for
   events with no `endAt`.
4. **Late-issuance policy** — decide whether a valid issuance after `endAt + 30 minutes` should
   still notify (currently it does not).
5. Only after these decisions should Phase 3 planning begin.

**STOP — Phase 2 only. No commit was created; HEAD remains
`25cbf0c6893f79292be4580a056003c54753ff12`.**
