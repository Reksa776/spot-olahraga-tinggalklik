# PHASE 18B — REFUND, MONEY INTEGRITY & MANUAL REFUND RAIL IMPLEMENTATION

**Project:** TinggalKlik.Co
**Mode:** AUDIT → IMPLEMENT → VERIFY → REPORT
**Authoritative product decisions:** `PHASE_18A_REFUND_MONEY_PRODUCT_DECISION_LOCK.md`
**Verdict label:** see §23.

Every important statement below is labelled **IMPLEMENTED**, **VERIFIED**, **PRE-EXISTING**, or
**DEFERRED**.

---

## 1. Executive Summary

Phase 18A closed the refund-policy questions but left the money machinery with two real
integrity gaps and no refund rail at all. Phase 18B implements the locked decisions:

| Decision | Contract | Status |
|---|---|---|
| `D-P17-04 = B` | Production refund rail is a **manual bank transfer**. No outbound iPaymu refund API. `PROCESSING → REFUNDED` requires recorded transfer evidence. | IMPLEMENTED |
| `D-P17-05 = A` | Sellable prices are **whole rupiah** (server-enforced), **and** settlement enforces `refundedAmount + amount <= total` as a conditional write. | IMPLEMENTED |
| `D-P17-06 = A` | At most **one `PROCESSING` refund per order**, enforced transactionally under an order-row lock. | IMPLEMENTED |
| `D-P17-09 = A` | Cancellation does **not** refund. Buyer requests through the normal workflow. | PRESERVED + VERIFIED |
| `D-P17-12 = A` | PIC fee reversal stays **full-item only**; partial refunds retain the fee. | PRESERVED + VERIFIED |
| `D-P17-17 = C` | Late payment stays blocked; **no** automatic fulfilment, no ticket issuance, no resurrection. Operator visibility added. | IMPLEMENTED |
| `D-P17-18 = A` | Ticket issuance stays **buyer-triggered**; `PAID` + zero tickets is a recoverable state with operator visibility. | IMPLEMENTED |

The single most consequential change is that `lib/ticketing/refunds/service.ts` no longer calls a
provider at all. It used to call `getRefundProvider()`, whose only truthful answer was
`UNSUPPORTED` → `FAILED`; it now runs the two-step manual rail instead, and the ONLY path to
`REFUNDED` is `settleRefund` with evidence attached.

**Five test suites and two routes were added; nine existing tests were rewritten** because they
encoded the superseded contract (provider confirmation, and fractional-price acceptance). None
was deleted and none was weakened — each rewrite asserts a *stronger* property of the new
contract (e.g. the webhook refund test now asserts that a provider can never settle a refund,
which the old test could not).

---

## 2. Phase 18A Decisions Used

* `D-P17-05 = A` — whole rupiah prices.
* `D-P17-06 = A` — maximum one `PROCESSING` refund per order.
* `D-P17-09 = A` — cancellation does not automatically refund.
* `D-P17-12 = A` — full-item PIC reversal only.
* `D-P17-17 = C` — late settlement blocked, resolved manually, visible.
* `D-P17-18 = A` — buyer-triggered issuance retained; `PAID` + no tickets is recoverable.
* `D-P17-04 = B` — manual bank transfer rail; no iPaymu refund implementation.

Locked prior-phase contracts that were **not** reopened: Phase 10B refund lifecycle and SoD,
Phase 12 cancellation, Phase 14/15 lifecycle and check-in, Phase 16 QR, Phase 17 money
representation (D-61), single CAS settlement path, webhook security sequence.

---

## 3. Baseline Audit

Audited before editing (source, not reports):

* `prisma/schema.prisma` — `Refund` (status enum, `confirmedAmount`, `providerRef`,
  `completedAt`, `failedAt`, `failureReason`, `feeTreatment`, `idempotencyKey`), `RefundItem`
  (`ticketId @unique`), `PICFeeLedger` (unique `(orderItemId, type)` in effect via
  `idempotencyKey @unique`), `EventOrder` (`total`, `refundedAmount`, `fulfilmentBlockedAt`).
* `lib/ticketing/refunds/{service,settlement,eligibility,validation,payload}.ts`.
* `lib/ticketing/payment/{webhook,refund-provider}.ts`.
* `lib/ticketing/checkout.ts` — `roundToRupiah(unitPrice × quantity)`, `priceSnapshot: line.unitPrice`.
* `lib/ticket-types/validation.ts` — `moneyAmount` (the only price parser).
* `lib/ticketing/audit-log.ts` — the action vocabulary.
* `app/dashboard/{refunds,orders}/page.tsx`, `lib/dashboard/{refunds,orders}.ts`,
  `components/dashboard/RefundDecisionActions.tsx`.
