# ROLE → CAPABILITY AUDIT REPORT

**Scope:** why `/dashboard` showed `Platform · ADMIN` with only **Dashboard, PIC,
Pengaturan**, and whether the role/capability mapping is broken.
**Verdict:** the navbar and the mapping are **correct**. The missing menus were a missing
**tenant membership** (a data/bootstrap gap), not a code bug. The fix is an idempotent
bootstrap, not a capability change.

No commit, no push, no new role, no enum change, no payment/refund/order logic touched, and
no change to the authorization code.

---

## 1. Database roles found

There are **three independent role dimensions**. They are not interchangeable, and the
original suspicion (`User.role` = `CUSTOMER/ADMIN/MANAGER/PIC`) was a conflation: that enum
is `platformRole`, not `role`.

| Column | Enum | Values | Authority? |
| --- | --- | --- | --- |
| `User.role` | `Role` | `ADMIN, SELLER, CUSTOMER, AFFILIATOR` | **No** — legacy retail, dormant. Only the unused `requireAdminSession()` (`lib/csrf.ts:136`) reads it. |
| `User.platformRole` | `PlatformRole` (nullable) | `CUSTOMER, ADMIN, MANAGER, PIC` | **Yes** — this is what `lib/authz` reads. `NULL` resolves to `CUSTOMER`. |
| `OrganizerMember.role` | `OrganizerMemberRole` | `OWNER, ADMIN, MANAGER, FINANCE, PIC, CHECKIN_STAFF` | Tenant capability source, gated by `OrganizerMember.status ∈ {INVITED, ACTIVE, SUSPENDED, REVOKED}`. |

References audited: `User.role`, `User.platformRole`, `PlatformRole`,
`OrganizerMemberRole`, `platformRole`, `resolveAuthzScope`,
`computeDashboardCapabilities`, `decidePlatformPermission`, `decideOrganizerPermission`,
`canReadEvents`, `canReadOrders`, `canReadPayments`, `canAssignPic`,
`canManagePlatformPic`, `canReadReports`, `canManageVenues`.

The one **wrong assumption to discard**: `User.role` and `User.platformRole` are
independent. A ticketing `MANAGER` is a legacy `Role.CUSTOMER`; a legacy `Role.ADMIN`
grants nothing in ticketing. Nothing live uses the legacy column for authorization.

---

## 2. Role → authz mapping (unchanged by this task)

Authority is the **intersection rule** (`lib/authz/permissions.ts`): an organizer-scoped
permission needs **both** a capability source **and** an ACTIVE membership scope.

**Platform-scope capability (`decidePlatformPermission`)**

| platformRole | Platform permissions |
| --- | --- |
| `ADMIN` | `sport.manage`, `venue.manage.global`, `pic.manage`, `user.manage`, `role.manage`, `platform.config`, `audit_log.read` |
| `MANAGER` | `audit_log.read` only |
| `PIC` / `CUSTOMER` | none |

**Organizer-scope capability (`decideOrganizerPermission`, requires ACTIVE membership)**

| platformRole | Tenant capability inside a member organizer |
| --- | --- |
| `ADMIN` | event read/write/publish/banner, venue, ticket-type write/quota/price, order read/cancel, payment read, refund request/approve, PIC assign, PIC attribution/fee read, check-in, report transaction/event-sales read. Financial perms withheld (`ADMIN_GRANT_REQUIRED`). |
| `MANAGER` | the above **plus** payment reconcile, refund execute, fee rate/adjust/mark-paid, settlement prepare/approve/proof, financial exports. |
| `PIC` / `CUSTOMER` | none |

**Own-scope capability (`decideOwnResourcePermission`)**

- `PIC`: order/payment read own, PIC attribution/fee read own, own-PIC-fee export, ticket read/issue own, refund request own.
- `CUSTOMER`: order read/cancel own, payment read own, ticket read/issue own, refund request own.

**Membership-role map:** `OWNER`, `MANAGER`, `FINANCE`, `PIC`, `CHECKIN_STAFF` are
mapped. `OrganizerMemberRole.ADMIN` is **deliberately unmapped** (D-05: the tenant-admin
tier was collapsed into `OWNER` + platform `ADMIN`) and contributes zero capability.

**Grant gate:** for platform `ADMIN`, `ADMIN_GRANT_REQUIRED` permissions
(`payment.reconcile`, `refund.approve`, `fee.rate.change`, `fee.adjust`,
`settlement.approve`, `report.export.*`) require an explicit `PermissionGrant` even when a
membership exists. A membership cannot escalate an ADMIN past this.

`ORGANIZER_SPANNING_PLATFORM_ROLES` is **empty**: no platform role reaches a tenant
without a membership. This is the isolation guarantee and it was preserved.

---

## 3. Root cause — why ADMIN saw only 3 menus

Traced flow (verified against the live DB, not just by reading code):

```
User.platformRole = "ADMIN"
  → auth()/JWT (platformRole mirrored; scope re-resolved from DB per request)
  → resolveAuthzScope(userId)         // organizerScopes: []
  → computeDashboardCapabilities()    // tenant booleans all false
  → DashboardAppShell menu            // Dashboard + PIC + Pengaturan
```

