# PHASE 20B — OPERATIONAL HARDENING IMPLEMENTATION REPORT

**Project:** TinggalKlik.Co
**Mode:** AUDIT → IMPLEMENT → VERIFY → REPORT
**Authoritative source:** `PHASE_20A_OPERATIONAL_DECISION_LOCK.md` (the owner selected **Option A**
for all nine decisions)
**Baseline:** Phase 19 — 63 suites / 1365 tests

Every claim below carries `FILE`, `FUNCTION / ROUTE`, behaviour and test evidence, and is
classified **IMPLEMENTED** · **VERIFIED (already satisfied)** · **PRE-EXISTING** · **DEFERRED**.

---

## 1. Executive Summary

**Phase 20B is complete.** Nine Option A decisions were applied. The decisive finding is that
**six of them are, by the Phase 20A contract itself, `status quo` with an empty obligation set** —
Option A of `D-P19-01`, `D-P19-02`, `D-P19-04`, `D-I19-01`, `D-I19-02` and `D-I19-04` is
"no automatic behaviour; the operator resolves it", which is what the system already does. Those
were audited and left untouched, and are recorded here with the evidence that satisfies them.

**Three decisions carried real work, and all three are implemented:**

1. **`D-P19-05` — an event now requires an `endAt` before it can be published.** Enforced in the
   service (a named precondition, exactly like the two that already existed), reflected in the two
   UI affordances, and covered by real-database tests. This closes the only hole Phase 19 found
   with a permanent consequence: an `endAt`-less event can never complete, so it stayed live — and
   its gate open — forever.
2. **`D-P19-03` — the gate's copy now describes the gate.** The predicate has no `startAt` term, so
   admission has always been possible from publication; the event page claimed the opposite. Option
   A keeps the behaviour and corrects the words. No display logic and no predicate changed.
3. **`D-I19-03` — the deployment contract is now documented in the repository.** `README.md` gained
   the scheduler section (endpoint, secret, VPS-cron line, systemd alternative, lease semantics,
   how to verify a run) plus the operational contracts for refunds, late settlements and the
   webhook ledger. The README's previous *only* deployment guidance — "Deploy on Vercel" —
   contradicted the scheduler design and was replaced.

**One documented contradiction with the brief, resolved in favour of Phase 20A.** The Phase 20B
brief (Step 3) asks that an undecided refund not "remain operationally blocking forever". Option A
of `D-P19-01`, as specified in Phase 20A and designated authoritative, is *"No automatic
expiration; an operator resolves every request"* — the exact opposite. No automation was invented:
the request is recorded here (§20, G1) as needing **Option B or C** as a new owner decision.

**Verification:** `prisma validate` valid · `migrate status` 22 migrations up to date · `tsc` exit 0
· **63 suites / 1376 tests passed** · build compiled · ESLint 0 errors / 5 pre-existing warnings ·
runtime smoke test green.

**No schema change, no migration, no new permission key, no new route, no new dependency.** No
commit, push, reset, or data modification.

### One notable consequence, stated plainly

