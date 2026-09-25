# PHASE — PIC PAYOUT SELF-SERVICE ARCHITECTURE AUDIT

**Type:** AUDIT ONLY — read-only. No source, schema, migration, dependency or data was modified.
**Repository:** `~/tinggalklik` · branch `main` · HEAD `29333ff` ("fix pesantiket")
**Scope decision:** whether to let a PIC request their own payout, with Admin/Manager approving or rejecting.
**Audit date:** 2026-09-25.

---

## ⚠️ HEADLINE: THE FEATURE THE TASK ASKS US TO "CONSIDER" ALREADY EXISTS

The task brief states:

> *"Payout / pencairan is currently initiated by ADMIN or MANAGER. PIC currently does NOT initiate payout requests themselves. We are considering changing the flow so PIC can submit a payout request."*

**That is not the state of the code at HEAD.** Phase 21 already shipped a **PIC-initiated payout request** flow, end to end: schema states, a service, an own-scope permission, an API route, a dashboard control and an integration test suite.

Evidence (all present, committed, and in the working tree):

| Layer | Artifact |
|---|---|
| Enum states | `SettlementStatus.REQUESTED`, `SettlementStatus.REJECTED` (`prisma/schema.prisma:607-622`) |
| Columns | `Settlement.rejectedByUserId`, `.rejectedAt`, `.rejectionReason` (`prisma/schema.prisma:1614-1620`) |
| Migration | `prisma/migrations/20260927000000_add_pic_payout_requests/migration.sql` |
| Permission | `PIC_PAYOUT_REQUEST_OWN = "pic_payout.request.own"` (`lib/authz/permissions.ts`) |
| Service | `lib/pic/payout.ts` — `createMyPicPayoutRequest`, `listMyPicPayoutRequests`, `listMyPicSettleableOrganizers` |
| API | `app/api/pic/payouts/route.ts` (`GET` + `POST`), prefix-protected in `proxy.ts:134` |
| Review API | `app/api/organizer/settlements/[settlementId]/reject/route.ts`; `approve` accepts `REQUESTED` |
| PIC UI | `components/dashboard/PicPayoutRequestDialog.tsx` ("Ajukan Pencairan"), PIC "Pencairan" card |
| Operator UI | `components/dashboard/SettlementActions.tsx` renders **Setujui / Tolak** on a `REQUESTED` row |
| Tests | `__tests__/pic-self-service/payout-request.integration.test.ts` (13 tests) |

Therefore this report describes the **CURRENT IMPLEMENTATION** (which already contains the target flow), and Section 15/16 treat "future change" as **refinement of a shipped feature**, not green-field construction. Every claim below was read from source; nothing is inferred from UI visibility.

---

## 1. Executive Summary

**What exists today.** Payout ("pencairan") is a single domain — `Settlement` — with two entry origins that converge on one money engine:

1. **Operator origin** (original V1): an organizer member with `settlement.prepare` prepares a `DRAFT` for one PIC + one tenant + one period;
2. **PIC origin** (Phase 21, already shipped): the PIC themselves POSTs `/api/pic/payouts`, which calls the *same* money engine with `origin: "PIC_REQUEST"` and lands directly in `REQUESTED`.

From `REQUESTED` (or from `PENDING_APPROVAL`), the lifecycle is identical and operator-controlled: **approve → (upload proof) → mark paid**, or **reject** with a PIC-visible reason.

**Money never moves until `paid`.** `markSettlementPaid` is the only money-moving edge; it is manual (bank transfer) and requires recorded proof plus a provider reference.

**Amounts are never client-supplied.** No endpoint accepts an `amount`, `netAmount`, `status` or `method`. The figure is derived server-side from the append-only `PICFeeLedger` (unsettled EARNED rows minus their offsetting REVERSAL rows, plus any carried post-paid claw-backs) by the same `selectSettlementItems` used to preview the PIC's balance.

**No minimum payout amount exists.** The only floor is "net > 0" (`NOTHING_SETTLEABLE`); there is no constant, config or business rule imposing a minimum.

**Gaps/risks found (all pre-existing, none introduced here):**

1. **`ADMIN` cannot prepare a settlement at all** — `settlement.prepare` is absent from `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.ADMIN` and is **not** in `ADMIN_GRANT_REQUIRED`, so a grant cannot confer it either.
2. **`ADMIN` can approve only with an explicit `PermissionGrant`** (D-19), while `MANAGER`/`OWNER`/`FINANCE` hold it by role. The brief's "Admin **or** Manager approves" is therefore asymmetric for Admin.
3. **No `approver ≠ payer` separation of duties.** The code enforces `preparer ≠ approver` and `preparer ≠ payer`, but the same person who approved a payout may also mark it paid.
4. **PIC bank details have no edit path at all.** They are written only once, at PIC-profile creation by an ADMIN; no API or UI can change them afterwards (not even an admin one).
5. **PIC cannot request a partial or specific amount.** The request is always the full per-tenant settleable balance for a server-derived window (`earliest eligible row → now`), one tenant at a time.
6. **Route documentation drift:** `approve/route.ts` claims "a MANAGER may prepare but not approve", and `paid/route.ts` claims it requires `settlement.proof.upload`; the permission map and service say otherwise (MANAGER **can** approve; `paid` checks only `settlement.approve`).

---

## 2. Current Payout Flow (as implemented)

