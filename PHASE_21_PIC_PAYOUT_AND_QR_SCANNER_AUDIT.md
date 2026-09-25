# PHASE 21 — PIC SELF-SERVICE PAYOUT + QR CHECK-IN SCANNER COMPATIBILITY

**AUDIT ONLY — NO SOURCE, SCHEMA, MIGRATION OR DATA CHANGES WERE MADE.**

- Repo: `/home/reksa/tinggalklik` · branch `main` · app **NOT DEPLOYED** (per `DEPLOYMENT_RUNBOOK.md`)
- Method: read-only source inspection, Prisma schema inspection, dependency inspection, existing-test inspection.
- Merge-safety: no file under `app/`, `lib/`, `components/`, `prisma/`, `__tests__/` or `package.json` was written, and no migration, commit, push, reset or rebase was performed.

---

## 1. Executive Summary

Two independent verticals were audited:

- **PART A — PIC self-service payout.** The PIC money domain is fully implemented but **operator-initiated**. A PIC's own dashboard (`app/dashboard/pic/page.tsx`, third branch) is **read-only**: it displays earnings, the append-only fee ledger and a *history* of settlements, but has **no "Ajukan Pencairan" control, no payout-request route and no PIC-facing mutation of any kind**. Every money movement lives on `/api/organizer/settlements/*`, gated by tenant-scope `settlement.prepare` / `settlement.approve` / `settlement.proof.upload` and a preparer-vs-approver separation of duties. The existing `Settlement` domain can *technically* be extended, but it models a **period-window-derived operator claim**, not a **PIC-specified amount request**, and its authorization model assumes the creator is a tenant member. This is a **requirements conflict**, not a missing endpoint.

- **PART B — QR scanner compatibility.** The gate scanner (`components/organizer/TicketScanner.tsx`) is a working client-side *input device* over the unchanged check-in backend. Its only hard compatibility defect is that it **aborts when `window.BarcodeDetector` is absent** — which is the exact case on Firefox, Safari and desktop Chrome on Linux. The camera itself (`getUserMedia`) is supported there; only the decode step is missing. The fix is purely a client-side decode fallback; the backend, the `TICKET:<ticketCode>` payload (D-46) and the authorization model stay untouched.

**Verdicts** are in §26: PIC PAYOUT = **BLOCKED — OWNER DECISION REQUIRED**; QR SCANNER = **READY FOR IMPLEMENTATION** (one owner decision: approve adding a decoder dependency).

---

## 2. PART A — Current PIC Earnings / Payout Architecture

### 2.1 The PIC dashboard is one page with three authority branches

`app/dashboard/pic/page.tsx` renders exactly one of:

1. `PlatformPicSection` — platform `pic.manage` (ADMIN): create/approve/suspend profiles (list via `listPicsForAdmin`).
2. `OrganizerPicSection` — tenant `pic.assign`: attach an approved PIC to an organizer's event.
3. `PicSelfServiceSection` — the caller's own **ACTIVE** `PICProfile`; **read-only**.

A `PIC`-role account with a non-ACTIVE profile gets `AccountStandingNotice` (§PHASE 34 path). A caller with none of the three gets `AccessDeniedPanel`.

**The self-service branch is the only PIC-owned surface, and it is read-only by construction** (documented at the top of `lib/pic/self-service.ts`: "Every function here is read-only").

### 2.2 Where earnings and balance are displayed (self-service branch)

| Surface | Data | Service |
|---|---|---|
| StatGrid "Fee Bersih" | `overview.netFee` | `getMyPicOverview` |
| "Ringkasan Fee" card: Total Penjualan / Fee Diperoleh / Fee Pembatalan / Fee Bersih | `grossSales`, `feeEarned`, `feeReversed`, `netFee` | `getMyPicOverview` |
| "Ledger Terbaru" table (50 rows, newest first) | `listMyFeeLedger` | `pic_fee.read.own` |
| "Pencairan" table (50 rows) — **payout history, read-only** | `listMySettlements` | `pic_fee.read.own` |
| "Ekspor CSV" anchor | `/api/reports/my-pic-fee/export` | `report.export.own_pic_fee` |

The "Pencairan" card copy is explicit that payouts are **operator-managed**: *"Pencairan dikelola penyelenggara…"* and *"Penyelenggara akan menyiapkan pembayaran fee kamu…"*.

### 2.3 Is there an "Ajukan Pencairan" button today? **No.**

There is no button, no form, no dialog, no route and no server action for PIC-initiated payout. Confirmed by full route sweep (`app/api/**` has only `admin/pic` and `organizer/pic` for PIC; `organizer/settlements` for payout) and by `PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md` §2 alongside this re-verification.

### 2.4 Where "Ajukan Pencairan" would logically live

The self-service **"Pencairan" section** of `/dashboard/pic` (or the "Ringkasan Fee"/`#earnings` anchor), rendered only for the third branch, guarded by the same `requireMyPic` identity+profile+own-scope gate. Its navigation row already exists: `components/dashboard/DashboardAppShell.tsx` exposes `Ringkasan PIC`, `Event Saya`, `Referral`, `Pendapatan` (all `/dashboard/pic…`), pinned by `__tests__/pic-self-service/menu.test.ts`.

### 2.5 "Available balance" — what the PIC actually sees

The number labelled "Fee Bersih" / "Fee Bersih" is computed by `getPicLedgerBalance(picProfileId)`:

```
net = Σ(CREDIT.amount) − Σ(DEBIT.amount)   over the WHOLE PICFeeLedger (groupBy direction)
```

This is the **canonical** balance helper (`lib/pic/ledger.ts`, "THE ONE CANONICAL SUM", Phase 30 GAP-1/GAP-2), used by self-service and platform admin alike. It is **not** window-limited and **not** type-filtered. See §3.4 for the discrepancy with the *settleable* amount.

---

## 3. PICFeeLedger Lifecycle

### 3.1 Model and enums (`prisma/schema.prisma`)