* `app/api/ticketing/refunds/**`, `proxy.ts` (`/api/ticketing/` prefix → protected).
* `__tests__/ticketing-refunds/**`, `__tests__/ticket-types/**`,
  `__tests__/ticketing-payment/payment-webhook.integration.test.ts`.

### Findings that shaped the implementation

| # | Finding | Class |
|---|---|---|
| A1 | `moneyAmount` accepted up to 2 decimals, so a fractional-rupiah price was storable; checkout rounds the LINE while a refund claims the un-rounded `priceSnapshot`. | IMPLEMENTED (fixed) |
| A2 | `processConfirmedRefund` did `refundedAmount: { increment: amount }` with no balance predicate — a blind increment. | IMPLEMENTED (fixed) |
| A3 | `executeRefund` CASed `APPROVED → PROCESSING` with no check for another `PROCESSING` refund on the same order. | IMPLEMENTED (fixed) |
| A4 | `confirmInboundRefund` identified the refund by `(eventOrderId, status: PROCESSING)` + amount — the identification Phase 18A forbade. | IMPLEMENTED (removed) |
| A5 | `executeRefund` called `getRefundProvider()`, which can only answer `UNSUPPORTED` → `FAILED`. No rail existed. | IMPLEMENTED (manual rail) |
| A6 | `Refund` had no field for an operator evidence note (`providerRef`/`completedAt`/`processedByUserId` cover reference/instant/actor). | IMPLEMENTED (one column) |
| A7 | `lib/dashboard/orders.ts` did not expose `fulfilmentBlockedAt` and had no way to find `PAID` + zero tickets. | IMPLEMENTED (fixed) |
| A8 | The refund dashboard showed no transfer reference, no evidence and no processing age. | IMPLEMENTED (fixed) |
| A9 | `lib/dashboard/orders.ts` built one flat `where`; adding a second `OR` group would have silently overridden the first. | IMPLEMENTED (AND-combined) |

---

## 4. Files Changed

**Production (12 modified, 3 new):**

| FILE | WHAT |
|---|---|
| `prisma/schema.prisma` | `Refund.evidenceNote String? @db.Text` |
| `prisma/migrations/20260919010000_add_refund_evidence_note/migration.sql` | **NEW** — additive column |
| `lib/ticket-types/validation.ts` | whole-rupiah rule in `moneyAmount` |
| `lib/ticketing/refunds/service.ts` | manual rail: `executeRefund` claims, `settleRefund`, `failRefund` |
| `lib/ticketing/refunds/settlement.ts` | order lock, balance CAS, evidence, `confirmInboundRefund` removed |
| `lib/ticketing/refunds/validation.ts` | `refundSettleSchema`, `refundFailSchema` |
| `app/api/ticketing/refunds/[refundId]/settle/route.ts` | **NEW** — settle route |
| `app/api/ticketing/refunds/[refundId]/fail/route.ts` | **NEW** — fail route |
| `lib/ticketing/payment/webhook.ts` | refund branch records and never settles |
| `lib/ticketing/payment/refund-provider.ts` | header only — capability statement, no longer called |
| `lib/ticketing/audit-log.ts` | `refund.process` action |
| `lib/dashboard/orders.ts` | `fulfilmentBlockedAt`, `needsReview`, AND-combined predicates |
| `lib/dashboard/refunds.ts` | `evidenceNote` on the read model |
| `app/dashboard/orders/page.tsx` | "Perlu tindakan" worklist + attention badges |
| `app/dashboard/refunds/page.tsx` | evidence / processing-age columns, honest copy |
| `components/dashboard/RefundDecisionActions.tsx` | claim / settle / fail controls |

**Tests (7 modified, 2 new):** `__tests__/ticketing-refunds/refund-harness.ts`,
`refund-lifecycle.integration.test.ts`, `refund-wiring.test.ts`,
`refund-manual-rail.integration.test.ts` (**NEW**),
`refund-reconciliation-visibility.integration.test.ts` (**NEW**),
`__tests__/ticketing-payment/payment-webhook.integration.test.ts`,
`__tests__/ticket-types/validation.test.ts`,
`__tests__/ticket-types/ticket-type-service.integration.test.ts`,
`__tests__/events/event-service.integration.test.ts`.

