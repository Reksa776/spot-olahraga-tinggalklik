# PROJECT BUG AUDIT REPORT — TINGGALKLIK

**Audit type:** READ-ONLY. No source, database, migration, or git state was changed.
**Repository:** `/home/reksa/tinggalklik` (branch `main`).
**Audited revision:** working tree as found (no commit made, no stash, no reset).
**Audit date:** 2026-09-29.

> This report is the deliverable. No bug in it has been fixed. Every finding cites a file,
> a line, and quoted evidence (code, test output, or command output).

---

## 1. EXECUTIVE SUMMARY

The codebase is unusually well-engineered for its size: authorization is server-side and
fail-closed, money is handled in `Decimal` throughout, the webhook is HMAC-verified with a
database-backed replay guard, inventory uses atomic conditional `UPDATE`s, settlement and
refund transitions are guarded by compare-and-swap + row locks, and separation of duties is
enforced on settlements. There are **no `any` casts, no `@ts-ignore`, no empty catch blocks
that swallow correctness errors, no string-interpolated raw SQL, and no missing top-level
auth guard on any API route**.

Against that baseline, this audit found **one confirmed high-severity functional bug** with a
reproducible failing integration test, plus several configuration/deployment hazards and
hardening gaps. The confirmed bug is a **concurrency race in payment-session creation** that
can open **two payable provider sessions for the same order** (reachable in production by two
concurrent "Pay" clicks), for which the design's own documented control (a unique
`paymentReference`) does **not** hold. The remaining items are environment-dependent
(deployment `.env`) or resource-hardening observations.

| Class | Count |
| --- | --- |
| P0 (critical) | 0 confirmed |
| P1 (high) | 1 confirmed |
| P2 (medium) | 3 |
| P3 (low) | 1 |
| POTENTIAL (unproven / environment-dependent) | 4 |
| INFO / false positives ruled out | 8 |

**Note on the deployed instance:** nothing on this host serves this repository. The only
listening Next.js process is PID 2015 `next-server` inside Docker container
`73f1ab50886b` (name `restaurant-app`), which serves a **different** application
(`<title>Restaurant Order Management</title>`) and has **no bind mount** of this repo. Port 80
is the Fedora default test page. An open SSH session to `103.93.132.214` exists but is not
inspectable from here. Therefore the findings below describe the **repository source**, and no
statement can be made about whatever build the end user may be browsing (see POT-01). This
does not affect the validity of the source-level findings.

---

## 2. PROJECT ARCHITECTURE DISCOVERED

Derived from source, not from documentation.

- **Framework:** Next.js `16.3.6` (App Router), React `19.2.8`, TypeScript `5.9.3`.
- **Runtime entry:** `npm run build` + `next start` via `ecosystem.config.cjs`
  (PM2, `script: node_modules/next/dist/bin/next`, `args: start -H 127.0.0.1`,
  `instances: 1`, `exec_mode: "fork"`, `PORT: 3003`).
  The single-fork setting is **load-bearing**: `lib/rate-limit.ts` is in-process, and
  `lib/realtime/bus.ts` is an in-process event bus, both asserted by tests.
- **Data layer:** Prisma `6.19.3` over MariaDB (`prisma/schema.prisma`, 1807 lines; latest
  migration `20260927000000_add_pic_payout_requests`).
- **Auth:** `next-auth` `5.0.0-beta.32` (`auth.ts`), edge auth-only proxy (`proxy.ts`),
  authorization core in `lib/authz/{guards,scope,permissions}.ts`.
- **Domain modules:** ticketing (`lib/ticketing/**`: checkout, inventory, reservations,
  payment, settlement, refunds, checkin, tickets/issuance), PIC (`lib/pic/**`: attribution,
  fee, ledger, payout, reconciliation, referral, reporting), realtime (`lib/realtime/**`),
  jobs (`lib/jobs/**`), images (`lib/images/**`), dashboard read model
  (`lib/dashboard/**`).
- **API surface:** ~78 `route.ts` files under `app/api/**`. **No server actions** (no
  `"use server"` anywhere in `app/` or `lib/`).
- **Realtime:** one Server-Sent Events endpoint `GET /api/realtime/stream` (notifications
  only, no data cross-wire), with a client-side leader election (`lib/realtime/leader.ts`).
- **Background work:** a single secret-authenticated trigger
  `POST /api/internal/jobs/tick` guarded by `JOBS_TICK_SECRET`, driving two jobs
  (`event-lifecycle`, `reservation-reaper`) via a DB lease (`lib/jobs/lock.ts`).
- **Money authority:** the webhook is the only automatic settlement trigger
  (`lib/ticketing/payment/webhook.ts`); a separate operator-triggered reconciliation path
  (`lib/ticketing/payment/reconciliation.ts`) enters the **same** settlement transaction.

---

## 3. BUILD / TEST STATUS

All commands run against the current tree. No failures were fixed.

| Command | Result |
| --- | --- |
| `npx jest --runInBand` | **154 suites: 153 passed, 1 failed. 3340 tests: 3339 passed, 1 failed.** Time 129.3 s. |
| `npx tsc --noEmit --incremental false` | Exit 0 (clean). |
| `npm run lint` | Exit 0. **0 errors, 4 warnings.** |
| `npm run build` | Exit 0 (production build completed). |
| `npm audit --omit=dev` | **3 high severity** (see §20). |
| `npm outdated` | 19 packages behind (see §20). |

