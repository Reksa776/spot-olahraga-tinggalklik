# DASHBOARD_NAVBAR_FIX_REPORT

Scope: the unified `/dashboard` sidebar / mobile drawer navigation.
No dashboard architecture, auth, authorization, business/API logic, schema, or refund Phase 10B work was modified. Nothing was committed or pushed.

---

## 1. Navigation before this change

The unified dashboard existed with all its pages, but the sidebar rendered the destinations as a **single flat, unlabeled list**:

| Label | Route |
|---|---|
| Ringkasan | `/dashboard` |
| Event & Tiket | `/dashboard/events` |
| Pesanan | `/dashboard/orders` |
| Pelanggan | `/dashboard/customers` |
| Pembayaran | `/dashboard/payments` |
| Refund | `/dashboard/refunds` |
| PIC | `/dashboard/pic` |
| Laporan | `/dashboard/reports` |
| Pengaturan | `/dashboard/settings` |

Problems observed:
- No section headers or grouping — nine rows in a row read as an empty, unfinished rail.
- `/dashboard/venues` existed and was usable but had **no nav entry** (a real destination the menu did not advertise).
- No identity block at the bottom of the sidebar.
- Row hit-areas were compact; there was no vertical rhythm to fill the rail.

## 2. Navigation after this change

The same destinations, now organized into labeled sections, ordered deliberately. Only real, usable pages are linked — nothing was invented to fill space.

**RINGKASAN**
- Dashboard → `/dashboard`

**EVENT & TIKET**
- Event → `/dashboard/events`

**PENJUALAN**
- Pesanan → `/dashboard/orders`
- Pelanggan → `/dashboard/customers`
- Pembayaran → `/dashboard/payments`
- Refund → `/dashboard/refunds`

**ORANG**
- PIC → `/dashboard/pic`

**LAPORAN**
- Laporan → `/dashboard/reports`

**VENUE & PENGATURAN**
- Venue → `/dashboard/venues` *(newly exposed — the page existed)*
- Pengaturan → `/dashboard/settings`

## 3. Files changed

| File | What changed |
|---|---|
| `components/dashboard/DashboardAppShell.tsx` | Nav re-declared as capability-gated rows carrying a `section`; folded into `SECTION_ORDER` labelled groups; **Venue** row added; icons moved from `react-icons/fi` to `lucide-react` (the shell/sidebar icon convention). |
| `components/dashboard/DashboardNav.tsx` | Renders labelled sections flat (no accordions); section label lights when a child is active; sidebar-footer identity block (avatar + name/email) added; `userName`/`userEmail` accepted. |
| `components/dashboard/DashboardShell.tsx` | `ShellNavItem` re-exported; `nav` typed as `ShellNavGroup[]`; `findActiveLabel` simplified for grouped nav; identity threaded into the nav slot. |
| `components/dashboard/ui/sidebar.tsx` | `SidebarMenuButton` row padding `py-2.5` → `py-3`, `px-2.5` → `px-3` for a comfortable hit area. |

No backend, schema, API, or page files were touched.

## 4. Routes represented

Every entry resolves to a page file that exists and is wired into the app:

- `/dashboard` — `app/dashboard/page.tsx`
- `/dashboard/events` — `app/dashboard/events/page.tsx` (+ `/new`, `/[id]` covered by the prefix rule)
- `/dashboard/orders` — `app/dashboard/orders/page.tsx` (+ `/[orderNumber]`)
- `/dashboard/customers` — `app/dashboard/customers/page.tsx`
- `/dashboard/payments` — `app/dashboard/payments/page.tsx`
- `/dashboard/refunds` — `app/dashboard/refunds/page.tsx`
- `/dashboard/pic` — `app/dashboard/pic/page.tsx` (+ `/[id]`)
- `/dashboard/reports` — `app/dashboard/reports/page.tsx`
- `/dashboard/venues` — `app/dashboard/venues/page.tsx`
- `/dashboard/settings` — `app/dashboard/settings/page.tsx` (+ `/settings/sports`, `/settings/venues`)

## 5. Visual / layout improvements

