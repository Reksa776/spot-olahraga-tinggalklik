# PHASE 18A — REFUND & MONEY PRODUCT DECISION LOCK

**Project:** TinggalKlik.Co
**Mode:** AUDIT + PRODUCT DECISION LOCK ONLY — no source, schema, migration, test, dependency, config or environment change
**Date:** 2026-09-19
**Baseline:** `PHASE_17_PAYMENT_REFUND_MONEY_DECISION_LOCK.md` (factual baseline — not reopened absent contradiction)
**Label vocabulary:** `SOURCE FACT` · `DESIGN FACT` · `EXISTING BEHAVIOR` · `PRODUCT DECISION` · `OPEN QUESTION` · `PROVIDER CAPABILITY` · `INFRASTRUCTURE DECISION`

**Decision status vocabulary (used exactly):**
`LOCKED` · `OPEN — PRODUCT` · `OPEN — PROVIDER` · `OPEN — INFRASTRUCTURE` · `DEFERRED` · `OUT OF SCOPE`

---

## 1. Executive Summary

`SOURCE FACT` Phase 18A re-read the live money paths and confirmed every Phase 17 factual claim. **Nothing audited contradicts Phase 17.** This phase therefore adds no new facts about what the code *does*; its work is to convert seven vague open items into **explicit, mutually exclusive policy options with the exact source consequence of each**, so that the product owner can choose rather than a developer guessing.

`SOURCE FACT` The seven Phase 17 open items are all still open, and this phase deliberately leaves all seven open:

| ID | Subject | Status after 18A |
|---|---|---|
| D-P17-05 | Refundable-balance integrity | `OPEN — PRODUCT` |
| D-P17-06 | Multiple in-flight refunds / callback matching | `OPEN — PRODUCT` (+ one provider sub-question) |
| D-P17-09 | Cancellation → refund policy | `OPEN — PRODUCT` |
| D-P17-12 | Proportional PIC fee reversal | `OPEN — PRODUCT` |
| D-P17-16 | Stuck `PROCESSING` refund reconciliation | `OPEN — PROVIDER` + `OPEN — INFRASTRUCTURE` |
| D-P17-17 | Late settlement / `fulfilmentBlockedAt` remediation | `OPEN — PRODUCT` |
| D-P17-18 | Settled order with no tickets | `OPEN — PRODUCT` |

Three findings materially sharpen the decision, and all three are source- or documentation-verified in this phase:

1. **`SOURCE FACT` — the provider has no refund rail, and this is now externally corroborated, not inferred.** Re-confirmed from source: `lib/ticketing/payment/refund-provider.ts` returns `{ ok: false, reason: "UNSUPPORTED" }` for every call (D-R17). Additionally, `EXTERNAL PROVIDER RESEARCH` performed this phase shows iPaymu's own merchant documentation frames refunds as a **manual merchant process** — its refund guidance instructs the merchant to publish a refund policy and return funds by bank transfer or back to the originating e-wallet. There is no iPaymu refund *API endpoint* in the documented v2 surface. **The rail decision (D-P17-04) is therefore a real, external constraint, not a code omission.**
2. **`INFRASTRUCTURE DECISION` — the platform already contains a declared-but-unwired reconciliation capability.** `SOURCE FACT` the permission key `payment.reconcile` (`PAYMENT_RECONCILE`) exists in `lib/authz/permissions.ts` and is granted to several roles, but has **zero consumers** anywhere in `app/`, `lib/` or `components/`. `SOURCE FACT` `verifyPaymentStatus(sessionId)` exists in `lib/payment/ipaymu.ts` (`POST /api/v2/payment/status`) and is also **never called** — `lib/ticketing/payment/webhook.ts:86` documents that decision explicitly: *"No provider `verifyPaymentStatus` call. A server-side status poll is not a settlement."* Reconciliation is thus a **pre-designed, deliberately-unbuilt** seam, not a missing architecture.
3. **`SOURCE FACT` — the reconciliation seam is payment-shaped, not refund-shaped.** `verifyPaymentStatus` is keyed by payment `sessionId` and returns payment status. It cannot produce evidence about a refund, because the provider exposes no refund object to query. This is the precise reason D-P17-16 is `OPEN — PROVIDER` and not merely `OPEN — INFRASTRUCTURE`.

`SOURCE FACT` Every locked decision from Phases 10A/10B/12/14/15/16/17 re-verified as intact and is **not reopened**: server-side money authority, single settlement path, SoD, check-in/refund exclusion, cancellation and completion moving no money, PIC reversal at full-item refund, webhook security sequence, and D-61 money representation.

**Verdict:** `DECISION LOCK PARTIALLY COMPLETE — OPEN PRODUCT DECISIONS` (§23).

---

## 2. Authoritative Sources

`SOURCE FACT` Read in full or in the relevant regions, in the live tree, in this phase:

| Area | Files / lines inspected |
|---|---|
| Reports | `PHASE_17_PAYMENT_REFUND_MONEY_DECISION_LOCK.md` (baseline), Phase 10A, Phase 10B (impl + refund audit), Phase 12, Phase 13, Phase 14, Phase 15, Phase 16, `TICKETING_PHASE1_DESIGN.md` |
| Schema | `prisma/schema.prisma` — `Refund` (¶293), `RefundItem` (¶1590), `PICFeeLedger` (¶1447), `PaymentTransaction` (¶1260), `EventOrder`, `Payment`, `WebhookEvent`, `Ticket`; enum `RefundStatus` (¶608) |
| Refund | `lib/ticketing/refunds/{service,settlement,eligibility,validation,payload}.ts` |
| Payment | `lib/ticketing/payment/{settlement,webhook,service,refund-provider,gateway,reference,void,validation}.ts`, `lib/payment/ipaymu.ts` |
| Order / checkout | `lib/ticketing/checkout.ts`, `lib/ticketing/orders.ts`, `lib/ticketing/reservations.ts` |
| Tickets | `lib/ticketing/tickets/{issuance,service,payload}.ts` |
| Events | `lib/events/{service,lifecycle,sales-state,catalog}.ts` |
| Jobs / authz | `lib/jobs/{lock,tick}.ts`, `lib/authz/permissions.ts` |
| Audit | `lib/ticketing/audit-log.ts` |

`SOURCE FACT` Empirical verification (audit-only; nothing written except this report):

| Command | Result |
|---|---|
| `npx prisma validate` | `The schema at prisma/schema.prisma is valid` |
| `npx prisma migrate status` | 21 migrations found · `Database schema is up to date!` |
| `npx tsc --noEmit` | exit 0 (clean) |
| `npx jest --runInBand` (run 1) | 61 suites · 1332 passed · **1 failed** (`payment-races.integration.test.ts:230`) |
| `npx jest __tests__/ticketing-payment/payment-races.integration.test.ts` | **8 passed** in isolation |
| `npx jest --runInBand` (run 2) | **61 suites / 1333 tests passed** |

`SOURCE FACT` **Failure classification: `TEST HARNESS FLAKE` (pre-existing, not a regression).** The single failure in run 1 is a high-concurrency race test (`H1. eight simultaneous Pay clicks produce one provider payment, not eight`) that **passes in isolation and on the second full run**. No file was modified in this phase, so the flake is not attributable to Phase 18A; it is load/ordering-sensitive under a full-suite run. Recorded here rather than hidden, per brief §19.

`EXTERNAL PROVIDER RESEARCH` (performed this phase, to avoid fabricating capability):

