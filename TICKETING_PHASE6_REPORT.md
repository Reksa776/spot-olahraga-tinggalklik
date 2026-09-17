# TICKETING PHASE 6 REPORT

## 1. Status

```text
PHASE 6 STATUS: PASS WITH WARNINGS
```

Not PASS, because three items are genuinely outstanding and none of them is mine to
decide: the design's pre-Phase-6 decision register (`D-01`, `D-04`, `D-06`, `D-09`,
`D-22`, `D-26`, `D-33`, `D-61`) is still formally open (§4 below records exactly how each
was avoided rather than guessed), the expiry reaper has a mechanism but no runner, and
one Phase 5 reporting wart was found (`released` can over-report).

Nothing in Phase 6 is blocked, and no acceptance criterion that this phase owns is
unmet.

## 2. Scope implemented

| Item | Status |
| --- | --- |
| `TicketReservation` lifecycle (create / release / confirm-consuming / expire) | IMPLEMENTED |
| Reservation TTL from `PlatformSetting.reservationTtlMinutes` | IMPLEMENTED |
| Reservation ownership | IMPLEMENTED |
| Quantity rules `minPerOrder` / `maxPerOrder` / event `maxTicketsPerOrder` | IMPLEMENTED |
| Sales-window + inactive + sold-out gating | IMPLEMENTED |
| Atomic reservation through the Phase 5 primitives | IMPLEMENTED |
| `EventOrder` / `EventOrderItem` creation (payment-ready) | IMPLEMENTED |
| Server-side price + total derivation with price snapshot | IMPLEMENTED |
| Multi-ticket-type cart (§11.3) with all-or-nothing rollback | IMPLEMENTED |
| Checkout idempotency (`Idempotency-Key`, §25.5/§30.1) | IMPLEMENTED |
| Customer order read + cancel (ownership-scoped) | IMPLEMENTED |
| Customer UI: purchase form, order confirmation, countdown, cancel | IMPLEMENTED |
| Tests, route classification, audit logging, report | IMPLEMENTED |

`MIGRATION: NONE` — see §7.

## 3. Business decisions consumed (all LOCKED in the design)

| Ref | Decision as implemented | Where |
| --- | --- | --- |
| §11.2 | Reservation row + counter change in ONE transaction; `reserveQuota` conditional `UPDATE` as the only availability gate | `lib/ticketing/reservations.ts`, `lib/ticketing/checkout.ts` |
| §11.2 | Transitions: reserve → `reserved += n`; confirm → `reserved -= n`, `sold += n`; release → `reserved -= n` | `lib/ticketing/inventory.ts` (Phase 5) |
| §11.4 | TTL = `PlatformSetting.reservationTtlMinutes` (default **30**), one TTL per order applied to every reservation and to the order's own payment window | `resolveReservationTtlMinutes()` |
| §11.3 | Multi-ticket-type cart supported; lines merged per type, processed **ascending by `ticketTypeId`**, any failure rolls the whole transaction back and the response is `SOLD_OUT` **naming the type** | `lib/ticketing/checkout.ts` |
| §12.1 | Pre-payment state: `EventOrder.status = PENDING_PAYMENT`, `paymentStatus = UNPAID`, no `Payment` row; `paymentUrl: null` | `lib/ticketing/checkout.ts`, `lib/ticketing/order-payload.ts` |
| §12.3 | Anti-resurrection: cancellation and expiry both CAS on `status = PENDING_PAYMENT`, so `EXPIRED → CANCELLED` (and `→ PAID`) is refused | `lib/ticketing/orders.ts`, `lib/ticketing/reservations.ts` |
| §17.2 | Pricing is server-side; MVP `discount = platformFee = picFeeTotal = 0`; currency IDR; fees stay zero until configured (D-11) | `lib/ticketing/checkout.ts` |
| §25.5 | Request body is exactly `{ eventId, items[{ticketTypeId, quantity}], buyerName, buyerEmail, buyerPhone, couponCode?, shareToken? }` — no prices, no totals, no `organizerId` | `lib/ticketing/checkout-validation.ts` |
| §25.5 / §30.1 | `Idempotency-Key` header is **required**; unique `(userId, scope, key)`; `requestHash` mismatch → `409 CONFLICT` | `lib/ticketing/idempotency.ts` |
| §26.4 | Cancel allowed only while `PENDING_PAYMENT`; releases reservations; a paid order cannot be cancelled | `lib/ticketing/orders.ts` |
| §10.5 | Availability is `quota - sold - reserved` (unclamped) with a clamped variant for display | `lib/ticketing/inventory.ts`, `lib/events/sales-state.ts` |
| §36.5 | Money serialized as fixed-2dp **strings**, never JSON numbers | `lib/ticketing/order-payload.ts` |

