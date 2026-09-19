# PHASE 17 — PAYMENT / REFUND / EVENT MONEY FLOW AUDIT + DECISION LOCK

**Project:** TinggalKlik.Co
**Mode:** AUDIT + DECISION LOCK ONLY — no source, schema, migration, test, or dependency change
**Date:** 2026-09-19
**Label vocabulary used throughout:** `SOURCE FACT` · `DESIGN FACT` · `EXISTING BEHAVIOR` · `PRODUCT DECISION` · `OPEN QUESTION` · `PROVIDER CAPABILITY` · `INFRASTRUCTURE DECISION`

---

## 1. Executive Summary

`SOURCE FACT` The money system is **more locked than the brief assumes**. Every financial transition in the repository is a conditional database write (CAS) or a unique constraint; the amount written at any point is derived from server-stored rows; and the one path that could fabricate money movement — a provider adapter reporting success — is, by explicit design, the one thing this provider cannot do.

Six findings carry the phase:

1. **`PROVIDER CAPABILITY` — outbound refunds are unreachable in production.** iPaymu exposes no refund endpoint (already verified under D-R17). The default refund adapter returns `{ ok: false, reason: "UNSUPPORTED" }` for every call, so `executeRefund` moves a valid request to `FAILED` with `failureReason = "PROVIDER_UNSUPPORTED"`. `SOURCE FACT` The **only** production path from `PROCESSING → REFUNDED` is a provider-originated refund callback (`confirmInboundRefund`) — a rail this provider does not document either. The full settlement machine (quota restore, PIC reversal, `PaymentTransaction.REFUND`, `refundedAmount` increment) is therefore **implemented and tested but not reachable through the configured rail**.
2. **`SOURCE FACT` — ticket issuance is not part of settlement.** Settlement marks the order `PAID` and converts reservations; tickets are issued by a separate, buyer-triggered, ownership-gated, idempotent endpoint (`POST /api/ticketing/orders/[orderNumber]/issue`). A settled order whose buyer never returns remains `PAID` with **zero tickets**, and no job covers it.
3. **`SOURCE FACT` — the refundable-balance invariant holds for integer rupiah and can be violated by sub-rupiah amounts.** Per-line totals are rounded to whole rupiah (`ROUND_HALF_UP`) at checkout, while a refund claim is the sum of un-rounded `priceSnapshot` values; and `refundedAmount` is settled with a **blind increment**, not a balance-checked CAS. With fractional-rupiah prices the cumulative claim can (a) strand a legitimate last ticket as permanently unrefundable, and (b) under concurrency, push `refundedAmount` above `total` by up to Rp 0.49 × lines. This is the phase's one genuine money-integrity gap.
4. **`SOURCE FACT` — two refunds for the same order may be `PROCESSING` at once**, and inbound confirmation matches by `(orderId, amount)` only. A callback can confirm the wrong in-flight refund when two refunds for one order report the same amount. No constraint or guard prevents this.
5. **`SOURCE FACT` — cancellation and completion move no money**, exactly as Phases 12/14/15 locked. Verified against the current source, not taken from the reports.
6. **`SOURCE FACT` — webhook security, SoD, and check-in/refund exclusion are all implemented and verified**, and D-61's money representation is intact.

Nothing audited contradicts a locked decision. The phase's remaining ambiguity is not about what the code does — it is about **which of four product policies** the platform intends where the source is silent.

**Verdict:** `DECISION LOCK PARTIALLY COMPLETE — OPEN PRODUCT DECISIONS` (§29).

---

## 2. Sources Audited

`SOURCE FACT` Read in full or in the relevant regions, in the live tree:

| Area | Files |
|---|---|
| Schema | `prisma/schema.prisma` — `EventOrder`, `EventOrderItem`, `Payment`, `PaymentTransaction`, `WebhookEvent`, `Refund`, `RefundItem`, `Ticket`, `PICFeeLedger`, `IdempotencyKey`; enums `OrderStatus`, `PaymentStatus`, `RefundStatus`, `TicketStatus`, `CheckInResult`, `IdempotencyStatus` |
| Payment | `lib/payment/ipaymu.ts` (signature verify), `lib/ticketing/payment/{gateway,service,settlement,webhook,validation,refund-provider}.ts` |
| Refund | `lib/ticketing/refunds/{service,settlement,eligibility,validation,payload}.ts` |
| Order / checkout | `lib/ticketing/checkout.ts`, `lib/ticketing/orders.ts`, `lib/ticketing/reservations.ts` |
| Issuance / tickets | `lib/ticketing/tickets/{issuance,service,payload}.ts` |
| Events | `lib/events/{service,lifecycle,sales-state,catalog}.ts` |
| Contention | `lib/ticketing/db-contention.ts` |
| Design / reports | `TICKETING_PHASE1_DESIGN.md`, Phase 10A, Phase 10B (impl + refund audit), Phase 12, Phase 13, Phase 14, Phase 15, Phase 16 reports |

`SOURCE FACT` Verification performed on the live tree (audit-only; no file written except this report):

| Command | Result |
|---|---|
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `npx prisma migrate status` | 21 migrations found · `Database schema is up to date!` |
| `npx tsc --noEmit` | exit 0 (clean) |
| `npx jest --runInBand` | **61 suites / 1333 tests passed** (Phase 16 baseline: 61 / 1333) |

`EXISTING BEHAVIOR` No test failed, so no baseline/pre-existing/new classification was required.

---

## 3. Current Payment State Machine

`SOURCE FACT` Models: `EventOrder` (`OrderStatus`, `PaymentStatus`), `Payment`, `PaymentTransaction`, `WebhookEvent`.

