# TICKETING PHASE 10B — REFUND IMPLEMENTATION REPORT

## Scope and outcome

This phase implements the ticketing refund lifecycle that
`TICKETING_PHASE10B_REFUND_AUDIT.md` specified but deliberately did not build. The work
covers the data model, the transactional settlement core, authorization, the provider
seam, the inbound webhook confirmation branch, the API routes and the two UI surfaces
(buyer and dashboard), plus a new `__tests__/ticketing-refunds/` suite.

Outcome in one line: **a buyer can request a refund on their own paid order; a different
staff member can approve or reject it; execution always ends in a truthfully-reported
terminal state; nothing — money, quota, tickets, order totals or the PIC ledger — moves
until a refund is CONFIRMED, and the provider seam is honest that iPaymu cannot confirm
one today.**

Environment constraints were honoured: `AUTH_URL` was not changed, no commit or push was
made, no unrelated module was modified, no dependency was added, and no provider API was
invented.

---

## 1. Policy requirements as implemented

The lifecycle is driven by the resolved requirement set cited throughout the code as
`D-R01`–`D-R17`. Read as requirements (what the phase must do), they are:

| ID | Requirement | Where enforced |
| --- | --- | --- |
| R01 | Full **and** partial (per-item / per-ticket) refunds | `refunds/validation.ts`, `refunds/eligibility.ts` |
| R02 | Buyer requests; staff/admin approve and execute; buyer cannot decide their own | `refunds/service.ts`, `authz/permissions.ts` |
| R03 | Only a `PAID`/`PARTIALLY_REFUNDED` order is refundable | `refunds/eligibility.ts` |
| R04 | An `ISSUED` ticket is refundable when otherwise eligible | `refunds/eligibility.ts` |
| R05 | A `CHECKED_IN` ticket is never refundable | `refunds/eligibility.ts` |
| R06 | Quota is restored **only** after a confirmed refund | `refunds/settlement.ts` |
| R07 | Lifecycle `PENDING → APPROVED → PROCESSING → REFUNDED` / `FAILED`, `PENDING → REJECTED` | `schema.prisma`, `refunds/service.ts`, `refunds/settlement.ts` |
| R08 | Partial refunds are ticket/item based | `refunds/service.ts`, `refunds/eligibility.ts` |
| R09 | Requested amount ≤ currently refundable balance | `refunds/eligibility.ts` |
| R10 | A ticket is claimed at most once | `RefundItem.ticketId @unique`, `refunds/eligibility.ts` |
| R11 | Idempotent and race-safe: no duplicate refund/quota restore/ledger reversal/txn/transition | CAS `updateMany` + unique constraints + one transaction |
| R12 | Persist the provider refund reference when one is returned | `refunds/settlement.ts`, `Refund.providerRef` |
| R13 | Persist the reason and the rejection/failure explanation | `refunds/service.ts`, `refunds/settlement.ts` |
| R14 | `EventOrder.refundedAmount` reflects **confirmed** amounts only | `refunds/settlement.ts` |
| R15 | Order/payment/ticket become refunded/partial only after confirmed settlement | `refunds/settlement.ts` |
| R16 | PIC fee reversal is consistent and reuses the existing ledger | `refunds/settlement.ts` (`PICFeeLedger`, no second ledger) |
| R17 | iPaymu refund capability verified before outbound work | `refund-provider.ts` header (verdict: UNSUPPORTED) |

---

## 2. Decision reconciliation with the audit

The audit's §10 numbered its **open questions** `D-R01`–`D-R17` (full/partial, who
initiates, fee treatment, timing, notifications …). The code comments cite a **resolved
requirement set** with the same prefix. The two coincide for R01–R06 and then renumber.
This is recorded here rather than silently resolved, because the audit is the primary
reference a reviewer will open:

| Implementation requirement | Audit §10 question(s) it answers |
| --- | --- |
| R01–R06 | D-R01–D-R06 (same meanings) |
| R07 lifecycle | D-R11 (timing) + D-R07 (fee treatment is deferred to R16) |
| R08 partial selection | D-R01 (partial vs full) |
| R09 amount bound | D-R10 (organizer net) + money-integrity §7 |
| R10 single claim | D-R13 (duplicate request) |
| R11 idempotency/races | D-R14 (duplicate webhook) + D-R15 (idempotency) |
| R12 provider ref | D-R15 |
| R13 reason/audit | D-R13 + D-R17 (audit log) |
| R14 `refundedAmount` | D-R10 |
| R15 propagated status | D-R03 |
| R16 PIC reversal | D-R09 (PIC fee treatment) |
| R17 provider verification | §16 external verification |

