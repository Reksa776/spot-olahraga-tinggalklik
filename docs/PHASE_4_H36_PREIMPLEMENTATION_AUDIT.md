# PHASE 4 — H-36 WHATSAPP REMINDER PRE-IMPLEMENTATION AUDIT

**Repository:** `/home/reksa/tinggalklik` · branch `main` · HEAD
`9b8fecd99bcc74677c1805c18379241af04fddd1`
**State at audit:** staged 0 · 4 tracked modifications (2 baseline Phase 3C + 2 Phase 3E) ·
untracked Phase 2–3E artifacts · no migration · `TEST_DATABASE_URL` absent.
**Verdict of this audit:** a migration-free, dry-run-only implementation is possible.

---

## 1. What exists, and the exact callers

| Concern | Actual implementation | Caller today |
|---|---|---|
| Template registry | `lib/notifications/templates.ts` — `TEMPLATES`, `hasTemplate`, `renderNotification` | worker via `renderNotification` |
| Versioned renderers | `purchase-proof-template.ts`, `ticket-issued-template.ts` | registry |
| Outbox writer | `lib/notifications/enqueue.ts` — `enqueueNotification`, `MAX_IDEMPOTENCY_KEY_LENGTH = 191` | settlement hook, issuance hook, sweeps |
| Queue state machine | `lib/notifications/queue.ts` — `claimDueDeliveries`, `markDeliverySimulated`, `markDeliverySkipped`, `recoverExpiredDeliveryLeases` | `lib/notifications/worker.ts` |
| Worker | `lib/notifications/worker.ts` + `scripts/notification-worker.ts` | separate process |
| Transport clamp | `lib/notifications/config.ts:38` `PHASE_1_DRY_RUN_ONLY = true`; effective transport can only be `dry-run`/`disabled` | worker startup |
| Contacts | `lib/notifications/contacts.ts` — `normalizeIndonesianPhone`, `normalizeEmail` | purchase-proof, ticket-issued |
| Scheduler | `app/api/internal/jobs/tick/route.ts` → `runJobsTick` (`lib/jobs/tick.ts`) | VPS cron, bearer secret |
| Lease | `lib/jobs/lock.ts` — `JOB_NAMES`, `acquireJobLock`, `releaseJobLock` | tick |
| Event time | `Event.startAt`, `Event.endAt`, `Event.timezone` (`prisma/schema.prisma:927-931`) | lifecycle, ticket-issued |
| Ticket recipient | `Ticket.attendeePhone`, `Ticket.attendeeEmail`, `Ticket.holder.phone`, `Ticket.status` (`:1185-1195`) | none for reminders |
| Paid eligibility | `EventOrder.status`, `paymentStatus`, `paidAt` (`:1069-1079`) | purchase-proof, ticket-issued |
| Cancellation/archive | `Event.cancelledAt`, `Event.archivedAt`, `Event.status` | check-in, ticket-issued |

No second scheduler, outbox, queue, transport or contact normaliser exists — the reminder must
reuse each of these.

## 2. Why the schema already suffices

- `Notification.idempotencyKey` is `@unique` (`schema.prisma:203`). The enqueue helper treats a
  collision as a benign replay and returns the existing row.
- `NotificationDelivery` is unique on `(notificationId, channel)` (`:1740`), so fan-out cannot
  double-send one channel.
- `Notification` carries `eventId`, `ticketId`, `eventOrderId`, `organizerId`, `category`,
  `templateKey`, `payload`, `priority` — every field a reminder needs.
- Delivery state has `QUEUED | SENDING | SENT | FAILED | SKIPPED`; `SKIPPED` is terminal and is
  never claimed, which is exactly the vocabulary needed to retire a superseded occurrence.
- No `scheduledFor` column is required: the job enqueues when the 36-hour boundary is due, and the
  unique key is the occurrence record.

**Key-length check:** `reminder.h36:` (13) + event cuid (≤25) + `:` + ticket cuid (≤25) + `:` +
epoch milliseconds (13) + `:` + channel (≤8) + `:v1` (3) ≈ 90 characters, well under 191.

## 3. Eligibility, derived rather than invented

The existing post-issuance feature (`lib/notifications/ticket-issued.ts:275-292`) defines a paid
order as:

