# PHASE 24 — AUTH UX, SESSION EXPIRY, CLIENT 401 HANDLING & SECURITY HEADERS HARDENING

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Scope:** audit first, then the smallest correct change per defect. Local development only.
**Stance:** no deployment · no commit · no push · no database reset · no `prisma db push` · no
`prisma migrate reset` · no destructive migration · no deleted business data · no production
credential change · no production payment call · no change to payment settlement or webhook
authority.

---

## 1. EXECUTIVE SUMMARY

Four workstreams were requested. Three of them turned out to be **one mechanism short of
correct**, and one was a **missing file configuration** rather than a design problem. Nothing in
the authorization architecture was replaced, and no second authentication system was introduced.

| # | Workstream | Finding | Change |
|---|---|---|---|
| A | Server-side gating for `/login` and `/register` | Both pages were pure client components; the "already signed in?" decision ran in a `useEffect` in each form, so a signed-in visitor was served the full form and moved a frame later | Both pages now resolve the session **on the server** through the existing `getAuthzScope()` and redirect before any HTML is sent. The decision is a new **pure** helper (`decideSessionGate`) reusing `postLoginDestination` / `intentForPlatformRole`. The client checks remain as a documented fallback. |
| B | Client 401 handling | A 401 rendered the server's message **beside the button** in the same visual slot where a payment refusal appears ("Silakan login terlebih dahulu.") — with no way forward and an easy read of "my payment was refused" | All four action buttons now classify 401 as a **session state**, not a business failure, and send the visitor to `/login?callbackUrl=<current page>` so one sign-in puts them back on the same order. |
| C | Global error boundary verification | `app/global-error.tsx` existed but had **never been proven to render** | Rendered for real (react-dom/server), in a tree with no App Router context — which is the state it actually runs in. It renders a complete `<html lang="id">` document, shows only the safe Indonesian message and `digest`, and leaks nothing. `next/link` was verified safe there, so no architecture change was needed. |
| D | Security response headers | `next.config.ts` carried **no `headers()` function at all**, which is why `m3-hsts`, `m4-csp` and `csp-development-unsafe-eval` were the 34 pre-existing failures | Policy restored **from an audit of what this application actually loads** (not copied from the deleted retail config). The three failing suites now pass, plus a new suite pinning the parts they do not cover. The one remote third-party asset on the auth pages (the Google logo) was replaced with inline SVG rather than widening `img-src`. |

**Test result:** 1562 / 1528 passed / **34 failed** → 1677 / **1677 passed / 0 failed**.
The 34 pre-existing failures are resolved; **115 tests were added** across 4 new suites, and the
two things that were *not* verifiable here are named in §15 rather than glossed.

---

## 2. AUDIT FINDINGS

### 2.1 Authentication and authorization (unchanged by this phase)
One Auth.js v5 credentials + Google system (`auth.ts`), `session.strategy = "jwt"`, one
centralized permission map (`lib/authz/permissions.ts`), and authority re-read from the database
per request by `lib/authz/scope.ts` (`resolveAuthzScope`). `proxy.ts` is authentication-only by
decision D-49, which is correct — it runs in the Edge runtime where Prisma is unavailable, so it
cannot answer "may this actor touch this organizer?".

`getAuthzScope()` is the one call that answers *both* "is there a session?" and "does that user
still exist?" — it returns `null` for a valid cookie whose `User` row is gone, exactly like the
guards. That property is what made workstream A safe to implement on top of it (see §4).

### 2.2 What the auth pages were doing
`app/login/page.tsx` and `app/register/page.tsx` were thin **server** wrappers around client
forms whose first `useEffect` called `getSession()` and then navigated. So:
* the server-rendered HTML always contained the form (correctly — a JS-less client can sign in);
* but a signed-in visitor was shown the form and redirected a frame later, which is the "flash"
  the brief names.

### 2.3 How the client buttons handled a 401
All four controls (`PayNowButton`, `CancelOrderButton`, `RequestRefundButton`,
`IssueTicketsButton`) had exactly one failure branch:

```ts
if (!response.ok) { setError(payload?.message ?? "<business-flavoured default>"); }
```

