# PHASE 25 — OPERATIONAL SECURITY & PRODUCTION READINESS AUDIT

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Mode:** Audit first. Two bounded defects were fixed; everything else is classified, not changed.

---

## 1. EXECUTIVE SUMMARY

The application is **structurally sound and ready to move toward a VPS**, but it is **not ready
to deploy today**. No security defect was found in authentication, authorization, tenant
isolation, CSRF, upload handling, payment settlement, refund settlement or ticket issuance —
every one of those control chains was traced to source and holds. What blocks a deployment is
**configuration, process and infrastructure**, not code:

* the entire Phase 21–25 body of work is **uncommitted** (45 modified + 38 untracked paths, one
  of them an already-applied migration);
* `TRUSTED_PROXY` is unset, which makes the login limiter a **platform-wide lockout** surface;
* the scheduler does not exist yet, and without it events never complete and sales never close;
* `UPLOAD_DIR` holds irreversible data (event imagery) with **no backup procedure**;
* there is **no health endpoint** for the reverse proxy or process manager to probe.

Two genuine defects were found, both in the *deployment contract* rather than the runtime, and
both were fixed because the fix is bounded and carries no runtime risk:

1. **`.env.example` described the deleted retail application.** It advertised 12 variables no
   code reads (Cloudinary, a payout provider, RajaOngkir, WhatsApp, spin-wheel), pointed
   `DATABASE_URL` at `demo_marketplace`, led the iPaymu block with an active-looking
   `IPAYMU_URL="https://sandbox.iapmu.id"` (a **misspelled** domain that is also not read by the
   payment path), set `UPLOAD_DIR="./uploads"` when the code's default is `./storage/uploads`,
   and **omitted `AUTH_URL`**, which the login redirect origin is built from. An operator
   following it would configure the wrong database, the wrong variables and the wrong upload
   directory. Rewritten from the sources, and pinned by a new test suite.
2. **`storage/` was not git-ignored.** The runtime upload directory (organizer-uploaded event
   imagery, unbounded binary content) would be swept into any `git add -A`. Added to
   `.gitignore`, alongside `*.tsbuildinfo` and `next-env.d.ts`, whose tracking is what keeps
   every working tree permanently dirty.

**VERDICT: READY WITH BLOCKERS** (2 bounded defects fixed; the blockers are deployment
configuration, process and infrastructure, each with a concrete action below).

---

## 2. REPOSITORY BASELINE

| Fact | Value | Command |
|---|---|---|
| HEAD | `8628dbf 2026-09-19 "integrasi dengan UI"` | `git log -1 --format="%h %ad %s" --date=short` |
| Working tree | **45 modified + 38 untracked paths** | `git status --porcelain` |
| Prisma schema | valid | `npx prisma validate` → "The schema at prisma/schema.prisma is valid 🚀" |
| Migrations | 23 on disk, **22 tracked**, 1 untracked; DB "up to date" | `npx prisma migrate status` |
| TypeScript | clean (exit 0, no output) | `npx tsc --noEmit` |
| ESLint | 0 errors, 3 warnings (all pre-existing `@next/next/no-img-element`) | `npx eslint .` |
| Build | success | `npm run build` → "✓ Compiled successfully in 2.7s" |
| Tests | **1703 passed / 1703, 78 suites** | `npm test -- --runInBand` |
| Security suite | **101 passed / 101, 6 suites** | `npx jest __tests__/security --runInBand` |
| Next.js | 16.3.0 | `node -p "require('./node_modules/next/package.json').version"` |
| Node (local) | v24.21.0 | `node -v` |

**The tree is 100% ahead of HEAD.** Everything from Phase 21 (dashboard sync) through Phase 25 is
uncommitted, including `prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/` — a
migration that is **already applied locally** but exists in no commit. Deploying from the
repository would ship a version of the product that no longer exists; deploying from the working
tree would ship an unauditable one. This is finding **BLOCK-1**.

---

## 3. AUTHENTICATION AUDIT

**FILE** `auth.ts` · **SYMBOL** `NextAuth({ session: { strategy: "jwt" }, providers: [...] })`

| # | Question | Evidence | Result |
|---|---|---|---|
| A1 | Can request data influence identity? | `Credentials({ credentials: { identifier, password } })` — only those two names are declared; `authorize()` builds the user from `prisma.user.findFirst({ where: { OR: [{email}, {phone}] } })` and returns `{ id, ... }` from the **row**. `LoginForm` calls `signIn("credentials", { identifier, password, redirect: false })` and never sends the selected chip. | **PASS** |
| A2 | Can request data influence role? | The `authorize()` return object's `role` is `user.role` (the DB column). No request field is read for it. `signIn()` is called with exactly `identifier` + `password`. | **PASS** |
| A3 | Timing / user enumeration | `TIMING_EQUALISATION_HASH` is a **real cost-12 bcrypt hash** (`$2b$12$...`), so the not-found path performs the same work as a wrong password. | **PASS** |
| A4 | OAuth account takeover | `allowDangerousEmailAccountLinking: false`, with the takeover scenario documented inline. | **PASS** |
| A5 | Stale JWT after user deletion | `jwt()` refreshes `platformRole` from `resolveAuthzScope(token.id)` when stale (≤60 s, D-48); the guards re-resolve per request and fail closed on `null`. `lib/auth/session-gate.ts` returns `render-form` for a `null` scope — **this is what prevents the `/login ↔ /dashboard` redirect loop** for a signature-valid token whose user is gone. | **PASS** |
| A6 | CallbackUrl open redirect | `resolveSafeCallbackUrl` validates; `proxy.ts` builds the callback from `pathname` (the resolved request path), **never** from the incoming query. Live-verified in Phase 24 (external and looping values rejected, order path preserved). | **PASS** |
| A7 | Secrets to client | No `process.env` read is reachable from a client component; `AUTH_SECRET`/provider keys are read only inside `lib/payment/config.ts` and Auth.js internals. | **PASS** |
| A8 | Login rate limiting | `rateLimiters.login(ip)` = 5 / 15 min in `authorize()`. **But** `getClientIp()` returns the sentinel `"untrusted"` while `TRUSTED_PROXY` is unset (`lib/rate-limit.ts`), so every client shares one bucket and one attacker can lock out the platform. | **BLOCK-2** (documented in `auth.ts` and `.env.example`) |

