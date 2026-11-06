# Existing Integration Review

**Status:** PLANNING ONLY — no source, schema, dependency, environment or account was changed.

**Purpose:** establish exactly what exists today before proposing a Baileys gateway. Every statement below is labelled:

- **VERIFIED** — read directly from the cited source file/location in this repository.
- **PROPOSED** — a design decision in this planning set, not current code.
- **UNVERIFIED** — requires a real database, a paired WhatsApp account, or a live provider; none was used.

The audit set in `docs/audit/` is preserved and is not superseded by this document.

---

## 1. Current end-to-end pipeline

**VERIFIED.** The notification subsystem is already a persistent outbox with a separate worker:

```
business transaction commits
  → producer calls enqueueNotification()
      → Notification            (logical message, idempotencyKey unique)
      → NotificationDelivery    (one row per channel, QUEUED)
  → notification worker (separate OS process)
      → acquire joblock:notification-dispatch
      → recover expired SENDING leases as FAILED/AMBIGUOUS_DELIVERY
      → claim due rows with conditional UPDATE (CAS)
      → render a registered template from payload JSON
      → transport.send()
      → SENT / QUEUED(retry) / FAILED / SKIPPED
```

Evidence:

| Layer | Source |
|---|---|
| Enqueue writer and two-layer idempotency | `lib/notifications/enqueue.ts:28-30`, `:173-207`, `:259` |
| Queue state machine and claim CAS | `lib/notifications/queue.ts:17-48`, `:93-166` |
| Retry/backoff/terminal failure | `lib/notifications/queue.ts:207-290` |
| Ambiguous delivery recovery | `lib/notifications/queue.ts:344-383` |
| Worker batch and transport selection | `lib/notifications/worker.ts:36-64`, `:382-505` |
| Worker lease/heartbeat | `lib/notifications/worker-lock.ts:1-106` |
| Worker entrypoint | `scripts/notification-worker.ts:1-83` |
| Registry of server-side templates | `lib/notifications/templates.ts:67-104` |
| Notification / delivery models | `prisma/schema.prisma:197-241`, `:1722-1744` |

**VERIFIED.** Three business producers exist:

| Producer | Trigger | Idempotency key | Channels |
|---|---|---|---|
| Purchase proof | post-commit in `settleVerifiedPayment` (`lib/ticketing/payment/settlement.ts:625-633`) | `purchase-proof:{orderNumber}:{email|whatsapp}:v1` (`lib/notifications/purchase-proof.ts:102-107`) | EMAIL, WHATSAPP |
| Ticket issued | post-commit after `issueTicketsForOrder` creates tickets (`lib/ticketing/tickets/issuance.ts:644`) | `ticket-issued:{orderNumber}:{email|whatsapp}:v1` (`lib/notifications/ticket-issued.ts:74-79`) | EMAIL, WHATSAPP |
| H-36 reminder | third tick job (`lib/jobs/tick.ts:169-173`) | `reminder.h36:{eventId}:{ticketId}:{startAtMs}:{channel}:v1` (`lib/notifications/h36-reminder.ts:95-110`) | WHATSAPP |

**VERIFIED.** A fourth producer does **not** exist: there is no document-blast template in `lib/notifications/templates.ts:67-72` and no document model in `prisma/schema.prisma`.

---

## 2. Why live delivery is disabled today

There are several independent gates. Removing only one does not enable a live send.

| # | Gate | Evidence | Effect |
|---|---|---|---|
| 1 | Kill switch defaults OFF | `lib/notifications/config.ts:86-94` (`readFlag`); `.env.example` sets `NOTIFICATIONS_ENABLED="false"` | No batch is claimed or written unless the value is exactly `true` |
| 2 | Compile-time dry-run marker | `lib/notifications/config.ts:38` `PHASE_1_DRY_RUN_ONLY = true` | Documents intent and is logged at `:259`, but **is not itself the clamp** |
| 3 | Hard-coded transport clamp | `lib/notifications/config.ts:173-181` maps requested `smtp`/`baileys` to `dry-run` unconditionally | Even `NOTIFICATIONS_ENABLED=true` plus `WHATSAPP_TRANSPORT=baileys` resolves to dry-run |
| 4 | Refusing adapters | `lib/notifications/transports/baileys.ts:42-53`; `lib/notifications/transports/smtp.ts:88-96` | Constructing either adapter throws; Baileys is never imported |
| 5 | Worker defaults to dry-run and rejects live injection | `lib/notifications/worker.ts:391-404` | The worker only instantiates dry-run transports and throws if an injected transport claims `smtp`/`baileys` |
| 6 | Worker is not supervised | `ecosystem.config.cjs:62-90` declares only the Next.js app | Queue rows remain `QUEUED` if the worker is not started manually |
| 7 | Worker runtime is not declared | `package.json:21` uses `npx tsx`; `scripts/notification-worker.ts:25` imports `dotenv/config`; neither `tsx` nor `dotenv` is a direct dependency in `package.json` | A clean production install can fail to launch the worker or fetch `tsx` at runtime |

