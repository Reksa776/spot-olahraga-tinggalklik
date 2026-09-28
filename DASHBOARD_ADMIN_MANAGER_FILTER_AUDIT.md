# DASHBOARD ADMIN & MANAGER — FILTER AUDIT

**Status:** AUDIT ONLY — the body below is a **HISTORICAL SNAPSHOT** of the dashboard *before* the
filter work. **§0 records the FINAL IMPLEMENTED STATE and supersedes every recommendation in this
document.** Read §0 first; where it and the body disagree, §0 is correct.
**Date:** 2026-09-28
**Scope:** every `/dashboard/**` route reachable by a `platformRole` of `ADMIN` or `MANAGER` (plus the
`ADMIN`-only system surfaces), the read models behind them, and the shared UI primitives.
**Goal (as originally written):** one consistent **dropdown/select** filtering pattern, replacing the
ad-hoc mixture of pills / repeated-`?status=` links / URL-only filters that existed then.

---

## 0. FINAL IMPLEMENTED STATE (authoritative)

### 0.1 The presentation decision was REVERSED

The dropdown direction recommended in §9–§11 was **implemented and then withdrawn**: a `<select>`
hides the choices behind a click, so an operator cannot see what can be filtered and an active filter
is not visible at a glance. The shipped pattern is a **row of visible PILL LINKS**
(`components/dashboard/filters/`) — one click, `aria-current` + brand treatment on the applied pill,
no client boundary for status filtering, and the URL as the only state. **Do not "restore" the
dropdowns.** The two native `<select>`s that remain are inside the reports GET form, where they are
required to work before hydration.

### 0.2 Final filter surface, per page

| Route | Filters as shipped | Wire format |
|---|---|---|
| `/dashboard` | `Periode` pill row (7 hari · 30 hari · 3 bulan) + `from`/`to` | `?period=7d\|30d\|3m`, `?from=&to=` |
| `/dashboard/events` | `Status` pill row + search `q` | `?status=DRAFT`, `?status=PUBLISHED&status=ONGOING` (Aktif) |
| `/dashboard/orders` | **ONE** status row: `Status pembayaran` pill row + search `q` | `?paymentStatus=PAID`, `?paymentStatus=PAID&q=andi` |
| `/dashboard/orders` | `?status=` is **honoured but has NO CONTROL** — the "Menunggu bayar" KPI deep-links it, and the bar states it in words | `?status=PENDING_PAYMENT` (forwarded, never choosable) |
| `/dashboard/payments` | `Status pembayaran` pill row + search `q` | `?status=PAID`, `?q=` |
| `/dashboard/refunds` | `Status refund` pill row + search `q` | `?status=PENDING&status=PROCESSING` (Perlu Ditangani) |
| `/dashboard/settlements` | `Status pencairan` pill row | `?status=REQUESTED&status=PENDING_APPROVAL` |
| `/dashboard/customers` | search `q` only | `?q=` |
| `/dashboard/users` | `Peran` pill row + search `search` + pagination | `?role=MANAGER\|PIC`, `?search=`, `?page=` |
| `/dashboard/venues` | search `q` | `?q=` |
| `/dashboard/settings/venues` | search `q` | `?q=` |
| `/dashboard/reports` | `Periode` pills + date inputs + `Event`/`Status pesanan` native `<select>` | `?from=&to=&period=&eventId=&status=` |
| `/dashboard/check-in`, `/dashboard/pic`, `/dashboard/settings/sports`, all detail/create/edit pages | **none — deliberately** (§0.4) | — |

**`/dashboard/orders` carries ONE status filter.** Any statement in this document that orders has
`status` + `paymentStatus` + `review` as *filters* is superseded. `review=1` no longer exists as a
page parameter or a control; the `needsReview` **read-model** predicate is retained for
reconciliation and is exercised by
`__tests__/ticketing-refunds/refund-reconciliation-visibility.integration.test.ts`.

### 0.3 Superseded sections

| Section | Says | Final |
|---|---|---|
| §3 route table, row 6 | orders has `status`, `paymentStatus`, `review` | one visible filter: `paymentStatus` (+ search); `status` is a URL-only KPI deep link |
| §3 matrix rows `orders` | 4 knobs incl. Worklist | 2 knobs: `paymentStatus`, `q` |
| §9 items 3/4/5 | dropdowns fix the widget inconsistency | a shared PILL ROW fixes it; orders no longer offers two payment-status option sets |
| §9 item 6 | five `q` read models, no search box | **every one now has a search box**, plus `venues`, `settings/venues`, `users` |
| §10.3/§10.4 | model `orders?review` as a dropdown | review is **removed from the surface**; the predicate stays in the read model |
| §11 | files to modify | see §0.5 |

The `/dashboard/pic` aggregates and `venues`/`users` read-model parameters (`q`, `role`, `search`,
`page`) were also exposed, and `listManagedUsers`' previously unreachable `pagination` envelope is now
rendered (`LinkPagination`).

### 0.4 Pages deliberately WITHOUT a filter

`/dashboard/check-in` (`listCheckInGateEvents` takes no parameters), `/dashboard/pic`
(`listPicsForAdmin` / `listOrganizerPicAssignments` take none), `/dashboard/settings/sports`
(`listSportsForAdmin` takes none), every detail page, every create/edit form, and the
settings/application, branding and maintenance forms. **No filter was invented for them** — a pill
row over a dataset with no filterable dimension would be a control that cannot change anything.

### 0.5 Files in the final implementation

`lib/metadata.ts`, `lib/dashboard/filter-options.ts`, `components/dashboard/filters/{filter-types.ts,
FilterPills.tsx,FilterBar.tsx,PeriodPills.tsx,DashboardFilterSearch.tsx}` and the eight dashboard
filter pages, `components/dashboard/ReportFilters.tsx`, `components/admin/UserManager.tsx`,
`components/organizer/VenueManager.tsx`, `components/platform/GlobalVenueManager.tsx`. Deleted:
`DashboardFilterSelect.tsx`, `PeriodSelectForm.tsx`. No predicate, parser, permission or schema change.

---

## 1. Executive summary

The dashboard has **24 page routes**. Only **8** carry any query-param filtering: `/dashboard`,
`/dashboard/events`, `/dashboard/orders`, `/dashboard/payments`, `/dashboard/customers`,
`/dashboard/refunds`, `/dashboard/settlements`, `/dashboard/reports`.

Across those 8 routes there are **21 filter knobs**. Today:

- **2** are real dropdowns (both native `<select>` inside `ReportFilters.tsx`: *Event* and *Status pesanan*).
- **33** are **pills / text links** (30 in the four list toolbars + 3 period pills on the overview).
- **4** are **date inputs** (`from`/`to`, on the overview and on reports).
- **6** filters are **URL-only** — fully parsed and forwarded to Prisma, with **no control drawn at all**
  (`orders?status`, `payments?status`, and `q` on events / orders / payments / refunds).
