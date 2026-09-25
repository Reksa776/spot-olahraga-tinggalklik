# PHASE 33 — FINAL MULTI-ROLE AUTHORIZATION AUDIT + USER MANAGEMENT + PIC ACCOUNT FLOW

**Status: IMPLEMENTED AND VERIFIED.**

Explicit safety statement (brief §AE): **no commit, no push, no DB reset, no destructive
migration, no business data deletion.** The only schema change is one additive nullable
column; the test database was migrated through `npm run test:db:setup` only; the
development database was never reset (it carries pre-existing drift from earlier phases —
see §24 — and `prisma migrate dev` was aborted precisely because it demanded a reset,
which this phase forbids).

---

## 1. Existing role architecture (as audited, from source)

| Dimension | Column | Authority | Source |
|---|---|---|---|
| Platform role | `User.platformRole` (nullable, `CUSTOMER/ADMIN/MANAGER/PIC`) | THE authoritative platform dimension; NULL resolves to CUSTOMER | `lib/authz/scope.ts#resolveAuthzScope` |
| Legacy retail role | `User.role` (`Role` enum) | DORMANT. Nothing in ticketing reads it. Kept because the session contract types it and dropping the enum would be a destructive migration | schema comments, `lib/authz/scope.ts` |
| Tenant role | `OrganizerMember.role` (`OWNER/ADMIN/MANAGER/FINANCE/PIC/CHECKIN_STAFF`) | Scoped to one organizer; only ACTIVE memberships confer capability | `lib/authz/permissions.ts` |
| Financial grants | `PermissionGrant` | Satisfies D-19 ONLY for ADMIN and only for `ADMIN_GRANT_REQUIRED` permissions | `grantApplies()` |
| App control | `application.settings`, `maintenance.manage`, `branding.manage` | PLATFORM scope, ADMIN-only, absent from all other maps and from `ADMIN_GRANT_REQUIRED` | Phase 32 |
| **User management** | `user.manage` | PLATFORM scope, ADMIN-only (Phase 33) | `lib/authz/permissions.ts` |

The two role dimensions are **never collapsed**: a platform role alone confers zero tenant
data (an ADMIN with no membership reads nothing), and a tenant membership confers no
platform power (`OrganizerMemberRole.ADMIN` is unmapped → fail-closed, D-05).

## 2. Final role matrix

Legend: ✅ = holds by role · 💰 = holds only with an explicit D-19 `PermissionGrant` (ADMIN)
· ❌ = never. "Tenant" columns assume an ACTIVE membership in that tenant (the intersection
rule — capability AND scope, never either alone).

| Role | Platform access | Tenant ops | Own resources | Event | Order | Payment | Refund | Check-in | PIC | Report | Settlement | **User mgmt** | Role mgmt | Branding | Maintenance | App settings |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **CUSTOMER** | — | — | ✅ own only | browse | ✅ own | ✅ own | ✅ request own | — | — | — | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| **ADMIN** | full + system | ✅ (membership) | ✅ own | ✅ | ✅ | ✅ read | approve 💰 | ✅ | ✅ manage/assign | ✅ read | prepare 💰 / approve 💰 | ✅ **NEW** | ✅ | ✅ | ✅ | ✅ |
| **MANAGER** | audit read only | ✅ (membership) | ✅ own | ✅ | ✅ | ✅ + reconcile | ✅ full | ✅ | ✅ assign | ✅ + exports | ✅ full SoD | ❌ **NEW** | ❌ | ❌ | ❌ | ❌ |
| **PIC (platform)** | — | — | ✅ own + PIC own | — | ✅ own | ✅ own | ✅ request own | — | ✅ own fee/attribution/export | — | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| Org OWNER | — | full in own tenant | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ + exports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Org MANAGER | — | full in own tenant | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ + exports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Org FINANCE | — | finance only | ✅ | read | ✅ | ✅ | ✅ | ❌ (log read) | read attribution/fees | ✅ + exports | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Org PIC | — | attribution read only | ✅ | — | — | — | — | — | read-all attribution | — | — | ❌ | ❌ | ❌ | ❌ | ❌ |
| Org CHECKIN_STAFF | — | scan only | ✅ | — | — | — | — | ✅ scan + log | — | — | — | ❌ | ❌ | ❌ | ❌ | ❌ |