| Source | Fact |
|---|---|
| `docs.ipaymu.com/en/docs` (API v2 introduction) | Signature auth (`va`, `signature`, `timestamp`); base URLs `my.ipaymu.com` / `sandbox.ipaymu.com`. No refund endpoint listed. |
| `docs.ipaymu.com/id/docs/verification/refund-policy` | iPaymu requires a **public merchant refund-policy page** for account verification, and its example guidance describes refunds as returned *"melalui transfer ke rekening bank"* or back to the same e-wallet — i.e. a **merchant-executed, manual** process. |
| Public iPaymu API v2 endpoint listing | Payment (COD + callback), Balance, Transaction history, IP/domain validation, Area. A `Refund` value appears as a **transaction status** in transaction history, **not** as an outbound refund endpoint. |

`PROVIDER CAPABILITY` This corroborates D-R17 from outside the repository: **iPaymu cannot be instructed to move money back.** The capability gap is external and real.

---

## 3. Decision Method

`SOURCE FACT` Rules applied to every item in §§4–11:

1. **Source first.** The current implementation is stated before any option is considered.
2. **No policy invented.** Where the repository does not determine a business answer, the section ends `PRODUCT DECISION REQUIRED` (or the provider/infrastructure equivalent) and **no option is marked selected**.
3. **Locked stays locked.** Phases 10B/12/14/15/16/17 decisions are not reopened without concrete contradictory source evidence. None was found.
4. **Classification of each option, not just each decision:**

   | Class | Meaning | Who may decide |
   |---|---|---|
   | `PRODUCT DECISION` | a business rule (who gets money back, when, how much) | product owner |
   | `PROVIDER CAPABILITY` | what the payment provider can be made to do | provider / account holder |
   | `INFRASTRUCTURE DECISION` | what the deployment can run reliably (jobs, polling, cron) | engineering + ops |
   | `SOURCE FACT` | what the code does today | nobody — it is observable |

5. **No technical preference dressed as policy.** "Add a balance CAS" is an implementation candidate, not a product rule; it is listed under §19, never selected here.

`SOURCE FACT` Every option below is expressed so that it is **implementable only after** a corresponding decision exists. This phase implements none of them.

---

## 4. D-P17-05 — Refundable Balance

**Status: `OPEN — PRODUCT`**

### 4.1 Current source

`SOURCE FACT` The arithmetic, exactly as implemented:

```
checkout.ts:81    function roundToRupiah(value)  → ROUND_HALF_UP at 0 decimals
checkout.ts:392   lineSubtotal = roundToRupiah(unitPrice × quantity)   // whole rupiah
checkout.ts:490   subtotal     = Σ lineSubtotal
checkout.ts:494   total        = roundToRupiah(subtotal − discount)    // discount is 0
checkout.ts:551   EventOrderItem.priceSnapshot = line.unitPrice        // ← UN-ROUNDED (2dp)
eligibility.ts:227 lineAmount  = Decimal(ticket.orderItem.priceSnapshot)  // un-rounded
eligibility.ts:238 if (claimSum > refundableBefore) → AMOUNT_EXCEEDS_REFUNDABLE
eligibility.ts:117 refundableBalance = max(total − refundedAmount, 0)
settlement.ts:208  data: { refundedAmount: { increment: amount } }     // ← BLIND increment
settlement.ts:216  fullyRefunded = refundedAmount ≥ total
```

`SOURCE FACT` The guard is evaluated **only at request time** and the settlement write is **unconditional**. There is no `refundedAmount + amount ≤ total` predicate anywhere.

`EXISTING BEHAVIOR` Consequence, source-derivable and reproducible by reasoning alone:

- **With integer-rupiah prices:** `Σ(all priceSnapshots) = total` exactly, and each ticket is claimable once (`RefundItem.ticketId @unique`), so `refundedAmount ≤ total` holds **even under concurrency**. The invariant is safe.
- **With sub-rupiah prices:** (a) a legitimate final ticket can become permanently unrefundable (*stranded ticket*), and (b) two concurrent requests for disjoint tickets can each pass the stale guard and both settle, pushing `refundedAmount` above `total` by up to Rp 0.49 × lines.

`OPEN QUESTION` Whether the platform *permits* sub-rupiah ticket prices is not stated anywhere in the design; `roundToRupiah` exists precisely because prices arrive as arbitrary decimals. So the gap is conditional on a price policy the repository does not currently define.

### 4.2 The options actually supported by the implementation

**OPTION A — All sellable ticket prices must be whole rupiah.**

| Dimension | Consequence |
|---|---|
| Source impact | validation at the ticket-type price edge (currently accepts 2dp decimal strings) |
| Database impact | none (column already `Decimal(14,2)`) |
| API impact | `POST`/`PATCH` ticket type refuses a non-integer price; error shape already exists |
| Checkout impact | `roundToRupiah` becomes a no-op for new orders; existing orders unaffected |
| Refund impact | claim sum equals rounded total by construction; **no settlement change needed** |
| Concurrency | invariant holds structurally; **no race remains** |
| Migration | none |
| Backward compatibility | **existing fractional-price orders retain the gap** unless a data policy is also chosen |
| User-visible | organisers cannot enter `1000.49` |
| Tests required | price-edge rejection; refund math over integer prices (partly exists) |

**OPTION B — Allow fractional prices, enforce the balance at settlement.**

| Dimension | Consequence |
|---|---|
| Source impact | `settlement.ts` settlement write becomes a conditional update |
| Database impact | none required; a `CHECK (refundedAmount ≤ total)` would need a migration if chosen |
| API impact | none |
| Checkout impact | none |
| Refund impact | a settlement that would exceed the balance is refused/rolled back instead of applied |
| Concurrency | gap closes **if** the predicate is part of the same conditional write; a read-then-write check would **not** close it |
| Migration | none required |
| Backward compatibility | full; existing rows untouched |
| User-visible | a stranded fractional remainder becomes an explicit refusal rather than a silent one |
| Tests required | concurrent disjoint-ticket settlement; fractional-price matrix |

**OPTION C — Another source-supported accounting model.**
`SOURCE FACT` None exists in the repository. D-61 (`Decimal(14,2)`, decimal-string input, `moneyString`, `requireSafeRupiah`) constrains any alternative to preserve 2dp decimals; an integer-rupiah column migration is **not** warranted by the source. No further option is presented because none is derivable.

### 4.3 What is already locked and not reopened

`PRODUCT DECISION` (locked, D-P17-01/D-P17-15) Amounts come from stored `priceSnapshot`/`total`; the client can never supply an amount; money stays `Decimal(14,2)` with decimal-string edges.

**PRODUCT DECISION REQUIRED.**

---

## 5. D-P17-06 — Multiple In-flight Refunds

**Status: `OPEN — PRODUCT`** (with one `OPEN — PROVIDER` sub-question)

### 5.1 Current source

`SOURCE FACT` `lib/ticketing/refunds/settlement.ts` (`confirmInboundRefund`):

```
findFirst({ eventOrderId, status: "PROCESSING" }, orderBy: { processedAt: "desc" })
  → refund; if none → { handled: false, reason: "NO_IN_FLIGHT_REFUND" }
  → if amountReported !== null and ≠ refund.requestedAmount → REFUND_AMOUNT_MISMATCH (no mutation)
```

`SOURCE FACT` Schema facts:

- `Refund.refundNumber String? @unique` — unique **but nullable, and unused for callback matching**.
- `Refund.eventOrderId String?` — **no uniqueness**; nothing prevents two `PROCESSING` refunds for one order.
- `Refund.idempotencyKey String? @unique` — declared, **never written** by any code path (locked as D-P17-20, housekeeping).
- `RefundItem.ticketId String @unique` — the only structural guard, and it guarantees *disjoint tickets*, not *one in-flight refund per order*.

