# TICKETING PHASE 10B — REFUND DOMAIN AUDIT

## Audit-only report

**Scope.** This phase audits the existing repository for REFUND support. It is
**audit only**. No refund service, API, UI, webhook action, state transition, quota
change, authorization change, iPaymu change, dashboard change, checkout change or
settlement change was made. `AUTH_URL` and production deployment configuration were
not touched. Nothing was committed or pushed. Only this report file was created.

**Method.** A repository-wide search for `refund`, `refunded`, `refund.completed`,
refund status/amount, provider refund, iPaymu refund, refund webhook, refund
transaction, refund ledger and `refundedAmount`, followed by direct inspection of the
Prisma schema, migrations, payment services, webhook handler, gateway adapter, iPaymu
adapter, order service, ticket services, PIC fee ledger, audit log, API routes,
dashboard code, tests and the design/audit reports.

**Verification (audit does not rewrite code).**

| Check | Command | Result |
| --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | **0 errors** |
| Tests | `npx jest --runInBand` | **45 suites / 1035 tests passed** |
| Build | `npm run build` | **succeeds** |

**Headline finding.** Refunds are **schema-only plus inbound detection**. The data
model, enums, permissions, audit vocabulary seam and a webhook classification path all
exist, but **nothing creates, approves, executes, records or completes a refund**. The
legacy retail refund engine (`lib/refund.ts`) was deleted with the retail application
and has not been replaced. The Phase 9 audit statement — *"Refund (`refund.completed`)
… = Phase 9 work"* — remains accurate.

---

## 1. Current refund implementation

### 1.1 What exists

| Layer | State | Evidence |
| --- | --- | --- |
| Refund domain model | Present, adapted to ticketing, **unused** | `prisma/schema.prisma:294-318` (`Refund`), `:1544-1560` (`RefundItem`), `:571` (`RefundFeeTreatment`) |
| Order/aggregate fields | `EventOrder.refundedAmount` present, always `0` | `schema.prisma:981` |
| Ticket fields | `Ticket.refundedAt`, `Ticket.refundItem` present, always `NULL` | `schema.prisma:1082`, `:1096` |
| Ledger seam | `PICFeeLedger.refundId` and `fee:reversal:{refundId}` key convention present, unused | `schema.prisma:1426`, `:1430-1432` |
| Event policy fields | `Event.returnQuotaOnRefund` (`false`), `Event.refundDeadlineAt` (`NULL`) present, unused | `schema.prisma:844`, `:846` |
| Refund enums | `RefundFeeTreatment` exists. **No `RefundStatus`** | `schema.prisma:571` |
| Payment transaction type | `PaymentTransactionType.REFUND`/`CHARGEBACK` declared, never written | `schema.prisma:447-453` |
| Inbound detection | Gateway classifies a refund notification and maps it to `refund.completed` | `lib/ticketing/payment/gateway.ts:703-713`, `:742-748` |
| Webhook handling | Records the delivery and **ignores** it | `lib/ticketing/payment/webhook.ts:521-535` |
| Authorization | `refund.request` / `refund.approve` / `refund.execute` wired into role maps | `lib/authz/permissions.ts:166-168`, `:267-269`, `:353-354`, `:379-381`, `:431-433`, `:466-468`, `:493-495`, `:567` |
| Errors | `REFUND_NOT_ALLOWED` (409) defined | `lib/api/errors.ts:51`, `:94`, `:120` |
| Audit vocabulary | Refund actions deliberately absent | `lib/ticketing/audit-log.ts:83`, `:91` |
| Rate limiting | `refundRequest` bucket was deleted with retail | `lib/rate-limit.ts:155` |

### 1.2 What does **not** exist

- No refund service (`lib/ticketing/refund/` absent; `lib/refund.ts` deleted — `git status`
  shows ` D lib/refund.ts`, file no longer on disk).
- No refund API route. `app/api/refunds` does not exist; the only `refund` mentions in
  `app/api` are comments (`.../orders/[orderNumber]/cancel/route.ts:21`,
  `.../organizer/events/[id]/unpublish/route.ts:15-17`).
- No refund execution wired into settlement, webhook, orders, tickets, ledger or quota.
- No read/write of `Refund`, `RefundItem`, `refundedAt`, `refundedAmount`,
  `refundNumber`, `feeTreatment`, `refundDeadlineAt` or `returnQuotaOnRefund` anywhere in
  `.ts`/`.tsx`; a repository-wide search returns only comments and tests.
- No refund UI; the public `app/refund-policy/page.tsx` is generic **retail** policy text
  (shipping/damaged goods), not ticketing refund policy.

### 1.3 Tests that lock the current (no-refund) behaviour

- `__tests__/ticketing-issuance/issuance-wiring.test.ts:417-422` — asserts the issuance
  path does **not** call `prisma.refund.(create|update)` and does not set
  `refundedAt: new Date(...)`.
- `__tests__/ticketing-payment/payment-wiring.test.ts:409-413` — asserts the payment path
  does **not** call `prisma.refund.create`.
- `__tests__/ticketing-payment/payment-webhook.integration.test.ts:655-665` — *"C4. a
  refund notification is recorded and never acted on"*, expecting outcome
  `REFUND_OUT_OF_SCOPE`.
- `__tests__/ui-consolidation/checkin-gate.test.ts:131` — asserts the check-in schema does
  **not** yet contain `REJECTED_REFUND_PENDING` (D-28 unimplemented).
- `__tests__/authz/permission-map.test.ts:153` — covers `REFUND_APPROVE` as
  grant-required for `ADMIN`.

**Conclusion.** The feature is **not implemented at runtime**. What exists is the
storage shape, inbound classification, the permission vocabulary and the ledger seam —
all placed by earlier phases, none exercised.

---

## 2. Current data model

### 2.1 `Refund` (`schema.prisma:294-318`, `@@map("refund")`)

Current columns: `id Int @id @default(autoincrement())`, `createdAt`, `updatedAt`,
`refundNumber String? @unique`, `organizerId String?`, `eventOrderId String?`,
`requestedByUserId String?`, `requestedByRole String?`, `approvedByUserId String?`,
`approvedAt DateTime?`, `feeTreatment RefundFeeTreatment?`, `idempotencyKey String?
@unique`. Relations: `organizer`, `eventOrder`, `items RefundItem[]`, `feeEntries
PICFeeLedger[]`. Indexes on `createdAt`, `organizerId`, `eventOrderId`.

