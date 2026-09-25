# PIC SELF-SERVICE DASHBOARD V1 IMPLEMENTATION REPORT

A **read-only, own-scope** dashboard for an active PIC: what I earned, what I referred, and
what my links sold — served to the PIC themselves inside the existing `/dashboard` shell.

---

## 1. Summary

Before this change, the dashboard entry gate admitted only tenant members, platform
staff, and legacy customers — **not a PIC**, even one with an *ACTIVE* `PICProfile`. A PIC
signed in, passed the guest/redirect blocks, and was then refused at the dashboard because
`computeDashboardCapabilities(scope)` could not see a `PICProfile` (a row the permission
deciders deliberately do not consult). There was no PIC-facing surface at all; the only PIC
pages were the **management** views (`/dashboard/pic` list + detail) owned by `pic.manage`
and `pic.assign`. A referrer had no way to see their assignments, referral links,
attributions, sales or fees.

**PIC SELF-SERVICE DASHBOARD V1** fixes the gate and the gap:

1. **Entry.** `DashboardCapabilities` gains `hasActivePicProfile`. The layout probes the
   database **only when the first-pass decision refused** the actor, and admits the actor if
   they own an ACTIVE `PICProfile`. Every first-pass-eligible actor (admin, organizer, …) is
   **never flagged** — their capability set is byte-identical to before.
2. **Navigation.** A pure PIC sees exactly four rows: **Ringkasan PIC, Event Saya, Referral,
   Pendapatan** — anchors into the single self-service section on `/dashboard/pic`. The
   generic tenant "Dashboard" row is the exact inverse of the flag.
3. **The surface.** `/dashboard/pic` gains a third branch: when the caller owns an ACTIVE
   profile (and holds no `pic.manage` / `pic.assign`), it renders the **self-service**
   section — profile strip, StatGrid, My Assignments, Referral links (each with a copy
   button), Latest Attributions, Fee Summary, and Latest Ledger — all **read-only**.
4. **Authority.** Every read funnels through `requireMyPic`, and every query is scoped to the
   ACTIVE profile resolved **from the server-side session**. No function accepts a
   `picProfileId`, `organizerId` or money value from the caller.

Result: `tsc` clean · ESLint clean on the feature files (repo-wide unchanged) · **102 suites /
2073 tests pass** (44 of them new for this feature, incl. real-database isolation and
reporting suites) · production build passes · **no Prisma schema change**.

---

## 2. User Flows

**PIC LOGIN → PIC DASHBOARD → MY EVENTS → REFERRAL LINKS → ATTRIBUTIONS → SALES →
EARNED / REVERSAL → NET FEE**

1. A PIC signs in as usual and navigates to `/dashboard`.
2. `app/dashboard/layout.tsx`: `getAuthzScope()` → `computeDashboardCapabilities(scope)`.
   The PIC has no tenant membership, no platform surface, and no legacy grants → **refused
   on the first pass**. The layout then probes `findActivePicProfile(userId)` — the caller
   owns an ACTIVE profile → `hasActivePicProfile = true` → **admitted**.
3. The shell renders the PIC-only menu: *Ringkasan PIC / Event Saya / Referral / Pendapatan*.
4. `/dashboard/pic` (branch 3) loads all six service reads in `Promise.all` and renders:
   - **StatGrid** — assigned events (active), attributed orders, tickets sold, gross sales.
   - **Event Saya** (`#events`) — only the PIC's own assignments, active and revoked.
   - **Tautan Referral** (`#referrals`) — a signed `…/e/{slug}?pic=…` link per active
     assignment, with a client copy button (`CopyLinkButton`). A revoked assignment shows
     "Tautan tidak tersedia" — never a stale token.
   - **Atribusi Terbaru** — the PIC's recent attributions with order totals and payment tone.
   - **Ringkasan Fee** — earned / reversed / **net = CREDIT − DEBIT**, from the posted ledger.
   - **Ledger Terbaru** (`#earnings`) — the append-only history in `EARNED`/`VOID` vocabulary,
     never "paid out".
5. Every row dollar amount is derived at read time from `PAID` orders and the posted ledger;
   there is no counter to drift and no write path from this surface.

---

## 3. The Entry Gate

`lib/dashboard/scope.ts`:

- `DashboardCapabilities.hasActivePicProfile: boolean` (new field).
- `computeDashboardCapabilities(scope, context= { hasActivePicProfile?: boolean } )` — the
  context is an **optional second argument defaulting to `false`**, so every existing
  single-argument caller (layout, tests, redirect logic) is byte-identical. The pure
  combinator still cannot see a `PICProfile`; the flag is supplied by the caller that can.
- `canEnterDashboard` now admits when
  `hasTenantAccess || hasPlatformSurface || hasActivePicProfile`.
- `findActivePicProfile(userId)` (in `lib/pic/self-service.ts`) is the layout's exact probe:
  ACTIVE only, user-scoped, fail-closed (`null` for SUSPENDED/REJECTED/missing).

`app/dashboard/layout.tsx`:

```
const capabilities = computeDashboardCapabilities(scope);
if (!canEnterDashboard(capabilities)) refused → see also cap probe…
```
The probe runs **only on the way out**: first-pass-admitted actors keep `hasActivePicProfile`
`false`, so an admin who also owns a PIC profile stays on the generic dashboard (its PIC rows
are hidden: `visible: !hasActivePicProfile`). Only a first-pass-denied actor is ever flagged
"PIC", and only if their profile is ACTIVE.

The page (`app/dashboard/pic/page.tsx`) keeps its original branch order — `pic.manage`
(platform management) → `pic.assign` (organizer management) → `hasActivePicProfile`
(self-service) → deny — so operator behavior is unchanged; the self-service section is purely
additive.

---

## 4. The `requireMyPic` Guard and Error Contract

`lib/pic/self-service.ts` funnels every read through one fail-closed guard, in order:

| Step | Check | Failure → |
|---|---|---|
| 1 | `requireAuth()` — a real server session | `UNAUTHORIZED` |
| 2 | `scope.userId === userId` — the argument is a routing key, never authority | `PIC_ACCESS_DENIED` (forged id) |
| 3 | ACTIVE `PICProfile` exists for the **session** user | `NOT_FOUND` ("no such PIC") |
| 4 | `decideOwnResourcePermission` per required family | `FORBIDDEN` |

Profile-existence precedes permissions so the two failures read differently: **"you are not a
PIC"** (`NOT_FOUND`) vs **"you are a PIC but this family is not yours"** (`FORBIDDEN`). An
account that owns an ACTIVE profile but is a CUSTOMER on the platform clears step 3 and then
correctly fails `FORBIDDEN` on the fee family — identity is not a role escape hatch.

**Permission mapping** (deliberate — see §9):

| Read | Required own-scope permission |
|---|---|
| assignments / referral links | profile-scoped only (`[]`) — holding an ACTIVE profile + owning the account is the authority |
| attributions / sales counts | `pic_attribution.read.own` |
| fee summary / ledger | `pic_fee.read.own` |
| overview | both of the above |
| `report.export.own_pic_fee` | **deliberately not consumed in V1** (export out of scope) |

No new permission is invented; the existing maps for `PIC` and `CUSTOMER` are untouched, and
the role-matrix/permission-map suites still pin their exact capability objects.

---

## 5. The Read Model

All figures are **derived at read time**, never counted from a mutable counter:

- **assignedEvents** — count of `PICEventAssignment` where `isActive = true`.
- **attributedOrders** — count of `PICAttribution` rows (all payment states; checkout-time
  fact).
- **ticketsSold / grossSales** — `eventOrderItem` quantity (`_sum`) and `eventOrder.total`
  (`_sum`) where `eventOrder.picProfileId = mine AND paymentStatus = "PAID"` — the dashboard
  revenue contract: a PENDING/FAILED/CANCELLED/REFUNDED order **never** inflates "sold".
- **fee earned / reversed / net** — `PICFeeLedger` grouped by direction (`_sum.amount`):
  `earned = CREDIT`, `reversed = DEBIT`, `net = CREDIT − DEBIT` in `Prisma.Decimal`
  (exact arithmetic, never float, never recomputed from current fee config). Ledger rows are
  append-only; in the current engine the observable vocabulary is `EARNED` and `VOID`.

All service queries run under one `Promise.all`; authorizations are identical across the six
result sets.

Referral links reuse the existing `mintPicReferralToken` (PIC VERTICAL SLICE) — signed,
server-side, per **active non-revoked** assignment. Nothing is ever accepted from the query
string or body; the event referenced by a link lookup is re-authorized against the caller's
own active assignment before a token is minted (`getMyReferralLink` → `null` otherwise).