- `model PICFeeLedger` (line ~1508): append-only, `amount Decimal(14,2)`, `direction`, `status`, snapshot fields (`rateBp`, `fixedAmount`, `basisType`, `basisAmount`, `quantity`), `refundId`, `settlementId`, `idempotencyKey @unique`, `reversalRef`.
- Unique wall: `@@unique([orderItemId, type, reversalRef])`; indexes on `(picProfileId,status,createdAt)`, `organizerId`, `eventId`, `orderId`, `settlementId`.
- `PICFeeEntryType` = `EARLY_ACCRUAL · EARNED · EARNED_ADJUSTMENT · REVERSAL · PAYOUT · ADJUSTMENT`
- `LedgerDirection` = `CREDIT · DEBIT`
- `PICFeeStatus` = `PENDING · EARNED · PAYABLE · APPROVED · SETTLED · VOID`
- `PICFeeType` = `PERCENTAGE · FIXED · HYBRID`; `FeeBasisType` = `GROSS_BEFORE_DISCOUNT · GROSS_AFTER_DISCOUNT · NET_AFTER_GATEWAY`

### 3.2 Every writer (verified by `pICFeeLedger.create` grep)

| Row | Writer | Shape |
|---|---|---|
| **EARNED** | `lib/pic/attribution.ts:224` (`postEarnedPicFees`) | `type=EARNED`, `direction=CREDIT`, `status=EARNED`, key `fee:earned:{orderItemId}` |
| **REVERSAL** | `lib/ticketing/refunds/settlement.ts:483` | `type=REVERSAL`, `direction=DEBIT`, `reversalRef` set per source refund (BUG-3), key `fee:reversal:{refundId}` |
| **PAYOUT** | `lib/ticketing/settlement/settlement.ts:965` (`markSettlementPaid`) | `type=PAYOUT`, `direction=DEBIT`, `status=SETTLED`, one per included EARNED item, key `fee:payout:{settlementId}:{earnedId}` |

The only column mutations of existing rows are the **paid-time state transitions** on already-claimed rows (`settlement.ts:859` `EARNED → SETTLED` + `settlementId` link; `settlement.ts:888` `settlementId` link on consumed REVERSAL rows). There is **no `pICFeeLedger.update`/`delete` of an amount anywhere** in `app/`/`lib/` — the ledger is append-only in practice. `EARLY_ACCRUAL`, `EARNED_ADJUSTMENT`, `ADJUSTMENT` and statuses `PENDING/PAYABLE/APPROVED` have **zero writers** (vocabulary only).

### 3.3 How an EARNED fee is created end-to-end

```
buyer checkout (attributed order)                 lib/ticketing/checkout.ts
   → PICAttribution captured (one per order)      lib/pic/attribution.ts
   → fee computed once at checkout                lib/pic/fee.ts (computeLinePicFee, resolvePicFeeConfig)
       inheritance: assignment.feeRateBp ?? profile.defaultFeeRateBp>0 ?? platformDefault>0 ?? 0
       basis fixed at GROSS_BEFORE_DISCOUNT; rounding once, half-up to whole rupiah
   → order paid (webhook-only PAID)               lib/ticketing/payment/settlement.ts
   → EARNED ledger row posted                     lib/pic/attribution.ts:224  (status EARNED, CREDIT)
   → reversal on refund                           lib/ticketing/refunds/settlement.ts:483 (DEBIT)
```

The basis and rate are **snapshots**; a later rate change cannot rewrite past earnings. `PICFeeLedger` is the only ledger; attribution is a separate, `orderId @unique` record.

### 3.4 The available-balance formula(s) — DISCREPANCY (reported, not resolved)

Three different "PIC money" numbers exist today:

1. **Canonical net (used by self-service + platform list):** `ΣCREDIT − ΣDEBIT` over the whole ledger — `lib/pic/ledger.ts#getPicLedgerBalance`. ✅ This is the authoritative *available* figure shown to the PIC.
2. **Settleable amount (used by the operator prepare step):** a **windowed** computation in `lib/ticketing/settlement/settlement.ts#selectSettlementItems` — `type=EARNED`, `status=EARNED`, `settlementId IS NULL`, `createdAt` in `[periodStart, periodEnd]`, minus unsettled REVERSAL rows (including **carried post-paid claw-backs**), items with `net ≤ 0` excluded. This is **not** the same as (1): it is period-scoped, consumes only unsettled rows, and carries deficits.
3. **Operator "Total fee (kredit)" (known defect):** `app/dashboard/pic/[id]/page.tsx` sums CREDIT over the **latest 100** ledger rows (`lib/pic/service.ts`, `take: 100`). Already flagged as GAP-2 in `PHASE_29A_PIC_MONEY_LEDGER_AUDIT_REPORT.md`.

**Conclusion:** there is one canonical formula (1) for *displayed available balance*, but it is **not** identical to what a settlement can actually claim (2). Any self-service payout must state which of these a requested amount is checked against. This is an **owner decision** (§25), not a silent choice.

---

## 4. Existing Settlement / Payout Lifecycle

### 4.1 Domain files

- Models: `Settlement`, `SettlementItem` (`prisma/schema.prisma` ~1581/1632). `SettlementPayeeType = PIC | ORGANIZER`; `SettlementStatus = DRAFT · PENDING_APPROVAL · APPROVED · PAID · FAILED · CANCELLED`; `SettlementMethod = MANUAL_TRANSFER · GATEWAY_SPLIT` (GATEWAY_SPLIT storage-only, D-04).
- Service: `lib/ticketing/settlement/service.ts` (authz + SoD + proof + reads); core: `lib/ticketing/settlement/settlement.ts` (transactional money); `payload.ts` (`buildSettlementPayload`, `maskAccountNumber`); `validation.ts`; `proof.ts` (protected storage).
- Routes: `app/api/organizer/settlements/` — `route.ts` (GET list / POST prepare), `[settlementId]/route.ts`, `.../submit|approve|paid|fail|cancel/route.ts`, `.../proof/route.ts`, `.../proof/[fileName]/route.ts`.
- Pages/components: `app/dashboard/settlements/page.tsx`, `app/dashboard/settlements/[id]/page.tsx`, `components/dashboard/SettlementPrepareForm.tsx`, `components/dashboard/SettlementActions.tsx`, `components/dashboard/manual-transfer-dialog.ts` + `use-manual-transfer-dialog.ts`.