```
EventOrder:  PENDING_PAYMENT ──settleVerifiedPayment (CAS)──▶ PAID ──confirmRefund──▶ PARTIALLY_REFUNDED ──▶ REFUNDED
                    │                                                                        ▲
                    ├── reaper / cancelEvent (CAS) ──▶ EXPIRED                                  │
                    └── buyer cancelOrder (CAS) ────▶ CANCELLED ────────────────────────────────┘
                                          │
                                          └── late settlement: paymentStatus=PENDING→PAID,
                                              status UNCHANGED, fulfillmentBlockedAt set

Payment:     PENDING ──▶ PAID | FAILED | EXPIRED | REFUNDED | PARTIALLY_REFUNDED
PaymentTransaction: append-only (PAYMENT / REFUND rows), status PAID | REFUNDED
```

| Transition | File · mechanism | Authorization | Money | Audit |
|---|---|---|---|---|
| `PENDING_PAYMENT → PAID` | `payment/settlement.ts:296` — `updateMany({ status: PENDING_PAYMENT, paymentStatus: { not: PAID } })` | webhook (signature) | none (records) | `payment.settle` |
| late settlement (`EXPIRED`/`CANCELLED` + money in) | `payment/settlement.ts:330` — writes `paymentStatus=PAID`, `fulfilmentBlockedAt`, **not** `status` | webhook (signature) | ledger row only | yes |
| `PENDING_PAYMENT → EXPIRED` | `reservations.ts` reaper CAS + reservation release | system (job) | none | `order.expire` |
| `PENDING_PAYMENT → EXPIRED` (event cancel) | `events/service.ts` `cancelEvent` CAS + `releaseOrderReservations` + `voidOpenPayments` | `event.cancel` | none | `order.expire`, `payment.expired` |
| `PENDING_PAYMENT → CANCELLED` | `ticketing/orders.ts` buyer cancel CAS | own order | none | yes |
| `paymentStatus → PAID/REFUNDED` | `settlePaymentRow`, refund settlement | server | records | yes |

`SOURCE FACT` **One authoritative settlement path.** `settleVerifiedPayment` is the only writer of `PAID`. Its step-4 CAS plus the `WebhookEvent.providerEventId @unique` claim means a duplicate webhook, a concurrent duplicate, and a re-delivered callback all converge on `ALREADY_PAID` with no second mutation.

`SOURCE FACT` **Ticket issuance is out of band** (§1.2). `assertOrderIsFulfillable` requires `fulfilmentBlockedAt = null`, `status = PAID`, `paymentStatus = PAID`, `paidAt != null`; issuance then takes the order row lock and writes only missing `(orderItemId, sequenceNo)` pairs. Idempotency is structural: `Ticket @@unique([orderItemId, sequenceNo])` plus a presence check inside the lock.

---

## 4. Current Refund State Machine

`SOURCE FACT` `lib/ticketing/refunds/service.ts` + `settlement.ts`:

```
          requestRefund (buyer/tenant)                approveRefund            executeRefund
                    │                                      │                       │
                    ▼                                      ▼                       ▼
PENDING ────────────────▶ APPROVED ──────────────────▶ PROCESSING ──────┬──▶ REFUNDED
   │                          │                          │              │
   └──▶ REJECTED ◀────────────┘                          └──▶ FAILED ◀──┘  (provider decline/unsupported)
        (staff decline)                                        │
                                                   releaseRefundClaims → claims re-requestable
```

| Step | Enforcement | Idempotency |
|---|---|---|
| request | eligibility `D-R03/R04/R05/R09/R10`; amount = Σ `orderItem.priceSnapshot` | `RefundItem.ticketId @unique` |
| approve | `PERMISSIONS.REFUND_APPROVE` + `requireOrganizerAccess`; **SoD**: `requestedByUserId === actor.userId` → `FORBIDDEN/Separation of duties` (`service.ts:341`) | CAS on `status = PENDING` |
| reject | same SoD (`service.ts:410`) | CAS |
| execute | `REFUND_EXECUTE` + SoD (`service.ts:535`); CAS `APPROVED → PROCESSING` | CAS; provider called **outside** the DB transaction; `ALREADY_REFUNDED` on replay |
| settle | CAS `PROCESSING → REFUNDED`; per-ticket CAS `ISSUED + refundedAt = null + checkedInAt = null → REFUNDED`; rollback if any ticket is not exactly 1 | CAS; duplicate confirmation → `ALREADY_REFUNDED` |
| fail | CAS `PROCESSING → FAILED`; `releaseRefundClaims` | CAS |

`SOURCE FACT` **The only money-moving point is `processConfirmedRefund`**, inside one transaction: ticket rows → order `refundedAmount` increment → order status → conditional quota restore → PIC reversal → `PaymentTransaction` `REFUND` row. A failed refund leaves all of it untouched.

`SOURCE FACT` **Client input can never be authority**: `amount`, `currency`, `status`, `providerRef`, `confirmedAmount` are all absent from every request schema; `confirmedAmount` is written from the provider response or falls back to the stored claim.

`OPEN QUESTION` `Refund.idempotencyKey` (`@unique`, nullable) is **declared but never written** by any code path. Duplicate-request protection rests entirely on `RefundItem.ticketId @unique`. Documentation/cleanup item, not a defect.

---

## 5. Current Order State Machine

`SOURCE FACT` `OrderStatus`: `PENDING_PAYMENT`, `PAID`, `CANCELLED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED`. `PaymentStatus`: `UNPAID`, `PENDING`, `PAID`, `FAILED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED`.

`EXISTING BEHAVIOR` The order carries three independent money columns (`subtotal`, `total`, `refundedAmount`) and two independent status columns (`status`, `paymentStatus`). The design deliberately allows the **mismatch state** `status = CANCELLED && paymentStatus = PAID` (late settlement) and points it at an operator queue — `SOURCE FACT` `settlement.ts:330-372` implements exactly that.