**The single failing test is the audit's primary P1 finding (BUG-01).**

Lint warnings (all pre-existing, non-blocking):
```
app/e/[slug]/page.tsx:169,348  warning  @next/next/no-img-element
components/events/EventCard.tsx:54  warning  @next/next/no-img-element
scripts/verify-phase33-live.js:286  warning  'custCookies' is assigned a value but never used
```

Test suite coverage by area (24 dirs, 164 test files): auth-flow (14), events (12),
pic-self-service (11), ticketing-ui (10), realtime (10), ticketing-pic (9),
ticketing-payment (9), security (9), admin-manager (8), ticketing-checkin (7),
dashboard (7), authz (7), and others (6 or fewer each).

---

## 4. P0 FINDINGS

**None confirmed.** No finding in this audit met the P0 bar (data loss / full security
compromise) with concrete, reproducible evidence.

---

## 5. P1 FINDINGS

### BUG-01 — Concurrent "Pay" clicks can create two payable provider sessions for one order

**BUG-ID:** BUG-01
**Severity:** P1 (high) — financial / double-charge hazard
**Title:** The payment-creation concurrency guard does not hold; a second concurrent
caller computes a different `paymentReference` and opens a second gateway session.

**Location:**
- `lib/ticketing/payment/service.ts:485-486` — attempt number is derived from a
  non-atomic `count()`.
- `lib/ticketing/payment/service.ts:364-380` — `findLivePayment()` only treats a row as
  live when it already carries a URL / QR / number.
- `lib/ticketing/payment/service.ts:416` — the pre-claim resume check.
- `lib/ticketing/payment/service.ts:505-534` — the claim insert and its `P2002` handler.
- `prisma/schema.prisma:1266` + `prisma/schema.prisma:1318` — `paymentReference @unique`
  is the **only** uniqueness guarantee; there is no unique constraint on an active payment
  per order.

**Evidence (test output, verbatim):**
```
FAIL __tests__/ticketing-payment/payment-races.integration.test.ts
  ● H. concurrent payment creation › H1. eight simultaneous Pay clicks produce one provider payment, not eight

    expect(received).toHaveLength(expected)

    Expected length: 1
    Received length: 2
    Received array:  [{"body": {"amount": 150000, ... "referenceId": "EVT-1790669189966-48175592"},
                       "url": "https://sandbox.ipaymu.com/api/v2/payment/direct"},
                      {"body": {"amount": 150000, ... "referenceId": "EVT-1790669189966-48175592#2"},
                       "url": "https://sandbox.ipaymu.com/api/v2/payment/direct"}]

      228 |
      229 |         // THE ASSERTION THIS TEST EXISTS FOR: one session was actually bought.
    > 230 |         expect(gatewayStub.calls).toHaveLength(1);
          |                                   ^
      at Object.<anonymous> (__tests__/ticketing-payment/payment-races.integration.test.ts:230:35)
```
The two provider calls carry references `EVT-…-48175592` and `EVT-…-48175592#2` — i.e. two
**different** attempt numbers, not a collision on the same one.

**Relevant source:**
```ts
// service.ts:485-486
const attemptNumber = (await prisma.payment.count({ where: { orderId: order.id } })) + 1;
const paymentReference = buildPaymentReference(orderNumber, attemptNumber);
```
```ts
// service.ts:364-380 (findLivePayment)
where: {
  orderId,
  status: { in: [...ACTIVE_PAYMENT_STATUSES] },
  OR: [ { paymentUrl: { not: null } }, { qrString: { not: null } }, { paymentNumber: { not: null } } ],
}
```
The claim insert is documented as the concurrency guard:
> "`paymentReference` is `@unique`, so two simultaneous 'Pay' clicks compute the same attempt
> number, and the loser's insert is rejected by the database … A gateway session is therefore
> opened at most once per attempt." (`service.ts`, header around line 487)

**Actual behavior:** With 8 concurrent `createOrderPayment` calls, **2** provider sessions
were created. Caller B reached `prisma.payment.count()` *after* caller A's claim row had
committed. `count()` therefore returned `1`, B computed attempt number `2`, produced a
**different** unique `paymentReference` (`…#2`), and its insert did **not** raise `P2002`.
`findLivePayment()` had already returned `null` for B, because A's row was still in `UNPAID`
with no URL/QR/number yet (the provider call is deliberately outside the transaction).

**Expected behavior:** At most one provider session per order while an attempt is non-terminal;
every other concurrent caller must either resume that session or receive
`409 / PAYMENT_CREATION_IN_PROGRESS`.

**Impact:** A buyer can hold **two or more independently payable instruments** (two QRIS codes
/ two Virtual Accounts) for the same order. Because each session carries a distinct
`paymentReference`, the gateway can emit two separate success notifications. The first settles
the order (`settleVerifiedPayment`, order CAS → `PAID`); the second is absorbed as
`ALREADY_PAID` / `LATE_SETTLEMENT`. Money that already moved twice is **not** returned
automatically — it produces an operator alert/`fulfilmentBlockedAt` and a manual refund. The
seats were reserved only once, so the second payment buys nothing.

**Attack / failure scenario:**
1. Buyer opens the order page; the browser issues the pay request twice (double-click, flaky
   network retry, or a scripted `fetch` loop).
