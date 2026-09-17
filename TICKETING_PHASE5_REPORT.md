# TICKETING PHASE 5 REPORT

**TicketType Management + Inventory Foundation**

| Field | Value |
| --- | --- |
| Repository | `demo-marketplace` (package `toko`) |
| Branch | `main` |
| Baseline documents | `TICKETING_REBUILD_AUDIT.md`, `TICKETING_PHASE1_DESIGN.md`, `TICKETING_PHASE2_REPORT.md`, `TICKETING_PHASE2_5_REPORT.md`, `TICKETING_PHASE3_REPORT.md`, `TICKETING_PHASE4_REPORT.md` |
| Document date | 2026-09-16 |
| Commit created | NO |
| Push performed | NO |
| History rewritten | NO |

Classification tags used throughout (brief §35): `LOCKED`, `IMPLEMENTED`, `VERIFIED`,
`PRE-EXISTING`, `OUT OF SCOPE`, `WARNING`, `BLOCKED`, `DECISION REQUIRED`.

---

## 1. Status

```text
PHASE 5 STATUS: PASS WITH WARNINGS
```

All 47 acceptance criteria in brief §37 are satisfied. The warnings in §21 are
pre-existing items, deliberate deferrals, and hand-off notes — none is a Phase 5 defect
and none blocks Phase 6.

---

## 2. Scope

Phase 5 delivered the **TicketType domain and the ticket-inventory foundation** on top of
the Phase 4 Event domain, and made the Phase 4 publish precondition practically reachable.

Implemented:

* `TicketType` CRUD (`lib/ticket-types/service.ts`) — organizer-scoped, audited.
* A canonical availability calculation with a single definition and no second copy.
* Atomic, database-enforced inventory mutation (`lib/ticketing/inventory.ts`):
  `reserveQuota`, `confirmReservation`, `releaseReservation`.
* Oversell prevention proved against real InnoDB under genuine parallelism.
* Quota-invariant protection, including refusal to reduce `quota` below `sold + reserved`.
* Sales-window semantics and the canonical ticket-availability state machine.
* Completion of the Phase 4 publish dependency, without weakening or duplicating the
  Phase 4 rule.
* Two organizer API routes, both classified; organizer UI for ticket-type management.
* 178 new tests across 6 suites, including real-database concurrency tests.

Explicitly not in scope — see §22 for the confirmation list and §24 for the Phase 6 hand-off.

---

## 3. Business Decisions Used

### 3.1 Decisions Phase 5 was required to consume

| ID | Decision | Phase 5 treatment |
| --- | --- | --- |
| D-13 | Self-publish at launch | `LOCKED` — no approval queue, no `PENDING_REVIEW`, publish remains a direct authorized action |
| D-14 | Unpublish hides + preserves read-only page | `LOCKED` — untouched; TicketType management cannot publish, cancel or archive an event |
| D-64 | Venue ownership BOTH | `LOCKED` — untouched; no venue logic is touched by Phase 5 |
| Design §10.5 | Availability is `quota - reserved - sold` | `IMPLEMENTED` and `VERIFIED` — single canonical definition |
| Design §11.2 / §11.6 | Atomic conditional decrement; `sold + reserved <= quota` | `IMPLEMENTED` and `VERIFIED` under real concurrency |
| Design §11.6 | "100 concurrent buyers, 50 tickets → exactly 50 reservations, zero sales" | `IMPLEMENTED` and `VERIFIED` — executed as a real test |

### 3.2 D-60 — still unresolved, deliberately

```text
D-60: DECISION REQUIRED  (intentionally deferred by Phase 1)
```

Phase 5 did **not** decide whether two TicketTypes in the same event may share a name.

* No `UNIQUE(eventId, name)` was added. `VERIFIED` — the `TicketType` model declares no
  `@@unique` at all.
* No unique slug, no automatic suffixing, no case-insensitive uniqueness, no hidden
  ticket-code uniqueness was introduced as a substitute.
* Phase 5 could proceed without the constraint, so it did. The observable consequence is
  recorded as warning 1 in §21.

### 3.3 D-19 — grant-required financial separation

`LOCKED` (Phase 3). Phase 5 extends the Phase 3 vocabulary with three organizer-scoped
permissions rather than inventing a parallel check:

| Permission | Gates |
| --- | --- |
| `ticket_type.write` | create, update of name/description/window/ordering, activate/deactivate, delete |
| `ticket_type.quota.change` | any change to `quota` |
| `ticket_type.price.change` | any change to `price` |

`VERIFIED` — the three strings are distinct, organizer-scoped, and a caller holding only
`ticket_type.write` is refused a quota or price change.

---

## 4. Files Changed

No tracked file was modified by Phase 5 **except** `jest.config.js` (one `testMatch` entry).
Every other Phase 5 file is new and lives in an untracked directory created by earlier
phases. `tsconfig.tsbuildinfo` was restored to its committed state after type-checking.