Source of every cell: `PLATFORM_ROLE_PLATFORM_PERMISSIONS`,
`PLATFORM_ROLE_ORGANIZER_PERMISSIONS`, `PLATFORM_ROLE_OWN_PERMISSIONS`,
`MEMBERSHIP_ROLE_PERMISSIONS` in `lib/authz/permissions.ts`; guards in
`lib/authz/guards.ts`; UI capability derivation in `lib/dashboard/scope.ts`.

## 3–7. Role capability summaries

**ADMIN — System Owner + Full Operations.** Everything MANAGER has inside a tenant it
holds a membership in, plus platform master data (sports, global venues), PIC platform
management, audit log, the Phase 32 application controls, and (Phase 33) user management.

**MANAGER — Full Operations, zero system control.** Holds the full operational tenant set
including financial preparation/approval/execution and exports **by role** (D-19's
"Manager holds by role" asymmetry). Holds none of: `user.manage` (new), `role.manage`,
`platform.config`, `sport.manage`, `venue.manage.global`, `pic.manage`,
`application.settings`, `maintenance.manage`, `branding.manage`.

**CUSTOMER** — own-scope buyer capabilities only (`order.read.own`, `order.cancel.own`,
`payment.read.own`, `ticket.read.own`, `ticket.issue.own`, `refund.request.own`).

**PIC (platform role)** — own-scope buyer capabilities (same as customer except
`order.cancel.own`, deliberately withheld) **plus** `pic_attribution.read.own`,
`pic_fee.read.own`, `report.export.own_pic_fee`.

**Tenant roles** — see matrix; every one is confined to its own organizer by the
membership gate (`decideOrganizerPermission` returns `ORGANIZER_ACCESS_DENIED` → HTTP 404
for a non-member, so cross-tenant probing learns nothing).

## 8. Current PIC menu audit (the "Tambah PIC" question)

Classification of the existing surfaces, proven from source:

| Surface | File | What it actually does |
|---|---|---|
| "Tambah PIC" form | `components/platform/PicManager.tsx` → `POST /api/admin/pic` → `createPic()` | **Creates a PICProfile only.** Requires an EXISTING account by email (`"Belum ada akun dengan email tersebut. Minta PIC mendaftar akun terlebih dahulu."`). Does NOT create a User, does NOT create login credentials, does NOT assign events, does NOT send credentials. |
| Status controls | same component → `PATCH /api/admin/pic/[id]` | PENDING→ACTIVE (approval stamps `approvedAt/By`), SUSPENDED (records reason), REJECTED. |
| Assignment | `components/organizer/PicAssignmentManager.tsx` → `assignPicToEvent()` | Organizer-scope `pic.assign`; refuses non-ACTIVE profiles; `(picProfileId,eventId)` unique → reactivate-not-duplicate. |
| PIC self-service | `app/dashboard/pic/page.tsx` (3rd branch) → `lib/pic/self-service.ts` | Own profile / assigned events / referral links / attributions / fee ledger — all own-scope, session-derived. |

