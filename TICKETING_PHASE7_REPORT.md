# TICKETING PHASE 7 REPORT

**Project:** TinggalKlik.Co — Event + Sports Ticketing rebuild
**Repository:** `demo-marketplace` · branch `main`
**Phase:** 7 — Payment Gateway + Payment Lifecycle
**Date:** 2026-09-17

---

## 1. Status

```text
PHASE 7 STATUS: PASS WITH WARNINGS
```

Phase 7 is *functionally complete and concurrency-verified*. The warnings below are
**unresolved business decisions carried forward**, **one unverifiable-by-construction
sandbox gate (`D-16`)**, and **two honest limitations** (no job runner, UI not
browser-verified). None of them is a correctness defect in the delivered code, and none of
them was resolved by guessing.

---

## 2. Scope implemented

| Capability | Status | Where |
| --- | --- | --- |
| Payment creation | **IMPLEMENTED / VERIFIED** | `lib/ticketing/payment/service.ts` |
| Payment record lifecycle | **IMPLEMENTED / VERIFIED** | `Payment` + `PaymentTransaction` (Phase 2 schema, unchanged) |
| Provider adapter (seam) | **IMPLEMENTED / VERIFIED** | `lib/ticketing/payment/gateway.ts` — the only module that may touch iPaymu |
| Webhook signature verification | **IMPLEMENTED / VERIFIED** | `webhook.ts` + `verifyCallbackSignature` (raw-body, fail-closed) |
| Amount verification | **IMPLEMENTED / VERIFIED** | server total vs reported `sub_total`; mismatch ⇒ refused, no mutation |
| Payment state machine | **IMPLEMENTED / VERIFIED** | guarded CAS transitions, no illegal edge |
| Settlement | **IMPLEMENTED / VERIFIED** | `settlement.ts` — one transaction, order CAS → payment CAS → conversion |
| Reservation conversion | **IMPLEMENTED / VERIFIED** | via `confirmOrderReservations` (canonical, Phase 5 primitives) |
| Payment expiry | **CONSUMED, NOT SCHEDULED** | reaper mechanism untouched; runner belongs to another phase (§15) |
| Idempotency (webhook) | **IMPLEMENTED / VERIFIED** | `WebhookEvent.providerEventId @unique`, insert-first ledger |
| Idempotency (creation) | **IMPLEMENTED / VERIFIED** | one live `Payment` per order; concurrent clicks re-use it |
| Audit logging | **IMPLEMENTED / VERIFIED** | all four actions declared and written: `payment.create` (service), `payment.success` (settled + late), `payment.failed` (failure notification), `payment.expired` (reaper + cancel-void), through the Phase 6 logger |
| API | **IMPLEMENTED / VERIFIED** | `POST .../orders/[orderNumber]/pay`, `POST /api/ticketing/payment/webhook` |
| UI | **IMPLEMENTED, TYPE-CHECKED ONLY** | `PayNowButton`, `RefreshOrderStatus`, order page |
| Tests | **IMPLEMENTED / VERIFIED** | 4 suites, 72 tests, all passing |

**Deliberately not implemented:** ticket issuance, QR/e-ticket, check-in, PIC
attribution/fees, settlement ledger, refunds, financial reporting, Excel export,
WhatsApp/email, coupons, spin wheel, retail cleanup, any model rename.

---

## 3. Business decisions

