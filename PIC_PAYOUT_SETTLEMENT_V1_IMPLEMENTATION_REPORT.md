# PIC PAYOUT / SETTLEMENT V1 IMPLEMENTATION REPORT

**Final status: `PIC PAYOUT / SETTLEMENT V1 [COMPLETE]`**

## 1. Objective

Ship the first paying half of the PIC money lifecycle: an operator-driven, manually-transferred
payout flow (Option C of `PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md` §19) with full system
control — state machine, segregation of duties, tenant isolation, ledger linkage, audit trail,
proof-of-payment upload, operator dashboard, read-only PIC history, and integration coverage.

The earning half was already production-grade; this restores the *paying* half in an additive,
verified way. Nothing here changes the append-only ledger, the three anti-double-payment walls,
the order-settle CAS, the refund reversal path, or the `GATEWAY_SPLIT` hold.

## 2. Scope and Method

In build order per the audit contract (§19):

1. Settlement service library `lib/ticketing/settlement/*`.
2. API routes under `app/api/organizer/settlements/*` gated by the reuse permissions.
3. Proof-of-payment storage + protected serving.
4. Operator dashboard (list, detail, actions, prepare form).
5. PIC self-service read-only settlement history.
6. Audit logging on every transition.
7. Integration tests against the real test database.
8. Verification evidence (schema, types, lint, journeys, full suite, production build).

This project **does not commit or push**; the working tree carries the change only.

## 3. Delivery model (Option C — manual bank transfer, system-controlled)

Contracted in `PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md` §19 and delivered as chosen:

- An organizer operator prepares a payout for a PIC over a period window; the system computes
  gross/deduction/net from the ledger, snapshots bank data, and creates a DRAFT.
- Approval and payment are performed by a *different* organizer member (half-gate at service
  layer — D-19).
- Payment is executed by the operator **manually** (bank transfer off-platform) and evidenced
  by an uploaded proof file + a manual `providerReference`; the system then flips the ledger.
- PICs cannot request, self-withdraw, or see full bank numbers anywhere.

`Settlement.method` is always `MANUAL_TRANSFER`. `GATEWAY_SPLIT` is never written.

## 4. State machine implemented

```text
DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──paid──▶ PAID
   │                  │                            │
   └─cancel──▶ CANCELLED    └─cancel──▶ CANCELLED  └─fail──▶ FAILED
```

- No `PROCESSING` state exists (schema enum never had it; service never transitions to it).
- `CANCELLED`/`FAILED` release their `SettlementItem` claim lines; the ledger rows stay
  `EARNED` + unlinked and remain consumable by a future period.
- Every transition is guarded by the owning organizer's permission resolved **from the row**
  (`requireOrganizerAccess(settlement.organizerId, perm)`), so a row is only ever acted on by
  someone with rights in its own tenant.
- Transitions are idempotent re-runs: re-`submit`/`approve`/`paid` on a completed row returns
  the row as `ALREADY` instead of double-effect.

## 5. Money flow / ledger interlock

At `paid` the single transaction does three things atomically:

1. Flips every included EARNED row to `status = SETTLED` and sets `settlementId`.
2. Links included REVERSAL (DEBIT) rows by setting their `settlementId` (status untouched).
3. Appends **one** PAYOUT row per included EARNED row: `type = PAYOUT`, `direction = DEBIT`,
   `status = SETTLED`, `settlementId = <id>`, `amount = <the earned amount>`. The PAYOUT sum
   therefore always equals the settlement net (all credits minus all included reversals).

The PAYOUT rows carry `idempotencyKey = "fee:payout:{settlementId}:{earnedId}"`, so a re-drive
of `paid` can never append a second money row — the unique key is the double-payment wall. See
§24 for the documented deviation this key represents.

## 6. Segregation of duties

`PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md` risk #4 (D-19): the role map grants
prepare/approve/proof to the same membership, so the permission layer alone cannot separate
duties. The service layer therefore enforces:

- the person who **prepared** the settlement cannot `approve` or `paid` it
  (`preparedByUserId !== approvedByUserId/paidByUserId`);
- proof upload is not duty-bearing (it is evidence, not approval), but still requires
  `SETTLEMENT_PROOF_UPLOAD`.

The integration suite pins this: an OWNER who prepares and then tries to approve their own
settlement is refused with `FORBIDDEN`.

## 7. Tenant isolation

- Every operation resolves the row's OWN `organizerId` and calls
  `requireOrganizationAccess(organizerId, permission)`; a forged `organizerId` in a list query
  is refused with `ORGANIZER_ACCESS_DENIED`.
- The unique settlement key includes `organizerId` (`@@unique([payeeType, organizerId,
  picProfileId, periodStart, periodEnd])`), so the same PIC earning in two tenants can be
  settled once per tenant, in the same window.
