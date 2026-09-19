# LOGIN → DASHBOARD IMPLEMENTATION REPORT

Scope: after a successful login, a user **with** back-office access lands on `/dashboard`; a user
**without** it is refused. `/dashboard` stays protected and server-side-authorized. No new
dashboard was created and no authentication architecture was replaced.

---

## 1. Authentication Flow

```
/login  (public, 200)
   │  LoginForm → signIn("credentials", { identifier, password, redirect: false })
   ▼
Auth.js Credentials provider (auth.ts — UNCHANGED)
   │  success → session cookie set; failure → result.error
   ▼
client navigation to postLoginDestination(callbackUrl)
   │
   ▼
proxy.ts  ── no session?  ──►  302 /login?callbackUrl=<path>
   │  session present
   ▼
app/dashboard/layout.tsx
   │  no session      → redirect("/login")
   │  no capability   → <AccessDeniedPanel/>
   ▼
/dashboard
```

Two layers, both server-side:

| Layer | Answers | Mechanism |
|---|---|---|
| `proxy.ts` | *are you signed in?* | coarse protected/public split, 302 to `/login` |
| `lib/dashboard/scope.ts` | *may you use the back office?* | `canEnterDashboard(...)` from real permission deciders |

The proxy deliberately does **not** authorize — it runs where Prisma is unavailable, so it cannot
answer "may this actor touch this organizer?". The real decision is per-request in the layout and
the page services.

## 2. Login Redirect

`lib/auth/redirect.ts` (new) owns the destination as a **pure function**:

* `DEFAULT_POST_LOGIN_PATH = "/dashboard"`
* `postLoginDestination(raw)` → sanitised callback, else `/dashboard`

`components/auth/LoginForm.tsx` funnels **all three** navigation paths through it — the
credentials submit, the already-authenticated visit, and the Google button (`callbackUrl`):

```ts
router.replace(postLoginDestination(readCallbackUrl()));
```

No path leads to `/`, `/admin`, `/platform`, `/organizer` or any retail route any more. (That
retail home-page redirect existed: `session.user.role` was read and used to pick a landing page,
and the session was printed with `console.log`.) Both are gone — the role-string branch and the
session log.

A failed login **returns before any navigation**, keeping its existing toast and staying on
`/login`.

## 3. Callback URL Behavior

`/dashboard/events` while anonymous → `/login?callbackUrl=%2Fdashboard%2Fevents` → login →
`/dashboard/events`.

The value is attacker-controlled (it travels through the URL), so it is validated by **parsing**,
not by prefix matching: the value is resolved against the reserved sentinel origin
`https://internal.invalid` and accepted only if the origin is still that sentinel.

| Input | Result |
|---|---|
| `/dashboard/events` | accepted |
| `/dashboard?tab=orders#x` | accepted (path + query + hash) |
| `https://evil.example` | rejected |
| `//evil.example` | rejected — protocol-relative resolves off-origin |
| `javascript:alert(1)` | rejected |
| `/\evil.example` | rejected — backslash is normalised to `/` by some browsers |
| `/login`, `/register` | rejected — would loop the user |
| values with `\n` / `\r` / `\0` | rejected — header smuggling / truncation |
| `https://internal.invalid/dashboard` (our **own** host, absolute) | rejected — only a path is ever needed |

Invalid input is treated as **absent**, never as a navigation target. The proxy builds the
callback from the resolved request **path**, never from the incoming query — verified live: a
request to `/dashboard/events?callbackUrl=https://evil.example` produced
`callbackUrl=%2Fdashboard%2Fevents`.

## 4. Dashboard Access Rules

`canEnterDashboard(capabilities)` = `hasTenantAccess || hasPlatformSurface`, where those are
derived from the existing deciders (`decidePlatformPermission` / `decideOrganizerPermission`) and
the existing permission vocabulary — never from `user.role === "ADMIN"`.

| Actor | Entry | Basis |
|---|---|---|
| Platform user (e.g. `event.read`, `pic.manage`, `sport.manage`, `venue.manage.global`) | allowed | any platform surface permission |
| Organizer with a live membership (`order.read.tenant`, `event.write`, `pic.assign`, `venue.manage`, …) | allowed | `hasTenantAccess` |
| PIC user | allowed **only** if a permission it actually holds grants a surface | same rule, no special case |
| Authenticated customer, no tenant/platform capability | **refused** | `AccessDeniedPanel`, no redirect |

`app/dashboard/layout.tsx` and the access tests call the *same* function, so the gate cannot drift
from what is tested.

## 5. Unauthorized User Behavior

* **Anonymous** → `302` to `/login?callbackUrl=<path>` (proxy).
* **Authenticated but unauthorized** → the layout renders `AccessDeniedPanel`. Deliberately a
  refusal *state*, not a redirect: a redirect would hide the 403 and leave the user guessing. The
  scope resolves fine — the refusal comes from capabilities, so *being signed in is not access*.
