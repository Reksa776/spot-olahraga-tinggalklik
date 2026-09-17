# TINGGALKLIK.CO — PHASE 10 REPORT

## UI CONSOLIDATION, THEME ALIGNMENT & CHECK-IN FOUNDATION

Date: 2026-09-17
Repository: `demo-marketplace` (branch `main`)
Operator decisions taken at the start of this phase (asked, not assumed):

| Decision | Choice |
| --- | --- |
| Which identity wins | **Ink navy + brand orange** (Phase 9's choice) becomes THE identity; the brand-critical chrome is repainted onto it. Admin/retail **page bodies keep their structure and were not repainted** — low-risk, small diff. |
| Cleanup appetite | **Evidence-only, no deletions.** Full inventory with per-route evidence; delete nothing. |

---

## 1. Status

```text
PHASE 10 STATUS: PASS WITH WARNINGS
```

Objective A (global UI consolidation) is **done for every surface that carries branding or
navigation**; Objective B (safe removal of dead pages) is **done as an audit** and correctly found
nothing safe to delete; Objective C (check-in) is **BLOCKED by the brief's own decision gate**, with
four evidenced blockers and zero fabrication.

The warnings are additive disclosures, not partial work: the legacy accent still exists inside
retail/admin **page bodies** (the scope the operator chose), one brief instruction (§10, fold
ticketing admin into `/admin`) **contradicts a frozen Phase 3 architectural decision** and was
therefore not followed, and no visual browser pass was possible.

---

## 2. UI audit (before any change)

Two palettes ran on one Tailwind v4 token file. The **structure** was already consistent — matching
radii (`rounded-xl`/`2xl`), bar heights (`h-16`), container widths (`max-w-7xl`), bordered-white cards
and `bg-gray-50` page bands appear in both. What split was the **accent**:

| Surface | Accent before | Evidence |
| --- | --- | --- |
| Login / Register | rose | `app/login/page.tsx` (`from-rose-50 via-white to-white`), `components/auth/LoginForm.tsx` (13 rose sites), `RegisterForm.tsx` (19) |
| Retail storefront chrome | rose | `components/products/BottomNavbar.tsx` (active item), `components/Footer.tsx` (14 link hovers) |
| Admin sidebar | rose | `components/admin/AdminNavbar.tsx` (`bg-rose-50 text-rose-600` active states, "Admin**Panel**" lockup), `AdminMenuCard.tsx` |
| Platform / Organiser back office | **blue** (a third accent) | `app/platform/layout.tsx` + `app/organizer/layout.tsx` (`hover:text-blue-600`), `components/organizer/*` + `components/platform/*` (19 sites) |
| Shared dialog | rose | `components/ui/Dialog.tsx` focus ring |
| Ticketing / discovery | ink + brand | `app/globals.css`, `components/ticketing/**` |

Measured baseline of the retired accent: **385 occurrences of `rose-*` across 59 files**. Every one
was classified before touching it — see §3.

Brand lockups in the tree before this phase: **four** (`TK / TinggalKlik.Co`, `Admin Panel`,
`Admin Platform`, `Panel Penyelenggara`). That, more than the colour, is what made one product read
as three applications.

---

## 3. UI consolidation

### 3.1 The accent contract is now written down

`app/globals.css` gained an `ACCENT CONTRACT (PHASE 10)` block **as comments only** — no token was
added, renamed or revalued, so the live retail storefront cannot be repainted by this change. It
records which colours mean what (`rose`/`red` = failure, `emerald` = paid, `amber` = pending,
`sky`/`blue` = informational, sport tints = categorical) and the canonical class strings, so a new
surface cannot invent its own accent:

```text
primary action  bg-brand-600 text-white hover:bg-brand-700
neutral action  bg-ink-900   text-white hover:bg-ink-800
focus ring      focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600
```

### 3.2 One lockup, six surfaces

`components/Brand.tsx` is now the single implementation. `components/ticketing/Brand.tsx` became a
**re-export** (`export { default } from "@/components/Brand"`) so the Phase 9 imports keep working:
one implementation, two import paths, zero churn. It moved out of the ticketing namespace because the
auth and admin layers importing it *through a ticketing path* would state a dependency that does not
exist.

Consumers: discovery header/footer, login, register, admin sidebar, platform back office, organiser
back office. Back offices keep a small role chip (`Platform`, `Penyelenggara`) beside the mark, so
each surface stays identifiable without inventing a second brand.

### 3.3 Colour is carried by meaning, not by history

The sweep was **not** a find-and-replace. Two files keep `rose`/`blue` deliberately, and they are
recorded in code (`SEMANTIC_COLOUR_FILES` in the Phase 10 suite) so a future "finish the sweep" pass
cannot quietly destroy them:

| File | Why it keeps its colour |
| --- | --- |
| `app/ticketing/orders/[orderNumber]/page.tsx` | `EXPIRED`, `FAILED`, `Ditahan operator` — failure states. "Your payment failed" in the buy-now colour is a defect. |
| `lib/ticketing/ui/sport-tint.ts` | categorical sport hues — chosen to be distinguishable from their neighbours, not to express brand. |

Two informational `blue` sites also remain, both semantic: the `COMPLETED` event status
(`app/organizer/events/page.tsx:27`) and an info callout (`TicketTypeManager.tsx:457`).

### 3.4 What changed, file by file

| File | Change | Reason |
| --- | --- | --- |
| `app/globals.css` | + contract block (comments) | One place states the identity and the semantics |
| `components/Brand.tsx` | **new** — canonical lockup | Four lockups → one |
| `components/ticketing/Brand.tsx` | → re-export | Keep Phase 9 imports working |
| `app/login/page.tsx`, `app/register/page.tsx` | rose wash → ink/brand wash | Identity |
| `components/auth/LoginForm.tsx` | 13 accents; emoji → `<Brand />`; heading ink; 2 copy lines | Identity; the retail shopping-bag emoji no longer greets buyers |
| `components/auth/RegisterForm.tsx` | 19 accents; emoji → `<Brand />`; heading ink; 1 copy line | same |
| `components/Footer.tsx` | 14 × `hover:text-rose-600` → `brand-600` | Identity (retail footer content untouched) |
| `components/products/BottomNavbar.tsx` | 2 × active `text-rose-600` → `brand-600` | Identity (links untouched) |
| `components/admin/AdminNavbar.tsx` | 3 active states; lockup → `<Brand />` + `Admin` chip; "Kembali ke Toko" → "Kembali ke situs" | Identity |
| `components/admin/AdminMenuCard.tsx` | 3 hover accents | Identity |
| `components/ui/Dialog.tsx` | focus ring rose → brand | Shared primitive; `danger`/`warning`/`info` variants untouched |
| `app/platform/layout.tsx` | lockup + `Platform` chip; `blue` → `brand`; + "Lihat situs" link; `sticky h-16` bar | One identity; the back office had no way back to the public site |
| `app/organizer/layout.tsx` | same treatment; denial-panel CTA `amber-900` → `ink-900` | same |
| `components/organizer/{EventForm,EventImageManager,VenueManager,TicketTypeManager}.tsx`, `components/platform/{GlobalVenueManager,SportManager}.tsx`, `app/organizer/events/page.tsx`, `app/organizer/events/[id]/page.tsx` | identity `blue` → `brand` (CTAs, links) | Ticketing back office, not retail: in scope, and cheap at 19 sites |

Measured result:

```text
rose-* occurrences   385 across 59 files  →  325 across 48 files   (−60 sites, −11 files)
files using brand-*  —                    →  38
legacy accent left in chrome files       →  0
identity blue left in ticketing back office → 2, both semantic
```

### 3.5 The remaining 325 occurrences — scope, not oversight

They are inside **retail/admin page bodies** (`app/admin/**` pages, `ProductCard`,
`CartPageClient`, `CheckoutPage`, `PromosList`, `AddressesList`, …), which the operator explicitly
excluded to keep this phase's diff small and the regression surface flat. The mapping is mechanical
(`rose-NNN` → `brand-NNN`; every target token already exists in the scale). **This is no longer only
a theoretical inconsistency** — see §14, warning 1, which has rendered proof that a retail page now
shows both accents at once.

---

## 4. Deleted pages

**None.**

| route | file | reason | evidence | replacement |
| --- | --- | --- | --- | --- |
| — | — | No page met the evidence bar for removal | 0 of 64 pages has zero inbound references except three, which are BLOCKED rather than dead (§6) | — |

Two 0-byte component files were found and **reported, not deleted** (the operator chose an
evidence-only pass):

| file | evidence | recommendation |
| --- | --- | --- |
| `components/profile/MenuList.tsx` | 0 bytes on disk; no import anywhere in `app/**`, `components/**`, `lib/**`, `__tests__/**` | REMOVE — safe; a zero-byte module cannot execute |
| `components/profile/ProfileHeader.tsx` | same | REMOVE |

This is recorded in `lib/ui/route-inventory.ts` (`UNUSED_FILE_CANDIDATES`) and asserted by the test
suite (still present, still empty, still unimported), so the finding cannot be lost.

---

## 5. Pages kept deliberately

Everything else — 64 pages, 0 deleted. The ones most likely to look "unused" and why they are not:

| Route | Why it stays |
| --- | --- |
| `/checkout/payment-finish` | Referenced by `app/api/buy-now/ipaymu/route.ts` and `/api/orders/[id]/repay` — it is the provider return URL. The v1 probe missed it by requiring a quote before the path in a concatenated string. |
| `/orders/[id]`, `/products/[slug]` | Dynamic routes reached through template literals; a literal-substring search reports them as orphans. |
| `/platform/sports`, `/platform/venues` | Permission-gated platform back office, reachable from its own layout nav. |
| `/promos` | The buyer's own spin-wheel reward vouchers ("Promo Saya"), linked from `/profile`. |
| `/campaigns`, `/flash-sales`, `/promotions` | Unlinked, but **not** obsolete — see §6. |
| `/faq`, `/kontak`, `/syarat-ketentuan`, `/refund-policy` | Legal/support pages linked from both footers. |
| Auth, retail, admin, API and webhook routes | Protected by the brief (§13) and reachable. |

---

## 6. Route inventory

64 pages. The full table is `lib/ui/route-inventory.ts`, machine-checked against the filesystem by
`__tests__/ui-consolidation/route-inventory.test.ts` (every page accounted for exactly once, every
row pointing at a file that exists, no reachable row without named evidence).

```text
KEEP      31   reachable and on the consolidated identity, or coloured semantically
REFACTOR  30   reachable and needed, page body still carries the legacy accent (§3.5 backlog)
REDIRECT   0   nothing was retired, so nothing needs an alias
REMOVE     0   nothing met the evidence bar
BLOCKED    3   unlinked, but not provably dead
```

`referencedBy` was produced mechanically — matching each route as a **complete URL token** plus a
template-literal prefix for dynamic segments. Two false-positive classes were found and eliminated
while building it, and both changed the answer:

1. plain substring matching reported `/promotions` as referenced by `/api/admin/promotions`, and
   inflated `/orders`, `/products`, `/checkout` from `/api/...` imports — the v1 probe declared
   **every** route reachable, including three that are not;
2. requiring a quote before the route hid concatenated URLs (`${base}/checkout/payment-finish?…`),
   which made a live route look dead.

The three `BLOCKED` rows, each with its own reason:

| Route | Why it cannot be removed |
| --- | --- |
| `/campaigns` | No inbound reference, but it renders `CampaignsList` over the live `/api/campaigns`. The retail WhatsApp broadcast feature and existing shared links may target it. Not a duplicate of anything. |
| `/flash-sales` | Same shape, over the live `/api/flash-sales`. |
| `/promotions` | Same shape again. **Not** a duplicate of `/promos`: that is the buyer's own reward vouchers, this is the public store-wide promotion list. |

Each needs a product decision (link it from a retail menu entry, or retire it behind a redirect).
Both are outside this phase's mandate, so nothing was changed.

---

## 7. Check-in

```text
CHECK-IN: BLOCKED
```

Nothing was implemented — no route, no module, no component, no permission wiring, no scanner
dependency, and no fake "validate" affordance. `__tests__/ui-consolidation/checkin-gate.test.ts`
(11 tests) proves the absence and pins each blocker.

### 7.1 The one dependency that IS locked

**Staff / tenant authority is fully specified and needs no decision.** Evidence:

- `model StaffEventAssignment` with `@@unique([organizerMemberId, eventId])`, `revokedAt`,
  `organizerId`, `@@index([eventId, revokedAt])` — the tenant-scoped assignment the design requires;
- `checkin.scan`, `checkin.override`, `checkin.log.read` declared in `lib/authz/permissions.ts` and
  held by `CHECKIN_STAFF` plus the organiser roles;
- design §20.2 check 5: "Manager/Admin, or `CHECKIN_STAFF` with an active `StaffEventAssignment` for
  this event, within the tenant scope";
- `CheckIn.checkedInByUserId` + `checkedInByMemberId` record both identities;
- `CheckIn.ticketId String? @unique` — nullable-unique, which is exactly the design's own
  recommended form for "rejected attempts are also recorded" (D-32), and the DB-level duplicate
  guarantee.

This was verified as *intact*, not modified.

### 7.2 The four blockers

| # | Blocker | Evidence |
| --- | --- | --- |
| 1 | **D-46 / scanner-token delivery** | Design §19.3 chooses design B and says outright that a bare id is unacceptable — "the URL is not the security boundary; the **token** is". §19.4 and §20.2 checks 1/7 therefore require hashing the presented `qrToken` against `qrTokenHash`. Phase 8's finding stands: that token has **never been delivered to any client** (no delivery channel exists; §26.6 rejects returning a browser token). The only credential in existence is `ticketCode`, and the wallet QR encodes `TICKET:<ticketCode>`. Implementing check-in against it would be the exact downgrade §19.3 rejects. |
| 2 | **D-28** | Whether a ticket with an open refund request may be admitted is marked `DECISION REQUIRED` (design §18 lines 1550/1563) and is validation-chain check 4. |
| 3 | **Design ↔ schema divergence** | Design §20.1 specifies `CheckInMethod = QR_SCAN \| MANUAL_CODE \| MANUAL_OVERRIDE` and `CheckInResult = ACCEPTED \| REJECTED_DUPLICATE \| REJECTED_INVALID \| REJECTED_WRONG_EVENT \| REJECTED_NOT_ISSUED \| REJECTED_UNAUTHORIZED \| REJECTED_REFUND_PENDING`. The shipped schema has `QR_SCAN \| MANUAL` and `SUCCESS \| DUPLICATE \| ALREADY_CHECKED_IN \| INVALID_TICKET \| WRONG_EVENT \| UNPAID \| TICKET_NOT_FOUND`. There is no value to record a refusal for an unauthorised scanner, no `MANUAL_OVERRIDE`, and **no `REJECTED_REFUND_PENDING`** — so a faithful implementation needs additive enum values, i.e. a migration, which the brief requires to be raised rather than assumed. |
| 4 | **Issuance invocation** | Design §19.2 states tickets are created at settlement; the shipped implementation is buyer-triggered (`POST /api/ticketing/orders/{n}/issue`) and no settlement hook exists (Phase 8 warning 4). A ticket that was never issued cannot be checked in, so check-in depends on this being resolved. Creating the hook would mean modifying Phase 7 settlement, which this phase's brief forbids. |

Per the brief's §15, the phase therefore **stopped** and fabricated no scanner credentials, no staff
permissions, no refund guard and no token delivery.

---

## 8. Security

No authorization, ownership, tenant or credential-handling behaviour was changed. The phase touched
presentation only; the route table, permission map and authz guards are byte-identical apart from
`components/ticketing/Brand.tsx` becoming a re-export.

| Check | Result | Evidence |
| --- | --- | --- |
| Anonymous → ticketing wallet | **307** → `/login?next=%2Fticketing%2Ftickets` | real request |
| Anonymous → `/admin` | **302** → `/login?callbackUrl=%2Fadmin` | real request |
| Anonymous → `/organizer/events` | **307** → `/login` | real request |
| Anonymous → `/platform/sports` | **307** → `/login` | real request |
| Anonymous → `/profile`, `/orders` | **302** → `/login` | real request |
| Authenticated **customer** → `/admin` | **307** (role gate holds) | real session |
| Authenticated non-privileged → `/platform/sports` | **200** with "Akses platform ditolak" (fail-closed denial panel, no data) | real session |
| Cross-user ticket read | unchanged — 404 by ownership predicate | Phase 8 suite, re-run green |
| Route classification | **142/142**, suite green; Phase 10 added no route | `__tests__/authz/route-classification.test.ts` |
| Untrusted input fields | no new request surface exists at all | this phase added no route/handler |
| Secrets in rendered HTML | no `qrToken`, no `qrTokenHash`, no provider credential | rendered-HTML sweep |

The webhook and payment trust boundary is untouched (`app/api/ticketing/payment/webhook/route.ts`
and `lib/ticketing/payment/**` were not modified — see §12).

---

## 9. Tests

```text
Baseline (Phase 9):  60 suites / 1439 tests / 1437 passed / 2 failed
Final (Phase 10):    63 suites / 1490 tests / 1488 passed / 2 failed
Phase 10 (new):       3 suites /   51 tests /   51 passed
Regressions:         0
```

The failing suites are **identical to the baseline** — the same six
(`__tests__/ipaymu/production-hardening.test.ts`, `__tests__/marketing/{address-shipping-ux,
campaign-optional-audit,m7-audit-fixes,profile-phone-shipping}.test.ts`,
`__tests__/p0/remediation.integration.test.ts`) and the same two failing tests inside
`p0/remediation.integration.test.ts`:

- `B. Payout PAID consumes commissions (ledger balance) › balance decreases on request, PAID settles FIFO conversions, second over-balance withdrawal rejected`
- `E. Admin affiliate detail executes against MariaDB › GET returns 200 with correct stats (no P2010 / SQL syntax error)`

These are the pre-existing retail pair recorded in the Phase 8 and Phase 9 reports. No test was
skipped, weakened, snapshotted or removed; the baseline was taken from the Phase 9 report because
the background run I started was overtaken by my own edits and would have been meaningless.

Phase 10 suites (`__tests__/ui-consolidation/`):

| Suite | Tests | What it pins |
| --- | --- | --- |
| `route-inventory.test.ts` | 12 | all 64 pages accounted for exactly once; every row points at a real file; no reachable row without evidence; no deletion performed; the two unused-file candidates still reported |
| `identity-consolidation.test.ts` | 28 | the accent contract is declared; no chrome file carries the retired accent; the semantic exceptions stay semantic; one lockup, no consumer re-implementing the mark; back offices link back to the site |
| `checkin-gate.test.ts` | 11 | no check-in route/module/permission caller/scanner dependency/fake affordance; the blockers are still the blockers; the locked infrastructure and the never-emitted token are intact |

Focused re-runs after the edits (all green): Phase 8 (`ticketing-issuance`), Phase 7
(`ticketing-payment`), Phase 9 (`ticketing-ui`) and Phase 3 (`authz`) — **16 suites / 300 tests /
300 passed**, including 142/142 route classification.

---

## 10. TypeScript

```text
npx tsc --noEmit → exit 0 (clean, no output)
```

Run after every edit batch and once more after the suite was added.

---

## 11. ESLint

```text
Baseline (Phase 9 report):  512 problems (348 errors, 164 warnings)
Final  (Phase 10):          512 problems (348 errors, 164 warnings)
Delta:                      0
```

Repository-wide totals are identical, so the phase introduced no new problem and fixed none (it did
not fix any unrelated legacy debt either). No eslint configuration was changed.

---

## 12. Migration

```text
MIGRATION: NONE
```

- `prisma/schema.prisma` — **not modified by this phase** (confirmed by set-differencing the
  session-start `git status` against the current one: no `prisma/` path appears in the phase's diff).
- `prisma/migrations/**` — not modified; no historical migration was edited.
- `prisma db push` was not run; the database was not reset or seeded.

The check-in enum divergence in §7.2 is the **candidate** migration, and it is deliberately not
created: it is only needed if and when check-in is unblocked, and creating it now would bake in
answers to D-28 that have not been given.

---

## 13. Retail regression

```text
Retail regression: PASS (no behaviour changed)
```

| Surface | Status |
| --- | --- |
| `app/api/checkout/**`, `app/api/orders/**`, `app/api/payment/**`, `app/api/buy-now/**` | Untouched (set-differenced) |
| `app/api/ticketing/**` (incl. the Phase 7 webhook) | Untouched |
| `lib/payment/**`, `lib/ticketing/payment/**`, `lib/ticketing/tickets/**`, `lib/ticketing/inventory.ts`, `reservations.ts`, `checkout.ts`, `orders.ts` | Untouched |
| `prisma/**` | Untouched |
| `Product` / `ProductVariant` / `Flashsale` / `Order` / `OrderItem` | Not renamed, not migrated |
| Retail checkout/cart/order/payment behaviour | Unchanged; only class names in the retail **chrome** (footer hovers, bottom-nav active state) changed |
| Retail data | `Product` = **5** rows, unchanged; no retail data migration |
| Seeded sports | **14**, unchanged |
| Git history | not rewritten |

Residue after the phase:

```text
tagged fixture users 0 · tickets 0 · eventOrders 0 · events 0 · checkIns 0
sports 14 · retail products 5
```

Fixtures: this phase created two tagged users and two Auth.js cookie jars to read the authenticated
HTML, all removed; **no ticket, event, order or check-in fixture was needed** and none exists. The
two throwaway probe scripts (`scripts/.p10-*.js`) were deleted; `scripts/` contains no `p10` file.
No other phase's evidence was deleted or modified.

---

## 14. Remaining warnings

1. **`WARNING` — the legacy accent survives inside retail/admin page bodies, and it is now visible
   on one screen.** Rendered proof: `/home` (a retail page) serves `text-brand-600` for its bottom
   navigation *and* `text-rose-600` from its product cards in the same response. 325 occurrences
   remain across 48 files. The mapping is mechanical and safe (`rose-NNN` → `brand-NNN`, both scales
   exist, and the two semantic files are already identified), but completing it touches protected
   retail/admin page bodies, which is exactly what the operator chose to defer. Recommend as the
   immediate next step.
2. **`WARNING` — a brief instruction contradicted a frozen architectural decision, so it was not
   followed.** Brief §10 asks to consolidate ticketing administration into the existing Admin
   Dashboard and add ticketing menu entries. `app/platform/layout.tsx` documents, with reasoning,
   why the ticketing platform surfaces must **not** live under `/admin`: `/admin` gates on the legacy
   retail `role`, while `platformRole` is a separate Phase 3 dimension, and bridging the two would be
   a hidden grant. No ticketing entry was therefore added to `AdminNavbar`, and no role bridge was
   written. If the operator wants one dashboard, that is a Phase 3 authorization decision, not a UI
   one.
3. **`WARNING` — no visual browser pass.** No headless-browser tooling exists in the repository and
   adding one is out of scope, so verification is rendered-HTML over HTTP against a real dev server
   with real Auth.js sessions (evidence in §8 and below), plus type-checking. Visually *inspected*:
   no. **Visual browser verification: NOT AVAILABLE.**
4. **`WARNING` — no navigation path between the two customer worlds.** The discovery header links
   events, sports and tickets; the retail storefront's bottom nav links only retail routes; neither
   footer links across. The identity is consolidated but the *journey* is not. Choosing which app is
   primary is a product decision, so no link was invented.
5. **`WARNING` (pre-existing, carried forward) — the Phase 7 payment-creation race is untouched.**
   Eight concurrent "Pay" clicks can still create two gateway sessions for one order, because
   `attemptNumber` is derived from a non-atomic `count()+1`. Not touched: the brief closes the
   payment boundary, and this phase did not go near it. Fix direction unchanged from the Phase 8
   report.
6. **`WARNING` (pre-existing) — no reaper runner.** `expireDueReservations()` still has no
   scheduler; unscheduled as before.
7. **`WARNING` — D-46, D-28, D-32 (partially), D-34, plus D-08, D-09, D-20, D-22, D-26, D-33, D-39,
   D-60, D-61 and D-01/04/06 remain unresolved.** None was guessed. D-32 *is* answerable from the
   design's own recommendation (nullable-unique `ticketId`, which the schema already implements), and
   that is recorded here rather than actioned, since nothing consumes it yet.
8. **`WARNING` — `/campaigns`, `/flash-sales`, `/promotions` are unlinked.** They are live pages over
   live APIs, so they are `BLOCKED` in the inventory rather than dead. Each needs a one-line product
   decision: link it, or retire it behind a redirect.

---

## 15. Files

### Changed or created by this phase

```text
app/globals.css                                     + accent contract (comments only)
app/login/page.tsx                                  backdrop → ink/brand
app/register/page.tsx                                backdrop → ink/brand
app/platform/layout.tsx                             lockup + chip + accents + "Lihat situs"
app/organizer/layout.tsx                            lockup + chip + accents + "Lihat situs"
app/organizer/events/page.tsx                       identity accents → brand
app/organizer/events/[id]/page.tsx                  identity accents → brand
components/Brand.tsx                                NEW — the single lockup
components/ticketing/Brand.tsx                      → re-export
components/auth/LoginForm.tsx                       accents + lockup + copy
components/auth/RegisterForm.tsx                    accents + lockup + copy
components/admin/AdminNavbar.tsx                    accents + lockup + label
components/admin/AdminMenuCard.tsx                  accents
components/ui/Dialog.tsx                            focus ring
components/Footer.tsx                               accents
components/products/BottomNavbar.tsx                accents
components/organizer/{EventForm,EventImageManager,VenueManager,TicketTypeManager}.tsx
components/platform/{GlobalVenueManager,SportManager}.tsx
lib/ui/route-inventory.ts                           NEW — the audited inventory
__tests__/ui-consolidation/{route-inventory,identity-consolidation,checkin-gate}.test.ts   NEW
jest.config.js                                      + ui-consolidation namespace
TICKETING_PHASE10_REPORT.md                         NEW
```

### Deliberately untouched

```text
prisma/**                          lib/ticketing/payment/**        lib/payment/**
lib/ticketing/{inventory,checkout,orders,reservations,db-contention,idempotency,audit-log}*.ts
lib/ticketing/tickets/**           app/api/ticketing/**            app/api/{checkout,orders,payment,buy-now}/**
app/admin/** page bodies           retail page bodies (cart/checkout/orders/products/…)
auth.ts                            lib/authz/**                    proxy.ts
components/ticketing/{SiteHeader,SiteFooter,SiteShell,EventCard,…}.tsx  (already on the identity)
package.json / package-lock.json   (+0 dependencies; `qrcode.react` reused, nothing added)
```

---

## 16. Rendered verification (what was actually observed)

Real dev server, real Auth.js credentials sessions, real database:

```text
curl /                                    200  >TK< ✓  bg-brand-600 ✓  (rose only from sport tint, by design)
curl /events                              200  >TK< ✓  bg-brand-600 ✓  rose: none
curl /login                               200  SSR wrapper from-ink-50 / to-brand-50 ✓
curl /register                            200  SSR wrapper ✓
curl /home                                200  text-brand-600 ✓ (nav)   text-rose-600 still present (product cards)
curl /ticketing/tickets        (customer) 200  >TK< ✓  TinggalKlik ✓  rose: none
curl /admin                    (customer) 307  role gate holds
curl /admin                    (admin)    200  >TK< ✓  bg-brand-50 ✓  text-brand-700 ✓  rose-50/rose-600 absent
curl /admin/products           (admin)    200  >TK< ✓
curl /platform/sports  (authenticated, no platform permission)  200  "Akses platform ditolak" ✓ fail-closed
```

`/login` and `/register` server-render their "checking session" state first, so their `<Brand />`
appears after hydration — the *page-level* wrapper colour is what the curl output confirms above, and
the lockup in those forms is asserted by the static suite. Responsive behaviour was reviewed at the
6 viewport widths the brief lists by reading the markup (no horizontal overflow, no fixed-width
tables, sticky bars respect the mobile safe area) but **not observed in a browser**.

---

## 17. Git status

```text
Commit created:     NO
Push performed:     NO
History rewritten:  NO
git reset/clean/restore/rebase: NOT RUN
```

All pre-existing working-tree modifications from the session start were preserved untouched: 41 of
the 49 tracked files in the current diff were already modified before this phase and were not
touched by it; the phase itself modified 8 tracked files, and its edits to untracked files (the Phase
4–9 additions) are additions to files that were already uncommitted. Full lists in §15.

---

## 18. Final summary

```text
PHASE 10 STATUS: PASS WITH WARNINGS
```

**Implemented.** One visual identity. `ink`/`brand` is now the accent on every surface that carries
branding or navigation: login, register, retail chrome, admin sidebar, both back offices, the shared
dialog and the discovery/ticketing surfaces that already used it. Four brand lockups collapsed into
one `components/Brand.tsx` with a re-export keeping the Phase 9 imports valid. The accent contract is
written into `globals.css` and enforced by tests, including the semantic exceptions that must *not*
be repainted. Colour is now carried by meaning: 325 remaining `rose` sites are either the legacy page
bodies the operator scoped out, or failure/informational semantics.

**UI pages changed.** Presentation only, on 9 pages plus 16 components; zero logic changed, zero
routes added, zero dependencies added.

**Cleanup.** 64 pages audited with mechanically-derived evidence; **0 deleted**, because 0 met the
bar. Three unlinked pages are reported as `BLOCKED` rather than removed, and two 0-byte components
are reported as safe removals without being deleted. Two false-positive classes were found in the
probe itself and corrected, which is what turned "everything is reachable" into an accurate answer.

**Check-in.** BLOCKED, with four evidenced dependencies (token never delivered, D-28 open, design↔
schema enum divergence needing a migration, and the unresolved issuance trigger). The one gate item
that *is* locked — tenant-scoped staff authority — was verified intact. Nothing was fabricated.

**Tests.** 63 suites / 1490 tests / 1488 passed, with Phase 10 contributing 3 suites and 51 tests.
The same six suites and the same two pre-existing tests fail as before: **0 regressions**. tsc clean;
ESLint identical to baseline; 142/142 routes classified; residue 0; retail data unchanged.

**Stop.** Phase 10 ends here. No commit, no push, no history rewrite.