The new publish precondition **broke 102 existing tests across 6 suites** — every fixture that
published an event without an end time. They were encoding the superseded contract, so they were
**updated, not deleted or weakened**: each fixture now sets a real `endAt` (§18). This is exactly
the consequence Phase 20A §8 named as the risk of Option A ("an organizer who genuinely does not
know the end time cannot publish"), now visible in the fixture population.

---

## 2. Decision Matrix

| ID | Option A as specified in Phase 20A | Obligation | Outcome |
|---|---|---|---|
| `D-P19-01` | No automatic expiration; operator resolves every request | none ("Implementation impact: **none**") | **VERIFIED (already satisfied)** — no code |
| `D-P19-02` | No SLA; age display only | none | **VERIFIED (already satisfied)** — the age column already exists |
| `D-P19-03` | Keep the behaviour; **correct the page copy** | UI copy must match the backend | **IMPLEMENTED** |
| `D-P19-04` | Manual operator remediation only (status quo + visibility) | none | **VERIFIED (already satisfied)** — the worklist exists and stays read-only |
| `D-P19-05` | **Require `endAt` before publish** | service + API + UI + tests | **IMPLEMENTED** |
| `D-I19-01` | Dashboard/manual only | none ("A = none") | **VERIFIED (already satisfied)** — no code |
| `D-I19-02` | No UI; logs/database only | none | **VERIFIED (already satisfied)** — no new surface added |
| `D-I19-03` | VPS cron | deployment documentation | **IMPLEMENTED** (docs; no code, no cron installed on any host) |
| `D-I19-04` | Dashboard-only | none | **VERIFIED (already satisfied)** — no provider, no writer |

---

## 3. D-P19-01 — Stale `PENDING` / `APPROVED` refunds → **Option A**

**Outcome: VERIFIED (already satisfied). No code change.**

* **FILE** `lib/ticketing/refunds/service.ts` · **FUNCTIONS** `requestRefund`, `approveRefund`,
  `rejectRefund`, `executeRefund`, `settleRefund`, `failRefund`
* **FILE** `lib/ticketing/events`→`lib/events/service.ts` · **FUNCTION** `archiveEvent` (open-refund
  precondition)
* **FILE** `lib/ticketing/checkin/service.ts` · **CONSTANT** `OPEN_REFUND_STATUSES`

**Behaviour under Option A (unchanged, verified):** a `PENDING`/`APPROVED` refund persists
indefinitely and is cleared only by a human decision (`approveRefund`/`rejectRefund`) — there is
**no** expiry function, **no** expiry job, and none was added. While open it continues to (a) retain
the `RefundItem` claim, (b) refuse the gate with `REFUND_PENDING`, and (c) block event archival.

**Why nothing was implemented:** Phase 20A §4 Option A is *"Behavior: status quo"* with
*"Implementation impact: **none** (zero code)"*, and §15's obligation row for `D-P19-01`/Option A is
empty. Implementing expiry would be Option B, which Phase 20A explicitly did not recommend and which
requires an owner-supplied duration, a `RefundStatus` decision, and an amendment to `P14-D10`
("two jobs only"). **It was not invented.** See §20 G1.

**Test evidence (pre-existing, still green):**
`__tests__/ticketing-refunds/refund-lifecycle.integration.test.ts`,
`__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts`,
`__tests__/ticketing-checkin/check-in-refund-gate.integration.test.ts`.

---

## 4. D-P19-02 — Refund SLA / reminder → **Option A**

**Outcome: VERIFIED (already satisfied). No code change.**

* **FILE** `app/dashboard/refunds/page.tsx` · **FUNCTION** `processingAge` — renders minutes → hours
  → days for `PROCESSING` rows in the **"Diproses"** column, from one clock read per render.
* **FILE** `lib/dashboard/refunds.ts` · **FUNCTION** `listDashboardRefunds` — all six statuses
  filterable, tenant-scoped.

**Behaviour under Option A:** the elapsed time is **visible** and there is **no threshold, no
reminder and no breach state**. The source comment on `processingAge` states this is deliberate
(*"Nothing here is a deadline or an SLA … inventing a threshold would invent a policy"*). No
threshold was invented and no `Notification` writer was added (Option B/A-of-`D-I19-04` keeps
notifications dashboard-only).

**Test evidence (pre-existing, still green):**
`__tests__/ticketing-refunds/refund-reconciliation-visibility.integration.test.ts`,
`__tests__/events/lifecycle-ui-wiring.test.ts`.

---

## 5. D-P19-03 — Check-in before `startAt` → **Option A** — **IMPLEMENTED**

**Contract:** keep the behaviour (admission is possible from publication), **correct the copy** so
the product describes itself truthfully. No predicate change, no new field, no authorization change.

### 5.1 The copy — FILE `app/dashboard/events/[id]/page.tsx`

**BEHAVIOUR:** the gate notice read *"Pintu masuk hanya dibuka untuk event yang sedang berjalan"* —
a start-time gate the predicate never implemented. It now reads **"Pintu masuk dibuka sejak event
dipublikasikan"**, followed by the existing grace clause when an end time exists. A comment at the
`gateState` derivation records why: `isEventCheckInOpen` has no `startAt` term, so the words were
corrected rather than the rule.

`gateState` itself is untouched — still derived from the one canonical predicate
(`isEventCheckInOpen(event, now)`) and the one canonical constant (`CHECK_IN_GRACE_MS`).

**Test evidence:** `__tests__/events/lifecycle-ui-wiring.test.ts` · `P20B-U1` asserts the page
contains the corrected sentence and **not** the withdrawn claim.

### 5.2 The behaviour is now pinned, not accidental

* **FILE** `__tests__/ticketing-checkin/check-in-wiring.test.ts` · new test
  *"admits BEFORE startAt — the pre-start window is the owned decision, not an oversight"*: a
  `PUBLISHED` event with `startAt` a month away reports an **open** gate, and the predicate's
  parameter type is asserted not to carry `startAt`.
* **FILE** `__tests__/events/lifecycle-ui-wiring.test.ts` · `P20B-U1` also extracts the predicate
  body and asserts it contains `CHECK_IN_GRACE_MS` and **no `startAt`** — so a future switch to
  Option B is a deliberate failing test rather than a silent edit.

### 5.3 What was NOT changed (all verified still in force)

| Concern | Status |
|---|---|
| server-side enforcement | unchanged — `lib/ticketing/checkin/service.ts:357` calls the canonical predicate |
| no client-only gate | unchanged — the panel receives `gateState` as a server-derived prop and reads no clock (`__tests__/events/lifecycle-ui-wiring.test.ts`) |
| `D-28` refund-pending gate | unchanged — `OPEN_REFUND_STATUSES` + `REFUND_PENDING` at `checkin/service.ts:429` |
| `CHECKED_IN` terminal / one admission per ticket | unchanged — CAS + `CheckIn.ticketId @unique` |
| tenant isolation | unchanged — `checkin.scan` + `StaffEventAssignment` + event-match |
| `CANCELLED` / `ARCHIVED` gates | unchanged — fail-closed before the status check |
| `REFUNDED` / `VOID` tickets | unchanged — the admission CAS requires `status = 'ISSUED'` |

**Existing gate coverage (pre-existing, still green):** the full matrix in
`__tests__/ticketing-checkin/check-in-wiring.test.ts` (P13-2 / P15-1: `PUBLISHED`, `ONGOING`,
`COMPLETED` ± grace, `DRAFT`, `PENDING_REVIEW`, `CANCELLED`, `ARCHIVED`, `endAt`-less) and the
real-database refund-gate cases in `__tests__/ticketing-checkin/check-in-refund-gate.integration.test.ts`
(`PENDING` / `APPROVED` / `PROCESSING` / `REFUNDED`).

---

## 6. D-P19-04 — Late-settlement remediation → **Option A**

**Outcome: VERIFIED (already satisfied). No code change.**

* **FILE** `lib/ticketing/payment/settlement.ts` · **FUNCTION** `settleVerifiedPayment` — returns
  `LATE_SETTLEMENT`, records the money, sets `fulfilmentBlockedAt`, audits
  `LATE_SETTLEMENT_AFTER_TERMINAL_STATE`. **No** ticket, **no** quota change, **no** resurrection.
* **FILE** `lib/ticketing/tickets/issuance.ts` · **FUNCTION** `assertOrderIsFulfillable` — refuses
  with `FULFILMENT_BLOCKED` when `fulfilmentBlockedAt` is set.
* **FILE** `lib/dashboard/orders.ts` · **FUNCTION** `needsReview` + `app/dashboard/orders/page.tsx`
  — the **"Perlu tindakan"** filter surfaces late settlements and `PAID`-with-zero-tickets.

**Behaviour under Option A (unchanged):** visibility only, and the worklist is **read-only**. No
automatic issuance, refund, quota restore, resurrection or payment-state mutation was added — and
the brief's prohibitions match Option A here, so there was no conflict.

**Where the money-side guarantees are enforced** (unchanged, re-verified this phase): the settlement
CAS in `lib/ticketing/payment/settlement.ts` is the only writer of `PAID`; issuance refuses
independently at `assertOrderIsFulfillable`.

**Test evidence (pre-existing, still green):** `__tests__/ticketing-payment/payment-webhook.integration.test.ts`,
`__tests__/ticketing-refunds/refund-reconciliation-visibility.integration.test.ts`.

---

## 7. D-P19-05 — `endAt` required before publish → **Option A** — **IMPLEMENTED**

### 7.1 Service (the control) — FILE `lib/events/service.ts`

**FUNCTION** `publishEvent` · **BEHAVIOUR:**

* `endAt: true` added to the precondition read.
* A third named precondition joins the existing two:

  ```
  if (current.endAt === null) {
      unmet.push("Waktu selesai event wajib diisi sebelum event dipublikasikan agar event dapat diselesaikan.");
  }
  ```

  It is returned as `CONFLICT` with `details.preconditions` — the same shape the quota and
  `startAt` conditions already use, so no new error code and no new client contract.
* The doc comment's precondition list is extended, and the reasoning is recorded: without an `endAt`
  an event can never complete (neither automatically per `P14-D22` nor manually), so it would stay
  live — and, under `D-P19-03` Option A, with its gate open — indefinitely.
* **Unchanged:** the `DRAFT`-only source state (`P14-D23`), the future-`startAt` rule, the
  read-only quota condition, the banner hint, `publishedAt` set on first publish only, and the
  `event.publish` audit row.

**Enforcement location:** server-side, inside the only function that writes `status = "PUBLISHED"`
(verified: `publishEvent` is the sole writer; the single caller is
`app/api/organizer/events/[id]/publish/route.ts`). The requirement is **not** in
`createEvent`/`updateEvent`, so a draft can still be saved incomplete — the smallest possible change,
and `endAt` stays editable through `DRAFT`, `PUBLISHED` and `ONGOING` (`P14-D12`).

**Test evidence (real database):** `__tests__/events/event-service.integration.test.ts` ·
*"refuses to publish an event with no endAt, naming the precondition"* (409 + `CONFLICT` +
`preconditions` contains "Waktu selesai" + the event is still `DRAFT` with `publishedAt = null`) ·
*"still saves a DRAFT with no endAt — the requirement is at publish, not create"* (create and update
succeed, then supplying the end time unblocks publication).

### 7.2 UI — FILE `components/organizer/EventActions.tsx`

**BEHAVIOUR:** the **Publikasikan** button is disabled when `endAt === null`, with a `title`
explaining that the end time is required because an `endAt`-less event cannot be completed, plus a
hint paragraph beneath the row — mirroring the existing disabled-with-explanation treatment of
**Selesaikan event** (`P14-D22`). The server refuses independently, so the rule survives a client
that ignores the disabled state.

### 7.3 UI — FILE `components/organizer/TicketTypeManager.tsx` + `app/dashboard/events/[id]/page.tsx`

**BEHAVIOUR:** the publish-readiness preview mirrors the three server preconditions; the third
(*"Waktu selesai event sudah diisi"*) was added, and the page now passes
`eventEndAt={event.endAt ? event.endAt.toISOString() : null}`. Without this the preview would report
"ready" for an event the server refuses — the exact class of UI/server drift Phase 20A flagged.

**Test evidence:** `__tests__/events/lifecycle-ui-wiring.test.ts` · `P20B-U2` asserts the service
rule exists, the button is disabled with the explanation, and the readiness list carries the new
condition and its prop.

### 7.4 Lifecycle monotonicity (audited, unchanged)

`PUBLISHED → ONGOING` (`P14-D02`) and `ONGOING → COMPLETED` (`P14-D04`) remain tick-driven and
monotonic; `COMPLETED` is never purchasable (`P14-D11`); `ARCHIVED` remains terminal; nothing was
added that could reopen a completed event. **Test evidence (pre-existing, still green):**
`__tests__/events/lifecycle-integration.integration.test.ts` (including the catch-up and
`endAt`-less cases), `__tests__/events/lifecycle-automation.test.ts`.

---

## 8. D-I19-01 — Refund processing reconciliation → **Option A**

**Outcome: VERIFIED (already satisfied). No code change.**

* **FILE** `lib/ticketing/refunds/service.ts` · **FUNCTION** `settleRefund` — the only path to
  `REFUNDED`; requires the operator's transfer reference (`refundSettleSchema#transferRef`, no amount
  accepted) and derives `confirmedAmount` server-side from `RefundItem.amount`.
