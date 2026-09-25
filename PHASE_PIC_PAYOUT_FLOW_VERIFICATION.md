# PHASE — PIC PAYOUT REQUEST FLOW VERIFICATION

**Type:** AUDIT / VERIFICATION ONLY — read-only. No source, schema, migration, dependency or data was modified.
**Repository:** `~/tinggalklik` · branch `main` · HEAD `29333ff` ("fix pesantiket")
**Verification date:** 2026-09-25.
**Method:** every claim below was read from the shipped source; the four relevant integration suites were executed against the test database (all green). Nothing was inferred from UI visibility alone.

**Verdict:** **FLOW VERIFIED — NO IMPLEMENTATION REQUIRED.**
The five stated requirements are all met by the shipped code. A set of pre-existing, **non-blocking** findings is recorded in §10; none of them is a defect in the verified flow.

---

## Requirements scorecard

| Requirement | Verdict | Evidence |
|---|---|---|
| No minimum payout amount | ✅ **MET** | No min constant/config anywhere; the only floor is `net > 0` → `NOTHING_SETTLEABLE` (`lib/ticketing/settlement/settlement.ts#createPreparedSettlement`) |
| Amount server-derived from settleable balance | ✅ **MET** | `selectSettlementItems` / `previewSettleable`; no endpoint accepts an amount (`lib/ticketing/settlement/validation.ts`) |
| PIC cannot approve own request | ✅ **MET** | PIC holds no `settlement.*`; plus SoD `preparedByUserId ≠ actor` (`service.ts#approveSettlement`) |
| PIC cannot mark paid | ✅ **MET** | Same (holds no `settlement.approve`; SoD) |
| `Settlement` / `PICFeeLedger` is the single source of truth | ✅ **MET** | PIC path calls the *same* `createPreparedSettlement` / `markSettlementPaid`; no second money code |

---

## 1. Current verified flow

```
PIC (session, ACTIVE PICProfile, pic_payout.request.own — OWN scope)
  │  "Ajukan Pencairan"  →  POST /api/pic/payouts  { organizerId, notes? }
  ▼
lib/pic/payout.ts#createMyPicPayoutRequest
  │   • requireMyPic → identity from SESSION (no picProfileId accepted)
  │   • window = earliest eligible EARNED row for that tenant → now
  ▼
lib/ticketing/settlement/settlement.ts#createPreparedSettlement(origin: "PIC_REQUEST")
  │   • selectSettlementItems → claims EARNED − REVERSAL lines
  │   • bank snapshot copied from PICProfile
  │   • Settlement + SettlementItem rows; audit "settlement.request"
  ▼
Settlement { status: REQUESTED, preparedByUserId: <PIC user>, organizerId, picProfileId }
  │
  ├── Manager/Admin (settlement.approve, SoD) ── Setujui ──► APPROVED
  │                                                          │  proof upload (settlement.proof.upload)
  │                                                          │  Tandai dibayar (settlement.approve + SoD + proof + reference)
  │                                                          ▼
  │                                                        PAID   ★ only here does PICFeeLedger change
  └── Manager/Admin (settlement.approve, SoD) ── Tolak (reason REQUIRED) ──► REJECTED + rejectionReason
                                                                             (claim lines RELEASED)
```

**Verified end-to-end:**
`REQUESTED` is written by the PIC path; a `REQUESTED` row is visible to operators; `approve` accepts `REQUESTED` as well as `PENDING_APPROVAL`; `reject` accepts only `REQUESTED`; `paid` requires `APPROVED` + recorded proof + a transfer reference; no ledger row changes until `paid`.

---

## 2. PIC experience

### 2.1 UI — exact location and fields

| Item | Finding |
|---|---|
| Card | `app/dashboard/pic/page.tsx:693-700` — `SectionCard title="Pencairan"` |
| Action | `actions={<PicPayoutRequestDialog organizers={settleable} />}` |
| Dialog | `components/dashboard/PicPayoutRequestDialog.tsx` |
| Trigger label | **"Ajukan Pencairan"** (button disabled when `organizers.length === 0`) |
| Field 1 | **Penyelenggara** — `Select`, options = only tenants with **positive** settleable net (`listMyPicSettleableOrganizers`); label shows `Name · Rp…` |
| Field 2 | **Jumlah diajukan** — `Input readOnly disabled`, value = `formatIdr(selected.settleableNet)`, hint "Dihitung server dari fee yang dapat dicairkan." |
| Field 3 | **Catatan (opsional)** — `Textarea`, `maxLength={2000}` |
| Submit body | `{ organizerId, ...(notes.trim() ? { notes: notes.trim() } : {}) }` — **no amount, no status, no bank, no picProfileId** |
| Result | dialog closes, `router.refresh()`; errors rendered from `payload.message` |