### 4.2 Lifecycle (Option C — manual bank transfer with system control, D-P17-04 = B)

```
DRAFT ──submit──▶ PENDING_APPROVAL ──approve──▶ APPROVED ──paid──▶ PAID
   │                     │                 │
   └──cancel──▶ CANCELLED └──cancel──▶ CANCELLED  └──fail──▶ FAILED

APPROVED ──(proof upload, required)──▶ PAID   (providerReference required; only money-moving edge)
```

Guardrails inside the lifecycle:
- `prepareSettlement` requires `settlement.prepare` in the **row's own organizer**; body carries only `organizerId`, `picProfileId`, `periodStart`, `periodEnd`, `notes` — **no amount, no status, no bank** (validation is strict).
- Prepare refuses when the PIC has no complete bank profile (`BANK_DETAILS_MISSING`) and when nothing is settleable (`NOTHING_SETTLEABLE`).
- `approveSettlement` requires `settlement.approve` **and** `preparedByUserId !== actor.userId` (`SEPARATION_OF_DUTIES`).
- `paySettlement` requires `settlement.approve` + SoD, `proofFilePath` present (`PROOF_REQUIRED`), a strict `providerReference` (≥3 chars), and re-checks for a **new unconsumed REVERSAL** on any claimed order item (`NEW_REVERSAL_DETECTED`).
- `recordSettlementProof` only on `APPROVED`, CASed; magic-byte validated (jpeg/png/webp/%PDF-), 5 MB cap, server-named.
- Every transition runs in one `prisma.$transaction` under `withContentionRetry`, with an audit row in the same transaction.

### 4.3 Does the domain represent (a), (b) or both? — **CONFLICT, reported**

**It represents (a) operator-created settlement only.** There is **no PIC-initiated path** and **no REQUESTED/REJECTED state**. Four structural conflicts with the target flow:

1. **Amount basis.** The target flow says the PIC "chooses/requests an amount". The existing model derives the amount server-side from a **period window** of unsettled EARNED rows — it accepts **no amount** from the client, deliberately (`settlement/validation.ts` doc: "every value that determines how much money moves must be derived server-side").
2. **Creator identity.** `createPreparedSettlement` requires an `actor` holding `settlement.prepare` **inside the tenant**. A PIC is not a tenant member and holds no `settlement.*` permission, so the existing prepare path cannot be authored by a PIC.
3. **Tenant scoping.** A PIC-`payeeType` settlement deliberately stores **both** `picProfileId` and `organizerId` ("one PIC that earns in two tenants during the same window must be settleable twice, once per tenant"). A PIC-initiated request must decide whether it targets one tenant or aggregates across tenants.
4. **SoD definition.** SoD is defined as *preparer ≠ approver ≠ payer*. If a PIC authors the request, the "preparer" becomes the PIC and the organizer approves/pays — a **different** SoD than the refunds/settlements model. This is a policy decision.

### 4.4 Reusable pieces

The entire **money half** is reusable as-is: `selectSettlementItems`, `createPreparedSettlement`'s transaction, `markSettlementPaid`'s ledger flips, `SettlementItem.picFeeLedgerId @unique`, proof storage/serving, `buildSettlementPayload` + masking, `withContentionRetry`, audit logging. What is missing is an **initiation/authorization layer**, not accounting.

---

## 5. PIC Bank Information

- **Fields** (`PICProfile`): `bankName String?`, `bankAccountName String?`, `bankAccountNumber String?`, `taxId String?` — **all optional**.
- **Written at creation only**: `createPicSchema` accepts the bank fields (`lib/pic/validation.ts:59-61`) and `lib/pic/service.ts:264-266` writes them. There is **no update schema and no update path** for bank data: `updatePicStatusSchema` contains only `status`+`reason`, and `PATCH /api/admin/pic/[id]` documents that payout details are *not* editable through it.
- **Can the PIC maintain their own destination?** **No.** There is no self-service bank editor; `getMyPicProfile` does not even select the bank fields, so a PIC cannot view their own account number in the dashboard.
- **Can an admin edit it after creation?** **No surface exists** — create-time only.
- **Required?** Not at creation, but **required at settlement prepare** (`BANK_DETAILS_MISSING`) — the operator cannot pay out until the profile has all three.
- **Masking**: `maskAccountNumber` → `••••` + last-4 (`lib/ticketing/settlement/payload.ts:32`); the operator PIC detail has a local copy (`app/dashboard/pic/[id]/page.tsx:79`). The full number is never rendered in a payload or logged.
- **Historical snapshot**: on prepare, `Settlement` **snapshots** `bankName`/`bankAccountName`/`bankAccountNumber` from the profile, so an existing payout's recorded destination cannot drift. (Because there is no edit path, this is currently untested in practice.)
- **Security/privacy concern**: bank data is **admin-entered and immutable**, so a PIC whose account changes cannot update their payout destination without a new/admin action — a real operational gap for a self-service flow.

---

## 6. PIC Authorization

### 6.1 Existing permission keys (`lib/authz/permissions.ts`)

- Platform-scope: `pic.manage`, `pic_attribution.read.all`, `pic_fee.read.all`, `fee.rate.change`, `fee.adjust`, `fee.mark_paid`.
- Tenant-scope: `pic.assign`, `settlement.prepare`, `settlement.approve`, `settlement.proof.upload`.
- Own-scope: `pic_attribution.read.own`, `pic_fee.read.own`, `report.export.own_pic_fee`.
- The platform `PIC` role's own-permission map (~line 638) = `order.read.own`, `payment.read.own`, `pic_attribution.read.own`, `pic_fee.read.own`, `report.export.own_pic_fee`, `ticket.read.own`, `ticket.issue.own`, `refund.request.own`.

