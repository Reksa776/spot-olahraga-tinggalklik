# 07 — TICKETING & TRANSACTION AUDIT

---

## 1. End-to-end flow (as implemented)

```
1. Buyer browses public event
   GET /events, /e/[slug], /api/events, /api/events/[slug]

2. Buyer selects ticket type + quantity
   Server-side availability from Event + TicketType + sales windows

3. Checkout
   POST /api/ticketing/checkout
   → auth + CSRF + strict Zod
   → idempotency key (unique per user/scope/key, request hash)
   → transaction: order + items + quota CAS + reservations
   → PENDING_PAYMENT, reservation TTL (default 30 min)

4. Payment attempt
   POST /api/ticketing/orders/[orderNumber]/pay
   → server-created Payment (activeOrderId unique)
   → iPaymu direct (QR/VA) or redirect session
   → provider reference / transaction id stored server-side

5. Payment result
   Browser redirect: display only, NEVER settles
   Provider webhook: POST /api/ticketing/payment/webhook
   → HMAC over raw bytes
   → amount verification
   → WebhookEvent insert (providerEventId unique) = replay guard
   → settleVerifiedPayment transaction:
        order PAID + paidAt, quota converted, payment status
   → post-commit enqueue purchase proof

6. Ticket issuance
   POST /api/ticketing/orders/[orderNumber]/issue (own order)
   → row lock + unique (orderItemId, sequenceNo)
   → Ticket rows with ticketCode + qrTokenHash
   → enqueue ticket-issued message

7. Buyer wallet
   /ticketing/orders/[orderNumber]
   → QR "TICKET:<ticketCode>" via qrcode.react
   → public dashboard/ticket pages are ownership-checked

8. Gate
   Organizer scanner or PIC scanner
   → checkInTicket (see 08)
```

---

## 2. Checkout guarantees

`lib/ticketing/checkout.ts`:

- **Server-side pricing only.** Client sends ticket type ids and quantities; `TicketType.price` is authoritative.
- **One transaction.** Idempotency row → order → per-line quota CAS → order item → reservation. A failure rolls back the quota hold, so inventory cannot be stranded.
- **Deterministic lock order.** Lines are sorted by `ticketTypeId` to avoid deadlocks.
- **Idempotency.** `IdempotencyKey` is unique on `(userId, scope, key)` and stores a request hash; a same-key/different-body replay is refused rather than silently returning a stale order.
- **Bounded contention retry.** Transient InnoDB contention and order-number collisions are retried from the beginning, re-running every guard.
- **Reservation expiry.** `TicketReservation.expiresAt`; the `reservation-reaper` tick releases seats for abandoned orders.

**Not implemented:** dynamic pricing, coupons in the current checkout path (columns exist on `EventOrder`, but this audit found no active coupon engine), and client-side price negotiation.

---

## 3. Payment gateway

| Aspect | Implementation |
|---|---|
| Provider | iPaymu (single provider) |
| Environment | `PAYMENT_ENVIRONMENT` = `sandbox` \| `production`; missing/misspelled throws |
| Flows | DIRECT (QRIS/VA/retail code rendered locally from provider data) and REDIRECT (hosted page) |
| Credentials | server env only; no credential is accepted from a request |
| Webhook auth | HMAC signature over exact raw body, verified before parsing/mutation |
| Replay | `WebhookEvent.providerEventId @unique`; only `PROCESSED` blocks a later verified delivery |
| Amount | provider amount compared to expected; mismatch rejected |
| Reconciliation | operator-triggered `POST /api/organizer/payments/[paymentReference]/reconcile`; same settlement transaction |
| Refunds | **manual bank transfer**, not a provider refund API |

`Payment.activeOrderId @unique` prevents two non-terminal payment attempts for one order. `providerTransactionId` is written only from a provider response, never from a caller.

---

## 4. Settlement and issuance

### 4.1 Settlement
`lib/ticketing/payment/settlement.ts` is the only automatic settlement path from a verified webhook or operator reconciliation. It:

- claims the order with a conditional update (CAS) so only one caller wins;
- converts reservations to sold quota;
- sets order/payment status and `paidAt`;
- handles late settlement/anomalies;
- enqueues purchase proof **after commit** (non-throwing, so a queue failure cannot roll back money).

### 4.2 Issuance
`lib/ticketing/tickets/issuance.ts` is deliberately separate and idempotent:

- `SELECT ... FOR UPDATE` on the order serializes concurrent issuers;
- `@@unique([orderItemId, sequenceNo])` is the database arbiter;
- missing-sequence diffing recovers from a partial crash;
- eligibility is re-checked under the lock;
- it does not re-price, touch inventory, or send anything;
- after issuing, it enqueues the ticket-issued notification.

**Why separate:** settlement must be exactly-once for money; issuance must be at-least-once converging to exactly-once so a paid buyer whose request died still gets tickets.

---

## 5. Ticket and QR generation

- `Ticket.ticketCode` is human-readable and unique.
- `Ticket.qrTokenHash` is unique; a 32-byte random token is hashed at issuance.
- **The raw QR token is never delivered to any client.** The buyer wallet renders the public code payload `TICKET:<ticketCode>`.
- `Ticket` has no money columns; price snapshots stay on `EventOrderItem`.
- Ticket statuses: `RESERVED → ISSUED → CHECKED_IN`, with `VOID`/`REFUNDED` terminal alternatives.

**Important:** this means the QR is an **identifier**, not a bearer secret. Anyone who learns a ticket code can attempt a scan; admission controls are event/status/refund checks plus the one-time CAS. See 08 and 12.

---

## 6. Purchase proof and invoice

- Purchase proof is a plain-text message rendered from a stored payload snapshot (`purchase-proof.v1`), delivered over email/WhatsApp.
- Ticket-issued is a separate message (`ticket-issued.v1`) after issuance.
- Idempotency keys: `purchase-proof:{orderNumber}:{channel}:v1`, `ticket-issued:{...}:{channel}:v1`.
- Both channels have independent delivery rows and retries.
- There is **no PDF invoice/e-ticket attachment generator**. The proof is text; this satisfies "bukti pembelian" only if plain text is acceptable.

---

## 7. Refunds

- Buyer requests via `/api/ticketing/refunds` (own-scope).
- Staff approve/execute/reject; requester cannot decide their own request.
- Production rail is manual bank transfer; provider refund API is unsupported.
- `RefundItem.ticketId @unique` prevents double refund of a ticket.
- Refund settlement restores quota and reverses PIC fees only when `REFUNDED`.
- Evidence files are private and tenant/own-scope protected.

---

## 8. Transaction risks

| # | Risk | Evidence | Severity |
|---|---|---|---|
| T-1 | No real-DB concurrency evidence | mocked suites only; `TEST_DATABASE_URL` absent | High |
| T-2 | Public code is the scan credential | `TICKET:<ticketCode>`; raw token never delivered | High (design) |
| T-3 | Purchase proof is text, not PDF | template renderer | Medium (product expectation) |
| T-4 | Notification enqueue failures are non-fatal and recovered by manual sweeps | `enqueuePurchaseProof` never throws | Medium (ops) |
| T-5 | Webhook is the only automatic settlement trigger; missed callbacks need operator reconciliation | webhook module header | Medium (ops) |
| T-6 | Coupon fields exist but no active engine was found in this audit | `EventOrder.couponId/couponCode` | Low/INFO |

---

## 9. Recommendations

1. Run the real-DB check-in/payment integration suites before claiming production readiness (Phase 3G).
2. Decide whether a PDF e-ticket is required; if yes, add a document renderer and delivery attachment path — this is related to, but separate from, feature 4.
3. Add monitoring for `Notification` rows that remain queued and for webhook reconciliation backlog.
4. Keep settlement and issuance separate; do not merge them for convenience.
5. Treat ticket codes as sensitive identifiers in logs, support tooling and analytics.