**Dead code (no action):** `lib/csrf.ts` exports `requireSession` and `requireAdminSession` with
**zero consumers** — `grep -rn "requireSession\|requireAdminSession" app/ lib/ components/ proxy.ts auth.ts __tests__/` returns only the definitions and their own doc comments. Their 401 bodies also omit the machine-readable `code` the rest of the API contract now carries. `requireAdminSession`'s docblock claims it "guards the existing retail admin surface", which was deleted. **Classification: LEGACY / INFO.** Left untouched: the module documents their retention as a deliberate Phase 3 decision, they are unreachable, and removing them would be churn without a security effect.

**Account switching** requires an explicit sign-out (Auth.js session cookie; no switch-account endpoint). **INTENTIONAL.**

---

## 4. AUTHORIZATION / TENANT ISOLATION

**FILE** `lib/authz/permissions.ts`, `guards.ts`, `scope.ts` · **SYMBOL** `PERMISSIONS`, `requireAuth`, `requireEventAccess`, `decideOrganizerPermission`

* **Role reads outside `lib/authz`:** `grep -rn "\.platformRole ===\|\.role ===\|session\.user\.role" app/ lib/ components/ auth.ts proxy.ts | grep -v "^lib/authz/"` returns exactly four hits — one stale comment, one in the **dead** `requireAdminSession`, and `auth.ts:328`, which mirrors the role into the session for routing/UI and is documented as **not** authority. **No authorization decision anywhere reads a role outside the centralized map. PASS.**
* **Phase 23A fix intact:** `lib/authz/permissions.ts` mtime `2026-09-20 04:41`; `PLATFORM_ROLE_OWN_PERMISSIONS` still grants ADMIN/MANAGER the buyer own-scope set. Live re-proved in Phase 24: owner `200`, other buyer `404`.
* **Order/tenant scope:** `findOwnOrderRow` → `requireOwnResource("order.read.own", …)`; organizer surfaces resolve membership + `staffEventAssignment` per request (`lib/authz/scope.ts`, `lib/organizer/context.ts`).
* **IDOR:** `checkout.ts` and the order service take the `orderNumber`/`eventId` **from the path but resolve authority from the session**; there is no `organizerId`/`userId` read from a body or query that reaches a `where` clause.

**Classification: PASS.** Identity → tenant → resource → action is enforced server-side at every
sensitive resource (order, payment, ticket, refund, event, venue, report, settings).

---

## 5. API ERROR CONTRACT

**FILE** `lib/api/errors.ts`, `lib/api/response.ts`, `proxy.ts`, `lib/errors/classify.ts`

* Every route in `app/api/**` returns through `handleApi` + `AppError`, i.e. an envelope with a
  stable `code`. Verified by the `-wiring` suites which enumerate routes and assert the envelope.
* `proxy.ts`'s unauthenticated API response carries `code: "UNAUTHORIZED"` (not just a message),
  which is what lets `lib/auth/client-session.ts` tell a **session that ended** (401 → sign in and
  return) from an action that was **refused** (403/409 → business error).
* **Manual `Response.json` bypasses** (26 route files matched the inventory scan) resolve to two
  categories: the machine-auth/`webhook` routes (which build their own refusal envelopes and are
  covered by their own wiring tests) and the image-serving route, which returns 404 because a
  missing file is genuinely not found.
* Infrastructure vs business distinction: `lib/errors/infrastructure.ts` + `classify.ts` map
  Prisma/connection/timeout failures to retryable system states; `notFound()` is no longer the
  catch-all (Phase 24 removed `catch(() => null)` → `notFound()` from the buyer and public pages).

**Classification: PASS.** No route returns a raw exception, a Prisma error, or a SQL string.

---

## 6. CSRF / REQUEST SECURITY

**FILE** `lib/csrf.ts` · **SYMBOL** `requireSameOrigin`, `isSameOrigin`

The module's own docblock is accurate: `requireSession` is a **session** check, and the real CSRF
control is an Origin/Referer check (decision D-56) that fails **closed** when neither header is
present, and passes GET/HEAD/OPTIONS.

**Exhaustive coverage check** — every `route.ts` exporting a mutating handler was scanned:

```
for f in $(grep -rl "export async function \(POST\|PUT\|PATCH\|DELETE\)" app/api --include=route.ts); do
  grep -q "requireSameOrigin" "$f" || echo "MISSING: $f"
done
→ MISSING: app/api/ticketing/payment/webhook/route.ts
→ MISSING: app/api/internal/jobs/tick/route.ts
```

Both exclusions are **correct by design and asserted by their suites**
(`payment-wiring.test.ts:307` asserts the webhook does **not** call it):

* the **webhook** is a server-to-server callback from a provider that sends no `Origin`. Its trust
  boundary is the HMAC signature over the **exact raw body**, verified timing-safe and
  fail-closed (`lib/ticketing/payment/webhook.ts:384`, 401 on failure, refusal recorded in
  `webhookevent`), with a body-size bound (`MAX_WEBHOOK_BODY_BYTES`).
* the **job tick** is machine-authenticated by `Authorization: Bearer $JOBS_TICK_SECRET`,
  compared in constant time, failing closed when unset (`route.ts` `isAuthorized`).

**Classification: PASS.**

---

## 7. RATE LIMITING / ABUSE CONTROLS

**FILE** `lib/rate-limit.ts` · **SYMBOL** `checkRateLimit`, `rateLimiters.{login,register,paymentCreation,upload}`

| Bucket | Limit | Consumer | Active? |
|---|---|---|---|
| `login` | 5 / 15 min (IP) | `auth.ts` `authorize()` | yes |
| `register` | 3 / hour (IP) | `app/api/auth/register/route.ts` | yes |
| `paymentCreation` | 5 / 5 min (user) | `app/api/ticketing/orders/[orderNumber]/pay/route.ts` | yes |
| `upload` | 20 / min (user) | `app/api/organizer/events/[id]/images/route.ts`, **before the multipart body is parsed** | yes |

Two documented limitations, neither a code defect:

* **per-instance, in-memory** — correct for a single VPS; `REDIS_URL` only logs a warning
  (`lib/rate-limit.ts` module scope). `REDIS_URL` is otherwise unused. **INTENTIONAL.**
* **`TRUSTED_PROXY` unset ⇒ global bucket.** `getClientIp()` deliberately ignores forwarding
  headers unless a proxy is trusted (the M2 fix — spoofing `x-forwarded-for` must not buy a fresh
  bucket), and returns `"untrusted"`. Correct security posture, but the **deployment must set
  `TRUSTED_PROXY`** or the login limiter is a platform-wide DoS. **BLOCK-2.**

No webhook-specific limiter exists. That is safe here because the webhook rejects before any
mutation (signature, then size) and records every delivery. **INFORMATIONAL.**

---

## 8. UPLOAD SECURITY