```
order.status === "PAID" && order.paymentStatus === "PAID" && order.paidAt !== null
```

and a notifiable event as not `CANCELLED` / `ARCHIVED`. The reminder reuses that rule, plus:

- `Ticket.status === "ISSUED"` — a `RESERVED` ticket was never paid, `VOID`/`REFUNDED` must not
  receive an event reminder, and `CHECKED_IN` belongs to an event that already started.
- `Event.status === "PUBLISHED"` and `cancelledAt/archivedAt === null` at enqueue time.
- `startAt > now` — a reminder is never queued for a started event.

Recipient precedence: `Ticket.attendeePhone` (the person admitted), then `Ticket.holder.phone`.
A missing phone is skipped; an unnormalisable phone is skipped. Neither is ever guessed.

## 4. Timing and timezone

- `startAt` is a `DateTime` (UTC instant). The H-36 target is
  `startAt.getTime() - 36 * 60 * 60 * 1000`.
- The event window is `target <= now < startAt`: a reminder is due exactly at the boundary,
  catch-up is possible until the event starts, and nothing is sent after it begins.
- `Event.timezone` is an IANA name (default `Asia/Jakarta`). It is used **only for display** in
  the rendered message; the due calculation never uses a local clock.
- An invalid timezone or invalid `startAt` refuses the payload rather than emitting a wrong time.

## 5. Cancellation and rescheduling today

There is no reminder row, so nothing exists to cancel. Two behaviours must be designed:

1. **Cancelled/archived event** — excluded by the enqueue query; a row queued before the
   cancellation but not yet sent must be retired by reconciliation, because the worker is generic
   and must not learn event rules.
2. **Rescheduled event** — the occurrence key includes the start instant
   (`…:{startAt.getTime()}:…`). A new start is a new occurrence; the old queued occurrence is
   marked `SKIPPED` with `REMINDER_SUPERSEDED`, so it can never be sent with a stale time.

## 6. Dry-run enforcement trace

```
cron → POST /api/internal/jobs/tick (bearer secret)
     → runJobsTick → runH36ReminderSweep        (ENQUEUE ONLY — no transport import)
     → notification + notificationdelivery rows (QUEUED)
worker (separate process) → claimDueDeliveries
     → resolveNotificationConfig()              (PHASE_1_DRY_RUN_ONLY = true)
     → effective transport = dry-run | disabled
     → dry-run send() returns { simulated: true }
     → markDeliverySimulated() → status SKIPPED, errorCode DRY_RUN_SIMULATED
```

There is no path from the reminder module to `transports/baileys.ts` or `transports/smtp.ts`, and
no path that writes `SENT` under dry-run. The reminder adds a producer only.

## 7. Tests and configuration

- Existing suites: `__tests__/notifications/` (12 files) and `__tests__/jobs/tick.test.ts`, all of
  which require the repository's Jest setup; the setup requires `TEST_DATABASE_URL`, which is not
  present in this environment. They are therefore **not run** in this phase.
- The DB-free config used for Phase 3E (`/tmp/p3e.jest.json`) can be extended with the new pure/
  mocked suites.
- `__tests__/notifications/purchase-proof-template.test.ts:169` currently asserts
  `hasTemplate("reminder.h36.v1") === false`. Registering the template requires that assertion to
  flip — an intentional, documented test change, not a weakened one.

## 8. Stop conditions checked

| Condition | Finding |
|---|---|
| Schema change unavoidable? | **No** — unique key + existing delivery state suffice |
| Outbox cannot represent an occurrence? | **No** — key includes event, ticket, start instant, channel |
| Scheduler cannot guarantee safe leasing? | **No** — DB lease exists and is reused |
| Dry-run guard bypassable? | **No** — compile-time constant clamps the transport |
| Timezone/reschedule ambiguous? | **No** — UTC instant for calculation, IANA zone for display, key carries the instant |
| Uncommitted files conflict? | **No** — the reminder adds new files and touches the tick/template registry only |

## 9. Conclusion

Proceed with a migration-free implementation: one template module, one sweep module, one new
leased job, a registry entry, the tick wiring, and focused tests. Live WhatsApp remains disabled
by the existing compile-time clamp and is out of scope.