```
PIC ORIGIN (PHASE 21 — exists today)
────────────────────────────────────
PIC (session, ACTIVE profile, pic_payout.request.own — OWN scope)
    │  POST /api/pic/payouts  { organizerId, notes? }        ← no amount, no bank, no picProfileId
    ▼
lib/pic/payout.ts#createMyPicPayoutRequest
    │  • requireMyPic(...) → session identity, never a body id
    │  • window = earliest eligible EARNED row (tenant) → now
    ▼
lib/ticketing/settlement/settlement.ts#createPreparedSettlement(origin: "PIC_REQUEST")
    │  • selectSettlementItems()  → claims EARNED − REVERSAL lines
    │  • bank snapshot copied from PICProfile
    │  • SettlementItem rows written (picFeeLedgerId UNIQUE)
    ▼
Settlement { status: REQUESTED, preparedByUserId: <PIC user>, organizerId, picProfileId }


OPERATOR PREPARE (original V1 — also available)
───────────────────────────────────────────────
MANAGER / FINANCE / membership OWNER|MANAGER (settlement.prepare — ORGANIZER scope)
    │  POST /api/organizer/settlements { organizerId, picProfileId, periodStart, periodEnd, notes? }
    ▼
createPreparedSettlement(origin: "OPERATOR")  →  Settlement { status: DRAFT }
    │  POST .../[id]/submit   → PENDING_APPROVAL


REVIEW & PAYMENT (both origins converge)
────────────────────────────────────────
REQUESTED ──approve──┐
PENDING_APPROVAL ────┴──► APPROVED ──proof──► (proofFilePath) ──paid──► PAID
        │                     │
        └──reject──► REJECTED │
                              └──fail──► FAILED
DRAFT/PENDING_APPROVAL ──cancel──► CANCELLED

  approve  : settlement.approve  + SoD (actor ≠ preparedByUserId)   [service.ts#approveSettlement]
  reject   : settlement.approve  + SoD (actor ≠ preparedByUserId)   [service.ts#rejectSettlement]  → REQUESTED only
  proof    : settlement.proof.upload                                [service.ts#recordSettlementProof] → APPROVED only
  paid     : settlement.approve  + SoD + proofFilePath REQUIRED + providerReference REQUIRED  [markSettlementPaid]  ★ MOVES MONEY
  fail     : settlement.approve  (no SoD)                           → APPROVED only, releases claims
  cancel   : settlement.prepare  (no SoD)                           → DRAFT|PENDING_APPROVAL, releases claims


LEDGER / ACCOUNTING (inside the `paid` transaction, all-or-nothing)
───────────────────────────────────────────────────────────────────
1. included EARNED rows:  status EARNED → SETTLED,  settlementId ← settlement.id
2. included REVERSAL rows:                          settlementId ← settlement.id
3. append PAYOUT rows:    type=PAYOUT, direction=DEBIT, status=SETTLED,
                          one per included EARNED item,
                          idempotencyKey = `fee:payout:{settlementId}:{earnedId}`
                          Σ PAYOUT == Settlement.netAmount (carried claw-backs spread, earliest-first)
```

**Where each ledger entry is created (authoritative call sites):**

| Entry | Created by | Idempotency key |
|---|---|---|
| `EARNED` (CREDIT) | `lib/pic/attribution.ts#postEarnedPicFees`, called from `lib/ticketing/payment/settlement.ts:472` when an ORDER settles as paid | `fee:earned:{orderItemId}` |
| `REVERSAL` (DEBIT) | `lib/ticketing/refunds/settlement.ts:492` on refund settlement | `fee:reversal:{refundId}:{orderItemId}` |
| `PAYOUT` (DEBIT) | `lib/ticketing/settlement/settlement.ts#markSettlementPaid` | `fee:payout:{settlementId}:{earnedId}` |

> Note the name collision to keep straight: **payment** settlement (`lib/ticketing/payment/settlement.ts`) settles an *order* and posts EARNED fees; **payout** settlement (`lib/ticketing/settlement/`) settles a *PIC's fees*. They are different engines.

---

## 3. Current PIC Capabilities

Backend-traced, not UI-inferred. Every PIC read/write funnels through `lib/pic/self-service.ts#requireMyPic`, which enforces: (1) authenticated session, (2) `scope.userId === userId` (a forged id is `PIC_ACCESS_DENIED`), (3) an **ACTIVE** `PICProfile` on a non-disabled `User` (else `NOT_FOUND`), (4) the requested own-scope permission(s) via `decideOwnResourcePermission`.

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Can a PIC see their payout **balance**? | **YES** — "Saldo yang dapat dicairkan" per tenant (`settleableNet`), plus a whole-ledger net fee figure | `lib/pic/payout.ts#listMyPicSettleableOrganizers`; `lib/pic/ledger.ts#getPicLedgerBalance`; `app/dashboard/pic/page.tsx:700-731` |
| 2 | Can a PIC see payout **history**? | **YES** — all their `Settlement` rows, bank masked, newest first | `lib/pic/payout.ts#listMyPicPayoutRequests`; `app/dashboard/pic/page.tsx:737-800` |
| 3 | Can a PIC **create** a payout? | **YES** — lands as `REQUESTED` | `POST /api/pic/payouts` → `createMyPicPayoutRequest` |
| 4 | Can a PIC **modify** a payout? | **NO** — no mutation exists on the PIC surface besides create | only `GET`/`POST` in `app/api/pic/payouts/route.ts` |
| 5 | Can a PIC **approve** a payout? | **NO** — holds no `settlement.*` permission; SoD also blocks author-as-approver | `lib/authz/permissions.ts` (PIC own map has no `settlement.*`); `service.ts#approveSettlement` |
| 6 | Can a PIC **reject** a payout? | **NO** — same reason | `service.ts#rejectSettlement` |
| 7 | Can a PIC **mark paid**? | **NO** — same reason | `service.ts#paySettlement` |
| 8 | What **permissions** does a PIC hold? | **OWN scope only:** `order.read.own`, `payment.read.own`, `ticket.read.own`, `ticket.issue.own`, `refund.request.own`, `pic_attribution.read.own`, `pic_fee.read.own`, **`pic_payout.request.own`**, `report.export.own_pic_fee`. **No** tenant-scope and **no** platform-scope permission. | `PLATFORM_ROLE_OWN_PERMISSIONS.PIC` / `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC = ∅` / `PLATFORM_ROLE_PLATFORM_PERMISSIONS.PIC = ∅` |
| 9 | Which permission **would** control "request payout" if new? | **Already exists:** `pic_payout.request.own` (OWN scope). No new capability is required. | `lib/authz/permissions.ts` |