---

## 5. D-P17-05 Implementation

### 5.1 Whole rupiah (server-enforced)

* **FILE:** `lib/ticket-types/validation.ts`
* **FUNCTION:** `moneyAmount` (used by `createTicketTypeSchema.price` and
  `updateTicketTypeSchema.price`)
* **BEHAVIOR:** after the existing shape/precision checks, the fraction must pad to `00`. The
  rule is enforced **server-side in the schema every admin and organizer route parses** —
  `price: "150000"` and `"150000.00"` are accepted and canonicalised to `"150000.00"`;
  `"150000.50"`, `"150000.25"`, `"150000.01"` and the JSON number `100000.5` are refused with
  `WHOLE_RUPIAH_MESSAGE`. `TICKET_TYPE_LIMITS.WHOLE_RUPIAH_MESSAGE` is exported so the message
  is asserted by tests rather than string-copied.
* **WHY IT FIXES THE MISMATCH:** `priceSnapshot` stores the unit price and a refund claims the
  snapshot; checkout stores `roundToRupiah(unitPrice × quantity)`. With a whole unit price the
  two agree for every line, so `Σ priceSnapshot == order.total` exactly.
* **ENTRY PATHS AUDITED:** `ticketType.create` / `ticketType.update` in
  `lib/ticket-types/service.ts` are the **only** writers (`grep` verified), and both are fed by
  these two schemas. There is no admin route, seed, or helper that writes a price directly.
* **D-61 UNCHANGED:** storage stays `Decimal(14,2)`; the API still renders fixed two-decimal
  strings; the gateway guard `requireSafeRupiah` is untouched; nothing became a JS number.
* **TESTS:** `__tests__/ticket-types/validation.test.ts` →
  *"PHASE 18B — a price carries no fractional rupiah"* (accept matrix, refuse matrix with the
  exact message, update-path refusal, JSON-number refusal, and a static guard that the service
  writes `price: input.price` and never `price: Number(...)`);
  `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts` →
  *"whole-rupiah pricing keeps the order total refundable to the cent"*.

### 5.2 Refundable balance as a database predicate

* **FILE:** `lib/ticketing/refunds/settlement.ts`
* **FUNCTION:** `processConfirmedRefund`
* **BEHAVIOR:** the transaction now (1) reads the refund, (2) takes
  `SELECT id FROM eventorder WHERE id = ? FOR UPDATE`, (3) CASes `PROCESSING → REFUNDED`, then
  (4) replaces the blind increment with a **conditional** write:

  ```ts
  const balanceCas = await tx.eventOrder.updateMany({
      where: { id: order.id, refundedAmount: { lte: new Prisma.Decimal(order.total).minus(amount) } },
      data: { refundedAmount: { increment: amount } },
  });
  if (balanceCas.count !== 1) throw new AppError(ERROR_CODES.REFUND_NOT_ALLOWED, {
      details: { reason: "REFUNDABLE_BALANCE_EXCEEDED" } });
  ```

  A claim that does not fit is **not** marked `REFUNDED`: the throw rolls the whole settlement
  back, leaving the refund `PROCESSING` with nothing moved — the truthful failure state the
  brief requires. This is a read-compare-write *inside* the database, not in the application.
* **TESTS:** `refund-manual-rail.integration.test.ts` →
  *"a settlement that would exceed the order total is refused and moves nothing"* (asserts
  status stays `PROCESSING`, `refundedAmount = 0`, ticket still `ISSUED`, zero `REFUND`
  transactions) and *"concurrent settlements against one balance never push `refundedAmount`
  past total"* (two PROCESSING claims, each one rupiah short of the total, settled in parallel:
  exactly one reaches `REFUNDED`, `refundedAmount <= total` holds).

### 5.3 Idempotency preserved

The CAS to `REFUNDED` still happens **before** the order is read, so a replay whose order is
already `REFUNDED` returns `ALREADY_REFUNDED` rather than tripping the order-status guard. The
existing *"a repeated confirmation is ALREADY_REFUNDED"* test still passes unchanged.

---

## 6. D-P17-06 Implementation

