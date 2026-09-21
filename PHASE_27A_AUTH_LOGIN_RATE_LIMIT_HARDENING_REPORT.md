# PHASE 27A — AUTH LOGIN / RATE-LIMIT HARDENING

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Mode:** audit → bounded implementation of F1–F4. F5 untouched.
**Baseline:** Phase 26B release set staged in the index, `HEAD` = `8628dbf`.

---

## 1. EXECUTIVE SUMMARY

Four defects were reported after the Phase 27 audit. All four are fixed, and each fix was
verified against the framework's actual behaviour rather than a description of it.

| # | Defect | Status | Evidence |
|---|---|---|---|
| **F1** | Duplicate registration answered **400** while sending code `CONFLICT` | **FIXED** | `app/api/auth/register/route.ts` — status now read from `statusForCode(ERROR_CODES.CONFLICT)` = 409; body unchanged |
| **F2** | A raced duplicate (Prisma `P2002`) fell into the catch-all → **500** | **FIXED** | `isUniqueConstraintError()` + shared `duplicateAccountResponse()`; 409, same body, no Prisma detail, not logged as an outage |
| **F3** | Login limiter counted **requests** (successes too) and collapsed every dev client into `login:untrusted` | **FIXED** | `lib/rate-limit.ts` — read-only probe + explicit failure recorder + `clientRateLimitKey`; production path byte-identical |
| **F4** | A throttled visitor was told their password was wrong | **FIXED** | `LoginRateLimited extends CredentialsSignin` (`code = "rate_limited"`) + `lib/auth/sign-in-failure.ts`; live-verified below |
| **F5** | 264/275 users have `password = NULL` | **UNTOUCHED — owner decision** | No code, data or schema change; see §9 |

The single behavioural change a buyer can see is that a fifth wrong password now produces a
*rate-limit* sentence instead of "password salah". Nothing about any account, identifier or
password state is disclosed by it.

---

## 2. WHAT WAS WRONG, PRECISELY

### F1 — two clients disagreed about one response

`lib/api/errors.ts` is the platform's status registry and maps `CONFLICT: 409`. The register
route hand-wrote its own envelope and paired the code with **400**. A client branching on
`code` (the documented contract: *"branch on `code`, never on `message`"*) and a client
branching on the status reached opposite conclusions about the same event.

### F2 — the duplicate check is a read, not a lock

`prisma.user.findFirst` then `prisma.user.create` cannot be atomic without a transaction
around a unique index that already exists. Two concurrent registrations for one email both
pass the pre-check; the loser raises `P2002`, which the route's `catch` turned into
**500 "Terjadi kesalahan saat registrasi."** — a server error reported for a duplicate
account, and a log line that looks like an outage.

### F3 — the limiter charged the wrong event, then could not say so

Two independent defects in one bucket:

1. **`rateLimiters.login(ip)` counted every `authorize()` call.** A *successful* sign-in
   spent the same allowance as a wrong password, and so did a request carrying no
   credentials at all. Five of the operator's own logins were enough to lock the bucket.
2. **When the bucket was empty, `authorize` returned `null`.** Auth.js collapses `null` into
   the same `CredentialsSignin` as a wrong password, so a locked visitor was told their
   password was wrong, retried, stayed locked, and was told again.

A third, smaller defect: the bucket key was `"untrusted"` whenever no forwarding header was
trusted, which in a dev server run without a reverse proxy is *every* local client.

### F4 — one message for three outcomes

With F3.2 fixed the code exists but nothing consumed it: `LoginForm` rendered a single
`setAuthError(AUTH_FAILED_MESSAGE)` for `result?.error`. A misconfiguration was reported as a
password problem too.

---

## 3. FILES CHANGED

### Application

Per-file line counts are `git diff --numstat` (insertions/deletions); the eight modified
paths total **+505 / −69**.