The reservation enum in the schema is `HELD | CONVERTED | RELEASED | EXPIRED` — the
design's prose says "CONFIRMED" in places, but the **schema is the vocabulary** and
`CONVERTED` is what is used (`RESERVATION_INITIAL_STATUS = "HELD"` has exactly one
definition).

## 4. Unresolved decisions — recorded, never guessed

The design's §39.3 register requires these **before Phase 6**. They are not implemented
decisions; each is handled so that Phase 6 does not depend on the answer.

| Ref | What is open | How Phase 6 avoided deciding it | Classification |
| --- | --- | --- | --- |
| **D-01** | PIC tracking-link model | PIC attribution is explicitly **out of scope** for Phase 6. No `PICAttribution` row is created and no link model is assumed. A `shareToken` is accepted as an **inert** hint that nothing resolves. | DECISION REQUIRED + OUT OF SCOPE |
| **D-04** | Attribution window / first-vs-last click | Same: no click, cookie or window logic exists in Phase 6. | DECISION REQUIRED + OUT OF SCOPE |
| **D-06** | Attribution per order vs per line | Observable consequence only of D-01/D-04. Not encoded. | DECISION REQUIRED + OUT OF SCOPE |
| **D-09** | Repay a `CANCELLED`/`EXPIRED` order at the old price or re-price | Repayment does not exist in Phase 6. No re-pricing path, no "reopen" transition. | DECISION REQUIRED (payment phase) |
| **D-22** | Who bears the platform/PIC fee | The totals are the **zero-fee baseline**: `platformFee = 0`, `total = subtotal`, `organizerNetAmount = total`. This encodes *neither* policy — "absorbed" would reduce the organizer net, "passed on" would raise the buyer total, and BOTH remain reachable with no migration because every field already exists. | DECISION REQUIRED (WARNING) |
| **D-26** | Free (zero-price) ticket types | A zero-price type is purchasable and produces a `0.00` order in `PENDING_PAYMENT`; **no** `FREE` settlement path was invented. Deciding it means choosing a settlement route, which is a payment-phase decision. | DECISION REQUIRED (payment phase) |
| **D-33** | Guest checkout vs account required | **No guess was needed**: §25.5 states the endpoint's contract as "Auth: **Required** (customer session)", and the register recommends account-required. The route calls `requireAuth()` and derives the buyer from the session. If a later phase allows guests, `holderUserId` is already nullable and nothing here would change. | DECISION REQUIRED (design contract already covered this phase) |
| **D-61** | API money representation: decimal string vs integer rupiah | Implemented **decimal strings**, because §36.5's binding rule is "strings … **never as JSON numbers**" and `Decimal(14,2)` is what is stored either way. The register's *recommendation* is integer rupiah, so this is the single place where the implementation follows §36.5 over a register recommendation. It is a pure API-contract switch (no migration, no storage change). | **DECISION REQUIRED — highest-priority operator confirmation** |
| **D-60** | `TicketType.name` uniqueness within an event | Untouched. No `@@unique([eventId, name])`, no unique slug/code substitute. Asserted by `checkout-wiring.test.ts`. | DECISION REQUIRED (unchanged) |

`D-11` (fee amounts) is *not* guessed either: fees are `0` because §17.2 says they stay
zero until configured.

## 5. Files changed

**Prisma / migrations** — none (see §6/§7).

**lib — new**
- `lib/ticketing/reservations.ts` — lifecycle: `createReservation`, `releaseOrderReservations`, `confirmOrderReservations`, `countHeldReservations`, `selectOrdersWithDueReservations`, `expireDueReservations`, TTL resolution, `computeExpiresAt`
- `lib/ticketing/checkout.ts` — `createTicketOrder` (gate → deterministic-lock transaction → payment-ready order)
- `lib/ticketing/checkout-validation.ts` — Zod request/item/idempotency-key schemas
- `lib/ticketing/idempotency.ts` — key scope, TTL, canonical `requestHash`, line normalisation
- `lib/ticketing/order-payload.ts` — the single customer order payload builder + `moneyString`
- `lib/ticketing/orders.ts` — `getOwnOrder`, `cancelOwnPendingOrder`

**lib — modified**
- `lib/ticketing/audit-log.ts` — three new action names (`order.create`, `order.cancel`, `order.expire`), `EventOrder` added to `entityType`, and an explicit `actorType: "SYSTEM"` actor for job-driven actions (with a guard that a `USER` action must name its actor)
- `lib/events/sales-state.ts` — exported the existing per-type classifier (`classifySalesState`) and event purchasability predicate; **no behaviour change** (this is the §11 reuse instead of a second sales-state implementation)
- `lib/authz/permissions.ts` — added `order.cancel.own` to the customer (own-scope) set
- `lib/events/catalog.ts` — public detail now exposes the event `id` (the §25.5 request requires `eventId`; the payload previously exposed only `slug`)