`EXISTING BEHAVIOR` Two partial refunds for one order can therefore both be `PROCESSING`. A provider callback carrying `(orderId, amount)` is resolved by `findFirst` + `processedAt desc` + exact-amount equality. When two in-flight refunds report the **same** amount, the callback confirms whichever row sorts first — the other stays `PROCESSING` even though money may have moved for it.

### 5.2 Options

**OPTION A — At most one `PROCESSING` refund per order (platform policy).**

| Dimension | Consequence |
|---|---|
| Concurrency | a second execute attempt is refused while one is in flight |
| UX | a buyer must wait for refund #1 to resolve before requesting/executing a second; partial-refund batching becomes sequential |
| Database | enforceable by a partial unique index or an application CAS at the `APPROVED → PROCESSING` edge |
| API | new refusal reason at `executeRefund` |
| Callback | `(orderId, amount)` matching becomes unambiguous by construction |
| Provider dependency | **none** — pure platform policy |
| Failure/retry | a `FAILED` refund releases claims (locked D-P17-07), unblocking the next |

**OPTION B — Multiple in-flight refunds allowed; every callback must identify the refund.**

| Dimension | Consequence |
|---|---|
| Concurrency | unchanged today (multiple in-flight permitted) |
| UX | unchanged; parallel partial refunds remain possible |
| Database | `Refund.refundNumber` already exists and is unique — usable as the identity, but callbacks currently never carry it |
| API | provider request must include our `refundNumber`; inbound payload must echo it |
| Callback | matching becomes `refundNumber` (or provider refund reference) instead of `(orderId, amount)` |
| Provider dependency | **`OPEN — PROVIDER`: iPaymu cannot originate a refund call at all, and documents no refund callback carrying a refund reference.** Any provider used must prove it echoes a refund identifier before this option is realizable |
| Failure/retry | provider reference must be persisted (`Refund.providerRef` exists) for any reconciliation |

**OPTION C — Another source-supported mechanism.**
`SOURCE FACT` None exists. There is no per-refund provider reference today (`Refund.providerRef` is only written from a provider response that the current rail never produces), and no lock/lease table for refunds. No further option is derivable.

### 5.3 Separation of concerns (brief §13)

`SOURCE FACT` "Only one `PROCESSING` refund per order" is a **platform policy** — implementable with zero provider involvement. "The provider returns/echoes a refund reference" is a **provider capability** — currently absent. These are **not** the same decision and must not be merged: Option A is available today; Option B is blocked until a rail exists.

**PRODUCT DECISION REQUIRED.**

---

## 6. D-P17-09 — Event Cancellation Refunds

**Status: `OPEN — PRODUCT`**

### 6.1 Current source

`SOURCE FACT` `lib/events/service.ts` `cancelEvent` (¶1149), re-verified line by line:

1. `requireEventAccess(eventId, EVENT_PUBLISH)`; archived → refuse.
2. Idempotent replay when already `CANCELLED` (no second audit row).
3. CAS `updateMany({ id, status: current.status, archivedAt: null }) → CANCELLED + cancelledAt + cancelReason` — the transition **is** the guard.
4. For each `PENDING_PAYMENT` order: one transaction, order-status CAS → `EXPIRED`, `releaseOrderReservations`, `voidOpenPayments` (lock order: order → reservations → ticket types).
5. Audit `event.cancel`, `order.expire`, `payment.expired`.
6. **Nothing else.**

`EXISTING BEHAVIOR` Paid orders untouched · issued tickets untouched · **no refund created** · no PIC ledger write · no quota change beyond releasing unpaid holds. This is the Phase 12 lock, holding verbatim.

`SOURCE FACT` The *manual* refund path already works on a cancelled event: `requestRefund` requires only `order.status ∈ {PAID, PARTIALLY_REFUNDED}` and eligibility rules; it does not read `event.status`. So Option A below is **already implemented**; only the automatic variants are new.

### 6.2 Options

**OPTION A — Cancellation creates no refunds; the buyer requests manually.** *(= today)*

| Dimension | Consequence |
|---|---|
| Paid orders | untouched; refund only if the buyer acts |
| Unpaid orders | expired + payments voided (already) |
| Issued tickets | untouched (still `ISSUED`) |
| Checked-in tickets | untouched; **not refundable** (locked D-R05/D-28) |
| Existing PENDING/APPROVED/PROCESSING | untouched |
| Quota | only unpaid holds released (already) |
| PIC fees | untouched |
| Payment ledger | only void rows for unpaid attempts (already) |
| Provider dependency | none |
| Race behaviour | none new |
| Operator workload | **buyers may never request**, leaving paid attendance unrefunded and unbilled expectations unmet |

**OPTION B — Cancellation automatically creates refund requests for eligible paid tickets.**

| Dimension | Consequence |
|---|---|
| Paid orders | one `Refund` per eligible ticket (or per order) created in state `PENDING` |
| Unpaid orders | unchanged (already expired) |
| Issued tickets | become refund *candidates*; still `ISSUED` until settlement |
| Checked-in tickets | **excluded** — must be, per the locked check-in/refund exclusion |
| Existing PENDING/APPROVED/PROCESSING | must be deduplicated, or refused, by the same `RefundItem.ticketId @unique` guard |
| Quota | restored only when a refund is **confirmed** (locked D-R06) |
| PIC fees | reversed only at full-item refund (locked D-P17-11) |
| Payment ledger | one `REFUND` row per confirmed refund |
| Provider dependency | **the flow still terminates at `PROCESSING → FAILED` today** — no rail |
| Race behaviour | bulk creation races the buyer's own manual request; needs idempotent creation |
| Operator workload | one approval/execution decision per created refund — potentially **large** and identical in every case |

**OPTION C — Cancellation creates a refund *batch* requiring a single staff/finance approval.**

| Dimension | Consequence |
|---|---|
| All above | as Option B, but the batch is one decision rather than N |
| Schema | **no batch model exists** (`Refund` has no batch/group column) → would need a schema addition |
| Authorization | refund approval is already tenant-scoped (`REFUND_APPROVE`); SoD rules would need an explicit statement for a batch actor |
| Provider dependency | unchanged — still blocked at execution |
| Operator workload | lowest of the automatic options |

**OPTION D — Cancellation only notifies buyers and exposes the existing manual refund flow.**

| Dimension | Consequence |
|---|---|
| Paid orders | untouched |
| Notification | `SOURCE FACT` no notification sender exists for refund transitions today; audit vocabulary exists, delivery does not |
| Everything else | identical to Option A, plus a signal to the buyer |
| Provider dependency | none |

`PRODUCT DECISION` Options B/C/D are **not** implemented and this phase does not implement them. Phase 12's "cancellation moves no money" remains the live behaviour regardless of which option is chosen, until the chosen option is built.

**PRODUCT DECISION REQUIRED.**

---

## 7. D-P17-12 — PIC Fee Reversal

**Status: `OPEN — PRODUCT`**

### 7.1 Current source

`SOURCE FACT` `reversePicFeesForRefund` (`lib/ticketing/refunds/settlement.ts:347`) runs inside the confirmed-refund transaction:

```
for each distinct orderItemId in the refund:
  earned = PICFeeLedger.findFirst({ orderItemId, type: "EARNED" })      // none → skip
  refundedTickets = Ticket.count({ orderItemId, status: "REFUNDED" })
  fullyRefunded = refundedTickets ≥ orderItem.quantity
  if (!fullyRefunded) continue                                          // ← FEE RETAINED
  if (existing REVERSAL for orderItemId) continue                       // ← double-guard #1
  create({ type: "REVERSAL", direction: "DEBIT", amount: earned.amount, status: "VOID",
           refundId, adjustmentReason: "REFUND",
           idempotencyKey: `fee:reversal:${refundId}:${orderItemId}` }) // ← double-guard #2
```

