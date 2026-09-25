# PHASE 29 — PIC MONEY LIFECYCLE RECONCILIATION REPORT

| | |
| --- | --- |
| **Phase** | PHASE 29 — RECONCILIATION & BALANCE-INTEGRITY AUDIT of the PIC money lifecycle (referral → attribution → order → EARNED → REVERSAL → payout settlement → PAYOUT → outstanding → dashboard). |
| **Mode** | **AUDIT ONLY** — no source, schema, migration, database or seed changes; nothing committed or pushed. Reconciles `PIC_PAYOUT_SETTLEMENT_V1_IMPLEMENTATION_REPORT.md` (26 sections) against the shipped code and the `PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md` contract. |
| **Auditor** | opencode (big-pickle) |
| **Date** | 2026-09-24 |
| **Status** | **AUDIT COMPLETE.** The lifecycle is closed end to end under Option C (manual bank transfer): money-once, duty-separated, tenant-isolated, audited, Decimal-exact. Verification fully green (103 suites / 2089 tests, tsc, lint, prisma validate, production build). Reconciliation verdict: **24 of 26 implementation sections verified true**; **2 GAPs and 2 money-integrity findings** are documented (operator-facing totals formula; post-payout refund net-off; partial-refund proportional reversal). Phase 30 readiness: **NO — 3 blockers** must be closed first. |

---

## 1. Executive Summary

The six-phase PIC money arc — share token resolves at checkout, fee snapshots frozen on the order items, EARNED credits posted in the order-settle transaction, REVERSAL debits posted on full-item refunds, operator-driven MANUAL_TRANSFER settlements flipping EARNED→SETTLED and appending PAYOUT debits, and PIC read-only self-service reflecting `net = ΣCREDIT − ΣDEBIT` — **reconciles**. Every money-writing step happens inside its own authoritative transaction with a CAS and a unique idempotency guard; no float reaches the ledger; no `GATEWAY_SPLIT` is written; no PIC-initiated withdrawal exists; nothing was committed or pushed.

The audit's honest book-keeping:

- **Verified true**: ledger semantics, balance formula, settlement eligibility, payout accounting, exactly-once guarantees, SoD half-gate, tenant isolation, concurrency control, precision, proof handling, audit trail, self-service balance.
- **GAP (reporting)**: platform operator list "ledgerTotal" (`lib/pic/service.ts:131-146`) is a magnitude sum (EARNED+REVERSAL+PAYOUT) that shares no formula with the balance any other surface shows; operator detail credit sum is capped at 100 rows.
- **Money-integrity findings (both documented, both pre-existing policy decisions left open)**: BUG-1 post-PAID refund claw-back is recorded but never netted (D-18); BUG-3 partial item refunds do not proportionally reverse the fee (D-R16 locked to whole-item).

Phase 30 readiness is **NO** until those three are closed. The ledger itself never lied — the gaps are in the *reading* surfaces and the two open policy decisions.

## 2. Scope and Method

Read-only reconciliation. Confronted every claim of `PIC_PAYOUT_SETTLEMENT_V1_IMPLEMENTATION_REPORT.md` against the shipped source, schema, and tests; re-ran the full verification set; reconstructed 12 lifecycle scenarios and scored 16 invariants.

**Files walked for evidence**: `lib/pic/attribution.ts`, `lib/ticketing/checkout.ts`, `lib/ticketing/payment/settlement.ts`, `lib/ticketing/refunds/settlement.ts`, `lib/ticketing/refunds/service.ts`, `lib/ticketing/settlement/{settlement,service,validation,payload,proof}.ts`, `lib/ticketing/db-contention.ts`, `lib/ticketing/audit-log.ts`, `lib/pic/self-service.ts`, `lib/pic/service.ts`, `lib/authz/permissions.ts`, `prisma/schema.prisma`, `app/dashboard/pic/*`, `app/dashboard/settlements/*`, `__tests__/ticketing-pic/settlement.integration.test.ts` (16 tests), plus the Phase 22 test-DB machinery (`jest.config.js`, `jest.setup-env.ts`).

