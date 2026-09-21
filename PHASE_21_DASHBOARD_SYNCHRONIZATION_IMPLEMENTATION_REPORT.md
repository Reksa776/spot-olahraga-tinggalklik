# PHASE 21 — DASHBOARD SYNCHRONIZATION + THEME SCRIPT RENDERING FIX

**Project:** TinggalKlik.Co
**Type:** Implementation (audit → fix → verify)
**Date:** 2026-09-19
**Status:** Implemented and verified. No commit, no push, no reset, no destructive DB operation.

---

## 1. Initial dashboard audit findings

The audit compared every dashboard surface against the real source of truth in four layers — UI →
API route → service layer → authorization → Prisma/domain contract. The dashboard was **not** out of
sync as a whole: orders, payments, refunds, customers, PIC, venues, reports and settings already
agreed with their services, and no stale retail domain (affiliate, ongkir, shipping, Spin Wheel,
COD, PayLater, payout engine) survived anywhere in the dashboard, components or `lib/dashboard`.

Two clusters were genuinely wrong:

| # | Mismatch | Layer that was wrong |
|---|---|---|
| M1 | Event **status vocabulary drift**: the list, the detail header and the overview each carried a private tone map, and `ONGOING` — a real, tick-driven, sellable state — was **absent from all three**, so a live event rendered as a neutral grey badge indistinguishable from a draft. | Dashboard UI |
| M2 | The event list **re-derived `totalPages`** from a second, hardcoded copy of the page size instead of reading `result.pagination.totalPages`. | Dashboard UI |
| M3 | The event list had **no status filter control** though `listOrganizerEvents` already supported `status`, and the raw `?status=` value was forwarded toward Prisma unvalidated — an unrecognised value would raise instead of rendering a page. | Dashboard UI |
| M4 | The overview `dipublikasikan` tile and the `upcoming` panel counted only `PUBLISHED`, so a live event **vanished from the count the moment it started** (the tick moves it to `ONGOING` at `startAt`). | Dashboard UI |
| M5 | The event detail offered the **public page link only for `PUBLISHED`** — an `ONGOING` event had no way to view what buyers see. | Dashboard UI |
| M6 | The event form still labelled the end time **"Selesai (opsional)"**, contradicting the Phase 20B rule that `endAt` is required *before publish*. | Dashboard UI (copy) |

No mismatch was found in API response interpretation, money formatting (server stays authoritative),
permission-based navigation, tenant/platform scope, refund SoD, payment settlement display, or PIC
attribution. Those were re-verified (see §8–§10) and are unchanged.

---

## 2. Theme script root cause

`DashboardThemeScript` returned `<script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />`
from `components/dashboard/theme/theme-provider.tsx`, mounted by `DashboardProviders` inside the
**dashboard route segment** (`app/dashboard/layout.tsx`).

A `<script>` inside a route segment is a host element React must render. On a **client-side
navigation** into the dashboard there is no server HTML to hydrate, so React *creates* the node on
the client, logs

> Encountered a script tag while rendering React component. Scripts inside React components are
> never executed when rendering on the client. Consider using template tag instead.

and — as the message states — does not execute it. Confirmed empirically against this repository:
the warning fires on **client-side navigation into any segment rendering a `<script>`**, and does
not fire on a full load. So the two symptoms had one cause: the script belonged to a route segment
instead of the document, making it both noisy *and* a no-op for exactly the users who reach the
dashboard through the post-login redirect or an in-app link.

`next-themes` was a **second** source of the identical warning: its provider renders its own inline
`<script>` inside whatever segment mounts it.

`next/script strategy="beforeInteractive"` was tested and **rejected**: for an **inline** script
Next emits a `self.__next_s.push(...)` stub and injects the real script only after
`DOMContentLoaded` (only `src`-based scripts are hoisted pre-paint), which reintroduces the flash
the script exists to prevent. Verified in a production build.

---

## 3. Theme script fix

The bootstrap now lives in the **root layout** as a plain inline `<script>`, the first child of
`<body>`, emitted by a **Server Component**:

- `app/layout.tsx` renders `<script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />`
  as the first child of `<body>`. The browser executes it while parsing — **before** the app below
  it is painted — and because the **root layout is never re-rendered on client-side navigation**,
  no navigation can re-create it.