So the historical answer to the brief's final question #1 is: **the existing menu created a
PICProfile only — never a login.** The UI copy already said so honestly ("Profil PIC
ditautkan ke akun yang sudah terdaftar"), but the *account* half had no management surface
at all, which is what Phase 33 adds.

## 9. PICProfile ↔ User relationship (all 20 brief questions, from source)

1. Belongs to User? **Yes** — `PICProfile.userId` FK.
2. 1:1? **Yes** — `userId @unique`, `onDelete: Cascade`.
3. Does creating a profile create a User? **No** (pre-Phase 33 it refused unknown emails).
4. Only attaches metadata to an existing User? **Yes** — that was the entire old flow.
5. Can a CUSTOMER become PIC? **Yes** — that was the only path (link existing account).
6. Did platformRole change CUSTOMER→PIC? **NO — this was the audit's real defect.**
   Nothing in the codebase ever set `platformRole = PIC`. Consequence: a customer given a
   profile entered the self-service dashboard (the layout admits on the ACTIVE *profile*)
   but `Pendapatan` (fee summary/ledger) returned FORBIDDEN, because own-scope
   permissions resolve against the PLATFORM role and the CUSTOMER map withholds
   `pic_fee.read.own` / `pic_attribution.read.own`. **Fixed** (see §14).
7. PIC login = same User auth? **Yes** — credentials login in `auth.ts` is the only auth;
   PICProfile holds no credentials.
8. Does a PIC need platformRole=PIC? **For the fee/attribution families, yes** — the
   role map is the capability source. Now guaranteed at creation.
9. Can a PIC also be CUSTOMER? **Yes** — same account keeps all own-scope buyer powers
   (the PIC map is a superset for buying; only `order.cancel.own` is withheld).
10. Can a PIC own customer orders? **Yes** — orders reference `userId`; role change moves nothing.
11. Both customer and PIC capabilities on one User? **Yes** — pinned by test.
12. What happens to existing orders when platformRole changes? **Nothing** — ownership is
    `EventOrder.userId`; the id does not move. Regression-tested (§25).
13. Old menu created User/PICProfile/Assignment/all three/one? **One: PICProfile only.**
14. Can a PIC exist without a login? **Not through any surface** — the old flow required
    an account; Phase 33's new flow creates both atomically. (A raw DB row could, but no
    code path does.)
15. A login without PICProfile? **Yes** — every ordinary customer.
16. Assignment before login exists? **Assignment requires an ACTIVE profile, which
    requires a linked account** — so no (and that ordering is safe).
17. Attribution linkage: `PICAttribution.orderId` UNIQUE → `picProfileId`; the profile,
    not the user, is the attribution subject.
18. Referral: HMAC-signed token `p1:{picProfileId}:{eventId}` minted only for ACTIVE
    assignments (`lib/pic/referral.ts` fail-closed on missing secret); checkout resolver
    re-checks profile ACTIVE + assignment active against current rows.
19. PIC sees the dashboard via `hasActivePicProfile` (layout probes DB only for
    first-pass-denied actors, session-derived id only).
20. Suspension/revocation: profile SUSPENDED → not assignable, entry gate closes,
    checkout resolver rejects tokens; account disabled (Phase 33) → scope NULL → every
    guard denies. Dimensions stay separate (§O below).

## 10. PIC login flow (audited + fixed)

Login uses the ordinary credentials form → `authorize()` → JWT → callback. Post-login
routing admits a pure PIC to `/dashboard` through the profile probe; the menu renders the
four self-service rows (Ringkasan PIC, Event Saya, Referral, Pendapatan) and nothing else.
Server enforcement is the four-step `requireMyPic` guard (session → identity → ACTIVE
profile → own-scope decider); a PIC requesting another PIC's records gets
`PIC_ACCESS_DENIED`, and no self-service function accepts a `picProfileId` from the
caller. The Phase 33 fix completes the flow: `platformRole=PIC` is now set at profile
creation, so `Pendapatan` no longer 403s for converted customers (previously Event Saya
rendered but the fee family was refused — the exact "half-broken PIC" the audit found).

## 11. Customer → PIC behavior

The transition is **same-account promotion**, never duplication: `createPic` (existing
account flow) and `createManagedUser(role=PIC)` (new account flow) both leave the User row
the single identity. Orders, tickets, refunds and payment history hang off `userId` and
survive untouched. Regression test
`__tests__/admin-manager/pic-account-role.integration.test.ts` seeds a real PAID order +
ISSUED ticket, converts the buyer to a PIC, and asserts: same user id, order count
unchanged, ticket count unchanged, exactly one User row for the email, and the buyer's own
`ORDER_READ_OWN`/`TICKET_READ_OWN` still resolving. No place in the codebase assumes
`platformRole === CUSTOMER` for own-resource checks — the own map is per-role — so no
customer capability is lost.