2. Both requests pass `requireAuth` + ownership + `assertOrderPayable` and hit the claim.
3. Caller B's `count()` lands after A's insert → B creates a second `Payment` row and calls
   iPaymu a second time.
4. The buyer now holds two live QRIS/VA instruments and may pay both.
No attacker privileges are needed; any authenticated buyer (or a hostile buyer acting in bad
faith) can trigger it. Route-level rate limiting (`5 per 5 minutes`) bounds how many sessions
per burst but does not preserve the "exactly one session" invariant — two concurrent clicks are
enough.

**Confidence:** HIGH. The failing test is concrete, reproducible evidence, and the reference
numbers in the output (`#1` and `#2`) point directly at the non-atomic attempt numbering.

**Recommended fix (explain only — NOT applied):**
Make the "one active attempt per order" a **database invariant**, not a derived value:
- Preferred: add a partial/durable uniqueness that prevents more than one non-terminal
  `Payment` per `(orderId)`. MySQL/MariaDB has no partial indexes, so the common approach is a
  nullable generated/stored column (e.g. `activeOrderKey = orderId` when `status IN
  ('UNPAID','PENDING')`, else `NULL`) with `@@unique`, or a dedicated "active attempt" pointer
  column on `EventOrder`.
- Or take a transaction-scoped row lock on the `EventOrder` (`SELECT … FOR UPDATE`) around the
  "resume-or-claim" decision so `count()`/claim is serialized per order.
- Also treat an existing **claim row with no instrument yet** (`UNPAID`, `paymentUrl`/`qrString`/
  `paymentNumber` all null) as "creation in progress" and return `409
  PAYMENT_CREATION_IN_PROGRESS` instead of creating a new attempt.
Whatever the shape, the guard must not depend on reading `count()` before a sibling commits.

---

## 6. P2 FINDINGS

### BUG-02 — No database guard against multiple active `Payment` rows per order

**BUG-ID:** BUG-02
**Severity:** P2 (medium) — data-integrity enabler of BUG-01
**Title:** `Payment` has a unique `paymentReference` but no constraint binding an order to a
single active attempt.

**Location:** `prisma/schema.prisma:1150-1320` (`model Payment`); specifically
`paymentReference String @unique` (`:1266`) and the indexes `@@index([orderId, status])`
(`:1318`), `@@index([organizerId, status])`, `@@index([status, expiresAt])`.

**Evidence:**
```
$ grep -n "@@unique\|@unique" prisma/schema.prisma   # Payment block
1266:  paymentReference    String             @unique
```
There is no `@@unique([orderId])` guard, and no `@@unique([orderId, status])` (which would not
work anyway given multiple terminal rows are legitimate). The `Payment` model comment claims
`paymentReference` "is unique so a retried create cannot mint two payable references for one
attempt" — true only when both attempts compute the *same* reference, which BUG-01 shows is not
guaranteed.