**FILE** `app/api/organizer/events/[id]/images/route.ts`, `app/api/uploads/events/[filename]/route.ts`, `lib/images/format.ts`, `lib/images/process.ts`, `lib/events/images.ts`

The security property is the **order**: `upload → validate → process → strip EXIF → store
processed output → serve`. The handler never touches the filesystem, so no code path can persist
an unprocessed file.

| Control | Evidence | Result |
|---|---|---|
| Content-type from **magic bytes**, not the client header | `detectImageFormat()` — JPEG SOI+marker, full 8-byte PNG signature, `RIFF` **and** `WEBP` FourCC (explicitly rejecting WAV/AVI, which share RIFF) | **PASS** |
| SVG / executable risk | `IMAGE_FORMATS = ["jpeg","png","webp"]` — SVG is not representable, so no script-bearing XML can be stored | **PASS** |
| Size limit | `MAX_EVENT_IMAGE_BYTES = 5 MB`, checked against the declared size **and re-checked against the actual bytes** ("a chunked request cannot slip past the limit above") | **PASS** |
| Decompression bomb | the metadata stripper walks the container and throws on anything malformed, so a valid-header/corrupt-body file is rejected rather than stored | **PASS** |
| Path traversal | serving route reduces to `path.basename` and 404s if the segment was not already a bare basename | **PASS** |
| Filename | generated server-side; the client filename is ignored for every decision | **PASS** |
| Authorization | `requireAuth` + `event.banner.upload` in the event's own tenant | **PASS** |
| Cache headers | `public, max-age=31536000, immutable` + `nosniff` + `Content-Disposition: inline` | **PASS** |
| **Durability** | `UPLOAD_DIR` defaults to `./storage/uploads`; DB rows point at files that exist only there. **No backup procedure is documented anywhere**, and the directory is on the app host. | **BLOCK-4** |

---

## 9. PAYMENT SECURITY (READ ONLY — no provider call made)

**FILE** `lib/ticketing/payment/service.ts`, `gateway.ts`, `settlement.ts`, `webhook.ts`, `method-catalog.ts`, `validation.ts`, `lib/payment/config.ts`

**REDIRECT SUCCESS ≠ PAID — proven from source, not assumed:**

1. `returnUrl = ${origin}/ticketing/orders/${encodeURIComponent(orderNumber)}` and
   `notifyUrl = ${origin}/api/ticketing/payment/webhook` (`service.ts:540-541`). The return URL
   uses the **order's own `orderNumber`** — never a payment reference, session id, event id or
   ticket-type id. No browser route mutates payment state: the entire public surface of
   `service.ts` is `createOrderPayment`.
2. Every write of `PAID` lives in **`lib/ticketing/payment/settlement.ts`** (`status:"PAID"`,
   `paymentStatus:"PAID"`), reachable only from the webhook path, and is guarded by
   `paymentStatus: { not: "PAID" }` CAS predicates for idempotency.
3. The webhook (a) bounds the body, (b) verifies the HMAC over the raw bytes **timing-safely and
   fail-closed**, (c) records the delivery — including refusals with `signatureValid: false` —
   in `webhookevent`, (d) resolves the reference and verifies the **amount**, then (e) settles.
   `webhook.ts:87` documents that a server-side status poll is explicitly **not** a settlement,
   and `verifyPaymentStatus` has no production consumer.

**Ordering / claims:** `service.ts:289` short-circuits an already-PAID order (`ALREADY_PAID`);
`ACTIVE_PAYMENT_STATUSES` prevents a second in-flight payment; the amount is whole-rupiah and
`Decimal`-typed. Production config is **fail-closed and frozen**: `resolvePayEnvironment` has no
default, credentials are read only for the selected environment, the base URL is allow-listed per
environment (SSRF / mis-routed-money guard), and sandbox VA reuse in production is refused
(`lib/payment/config.ts`).

**Classification: PASS. Payment semantics unchanged in this phase** — mtimes prove it: all four
payment files were last written at **00:12–00:14** today (Phase 22), while this phase's files are
at **11:16/11:24**. Their working-tree diffs are Phase 22 content (deletion of the legacy
`IPAYMU_CONFIG` double-source, the `SessionID` spelling, the method-catalog policy).

---

## 10. REFUND SECURITY (READ ONLY)

**FILE** `lib/ticketing/refunds/service.ts`, `settlement.ts`, `eligibility.ts`, `validation.ts`

| Requirement | Evidence | Result |
|---|---|---|
| Requester cannot approve / reject / execute / settle / fail their own request | five separate guards, each with its own message: `service.ts:363, 432, 542, 667, 753`, e.g. `"Pemohon refund tidak dapat menyetujui permintaannya sendiri."` | **PASS** |
| At most one PROCESSING refund per order | row-locked claim with the rationale documented at `service.ts:505` ("cannot be a partial unique index") | **PASS** |
| Settlement requires evidence | reference is **required** (`service.ts:633`: "an operator cannot complete a transfer they did not…") and a manual rail cannot supply a different figure (`validation.ts:122`) | **PASS** |
| No webhook can settle a manual refund | no refund path is reachable from `webhook.ts` | **PASS** |
| CHECKED_IN cannot be refunded | `eligibility.ts:201` + the admission CAS refusing a claimed ticket | **PASS** |
| Refund cannot exceed refundable amount | `eligibility.ts:117` `total - refundedAmount` floored at zero | **PASS** |
| Internal identifiers never leave the API | `payload.ts:19-20` — no `organizerId`, no `requestedByUserId`, no `approvedByUserId`, no `processedByUserId` | **PASS** |

---

## 11. TICKET ISSUANCE / CHECK-IN

**FILE** `lib/ticketing/tickets/issuance.ts`, `lib/ticketing/checkin/service.ts`

* **QR payload is exactly `TICKET:<ticketCode>`** — `TICKET_QR_PREFIX = "TICKET:"`, asserted by
  `__tests__/ticketing-issuance/qr-payload-contract.test.ts` against the production regex
  `/^TICKET:EVT-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/`, including that it carries no
  personal data. **PASS**
* **Issuance authority:** `issuance.ts:187` refuses anything whose `order.paymentStatus !== "PAID"`
  — buyer-triggered issuance can only *materialise* tickets that settlement already authorised.
  **PASS**
* **Check-in:** one transaction that (1) takes the ticket row lock, (2) reads the open-refund
  claim **inside** the transaction after the lock, (3) CAS `ISSUED → CHECKED_IN` via `updateMany`
  on `status: "ISSUED"`, and (4) writes the evidence. A duplicate admission gets
  `TICKET_ALREADY_CHECKED_IN` with the original timestamp and staff. **PASS**
