# LANDING PAGE — PUBLISHED EVENT VISIBILITY + PURCHASE CARD SCROLL FIX

**Phase:** Landing-page PUBLISHED-event visibility + Detail-Event purchase-card scroll behaviour
**Scope:** TinggalKlik.Co — public landing page, `/events`, event detail page, public catalog service, checkout service
**Status:** Implemented, tested (unit + integration + real browser), typechecked, linted, built
**Not done (explicitly):** no `git commit`, no `git push`, no `git reset/rebase/stash`, no new dependency, no `prisma/schema.prisma` change, no migration, no DB reset, no data deleted outside this phase's own fixtures

---

## 1. Audit before coding

Everything below was read before a single line was changed.

### Event visibility

| Surface | What it reads |
| --- | --- |
| `app/page.tsx` (landing) | `listPublicEvents()` × 3 (`startAt_asc`, `newest`, `priceMax: 0`) + `countPublicEventsBySport()` |
| `app/events/page.tsx` (`/events`) | `listPublicEvents()` with the same `catalogQuerySchema` |
| `app/api/events/route.ts` | `listPublicEvents()` — the JSON surface |
| `app/e/[slug]/page.tsx` (detail) | `getPublicEventBySlug()` (+ `listPublicEvents()` for "related") |
| Cards | `components/events/EventCard.tsx` — presentation only, renders exactly the `PublicEventCard` fields |

There is **no frontend filter and no `EventCard` hiding**: every list is the server's payload. The visibility rule lives in exactly one place — `lib/events/catalog.ts`.

### Date / "closed" utilities already in the project

* `lib/events/sales-state.ts` — `summarizeSales`, `classifySalesState`, `remainingFor`, `isEventPurchasable`, `isEventCheckInOpen`; the **only** place the sales-window rule (`type.salesEndAt ?? event.salesEndAt ?? event.startAt`) exists.
* `lib/events/lifecycle.ts` — the lifecycle state machine (`PUBLISHED → ONGOING → COMPLETED`) and the 30-minute grace window.
* `lib/ticketing/ui/format.ts` — `formatEventSchedule`, `salesStateLabel` (the "penjualan ditutup / tiket habis" vocabulary) and the `Asia/Jakarta` formatters.
* No new timezone utility was created: the "has the event passed?" question is answered by comparing real `Date` instants, exactly as the catalog already did.

### Purchase card

* `app/e/[slug]/page.tsx` — the `#beli` card carried `lg:sticky lg:top-24`; the page rendered `components/ticketing/StickyBuyBar.tsx` (`fixed inset-x-0 bottom-0 z-40 ... lg:hidden`) whenever `event.isAvailable`; the `<article>` carried `pb-24` purely to clear that bar.
* `components/events/TicketPurchaseForm.tsx` — no positioning classes of its own (verified by grep: zero `sticky` / `fixed` / `absolute` in `components/events/`).
* Parent chain (`aside`, the `lg:grid-cols-3` wrapper, `article`) — no `overflow` or `transform` that could create a containing block or a scroll container. **No JS scroll listener, `onscroll`, `requestAnimationFrame` or `getBoundingClientRect` exists anywhere in the page.**

---

## 2. Root cause — why a past PUBLISHED event did not appear

**Cause A/B — a hard-coded DATE FILTER inside the catalog query.** Not a frontend filter, not `EventCard`.

`lib/events/catalog.ts` → `publicVisibilityWhere(now)` carried:

```ts
status: { in: ["PUBLISHED", "ONGOING"] },
visibility: "PUBLIC",
archivedAt: null,
OR: [                                   // ← the past-event filter
    { endAt: { gte: now } },
    { AND: [{ endAt: null }, { startAt: { gte: now } }] },
],
```

Any event whose end (or start, when `endAt` is null) had passed was excluded from **every** public surface at once: landing, `/events`, `/api/events`, the per-sport counts, and the "related events" band — while the detail page still resolved it by slug. That is why it looked like a "hidden landing page" bug rather than a query problem.

