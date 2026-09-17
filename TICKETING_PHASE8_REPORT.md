# TICKETING PHASE 8 — TICKET ISSUANCE + QR / E-TICKET + CUSTOMER TICKET WALLET

**Repository:** `demo-marketplace` (TinggalKlik.Co) · **Branch:** `main`
**Date:** 2026-09-17 · **Author:** implementation phase, no commit performed

---

## 1. Status

```text
PHASE 8 STATUS: PASS WITH WARNINGS
```

Every acceptance criterion in brief §54 is met (evidence in §26 below). Two warnings survive,
both documented rather than resolved:

1. **`WARNING` — a PRE-EXISTING Phase 7 race is reproducible.** Phase 7's own suite
   `__tests__/ticketing-payment/payment-races.integration.test.ts` (test **H1**) intermittently
   buys **two** provider payment sessions for one order. It reproduces **2 of 5 runs in
   isolation**, with no Phase 8 module loaded at all. Root cause located, deliberately **not**
   fixed (brief §18 closes the payment boundary). See §24.1.
2. **`DECISION REQUIRED` — D-46** (short-lived display token vs server-rendered QR image).
   The design assigns it to this phase and marks it unresolved. The implemented mechanism is
   the one the design's own §23.4 content rule *forces* and its recommendation endorses, but the
   formal decision is still open, and it has a concrete downstream consequence for check-in.
   See §25.

---

## 2. Scope implemented

| Item | Status | Where |
| --- | --- | --- |
| Ticket issuance service | `IMPLEMENTED` | `lib/ticketing/tickets/issuance.ts` |
| Idempotent generation | `IMPLEMENTED` / `VERIFIED` | row lock + `@@unique([orderItemId, sequenceNo])` + missing-sequence diff |
| Ticket identity / public code | `IMPLEMENTED` | `lib/ticketing/tickets/reference.ts` (`EVT-XXXX-XXXX`) |
| Opaque QR token (generated + hashed only) | `IMPLEMENTED` | `reference.ts`, persisted as `Ticket.qrTokenHash` |
| QR payload | `IMPLEMENTED` / `VERIFIED` | `TICKET:<ticketCode>`, non-PII, stable, server-derived |
| Ticket status lifecycle (initial state only) | `IMPLEMENTED` | `ISSUED`; no check-in transition exists |
| Ticket ownership | `IMPLEMENTED` / `VERIFIED` | `holderUserId` predicate in every query |
| Customer ticket wallet | `IMPLEMENTED` | `app/ticketing/tickets/page.tsx` |
| Ticket detail / e-ticket | `IMPLEMENTED` | `app/ticketing/tickets/[ticketCode]/page.tsx` |
| Ticket APIs | `IMPLEMENTED` | 3 routes, see §14 |
| Authorization / tenant isolation | `IMPLEMENTED` / `VERIFIED` | `lib/authz` guards, own-scope permissions |
| Audit logging | `IMPLEMENTED` / `VERIFIED` | `ticket.issue` via the existing logger |
| Concurrency testing (real InnoDB) | `VERIFIED` | `issuance-concurrency.integration.test.ts` (9 tests) |
| Security testing | `VERIFIED` | integration groups F/I + static guards |
| Route classification | `VERIFIED` | 142/142 classified, suite green |
| Report | `IMPLEMENTED` | this file |

`OUT OF SCOPE` and untouched: payment/iPaymu/webhook/settlement, reservation and inventory
semantics, check-in, PIC attribution and fees, settlement/payout, refunds, reporting, Excel,
WhatsApp/email delivery, marketing/spin-wheel, retail checkout/order/payment, model renames,
guest checkout, D-09 repayment, D-20 settlement, D-22 fees, D-26 free tickets, D-60, D-61.

---

## 3. Files changed

**Created (12 application + 4 test files):**

```text
lib/ticketing/tickets/reference.ts                     ticket code, QR token, hashing, payload
lib/ticketing/tickets/issuance.ts                      the fulfilment service (gate, lock, plan)
lib/ticketing/tickets/payload.ts                       wallet/e-ticket projections
lib/ticketing/tickets/service.ts                       ownership-scoped reads
lib/ticketing/tickets/validation.ts                    query + path-param schemas
app/api/ticketing/tickets/route.ts                     GET  wallet list
app/api/ticketing/tickets/[ticketCode]/route.ts        GET  ticket detail (the only QR source)
app/api/ticketing/orders/[orderNumber]/issue/route.ts  POST issuance
app/ticketing/tickets/page.tsx                         My Tickets
app/ticketing/tickets/[ticketCode]/page.tsx            E-ticket
components/tickets/IssueTicketsButton.tsx              explicit fulfilment action
components/tickets/TicketQr.tsx                        SVG QR from a server-supplied payload
__tests__/ticketing-issuance/issuance-harness.ts       fixtures (not a suite)
__tests__/ticketing-issuance/issuance.integration.test.ts
__tests__/ticketing-issuance/issuance-concurrency.integration.test.ts
__tests__/ticketing-issuance/issuance-wiring.test.ts
```

**Modified (5):**