A 401 therefore rendered `"Silakan login terlebih dahulu."` as an inline error. For
`PayNowButton` that message sits directly under "Bayar sekarang", in the same red panel that a
refused payment uses. `PayNowButton` additionally called `router.refresh()` on that path,
re-rendering a page whose session no longer resolves.

### 2.4 The 401 producer
`proxy.ts` returned `{ success: false, message: "Silakan login terlebih dahulu." }` — **no
`code`**, despite `lib/api/response.ts` stating the client contract as "branch on `code`, never
on `message`". Handler-level 401s (`lib/api/errors.ts`) do carry `UNAUTHORIZED`.

### 2.5 Security headers
`next.config.ts` contained only `poweredByHeader` and `allowedDevOrigins`. There was **no
`headers()` export**, so no CSP, no HSTS and no framing protection on any response. The retail-era
configuration (recoverable from `git show 8628dbf^:next.config.ts`) had a policy that named
`analytics.tiktok.com`, `unpkg.com`, `*.tile.openstreetmap.org` and
`down-id.img.susercontent.com` — all four belong to components that no longer exist.

**Actual external resources of the current application (audited by search, not assumed):**

| Kind | Origin | Why |
|---|---|---|
| image | `https://my.ipaymu.com`, `https://sandbox.ipaymu.com` | The gateway serves the QRIS code as a PNG (`lib/ticketing/payment/gateway.ts` maps `QrImage`). That bitmap **is** the payment instrument and cannot be re-encoded locally. |
| image | *(previously)* `www.svgrepo.com` | The Google logo on both auth buttons. **Removed** — see §7.2. |
| image | `'self'` + `data:` | Event banners/photos are same-origin `/api/uploads/events/...` (`lib/images/process.ts`); no `blob:`/`createObjectURL` exists anywhere in the tree. |
| script | none | No analytics pixel, no map bundle, no `next/script` with a `src`. Only Next.js chunks + the inline theme bootstrap in `app/layout.tsx`. |
| font | none | `app/globals.css` pins a system sans stack; no `@font-face`, no font CDN import. |
| connect | `'self'` | Every browser `fetch` targets this origin's own API routes. The gateway is called **server-side**. |
| frame | none | No `<iframe>`, no `<object>`. Google sign-in is a redirect, not an embed. |
| form-action | `'self'` | Verified against `node_modules/next-auth/react.js`: `signIn` performs a same-origin `fetch` to `/api/auth/signin/google` and then `window.location.href = data.url`. It is a navigation, not a cross-origin form post, so `form-action 'self'` does not interfere. |
| geolocation / camera / mic | unused | The venue map is an outbound `<a>`; no component calls `navigator.geolocation` or `mediaDevices`. |

---

## 3. FILES CHANGED

> **Repository context (important for reading any diff):** nothing from the previous phases was
> ever committed, so `git status` shows the accumulated work of Phases 21–23 as well. The list
> below is this phase's footprint only, and every claim about it is backed by the verification in
> §10–§13.

### 3.1 New files

| File | Why it exists | Security impact | Proving tests |
|---|---|---|---|
| `lib/auth/session-gate.ts` | The pure decision "should this visitor see the auth form, or be sent to their own surface?" + `readCallbackUrlParam` for server `searchParams` normalisation | No new authority: the role comes from the resolved scope, never from the request. Prevents the `/login ↔ /dashboard` redirect loop for a deleted-account cookie | `__tests__/auth-flow/session-gate.test.ts` |
| `lib/auth/client-session.ts` | Turns a 401 into a return-preserving login redirect, from the browser | The return path is validated by the **same** `loginUrlFor` the server pages use; only a same-origin path can ever be produced; `/login` ↔ `/register` are rejected as loop paths; no server-only import (asserted) | `__tests__/auth-flow/client-session-expiry.test.ts` |
| `components/auth/GoogleMark.tsx` | The inline four-colour Google mark for both auth buttons | Removes a third-party asset host from the two most sensitive pages and lets `img-src` stay closed to everything but the payment gateway | `__tests__/security/phase24-headers.test.ts` §5 |
| `__tests__/auth-flow/session-gate.test.ts` | 34 tests: decision per role, hostile callbacks, wiring, real-DB deleted-user case | — | itself |
| `__tests__/auth-flow/client-session-expiry.test.ts` | 27 tests: what counts as an expiry, the return path, the navigation, wiring order, no-payment-claim | — | itself |
| `__tests__/errors/global-error-render.test.ts` | 14 tests: the global boundary renders standalone and leaks nothing | — | itself |
| `__tests__/security/phase24-headers.test.ts` | 40 tests: environment-aware HSTS/eval, bounded allow-listing, both framing halves | — | itself |