## 12. User management implementation (V1)

- **Guard**: `user.manage` (new string, PLATFORM scope) — held only by ADMIN; absent from
  `ADMIN_GRANT_REQUIRED`, so a `PermissionGrant` cannot manufacture it (tested).
- **Service**: `lib/admin/users.ts` — `listManagedUsers`, `createManagedUser`,
  `setManagedUserDisabled`. Fixed `MANAGED_ROLES = ["MANAGER","PIC"]`; the service
  re-checks the union even for direct callers; an ADMIN row can never be a target; an
  ADMIN cannot disable themselves; duplicate email/phone → 409; bcrypt cost-12 via the
  existing `hashPassword`; password never returned or logged; audit uses safe metadata
  only.
- **Fixed role choices**: the Zod contract is `z.enum(["MANAGER","PIC"])` — a body with
  `"role":"ADMIN"` is a VALIDATION_ERROR before the service runs. No permission editing
  exists anywhere in the surface.

## 13. Manager creation flow

`POST /api/admin/users` `{name,email,password,role:"MANAGER"}` → CSRF check → Zod
(password policy = the registration policy: ≥8 chars, upper+lower+digit) → duplicate
check → bcrypt hash → `User` created with `platformRole=MANAGER` (server-decided; legacy
`role` stays CUSTOMER) → audit `user.created`. MANAGER accounts get **no** tenant
membership (that remains a separate organizer-side action) and no system permissions.

## 14. PIC creation flow + the smallest safe correction

Two paths, one invariant (`User` + `PICProfile` consistent, profile starts PENDING, no
event auto-assignment):

1. **New account** (new): `role:"PIC"` in `POST /api/admin/users` → one transaction
   creates `User(platformRole=PIC)` **and** `PICProfile` (code derived/validated, optional
   default rate) → audit `pic.user.created`.
2. **Existing account** (fixed): `POST /api/admin/pic` → `createPic` now sets
   `platformRole=PIC` **in the same transaction** when the account is NULL/CUSTOMER, and
   deliberately never demotes an ADMIN/MANAGER → audit `pic.create` records the role
   transition.

The correction is minimal: no new model, no second auth table, no schema change for this
fix — the target model of brief §G (User → PICProfile → assignments/attribution/ledger)
was already the stored architecture; only the role stamp was missing.

## 15. PIC assignment flow — unchanged (verified)

`assignPicToEvent` still enforces: organizer access derived from the EVENT's `organizerId`
(never a body parameter) + `pic.assign` + profile ACTIVE + `(picProfileId,eventId)`
duplicate protection (reactivate on re-assign) + soft revocation preserving history. No
changes were needed; the new tests cover the create→assign seam (profile starts PENDING,
and only ACTIVE profiles are assignable — so account creation can never leak into
assignment).

## 16. Referral flow — unchanged (verified)

Tokens are minted only for ACTIVE, non-revoked assignments of the caller's OWN profile
(`listMyReferralLinks`, `getMyReferralLink` re-authorize the eventId); unassigned PICs get
no link; the client never picks a `picProfileId`; the HMAC secret contract (fail-closed on
`PIC_REFERRAL_SECRET` unset, constant-time compare, version + event pinned) is untouched.
`__tests__/ticketing-pic/referral.test.ts` passes unchanged.

## 17. Authorization changes

1. `user.manage` added to the vocabulary and the PLATFORM scope map (ADMIN-only).
2. `User.disabledAt` (new, additive) — NULL = active. `resolveAuthzScope` returns **null**
   for a disabled account → dashboard gate, every API guard and every require* path fails
   closed, including open sessions (scope is DB-resolved per request, never read from the
   JWT). `auth.ts` refuses login for a disabled account with the same timing-equalisation
   and rate-limit treatment as a wrong password (no account-state enumeration).
   `findActivePicProfile` / `requireMyPic` additionally require `user.disabledAt = null`,
   so the PIC entry flag honours the account dimension.