```text
lib/ticketing/audit-log.ts            + "ticket.issue" action, + "Ticket" entity type
lib/authz/permissions.ts              + TICKET_READ_OWN / TICKET_ISSUE_OWN (own-scope; CUSTOMER, PIC)
lib/ticketing/order-payload.ts        + tickets[], + walletUrl, + canIssueTickets (additive)
app/ticketing/orders/[orderNumber]/page.tsx   + issued-tickets block OR the issue action
jest.config.js                        + "**/__tests__/ticketing-issuance/*.test.ts"
```

**Deleted:** none. A temporary verification tool (`scripts/p8-ui-verify.ts`, used for the
dev-server checks in §15) was created and **removed** after use; its fixtures were cleaned from
the database and their absence re-verified (§22).

`proxy.ts` was **not** touched by this phase: `/api/ticketing/` (protected) and `/ticketing`
(protected page) already cover all three new routes and both new pages — asserted in §26/A17.

---

## 4. Schema / migration status

```text
MIGRATION: NONE
```

* `prisma/schema.prisma` was **not modified** by this phase. Phase 2's foundation already
  contained everything issuance needs: `Ticket.(ticketCode, qrTokenHash, qrVersion, orderId,
  orderItemId, sequenceNo, ticketTypeId, eventId, organizerId, holderUserId, status, issuedAt)`,
  `@@unique([orderItemId, sequenceNo])`, and the five indexes.
* `npx prisma validate` → `The schema at prisma/schema.prisma is valid 🚀`
* `npx prisma generate` → regenerated cleanly.
* `npx prisma migrate status` → `Database schema is up to date!` (18 migrations)
* No historical migration was read, edited or replayed. `prisma db push` was not run.
* No new dependency: `qrcode.react@4.2.0` was already installed and is already used by the
  event-share surface, so `package.json` has no Phase 8 diff (asserted in the static guards).

---

## 5. Ticket issuance lifecycle

```text
EventOrder(status = PAID, paymentStatus = PAID, paidAt != null, fulfilmentBlockedAt = null)
        │
        │  POST /api/ticketing/orders/{orderNumber}/issue   (CSRF + session + ownership)
        ▼
pre-flight gate  →  plan from persisted EventOrderItem.quantity
        │
        ▼
prisma.$transaction
   ├─ SELECT id FROM eventorder WHERE id = ? FOR UPDATE      ← serialises the same order
   ├─ re-read the gate on the COMMITTED row                  ← late settlement is honoured
   ├─ read existing ticket rows for the order                ← the state IS the rows
   ├─ insert only the missing (orderItemId, sequenceNo) slots
   ├─ read the whole set back and assert the count invariants under the lock
   └─ COMMIT
        │
        ▼
audit "ticket.issue"  (only when rows were created)
        │
        ▼
Ticket rows: status = ISSUED, holderUserId = buyer, issuedAt = order.paidAt
```

Outcomes: `ISSUED` (≥1 row created, HTTP 201) or `ALREADY_ISSUED` (0 rows, HTTP 200). Neither
is a failure — a refresh, a double-click, a retried internal call and a crash recovery all
converge on exactly `SUM(quantity)` rows.

---

## 6. Ticket identity / code design

* Public code: `EVT-XXXX-XXXX` over a 32-symbol ambiguity-free alphabet
  (`23456789ABCDEFGHJKMNPQRSTVWXYZ`), matching design §19.1's own example shape. Drawn with
  `crypto.randomInt`, **never sequential** despite the design's example incrementing its last
  character — the same row says "non-sequential, random suffix", and a sequential code would let
  one buyer enumerate an event. Uniqueness is enforced by `Ticket.ticketCode @unique` and a
  bounded 5-attempt regeneration.
* Scanner token: `base64url(randomBytes(32))` per design §19.3, persisted **only** as
  `SHA-256` (`Ticket.qrTokenHash`, `@unique`). The plaintext is generated inside a single
  expression, is never bound to a variable, and is not returned, logged or audited — asserted by
  the static guards.
* Immutability: nothing regenerates a code or a token. `qrVersion` stays at its default `1`,
  because `ticket.reissue` is a later phase (design §19.5) and this phase does not invent one.

---

## 7. QR design

| Property | Implementation | Evidence |
| --- | --- | --- |
| Encoded value | `TICKET:<ticketCode>` — namespaced public reference | `reference.ts#buildTicketQrPayload` |
| Determinism / stability | pure function of the code; identical on every read | integration G1, G4 |
| Non-PII | code alphabet excludes `@ : + / ?`, so an email/phone/URL/money value is unrepresentable, plus `assertQrPayloadIsSafe` | integration G2 |
| No secret | the token and its hash never appear in any response | integration G2, static guards |
| No URL | deliberately not a link: brief §25/§37 forbid a public ticket page | `reference.ts` |
| Renderer | SVG via the already-installed `qrcode.react`, exactly as `ShareEventMenu` does | `components/tickets/TicketQr.tsx` |
| One source | the payload is returned **only** by `GET /api/ticketing/tickets/{ticketCode}`; the list endpoint omits `qr` entirely (design §26.5) | integration G3 |
| Not authorization | the payload is a lookup identifier; admission stays a server-side decision | design §19.4 / §36 |

