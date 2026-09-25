# PHASE 30 — PIC MONEY INTEGRITY & RECONCILIATION
## IMPLEMENTATION REPORT

**Date:** 2026-09-24
**Scope:** Close BUG-1, BUG-3, GAP-1, GAP-2 from the Phase 29 audits and reconcile the PIC money lifecycle end-to-end.
**Status:** **PASS** (all Phase 30 completion gates green)
**Commit policy:** no commit, no push performed.

---

## 1. Executive summary

Phase 30 fixes the four money-integrity blockers left open by Phase 29:

| ID | Defect | Resolution | Where |
|----|--------|-----------|-------|
| **BUG-1** | Post-`PAID` refund (`REVERSAL`) recorded but never netted into a later settlement | **D-18 net-off**: carried post-paid reversals are selected as settlement deductions and reduce the appended PAYOUT rows so they sum exactly to `netAmount` | `lib/ticketing/settlement/settlement.ts` |
| **BUG-3** | Partial item refunds do not proportionally reverse PIC fees | **D-R16 proportional reversal**: one incremental `REVERSAL` per refund event; cumulative reversal converges exactly on `EARNED` | `lib/ticketing/refunds/settlement.ts` |
| **GAP-1** | Platform PIC list `ledgerTotal` used a magnitude sum | Canonical `Σ CREDIT − Σ DEBIT` via the shared helper | `lib/pic/service.ts`, `lib/pic/ledger.ts` |
| **GAP-2** | Platform PIC detail total was `take: 100` and type/direction blind | Whole-ledger Decimal aggregation; the ledger *table* stays paginated | `lib/pic/service.ts`, `lib/pic/ledger.ts` |

A single canonical balance helper (`lib/pic/ledger.ts`) now powers self-service, the admin list, the admin detail and settlement selection, so the four surfaces cannot drift.

**Audit-first note:** the module-level implementation for BUG-1/BUG-3/GAP-1/GAP-2 was already present in the working tree (uncommitted) when this phase started. It was **not** trusted blindly — the schema, migrations and code were inspected, the full PIC/refund/settlement suites were executed, and two genuine test defects were found and fixed, plus the missing admin-total coverage was added (see §15). The shipped source remains the source of truth.

---

## 2. Phase 29 findings addressed

* **BUG-1** — `selectSettlementItems` only matched `type=EARNED, status=EARNED, settlementId IS NULL` inside the window, so a refund that arrived after payout stranded a negative balance. Now carried reversals (item EARNED already settled) are added as deductions and consumed once.
* **GAP-1** — `listPicsForAdmin` (and the earlier magnitude sum) now uses `getPicLedgerBalances` and returns `net`.
* **BUG-3** — `reversePicFeesForRefund` replaces the all-or-nothing full-item reversal with a per-refund proportional increment.
* **GAP-2** — `getPicDetail` totals now use `getPicLedgerBalance` (whole ledger) plus a `groupBy(type)` breakdown; the 100-row cap survives only on the listing array.

---

## 3. D-18 decision and implementation

**Decision:** NET-OFF FUTURE SETTLEMENTS. No direct claw-back from the PIC. Historical `EARNED` and `PAYOUT` rows are never rewritten, deleted or mutated; the post-paid `REVERSAL` becomes a deficit consumed by the next eligible settlement.

**File / function:** `lib/ticketing/settlement/settlement.ts` → `selectSettlementItems` and `markSettlementPaid`.

*Selection* classifies every unsettled `REVERSAL` in the PIC+tenant scope:

| Class | Meaning | Action |
|-------|---------|--------|
| A | item's `EARNED` is in this window | offsets that item in place (`net ≤ 0` ⇒ item skipped, rows stay consumable) |
| B | item's `EARNED` already **settled** (paid) | carried deficit, added as a `DEBIT` item |
| C/D | already consumed / already in another settlement | excluded (`settlementId: null` filter + paid-time CAS) |

*Payout pooling* in `markSettlementPaid`: the preliminary PAYOUT sum overstates `netAmount` by exactly the carried total; that excess is spread across the payout rows (earliest `EARNED` first, never below zero) so `Σ PAYOUT == netAmount`.