`SOURCE FACT` Triple idempotency protection: the `findFirst(REVERSAL)` guard, `idempotencyKey @unique`, and the `@@unique([orderItemId, type])` constraint on `PICFeeLedger`.

`EXISTING BEHAVIOR` A partial refund **retains the entire PIC fee**; the full `earned.amount` is reversed **only** once every ticket of that order item is `REFUNDED`. `SOURCE FACT` `settlement.ts:343` documents this as the deliberate D-R16 rule, not an oversight.

`SOURCE FACT` Cancellation touches PIC fees **not at all**; completion touches them **not at all**.

### 7.2 Options

**OPTION A — Keep full-item reversal only.** *(= today, D-R16)*

| Dimension | Consequence |
|---|---|
| Accounting semantics | the PIC is paid for *placing the admission*, and keeps the fee while any admission remains sold |
| Multiple tickets / order item | fee survives until the last ticket refunds |
| Partial refunds | fee retained, in full, for every partial state |
| Decimal arithmetic | none added — the reversal amount is the stored `earned.amount` |
| Rounding | none — no division occurs |
| Duplicate safety | unchanged (triple-guarded) |
| Ledger implications | a refunded ticket can exist while the full fee stands — **by design**, and needs to be stated in any operator-facing reconciliation |
| Audit implications | unchanged |

**OPTION B — Proportional reversal by refunded ticket share.**

| Dimension | Consequence |
|---|---|
| Accounting semantics | the PIC earns a fraction of the fee equal to the sold-but-not-refunded share |
| Multiple tickets / order item | requires a deterministic numerator/denominator across *sequential* partial refunds (each refund sees only its own tickets) |
| Partial refunds | each confirmed refund reverses its share |
| Decimal arithmetic | **division is required** — `amount × refunded/quantity` |
| Rounding | must be specified: `ROUND_HALF_UP` per reversal leaves a residue; a "reverse remainder on the final ticket" rule is needed to land exactly on `earned.amount` |
| Duplicate safety | the current per-`refundId` idempotency key is **insufficient** — a proportional model needs a cumulative rule, i.e. `reversedSoFar + share ≤ earned.amount` with a CAS |
| Ledger implications | `REVERSAL` rows become partial; `amount = earned.amount` no longer holds; `status = VOID` semantics must be redefined |
| Audit implications | each partial reversal needs its own basis (`refunded/quantity`) recorded |

**OPTION C — Another source-supported accounting rule.**
`SOURCE FACT` **None exists.** The repository contains no proportional fee formula, no fee-split helper, and no `reversedSoFar` aggregate. Option B would require **inventing** a formula, which brief §6 forbids. It is listed because the product owner may legitimately choose it, but its arithmetic would have to be specified by the product owner, not derived from source.

`PRODUCT DECISION` D-R16's retained-fee rule is **not a bug** and is not reopened.

**PRODUCT DECISION REQUIRED.**

---

## 8. D-P17-16 — Stuck `PROCESSING` Refunds

**Status: `OPEN — PROVIDER` + `OPEN — INFRASTRUCTURE`**

### 8.1 Current source

`SOURCE FACT` The failure mode is structural, not accidental: `executeRefund` performs the `APPROVED → PROCESSING` CAS **before** the provider call, and the provider call is deliberately **outside** the DB transaction. If the provider moves money and the process then dies, the row stays `PROCESSING` forever.

`SOURCE FACT` There is **no reconciliation service**:

- No reconciliation route (`find app -name "*reconcil*"` → nothing).
- No polling job; `lib/jobs/tick.ts` registers exactly two jobs (`JOB_NAMES.EVENT_LIFECYCLE`, `JOB_NAMES.RESERVATION_REAPER`), neither refund-related.
- `PAYMENT_RECONCILE` (`"payment.reconcile"`) permission key **exists** in `lib/authz/permissions.ts` (¶141) and is granted to several roles — and has **zero consumers**.
- `verifyPaymentStatus(sessionId)` exists in `lib/payment/ipaymu.ts` (¶1283) and is **never called**; `webhook.ts:86` states: *"No provider `verifyPaymentStatus` call. A server-side status poll is not a settlement."*
- `PaymentTransaction.providerTransactionId` is **indexed, not unique**.

`SOURCE FACT` **The reconciliation seam is real but payment-shaped.** `verifyPaymentStatus` answers "what happened to payment session X?" — it cannot answer "did refund Y move money?", because iPaymu exposes no refund object.

### 8.2 Current provider capability (stated separately, per brief §7)

`PROVIDER CAPABILITY` Today: the configured rail **cannot originate a refund at all**, let alone report on one. A `PROCESSING` refund can therefore only arise if a real rail exists. **The stuck-`PROCESSING` problem is not currently reachable in production — but it becomes reachable the moment a rail is chosen.** This ordering matters: D-P17-16 cannot be resolved before D-P17-04.

### 8.3 Options

**OPTION A — Manual operator reconciliation.**

| Dimension | Consequence |
|---|---|
| Mechanism | an authorized operator records the outcome against evidence they hold outside the system |
| Evidence required | provider reference, provider status, provider amount, timestamp, operator identity, audit note |
| Schema | the fields largely exist (`Refund.providerRef`, `completedAt`, `processedByUserId`) but there is **no operator-facing surface** and no "evidence" field |
| Authority | must reuse `REFUND_EXECUTE` (no new permission key) |
| Risk | **an operator marking `REFUNDED` without an evidence model is indistinguishable from a fabricated refund** — the exact thing D-R17 forbids |

**OPTION B — Provider polling / reconciliation job.**

| Dimension | Consequence |
|---|---|
| Mechanism | a third job in `runJobsTick` queries the provider for in-flight refunds |
| Provider dependency | **blocked** — no provider refund-status endpoint exists to poll for refunds |
| Infrastructure | the automated tick + `JobLock` lease already exist (`lib/jobs/{lock,tick}.ts`), so the *scheduling* half is free; only the *query* half is missing |
| Evidence required | provider status + amount + reference, per refund |

**OPTION C — Provider webhook + periodic reconciliation.**

| Dimension | Consequence |
|---|---|
| Mechanism | inbound refund callback (already implemented as `confirmInboundRefund`) **plus** a periodic sweep for callbacks that never arrive |
| Provider dependency | **blocked** — requires a rail that both emits a refund callback *and* offers a status query |
| Current state | the inbound half exists and is idempotent; the sweep half does not |

**OPTION D — Another mechanism actually supported by the chosen rail.**
`SOURCE FACT` Undecidable until D-P17-04 is decided. Listing a mechanism before the rail exists would be fabrication.

### 8.4 Evidence model (required for any option)

`INFRASTRUCTURE DECISION` Whatever is chosen, a refund may only leave `PROCESSING` on **authoritative evidence**, and the states reachable are exactly `PROCESSING → REFUNDED` or `PROCESSING → FAILED`. Minimum evidence set:

| Evidence | Field today |
|---|---|
| provider refund reference | `Refund.providerRef` (exists, written from provider response) |
| provider status | none |
| provider amount | none (the ledger row carries our own amount) |
| timestamp | `Refund.completedAt` / `failedAt` (exist) |
| operator identity (if manual) | `Refund.processedByUserId` (exists) |
| audit note | `Refund.failureReason` is failure-only; a neutral note field does not exist |

`SOURCE FACT` An operator **must not** be able to write `REFUNDED` with no evidence model; that prohibition is locked and is not reopened by this phase.

**INFRASTRUCTURE / PROVIDER DECISION REQUIRED.**

---

## 9. D-P17-17 — Late Settlement / `fulfilmentBlockedAt`

**Status: `OPEN — PRODUCT`**

### 9.1 Current source