* **Direct URL entry** is not a bypass: every page's own service re-decides authorization from the
  database, so typing `/dashboard/orders` as a customer is refused by the service even if the
  shell rendered.

## 6. Proxy Changes

**No behavioral change.** `/dashboard` remains in `PROTECTED_PAGE_ROUTES`; the matcher remains
`/dashboard/:path*`; the redirect remains `Response.redirect(new URL("/login", req.url))` with
`searchParams.set("callbackUrl", pathname)`. A comment block was added recording why the shape is
what it is (see §16 item 1) — that investigation did not change the code.

## 7. Auth.js Changes

**None.** `auth.ts` is untouched — provider, callbacks, session strategy and `AUTH_SECRET` usage
are exactly as before. The only Auth.js-adjacent edits are the login form's destination and the
removal of the session log.

## 8. Files Changed

| File | Change |
|---|---|
| `components/auth/LoginForm.tsx` | all navigation through `postLoginDestination`; removed the role-based landing branch and `console.log(session)`; failed login still returns early |
| `proxy.ts` | comment only — documents the `AUTH_URL` origin coupling and the two rejected alternatives |
| `jest.config.js` | enrolled `__tests__/auth-flow/*.test.ts`; documented that `__tests__/auth/` is excluded |
| `lib/dashboard/scope.ts` | `canEnterDashboard` / `computeDashboardCapabilities` (the entry gate) |
| `app/dashboard/layout.tsx` | gate: `redirect("/login")` without a session, `AccessDeniedPanel` without capability |
| `__tests__/ui-consolidation/shadcn-dashboard.test.ts` | updated to the single-shell, capability-gated reality |

## 9. Files Added

| File | Purpose |
|---|---|
| `lib/auth/redirect.ts` | pure callback sanitiser + default destination |
| `__tests__/auth-flow/post-login-redirect.test.ts` | 41 tests — redirect, callback guard, form wiring, proxy, logout |
| `__tests__/auth-flow/dashboard-access.integration.test.ts` | 11 DB-backed tests — who may enter, tenant isolation |

## 10. Files Deleted

None. This task removed code, not files: the role-based landing branch, the "Lupa Password?" link
(it pointed at a `/forgot-password` route that has never existed, i.e. a 404), and the session log.

## 11. Security Review

| Risk | Handling |
|---|---|
| Open redirect via `callbackUrl` | parsed against a sentinel origin; off-origin, protocol-relative, `javascript:`, backslash and control-char values all rejected |
| Callback smuggling via the incoming query | the proxy sets `callbackUrl` from `pathname` only — verified live |
| Bypass by typing the URL | proxy gates the subtree; each page's service authorizes independently |
| Session / role / permission spoofing | no client-side or `localStorage` authorization; capabilities come from DB membership each request |
| Stale session | the cookie is the session; a cleared/expired cookie fails the proxy and the layout |
| Tenant isolation | `listDashboardOrders(scope, { organizerId: otherTenant })` → `ORGANIZER_ACCESS_DENIED`, 404-shaped so it does not confirm existence |
| Host-header injection | **not** used — the origin is never rebuilt from `Host` / `x-forwarded-host` |
| Admin-only backdoor (`role === "ADMIN"`) | none in the gate; a platform ADMIN still needs an explicit grant |

Introduced no client-only authorization, no `localStorage` authorization, no hardcoded password, no
role bypass, no permission query parameter.

## 12. Tests

Command: `npx jest --runInBand`

```
Test Suites: 45 passed, 45 total
Tests:       1035 passed, 1035 total
```

Of which `__tests__/auth-flow`: **2 suites, 52 tests passed** — 41 pure redirect/guard tests +
11 DB-backed access tests.

| Required | Where | Result |
|---|---|---|
| TEST 1 anonymous → `/dashboard` → `/login` | proxy assertions + **live curl** | PASS |
| TEST 2 valid organizer login → `/dashboard` | `dashboard-access.integration.test.ts` (DB) | PASS |
| TEST 3 valid platform login → `/dashboard` | same | PASS |
| TEST 4 authenticated customer → denied | same (`canEnterDashboard=false`) | PASS |
| TEST 5 `callbackUrl=/dashboard/events` honoured | `post-login-redirect.test.ts` | PASS |
| TEST 6 malicious callback → no external redirect | same, full matrix | PASS |
| TEST 7 logout → `/dashboard` requires login | proxy + shell `signOut` assertions | PASS |
| TEST 8 organizer A opening organizer B → refused | `dashboard-access.integration.test.ts` + `authz/tenant-isolation.integration.test.ts` (Case B) | PASS |