`WARNING` — the *image* is rendered by the client from a server-fixed payload, following the
repository's existing convention (server fixes content, client renders SVG; no PNG/encoder added).
The acceptance item "QR is server-generated" holds for the content — the client cannot encode
anything else, because it receives no other value — but not for the rasterisation. This is the
same trade-off the design's §10.6/§25.6 already made for event sharing, and the alternative is
the open half of D-46 (§25).

---

## 8. Eligibility rules

Single definition, `assertOrderIsFulfillable()` — evaluated twice: pre-flight (cheap refusal) and
again on the locked row (authoritative).

```text
1. order exists and is the caller's            (predicate in the query, not a check after)
2. fulfilmentBlockedAt IS NULL                 ← checked FIRST: it is the overspecified state
3. status          = PAID
4. paymentStatus   = PAID
5. paidAt IS NOT NULL
6. the order has at least one item
7. every item has quantity > 0
8. every item still resolves its ticketTypeId
```

`fulfilmentBlockedAt` is checked before status on purpose: a late settlement leaves the order
terminally `CANCELLED`/`EXPIRED` **and** `paymentStatus = PAID` **and** blocked, and reporting
"not paid" for an order that took the customer's money is both wrong and useless to an operator.

Rejections are deterministic and side-effect free — no ticket, no state change, no release, no
inventory move, no audit row (integration A2–A8, H2, H3).

---

## 9. Fulfilment-blocked behaviour

```text
PAID + fulfilmentBlockedAt != NULL   →   409 CONFLICT  reason = FULFILMENT_BLOCKED   →   0 tickets
```