**API — new** (3 routes)
- `app/api/ticketing/checkout/route.ts`
- `app/api/ticketing/orders/[orderNumber]/route.ts`
- `app/api/ticketing/orders/[orderNumber]/cancel/route.ts`

**API — reverted (deliberate)**
- `app/api/checkout/route.ts` and `app/api/orders/**` were briefly written and then
  **restored to their tracked content** (`git checkout --`), because they are live
  retail routes. See §13.

**UI**
- `components/events/TicketPurchaseForm.tsx`, `components/orders/ReservationCountdown.tsx`, `components/orders/CancelOrderButton.tsx`, `app/ticketing/orders/[orderNumber]/page.tsx` — new
- `app/e/[slug]/page.tsx` — the purchase form replaces the Phase 4 disabled placeholder

**Security / infrastructure**
- `proxy.ts` — `/api/ticketing/` added to `PROTECTED_API_PREFIXES`
- `jest.config.js` — Phase 6 glob (`**/__tests__/ticketing-checkout/*.test.ts`) + a comment recording why it is deliberately **not** `__tests__/checkout/*.test.ts`

**Tests — new** (`__tests__/ticketing-checkout/`)
- `reservation-lifecycle.test.ts` (42), `checkout-wiring.test.ts` (25), `checkout.integration.test.ts` (39), `checkout-concurrency.integration.test.ts` (10)

## 6. Schema changes

**NONE.** `prisma/schema.prisma` was not modified by Phase 6, and its working-tree diff is
exactly the pre-existing Phase 2 foundation (1419 insertions) plus the Phase 2.5
collation/legacy-name repairs.

Everything Phase 6 needs already existed from Phase 2:

- `TicketReservation` (`orderId`, `ticketTypeId`, `eventId`, `quantity`, `status`, `expiresAt`) with the `TicketReservationStatus` enum
- `EventOrder` (`orderNumber` unique, `userId`, `organizerId`, `eventId`, `expiresAt`, `buyerName/Email/Phone`, `subtotal/discount/platformFee/picFeeTotal/total/organizerNetAmount`, `currency`, `status`, `paymentStatus`, `cancelledAt`, `cancelReason`) and `EventOrderItem` (`nameSnapshot`, `priceSnapshot`, `quantity`, `subtotal`)
- `IdempotencyKey` with `@@unique([userId, scope, key])`, `requestHash`, `status`, `responseRef`
- `PlatformSetting.reservationTtlMinutes @default(30)`

Verified live: `TicketReservation.status` defaults to `HELD` (the row is never created
with an explicit status, so the initial state has one definition).

## 7. Migration details

```text
Migration: NONE
```

- `npx prisma validate` → valid
- `npx prisma generate` → ok
- `npx prisma migrate status` → **18 migrations, "Database schema is up to date!"**
- No migration directory was added or edited; the newest is `20260916010000_phase2_5_…`
- Historical migrations were left exactly as found (the 4 modified legacy migration files
  in `git status` are the **pre-existing Phase 2.5 checksum repairs**)
- `prisma db push` was not used. Fresh-replay validation was therefore not applicable
  (no new migration exists to replay); the existing chain is unchanged and `migrate
  status` reports it applied.

## 8. Reservation lifecycle

```text
POST /api/ticketing/checkout
        ↓
  HELD  ──(cancel / reaper)──→ RELEASED / EXPIRED      reserved -= n
        └──(Phase 7 settlement)──→ CONVERTED            reserved -= n, sold += n
```

- **Create**: the gate runs first (event purchasable, type active, inside its window, not
  exhausted, quantities legal), then ONE transaction writes the idempotency key row, the
  order, each order item, each `reserveQuota` CAS and each reservation row. If any part
  fails, the whole thing rolls back — so **reserved inventory can never be stranded** and
  an order can never exist without its hold.
- **Release** (`cancelOwnPendingOrder`): one transaction releases the order's holdings and
  CAS-es `PENDING_PAYMENT → CANCELLED`. Repeat calls are refused (`ORDER_NOT_PAYABLE`)
  and inventory is unaffected.
- **Expire** (`expireDueReservations`): per-order transaction; CAS `HELD → EXPIRED`,
  release seats, then transition the parent to `EXPIRED` **only when no `HELD` reservation
  remains**. Re-running changes nothing.