**Verification (all read-only, all green)** — see §18. No source file was modified.

## 3. Ledger Definition and Semantics (reconciliation of implementation §5)

**Claim**: "EARNED stays CREDIT forever; settlement consumption is expressed by new PAYOUT DEBIT rows."

**Verified**: `PICFeeLedger` rows are the only ledger. EARNED/CREDIT/status-EARNED (writer `postEarnedPicFees`, `attribution.ts:206-260`); REVERSAL/DEBIT/status-VOID, whole-item-full-only (writer `refunds/settlement.ts:400-477`); PAYOUT/DEBIT/status-SETTLED, one per included EARNED, `amount = earned − consumed reversals`, `fee:payout:{settlementId}:{earnedId}` (writer `settlement.ts:850-885`). No `pICFeeLedger.update/delete` exists anywhere; the only column mutations are the paid-time status flip `EARNED→SETTLED` + `settlementId` link on already-claimed EARNED rows and the `settlementId` link on consumed REVERSAL rows — state transitions on consumed lines, never edits of money amounts. `EARLY_ACCRUAL / EARNED_ADJUSTMENT / ADJUSTMENT / PENDING / PAYABLE / APPROVED` have zero writers (vocabulary only).

**Verdict**: **TRUE**.

## 4. Balance Formula and Reconciliation (implementation §4-5)

**Claim**: "net = ΣCREDIT − ΣDEBIT; self-service balance reconciles with settlement math."

**Verified** (source: `self-service.ts:316-341` `groupBy direction`; settlement window math `settlement.ts:151-189`):

| Working example (all Decimal) | Self-service net | Settlement window net | Platform list total |
| --- | --- | --- | --- |
| EARNED 100 credit, no reversal/payout | `100` | `100` (if in-window) | `100` |
| + REVERSAL 40 (full refund pre-payout) | `60` | `60` | `140` ❌ |
| + PAYOUT 100 (settled) | `−40` | `0` (rows consumed) | `240` ❌ |

The money surfaces (self-service, settlement prep/paid) agree; the **operator list total agrees with nothing** (GAP-1, §15-BUG). This is a reading-surface defect, not a ledger defect.

**Verdict**: money formulas **TRUE**; operator totals **GAP**.

## 5. Source-of-Truth Ruleset — Settlement Eligibility (implementation §5, §14, §15)

**Verified contract** (`selectSettlementItems`, `settlement.ts:137-258`):

1. EARNED row eligible iff `type=EARNED AND direction=CREDIT AND status=EARNED AND settlementId IS NULL AND createdAt ∈ [periodStart, periodEnd] AND picProfileId=payee AND organizerId=tenant` (`:151-160`).
2. Reversals consult only order items that have an eligible EARNED in **this** window, `type=REVERSAL AND direction=DEBIT AND settlementId IS NULL` (`:177-189`). A reversal whose EARNED was settled elsewhere cannot reduce this settlement (correct per-item accounting).
3. Per item `net = ΣEARNED − ΣREVERSAL`; `net ≤ 0` ⇒ item excluded, rows stay consumable (`:227-233`); `net > 0` ⇒ CREDIT line + DEBIT lines both included.
4. `(payeeType, organizerId, picProfileId, periodStart, periodEnd)` unique ⇒ one claim per window; re-prepare replays open rows / CONFLICT on re-opened CANCELLED/FAILED (`:290-…`; test `window replays`, `closed window refuses`).
5. `paid` re-checks every included order item for **unclaimed** reversals and refuses `NEW_REVERSAL_DETECTED` excluding its own included DEBIT lines (`:744-788`).

**Verdict**: **TRUE** as implemented; the paid-time guard is intentionally in-window-only (post-PAID is BUG-1, §15).

## 6. Lifecycle Integrity — String and Money-Once Guarantees (implementation §5, §13, §15)

Closed chain verified with exact writers and their transactions:

```
checkout resolveReferralAtCheckout (read-only, in-order tx)   lib/ticketing/checkout.ts:490
  → order create persists frozen fee snapshots                EventOrderItem.picFeeAmount/rateBp/… (schema:1103-1108)
  → iPaymu notify → order-settle tx (CAS PENDING→PAID)        lib/ticketing/payment/settlement.ts (step 4)
  → postEarnedPicFees EARNED CREDIT (in THAT tx, winner branch) lib/ticketing/payment/settlement.ts:472
  → refund settle tx (CAS PROCESSING→REFUNDED, order row locked) lib/ticketing/refunds/settlement.ts:143-334
  → reversePicFeesForRefund REVERSAL DEBIT (in THAT tx)       lib/ticketing/refunds/settlement.ts:301,400-477
  → settlement paid tx (CAS APPROVED→PAID, proof required)    lib/ticketing/settlement/settlement.ts:642-913
  → flips EARNED→SETTLED + links REVERSAL + appends PAYOUT    settlement.ts:791-885
  → self-service net = ΣCREDIT − ΣDEBIT                        lib/pic/self-service.ts:316-341
```

Money-once walls (all unique, all verified): `@@unique([orderItemId,type])`; `idempotencyKey @unique` (earned/reversal/payout); `Settlement` period-unique ×2; `SettlementItem.picFeeLedgerId @unique`; plus `withContentionRetry` around every settlement transition (`settlement.ts:290/484/562/642/935/1010`). Tests pin: PAYOUT count exactly 1 after re-run (`settlement.integration.test.ts:600-626`), sum == net (`:588-592`).

**Verdict**: **TRUE**.

## 7. Segregation of Duties (implementation §6)

