# PHASE 29A — PIC MONEY LEDGER AUDIT REPORT

| | |
| --- | --- |
| **Phase** | PHASE 29A — PIC money ledger audit (ledger semantics, balance formula, invariants). |
| **Mode** | **AUDIT ONLY** — no source, schema, migration, database or seed changes; nothing committed or pushed. |
| **Auditor** | opencode (big-pickle) |
| **Date** | 2026-09-24 |
| **Status** | **AUDIT COMPLETE.** The double-entry PIC ledger is real, append-only, double-payment-walled and Decimal-exact. The canonical balance formula `net = ΣCREDIT − ΣDEBIT` is proven by code and tests on the PIC self-service surface, and reconciles with settlement math. One reporting GAP (platform operator money totals) violates the shared-formula rule, and two money-integrity limits are documented as findings (post-payout refund net-off, partial-refund proportional reversal). |

---

## 1. Ledger definition and semantics (what a row means)

`PICFeeLedger` (`prisma/schema.prisma:1484-1548`) is the **only** PIC money record. Every row is a signed, append-only journal entry:

| Field | Semantics (confirmed by writers) |
| --- | --- |
| `type` | `EARNED` (fee won), `REVERSAL` (fee clawed back), `PAYOUT` (fee paid out). `EARLY_ACCRUAL / EARNED_ADJUSTMENT / ADJUSTMENT` are vocabulary only — **zero writers** (deep-audit §6 confirmed, re-confirmed in Phase 29: no writer for any of them in `app/`/`lib/`). |
| `direction` | `CREDIT` = money owed **to** the PIC; `DEBIT` = money no longer owed / already paid (stored as **positive** magnitudes). |
| `status` | `EARNED` (unsettled), `SETTLED` (claimed + flipped at payout `paid`), `VOID` (refund reversal — never payable). `PENDING / PAYABLE / APPROVED` are vocabulary only (zero writers). |
| `amount` | `Decimal(14,2)`, always a positive magnitude; sign lives in `direction`. |
| `idempotencyKey` | `fee:earned:{orderItemId}`, `fee:reversal:{refundId}:{orderItemId}`, `fee:payout:{settlementId}:{earnedId}` — each `@unique`, each a double-append wall. |
| `settlementId` | `null` while consumable; set at payout `paid` (EARNED flips and REVERSAL linkage) — the "consumed" marker. |
| FK snapshot | `feeType/rateBp/fixedAmount/basisType/basisAmount/quantity` copied at write time; **never recomputed** (design §15.1 / D-23; `postEarnedPicFees` at `lib/pic/attribution.ts:206-260`). |

### Writers (only three, each inside its own argument-carrying transaction)

1. **EARNED (CREDIT)** — `postEarnedPicFees` (`lib/pic/attribution.ts:206-260`), called only inside the authoritative order-settlement transaction (`lib/ticketing/payment/settlement.ts:472`, in the winner branch of the step-4 CAS). Replays the frozen checkout snapshots (`EventOrderItem.picFeeAmount/rateBp/…`, schema:1103-1108). Idempotent via `@@unique([orderItemId, type])` + unique `idempotencyKey`; a non-PIC order posts nothing.
2. **REVERSAL (DEBIT, status VOID)** — `reversePicFeesForRefund` (`lib/ticketing/refunds/settlement.ts:400-477`), called inside `settleRefund`'s REFUNDED transaction (line 301). Posts once per order item, only when the item is **fully refunded** (`refundedTickets >= orderItem.quantity`, line 432-433), with `amount = earned.amount` (line 459) and the EARNED row's `attributionId` (line 456). Partial item refunds post nothing (see finding BUG-3).
3. **PAYOUT (DEBIT, status SETTLED)** — inside `markSettlementPaid`'s transaction (`lib/ticketing/settlement/settlement.ts:850-885`). One row per included EARNED row, `amount = earned.amount − Σ consumed reversals of the same order item` (lines 839-857), copied FK snapshot + `attributionId`, `idempotencyKey = fee:payout:{settlementId}:{earnedId}`. The PAYOUT sum is therefore **exactly** the settlement net.

### Readers (balance surfaces)

