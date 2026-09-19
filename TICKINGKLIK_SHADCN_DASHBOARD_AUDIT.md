# TINGGALKLIK.CO — SHADCN DASHBOARD MIGRATION AUDIT

**Phase:** Full dashboard shadcn/ui + theme system + chart system
**Repository:** Reksa776/demo-marketplace
**Scope:** `/admin/**`, `/organizer/**`, `/platform/**` and every dashboard-owned component
**Constraint:** UI migration only. Auth, authz, APIs, Prisma, payment, ticketing and customer-facing
UI are frozen.

> **Status of this phase.** BATCH 2–9 (the shadcn foundation) and a first slice of page batches were
> already landed on this branch before this audit was written. This document therefore records the
> **actual repository state**: what is migrated, what still imports Mantine, and the order the
> remainder is converted in. It is a working inventory, not a proposed design.

---

## 1. DASHBOARD ROUTES (fresh inventory)

### 1.1 Admin — `app/admin/**` (25 route files)

| Route | File | Mantine at audit time |
| --- | --- | --- |
| `/admin` | `app/admin/page.tsx` | no |
| `/admin/layout` | `app/admin/layout.tsx` | **yes** (stylesheet import) |
| `/admin/users` | `app/admin/users/page.tsx` | **yes** |
| `/admin/orders` | `app/admin/orders/page.tsx` | no |
| `/admin/orders/[id]` | `app/admin/orders/[id]/page.tsx` | **yes** |
| `/admin/products` | `app/admin/products/page.tsx` | **yes** |
| `/admin/products/new` | `app/admin/products/new/page.tsx` | **yes** |
| `/admin/products/[id]/edit` | `app/admin/products/[id]/edit/page.tsx` | **yes** |
| `/admin/vouchers` | `app/admin/vouchers/page.tsx` | **yes** |
| `/admin/discounts` | `app/admin/discounts/page.tsx` | **yes** |
| `/admin/bulk-discounts` | `app/admin/bulk-discounts/page.tsx` | **yes** |
| `/admin/settings` | `app/admin/settings/page.tsx` | no (form has Mantine) |
| `/admin/reports` | `app/admin/reports/page.tsx` | **yes** |
| `/admin/refunds` | `app/admin/refunds/page.tsx` | **yes** |
| `/admin/campaigns` | `app/admin/campaigns/page.tsx` | **yes** |
| `/admin/promotions` | `app/admin/promotions/page.tsx` | **yes** |
| `/admin/flash-sales` | `app/admin/flash-sales/page.tsx` | **yes** |
| `/admin/broadcasts` | `app/admin/broadcasts/page.tsx` | **yes** |
| `/admin/shipping-discounts` | `app/admin/shipping-discounts/page.tsx` | **yes** |
| `/admin/spin-wheel` | `app/admin/spin-wheel/page.tsx` | **yes** |
| `/admin/whatsapp` | `app/admin/whatsapp/page.tsx` | no (dashboard has Mantine) |
| `/admin/affiliate` | `app/admin/affiliate/page.tsx` | no |
| `/admin/affiliate/manage` | `app/admin/affiliate/manage/page.tsx` | no |
| `/admin/affiliate/manage/[id]` | `app/admin/affiliate/manage/[id]/page.tsx` | no |
| `/admin/affiliate/payouts` | `app/admin/affiliate/payouts/page.tsx` | no |
| `/admin/affiliate/audit-log` | `app/admin/affiliate/audit-log/page.tsx` | no |

### 1.2 Organizer — `app/organizer/**` (5 route files)

| Route | File | Mantine at audit time |
| --- | --- | --- |
| `/organizer/layout` | `app/organizer/layout.tsx` | **yes** |
| `/organizer/events` | `app/organizer/events/page.tsx` | **yes** |
| `/organizer/events/new` | `app/organizer/events/new/page.tsx` | **yes** |
| `/organizer/events/[id]` | `app/organizer/events/[id]/page.tsx` | **yes** |
| `/organizer/venues` | `app/organizer/venues/page.tsx` | **yes** |

### 1.3 Platform — `app/platform/**` (3 route files)

