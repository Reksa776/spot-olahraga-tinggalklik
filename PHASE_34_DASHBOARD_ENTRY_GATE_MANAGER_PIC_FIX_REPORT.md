# PHASE 34 — FIX DASHBOARD ENTRY GATE FOR MANAGER + PIC

**Status:** FIXED — audit first, smallest correct fix, no schema change, no role-system change.
**Re-verified on the final tree (post Phase 35/36):** gate, standing states and live browser
smoke (§9, §13) confirmed; full suite **116 suites / 2270 tests / 0 failures**.
**Safety:** NO COMMIT · NO PUSH · NO DB RESET · NO DESTRUCTIVE MIGRATION.

---

## 1. EXACT ROOT CAUSE

The dashboard has **one** entry gate, `canEnterDashboard(capabilities)` in
`lib/dashboard/scope.ts`, applied by the single layout `app/dashboard/layout.tsx`. Before this
phase it was:

```ts
canEnterDashboard = hasTenantAccess || hasPlatformSurface || hasActivePicProfile
// hasPlatformSurface = canManageSports || canManageGlobalVenues || canManagePlatformPic
```

It conflated **dashboard entry** with **holding an operational capability**. That is correct
for the old populations (platform ADMIN, organizer OWNER, ACTIVE PIC) but wrong for the
accounts Phase 33 provisions separately from organizer membership:

* **A — MANAGER with no `OrganizerMember`.** `hasTenantAccess` is false (every tenant
  permission requires an ACTIVE membership) and `hasPlatformSurface` is false (MANAGER's only
  platform permission is `audit_log.read`, which is not one of the three surface flags).
  `hasActivePicProfile` is false. → the layout rendered `AccessDeniedPanel`
  (“Akun kamu belum memiliki akses ke dashboard…”).

* **B — PIC with a PENDING `PICProfile`.** `hasTenantAccess` and `hasPlatformSurface` are
  false, and the layout's probe `findActivePicProfile(userId)` returns `null` for anything
  that is not ACTIVE, so `hasActivePicProfile` stayed false. → same generic denial. The
  layout never even reached the intended “pending approval” UX.

* **C — ACTIVE PIC** enters correctly (probe returns the profile → `hasActivePicProfile`
  true). Confirmed unchanged.

* **D — ADMIN** enters correctly on the platform surface, with or without a membership.
  Confirmed unchanged.

* **E — CUSTOMER** is still refused (`resolveAuthzScope` resolves, but no capability flag).
  Confirmed unchanged.

The login path was **not** the bug: `postLoginDestination` defaults to `/dashboard` and the
role intents already send ADMIN/MANAGER to `/dashboard` and PIC to `/dashboard/pic`. The
destination was correct; the destination's gate rejected them. No redirect was changed.

---

## 2. EXACT FILES CHANGED

| File | Change |
| --- | --- |
| `lib/dashboard/scope.ts` | New capability `hasPlatformRoleEntry`, derived from `scope.platformRole`; `canEnterDashboard` now admits it. |
| `app/dashboard/layout.tsx` | Probe the PIC profile for PIC-role accounts (not only on first-pass denial); corrected the `contextLabel` so MANAGER/PIC are not mislabelled “Penyelenggara”. |
| `components/dashboard/AccountStandingNotice.tsx` | **NEW** shared landing notice (MANAGER onboarding / PIC pending·suspended·rejected·missing). Reuses `SectionCard` + `EmptyBlock`. |
| `lib/pic/self-service.ts` | New `findPicProfileStanding(userId)` — user-scoped status-only probe (complement of `findActivePicProfile`). |
| `app/dashboard/page.tsx` | Renders the standing notice for a MANAGER without an organization and for a PIC whose profile is not ACTIVE; otherwise the existing overview. |
| `app/dashboard/pic/page.tsx` | For a PIC-role account with a non-ACTIVE profile, renders the standing notice instead of the generic operator denial. |
| `__tests__/authz/role-matrix.integration.test.ts` | Updated MANAGER-without-membership and PIC entry expectations to the new semantics. |
| `__tests__/auth-flow/dashboard-access.integration.test.ts` | Updated the MANAGER-without-membership expectation. |
| `__tests__/pic-self-service/entry.integration.test.ts` | Updated TEST 1 / TEST 4; added `findPicProfileStanding` coverage (TEST 21). |
| `__tests__/pic-self-service/menu.test.ts` | Added `hasPlatformRoleEntry: false` to the capability builder. |
| `__tests__/admin-manager/branding-and-wiring.test.ts` | Added `hasPlatformRoleEntry: false` to the capability builder. |
| `__tests__/auth-flow/phase34-dashboard-entry-gate.integration.test.ts` | **NEW** Phase 34 regression suite (16 cases). |