### 3.2 Modified files

| File | The change | Why |
|---|---|---|
| `app/login/page.tsx` | Async server component: `readCallbackUrlParam(await searchParams) → decideSessionGate(await getAuthzScope(), callbackUrl) → redirect()` **before** `return <LoginForm />`; `export const dynamic = "force-dynamic"` | Kills the flash; the callback is preserved and validated on the server |
| `app/register/page.tsx` | Same gate | Same behaviour on the second auth page, as the brief requires |
| `components/auth/LoginForm.tsx` | Remote `<img>` → `<GoogleMark />`; doc block now states the server gate is primary and this check is the fallback | No third-party origin on the sign-in page; the reasoning survives the next editor |
| `components/auth/RegisterForm.tsx` | Same two edits | Same |
| `components/orders/PayNowButton.tsx` | 401 branch (before the error branch) → `redirectToLoginForExpiredSession()` + `return` | A session that ended can no longer be shown as a payment failure, and the 401 path no longer calls `router.refresh()` |
| `components/orders/CancelOrderButton.tsx` | Same branch | A 401 can no longer be shown as "cancellation failed" |
| `components/orders/RequestRefundButton.tsx` | Same branch | A 401 can no longer be shown as "refund refused" |
| `components/tickets/IssueTicketsButton.tsx` | Same branch | A 401 can no longer be shown as "issuance failed"; the retry after signing in is safe because issuance is idempotent |
| `proxy.ts` | Added `code: "UNAUTHORIZED"` to the 401 JSON body | The live 401 now carries the code the client contract says to branch on; `message` is retained for clients that only read it |
| `next.config.ts` | `headers()` global rule: CSP, HSTS (non-dev), `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-XSS-Protection`, `Permissions-Policy` | Restores the policy from an audited resource list (§7) |

### 3.3 Deliberately NOT changed
`auth.ts`, `lib/authz/**`, `lib/auth/redirect.ts`, `lib/auth/roles.ts`, `lib/ticketing/**`,
`lib/payment/**`, all payment routes and webhook handlers, `lib/db`/schema/migrations, and every
error-boundary file. `lib/csrf.ts` was left alone too — `requireSession`/`requireAdminSession`
return a 401 without a `code`, but they are unreferenced anywhere in the tree (§15).

---

## 4. SERVER-SIDE SESSION GATING

### 4.1 The decision, as a pure function

```ts
export function decideSessionGate(
    visitor: AuthenticatedVisitor | null | undefined,   // the RESOLVED scope, or null
    callbackUrl: string | null | undefined              // raw, untrusted
): SessionGateDecision
```

* `visitor === null` → `{ action: "render-form" }`
* `visitor` present → `{ action: "redirect", to: postLoginDestination(callbackUrl, { intentDefault: intentForPlatformRole(visitor.platformRole) }) }`

A discriminated union rather than `string | null`, so "render the form" is visibly a *decision*,
not a missing value.

### 4.2 Why `null` must render the form instead of redirecting — the loop that was avoided
`visitor` is the value of `getAuthzScope()`, which is `null` in two different situations:
anonymous, **and a signature-valid JWT whose `User` row has been deleted** (fail-closed in the
guards). If the gate used `if (session?.user)` instead, a deleted account's cookie would be
redirected to `/dashboard`, whose layout resolves the same scope, finds `null`, and redirects
back to `/login` — a browser-level redirect loop for the visitor who most needs the form. The
rule is therefore "a scope exists → redirect; no scope → render", and it is pinned twice: as a
pure test, and against the real database (`resolveAuthzScope("<deleted-id>") === null`).