| Route | File | Mantine at audit time |
| --- | --- | --- |
| `/platform/layout` | `app/platform/layout.tsx` | **yes** |
| `/platform/sports` | `app/platform/sports/page.tsx` | **yes** |
| `/platform/venues` | `app/platform/venues/page.tsx` | **yes** |

No `/platform` page renders a public footer marker of its own — the suppression is global to the
dashboard shell (§7).

---

## 2. DASHBOARD LAYOUTS

| Layout | Role | Decision made there (FROZEN) |
| --- | --- | --- |
| `app/admin/layout.tsx` | server | `auth()` → `redirect("/login")` when anonymous → `redirect("/products")` when `role !== "ADMIN"` |
| `app/organizer/layout.tsx` | server | `getOrganizerPageContext()`; zero tenant ⇒ `AccessDeniedPanel`; second `auth()` is **display only** |
| `app/platform/layout.tsx` | server | `getAuthzScope()` → `/login`; `decidePlatformPermission(SPORT_MANAGE / VENUE_MANAGE_GLOBAL)`; both false ⇒ `AccessDeniedPanel` |

All three are `force-dynamic`, all three render `<DashboardProviders>` and are **unchanged in their
authorization behaviour** by this migration. Their only pending change is presentational: dropping
the `@mantine/core/styles.css` import and the Mantine `<Text>` used in the denial body.

---

## 3. DASHBOARD COMPONENTS

### 3.1 Foundation (already shadcn — pinned Mantine-free by `__tests__/ui-consolidation/shadcn-dashboard.test.ts`)

```
components/dashboard/DashboardShell.tsx    shell: sidebar + topbar + capped content canvas
components/dashboard/DashboardNav.tsx      sidebar navigation groups/items
components/dashboard/AdminShell.tsx        binds ADMIN_NAV to the shell
components/dashboard/OrganizerShell.tsx    binds ORGANIZER_NAV
components/dashboard/PlatformShell.tsx     builds nav from the server's permission booleans
components/dashboard/primitives.tsx        the shared vocabulary (see §3.3)
components/dashboard/theme/theme-config.ts catalogue + pre-paint bootstrap script
components/dashboard/theme/theme-provider.tsx next-themes + accent/chart persistence
components/dashboard/theme/theme-switcher.tsx appearance / accent / chart-palette menu
components/dashboard/ui/*                  the shadcn kit (§5)
lib/utils.ts                               the `cn()` helper every kit file uses
lib/ui/dashboard-nav.ts                    active-destination rule (pure, tested)
```

### 3.2 Consumers still to migrate (44 files, 18,477 lines)

**Shared dashboard:** `DashboardProviders.tsx`, `mantine-theme.ts` (**delete**)

**Organizer (7):** `EventForm.tsx`, `EventActions.tsx`, `EventImageManager.tsx`,
`TicketTypeManager.tsx`, `VenueManager.tsx` + `app/organizer/{venues,events,events/new,events/[id]}`

**Platform (5):** `SportManager.tsx`, `GlobalVenueManager.tsx` + `app/platform/{layout,sports,venues}`

**Admin components (11):** `ProductImageUpload.tsx`, `DeleteProductButton.tsx`,
`RealtimeProductFilter.tsx`, `orders/AdminOrdersPage.tsx`, `affiliate/AdminAffiliateDetail.tsx`,
`affiliate/AdminAffiliateManagement.tsx`, `affiliate/AdminAffiliatePage.tsx`,
`affiliate/AdminAffiliatePayoutsPage.tsx`, `affiliate/AdminAuditLogPage.tsx`,
`app/admin/settings/AdminSettingsForm.tsx`, `app/admin/whatsapp/WhatsAppDashboard.tsx`

**Admin pages (18):** listed in §1.1

### 3.3 The primitives module (already shadcn)

`primitives.tsx` was rewritten onto shadcn **keeping its public API**, which is why the pages that
consume it did not have to change:

`PageHeader` · `SectionCard` · `StatCard` · `StatGrid` · `StatusBadge` · `DataTable` · `DataRow` ·
`TableToolbar` · `EmptyBlock` · `ErrorBlock` · `LoadingBlock` · `InfoNote` · `AccessDeniedPanel` ·
`LinkPagination` · `PrimaryAction` · `TextLink` · `SectionHeading` · `Money` · `useToneColor`

