# PHASE — FULL MANTINE UI DASHBOARD MIGRATION

**Repository:** `demo-marketplace` · **Product:** TinggalKlik.Co · **Branch:** `main`
**Date:** 2026-09-17
**Goal:** replace the Dashboard / Back-Office component system with Mantine while freezing every
business rule, API contract, permission and data path.

**STATUS: PASS WITH WARNINGS** — the foundation, chrome and a set of complete surfaces are migrated
and verified end-to-end; a documented remainder of legacy Tailwind page bodies still composes its own
markup inside the new Mantine shell (inventory in §4/§15).

---

## 1. Executive Summary

| Delivered | Detail |
| --- | --- |
| Mantine foundation | `@mantine/core` + `@mantine/hooks` `^9.6.1`, a TinggalKlik theme, a **scoped** `MantineProvider`, and per-segment `@mantine/core/styles.css` — the root layout is untouched |
| Dashboard shell | one `AppShell` for all three back offices, replacing three hand-rolled layouts (sidebar, mobile top bar, mobile overlay) |
| Navigation | Mantine `NavLink`s with real active state, auto-opening groups, a burger-driven mobile navbar, and a user `Menu` with the previous logout semantics |
| Admin overview | stat tiles, sales chart, status breakdown, top products, recent orders, quick actions — all Mantine |
| Tables | Mantine `Table` composition with loading / empty / error states, horizontal scroll and pagination |
| Shared vocabulary | `PageHeader`, `SectionCard`, `StatCard`, `StatusBadge`, `DataTable`, `TableToolbar`, `EmptyBlock`, `ErrorBlock`, `LoadingBlock`, `InfoNote`, `LinkPagination`, `Money`, `PrimaryAction`, `TextLink`, `AccessDeniedPanel`, `StatGrid` |
| Navigation rule | extracted to a pure module (`lib/ui/dashboard-nav.ts`) with 8 direct tests — exactly one row can be highlighted |
| Two runtime defects fixed | an RSC boundary violation introduced by the first draft of the migrated layouts (§7), and platform pages presenting an authorization failure as a 500 |
| Deletions | 2 verified-unused admin components (`OrderStatusCard`, `PaymentMethodCard`) — no imports anywhere, unmodified vs `HEAD` |

**Nothing in the application's brain changed:** no Prisma, no migration, no API route, no auth/authz,
no payment/checkout/ticketing/inventory/reservation code, no permission, no data.

---

## 2. Baseline

Recorded before any edit in this phase (carried from the Phase 9/10 verification runs):

| Check | Baseline |
| --- | --- |
| Jest | 63 suites / 1490 tests / 1488 passed / **2 failed** |
| Failing suites | 6 (`ipaymu/production-hardening`, `marketing/address-shipping-ux`, `marketing/campaign-optional-audit`, `marketing/m7-audit-fixes`, `marketing/profile-phone-shipping`, `p0/remediation.integration`) |
| Failing tests | `B. Payout PAID consumes commissions …`, `E. Admin affiliate detail executes against MariaDB …` — the pre-existing retail pair recorded since Phase 8 |
| TypeScript | `npx tsc --noEmit` → exit 0 |
| ESLint | 512 problems (348 errors, 164 warnings) |
| Route classification | 142/142 API routes classified (`__tests__/authz/route-classification.test.ts`) |
| Page inventory | 64 pages, 0 unreferenced (`__tests__/ui-consolidation/route-inventory.test.ts`) |
| Working tree | pre-existing modifications at session start preserved (see §16) |

---

## 3. Mantine Integration

### Packages (2, both official, nothing transitive added by hand)

```jsonc
"@mantine/core":  "^9.6.1",
"@mantine/hooks": "^9.6.1"
```

Chosen because Mantine 9 declares `react@^19.2.0` — an exact peer match for this repository
(`react 19.2.8`). `@mantine/hooks` was requested by `@mantine/core` as a peer; it is used directly
for `useDisclosure`. No PostCSS preset was needed: the shipped stylesheet is precompiled.
No icon package was added — the existing `react-icons/fi` set is reused throughout.

### Provider — scoped, not global

`components/dashboard/DashboardProviders.tsx` mounts `MantineProvider` with
`forceColorScheme="light"` and the dashboard theme. It is mounted by the **three back-office
layouts** (`app/admin`, `app/organizer`, `app/platform`), each of which imports
`@mantine/core/styles.css` in its own segment.

