# PIC BUSINESS FLOW — DEEP AUDIT REPORT

**Product:** TinggalKlik.Co ticketing platform
**Scope:** PIC (referrer) end-to-end flow only
**Mode:** READ-ONLY. No source modified, no migration, no DB write, no commit, no push.
**Verification:** see §18.

Legend: `[IMPLEMENTED]` = live and enforced · `[PARTIAL]` = some wiring, not reachable/complete · `[NOT WIRED]` = exists (model/UI/permission) but no active effect · `[NOT IMPLEMENTED]` = does not exist.

---

## 1. PIC DOMAIN INVENTORY

### 1.1 Prisma models (`prisma/schema.prisma`)

| Model | Line | Used by production code |
|---|---|---|
| `PICProfile` | 1358 | `lib/pic/service.ts` (full management surface) |
| `PICEventAssignment` | 1401 | `lib/pic/service.ts` (assign/revoke/read) |
| `PICAttribution` | 1432 | **NO writer, NO reader** (only `_count` in `PIC_SELECT` `service.ts:74`) |
| `PICFeeLedger` | 1471 | Readers: `service.ts:131–135` (sum), `service.ts:353–366` (detail). Writer: reversal-only `lib/ticketing/refunds/settlement.ts:448–472` (conditional); **no EARNED writer** |
| `Settlement` | 1538 | storage only; no API reads/writes PIC rows |
| `SettlementItem` | 1589 | storage only |
| `EventOrder.picProfileId` (+ `attribution`/`feeEntries` relations) | 1042 / 1062 / 1069–1070 | **never written** (checkout omits it, `checkout.ts:479–501`) |
| `PlatformSetting.defaultPicFeeRateBp` | 1730 | **no reader, no writer** |

### 1.2 Enums

`PICStatus` (:515), `PICAttributionSource` (:523), `PICAttributionMethod` (:531), `FeeBasisType` (:538), `PICFeeType` (:547), `PICFeeEntryType` (:553), `PICFeeStatus` (:562), `LedgerDirection` (:572), `SettlementPayeeType` (:577), `SettlementStatus` (:582), `SettlementMethod` (:593), `PlatformRole.PIC` (:377).

### 1.3 Relations worth noting

- `PICProfile.eventOrders` (:1391) — FK is `EventOrder.picProfileId` (onDelete: SetNull, :1062).
- `PICAttribution.orderId @unique` (:1434) — makes duplicate attribution *structurally* impossible once wired.
- `PICFeeLedger.idempotencyKey @unique` (:1502) + `@@unique([orderItemId, type])` (:1518) — the idempotency guard for posting.
- `SettlementItem.picFeeLedgerId @unique` (:1592) — one ledger entry can be settled at most once.
- `PICEventAssignment @@unique([picProfileId, eventId])` (:1420) — one pairing can only ever be one row.

### 1.4 Services / repositories (`lib/pic/service.ts`, 641 lines)

| Function | Line | Gate | Write? |
|---|---|---|---|
| `listPicsForAdmin` | 120 | `pic.manage` | read only (incl. ledger `groupBy` sum :131) |
| `createPic` | 195 | `pic.manage` | `PICProfile.create` (:220) — resolves existing account by email; status `PENDING` |
| `updatePicStatus` | 269 | `pic.manage` | `PICProfile.update` (approve/suspend/reject, :288) |
| `getPicDetail` | 324 | `pic.manage` | read only (assignments + ledger, :336–367) |
| `listOrganizerPicAssignments` | 408 | `pic.assign` on the given organizer | read only |
| `assignPicToEvent` | 491 | `pic.assign` on the event's OWNER organizer | `PICEventAssignment` create/reactivate (:547–556) |
| `revokePicAssignment` | 585 | `pic.assign` on assignment's organizer | soft delete `isActive:false` + `revokedAt` (:618–625) |

`reversePicFeesForRefund` — `lib/ticketing/refunds/settlement.ts:400–478` (reversal writer, see §7/§9). No other service touches the PIC models.

### 1.5 API routes