### 4.3 Role destinations (from the existing intent table, not re-derived)
| Role | `/login` and `/register` redirect to |
|---|---|
| ADMIN | `/dashboard` |
| MANAGER | `/dashboard` |
| PIC | `/dashboard/pic` |
| CUSTOMER (and `platformRole = null`) | `/ticketing/tickets` |

Each destination gates itself server-side, so the gate can only move a browser — it cannot widen
what that browser may see. A MANAGER who is redirected to `/dashboard` and holds no capability
still meets `AccessDeniedPanel` there, which is the intended, honest outcome.

### 4.4 The callback is honoured, and only when it is safe
`/login?callbackUrl=/ticketing/orders/EVT-1789839425778-fec07c44` for a signed-in visitor
returns them to that exact order. `https://evil.example`, `//evil.example`,
`javascript:alert(1)`, `/\evil.example`, a CRLF-smuggled value, `/login` and `/register` all fall
back to the role's own destination. This is `resolveSafeCallbackUrl`, the same validator the
proxy and the login form already use — no second implementation.

### 4.5 What was intentionally kept
The forms keep their `getSession()` checks. The server gate cannot cover a session created
*after* its HTML was delivered (a second tab signing in, or a soft navigation reusing an earlier
payload), and both paths run through the same pure helpers, so they cannot disagree. Removing
them would also have invalidated the existing assertions in `__tests__/auth-flow/role-intent.test.ts`
and `post-login-redirect.test.ts` that require the form to resolve its destination through the
shared helper.

---

## 5. CLIENT 401 HANDLING

### 5.1 Classification
`isSessionExpired(status, payload)` is true **only** for `401` or the explicit
`UNAUTHORIZED` code. A `403` is an authorization decision, `404` a missing resource, `409` a
business state, `402` a payment requirement, `429` a throttle and `5xx` a system fault — none of
them is "you need to sign in", and treating any of them as one would hide a real refusal behind a
login screen. All of those are asserted as `false`.

### 5.2 The return path
`loginUrlForCurrentPage({ pathname, search })` → `loginUrlFor(pathname + search)` →
`/login?callbackUrl=%2Fticketing%2Forders%2FEVT-1`. It is built from
`window.location.pathname` + `search` — never `window.location.href` and never a query parameter
— and then validated, so the only possible output is `/login?callbackUrl=<a path on this site>`.
`/login` and `/register` degrade to a bare `/login` rather than looping.

### 5.3 The navigation
`window.location.assign(...)` — a document load, not `router.replace`. The session cookie changed
on the server, so a soft navigation would re-use the router cache and the in-memory React tree of
a page rendered for the previous session. It also stops queued client work on a page that can no
longer act.

### 5.4 Wiring, per component
The expiry branch is placed **before** the generic `if (!response.ok)` branch, sends the visitor
to sign in, and returns in a block that contains no `setError(`, no `setResult(`, no
`router.refresh(` and — for `PayNowButton` — no `paymentUrl`, no `window.location.href = url` and
no success wording. All four components are asserted for that shape, and the assertion is written
as *"the expiry branch is a distinct, earlier block"* so a future reordering fails the suite.

---

## 6. GLOBAL ERROR BOUNDARY VERIFICATION

The static guards in `__tests__/errors/error-boundaries.test.ts` already proved existence,
placement, the client directive and the `<html>`/`<body>`/stylesheet import. What was missing was
proof that the component **can render**: a boundary that throws while rendering the error is a
blank page, and the happy path never touches it. The new suite (`global-error-render.test.ts`)
renders it with `react-dom/server`, with the CSS import stubbed and **no App Router provider in
the tree** — the real situation, since the layout that would have provided that context is what
failed:

* ships a complete document: output begins `<html`, contains `lang="id"`, `<body`, `</html>`;
* renders with no router context: nothing reaches for `useRouter`/`usePathname`/a provider (it
  would throw);
* shows `Terjadi masalah`, `Data Anda tetap aman`, `Coba lagi`, `Kembali ke beranda`;
* shows `Kode referensi: req_9f2c41` from the real `digest`, and renders **no** reference line at
  all when React withholds the digest (never the string `undefined`);
* renders **none** of: `SELECT * FROM`, `api_key`, `sk_live_LEAKED`,
  `PrismaClientKnownRequestError`, `.next/server`, `/srv/app`, `stack`, `process.env`,
  `AUTH_SECRET` — for all four boundaries;