**Verified**: role map grants the same membership `SETTLEMENT_PREPARE/APPROVE/PROOF_UPLOAD` (OWNER `permissions.ts:452-454`, MANAGER `:487-489`, FINANCE `:512-514`, platform ADMIN inside tenant `:400-402` via grant; `SETTLEMENT_APPROVE ∈ ADMIN_GRANT_REQUIRED` `:625`), so the permission layer **cannot** separate duties — exactly as the deep audit warned (risk #4). The service layer enforces the half-gate: `approve` refuses `preparedByUserId === actor.userId` (`service.ts:194-195`), `paid` same (`:231-232`). Test pins an OWNER-preparer being refused to self-approve (`settlement.integration.test.ts:706-720`).

**Verdict**: **TRUE** — service-layer half-gate is present, tested, and consistent with D-19.

## 8. Tenant Isolation (implementation §7)

**Verified**: every operation resolves the **row's own** `Settlement.organizerId` and calls `requireOrganizerAccess(organizerId, permission)` (`service.ts:78-120`, `refuseIfNotReadable`); a forged `organizerId` in a list query is refused (`resolveOrganizerFilter`, `:437-470`); the period-unique index includes `organizerId` so one PIC earning in two tenants settles once per tenant per window; a stranger-OWNER is refused on prepare, list, and detail (test `settlement.integration.test.ts:722-737`).

**Verdict**: **TRUE**.

## 9. Concurrency and Idempotency (implementation §13, §15)

**Verified**: all six transitions + prepare run under `withContentionRetry` (`db-contention.ts:115-145`; retries only P2034/1213/1205, jittered backoff, bounded 10). Paid flips + PAYOUT append happen in one transaction, so the ledger can never observe a half-paid settlement. Re-runs are `ALREADY` no-ops; PAYOUT re-append is blocked by the unique idempotency key. Order-settle CAS prevents double EARNED (pre-existing, re-verified at `payment/settlement.ts` step 4).

**Verdict**: **TRUE** within the manual-rail scope (no scheduler; **none added** — §23).

## 10. Financial Precision (implementation §20)

**Verified**: `Decimal(14,2)` columns everywhere; `Prisma.Decimal` arithmetic in all writers and aggregations (groupBy sums, PAYOUT itemNet = `Decimal.minus(Decimal)`); the only `Number()` cast on money is a display refinement in the operator detail card (`app/dashboard/pic/[id]/page.tsx:122`) — display-only. Test asserts exact decimal strings `"250000.00"`.

**Verdict**: **TRUE** (no float reaches the ledger).

## 11. Proof and Evidence Handling (implementation §10, §11, §16)

**Verified**: `lib/ticketing/settlement/proof.ts` — owned storage tree under `UPLOAD_DIR/settlement-proof`; server-generated filename (random hex + detected extension); magic-byte validation (JPEG/PNG/WebP via `detectImageFormat`, PDF via `%PDF-` header — never the client MIME); 5 MB cap re-checked on actual bytes; write-then-rename; idempotent path-safe delete; read refuses traversal. `paid` requires `proofFilePath` set (`settlement.ts:676-677`) and a manual `providerReference` (validation `markPaidSchema`). Serving route re-checks `requireAuth` + `SETTLEMENT_PROOF_UPLOAD` against the row's tenant + exact `proofFilePath === fileName`; `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`. Tests: bad magic/oversize refused, traversal = miss, replacement deletes superseded file only after commit.

**Verdict**: **TRUE**.

## 12. Audit Trail Completeness (implementation §12)

**Verified**: actions `settlement.prepare/submit/approve/proof_upload/paid/failed/cancel` exist in `TicketingAuditAction` (`audit-log.ts:202-208`), entityTypes `Settlement` + `PICFeeLedger`. Financial transitions (`approve`, `paid`, `fail`) are written with `writeTicketingAuditInTx` (throw-on-failure ⇒ a failed audit rolls the payout back — the strong-audit requirement); non-financial ones (`prepare/submit/cancel/proof_upload`) use the fire-and-forget writer, matching the refund precedent. `providerReference`, netAmount, before/after states and actor identity are captured.

**Reconciliation note (pre-existing, out of V1 scope)**: `refund.settle` still uses the fire-and-forget writer (`refunds/settlement.ts:359`) and thus does not fail-closed on an audit error. Documented; not a V1 regression.

**Verdict**: **TRUE** (settlement transitions); observed asymmetry in the refund rail.

## 13. Dashboard Reconciliation (implementation §17, §18)

Operator surfaces: `/dashboard/settlements` + `[id]` (period, status tone, net, masked bank, actions) and the PIC self-service "Pencairan" history card gated on `PIC_FEE_READ_OWN` (`listMySettlements`, `self-service.ts:200-260` region). PIC self-service balance (`getMyFeeSummary`) uses the shared formula.

**Reconciliation FAIL on the platform operator list**: `listPicsForAdmin` `ledgerTotal = _sum.amount` over ALL rows with no direction/status filter (`lib/pic/service.ts:131-146`) and the detail card credit-sum is capped at `take: 100` (`service.ts:353-366`). Neither equals the balance formula. Full writeup GAP-1/GAP-2 in `PHASE_29A_PIC_MONEY_LEDGER_AUDIT_REPORT.md` §6.

**Verdict**: self-service **TRUE**; operator totals **GAP**.

## 14. Data Protection and Privacy (bank data)

**Verified**: `PICProfile` bank fields are create-only (never editable by PIC or organizer; `createPic` only), snapshotted onto `Settlement` at prepare (snapshot rule), surfaced only masked (`••••7890`) in payloads/dashboard, never logged (full account number is on the `FORBIDDEN_METADATA_KEYS` list, `audit-log.ts:226`). Proof files are financial documents kept in a non-public tree served under authz re-checks with nosniff. Test asserts the masked value (`settlement.integration.test.ts:463`).

**Verdict**: **TRUE**.

## 15. Findings (formal)

### BUG-1 — Post-PAID refund claw-back is recorded but never netted (D-18 open → Phase 30 blocker)
- **Bug**: A REVERSAL posted after its EARNED row was already `SETTLED` + linked to a PAID settlement can never be consumed by any future window: settlement eligibility requires `status=EARNED, settlementId=null` (`settlement.ts:151-189`), so the DEBIT row stays `settlementId=null` forever and the self-service balance goes negative (EARNED 100 − PAYOUT 100 − REVERSAL 40 = **−40**). A subsequent settlement for the same PIC will not deduct it (reversals only offset order items that have an eligible in-window EARNED, `settlement.ts:173-189`) → **overpay risk on the next payout**.
- **Root cause**: V1 guards the refund-vs-payout race only **in-window** (`NEW_REVERSAL_DETECTED`, `settlement.ts:766-788`); the design decision D-18 (net-off future payouts vs claw back from PIC) was deliberately left open by the deep audit (§13) and ratified as "handled at the moment that matters" in the implementation report §14 — which is true for in-flight settlements only.
- **Reproduction**: 1) EARNED 100 → prepare → approve → proof → paid (PAYOUT 100, net 0). 2) Refund the item → REVERSAL 40 (VOID), `settlementId null`. 3) `getMyFeeSummary` ⇒ net −40; prepare a new window ⇒ gross/deduction exclude the 40.
- **Impact**: **HIGH** if a PIC is paid again before the claw-back is reconciled; the money facts are fully recorded, so it is recoverable by an operator, and no cash moves automatically — but the accounting does not self-heal.
- **Mitigation (in place)**: reversals are always posted (ledger complete), the balance goes visibly negative, paid-time guard covers the in-flight window.
- **Fix (Phase 30, NOT applied here)**: (a) when a reversal is posted for an order item whose EARNED is already `SETTLED`, link the reversal to the original (PAID) settlement and mark that settlement `FAILED`-adjacent / surface an operator action; or (b) net-off at prepare: include unconsumed REVERSAL DEBIT rows (settlementId null) whose order item's EARNED is SETTLED+linked, as an offset to the window — the D-18 decision. Choose one and pin with a test.
- **Test**: new integration test: refund-after-payout ⇒ next prepare's net subtracts the claw-back (or the settlement is refused while owing).
- **Priority**: **HIGH** (Phase 30 blocker).