**Key finding (VERIFIED).** `PHASE_1_DRY_RUN_ONLY` is not a functioning master switch. The effective transport is clamped by the two ternaries at `lib/notifications/config.ts:173-181`, and the worker separately refuses live transports at `lib/notifications/worker.ts:398-404`. A correct activation therefore requires all of the following:

1. Replace or bypass the hard-coded clamp with an explicit live configuration path.
2. Add a real Baileys transport that returns a provider message id.
3. Change the worker to select that transport under a fail-closed gate.
4. Remove the worker's refusal of the live transport.
5. Start and supervise the worker.
6. Provide the runtime (`tsx`/compiled output) and environment.

Changing only `PHASE_1_DRY_RUN_ONLY` would change a log line, not behaviour.

---

## 3. Configuration surface

**VERIFIED.** `resolveNotificationConfig()` reads (`lib/notifications/config.ts:144-253`):

| Variable | Current default | Behaviour |
|---|---|---|
| `NOTIFICATIONS_ENABLED` | false | Exact `"true"` only; everything else is OFF |
| `EMAIL_TRANSPORT` | `dry-run` | `disabled | dry-run | smtp`; `smtp` is refused and downgraded |
| `WHATSAPP_TRANSPORT` | `dry-run` | `disabled | dry-run | baileys`; `baileys` is refused and downgraded |
| `NOTIFICATION_WORKER_POLL_MS` | 5,000 | 1,000–300,000 |
| `NOTIFICATION_BATCH_SIZE` | 20 | 1–100 |
| `NOTIFICATION_LEASE_MS` | 120,000 | 30,000–900,000 |
| `WHATSAPP_DAILY_CAP` | 20 | 1–1,000, counted across all WhatsApp sends today |
| `WHATSAPP_SEND_DELAY_MS` | 5,000 | 0–60,000 |

**VERIFIED.** `WA_AUTH_DIR` is **not read by any runtime module**. It appears in `.env.example` only as a commented placeholder. `lib/notifications/transports/baileys.ts` explicitly does not touch it (`:34-40`).

**VERIFIED.** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `EMAIL_FROM` are read only by `readSmtpAdapterConfig()` (`lib/notifications/transports/smtp.ts:55-84`), which is not called by the worker while the clamp is active. `SMTP_PASS` is deliberately absent from that type.

---

## 4. Delivery model and its limits

**VERIFIED.** `Notification` (`prisma/schema.prisma:197-241`) stores:

- `idempotencyKey @unique`
- legacy `channel` string plus typed `NotificationDelivery.channel`
- `recipient`, `category`, `templateKey`, `payload` JSON text, `priority`
- subject links: `eventOrderId`, `ticketId`, `eventId`, `organizerId`, `picProfileId`

**VERIFIED.** `NotificationDelivery` (`prisma/schema.prisma:1722-1744`) stores:

- `status` (`QUEUED | SENDING | SENT | FAILED | SKIPPED`)
- `attemptCount`, `maxAttempts`, `nextRetryAt`
- `provider`, `providerMessageId`
- `queuedAt`, `sentAt`, `failedAt`
- `@@unique([notificationId, channel])`
- `@@index([status, nextRetryAt])`

**VERIFIED.** There is no acknowledgement field (`deliveredAt`, `readAt`, ack state), no gateway dispatch-idempotency table, and no document model.

**VERIFIED.** `nextRetryAt` doubles as the lease deadline while `status = SENDING` (`lib/notifications/queue.ts:20-40`). An expired `SENDING` row is moved to `FAILED` with `AMBIGUOUS_DELIVERY`; it is never automatically resent (`lib/notifications/queue.ts:344-383`). This is the correct foundation for an unreliable WhatsApp transport and must be preserved.

**VERIFIED.** The claim query orders only by `queuedAt` (`lib/notifications/queue.ts:116`). `Notification.priority` is stored by the producers (proof 10, ticket 20, H-36 30) but is not used for ordering. A large document blast therefore needs an explicit fairness policy; see `notification-reliability-design.md`.

---

## 5. WhatsApp and email transport inventory