**Actual behavior:** Two `Payment` rows can coexist for one order in `UNPAID`/`PENDING`.
**Expected behavior:** At most one non-terminal attempt per order (design §13.2: "one logical
attempt per order (at most one in a non-terminal state at a time)").
**Impact:** The invariant "one active attempt per order" is not enforced where it matters — in
the database. Application-level checks are the only barrier, and BUG-01 proves they race.
**Attack / failure scenario:** Same as BUG-01; this is the schema-level reason BUG-01 is
possible.
**Confidence:** HIGH (schema read directly).
**Recommended fix (NOT applied):** Express "one active attempt per order" as a schema-level
constraint (nullable generated unique column, or an `EventOrder.activePaymentId`/attempt-counter
with a unique key), so the database — not the application — rejects the second concurrent claim.

### BUG-03 — Deployment origin configuration points at `localhost:3000` while production port is `3003`

**BUG-ID:** BUG-03
**Severity:** P2 (medium) — production configuration / payment-callback reachability
**Title:** The repository-local `.env` pins `AUTH_URL` and `NEXT_PUBLIC_APP_URL` to
`http://localhost:3000`, but the documented production process binds `127.0.0.1:3003`, and the
payment gateway's callback/return URLs are built from `NEXT_PUBLIC_APP_URL`.

**Location:**
- `.env` (gitignored — see §21): `AUTH_URL="http://localhost:3000"`,
  `NEXT_PUBLIC_APP_URL=http://localhost:3000`, `PAYMENT_ENVIRONMENT=sandbox`.
- `ecosystem.config.cjs` (`env: { PORT: "3003" }`, binds `-H 127.0.0.1`).
- `lib/ticketing/payment/reconciliation.ts` (module header) — documents the observed incident.
- `proxy.ts` (page-protection comment) — documents the observed redirect.

**Evidence (from the repository's own comments, i.e. previously measured):**
```
lib/ticketing/payment/reconciliation.ts:
  "Phase 27B proved the failure mode on a real sandbox payment — the notify URL handed to
   iPaymu was `http://localhost:3000/…`, iPaymu posts server-to-server, so the callback was
   refused before any HTTP exchange happened. Money moved; no webhook ever arrived; no ledger
   row, no settlement, no tickets."
```
```
proxy.ts:
  "Measured: with `.env` pinning AUTH_URL to the dev origin, a production build served on
   :3100 answered an anonymous `/dashboard` with
   `location: http://localhost:3000/login?callbackUrl=%2Fdashboard`."
```

**Actual behavior:** If the host environment does not override these variables, `next start`
loads `.env` from `cwd` (the ecosystem file's own header says so explicitly), the gateway
`notifyUrl` becomes `http://localhost:3000/api/ticketing/payment/webhook`, and unauthenticated
page redirects point at `localhost:3000` — which on this host is a **different application**.
**Expected behavior:** In production, `NEXT_PUBLIC_APP_URL` / `AUTH_URL` must be the public
HTTPS origin (and `PAYMENT_ENVIRONMENT` must not be `sandbox`).
**Impact:** Real payments can be taken with no callback (settlement never triggered) and users
are bounced to the wrong host. This exact failure has already occurred once (Phase 27B).
**Attack / failure scenario:** An operator runs `pm2 start ecosystem.config.cjs` on a host
where the `.env` file is present and no overriding environment variables are set → every
production payment's notify URL is unreachable → systematic unpaid-but-charged orders.
**Confidence:** MEDIUM. The values are confirmed in `.env`, and the failure mode is documented
by the codebase as previously observed; whether **the** deployed host sets correct overrides
cannot be verified from here (the project is not being served on this machine — see §1 note).
`.env` is gitignored (§21), so this is environment configuration, not committed source.
**Recommended fix (NOT applied):** Correct the deployment environment: set the public origin in
`AUTH_URL`/`NEXT_PUBLIC_APP_URL` and `PAYMENT_ENVIRONMENT=production` for the production
process, and fail the start when `NEXT_PUBLIC_APP_URL` is a `localhost` origin while
`NODE_ENV=production`. (The `getAppOrigin` allowlist already fails closed on bad hosts; a
startup assertion would catch the mismatch earlier.)

### BUG-04 — `TRUSTED_PROXY="nginx"` is invalid, so all clients share one rate-limit bucket

**BUG-ID:** BUG-04
**Severity:** P2 (medium) — rate-limit correctness behind a reverse proxy
**Title:** `.env` sets `TRUSTED_PROXY` to the string `nginx`, which the parser rejects; proxy
trust stays OFF and `x-forwarded-for` is ignored, collapsing all clients into a single shared
bucket key.

**Location:** `lib/rate-limit.ts:293-325` (`getClientIp`), `:534-536` (`warnInvalidTrustedProxy`),
`:614-665` (shared-bucket discussion); `.env`.

**Evidence (emitted during the test run, verbatim):**
```
console.warn
  [RATE_LIMIT] TRUSTED_PROXY is not a valid address/CIDR list (got "nginx"). Proxy trust stays
  OFF and forwarded headers are ignored. TRUSTED_PROXY is not a switch: name the reverse
  proxy's address, e.g. 10.0.0.1 or 172.16.0.0/12 (comma-separate several). Values such as
  true, false, yes, no and nginx are invalid and never enable trust.
      at warnInvalidTrustedProxy (lib/rate-limit.ts:533:13)
```
Source:
```ts
// lib/rate-limit.ts:293-325 (abridged)
if (trustedProxy) { ...use x-forwarded-for... } else if (raw?.trim()) { warnInvalidTrustedProxy(raw.trim()); }
return UNTRUSTED_CLIENT_KEY;   // all untrusted clients share this bucket
```

**Actual behavior:** Behind nginx, every request's socket peer is `127.0.0.1`; with trust OFF
the limiter keys on the shared sentinel, so per-IP buckets are effectively global.
**Expected behavior:** `TRUSTED_PROXY` names the proxy address/CIDR (e.g. `127.0.0.1` or
`172.16.0.0/12`) so the real client IP is used.
**Impact:** (a) IP-based throttling no longer distinguishes clients; (b) the shared bucket can
cause collateral lockout. Partially mitigated by design: `auth.ts` also maintains an
account-scoped bucket, and the shared-bucket behaviour is deliberate fail-closed. In addition,
the same misconfiguration removes IP granularity from audit logging (`lib/rate-limit.ts`
`getClientIp` is used by `lib/ticketing/audit-log.ts`).
**Attack / failure scenario:** An operator copies `.env.example`-style prose (`TRUSTED_PROXY=nginx`)
into production; the app fails closed for proxy trust, and login throttling + audit IP
attribution degrade. An attacker's failed logins can consume a shared bucket.
**Confidence:** MEDIUM-HIGH. The warning and the code path are directly observed; whether the
production host also carries this literal value cannot be confirmed from here.
**Recommended fix (NOT applied):** Set `TRUSTED_PROXY` to the reverse proxy's real address/CIDR
(the code's own documentation gives `127.0.0.1` / a private range), and link the runbook's
note here. (The code correctly refuses to treat `nginx`/`true`/`false` as a switch — this is a
configuration defect, not a code defect.)

---

## 7. P3 FINDINGS

### BUG-05 — Realtime SSE endpoint has no per-user connection cap

**BUG-ID:** BUG-05
**Severity:** P3 (low) — resource exhaustion / hardening
**Title:** `GET /api/realtime/stream` accepts unlimited concurrent long-lived connections per
user, each holding a listener + interval in the single process.

**Location:** `app/api/realtime/stream/route.ts:44-150`; `lib/realtime/bus.ts:170-200`
(`subscribeRealtimeBus`, `realtimeListenerCount`).

**Evidence:**
```ts
// app/api/realtime/stream/route.ts
const audiences = await resolveRealtimeAudience();
if (audiences.length === 0) { return new Response(...401...); }
// ... no count/limit check anywhere ...
unsubscribe = subscribeRealtimeBus((change) => { ... });
heartbeat = setInterval(() => { ... }, SSE_HEARTBEAT_MS);
```
There is no ceiling on `realtimeListenerCount()`, no per-user connection limit, and no
connection-timeout. The bus exposes `realtimeListenerCount()` for exactly this kind of probe
but nothing consumes it as a limit.

**Actual behavior:** Any authenticated user may open arbitrarily many SSE connections; each is
retained in the process-wide `Set` until the client cancels or the request aborts.
**Expected behavior:** A bounded number of concurrent streams per user/actor, with a documented
ceiling and a 429/close beyond it.
**Impact:** A single authenticated client can exhaust file descriptors / memory in the
single-fork process (PM2 `max_memory_restart: "512M"`), degrading the whole application. No
data leakage occurs (the channel delivers notifications only), so this is availability, not
confidentiality.
**Attack / failure scenario:** A logged-in user opens hundreds of `EventSource` connections in
a loop (or many browser tabs from a shared account) and causes a restart-loop of the 1-instance
deployment.
**Confidence:** HIGH for the absence of a limit (source read); MEDIUM for the practical impact
magnitude (depends on host limits).
**Recommended fix (NOT implemented):** Track and cap concurrent streams per `scope.userId`
(e.g. reject with 429 once a documented ceiling is reached), and/or bound total
`realtimeListenerCount()` with a fail-closed refusal.

---

## 8. POTENTIAL FINDINGS (unproven — labelled as such)

- **POT-01 — The served instance cannot be verified from this host.**
  Nothing on this box serves this repository (see §1). The only Next.js server is a different
  application in Docker container `73f1ab50886b`. Therefore a build the user is browsing
  elsewhere may be stale relative to this tree. *What is unproven:* whether the build under
  review is this revision. (Cf. the earlier navbar incident in which the user's screenshot was
  from a stale served build.)

- **POT-02 — `next-auth@5.0.0-beta.32` is a beta.**
  `npm outdated` shows `next-auth` current `5.0.0-beta.32` and "latest" `4.24.15` (the
  prerelease is intentional; the major-version "latest" is misleading). *What is unproven:*
  any concrete auth regression attributable to the beta. No failing auth test exists in the
  suite (auth-flow: 14 suites, all passing).

- **POT-03 — Requirement on `deepmerge-ts` is reachable only through a dev-time Prisma tool.**
  See §20. `@prisma/config` → `prisma` is a `devDependency`; the vulnerability is a stack
  exhaustion on recursive object graphs in a config loader. *What is unproven:* any
  production runtime exposure, since `npm audit --omit=dev` still reports it as a transitive
  path (build tooling is installed on the host). No exploit path was demonstrated.

- **POT-04 — Production build/runtime environment beyond `.env` is unverifiable.**
  Whether PM2 is running this project, whether nginx routes to `:3003`, and whether cron calls
  `/api/internal/jobs/tick` could not be checked (`pm2` not available; no project service
  running). *What is unproven:* that the deployment matches `ecosystem.config.cjs` and
  `DEPLOYMENT_RUNBOOK.md`.

---

## 9. SECURITY FINDINGS

Overall: strong. Concretely verified controls:

- **Webhook trust boundary** (`app/api/ticketing/payment/webhook/route.ts`,
  `lib/ticketing/payment/webhook.ts`): public by design, bounded body
  (`MAX_WEBHOOK_BODY_BYTES`), HMAC verified fail-closed **before** parsing, `timingSafeEqual`
  on the signature (`lib/payment/ipaymu.ts:1252-1263`), amount compared as `Decimal` against
  `EventOrder.total`, and a **database unique constraint** (`WebhookEvent.providerEventId`) as
  the replay arbiter — not a check-then-insert. Rejected/unverified rows do not block a later
  verified delivery (`blocksReprocessing`).
- **No injection surface found.** Raw SQL is parameterised tagged templates only
  (`lib/ticketing/inventory.ts:212,312,390,448`, `lib/ticketing/checkin/service.ts:433`,
  `lib/ticketing/refunds/{service,settlement}.ts`, `health/ready` `SELECT 1`).
- **No `any` / `@ts-ignore` / `eslint-disable`** in `lib/` (grep: 0 matches).
- **Path traversal defended** at uploads: `lib/images/process.ts` generates
  server-side random filenames and never uses client names; serve routes use
  `path.basename` guards (`app/api/uploads/events/[filename]/route.ts:73`,
  `app/api/organizer/.../evidence/[fileName]/route.ts`).
- **CSRF:** every state-changing route calls `requireSameOrigin` (grep across `app/api/**`).
- **Job runner:** `JOBS_TICK_SECRET` compared in constant time with a length-safe filler, fails
  closed when unconfigured (`app/api/internal/jobs/tick/route.ts:46-92`).
- **Secrets in crypto:** QR tokens from `randomBytes(32)` + SHA-256 hash
  (`lib/ticketing/tickets/reference.ts`), referral HMAC + `timingSafeEqual`
  (`lib/pic/referral.ts`), module-level HMAC secret for the limiter
  (`lib/rate-limit.ts:741`).

Deployment-related security items are BUG-03 and BUG-04 above.

---

## 10. AUTHENTICATION / AUTHORIZATION FINDINGS

- **Proxy** (`proxy.ts`) is auth-only by decision D-49, and every `/api/*` route is classified
  as public or protected; an **unclassified-route test** (`__tests__/authz/route-classification.test.ts`)
  fails if a new route is omitted. The two "NO_GUARD" routes were verified as intentional:
  `/api/ticketing/payment/webhook` and `/api/internal/jobs/tick` (machine-authenticated).
- **Guards** (`lib/authz/guards.ts`) throw on deny (`requireAuth`, `requirePlatformPermission`,
  `requirePlatformRole`, `requireOrganizerAccess`, `requireOrganizerMember`, `requireOwnResource`).
- **Scope resolution** (`lib/authz/scope.ts`) returns `null` for a missing or `disabledAt` user;
  unknown platform role defaults to `CUSTOMER`; TTL 60 s.
- **Ownership before capability** on payment creation (`requireOwnOrderForPayment` +
  `requireOwnResource(ORDER_READ_OWN)`), so a foreign order is `NOT_FOUND`, not `FORBIDDEN`.
- **Cross-tenant safety by construction** on reconciliation: the tenant comes from the
  `Payment` row, never the request (`lib/ticketing/payment/reconciliation.ts`).
- **Separation of duties** on settlements: the preparer cannot approve or pay
  (`lib/ticketing/settlement/service.ts:197,234,292` — three explicit
  `SEPARATION_OF_DUTIES` refusals).

**No IDOR / role-spoofing / missing-authorization finding was confirmed.** The one
apparently-unguarded export route (below) was a false positive (§21).

---

## 11. PAYMENT FINDINGS

- **BUG-01 / BUG-02** are the payment findings (concurrent-session race; no active-attempt DB
  constraint).
- Verified positive controls: settlement is a single transaction with an order-row CAS
  (`lib/ticketing/payment/settlement.ts`, `cas.count === 0` → idempotent no-op); the payment-row
  CAS includes `UNPAID|PENDING`; late settlements after cancel/expiry are recorded
  (`paymentStatus=PAID`) **without** issuing tickets and set `fulfilmentBlockedAt`;
  `providerTransactionId` is only ever written from a provider response;
  reconciliation refuses terminal orders (`D-P19-04`) and never accepts client-supplied amount
  or transaction id.
- **No client-side payment trust found**: the request body schema carries no financial field;
  amount/currency come from the persisted order.

---

## 12. TICKETING / INVENTORY FINDINGS

- **No oversell or counter-underflow finding confirmed.** `lib/ticketing/inventory.ts` uses
  atomic conditional `UPDATE`s: reserve `reserved + sold + n <= quota`; confirm
  `reserved >= n`; release/restore use `GREATEST(0, …)`. Confirm underflow **throws** and rolls
  back (never silently mints a seat).
- Reservations move through conditional `updateMany` on the current status
  (`lib/ticketing/reservations.ts`), so a double release/confirm is a no-op.
- The reaper (`expireDueReservations`) was re-written (Phase 7 fix) to claim the order
  (`HELD`-independent CAS to `EXPIRED`) **before** releasing holds, matching the
  order-row → reservations → ticket-types lock order used by cancel/settlement, closing the
  "paid but ticketless" class.
- Checkout writes the idempotency key row in the **same transaction** as the order, so a lost
  race aborts everything (`lib/ticketing/checkout.ts:483-500`).

---

## 13. REFUND FINDINGS

- Eligibility is a single pure predicate (`lib/ticketing/refunds/eligibility.ts`) with explicit
  rules: only `PAID`/`PARTIALLY_REFUNDED`; `CHECKED_IN` never refundable; `ISSUED` only;
  `RefundItem.ticketId @unique` as the one-refund-per-ticket backstop; amount =
  Σ purchase-time unit prices, never from the client.
- Settlement (`lib/ticketing/refunds/settlement.ts`) re-checks state inside the transaction,
  CAS-es each ticket `ISSUED → REFUNDED` with `refundedAt: null AND checkedInAt: null`
  (**rolls back if a ticket was checked in between approval and settlement**), and guards the
  order balance with a **conditional** `refundedAmount <= total - amount` update (not
  read-then-write). PIC fee reversal is computed from EARNED rows with a unique
  `(orderItemId, type, reversalRef)` guard and a rounding remainder absorbed on the final
  increment. Quota is restored only after confirmation and only when
  `Event.returnQuotaOnRefund`.
- **No double-refund / refund-after-check-in / refund-after-cancel finding confirmed.**

---

## 14. PIC / SETTLEMENT FINDINGS

- `PICAttribution.orderId @unique` makes duplicate attribution structurally impossible.
- `PICFeeLedger` EARNED posting is idempotent via `idempotencyKey = fee:earned:{orderItemId}`
  and `@@unique([orderItemId, type, reversalRef])`; EARNED rows are posted inside the settlement
  transaction, so a rolled-back settlement posts none.
- `lib/pic/ledger.ts` centralises the balance as `Σ CREDIT − Σ DEBIT` (and entitlement as
  `Σ EARNED − Σ REVERSAL`), explicitly avoiding magnitude double-counting and window truncation.
- Settlement SoD (preparer ≠ approver ≠ payer) is enforced (see §10).
- PIC self-service resolves the ACTIVE profile from the session (`findActivePicProfile`);
  `lib/realtime/audience.ts` refuses a suspended PIC its PIC audience.
- **No cross-PIC data exposure, duplicate payout, or negative-fee finding confirmed.**

---

## 15. REALTIME FINDINGS

- Audience is derived server-side from the session/database, the endpoint takes **no
  parameters**, and delivery is a set intersection (`lib/realtime/audience.ts`,
  `app/api/realtime/stream/route.ts`). Anonymous callers get `[]` → mute, and the handler also
  returns 401 itself.
- Publish-after-commit only; the envelope carries no data (no money, no identity).
- Cleanup covers consumer `cancel()`, request `abort`, and the failed-write path; the heartbeat
  timer is `unref`'d so it cannot keep the process alive.
- The in-process bus is deliberate and enforced by a deployment test that fails if
  `ecosystem.config.cjs` moves off one forked instance.
- **Finding:** BUG-05 (no per-user connection cap).

---

## 16. UI FINDINGS

- The prior phases' navbar work is present and correct in source: brand region
  `flex shrink-0 items-center`, search `hidden min-w-0 flex-1 justify-end md:flex lg:max-w-xl`,
  and `components/ticketing/header-nav.ts` intentionally carries no display utility (the
  Tailwind `.hidden`-before-`.inline-flex` ordering trap was identified and designed around).
- Role-based dashboard destination is centralised (`lib/auth/roles.ts` + `lib/dashboard/scope.ts`);
  `app/dashboard/layout.tsx` gates on real permissions with a fail-closed denial panel.
- **No new UI bug was confirmed.** The previously reported "still crushed brand" was a stale
  served build, not source (POT-01).
- Lint's two `no-img-element` warnings are performance advisories, not correctness bugs
  (deliberate: public event imagery served through the upload route).

---

## 17. DATABASE FINDINGS

- Money columns are `Decimal(14,2)`; `sold`/`reserved`/`quota` are `Int`; no float money found.
- Meaningful uniques present: `EventOrder.orderNumber`, `Ticket.ticketCode`,
  `Ticket.qrTokenHash`, `Ticket.(orderItemId, sequenceNo)`, `CheckIn.ticketId`,
  `RefundItem.ticketId`, `PICAttribution.orderId`, `PICFeeLedger.idempotencyKey`,
  `Settlement.(payeeType, picProfileId, periodStart, periodEnd)` and the organizer twin,
  `IdempotencyKey.(userId, scope, key)`, `WebhookEvent.providerEventId` (via unique), and
  `Payment.paymentReference`.
- Indexes cover the hot predicates (order lookups by status, ticket by event/status, ledger by
  PIC/status, etc.).
- **Finding:** BUG-02 — no constraint binding an order to one *active* payment attempt.
- Cascade/delete behaviour uses `Restrict` for money-bearing relations and `SetNull` for actor
  references — conservative and appropriate. No unsafe cascade was confirmed.
- **No migration was created or run for this audit.**

---

## 18. DEPLOYMENT FINDINGS

- `ecosystem.config.cjs` is a sound single-instance fork definition (PM2 supervises Next's own
  binary; pinned `PORT=3003`; bound to loopback; `max_memory_restart: "512M"`).
- **BUG-03** (origin/`.env` mismatch) and **BUG-04** (`TRUSTED_PROXY="nginx"`) are the
  deployment findings.
- **Additional observation:** the `.env` also sets `PAYMENT_ENVIRONMENT=sandbox`; with the
  gateway URLs pinned to `localhost:3000`, a host that fails to override these will run
  production traffic against sandbox endpoints. This is part of BUG-03.
- A job scheduler (cron) is required for `event-lifecycle` and `reservation-reaper`; whether it
  is installed cannot be verified from here (POT-04). The tick endpoint itself is correctly
  secret-gated and fail-closed.
- No service was restarted, and no command with external side effects was run.

---

## 19. TEST COVERAGE GAPS

The suite is broad (164 files) and includes genuine concurrency races (checkout, issuance,
payment, refunds, PIC settlement). Gaps observed:

- **The one gap that matters most is already covered:** the H1 payment-creation race has a test
  and it **fails** (BUG-01). This is a strength, not a gap.
- **PIC payout-request concurrency** has an integration test
  (`pic-self-service/payout-request.integration.test.ts`, passing); no confirmed gap.
- **Not observed (potential gaps to confirm separately):** an end-to-end test that drives the
  `/api/ticketing/orders/[orderNumber]/pay` **route** (with its rate limiter + CSRF) rather
  than the service directly; a test that asserts a per-user ceiling on
  `/api/realtime/stream`; and a deployment/env assertion that fails when
  `NEXT_PUBLIC_APP_URL` is a localhost origin under `NODE_ENV=production`.
- The `organizer/pic-fee-report/export` route's authorization is exercised indirectly; there is
  no route-level test asserting an unauthorized caller receives 404/403 (see §21 — the guard
  exists in the service).

---

## 20. DEPENDENCY FINDINGS

`npm audit --omit=dev` (verbatim):
```
deepmerge-ts  <8.0.0
Severity: high
DeepmergeTS has stack exhaustion when merging recursive object graphs - GHSA-ggr8-5vv4-36mx
fix available via `npm audit fix --force`
Will install prisma@6.12.0, which is a breaking change
  @prisma/config  6.13.0-dev.1 - 8.1.0-dev.4  Depends on vulnerable versions of deepmerge-ts
    prisma  6.13.0-dev.1 - 8.1.0-dev.4  Depends on vulnerable versions of @prisma/config

3 high severity vulnerabilities
```
- The path is `prisma` → `@prisma/config` → `deepmerge-ts`; `prisma` is a **devDependency**
  (build/CLI tooling), so runtime exposure is limited/indirect (POT-03).
- **The only offered fix (`npm audit fix --force`) is breaking** (pins `prisma@6.12.0`). It was
  **NOT run**, per the audit's instructions.

`npm outdated` highlights (current → latest):
```
@prisma/client   6.19.3 → 7.10.0      prisma         6.19.3 → 8.0.0-rc.17
react/react-dom  19.2.8 → 19.3.0      typescript      5.9.3 → 7.0.2
next-auth 5.0.0-beta.32 (latest tag 4.24.15)           eslint 9.39.5 → 10.11.0
zod 4.4.3 → 4.6.5   axios 1.19.0 → 1.20.0   jest 30.4.2 → 30.5.2   ...
```
**No dependency was upgraded or modified.**

---

## 21. FALSE POSITIVES RULED OUT

Investigated and found **not** to be bugs:

1. **`/api/organizer/pic-fee-report/export` looks unguarded** (its handler contains no
   `requireAuth`/`requireOrganizerAccess` call). **Ruled out:** the service it calls,
   `exportOrganizerPicFeeCsv` (`lib/pic/tenant-reporting.ts`), performs
   `requireOrganizerAccess(organizerId, PERMISSIONS.REPORT_EXPORT_PIC_FEE)` and re-checks
   membership; `organizerId` is a routing key, not authority. `proxy.ts` also classifies
   `/api/organizer/` as protected.
2. **`/api/ticketing/payment/webhook` and `/api/internal/jobs/tick` appear public.**
   **Ruled out:** both are public by contract; the webhook's HMAC + replay ledger and the tick's
   constant-time shared secret are the real controls, both fail-closed.
3. **`Math.random()` used in non-crypto contexts** (`lib/events/slug.ts:88`,
   `lib/events/service.ts:310`, `lib/ticketing/checkout.ts:97`, `lib/ticketing/db-contention.ts:97`,
   `lib/realtime/leader.ts:123`). **Ruled out:** each is documented and safe — slug/order/event
   uniqueness is enforced by DB unique constraints with bounded retry, and the contention value
   is backoff jitter, not a secret.
4. **Empty `catch {}` blocks** (`app/ticketing/orders/[orderNumber]/page.tsx:247`,
   `app/e/[slug]/page.tsx:85`, `app/api/realtime/stream/route.ts:99,114`,
   `app/api/uploads/events/[filename]/route.ts:73`). **Ruled out:** none swallows a correctness
   error — they are fallback render, already-closed stream, and best-effort cleanup paths.
5. **In-process realtime bus / in-memory rate limiter.** **Ruled out:** deliberate and
   test-enforced against `instances: 1` (`ecosystem.config.cjs`; realtime deployment test).
6. **`Payment.provider` stored as a plain string** rather than an enum. **Ruled out:** documented
   forward-compatibility choice; no comparison depends on an enum.
7. **Raw SQL in inventory.** **Ruled out:** required to express a column-vs-column guard
   (`reserved + sold + n <= quota`), and every statement is a parameterised tagged template.
8. **`TRUSTED_PROXY` accepted but ignored.** **Ruled out as a code bug:** the code deliberately
   fails closed and warns; the defect is the configuration value (BUG-04), not the parser.

---

## 22. RECOMMENDED REMEDIATION ORDER

1. **BUG-01 (P1)** — enforce "one active payment attempt per order" atomically. This is the only
   confirmed bug and the only one with direct money-loss potential. Fix the guard (DB
   constraint and/or order-row lock + treat a bare claim row as "in progress"); re-run
   `__tests__/ticketing-payment/payment-races.integration.test.ts` until H1 passes.
2. **BUG-02 (P2)** — add the schema-level constraint that makes #1 structural; migrate
   deliberately (not in this audit).
3. **BUG-03 (P2)** — correct the deployment origins and `PAYMENT_ENVIRONMENT`, and add a
   startup assertion that refuses a localhost origin under `NODE_ENV=production`.
4. **BUG-04 (P2)** — set `TRUSTED_PROXY` to the proxy's address/CIDR.
5. **BUG-05 (P3)** — cap concurrent realtime streams per user.
6. **POT-01…POT-04** — verify the actually-deployed build and host configuration;
   decide deliberately on the Prisma/dev-tooling advisory (do **not** run
   `npm audit fix --force` blindly).
7. **Coverage** — add route-level tests for the pay endpoint and for the
   realtime-stream ceiling (§19).

---

## CLOSING ATTESTATION

- files modified = **NONE**
- database modified = **NONE**
- migrations = **NONE**
- commits = **NONE**
- pushes = **NONE**
- reset/rebase/stash = **NONE**

The audit was completed against the repository **as it currently is**. No source file was
edited, no migration was generated or applied, no database row was created, updated, or
deleted, and no git state-changing command was run. `npm audit fix --force` was deliberately
not executed.
