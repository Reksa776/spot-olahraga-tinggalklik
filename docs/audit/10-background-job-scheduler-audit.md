# 10 — BACKGROUND JOB & SCHEDULER AUDIT

---

## 1. Scheduler shape

There is **no in-process timer, no Redis, no BullMQ, and no worker queue for jobs**. The production scheduler is external cron:

```
* * * * * curl -fsS -X POST https://HOST/api/internal/jobs/tick \
  -H "Authorization: Bearer $JOBS_TICK_SECRET"
```

`app/api/internal/jobs/tick/route.ts`:

- machine-authenticated with a shared bearer secret;
- constant-time comparison (`timingSafeEqual`), padded length check to avoid a length oracle;
- **fails closed (401)** when `JOBS_TICK_SECRET` is unset;
- returns job counts, never tenant or buyer data;
- imports no business logic; calls `runJobsTick()`.

`proxy.ts` classifies `/api/internal/` as pass-through because the caller is cron and has no session; the route's own secret is the control.

---

## 2. The three jobs

`lib/jobs/lock.ts` defines:

| Job | Purpose | Batch / limit |
|---|---|---|
| `event-lifecycle` | `PUBLISHED → ONGOING → COMPLETED` | 200 candidates/run |
| `reservation-reaper` | Expire abandoned orders and release held seats | 100/run |
| `h36-reminder` | Enqueue H-36 reminder outbox rows | 25 events/run, 500 tickets/event |

`lib/jobs/tick.ts` runs all three with **one `now`**, each under its own lease and try/catch. A failure in one does not stop the others; `ok` is true only if all ran successfully. A skipped (lease-held) job is not a failure.

---

## 3. Lease semantics

`JobLock` is a per-job row:

- `acquireJobLock` upserts the row then runs a conditional `updateMany` where `lockedUntil IS NULL OR lockedUntil < now`;
- `count === 1` means this invocation owns the job;
- `releaseJobLock` clears the lease and records `lastRunAt`/`lastStatus` (`OK`/`FAILED`/`SKIPPED`);
- lease duration is 5 minutes;
- a crashed run's lease is taken over after expiry.

The lease is an efficiency and observability guard, **not** the correctness guard. Jobs use conditional updates, so even overlapping runs produce at most one transition.

---

## 4. Notification worker (separate)

The notification worker is not part of the tick:

- entry point `scripts/notification-worker.ts`;
- `npm run worker:notifications` (poll) or `--once`;
- its own lease/claim in `lib/notifications/worker-lock.ts` and `NotificationDelivery` state;
- poll interval default 5s, batch 20, lease 120s;
- retries with `nextRetryAt` and `maxAttempts`;
- **not declared in `ecosystem.config.cjs`**.

So there are two independent operational processes: cron-driven tick and the notification worker.

---

## 5. Manual recovery commands

| Command | Effect |
|---|---|
| `npm run sweep:purchase-proof -- --limit 20` | Creates missing purchase-proof queue rows; no send |
| `npm run sweep:ticket-issued` | Creates missing ticket-issued queue rows; no send |
| `npm run worker:notifications -- --once` | Processes one batch |
| `npm run audit:ipaymu` | Operator audit script, not a job |

There is **no** manual H-36 sweep command; it runs only through the tick. There is no document-blast job.

---

## 6. Can the system support the four features?

| Capability | Ready? | Explanation |
|---|---|---|
| Scheduled H-36 enqueue | **Yes** | Third job exists, DB lease, idempotent outbox |
| H-36 live send | **No** | Dry-run clamp + worker activation |
| Purchase proof enqueue | **Yes** | Post-commit hook, recovery sweep |
| Purchase proof live send | **No** | Same clamp |
| PIC scan | **Yes** | Request-time, not a job |
| Bulk post-event document send | **No** | No producer, no document model, daily cap 20, no blast policy |

---

## 7. Monitoring and failure handling

**Available:** `JobLock.lastRunAt/lastStatus`, structured logs, tick JSON response with per-job counts, delivery rows with error codes, health/readiness endpoints.

**Missing / weak:** no alerting, no dashboard for stuck jobs, no dead-letter queue, no automatic retry of a failed tick (the next cron minute is the retry), no queue-depth metric, no worker supervision in PM2.

A tick that fails repeatedly records `FAILED` on the lease, but nobody is notified unless an external monitor watches the logs or `lastRunAt`.

---

## 8. Risks

| # | Risk | Severity |
|---|---|---|
| J-1 | Cron not installed/working → no lifecycle, no seat release, no reminders | Critical operational |
| J-2 | Notification worker not started → queue never drains | Critical operational |
| J-3 | No alerting on failed/stuck jobs | High |
| J-4 | H-36 cap 25 events/tick; a large backlog needs many minutes | Medium |
| J-5 | H-36 500 tickets/event without cursor | Medium |
| J-6 | Tick endpoint is public at the proxy but protected by secret; misconfigured secret fails closed | Strength |
| J-7 | No queue system for mass document delivery | High for feature 4 |
| J-8 | No real DB test of leases/concurrency in this session | Medium |

---

## 9. Recommendations

1. Treat cron and the notification worker as required production services; add both to deployment supervision and alerting.
2. Add a monitoring check for `JobLock.lastRunAt` older than a few minutes and for `NotificationDelivery.FAILED`/stuck `QUEUED`.
3. For feature 4, add a bounded batch job with cursor/pagination and a separately approved daily cap; do not reuse the 20/day proof policy.
4. Add H-36 pagination before events exceed 500 tickets.
5. Keep the single-clock tick and per-job lease; do not move business logic into cron.
