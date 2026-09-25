# PIC Payout / Settlement — Deep Audit Report

| | |
| --- | --- |
| **Audit** | PIC PAYOUT / SETTLEMENT business flow — "how does an **EARNED** amount become money reaching the PIC?" |
| **Mode** | **AUDIT ONLY** — no source, database, migration or seed changes; nothing fixed; nothing committed or pushed. |
| **Auditor** | opencode (big-pickle) |
| **Date** | 2026-09-24 |
| **Status** | **Audit complete.** The payout/settlement rail is **unimplemented end to end**; the database layer is ready, the permission vocabulary exists (unused), and the money logic (fee accrual, reversal) is production-grade — but the payout execution layer (service + routes + UI + export + proof) does not exist. |

---

## 1. Objective

Audit the complete PIC *payout / settlement* business flow: from the moment a PIC fee becomes **EARNED** on the append-only ledger to the moment a bank transfer or disbursement API would make the PIC whole. Question asked: *"How does an EARNED amount become money paid to the PIC, today?"* — and, if the answer is "it cannot", what exactly is missing and what is already in place.

## 2. Scope and Method

Read-only. No mutation of source, database, migrations, or seeds. No commit, no push. Specifically audited:

- **Schema** (`prisma/schema.prisma`): `PICFeeLedger`, `Settlement`, `SettlementItem`, `PICProfile` (bank fields), `Payment`, `Refund`, `AdminAuditLog`, `IdempotencyKey`, all fee/settlement enums.
- **Money writers**: `lib/ticketing/payment/settlement.ts`, `lib/pic/attribution.ts`, `lib/ticketing/refunds/settlement.ts`.
- **Money readers**: `lib/pic/self-service.ts`, `app/dashboard/pic/*`.
- **Gateway**: `lib/payment/ipaymu.ts`, `lib/payment/config.ts`.
- **Authz**: `lib/authz/permissions.ts`, `__tests__/authz/*` (permission-map, role-matrix, tenant-isolation).
- **API/UI inventory**: `app/api/*`, `app/dashboard/*`.
- **Design & history artifacts**: `TICKETING_PHASE1_DESIGN.md`, `TICKETING_REBUILD_AUDIT.md`, `AUDIT-REMEDIATION-REPORT.md`, `README.md` (§8 sandbox).

**Verification run (all read-only, all green):**

```
npx prisma validate          → schema valid
npx tsc --noEmit             → exit 0
npm run lint                 → 0 errors, 3 pre-existing <img> warnings (unrelated)
npx jest __tests__/authz/permission-map.test.ts __tests__/pic-self-service
                             → 5 suites / 75 tests / 2 snapshots PASSED
```

Pre-existing full-suite state outside this audit's scope: 102 suites / 2073 tests (previous passes). Nothing in this audit changed any test expectation.

## 3. Terminology (the trap)

Two unrelated things share the word **"settlement"** in this codebase. The report never conflates them:

1. **Order settlement** — `lib/ticketing/payment/settlement.ts`. When the iPaymu webhook confirms a payment, the order is CAS-atomically moved `PENDING_PAYMENT → PAID`, quota is converted, tickets are issued, and PIC fee **EARNED** rows are posted. This is the *point of sale*, not the payout.
2. **Payout settlement** — the `Settlement` / `SettlementItem` tables. A scheduled payout to a payee (PIC or organizer), built from EARNED ledger entries, approved, executed, and proof-uploaded. **This is what the business brief calls "settlement" for paying people.** It is **unimplemented** (see §6, §20).

## 4. The business question, answered in one line

**Today, an EARNED amount can never become money in a PIC's bank account.** The ledger records it, the PIC sees it in a read-only dashboard, and there the money stops. No settlement run, no payout request, no transfer instruction, no proof upload, no export, and no disbursement API exist anywhere in the application code.

## 5. Provenance: why the tables exist at all

The `Settlement`/`SettlementItem` models were designed, not built:

- `TICKETING_PHASE1_DESIGN.md` §16 "Settlement Model" — one payee-discriminated table ("Phase 0's `AffiliatePayout` is the template", §16.1), a full state machine (`DRAFT → PENDING_APPROVAL → APPROVED → PROCESSING → PAID`, §16.3), and explicit recommendations (Option C execution, §16.4; SoD, §16.3; settlement cadence/hold, D-21).
- `TICKETING_REBUILD_AUDIT.md`: "settlements and payouts (automatic or assisted)" listed as **future/post-MVP** work; §28.1 "Settlement: a `Settlement`/`OrganizerPayout` record per period, computed from PAID orders only… (mirror `AffiliatePayout`)".
- `prisma/schema.prisma` comments: "Two payee types on one table… documented and enforced in the service layer **from Phase 9**" (schema:1551) and the `GATEWAY_SPLIT` value "**MUST NOT be used until iPaymu split-settlement is verified (D-04)**" (schema:593).
- The acute-phase remediation history (`AUDIT-REMEDIATION-REPORT.md`) that fixed the legacy **Affiliate** payout webhook belongs to the retail app; the affiliate program (and its payout webhook) was **removed** with the retail scope (`prisma/schema.prisma` header comments; `TICKETING_REBUILD_AUDIT.md` §34.2 "DEPRECATE"). No affiliate payout code remains in the repo (verified — `lib/affiliate/`, `app/api/payment/payout/` do not exist).

## 6. The state machine today: schema vs. design vs. code

| Layer | Transitions that actually exist | Source |
| --- | --- | --- |
| **Write code (app layer)** | `EARNED` (credit, `type=EARNED`, `status=EARNED`) on order settle · `REVERSAL` (debit, `type=REVERSAL`, `status=VOID`) on refund | `lib/ticketing/payment/settlement.ts:472`, `lib/ticketing/refunds/settlement.ts:448` |
| **Enums (schema)** | `PICFeeStatus`: `PENDING/EARNED/PAYABLE/APPROVED/SETTLED/VOID` · `SettlementStatus`: `DRAFT/PENDING_APPROVAL/APPROVED/PAID/FAILED/CANCELLED` — **no `PROCESSING`** (dropped vs. design) | `prisma/schema.prisma:584-600, 555-560` |
| **Design (doc)** | `EARNED ──settlement──▶ PAID`, `EARNED ──refund──▶ REVERSED`, `DRAFT→PENDING_APPROVAL→APPROVED→PROCESSING→PAID`, `→FAILED`, `any→CANCELLED` | `TICKETING_PHASE1_DESIGN.md` §15.4, §16.3 |

**Verified:** even the *used* enum values are a subset of what exists. Grep across `app/`, `lib/`, `components/` shows the only **written** `PICFeeEntryType` values are `EARNED` and `REVERSAL`; only ledger statuses written are `EARNED` and `VOID`. `PAYABLE`, `APPROVED`, `SETTLED`, `PENDING`, `ADJUSTMENT`, `PAYOUT`, `EARLY_ACCRUAL`, and the entire `SettlementStatus`/`SettlementMethod` enum set have **zero writers**.

## 7. Verified current money flow (end to end)

```
buyer pays → iPaymu notification         validated HMAC + amount  lib/payment/ipaymu.ts, app/api/payment/ipaymu/notification/route.ts
           → CAS settle order            UPDATE … WHERE status IN (PENDING,PROCESSING) AND paymentStatus NOT IN (PAID,REFUNDED)
                                          retried; @@unique([orderItemId,type]) guards double-credit     lib/ticketing/payment/settlement.ts:472
           → snapshot PIC fee EARNED      CREDIT row, status=EARNED, idempotencyKey "fee:earned:{orderItemId}",
                                          unique(orderItemId,type)                                      lib/pic/attribution.ts:224
           → PIC reads read-only balances net = CREDIT − DEBIT (self-service summary)                  lib/pic/self-service.ts:316
           → ✗  PAYOUT. Stops here.       (continuation is §20)
```

The PIC self-service dashboard (`app/dashboard/pic/page.tsx`, `[id]/page.tsx`) is **read-only by design** (§2 of `lib/pic/self-service.ts`): overview, assignments, attributions, fee summary, ledger list. There is no button, route, or endpoint for "request payout", "pencairan", "withdraw", or "settlement". Confirmed by full route inventory (§15).

## 8. The fee/ledger sources of truth