`SOURCE FACT` `lib/ticketing/payment/settlement.ts` step 4 (¶296): the settlement CAS is `where { id, status: PENDING_PAYMENT, paymentStatus: { not: PAID } }`. When it returns `count = 0` and the order is `CANCELLED` or `EXPIRED`, the **late-settlement branch** (¶330) runs:

```
updateMany({ where: { id, status IN (CANCELLED, EXPIRED), paymentStatus: { not: PAID } },
             data: { paymentStatus: "PAID", paidAt: COALESCE(paidAt, now),
                     fulfilmentBlockedAt: COALESCE(fulfilmentBlockedAt, now) } })
settlePaymentRow(...)   // the money IS recorded — the ledger is truthful
```

`SOURCE FACT` **Order status is deliberately unchanged.** No reservation is converted, no counter moves, no tickets are created.

`SOURCE FACT` `assertOrderIsFulfillable` (`lib/ticketing/tickets/issuance.ts:158`) checks `fulfilmentBlockedAt !== null` **first** and refuses with `FULFILMENT_BLOCKED` — explicitly ordered first because the blocked combination is the *overspecified* one and checking status first would misreport a paid order as unpaid.

`EXISTING BEHAVIOR` The result is a terminal mismatch state — `status = CANCELLED|EXPIRED` **and** `paymentStatus = PAID` **and** `fulfilmentBlockedAt ≠ null` — with money in the ledger and no fulfilment. `SOURCE FACT` there is **no resolution surface** of any kind (no route, no admin action, no job).

### 9.2 Options

**OPTION A — Refund the late payment.**

| Dimension | Consequence |
|---|---|
| Mechanism | convert the blocked order into a refund claim |
| Provider dependency | **blocked by the rail decision** (same wall as every other refund) |
| Seats | must **not** be re-taken; the reservation was already released |
| Audit | a new action would be needed |
| Risk | if the buyer has already been made whole by an out-of-band transfer, this double-refunds |

**OPTION B — Allow an operator to restore fulfilment manually.**

| Dimension | Consequence |
|---|---|
| Mechanism | authorized operator clears `fulfilmentBlockedAt` so the buyer can issue tickets |
| Seats | the original reservation is gone; restoring fulfilment requires **re-acquiring inventory** at current availability — not guaranteed |
| Risk | **could oversell** if availability changed; must be an explicit, audited decision, never automatic |
| Authority | must reuse an existing permission (no new key) |
| Evidence | operator identity + reason (+ audit row) |

**OPTION C — Keep blocked; reconcile manually outside the system.** *(= today)*

| Dimension | Consequence |
|---|---|
| Mechanism | nothing changes; the operator uses the mismatch state and resolves it off-platform |
| Cost | no visibility surface; the state is discoverable only by querying the database |
| Risk | the condition is silently durable — acceptable only if an operator actually looks |

**OPTION D — Another source-supported policy.**
`SOURCE FACT` None derivable. `fulfilmentBlockedAt` has exactly two writers (settlement) and one reader (issuance); no other policy harness exists.

`SOURCE FACT` **Invariant that binds all four options:** a late settlement must **never** silently create tickets or restore inventory. Any chosen option must preserve that.

**PRODUCT DECISION REQUIRED.**

---

## 10. D-P17-18 — Paid Without Tickets

**Status: `OPEN — PRODUCT`**

### 10.1 Current source

`SOURCE FACT` Ticket issuance is **not** part of settlement. Settlement marks the order `PAID` and converts reservations; tickets are created by a separate, **buyer-triggered**, ownership-gated, idempotent endpoint (`POST /api/ticketing/orders/[orderNumber]/issue`).

`SOURCE FACT` `assertOrderIsFulfillable` requires `fulfilmentBlockedAt = null`, `status = PAID`, `paymentStatus = PAID`, `paidAt ≠ null`. Issuance then takes the order row lock and writes only missing `(orderItemId, sequenceNo)` pairs. Idempotency is structural: `Ticket @@unique([orderItemId, sequenceNo])` plus a presence check inside the lock.

`EXISTING BEHAVIOR` A settled order whose buyer never returns remains **`PAID` with zero tickets**, and **no job covers it**.

### 10.2 Options

**OPTION A — Keep buyer-triggered issuance; add notification and operator visibility.**

| Dimension | Consequence |
|---|---|
| Idempotency | unchanged — the existing structural guarantee is preserved |
| Crash recovery | unchanged |
| Ticket uniqueness | unchanged |
| `fulfilmentBlockedAt` | respected (buyer cannot self-serve past it) |
| Settlement transaction | untouched — keeps settlement fast and single-purpose |
| Notification | `SOURCE FACT` no notification sender exists for this today; needs building |
| Race with manual issuance | none new |
| Duplicate ticket risk | none — uniqueness is structural |

**OPTION B — Automatically issue tickets after settlement.**

| Dimension | Consequence |
|---|---|
| Mechanism | in-transaction (issuance joins the settlement transaction) **or** post-settlement job |
| Idempotency | must reuse the `(orderItemId, sequenceNo)` uniqueness; safe if reused |
| Crash recovery | in-transaction: atomic with settlement, no orphan. Post-settlement: a job must be idempotent — which the existing structural guard already provides |
| Settlement transaction | **in-transaction extends the settlement's lock window** (order row → reservations → ticket types → ticket inserts) and lengthens the critical section under webhook load |
| `fulfilmentBlockedAt` | must be honoured — a blocked order must still not receive tickets |
| Race with manual issuance | safe via the same uniqueness constraint |
| Duplicate ticket risk | none, if it goes through the existing service |
| Notification | still separately required |

**OPTION C — Queue issuance asynchronously.**

| Dimension | Consequence |
|---|---|
| Mechanism | a third job in `runJobsTick`, or an enqueue-and-worker |
| Infrastructure | `SOURCE FACT` the tick + `JobLock` lease already exist; **no queue/Redis/BullMQ exists and Phase 14 D-P14-09 forbids introducing one** |
| Idempotency | same structural guarantee applies |
| Crash recovery | the sweep re-runs until tickets exist |
| Duplicate ticket risk | none |
| Latency | tickets appear on the next tick, not instantly |

**OPTION D — Another architecture-compatible approach.**
`SOURCE FACT` None derivable beyond the three above; the issuance service is the only ticket creator and is already idempotent.

`SOURCE FACT` **The design question is genuinely open and must be answered explicitly:** should issuance be *same transaction* or *post-settlement*? The brief's own instruction is to evaluate this rather than assume — and the source provides no answer.

**PRODUCT DECISION REQUIRED.**

---

## 11. Refund Provider / Rail

**Status: `OPEN — PROVIDER` — the largest blocker.**

### 11.1 The blocker, stated precisely

`PROVIDER CAPABILITY` **iPaymu has no outbound refund API.** This phase re-verified it from source (`refund-provider.ts` returns `UNSUPPORTED` for every call — D-R17) **and** externally:

- `docs.ipaymu.com/en/docs` lists signature auth and base URLs; no refund endpoint.
- The public API v2 endpoint listing contains Payment, Balance, Transaction history, IP/domain validation and Area.
- `docs.ipaymu.com/id/docs/verification/refund-policy` requires merchants to publish a **refund policy** and describes the refund itself as returned *"melalui transfer ke rekening bank"* or back to the originating e-wallet — a **merchant-executed manual process**.
- A `Refund` value appears as a **transaction status** in transaction history, not as an outbound operation.

`EXISTING BEHAVIOR` Consequence: **no refund can reach `REFUNDED` in production through the configured rail.** `executeRefund` correctly ends at `FAILED / PROVIDER_UNSUPPORTED`. This is truthful failure, not a defect — and it is why every option below except A/B/D remains unimplementable today.