* **FILE** `lib/ticketing/refunds/settlement.ts` · **FUNCTIONS** `processConfirmedRefund`,
  `processFailedRefund` — the sole financial mutation, and the claim release for failures.

**Behaviour under Option A:** dashboard/manual only. **No** reconciliation job, **no** statement
import, **no** provider integration was added; `payment.reconcile` and `verifyPaymentStatus()` stay
unconsumed, and neither was repurposed for refunds (they are payment-session-shaped and are not
refund evidence).

**Financial invariants — where enforcement happens (unchanged, re-verified):**

| Invariant | Enforced by |
|---|---|
| `refundedAmount + amount ≤ total` | conditional `updateMany` on the locked order row inside `processConfirmedRefund` |
| one `PROCESSING` refund per order (`D-P17-06`) | order-row `FOR UPDATE` + in-flight count + CAS in `executeRefund` |
| one claim per ticket (`D-R10`) | `RefundItem.ticketId @unique` |
| no refund of a `CHECKED_IN` ticket (`D-R05`) | ticket CAS requiring `status='ISSUED'`, `checkedInAt IS NULL`, `refundedAt IS NULL` |
| `REFUNDED` requires evidence | `settleRefund` + the strict settle schema |
| idempotent settlement | `PROCESSING → REFUNDED` CAS; replay returns `ALREADY_REFUNDED` |

