# PHASE 20A — OPERATIONAL DECISION LOCK

**Project:** TinggalKlik.Co
**Mode:** AUDIT → DECISION ANALYSIS → DECISION LOCK → REPORT
**Baseline:** Phase 19 (audit complete; no code required; 63 suites / 1365 tests green)
**Status of this document:** a decision *contract*. It selects no business policy.

Every statement is labelled: `SOURCE FACT` · `DESIGN FACT` · `EXISTING BEHAVIOR` ·
`PRODUCT DECISION` · `OPEN QUESTION` · `PROVIDER CAPABILITY` · `INFRASTRUCTURE DECISION`.
Source code was read directly for every claim; where a Phase 19 statement and the source
disagreed, the source is recorded as current truth and the discrepancy is named.

---

## 1. Executive Summary

Phase 20A analysed the nine open Phase 19 decisions against the live source. **No decision was
made.** The deliverable is an unambiguous implementation contract for Phase 20B that becomes
executable the moment the owner fills in the §20 table.

Three things changed the shape of the problem relative to the Phase 19 summary:

1. **Two decisions are already partly implemented, which narrows them to a value question.**
   `D-P19-02`: `/dashboard/refunds` **already computes and displays** a `PROCESSING` age
   (minutes → hours → days) in a column literally labelled *"Diproses"*, with a source comment
   stating it is deliberately *not* an SLA. So the question is only "does a threshold exist, and
   which side chases the other". `D-I19-02`: `WebhookEvent.payloadJson` is **already redacted**
   at write time, so an admin ledger does not require new payload discipline.

2. **`D-I19-03` is the only decision whose answer is already written down.** `.env.example`
   documents `JOBS_TICK_SECRET` **and the exact cron line** — including the cadence
   (*"one request per minute"*). What is missing is not a decision but an **installation**:
   nothing in the repository proves the cron exists, and `README.md`'s only deployment guidance
   is *"Deploy on Vercel"*, which contradicts the VPS-cron design. That contradiction is a
   `SOURCE FACT` and is reported (§11.4), not resolved.

3. **One decision has evidence that the code and its own UI disagree.** `D-P19-03`: the gate
   admits before `startAt`, while the event page's own copy reads *"Pintu masuk hanya dibuka
   untuk event yang sedang berjalan"* (the gate is only open for an event in progress). One of
   the two is wrong, and only the owner can say which.

**Recommended decision set (§14)** is a *recommendation for the owner*, not a decision: five
decisions can be closed structurally without inventing any value, and four require a value or a
rail the owner must supply. **Phase 20B is blocked on all nine.**

**Verdict: `PHASE 20A BLOCKED — OWNER DECISIONS REQUIRED`.**

---

## 2. Phase 19 Baseline

| Check | Result | Source |
|---|---|---|
| `npx prisma validate` | valid | re-run for this phase |
| `npx prisma migrate status` | 22 migrations · *Database schema is up to date!* | re-run |
| `npx tsc --noEmit` | exit 0 | re-run |
| `npx jest --runInBand` | **63 suites / 1365 tests passed** | re-run |
| `npm run build` | *✓ Compiled successfully* | re-run |
| `npx eslint .` | 0 errors / 5 warnings (pre-existing `no-img-element`) | re-run |
| Worktree before this phase | 494 entries | `git status --short \| wc -l` |

Phase 19's findings are carried forward unchanged: no mechanical integrity bug, every locked
money invariant enforced by a database constraint or conditional transaction write, and four
operationally consequential behaviours that are consequences of locked decisions rather than
defects.

**Correction carried from Phase 19 §2.2** (`SOURCE FACT`): the six long-lived `refund` rows are
**legacy retail orphans** (`refundNumber`, `eventOrderId`, `organizerId` all `NULL`, zero
`RefundItem` rows), not a stranded ticketing refund. Phase 18B's sentence about a live
`PROCESSING` refund holding an order slot was inaccurate. Nothing about any Phase 18B
implementation changes.

---

## 3. Prior Locked Decisions

These are **not reopened** by this document. They constrain the options below.

| ID | Locked contract | Where enforced |
|---|---|---|
| `D-28` | open refund (`PENDING`/`APPROVED`/`PROCESSING`) blocks check-in | `lib/ticketing/checkin/service.ts:73,429` |
| `D-46` | QR payload is exactly `TICKET:<ticketCode>`; `QR_SCAN` unused; raw token server-only | `lib/ticketing/tickets/reference.ts` |
| `P14-D02` | `PUBLISHED → ONGOING` at `startAt`, automatic only | `lib/events/lifecycle.ts` |
| `P14-D04` | completion at `endAt + 30m`, catch-up allowed | `lib/events/lifecycle.ts` |
| `P14-D05` | manual completion after `endAt` (`event.publish`) | `lib/events/service.ts#completeEventManually` |
| `P14-D06` | exactly 30-minute check-in grace, one constant | `lib/events/sales-state.ts#CHECK_IN_GRACE_MINUTES` |
| `P14-D09/D10` | internal tick route + DB lease; business logic never in cron | `app/api/internal/jobs/tick/route.ts`, `lib/jobs/lock.ts` |
| `P14-D11` | `COMPLETED` is not purchasable; `ONGOING` is | `lib/events/sales-state.ts#isEventPurchasable` |
| `P14-D12` | `startAt` frozen at `ONGOING`; `endAt` frozen at `COMPLETED`; no reopen | `lib/events/service.ts:492-523` |
| `P14-D16` | completion moves no money, waits for nothing | `lib/events/service.ts#completeEvent*` |
| `P14-D22` | `endAt IS NULL` never auto-completes, never completes manually | `lib/events/lifecycle.ts`, `service.ts:885` |
| `P14-D23` | publish from `DRAFT` only; unpublish from `PUBLISHED` only | `lib/events/service.ts` |
| `D-P17-09` | event cancellation does **not** automatically refund | `lib/events/service.ts#cancelEvent` |
| `D-P17-12` | PIC fee reverses only on full order-item refund | `lib/ticketing/refunds/settlement.ts` |
| `D-P17-17` | late settlement stays blocked and manual | `lib/ticketing/payment/settlement.ts` |
| `D-P17-18` | ticket issuance stays buyer-triggered | `app/api/ticketing/orders/[orderNumber]/issue/route.ts` |
| `D-P17-04` | refund rail is **manual bank transfer**; no provider refund API | `lib/ticketing/payment/refund-provider.ts` |
| `D-P17-05` | whole-rupiah pricing, enforced server-side | `lib/ticket-types/validation.ts` |
| `D-P17-06` | at most **one** `PROCESSING` refund per order | `lib/ticketing/refunds/service.ts#executeRefund` |
| `D-61` | `Decimal(14,2)` → fixed 2-decimal API strings | `lib/ticketing/money.ts` |
| `D-R03` | only `PAID`/`PARTIALLY_REFUNDED` orders are refundable | `lib/ticketing/refunds/eligibility.ts:141-162` |
| `D-R05` | a `CHECKED_IN` ticket is never refundable | `eligibility.ts:197` |
| Phase 12 | archive is `any non-ARCHIVED`, **refused while anyone's refund is open** | `lib/events/service.ts:1097,1404` |

**Rule applied throughout:** where a proposed option would change one of these, the option is
marked as requiring an **explicit amendment**, never as an incidental consequence.

---

## 4. D-P19-01 — Stale `PENDING` / `APPROVED` refunds

**DECISION ID:** D-P19-01
**TITLE:** Lifecycle of an undecided refund request

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

A refund is created by `requestRefund` (`lib/ticketing/refunds/service.ts:114`) as a `Refund` row
plus one `RefundItem` per selected ticket. Five staff functions exist —
`approveRefund`, `rejectRefund`, `executeRefund`, `settleRefund`, `failRefund` — and `listRefunds`.
**No withdrawal, cancel or expiry function exists.** While the refund is `PENDING` or `APPROVED`,
three things hold simultaneously:

1. **The claim is retained.** `RefundItem.ticketId` is `@unique`; `evaluateRefundEligibility`
   refuses a second claim for that ticket, so the buyer cannot request again for the same ticket.
2. **The gate refuses.** `checkIn/service.ts:73,429` treats `PENDING`/`APPROVED`/`PROCESSING` as
   `OPEN_REFUND_STATUSES` → `reason: "REFUND_PENDING"`.
3. **The event cannot be archived.** `archiveEvent` (`events/service.ts:1404`) counts refunds with
   `status IN (PENDING, APPROVED, PROCESSING)` for the event and throws
   `AppError.conflict("Event tidak dapat diarsipkan selama masih ada refund yang belum selesai.")`
   with `details.preconditions`.

The row stays visible and actionable on `/dashboard/refunds` (all statuses are filterable;
`VALID_STATUSES` includes `PENDING`, `APPROVED`, `PROCESSING`, `REFUNDED`, `FAILED`).
A buyer-facing list exists at `app/ticketing/refunds/page.tsx`, and it is **read-only**.
Audit actions today: `refund.request`, `refund.approve`, `refund.reject`, `refund.process`,
`refund.settle`, `refund.fail`.

### WHY THIS MATTERS

Requirement (3) is the sharp end: **one neglected request row blocks an event's archival**, and
requirements (1)+(2) withhold a ticket that no longer has an active dispute intent. This is not a
bug — it is the correct consequence of three locked decisions — but the *lifecycle* of an
abandoned request has never been specified.

### EXISTING LOCKS

`D-R10` (one claim per ticket, database-enforced) · `D-28` (open refund blocks the gate) ·
Phase 12 archive precondition (`REFUNDABLE`-in-flight blocks archive) · `D-R02`
(requester cannot decide their own refund, so the *buyer* can never clear a stale row).

### OPTIONS

#### OPTION A — No automatic expiration; an operator resolves every request
* **Behavior:** status quo. A stale row is cleared only by `approveRefund`/`rejectRefund`
  (either of which is a decision, not an expiry).
* **Consequences:** ticket claim, gate refusal and archive block all persist until a human acts.
* **Implementation impact:** **none** (zero code).
* **Operational impact:** the operator must notice the row. The current dashboard makes it
  visible but does not rank it.
* **Risk:** an unattended request stalls one ticket and one event's archival indefinitely.
  Mitigation today is procedural only.

#### OPTION B — Automatic expiration after an explicit SLA
* **Behavior:** a scheduled pass moves stale `PENDING`/`APPROVED` refunds to a terminal state,
  releasing the claim.
* **Consequences:** *definitional* — this is `D-P19-01`, not a mechanism. Before any code exists,
  the owner must answer: what is the state (`REJECTED` vs a new `EXPIRED`)? Does expiry notify the
  buyer? Can the buyer re-request immediately (which would make expiry a no-op against a
  determined buyer)? Does expiry need to be reversible by an operator?
* **Implementation impact:** **highest of the three.** A new `RefundStatus` value would require an
  enum change plus migration; reusing `REJECTED` avoids the migration but misrepresents intent
  (a `REJECTED` refund was *decided*; an expired one was *abandoned*). A third `joblock` job
  conflicts with `P14-D10` *"two jobs only"* — the amendment would be explicit.
* **Operational impact:** removes the stall, adds a new automated state machine that moves no
  money and must be tested for races against `approveRefund`.
* **Risk:** without a buyer notification, an expired request can look to the buyer like a silent
  rejection. **The SLA duration is a value that must come from the owner; this document invents
  none.**

#### OPTION C — Buyer withdrawal before approval
* **Behavior:** the buyer may withdraw their own `PENDING` (and possibly `APPROVED`) request;
  the claim is released and the ticket becomes requestable and gate-eligible again.
* **Consequences:** clears the common case (buyer changed their mind) without a timer, and
  preserves `D-R02` — the buyer acts on their *own* request, they do not *decide* it.