| Route | Description | Gate |
|---|---|---|
| `GET/POST /api/admin/pic/route.ts` | list / create PIC | `pic.manage` (+ CSRF on POST) |
| `GET/PATCH /api/admin/pic/[id]/route.ts` | detail / status change | `pic.manage` (+ CSRF on PATCH) |
| `GET/POST /api/organizer/pic/route.ts` | list assignments / assign | `pic.assign` (+ CSRF on POST) |
| `DELETE /api/organizer/pic/[id]/route.ts` | revoke | `pic.assign` (+ CSRF) |

There is **no** attribution, fee, payout, or PIC self-service route anywhere.

### 1.6 Components / pages

- `app/dashboard/pic/page.tsx` — branches on `canManagePlatformPic` → `components/platform/PicManager.tsx` (ADMIN), or `canAssignPic` → `components/organizer/PicAssignmentManager.tsx` (organizers); else `AccessDeniedPanel`.
- `app/dashboard/pic/[id]/page.tsx` — platform ADMIN detail: assignments + ledger, bank number masked, ledger display-only (append-only contract), `getPicDetail` → `PIC_MANAGE`.
- `PicManager.tsx` — create + approve/suspend/reject + **dead link** to `/platform/pic/{id}` (line 280; no such route, 404).
- `PicAssignmentManager.tsx` — assign to event + revoke.

### 1.7 Permissions & authz helpers

Definitions: `permissions.ts:182–183` (`pic.manage`, `pic.assign`), `:184–187` (`pic_attribution.read.own/all`, `pic_fee.read.own/all`), `:206–208` (`report.export.pic_fee`, `report.export.own_pic_fee`).

Computed grants: platform ADMIN → `PIC_MANAGE` only (`:332`); `PIC` platform map = **empty** (`:340`); `PIC` tenant map = **empty** (`:415`); own-scope `PIC` map = `order.read.own, payment.read.own, pic_attribution.read.own, pic_fee.read.own, report.export.own_pic_fee, ticket.read.own, ticket.issue.own, refund.request.own` (**no** `order.cancel.own`, `:579–596`).

**Consumers:** `pic.manage` → 3 services; `pic.assign` → 3 services. `pic_attribution.read.own / pic_fee.read.own / report.export.own_pic_fee / *_read.all / report.export.pic_fee` → **zero consumers** (the only mention is a comment, `service.ts:322`).

### 1.8 Audit log

`writeTicketingAudit` actions: `pic.create` (:243), `pic.status.update` (:301), `pic.assign` / `pic.assign.reactivate` (:558), `pic.assign.revoke` (:627). Entities `PICProfile`, `PICEventAssignment`. No audit for attribution/fee (nothing to audit).

### 1.9 Tests

- `__tests__/authz/permission-map.test.ts` — asserts the PIC maps, ADMIN grants, own-scope sets.
- `__tests__/ticketing-checkout/checkout-wiring.test.ts:366–374` — **structurally pins** "no PIC attribution or fee-ledger writes in the checkout path."
- `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts:605–707` — exercises `reversePicFeesForRefund` (D-P17-12): partial refund **retains** fee, full item refund posts exactly one `REVERSAL` (the test seeds an `EARNED` row by hand).
- `__tests__/auth-flow/*` + `role-matrix` + `dashboard-access` — cover PIC as a login actor (see §2).
- **No dedicated PIC domain test file exists.**

---

## 2. PIC LOGIN FLOW

Trace: login form → `resolveAuthzScope` (`lib/authz/scope.ts:84`, `platformRole ?? "CUSTOMER"`) → JWT/session mirror (`auth.ts`) → post-login destination (`lib/auth/session-gate.ts`, `roles.ts` intents) → single dashboard layout gate (`app/dashboard/layout.tsx` → `canEnterDashboard`, `lib/dashboard/scope.ts:133–141`).

Answers:

- **Can PIC log in?** Yes — standard credentials/Google session, exactly like any user.
- **Where is PIC redirected?** The role-selector intent maps `PIC → /dashboard/pic` (`lib/auth/roles.ts`). If the row already has `platformRole = PIC`, `intentForPlatformRole` returns `/dashboard/pic`.
- **Can PIC enter `/dashboard`?** **No.** `canEnterDashboard = hasTenantAccess || hasPlatformSurface`. A pure PIC has no organizer membership and no platform surface (platform map empty, `permissions.ts:340`), so the dashboard layout renders `AccessDeniedPanel`. The layout is a single gate for every `/dashboard/*` route, so `/dashboard/pic` is *inside* it and is equally blocked.
- **Can PIC enter `/dashboard/pic`?** Only if `pic.manage` (ADMIN) or `pic.assign` (organizer member) — neither is a PIC property. The PIC's own destination is therefore unreachable.
- **Which permission is required?** For today’s surfaces: `pic.manage` (platform), `pic.assign` (tenant). For the intended PIC self-service there is **no permission with any consumer** and no UI.
- **Why does PIC self-service fail today?** (a) `PLATFORM_ROLE_PLATFORM_PERMISSIONS.PIC = toSet([])` and `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty (`:640–641`) → nothing grants a PIC dashboard entry; (b) every page under `/dashboard` is gated by one layout that PIC cannot pass; (c) the self-scope permissions that were designed for exactly this (`pic_attribution.read.own`, `pic_fee.read.own`, `report.export.own_pic_fee`) have no route, no page, no component.
- **What code would need to change (not implemented here):** add a PIC self-service capability in `computeDashboardCapabilities` + `canEnterDashboard` (e.g. "has an ACTIVE PICProfile"), a PIC-owned page/API reading own attribution/fee, and a guard that resolves the session user → own PICProfile → own data only. Session/token plumbing can stay as-is (own-scope checks are already the pattern, `decideOwnResourcePermission`).

---

## 3. PIC EVENT ASSIGNMENT

Current state is the strongest part of the PIC domain:

- **Authorization is two-sided and never trusts the body:** `assignPicToEvent` loads the event first and checks `requireOrganizerAccess(event.organizerId, PIC_ASSIGN)` — an actor cannot name another tenant's event (`service.ts:496–510`). A nonexistent or foreign event answers NOT_FOUND (`:503–505`), so cross-tenant event ids are not enumerable.
- **PIC must be ACTIVE**: unapproved/suspended profiles are not assignable (`:521`, list filters `status: "ACTIVE"` `:439`).
- **Duplicate assignment structurally impossible**: `@@unique([picProfileId, eventId])` (`schema:1420`). Re-assigning a revoked pairing *reactivates* the same row (`:527–556`), preserving history.
- **Revoke is soft** (`isActive:false` + `revokedAt`, no `revokedBy` column; actor identity lives on the audit row `:614–617`). Revocation authorizes against the `organizerId` recorded on the assignment (`:605–608`).
- Lifecycle: `INVITED?` — no; PIC creation is direct. States: created PENDING → approved ACTIVE → assign → (revoke) → reactivate. Assignment does not consult `Event.status`.
- **Conceptual check — PIC A / Event A must not see Event B:** PIC never has a tenant enumeration surface at all today, so there is nothing to leak. The *intended* rule, "`canSellAllEvents:false` ⇒ PIC may only attribute assigned events (design §14.3)", is documented on the column (`schema:1367–1369`) but **has no service-layer checker** ("Checked in the service layer from Phase 9" never landed).

---

## 4. ATTRIBUTION MECHANISM

Search results — only references:

- `shareToken` is an **input** to checkout (`lib/ticketing/checkout-validation.ts:82`), included in the request hash (`checkout.ts:280`) and stored on the `IdempotencyKey` row (`lib/ticketing/idempotency.ts:96`). **Nothing ever reads it back for attribution.**
- The public share link is the canonical event URL — `canonicalShareUrl` = `/e/{slug}` (`lib/events/catalog.ts:113–116`), copied by `components/events/ShareEventMenu.tsx`. **No PIC code, no referral parameter.**
- `GET /api/events/[slug]` resolves by `slug **or** shareCode` (`catalog.ts:611`) — `shareCode` is an *event* code (unlisted/private access), unrelated to PIC.
- Registration no longer processes any `referralCode`; the affiliate block was removed (`app/api/auth/register/route.ts:13–14`).
- `PICAttribution` contains the fields designed for future LINK/QR attribution (`method`, `shareToken`, `firstTouchAt`, `lastTouchAt`, `isFinal`, `selfReferral`, `overriddenByUserId`, `schema:1432–1452`) — all documented as "NOT required by it" and "Freezing is NOT applied in this phase."

Answers:

- **A.** There is **no link** from customer to PIC.
- **B.** There is **no PIC link** — no URL, no QR, no code, no server-generated token.
- **C.** `shareToken` is **inert** for attribution: accepted, hashed, stored, never resolved or trusted.
- **D.** No attribution can survive landing → event → checkout → order because none is captured at any hop.
- **E.** The storage model (`PICAttribution`, `EventOrder.picProfileId`) exists server-side but is **never written**.
- **F.** Nothing to forge today — and the current checkout even correctly refuses to treat a client `shareToken` as authority (it cannot: it is unqualified, `checkout-validation.ts:82`). The future risk is the design's: attribution must be resolved server-side from a *bound* PIC identity, not from a raw client string.
- **G.** No URL parameter is accepted, so a customer cannot steer a PIC by editing the URL — but equally the mechanism does not work at all.
- **H.** No PIC can claim events — there is a single, secured path: organizer-admin assignment (`pic.assign`), and nothing else.

> **STATE: "ATTRIBUTION MECHANISM NOT IMPLEMENTED."**

---

## 5. CHECKOUT INTEGRATION

Trace in `lib/ticketing/checkout.ts`:

- `shareToken` → request hash (:280) → `IdempotencyKey.requestHash` (:467–477). That is the **only** use.
- Fee constants: `discount = 0`, `platformFee = 0`, `picFeeTotal = 0` (:419–421), with an explicit comment: `picFeeTotal = 0` — *"the fee engine is Phase 9"* (:412).
- Order create data (:479–501) contains **no `picProfileId`** and freezes `picFeeTotal` at 0 (:493). `EventOrder.picProfileId` (`schema:1042`), its relation (:1062), and the `PICAttribution` one-to-one (`schema:1069`) are simply untouched.
- No `PICAttribution.create`, no `pICFeeLedger.create` — and a structural test **pins** that absence (`checkout-wiring.test.ts:366–374`).

**Exact point where PIC information is lost:** the `shareToken` string never leaves the hashing/idempotency path; it is not resolved to a `PICProfile`, and the order is created with a zero fee and a null `picProfileId`. Everything downstream (payment, ticket, refund) correctly carries no PIC data because none was attached.

---

## 6. FEE ENGINE

Configuration surfaces that exist:

- `PICProfile.defaultFeeRateBp` (`schema:1366`) — "0 means inherit event/organizer/platform default — deliberately encodes no business rate."
- `PICEventAssignment.feeRateBp` / `feeTypeOverride` (`schema:1406–1407`) — "NULL means inherit."
- `PlatformSetting.defaultPicFeeRateBp` (`schema:1730`) — default `0`; "no fee percentage is seeded" so an unconfigured platform cannot silently charge a rate.
- `PICFeeType` (PERCENTAGE/FIXED/HYBRID, :547), `FeeBasisType` (GROSS_BEFORE_DISCOUNT/GROSS_AFTER_DISCOUNT/NET_AFTER_GATEWAY, :538).
- Ledger snapshots `rateBp / fixedAmount / basisType / basisAmount` (:1486–1492).

Computation that exists: **none.** No code reads `defaultFeeRateBp`, `feeRateBp`, `feeTypeOverride`, or `defaultPicFeeRateBp` to price anything. The only place a rate is *copied*, not computed, is service read models (`service.ts:378,458`).

> **STATE: "FEE ENGINE NOT IMPLEMENTED."** Semantics are documented at schema level only; percentages/fixed amounts are not priced, not inherited, not applied.

---

## 7. PIC FEE LEDGER

- **Who creates entries:** only `reversePicFeesForRefund` (`refunds/settlement.ts:448–472`) and only `REVERSAL`/`DEBIT` rows for a **fully refunded** order item, and only when an `EARNED` row already exists (`:419–424` → `continue`). No production path creates `EARNED`, `PAYOUT`, `ADJUSTMENT`, or `EARLY_ACCRUAL`.
- **When:** inside the refund settlement transaction, once per full item, guarded by `@@unique([orderItemId, type])` + `fee:reversal:{refundId}:{orderItemId}` idempotency key.
- **References:** copies `picProfileId/organizerId/eventId/orderId/orderItemId/ticketTypeId/attributionId` from the earned row; `refundId` links the refund.
- **Snapshots:** `rateBp/fixedAmount/basisType/basisAmount/amount` copied from the earned entry — the design contract ("SNAPSHOTS taken at posting time", `schema:1467–1470`) is honoured *by the reversal* but practised by no earning path.
- **Status:** reversal written as `VOID` (`settlement.ts:467`); `PICFeeStatus` journey (`PENDING→EARNED→PAYABLE→APPROVED→SETTLED`, `schema:562–569`) is otherwise unused.
- **Readers:** `listPicsForAdmin` `groupBy` sum (:131–135) and `getPicDetail` (:353–366) — both `pic.manage`.

> **STATE: "PIC FEE LEDGER MODEL EXISTS BUT IS NOT WIRED (revenue side)."** The reversal write path is fully implemented and covered by `refund-manual-rail.integration.test.ts:605–707`; it is simply unreachable because nothing ever posts an `EARNED` row.

---

## 8. PAYMENT → PIC (integration point)

Lifecycle today: checkout (`PENDING_PAYMENT`/`UNPAID`) → payment creation (iPaymu) → webhook `settleVerifiedPayment` (`lib/ticketing/payment/settlement.ts`) → order `PAID` → tickets issued.

Where an EARNED fee *should* be posted: inside the **same single settlement transaction** (`settleVerifiedPayment`), after the order CAS flips to `PAID` — the webhook handler is explicit that "No PIC attribution, fee ledger or fee snapshot — Phase 9" (`webhook.ts:77`), and the operator reconcile path enters the *same* transaction, so a future poster would be branch-consistent.

**Current code:** nothing posts a fee here. The order's `picFeeTotal` was already frozen at 0 and no EARNED row exists. No change was made to payment settlement during this audit.

---

## 9. REFUND → PIC

`reversePicFeesForRefund` (`refunds/settlement.ts:400–478`) is invoked from refund settlement and is **correctly scoped**:

- Full item refund → one `DEBIT/REVERSAL` row, amount equal to earned, `status VOID`, `adjustmentReason: "REFUND"`, idempotent.
- Partial refund → **retains** the fee (D-P17-12, asserted in the test suite).
- Reversal only fires if an `EARNED` row exists.

> **STATE: "PARTIAL"** — reversal logic implemented + tested; unreachable in production because the EARNED side is not wired. Strictly, per the task's own labels: the reversal is wired code, the ecosystem is `[PARTIAL]`.

---

## 10. PIC PAYOUT / SETTLEMENT

- `Settlement` / `SettlementItem` models support `payeeType = PIC` (`schema:577–580`), per-PIC uniqueness `@@unique([payeeType, picProfileId, periodStart, periodEnd])` (:1577), `SettlementStatus` ™:582–589, `SettlementMethod.MANUAL_TRANSFER` only (`GATEWAY_SPLIT` explicitly banned until iPaymu split is verified, D-04, :591–594).
- `PICProfile` collects `bankName/bankAccountName/bankAccountNumber/taxId` (:1370–1373); the admin detail page masks the account number.
- **No payout service, no settlement API route, no `Settlement.*.create` anywhere in production**, no status transitions implemented. The only hook is the permission vocabulary (`SETTLEMENT_PREPARE/APPROVE/PROOF_UPLOAD` in the maps) and the doc comment "Settlement ... enforced in the service layer from Phase 9."

> **STATE: "PAYOUT FLOW NOT IMPLEMENTED."**

---

## 11. PIC SELF-SERVICE

- No PIC dashboard, no own-attribution page, no own-fee page, no PIC report/export page.
- `pic_attribution.read.own`, `pic_fee.read.own`, `report.export.own_pic_fee` — **permission exists, zero consumers** (only occurrence in code is a comment, `service.ts:322`).
- The only PIC-facing "detail" page is the ADMIN/operator view (`/dashboard/pic/[id]`, `pic.manage`).

> **STATE: "PERMISSION EXISTS — UI NOT WIRED."**

---

## 12. DATA ISOLATION (PIC)

- There are **no PIC-consumer endpoints**, so there is no place where Event B / Order B / Attribution B / Fee B / Customer B / Payment B could currently leak to a PIC.
- All existing PIC routes use either `pic.manage` (platform ADMIN) or `pic.assign` on the owning tenant (organization member), exactly as documented (`app/api/admin/pic/route.ts:14–16`, `app/api/organizer/pic/route.ts:14–22`).
- Cross-tenant behaviour: `listOrganizerPicAssignments` runs `requireOrganizerAccess` on the passed `organizerId` (foreign tenant → 404, `service.ts:408–444`); `assignPicToEvent` and `revokePicAssignment` authorize against the authoritative `organizerId`, never a body value.
- When implemented, PIC own-scope reads must — and structurally can — go through `decideOwnResourcePermission` (owner = the `User` bound to the `PICProfile` via `userId`, `schema:1360`). Tenant isolation is unchanged by this audit.

---

## 13. ROLE BOUNDARY (does PIC risk widening authority?)

Current construction is safe **by absence and by design**:

- `PLATFORM_ROLE_PLATFORM_PERMISSIONS.PIC = ∅`, `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC = ∅` (`permissions.ts:340,415`).
- PIC own-scope map deliberately **withholds** `order.cancel.own`, and includes only buyer-level reads plus the three PIC self-reads (`:579–596`); it grants no `user.manage`, `role.manage`, `refund.approve/execute`, `payment.*`, `settlement.*`, or tenant/global powers.
- Nothing in the intended wiring path touches `ADMIN_GRANT_REQUIRED` (:620–629) or the platform/tenant maps; those must remain untouched (admin-authorization freeze is respected).
- The one extension the PIC self-service needs (own data reads) is already expressible as own-scope permissions that exist but have no consumer.
- Residual note: since **no** code can currently grant `platformRole = PIC` either (the only writer is `CUSTOMER` at registration, `route.ts:235`), the role is effectively unreachable today — a governance gap, not an authorization hole.

---

## 14. PROPOSED TARGET ARCHITECTURE (description only — nothing implemented)

```
ADMIN ──(pic.manage)──▶ create profile (existing USER) ──▶ approve/activate
                     └──▶ assign PICProfile → Event          [ pic.assign, tenant-scoped, existing ]
                                  │
