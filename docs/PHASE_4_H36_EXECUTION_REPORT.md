# PHASE 4 — H-36 WHATSAPP REMINDER EXECUTION REPORT

**Scope:** reminder engine, dry-run only, migration-free.
**Verdict:** **PASS WITH LIMITATIONS**

---

## 1. Baseline Git state

```
repository /home/reksa/tinggalklik
branch     main
HEAD       9b8fecd99bcc74677c1805c18379241af04fddd1
staged     0
modified   4 tracked (2 Phase 3C baseline + 2 Phase 3E)
untracked  Phase 2–3E reports, 3B/3C modules, 3D route, 3E page/suite
```

Preserved untouched: `lib/ticketing/checkin/service.ts` and
`__tests__/ticketing-checkin/check-in-wiring.test.ts` (Phase 3C), the 3D route, the 3E page and
scanner, and every prior report. No reset, stash, checkout, restore or clean.

## 2. Pre-implementation audit

`docs/PHASE_4_H36_PREIMPLEMENTATION_AUDIT.md`. Confirmed reusable, with exact callers:

- registry/`renderNotification` (`lib/notifications/templates.ts`),
- outbox `enqueueNotification` + unique key (`lib/notifications/enqueue.ts`),
- queue state machine and worker (`queue.ts`, `worker.ts`),
- contacts (`normalizeIndonesianPhone`),
- DB-leased tick (`lib/jobs/tick.ts`, `lib/jobs/lock.ts`),
- `Event.startAt/timezone`, `Ticket.attendeePhone/holder.phone/status`,
  `EventOrder.status/paymentStatus/paidAt`.

Audit conclusion: the unique key plus existing delivery states represent an occurrence; **no
schema change is required**.

## 3. Design

`docs/PHASE_4_H36_DESIGN.md`. Occurrence identity is
`reminder.h36:{eventId}:{ticketId}:{startAtMs}:{channel}:v1`; the job enqueues at the due boundary
and reconciles queued rows against the event's current state.

## 4. Files changed

| File | Change |
|---|---|
| `lib/notifications/h36-reminder-template.ts` | **NEW** — payload builder, zone validation, renderer |
| `lib/notifications/h36-reminder.ts` | **NEW** — due window, occurrence key, sweep, reconciliation |
| `lib/notifications/templates.ts` | registers `reminder.h36.v1`; Phase 5 remains unregistered |
| `lib/jobs/lock.ts` | third job `h36-reminder` |
| `lib/jobs/tick.ts` | runs the reminder under the same lease/`now`, reports its own outcome |
| `__tests__/notifications/h36-reminder.test.ts` | **NEW** — 22 focused tests |
| `__tests__/jobs/tick.test.ts` | intentionally widened to three jobs; reminder mocked |
| `__tests__/notifications/purchase-proof-template.test.ts` | boundary assertion: reminder now registered, Phase 5 template still absent |
| `docs/PHASE_4_H36_*` | audit, design, this report |

No schema, migration, package, transport, worker, proxy or route change.

## 5. Scheduler / job integration

`JOB_NAMES.H36_REMINDER = "h36-reminder"`; `runJobsTick` runs it after lifecycle and reaper via
`runLeasedJob`, with the **same `now`** and its own lease row. Batch ceiling 25 events. A failed
reminder run sets the overall tick `ok: false` but does not prevent the other two jobs, matching
the existing per-job isolation. It is enqueue-only: no claim, render, send or retry.

## 6. Recipient eligibility evidence

Query: `Event.status = PUBLISHED`, `cancelledAt/archivedAt null`,
`startAt ∈ (now, now + 36h]`; `Ticket.status = ISSUED`; `order.status = PAID`,
`paymentStatus = PAID`, `paidAt != null`. That paid rule is copied from
`lib/notifications/ticket-issued.ts:275-292` — no new purchase policy.