Produced in the tests by its **real cause**, not by hand: a cancelled order that the provider's
success notification reaches afterwards (Phase 7's `LATE_SETTLEMENT`). The fixture asserts the
state it created (`paymentStatus = PAID`, `paidAt != null`, `fulfilmentBlockedAt != null`,
`status != PAID`) so a change in settlement's terminal states surfaces as a fixture failure
rather than as a passing issuance test.

No auto-repair of any kind: the order's status, payment status, timestamps, counters and
reservations are byte-identical before and after the refusal (integration A7), and five
simultaneous calls against a blocked order all refuse with the same reason (concurrency E5).

---

## 10. Idempotency strategy

Three mechanisms, each covering what the previous cannot:

1. **`SELECT … FOR UPDATE` on the `eventorder` row** — serialises issuers of the *same* order, so
   10 simultaneous calls do one set of inserts and nine no-ops instead of a racing insert storm.
   Lock order matches Phase 7's settlement (`eventorder` first), so the two paths queue rather
   than deadlock. It is the only raw statement in the layer, and the reason for it (Prisma has no
   row-locking read; the alternatives are worse) is documented in the module.
2. **`@@unique([orderItemId, sequenceNo])`** — the database is the final arbiter. Even if the lock
   were never taken, a second insert for the same slot cannot commit; the loser adopts the
   existing row. Proved directly by concurrency E7, which bypasses the service and asserts the
   constraint fires (`P2002`).
3. **Missing-sequence diffing** — the plan is derived from the rows that exist, never from a
   status flag. A crash after 3 of 5 rows leaves 3, and the next call creates 2 (integration D1,
   D2, concurrency E4).

Contention (`P2010` wrapping MySQL 1205/1213) is classified and retried by the **shared** bounded
`withContentionRetry` from Phase 6 — not a new implementation, and not a blanket retry — with the
transaction re-run from the beginning.

---

## 11. Concurrency evidence (real MySQL/InnoDB)

`__tests__/ticketing-issuance/issuance-concurrency.integration.test.ts` — 9 tests, real database,
real services, real sessions, `Promise.all`, no mocks inside the issuance path. Run 3× consecutively:

```text
E1  2 simultaneous calls, quantity 4     → exactly 1 ISSUED, 4 rows created     PASS
E2  10 simultaneous calls, quantity 5    → exactly 1 ISSUED + 9 ALREADY_ISSUED  PASS
                                           total rows = 5, every caller reports totalTickets = 5
E3  two different orders concurrently    → 2 and 3 rows on their own types      PASS
E4  race after partial progress (5,      → both callers create only what is      PASS
    slots 3+4 deleted)                     missing: 2 rows created, 5 present
E5  blocked order × 5 concurrent calls   → 5/5 rejected FULFILMENT_BLOCKED,      PASS
                                           row state identical, 0 tickets
E6  6 repeats after completion           → 6× ALREADY_ISSUED, 0 created,         PASS
                                           codes unchanged, invariants hold
E7  direct insert of an existing slot    → P2002 from the database               PASS
E8  counters before/after issuance       → byte-identical incl. `version`        PASS
E9  items removed from a paid order      → refused, 0 tickets                     PASS
```

Invariant assertions are derived from the persisted order lines (per order and per line), not
from constants, and are re-checked after every race: no oversell, no negative counter, no
duplicate `ticketCode`, no duplicate `(orderItemId, sequenceNo)`, no ticket without a holder.

---

## 12. Ticket count invariants

For every issued order, asserted **under the lock** and again in the tests:

```text
SUM(EventOrderItem.quantity) == COUNT(Ticket where orderId = order)
EventOrderItem.quantity      == COUNT(Ticket where orderItemId = item)
ticketCode                   unique across the table
(orderItemId, sequenceNo)    unique across the table
```

A mismatch raises an unexposed `INTERNAL_ERROR` with `TICKET_COUNT_MISMATCH` /
`TICKET_LINE_COUNT_MISMATCH`, which rolls the transaction back — so a partially-fulfilled order
cannot be *reported* as fulfilled.

---

## 13. Ownership / tenant isolation

* **Structural, not a check afterwards.** Every read carries `holderUserId = session.user.id` in
  its `where` clause (design §26's mandatory ownership predicate), so there is no code path that
  fetches a row and then decides whether the caller may see it.
* **404, never 403** for another buyer's ticket (brief §15) — indistinguishable from a code that
  was never issued. Verified at the service layer (F2) and over real HTTP (§15).
* **Own-scope permission is still applied**: `requireOwnResource(PERMISSIONS.TICKET_READ_OWN |
  TICKET_ISSUE_OWN, …)`, so a role without the capability is refused even for its own rows.
* **Cross-tenant**: tenant B's owner, holding a real ACTIVE membership on their own organization,
  gets `NOT_FOUND` for tenant A's paid order — the lookup is `{orderNumber, userId}`, so an order
  that is not the caller's does not exist (I1).
* **Identity comes from the session only.** No request field can widen the result set: the wallet
  schema declares no `userId`/`holderUserId`/`organizerId`/`paymentStatus`/`ticketStatus`/
  `paidAt`/`issuedAt`/`ticketCode`/`qrPayload`, and the issuance route reads no body at all
  (I2 + static guards).

---

## 14. API routes

| Method | Path | Class | Controls |
| --- | --- | --- | --- |
| `GET` | `/api/ticketing/tickets` | PROTECTED | `requireAuth` + `TICKET_READ_OWN` + ownership predicate; paginated (default 20, cap 50); no QR in the payload |
| `GET` | `/api/ticketing/tickets/[ticketCode]` | PROTECTED | `requireAuth` + `TICKET_READ_OWN` + code shape validation + ownership predicate; 404 for foreign/malformed; the only route that returns `qr.payload` |
| `POST` | `/api/ticketing/orders/[orderNumber]/issue` | PROTECTED | `requireSameOrigin` + `requireAuth` + `TICKET_ISSUE_OWN` + ownership predicate; no body; 201 `ISSUED` / 200 `ALREADY_ISSUED` / 402 · 404 · 409 with deterministic codes |

Design paths `/api/tickets*` (§26.5/§26.6) were **not** used: `/api/**`'s retail siblings own
`/api/orders/**`, and brief §3 keeps ticketing namespaced rather than moving retail. Recorded as
a deliberate, documented substitution.

---

## 15. UI routes and components

```text
event detail → checkout (Phase 6) → payment (Phase 7) → PAID
      → /ticketing/orders/{n}   lists issued tickets + links to the wallet, or offers the issue action
      → /ticketing/tickets      My Tickets (own, upcoming, paginated)
      → /ticketing/tickets/{code}  E-ticket: event, sport, date/time, venue, ticket type,
                                   code, SVG QR, order number, slot, issued-at
```

Verified over HTTP against the running dev server (Next 16.3.0, Turbopack) with a **real
Auth.js session** created through the credentials provider, against a real fixture (paid order,
2 issued tickets, plus a second buyer's ticket):

```text
/ticketing/tickets                      (anonymous)  307 → /login?next=…            PROTECTED
/ticketing/tickets/EVT-ABCD-EFGH        (anonymous)  307 → /login?next=…            PROTECTED
/ticketing/tickets                      (session)    200, both own codes present     OK
                                                      other buyer's code: absent
                                                      "TICKET:" payloads: 0           (no QR in the list)
                                                      "qrToken": 0
/ticketing/tickets/EVT-8FRX-CZMA        (session)    200, code + order number shown  OK
                                                      QR SVG present (qrcode.react symbol path)
                                                      check-in / validation UI: absent
/ticketing/tickets/EVT-SDMR-VBSB        (session A)  404, zero ticket data            OWNERSHIP OK
                                                      (the code appears only as the echoed URL path)
/ticketing/orders/{paid, issued}        (session)    200, tickets listed + wallet link
                                                      issue button: absent            CORRECT
/api/ticketing/tickets                  (no session) 401 {"success":false,…}          OK
/api/ticketing/orders/{n}/issue         (no session) 401                              OK
```

This covers brief §38 items 1–5 and 7 against the real server. Item 6 (a blocked order produces
no ticket) is not reachable over HTTP without fabricating a late settlement in the live
database, so it is covered by the Jest fixtures that produce it honestly (A6/A7/H2/E5) instead.

`WARNING: UI verified over HTTP against the dev server; the authenticated wallet and e-ticket
pages were NOT visually browser-verified` (no browser automation is available in this
environment). The rendered HTML was inspected directly, so the checks above are on real markup,
not on type-checking alone.

---

## 16. Audit behaviour

* Reuses `lib/ticketing/audit-log.ts` — no second logger; asserted by the static guards.
* One action added: `ticket.issue`. Deliberately **not** four: issuance is the only ticket
  transition this phase performs, and declaring `ticket.reissue`/`ticket.void` (design §19.5)
  without a writer would be vocabulary invented for symmetry.
* One row per fulfilment **call that created rows**, `entityRef = orderNumber` (one call issues N
  rows, so per-row audit would be N near-identical writes saying less). A refresh, a double-click
  or a replayed call writes **nothing** — integration H1 asserts exactly one row across three
  calls; H2/H3 assert zero rows for a refused call.
* `actorUserId` is the buyer; `actorType` stays the default human actor (no fabricated `SYSTEM`
  id — this path is user-initiated, unlike Phase 7's provider webhook which uses the explicit
  `PROVIDER` marker).
* Payload: order number, order id, event id, counts, `status: "ISSUED"` and the created codes —
  which are public by design. No name, email, phone, token, hash, header or secret; asserted by
  test (`H1`) and by the static guards.

---

## 17. Security tests

| Attack | Result | Test |
| --- | --- | --- |
| Unauthenticated issue / wallet read | 401 | F4 (route + API) |
| Another customer reads the ticket | 404, no data | F2, and over HTTP in §15 |
| Another customer issues the order | 404 | F2, F3 |
| Another tenant's owner issues the order | 404 | I1 |
| Manipulated `ticketCode` (wrong shape, traversal, SQL fragment, valid-but-unissued) | 404; malformed rejected before any query | F5 |
| Malformed path parameter through the route | 400 from Zod | I6 |
| `userId`/`holderUserId`/`organizerId`/`paymentStatus`/`ticketStatus`/`paidAt`/`qrPayload` in a request | stripped; no schema field exists | I2 |
| Cross-site POST to issuance | 403 before any work | I3 (handler); proxy is the outer layer |
| Client-controlled quantity | impossible: the plan comes from `EventOrderItem.quantity` | B4 (catalogue edited after purchase) |
| Client-controlled identity | impossible: session-only | I2, static guards |
| Ticket for an unpaid/failed/cancelled/expired/blocked order | refused | A2–A6 |
| Duplicate request | 0 additional rows | C1, C2, E6 |
| Slot collision forced at the database level | `P2002` | E7 |

---

## 18. Test baseline vs final

```text
BASELINE (Phase 7 final, as recorded in TICKETING_PHASE7_REPORT.md)
  suites        52
  tests         1274
  failed        2      passing 1272
  failing suites 6    (p0/remediation.integration, marketing/profile-phone-shipping,
                       marketing/m7-audit-fixes, marketing/campaign-optional-audit,
                       marketing/address-shipping-ux, ipaymu/production-hardening)

FINAL (this phase, full suite, --runInBand)
  suites        55     (+3: the three Phase 8 suites)
  tests         1349   (+75)
  failed        2      passing 1347   ← the SAME two failing tests, no new ones
  failing suites 6     ← the SAME six as baseline

PHASE 8 SUITES
  __tests__/ticketing-issuance/issuance.integration.test.ts             35 tests
  __tests__/ticketing-issuance/issuance-concurrency.integration.test.ts  9 tests
  __tests__/ticketing-issuance/issuance-wiring.test.ts                  31 tests
                                                                        ── 75 tests, 75 passing
  Stable across 3 consecutive runs (75/75 each).

REGRESSIONS
  None attributable to Phase 8.
  One pre-existing intermittent failure surfaced (§24.1): payment-races H1.
  When it fires, the same run reports 7 failing suites / 3 failing tests — the six
  baseline suites plus payment-races, and the two baseline tests plus H1.
```

---

## 19. TypeScript result

```text
npx tsc --noEmit      exit 0, no output
```

Zero errors. The one type defect found during implementation was fixed rather than suppressed:
`ticketWalletQuerySchema.upcoming` used `.optional().transform(…)`, which zod infers as a
*required* key of type `boolean | undefined` and which forced three call sites to pass
`upcoming: undefined` for no benefit. It is now `.transform(…).optional()`, so the field is
genuinely optional and the parse behaviour is unchanged.

---

## 20. ESLint result

```text
BASELINE   512 problems (348 errors, 164 warnings)
FINAL      512 problems (348 errors, 164 warnings)     ← identical
```

No new lint problem was introduced. Scoped lint over only the Phase 8 surface reports **2
errors, both pre-existing** and both in Phase 6 components
(`components/orders/OrdersPage.tsx`, `components/orders/ReservationCountdown.tsx`,
`react-hooks/set-state-in-effect`) — the live repo's unrelated lint debt, which this phase did
not touch or "clean up".

---

## 21. Route classification result

```text
route files on disk      142   (139 after Phase 7; +3 for this phase)
__tests__/authz/route-classification.test.ts   6/6 passing
unclassified routes      0
prefix in both lists     0
```

`proxy.ts` needed no change: `/api/ticketing/` is already a PROTECTED prefix (covers the two
wallet routes **and** the nested issuance route), `/ticketing` is already a PROTECTED page route
(covers both new pages), and nothing new is public. The Phase 8 wiring suite independently
asserts the three routes are protected, that no wallet/issuance path is public, and that no
prefix appears in both lists.

---

## 22. Residue verification

After the full suite (run repeatedly) and after the dev-server fixtures were cleaned:

```text
ticket                        0        eventOrder                0
eventOrderItem                0        ticketReservation         0
payment / paymentTransaction  0        webhookEvent              0
event                         0        ticketType                0
organizer                     0        test users (example.test)  0
audit: ticket.issue           0        sport                     14   ← the 14 seeded sports
retail: products              5        retail: orders          149   ← unchanged
```

* Test fixtures are torn down by event id and by a `p8-`-tagged suffix, so they cannot touch
  another phase's rows or any retail row. The teardown deletes tickets **first**, because
  `Ticket.orderId`/`orderItemId` are `onDelete: Restrict` and a surviving ticket row would block
  the rest of the cleanup.
* **Pre-existing residue found and deliberately NOT deleted:** 261 `ticket_type.*` audit rows with
  `actorUserId = NULL`, left by earlier phases' runs (already recorded in the Phase 6 and Phase 7
  reports; the count is unchanged at 261). Removing another phase's evidence is not this phase's
  call.
* The temporary UI-verification fixtures (one organizer with a member, one sport, one event, one
  ticket type, one paid order with three tickets, two users) were removed by the tool's own
  `cleanup` mode, and the zero-counts above were measured **after** that removal.

---

## 23. Legacy safety verification

```text
git status --short → no change under any of:            (verified by path filter)
  app/api/checkout/**   app/api/orders/**   app/api/payment/**   lib/payment/**
  app/admin/**  app/api/admin/**  lib/admin.ts  components/{cart,checkout,orders}/…
```

* No retail model renamed, repurposed or migrated: `model Order`, `model OrderItem`,
  `model Product`, `model FlashSale` all still exist under their own names, and the ticket layer
  references only ticketing models (asserted).
* No ticketing module imports a retail handler or `lib/payment/**` including `lib/payment/ipaymu`
  (asserted); ticket code reaches the database only through Prisma, and never through SQL.
* The many modified files under `app/admin/**`, `app/api/admin/**`, `lib/admin.ts`, plus
  `auth.ts`, `lib/csrf.ts`, `types/next-auth.d.ts`, `package-lock.json`, `next-env.d.ts`,
  `prisma/schema.prisma` and three legacy migration files, are **`PRE-EXISTING`** working-tree
  modifications: they were present in `git status` before any Phase 8 edit and this phase did not
  touch them.
* No Phase 7 payment module was modified (brief §18). The payment layer does not import the
  ticket layer and vice versa — both directions asserted.

---

## 24. Known warnings

### 24.1 `WARNING` — PRE-EXISTING Phase 7 race: duplicate provider sessions for one order

`__tests__/ticketing-payment/payment-races.integration.test.ts` › **H1** ("eight simultaneous Pay
clicks produce one provider payment, not eight") fails intermittently.

```text
Isolated runs (that suite alone, no Phase 8 suite loaded):   3 passed / 2 failed  out of 5
Full-suite runs:                                             3 of 4 failed H1
Observed failure:  gatewayStub.calls has length 2 —
                   reference_id "EVT-1789610793722-c774416d"
                   reference_id "EVT-1789610793722-c774416d#2"
```

**Cause.** `lib/ticketing/payment/service.ts` derives the attempt number with a non-atomic
`prisma.payment.count({ where: { orderId } }) + 1` and relies on the unique `paymentReference` as
the claim (§30.3's "database rejects the second write"). That guard only serialises callers that
compute the **same** attempt number. A caller whose `count()` reads *after* the winner's row
commits computes attempt 2, builds `…#2`, and its insert succeeds — so a second gateway session is
bought and a second `Payment` row exists for one order. The window is the gap between the COUNT
and the INSERT, so its width is a function of database latency, which is why it passed during
Phase 7's run and reproduces now.

**Why it is not fixed here.** Brief §18 closes this boundary: "Do NOT modify
`lib/ticketing/payment/**` … unless a proven Phase 7 bug directly blocks issuance." This bug does
not block issuance (issuance consumes an already-`PAID` order and never creates a payment). It is
a duplicate-attempt/double-charge risk and **needs an explicit decision** — the natural fix is to
claim the attempt transactionally (insert with a DB-derived sequence, or a partial unique index on
`(orderId)` where status is non-terminal) so the loser always takes the resume path.

**Not a Phase 8 regression.** Proven by isolation: the suite fails with **no Phase 8 module on the
path**. `createOrderPayment` reads its own explicit `select` (`id, orderNumber, userId,
organizerId, status, paymentStatus, total, currency, expiresAt, buyerName, buyerEmail,
buyerPhone`) and does not use `ORDER_PAYLOAD_SELECT`, `lib/ticketing/tickets/**` or any other
Phase 8 artifact. The only Phase 8 edits that touch shared code are additive union members in
`audit-log.ts` and new permission strings in `permissions.ts`.

### 24.2 `WARNING` — the QR image is client-rendered from a server-fixed payload

See §7. The encoded content is decided server-side and cannot be substituted by the client, but
the SVG is produced by `qrcode.react` in a client component, mirroring the existing
`ShareEventMenu` convention. If the operator reads brief §54's "QR is server-generated" as
requiring a server-rasterised image, that is the same decision as D-46's recommendation and should
be taken together with it.

### 24.3 `WARNING` — no delivery channel exists, so the generated scanner token is never emitted

`Ticket.qrTokenHash` is `NOT NULL UNIQUE`, so every ticket must carry a real credential — and one
is generated and hashed per ticket. **No path in this build emits its plaintext**, by design:
`§26.6` rejects handing the permanent token to a browser, and delivery (email/WhatsApp) is a later
phase. Consequence for Phase 9: the wallet QR encodes the *public code*, so it is a lookup
identifier rather than a scan credential, and the check-in phase must either receive the token
through an out-of-band channel or explicitly accept code-based lookup. This is the second half of
D-46 and is stated rather than papered over.

### 24.4 `WARNING` — issuance is not invoked by the webhook

The design's ideal (§5.1, §11.4, §21 row 4, §31.5) is that issuance runs inside the settlement
transaction, triggered by the verified webhook, only when the settlement CAS reports
`affectedRows = 1`. Phase 7 built the settlement and deliberately did not issue tickets; brief §18
forbids modifying it. So issuance is a **separate, re-runnable step** invoked by
`POST /api/ticketing/orders/{n}/issue`, exactly as brief §17 permits ("implement a dedicated
ticket issuance service that can safely be invoked after payment"). The design's *uniqueness*
invariants are preserved by the database rather than by the trigger's location — the row lock and
`@@unique([orderItemId, sequenceNo])` make a duplicate call create nothing — and the endpoint
cannot make an order paid. What is **not** yet true: tickets are materialised when a *buyer* asks,
not when the payment settles, so a paid order can sit unissued until someone opens the page.

### 24.5 `WARNING` — no runner for the reaper; the phase added no infrastructure

`expireDueReservations()` still has a mechanism and no runner (a Phase 5/7 finding, unchanged by
this phase). No cron, `setInterval`, BullMQ, Redis or worker was introduced anywhere in the
ticketing tree (asserted); the only timer in `lib/ticketing/**` remains Phase 6's documented
backoff in `db-contention.ts`.

### 24.6 `WARNING` — audit durability

The `ticket.issue` row is written after the transaction commits and the helper swallows its own
failures, so a busy audit table can never fail a fulfilment — at the cost of a possible missing
audit row. Same contract as Phase 7.

---

## 25. Explicitly unresolved decisions

| ID | Question | Status here | Why it did not block |
| --- | --- | --- | --- |
| **D-46** | Short-lived display token vs server-rendered QR image | `DECISION REQUIRED` — mechanism implemented per §23.4's content rule + the design's recommendation; the image is client-rendered (§7, §24.2) | §23.4/§26.6 *force* the payload shape independently of D-46 |
| **D-08** | Does a refund return quota to sale? | `DECISION REQUIRED` — not implemented | Refunds are `OUT OF SCOPE`; nothing in issuance touches quota |
| **D-28** | Block check-in for a ticket with an open refund request? | `DECISION REQUIRED` — not implemented | Check-in and refunds are `OUT OF SCOPE`; the design's own check-in phase consumes it |
| **D-39** | Is Email mandatory at launch (vs WhatsApp + wallet only)? | `DECISION REQUIRED` — not implemented | Delivery is `OUT OF SCOPE`; the wallet is the delivery mechanism this phase ships |
| **D-01 / D-04 / D-06** | PIC tracking-link model, attribution window, per-order vs per-line | `DECISION REQUIRED` — not implemented | PIC is `OUT OF SCOPE`; `Ticket` carries no PIC column and none was invented |
| **D-09** | Repayment / reopen of terminal orders | `DECISION REQUIRED` — not implemented | No reopen path exists; a blocked order stays blocked |
| **D-20** | Settlement model | `DECISION REQUIRED` — untouched | Settlement/payout is `OUT OF SCOPE` |
| **D-22** | Who bears the platform/PIC fee | `DECISION REQUIRED` — untouched | No fee arithmetic exists in issuance (`Ticket` has no money columns at all) |
| **D-26** | Free-ticket settlement | `DECISION REQUIRED` — not implemented | Issuance requires `PAID`/`PAID`; a zero-total order is never interpreted as permission to issue |
| **D-33** | Guest checkout | `DECISION REQUIRED` — not implemented | Every ticket route requires a session; ownership is the whole boundary |
| **D-60** | `TicketType` name uniqueness within an Event | `DECISION REQUIRED` — untouched | No `@@unique([eventId, name])` and no substitute was added |
| **D-61** | API money representation | `UNCHANGED` | The ticket payloads carry **no money at all** (design §19.1), so the decision does not arise on this surface |
| **D-16** | iPaymu `expired` unit | `WARNING` (from Phase 7, unchanged) | Payment untouched |
| **D-31** | Pre-issued-quantity ticket model | `RESOLVED as not used` | `TicketStatus.RESERVED` exists but issuance only ever writes `ISSUED` |
| — | Staff/support ticket read override (design §26.6 "authorized, audited") | `DECISION REQUIRED` — not implemented | No such permission exists in the Phase 3 map; inventing one would be new authority, so only the customer path ships |

---

## 26. Acceptance criteria (brief §54)

```text
[x] PAID / PAID order can issue tickets                    A1, I4
[x] PENDING_PAYMENT cannot issue                           A2
[x] FAILED cannot issue                                    A3
[x] CANCELLED cannot issue                                 A4
[x] EXPIRED cannot issue                                   A5 (expired by the real reaper)
[x] fulfilmentBlockedAt blocks issuance                     A6, E5
[x] quantity is derived from EventOrderItem.quantity        B4 (catalogue edited afterwards)
[x] exact ticket count is produced                          B1, B2, B3, E1, E2
[x] multiple order items are handled correctly              B3
[x] repeated issuance is idempotent                         C1, C2, E6
[x] concurrent issuance is idempotent                       E1, E2, E4
[x] partial issuance can recover                            D1, D2, E4
[x] ticket codes are unique                                 C3, E7
[x] ticket codes are stable                                 G4
[x] QR payload is stable                                    G1, G4
[x] QR payload contains no PII                              G2, static guards
[x] QR is server-generated (content)                        G1, §7 (image note: §24.2)
[x] ticket ownership is enforced                            F2, F4, I5
[x] cross-user ticket access returns 404                    F2, F5, I5, and over HTTP §15
[x] cross-tenant access is denied                           I1
[x] audit logging uses existing ticketing audit system      H1, static guards
[x] duplicate issuance creates no misleading duplicate audit H1
[x] no payment code was changed                             payment diff empty, static guards
[x] no inventory counters were changed by issuance          E8 (byte-identical incl. version)
[x] no reservation behavior was changed                     static guards
[x] no retail code was changed                              §23
[x] no refund behavior was added                            static guards
[x] no check-in workflow was added                          static guards
[x] all routes are classified                               142/142, classification suite green
[x] TypeScript passes                                       tsc exit 0
[x] Phase 8 tests pass                                      75/75, stable over 3 runs
[x] baseline regressions = 0                                the same 6 suites / 2 tests (§18, §24.1)
[x] residue = 0                                             §22
[x] retail data unchanged                                   5 products / 149 orders
[x] no migration unless genuinely required                  MIGRATION: NONE
[x] report created                                          this file
[x] no commit / no push / no history rewrite                 §27
```

---

## 27. Git status

```text
Commit created:     NO
Push performed:     NO
History rewritten:  NO
```

No `git commit`, `git push`, `git reset`, `git checkout --`, `git clean`, `git restore` or
`git rebase` was run. All pre-existing working-tree modifications
(`next-env.d.ts`, `package-lock.json`, `prisma/seed-regions.js`, the `app/admin/**` /
`app/api/admin/**` / `lib/admin.ts` / `auth.ts` / `lib/csrf.ts` / `types/next-auth.d.ts` /
`prisma/schema.prisma` / legacy migration edits) are preserved untouched.

**Created:** the 12 application files and 4 test files in §3.
**Modified:** the 5 files in §3.
**Deleted:** none. The temporary `scripts/p8-ui-verify.ts` (+ its manifest) was created for the
dev-server verification and removed afterwards.

---

## 28. Phase 9 dependencies and final summary

Phase 9 (not started) will need from this phase:

1. **A decision on D-46** and a delivery channel for the scanner token (§24.3), or an explicit
   decision that check-in resolves the public code.
2. **An issuance invocation model** other than "the buyer asks": either the hook the design
   intended inside settlement (which brief §18 forbade this phase from adding) or a defined
   internal caller, so a paid order cannot sit unissued (§24.4).
3. **D-28** before any check-in UI exists (open-refund guard), and **D-08** before any refund
   touches quota.
4. The 261 pre-existing `ticket_type.*` audit rows remain in the development database as another
   phase's evidence (§22).

### Summary

Phase 8 turns a paid, fulfilment-eligible `EventOrder` into exactly `SUM(EventOrderItem.quantity)`
`Ticket` rows — once, whoever asks, however many times, and after any crash. The guarantee is
carried by three mechanisms the tests attack separately: a row lock that serialises an order's
issuers, a database unique constraint that cannot be argued with, and a plan derived from existing
rows rather than from a flag. Ownership is structural rather than a check, money never appears on
this surface at all, payment and inventory are provably untouched, and no unresolved business
decision was guessed.

75 new tests pass, three times in a row; the full suite is +3 suites and +75 tests with the same
**six** failing suites and the same **two** failing tests as the Phase 7 baseline; the schema is
unchanged (**MIGRATION: NONE**); the lint total is byte-identical; all 142 routes are classified;
and the database holds zero residue. The one thing that is worse than the baseline is
not mine: Phase 7's payment-attempt race, reproduced in isolation, located, and reported instead
of quietly patched inside a phase whose brief forbids touching it (§24.1).

```text
PHASE 8 STATUS: PASS WITH WARNINGS
```