`SOURCE FACT` Inventory conversion happens **only** in the settlement CAS winner (`confirmOrderReservations` inside the same transaction); it throws on counter underflow, rolling the `PAID` write back. A late settlement deliberately does **not** re-take seats.

---

## 6. Current Ticket / Check-in Money Boundary

| Fact | Evidence |
|---|---|
| Refundable only while `ISSUED`, not checked in, not already claimed | `eligibility.ts` D-R04/R05/R10 |
| Settlement refuses a checked-in ticket and rolls back | `settlement.ts` ticket CAS `checkedInAt: null` |
| Check-in refuses a ticket with any open refund | Phase 15 `checkInTicket` + `CheckInResult.REFUND_PENDING` (409) |
| Both writers serialize on the ticket row | `SELECT … FOR UPDATE` in check-in and refund paths |

`SOURCE FACT` `CHECKED_IN → REFUNDED` and `REFUNDED → CHECKED_IN` are both structurally impossible; proven by the existing real-DB suite `__tests__/ticketing-checkin/check-in-refund-gate.integration.test.ts` (passing in the 61/1333 baseline).

`SOURCE FACT` Check-in performs **no** money movement: no order, payment, refund, quota, or PIC write.

---

## 7. Payment Settlement Audit

`SOURCE FACT` Traced end to end: checkout → `EventOrder` `PENDING_PAYMENT` + reservations `HELD` + `IdempotencyKey` row (one transaction) → `createOrderPayment` → provider session → webhook → signature → amount → ledger claim → `settleVerifiedPayment`.

| Property | Status | Evidence |
|---|---|---|
| Exactly one settlement path | **IMPLEMENTED** | only writer of `PAID` |
| Amount from client? | **No** | amount comes from `EventOrder.total` / provider report |
| Currency changeable by client? | **No** | `currency` absent from every schema; mixed-currency checkout refused |
| Duplicate webhook harmless | **IMPLEMENTED** | `proveventEventId @unique` claim → `DUPLICATE`, 200, no mutation |
| Concurrent delivery | **IMPLEMENTED** | CAS predicate decides one winner |
| Retry behaviour | **IMPLEMENTED** | `withContentionRetry` for transient contention only |
| Quota mutation | **IMPLEMENTED** | `confirmReservation` inside the winning transaction |
| Ticket issuance boundary | **SEPARATE** | buyer-triggered endpoint (§3) |
| Late / stale settlement | **IMPLEMENTED** | money recorded, no fulfilment, `fulfilmentBlockedAt` |
| `PaymentTransaction.providerTransactionId` uniqueness | **MISSING** | indexed, not unique (see §20) |

`OPEN QUESTION` **Settled order with no tickets.** If the buyer closes the browser after payment, nothing re-drives issuance. Design §26 treats the wallet as the delivery surface, but no job/notification compensates. Needs a product decision (auto-issue on settlement, or an operator/notification path), not a silent fix.

---

## 8. Refund Audit

`SOURCE FACT` All §4 checks verified against source; additionally:

- **Amount cannot exceed the refundable balance** at request time (`amount > total − refundedAmount` → `AMOUNT_EXCEEDS_REFUNDABLE`), but **is not re-checked at settlement** (§10 of this report).
- **Provider call is outside the transaction** — correct, and it is the reason a crash between provider success and settlement leaves a `PROCESSING` refund with money moved at the rail (§17).
- **Inbound confirmation is truthful**: `confirmInboundRefund` requires an in-flight `PROCESSING` refund, requires the provider-reported amount to **equal** `requestedAmount` exactly (or be absent), then runs the same CAS settlement. Only `amountReported === null` is tolerated; the ledger movement always uses stored claims, never the reported figure.
- **Unknown refund callback is harmless**: recorded as `IGNORED` (`ignored_refund_flow_is_phase_9`) and answered 200. `SOURCE FACT` the string is a stale label from Phase 9 planning; cosmetic only.

---

## 9. Provider Capability Audit

`PROVIDER CAPABILITY` (source-verified, not assumed):

| Question | Fact |
|---|---|
| Which provider? | **iPaymu** (`lib/payment/ipaymu.ts`, `PROVIDER = "ipaymu"`) |
| Payment APIs implemented? | Yes — session create, callback, status |
| Refund API implemented? | **No** — D-R17 concluded the iPaymu v2 surface (Payment, Balance, Transaction history, IP/domain validation, Area) has **no refund endpoint** |
| Outbound refund exists? | **No** — `refund-provider.ts` default adapter returns `{ ok: false, reason: "UNSUPPORTED" }` unconditionally |
| Refund confirmation exists? | **Yes** — `confirmInboundRefund` (callback-driven) |
| Refund webhook exists? | **Yes** — `applyRefundOutcome` branch |
| Provider references | `Payment.externalSessionId` / `PaymentTransaction.providerTransactionId` (nullable) |
| Amounts on the wire | 2-decimal strings, `requireSafeRupiah` guarded |
| Expiry unit | Order/payment expiry is a `DateTime`, TTL resolved from `PlatformSetting` |
| Sandbox verification | Environment switch (`SANDBOX`/`PRODUCTION`); no live rail used in tests |

`PROVIDER CAPABILITY` **PROVIDER CAPABILITY GAP:** there is no outbound money-return rail. The repository's answer is truthful failure (`FAILED / PROVIDER_UNSUPPORTED`), never fake success — which is the correct behavior and also the reason **no refund can reach `REFUNDED` in production today**.

---

## 10. Partial Refund Audit

`SOURCE FACT` Arithmetic actually implemented:

```
checkout:   lineSubtotal = ROUND_HALF_UP(unitPrice × quantity, 0dp)     // whole rupiah
            subtotal     = Σ lineSubtotal
            total        = subtotal − discount(0) = subtotal
claim:      amount       = Σ priceSnapshot (un-rounded, 2dp) over selected tickets
guard:      amount > total − refundedAmount  ⇒  AMOUNT_EXCEEDS_REFUNDABLE
settle:     refundedAmount += amount          // unconditional increment
```