3. `createPic` sets `platformRole=PIC` (null/CUSTOMER only) — the defect fix.
4. `canManageUsers` added to `DashboardCapabilities` (menu rendering of decision 1).

## 18. API changes

| Route | Verbs | Guard | Notes |
|---|---|---|---|
| `/api/admin/users` | GET, POST | proxy session + `user.manage` | GET list (role/search/page filters, MANAGER+PIC only); POST create (CSRF, Zod, tx for PIC, audit) |
| `/api/admin/users/[id]` | PATCH | proxy session + `user.manage` | `{disabled:boolean}` only; target restricted to MANAGER/PIC; reversible; audited `user.disabled`/`user.enabled` |

Both are auto-covered by the proxy's existing `/api/admin/` protected prefix (the route
classification test enumerates every route file and still passes). No `/api/admin/users/[id]/disable`
endpoint was needed — one PATCH expresses both directions without duplicating service logic.

## 19. UI changes

- `/dashboard/users` (ADMIN-only; others get the standard `AccessDeniedPanel`): list with
  Name/Email/Role/Account status/PIC profile (code + its OWN status badge)/Created/Actions;
  "Tambah Pengguna" dialog with the fixed two-role select and PIC-only profile fields
  (display name, optional code, optional default rate); disable/enable confirm dialog.
  No ADMIN creation, no permission editing, no delete. Success message states the password
  is never shown again.
- Sidebar "Sistem" section gains the "Pengguna" row (`canManageUsers`); the settings hub
  links it too. MANAGER's sidebar has no such row and the page refuses them directly.
- `DataTable` (primitives) now keys header/cell elements by `columns[i].id` when provided
  (fallback positional), and `TableColumn` documents the new optional `id`.

## 20. DataTable warning root cause

Traced through `DashboardPaymentsPage → DataTable → columns → cells → mapped children`:
the warning did **not** originate from the payments page's cell arrays — every cell there
(already in the committed baseline, verified via `git show HEAD:`) carries a stable key
(`key="ref"|"order"|"method"|…`, row key `payment.id`), and the row map keys on
`payment.id`. The two remaining index-keyed maps inside `DataTable` were its own header
and cell wrappers. React attributes the warning to `DataTable` because that component
performs the mapping — so the fix belongs there, not at any call site.

## 21. DataTable fix

- Header cells: `key={column.id ?? `col-${index}`}`; body cells:
  `key={columns[index]?.id ?? `cell-${index}`}` — stable domain identity when a column
  declares `id`, positional otherwise (documented on the type).
- Regression suite `__tests__/ui-consolidation/dashboard-table-keys.test.ts` renders the
  exact payments-shaped trees (conditional button/span cells, `TextLink`, `StatusBadge`,
  `LinkPagination` footer, empty/loading/error states) through `react-dom/server` and
  fails on any `unique "key"` console.error. All green. Browser-console verification: the
  production build compiles the same element trees the probe renders; the probe is the
  executable statement that the warning is gone.

## 22. Security findings