- **EARNED writer**: `postEarnedPicFees` (`lib/pic/attribution.ts:224`). Invoked inside the order-settlement transaction (`lib/ticketing/payment/settlement.ts:472`, `settleVerifiedPayment` SETTLED branch). Replays the checkout snapshot; the `@@unique([orderItemId, type])` + `idempotencyKey @unique` make it a double-credit no-op.
- **REVERSAL writer**: `reversePicFeesForRefund` (`lib/ticketing/refunds/settlement.ts:448`). Called from the refund settle path (`REFUNDED`). Posts `type=REVERSAL, direction=DEBIT, status=VOID`, idempotencyKey `fee:reversal:{refundId}:{orderItemId}`; skips when a reversal already exists. `RefundFeeTreatment` = `REVERSED`.
- **Ledger is append-only in practice**: no `pICFeeLedger.update` / `pICFeeLedger.delete` anywhere in `app/`/`lib/` (verified by grep). The design matches: "There is no code path that edits a ledger entry" (`TICKETING_PHASE1_DESIGN.md` §15.5). Corrective actions are new `ADJUSTMENT` rows **by design** — but no adjustment writer exists yet either.

**Snapshot rule honoured**: every EARNED row snapshots `rateBp`/`fixedAmount`/`basisType`/`basisAmount`/`quantity` (`PICFeeLedger`, schema:1484) so later config changes cannot retroactively alter an earned figure (design §16.2/§17.2).

## 9. Refund interaction with the ledger (full and partial)

- **Full refund** → one `REVERSAL` DEBIT per affected order item, `status=VOID`, never payable.
- **Partial refund** → reversal covers only the refunded quantity with the same snapshot.
- **Refund execution itself is a manual bank transfer**: the settle path stores `providerRef = input.transferRef` (`lib/ticketing/refunds/settlement.ts:317`, `:377`); the route derives `transferRef` from input (`lib/ticketing/refunds/service.ts:701`). **No iPaymu refund API call is made** — refunds are paid back to the buyer manually, off-platform. This is the single strongest precedent that manual, proof-bearing money movement is the operating norm here.

## 10. Idempotency and double-payment guards (present vs. absent)

Already in place (verified in schema):

| Guard | Location |
| --- | --- |
| Ledger: `@@unique([orderItemId, type])` — one EARNED per line | schema:1525 |
| Ledger: `idempotencyKey @unique` | schema:1488/1522 |
| `Settlement @@unique([payeeType, picProfileId, periodStart, periodEnd])` — one settlement per payee per period | schema:1590 |
| `Settlement @@unique([payeeType, organizerId, periodStart, periodEnd])` | schema:1591 |
| `SettlementItem.picFeeLedgerId @unique` — a ledger entry can be paid **at most once** | schema:1605 |
| Order settle: CAS `UPDATE…WHERE` + retry + `@@unique` = replay-safe, webhook-idempotent | `lib/ticketing/payment/settlement.ts` |

