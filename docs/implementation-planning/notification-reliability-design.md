# Notification Reliability Design

**Status:** PROPOSED reliability model layered on the existing queue.

**Constraint:** Baileys does not provide exactly-once delivery. This design targets **at-most-one socket acceptance per delivery id**, durable state, bounded duplicates and terminal ambiguity — not a false exactly-once claim.

---

## 1. Existing guarantees to preserve

**VERIFIED.**

- `Notification.idempotencyKey` is unique (`prisma/schema.prisma:205`); one logical event produces one notification.
- `NotificationDelivery` is unique on `(notificationId, channel)` (`prisma/schema.prisma:1742`); one channel fans out once.
- Claiming uses a conditional `UPDATE ... WHERE status = 'QUEUED'` and only `count === 1` wins (`lib/notifications/queue.ts:93-166`).
- A claimed row becomes `SENDING`, `attemptCount` increments, and `nextRetryAt` becomes the lease deadline (`:139-151`).
- An expired `SENDING` row becomes `FAILED/AMBIGUOUS_DELIVERY`; it is never automatically resent (`:344-383`).
- Failures retry with 60s/300s backoff and ±20% jitter; the last attempt becomes terminal `FAILED` (`:72-89`, `:234-270`).
- A dry-run result is `SKIPPED/DRY_RUN_SIMULATED`, not `SENT` (`lib/notifications/worker.ts:302-317`).
- The worker holds a `notification-dispatch` lease and records a heartbeat (`lib/notifications/worker-lock.ts:36-106`).

These are the invariants. The gateway must not add a second competing queue.

---

## 2. State model

### 2.1 `NotificationDelivery` remains the app-facing state

| State | Meaning | Who writes |
|---|---|---|
| `QUEUED` | Eligible to be claimed at/after `nextRetryAt` | enqueue, retry |
| `SENDING` | Claimed with a lease; provider outcome unknown | CAS claim |
| `SENT` | The live transport/API accepted the message and returned a provider id | worker only |
| `FAILED` | Terminal after retries, or ambiguous, or permanent rejection | worker/queue |
| `SKIPPED` | Terminal condition retrying cannot fix (invalid recipient, unknown template, disabled transport, dry-run) | worker/queue |

**Critical semantic:** `SENT` does **not** mean delivered to the handset. It means the gateway accepted it and returned a message id. Delivery/read acknowledgements are separate.

### 2.2 Proposed acknowledgement fields

`NotificationDelivery` currently has no ack fields (`prisma/schema.prisma:1722-1744`). Proposed additive fields:

```prisma
enum DeliveryAcknowledgementStatus {
  NONE
  ACCEPTED
  DELIVERED
  READ
  FAILED
  UNKNOWN
}

model NotificationDelivery {
  // existing fields unchanged ...
  ackStatus       DeliveryAcknowledgementStatus @default(NONE)
  ackAt           DateTime?
  deliveredAt     DateTime?
  readAt          DateTime?
  lastAttemptAt   DateTime?
  @@index([channel, ackStatus, updatedAt])
}
```

Rules:

- `SENT` + `ackStatus = ACCEPTED` is the honest state after `sendMessage` succeeds.
- A `messages.update` receipt may advance to `DELIVERED` or `READ`; a failure receipt sets `FAILED`/`UNKNOWN`, never `SENT`.
- Ack updates are monotonic: `READ` cannot regress to `DELIVERED`, `DELIVERED` cannot regress to `ACCEPTED`.
- A later ack failure does not trigger an automatic resend. The message may already be on the handset.

---

## 3. Gateway dispatch idempotency

The existing worker can retry after a transport throws. If the gateway accepted a message but the HTTP response was lost, a naive retry duplicates it. The gateway therefore needs durable dispatch state keyed by the **delivery id**.

### 3.1 Proposed table

```prisma
enum WhatsAppGatewayMessageState {
  PENDING
  SENDING
  SENT
  FAILED_BEFORE_SEND
  AMBIGUOUS
}

model WhatsAppGatewayMessage {
  id              String                      @id @default(cuid())
  deliveryId      String                      @unique
  notificationId  Int
  recipientHash   String                      @db.VarChar(64)
  state           WhatsAppGatewayMessageState @default(PENDING)
  messageId       String?                     @unique
  ackStatus       DeliveryAcknowledgementStatus @default(NONE)
  ackAt           DateTime?
  attemptCount    Int                         @default(0)
  leaseUntil      DateTime?
  errorCode       String?
  createdAt       DateTime                    @default(now())
  updatedAt       DateTime                    @updatedAt
  expiresAt       DateTime

  @@index([state, leaseUntil])
  @@index([expiresAt])
  @@map("whatsappgatewaymessage")
}
```

The table stores no message body and no full JID. `recipientHash` is a keyed hash or SHA-256 of the normalized JID, used only for correlation.

### 3.2 Send algorithm

**PROPOSED.**