* **Implementation impact:** a new service function + `POST /api/ticketing/refunds/[refundId]/withdraw`
  (`refund.request.own` + ownership predicate + same-origin), new validation schema, new audit
  action `refund.withdraw`, reuse of `releaseRefundClaims`
  (`settlement.ts:71`) for the claim release, and a status decision: reuse `REJECTED` (no
  migration) or add `WITHDRAWN` (enum change + migration).
* **Operational impact:** fewer stale rows, no new job, buyer has a self-service exit.
* **Risk:** withdrawal of an `APPROVED` refund creates a window in which staff must not
  concurrently execute it — the same CAS discipline `executeRefund` already uses is required.
  A withdrawn request that the buyer re-submits produces claim churn rather than a stall.

> A fourth variant — *"operator may delete/reject a stale row without a decision"* — is **not
> offered**: rejecting is a decision with a recorded actor, and a silent delete would destroy the
> audit trail the refund workflow exists to preserve.

### RECOMMENDED CONTRACT

**Recommendation for owner consideration (structural only):** Option **A** as the *immediate*
contract (zero code, zero risk, no value required), optionally followed by Option **C** as the
real fix, since C removes the stall without a timer, a value, or a background job, and is the only
option that does not need a notification channel to be honest. **Option B is not recommended**
until a value and a buyer-facing notification exist, because an unattended expiry with no
notification is indistinguishable from a silent rejection.

### IMPLEMENTATION CONSEQUENCES
A = none. C = one service function, one route, one validation schema, one audit action, one status
decision (`REJECTED` reuse vs `WITHDRAWN` addition). B = C's surface **plus** a third job (an
explicit `P14-D10` amendment), a schema/enum decision, and a `PENDING → EXPIRED` race test against
`approveRefund`.

### TEST CONSEQUENCES
A = none. C/B = ownership (only the requester may withdraw), a concurrent
withdraw/approve test with exactly one winner, claim release asserted on the ticket, gate
`REFUND_PENDING` cleared afterwards, archival unblocked, audit row written, and a
re-request-after-withdrawal test.

**MIGRATION REQUIRED?** A = **NO.** C = **NO if `REJECTED` is reused; YES (enum addition) if
`WITHDRAWN`.** B = **likely YES** (`PENDING → EXPIRED` is not expressible in the shipped enum
without overloading `FAILED` or `REJECTED`). One additive migration at most; no data migration in
any variant (no existing row changes state).

**EXTERNAL DEPENDENCY?** A/C = none. B = only if expiry is accompanied by a buyer notification
(§12 `D-I19-04`).

### FINAL OWNER DECISION
`____________________________________________`

---

## 5. D-P19-02 — Refund SLA / reminder

**DECISION ID:** D-P19-02
**TITLE:** Whether a refund has a time commitment, and who is told when it lapses

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

* **An age display already exists.** `app/dashboard/refunds/page.tsx#processingAge` converts
  `processedAt` into `"N menit" | "N jam" | "N hari"` and renders it in the **"Diproses"** column
  (only for `PROCESSING` rows). Its source comment is explicit:
  *"Nothing here is a deadline or an SLA — the product decision leaves a stuck refund to an
  operator, and inventing a threshold would invent a policy."* One clock read per render keeps
  every cell consistent.
* **No SLA data exists.** `PlatformSetting` has exactly: `platformName`, `logoUrl`, `email`,
  `phone`, `address`, `defaultPicFeeRateBp`, `defaultPlatformFeeRateBp`, `reservationTtlMinutes`,
  `exportSyncMaxRows`. There is no refund-related field, and `PlatformSetting` is read by exactly
  one module (`lib/ticketing/reservations.ts:102`, `reservationTtlMinutes`).
* **A delivery schema already exists but is unused.** `Notification` carries `channel`,
  `recipient`, `idempotencyKey @unique`, `category` (`REFUND` is a shipped value),
  `templateKey`, `priority`, `recipientType`, and nullable links to `eventOrder`/`ticket`/`event`/
  `organizer`/`picProfile`. `NotificationDelivery` carries `channel` (`WHATSAPP`/`EMAIL`/`IN_APP`),
  `status` (`QUEUED`/`SENDING`/`SENT`/`FAILED`/`SKIPPED`), `attemptCount`, `maxAttempts`,
  `nextRetryAt`, and a `(notificationId, channel)` unique. **Both tables have zero writers**, and
  **no provider client exists** in the repository.
* **The lifecycle already timestamps every step** an SLA would need: `createdAt`,
  `approvedAt`, `processedAt`, `completedAt`, `failedAt`.

### WHY THIS MATTERS

An operator can already *see* how long a refund has been in flight, and a buyer can already *see*
their own refund (`app/ticketing/refunds/page.tsx`). What does not exist is a commitment — so the
question is genuinely about **obligation and escalation**, not about visibility.

### EXISTING LOCKS

`D-P17-04` (manual rail: the platform cannot make the money move, a human does) ·
`D-P19-02`'s answer must not imply automatic settlement (`REFUNDED` requires
operator-recorded transfer evidence — `settleRefund` + `refundSettleSchema#transferRef`).
The age display's own comment is a **`DESIGN FACT`**: no threshold may be invented.

### OPTIONS

#### OPTION A — No SLA; age display only (status quo)
* **Behavior:** the dashboard shows elapsed time; no threshold, no reminder, no breach state.
* **Consequences:** zero new surfaces; the operator's judgement is the only mechanism.
* **Implementation impact:** none.
* **Operational impact:** unchanged.
* **Risk:** a refund can sit in `PROCESSING` unnoticed. Low today (a `PROCESSING` refund is only
  created by an operator action), rising if refund volume grows.

#### OPTION B — Operator reminder only (staff-facing, no buyer commitment)
* **Behavior:** when a `PROCESSING` refund passes a threshold, the dashboard flags it (a badge or
  a worklist row) — and optionally writes a staff `Notification` row.
* **Consequences:** needs an SLA *value* and a destination for the reminder.
* **Implementation impact:** with the threshold as a **constant**, this is a read-model change
  (`lib/dashboard/refunds.ts#listDashboardRefunds`) and a page badge — **no schema, no migration,
  no new job**. If the threshold must be configurable, it needs an additive `PlatformSetting`
  field + migration. With a `Notification` row it also needs the first-ever writer for a table
  with no provider — a queued-but-unsendable row is *worse* than none, because it implies a
  delivery that will never happen.
* **Operational impact:** converts "visible if you look" into "flagged if you don't".
* **Risk:** a badge with no owner discipline becomes background noise.

#### OPTION C — Buyer-facing commitment (buyer reminder / SLA promise)
* **Behavior:** the buyer is told a refund is being processed and reminded if it is not settled.
* **Consequences:** this is a **public commitment**, so the value must be defensible against the
  manual bank-transfer rail: the platform cannot guarantee a bank's posting time. It also
  requires a delivery channel to exist first (§12).
* **Implementation impact:** depends entirely on `D-I19-04`. Cannot be implemented alone.
* **Operational impact:** the operator bears the SLA.
* **Risk:** the highest of the three — a missed advertised window is a reputational and
  dispute risk the platform cannot control (the rail is a manual transfer).

> A fourth variant — *automatic escalation* (a job that reassigns or force-settles) — is **not
> offered**: force-settling is forbidden (`REFUNDED` requires evidence), and reassignment invents
> an organizational policy.

### RECOMMENDED CONTRACT

**This decision is BOTH product and infrastructure**, and should be split:
* **Product half:** whether a threshold exists at all, and — if so — its **value** (owner-supplied;
  none is proposed here), and whether it is staff-facing or buyer-facing.
* **Infrastructure half:** any buyer-facing reminder is **blocked by `D-I19-04`**.

**Recommendation for owner consideration:** Option **B with a constant threshold**, no new
`Notification` writer, no buyer commitment — it is the only variant that delivers value with no
schema change, no job, and no promise the manual rail cannot keep. **Option C should not be chosen
before a channel exists.**

**Required data if an SLA is selected:** the threshold (constant or `PlatformSetting`), which
status it applies to (`PROCESSING` only, or `APPROVED` as well), the reference timestamp
(`processedAt` for `PROCESSING`), the breach action (flag only vs escalate), and the notification
target if any. Everything else already exists as timestamps.

### IMPLEMENTATION CONSEQUENCES
Read-model + badge only (Option B, constant): `lib/dashboard/refunds.ts`, `app/dashboard/refunds/page.tsx`.
Configurable threshold: an additive `PlatformSetting` field. Buyer reminder: blocked.

### TEST CONSEQUENCES
Threshold boundary (just-under / just-over), that a `REFUNDED`/`FAILED` row is never flagged,
that the flag is computed from one clock read, and tenant scoping of any reminder query.

**MIGRATION REQUIRED?** **NO** with a constant. **YES (additive `PlatformSetting` column)** if the
threshold must be configurable per deployment.

**EXTERNAL DEPENDENCY?** **Only for the buyer-facing variant** — none exists
(`D-I19-04`).

### FINAL OWNER DECISION
`____________________________________________`

---

## 6. D-P19-03 — Check-in gate timing relative to `startAt`

**DECISION ID:** D-P19-03
**TITLE:** May a ticket be admitted before the event starts?

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

`lib/events/sales-state.ts#isEventCheckInOpen(event, now)` is the single canonical gate predicate
(reused by the check-in service at `checkin/service.ts:357` and by the wallet's "scannable"
verdict). It returns, in order:

1. `false` if `archivedAt !== null` or `cancelledAt !== null` — fail closed;
2. `false` unless `status ∈ CHECKIN_OPEN_STATUSES` = `{PUBLISHED, ONGOING, COMPLETED}`;
3. for `COMPLETED`: `false` when `endAt IS NULL`, else `now ≤ endAt + 30m`;
4. for `PUBLISHED`/`ONGOING`: `true` when `endAt IS NULL`, else `now ≤ endAt + 30m`.

**There is no `startAt` term anywhere in the predicate** (the only `startAt` occurrence in the file
is in an unrelated sales-window helper at line 165). Therefore:

> **`PUBLISHED` + not cancelled + not archived + `now ≤ endAt + 30m` (or `endAt IS NULL`)
> ⇒ the gate is open, including arbitrarily long before the event begins.**

And because `publishEvent` **requires `startAt` to be in the future**
(`lib/events/service.ts:69`; the documented preconditions are *"at least one active `TicketType`
with `quota > 0`"*, *"`startAt` in the future"*, and a banner which is explicitly **not** enforced),
the early-admission window is **always ≥ 0 and unbounded above** — a weekly event published a month
ahead has a gate open for a month.

**Consumers that inherit this behaviour today:** the check-in service (authoritative), the event
page's display state (`app/dashboard/events/[id]/page.tsx:75-87` derives
`gateState: "OPEN" | "GRACE" | "CLOSED"` from `checkInOpen` + `endAt`), and the buyer wallet's
`admission.scannable` (Phase 16).

### WHY THIS MATTERS

This is an externally visible business rule: it decides whether a valid ticket is admitted weeks
before its event. It also produces a **documented contradiction** (`SOURCE FACT`): the event page's
own copy reads *"Pintu masuk hanya dibuka untuk event yang sedang berjalan"* — the gate is only
open for an event in progress — which the predicate does not implement. Either the copy is wrong or
the predicate is; the owner must say which.

### EXISTING LOCKS

`P14-D06` (30-minute grace after `endAt`, one constant) · `P14-D03` (lifecycle monotonic) ·
Phase 14 §5 (the gate contract as implemented) · `D-28` (refund guard unchanged by this decision).

### OPTIONS

#### OPTION A — Keep current behavior (`PUBLISHED` opens the gate)
* **Behavior:** as above. Admission is possible from publication until `endAt + 30m`.
* **Consequences:** attendee admission works with zero staff timing pressure; the wallet's
  scannable verdict is truthful from publish time; day-of operations cannot be "locked out" by a
  clock misconfiguration; no lifecycle or scheduler involvement.