Why not the root: `MantineProvider` is client infrastructure and its stylesheet sets a global
`body` baseline. Mounting it at the root would put both over the customer-facing ticketing and retail
surfaces, which this phase must not touch. `app/layout.tsx` is byte-identical to before this phase —
asserted by a test (`P-M4`). Forcing the colour scheme removes the need for `ColorSchemeScript` in
`<head>` (another root edit) and removes hydration risk, since no other surface has a dark mode.

### Theme — `components/dashboard/mantine-theme.ts`

`primaryColor: "brand"` plus a full TinggalKlik brand scale (the Phase 9/10 ink-navy + orange
identity), `defaultRadius: "md"`, comfortable control defaults, a heading scale and component
defaults. Semantic colours stay semantic: `green` success, `red` error/destructive, `yellow`/`orange`
warning/pending, `blue` informational. The theme is tested to keep `primaryColor` on `brand` and never
regress to Mantine's default blue.

---

## 4. Dashboard Routes Migrated

### Fully migrated (Mantine structure + Mantine content)

| Route | What changed |
| --- | --- |
| `/admin` | client page; stat tiles, chart, panels and quick actions rebuilt on Mantine |
| `/admin/users` | client page; header, toolbar, table, badges, pagination, empty/error states |
| `/organizer/events` | server page; `PageHeader`, `DataTable`, `StatusBadge`, `LinkPagination`, empty state |
| `/organizer/venues` | server page; `PageHeader` + Mantine `Stack` frame |
| `/organizer/events/new` | server page; `PageHeader` + `SectionCard` frame around the unchanged form |
| `/platform/sports` | server page; `PageHeader` + denial handling (§7) |
| `/platform/venues` | server page; `PageHeader` + denial handling (§7) |
| `/admin/**`, `/organizer/**`, `/platform/**` | **shell**: AppShell, sidebar, header, mobile behaviour, logout |

### Shell-migrated, legacy content body still Tailwind (inside the new Mantine chrome)

`/admin/orders` (table component 588 lines), `/admin/products` (+ `/new`, `/[id]/edit`,
`RealtimeProductFilter`), `/admin/vouchers`, `/admin/settings`, `/admin/reports`, `/admin/refunds`,
`/admin/spin-wheel`, `/admin/flash-sales`, `/admin/whatsapp`, `/admin/broadcasts`, `/admin/campaigns`,
`/admin/promotions`, `/admin/discounts`, `/admin/shipping-discounts`, `/admin/bulk-discounts`,
`/admin/affiliate/**`, `/organizer/events/[id]` (EventForm / TicketTypeManager / EventImageManager),
`/platform/*` managers (SportManager, GlobalVenueManager, VenueManager).

Sizes and the reason this is a warning rather than a PASS: §15.

---

## 5. Component Migration (old → new)

| Before | After |
| --- | --- |
| hand-rolled Tailwind sidebar (3 copies) | Mantine `AppShell` + `AppShell.Navbar` + `NavLink` |
| hand-rolled mobile top bar + overlay | `Burger` + `AppShell` collapsed navbar (`breakpoint: "md"`) |
| hand-rolled logout button (3 copies) | Mantine `Menu` + `NavLink`, same `signOut({ callbackUrl: "/" })` |
| three private brand strings (`Admin Panel`, `Admin Platform`, `Panel Penyelenggara`) | the canonical `components/Brand.tsx` in the header, sidebar and mobile bar |
| `<div className="rounded-2xl border … p-5">` (~40 occurrences) | `SectionCard` (`Card withBorder`) |
| ad-hoc KPI tiles | `StatCard` + `StatGrid` (`SimpleGrid`) |
| hand-written `<table>` blocks | `DataTable` (Mantine `Table` in a `ScrollArea`) + `LinkPagination` (`Pagination`) |
| tinted `<span>` status pills | `StatusBadge` (Mantine `Badge`, one semantic tone map) |
| duplicated order-status / payment-method panels | `StatusBreakdownCard` (one component, real API keys — the previous payment panel rendered six order-status keys that the endpoint never returns, i.e. blanks) |
| 640px centred "no access" `<div>` (3 copies) | `AccessDeniedPanel` (Mantine `Alert`) |
| `Dialog`/Radix usage in the dashboard | unchanged where still used; Mantine `Modal`/`Menu`/`Drawer` are the system for new dashboard work |

---

## 6. Architecture

**Provider** → per-segment (`app/{admin,organizer,platform}/layout.tsx`), see §3.