### 2.2 Verified claims

| Claim | Verdict | Evidence |
|---|---|---|
| Amount shown to PIC is server-derived | ✅ | `PicPayoutRequestDialog` renders `selected.settleableNet` from `listMyPicSettleableOrganizers`; never an input |
| No arbitrary client amount accepted | ✅ | Dialog sends no amount; `picPayoutRequestSchema` is `.strict()` with only `organizerId` + `notes`; `createMyPicPayoutRequest` accepts only `{ organizerId, notes? }` |
| Only eligible tenant selectable | ✅ | Options come from `settleableOrganizerIds()` → tenants where the PIC has unsettled `EARNED` rows; each offered only when `net > 0` |
| Request status visible | ✅ | PIC history table (Pencairan / Penyelenggara / **Status** / Tujuan / Jumlah / Dibayar), `app/dashboard/pic/page.tsx:737-800` |
| Rejection reason visible | ✅ | Dedicated **"Alasan penolakan"** block listing up to 5 rejected requests, `app/dashboard/pic/page.tsx:806-832` |
| Balance visible | ✅ | **"Saldo yang dapat dicairkan"** per tenant, `app/dashboard/pic/page.tsx:699-731` |

### 2.3 API trace

`app/api/pic/payouts/route.ts`
- `POST`: `requireSameOrigin` → `requireAuth` → body must be an object → `parseOrThrow(picPayoutRequestSchema, body)` → `createMyPicPayoutRequest(scope.userId, input)` → `created(payload)`.
- `GET`: `requireAuth` → `listMyPicPayoutRequests` + `listMyPicSettleableOrganizers` → `ok({ requests, organizers })`.
- **Authorization:** route does not decide authority; `createMyPicPayoutRequest` calls `requireMyPic(userId, [PIC_PAYOUT_REQUEST_OWN])`, which enforces session identity, an ACTIVE `PICProfile` on a non-disabled `User`, and `decideOwnResourcePermission` (OWN scope).
- **Amount calculation:** server-side only, via `settleableWindowStart` → `createPreparedSettlement` → `selectSettlementItems`.
- **Settlement creation:** `tx.settlement.create({ status: "REQUESTED", payeeType: "PIC", picProfileId, organizerId, bankName/AccountName/AccountNumber: <snapshot>, preparedByUserId: <PIC user> })` + `settlementItem.createMany`.
- **Initial status:** `REQUESTED` ✅ (asserted by test).
- **No ledger money movement at request time:** ✅ — the request writes `Settlement` + `SettlementItem` + audit only. Asserted: `pICFeeLedger.status === "EARNED"` and `settlementId === null` after a request (`payout-request.integration.test.ts`, "creating a request derives the amount server-side and lands it as REQUESTED").

---

## 3. Manager experience

| Check | Verdict | Evidence |
|---|---|---|
| Manager can see REQUESTED payouts | ✅ | `listSettlements(scope, query)` scopes to organizers where the actor holds `settlement.prepare` and accepts `status=REQUESTED`; the dashboard filter uses `SETTLEMENT_STATUSES` (includes `REQUESTED`) — `app/dashboard/settlements/page.tsx` |
| Manager can approve | ✅ | `MANAGER` holds `settlement.approve` **by role** (`PLATFORM_ROLE_ORGANIZER_PERMISSIONS.MANAGER`), and `approveSettlementCore` accepts `REQUESTED`; integration test approves a PIC request as a MANAGER |
| Manager can reject | ✅ | `POST …/[settlementId]/reject` → `rejectSettlement` (`settlement.approve` + SoD) |
| Reject reason REQUIRED | ✅ | `rejectSettlementSchema.reason` = `z.string().trim().min(3).max(500)` and the schema is `.strict()`; `rejectSettlement` persists it on `rejectionReason` |
| Tenant isolation | ✅ | `requireSettlementPermission(row.organizerId, …)` — organizer taken from the **row**, not the request; no membership ⇒ `ORGANIZER_ACCESS_DENIED` (404). Covered by `settlement.integration.test.ts` "tenancy: another tenant's OWNER is refused everywhere" |
| Separation of duties | ✅ | `preparedByUserId === actor.userId` ⇒ `FORBIDDEN / SEPARATION_OF_DUTIES` on approve/reject/pay |

