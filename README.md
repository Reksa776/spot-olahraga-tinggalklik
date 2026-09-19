This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out the [Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

---

# Operations

Everything below is part of the running system, not framework boilerplate. It documents what the
code actually does, so an operator can run the platform without reading the source.

Two background behaviours are **not optional**: event lifecycle automation and reservation
expiry. Both run through the same internal tick endpoint, and **neither runs unless a scheduler
calls it.** If the tick is not scheduled, events never complete and abandoned checkouts never
release their seats.

## 1. Scheduler (required)

**Endpoint:** `POST /api/internal/jobs/tick`

**Authentication:** machine-only, not session-based.

```
Authorization: Bearer $JOBS_TICK_SECRET
```

The route has **no session gate** — the caller is cron, which has no session — so its entire
authority is that secret, compared in constant time. It **fails closed**: if `JOBS_TICK_SECRET`
is unset the route returns `401` for every request, so an unconfigured deployment never exposes
an unauthenticated "run every job" endpoint. A refusal is a bare `401` and never logs the
presented value.

Generate the secret:

```bash
openssl rand -hex 32
```

Set it in the application's environment (see `.env.example`), then add the schedule on the host
that serves the application.

**VPS cron** (the supported deployment shape — the tick needs a persistent host, not a
serverless function):

```cron
* * * * * curl -fsS -X POST https://YOUR_HOST/api/internal/jobs/tick \
  -H "Authorization: Bearer $JOBS_TICK_SECRET" >/dev/null
```

**systemd timer** (preferred where systemd is available, because run output is captured and a
persistent `401` cannot pass unnoticed):

```ini
# /etc/systemd/system/tinggalklik-tick.service
[Unit]
Description=TinggalKlik.Co job tick

[Service]
Type=oneshot
EnvironmentFile=/etc/tinggalklik/tick.env   # JOBS_TICK_SECRET=...
ExecStart=/usr/bin/curl -fsS -X POST https://YOUR_HOST/api/internal/jobs/tick -H "Authorization: Bearer ${JOBS_TICK_SECRET}"
```

```ini
# /etc/systemd/system/tinggalklik-tick.timer
[Unit]
Description=Run the TinggalKlik.Co job tick every minute

[Timer]
OnCalendar=*-*-* *:*:00
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tinggalklik-tick.timer
```

> **Do not** deploy only to a serverless platform and assume the tick runs. The design has no
> platform-cron integration and no long-lived worker process (no Redis, no BullMQ, no
> `setInterval`) — by decision. A serverless-only deployment would need that decision revisited.

**Frequency:** one request per minute. Both jobs are bounded batches over the *current* time, so
a slower cadence is safe (a missed tick is recovered by the next one — completion has a 30-minute
grace, and expiry catch-up is allowed); a faster one is pointless. Nothing requires a tighter
interval.

**Overlap / single-flight:** each job takes a lease row in the `joblock` table
(`event-lifecycle`, `reservation-reaper`) for 5 minutes. A second concurrent tick is a cheap
no-op; a crashed run releases itself when the lease expires, with no operator action. The lease
is a convenience, not the correctness guard — every transition the jobs perform is a conditional
database write, so even a fully overlapping run can only produce one transition.

**Verifying the tick ran** (there is no UI for this):

```sql
SELECT name, lastRunAt, lastStatus, lockedUntil FROM joblock;
```

`lastRunAt` is the last run that actually executed, and `lastStatus` is `OK` or `FAILED` for it.
`NULL` means the job has never run — which, on a live deployment, means the schedule is missing
or failing. Prefer logging the HTTP status over `>/dev/null` so a rotated or mistyped secret is
visible.

## 2. Event lifecycle automation

Time-driven, and monotonic — `DRAFT → PUBLISHED → ONGOING → COMPLETED`, plus `CANCELLED` and the
terminal `ARCHIVED`.

| Transition | Trigger |
|---|---|
| `DRAFT → PUBLISHED` | organizer, `event.publish`; requires a sellable ticket type, a **future `startAt`**, and an **`endAt`** |
| `PUBLISHED → ONGOING` | tick, when `startAt` is reached |
| `PUBLISHED`/`ONGOING → COMPLETED` | tick, at `endAt` + 30 minutes (or by hand once `endAt` has passed) |
| `PUBLISHED`/`ONGOING → CANCELLED` | organizer |
| any non-archived → `ARCHIVED` | organizer; soft delete, nothing removed |

An event **cannot be published without an end time** — an `endAt`-less event could never
complete, so it would stay live indefinitely. `endAt` stays editable while the event is a draft,
published or running.

Neither completion nor cancellation **moves money**, and neither voids issued tickets.

## 3. Reservation expiry

A checkout holds seats for `PlatformSetting.reservationTtlMinutes` (default 30). The tick claims
each expired `PENDING_PAYMENT` order, releases its held seats and closes any open payment session,
so an abandoned checkout returns its inventory automatically. Without the tick, held seats are
never released and events appear sold out.

## 4. Refunds (manual bank transfer)

There is **no automated refund rail**. The payment provider used for collection has no outbound
refund API, so refunds are performed by a human and recorded in the dashboard.

```
PENDING ──approve──▶ APPROVED ──process──▶ PROCESSING ──settle(evidence)──▶ REFUNDED
   └──reject──▶ REJECTED                      └──fail──▶ FAILED
```

- A buyer requests a refund for tickets on a paid order. **Only `PAID`/`PARTIALLY_REFUNDED`
  orders are refundable**, and a checked-in ticket is never refundable.
- Staff approve or reject; the requester can never decide their own request.
- `PROCESSING` means an operator is handling it. **It does not mean the money has moved.**
- `REFUNDED` requires recorded transfer evidence (bank reference + note) and is the only step
  that returns quota. It is idempotent and transaction-safe.
- At most **one** refund may be `PROCESSING` per order, and the confirmed total can never exceed
  the order's refundable balance.
- A ticket with an open refund (`PENDING`/`APPROVED`/`PROCESSING`) **cannot be checked in**, and
  a checked-in ticket cannot be refunded.

**Reconciliation is manual.** A recorded bank reference is a claim, not proof, until it is
checked against the bank statement. There is no automatic settlement of refunds, and none should
be assumed — do not mark a refund `REFUNDED` without evidence of a real transfer.

An open refund also **blocks archiving** its event: `/dashboard/refunds` is where they are found
and cleared.

## 5. Late settlements and "needs action"

If a provider payment arrives for an order that has already expired or been cancelled, the money
is **recorded and fulfilment is blocked** — no tickets are issued, no order is resurrected, no
quota is returned, and nothing is refunded automatically. The order appears under the
**"Perlu tindakan"** filter on `/dashboard/orders`, together with paid orders that have no tickets
issued yet. That queue is the operational remedy: resolve it manually.

Ticket issuance is **buyer-triggered** — a paid order issues its tickets when the buyer asks, so a
paid order with zero tickets is a recoverable state, not a failure.

## 6. Notifications

**Dashboard-only.** The platform sends no email, WhatsApp or SMS messages: every operational
signal in this section is a row an operator sees in the dashboard, and no buyer notifications are
sent. Treat the dashboard as the channel of record.

## 7. Provider webhook ledger

Payment callbacks are recorded in the `webhookevent` table — one row per delivery, including
refused signatures — with a redacted payload summary and a payload hash for forensics. **There is
no UI for it**: investigate through the database. Providers retry failed deliveries themselves;
there is no manual replay control, by design, and a status poll is never treated as a settlement.

## Deploying the application itself

The application is a standard Next.js server; it can be built and run with `npm run build` and
`npm start` behind a reverse proxy. Whatever host you choose, the scheduler in §1 must be
installed on it, or the two background behaviours described above will be silently inactive.
Check out the [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying)
for platform details.