### 11.2 Options

**OPTION A — Choose a payment provider with a supported refund API.**

| Dimension | Consequence |
|---|---|
| Source of funds | provider-held merchant balance |
| Provider dependency | total — requires a new gateway adapter and a migration of in-flight payments |
| Refund reference | provider-issued; `Refund.providerRef` is the field |
| Confirmation | provider callback and/or status query |
| Webhook/polling | both become available; the inbound handler already exists |
| Reconciliation | unlockable (D-P17-16) |
| Audit evidence | provider reference + status + amount |
| Failure handling | `DECLINED` / `PROVIDER_ERROR` paths already exist and are meaningful |
| Partial refund | depends on the chosen provider — must be verified, not assumed |
| Full refund | same |
| Security | signature verification already implemented generically (`verifyCallbackSignature`) |
| Operational burden | **lowest ongoing**; highest integration/migration cost |

**OPTION B — Manual bank transfer refund (merchant-executed).**

| Dimension | Consequence |
|---|---|
| Source of funds | the merchant's own bank account |
| Provider dependency | **none** — this matches what iPaymu documents today |
| Refund reference | `Refund.providerRef` can hold a bank transfer reference/note; `processedByUserId` holds the operator |
| Confirmation | **manual** — the operator asserts completion |
| Webhook/polling | none available; reconciliation is human |
| Reconciliation | D-P17-16 reduces to "operator records evidence" (Option A of §8) |
| Audit evidence | operator identity + note + timestamp; **needs an evidence model to be legitimate** |
| Failure handling | manual |
| Partial refund | yes, by transferred amount — **but must still reconcile against the claim** |
| Full refund | yes |
| Security | must not let a client assert a bank transfer happened |
| Operational burden | **high and per-transaction**; scales linearly with refund volume |

**OPTION C — Wallet / store credit.**

| Dimension | Consequence |
|---|---|
| Source of funds | platform-held credit, not money returned to the buyer's bank |
| Provider dependency | none |
| Schema | **`SOURCE FACT` no credit/wallet ledger model exists** — would require a new model |
| Legal/consumer framing | `OPEN QUESTION` outside the repository's evidence; the brief forbids assuming legal rules, so this is flagged for the product owner's own determination |
| Confirmation | platform-internal, fully auditable |
| Partial/full | both natural |
| Operational burden | lowest, but it is **not a refund of money** in the ordinary sense |

**OPTION D — Another real provider-supported rail.**
`SOURCE FACT` Undecidable without naming a provider. Per brief §10, no provider is recommended here because this phase cannot verify a specific vendor's refund API from the repository; doing so would mean fabricating capability.

`EXTERNAL PROVIDER RESEARCH REQUIRED` Any provider named under Option A or D must be verified against its own refund documentation before it may be integrated. This phase verified **iPaymu only**, and only to establish that its rail does not exist.

**PROVIDER / PRODUCT DECISION REQUIRED.**

---

## 12. Money Accounting Invariants

`SOURCE FACT` These are invariants, **not** product choices. They are already true in the source (verified) and every option in §§4–11 must preserve them.

| # | Invariant | Status in source |
|---|---|---|
| 1 | A confirmed refunded amount can never exceed the refundable amount | **holds for integer prices; conditional gap under fractional prices (§4)** |
| 2 | The client cannot choose the confirmed refund amount | holds — absent from every request schema |
| 3 | A provider-reported amount cannot silently override the server claim | holds — `confirmInboundRefund` requires exact equality or null |
| 4 | Duplicate refund confirmation cannot duplicate money movement | holds — CAS `PROCESSING → REFUNDED` → `ALREADY_REFUNDED` |
| 5 | Duplicate payment webhook cannot duplicate settlement | holds — `WebhookEvent.providerEventId @unique` + CAS |
| 6 | Check-in cannot coexist with a confirmed refund | holds — row locks + `REFUND_PENDING` gate (Phase 15) |
| 7 | Quota restore happens only after a confirmed refund | holds — inside the settlement transaction |
| 8 | PIC reversal happens only per the locked fee policy | holds — D-R16, triple-guarded |
| 9 | Completion never moves money | holds — Phase 15 verified |
| 10 | Cancellation never moves money unless an explicit refund policy authorizes it | holds — Phase 12 verified |
| 11 | Every money movement has an auditable transaction | holds — `PaymentTransaction` + audit-log vocabulary |
| 12 | No fake provider success | holds — `UNSUPPORTED` is a first-class truthful outcome |

`SOURCE FACT` Invariant 1 is the only one with a conditional gap, and §4 is exactly that gap.

---

## 13. Accounting Edge Case Matrix

`SOURCE FACT` Current behaviour is stated from the implementation, not assumed. "Decision required" names the section that must be settled first.

| # | Case | Current behavior | Safe? | Decision required | Future phase |
|---|---|---|---|---|---|
| 1 | Integer price, one ticket, full refund | `amount = total`; order → `REFUNDED` | **safe** | none | — |
| 2 | Fractional price, one ticket, full refund | claim `1000.49 > 999.02` possible → stranded | **unsafe** | §4 | 18 |
| 3 | Integer price, multiple tickets, partial refund | monotonic balance shrink | **safe** | none | — |
| 4 | Integer price, full refund across tickets | `refundedAmount = total` | **safe** | none | — |
| 5 | Two simultaneous refund requests (disjoint tickets) | both may pass a stale guard | **unsafe only if fractional** | §4 | 18 |
| 6 | Duplicate refund callback | second `ALREADY_REFUNDED` | **safe** | none | — |
| 7 | Two in-flight refunds, same amount, one callback | `findFirst` confirms one; other sticks `PROCESSING` | **unsafe** | §5 | 18 |
| 8 | Payment callback ∥ refund callback | independent ledger rows | **safe** | none | — |
| 9 | Check-in ∥ refund confirmation | row lock; exactly one winner | **safe** | none | — |
| 10 | Cancellation + refund | cancellation moves no money; manual refund path still works | **safe** | §6 (policy only) | 18+ |
| 11 | Completion + refund | completion moves no money; refunds continue | **safe** | none | — |
| 12 | Late payment | money recorded, fulfilment blocked, no seats | **safe but unresolved** | §9 | 18+ |
| 13 | Paid, no tickets | buyer must return; no job | **safe but unresolved** | §10 | 18+ |
| 14 | Provider timeout (refund) | `FAILED`, claims released | **safe** | none | — |
| 15 | Provider success + application crash | stuck `PROCESSING`, money possibly gone | **unsafe but unreachable today** | §8 + §11 | 18+/19 |
| 16 | Refund execution with no rail | `FAILED / PROVIDER_UNSUPPORTED` | **safe (truthful)** | §11 | 18 |

`SOURCE FACT` Rows 6, 8, 9, 10, 11, 14, 16 are the locked core and are correct. The unsafe rows are 2, 5, 7 and 15 — and **15 is currently unreachable** because of 16.

---

## 14. Product vs Provider vs Infrastructure

`SOURCE FACT` The boundary, kept explicit per brief §13:

| Concern | Class | Why |
|---|---|---|
| Prices must be whole rupiah | **PRODUCT POLICY** | a commercial decision about what may be sold |
| Balance must be enforced at settlement | **PRODUCT POLICY** → then **engineering** | the *rule* is a policy; the CAS is its implementation |
| Only one in-flight refund per order | **PRODUCT POLICY** | a UX/business decision |
| Provider echoes a refund reference | **PROVIDER CAPABILITY** | not ours to decide |
| System polls the provider every N minutes | **INFRASTRUCTURE DECISION** | ops/deloyment capacity |
| Cancellation creates refunds | **PRODUCT POLICY** | money + buyer expectations |
| Proportional PIC reversal | **PRODUCT POLICY** | a commercial split |
| Operator may mark a refund REFUNDED | **PRODUCT POLICY** + needs an **evidence model** | who may assert money moved |
| Choose a payment provider with refunds | **PRODUCT + PROVIDER DECISION** | commercial + technical |
| A third job in `runJobsTick` | **INFRASTRUCTURE DECISION** | bounded by the existing single-flight design |