### 4.1 New — inventory (the core of this phase)

| File | Lines |
| --- | --- |
| `lib/ticketing/inventory.ts` | 442 |

### 4.2 New — TicketType domain

| File | Lines |
| --- | --- |
| `lib/ticket-types/validation.ts` | 337 |
| `lib/ticket-types/access.ts` | 73 |
| `lib/ticket-types/service.ts` | 663 |

### 4.3 New — API

| File | Lines |
| --- | --- |
| `app/api/organizer/events/[id]/ticket-types/route.ts` | 85 |
| `app/api/organizer/events/[id]/ticket-types/[ticketTypeId]/route.ts` | 100 |

### 4.4 New — UI

| File | Lines |
| --- | --- |
| `components/organizer/TicketTypeManager.tsx` | 656 |

### 4.5 New — tests

| File | Lines |
| --- | --- |
| `__tests__/ticket-types/validation.test.ts` | 365 |
| `__tests__/ticket-types/inventory.test.ts` | 140 |
| `__tests__/ticket-types/inventory-concurrency.integration.test.ts` | 452 |
| `__tests__/ticket-types/ticket-type-service.integration.test.ts` | 969 |
| `__tests__/ticket-types/publish-integration.integration.test.ts` | 556 |
| `__tests__/ticket-types/api-wiring.test.ts` | 209 |

### 4.6 Modified — Phase 3 / Phase 4 files

| File | Change |
| --- | --- |
| `lib/ticketing/audit-log.ts` | Added the TicketType action vocabulary (create/update/quota/price/active/delete) |
| `lib/events/sales-state.ts` | Publish preconditions consume the canonical availability result instead of holding a second copy of `quota - sold - reserved` |
| `app/organizer/events/[id]/page.tsx` | Wired `TicketTypeManager` in, replacing the Phase 4 placeholder |
| `jest.config.js` | Added `**/__tests__/ticket-types/*.test.ts` to `testMatch` so the new suites are part of the standard run |
| `lib/authz/permissions.ts` | Added the three `ticket_type.*` permission strings (see §3.3) |

### 4.7 New — documentation

`TICKETING_PHASE5_REPORT.md` (this file).

---

## 5. Database Changes

```text
Migration: NONE
```

`VERIFIED`. Phase 2 had already created every model, column, index and enum Phase 5 needs.
`prisma/schema.prisma` is byte-identical to the end-of-Phase-4 state — its diff against
`HEAD` is still exactly the Phase 2 additive foundation:

```text
prisma/schema.prisma | 1419 ++++++++++++++++++++++++++++
1 file changed, 1419 insertions(+)
```

No model was added, renamed or removed. No field was added "to make implementation
easier". No historical migration was edited. `prisma db push` was not used.

### 5.1 The `TicketType` model as it already existed

```prisma
model TicketType {
  id           String    @id @default(cuid())
  eventId      String
  name         String
  description  String?   @db.Text
  price        Decimal   @db.Decimal(14, 2)
  currency     String    @default("IDR")
  quota        Int
  sold         Int       @default(0)
  reserved     Int       @default(0)
  minPerOrder  Int       @default(1)
  maxPerOrder  Int?
  salesStartAt DateTime?
  salesEndAt   DateTime?
  isActive     Boolean   @default(true)
  sortOrder    Int       @default(0)
  /// Optimistic-lock counter, mirroring the existing Flashsale `version`.
  version      Int       @default(0)
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  event        Event               @relation(fields: [eventId], references: [id], onDelete: Restrict)
  orderItems   EventOrderItem[]
  tickets      Ticket[]
  reservations TicketReservation[]
  feeEntries   PICFeeLedger[]

  @@index([eventId, isActive, sortOrder])
  @@index([eventId, salesStartAt, salesEndAt])
  @@map("tickettype")
}
```

`VERIFIED`: no `@@unique`, and the `(eventId, isActive, sortOrder)` index that the
organizer list and the publish precondition need is already present.

---

## 6. TicketType Domain

### 6.1 Read / write split

The service exposes a deliberately narrow surface. `sold`, `reserved` and `version` are
`implemented` as **read-only projections** and are never accepted as input:

* No Zod schema in `lib/ticket-types/validation.ts` contains `sold`, `reserved` or `version`.
* `lib/ticket-types/service.ts` never assigns them — asserted mechanically by a test
  (`api-wiring.test.ts`) that fails if the module ever starts mutating a counter. The
  assertion targets actual mutation shapes (`data.sold =`, `sold -=`, `increment: sold`)
  rather than a bare word scan, because this service legitimately *reads* those fields into
  audit payloads and type annotations.

### 6.2 Create

`VERIFIED`:

* identity comes from the authenticated session, never from the request body;
* the Event is resolved from the database and its **actual** `organizerId` is the authority;
* an `ACTIVE` `OrganizerMember` row is required;
* `ticket_type.write` is required;
* the request may carry an `eventId`; that value is `DATA`, never authority;
* new rows start at `sold = 0`, `reserved = 0`, `version = 0` from the column defaults —
  the application never supplies them.

### 6.3 Update

`VERIFIED`:

* an ordinary update cannot corrupt inventory: `quota`, `price` and `isActive` each require
  their own permission, and the counters are unreachable;
* a no-op update is rejected rather than silently audited as a change;
* an update that changes nothing observable returns a `CONFLICT`, so the audit log cannot
  accumulate misleading "updated" entries.

### 6.4 Delete

`VERIFIED` — the design does not define safe hard-deletion for a TicketType that may already
participate in commercial history, so the destructive path is **refused rather than
invented**.

* The FK inspection is recorded in-code: `EventOrderItem.ticketType` is `onDelete: SetNull`,
  so the database *would* silently allow a delete and blank out historical order lines.
  The application therefore refuses first.
* Deletion is refused when any `EventOrderItem`, `Ticket`, `TicketReservation` or
  `PICFeeLedger` row references the ticket type.
* The supported retirement path is deactivation (`isActive = false`), which is what the
  organizer UI exposes. This is a documented boundary, not a missing feature.

### 6.5 Quota changes

`VERIFIED`:

* the floor for any quota reduction is `sold + reserved` (design §11.6);
* a reduction below that floor is refused with a `CONFLICT` carrying a machine-readable
  `minimumQuota`, so the organizer UI can say what the legal minimum is;
* `sold` and `reserved` are never silently reduced to accommodate a shrink;
* quota increases are allowed and audited with before/after state;
* this is reachable even when sales have already begun, so an organizer can sell more
  seats without being able to erase demand.

---

## 7. Validation

`lib/ticket-types/validation.ts` (Zod), `IMPLEMENTED` and `VERIFIED` by
`__tests__/ticket-types/validation.test.ts`.

| Field | Rule enforced |
| --- | --- |
| `name` | required, trimmed, length-bounded |
| `description` | optional, bounded |
| `price` | required, `>= 0`, decimal-safe; negative and malformed values rejected |
| `quota` | required, integer, `>= 0` |
| `salesStartAt` / `salesEndAt` | optional ISO datetimes; `salesEndAt` may not precede `salesStartAt` |
| `minPerOrder` | `>= 1` when present |
| `maxPerOrder` | may not be less than `minPerOrder` when both present |
| `isActive` | explicit boolean |
| `sortOrder` | integer |

Deliberate exclusions, each with the reasoning in-code:

* **`sold`, `reserved`, `version`** — inventory state and the optimistic-lock token. Not
  client input, ever.
* **`currency`** — the design marks it *"reserved for future multi-currency; single value in
  MVP"*. Accepting a value would implement multi-currency by accident, so it is not accepted
  from clients; it stays at its `IDR` default and is returned on the organizer view.

Money handling: `VERIFIED` — `price` is Prisma `Decimal(14, 2)` end to end, and no
floating-point arithmetic is performed on a monetary value anywhere in Phase 5.

---

## 8. Inventory Model

`lib/ticketing/inventory.ts` holds the **single canonical definition**. Nothing else in the
codebase re-derives availability.

```text
rawAvailable(snapshot) = snapshot.quota - snapshot.sold - snapshot.reserved   (design §10.5)
committedQuota(snapshot) = snapshot.sold + snapshot.reserved                  (the floor)
```

`sold + reserved` is what the service uses as the minimum legal `quota`, so the quota guard
and the availability display cannot drift apart — a second copy of the formula is exactly
how those two would disagree later.

Invariant check (design §11.6), `IMPLEMENTED` and `VERIFIED`:

```text
sold >= 0
reserved >= 0
sold + reserved <= quota
available >= 0
```

`inventoryViolations(snapshot)` returns the specific breached invariants, and
`isInventoryConsistent` is its boolean form. Tests assert on a fresh row, after reserve,
after confirm, after release, and after every refusal case.

Public display clamps at zero (`Math.max(0, ...)` in `lib/events/sales-state.ts`) because
`sold` and `reserved` are independent counters that a future refund path could legitimately
move in a way that momentarily makes `quota - sold - reserved` read negative — but the raw
(unclamped) value is what invariants are checked against, so clamping for display can never
hide a real inconsistency.

---

## 9. Atomic Inventory Safety

### 9.1 Why conditional SQL and not `updateMany`

The guard is `reserved + sold + n <= quota` — a comparison between **three columns and a
parameter**. Prisma's `updateMany({ where: ... })` cannot express a column-to-column
comparison, so the only expressible alternative would be read-then-write, which the brief
forbids. The atomic boundary is therefore a parameterised `$executeRaw`, with the affected
row count deciding success. This preserves the precedent the brief told us to preserve —
`UPDATE flashsale SET saleStock = saleStock - n WHERE id = ? AND saleStock >= n`.