There is **no `/api/pic/**` section** (asserted in TEST 17): the surface is server-rendered
reads only, so there is no second write surface for PIC business data.

---

## 6. Files Changed / Added

### New
| File | Role |
|---|---|
| `lib/pic/self-service.ts` | The whole read model: guard + six surfaces + `findActivePicProfile`. |
| `components/dashboard/CopyLinkButton.tsx` | Client copy button (`Salin tautan` / `Tersalin`, 2 s). |
| `__tests__/pic-self-service/entry.integration.test.ts` | TESTS 1–4, 18, 20 — the gate. |
| `__tests__/pic-self-service/ownership.integration.test.ts` | TESTS 5–12 — isolation. |
| `__tests__/pic-self-service/reporting.integration.test.ts` | TESTS 13–17 — metrics. |
| `__tests__/pic-self-service/menu.test.ts` | TESTS 18–21 — menu rendering, pure. |
| `PIC_SELF_SERVICE_DASHBOARD_V1_IMPLEMENTATION_REPORT.md` | This document. |

### Changed
| File | Change |
|---|---|
| `lib/dashboard/scope.ts` | `hasActivePicProfile` + optional context arg + gate. |
| `app/dashboard/layout.tsx` | Lazy probe for first-pass-denied actors; `contextLabel` "PIC". |
| `components/dashboard/DashboardAppShell.tsx` | `buildDashboardNav` extracted (pure, testable); PIC rows + generic-row inversion. |
| `app/dashboard/pic/page.tsx` | Branch 3 (self-service) + `PicSelfServiceSection`; branches 1/2/4 untouched. |
| `jest.config.js` | `**/__tests__/pic-self-service/*.test.ts` added to `testMatch`. |
| `__tests__/ui-consolidation/shadcn-dashboard.test.ts` | P-S2 page-resolution test now normalises `#fragment` hrefs (anchor → same page). |

---

## 7. Verification Evidence

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint` on feature files | clean |
| `npx jest __tests__/pic-self-service/` | 44/44 pass |
| `npx jest` (full, serialised, real MySQL `_test`) | **102 suites / 2073 tests pass** |
| Pinned suites (`role-matrix`, `permission-map`, `dashboard-access`, `pic-referral`, `ui-consolidation`) | unaffected (57 + 38 pass unchanged) |
| `npm run build` | Compiled successfully · static 19/19 · exit 0 |

---

## 8. Security Notes

- **Fail-closed at every layer**: gate → menu → route branch → service guard → scoped query.
  A forged URL to a PIC dashboard page resolves the wrong body or a denied panel, never
  another PIC's rows.
- **Session, not headers**: `userId` flows from `getAuthzScope` in the layout and
  `requireAuth` inside each read. A caller cannot parametrise a read against another user.
- **No client authority**: `CopyLinkButton` only prettifies a server-minted share path;
  referral tokens are minted server-side per active assignment, and a revoked assignment never
  renders a link.
- **No new write surface**: no `/api/pic/*`, no mutations, no counters.

---

## 9. What Was Deliberately NOT Done (explicit confirmations)

- **Admin authorization unchanged.** The `ADMIN_GRANT_REQUIRED` flag, the platform `ADMIN`
  permission grants, `pic.manage`, `pic.assign`, and every permission map are untouched.
- **Existing engines reused only.** Payment, webhook, reconciliation, refund, fee engine and
  referral mechanism are read (or reused) exactly as they were; none were modified to serve
  this dashboard.
- **Payout / settlement / export are NOT implemented.** `PICFeeLedger.PAYOUT` exists as an
  enum value but this dashboard never triggers or renders a payout; `report.export.own_pic_fee`
  is deliberately left unwired. These are the primary follow-ups and remain read-only gaps.
- **No schema change** (Prisma valid; verified by the clean build + tests).
- **Nothing committed or pushed.**

## 10. Known Gaps / Roadmap

1. Payout requests & the `PAYOUT`/`SETTLED` vocabulary for the PIC (needs a write + approval
   flow — owned by another phase).
2. `report.export.own_pic_fee` wiring once an export surface exists.
3. Assignment lifecycle (PIC-facing activate/request) — currently an organizer/admin verb.

**Status: IMPLEMENTED · VERIFIED · NOT COMMITTED.**