| D | Decision | Phase 7 implementation | Source |
| --- | --- | --- | --- |
| **D-09** repayment pricing | **DECISION REQUIRED** — not implemented | A terminal order is refused with `ORDER_NOT_PAYABLE` and `details.decision = "D-09_REPAYMENT_PRICING"`. The design's §26.3 clause "re-reserve quota if it was released" is *deliberately absent*: re-reserving is repayment, and its price rule is open. | design §26.3, register §39.4 |
| **D-16** iPaymu `expired` unit | **DECISION REQUIRED** — sandbox verification NOT performed | The value sent is **this platform's own** TTL (`PlatformSetting.reservationTtlMinutes`, 30), and `Payment.expiresAt` is `EventOrder.expiresAt` — the same instant. Under either candidate unit this satisfies §11.4's hard constraint `TTL ≤ gateway session expiry`. See §11 warning 1. | design §13.2, §11.4, §31.6 |
| **D-17** second provider | **LOCKED: no** — seam preserved | `gateway.ts` is the only iPaymu-importing module in the ticketing tree; a static guard enforces that. | design §13.5 |
| **D-20** settlement model | **DECISION REQUIRED** (Phase 16) | No settlement, payout or ledger code exists. | register §39.4 |
| **D-22** fee bearer | **DECISION REQUIRED** — not implemented | The provider's own fee is **recorded** (`PaymentTransaction.providerFee`, `EventOrder.gatewayFee`) as a fact. **No fee is charged to buyer, organizer or PIC.** `platformFee` stays `0`. | design §17.2, register §39.4 |
| **D-26** free tickets | **DECISION REQUIRED** — not implemented | A zero-total order is refused at creation with `CONFLICT` / `reason: "ZERO_AMOUNT_ORDER"` / `decision: "D-26_FREE_TICKET_SETTLEMENT_PATH"`. It is never sent to the gateway (the adapter itself rejects `amount <= 0`). No `FREE` path was invented. | register §39.4 |
| **D-33** guest checkout | **DECISION REQUIRED** — account required as built | Payment creation goes through `requireAuth()` + `requireOwnResource(ORDER_READ_OWN, actor.userId)`. No guest path exists. | register §39.4 |
| **D-60** TicketType name uniqueness | **UNRESOLVED — deliberately untouched** | No `@@unique([eventId, name])`, no substitute. Asserted by the Phase 6 guard, still green. Payment never depends on it. | brief §4 |
| **D-61** API money representation | **PRE-EXISTING (Phase 6 contract) followed** | Money crosses the API as fixed 2-decimal **strings** (`"300000.00"`), formatted by `decimal.js`. No JSON numbers, no floats. The residual string-vs-integer-rupiah choice remains open and is *not* changed here. | design §36.5 |
| **D-01 / D-04 / D-06** PIC attribution | **OUT OF SCOPE** — not touched | No attribution model, window or per-order/line rule exists in the payment path. `picFeeTotal` stays `0`. | brief §4 |

**No unresolved decision was silently resolved.**

---

## 4. Payment lifecycle

```text
POST /api/ticketing/checkout                 (Phase 6)
      │   EventOrder PENDING_PAYMENT / UNPAID, reservations HELD
      ▼
POST /api/ticketing/orders/{n}/pay           (Phase 7, customer-authenticated + CSRF)
      │   ownership → payable? → window? → holds still HELD? → amount != 0?
      │   purchase/claim ONE Payment row (UNIQUE paymentReference)
      │   ── provider call happens OUTSIDE any transaction (§13.3) ──
      ▼
iPaymu  ──► paymentUrl + SessionId  →  Payment PENDING, order paymentStatus PENDING
      │
      ├── browser return / "Perbarui status"  →  READ ONLY, never proof (§22)
      │
      ▼
POST /api/ticketing/payment/webhook          (anonymous; HMAC is the trust boundary)
      │  1. bound body (64 KB)           → 413
      │  2. verify HMAC over the raw body → 401 fail-closed
      │  3. resolve OUR reference          → 200 + IGNORED if not ours
      │  4. verify amount                  → refused, no mutation
      │  5. claim WebhookEvent row         → DUPLICATE = 200, no mutation
      │  6. classify: REFUND / UNKNOWN / PENDING = acknowledged, no mutation
      ▼
settleVerifiedPayment (one transaction)
      │  order CAS (PENDING_PAYMENT → PAID, paymentStatus != PAID)
      │  → Payment CAS (UNPAID|PENDING → PAID) → PaymentTransaction
      │  → confirmOrderReservations: HELD → CONVERTED, reserved -= n, sold += n
      ▼
EventOrder PAID / PAID  (paidAt set)      [or EXPIRED on late settlement]
```

Terminal transitions modelled and tested:

| From | Event | To | Inventory |
| --- | --- | --- | --- |
| `PENDING_PAYMENT` | provider success | `PAID` / `PAID` | `reserved -= n`, `sold += n` |
| `PENDING_PAYMENT` | provider failure | `CANCELLED` / `FAILED` | `reserved -= n` |
| `PENDING_PAYMENT` | customer cancel | `CANCELLED` / unchanged | `reserved -= n` |
| `PENDING_PAYMENT` | TTL elapsed | `EXPIRED` | `reserved -= n` |
| `CANCELLED`/`EXPIRED` | provider success (late) | **unchanged status** / `PAID` | **nothing** |