**Test evidence (pre-existing, still green):** `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts`
(evidence requirements, wrong amount, duplicate settlement, concurrent settlement),
`refund-lifecycle.integration.test.ts`.

---

## 9. D-I19-02 — Webhook ledger visibility → **Option A**

**Outcome: VERIFIED (already satisfied). No code change.**

* **FILE** `lib/ticketing/payment/webhook.ts` — the delivery ledger write; the security sequence
  (raw-body bound → timing-safe signature fail-closed → amount verification → replay claim → act) is
  untouched.
* **MODEL** `WebhookEvent` — `providerEventId @unique`, `signatureValid`, `processingStatus`,
  `processingResult`, `payloadHash`, and an **already-redacted** `payloadJson`.

**Behaviour under Option A:** there is **no UI and no API** for the ledger — it is inspected through
the database. Nothing was added, so no payload, secret, signature or token material can be exposed
by a surface that does not exist; verification was not weakened.

**Test evidence (pre-existing, still green):** `__tests__/ticketing-payment/payment-webhook.integration.test.ts`
(valid/invalid signature, replay, duplicate delivery, amount mismatch, refund-callback handling).

---

## 10. D-I19-03 — Production scheduler → **Option A** — **IMPLEMENTED (documentation)**

The application side was already complete and hardened (Phase 15). Option A's obligation was the
**deployment contract**, because Phase 19 found that *nothing in the repository proved a scheduler
was calling the route*.