* **Implementation impact:** **none**.
* **Operational impact:** favourable for staff (no window to set up), unfavourable for fraud
  control (a ticket is a usable credential for the entire pre-event period).
* **Risk:** early admission. Also the *stated* meaning of `ONGOING` ("event sedang berlangsung")
  becomes decorative, and the UI copy stays inaccurate.

#### OPTION B — The gate opens at `startAt`
* **Behavior:** `now < startAt` ⇒ closed, for every status.
* **Consequences:** the gate aligns with the event's own time window and with the copy already on
  the page; admission before the event is impossible; the wallet's scannable state becomes false
  until the event starts (a visible change for buyers who open the ticket early).
* **Implementation impact:** **one predicate change plus one constant-free condition** —
  `isEventCheckInOpen` gains a `startAt` term. Critically, it must be implemented as
  **`startAt <= now`, not as `status === "ONGOING"`**: a `status`-based gate would make admission
  depend on the **scheduler having run**, converting a cron outage into a closed gate at the
  venue. `startAt` is a stored column, so a `startAt`-based gate keeps the predicate
  scheduler-independent. Consumers need no new data plumbing: `gateState` is server-derived and
  the panel already receives it as a prop.
* **Operational impact:** staff must not open the gate early; combine with `P14-D05`-style manual
  completion only if an operator override is later requested (a separate decision).
* **Risk:** an event that starts late now has a genuinely closed gate until its recorded
  `startAt`; a timezone mistake in `startAt` becomes an admission incident, where today it is only
  a display problem.

#### OPTION C — The gate opens a configured number of minutes before `startAt`
* **Behavior:** as B, with a lead time.
* **Consequences:** matches real box-office practice; handles queue formation and late door prep.
* **Implementation impact:** identical to B plus **a value** (a constant, or an additive
  `PlatformSetting`/`Event` field). Tests must cover the boundary on both sides.
* **Operational impact:** best of the three for real operations.
* **Risk:** **the lead-time value must come from the owner — none is proposed here**; a
  per-event override would widen the UX and the migration.

### RECOMMENDED CONTRACT

**Recommendation for owner consideration — Option B**, implemented as `startAt <= now` (not as a
status check), because it makes the predicate agree with the copy the product already ships, is a
one-condition change, and — decisive — **does not make admission depend on the scheduler**.
Option C is equally sound if a lead time is wanted, but then the owner must supply the value and
decide whether it is global or per event. Option A is defensible only if early admission is
intended, in which case **the page copy must be corrected** so the product describes itself
truthfully.

Whichever option is chosen, note that this **amends a Phase 14 §5 contract statement**, so the
decision should be recorded as an explicit amendment to the decision lock, not as a silent fix.

### IMPLEMENTATION CONSEQUENCES
`lib/events/sales-state.ts#isEventCheckInOpen` (+ `CHECKIN_OPEN_STATUSES` docs); no change to
`checkin/service.ts`, the event page, or the wallet, since all three consume the predicate. The
30-minute `endAt` grace, `COMPLETED` handling and the `endAt IS NULL` rule are untouched.

### TEST CONSEQUENCES
Gate matrix around `startAt` (just before / exactly at / after), and per status: `DRAFT` closed,
`PUBLISHED`/`ONGOING` closed before `startAt` and open after, `COMPLETED` open only within grace,
`CANCELLED`/`ARCHIVED` always closed, `endAt IS NULL` live event follows the same `startAt` rule.
A scheduler-independence test (gate state is unaffected by whether any job has run) is required
for Option B/C to prove the design choice above. Wallet scannable state must be re-asserted at the
new boundary.

**MIGRATION REQUIRED?** A/B = **NO.** C with a global constant = **NO**; with a configurable or
per-event value = **YES (additive)**.

**EXTERNAL DEPENDENCY?** None. Predicates use epoch comparisons; rendering already localizes via
`toLocaleString("id-ID")`, so no timezone library or timezone storage change is required.

### FINAL OWNER DECISION
`____________________________________________`

---

## 7. D-P19-04 — Late-settlement remediation

**DECISION ID:** D-P19-04
**TITLE:** What an operator may do with money that arrived for a terminal order

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

`lib/ticketing/payment/settlement.ts` classifies a verified provider delivery against the order's
state and returns one of `SETTLED`, `ALREADY_PAID`, `ORDER_FAILED`, `LATE_SETTLEMENT`,
`NOT_APPLICABLE`, `RETRY_LATER`. Two distinct situations block fulfilment:

* **`LATE_SETTLEMENT`** (returned at `:95` and `:377`): the order is already terminal
  (`CANCELLED`/`EXPIRED`), so **no resurrection, no quota change and no ticket** — the payment is
  recorded and `fulfilmentBlockedAt` is set (`:289`, `:353`, `:442`), with the audit action
  `LATE_SETTLEMENT_AFTER_TERMINAL_STATE` (`:533`).
* **A settled order with anomalies** (`:442`): money is in and the order is `PAID`, but the held
  seats could not be converted 1:1, so `fulfilmentBlockedAt` is set rather than guessed
  (`WHERE fulfilmentBlockedAt IS NULL` — first writer wins).

Downstream, the block is absolute and honest:

* **Issuance refuses:** `assertOrderIsFulfillable` throws `FULFILMENT_BLOCKED` when
  `fulfilmentBlockedAt !== null`, and `ORDER_NOT_PAID` unless `status = PAID` **and**
  `paymentStatus = PAID` **and** `paidAt <> null`.
* **The refund workflow cannot reach it:** `evaluateRefundEligibility` (`eligibility.ts:141-162`)
  requires `status ∈ {PAID, PARTIALLY_REFUNDED}` **and** `paymentStatus ∈ {PAID,
  PARTIALLY_REFUNDED}` → a `CANCELLED`/`EXPIRED` order is refused as `ORDER_NOT_PAID`.
* **Quota is not restored** (correct: the seats were released at expiry/cancel).
* **The money is recorded:** a `PaymentTransaction(PAYMENT)` row exists from settlement.
* **It is visible:** `lib/dashboard/orders.ts#needsReview` + the orders page "Perlu tindakan"
  filter (Phase 18B), read-only.

### WHY THIS MATTERS

This is the only state in the system where **customer money is held and no supported operation can
return it**. Phase 18B deliberately shipped visibility without remediation. Phase 20A must define
what "manual" means, because today "manual" means *"look at it"*.

### EXISTING LOCKS

`D-P17-17` (late settlement **remains blocked and manual**; no auto-fulfilment, no auto-issuance,
no resurrection) · `D-R03` (only `PAID`/`PARTIALLY_REFUNDED` orders are refundable) ·
`D-P17-04` (the refund rail is a manual bank transfer) · `D-P17-18` (issuance is buyer-triggered).

### OPTIONS

#### OPTION A — Manual operator remediation only (status quo + visibility)
* **Behavior:** nothing changes. The order stays blocked, visible in "Perlu tindakan".
* **Consequences:** zero risk to money lineage; the customer's money remains on the platform.
* **Implementation impact:** none.
* **Operational impact:** support must handle the case outside the product (off-platform refund).
* **Risk:** an indefinitely held payment with no in-product resolution and no audit trail for the
  off-platform remedy — the worst outcome for reconciliation.

#### OPTION B — Automatic refund
* **Behavior:** settlement detects a terminal order and initiates a refund.
* **Consequences:** **forbidden.** `D-P17-17` explicitly forbids it, the rail cannot refund
  programmatically (`D-P17-04`), and completion/cancellation may never move money (`P14-D16`,
  `D-P17-09`).
* **Implementation impact:** n/a. **Operational impact:** n/a. **Risk:** n/a — out of contract.

#### OPTION C — Buyer-initiated refund request against the terminal order
* **Behavior:** the buyer requests a refund through the normal workflow for a `CANCELLED`/`EXPIRED`
  order that has money attached.
* **Consequences:** reuses the entire existing rail, evidence discipline and SoD; the buyer is the
  claimant (consistent with `D-R01`).
* **Implementation impact:** **changes `D-R03`** — `evaluateRefundEligibility` would need a
  carve-out such as *"an order whose `paymentStatus` is `PAID` and whose money was recorded as a
  late settlement is refundable even though its `status` is terminal"*. That is a change to a
  locked eligibility rule, so it must be an explicit amendment plus new eligibility reason codes
  and tests.
* **Operational impact:** the buyer self-serves; staff only approve and settle.
* **Risk:** **this is the design-sensitive option.** The carve-out must not accidentally make any
  terminal order refundable — only those with recorded money and no fulfilled tickets. A
  `refundableBalance` of `0` on such an order would need care, since such an order may have
  `refundedAmount = 0` while never having had tickets.

#### OPTION D — Operator-initiated manual bank-transfer refund for a terminal order
* **Behavior:** an authorized operator creates the refund row for the blocked order and settles it
  through the existing manual-evidence path.
* **Consequences:** fully auditable in-product (`refund.request` … `refund.settle` with a bank
  reference); keeps the buyer out of the decision; uses the rail that already exists.
* **Implementation impact:** like C, requires the `D-R03` carve-out (or a distinct
  "operator late-settlement refund" path), plus `refund.request` in an operator context, which the
  SoD rule then forbids the same actor from approving — the two-person rule must still hold.
* **Operational impact:** staff-driven; the buyer must be told by some other means
  (blocked by `D-I19-04`).
* **Risk:** if the operator can create a refund for *any* terminal order, the eligibility carve-out
  becomes an operator override of `D-R03`; it must be bounded to orders that carry recorded money
  and `fulfilmentBlockedAt`, and it must be auditable as such.

> Explicitly **not** offered: *"restore fulfilment"* / *"mark the order fulfilable"* — that is
> `D-P17-17`'s prohibition, and restoring seats that were released and possibly resold would be an
> inventory violation.

**Evidence required by any money-returning option:** the same discipline as the manual rail —
`Refund.providerRef` (bank reference), `Refund.evidenceNote`, `processedByUserId`, `completedAt`,
`confirmedAmount` derived server-side from `RefundItem` amounts, never operator-entered. The
existing `settleRefund` schema already enforces this; nothing new is needed. **Audit trail:**
`refund.request`/`approve`/`process`/`settle` plus the pre-existing
`LATE_SETTLEMENT_AFTER_TERMINAL_STATE` payment audit, so the money's inbound and outbound records
both exist. **Quota must not be restored** (never held at settlement time for a terminal order).
**Tickets must never be issued** (`assertOrderIsFulfillable` stays untouched).

### RECOMMENDED CONTRACT

**Recommendation for owner consideration — Option A now, Option D as the follow-up decision.**
Rationale: A is `D-P17-17` as written and carries no risk; D is the only option that returns money
*inside* the product with the existing rail and evidence model, but it requires an explicit
amendment to `D-R03` and a bound that prevents it becoming a general operator override. **Option C
adds a buyer-initiated path to the same amendment** and can be added afterwards once D defines the
eligibility carve-out. **Option B is out of contract.**

### IMPLEMENTATION CONSEQUENCES
A = none. D = eligibility carve-out + bounded predicate + an operator refund path + tests that
prove no other terminal order becomes refundable. No change to settlement, completion or
cancellation.

### TEST CONSEQUENCES
That a late-settled order carries exactly one `PaymentTransaction`, that no ticket can be issued
for it, that quota is untouched, that an authorized operator can create and settle the refund, that
SoD still blocks self-approval, that an ineligible `CANCELLED` order with **no** recorded money is
still refused, and that an idempotent replay does not double-refund.

**MIGRATION REQUIRED?** A = **NO.** C/D = **NO schema change** if the carve-out is expressed as
eligibility logic; **possible additive** if a marker column is preferred over inference from
`fulfilmentBlockedAt` + `paymentStatus`. No data migration.

**EXTERNAL DEPENDENCY?** The manual bank rail only (`D-P17-04`); no provider API.