The model comment (`:288-293`) records that the **retail** columns were removed — retail
`orderId`, `amount`, `reason`, `status`, `requestedBy`, `processedBy`, `providerRef` —
and that the ticketing path addresses refunds by `eventOrderId`. It also states
*"Nothing writes this table yet."*

Key consequence: **there is no header-level `amount`, `status`, `reason` or
`providerRef`.** The only `amount` lives on `RefundItem`.

### 2.2 `RefundItem` (`schema.prisma:1544-1560`, `@@map("refunditem")`)

`id String @id @default(cuid())`, `refundId Int`, `ticketId String @unique`,
`orderItemId String?`, `amount Decimal(14,2)`, `createdAt`. Relations to `Refund`,
`Ticket`, `EventOrderItem`. Indexes on `refundId`, `orderItemId`.

`ticketId` is **unconditionally unique** — the documented double-refund guarantee.

### 2.3 The twelve schema questions

| # | Question | Answer | Detail |
| --- | --- | --- | --- |
| 1 | Is there already a `Refund` model? | **Yes** | `schema.prisma:294`, adapted/trimmed, unused |
| 2 | Is refund represented by `PaymentTransaction`? | **Partly, unused** | `PaymentTransactionType.REFUND` exists (`:449`) but no code writes a `REFUND` transaction. `Refund`/`RefundItem` are the ticketing refund record |
| 3 | Is there a refund status enum? | **No** | No `RefundStatus`. Only `RefundFeeTreatment` (`REVERSED/RETAINED/ADJUSTED`, `:571`) |
| 4 | Is there `refundedAmount` on `EventOrder`? | **Yes** | `Decimal(14,2) @default(0)` (`:981`), never updated |
| 5 | Is partial refund representable? | **At item level, yes; at header level, no** | `RefundItem.amount` per ticket + `OrderStatus.PARTIALLY_REFUNDED` + `refundedAmount`; but `Refund` has no `amount`/`status`, so a header cannot state how much or which request won |
| 6 | Are multiple / partial refund requests representable? | **Structurally yes; no lifecycle** | No `orderId @unique`; many `Refund` rows per order, many `RefundItem` rows per refund. Missing: a `status` to distinguish pending/processing/completed/failed/rejected, so overlapping requests cannot be arbitrated |
| 7 | Is refund idempotency representable? | **Yes (2 mechanisms)** | `Refund.idempotencyKey @unique` (`:307`) and generic `IdempotencyKey` (`:1598`, `@@unique([userId, scope, key])`, example scope `"refund.create"`). `PICFeeLedger.idempotencyKey @unique` for reversal keys |
| 8 | Is a provider refund reference representable? | **No dedicated column** | The design's `providerRef` was removed from `Refund`. `PaymentTransaction.providerTransactionId` and `WebhookEvent.providerTransactionId` could carry one, but `Refund` has no field and no link to `WebhookEvent` |
| 9 | Is refund reason representable? | **No** | `reason` was removed. (`EventOrder.cancelReason` and `Ticket.voidReason` exist; `Refund` has none) |
| 10 | Is refund actor representable? | **Partly** | `requestedByUserId`, `requestedByRole`, `approvedByUserId`, `approvedAt` exist. `processedByUserId` (who executed) does not |
| 11 | Is a refund timestamp representable? | **Partly** | `createdAt`/`updatedAt`/`approvedAt`. No `completedAt`/`failedAt`/`rejectedAt` |
| 12 | Is a refund webhook event representable? | **Partly** | Generic `WebhookEvent` (`:1247`) with `eventType`, `statusCode`, `amountReported`, `processingStatus`; gateway emits `refund.completed`; `PaymentTransactionType.REFUND` exists. Missing: any refund-specific linkage (`WebhookEvent.refundId`), and no `PaymentTransaction` refund row is written |

### 2.4 Enums relevant to refund

| Enum | Values | Written by refund code? |
| --- | --- | --- |
| `OrderStatus` (`:411-418`) | `PENDING_PAYMENT`, `PAID`, `CANCELLED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED` | `REFUNDED`/`PARTIALLY_REFUNDED` **never** written |
| `PaymentStatus` (`:421-429`) | `UNPAID`, `PENDING`, `PAID`, `FAILED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED` | `REFUNDED`/`PARTIALLY_REFUNDED` **never** written |
| `PaymentTransactionType` (`:447-453`) | `PAYMENT`, `REFUND`, `CHARGEBACK`, `FEE`, `ADJUSTMENT` | only `PAYMENT` written |
| `TicketStatus` (`:463-469`) | `RESERVED`, `ISSUED`, `CHECKED_IN`, `VOID`, `REFUNDED` | `REFUNDED` **never** written |
| `WebhookProcessingStatus` (`:455-460`) | `RECEIVED`, `PROCESSED`, `IGNORED`, `FAILED` | refunds set `IGNORED` only |

### 2.5 Migrations

- `prisma/migrations/20260827000000_add_refund_system/migration.sql` — created the
  legacy retail refund table and a `REFUND_PENDING` order status (retail).
- `prisma/migrations/20260916000000_ticketing_phase2_foundation/migration.sql` — added the
  ticketing refund columns (`refundNumber`, `approvedAt`, `returnQuotaOnRefund`,
  `refundDeadlineAt`, `refundedAmount`, `refundedAt`, `refundId`), created `refunditem`,
  and the unique indexes `refund_refundNumber_key` / `refund_idempotencyKey_key` plus the
  `organizerId` / `eventOrderId` indexes.

No migration adds a refund `status`, `amount`, `reason`, `processedBy` or `providerRef`;
those are the gaps section 11 lists.

---

## 3. Current payment state machine

### 3.1 Declared states

```
PaymentStatus : UNPAID → PENDING → PAID → (REFUNDED | PARTIALLY_REFUNDED   ← declared, never reached)
                        PENDING → FAILED
                        PENDING → EXPIRED
OrderStatus   : PENDING_PAYMENT → PAID → (REFUNDED | PARTIALLY_REFUNDED     ← declared, never reached)
                PENDING_PAYMENT → CANCELLED
                PENDING_PAYMENT → EXPIRED
TicketStatus  : RESERVED → ISSUED → CHECKED_IN
                              ISSUED → REFUNDED | VOID               ← REFUNDED never reached
```