- Cross-tenant reads are 404/denied everywhere; the test suite proves a stranger-OWNER is
  refused for prepare, list, and detail.

## 8. Permissions and capabilities

Reused as-is (zero permission-map changes):

- prepare / submit / cancel  → `SETTLEMENT_PREPARE`
- approve / fail / mark-paid → `SETTLEMENT_APPROVE`
- proof upload / proof read  → `SETTLEMENT_PROOF_UPLOAD`
- PIC reads its own rows     → `PIC_FEE_READ_OWN` (existing self-service rule)

The operator side derives `canManageSettlements` in `computeDashboardCapabilities` from
`hasOrganizerPermission(scope, SETTLEMENT_PREPARE)` — the same permission the list/detail reads
require — which keeps the nav, list, detail, and actions truthful to one another.

## 9. Bank snapshot and masking

- `prepare` refuses a PIC without bank details (`BANK_DETAILS_MISSING`).
- Bank country/name/account-name/account-number are snapshotted onto the `Settlement` row at
  prepare time — the operator sees what was true when the payout was opened, never live config
  (snapshot rule, audit §21).
- Payloads expose only the masked account number (`••••7890`) and a display bank string; the
  full number lives in the DB and is returned only on server-side action outcomes the operator
  already performed.

## 10. Proof-of-payment upload and storage

`lib/ticketing/settlement/proof.ts`:

- Own storage tree `<UPLOAD_DIR>/settlement-proof/**` (`UPLOAD_DIR` env, default
  `storage/uploads/settlement-proof`).
- Magic-byte validation: JPEG/PNG/WebP via `detectImageFormat`, or `%PDF-` header; 5 MB cap;
  server-generated filename (extension derived from the detected type, never from the client).
- Re-upload while `APPROVED` replaces the file; the superseded file is deleted only **after**
  the new one is committed.
- `deleteStoredProof` refuses path separators and is idempotent; `readStoredProof` returns
  `null` for traversals/nested names.

## 11. Protected proof serving

`GET /api/organizer/settlements/[settlementId]/proof/[fileName]`:

- `requireAuth()` + `SETTLEMENT_PROOF_UPLOAD` permission against the row's tenant.
- Basename guard plus an exact `proofFilePath === fileName` match, so only the current stored
  proof is reachable and stranger file paths are a miss.
- Serves raw bytes with `Content-Disposition: inline`, `Content-Type` from the detected type,
  and `X-Content-Type-Options: nosniff`.

## 12. Audit logging

Every transition writes to the audit log through `lib/ticketing/audit-log.ts`:

- actions: `settlement.prepare`, `settlement.submit`, `settlement.approve`,
  `settlement.proof_upload`, `settlement.paid`, `settlement.failed`, `settlement.cancel`;
- entityTypes: `Settlement` (and `PICFeeLedger` for the PAID ledger effects).

Financial transitions (`approve`, `paid`, `fail`) use `writeTicketingAuditInTx` (throw-on-
failure) so a crashed audit is a rolled-back payout; non-financial ones use the fire-and-forget
writer, matching the refunds precedent.

## 13. Ledger linkage at PAID (one tx)

Covered in §5. Additionally: the link happens inside the SAME `withContentionRetry` transaction
as the status flips and the PAYOUT appends, so the ledger can never observe a partially-paid
settlement — the double-payment walls (`SettlementItem.picFeeLedgerId` unique,
`pICFeeLedger.idempotencyKey` unique) and the period-replay guard keep every claim exclusive.

## 14. Paid-time re-validation (new-reversal guard)

The audit's D-18 ("refunds land after a hypothetical payout") is handled at the moment that
matters: `paid` re-evaluates the settlement's own included order items and **refuses** with
`NEW_REVERSAL_DETECTED` when an unlinked `REVERSAL` (DEBIT) row appeared against an included
order item since prepare. The guard excludes the settlement's *own* included REVERSAL rows from
the freshness query so that legitimate partial-claw-back settlements (which carry DEBIT items)
are not falsely refused.

## 15. Duplicate-period wall and replay semantics

- DB unique indexes are the wall: identical (payeeType, organizerId, picProfileId, periodStart,
  periodEnd) can exist only once.
- `prepare` replays the existing row for open statuses (`DRAFT`/`PENDING_APPROVAL`/`APPROVED`),
  returns `CONFLICT` for a re-opened `CANCELLED`/`FAILED` window (the operator must shift or
  widen the window), and never double-settles.
- Concurrent prepares collide on the unique index; the loser re-reads and returns the winner's
  row (`withContentionRetry` precedent).

## 16. API surface

All under `app/api/organizer/settlements`:

| Route | Action |
| --- | --- |
| `GET  /` | list, scoped by `resolveOrganizerFilter`; forged organizer refused |
| `POST /` | prepare (bank check, accounting, DRAFT) |
| `GET  /[settlementId]` | detail (summary, bank, evidence, items) |
| `POST /[settlementId]/submit` | DRAFT → PENDING_APPROVAL |
| `POST /[settlementId]/approve` | PENDING_APPROVAL → APPROVED (SoD half-gate) |
| `POST /[settlementId]/proof` | multipart `file` upload/re-upload while APPROVED |
| `POST /[settlementId]/paid` | ledger flip (refuses missing proof, short reference, stale reversal) |
| `POST /[settlementId]/fail` | APPROVED → FAILED (reason required) + release items |
| `POST /[settlementId]/cancel` | DRAFT/PENDING_APPROVAL → CANCELLED + release items |
| `GET  /[settlementId]/proof/[fileName]` | protected proof bytes |

## 17. Operator dashboard

- `app/dashboard/settlements/page.tsx` — list (status tones, period, net, masked bank) with the
  `SettlementPrepareForm` (organizer/PIC/period/notes, reads `payload?.data?.id`).
- `app/dashboard/settlements/[id]/page.tsx` — detail with summary, bank snapshot, evidence, and
  items table, plus per-status `SettlementActions` (submit / approve / fail / paid / cancel,
  proof file input with prompts and client-side size check).
- Nav row "Pencairan PIC" (Banknote icon, "Penjualan" section) gated on `canManageSettlements`.

## 18. PIC self-service (read-only history)

`listMySettlements(userId)` in `lib/pic/self-service.ts`:

- requires `requireMyPic` + `PIC_FEE_READ_OWN`;
- returns the PIC's own settlements with ISO dates, masked bank, net amounts (`Decimal`);
- `app/dashboard/pic/page.tsx` renders a "Pencairan" card with `SETTLEMENT_STATUS_TONE`, and the
  balance note now states that payouts are managed by the organizer and appear as a PAYOUT
  debit once settled.

PICs cannot request, cancel, or modify anything — consistent with the read-only design.

## 19. Route inventory and nav registration

- `lib/ui/route-inventory.ts` + `__tests__/ui-consolidation/route-inventory.test.ts` now account
  for `/dashboard/settlements` and `/dashboard/settlements/[id]` (33 pages, 20 dashboard).
- `__tests__/authz/role-matrix.integration.test.ts` includes `/dashboard/settlements` in the
  tenant menu a membership-holding ADMIN is offered, and in `ALL_TENANT_MENU` (the isolation
  rule — a no-membership admin must not see it; `canManageSettlements` is tenant-scoped).
- `__tests__/pic-self-service/menu.test.ts` capabilities literal carries
  `canManageSettlements: false`.

## 20. Testing

`__tests__/ticketing-pic/settlement.integration.test.ts` (16 tests, real DB, `@/auth` mocked):

- prepare accounting: no-bank refusal, gross/deduction/net + masked bank + window replay,
  partial claw-back (CREDIT + DEBIT items), full claw-back exclusion, empty-window refusal,
  closed-window (cancelled) re-prepare conflict.
- lifecycle: submit → approve → proof → paid flips ledger (`EARNED→SETTLED`, `settlementId`
  set, linked REVERSAL, one PAYOUT DEBIT per EARNED summing to net, idempotency keys);
  idempotent re-runs; paid-without-proof refusal; paid refusing a fresh post-prepare reversal;
  fail (releases items) and cancel.
- guards: SoD (preparer cannot approve/pay), tenant 404s for prepare and forged list,
  proof hardening (bad magic, oversize, traversal miss, idempotent delete), proof replacement
  lifecycle, detail read for owner and manager scopes.

## 21. Verification evidence

```
$ npx prisma validate                     → "The schema at prisma/schema.prisma is valid"
$ npx tsc --noEmit                        → exit 0
$ npm run lint                            → 0 errors, 3 warnings (pre-existing <img> LCP advisories)
$ npm test                                → 103 suites, 2089 tests PASSED
$ npm run build                           → Compiled successfully (routes incl.
                                            /dashboard/settlements, /dashboard/settlements/[id])
```

Targeted: `npx jest __tests__/ticketing-pic/settlement.integration.test.ts` → 16/16 PASSED.

## 22. Files changed / added

**New**
- `lib/ticketing/settlement/`: `validation.ts`, `payload.ts` (masked bank, `proofFileName`),
  `proof.ts`, `settlement.ts` (core), `service.ts` (actor-facing).
- `app/api/organizer/settlements/`: `route.ts`,
  `[settlementId]/{route,submit,approve,proof,paid,fail,cancel}/route.ts`,
  `[settlementId]/proof/[fileName]/route.ts`.
- `app/dashboard/settlements/`: `page.tsx`, `[id]/page.tsx`;
  `components/dashboard/SettlementActions.tsx`, `components/dashboard/SettlementPrepareForm.tsx`.