No schema/migration change. No change to `lib/authz/permissions.ts`, the role maps, or any
tenant/PIC service guard.

---

## 3. OLD vs NEW DASHBOARD-ENTRY SEMANTICS

| | OLD | NEW |
| --- | --- | --- |
| Gate | `hasTenantAccess \|\| hasPlatformSurface \|\| hasActivePicProfile` | `… \|\| hasPlatformRoleEntry` |
| Entry right | a *capability* | a *platform role* (`ADMIN`/`MANAGER`/`PIC`); `CUSTOMER` still refused |
| Tenant data | requires ACTIVE `OrganizerMember` | **unchanged** — requires ACTIVE `OrganizerMember` |
| PIC self-service | requires ACTIVE `PICProfile` | **unchanged** — requires ACTIVE `PICProfile` (`requireMyPic`) |

`hasPlatformRoleEntry = scope.platformRole !== "CUSTOMER"`, i.e. it is derived from the
authoritative `AuthzScope.platformRole` (resolved from the `User` row per request), not
hardcoded role names in the layout. Entry still grants **zero** authority: `hasTenantAccess`
stays false, the platform capability maps are untouched, and every page/service re-decides its
own read.

---

## 4. MANAGER BEHAVIOR WITHOUT MEMBERSHIP

* `/dashboard` loads (no `AccessDeniedPanel`).
* Shows the onboarding state **“Belum Ada Organisasi”** — “Akun Manager sudah aktif, tetapi
  belum ditugaskan ke organisasi…”. No zeros that read like an empty business.
* No tenant data and no operational surface. The menu contains exactly `/dashboard` — not
  `/dashboard/events`, `/orders`, `/payments`, `/users`, `/settings/application`,
  `/settings/branding`, or `/settings/maintenance`.
* Direct URLs (`/dashboard/events`, `/dashboard/orders`, `/dashboard/payments`,
  `/dashboard/pic`) still hit their existing service guards and are refused. No tenant read
  works: `listDashboardOrders(scope, { organizerId })` still throws
  `ORGANIZER_ACCESS_DENIED`.
* With an ACTIVE `OrganizerMember`, behavior is byte-identical to before (tenant menu +
  permissions unchanged).

## 5. PIC PENDING BEHAVIOR

* `/dashboard` and `/dashboard/pic` load (layout admits on the platform role).
* Show **“Profil PIC Menunggu Persetujuan”** — “…masih menunggu persetujuan admin. Setelah
  disetujui, fitur Event Saya, Referral, dan Pendapatan akan tersedia.”
* No self-service rows in the menu (`hasActivePicProfile` stays false), no fee/referral/
  attribution surface, and no other PIC's data: the notice reads only the caller's own profile
  *status*; every data read still fails `requireMyPic` (NOT_FOUND without an ACTIVE profile).

## 6. PIC ACTIVE BEHAVIOR

* Unchanged. The layout probes `findActivePicProfile` for PIC-role accounts (and for any
  first-pass-denied account), sets `hasActivePicProfile`, and the four self-service items
  remain: **Ringkasan PIC · Event Saya · Referral · Pendapatan**.

## 7. DISABLED-ACCOUNT BEHAVIOR

`User.disabledAt` (Phase 33) is enforced in `resolveAuthzScope`, which returns `null` — the
layout redirects to `/login` and no capability is computed. Verified for a disabled MANAGER
and a disabled PIC (the PIC's ACTIVE profile row is left untouched; the *account* dimension
closes it). The DB is re-resolved per request, so a stale JWT cannot re-open it.

## 8. TENANT-ISOLATION PROOF

Asserted against the real database:

* MANAGER with no membership → `listDashboardOrders(scope, { organizerId })` →
  `ORGANIZER_ACCESS_DENIED` (404-shaped), and the refusal is a real `AppError`.
* ADMIN with no membership → same refusal for a named tenant.
* `tenant-isolation.integration.test.ts`, `order-ownership-404`, and the role-matrix
  cross-tenant cases all pass unchanged.

Entry never creates an `OrganizerMember` and never spans a tenant: `canEnterDashboard` only
decides whether the **shell** renders.

---

## 9. TESTS

`npm test` → **115 suites, 2256 tests, all passing** (2 snapshots).

New: `__tests__/auth-flow/phase34-dashboard-entry-gate.integration.test.ts` (16 tests) covers:
ADMIN entry; MANAGER-no-membership entry with no tenant/user/system surface (menu = exactly
`/dashboard`); MANAGER isolation refusal; PIC PENDING/ACTIVE/SUSPENDED/REJECTED entry vs.
self-service; `findPicProfileStanding`; CUSTOMER refusal; disabled MANAGER/PIC; and the exact
standing-notice copy (no generic denial string).