**Not implemented in this phase (deliberately):** D-R16 customer notifications
(`REFUND_CREATED`/`REFUND_COMPLETED`), D-R08 gateway-fee accounting, and D-28 (block
check-in for a ticket with an open refund request — it belongs to the still-unbuilt
check-in service). These are listed again in §15.

---

## 3. Data model and migration

`prisma/schema.prisma` was extended, not replaced:

* `enum RefundStatus { PENDING, APPROVED, REJECTED, PROCESSING, REFUNDED, FAILED }`;
* `Refund` gained `refundNumber @unique`, `organizerId`, `eventOrderId`,
  `requestedByUserId/Role`, `requestedAmount`/`confirmedAmount` `Decimal(14,2)`,
  `reason`, `approvedByUserId/At`, `processedByUserId/At`, `providerRef`,
  `completedAt/failedAt/failureReason`, `feeTreatment`, `idempotencyKey @unique`, the
  `items`/`feeEntries` relations and the query indexes;
* `RefundItem` is the per-ticket claim; its `ticketId` is `@unique`, which is the
  database-level guarantee behind R10. It cascades from `Refund` and **restricts** on
  `Ticket` (a claimed ticket cannot be deleted from under its claim);
* `RefundFeeTreatment` (`REVERSED|RETAINED|ADJUSTED`) already existed and is used as-is.

`prisma/migrations/20260918000000_add_refund_lifecycle/migration.sql` is hand-written
because `prisma migrate dev` is blocked by pre-existing, unrelated drift (it demanded a
destructive `migrate reset`, which was not performed). The migration:

1. reconciles the physically-retained legacy retail `refund` table (drops the dead retail
   FK/unique key/columns that made a ticketing insert impossible, and re-maps the six
   legacy `COMPLETED` rows to `REFUNDED`);
2. adds the lifecycle columns and the `RefundStatus` enum;
3. aligns index names with the committed schema.

It was applied with `mysql < file` and recorded with `prisma migrate resolve --applied`.
A snapshot table `refund_backup_phase10b` was taken first. `npx prisma migrate status`
reports the schema up to date (20 migrations); `npx prisma validate` is clean.

---

## 4. Authorization

`lib/authz/permissions.ts` gained one buyer-facing, own-scoped capability:

* `REFUND_REQUEST_OWN: "refund.request.own"` — in `PERMISSIONS`, in `OWN_SCOPE`, and in
  the customer/PIC own maps. It is **not** in any organizer map.
* `REFUND_REQUEST`, `REFUND_APPROVE`, `REFUND_EXECUTE` already existed as organizer-scoped
  capabilities; approve/execute are deliberately absent from every own map, so no role can
  self-approve by capability.

The service then adds the enforceable half of the audit's D-R02: **separation of duties**.
In `approveRefund`, `rejectRefund` and `executeRefund`, after the tenant check, a request
whose `requestedByUserId === actor.userId` is refused with `FORBIDDEN` /
`SEPARATION_OF_DUTIES`. This applies to every requester, not only buyers, which removes the
self-approval question entirely.

Ownership is a predicate in the query (`where: { orderNumber, userId: actor.userId }`), so a
buyer cannot learn that another buyer's order exists — the refusal is `NOT_FOUND`, not
`FORBIDDEN`. Cross-tenant access fails as `NOT_FOUND` too.

---

## 5. Refund service and lifecycle

`lib/ticketing/refunds/service.ts` owns the actor-facing half:

* `requestRefund` — ownership predicate, `refund.request.own`, eligibility, then a
  transaction that inserts the `Refund` and its `RefundItem` claims with a generated
  `RFD-{epochMillis}-{8 hex}` number. A `P2002` on `RefundItem.ticketId` is reported as
  `TICKET_ALREADY_CLAIMED` rather than retried;