Recipient: `attendeePhone` then `holder.phone`, normalised to `62…`. Missing → counted skip;
invalid → counted skip. Two tickets sharing one phone produce **one** message (first by
`createdAt`), counted as `skippedDuplicateRecipient`. The occurrence key stays per ticket as
specified, so the outbox remains ticket-addressable.

## 7. H-36 calculation evidence

`target = startAt - 36h`; due when `target <= now < startAt`. Pure helpers
`h36ReminderTargetAt` / `isH36ReminderDue` are used by the sweep (the query also bounds the same
window). Tests pin: 1 ms before target → not due; exactly at target → due; 1 ms before start →
due; at start → not due; after start → not due.

## 8. Reschedule / cancellation behaviour

Before enqueue, up to 200 `QUEUED` WhatsApp rows with the reminder template are compared with the
event's current state; the transition is a CAS on `status = QUEUED`:

| Condition | Result |
|---|---|
| event missing | `SKIPPED / REMINDER_EVENT_MISSING` |
| cancelled / archived / not PUBLISHED | `SKIPPED / REMINDER_EVENT_CANCELLED` |
| current `startAt` ≠ payload instant | `SKIPPED / REMINDER_SUPERSEDED` |
| `startAt <= now` | `SKIPPED / REMINDER_WINDOW_PASSED` |

A reschedule changes the key, so the new occurrence is a distinct row; the old queued occurrence
is retired before it can be sent with a stale time. A delivery already `SENDING`/`SENT` is never
rewritten. `SKIPPED` is terminal and is not claimed again.

## 9. Idempotency evidence

- Key ≈90 chars, below `MAX_IDEMPOTENCY_KEY_LENGTH = 191`; construction throws rather than
  truncating.
- `Notification.idempotencyKey @unique` → duplicate tick returns the existing row
  (`created: false`), counted as `existing`.
- Tests: repeated tick → existing, not a second row; two concurrent sweeps with a shared key set
  → one created key, two calls, one `enqueued` + one `existing`; reschedule → different key;
  channels → different keys.
- Per-recipient dedupe prevents two tickets to the same phone from producing two messages.
- Uniqueness is not weakened by suffix/random/timestamp.

## 10. Dry-run safety evidence

- `PHASE_1_DRY_RUN_ONLY` is untouched and remains a compile-time `true` in
  `lib/notifications/config.ts:38`; the effective transport can only be `dry-run`/`disabled`.
- `h36-reminder.ts` imports the outbox and contacts only; a static test asserts it contains no
  `transports`/`baileys`/`nodemailer`/`smtp`, no `.send(`, no claim function.
- The worker records a simulated delivery as `SKIPPED / DRY_RUN_SIMULATED`, never `SENT` and
  never a provider message id.
- No real WhatsApp message was sent; no credentials or pairing are read.

## 11. Tests and exact counts

DB-free Jest config (outside the repo, `/tmp/p4.jest.json`) because the repository's default
setup requires `TEST_DATABASE_URL`, which is not set:

```
Test Suites: 10 passed, 10 total
Tests:       323 passed, 323 total
```

| Suite | Tests |
|---|---|
| `h36-reminder.test.ts` (**new**) | **22** |
| `pic-assignment` | 66 |
| `qr-payload-validation` | 76 |
| `check-in-transaction` | 50 |
| `check-in-wiring` | 29 |
| `pic-scan-api` | 24 |
| `pic-scan-authz` | 20 |
| `qr-payload-contract` | 17 |
| `pic-scan-page` | 13 |
| `route-classification` | 6 |

The new suite is explicitly labelled mocked/pure: mocked Prisma + mocked enqueue. It does not
prove real unique-index concurrency, real delivery or a live database.

## 12. TypeScript / ESLint / diff check

```
npx tsc --noEmit                 exit 0
npx eslint <8 phase files>       exit 0
git diff --check                 exit 0
```