**There is no own-scope permission for initiating a payout.** A write cannot honestly ride on `pic_fee.read.own` (§25 decision).

### 6.2 How the authenticated PIC is identified

`PICProfile.userId` is `@unique`. `requireMyPic(userId, permissions)` (`lib/pic/self-service.ts`) enforces, in order:
1. `requireAuth()` → session scope;
2. **identity**: `scope.userId === userId` (the argument is a routing key, never authority; a forged id → `PIC_ACCESS_DENIED`);
3. **profile**: an ACTIVE `PICProfile` for the session user with `user.disabledAt = null` (else `NOT_FOUND`, 404-masked);
4. **own-scope permissions** via `decideOwnResourcePermission`.

### 6.3 Isolation and negative guarantees (verified)

| Claim | Mechanism |
|---|---|
| PIC sees only own earnings | every self-service read filters `where: { picProfileId }` derived from the session profile; service accepts **no** `picProfileId` parameter |
| PIC can only request against own earnings | **no request path exists**; when added it must use the same guard (not the existing operator service) |
| Cannot name another PIC id | no self-service function accepts one; `userId` mismatch → `PIC_ACCESS_DENIED` |
| Tenant/organizer isolation | operator routes use `requireOrganizerAccess(row.organizerId, perm)`; `resolveOrganizerFilter` refuses forged `organizerId` as 404 |
| Direct URL cannot bypass ownership | `/dashboard/pic` re-checks; `/dashboard/settlements` requires `canManageSettlements` (not a PIC capability) and its services re-authorize |
| PIC cannot approve own payout | PIC holds no `settlement.*` permission; no PIC route exists |
| PIC cannot mark own payout PAID | same |
| Admin/organizer correctly scoped | `ADMIN_GRANT_REQUIRED` includes `settlement.approve` (D-19 grant policy); MANAGER may prepare but not approve |

---

## 7. Existing Payout APIs / UI

**APIs**
| Route | Method | Purpose | Authorization |
|---|---|---|---|
| `/api/organizer/settlements` | GET | tenant-scoped list | `settlement.prepare` |
| `/api/organizer/settlements` | POST | prepare DRAFT | `settlement.prepare` + CSRF |
| `/api/organizer/settlements/[id]` | GET | detail + items | `settlement.prepare` on row tenant |
| `.../[id]/submit` | POST | DRAFT→PENDING_APPROVAL | `settlement.prepare` |
| `.../[id]/approve` | POST | →APPROVED | `settlement.approve` + SoD |
| `.../[id]/paid` | POST | record transfer →PAID | `settlement.approve` + SoD + proof + reference |
| `.../[id]/fail` | POST | APPROVED→FAILED | `settlement.approve` |
| `.../[id]/cancel` | POST | DRAFT/PENDING→CANCELLED | `settlement.prepare` |
| `.../[id]/proof` | POST | upload evidence | `settlement.proof.upload`, APPROVED only |
| `.../[id]/proof/[fileName]` | GET | serve evidence | `settlement.proof.upload` + basename guard |

**UI** — operator worklist `/dashboard/settlements` (+ detail `[id]`), `SettlementPrepareForm`, `SettlementActions` (shadcn `Dialog`, no native prompts). PIC-facing: read-only "Pencairan" card only.

**Gaps for self-service**: no PIC-request endpoint, no PIC-request UI, no review/reject queue action keyed to a PIC request, no PIC-visible rejection reason, no notification.

---

## 8. Financial and Concurrency Invariants

| Risk | Existing protection | Where |
|---|---|---|
| payout > available balance | `selectSettlementItems` excludes fully-clawed-back items; prepare refuses `items.length === 0 \|\| net ≤ 0` | `settlement.ts` |
| two concurrent requests consuming same fee | `SettlementItem.picFeeLedgerId @unique` (one ledger row settled once) + CAS `updateMany` + `withContentionRetry` | schema + `settlement.ts` |
| duplicate payout / duplicate window | `@@unique([payeeType, picProfileId, periodStart, periodEnd])` and the organizer variant; P2002 replay returns the existing row | schema + `createPreparedSettlement` |
| payout of already-settled fees | eligibility filter `settlementId: null` on EARNED rows | `selectSettlementItems` |
| payout of refunded/reversed fees | per-item net = EARNED − Σ unclaimed reversals; full claw-back excluded; carried post-paid claw-backs netted whole-or-nothing | `selectSettlementItems` |
| refund lands after prepare, before paid | paid-time re-check → `NEW_REVERSAL_DETECTED` refusal | `markSettlementPaid` |
| refund while "PROCESSING" | N/A — there is no PROCESSING state; only `APPROVED` may be paid | enum |
| PAID without transfer evidence | `PROOF_REQUIRED` (proof must be recorded on APPROVED) | `markSettlementPaid` |
| amount manipulation | validation accepts no amounts/status/bank; all derived server-side | `settlement/validation.ts` |
| cross-PIC payout | all reads/writes scoped by row's `picProfileId` + authorization on row tenant | service |
| cross-organizer payout | `requireOrganizerAccess(row.organizerId, …)`; forged tenant → 404 | service |
| ledger append-only | no amount-editing `update`/`delete`; only claim-state flips | grep-verified |

**Note for the future feature:** a PIC-requested payout that accepts a **client-specified amount** would introduce a *new* risk class (check-then-write) unless it is expressed as a claim over specific unsettled ledger rows inside one transaction (the existing model already does this safely). The audit therefore recommends **not** accepting a free amount.

---

## 9. PIC Self-Service Payout Gaps (exact)