| # | Finding | Severity | Disposition |
|---|---|---|---|
| S1 | PIC profile creation never set `platformRole=PIC` → converted customers got FORBIDDEN on their own fee surface (functional defect, not privilege escalation — the missing role *withheld* capability) | High (functional) | **Fixed** + regression tests |
| S2 | No ADMIN surface existed to mint MANAGER/PIC accounts; profiles required a pre-existing customer account (operational gap, honest UI) | Medium | **Fixed** by V1 user management |
| S3 | No account-status field on User; a "removed" operator could only be left technically able to log in | Medium | **Fixed** additively (`disabledAt`), enforced at login + scope + PIC entry |
| S4 | MANAGER escalation paths (create user/PIC/ADMIN, grants, branding, maintenance) | — | All verified still denied, including with a planted PermissionGrant (tested) |
| S5 | PIC cross-access (another PIC's ledger/referrals, self-assignment, arbitrary picProfileId) | — | Verified denied by `requireMyPic` + assignment/checkout re-checks (existing suites + new tests) |
| S6 | Customer field-manipulation to become PIC / set platformRole | — | Register route strips privilege-shaped keys and hardcodes roles (unchanged); user-management route's role is a two-value enum; tested |
| S7 | Audit metadata leaking credentials | — | `writeTicketingAudit` key filter already drops `password`/`passwordHash`/`bankaccountnumber`; new audit rows pass ids/emails/role names only; asserted by test |

## 23. Database changes

One additive change, nothing else:

```prisma
disabledAt DateTime?   // on model User; nullable; no default; no backfill needed
```

Every existing row stays active (NULL). No column dropped, no enum altered, no table
removed, no data rewritten. The PIC role fix wrote no schema (the column already
existed).

## 24. Migration status

- Migration: `prisma/migrations/20260925010000_add_user_disabled_at/migration.sql`
  (ALTER ADD COLUMN + one index; verified to apply cleanly and to be the ONLY
  migrations-vs-schema delta it introduces — applied to a scratch shadow database row by
  row, then confirmed via `SHOW COLUMNS`/`SHOW INDEX`).
- Test DB migrated via `npm run test:db:setup` (idempotent `migrate deploy`); the full
  Jest run therefore executed against the migrated test schema.
- **Development DB not touched by a migration command**: `prisma migrate dev` was invoked
  once with `--create-only` and aborted when Prisma demanded a full **reset** of the dev
  database — demanded because of PRE-EXISTING drift (the documented retail-era tables and
  collation renames prior phases deliberately left in place; visible in
  `migrate diff --from-migrations`). Per brief §AB no reset was performed. Production
  rollout is `npx prisma migrate deploy` at the operator's chosen time (this command never
  resets); nothing was applied automatically.

## 25. Tests

New suites (all passing):

- `__tests__/admin-manager/user-management.integration.test.ts` (13): MANAGER creation
  (server-set role, dormant legacy role, bcrypt hash, no profile); PIC creation
  (User+PICProfile in one step, PENDING, derived code); duplicate 409; fixed union (a
  direct `role:"ADMIN"` call refuses and creates nothing); audit without credential
  material; list (managed roles only, no `password` field, role filter); disable/enable
  (scope NULL while disabled, restored after); ADMIN target refused; MANAGER/PIC/CUSTOMER
  refused every verb; planted PermissionGrant cannot manufacture `user.manage`.
- `__tests__/admin-manager/pic-account-role.integration.test.ts` (5): customer→PIC role
  promotion; ADMIN/MANAGER never demoted; fee+attribution own families resolve for the
  promoted role; **customer data safety** (same id, orders/tickets intact, single User
  row, buyer capabilities preserved); account status vs PIC status dimensions (PENDING
  entry refusal → ACTIVE entry → account disable closes everything while profile state is
  untouched → re-enable restores).
- `__tests__/ui-consolidation/dashboard-table-keys.test.ts` (4): the key-warning probe
  described in §21.

Updated pins: `role-matrix.integration.test.ts` (ADMIN menu gains `/dashboard/users`,
`canManageUsers` true-for-ADMIN, MANAGER refused on capability + menu);
`route-inventory.test.ts` (38 pages; 24 dashboard routes);
`phase27a-login-rate-limit.test.ts` (the refusal-recording contract is now 4 sites —
unknown user, deactivated account, OAuth-only, wrong password — each named);
`pic-self-service/menu.test.ts` + `admin-manager/branding-and-wiring.test.ts` (capability
fixture gains `canManageUsers: false`).

## 26. Full Jest result