No `any`, `@ts-ignore`, lint suppression or weakened assertion was added.

## 13. Database limitations

- `TEST_DATABASE_URL`/`DATABASE_URL` are not set; no Prisma query was executed and no database
  test was run.
- `prisma/schema.prisma` sha256 `0f48e1ce…ac4a99` unchanged; `prisma/` and `prisma/migrations/`
  clean; no migrate/push/reset/seed/truncate.
- `__tests__/jobs/tick.test.ts` was updated for the third job but not executed (requires the
  test database); the tick contract is therefore covered by types and review, not a run.
- Real duplicate-key behaviour under two connections is unverified until Phase 3G.

## 14. Security review

| Concern | Result |
|---|---|
| Race between ticks/workers | Job lease + unique occurrence key; second run returns existing |
| Duplicate reminder per participant | Per-recipient dedupe inside an event; key stays per ticket |
| Timezone correctness | UTC arithmetic; IANA zone only for display; invalid zone refused |
| Reschedule | New key; old queued row superseded before send |
| Cancellation | Excluded at enqueue; queued rows retired (`REMINDER_EVENT_CANCELLED`) |
| Tenant/event isolation | Query selects only the event's own tickets; no client input |
| Participant eligibility | Paid order + issued ticket rule reused from issuance |
| Contact privacy | No phone/email in payload, template, logs or subject; sanitised errors |
| Dry-run bypass | No transport import; config clamp untouched; static test |
| Outbox uniqueness | Unique key, no truncation, no random suffix |
| Worker lease | Existing delivery lease/backoff unchanged |
| Purchase-proof regression | No change to its module; only the registry gained one entry; its boundary test updated |

No security-critical defect found.

## 15. Remaining work

1. Live WhatsApp delivery — blocked on the owner transport/session decision; still dry-run.
2. Real-database verification of the job and unique-key race (Phase 3G).
3. Batch pagination for events with more than 500 issued tickets: the select takes 500 ordered by
   `createdAt`, so tickets beyond the cap are not reached in later ticks. A cursor/batching
   design is needed if such events are expected.
4. Email reminder channel is not implemented (objective is WhatsApp).
5. No opt-out/preferences, no reminder cancellation UI, no per-event reminder override.
6. Phase 3F/3G and Phase 5 remain untouched.

## 16. Final Git state

```
HEAD 9b8fecd99bcc74677c1805c18379241af04fddd1   (unchanged)
branch main · staged 0
M __tests__/jobs/tick.test.ts                     (Phase 4)
M __tests__/notifications/purchase-proof-template.test.ts (Phase 4 boundary)
M __tests__/ticketing-checkin/check-in-wiring.test.ts     (baseline 3C)
M app/dashboard/pic/page.tsx                      (Phase 3E)
M components/organizer/TicketScanner.tsx          (Phase 3E)
M lib/jobs/lock.ts                                (Phase 4)
M lib/jobs/tick.ts                                (Phase 4)
M lib/notifications/templates.ts                  (Phase 4)
M lib/ticketing/checkin/service.ts                (3C/3D)
?? lib/notifications/h36-reminder.ts
?? lib/notifications/h36-reminder-template.ts
?? __tests__/notifications/h36-reminder.test.ts
?? docs/PHASE_4_H36_PREIMPLEMENTATION_AUDIT.md
?? docs/PHASE_4_H36_DESIGN.md
?? docs/PHASE_4_H36_EXECUTION_REPORT.md
```

No commit, push, deploy, tag, stage, amend, reset, stash, clean, checkout or restore; no
migration; `.cloud-attachments/` untouched.

## 17. Final verdict

**PASS WITH LIMITATIONS** — the reminder engine is implemented, migration-free, enqueue-only and
provably dry-run; it handles eligibility, the 36-hour boundary, timezone display, duplicates,
reschedules and cancellations. It is not proven against a real database, and it does not (and
must not yet) send a real WhatsApp message.