**Invariants preserved:** append-only ledger, `Σ CREDIT − Σ DEBIT`, no history rewrite, `NEW_REVERSAL_DETECTED` unchanged (a reversal landing between prepare and paid still hard-refuses with `CONFLICT`), `SettlementItem.picFeeLedgerId` UNIQUE (one ledger row settles once).

**Tests:** `__tests__/ticketing-pic/settlement-carried-reversal.integration.test.ts`.

---

## 4. D-R16 decision and implementation

**Decision:** PROPORTIONAL REVERSAL, `Prisma.Decimal` end-to-end, no floats.

**File / function:** `lib/ticketing/refunds/settlement.ts` → `reversePicFeesForRefund`.

```
newlyRefundedQty = refundedTickets(REFUNDED) − Σ quantity of existing REVERSAL rows
non-final increment = earned.amount × newlyRefundedQty / quantity  (ROUND_DOWN to 2dp)
final increment     = earned.amount − Σ existing reversal amounts    (absorbs remainder)
```

Rounding policy: 2 dp, `ROUND_DOWN` for every non-final increment; the increment that fully refunds the item absorbs the remainder. Cumulative reversal therefore equals the original `EARNED` exactly and can never overshoot it. A re-run computes `newlyRefundedQty = 0` and posts nothing.

**Ledger identity:** each reversal carries `refundId` + `reversalRef = String(refundId)` + `idempotencyKey = fee:reversal:{refundId}:{orderItemId}`, and the schema unique wall became `@@unique([orderItemId, type, reversalRef])` so an item may hold one incremental reversal per refund event while the one-`EARNED`-per-item wall is untouched.

**Migration:** `prisma/migrations/20260924000000_add_pic_fee_proportional_reversals` — additive only: `ADD COLUMN reversalRef VARCHAR(191) NOT NULL DEFAULT 'NONE'`, create new unique index, drop the old `(orderItemId, type)` index. No data rewrite, no drops except the superseded index.

**Tests:** `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts` (2-ticket proportional, 3-ticket non-divisible rounding `3333.33 / 3333.33 / 3333.34`, idempotent replay).

---

## 5. Post-paid refund lifecycle (BUG-1)

```
EARNED 100 ──settle──▶ PAYOUT 100   (ledger net 0)
        └─ later refund ──▶ REVERSAL 40 (DEBIT, settlementId NULL)   (ledger net −40)
                                   │
next settlement prepare: gross 140, deduction 40, net 100
                                   │
paid: EARNED flipped SETTLED, REVERSAL linked (CAS settlementId:NULL),
      PAYOUT rows appended reduced by 40 so Σ PAYOUT == 100
```

Verified by Scenario C/D in `settlement-carried-reversal.integration.test.ts`: item A earned 6000 and paid; reversal 6000 then offsets a later 14000 window (gross 14000, deduction 6000, net 8000, payouts pooled to two × 4000); a deficit larger than the window refuses `NOTHING_SETTLEABLE` and carries onward.

---

## 6. Partial refund lifecycle (BUG-3)

```
quantity 3, EARNED 30 → refund 1 → REVERSAL 10   (cum 10)
                        refund 1 → REVERSAL 10   (cum 20)
                        refund 1 → REVERSAL 10   (cum 30 == EARNED, exact)
```

Non-divisible: `EARNED 10000 / qty 3` → `3333.33 + 3333.33 + 3333.34 = 10000.00` exactly. Idempotent replay posts nothing and the reversal count cannot grow.

---

## 7. Canonical balance formula

**File:** `lib/pic/ledger.ts`

```
getPicLedgerBalance(picProfileId)  → { credit, debit, net }   // groupBy(direction), Δ Decimal
getPicLedgerBalances(ids)          → Map<id, {credit,debit,net}>  // one groupBy, zero-filled
net = credit − debit
```

`Decimal` only (groupBy `_sum`), whole ledger, no window, no `Number()`. Consumed by self-service (`lib/pic/self-service.ts`), admin list, admin detail and the settlement reconciliation.

---

## 8. Admin total reconciliation (GAP-1 / GAP-2)

| Surface | File / function | Number | Label |
|---------|-----------------|--------|-------|
| Platform PIC list | `lib/pic/service.ts` → `listPicsForAdmin` | `net` | `Saldo fee (net)` (`components/platform/PicManager.tsx`) |
| Platform PIC detail | `lib/pic/service.ts` → `getPicDetail` | `balance.{credit,debit,net}` + `totalsByType` | `Saldo fee (net: kredit − debit)` |
| PIC self-service | `lib/pic/self-service.ts` | `earned`/`reversed`/`net` | unchanged |