| Case | Behaviour | Verdict |
|---|---|---|
| One order / one ticket, integer price | `amount = total` | safe |
| Partial ticket set, integer price | `Σ(selected ≤ all) ≤ total` | safe |
| Multiple sequential refunds, integer price | remaining balance shrinks monotonically | safe |
| Mixed refunded / issued tickets | allowed; each ticket claimed once | safe |
| Order status | `PAID → PARTIALLY_REFUNDED → REFUNDED` when `refundedAmount ≥ total` | correct |
| `refundedAmount > total` | possible only via rounding + concurrency | **gap** |
| Fractional-rupiah price | claim sum may exceed rounded line total | **gap** |

**Two concrete consequences, both source-derivable:**

1. `SOURCE FACT` **Stranded ticket.** With `unitPrice = 1000.49`, `quantity = 3`: `lineSubtotal = 1000` each, `total = 3000`, but each claim is `1000.49`. Requests 1 and 2 succeed (`refundedAmount = 2000.98`); the third claim `1000.49 > 999.02` is **refused forever**. The buyer cannot recover the remainder because the API offers no free-amount refund.
2. `SOURCE FACT` **Sub-rupiah over-refund under concurrency.** Two concurrent requests for disjoint tickets each read `refundedAmount = 0` and each pass the guard; both settle, because the increment is unconditional. The excess is bounded by `0.49 × lines` and requires a non-integer price — but it is a real double-claim of a balance, and it is invisible to every existing test.

`SOURCE FACT` For **integer-rupiah prices** the invariant `refundedAmount ≤ total` holds exactly, even under concurrency, because `Σ(all priceSnapshots) = total` and every ticket is claimable once. The gap is therefore precisely the fractional-price case.

---

## 11. PIC Fee Ledger Audit

`SOURCE FACT` `PICFeeLedger`: `type` = `EARNED | REVERSAL` (+ payout/adjustment), `direction` = `CREDIT | DEBIT`, `amount Decimal(14,2)`, `basisAmount`, `quantity`, `status`, `refundId`, `idempotencyKey @unique`.

| Question | Fact |
|---|---|
| When created? | `EARNED` per order item at settlement (fee engine, Phase 9) |
| When final? | On settlement; `status = EARNED` |
| When refunded/reversed? | `reversePicFeesForRefund` during confirmed refund settlement |
| Reversal condition | **Only when the order item's tickets are all `REFUNDED`** (`refundedTickets >= orderItem.quantity`) |
| Reversal amount | **Full** `earned.amount`, `direction = DEBIT`, `status = VOID`, `adjustmentReason = REFUND` |
| Partial refund | **Fee retained** — documented in `settlement.ts:343` as D-R16's deliberate rule |
| Double reversal? | Prevented three ways: `findFirst(REVERSAL)` guard, `@@unique([orderItemId, type])`, `idempotencyKey = fee:reversal:{refundId}:{orderItemId} @unique` |
| Reversal idempotent? | Yes — all three guards are database-enforced |
| Cancellation touches PIC? | **No** |
| Completion touches PIC? | **No** (Phase 15 verified) |

`PRODUCT DECISION` Proportional reversal on a partial refund is **not** implemented and is a genuine product choice, not a defect — D-R16 chose "reverse only when the whole item's admission is gone", which avoids inventing a per-seat fee split. `OPEN QUESTION` whether a partial refund should reduce the fee proportionally.

---

## 12. Cancellation Money Audit

`SOURCE FACT` `cancelEvent` (verified line by line, not taken from the Phase 12 report):

1. CAS `status → CANCELLED` (+ `cancelledAt`), idempotent replay when already `CANCELLED` (no second audit row).
2. For each `PENDING_PAYMENT` order: CAS `→ EXPIRED`, `releaseOrderReservations`, `voidOpenPayments` — **one transaction per order**, order row → reservations → ticket types (the established lock order).
3. Audit: `event.cancel`, `order.expire`, `payment.expired`.
4. **Nothing else.** `SOURCE FACT` Paid orders untouched · issued tickets untouched · **no refund created** · no PIC ledger write · no quota change beyond releasing unpaid holds.

`EXISTING BEHAVIOR` Phase 12's decision holds verbatim in the current source.

`OPEN QUESTION` **Cancellation refund policy.** Introducing `CANCELLED → refund workflow` (bulk create refunds for all paid orders, or notify buyers to request) is a product decision with money consequences. It is **not** implemented, and this phase does not propose implementing it.

---

## 13. Completion Money Audit

`SOURCE FACT` Phase 15's `completeEvent` / `advanceEventLifecycleBatch` writes only `Event.status`, `Event.completedAt`, and an audit row, under a CAS on the expected current status. Verified: no `EventOrder`, `Payment`, `PaymentTransaction`, `Refund`, `Ticket`, `TicketType` counter, or `PICFeeLedger` write.

`EXISTING BEHAVIOR` Completion does not wait for open refunds, unpaid orders, reservations, or pending payments — exactly as Phase 14 locked. Closure of a refund after `COMPLETED` works end to end (Phase 15 regression item J).

`SOURCE FACT` The only money-adjacent residue is the pre-existing `fulfilmentBlockedAt` flag written by *settlement*, not by completion.

---

## 14. Check-in / Refund Race

`SOURCE FACT` Four-way audit:

| Race | Serialization | Outcome |
|---|---|---|
| refund request vs check-in | eligibility reads `checkedInAt`; check-in holds the ticket row lock and requires no open refund | exactly one winner |
| refund approval vs check-in | approval does not touch the ticket; the **settlement** CAS requires `ISSUED + refundedAt=null + checkedInAt=null` | check-in wins → settlement rolls back |
| refund processing vs check-in | check-in sees an open refund (`PROCESSING`) → `REFUND_PENDING`, 409 | check-in refused |
| refund confirmation vs check-in | both take `SELECT … FOR UPDATE` on the ticket row | one winner, loser rolls back |

