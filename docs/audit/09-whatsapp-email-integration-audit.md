# 09 — WHATSAPP & EMAIL INTEGRATION AUDIT

---

## 1. Providers actually present

| Integration | Library / adapter | Status |
|---|---|---|
| WhatsApp | `@whiskeysockets/baileys@6.7.24` → `lib/notifications/transports/baileys.ts` | Adapter exists; constructor refuses; **never imported for a live send** |
| Email | `nodemailer@8.0.11` → `lib/notifications/transports/smtp.ts` | Adapter exists; constructor refuses; no connection attempted |
| Dry-run | `lib/notifications/transports/dry-run.ts` | **The only instantiable transport** |
| Meta WhatsApp Cloud API | — | **NOT FOUND** |
| WhatsApp Business API | — | **NOT FOUND** |
| Fonnte / Wablas / Twilio | — | **NOT FOUND** |
| SendGrid / Mailgun / Resend | — | **NOT FOUND** |
| Laravel Mail / framework mailer | — | Not applicable (Next.js) |

No secret, API key, password or token is reproduced in this audit.

---

## 2. The dry-run clamp

`lib/notifications/config.ts:38`:

```ts
export const PHASE_1_DRY_RUN_ONLY = true;
```

- `EMAIL_TRANSPORT=smtp` is recorded as a refusal and downgraded to `dry-run`.
- `WHATSAPP_TRANSPORT=baileys` is recorded as a refusal and downgraded to `dry-run`.
- Even with `NOTIFICATIONS_ENABLED=true`, no live transport can be constructed.
- The SMTP/Baileys adapters throw on construction; no code path produces a live sender.
- A dry-run send is recorded as `SKIPPED` / `DRY_RUN_SIMULATED`, not `SENT`.

**Consequence:** features 1 and 2 are code-complete but operationally inactive. Enabling them requires a code change (the constant) plus provider credentials/hosting and an owner decision.

---

## 3. Queue and worker architecture

```
producer (web request / tick)
  → Notification (idempotencyKey unique)
  → NotificationDelivery (notificationId + channel unique)
  → notification worker (separate process)
      → claim QUEUED/SENDING rows with lease
      → render template payload
      → transport (dry-run only)
      → SENT or FAILED + nextRetryAt
```

- `Notification` stores recipient, channel, template key, payload JSON, subject links (`userId`, `eventOrderId`, `ticketId`, `eventId`, `organizerId`, `picProfileId`).
- `NotificationDelivery` stores per-channel status, attempts, max attempts, provider message id, error code/message, retry time.
- The worker is a separate Node process (`scripts/notification-worker.ts`), not a Next.js route.
- Worker concurrency: email 3, WhatsApp 1 (one socket).
- WhatsApp policy defaults: 20 messages/day cap, 5-second delay per send.
- Retry: `attemptCount`/`maxAttempts` (default 3), `nextRetryAt`.
- Worker lease: `lib/notifications/worker-lock.ts` prevents two worker processes claiming the same batch.

**Operational gap:** the worker is deliberately **not** declared in `ecosystem.config.cjs`; an operator must start and supervise it. If it is not running, queue rows remain `QUEUED` indefinitely.

---

## 4. Templates

Registry: `lib/notifications/templates.ts`.

| Template key | Purpose | Channels | Status |
|---|---|---|---|
| `purchase-proof.v1` | Purchase receipt after settlement | Email + WhatsApp | Registered |
| `ticket-issued.v1` | Ticket issued / wallet instructions | Email + WhatsApp | Registered |
| `reminder.h36.v1` | H-36 event reminder | WhatsApp (producer) | Registered |
| Post-event document template | Feature 4 | — | **NOT FOUND** |

Rendering is plain text. There is no HTML email template, no PDF attachment, no image attachment and no QR image attachment. The buyer receives a text proof/ticket message; the wallet is the visual ticket.

---

## 5. Purchase-proof pipeline (feature 2)

`lib/notifications/purchase-proof.ts`:

- Runs **after** `settleVerifiedPayment` commits.
- Eligible only when order `status = PAID`, `paymentStatus = PAID`, `paidAt` is non-null.
- Builds an immutable snapshot from order items/payment/tickets and current store contact.
- Enqueues one row per channel:
  - `purchase-proof:{orderNumber}:email:v1`
  - `purchase-proof:{orderNumber}:whatsapp:v1`
- Missing/invalid contact results in that channel being skipped, not the whole proof.
- It never throws; a queue failure is logged with sanitized metadata and returned as a channel failure.
- Recovery: `npm run sweep:purchase-proof` creates missing queue rows under the same keys (dry-run; no send).