`npm test` → **114 suites / 2236 tests: 113 suites passed, 1 failed before the §25 static
contract update; after the update: all green (0 failures).** One unrelated flake
(`payment-races`, a documented concurrency-timing suite) passed on isolated re-run. Note:
`maxWorkers: 1` and `forceExit: true` are the established config; a couple of suites print
large Prisma query logs but assert correctly.

## 27. TypeScript

`npx tsc --noEmit` → **0 errors** (run repeatedly during the work and at the end).

## 28. ESLint

`npm run lint` → **0 errors, 3 pre-existing warnings** (the `<img>` LCP warnings in
`app/e/[slug]/page.tsx` and `components/events/EventCard.tsx`, untouched by this phase).

## 29. Build

`npm run build` → **Compiled successfully.** `/dashboard/users` appears in the route
manifest as a dynamic (ƒ) route. One pre-existing Turbopack tracing warning
(`lib/branding/logo.ts` dynamic fs access, Phase 32) — unchanged.

## 30. Live verification

Executable-verification substitution, honestly labelled: no browser session was driven in
this environment. The verification set the brief lists (login as ADMIN → create
Manager/PIC → login as each → verify access/denials → console check) is covered by the
integration suites, which run the REAL services, REAL database, REAL authz deciders and
REAL session mocking at the exact boundary the browser would hit (`requireAuth`), plus the
static wiring suites that pin the enforcement points and the rendered-menu assertions.
Items requiring a human browser (console observation, visual logo/maintenance checks)
remain the one open manual step for the operator (§31).

## 31. Remaining gaps

1. **Production migration** must be applied deliberately (`npx prisma migrate deploy`)
   after the operator's backup — never automatic, per §AB.
2. **Browser walkthrough** (the §AC manual list) on a live dev server for visual/console
   confirmation.
3. Pre-existing dev-DB drift (retail-era tables, collation renames) remains an accepted,
   documented state from earlier phases; a future cleanup migration may reconcile it —
   out of scope here and destructive if done carelessly.
4. User-management list filters expose role + search; status filter and edit (name/email)
   are deliberately deferred (V1 scope, brief §M/§U).
5. The dev-DB drift means `prisma migrate dev` locally will keep demanding a reset until
   the operator baselines; use `migrate deploy`/`migrate diff` workflows instead.

## 32. Git status

Working tree carries this phase's changes **uncommitted** (no commit, no push performed):

Modified (Phase 33 subset): `prisma/schema.prisma`, `lib/authz/permissions.ts`,
`lib/authz/scope.ts`, `lib/dashboard/scope.ts`, `lib/pic/service.ts`,
`lib/pic/self-service.ts`, `lib/ticketing/audit-log.ts`, `auth.ts`, `components/dashboard/
primitives.tsx`, `components/dashboard/DashboardAppShell.tsx`,
`app/dashboard/settings/page.tsx`, `lib/ui/route-inventory.ts`,
`__tests__/authz/role-matrix.integration.test.ts`,
`__tests__/security/phase27a-login-rate-limit.test.ts`,
`__tests__/ui-consolidation/route-inventory.test.ts`,
`__tests__/pic-self-service/menu.test.ts`,
`__tests__/admin-manager/branding-and-wiring.test.ts`,
`__tests__/admin-manager/user-management.integration.test.ts` (new),
`__tests__/admin-manager/pic-account-role.integration.test.ts` (new),
`__tests__/ui-consolidation/dashboard-table-keys.test.ts` (new),
`app/api/admin/users/` (new), `app/dashboard/users/` (new),
`components/admin/UserManager.tsx` (new),
`prisma/migrations/20260925010000_add_user_disabled_at/` (new),
`PHASE_33_MULTI_ROLE_USER_MANAGEMENT_PIC_ACCOUNT_AUDIT_REPORT.md` (new). The tree also
holds earlier phases' uncommitted work (Phases 29–32 reports, PIC suites, settings
routes) — untouched by this phase.

---

## Explicit answers to the five final questions