* **FILE:** `lib/ticketing/refunds/service.ts`
* **FUNCTION:** `executeRefund` (the `POST …/execute` route)
* **BEHAVIOR:** the `APPROVED → PROCESSING` CAS now runs inside one transaction that first locks
  the ORDER row (`SELECT id FROM eventorder WHERE id = ? FOR UPDATE`) and counts the order's
  other `PROCESSING` refunds. The lock is the serialization point: two workers claiming two
  different approved refunds of the same order cannot both read "none in flight". The loser is
  refused with `REFUND_NOT_ALLOWED` / `reason: "REFUND_ALREADY_PROCESSING"` (409) and its refund
  stays `APPROVED`.
* **WHY NOT A PARTIAL UNIQUE INDEX:** MySQL/Prisma cannot express "unique only when
  `status = 'PROCESSING'`" without a maintained generated column, which every status transition
  would then have to keep correct across the codebase. The row lock is the mechanism the brief
  explicitly permits and the one every money path already serializes on.
* **SCOPE OF THE LOCK:** only `PROCESSING`. `PENDING` and `APPROVED` remain unrestricted, exactly
  as `D-P17-06 = A` specifies ("maximum ONE PROCESSING refund per order").
* **FAILED / REFUNDED RELEASE THE CLAIM:** `failRefund` → `FAILED` and `settleRefund` →
  `REFUNDED` both leave `PROCESSING`, so the next legitimate refund can be claimed.
* **TESTS:** `refund-manual-rail.integration.test.ts` →
  *"two concurrent claims on the same order produce exactly one winner"* (real parallel
  `Promise.all`, asserts `count(PROCESSING) === 1`, loser still `APPROVED`, and the loser can be
  claimed after the winner settles) and *"a FAILED transfer releases the in-flight claim"*;
  `refund-lifecycle.integration.test.ts` → *"a PROCESSING refund holds the order's one in-flight
  slot"*; static guard in `refund-wiring.test.ts` →
  *"at most one PROCESSING refund per order is enforced under a row lock"*.

---

## 7. D-P17-09 Preservation (cancellation)

* **NOT CHANGED:** `lib/events/service.ts#cancelEvent` still expires unpaid orders, leaves paid
  orders untouched, voids no tickets and moves no money.
* **VERIFIED:** `__tests__/events/event-service.integration.test.ts` →
  *"does not touch a paid order, its issued ticket, or its refundedAmount"* now **also** asserts
  `prisma.refund.count({ where: { eventOrderId } }) === 0` — cancellation creates no refund row
  of any kind, so the only route to money back on a cancelled event is the buyer's own request.
* **No new code path:** `grep` confirms no cancellation code touches `refund.create`.

---

## 8. D-P17-12 Preservation (PIC fee)

* **NOT CHANGED:** `reversePicFeesForRefund` still reverses only when
  `refundedTickets >= orderItem.quantity`, posts a single `REVERSAL`/`DEBIT` entry for the full
  earned amount, and is guarded three ways (existing reversal, unique `idempotencyKey`
  `fee:reversal:{refundId}:{orderItemId}`, and the item-level full-refund predicate).
* **VERIFIED (new coverage — this behaviour had NO integration test before):**
  `refund-manual-rail.integration.test.ts` →
  *"a partial refund retains the fee; the final ticket reverses it exactly once"* builds a real
  `PICProfile` + `EARNED` ledger row on a two-ticket order item, refunds one ticket
  (`feeTreatment = "RETAINED"`, zero `REVERSAL` rows), then the last ticket
  (`feeTreatment = "REVERSED"`, exactly one `REVERSAL` row, `DEBIT`, full `15000.00`,
  `status = VOID`, `refundId` set).
* **No proportional math was introduced:** the reversal amount is `earned.amount`, unchanged.

---

## 9. D-P17-17 Implementation (late settlement)

* **NOT CHANGED (locked policy):** `lib/ticketing/payment/settlement.ts` still records the money,
  refuses to resurrect the order, restores no quota and issues no ticket. `LATE_SETTLEMENT`
  remains a `PROCESSED` ledger row with `fulfilmentBlockedAt` set and an operator alert.
* **IMPLEMENTED (visibility):**
  * **FILE:** `lib/dashboard/orders.ts` · **FUNCTION:** `listDashboardOrders` · **BEHAVIOR:**
    `fulfilmentBlockedAt` is selected, and a new `needsReview` filter selects
    `OR: [{ fulfilmentBlockedAt: { not: null } }, { status: "PAID", tickets: { none: {} } }]`
    **inside** the tenant scope.
  * **FILE:** `app/dashboard/orders/page.tsx` · **BEHAVIOR:** a "Perlu tindakan" toolbar link and
    an attention column rendering `Pembayaran terlambat` (`error` tone) or `Tiket belum terbit`
    (`warn` tone). Read-only — the page has no control that changes an order.