Regression surface untouched and still green: inventory/quota, reservation, publish, public
catalog, orders, customers, payments, iPaymu, QRIS/VA, webhook, PIC, API authorization.

### Live runtime verification (production build)

```
/dashboard             302 → /login?callbackUrl=%2Fdashboard
/dashboard/events      302 → /login?callbackUrl=%2Fdashboard%2Fevents
/dashboard/orders      302 → /login?callbackUrl=%2Fdashboard%2Forders
/dashboard/customers   302 → /login?callbackUrl=%2Fdashboard%2Fcustomers
/dashboard/payments    302 → /login?callbackUrl=%2Fdashboard%2Fpayments
/dashboard/pic         302 → /login?callbackUrl=%2Fdashboard%2Fpic
/dashboard/reports     302 → /login?callbackUrl=%2Fdashboard%2Freports
/dashboard/settings    302 → /login?callbackUrl=%2Fdashboard%2Fsettings
/dashboard/venues      302 → /login?callbackUrl=%2Fdashboard%2Fvenues

query smuggling         302 → callbackUrl=%2Fdashboard%2Fevents   (evil value ignored)
/api/organizer/events   401 Unauthorized
/organizer/events       307 → /dashboard/events
/  ·  /login  ·  /events   200
```

## 13. TypeScript

**PASS** — `npx tsc --noEmit` produced no output.

## 14. ESLint

**PASS (no new problems)** — `npx eslint .` → 45 problems (27 errors, 18 warnings), **identical to
the pre-existing baseline**. Every one is in a pre-existing file (`require()` style imports and
unused vars in older test files). ESLint on the files this task touches reported a single
**pre-existing** warning — the Google logo `<img>` in `LoginForm.tsx`, which the diff does not
touch.

## 15. Production Build

**PASS** — `npm run build`, exit 0, `✓ Compiled successfully`, all pages generated. The build was
then *served* (`npm run start`) to produce the runtime table in §12, rather than trusting that a
successful compile implies correct redirects.

## 16. Remaining Issues

1. **The login redirect's origin comes from `AUTH_URL`, and that is not negotiable.** `next-auth`
   overwrites `req.url` with `AUTH_URL` (`node_modules/next-auth/lib/env.js` — *"If `AUTH_URL` is
   defined, override the request's URL"*), so `new URL("/login", req.url)` carries the *configured*
   origin. Measured: with `.env` minting `AUTH_URL=http://localhost:3000`, a build served on `:3100`
   answered anonymous `/dashboard` with `location: http://localhost:3000/login?...`. Re-pointing
   `AUTH_URL` at the serving origin changed the target to that origin exactly. Two "fixes" were
   tried and rejected on evidence:
   * a **relative** `Location` → Next.js parses that header with `new URL()`, so it throws
     `ERR_INVALID_URL` and every gated page answers **500** instead of redirecting (reproduced
     against a real build);
   * rebuilding the origin from `Host` / `x-forwarded-host` → swaps a config coupling for
     host-header-injection redirects.
   So this is a **deployment config requirement**, not a code defect.
2. **Logout / bfcache** — verified server-side: after `signOut`, `/dashboard` redirects to login
   because no session reaches the proxy and no cached response satisfies it. The browser
   *back/forward cache* showing a stale shell briefly was **not** tested; it would render no data,
   since every figure is fetched server-side under a fresh authorization decision.
3. **`forceExit: true` in Jest** — `lib/rate-limit.ts` leaves a module-scope `setInterval`
   un-`unref()`ed, so workers hang at shutdown. Pre-existing; affects shutdown only, never results.
4. **No password-reset flow.** The dead "Lupa Password?" link was removed rather than pointed at
   an invented route. A reset flow is a feature, not a link.

## 17. Manual Steps

1. **Set `AUTH_URL` to the deployment's real public origin.** This is the one item that can
   misdirect logins (§16.1). `.env.example` documents `AUTH_SECRET` but **not** `AUTH_URL`;
   adding it there would prevent the next deployment from inheriting a dev origin.
2. Have at least one account with a back-office capability before testing, otherwise `/dashboard`
   correctly shows the denial panel — that is not a bug.
3. Payment gateway credentials/webhook (iPaymu) remain a separate, still-unverified external
   requirement from the previous task; nothing here changes it.

## 18. Git Status

**Not clean** — as expected, and **nothing was committed or pushed**.

* This task: 6 modified files, 3 added (`lib/auth/redirect.ts`, `__tests__/auth-flow/`).
* Still uncommitted from the earlier cleanup/consolidation work: the retail deletion
  (387 files in `git diff --stat`, mostly deletions), plus untracked `app/dashboard/`,
  `lib/dashboard/`, `components/dashboard/DashboardAppShell.tsx`, `lib/pic/`,
  `components/ticketing/PaymentInstruction.tsx`, report markdown files.

Ready for your review.