Server/client safety: everything here is a client component called **from** server components, so no
prop is a function. `AccessDeniedPanel` and `PrimaryAction` own their own `<Link>`.

---

## 4. MANTINE USAGE (the removal target)

`@mantine/core` is the only Mantine package imported (no `@mantine/hooks`, no `@mantine/form`).

| Component | Uses | Replacement |
| --- | --- | --- |
| `Stack`, `Group`, `Box`, `SimpleGrid`, `Grid`, `Center` | 78 | Tailwind `flex`/`grid` classes (shadcn has no layout primitives) |
| `Text`, `Title` | 38 | `<p>`/`<span>`/`<h1..h3>` + Tailwind type scale |
| `TextInput`, `NumberInput` | 39 | `ui/input.tsx` `Input` + `Field` |
| `Textarea` | 15 | `ui/input.tsx` `Textarea` |
| `Select`, `MultiSelect` | 20 | `ui/select.tsx` `Select` |
| `Modal` | 20 | `ui/dialog.tsx` `Dialog` |
| `Button`, `ActionIcon`, `UnstyledButton` | 21 | `ui/button.tsx` `Button` |
| `Paper`, `Card` | 10 | `ui/card.tsx` `Card` |
| `Switch` | 10 | `ui/select.tsx` `Switch` |
| `Badge` | 4 | `ui/badge.tsx` `Badge` / `StatusBadge` |
| `Alert` | ~10 | `ui/alert.tsx` `Alert` / `InfoNote` |
| `Loader` | 5 | `LoadingBlock` / skeleton spinner |
| `Skeleton` | 5 | `ui/separator.tsx` `Skeleton` |
| `Divider` | 5 | `ui/separator.tsx` `Separator` |
| `Pagination` | 5 | `LinkPagination` |
| `Checkbox` | 2 | `ui/select.tsx` `Checkbox` + `FieldToggle` |
| `Progress` | 1 | token-driven determinate bar |
| `SegmentedControl` | 1 | shadcn Tabs / button group |
| `ScrollArea` | 1 | `ui/misc.tsx` `ScrollArea` |
| `List` | 3 | `<ul>/<li>` |
| `Image` | 4 | `next/image` / `<img>` |
| `MantineProvider`, `createTheme` | 2 | **deleted** |

**Provider footprint:** `MantineProvider` is mounted once, in `DashboardProviders.tsx`, force-light
so the un-migrated half could not half-enter dark mode. The stylesheet is imported in the three
back-office layouts so Mantine's baseline never reached a customer surface.

**Not in scope / must not change:** `components/ui/Dialog.tsx` (retail confirm dialog, mounted by
the root layout) and every `components/ticketing/**` surface — `__tests__/ticketing-ui/ui-wiring.test.ts`
asserts those import **no** design-system package at all.

---

## 5. EXISTING SHADCN COMPONENTS

`components.json` — style `new-york`, RSC, CSS variables, base `neutral`, aliases
`@/components/dashboard/ui`, utils `@/lib/utils`.

