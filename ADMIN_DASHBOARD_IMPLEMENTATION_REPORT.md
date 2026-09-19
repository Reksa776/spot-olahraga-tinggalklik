# ADMIN DASHBOARD IMPLEMENTATION REPORT

Consolidating the ticketing back office into **one dashboard UI** with
role/permission-based navigation and authorization-scoped data.

---

## 1. Summary

The product previously had **two back offices with two layouts** — `/platform/**` (4 pages,
`PlatformShell`) and `/organizer/**` (5 pages, `OrganizerShell`). They are now **one
dashboard** at `/dashboard/**` with a single shell, a single permission-driven menu, and
**no change to the authorization model**: platform and organizer remain distinct authority
dimensions and each page's service still re-decides access from the database.

Nine pages became fifteen: an Overview plus Events & Tickets, Orders (list + detail),
Customers, Payments, PIC (list + detail), Reports, Settings (hub + sports + venues) and
Venues. The retired prefixes are **307-redirected** so no existing link or bookmark breaks.

Result: `tsc` clean · **43 suites / 983 tests pass** · production build passes · Prisma
valid (no schema change) · ESLint unchanged at 45 pre-existing problems.

## 2. Dashboard Architecture

```
                     ┌──────────────────────────────┐
                     │  app/dashboard/layout.tsx     │  ONE layout (server)
                     │  getAuthzScope()              │
                     │  computeDashboardCapabilities │  ← decidePlatformPermission /
                     │  fail-closed entry gate       │    decideOrganizerPermission
                     └───────────────┬───────────────┘
                                     │ capability booleans
                     ┌───────────────▼───────────────┐
                     │ components/dashboard/          │  ONE shell (client)
                     │   DashboardAppShell.tsx        │  menu = f(capabilities)
                     │   DashboardShell.tsx (frame)   │
                     └───────────────┬───────────────┘
                                     │ page render
             /dashboard/events · /orders · /customers · /payments
             /dashboard/pic · /reports · /settings/... · /venues
                                     │
                     server components → lib/dashboard/* services
                                     │
                     resolveOrganizerFilter(scope, PERMISSION, requested?)
                                     │
                                  Prisma (scoped query)
```

- **One layout, one shell.** `PlatformShell.tsx` and `OrganizerShell.tsx` were deleted.
  `DashboardAppShell.tsx` is the only component that declares destinations; it is a *client*
  component that receives **capability booleans** from the server layout and filters rows.
- **One nav truth.** `lib/dashboard/scope.ts` → `computeDashboardCapabilities(scope)` is the
  single place the dashboard decides "may this actor read X", and it calls the **real**
  deciders (`decidePlatformPermission` / `decideOrganizerPermission`).
- **The menu is not the security boundary.** Each page's service re-runs its own
  permission check and scopes the query; a forged URL yields an empty or denied state, never
  another tenant's rows.
- **`lib/dashboard/**` is a read-model layer only** — no new business rules, no writes. It
  reuses the existing `EventOrder`, `Payment`, `Ticket`, `User`, `Event`, `PICProfile` and
  `Organizer` models and the existing permission vocabulary.

## 3. Routes Changed

| Before | After | Mechanism |
|---|---|---|
| `/organizer` | `/dashboard` | 307 redirect |
| `/organizer/events` | `/dashboard/events` | moved + 307 redirect |
| `/organizer/events/new` | `/dashboard/events/new` | moved + 307 redirect |
| `/organizer/events/:id` | `/dashboard/events/:id` | moved + 307 redirect |
| `/organizer/venues` | `/dashboard/venues` | moved + 307 redirect |
| `/organizer/pic` | `/dashboard/pic` | merged + 307 redirect |
| `/platform` | `/dashboard` | 307 redirect |
| `/platform/sports` | `/dashboard/settings/sports` | moved + 307 redirect |
| `/platform/venues` | `/dashboard/settings/venues` | moved + 307 redirect |
| `/platform/pic` | `/dashboard/pic` | merged + 307 redirect |
| `/platform/pic/:id` | `/dashboard/pic/:id` | moved + 307 redirect |

New pages: `/dashboard`, `/dashboard/orders`, `/dashboard/orders/[orderNumber]`,
`/dashboard/customers`, `/dashboard/payments`, `/dashboard/reports`,
`/dashboard/settings`.

Redirects live in `next.config.ts` (`redirects()`), are **307 temporary**, and are emitted
in specificity order (`/organizer/events/:id` before `/organizer/events`). Verified in
`.next/routes-manifest.json`.

API namespaces were **not** renamed or redirected: `/api/organizer/**` and `/api/admin/**`
are not pages, no URL changed, and their authorization is untouched.

