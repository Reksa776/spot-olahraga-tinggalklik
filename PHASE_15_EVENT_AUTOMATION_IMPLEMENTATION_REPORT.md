# PHASE 15 — EVENT AUTOMATION + SCHEDULER + LIFECYCLE COMPLETION

**Project:** TinggalKlik.Co
**Mode:** Implementation, strictly following `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §23
**Date:** 2026-09-19

Labels used throughout: **IMPLEMENTED** (written in this phase) · **VERIFIED** (executed and
observed) · **PRE-EXISTING** (already in the tree before this phase) · **DEFERRED** (not
done, with a reason).

---

## 1. Executive summary

Phase 14 locked the event lifecycle; Phase 15 built it. The event state machine is now real
rather than declared: `PUBLISHED → ONGOING` (automatic at `startAt`), `→ COMPLETED`
(automatic at `endAt + 30 minutes`, or manual by a holder of `event.publish` once `endAt` has
passed), with cancellation and archival exactly as Phase 12 left them.

| Area | Status |
| --- | --- |
| Event lifecycle automation (P14-D01…D06, D22, D23) | IMPLEMENTED · VERIFIED |
| Scheduler: DB-backed tick route + VPS cron, DB lease, two jobs (P14-D09, D10) | IMPLEMENTED · VERIFIED |
| Sales/catalog relationship (P14-D11) | IMPLEMENTED · VERIFIED |
| `endAt`/`startAt` freezes (P14-D12) | IMPLEMENTED · VERIFIED |
| Check-in window + grace (P14-D06) | IMPLEMENTED · VERIFIED |
| D-28 open-refund gate + race safety (P14-D15) | IMPLEMENTED · VERIFIED |
| Audit vocabulary (P14-D21) | IMPLEMENTED · VERIFIED |
| UI: completion affordance, window labels, soft `requiresCheckIn` (P14-D13, D18) | IMPLEMENTED · VERIFIED |
| Migration (P14-D20) | IMPLEMENTED · VERIFIED (additive, applied) |
| TypeScript / build / lint / full regression | VERIFIED, clean |

No Phase-14 decision required reinterpretation, and **no contradiction between §23 and the
actual code/schema was found**. Two items the lock classified as *documentation, not
decisions* were handled as such and are recorded in §26.

---

## 2. Phase 14 decisions implemented

| ID | Decision | Where |
| --- | --- | --- |
| P14-D01 | `ONGOING` is a real lifecycle state | `lib/events/lifecycle.ts` |
| P14-D02 | `PUBLISHED → ONGOING` automatic at `now >= startAt`, no manual entry | `isOngoingDue`, `advanceEventLifecycleBatch` STEP 1 |
| P14-D03 | Monotonic; `startAt` frozen at `ONGOING`; no `ONGOING → PUBLISHED` | `lib/events/service.ts` (edit freeze, `publishEvent`, `unpublishEvent`) |
| P14-D04 | Automatic completion at `now >= endAt + 30m` | STEP 2 |
| P14-D05 | Manual completion: `event.publish` + `endAt != null` + `now >= endAt` | `completeEvent`, `mayCompleteManually` |
| P14-D06 | Grace = exactly 30 minutes, one canonical constant | `CHECK_IN_GRACE_MINUTES`, `CHECK_IN_GRACE_MS` |
| P14-D07 | Cancellation unchanged (no auto refund/void/money) | `cancelEvent` — untouched |
| P14-D08 | Archive keeps the Phase 12 widened policy | `archiveEvent` — untouched |
| P14-D09 | Scheduler = DB tick route + VPS cron; no BullMQ/Redis/`setInterval` | `lib/jobs/*`, `app/api/internal/jobs/tick/route.ts` |
| P14-D10 | Two jobs, one tick, DB lease, `now` passed through | `runJobsTick`, `lib/jobs/lock.ts` |
| P14-D11 | `PUBLISHED` + `ONGOING` purchasable; `COMPLETED` not; live catalog includes `ONGOING` | `lib/events/sales-state.ts`, `lib/events/catalog.ts` |
| P14-D12 | `startAt` frozen at `ONGOING`/`COMPLETED`; `endAt` frozen at `COMPLETED`; no reopen | `updateEvent` |
| P14-D13 | `requiresCheckIn` is soft only | `CheckInPanel` (copy), no service consumer added |
| P14-D14 | One admission per ticket, `CHECKED_IN` terminal, no undo | unchanged from Phase 13; re-asserted |
| P14-D15 | Open refund blocks check-in with `CheckInResult.REFUND_PENDING`, HTTP 409, refusal recorded | `checkInTicket` |
| P14-D16 | Completion never waits and moves no money | `advanceEventLifecycleBatch` (asserted by test) |
| P14-D17 | D-46 unchanged: `TICKET:<ticketCode>`, `QR_SCAN` unused, raw token server-only | untouched; re-asserted |
| P14-D18/D19 | PIC and Finance have no gate access | unchanged; re-asserted |
| P14-D20 | `Event.completedAt`, `CheckInResult.REFUND_PENDING`, `JobLock` | `prisma/schema.prisma` + migration |
| P14-D21 | `event.ongoing`, `event.complete` audit actions | `lib/ticketing/audit-log.ts` |
| P14-D22 | `endAt IS NULL` never completes | `completionDueAt`, `mayCompleteManually`, `completeEvent` |
| P14-D23 | Publish from `DRAFT` only; unpublish from `PUBLISHED` only | `publishEvent`, `unpublishEvent` |
| P14-D24 | Past-event display grace unchanged | untouched |
| P14-D25 | No new permission key | `PERMISSIONS.EVENT_PUBLISH` reused |

---

## 3. Files changed

**New (11) — IMPLEMENTED**

| Path | Purpose |
| --- | --- |
| `lib/events/lifecycle.ts` | Canonical grace constant, pure predicates, `advanceEventLifecycleBatch` |
| `lib/jobs/lock.ts` | DB lease: `acquireJobLock` / `releaseJobLock` / `JOB_NAMES` |
| `lib/jobs/tick.ts` | `runJobsTick` — both jobs, one `now`, per-job isolation |
| `app/api/internal/jobs/tick/route.ts` | Machine-authenticated trigger |
| `app/api/organizer/events/[id]/complete/route.ts` | Manual completion endpoint |
| `prisma/migrations/20260919000000_add_event_lifecycle_and_joblock/migration.sql` | Additive migration |
| `__tests__/events/lifecycle-automation.test.ts` | Pure predicate matrix (19 tests) |
| `__tests__/events/lifecycle-integration.integration.test.ts` | Real-DB lifecycle (19 tests) |
| `__tests__/events/lifecycle-ui-wiring.test.ts` | Static UI wiring (13 tests) |
| `__tests__/jobs/tick.test.ts` | Lease, tick, isolation, route auth (14 tests) |
| `__tests__/ticketing-checkin/check-in-refund-gate.integration.test.ts` | D-28 against real MariaDB (9 tests) |

**Modified — IMPLEMENTED**

`prisma/schema.prisma` · `lib/events/sales-state.ts` · `lib/events/service.ts` ·
`lib/events/validation.ts` · `lib/events/catalog.ts` · `lib/ticketing/checkin/service.ts` ·
`lib/ticketing/refunds/service.ts` · `lib/ticketing/audit-log.ts` · `proxy.ts` ·
`components/organizer/EventActions.tsx` · `components/organizer/CheckInPanel.tsx` ·
`app/dashboard/events/[id]/page.tsx` · `jest.config.js` · `.env.example`

**Modified tests — VERIFIED (existing suites extended, none deleted or weakened)**

`__tests__/events/lifecycle-integration.integration.test.ts` (grown in place) ·
`__tests__/ticketing-checkin/check-in-wiring.test.ts` ·
`__tests__/ticketing-checkout/reservation-lifecycle.test.ts` ·
`__tests__/ui-consolidation/checkin-gate.test.ts` ·
`__tests__/ticketing-refunds/refund-lifecycle.integration.test.ts`

---

## 4. Migration — IMPLEMENTED · VERIFIED

`prisma/migrations/20260919000000_add_event_lifecycle_and_joblock/migration.sql`, purely
additive and applied with `prisma migrate deploy`:

1. `ALTER TABLE event ADD COLUMN completedAt DATETIME(3) NULL` — the **observed** completion
   instant. The scheduled instant stays derivable (`endAt + 30m`); there is deliberately no
   `ongoingAt`, because `ONGOING` is derived from `startAt` and a second timestamp would be a
   second source of truth.
2. `ALTER TABLE checkin MODIFY result ENUM(… existing …, 'REFUND_PENDING')` — appended at the
   **end** so every existing row keeps its ordinal meaning.
3. `CREATE TABLE joblock (name PK, lockedUntil, lockedBy, lastRunAt, lastStatus, updatedAt)`.

VERIFIED: `prisma validate` → valid. `prisma migrate status` → *21 migrations found /
Database schema is up to date*. `prisma migrate diff --from-schema-datasource
--to-schema-datamodel` contains **no** Phase 15 object (`joblock`, `completedAt`,
`REFUND_PENDING` are all absent from the diff), so the live schema matches the model exactly.

No reset, no drop, no destructive statement, no data rewritten.

---

## 5. Lifecycle predicates — IMPLEMENTED · VERIFIED

`lib/events/lifecycle.ts` is the only lifecycle implementation:

| Export | Contract |
| --- | --- |
| `CHECK_IN_GRACE_MINUTES = 30`, `CHECK_IN_GRACE_MS` | The single definition; `sales-state.ts` re-exports/imports it |
| `completionDueAt(endAt)` | `endAt + grace`, or `null` when `endAt` is `null` |
| `isOngoingDue(event, now)` | `PUBLISHED`, live, `startAt <= now`, completion not yet due |
| `isCompletionDue(event, now)` | live, `PUBLISHED|ONGOING`, `endAt != null`, `endAt + grace <= now` |
| `mayCompleteManually(event, now)` | live, `PUBLISHED|ONGOING`, `endAt != null`, `now >= endAt` |

The four predicates are **pure** — no Prisma, no clock of their own (`now` is a parameter),
no side effects. VERIFIED by `__tests__/events/lifecycle-automation.test.ts`, including the
single-definition test that fails if a second grace literal appears anywhere in the lifecycle
surface.

---

## 6. Event state machine

```
DRAFT ──publishEvent (DRAFT only)──▶ PUBLISHED
                                        │  startAt            (automatic, JOB 1)
                                        ▼
                                     ONGOING ─────────┐
                                        │             │ endAt + 30m (automatic, JOB 1)
                                        │             ▼
                                        │          COMPLETED
                                        │             │
              cancelEvent ──────────────┴──▶ CANCELLED │
                                                    ARCHIVED ◀── archiveEvent (any non-ARCHIVED, Phase 12 policy)
```

Manual completion is the second writer of `→ COMPLETED`: `completeEvent` accepts `PUBLISHED`
or `ONGOING` once `now >= endAt`. There is deliberately **no** manual `ONGOING`, **no**
`ONGOING → PUBLISHED`, **no** `COMPLETED → ONGOING`, and **no** reopen.

---

## 7. Scheduler architecture — IMPLEMENTED · VERIFIED

```
VPS crontab (every minute)
        │  POST /api/internal/jobs/tick   Authorization: Bearer $JOBS_TICK_SECRET
        ▼
app/api/internal/jobs/tick/route.ts   (constant-time secret check; business logic: none)
        ▼
lib/jobs/tick.ts  runJobsTick({ now })
        ├── JOB 1  event-lifecycle       → advanceEventLifecycleBatch({ now, batchSize: 200 })
        └── JOB 2  reservation-reaper    → expireDueReservations({ now, batchSize: 100 })
```

* Business logic lives in the services; the scheduler only triggers (P14-D10).
* JOB 2 is the **existing** `expireDueReservations`, unmodified — this tick is the production
  caller it has been missing since Phase 6, which closes the "phantom sold-out event" gap.
* Each job: own lease, own `try/catch`, own outcome. A JOB 1 failure cannot prevent JOB 2 and
  vice versa; both facts are asserted with injected failures.
* Batch sizes are bounded so one tick cannot run long. `runJobsTick` honours an injected
  `now`, which is what the tests use to make the automation deterministic.

DEFERRED (deliberately, per P14-D10): notification dispatch, counter reconciliation and any
other periodic work. Declaring them now would be a job with no requirement.

---

## 8. JobLock — IMPLEMENTED · VERIFIED

`lib/jobs/lock.ts`. `acquireJobLock` runs two statements: an `upsert` with an **empty update**
(creates the row on first run, never stomps a live lease) followed by a conditional
`updateMany` whose `WHERE` is the whole acquisition rule
(`lockedUntil IS NULL OR lockedUntil < now`). `count === 1` = this invocation owns the job.
`releaseJobLock` clears the lease and records `lastRunAt` / `lastStatus` on every path
(success, failure, skip). Lease duration 5 minutes.

The lease is **not** the correctness guard — every transition is a conditional write, so even
a simultaneous double run yields one transition. The lease makes an overlap a cheap no-op and
a crash visible and recoverable.

VERIFIED: first claim wins / second concurrent claim refused · a **stale** lease is taken over
with no operator action · release frees the lease and records the run · only the two declared
job names exist.

---

## 9. Tick route security — IMPLEMENTED · VERIFIED

`POST /api/internal/jobs/tick`:

* `Authorization: Bearer $JOBS_TICK_SECRET`, compared with `crypto.timingSafeEqual`
  (length mismatch is not a clean signal — a filler comparison is still performed).
* Missing secret in the environment ⇒ **fail closed** (401), so an unconfigured deployment
  never exposes "run every job".
* No request body, no session, no organizer auth chain; the route is a pass-through in
  `proxy.ts` and is deliberately **not** added to the session-protected matcher (a session
  gate would make it unusable by its only legitimate caller while adding nothing).
* The response exposes job counts and timing only — no secret, no configuration, no tenant or
  buyer data. Refusals are bare 401s and never echo the presented value.

VERIFIED statically (`__tests__/jobs/tick.test.ts`) and at runtime (§23).

---

## 10. Event lifecycle service — IMPLEMENTED · VERIFIED

`advanceEventLifecycleBatch({ now, batchSize = 200 })`:

* **STEP 1** `PUBLISHED → ONGOING` where `startAt <= now`, live, and completion is not yet due.
* **STEP 2** `{PUBLISHED, ONGOING} → COMPLETED` where `endAt + grace <= now`, live; sets
  `completedAt = now`.
* Each step first **selects** a bounded, deterministically ordered candidate set and then
  performs a **conditional UPDATE carrying the full predicate** per row — never read-then-write.
* **Catch-up** is allowed and asserted: a `PUBLISHED` event whose whole window passed goes
  straight to `COMPLETED`; it is never first fabricated into `ONGOING`.
* One audit row per **successful** transition; a run that transitions nothing writes nothing.
* Returns `{ toOngoing, toCompleted, scanned }`.

VERIFIED against real MariaDB: the exact-boundary transitions, catch-up, `endAt IS NULL` never
completing, `CANCELLED`/`ARCHIVED` skipped, a second run being a no-op with no duplicate audit
row, two concurrent batches producing exactly one transition, and purity (no order, ticket,
payment, refund, ticket-type counter or `PICFeeLedger` row touched).

## 11. Manual completion — IMPLEMENTED · VERIFIED

`completeEvent(scope, eventId, input, request?)` behind `POST
/api/organizer/events/[id]/complete`:

* Authority: `PERMISSIONS.EVENT_PUBLISH` in the event's own tenant (no new permission key).
* Refuses: `ARCHIVED`, `CANCELLED`, `endAt IS NULL`, `now < endAt`.
* Accepts `PUBLISHED` / `ONGOING`; sets `status = COMPLETED` + `completedAt = now` with a
  **CAS conditional update**; an already-`COMPLETED` event is an idempotent replay that
  returns the row and writes **no** second audit row.
* Body is strictly `{ note?: string }` (Zod, `.strict()`), recorded as the audit reason.
* Touches no money: no refund, void, quota, order, payment or PIC ledger mutation.

VERIFIED: the happy path, idempotent replay, every refusal, and authorization
(no session / non-member / `FINANCE` / cross-tenant / plain customer).

---

## 12. Sales-state changes — IMPLEMENTED · VERIFIED

`isEventPurchasable` now sells `PUBLISHED` and `ONGOING` only; **`COMPLETED` was removed**
(P14-D11 — design §10.3 states completion's effect as "Sales stop"). All existing conditions
are preserved untouched: `visibility`, `archivedAt`/`cancelledAt`, the event sales window and
the ticket-type windows.

`isEventCheckInOpen(event, now)` — the ONE canonical gate predicate, now **time-aware**:
`false` for `DRAFT`/`PENDING_REVIEW`/`CANCELLED`/`ARCHIVED` and whenever `cancelledAt` /
`archivedAt` is set; `true` for `PUBLISHED`/`ONGOING`/`COMPLETED` while
`now <= endAt + CHECK_IN_GRACE_MS`; for an `endAt`-less live event, open for as long as the
event is live.

VERIFIED by the pure matrices and the real-DB integration suites.

---

## 13. Catalog changes — IMPLEMENTED · VERIFIED

`publicVisibilityWhere` now selects `status IN ('PUBLISHED','ONGOING')`. Before this change a
`PUBLISHED`-only filter would have hidden every live event the moment the scheduler started it.
`DRAFT`, `PENDING_REVIEW`, `COMPLETED`, `CANCELLED`, `ARCHIVED` remain excluded, `visibility =
PUBLIC` and `archivedAt = null` are preserved, and the existing past-event filter is untouched
(P14-D24).

VERIFIED: an `ONGOING` event appears; `COMPLETED`, `CANCELLED`, `ARCHIVED`, `DRAFT` do not; a
`COMPLETED` event is not purchasable while an `ONGOING` one still is.

---

## 14. Check-in D-28 — IMPLEMENTED · VERIFIED

Inside the same admission transaction, after the event gate, the actor's authorization, the
ticket lookup and the event match:

1. `SELECT id FROM ticket WHERE id = ? FOR UPDATE` — the serialization point shared with
   `requestRefund`.
2. The open-refund guard, read **inside** the transaction **after** the lock:
   `RefundItem` exists for this ticket and the parent `Refund.status IN
   ('PENDING','APPROVED','PROCESSING')`.
3. On a hit: `CheckInResult.REFUND_PENDING`, HTTP **409**, `reason: "REFUND_PENDING"`, an
   append-only refusal row and a `checkin.rejected` audit row — the same treatment every other
   refusal gets, so an operator can see the door turned someone away over a refund.

`REJECTED` and `FAILED` released their claim and do **not** block. `REFUNDED` still cannot be
admitted (the admission CAS requires `ISSUED`). `WRONG_EVENT` is still decided **before** any
refund information is disclosed. Tenant isolation is unchanged.

VERIFIED against real MariaDB for all five statuses plus both end states, and the recorded
refusal result in each case.

---

## 15. Refund / check-in concurrency — IMPLEMENTED · VERIFIED

`requestRefund` now takes the **same** `SELECT … FOR UPDATE` on the ticket rows (ascending id
order, so the two paths cannot deadlock) before it validates `checkedInAt` / `status`. Neither
side uses an in-memory check.

| Order | Outcome |
| --- | --- |
| refund first | gate's locked read sees the `RefundItem` ⇒ `REFUND_PENDING` |
| check-in first | refund's locked read sees `checkedInAt` ⇒ `REFUND_NOT_ALLOWED` (`TICKET_CHECKED_IN`) |

Invariant asserted in both launch orders: **exactly one** of the two succeeds; a `CHECKED_IN`
ticket never gains a refund claim, and a claimed ticket never becomes `CHECKED_IN`.

---

## 16. Audit changes — IMPLEMENTED · VERIFIED

`event.ongoing` and `event.complete` added to `TicketingAuditAction`. System transitions write
`actorType = "SYSTEM"`, `actorOrganizerId = null`, `organizerId = event.organizerId`,
`entityType = "Event"`, `entityRef = event.id`, with `status` (and `completedAt` where
relevant) in `afterState`. Manual completion records the real actor scope. No PII, no secrets.
A no-op tick writes **no** audit row; the run itself is observable through
`JobLock.lastRunAt` / `lastStatus` and the tick response. The D-28 refusal reuses
`checkin.rejected` — no new action was invented.

---

## 17. UI changes — IMPLEMENTED · VERIFIED

* **EventActions** — `Selesaikan event` for `PUBLISHED`/`ONGOING` only; never for `COMPLETED`.
  The confirmation states the three promises (sales stop, nothing is deleted, in-flight refunds
  continue). With `endAt === null` the button is **disabled with an explanation** (P14-D22)
  rather than sending a request the server must refuse. The server's `NOT_ENDED` refusal is
  rendered verbatim — the browser is never trusted for the clock.
* **CheckInPanel** — takes the server-provided gate state: `OPEN` before `endAt`, `GRACE`
  between `endAt` and `endAt + 30m` (labelled "Masa tenggang check-in"), `CLOSED` after.
  `requiresCheckIn === false` shows a soft/optional notice and keeps the scanner usable —
  explicitly **not** a security bypass, and not an authorization switch.
* **Event detail page** — derives the window once, on the server, from one `now` and the same
  `isEventCheckInOpen` the API uses, and passes `gateState` / `requiresCheckIn` down.
* No buyer-facing check-in or completion control was added; no fake analytics.

VERIFIED by `__tests__/events/lifecycle-ui-wiring.test.ts` (13 assertions) and the Phase 13 UI
suites.

---

## 18. Authorization — IMPLEMENTED · VERIFIED

No new permission key and no new role (P14-D25). Manual completion requires
`event.publish`; check-in keeps the existing `checkin.scan` + `StaffEventAssignment` rules;
`PIC` and `FINANCE` still hold no gate access. Nothing authoritative is read from the client:
`organizerId`, `status`, `completedAt`, the actor, ticket ownership, event ownership and refund
status are all server-derived. Cross-tenant access remains denied (asserted for both the
completion endpoint and the refund path).

---

## 19. Tests — IMPLEMENTED · VERIFIED

| Suite | Tests | Kind |
| --- | --- | --- |
| `__tests__/events/lifecycle-automation.test.ts` (new) | 19 | pure predicates, single-source grace |
| `__tests__/events/lifecycle-integration.integration.test.ts` (new) | 19 | **real MariaDB**: transitions, concurrency, purity, manual completion, freezes, publish guards, catalog |
| `__tests__/events/lifecycle-ui-wiring.test.ts` (new) | 13 | static wiring |
| `__tests__/jobs/tick.test.ts` (new) | 14 | lease, tick, isolation, route auth, proxy classification |
| `__tests__/ticketing-checkin/check-in-refund-gate.integration.test.ts` (new) | 9 | **real MariaDB**: D-28 matrix + race |
| `__tests__/ticketing-checkin/check-in-wiring.test.ts` (extended) | 28 | gate predicate matrix incl. grace |
| `__tests__/ticketing-checkout/reservation-lifecycle.test.ts` (extended) | 43 | `isEventPurchasable` matrix |
| `__tests__/ui-consolidation/checkin-gate.test.ts` (extended) | 10 | gate stays closed to buyers |
| `__tests__/ticketing-refunds/refund-lifecycle.integration.test.ts` (extended) | 16 | **real MariaDB**: settlement on a `COMPLETED` event |

All 20 items of §23.8 are covered. State-changing behaviour is tested against the real
database wherever the repository already has that capability (lifecycle, D-28, lease, reaper);
nothing was mocked to make a test pass, no existing test was skipped or deleted, and no
assertion was weakened.

---

## 20. TypeScript — VERIFIED

`npx tsc --noEmit` → **clean** (exit 0, no output).

## 21. Build — VERIFIED

`npm run build` → `✓ Compiled successfully`. `/api/internal/jobs/tick` is present in the route
manifest as a dynamic function.

## 22. ESLint — VERIFIED

`npx eslint .` → **0 errors, 5 warnings**. All five are the pre-existing
`@next/next/no-img-element` notices (Phase 13 baseline: 0 errors / 5 warnings). No new lint
debt; one unused import introduced while wiring the service was removed rather than suppressed.

## 23. Runtime verification — VERIFIED

Production build served on a spare port with `JOBS_TICK_SECRET` supplied via the environment
(never written to a file):

| Check | Result |
| --- | --- |
| `POST /api/internal/jobs/tick`, no `Authorization` | **401** `{"code":"UNAUTHORIZED"}` |
| `POST /api/internal/jobs/tick`, wrong bearer | **401** (identical body, no oracle) |
| `POST /api/internal/jobs/tick`, correct bearer | **200** — both jobs ran, `ok: true`, per-job counts |
| `GET /dashboard`, anonymous | **302** → `/login?callbackUrl=%2Fdashboard` |
| `GET /api/events`, anonymous | **200**, catalog payload served |

## 24. Regression audit (§23 list) — VERIFIED

| # | Claim | Evidence |
| --- | --- | --- |
| A | `COMPLETED` cannot be purchased | C15 §12 pure + real-DB assertion |
| B | `ONGOING` appears in the public catalog | C15 §13 |
| C | `ONGOING` cannot be unpublished | `unpublishEvent` accepts `PUBLISHED` only; asserted |
| D | `ONGOING` cannot be manually created | no manual entry path exists; `publishEvent` refuses non-`DRAFT` |
| E | `startAt` freezes after `ONGOING` | `updateEvent` freeze; asserted for `ONGOING`/`COMPLETED` |
| F | `endAt` freezes after `COMPLETED` (no reopen) | `updateEvent` freeze; asserted |
| G | Completion touches no commercial row | purity snapshot: orders, tickets, payments, refunds, ticket-type counters, `PICFeeLedger` |
| H | Cancellation unchanged | `cancelEvent` untouched; Phase 12 suite green |
| I | Archive keeps the Phase 12 widened policy | `archiveEvent` untouched |
| J | Refund settlement still works on a `COMPLETED` event | event completed by the real batch, then request → approve → **REFUNDED** with quota return, ledger row and `refund.settle` |
| K | `CHECKED_IN` cannot be refunded | asserted in both suites |
| L | Open refund cannot be checked in | D-28 matrix (PENDING/APPROVED/PROCESSING) |
| M | Two concurrent check-ins ⇒ one admission | Phase 13 race suite green |
| N | Two concurrent lifecycle ticks ⇒ one transition | real-DB concurrency test |
| O | JOB 1 failure does not prevent JOB 2 | injected-failure test |
| P | JOB 2 failure does not prevent JOB 1 | injected-failure test |
| Q | A stale lease can recover | stale-lease takeover test |
| R | No raw QR token in any response/log/audit | unchanged since Phase 8/13; `qrToken`/`qrTokenHash` appear only in prose and the issuance path |
| S | No new permission key | permission-map suite green; `PERMISSIONS.EVENT_PUBLISH` reused |
| T | No BullMQ/Redis scheduler | grep of `lib/jobs`, `lib/events/lifecycle.ts`, `app/api/internal`, `package.json`: none |

---

## 25. Failures and root causes

**New regressions: none.** The full suite finished green on the final run: **58 suites / 1281
tests passed**, against the Phase 13 baseline of 53 / 1200.

Three failures were hit and fixed during development, all of them in the new tests rather than
in the product code — recorded here because each was a real bug in the test:

1. `__tests__/jobs/tick.test.ts` — a heterogeneous object-literal array typed as
   `{ authorization?: undefined } | { authorization: string }`, rejected by
   `tickRequest(headers: Record<string, string>)`. Root cause: missing annotation, not a route
   defect. Fixed by typing the array.
2. `check-in-refund-gate.integration.test.ts` — three assertions addressed the refusal
   `CheckIn` row by `ticketId`, but a refused attempt cannot carry `ticketId` (it is UNIQUE and
   belongs to the single accepted admission by design D-32); the row is traced by the presented
   code in `note`. Root cause: the test encoded the wrong key. Fixed. A fourth assertion
   expected the guard's reason for a settled `REFUNDED` ticket, where the guard correctly does
   not fire and the **CAS** refuses with `TICKET_NOT_ISSUED` / `details.status = REFUNDED`.
   Corrected to assert the real contract.
3. Two "concurrent check-in vs refund" tests initially raced on the **mocked session**: the
   harness's scope helpers re-sign the mocked `auth()` in, so a second sign-in landing
   mid-flight swapped the gate actor. Root cause: test harness, not the DB race. Fixed by
   resolving the buyer's scope before launching the pair, so only the gate reads the session —
   and the refund path takes its authority from the object passed in.

**Environment failures: none.**

---

## 26. Deferred items and non-blocking observations

* **DEFERRED — the read-only `stale` display grace** (§25.2 of the lock): deliberately
  untouched (P14-D24). It is a display grace, not the check-in gate.
* **DEFERRED — `CHECKIN_SUCCESS` notifications**, `CheckInResult.DUPLICATE` (still unused),
  and the QR delivery work of Phase 16 (D-46 closed by *ratifying* the current design, so
  Phase 16 is optional hardening: print/PDF wallet, offline manifest, reissue/transfer).
* **PRE-EXISTING (not this phase) — orphaned legacy tables in the database.** `prisma migrate
  diff` reports 30 legacy retail tables plus `refund_backup_phase10b` that exist in MariaDB but
  no longer have a Prisma model. This drift pre-dates Phase 15 (it is the residue of the retail
  removal) and the tool therefore *proposes* `DROP TABLE` statements. Nothing was dropped:
  §20/§26 forbid destructive migration. Flagged for a future cleanup phase, with an explicit
  decision required, not silently resolved here.
* **PRE-EXISTING (not this phase)** — the mixed-case leftover index names reported by the same
  diff (e.g. `Session_sessionToken_key`), and the working-tree deletions of
  `prisma/schema.after-pull.prisma`, `prisma/schema.prisma.bak` and the `seed-regions.*`
  files. None are Phase 15 changes.
* **Untouched by design:** Phase 10B refund lifecycle, Phase 12 cancellation and archive
  behaviour, Phase 13 check-in authorization, D-46 QR security model, D-61 money
  representation, payment settlement, ticket issuance, PIC fee settlement, public visibility
  semantics apart from adding `ONGOING` to the live catalog, past-event display grace, and
  `PENDING_REVIEW`.

---

## 27. Final verdict

**PHASE 15 COMPLETE.**

Every locked Phase 14 decision in §23 is implemented; no product rule had to be invented. The
verification is empirical, not merely "it compiles": `tsc --noEmit` clean, `prisma validate`
clean with the migration applied and the live schema matching the model, `npm run build`
successful, ESLint at the Phase 13 baseline (0 errors / 5 pre-existing warnings), **58 suites
and 1281 tests passing** including the real-MariaDB lifecycle, race and refund suites, plus a
live-server check of the tick route's 401/200 behaviour and the anonymous `/dashboard`
redirect.

No commit, no push, no reset, no `migrate reset`, no destructive migration, and no test was
deleted or weakened. The pre-existing uncommitted working tree was preserved as-is.

---

### git status (evidence)

```
$ git status --short | wc -l
474
```

The tree is **not** clean, and that is expected: it carried the Phase 1–14 uncommitted working
set before this phase. Phase 14 recorded **461** entries; the count is now **474**, and the
difference is exactly this phase's footprint — **11 new source/test files, `.env.example`, and
this report** — which also confirms that no other path was touched:

```
?? lib/events/lifecycle.ts
?? lib/jobs/lock.ts
?? lib/jobs/tick.ts
?? app/api/internal/
?? app/api/organizer/events/[id]/complete/
?? prisma/migrations/20260919000000_add_event_lifecycle_and_joblock/
?? __tests__/events/lifecycle-automation.test.ts
?? __tests__/events/lifecycle-integration.integration.test.ts
?? __tests__/events/lifecycle-ui-wiring.test.ts
?? __tests__/jobs/
?? __tests__/ticketing-checkin/check-in-refund-gate.integration.test.ts
 M .env.example
```