1. No PIC own-scope payout-request permission or mutation path.
2. No API endpoint where a PIC can create a payout request.
3. No UI control/dialog for "Ajukan Pencairan" (no native prompt convention exists; shadcn `Dialog` required).
4. `Settlement` has **no REQUESTED/PENDING-by-PIC** lifecycle state and no **REJECTED** terminal state with a PIC-visible reason; `PENDING_APPROVAL` is a post-operator-submit state.
5. Amount semantics conflict: existing model is window-derived, target flow is amount-requested (§4.3).
6. Creator/SoD model conflict: `preparedByUserId` is an operator tenant member; a PIC is neither.
7. `organizerId` is mandatory on a PIC settlement; target flow does not say which tenant a cross-tenant PIC requests from.
8. PIC cannot view or maintain bank destination (§5) — create-time/admin-only.
9. No PIC-visible rejection reason or notification on a refused payout.
10. `getMySettlements`/`listMySettlements` returns only closed/history rows; there is no "pending request" read for the PIC.

---

## 10. PART B — Current QR Scanner Architecture

**Component**: `components/organizer/TicketScanner.tsx` (1301 lines, `"use client"`).
**Page**: `app/dashboard/events/[id]/check-in/page.tsx` — server-authorized by `requireEventCheckInAccess`, renders `<TicketScanner/>` only when `isEventCheckInOpen` is true.
**Backend**: `POST /api/organizer/events/[id]/check-in` → `lib/ticketing/checkin/service.ts#checkInTicket`; validation `lib/ticketing/checkin/validation.ts` (`code` free text ≤120, strict body).

**Exact flow**:

```
camera  → navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:"environment"}}, audio:false})
        → <video> attached (muted, playsInline) + video.play() + waitForVideoReady()
        → requestAnimationFrame loop
        → new BarcodeDetector({formats:["qr_code"]}).detect(video)
        → barcodes[0].rawValue
        → sanitizeScannedPayload(raw)            (strips control chars, trims, caps 128)
        → throttle (SAME_QR_COOLDOWN_MS = 1500) suppresses the same payload in-frame
        → POST /api/organizer/events/[id]/check-in  { code: payload, gateLabel }
        → server normalizeCode() strips "TICKET:" prefix → resolve Ticket by ticketCode
        → authorization + gate window + FOR UPDATE + open-refund gate + CAS → CheckIn row
        → result classified by scanFeedbackFor() → UI badge
```

**Manual fallback** already exists: the "Kode tiket (manual)" field + gate-label field, posting the same payload (keyboard-wedge scanners included).

**Diagnostics panel** shows only capability booleans (safe context, camera API, getUserMedia, BarcodeDetector, resolution, state) — never the payload, code, token or cookie.

---

## 11. BarcodeDetector Compatibility Problem

`startScanner()` aborts the whole camera when the **decode API** is missing:

```
if (!environmentFailure(...)) {        // secure context + mediaDevices + getUserMedia
    const DetectorCtor = window.BarcodeDetector;
    if (!DetectorCtor) {
        setFailure(NO_DETECTOR_FAILURE);  // ← the user's message
        setState("error");
        return;                           // camera never starts
    }
}
```

`NO_DETECTOR_FAILURE` copy: *"QR scanner kamera tidak didukung browser ini"* / *"Browser ini tidak menyediakan BarcodeDetector. Gunakan kolom kode manual di bawah."* — this is the exact string the user reported.

**Browser matrix (compatibility, not permission):**

| Browser / OS | `BarcodeDetector` | Result today |
|---|---|---|
| Chrome/Edge on Android, ChromeOS, macOS | present | camera scanning works |
| Chrome/Edge desktop on **Windows/Linux** | generally **absent** (platform backend not shipped) | **hard failure** — the reported case |
| Firefox (all platforms) | absent | hard failure |
| Safari / iOS WebKit | absent | hard failure |

The failure is **decode-API support**, not camera permission and not the webcam. `getUserMedia` works on all of the above (camera is already delegated via `Permissions-Policy: camera=(self)` in `next.config.ts`, and HTTPS/localhost is required). A **laptop webcam is not unsupported** — only the decode step is.

---

## 12. Candidate Scanner Architecture

Keep the component's shape and the backend untouched; replace only the **decode provider** with a layered strategy:

1. **`BarcodeDetector`** when present (current, fastest, zero bundle cost).
2. **A JS decoder fallback** when absent — decode an off-screen canvas frame (`drawImage(video)` → `ImageData`) with an in-browser library.
3. **Image upload** (optional) — decode a user-selected screenshot/photo through the same decoder.
4. **Manual code** — already present, unchanged.

All four converge on the same `TICKET:<ticketCode>` string and the same existing `checkIn()` POST. The loop, throttle, diagnostics, cooldown, network backoff and cleanup logic are provider-agnostic and stay.

---

## 13. html5-qrcode Evaluation (and the existing dependency reality)

**Current dependencies** (`package.json`): only `qrcode` and `qrcode.react` — both are **QR generators**, not decoders. There is **no** decoder dependency (`jsqr`, `@zxing/*`, `html5-qrcode`, `quagga`, `instascan`, `react-qr-reader` are all absent; pinned by static guards in `__tests__/ticketing-checkin/scan-wiring.test.ts` and `wallet-qr-presentation.test.ts`).

| Criterion | `html5-qrcode` |
|---|---|
| Laptop webcam | Supported; enumerates devices, defaults to environment/rear where possible, works with built-in laptop cams |
| Chrome / Edge | Supported (uses `BarcodeDetector` when available, otherwise its own decoder) |
| Firefox / Safari | Supported via its bundled decoder |
| Mobile browsers | Supported (rear-camera preference) |
| QR image/file scan | Built-in `scanFile` / file-based API — image-upload fallback is practical |
| Camera permission handling | Provides error callbacks; but it **owns** the camera lifecycle, which would duplicate/compete with the existing `releaseCamera()`/visibility logic |
| Cleanup / unmount | Requires explicit `stop()`/`clear()`; integration must hook the existing unmount effect |
| SSR / Next.js | Browser-only; must be dynamic-imported inside a `"use client"` component (already is) to avoid SSR evaluation |
| Bundle impact | Notably larger than a minimal decoder; pulls a full scanning UI framework |
| TypeScript | Ships its own typings |
| Security | All decode is local in-browser; no network call; no payload persistence — compatible with the current privacy contract |
| Maintenance | Historically slower-moving; last significant release years old (verify at install time) |