* offers only same-origin `href`s;
* keeps `data-dashboard-shell` on the dashboard boundary so the marketing footer stays suppressed.

**On `next/link`:** the shared `ErrorState` renders its actions with `next/link`, and it was
verified to render correctly outside the router (the suite renders that exact path). The brief
permits plain `<a>` for `global-error` only if `next/link` is unsafe — it is not, so the shared
boundary architecture was left as one implementation for all four boundaries.

---

## 7. CSP DESIGN AND THE ACTUAL ALLOWED RESOURCES

### 7.1 The policy (production / test)
```
default-src 'self';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data: https://my.ipaymu.com https://sandbox.ipaymu.com;
font-src 'self';
connect-src 'self';
frame-src 'none';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```
Development adds exactly one token: `'unsafe-eval'` in `script-src` (React 19's dev build evals
to reconstruct callstacks). It is computed **inside** `headers()`, so it reflects the environment
the server was actually started in — verified live in §12.

Every origin above is justified in §2.5 from a code search, and the negative assertion is
enforced: across the *entire* policy there are exactly two third-party origins, both the payment
gateway's image hosts. `script-src`, `style-src`, `font-src` and `connect-src` name no third-party
origin at all.

`'unsafe-inline'` is a genuine constraint rather than an oversight: the theme bootstrap in
`app/layout.tsx` is an inline script and Next.js injects styles inline. Moving to a nonce-based
`script-src` is a real improvement and a real piece of work (a per-request nonce from the proxy
plus changes to the bootstrap); it is listed in §15 rather than smuggled into this phase.

### 7.2 Removing the third-party image origin instead of allow-listing it
The login and register buttons rendered `<img src="https://www.svgrepo.com/show/...">`. The
correct fix was **not** `img-src ... https://www.svgrepo.com`, because the frozen header contract
allows exactly two third-party image origins (the payment ones) and because a login page should
not depend on an asset host this product does not control for a decorative mark: it reports the
visitor's IP and referrer to a third party before sign-in, it can be blocked or re-hosted, and a
broken-image glyph on a sign-in button is a trust failure. Both call sites now render
`<GoogleMark />` — inline SVG, no request, no layout shift, no third-party origin.

### 7.3 Why the header set is global
`source: "/(.*)"` covers every response, including authenticated and dynamic ones. This was a
real defect in the retail-era config, where the header block was `/api`-only: the surfaces that
execute in a browser (login, checkout, the order page) were exactly the unprotected ones. Both the
file and the runtime value are asserted, and the live check in §12 shows the policy on an
anonymous page **and** on an authenticated, `force-dynamic` order page.

---

## 8. HSTS DECISION

* Sent in production and in the test environment: `max-age=31536000; includeSubDomains`.
* **Not** sent in development: the dev server speaks plain HTTP, where a one-year "always use
  HTTPS for this host" instruction is meaningless noise that outlives the dev server. Verified
  live in §12.
* `preload` is deliberately **not** enabled. Submission to a browser-vendor preload list is
  effectively permanent and obliges every current and future subdomain to serve HTTPS; that is a
  deployment owner's decision, not a default this repository should bake in.
* This satisfies both the brief ("do not set HSTS in development HTTP") and the pre-existing test
  contract (which asserts the header under `NODE_ENV=test`) without weakening either.

---

## 9. OTHER SECURITY HEADERS

| Header | Value | Reasoning |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Stops MIME sniffing on uploads served from `/api/uploads/events/...`. |
| `X-Frame-Options` + CSP `frame-ancestors` | `DENY` / `'none'` | Both halves, for old and new browsers. Nothing is designed to be embedded (the venue map is an outbound link). Stops clickjacking of sign-in and payment screens. |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Paths here are sensitive (`/ticketing/orders/EVT-...`); send the origin, never the path. |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | All three capabilities are unused (audited). Clipboard is left alone deliberately — it is not gated by this policy, and both call sites copy a value the user is already looking at. |
| `X-XSS-Protection` | `1; mode=block` | Deprecated and inert in modern browsers, but the frozen contract asserts it; retained as belt-and-braces. |
| `poweredByHeader: false` | — | Removes `X-Powered-By`, which advertises the framework version. |