**PIC fee history / reporting:** `getMyFeeSummary`, `listMyFeeLedger` (`pic_fee.read.own`), `listMyAttributions` (`pic_attribution.read.own`), `getMyPicOverview`, plus the own-fee CSV export (`report.export.own_pic_fee`) at `/api/reports/my-pic-fee/export` and reconciliation at `/api/reports/pic-fee-reconciliation`.

**PIC bank information:** read-only and masked on the PIC surface (`••••` + last 4 via `maskAccountNumber`). The PIC **cannot** edit it (see §9).

---

## 4. Current ADMIN Capabilities

`ADMIN` is a **platform** role. Inside a tenant it must hold an **ACTIVE `OrganizerMember`** row; without one there is no tenant access at all (`ORGANIZER_SPANNING_PLATFORM_ROLES` is empty).

| Action | ADMIN by role? | ADMIN with `PermissionGrant`? |
|---|---|---|
| **Create/prepare** a settlement | **NO** | **NO** (`settlement.prepare` is not in `ADMIN_GRANT_REQUIRED`, so a grant can never unlock it) |
| **Submit** | NO | NO |
| **Approve** | **NO** by default | **YES** — `settlement.approve` **is** in `ADMIN_GRANT_REQUIRED` (D-19) |
| **Reject** | NO by default | **YES** (uses `settlement.approve`) |
| **Pay** | NO by default | **YES** (uses `settlement.approve`) + SoD vs preparer |
| **Upload proof** | **NO** | **NO** (`settlement.proof.upload` not grant-unlockable) |
| **Cancel / Fail** | NO | Cancel needs `settlement.prepare` → NO; Fail uses `settlement.approve` → YES with grant |
| **Manage PIC profiles** (`pic.manage`) | **YES** (platform scope) | n/a |

Authorizing functions: `decideOrganizerPermission` / `decidePlatformPermission` + `ADMIN_GRANT_REQUIRED` in `lib/authz/permissions.ts`; `requireOrganizerAccess` in `lib/authz/guards.ts`.
**Practical consequence:** today an ADMIN cannot originate a payout, and can only participate in the review/payment steps via an explicit grant.

---

## 5. Current MANAGER Capabilities

`MANAGER` is a platform role that holds **by role** (no grant needed) the full financial set, provided it has an ACTIVE membership in the target organizer.

| Action | MANAGER? | Permission |
|---|---|---|
| **Create/prepare** | **YES** | `settlement.prepare` |
| **Submit** | **YES** | `settlement.prepare` |
| **Approve** | **YES** | `settlement.approve` (+ SoD vs preparer) |
| **Reject** | **YES** | `settlement.approve` (+ SoD vs preparer) |
| **Pay** | **YES** | `settlement.approve` (+ SoD vs preparer, + proof + reference) |
| **Upload proof** | **YES** | `settlement.proof.upload` |
| **Cancel** | **YES** | `settlement.prepare` |
| **Fail** | **YES** | `settlement.approve` |

> **Documentation drift (code is truth):** `app/api/organizer/settlements/[settlementId]/approve/route.ts` says *"a MANAGER may prepare but not approve"*. That is **false against the shipped maps** — `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.MANAGER` **does** contain `settlement.approve`, and `MEMBERSHIP_ROLE_PERMISSIONS.MANAGER` too. A MANAGER **can** approve.

Membership roles with the same financial set: `OWNER`, `MANAGER`, `FINANCE` (`MEMBERSHIP_ROLE_PERMISSIONS`).

---

## 6. Settlement Architecture

**Model:** `Settlement` (+ `SettlementItem`). One table serves two payee types (`SettlementPayeeType.PIC | ORGANIZER`); V1 writes `payeeType = "PIC"` and **populates both** `picProfileId` (payee) and `organizerId` (accounting tenant) — the latter is what makes tenant-scoped authorization possible and matches the schema's per-organizer unique index.

**Implemented state machine (only these transitions exist):**

```
                 ┌────────── PIC origin (Phase 21) ──────────┐
                 │        create(origin: PIC_REQUEST)        │
                 ▼                                           │
            ┌──────────┐  operator create(DRAFT)   ┌──────────┴───┐
            │REQUESTED │◄──────────────────────────│    DRAFT     │
            └────┬─────┘                           └──────┬───────┘
                 │ approve                       submit │      │ cancel
                 │ (service: settlement.approve)        ▼      ▼
                 │                             ┌──────────────┐ CANCELLED
                 │                             │PENDING_APPROVAL│
                 │                             └──────┬────────┘
                 │        approve                     │ cancel
                 └──────────────►┌──────────┐◄────────┘
                                 │ APPROVED │
                                 └────┬─────┘
                     proof (APPROVED only)│  paid  │ fail
                                          ▼        ▼      ▼
                              proofFilePath  ┌──────┐  ┌────────┐
                                             │ PAID │  │ FAILED │
                                             └──────┘  └────────┘
                 reject (REQUESTED only) ─► REJECTED
```