- **3** filters are **backend-only** — the read model supports them but the page never reads the param
  (`customers?q`, `settlements organizerId`, `settlements picProfileId`).

No surface has a search box, even though **five read models already implement `q`**. No surface uses
tabs or checkboxes as filters. The `Tabs` primitive exists but is unused.

Two hard findings shape every recommendation:

1. **The wire format is already built, tested, and shipped (uncommitted) for multi-value status:**
   `?status=PENDING&status=PROCESSING`, with parsers (`parseEventStatusFilters`,
   `parseStatuses` × 2), service support (`statuses?: T[]` → `status: { in: … }` on events, refunds,
   settlements), `LinkPagination` array support, and 25 passing tests in
   `__tests__/dashboard/kpi-navigation.test.ts`. **This must not be replaced.**
2. **`components/dashboard/ui/select.tsx` exists and is a Radix `Select`** (client-only). It is
   currently used by *mutation forms* (`SettlementPrepareForm`, `PicPayoutRequestDialog`,
   `MaintenanceSettingsForm`, and three organiser forms) — never by a filter bar. The one existing
   filter bar (`ReportFilters.tsx`) deliberately uses **native `<select>`**, and a test
   (`__tests__/dashboard/dashboard-ui-wiring.test.ts`) pins that file as **not** a client component
   with the explicit intent *"it must work before hydration"*.

Recommendation, in one line: **keep the existing wire format untouched, and add ONE shared
`components/dashboard/filters/` module whose control is the existing Radix `Select` for the list
pages and the already-proven native `<select>` for the reports form** — so every filter becomes a
labelled dropdown while no predicate, parser, or permission changes.

---

## 2. Complete route inventory

24 page routes under `app/dashboard/**` (`+ layout.tsx`, `+ error.tsx`). Access is decided
**server-side per page**; a menu row is a courtesy, never the control.

| # | Route | Read the page performs | Gate (permission) | Filters | Pagination |
|---|-------|------------------------|-------------------|---------|------------|
| 1 | `/dashboard` | `getDashboardOverview`, `getDashboardActivity(5)`, `getDashboardReport` | layout `canEnterDashboard`; charts need `report.transaction.read` | period, from/to | — |
| 2 | `/dashboard/events` | `listOrganizerEvents` | `event.read` | status(es), **`q` unwired** | ✅ `LinkPagination` |
| 3 | `/dashboard/events/new` | — | `event.write` | — | — |
| 4 | `/dashboard/events/[id]` | `getOrganizerEvent` | `event.read` | — | — |
| 5 | `/dashboard/events/[id]/check-in` | gate | `checkin.scan` | — | — |
| 6 | `/dashboard/orders` | `listDashboardOrders` | `order.read.tenant` | **SUPERSEDED — final: `paymentStatus` pill row + `q`; `status` is a URL-only KPI deep link, `review` is not a page parameter at all (see §0)** | ✅ |
| 7 | `/dashboard/orders/[orderNumber]` | `getDashboardOrder` | `order.read.tenant` | — | — |
| 8 | `/dashboard/customers` | `listDashboardCustomers` | `order.read.tenant` | **`q` not even forwarded** | ✅ |
| 9 | `/dashboard/payments` | `listDashboardPayments` | `payment.read.tenant` | **status (unwired)**, **`q` unwired** | ✅ |
| 10 | `/dashboard/refunds` | `listDashboardRefunds` | `order.read.tenant` | status(es), **`q` unwired** | ✅ |
| 11 | `/dashboard/reports` | `getDashboardReport` | `report.transaction.read` (export needs `report.export.transaction`) | from, to, period, eventId, status | — |
| 12 | `/dashboard/settlements` | `listSettlements` | `settlement.prepare` | status(es); service also accepts `organizerId`/`picProfileId` (unwired) | ✅ |
| 13 | `/dashboard/settlements/[id]` | settlement detail | `settlement.prepare` (+ `approve`/`proof.upload` for finals) | — | — |
| 14 | `/dashboard/check-in` | `listCheckInGateEvents` | `checkin.scan` | — | — |
| 15 | `/dashboard/venues` | `listVenues` | `venue.manage` | — | — |
| 16 | `/dashboard/pic` | PIC assignment / self-service | `pic.assign` or `pic.manage` | — | — |
| 17 | `/dashboard/pic/[id]` | PIC detail | as above | — | — |
| 18 | `/dashboard/users` | user admin | **`user.manage` — ADMIN ONLY** | — | — |
| 19 | `/dashboard/settings` | hub | `sport.manage` ∣ `venue.manage.global` ∣ `venue.manage` | — | — |
| 20 | `/dashboard/settings/application` | app settings | **`application.settings` — ADMIN ONLY** | — | — |
| 21 | `/dashboard/settings/branding` | branding | **`branding.manage` — ADMIN ONLY** | — | — |
| 22 | `/dashboard/settings/maintenance` | maintenance | **`maintenance.manage` — ADMIN ONLY** | — | — |
| 23 | `/dashboard/settings/sports` | `SportManager` | `sport.manage` (platform) | — | — |
| 24 | `/dashboard/settings/venues` | `GlobalVenueManager` | `venue.manage.global` (platform) | — | — |

**Notes**
- `app/dashboard/layout.tsx` already exists; all pages are `export const dynamic = "force-dynamic"`.
- "Organizer/PIC/event/venue filters" — I searched for them. **They do not exist on any page.** The
  only place an `organizerId` is taken from outside the session is
  `resolveOrganizerFilter(scope, permission, requested)`, which re-decides it and throws on refusal;
  **no dashboard page reads a tenant id from the URL today.**
- `app/dashboard/settings/venues` and `settings/sports` render page-level denials inside the shell
  (`AccessDeniedPanel`, non-`standalone`) — a MANAGER navigating directly is refused by the service.

---

## 3. Complete filter inventory

### 3.1 Actual filters found in source (21 knobs)