1. Worker calls `POST /v1/messages/text` with `deliveryId`.
2. Gateway atomically inserts `WhatsAppGatewayMessage(deliveryId, state=PENDING)`; on duplicate, load it.
3. If existing:
   - `SENT` + `messageId` → return the same id. No send.
   - `FAILED_BEFORE_SEND` → allowed to retry; increment attempt.
   - `PENDING/SENDING` with a live lease → `409 IN_PROGRESS`; caller must not send in parallel.
   - `SENDING` with an expired lease, or `AMBIGUOUS` → `409 AMBIGUOUS`; never resend.
4. Otherwise set `SENDING`, `leaseUntil = now + 60s` and call the socket once.
5. On return with `messageId`: persist `SENT`, `messageId`, `ackStatus=ACCEPTED`; return id.
6. On a definite pre-send failure (validation, socket not connected, explicit rejection): persist `FAILED_BEFORE_SEND`; return a retryable error.
7. On timeout/unknown after invoking `sendMessage`: persist `AMBIGUOUS`; return `409 AMBIGUOUS`.

The worker resolves an HTTP timeout with `GET /v1/messages/:deliveryId` before deciding:

- `SENT` → mark `SENT` with the provider id.
- `FAILED_BEFORE_SEND` → retry policy applies.
- `SENDING` expired or `AMBIGUOUS` → mark `FAILED/AMBIGUOUS_DELIVERY`; no automatic resend.
- Gateway unreachable → do **not** guess; mark terminal ambiguous after a bounded resolution attempt.

### 3.3 Retention

`expiresAt` defaults to 30 days. A cleanup job deletes expired gateway metadata after the corresponding `NotificationDelivery` is terminal. This is not an archive; the app's delivery row is the long-lived record.

---

## 4. Retry policy

### 4.1 Classification

| Class | Examples | Action |
|---|---|---|
| Transient/retryable | Gateway not ready, socket reconnecting, 429/503, network failure before acceptance, SMTP temporary failure | `recordDeliveryFailure` → `QUEUED` with 60s/300s backoff, max attempts |
| Permanent | Invalid JID/number, blocked/forbidden recipient, malformed template payload, unknown template, session `LOGGED_OUT`, document revoked | `SKIPPED` or terminal `FAILED`; no automatic retry |
| Ambiguous | Timeout after the socket may have accepted; missing message id; expired gateway `SENDING`; worker crash after send | Terminal `FAILED/AMBIGUOUS_DELIVERY`; operator review |
| Provider ack failure | Accepted but later receipt says failed | Record `ackStatus=FAILED`; do not resend automatically |

The existing `recordDeliveryFailure()` retries every thrown transport error. The live transport must therefore throw distinct typed errors so the worker can terminate an ambiguous outcome instead of retrying it. This is a required code change in the activation phase.

### 4.2 Attempts

- Default `maxAttempts = 3` remains.
- Backoff remains 60s, then 300s, ±20% jitter.
- A permanent/ambiguous error must not consume the remaining attempts.
- A manual operator retry of a terminal `FAILED` row must be an explicit audited action that resets it to `QUEUED` with a new attempt budget. No public resend endpoint.

### 4.3 Session-down behaviour

When the gateway reports `LOGGED_OUT`, `CONFLICT` or `FENCED`, the worker should stop claiming WhatsApp rows rather than burn attempts on a session that cannot succeed. The rows stay `QUEUED`; an alert fires. Email continues independently.

---

## 5. Duplicate prevention summary

| Layer | Key | Failure mode if bypassed |
|---|---|---|
| Logical notification | `Notification.idempotencyKey` unique | Same event enqueues twice |
| Channel fan-out | `(notificationId, channel)` unique | Two delivery rows for one channel |
| Queue claim | CAS `QUEUED → SENDING` + lease | Two workers send one row |
| Gateway dispatch | `WhatsAppGatewayMessage.deliveryId` unique | Worker retry after lost HTTP response duplicates |
| Provider message id | stored and returned on replay | Cannot correlate/reconcile |
| Ambiguous recovery | terminal `FAILED/AMBIGUOUS_DELIVERY` | Automatic resend of a message that may have arrived |

**Residual duplicate window:** if the gateway's dispatch table is lost or restored from a stale backup after a send, it may resend. Backups and restore procedures must preserve the table; the worker must not reset `SENT` rows. This is an operational risk, not something code can promise away with Baileys.

---

## 6. Fairness, priority and caps

### 6.1 Finding

**VERIFIED.** The claim query orders only by `queuedAt` (`lib/notifications/queue.ts:116`). `Notification.priority` exists and producers set 10/20/30 (`purchase-proof.ts:273`, `ticket-issued.ts:228`, `h36-reminder.ts:398`), but it does not affect claim order. A document blast that fills the queue could delay reminders and proofs.

### 6.2 Proposed policy