- `components/dashboard/theme/theme-provider.tsx` no longer returns a `<script>`; the
  `DashboardThemeScript` component and the `next-themes` dependency are gone. The provider still
  owns the picker state and re-applies the three attributes while the user is in the dashboard.
- `components/dashboard/DashboardProviders.tsx` now mounts only `DashboardThemeProvider`.

All three preferences are covered by the one script: appearance (`class="dark"` +
`style.colorScheme`, `light` fallback matching the old `defaultTheme="light"`), `data-accent`, and
`data-chart`. The script reads the **same three localStorage keys** the provider writes
(`tk-dashboard-appearance` — the key the old `next-themes` used, so an existing choice survives —
`tk-dashboard-accent`, `tk-dashboard-chart`), is a no-op for a visitor who never personalised the
back office, and swallows storage failures (private mode) rather than throwing.

No hydration mismatch is introduced: the provider's server and first client render both use the
defaults and read the real values after mount through `useBrowserValue`; the switcher guards on the
same `mounted` signal.

**CSP note:** the root layout also carries the existing `unsafe-inline` script-src allowance in
`next.config.ts` — untouched by this phase (see §19).

---

## 4. Dashboard mismatches found

See §1 table (M1–M6). Nothing else in the audited surface list was found to be inconsistent with the
backend.

---

## 5. Event mismatches found

M1 (status drift + missing `ONGOING`), M2 (pagination), M3 (unvalidated filter, no filter control),
M4 (overview counts), M5 (detail public link), M6 (form copy). The backend `endAt`-before-publish
rule itself was **correct and left untouched** (see §6).

---

## 6. Event fixes

- **New** `lib/events/status.ts` — the one vocabulary for the dashboard:
  - `EVENT_STATUS_FILTERS` = `DRAFT, PUBLISHED, ONGOING, COMPLETED, CANCELLED, ARCHIVED`
    (typed `satisfies readonly EventStatus[]`). `PENDING_REVIEW` is **deliberately excluded** — D-13
    locked self-publish, so no code path can produce it.
  - `eventStatusTone(status)` — one tone table; `ONGOING → brand`, `PUBLISHED → success`,
    `COMPLETED → info`, `CANCELLED → error`, `DRAFT/ARCHIVED → neutral`, and **anything unrecognised
    degrades to `neutral`** rather than throwing.
  - `parseEventStatusFilter(value)` — narrows `?status=` to a reachable status or `null`.
- `app/dashboard/events/page.tsx` — reads `eventStatusTone`; validates the filter with
  `parseEventStatusFilter` before it reaches the service; adds a status filter control (a row of
  shareable links, keeping the page server-rendered); paginates from
  `result.pagination.totalPages`.
- `app/dashboard/events/[id]/page.tsx` — reads the shared tone table; offers the public page link
  for **`PUBLISHED` and `ONGOING`**.
- `app/dashboard/page.tsx` — overview badge reads the shared tone table.
- `lib/dashboard/overview.ts` — the published count and the upcoming panel now count
  **`{ in: ["PUBLISHED", "ONGOING"] }`**. The already-correct upcoming filter keeps `startAt > now`.
- `components/organizer/EventForm.tsx` — the end-time field is relabelled from `"Selesai (opsional)"`
  to `"Selesai"` with a hint: optional for a draft, **required before publication**. The field
  itself stays optional so a draft can be saved before the schedule is settled.

**The backend rule was not weakened.** `publishEvent` in `lib/events/service.ts` still refuses
publication when `endAt === null` (asserted by a regression test, §11). The dashboard copy now
matches the contract; the service remains authoritative.

**No invented behaviour.** The dashboard does not imply that `endAt`, cancellation, completion or
archive move money, refund buyers, or create tickets — none of those exist in the contract, and
nothing added by this phase suggests otherwise.

---

## 7. Other dashboard fixes

None beyond M1–M6. The theme fix (§3) is the only other code change.

---

## 8. Permission / authorization verification

Unchanged and re-checked. UI visibility was **not** treated as authorization: every dashboard page
still resolves its context server-side (`getOrganizerPageContext`, `getAuthzScope`) and the API
routes/services remain the authority (`requireOrganizerAccess`, refund SoD, tenant membership). The
status filter links added to the event list carry **no** new authority — the query is still scoped
by `readableOrganizerIds` inside `listOrganizerEvents`. No permission key was added or removed.