**Assessment:** `html5-qrcode` is *workable* but heavier than needed, and it wants to manage the camera itself, which conflicts with the scanner's carefully-built acquisition/cleanup pipeline. A **minimal frame decoder** (e.g. `jsqr`, pure/isomorphic and small, decoding canvas `ImageData`) integrates with the *existing* `detect(video)` loop with less surface area. **Recommendation: prefer a minimal decoder feeding the existing loop; if the team prefers a batteries-included scanner UI, `html5-qrcode` is the fallback choice.** Library selection is an **owner decision** and the dependency must not be installed during this audit (none was).

---

## 14. QR Security / D-46 Preservation

- Payload stays **exactly** `TICKET:<ticketCode>` (`lib/ticketing/tickets/reference.ts#buildTicketQrPayload`, `assertQrPayloadIsSafe`). **Unchanged.**
- Backend `normalizeCode()` strips the `TICKET:` prefix and validates the ticket-code shape; the scanner only supplies the string.
- Raw `qrToken`/`qrTokenHash` are **never** delivered to, read by, or logged by the client; `CheckInMethod` stays `MANUAL`; `QR_SCAN` remains unused (P14-D17 / D-46 ratified).
- No new storage/logging of decoded payloads; throttle map is in-memory and short-lived.
- Authorization/admission decisions remain **server-only** (D-46: "QR is NOT authorization").
- Do not introduce a public ticket page or a URL payload.

---

## 15. Camera / Image / Manual Fallback Design

```
Level 1 CAMERA  : BarcodeDetector → JS decoder fallback; existing loop/throttle/cleanup
Level 2 IMAGE   : file/screenshot input → decode off a canvas → same payload → same POST
Level 3 MANUAL  : existing code field (also keyboard-wedge scanners)
```

All three produce the identical `TICKET:<ticketCode>` (or bare code) and call the identical endpoint. Camera denial (`NotAllowedError`, etc.) must surface the existing `describeCameraError` message and leave Image/Manual fully usable — never a dead end.

---

## 16. Check-in Backend Preservation (verified unchanged)

`checkInTicket` already enforces, server-side, everything the scanner input cannot affect:

- **Tenant + event authorization**: `requireEventCheckInAccess` → `requireOrganizerAccess(event.organizerId, checkin.scan)`; a `CHECKIN_STAFF` without `checkin.override` additionally needs an active `StaffEventAssignment`; forged event id → 404.
- **Gate lifecycle**: `isEventCheckInOpen(gate, now)` (no `startAt` term; cancelled/archived/grace-expired close it).
- **Refund pending gate**: `OPEN_REFUND_STATUSES = [PENDING, APPROVED, PROCESSING]` → `REFUND_PENDING` refusal.
- **Duplicate admission**: `SELECT … FOR UPDATE` on the ticket + CAS `ISSUED → CHECKED_IN` + UNIQUE `CheckIn.ticketId`.
- **Wrong-event / unknown-code** masked as `NOT_FOUND`/`WRONG_EVENT`.
- **Audit trail**: accepted and rejected attempts both write `CheckIn`/audit rows.

Nothing here changes; the scanner is a client-side input device only.

---

## 17. Existing Tests

**Payout / PIC**
- `__tests__/ticketing-pic/settlement.integration.test.ts` (16 tests), `settlement-carried-reversal.integration.test.ts`
- `__tests__/pic-self-service/{entry,ownership,reporting}.integration.test.ts`, `menu.test.ts`, `menu-navigation-regression.test.ts`
- `__tests__/ticketing-pic/{pic-wiring,pic-checkout.integration,admin-pic-totals.integration,pic-reporting.integration,pic-csv}.test.ts`
- `__tests__/ticketing-ui/refund-settlement-dialogs.test.ts`

**Scanner / check-in**
- `__tests__/ticketing-checkin/camera-pipeline.test.ts` (env detection, failure mapping, static `BarcodeDetector` assertions)
- `__tests__/ticketing-checkin/scanner-loop.test.ts` (throttle, sanitize, no decoder package)
- `__tests__/ticketing-checkin/scan-wiring.test.ts` (no library import, only-native decode assertion)
- `__tests__/ticketing-checkin/check-in-wiring.test.ts`, `check-in.integration.test.ts`, `check-in-refund-gate.integration.test.ts`
- `__tests__/ui-consolidation/checkin-gate.test.ts`, `__tests__/ticketing-issuance/qr-payload-contract.test.ts`, `__tests__/ticketing-ui/wallet-qr-presentation.test.ts`

**Note:** static guards currently **assert that no decoder library is imported** (`expect(source).not.toMatch(/import .*(zxing|jsqr|barcode)/i)`). Adding a fallback decoder will require **updating those guards** deliberately, not deleting them.

---

## 18. Missing Tests

**PIC self-service payout (future):**
1. PIC sees own available balance. 2. PIC cannot see another PIC's balance. 3. PIC can request ≤ available (settleable). 4. Cannot request > available. 5. Two concurrent requests cannot consume the same fee twice. 6. Refund/reversal cannot create overpayment. 7. PIC cannot approve own request. 8. PIC cannot mark own request PAID. 9. Admin/organizer can review an eligible request. 10. Transfer evidence required before PAID. 11. Transfer reference required before PAID. 12. Failed transfer does not destroy available money. 13. Cross-tenant access returns safe 404/denial.

**Scanner (future):**
1. Camera loads when supported. 2. BarcodeDetector absence does not disable scanning (fallback decodes). 3. Laptop webcam selectable. 4. `TICKET:<ticketCode>` decoded. 5. Invalid payload rejected. 6. Raw `qrToken` never exposed. 7. Manual fallback still works. 8. Image-upload fallback works if added. 9. Camera cleanup on unmount/navigation. 10. Permission denial yields usable fallback UI. 11. Check-in backend unchanged. 12. Existing authorization/admission rules unchanged.