---

## 10. TEST RESULTS BEFORE / AFTER

| | Before this phase (Phase 23 baseline) | After |
|---|---|---|
| Suites | 76 | 77 |
| Tests total | 1562 | **1677** |
| Passed | 1528 | **1677** |
| Failed | **34** | **0** |
| Failing suites | `security/m4-csp`, `security/m3-hsts`, `security/csp-development-unsafe-eval` | none |

* `__tests__/security` — **75 tests / 5 suites, all passing** (was 35 tests / 34 failing).
* New this phase — **115 tests / 4 suites, all passing**:
  `session-gate` (34), `client-session-expiry` (27), `global-error-render` (14),
  `phase24-headers` (40).
* The +115 delta is exactly the four new suites; no existing test was deleted, skipped,
  weakened, or given a softened expectation. The three previously failing suites were made to
  pass by supplying the missing configuration, not by editing their assertions.

---

## 11. FULL REGRESSION

| Check | Result |
|---|---|
| `npx prisma validate` | ✅ schema valid |
| `npx prisma migrate status` | ✅ 23 migrations, "Database schema is up to date!" |
| `npx tsc --noEmit` | ✅ clean, no output |
| `npx eslint .` | ✅ **0 errors**, 3 warnings (all pre-existing `@next/next/no-img-element` — down from 5, because the two remote Google `<img>`s are gone) |
| `npm test -- --runInBand` | ✅ **77 suites / 1677 tests / 0 failures / 56 s** |
| `npm run build` | ✅ succeeded; `/login` and `/register` now correctly listed as dynamic (`ƒ`) |

Targeted suites re-run explicitly and green: `auth-flow/*` (5 suites incl. the 2 new), `errors/*`
(4 suites incl. the new render suite), `security/*` (5 suites), `authz/*`, the ticketing
checkout/order-ownership suites, the payment method contract and the payment integration suites.

---

## 12. LIVE HTTP VERIFICATION

Production build (`npm run build` → `next start`), against the **local development database**,
using sessions minted from the real `AUTH_SECRET` for two existing accounts:
`reksa@gmail.com` (`platformRole = ADMIN` **and** the owner of the reported order,
`/ticketing/orders/EVT-1789839425778-fec07c44`) and `asep123@gmail.com` (`platformRole = null`,
i.e. CUSTOMER).

### Anonymous
| Request | Result |
|---|---|
| `GET /login` | **200** |
| `GET /register` | **200** |
| `GET /dashboard` | **302** → `/login?callbackUrl=%2Fdashboard` |
| `GET /ticketing/tickets` | **302** → `/login?callbackUrl=%2Fticketing%2Ftickets` |
| `GET /login?callbackUrl=/dashboard/events` | **200** (form rendered; nothing to redirect) |
| `GET /api/ticketing/tickets` | **401** `{"success":false,"code":"UNAUTHORIZED","message":"Silakan login terlebih dahulu."}` |

### Authenticated ADMIN
| Request | Result |
|---|---|
| `GET /login` | **307** → `/dashboard` |
| `GET /register` | **307** → `/dashboard` |
| `GET /login?callbackUrl=<the exact order>` | **307** → `/ticketing/orders/EVT-1789839425778-fec07c44` (preserved exactly) |
| `GET /login?callbackUrl=https://evil.example` | **307** → `/dashboard` (hostile value rejected) |
| `GET /login?callbackUrl=/login` | **307** → `/dashboard` (loop path rejected) |
| `GET /dashboard` | **200** |
| `GET /ticketing/orders/EVT-1789839425778-fec07c44` | **200** — the Phase 23A order still resolves for its owner |
| `GET /ticketing/orders/EVT-UNKNOWN` | **404** |