Absent (because the payout layer doesn't exist): any code that reads these constraints, any `settlementNumber` generator (`STL-…` per design §16.1 — field is `@unique` but no code ever sets it), any status-transition CAS for `Settlement`. Good news for the minimum build: the schema-level anti-double-payment design is *already correct*; a service just has to use it.

## 11. Concurrency analysis

- **Order settlement**: single-row CAS in a retry loop with a 20 s transaction timeout — sound. Two racing webhooks cannot double-post EARNED (unique guard).
- **Refund reversal**: guarded by idempotencyKey + existence check — sound.
- **Future payout**: the risk the schema already neutralises is *double-pay of the same period* (two unique-pair indexes) and *double-settle of the same ledger entry* (unique `SettlementItem.picFeeLedgerId` + `PICFeeLedger.settlementId`). A payout *service* would still need to (a) pick EARNED-only rows, (b) snapshot the bank account into `Settlement`, (c) set the `settlementId` on each ledger row and create `PAYOUT` DEBIT entries — all inside one transaction with the CAS on `Settlement.status`. **None of that exists.**

## 12. iPaymu capability inventory

`lib/payment/ipaymu.ts` (plus `ipaymu-production.ts`, `config.ts`) exports collection and verification surfaces only:

- `createRedirectPayment` / `createDirectPayment` — payment sessions.
- Notification classification + HMAC/amount verification (`classifyIpaymuNotification`, `verifyIpaymuNotification`, `fetchTransactionStatus`).
- **No** refund API, **no** disbursement/transfer/payout API, **no** split-settlement API, **no** balance/ledger reconciliation API.

This matches the design's explicit stance: "It does not assume iPaymu capabilities that Phase 0 could not verify. Split settlement is treated as unverified (§22, §16)" (`TICKETING_PHASE1_DESIGN.md`), and the schema comment holding `GATEWAY_SPLIT` as storage-only pending D-04 verification (schema:593). `README.md` §8 only documents sandbox usage for payment creation.

**Consequence**: payouts (PIC or organizer) cannot be executed through iPaymu today. The design's own recommended execution mode is **Option C — automate the report, transfer manually, upload proof** (`TICKETING_PHASE1_DESIGN.md` §16.4 recommendation; D-20). Notably, even Option C's "transfer manually + upload proof" is **not implemented** — there is no proof-upload surface (§17).

## 13. Business decision history (design only — all open)

Every money-movement policy decision is recorded in the design doc as `DECISION REQUIRED` and **none is acted on in code**:

| Decision | State |
| --- | --- |
| D-20 settlement option (A/B/C) — recommendation **C** (hybrid/manual) | Open, not implemented |
| D-21 cadence + hold period (recommendation: hold until event ends → `EARNED→PAYABLE`) | Open — the `EARNED→PAYABLE` transition is not implemented |
| D-19 SoD threshold / strict two-person control | Partially reflected in permission design (D-19 test), not in any service |
| D-18 refund-after-payout claw-back vs net-off | Open (irrelevant today — no payouts exist) |
| R-10 Excel exports (Transaction, PIC Fee, Event Sales, Settlement) | "Designed", not built (§18) |

## 14. Payout destination (bank account) inventory

- **Storage**: `PICProfile.bankName / bankAccountName / bankAccountNumber` (schema:1383-1385), `String?`, max 64 (validation `accountField = string.trim().max(64).optional()`, `lib/pic/validation.ts:59`).
- **Written**: only at PIC creation (`createPic`, `lib/pic/service.ts:234`). Admin PIC flow (`app/api/admin/pic/route.ts` POST, `PATCH` on `[id]` strictly `updatePicStatus`) and organizer PIC flow (`app/api/organizer/pic/route.ts`) **cannot edit bank data**.
- **Self-service**: read-only; bank shown **masked** via `maskAccountNumber` (`app/dashboard/pic/[id]/page.tsx:78`).
- **Not present**: no PIC bank self-edit, no admin bank-update, no PayoutProfile/beneficiary confirmation, **no KYC/verification step**. If a PIC's account changes, nothing in the system can record the change; a future settlement would snapshot whatever the ledger-adjacent profile holds at run time (mirroring the design: "snapshot of payee bank details captured" at prepare, §16.3).
- **Design expectation** (unverified at code level): PICs entering financial details is *designed* (see self-service brief bullet "transaction value, fee accrued/payable/paid" §5 and dashboard requirements). Today the write path is admin-initiated at create only.

## 15. Roles, permissions and scope (fully designed, zero consumers)

The authz vocabulary for settlement/payout **and** the export permissions **are fully defined, scoped, tested — and never enforced by any business code** (grep: only `lib/authz/permissions.ts` and authz tests reference them).

| Permission (P.) | Defined | Scope | Holders (by role/test) | Consumed by business code |
| --- | --- | --- | --- | --- |
| `SETTLEMENT_PREPARE` | permissions.ts:193 | ORGANIZER | OWNER, MANAGER, FINANCE (by role); ADMIN via grant; PIC/CHECKIN_STAFF denied | **none** |
| `SETTLEMENT_APPROVE` | permissions.ts:194 | ORGANIZER | same | **none** |
| `SETTLEMENT_PROOF_UPLOAD` | permissions.ts:195 | ORGANIZER | same | **none** |
| `FEE_MARK_PAID` | permissions.ts | ORGANIZER | OWNER/MANAGER/FINANCE/ADMIN-default(org) | **none** |
| `REPORT_EXPORT_PIC_FEE` / `REPORT_EXPORT_TRANSACTION` / `REPORT_EXPORT_FINANCIAL` | permissions.ts | ORGANIZER | OWNER/MANAGER/FINANCE (+ADMIN default org for EXPORT_FINANCIAL) | **none** |

Details verified: `ORGANIZER_SCOPE_FINANCIAL` includes the three SETTLEMENT_* and export perms (permissions.ts:296-307). Platform ADMIN *inside a tenant* has **no** financial permissions by design (D-19) — `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.ADMIN` (permissions.ts:353-375) is deliberately free of settlement/refund-approve/fee/export, and the D-19 test pins `ADMIN` to set `SETTLEMENT_APPROVE` (permission-map.test.ts:149-173); `OrganizerMemberRole.ADMIN` is intentionally unmapped (D-05). Roles that hold settlement authority by default are **OWNER, MANAGER, FINANCE** (membership maps permissions.ts:430-521); CHECKIN_STAFF (least privilege) and PIC (viewer-only) are denied `SETTLEMENT_APPROVE` (permission-map.test.ts:314-341, 343-368). Tenant isolation for `SETTLEMENT_APPROVE` is cross-organizer-tested (tenant-isolation.integration.test.ts:452-479). Role-matrix pins (role-matrix.integration.test.ts:278).

**Critical findings for a future build** (detail in §19): (a) the permission gate is fully ready — a settlement service would hook `requireOrganizerAccess(…, P.SETTLEMENT_*)` with zero permission-map changes; (b) **SoD is NOT enforced by the role layer**: one role (OWNER, MANAGER, or FINANCE) simultaneously holds prepare, approve, and proof-upload. The design's "approver must not be the preparer" (§16.3 D-19) can therefore only be enforced at the service layer; (c) the platform ADMIN currently receives no org-scope financial power even though `AdministratorFiatAuthorizer`… (see §19).

## 16. Segregation of duties pattern (already proven in this repo)

The refund flow is the template the settlement flow must copy:

- Request `REFUND_REQUEST` → approve `REFUND_APPROVE` → execute `REFUND_EXECUTE`, each a distinct transition with its own route and actor check: `app/api/ticketing/refunds/[refundId]/approve`, `/reject`, `/settle`; service logic in `lib/ticketing/refunds/service.ts`.
- The executors already carry hard "not-your-own-action" enforcement: "the buyer cannot approve/execute their own refund" (`lib/ticketing/refunds/service.ts:349`, `:400`) and require a **different actor** than the requester (e.g. `refund.approve` half-gate).
- Admin permission model mirrors it: `REFUND_APPROVE` is in `ADMIN_GRANT_REQUIRED` (D-19), absent from ADMIN defaults, held by OWNER/MANAGER/FINANCE by role.

A settlement service would re-use the identical half-gate (`preparedByUserId !== approvedByUserId`), the identical `CREATE→PENDING_APPROVAL→APPROVED→PAID` spine, and the **same mandatory audit writer**.

## 17. UI / API inventory (what a payout operator can click today — nothing)

Full sweep of `app/api/*` and `app/dashboard/*` (also `app/admin` does not exist; administration lives under `/dashboard`):

- **Dashboard**: `check-in · customers · events · orders · payments · pic · refunds · reports · settings · venues`. **No settlement page, no payout page.**
- **The only "settle" route** is `app/api/ticketing/refunds/[refundId]/settle` — that is **refund** settlement (executing a refund), unrelated to the `Settlement` table. Its `SETTLEMENT_STATE_INVALID` error code (`lib/api/errors.ts:56,112,141`, consumed `lib/ticketing/refunds/settlement.ts:198`) is a *refund state-machine* guard string — do not mistake it for payout support.
- **Upload/proof infrastructure**: only event banner/uploads exist (`app/api/uploads/events/[filename]`, `app/api/organizer/events/[id]/images/…`). No generic document upload route, so `Settlement.proofFilePath` has no way to be populated.
- **PIC admin**: `app/api/admin/pic/route.ts` GET/POST, `app/api/admin/pic/[id]/route.ts` GET/PATCH(status only); organizer: `app/api/organizer/pic/route.ts` GET/POST, `[id]` DELETE. No fee-marking, no settlement, no payout endpoint.

## 18. Reporting / export readiness

- The dashboard reports page (`app/dashboard/reports/page.tsx` + `lib/dashboard/reports.ts`) surfaces **sales/orders/revenue over an explicit window** only — it is a "what sold" report, has no fee/payable/paid columns, and has **no export button**.
- Export permissions are dead code (§15). There is no Excel/CSV export service anywhere; design R-10 (Transaction, PIC Fee, Event Sales, **Settlement** exports) is "Designed" only.
- Ledger read surfaces that *do* exist: self-service summary/ledger (`lib/pic/self-service.ts`), attributed orders, PIC overview. Sufficient to build the PIC Fee report, but the report/export layer for payout ops is absent.

## 19. What the minimum payout implementation must contain (Option C — additive only)

Nothing below requires a schema change; the models already support every step. Two non-negotiable cross-cutting rules from the design are also listed. In build order:

1. **Settlement service** (`lib/ticketing/settlement/*`): prepare (select `type=EARNED`∧`status=EARNED` ledger rows in period; compute gross/net; generate `settlementNumber`; **snapshot bank fields** into `Settlement`), submit, approve (half-gate `preparedByUserId !== approvedByUserId`, enforcing D-19 SoD at service layer since the role layer cannot), mark paid (**sets `settlementId` on ledger rows, creates `PAYOUT` DEBIT rows, `FEE_MARK_PAID`/`SETTLED` statuses**), fail/cancel (releases entries).
2. **API routes** `app/api/admin/settlements/…` (prepare/approve/mark-paid/proof) gated by `SETTLEMENT_PREPARE/APPROVE/PROOF_UPLOAD` — zero permission-map work.
3. **Proof upload**: generic document upload route feeding `Settlement.proofFilePath` (upload infra today only covers event images).
4. **Dashboard page(s)**: settlement list/detail + PIC payout history; PIC self-service gains read-only payout rows (never edits bank).
5. **Exports** (R-10 PIC Fee + Settlement at minimum) using the existing `REPORT_EXPORT_*` perms.
6. **Audit**: every transition writes `AdminAuditLog` with action `settlement.prepare/approve/paid/cancel`, actor identity, `entityRef`, `beforeState/afterState` (`lib/ticketing/audit-log.ts` precedent).
7. **Balance formula alignment**: the self-service summary computes `net = Σ CREDIT − Σ DEBIT` across *all* statuses (`lib/pic/self-service.ts:316-341`). Once settlements exist, the "payable" figure and the settlement-prepare selection must both agree on the design formula `Σ EARNED/PAYABLE credits − reversals − PAID (PAYOUT)` (§15.4); today there is no distinction because nothing is ever marked paid.

**The design doc's complete copy-paste-able contract is §15.4 (entry lifecycle), §16.3 (state machine + SoD), §16.4 (Option C).**

## 20. Evidence/proof-of-payment infrastructure readiness

- `proofFilePath`, `providerReference`, `providerStatus` exist on `Settlement` (schema:1568-1570) — **unpopulated**; no code.
- `AdminAuditLog` (schema:242) already carries `actorType/actorUserId/actorRole/actorOrganizerId/organizerId/entityRef/beforeState/afterState/reason/ipAddress/userAgent/correlationId` — payout transitions fit it without modification.
- `IdempotencyKey` table (schema:1681) and ledger idempotencyKey strings are the replay-guard story; the settlement service should mint keys like `settle:{settlementNumber}` before any external side effect.
- `Payout status` evidence would arrive from the uploaded proof file (Option C) or a future gateway disbursement API (Option B, blocked on D-04 verification).

## 21. What must NOT change (preserve invariants)

- **Ledger append-only**: no `pICFeeLedger.update/delete` paths — new entries only.
- `@@unique([orderItemId, type])` and `idempotencyKey` uniqueness: the double-credit wall.
- `SettlementItem.picFeeLedgerId` uniqueness and the two payee-period `@@unique` constraints: the double-pay walls.
- Order settlement CAS shape (`settleVerifiedPayment`); EARNED posting must stay inside that transaction.
- Refund reversal path: `REVERSAL` debit + `VOID` status, never mutating the original EARNED row.
- **Snapshot rule**: settlement must snapshot bank + rate basis, never read live config.
- `GATEWAY_SPLIT` value: must remain unwritten until D-04 split-settlement is verified against iPaymu.
- Bank data: do not add PIC self-edit without an approval/audit wrapper (masked display only).
- Permission model: do not hand platform ADMIN org-scope financial power by default (D-19 is load-bearing and tested).

## 22. Risks surfaced by this audit

1. **Financial-feature brand forgery**: the *existence* of `Settlement` tables, settlement permissions, and a `settlement` error code can make the system look payout-capable. It is not. Any operator-facing statement "fees are settled automatically" is false today.
2. **PIC balance ≠ cash**: the self-service "net" figure is *earned money the company owes* — with no liability account or escrow, and no status separation once settlements are introduced (§19.7).
3. **stale bank data**: bank account is create-only and unverifiable; a real payout built on a stale account is a hard failure and an unhappy PIC. KYC/confirmation is absent from the design decisions too.
4. **SoD at permission-layer gap**: prepare+approve+proof all default to the same role; service-layer half-gate is mandatory, never reliance on the role map.
5. **Refunds land after a hypothetical payout**: no claw-back/net-off logic exists (D-18). Safe today (no payouts); must be settled before Option C goes live.
6. **Process/runtime gap**: manual transfer + proof upload has no *verification* step (does the receipt actually clear?) — unchanged from the design, but worth naming as a control gap.

## 23. Alternative: what would make it automated/self-serve

If the business ever wants PIC-initiated payouts or gateway-driven disbursement:

- **PIC-initiated**: a `POST /api/pic/settlements/request` that opens a `DRAFT` (or `PENDING_APPROVAL` directly) under a **global/pic-scope** settlement permission the PIC holds (today `SETTLEMENT_*` is ORGANIZER-scope and PIC is denied) — i.e. a new permission (e.g. `settlement.request.own`) plus a PIC-role map row. Note: this reverses the current "PIC is read-only" self-service design (§2 of `lib/pic/self-service.ts`) and contradicts the brief's "capture, manual, proof-upload" stance unless approved explicitly.
- **Gateway-driven**: possible only after split-settlement verification (D-04), which is untestable without live iPaymu sub-merchant config (`AUDIT-REMEDIATION-REPORT.md` "NEEDS RUNTIME VERIFICATION" precedent). The ledger stays the source of truth (§16.4).

## 24. Verification evidence (read-only)

```
$ npx prisma validate                     → "The schema at prisma/schema.prisma is valid"
$ npx tsc --noEmit                        → exit 0
$ npm run lint                            → 0 errors, 3 warnings (pre-existing <img> LCP advisories)
$ npx jest __tests__/authz/permission-map.test.ts __tests__/pic-self-service
                                           → 5 suites, 75 tests, 2 snapshots, all PASSED
```

Grep confirmations: `Settlement`/`SettlementItem` appear only in `prisma/schema.prisma`, `app/api/ticketing/refunds/[refundId]/settle` (refund), dashboard/orders/refunds pages (unrelated), and authz tests; no `pICFeeLedger.update/delete`; no `POST/GET …/settlement` route; no `REPORT_EXPORT_*` consumer.

## 25. Final verdict — the eight questions

| # | Question | Answer |
| --- | --- | --- |
| Q1 | **Can a PIC withdraw/request payout today?** | **NO.** Zero self-service or API surface; PIC self-service is read-only. |
| Q2 | **Can an Admin pay a PIC today?** | **NO.** No settlement service, no route, no UI, no proof upload; bank data snapshot and settlement rows are never written. |
| Q3 | **Is `Settlement`/`SettlementItem` implemented?** | **NO — schema-only.** Every field, enum, and unique index exists (schema:1551/1602); not a single row can be created by any code path, and the `SettlementStatus` enum even drops the design's `PROCESSING` state. |
| Q4 | **Is a payout destination fully implemented?** | **PARTIAL.** Storage exists (`PICProfile` bank fields) and validation caps them, but data is **create-only**, never updateable by PIC or admin, displayed masked, never snapshotted, never verified/KYC'd, and no payout beneficiary record is ever produced. |
| Q5 | **Is iPaymu payout/disbursement implemented?** | **NO.** iPaymu integration is collection-only (session creation, webhook verification, status fetch). Refund money movement is a *manual bank transfer* (transferRef), and `GATEWAY_SPLIT` is storage-only pending D-04. |
| Q6 | **Can the system *safely* support a payout if a minimal layer were added?** | **YES, on condition.** The DB anti-double-payment design is correct (period-unique `Settlement`, entry-unique `SettlementItem`, append-only ledger, idempotency keys, refund-side SoD template, audit model). The must-haves before going live: service-layer SoD half-gate, bank snapshot at prepare, EARNED-selection + formula alignment (§19.7), an audit write per transition, proof-upload path, and D-18 claw-back handling. None of these are schema blockers. |
| Q7 | **What is the minimum implementation?** | A settlement service + 3-4 routes + proof upload + one dashboard page + export + audit wiring — **all additive, no schema/permission-map change, permission-agnostic to enforcement** (see §19). Design doc §15.4/§16.3/§16.4 is the ready-made spec. |
| Q8 | **What must NOT change when building it?** | The append-only ledger, the three uniqueness walls, the order-settle CAS, the reversal path, the snapshot rule, the `GATEWAY_SPLIT` hold, and the D-19 ADMIN default (see §21). |

**Bottom line:** the *earning* half of PIC money is production-grade; the *paying* half does not exist. Every structural guard needed to pay a PIC correctly is already modelled; what is missing is the service layer, the operator surface, and the proof-of-remittance workflow — and with them, the operating decision (Option C manual vs. gateway split, cadence, hold, refund claw-back) that the design doc deliberately left open.

---

### Appendix A — key references

| Asset | Location |
| --- | --- |
| `Settlement` model | `prisma/schema.prisma:1551-1596` |
| `SettlementItem` model | `prisma/schema.prisma:1602-1619` |
| `PICFeeLedger` model (+ unique/append-only contract) | `prisma/schema.prisma:1484-1548` |
| Fee enums | `prisma/schema.prisma:553-615` (`PICFeeEntryType`, `PICFeeStatus`, `LedgerDirection`, `SettlementPayeeType`, `SettlementStatus`, `SettlementMethod`, `RefundFeeTreatment`) |
| `PICProfile` (bank fields) | `prisma/schema.prisma:1371,1383-1385` |
| `AdminAuditLog` | `prisma/schema.prisma:242` |
| EARNED posting | `lib/ticketing/payment/settlement.ts:472` → `lib/pic/attribution.ts:224` |
| REVERSAL posting | `lib/ticketing/refunds/settlement.ts:448` |
| Refund manual transfer (`transferRef`) | `lib/ticketing/refunds/service.ts:701`, `settlement.ts:317,377` |
| iPaymu surface (collection-only) | `lib/payment/ipaymu.ts`, `lib/payment/config.ts` |
| Settlement/export permissions | `lib/authz/permissions.ts:193-195,296-307,353-412,430-521` |
| SoD refund half-gate | `lib/ticketing/refunds/service.ts:349,400` |
| Self-service (read-only) fee summary | `lib/pic/self-service.ts:316-341` |
| Self-service page / masked bank | `app/dashboard/pic/page.tsx`, `[id]/page.tsx:78` |
| Refund-only "settle" route | `app/api/ticketing/refunds/[refundId]/settle/route.ts` |
| Reports page (sales-only, no export) | `app/dashboard/reports/page.tsx`, `lib/dashboard/reports.ts` |
| Design spec for settlement | `TICKETING_PHASE1_DESIGN.md` §15.4, §16.1-16.5, §17, R-10 (§24.2) |
| Design decisions (all open) | D-05, D-18, D-19, D-20, D-21, D-04 (schema:593) |
| Affiliate payout (removed precedent) | `TICKETING_REBUILD_AUDIT.md` §34.2; `AUDIT-REMEDIATION-REPORT.md` (historical) |

### Appendix B — files read for this audit

`prisma/schema.prisma`; `lib/ticketing/payment/settlement.ts`; `lib/pic/attribution.ts`; `lib/ticketing/refunds/settlement.ts`; `lib/ticketing/refunds/service.ts`; `lib/ticketing/refunds/payload.ts`; `lib/api/errors.ts`; `lib/pic/self-service.ts`; `lib/pic/service.ts`; `lib/pic/validation.ts`; `lib/payment/ipaymu.ts`; `lib/payment/config.ts`; `lib/authz/permissions.ts`; `__tests__/authz/permission-map.test.ts` (incl. role-matrix + tenant-isolation references); `app/dashboard/pic/page.tsx`; `app/dashboard/pic/[id]/page.tsx`; `app/dashboard/reports/page.tsx`; `lib/dashboard/reports.ts`; `app/api/pic/*`, `app/api/admin/pic/*`, `app/api/organizer/pic/*`; `app/api/ticketing/refunds/*`; route + dashboard directory sweeps; `TICKETING_PHASE1_DESIGN.md`; `TICKETING_REBUILD_AUDIT.md`; `AUDIT-REMEDIATION-REPORT.md`; `README.md`.