**UI:** detail page renders **Setujui** and **Tolak** for a `REQUESTED` row (`components/dashboard/SettlementActions.tsx`); *Tolak* opens the required-reason dialog (`DEFAULT_DIALOG` kind `rejectPayout`).

---

## 4. Admin experience

**Can an Admin approve/reject a PIC payout by role? — NO, by design (D-19).** Admin holds no `settlement.*` permission in any map.

**Exact prerequisites for an Admin to approve / reject / pay a PIC request (both must hold):**

1. **An ACTIVE `OrganizerMember` row** for the settlement's `organizerId`.
   - `decideOrganizerPermission` checks membership **before** grants, and `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty — so a platform ADMIN reaches no tenant without a membership; without one the answer is `ORGANIZER_ACCESS_DENIED` → **404**.
   - The membership **role is irrelevant** for this path (any role satisfies the scope gate); it is the grant that decides.
2. **An explicit, non-revoked `PermissionGrant`** with `permission = "settlement.approve"`.
   - `ADMIN_GRANT_REQUIRED` contains `SETTLEMENT_APPROVE`, and for an ADMIN the decider returns `granted ? ALLOW : deny` — a grant is the **only** way.
   - `PermissionGrant.organizerId` must be either **that organizer** or **NULL** (platform-wide); `revokedAt` must be NULL. Unique key: `@@unique([userId, organizerId, permission])`.
   - Example row: `{ userId: <admin>, organizerId: <settlement.organizerId>, permission: "settlement.approve", grantedByUserId: <admin/owner>, revokedAt: null }`.
   - Revocation takes effect within the D-48 scope TTL (≤ 60 s) for an already-open session.

**Admin can additionally:** approve, reject, and mark paid (all use `settlement.approve`), subject to SoD.
**Admin can NOT:** prepare a settlement (`settlement.prepare` is not in `ADMIN_GRANT_REQUIRED`, so even a grant cannot unlock it), and **can NOT upload proof** (`settlement.proof.upload` is likewise not grant-unlockable).

> **Operational consequence (documented, not a defect):** an **Admin-only** workflow can never reach `PAID`, because `markSettlementPaid` requires `proofFilePath` to be set and only a MANAGER / membership OWNER|MANAGER|FINANCE can upload the proof. In practice the Admin reviews, and a Manager/Finance member uploads the evidence. Authorization was **not** changed.

---

## 5. Accounting behavior

| Question | Verified answer | Evidence |
|---|---|---|
| When does `PICFeeLedger` change in the payout flow? | **Only at `PAID`.** | `markSettlementPaid` — the only function that writes `pICFeeLedger` in this domain |
| Is a payout DEBIT created only at `PAID`? | **Yes** | `tx.pICFeeLedger.create({ type: "PAYOUT", direction: "DEBIT", status: "SETTLED", idempotencyKey: \`fee:payout:${settlementId}:${ledgerRow.id}\` })` inside the `paid` transaction only |
| What exactly happens at `PAID` (one transaction) | 1) included `EARNED` rows: `EARNED → SETTLED` + `settlementId` set (CAS: `status=EARNED, settlementId=null`); 2) included `REVERSAL` rows linked; 3) append one `PAYOUT` DEBIT per included `EARNED` item; Σ PAYOUT == `netAmount` | `markSettlementPaid` |
| Does any money move at REQUEST time? | **No** — only `Settlement(REQUESTED)` + `SettlementItem` claim rows + audit | asserted by test (§2.3) |
| Does any money move at APPROVE / REJECT time? | **No.** Reject **releases** the claim lines (`releaseSettlementItems`); nothing was ever flipped | `rejectSettlement` / `approveSettlement` |
| Is the money engine single-sourced? | **Yes** — PIC request, operator prepare, preview and paid all use `selectSettlementItems` / `markSettlementPaid`. No duplicated accounting in `lib/pic/payout.ts`. | §7 of the prior audit |
| Are amounts exact decimals? | **Yes** — `Decimal(14,2)`, rendered as fixed 2-decimal strings (`moneyString`); no float round trips | `payload.ts` |