* **NO REMEDIATION ACTION SHIPPED:** the locked policy permits visibility without a remedy when
  no safe money-preserving remedy exists, and none does without a product decision on how the
  blocked money is returned. This is deliberate: see §20 (DEFERRED).
* **TESTS:** `refund-reconciliation-visibility.integration.test.ts` →
  *"a late settlement and a paid-without-tickets order are both visible, and nothing else is"*
  (the late-settled order is produced by its **real cause** via `createLateSettledOrder`, and the
  test asserts it stays `CANCELLED`, stays blocked, still has zero tickets).

---

## 10. D-P17-18 Implementation (paid without tickets)

* **NOT CHANGED:** issuance stays buyer-triggered; `lib/ticketing/tickets/issuance.ts` is
  untouched. Payment settlement still does NOT issue anything, and nothing was moved into the
  settlement transaction.
* **IMPLEMENTED:** the same `needsReview` worklist makes `PAID` + zero tickets findable, so the
  state is operable rather than invisible.
* **NO SECOND ISSUANCE PATH:** no operator action was added. The buyer's existing
  `POST /api/ticketing/orders/[orderNumber]/issue` remains the only way tickets are minted, which
  keeps the idempotency and ownership guarantees already tested.
* **TESTS:** same suite — after the worklist surfaces the order, the test issues through the
  **buyer's** path twice, asserting `outcome: "ISSUED"` then `"ALREADY_ISSUED"` with
  `ticketsIssued: 0`, exactly one ticket row and one distinct `ticketCode`, and that the order
  then leaves the worklist **by its own state**.

---

## 11. Manual Refund Rail (D-P17-04 = B)

The lifecycle is unchanged; the meaning of the middle state changed.

```
PENDING ──approve──▶ APPROVED ──process──▶ PROCESSING ──settle(evidence)──▶ REFUNDED
   │                                            │
   └──reject──▶ REJECTED                        └──fail──▶ FAILED
```

| Step | ROUTE | FUNCTION | WHAT IT DOES |
|---|---|---|---|
| Request | `POST /api/ticketing/refunds` | `requestRefund` | unchanged |
| Approve | `POST …/approve` | `approveRefund` | unchanged |
| Reject | `POST …/reject` | `rejectRefund` | unchanged |
| **Claim** | `POST …/execute` | `executeRefund` | `APPROVED → PROCESSING`; **moves no money**, calls no provider, writes `refund.process` |
| **Settle** | `POST …/settle` | `settleRefund` | `PROCESSING → REFUNDED`; **requires evidence**; the one and only money movement |
| **Fail** | `POST …/fail` | `failRefund` | `PROCESSING → FAILED`; releases the claim; moves no money |

**Evidence model** (`Refund` columns, no new ledger):

| Evidence | Column | Source |
|---|---|---|
| Bank/transfer reference | `providerRef` (required, non-empty) | operator |
| Evidence note | `evidenceNote` (optional, new) | operator |
| Transfer instant | `completedAt` | **server clock** |
| Operator | `processedByUserId` | **session**, never the body |
| Amount | `confirmedAmount` | **server-derived** sum of the refund's own `RefundItem` rows |

**Security properties (each with a test):**

* a refund cannot become `REFUNDED` without a reference — the schema is `.strict()` and
  `transferRef` is required (`min(3).max(120)`), so an evidence-less settle is a 400;
* the client cannot influence the amount — `settleRefund` derives it via
  `moneyString(Σ items.amount)` and never reads an amount from the request;
* a client cannot smuggle `confirmedAmount`, `amount`, `status` or `organizerId` — `.strict()`
  rejects unknown keys outright;
* separation of duties holds — a requester cannot settle or fail their own request;
* `PROCESSING` explicitly does NOT mean money moved: the audit action `refund.process` says so,
  the payload's `confirmedAmount` is still `0.00`, and the dashboard copy says so.

**Tests:** `refund-manual-rail.integration.test.ts` (evidence matrices, wrong-state refusal,
SoD), `refund-lifecycle.integration.test.ts` (end-to-end through both steps, including the
`COMPLETED`-event case), static guards in `refund-wiring.test.ts` →
*"a manual settlement requires recorded transfer evidence"* and
*"only the settlement core may write REFUNDED, and only from PROCESSING"*.