---

## 9. API / data-contract verification

- The event list's `?status=` is now validated **before** the service; the API route
  (`app/api/organizer/events/route.ts`) was left as-is and still validates against its own
  `EVENT_STATUSES` superset and returns `AppError.validation` for anything else (see §19, INFO-1).
- Money: no formatting or arithmetic moved into the frontend; server remains authoritative.
- No dashboard fetch expects a field the API no longer returns, and no nullable field is treated as
  always present (`eventStatusTone` tolerates any string).

---

## 10. Public / dashboard consistency verification

- Public visibility: `lib/events/catalog.ts` excludes `DRAFT / PENDING_REVIEW / CANCELLED /
  ARCHIVED` (and completed events drop out), so the detail page's link now appears for exactly the
  two states the public catalog serves — `PUBLISHED` and `ONGOING`.
- No duplicate event state was introduced; the dashboard continues to consume
  `lib/events/service.ts` and the catalog continues to consume the same event rows.

---

## 11. Tests added / updated

- **Added** `__tests__/events/status-presentation.test.ts` (11 tests): the status tuple, the
  deliberate absence of `PENDING_REVIEW`, per-status tones, the unknown-value fallback, filter
  narrowing (`undefined`, `""`, `PENDING_REVIEW`, lowercase, injection), that the three surfaces
  read the shared table (and no longer carry inline conditionals), that pagination is the service's
  answer, that a live event keeps its public link, and that `publishEvent` still refuses a null
  `endAt`.
- **Updated** `__tests__/ui-consolidation/shadcn-dashboard.test.ts`: the theme-bootstrap assertion
  now strips comments before checking `theme-provider.tsx` for a leftover `next-themes` **import**,
  so the provider's doc block can keep naming the removed library while an actual leftover import
  would still fail. (The guard was matching explanatory prose; it now checks code, as its own
  neighbouring guard already did.)

---

## 12. Tests executed

| Suite set | Result |
|---|---|
| `status-presentation`, `shadcn-dashboard`, `lifecycle-ui-wiring`, `event-service.integration` | **4 passed / 4 suites, 119 passed / 119 tests** |
| Full `npx jest` | **50 passed / 14 failed suites (64 total); 1282 passed / 106 failed tests (1388 total)** |

**Every one of the 14 failing suites was confirmed pre-existing**, by stashing all tracked changes
and re-running them on the untouched working tree:

- `security/m3-hsts`, `security/m4-csp`, `security/csp-development-unsafe-eval` — read `next.config.ts`,
  which currently declares only `poweredByHeader` and `allowedDevOrigins` (no `headers()` function).
  **`next.config.ts` is not modified by this phase.**
- `ticketing-{issuance,checkout,payment,checkin,refunds}/*.integration.test.ts` — fail at fixture
  setup (`expected SETTLED, got DUPLICATE`), i.e. leftover rows from a previous run, and their
  imports have **no edge** to any file this phase touched. Reproduced identically on the baseline.
- `ui-consolidation/shadcn-dashboard` is the one suite whose state changed: it now **passes**.

No assertion was weakened and no test was skipped to make something pass.

---

## 13. TypeScript result

`npx tsc --noEmit` → **clean** (no output).

## 14. Build result

`npm run build` → **success** (Next.js 16.3.0). All dashboard routes and `/e/[slug]`, `/events`
built as expected; Proxy (middleware) present.

## 15. ESLint result

`npx eslint` on every changed source and test file → **clean** (no output).

## 16. Runtime smoke results

Production build served locally (`next start`), verified with `curl` and with a headless Chrome
session driven over CDP:

| Check | Result |
|---|---|
| `GET /` | 200; theme bootstrap is the **first child of `<body>`**; no `__next_s` stub |
| Bootstrap present once in served HTML across `/`, `/login`, `/events` | yes |
| `GET /dashboard` anonymous | **302** → `/login?callbackUrl=%2Fdashboard` |
| `GET /dashboard/events` anonymous | **302** → `/login?callbackUrl=%2Fdashboard%2Fevents` |
| Full load → reload → **client-side navigation** (clicked an internal link to `/`) | **0 console messages of any level**, 0 script-tag warnings, 0 hydration warnings, 0 page errors |
| Theme persistence (wrote appearance=`dark`, accent=`violet`, chart=`ocean`; reloaded) | `class="dark"`, `data-accent="violet"`, `data-chart="ocean"`, `style.colorScheme="dark"` — all applied by the bootstrap |