### Authenticated CUSTOMER
| Request | Result |
|---|---|
| `GET /login` | **307** → `/ticketing/tickets` |
| `GET /register` | **307** → `/ticketing/tickets` |
| `GET /login?callbackUrl=<the exact order>` | **307** → that path (preserved) |
| `GET /dashboard` | **200**, body contains `Akses dashboard ditolak` (AccessDeniedPanel) |
| `GET /ticketing/orders/EVT-1789839425778-fec07c44` (another buyer's order) | **404** — the privacy contract is intact |
| `GET /ticketing/tickets` | **200** |

### Response headers (production build)
Present on the anonymous `/login` **and** on the authenticated, dynamic order page:
```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
X-XSS-Protection: 1; mode=block
Permissions-Policy: camera=(), microphone=(), geolocation=()
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://my.ipaymu.com https://sandbox.ipaymu.com; font-src 'self'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
```
No `X-Powered-By` header is present. No secret was printed while collecting these.

### Development build (`npm run dev`)
Server booted clean (no errors in the log) and served `/login` **200** with:
* `Content-Security-Policy: … script-src 'self' 'unsafe-inline' 'unsafe-eval'; …` — the dev-only
  allowance, present;
* **no** `Strict-Transport-Security` — the documented omission, present;
* `X-Frame-Options` and `Permissions-Policy` unchanged.

---

## 13. PAYMENT SAFETY VERIFICATION

* `lib/payment/**` and `lib/ticketing/payment/**` contain **no** reference to anything this phase
  added (`isSessionExpired`, `client-session`, `session-gate`, `securityHeaders`, the CSP) —
  verified by search.
* No webhook handler, settlement path, amount verification, status transition, ticket-issuance
  rule or refund-settlement rule was edited; `git diff --stat lib/payment lib/ticketing/payment`
  shows only the **pre-existing, uncommitted Phase 22 work** (`ipaymu.ts`, `gateway.ts`,
  `method-catalog.ts`, `validation.ts`) that was already in the tree before this session began.
  Those diffs contain nothing from this phase.
* The one payment-adjacent edit is presentational and fail-safe: `PayNowButton` now returns early
  on a 401 **before** any error or success handling, so a session that ended can no longer produce
  a payment-flavoured message, and it no longer triggers `router.refresh()` on that path.
* No provider call was made. No production iPaymu credential was used or read. No payment was
  created, settled, marked paid or refunded. No order or payment row was written, updated or
  deleted by this phase.
* Redirect success still means nothing: `paymentStatus` continues to come from the verified
  webhook, and nothing added here reads a query parameter to decide payment state.

---

## 14. SECURITY IMPLICATIONS

**Strengthened**
* Every response now carries CSP, framing protection, `nosniff`, a referrer policy and a
  permissions policy — including the authenticated and dynamic surfaces the retail-era config
  left unguarded.
* `script-src` allows no third-party origin, and the CSP is free of `unsafe-eval` outside
  development. The `img-src` allow-list is bounded to exactly the two payment hosts, asserted.
* The two auth pages no longer load a third-party asset, and no longer render for an
  authenticated visitor at all — removing a form that could only confuse its audience.
* The live 401 now carries a machine-readable `code`, so a session expiry cannot be conflated
  with a business refusal by any client.
* A buyer whose session expires now lands back on the exact page they were on, which removes the
  "abandon the purchase" outcome that the previous inline error produced.

**Unchanged (deliberately)**
* No client-selected role can influence identity or the post-login destination: the role comes
  from `resolveAuthzScope` on the server, and the login selector is never transmitted.
* Public registration still always creates a CUSTOMER.
* Tenant isolation, own-resource ownership and the Phase 23A order fix are untouched; the live
  run re-proves 200 for the owner and 404 for another buyer.
* Payment settlement authority, webhook verification and ticket issuance authority are untouched.
* The auth pages remain `noindex`; no new route was added to the public proxy lists.

**New surface, and why it is not a hole** — `lib/auth/client-session.ts` builds a URL that the
browser then navigates to. It is the only place this phase lets client-derived data reach a
redirect target, so it is constrained three ways: the value is built from `pathname` + `search`
only, it is passed through the same validator the server uses, and the resulting URL can only ever
be `/login?callbackUrl=<internal path>`. `https://evil.example`, `//evil.example` and
`javascript:alert(1)` are asserted to degrade to `/login`.

---

## 15. REMAINING ISSUES

1. **MANAGER and PIC live gating was not exercised over HTTP.** The local database contains
   exactly one account with a `platformRole` (the ADMIN). Creating accounts to satisfy a test
   would have meant writing rows, which this phase forbids, so those two destinations are proven
   by the pure decision tests (`decideSessionGate` per role) plus the fact that both destination
   pages gate themselves. ADMIN and CUSTOMER were verified end to end.
2. **No browser-level verification.** There is no browser automation in this repository. The
   headers were verified from the wire, and the dev server was verified to boot and serve with
   its policy, but "the dev CSP allows every HMR feature React 19 actually uses" was **not**
   observed in a browser console. The policy matches what the pre-existing dev-CSP test requires;
   a manual console check during the next `npm run dev` session is still advisable.
3. **`'unsafe-inline'` remains in `script-src`.** Required by the inline theme bootstrap and
   Next's inline injection. A nonce-based policy is the stronger end state and needs a per-request
   nonce plus a change to that bootstrap — a scoped piece of work, not a config tweak.
4. **An authenticated visitor can no longer reach the sign-in form by navigating to `/login`.**
   This is the requested behaviour, and its consequence is that switching accounts requires
   signing out first. `RegisterForm`'s "Keluar dari akun ini" panel survives only as the
   client-side fallback path; sign-out remains available in the site and dashboard shells.
5. **`lib/csrf.ts`'s `requireSession` / `requireAdminSession` still return a 401 body without a
   `code`.** They are unreferenced anywhere in the tree (the proxy and the guards are the live
   401 paths), so they were left alone rather than edited as dead code. If they are ever wired up,
   they should be brought onto the envelope.
6. **The security contract's `X-XSS-Protection` and the two payment image origins are inherited
   constraints.** Both are asserted by suites that predate this phase; changing either is a
   product decision (drop the legacy header; move the QRIS bitmap to a same-origin proxy).
7. **`tsconfig.tsbuildinfo` is tracked and modified** by repeated typechecks — pre-existing
   repository hygiene, unrelated to this phase.

---

## 16. RECOMMENDED NEXT PHASE

1. **Nonce-based CSP** — remove `'unsafe-inline'` from `script-src` by issuing a per-request
   nonce (the proxy is the natural place) and threading it to the inline theme bootstrap. Verify
   with a browser console and the existing CSP suites updated deliberately.
2. **A dev-environment browser smoke check** covering HMR, the Google OAuth redirect and a
   QRIS-direct payment instrument, so the CSP's dev allowance is evidence rather than inference.
3. **Multi-role live fixtures** — a seeded, resettable set of one ADMIN / MANAGER / PIC / CUSTOMER
   account in the *test* database so the four-role routing matrix can be verified over HTTP
   without ever writing to development data.
4. **A `code` on every error path** — finish the envelope by giving the remaining hand-built 401s
   (`lib/csrf.ts`) the same `code`, and add a static guard that every JSON error response carries
   one.
5. **HSTS decision record** — capture the `preload`/subdomain decision per environment in the
   deployment documentation, since it is the one security header whose value depends on
   infrastructure rather than code.

---

## FINAL CHECKLIST (as required)

| Item | Result |
|---|---|
| Prisma validate | ✅ valid |
| Prisma migration status | ✅ 23 migrations, up to date |
| Prisma migrations created | **none** |
| TypeScript (`tsc --noEmit`) | ✅ clean |
| ESLint | ✅ 0 errors, 3 pre-existing warnings |
| Targeted tests (`auth-flow`, `errors`, `security`) | ✅ all green |
| Full tests | ✅ **1677 / 1677 passed, 0 failed** (was 1528 / 1562 with 34 failures) |
| Build | ✅ succeeded |
| Live HTTP | ✅ verified (see §12) |
| Security headers | ✅ present on anonymous and authenticated responses; HSTS production/test only; `unsafe-eval` development only |
| New failures introduced | **none** |
| Database data changed | **no** — no row created, updated or deleted; no fixture written; no reset, no `db push`, no destructive migration |
| Payment semantics changed | **no** — no payment/settlement/webhook/issuance/refund file edited; no provider call; no production credential used |
| Deployment / commit / push | **none performed** |

**Cannot be verified in this environment:** the live four-role redirect matrix for MANAGER and PIC
(no such accounts exist locally — §15.1), and browser-console behaviour of the development CSP and
HMR (§15.2). Both are named rather than assumed.