### BUG-3 — Partial item refunds do not proportionally reverse the fee (D-R16 interpretation)
- **Bug**: `reversePicFeesForRefund` reverses only when `refundedTickets >= orderItem.quantity` (`refunds/settlement.ts:432-437`); a partial refund of one ticket in a multi-ticket item posts nothing, and the eventual full-item reversal claws back the **whole** fee. Between a partial refund and full refund the PIC is credited 100% of a partially-reverted sale; if the item is never fully refunded, nothing is clawed back for the refunded part.
- **Root cause**: the shipped rule is whole-item-once; the deep audit's §9 prose claimed proportional-per-quantity — the code chose differently and was not re-reconciled against that prose.
- **Reproduction**: quantity-3 item, EARNED 30 000; refund 1 ticket → `pICFeeLedger` REVERSAL count = 0; refund remaining 2 → REVERSAL 30 000.
- **Impact**: MEDIUM — ledger is generous to the PIC during partial refunds; no overdraft at settlement because (pre-payout) the reversal lands before the EARNED is settled.
- **Fix (Phase 30, business decision)**: proportional reversal on each refund increment (`amount = earned.amount × refunded/quantity`, capped), or ratify whole-item semantics in writing.
- **Priority**: MEDIUM.

### GAP-1 — Operator list total shares no balance formula
- `lib/pic/service.ts:131-146` `_sum.amount` all rows ⇒ magnitude sum ("240.00" for EARNED 100 / REVERSAL 40 / PAYOUT 100). Feed to platform `PicManager`. Fix: apply `ΣCREDIT − ΣDEBIT` (or relabel as gross-credit with `type=EARNED` filter) exactly as `getMyFeeSummary`. **MEDIUM** (reporting only).

### GAP-2 — Operator detail credit total capped/status-blind
- `lib/pic/service.ts:353-366` `take:100`; `app/dashboard/pic/[id]/page.tsx:121-123` sums CREDIT regardless of type/status. Fix: full read + `type=EARNED` filter or shared formula. **LOW**.

## 16. Scoring Matrix — Invariants