| Surface | Formula | Location |
| --- | --- | --- |
| PIC self-service net outstanding | `Σ(CREDIT) − Σ(DEBIT)`, all rows, all statuses | `lib/pic/self-service.ts:316-341` (`groupBy direction`) |
| Settlement window net | `Σ in-window EARNED-CREDIT − Σ REVERSAL-DEBIT (settlementId null) of those items` | `lib/ticketing/settlement/settlement.ts:151-189` |
| Platform operator list "ledgerTotal" | `Σ amount` all rows, **no direction/status filter** | `lib/pic/service.ts:130-146` (GAP-1) |
| Platform operator detail "Total fee (kredit)" | `Σ(CREDIT) amount` over the **latest 100** rows | `app/dashboard/pic/[id]/page.tsx:121-123`, `lib/pic/service.ts:353-366` (`take: 100`) (GAP-2) |

## 2. Balance formula proof

For a PIC with `EARNED 100` (CREDIT), `REVERSAL 40` (DEBIT), `PAYOUT 100` (DEBIT):

- Self-service net = `100 − 40 − 100 = −40` (the company owes nothing; the PIC owes 40 back because 100 was paid but 40 was clawed back before/after payout).
- After a normal single settlement (`EARNED 100` in-window, no reversal → `PAYOUT 100`): net = `100 − 100 = 0`. The EARNED row remains CREDIT forever; the PAYOUT row cancels it. **This is the invariant**: credit rows never change; consumption is expressed by new DEBIT rows. Confirmed: no `pICFeeLedger.update/delete` anywhere in `app/`/`lib/` (grep), `SETTLED` rows are only ever reached by the status flip in the paid path.
- Settlement window math reconciles to the same had the window covered the whole ledger: window net (eligible) is exactly the portion of `ΣCREDIT − ΣDEBIT` that is still consumable (status EARNED, settlementId null, in-window).

**Verdict: PASS** — the formula `net = ΣCREDIT − ΣDEBIT` is internally consistent and is what the settlement math embeds. `GATEWAY_SPLIT` is never written (comment-only, `lib/ticketing/settlement/settlement.ts:34`, `validation.ts:15`).

## 3. Precision / float audit

- All writes and aggregate sums use `Prisma.Decimal` (`Decimal(14,2)` columns). PAYOUT itemNet = `Decimal.minus(Decimal)` (`settlement.ts:853`); test asserts `sum.toFixed(2) = "250000.00"` (`settlement.integration.test.ts:588-592`).
- The **only** `Number()` on money is a display refinement in the operator detail card (`app/dashboard/pic/[id]/page.tsx:122`) — display-only, not stored. No float reaches the ledger.
- **Verdict: PASS** (deep-audit §14 criterion satisfied; float points are display-only).

## 4. Anti-double-payment walls (re-verified)

| Wall | Source |
| --- | --- |
| One EARNED per order item | `@@unique([orderItemId, type])`, schema:1525 |
| Ledger `idempotencyKey @unique` | schema:1488/1522 |
| One settlement per payee per period | `Settlement @@unique([payeeType, picProfileId, periodStart, periodEnd])`, schema:1590 |
| Per tenant too | `@@unique([payeeType, organizerId, periodStart, periodEnd])`, schema:1591 |
| A ledger entry paid at most once | `SettlementItem.picFeeLedgerId @unique`, schema:1605 + `PICFeeLedger.settlementId` link |
| Reversal once per item | derived from `@@unique([orderItemId, type])` + explicit existence check (`refunds/settlement.ts:439-446`) |
| PAYOUT once per (settlement, earned) | `fee:payout:{settlementId}:{earnedId}` `@unique` |

**Verdict: PASS** — period-replay, idempotent re-runs (`ALREADY`) and paid-time flips are all guarded by these plus the per-transition `withContentionRetry` wrappers at `settlement.ts:290/484/562/642/935/1010`.

## 5. Invariant scoring matrix (PASS/FAIL/UNPROVEN/GAP)