- **Guarding**: every reservation transition is `updateMany` with a `status` predicate, so
  the affected-row count decides the winner. There is **no** `ticketReservation.update()`
  anywhere in `lib/ticketing` (asserted by test) — a singular update could not express
  "only if it is still `HELD`".
- **Confirm** is *not* called by any Phase 6 code path: settlement is Phase 7. The
  primitive's race-safety is nevertheless proved in the concurrency suite.

## 9. Checkout lifecycle

1. CSRF (same-origin) → `requireAuth()` → `Idempotency-Key` **required** → Zod parse
   (undeclared keys stripped, so `price`/`total`/`organizerId`/`userId`/`status` cannot
   reach the service).
2. Coupons are **refused** (`COUPONS_NOT_AVAILABLE_IN_MVP`) rather than silently ignored.
3. Lines merged per type, ordered ascending by `ticketTypeId` (deadlock avoidance).
4. Event + each `TicketType` + each `Venue`/currency resolved **from the database**;
   cross-event ticket types are `NOT_FOUND` (existence not confirmed).
5. Gate: event purchasable (`SALES_NOT_OPEN` for cancelled, `NOT_FOUND` for anything not
   public), type active, window open, `minPerOrder`/`maxPerOrder`, event
   `maxTicketsPerOrder`.
6. Price snapshot from `TicketType.price` using `Prisma.Decimal`; `total = subtotal`
   (MVP zero fees). **No `Number`, no float arithmetic.**
7. ONE transaction: idempotency key → order → per line (CAS → item → reservation).
8. Response: `201` for a real creation, `200` for an idempotent replay, `paymentUrl: null`.

## 10. Inventory integration

- Every inventory mutation goes through `lib/ticketing/inventory.ts`
  (`reserveQuota` / `confirmReservation` / `releaseReservation`). Phase 6 adds **no**
  `UPDATE tickettype`, no `$executeRaw`, and no second availability formula — enforced by
  `checkout-wiring.test.ts`, including a repository-wide scan asserting the arithmetic
  `quota - sold - reserved` exists in exactly the two owner modules.
- Availability has exactly one canonical definition; `availableInventory` is a **re-export**
  of `sales-state.ts`'s `remainingFor`, not a third copy. The two expressions are proved to
  agree (`remainingFor === max(0, rawAvailable)`) by test, so editing one without the other
  fails.
- The checkout never writes `sold`, `reserved` or `version`. The `version` counter is the
  audit trail of successful CAS operations: the 100-buyer race produced exactly
  `version = 50`.

## 11. Concurrency evidence

Real MySQL/InnoDB, `Promise.all`, no mocks (brief §29).

| Case | Result |
| --- | --- |
| **100 buyers / 50 seats** through the full checkout | **50 succeeded, 50 rejected — all 50 with `SOLD_OUT`** (asserted as an exact tally) |
| Counters after the race | `quota = 50`, `reserved = 50`, `sold = 0`, `version = 50` |
| Rows after the race | exactly 50 `HELD` reservations, 50 distinct owning orders, 50 `PENDING_PAYMENT` orders, 0 `Payment` rows, every total `100000` |
| Oversell | **0** |
| 5 concurrent cancels of one order | exactly **1** wins; seats released **once** (`reserved` back to 0, never negative) |
| 5 concurrent confirms of one hold | exactly **1** succeeds; the 4 losers report `RESERVED_UNDERFLOW`; `sold = 4`, `reserved = 0` |
| release racing confirm | the seats are accounted for exactly once (`sold` is 0 or 5, never 10); counters stay consistent |
| reaper racing cancel | both may run; the seats return exactly once, the reservation ends `RELEASED` or `EXPIRED`, and a second sweep changes nothing |

**A real defect this suite found and I fixed.** The first run produced **12 successes, 88
failures, all `P2010`** — Prisma's raw-query failure wrapping InnoDB `ER_LOCK_DEADLOCK`
(1213) / `ER_LOCK_WAIT_TIMEOUT` (1205). The invariants held (no oversell), but 88 buyers
would have seen a broken checkout, and the raw Prisma error escaped the service entirely.

`lib/ticketing/checkout.ts` now classifies transient serialization failures
(`P2034`, or `P2010` **only** when MySQL's error number/message agrees it was contention —
`P2010` alone is generic and must not blanket-retry real SQL errors) and re-attempts the
request, bounded at 10 attempts, with a short **jittered** backoff. This is a *guarded*
retry, not the unguarded kind the brief rules out: every attempt re-runs the gate, the
conditional `UPDATE` and the key insert from scratch, and the jitter stops deadlock victims
re-colliding in lockstep. Result: 50/50 as the design's §11.6 expects.

## 12. Ownership / security evidence