The detail ledger *array* keeps `take: 100` (pagination); the totals are DB aggregates independent of it. `totalsByType` is keyed by `type`, so a future/non-`EARNED` credit (`EARLY_ACCRUAL`, `ADJUSTMENT`) is its own line and can never inflate `EARNED`.

A negative outstanding balance is displayed as-is (never clamped or hidden); no "Withdraw" button and no automatic payout exist.

---

## 9. Settlement reconciliation

`markSettlementPaid` remains the single `APPROVED → PAID` writer. In one transaction it: CASes the status; runs the `NEW_REVERSAL_DETECTED` check; flips included `EARNED` rows to `SETTLED` and links the settlement; links included `REVERSAL` rows via CAS; appends `PAYOUT` `DEBIT` rows equal to each item's net with the carried remainder spread so they sum exactly to `netAmount`. Any throw rolls everything back.

---

## 10. Ledger invariants

* Money is `Decimal` / `Decimal(14,2)` throughout; no floating point anywhere in the money path.
* Ledger is append-oriented; `EARNED` / `REVERSAL` / `PAYOUT` history is never rewritten.
* Balance is `Σ CREDIT − Σ DEBIT` on every surface.
* One `EARNED` per order item (`@@unique([orderItemId, type, reversalRef])`, `reversalRef='NONE'` for non-reversals).
* No reversal consumed twice; no payout appended twice (`SettlementItem.picFeeLedgerId` UNIQUE + `idempotencyKey` uniqueness + paid-time CAS).

---

## 11. Idempotency / concurrency

* Refund retries: `newlyRefundedQty ≤ 0` ⇒ no post; `fee:reversal:{refundId}:{orderItemId}` + `(orderItemId,type,reversalRef)` unique wall.
* Settlement prepare is bounded by `@@unique([payeeType, organizerId|picProfileId, periodStart, periodEnd])`; the P2002 loser re-reads and returns the winner (`EXISTS`).
* Concurrent paid attempts serialized by the `updateMany(status: APPROVED)` CAS; the reversal link CAS rejects a second consumer.
* Refund-after-prepare is caught by `NEW_REVERSAL_DETECTED`; refund-after-paid becomes a carried deficit.
* All transitions use `withContentionRetry` + DB CAS (no application-only checks).

---

## 12. Tenant isolation

Every settlement selection is scoped by `organizerId`, and the ledger carries `organizerId`, so the same PIC earning in two organizers settles independently. `settlement-carried-reversal` pins that a reversal on organizer B never offsets organizer A's settlement for the same PIC.

---

## 13. Authorization

Unchanged. Platform admin totals use `requirePlatformPermission(PIC_MANAGE)`; settlement transitions use `requireOrganizerAccess` against the row's own `organizerId`; SoD (preparer ≠ approver ≠ payer) is enforced in `settlement/service.ts`. No `picProfileId`/`organizerId`/`settlementId` from the client confers authority; server resolves authority from the session and DB relationships. No Admin authorization redesign, no new bypass.

---

## 14. Database / migration changes

* `prisma/migrations/20260924000000_add_pic_fee_proportional_reversals/migration.sql` — additive (`reversalRef` column + rebuilt unique index). No destructive statement.
* `prisma/schema.prisma` — `PICFeeLedger.reversalRef String @default("NONE")`, `@@unique([orderItemId, type, reversalRef])`.
* `prisma validate` → valid.
* `prisma migrate status` → test DB fully migrated (all 27 migrations applied, which the Jest global-setup gate enforces). The **development** DB has 3 additive migrations pending (2 from Phase 29, the Phase 30 one) — left untouched deliberately; no reset, drop or data deletion was performed.

---

## 15. Tests added / fixed

**Added — `__tests__/ticketing-pic/admin-pic-totals.integration.test.ts` (12 tests):**
0 rows; earned only; earned + reversal; earned + payout; earned + reversal + payout (canonical −40 vs the buggy 240); batch helper zero-fill + agreement; admin list net for all shapes incl. negative and not clamped; **>100 rows** totals independent of the 100-row table cap while the table stays at 100; `totalsByType` keeps a non-`EARNED` credit on its own line (`EARLY_ACCRUAL`) and a `DEBIT` `ADJUSTMENT` does not inflate `EARNED`; list total === detail net === helper net.