`SOURCE FACT` Merging any two rows above would be exactly the error the brief warns against: e.g. "allow multiple in-flight refunds" (policy) **cannot** be satisfied by "the provider will return a reference" (capability that does not exist today).

---

## 15. Locked Decisions

`SOURCE FACT` Locked by source and/or prior phases. **Not reopened; no contradictory evidence found in this phase.**

| ID | Decision | Evidence |
|---|---|---|
| L-18A-01 | Money authority is server-side; client can never set amount, currency, status, providerRef or confirmedAmount | request schemas; `eligibility.ts` |
| L-18A-02 | One authoritative settlement path (CAS `PENDING_PAYMENT + not PAID`); late settlement records money without fulfilment | `settlement.ts:296-372` |
| L-18A-03 | Ticket issuance is separate, buyer-triggered, ownership-gated, idempotent | `issuance.ts`, `Ticket @@unique([orderItemId, sequenceNo])` |
| L-18A-04 | No fake refund success; `UNSUPPORTED` is a truthful terminal outcome | `refund-provider.ts` (D-R17) |
| L-18A-05 | Refund lifecycle `PENDING → APPROVED → PROCESSING → REFUNDED \| FAILED`, with SoD at approve/reject/execute | `refunds/service.ts` |
| L-18A-06 | Failed refund releases claims; retry is a new request; no automatic retry | `processFailedRefund`, `releaseRefundClaims` (D-P17-07) |
| L-18A-07 | Cancellation moves no money and creates no refunds | `events/service.ts:1149` (Phase 12) |
| L-18A-08 | Completion moves no money and waits for nothing | Phase 15 `completeEvent` |
| L-18A-09 | PIC reversal only at full order-item refund, full amount, triple-idempotent | `settlement.ts:347-425` (D-R16) |
| L-18A-10 | Check-in and refund are mutually exclusive; open refund blocks check-in | Phase 14 D-28 + Phase 15 `REFUND_PENDING` |
| L-18A-11 | Webhook sequence: 64 KiB bound → timing-safe signature fail-closed → amount → replay claim → act | `webhook.ts` |
| L-18A-12 | Money representation D-61 (`Decimal(14,2)`, decimal-string edges, `moneyString`, `requireSafeRupiah`) | source-wide |
| L-18A-13 | `PaymentTransaction.providerTransactionId` non-uniqueness is a documented gap, not an oversight | `schema.prisma:1282` |
| L-18A-14 | An operator may never write `REFUNDED` without an evidence model | brief §7 + D-R17 |

---

## 16. Open Product Decisions

| ID | Decision | Options in this report | Blocks |
|---|---|---|---|
| D-P17-05 | Refundable-balance integrity | §4 A / B (C not derivable) | balance CAS work |
| D-P17-06 | In-flight refunds per order + callback matching | §5 A / B (C not derivable) | refund concurrency work |
| D-P17-09 | Cancellation → refund policy | §6 A / B / C / D | cancellation refund work |
| D-P17-12 | Proportional PIC reversal | §7 A / B (C not derivable) | PIC fee work |
| D-P17-17 | Late settlement remediation | §9 A / B / C / D | operator remediation work |
| D-P17-18 | Paid-but-unissued orders | §10 A / B / C / D | issuance automation work |
| D-P17-04 | Refund rail selection (partly product) | §11 A / B / C / D | **everything refund-related** |

---

## 17. Open Provider Decisions

| ID | Decision | Fact | Consequence |
|---|---|---|---|
| D-P17-04 | Which rail returns money to buyers | `PROVIDER CAPABILITY` iPaymu cannot refund; documents refunds as a merchant manual process | **No refund can reach `REFUNDED` in production today** |
| D-P17-06 (sub) | Provider must echo a refund reference for callback matching (Option B) | no such capability today | Option B unrealizable until a rail exists |
| D-P17-16 (sub) | Provider must expose a refund status for polling (Options B/C) | no such capability today | polling-based reconciliation unrealizable |

---

## 18. Open Infrastructure Decisions

| ID | Decision | Fact | Notes |
|---|---|---|---|
| D-P17-16 | How a stuck `PROCESSING` refund is reconciled | `PAYMENT_RECONCILE` key exists with **zero consumers**; `verifyPaymentStatus()` exists and is deliberately uncalled; `webhook.ts:86` documents why | The **scheduling** half already exists (`runJobsTick` + `JobLock`); only the provider **query** half is missing — hence the provider dependency |
| D-P17-17 | Whether an operator remediation surface is built | no route, action or job exists | authority must reuse an existing permission key |
| D-P17-18 | Whether issuance gets a job (sweep) vs in-transaction | tick + lease exist; adding a job is a bounded change | Phase 14 D-P14-09 forbids queues/Redis; a tick job is the compliant form |
| D-P17-05 | Whether a DB `CHECK (refundedAmount ≤ total)` is added | none today | would require an additive migration if chosen |

---

## 19. Phase 18 Implementation Contract

`SOURCE FACT` What Phase 18 **may** implement, and what it must not start. **Nothing here is authorized by this phase** — each item is gated on the decision named.

| Candidate | Gate | Status |
|---|---|---|
| Whole-rupiah price validation at the ticket-type edge | D-P17-05 = Option A | **BLOCKED** |
| Conditional balance CAS at refund settlement | D-P17-05 = Option B | **BLOCKED** |
| One-in-flight-refund guard per order | D-P17-06 = Option A | **BLOCKED** |
| Callback matching by `refundNumber` / provider reference | D-P17-06 = Option B **and** D-P17-04 provider capability | **BLOCKED** |
| Populate or drop `Refund.idempotencyKey` | housekeeping (D-P17-20) | **DEFERRED** |
| Make `PaymentTransaction.providerTransactionId` unique | D-P17-21, needs rail context | **DEFERRED** |
| Reconciliation of stuck `PROCESSING` refunds | D-P17-16 + D-P17-04 | **BLOCKED** |
| Operator remediation surface for `fulfilmentBlockedAt` | D-P17-17 | **BLOCKED** |
| Cancellation refund workflow | D-P17-09 | **BLOCKED** |
| Automatic or swept issuance | D-P17-18 | **BLOCKED** |
| Proportional PIC reversal | D-P17-12 | **BLOCKED** |
| Outbound refund adapter for a new rail | D-P17-04 | **BLOCKED (PROVIDER)** |
| Fee engine expansion, coupons, payouts, ticket transfer/void/reissue | — | **OUT OF SCOPE** |
| Legacy retail table cleanup / `refund_backup_phase10b` | — | **OUT OF SCOPE** |

`SOURCE FACT` **No candidate in this table is `READY`.** Every implementable candidate depends on a decision this phase is forbidden to make. That is the intended and correct outcome of a decision-lock phase.

---

## 20. Phase 19+ Dependencies

`DEFERRED` Items that must **not** enter Phase 18:

- Provider/rail integration under D-P17-04 (must precede every refund feature).
- Fee engine expansion: platform fee > 0, PIC payout (`Settlement` / `SettlementItem`), D-22/D-23.
- Coupons/discounts (`discount` is fixed at 0 and refused at checkout).
- Refund-state notifications (audit vocabulary exists; no sender does).
- Ticket transfer / void / reissue.
- Advanced scanner / camera decoding (Phase 16 locked the manual + keyboard-wedge contract).
- Legacy retail table and `refund_backup_phase10b` cleanup.
- Unrelated UI work.