PIC ──────────────────▶ referral surface (LINK/QR per design D-01; ids baked in PIC_SELECT? no — new)
                                  │   server-generated, bound to ACTIVE profile + ACTIVE assignment
CUSTOMER ──▶ referral URL ──▶ /events or /e/[slug]?pic= <token> ──▶ checkout
                                    │
SERVER (checkout, inside the existing CAS + idempotent transaction):
      1. resolve token → PICProfile (server-side only; token has no monetary authority)
      2. validate ACTIVE profile + ACTIVE (picProfileId,eventId) assignment (design §14.3, honoring canSellAllEvents)
      3. write PICAttribution { orderId @unique, source, method, selfReferral=false }
      4. set Order.picProfileId; price picFeeTotal from resolved feeRateBp/feeType (inheritance chain)
PAYMENT success (existing settleVerifiedPayment transaction):
      5. post PICFeeLedger EARNED (snapshot rate/sbasis, idempotencyKey "fee:earned:{orderItemId}",
         @@unique([orderItemId,type]) guards)
REFUND (existing reversePicFeesForRefund):
      6. full item → DEBIT/REVERSAL; partial → retain (already implemented + tested)
PIC self-service (new, own-scope permissions already defined):
      7. dashboard tile incl. assignments, attributions, sales, fee ledger, payout status