### 3.2 What actually moves state

- `lib/ticketing/payment/settlement.ts` is the only settlement path. It runs one
  transaction that (a) CAS-updates `EventOrder` `PENDING_PAYMENT → PAID` guarded by
  `paymentStatus != PAID`, (b) CAS-updates `Payment → PAID` and inserts a
  `PaymentTransaction` of type `PAYMENT`, (c) per `EventOrderItem` CAS-moves quota
  `reserved -= q, sold += q`. It has no refund branch. Design §13.3 steps 7-10
  (tickets/attribution/PIC ledger/fee snapshots) are absent.
- `lib/ticketing/payment/void.ts` moves an open `Payment` to `EXPIRED` on cancel/expire
  (`PaymentStatus` has no `CANCELLED`; the file documents this at `:20-27`).
- `lib/ticketing/orders.ts` CAS-moves the order to `CANCELLED` only from
  `PENDING_PAYMENT`; a paid order cannot be cancelled (`:90`, `:101-102`).
- `lib/ticketing/reservations.ts` reaps `HELD → EXPIRED` and moves the parent order to
  `EXPIRED`.

### 3.3 Where refund would fit

| Question | Current answer |
| --- | --- |
| Can `PAID` transition to refund? | **No.** No service writes `REFUNDED`/`PARTIALLY_REFUNDED`; `settlement.ts` only produces `PAID` |
| Can a partially refunded payment remain `PAID`? | **Not expressible today.** `PaymentStatus.PARTIALLY_REFUNDED` exists but nothing transitions into it, and there is no rule about whether a partially refunded payment keeps `PAID` |
| Is fully refunded represented separately? | **Enum value exists, semantics undefined.** `PaymentStatus.REFUNDED` / `OrderStatus.REFUNDED` / `TicketStatus.REFUNDED` are declared, never set |
| What happens to `EventOrder`? | Nothing today. Design §18.4 says on completion the order becomes `REFUNDED` or `PARTIALLY_REFUNDED`, and `refundedAmount` accumulates |
| What happens to `Payment`? | Nothing today. A refund would need a rule for which of an order's possibly-multiple `Payment` rows is the settled one and how its status changes |
| What happens to `PaymentTransaction`? | Nothing today. `PaymentTransactionType.REFUND` is the intended record (append-only, `amount`, `providerFee`, `providerTransactionId`), but no code writes it |

**Important structural note.** An order can have **multiple `Payment` rows** (one per
attempt; `Payment.paymentReference` is unique). The refund design must nominate the
settled payment row and must not assume "one payment per order".

**No new states were invented.**

---

## 4. Current ticket lifecycle

### 4.1 What exists

- `TicketStatus` (`schema.prisma:463-469`): `RESERVED`, `ISSUED`, `CHECKED_IN`, `VOID`,
  `REFUNDED`.
- Issuance (`lib/ticketing/tickets/issuance.ts`) creates `Ticket` rows in `ISSUED`, sets
  `issuedAt`, and stores only `qrTokenHash` (raw token shown once). Design §19.3 uses an
  opaque token with `qrVersion` for per-ticket revocation.
- Admission verdicts (`lib/ticketing/tickets/payload.ts:186-212`, `describeAdmission`):
  `ISSUED` → scannable; `CHECKED_IN` → `ALREADY_CHECKED_IN`; `VOID` → `TICKET_VOID`;
  `REFUNDED` → `TICKET_REFUNDED`; `RESERVED` → `NOT_PAID`. So the **read model already
  knows how a refunded ticket must present**: non-scannable, reason `TICKET_REFUNDED`.
- `lib/ticketing/tickets/validation.ts:34-39` includes `REFUNDED` in
  `WALLET_STATUS_VALUES`.
- `Ticket.refundedAt` (`:1082`) and the one-to-one `Ticket.refundItem` (`:1096`) exist,
  unused. `RefundItem.ticketId` is unique, so a ticket can be attached to at most one
  refund item ever.
- `CheckIn` (`:1113-1140`) has a unique `ticketId`; the check-in service does **not**
  exist yet (Phase 10 UI is blocked).

### 4.2 The eight scenarios

| # | Scenario | Can the model represent it? | Notes / gaps |
| --- | --- | --- | --- |
| 1 | Customer buys ticket | Yes | Order + reservation + (post-payment) ticket rows |
| 2 | Payment becomes `PAID` | Yes | Payment CAS + quota CAS in `settlement.ts` |
| 3 | Ticket is issued | Yes | `issuance.ts` → `ISSUED`, `issuedAt`, `qrTokenHash` |
| 4 | Ticket is refunded | **Model yes, code no** | Fields exist (`REFUNDED`, `refundedAt`, `refundItem`, `RefundItem`). No code sets them; no QR rotation is performed |
| 5 | Ticket already checked in | **Ambiguous — policy undecided** | `CHECKED_IN` is terminal in design §19.2; there is no guard preventing a refund of a checked-in ticket, because no refund code exists. Design §18.4/§19.2 do not explicitly forbid it (D-R05) |
| 6 | Ticket not checked in | Yes | `ISSUED → REFUNDED` is the designed path |
| 7 | One item of a multi-ticket order is refunded | **Model yes** | Per-ticket `RefundItem`; order → `PARTIALLY_REFUNDED`; sibling tickets untouched |
| 8 | Entire order is refunded | **Model yes** | All tickets → `REFUNDED`; order → `REFUNDED`; `refundedAmount == total` |

### 4.3 Specific guarantees and gaps

- **Duplicate-refund race:** the unconditional unique `RefundItem.ticketId` is the
  structural guarantee against double refund. Consequence: it also permanently blocks a
  *second* refund request for the same ticket even if the first was **rejected** (the row
  is not deleted). This is a concrete design decision to settle (D-R13).
- **QR validity:** `payload.ts` already treats `REFUNDED` as invalid, so refund semantics
  for the *verdict* are in place. However, per-ticket revocation-by-rotation
  (`qrVersion`/`qrTokenHash`) is not wired, and the check-in path that would enforce the
  verdict does not exist yet.
- **Ownership:** `Ticket.holderUserId` exists; per-ticket attribution is present but
  unused.