### 10.1 The contract, as documented

* **FILE** `README.md` · new **Operations** section (the deployment contract):

  | Field | Documented value |
  |---|---|
  | Trigger | `POST /api/internal/jobs/tick` |
  | Authentication | `Authorization: Bearer $JOBS_TICK_SECRET`; constant-time; fails closed; bare `401`; secret never logged |
  | Expected frequency | one request per minute (and *why* a slower cadence is safe: bounded batches, catch-up, 30-minute grace) |
  | Cron line | the exact VPS-crontab invocation, copy-pasteable |
  | Alternative | complete systemd `.service` + `.timer` units, with the reason they are preferred (run output is captured, so a persistent `401` cannot pass unnoticed) |
  | Single-flight | the `joblock` lease, 5 minutes, stale-lease takeover, and the explicit statement that the lease is a convenience while the **conditional writes** are the correctness guard |
  | Observability | `SELECT name, lastRunAt, lastStatus, lockedUntil FROM joblock;` — the only way to tell whether the jobs ran |
  | Deployment owner | **flagged as the operator's action** — the schedule is *not* installed by this phase |
* The README's previous, contradictory guidance (**"Deploy on Vercel"**) was replaced; the section
  now states plainly that both background behaviours are inert without the schedule, and that a
  serverless-only host would need the Phase 20A decision revisited.
* **FILE** `.env.example` — already carried `JOBS_TICK_SECRET`, the `openssl rand -hex 32` guidance
  and the example schedule (Phase 15). Verified unchanged and still correct.
* **NOT done, deliberately:** no cron was installed on any host, no worker process, no `setInterval`,
  no BullMQ/Redis. **Deployment-only, as Option A specifies.**

### 10.2 Scheduler runtime verification (this phase)

| Check | Result |
|---|---|
| `POST /api/internal/jobs/tick` with no header | **401** |
| with a wrong bearer token | **401** |
| with the correct secret | **200** — `eventLifecycle` and `reservationExpiry` both `ran: true, ok: true`, one shared `now` |