| File | Exports |
| --- | --- |
| `ui/button.tsx` | `Button`, `buttonVariants` (36/40/44px, `rounded-field`) |
| `ui/card.tsx` | `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardAction`, `CardContent`, `CardFooter` |
| `ui/badge.tsx` | `Badge` (default/secondary/outline/**success/warning/danger/info/muted**), `badgeVariants` |
| `ui/input.tsx` | `Input`, `Textarea`, `Label`, `Field` |
| `ui/select.tsx` | `Select*`, `Checkbox`, `Switch`, `RadioGroup`, `RadioGroupItem`, `FieldToggle` |
| `ui/dialog.tsx` | `Dialog`, `DialogContent`, `DialogHeader/Footer/Title/Description`, … |
| `ui/sheet.tsx` | `Sheet`, `SheetContent` (mobile drawer), … |
| `ui/dropdown-menu.tsx` | `DropdownMenu*` |
| `ui/table.tsx` | `Table`, `TableHeader/Body/Footer/Row/Head/Cell/Caption` |
| `ui/alert.tsx` | `Alert`, `AlertTitle`, `AlertDescription` (default/info/warning/danger/success) |
| `ui/separator.tsx` | `Separator`, `Skeleton` |
| `ui/sidebar.tsx` | `Sidebar`, `SidebarProvider`, `SidebarHeader/Content/Footer/Group/Menu/MenuItem/MenuButton`, `SidebarTrigger`, `SidebarCollapseToggle`, `useSidebar` |
| `ui/misc.tsx` | `Tooltip*`, `Avatar`, `AvatarFallback`, `Collapsible*`, `ScrollArea` |
| `ui/chart.tsx` | `ChartContainer`, `ChartTooltip`, `ChartTooltipContent`, `ChartLegend`, `ChartLegendContent`, `useChart` |

**Gaps to add only if a migrated page needs them:** `Tabs` (`SegmentedControl` call site),
`Progress` (`Progress` call site). Radix `tabs`/`progress` packages are **not** yet installed; the
Radix packages already present are avatar, checkbox, collapsible, dialog, dropdown-menu, label,
popover, radio-group, scroll-area, select, separator, slot, switch, tabs, tooltip, visually-hidden.

---

## 6. EXISTING CHART IMPLEMENTATION

- `recharts@3` was already a dependency; **no charting library was added**.
- `components/dashboard/ui/chart.tsx` is the shadcn chart composition over Recharts.
- A chart declares a semantic series and a **token** colour, never a hex literal:
  `{ revenue: { label: "Penjualan", color: "var(--chart-1)" } }`, rendered as
  `stroke="var(--color-revenue)"`. `ChartContainer` emits one scoped
  `[data-chart=…] { --color-revenue: var(--chart-1) }` rule per entry, so a palette change is a pure
  CSS cascade.
- Migrated: `components/admin/SalesChart.tsx`. Pinned by test to contain `ChartContainer`,
  `var(--chart-1)`, `dataKey="revenue"`, `toLocaleString("id-ID")`, and **no** `#rrggbb` literal.
- The previous module-level `CHART_COLORS` hex array must be gone from the dashboard; the test
  asserts zero consumers remain.
- **Data safety:** every chart keeps its existing API response, data keys, formatting and
  calculations. No chart is re-plotted, re-scaled or fabricated. Empty responses render an empty
  state, never zero-filled mock series.

---

## 7. FOOTER RENDERING PATH

```
app/layout.tsx ──renders <Footer /> on EVERY route
components/Footer.tsx ──emits data-global-footer
app/globals.css:166 ── body:has([data-dashboard-shell]) footer[data-global-footer] { display: none }
components/dashboard/DashboardShell.tsx ── carries data-dashboard-shell
```

Mechanism: **CSS suppression keyed on the shell marker**, not a path check. Reason recorded in
`app/globals.css`: `app/layout.tsx` cannot become path-aware without a `usePathname` client
component, and this project ships a `proxy.ts`, which the Next docs warn can hydrate mismatched.

Consequence, verified: `/admin/**`, `/organizer/**`, `/platform/**` render **no** footer; `/`,
`/products` and the retail pages keep the exact footer markup and spacing they had. The retail
footer component and its data source (`getPublicStoreSetting`) are untouched.

---

## 8. THEME IMPLEMENTATION

Three layers, all already in place.

**a. Tokens** — `app/globals.css`, shadcn architecture, mapped into Tailwind v4 via `@theme inline`:
`--background --foreground --card --card-foreground --popover --popover-foreground --primary
--primary-foreground --secondary --secondary-foreground --muted --muted-foreground --accent
--accent-foreground --destructive --border --input --ring`, the eight `--sidebar*` tokens, the five
`--chart-1..5` tokens, plus `--radius*` and the `shadow-card` / `shadow-pop` elevations. Overridden
in a `.dark` block, with `@custom-variant dark`.

**b. Switchers** — `[data-accent="…"]` (6 accents) and `[data-chart="…"]` (6 palettes), each with a
matching `.dark[…]` variant so a palette works in both appearances.

**c. Runtime** — `dashboard/theme/theme-config.ts` holds the catalogue + `THEME_STORAGE` keys
(`tk-dashboard-appearance|accent|chart`) + `THEME_BOOTSTRAP_SCRIPT`, an inline pre-paint script that
applies the stored `data-accent` / `data-chart` before the first frame (no flash). `theme-provider.tsx`
wraps `next-themes` (already a dependency — **no second theme system**) and persists the two
palettes. `theme-switcher.tsx` exposes all three controls from the topbar; `DashboardShell` mounts it.

Persistence is **localStorage only** — no schema change, which the brief requires.

---

## 9. FILES TO MIGRATE

44 files importing `@mantine/core` (18,477 lines) — enumerated in §3.2 and §1, plus:

- `package.json` — remove `@mantine/core`, `@mantine/hooks` once the count reaches zero
- `__tests__/ui-consolidation/shadcn-dashboard.test.ts` — lower `REMAINING_MANTINE_CONSUMERS` from
  45 to 0 (the ratchet can only shrink)

## 10. PROTECTED FILES

Never edited by this migration:

```
auth.ts  lib/authz/**  prisma/** (schema + migrations)  app/api/**
lib/payments/**  lib/ticketing/**  lib/whatsapp/**  lib/email/**
components/ticketing/**  components/ui/Dialog.tsx  components/Footer.tsx
app/layout.tsx  app/(customer routes)/**  checkout / cart / wallet / e-ticket
```

Also protected: all route authorization, PII, cookies and sessions. The dashboard shell must never
import `@/lib/authz` or call `auth()` — asserted by test.

## 11. MIGRATION PLAN

| Batch | Work | State |
| --- | --- | --- |
| 1 | This audit | **done** |
| 2–5 | Theme foundation: tokens, dark mode, accents, chart palettes | **done** |
| 6–8 | Shell, sidebar, topbar | **done** |
| 9 | Footer removal (CSS suppression on the shell marker) | **done** |
| 10–11 | Admin overview + shared primitives | **done** |
| — | **Remaining** | |
| 12 | Shared: `DashboardProviders` off Mantine, delete `mantine-theme.ts`, 3 layouts | **todo** |
| 13 | Organizer: 5 components + 4 pages | **todo** |
| 14 | Platform: 2 components + 2 pages | **todo** |
| 15 | Admin components: affiliate suite, uploads, order table, settings form, WhatsApp | **todo** |
| 16 | Admin pages: products, orders/[id], users, vouchers, discounts, bulk-discounts | **todo** |
| 17 | Admin pages: marketing (campaigns, promotions, flash-sales, broadcasts, shipping-discounts) | **todo** |
| 18 | Admin pages: reports, refunds, spin-wheel | **todo** |
| 19–21 | Responsive + visual consistency pass across the three sections | **todo** |
| 22 | Drop `@mantine/core`/`@mantine/hooks`; ratchet → 0 | **todo** |
| 23 | Verify: `tsc --noEmit`, jest vs baseline, eslint, HTTP probes; write the migration report | **todo** |

Per-file method (behaviour-preserving): swap the import source, replace layout primitives with
Tailwind, replace controls with the shadcn equivalents, keep every prop name that carries state
(`value`/`onChange`, form actions, endpoints, confirm wording, mutation order). `tsc --noEmit` after
each batch.

---

## Baseline (measured, for comparison after the migration)

```
npx tsc --noEmit                  → clean (exit 0)
npx jest --runInBand              → 64 suites, 1531 tests, 1529 passed, 2 failed
                                    6 failing suites, all PRE-EXISTING and unrelated:
                                      __tests__/p0/remediation.integration.test.ts        (real assert)
                                      __tests__/ticketing-payment/payment-races…          (real assert)
                                      __tests__/marketing/{profile-phone-shipping,m7-audit-fixes,
                                        campaign-optional-audit,address-shipping-ux}      (tsx scripts,
                                        not Jest suites → "must contain at least one test")
                                      __tests__/ipaymu/production-hardening.test.ts       (tsx script)
```

The 4 "must contain at least one test" suites and the ipaymu one are standalone `tsx` scripts with
their own runner, unchanged in git — they are not Jest suites. The 2 genuine failures are payment
business-logic assertions, also unchanged. Neither is touched by a UI migration.

> The 11-test delta from the brief's stated baseline (1542) is
> `__tests__/ui-consolidation/mantine-dashboard.test.ts` (45 tests), which was deleted when the shell
> was rewritten and replaced by `shadcn-dashboard.test.ts`. The replacement preserves the coverage
> that is *logic* — nav active-state, advertised-destination existence, permission narrowing, the
> frozen surfaces — and re-expresses the Mantine-specific assertions as the ratchet in §9.
