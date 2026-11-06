# PHASE 4 — H-36 WHATSAPP REMINDER DESIGN

**Scope:** enqueue-only reminder engine, dry-run only, migration-free.
**Authority:** the audit (`docs/PHASE_4_H36_PREIMPLEMENTATION_AUDIT.md`) and the existing
notification/queue/job contracts.

---

## 1. Template — `reminder.h36.v1`

- New pure module `lib/notifications/h36-reminder-template.ts`.
- Registered in `lib/notifications/templates.ts` beside the two Phase 2 business templates.
- Payload (data, never markup):

```ts
{
  version: "v1",
  event: {
    title: string,
    startAt: string,        // ISO instant
    timezone: string,       // IANA, display only
    venueName: string|null,
    venueAddress: string|null,
    venueCity: string|null
  }
}
```

- No ticket code, no QR token, no phone, email, user id, order number or internal id.
- The renderer formats the start instant with `Intl.DateTimeFormat(..., { timeZone })`; an
  unrenderable zone falls back to the ISO instant plus the zone label rather than inventing a
  local time.
- Unknown payload shapes render a generic but honest message ("waktu yang dijadwalkan").

## 2. Job — `h36-reminder`

- `JOB_NAMES.H36_REMINDER = "h36-reminder"` — a deliberate third entry. The tick's two-job
  vocabulary was pinned by tests; those tests are updated to expect three, not bypassed.
- `runJobsTick` runs it under the same DB lease, with the same single `now`, and reports its own
  outcome so a failure cannot mask lifecycle/reaper results.
- `runH36ReminderSweep({ now, maxEvents: 25 })` is enqueue-only. It never claims a delivery,
  never renders, never sends, and never imports a transport.
- Batch ceiling: 25 events per tick, each event's issued-ticket select capped at 500.

## 3. Recipient eligibility

Query shape (per event):

```
event: status PUBLISHED, cancelledAt null, archivedAt null,
       startAt > now AND startAt <= now + 36h
tickets: status ISSUED
         order: status PAID, paymentStatus PAID, paidAt != null
```

Per ticket:

1. `attendeePhone` (trimmed) else `holder.phone`.
2. Missing → `skippedNoContact`.
3. `normalizeIndonesianPhone` fails → `skippedInvalidContact`.
4. Valid → one WhatsApp enqueue with the normalised `62…` recipient.

No new purchase policy is introduced: the paid rule is copied from the existing issuance
notification, and ticket status is the existing lifecycle.

## 4. H-36 calculation and window

```
target = startAt - 36h
due    = target <= now < startAt
```

- UTC arithmetic only; no host timezone.
- A tick that runs late catches up until `startAt`; after it, nothing is queued.
- `Event.timezone` is display metadata in the payload, validated before enqueue.
- An invalid `startAt`/timezone skips that event's tickets and is counted, never guessed.

## 5. Idempotency and occurrence identity

```
reminder.h36:{eventId}:{ticketId}:{startAtEpochMs}:{channel}:v1
```

- Compatible with `Notification.idempotencyKey @unique` (≈90 chars < 191).
- One row per ticket per channel per start instant.
- A duplicate tick or a second worker receives `created: false` from `enqueueNotification`; no
  second row and no second delivery.
- A reschedule changes the key, so the new occurrence cannot be mistaken for the old one.
- Uniqueness is not weakened: no suffix, random value or timestamp-of-enqueue is added.

## 6. Cancellation and reschedule reconciliation

Before enqueuing, the job examines at most 200 `QUEUED` WhatsApp deliveries whose template is
`reminder.h36.v1` and compares the payload's `startAt` with the event's current state:

| Condition | Result |
|---|---|
| event missing | `SKIPPED / REMINDER_EVENT_MISSING` |
| cancelled, archived, or not PUBLISHED | `SKIPPED / REMINDER_EVENT_CANCELLED` |
| current `startAt` ≠ payload instant | `SKIPPED / REMINDER_SUPERSEDED` |
| `startAt <= now` | `SKIPPED / REMINDER_WINDOW_PASSED` |

The transition is a CAS on `status = QUEUED`, so a delivery already `SENDING`/`SENT` is never
rewritten. `SKIPPED` is terminal and the worker never claims it.

## 7. Dry-run protection

- No code in this phase can set `PHASE_1_DRY_RUN_ONLY`; it stays a compiled constant.
- The reminder imports `enqueueNotification` only — not `worker.ts`, not `transports/*`.
- Under dry-run the worker records `SKIPPED / DRY_RUN_SIMULATED`, never `SENT` and never a
  provider message id.
- Live WhatsApp remains disabled; this phase has no pairing, socket, credential or provider call.

## 8. Error handling

- Per-ticket enqueue failure is counted and logged with `eventId`/`ticketId` and a sanitised
  error; the recipient phone is never logged.
- A database failure propagates to the leased job, which records `FAILED` on the lease and
  reports the error in the tick body, without aborting the other jobs.
- Enqueue failures are recoverable by the next tick because the occurrence is still missing
  from the outbox; no sweep table is needed.

## 9. Test plan (mocked/pure, honestly labelled)

1. Exactly 36 hours; one millisecond before/after the boundary; at `startAt`.
2. Timezone display differs between `Asia/Jakarta` and `UTC`; invalid zone refuses the payload.
3. Invalid `startAt` refuses the payload.
4. Cancelled event excluded by the query; queued cancelled row reconciled.
5. Rescheduled event: new key, old queued row superseded; stale payload never sent.
6. Eligible ticket enqueued once; missing/invalid phone skipped.
7. Duplicate enqueue returns `existing`; two concurrent sweeps produce one key.
8. Key length and start-instant identity.
9. Regression guard: reminder module imports no transport and never calls `send`.
10. Tick registers three jobs and passes one shared `now`.

No test claims database concurrency; the real-DB guarantee remains Phase 3G.