- **Check-in dependency:** the open-refund check-in guard (design §20.2 check 4,
  `REJECTED_REFUND_PENDING`, D-28) is **not implemented**; `checkin-gate.test.ts:131`
  asserts its absence.

**No check-in functionality was implemented.**

---

## 5. Inventory / quota implications

### 5.1 Current architecture

- Counters live on `TicketType`: `quota`, `sold`, `reserved`
  (`lib/events/sales-state.ts`; `lib/ticketing/inventory.ts`).
- Availability is derived: `remaining = max(0, quota - sold - reserved)`
  (`sales-state.ts:109-111`), clamped at zero because `sold`/`reserved` "could in principle
  leave slightly inconsistent" state after a refund or expiry (`:102-108`).
- `sold` is incremented **only** in `confirmReservation` at settlement.
- `lib/ticketing/inventory.ts:302-303` states verbatim that `sold` is "only ever
  incremented here and decremented by a refund from a later phase
  (`Event.returnQuotaOnRefund`, decision D-08) — nothing in Phase 5 moves it."
- `Event.returnQuotaOnRefund Boolean @default(false)` exists (`schema.prisma:844`), with
  the design-documented default **false**; it is read nowhere.

### 5.2 Current refund effect on `sold` / `reserved` / `available`

**None.** There is no refund code, so a refunded ticket currently changes no counter.
`remaining` is unaffected.

### 5.3 The business decision (D-R06)

The repository deliberately does **not** decide this. The design register
(`TICKETING_PHASE1_DESIGN.md:859`, `:3635`) records D-08 with a designed default of
**no** (do not return quota) and a per-event flag. Open sub-questions, none of which the
code answers:

- Should refunded quantity return to quota at all?
- If yes, **when**: before the gateway refund, after the gateway accepts it, or after the
  `refund.completed` webhook?
- What happens if the gateway refund **fails** — is quota restored or not? (If restored
  before confirmation, a failed refund would have resold a seat that is still valid.)
- What happens on a **partial** refund — is it per refunded ticket?
- Concurrency: returning `sold` needs a guarded decrement (`sold = sold - n` with a
  floor/`>= n` guard) to avoid a value below zero when combined with purchases, and the
  `remaining` clamp already signals the counters are not treated as an invariant today.

**Not implemented.**

---

## 6. iPaymu refund capability

### 6.1 Repository evidence

- `lib/payment/ipaymu.ts` — the **only** `refund` occurrence is a status mapping:
  `if (s === "refunded" || s === "canceled") return "failed";` (`:998`). There is **no
  refund request type, no refund endpoint constant, no refund response parser, and no
  refund reference type.**
- `lib/payment/ipaymu-production.ts` — no refund matches.
- `lib/ticketing/payment/gateway.ts` — **inbound classification only**:
  `isRefundNotification` (`:742-748`) and `eventTypeFor` returning `refund.completed`
  (`:710-713`); the `GatewayEvent.eventType` union includes `refund.completed` (`:670-675`).
  There is no outbound refund call.
- `lib/ticketing/payment/webhook.ts:521-535` records an inbound refund and ignores it.
- Config is fail-closed via `getIpaymuConfig()` (`lib/payment/config.ts`); signature
  verification is the trust boundary.

### 6.2 Verdict

The current adapter has **no outbound refund capability** and the repository contains
**insufficient evidence** to implement one — no refund endpoint path, no request/response
field names, no documented partial-refund semantics, no refund reference format.

> **External iPaymu verification required.**

The inbound `refund.completed` classification is enough to *observe* a provider-initiated
refund notification, but the **shape of a refund request and whether partial refunds are
supported must be confirmed against the iPaymu sandbox/API documentation before any
adapter work.** The adapter was **not** modified on assumptions.

---

## 7. Financial implications

### 7.1 The values and how a refund would touch them

| Value | Where | Refund effect (designed, not implemented) |
| --- | --- | --- |
| `EventOrder.total` | immutable snapshot `schema.prisma:979` | unchanged; refund is tracked separately |
| `EventOrder.refundedAmount` | `:981`, `Decimal(14,2) @default(0)` | **sum of completed `RefundItem.amount`**; must never exceed `total` |
| `Payment.amount` | `:1158` | unchanged (the captured amount) |
| `PaymentTransaction.amount` | `:1222` | a `REFUND` transaction records the refunded amount (append-only) |
| `PICFeeLedger` | `:1401-1454` | `REVERSED`/`ADJUSTMENT` entries with `refundId`, idempotency key `fee:reversal:{refundId}` |
| `organizerNetAmount` | `:980` | reduces by the organizer's share of the refund; interaction with `platformFee`/`gatewayFee` is policy (D-R07/D-R08/D-R10) |
| `gatewayFee` | `:977`, nullable | whether/how it is returned to the buyer or absorbed is policy (D-R08) |
| `platformFee` | `:976` | whether it is refunded is policy (D-R07) |
| `PICFeeLedger` reversal | `:1401+` | fee reversal after payout may require claw-back/net-off (D-R09 / D-18) |

### 7.2 Integrity checks required before coding (not implemented)

- **Double refund** — structurally mitigated by unconditional `RefundItem.ticketId`
  unique. Completion must still be idempotent (a retried webhook/approval must not write a
  second reversal or a second ticket transition).
- **Refund > paid** — enforce server-side using snapshots: `OrderItem.priceSnapshot` per
  ticket, and `refundedAmount + newAmount <= EventOrder.total`.
- **Refund > refundable** — the refundable amount must exclude gateway/platform/PIC
  components according to the policy decided in D-R07/D-R08/D-R09.
- **Decimal precision** — D-61 is **CLOSED**: persist `Decimal(14,2)`, compute in
  `Prisma.Decimal`, serialize as fixed 2-decimal strings (`moneyString`,
  `lib/ticketing/order-payload.ts:44-46`). **Do not introduce integer-rupiah.**
- **Concurrent refund requests** — the ticket-level unique plus a request-level
  `idempotencyKey` are the two available guards; a header `status` (missing today) is
  needed to CAS-arbitrate.
- **Duplicate refund webhooks** — `WebhookEvent.providerEventId @unique` (insert-first)
  plus the "only `PROCESSED` blocks a later verified delivery" rule
  (`webhook.ts:51-73`) already provide replay safety; the refund completion must be
  idempotent under it.