| # | Invariant | Verdict | Evidence |
| --- | --- | --- | --- |
| I-1 | Ledger is append-only; no row is ever edited/deleted | **PASS** | grep: no `pICFeeLedger.update/delete`; only `create` + the paid-time `status/settlementId` **flip on EARNED** and REVERSAL-link `settlementId` (a state transition on already-claimed rows, not a money edit) |
| I-2 | net = ΣCREDIT − ΣDEBIT is the one true balance | **PASS** | self-service formula (§2), matches settlement math |
| I-3 | EARNED posted exactly once, in the order-settle tx | **PASS** | `payment/settlement.ts:472` + unique guards; 16-test suite |
| I-4 | REVERSAL posted exactly once, in the refund-settle tx | **PASS** | `refunds/settlement.ts:439-446` + unique guard |
| I-5 | PAYOUT posted exactly once per included EARNED and sums to net | **PASS** | `settlement.ts:850-885`; test `payouts.length=2, sum=250000.00` |
| I-6 | Full claw-back excludes the item and leaves rows consumable | **PASS** | `settlement.ts:229-233`; test `full claw-back excludes` |
| I-7 | Partial claw-back nets CREDIT+DEBIT lines | **PASS** | `settlement.ts:235-258`; test `partial claw-back` |
| I-8 | Fail/cancel release claim lines, ledger untouched | **PASS** | `settlement.ts:file:935+` and cancel; test `fail releases the claim lines` (item rows 0, EARNED still EARNED + unlinked) |
| I-9 | Paid refuses a fresh reversal after prepare | **PASS** | `settlement.ts:766-788`; test `paid refuses when a fresh reversal lands` |
| I-10 | Paid refuses without proof | **PASS** | `settlement.ts:676-677`; test |
| I-11 | Double-append of PAYOUT impossible | **PASS** | unique `idempotencyKey`; test `re-running submit/approve/paid` (1 payout) |
| I-12 | Platform operator money totals use the shared balance formula | **GAP** | `lib/pic/service.ts:130-146` `_sum.amount`, no direction/status filter → magnitude sum, not a balance (GAP-1); detail page credit sum capped at 100 rows (GAP-2) |
| I-13 | Snapshot rule honoured (rate/basis frozen per row) | **PASS** | `postEarnedPicFees` copies snapshots; refund/payout copy from the EARNED row |
| I-14 | `GATEWAY_SPLIT` never written | **PASS** | grep: comment-only |
| I-15 | Isolated tenants cannot cross-settle | **PASS** | unique index includes `organizerId`; service resolves `row.organizerId` → `requireOrganizerAccess`; tests |
| I-16 | No float reaches the ledger | **PASS** | §3 |

## 6. Findings

### GAP-1 — Platform operator list "ledgerTotal" is a magnitude sum, not a balance
- **Location**: `lib/pic/service.ts:131-146` (`groupBy` `_sum.amount` over ALL rows for the profile, no `type/direction/status` filter). Feeds the platform PIC manager list (`app/dashboard/pic/page.tsx:212`, `PicManager`).
- **Bug**: A PIC with EARNED 100, REVERSAL 40, PAYOUT 100 is shown `240.00`, while the PIC's own self-service balance is `−40.00` and the true gross credit is `100.00`. The number neither equals net, nor gross credit, nor outstanding — it is the sum of absolute magnitudes and misleads.
- **Root cause**: `groupBy` over the whole table was written to avoid a mutable counter, but no sign/status semantics were applied.
- **Reproduction**: Post EARNED 100, REVERSAL 40, PAYOUT 100 for one ACTIVE PIC; call `listPicsForAdmin` → `ledgerTotal = "240.00"` vs self-service `net = "-40.00"`.
- **Impact**: LOW (reporting only; nothing posts from this figure). But it materially misleads a platform operator reading "fee" as money available, and violates the audit contract's rule that operator totals never count reversal/adj rows and must match one shared formula.
- **Mitigation (already in place)**: none. The self-service + settlement numbers are the money truth.
- **Fix (Phase 30 candidate, NOT applied in Phase 29)**: apply the shared formula `Σ CREDIT − Σ DEBIT` (or clearly label the column "gross fee (credit)") in `listPicsForAdmin`, with an explicit `type IN (EARNED, REVERSAL, PAYOUT)` + `direction` split, exactly as `getMyFeeSummary` does.
- **Test**: extend a ledger fixture such that `listPicsForAdmin`'s `ledgerTotal` equals `getMyFeeSummary().net` (or a relabeled gross), and assert a reversal/payout does not inflate it.
- **Priority**: MEDIUM.