**EARNED** entries are posted by the **order payment** settlement (not the payout engine): `lib/ticketing/payment/settlement.ts:472 → postEarnedPicFees`, key `fee:earned:{orderItemId}`. **REVERSAL** entries by refund settlement, key `fee:reversal:{refundId}:{orderItemId}`.

---

## 6. Authorization / SoD

### Authorization matrix (backend-traced)

| Action | Permission | Scope | MANAGER (platform) | ADMIN | PIC | OWNER / FINANCE (membership) |
|---|---|---|---|---|---|---|
| Request payout | `pic_payout.request.own` | OWN | ✗ | ✗ | ✅ (own) | ✗ (unless also a PIC) |
| Prepare | `settlement.prepare` | ORGANIZER | ✅ | **✗ (not grantable)** | ✗ | ✅ |
| Submit | `settlement.prepare` | ORGANIZER | ✅ | ✗ | ✗ | ✅ |
| Approve | `settlement.approve` | ORGANIZER | ✅ | ✅ **only with grant** | ✗ | ✅ |
| Reject | `settlement.approve` | ORGANIZER | ✅ | ✅ **only with grant** | ✗ | ✅ |
| Upload proof | `settlement.proof.upload` | ORGANIZER | ✅ | **✗ (not grantable)** | ✗ | ✅ |
| Mark paid | `settlement.approve` + SoD + proof + reference | ORGANIZER | ✅ | ✅ **only with grant** | ✗ | ✅ |
| Cancel | `settlement.prepare` | ORGANIZER | ✅ | ✗ | ✗ | ✅ |
| Fail | `settlement.approve` | ORGANIZER | ✅ | grant | ✗ | ✅ |

`MEMBERSHIP_ROLE_PERMISSIONS.OWNER/MANAGER/FINANCE` all carry the settlement set; `ADMIN` (membership role) is deliberately unmapped (D-05).

### Segregation of duties — enforced (exact)

| Rule | Enforced | Source |
|---|---|---|
| preparer ≠ approver | ✅ | `service.ts#approveSettlement` → `FORBIDDEN / SEPARATION_OF_DUTIES` |
| preparer ≠ rejecter | ✅ | `service.ts#rejectSettlement` |
| preparer ≠ payer | ✅ | `service.ts#paySettlement` |
| approver ≠ payer | ❌ **not enforced** | no comparison exists |
| PIC cannot approve/reject/pay | ✅ | structural: no `settlement.*` capability + SoD |

For the PIC flow specifically, SoD is satisfied **automatically**: the PIC is the author (`preparedByUserId`) and holds no settlement capability, so any reviewing operator passes.

### Isolation

- PIC path: identity from session only; no function accepts a `picProfileId`; forged `userId` ⇒ `PIC_ACCESS_DENIED`.
- Operator path: tenant from the Settlement **row**; cross-tenant ⇒ 404.
- Proxy: `/api/pic/`, `/api/organizer/`, `/api/admin/` in `PROTECTED_API_PREFIXES` (defence in depth).

---

## 7. Edge cases

| Edge case | Behaviour | Verified by |
|---|---|---|
| **Zero balance** | `listMyPicSettleableOrganizers` → `[]`; the "Ajukan Pencairan" button is **disabled**; a direct API call → `CONFLICT / NOTHING_SETTLEABLE` | code + tests |
| **Insufficient settleable balance** | A request always claims the whole per-tenant settleable amount; there is no partial, so any shortfall reduces to "≤ 0 → nothing to claim" → `NOTHING_SETTLEABLE` | `createPreparedSettlement` |
| **Concurrent payout request** | At least one succeeds; `SettlementItem.picFeeLedgerId @unique` makes a double-claim impossible (`P2002` → `ALREADY_CLAIMED` message on the retry) | test "two concurrent requests never consume the same fee twice" |
| **Duplicate request** | A second request finds nothing left to claim → `CONFLICT`. (Not idempotent-by-key: it is **refused**, not replayed.) | test "a second request finds nothing left to claim" |
| **Late reversal (after prepare, before PAID)** | `markSettlementPaid` detects an unconsumed REVERSAL on a claimed order item → `CONFLICT / NEW_REVERSAL_DETECTED`; operator must fail and re-prepare | `settlement.integration.test.ts` "paid refuses when a fresh reversal lands after prepare" |
| **Late reversal (already paid)** | Netted off the **next** settlement as a carried claw-back | `settlement-carried-reversal.integration.test.ts` |
| **Cross-tenant access** | PIC requesting a tenant they did not earn in → `CONFLICT` (no leak); operator without membership → 404 | test "requesting against a tenant the PIC did not earn in finds nothing"; "tenancy: another tenant's OWNER is refused everywhere" |
| **PIC attempts approve** | Refused | test "the author (PIC) can never approve, reject or pay their own request" |
| **PIC attempts paid** | Refused | same test |
| **Reject → request again** | Claim lines are released and the settleable balance is restored, so the PIC can request afresh (the new request uses a later `periodEnd`, so it is a new row, not a collision with the rejected window) | test "an operator rejects with a reason; the PIC sees it and the claim is released" (asserts release + restored balance). **See §9 gap: the actual re-request call is not asserted.** |
| **PIC without complete bank details** | Request refused (`VALIDATION_ERROR`) — a payee who cannot be paid is not offered | test "a PIC without complete bank details cannot request" |
| **CUSTOMER role with ACTIVE PIC profile** | `FORBIDDEN` on `pic_payout.request.own` | test "a CUSTOMER role with an ACTIVE profile is FORBIDDEN" |