Empirical state before the fix:

```json
{
  "user": { "email": "reksa@gmail.com", "role": "ADMIN", "platformRole": "ADMIN" },
  "scope": { "platformRole": "ADMIN", "organizerScopes": [], "grants": [] },
  "capabilities": {
    "canManageSports": true, "canManageGlobalVenues": true, "canManagePlatformPic": true,
    "canReadEvents": false, "canManageEvents": false, "canReadOrders": false,
    "canReadPayments": false, "canAssignPic": false, "canManageVenues": false,
    "canReadReports": false, "hasTenantAccess": false
  }
}
```

Menu gating (`DashboardAppShell.tsx:94-189`):

| Menu | Capability | ADMIN value (no membership) |
| --- | --- | --- |
| Dashboard | unconditional | **shown** |
| Event | `canReadEvents` (membership) | hidden |
| Pesanan / Pelanggan / Refund | `canReadOrders` (membership) | hidden |
| Pembayaran | `canReadPayments` (membership) | hidden |
| PIC | `canAssignPic \|\| canManagePlatformPic` | **shown** (platform) |
| Laporan | `canReadReports` (membership) | hidden |
| Venue | `canManageVenues` (membership) | hidden |
| Pengaturan | `canManageSports \|\| canManageGlobalVenues \|\| canManageVenues` | **shown** (platform) |

Why `organizerScopes` was empty: **the `organizer` and `organizermember` tables were
empty**. No `Organizer` row (design B12 "one Organizer (TinggalKlik.Co)" was never seeded),
no membership row for the admin, and the app has **no organizer-creation flow**. Therefore
`hasOrganizerPermission()` iterated an empty list and every tenant boolean was false — the
correct, contract-defined result.

This is **not** navbar gating, **not** a `platformRole` resolution failure, **not** a
legacy-session issue, and **not** a wrong field read. It is the missing scope half of the
intersection rule.

---

## 4. Capability ADMIN before / after

| Capability | Before fix | After fix |
| --- | --- | --- |
| `canManageSports` | true | true |
| `canManageGlobalVenues` | true | true |
| `canManagePlatformPic` | true | true |
| `canReadEvents` | **false** | **true** |
| `canManageEvents` | false | **true** |
| `canReadOrders` | **false** | **true** |
| `canReadPayments` | **false** | **true** |
| `canAssignPic` | **false** | **true** |
| `canManageVenues` | **false** | **true** |
| `canReadReports` | **false** | **true** |
| `hasTenantAccess` | **false** | **true** |

Resulting menu: Dashboard, Event, Pesanan, Pelanggan, Pembayaran, Refund, PIC, Laporan,
Venue, Pengaturan — every destination the existing contract allows the platform ADMIN that
is also an ACTIVE owner of the sole organizer.

Note the restored tenant surfaces come from **`PLATFORM_ROLE_ORGANIZER_PERMISSIONS.ADMIN`**
(the platform-role map), not from inventing permissions. The membership role `OWNER` adds
`refund.execute` (not grant-gated); all grant-gated financial power remains withheld.

---

## 5. Capability MANAGER

- **platformRole `MANAGER` + ACTIVE membership:** tenant surfaces per
  `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.MANAGER` → `canReadEvents`, `canManageEvents`,
  `canReadOrders`, `canReadPayments`, `canAssignPic`, `canManageVenues`, `canReadReports`
  are true; **no platform master data** (`canManageSports/GlobalVenues/PlatformPic` false).
- **platformRole `MANAGER` without a membership:** refused at the entry gate
  (`canEnterDashboard === false`) — audit-only is not a dashboard surface.
- **Privilege escalation:** `user.manage`, `role.manage`, `platform.config` are denied for
  MANAGER regardless of membership.

## 6. Capability PIC

- All dashboard capabilities false → **cannot enter `/dashboard`**.
- No platform permission (`pic.manage`, `sport.manage` denied).
- Authority is own-scope only (`order.read.own`, `payment.read.own`,
  `pic_attribution.read.own`, `pic_fee.read.own`, `ticket.read.own`, `ticket.issue.own`,
  `refund.request.own`), enforced by `decideOwnResourcePermission` against the record owner.

## 7. Capability CUSTOMER

- All dashboard capabilities false → **cannot enter `/dashboard`** (only the public/buyer
  surfaces).
- Own-scope only (`order.read.own`, `order.cancel.own`, `payment.read.own`,
  `ticket.read.own`, `ticket.issue.own`, `refund.request.own`); another user's record is
  denied.

---

## 8. Does ADMIN need an organizer membership?

**Yes — by explicit design, not as a navbar workaround.** Launch is single-organizer
(D-05: TinggalKlik.Co is the sole organizer), and the design requires the operator's
platform ADMINs to be ACTIVE members/owners of it. The authorization layer refuses to
derive tenant authority from a platform role alone, because that would be a hidden
privilege grant and would break per-tenant isolation. The rejected alternative — adding
`ADMIN` to `ORGANIZER_SPANNING_PLATFORM_ROLES` — would let an ADMIN read **every** tenant
without membership, weaken §7.4/§16 isolation, and contradict the pinned test
"a platform role confers NO tenant data".