`EXISTING BEHAVIOR` `CHECKED_IN → REFUNDED` impossible (CAS + row lock). `REFUNDED → CHECKED_IN` impossible (status guard + `REFUND_PENDING`). Proven by the passing real-DB race suite. `SOURCE FACT` no invalid final state is reachable in the audited orderings.

---

## 15. Settlement / Refund Race

| Race | Assessment |
|---|---|
| settlement ∥ refund request | request refuses (`ORDER_NOT_PAID`) until the order is `PAID` |
| settlement ∥ refund approval | approval is on an existing `PENDING` refund; approval does not read the order's money total |
| settlement ∥ refund execution | `executeRefund` requires `APPROVED`; settlement and refund touch different rows except the order, which refund settlement re-reads under the transaction |
| payment webhook ∥ refund webhook | independent ledger rows (`providerEventId @unique` each); refund settlement re-checks order state and throws `SETTLEMENT_STATE_INVALID` if the order left the lifecycle |
| duplicate webhook ∥ duplicate webhook | one ledger row wins; the other returns `DUPLICATE` |

`SOURCE FACT` Isolation is MySQL/MariaDB default (`REPEATABLE READ`) with explicit row locks (`FOR UPDATE`) and CAS predicates; transient contention is retried by `withContentionRetry` up to a bounded attempt count, and exhaustion surfaces as `RETRY_LATER` rather than a silent drop.

`SOURCE FACT` **Deadlock risk is bounded** by a documented lock order (order row → reservations → ticket types; ticket row before refund claim updates).

`SOURCE FACT` **The one unbounded interaction** is §10's balance race and §16's multi-in-flight refunds.

---

## 16. Webhook Security

`SOURCE FACT` Exact sequence in `handleGatewayWebhook`:

1. **Body bound** — `> 64 KiB (MAX_WEBHOOK_BODY_BYTES)` → `413`, before any parsing or DB work.
2. **Signature, fail-closed** — `verifyCallbackSignature` accepts the header **or** the body's `signature` field (one value only, never both), removes `signature` from the canonical payload, recomputes HMAC-SHA256 over the ksort'd JSON with the VA secret, and compares with **`crypto.timingSafeEqual`**. `MISSING_SIGNATURE`/`INVALID_SIGNATURE` → recorded + `401`. `NOT_CONFIGURED` → `500`, never a fall-through to processing. **No state mutation occurs before verification.**
3. **Interpretation** — target resolved from provider reference; unknown target → ledger row `IGNORED`, `200` (no retry storm).
4. **Amount** — payment callbacks compared to the order total; mismatch → `400` with **no state change**. Refund callbacks skip the order-total comparison and are validated against the in-flight refund's `requestedAmount` instead.
5. **Replay claim** — `WebhookEvent.providerEventId @unique` insert **is** the guard; a losing insert returns `200 DUPLICATE` with no mutation.
6. **Act** — payment → settlement; refund → `confirmInboundRefund`; unknown status → recorded `IGNORED` (never mutates).

`SOURCE FACT` Secrets never enter the ledger: payloads are redacted, the signature is stripped, and buyer identifiers are dropped. Rejected deliveries are recorded with `signatureValid = false` so an attack is observable.

`SOURCE FACT` **No client-provided financial field is trusted anywhere** in this path: amount, currency, order identity, and refund amounts are all recomputed or matched server-side.

---

## 17. Ledger Reconciliation Model

`SOURCE FACT` Derivable equations:

```
order.total            = Σ lineSubtotal (roundToRupiah(price × qty))    [written once at checkout]
order.refundedAmount   = Σ confirmed refund amounts                     [increment per settlement]
net order amount       = total − refundedAmount
payment transactions   = append-only rows: type PAYMENT (settled) / type REFUND (per confirmed refund)
PIC fee                = Σ EARNED CREDIT rows per order item
PIC fee reversal       = Σ REVERSAL DEBIT rows per order item (≤ its EARNED, once)
```

`SOURCE FACT` All six values are recomputable from database rows alone; no in-memory or provider-only state is required to state what the platform believes it owes.

`OPEN QUESTION` Two facts are **not** reconcilable from our rows: (a) whether the provider actually moved the money when a refund is `PROCESSING` and the application crashed (there is no polling/reconciliation job), and (b) `PaymentTransaction.providerTransactionId` is not unique, so provider-side duplicates cannot be detected by constraint.

---

## 18. Idempotency Matrix

| Operation | Key / constraint | CAS | Transaction | Duplicate behaviour |
|---|---|---|---|---|
| checkout | `IdempotencyKey @@unique([userId, scope, key])` | insert race | one tx with order | replay returns stored response |
| payment attempt | `Payment.paymentReference @unique` | insert | yes | unique violation → reuse/refuse |
| payment webhook | `WebhookEvent.providerEventId @unique` | insert claim | ledger row then act | `DUPLICATE`, 200, no mutation |
| settlement | `EventOrder` CAS `PENDING_PAYMENT + not PAID` | yes | yes | `ALREADY_PAID` |
| ticket issuance | `Ticket @@unique([orderItemId, sequenceNo])` + presence check under row lock | yes | yes | creates only missing tickets |
| refund request | `RefundItem.ticketId @unique` | insert | yes | ticket already claimed → refused |
| refund approve / reject | `status = PENDING` CAS + SoD | yes | yes | `STATE_CHANGED` |
| refund execute | `status = APPROVED` CAS | yes | yes | `STATE_CHANGED` / `ALREADY_REFUNDED` |
| refund confirmation | `status = PROCESSING` CAS | yes | yes | `ALREADY_REFUNDED` |
| refund failure | `status = PROCESSING` CAS + claim release | yes | yes | idempotent |
| PIC fee creation | `idempotencyKey @unique` + `@@unique([orderItemId, type])` | insert | yes | no double EARNED |
| PIC fee reversal | `idempotencyKey @unique` + `@@unique([orderItemId, type])` + `findFirst` guard | insert | yes | no double REVERSAL |
| **refund balance** | **none** | **no** | — | **no guard at settlement (§10)** |

