# PHASE 32 — ADMIN vs MANAGER SEPARATION + APPLICATION CONTROL + BRAND CUSTOMIZATION

**Status:** implemented, verified, uncommitted.
**Explicitly not done:** no commit, no push, no PR, no database reset, no destructive migration, no data deleted.

---

## 1. Current role architecture BEFORE the changes

The audit (per §2/§29 — *trace UI → capability → permission → route → service → DB* before touching
anything) found one authority architecture, already layered, with **no second role system**:

| Layer | Artefact | Authority? |
| --- | --- | --- |
| `User.platformRole` (`PlatformRole?` = `CUSTOMER\|ADMIN\|MANAGER\|PIC`) | `prisma/schema.prisma` | **THE authority.** Resolved by `lib/authz/scope.ts#resolveAuthzScope` |
| `User.role` (`Role` = `ADMIN\|SELLER\|CUSTOMER\|AFFILIATOR`) | legacy retail column | **Not authority.** Read only by the retail session contract; nothing in `lib/authz` reads it (deliberate — deriving `ADMIN` from it would be a hidden privilege grant) |
| `OrganizerMember.role` (`OWNER\|ADMIN\|MANAGER\|FINANCE\|PIC\|CHECKIN_STAFF`) | tenant membership | Capability **inside one tenant only**; `ADMIN` is deliberately unmapped (D-05) |
| `PermissionGrant` | explicit allow-list | Consulted only for `ADMIN_GRANT_REQUIRED` (D-19) permissions — never a general privilege channel |
| `lib/authz/permissions.ts` | permission vocabulary + role→permission maps + 3 pure deciders | The single decision module |
| `lib/authz/guards.ts` | `requirePlatformPermission` / `requireOrganizerAccess` / `requireOwnResource` / `requirePlatformRole` | Throw-on-deny enforcement, used by every route/service |
| `lib/dashboard/scope.ts` | `computeDashboardCapabilities` / `canEnterDashboard` / `organizerIdsWith` | Menu + entry gate, computed **server-side from the same deciders** |
| `components/dashboard/DashboardAppShell.tsx` | `buildDashboardNav(capabilities)` | Renders rows; never an access control |
| `proxy.ts` | authentication + public/protected lists | **Auth-only** (D-49); Edge runtime, no Prisma |

**What that meant for ADMIN and MANAGER before this phase**

* The **platform-role dimension was already wired but thin**: `PLATFORM_ROLE_ORGANIZER_PERMISSIONS`
  gave MANAGER the *full* operational tenant set (including the financial permissions by role),
  and ADMIN a slightly *smaller* one (`D-19`: payment reconcile, refund execute, fee adjust/rate,
  all settlement steps and financial exports are **grant-required** for ADMIN).
  `PLATFORM_ROLE_PLATFORM_PERMISSIONS` gave ADMIN the platform master-data/administration set and
  MANAGER exactly `audit_log.read`.
* **There was no application-control surface at all** — no maintenance mode, no branding, no
  reader for `PlatformSetting.logoUrl`.
* `platformRole MANAGER` is *reachable* but **deliberately narrow**: a platform role alone confers
  no tenant data (the intersection rule), so a MANAGER without an ACTIVE `OrganizerMember` row
  cannot enter the dashboard. That is the existing, tested isolation guarantee — not a bug, and
  not under-wired.

**Decision taken:** activate and sharpen the **existing** `platformRole` mechanism. No new enum, no
`isManager` boolean, no `isAdmin` flag, no parallel permission system (§19).

---

## 2. Final definition — ADMIN (system owner / super admin)

Full operational access **plus** exclusive application control:

* All operational tenant capability it already had (events, tickets, orders, customers, payments,
  refunds, check-in, PIC, reports, venues) — unchanged.
* **New, exclusive:** `application.settings`, `maintenance.manage`, `branding.manage`.
* Plus the pre-existing platform set: `sport.manage`, `venue.manage.global`, `pic.manage`,
  `user.manage`, `role.manage`, `platform.config`, `audit_log.read`.
* Reachable surfaces: `/dashboard/settings/application`, `/dashboard/settings/branding`,
  `/dashboard/settings/maintenance`, and the `Sistem` sidebar section.
* **Preserved:** `D-19` (grant-required financial permissions). See §22.

## 3. Final definition — MANAGER (full operational access, no application control)