- **Retry safety** — completion must be safe to re-run: CAS on the refund header,
  `RefundItem` unique, `PICFeeLedger.idempotencyKey` unique, guarded `refundedAmount`
  update.
- **Negative balances** — no refund code writes balances today, so this is currently
  impossible; any implementation must guard `sold >= n` and `refundedAmount <= total`.

**No financial value is mutated by refund today.**

---

## 8. Authorization

### 8.1 What is wired

The permission vocabulary (`lib/authz/permissions.ts`) already includes
`refund.request` / `refund.approve` / `refund.execute` (`:166-168`) and places them in the
**organizer** scope (`:267-269`), so every check is tenant-scoped through the existing
`requireOrganizerAccess` / `decideOrganizerPermission` path (no client-supplied
`organizerId` is trusted; membership is the gate).

| Actor | `request` | `approve` | `execute` | Evidence |
| --- | :-: | :-: | :-: | --- |
| Platform `ADMIN` (in-tenant) | yes (map) | **grant-required** | no | map `:353-354`; `ADMIN_GRANT_REQUIRED` `:567`; grant branch `:767-777` |
| Platform `MANAGER` (in-tenant) | yes | yes | yes | `:379-381` |
| Membership `OWNER` | yes | yes | yes | `:431-433` |
| Membership `MANAGER` | yes | yes | yes | `:466-468` |
| Membership `FINANCE` | yes | yes | yes | `:493-495` |
| Membership `PIC` | no | no | no | `PIC` role map `:511` (only attribution read) |
| `CHECKIN_STAFF` | no | no | no | `:513-516` |
| Customer (`OWN` scope) | **not wired** | no | no | `OWN_SCOPE` `:241-250` and `PLATFORM_ROLE_OWN_PERMISSIONS` `:521-550` omit refund |
| Platform `ADMIN` `refund.execute` | — | — | **not held** (matches design §6.3 "Execute = NO" for Admin) | observed map |

`ADMIN` `refund.approve` is expressed through `ADMIN_GRANT_REQUIRED` (`:565-574`,
`:567`): the decision function returns the grant branch before consulting the role map
(`:767-777`), so an ungranted Admin is denied even though the map lists the permission.

### 8.2 What is missing

- **Buyer self-service request.** Design §6.3 (`TICKETING_PHASE1_DESIGN.md:380`) marks
  "Request refund" as `OWN` for a Customer, and §18.6/§26.8 describe a buyer-initiated
  request. The current `OWN_SCOPE` list **does not include** `refund.request`, and the
  customer/PIC own-scope maps do not either. So today **no buyer-facing permission path
  exists**; only staff/organizer actors can be authorized. This is a wiring gap, not a
  policy choice (D-R02 decides whether buyers may self-initiate).
- **A read permission** for a customer to see their own refund status is not defined.
- **Audit actions** (`refund.request`/`approve`/`execute`/`complete`) are absent from
  the audit vocabulary (`lib/ticketing/audit-log.ts:83`, `:91`).

**No authorization code was changed.**

---

## 9. Webhook architecture

### 9.1 The existing pipeline

The order is the security property (`lib/ticketing/payment/webhook.ts:36-49`):

1. read the raw body;
2. verify the signature → invalid ⇒ record, 401;
3. verify the amount → mismatch ⇒ record, 400;
4. `INSERT` the `WebhookEvent` (unique `providerEventId`) → duplicate ⇒ 200 no-op;
5. classify the status → unknown/pending ⇒ record, 200, never mutate;
6. settle (one transaction);
7. mark the ledger row;
8. 200 (500 only for a genuine server error, so the provider retries).

Signature trust is HMAC, not the session; the route
(`app/api/ticketing/payment/webhook/route.ts`) is intentionally public. Replay defence is
the DB unique constraint `WebhookEvent.providerEventId`, and **only a `PROCESSED` row
blocks a later verified delivery** (`:51-73`).

### 9.2 Where `refund.completed` fits now — and why it does not settle

After the ledger row is claimed, classification runs (`:520`). The **exact** current
branch is:

```ts
if (callback.isRefund) {
    await advanceLedgerRow(ledgerId, {
        processingStatus: "IGNORED",
        processingResult: "ignored_refund_flow_is_phase_9",
    });
    return { httpStatus: 200, message: "Notifikasi refund dicatat.",
             outcome: "REFUND_OUT_OF_SCOPE" };
}
```

So a refund notification is **detected, recorded for observability, and never acted on**.
The handler's own header (`:75-79`) documents that refunds are deliberately excluded.

### 9.3 Fitting a real refund completion in

| Stage | Current | Required for refund |
| --- | --- | --- |
| raw body → signature | HMAC verified for all callbacks | unchanged |
| **amount validation** | `amountVerdict(callback, target.total)` compares the reported amount to the **order total** (`:457-489`) | a refund callback reports a **refund** amount, not the order total; the current comparison would misclassify and reject. A refund-specific amount rule is required (must not weaken verification) |
| `WebhookEvent` insert | generic, `providerEventId` unique | reusable as-is |
| event classification | `isRefund` → `refund.completed` (`gateway.ts:710-713`) | reusable; must distinguish refund vs payment explicitly before the amount step |
| settlement/refund processing | none | a new refund-completion transaction, idempotent, behind the same replay guard |
| ledger | `WebhookEvent` ledger only | optionally a `PaymentTransaction` of type `REFUND` |
| response | `refund.completed` ⇒ 200 `REFUND_OUT_OF_SCOPE` | refund completion must be idempotent under redelivery and return 200 |

**Idempotency adequacy.** The existing `WebhookEvent.providerEventId` unique plus the
"only `PROCESSED` blocks" rule is sufficient to make refund callbacks replay-safe, **but
the refund completion itself must also be idempotent** (the webhook may arrive before the
staff-approved refund row exists — the legacy `transitionRefundForWebhook` problem noted
in design §18.1 — and may arrive twice at the application level across retries).

**No webhook security was weakened.**

---

## 10. Required business decisions

The following decisions must be answered **before coding**. For each: current repository
behaviour, what is supported, what is missing, the options, and the technical
consequences. **No policy is chosen here.** Where the design register already states a
*recommendation*, it is cited as the design's recommendation, not as a decision.

### D-R01 — Full refund vs partial refund

