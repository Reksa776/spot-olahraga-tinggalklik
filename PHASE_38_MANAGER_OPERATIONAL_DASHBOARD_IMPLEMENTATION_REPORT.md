# PHASE 38 — MANAGER DASHBOARD OPERATIONAL LIKE ADMIN (WITHOUT PLATFORM CONTROL)

**Status:** IMPLEMENTED — audited first, smallest correct change, uses the existing
permission/membership architecture only. No new permission system, no new role, no
organizer-onboarding system, no schema change, no migration.
**Verified:** full suite **117 suites / 2274 tests / 0 failures**; `tsc --noEmit` clean;
`eslint` 0 errors; `next build` clean; live smoke vs `next dev` :3000 — 9/9 PASS.
**Safety:** NO COMMIT · NO PUSH · NO DB RESET · NO DESTRUCTIVE MIGRATION.

---

## 1. EXACT ROOT CAUSE

A freshly created MANAGER logged in, passed the Phase 34 entry gate, but saw only
"Belum Ada Organisasi" — an empty dashboard. The **operational capability was already
complete**: `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.MANAGER` and
`MEMBERSHIP_ROLE_PERMISSIONS.MANAGER` both carry the full tenant operational permission
set, and the menu is already capability-driven (`components/dashboard/DashboardAppShell.tsx`).

The blocker is the **D-05 intersection rule**: every tenant-scoped permission resolution in
`lib/authz/permissions.ts` (`decideOrganizerPermission`) requires an **ACTIVE
`OrganizerMember`** and refuses *before* consulting the role map when none exists:

- Phase 33 (`createManagedUser`) created MANAGER/PIC `User` rows only — never a membership.
- `resolveAuthzScope` builds `organizerScopes` from memberships → empty for a fresh MANAGER.
- `hasTenantAccess` (and every tenant capability) → `false` → overview shows the standing notice.

No edit to either permission map can fix this — membership is the sole gateway. PIC is
unaffected by design (it owns a per-event schedule, not an organizer).

## 2. APPLIED FIX — WHAT CHANGES

**Create-time provisioning via the existing `OrganizerMember` mechanism** (no new system):

1. `lib/admin/users.ts` — `createManagedUser`, MANAGER branch: when creating a MANAGER, the
   transaction now also provisions ACTIVE `role:"MANAGER"` memberships in every
   **platform-owned organizer** = ACTIVE organizers where a non-disabled platform ADMIN holds
   an ACTIVE OWNER membership (the same anchor the bootstrap seed relies on; captured in a new
   `resolvePlatformOrganizerIds(tx)` helper). **Fail-closed:** if no platform organizer
   resolves, the account is still created with no membership and the honest standing notice
   remains. Returns `{ created, membershipOrganizerIds }`; audit `afterState` now records the
   provisioned organizer ids. PIC creation is untouched.
2. `prisma/seed-organizer.ts` — same rule applied as an idempotent backfill for pre-existing
   MANAGER accounts (keyed `organizerId_userId`; existing rows are never modified; non-destructive).
3. No schema/migration/role/permission changes anywhere else.

## 3. MANAGER MENU NOW (operational, capability-driven — unchanged from the full map)

`/dashboard` · `/dashboard/events` (PASS/FAIL/AUTO) · `/dashboard/check-in` ·
`/dashboard/orders` · `/dashboard/customers` · `/dashboard/payments` ·
`/dashboard/refunds` · `/dashboard/settlements` · `/dashboard/pic` · `/dashboard/reports`
· `/dashboard/venues` · `/dashboard/settings`.

## 4. ADMIN-ONLY — STILL DENIED TO MANAGER (server-side, direct-URL safe)