**Fixed — `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts`:**
1. Both BUG-3 tests created a `PICProfile` for the same shared `buyerB` account, colliding on `picprofile_userId_key` (one profile per user). Changed to idempotent `pICProfile.upsert({ where: { userId } })`. This was a **test fixture defect**, not a product regression.
2. The idempotency assertion used a nonexistent relation `refundItems`; corrected to the schema relation `items` (`Refund.items`).
3. Updated the stale module doc (`D-P17-12` "partial refund retains the fee") to the Phase 30 proportional contract.

**Pre-existing (verified, not modified):** `__tests__/ticketing-pic/settlement-carried-reversal.integration.test.ts` (BUG-1/D-18), the proportional block in `refund-manual-rail.integration.test.ts` (BUG-3), `settlement.integration.test.ts`, `pic-self-service/*`.

---

## 16. Verification results

| Check | Command | Result |
|-------|---------|--------|
| Schema | `npx prisma validate` | ✅ valid |
| Migrations | `npx prisma migrate status` | ✅ test DB at 27/27; dev DB 3 additive pending (untouched) |
| Types | `npx tsc --noEmit` | ✅ clean |
| Lint | `npx eslint` (pic / settlement / refunds / tests) | ✅ clean |
| Focused | `npx jest __tests__/ticketing-pic __tests__/ticketing-refunds __tests__/pic-self-service` | ✅ 16 suites, 221 tests |
| Full | `npx jest` | ✅ 105 suites, 2107 tests, 2 snapshots |
| Build | `npm run build` | ✅ success (all routes compiled) |

No flaky tests observed; no test weakened or deleted.

Scenario coverage (Part F): A/B `settlement.integration`; C/D `settlement-carried-reversal`; E/F/G/H `refund-manual-rail` (BUG-3); I concurrency in `refund-manual-rail` + `settlement.integration`; J/K tenancy in `ownership`/`settlement-carried-reversal`; L `admin-pic-totals`.

---

## 17. Remaining known gaps

* Dev/production databases still need `prisma migrate deploy` for the three additive migrations before this work is live (no data impact; test DB already migrated).
* Carried-reversal selections are per item; a `REVERSAL` row with `orderItemId = NULL` is conservatively never carried (it can never be matched to a paid `EARNED`). No such row is produced by the writer.
* A window whose carried deficit exceeds its earnings is refused (`NOTHING_SETTLEABLE`) and the deficit carries to a later/wider window; this is the documented D-18 carry-forward behaviour, not a leak.

---

## 18. Explicit out-of-scope

* No iPaymu payout API, no `GATEWAY_SPLIT`, no automatic disbursement, no PIC self-withdrawal, no new payout permissions.
* No Admin authorization redesign, no tenant-isolation or SoD changes.
* No schema change beyond the additive `reversalRef` + index rebuild; no destructive migration, no reset, no ledger row deletion, no historical money mutation.
* No floating-point money arithmetic.

---

## 19. Final verdict

**PASS.** BUG-1 (D-18), BUG-3 (D-R16), GAP-1 and GAP-2 are closed; the shared canonical balance formula is reconciled across every money surface; the post-paid and partial refund scenarios, concurrency, tenant isolation and idempotency all pass; `prisma validate`, `tsc`, lint, the full test suite (2107 tests) and the production build are green; no destructive database change was made.

**Uncommitted deliverables:**
* new `__tests__/ticketing-pic/admin-pic-totals.integration.test.ts`
* edits to `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts`
* the Phase 30 implementation modules already present in the working tree (verified, unmodified by this phase except the test fixes above).

**No commit. No push.**

---

## Changed files (this phase)

| File | Change |
|------|--------|
| `__tests__/ticketing-pic/admin-pic-totals.integration.test.ts` | **NEW** — 12 GAP-1/GAP-2 canonical-total tests |
| `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts` | Fixed PIC-profile fixture (`upsert`), fixed `items` relation, doc comment |

All other entries in `git status` (the `lib/pic/*`, `lib/ticketing/settlement/*`, migrations, settlements UI/API, `prisma/schema.prisma`, etc.) were **already dirty before this phase started** and were left as-is except for the two test files above.