`SOURCE FACT` Each of these is supported by existing structure or explicitly deferred by a prior phase; none is invented.

---

## 21. Non-Decisions

`SOURCE FACT` Explicitly **not** decided or changed by this phase:

- No refund policy selected. No option in §§4–11 is marked chosen.
- No automatic refund invented for `CANCELLED` or `COMPLETED`.
- No proportional PIC fee formula invented.
- No operator "mark as REFUNDED" capability invented, and no evidence model fabricated.
- No provider recommended or integrated; no vendor capability asserted beyond iPaymu's documented surface.
- No change to Phase 10B refund lifecycle, Phase 12 cancellation, Phase 13/16 check-in, Phase 14 lifecycle, Phase 15 automation, Phase 16 wallet/QR.
- No new permission key, no new role, no new job, no new cron, no queue.
- No schema change, no migration, no dependency, no config or environment change.
- No source, test, or configuration file modified.
- No commit, push, reset, or destructive database action.
- No cleanup of the 30 legacy retail tables or `refund_backup_phase10b`.

---

## 22. Final Decision Table

| ID | Decision | Status | Evidence | Implementation consequence | Phase |
|---|---|---|---|---|---|
| D-P17-01 | Server-side amount authority | **LOCKED** | request schemas; `eligibility.ts` | none — regression tests only | 17 |
| D-P17-02 | Single CAS settlement path; late settlement records without fulfilment | **LOCKED** | `settlement.ts:296-372` | none | 17 |
| D-P17-03 | Issuance is separate, buyer-triggered, idempotent | **LOCKED** | `issuance.ts:158` | none | 17 |
| D-P17-04 | Outbound refund rail | **OPEN — PROVIDER** | `refund-provider.ts` (D-R17); iPaymu docs describe manual merchant refunds | no `REFUNDED` reachable in production until chosen | 18 |
| D-P17-05 | Refundable balance (stranded ticket / sub-rupiah over-refund) | **OPEN — PRODUCT** | `checkout.ts:81/392/551`, `eligibility.ts:227/238`, `settlement.ts:208` | whole-rupiah prices **or** settlement balance CAS | 18 |
| D-P17-06 | Multiple in-flight refunds + callback matching | **OPEN — PRODUCT** | `settlement.ts:508`; no unique constraint; `Refund.refundNumber` unused for matching | one-in-flight guard and/or match by refund number (+ provider echo) | 18 |
| D-P17-07 | Failed refund releases claims; no automatic retry | **LOCKED** | `processFailedRefund` | none | 17 |
| D-P17-08 | Cancellation moves no money | **LOCKED** | `events/service.ts:1149` | none | 17 |
| D-P17-09 | Cancellation → refund policy | **OPEN — PRODUCT** | source silent beyond the Phase 12 lock | bulk/notify/nothing per §6 | 18 |
| D-P17-10 | Completion moves no money and waits for nothing | **LOCKED** | Phase 15 | none | 17 |
| D-P17-11 | PIC reversal only at full order-item refund, triple-idempotent | **LOCKED** | `settlement.ts:347-425` | none | 17 |
| D-P17-12 | Proportional PIC reversal | **OPEN — PRODUCT** | D-R16 retained-fee rule | needs a product-specified formula | 18 |
| D-P17-13 | Check-in and refund mutually exclusive | **LOCKED** | Phase 14 D-28 + Phase 15 `REFUND_PENDING` | none | 17 |
| D-P17-14 | Webhook security sequence | **LOCKED** | `webhook.ts` | none | 17 |
| D-P17-15 | Money representation D-61 | **LOCKED** | source-wide | none | 17 |
| D-P17-16 | Reconciliation for stuck `PROCESSING` refunds | **OPEN — PROVIDER** + **OPEN — INFRASTRUCTURE** | no reconciliation consumer; `PAYMENT_RECONCILE` unused; `verifyPaymentStatus` uncalled; `webhook.ts:86` | provider refund status needed; scheduling half already exists | 18 |
| D-P17-17 | Late-settlement / `fulfilmentBlockedAt` remediation | **OPEN — PRODUCT** | `settlement.ts:330-360`; `issuance.ts:158`; no resolution surface | refund / restore / keep-blocked per §9 | 18 |
| D-P17-18 | Paid-without-tickets | **OPEN — PRODUCT** | buyer-triggered issuance; no job | notification+visibility / auto-issue / sweep per §10 | 18 |
| D-P17-19 | Fee engine expansion, coupons | **DEFERRED** | `gatewayFee` recorded; fees 0 | later phase | 19+ |
| D-P17-20 | `Refund.idempotencyKey` declared but never written | **DEFERRED** | `schema.prisma:318`; no writer | populate or drop later | 18+ |
| D-P17-21 | `PaymentTransaction.providerTransactionId` not unique | **DEFERRED** | `schema.prisma:1282` | reconsider with a rail | 18+ |
| D-P17-22 | Legacy retail tables / `refund_backup_phase10b` | **OUT OF SCOPE** | pre-existing `migrate diff` proposals | explicit cleanup phase | — |
| D-P17-23 | `PAYMENT_RECONCILE` permission declared with zero consumers | **OPEN — INFRASTRUCTURE** | `permissions.ts:141`; no consumer | wire into a reconciliation surface or leave dormant | 18+ |

---

## 23. Final Verdict

`SOURCE FACT` Audited in full and verified empirically. **No locked decision was contradicted.**

What is settled:

- Payments, settlement, idempotency, webhook security, SoD, tenant isolation, check-in/refund exclusion and money representation are **sound and unchanged**.
- Cancellation and completion move no money, exactly as locked.
- The balance gap is real, **conditional on a price policy the repository does not define**, and its two consequences (stranded ticket, sub-rupiah over-refund) are source-derivable.
- The multi-in-flight gap is real and unconstrained.
- The rail gap is real, external, and independently corroborated.

What remains genuinely open — and must stay open, because the source cannot answer it and this phase is forbidden to guess:

- **7 open product decisions** (D-P17-05, 06, 09, 12, 17, 18, plus the product half of D-P17-04).
- **3 provider capability questions** (rail, refund-reference echo, refund status query).
- **2 infrastructure decisions** (reconciliation surface, operator remediation surface).

`SOURCE FACT` **No Phase 18 implementation candidate is `READY`.** Every one is gated on a decision this phase deliberately did not make. Phase 18 cannot begin until the product owner selects the §4–§11 options.

**FINAL VERDICT: `DECISION LOCK PARTIALLY COMPLETE — OPEN PRODUCT DECISIONS`**

Stated plainly: the money *machinery* is correct; the money *policy* is not the developer's to decide. Phase 18 cannot ship a working refund, a cancellation refund policy, a proportional fee rule, or reconciliation until the product owner chooses — and, for the rail, until a provider capable of returning money is selected.

---

### Verification & worktree

| Item | Result |
|---|---|
| `npx prisma validate` | valid |
| `npx prisma migrate status` | 21 migrations · up to date |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx jest --runInBand` | 61 suites / 1333 tests passed on the confirming run |
| Intermittent failure | `__tests__/ticketing-payment/payment-races.integration.test.ts:230` failed once under a full-suite run, passed in isolation and on re-run → `TEST HARNESS FLAKE`, pre-existing, not attributable to this phase |
| Files written by this phase | `PHASE_18A_REFUND_MONEY_PRODUCT_DECISION_LOCK.md` only |
| Source / schema / migration / test / dependency / config / env changes | none |
| Commit / push / reset / destructive migration | none performed |