- Claim WhatsApp rows by `notification.priority ASC, queuedAt ASC` (lower number = higher priority), with a deterministic tie-breaker on delivery id.
- Proof = 10, ticket-issued = 20, H-36 = 30, document blast = 40.
- Add `NotificationCategory.DOCUMENT` (enum addition) so document traffic can be counted and capped separately.
- Keep the existing transactional `WHATSAPP_DAILY_CAP` default 20 for proof/ticket/H-36.
- Add a separate `WHATSAPP_DOCUMENT_DAILY_CAP`, default **0** (disabled) until the owner approves a number.
- Add `WHATSAPP_ABSOLUTE_DAILY_CAP` as a hard platform ceiling across all categories; every category checks both its own cap and the absolute cap.
- Count real `SENT` and dry-run simulated sends per category; do not count invalid-recipient skips.
- The document cap must never starve transactional traffic: transactional rows are claimed first and have a reserved allowance. A document campaign pauses when the transactional backlog exists.

These values are **proposals**, not production claims. The owner must set and approve the initial blast cap; 20/day is explicitly unsuitable for a document blast (`docs/audit/09-whatsapp-email-integration-audit.md` finding N-8).

### 6.3 One socket means one throughput budget

All organizers share one number. A blast for one organizer consumes the same platform cap as every other organizer's receipts. The admin/monitoring view must show:
- sends today by category,
- remaining transactional allowance,
- remaining document allowance,
- document campaigns deferred by cap,
- oldest queued item age.

There is no per-organizer fairness at the transport layer. If fairness is required, it must be implemented as a producer-side quota before enqueue, not by opening a second socket.

---

## 7. Failed-message monitoring

**PROPOSED.** A read-only operator view/query, not a new public API:

```sql
-- queue depth and age
SELECT channel, status, COUNT(*) AS n,
       MIN(queuedAt) AS oldest
FROM notificationdelivery
GROUP BY channel, status;

-- stuck claims
SELECT id, notificationId, channel, attemptCount, nextRetryAt
FROM notificationdelivery
WHERE status = 'SENDING' AND nextRetryAt < NOW() - INTERVAL 5 MINUTE;

-- terminal failures requiring review
SELECT id, notificationId, channel, provider, errorCode, failedAt
FROM notificationdelivery
WHERE status = 'FAILED'
ORDER BY failedAt DESC
LIMIT 100;

-- gateway ambiguity
SELECT deliveryId, notificationId, state, messageId, errorCode, updatedAt
FROM whatsappgatewaymessage
WHERE state IN ('AMBIGUOUS', 'FAILED_BEFORE_SEND')
ORDER BY updatedAt DESC
LIMIT 100;
```

Alerts:

- worker heartbeat `joblock.lastRunAt` older than 10 minutes;
- `SENDING` past lease;
- `FAILED` rate above an approved threshold;
- any `LOGGED_OUT`/`CONFLICT`/`FENCED`;
- `AMBIGUOUS` increase;
- oldest `QUEUED` WhatsApp row older than an approved SLO;
- daily cap hit while a transactional backlog exists.

No recipient, message body or token may appear in the monitoring view or alert payload.

---

## 8. Interaction with the existing worker

**PROPOSED** changes, in order of dependency:

1. Add `whatsapp-gateway.ts` implementing `WhatsAppTransport`.
2. Add a typed `AmbiguousDeliveryError` and a worker branch that records terminal `FAILED/AMBIGUOUS_DELIVERY` instead of retrying.
3. Replace the unconditional clamp with a fail-closed live selection (see activation plan).
4. Stop claiming WhatsApp when gateway readiness is false; leave rows `QUEUED`.
5. Add priority ordering and category-aware caps.
6. Add ack reconciliation from `WhatsAppGatewayMessage` to `NotificationDelivery`.
7. Add monitoring queries/alerts.

The worker must remain the only component that writes `NotificationDelivery.status`. The gateway writes only `WhatsAppGatewayMessage`.

---

## 9. Schema changes proposed

**No migration is created in this planning task.**

| Change | Reason | Risk |
|---|---|---|
| `NotificationDelivery.ackStatus/ackAt/deliveredAt/readAt/lastAttemptAt` | Honest post-acceptance tracking | Additive; nullable/defaulted |
| `DeliveryAcknowledgementStatus` enum | Typed ack states | Additive |
| `WhatsAppGatewayMessage` + state enum | Durable dispatch idempotency | New table; no existing rows |
| `NotificationCategory.DOCUMENT` | Separate document cap/reporting | Enum addition; no existing value removed |
| Indexes for category/ack/monitoring | Query performance | Additive |

**Rollback:** drop the new table and additive columns only after stopping the gateway/worker and confirming no code reads them. Do not roll back by deleting `NotificationDelivery` rows.

---

## 10. Verification requirements

- Unit: gateway state transitions, duplicate replay, expired lease, timeout resolution, ack monotonicity.
- Integration: two workers claim once; two send requests for one delivery id produce one `sendMessage`; HTTP timeout followed by `GET` resolves.
- Real DB: CAS and unique constraints under concurrent transactions.
- Negative: logged-out session leaves rows queued and alerts; ambiguous never retries; invalid JID never reaches socket.
- Live controlled: one message, one provider id, ack observed; re-run produces zero duplicates.

See `testing-and-acceptance-criteria.md`.