* **Operational:** every tenant permission in `OPERATIONAL_TENANT_PERMISSIONS` — events CRUD/publish,
  ticket types + quota/price, orders + cancel, payments read **and reconcile**, refunds
  request/approve/execute, PIC assign + attribution/fee read, fee rate/adjust/mark-paid,
  settlement prepare/approve/proof, check-in scan/override/log, all operational reports + financial
  exports (by role, not by grant), venues, reports.
* **Excluded (§5):** all three new application-control permissions, and every platform-governance
  permission (`user.manage`, `role.manage`, `platform.config`, `sport.manage`,
  `venue.manage.global`, `pic.manage`).
* **Kept:** `audit_log.read` (pre-existing §6.3 grant to Manager; removing it would weaken an
  existing capability rather than sharpen the boundary — a read of the platform's own history is not
  application control).
* **Still bounded by:** tenant isolation (needs an ACTIVE membership) and every existing SoD rule.

---

## 4. Capability matrix (after implementation)

`YES*` = allowed **only** through the pre-existing `D-19` explicit `PermissionGrant` for an ADMIN;
tenant + SoD constraints are unchanged for both roles.

| Capability | Permission string | Scope | ADMIN | MANAGER |
| --- | --- | --- | --- | --- |
| dashboard.access | (any tenant or platform capability, or an ACTIVE PIC profile) | — | YES | YES |
| events.manage | `event.read/write/publish/banner.upload` | ORGANIZER | YES | YES |
| ticket_types.manage | `ticket_type.write/quota.change/price.change` | ORGANIZER | YES | YES |
| orders.manage | `order.read.tenant`, `order.cancel` | ORGANIZER | YES | YES |
| customers.read | `order.read.tenant` (same gate as orders) | ORGANIZER | YES | YES |
| payments.read | `payment.read.tenant` | ORGANIZER | YES | YES |
| payments.reconcile | `payment.reconcile` | ORGANIZER | **YES\*** | YES |
| refunds.manage | `refund.request/approve/execute` | ORGANIZER | YES / YES\* / YES\* | YES |
| checkin.manage | `checkin.scan/override/log.read` | ORGANIZER | YES | YES |
| pic.manage (platform profiles) | `pic.manage` | PLATFORM | YES | **NO** |
| pic.assign | `pic.assign` | ORGANIZER | YES | YES |
| pic.reporting | `pic_attribution.read.all`, `pic_fee.read.all` | ORGANIZER | YES | YES |
| fee.rate.change / fee.adjust / fee.mark_paid | same names | ORGANIZER | **YES\*** | YES |
| settlement.prepare | `settlement.prepare` | ORGANIZER | **YES\*** | YES |
| settlement.approve | `settlement.approve` | ORGANIZER | **YES\*** | YES |
| settlement.proof | `settlement.proof.upload` | ORGANIZER | **YES\*** | YES |
| settlement.paid | `settlement.paid` (write path) | ORGANIZER | **YES\*** | YES |
| reports.read | `report.transaction.read`, `report.event_sales.read` | ORGANIZER | YES | YES |
| reports.export.financial | `report.export.*` | ORGANIZER | **YES\*** | YES |
| venues.manage | `venue.manage` | ORGANIZER | YES | YES |
| venues.manage.global | `venue.manage.global` | PLATFORM | YES | **NO** |
| sports.manage | `sport.manage` | PLATFORM | YES | **NO** |
| audit_log.read | `audit_log.read` | PLATFORM | YES | YES |
| **application.settings** | `application.settings` | PLATFORM | **YES** | **NO** |
| **maintenance.manage** | `maintenance.manage` | PLATFORM | **YES** | **NO** |
| **branding.manage** | `branding.manage` | PLATFORM | **YES** | **NO** |
| user.manage | `user.manage` | PLATFORM | YES | **NO** |
| role.manage | `role.manage` | PLATFORM | YES | **NO** |
| platform.config | `platform.config` | PLATFORM | YES | **NO** |