- `__tests__/ticketing-pic/settlement.integration.test.ts`.

**Changed**
- `lib/dashboard/scope.ts` (`canManageSettlements`, computed from `SETTLEMENT_PREPARE`),
  `components/dashboard/DashboardAppShell.tsx` (nav row),
  `lib/pic/self-service.ts` (+`listMySettlements`), `app/dashboard/pic/page.tsx` (Pencairan card),
  `lib/ticketing/audit-log.ts` (settlement actions/entityTypes),
  `lib/ui/route-inventory.ts` (+2 routes),
  `__tests__/ui-consolidation/route-inventory.test.ts`, `__tests__/authz/role-matrix.integration.test.ts`,
  `__tests__/pic-self-service/menu.test.ts`.

## 23. Contract confirmations (explicit "NOT done" list)

- **No iPaymu payout / disbursement integration.** `method` is always `MANUAL_TRANSFER`; money
  moves as an operator bank transfer evidenced by proof upload + manual `providerReference`.
- **No `GATEWAY_SPLIT` ever written** by any code path (value remains storage-only per D-04).
- **No PIC self-withdrawal / payout request surface.** PIC self-service stays read-only; no new
  `SETTLEMENT_*` grant to the PIC role.
- **No auto-disbursement / scheduler / job** exists.
- **No permission-map change**, no grant of org-scope financial power to platform ADMIN by logic
  (capability is per-membership).
- **No commit, no push** — working tree only.

## 24. Documented deviations from the audit contract

1. **`idempotencyKey = fee:payout:{settlementId}:{earnedId}`.** The design's scheme
   (`settle:{settlementNumber}` / `FEE_MARK_PAID`) assumed a global key; `PICFeeLedger.eventId`
   and `orderId` are NOT NULL, so the PAYOUT rows must carry real order/event FKs and a real
   idempotency key per row. `fee:payout:{settlementId}:{earnedId}` is unique per row by
   construction and still a double-append wall.
2. **Paid-time reversal re-check.** The freshness query excludes the settlement's own included
   REVERSAL ids (see §14). Without that, every partial-claw-back settlement would be
   permanently unpayable.
3. **Both payee fields populated.** A PIC settlement sets `picProfileId` AND `organizerId`,
   diverging from the schema comment "exactly one", on purpose: the tenant-scoped indexes and
   `resolveOrganizerFilter` scope reads correctly. The schema constraint itself (additive
   columns, no CHECK) permits it.
4. **Zero-scope via `requireOrganizerAccess`.** Audit suggested `app/api/admin/settlements`;
   delivered under `app/api/organizer/settlements` so tenancy is enforced by the same
   organizer-scope machinery as refunds — no admin broker in the hot path.

## 25. Known gaps / roadmap

- **Receipt verification is a process control.** An operator uploads a proof and marks paid —
  no external clearing check exists. This is inherent to Option C (audit §22.6) and unchanged
  for manual transfer.
- **Exports (R-10 Fee + Settlement)** are not built; the dashboard and APIs expose the data.
- **Bank data remains create-only and unverifiable** (KYC/confirmation out of scope).
- **Reconciliation/file download batching** and `providerStatus` population are unused (manual
  flow has no gateway statuses to mirror).

## 26. Final verdict

| # | Question | Answer |
| --- | --- | --- |
| Q1 | Can an operator prepare/approve/pay a PIC payout? | **YES** — full DRAFT → PENDING_APPROVAL → APPROVED → PAID lifecycle. |
| Q2 | Is the ledger correctly settled at PAID? | **YES** — EARNED→SETTLED, REVERSAL linkage, one PAYOUT DEBIT per EARNED, atomic. |
| Q3 | Is segregation of duties enforced? | **YES** — service-layer half-gate, tested. |
| Q4 | Is tenancy isolation enforced end to end? | **YES** — row-scoped permission resolution, forged tenant refused. |
| Q5 | Is every transition audited? | **YES** — `settlement.*` actions, in-tx for financial steps. |
| Q6 | Is proof-of-payment hardened? | **YES** — owned tree, magic-byte + size validation, protected serving, idempotent delete. |
| Q7 | Is the duplicate-period wall real? | **YES** — DB unique indexes + replay/conflict semantics. |
| Q8 | Is the out-of-scope list honored? | **YES** — no iPaymu payout, no GATEWAY_SPLIT, no PIC withdrawal, no auto path, no commit/push. |

**Bottom line:** the previously schema-only paying half of PIC money is now implemented,
operator-driven, duty-separated, tenant-isolated, audited, proofed, and green across 2089
tests and a production build. The earning → paying lifecycle is closed under Option C.

`PIC PAYOUT / SETTLEMENT V1 [COMPLETE]`