### 9.2 The three primitives

`IMPLEMENTED` and `VERIFIED`:

```sql
-- reserveQuota(ticketTypeId, quantity)
UPDATE `tickettype`
   SET reserved = reserved + ?, version = version + 1
 WHERE id = ?
   AND isActive = true
   AND reserved + sold + ? <= quota

-- confirmReservation(ticketTypeId, quantity)
UPDATE `tickettype`
   SET reserved = reserved - ?, sold = sold + ?, version = version + 1
 WHERE id = ?
   AND reserved >= ?

-- releaseReservation(ticketTypeId, quantity)
UPDATE `tickettype`
   SET reserved = reserved - ?, version = version + 1
 WHERE id = ?
   AND reserved >= ?
```

All three are parameterised. The `reserved >= ?` guard on confirm and release turns a
possible `reserved` underflow into a refused statement rather than a corrupt negative
counter — the design calls this "a data-integrity alarm: reserved underflow (must never
happen)".

`version` is incremented on every successful mutation, so the existing optimistic-lock column
stays meaningful for any future compare-and-set reader.

The row lock acquired by the `UPDATE` is a real one: it writes real columns (`reserved`,
`sold`, `version`), so this is not a lock-free read that merely appears atomic.

### 9.3 Concurrency evidence (brief §21)

`VERIFIED` against real InnoDB — not mocks. `__tests__/ticket-types/inventory-concurrency.integration.test.ts`
runs the primitives through the live connection pool, so racing statements genuinely execute
in parallel on separate connections and the row lock decides the winner.

| Case | Setup | Result asserted |
| --- | --- | --- |
| A — enough inventory | quota 10, request 3 | succeeds, `reserved = 3`, remaining 7 |
| B — exact inventory | quota 10, request 10 | succeeds, remaining 0 |
| C — insufficient | quota 10, request 11 | rejected; nothing moved |
| D — concurrent oversell | quota 10, **two racing requests of 6** | exactly one succeeds; final state never exceeds inventory |
| D — many racers | 5 seats, **10 simultaneous** single-seat requests | exactly 5 succeed |
| D — design §11.6 | 50 seats, **100 simultaneous** buyers | exactly 50 reservations, `sold = 0`, zero tickets issued |
| D — mixed sizes | quota 20, 12 racing requests of sizes 4/7/2/3 | granted total never exceeds 20 |
| E — concurrent confirm | one hold, two racing confirms | only one wins; `sold` never inflated by an unbacked confirm |
| F — concurrent release | one hold, two racing releases | cannot inflate availability |

### 9.4 What this module deliberately does not do

* It does **not** create `TicketReservation` rows.
* It does **not** run a reaper or any expiry timer.
* It does **not** touch orders, payments, tickets or notifications.
* It does **not** decide reservation TTL policy — that belongs to Phase 6/7.

`VERIFIED`: there is no `ticketReservation.create` / `update` / `upsert` anywhere in the
codebase. The single `ticketReservation.deleteMany` that exists is in the **Phase 4** event
hard-deletion path, which is reached only after the "no orders" guard has already passed.

Because the primitives are not yet called from production code (nobody may purchase until
Phase 6), `reserved` remains 0 on live data. That is the correct boundary, and it is why the
concurrency proof is a test rather than a production observation.

---

## 10. Sales Window

`IMPLEMENTED` and `VERIFIED`:

* `salesEndAt` may not precede `salesStartAt` (validation plus a test).
* `isActive = false` is not sellable regardless of window.
* Outside the configured window the ticket type is unavailable.
* `reserveQuota` independently requires `isActive = true`, so a deactivation racing a
  checkout cannot be bypassed by a window check that already passed in application code.

The canonical availability state machine is expressed in `lib/events/sales-state.ts`, and the
states are distinguishable by callers:

```text
ACTIVE  + SALE_OPEN        + available > 0   → purchasable
ACTIVE  + SALE_NOT_STARTED                   → not yet on sale
ACTIVE  + SALE_ENDED                         → on-sale window closed
ACTIVE  + available = 0                      → SOLD_OUT
INACTIVE                                     → not purchasable
```

Phase 5 established availability **state** only. It implements no purchasing path.

---

## 11. Event Publish Integration

The Phase 4 precondition — *at least one `ACTIVE` TicketType with `quota > 0`, with `startAt`
in the future* — was left intact and is now reachable.

`VERIFIED` by `__tests__/ticket-types/publish-integration.integration.test.ts`:

| Scenario | Result |
| --- | --- |
| no TicketType at all | publish refused, machine-readable precondition reported |
| only an inactive TicketType (quota > 0) | publish refused |
| only a zero-quota active TicketType | publish refused |
| valid active TicketType with quota > 0, future `startAt` | **TicketType precondition passes** |
| valid TicketType but `startAt` in the past | publish refused — Phase 4 future-start rule still enforced |