## 4. Components Changed

- `components/dashboard/DashboardShell.tsx` — doc comments updated (the frame is unchanged;
  it still decides nothing).
- `components/dashboard/DashboardNav.tsx` — doc comments updated.
- `components/dashboard/ui/sidebar.tsx` — doc comment updated (menu contents still come from
  the caller).
- `components/Brand.tsx` — the "every surface renders this" list now names the single
  dashboard rather than the deleted retail/back-office chrome.
- `components/ticketing/SiteHeader.tsx`, `components/ticketing/SiteFooter.tsx` — public
  links to the back office repointed to `/dashboard/events` and `/dashboard/venues`.
- `components/organizer/EventForm.tsx`, `components/organizer/EventActions.tsx` — post-save
  navigation repointed to `/dashboard/events`.
- `app/page.tsx`, `app/events/page.tsx` — "Buat event" links repointed.
- `proxy.ts` — `PROTECTED_PAGE_ROUTES` and the middleware `matcher` now target
  `/dashboard`; the retired prefixes were removed (they are redirects, no longer pages).

## 5. Components Added

- `components/dashboard/DashboardAppShell.tsx` — the one shell; builds the menu from
  capabilities.
- `lib/dashboard/scope.ts` — `organizerIdsWith`, `hasOrganizerPermission`,
  `hasPlatformPermission`, `resolveOrganizerFilter`, `computeDashboardCapabilities`.
- `lib/dashboard/overview.ts` — scoped overview aggregates.
- `lib/dashboard/orders.ts` — `listDashboardOrders`, `getDashboardOrder`.
- `lib/dashboard/customers.ts` — `listDashboardCustomers` (derived, no new model).
- `lib/dashboard/payments.ts` — `listDashboardPayments`.
- `lib/dashboard/reports.ts` — `getDashboardReport`.
- `app/dashboard/layout.tsx` — the single layout and entry gate.
- 15 `app/dashboard/**/page.tsx` files.

## 6. Components Removed

- `components/dashboard/PlatformShell.tsx`
- `components/dashboard/OrganizerShell.tsx`
- `app/platform/**` (layout + 4 pages), `app/organizer/**` (layout + 5 pages)

No reusable service was deleted: `lib/events/service.ts`, `lib/ticket-types/service.ts`,
`lib/venues/service.ts`, `lib/sports/service.ts`, `lib/pic/service.ts` and the whole
`lib/ticketing/**` stack are untouched and are what the new pages read.

## 7. Services Changed

None of the existing services changed behaviour. The only new code is the read-model layer
in `lib/dashboard/**`, which **calls into** the authorization decisions rather than
re-implementing them:

- `resolveOrganizerFilter(scope, permission, requested?)` returns the actor's readable
  organizer ids for that permission, or authorizes a single requested id via
  `decideOrganizerPermission` — a forged value throws with the decider's own code
  (`ORGANIZER_ACCESS_DENIED` stays a 404).

## 8. API Changes

**None.** No route handler was added, changed or removed. The dashboard pages are server
components that call services directly (the established pattern — e.g. the former
`/platform/pic` called `listPicsForAdmin` directly), and all mutations continue to go
through the existing `/api/organizer/**` and `/api/admin/**` handlers with their existing
guards and CSRF checks.

## 9. Database Changes

**None.** No Prisma model, enum, column, index or migration was added, changed or removed.
`npx prisma validate` → valid. The dashboard reads existing models:

- Overview: `Event`, `EventOrder`, `Ticket`, `Payment`, `Sport`, `PICProfile`.
- Orders: `EventOrder` (+ `Payment`, `Ticket` on detail).
- Customers: `EventOrder` grouped by `userId` → `User`.
- Payments: `Payment` (+ `EventOrder`).
- Reports: `EventOrder`, `Ticket`, `Payment`, `Event`.
- PIC: `PICProfile`, `PICEventAssignment`, `PICFeeLedger` (via existing `lib/pic/service.ts`).

## 10. Role & Permission Behavior

- **No hard-coded role checks.** No page or service branches on `user.role` or
  `platformRole === "ADMIN"`. Navigation and page bodies are driven by
  `PERMISSIONS.*` decisions.
- The menu rows and their gating permission:

  | Menu | Shown when the actor holds |
  |---|---|
  | Ringkasan (`/dashboard`) | always |
  | Event & Tiket | `event.read` in some organizer |
  | Pesanan | `order.read.tenant` |
  | Pelanggan | `order.read.tenant` |
  | Pembayaran | `payment.read.tenant` |
  | PIC | `pic.manage` (platform) **or** `pic.assign` (tenant) |
  | Laporan | `report.transaction.read` / `report.event_sales.read` |
  | Pengaturan | `sport.manage` / `venue.manage.global` / `venue.manage` |

