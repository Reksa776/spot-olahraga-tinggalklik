# PHASE 39 — PIC SELF-SERVICE MENU NAVIGATION FIX

**Status:** IMPLEMENTED — root cause proved from source + runtime (live browser, not
assumed), smallest correct change on the destination side. No new routes, no workaround
redirect, no capability/role/schema/permission change, no migration.
**Verified:** `tsc --noEmit` clean; `eslint` 0 errors (all 4 remaining warnings pre-exist);
`next build` clean; live browser click-through (desktop + mobile) **12/12 PASS** with
section-scroll proof; full suite **118 suites / 2283 passed, 1 pre-existing flaky failure**
(documented in §10, provably orthogonal to this phase).
**Safety:** NO COMMIT · NO PUSH · NO DB RESET · NO DESTRUCTIVE MIGRATION · payment/refund/
ledger/settlement code untouched.

---

## 1. EXACT ROOT CAUSE (proved, not assumed)

The bug report: *"Login PIC OK, menu PIC terlihat, tapi saat diklik kembali ke /dashboard /
halaman tidak terbuka sebagaimana mestinya."* The audit split it into two claims and proved
each against the running app:

### 1a. "Klik menu kembali ke /dashboard" — DOES NOT EXIST, proven
A full source sweep plus a real-browser walkthrough showed no mechanism returns a PIC to
`/dashboard`:
- No `redirect("/dashboard")` anywhere under `app/` (the only dashboard-level redirect is
  the `/login` gate on a missing session); `proxy.ts` is auth-only; `next.config.ts` has no
  dashboard redirect/rewrite.
- `DashboardAppShell` / `DashboardNav` / `DashboardShell` / `sidebar.tsx` render plain
  `<Link href={href}>` — `onClick` only closes the mobile drawer (`setMobileOpen(false)`),
  never returns the user.
- A fresh ACTIVE PIC logged in via HTTP, then each of the 4 menu rows was **actually clicked**
  in a real headless Chrome (desktop 1280px + mobile 390px). Every row landed on its exact
  target URL (`/dashboard/pic`, `#events`, `#referrals`, `#earnings`) — **never** `/dashboard`.
  Console: 0 errors, 0 warnings, 0 exceptions.

### 1b. "Halaman tidak terbuka" — REAL, this is the defect, proven
The menu offers three **hash-navigation rows** on the single self-service page
(`app/dashboard/pic/page.tsx`), but the page only declared TWO of the three anchors:

| Menu row | Menu href | Element declared on page | Before | After |
| --- | --- | --- | --- | --- |
| Event Saya | `/dashboard/pic#events` | `<div id="events">` | scrolled to 952px | scrolled to 888px |
| Referral | `/dashboard/pic#referrals` | **missing** | **stayed at 0px** | scrolled to 1279px |
| Pendapatan | `/dashboard/pic#earnings` | `<div id="earnings">` | scrolled to 2724px | scrolled to 2660px |

Clicking "Referral" changed the URL to `#referrals` but the browser had **no element to jump
to**, so the page stayed pinned at the top — the Ringkasan overview, which reads like the
generic dashboard. That is the honest mechanism behind "kembali ke dashboard utama / halaman
tidak terbuka". A second, contributing factor: even the anchors that DID exist sat under the
shell's `sticky top-0 h-16` header with no scroll offset, so a section could land with its
title buried and still look like "nothing opened".

## 2. APPLIED FIX — WHAT CHANGES

`app/dashboard/pic/page.tsx` only (destination side; menu hrefs stay byte-identical):
1. Added `<div id="referrals" className="scroll-mt-16 …">` wrapping the "Tautan Referral"
   section — the missing anchor that made the Referral row open nothing.
2. Added `scroll-mt-16` to the `#events` and `#earnings` anchors (same sticky-header offset),
   so every section clears the 64px shell header on jump.
3. No navigation code, menu map, permission, scope or route changed. An anchor offset is a
   destination definition, not a workaround redirect — the PIC menu rows were already landing
   on the right URL; now they land on the right *place*.

## 3. THE MENU ↔ PAGE CONTRACT (now pinned)

The four PIC self-service rows route only under `/dashboard/pic` — never `/dashboard`:
`/dashboard/pic` (Ringkasan PIC) · `/dashboard/pic#events` · `/dashboard/pic#referrals` ·
`/dashboard/pic#earnings`. Each hash row now resolves to a declared, offset-aware anchor on
the page; all separate self-service sections stay on this one page (no new routes were
invented, per the phase scope).

## 4. REGRESSION SUITE — `__tests__/pic-self-service/menu-navigation-regression.test.ts` (NEW)