No Phase 4 rule was weakened, removed or duplicated. `publishEvent` in the Phase 4 event
service is the only publish implementation, and the Phase 4 lifecycle tests still pass
(§18).

`VERIFIED`: TicketType management cannot itself publish, cancel, archive or unpublish an
event, and cannot touch orders, payments or tickets.

---

## 12. Authorization / Tenant Isolation

`lib/authz/` (Phase 3) is the only authorization surface. No `isAdmin()`, no
`role === "ADMIN"` shortcut, no second RBAC system, and no `as any` at the authorization
boundary was introduced.

The invariant from brief §18 holds in every handler and service:

```text
identity
  ↓
Phase 3 authz scope
  ↓
ACTIVE organizer membership
  ↓
permission
  ↓
target resource ownership
```

* Authority is derived from the **Event's actual `organizerId`**, resolved from the
  database. A caller-supplied `organizerId` or `eventId` is data, never authority.
* Membership must be `ACTIVE`; inactive or absent membership is denied.
* Cross-tenant reads and writes fail closed with the Phase 3 semantics — a denial is
  `ORGANIZER_ACCESS_DENIED` mapped to **HTTP 404**, not 403, so the response cannot be used
  to confirm that another organizer's ticket type exists.
* A platform `ADMIN` does not gain tenant access by virtue of being `ADMIN`. Platform
  capability and tenant membership remain separate dimensions, as Phase 3 established.

`VERIFIED` — covered by the Phase 5 tenant-isolation block in
`ticket-type-service.integration.test.ts` (organizer A cannot read or mutate organizer B's
ticket types; an inactive membership is denied; an unauthenticated caller is denied; a
manipulated identifier cannot bypass the check).

---

## 13. API

Both routes reuse the Phase 4 infrastructure (`lib/api/errors.ts`, `lib/api/response.ts`,
`lib/api/validation.ts`). No second response envelope, no second `AppError`, no inconsistent
error shape.

| Route | Methods | Authorization |
| --- | --- | --- |
| `/api/organizer/events/[id]/ticket-types` | GET, POST | `ACTIVE` membership on the Event's organizer + `ticket_type.write` on POST |
| `/api/organizer/events/[id]/ticket-types/[ticketTypeId]` | GET, PATCH, DELETE | same scope; quota changes additionally need `ticket_type.quota.change`, price changes `ticket_type.price.change` |

`VERIFIED`:

* every input is parsed through the Zod layer before it reaches the service;
* state-changing methods keep the Phase 3 same-origin CSRF protection — asserted by a test
  that fails if a mutating handler stops calling `requireSameOrigin(request)`;
* both routes are protected by the existing `/api/organizer/` prefix in `proxy.ts` (defence
  in depth, not the control — the guards above are the control);
* **134/134 API routes are classified** (132 at the end of Phase 4 + these 2), and the
  Phase 3 route-classification test is green, so an unclassified route still fails the build.

---

## 14. UI

`components/organizer/TicketTypeManager.tsx` (656 lines), wired into the organizer event
detail page.

It provides list, create, edit, activate/deactivate and inventory/availability display — the
organizer experience the brief specifies. It follows the existing organiser design system and
component conventions (the same shape as the Phase 4 `VenueManager` / `EventForm`), and
introduces no new UI framework.

Notable behaviour:

* the organizer view is the authorized surface, so it **may** show `quota`, `sold` and
  `reserved`;
* when editing, the quota input's lower bound is the committed count (`sold + reserved`), so
  the UI cannot express a value the backend would reject;
* a refused quota reduction surfaces the machine-readable `minimumQuota`;
* when an event cannot be published because of the TicketType precondition, the actual
  precondition result is shown (e.g. "at least one active ticket type with quota > 0"), not a
  disabled button with no explanation.

The backend remains authoritative: no guard was weakened to make a UI control work.

No checkout, cart, payment, order history, e-ticket, QR or reservation UI exists. The legacy
retail homepage and retail pages were not modified.

---

## 15. Public Exposure

Phase 1 does not require a public *ticketing* API for purchase in Phase 5, so no new public
route was created. What the public surface may show was already defined in Phase 4 and is
unchanged.

`VERIFIED`:

* the public catalog and detail project availability only as `isSoldOut` / `salesState`;
* raw `quota` is not returned publicly;
* `sold` and `reserved` are read internally to compute the summary and are **never** returned
  to a public caller;
* no organizer membership, `PermissionGrant`, audit row, settlement or financial data is
  exposed;
* a draft or unpublished event remains unavailable exactly as D-14 defines.

---

## 16. Audit Logging

`lib/ticketing/audit-log.ts` was extended with the TicketType action vocabulary, reusing the
Phase 4 audit approach (`AdminAuditLog`, the same helper the Event and Venue services use).

