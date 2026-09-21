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

## 8. Local sandbox testing (iPaymu SANDBOX)

The goal is to run the **real** payment flow against the iPaymu SANDBOX while the application
stays on `localhost`. It works without deploying and without exposing the machine to the
internet.

1. **Sandbox does not require a verified IP or domain.** The provider's own sandbox
   documentation says so, and the platform is already pointed at it: `PAYMENT_ENVIRONMENT` is
   `sandbox`, and `lib/payment/config.ts` refuses to build a session without it.
2. **`localhost` is a valid application environment for local development.** API calls,
   payment-session creation and the browser return flow all work from `http://localhost:3000`.
3. **The provider's callback server cannot reach `localhost`.** This is the one thing that does
   not work, and it is not a bug in this codebase: iPaymu posts the callback *server-to-server*,
   so `http://localhost:3000/api/ticketing/payment/webhook` resolves to *iPaymu's own machine*
   and the connection is refused before any HTTP exchange. The sandbox dashboard shows the
   transaction as paid while the order stays **Menunggu Pembayaran** — the notification simply
   never arrived, and no row is written to `webhookevent`.
   > The `notifyUrl` is baked into the payment session when it is created, so changing
   > `NEXT_PUBLIC_APP_URL` after the fact does **not** re-point an existing session.
4. **Use Sandbox “Tes Notify”.** It generates a real callback request for the transaction,
   including the signature, so you do not have to construct one.
5. **Copy the generated request**, not a summary of it: the raw form-urlencoded body and, if it
   is sent as a header, the `X-Signature` value.
6. **POST that exact request to the local webhook.** The helper does it in one command and
   preserves the bytes:

   ```bash
   # Save the raw body exactly as Tes Notify shows it, then:
   node scripts/replay-sandbox-callback.cjs --body-file callback.txt --signature <X-Signature>
   ```

   Or with `curl` (`--data-binary`, never `-d`, so the body is not altered):

   ```bash
   curl -i -X POST http://localhost:3000/api/ticketing/payment/webhook \
     -H "Content-Type: application/x-www-form-urlencoded" \
     -H "X-Signature: <the value from Tes Notify>" \
     --data-binary @callback.txt
   ```
7. **Do not edit the payload or recompute the signature.** The signature covers the exact field
   set; a reordered body is still accepted (the verification canonicalises before signing), but
   any changed VALUE is not — it is refused as `401`.
8. **The local webhook performs the real checks.** A replayed request goes through the same
   chain as production: raw-body HMAC verification against the merchant VA, the amount check
   against `EventOrder.total`, the reference lookup against our own `Payment`, the
   `webhookevent` replay ledger, and the canonical settlement transaction. So a successful
   replay genuinely settles the order — it is not a shortcut and it is not a “mark as paid”.
   Tickets are **not** issued by the callback; issuance stays buyer-triggered.
9. **A public HTTPS tunnel is optional, not mandatory.** A tunnel (or any reachable HTTPS host)
   is only needed if you want iPaymu to deliver the callback *automatically* with no manual step.
   The replay above is the supported way to test the sandbox locally.

> **The alternative for a payment whose callback can never be re-delivered** is the
> operator-triggered reconciliation path (`PAYMENT_RECONCILE`, “Verifikasi status” on
> `/dashboard/payments`), which asks the provider for the transaction's authoritative status and
> feeds the same settlement engine. It requires the provider transaction id to have been
> persisted on the payment, so it cannot recover a session created before that column existed.

The automated counterpart to this section is `__tests__/ticketing-payment/sandbox-callback-replay.test.ts`,
which replays a captured, sanitized provider payload — the full 26-field shape — through the real
route and asserts the whole settlement and rejection chain.

## Health checks

Two endpoints, added in Phase 26. Both are public by design — a probe holds no session — and
neither returns a version, a hostname, dependency detail or any business data.

| Endpoint | Meaning | Status | Checks |
|---|---|---|---|
| `GET /api/health` | liveness — the process answers | always `200` | nothing |
| `GET /api/health/ready` | readiness — the process can serve | `200` / `503` | one `SELECT 1` |

Liveness deliberately touches nothing: restarting Node cannot fix a database that is down, so a
liveness probe that checked one would restart-loop a healthy server. Use `/api/health/ready`
when the question is "can I send traffic here?".

```bash
curl -fsS https://YOUR_HOST/api/health
curl -fsS https://YOUR_HOST/api/health/ready
```

## Deploying the application itself

The application is a standard Next.js server: `npm ci` → `npx prisma migrate deploy` →
`npm run build` → `pm2 reload tinggalklik`, behind a reverse proxy. The runtime is pinned to
Node 24 (`.nvmrc`), and the process definition is `ecosystem.config.cjs` — it binds loopback
and runs a single instance, both of which are load-bearing rather than preferences.

**Read [`DEPLOYMENT_RUNBOOK.md`](./DEPLOYMENT_RUNBOOK.md) before deploying.** It carries the
environment contract, the `TRUSTED_PROXY`/`x-forwarded-for` requirement, the upload-persistence
and backup contract, the migration procedure (forward-only; rollback is a restore), the
rollback steps, and the gate that must be satisfied before the scheduler in §1 is installed.

Whatever host you choose, the scheduler in §1 must eventually be installed on it, or the two
background behaviours described above will be silently inactive — but only after that gate is
met. Check out the
[Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying)
for platform details.