| Route | Behaviour for MANAGER |
| --- | --- |
| `/dashboard/users` | `requirePlatformPermission(user.manage)` → "Akses ditolak" (200 + denial panel) |
| `/dashboard/settings/application` | platform permission → "Akses ditolak" |
| `/dashboard/settings/branding` | `requirePlatformPermission(branding.manage)` → "Akses ditolak" |
| `/dashboard/settings/maintenance` | platform permission → "Akses ditolak" |
| `/dashboard/settings/sports` · `/dashboard/settings/venues` | platform permission → "Akses ditolak" |
| `/dashboard/settings/roles`, `/dashboard/settings/platform` | no such route → 404 |

The 6 listed permissions (`user.manage`, `role.manage`, `platform.config`,
`application_settings`, `maintenance.manage`, `branding.manage`) are absent from the MANAGER
maps and asserted `allowed: false` in the regression suite. ADMIN "full access" behaviour is
unchanged (spot-checked live). `GET /api/admin/users` → 403 for MANAGER.

## 5. FILES CHANGED (Phase 38 only)

| File | Change |
| --- | --- |
| `lib/admin/users.ts` | `createManagedUser` now provisions ACTIVE MANAGER memberships in platform-owned organizers (fail-closed); `resolvePlatformOrganizerIds(tx)` helper; richer audit `afterState`; doc block. Existing transfers/updates untouched. |
| `prisma/seed-organizer.ts` | Idempotent backfill: every `platformRole=MANAGER` also gets ACTIVE MANAGER membership in the bootstrap organizer; existing rows never mutated. |
| `__tests__/admin-manager/user-management.integration.test.ts` | `afterAll` deletes `OrganizerMember` rows **before** users (`onDelete: Restrict`). |
| `__tests__/auth-flow/phase38-manager-operational.integration.test.ts` | **NEW** regression suite (4 tests): provisioning + operational capability/menu, platform-permission denials, isolation vs an unrelated organizer (`ORGANIZER_ACCESS_DENIED` + `listDashboardOrders` refusal), PIC untouched, and the Phase 34 raw MANAGER contract preserved (no membership → menu `["/dashboard"]`). |

## 6. TESTS

- New `phase38-manager-operational` suite: **4/4 pass**.
- `__tests__/auth-flow`, `__tests__/authz`, `__tests__/pic-self-service`,
  `__tests__/admin-manager`: **28 suites / 490 tests pass**.
- Full suite: **117 suites / 2274 tests / 0 failures** (Phase 37 baseline 2270 + 4 new).

## 7. TYPECHECK — `npx tsc --noEmit` → clean.

## 8. LINT — `npm run lint` → 0 errors (4 pre-existing warnings in unrelated files).

## 9. BUILD — `npm run build` → clean (all dashboard routes emit).

## 10. LIVE SMOKE — 9/9 PASS vs `next dev` :3000

ADMIN login → POST `/api/admin/users` creates MANAGER → membership `MANAGER/ACTIVE@tinggalklik`
provisioned → MANAGER login → **all 12 operational surfaces render 200** (no standing notice, no
denial) → **all 6 admin-only surfaces render the "Akses ditolak" panel** (`roles`/`platform` 404) →
ADMIN `/dashboard/users` unchanged → MANAGER `/dashboard/pic` intact. Fixtures cleaned up (0 rows
left). Existing accounts `manager1@gmail.com` / `pic2@gmail.com` backfilled via seed (non-destructive).

## NOTES & CAVEATS

- The seed also synced `phase33-verify-admin` an OWNER membership (its documented role) — dev DB only.
- Tests run against `<db>_test` (jest config); the suite builds its own platform anchor so it is
  deterministic and independent of the dev bootstrap state.
- Replaces the Phase 34-era empty-organizer MANAGER screen only for accounts created (or backfilled)
  after this phase. A MANAGER with genuinely no eligible platform organizer still honestly sees
  "Belum Ada Organisasi".
- **NO COMMIT · NO PUSH · NO DB RESET.** All Phase 38 changes are uncommitted working-tree changes,
  consistent with the existing Phase 29–36 uncommitted baseline.