---

## 12. Refund Reconciliation

* **IMPLEMENTED:** `app/dashboard/refunds/page.tsx` now shows, per refund: the refund number, the
  order, the buyer, ticket count, the **amount**, the status, the **transfer reference + evidence
  note** (or the failure reason), the **`processedAt` instant and how long it has been
  `PROCESSING`**, and the actions. `lib/dashboard/refunds.ts` selects `evidenceNote`.
* **IMPLEMENTED:** `components/dashboard/RefundDecisionActions.tsx` — `PENDING` → Setujui/Tolak,
  `APPROVED` → "Mulai proses", `PROCESSING` → "Catat transfer" (prompts for the reference, then an
  optional note) / "Gagalkan" (prompts for a reason). The component contains **no** shortcut to
  `REFUNDED`.
* **THE TRUTH IS PRESERVED:** `PROCESSING` renders as an outstanding task ("N hari berjalan"),
  never as "money sent"; only `REFUNDED` — which cannot be reached without evidence — claims that.
  No automatic `PROCESSING → REFUNDED` was introduced anywhere, and `grep` confirms no scheduler
  or job touches refunds.
* **NO iPaymu POLLING, NO REUSED `PAYMENT_RECONCILE`:** confirmed by search — neither appears in
  any refund file.
* **OPERATIONAL NOTE:** the live database currently holds one pre-existing `PROCESSING` refund
  created before this phase. Under `D-P17-06` it legitimately holds its order's single in-flight
  slot; the new surface is how an operator resolves it (settle with evidence, or fail). No data
  was modified.

---

## 13. Authz / Tenant Isolation

* **UNCHANGED** for request/approve/reject/execute: `requireOwnResource(REFUND_REQUEST_OWN)` for the
  buyer, `requireOrganizerAccess(REFUND_APPROVE)` and `(REFUND_EXECUTE)` for staff.
* **SAME PERMISSION FOR THE NEW EDGES:** both `settleRefund` and `failRefund` require
  `PERMISSIONS.REFUND_EXECUTE` on the refund's OWN `organizerId`, resolved from the row. **No new
  permission key and no new role was introduced** (verified by
  `__tests__/authz/permission-map.test.ts` passing unchanged).
* **SOD ENFORCED ON EVERY STAFF EDGE:** approve, reject, process, settle and fail each refuse
  `requestedByUserId === actor.userId`. The new suite covers the settle case.
* **CROSS-TENANT:** a foreign organizer resolves through the same guard chain and is denied
  (404/403); the worklist test asserts the review filter cannot leave the tenant scope.
* **NO CLIENT AUTHORITY:** `organizerId`, `status`, `confirmedAmount`, `amount`, `providerRef`,
  ticket/order ids and the actor all come from the row or the session. The `.strict()` schemas
  make an attempted override a 400.
* **ROUTES PROTECTED:** `proxy.ts`'s `/api/ticketing/` prefix covers the two new routes (defence in
  depth); both handlers call `requireSameOrigin` → `requireAuth` → `parseOrThrow`. A static guard
  in `refund-wiring.test.ts` asserts auth + same-origin + validation for all six refund routes.

---

## 14. Concurrency Guarantees

| Invariant | Mechanism | Test |
|---|---|---|
| `refundedAmount ≤ total` | conditional `updateMany` on the locked order row | balance-race test (parallel settles) |
| one `PROCESSING` per order | order-row `FOR UPDATE` + count + CAS in one transaction | concurrent-claim test (parallel claims) |
| one money movement per refund | `PROCESSING → REFUNDED` CAS in the settlement transaction | concurrent duplicate-settle test |
| one admission vs an open refund | pre-existing ticket-row `FOR UPDATE` on the gate and the claim (Phase 15, D-28) | pre-existing `check-in-refund-gate` suite, still green |
| no duplicate ledger row | `RefundItem.ticketId @unique`, `PICFeeLedger.idempotencyKey @unique` | pre-existing + new PIC test |

**Deadlock reasoning (documented in code):** both `executeRefund` and `processConfirmedRefund`
now take the ORDER row lock first, then the refund row, then the tickets then the `tickettype`
counters. `requestRefund` (tickets → refund insert) is the pre-existing inverse; InnoDB resolves
that ordering and settlement retries it through `withContentionRetry`, unchanged. No new lock
inversion was introduced by Phase 18B.