* `approveRefund` — tenant check, separation of duties, CAS `PENDING → APPROVED`;
* `rejectRefund` — tenant check, separation of duties, CAS `PENDING → REJECTED`, and — in
  the same transaction — `releaseRefundClaims`, so the ticket can be requested again while
  the `Refund` row survives as the record;
* `executeRefund` — tenant check, separation of duties, CAS `APPROVED → PROCESSING`
  **before** the provider call, then the provider call outside any transaction, then either
  `processConfirmedRefund` or `processFailedRefund`;
* `listRefunds` — own-scope by default, tenant-scope with `order.read.tenant`.

The provider call being outside the transaction is deliberate: a provider round-trip must
never hold an InnoDB transaction open, and the CAS already guarantees exactly one caller
reaches the call.

`lib/ticketing/refunds/eligibility.ts` is pure and is the **single** copy of the
"refundable?" predicate, re-used by request and by settlement so the two cannot drift.

---

## 6. Transactional confirmed settlement

`lib/ticketing/refunds/settlement.ts` holds the transactional core and was split from the
service for one concrete reason: the public webhook must import it, and the service imports
the authz guards (→ `@/auth` → NextAuth ESM). The split keeps the module graph honest —
settlement has no actor, no session and no authorization. A static guard asserts this.

`processConfirmedRefund` runs everything in ONE retried transaction
(`withContentionRetry(prisma.$transaction(...))`), in this order:

1. **CAS `PROCESSING → REFUNDED`** (`updateMany`). A duplicate confirmation finds the row
   elsewhere and returns `ALREADY_REFUNDED` without doing anything (R11).
2. Assert the order is still `PAID`/`PARTIALLY_REFUNDED` (otherwise roll back).
3. **Tickets `ISSUED → REFUNDED`**, one guarded `updateMany` each; any miss (checked in,
   already refunded) rolls the whole transaction back.
4. **`EventOrder.refundedAmount` increment**, then read-back, then
   `REFUNDED`/`PARTIALLY_REFUNDED` on both `status` and `paymentStatus` — so those values
   only ever reflect CONFIRMED money (R14/R15).
5. **Quota restore**, only if `Event.returnQuotaOnRefund`, via the existing
   `restoreSoldQuota` primitive (R06).
6. **PIC fee reversal** via `reversePicFeesForRefund`, using the existing `PICFeeLedger`
   only: a `REVERSAL`/`DEBIT` row per fully-refunded order item, guarded by the existing
   `@@unique([orderItemId, type])`. Partial item refunds post nothing until the item's last
   ticket is refunded (R16).
7. **Append-only `PaymentTransaction`** of type `REFUND` when a paid payment exists (R12).
8. Persist `feeTreatment` on the refund.

The audit row is written after the transaction commits, with `actorType: "USER"` for a
staff execution and `"PROVIDER"` for a provider-confirmed one.

`processFailedRefund` performs `PROCESSING → FAILED`, releases the claims and audits the
failure. `confirmInboundRefund` matches an in-flight `PROCESSING` refund by order, validates
any reported amount against the refund's **own requested amount** (not the order total),
and then calls the same `processConfirmedRefund`; an unmatched callback is a no-op.

---

## 7. Provider seam — iPaymu refunds are UNSUPPORTED (R17)

`lib/ticketing/payment/refund-provider.ts` is the seam. Its header records the R17
verification: the iPaymu API v2 exposes payment (COD + callback), balance,
transaction-history, IP/domain validation and area endpoints, and **no refund endpoint**.
The default `UnsupportedRefundProvider` therefore returns `{ ok: false, reason:
"UNSUPPORTED" }` for every request. It never fabricates a reference and never reports a
success that did not happen.

Consequence: with the configured provider, `executeRefund` ends in **`FAILED`** with
`failureReason = "PROVIDER_UNSUPPORTED"`, the claims are released, and no money, ticket,
quota or ledger row moves. `FAILED` (an infrastructure condition) is deliberately distinct
from `REJECTED` (a human decision). The seam is injectable (`setRefundProvider`) for a
future adapter and for tests; it is not exported from any route, so a request can never
choose its own provider.

---

## 8. Webhook integration

`lib/ticketing/payment/webhook.ts` gained a refund branch that can only **confirm** a
refund, never create one:

* the branch imports `confirmInboundRefund` from `../refunds/settlement` (not from the
  service, avoiding NextAuth in the public surface);