- **Entry gate:** the layout redirects an anonymous visitor to `/login` and denies only an
  actor holding **no tenant access and no platform capability** (a plain CUSTOMER). A
  platform ADMIN with no membership still enters; an organizer OWNER with no platform role
  still enters.
- **Platform vs organizer never merge.** `pic.manage` (platform) and `pic.assign` (tenant)
  remain separate permissions, so the PIC page renders a different body per authority rather
  than granting one. `venue.manage.global` (platform master data) stays separate from
  `venue.manage` (tenant), so an organizer never reaches global venue or sports management.

## 11. Platform Admin Behavior

- Sees the platform block on the overview: sports total/active, PIC active/pending/total.
- Sees `Pengaturan → Cabang olahraga`, `Venue global` when the corresponding platform
  permission is held, and the platform PIC management body at `/dashboard/pic`.
- Tenant data (events/orders/customers/payments/reports) is scoped by the same rule as
  everyone else: **a platform role confers no tenant access without an active membership**
  (`ORGANIZER_SPANNING_PLATFORM_ROLES` is empty). An ADMIN with a membership sees the tenant
  block; without one, the block is rendered as "no access" rather than as zeros.

## 12. Organizer Behavior

- Sees only its own data: `listOrganizerEvents` scopes by `readableOrganizerIds`, and every
  dashboard list resolves its organizer filter through `resolveOrganizerFilter`.
- Events & Tickets keeps the full existing management surface (details, ticket types, quota,
  price, sale window, images, publish/unpublish/delete) at `/dashboard/events/**`.
- Can assign an approved PIC to its own events at `/dashboard/pic`.
- Has **no** menu row for platform master data and cannot open it by URL: the settings pages
  re-check `sport.manage` / `venue.manage.global` in the service and render a denial panel.

## 13. PIC Behavior

One page, two authority dimensions:

- `pic.manage` (platform) → the platform PIC manager (create/approve/suspend, ledger read).
- `pic.assign` (tenant) → the organizer assignment manager (assign/revoke for own events).
- Neither → denial panel.

`PICProfile` / `PICEventAssignment` / `PICAttribution` / `PICFeeLedger` and
`PlatformRole.PIC` are unchanged. The Affiliate concept was **not** reintroduced. The ledger
remains append-only and display-only; no `Affiliate`/`affiliate` identifier or route exists.

## 14. Payment Behavior

- Read-only. The dashboard **cannot** set a payment to `PAID`: there is no such control, and
  `PaymentStatus` still moves to `PAID` only through the signature-verified, idempotent
  webhook (`lib/ticketing/payment/webhook.ts`).
- `/dashboard/payments` lists payment id, order, method (+ channel), flow (`DIRECT` /
  `REDIRECT`), amount, status (`UNPAID`/`PENDING`/`PAID`/`FAILED`/`EXPIRED`/`REFUNDED`),
  VA/cstore number, gateway expiry and created time.
- `/dashboard/orders/[orderNumber]` shows the order's payments with the gateway-issued
  number/URL, plus the issued tickets.
- QRIS/VA values are the gateway's own (`paymentNumber`, `qrImageUrl`, `providerName`),
  never generated here. The buyer-facing inline QR/VA rendering
  (`components/ticketing/PaymentInstruction.tsx`) is untouched.

## 15. Security Review

| Scenario | Where it is enforced | Result |
|---|---|---|
| Organizer A opens Organizer B's event | `getOrganizerEvent` → `requireEventAccess` | `ORGANIZER_ACCESS_DENIED` (404) |
| Organizer A opens Organizer B's order | `getDashboardOrder` scopes to readable organizers | `null` → not-found boundary |
| Organizer A opens Organizer B's payment | `listDashboardPayments` → `resolveOrganizerFilter` | empty list / 404 for a specific id |
| Organizer A assigns a PIC to Organizer B's event | `assignPicToEvent` authorizes the **event's** organizer | 404 |
| Organizer A redeems Organizer B's PIC assignment | `revokePicAssignment` authorizes the assignment's organizer | 404 |
| Platform user without `sport.manage` | `listSportsForAdmin` | denial panel (not a 500) |
| Customer (no tenant, no platform perm) opens `/dashboard` | layout entry gate | denial panel |
| Anonymous visitor opens `/dashboard/**` | `proxy.ts` `PROTECTED_PAGE_ROUTES` + layout | redirect to `/login` |
| Forged `?organizerId=` on a list | `resolveOrganizerFilter` → `decideOrganizerPermission` | 404, not a wider filter |
| Price/quota tampering from the dashboard | dashboard is read-only; checkout re-derives everything server-side | n/a |