The lifecycle makes this the normal outcome too (`PUBLISHED → ONGOING` at `startAt`, `→ COMPLETED` at `endAt + 30m`, and `COMPLETED` is outside the catalog's status list), so a still-`PUBLISHED` past event exists only where that scheduler has not run. `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` records the past-event display as deliberately out of scope (`P14-D24`) — this phase is that work.

**Second, independent root cause (the CTA).** Even once listed, the *sales* verdict could not express "the event is over":

* `EventCard.availabilityBadge` showed "Ditutup" only for `salesState === "CLOSED"`.
* `classifyType`'s window end is `type.salesEndAt ?? event.salesEndAt ?? event.startAt`. With an **explicit future `salesEndAt`**, a finished event classifies as **`OPEN`** — so the card had no badge and the detail page's `closedReason` was `null`, leaving an active "Pesan tiket".
* The server had the same gap: `isEventPurchasable` is a **status** question (no dates), so an authenticated client could still create an order for a finished event whose sales window had not closed.

---

## 3. Query/filter found

One predicate, three call sites:

```ts
// lib/events/catalog.ts — BEFORE
publicVisibilityWhere(now)  →  { status ∪ visibility ∪ archivedAt ∪ PAST-DATE-FILTER }
```

Used by `listPublicEvents` (via `buildFilterWhere`) and `countPublicEventsBySport`. Nothing else filtered dates; `catalogQuerySchema.dateFrom/dateTo` are **caller-supplied** filters and were left untouched.

---

## 4. Change — event visibility

`publicVisibilityWhere` is now composed from two named pieces:

```ts
publicStatusWhere()      // status ∈ {PUBLISHED, ONGOING} ∧ visibility = PUBLIC ∧ archivedAt = null
notEndedWhere(now)       // the OLD date filter, now used only where it belongs
endedWhere(now)          // the mirror of notEndedWhere — ordering only, never visibility

publicVisibilityWhere(now) = AND[
    publicStatusWhere(),
    OR[
        { status: "PUBLISHED" },   // ← never date-filtered: a published event is not deleted by the clock
        notEndedWhere(now),        // ← ONGOING keeps its live-window filter
    ],
]
```

* **PUBLISHED** rows are now returned regardless of the clock.
* **ONGOING** rows keep the existing live-window filter (the scheduler resolves them into `COMPLETED`, which stays outside the status list).
* `DRAFT` / `PENDING_REVIEW` / `CANCELLED` / `ARCHIVED` are untouched — still excluded by `publicStatusWhere` (plus `archivedAt`), i.e. the existing rules.
* **The lifecycle state machine was not touched**: nothing writes `status`, and no event is auto-archived/completed for display purposes.

### The "has it ended?" verdict — one canonical rule

New pure predicate in `lib/events/sales-state.ts`, beside `isEventPurchasable`:

```ts
export function isEventEnded(event: { startAt: Date; endAt: Date | null }, now = new Date()): boolean {
    const end = event.endAt ?? event.startAt;
    return end.getTime() < now.getTime();
}
```

It is deliberately the **same rule the catalog's past filter always used** (`endAt >= now`, else `startAt >= now`, is the not-past form), so no new business rule was invented — the existing comparison was given a name and reused. The boundary is strict (`end === now` is still not ended, matching the inclusive `gte`).

Exposed to the UI as a server-computed boolean so no view re-derives it (and no client clock can disagree):

* `PublicEventCard.hasEnded`
* `PublicEventDetail.hasEnded`
* `getPublicEventBySlug(slug, origin, now = new Date())` — `now` injectable for exact boundary tests (same pattern as `isEventCheckInOpen`, `advanceEventLifecycleBatch`, `expireDueReservations`).

### Ordering — upcoming first, ended after

Once past events are visible, a plain `startAt asc` would put every finished event at the **front** of "Event terdekat" ("Yang paling cepat digelar"), and with `limit: 8` the upcoming ones would fall off the page entirely.

Prisma cannot `ORDER BY "has this row's end passed?"` — it is a comparison against the clock, not a column — so for the date ordering only, `listPublicEvents` assembles the page from the two sets the visibility rule already knows:

1. `upcomingCount = count(where ∧ notEndedWhere)` — maps the page offset onto the right set;
2. the live window, `startAt asc` (bounded by `limit`/`skip`);
3. the finished rows, `startAt desc` (most recently started first), filling the remainder.

`total` and `totalPages` are unchanged. `newest` keeps creation order ("Baru ditambahkan" is about when an event was published), and `price_asc` / `price_desc` keep their aggregate ordering untouched.

> **Behaviour note (deliberate).** On the landing page's 8-card "Event terdekat" preview, a passed event appears *after* the upcoming ones and therefore only when it fits in that preview. It is always present on `/events` and in `/api/events` (no cap), which is the full catalog. This is the ordering you chose when asked ("After upcoming events").

---

## 5. Behaviour of an event that has ended

| Question | Answer |
| --- | --- |
| Listed on the landing / `/events` / API? | **Yes** |
| `hasEnded` on the payload | `true` |
| Badge on the card | **"Ditutup"** (outranks every sales state) |
| Detail page reachable? | **Yes** — D-14's `isAvailable` is a *status* question and is unchanged |
| Purchase CTA on the detail page | **Suppressed** (the existing "Pembelian tiket tidak tersedia untuk event ini." refusal, no tier steppers, no submit button) |
| New order possible? | **No** — refused server-side (`409 SALES_NOT_OPEN`, `reason: "EVENT_ENDED"`) |
| DB status changed for display? | **No** |
| Lifecycle state machine changed? | **No** |

---

## 6. UI — "Ditutup"

* **`components/events/EventCard.tsx`** — `hasEnded` is checked **first** in `availabilityBadge` and wins outright, before `SOLD_OUT` / `NOT_STARTED` / `CLOSED`. It reuses the existing `text-xs font-bold text-ink-500` caption style already used for "Ditutup" (no new design), next to the price. The card keeps its single `<a>` and gains no button: the only affordance remains the link to the detail page.
* **`app/e/[slug]/page.tsx`** — `closedReason` becomes `"Ditutup"` when `event.hasEnded`, so the hero pill cannot claim an event is on sale merely because its sales window is open. The purchase card receives `purchasable = event.isAvailable && !event.hasEnded`.
* Consistent at every breakpoint and on both surfaces: the badge is a card caption (same at all widths), and the detail CTA reuse is the project's existing unavailable state.

---

## 7. Root cause — the purchase card followed the viewport

Two independent mechanisms, both viewport-tracking:

1. `app/e/[slug]/page.tsx` (line ~404, before the change):
   `<div id="beli" className="scroll-mt-24 rounded-2xl border border-ink-100 bg-white p-5 shadow-card lg:sticky lg:top-24">` — **`lg:sticky lg:top-24`** pinned the card beside the description on desktop while the page scrolled past it.
2. `components/ticketing/StickyBuyBar.tsx` — **`fixed inset-x-0 bottom-0 z-40 ... lg:hidden`**, rendered by the page below `lg`: a fixed purchase bar that sat on top of whatever was behind it (the `<article>`'s `pb-24` existed only to clear it).

No parent `overflow`, `transform`, `z-index` or JS scroll listener was involved. Per your decision ("Remove it too"), both were removed.

---

## 8. Change — purchase card scroll behaviour

* `#beli` → `className="scroll-mt-24 rounded-2xl border border-ink-100 bg-white p-5 shadow-card"` — the positioning utilities are gone; `scroll-mt-24` is kept so an in-page anchor jump still clears the sticky site header (that is `scroll-margin-top`, which moves where the anchor lands and pins nothing).
* The `StickyBuyBar` import and its render site were removed from the detail page; the `<article>`'s `pb-24 lg:pb-0` was dropped because the space it reserved no longer has a bar to clear. `components/ticketing/StickyBuyBar.tsx` still exists (its own tests pin it) — it is simply no longer rendered anywhere on the detail page.
* Nothing was papered over: no `z-index` change, no `overflow-hidden`, no overlay, no new wrapper. Both affordances are ordinary in-flow content.

---

## 9. Responsive behaviour

| Breakpoint | Before | After |
| --- | --- | --- |
| Desktop (`≥ lg`) | `#beli` in the right column **and sticky** | Same right column (`aside` inside the `lg:grid-cols-3` grid), normal flow, no `sticky` |
| Tablet (`md`) | Fixed bottom bar | Normal flow only |
| Mobile (< `lg`) | Card in flow **+ fixed bottom bar** covering content | Card in flow only; nothing pinned |

Measured in a real headless Chrome at 1440×900, 834×1112 and 390×844 (§16).

---

## 10. Server-side protection

`lib/ticketing/checkout.ts` — a new guard in `createTicketOrder`, placed **after** the `isEventPurchasable` status check and **before** the per-order ceiling and the pricing walk (nothing is written before it; the whole order/reservation transaction is downstream):

```ts
if (isEventEnded(event, now)) {
    throw new AppError(ERROR_CODES.SALES_NOT_OPEN, {
        message: "Event ini sudah selesai dan tidak menerima pesanan baru.",
        details: { reason: "EVENT_ENDED" },
    });
}
```

* It exists because `isEventPurchasable` is a status question and `classifySalesState`'s default window end is `startAt` — an explicit future `salesEndAt` would otherwise keep a finished event at `OPEN`.
* It uses the **same** `isEventEnded` the card badge is built from, so display and enforcement cannot drift.
* `endAt: true` was added to the event `select` (a narrow addition to an existing projection).
* **Nothing else changed**: price is still read from `TicketType.price` and recomputed with `Prisma.Decimal`, quota still goes through the `reserveQuota` CAS inside the single transaction, idempotency, reservation TTL, payment architecture and the `401`/auth path are untouched. The client's "Ditutup" state is never trusted — it is only ever confirmed.
* No open redirect, no auth/authz bypass: the guard is downstream of the session and adds an additional refusal, never an allowance.

---

## 11. Regression — checkout (guest login + restore)

Re-driven end-to-end in a real browser (see §16). Unchanged by this phase: `components/events/TicketPurchaseForm.tsx` and `lib/ticketing/checkout-draft.ts` were **not modified at all** (the only wiring that changed near the form is the detail page passing `isAvailable={purchasable}`, which equals `event.isAvailable` for every event that has not ended).

*Guest:* detail → fill (qty 2 + Budi / budi-phaseb@example.com / 08123456789) → "Pesan tiket" → `401` → `/login?callbackUrl=%2Fe%2F<slug>` → sign in → **back on the same event page** (not `/dashboard`) with the form restored (all four values, restore notice, submit enabled) and the draft consumed. ✅

*Authenticated:* a signed-in buyer's `POST /api/ticketing/checkout` reaches the normal business gates (verified by the integration suite refusing with `LIMIT_EXCEEDED` — i.e. past the clock guard — and by the upcoming event's detail page rendering a working form).

---

## 12. Test results

**`npx jest --runInBand`**

| Run | Result |
| --- | --- |
| 1st | 159 suites, **3467 tests — 3466 passed, 1 failed** |
| 2nd | 159 suites, **3467 tests — all passed** |

The single first-run failure was `__tests__/ticketing-payment/payment-races.integration.test.ts` › "G1. expiry and settlement cannot both win (4 rounds)" — a **documented pre-existing, load-sensitive flake** (recorded as such in `PHASE_39_…`, `PHASE_33_…`, `PHASE_20B_…`, `PHASE_18A_…` etc.). It passed in isolation and on the re-run. It is not attributable to this phase: that suite's fixtures are `FUTURE`-dated (`payment-harness.ts` → `startAt: FUTURE`), so the new `isEventEnded` guard can never fire in it, and this phase touches neither payment nor reservation code.

### Tests added / updated, mapped to the brief's A–O

| # | Requirement | Where | Result |
| --- | --- | --- | --- |
| A | PUBLISHED, not passed → appears | `__tests__/events/past-published-visibility.integration.test.ts` (+ `catalog.integration.test.ts`) | ✅ |
| B | PUBLISHED, passed → still appears | `past-published-visibility…` (2 fixtures), `catalog.integration.test.ts` (rewritten "a past event is excluded") | ✅ |
| C | passed → badge "Ditutup" | `__tests__/ticketing-ui/discovery-render.test.ts` (fed `salesState: "OPEN"` deliberately) | ✅ |
| D | passed → purchase CTA inactive | `discovery-render.test.ts` (no buy affordance on the card) + `__tests__/ticketing-checkout/checkout-draft.test.ts` §I (form refuses: notice, no submit, no steppers) + `purchase-card-flow.test.ts` (page wires `purchasable`) | ✅ |
| E | DRAFT → absent | `catalog.integration.test.ts` (existing) + `past-published-visibility…` | ✅ |
| F | CANCELLED → existing rule | same two suites | ✅ |
| G | ARCHIVED → existing rule | same two suites | ✅ |
| H | boundary: just before the end → not ended | `__tests__/events/sales-state.test.ts` (`isEventEnded`, **fixed clock**) | ✅ |
| I | boundary: just after the end → ended | `sales-state.test.ts` (`isEventEnded`, **fixed clock**) | ✅ |
| J | passed → server refuses a new order | `past-published-visibility…` (real `createTicketOrder`, `SALES_NOT_OPEN`/`EVENT_ENDED`, **0 order rows**) | ✅ |
| K | card uses no sticky/fixed | `__tests__/ticketing-ui/purchase-card-flow.test.ts` (computed-position class audit over comment-stripped source) | ✅ |
| L | desktop: no overlap | `purchase-card-flow.test.ts` + real-browser geometry (§16) | ✅ |
| M | mobile: no overlap, normal flow | `purchase-card-flow.test.ts` + real-browser geometry (§16) | ✅ |
| N | existing checkout form still works | `checkout-draft.test.ts` §I (submit button, steppers, buyer fields, CLOSED ⇒ disabled action) | ✅ |
| O | guest → login → return → restore | `checkout-draft.test.ts`'s existing 57 assertions + real-browser flow (§16) | ✅ |

No test was skipped, weakened or deleted to make the suite green. The one existing assertion that changed is `catalog.integration.test.ts`'s "a past event is excluded" → "PHASE B: a past PUBLISHED event is STILL listed, marked hasEnded" (the old name asserted exactly the behaviour this phase was asked to change), plus the date-sort test, which now asserts the new two-block ordering while keeping its original intent (the ordering is applied by the query, not by re-sorting a fetched page).

---

## 13. TypeScript result

```
npx tsc --noEmit --incremental false
→ exit 0, no output
```

---

## 14. Lint result

```
npm run lint
→ ✖ 4 problems (0 errors, 4 warnings)
```

Identical to the pre-phase baseline — all four are pre-existing and in files this phase did not touch:
`app/e/[slug]/page.tsx` (`<img>` ×2, pre-existing), `components/events/EventCard.tsx` (`<img>`, pre-existing), `scripts/verify-phase33-live.js` (unused `custCookies`). **Zero new warnings, zero errors.**

---

## 15. Build result

```
npm run build
→ exit 0
```

All routes compiled, including `ƒ /e/[slug]`, `ƒ /events`, `ƒ /`.

---

## 16. Browser / UI validation (performed)

Headless Chrome 153 over raw CDP (the technique the checkout phase used), production server (`next start`) on `http://localhost:3000`, with two throw-away `PUBLISHED + PUBLIC` fixtures in the development database:

* `upcoming` — start `+20d`, no explicit sales end;
* `passed` — start/end `−20d`, and an **explicit `salesEndAt` at `+40d`** so its `salesState` is `OPEN` (the exact case a sales-state-only check gets wrong).

All fixture rows were deleted afterwards (verified: 0 leftover events / sports / organizers / users).

| Brief check | Method | Result |
| --- | --- | --- |
| 1. PUBLISHED not passed appears | SSR HTML of `/` | ✅ card rendered, no badge |
| 2. PUBLISHED passed still appears | SSR HTML of `/` | ✅ card rendered |
| 3. passed shows "Ditutup" | SSR HTML: landing card, and the detail hero pill (`rounded-full bg-white/95 … Ditutup`) | ✅ (the other passed event, `badminton-star-cirebon`, also shows it; the upcoming card shows **no** badge) |
| 4. passed CTA cannot checkout | detail page shows the refusal and **0** submit buttons / **0** tier inputs; authenticated `POST /api/ticketing/checkout` for the passed event → **409 `SALES_NOT_OPEN`, `details.reason = "EVENT_ENDED"`**; 0 order rows and 0 reservations created | ✅ |
| 5. card is not sticky/fixed | `getComputedStyle(#beli).position` | ✅ `"static"` at 1440×900, 834×1112 and 390×844 |
| 6. scrolling never makes the card overlap | 14 scroll steps per breakpoint: constant document offset, rect-intersection against the share card / "Tentang event" / related band / footer, `elementFromPoint` on the card's own box, and a fixed/sticky-element sweep | ✅ `offsetDrift = 0px` at every breakpoint (the card moves with the page); 0 intersections; 0 "covered by" hits; the only floating element intersecting the card box is the app-wide toast portal `data-rht-toaster` — empty, transparent, `pointer-events: none` |
| 7. desktop / 8. mobile / tablet | 1440×900, 834×1112, 390×844 | ✅ |
| 9. guest → login → return → restore | real form + real login page | ✅ `/login?callbackUrl=%2Fe%2F<slug>`; draft stored with exactly `buyerEmail,buyerName,buyerPhone,eventId,items,savedAt,shareToken`; after sign-in returned to `/e/<slug>` (**not** `/dashboard`); values restored (Budi PhaseB / budi-phaseb@example.com / 08123456789 / qty 2); notice "Data pembelian Anda dipulihkan setelah login…" shown; draft consumed; submit enabled |

Ordering confirmed on the real page: "Event terdekat" rendered `phaseb-e2e-upcoming → badminton-star-cirebon` (ended) `→ phaseb-e2e-passed` — upcoming first, ended after, most-recent first.

---

## 17. Git status

```
 M __tests__/events/catalog.integration.test.ts
 M __tests__/events/sales-state.test.ts
 M __tests__/ticketing-checkout/checkout-draft.test.ts
 M __tests__/ticketing-ui/discovery-render.test.ts
 M __tests__/ui-consolidation/page-reveal.test.ts
 M app/e/[slug]/page.tsx
 M components/events/EventCard.tsx
 M lib/events/catalog.ts
 M lib/events/sales-state.ts
 M lib/ticketing/checkout.ts
?? LANDING_PUBLISHED_EVENT_VISIBILITY_REPORT.md
?? __tests__/events/past-published-visibility.integration.test.ts
?? __tests__/ticketing-ui/purchase-card-flow.test.ts
```

**No commit, no push, no reset/rebase/stash.** Every temporary artifact this phase created was removed: `scripts/tmp-phaseb-e2e.ts`, `scripts/tmp-phaseb-browser.mjs`, `scripts/tmp-phaseb-flow.mjs`, the fixture rows, `/tmp/zz-phaseb-chrome`, and the `next start` / headless-Chrome processes (ports 3000 and 9333 confirmed down).

---

## 18. DB / schema status

* `prisma/` — **0 files changed** (`git status --short -- prisma` is empty).
* **No migration, no `schema.prisma` edit, no DB reset, no data deleted outside this phase's own fixtures.**
* The development database was used only for the throw-away fixtures described in §16, all of which were removed and re-verified as gone.
* No event's stored `status` was changed to achieve any of the display behaviour.

---

## 19. Files changed

| File | Change |
| --- | --- |
| `lib/events/sales-state.ts` | **Added** the canonical `isEventEnded` predicate (+ its `EventEndWindow` type). Pure, clock-injectable, no new business rule. |
| `lib/events/catalog.ts` | Split the hard-coded public filter into `publicStatusWhere` / `notEndedWhere` / `endedWhere`; a `PUBLISHED` row is no longer date-filtered; added `hasEnded` to the card and detail payloads; the date ordering leads with not-yet-ended events; `getPublicEventBySlug` takes an injectable `now`; `toCard`/`toDetail` now pass one clock to `summarizeSales`. |
| `components/events/EventCard.tsx` | `availabilityBadge` checks `hasEnded` first and labels it "Ditutup". |
| `app/e/[slug]/page.tsx` | Removed `lg:sticky lg:top-24` from `#beli` and the fixed `StickyBuyBar` render (+ the `pb-24` that cleared it); `closedReason` = "Ditutup" for an ended event; the purchase card reads `purchasable = event.isAvailable && !event.hasEnded`; documentation updated. |
| `lib/ticketing/checkout.ts` | Added the event-ended refusal (`SALES_NOT_OPEN` / `EVENT_ENDED`) and `endAt` to the event projection. |
| `__tests__/events/past-published-visibility.integration.test.ts` | **New** — A, B, the state-matrix, ordering/pagination, detail verdicts, and J (server refusal + no rows written). |
| `__tests__/ticketing-ui/purchase-card-flow.test.ts` | **New** — K/L/M source audit (no sticky/fixed, no responsive variant, no scroll JS, in-flow sidebar) + the ended-event wiring. |
| `__tests__/events/catalog.integration.test.ts` | Past-event assertion rewritten for the new rule; `pastOpenSales` fixture added (proves `salesState` can stay `OPEN` while `hasEnded` is true); ordering test rewritten; detail `hasEnded` assertions added. |
| `__tests__/events/sales-state.test.ts` | H/I boundary tests for `isEventEnded` with a fixed clock. |
| `__tests__/ticketing-ui/discovery-render.test.ts` | C/D card badge + no-purchase-affordance tests; fixture gains `hasEnded`. |
| `__tests__/ticketing-checkout/checkout-draft.test.ts` | Section I — the form's refusal (D) and its untouched working state (N). |
| `__tests__/ui-consolidation/page-reveal.test.ts` | Fixture gains the required `hasEnded` field (type-only). |

**Diff size:** 10 modified + 2 new code files (plus this report), `642 insertions(+), 71 deletions(-)`.

---

## Final acceptance

**Event PUBLISHED — not yet ended:** shown normally on the landing page, `/events` and the API; no "Ditutup" badge; detail page renders a working form; buyable whenever the existing checkout rules are satisfied. ✅

**Event PUBLISHED — already ended:** **still shown** (never removed by the clock); badge **"Ditutup"** on the card and in the detail hero; the detail page opens but offers no purchase; the server refuses a new order (`409 SALES_NOT_OPEN` / `EVENT_ENDED`) even for a signed-in client. ✅

**Purchase card ("Pilih tiket" / "Pesan tiket"):** stays in the existing right-hand column at `lg`+, in every other breakpoint too; **not sticky**, **not fixed**, does **not** follow the viewport (measured document-offset drift `0px` across 14 scroll steps); scrolls with the page and never overlaps another card or section. ✅

**Before coding:** audit + root causes reported. **After coding:** minimal, safe implementation with all four validation commands run, plus real-browser verification. **No commit, no push.** ✅