* a refund callback skips the order-total comparison (a partial refund legitimately reports
  less than the order total); the amount is validated inside `confirmInboundRefund` against
  the in-flight refund;
* `applyRefundOutcome` maps the confirmation to: `REFUND_CONFIRMED` (200, ledger
  `PROCESSED`), `REFUND_AMOUNT_MISMATCH` (200, ledger `IGNORED`, refund left `PROCESSING`),
  `REFUND_RETRY_LATER` (500, ledger `FAILED`, so the provider retries), and
  `REFUND_OUT_OF_SCOPE` (200, ledger `IGNORED`) for an unsolicited refund — which preserves
  the pre-existing C4 assertion.

The signature verification, replay guard and ledger ordering are unchanged.

---

## 9. API routes

New, all `nodejs` runtime and all under the already-protected `/api/ticketing/` prefix:

| Route | Method | Guards |
| --- | --- | --- |
| `/api/ticketing/refunds` | `POST` | `requireSameOrigin` + `requireAuth` + `refundRequestSchema` |
| `/api/ticketing/refunds` | `GET` | `requireAuth` + `refundListQuerySchema` (read-only, no CSRF) |
| `/api/ticketing/refunds/[refundId]/approve` | `POST` | same-origin + auth + `refundApproveSchema` |
| `/api/ticketing/refunds/[refundId]/reject` | `POST` | same-origin + auth + `refundRejectSchema` (reason required) |
| `/api/ticketing/refunds/[refundId]/execute` | `POST` | same-origin + auth + `refundExecuteSchema` |

The path segment is `z.coerce.number().int().positive()`, so a non-numeric or non-positive
id fails validation (400) rather than reaching Prisma as `NaN`. The request schema accepts
only `orderNumber`, optional `ticketIds` and an optional `reason`; amount, currency,
identity and status fields are absent and stripped.

---

## 10. UI

**Buyer:** `app/ticketing/refunds/page.tsx` (own refund list) and
`components/orders/RequestRefundButton.tsx`. The order detail page renders the button only
when the order is paid, has tickets, and every ticket is `ISSUED` (a mixed
checked-in/issued order is not offered, so the request cannot be created and then fail at
settlement). `REFUNDED`/`PARTIALLY_REFUNDED` labels were added to the order/payment status
maps.

**Dashboard:** `app/dashboard/refunds/page.tsx` (server RSC list) and
`components/dashboard/RefundDecisionActions.tsx` (client approve/reject/execute).
Rejection uses `window.prompt` for the required reason. The Refund nav entry is gated by the
existing `capabilities.canReadOrders` capability — no new dashboard capability was invented.

`lib/ui/route-inventory.ts` registered both pages, and the route-inventory test counts were
updated (29 pages / 16 dashboard routes); the full suite confirms the inventory is exact.

---

## 11. Tests

New `__tests__/ticketing-refunds/` (registered in `jest.config.js`):

| File | Tests | What it locks |
| --- | --- | --- |
| `eligibility.test.ts` | 33 | Every eligibility branch (R03/R04/R05/R09/R10), per-snapshot money, `refundableBalance`, `confirmedAmountVerdict`, and the Zod contract (amount/identity stripped, positive-int id, status enum) |
| `refund-wiring.test.ts` | 24 | Module-graph honesty (settlement has no authz; webhook uses settlement, never service), quota restore only in settlement, CAS on every transition, single transaction, no `Number()` money, unique `RefundItem.ticketId`, truthful provider, route guards and classification |
| `refund-lifecycle.integration.test.ts` | 15 | Real DB: unsupported→FAILED with no movement; confirmed settlement (tickets/order/quota/PIC/`PaymentTransaction`/audit); `ALREADY_REFUNDED` replay; two-step partial refund; IDOR; separation of duties; cross-tenant; unpaid/checked-in/closed-window/double-claim refusals; reject releases the claim; webhook confirm and amount-mismatch; own vs tenant list |