| Attack | Result |
| --- | --- |
| Unauthenticated `requireAuth()` | `UNAUTHORIZED` |
| Another customer reads the order | **`NOT_FOUND`** (not 403 — no existence confirmation) |
| Another customer cancels the order | refused; the order is still `PENDING_PAYMENT` |
| Manipulated `customerId` / `userId` / `organizerId` in the body | stripped by Zod before the service sees it; the order still belongs to the session user |
| Client-supplied `total` / `price` / `subtotal` / `currency` | ignored; totals recomputed from the DB (`300000.00`, `IDR`) |
| Ticket type from another event | `NOT_FOUND` |
| Inactive / not-started / ended / sold-out type | `SALES_NOT_OPEN` (`INACTIVE`, `NOT_STARTED`, `CLOSED`) or `SOLD_OUT`, with zero seats reserved |
| Draft event | `NOT_FOUND`; cancelled event | `SALES_NOT_OPEN` + `EVENT_CANCELLED` |
| Repeat cancel / cancel after expiry | `ORDER_NOT_PAYABLE`; the expired order is **not** resurrected |
| Duplicate request, same key | one order, `replayed: true`, seats held **once** |
| Same key, different body | `CONFLICT` + `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST` |
| Same key string, different customer | independent orders (scope is per user) |
| Failed line | no partial reservation, no order row created |
| Cross-organizer | unchanged from Phase 3: an organizer actor cannot touch another tenant's event |

CSRF: both state-changing routes call `requireSameOrigin(request)` and return
`csrf.error`; asserted statically **and** by the Phase 3 route-classification suite
(134 → **137/137** routes classified).

## 13. API routes

| Route | Method | Auth | Guard |
| --- | --- | --- | --- |
| `/api/ticketing/checkout` | POST | `requireAuth()` | `requireSameOrigin`; `Idempotency-Key` required |
| `/api/ticketing/orders/[orderNumber]` | GET | `requireAuth()` | `order.read.own` **+** server-side ownership (404); design references `GET /api/orders/{orderNumber}` |
| `/api/ticketing/orders/[orderNumber]/cancel` | POST | `requireAuth()` | `requireSameOrigin`; `order.cancel.own` **+** ownership; design references `POST /api/orders/{orderNumber}/cancel` |

**Deliberate path divergence (WARNING, documented).** The design's §25.5 sketches
`POST /api/checkout` and `/api/orders/{orderNumber}`. Both namespaces are **already taken
by live retail routes** (`app/api/checkout/route.ts` is a tracked retail handler;
`app/api/orders/[id]` exists, and Next.js rejects two dynamic segment names at one
position). Brief §34 forbids modifying retail checkout, so the ticketing purchase surface
lives under `/api/ticketing/**`, exactly as Phase 4 resolved the same collision for
`/api/admin/**` by using `/api/organizer/**`. Both replaced paths are recorded here.

**A mistake I made and corrected:** I first wrote the two colliding files in place,
discovered the overwrite of a tracked retail route, and restored it with
`git checkout --` — verified today: `app/api/checkout/route.ts` and `app/api/orders/**`
show **zero modifications** in `git status`.

## 14. UI changes

- `components/events/TicketPurchaseForm.tsx` — quantity selection driven by the public
  availability payload, submitting **only** `ticketTypeId` + `quantity`; no price, total or
  currency is sent or trusted.
- `app/e/[slug]/page.tsx` — the Phase 4 disabled placeholder is replaced by the real form.
- `app/ticketing/orders/[orderNumber]/page.tsx` — payment-ready confirmation: status,
  totals, items, reservation state, `paymentUrl` deliberately shown as "Phase 7".
- `components/orders/ReservationCountdown.tsx` — renders the **server's** `expiresAt` and
  revalidates on reaching zero; it never releases inventory (server state is authoritative).
- `components/orders/CancelOrderButton.tsx` — shown only while `canCancel` is true.

No payment UI, no QR/wallet, no check-in, no PIC/financial/settlement dashboard, and no
retail screen touched. The UI is type-checked but **not browser-verified** (no dev-server
run in this phase) — recorded as a WARNING.

## 15. Audit logging

Reuses `lib/ticketing/audit-log.ts` (no second logger — brief §27). Phase 6 adds three
action names and wires three call sites:

| Action | Written by | When | Tenant column | Actor |
| --- | --- | --- | --- | --- |
| `order.create` | `createTicketOrder` | **after** the transaction commits | `organizerId` = the order's organizer | the customer session user |
| `order.cancel` | `cancelOwnPendingOrder` | after the guarded CAS commits | the order's organizer | the buyer |
| `order.expire` | `expireDueReservations` | per order, after its own transaction | the order's organizer | **explicit `SYSTEM`** |

