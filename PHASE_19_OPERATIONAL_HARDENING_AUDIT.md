# PHASE 19 — OPERATIONAL HARDENING & RECONCILIATION AUDIT

**Project:** TinggalKlik.Co
**Mode:** AUDIT → DECISION LOCK → IMPLEMENT ONLY IF SAFE → VERIFY → REPORT
**Baseline:** Phase 18B (manual bank-transfer refund rail, whole-rupiah pricing, balance
protection, one-process rule, late-settlement and PAID/no-ticket visibility)

Every claim below cites **FILE**, **FUNCTION / ROUTE**, **ACTUAL BEHAVIOR** and
**TEST / EVIDENCE**, and every finding is classified as exactly one of:
`LOCKED` · `VERIFIED` · `OPEN PRODUCT DECISION` · `OPEN INFRASTRUCTURE DECISION` ·
`PROVIDER DEPENDENCY` · `DEFERRED` · `OUT OF SCOPE` · `IMPLEMENTED`.

**Method note:** source is authoritative over reports. Where this audit contradicts an earlier
report, the contradiction is stated explicitly (§2.2) rather than inherited.

---

## 1. Executive Summary

**No mechanical integrity bug that violates a locked contract was found.** Phase 19 therefore
made **no code changes and no schema changes** — the correct outcome of an audit-first phase.

The operational picture is: every financial transition is a compare-and-swap or a database
constraint, every money movement is reconstructable from append-only rows, and every state that
can persist indefinitely has a documented owner — **except four, which are genuinely the product
owner's to decide** (§23) and three infrastructure items (§24).

The four substantive operational findings:

1. **An abandoned refund withholds three things at once.** A `PENDING`/`APPROVED` refund keeps its
   `RefundItem` claim, which (a) blocks that ticket from ever being re-requested
   (`RefundItem.ticketId @unique`), (b) blocks that ticket at the gate (`REFUND_PENDING`), and
   (c) blocks the whole event from being archived (archive refuses while any open refund exists).
   This is the exact consequence of three *locked* decisions (D-R10, D-28, Phase 12 archive
   precondition) — not a defect — but it means one neglected request row can stall an event's
   archival. → **OPEN PRODUCT DECISION D-P19-01.**
2. **The gate opens as soon as an event is `PUBLISHED`, not at `startAt`.** `isEventCheckInOpen`
   has no `startAt` check, so a ticket for an event next month is admitted today. That is what the
   Phase 14 lock specifies; it is recorded here as an operational risk to confirm or correct.
   → **OPEN PRODUCT DECISION D-P19-03.**
3. **`endAt IS NULL` events keep the gate open forever and can never complete.** Locked by
   P14-D22, and now visible as a concrete consequence. → **OPEN PRODUCT DECISION D-P19-05.**
4. **A `PROCESSING` refund has no automatic way out, and no provider can help.** Manual rail by
   decision; `PAYMENT_RECONCILE` (permission) and `verifyPaymentStatus()` (function) both exist
   with **zero consumers** and are payment-shaped, not refund-shaped. → **OPEN INFRASTRUCTURE
   DECISION D-I19-01**, with the stale-refund SLA as **OPEN PRODUCT DECISION D-P19-02**.

Live data confirms the machinery is not silently leaking: there are **no** stuck ticketing
financial states (§15) — the only long-lived rows are six **legacy retail refund rows** with no
order, no organizer and no claim, which no ticketing read path can reach.

---

## 2. Phase 18B Baseline

### 2.1 Baseline verification (run for this phase)