`failRefund` deliberately takes no locks: it is a single CAS plus a claim release.

---

## 15. Database / Migration Changes

* **FILE:** `prisma/migrations/20260919010000_add_refund_evidence_note/migration.sql`
  — one statement: `ALTER TABLE refund ADD COLUMN evidenceNote TEXT NULL;`
* **ADDITIVE ONLY:** no drop, no enum reorder, no row rewrite, no data deletion.
* **NOT TOUCHED:** the 30 orphaned legacy retail tables and `refund_backup_phase10b`. `prisma
  migrate status` reports those as drift only in `migrate diff`, exactly as Phase 15 recorded;
  nothing was dropped and no `migrate reset` was run.
* **APPLIED:** `npx prisma migrate deploy` → *"All migrations have been successfully applied"*;
  `npx prisma migrate status` → *"22 migrations found… Database schema is up to date!"*.
* **LIVE DATA CHECK:** `SELECT COUNT(*) FROM tickettype WHERE price <> FLOOR(price)` → **0**;
  likewise **0** fractional `priceSnapshot` values. The new invariant holds for existing data, so
  no legacy row needed migration (which is fortunate — rewriting production prices would have
  been a destructive, unapproved change).

---

## 16. API Changes

| ROUTE | CHANGE |
|---|---|
| `POST /api/ticketing/refunds/[refundId]/settle` | **NEW** — records evidence, settles |
| `POST /api/ticketing/refunds/[refundId]/fail` | **NEW** — fails a processing refund |
| `POST /api/ticketing/refunds/[refundId]/execute` | same path, changed meaning: `APPROVED → PROCESSING` (no provider) |
| `POST /api/ticketing/payments/webhook` (payment callback) | refund-shaped deliveries are recorded `IGNORED` and answered 200 with `REFUND_MANUAL_RAIL` |

No route was removed and no response shape changed for existing consumers. The refund payload is
unchanged (`providerRef` now carries the bank reference; `confirmedAmount` remains server-derived
and `"0.00"` until settlement).

---

## 17. UI Changes

* `app/dashboard/refunds/page.tsx` — 10 columns (adds **Bukti transfer**, **Diproses**), honest
  description of the manual rail, per-row processing age.
* `components/dashboard/RefundDecisionActions.tsx` — the three-rail control set described in §12.
* `app/dashboard/orders/page.tsx` — "Perlu tindakan" worklist link, attention badges, and an
  accurate empty state for review mode.
* No new page, no new route, no visual system change; `components/dashboard/primitives.tsx` and
  the design tokens are reused, and the route inventory test (`29` routes) passes unchanged.

---

## 18. Test Matrix

| Area | Suite | Result |
|---|---|---|
| Whole rupiah (accept/refuse/update/JSON number/bypass) | `ticket-types/validation.test.ts` | PASS |
| Whole rupiah through the service (round trip) | `ticket-types/ticket-type-service.integration.test.ts` | PASS |
| End-to-end refundable-to-the-cent, no stranded ticket | `refund-manual-rail.integration.test.ts` | PASS |
| Balance CAS (over-balance refused; concurrent) | `refund-manual-rail.integration.test.ts` | PASS |
| One `PROCESSING` per order (concurrent + release) | `refund-manual-rail`, `refund-lifecycle` | PASS |
| Evidence required (schema + wrong state + SoD) | `refund-manual-rail.integration.test.ts` | PASS |
| Duplicate settlement moves money once | `refund-manual-rail.integration.test.ts` | PASS |
| PIC partial retains / full reverses once | `refund-manual-rail.integration.test.ts` | **NEW COVERAGE** |
| Webhook cannot settle a refund | `refund-lifecycle`, `payment-webhook` | PASS |
| Refund identity: no `(orderId, amount)` matching | `refund-wiring.test.ts` (static) | PASS |
| Static architectural guards (routes, CAS, evidence, no provider call, no payout) | `refund-wiring.test.ts` | PASS |
| Late settlement + paid/no-ticket visibility, and no mutation | `refund-reconciliation-visibility.integration.test.ts` | **NEW** |
| Buyer issuance idempotency | `refund-reconciliation-visibility.integration.test.ts` | PASS |
| Cancellation creates no refund | `events/event-service.integration.test.ts` | PASS |
| Check-in / refund exclusion | pre-existing `ticketing-checkin/*` | PASS |
| Existing refund lifecycle, eligibility, payment, issuance, events, authz, UI | whole suite | PASS |