### FINAL OWNER DECISION
`____________________________________________`

---

## 8. D-P19-05 — Is `endAt` required before publish?

**DECISION ID:** D-P19-05
**TITLE:** May an event be published without an end time?

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

* **Validation:** `lib/events/validation.ts` — `startAt` is **required** on create
  (`isoDateTime`) and optional on update (omitted = unchanged); `endAt` is
  `optionalIsoDateTime` on **both** create and update, so `endAt` may be `null` at every point in
  an event's life before `COMPLETED`.
* **Publish:** `publishEvent` enforces *"at least one active `TicketType` with `quota > 0`"* and
  *"`startAt` in the future"*; the banner is *"recommended only, NOT enforced"*. **There is no
  `endAt` precondition**, and `endAt` is not even selected for the precondition check.
* **Lifecycle:** `isCompletionDue` and `mayCompleteManually` both require a non-null `endAt`, so a
  null-`endAt` event **never** completes automatically or manually (`P14-D22`), and
  `completeEventManually` throws *"Event tanpa waktu selesai tidak dapat diselesaikan secara
  manual. Batalkan atau arsipkan event ini sebagai gantinya."*
* **Gate:** with `endAt IS NULL` the gate returns `true` for as long as the event is otherwise live
  — i.e. **indefinitely**, and independently of `D-P19-03`'s answer for the *late* bound (the
  early bound, if any, comes from Option B/C there).
* **Edit rules:** `endAt` is editable in `DRAFT`, `PUBLISHED` and `ONGOING`, and frozen at
  `COMPLETED` (`service.ts:514-523`), with `endAt > startAt` enforced
  (`service.ts:544`, *"Harus setelah waktu mulai."*). So a null `endAt` **can be filled in later**
  — including while `ONGOING`.
* **Sales:** purchasability is driven by the sales windows (`salesStartAt`/`salesEndAt` and the
  ticket-type windows), not by `endAt`, so a null `endAt` does not by itself extend sales.
* **Exits that exist:** cancel and archive both work on a null-`endAt` event.

### WHY THIS MATTERS

A null `endAt` is not merely "an event with an open ending". Combined with `P14-D22` it produces an
event that is **permanently live**: no automatic completion, no manual completion, and — today — an
open gate forever. That is a coherent design only if the product intends indefinite events.

### EXISTING LOCKS

`P14-D22` (null `endAt` never completes) · `P14-D12` (`endAt` frozen only at `COMPLETED`) ·
`P14-D04` (completion at `endAt + 30m`, catch-up allowed) · `P14-D11`/`CANCELLED`/`ARCHIVED`
lifecycle.

### OPTIONS

#### OPTION A — Require `endAt` before publish
* **Behavior:** publishing a draft with no `endAt` is refused with a precondition.
* **Consequences:** every live event has a completion deadline; `COMPLETED` becomes reachable for
  every published event, so the lifecycle's "no exit" hole closes at the source.
* **Implementation impact:** `publishEvent` gains a precondition and a `preconditions` entry,
  consistent with the existing quota/`startAt` preconditions (whose unmet items are already
  returned as `details.preconditions`). Because `endAt` is required *at publish* rather than at
  create, drafts can still be saved incomplete — the smallest possible change.
* **Operational impact:** organizers must decide an end time before going live.
* **Risk:** an organizer who genuinely does not know the end time cannot publish; they would set an
  arbitrary value, which then **freezes at `COMPLETED`** (`P14-D12`) and can no longer be
  corrected afterwards. That is a real consequence of this option and must be understood.

#### OPTION B — Allow `endAt IS NULL` indefinitely (status quo)
* **Behavior:** as today.
* **Consequences:** no forced decision; the event never completes and the gate never closes by
  itself.
* **Implementation impact:** none.
* **Operational impact:** an organizer must remember to cancel or archive; nothing prompts them.
* **Risk:** permanently live events; combined with `D-P19-03` Option A, a permanently open gate
  with no time bound at all. Also, `reports`/completion-based surfaces never include the event.

#### OPTION C — Allow null initially, require it before the event starts
* **Behavior:** publishable with a null `endAt`; the event must have one before `ONGOING`
  (i.e. before `startAt`).
* **Consequences:** splits the two concerns — publishing (sales/marketing) is unblocked, while
  completion is guaranteed. It also fits the existing monotonic lifecycle: the requirement lands at
  the same boundary where `startAt` freezes.
* **Implementation impact:** either a validation rule at the `PUBLISHED → ONGOING` transition
  (which today is a **batch job**, not a user action, so the requirement could only be enforced by
  the *tick* or by an edit-time rule) or a precondition on editing. **This is the awkward part:**
  blocking the automatic transition is not possible without either failing a job (leaving the event
  `PUBLISHED` past its start) or adding a stored pre-start validation surface. It also interacts
  with `P14-D02` (the transition is automatic), so implementing C means the job must *refuse* to
  advance an event with no `endAt` — a new job-level exclusion that must be documented and tested.
* **Operational impact:** an organizer who forgets must act before the start; the system cannot
  self-heal.
* **Risk:** if the job refuses to advance, the event stays `PUBLISHED` while its start passes —
  which puts the gate/lifecycle in a subtly wrong state (the event is running but not `ONGOING`).

> Interpretation note: only A and B keep the lifecycle's automatic transitions intact. **C is
> mechanically the most intrusive** because the transition it gates is owned by a background job
> rather than a user action.

### RECOMMENDED CONTRACT

**Recommendation for owner consideration — Option A**, because it closes the "permanent live event"
hole at the cheapest point (a publish precondition, matching the two preconditions already there),
requires no job change, and keeps `P14-D02`/`P14-D04` untouched. The counter-argument — that an
unknown end time is sometimes genuine — is real, and should be weighed against the fact that
**`endAt` remains editable through `ONGOING`** (`P14-D12`), so an organizer only needs a plausible
value at publish time, and can correct it later until `COMPLETED`. Option B is acceptable only if
indefinite events are intended, in which case the "never completes" consequence should be
documented for organizers. **Option C is not recommended** because it adds a job-level exclusion
to a transition `P14-D02` defines as automatic.

### IMPLEMENTATION CONSEQUENCES
A = `publishEvent` precondition + message + tests. B = none. C = job exclusion semantics + tests.

### TEST CONSEQUENCES
A: publish refused with a precondition when `endAt` is null, allowed when set, and `endAt > startAt`
still enforced; a draft with null `endAt` still saves. C: the lifecycle batch leaves a null-`endAt`
`PUBLISHED` event un-advanced and still reports it as scanned.

**MIGRATION REQUIRED?** **NO** for A and B — `endAt` stays a nullable column; the requirement is
validation, not schema. C = no schema change either, but a job-behaviour change.

**EXTERNAL DEPENDENCY?** None.

### FINAL OWNER DECISION
`____________________________________________`

---

## 9. D-I19-01 — Refund processing reconciliation

**DECISION ID:** D-I19-01
**TITLE:** How a `PROCESSING` refund is observed and closed

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

The manual rail is complete and evidence-gated: `executeRefund` (`APPROVED → PROCESSING`) writes
`processedAt`/`processedByUserId` and **no money**; `settleRefund` (`PROCESSING → REFUNDED`)
requires `transferRef` (strict schema, `min(3).max(120)`, no amount accepted) and derives
`confirmedAmount` server-side from `RefundItem.amount`; `failRefund` (`PROCESSING → FAILED`)
records `failureReason` and releases the claim. `Refund` exposes `providerRef` (the operator's bank
reference), `evidenceNote`, `processedAt`, `completedAt`, `failedAt`. The dashboard shows status,
amount, buyer, ticket count, transfer evidence, processing age and creation time, with the six
statuses filterable.

**Nothing transitions `PROCESSING` automatically.** There is no refund-shaped reconciliation
surface or job. Two related artefacts exist and are **unused**: the `payment.reconcile` permission
(no consumers) and `verifyPaymentStatus()` in `lib/payment/ipaymu.ts` (no callers) — and the
webhook module documents why a poll is not a settlement trigger. **Neither can produce evidence
about a refund**, because both are keyed by a payment session.

### WHY THIS MATTERS

This is the decision about whether `PROCESSING` can be *closed* by anything other than a human, and
the honest answer depends on a fact the phase must state plainly:

> **A bank-transfer reference recorded by the operator is a claim, not proof.** It is authoritative
> only if compared against an authoritative external source — a bank statement or a transfer
> provider's API. Without such a source, any "automatic reconciliation" would be *inference*, and
> inference must never write `REFUNDED`.

### EXISTING LOCKS

`D-P17-04` (manual bank transfer; **no provider refund API**) · Phase 18B (`REFUNDED` requires
recorded evidence; `PROCESSING` does not mean money moved; the operator may never write `REFUNDED`
without evidence) · Phase 15/17 (`verifyPaymentStatus` is not a settlement trigger) ·
`P14-D10` (two jobs only).

### OPTIONS

#### OPTION A — Dashboard/manual only (status quo)
* **Behavior:** an operator reads the age column and acts. `PROCESSING` has no automatic exit.
* **Consequences:** zero risk; the truth of each row stays a human attestation.
* **Implementation impact:** none.
* **Operational impact:** the operator is the reconciliation system.
* **Risk:** unbounded `PROCESSING` duration (see `D-P19-02`); no aging policy, no chase.

#### OPTION B — Age-based reminder (observability, not state)
* **Behavior:** flag rows that exceed a threshold.
* **Consequences:** purely a read-model concern; no state change, no money.
* **Implementation impact:** the same change as `D-P19-02` Option B — they are the same surface.
* **Operational impact:** the "stuck refund" becomes visible without being *resolved*.
* **Risk:** low; a badge is not a policy.

#### OPTION C — Scheduled reconciliation job
* **Behavior:** a job polls something and settles or fails stale refunds.
* **Consequences:** **blocked, and not by infrastructure effort — by the absence of an
  authoritative source.** A job can only act on evidence; the only evidence in the system is
  operator-entered. Polling iPaymu is not a refund-status source (`D-P17-04`), and reusing
  `PAYMENT_RECONCILE`/`verifyPaymentStatus` for refunds would be a category error. This option also
  adds a **third job**, contradicting `P14-D10` ("two jobs only") without an explicit amendment.
* **Implementation impact:** a new job + rail capability that does not exist.
* **Operational impact:** would remove the human from the loop — which is exactly what the manual
  rail was chosen to prevent.
* **Risk:** **high and unacceptable as specified** — an automatic transition with no authoritative
  evidence would be fabricated success, which Phase 17/18A forbid.

#### OPTION D — Bank statement import
* **Behavior:** an operator imports (or the system ingests) the platform bank statement; transfers
  are matched to `Refund.providerRef` + amount and made available as *evidence* for a human to
  confirm.
* **Consequences:** this is the **only mechanism that makes a bank reference authoritative**. It
  supplies evidence; it must not itself write `REFUNDED` unless the owner explicitly delegates that
  and the matching is exact (reference + amount + currency + date window).
* **Implementation impact:** a new import surface (file or API), a matching routine, a review UI,
  storage for the imported statement, and an authorization decision (who may import).
* **Operational impact:** significantly reduces manual checking at volume.
* **Risk:** statement formats vary per bank; a wrong match could attest to money that never
  arrived. Requires exact-reference discipline and human confirmation for anything ambiguous.

#### OPTION E — External transfer provider integration
* **Behavior:** refunds are paid out through a provider that returns a settlement status.
* **Consequences:** supplies authoritative evidence programmatically — the only variant in which a
  job could legitimately settle a refund.
* **Implementation impact:** a new provider integration, credentials, webhook/polling, its own
  reconciliation and failure handling; effectively a second money rail alongside the gateway.
* **Operational impact:** real automation, real provider dependency.
* **Risk:** **`EXTERNAL PROVIDER RESEARCH REQUIRED`** — no such provider has been evaluated or
  chosen in this repository, and no capability may be assumed.