The last row is design §11.4/§12.3's explicit operator-queue rule, not an accident: the
mismatch `status = CANCELLED` + `paymentStatus = PAID` is recorded, `fulfilmentBlockedAt`
is set, no ticket is issued and no seat moves.

---

## 5. Concurrency evidence

All of it is **real MySQL/InnoDB against the real services**. Only the outbound socket is
stubbed (`global.fetch`), which means the provider adapter's own amount guard, request
signing and config resolution still execute.

| Case | Result |
| --- | --- |
| **Duplicate webhook** — identical bytes × 3 | `SETTLED`, then `DUPLICATE`, `DUPLICATE`. Counters byte-identical after the repeats. 1 `PaymentTransaction`, 1 reservation, 1 `Payment`, exactly 1 `PROCESSED` ledger row. |
| **Second success, different `trx_id`** | `ALREADY_PAID`. Counters unchanged. Still 1 transaction. (The ledger's replay guard cannot catch this one — the order-state CAS does.) |
| **10 concurrent deliveries, same body** | exactly **1** `SETTLED`; `sold = 5`, `reserved = 0`, 1 transaction. |
| **20 orders × 2 deliveries = 40 concurrent** | exactly **20** `SETTLED`; the 20 losers resolved as `ALREADY_PAID` (measured distribution `{ SETTLED: 20, ALREADY_PAID: 20 }`). `sold = 60`, `reserved = 0`, 20 transactions, 20 converted reservations, 20 PAID orders. |
| **Concurrent payment creation** — 8 simultaneous clicks | **1** gateway call. 1 `Payment` row. Every other attempt either resumed the *same* reference/URL or was refused `CONFLICT`/`PAYMENT_CREATION_IN_PROGRESS`. Order stays `PENDING_PAYMENT`, seats untouched. |
| **Cancel vs settlement** — 4 rounds, start order alternated | Both sides given a head start in turn. Measured winner: `cancel` 4/4. **Invariants held in every round**: `reserved = 0`; `sold ∈ {0, quantity}`; status terminal (`PAID`\|`CANCELLED`); a `PAID` order always has `CONVERTED` + `sold = quantity`; a `CANCELLED` order never does. The `settlement wins` branch is additionally pinned deterministically by test F3. |
| **Expiry vs settlement** — 4 rounds, start order alternated | Measured winner: `expiry` 4/4. Same invariants; an expired order never has a converted reservation. The other branch is pinned deterministically by G2 (settle → reaper ⇒ nothing moves) and by the 20-order E4 run. |
| **Reaper after settlement** | A PAID order with an elapsed `expiresAt` is **not** touched: `sold` stays, the reservation stays `CONVERTED`. |
| **Late success after expiry** | Recorded, never converted: no ticket, no seat movement. |

Supporting test cases: `__tests__/ticketing-payment/payment-races.integration.test.ts`
(H1, H2, F1, F2, F3, G1, G2, E4).

---

## 6. Security evidence

| Control | Evidence |
| --- | --- |
| Missing `X-Signature` | 401 `REJECTED_SIGNATURE`; nothing mutates |
| Malformed signature (`deadbeef`, non-hex, truncated) | 401 each; all three recorded with `signatureValid = false` |
| **Correct algorithm, wrong secret** | 401. Order untouched, invariants hold |
| Route-level raw-body handling | `POST` with a bad signature ⇒ **HTTP 401** through the standard envelope; the identical bytes with a valid signature ⇒ **HTTP 200** |
| Signature coverage | Field order is irrelevant (the provider's scheme canonicalises) **but a changed field value fails** — both halves asserted |
| Amount mismatch | Refused with `INVALID_WEBHOOK` / `AMOUNT_MISMATCH`; counters, order and payment **all unchanged**; ledger row `rejected_amount_mismatch` with `signatureValid = true` (so the rejection is about money, not the key) |
| Oversized body | 413 `BODY_TOO_LARGE`, before hashing |
| Foreign reference | 200 + ignored (our two order models cannot cross-settle, design §35.7) |
| **IDOR** — another customer pays/reads the order | `404 NOT_FOUND`, zero gateway calls, zero `Payment` rows. A 403 would confirm existence (design §7.4) |
| Unauthenticated payment creation | `401 UNAUTHORIZED` from `requireAuth()`; nothing created |
| Client-supplied `amount` / `total` / `currency` / `organizerId` / `userId` / `paymentStatus` | The request schema declares **no** financial or identity field at all; a tampered body parses to `{ method }` only, and the provider is told the DB amount (`300000`) and `IDR` |
| CSRF | `requireSameOrigin(request)` on the pay route, asserted |
| Route classification | **139/139** routes classified; Phase 3 classification suite green; the webhook is an explicit `PUBLIC_API_PREFIXES` entry and no prefix appears in both lists |
| Provider-driven audit rows | `actorType: "PROVIDER"`, `actorUserId: null` — never a fabricated user id |
| Browser return | The confirmation page reads **no** query parameter; `paymentUrl` is only ever the provider's own URL; no `"paid"`/`"success"` literal comparison exists |

---

## 7. Financial invariants

Measured before/after on dedicated ticket types (never from a service's own report — always
re-read from the `tickettype` row):

| Scenario | quota | sold | reserved | Assertion |
| --- | --- | --- | --- | --- |
| 2 seats reserved → settled | 20 | 0 → **2** | 2 → **0** | `sold + reserved <= quota`; invariants hold |
| 2 seats reserved → failed | 20 | 0 → **0** | 2 → **0** | no sale on a failed payment |
| 3 settled + 1 failed on a 4-seat type | 4 | 0 → **3** | 4 → **0** | nothing invented, nothing lost |
| 20 orders × 3 seats settled concurrently | 100 | 0 → **60** | 60 → **0** | exactly 20 conversions |

**No double conversion exists anywhere:** every settlement test asserts a single
`PaymentTransaction`, a single reservation row and `reserved` decreasing exactly once.
`sold > quota`, negative counters and `sold + reserved > quota` were never observed, and
`assertInventoryInvariants` is re-checked after every transition.

---

## 8. Migration

```text
MIGRATION: NONE
```

- `prisma/schema.prisma` was **not modified** (last write `2026-09-16 10:13`, i.e. before
  this phase; byte-identical to the Phase 6 state).
- The Phase 2 foundation already carried everything used: `Payment`, `PaymentTransaction`,
  `WebhookEvent` (`providerEventId @unique`), `PaymentStatus`, `PaymentEnvironment`,
  `PaymentMethod`, `PaymentTransactionType`, `EventOrder.gatewayFee`, `fulfilmentBlockedAt`,
  `paidAt`, `EventOrderStatus`.
- No new model, no new column, no new enum, no edit to any historical migration.
- `npx prisma validate` ⇒ valid · `npx prisma generate` ⇒ ok ·
  `npx prisma migrate status` ⇒ **18 migrations, "Database schema is up to date!"**
- No `prisma db push`, no `migrate reset`, no fresh-replay needed (nothing to replay).

---

## 9. Baseline vs final

```text
Baseline (Phase 6 final): 48 suites / 1202 tests / 2 failed / 1200 passed
Final (Phase 7):          52 suites / 1274 tests / 2 failed / 1272 passed

New Phase 7:               4 suites /   72 tests / 0 failed /   72 passed
  payment-creation.integration  15 passed
  payment-webhook.integration   21 passed
  payment-races.integration      8 passed
  payment-wiring                28 passed

Existing failures:         2  (identical set, identical names)
Regressions:               0
```

Failing suites are **exactly** the baseline six — `__tests__/ipaymu/production-hardening`,
`__tests__/marketing/{profile-phone-shipping, m7-audit-fixes, campaign-optional-audit,
address-shipping-ux}`, `__tests__/p0/remediation.integration` — with the same two failing
tests. **Nothing was suppressed, skipped, snapshotted or weakened to make the suite green.**

Also green: `npx tsc --noEmit` (exit 0), and
`npx jest __tests__/authz/route-classification.test.ts` ⇒ 6/6, **139/139 routes classified**.

---

## 10. Legacy safety

Verified by mtime separation — every pre-existing modification in `git status` carries a
`2026-09-16` timestamp (Phase 2.5/3/4/5/6 work), while this phase's writes are all
`2026-09-17`:

- **Retail checkout, order and payment trees untouched**: `app/api/checkout/**`,
  `app/api/orders/**`, `app/api/payment/**`, `lib/payment/**` — no writes this phase. The
  only `lib/payment` change in the tree is the pre-existing Phase 2.5-era edit set.
- **No retail data migrated**: 5 products, 149 retail orders, intact.
- **No model renamed**: `Product`, `Flashsale`, `Order`, `OrderItem` unchanged.
- **No historical migration modified** by this phase (the four modified migration files
  predate it and were preserved exactly as found).
- **No route deleted**; the ticketing payment surface is additive under
  `/api/ticketing/**`.
- **No Git history rewrite, no commit, no push.**
- **No new dependency.** `package.json` is unmodified; `package-lock.json` is the
  pre-existing modification.
- The ticketing surface never imports the retail handlers, and no file outside `gateway.ts`
  imports `lib/payment/ipaymu` — both asserted by static guard.

---

## 11. Warnings

### W1 — `D-16` (iPaymu `expired` unit) is **not sandbox-verified** — `DECISION REQUIRED`

Design §31.6 lists sandbox verification as explicit Phase 7 gate work. It was **not
performed**: the repository contains no sandbox evidence that settles hours-vs-minutes, and
the provider's create response (`Data`) returns only `SessionId` and `Url`, so the value
cannot be read back either.

What was implemented instead is not a guess: the value sent is **this platform's own TTL**
(`reservationTtlMinutes`, LOCKED at 30 by design §11.4), and `Payment.expiresAt` is aligned
to `EventOrder.expiresAt`. Design §11.4's hard constraint is `TTL ≤ gateway session expiry`,
which holds under **both** remaining candidates:

- unit = minutes → gateway expiry == our window (exact)
- unit = hours → gateway expiry > our window (still valid)

The one forbidden outcome — a gateway session that lapses while the platform still considers
the order payable — is therefore impossible. The residual risk is the opposite direction (a
provider window longer than ours), which is precisely the late-settlement path this phase
implements and tests. If `D-16` is later answered "hours", the change is confined to
`gatewaySessionExpiryValue`.

### W2 — No job runner exists; the reaper still has no scheduler — `WARNING`

Design §35.6/§40.11 assigns the job runner to **another** phase, and brief §15 says not to
schedule it here. `expireDueReservations()` is unchanged as a mechanism and is still
unscheduled, so an order can remain `PENDING_PAYMENT` past `expiresAt` on a quiet system.
`assertOrderPayable` closes the customer-money hazard independently by refusing on the
**stored instant**, so the effect is a stale status label, never a payment for a dead order.
Guard: no `setInterval`, no queue/cron library anywhere in `lib/ticketing/**` except the one
documented backoff in `db-contention.ts`.

### W3 — The provider signature covers a **canonicalised** field set, not the literal bytes — `WARNING`

`verifyWebhookSignature` parses the form body, normalises it and sorts keys before MACing, so
**field order is irrelevant** (consistent with iPaymu's documented PHP scheme). Two
consequences worth recording:

1. A reordered but otherwise identical body **verifies** and, being a different byte string,
   produces a **different** `providerEventId` — so the replay guard does not catch it. The
   order-state CAS does (`ALREADY_PAID`), which is asserted.
2. `normalizeCallbackBody` coerces `trx_id`, `status_code`, `transaction_status_code` and
   `paid_off` through `parseInt`, so a **non-numeric** value in one of those fields collapses
   to `null` on both sides of the comparison and is therefore **not authenticated** by the
   signature.

This is inherited from the live retail verifier, which is out of Phase 7's scope to change.
It is not exploitable without the merchant VA (the HMAC secret), and duplicate-settlement is
prevented by the two independent guards above. Reported rather than silently patched.

### W4 — Late settlement writes no `PaymentTransaction` — `WARNING`

When money arrives after an order is `CANCELLED`/`EXPIRED`, `settlePaymentRow` correctly
refuses to flip a terminal `Payment` row, and consequently no `PaymentTransaction` is
written. The money is still traceable three ways — `EventOrder.paymentStatus = PAID`,
`fulfilmentBlockedAt`, the `payment.success` audit row with
`reason: LATE_SETTLEMENT_AFTER_TERMINAL_STATE`, and the `WebhookEvent` ledger — but it is
**absent from the transaction table**. Whether to write one against a terminal attempt is a
reconciliation rule Phase 7 was not given, so it was not invented. Asserted as-is in test E2.

### W5 — UI type-checked, **not browser-verified** — `WARNING: UI type-checked but not browser-verified`

`PayNowButton`, `RefreshOrderStatus` and the order-confirmation page compile and their
server-side data comes from `getOwnOrder` (ownership-scoped). No browser or dev-server
session was run, so no claim of visual or click-through verification is made.

### W6 — `tsconfig.tsbuildinfo` is a build artefact

It appears modified because `npx tsc --noEmit` rewrites it. It contains no source change.

### W7 — Pre-existing residue left in place — `PRE-EXISTING`

The database holds **261 `adminauditlog` rows** from earlier phases (`event.*`,
`ticket_type.*`) plus legitimate retail audit history (`AFFILIATE_*`, `ORDER_*`, `PAYOUT_*`,
`REFUND_*`, `REPAYMENT_*`). They are **not** Phase 7's and were **not** deleted. No
`payment.*` or `order.*` audit rows survive from these suites.

---

## 12. Residue verification

After a **full** suite run (`npx jest --runInBand`):

```text
p7 users/orgs/sports/events/ticket-types ..... 0
eventorder / payment / paymenttransaction .... 0
ticketreservation / webhookevent / ticket .... 0
payment.* audits / order.* audits ............ 0
seeded sports ................................ 14  (intentional)
products / retail orders ..................... 5 / 149  (untouched)
```

Fixtures are built through the real services and torn down children-first, scoped by the
event and by a per-run `SUFFIX` on users, organizers and reference strings. Two defects in
that teardown were found and fixed **during** this phase:

1. the second tenant's event was created but never recorded, so `event.organizerId`'s
   required FK blocked the organizer delete and aborted cleanup (fixed by recording it);
2. rejected webhook deliveries are stored with `orderId: null` and a **hashed**
   `providerEventId`, so the original filter matched nothing and every run leaked its
   rejection rows (fixed by keying on the suite-owned provider transaction id).

The five rows the first defect left behind were identified and removed; the table is now
empty.

---

## 13. Git status

```text
Commit created:     NO
Push performed:     NO
History rewritten:  NO
git reset --hard:   not run
git clean -fd:      not run
prisma db push:     not run
```

Files this phase wrote (all `2026-09-17`):

**New — payment layer**

- `lib/ticketing/payment/gateway.ts`
- `lib/ticketing/payment/validation.ts`
- `lib/ticketing/payment/reference.ts`
- `lib/ticketing/payment/service.ts`
- `lib/ticketing/payment/settlement.ts`
- `lib/ticketing/payment/webhook.ts`
- `lib/ticketing/payment/void.ts`
- `lib/ticketing/db-contention.ts`

**New — API**

- `app/api/ticketing/orders/[orderNumber]/pay/route.ts`
- `app/api/ticketing/payment/webhook/route.ts`

**New — UI**

- `components/orders/PayNowButton.tsx`
- `components/orders/RefreshOrderStatus.tsx`

**New — tests**

- `__tests__/ticketing-payment/payment-harness.ts`
- `__tests__/ticketing-payment/payment-creation.integration.test.ts`
- `__tests__/ticketing-payment/payment-webhook.integration.test.ts`
- `__tests__/ticketing-payment/payment-races.integration.test.ts`
- `__tests__/ticketing-payment/payment-wiring.test.ts`

**Modified (Phase 6 files, extended — no Phase 6 behaviour weakened)**

- `lib/ticketing/checkout.ts` — the bounded jittered contention retry extracted to
  `db-contention.ts` so settlement reuses *one* implementation; the payment response now
  reflects the committed order state
- `lib/ticketing/reservations.ts` — **race fix**: the reaper claims the expiry decision
  *before* releasing seats, so a settlement that wins the order row cannot lose the seats
- `lib/ticketing/orders.ts` — **race fix**: cancel CASes the order first (matching lock
  order) and voids the open payment attempt
- `lib/ticketing/order-payload.ts` — surfaces `paymentUrl`, `canPay`, `paidAt`
- `lib/ticketing/audit-log.ts` — `payment.create` / `payment.success` / `payment.failed` /
  `payment.expired` and the explicit `PROVIDER` actor
- `app/ticketing/orders/[orderNumber]/page.tsx` — Pay Now, status refresh, server-derived
  countdown
- `proxy.ts`, `jest.config.js` — webhook classified public; Phase 7 suites registered
- `__tests__/ticketing-checkout/checkout-wiring.test.ts` — the "exactly one timer" guard
  re-pointed at `db-contention.ts` (its assertion is unchanged in strength)

---

## 14. Phase 8 dependencies

What the next phase can consume:

- **Payment boundary is complete and closed.** `Payment` carries `paymentReference`,
  `paymentUrl`, `externalSessionId`, `expiresAt`, `providerEnvironment`; settlement writes
  `PaymentTransaction` with the provider's own `providerTransactionId`.
- **A paid order is issuer-ready**: `EventOrder PAID/PAID` with `paidAt` set, all
  reservations `CONVERTED`, and `sold` already incremented by the canonical primitives. The
  `fulfilmentBlockedAt` flag marks exactly the orders whose issuance must be withheld.
- **Issuance is NOT implemented** and is the natural Phase 8 seam: `Ticket` /
  `EventOrderItem` / `TicketType` rows are all in place and no `Ticket` row exists yet.
- **Audit vocabulary exists** for the money events, so issuance/check-in actions extend
  `TicketingAuditAction` rather than starting a second logger.
- **Reusable test harness**: `__tests__/ticketing-payment/payment-harness.ts` provides
  fixtures, session faking, signed callbacks and invariant assertions.
- **Reusable primitives**: `db-contention.ts#withContentionRetry` for any new transactional
  path; `voidOpenPayments` for retiring an attempt.

**Still blocking / open for later phases:**

- `D-16` sandbox verification (needs a real sandbox transaction).
- The job runner (reaper + any future expiry sweep) — assigned to another phase.
- `D-09` repayment, `D-22` fee bearer, `D-26` free-ticket settlement.
- `D-20` settlement model (Phase 16).
- W3 (signature canonicalisation / non-numeric `trx_id`) if the retail verifier is ever
  revisited.
- W4 (late-settlement financial record) — a reconciliation decision.

---

## 15. Final summary

Phase 7 delivers the payment boundary that Phase 6 deliberately stopped short of.

An authenticated buyer can open **exactly one** provider session per order — eight
simultaneous clicks produce one gateway payment — and the amount is always the persisted
`EventOrder.total`; the request schema has no financial field to tamper with. The provider's
callback is authenticated by HMAC over the raw body before anything is parsed, its amount is
checked against the order, and settlement runs in one transaction that converts the holds
through the canonical Phase 5 primitives, so `sold` rises exactly once and `reserved` falls
exactly once. Duplicate deliveries, duplicate *events*, concurrent deliveries, cancel races
and expiry races were all run against real InnoDB; in every one of them exactly one side won
and the counters stayed consistent.

Three things are worth calling out as findings rather than features:

1. **The concurrency tests found a real Phase 6 race and it was fixed.** The reaper released
   seats *before* checking whether the order was still `PENDING_PAYMENT`, which was
   harmless while nothing else could settle an order and became a double-mutation the
   moment settlement existed. It now claims the expiry decision first. Cancel had the mirror
   problem and now CASes the order row first, and it voids the open payment attempt.
2. **A stale-response bug was caught by test A1.** `createOrderPayment` returned the order's
   `paymentStatus` as read *before* the transition it had just made, so the API told a
   client that an order with a freshly opened session still had no payment in flight. It now
   reports the committed row — which also keeps the answer truthful when a concurrent cancel
   wins the guarded update.
3. **The provider's signature does not cover a non-numeric `trx_id`.** Its documented scheme
   canonicalises and `parseInt`s that field, so a non-numeric value becomes `null` on both
   sides. It cannot be exploited without the merchant VA, and duplicate settlement is
   blocked twice over, but it is a real property of the verifier this phase inherited. It is
   reported, not patched, because the verifier is live retail code.

The gateway is never invoked by a browser redirect, no ticket is issued, no retail file or
row was touched, and no migration was needed.