The existing `__tests__/authz/tenant-isolation.integration.test.ts` and
`__tests__/authz/permission-map.test.ts` continue to pass unchanged.

## 16. Tests

```
$ npx jest --runInBand
Test Suites: 43 passed, 43 total
Tests:       983 passed, 983 total
```

Test files updated for the new architecture (not deleted):

| Suite | Change |
|---|---|
| `__tests__/ui-consolidation/route-inventory.test.ts` | 21 → **27 pages**; new assertion that the inventory has **no `/organizer` or `/platform` route** and exactly **15 `/dashboard`** routes |
| `__tests__/ui-consolidation/shadcn-dashboard.test.ts` | menu-existence, authority-input, single-shell, denial-surface and token-purity guards now read `DashboardAppShell` + `app/dashboard/layout.tsx`; `DASHBOARD_SCOPE` is `app/dashboard` |
| `__tests__/ui-consolidation/identity-consolidation.test.ts` | identity chrome now lists `app/dashboard/layout.tsx` + `DashboardAppShell.tsx`; chip/exit assertions repointed |
| `__tests__/authz/route-classification.test.ts` | page-route guard now requires `/dashboard` (and asserts `/organizer`, `/platform` are **not** gated, because they are redirects) |
| `lib/ui/route-inventory.ts` | inventory rewritten to the 27 real routes |

## 17. TypeScript

**PASS** — `npx tsc --noEmit` produces no output.

## 18. ESLint

**PASS (no regression)** — `npx eslint .` → `45 problems (27 errors, 18 warnings)`, byte-for-
byte the same count as before this task. Every remaining problem is pre-existing and outside
the changed surface (`no-explicit-any` in legacy `lib/services/auth.ts`, `scripts/*`,
`server.js` `require()` imports, `<img>` warnings, unused `scope` params mirroring
`lib/sports/service.ts`). `npx eslint lib/dashboard app/dashboard
components/dashboard/DashboardAppShell.tsx next.config.ts proxy.ts` → **0 problems**.

## 19. Production Build

**PASS** — `npm run build` succeeds. The route manifest contains all 27 pages, including the
15 `/dashboard/**` routes, and `.next/routes-manifest.json` contains the 11 legacy redirects
in specificity order.

## 20. Full Test Suite

**PASS** — 43/43 suites, 983/983 tests.

## 21. Remaining Issues

1. **No per-customer detail page.** The brief marks customer detail as "if the existing
   architecture allows". A customer is a `User` with orders, and the order detail page
   already covers the useful drill-down from either end; a dedicated customer page was
   judged unnecessary rather than half-built. The list columns (name, email, phone, orders,
   tickets, spend, last order) are all present.
2. **No date-range UI on Reports.** The window is set by `?from=` / `?to=` and defaults to
   the last 30 days. A date-picker component was not invented; the data is real and the
   window is explicit in the page description.
3. **Platform-scope financial aggregates.** A platform ADMIN without an organizer membership
   sees platform master-data metrics only (sports, PIC). Cross-tenant order/revenue
   aggregates are **deliberately** not exposed, because the authorization model grants no
   role tenant access without a membership and this task was explicitly forbidden from
   weakening it. If genuine cross-tenant platform reporting is wanted, it needs a new
   platform-scope permission and a design decision — not a UI shortcut.
4. **`/dashboard/events` renders an empty list** (rather than a denial) for an actor with no
   readable organizer. This is the pre-existing `listOrganizerEvents` contract; the layout
   still refuses entry to an actor with no tenant access *and* no platform capability.

## 22. Manual Steps Required

**None for this change.** No schema migration, no new environment variable, no new
third-party service.

Unchanged from the previous task and still required for live payments: iPaymu channel
activation (QRIS / VA / c-store) in the merchant dashboard, and pointing the iPaymu webhook
at `/api/ticketing/payment/webhook` on the deployed origin. The dashboard does not change
those requirements — and it will not mark anything paid, because it cannot.

## 23. Git Status

**Working tree is NOT clean** — the changes from this task and the preceding cleanup are
uncommitted, as instructed (no commit, no push).

```
$ git status --porcelain | awk '{print $1}' | sort | uniq -c
     20 ??      (new files: app/dashboard/**, lib/dashboard/**, DashboardAppShell.tsx, …)
    326 D       (deleted: retail app + app/organizer/** + app/platform/** + two shells)
     61 M       (modified: layouts, links, proxy, next.config, tests, …)

$ git diff --stat | tail -1
 387 files changed, 5660 insertions(+), 118536 deletions(-)
```