The contract is not weakened: an ADMIN with a membership still cannot touch
grant-required financial actions, and an ADMIN without a membership still reads no tenant.

---

## 9. Files changed

**New**
- `prisma/seed-organizer.ts` — idempotent, deterministic, non-destructive bootstrap that
  ensures (a) the single `Organizer` (`slug: tinggalklik`, owner = oldest platform ADMIN)
  and (b) one ACTIVE `OWNER` `OrganizerMember` per platform ADMIN.
- `__tests__/authz/role-matrix.integration.test.ts` — 15 tests over the real DB plus a
  server-rendered menu check.

**Modified**
- `package.json` — added `"seed:organizer": "npx tsx prisma/seed-organizer.ts"`.

**Live database (data, not schema)**
- Created `Organizer` `TinggalKlik.Co` (`slug: tinggalklik`, `status: ACTIVE`,
  `ownerUserId = reksa@gmail.com`).
- Created `OrganizerMember` `(organizer, reksa) role=OWNER status=ACTIVE`.

**Deliberately NOT changed**
- `lib/authz/permissions.ts` (capability maps, `ADMIN_GRANT_REQUIRED`,
  `ORGANIZER_SPANNING_PLATFORM_ROLES` still empty).
- `lib/dashboard/scope.ts`, `components/dashboard/DashboardAppShell.tsx`,
  `app/dashboard/layout.tsx` (navbar).
- `prisma/schema.prisma` and every enum.
- Legacy `User.role` and the unused `requireAdminSession()`.

---

## 10. Test result

- New suite: `__tests__/authz/role-matrix.integration.test.ts` — **15/15 pass**. Covers:
  ADMIN with/without membership; ADMIN financial grant gate; MANAGER with/without
  membership; MANAGER escalation denial; PIC and CUSTOMER denial and own-scope; SUSPENDED
  membership denied; unmapped `OrganizerMemberRole.ADMIN`; cross-tenant read denied;
  denial is a real `AppError`; **and menu visibility** asserted by rendering
  `DashboardAppShell` and reading the destination hrefs for each capability set.
- Full suite: **49 suites / 1122 tests pass** (baseline 48 / 1107 ⇒ +1 suite / +15 tests).
  No existing test removed or weakened; the pinned isolation test still passes.

## 11. TypeScript result

`npx tsc --noEmit` — **0 errors**.

## 12. Build result

`npm run build` — **exit 0**, `✓ Compiled successfully`; all 16 `/dashboard/*` routes
compiled.

## 13. Lint result

`npm run lint` — **27 errors, 20 warnings**, identical to the pre-task baseline (the 27
errors are the pre-existing `require()`-import errors in tests outside this change). The
two new files introduce **no** new lint output.

---

## 14. Security / tenant-isolation verification

- **No spanning introduced:** `ORGANIZER_SPANNING_PLATFORM_ROLES` is still empty.
- **ADMIN without membership** still reads no tenant (test), and a forged `organizerId`
  still returns `ORGANIZER_ACCESS_DENIED` (404-shaped).
- **Grant-required financial actions** are still denied to an ADMIN even with an ACTIVE
  OWNER membership (D-19 preserved).
- **MANAGER does not become platform admin; PIC gains no platform permission; CUSTOMER
  gets no dashboard surface.**
- **SUSPENDED membership** confers nothing; the scope still resolves but the decision
  denies.
- **Tenant isolation unchanged:** `resolveOrganizerFilter` / `listDashboardOrders` still
  derive the filter only from ACTIVE memberships; a named non-member organizer is refused.
- **Menu hiding is not a security boundary:** the menu is rendered from the same deciders
  the services use, and every page/API re-decides independently.
- **Legacy `User.role`** is not consulted anywhere live.

**Session/cache:** no re-login or cache flush is required. `getAuthzScope()` calls
`resolveAuthzScope()` from the DB on every request; the JWT copy (`authzScopeRefreshedAt`,
≤60 s TTL) powers display only and is refreshed for the platform role. The admin's JWT
`platformRole` was already `ADMIN`; the newly added membership is picked up immediately by
the fresh per-request scope.

---

## 15. Kesimpulan

1. The navbar and role→capability mapping were **already correct**; no navbar or
   authorization code was changed.
2. The real cause was **data**: no organizer and no `OrganizerMember`, so the intersection
   rule (capability **and** ACTIVE scope) correctly produced zero tenant capability — hence
   Dashboard + PIC + Pengaturan.
3. `User.role` is a dormant legacy enum; `User.platformRole` is the operative authority
   column. They are not related.
4. Fixed by implementing the design's missing B12 bootstrap (`npm run seed:organizer`):
   the sole `Organizer` and an ACTIVE `OWNER` membership for platform ADMINs. The ADMIN now
   sees every menu the existing contract permits.
5. Tenant isolation, the grant gate (D-19), and `OrganizerMemberRole.ADMIN`'s unmapped
   status are all preserved and now pinned by tests.