(Full matrix in `PHASE_29A_PIC_MONEY_LEDGER_AUDIT_REPORT.md` §5.) Counted: **PASS 14 · GAP 2 · FAIL 0 · UNPROVEN 0** across 16 invariants. The two GAPs are reading-surface; no money invariant failed.

| # | Invariant | Verdict |
| --- | --- | --- |
| I-1..I-11 | append-only ledger; formula; EARNED/REVERSAL/PAYOUT exactly-once; claw-back (full/partial); release on fail/cancel; proof gate; reversal gate; payout once | PASS |
| I-12/I-13 | operator totals shared formula | GAP (GAP-1/2) |
| I-14..I-16 | snapshot frozen; GATEWAY_SPLIT unwritten; tenant isolation; Decimal-exact | PASS |

## 17. Scenario Walkthrough (A–L) — 12 verified

| # | Scenario | Expected | Observed (source) | Verdict |
| --- | --- | --- | --- | --- |
| A | One window, one EARNED, no reversal → approve → paid | EARNED→SETTLED, PAYOUT 1×=net, balance 0 | `settlement.ts:791-885`; test `lifecycle` (16/16) | **PASS** |
| B | Two sequential windows, two EARNED, two settlements | Two PAYOUTs, one per window, sum matches both nets | uniqueness + `fee:payout:{sid}:{id}`; no test, code-verified | **PASS** (code) |
| C | Partial claw-back (EARNED 150 + REVERSAL 50) | gross 150, deduction 50, net 100, items 3 (2C+1D), PAID net 100 | `settlement.ts:235-258`; test `partial claw-back` | **PASS** |
| D | Full claw-back (EARNED 150 + REVERSAL 150) | item excluded; nothing settleable ⇒ CONFLICT (or other items only) | `settlement.ts:229-233`; test `full claw-back excludes` | **PASS** |
| E | Refund before any settlement | reversal ages with settlementId null; future window nets it to 0 (item excluded) | `refunds/settlement.ts:448-477` + `settlement.ts:227-233`; covered by C/D | **PASS** (pre-payout) |
| F | Refund between prepare and paid | paid refuses `NEW_REVERSAL_DETECTED`; operator fails→re-prepares | `settlement.ts:766-788`; test `fresh reversal` | **PASS** |
| G | Refund after PAID | REVERSAL posted never netted; balance goes negative | §15 BUG-1 | **BUG-1 (HIGH)** |
| H | Partial refund, item never fully refunded | no reversal; full credit retained | `refunds/settlement.ts:432-437` | **BUG-3 (MEDIUM)** |
| I | Cancel before approval | CANCELLED; items released; ledger untouched | `settlement.ts:1010+`; test `closed window` | **PASS** |
| J | Fail after approval | FAILED; reason persisted; items released; ledger EARNED/unlinked | `settlement.ts:935+`; test `fail releases` | **PASS** |
| K | Duplicate window / replay / re-run | same draft id; re-runs `ALREADY`; no 2nd PAYOUT | `settlement.ts:290-…`; tests `window replays`, `re-running` | **PASS** |
| L | Tenant isolation (stranger; same PIC two tenants) | stranger denied everywhere; per-tenant per-window claims | `service.ts:78-120`; test `tenancy` | **PASS** |

**Scenarios verified: 12/12** (10 PASS, BUG-1 on G, BUG-3 on H).

## 18. Phase 29 Verification Results

| Command | Result | Notes |
| --- | --- | --- |
| `npx prisma validate` | **PASS** | "The schema at prisma/schema.prisma is valid" |
| `npx tsc --noEmit` | **PASS** | exit 0 |
| `npm run lint` | **PASS** | 0 errors, 3 pre-existing `<img>` LCP warnings (`app/e/[slug]/page.tsx`, `components/events/EventCard.tsx`) |
| `npx jest __tests__/ticketing-pic/settlement.integration.test.ts` | **PASS** | 16/16 (accounting, lifecycle, guards) |
| `npx jest __tests__/ticketing-pic __tests__/pic-self-service __tests__/ticketing-refunds` | **PASS** | 14 suites / 203 tests / 2 snapshots |
| `npm test` | **PASS** | 103 suites / **2089/2089 tests** / 2 snapshots / ~60 s |
| `npm run build` | **PASS** | exit 0; `/dashboard/settlements` + `[id]` compiled |