---

## 19. Exact Files That Would Need Modification

**PART A (illustrative, subject to owner decisions)**
- `prisma/schema.prisma` (only if a new state/permission model is required — see §20)
- `lib/authz/permissions.ts` (+ `__tests__/authz/*`) if a new own-scope key is added
- `lib/pic/self-service.ts` (read + new request mutation) and/or a new `lib/ticketing/settlement/request.ts`
- `lib/ticketing/settlement/{service,settlement,validation,payload}.ts` (initiation + a PIC-visible reason/state)
- `app/api/pic/payouts/route.ts` (new) or `app/api/organizer/settlements/...` extension
- `app/dashboard/pic/page.tsx` + `components/dashboard/SettlementActions.tsx`/a new request dialog
- `app/dashboard/settlements/**` (review queue), `components/dashboard/DashboardAppShell.tsx` (nav if any)
- `lib/ui/route-inventory.ts` (if a route/page is added)
- `lib/pic/service.ts` (bank edit path if the owner chooses to allow it)

**PART B**
- `components/organizer/TicketScanner.tsx` (decode-provider layering; image upload if chosen)
- `package.json` + lockfile (decoder dependency — **owner-approved only**)
- `__tests__/ticketing-checkin/{scan-wiring,scanner-loop,camera-pipeline}.test.ts` (update "no library" guards to the new provider contract)
- Possibly `next.config.ts` only if CSP needs adjustment (unlikely; decode is local)

---

## 20. Prisma / Schema Changes Required

**PART A** — depends on the owner's chosen model:
- Option 1 (extend `Settlement`): add PIC-request lifecycle values (`REQUESTED`, `REJECTED`) to `SettlementStatus` and a nullable `requestedByUserId`/`rejectionReason`; make `organizerId`/`preparedByUserId` sourcing compatible with a PIC-authored request. **Schema change + migration.**
- Option 2 (new `PayoutRequest` entity): a separate request table referencing `PICProfile`, amount/window, status, reason, linked to a `Settlement` on approval. **Schema change + migration.**
- No schema change if the decision is "PIC cannot self-initiate" (status quo).

**PART B** — **no Prisma/schema change.** Scanner work is entirely client-side.

---

## 21. Migration Requirement

- **PART A**: a migration is required **only if** schema changes are approved (§20). Additive/expand-only is possible for values **only if** MySQL/Primsa enum alterations are handled (enums in MySQL are `ALTER TABLE … MODIFY`) — must follow the project's additive migration discipline. No data backfill needed (settlement tables are empty, see §23).
- **PART B**: **no migration.**

---

## 22. Security Risks

**PART A**
- A client-specified **amount** re-introduces check-then-write races; mitigate by expressing the request as a claim over specific unsettled ledger rows inside one transaction (never a free amount).
- A PIC-authored settlement must **not** inherit tenant `settlement.prepare` semantics or bypass `SettlementItem.picFeeLedgerId @unique`.
- SoD must be redefined: the PIC is the requester, so the approver/payer must be organizer/finance staff — the PIC must never approve or pay their own request (no PIC `settlement.*` capability exists today; keep it that way).
- Bank snapshot/privacy: if a PIC-editable bank path is added, masking and create-only discipline must be preserved and the change audited.
- Cross-tenant aggregation: a PIC earning in two tenants must not have one request settle another tenant's ledger rows without an explicit tenant binding.

**PART B**
- Adding a decoder must not widen the payload contract, expose `qrToken`, or move any admission decision client-side.
- Image upload must validate/size-limit the file and decode locally (no server upload of QR images), and must not log the payload.
- Bundle/SSR: dynamic-import the decoder to avoid SSR evaluation; ensure camera tracks are stopped on unmount/navigation.

---

## 23. Deployment Considerations

- Application is **NOT DEPLOYED**; `AUTH_URL`/`NEXT_PUBLIC_APP_URL = http://localhost:3000`; no crontab/systemd/PM2 running; `joblock` empty.
- Camera requires a **secure context** in production (HTTPS) or `localhost`; the existing `Permissions-Policy: camera=(self)` already covers the scanner.
- Known current DB state (per prior audits, not re-queried here): `settlement=0`, `settlementitem=0`, `picfeeledger=0`, `picattribution=0`, `refunditem=0`, `eventorder=20`, `refund=6` (legacy orphans). Any new PIC payout feature has **no existing rows to migrate or corrupt**.
- No scheduler dependency is introduced by either vertical.

---

## 24. Recommended Minimal Implementation

**PART A (after owner decisions)** — smallest safe change:
1. Keep the operator `Settlement` accounting/proof/paid engine **unchanged**.
2. Add a **PIC-initiated request** that (a) is authorized by a **new own-scope permission** (e.g. `pic_payout.request.own`) plus `requireMyPic`, (b) is expressed as a **claim over the PIC's own unsettled EARNED rows** (no free amount, or an amount validated against the canonical `ΣCREDIT − ΣDEBIT` at request time **and** re-validated transactionally on approval/payment), (c) inserts a request row/state that the existing operator approval + manual-transfer + evidence + PAID flow consumes, and (d) shares `SettlementItem.picFeeLedgerId @unique` and the paid-time re-check so concurrency is a DB property.
3. Add the "Ajukan Pencairan" control to the self-service "Pencairan" card (shadcn `Dialog`, no native prompts), and a PIC-visible status/rejection reason.
4. If the owner chooses to let the PIC maintain the destination, add a guarded PIC bank-edit path with masking preserved.

**PART B** — smallest change:
1. In `startScanner()`, do **not** abort when `BarcodeDetector` is absent; select a decode provider (`BarcodeDetector` if present, else the JS decoder).
2. In `tick()`, if using the fallback, draw the video frame to an off-screen canvas and decode; keep the existing throttle/backoff/in-flight guards.
3. Add an image-upload fallback reusing the same decoder (optional but recommended for the three-level UX).
4. Update the static "no decoder package" guards to the new provider contract intentionally.
5. Do **not** change the endpoint, payload, method or admission logic.