**1. "Apakah menu PIC yang sekarang benar-benar membuat akun login PIC, atau hanya
membuat PICProfile?"**
Sebelum Phase 33: hanya PICProfile — "Tambah PIC" menautkan akun yang SUDAH terdaftar dan
menolak email tanpa akun; tidak ada User, password, atau login yang dibuat. Setelah
Phase 33: ADMIN punya dua jalur resmi — `/dashboard/users → Tambah Pengguna (role PIC)`
membuat **User + PICProfile sekaligus dalam satu transaksi** (login siap dipakai, profil
berstatus Menunggu), dan jalur lama `POST /api/admin/pic` tetap menautkan akun eksisting
(skarang sekaligus menaikkan platformRole-nya menjadi PIC). Menu lama tidak lagi menjadi
satu-satunya jalan, dan labelnya tidak pernah berbohong (copy-nya sudah jujur).

**2. "Bagaimana customer menjadi PIC tanpa kehilangan identitas customer?"**
Dengan promosi akun yang sama, bukan duplikasi: `createPic` menaikkan
`platformRole: CUSTOMER → PIC` pada row `User` yang sama dalam satu transaksi dengan
pembuatan profil. `userId` tidak berpindah, sehingga order, tiket, refund, dan riwayat
pembayaran tetap milik akun itu — dibuktikan oleh tes regresi yang menanam order PAID +
tiket ISSUED, mengonversi pembelinya menjadi PIC, lalu memastikan jumlah order/tiket
tetap, hanya ada satu row User untuk email tersebut, dan `order.read.own` /
`ticket.read.own` masih diizinkan.

**3. "Apakah Manager benar-benar full operational tetapi tidak system-admin?"**
Ya, dan sekarang terbukti per-nama: MANAGER memegang seluruh set operasional tenant —
termasuk keuangan D-19 *by role* (prepare/approve/execute settlement, fee rate change,
export financial) — dan memegang NOL dari: `user.manage` (baru), `role.manage`,
`platform.config`, `sport.manage`, `venue.manage.global`, `pic.manage`,
`application.settings`, `maintenance.manage`, `branding.manage`. Tes role-matrix mem-pin
capability object DAN menu (tidak ada baris "Sistem" untuk MANAGER), dan tes escalation
memastikan permintaan langsung ditolak.

**4. "Apakah ADMIN benar-benar dapat membuat Manager dan PIC secara aman?"**
Ya: `POST /api/admin/users` dijaga proxy + CSRF + `user.manage` (ADMIN-only, tidak
dapat diberikan lewat PermissionGrant — dites), peran ditetapkan server dari enum dua
nilai (body `"role":"ADMIN"` = VALIDATION_ERROR), password memakai kebijakan registrasi
dan bcrypt cost-12 lalu tidak pernah dikembalikan/dicatat, duplikat email → 409, PIC
dibuat User+PICProfile atomik berstatus Menunggu, semua mutasi diaudit tanpa materi
kredensial, dan target disable dibatasi ke MANAGER/PIC (ADMIN tak bisa dinonaktifkan
lewat permukaan ini, bahkan oleh ADMIN lain; ADMIN juga tak bisa menonaktifkan dirinya).

**5. "Apakah warning DataTable sudah benar-benar hilang?"**
Ya — dengan bukti, bukan suppression: akar masalahnya adalah dua pemetaan internal
`DataTable` (header & cell) yang memakai kunci indeks, dan React menyalahkan `DataTable`
karena Dialah yang memetakan. Perbaikan ada di komponen itu (`column.id ?? posisi`),
bukan di call site. Suite regresi merender pohon persis seperti halaman Pembayaran
(sel kondisional, TextLink, StatusBadge, footer, ketiga state) via `react-dom/server`
dan gagal jika ada `console.error` "unique key" — semuanya hijau. Kunci baris tetap
`payment.id`, dan sel halaman Pembayaran memang sudah berkunci stabil sejak baseline
(diverifikasi lewat `git show HEAD:`).