**Test evidence (pre-existing + new):** `__tests__/jobs/tick.test.ts` — machine authentication
(absent / malformed / wrong / unset secret), per-job isolation in both directions, lease overlap
prevention, stale-lease takeover, lifecycle and reaper ticks; **plus new `P20B-D1`** asserting the
README documents the endpoint, the secret name, the exact cron line and the `joblock` query, that the
Vercel recommendation is gone, and that `.env.example` still carries the secret and the example. The
proxy pass-through classification is asserted in the same suite.

---

## 11. D-I19-04 — Notification channel → **Option A**

**Outcome: VERIFIED (already satisfied). No code change.**

* **MODELS** `Notification`, `NotificationDelivery` (with `NotificationCategory.REFUND` etc. and
  channels `WHATSAPP`/`EMAIL`/`IN_APP`) — **zero writers, and none was added.**

**Behaviour under Option A:** dashboard-only. Every operational signal is a dashboard row; **no**
message is sent to buyers or staff, **no** provider was introduced, and **no** outbox was built.
Consequently no notification can affect a settlement, refund, ticket or payment — the brief's
prohibitions are satisfied by construction, not by a guard.

**Documented for operators:** README §6 states the dashboard is the channel of record.
**Test evidence:** none required (no behaviour); the absence of writers is asserted in the audit
(`PHASE_19_OPERATIONAL_HARDENING_AUDIT.md` §19).

---

## 12. Schema / Migration Changes

**None.**

* `prisma/schema.prisma` — **unmodified** (no enum value, no column, no index).
* `prisma/migrations/` — **no new migration**; `npx prisma migrate status` reports *22 migrations
  found* and *Database schema is up to date!*
* No `prisma migrate reset`, no destructive migration, no data modification.

This matches Phase 20A §17: **12 of 15 analysed options required no schema change**, and all three
selected options (copy, precondition, documentation) are code-and-docs only. `endAt` remains a
nullable column — the new rule is validation, not schema.

---

## 13. Authorization Changes

**None. No new permission key, no new role, no widened scope.**

| Surface touched this phase | Authority | Change |
|---|---|---|
| `publishEvent` precondition | `event.publish` in the event's tenant (unchanged) | a third *precondition*, evaluated after authorization |
| publish UI affordance | none — presentation only | disabled state only |
| readiness preview | none — reads data the page already renders | one new prop |
| gate copy | none — presentation only | text only |