PAYOUT:
      8. Settlement payeeType=PIC + SettlementItem (unique picFeeLedgerId) + MANUAL_TRANSFER proof flow
```

Principles to preserve: all PIC authority server-derived; attribution frozen (`isFinal`) rules later; ledger append-only; idempotent posting via unique keys; tenant isolation untouched; ADMIN authorisation untouched.

---

## 15. IMPLEMENTATION GAP TABLE

| Area | Exists | Wired | UI | Backend Auth | Missing |
|---|---|---|---|---|---|
| PIC login | ✅ (any session) | ✅ | ✅ (form) | `scope.platformRole` | destination/entry gating for PIC |
| PIC dashboard | — | ❌ | ❌ | — | canEnterDashboard path + page |
| PIC assignment | ✅ model | ✅ | ✅ | ✅ `pic.assign` 2-sided | none (complete) |
| PIC management | ✅ model | ✅ | ✅ | ✅ `pic.manage` | fix dead `/platform/pic/{id}` link |
| Referral link | — | ❌ | ❌ | — | token builder + consumer |
| Attribution | ✅ model | ❌ | ❌ | — | server-side writer + order link |
| Checkout integration | `picProfileId` col | ❌ | — | ✅ (origin+auth+idem) | resolve token, set pic, price fee |
| Fee engine | config cols + enums | ❌ | — | — | compute/inherit/basis resolver |
| Fee snapshot | ledger cols | ❌ | — | — | populate at EARNED posting |
| Fee ledger (EARNED) | ✅ model | ❌ | ❌ (read side: admin only) | — | EARNED writer |
| Fee ledger (REVERSAL) | ✅ model | ✅ | — | ✅ (in refund tx) | none (untested reachability only) |
| Payment settlement integration | — | ❌ | — | — | post EARNED in `settleVerifiedPayment` |
| Refund reversal | ✅ | ✅ | — | ✅ | none (needs EARNED to exist) |
| Payout / settlement | ✅ models | ❌ | ❌ | — | service + routes + proof flow |
| Reporting | perms exist | ❌ (admin read-only on ledger) | ❌ | — | own/all read routes |
| Export (`report.export.*`) | perms exist | ❌ | ❌ | — | exporter + job path |
| Tenant isolation | ✅ | ✅ | — | ✅ 404 cross-tenant | none |

---

## 16. EXACT CODE CHANGE PLAN (read-only proposal)

**Existing files likely needing changes**
- `lib/ticketing/checkout.ts` — resolve+validate token, set `picProfileId`, compute `picFeeTotal` from rate override chain; keep the idempotency/CAS structure identical.
- `lib/ticketing/checkout-validation.ts` — tighten `shareToken` → typed PIC token (or a new field).
- `lib/ticketing/idempotency.ts` / `order-payload.ts` — carry the token into request hash + surface fee fields.
- `lib/ticketing/payment/settlement.ts` — inside the existing single transaction, after PAID CAS: post EARNED ledger rows; no change to the CAS itself.
- `lib/ticketing/refunds/settlement.ts` — reversal already correct; verify it runs post-EARNED.
- `lib/pic/service.ts` — add own-scope reads (resolve `user → PICProfile → own attribution/fee/export`), reusing `decideOwnResourcePermission`.
- `lib/dashboard/scope.ts` + `app/dashboard/layout.tsx` — add "has ACTIVE PICProfile" as a self-service capability for `canEnterDashboard` + menu; keep ADMIN authz untouched.
- `app/dashboard/pic/page.tsx` + new pages — PIC self-service view.
- `components/platform/PicManager.tsx:280` — dead `/platform/pic/{id}` link → correct path.
- `lib/auth/roles.ts` / `session-gate.ts` — PIC destination remains `/dashboard/pic`; effective only after the layout gate admits PIC.

**New files likely needed**
- `lib/pic/referral.ts` (token mint/verify), `lib/pic/fee.ts` (engine: rate resolution + basis math), `lib/pic/attribution.ts` (writer), `lib/pic/payout.ts` (settlement service), corresponding `app/api/pic/...` routes (`mine/assignments`, `mine/attributions`, `mine/fees`, `mine/export`), an own-report page, and a PIC self-service menu item.

**Existing models to reuse (no schema change)**
`PICProfile`, `PICEventAssignment` (+unique pair), `PICAttribution` (+unique orderId), `PICFeeLedger` (+idempotency keys, +`[orderItemId,type]` unique), `Settlement`/`SettlementItem` (+unique picFeeLedgerId), `PlatformSetting.defaultPicFeeRateBp`, `EventOrder.picProfileId`.

**Tests required (per flow)**
- Referral: token mint/expire/forge-reject; token for unassigned/inactive PIC rejected.
- Attribution: one per order (unique), canSellAllEvents honored, freeze semantics.
- Checkout: picProfileId persisted, fee arithmetic (percentage/fixed/hybrid × basis), fee stays 0 when unconfigured.
- Settlement: EARNED posted once per item (idempotent), replay-safe against webhook + reconcile.
- Refund: reversal idempotence re-verified end-to-end against real EARNED rows.
- Access: PIC own-scope reads cannot cross profiles/events/organizers; PIC cannot reach any platform/tenant route; role-matrix + tenant-isolation suites extended for `platformRole = PIC`.

---

## 17. FINAL PIC FLOW (plain language with status)

1. **ADMIN creates PIC profile** from an existing account — `[IMPLEMENTED]` (`pic.manage`, `createPic`).
2. **ADMIN/organizer assigns PIC to an event** — `[IMPLEMENTED]` (`pic.assign`, unique pairing, soft revoke, audited).
3. **PIC gets events to sell** — `[PARTIAL]`: the record exists (`PICEventAssignment`), but **PIC has no UI to see its own events** (no self-service).
4. **PIC gets a referral mechanism** — `[NOT IMPLEMENTED]` (no link/QR/code; `shareToken` inert).
5. **Customer comes through PIC** — `[NOT IMPLEMENTED]` (no landing capture; no attribution anywhere).
6. **Customer buys a ticket** — `[IMPLEMENTED]` core checkout; **`[NOT WIRED]` PIC part** (`picFeeTotal = 0`, `picProfileId` null, no fee computed).
7. **Order records PIC** — `[NOT WIRED]` (column + relation exist, never written).
8. **Payment succeeds** — `[IMPLEMENTED]` settlement; **`[NOT WIRED]` for PIC** (no EARNED posting).
9. **PIC fee earned** — `[NOT IMPLEMENTED]` (no fee engine).
10. **Fee ledger** — `[NOT WIRED]` revenue side; `[IMPLEMENTED]` reversal side (`PICFeeLedger.EARNED` absent → `REVERSAL` unreachable in production; structurally proven in tests).
11. **Refund, if any** — `[PARTIAL]`: refund flow `[IMPLEMENTED]`; fee reversal `[IMPLEMENTED]` *conditional on an EARNED row existing*.
12. **Fee reversal where applicable** — `[PARTIAL]` (full-item only by design D-P17-12; inert until EARNED exists).
13. **PIC sees earnings** — `[NOT IMPLEMENTED]` (no self-service UI; permissions defined, no consumers).
14. **PIC payout** — `[NOT IMPLEMENTED]` (models only; no service, no route, no proof flow).

---

## 18. VERIFICATION (read-only)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | ✅ clean |
| `npm run lint` | ✅ 0 errors, 3 warnings (`@next/next/no-img-element`, pre-existing) |
| Relevant PIC-adjacent suites (`checkout-wiring` [pins no-PIC-writes], `permission-map`, `dashboard-access`, `role-intent`, `refund-manual-rail` [PIC reversal]) | ✅ 116 / 116 passed |
| Full suite (this session, same read-only state) | ✅ 94 suites / 1977 tests passed |
| `npm run build` | ✅ clean |

No source was modified to obtain these results.

---

## HEADLINE CONCLUSIONS

1. **ATTRIBUTION MECHANISM NOT IMPLEMENTED** — `shareToken` is hashed and discarded; no PIC link exists.
2. **FEE ENGINE NOT IMPLEMENTED** — rate config is schema-only; nothing prices a PIC fee.
3. **PIC FEE LEDGER MODEL EXISTS BUT IS NOT WIRED (revenue side)** — only the reversal writer exists, and it fires only when (nothing creates) an `EARNED` row. A structural test (`checkout-wiring.test.ts:366–374`) intentionally pins the no-write state.
4. **PAYOUT FLOW NOT IMPLEMENTED** — Settlement models/PIC payee only.
5. **PERMISSION EXISTS — UI NOT WIRED** for `pic_attribution.read.own`, `pic_fee.read.own`, `report.export.own_pic_fee`; `platformRole=PIC` cannot enter `/dashboard`.
6. Solid, complete today: **PIC management + event assignment** (duplicate-proof, tenantly isolated, audited) and **refund fee-reversal logic** (full-item only), both test-protected.