(First persistence run appeared to fail on appearance, but the probe had written the wrong key —
`tk-dashboard-theme` instead of `tk-dashboard-appearance`. With the correct key the bootstrap
applies all three. The bug was in the probe, not the app.)

## 17. Files changed

| File | Change |
|---|---|
| `app/layout.tsx` | Bootstrap inline `<script>` as first child of `<body>`; documentation |
| `components/dashboard/theme/theme-provider.tsx` | Removed `DashboardThemeScript`; no `<script>`, no `next-themes` |
| `components/dashboard/theme/theme-config.ts` | Bootstrap script covers all three preferences; corrected docs |
| `components/dashboard/theme/theme-switcher.tsx` | Aligned with the provider |
| `components/dashboard/DashboardProviders.tsx` | Mounts only the theme provider; corrected docs |
| `lib/events/status.ts` | **New** — shared status vocabulary, tone, filter narrowing |
| `app/dashboard/events/page.tsx` | Shared tone; validated filter + filter UI; service pagination |
| `app/dashboard/events/[id]/page.tsx` | Shared tone; public link for `PUBLISHED` **and** `ONGOING` |
| `app/dashboard/page.tsx` | Overview badge reads the shared tone |
| `lib/dashboard/overview.ts` | Published count and upcoming panel count `PUBLISHED` + `ONGOING` |
| `components/organizer/EventForm.tsx` | End-time label/hint matches the Phase 20B rule |
| `__tests__/events/status-presentation.test.ts` | **New** regression suite |
| `__tests__/ui-consolidation/shadcn-dashboard.test.ts` | Bootstrap guard checks code, not prose |
| `next-env.d.ts`, `tsconfig.tsbuildinfo` | **Generated artifacts** touched by the build runs (not hand-edited) |

## 18. Files intentionally not changed

- `next.config.ts` (CSP/HSTS headers live here in production; out of scope).
- `lib/events/service.ts` — the `endAt`-before-publish rule is already correct and remains the
  authority.
- `app/api/organizer/events/route.ts` — its own status validation is a backend concern.
- All payment, refund, ticket issuance, check-in, QR, scheduler/tick, lifecycle and Prisma schema
  files — no contract change was required.
- Every other dashboard surface audited and found already consistent.

## 19. Remaining known gaps

- **INFO-1:** `app/api/organizer/events/route.ts` accepts `PENDING_REVIEW` in its `EVENT_STATUSES`
  superset while the dashboard offers only the six reachable statuses. This is intentional at the
  API (defensive superset) and not a defect; noted for awareness.
- **INFO-2:** The three security-header test suites fail because `next.config.ts` does not currently
  declare `headers()`. **Pre-existing**, untouched by this phase, and out of scope; flagged so it is
  not mistaken for a regression.
- **INFO-3:** The ticketing integration suites fail on fixture residue in the shared database
  (`DUPLICATE` settlement). Pre-existing and environmental (they need a clean DB); not touched.
- **INFO-4:** `next-env.d.ts` and `tsconfig.tsbuildinfo` show as modified because `next start`/build
  rewrote them (`.next/dev/types` → `.next/types`). Generated files, safe to discard.

## 20. Explicit confirmation

- ✅ No database reset.
- ✅ No destructive migration.
- ✅ No data deletion.
- ✅ No commit.
- ✅ No push.
- ✅ No `git reset`, no `git clean`, no `git checkout -- .`. (A `git stash`/`git stash pop` pair was
  used **only** to establish the pre-existing-failure baseline; the working tree was fully restored.)
- ✅ No secret value was read or displayed.

The layers now agree:

```
REAL BACKEND CONTRACT
        ↓
SERVICE / AUTHZ          (unchanged — still authoritative)
        ↓
API                      (unchanged)
        ↓
DASHBOARD UI             (status vocabulary, filter, pagination, counts, copy, theme bootstrap)
        ↓
PUBLIC UI                (unchanged — already consistent)
```