| File | Δ | What and why |
|---|---|---|
| `lib/rate-limit.ts` | +209/−7 | `openWindow()` (one window implementation), `checkRateLimit` refactored onto it, **new** `peekRateLimit` (read-only probe) and `recordRateLimitFailure` (the only way to spend the allowance), **new** `clientRateLimitKey`, and `rateLimiters.login` reshaped from one call into `{ check, recordFailure, maxFailures, windowMs }`. Values unchanged: **5 / 15 min**. |
| `auth.ts` | +77/−22 | Limits are probed once, spent **only** on a failed verification (3 call sites: unknown user, passwordless account, wrong password), never on a malformed request or a success; refusal `throw new LoginRateLimited()`; doc comment rewritten (it claimed the old semantics and a stale deployment note). |
| `lib/auth/sign-in-failure.ts` | **new, 147 lines** | Pure/client-safe: `LOGIN_RATE_LIMITED_CODE`, the three sentences, `classifySignInFailure(error, code)`. One definition shared by server and client so they cannot drift. |
| `app/api/auth/register/route.ts` | +70/−13 | 409 from the registry; `duplicateAccountResponse()` shared by the pre-check and the race handler; `isUniqueConstraintError()`; bucket key from `clientRateLimitKey`. |
| `components/auth/LoginForm.tsx` | +37/−17 | Renders `classifySignInFailure(result?.error, result?.code)?.message`; the local message constant is gone (the shared module owns it); header doc updated. |

### Tests

| File | Δ | What |
|---|---|---|
| `__tests__/security/phase27a-login-rate-limit.test.ts` | **new, 435 lines / 24 tests** | Bucket key in production/dev (incl. spoofed `x-forwarded-for` and fail-closed cases), the allowance semantics, the honest dev-collapse limitation, and the `auth.ts` / register-route wiring contracts. |
| `__tests__/auth-flow/sign-in-failure.test.ts` | **new, 239 lines / 19 tests** | Classification table, message contract (incl. the pinned credential sentence), and the form wiring. |
| `__tests__/auth-flow/register-route.test.ts` | +93/−4 | Duplicate → 409; `P2002` → 409 with no Prisma detail and no error log; unexpected failure → 500 + log; bucket-key mock updated. |
| `__tests__/auth-flow/register-customer-only.test.ts` | +9/−3 | Duplicate → 409 (message pinned); bucket-key mock updated. |
| `__tests__/auth-flow/role-intent.test.ts` | +5/−1 | **Anchor only** — the failed-login slice starts at the classification now. Assertions unchanged, slice strictly wider. |
| `__tests__/auth-flow/post-login-redirect.test.ts` | +5/−2 | Same anchor update, assertions unchanged. |

Nothing else in the tree was modified. `git diff --name-only` lists exactly these eight paths;
no `lib/payment/**`, no `lib/ticketing/**`, no `prisma/**`.

---

## 4. THE DEV BUCKET — WHAT WAS CHECKED AND WHAT IS HONESTLY POSSIBLE

`clientRateLimitKey` was written only after establishing whether a trustworthy peer address
exists on this code path. It does not, and that is not an assumption:

* `next/dist/server/base-server.js:612` —
  `req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress;`
  The header is filled **only when the client did not send one**, so a client-supplied value
  and a socket-derived one are indistinguishable by the time a handler reads it. Reading it
  would re-open the M2 spoofing hole.
* `NextRequest` declares **no `ip`** in Next 16 (`server/web/spec-extension/request.d.ts`), and
  a `Request` has no socket.

So the function does the only thing that is both safe and useful:

* **Production — unchanged to the byte.** `getClientIp`'s answer is returned as-is: a trusted
  reverse proxy yields the real client IP, and a missing `TRUSTED_PROXY` still fails closed
  into the shared `untrusted` bucket.
* **Development — its own labelled bucket (`dev-local`)**, reachable only when
  `NODE_ENV !== "production"`. The gate is an equality test against `"production"`, so a
  production build cannot enter it.

**Limitation, stated rather than hidden:** two browsers on one dev server still share that
bucket, because separating them would require trusting a header M2 deliberately stopped
trusting. The remedy for the reported lockout is the accounting fix, and the `dev-local` label
is what makes the dev behaviour explicit instead of accidental. A test asserts this collapse
so the next editor sees it rather than rediscovers it.

---

## 5. WHY THE CODE REACHES THE CLIENT (VERIFIED, NOT ASSUMED)

`@auth/core/index.js` (the installed beta):

```js
const isClientSafeErrorType = isClientError(error);
const type = isClientSafeErrorType ? error.type : "Configuration";
const params = new URLSearchParams({ error: type });
if (error instanceof CredentialsSignin) params.set("code", error.code);
```

Verified by execution, not by reading:

```
instanceof CredentialsSignin: true
type: CredentialsSignin | code: rate_limited
isClientError: true
```

Static properties are inherited, so a subclass keeps `type = "CredentialsSignin"` (staying in
the client-safe set) and carries its own `code`; `next-auth/react` reads both out of the URL.
The classification therefore keys on the **code**, which is the value this application
controls — not on a type string that any thrown `CredentialsSignin` shares.

---