| Transition | Function | Guard | Effect on claims |
|---|---|---|---|
| `∅ → DRAFT` | `createPreparedSettlement(origin: OPERATOR)` | `settlement.prepare` | writes `SettlementItem` rows |
| `∅ → REQUESTED` | `createPreparedSettlement(origin: PIC_REQUEST)` | `pic_payout.request.own` (own) | writes `SettlementItem` rows |
| `DRAFT → PENDING_APPROVAL` | `submitSettlement` | `settlement.prepare` | — |
| `PENDING_APPROVAL｜REQUESTED → APPROVED` | `approveSettlement` | `settlement.approve` + SoD | — |
| `REQUESTED → REJECTED` | `rejectSettlement` | `settlement.approve` + SoD | **releases** lines (`releaseSettlementItems`) |
| `APPROVED → PAID` | `markSettlementPaid` | `settlement.approve` + SoD + proof + reference | **flips/link ledger + appends PAYOUT** ★ |
| `APPROVED → FAILED` | `failSettlement` | `settlement.approve` | releases lines |
| `DRAFT｜PENDING_APPROVAL → CANCELLED` | `cancelSettlement` | `settlement.prepare` | releases lines |

**Proof / evidence:** `lib/ticketing/settlement/proof.ts` — magic-byte validated (JPEG/PNG/WEBP/PDF), ≤ 5 MB, server-generated filename under `UPLOAD_DIR/settlement-proof/`, served only through an authenticated, tenant-re-checked route with `nosniff` + `Content-Disposition: inline`. Re-upload while APPROVED replaces the file; the superseded file is deleted only after the DB link commits.
**Provider reference:** `Settlement.providerReference` is the operator's **manual bank-transfer reference** (min 3 chars), never an iPaymu id. `GATEWAY_SPLIT` is storage-only and never written (D-04).
**Idempotency:** no client idempotency key. Re-running any transition is safe via status CAS (`updateMany` with the source status) and returns `ALREADY`; prepare replays the existing row via the unique window index.
**Concurrency:** every transition is one `prisma.$transaction` wrapped in `withContentionRetry`; the duplicate-claim boundary is `SettlementItem.picFeeLedgerId @unique` (`P2002` → `ALREADY_CLAIMED` retry message on the PIC path).
**Paid-time re-check:** `markSettlementPaid` refuses (`NEW_REVERSAL_DETECTED`) if an unconsumed REVERSAL landed on a claimed order item after prepare.
**SoD:** see §11.

---

## 7. PICFeeLedger Architecture

**Append-only.** The schema comment: *"Never UPDATE an amount — post a REVERSAL/ADJUSTMENT row instead."* `direction` is the sign; `amount` is `Decimal(14,2)`.

| # | Question | Answer |
|---|---|---|
| 1 | How are `EARNED` entries created? | `postEarnedPicFees` (`lib/pic/attribution.ts`), called from the **order payment settlement** (`lib/ticketing/payment/settlement.ts:472`) when an order settles; it **replays** the checkout snapshots (never recomputes). Key `fee:earned:{orderItemId}`. |
| 2 | How are `REVERSAL` entries created? | `lib/ticketing/refunds/settlement.ts:492` on refund settlement, proportional per order item (`reversalRef` = source refund). Key `fee:reversal:{refundId}:{orderItemId}`. |
| 3 | How are `PAYOUT` entries created? | `markSettlementPaid` (the payout engine), one DEBIT per included EARNED item, `status=SETTLED`. Key `fee:payout:{settlementId}:{earnedId}`. |
| 4 | How is **current balance** calculated? | `lib/pic/ledger.ts#getPicLedgerBalance`: `Σ CREDIT − Σ DEBIT` over the **whole** ledger (groupBy, no time box, no truncation). One canonical helper used by PIC self-service and admin views. |
| 5 | What kind of balance is it? | **Whole-ledger net** for the PIC (`net`, can be negative). It is **not** settleable, **not** period- or organizer-scoped. The **settleable** figure is a *different* function: `previewSettleable` → `selectSettlementItems` (per PIC + tenant + window). The PIC UI labels the settleable number explicitly ("Saldo yang dapat dicairkan"). |
| 6 | How does `SettlementItem` reference the ledger? | `SettlementItem.picFeeLedgerId` (nullable, **`@unique`**) → `PICFeeLedger`; the mirrored `PICFeeLedger.settlementId` is the column the money code flips. |
| 7 | Can a ledger entry be paid more than once? | **No.** `SettlementItem.picFeeLedgerId @unique` + the `paid` CAS (`status: EARNED, settlementId: null`). |
| 8 | Uniqueness constraints | `PICFeeLedger.idempotencyKey @unique`; `@@unique([orderItemId, type, reversalRef])`; `SettlementItem.picFeeLedgerId @unique`; `Settlement @@unique([payeeType, picProfileId, periodStart, periodEnd])` and `@@unique([payeeType, organizerId, periodStart, periodEnd])`. |
| 9 | Concurrency protection | Whole-transaction transitions + status CAS + `withContentionRetry` + `P2002` handling; the DB, not a read-then-write check, decides claim races. |

---

## 8. Payout Amount Semantics

| Question | Answer |
|---|---|
| Does Admin/Manager enter the amount? | **No.** No schema or endpoint accepts an amount. `validation.ts` states it explicitly. |
| Calculated from a period? | **Yes** — "every consumable EARNED row in the window, offset by every consumable REVERSAL row", plus carried post-paid claw-backs. |
| From ledger rows? | **Yes** — `selectSettlementItems` (`lib/ticketing/settlement/settlement.ts`). |
| Can one payout contain multiple ledger rows? | **Yes** — one `SettlementItem` per included EARNED row **and** per offsetting REVERSAL row. |
| Organizer-specific? | **Yes** — exactly one `organizerId` per settlement. |
| Can one payout span multiple organizers? | **No.** |
| Can a payout be partial? | **Operator:** yes, by choosing a narrower window. **PIC:** no — the window is server-derived (`earliest eligible → now`) and the amount is read-only, so a PIC always requests the **full** settleable balance for one tenant. |
| Minimum amount? | **None.** The only floor is `net > 0` (`NOTHING_SETTLEABLE`). No constant/config/business rule for a minimum exists. |
| Maximum amount? | **None** — bounded only by available settleable ledger rows. |
| Who determines the final amount? | **The server** (transactional core). Both the displayed number and the claimed number come from the *same* `selectSettlementItems`; a client cannot influence it. |