Design details that are deliberate:

- **Written after commit, never inside it.** A rolled-back checkout therefore leaves no
  audit row claiming a purchase, and a loser of the concurrent-cancel CAS writes nothing.
  Both are asserted by test.
- **A replay writes nothing** — the idempotent path returns before the audit call
  (a replay has no side effects, §30.2). Asserted: exactly one row per order number.
- **The reaper is not a user.** Rather than repeating the `adminId = "SYSTEM"` sentinel
  overload that design §32.1 criticises, `TicketingAuditParams` now accepts an explicit
  `actorType: "SYSTEM"` with no actor (and refuses a `USER` action with no actor). The
  row records `actorType = SYSTEM`, `actorUserId = null`, and the legacy NOT NULL
  `adminId` carries the marker because the column cannot be null.
- **No buyer PII.** The payload is `orderNumber`, `eventId`, ticket-type ids, quantities,
  currency, subtotal/total, status, `expiresAt` and the idempotency key. The buyer's name,
  email and phone are deliberately excluded — the order row already holds them. Asserted
  by test against the literal fixture strings.
- **`reservation.release` is not a separate action**: releasing seats is a step inside a
  cancel or an expiry, and a second row per step would overstate how many transactions
  happened.

Five tests cover this path (`order.create` fields and tenant, the Phase 5 ticket-type path
still naming its actor, no double-write on replay, no row on rollback, one row each for
cancel and expire including the SYSTEM actor and the no-op re-run).

## 16. Tests

`__tests__/ticketing-checkout/` — **4 suites, 121 tests, 121 passed**:

| Suite | Tests | Covers |
| --- | --- | --- |
| `reservation-lifecycle.test.ts` | 42 | A: gate rules, quantity bounds, windows, coupons, expiry arithmetic; availability equivalence between the two owner modules |
| `checkout-wiring.test.ts` | 25 | D/J/§32: canonical primitives reused, no counter writes, no second formula, state guards, no scheduler, no payment/QR/notification/PIC code, required CSRF + auth, D-60 untouched |
| `checkout.integration.test.ts` | 44 | A/B/C/F/G/H + audit against the real DB and real `lib/authz`: validation, IDOR, lifecycle, reaper idempotency, multi-line, snapshots, exact Decimal totals, idempotency, failure safety, no stranded holds, invariants, audit rows |
| `checkout-concurrency.integration.test.ts` | 10 | E: the 100/50 race and the four transition races on real InnoDB |

Test groups from brief §31 are all covered (A–K); group J is satisfied by the Phase 3
classification suite plus the static route assertions.

## 17. Baseline vs final

| | Baseline (end of Phase 5) | Final (end of Phase 6) |
| --- | --- | --- |
| Test suites | 44 | **48** (+4) |
| Tests | 1081 | **1202** (+121) |
| Failed tests | 2 | **2** |
| Passed tests | 1079 | **1200** |
| Failing suites | 6 | **6 — the identical six** |

The six failing suites are the pre-existing retail/iPaymu ones, unchanged and
un-suppressed: `__tests__/p0/remediation.integration.test.ts`,
`__tests__/marketing/profile-phone-shipping.test.ts`,
`__tests__/marketing/m7-audit-fixes.test.ts`,
`__tests__/marketing/campaign-optional-audit.test.ts`,
`__tests__/marketing/address-shipping-ux.test.ts`,
`__tests__/ipaymu/production-hardening.test.ts`. **Zero Phase 6 regressions.**

One test-infrastructure error of mine was also caught and fixed here: my first Phase 6
Jest glob was `**/__tests__/checkout/*.test.ts`, which enrolled the **tracked legacy
script** `__tests__/checkout/lifecycle.test.ts` (a standalone `tsx` entry point with a
hand-rolled `assert` that ends in `process.exit(1)`, never part of any `testMatch`; it
fails 21 of its own 166 static checks). That would have injected unrelated verdicts into
the Jest counts and killed the worker. Phase 6 suites were relocated to
`__tests__/ticketing-checkout/` and the legacy file is untouched and unenrolled.

## 18. Migration verification

No migration exists to verify. `prisma validate` ✓, `prisma generate` ✓, `prisma migrate
status` ✓ (18 migrations, up to date). No `db push`, no `migrate reset`, no historical
migration edited.

## 19. Residue verification

Live database after the full run:

```text
events 0 · ticketTypes 0 · eventOrders 0 · eventOrderItems 0 · reservations 0
idempotencyKeys 0 · tickets 0 · payments 0 · venues 0 · organizers 0
organizerMembers 0 · sports 14
adminAuditLog (order.*) 0
```