---

## 8. UI/UX findings

1. **PIC history does not distinguish origin.** `listMyPicPayoutRequests` filters only `payeeType: "PIC"` + `picProfileId`, so the PIC's history contains **both** their own `REQUESTED` requests **and** operator-prepared settlements (`DRAFT`/`PENDING_APPROVAL`/`APPROVED`/`PAID`). No field in the payload names the author, so the only cue is the status (`REQUESTED` ⇒ PIC-initiated). A PIC may therefore see a `DRAFT` payout they never asked for and have no way to tell why it exists.
2. **No human-readable status labels for settlement states.** The PIC and operator tables render the raw enum (`REQUESTED`, `PENDING_APPROVAL`, `DRAFT`, …) via `StatusBadge`. The PIC dashboard's fee-ledger table *does* translate entry types (e.g. `PAYOUT → "Pencairan"`), so this is an inconsistency in polish.
3. **"Jumlah diajukan" is a disabled input.** It is honest (server-derived) but renders as a greyed form field, which can read as "broken" rather than "read-only".
4. **Rejection reasons are shown in a separate block, up to 5.** The reason is not attached to its row in the history table; with more than 5 rejected requests the older reasons are silently truncated.
5. **No in-context explanation of the operator step for the PIC.** The card copy ("penyelenggara meninjau … melakukan transfer bank manual") explains the process, but the history has no per-row hint for `REJECTED` other than the separate block; there is no "what do I do now" affordance (e.g. re-request after fixing the bank).
6. **Operator surfaces are consistent** — `REQUESTED` gets `Setujui`/`Tolak`, and the detail page labels the rejection reason "Alasan penolakan (terlihat oleh PIC)". No confusion found there.
7. **Copy mismatch (minor):** the PIC dialog title is "Ajukan pencairan fee" while the trigger is "Ajukan Pencairan"; harmless.

None of these is a functional defect in the verified flow.

---

## 9. Test coverage

**Relevant existing suites (executed, read-only against the test DB):**

| Suite | Focus | Result |
|---|---|---|
| `__tests__/pic-self-service/payout-request.integration.test.ts` | 13 tests: derived amount, REQUESTED creation + no ledger movement, duplicate/concurrent, reversal, forged userId, isolation, CUSTOMER role, missing bank, foreign tenant, SoD, approve + paid gate, reject + reason | **PASS** |
| `__tests__/ticketing-pic/settlement.integration.test.ts` | 16 tests: gross/deduction/net + masking + replay, partial/full claw-back, nothing-settleable, closed window, full lifecycle + one PAYOUT per EARNED, idempotent re-runs, proof required, late reversal, fail/cancel release, SoD, tenancy, proof hardening/replacement | **PASS** |
| `__tests__/ticketing-pic/settlement-carried-reversal.integration.test.ts` | carried post-paid claw-back | **PASS** |
| `__tests__/pic-self-service/ownership.integration.test.ts` | own-scope identity enforcement | **PASS** |

**Executed:** `npx jest <4 suites> --runInBand` → **4 suites, 51 tests, all passed** (exit 0). No test was modified.