| Transport | Current state | Evidence |
|---|---|---|
| Dry-run email | Instantiable; returns `{ simulated: true }` | `lib/notifications/transports/dry-run.ts:29-45` |
| Dry-run WhatsApp | Instantiable; returns `{ simulated: true }` | `lib/notifications/transports/dry-run.ts:47-66` |
| Baileys adapter | Refusing stub, no Baileys import, no socket | `lib/notifications/transports/baileys.ts:1-53` |
| SMTP adapter | Refusing stub, no Nodemailer import | `lib/notifications/transports/smtp.ts:1-96` |
| `@whiskeysockets/baileys` | Declared `6.7.24` | `package.json:45` |
| `nodemailer` | Declared `8.0.11` | `package.json:55` |
| Meta Cloud API / BSP | **NOT FOUND** | no provider package or route |
| Fonnte / Wablas / Twilio | **NOT FOUND** | no provider package or route |

**VERIFIED.** The dry-run result is written as `SKIPPED` with `errorCode = DRY_RUN_SIMULATED`, never `SENT` (`lib/notifications/worker.ts:302-317`; `lib/notifications/queue.ts:186-204`). No live send can be mistaken for a success today.

---

## 6. Worker lifecycle and current operational behaviour

**VERIFIED.** `scripts/notification-worker.ts`:

- loads `.env` through `dotenv/config` (`:25`);
- resolves config once (`:31`);
- creates the worker (`:33-35`);
- handles `SIGTERM`/`SIGINT`, awaits the in-flight batch, disconnects Prisma and exits (`:39-65`);
- supports `--once` for a single batch (`:67-73`).

**VERIFIED.** `createNotificationWorker()` polls forever and catches per-batch errors so one transient failure does not kill the loop (`lib/notifications/worker.ts:537-612`). The worker lease row is `notification-dispatch` (`lib/notifications/worker-lock.ts:36`), released with `lastRunAt`/`lastStatus` on every completion (`:82-106`).

**VERIFIED.** `ecosystem.config.cjs` contains only `tinggalklik` (`:64`). It has no worker app and no WhatsApp process. `npm run worker:notifications` must be started manually.

---

## 7. Test evidence

**VERIFIED.** There are 13 test files directly under `__tests__/notifications/`:

```
h36-reminder.test.ts
logging.test.ts
purchase-proof.integration.test.ts
purchase-proof-template.test.ts
purchase-proof-wiring.test.ts
purchase-proof-worker.test.ts
queue.test.ts
ticket-issued.integration.test.ts
ticket-issued-template.test.ts
ticket-issued-wiring.test.ts
ticket-issued-worker.test.ts
transports.test.ts
worker.test.ts
```

**VERIFIED (from the audit, not re-run in this session).** The 3F focused run was 11 suites / 339 tests, all passing, but it was mocked/pure and no real MariaDB was used because `TEST_DATABASE_URL` is unset. The notification suites named above are not proof of a live provider or a real queue race.

**UNVERIFIED.** No Baileys pairing, socket, message send, SMTP connection or real database contention has been exercised. This planning set does not claim otherwise.

---

## 8. Constraints the gateway design must respect

1. **One WhatsApp number for every organizer and event.** No per-organizer socket, no per-event session.
2. **One active socket.** Two sockets on the same credentials disconnect each other; the session is account-level authority.
3. **One queue.** `Notification` / `NotificationDelivery` remain the source of truth; the gateway is a transport, not a second queue.
4. **One worker.** The existing worker owns retries and terminal states; the gateway must not retry an ambiguous send on its own.
5. **No browser pairing.** A QR rendered in a web route is an account-takeover primitive. Pairing is an operator CLI action on the host.
6. **No secret in logs or payloads.** `lib/notifications/logger.ts` already redacts secret-shaped keys and masks recipients; gateway logs must use the same discipline.
7. **No exactly-once claim.** Baileys has no exactly-once guarantee. The design must make duplicates detectable and bounded, not pretend they are impossible.
8. **Dry-run remains the default outside the approved activation window.**
9. **The worker is currently not deployable as a clean service** because `tsx` and `dotenv` are not direct dependencies; this is a prerequisite, not a gateway feature.
10. **The current 20/day WhatsApp cap is a proof/reminder policy, not a blast policy.** A document blast requires a separately approved cap and fairness rules.

---

## 9. Conclusion

The repository already has a strong notification **foundation**: persistent outbox, unique idempotency keys, CAS claiming, lease recovery, ambiguous-delivery refusal, retries, sanitised logging and a separate worker. It does **not** have a live WhatsApp transport, session custody, a connection owner, acknowledgement tracking or a document-distribution model.

The correct next step is not to rewrite the notification layer. It is to add a single-owner Baileys gateway behind the existing `WhatsAppTransport` contract, make the worker's transport selection explicitly live under a fail-closed gate, and keep the existing queue/retry semantics as the only delivery authority.