## 6. SECURITY IMPLICATIONS

* **No weaker control.** Rate limiting stays on, still 5 per 15 minutes, still checked before
  any password is verified. A refused request never reaches `bcrypt` or the database — proven
  live in §7 (attempt 6 was refused, not merely answered with a different sentence).
* **No spoofable key.** Client-supplied `x-forwarded-for` is ignored unless `TRUSTED_PROXY` is
  configured, exactly as M2 requires; asserted in both directions.
* **No new disclosure.** The rate-limit sentence names no account, identifier, count or
  remaining time; the three sentences are asserted to contain no internal token, no raw error
  type, no status code and no existence hint whatsoever. Unknown Auth.js error types fall back
  to the generic credential sentence — the failsafe direction.
* **No enumeration.** Credential failures remain one uniform sentence and one timing-equalised
  path (`TIMING_EQUALISATION_HASH` untouched).
* **No Prisma disclosure.** The `P2002` branch is matched on the code field only; `meta`,
  `clientVersion`, the SQL and the model name are neither returned nor logged.
* **No CSRF, ownership or session change.** `requireSameOrigin` still runs first and still
  fails closed (403 before the body is read, asserted); registration still creates a CUSTOMER
  from an allow-list of four fields; no role input was added anywhere.
* **No payment surface touched.** No file under `lib/ticketing/**` or `lib/payment/**` is in
  this phase's diff; the Phase 27 H1 race is untouched and still open.

---

## 7. LIVE VERIFICATION (production build, isolated process, loopback only)

`PORT=3111 npx next start` against the local build and the local **development** database,
using a non-existent identifier (read-only lookup, no row written, no provider call):

```
GET  /api/health                       -> {"status":"ok"}
GET  /api/auth/csrf                    -> csrf token present (64 chars)
POST /api/auth/callback/credentials    -> attempt 1 -> code=credentials
                                          attempt 2 -> code=credentials
                                          attempt 3 -> code=credentials
                                          attempt 4 -> code=credentials
                                          attempt 5 -> code=credentials
                                          attempt 6 -> code=rate_limited
log: "login rate limit exceeded"       -> exactly 1 line
log: password literal                  -> absent
```

This is the whole F3/F4 story end to end: five credential failures exhaust the allowance, the
sixth is refused with a **distinct code the browser can read**, the refusal itself is not
counted again (one log line, not two), and no credential reaches the log.

The register path was **not** exercised live, deliberately: the only way to provoke a
duplicate against the development database is to name an existing account, which would mean
reading a real buyer's email, and any other payload would have written a row. It is covered by
driving the real handler with real `Request` objects instead
(`register-route.test.ts`: 201 / 400 / 403 / 409 / 409-race / 500).

---

## 8. TESTS

| Stage | Suites | Tests | Result |
|---|---|---|---|
| Phase 26B baseline | 82 | 1758 | 1758 passed |
| **After Phase 27A** | **84** | **1803** | **1802 passed, 1 failed** |
| New suites alone | 2 | 43 | 43 passed |
| `__tests__/security` + `__tests__/auth-flow` | 16 | 357 | 357 passed |

**The one failure is the known Phase 27 H1 race** (`payment-races.integration.test.ts:230`:
eight concurrent Pay clicks produced two gateway sessions). It is pre-existing, was
explicitly out of scope, and reproduces identically without this phase's changes:
`lib/ticketing/payment/service.ts` is not in the diff. **8/8 pass in isolation**, which is the
same intermittent signature Phase 26A documented. No new failure was introduced and no test
was weakened, skipped or deleted to obtain this result.

Existing tests updated (not loosened):

* `register-route.test.ts` / `register-customer-only.test.ts` — the duplicate assertion now
  expects **409**, which is the contract change itself;
* `role-intent.test.ts` / `post-login-redirect.test.ts` — **anchor updates only**: the
  failed-login slice starts at `const failure = classifySignInFailure(`, because the branch it
  slices is now classified in a shared module. Their assertions (`return;`, no `router.replace`,
  no `router.push`) are unchanged, and the slice is strictly wider than before. Both files
  assert a message was added, not removed.

## 9. VERIFICATION COMMANDS

| Command | Result |
|---|---|
| `npx prisma validate` | ✅ "The schema at prisma/schema.prisma is valid 🚀" |
| `npx prisma migrate status` | ✅ "23 migrations found" / "Database schema is up to date!" |
| `npx tsc --noEmit` | ✅ clean (0 errors) |
| `npx eslint .` | ✅ **0 errors, 3 warnings** — the same 3 pre-existing `<img>` warnings as before this phase; the one warning this phase briefly introduced was fixed, not suppressed |
| `npm test -- --runInBand` | ⚠️ 1802/1803 (the pre-existing H1 race only) |
| `npm run build` | ✅ compiled successfully |