`SOURCE FACT` `Refund.idempotencyKey` exists as a unique column but is never populated (§4).

---

## 19. Authorization / Tenant Isolation

`SOURCE FACT`

| Actor | Capability | Mechanism |
|---|---|---|
| Buyer | own order, own refund, own tickets | ownership predicate **inside** the query (`userId`) — not a post-check; `requireOwnResource` |
| Organizer | tenant-scoped refund management (approve/execute) | `requireOrganizerAccess(organizerId, REFUND_APPROVE / REFUND_EXECUTE)` |
| Platform | global capability only where already defined | existing permission map |
| PIC / Finance | **no** refund or gate capability | Phase 14/16 lock |

`SOURCE FACT` **Separation of duties is enforced three times** (`approve`, `reject`, `execute`): a requester can never decide their own refund.

`SOURCE FACT` No client-supplied `organizerId`, `amount`, `currency`, `status`, `providerRef`, `confirmedAmount`, `feeTreatment`, or PIC identity can become authority anywhere in the money paths — all of them are absent from the request schemas or overwritten from server state. Cross-tenant access remains a 404-style denial, never a widened scope.

---

## 20. Database Constraint Matrix

| Invariant | Enforced by | Verdict |
|---|---|---|
| `RefundItem.ticketId` unique → a ticket claimed once (D-R10) | **database** | strong |
| `WebhookEvent.providerEventId` unique → replay impossible | **database** | strong |
| `PICFeeLedger @@unique([orderItemId, type])` → one EARNED, one REVERSAL | **database** | strong |
| `PICFeeLedger.idempotencyKey` unique | **database** | strong |
| `EventOrder.orderNumber`, `Payment.paymentReference`, `Refund.refundNumber`, `Ticket.ticketCode`, `Ticket.qrTokenHash`, `IdempotencyKey(userId, scope, key)` | **database** | strong |
| `Ticket @@unique([orderItemId, sequenceNo])` → issuance idempotency | **database** | strong |
| One settlement per order | **CAS** (`updateMany` predicate) | strong |
| `refundedAmount ≤ total` | **application check at request time only**, no settlement CAS | **gap (§10)** |
| At most one in-flight refund per order | **nothing** | **gap (§16 of the refund machine)** |
| `PaymentTransaction.providerTransactionId` non-duplication | **nothing** (indexed only) | gap |
| Refund status transition legality | **application CAS** | strong |
| Refund amount = Σ claims | **application** | strong |
| `CHECKED_IN` ticket not refundable | **application CAS + row lock** | strong |
| Refund requester ≠ approver/executor | **application only** | strong in code, no DB backstop |

`SOURCE FACT` Only one financial invariant in the whole system exists **solely in the application** in a way that can be lost under concurrency: the refundable balance.

---

## 21. Failure / Recovery Matrix

| Situation | Terminal state today | Truthful? | Needs reconciliation? |
|---|---|---|---|
| Provider timeout on payment session create | attempt `PENDING`/`FAILED`, order `PENDING_PAYMENT`, reservations expire | yes | no |
| Provider 4xx/5xx on refund | `FAILED / PROVIDER_*`, claims released | yes | no |
| Malformed provider response | treated as failure; nothing applied | yes | no |
| Duplicate provider response | `DUPLICATE`, no mutation | yes | no |
| DB failure before provider call | nothing moved | yes | no |
| DB failure after provider call (refund) | refund stuck `PROCESSING`, **money may have moved** | visible but unresolved | **yes** |
| Provider succeeds, app crashes | same as above | visible but unresolved | **yes** |
| App succeeds, response lost | CAS makes the retry a no-op | yes | no |
| Webhook delayed | settlement happens when it arrives; late settlement path if expired | yes | operator queue |
| Webhook amount mismatch | `400`, nothing applied, ledger row | yes | operator review |
| Order `PAID` but buyer never returns to issue tickets | **`PAID` with zero tickets** | visible | **yes (no job)** |
| Order `PAID` with inventory anomaly | `fulfilmentBlockedAt`, issuance refused | yes | operator queue |

`OPEN QUESTION` There is **no reconciliation service** in the architecture, and this phase does not invent one. The two unresolved rows (`refund stuck PROCESSING`, `paid-but-unissued`) are exactly the two items a future phase must decide on.

---

## 22. Money Representation

`EXISTING BEHAVIOR` D-61 remains closed and intact:

- Database: `Decimal(14,2)` for every money column.
- Edge: prices validated as **decimal strings** (`MONEY_SHAPE` regex, `MAX_MONEY = 999999999999.99`); no `z.coerce.number()`.
- Computation: `Prisma.Decimal` / decimal.js only; `roundToRupiah` applies `ROUND_HALF_UP` at first persistence.
- API: `moneyString()` → fixed 2-decimal strings; the frontend is display-only.
- Provider wire boundary: `requireSafeRupiah()` refuses anything that is not an exact non-negative safe integer.

`SOURCE FACT` No integer-rupiah migration is warranted or attempted; no floating-point money arithmetic exists anywhere in the audited paths.

`OPEN QUESTION` `roundToRupiah`'s interaction with per-ticket claim sums is the source of §10's gap. If the platform standardizes on whole-rupiah prices, the gap closes with no code change; otherwise a balance CAS is required.

---

## 23. Product Decisions

