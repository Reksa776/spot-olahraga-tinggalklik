# PHASE 21 — PIC SELF-SERVICE PAYOUT + QR SCANNER COMPATIBILITY

## IMPLEMENTATION REPORT

**Verdict: PHASE 21 COMPLETE.**

Both verticals are implemented and verified. All source/schema/migration changes are additive
and non-destructive; the change was **not** committed or pushed; no database was reset or
dropped.

---

## A. Initial audit findings

The prior pass produced `PHASE_21_PIC_PAYOUT_AND_QR_SCANNER_AUDIT.md`. Its load-bearing findings:

- **PIC payout** — the PIC dashboard (`app/dashboard/pic/page.tsx`, third branch) was **read-only**.
  The `Settlement` engine (claim lines, manual transfer, proof, provider reference, SoD) existed
  but was **operator-initiated and period-window-derived**, with the amount never client-supplied.
  Verdict: **BLOCKED — OWNER DECISION REQUIRED** (amount semantics, creator identity, per-tenant vs
  aggregate, and SoD definition all conflicted with a PIC-initiated flow), plus a real architecture
  gap: PIC bank data was create-time/admin-only.
- **QR scanner** — `components/organizer/TicketScanner.tsx` **hard-aborted** when
  `window.BarcodeDetector` was absent (Firefox, Safari, desktop Chrome on Linux/Windows) — the exact
  user-reported message. The camera, the payload (`TICKET:<ticketCode>`, D-46) and the check-in
  backend were all correct. Verdict: **READY FOR IMPLEMENTATION**.

Those conflicts are now settled by the owner's locked decisions (below), so implementation proceeded.

---

## B. PIC payout decisions implemented

Every locked decision is now code:

| # | Decision | Where it lives |
|---|---|---|
| 1 | PIC may initiate their own payout request | `lib/pic/payout.ts#createMyPicPayoutRequest`, `app/api/pic/payouts/route.ts` |
| 2 | New own-scope permission `pic_payout.request.own` | `lib/authz/permissions.ts` (`PERMISSIONS`, `OWN_SCOPE`, PIC own-map) |
| 3 | Own-scope only; identity from `requireMyPic`; no client `picProfileId` | `lib/pic/payout.ts` (accepts no profile id; uses the session's ACTIVE profile) |
| 4 | Bound to ONE organizer; no aggregation | `createMyPicPayoutRequest({ organizerId })`; one row per tenant |
| 5 | PIC requests the settleable fee; **no free-form amount** | the request body carries `organizerId` + optional `notes` only (`picPayoutRequestSchema`, `.strict()`) |
| 6 | Amount derived server-side from the existing settleable ledger items | `createPreparedSettlement(..., origin: "PIC_REQUEST")` → `selectSettlementItems` |
| 7 | No second accounting engine; reuse `Settlement`/`SettlementItem` | same core, same `SettlementItem.picFeeLedgerId @unique` |
| 8 | PIC can never approve / pay / upload payer proof / bypass operator auth | PIC holds no `settlement.*`; SoD is author ≠ approver ≠ payer; the PIC is the author |
| 9 | Operator approval/payment stays SoD-controlled | `approveSettlement` / `rejectSettlement` in `lib/ticketing/settlement/service.ts` |
| 10 | Rejection requires a PIC-visible reason | `rejectSettlementSchema`, `Settlement.rejectionReason`, surfaced in the PIC dashboard |
| 11 | PIC history shows REQUESTED/APPROVED/REJECTED/PAID/FAILED | `listMyPicPayoutRequests`, PIC "Pencairan" card |
| 12 | Bank destination stays admin/operator managed | no PIC bank edit added; bank is snapshotted from the profile at request time |
| 13 | Manual transfer + proof + `providerReference` requirements unchanged | `markSettlementPaid` untouched |
| 14 | Existing payout money invariants unchanged | `selectSettlementItems`, paid-time re-check, ledger flips all untouched |
| 15 | No automatic refund/issuance/reconciliation | nothing added |

**Design choice (Part A1/A2).** Extending `Settlement` — rather than a separate `PayoutRequest`
entity — was selected because the brief requires `SettlementItem.picFeeLedgerId @unique` to be the
financial claim/concurrency boundary, and `SettlementItem.settlementId` is NOT NULL: a claim can
only exist under a `Settlement` row. Adding two lifecycle values plus rejection columns is the
smallest model change that reuses the whole money engine. The PIC-authored claim is created
directly as `REQUESTED` (no `DRAFT`/`PENDING_APPROVAL` walk), and `preparedByUserId` is the PIC's
user id, so the existing SoD check (`preparedByUserId === actor.userId`) automatically lets
operators approve/pay while the PIC can never self-approve.

---

## C. Data model changes (additive only)

`prisma/schema.prisma`:

- `enum SettlementStatus` — appended `REQUESTED`, `REJECTED` (existing values and the `DRAFT`
  default untouched).
- `model Settlement` — three nullable, NULL-default columns: `rejectedByUserId String?`,
  `rejectedAt DateTime?`, `rejectionReason String? @db.Text`, plus the `rejectedBy` relation.
- `model User` — the matching `settlementsRejected Settlement[] @relation("SettlementRejectedBy")`.

**No PICProfile change; no new table.**

---

## D. API routes

| Route | Method | Purpose | Authority |
|---|---|---|---|
| `/api/pic/payouts` | GET | the PIC's own requests (bank masked) + per-tenant settleable amounts | `requireMyPic(..., pic_payout.request.own / pic_fee.read.own)` |
| `/api/pic/payouts` | POST | create a payout request for ONE organizer | `requireMyPic(..., pic_payout.request.own)` + CSRF |
| `/api/organizer/settlements/[settlementId]/reject` | POST | refuse a `REQUESTED` request with a required reason | `settlement.approve` on the row's tenant + SoD + CSRF |

`POST /api/organizer/settlements/[settlementId]/approve` now also accepts a `REQUESTED` row (the
operator review of a PIC request converges on `APPROVED` through the existing route).

Both new routes are classified in `proxy.ts` (`/api/pic/` added to `PROTECTED_API_PREFIXES`;
`/api/organizer/` already covered), so the route-classification suite stays green.

**Request body (POST /api/pic/payouts):** `{ organizerId, notes? }` only — no amount, no status,
no bank, no `picProfileId`; strict schema strips anything else.
**Response:** a safe payload (`id`, `settlementNumber`, `status`, `organizerName`, period,
gross/deduction/net as fixed 2-decimal strings, masked bank, `providerReference`,
`rejectionReason`, `rejectedAt`, `paidAt`, `createdAt`).

---

## E. Authorization

- New own-scope key `pic_payout.request.own`, added to `OWN_SCOPE` (so the scope decider resolves
  it) and to `PLATFORM_ROLE_OWN_PERMISSIONS.PIC` — held by **no other role**.
- Every PIC function funnels through `requireMyPic`: `requireAuth()` → identity
  (`scope.userId === userId`, forged id = `PIC_ACCESS_DENIED`) → ACTIVE profile with an enabled
  account (`NOT_FOUND` otherwise) → `decideOwnResourcePermission` for the family.
- The PIC's `picProfileId` is **never** accepted from the client; it comes from the session profile.
- Operator review uses `requireOrganizerAccess(row.organizerId, PERMISSIONS.SETTLEMENT_APPROVE)`
  against the **row's own** tenant (a forged tenant is a 404).
- **Separation of duties**: `approveSettlement`, `rejectSettlement` and `paySettlement` all refuse
  when `preparedByUserId === actor.userId`. The PIC is the author, and holds no `settlement.*`
  capability, so the PIC can never approve, reject, pay or upload payer proof.

A CUSTOMER role that owns an ACTIVE profile is `FORBIDDEN` on the new permission (identity is not a
role escape hatch) — covered by test.

---

## F. Concurrency / money invariants

- A request claims ledger rows transactionally through `createPreparedSettlement` →
  `selectSettlementItems`, inserting `SettlementItem` rows under the existing
  **`SettlementItem.picFeeLedgerId @unique`** boundary. Two concurrent requests cannot consume the
  same fee; the loser is surfaced as a safe `CONFLICT` (`ALREADY_CLAIMED`) instead of a 500.
- The amount is always the server-computed settleable net (unsettled in-window EARNED minus their
  offsetting reversals, including carried post-paid claw-backs) — never a client value.
- A second request with nothing left to claim is refused (`NOTHING_SETTLEABLE`).
- The paid-time **`NEW_REVERSAL_DETECTED`** re-check and the **proof + providerReference**
  requirements are untouched. A reversal reduces the settleable amount (no overpayment).
- A rejected request releases its claim lines in the same transaction, so the fee becomes
  requestable again — no money moved, because a `REQUESTED` row was never approved.

---

## G. PIC UI

`app/dashboard/pic/page.tsx` (self-service branch) + new `components/dashboard/PicPayoutRequestDialog.tsx`:

- A "Saldo yang dapat dicairkan" block, **per organizer**, from
  `listMyPicSettleableOrganizers` (the money engine's own `previewSettleable`) — labelled honestly
  so it is not confused with the whole-ledger canonical net.
- An **"Ajukan Pencairan"** button opening a shadcn `Dialog` (no native prompt), where the PIC picks
  the organizer, sees the server-derived amount (read-only), adds an optional note, and confirms.
- The "Pencairan" history table shows **REQUESTED / APPROVED / REJECTED / PAID / FAILED**, the
  organizer, the requested amount, the masked destination, and the paid date; a **rejection reason**
  panel renders reasons for REJECTED rows.
- No other PIC's data is reachable (own-scope reads only); no raw bank number is ever rendered.

---

## H. Operator review UI

- `/dashboard/settlements` list and `/dashboard/settlements/[id]` detail gained `REQUESTED`
  (pending) and `REJECTED` (error) status tones; the detail page renders the rejection reason
  (marked "terlihat oleh PIC").
- `components/dashboard/SettlementActions.tsx` renders **Setujui** / **Tolak** for a `REQUESTED`
  settlement. "Tolak" opens a required-reason dialog (`rejectPayout` kind in
  `manual-transfer-dialog.ts`) posting to the new reject route. The existing APPROVED → proof →
  Tandai dibayar → Gagalkan flow is unchanged.
- The operator discovers PIC requests in the **existing** settlement worklist — no second financial
  dashboard was created.

---

## I. QR decoder architecture

`components/organizer/TicketScanner.tsx`:

- A new `DecodeMode = "native" | "jsqr"`. On start, the detector is chosen per session:
  `BarcodeDetector` (with its `{formats:["qr_code"]}` + no-arg fallback) when constructible,
  **jsQR otherwise**. A missing native detector **no longer aborts the camera**.
- New pure helper `decodeFrameWithJsQr(video, canvas)`: draws the current frame to a reused
  off-screen canvas, reads `ImageData`, runs `jsQR(...)`, and returns `null` (never throws) for an
  unusable frame.
- The detection loop branches on the mode (`decodeFrameWithJsQr` vs `detector.detect`) and feeds the
  **same** `raw` into the existing `sanitizeScannedPayload` → throttle → `checkIn` path.
- The library is a **decoder only**: it never touches `getUserMedia`, the `<video>`, the animation
  loop, the throttle, the diagnostics or the cleanup. `releaseCamera()`, visibility pause, network
  backoff and the manual fallback are unchanged.
- The diagnostics panel now shows a `Decoder` row (`NATIVE` / `JSQR`).

---

## J. Browser compatibility

- Browsers with `BarcodeDetector` (Chrome/Edge on Android/ChromeOS/macOS): native path, unchanged.
- Browsers without it (Firefox, Safari, Chrome/Edge desktop on Linux/Windows): the jsQR fallback
  decodes the same webcam frame — the **laptop webcam now scans**.
- Camera acquisition keeps `facingMode: { ideal: "environment" }` with the `{video:true}` fallback,
  so mobile rear-camera behaviour is preserved; permission errors keep their actionable messages.

---

## K. Security / D-46 preservation

- QR payload remains exactly `TICKET:<ticketCode>` (`lib/ticketing/tickets/reference.ts` untouched);
  the server still `normalizeCode`-strips the prefix.
- No `qrToken`/`qrTokenHash` exposure; no `QR_SCAN` method; no public ticket URL; no new `/api` call.
- The scanner stays a client-side **input device**; the server remains authoritative.
- Test guards now assert the intentional jsQR dependency exists and no other scanner bundle was added.

---

## L. Tests

Updated static guards (replaced, not deleted) to assert the **new** contract:
`__tests__/ticketing-checkin/{scan-wiring,scanner-loop,check-in-wiring,camera-pipeline}.test.ts`,
`__tests__/ui-consolidation/checkin-gate.test.ts`,
`__tests__/ticketing-ui/wallet-qr-presentation.test.ts` — each now requires `import jsQR from "jsqr"`
and forbids `zxing`/`html5-qrcode`/`instascan`/`quagga`.

New:
- `__tests__/ticketing-checkin/scanner-fallback.test.ts` — decodes a **real** QR bitmap through
  `decodeFrameWithJsQr`; returns `null` for zero-size/blank frames; the fallback is a decoder, not a
  camera owner; a missing `BarcodeDetector` selects the fallback (no `NO_DETECTOR_FAILURE`); camera
  lifecycle/throttle/cleanup/manual fallback and the single check-in route are preserved; no secret
  exposure.
- `__tests__/pic-self-service/payout-request.integration.test.ts` (real DB) — settleable derivation
  (EARNED − reversals, per tenant); a request is server-derived and lands `REQUESTED` without
  settling the ledger; a second request finds nothing; **two concurrent requests consume one claim**;
  a reversal reduces the amount; forged `userId` = `PIC_ACCESS_DENIED`; one PIC never sees another's
  requests; CUSTOMER role = `FORBIDDEN`; missing bank = `VALIDATION_ERROR`; foreign tenant finds
  nothing; the author can never approve/reject/pay; an operator approves and PAID still requires
  proof; an operator rejects with a reason the PIC reads, and the claim is released.

---

## M. Typecheck / lint / build

| Gate | Result |
|---|---|
| `npx prisma validate` | ✅ "The schema at prisma/schema.prisma is valid 🚀" |
| `npx prisma migrate status` | ✅ "Database schema is up to date!" (31 migrations) |
| `npx tsc --noEmit` | ✅ exit 0, no output |
| `npx eslint .` | ✅ **0 errors**, 4 pre-existing warnings (3× `no-img-element`, 1 unused var in `scripts/verify-phase33-live.js`) |
| `npx jest --runInBand` | ✅ **125 suites / 2467 tests passed** |
| `npm run build` | ✅ exit 0; `/api/pic/payouts` and `/api/organizer/settlements/[settlementId]/reject` present in `.next/routes-manifest.json` |
| `git diff --check` | ✅ clean |

---

## N. Migration status

**Migration name:** `20260927000000_add_pic_payout_requests`

**SQL inspected (additive, non-destructive):**
```sql
ALTER TABLE `settlement`
    MODIFY COLUMN `status` ENUM('DRAFT','PENDING_APPROVAL','APPROVED','PAID','FAILED','CANCELLED','REQUESTED','REJECTED') NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN `rejectedByUserId` VARCHAR(191) NULL,
    ADD COLUMN `rejectedAt` DATETIME(3) NULL,
    ADD COLUMN `rejectionReason` TEXT NULL;

ALTER TABLE `settlement`
    ADD CONSTRAINT `settlement_rejectedByUserId_fkey`
        FOREIGN KEY (`rejectedByUserId`) REFERENCES `user`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;
```

The enum is **extended** (existing values preserved, `DRAFT` default kept); the three columns are
`NULL` by default. No drop, no rename, no data rewrite, no back-fill. Applied with
`npx prisma migrate deploy` to the application DB (no reset) and the dedicated Jest database was
brought up to date with `npm run test:db:setup` (idempotent; never drops, truncates or resets).

---

## O. Remaining gaps

- **No PIC bank editing** — deliberate (decision #12); the destination stays operator-managed. A PIC
  without complete bank details cannot request and receives a clear `VALIDATION_ERROR`.
- **No camera-device picker** — deliberate. The existing rear-camera preference with the
  `{video:true}` fallback is preserved so mobile behaviour is not broken; the jsQR fallback is what
  unlocks the laptop webcam. Enumerating/choosing among multiple laptop cameras remains a possible
  future enhancement.
- **No image-upload fallback** — deliberately out of scope per brief Part B5 (kept clean without
  widening scope); camera + manual remain the two levels.
- `CameraFailureKind` retains the now-unused `"NO_DETECTOR"` member (harmless vocabulary).

---

## P. Exact files changed

**Modified**
- `prisma/schema.prisma` (enum values + 3 columns + 1 relation)
- `proxy.ts` (`/api/pic/` protected prefix)
- `lib/authz/permissions.ts` (new own-scope permission + own-map)
- `lib/ticketing/audit-log.ts` (`settlement.request`, `settlement.reject`)
- `lib/ticketing/settlement/settlement.ts` (`origin` option, approve-from-REQUESTED, `rejectSettlement`, `previewSettleable`)
- `lib/ticketing/settlement/service.ts` (`rejectSettlement`; approve reads REQUESTED)
- `lib/ticketing/settlement/validation.ts` (`REQUESTED`/`REJECTED`, `rejectSettlementSchema`, `picPayoutRequestSchema`)
- `lib/ticketing/settlement/payload.ts` (`rejectionReason`, `rejectedAt`)
- `components/organizer/TicketScanner.tsx` (jsQR fallback)
- `components/dashboard/SettlementActions.tsx` (REQUESTED review actions)
- `components/dashboard/manual-transfer-dialog.ts` (`rejectPayout` kind)
- `app/dashboard/pic/page.tsx` (settleable + request dialog + history + rejection reason)
- `app/dashboard/settlements/page.tsx`, `app/dashboard/settlements/[id]/page.tsx` (status tones + rejection reason)
- `package.json`, `package-lock.json` (`jsqr ^1.4.0`)
- `__tests__/pic-self-service/reporting.integration.test.ts`
- `__tests__/ticketing-checkin/{camera-pipeline,check-in-wiring,scan-wiring,scanner-loop}.test.ts`
- `__tests__/ticketing-ui/wallet-qr-presentation.test.ts`
- `__tests__/ui-consolidation/checkin-gate.test.ts`

**Created**
- `prisma/migrations/20260927000000_add_pic_payout_requests/migration.sql`
- `lib/pic/payout.ts`
- `app/api/pic/payouts/route.ts`
- `app/api/organizer/settlements/[settlementId]/reject/route.ts`
- `components/dashboard/PicPayoutRequestDialog.tsx`
- `__tests__/pic-self-service/payout-request.integration.test.ts`
- `__tests__/ticketing-checkin/scanner-fallback.test.ts`
- `PHASE_21_PIC_PAYOUT_AND_QR_SCANNER_AUDIT.md` (audit pass)
- `PHASE_21_PIC_PAYOUT_AND_QR_SCANNER_IMPLEMENTATION_REPORT.md` (this file)

---

## Q. Commit / push status

```
COMMIT:  NO
PUSH:    NO
RESET/REBASE/CLEAN: NO
```

Changes are present in the working tree only. No database was reset or dropped; the migration is
additive and applied; all existing uncommitted work was preserved.

---

# FINAL VERDICT

- **PIC SELF-SERVICE PAYOUT:** implemented and verified. PIC initiates an own-scope, server-derived,
  single-tenant request that reuses the existing settlement money engine; operator review with SoD;
  rejection reasons PIC-visible; all money/concurrency invariants preserved.
- **QR SCANNER:** implemented and verified. The laptop webcam scans without `BarcodeDetector` via the
  intentional jsQR fallback; D-46, the payload, the backend and the manual fallback are unchanged.

**PHASE 21 COMPLETE**