### RECOMMENDED CONTRACT

**Recommendation for owner consideration — Option A as the contract now, with Option D named as
the only viable path to automation.** The reasoning: B is a display change that belongs to
`D-P19-02`; C is **blocked by evidence, not effort**; E is an unevaluated provider decision. D is
the single mechanism that upgrades a recorded claim into verified evidence, and even then the
recommended shape is *"D supplies evidence, a human confirms"* rather than automatic settlement.
If the owner ever wants automated settlement, D or E must come first — in that order of cost.

**Documented for the record:** automatic reconciliation is impossible with the current rail, and
that is a **`PROVIDER CAPABILITY`** fact, not a backlog item.

### IMPLEMENTATION CONSEQUENCES
A = none. B = shared with `D-P19-02`. D/E = out of scope until chosen; nothing may be built first.

### TEST CONSEQUENCES
A/B: none beyond `D-P19-02`'s. D: import parsing, exact-match on reference + amount, ambiguity
handling, authorization, and that no import can move a refund to `REFUNDED` without human
confirmation. E: provider-specific; blocked.

**MIGRATION REQUIRED?** A/B = **NO.** D = likely **YES (new tables for imported statements and
matches)**. E = yes, undetermined.

**EXTERNAL DEPENDENCY?** A/B = none. D = a bank statement source (file export or API). E = a
transfer provider, unevaluated.

### FINAL OWNER DECISION
`____________________________________________`

---

## 10. D-I19-02 — Webhook ledger visibility

**DECISION ID:** D-I19-02
**TITLE:** Who may see provider deliveries, including rejected ones

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

`WebhookEvent` persists one row per delivery: `provider`, `providerEventId @unique`,
`providerTransactionId`, `eventType`, `statusCode`, `amountReported` (explicitly *untrusted until
verified*), `payloadHash` (SHA-256 of the raw body), `payloadJson` (**already redacted** —
*"Redacted payload summary; full raw bodies are not retained here"*), `signatureValid`,
`orderId`/`paymentId` (nullable, `SetNull`), `processingStatus` (`RECEIVED`/`PROCESSED`/`IGNORED`/
`FAILED`), `processingResult`, `errorMessage`, `remoteIp`, `receivedAt`, `processedAt`.

**There is no UI and no API for it.** `find app/api/admin -name route.ts` returns only `pic`,
`sports` and `venues`. A repository-wide search finds no `webhookEvent` consumer in `lib/dashboard`
or `app/dashboard`. So today a **forged-signature attempt is recorded and invisible**: a
`signatureValid = false` row is written, `IGNORED`/`FAILED` results land in `processingResult`, and
nothing surfaces them.

### WHY THIS MATTERS

The ledger is the platform's only forensic record of the payment boundary — replay attempts,
amount mismatches, unknown orders, and every refused signature. Its absence from every operator
surface means the strongest security evidence in the system is write-only.

### EXISTING LOCKS

Phase 15/17 webhook security sequence (raw-body bound → timing-safe signature fail-closed → amount
verification → replay claim → act) · `D-P17-06` (one in-flight refund per order; refund callbacks
are now recorded as `ignored_refund_rail_is_manual`) · "no new permission key" (Phase 18B/19) ·
`D-61` (money as fixed 2-decimal strings).

### OPTIONS

#### OPTION A — No UI; logs/database only
* **Behavior:** status quo.
* **Consequences:** zero surface, zero exposure risk.
* **Implementation impact:** none.
* **Operational impact:** investigation requires database access.
* **Risk:** a live attack indicator stays unseen by operators.

#### OPTION B — Read-only admin webhook ledger
* **Behavior:** a paginated, filterable list of deliveries with the **metadata** required to
  triage — timestamp, provider, event type, `signatureValid`, `processingStatus`,
  `processingResult`, `amountReported`, linked order/payment reference, `remoteIp`, and the
  `payloadHash` for forensic comparison. **No raw payload bodies, no secrets, no token material.**
* **Consequences:** every refused/replayed/mismatched delivery becomes discoverable.
* **Implementation impact:** a read model plus one read-only page and/or an admin API route
  following the existing `app/api/admin/<resource>/route.ts` convention. **Authorization is the
  open design question:** the natural platform-level capability is `payment.reconcile` (ADMIN and
  MANAGER already hold it), but the ledger is **payment-shaped data across all tenants**, so the
  owner must confirm whether it is a platform-wide view (using `payment.reconcile`) or
  tenant-scoped (using `payment.read.tenant`). Choosing the tenant-scoped reading requires the
  query to derive scope from `order.organizerId`, and rows with `orderId = NULL` (unmatched
  deliveries) would then be invisible — which would hide exactly the forgery attempts the surface
  exists to reveal. **This is the decisive detail of this decision.**
* **Operational impact:** an actionable security surface with no mutation.
* **Risk:** low, provided the last point is answered: a tenant-scoped ledger is a *worse* security
  control than no ledger, because it hides unmatched deliveries.

#### OPTION C — Filtered operational reconciliation screen
* **Behavior:** as B, plus purpose-built filters (e.g. "signature rejected", "amount mismatch",
  "unknown order") and a link to the affected order.
* **Consequences:** same as B with better triage ergonomics.
* **Implementation impact:** B plus preset filters and order deep-links.
* **Operational impact:** best day-to-day usability.
* **Risk:** same as B; no state change either way.

#### OPTION D — Full replay/retry console
* **Behavior:** operators can re-process or resend deliveries.
* **Consequences:** **not offered.** Replay is the mechanism the ledger exists to *detect*, and a
  manual replay button would create a new mutation path into settlement — the single CAS-guarded
  settlement path would gain a second entry point. Provider re-delivery is already the supported
  recovery (`providerEventId` UNIQUE, only `PROCESSED` blocks a later verified delivery).
* **Implementation impact:** n/a. **Operational impact:** n/a. **Risk:** unacceptable.

### RECOMMENDED CONTRACT

**Recommendation for owner consideration — Option B (or C) with the following minimum and security
requirements, which are not optional:**
* **Expose:** `receivedAt`, `provider`, `eventType`, `statusCode`, `signatureValid`,
  `processingStatus`, `processingResult`, `errorMessage`, `amountReported`, `remoteIp`,
  `payloadHash`, and the linked order/payment **reference** (not internal ids where avoidable).
* **Never expose:** raw payload bodies (`payloadJson` is redacted but still omittable), the
  webhook signing secret, any `qrToken`/`qrTokenHash`, provider credentials, or buyer PII beyond
  what an operator needs.
* **Replay controls:** none (Option D refused). Read-only.
* **Tenant isolation:** the owner must choose platform-scoped (via `payment.reconcile`) or
  tenant-scoped (via `payment.read.tenant`) — and if tenant-scoped, a **separate platform-only
  view for unmatched deliveries** is required, or the control fails where it matters.
* **Permission:** no new key is proposed; the two existing keys are the candidates.

### IMPLEMENTATION CONSEQUENCES
One read model (`lib/dashboard/**`) + one page or admin route. No mutation path, no settlement
involvement. Audit posture unchanged: viewing the ledger must not write audit rows.

### TEST CONSEQUENCES
Authorization (unauthenticated denied; the chosen scope enforced; cross-tenant denied), that the
redacted payload is not rendered, that no secret field is serialized, and that forged-signature
rows are returned by the filter they were designed for.

**MIGRATION REQUIRED?** **NO.** Every required field already exists, with indexes on
`(provider, receivedAt)`, `(processingStatus, receivedAt)` and `(orderId, receivedAt)`.

**EXTERNAL DEPENDENCY?** None.

### FINAL OWNER DECISION
`____________________________________________`

---

## 11. D-I19-03 — Production scheduler contract

**DECISION ID:** D-I19-03
**TITLE:** What drives `POST /api/internal/jobs/tick`, how often, and who owns it

### 11.1 Current source behavior (`SOURCE FACT`)

The application side is complete and hardened:

* **Route:** `app/api/internal/jobs/tick/route.ts`. `Authorization: Bearer $JOBS_TICK_SECRET`,
  compared in **constant time** (SHA-256-length-padded to avoid a length oracle); **fails closed**
  when the secret is unset; a bare `401` for absent/wrong/malformed headers; no session; no body;
  returns `200` with per-job results (a failed *job* is reported in the body, not by failing the
  request). `proxy.ts:81` lists `/api/internal/` as a pass-through, documented as defence in depth
  with the real control in the handler.
* **Single-flight:** `lib/jobs/lock.ts` — two names only (`event-lifecycle`, `reservation-reaper`),
  `JOB_LEASE_MS = 5 minutes`, acquisition = `upsert` (empty update, so an active lease is not
  stomped) + conditional `updateMany` on `lockedUntil IS NULL OR lockedUntil < now`; release
  records `lastRunAt`/`lastStatus` (`OK`/`FAILED`). A skipped run (`ran: false, ok: true`) returns
  **without** touching the lease row, so `lastRunAt` truthfully means *last executed run*, and the
  declared `SKIPPED` status has no writer. The lease is explicitly documented as *not* the
  correctness guard — every job's transitions are conditional writes.
* **Work:** `lib/jobs/tick.ts#runJobsTick` — one `now` shared by both jobs, sequential, per-job
  try/catch so a failure in one cannot prevent the other, batch sizes 200 (lifecycle) and 100
  (reaper), returning `{ ok, now, jobs: { eventLifecycle, reservationExpiry }, durationMs }`.
* **Documented trigger:** `.env.example:79-93` names `JOBS_TICK_SECRET` (with
  `openssl rand -hex 32` guidance) **and the cron line verbatim**:
  `* * * * * curl -fsS -X POST https://YOUR_HOST/api/internal/jobs/tick -H "Authorization: Bearer $JOBS_TICK_SECRET" >/dev/null`,
  stating *"The tick itself is driven by the deployment's cron, one request per minute"* and *"No
  worker process, no Redis, no BullMQ"*.