| Route | Filter | Query param | Accepted values | Parser / validator | Service param | Prisma predicate | Current UI | Combinable | Refresh | Pagination |
|-------|--------|-------------|-----------------|-------------------|---------------|------------------|-----------|-----------|---------|-----------|
| `/dashboard` | Period | `period` | `7d`,`30d`,`3m` | `resolveDashboardReportFilters` (lenient) | `getDashboardReport` | `createdAt` window | **3 link pills** | ✅ (with from/to) | ✅ | n/a |
| `/dashboard` | Custom range | `from`,`to` | `YYYY-MM-DD` | same | same | `createdAt gte/lte` | **2 native date inputs** | ✅ | ✅ | n/a |
| `events` | Status(es) | `status` (repeatable) | 6 enum + `Aktif` union | `parseEventStatusFilters` | `listOrganizerEvents{statuses}` | `status: { in: [...] }` | **8 pills** | ✅ | ✅ | ✅ |
| `events` | Search | `q` | any string | **none (not read)** | `listOrganizerEvents{q}` → title/eventCode/slug | `OR contains` | **NONE** | — | — | ✅ (not passed) |
| ~~`orders`~~ | ~~Order status~~ | `status` | 6 enum | `parseStatus` | `listDashboardOrders{status}` | `status` | **SUPERSEDED (§0): no control — a URL-only KPI deep link, stated in the bar's hint** | ✅ (AND) | ✅ | ✅ |
| `orders` | Payment status | `paymentStatus` | 7 enum, **all offered** | `parsePaymentStatus` (first-only) | `listDashboardOrders{paymentStatus}` | `paymentStatus` | **SUPERSEDED (§0): a pill row of all 7, the page's ONLY status filter** | ✅ (AND w/ status) | ✅ | ✅ |
| ~~`orders`~~ | ~~Worklist (`review`)~~ | ~~`review`~~ | — | — | `listDashboardOrders{needsReview}` | `OR fulfilmentBlockedAt, (PAID ∧ no tickets)` | **SUPERSEDED (§0): removed from the surface; the read-model predicate is retained for reconciliation** | — | — | — |
| `orders` | Search | `q` | any | read + forwarded | `{q}` → orderNumber/buyerName/buyerEmail | `OR contains` | **SUPERSEDED (§0): search box** | — | ✅ | ✅ |
| `payments` | Payment status | `status` | 7 enum | `parseStatus` (local) | `listDashboardPayments{status}` | `status` | **NONE** | — | ✅ | ✅ raw |
| `payments` | Search | `q` | any | **not read** | `{q}` → reference/order.no/buyer | `OR contains` | **NONE** | — | — | ✅ |
| `customers` | Search | `q` | any | **not read** | `listDashboardCustomers{q}` | `buyer.is` (`buildBuyerSearch`) | **NONE** | — | — | ✅ |
| `refunds` | Status(es) | `status` (repeatable) | 6 enum + `Perlu Ditangani` union | `parseStatuses` | `listDashboardRefunds{statuses}` | `status: { in }` | **8 pills** | ✅ | ✅ | ✅ |
| `refunds` | Search | `q` | any | **not read** | `{q}` → refundNo/orderNo/buyerName/email | `OR contains` | **NONE** | — | — | ✅ |
| `settlements` | Status(es) | `status` (repeatable) | 8 enum + `Menunggu Persetujuan` union | `parseStatuses` | `listSettlements{statuses}` | `status: { in }` | **10 pills** | ✅ | ✅ | ✅ |
| `settlements` | Tenant | `organizerId` | org id | service `resolveOrganizerFilter` | `listSettlements` | `organizerId` | **NONE** | — | — | — |
| `settlements` | PIC | `picProfileId` | pic id | `settlementListQuerySchema` (API) | `listSettlements` | `picProfileId` | **NONE** | — | — | — |
| `reports` | From | `from` | date | `resolveDashboardReportFilters` | `getDashboardReport` | window | **date input** | ✅ | ✅ | n/a |
| `reports` | To | `to` | date | same | same | window | **date input** | ✅ | ✅ | n/a |
| `reports` | Period | `period` | 3 | same | same | window shortcut | **3 link pills** | ✅ | ✅ | n/a |
| `reports` | Event | `eventId` | org event id | same | `filters.eventId` | `eventId` | **native `<select>`** | ✅ | ✅ | n/a |
| `reports` | Order status | `status` | 6 enum | same (`DASHBOARD_REPORT_ORDER_STATUSES`) | `filters.orderStatus` | `status` | **native `<select>`** | ✅ | ✅ | n/a |

Pagination (`?page=`) exists on the 7 list pages via `LinkPagination` and is not counted as a filter.

### 3.2 Filters the backend **already** supports but no UI exposes

| Route | Backend capability | UI | Classification |
|-------|--------------------|----|----------------|
| ~~`events`~~ | `q` (title / eventCode / slug) | **SUPERSEDED (§0): search box** | **L → resolved** |
| ~~`orders`~~ | `status` (6 enums) | **SUPERSEDED (§0): honoured, no control (KPI deep link)** | **L → intentional** |
| ~~`orders`~~ | `q` (orderNumber / buyerName / buyerEmail) | **SUPERSEDED (§0): search box** | **L → resolved** |
| ~~`payments`~~ | `status` (7 enums) | **SUPERSEDED (§0): pill row** | **L → resolved** |
| ~~`payments`~~ | `q` (reference / order no / buyer) | **SUPERSEDED (§0): search box** | **L → resolved** |
| ~~`refunds`~~ | `q` (refundNo / orderNo / buyer) | **SUPERSEDED (§0): search box** | **L → resolved** |
| ~~`customers`~~ | `q` (buyer name/email/phone) | **SUPERSEDED (§0): search box, forwarded** | **M → resolved** |
| `settlements` | `organizerId` | none — **stays none**: a client-supplied tenant id must never be honoured | **M → intentional** |
| `settlements` | `picProfileId` | none — **stays none** (no page-level use case; the API query schema still accepts it) | **M → intentional** |
| ~~`venues`~~ | `q` (name) | **SUPERSEDED (§0): search box** | **L → resolved** |
| ~~`settings/venues`~~ | `q` (name) | **SUPERSEDED (§0): search box** | **L → resolved** |
| ~~`users`~~ | `role`, `search`, `page` | **SUPERSEDED (§0): pill row + search box + `LinkPagination`** | **M → resolved** |

This was the single largest source of inconsistency: **every read model that implements search now has
a search box**, and the two remaining unintentional gaps (`settlements organizerId`/`picProfileId`) are
kept as gaps on purpose — neither is a filter an operator should be able to set from a URL.

---

## 4. Current UI pattern inventory (classification A–M)

> **SUPERSEDED (see §0).** The counts below describe the dashboard BEFORE the work. In the final
> implementation pattern **B (link pills)** is the standard for status filtering, pattern **H (text
> search)** went from 0 UI to 8 pages, and pattern **L (URL-only)** is down to the single intentional
> case (`orders?status`, the "Menunggu bayar" KPI deep link).

| Code | Pattern | Count | Locations |
|------|---------|-------|-----------|
| **A** | Dropdown / Select (as filter) | **2** | `components/dashboard/ReportFilters.tsx` — `eventId`, `status` (native `<select>`) |
| **B** | Link pills | **33** | events toolbar **8**, orders toolbar **4**, refunds toolbar **8**, settlements toolbar **10**, overview period **3** |
| **C** | Tabs used as filters | **0** | `ui/tabs.tsx` exists; **no consumer anywhere** |
| **D** | Repeated `?status=…` | **4 emit, 3 read** | emit: events/refunds/settlements `hrefFor()` + overview KPI; read: events/refunds/settlements (+ `LinkPagination` arrays) |
| **E** | Single `?status=VALUE` | **6** | events, orders, payments, reports, refunds, settlements |
| **F** | Checkbox as filter | **0** | — |
| **G** | Toggle / Switch | **1** | `MaintenanceSettingsForm.tsx` — a **settings** toggle, not a list filter |
| **H** | Text search | **0 UI / 5 backend** | `q` on events, orders, payments, customers, refunds |
| **I** | Date input | **4** | overview `from`/`to`, reports `from`/`to` |
| **J** | Period selector | **2, both pills** | overview (3), reports (3) — neither is a `<select>` |
| **K** | Filter inside toolbar/header | **5** | `TableToolbar` wraps all five filter surfaces (events, orders, refunds, settlements, reports) |
| **L** | URL-only filter, no UI | **6** | `orders.status`, `payments.status`, `q`× 4 (events/orders/payments/refunds) |
| **M** | Backend filter, no frontend control | **3** | `customers.q`, `settlements.organizerId`, `settlements.picProfileId` |