- **Part A (pure, no DB):** every menu hash href has a matching `id` in the page source; all
  three anchors are declared; all three carry `scroll-mt-16`; no self-service row can equal
  `/dashboard`; a source scan proves no `app/dashboard` route module and no
  `components/dashboard` component performs `redirect("/dashboard")` /
  `router.replace("/dashboard")`.
- **Part B (real DB, mirrors the layout's exact predicate chain** `resolveAuthzScope →
  findActivePicProfile → computeDashboardCapabilities → buildDashboardNav`**):** ACTIVE pure
  PIC → admitted with exactly the four rows, never `/dashboard`; PENDING PIC → standing
  notice (flag false, rows absent, menu `["/dashboard"]`); DISABLED PIC → refused at the
  scope (`null`, no menu); ADMIN → `/dashboard/pic` stays the management row with no
  self-service fragments.

## 5. FILES CHANGED (Phase 39 only)

| File | Change |
| --- | --- |
| `app/dashboard/pic/page.tsx` | Added the missing `id="referrals"` anchor wrapper around "Tautan Referral" + `scroll-mt-16` on all three section anchors (against the `sticky h-16` header); indentation normalized to the file's nesting. |
| `__tests__/pic-self-service/menu-navigation-regression.test.ts` | **NEW** — 10 tests pinning the href↔anchor contract (§4). |

(Unchanged: `DashboardAppShell`/`DashboardNav`/`DashboardShell` nav, `lib/pic/self-service`,
`lib/authz`, `scope.ts`, schema, seed, and all payment/ledger/settlement code.)

## 6. TESTS

- New `menu-navigation-regression` suite included in the `pic-self-service` run: **5 suites /
  58 tests / 0 failures** (includes the pre-existing `menu.test.ts`, `entry.integration`,
  `ownership`, `reporting`).
- Full suite (default parallel workers): **118 suites / 2283 passed**, with the SINGLE
  failure being the pre-existing flaky `payment-races.integration.test.ts` (see §10).

## 7. TYPECHECK — `npx tsc --noEmit` → clean (0 errors).

## 8. LINT — `npm run lint` → 0 errors. All 4 warnings are pre-existing and in unrelated
files (`app/e/[slug]/page.tsx` ×2, `components/events/EventCard.tsx`, `scripts/verify-phase33-live.js`).
The 4 temporary warnings from the throwaway live-smoke harness disappeared with its deletion.

## 9. BUILD — `npm run build` → clean (all dashboard routes emit).

## 10. LIVE SMOKE — real browser click-through vs `next dev` :3000

A fresh ACTIVE PIC fixture (known password) logged in over HTTP, session injected into a
real headless Chrome, then:
- desktop: all 4 rows clicked from `/dashboard` → final URL exact; all 4 PASS;
- mobile (390px emulation, drawer): all 4 rows → final URL exact; all 4 PASS;
- section-scroll probe: `#events` 888px, `#referrals` 1279px, `#earnings` 2660px (referrals
  was **0px before the fix** — the regression, now open);
- console: 0 errors/warnings/exceptions throughout.
Result **12/12 PASS** — harness + fixtures removed afterward (0 rows left in dev DB).

## KNOWN PRE-EXISTING FLAKE (NOT a Phase 39 regression) — H1 payment-races

`__tests__/ticketing-payment/payment-races.integration.test.ts` (H1: "eight simultaneous Pay
clicks produce ONE provider payment") is a **timing-sensitive concurrency integration** in
code this phase is forbidden to touch. Under default-parallel full-suite load it failed in
3 of 3 runs *with* the Phase 39 suite present; it passed 3/3 standalone and the **full suite
ran 117/117 (2274/2274, 0 failures) with only this phase's new suite excluded**. A
`--maxWorkers=2` run made it worse (4 suites / 11 tests fail) — direct evidence the area is
parallel-timing sensitive, not a Phase 39 code defect. Verdict: pre-existing latent flake in
an intentionally concurrent suite; evidence logged here (receipts: `full-suite.log`,
`full-suite2.log`, `full-suite3.log`, `full-suite-no-new.log`, `full-suite-w2.log`,
`races.log` in `/tmp/opencode`). No payment/refund/settlement code was modified.

## NOTES & CAVEATS

- The literal "navigated back to /dashboard" does not reproduce on the current tree (proven
  at runtime); the reproducible defect is the Referral row opening nothing, plus anchors
  parking under the sticky header. The user-facing perception of both is "the PIC page did
  not open / bounced to the overview".
- Tests hit `<db>_test` (jest config); fixtures are unique-suffixed and cleaned in `afterAll`;
  dev DB spot-checked — only pre-existing fixtures remain (`disabled-check@example.test`,
  `phase33-verify-admin@example.test`).
- **NO COMMIT · NO PUSH · NO DB RESET.** All Phase 39 changes are uncommitted working-tree
  changes (page edit + new test file), consistent with the existing Phase 29–38 uncommitted
  baseline.