| Command | Result |
|---|---|
| `npx prisma validate` | *The schema at prisma/schema.prisma is valid* |
| `npx prisma migrate status` | 22 migrations · *Database schema is up to date!* |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx jest --runInBand` | **63 suites / 1365 tests passed** |
| `npm run build` | *✓ Compiled successfully* |
| `npx eslint .` | **0 errors / 5 warnings** (`no-img-element`, pre-existing) |
| `git status --short` | 493 entries (unchanged from the Phase 18B end state) |

### 2.2 One correction to the Phase 18B report

Phase 18B §12 stated that the live database held "one pre-existing `PROCESSING` refund … [which]
legitimately holds its order's single in-flight slot". **That claim is wrong**, and source/data
correct it here:

* **EVIDENCE (read-only):** all 6 rows in `refund` have `refundNumber IS NULL`, `eventOrderId IS
  NULL`, `organizerId IS NULL`, `confirmedAmount = 0`; `refunditem` has 0 rows. `refund_backup_phase10b`
  holds the same 6 rows.
* **INTERPRETATION:** these are **legacy retail refund rows** (the ticketing `Refund` model reuses
  the legacy `Int` PK — see the schema comment at `prisma/schema.prisma:1592`), not ticketing
  refunds. They hold **no** order slot: `D-P17-06`'s in-flight count is keyed by `eventOrderId`,
  and `NULL` matches nothing.
* **CONSEQUENCE:** the archived-`PROCESSING` claim in Phase 18B is withdrawn. Nothing about the
  Phase 18B *implementation* changes; only that sentence was inaccurate. Reported, not modified.

---

## 3. State Machine Matrix

Sources: `prisma/schema.prisma` enums; `lib/ticketing/{checkout,orders,reservations,inventory,
payment/settlement,payment/void,payment/webhook,refunds/*,tickets/issuance,checkin/service,
audit-log}.ts`; `lib/events/{service,lifecycle,sales-state,catalog}.ts`; `lib/jobs/{tick,lock}.ts`.

**EVENT** (`EventStatus`)

| STATE | NEXT STATES | ACTOR | RETRY SAFE | TERMINAL |
|---|---|---|---|---|
| `DRAFT` | `PUBLISHED`; `ARCHIVED` | organizer (`event.publish`) / `event.archive` | yes — CAS | no |
| `PENDING_REVIEW` | *(no writer, no transition)* | — | — | **unreachable** |
| `PUBLISHED` | `ONGOING` (auto), `COMPLETED` (auto), `CANCELLED`, `ARCHIVED`, → back to `DRAFT`?? **no** — unpublish is `PUBLISHED → DRAFT` | tick / `event.publish` / `event.cancel` / `event.archive` | yes — CAS | no |
| `ONGOING` | `COMPLETED` (auto or manual), `CANCELLED`, `ARCHIVED` | tick / `event.publish` / `event.cancel` / `event.archive` | yes — CAS | no |
| `COMPLETED` | `ARCHIVED` | `event.archive` | yes — CAS | no (not terminal) |
| `CANCELLED` | `ARCHIVED` | `event.archive` | yes — CAS | no |
| `ARCHIVED` | *(none)* | — | — | **TERMINAL** |

* `FILE` `lib/events/service.ts` · `publishEvent` (`:905` region), `cancelEvent` (`:1202`),
  `archiveEvent` (`:1404`) — each is a conditional `updateMany` + `count !== 1` → conflict.
* `FILE` `lib/events/lifecycle.ts` · `advanceEventLifecycleBatch` — `PUBLISHED → ONGOING` and
  `{PUBLISHED,ONGOING} → COMPLETED`, both conditional.
* `TEST` `__tests__/events/{event-service,lifecycle-automation,lifecycle-integration}.integration.test.ts`.

**ORDER** (`OrderStatus`)

| STATE | NEXT STATES | ACTOR | RETRY SAFE | TERMINAL |
|---|---|---|---|---|
| `PENDING_PAYMENT` | `PAID` (settlement), `CANCELLED` (buyer cancel), `EXPIRED` (reaper) | provider webhook / buyer / tick JOB 2 | yes — conditional `updateMany` | no |
| `PAID` | `PARTIALLY_REFUNDED`, `REFUNDED` | refund settlement | yes — CAS | no |
| `PARTIALLY_REFUNDED` | `PARTIALLY_REFUNDED`, `REFUNDED` | refund settlement | yes | no |
| `REFUNDED` | *(none)* | — | — | **TERMINAL** (commercial) |
| `CANCELLED` | *(none)* — may still carry `paymentStatus = PAID` (late settlement) | — | — | **TERMINAL** |
| `EXPIRED` | *(none)* — same late-settlement caveat | — | — | **TERMINAL** |

* `FILE` `lib/ticketing/reservations.ts#expireDueReservations` — claims `PENDING_PAYMENT → EXPIRED`
  **before** releasing seats (Phase 7 ordering fix), so an order can never be `PAID` with zero
  seats sold.
* `FILE` `lib/ticketing/orders.ts#cancelOwnPendingOrder` — order row claimed first, then
  reservations, then `voidOpenPayments`.
* Anti-resurrection: `CANCELLED/EXPIRED → PAID` is not implemented anywhere
  (`lib/ticketing/payment/settlement.ts` records money and blocks fulfilment instead).

**PAYMENT** (`PaymentStatus`) + **PaymentTransaction**

| STATE | NEXT STATES | ACTOR | RETRY SAFE | TERMINAL |
|---|---|---|---|---|
| `UNPAID` | `PENDING` | pay route | yes (claim row + `IdempotencyKey`) | no |
| `PENDING` | `PAID` (settle), `FAILED` (provider verdict), `EXPIRED` (cancel/reaper void) | webhook / cancel / reaper | yes — conditional `updateMany` | no |
| `PAID` | `REFUNDED`, `PARTIALLY_REFUNDED` | refund settlement | yes — CAS | no |
| `FAILED` | *(none)* | — | — | **TERMINAL** |
| `EXPIRED` | *(none)* | — | — | **TERMINAL** |
| `REFUNDED` / `PARTIALLY_REFUNDED` | `REFUNDED` | refund settlement | yes | `REFUNDED` terminal |

* `FILE` `lib/ticketing/payment/void.ts#voidOpenPayments` — moves only `UNPAID`/`PENDING` to
  `EXPIRED`; a `PAID` attempt is never downgraded. Called by cancel, the reaper and event cancel.
* `FILE` `lib/ticketing/payment/settlement.ts` — appends `PaymentTransaction(type=PAYMENT)` in the
  same transaction as the order CAS.

**REFUND** (`RefundStatus`)

| STATE | NEXT STATES | ACTOR | RETRY SAFE | TERMINAL |
|---|---|---|---|---|
| `PENDING` | `APPROVED`, `REJECTED` | staff (`refund.approve`), SoD | yes — CAS | no |
| `APPROVED` | `PROCESSING` | staff (`refund.execute`) | yes — CAS + order lock | no |
| `PROCESSING` | `REFUNDED` (evidence required), `FAILED` | staff (`refund.settle` / `refund.fail`) | yes — CAS | no |
| `REFUNDED` | *(none)* | — | — | **TERMINAL** |
| `FAILED` | *(none)* — claims released, a NEW request is the recovery | — | — | **TERMINAL** |
| `REJECTED` | *(none)* — claims released | — | — | **TERMINAL** |

* `FILE` `lib/ticketing/refunds/service.ts` (`requestRefund`, `approveRefund`, `rejectRefund`,
  `executeRefund`, `settleRefund`, `failRefund`), `lib/ticketing/refunds/settlement.ts`
  (`processConfirmedRefund`, `processFailedRefund`).
* `TEST` `__tests__/ticketing-refunds/{refund-lifecycle,refund-manual-rail}.integration.test.ts`.

**TICKET** (`TicketStatus`)

| STATE | NEXT STATES | ACTOR | RETRY SAFE | TERMINAL |
|---|---|---|---|---|
| `RESERVED` | *(no writer)* | — | — | **unreachable** |
| `ISSUED` | `CHECKED_IN`, `REFUNDED` | gate / refund settlement | yes — CAS (`WHERE status='ISSUED'`) | no |
| `CHECKED_IN` | *(none)* | — | — | **TERMINAL** |
| `REFUNDED` | *(none)* | — | — | **TERMINAL** |
| `VOID` | *(no writer)* | — | — | **READ-ONLY / DEFERRED** |

* `FILE` `lib/ticketing/checkin/service.ts:440` — `updateMany({ where: { status: "ISSUED" } })`.
* `FILE` `lib/ticketing/refunds/settlement.ts` — `WHERE status='ISSUED' AND refundedAt IS NULL AND
  checkedInAt IS NULL`.
* **`VOID` has no writer** — the only `status: "VOID"` write in the codebase is on
  `PICFeeLedger` (`lib/ticketing/refunds/settlement.ts:467`, i.e. `PICFeeStatus.VOID`), not on
  `Ticket`; `lib/ticketing/tickets/payload.ts:265` and `lib/ticketing/tickets/validation.ts:38`
  only *read* `TicketStatus.VOID` defensively. A repository-wide search for a `Ticket` write to
  `VOID` returns nothing. So "void a ticket" is a **DEFERRED** capability, not a reachable state.

**CHECK-IN** (`CheckInResult` / `CheckIn` rows)

| OUTCOME | MEANING | WRITTEN WHEN |
|---|---|---|
| `SUCCESS` | admitted; `Ticket.checkedInAt` set in the same transaction | `lib/ticketing/checkin/service.ts` |
| `DUPLICATE` | the same ticket re-scanned after a successful admission | ditto (append-only evidence) |
| `ALREADY_CHECKED_IN`, `INVALID_TICKET`, `WRONG_EVENT`, `UNPAID`, `TICKET_NOT_FOUND`, `REFUND_PENDING` | refusals, each also written as a `CheckIn` row and a `checkin.rejected` audit | ditto |

* `CheckIn.ticketId` is **UNIQUE** (§16) — one admission row per ticket is a database property.
* Terminal: a ticket is admitted **at most once**; there is no undo/re-entry (Phase 14 P14-D14,
  `LOCKED`).

**PIC FEE** (`PICFeeEntryType` / `PICFeeStatus` / `LedgerDirection`)

| ENTRY | WRITER | TERMINAL |
|---|---|---|
| `EARNED` (CREDIT, `EARNED`) | Phase 9 fee posting | no |
| `REVERSAL` (DEBIT, `VOID`, `adjustmentReason = REFUND`) | `lib/ticketing/refunds/settlement.ts#reversePicFeesForRefund` | **yes per (orderItemId, type)** — `@unique` |
| `EARLY_ACCRUAL`, `EARNED_ADJUSTMENT`, `PAYOUT`, `ADJUSTMENT` | **no writers** | `OUT OF SCOPE` (no fee-settlement engine) |

**RESERVATION** (`TicketReservationStatus`)

| STATE | NEXT STATES | ACTOR | RETRY SAFE | TERMINAL |
|---|---|---|---|---|
| `HELD` | `CONVERTED`, `RELEASED`, `EXPIRED` | settlement / cancel / reaper | yes — `WHERE status='HELD'` CAS | no |
| `CONVERTED` | *(none)* | — | — | **TERMINAL** |
| `RELEASED` | *(none)* | — | — | **TERMINAL** |
| `EXPIRED` | *(none)* | — | — | **TERMINAL** |

`lib/ticketing/reservations.ts:78` — `TERMINAL_RESERVATION_STATUSES = [CONVERTED, RELEASED, EXPIRED]`.

---

## 4. Stuck State Audit

For every state that can persist indefinitely: **(1)** intentional? **(2)** owner? **(3)** how
found? **(4)** resolving action? **(5)** safe? **(6)** can it race? **(7)** observable?

| STATE | 1 INTENTIONAL | 2 OWNER | 3 FOUND VIA | 4 RESOLVED BY | 5 SAFE | 6 RACE | 7 OBSERVABLE |
|---|---|---|---|---|---|---|---|
| `Refund.PENDING` | yes (needs a decision) | staff | `/dashboard/refunds` (all statuses listed) | approve or reject | yes | reject/approve CAS | **yes** — status, amount, order, buyer |
| `Refund.APPROVED` | yes | staff | same | execute (`APPROVED → PROCESSING`) | yes | CAS + order lock | **yes** |
| `Refund.PROCESSING` | yes — one-in-flight by decision | staff | same + **processing age** | record transfer (settle) or fail | yes | CAS; balance predicate | **yes** |
| `Refund.FAILED` | terminal, claims released | — | same | new request | — | — | **yes** |
| `Order.PENDING_PAYMENT` | **no — self-resolving** | tick JOB 2 | orders list | reservation TTL elapse → `EXPIRED` | yes | claim-before-release | yes |
| `Order.PAID` + 0 tickets | yes — issuance is buyer-triggered | buyer / staff (visibility) | orders **Perlu tindakan** | buyer issues | yes | unique `(orderItemId, sequenceNo)` | **yes** |
| `Order` + `fulfilmentBlockedAt` | yes — money in, fulfilment blocked | staff | orders **Perlu tindakan** | **none shipped** | — | — | **yes** (§23 D-P19-04) |
| `Payment.PENDING` | **no — self-resolving** | reaper / cancel | payments list (expiry column) | voided to `EXPIRED` when the order dies | yes | conditional `updateMany` | yes |
| `WebhookEvent.RECEIVED` | transient | — | **DB only** | advance on the same delivery | — | guarded `updateMany` | **no UI** (§24 D-I19-02) |
| `WebhookEvent.FAILED` | yes — retryable by design | provider retry | **DB only** | provider re-delivery | yes | `processingStatus != PROCESSED` guard | **no UI** |
| `Event.PUBLISHED` (future `startAt`) | **yes — gate open by lock** | — | events list | nothing needed (sales window governs) | — | — | yes |
| `Event` with `endAt IS NULL` | yes (P14-D22) | organizer | events list | cancel or archive | yes | CAS | yes |
| `Event.ONGOING` → `COMPLETED` | **no — self-resolving** | tick JOB 1 | events list | automatic at `endAt+30m`, or manual | yes | CAS, catch-up | yes |
| `Event.COMPLETED`/`CANCELLED` | yes — awaiting archival | organizer | events list | archive | yes | archive CAS + open-refund precondition | yes |
| `Ticket.CHECKED_IN` | terminal by design | — | gate log/introspection | none (no undo) | — | — | yes |
| `Reservation.HELD` | **no — TTL-bound** | tick JOB 2 | no UI surface | reaped at `expiresAt` | yes | CAS | no (not required) |

### 4.1 The one state where "stuck" has a cascade — `Refund.PENDING`/`APPROVED`

**FILE** `lib/ticketing/checkin/service.ts:429` · **FUNCTION** `checkInTicket` open-refund guard ·
**BEHAVIOR:** any `RefundItem` whose parent refund is in `["PENDING","APPROVED","PROCESSING"]`
makes the gate refuse with `REFUND_PENDING`.

**FILE** `lib/ticketing/refunds/eligibility.ts:206` · **BEHAVIOR:** an existing `RefundItem` blocks
a second claim for that ticket forever (`TICKET_ALREADY_REFUNDED`), backed by
`RefundItem.ticketId @unique`.

**FILE** `lib/events/service.ts:1388` · **FUNCTION** `archiveEvent` · **BEHAVIOR:** archival is
**refused** while any open refund exists for the event
(`AppError.conflict("Event tidak dapat diarsipkan selama masih ada refund yang belum selesai.")`).

**CLASSIFICATION:** `VERIFIED` — all three are the direct, correct consequence of `LOCKED`
decisions (D-R10 one-claim-per-ticket, D-28 open-refund-blocks-gate, Phase 12's archive
precondition). **The residual question is a policy question, not a defect:**
→ §23 **D-P19-01**.

---

## 5. Payment Reconciliation

| QUESTION | ANSWER | EVIDENCE |
|---|---|---|
| **A. Can a valid provider payment become invisible?** | No, but a **rejected/forged** delivery is recorded and not shown in any UI. A valid payment always leaves a `WebhookEvent` row + (when settling) a `PaymentTransaction`. | `lib/ticketing/payment/webhook.ts` (insert-first ledger); `WebhookEvent` unpinned in `lib/dashboard/**` |
| **B. Can the same provider payment settle twice?** | No. `WebhookEvent.providerEventId` is `@unique`, and only a `PROCESSED` row blocks a later verified delivery. | unique index §16; `blocksReprocessing()` |
| **C. Can a payment settle against the wrong order?** | No. The target is resolved by `Payment.paymentReference` (`@unique`) that we ourselves sent, plus an `EVT-` namespace check. | `resolveTicketingTarget` |
| **D. Can an order become `PAID` without a valid payment record?** | No settlement path exists without a resolved `Payment` row; the ledger row records the delivery. | `settleVerifiedPayment` is only reachable from the webhook, post-signature |
| **E. Can a valid payment exist without fulfilment?** | Yes, by design: `LATE_SETTLEMENT` (money recorded, `fulfilmentBlockedAt` set, no tickets) and `PAID` + zero tickets (buyer-triggered issuance). | `lib/ticketing/payment/settlement.ts:95,353`; `assertOrderIsFulfillable` |
| **F. Can a late payment be distinguished from normal settlement?** | Yes. Distinct outcome, distinct ledger `processingResult`, `fulfilmentBlockedAt` timestamp, `LATE_SETTLEMENT_AFTER_TERMINAL_STATE` audit. | `settlement.ts:513-533` |
| **G. Can an operator find the situation?** | Yes for late settlement and PAID/no-tickets (orders "Perlu tindakan"). **No** for the webhook ledger itself. | `lib/dashboard/orders.ts#needsReview`; §24 D-I19-02 |
| **H. Is there a safe remediation?** | **None shipped.** No code path returns the money or restores fulfilment. | `OPEN PRODUCT DECISION` → §23 D-P19-04 |

**Provider polling is not implemented and must not be added without a decision:** `PAYMENT_RECONCILE`
exists as a permission with **zero consumers** (`lib/authz/permissions.ts:141`) and
`verifyPaymentStatus()` exists in `lib/payment/ipaymu.ts:1283` with **zero callers** — by design:
`lib/ticketing/payment/webhook.ts:87` states *"A server-side status poll is not a settlement
trigger."* `LOCKED` (Phase 15/17) → §24 D-I19-01.

---

## 6. Refund Reconciliation

**VERIFIED** — every requirement of the manual rail is present in source:

| REQUIREMENT | FILE · FUNCTION | BEHAVIOR |
|---|---|---|
| lifecycle `PENDING→APPROVED→PROCESSING→REFUNDED/FAILED`, `PENDING→REJECTED` | `lib/ticketing/refunds/service.ts` | six functions, each CAS-guarded |
| evidence required | `settleRefund` + `refunds/validation.ts#refundSettleSchema` | `transferRef` required (`min(3).max(120)`), strict schema |
| transfer reference | `settlement.ts#processConfirmedRefund` | persisted on `Refund.providerRef` |
| processed by / at | `requestRefund`→`settleRefund` | `processedByUserId` (execute), `completedAt` (settle), server clock |
| confirmed amount | `settleRefund` | `moneyString(Σ RefundItem.amount)` — **never** from the body |
| evidence note | `processConfirmedRefund` | `Refund.evidenceNote` (Phase 18B additive column) |
| failure reason | `processFailedRefund` | `Refund.failureReason` from the operator's `reason` |
| SoD | all five staff edges | `requestedByUserId === actor.userId` → `FORBIDDEN` |
| tenant isolation | `requireOrganizerAccess(refund.organizerId, REFUND_*)` | resource-derived, 404/403 |
| one `PROCESSING`/order | `executeRefund` | `eventorder … FOR UPDATE` + in-flight count + CAS |
| balance protection | `processConfirmedRefund` | conditional `updateMany` (`refundedAmount ≤ total − amount`) |
| duplicate settlement | `processConfirmedRefund` | `PROCESSING → REFUNDED` CAS; replay → `ALREADY_REFUNDED` |
| retry | `withContentionRetry` | re-runs the whole transaction, guards re-evaluated |

**Can `PROCESSING` remain forever?** **Yes — and that is intentional.** Nothing transitions it
automatically; only an operator can, and only with evidence. There is no SLA, no reminder, no job.
`TEST` `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts`.

**Is the dashboard sufficient?** It is sufficient to *see and resolve* every state
(`/dashboard/refunds` lists all six statuses, shows the reference/evidence/age and offers the
actions). It is **not** a reminder system, a bank-statement reconciler, or an SLA tracker.
Classification: **OPERATOR-SURFACE SUFFICIENT (VERIFIED)**; reminder / statement-import /
reconciliation-job / SLA are `OPEN` (§23 D-P19-02, §24 D-I19-01, §26).

---

## 7. Refund Balance Integrity

Each invariant verified directly in source, with its enforcement layer:

| INVARIANT | ENFORCED BY | EVIDENCE | CLASS |
|---|---|---|---|
| confirmed refund amount ≤ refundable amount | **database predicate (B)** inside the transaction | `settlement.ts` conditional `updateMany` + `REFUNDABLE_BALANCE_EXCEEDED` | `VERIFIED` |
| per-line amount ≤ ticket/order-item refundable | **application (C)**, same predicate as above | `eligibility.ts#evaluateRefundEligibility` (D-R09) | `VERIFIED` |
| no ticket refunded twice | **database (A)** | `refunditem.ticketId` UNIQUE; `eligibility` pre-check for the friendly error | `VERIFIED` |
| no refund after `CHECKED_IN` | **transaction (B)** | `Ticket CAS: status='ISSUED' AND checkedInAt IS NULL AND refundedAt IS NULL` | `VERIFIED` |
| no refund after invalid order state | **transaction (B)** | `order.status ∈ {PAID, PARTIALLY_REFUNDED}` else `SETTLEMENT_STATE_INVALID` | `VERIFIED` |
| no duplicate PIC reversal | **database (A)** | `picfeeledger.(orderItemId, type)` UNIQUE + `idempotencyKey` UNIQUE + code pre-check | `VERIFIED` |
| no duplicate `PaymentTransaction(REFUND)` | **transaction (B)** | created inside the same transaction as the one-shot CAS to `REFUNDED` | `VERIFIED` |
| no duplicate quota restoration | **transaction (B)** | `restoreSoldQuota` called only after the CAS succeeded; `GREATEST(0, …)` clamp | `VERIFIED` |

**No application-level "check-then-update" race remains on a money path.** The two patterns that
*look* like check-then-update are both safe by ordering: `eligibility` reads are re-verified under
locks inside the writing transaction, and the reaper claims the order row **before** releasing
seats.

---

## 8. Ticket Issuance

| CHECK | EVIDENCE | CLASS |
|---|---|---|
| buyer-triggered only | `app/api/ticketing/orders/[orderNumber]/issue/route.ts`; nothing in settlement issues tickets | `LOCKED` / `VERIFIED` |
| ownership | `lib/ticketing/orders.ts` resolves the order by `userId` predicate; foreign order → 404 | `VERIFIED` |
| idempotency | `outcome: "ISSUED" \| "ALREADY_ISSUED"`; second call creates 0 rows | `VERIFIED` |
| duplicate issuance | `ticket.(orderItemId, sequenceNo)` UNIQUE is the arbiter; `ticketCode`/`qrTokenHash` UNIQUE with bounded retry | `VERIFIED` |
| concurrent issuance | same unique constraint + `P2002` classification; `TEST` `__tests__/ticketing-issuance/*` | `VERIFIED` |
| ticket code uniqueness | `ticket.ticketCode` UNIQUE | `VERIFIED` |
| QR payload | `TICKET:<ticketCode>` (`lib/ticketing/tickets/reference.ts#buildTicketQrPayload`) | `LOCKED` (D-46) |
| raw token secrecy | minted → SHA-256 → `qrTokenHash` (write-only); never returned/rendered/logged (Phase 16 repo-wide search) | `VERIFIED` |
| quantity | `expectedTickets = Σ EventOrderItem.quantity`; `(orderItemId, sequenceNo)` bounds it | `VERIFIED` |
| max per order | `maxTicketsPerOrder` enforced at checkout | `VERIFIED` |
| refund interaction | a `REFUNDED` ticket is never re-issued (issuance only creates the missing rows for an order) | `VERIFIED` |
| check-in interaction | issuance never touches `CHECKED_IN` tickets | `VERIFIED` |

**PAID + zero tickets:** exists, is recoverable, and is **visible** on the orders worklist;
issuance remains buyer-triggered. `TEST`
`__tests__/ticketing-refunds/refund-reconciliation-visibility.integration.test.ts`.
**IMPLEMENTED (Phase 18B) / VERIFIED.** No automatic issuance was added and none is proposed.

---

## 9. Check-in

`ISSUED → CHECKED_IN` — `lib/ticketing/checkin/service.ts`.

| GUARD | BEHAVIOR | CLASS |
|---|---|---|
| event clock + 30-minute grace | `lib/events/sales-state.ts#isEventCheckInOpen(event, now)`; the ONE canonical predicate, reused by the gate and the wallet's "scannable" verdict | `LOCKED` (P14-D06) |
| event lifecycle | `CHECKIN_OPEN_STATUSES = [PUBLISHED, ONGOING, COMPLETED]`; `COMPLETED` open only inside grace | `LOCKED` |
| `cancelledAt` / `archivedAt` | fail closed before any status check | `LOCKED` |
| refunded / void ticket | admission CAS requires `status = 'ISSUED'` | `VERIFIED` |
| already checked in | CAS fails → `ALREADY_CHECKED_IN` (or `DUPLICATE` for the same ticket) | `VERIFIED` |
| refund pending | open-refund guard inside the transaction, after a `FOR UPDATE` on the ticket row → `REFUND_PENDING` | `LOCKED` (D-28) |
| tenant / event match | ticket's `eventId` must equal the route's event; mismatch → `WRONG_EVENT` **before** any refund disclosure | `VERIFIED` |
| staff assignment + permission | `checkin.scan` + `StaffEventAssignment` scope; PIC and Finance have no gate permission | `LOCKED` (Phase 13/14) |
| **`startAt` (early admission)** | **not checked** — a `PUBLISHED` event's gate is open from publication | `OPEN PRODUCT DECISION` → §23 D-P19-03 |

**Concurrency:** check-in vs refund serialize on the ticket row `FOR UPDATE` taken by *both*
writers; concurrent duplicate check-ins lose the CAS and the loser records `DUPLICATE`;
`CheckIn.ticketId` is UNIQUE. `TEST` `__tests__/ticketing-checkin/{check-in,
check-in-refund-gate,check-in-wiring}.integration.test.ts` (+ the Phase 18B rewrites).
**No ticket can reach an impossible combination** (`CHECKED_IN`+refund claim, or
`REFUNDED`+`checkedInAt`) — both are excluded by the two CAS predicates.

---

## 10. Event Lifecycle

| ITEM | EVIDENCE | CLASS |
|---|---|---|
| `PUBLISHED → ONGOING` at `startAt` | `lib/events/lifecycle.ts#advanceEventLifecycleBatch` STEP 1 (conditional, `archivedAt/cancelledAt IS NULL`) | `LOCKED` (P14-D02) |
| `→ COMPLETED` at `endAt + 30m` | STEP 2, `status IN (PUBLISHED, ONGOING)`, **catch-up allowed** (a long-past event completes directly) | `LOCKED` (P14-D04) |
| 30-minute grace constant | `CHECK_IN_GRACE_MINUTES = 30` — one constant, no duplicates (`grep` verified) | `LOCKED` (P14-D06) |
| manual completion | `completeEventManually` + `mayCompleteManually` (`event.publish`, non-null `endAt`, `now ≥ endAt`) | `LOCKED` (P14-D05) |
| `endAt IS NULL` | never completes, automatically or manually; remains live until cancel/archive | `LOCKED` (P14-D22) |
| `PUBLISHED/ONGOING → CANCELLED` | `cancelEvent`: expires unpaid orders, voids open payments, leaves paid orders/tickets alone, no refund rows | `LOCKED` (Phase 12 / D-P17-09) |
| archive | `ARCHIVED`, terminal, CSP `archivedAt IS NULL`, refuses while an open refund exists | `LOCKED` (Phase 12 + precondition) |
| publish | `DRAFT` only; `unpublish` `PUBLISHED` only | `LOCKED` (P14-D23) |
| edit freezes | `startAt` frozen at `ONGOING`; `endAt` editable through `ONGOING`, rejected at `COMPLETED`; no reopen | `LOCKED` (P14-D12) |
| `COMPLETED` sales | `isEventPurchasable` excludes `COMPLETED`, includes `ONGOING` | `LOCKED` (P14-D11) |
| catalog visibility | `publicVisibilityWhere` includes `PUBLISHED`+`ONGOING`; excludes `COMPLETED`/`CANCELLED`/`ARCHIVED` | `LOCKED` |

**Lifecycle states with no exit:** none — every non-`ARCHIVED` state has at least one transition,
and `ARCHIVED` is the deliberate terminal. Two lifetimes are unbounded **by decision**:
an uncompleted `PUBLISHED` event with `endAt IS NULL` (gate open indefinitely — §23 D-P19-05), and
a `COMPLETED`/`CANCELLED` event awaiting manual archival. No semantics were altered.

---

## 11. Scheduler / Jobs

| JOB | TRIGGER | LEASE | LOCK | WORK | RETRY | FAILURE | OBSERVABILITY |
|---|---|---|---|---|---|---|---|
| JOB 1 event-lifecycle | `POST /api/internal/jobs/tick` | `joblock` row, 5-min lease | conditional `UPDATE` claim, stale leases takeover-able | `advanceEventLifecycleBatch({ batchSize: 200 })` | none (next tick is the retry) | isolated try/catch → `lastStatus='FAILED'`; JOB 2 still runs | `joblock.lastRunAt`/`lastStatus` + tick response + audit rows |
| JOB 2 reservation-reaper | same tick | same | same | `expireDueReservations({ batchSize: 100 })` | none (idempotent by construction) | isolated try/catch; JOB 1 unaffected | same |

* `FILE` `app/api/internal/jobs/tick/route.ts` — machine-authenticated
  (`Authorization: Bearer $JOBS_TICK_SECRET`), **constant-time** comparison via `timingSafeEqual`
  on SHA-256 digests (so the comparison cannot leak length), bare `401` on any failure, no session,
  no request body. `LOCKED` (P14-D09/D10), `VERIFIED` by `__tests__/jobs/tick.test.ts`.
* `FILE` `lib/jobs/{tick,lock}.ts` — two job names, one `now` passed to both, per-job isolation,
  `JOB_LEASE_MS = 5 * 60_000`.
* **Frequency is NOT in the repository.** The design is "an external scheduler POSTs the tick
  route"; no cron entry, systemd unit, `vercel.json` or package script schedules it.
  `grep` for `cron|setInterval|worker|BullMQ|Redis` finds no scheduler.
  **CLASSIFICATION: `OPEN INFRASTRUCTURE DECISION` / DEPLOYMENT DEPENDENCY** (§24 D-I19-03) —
  and a genuinely important one, because both jobs are silent if nothing calls the route.

---

## 12. Reservations

| ITEM | EVIDENCE | CLASS |
|---|---|---|
| creation | `lib/ticketing/reservations.ts#createReservation` (`HELD`, `expiresAt = now + TTL`) | `VERIFIED` |
| TTL source | `PlatformSetting.reservationTtlMinutes`, default 30 | `VERIFIED` |
| expiration | `expireDueReservations`: selects `HELD AND expiresAt < now`, claims the ORDER row first, releases seats, expires the order | `VERIFIED` |
| release | `releaseOrderReservations(tx, orderId, "RELEASED"|"EXPIRED")` — `WHERE status='HELD'`, idempotent | `VERIFIED` |
| double release | CAS on `HELD`; `restoreSoldQuota` clamps with `GREATEST(0, sold - q)` | `VERIFIED` |
| reservation after payment | `confirmOrderReservations` converts `HELD → CONVERTED` in the settlement transaction | `VERIFIED` |
| reservation after cancellation | cancel calls `voidOpenPayments` + `releaseOrderReservations` in one transaction | `VERIFIED` |
| event cancellation | expires unpaid orders and releases via the same helpers | `VERIFIED` |
| event completion | **touches no reservation, order or quota** (Phase 14 P14-D16) | `VERIFIED` |
| orphan reservation | self-healing branch in the reaper releases seats for terminal, unpaid orders still holding them | `VERIFIED` |
| reservations with no owner | `TicketReservation.orderId` FK is **required + `onDelete: Cascade`** — an owner-less hold is unrepresentable | `VERIFIED` |

**Live check (read-only):** 5 reservations, **all** `EXPIRED`; 0 `HELD`. So there is no overdue
hold in the live database. No `HELD` reservation can be indefinite: the reaper expires it even if
nothing else does, and the tick is the only requirement.

---

## 13. Inventory / Quota

**The actual invariant is NOT `available + reserved + sold = capacity`.** It is:

> `sold + reserved ≤ quota`, with neither counter negative
> (`lib/ticketing/inventory.ts#inventoryViolations`, design §11.6),
> and `available := max(0, quota − sold − reserved)` for display.

* `FILE` `lib/ticketing/inventory.ts#reserveQuota` — the guard is inside the statement:
  `UPDATE tickettype SET reserved = reserved + n, version = version + 1
   WHERE id = ? AND isActive = true AND reserved + sold + n <= quota`
  → **database-enforced under a row lock**, not application logic.
* `restoreSoldQuota` — `sold = GREATEST(0, sold − n)`, appends `version`.
* `rawAvailable` (unclamped) exists separately for diagnostics; `availableInventory` (clamped) for
  display, so a transient inconsistency is visible rather than hidden.

| TRANSITION | COUNTER EFFECT | EVIDENCE |
|---|---|---|
| reservation (checkout) | `reserved += n` | `reserveQuota` |
| payment settled | `reserved -= n`, `sold += n` | `confirmOrderReservations` |
| buyer cancel / order expiry | `reserved -= n` | `releaseOrderReservations` |
| confirmed refund | `sold -= n` (only if `event.returnQuotaOnRefund`) | `settlement.ts` → `restoreSoldQuota` |
| event cancellation | `reserved -= n` for unpaid orders | `events/service.ts` → void + release |
| event completion | **no counter change** | P14-D16 |

**Concurrency:** `version` is bumped on every mutation; the guard is a conditional `UPDATE`;
`withContentionRetry` re-runs deadlock victims. `TEST`
`__tests__/ticket-types/inventory-concurrency.integration.test.ts` (100 simultaneous buyers).
**CLASS: `VERIFIED`.**

---

## 14. PIC Accounting

| ITEM | EVIDENCE | CLASS |
|---|---|---|
| attribution → fee | `picattribution.orderId` **UNIQUE** (one attribution per order); fee posting is Phase 9 | `VERIFIED` |
| `EARNED` (CREDIT) | Phase 9 posting; no fee rate is hardcoded (snapshotted `rateBp`/`fixedAmount`/`basisAmount`) | `VERIFIED` |
| full-item refund → `REVERSAL` | `reversePicFeesForRefund`: only when `refundedTickets ≥ orderItem.quantity`, full earned amount, `DEBIT`, `status=VOID`, `adjustmentReason=REFUND` | `VERIFIED` |
| partial refund | posts **nothing** (`feeTreatment = "RETAINED"`) | `LOCKED` (D-R16 / D-P17-12) |
| duplicate reversal | `picfeeledger.(orderItemId, type)` UNIQUE + `idempotencyKey` UNIQUE + explicit existing-reversal check (triple guard) | `VERIFIED` |
| cancellation | **does not touch the ledger** (no writer in `cancelEvent`) | `VERIFIED` |
| payment failure / order expiry | no fee is ever `EARNED` for an unpaid order, so nothing to reverse | `VERIFIED` |
| refund failure | `processFailedRefund` writes no ledger row | `VERIFIED` |
| refund settlement | the only reversal writer | `VERIFIED` |
| tenant isolation | ledger rows carry `organizerId`; no PIC-facing API reads another tenant's rows | `VERIFIED` |

**Live check:** `picfeeledger` 0 rows, `picprofile`/`picattribution` 0 rows — no fee has ever been
posted in this database, so no money-movement-without-state can exist here.
**TEST** `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts` (partial retains,
full reverses once, exact amount, `refundId` linkage) — Phase 18B added the first integration
coverage this rule ever had.

**`EARLY_ACCRUAL` / `EARNED_ADJUSTMENT` / `PAYOUT` / `ADJUSTMENT` and the whole `Settlement`
model** (`DRAFT → PENDING_APPROVAL → APPROVED → PAID/FAILED/CANCELLED`) have **no writers** —
the payout engine does not exist. `OUT OF SCOPE` / `DEFERRED`.

---

## 15. Orphan / Duplicate Data

**Live, read-only inspection** (SELECT/COUNT only; nothing mutated):

| CHECK | RESULT |
|---|---|
| orders | 3 — all `EXPIRED`, all `paymentStatus = UNPAID` |
| payments / payment transactions | **0** |
| tickets | **0** |
| reservations | 5 — all `EXPIRED`, 0 `HELD` |
| events | 5 — all `PUBLISHED` |
| webhook events | 0 |
| PIC ledger / attribution / profile | 0 |
| refunds | 6 — **all orphans**: `refundNumber`, `eventOrderId`, `organizerId` all `NULL`, `confirmedAmount = 0` |
| refund items | 0 |
| `refund_backup_phase10b` | the same 6 legacy rows |

* **FINDING O19-01 — legacy orphan refund rows (`VERIFIED`, `DEFERRED`):** these are pre-ticketing
  retail rows (the `Refund` model reuses the legacy `Int` PK). They are **unreachable by every
  ticketing read path**: `listDashboardRefunds` filters `organizerId: { in: [...] }` (NULL never
  matches), `listRefunds` filters `requestedByUserId` (NULL never matches), and
  `settleRefund`/`failRefund`/`executeRefund` reject a row with a null `organizerId`/`eventOrderId`
  as `NOT_FOUND`. They hold no ticket claim, no order slot and no money. **Recommended:** leave
  them; cleanup is a data-removal decision outside this phase (§26).
* **No ticket without an order** is representable: `Ticket.orderId` is required (`onDelete:
  Restrict` on the ticket→order relation, so an order cannot be deleted out from under a ticket
  without an explicit decision).
* **No duplicate payment reference / ticket code / QR identity / refund item** is representable —
  all four are UNIQUE in the database (§16).
* **No `PaymentTransaction` without a payment**: `paymentId` is required and `onDelete: Restrict`.
* **Orphan `Refund` after order deletion** is *representable* (`Refund.eventOrderId` is
  `SetNull`) and is exactly what the 6 legacy rows are — but nothing in the ticketing application
  deletes an order, so production cannot create one.

---

## 16. Database Constraints

Unique constraints on the ticketing tables (read from `information_schema`, read-only):

| TABLE | UNIQUE KEY | COLUMNS |
|---|---|---|
| `eventorder` | `eventorder_orderNumber_key` | `orderNumber` |
| `payment` | `payment_paymentReference_key` | `paymentReference` |
| `refund` | `refund_refundNumber_key` / `refund_idempotencyKey_key` | `refundNumber` / `idempotencyKey` |
| `refunditem` | `refunditem_ticketId_key` | `ticketId` |
| `ticket` | `ticket_ticketCode_key` / `ticket_qrTokenHash_key` / `ticket_orderItemId_sequenceNo_key` | `ticketCode` / `qrTokenHash` / `(orderItemId, sequenceNo)` |
| `picfeeledger` | `picfeeledger_idempotencyKey_key` / `picfeeledger_orderItemId_type_key` | `idempotencyKey` / `(orderItemId, type)` |
| `picattribution` | `picattribution_orderId_key` | `orderId` |
| `checkin` | `checkin_ticketId_key` | `ticketId` |
| `webhookevent` | `webhookevent_providerEventId_key` | `providerEventId` |
| `joblock` | `PRIMARY` | `name` |
| `event` | `event_slug_key` / `event_shareCode_key` / `event_eventCode_key` | slugs/codes |

**Enforcement classification for every load-bearing invariant:**

| INVARIANT | A DB | B TRANSACTION | C APP | D TEST-ONLY |
|---|---|---|---|---|
| one settlement per provider event | ✔ `providerEventId` UNIQUE | ✔ | | |
| one refund claim per ticket | ✔ `ticketId` UNIQUE | ✔ | ✔ friendly refusal | |
| one admission per ticket | ✔ `checkin.ticketId` UNIQUE | ✔ CAS | | |
| one ticket identity per order slot | ✔ `(orderItemId, sequenceNo)` | | | |
| one reversal per order item | ✔ `(orderItemId, type)` = `idempotencyKey` UNIQUE | ✔ | ✔ | |
| `refundedAmount ≤ total` | | ✔ conditional `updateMany` | | |
| `sold + reserved ≤ quota` | row lock | ✔ conditional `UPDATE` | | |
| one `PROCESSING` refund per order | | ✔ order-row `FOR UPDATE` + count | ✔ pre-check | |
| no ticket admitted twice | | ✔ CAS `WHERE status='ISSUED'` | | |
| order `PAID` ≠ resurrected | | ✔ conditional `updateMany` | | |
| exactly one reconciliation/day | | | | ✘ — see below |

**FINANCIAL INVARIANTS THAT EXIST ONLY BECAUSE "THE CODE CURRENTLY DOES THAT":**
none for money movement. The one invariant that is **test-only** is that the tick route is
actually called on a schedule — a deployment property, not a code property (§24 D-I19-03).

---

## 17. Idempotency

| ROUTE | ACTION | MECHANISM | RETRY SAFE | CONCURRENT SAFE | DB GUARANTEE |
|---|---|---|---|---|---|
| `POST /api/ticketing/checkout` | create order | `IdempotencyKey (userId, scope, key)` UNIQUE + `orderNumber` UNIQUE; same-key replay returns the original order | ✔ | ✔ | ✔ |
| `POST …/orders/[n]/pay` | create payment session | claim row + `IdempotencyKey`; rate-limited | ✔ | ✔ | ✔ |
| `POST …/payment/webhook` | settle | insert-first `WebhookEvent` UNIQUE; only `PROCESSED` blocks re-delivery | ✔ | ✔ | ✔ |
| `POST …/orders/[n]/cancel` | cancel order | conditional `updateMany` on `PENDING_PAYMENT`; releases holds once | ✔ | ✔ | ✔ |
| `POST …/orders/[n]/issue` | issue tickets | `(orderItemId, sequenceNo)` UNIQUE → `ISSUED`/`ALREADY_ISSUED` | ✔ | ✔ | ✔ |
| `POST …/refunds` | request refund | `RefundItem.ticketId` UNIQUE (double submit → `TICKET_ALREADY_CLAIMED`) | ✔ | ✔ | ✔ |
| `POST …/refunds/[id]/approve` | `PENDING→APPROVED` | status CAS | ✔ | ✔ | ✔ |
| `POST …/refunds/[id]/reject` | `PENDING→REJECTED` | CAS + claim release in one transaction | ✔ | ✔ | ✔ |
| `POST …/refunds/[id]/execute` | `APPROVED→PROCESSING` | order-row `FOR UPDATE` + in-flight count + CAS | ✔ | ✔ | ✔ (transaction) |
| `POST …/refunds/[id]/settle` | `PROCESSING→REFUNDED` | CAS + balance predicate + evidence | ✔ | ✔ | ✔ (transaction) |
| `POST …/refunds/[id]/fail` | `PROCESSING→FAILED` | CAS + claim release | ✔ | ✔ | ✔ |
| `POST …/events/[id]/check-in` | admit | ticket-row `FOR UPDATE` + CAS `ISSUED→CHECKED_IN` + `CheckIn.ticketId` UNIQUE | ✔ | ✔ | ✔ |
| `POST …/events/[id]/publish|unpublish|cancel|complete|archive` | lifecycle | each a conditional `updateMany` + `count !== 1` → conflict | ✔ | ✔ | ✔ (transaction) |
| `POST /api/internal/jobs/tick` | run jobs | `joblock` lease (single-flight); jobs themselves idempotent | ✔ | ✔ | ✔ (lease row) |
| reservation expiry | `HELD→EXPIRED` | CAS before release | ✔ | ✔ | ✔ |

**No mutation was found where a retry can duplicate money, tickets, quota, ledger rows or a status
transition.** Every one is anchored either in a UNIQUE constraint or in a conditional write inside
a transaction.

---

## 18. Authz / Tenant Isolation

| SURFACE | RULE | EVIDENCE | CLASS |
|---|---|---|---|
| payment visibility | `order.read.tenant` via `resolveOrganizerFilter`; no unscoped query | `lib/dashboard/payments.ts` | `VERIFIED` |
| refund visibility | own-scope (buyer) or `order.read.tenant` (staff) | `lib/ticketing/refunds/service.ts#listRefunds` | `VERIFIED` |
| refund actions | `REFUND_APPROVE` / `REFUND_EXECUTE` on the **row's** organizerId + SoD | `service.ts` (5 edges) | `VERIFIED` |
| order worklist | filter applied **inside** the tenant scope | `lib/dashboard/orders.ts`; `TEST` reconciliation-visibility suite | `VERIFIED` |
| ticket issuance | order resolved by `userId` predicate | `lib/ticketing/orders.ts` | `VERIFIED` |
| check-in | `checkin.scan` + staff assignment + event match | `checkin/service.ts` | `VERIFIED` |
| event lifecycle | `event.publish`/`event.cancel`/`event.archive` per organizer | `lib/events/service.ts` | `VERIFIED` |
| PIC | `pic.*` capabilities; ledger is organizer-scoped | `lib/authz/permissions.ts` | `VERIFIED` |
| client-supplied `organizerId` is never authority | always re-decided against memberships (`resolveOrganizerFilter` / `requireOrganizerAccess`) | `lib/dashboard/scope.ts`, `lib/authz/guards.ts` | `VERIFIED` |
| cross-tenant resource | **404** (existence not leaked) | `__tests__/authz/role-matrix.integration.test.ts` | `VERIFIED` |
| unauthorized actor | 403 where membership is the subject; 404 where the resource is | `lib/api/errors.ts` comment + guards | `VERIFIED` |
| buyer foreign order/refund/ticket | 404 | ownership predicates in every query | `VERIFIED` |

No new permission key and no new role was introduced in Phases 18B/19
(`__tests__/authz/permission-map.test.ts` green).

---

## 19. Observability

**Can an operator reconstruct WHO / WHAT / WHEN / HOW MUCH / WHY / REFERENCE for every money
movement?** Yes — for every movement that the platform itself performs.

| MOVEMENT | WHO | WHAT | WHEN | HOW MUCH | WHY | REFERENCE | EVIDENCE |
|---|---|---|---|---|---|---|---|
| payment settled | `PROVIDER` actor on the audit row | order `PAID` + `PaymentTransaction(PAYMENT)` | `paidAt`, `occurredAt` | `EventOrder.total` | `payment.success` | provider txn id + order number | `audit-log.ts` (`payment.success`), `payment/settlement.ts` |
| payment failed | `SYSTEM` | order `CANCELLED`, seats released | audit timestamp | — | `payment.failed` | provider txn id | `payment.failed` |
| late settlement | `SYSTEM` | money recorded, `fulfilmentBlockedAt` | block timestamp | `total` | `LATE_SETTLEMENT_AFTER_TERMINAL_STATE` | provider txn id + order number | `payment/settlement.ts:513` |
| refund requested | buyer (`USER`) | `Refund` + claims | `createdAt` | `requestedAmount` | `refund.request` | refund number + order number | `refunds/service.ts` |
| refund approved/rejected | staff (`USER`) | status | `approvedAt` | requested amount | `refund.approve`/`reject` + reason | refund number | ditto |
| refund processing | staff | `PROCESSING` | `processedAt` + `processedByUserId` | — | `refund.process` | refund number | ditto |
| **refund settled (money out)** | staff (`USER`) | `REFUNDED`, tickets, quota, PIC ledger | `completedAt` | `confirmedAmount` (server-derived) | `refund.settle` | **`providerRef` (bank reference)** + `evidenceNote` | `settlement.ts`, `refund.process/settle` |
| refund failed | staff or `SYSTEM` | `FAILED`, claims released | `failedAt` | — | `refund.fail` + `failureReason` | refund number | `settlement.ts` |
| ticket issued | buyer-triggered | `Ticket` rows | `issuedAt` | — | `ticket.issue` | ticket code | `tickets/issuance.ts` |
| admission | staff | ticket `CHECKED_IN` + `CheckIn` row | `checkedInAt` | — | `checkin.success` / `checkin.rejected` | ticket code | `checkin/service.ts` |
| PIC fee | system | `PICFeeLedger(EARNED)` | `createdAt` | amount + rate snapshot | fee posting | `idempotencyKey` `fee:earned:{orderItemId}` | Phase 9 |
| PIC reversal | system | `PICFeeLedger(REVERSAL, DEBIT)` | `createdAt` | earned amount | `adjustmentReason=REFUND` | `fee:reversal:{refundId}:{orderItemId}` | `settlement.ts` |

**Audit vocabulary is enumerated and closed** (43 actions, no invented names):
`event.*`, `order.*`, `payment.*`, `refund.*` (incl. the Phase 18B `refund.process`),
`ticket.issue`, `checkin.*`, `pic.*`, `ticket_type.*`.

**Never logged (verified):** raw QR token, `qrTokenHash`, passwords, session tokens, provider
credentials, payment secrets. `lib/ticketing/audit-log.ts` runs a defensive key filter on
`beforeState`/`afterState`, and Phase 16's repo-wide search found no token in any response, log,
audit row or render.

**Observability GAPS:**
* `WebhookEvent` (the delivery ledger, including **forged-signature** attempts) has **no UI
  surface** — `grep webhookEvent lib/dashboard app/dashboard` → nothing. The design's "visible in
  `/api/admin/webhooks`" was never built; there is no `app/api/admin/webhooks` route.
  → **OPEN INFRASTRUCTURE DECISION D-I19-02.**
* Notifications: the `Notification`/`NotificationDelivery` models have **zero writers** — every
  operator alert in this system is a dashboard row an operator must look at.
  → **DEFERRED** (§26).
* `joblock.lastRunAt`/`lastStatus` is the only evidence a scheduled job ran; nothing surfaces it.
  → part of D-I19-03.

---

## 20. Reconciliation Matrix

| INVARIANT | SOURCE OF TRUTH | DETECTION | REMEDIATION | AUTOMATIC | OPERATOR | STATUS |
|---|---|---|---|---|---|---|
| payment amount == order total | `Payment` + `WebhookEvent.amountReported` vs `EventOrder.total` | webhook amount check (`sub_total` preferred); `INVALID_WEBHOOK` + `IGNORED` row on mismatch | manual investigation (no UI) | no | manual, **no surface** | `OPEN` D-I19-02 |
| order `PAID` ⟺ real money | `PaymentTransaction(PAYMENT)` rows appended with the CAS | order/payment status divergence is structurally impossible on the settle path | — | — | — | `VERIFIED` |
| `refundedAmount` ≤ `total` | `EventOrder.refundedAmount` | conditional write refuses; refund stays `PROCESSING` | settle refused / fail with reason | no | yes (`/dashboard/refunds`) | `VERIFIED` |
| ticket count == `Σ quantities` | `Ticket` rows per `orderItemId` | issuance compares `expectedTickets` vs committed rows | buyer re-issues from the order page | no | worklist visibility | `VERIFIED` |
| quota `sold + reserved ≤ quota` | `tickettype` counters | conditional `UPDATE` guard; `inventoryViolations()` diagnostics | retry (`withContentionRetry`) | yes (retry) | quota edit (`ticket_type.quota.change`) | `VERIFIED` |
| reservation expiry | `TicketReservation.expiresAt` | reaper selector `HELD AND expiresAt < now` | reaper releases + expires the order | **yes** | — | `VERIFIED` |
| refund transaction ⟺ refund row | `PaymentTransaction(REFUND)` | created only inside the one-shot CAS transaction | — | — | — | `VERIFIED` |
| PIC ledger ⟺ refund | `PICFeeLedger` rows | `(orderItemId,type)` + `idempotencyKey` UNIQUE | — | — | — | `VERIFIED` |
| admission ⟺ ticket | `Ticket.checkedInAt` + `CheckIn.ticketId` UNIQUE | gate reports `DUPLICATE`/`ALREADY_CHECKED_IN` | none (no undo by decision) | — | — | `VERIFIED` |
| event lifecycle ⟺ clock | `Event.status` + `endAt` | tick JOB 1 catch-up; manual completion | cancel / archive / manual complete | **yes** | yes | `VERIFIED` |
| provider delivery ⟺ settled | `WebhookEvent.providerEventId` UNIQUE | ledger row per delivery | provider re-delivery; operator alert for forced rows | partly | **no UI** | `OPEN` D-I19-02 |

---

## 21. Findings

| ID | FINDING | CLASS |
|---|---|---|
| O19-01 | 6 orphan legacy retail `refund` rows (no order/organizer/claim) — unreachable by every ticketing path | `VERIFIED` · `DEFERRED` |
| O19-02 | An open (`PENDING`/`APPROVED`) refund withholds its ticket from re-request **and** the gate **and** blocks event archival | `VERIFIED` · `OPEN PRODUCT DECISION` D-P19-01 |
| O19-03 | The gate admits as soon as an event is `PUBLISHED`, with no `startAt` check (early admission) | `VERIFIED` · `OPEN PRODUCT DECISION` D-P19-03 |
| O19-04 | `endAt IS NULL` events never complete and keep an open gate indefinitely | `VERIFIED` · `OPEN PRODUCT DECISION` D-P19-05 |
| O19-05 | No reconciliation surface or job for a stuck `PROCESSING` refund; `PAYMENT_RECONCILE` and `verifyPaymentStatus()` are declared-but-unused and payment-shaped | `VERIFIED` · `OPEN INFRASTRUCTURE DECISION` D-I19-01 |
| O19-06 | `WebhookEvent` ledger (incl. forged-signature attempts) has no UI surface; no `/api/admin/webhooks` route exists | `VERIFIED` · `OPEN INFRASTRUCTURE DECISION` D-I19-02 |
| O19-07 | No production scheduler exists in the repository; both jobs are silent if the tick route is not called externally | `VERIFIED` · `OPEN INFRASTRUCTURE DECISION` / DEPLOYMENT D-I19-03 |
| O19-08 | No remediation for a late settlement (`fulfilmentBlockedAt`) — visibility only | `VERIFIED` · `OPEN PRODUCT DECISION` D-P19-04 |
| O19-09 | `TicketStatus.VOID`, `TicketStatus.RESERVED`, `EventStatus.PENDING_REVIEW` and the whole `Settlement` model have no writers (`PENDING_REVIEW` appears only in a status *filter* list — `app/api/organizer/events/route.ts:32` — and in comments; `prisma.settlement` has zero calls) | `VERIFIED` · `DEFERRED` / `OUT OF SCOPE` |
| O19-10 | `OPEN_REFUND_STATUSES` is duplicated (private) in `checkin/service.ts` and `events/service.ts` | `VERIFIED` · low-risk duplication, not fixed (would touch two locked modules for cosmetics) |
| O19-11 | No rate limiter on the check-in endpoint, and none on refund request either: `lib/rate-limit.ts` now defines four named buckets (`login`, `register`, `paymentCreation`, `upload`), explicitly because nine retail-era buckets — including `refundRequest` and `orderCreation` — were deleted with the retail application | `VERIFIED` · not a decision; `checkin.scan` + staff assignment + tenant scope bound the surface, and the gate is not an anonymous endpoint |
| O19-12 | Corrections to Phase 18B's stale-`PROCESSING` sentence (§2.2) | `VERIFIED` |
| O19-13 | `EventOrder.discount`/`platformFee` are structurally always 0 (no coupon/fee engine) | `VERIFIED` · `OUT OF SCOPE` |

**No finding is a violation of a locked contract.** All thirteen are either intentional
consequences, absent capabilities, or genuinely open policy/infrastructure questions.

---

## 22. Mechanical Fixes (if any)

**NONE IMPLEMENTED. No code, schema, migration or test was changed in Phase 19.**

Why, against the "may fix mechanical integrity bugs that violate locked contracts" gate:

* Every locked money invariant is enforced (DB constraint or conditional transaction write) —
  §7, §16, §17 found **no** application-level check-then-update left on a money path.
* Every identified gap is either (a) an intentional consequence of a locked decision
  (O19-02, O19-03, O19-04), (b) a missing capability whose shape is a product/infrastructure
  choice (O19-05, O19-06, O19-08), or (c) cosmetic (O19-10).
* Fixing any of them would require inventing a policy (a stale-refund TTL, a gate `startAt` rule,
  a late-settlement remedy) or adding infrastructure (a scheduler contract, a reconciliation job)
  — both explicitly forbidden by the phase brief (§21 "STOP and classify").

The residual risk of changing nothing is **operational, not financial**: no money can move
incorrectly today, and each open item is visible in §23/§24 with its current behaviour and risk.

---

## 23. Open Product Decisions

### D-P19-01 — Stale `PENDING`/`APPROVED` refunds
* **QUESTION:** Should an open refund that nobody decides expire, remind, or stay open forever?
* **CURRENT BEHAVIOR:** it stays open indefinitely. Its `RefundItem` claim blocks (a) a new request
  for that ticket, (b) the gate (`REFUND_PENDING`), and (c) event archival
  (`archiveEvent` refuses while any open refund exists).
* **OPTIONS:** (A) leave as-is, staff-managed; (B) surface an "aging" indicator without any policy
  (pure observability); (C) auto-expire open refunds after a configured window (a policy — needs a
  window value and a buyer-visible outcome); (D) allow archive to ignore open refunds.
* **RISK:** one neglected row can stall an event's archival and withhold one ticket.
* **DEPENDENCIES:** archive precondition (Phase 12) and D-28's gate rule are `LOCKED`; any change
  reopens them.
* **RECOMMENDATION STATUS:** **no recommendation** — owner's decision.

### D-P19-02 — Refund SLA / reminder for `PROCESSING`
* **QUESTION:** Should the platform define a maximum time a refund may sit in `PROCESSING`, and
  remind/chase an operator?
* **CURRENT BEHAVIOR:** no SLA, no reminder, no threshold; `/dashboard/refunds` shows the elapsed
  age only.
* **OPTIONS:** (A) none (status quo); (B) a display-only aging bucket; (C) a configured SLA with a
  reminder; (D) an SLA with escalation.
* **RISK:** a refund can silently sit in `PROCESSING` (money not moved, buyer waiting) with no
  prompt to act.
* **DEPENDENCIES:** none technical; a reminder needs the notification channel that does not exist
  (D-I19-04).
* **RECOMMENDATION STATUS:** **no recommendation** — no SLA value may be invented.

### D-P19-03 — Does the gate open before `startAt`?
* **QUESTION:** Should a ticket be admitted before the event starts?
* **CURRENT BEHAVIOR:** **yes** — `isEventCheckInOpen` checks `status ∈ {PUBLISHED, ONGOING,
  COMPLETED}` and `now ≤ endAt + 30m`; it never checks `startAt`. A `PUBLISHED` event starting next
  month has an open gate today.
* **OPTIONS:** (A) keep (Phase 14's locked contract as written); (B) require `startAt ≤ now`
  (a check-in semantics change, which Phase 19 must not make unilaterally).
* **RISK:** early admission — a valid ticket admitted outside the event's own time window.
* **DEPENDENCIES:** Phase 14 §5 gate contract; changing it would change a `LOCKED` semantic and the
  check-in test matrix.
* **RECOMMENDATION STATUS:** **no recommendation** — flagged because the consequence is concrete
  and may not have been intended.

### D-P19-04 — Late-settlement remediation (carried from Phase 18B)
* **QUESTION:** When verified money has arrived for a terminal order, what happens to it?
* **CURRENT BEHAVIOR:** it is recorded, `fulfilmentBlockedAt` is set, no ticket is issued, no money
  is returned; the order appears in "Perlu tindakan".
* **OPTIONS:** (A) keep blocked + manual reconciliation; (B) an operator-initiated refund against a
  cancelled/expired order (needs a rule for what a refund may reference); (C) restore fulfilment
  (explicitly forbidden by D-P17-17); (D) auto-refund (forbidden).
* **RISK:** customer money held with no supported path back.
* **DEPENDENCIES:** refund eligibility currently requires `order.status ∈ {PAID,
  PARTIALLY_REFUNDED}` (`eligibility.ts` D-R03) — option B changes a locked rule.
* **RECOMMENDATION STATUS:** **no recommendation**.

### D-P19-05 — Should `endAt` be required before publish?
* **QUESTION:** May an event be published with no `endAt`?
* **CURRENT BEHAVIOR:** yes. Such an event never completes automatically or manually, keeps an open
  gate indefinitely, and can only leave the live state by cancellation or archival.
* **OPTIONS:** (A) keep; (B) require `endAt` at publish; (C) warn in the organizer UI without
  enforcing.
* **RISK:** a permanently "live" event with an open gate and an unbounded sales/lifecycle window.
* **DEPENDENCIES:** P14-D22 (`LOCKED`) and the event validation schema.
* **RECOMMENDATION STATUS:** **no recommendation**.

---

## 24. Open Infrastructure Decisions

### D-I19-01 — Reconciliation for a stuck `PROCESSING` refund
* **QUESTION:** What, if anything, observes in-flight refunds?
* **CURRENT BEHAVIOR:** nothing. `PAYMENT_RECONCILE` (permission) and `verifyPaymentStatus()`
  (lib/payment/ipaymu.ts) exist with **zero consumers** and are **payment-shaped** (keyed by a
  payment session), so they cannot produce evidence about a refund.
* **OPTIONS:** (A) keep manual (status quo); (B) an operator-driven reconciliation view that lists
  stale in-flight refunds and their evidence; (C) a provider-agnostic refund reconciliation job
  (requires a rail that can report status — see §25).
* **RISK:** low today (manual rail, no money in flight without an operator action), high if a rail
  is automated later.
* **DEPENDENCIES:** the chosen refund rail.
* **RECOMMENDATION STATUS:** **no recommendation**.

### D-I19-02 — Webhook ledger observability
* **QUESTION:** Should operators see provider deliveries, including forged-signature attempts?
* **CURRENT BEHAVIOR:** `WebhookEvent` rows exist (with `signatureValid`, `processingStatus`,
  `processingResult`, `errorMessage`, redacted `payloadJson`, `remoteIp`) and **no UI surface**.
  There is no `/api/admin/webhooks` route.
* **OPTIONS:** (A) accept DB-only visibility; (B) an admin read-only deliveries page with filters
  (`signatureValid=false`, `processingStatus=FAILED`); (C) an export/report.
* **RISK:** a replay storm or forgery attempt is recorded but invisible to the operator.
* **DEPENDENCIES:** route-inventory bookkeeping if a new page is added.
* **RECOMMENDATION STATUS:** **no recommendation**.

### D-I19-03 — The production scheduler contract (deployment)
* **QUESTION:** What calls `POST /api/internal/jobs/tick`, how often, and who notices when it stops?
* **CURRENT BEHAVIOR:** the application side is complete and machine-authenticated
  (`JOBS_TICK_SECRET`, constant-time, fails closed). **No scheduler exists in the repository**:
  no cron file, no systemd unit, no package script. Both jobs are silently idle if nothing calls
  the route; the only trace is `joblock.lastRunAt`.
* **OPTIONS:** (A) VPS cron entry (the Phase 14 decision's intent); (B) platform cron; (C) a
  supervised worker — explicitly rejected in Phase 14/15.
* **RISK:** if the cron is not installed (or stops), reservations stop expiring and events stop
  completing, with no alert.
* **DEPENDENCIES:** deployment configuration outside the repository.
* **RECOMMENDATION STATUS:** **deployment action required**; cannot be verified from this
  repository, and was NOT assumed to be configured.

### D-I19-04 — Notification channel
* **QUESTION:** Should the platform notify buyers/operators about money events?
* **CURRENT BEHAVIOR:** `Notification` and `NotificationDelivery` have **zero writers**. Every
  alert is a dashboard row an operator must visit.
* **OPTIONS:** (A) dashboard-only (current); (B) email/WhatsApp fan-out via `NotificationDelivery`.
* **RISK:** operator alerts are pull-only; no buyer notification for refund settlement.
* **DEPENDENCIES:** a provider choice (external service).
* **RECOMMENDATION STATUS:** **no recommendation**.

---

## 25. Provider Dependencies

| ITEM | STATUS | EVIDENCE |
|---|---|---|
| iPaymu **cannot refund** — no outbound refund endpoint | `PROVIDER DEPENDENCY` (confirming Phase 17/18A) | `lib/ticketing/payment/refund-provider.ts` returns `UNSUPPORTED`; Phase 17's verification of the provider surface; the rail is manual by `D-P17-04 = B` |
| payment settlement authority | iPaymu signature-verified callback is the only settlement trigger | `payment/webhook.ts` (fail-closed, timing-safe, replay ledger) |
| `verifyPaymentStatus()` | exists, **never called** — a status poll is not a settlement trigger | `lib/ticketing/payment/webhook.ts:87` (Phase 15/17 lock) |
| refund reference on a manual rail | our own transfer reference (`Refund.providerRef`), operator-supplied | Phase 18B §11 |
| a future automated rail | would need a provider that both refunds **and** reports refund status; neither is available today | §24 D-I19-01 |

**Nothing in Phase 19 added or assumed any provider capability.**

---

## 26. Deferred Work

* Cleanup of the 30 orphaned legacy retail tables, `refund_backup_phase10b`, and the 6 legacy
  orphan `refund` rows (O19-01). Data removal — needs an explicit decision, not an audit phase.
* `Settlement` payout engine (`PICFeeLedger → Settlement`, `SettlementStatus`,
  `SettlementMethod`) — no writers; `OUT OF SCOPE`.
* Ticket void / reissue (`TicketStatus.VOID` has no writer); ticket transfer.
* `EventStatus.PENDING_REVIEW` workflow.
* Coupons/discounts (`EventOrder.discount` is always 0).
* Fee engine expansion (`EARLY_ACCRUAL`, `PAYOUT`, `ADJUSTMENT` entries).
* Refund evidence file upload (textual/referential evidence is the current model).
* Bank-statement import.
* A dead-letter/report view for `WebhookEvent`.
* De-flaking `__tests__/ticketing-payment/payment-races.integration.test.ts` (a known
  load-sensitive flake first observed in Phase 18A: it passed in this phase's full run and in
  isolation).
* The duplicated private `OPEN_REFUND_STATUSES` constant (O19-10).

---

## 27. Test Results

Baseline only — Phase 19 changed no code, so there is nothing new to test, and no test was
weakened or skipped.

| Command | Result | Classification |
|---|---|---|
| `npx prisma validate` | valid | pass |
| `npx prisma migrate status` | 22 migrations · up to date | pass (no schema change) |
| `npx tsc --noEmit` | exit 0 | pass |
| `npx jest --runInBand` | **63 suites / 1365 tests passed** | pass — identical to the Phase 18B baseline |
| `npm run build` | *✓ Compiled successfully* | pass |
| `npx eslint .` | 0 errors / 5 warnings | pass (pre-existing `no-img-element`) |

**Failures:** none. **Flakes:** none observed in this run (the `payment-races` suite passed both in
the full run and in isolation). **Regressions:** none — no code changed.

Regression coverage relevant to this audit (all green): refund lifecycle + manual rail,
refund balance/concurrency, check-in/refund exclusion, event lifecycle + automation, jobs/lease,
reservation expiry, inventory concurrency, issuance idempotency, authz role matrix, reconciliation
visibility.

---

## 28. Worktree

* `git status --short` → **494** entries: the 493-entry Phase 18B tree plus this report.
* **No** source, schema, migration, test, config or environment file was modified. Evidence:
  `find . -newer PHASE_18B_REFUND_MONEY_IMPLEMENTATION_REPORT.md` (i.e. anything touched after
  Phase 18B ended, excluding `.next`/`.git`) returns **exactly one path** —
  `./PHASE_19_OPERATIONAL_HARDENING_AUDIT.md`.
* **Live database:** read-only inspection only (`SELECT`/`COUNT`/`information_schema`). No
  `UPDATE`, `DELETE`, `INSERT`, `ALTER`, `DROP`, `TRUNCATE` or `migrate reset` was executed.
* **No** `git commit`, `git push`, `git reset`, `git clean`.

---

## 29. Final Verdict

**PHASE 19 AUDIT COMPLETE — NO CODE REQUIRED**

Every acceptance criterion in the brief is satisfied: all eight state machines are mapped from
source (§3), every terminal state is identified, every indefinite state has an owner or is
explicitly intentional (§4), and the stuck-refund / stuck-payment / PAID-no-ticket /
late-settlement / reservation / lifecycle / scheduler / quota / PIC / issuance / check-in
behaviours are all documented against real code with real tests. No unsafe automatic remediation
was introduced, no product policy was invented, no live data was modified, and no code was
changed — because the audit found **no mechanical integrity bug that violates a locked contract**.

The five items that genuinely need a product decision are §23 D-P19-01 through D-P19-05, and the
four infrastructure/deployment items are §24 D-I19-01 through D-I19-04. The most operationally
urgent of these is **D-I19-03**: the jobs exist, are tested and are idempotent, but nothing in this
repository proves a scheduler is calling them.