**Where the dropdown pattern already wins:** `ReportFilters.tsx` (2 selects) and the 6 **mutation forms**
that use Radix `Select` (`SettlementPrepareForm`, `PicPayoutRequestDialog`, `MaintenanceSettingsForm`,
`EventForm`, `TicketTypeManager`, `PicAssignmentManager`). Those are not filters, but they establish
the dropdown look-and-feel the dashboard already speaks.

**The four list toolbars are near-duplicates of each other.** Events, refunds and settlements each
render `Semua` + a named union + every enum member as a `TextLink`; orders renders two independent
pill rows. Three of the four re-implement the same active-state trick (`"• Semua"` vs `"Semua"`) inline.

---

## 5. Backend / query architecture

The pipeline is uniform and worth preserving exactly:

```
page (server component, force-dynamic)
  → `const params = await searchParams`        (Next 16: Promise-based; repeated param = string[])
  → local/nearby parser                       (validates against the enum, DROPS the unknown value)
  → scoped service                            (lib/dashboard/*, lib/events/service.ts,
                                               lib/ticketing/settlement/service.ts#listSettlements)
  → resolveOrganizerFilter(scope, PERMISSION, requested?)
  → Prisma `where`  (organizerId: { in: organizerIds } ALWAYS first)
```

Verified properties:

- **Tenant scope is applied first and is never widened by a filter.** Every list calls
  `resolveOrganizerFilter(scope, permission, requested)`; with no `requested` it returns
  `organizerIdsWith(...)`; with a `requested` it re-decides and **throws `AppError`** on refusal.
  An empty set short-circuits to an empty page — never an unscoped query.
- **Invalid values are dropped, not forwarded.** `parseEventStatusFilters`, `parseStatuses` × 2,
  `parseStatus`, `parsePaymentStatus` all narrow against the enum before Prisma sees anything.
- **`status` and `paymentStatus` are AND-ed, not merged.** `listDashboardOrders` builds
  `where = { organizerId, ...(status), ...(paymentStatus), ...(AND: [q, needsReview]) }` — sibling
  keys, so one narrows the other. The two `OR` groups are pushed into `AND[]` deliberately, because
  two sibling `OR` keys would have one silently override the other. **This is correct today.**
- **`review=1` deliberately nullifies `status`** (`status: needsReview ? null : status`). Documented as
  a product decision (a worklist that must show the whole queue).
- **`orders` forwards the validated status into `LinkPagination`; `payments` forwards the RAW one**
  (`query={{ status: params.status, q: params.q }}`). Harmless (the page re-parses) but inconsistent.
- **Reports use ONE parser in two modes**: the page is *lenient* (bad input → default window + a
  visible notice), the export endpoint is *strict* (`strict: true` → 400). The download link carries
  the **resolved day keys**, not the period shortcut, so a file cannot cover a different window than
  the screen.

**Nothing found that is visual-only or client-only.** No filter is filtered in the browser; no filter
is dropped on pagination or search (verified: all three multi-status pages hand their array to
`LinkPagination`, which appends repeated params).

---

## 6. Admin vs Manager access

Authority is a **permission map**, never a role string. The only difference between a platform `ADMIN`
and a platform `MANAGER` is the **platform** map:

| Capability | ADMIN | MANAGER |
|------------|:-----:|:-------:|
| `sport.manage`, `venue.manage.global`, `pic.manage` | ✅ | ❌ |
| `user.manage`, `role.manage`, `platform.config` | ✅ | ❌ |
| `application.settings`, `maintenance.manage`, `branding.manage` | ✅ | ❌ |
| `audit_log.read` | ✅ | ✅ |

Six destinations are therefore **ADMIN-only**: `/dashboard/users`,
`/dashboard/settings/application`, `/settings/branding`, `/settings/maintenance`,
`/settings/sports`, `/settings/venues`. **None of them has a filter**, so the dropdown work never
touches the ADMIN/MANAGER separation.

Inside a tenant, capability is resolved from the **membership** role
(`OWNER`, `MANAGER`, `FINANCE`, `PIC`, `CHECKIN_STAFF`), *and* `ADMIN`/`MANAGER` platform roles also
hold tenant permissions from `PLATFORM_ROLE_ORGANIZER_PERMISSIONS` (**only for organizers they are an
ACTIVE member of** — `resolveAuthzScope` reads memberships and there is no implicit bridge). So:

- A platform ADMIN **with no membership** has `hasTenantAccess === false` and realises **no tenant
  filter at all** — the tenant list pages render an honest empty state.
- A platform ADMIN and a platform MANAGER who are members with the **same membership role** see
  **byte-identical filters**, because the filter set is derived from `canReadEvents` /
  `canReadOrders` / `canReadPayments` / `canManageSettlements` / `canReadReports` — all tenant
  permissions held equally by both.

**Consequence for this work:** every filter must be gated by the *permission that owns the data*
(`canReadPayments` for the payments filter, `canManageSettlements` for the settlements filter, …),
never by `platformRole`. No new permission, no role check, no client-supplied tenant id.

---

## 7. Tenant isolation verification

| Check | Result |
|-------|--------|
| Does any filter read `organizerId` from the URL as authority? | **No.** No dashboard page reads a tenant id from `searchParams`. |
| Is a requested tenant re-decided? | **Yes** — `resolveOrganizerFilter` throws `AppError(decision.code)` (404 for `ORGANIZER_ACCESS_DENIED`) instead of widening. |
| Can a filter widen the scope? | **No.** `organizerId: { in: organizerIds }` is always the first `where` key and is AND-ed with every filter. |
| Does an empty readable set fall back to "all"? | **No.** Every list returns `{ items: [] }` early. |
| Do the new status filters narrow or widen? | **Narrow.** `status: { in: [...] }` on an already-scoped `where`. |
| Are the filter parsers enum-narrowing? | **Yes**, all four. An unknown string can never reach Prisma (where it would raise on the enum). |
| Does the reports `eventId` filter leak? | **No** — `buildDashboardReportScopeWhere` puts `eventId` *inside* the `organizerId: { in }` scope. |
| Is there a URL-only filter that bypasses the page's enum validation? | **No** — but `payments`' pager re-emits the raw value (cosmetic only). |