### GAP-2 — Operator detail "Total fee (kredit)" is capped and unfiltered by status
- **Location**: `app/dashboard/pic/[id]/page.tsx:121-123` + `lib/pic/service.ts:353-366` (`take: 100`).
- **Bug**: Sums `direction = CREDIT` over only the 100 most recent ledger rows (any status/type), so a PIC with >100 entries under-reports, and any future `EARLY_ACCRUAL`/`ADJUSTMENT` CREDIT would be counted as "fee". Label is accurate ("Total fee (kredit)") but the number is not the full picture.
- **Impact**: LOW (display only; explicitly labeled as credit total).
- **Fix (Phase 30)**: read all rows (paginate) and constrain `type = EARNED`; or compute via the shared formula and relabel.
- **Priority**: LOW.

### BUG-1 — Post-payout refund claw-back is recorded but never netted (D-18 open)
- **See** `PHASE_29_PIC_MONEY_LIFECYCLE_RECONCILIATION_REPORT.md` §BUG-1 for full writeup. Summary: a reversal created after its EARNED row was PAID (`status=SETTLED`, `settlementId` set) can never be consumed by any future settlement window (eligibility is `status=EARNED, settlementId=null`, `settlement.ts:151-189`), so the DEBIT row stays unlinked forever and the self-service balance turns negative — the platform has paid the PIC the full fee and later collected a claw-back with no repayment offset. In-window (`paid`-time) reversals are guarded (`settlement.ts:766-788`); **only** the post-PAID window is exposed.
- **Priority**: HIGH (accounting integrity for post-payout refunds; no cash is moved wrongly **today** because payouts are manual and operators see the negative balance, but a new-period settlement for the same PIC will not deduct the pre-existing reversal → overpay on next payout).

### BUG-3 — Partial item refunds do not proportionally reverse the fee (D-R16 interpretation locked to whole-item)
- **Location**: `refunds/settlement.ts:432-437` (`fullyRefunded = refundedTickets >= orderItem.quantity`).
- **Bug**: A quantity-3 item where one ticket is refunded posts **no** fee reversal; the EARNED credit stays at 100% until the *last* ticket of the item is refunded, at which point the **full** fee is reversed at once. Two consequences: (a) between a partial refund and the item's full refund the PIC is credited the full fee even though part of the sale was reversed; (b) if an order is never fully item-refunded, no fee is ever clawed back for the part that was.
- **Contrast**: the deep audit's §9 claimed "Partial refund → reversal covers only the refunded quantity with the same snapshot" — the shipped code does **not** do that (whole-item-only). This is a **documented deviation** that must be ratified by business or changed in Phase 30.
- **Impact**: MEDIUM (ledger is on the generous side for the PIC during partial refunds; never over-pays at settlement because the reversal appears before the EARNED is settled when fully refunded pre-payout).
- **Fix (Phase 30, business decision required)**: either proportional reversal `amount = earned.amount × refunded/quantity` posted per item-refund increment (with a guard against the total exceeding the EARNED), or keep whole-item semantics and document that a partially-refunded item's fee is retained until the item is fully refunded.
- **Priority**: MEDIUM.

## 7. Verification evidence (read-only, Phase 29)

```
npx prisma validate                                    → "The schema at prisma/schema.prisma is valid"
npx tsc --noEmit                                       → exit 0
npm run lint                                           → 0 errors, 3 pre-existing <img> LCP warnings (unrelated files)
npx jest __tests__/ticketing-pic/settlement.integration.test.ts
                                                       → 16/16 PASSED
npx jest __tests__/ticketing-pic __tests__/pic-self-service __tests__/ticketing-refunds
                                                       → 14 suites / 203 tests / 2 snapshots PASSED
npm test                                               → 103 suites / 2089 tests / 2 snapshots PASSED
npm run build                                          → exit 0 (incl. /dashboard/settlements routes)
```

## 8. Ledger audit conclusion

The ledger itself is **production-grade and internally consistent**: append-only, exactly-once writers, Decimal-exact, triple double-payment walls, snapshot-frozen. The one-true formula `ΣCREDIT − ΣDEBIT` holds on the money surfaces and reconciles with settlement math. The failures the audit found are **reading-surface** (operator totals must adopt the shared formula, GAP-1/GAP-2) and **policy decisions still open** (D-18 post-payout net-off, D-R16 partial-refund proportionality), not ledger corruption.