---

## 25. Owner Decisions Required

**PART A**
1. **Initiation model**: extend `Settlement` (new states) vs a separate `PayoutRequest` entity vs declare self-initiation out of scope.
2. **Amount semantics**: PIC-specified amount (conflicts with the current period-window model) vs PIC selects a period/window and the server derives the amount (matches existing engine). *The audit recommends the latter to preserve concurrency safety.*
3. **Permission**: add a new own-scope key (recommended) vs reuse an existing one (rejected — a write under `pic_fee.read.own` is dishonest).
4. **Tenant binding**: does a PIC request target one organizer, or aggregate across tenants? (Existing PIC settlements are per-organizer.)
5. **Separation of duties**: define requester vs approver vs payer when the PIC is the requester (PIC must not approve/pay).
6. **Lifecycle states**: introduce `REQUESTED`/`REJECTED` (with PIC-visible reason) or reuse `DRAFT`/`CANCELLED`?
7. **Bank data**: allow PIC self-service bank edit (currently create-time/admin-only), or keep admin-managed?
8. **Available-balance definition to enforce**: canonical `ΣCREDIT − ΣDEBIT` vs the windowed *settleable* amount (§3.4 discrepancy). These differ; the request validation must pick one.
9. **Operator rejection UX**: where does the admin review/approve/reject a PIC request (settlement queue vs new inbox)? Notifications?
10. **Partial payouts**: may a PIC request less than full settleable? (Existing engine settles whole items/net, no partial.)

**PART B**
11. **Decoder approach**: minimal JS decoder driving the existing loop (recommended) vs `html5-qrcode` (heavier, manages the camera itself). Approval is required to add a dependency.
12. **Image upload**: include the file/screenshot fallback now, or camera+manual only?

---

## 26. Final Verdict

### PIC PAYOUT: **BLOCKED — OWNER DECISION REQUIRED**

The money engine, ledger, proof storage and operator lifecycle are sound and reusable, and there is **no existing architecture defect** in them. The blocker is that the **target business flow conflicts with the current domain's semantics** in four load-bearing ways (amount-derived-vs-amount-requested, creator is a tenant member vs a PIC, per-tenant vs aggregate, and SoD definition), plus there is **no PIC own-scope capability** and **no PIC-maintainable bank destination** (an existing architecture gap). These are product/authorization decisions — none can be settled silently.

### QR SCANNER: **READY FOR IMPLEMENTATION**

The scanner's only compatibility defect is a **hard dependency on `BarcodeDetector`**, which is absent on Firefox, Safari and desktop Chrome on Linux/Windows. The camera pipeline, the payload (`TICKET:<ticketCode>`, D-46) and the entire check-in backend are correct and must stay unchanged. Implementation is a client-side decode-provider fallback plus (optionally) an image-upload fallback, with one owner decision: **approve adding a decoder dependency** (minimal decoder recommended over `html5-qrcode`).

### OVERALL: **BLOCKED — OWNER DECISION REQUIRED**

The combined phase cannot proceed to implementation until the PIC payout decisions in §25 are made. The QR scanner vertical is independently ready.

---

## Files Inspected (representative, read-only)

`prisma/schema.prisma` (PICProfile/PICEventAssignment/PICAttribution/PICFeeLedger/Settlement/SettlementItem + enums) · `lib/pic/{ledger,fee,validation,self-service,service,attribution}.ts` · `lib/ticketing/settlement/{service,settlement,payload,validation,proof}.ts` · `lib/ticketing/refunds/settlement.ts` · `lib/authz/permissions.ts` · `lib/ui/route-inventory.ts` · `app/dashboard/pic/page.tsx` · `app/dashboard/settlements/page.tsx` · `components/dashboard/SettlementActions.tsx` · `app/api/admin/pic/route.ts` · `app/api/admin/pic/[id]/route.ts` · `app/api/organizer/pic/route.ts` · `app/api/organizer/pic/[id]/route.ts` · `app/api/organizer/settlements/route.ts` · `app/api/organizer/settlements/[settlementId]/route.ts` · `.../approve/route.ts` · `.../paid/route.ts` · `components/organizer/TicketScanner.tsx` · `app/dashboard/events/[id]/check-in/page.tsx` · `app/api/organizer/events/[id]/check-in/route.ts` · `lib/ticketing/checkin/{service,validation}.ts` · `lib/ticketing/tickets/reference.ts` · `next.config.ts` · `package.json` · `components/dashboard/DashboardAppShell.tsx` (via search) · test files listed in §17 · prior reports `PIC_PAYOUT_SETTLEMENT_DEEP_AUDIT_REPORT.md`, `PHASE_29A/PIC_PAYOUT/PHASE_20A` docs (referenced, not modified).

## Tests Run

**None.** This is an audit-only pass; no Jest suite, typecheck, lint or build was executed, to avoid any database side effects from integration suites. Existing tests were **inspected** (§17), not executed.

## DB Queries Run

**None.** No MySQL/Prisma query was issued. The current runtime DB state is already documented by prior audits (`settlement=0`, `settlementitem=0`, `picfeeledger=0`, `picattribution=0`, `refunditem=0`) and was not needed to reach the verdicts. A read-only `git status --porcelain` and `git diff --check` were run: both clean.

## Change Confirmations

```
SOURCE CHANGED:      NO
SCHEMA CHANGED:      NO
DATABASE DATA CHANGED: NO
DEPENDENCIES CHANGED:  NO
MIGRATIONS CREATED:    NO
COMMIT:                NO
PUSH:                  NO
RESET/REBASE:          NO
```

The only file created is this audit report. All pre-existing working-tree state was left exactly as found.

---

**AUDIT VERDICT (PIC PAYOUT): BLOCKED — OWNER DECISION REQUIRED**
**AUDIT VERDICT (QR SCANNER): READY FOR IMPLEMENTATION**
**OVERALL: BLOCKED — OWNER DECISION REQUIRED**