**Source of truth:** `Settlement.grossAmount` / `deductionAmount` / `netAmount`, computed inside `createPreparedSettlement` and consumed unchanged by `markSettlementPaid` (which re-checks for late reversals).

---

## 9. Bank Information

Fields live on `PICProfile`: `bankName`, `bankAccountName`, `bankAccountNumber` (all nullable), plus `taxId`. A snapshot is copied onto `Settlement.bankName/bankAccountName/bankAccountNumber` at prepare time.

| # | Question | Answer |
|---|---|---|
| 1 | Who can **create** bank information? | **ADMIN** with `pic.manage`, at PIC-profile creation only — `lib/pic/service.ts:264-266` via `POST /api/admin/pic`. (The Phase 33 user-provisioning path `lib/admin/users.ts:235` creates a `PICProfile` **without** bank fields.) |
| 2 | Who can **modify** it? | **Nobody through the application.** There is no `pICProfile.update` that writes bank fields; `updatePicStatus` changes only `status`/approval stamps, and `updatePicStatusSchema` has no bank field. |
| 3 | Can a PIC edit it? | **No** — there is no PIC self-service profile-update route or UI. |
| 4 | Is it **snapshotted** at payout creation? | **Yes** — copied into the `Settlement` row by `createPreparedSettlement`, and required to be complete (`BANK_DETAILS_MISSING` otherwise). |
| 5 | What if bank info changes **after** creation? | It cannot be changed through the app, so the snapshot cannot drift. Even if it were changed, the payout pays the **snapshot** — the historical record stays truthful. |

---

## 10. Authorization / Tenant Isolation

**Scopes** (`lib/authz/permissions.ts` → `PERMISSION_SCOPE`): `PLATFORM` | `ORGANIZER` | `OWN`. Unknown permission ⇒ deny. Effective permission = capability (role map or grant) **AND** scope; never a union of loose grants.

| Surface | Guard | Failure shape |
|---|---|---|
| Organizer settlement routes | `requireAuth()` (route) then `requireOrganizerAccess(row.organizerId, …)` (service). The organizer is resolved **from the Settlement row**, never from the request. | No active membership ⇒ `ORGANIZER_ACCESS_DENIED` → **404** (does not confirm existence) |
| PIC payout routes | `requireAuth()` (route) then `requireMyPic(userId, [pic_payout.request.own])` (service) | Wrong user ⇒ `PIC_ACCESS_DENIED`; no ACTIVE profile ⇒ `NOT_FOUND` |
| Cross-tenant detail read | `getSettlement` re-guards the row's own `organizerId` | 404 |
| IDOR on `picProfileId` | PIC functions accept **no** `picProfileId`; identity comes from the session | forged id ⇒ denial |
| Proxy | `/api/organizer/`, `/api/pic/`, `/api/admin/` are in `PROTECTED_API_PREFIXES` (`proxy.ts:121-134`) | defence in depth only |

**If PIC → request and ADMIN/MANAGER → review were to be "added", the isolation work is already done:** the PIC path is own-scope and cannot name a foreign ledger row; the review path re-uses `settlement.approve` against the row's tenant. **What would still need changing is not isolation but the two capability asymmetries in the Executive Summary** (Admin cannot prepare; Admin approves only via grant) and the missing approver≠payer SoD.

---

## 11. Segregation of Duties (current enforcement, verbatim)

Enforced in `lib/ticketing/settlement/service.ts` on `Settlement.preparedByUserId`:

| Check | Enforced? | Code |
|---|---|---|
| preparer ≠ approver | **YES** | `approveSettlement` → `preparedByUserId === actor.userId` ⇒ `FORBIDDEN / SEPARATION_OF_DUTIES` |
| preparer ≠ rejecter | **YES** | `rejectSettlement` → same check |
| preparer ≠ payer | **YES** | `paySettlement` → same check |
| **approver ≠ payer** | **NO** | no such comparison exists |
| preparer ≠ submitter | **NO (deliberate)** | `submit/route.ts` documents that SoD sits on the financial edges |
| preparer ≠ failer / canceller | **NO** | `failSettlement` / `cancelSettlement` carry no SoD check |

The module header claims *"author ≠ approver ≠ payer"*, but the code enforces only the two `author ≠ …` equalities. The single honest statement is: **preparer ≠ approver and preparer ≠ payer; the approver may also be the payer.**

**Can current SoD accommodate `PIC requester → Manager/Admin approver → payment operator` without weakening controls?**
**Yes, with the PIC flow as shipped** — because the PIC author holds no `settlement.*` capability at all, every operator automatically satisfies `author ≠ approver`. The only real gap relative to a stricter three-party model is the missing `approver ≠ payer` rule; adding it is a small, local check in `paySettlement` (schema unchanged), not a redesign.

---

## 12. Current UI