**Duplicate prevention:** unique idempotency key per channel. A replayed webhook or repeated sweep converges on the existing row.

---

## 6. Ticket-issued pipeline

`lib/notifications/ticket-issued.ts`:

- Enqueued after ticket issuance creates rows.
- Separate idempotency key per channel.
- Renders ticket codes/wallet instructions.
- Same dry-run/worker/retry path as purchase proof.
- Recovery: `npm run sweep:ticket-issued`.

---

## 7. H-36 reminder pipeline (feature 1)

`lib/notifications/h36-reminder.ts`, `h36-reminder-template.ts`:

- Offset: exactly 36 hours (`H36_OFFSET_MS`).
- Due predicate: `now >= startAt - 36h` and `now < startAt` (inclusive target; not after start).
- Query: `PUBLISHED`, not cancelled, not archived, `startAt > now <= now + 36h`.
- Recipients: `ISSUED` tickets on `PAID/PAID` orders, phone from attendee or holder.
- One message per normalized phone per event (duplicate tickets to one phone do not spam).
- Channel: **WhatsApp only**.
- Idempotency key: `reminder.h36:{eventId}:{ticketId}:{startAtMs}:{channel}:v1`.
- A changed `startAt` produces a new key; the sweep reconciles stale queued rows (`superseded` counter), so a reschedule does not silently reuse the old occurrence.
- Timezone from `Event.timezone` is used in the human-readable time (`formatH36EventTime`); boundary math is UTC instants.
- Bounds: 25 events per tick, 500 tickets per event.
- Enqueue only; it never sends, claims or retries.

**Limitations:**
- If a tick is missed and the event has already started, the query (`startAt > now`) will not enqueue a late reminder.
- The 500-ticket per-event cap has no cursor; a event larger than 500 tickets may never remind tickets beyond the first 500 unless the design changes.
- Live delivery is blocked by the dry-run clamp.

---

## 8. Delivery status and observability

- Per-channel status is durable in `NotificationDelivery` (`QUEUED`, `SENDING`, `SENT`, `FAILED`, `SKIPPED`).
- Dry-run is explicitly `SKIPPED` with a simulated result, not success.
- Worker logs structured events (`notification.*`) without recipients or secrets.
- No dashboard for queue depth/failed deliveries was found. Operators must query the DB/logs.
- No dead-letter queue; failed rows remain inspectable and retryable up to `maxAttempts`.

---

## 9. Environment variables

Documented in `.env.example`:

```text
NOTIFICATIONS_ENABLED
EMAIL_TRANSPORT
WHATSAPP_TRANSPORT
WHATSAPP_DAILY_CAP
WHATSAPP_SEND_DELAY_MS
NOTIFICATION_WORKER_POLL_MS
NOTIFICATION_BATCH_SIZE
NOTIFICATION_LEASE_MS
```

SMTP host/port/user/pass and `WA_AUTH_DIR` are **commented out** in the example; nothing reads them while the clamp is on. No `FONNTE_*`, `WABLAS_*`, `TWILIO_*`, `SENDGRID_*`, `MAILGUN_*` or `RESEND_*` variables exist.

---

## 10. Findings

| # | Finding | Severity |
|---|---|---|
| N-1 | No live email/WhatsApp is possible in this build | Blocker for features 1/2/4 |
| N-2 | Worker is not supervised by PM2 and can be forgotten | High operational |
| N-3 | Purchase proof is text, not a PDF invoice/e-ticket | Medium product |
| N-4 | H-36 only covers WhatsApp; no email reminder | Medium (requirement says WhatsApp, so acceptable) |
| N-5 | H-36 misses reminders if the event starts before a tick runs | Medium edge case |
| N-6 | H-36 500-ticket cap lacks pagination | Medium for large events |
| N-7 | No queue monitoring UI/alerting | Medium operational |
| N-8 | Daily cap 20/day is incompatible with a document blast | High for feature 4 design |
| N-9 | Transports are fail-closed stubs, not accidentally connected | Strength |

---

## 11. Recommendations

1. Treat OPS-1 (live transport activation) as an owner decision, not a coding task; do not flip the constant without SMTP/Baileys hosting, credentials and a controlled test recipient.
2. Start and supervise the notification worker; expose queue depth/failed counts.
3. For feature 4, design a separate blast policy and batching; the current 20/day cap and 5s delay are intentionally conservative for proofs, not mass delivery.
4. Decide whether a PDF e-ticket is required; if so, add an attachment path explicitly.
5. Add a cursor or per-event pagination to H-36 before events exceed 500 tickets.