- **Current behaviour.** Structurally per-ticket (`RefundItem`), and
  `OrderStatus`/`PaymentStatus` carry `PARTIALLY_REFUNDED`; no header `amount`/`status`.
- **Supported.** Partial at the item level; full by refunding all tickets.
- **Missing.** The policy of *when* partial is allowed (any subset? per order item? whole
  order only?) and header-level amount/status.
- **Options.** (a) full-order only; (b) per-ticket partial; (c) hybrid with a threshold.
- **Consequences.** (a) contradicts the per-ticket model and `PARTIALLY_REFUNDED`;
  (b) needs a header `status` + `amount` and a `refundedAmount <= total` guard, and makes
  order-status derivation non-trivial; (c) adds policy config.

### D-R02 — Who can initiate a refund

- **Current behaviour.** `refund.request` is organizer-scoped; Customer `OWN` request is
  **not wired**.
- **Supported.** Admin (in-tenant), Manager, membership Owner/Manager/Finance.
- **Missing.** Buyer self-initiation path; audit action.
- **Options.** (a) staff-only; (b) buyer requests own, staff approves; (c) both.
- **Consequences.** (b) requires adding `refund.request` to `OWN_SCOPE` and the customer
  own map, plus an ownership predicate (design §26's two-gates pattern); (a) avoids that
  but removes the customer-facing flow.

### D-R03 — Refundable order states

- **Current behaviour.** Only `PAID` implies paid; `CANCELLED`/`EXPIRED` are terminal;
  `PENDING_PAYMENT` is unpaid.
- **Supported.** The state set exists; nothing enforces a refund precondition.
- **Missing.** The allowed set (presumably `PAID`, `PARTIALLY_REFUNDED`).
- **Options.** (a) `PAID`/`PARTIALLY_REFUNDED` only; (b) also paid-but-fulfilment-blocked.
- **Consequences.** Must be a CAS predicate so a refund cannot race a cancel/expire;
  (b) interacts with `fulfilmentBlockedAt` and the operator queue.

### D-R04 — Refund after ticket issuance

- **Current behaviour.** Issued tickets are `ISSUED`; issuance is idempotent and
  one-shot.
- **Supported.** Model can mark tickets `REFUNDED` and invalidate admission.
- **Missing.** Policy on refunding after issuance and whether QR must be rotated.
- **Options.** (a) allowed; (b) allowed only before issuance; (c) allowed with a fee.
- **Consequences.** Issuance happens in the settlement transaction, so "before issuance"
  is a narrow/impossible window for a paid order; allowed-after-issuance requires ticket
  transitions + QR revocation in the completion transaction.

### D-R05 — Refund after check-in

- **Current behaviour.** `CHECKED_IN` is terminal; no refund code; no check-in service.
- **Supported.** Nothing either way.
- **Missing.** Policy; also the D-28 open-refund check-in guard.
- **Options.** (a) forbid; (b) allow (full/partial); (c) allow with override + note.
- **Consequences.** (a) needs a guard (`ticket.status == CHECKED_IN` refuses); (b)/(c)
  create the buy-attend-refund abuse path the design risk register names (`RK-15`,
  `TICKETING_PHASE1_DESIGN.md:3879`).

### D-R06 — Inventory restoration

- **Current behaviour.** `Event.returnQuotaOnRefund` exists (`default false`), read
  nowhere; `sold` never decremented.
- **Supported.** A per-event flag and a `sold` counter.
- **Missing.** The decision, the timing, and failure/partial semantics.
- **Options/timing.** no return; return before gateway; return after gateway; return after
  `refund.completed`.
- **Consequences.** Returning early risks reselling a seat whose refund later fails;
  returning late leaves availability wrong during processing; guarded decrement and a
  `sold >= n` floor are required. (Design register default: not returned, `:3635`.)

### D-R07 — Platform fee treatment

- **Current behaviour.** `EventOrder.platformFee` snapshot; no refund logic.
- **Supported.** The column exists.
- **Missing.** Whether the platform fee is refunded.
- **Options.** full / partial / non-refundable.
- **Consequences.** Affects `organizerNetAmount` and `refundedAmount` math; must be
  disclosed at checkout if non-refundable.

### D-R08 — Gateway fee treatment

- **Current behaviour.** `EventOrder.gatewayFee` (nullable) and
  `PaymentTransaction.providerFee` exist; `RefundFeeTreatment` exists with values
  `REVERSED/RETAINED/ADJUSTED` (note: the design text at `:1528` proposed
  `GATEWAY_FEE_NON_REFUNDABLE/FULL/PARTIAL` — an unreconciled naming/semantic
  discrepancy).
- **Supported.** Storage for the treatment.
- **Missing.** Policy and the enum reconciliation.
- **Options.** non-refundable (design recommendation at `:1561`) / refunded / partial.
- **Consequences.** Enum reconciliation is a migration; the fee affects
  `organizerNetAmount` and the provider reconciliation.

### D-R09 — PIC fee treatment

- **Current behaviour.** `PICFeeLedger` is append-only with `REVERSED`/`ADJUSTMENT`,
  `refundId`, and a `fee:reversal:{refundId}` idempotency convention. No reversal code.
- **Supported.** Ledger mechanics; nothing writes them.
- **Missing.** Whether a PIC fee is reversed on refund, and after payout vs before.
- **Options.** reverse / retain / adjust; and claw-back vs net-off (design D-18,
  `:1276`, recommends net-off with a threshold).
- **Consequences.** After-payout reversal needs a negative carry-forward entry; must be
  idempotent on the completion key.

### D-R10 — Organizer net amount treatment

- **Current behaviour.** `organizerNetAmount` snapshot; no refund math.
- **Supported.** The column.
- **Missing.** How the organizer's settlement is reduced, and cadence interaction
  (D-21 hold).
- **Options.** reduce immediately / on next settlement / absorb.
- **Consequences.** Interacts with settlement runs that do not yet exist; a refund after
  payout may require the same claw-back/net-off decision as D-R09.

### D-R11 — Refund timing: synchronous vs asynchronous

- **Current behaviour.** Payment settlement is webhook-driven; there is no background
  worker (design notes say so) and no outbound refund call.
- **Supported.** A request/approve/execute lifecycle is designed but absent.
- **Missing.** Whether execution is synchronous or provider-confirmed asynchronously.
- **Options.** (a) synchronous staff "execute" calling the provider; (b) asynchronous
  submit-then-webhook-confirm; (c) manual/off-platform with recorded reference.
- **Consequences.** (b) needs a `PROCESSING` state and the refund-webhook branch that is
  currently an ignore; (c) requires provider-ref/documented reconciliation.

### D-R12 — Gateway refund failure

- **Current behaviour.** No refund call; `Refund` has no `status`/`failedAt`.
- **Supported.** Nothing.
- **Missing.** Failure handling and whether quota/ticket changes are rolled back.
- **Options.** retry / auto-reject / manual.
- **Consequences.** Must define whether a failure after quota restoration resells the
  seat; requires a `FAILED` status and a retry path.

### D-R13 — Duplicate refund request

- **Current behaviour.** `RefundItem.ticketId` is **unconditionally** unique; `Refund.
  idempotencyKey` and generic `IdempotencyKey` exist.
- **Supported.** Structural double-refund prevention; idempotency keys.
- **Missing.** Behaviour on a same-ticket request after a **rejected/failed** refund —
  the unique row persists, so re-requesting is impossible. Also no header status to CAS.
- **Options.** (a) permanent block; (b) allow re-request after rejection (needs a partial
  unique or a status-aware check — Prisma has no partial unique index); (c) reuse the
  rejected row.
- **Consequences.** (b) requires an application-level guard instead of the DB unique,
  reducing the race guarantee.

### D-R14 — Duplicate refund webhook

- **Current behaviour.** `WebhookEvent.providerEventId` unique + insert-first + "only
  `PROCESSED` blocks"; refund callbacks return `REFUND_OUT_OF_SCOPE` 200.
- **Supported.** Replay-safe delivery recording.
- **Missing.** Refund completion idempotency.
- **Options.** rely on completion being CAS/idempotent; or add a refund-row state machine.
- **Consequences.** Completion must be safe when the webhook arrives before approval and
  when it arrives twice.

### D-R15 — Refund reference / idempotency

- **Current behaviour.** `Refund.refundNumber` (nullable unique) and `idempotencyKey`
  (nullable unique); no `providerRef`, no link to `WebhookEvent`/`PaymentTransaction`.
- **Supported.** Internal reference and request idempotency.
- **Missing.** A provider refund reference and its reconciliation link.
- **Options.** add `Refund.providerRef`; or store on `PaymentTransaction.
  providerTransactionId`; or both.
- **Consequences.** A provider reference is required to reconcile the refund against the
  gateway; without it, "external verification required" cannot be closed.

### D-R16 — Customer notification

- **Current behaviour.** Notification design lists `REFUND_CREATED`/`REFUND_COMPLETED`
  (`TICKETING_PHASE1_DESIGN.md:1799-1800`); the notification/delivery models exist.
  No refund code emits any.
- **Supported.** Notification storage/fan-out is designed.
- **Missing.** The events and delivery wiring.
- **Options.** in-app / WhatsApp / email / none.
- **Consequences.** Delivery is a later phase; the decision affects only what to enqueue.

### D-R17 — Audit log requirements

- **Current behaviour.** The audit vocabulary has `order.*` and `payment.*`; the module
  explicitly excludes refunds (`lib/ticketing/audit-log.ts:91`).
- **Supported.** The generic audit write path with `action` as a namespaced string.
- **Missing.** Refund actions and required fields.
- **Options.** `refund.request`/`approve`/`execute`/`complete`/`fail`/`reject`.
- **Consequences.** Required for traceability and for the D-R02/D-R05 overrides; adding an
  action is additive but must be done before the first refund write, or it is unaudited.

---

## 11. Required schema changes

None of these is implemented. Listed for the coding phase.

1. **`RefundStatus` enum + `Refund.status`** (e.g. `PENDING`, `PROCESSING`,
   `COMPLETED`, `FAILED`, `REJECTED`) — the single biggest gap; without it a request
   lifecycle and CAS arbitration are impossible.
2. **`Refund.amount Decimal(14,2)`** — header total, server-authoritative, sum of items.
3. **`Refund.reason String? @db.Text`** — removed with the retail rewrite.
4. **`Refund.processedByUserId String?`** — who executed.
5. **`Refund.providerRef String?`** — provider refund reference (see D-R15).
6. **`Refund.completedAt` / `failedAt` / `rejectedAt`** (or a status-history table) —
   currently only `createdAt`/`updatedAt`/`approvedAt`.
7. **Reconcile `RefundFeeTreatment`** (`REVERSED/RETAINED/ADJUSTED`) with the design
   vocabulary (`GATEWAY_FEE_NON_REFUNDABLE/FULL/PARTIAL`) — a naming/semantic decision,
   possibly a data migration.
8. **Optional `RefundItem`/`WebhookEvent` linkage** (e.g. `WebhookEvent.refundId`) for
   reconciliation.
9. **Revisit the unconditional `RefundItem.ticketId @unique`** against D-R13 (Prisma
   cannot express a partial unique index; this is a real constraint on re-request after
   rejection).
10. Already present and reusable, no change: `EventOrder.refundedAmount`,
    `Ticket.refundedAt`/`refundItem`, `PICFeeLedger.refundId`, `Event.returnQuotaOnRefund`,
    `Event.refundDeadlineAt`, `Refund.idempotencyKey`, `IdempotencyKey`,
    `PaymentTransactionType.REFUND`.

## 12. Required service changes

1. New refund service (e.g. `lib/ticketing/refund/`) implementing
   `request → approve → execute → complete/fail/reject` with the legacy CAS discipline
   described in design §18.1 (`PENDING → PROCESSING → COMPLETED`, idempotent
   `executeRefundCompletion`, webhook transition helper).
2. A refund-completion transaction that atomically: writes `RefundItem`s, transitions
   `Ticket → REFUNDED` (+ `refundedAt`, QR invalidation), accumulates
   `EventOrder.refundedAmount`, derives `OrderStatus`/`PaymentStatus`
   (`REFUNDED`/`PARTIALLY_REFUNDED`), writes `PICFeeLedger` reversal entries (idempotent
   `fee:reversal:{refundId}`), optionally moves quota (D-R06), and writes the audit entry.
3. A webhook refund branch to replace the `ignored_refund_flow_is_phase_9` path, with
   refund-specific amount validation and idempotent completion.
4. Optional `PaymentTransaction` (`type: REFUND`) recording.
5. Extend `lib/ticketing/audit-log.ts` vocabulary with refund actions.
6. Possibly a refund rate-limit bucket (the `refundRequest` bucket was deleted).

## 13. Required API changes

1. `POST /api/refunds` — request (design §26.8, `TICKETING_PHASE1_DESIGN.md:2259-2261`):
   ownership-enforced, `ticketIds[]` + `reason`, server-computed amount, policy/deadline/
   rate-limit checks, `201 { refundNumber, status: PENDING, amount }`.
2. Organizer, permission-gated approve/execute/reject route(s) (design §27 style) using
   `refund.approve` / `refund.execute`.
3. A customer refund read (own requests) — permission/definition missing (section 8).
4. Idempotency scope `"refund.create"` wired into the checkout-style `IdempotencyKey`
   enforcement.
5. If D-R02 = buyer self-service: own-scope `refund.request` permission wiring plus the
   mandatory ownership predicate.

## 14. Required UI changes

1. Customer order/ticket surfaces: request a refund, show refund status, render
   `REFUNDED` tickets in the wallet (the payload already returns the status; the wallet
   value list already includes it).
2. Dashboard: refunds list and approve/execute/reject screens (permission-aware), plus
   refund state on the order/attendee views.
3. **Public `app/refund-policy/page.tsx` currently shows retail policy text** — it needs
   ticketing refund policy, and that policy must exist before sales (design note at
   `:3598`).
4. Event admin form: expose `returnQuotaOnRefund` and `refundDeadlineAt` once D-R06/D-29
   are decided.

## 15. Required tests

The eventual refund phase will need regression tests for:

1. **Payment races** — `__tests__/ticketing-payment/payment-races.integration.test.ts`
   pattern: refund vs cancel/expire, concurrent duplicate refund requests.
2. **Payment webhook** — extend `payment-webhook.integration.test.ts` (its C4 currently
   asserts refunds are ignored) for refund completion, duplicate/replay, amount mismatch,
   and "refund before approval".
3. **Order/payment state** — `PAID → PARTIALLY_REFUNDED → REFUNDED`; invalid transitions
   refused; `refundedAmount` bounds.
4. **Ledger** — `PICFeeLedger` reversal entries, idempotency key reuse, claw-back/net-off.
5. **Ticket issuance/state** — ticket `REFUNDED`, QR/admission invalid, checked-in
   handling (D-R05), partial vs full.
6. **Idempotency** — `Refund.idempotencyKey` and `IdempotencyKey` enforcement.
7. **Inventory** — `sold` behavior per D-R06, guard vs underflow.
8. **Authorization** — role matrix, tenant isolation, buyer own-scope (if D-R02), audit.
9. **Money precision** — fixed 2-decimal strings (D-61 canon).
10. **Failure/retry** — provider refund failure, retry, no partial mutation.

**No refund tests were added** (the feature does not exist); the existing suite already
locks the current no-refund behaviour (section 1.3).

## 16. External verification required

> **External iPaymu verification required.**

Specifically, the following must be confirmed outside the repository before the adapter is
extended:

1. Whether iPaymu exposes a **refund/disbursement endpoint** and its exact path/verb.
2. The **refund request** field names, the amount unit, and the reference format.
3. The **refund response** and how a refund reference is returned.
4. Whether **partial refunds** are supported and how they are identified.
5. The **refund notification** payload shape and the status values, to align with the
   existing `refund.completed` classification (`gateway.ts:710-713`, `:742-748`).
6. Whether the existing signature scheme applies to refund requests/callbacks.

No iPaymu adapter code was changed on assumptions.

## 17. Recommended implementation order

Sequencing only; it does not choose policy.

1. **Close the blocking decisions** needed by the first write: D-R01, D-R02, D-R03,
   D-R04, D-R05, D-R06 (at minimum), and reconcile D-R08's enum naming.
2. **Schema first**: add `RefundStatus`/`Refund.status`, header `amount`, `reason`,
   `processedByUserId`, `providerRef`, completion timestamps; reconcile
   `RefundFeeTreatment`. Migration + Prisma client.
3. **Authorization wiring**: buyer own-scope `refund.request` if D-R02 = self-service;
   audit actions in `audit-log.ts`.
4. **Refund service core**: request/approve/execute with idempotency and CAS; completion
   transaction covering tickets, `refundedAmount`, statuses, ledger reversal, quota
   (per D-R06).
5. **Webhook branch**: refund-specific amount validation + idempotent completion, behind
   the existing `providerEventId` replay guard.
6. **External iPaymu work** (only after section 16 confirms the API): request builder,
   response parser, `providerRef`.
7. **API**: `POST /api/refunds` + organizer approve/execute routes + customer read.
8. **Tests**: the section-15 suite (update the three wiring tests that currently assert
   "no refund execution" only as part of this step).
9. **UI**: customer request/status, dashboard refund screens, public refund policy.
10. **Notifications** (`REFUND_CREATED`/`REFUND_COMPLETED`) as a later phase.

**Dependency note.** D-28 (block check-in for a ticket with an open refund request) is a
shared dependency with the still-unbuilt check-in service; the check-in phase cannot be
completed without it, and a refund implementation that ignores it re-opens the
buy-attend-refund abuse path (`RK-15`).

---

## Strict scope compliance

| Prohibition | Status |
| --- | --- |
| add `Refund` model | not done |
| add refund API | not done |
| add refund UI | not done |
| add refund webhook | not done |
| change Payment/Order/Ticket status | not done |
| change quota | not done |
| modify iPaymu integration | not done |
| modify authorization | not done |
| modify dashboard / checkout / settlement | not done |
| modify `AUTH_URL` / production deployment | not done |
| add unrelated dependencies | not done |
| commit / push | not done |
| create documentation/report files | only `TICKETING_PHASE10B_REFUND_AUDIT.md` |

**Files changed:** `TICKETING_PHASE10B_REFUND_AUDIT.md` (new). No source, schema,
migration, test or configuration file was modified.

**Verification:** `npx tsc --noEmit` 0 errors · `npx jest --runInBand` 45 suites / 1035
tests passed · `npm run build` succeeds. Unrelated pre-existing lint debt was left
untouched.