**Database:** no schema change, no migration, no `db push`, no reset, no truncate, no row
written or deleted. Jest ran against the dedicated `_test` database; the live check above was
read-only on the development database.

---

## 10. GIT STATE

* `HEAD` is still **`8628dbf`**. No commit, no push, no reset, no clean, no reflog entry.
* The **Phase 26B staged release baseline is preserved**: all 129 staged paths are untouched in
  the index except the two this phase had to modify (`app/api/auth/register/route.ts`,
  `components/auth/LoginForm.tsx`), and the re-staged copies are exactly the working-tree
  versions, so the index cannot commit a stale implementation.
* This phase added: `auth.ts` and `lib/rate-limit.ts` (both clean at `HEAD` before, now
  modified for F3), `lib/auth/sign-in-failure.ts`, the two new suites, and this report.
* `0` files were deleted, `0` were restored, and nothing was staged with `git add .`
* Staged total is now **137** paths (the Phase 26B 129, plus this phase's additions and the two
  files it modified that were previously clean at `HEAD`: `auth.ts`, `lib/rate-limit.ts`).

### Known artifact: `git diff --cached --check` is not clean, and was not clean before

`--check` reports **132** "trailing whitespace" lines. All of them come from exactly two files
and every one of them is a **CR** byte at end of line:

| File | Lines flagged | Whose |
|---|---|---|
| `auth.ts` | **77** (the lines this phase added) | mine, following the file |
| `app/login/page.tsx` | **55** | the pre-existing staged baseline — not touched by this phase |

Measured, not assumed:

```
HEAD:auth.ts             first line ends  ";^M$"      (335 CR lines at HEAD)
HEAD:app/login/page.tsx  first line ends  ";^M$"      (  8 CR lines at HEAD)
index auth.ts                                                  390 CR lines
```

So `auth.ts` is a **CRLF file in `HEAD`**, and this phase's 77 added lines are CRLF because the
file is — the alternative would be an LF island inside a CRLF file, i.e. a mixed-encoding file,
which is strictly worse than the warning. `--check` flags these because the repository has no
`.gitattributes` and `core.autocrlf` is unset, so CR is content rather than a checkout artifact.

**Deliberately not fixed here.** The remedy is repository-wide EOL normalisation
(`* text=auto` + `git add --renormalize .`), which rewrites hundreds of untouched lines inside
an already-staged release baseline and belongs to an owner decision, not to an auth fix. It was
also **already true of the baseline** before this phase (the 55 `app/login/page.tsx` lines came
with Phase 24's work), so this phase neither introduced the condition nor is the place to end
it.

---

## 11. REMAINING ISSUES / OWNER DECISIONS

1. **F5 — 264 of 275 users have no password.** Untouched, as instructed. Until it is decided,
   those accounts cannot sign in with credentials: some are Google-created (correct), and some
   look like imported/legacy rows (an onboarding decision, not a code defect). Options as
   reported in the Phase 27 audit: an administrative password-reset/onboarding flow, or an
   explicit statement that only the credentialled accounts may sign in.
2. **Phase 27 H1 — payment concurrency race.** Still open, by instruction. Two payable
   instruments can exist for one order; paying both creates a settlement flagged for manual
   handling (no double issuance, no amount manipulation).
3. **`TRUSTED_PROXY` must still be set on the VPS**, and the nginx directive must *overwrite*
   `x-forwarded-for` (`$remote_addr`), never append — otherwise every client shares one bucket
   (Phase 25 §6 / the deployment runbook). The `dev-local` bucket does not change this.
4. **In-memory limiter** remains per-process, so PM2 must stay at `instances: 1` (Phase 26
   `ecosystem.config.cjs`), which is also what makes `clientRateLimitKey`'s production branch
   correct as written.
5. **`__tests__/auth/register-rate-limit.test.ts` is dead and now stale.** It is a hand-run
   `tsx` script, excluded from `testMatch` on purpose, that reads
   `app/api/voucher/validate/route.ts` — a file deleted with the retail application, so it
   cannot run. Its assertions about `getClientIp(req)` in the register route no longer match the
   source. It was left in place rather than deleted (the phase forbids removing tests); it
   should be deleted or rewritten in a future phase, and it is not part of any suite.