Zero Phase 6 residue, including audit rows — and this was **verified by re-running**, not
assumed. The first attempt did leave rows: my cleanup omitted the organizer id under which
the ticket-type *fixtures* are audited (they are created as the owner, not as a buyer), so
each run left five `ticket_type.create` rows behind. Fixed, then both DB suites were re-run
and the count confirmed at 0.

**Pre-existing residue found (NOT Phase 6's, left in place):** 261 `ticket_type.*` audit
rows from earlier phases' test runs, all with `actorUserId = NULL` and a populated
`adminId`. Current behaviour is correct — a test now asserts that the Phase 5 ticket-type
path records the acting user — so these predate that wiring. They were deliberately **not**
deleted: they are another phase's artefact, erasing them would hide the finding, and the
Phase 5 report's "zero residue" claim did not count audit rows at all. One statement clears
them if the operator wants:

```sql
DELETE FROM adminauditlog WHERE action LIKE 'ticket_type.%' AND actorUserId IS NULL;
```

No broad `DELETE` was ever run against unrelated tables. Retail data intact: **5 products /
149 orders** (the same values recorded at the end of Phase 4).

## 20. Legacy safety

Untouched: `Product`, `ProductVariant`, `Flashsale`, legacy `Order`/`OrderItem`, retail
checkout and cart, retail homepage, retail admin, marketing, affiliate, spin wheel,
shipping, and the existing iPaymu integration. No retail model renamed, no retail data
migrated, no retail route deleted. `git status` confirms no modification under
`app/api/payment/**`, `lib/payment/**`, or the retail `Order` routes; the only files Phase 6
touched outside its own new tree are `lib/events/sales-state.ts`,
`lib/events/catalog.ts`, `lib/authz/permissions.ts`, `proxy.ts`, `jest.config.js` and one
event page.

## 21. Warnings / unresolved issues

1. **`D-61` money encoding — DECISION REQUIRED (top priority).** Implemented as decimal
   strings per §36.5's "never JSON numbers"; the register recommends integer rupiah.
   Switching is an API-contract change only (no migration).
2. **`D-22` fee bearer — DECISION REQUIRED.** Totals are the zero-fee baseline; neither
   "absorbed" nor "passed to buyer" is encoded. Both are reachable with existing fields.
3. **`D-01`/`D-04`/`D-06` PIC attribution — DECISION REQUIRED + OUT OF SCOPE.** No
   attribution is captured at checkout. If a later phase needs attribution *from* this
   phase's orders, the order already carries `picFeeTotal` and a nullable `shareToken`
   passthrough, but no attribution row.
4. **`D-09` repayment pricing, `D-26` free-ticket settlement — DECISION REQUIRED
   (payment phase).** Neither path exists in Phase 6.
5. **`D-33` guest checkout — DECISION REQUIRED.** §25.5's own contract for this endpoint is
   "Auth: Required", which is what is enforced.
6. **The reaper has a mechanism but no runner — WARNING.** `expireDueReservations` is the
   §11.4 body (bounded batch, re-runnable, single-transaction per order), but §11.4's
   **scheduling** (1-minute interval, single-flight) is assigned to a later phase and no
   scheduler infrastructure decision exists. Per brief §8 no cron/BullMQ/Redis/timer was
   invented. Consequence: **expired holds are released when the reaper is invoked, not
   automatically.** Phase 7 must supply the runner before payment windows can lapse.
7. **Phase 5 `released` can over-report — WARNING (pre-existing, not fixed).** Because
   `releaseReservation` computes `released` as `min(requested, reserved + requested)` from
   a read taken *after* a `GREATEST(0, …)` update, a no-op release (already 0) reports the
   requested quantity as released. The counters are correct; only the reported figure is
   optimistic. Similarly `version` is bumped even by a no-op release. Both live in Phase 5
   code that Phase 6 consumes; changing them would alter a Phase 5 module's semantics, so
   they are documented rather than edited. Assertions were written against the effects
   (`sold`, `reserved`, `version` deltas) instead.
8. **UI is type-checked but not browser-verified** (no dev server was run). The purchase
   form, countdown and cancel button have no automated interaction tests.
9. **API paths diverge from the design's sketch** (`/api/ticketing/**` instead of
   `/api/checkout`, `/api/orders/{orderNumber}`) because those namespaces are occupied by
   live retail routes. Documented in §13 and in the route files.
10. **No idempotency-key cleanup job.** `expiresAt` is set (24 h) but nothing prunes expired
    rows — same missing-runner class as (6).