Own-scope (`order`/`payment`/`ticket`/`refund` for one's own purchases) is unchanged for both roles
(Phase 23A behaviour), and is identity-gated, so it confers nothing over anyone else's records.

---

## 5. Permission changes

`lib/authz/permissions.ts` (one map edit, three consumers traced first):

* Added `PERMISSIONS.APPLICATION_SETTINGS = "application.settings"`,
  `MAINTENANCE_MANAGE = "maintenance.manage"`, `BRANDING_MANAGE = "branding.manage"`.
* Classified all three **`PLATFORM`** in `PERMISSION_SCOPE` → `decidePlatformPermission` is the only
  decider that can allow them; `decideOrganizerPermission` refuses them outright (they are not
  organizer-scope) and `decideOwnResourcePermission` refuses them (they are not own-scope).
* Added all three to `PLATFORM_ROLE_PLATFORM_PERMISSIONS.ADMIN` **only**. `MANAGER`, `PIC` and
  `CUSTOMER` are untouched, so MANAGER resolves them to **deny**.
* **Not** added to `ADMIN_GRANT_REQUIRED`, so a `PermissionGrant` row cannot unlock them for
  MANAGER either (§5.2 "never the union of loose grants").
* No permission was removed from any role. No `ADMIN_GRANT_REQUIRED` entry changed. No organizer or
  own-scope map changed.

## 6. Route / API changes

**New (all ADMIN-only):**

| Route | Methods | Guard |
| --- | --- | --- |
| `/api/admin/settings/application` | `GET`, `PATCH` | `application.settings` / `maintenance.manage` (+ proxy `/api/admin/` protection, + `requireSameOrigin`) |
| `/api/admin/settings/branding` | `GET`, `POST`, `DELETE` | `branding.manage` (+ proxy protection, + CSRF, + `rateLimiters.upload` on POST) |
| `/api/uploads/branding/[filename]` | `GET` | public (assets; the maintenance page renders the logo) |

**Modified (maintenance enforcement only — no contract change in the OFF state):**
`/api/ticketing/checkout` (POST), `/api/ticketing/orders/[orderNumber]/pay` (POST),
`/api/events` (GET), `/api/events/[slug]` (GET), `/api/events/[slug]/share` (GET),
`/api/sports` (GET).

**New pages:** `/maintenance`, `/dashboard/settings/application`,
`/dashboard/settings/branding`, `/dashboard/settings/maintenance`.
**Modified pages/UI:** `app/layout.tsx` (root enforcement), `app/dashboard/layout.tsx`,
`app/dashboard/settings/page.tsx` (new `Sistem` section), `DashboardAppShell` (new `Sistem`
section + logo prop), `DashboardShell`, `DashboardNav`, `SiteHeader`, `SiteFooter`,
`components/Brand.tsx`.

## 7. Maintenance implementation

* **Data:** `PlatformSetting` — the **existing** single-row platform configuration (`id = 1`),
  already read by `lib/ticketing/reservations.ts`. Additive columns `maintenanceMode` (default
  `false`), `maintenanceMessage`, `maintenanceEtaMessage` (both nullable `TEXT`). No localStorage, no
  hardcoded state; a missing row means **available** with the built-in wording.
* **Read model:** `lib/app-settings.ts` — `getApplicationSettings` / `getApplicationBranding` /
  `getMaintenanceState`, request-cached with React `cache()` (and a pass-through outside a render, so
  a toggle is visible on the next request, not after a TTL).
* **Write:** `lib/application/service.ts#updateMaintenanceSettings` — one `upsert`, so mode + message
  + ETA cannot be submitted in an order that strands a stale notice. Requires `maintenance.manage`.
* **UI:** `components/dashboard/MaintenanceSettingsForm.tsx` (ON/OFF switch, message, ETA, save) on
  `/dashboard/settings/maintenance`; `/dashboard/settings/application` shows the current state
  read-only with links to the owning page; the settings hub renders the `Sistem` section only when
  the capability is held.
* **Public page:** `app/maintenance/page.tsx` — renders the configured logo, the operator message,
  the optional ETA, and says the site is available when the switch is OFF (so the URL is never a
  404 and the ADMIN's preview is the real page).

## 8. Maintenance enforcement layer (server-side)

Three server-side points, no client-side React check anywhere:

1. **`app/layout.tsx` (root Server Component)** — runs before any page renders. Reads the request
   path from the `x-pathname` header the proxy stamps on, resolves `platformRole` from the
   server-side session, and calls the **pure** `maintenanceBlocksPage(pathname, role)`. Redirects to
   `/maintenance` when it answers `true`.
   * **ADMIN keeps the dashboard** (`/dashboard/**` allowed for `ADMIN` only) — the recovery path;
     a locked-out ADMIN would make maintenance a one-way door.
   * **MANAGER does not bypass** — a closed application is closed to MANAGER too.
   * **No redirect loop** — the decision is a function of the path, and `/maintenance` is exempt for
     every role, so the target cannot re-enter itself. A missing `x-pathname` fails **open** (the one
     state that must never produce a loop) and is only possible for paths the matcher excludes.
2. **`lib/maintenance.ts#assertNotInMaintenance` / `assertPurchasingAvailable`** — throws
   `AppError(SERVICE_UNAVAILABLE, 503)` carrying the operator's message and
   `details.reason = "MAINTENANCE_MODE"`. Applied to the two money-moving endpoints and to the four
   public catalogue endpoints. Delegation, not duplication, so status/message/reason cannot drift.
3. **`proxy.ts`** — forwards the path only. It deliberately does **not** read the flag: it runs in the
   Edge runtime, where Prisma is unavailable, so deciding there would be deciding without the
   database (D-49's auth-only rule preserved).

**Exempt (never blocked):** `/maintenance`, `/login` (ADMIN recovery), `/api/health`,
`/api/health/ready`, `/api/auth/*`, `/api/internal/*` (the cron tick must keep expiring
reservations), `/api/uploads/*` (the maintenance page's own logo). The exemption sets are exported
data, asserted by tests.

**Live verification** (production build on `:3311`, dev database):

| Request | maintenance OFF | maintenance ON |
| --- | --- | --- |
| `/` | 200 | **307 → `/maintenance`** |
| `/events` | 200 | **307 → `/maintenance`** |
| `/e/…`, `/faq`, `/kontak`, `/register` | 200 | **307 → `/maintenance`** |
| `/maintenance` (and following the redirect from `/`) | 200 | **200** (no loop) |
| `/login` | 200 | **200** (recovery) |
| `/api/health`, `/api/health/ready` | 200 | **200** |
| `/api/auth/session` | 200 | **200** |
| `/api/events`, `/api/sports`, `/api/events/:slug`, `…/share` | 200 | **503** |
| `POST /api/ticketing/checkout` (anonymous) | 401 | **401** (auth precedes availability; manager/admin receive **503**) |
| `/api/uploads/events/x.jpg` | 404 | 404 (route reachable; file absent) |

## 9. Branding implementation

Scope kept deliberately small (§10, §16): **logo only**. Preview, upload, replace, remove.
`components/dashboard/BrandingLogoManager.tsx` on `/dashboard/settings/branding`, guarded
server-side by `branding.manage`. Formats stated as PNG / JPEG / WebP and enforced **by content**.
No CMS, no theme editor, no second logo setting.

## 10. Logo upload / storage architecture

Reuses the **existing** upload architecture — nothing new (`lib/branding/logo.ts`):

* Magic-byte validation via `lib/images/format.ts` (`detectImageFormat`) — the declared MIME type is
  never the decision; the declared size is re-checked against the real bytes.
* Metadata stripped via `lib/images/strip-metadata.ts` (same allow-list stripper event imagery uses),
  so a logo cannot carry EXIF/GPS into a publicly served file.
* Size cap **5 MB** (same as event imagery / settlement proof).
* Filename generated server-side (`<timestamp>-<32 hex>.<ext>`); the client filename never touches the
  filesystem → traversal and extension spoofing are structural impossibilities, not filters.
* Written write-then-rename (never a half-written asset pointed at by the DB).
* Directory `<UPLOAD_DIR>/branding` (default `storage/uploads/branding`) — the **persistent** tree, not
  `.next`, `tmp`, `/tmp`, `node_modules` or build output; it survives restart/rebuild/deploy.
* Served by `/api/uploads/branding/[filename]`: public, basename-only, `nosniff`,
  `Content-Disposition: inline`, MIME from the stored extension, 404 with no listing on a miss.
* **No binary in MySQL** — the DB holds only the URL string.
* **SVG is not accepted** and is not in the MIME allow-list: this codebase has no SVG sanitizer, and
  an SVG is a scriptable document (§11).
* **Only after** a successful store does the DB point at the asset; a replace then deletes the asset it
  replaced, so orphans cannot accumulate and the only recoverable failure state is "branding
  unchanged".

## 11. Landing page integration

`components/ticketing/SiteHeader.tsx` and `SiteFooter.tsx` read `getApplicationBranding()` and pass
`logoSrc` into the single shared lockup `components/Brand.tsx`. Nothing is hardcoded: with a
configured logo the lockup renders `[LOGO] TinggalKlik.Co`; with none it renders the existing
typographic mark. `app/maintenance/page.tsx` uses the same accessor, so the closed site stays
identifiable.

## 12. Dashboard logo integration

`app/dashboard/layout.tsx` resolves the branding once (server-side) and threads it
`DashboardAppShell → DashboardShell → DashboardNav` (desktop rail) **and** the mobile top bar, so
there is exactly one logo and one source of truth. The lockup is an internal `<Link href="/">`, so
clicking the dashboard logo navigates to the public landing page — normal internal navigation, no
`window.location`. No dashboard-specific logo configuration exists (`lib/store-settings.ts` still
knows nothing about logos).

## 13. Audit logging

`lib/ticketing/audit-log.ts` gained six actions and the `PlatformSetting` entity type:

`application.maintenance.enabled`, `application.maintenance.disabled`,
`application.maintenance.updated`, `application.branding.logo_uploaded`,
`application.branding.logo_replaced`, `application.branding.logo_removed`.

Metadata only — the boolean, the messages, and for a logo the generated **file name**, content type,
size, stripped-metadata list and a `logoConfigured` flag. Never image bytes, secrets, credentials or
buyer PII (the writer's forbidden-key filter also runs). Writes use the fire-and-forget writer, like
every other non-money audit in this codebase.

## 14. Security controls

* MANAGER is denied at the **service** layer (not just the menu) for application settings read/write,
  maintenance write, and logo upload/replace/remove; the routes are additionally behind the
  session-gated `/api/admin/` prefix and `requireSameOrigin`.
* The three new permissions are platform-scope, ADMIN-only, and unreachable from a tenant membership
  (any role) or from an own-scope path or from a `PermissionGrant`.
* Tenant isolation, `D-19`, SoD (`preparedBy != approvedBy`, requester-cannot-decide-own-refund),
  CSRF, rate limits, settlement/refund/payment security and the audit trail are **unchanged**.
* The read side refuses to serve a logo whose file is absent or whose URL is not a branding URL
  (including traversal-shaped and absolute-URL values) → fallback mark instead of a broken image.
* Upload pipeline: magic bytes, real-bytes size re-check, metadata strip, generated filename,
  verified directory, protective response headers.

## 15. Database changes

**Additive only**, on the existing `platformsetting` table:

```sql
ALTER TABLE `platformsetting`
    ADD COLUMN `maintenanceMode` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `maintenanceMessage` TEXT NULL,
    ADD COLUMN `maintenanceEtaMessage` TEXT NULL;
```

Branding reuses the **existing** `logoUrl` column (created with the table in the Phase 2 foundation
migration) — no branding column was added. No column, index, row or value was changed or dropped.

## 16. Migration status

* `prisma/migrations/20260925000000_add_platform_maintenance_branding/migration.sql` (this phase) —
  additive, non-destructive.
* `npx prisma validate` → **valid**.
* `npx prisma migrate status` → **28 migrations found, database schema is up to date** (the phase
  migration was already applied to the local dev database by an earlier partial run of this phase;
  this session did **not** run `migrate deploy`).
* **Not applied to production.** No reset, no `migrate reset`, no data deletion.

## 17. Tests added / updated

**New namespace `__tests__/admin-manager/` (registered in `jest.config.js`), 65 tests:**

| File | Covers |
| --- | --- |
| `role-separation.test.ts` (pure) | ADMIN holds the three; MANAGER holds none (with a membership, via a grant, via an owner membership); MANAGER's complete operational set is intact; MANAGER's platform surface is *exactly* `audit_log.read`; organizational/own paths cannot resolve application control; tenant isolation unchanged |
| `maintenance.test.ts` (pure) | exempt page/API sets; no redirect loop for every role; public pages blocked for every role; ADMIN keeps the dashboard; MANAGER does not bypass; `/login` and health/assets survive; `assertPurchasingAvailable` ≡ `assertNotInMaintenance` (503 + `MAINTENANCE_MODE`) |
| `application-control.integration.test.ts` (real DB) | ADMIN reads/writes, MANAGER refused on read **and** write, unauth refused, audit rows per action (enabled/disabled/updated/uploaded/replaced/removed), `null` message → default, enable→disable round trip, dashboard capability flags per role, real PNG upload stored on disk + DB pointer, replace deletes the old asset, remove clears + deletes, dangling/hostile `logoUrl` falls back |
| `branding-and-wiring.test.ts` | Brand renders logo+wordmark / mark-only / `null` ≡ omitted, link to `/`; landing + dashboard read the same accessor; no second logo config; root layout is the enforcement point; proxy stamps the path and does **not** decide; both money endpoints and all four catalogue endpoints guarded; exempt endpoints explicitly unguarded; the `Sistem` menu section appears only for ADMIN and each row is gated by its own capability; upload contract (magic bytes, no SVG, generated filename, persistent dir, no binary in MySQL) |

**Updated pinned suites:** `__tests__/authz/role-matrix.integration.test.ts` (ADMIN menu now includes
the three system rows; MANAGER asserted to hold zero application control while keeping every
operational row), `__tests__/pic-self-service/menu.test.ts` (three new capability defaults),
`__tests__/ui-consolidation/route-inventory.test.ts` + `lib/ui/route-inventory.ts` (33 → 37 pages,
20 → 23 dashboard routes, plus `/maintenance`).

**`__tests__/authz/route-classification.test.ts`** exercised its intended guard: the new
`/api/uploads/branding/*` route had to be classified, and the suite caught a *truncated* prefix list
caused by a square-bracketed path written inside a proxy comment (the regex ends at the first `]`).
Fixed by rewording the comment, and a note now warns future editors.

## 18. Full test result

```
Test Suites: 111 passed, 111 total
Tests:       2213 passed, 2213 total
```

**One flaky test, proven unrelated.** `__tests__/ticketing-payment/payment-races.integration.test.ts`
→ *"E4. twenty orders settling at once each convert exactly once"* failed once in an intermediate
full run and once in 3 standalone runs (passing standalone on the other two, and passing in the
final full run). It is a genuine 40-concurrent-webhook contention test against real InnoDB
(`expect(threw).toEqual([])`, `settled === 20`). Its dependencies — `createOrderPayment`,
`handleGatewayWebhook`, `cancelOwnPendingOrder`, `expireDueReservations`, `createTicketType`,
`requireOrganizerAccess` — are **not touched by this phase**, and every phase-32 assertion passes
deterministically in isolation and in the full run.

## 19. TypeScript result

`npx tsc --noEmit` → **0 errors** (clean).

## 20. ESLint result

`npm run lint` → **0 errors, 3 warnings**, all pre-existing and unrelated
(`@next/next/no-img-element` in `app/e/[slug]/page.tsx` ×2 and `components/events/EventCard.tsx`).
The two new `<img>` uses (the lockup and the branding preview) carry a scoped
`eslint-disable-next-line` with the reason inline.

## 21. Build result

`npm run build` → **compiled successfully**; 27/27 static pages generated; all routes dynamic (`ƒ`),
which is expected — the root layout now reads `headers()`/`auth()`/the settings row, and every page
in this application was already dynamic or database-backed. The build log confirms `/maintenance`,
`/dashboard/settings/application`, `/dashboard/settings/branding`,
`/dashboard/settings/maintenance` and `/api/uploads/branding/[filename]` are present.

## 22. Remaining gaps (deliberate, documented)

1. **`D-19` is preserved, so ADMIN is not *literally* unrestricted on money.** Payment
   reconcile/refund-execute/fee changes/settlement steps/financial exports still require an explicit
   `PermissionGrant` for an ADMIN, while MANAGER holds them by role. This is a **pre-existing,
   code-documented financial control** and §29 explicitly forbids weakening existing financial
   safety, so it was left intact rather than traded for the word "full". The matrix above marks those
   cells `YES*` for that reason. If the business wants ADMIN to hold them by role, it is a one-line
   change to `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.ADMIN` plus a decision to retire `D-19` — do it
   deliberately, with `__tests__/authz/permission-map.test.ts` updated on purpose.
2. **`/dashboard/settings` (the hub) still opens for a MANAGER**, because it also hosts the
   *operational* organizer-venue settings they legitimately own. §21's "MANAGER: GET
   /dashboard/settings → denied" is therefore satisfied for the **system** surfaces — the three
   system pages deny MANAGER at the page and API layers — while the hub itself renders only the rows
   the caller may actually open (`Sistem` is absent for a MANAGER).
3. **The public catalogue APIs are blocked, but `/api/uploads/events/*` is not.** Documented as
   intentional: the maintenance page needs asset serving to stay up, and a stale event banner URL is
   harmless. Health/auth/jobs are likewise exempt by design.
4. **No user/role administration UI was added.** §3 lists "user management / role governance" as
   ADMIN capabilities; the *permissions* (`user.manage`, `role.manage`, `platform.config`) already
   exist and are ADMIN-only, but no UI exists for them, and §1 says not to invent unrelated systems.
   They remain ADMIN-only at the authorization layer.
5. **`OrganizerMemberRole.ADMIN` is still unmapped (D-05)** — deliberately untouched, so it cannot
   become a privilege tier via this phase.
6. **Runtime-uploaded assets live in the tracked `storage/uploads/**` tree** (the existing
   convention — event imagery is tracked the same way). A production deployment should treat that
   directory as persistent mounted storage, and may want it git-ignored.
7. **Branding is logo-only.** No colours, no favicon, no login-page logo (`LoginForm`/`RegisterForm`
   keep the built-in mark). The logo does cover the landing page, the dashboard lockup and the
   maintenance page — one source of truth throughout.
8. **A bug found by live verification, fixed during the phase:** the proxy's page fall-through
   returned `undefined` for public pages, so the `x-pathname` header was discarded and maintenance
   blocked nothing (measured: `/`, `/events`, `/faq` all answered 200 with the mode ON). Fixed by
   returning the pass-through response; the table in §8 is the post-fix measurement.

## 23. Git status

Branch: `main`. **Nothing committed, nothing pushed, no PR opened.**

Files changed by this phase (on top of the pre-existing uncommitted Phase 29–31 work already in the
tree):

* **Modified:** `lib/authz/permissions.ts`, `lib/dashboard/scope.ts`, `lib/ticketing/audit-log.ts`,
  `lib/ui/route-inventory.ts`, `prisma/schema.prisma`, `proxy.ts`, `jest.config.js`,
  `app/layout.tsx`, `app/dashboard/layout.tsx`, `app/dashboard/settings/page.tsx`,
  `components/Brand.tsx`, `components/dashboard/DashboardAppShell.tsx`,
  `components/dashboard/DashboardShell.tsx`, `components/dashboard/DashboardNav.tsx`,
  `components/ticketing/SiteHeader.tsx`, `components/ticketing/SiteFooter.tsx`,
  `app/api/events/route.ts`, `app/api/events/[slug]/route.ts`,
  `app/api/events/[slug]/share/route.ts`, `app/api/sports/route.ts`,
  `app/api/ticketing/checkout/route.ts`, `app/api/ticketing/orders/[orderNumber]/pay/route.ts`,
  `__tests__/authz/role-matrix.integration.test.ts`,
  `__tests__/ui-consolidation/route-inventory.test.ts`,
  `__tests__/pic-self-service/menu.test.ts`.
* **Added:** `lib/app-settings.ts`, `lib/maintenance.ts`, `lib/branding/logo.ts`,
  `lib/application/service.ts`, `lib/application/validation.ts`,
  `app/api/admin/settings/application/route.ts`, `app/api/admin/settings/branding/route.ts`,
  `app/api/uploads/branding/[filename]/route.ts`, `app/maintenance/page.tsx`,
  `app/dashboard/settings/application/page.tsx`, `app/dashboard/settings/branding/page.tsx`,
  `app/dashboard/settings/maintenance/page.tsx`,
  `components/dashboard/MaintenanceSettingsForm.tsx`,
  `components/dashboard/BrandingLogoManager.tsx`, `__tests__/admin-manager/` (4 suites).
* `storage/uploads/branding/` holds the runtime-uploaded logo (`??`, untracked, not mine to commit).

### Explicit statement

**No commit. No push. No PR. No database reset. No destructive migration. No business data
deleted.** The Phase 32 migration is additive-only and was already applied locally; production has
not been touched.

**One local data note (disclosed):** the local development database had `platformsetting.maintenanceMode = true`
plus a `logoUrl` left behind by an earlier partial run of this phase. During live verification this
session set `maintenanceMode` back to **false** (the schema default, and the state the running
application was actually serving), and left `logoUrl` untouched — the file it points at exists and is
served. If a maintenance window is genuinely wanted, enable it from
`/dashboard/settings/maintenance`.