| Surface | File | What exists |
|---|---|---|
| **PIC dashboard** | `app/dashboard/pic/page.tsx` | "Fee Bersih" stat; "Ringkasan Fee" card (Kredit/Debit/Net + own-fee export); fee ledger table; **"Pencairan" card** with per-tenant **"Saldo yang dapat dicairkan"**, an **"Ajukan Pencairan"** action, and a payout **history table** (Pencairan, Penyelenggara, Status, Tujuan(bank, masked), Jumlah, Dibayar). |
| **PIC request control** | `components/dashboard/PicPayoutRequestDialog.tsx` | Tenant `Select` (only positive-balance tenants), **read-only** amount field, optional note (≤2000), posts `{organizerId, notes?}` to `/api/pic/payouts`; surfaces server refusals verbatim. Disabled when no settleable balance. |
| **PIC detail (admin view)** | `app/dashboard/pic/[id]/page.tsx` | PIC profile detail incl. masked bank (`maskAccountNumber`). Read-only for bank. |
| **Operator settlement list** | `app/dashboard/settlements/page.tsx` | "Pencairan PIC" worklist; **`SettlementPrepareForm`** at the top ("Buat pencairan": tenant, PIC payee, period start/end, optional note — **no amount field**); status filter incl. `REQUESTED`/`REJECTED`; masked bank; net amount; deep links to detail. |
| **Operator settlement detail** | `app/dashboard/settlements/[id]/page.tsx` | Summary (Bruto/Potongan/Jumlah dibayar/Metode), **"Bank penerima"** (snapshotted, masked), **"Bukti & evidence"** (reference, proof link, failure reason, **rejection reason**), and the claimed line list. |
| **Operator actions** | `components/dashboard/SettlementActions.tsx` | `DRAFT` → *Ajukan persetujuan* / *Batalkan*; `PENDING_APPROVAL` → *Setujui* / *Batalkan*; **`REQUESTED`** → ***Setujui* / *Tolak*** (Tolak opens a required-reason dialog); `APPROVED` → *Upload/Ganti bukti transfer*, *Tandai dibayar*, *Gagalkan*. Terminal states show "Tidak ada tindakan tersisa." |
| **Prepare form** | `components/dashboard/SettlementPrepareForm.tsx` | Posts to `/api/organizer/settlements`. |
| **Dialog pure logic** | `components/dashboard/manual-transfer-dialog.ts` | Definitions for `paid` / `settleFail` / **`rejectPayout`** kinds (required reason, 3-char min). |

---

## 13. API Inventory

| Method | Path | Role / Permission | Purpose | Status | Accounting effect |
|---|---|---|---|---|---|
| `GET` | `/api/pic/payouts` | PIC session + `pic_fee.read.own` & `pic_payout.request.own` | Own requests + per-tenant settleable amounts | **IMPLEMENTED** | none |
| `POST` | `/api/pic/payouts` | PIC session + `pic_payout.request.own` | **Create PIC payout request** | **IMPLEMENTED** | writes `Settlement(REQUESTED)` + claim items; **no ledger write** |
| `GET` | `/api/organizer/settlements` | `settlement.prepare` in tenant(s) | List payouts | IMPLEMENTED | none |
| `POST` | `/api/organizer/settlements` | `settlement.prepare` | **Prepare** operator payout | IMPLEMENTED | writes `Settlement(DRAFT)` + claim items |
| `GET` | `/api/organizer/settlements/[settlementId]` | `settlement.prepare` (row tenant) | Detail + items | IMPLEMENTED | none |
| `POST` | `…/[settlementId]/submit` | `settlement.prepare` | `DRAFT → PENDING_APPROVAL` | IMPLEMENTED | none |
| `POST` | `…/[settlementId]/approve` | `settlement.approve` + SoD | `PENDING_APPROVAL｜REQUESTED → APPROVED` | IMPLEMENTED | none |
| `POST` | `…/[settlementId]/reject` | `settlement.approve` + SoD | **`REQUESTED → REJECTED`** (reason required) | **IMPLEMENTED** | releases claim items; no ledger write |
| `POST` | `…/[settlementId]/proof` | `settlement.proof.upload` | Upload transfer evidence | IMPLEMENTED | file only; no ledger write |
| `GET` | `…/[settlementId]/proof/[fileName]` | `settlement.proof.upload` (row tenant) | Serve evidence | IMPLEMENTED | none |
| `POST` | `…/[settlementId]/paid` | `settlement.approve` + SoD + proof + reference | **Record manual transfer** | IMPLEMENTED | **EARNED→SETTLED, link REVERSAL, append PAYOUT DEBIT** ★ |
| `POST` | `…/[settlementId]/fail` | `settlement.approve` | `APPROVED → FAILED` | IMPLEMENTED | releases claim items |
| `POST` | `…/[settlementId]/cancel` | `settlement.prepare` | `DRAFT｜PENDING_APPROVAL → CANCELLED` | IMPLEMENTED | releases claim items |
| `POST` | `/api/admin/pic` | `pic.manage` (ADMIN) | Create PIC profile **incl. bank** | IMPLEMENTED | none |
| `GET/PATCH` | `/api/admin/pic/[id]` | `pic.manage` (ADMIN) | PIC detail / **status only** | IMPLEMENTED | none (no bank write) |

**Doc discrepancies to fix (not fixed here):** `approve/route.ts` ("MANAGER … not approve") and `paid/route.ts` ("requires `settlement.approve` AND `settlement.proof.upload`") do not match `permissions.ts` / `service.ts#paySettlement`.

---

## 14. Database Inventory (read-only)

**`PICProfile`** — `userId @unique`, `picCode @unique`, `status PICStatus`, `defaultFeeRateBp Int @default(0)`, `canSellAllEvents Boolean`, `bankName?`, `bankAccountName?`, `bankAccountNumber?`, `taxId?`, `approvedByUserId?`, `approvedAt?`, `suspendedAt?`, `suspendReason?`; relations to `PICEventAssignment[]`, `PICAttribution[]`, `PICFeeLedger[]`, `Settlement[]`, `EventOrder[]`; `@@index([status])`.