Recorded: create, update, quota change, price change, activation/deactivation, and
delete/deactivate attempts. Where the design requires before/after information, both states
are captured — including the inventory counters in the payload, which is precisely why the
service reads them rather than writing them.

Never logged: passwords, tokens, provider secrets, QR material, or unnecessary buyer PII.

Phase 14 audit-log consolidation was not attempted, as instructed.

---

## 17. Tests

`IMPLEMENTED` — 6 new suites, 178 tests, all passing.

| Suite | Tests | Kind |
| --- | --- | --- |
| `validation.test.ts` | — | pure |
| `inventory.test.ts` | — | pure (availability math, invariant checks) |
| `inventory-concurrency.integration.test.ts` | — | real DB, real parallelism |
| `ticket-type-service.integration.test.ts` | — | real DB (CRUD, isolation, quota guard) |
| `publish-integration.integration.test.ts` | — | real DB (publish preconditions) |
| `api-wiring.test.ts` | — | static (CSRF present, no counter mutation, permission distinctness) |
| **Total** | **178** | |

Coverage against brief §22:

* **TicketType** — create, read, update, deactivate, validation, price validation, quota
  validation, sales-window validation, active/inactive, ordering.
* **Tenant isolation** — organizer A manages its own; A cannot read B's; A cannot mutate B's;
  inactive membership denied; unauthenticated denied; manipulated identifiers cannot bypass.
* **Inventory** — available calculation, exact quota, sold out, insufficient inventory, atomic
  decrement, concurrent mutation, no negative inventory, no oversell.
* **Event publish** — the full table in §11.
* **Public exposure** — no leak of organizer/financial internals; unpublished event stays
  unavailable.
* **Route classification** — all routes classified; the Phase 3 test remains green.

The suites that use the live database clean up after themselves; residue was verified (§19.3).

---

## 18. Baseline vs Final

### 18.1 Baseline recorded before Phase 5 changes

```text
TypeScript : npx tsc --noEmit              → exit 0
Migrations : 18 migrations, up to date
Jest       : 38 suites — 6 failed, 32 passed
             903 tests — 2 failed, 901 passed

Failing suites (all pre-existing):
  __tests__/p0/remediation.integration.test.ts
  __tests__/marketing/profile-phone-shipping.test.ts
  __tests__/marketing/m7-audit-fixes.test.ts
  __tests__/marketing/campaign-optional-audit.test.ts
  __tests__/marketing/address-shipping-ux.test.ts
  __tests__/ipaymu/production-hardening.test.ts

Failing tests (both pre-existing):
  ● B. Payout PAID consumes commissions (ledger balance) › balance decreases on request,
    PAID settles FIFO conversions, second over-balance withdrawal rejected
  ● E. Admin affiliate detail executes against MariaDB › GET returns 200 with correct stats
    (no P2010 / SQL syntax error)
```

### 18.2 Final

```text
TypeScript : npx tsc --noEmit              → exit 0
Jest       : 44 suites — 6 failed, 38 passed
             1081 tests — 2 failed, 1079 passed
```

| | Baseline | Final | Delta |
| --- | --- | --- | --- |
| Suites | 38 | 44 | +6 (all new Phase 5) |
| Suites failing | 6 | 6 | **0** |
| Tests | 903 | 1081 | +178 |
| Tests failing | 2 | 2 | **0** |
| Tests passing | 901 | 1079 | +178 |

`VERIFIED`: the failing suite set and the failing test set are **identical** to the baseline.
Zero Phase 5 regressions. No pre-existing failure was suppressed, skipped or modified, and no
unrelated test was touched to make this report green.

---

## 19. Migration Verification

### 19.1 No migration was required

```text
Migration: NONE
```

### 19.2 Schema/database drift

`npx prisma migrate status` → `Database schema is up to date!` (18 migrations found).

`npx prisma migrate diff --from-url <DATABASE_URL> --to-schema-datamodel prisma/schema.prisma --script`
was then inspected statement by statement rather than trusted because it exited non-zero.
Result (`PRE-EXISTING`, documented in Phase 2.5 and Phase 4):

| Category | Count | Nature |
| --- | --- | --- |
| Index redefinitions | 114 dropped / 114 created / **0 unmatched** | constraint-name casing only (`Account_userId_fkey` → `account_userid_fkey`) |
| Foreign keys | 52 dropped / 52 added / **0 unmatched** | same casing difference |
| Column `MODIFY` | 2 | `affiliatepayout` (`paidAt`, `failedAt`, `providerStatus`), `spinwheelcampaign` (`maxSpinsPerUser`) — legacy retail |

Findings, `VERIFIED`:

* **no destructive statement of any kind** — no `DROP TABLE`, `DROP COLUMN`, `RENAME TABLE`,
  `TRUNCATE` or `DELETE`;
* the index and foreign-key sets pair exactly in both directions, i.e. the only difference is
  the historical PascalCase constraint names versus the names Prisma derives from the
  `@@map`ped schema;