**Full run: 63 suites / 1365 tests passed** (Phase 16 baseline: 61 suites / 1333 tests → **+2
suites, +32 tests**).

---

## 19. Verification

| Command | Result |
|---|---|
| `npx prisma validate` | *The schema at prisma/schema.prisma is valid* |
| `npx prisma migrate status` | 22 migrations · *Database schema is up to date!* |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx jest --runInBand` | **63 suites / 1365 tests passed** |
| `npm run build` | *✓ Compiled successfully*; build completes, all routes emitted |
| `npx eslint .` | **0 errors / 5 warnings** — the pre-existing `no-img-element` set, unchanged |

### Runtime smoke (built server, `next start`)

| Check | Result |
|---|---|
| `GET /dashboard` (anonymous) | `302 → /login?callbackUrl=%2Fdashboard` |
| `GET /dashboard/refunds` (anonymous) | `302 → /login?callbackUrl=%2Fdashboard%2Frefunds` |
| `GET /api/events` (public catalog) | `200` |
| `POST /api/ticketing/refunds/1/settle` (anonymous) | `401 {"message":"Silakan login terlebih dahulu."}` |
| `POST /api/ticketing/refunds/1/fail` (anonymous) | `401` |

The two new routes are therefore unreachable without a session, and the refund dashboard remains
behind the login redirect.

---

## 20. Known Limitations

1. **No automated remediation for a late settlement.** `D-P17-17 = C` leaves it manual and the
   phase shipped visibility only. Returning that money is a refund, which needs its own product
   decision (which order status a refund may be raised against for a cancelled/expired order).
   **DEFERRED.**
2. **No refund SLA / reminder.** `processingAge` is displayed with no threshold, because
   inventing one would invent a policy. **DEFERRED.**
3. **No reconciliation job.** Nothing transitions a stuck `PROCESSING` refund automatically —
   deliberately, since only an operator has the evidence. **DEFERRED (would need an
   infrastructure decision, not a product one).**
4. **A pre-existing `PROCESSING` refund in the live database now blocks its order's in-flight
   slot** until an operator settles or fails it. That is `D-P17-06` working as locked, and the new
   surface is the remedy. Reported, not modified.
5. **`Refund.idempotencyKey` remains unused** (nullable + unique). Phase 17 flagged it as a
   candidate; Phase 18B did not need it because the lifecycle CASes are already idempotent.
   **DEFERRED.**
6. **No evidence file upload.** The evidence model is textual/referential, which the brief
   explicitly permits. **DEFERRED.**

---

## 21. Deferred Work

* Payment-shaped `PAYMENT_RECONCILE` + `verifyPaymentStatus()` remain declared-and-unused
  (Phase 18A finding 7). Phase 18B confirms they are **not** refund reconciliation and did not
  repurpose them.
* Splitting the manual rail into batch transfer runs, or recording a bank-statement import.
* Notification fan-out for `refund.process` / `refund.settle` (no notification infrastructure was
  introduced — the brief said dashboard visibility is sufficient).
* The pre-existing orphaned retail tables and `refund_backup_phase10b` cleanup.

---

## 22. Worktree

* Before: **487** entries. After: **493** (**+6**).
* The new files are the migration directory, this report, the two refund routes and the two test
  suites; the routes and suites live inside directory trees that were ALREADY untracked from the
  uncommitted Phase 10B work, so `git status` reports them as part of those directory entries
  rather than as separate rows. Nothing was hidden or re-created by that.
* **NO** `git commit`, `git push`, `git reset`, `git clean`, `prisma migrate reset`, destructive
  migration or data deletion. The pre-existing uncommitted work from Phases 1–18A is preserved.
* **No file outside the Phase 18B list in §4 was modified.** Verified two ways: `find -newermt`
  over the implementation window returns exactly those files (plus the Phase 18A report, whose
  mtime falls inside the same window because it was written at the start of this session), and
  the only affected paths under `lib/`, `app/`, `components/` and `__tests__/` are the ones
  enumerated above.

---

## 23. Final Verdict

**PHASE 18B COMPLETE WITH DOCUMENTED LIMITATIONS**

The limitations are the five DEFERRED items in §20 — none of them is a locked acceptance
criterion, and each is deferred by product decision rather than by incomplete work. Every
acceptance item is met and evidenced above.