Each item states the source fact first, then what genuinely requires a decision.

| Area | Current source fact | Already locked | Requires product decision |
|---|---|---|---|
| A. Refund provider | iPaymu has no refund API; adapter returns `UNSUPPORTED` | Never fake success (D-R17) | Which rail executes refunds (bank transfer/manual, another gateway, wallet credit) |
| B. Gateway fee treatment | `gatewayFee` recorded from provider, never assumed; `platformFee = 0` | D-11/D-22/D-23 fields stored independently | Pass-to-buyer vs absorbed, and whether fees reduce a refund |
| C. Partial refund fee policy | PIC reversal only when the whole order item is refunded (D-R16) | No invented per-seat split | Whether partial refund reduces PIC fee proportionally |
| D. Cancellation refund policy | Cancellation moves no money | Phase 12 lock | Whether `CANCELLED` triggers refunds, notification-only, or nothing |
| E. Refund SLA / reconciliation | No polling, no reconciliation job; `PROCESSING` can stick | — | SLA + who resolves a stuck `PROCESSING` refund |
| F. Manual refund intervention | `FAILED` releases claims so a new request is possible | No fake success path | Whether an operator may record an off-platform refund (and how it is evidenced) |
| G. Failed refund retry | FAILED + released claims; retry = new request | D-R07 | Whether retry should be automatic and bounded |
| H. Refund after check-in | Refused (`TICKET_CHECKED_IN`) | D-R05 / D-28 | Should an admitted ticket ever be refundable (no-shows, goodwill)? |
| I. Refund after cancellation | Ordinary refund flow works on a cancelled event's paid orders | Phase 12 + eligibility | Bulk policy (D above) |
| J. PIC fee reversal semantics | Full reversal at full item refund | D-R16 as implemented | Proportional reversal (C above) |
| K. Settled-but-unissued orders | Issuance is buyer-triggered; no compensating job | Phase 8/9 design | Auto-issue on settlement vs notification/operator path |
| L. Multi-in-flight refunds per order | Possible; callback matched by `(orderId, amount)` | — | One-in-flight rule vs callback matching by refund number |

---

## 24. Implementation Candidates

`SOURCE FACT` Candidates that are mechanical **once the corresponding decision exists** — none may be started before it does:

| Candidate | Depends on | Size | Risk |
|---|---|---|---|
| Balance CAS at refund settlement (`refundedAmount + amount ≤ total` in the settlement predicate) | §23 C/L, §10 | small (one conditional update) | low; closes a real gap |
| Whole-rupiah price validation at the ticket-type edge | §23 (price policy) | small | behavioral change to price input |
| One-in-flight-refund guard per order | §23 L | small–medium | changes refund UX |
| Callback matching by `refundNumber`/`providerRef` instead of amount | §23 L | medium | needs provider support |
| Populate or drop `Refund.idempotencyKey` | housekeeping | trivial | none |
| Auto-issue on settlement or a fulfilment nudge job | §23 K | medium | needs job/notification design |

`SOURCE FACT` **Nothing else** in the audited money flow is broken, unenforced, or unsafe. There is no candidate that would change a locked semantic.

---

## 25. Future / Deferred Work

`DEFERRED` (explicitly outside this phase):

- Refund rail selection and integration (provider decision, §9/§23 A).
- Reconciliation/polling service for stuck `PROCESSING` refunds.
- Operator remediation tooling for `fulfilmentBlockedAt` and late settlements.
- Fee engine completion: platform fee > 0, PIC fee payout (`Settlement` / `SettlementItem`), D-22/D-23 resolution.
- Refund-state notifications (CUSTOMER/PIC) — the vocabulary exists, no senders for these transitions.
- Coupons/discounts (currently `discount = 0`, refused at checkout).

---

## 26. Phase 18 Dependencies

`INFRASTRUCTURE DECISION` Phase 18 cannot implement money-return behavior without:

1. A **provider/rail decision** for outbound refunds (or an explicit human-executed refund process).
2. A **product decision** on the refundable-balance guard (integer prices vs settlement CAS).
3. A **product decision** on in-flight refunds per order and callback matching.
4. A **product decision** on cancellation refunds.
5. An **operator/reconciliation** decision for stuck `PROCESSING` refunds.

`SOURCE FACT` Everything else Phase 18 might need — settlement, idempotency, webhook security, SoD, tenant isolation, check-in exclusion, money representation — is already implemented and verified.

---

## 27. Non-Decisions

Explicitly **not** decided or changed by this phase:

- No automatic refund invented for `CANCELLED`.
- No automatic refund or void invented for `COMPLETED`.
- No automatic PIC fee reversal rule invented beyond D-R16.
- No fake refund success and no fake provider reference.
- No change to Phase 10B refund lifecycle, Phase 12 cancellation, Phase 13/16 check-in, Phase 14 lifecycle, Phase 15 automation.
- No new provider integration, no new dependency, no schema or migration change.
- No cleanup of the 30 legacy retail tables or `refund_backup_phase10b` (still out of scope).
- No fee engine expansion and no coupon implementation.
- No test, source, or configuration file modified.

---

## 28. Final Decision Table