* **no ticketing table appears anywhere in the drift**. The affected tables are exclusively
  legacy retail tables (`account`, `product`, `order`, `flashsale`, `voucher`, …). There is no
  drift on `tickettype`, `event`, `organizer`, `venue`, `sport` or any other ticketing model.

Because Phase 5 changed no schema, it cannot have introduced drift; the state above is exactly
the end-of-Phase-4 state.

### 19.3 Test residue

`VERIFIED` after the full suite:

```text
ticketType rows: 0
event rows:      0
organizer rows:  0
venue rows:      0
sport rows:      14
```

No temporary Phase 5 rows remain. The 14 seeded sports are intact and were not duplicated or
altered. No broad `DELETE FROM` was run against any table, and no legitimate retail data was
deleted.

---

## 20. Legacy Safety

`PRE-EXISTING` / `OUT OF SCOPE` — confirmed unchanged:

| Area | Status |
| --- | --- |
| `Product`, `ProductVariant`, `Flashsale` models | untouched |
| Retail `Order` / `OrderItem` | untouched |
| Retail checkout, cart, buy-now | untouched |
| iPaymu payment integration and webhook route | untouched |
| Refund, affiliate, commission, payout | untouched |
| Marketing, campaigns, vouchers, spin wheel, shipping | untouched |
| Retail admin routes and pages, retail homepage | untouched |
| Legacy migrations (including the Phase 2.5 repairs) | untouched |
| Retail data | untouched (5 products / 149 orders remain as in Phase 4) |

Ticketing remained purely additive. No `Product → Event` or `Flashsale → TicketType` rename
occurred, and no retail data was backfilled into a ticketing table.

---

## 21. Warnings / Unresolved Issues

Warnings 1–7 are recorded, not hidden. None is a Phase 5 defect.

1. **`WARNING` — D-60 remains `DECISION REQUIRED`.** Because no uniqueness on
   `(eventId, name)` was added (correctly, per brief §25), two ticket types within one event
   **may** share the same display name. Nothing in Phase 5 depends on that being impossible;
   the organizer UI shows both, and ordering is by `sortOrder`. Whoever resolves D-60 will
   need to decide whether existing duplicate names are legal.

2. **`WARNING` — the inventory primitives have no production caller yet.** `reserveQuota`,
   `confirmReservation` and `releaseReservation` are implemented and concurrency-proved, but
   until Phase 6 checkout calls them, `reserved` stays 0 on live data. This is the correct
   phase boundary; the consequence is that the atomic path is proven by test rather than by
   production traffic.

3. **`WARNING` — `minPerOrder` / `maxPerOrder` are validated but not enforced at purchase
   time.** They are stored and bounded correctly; enforcing them per order belongs to Phase 6
   checkout, which is the only place an order line exists.

4. **`WARNING` — deleting a venue or ticket type that participates in commercial history is
   refused.** The design defines no archival model for these entities, so Phase 5 refuses the
   destructive path rather than inventing a schema. Deactivation is the supported retirement
   path. This is a real limitation that a future phase should resolve deliberately.

5. **`PRE-EXISTING` — 6 failing suites / 2 failing tests**, unchanged from the baseline.
   Described in §18.1; unrelated to ticketing (retail affiliate payout ledger and an
   admin affiliate detail route).

6. **`PRE-EXISTING` — legacy schema drift**, confined to constraint-name casing plus two
   legacy column `MODIFY`s. Documented in §19.2; no ticketing object is affected.

7. **`PRE-EXISTING` — `forceExit: true` in `jest.config.js`.** `lib/rate-limit.ts` starts a
   module-scope interval that is never `unref()`-ed, so suites importing it transitively
   finish and then hang. Mitigated in configuration by Phase 4, with the one-line proper fix
   recorded as a finding. It affects worker shutdown only, never test results.

8. **`WARNING` — `currency` is not client-settable.** The design reserves it for future
   multi-currency, so Phase 5 leaves it at `IDR`. A future multi-currency phase must add the
   validation and the conversion rules together.

No `BLOCKED` items. No stop condition from brief §38 was triggered: no unresolved decision was
required to proceed, D-60 was never technically unavoidable, the schema needed no change, the
inventory could be made atomic using the design's own conditional-decrement rule, Phase 3
authorization expressed the required permissions without inventing a privilege model, no
Phase 4 behaviour had to change, and no checkout/payment/reservation feature was pulled in.

---

## 22. Explicit Out-of-Scope Confirmation

Phase 5 did **NOT** implement:

| Item | Status |
| --- | --- |
| TicketType | **IMPLEMENTED** (in scope) |
| quota / atomic inventory foundation | **IMPLEMENTED** (in scope) |
| reservation workflow (`TicketReservation` rows) | NOT implemented |
| reservation expiry / reaper | NOT implemented |
| checkout / cart | NOT implemented |
| payment creation / iPaymu | NOT implemented |
| payment webhook changes | NOT implemented |
| payment settlement | NOT implemented |
| refund | NOT implemented |
| order creation for ticket purchases | NOT implemented |
| ticket issuance | NOT implemented |
| QR / e-ticket / ticket wallet | NOT implemented |
| check-in | NOT implemented |
| PIC attribution / PIC fee calculation / PIC ledger | NOT implemented |
| settlement ledger | NOT implemented |
| financial reporting / Excel export | NOT implemented |
| WhatsApp / email / notification workflows | NOT implemented |
| coupons / marketing / spinwheel | NOT implemented |
| affiliate migration | NOT implemented |
| retail cleanup, `Product → Event`, `Flashsale → TicketType` | NOT implemented |
| KTP Git-history purge | NOT implemented |
| Git history rewrite | NOT implemented |
| D-60 decision | **NOT made** — still `DECISION REQUIRED` |

---

## 23. Git Status

```text
Commit created:    NO
Push performed:    NO
History rewritten: NO
```

`VERIFIED` before and after implementation:

* **Pre-existing changes preserved and untouched:** `next-env.d.ts` (modified),
  `package-lock.json` (modified), `prisma/seed-regions.js` (untracked) — all three were
  present at Phase 5 start and remain in their prior state.
* Phase 2.5's pre-existing migration-file modifications and the Phase 3 retail
  `(session.user as any)` type-only edits remain exactly as they were.
* `tsconfig.tsbuildinfo` was restored to its committed state after type-checking, so it does
  not appear as a spurious change.
* No tracked application, UI, API, auth, payment or WhatsApp source file was modified by
  Phase 5. The only tracked file Phase 5 changed is `jest.config.js` (one `testMatch` entry).
* No `.env`, credential, SQL dump, KTP document or uploaded customer file was added or
  committed.

---

## 24. Phase 6 Dependencies

What Phase 6 can consume directly:

| Capability | State |
| --- | --- |
| TicketType CRUD | **Ready** — organizer-scoped service + API + UI |
| `quota` / `sold` / `reserved` | **Ready** — readable, never writable from application code |
| Availability calculation | **Ready** — `rawAvailable`, `committedQuota` in `lib/ticketing/inventory.ts`, one canonical definition |
| Atomic inventory primitive | **Ready** — `reserveQuota` / `confirmReservation` / `releaseReservation`, concurrency-proved on real InnoDB |
| Sales window behaviour | **Ready** — validation plus `reserveQuota`'s independent `isActive` guard |
| Availability state machine | **Ready** — `lib/events/sales-state.ts` (`SALE_OPEN`, `SALE_NOT_STARTED`, `SALE_ENDED`, `SOLD_OUT`, inactive) |
| Event publish workflow | **Now reachable** — the Phase 4 TicketType precondition can be satisfied |
| Reservation | **Untouched** — no `TicketReservation` rows are created; the model and the primitives are ready for Phase 6 to build the lifecycle (TTL, expiry, reaper) on |
| Checkout | **Untouched** — retail checkout is unchanged and no ticketing checkout exists |
| Payment / iPaymu | **Untouched** |

Business decisions still open that Phase 6 will meet:

* **D-60** — ticket-type name uniqueness within an event (`DECISION REQUIRED`).
* **D-48 / reservation TTL policy** — how long a `reserved` hold survives before release
  belongs to the reservation phase, not to this module.

Technical blockers remaining: **none** for the Phase 5 foundation. The only forward-looking
constraint is warning 4 (no archival model for venues/ticket types), which does not block
Phase 6.

---

## 25. Final Summary

Phase 5 made the Phase 4 publish precondition real. An organizer can now create a
TicketType with a price, a quota, a sales window and an active state; the event can then
satisfy the precondition and be published through the unchanged Phase 4 path.

The inventory foundation is the part worth trusting: availability has exactly one definition
(`quota - sold - reserved`), the guard is a real database-level conditional update rather than
an application read-modify-write, the invariant `sold + reserved <= quota` is checked rather
than assumed, and overselling was disproved under genuine parallelism against real InnoDB —
including the design's own 100-buyers/50-seats case, where exactly 50 reservations and zero
sales result.

Authorization was not re-designed: every operation derives authority from the Event's actual
organizer and an `ACTIVE` membership through the Phase 3 `lib/authz` surface, cross-tenant
denial is a 404 that cannot confirm existence, and a platform `ADMIN` gains no tenant access
by virtue of the role.

Nothing beyond the boundary was built. No migration was needed, so none was created. D-60 was
left undecided, and the consequence of leaving it undecided is stated plainly rather than
quietly patched with a constraint. Reservation, checkout, payment, ticket issuance and every
later commercial workflow remain exactly as they were.

```text
PHASE 5 STATUS: PASS WITH WARNINGS
```