* **Staff scope:** `requireEventCheckInAccess` requires `CHECKIN_SCAN` in the event's tenant, and a
  non-privileged operator is additionally bounded by a live `staffEventAssignment`
  (`revokedAt: null`). **PASS**

---

## 12. EVENT LIFECYCLE

**FILE** `lib/events/lifecycle.ts`, `sales-state.ts`, `catalog.ts`

```
PUBLISHED ──startAt──▶ ONGOING ──endAt + 30m──▶ COMPLETED
```

* Transitions are **monotonic and conditional**: `updateMany({ where: { status: … } })` with
  `AUTO_SOURCE_STATUSES = ["PUBLISHED","ONGOING"]`, so a re-run cannot re-apply or reopen. A
  missed tick is *caught up*, never fabricated into a fake intermediate history
  (`lifecycle.ts:110-113`).
* `COMPLETED` is removed from the purchasable set (`isEventPurchasable`, P14-D11) — "selling a
  finished event" is refused; `ONGOING` stays purchasable by design.
* `CHECK_IN_GRACE_MS` is defined **once** and imported by `sales-state.ts`, so the gate and the
  completion job cannot drift.

**The three known gaps, classified:**

| Gap | Classification | Reasoning |
|---|---|---|
| **No event-level `endAt` sales cutoff** (purchase gate = `PUBLISHED\|ONGOING` + visibility + not archived/cancelled; `isEventPurchasable` is genuinely called by `checkout.ts`) | **INTENTIONAL** | documented inline ("`ONGOING` … a TIME statement, not a commercial one, and the sales window still governs the sale") and unit-tested. Sales are bounded by per-ticket-type `salesEndAt` **and** by completion at `endAt + 30m`. Residual risk appears **only** if the scheduler is absent — see BLOCK-3. |
| **Check-in gate opens at publication** (`CHECKIN_OPEN_STATUSES = PUBLISHED\|ONGOING\|COMPLETED`) | **INTENTIONAL** | documented as "a gate is open while the event is a live, publicly-facing event". |
| **Open refunds block archive** (`service.ts:1419` `OPEN_REFUND_STATUSES`) | **INTENTIONAL** | prevents archiving away money that is still owed. |

---

## 13. SCHEDULER / JOB INFRASTRUCTURE

**FILE** `app/api/internal/jobs/tick/route.ts` · **SYMBOL** `isAuthorized`, `runJobsTick`

| Property | Evidence |
|---|---|
| Authentication | `Authorization: Bearer $JOBS_TICK_SECRET`, `safeEqual` padded so a length mismatch is not a clean signal |
| **Fails closed** | `if (!expected \|\| expected.length === 0) return false` — an unconfigured deployment never exposes "run every job" |
| Method restriction | `export async function POST` only; no GET handler exists |
| Replay | harmless — the tick is idempotent and single-flight via the `joblock` DB lease |
| No business logic in the route | it authenticates, calls `runJobsTick()`, serialises. State predicates/conditional updates/audit rows belong to the services |
| Leakage | job counts and timing only; refusal is a bare 401 that does not distinguish absent/malformed/wrong and does not log the presented value |

**Classification: PASS.** **BLOCK-3** is not a defect in this route — it is that nothing calls it.
`README.md` §1 documents both supported invocations (VPS cron and a systemd timer with
`EnvironmentFile=/etc/tinggalklik/tick.env`), and the tick is **required**: without it, events
never reach `ONGOING`/`COMPLETED` and expired seat holds are never released.

---

## 14. ENVIRONMENT / CONFIGURATION

Derived from `grep -rho "process\.env\.[A-Z_0-9]*" app/ lib/ components/ auth.ts proxy.ts next.config.ts scripts/ | sort -u` plus the `prisma/schema.prisma` `env("DATABASE_URL")` declaration.

**ACTIVE — the runtime reads these**

| Variable | Read by |
|---|---|
| `DATABASE_URL` | `prisma/schema.prisma` (`env("DATABASE_URL")`); base name of the Jest `_test` database |
| `AUTH_SECRET` | Auth.js internals (no `process.env` occurrence) |
| `AUTH_URL` | Auth.js internals — **overwrites `req.url`**, i.e. the login redirect origin (`proxy.ts` documents the coupling) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | `auth.ts` |
| `PAYMENT_ENVIRONMENT` | `lib/payment/config.ts` — **the selector; fail-closed, no default** |
| `IPAYMU_SANDBOX_VA`, `IPAYMU_SANDBOX_API_KEY`, `IPAYMU_SANDBOX_BASE_URL` | `lib/payment/config.ts` |
| `IPAYMU_PRODUCTION_VA`, `IPAYMU_PRODUCTION_API_KEY`, `IPAYMU_PRODUCTION_BASE_URL` | `lib/payment/config.ts` |
| `NEXT_PUBLIC_APP_URL` | `lib/app-origin.ts`, `lib/payment/config.ts` (production refuses localhost/`127.0.0.1`/`sandbox`) |
| `JOBS_TICK_SECRET` | `app/api/internal/jobs/tick/route.ts` |
| `UPLOAD_DIR` | `lib/images/process.ts`, `app/api/uploads/events/[filename]/route.ts` |
| `TRUSTED_PROXY` | `lib/rate-limit.ts` `getClientIp` |
| `NODE_ENV` | `next.config.ts` (HSTS/`unsafe-eval`), `lib/rate-limit.ts`, logging guards |

**OPTIONAL / DECLARED-BUT-INERT:** `REDIS_URL` (only triggers a warning; the limiter is in-memory),
`PORT`/`HOSTNAME` (read by `next start` itself, never by this code).

**LEGACY:** `IPAYMU_API_KEY`, `IPAYMU_VA`, `IPAYMU_URL`, `IPAYMU_IS_PRODUCTION` — read **only** by
`lib/payment/ipaymu-production.ts`, whose sole importer is `scripts/audit-ipaymu.ts`. The module
prefers the strict model whenever any `IPAYMU_*_{VA,API_KEY}` name is present (`strictMode`), so a
correctly-configured deployment never reaches the legacy branch. **INHERITED / LEGACY.**