`refund-harness.ts` extends the Phase 8 issuance harness (which extends Phase 7's) so
fixtures are still built through the real services and only the provider socket (and, when
asked, the refund adapter) is substituted. The harness's teardown deletes refunds before
tickets/orders to satisfy `RefundItem.ticket`'s `Restrict` FK.

The suite deliberately arranges the checked-in state with a direct `Ticket` update because
the check-in service itself is a later phase; that is noted at the call site.

---

## 12. Verification

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | 0 errors |
| `npx jest --runInBand` | **48 suites / 1107 tests passed** (baseline 45 / 1035 ⇒ +3 suites / +72 tests) |
| `npm run build` | exit 0, `✓ Compiled successfully`; `/dashboard/refunds` and `/ticketing/refunds` appear in the route table |
| `npm run lint` | 27 errors, unchanged from baseline (all pre-existing, in unrelated files); the only new output is 2 `_input` unused-var warnings in `refunds/service.ts`, matching the existing codebase style |
| `npx prisma validate` | valid |
| `npx prisma migrate status` | up to date (20 migrations) |

The authz, route-classification, UI-consolidation and payment/issuance suites all still
pass, confirming the auto-classifying guards absorbed the new routes and that the webhook's
pre-existing refund-ignored behavior (C4) was preserved.

---

## 13. Files changed

**New**
* `lib/ticketing/refunds/{eligibility,validation,payload,settlement,service}.ts`
* `lib/ticketing/payment/refund-provider.ts`
* `lib/dashboard/refunds.ts`
* `app/api/ticketing/refunds/route.ts`
* `app/api/ticketing/refunds/[refundId]/{approve,reject,execute}/route.ts`
* `app/dashboard/refunds/page.tsx`, `components/dashboard/RefundDecisionActions.tsx`
* `app/ticketing/refunds/page.tsx`, `components/orders/RequestRefundButton.tsx`
* `prisma/migrations/20260918000000_add_refund_lifecycle/migration.sql`
* `__tests__/ticketing-refunds/{eligibility.test.ts,refund-wiring.test.ts,refund-lifecycle.integration.test.ts,refund-harness.ts}`
* `TICKETING_PHASE10B_REFUND_IMPLEMENTATION_REPORT.md` (this file)

**Modified**
* `prisma/schema.prisma` — `RefundStatus`, `Refund` lifecycle columns/indexes, `RefundItem`
* `lib/authz/permissions.ts` — `REFUND_REQUEST_OWN`
* `lib/ticketing/inventory.ts` — `restoreSoldQuota` + `RestoreResult`
* `lib/ticketing/audit-log.ts` — `refund.request|approve|reject|settle|fail`
* `lib/ticketing/payment/webhook.ts` — refund confirmation branch
* `lib/ui/route-inventory.ts` — the two new pages
* `components/dashboard/DashboardAppShell.tsx` — Refund nav entry
* `app/ticketing/orders/[orderNumber]/page.tsx` — refund button + status labels
* `__tests__/ui-consolidation/route-inventory.test.ts` — page/route counts
* `jest.config.js` — `__tests__/ticketing-refunds/*.test.ts`

No dependency, `AUTH_URL`, deployment or unrelated module was touched. No commit or push
was made.

---

## 14. Security and integrity notes

* The webhook remains public by design and trusts only a verified HMAC; it cannot create,
  approve or execute a refund.
* Every status transition is a compare-and-swap, and every uniqueness guarantee that
  prevents a double refund is a database constraint (`RefundItem.ticketId`), not a check.
* Money never leaves `Decimal`: the payload renders fixed 2-decimal strings via
  `moneyString`, and a static guard forbids `Number()` in the refund layer.
* Cross-tenant and IDOR access resolve to `NOT_FOUND`, so existence is not disclosed.
* The refund branch of the webhook preserves the previous "no refund is acted on unless
  one is genuinely in flight" behavior.

---

## 15. Open items and deferred work

1. **D-R16 notifications** (`REFUND_CREATED` / `REFUND_COMPLETED`) — not implemented.
2. **D-R08 gateway-fee accounting** — not applicable while the provider cannot refund.
3. **D-28 check-in gate** — blocking check-in for a ticket with an open refund is a shared
   dependency of the still-unbuilt check-in service; without it the
   buy-attend-refund abuse path (RK-15) remains open.
4. **Real provider adapter** — when iPaymu (or another provider) publishes a refund API,
   an adapter is written to `RefundProvider`; the whole lifecycle then works unchanged.
5. **Documentation nit** — the requirement-ID renumbering described in §2 is the one
   place where the audit and the code do not use identical numbering.