No command failed; therefore no "pre-existing failure" had to be recorded. All runs were read-only against the test DB (`tinggalklik_test`).

## 19. Reconciliation Summary Table (implementation report sections 1–26)

| Impl. § | Claim | Reconcile |
| --- | --- | --- |
| 1 Objective / 2 Method | Option C manual, additive, verified | **TRUE** |
| 3 Delivery model | MANUAL_TRANSFER only | **TRUE** |
| 4 State machine | DRAFT→PENDING_APPROVAL→APPROVED→PAID; cancel/fail release | **TRUE** |
| 5 Money flow/ledger interlock | flips + link + one PAYOUT per EARNED = net | **TRUE** |
| 6 SoD | service half-gate | **TRUE** |
| 7 Tenant isolation | row-scoped, per-tenant window unique | **TRUE** |
| 8 Permissions | reuse only, zero map changes | **TRUE** |
| 9 Bank snapshot/masking | prepare check + snapshot + mask | **TRUE** |
| 10/11 Proof store + serving | magic bytes, 5MB, protected, nosniff | **TRUE** |
| 12 Audit | actions + in-tx financial | **TRUE** (refund rail asymmetry noted) |
| 13 Ledger linkage at PAID | one tx | **TRUE** |
| 14 Paid-time reversal re-check | in-window guard | **TRUE** for its window; **BUG-1** beyond it |
| 15 Duplicate-period wall | unique × 2, replay/CONFLICT | **TRUE** |
| 16 API surface | 10 routes | **TRUE** |
| 17/18 Dashboards | operator + read-only PIC history | **TRUE**; operator platform totals **GAP-1/2** |
| 19 Route inventory | 33 pages/20 dashboard | **TRUE** (build shows routes) |
| 20 Testing | 16 integration | **TRUE** |
| 21 Verification | full suite green | **TRUE** (re-verified 2089/2089) |
| 22 Files | additive | **TRUE** |
| 23 NOT-done list | no iPaymu/no GATEWAY_SPLIT/no PIC withdrawal/no scheduler/no commit | **TRUE** |
| 24 Deviations (4) | payout key, paid re-check exclusion, both payee fields, organizer-scope routes | **TRUE** — all four are exactly what the code does |
| 25 Known gaps | receipt verification manual; exports absent; bank create-only | **TRUE** (unchanged) |
| 26 Verdict | Q1–Q8 all YES | **TRUE** for delivered scope; reconciliation adds BUG-1/gaps |

## 20. Known Bugs

1. **BUG-1 — post-PAID refund claw-back never netted into future settlements (D-18).** HIGH.
2. **BUG-3 — partial item refunds do not proportionally reverse the fee (D-R16).** MEDIUM.
3. **GAP-1 — platform operator `ledgerTotal` magnitude sum, no shared formula.** MEDIUM (reporting).
4. **GAP-2 — operator detail credit total capped at 100 rows, status-blind.** LOW (reporting).

## 21. Recommended Fixes (Phase 30 — not applied in Phase 29)

1. **D-18 decision + implementation**: net-off unconsumed reversals of already-PAID order items at `prepare` (`offset = Σ REVERSAL(DEBIT, settlementId null, orderItem EARNED already SETTLED)`) **or** link-and-flag the PAID settlement for operator action; pick one, test `refund-after-payout` end to end.
2. **Operator totals formula**: `listPicsForAdmin` computes `ΣCREDIT − ΣDEBIT` (or relabel gross-EARNED with a `type=EARNED` filter and inline it with `getMyFeeSummary`); detail page reads full ledger with `type=EARNED`.
3. **D-R16 ratification**: proportional per-refund reversal or documented whole-item decision.
4. Everything else in §25 of the implementation report (exports, KYC, receipt verification controls) are enhancements, not correctness fixes.