Updated the suites that pinned the OLD semantics (role-matrix, dashboard-access, PIC entry,
menu builder, branding wiring) to the Phase 34 semantics — the assertions were changed to the
correct new behavior, not weakened.

**Re-verification on the final tree (post Phase 35/36):** `npm test` → **116 suites, 2270
tests, all passing** (2 snapshots) — includes the Phase 34 gate suite, the later
`phase36-entry-vs-data-access` suite (entry ≠ tenant read, `requireMyPic` ACTIVE-only,
cross-PIC denial, disabled-account null scope) and the tenant-isolation / role-matrix /
login-routing / route-inventory / `dashboard-table-keys` suites. The implementation files of
Phase 34 were unchanged by later phases; the gate and the standing states verified byte-identical.

## 10. TSC

`npx tsc --noEmit` → clean (exit 0).

## 11. LINT

`npm run lint` → 0 errors, 4 pre-existing warnings (unrelated `<img>` and a script var).

## 12. BUILD

`npm run build` → **successful** (compiled, type-checked, route table emitted).

> Note: the first build failed on a *generated* `.next/dev/types/validator.ts` (`TS1128`,
> a truncated block from an earlier `next dev` run). `.next/` is gitignored build output, so
> it was removed and the clean rebuild succeeded. This was a stale-artifact issue, not a code
> defect.

## 13. MANUAL SMOKE TEST STATUS

**Rerun as a genuine live browser smoke on the final tree (headless Chromium over the DevTools
Protocol against `next dev`), using the repo's established verification pattern
(`scripts/verify-phase33-live.js`): the known admin account creates throwaway `@example.test`
MANAGER + PIC rows through `/api/admin/users`, each is logged in through the real credentials
callback, and the rendered pages are asserted in the browser.** All **20 checks PASS**:

| Step | Live result |
| --- | --- |
| ADMIN login → creates MANAGER (201) + PIC (201, profile `PENDING`) | PASS |
| MANAGER login → `/dashboard` shows **“Belum Ada Organisasi”**; generic “Akses dashboard ditolak” **absent**; menu has **no** tenant rows (Pesanan/Pembayaran/Pengaturan) | PASS |
| MANAGER direct URL `/dashboard/events`·`/orders`·`/payments`·`/pic` | PASS — each renders the project's explicit no-access state (HTTP 200, per `lib/organizer/context.ts`), with **no tenant-data token** leaked (checked for `Lunas` / `Menunggu bayar` / `dipublikasikan` / `Pembayaran berhasil`) |
| PIC (PENDING) `/dashboard` → **“Profil PIC Menunggu Persetujuan”**, no self-service nav row | PASS |
| PIC approved → re-login → four items **Ringkasan PIC · Event Saya · Referral · Pendapatan** | PASS |
| Browser console on every visited page | PASS — zero React unique-key warnings (`dashboard-table-keys.test.ts` remains the dedicated DataTable/payments assertion and passes in the full suite) |

Smoke fixtures were the phase's own throwaway rows (per the `verify-phase33-live.js`
convention) and were **removed in cleanup**; no pre-existing user/order/organizer row was
touched. The one live-flag nuance: a platform ADMIN's `/dashboard` renders the platform
overview without any membership, and `reksa@gmail.com` (the only user with an ACTIVE
membership) has no discoverable password, so the tenant DataTable page was asserted via the
dedicated key suite rather than a live render.

## 14. GIT STATUS

No commit made. Working tree (this phase's files):

```
 M lib/dashboard/scope.ts
 M app/dashboard/layout.tsx
 M app/dashboard/page.tsx
 M app/dashboard/pic/page.tsx            (my hunk: the PIC standing branch)
 M __tests__/authz/role-matrix.integration.test.ts
 M __tests__/auth-flow/dashboard-access.integration.test.ts
?? components/dashboard/AccountStandingNotice.tsx                          (new)
?? __tests__/auth-flow/phase34-dashboard-entry-gate.integration.test.ts    (new)
?? lib/pic/self-service.ts                  (edited; untracked in HEAD)
?? __tests__/pic-self-service/entry.integration.test.ts   (edited; untracked in HEAD)
?? __tests__/pic-self-service/menu.test.ts                (edited; untracked in HEAD)
?? __tests__/admin-manager/branding-and-wiring.test.ts    (edited; untracked in HEAD)
```

The repo already carried a large uncommitted working tree before this phase (the earlier
Phase 31/32/33 work); none of it was reverted or committed.

---

**NO COMMIT**
**NO PUSH**
**NO DB RESET**
**NO DESTRUCTIVE MIGRATION**