**`PICEventAssignment`** — `@@unique([picProfileId, eventId])`; `feeRateBp?`, `feeTypeOverride?`, `isActive`, `revokedAt?`; indexes on `[eventId,isActive]`, `[picProfileId,isActive]`, `[organizerId]`.

**`PICAttribution`** — `orderId @unique` (structural "one attribution per order"); `source`, `method?`, `shareToken?`, `selfReferral`, `isFinal`.

**`PICFeeLedger`** — append-only. Key fields: `type PICFeeEntryType`, `direction LedgerDirection`, `amount Decimal(14,2)`, `status PICFeeStatus @default(EARNED)`, snapshots (`rateBp`, `fixedAmount?`, `basisType`, `basisAmount`), `settlementId?`, `refundId?`, `reversalRef @default("NONE")`, **`idempotencyKey @unique`**; **`@@unique([orderItemId, type, reversalRef])`**; indexes `[picProfileId,status,createdAt]`, `[organizerId,createdAt]`, `[eventId,createdAt]`, `[orderId]`, `[settlementId]`.

**`Settlement`** — `settlementNumber @unique`; `payeeType`; **`picProfileId?` / `organizerId?` (V1 PIC rows populate both)**; `periodStart/periodEnd`; `grossAmount/deductionAmount/netAmount Decimal(14,2)`; `status SettlementStatus @default(DRAFT)`; `method SettlementMethod`; bank snapshot `bankName?/bankAccountName?/bankAccountNumber?`; `providerReference?`, `providerStatus?`, `proofFilePath?`; `preparedByUserId`, `approvedByUserId?/approvedAt?`, `paidByUserId?/paidAt?`, **`rejectedByUserId?/rejectedAt?/rejectionReason?`**; `failureReason?`, `notes?`. **Uniques:** `[payeeType, picProfileId, periodStart, periodEnd]`, `[payeeType, organizerId, periodStart, periodEnd]`. **Indexes:** `[payeeType,picProfileId,status]`, `[organizerId,status]`, `[status,createdAt]`.

**`SettlementItem`** — `settlementId`, **`picFeeLedgerId String? @unique`**, `orderId?`, `amount`, `direction`, `description?`; indexes `[settlementId]`, `[orderId]`.

**Enums:** `SettlementPayeeType (PIC|ORGANIZER)`, `SettlementStatus (DRAFT|PENDING_APPROVAL|APPROVED|PAID|FAILED|CANCELLED|REQUESTED|REJECTED)`, `SettlementMethod (MANUAL_TRANSFER|GATEWAY_SPLIT)`, `PICFeeEntryType (EARLY_ACCRUAL|EARNED|EARNED_ADJUSTMENT|REVERSAL|PAYOUT|ADJUSTMENT)`, `PICFeeStatus (PENDING|EARNED|PAYABLE|APPROVED|SETTLED|VOID)`, `LedgerDirection (CREDIT|DEBIT)`, `FeeBasisType`, `PICFeeType`, `PICStatus`, `PICAttributionSource/Method`, `PlatformRole`, `OrganizerMemberRole/Status`.

**Tenant models:** `Organizer` (tenant), `OrganizerMember` (ACTIVE membership = tenant scope), `User.platformRole`.

---

## 15. Future Change Impact

Because the target flow **already ships**, the remaining "change" is refinement. The realistic deltas:

| Concern | Current state | Delta needed |
|---|---|---|
| PIC self-request | **Done** | none |
| Admin/Manager approve/reject | **Done** (Manager by role; Admin via grant) | decide whether Admin should hold it by role |
| No minimum amount | **Already true** | none |
| Approver ≠ payer | **Missing** | 1 comparison in `paySettlement` (or a policy flag) |
| Bank-detail maintenance | **No edit path anywhere** | new admin (or PIC) edit path + validation + audit |
| Partial / specified amount | **Not supported** | would change amount semantics (see §16) |
| Cross-tenant aggregate | **Not supported** | schema/index change |
| Route doc drift | present | comment fixes only |

**Schema/API/UI/SoD impact of each delta is enumerated in §16.**

---

## 16. Options (presented, not chosen)

> Both options below assume the feature is missing. Since it is **already implemented via Option A**, the sections that follow are the realistic paths *forward*, not alternatives for a rebuild.

### Option A — Extend the existing `Settlement` lifecycle *(this is what shipped in Phase 21)*
- **Schema:** `SettlementStatus += REQUESTED|REJECTED`; `Settlement += rejectedByUserId/rejectedAt/rejectionReason`. *(Already applied: migration `20260927000000_add_pic_payout_requests`.)*
- **API:** add `POST /api/pic/payouts`; make `approve` accept `REQUESTED`; add `reject`. *(Done.)*
- **UI:** PIC request dialog + history; operator Setujui/Tolak. *(Done.)*
- **Authorization:** new own-scope `pic_payout.request.own`; review reuses `settlement.approve`. *(Done.)*
- **Accounting:** **zero new logic** — the PIC path calls the same engine; only the initial state and audit verb differ. *(Verified.)*
- **SoD:** preserved structurally (PIC author holds no `settlement.*`). *(Done.)*
- **Concurrency:** unchanged (`SettlementItem.picFeeLedgerId @unique`). *(Done.)*
- **Migration complexity:** low (additive enum values + 3 nullable columns). *(Done.)*
- **Risk of duplicating accounting:** **nil** — one money engine.

**Residual refinement (still Option A):** add `approver ≠ payer`; add a bank-detail edit path; optionally grant `settlement.prepare`/`proof.upload` to ADMIN (a deliberate D-19 change).