**Coverage gaps (not defects):**
1. **Reject → re-request is only half-covered.** The suite asserts the claim is released and the balance is restored, but never calls `createMyPicPayoutRequest` a second time to prove a fresh request succeeds.
2. **SoD assertions are weak** in the PIC suite: `rejects.toBeDefined()` without pinning `SEPARATION_OF_DUTIES` (the operator suite does assert SoD).
3. **No HTTP/route-level test** for `POST /api/pic/payouts` — same-origin check, body validation and the `created()` envelope are untested (tests call the service directly). A static guard in `reporting.integration.test.ts:441` only asserts that this is the sole `/api/pic` route.
4. **No test of the ADMIN grant path** for `settlement.approve` (or the 404-without-membership path).
5. **No test of a late REVERSAL arriving between `REQUESTED` and `PAID` on the PIC path** (the generic prepare→paid case is covered).
6. **No component/UI tests** for `PicPayoutRequestDialog` or the PIC history rendering.

---

## 10. Bugs / inconsistencies

**Verified flow — no bugs found.** The following are pre-existing inconsistencies outside the verified flow; none blocks it. **Nothing was changed.**

| # | Finding | Severity | Type |
|---|---|---|---|
| B1 | `app/api/organizer/settlements/[settlementId]/approve/route.ts` claims *"a MANAGER may prepare but not approve"* — **false**; `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.MANAGER` contains `settlement.approve` and a MANAGER does approve a PIC request (test-proven) | Low | Documentation drift |
| B2 | `…/[settlementId]/paid/route.ts` claims it requires `settlement.approve` **AND** `settlement.proof.upload`; `paySettlement` checks only `SETTLEMENT_APPROVE` (proof presence is enforced via `proofFilePath`, not via the upload permission) | Low | Documentation drift |
| B3 | The service header claims `author ≠ approver ≠ payer`; only `preparer ≠ approver` / `preparer ≠ payer` are enforced. **Approver may also be payer.** | Medium | Control gap (deliberate?) |
| B4 | **PIC bank details have no edit path anywhere** (written only at PIC-profile creation by an ADMIN). A wrong account number cannot be corrected via API or UI. | Medium | Operational gap |
| B5 | ADMIN cannot prepare a payout (not grantable) and cannot upload proof (not grantable), so an Admin-only workflow cannot reach `PAID`. | Low | Design (D-19) consequence — needs an explicit decision |
| B6 | PIC payout history mixes PIC-originated requests with operator-created settlements, with no origin indicator. | Low | UI/UX |
| B7 | Rejection reasons are rendered outside the row and capped at 5. | Low | UI/UX |
| B8 | Duplicate request is **refused** (`CONFLICT`), not replayed — no client idempotency key on this path. | Low | Behaviour note |

---

## 11. Recommended next action

1. **Accept the flow as verified** — no implementation is required to satisfy the stated requirements.
2. **Owner decision** on the three items that are genuine choices rather than defects:
   - **B3** — enforce `approver ≠ payer`, or accept preparer-only SoD;
   - **B5** — whether an ADMIN should hold `settlement.prepare` / `settlement.proof.upload` (a D-19 change), or stay grant-gated;
   - **B4** — add a PIC (or admin) bank-detail maintenance path.
3. **Cheap, no-risk follow-ups** if the owner wants them: correct the two stale route comments (B1, B2); add a regression test for reject → re-request and pin the SoD error code (gap 1–2); add an HTTP-level test for `POST /api/pic/payouts` (gap 3).

Do **not** touch the accounting engine, the claim uniqueness boundary, the amount derivation or the state machine — all four are single-sourced and verified.

---

## Appendix — Verification guarantees

- **Read-only.** Only file reads, `grep`/`ls`/`sed`, and `git status`/`git log` were executed, plus the four existing Jest suites against the **test** database (`tinggalklik_test`, which self-cleans in `afterAll`). No production data and no application data was modified; no `prisma` command, no migration, no dependency install.
- **Source files changed: ZERO.**
- **Schema changed: ZERO.**
- **Migrations created: ZERO.**
- **Dependencies changed: ZERO.**
- **Database data changed: ZERO** (test suites clean up after themselves; production untouched).
- **Commits: ZERO. Pushes: ZERO.**
- **Report created:** `PHASE_PIC_PAYOUT_FLOW_VERIFICATION.md` (this file — a document).
