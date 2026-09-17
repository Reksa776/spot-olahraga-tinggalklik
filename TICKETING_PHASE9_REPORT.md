# TICKETING PHASE 9 REPORT

**TinggalKlik.Co — UI/UX Redesign + Check-in Foundation**
Repository: `demo-marketplace` · branch `main` · 2026-09-17

---

## 1. Status

```
PHASE 9 STATUS: PASS WITH WARNINGS
```

Part A (discovery UI) and Part B (ticketing UI) are `IMPLEMENTED` and `VERIFIED` against real data
over HTTP. Part C (check-in foundation) is `BLOCKED` on unresolved decisions and nothing was
invented for it. The warnings in §21 are all pre-existing or documented limitations, none of which
invalidates an acceptance criterion.

---

## 2. Scope

`IMPLEMENTED` — the customer-facing experience, rebuilt as an event + sports discovery platform:

| Surface | Before | After |
| --- | --- | --- |
| `/` | Retail marketplace splash ("Marketplace Indonesia", fake "1Jt+ Produk" stat) | Discovery homepage: hero + search, real event count, sport grid with real counts, nearest / free-tier / newest sections, organiser CTA |
| `/events` | Search + sport chips + sort only | Full filter bar (search, sport, city, max price, date range, sort), shareable URL state, active-filter badge, empty states, pagination |
| `/e/{slug}` | Small banner over a text column | Full-bleed hero, metadata, sticky purchase card at `lg`+ and sticky bottom buy bar below it, gallery, important information, related events by sport |
| Checkout form | Plain inputs | Tier cards with steppers, min/max per order shown, display-only estimate, labelled buyer fields, brand CTA |
| `/ticketing/tickets` | Single flat list | Ticket-stub cards, Upcoming / All / Past views, per-ticket status badge, empty states |
| `/ticketing/tickets/{code}` | Plain detail box | Digital ticket: sport-tinted header, perforation, centred QR, code, holder (when set), order facts |
| `/ticketing/orders/{n}` | Status list | Three-status summary (Pesanan / Pembayaran / Tiket), countdown card, line items, totals, fulfilment block, clearer issued-ticket list |

`OUT OF SCOPE` (unchanged, verified): payment gateway, webhook, settlement, reservation semantics,
inventory CAS, issuance semantics, PIC attribution/fees, refunds, settlement/payout, email,
WhatsApp, coupons, spin wheel, marketing, guest checkout, retail checkout/order/payment.

---

## 3. UI audit before changes (`LOCKED` findings)

| Surface | Path | State found |
| --- | --- | --- |
| Root landing | `/` | Retail splash, rose palette, fabricated stat, links to `/login` + `/products` |
| Retail storefront | `/home` | Live, own chrome, untouched |
| Header | — | **None on any ticketing page.** `app/layout.tsx` renders only `children` + retail `Footer` |
| Catalog | `/events` | Working, plain; only search/sport/sort controls existed |
| Detail | `/e/[slug]` | Working, plain; purchase form in a small sidebar |
| Wallet / e-ticket / order | `/ticketing/*` | Working (Phase 8), plain |

**Server functions available for reuse (no new backend needed):** `listPublicEvents` (`q`, `sport`,
`city`, `dateFrom`, `dateTo`, `priceMax`, `hasTickets`, `sort` ∈ allow-list, `page`, `limit ≤ 50`),
`getPublicEventBySlug`, `listPublicSports`, `listOwnTickets`, `getOwnTicket`, `getOwnOrder`.

**Missing data that shaped the design:** the public payload carries **no ranking signal** (no views,
no sales rank), and the wallet/detail ticket projections carry **no event banner**. Both are handled
by omission, never fabrication — see §21 warning 6 and §20.

---

## 4. UI architecture

- **Shell**: one `SiteShell` (`SiteHeader` + `<main>` + `SiteFooter`) wraps all six ticketing pages.
  It is opt-in per page rather than in `app/layout.tsx`, because the retail storefront shares that
  root layout and must not gain ticketing chrome (`H1`, `H5` guards).
- **Server-first**: every page is a React Server Component. `force-dynamic` on `/`, `/events` and
  `/e/{slug}` matches the previous versions — availability (sold out, sales closed) is live state.