### Option B — A separate `PayoutRequest` layer that hands off to `Settlement`
- **Schema:** new `PayoutRequest` model + status enum, nullable FK to `Settlement`. **Risk:** two state machines, two audit vocabularies.
- **API:** new `/api/pic/payout-requests` tree + a hand-off endpoint that must call the money engine and dedupe.
- **UI:** a second PIC + operator surface parallel to the existing one.
- **Authorization:** a second own-scope permission tree alongside `pic_payout.request.own`.
- **Accounting:** must still delegate to `selectSettlementItems`/`markSettlementPaid`; **high risk of duplicating accounting logic** (the exact thing the current design avoids).
- **SoD/concurrency:** must re-implement the claim boundary or reuse `SettlementItem`; high risk.
- **Migration complexity:** medium-high. **Verdict:** only justified if a *materially different* object is needed (e.g. a request that can bundle multiple tenants, or a non-financial approval artifact).

### Option C — Extend Option A with explicit request semantics *(if the owner wants changes)*
Keep `Settlement` as the single ledger-bearing object, and add the specific requested behaviors on top:
- a **server-side** policy for partial vs full (still no client amount, if partial is wanted),
- an optional `approver ≠ payer` rule,
- a bank-detail maintenance surface,
- optional Aggregate/rounding policy.
Cheapest path; no new accounting code; keeps one state machine and one audit vocabulary.

**Do not choose for the owner** — the decision hinges on the questions in §17.

---

## 17. Owner Decisions Required

1. **Is the shipped Phase 21 flow acceptable as-is**, or does the owner want changes? (It already does "PIC requests → Admin/Manager approves/rejects".)
2. Should a PIC request the **full** settleable balance only (today), or be able to request a **partial/specific** amount? If partial: still server-derived, or entered? (Entering an amount conflicts with the current "no client-supplied amount" guarantee.)
3. Should a PIC be able to request **one tenant at a time** (today) or **aggregate** across tenants in one request?
4. Should **ADMIN** approve/reject **by role** (today: only with an explicit `PermissionGrant`, D-19), or stay grant-required?
5. Should **ADMIN** be able to **prepare** a payout at all? (Today: no, and not grantable.)
6. Must **approver ≠ payer** be enforced (today it is not), or is preparer-only SoD sufficient?
7. Who is the intended **final payer** — the same operator who approved, or a distinct "payment operator"?
8. Should PIC **bank details** be editable, and by whom — the PIC themselves (with re-verification) or an ADMIN? Today there is **no** edit path.
9. What should happen when the **balance changes between request and approval** (today: a late reversal blocks `paid` with `NEW_REVERSAL_DETECTED` and the operator must fail/re-prepare)? Is that acceptable, or should the amount re-derive at approval?
10. Should a **minimum payout amount** exist? (Today: none; only `net > 0`.) The brief says no arbitrary minimum — confirm.
11. Are the **statuses** `REQUESTED`/`REJECTED` the desired vocabulary, and are `FAILED`/`CANCELLED`/`REJECTED` distinct enough for operator reporting?

---

## 18. Recommended Next Phase (AUDIT ONLY — no implementation)

Given the flow already exists, the recommended next phase is **not** "build PIC self-service"; it is:

1. **Owner sign-off on §17**, primarily decisions 4–6 (Admin capability) and 6 (approver ≠ payer), which are the only places the current implementation diverges from a strict three-party control.
2. **Close the two documentation drifts** in `approve/route.ts` and `paid/route.ts` so the code and its comments agree about MANAGER approval and the `paid` permission set.
3. **Decide and, if approved, implement** a PIC **bank-detail maintenance** path — today a wrong bank detail can only be fixed by direct DB access, which is an operational and audit defect independent of this feature.
4. Leave the accounting engine, the claim uniqueness boundary, the amount derivation and the state machine **untouched**; any change there risks duplicating money logic that is currently single-sourced.

---

## Appendix — Verification guarantees for this audit

- **Read-only.** Only file reads and `grep`/`ls`/`git log`/`git status` were executed. No mutation, no script run against the DB, no `prisma` command, no migration.
- **Source files changed: ZERO.**
- **Schema changed: ZERO.**
- **Migrations: ZERO** (the referenced `20260927000000_add_pic_payout_requests` already existed at HEAD).
- **Dependencies changed: ZERO.**
- **Commits: ZERO. Pushes: ZERO.**
- **Files inspected:** `prisma/schema.prisma`; `lib/ticketing/settlement/{service,settlement,validation,payload,proof}.ts`; `lib/pic/{payout,self-service,ledger,service,validation,attribution,reporting,reconciliation}.ts`; `lib/authz/{permissions,guards}.ts`; `lib/dashboard/scope.ts`; `lib/admin/users.ts`; the ten `app/api/organizer/settlements/**` routes; `app/api/pic/payouts/route.ts`; `app/api/admin/pic/[id]/route.ts`; `app/dashboard/pic/page.tsx`; `app/dashboard/pic/[id]/page.tsx`; `app/dashboard/settlements/{page,[id]/page}.tsx`; `components/dashboard/{PicPayoutRequestDialog,SettlementActions,SettlementPrepareForm,manual-transfer-dialog}.tsx`; `proxy.ts`; `lib/ticketing/payment/settlement.ts`; `lib/ticketing/refunds/settlement.ts`; `__tests__/pic-self-service/payout-request.integration.test.ts`; `__tests__/ticketing-pic/settlement.integration.test.ts`; and the prior reports `PHASE_21_PIC_PAYOUT_AND_QR_SCANNER_{AUDIT,IMPLEMENTATION_REPORT}.md`, `PIC_PAYOUT_SETTLEMENT_*`.
- **Report created:** `PHASE_PIC_PAYOUT_SELF_SERVICE_AUDIT.md` (this file — a document, not source).