**Verified by existing tests:** `__tests__/dashboard/kpi-navigation.test.ts`
("keeps every destination on its existing scoped decider", "never reads an `organizerId` from the URL
as an authority source"), `__tests__/authz/role-matrix.integration.test.ts`,
`__tests__/auth-flow/dashboard-access.integration.test.ts`.

---

## 8. DataTable / filter interaction

Context: a React *"Each child in a list should have a unique key"* warning was traced to `DataTable`
rendering caller-supplied slots; the fix (`keyedSlot()` in `components/dashboard/primitives.tsx`) wraps
every `Children.toArray` member in its own keyed `Fragment`, and explicit keys
(`viewport` / `caption` / `head` / `body` / `footer`) were added to the component's own siblings.

Audit of the filter↔table seam:

- **Filters are siblings of `DataTable`, never children.** Every toolbar is a `TableToolbar`
  *above* `<DataTable>`. Adding/changing a filter therefore **cannot** introduce an unkeyed array
  inside `DataTable`.
- **The `empty` node changes with the filter** (`statuses.length === 0 ? … : isActiveUnion ? … : …`) —
  those branches already return **single** elements, and `keyedSlot` now covers the array case anyway.
- **The real new risk is inside the filter controls**, not the table: a Radix `SelectItem` list or a
  `<option>` list must be keyed. Rule for implementation: **`key={option.value}` on every
  `SelectItem`/`<option>`**, and never pass a bare array as a slot.
- **`footer` = `LinkPagination`** already handles arrays (`query={{ status: statuses }}` → repeated
  params) and is a single element, so it stays key-safe. Any new "active filters" chips row added to
  the footer must be `key`ed by param+value.
- **`rows` keys** are domain ids everywhere (`event.id`, `order.id`, `String(refund.id)`,
  `settlement.id`, `customer.userId`, `entry.status`) — unchanged by this work.
- `__tests__/ui-consolidation/dashboard-table-keys.test.ts` (extended, +6 array-slot regression tests)
  and `__tests__/dashboard/kpi-navigation.test.ts` already pin the behaviour; the filter work must keep
  both green.

---

## 9. Inconsistent filter patterns (the actual defect list)

| # | Inconsistency | Where | Why it's a problem |
|---|---------------|-------|--------------------|
| 1 | Four toolbar rows are hand-rolled pills, three of them near-identical copies | events, orders, refunds, settlements | 30 duplicated `TextLink`s; the active-state marker (`"• X"`) is re-implemented per page |
| 2 | Period is **pills** on two pages, and one of them has no `<select>` at all | `/dashboard`, `reports` | the same "window" concept has two different controls |
| 3 | **The same `?status=` param renders as pills on 4 pages and as a `<select>` on a 5th** | events/orders/payments/refunds/settlements vs reports | the strongest inconsistency; identical param, two widgets |
| 4 | Two payment-status filters with different option sets | `orders?paymentStatus` offers only *lunas*; `reports?status` offers 6; `payments?status` offers **none** | the definition of "payment filter" is unclear to an operator |
| 5 | `orders?review` silently nullifies `orders?status` | orders | a user combining filters gets one ignored with no visual cue |
| 6 | 5 read models implement `q`, 0 pages render a search box | events/orders/payments/customers/refunds | shipped capability invisible to every operator |
| 7 | 3 filters are reachable only by hand-editing the URL | see §3.2 | not discoverable, effectively dead code |
| 8 | The active/filtered state is expressed as a bullet character inside the link text | 4 toolbars | not accessible (no `aria-current`, no `aria-pressed`), and only partially announced |
| 9 | Toolbars carry no label and no "Reset" | 4 toolbars | unlike `ReportFilters`, which has `Label`s + `Reset` |
| 10 | `payments` re-emits the **raw** filter into the pager; `orders` re-emits the **validated** one | payments vs orders | diverging convention in the same folder |
| 11 | A filter change resets nothing explicitly: pills rebuild the querystring by hand on each page | 4 pages | 3 different `hrefFor` implementations, each with its own merge rules |
| 12 | `settlements` exposes 2 backend filters (`organizerId`, `picProfileId`) that no page reads | settlements | the API list has more filtering than the surface |

---

## 10. Recommended unified dropdown architecture

### 10.1 The two coupled decisions (decided from architecture, not preference)

**Decision 1 — the multi-status wire format stays `?status=A&status=B` (multi-value).**
Not a new `?queue=` param. Reasons:
1. it is **already implemented end-to-end** in this working tree — parsers, service params
   (`statuses?: T[]`), `status: { in: … }`, `LinkPagination` array support — and pinned by
   **25 passing tests**;
2. the union constants already exist as the single source of truth
   (`EVENT_ACTIVE_STATUSES`, `REFUND_NEEDS_HANDLING_STATUSES`, `SETTLEMENT_AWAITING_APPROVAL_STATUSES`),
   each documented as "the same union the KPI counts";
3. `?queue=` would introduce a **second vocabulary** for the same predicate, a second parser, a
   mapping module, and a second test surface — precisely the inconsistency this audit removes;
4. the KPI tiles already deep-link with the repeated form; `?queue=` would fork the wire format so the
   same destination means two different URLs;
5. `LinkPagination` already preserves arrays; a new param would need new preservation logic.

**The named union becomes a dropdown OPTION (a label), not a wire format.** `Aktif`,
`Perlu Ditangani`, `Menunggu Persetujuan` are option labels whose selection emits the repeated params
the backend already understands.

**Decision 2 — the control: reuse `components/dashboard/ui/select.tsx` (Radix) for the list pages;
keep native `<select>` for the reports form.**
Reasons:
1. A single-select native control **cannot** emit a repeated param, and Decision 1 forbids changing the
   wire format — so the list control needs JS regardless. Given that, the **existing** Radix primitive
   (which the brief prioritises, and which the dashboard's 6 mutation forms already use) is the right
   choice, and **no duplicate Select is created**;
2. The reports bar is a *single-valued* form (event, status, dates) with an explicit **Terapkan**
   action, and its test pins `components/dashboard/ReportFilters.tsx` as **not** a client component,
   documented as *"a filter that depends on hydration is a filter that silently reports the WRONG
   window"*. For a financial report that property is load-bearing, so its **mechanism** stays and only
   its **period pills become a `<select name="period">`**;
3. Both surfaces share the **same visual geometry**, taken from `SelectTrigger`
   (`h-10 rounded-field border border-input bg-card px-3 text-sm`) via one exported
   `FILTER_SELECT_CLASS`, so the pattern reads identically everywhere without a second implementation.

> If the user prefers a single mechanism on reports too, the switch cost is one test rewrite —
> see §14, Risk R1.

### 10.2 Target UI

```
Filter
[ Semua status ▼ ] [ Semua pembayaran ▼ ] [ Semua event ▼ ] [ Periode ▼ ]   Reset filter
```

- The URL stays the **source of truth**; the control's value is rendered from the server-resolved
  filter (so first paint is always correct, and refresh / Back / Forward / share all work).
- Every field renders a `Label`, a `Select` with a `SelectValue` placeholder, and an option list whose
  first entry is `Semua …`.
- Options are validated **server-side** (the existing parsers, unchanged); an unknown value is dropped
  per the existing convention.
- A field is only rendered when the operator holds the permission that owns its data.

### 10.3 Filter rules (per field)

| Rule | How it is satisfied |
|------|---------------------|
| Clear label | `<Label htmlFor>` + `SelectTrigger` (`aria-labelledby`) |
| "Semua …" option | option #1, value `all`, mapped to *omit the param* |
| Selected value visible | `SelectValue` renders the matched option label (a union option reads *"Perlu Ditangani"*) |
| URL is source of truth | `router.push(basePath + mergedQuery)`; the server re-renders from `searchParams` |
| Server-side validated | existing parsers, untouched |
| Invalid value | dropped (`parse*`), and the page's current "notice" convention is reused where one exists |
| Never widens tenant scope | the control only emits enum values / union tokens; `resolveOrganizerFilter` remains the only scope source |
| Refresh preserves | the value is in the URL |
| Back/Forward work | real `push` navigations |
| Pagination preserves | `LinkPagination`'s existing `query` object (arrays already supported) |
| Search preserves | the search field merges into the same query object |
| Filters AND | the backend already AND-s (`status` + `paymentStatus` siblings); a new field must add a sibling key or an `AND[]` push, never replace |
| Business semantics untouched | no predicate changes; union constants are the only source of multi-status definitions |

### 10.4 ~~The one field that needs care: `orders?review`~~ — SUPERSEDED, DO NOT IMPLEMENT

> **FINAL DECISION (§0):** the orders page exposes **one** status filter (`paymentStatus`) plus search.
> `review` is **not** a control, **not** a page parameter and **not** a link any more; the
> `needsReview` predicate stays in `lib/dashboard/orders.ts` for the reconciliation read path and is
> exercised by `__tests__/ticketing-refunds/refund-reconciliation-visibility.integration.test.ts`.
> The recommendation below was NOT implemented.

`review=1` is **not** a status — it is a worklist overlay whose backend deliberately clears `status`.
Model it as its own labelled dropdown (`Tampilan: Semua / Perlu tindakan`) and, when it is active,
**omit the status dropdown** (mirroring the backend), or keep it rendered but disabled with a hint.
Do **not** "fix" this by AND-ing `status` with `review` — that would change a documented product
decision.

### 10.5 Label accuracy (semantic check)

The labels must keep the predicates they already have. Explicitly **do not** change:

| Label | Correct predicate | Note |
|-------|-------------------|------|
| *Tiket terjual* → destination | `orders?paymentStatus=PAID` | ⚠️ the KPI counts `Ticket.status ∈ {ISSUED, CHECKED_IN}`; the destination lists **orders** by `paymentStatus`. It is an orders-level proxy for a ticket-level count. **Keep as-is**, but see Risk R4 — the label is the only thing bridging the two. |
| *Event aktif* | `status ∈ {PUBLISHED, ONGOING}` | `EVENT_ACTIVE_STATUSES` |
| *Refund perlu ditangani* | `status ∈ {PENDING, PROCESSING}` | `REFUND_NEEDS_HANDLING_STATUSES` |
| *Pencairan menunggu* | `status ∈ {REQUESTED, PENDING_APPROVAL}` | `SETTLEMENT_AWAITING_APPROVAL_STATUSES` |
| *Menunggu bayar* | `orders?status=PENDING_PAYMENT` | order status, **not** `paymentStatus` |
| *Lunas* | `paymentStatus = PAID` | never `status = PAID` |
| *Pembayaran lunas* (orders filter) | `paymentStatus = PAID` | the gateway column |

---

## 11. Exact files proposed for implementation

> **SUPERSEDED (see §0.5 for what was actually built).** The proposal below is the *dropdown* design
> that was withdrawn. The shipped module is the pill row; there is no `DashboardFilterSelect` and no
> `DashboardFilterForm`.

### 11.1 ~~NEW — shared filter module (dropdown design, NOT shipped)~~

| File | Kind | Responsibility |
|------|------|----------------|
| `components/dashboard/filters/filter-types.ts` | pure TS | `FilterOption` (`{ value, label, params }`), `FilterField`, `mergeFilterQuery()`, `resolveFilterSelection()`, `omitEmpty()` — **no React**, unit-testable |
| ~~`components/dashboard/filters/DashboardFilterBar.tsx`~~ | — | **replaced by `FilterBar.tsx`** (server component) |
| ~~`components/dashboard/filters/DashboardFilterSelect.tsx`~~ | — | **deleted** — the pill row needs no client boundary for status filtering |
| `components/dashboard/filters/DashboardFilterSearch.tsx` | `"use client"` | the `q` input (explicit submit) merged into the same query; activates the already-implemented searches |
| ~~`components/dashboard/filters/DashboardFilterForm.tsx`~~ | — | **not needed** — the reports GET form kept its existing native selects |

### 11.2 MODIFY — pages (UI only; searchParams contract unchanged)

| File | Change |
|------|--------|
| `app/dashboard/events/page.tsx` | pills → the shared **pill** bar (+ *Aktif* union); add `q` field; forward `q` to the service + pager |
| `app/dashboard/orders/page.tsx` | **SUPERSEDED — final:** ONE status row (`paymentStatus`, all 7) + `q`; the order-status row and the `Tampilan`/review row are REMOVED; a validated `?status=` is still forwarded for the KPI deep link and stated in the bar's hint; `review` is not read at all |
| `app/dashboard/payments/page.tsx` | add Status dropdown (7 enums) + `q`; pass the **validated** status to the pager |
| `app/dashboard/customers/page.tsx` | add `q` search field; **forward `q`** to `listDashboardCustomers` (currently dropped) |
| `app/dashboard/refunds/page.tsx` | pills → Status dropdown (incl. *Perlu Ditangani*, union emitted as repeated params) + `q` |
| `app/dashboard/settlements/page.tsx` | pills → Status dropdown (incl. *Menunggu Persetujuan*); optional Organizer/PIC dropdowns if wanted (service already supports them) |
| `app/dashboard/reports/page.tsx` | pass a `period` field to the bar; no predicate change |
| `components/dashboard/ReportFilters.tsx` | **period pills → `<select name="period">`**; keep `method="get"`, the native selects, the download `<a>`s and **no `"use client"`** |
| `app/dashboard/page.tsx` | overview period pills → the same dropdown (reuse the shared field) |
| `components/dashboard/primitives.tsx` | *only if needed*: a `TableToolbar` prop for a label row. **No change to `DataTable`, `LinkPagination` or `keyedSlot`.** |

### 11.3 NEW / MODIFY — tests

| File | Change |
|------|--------|
| `__tests__/dashboard/filter-options.test.ts` | NEW — pure: option→param merge, union options emit repeated params, `Semua` omits the param, unknown values dropped, permission gating of fields, `page` reset on filter change, arrays preserved |
| `__tests__/dashboard/filter-bar-wiring.test.ts` | NEW — source-level: every list page renders the bar, every field is permission-gated, `key={option.value}` present, no `<script>`, no colour literals (satisfies `P-S9`), no `@mantine` |
| `__tests__/dashboard/kpi-navigation.test.ts` | extend only (the 25 existing assertions must stay green) |
| `__tests__/dashboard/dashboard-ui-wiring.test.ts` | extend for the reports period `<select>`; the `not.toContain('"use client"')` assertion on `ReportFilters.tsx` **stays** |
| `__tests__/ui-consolidation/dashboard-table-keys.test.ts` | extend: option lists + an "active filters" chips row are key-safe |

**No test is modified on the audit step.**

---

## 12. Files explicitly protected (DO NOT TOUCH)

| Area | Files |
|------|-------|
| Schema / migrations | `prisma/schema.prisma`, `prisma/migrations/**` |
| Payment state machine | `lib/ticketing/payment/**` (incl. `webhook.ts`, `settlement.ts`) |
| Refund lifecycle | `lib/ticketing/refunds/**` |
| Settlement **money engine** | `lib/ticketing/settlement/service.ts` — **read-only exception:** `listSettlements` + `SettlementListParams` may be *read*; `prepareSettlement` / `approveSettlement` / `markPaid` / `failSettlement` / `rejectSettlement` must not change |
| Authz model | `lib/authz/permissions.ts`, `lib/authz/guards.ts`, `lib/authz/scope.ts` (**no new permission, no role check**) |
| Financial calculation | `lib/dashboard/reports.ts` where-builders, `lib/dashboard/export.ts`, `lib/xlsx.ts`, `lib/csv.ts` |
| Ticket issuance | `lib/ticketing/issuance/**` |
| Branding / auth | `lib/app-settings.ts`, `lib/branding/**`, `app/layout.tsx`, `components/dashboard/theme/**` |
| Tenant isolation | `lib/dashboard/scope.ts`, `lib/events/service.ts#readableOrganizerIds` |
| DataTable internals | `components/dashboard/primitives.tsx` — `DataTable`, `keyedSlot`, `LinkPagination` (**no behavioural change**) |

**SAFE TO MODIFY (UI only):** the 8 filter pages' JSX + their local parsers' *presentation*,
`components/dashboard/ReportFilters.tsx`, the overview's period control, and the new
`components/dashboard/filters/**`.

---

## 13. Test coverage — what exists, what is missing

### Existing (relevant)

| File | Covers |
|------|--------|
| `__tests__/dashboard/kpi-navigation.test.ts` (25) | KPI→URL contracts; union constants exact; `parseEventStatusFilters` normalisation; `status IN (…)`; payment-status validation + AND; `LinkPagination` repeated params; "no `organizerId` from the URL" |
| `__tests__/events/status-presentation.test.ts` | event status tone + filter vocabulary |
| `__tests__/dashboard/reporting.integration.test.ts` | `resolveDashboardReportFilters` lenient vs strict, clamping, granularity, where-builders |
| `__tests__/dashboard/dashboard-ui-wiring.test.ts` | reports filter bar is a **server** GET form with **native** selects; no `useState`; no `"use client"` |
| `__tests__/ui-consolidation/dashboard-table-keys.test.ts` | `DataTable` array-slot key safety |
| `__tests__/authz/role-matrix.integration.test.ts` | ADMIN vs MANAGER platform capabilities |
| `__tests__/auth-flow/dashboard-access.integration.test.ts`, `phase34/36/38/40-*.test.ts` | dashboard entry vs data access, MANAGER operational parity |
| `__tests__/admin-manager/*` | ADMIN-only surfaces (application/maintenance/branding/users) |
| `__tests__/ui-consolidation/shadcn-dashboard.test.ts` | the menu only advertises real pages; authority from capabilities; **no colour literals in any dashboard file** (`P-S9`); no `<script>` in a dashboard file; no `@mantine` |

### Missing (to add with the implementation)

1. `mergeFilterQuery()` — union option → repeated params; `Semua` omits; `page` reset; other filters and `q` preserved.
2. Field-level **permission gating** (a payments field must not render without `payment.read.tenant`).
3. **Search** wiring for all 5 `q` filters (including that `customers` finally forwards it).
4. The reports **period `<select>`** (and that `ReportFilters.tsx` is still not a client component).
5. Key safety of the new option lists / chips row.
6. A static assertion that **no filter page reads a tenant id from `searchParams`** (extend the existing one).
7. Union semantics pinned per page (already partly done — must not regress).

---

## 14. Risks

| # | Risk | Severity | Mitigation |
|---|------|:--------:|------------|
| **R1** | The reports bar keeps a different **mechanism** (server GET form) from the list bars, which could read as "still inconsistent" | Med | Documented and intentional: the brief's "consistent dropdown" is satisfied (a `<select>` everywhere), the *mechanism* differs only where a test-pinned no-hydration property is load-bearing. Switch cost if overruled: rewrite 3 assertions in `dashboard-ui-wiring.test.ts` |
| **R2** | A client filter bar adds a hydration boundary to 7 server pages | Low | Props are fully serializable; the server still resolves the current value, so **first paint is correct without JS**; the existing `LinkPagination` remains the pagination path |
| **R3** | Repeated-param emission from a single-select control could be got wrong (e.g. comma-joining) | Med | The union option carries an explicit `params` object (`{ status: ["PENDING","PROCESSING"] }`); a pure unit test pins the exact query string. **Never** invent `?status=A,B` |
| **R4** | *Tiket terjual* is a ticket-level count whose destination is an orders-level filter (`paymentStatus=PAID`) | Med (pre-existing) | Do **not** change the predicate. Keep the label; add a hint on the destination's payment field only if the user wants it. Flag as a separate decision |
| **R5** | `Review` dropdown accidentally AND-ed with status | Med | Keep `status: needsReview ? null : status`; assert in a test |
| **R6** | Adding a dropdown to *every* page could expose a filter to an actor who cannot read the data | High | Gate each field by its owning permission (`canReadPayments`, `canManageSettlements`, …) and test it. The control is a courtesy — the service remains the control |
| **R7** | Colour literals in the new files break `P-S9` | Low | Use tokens only (`border-input`, `bg-card`, `text-foreground`); the existing `SELECT_CLASS` is already compliant |
| **R8** | New option lists introduce unkeyed arrays → key warning returns | Low | `key={option.value}` on every item; extend the table-keys suite |
| **R9** | Reports period pills → `<select>` changes URL persistence | Low | Keep `name="period"` in the same GET form; a shared-URL test asserts the round-trip |
| **R10** | Scope creep into the settlement money engine | High | `listSettlements` read-only exception; explicit protected-files list (§12) |

---

## 15. Implementation batches

Design principle for every batch: **the URL contract and the predicates do not change.** Only the
widget changes.

### BATCH 1 — Shared dropdown/filter primitive
`components/dashboard/filters/filter-types.ts`, `DashboardFilterBar.tsx`,
`DashboardFilterSelect.tsx`, `DashboardFilterSearch.tsx`.
Deliverable: the row `[ Semua … ▼ ] …` + Reset, Radix `Select`, permission-gated fields, repeated-param
emission, `page` reset, keys everywhere. Tests: `__tests__/dashboard/filter-options.test.ts` +
`filter-bar-wiring.test.ts`.

### BATCH 2 — Events
Pills (8) → one Status dropdown incl. *Aktif*; add the `q` search; forward `q` to the service and the
pager. **No predicate change** (`status: { in: statuses }`).

### BATCH 3 — Orders
**SUPERSEDED — as shipped:** ONE status row — **Payment status** (all 7 options) — plus `q`.
The **Order status** row and the **Tampilan** (review) row are removed, and `review=1` is gone from the
surface; the read model keeps `needsReview` for reconciliation. A validated `?status=` is still
forwarded (the "Menunggu bayar" KPI deep-links it) and is stated in the bar's hint rather than offered
as a control. `status`∧`paymentStatus` remain sibling `where` keys.

### BATCH 4 — Payments
Add the **Status** dropdown (7 enums) + `q`; pass the **validated** value to the pager. This batch
activates the reconciliation worklist the read model already describes.

### BATCH 5 — Refunds
Pills (8) → Status dropdown incl. *Perlu Ditangani*; add `q`.

### BATCH 6 — Settlements / Pencairan
Pills (10) → Status dropdown incl. *Menunggu Persetujuan*; optional Organizer/PIC dropdowns
(service already accepts them) **only if the user wants them** — flag as a separate decision.

### BATCH 7 — Reports
Period pills → `<select name="period">` inside the existing **server** GET form; keep native
`eventId`/`status` selects, date inputs, download `<a>`s and the absence of `"use client"`.
Optionally align the field layout with the shared bar's geometry.

### BATCH 8 — Customers / PIC / Venues / other pages
`customers`: add `q` and **forward it**. Verify PIC / venues / check-in / settings have nothing to
convert (they do not, per §2) and record that as a negative result.

### BATCH 9 — Cross-dashboard consistency
Overview period pills → the same control; one shared `TableToolbar` label row; retire the three
hand-rolled `hrefFor` merge helpers in favour of `mergeFilterQuery`; make the pager re-emit
**validated** values everywhere.

### BATCH 10 — Regression + DataTable key verification
`npx tsc --noEmit`, full Jest, `npm run lint`, `npm run build`; re-run
`__tests__/ui-consolidation/dashboard-table-keys.test.ts` and `P-S9`; manual QA sweep (§16).
No source change in this batch beyond fixes the above surface.

Batches 2–6 repeat one shape and can be reviewed independently. Batch 7 is deliberately last among
the pages because it is the only one whose mechanism differs.

---

## 16. Manual QA checklist

**Per converted page**
- [ ] First paint with a shared URL (`?status=…`) shows the correct option already selected.
- [ ] Selecting `Semua …` removes the param (URL has no `status=` left over).
- [ ] A union option (`Aktif` / `Perlu Ditangani` / `Menunggu Persetujuan`) produces **repeated** params, and the URL visibly contains both.
- [ ] Changing a filter resets `page` to 1.
- [ ] Refresh keeps every filter.
- [ ] Browser Back / Forward restores the previous filter state.
- [ ] Pagination preserves every filter (the `page=2` link still carries them).
- [ ] Typing in the search box preserves the selected status, and vice versa.
- [ ] Combining two filters **narrows** the result set (AND), never widens it.
- [ ] An unknown value typed by hand (`?status=BOGUS`) renders the default list, not an error.
- [ ] A user **without** the owning permission sees no field for that filter.
- [ ] Console shows **no** `"Each child in a list should have a unique key"` warning, on any filter
      change, pagination, empty state, or footer render.
- [ ] Filtering to an empty result renders the page's existing empty state (not a crash, not "no data"
      masking an error).

**Cross-cutting**
- [ ] A MANAGER who is a member sees exactly the filters an ADMIN member sees; a MANAGER with no
      membership sees honest empty states and no tenant filters.
- [ ] The ADMIN-only surfaces (`users`, `settings/application|branding|maintenance`, `settings/sports`,
      `settings/venues`) are unchanged and still unfiltered.
- [ ] Reports numbers do not move for a given URL (the parser was not changed).
- [ ] The CSV/Excel download for the on-screen filters still matches the screen.

---

## FINAL OUTPUT

```
AUDIT COMPLETE
```

**Git status:** EXISTING CHANGES (uncommitted work from the two previous tasks — 15 modified files,
1 staged rename `app/favicon.ico → public/favicon.ico`, 3 untracked files:
`__tests__/dashboard/kpi-navigation.test.ts`, `__tests__/admin-manager/branding-favicon.test.ts`,
`lib/branding/metadata.ts`). Nothing was committed, pushed, reset, cleaned, or installed.

**Files modified by THIS AUDIT:** `DASHBOARD_ADMIN_MANAGER_FILTER_AUDIT.md` (new, this report) —
**no source file, no test, no schema, no migration.**

| Metric | Value |
|--------|-------|
| Dashboard routes audited | **24 page routes** (+ `layout.tsx`, `error.tsx`) |
| Routes with any filtering | **8** |
| Total filter knobs found | **21** (+ `page` pagination on 7 lists) |
| Current dropdown count | **2** (native `<select>`, both in `ReportFilters.tsx`) |
| Current non-dropdown filter count | **19** — 33 pills/links, 4 date inputs, 6 URL-only, 3 backend-only, 2 period pill rows |
| Inconsistent filters | **12** documented defects (§9) |
| Proposed shared component | `components/dashboard/filters/` — `filter-types.ts` + `DashboardFilterBar` + `DashboardFilterSelect` + `DashboardFilterSearch` + `DashboardFilterForm` (reuses the existing `ui/select.tsx`; **no new dependency, no duplicate Select**) |
| Wire format decision | **keep multi-value `?status=A&status=B`** (not `?queue=`) — already implemented, parsed, paginated and test-pinned |
| Batches | **10** (§15) |
| Risks | **10** (§14), two rated High (R6 permission-gated fields, R10 money-engine scope) |
| Test plan | 2 new suites + 3 extended suites; full `tsc` + Jest + lint + build in BATCH 10 (§13) |

**Waiting for `"GAS IMPLEMENTASI"`. Nothing will be implemented before that.**