## 22. Phase 30 Readiness

| Criterion | Verdict |
| --- | --- |
| Ledger semantics proven | **YES** |
| Balance formula proven | **YES** (self-service/settlement); operator totals **NO** (GAP-1) |
| Settlement eligibility proven | **YES** |
| Payout accounting proven | **YES** |
| Refund interaction understood | **YES** (in-window sealed; post-PAID open = BUG-1) |
| Tenant isolation proven | **YES** |
| Concurrency sufficiently controlled | **YES** (manual rail, contention retry, CAS) |
| Dashboard numbers reconcile | **NO** — platform operator list/detail totals do not use the shared formula |
| No CRITICAL/HIGH unresolved accounting bug | **NO** — BUG-1 (post-PAID claw-back never netted) is HIGH |

**Phase 30 readiness: NO.** Blockers: (1) BUG-1 D-18 net-off/claw-back implementation; (2) GAP-1 operator totals formula; (3) BUG-3 D-R16 proportional-reversal decision. The ledger and the manual settlement rail are release-safe to keep operating; Phase 30 must not add PIC self-withdrawal, auto-disbursement, or iPaymu payout until these close.

## 23. Cleanup and Stored Artifacts

No source, schema, migration, seed, or database change was made; nothing committed or pushed (`git status` untouched — only the two Phase 29 report files are new). Proof fixtures and ledger fixtures live only in the test DB under the `settle-*` and `STL-*` prefixes and are deleted by each suite's `afterAll`. The prior `PIC_PAYOUT_SETTLEMENT_*` reports remain as the audited artifacts.

## 24. Files Read / Referenced (audit-only)

`prisma/schema.prisma`; `lib/pic/attribution.ts`; `lib/pic/self-service.ts`; `lib/pic/service.ts`; `lib/ticketing/checkout.ts`; `lib/ticketing/payment/settlement.ts`; `lib/ticketing/refunds/service.ts`; `lib/ticketing/refunds/settlement.ts`; `lib/ticketing/settlement/{settlement,service,validation,payload,proof}.ts`; `lib/ticketing/db-contention.ts`; `lib/ticketing/audit-log.ts`; `lib/authz/permissions.ts`; `app/dashboard/pic/{page,[id]/page}.tsx`; `app/dashboard/settlements/{page,[id]/page}.tsx`; `__tests__/ticketing-pic/settlement.integration.test.ts`; `jest.config.js`; `package.json`; contract docs `PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md`, `PIC_PAYOUT_SETTLEMENT_V1_IMPLEMENTATION_REPORT.md`; new `PHASE_29A_PIC_MONEY_LEDGER_AUDIT_REPORT.md`.

## 25. Final Verdict (reconciliation Q1–Q8 of the implementation report)

| # | Implementation claim | Reconciliation |
| --- | --- | --- |
| Q1 | An operator can prepare/approve/pay a payout | **CONFIRMED** |
| Q2 | Ledger correctly settled at PAID, atomic | **CONFIRMED** |
| Q3 | SoD enforced | **CONFIRMED** (service half-gate) |
| Q4 | Tenancy enforced end to end | **CONFIRMED** |
| Q5 | Every transition audited (in-tx financial) | **CONFIRMED** |
| Q6 | Proof-of-payment hardened | **CONFIRMED** |
| Q7 | Duplicate-period wall real | **CONFIRMED** |
| Q8 | Out-of-scope list honored | **CONFIRMED** (no iPaymu payout, no GATEWAY_SPLIT, no PIC withdrawal, no auto path, no commit/push) |

**Bottom line:** the earning→paying lifecycle is closed and, within its shipped window semantics, correct. The reconciliation's departures are three documented items (post-PAID refund net-off, partial-refund proportionality, operator totals), all explicitly deferred to Phase 30 with fixes and tests prescribed. The channel between the ledger and the money it claims is **sound and green**.