Authorization ordering is unchanged and deliberate: `requireEventAccess` runs **before** the
preconditions, so a foreign tenant still receives its authorization error and cannot learn the
event's publish state. The existing suite asserts this
(`__tests__/events/event-service.integration.test.ts` — *"a member of A cannot publish, unpublish or
delete B's event"*, expecting `ORGANIZER_ACCESS_DENIED`), and it passes unchanged — which also
confirms the new precondition did not displace the tenant check.

---

## 14. Transaction / Concurrency Guarantees

No financial path was modified by this phase, so every guarantee below is **PRE-EXISTING and
re-verified** by the full suite:

| Invariant | Enforcement |
|---|---|
| one settlement per provider event | `WebhookEvent.providerEventId` UNIQUE + `PROCESSING`-only block |
| refund balance never exceeded | conditional `updateMany` inside the settlement transaction |
| one `PROCESSING` refund per order | order-row `FOR UPDATE` + count + CAS |
| one claim per ticket | `RefundItem.ticketId` UNIQUE |
| one admission per ticket | ticket CAS + `CheckIn.ticketId` UNIQUE |
| check-in ⟂ open refund | ticket-row `FOR UPDATE` taken by **both** writers + the open-refund guard |
| one lifecycle transition | `advanceEventLifecycleBatch` conditional updates; the lease is **not** the guard |
| one publish / cancel / complete / archive | conditional `updateMany` + `count !== 1` → `CONFLICT` |
| quota never over-sold | `UPDATE … WHERE reserved + sold + n <= quota` under a row lock |

**Newly relevant, and deliberately not a race:** the `endAt` precondition is a **read of the event
row already loaded for the same call**, evaluated before a conditional `updateMany` that carries
`status: "DRAFT"`. Two concurrent publishes still produce exactly one transition; the precondition
cannot introduce a check-then-write on money.

---

## 15. UI Changes

| File | Change | Reason |
|---|---|---|
| `app/dashboard/events/[id]/page.tsx` | gate copy corrected; comment recording why; passes `eventEndAt` to the readiness preview | `D-P19-03` (copy must match the backend), `D-P19-05` |
| `components/organizer/EventActions.tsx` | publish disabled with an explanation when `endAt === null`, plus a hint paragraph; header comment extended | `D-P19-05`, Step 16 (no control the backend rejects) |
| `components/organizer/TicketTypeManager.tsx` | third publish-readiness condition *"Waktu selesai event sudah diisi"* + `eventEndAt` prop | keeps the preview consistent with the server |

No control was added that the backend rejects; the one new disabled state carries an explanation.
The gate label (`OPEN`/`GRACE`/`CLOSED`) and its derivation are untouched.

---

## 16. Scheduler / Deployment Contract

See §10. Summary: **the application side is unchanged** (route, constant-time secret, fail-closed
behaviour, `joblock` lease, two idempotent jobs, one shared `now`, per-job isolation); the
**deployment side is now documented** in `README.md` §1 with a copy-pasteable VPS-cron line and a
systemd alternative. **The operator must install it** — this phase did not, and cannot, install cron
on a host.

---

## 17. Notification Behavior

**Dashboard-only (Option A).** No provider, no writer, no outbox. No notification can roll back a
settlement, duplicate a refund or ticket, or change a payment state.

---

## 18. Test Matrix

### 18.1 New tests (+11)

| Decision | File | Test |
|---|---|---|
| `D-P19-05` | `__tests__/events/event-service.integration.test.ts` | refuses to publish with no `endAt`, naming the precondition; nothing published |
| `D-P19-05` | same | a `DRAFT` without `endAt` still saves; supplying it later unblocks publication |
| `D-P19-03` | `__tests__/ticketing-checkin/check-in-wiring.test.ts` | admits before `startAt`; the pre-start window is the owned decision |
| `D-P19-03` | `__tests__/events/lifecycle-ui-wiring.test.ts` | the predicate body contains no `startAt` term |
| `D-P19-03` | same | the page describes the real rule and no longer claims a start-time gate |
| `D-P19-05` | same | the service enforces the precondition; the control is disabled with an explanation |
| `D-P19-05` | same | the readiness preview lists the new condition and receives it |
| `D-I19-03` | `__tests__/jobs/tick.test.ts` | README documents endpoint, secret, cron line and lease query |
| `D-I19-03` | same | the Vercel recommendation is gone; VPS cron and systemd are documented |
| `D-I19-03` | same | `.env.example` still carries the secret and the example schedule |

### 18.2 Updated fixtures (superseded contract, **none deleted or weakened**)

The `endAt`-before-publish rule made **102 tests across 6 suites** fail, because their setup
published events without an end time. Each fixture now supplies a real end time:

| File | Change |
|---|---|
| `__tests__/ticketing-payment/payment-harness.ts` | `FUTURE_END` exported; both fixture events carry `endAt` (drives payment, check-in and refund suites) |
| `__tests__/ticketing-checkout/checkout.integration.test.ts` | 4 published fixture events carry `endAt` |
| `__tests__/ticketing-checkout/checkout-concurrency.integration.test.ts` | 1 event |
| `__tests__/ticketing-checkin/check-in.integration.test.ts` | 1 event |
| `__tests__/ticket-types/publish-integration.integration.test.ts` | the shared `draftEvent` helper derives `endAt` from its `startAt` |
| `__tests__/events/event-service.integration.test.ts` | 8 published fixtures carry `endAt` (two of them specifically so the *intended* precondition remains the only unmet one) |
| `__tests__/ticketing-issuance/wallet-qr.integration.test.ts` | 1 fixture event; the scenario's own `endAt` arrangement is unchanged |

**No test was deleted, skipped, weakened or mocked-away.** Draft fixtures deliberately keep no end
time, which exercises the "a draft may be saved incomplete" half of the decision.

### 18.3 Pre-existing coverage re-run green

Refund lifecycle and manual rail · refund balance/concurrency · check-in matrix and refund gate ·
event lifecycle + automation + lease · reservation expiry · inventory concurrency · issuance
idempotency · authz role matrix · dashboard reconciliation visibility · UI wiring suites.

---

## 19. Verification Results

| # | Command | Result |
|---|---|---|
| 1 | `npx prisma validate` | *The schema at prisma/schema.prisma is valid 🚀* |
| 2 | `npx prisma migrate status` | 22 migrations found · *Database schema is up to date!* |
| 3 | `npx tsc --noEmit` | exit 0 |
| 4 | `npx jest --runInBand` | **63 suites / 1376 tests passed** (baseline 1365; **+11**) |
| 5 | concurrency tests | included in (4) — refund, check-in/refund, inventory, issuance, lease |
| 6 | `npm run build` | *✓ Compiled successfully* |
| 7 | `npx eslint .` | **0 errors / 5 warnings** — the unchanged pre-existing `no-img-element` set |

**Runtime smoke test:** tick → `401` (no header) · `401` (wrong secret) · `200` with both jobs
reporting `ran: true, ok: true` on one shared instant · public catalog `200` · anonymous
`/dashboard/events` and `/ticketing/tickets` → `302` to login.

**Failures encountered and root-caused:** the 102 failures in §18.2 — caused by the new publish
precondition meeting fixtures that encoded the old contract. **Classification: expected consequence
of an intended contract change, not a regression in production code** (the production code was
correct at every point; the fixtures were not). No other failures or flakes were observed.

---

## 20. Remaining Known Gaps

**G1 — `D-P19-01` remains "operator resolves it" (by decision, not by omission).** An undecided
refund still blocks its ticket, the gate and event archival indefinitely. The brief's Step 3 asks for
the opposite; **Phase 20A is authoritative and Option A is what it specifies.** Resolving this needs
a **new owner decision**: Option B (auto-expire, needs a duration + a `RefundStatus` decision +
a `P14-D10` amendment) or Option C (buyer withdrawal, needs a route, an audit action and a status
decision). Recorded, not silently implemented.

**G2 — No mechanical gate on ticket sales after `endAt`.** Purchasability is driven by the sales
windows (`salesStartAt`/`salesEndAt`, ticket-type windows) and by `COMPLETED`, not by `endAt`
itself; a `PUBLISHED`/`ONGOING` event can therefore still be sold inside its grace window. This is
the existing, locked contract and was not changed. Not raised as a defect — noted so the behaviour
is not mistaken for the new publish rule.

**G3 — The scheduler is still not installed on any host.** Documented (§10), and it remains the
operator's action. Until it is installed, lifecycle transitions and reservation expiry are inert.

**G4 — Pre-existing, untouched:** `PAYMENT_RECONCILE` and `verifyPaymentStatus()` remain unused;
`TicketStatus.VOID`/`RESERVED`, `EventStatus.PENDING_REVIEW` and the `Settlement` model still have
no writers; the six legacy orphan `refund` rows and the legacy retail tables remain; no refund SLA
value exists; no webhook ledger UI exists; the `payment-races` flake remains a known
load-sensitive test (it passed in this phase's full run).

---

## 21. Explicit Statement of What Was NOT Changed

* **No schema change, no migration, no data change** — not one row was read-modified; the six
  legacy orphan refund rows and all legacy tables are untouched.
* **No new route, permission key, role, dependency, or environment variable.**
* **No financial behaviour changed:** settlement, refund lifecycle and rail, quota movement, PIC
  reversal, ticket issuance and check-in authorization are all exactly as Phase 17/18B left them.
* **No automatic anything:** no automatic refund, ticket issuance, quota restore, re-fulfilment,
  order resurrection, notification, reconciliation, or refund expiry.
* **No `QR_SCAN`**, no camera scanner, no change to the `TICKET:<ticketCode>` payload or to the
  raw-token secrecy model.
* **Locked decisions intact:** `D-28`, `D-46`, `D-61`, `P14-D02`/`D04`/`D05`/`D06`/`D09`/`D10`/
  `D11`/`D12`/`D16`/`D22`/`D23`, `D-P17-04`/`05`/`06`/`09`/`12`/`17`/`18`, Phase 12 cancellation and
  archive widening, Phase 13 check-in authorization, Phase 16 wallet/QR.
* **The gate predicate was not changed** — `D-P19-03` Option A corrected the copy only.
* **No cron was installed**, no worker, no `setInterval`, no BullMQ/Redis.
* **No unrelated refactor.**
* **No commit, no push, no git reset, no `git clean`.**