**STALE DOCUMENTATION — fixed:** the old `.env.example` advertised `CLOUDINARY_*` (3),
`PAYOUT_*` (4), `RAJAONGKIR_*` (2), `WHATSAPP_AUTH_DIR`, `NOTIFICATION_PROVIDER`,
`SPIN_WHEEL_TEST_MODE` — **12 variables no code reads** — plus `DATABASE_URL` pointing at
`demo_marketplace` and `UPLOAD_DIR="./uploads"` (the code's default is `./storage/uploads`).

**MISSING FOR PRODUCTION:** none in code; the required *values* are `AUTH_URL`,
`TRUSTED_PROXY`, `NEXT_PUBLIC_APP_URL`, `PAYMENT_ENVIRONMENT=production` + the production
credential pair, and `JOBS_TICK_SECRET`.

---

## 15. LOGGING / INFORMATION DISCLOSURE

**Symbols inspected, not merely grepped for the word "secret":**

* `lib/payment/ipaymu.ts` — every `console.log` is guarded by
  `if (process.env.NODE_ENV !== "production")` and logs a **hand-built allow-list**
  (`url`, `amount`, `referenceId`, `method`, `channel`, `productCount`, a **truncated** body hash,
  `timestamp`; response: `httpStatus`, `status`, `message`, booleans, `sessionId`). The API key and
  the full signature are **never** in a log expression — the comment reads
  "SECURITY: Never log API key or full signature". Provider error messages are collapsed to a
  generic string in production (`process.env.NODE_ENV === "production" ? "…Gagal membuat
  pembayaran iPaymu." : …`).
* `lib/payment/ipaymu-production.ts` — its 20 `console.log` calls are inside
  `if (require.main === module)` (line 380), i.e. **CLI-only**, never on a request path; it prints
  `apiKeyPreview`/`vaPreview` (masked), never the raw values.
* `lib/ticketing/payment/webhook.ts` — the recorded payload summary is **redacted by
  construction**: "Buyer identifiers are dropped, the signature never appears, and no credential
  is kept" (`webhook.ts:121`); the full raw body is not stored, only a SHA-256 and the summary.
* `auth.ts` — the only log is `"[auth] login rate limit exceeded (ip bucket: …)"`; the attempted
  password and identifier are not logged.
* `lib/ticketing/refund` payloads drop `requestedByUserId`/`approvedByUserId`/`processedByUserId`.

**No production log expression was found that could emit a password, password hash,
`AUTH_SECRET`, iPaymu key, signature, `Authorization` header, session cookie, raw QR token or bank
identifier. PASS.**

---

## 16. SECURITY HEADERS / CSP

**FILE** `next.config.ts` · **SYMBOL** `headers()` (a single `source: "/(.*)"` rule, evaluated at
**call time** so the security suites can flip `NODE_ENV`)

| Header | Value | Note |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'`; `script-src 'self' 'unsafe-inline'` (**+`'unsafe-eval'` in development only**); `style-src 'self' 'unsafe-inline'`; `img-src 'self' data: https://my.ipaymu.com https://sandbox.ipaymu.com`; `font-src 'self'`; `connect-src 'self'`; `frame-src 'none'`; `object-src 'none'`; `base-uri 'self'`; `form-action 'self'`; `frame-ancestors 'none'` | every origin audited against the tree |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | **sent everywhere except development**; `preload` deliberately off |
| `X-Frame-Options` | `DENY` | together with `frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | order paths are themselves sensitive |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | clipboard deliberately unrestricted (only copies a value on screen) |
| `X-XSS-Protection` | `1; mode=block` | inert; retained because the frozen contract asserts it |
| `poweredByHeader` | `false` | removes `X-Powered-By` |

**Is `'unsafe-inline'` required?** Yes, today: the only scripts are Next.js's own chunks plus the
inline theme bootstrap in `app/layout.tsx`; the only styles are the Tailwind bundle plus Next's
inline style injection. Nothing loads a third-party script, style, font, connect or frame origin —
the retail pixels and Leaflet bundles were deleted with the retail application. The remote
Google logo on the auth buttons was replaced with inline SVG (`components/auth/GoogleMark.tsx`)
rather than widening `img-src`.

**Is the QRIS image origin justified?** Yes — the gateway serves the QRIS code as a PNG on its own
domain; re-encoding it locally is not an option. Two hosts, exactly the sandbox and production
gateways.

**Nonce migration:** not implemented, and correctly so. It requires middleware-generated nonces
plus dynamic rendering for every page that currently benefits from caching; the current policy
already blocks third-party script execution, which is the material risk. **FUTURE WORK.**

Verification: `npx jest __tests__/security --runInBand` → **6 suites, 101 tests, all PASS**
(`m3-hsts`, `m4-csp`, `csp-development-unsafe-eval`, `m2-ip-spoofing`, `phase24-headers`,
`deployment-env-contract`).

---

## 17. DATABASE / MIGRATION HYGIENE

* Schema valid; **23 migrations**, DB up to date; no drift reported.
* **`20260920000000_drop_unused_legacy_retail_tables` is untracked** while being applied locally —
  see BLOCK-1. Its name says "drop unused", so it is a destructive-in-name migration: it must be
  reviewed and committed deliberately, not swept into a bulk `git add`.
* One row of residue observed in the uploads directory and a documented fixture-teardown path
  that *archives* (never deletes) stranded reserved-prefix fixtures — **INTENTIONAL**.
* Retained legacy items (`refund_backup_phase10b`, the legacy `Role` enum with
  `ADMIN/SELLER/CUSTOMER/AFFILIATOR` alongside `PlatformRole`) — **LEGACY**, harmless while
  unreferenced; dropping them is future migration planning, not a Phase 25 action. **No schema or
  data change was made in this phase.**

---

## 18. DEPENDENCIES / SUPPLY CHAIN

`package.json` + a reference scan for each dependency:

| Package | Importers | Classification |
|---|---|---|
| `next-themes` | **0** (only mentioned in `components/dashboard/theme/*` comments explaining its removal) | **REAL DEFECT (P3)** |
| `@radix-ui/react-popover` | **0** | **REAL DEFECT (P3)** |
| `@radix-ui/react-visually-hidden` | **0** | **REAL DEFECT (P3)** |
| `axios` | 1 (`lib/services/auth.ts`, imported by `RegisterForm.tsx`) | used |
| `react-icons`, `recharts`, `qrcode.react`, `react-hot-toast`, `lucide-react`, `cva`, the remaining `@radix-ui/*` | ≥1 each | used |
| `next-auth` `^5.0.0-beta.32` | — | **beta pin in a production dependency**; the API surface used here is stable and covered by 78 suites, but it must be re-checked before every deploy |
| `prisma` / `@prisma/client` `^6.19.3` | — | matching pair |

Removal was **not** performed: `npm uninstall` rewrites `package-lock.json` and the brief forbids
package changes without explicit approval. Recorded for an owner-approved dependency-hygiene pass.
No `postinstall` script is declared, and `name: "toko"` is a stale retail identifier (INFO).

---

## 19. OBSERVABILITY / OPERATIONS

| Item | State | Classification |
|---|---|---|
| Health / readiness / liveness endpoint | **does not exist** (`find app -iname "*health*" -o -iname "*ready*"` → empty; the full route inventory confirms it) | **DEPLOYMENT BLOCKER (P2)** — nothing for nginx/PM2/systemd to probe |
| Error correlation IDs | numeric/digest correlation surfaced by the global boundary; API envelopes carry stable `code` | PASS |
| Webhook ledger | rows written for every delivery incl. refusals; **no UI**, "investigate through the database" (`README.md` §7) | INTENTIONAL |
| Refund "needs action" | `app/dashboard/refunds/page.tsx` surface + late-settlement docs (`README.md` §5) | PASS |
| PAID-with-zero-tickets | settlement writes `paymentStatus = PAID` **without** issuing when it must, and the code documents the resulting state explicitly | PASS (state is reachable *and* explained) |
| Reconciliation | `PERMISSIONS.PAYMENT_RECONCILE` is granted to roles but has **no route or UI**; `verifyPaymentStatus()` exists in `lib/payment/ipaymu.ts` with **no production consumer** | **FUTURE WORK (P2)** — a granted capability with no surface |
| Scheduler visibility | the tick returns per-job results and sets lease rows; no dashboard surface | FUTURE WORK (P3) |

---

## 20. PRODUCTION DEPLOYMENT READINESS

Not configured, not deployed. What a VPS deployment requires:

| Item | Requirement | Evidence / note |
|---|---|---|
| Node | **not pinned** — `package.json` has no `engines` field; local is v24.21.0, `@types/node` is ^20 | **BLOCK-5 (P3)** |
| Build / run | `npm run build` → `npm start` (verified: build succeeds; `next start` boots clean) | PASS |
| PORT / HOSTNAME | via `next start` env, not read by this code | configure at the process manager |
| Process manager | PM2 or systemd unit — **none in the repo** (`find . -maxdepth 2 -iname "*nginx*" -o -iname "*.service" -o -iname "ecosystem*" -o -iname "Dockerfile*"` → empty) | create at deploy time |
| Reverse proxy | required; must set **`TRUSTED_PROXY`** to the proxy address | **BLOCK-2** |
| HTTPS | required — `NEXT_PUBLIC_APP_URL` must be `https://`, and HSTS is emitted in every non-dev environment | PASS (code) / configure (infra) |
| `AUTH_URL` | the deployment's real public origin. Auth.js **overwrites `req.url`** with it, so a wrong value sends users to the wrong host after login | configure |
| `NEXT_PUBLIC_APP_URL` | must be https and must not contain `localhost`/`127.0.0.1`/`sandbox` or the payment path **throws** | PASS (code) |
| iPaymu | `PAYMENT_ENVIRONMENT=production` + the production credential pair; the VA must differ from the sandbox VA; **a registered fixed-IP/callback domain** and the `notifyUrl` `…/api/ticketing/payment/webhook` must be registered with the provider | configure |
| `JOBS_TICK_SECRET` | `openssl rand -hex 32`; the route **fails closed** (401) if unset | configure |
| Scheduler | cron or systemd timer, **once per minute**, POSTing the tick with the bearer secret | **BLOCK-3** |
| Uploads | `UPLOAD_DIR` must be persistent and **backed up** — DB rows point at files that exist only there | **BLOCK-4** |
| Filesystem permissions | the app user must own the upload dir | configure |
| Log rotation | Next.js writes to stdout; rotate at the process manager | configure |
| Migrations | `npx prisma migrate deploy` from a **committed** tree | blocked by **BLOCK-1** |
| Rollback | previous build artifact + `git revert`; note the untracked migration makes rollback undefined today | blocked by **BLOCK-1** |

---

## 21. TEST INFRASTRUCTURE

| Property | Evidence | Result |
|---|---|---|
| Test DB separation | `jest.setup-env.ts` → `applyTestDatabaseUrl()` in `setupFiles` (runs before the module graph, i.e. before `lib/prisma.ts` builds its client), deriving `<DATABASE_URL database>_test` | PASS |
| Refuses to run unmigrated | `__tests__/support/global-setup.ts` counts applied migrations vs `migration.sql` dirs and fails with `Run: npm run test:db:setup` | PASS |
| Fixture residue | `globalTeardown` → `fixture-teardown.ts` **archives** (never deletes) stranded reserved-prefix fixtures in both databases | INTENTIONAL (means a run is not 100 % read-only on the dev DB, by design) |
| Interference | `maxWorkers: 1`, with the reason documented (87 failures → 34 when serialised) | PASS |
| `.only` / `.skip` | scan returns **no real occurrences** (the single hit is `process.exit(1)` inside `__tests__/auth/register-rate-limit.test.ts`, a by-hand script excluded from `testMatch`) | PASS |
| Providers | no suite contacts iPaymu; `.env.example` states it and `lib/payment/config.ts` credentials are never read in tests | PASS |
| Known flake | the `payment-races` full-suite flake is contained by serialisation; **both full runs in this phase (63.4 s and 56.8 s) were green, 1703/1703** | PASS |
| `forceExit` | required because `lib/rate-limit.ts` starts a `setInterval` that is never `unref()`-ed — the module's own comment calls `.unref()` "the proper fix" | **REAL DEFECT (P3), not fixed** (touching the rate limiter for a shutdown nicety is not warranted; the workaround is correct and documented) |

---

## 22. FINDINGS MATRIX

| Area | Status | Severity | Evidence (FILE / SYMBOL / COMMAND) | Action |
|---|---|---|---|---|
| AUTH-1 identity from DB row | PASS | — | `auth.ts` `authorize()` | none |
| AUTH-2 role cannot be client-set | PASS | — | `LoginForm` sends only `identifier`,`password`; `__tests__/auth-flow/role-intent.test.ts` | none |
| AUTH-3 timing / enumeration | PASS | — | `TIMING_EQUALISATION_HASH` (real cost-12) | none |
| AUTH-4 stale/deleted user fails closed, no redirect loop | PASS | — | `lib/auth/session-gate.ts` `decideSessionGate`; `__tests__/auth-flow/session-gate.test.ts` | none |
| AUTH-5 callbackUrl open redirect | PASS | — | `proxy.ts` builds callback from `pathname`; `resolveSafeCallbackUrl` | none |
| AUTH-6 login limiter is a global bucket | DEPLOYMENT BLOCKER | **P1** | `lib/rate-limit.ts` `getClientIp`; `TRUSTED_PROXY` unset | set `TRUSTED_PROXY` at deploy |
| AUTH-7 dead `requireSession`/`requireAdminSession` | LEGACY | P3 | zero consumers; 401 without `code`; stale docblock | none (unreachable) |
| AUTHZ-1 centralized map, no stray role checks | PASS | — | role-read scan outside `lib/authz` returns only comments + the dead helper | none |
| AUTHZ-2 Phase 23A own-scope fix intact | PASS | — | `lib/authz/permissions.ts` mtime 04:41; owner 200 / other 404 live | none |
| API-1 error envelope + codes | PASS | — | `lib/api/errors.ts`, `handleApi`; `-wiring` suites | none |
| CSRF-1 every mutating route checked | PASS | — | exhaustive loop over `app/api/**/route.ts` | none |
| CSRF-2 the two exclusions are by design | PASS | — | `webhook.ts` (HMAC), `jobs/tick` (bearer); asserted in `payment-wiring.test.ts:307` | none |
| RATE-1 four active buckets | PASS | — | `lib/rate-limit.ts` `rateLimiters` | none |
| RATE-2 in-memory / per-instance | INTENTIONAL | P3 | module docblock; `REDIS_URL` inert | revisit if multi-instance |
| UPLOAD-1 magic bytes, no SVG, 5 MB, traversal, tenant authz | PASS | — | `lib/images/format.ts`, `process.ts`, upload/serve routes | none |
| UPLOAD-2 upload directory has no backup | DEPLOYMENT BLOCKER | **P1** | `UPLOAD_DIR`; DB rows point only at those files | define a backup job |
| PAY-1 redirect success ≠ PAID | PASS | — | all `PAID` writes in `settlement.ts`; `service.ts` exports only `createOrderPayment` | none |
| PAY-2 webhook HMAC, raw body, timing-safe, fail-closed, ledger | PASS | — | `webhook.ts:375-441` | none |
| PAY-3 payment config fail-closed + allow-listed host | PASS | — | `lib/payment/config.ts` `resolvePayEnvironment`, `buildIpaymuConfig` | none |
| REFUND-1 five self-dealing guards | PASS | — | `service.ts:363,432,542,667,753` | none |
| REFUND-2 evidence required to settle | PASS | — | `service.ts:633`; `validation.ts:122` | none |
| TICKET-1 payload exactly `TICKET:<code>` | PASS | — | `TICKET_QR_PREFIX`; `qr-payload-contract.test.ts` | none |
| TICKET-2 admission CAS + open-refund gate | PASS | — | `checkin/service.ts:408-452` | none |
| LIFE-1 monotonic, catch-up, no reopening | PASS | — | `lib/events/lifecycle.ts` | none |
| LIFE-2 no event-level `endAt` cutoff | INTENTIONAL | P3 | `isEventPurchasable` + its inline rationale + tests | revisit only if product wants a hard cutoff |
| LIFE-3 check-in opens at publication | INTENTIONAL | P3 | `CHECKIN_OPEN_STATUSES` | none |
| SCHED-1 tick auth + fail-closed | PASS | — | `jobs/tick/route.ts` `isAuthorized` | none |
| SCHED-2 nothing runs the tick | DEPLOYMENT BLOCKER | **P1** | `README.md` §1; no crontab/timer in repo | install cron/systemd timer |
| ENV-1 `.env.example` described the deleted retail app | **REAL DEFECT → FIXED** | **P1** | old template: 12 dead vars, `demo_marketplace`, `sandbox.iapmu.id`, `UPLOAD_DIR="./uploads"`, no `AUTH_URL` | rewritten from sources |
| ENV-2 `storage/` not ignored | **REAL DEFECT → FIXED** | P3 | `storage/uploads/events/*.png` untracked; `UPLOAD_DIR` default | added to `.gitignore` |
| ENV-3 `*.tsbuildinfo` + `next-env.d.ts` tracked | REAL DEFECT | P3 | `git ls-files`; Next docs §`next-env.d.ts`: "Add it to `.gitignore`… remove it from Git" | ignore added; `git rm --cached` is an owner action |
| ENV-4 legacy iPaymu names | LEGACY | P3 | read only by `lib/payment/ipaymu-production.ts` ← `scripts/audit-ipaymu.ts`; `strictMode` prefers the new model | none |
| LOG-1 no secret in any log expression | PASS | — | `lib/payment/ipaymu.ts` (dev-gated allow-list), `webhook.ts` (redacted summary), CLI logs behind `require.main` | none |
| HDR-1 full header set, dev/prod split | PASS | — | `next.config.ts` `headers()`; `__tests__/security` 101/101 | none |
| HDR-2 `'unsafe-inline'` script-src | INTENTIONAL | P3 | inline theme bootstrap + Next chunks | nonce migration = future work |
| DB-1 schema/migrations consistent | PASS | — | `prisma validate`; `migrate status` up to date | none |
| DB-2 destructive-in-name migration untracked | DEPLOYMENT BLOCKER | **P1** | `git status prisma/migrations` | review and commit deliberately |
| DEP-1 three unused packages | REAL DEFECT | P3 | `next-themes`, `@radix-ui/react-popover`, `@radix-ui/react-visually-hidden` → 0 importers | owner-approved removal |
| DEP-2 `next-auth` beta + no `engines` | DEPLOYMENT BLOCKER | P3 | `package.json` | pin Node; re-check the beta before deploy |
| OPS-1 no health endpoint | DEPLOYMENT BLOCKER | P2 | route inventory | add one (needs proxy allow-list + classification test) |
| OPS-2 `PAYMENT_RECONCILE` has no surface | FUTURE WORK | P2 | granted in `permissions.ts`; `verifyPaymentStatus` unused | build the reconciliation surface |
| OPS-3 webhook ledger has no UI | INTENTIONAL | P3 | `README.md` §7 | none |
| TEST-1 isolation, guards, no skips | PASS | — | `jest.setup-env.ts`, `global-setup.ts`, `.only/.skip` scan | none |
| TEST-2 `setInterval` not `unref()`-ed → `forceExit` | REAL DEFECT | P3 | `lib/rate-limit.ts`; `jest.config.js` comment | optional cleanup |
| PROC-1 the whole phase body is uncommitted | DEPLOYMENT BLOCKER | **P1** | 45 M + 38 ?? paths | commit before any deploy |

---

## 23. REQUIRED OWNER DECISIONS

1. **Commit strategy for Phases 21–25** — one large commit, or one per phase? The tree currently
   contains an **already-applied destructive-in-name migration**; decide whether it ships.
2. **Unused dependencies** — approve removing `next-themes`, `@radix-ui/react-popover`,
   `@radix-ui/react-visually-hidden` (rewrites `package-lock.json`).
3. **Health endpoint** — approve adding one, and choose its visibility (public-reachable
   unauthenticated vs proxy-only), since it must be added to the proxy allow-list and to the route
   classification test.
4. **Un-track the generated artifacts** — approve `git rm --cached tsconfig.tsbuildinfo next-env.d.ts`.
5. **Event-level `endAt` sales cutoff** — currently bounded only by per-tier `salesEndAt` and by
   automatic completion. Product decision, not a defect.
6. **Reconciliation surface** and **webhook ledger UI** — product/ops scope, deliberately not built.
7. **Backup policy** for `UPLOAD_DIR` and the database, including retention.

---

## 24. DEPLOYMENT CHECKLIST

**Before the first deploy**

- [ ] Commit the working tree; decide the fate of `20260920000000_drop_unused_legacy_retail_tables`
- [ ] `npm run test:db:setup` on the target host, then `npx prisma migrate deploy`
- [ ] Pin a Node major version (add `engines`; local verified on v24.21.0)
- [ ] `AUTH_SECRET` = `openssl rand -base64 32`; `JOBS_TICK_SECRET` = `openssl rand -hex 32`
- [ ] `AUTH_URL` = the real public HTTPS origin (wrong value ⇒ login lands on the wrong host)
- [ ] `NEXT_PUBLIC_APP_URL` = the same HTTPS origin (the payment path throws otherwise)
- [ ] `PAYMENT_ENVIRONMENT=production` + the production VA/API-key pair, VA ≠ sandbox VA
- [ ] Register the `notifyUrl` and the provider's required fixed IP / callback domain with iPaymu
- [ ] `TRUSTED_PROXY` = the reverse proxy address (**without it the login limiter locks out everyone**)
- [ ] `UPLOAD_DIR` = a persistent, backed-up path; the app user owns it

**On the host**

- [ ] Reverse proxy (nginx) terminating TLS + HSTS passthrough
- [ ] Process manager (PM2 or systemd) running `npm run build` → `npm start`
- [ ] **Scheduler installed**: cron or a systemd timer POSTing `/api/internal/jobs/tick` every
      minute with the bearer secret (`README.md` §1). Nothing else performs `PUBLISHED → ONGOING →
      COMPLETED` or releases expired seat holds
- [ ] Log rotation for the process manager's stdout
- [ ] Backup job for the database **and** `UPLOAD_DIR`

**Smoke test after deploy**

- [ ] Anonymous `/login` → 200; anonymous `/dashboard` → 302 to `/login?callbackUrl=%2Fdashboard`
- [ ] Each role's post-login destination (ADMIN/MANAGER → `/dashboard`, PIC → `/dashboard/pic`,
      CUSTOMER → `/ticketing/tickets`)
- [ ] An own order → 200; another buyer's → 404; unknown → 404
- [ ] Response headers: CSP, HSTS, `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
      `Permissions-Policy`
- [ ] Tick the scheduler once by hand and confirm a `joblock` row and a 200 with job counts
- [ ] A sandbox payment end-to-end: create → redirect → **return to the canonical order page** →
      confirm the return does **not** mark PAID → webhook settles → tickets issue

---

## 25. FINAL VERDICT

**VERDICT: READY WITH BLOCKERS** (2 bounded real defects found and fixed; 5 deployment blockers,
2 real defects deferred to owner approval, 1 future-work item, the rest PASS/INTENTIONAL/LEGACY).

**Real defects**

| ID | Severity | Fixed? |
|---|---|---|
| ENV-1 `.env.example` documented the deleted retail application | P1 | **yes** (rewritten + pinned by `__tests__/security/deployment-env-contract.test.ts`) |
| ENV-2 `storage/` (runtime uploads) not git-ignored | P3 | **yes** (`.gitignore`) |
| ENV-3 `tsconfig.tsbuildinfo`, `next-env.d.ts` tracked | P3 | partially (ignore added; untracking needs owner approval) |
| DEP-1 three unused packages | P3 | no (needs approval — lockfile) |
| TEST-2 rate-limiter interval not `unref()`-ed | P3 | no (workaround correct and documented) |

**Deployment blockers:** BLOCK-1 uncommitted tree incl. an applied migration (P1) · BLOCK-2
`TRUSTED_PROXY` unset ⇒ global login bucket (P1) · BLOCK-3 scheduler not installed (P1) · BLOCK-4
upload directory not backed up (P1) · BLOCK-5 no health endpoint (P2) / unpinned Node (P3).

**Intentional gaps (unchanged):** no event-level `endAt` cutoff · check-in opens at publication ·
open refunds block archive · in-memory per-instance limiter · webhook ledger has no UI ·
`'unsafe-inline'` in `script-src` · account switching requires sign-out.

**Future work:** reconciliation surface for the granted `PAYMENT_RECONCILE` capability · webhook
ledger UI · CSP nonce migration · drop the legacy `Role` enum and `refund_backup_phase10b`.

**Verification performed in this phase**

| Command | Result |
|---|---|
| `npx prisma validate` | schema valid |
| `npx prisma migrate status` | 23 migrations found; database schema up to date |
| `npx tsc --noEmit` | exit 0, no output |
| `npx eslint .` | 0 errors, 3 warnings (pre-existing `no-img-element`) |
| `npx jest __tests__/security --runInBand` | **101 passed / 101, 6 suites** |
| `npm test -- --runInBand` | **1703 passed / 1703, 78 suites** |
| `npm run build` | ✓ Compiled successfully |
| Live HTTP | **not performed in this phase** — no runtime code changed, so no runtime behaviour could have changed. (Phase 24 verified gating, callbacks, headers and order ownership against a production build.) |

**Explicit confirmations**

* **Database data changed: NO.** No migration was run, no `db push`, no reset, no row
  created/updated/deleted, no truncate. Prisma was used read-only (`validate`, `migrate status`).
* **Payment/provider call made: NO.** No iPaymu call, sandbox or production; no payment row
  touched.
* **Deployment / commit / push / reset / clean: NO.** Nothing was staged, committed or pushed;
  no git history or working-tree state was rewritten. The only files this phase changed are
  `.env.example`, `.gitignore`, and the new `__tests__/security/deployment-env-contract.test.ts`.

**Not verified (stated, not assumed):** live HTTP in this phase; the browser behaviour of the
development CSP under HMR; and MANAGER/PIC live redirects, which cannot be exercised because no
such accounts exist in the local database (their destinations are proven by the pure per-role
tests in `__tests__/auth-flow/`).