- **Filter state lives in the URL**: every filter control is a `GET` form or a `Link`; no client-side
  filtering, no `useState` filter mirror (`H2`).
- **One data path**: pages call the existing services; no page touches Prisma (`H3`).
- **Design tokens**: `ink-*` (deep navy) and `brand-*` (energetic orange) added additively in
  `app/globals.css`. No default Tailwind token is redefined, so retail is not repainted (`H6`).
- **No new dependency**: `qrcode.react` (already installed) is the only renderer used; no UI kit,
  icon pack, animation or state library is imported by any new file (`H7`).

---

## 5. Pages changed

| File | Change |
| --- | --- |
| `app/page.tsx` | `REPLACED` — discovery homepage (operator-approved: "Replace `/`"), keeps `<ReferralTracker/>` so retail affiliate attribution is not dropped |
| `app/events/page.tsx` | `REWRITTEN` (presentation) — same `listPublicEvents` + schema, all filters exposed |
| `app/e/[slug]/page.tsx` | `REWRITTEN` (presentation) — D-14 unavailable state preserved verbatim in meaning; added related events |
| `app/ticketing/tickets/page.tsx` | `REWRITTEN` (presentation) — three views, ticket cards |
| `app/ticketing/tickets/[ticketCode]/page.tsx` | `REWRITTEN` (presentation) — digital ticket |
| `app/ticketing/orders/[orderNumber]/page.tsx` | `REWRITTEN` (presentation) — three-status summary, fulfilment block |

All six retain their exact prior data sources, auth checks and `dynamic`/`metadata` exports.

---

## 6. Components created / modified

**Created (14) — `components/ticketing/`:** `Brand`, `SiteHeader`, `SiteFooter`, `SiteShell`,
`SearchBar`, `SectionHeader`, `EmptyState`, `SportGrid` (tile + chip variants), `EventRow`,
`StickyBuyBar`, `TicketCard`, `TicketStatusBadge`, `CatalogFilters`, `CatalogPagination`.

**Created (4 pure modules) — `lib/ticketing/ui/`:** `catalog-href.ts` (URL state),
`format.ts` (IDR/date/venue/sales-state formatting), `sport-tint.ts` (deterministic tint),
`wallet.ts` (views + time split).

**Redesigned in place (no duplicates):** `components/events/EventCard.tsx`,
`components/events/TicketPurchaseForm.tsx` (presentation only), `components/orders/PayNowButton.tsx`,
`components/orders/CancelOrderButton.tsx`, `components/orders/ReservationCountdown.tsx`,
`components/tickets/IssueTicketsButton.tsx`.

Zero duplicate primitives were introduced: the existing card, form and button components were
restyled rather than re-created (`H8` asserts every referenced component exists once).

---

## 7. Backend APIs consumed

`listPublicEvents`, `getPublicEventBySlug` (public catalog); `listOwnTickets`, `getOwnTicket`;
`getOwnOrder`; `POST /api/ticketing/checkout`; `POST /api/ticketing/orders/{n}/pay`;
`POST …/cancel`; `POST …/issue`; `GET/POST /api/auth/*` (session only).

**One additive backend change** — `countPublicEventsBySport()` in `lib/events/catalog.ts`
(`IMPLEMENTED`, read-only): a single `groupBy`-style aggregate over `Sport` reusing the existing
`publicVisibilityWhere`, so the sport grid can show a real per-sport count instead of a fabricated
one or none. It changes no existing query, payload or rule, and no `MIGRATION` is implied.
No route was added or altered: **142 route files, 142/142 classified** (§17).

---

## 8. Check-in foundation status

`BLOCKED` (correctly) — nothing operational was implemented.

The Phase 1 design does contain a check-in contract, and the Phase 2 schema already carries its
foundation, which was verified rather than assumed:

| Foundation piece | State |
| --- | --- |
| `CheckIn` model (table `checkin`) | `PRE-EXISTING` in `prisma/schema.prisma` |
| `StaffEventAssignment` model | `PRE-EXISTING` |
| `checkin.scan` / `checkin.override` / `checkin.log.read` | `PRE-EXISTING` in `lib/authz/permissions.ts` |
| `CHECKIN_STAFF` role mapped to those permissions | `PRE-EXISTING` |
| Validation order (§19.4), `UNAUTHORIZED`/403 rule, `TICKET_ALREADY_CHECKED_IN` | `LOCKED` in the design |
| **D-28** (block check-in for a ticket with an open refund request?) | **`DECISION REQUIRED`** — design row 3638 offers "block and warn the gate" as a *recommendation*, not a lock |
| Staff/support ticket-read override | **`DECISION REQUIRED`** — not resolved anywhere in the design |
| **D-46** (wallet QR mechanism) | **`DECISION REQUIRED`** |

Because a scan endpoint cannot be written without deciding the D-28 branch and the staff authority
model, Part C stops here per the brief ("STOP and report the exact decision required"; "do not
create fake check-in security"). What Phase 9 does contribute is proof that nothing was faked:
`H5` asserts no `/checkin`-matching route or module exists, no page or component references
`checkin.scan`, `checkin.override` or `StaffEventAssignment`, and the e-ticket contains **no
`<button>`** — it has no scanner, no "validate" action and no invented check-in state, only the
buyer-visible facts (`admission.scannable`, and `checkedInAt` when it is ever non-null).

---

## 9. D-46 status

`DECISION REQUIRED` — unchanged, and not silently resolved.

The e-ticket renders the QR with the repository's already-installed `qrcode.react` from a payload
**the server supplies**, following (a) the design's §26.6 alternative ("Render the QR server-side as
an image (no token reaches JS)" is listed alongside the short-lived-token option that D-46 defers)
and (b) the Phase 8 precedent, in which the payload is the ticket's **public code**, never the
scanner secret. `H4` pins this: the renderer takes `payload: string`, contains no `fetch`, no
`useEffect`, no `ticketCode`, no `qrToken`; the wallet page and its card mount no QR renderer at all;
and the e-ticket page never assembles a payload itself. When D-46 is locked, only the rendering
mechanism changes — the payload is already the server's decision, and the raw scanner token is still
never emitted by any endpoint.

---

## 10. Unresolved decisions (none guessed)

| ID | Subject | Phase 9 effect |
| --- | --- | --- |
| D-46 | Wallet QR display mechanism | `DECISION REQUIRED`, see §9 — repo precedent used, not a new decision |
| D-28 | Block check-in for refund-pending tickets | `DECISION REQUIRED` — blocks Part C |
| D-08 / D-39 | Pre-Phase-8 gate items | Untouched |
| D-01 / D-04 / D-06 | PIC attribution model / window / per-order-vs-line | Untouched — the UI shows no PIC concept at all |
| D-09 | Repayment pricing | Untouched — no reopen/repay affordance exists in the UI |
| D-20 | Settlement model | Untouched — no financial dashboard, no settlement UI |
| D-22 | Platform/PIC fee bearer | Untouched — the order page renders fee rows **only when non-zero**, so the zero-fee baseline is shown honestly and no fee is invented |
| D-26 | Free-ticket settlement | Untouched — a `priceMax=0` filter only makes free tiers *discoverable*; no zero-value order path, no free issuance, and the pay button still refuses via the server |
| D-33 | Guest checkout | Untouched — every purchase surface still resolves the session server-side |
| D-60 | TicketType name uniqueness | Untouched — no uniqueness rule added anywhere |
| D-61 | API money representation | Unchanged — money stays a decimal string end to end; `lib/ticketing/ui/format.ts` is the only place it becomes a display string, and it never writes back |

---

## 11. Security verification

| Check | Result |
| --- | --- |
| Anonymous `/ticketing/tickets`, `/ticketing/tickets/{code}`, `/ticketing/orders/{n}` | `307` → `/login` (HTTP-verified) |
| Other buyer (authenticated, no tickets) requesting buyer A's e-ticket | **404** |
| Other buyer requesting buyer A's order | **404** |
| Other buyer's wallet leaking buyer A's code | 0 occurrences; empty state rendered |
| Malformed ticket code | 404 (shape-checked before any query — observed when a hand-written fixture code was correctly rejected) |
| QR secret exposure | `qrToken` / `qrTokenHash` absent from every wallet, e-ticket and order response; asserted by `H4` and by the HTTP payload check (`TICKET:<code>` and nothing else) |
| Client-controlled price/total/ownership | None accepted: the purchase form sends `eventId`, `{ticketTypeId, quantity}` and contact fields only; its estimate is display-only |
| Payment truth from the URL | `H2` asserts no ticketing page reads `searchParams`, and none contains a `status=paid`-style check |
| `dangerouslySetInnerHTML`, secrets in UI | None (`H8`) |
| Retail isolation | No new file imports `@/components/products`, `@/lib/payment` or retail handlers (`H3`); none of `app/api/checkout/**`, `app/api/orders/**`, `app/api/payment/**`, `lib/payment/**` appears in `git status` |
| Ownership predicate | Unchanged — every private page still reads through `listOwnTickets` / `getOwnTicket` / `getOwnOrder`, which carry `holderUserId`/buyer predicates plus `ticket.read.own` |

---

## 12. Ownership / tenant verification

`VERIFIED` — structural, not re-implemented. Phase 9 changed no service, no query and no permission;
the wallet/e-ticket/order pages call the same ownership-scoped functions Phase 8 shipped. What was
re-verified is that the redesigned pages cannot widen that: no page accepts an identity field, none
uses `searchParams` for anything but catalog filters and the wallet's `view`, and the HTTP checks in
§11 were performed with two real sessions.

---

## 13. Responsive verification

Mobile-first class strategy, verified by construction and by markup inspection (no horizontal
overflow rules; horizontal scroll rows use `overflow-x-auto` with snap and a hidden scrollbar):

| Width | Evidence |
| --- | --- |
| 375 / 390 px | Header is brand + menu (`<details>`); search is a full-width primary action inside the page, not crammed into the sticky bar; card grids collapse to one column; ticket stub keeps its date block at 80px; sticky buy bar clears the home indicator via `pb-[max(0.75rem,env(safe-area-inset-bottom))]` |
| 768 px | Two-column card grids; filter panel two columns; ticket wallet two columns |
| 1024 px | Detail page becomes a 2+1 grid with a sticky purchase card; sticky buy bar hidden (`lg:hidden`); event rows stay scrollers |
| 1280 / 1440 px | 3–4 column grids; 7-column sport grid; `max-w-7xl` content width |

`WARNING: responsive behaviour was verified by markup and HTTP rendering, not by a visual browser at
each breakpoint` (see §14/§21).

---

## 14. HTTP / browser verification

Browser automation was **not** available. Verification was performed over HTTP against the running
dev server, with a real Auth.js credentials session and tagged fixtures (organizer, two published
events with tiers, a third event, a paid order with two issued tickets generated by the production
`generateTicketCode`/`generateQrToken`/`hashQrToken` helpers, and a second buyer), all removed
afterwards (§19).

```
GET /                              200   hero + "Event terdekat" + "Cabang olahraga" +
                                         "Ada tiket gratis" + "Baru ditambahkan" + organiser band;
                                         all 3 fixture events; real "3 event akan datang"
GET /events                        200   3 cards, "3 event ditemukan", "Mulai Rp…"
GET /events?q=Liga                 200   Liga present, "Lomba Lari" ABSENT, "Hasil untuk" shown
GET /events?priceMax=0             200   only the free-tier event; the 125.000 one excluded
GET /e/{slug}                      200   title, venue+city, "Reguler"/"VIP" + 75.000/250.000,
                                         "Pilih tiket", "Bagikan event", "Informasi penting",
                                         related "Event <sport> lainnya"
GET /ticketing/tickets             200   2 codes, "Aktif", tabs Akan datang/Semua/Sudah lewat;
                                         "TICKET:" 0 occurrences, "qrToken" 0 occurrences
GET /ticketing/tickets?view=past   200   upcoming ticket hidden, correct empty state
GET /ticketing/tickets?view=all    200   ticket present
GET /ticketing/tickets/{code}      200   QR <svg>, code, event, sport, order number,
                                         "Tunjukkan QR ini"; flight payload contains
                                         TICKET:<code> exactly; "checkin" 0 occurrences
GET /ticketing/orders/{n}          200   "Sudah dibayar" + "Lunas" + "Terbit (2)" + both codes
                                         + "Buka tiket saya"; total rendered from the Decimal string
other buyer → /ticketing/tickets/{A's code}   404
other buyer → /ticketing/orders/{A's order}   404
other buyer → /ticketing/tickets              200, empty, leaks nothing
anonymous → all three protected pages         307 → /login
```

The dev server was already running and recompiled the changed routes; no production build was
performed, and **no visual browser rendering was observed**.

---

## 15. TypeScript result

```
npx tsc --noEmit      exit 0, no output
```

---

## 16. Jest baseline vs final

| | Suites | Tests | Passed | Failed |
| --- | --- | --- | --- | --- |
| Baseline (Phase 8) | 55 | 1349 | 1347 | 2 |
| Final (Phase 9) | **60** | **1439** | **1437** | **2** |
| Phase 9 (new) | 5 | 90 | 90 | 0 |

Failing suites are **identical to the baseline** — the same six, and the same two failing tests
inside `__tests__/p0/remediation.integration.test.ts` (`B. Payout PAID consumes commissions`,
`E. Admin affiliate detail … chart clicks`). **Regressions: 0.** No test was skipped, weakened,
snapshotted away or removed.

Phase 9 suites (`__tests__/ticketing-ui/`), mapped to the brief's groups:

| Suite | Tests | Brief groups |
| --- | --- | --- |
| `catalog-url.test.ts` | 14 | filters preserve query state; URL state cannot express a server-rejected value |
| `display-format.test.ts` | 16 | IDR/schedule formatting, sales-state wording, deterministic sport tints, "display only" |
| `wallet-views.test.ts` | 9 | wallet only shows own tickets (view parsing is fail-closed); upcoming/past boundary |
| `discovery-render.test.ts` | 26 | catalog renders, detail renders, purchase form wired, e-ticket contains QR, QR payload shape, no credential in the list, honest empty/disabled states |
| `ui-wiring.test.ts` | 25 | shell wiring, no URL-derived authority, no direct DB/provider access, QR supplied by the server, **check-in not implemented**, tokens do not repaint retail, no UI framework added, no unsafe rendering |

---

## 16b. ESLint result

```
Baseline (before this phase's code changes):  512 problems (348 errors, 164 warnings)
Final  (after implementation):                512 problems (348 errors, 164 warnings)
New problems introduced by Phase 9:           0
```

Running ESLint over exactly the files this phase created or changed reports **5 problems (2 errors,
3 warnings)**: two `react-hooks/set-state-in-effect` errors in
`components/orders/ReservationCountdown.tsx` (lines inside the Phase 6 effect body — `setMounted` /
`setRemainingMs`; this phase changed only that component's returned JSX) and three warnings in the
existing order/handout components. Because the repository-wide total and its error/warning split are
**byte-identical to the pre-phase baseline**, none of these is newly introduced: had an edit added a
problem, the count would have risen. No unrelated legacy lint debt was touched.

---

## 17. Route classification

```
142 API route files · 142 classified · 0 unclassified
__tests__/authz/route-classification.test.ts  PASS (6/6)
```

Phase 9 added **no API route**, so the split is unchanged; the classification suite is green and was
re-run on its own to confirm.

---

## 18. Migration status

```
MIGRATION: NONE
npx prisma validate        The schema at prisma/schema.prisma is valid
npx prisma generate        OK
npx prisma migrate status  18 migrations found · "Database schema is up to date!"
```

`prisma/schema.prisma` was not modified, no historical migration was touched, `prisma db push` was
not run, and no migration file was created.

---

## 19. Database residue

Fixtures were tagged (`p9ui-*`) and removed after verification; the residue sweep reports:

```
tickets 0 · order items 0 · orders 0 · ticket types 0 · events 0 · venues 0
organizers 0 · users 0 · payments 0 · webhook events 0 · ticket.issue audits 0
ticket reservations 0
retail: products 5 (unchanged) · orders 149 (unchanged) · active sports 14 (seeded)
```

Two cleanup passes were needed and both are disclosed: the first fixture run failed mid-way on a
schema mismatch (a partial seed remained) and a second run used hand-written ticket codes that the
route's shape check correctly rejected — an earlier residue sweep removed the orphans from both, and
the final counts above are zero. No other phase's evidence was touched, and the temporary
verification script plus its fixture store were deleted (no `p9` files remain in `scripts/`).

---

## 20. Legacy safety verification

| Protected surface | Status |
| --- | --- |
| `app/api/checkout/**`, `app/api/orders/**`, `app/api/payment/**`, `lib/payment/**` | `UNTOUCHED` — absent from `git status` |
| Retail `Order` / `OrderItem` / `Product` / `ProductVariant` / `Flashsale` / cart / admin / marketing / affiliate / spin wheel / shipping | `UNTOUCHED` — no file appears in the phase's diff; no model renamed; no data migrated |
| `components/products/**`, `@/lib/payment`, retail handlers | `UNTOUCHED`; no new ticketing file imports any of them (`H3`) |
| Retail footer band | `PRE-EXISTING` file, one additive `data-global-footer` attribute so the discovery shell can suppress the second footer. No retail behaviour changes; on a browser without `:has()` support the footer simply renders as before |
| `app/globals.css` | Additive only: two new namespaced scales + two shadows + three utilities. No default Tailwind token is redefined (`H6`) |
| Historical migrations, git history | `UNTOUCHED` |

**Deliberate design decision worth recording:** the wallet and e-ticket were **not** given event
banner images. The wallet projection (`TICKET_WALLET_SELECT`) does not carry `bannerUrl`, and
widening it would have meant editing a Phase 8 payload that a security assertion pins (the detail
response is asserted to contain no URL at all). Rather than weaken that assertion, the ticket stub
uses a deterministic sport tint over the event date. The brief permits additive backend changes "if
absolutely required"; here the correct choice was to leave the closed Phase 8 contract alone.

---

## 21. Known warnings

1. **`DECISION REQUIRED` — D-46 (wallet QR mechanism).** Not resolved, not guessed; see §9.
2. **`WARNING` — the generated scanner token is still never emitted.** No delivery channel exists and
   §26.6 rejects browser-held tokens. Unchanged by this phase; Phase 10 must decide.
3. **`WARNING` — no visual browser verification.** The UI was type-checked and HTTP-rendered with
   real data and a real session (§14). Screenshot-level and breakpoint-by-breakpoint visual review
   was **not** performed; responsive behaviour is argued from markup and layout rules (§13).
4. **`WARNING` (pre-existing, not a Phase 9 regression) — the Phase 7 payment-creation race.** Eight
   concurrent "Pay" clicks can still create two provider sessions for one order, because
   `attemptNumber` comes from a non-atomic `count()+1`. `PayNowButton` was restyled only; the
   payment boundary is closed for this phase, so it is reported, not modified.
5. **`WARNING` — no job runner exists.** The reservation reaper mechanism remains unscheduled, as
   assigned by the design to another phase. Phase 9 did not add a scheduler, worker or timer.
6. **`WARNING` — no "Trending"/"Populer" section is claimed.** The public payload carries no ranking
   signal, so the homepage presents only the orderings that exist (date, creation) plus a real
   free-tier filter. This is a deliberate omission, not a missing feature.
7. **`WARNING` (pre-existing) — `tsconfig.tsbuildinfo` is a tracked build artifact** and shows as
   modified after any typecheck. Not part of this phase's edits.
8. **`NOTE` — `/ticketing/**` page protection comes from the page's own session check, not the
   proxy matcher.** `proxy.ts` lists `/ticketing` under `PROTECTED_PAGE_ROUTES` but its matcher does
   not cover `/ticketing/:path*`, so the middleware never runs there. Observed as a correct `307 →
   /login` over HTTP; left exactly as Phase 8 designed it, recorded here for Phase 10.

Remaining unresolved decisions (all `DECISION REQUIRED`, none touched): D-01, D-04, D-06, D-08,
D-09, D-20, D-22, D-26, D-28, D-33, D-39, D-46, D-60, D-61.

---

## 22. Files changed

**Created — 18 application files + 5 suites (≈2,826 lines incl. tests)**

```
components/ticketing/Brand.tsx                 components/ticketing/SiteHeader.tsx
components/ticketing/SiteFooter.tsx            components/ticketing/SiteShell.tsx
components/ticketing/SearchBar.tsx             components/ticketing/SectionHeader.tsx
components/ticketing/EmptyState.tsx            components/ticketing/SportGrid.tsx
components/ticketing/EventRow.tsx              components/ticketing/StickyBuyBar.tsx
components/ticketing/TicketCard.tsx            components/ticketing/TicketStatusBadge.tsx
components/ticketing/CatalogFilters.tsx        components/ticketing/CatalogPagination.tsx
lib/ticketing/ui/catalog-href.ts               lib/ticketing/ui/format.ts
lib/ticketing/ui/sport-tint.ts                 lib/ticketing/ui/wallet.ts
__tests__/ticketing-ui/catalog-url.test.ts     __tests__/ticketing-ui/display-format.test.ts
__tests__/ticketing-ui/wallet-views.test.ts    __tests__/ticketing-ui/discovery-render.test.ts
__tests__/ticketing-ui/ui-wiring.test.ts
```

**Modified — 14 files**

```
app/page.tsx                              app/events/page.tsx
app/e/[slug]/page.tsx                     app/ticketing/tickets/page.tsx
app/ticketing/tickets/[ticketCode]/page.tsx
app/ticketing/orders/[orderNumber]/page.tsx
components/events/EventCard.tsx           components/events/TicketPurchaseForm.tsx
components/orders/PayNowButton.tsx         components/orders/CancelOrderButton.tsx
components/orders/ReservationCountdown.tsx components/tickets/IssueTicketsButton.tsx
lib/events/catalog.ts                     jest.config.js
```

**Modified, shared/global (additive, disclosed in §20):** `app/globals.css` (tokens + utilities),
`components/Footer.tsx` (one `data-` attribute).

**Deleted:** the temporary verification tooling (`scripts/p9-ui-verify.ts`, `.p9fix.json`).

---

## 23. Files deliberately untouched

`prisma/schema.prisma` · `prisma/migrations/**` · `lib/payment/**` · `app/api/payment/**` ·
`app/api/checkout/**` · `app/api/orders/**` · `lib/ticketing/payment/**` ·
`lib/ticketing/inventory.ts` · `lib/ticketing/reservations.ts` · `lib/ticketing/tickets/issuance.ts`
· `lib/ticketing/tickets/service.ts` · `lib/ticketing/tickets/payload.ts` · `lib/ticketing/orders.ts`
· `lib/authz/**` · `proxy.ts` · `components/products/**` · `app/products/**` · `app/cart/**` ·
`app/orders/**` · `app/admin/**` · `app/home/page.tsx` · `app/affiliate/**`.

---

## 24. Next-phase dependencies

| Dependency | Needed by | Why |
| --- | --- | --- |
| **D-46** decision | Phase 10 (check-in / mobile) | Fixes the wallet QR display mechanism; today's choice follows repo precedent only |
| **D-28** decision | Phase 10 | Cannot write a scan endpoint without the refund-pending branch |
| Staff authority model (ticket read + assignment enforcement) | Phase 10 | `checkin.scan` and `StaffEventAssignment` exist, but who may read a ticket at the gate is unresolved |
| Scanner token delivery channel | Phase 10 | The raw token exists only as a hash and is never emitted |
| Phase 7 payment-creation race | any payment-touching phase | 8 concurrent Pay clicks can open two sessions; the fix belongs to the payment boundary |
| Reaper runner | Phase assigned by the design | The reservation-expiry mechanism is still unscheduled |

---

## 25. Final summary

Phase 9 delivered the customer-facing product: a discovery homepage backed entirely by the existing
public catalog, a filterable listing whose state lives in the URL, an event detail built around a
sticky purchase action, a ticket wallet and e-ticket that read as real credentials, and an order
page that separates order / payment / fulfilment status — all server-rendered, all from server data,
with no fabricated statistics, no new dependency and no new API route. The ticketing UI now looks
like an event and sports ticketing platform rather than a repainted retail storefront, which was the
phase's primary visual gate.

Part C was stopped rather than guessed: D-46, D-28 and the staff authority model are unresolved, so
no check-in endpoint, permission, credential or fake validation affordance was created — and a guard
test now proves none exists.

60 suites / 1439 tests / 1437 passing; the 2 failures are the pre-existing baseline pair. TypeScript
clean, ESLint identical to baseline (512 problems, 348 errors, 164 warnings), 142/142 routes
classified, `MIGRATION: NONE`, residue zero, retail untouched.

```
Commit:            NONE
Push:              NONE
History rewritten: NONE
```