11. **`order.create`'s audit row is fire-and-forget — WARNING.** The shared logger's own
    header documents that a *financial* action needs a durable (transactional) audit row
    and assigns that guarantee to a later phase, so Phase 6 follows the existing
    infrastructure rather than inventing a second writer. Consequence: an order could in
    principle commit without its audit row if the audit insert fails (the failure is
    logged loudly). Phase 9/10 should decide whether `order.create` must become
    transactional.
12. **261 pre-existing `ticket_type.*` audit rows** from earlier phases' test runs remain
    in the development database (see §19) — reported, not deleted.

## 22. Explicit out-of-scope confirmation

Phase 6 did **NOT** implement or modify:

- iPaymu payment creation or any gateway call · iPaymu webhook · payment settlement ·
  refunds · payouts
- ticket issuance · QR generation · e-ticket wallet · check-in
- PIC attribution · PIC fee calculation · PIC fee ledger · settlement ledger
- WhatsApp · email · notification workflows
- coupons · marketing · spin wheel · affiliate migration
- financial reporting · Excel export
- retail cleanup · `Product → Event` rename · `Flashsale → TicketType` rename
- `D-60` · `D-56`? (not applicable) · KTP Git-history purge
- Git history rewrite, commit or push

`Payment` rows are **0** after the full run; `paymentUrl` is always `null`; the resulting
order is payment-ready, not paid.

## 23. Git status

```text
Commit created:   NO
Push performed:   NO
History rewritten: NO
```

Pre-existing changes preserved exactly as found, including `next-env.d.ts`,
`package-lock.json`, `prisma/seed-regions.js`, the Phase 2/2.5 schema and migration
repairs, and all Phase 3/4/5 work. `git status --short` additionally shows the two
temporarily-created-and-restored retail files as clean (no entry), and
`tsconfig.tsbuildinfo` as modified (a build artefact, not source).

## 24. Phase 7 dependencies

What Phase 7 can consume **now**:

- **Payment-ready orders**: `createTicketOrder` returns an `EventOrder` in
  `PENDING_PAYMENT` / `UNPAID` with `expiresAt` (the payment window) and exact item
  snapshots. `paymentUrl` is `null` and awaiting Phase 7.
- **Atomic inventory primitives**, unchanged and already transaction-client-aware:
  `reserveQuota`, `confirmReservation` (→ `CONVERTED`, the settlement conversion),
  `releaseReservation` (failed payment / cancel / expiry).
- **A guarded reservation lifecycle**: `releaseOrderReservations`,
  `confirmOrderReservations`, `countHeldReservations`, plus `expireDueReservations` as the
  reusable reaper body.
- **Idempotency**: `IdempotencyKey` with the request hash and `responseRef`, and the
  replay/conflict semantics already proved.
- **Ownership-scoped order reads/cancel** and the `order.*` permission entries.
- **A webhook-shaped seam**: the design's `EventOrder.status`/`paymentStatus` vocabulary
  already exists, including `EXPIRED` released by the reaper.

What Phase 7 must decide or supply:

1. **A reaper runner** (warning 6) — without it, holds expire only when invoked.
2. **`D-26`** free-ticket settlement path and **`D-09`** repayment pricing.
3. **`D-61`** money encoding confirmation before the API contract spreads.
4. **`D-22`** fee bearer before charging gateway fees.
5. The `Payment` row/session and webhook CAS guards — explicitly **not** started here.

## 25. Final summary

Phase 6 delivers the reservation + checkout foundation on top of Phase 5's inventory
primitives: an organizer-independent, authenticated customer checkout that validates the
event, ticket type, sales window and quantity rules, reserves seats through the canonical
atomic CAS inside the same transaction that creates the order, snapshots the price with
Decimal-safe arithmetic, honours `Idempotency-Key` exactly as the design specifies, and
stops precisely at the payment boundary. Reservation release is idempotent and
state-guarded; expiry has a correct, re-runnable mechanism awaiting a runner; ownership is
enforced server-side with 404 semantics.

Reservations and orders are audited through the existing logger (no second writer), with
the reaper recorded as an explicit `SYSTEM` actor rather than a sentinel user, and with no
buyer PII in any payload.

The database needed **no migration**, no retail behaviour changed, and the full suite
matches the Phase 5 baseline exactly (same 6 failing suites, same 2 failing tests) while
adding 121 passing Phase 6 tests — including a real-InnoDB 100-buyer/50-seat race that
proves zero oversell, and which found and fixed a genuine contention-handling defect
(`P2010` deadlock surfaces becoming buyer-visible failures).

Outstanding items are the design's own open decisions (`D-01/04/06/09/22/26/33/61`), the
missing reaper runner, and one pre-existing Phase 5 reporting wart — all recorded above
rather than silently resolved.