* **What does NOT exist:** no crontab, systemd unit/timer, `vercel.json`, package script, CI job or
  supervisor entry. **No `maxDuration` or explicit `runtime` export on the route** (it runs on the
  default Node.js runtime; Phase 15's runtime verification exercised it successfully at 200).

### 11.2 The contradiction (`SOURCE FACT`)

`README.md` contains only Next.js boilerplate — *Getting Started*, *Learn More*, and **"Deploy on
Vercel"** — with no mention of cron, `JOBS_TICK_SECRET`, or the tick route. The scheduler design,
however, presumes a long-lived host with crontab (VPS). **The repository's only stated deployment
target and its only scheduler design disagree.** This is reported, not resolved.

### 11.3 Frequency analysis (`DESIGN FACT`, not a locked rule)

**No locked business rule mandates a frequency.** What the system tolerates is bounded by:

| Driver | Value | Consequence of a slow tick |
|---|---|---|
| check-in grace (`P14-D06`) | 30 min after `endAt` | completion lags; catch-up is allowed, so a delay is cosmetic |
| reservation TTL (`PlatformSetting.reservationTtlMinutes`) | 30 min default | held seats are released late, delaying inventory availability |
| lifecycle catch-up | allowed (`P14-D04`) | a long-past event completes directly; no drift accumulates |
| lease | 5 min | a run longer than 5 min can be overlapped by the next tick (harmless: conditional writes) |

So anything from ~1 minute to a few minutes satisfies every dependent behaviour, and **1 minute is
the value the repository already documents.** It should be treated as the documented intent to
confirm, not as a derived requirement.

### 11.4 OPTIONS

#### OPTION A — VPS cron
* **Reliability:** high (crond is a supervised system service). **Overlap:** prevented by the DB
  lease. **Restart:** cron is independent of app restarts. **Logging:** whatever the command
  redirects; `>/dev/null` as documented discards output, so the *only* durable evidence is
  `joblock.lastRunAt`/`lastStatus` and the audit rows the jobs write. **Failure visibility:** pull
  only. **Deployment complexity:** lowest — one crontab line, already documented verbatim.
  **Secret handling:** the secret can live in the crontab environment or a sourced env file.
  **Maintenance:** none. **Frequency:** any.
* **Risk:** a missing/typo'd cron entry is silent; the `>/dev/null` in the documented line discards
  the HTTP status, so even a persistent `401` would be invisible.

#### OPTION B — systemd timer
* **Reliability:** highest of A/B (units are declarative and restartable; `OnCalendar` or
  `OnUnitActiveSec`). **Overlap:** lease, plus systemd's own no-overlap guarantee for a unit.
  **Restart:** fully independent of the app. **Logging:** journald captures each run's output —
  **strictly better than A** — giving exit status and stderr for free. **Failure visibility:**
  queryable via `systemctl status`, still pull-only but with history. **Deployment complexity:**
  two unit files instead of one line; needs root. **Secret handling:** `EnvironmentFile=` with
  tight permissions. **Maintenance:** low. **Frequency:** any.
* **Risk:** more moving parts than A; requires systemd (not available on every host/container).

#### OPTION C — External scheduler (hosted cron/ping service)
* **Reliability:** depends on the provider, and introduces an off-host dependency in the
  money-adjacent path. **Overlap:** lease. **Restart:** n/a. **Logging:** the provider's dashboard.
  **Failure visibility:** often better (the provider alerts on non-2xx). **Deployment complexity:**
  low locally, but adds a third party that holds the secret. **Secret handling:** the weakest of the
  options — a shared secret stored in a hosted service. **Maintenance:** account/billing.
* **Risk:** an external service holding a bearer token that runs jobs touching money-adjacent
  state; also unavailable offline and unsuitable for the on-premises/VPS posture implied by the
  design.

#### OPTION D — PM2 cron ecosystem
* **Reliability:** depends on PM2 running. **Overlap:** lease. **Restart:** PM2 supervises.
  **Logging:** PM2 logs. **Deployment complexity:** requires adopting PM2 for the app lifecycle —
  a broader change than a scheduler. **Secret handling:** PM2 ecosystem config. **Maintenance:**
  another ecosystem to operate. **Frequency:** cron_restart is restart-oriented, not a clean
  per-minute HTTP trigger.
* **Risk:** introduces a process manager the project does not otherwise use, and misuses a restart
  primitive as a scheduler.

### RECOMMENDED CONTRACT

**Recommendation for owner consideration — OPTION A (VPS cron)**, because `.env.example` already
documents that exact contract and the design explicitly rejected a worker process; with **OPTION B
named as the better variant if the host uses systemd**, since it captures run output that the
documented `>/dev/null` cron line intentionally discards. **C is not recommended** (third party
holding the token), and **D is not recommended** (adopts a process manager for a task that needs
one HTTP request).

The contract, whichever mechanism is chosen:

| FIELD | VALUE |
|---|---|
| **TRIGGER** | `POST /api/internal/jobs/tick`, once per invocation; no body |
| **AUTHENTICATION** | `Authorization: Bearer $JOBS_TICK_SECRET`; constant-time; fails closed; bare `401`; secret never logged |
| **EXPECTED FREQUENCY** | 1 request per minute (as documented in `.env.example`); any interval from 1 to a few minutes satisfies every dependent behaviour; **owner to confirm the value** |
| **TIMEOUT** | Should be configured to exceed a normal run (both jobs are bounded batches of 200/100 rows) and stay below the 5-minute lease; the route declares none today |
| **FAILURE HANDLING** | per-job try/catch; a failed job is recorded as `lastStatus = 'FAILED'` on its lease row and reported in the response body; the HTTP status stays 200; the next tick is the retry (both jobs are idempotent) |
| **OBSERVABILITY** | `joblock.lastRunAt` / `lastStatus` per job, plus the audit rows the jobs write; **nothing surfaces these today** (see below) |
| **SINGLE-FLIGHT** | DB lease, 5-minute `lockedUntil`, stale leases takeover-able without operator action |
| **DEPLOYMENT OWNER** | **`OPEN` — not stated anywhere in the repository.** The owner must name who installs and monitors the schedule |

**Two gaps to record regardless of mechanism:** (1) if the documented `>/dev/null` line is used, a
persistent `401` (e.g. a rotated secret) is invisible — the recommendation is to log the HTTP
status or use systemd's journal; (2) **nothing in the product reads `joblock`**, so "is the
scheduler running?" is a database question. A minimal dashboard surface for the two lease rows
would close it, but is a separate decision (§14).

### IMPLEMENTATION CONSEQUENCES
**No application code change is required for any option** — the route, lease and jobs exist and are
tested. This decision is **deployment-only**, except for the optional observability addendum.

### TEST CONSEQUENCES
Already covered by Phase 15 (`__tests__/jobs/*`): authentication (absent / wrong / correct),
per-job isolation in both directions, lease overlap prevention, stale-lease takeover, and
lifecycle/reaper behaviour. Phase 20B needs no new tests for the mechanism itself; if an
observability surface is added, it needs authz + rendering tests.

**MIGRATION REQUIRED?** **NO** for any option. The optional lease-visibility surface needs no
schema change either (`readJobLocks()` already exists in `lib/jobs/lock.ts`).

**EXTERNAL DEPENDENCY?** Option A/B: none (host facilities). **Option C: an external service — an
explicit dependency decision.**

### FINAL OWNER DECISION
`____________________________________________`

---

## 12. D-I19-04 — Notification channel

**DECISION ID:** D-I19-04
**TITLE:** Whether the platform tells anyone anything, and through what

### CURRENT SOURCE BEHAVIOR (`SOURCE FACT`)

* **The schema exists and is ticket-aware.** `Notification`: `channel`, `recipient`,
  `idempotencyKey @unique`, `providerMessageId`, `payload`, `errorCode`, `errorMessage`,
  `retryCount`/`maxRetries`, plus nullable links to `eventOrder`, `ticket`, `event`, `organizer`,
  `picProfile`, a `recipientType`, a `category`, a `templateKey` and a `priority`.
  `NotificationDelivery`: one row per channel with `status`
  (`QUEUED`/`SENDING`/`SENT`/`FAILED`/`SKIPPED`), `attemptCount`/`maxAttempts`, `nextRetryAt`,
  `providerMessageId`, and a `(notificationId, channel)` unique.
* **The vocabulary already covers this phase's events.** `NotificationCategory` includes `REFUND`,
  `PAYMENT`, `TICKET`, `ORDER`, `CHECKIN`, `SYSTEM`; `NotificationRecipientType` includes
  `CUSTOMER`, `ADMIN`, `MANAGER`, `ORGANIZER_STAFF`; channels are `WHATSAPP`, `EMAIL`, `IN_APP`.
* **Nothing writes either table, and no provider client exists** (no mailer, SMS or WhatsApp
  client in `lib/`, `app/` or `package.json`). Every operator alert in the system today is a
  dashboard row a human must visit.

### WHY THIS MATTERS

Notifications are what turn the *visibility* decisions (`D-P19-01`, `D-P19-02`, `D-I19-01`,
`D-I19-02`) into *timely* ones, and they are the only way a buyer can be told about a refund
decision. They are also the single largest new scope in this phase: a channel means a provider, a
queue/retry policy, templating, and consent/opt-in questions.

### CLASSIFICATION

**BOTH product and infrastructure**, and it spans two audiences with different obligations:

| AUDIENCE | KIND | EXAMPLES | FAILURE IMPACT |
|---|---|---|---|
| Buyer | transactional | refund approved / processing / completed / failed; ticket issued; order paid | high — the buyer is waiting on money or entry |
| Staff | operational | stale refund; late settlement; PAID with no tickets; scheduler failure; webhook failure | medium — the dashboard already carries the same facts, so a missed alert degrades to today's behaviour |

### OPTIONS

#### OPTION A — Dashboard-only (status quo)
* **Behavior:** no messages; the dashboard is the channel.
* **Implementation impact:** none. **Operational impact:** unchanged.
* **Risk:** buyers learn nothing automatically. Acceptable while refund volume is manual and low;
  weak at scale.

#### OPTION B — In-app only (`IN_APP`)
* **Behavior:** rows in `Notification` with `channel = IN_APP`, rendered in the buyer's account.
* **Consequences:** no provider, no credentials, no external cost; uses only the existing schema.
  Reached only when the buyer opens the site, so it is a *record*, not an alert.
* **Implementation impact:** the first writer for `Notification`, a read surface for the buyer, and
  a delivery-status convention (`SENT` on write). No schema change — the enum value already exists.
* **Operational impact:** removes the "the buyer was never told" audit gap.
* **Risk:** low; does not solve time-sensitive chase.

#### OPTION C — EMAIL
* **Behavior:** transactional email through a configured provider.
* **Implementation impact:** provider selection + credentials + `NotificationDelivery` writes +
  retry on `nextRetryAt`; templating; bounce handling.
* **Operational impact:** reaches the buyer; adds deliverability operations.
* **Risk:** medium — new external dependency, new secret, new failure modes, and a retry policy
  that needs the very scheduler the platform is still installing (`D-I19-03`).

#### OPTION D — WHATSAPP
* **Behavior:** transactional WhatsApp (business API or a local gateway).
* **Implementation impact:** the heaviest — provider account, template approval, opt-in, per-message
  cost, and the same retry/scheduler dependency as email.
* **Operational impact:** highest reach in the target market.
* **Risk:** highest cost and compliance exposure; **`EXTERNAL PROVIDER RESEARCH REQUIRED`** — no
  provider has been evaluated in this repository.

### RECOMMENDED CONTRACT

**Recommendation for owner consideration — Option A now; Option B as the first step if any
notification work is authorized; C/D only after a provider decision.** Rationale: A is the status
quo and is *honest* (the dashboard already carries every fact); B requires **no schema change, no
provider, and no scheduler**, and it converts "no record that the buyer was told" into an auditable
one; C and D each introduce a provider, a secret, and a retry loop that depends on `D-I19-03` being
installed and monitored. **No provider is proposed and none may be assumed.**

### IMPLEMENTATION CONSEQUENCES
A = none. B = first writers for `Notification` (+`NotificationDelivery`), a buyer read surface, and
an idempotency convention per event using `Notification.idempotencyKey @unique` (which already gives
duplicate suppression). C/D = provider adapters + retry driven by the tick (a third job, or an
amendment to `P14-D10`).

### TEST CONSEQUENCES
B: idempotency (the same refund event twice ⇒ one notification), recipient resolution, tenant/user
isolation of the read surface, and that no message contains token material. C/D: provider failure
⇒ `FAILED` + retry scheduling, and no duplicate on retry.

**MIGRATION REQUIRED?** **NO for A and B** — the schema is complete. C/D = no schema change
expected (the delivery table already models retries), but a provider config surface may be added.

**EXTERNAL DEPENDENCY?** A/B = none. **C/D = a messaging provider (`EXTERNAL PROVIDER RESEARCH
REQUIRED`).**

### FINAL OWNER DECISION
`____________________________________________`

---

## 13. Cross-Decision Consistency

This section is mandatory and is the reason the decisions cannot be taken independently.

| PAIR | INTERACTION | CONTRADICTION IF… | RESOLUTION REQUIRED |
|---|---|---|---|
| **D-P19-01 × D-P19-02** | A stale-refund policy and an SLA are two answers to the same complaint. Option B of D-P19-01 (auto-expire) makes D-P19-02's *age* alert pointless for `PENDING` rows, while D-P19-02 Option C (buyer promise) makes expiry without notification a broken promise. | **YES:** D-P19-01 = B **and** D-P19-02 = C without a channel | Choose D-P19-01 A/C **or** pair D-P19-01 B with D-P19-02 A/B. Auto-expiry + a buyer-facing SLA promise + no notification is the one combination that must not ship. |
| **D-P19-03 × D-P19-05** | Both bound when the gate can be open. `startAt` supplies the lower bound (D-P19-03 B/C); `endAt` supplies the upper bound *and* completion. | **YES:** D-P19-05 = B (null `endAt` allowed indefinitely) **and** D-P19-03 = A (gate opens at publish) ⇒ a gate with **no lower and no upper bound at all** — a perpetually admissible ticket. | If both are answered A/B respectively, that combination should be flagged as accepted risk explicitly, or D-P19-05 should move to A/C. |
| **D-P19-04 × D-P17-09** | Cancellation does not auto-refund; a late settlement after cancellation is the case where money exists on a cancelled order. | Only if D-P19-04 chose Option B (auto-refund) — which would contradict `D-P17-09` **and** `P14-D16`. | Option B is out of contract; no conflict remains for A/C/D. |
| **D-P19-04 × D-P17-17** | `D-P17-17` locks "blocked/manual"; D-P19-04 defines what "manual" is. | **YES, definitionally:** if "manual" is defined as "operator may refund" (Option D) without amending `D-P17-17` in writing, the lock is silently rewritten. | The owner must record D-P19-04 = D as an **explicit amendment** to `D-P17-17` (which forbids re-fulfilment, not refund), and confirm that fulfilment stays blocked. |
| **D-I19-01 × D-P19-02** | Reconciliation and the SLA share one surface: the age of a `PROCESSING` refund. | **NO.** They compose: D-P19-02 sets the threshold and the flag; D-I19-01 decides whether anything beyond a flag is possible. | Implement as one change to `lib/dashboard/refunds.ts` if both are authorized; if D-I19-01 = C/D they differ (a job/import rather than a badge). |
| **D-I19-03 × event lifecycle** | `P14-D02`/`P14-D04` transitions are executed **only** by JOB 1. | **YES if the scheduler is not installed:** no event ever becomes `ONGOING` or `COMPLETED`, so `P14-D11`'s catalog behaviour (live `ONGOING` events) never activates and manual completion becomes the only path. | D-I19-03 is a **prerequisite** for the lifecycle contract to actually function; it must not be treated as optional polish. |
| **D-I19-03 × reservations** | `expireDueReservations` is executed **only** by JOB 2. | **YES if the scheduler is not installed:** held seats are never released; every abandoned checkout permanently consumes inventory until manually cancelled. | Same prerequisite, and this one is **customer-visible** (sold-out events with no sales). |
| **D-I19-03 × D-I19-04** | Any email/WhatsApp retry loop needs a periodic trigger. | **YES** if C/D is chosen as an outbound channel while the scheduler contract is uninstalled: `nextRetryAt` rows would never be retried. | Notification channel C/D depends on D-I19-03 being installed and monitored; B (in-app) does not. |
| **D-I19-02 × D-I19-01** | Both are "observability of the payment/refund boundary", but they are different objects (provider deliveries vs refund claims) and different permissions (`payment.reconcile` vs the refund actions). | **NO.** They must not be merged into one "ops console" that widens one permission to cover both. | Keep separate; if a single page is wanted, keep separate authorization per section. |
| **D-P19-03 × D-I19-03** | If D-P19-03 were implemented as `status === ONGOING` rather than `startAt <= now`, admission would depend on the scheduler. | **YES** — a cron outage at a venue would close the gate. | Constrain the implementation of D-P19-03 to a **stored-time** check; this is called out in §6 as a design requirement, not a preference. |
| **D-P19-05 × D-I19-03** | Option C (require `endAt` before the start) requires the lifecycle job to refuse to advance an event. | **YES:** a job-level exclusion changes the semantics of `P14-D02`'s automatic transition. | Prefer A (require at publish), which keeps the job's behaviour untouched. |

**Net consistency conclusion:** the only combinations that produce a genuine contradiction are
`(D-P19-01 = B) + (D-P19-02 = C) + (no channel)`, `(D-P19-03 = A) + (D-P19-05 = B)`, and any
notification-channel choice made without `D-I19-03`. Everything else composes.

---

## 14. Recommended Decision Set

**This is a recommendation for the owner's consideration. It is not a decision, and the §20 table
remains `UNDECIDED`.** No business *value* is proposed anywhere in this section; where a value is
required, it is marked `OWNER VALUE REQUIRED`.

| ID | Recommended option | Why | Value needed from owner? |
|---|---|---|---|
| `D-P19-01` | **A** (status quo), optionally followed by **C** (buyer withdrawal) | A costs nothing and is risk-free; C is the only non-timer fix that needs no notification to be honest | Only if C: whether withdrawal uses `REJECTED` (no migration) or a new `WITHDRAWN` status (migration) |
| `D-P19-02` | **B with a constant threshold, staff-facing, no new `Notification` writer** | Age display already exists; a constant needs no schema; a buyer promise is blocked by the channel | **`OWNER VALUE REQUIRED`:** the threshold (if any), the statuses it covers, and whether it is configurable |
| `D-P19-03` | **B**, implemented as `startAt <= now` (not a status check) | Agrees with the copy the product already ships; one condition; **does not make admission depend on the scheduler** | No — unless C is chosen, in which case the lead time is `OWNER VALUE REQUIRED` |
| `D-P19-04` | **A** now, **D** as the next decision | A is `D-P17-17` as written; D is the only in-product way to return money, but needs an explicit `D-R03` amendment and a bounded predicate | If D: whether buyers may also self-request (C) and the exact eligibility carve-out |
| `D-P19-05` | **A** (require `endAt` at publish) | Closes the permanent-live-event hole at the cheapest point; no job change; `endAt` stays editable through `ONGOING` | Confirm that an organizer must know an end time to publish |
| `D-I19-01` | **A** as the contract; **D** (statement import) as the only viable automation path | Automatic reconciliation is **blocked by evidence, not effort**; a bank reference alone is a claim | If D: the bank/statement source and who may import |
| `D-I19-02` | **B/C**, read-only, no payload bodies, no replay | Makes forged deliveries and replay attempts visible for the first time | **`OWNER VALUE REQUIRED`:** platform-scoped (`payment.reconcile`) vs tenant-scoped (`payment.read.tenant`), and how unmatched deliveries are shown |
| `D-I19-03` | **A (VPS cron)**, or **B (systemd timer)** on a systemd host | `.env.example` already documents A verbatim; B adds run-output capture | **`OWNER VALUE REQUIRED`:** the frequency (1/min documented) and the **deployment owner** |
| `D-I19-04` | **A** now; **B (in-app)** as the first step | B needs no provider, no scheduler, no schema | If C/D: the channel and the provider (external research required) |

**Minimum coherent bundle:** `D-I19-03` (otherwise two locked behaviours are inert), plus
`D-P19-03` and `D-P19-05` (the two externally visible admission rules), plus `D-P19-01`+`D-P19-02`
together if stale refunds are to be addressed at all. `D-I19-01`, `D-I19-02` and `D-I19-04` can be
deferred without breaking a locked contract.

---

## 15. Phase 20B Implementation Contract

Phase 20B becomes executable the moment §20 is filled in. Splits below are exhaustive.

### MUST IMPLEMENT — *conditional on the corresponding decision; empty until then*

**None.** No decision in §20 is taken, so Phase 20B has **no unconditional work**. Every candidate
below is gated.

### MAY IMPLEMENT — a candidate per decision, with its full obligation set

Each row becomes a MUST once the owner selects the option.

| Decision | Option | Source file / service | Route | Schema / migration | Authz & isolation | Transaction & idempotency | Tests | UI | Deployment |
|---|---|---|---|---|---|---|---|---|---|
| `D-P19-01` | A | — | — | none | — | — | — | — | — |
| `D-P19-01` | C | `lib/ticketing/refunds/service.ts` (`withdrawRefund`), reuse `releaseRefundClaims` | `POST /api/ticketing/refunds/[refundId]/withdraw` | none if `REJECTED`; enum + additive migration if `WITHDRAWN` | `refund.request.own` + ownership predicate + same-origin; **no** new permission key | one transaction: status CAS + claim release; idempotent replay | ownership, concurrent withdraw-vs-approve (one winner), claim released, gate unblocked, archive unblocked, audit row | buyer refund page action | none |
| `D-P19-01` | B (auto-expire) | new extent of `lib/jobs/*` | — | enum decision | owner recorded, since no buyer actor exists | CAS against `approveRefund`; third job = **`P14-D10` amendment** | boundary + race with approve | dashboard flag | **third job must be scheduled** |
| `D-P19-02` | B | `lib/dashboard/refunds.ts` | — | none with a constant; additive `PlatformSetting` if configurable | existing `order.read.tenant` scope unchanged | read-only | threshold boundary; settled rows never flagged | threshold badge in `app/dashboard/refunds/page.tsx` | none |
| `D-P19-03` | B | `lib/events/sales-state.ts#isEventCheckInOpen` | — | none | unchanged (`checkin.scan` + assignment) | pure predicate; **no** scheduler dependency | gate matrix around `startAt`; scheduler-independence; wallet scannable state | copy on the event page already matches | none |
| `D-P19-03` | C | same | — | additive if configurable | same | same | same + lead-time boundaries | may need a setting field | none |
| `D-P19-04` | A | — | — | none | — | — | — | — | — |
| `D-P19-04` | D | `lib/ticketing/refunds/eligibility.ts` + service + an operator path | reuses request/approve/process/settle | no schema change expected | **`D-R03` amendment**; SoD preserved (operator who requests cannot approve) | existing CAS discipline; balance predicate unchanged | late-settled order refundable; ordinary cancelled order **not**; quota untouched; no tickets; idempotent replay | "Perlu tindakan" deep-link into the refund flow | none |
| `D-P19-05` | A | `lib/events/service.ts#publishEvent` | — | none | unchanged (`event.publish`) | conditional update unchanged; only a new precondition | publish refused with null `endAt`; allowed with one; `endAt > startAt` intact; draft still savable | organizer form message | none |
| `D-I19-01` | A | — | — | none | — | — | — | — | — |
| `D-I19-01` | D (statement import) | new module | import + review surface | likely new tables | **new authorization decision** | import is read-only; settlement remains human-confirmed | exact reference+amount matching; ambiguity; no auto-`REFUNDED` | review screen | none |
| `D-I19-02` | B/C | new read model | `app/api/admin/webhooks/route.ts` or a dashboard page | none | `payment.reconcile` (platform) **or** `payment.read.tenant` + a platform view for unmatched; **no new key** | read-only; must not write audit rows | authz, cross-tenant, no payload/secret rendered, forgery filter | ledger page | none |
| `D-I19-03` | A/B | none (deployment) | — | none | secret handling only | unchanged | Phase 15 coverage stands | optional: expose `readJobLocks()` on the dashboard | **install the schedule; log the HTTP status** |
| `D-I19-04` | B (in-app) | first `Notification` writer | buyer read surface | none (enum values exist) | recipient/ownership predicate on reads | `Notification.idempotencyKey @unique` gives duplicate suppression | idempotency, recipient resolution, isolation, no token material | buyer notification list | none |
| `D-I19-04` | C/D | provider adapter + retry | — | none expected | provider credentials | retry driven by the tick | provider failure ⇒ `FAILED` + retry; no duplicate | templating | provider + scheduler monitoring |

### MUST NOT IMPLEMENT (regardless of any decision in this phase)

* Any automatic refund, automatic ticket issuance, automatic quota restoration, or automatic
  re-fulfilment of a terminal order (`P14-D16`, `D-P17-09`, `D-P17-17`, `D-P17-18`).
* Any write of `REFUNDED` without operator-recorded transfer evidence, or any operator-entered
  `confirmedAmount`.
* Any iPaymu refund API call (`D-P17-04`) or reuse of `PAYMENT_RECONCILE`/`verifyPaymentStatus` as
  refund reconciliation.
* Any change to `D-28`, `D-46`, `D-61`, `D-P17-05`, `D-P17-06`, `P14-D11`, `P14-D12`, `P14-D16`,
  `P14-D22`, `P14-D23`, or the 30-minute grace constant.
* Any new permission key, new role, or widening of tenant scope.
* Any camera scanner, second check-in path, or `QR_SCAN` activation.
* Any manual replay/retry of provider deliveries.
* Any data deletion: the legacy retail tables, `refund_backup_phase10b`, and the six legacy
  `refund` rows stay untouched.
* Any `git commit`, `push`, `reset`, `clean`, `prisma migrate reset`, or destructive migration.

### REQUIRES FUTURE DECISION

Deferred by construction: the automated refund rail / transfer provider (a fresh provider
evaluation); settlement/payout engine; ticket void/reissue; `PENDING_REVIEW`; coupons; the legacy
cleanup; a refund SLA *value*; the scheduler frequency value and deployment owner; the webhook
ledger's scope choice; `D-P19-04` Option D's eligibility carve-out.

---

## 16. Test Plan

Tests Phase 20B will need **if** the corresponding option is selected. Not written now.

| # | Area | Test |
|---|---|---|
| 1 | Stale refund handling | a `PENDING` refund older than the threshold is flagged (if `D-P19-02`=B); nothing changes rows |
| 2 | Refund claim release | withdrawing (or expiring) a refund releases the `RefundItem` claim: the ticket becomes requestable, gate-eligible, and archival unblocks |
| 3 | Withdraw/approve race | concurrent withdrawal and approval yield exactly one winner (real DB) |
| 4 | Gate timing | `isEventCheckInOpen` matrix around `startAt` for every status; `CANCELLED`/`ARCHIVED` always closed; `COMPLETED` open only in grace; null `endAt` follows the same `startAt` rule |
| 5 | Scheduler independence | gate state is identical whether or not any job has run |
| 6 | `endAt` validation | publish refused with null `endAt`; allowed when set; draft still savable; `endAt > startAt` preserved |
| 7 | Late-settlement workflow | refundable only when money is recorded and `fulfilmentBlockedAt` is set; an ordinary `CANCELLED` order stays refused; no ticket; quota untouched |
| 8 | Reconciliation | if D: exact reference+amount matching, ambiguity handling, and no automatic `REFUNDED` |
| 9 | Scheduler authentication | absent / wrong / correct secret; fails closed when unset; constant-time path unchanged |
| 10 | Scheduler lease | overlap prevention; stale-lease takeover; `lastRunAt`/`lastStatus` updated; a skipped run does not fake a run |
| 11 | Lifecycle tick | `PUBLISHED→ONGOING`, catch-up straight to `COMPLETED`, idempotent re-run, one audit row per real transition |
| 12 | Reservation tick | expiry claims the order before releasing seats; seats restored; idempotent |
| 13 | Notification | idempotency on replay; recipient resolution; isolation of the read surface; no token material in any message |
| 14 | Tenant isolation | every new surface: cross-tenant 404, unauthorized 403, buyer foreign resource 404, no client-supplied `organizerId` accepted |
| 15 | Retry/concurrency | every new mutation retried in parallel produces exactly one effect |
| 16 | Regression | the Phase 15/16/18B suites (jobs, lifecycle, check-in, refunds, wallet) must remain green — no test weakened or deleted |

---

## 17. Migration Risk

| Decision | Option | Schema impact |
|---|---|---|
| `D-P19-01` | A | none |
| `D-P19-01` | C | none if `REJECTED` reused; **enum addition** + additive migration if `WITHDRAWN` |
| `D-P19-01` | B | **enum addition** likely (`EXPIRED`-like state is not expressible without overloading) |
| `D-P19-02` | B | none with a constant; **additive `PlatformSetting` column** if configurable |
| `D-P19-03` | A/B | none |
| `D-P19-03` | C | none with a constant; **additive** if per-event/configurable |
| `D-P19-04` | A | none |
| `D-P19-04` | C/D | none expected (eligibility logic); additive marker column optional |
| `D-P19-05` | A/B/C | none |
| `D-I19-01` | A/B | none |
| `D-I19-01` | D | **new tables** (imported statements + matches) |
| `D-I19-02` | B/C | none |
| `D-I19-03` | A/B | none (deployment-only) |
| `D-I19-04` | A/B | none |
| `D-I19-04` | C/D | none expected |

**No migration is created in Phase 20A.** Every migration in the table is additive and no
`data migration` is required by any option: no existing row changes meaning under any recommended
contract. **Indexes:** none proposed; existing indexes already cover every query in this document
(`refund(organizerId,status,createdAt)`, `refund(status)`, `webhookevent(provider,receivedAt)`,
`webhookevent(processingStatus,receivedAt)`, `eventorder(status,expiresAt)`).

---

## 18. Deployment Requirements

| Requirement | Status | Detail |
|---|---|---|
| `JOBS_TICK_SECRET` configured | **REQUIRED** | Route fails closed when unset; `openssl rand -hex 32` per `.env.example` |
| A scheduler calling the tick route | **REQUIRED — MISSING** | `.env.example` documents the line; nothing installs it. Without it, event lifecycle and reservation expiry are inert |
| Run-output capture | **RECOMMENDED** | The documented cron line redirects to `/dev/null`, discarding even a `401`; systemd's journal or a logged status is strictly better |
| `maxDuration`/`runtime` on the tick route | **OPTIONAL** | Neither is declared; the default Node.js runtime is correct and was exercised successfully |
| Database reachable by the scheduler | **REQUIRED** | The tick reads/writes Prisma; the cron host must reach the DB (it calls the app over HTTP, so the app host suffices) |
| Secret rotation procedure | **OPEN** | A rotated secret silently breaks the schedule unless the HTTP status is monitored |
| Deployment target decision | **OPEN** | `README.md` says Vercel; the design presumes VPS cron. These must be reconciled before the schedule is real |
| Deployment owner | **OPEN** | Not stated anywhere in the repository |

---

## 19. Deferred Items

Carried from Phase 19 and unchanged by this phase: legacy retail cleanup (30 tables,
`refund_backup_phase10b`, six orphan `refund` rows) · settlement/payout engine ·
ticket void/reissue · ticket transfer · `PENDING_REVIEW` · coupons/discounts · fee-engine expansion
(`EARLY_ACCRUAL`, `PAYOUT`, `ADJUSTMENT`) · refund evidence **file** upload · bank-statement import
(until `D-I19-01`/D) · a `WebhookEvent` dead-letter view (until `D-I19-02`) ·
`__tests__/ticketing-payment/payment-races.integration.test.ts` load-sensitive flake ·
and the duplicated private `OPEN_REFUND_STATUSES` constant in `checkin/service.ts:73` and
`events/service.ts:1104` (cosmetic; both files are otherwise untouched, so a shared export would
be a deliberate small refactor for a later phase).

---

## 20. Final Decision Table

**Every Decision cell is `UNDECIDED`.** The owner has supplied no decision. Nothing in this
document may be read as a selection.

| ID | Question | Current Behavior | Decision | Status | Phase 20B Action |
|---|---|---|---|---|---|
| `D-P19-01` | What ends an undecided (`PENDING`/`APPROVED`) refund? | Persists indefinitely; withholds the ticket's claim, the gate, and event archival | **UNDECIDED** | OPEN — PRODUCT DECISION | BLOCKED |
| `D-P19-02` | Is there a refund SLA, and who is reminded? | `PROCESSING` age shown on the dashboard; explicitly not an SLA; no notification writers exist | **UNDECIDED** | OPEN — PRODUCT + INFRASTRUCTURE | BLOCKED |
| `D-P19-03` | May a ticket be admitted before `startAt`? | Yes — no `startAt` term in the gate predicate, while publish requires a future `startAt`; page copy says otherwise | **UNDECIDED** | OPEN — PRODUCT DECISION | BLOCKED |
| `D-P19-04` | What may an operator do with money on a terminal order? | Recorded, `fulfilmentBlockedAt` set, no tickets, no refund path, visible in "Perlu tindakan" | **UNDECIDED** | OPEN — PRODUCT DECISION | BLOCKED |
| `D-P19-05` | Must `endAt` exist before publish? | Optional at every stage; null ⇒ never completes, gate open indefinitely | **UNDECIDED** | OPEN — PRODUCT DECISION | BLOCKED |
| `D-I19-01` | How is a `PROCESSING` refund reconciled? | Dashboard/manual only; no automatic exit; `payment.reconcile`/`verifyPaymentStatus` are payment-shaped and unused | **UNDECIDED** | OPEN — INFRASTRUCTURE + PROVIDER CAPABILITY | BLOCKED |
| `D-I19-02` | Who sees provider deliveries, including refused ones? | `WebhookEvent` persisted (redacted payload, `signatureValid`) with no UI or API | **UNDECIDED** | OPEN — INFRASTRUCTURE + SCOPE DECISION | BLOCKED |
| `D-I19-03` | What drives the tick, how often, and who owns it? | Route + lease + two idempotent jobs complete and tested; **no scheduler installed**; cron line documented in `.env.example`; README says Vercel | **UNDECIDED** | OPEN — DEPLOYMENT DECISION | BLOCKED |
| `D-I19-04` | Does the platform notify anyone, and how? | Schema complete (`Notification`, `NotificationDelivery`, enums); zero writers; no provider client | **UNDECIDED** | OPEN — PRODUCT + INFRASTRUCTURE | BLOCKED |

---

## 21. Verification

Audit-only. Nothing was modified to make any check pass.

| Command | Result | Classification |
|---|---|---|
| `npx prisma validate` | *The schema at prisma/schema.prisma is valid 🚀* | pass |
| `npx prisma migrate status` | 22 migrations · *Database schema is up to date!* | pass — no schema change in this phase |
| `npx tsc --noEmit` | exit 0 | pass |
| `npx jest --runInBand` | **63 suites / 1365 tests passed** | pass — identical to the Phase 19 baseline |
| `npm run build` | *✓ Compiled successfully* | pass |
| `npx eslint .` | 0 errors / 5 warnings (`no-img-element`, pre-existing) | pass |

**Failures:** none. **Flakes:** none this run. **Regressions:** none (no code changed).
**Read-only database inspection** was used to confirm current row counts; no `UPDATE`, `DELETE`,
`INSERT`, `ALTER`, `DROP`, `TRUNCATE` or `migrate reset` was executed.

---

## 22. Worktree

* `git status --short` → **494** entries before writing this report (the Phase 19 end state,
  which was 493 + `PHASE_19_OPERATIONAL_HARDENING_AUDIT.md`); **495** after.
* Only one new file this phase: `PHASE_20A_OPERATIONAL_DECISION_LOCK.md`.
* No source, schema, migration, test, config or environment file modified; no data modified.
* No `git commit`, `push`, `reset`, `clean`; no destructive migration.

---

## 23. Final Verdict

**PHASE 20A BLOCKED — OWNER DECISIONS REQUIRED**

All nine open decisions were analysed against the live source, each with its current behaviour,
its existing locks, mutually exclusive options and their implementation/test/migration
consequences, and a recommended option marked explicitly as *not a decision*. §13 shows the
combinations that would contradict each other. §15 defines what Phase 20B may and may not do. The
§20 table records every decision as `UNDECIDED`, because the truthful state is that **no policy has
been chosen**, and Phase 20B cannot start without reopening one.

The single most consequential finding is not a product policy but a **fact**: `D-I19-03` has no
open *design* question left — the trigger, authentication, lease, idempotency and failure
handling are all implemented and tested — yet nothing in the repository proves the schedule exists,
and the repository's only stated deployment target (Vercel) contradicts the scheduler design.
Until that is installed, two locked behaviours (`P14-D02`/`P14-D04` lifecycle transitions and
reservation expiry) are inert, no matter which product decisions are made.