- **Labelled sections** with uppercase tracked captions create a clear hierarchy instead of a flat list.
- **Sections never render empty** — a section a caller has no rows for disappears entirely.
- **Row hit area enlarged** (`py-3`, `px-3`), consistent 18px icons, `truncate` labels — no overflow.
- **Active row** keeps the brand-coloured pill; the owning **section label brightens** when one of its rows is active.
- **Hover state** preserved (`bg-sidebar-accent`), selected state via `data-[active=true]`, focus-visible ring retained.
- **Sidebar footer** now shows who is signed in (avatar + name/email) above the existing “Lihat situs” and “Keluar” actions — the rail reads as one composed surface (brand, navigation, account).
- The desktop rail keeps its width (`17.25rem`), collapses to an icon strip with tooltips, and stays fully usable when collapsed (labels and identity hide, icons centre).
- Done with existing semantic tokens only — no new palette, no literal colours.

## 6. Permission behavior

Unchanged semantics, same mechanism the tests pin:

- Visibility is still driven by the server-computed `DashboardCapabilities` booleans in `app/dashboard/layout.tsx` → `computeDashboardCapabilities` → the real `decidePlatformPermission` / `decideOrganizerPermission` deciders. No `role === "ADMIN"` checks were introduced anywhere.
- Each destination is gated by the capability its page/service actually requires:
  - **Event** → `canReadEvents`
  - **Orders / Customers / Refund** → `canReadOrders`
  - **Payments** → `canReadPayments`
  - **PIC** → `canAssignPic` (organizer) **or** `canManagePlatformPic` (platform)
  - **Reports** → `canReadReports`
  - **Venue** → `canManageVenues` (organizer tenant venues)
  - **Settings** → `canManageSports` / `canManageGlobalVenues` / `canManageVenues`
  - **Dashboard** → always (entry gate already decided by the layout)
- The menu is not the access control — hiding is courtesy; direct-URL protection on every `/dashboard/*` page and its services is untouched and unchanged.

## 7. Mobile behavior

- The mobile drawer renders the **same** nav children (single source), so drawer and rail can never list different destinations.
- Close-on-select preserved: `onNavigate` closes the drawer, and the pathname effect in `DashboardShell` also self-closes on navigation.
- Row hit areas are comfortable (`py-3`), labels truncate, `overflow-x-hidden` on the content region prevents horizontal overflow.
- Active-state highlighting applies identically in the drawer.

## 8. Verification results

- `npx tsc --noEmit` — clean.
- `npx eslint` on the changed files — clean (repo-wide lint has pre-existing errors in `scripts/*` and `server.js`, none in dashboard files).
- `npx jest` — 42/48 suites passed; the 6 failures are **pre-existing database integration suites** (`ticketing-*checkout/issuance/payment/refunds*.integration.test.ts`) that exercise `lib/ticketing/*` against MySQL and import none of the changed files.
- `npx jest __tests__/ui-consolidation` — **93/93 passed**, including the `shadcn-dashboard` suite that pins:
  - every advertised nav href resolves to a real page file,
  - the menu is built from the capability booleans (`.filter((item) => item.visible)`),
  - the shell never decides access itself (no `authz` import, no `useSession`),
  - active-state rule delegation to `lib/ui/dashboard-nav.ts`,
  - no hardcoded surface colours in changed files,
  - identity/lockup consolidation assertions.
- `npx next build` — succeeded; all `/dashboard/**` routes registered and compiled as dynamic.
- Runtime smoke test (`next start`): `/dashboard` redirects to `/login?callbackUrl=%2Fdashboard`, `/login` serves 200 — the shell bootstraps without errors.

## 9. Remaining UI issues

- The account identity appears in both the top-bar account menu and the sidebar footer; this is intentional (footer identity + top-bar actions), but a future pass could make the footer block open the account menu to fully merge the two.
- For callers with very few permissions (e.g. a check-in staff who cannot enter at all under the current gate), the menu is accordingly small — this is correct behaviour, not underfilling.
- Section labels are static strings in `DashboardAppShell`; if new sections are added later they must be added to `SECTION_ORDER` in one place.
- The pre-existing database integration test failures noted in §8 are unrelated to this change and should be addressed against the local MySQL environment separately.