| ID | Decision | Status | Evidence | Implementation consequence | Phase |
|---|---|---|---|---|---|
| D-P17-01 | Amount authority is server-side only (`priceSnapshot`/`total`); client can never set amount, currency, status, providerRef or confirmedAmount | **LOCKED** | `eligibility.ts`, request schemas, `settlement.ts` | none — regression tests only | 17 |
| D-P17-02 | One authoritative settlement path; CAS `PENDING_PAYMENT + not PAID`; late settlement records money without fulfilment | **LOCKED** | `settlement.ts:296-372` | none | 17 |
| D-P17-03 | Ticket issuance is a separate, buyer-triggered, ownership-gated, idempotent step | **LOCKED** | `issuance.ts:468`, `assertOrderIsFulfillable` | none | 17 |
| D-P17-04 | Outbound refunds have no rail: iPaymu cannot refund; failure is truthful | **BLOCKED BY PROVIDER** | `refund-provider.ts` D-R17 | no `REFUNDED` reachable in production until a rail is chosen | 18 |
| D-P17-05 | Refundable-balance integrity under fractional prices and concurrency (stranded ticket + sub-rupiah over-refund) | **OPEN** | `checkout.ts:81/392`, `eligibility.ts:227`, `settlement.ts:205` | choose integer-rupiah prices or a settlement-time balance CAS | 18 |
| D-P17-06 | Multiple `PROCESSING` refunds per order and `(order, amount)` callback matching | **OPEN** | `confirmInboundRefund` findFirst; no constraint | one-in-flight rule and/or match by refund number | 18 |
| D-P17-07 | Failed refund releases claims; retry is a new request; no automatic retry | **LOCKED** | `processFailedRefund`, `releaseRefundClaims` | none | 17 |
| D-P17-08 | Cancellation moves no money and creates no refunds | **LOCKED** | `cancelEvent` verified | none | 17 |
| D-P17-09 | Cancellation → refund workflow (bulk or notify) | **OPEN** | source silent beyond Phase 12 lock | product policy then implementation | 18 |
| D-P17-10 | Completion moves no money and waits for nothing | **LOCKED** | Phase 15 `completeEvent` verified | none | 17 |
| D-P17-11 | PIC fee reversal only when the whole order item is refunded, full amount, idempotent | **LOCKED** | `reversePicFeesForRefund`, `@@unique([orderItemId, type])` | none | 17 |
| D-P17-12 | Proportional PIC reversal on partial refund | **OPEN** | D-R16 retained-fee rule | product choice | 18 |
| D-P17-13 | Check-in and refund are mutually exclusive; open refund blocks check-in | **LOCKED** | Phase 14 D-28 + Phase 15 row locks; passing race suite | none | 17 |
| D-P17-14 | Webhook security sequence: body bound → signature fail-closed (timing-safe) → amount → replay claim → act | **LOCKED** | `webhook.ts:355-544`, `ipaymu.ts:1188-1250` | none | 17 |
| D-P17-15 | Money representation D-61 (Decimal(14,2), decimal-string input, `moneyString`, `requireSafeRupiah`) | **LOCKED** | source-wide | none | 17 |
| D-P17-16 | Reconciliation/polling for refunds stuck in `PROCESSING` after provider success | **OPEN** | no reconciliation service exists | needs infra/product decision | 18 |
| D-P17-17 | Operator remediation for `fulfilmentBlockedAt` and late settlements | **OPEN** | flag written; no resolution surface | needs product decision | 18 |
| D-P17-18 | Settled order with no tickets (buyer never returns) | **OPEN** | issuance is buyer-triggered; no job | auto-issue or notification path | 18 |
| D-P17-19 | Gateway/platform fee treatment and coupon discounts | **DEFERRED** | `gatewayFee` recorded; fees 0 | fee engine phase | 18+ |
| D-P17-20 | `Refund.idempotencyKey` declared but never written | **DEFERRED** (housekeeping) | `prisma/schema.prisma:318` | populate or drop in a later cleanup | 18 |
| D-P17-21 | `PaymentTransaction.providerTransactionId` not unique | **DEFERRED** (documented gap) | schema index only | consider uniqueness when a rail exists | 18 |
| D-P17-22 | Legacy retail tables / `refund_backup_phase10b` present in MariaDB | **OUT OF SCOPE** | `migrate diff` proposals (pre-existing) | explicit cleanup phase | — |

---

## 29. Final Verdict

Audited in full, verified empirically, and no locked decision contradicted:

- Payments: single settlement path, CAS-guarded, replay-proof, amount-authoritative. **Sound.**
- Refunds: full lifecycle, SoD-enforced, CAS-guarded, never fabricating success. **Sound, but unreachable through the configured rail.**
- Tickets/check-in: money boundary clean, race-safe both directions. **Sound.**
- Cancellation/completion: no money movement, exactly as locked. **Sound.**
- Money representation, webhook security, tenant isolation: intact. **Sound.**
- Refundable-balance integrity and multi-in-flight refunds: **the only two genuine gaps**, both conjunctural (fractional prices + concurrency) and both requiring a product decision rather than a developer guess.

Phase 17 is an audit that answers every factual question; the questions it leaves open are policy questions the source cannot legitimately answer. Phase 18 implementation therefore remains blocked on:

- `BLOCKED BY PROVIDER` — outbound refund rail (D-P17-04).
- `OPEN PRODUCT DECISIONS` — D-P17-05, D-P17-06, D-P17-09, D-P17-12, D-P17-16, D-P17-17, D-P17-18.
- `OPEN INFRASTRUCTURE DECISION` — refund reconciliation (D-P17-16).

**FINAL VERDICT: `DECISION LOCK PARTIALLY COMPLETE — OPEN PRODUCT DECISIONS`**

Stated plainly: if the question is "can Phase 17 or Phase 18 ship a working refund in production?", the answer is **no** — that work is blocked by provider capability, and the lock says so explicitly rather than designing a fake rail.

---

### Verification & worktree

| Item | Result |
|---|---|
| `npx prisma validate` | valid |
| `npx prisma migrate status` | 21 migrations · up to date |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx jest --runInBand` | 61 suites / 1333 tests passed (matches Phase 16 baseline) |
| Files written by this phase | `PHASE_17_PAYMENT_REFUND_MONEY_DECISION_LOCK.md` only |
| Source / schema / migration / test / dependency changes | none |
| `git status --short \| wc -l` | 485 (66 untracked) — unchanged by this phase |
| Commit / push / reset / destructive migration | none performed |