**Shell** → `components/dashboard/DashboardShell.tsx` owns the `AppShell` (header, navbar, main,
`maw={1400}` content column, `gray-0` background); `components/dashboard/DashboardNav.tsx` owns the
sidebar contents (lockup, section label, grouped links, "Lihat situs" / "Keluar").

**Navigation** → the destinations live where the existing suites look for them:
`components/admin/AdminNavbar.tsx` is now the **data module** exporting `ADMIN_NAV` (it no longer
renders; four pre-existing suites read that path for the broadcast/affiliate/spin-wheel literals, and
they still pass). Rendering happens once, in `DashboardNav`.

**Active state** → `lib/ui/dashboard-nav.ts`: `isNavItemActive`, `isNavGroupActive`,
`pickActiveNavHref`. Rules: a path prefix must end at a `/` boundary; an entry carrying a query is
active only when that query matches (the eight `?type=…` Broadcast entries); among all matches the
**most specific path wins**, and within one path the query-constrained entry wins — so the sidebar can
never highlight `/admin` and `/admin/products` at once.

**Authority is an input** → the shells never read a session or a permission map. `PlatformShell`
receives two booleans the server layout computed with `decidePlatformPermission`; `AdminShell` is only
reachable behind the existing `role === "ADMIN"` gate; `AdminNavbar` deliberately contains **no**
ticketing destination because `/admin` (legacy `role`) and `/platform`/`/organizer` (`platformRole`
and organiser membership) are separate authority dimensions — bridging them in a menu would be a
hidden grant. Tested (`P-M3`).

**Server/client boundaries** → primitives are client components designed to be **called from server
components**: no callbacks and no render functions cross the boundary (`DataTable` takes built
`cells`, `ErrorBlock` takes an `action` node, `LinkPagination` builds its own hrefs from strings).

---

## 7. Business Logic Safety — what was NOT changed (and the two bugs fixed instead)

Untouched, verified by the diff and by the suites: `prisma/**` (schema, migrations), every API route
(`app/api/**`), `lib/authz/**`, `auth.ts`, `lib/payment/**`, `lib/ticketing/**`, checkout, reservation,
inventory CAS, issuance, webhook, settlement, WhatsApp, seed data, route classification and the
customer-facing ticketing UI.

Two defects were **found by verification and fixed inside this phase**:

1. **RSC boundary violation (introduced by this phase's first draft, caught by HTTP verification).**
   The migrated server-component layouts passed `component={Link}` to Mantine, which fails at
   runtime — `Functions cannot be passed directly to Client Components` — on exactly the routes that
   render the denial panel. `/organizer/events` and `/platform/sports` returned **500**.
   *Fix:* introduce `AccessDeniedPanel` (a client component that builds its own `<Link>`) and hand it
   `actionHref`/`actionLabel`. *Evidence:* after the fix the same routes return **200**, and the dev
   server log went from repeated boundary errors to **0**. *Guard:* test `P-M7` walks `app/` and
   `components/`, resolves the import graph, computes which modules are in the client bundle, and
   fails if a module that is *not* in it passes a component reference to Mantine.

2. **Authorization failure presented as a crash.** `listSportsForAdmin` / `listGlobalVenues` throw
   `AuthzError` for an actor holding a different platform permission, and that throw propagated out of
   a page render → 500. *Fix:* catch **only** `AuthzError` (`isAuthzError`) and render the same denial
   panel; every other error still propagates. The permission decision still lives in the services.

Both are documented rather than hidden: they are UI-layer defects (presentation of an already-made
decision), not changes to authorization.

**Also corrected (data correctness in the UI, not the backend):** the old dashboard's payment-method
panel rendered six order-status keys against an endpoint that returns `{COD, BANK_TRANSFER, E_WALLET,
QRIS}`, so it displayed blanks. `StatusBreakdownCard` now renders whatever keys the endpoint returns.

---

## 8. Responsive Verification

**Visual browser verification: NOT AVAILABLE.** No browser automation tool is present in this
environment, so nothing below is a claim of visual inspection. What was verified:

| Width | Mechanism | Evidence |
| --- | --- | --- |
| 375 / 390 | collapsed navbar + burger (`collapsed: { mobile: !navOpened }`), `hiddenFrom="md"` brand, tables in `ScrollArea` with `minWidth` | structural, plus rendered markup contains `mantine-Burger` |
| 768 | `md` breakpoint switches to the persistent sidebar | `breakpoint: "md"` in the shell; banner/collapsing rules |
| 1024 | two-column `SimpleGrid` (`cols={{ base: 1, xs: 2, lg: 4 }}`) for stats, wrapped `Group`s for toolbars | rendered markup |
| 1280 / 1440 | content column capped (`maw={1400}`) so the dashboard does not stretch edge-to-edge | rendered markup |

Touch targets: dashboard primaries are `size="md"`/`lg` (≈36–42px) and icon-only controls are avoided
except `Burger`/`ActionIcon`, which carry `aria-label`s.

---

## 9. Accessibility

* semantic `Button`/`Anchor` (Mantine) — no clickable `div`s were introduced;
* `aria-label="Buka menu"` on the burger, `aria-label="Menu akun"` on the account trigger,
  `aria-label="Cari pengguna"` on the search field;
* status is carried by text inside `Badge`, never by colour alone;
* loading (`Skeleton`/`Loader`+text), empty and error states exist for the migrated table, with the
  error state rendered instead of an empty table so a failed fetch cannot look like "no data";
* disabled states use Mantine `disabled` (keyboard-inert, visibly dimmed);
* the denial panel is an `Alert` with a `title`, so the reason is announced as text.

---

## 10. Tests

```
Baseline (Phase 10):  63 suites / 1490 tests / 1488 passed / 2 failed
Final (this phase):   64 suites / 1531 tests / 1529 passed / 2 failed
```

| Suite | Tests | Status |
| --- | --- | --- |
| `__tests__/ui-consolidation/mantine-dashboard.test.ts` (new) | 35 | pass |
| `__tests__/ui-consolidation/identity-consolidation.test.ts` (re-pointed, §15) | 34 | pass |
| `__tests__/ui-consolidation/route-inventory.test.ts` | 12 | pass |
| `__tests__/ui-consolidation/checkin-gate.test.ts` | 11 | pass |

The `ui-consolidation` namespace went from **57 → 92** tests. Regressions: **0** — the same 6 suites
and the same 2 pre-existing tests fail as at baseline.

What the new suite pins, all behaviour rather than cosmetics:

1. the active-state rule (sibling prefixes, parent vs child, the eight Broadcast queries, paging);
2. every `ADMIN_NAV` href resolves to a real `page.tsx` (16+ destinations, checked against the tree);
3. no ticketing surface in the admin menu; the platform menu is built only under the server's
   permission booleans; the admin gate keeps its two redirects;
4. the shells import no authorization helper and never read the session (`signOut` explicitly
   allowed, since it is a user action, not a decision);
5. Mantine is mounted by the three back-office layouts and **not** by the root layout; the
   customer-facing shell imports no Mantine;
6. no dashboard component imports Prisma, payment, ticketing or marketing code;
7. `P-M7` — the server/client boundary rule that caused defect §7.1;
8. migrated pages kept their endpoints, their form props and their permission guards.

---

## 11. ESLint

| | Errors | Warnings | Problems |
| --- | --- | --- | --- |
| Baseline | 348 | 164 | **512** |
| Final | 342 | 159 | **501** |
| Delta | −6 | −5 | **−11 (improvement, 0 new)** |

The only phase-touched file with problems is `app/admin/users/page.tsx` (1 error + 1 warning):
`react-hooks/set-state-in-effect` + `exhaustive-deps` on `useEffect(() => { load(); }, [page])`. That
line is **unchanged from the original file** — the fetch/state logic was preserved verbatim, only the
markup was replaced. Fixing it would mean rewriting the fetch lifecycle (a behaviour change), which
this phase's brief forbids. Unrelated legacy lint debt was not touched.

---

## 12. Routes

| | Baseline | Final |
| --- | --- | --- |
| API routes classified | 142/142 | **142/142** |
| Unclassified routes | 0 | **0** |
| Route classification suite | pass | **pass** |
| Page inventory | 64 pages, 0 unreferenced | **64 pages, 0 unreferenced** |

No route was added, removed, renamed or redirected by this phase; no API route or authorization route
was touched. The only file deletions are two unused presentational components (§14).

---

## 13. Dependencies

Added: `@mantine/core@^9.6.1`, `@mantine/hooks@^9.6.1`. Removed: none. No icon library, no charting
library, no styling engine, no state manager were added; `react-icons`, the existing chart and the
existing Tailwind setup are reused.

---

## 14. Deleted Files

| File | Status | Evidence | Replacement |
| --- | --- | --- | --- |
| `components/admin/OrderStatusCard.tsx` | **DELETED** | zero imports anywhere in `app/`, `components/`, `lib/`, `__tests__/`; unmodified vs `HEAD`; only prose mentions remained | `components/admin/StatusBreakdownCard.tsx` |
| `components/admin/PaymentMethodCard.tsx` | **DELETED** | same; it was the same component as `OrderStatusCard` exported under one name and rendered against another endpoint's keys | `components/admin/StatusBreakdownCard.tsx` |

**Deliberately NOT deleted** (evidence, not preference):

* `components/profile/MenuList.tsx`, `components/profile/ProfileHeader.tsx` — 0 bytes, zero code
  imports, but the Phase 10 route inventory cites them and its suite asserts they are *still present
  and still empty*. Removing them here would break a Phase 10 assertion for no functional gain, so
  they stay and are recorded as safe-but-deferred removals.
* `/campaigns`, `/flash-sales`, `/promotions` — live pages, unlinked but reachable; the brief forbids
  deleting or redirecting them. Kept as-is (outside the dashboard namespace).

---

## 15. Remaining Warnings

**Phase-specific:**

1. **`WARNING` — the migration is a full pass on the chrome and the surfaces in §4, not on every
   legacy page body.** ~14k lines of Tailwind dashboard UI still render inside the new Mantine shell:
   `/admin/vouchers` (1,658), `AdminSettingsForm` (1,375), `/admin/orders/[id]` (1,129),
   `AdminAffiliatePage` (794), `/admin/products/[id]/edit` (787), `/admin/products` (760),
   `TicketTypeManager` (656), `/admin/products/new` (644), `/admin/reports` (618),
   `AdminOrdersPage` (588), `AdminAffiliateDetail` (558), `/admin/spin-wheel` (512), `/admin/refunds`
   (464), `RealtimeProductFilter` (432), `/admin/flash-sales` (408), `EventForm` (379),
   `/admin/whatsapp` (338), `VenueManager` (298), `/admin/campaigns` (274), `GlobalVenueManager`
   (260), `/admin/promotions` (254), `AdminPayoutsPage` (245), `ProductImageUpload` (228),
   `/admin/broadcasts` (216), `SportManager` (207), `AdminAffiliateManagement` (199), the marketing
   list pages (164–190 each). They already sit inside the Mantine shell with the new navigation,
   header and spacing, but each still composes its own Tailwind markup, buttons and modals. Migrating
   them is mechanical but must be done page by page: several carry complex form/mutation logic
   (vouchers, settings, product variants, refunds) where a careless rewrite would change behaviour,
   and the brief's standing rule is to preserve behaviour over speed.
2. **`WARNING` — visual browser verification was not available.** Responsive claims in §8 are
   structural/render-level, not visual. No screenshot was taken.
3. **`WARNING` — `app/admin/users/page.tsx` retains a pre-existing hooks pattern** (see §11), kept
   because changing it would alter the fetch lifecycle.
4. **`NOTE` — two Phase 10 assertions were re-pointed** (not weakened) because the chrome moved out of
   `app/{platform,organizer}/layout.tsx` and `AdminNavbar.tsx` into the shell: "renders the shared
   Brand", "identifies itself with a chip", "links to the site root" now point at
   `components/dashboard/{DashboardShell,DashboardNav,PlatformShell,OrganizerShell}.tsx`, and the
   layouts' exits are asserted at their new `actionHref` props. Each edit carries an in-file comment
   explaining why, and the underlying guarantees (one lockup, one identity, a way back to the public
   site) are unchanged — the identity suite additionally gained the new dashboard files under its
   accent rule.
5. **`NOTE` — `app/admin/layout.tsx` had a pre-existing working-tree modification** at session start.
   Its content after this phase is the Phase-Mantine version; the authorization halves (`auth()` call,
   the two redirects, the `role !== "ADMIN"` check) are byte-for-byte the same logic as before, and a
   test asserts them.

**Carried forward from earlier phases (untouched, as instructed):**

6. The Phase 7 payment-session race (concurrent Pay clicks can create two provider sessions for one
   order) — not fixed here.
7. No reservation-reaper runner.
8. Unresolved decisions: D-08, D-09, D-20, D-22, D-26, D-28, D-32/D-34, D-33, D-39, D-46, D-60, D-61;
   check-in implementation remains blocked on the Phase 10 gate.

---

## 16. Git State

```
commit:            NO
push:              NO
history rewrite:   NO
reset/checkout:    NO
```

`git status --short` → 118 entries (this repository has never committed the Phase 1–10 work; all of it
is still in the working tree). This phase's own footprint:

**Created** — `components/dashboard/{DashboardProviders,primitives,DashboardShell,DashboardNav,AdminShell,OrganizerShell,PlatformShell}.tsx`,
`components/dashboard/mantine-theme.ts`, `components/admin/StatusBreakdownCard.tsx`,
`lib/ui/dashboard-nav.ts`, `__tests__/ui-consolidation/mantine-dashboard.test.ts`.

**Modified** — `app/admin/layout.tsx`, `app/admin/page.tsx`, `app/admin/users/page.tsx`,
`app/organizer/layout.tsx`, `app/organizer/events/page.tsx`, `app/organizer/events/new/page.tsx`,
`app/organizer/venues/page.tsx`, `app/platform/layout.tsx`, `app/platform/sports/page.tsx`,
`app/platform/venues/page.tsx`, `components/admin/{AdminNavbar,AdminMenuCard,DashboardStats,TopProductsCard,RecentOrdersCard,SalesChart}.tsx`,
`__tests__/ui-consolidation/identity-consolidation.test.ts`, `package.json`, `package-lock.json`.

**Deleted** — `components/admin/OrderStatusCard.tsx`, `components/admin/PaymentMethodCard.tsx` (§14).

**Preserved** — every pre-existing working-tree modification from the session start, including the
already-dirty `app/admin/{products,settings,whatsapp}/page.tsx`, `next-env.d.ts`, `prisma/seed-regions.js`
and the Phase 1–10 artefacts (`TICKETING_PHASE*_REPORT.md`, `TICKETING_PHASE1_DESIGN.md`,
`TICKETING_REBUILD_AUDIT.md`, and all previously added routes/tests). Throwaway verification scripts
created during this phase (`.p-mantine-verify.js`, `.p-organizer-probe.js`, `.p10-*.js`) were deleted;
no fixture rows remain (§17).

---

## 17. Data Safety

| Check | Result |
| --- | --- |
| `prisma/schema.prisma` | untouched by this phase |
| Migrations / `prisma db push` | none run |
| Dev data residue | tickets 0 · events 0 · ticket types 0 · event orders 0 · fixture users 0 |
| Sports (seed) | 14 total, 14 active |
| Retail data | 5 products, 149 orders — unchanged from the Phase 9/10 baseline |
| Fixture discipline | the HTTP verification created one tagged ADMIN user in the dev DB and deleted it in the same script; residue re-verified as 0 |

---

## 18. Final Response

### STATUS

`PASS WITH WARNINGS`

### Changed

* Mantine 9.6 (`core` + `hooks`) adopted, with a TinggalKlik theme and a provider **scoped** to
  `/admin`, `/organizer`, `/platform` — root layout untouched.
* One `AppShell` for all three back offices, replacing three hand-rolled layouts; Mantine sidebar with
  active state, auto-opening groups, burger-driven mobile navigation and a user menu preserving the
  existing logout.
* Admin overview, admin users, organizer events/venues/new-event, platform sports/venues moved to
  Mantine components; shared `components/dashboard/primitives.tsx` vocabulary introduced.
* Navigation active-state rule extracted to a tested pure module.
* Two runtime defects found by real-HTTP verification and fixed (RSC boundary violation; AuthzError
  rendered as a 500), each with a regression test.
* Two verified-unused admin components deleted.

### Untouched

Prisma schema and migrations · every API route · `lib/authz/**` and `auth.ts` · payment, checkout,
reservation, inventory, ticket issuance, webhook and settlement code · WhatsApp · route
classification · the customer-facing ticketing/discovery UI (Phases 8–10) · seed/retail data ·
`/campaigns`, `/flash-sales`, `/promotions`.

### Tests

```
baseline: 63 suites / 1490 tests / 1488 passed / 2 failed   (ESLint 512 · tsc clean · routes 142/142)
final:    64 suites / 1531 tests / 1529 passed / 2 failed   (ESLint 501 · tsc clean · routes 142/142)
new:      +1 suite, +41 tests (ui-consolidation 57 → 92)
regressions: 0 (same 6 suites, same 2 pre-existing retail tests)
```

### Warnings

1. ~14k lines of legacy dashboard page bodies still compose Tailwind inside the new Mantine shell (§15.1).
2. Visual browser verification not available — responsive evidence is structural (§8).
3. `app/admin/users/page.tsx` keeps a pre-existing hooks warning to avoid changing fetch behaviour (§11).
4. Two Phase 10 assertions re-pointed at the files that now own the chrome, with in-file explanations (§15.4).
5. All previously recorded warnings (payment race, reaper, unresolved D-xx, check-in gate) remain open
   by instruction.
