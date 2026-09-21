# PHASE — MULTI-ROLE AUTHENTICATION, AUTHORIZATION HARDENING, MODERN AUTH UI & GLOBAL ERROR HANDLING

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Stance:** audit first, then the smallest correct changes. No deployment, no commit, no push, no database reset, no destructive migration, no production credential touched.

---

## 1. EXECUTIVE SUMMARY

The authentication and authorization **architecture was already sound** and was NOT rebuilt. Identity comes from Auth.js v5 credentials (bcrypt, cost 12, with a real timing-equalisation hash), authority comes from `lib/authz` resolved from the database on every request, and tenant/ownership checks are enforced in the service layer. There is exactly one login system and exactly one authorization system.

What was wrong was (a) the **login/registration experience** and (b) **error handling everywhere**.

Three findings drove the work:

1. **The role selector did not exist, and the safest way to add one is to make it inert.** Four people land on one login page and each should recognise their own entrance. The selector is UI intent only: it is never transmitted, and the destination after sign-in is derived from the role the **server** reports, falling back to the chosen entrance only when the session cannot be read. Escalation is therefore not "prevented by a check" — there is no field to submit.
2. **A real, silent bug: session-gated pages returned the buyer to the wrong page.** `app/ticketing/orders/[orderNumber]/page.tsx` (and the wallet, e-ticket and refunds pages) redirected anonymous visitors to `/login?next=<path>`, but the login form (and `proxy.ts`) read `callbackUrl`. Every interrupted buyer was dumped on `/dashboard` after signing in, losing the exact page they were trying to open. One helper (`loginUrlFor`) now builds all four.
3. **Every failure was rendered as a 404.** `getOwnOrder(...).catch(() => null)` followed by `notFound()` reported a database outage, a timeout and a missing order identically; `.catch(() => null)` on the wallet and refunds lists rendered **empty states over outages**; the public event page told visitors an event did not exist whenever the catalog read failed. This is the generalisation of the Phase 23A defect, and it is now fixed at the classification layer (`lib/errors/`) with a retryable UI for outages and a genuine 404 only for genuine absence.

The UI work is a genuine redesign (one `AuthShell`, a real radio-group role selector, an accessible password field with a visibility toggle, inline safe errors, a `noindex` login/register page, and the removal of a **dead "Ingat Saya" checkbox**), and the error work adds the first `error.tsx`/`global-error.tsx`/`not-found.tsx` this application has ever had.

**Verification:** `prisma validate` ✅ · `migrate status` up to date (23 migrations) ✅ · `tsc --noEmit` clean ✅ · `eslint` 0 errors ✅ · `npm run build` ✅ · full suite **1562 tests, 1528 passed, 34 failed — the 34 are exactly the three pre-existing `__tests__/security/*` CSP/HSTS suites (BASELINE), 0 new failures**, +109 net passing tests versus the Phase 23A baseline (1419 passing / 34 failing). Live HTTP verification against a production build is recorded in §24.

---

## 2. EXISTING AUTHENTICATION ARCHITECTURE

Audited before any change; nothing here was replaced.

| Concern | Where | Contract |
| --- | --- | --- |
| Auth.js config | `auth.ts` | JWT session strategy, `PrismaAdapter`, credentials + Google |
| Password verification | `lib/password.ts` | `bcryptjs`, cost 12 |
| User enumeration defence | `auth.ts` | Real cost-12 `TIMING_EQUALISATION_HASH` compared even when no user exists (Phase 3 measured this, replacing a malformed non-bcrypt string that returned instantly) |
| Login rate limiting | `lib/rate-limit.ts` + `auth.ts` | 5 attempts / 15 min per bucket; a throttle is indistinguishable from bad credentials |
| Session typing | `types/next-auth.d.ts` | Augments `next-auth` **and** `@auth/core/jwt` (the second is load-bearing — see the file's own notes) |
| Post-login destination | `lib/auth/redirect.ts` | Pure `resolveSafeCallbackUrl` / `postLoginDestination`; open-redirect proof |
| Authentication gate (coarse) | `proxy.ts` | Edge auth-only by decision D-49; public/protected prefix allow-lists; a classification test fails if an `/api` route is unlisted |
| Authorization | `lib/authz/{permissions,scope,guards,errors}.ts` | Static role→permission maps + database membership/grants, throwing guards, fail-closed |
| Tenant isolation | `lib/authz/permissions.ts` | `ORGANIZER_SPANNING_PLATFORM_ROLES` is **empty**: no role reaches a tenant without an ACTIVE `OrganizerMember` row |
| Session expiry during use | page-level `getAuthzScope()` → `redirect(loginUrlFor(path))` | Fixed this phase (§9) |
| Public registration | `app/api/auth/register/route.ts` | Creates a `User`; hardened this phase (§5) |

**Two orthogonal role dimensions, deliberately not merged:**

* `User.role` — the LEGACY retail enum (`ADMIN|SELLER|CUSTOMER|AFFILIATOR`), dormant. Nothing in ticketing reads it.
* `User.platformRole` — the ticketing dimension (`ADMIN|MANAGER|PIC|CUSTOMER`), nullable. This is the only authority.

`lib/authz/scope.ts` documents why deriving a platform role from the legacy column would be a hidden privilege grant; there is no such bridge, and a test now pins that (`__tests__/auth-flow/role-intent.test.ts`).

---

## 3. AUTHENTICATION FLOW

```
credentials (identifier + password)
   ↓
rate limit (IP bucket; throttle == bad credentials to the caller)
   ↓
prisma.user.findFirst({ OR: [ { email }, { phone } ] })
   ↓
constant-time bcrypt verify (dummy hash when the user is absent or OAuth-only)
   ↓
JWT: token.id = user.id ; token.role = user.role
   ↓
jwt callback refreshes token.platformRole from the DATABASE when the cached copy is older
than AUTHZ_SCOPE_TTL_MS (60 s — approved D-48)
   ↓
session callback mirrors id / role / platformRole
   ↓
lib/authz re-resolves memberships + grants from the DATABASE on every request
   ↓
ALLOW / DENY
```

The token's role mirror is for cheap routing/UI gating only. The guards are strictly tighter than the 60-second bound because they re-read authority per request, so a revocation takes effect immediately.

---

## 4. FOUR-ROLE LOGIN BEHAVIOUR

One endpoint, four entrances.

| Role | How they log in | Entrance chip | Lands on (absent a callback) |
| --- | --- | --- | --- |
| ADMIN | `POST /api/auth/callback/credentials` via `signIn("credentials", …)` — one shared form | Admin | `/dashboard` |
| MANAGER | identical | Manajer | `/dashboard` |
| PIC | identical | PIC | `/dashboard/pic` |
| CUSTOMER | identical | Pembeli | `/ticketing/tickets` |

* **The selector is never sent.** `LoginForm` calls `signIn("credentials", { identifier, password, redirect: false })` — three keys, no role in any spelling. A test asserts the call's exact arguments.
* **The destination comes from the server's role.** After sign-in the form reads the session and uses `intentForPlatformRole(session.user.platformRole)`, falling back to the clicked entrance only if the session could not be read. A customer who clicks "Admin" is routed to `/ticketing/tickets`.
* **A mismatch is disclosed only to the account's owner**, in one neutral sentence naming their own role ("Anda masuk sebagai Pembeli."). It confirms or denies nothing about any other account.
* **Every destination gates itself**, so the intent can only ever move a browser: `/dashboard` runs `canEnterDashboard` (capability-based, not role-name-based) and renders `AccessDeniedPanel` for an account with no back-office authority; `/dashboard/pic` and `/ticketing/tickets` re-authorise in their services.
* ADMIN and MANAGER are treated as one shared entrance and are not reported as a mismatch when they click each other's chip — pedantry, not protection.
* `null` `platformRole` resolves to CUSTOMER in **both** the login screen and `resolveAuthzScope`, so the notice can never contradict the guards.

---

## 5. REGISTRATION BEHAVIOUR

Public registration creates a **CUSTOMER**. Enforced structurally, in four independent layers:

1. `registerSchema` is a plain Zod object → unknown keys are **stripped**, so `platformRole`, `role`, `permissions`, `organizerId`, `tenantId`, `isAdmin`, `roles`, `memberships`, `grants` never reach the handler.
2. The row is built from an explicit allow-list: `name`, `email`, `phone`, `password` — nothing is spread from the request body.
3. `platformRole: "CUSTOMER"` and `role: "CUSTOMER"` are set **by the route**, so authority is not inherited from a column default that a future migration could change.
4. A request carrying a privilege-shaped key is logged **by key name only** (never a value) and then ignored. Ignoring rather than rejecting is deliberate: a 400 would let a caller enumerate which key names are special, and there is nothing to gain by telling them.

`__tests__/auth-flow/register-customer-only.test.ts` asserts the **arguments handed to `prisma.user.create`** — not merely the HTTP status, which would pass just as happily on a route that stored `platformRole: "ADMIN"`.

Fields: name (required), email (optional), phone (optional) — one of email/phone required — password + confirmation, with the existing password policy preserved (`min 8`, upper, lower, digit) and bcrypt cost 12 untouched. Duplicate email/phone is reported as a conflict rather than a silent success (there is no mailer, so a "check your email" white lie would leave the visitor waiting forever); the enumeration trade-off is documented at the route, and the login path itself remains uniform.

**Not implemented, deliberately:** any administrative onboarding UI. Back-office access is still granted by an auditable operation against `User.platformRole` (e.g. `prisma/seed-organizer.ts` for the first admin). The brief forbids inventing privileges, and a self-service role picker is exactly that.

---

## 6. SESSION / JWT BEHAVIOUR

* Identity (`token.id`) and the legacy role come from the verified credential's database row.
* `token.platformRole` is refreshed from the database whenever the cached copy is older than 60 s (D-48). `undefined` (a pre-Phase-3 token) is always stale.
* The client cannot mutate any claim: the JWT is signed and encrypted with `AUTH_SECRET`, and no code path reads a role from a header, body, query or cookie.
* **A session that names a deleted user has no authority.** `resolveAuthzScope` returns `null` for an unknown id, `getAuthzScope` maps that to `null`, `requireAuth` throws `UNAUTHORIZED`, and a page redirects to login. Verified live: a correctly-signed, unexpired token for a non-existent user returned **307 → /login** for `/dashboard` and `/ticketing/tickets` (§24).
* `types/next-auth.d.ts` is complete (no `as any`); `__tests__/authz/session-typing.test.ts` was already pinning it and still passes.

---

## 7. AUTHORIZATION ARCHITECTURE

```
AUTHENTICATION → trusted identity
      ↓
trusted platformRole (User.platformRole, database)
      ↓
permission resolution (static maps + explicit grants)
      ↓
tenant / organizer membership (ACTIVE OrganizerMember required)
      ↓
resource ownership (ownerUserId === scope.userId)
      ↓
ALLOW / DENY   (guards THROW; nothing returns a boolean a caller can forget)
```

`lib/authz/permissions.ts` is pure (no DB, no NextAuth, no `next/server`) so every rule is unit-testable. `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty, which is the whole tenant-isolation guarantee. `AuthzError` mapping is preserved end-to-end: `ORGANIZER_ACCESS_DENIED → 404` (a cross-tenant denial must not confirm existence), and `toAppError` deliberately **preserves** that status instead of re-deriving 403 from the registry.

No role check was introduced anywhere. There is no new `if (user.role === "ADMIN")` in this phase.

---

## 8. PERMISSION MATRIX (derived from the actual maps, not from the brief's example)

| Role | Login | `/dashboard` entry | Own orders (`order.read.own`) | Own cancel (`order.cancel.own`) | Own payments | Own tickets (`ticket.read.own` / `ticket.issue.own`) | Own refund (`refund.request.own`) | Tenant (`OrganizerMember` + capability) | Platform (`sport.manage`, `user.manage`, `role.manage`, `platform.config`, `audit_log.read`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ADMIN | yes | yes (capabilities) | yes | yes | yes | yes / yes | yes | needs membership | yes; **financial permissions are grant-required (D-19)** |
| MANAGER | yes | yes (capabilities) | yes | yes | yes | yes / yes | yes | needs membership | only `audit_log.read` |
| PIC | yes | yes **iff** an ACTIVE membership exists | yes | **no** (deliberate — destructive) | yes | yes / yes | yes | membership capability only (`pic_attribution.read.all` via `PIC` membership) | none |
| CUSTOMER | yes | **no** → `AccessDeniedPanel` | yes | yes | yes | yes / yes | yes | none | none |
| FINANCE (membership role, not a platform role) | n/a | via membership | no | no | no | no | — | financial/bookkeeping capability, no event publishing | none |

**Documented conflicts with the brief's example table (resolved in favour of the existing permission architecture, as instructed):**

1. **PIC has no `order.cancel.own`.** The brief's table suggests PIC own-scope access "according to authz". The existing map withholds cancellation from PIC on purpose (destructive and irreversible) while granting ticket issuance for an order the PIC has already paid for (completing a purchase). Nothing was changed; the divergence is documented in `lib/authz/permissions.ts` at the map itself.
2. **`OrganizerMemberRole.FINANCE` exists as a membership role** and is not a platform role. The brief's four roles are the platform set; FINANCE was not promoted, invented, or removed.
3. **`Role.AFFILIATOR` is dormant**, a leftover of the deleted retail affiliate programme on a dormant column. It was left alone — nothing reads or writes it, and removing it is a migration the brief forbids without cause.
4. **`OrganizerMemberRole.ADMIN` is deliberately unmapped** (D-05, single organizer at launch): a membership row carrying it resolves to zero capability rather than an invented tier.

Phase 23A's own-scope grant to ADMIN/MANAGER is **intact** — re-verified live (§24) rather than merely assumed.

---

## 9. TENANT ISOLATION & OWN-RESOURCE VERIFICATION

* Tenant isolation unchanged and re-verified by the existing suites (`__tests__/authz/tenant-isolation.integration.test.ts` passes): without an ACTIVE membership no role — including ADMIN and MANAGER — reaches a tenant, and the denial is a 404 so existence is not confirmed.
* Own-resource access is identity-gated (`scope.userId === ownerUserId`) before the capability map is consulted, so granting own-scope permissions to a platform role confers nothing over another user's records.
* Live re-verification of the Phase 23A fix and of the privacy contract (§24):
  * `ADMIN` (buyer `reksa@gmail.com`) → `GET /ticketing/orders/EVT-1789839425778-fec07c44` **200**, `GET /api/ticketing/orders/<same>` **200**.
  * `CUSTOMER` (`asep123@gmail.com`) → the same order page **404** and the same API **404**; the 404 document contains **no order data at all** (checked for `buyerName` / `buyerEmail` / `buyerPhone` / `subtotal` / `total` / the buyer's name: zero occurrences; the only page-content strings are the route's static metadata title and the requested path).
  * `CUSTOMER` → `/dashboard` **200** rendering `AccessDeniedPanel` ("Akses dashboard ditolak") — the denial UX, not a blank shell and not a redirect loop.
  * Unknown order (authenticated) → **404**.

---

## 10. LOGIN UI CHANGES

`app/login/page.tsx` is now a thin server wrapper with `noindex` metadata; the layout lives in components.

New components:

* `components/auth/AuthShell.tsx` — the shared frame (background, centred `max-w-md` column, one card elevation, consistent exit link, footer slot). Server component.
* `components/auth/RoleSelector.tsx` — a real **radio group** (`role="radiogroup"` + `role="radio"`, roving tabindex, arrow/Home/End keys, `aria-checked`) rendered as segmented buttons, with an `aria-live` caption. Chips are `type="button"`, so pressing one can never submit the form.
* `components/auth/PasswordField.tsx` — accessible toggle (`aria-label`, `aria-pressed`, `aria-controls`, `type="button"`), `aria-invalid` + `aria-describedby` wiring, controlled **and** react-hook-form-registered modes; never transforms the value.
* `components/auth/AuthError.tsx` — the uniform, non-dismissable authentication failure alert (see §23).

Improvements over the previous form: the form is now **server-rendered** (previously the only thing in the login page's HTML was a "Memeriksa sesi login…" spinner, so the page had no fields at all without JavaScript — verified fixed live), labels are associated, focus states are explicit, inputs disable during submit, and the Google button keeps its existing behaviour.

**Removed:** the "Ingat Saya" checkbox, which rendered, was clickable and was read by nothing (`session.maxAge` is unset, so every session is already 30 days — a control that promised a choice it did not have). "Lupa Password?" was already absent because `/forgot-password` has never existed; not re-added.

---

## 11. REGISTRATION UI CHANGES

`app/register/page.tsx` is a thin server wrapper with `noindex` metadata. `components/auth/RegisterForm.tsx` was rebuilt on `AuthShell` + `PasswordField`, with:

* the same three outcomes handled distinctly: per-field schema errors under their field, server refusals as one `AuthError` carrying the API's own safe Indonesian sentence, and unexpected failures as a generic retry sentence (never a raw error);
* validation on **blur**, not per keystroke (`mode: "onBlur"`);
* the "already signed in" panel preserved (with a working sign-out);
* Google sign-up now lands on the buyer surface instead of the homepage.

The previous version registered its password inputs with react-hook-form while rendering *different*, controlled visuals — a hidden mirror input pattern. The shared field now takes RHF's real `register()` props, so one control is both visible and authoritative.

---

## 12. ERROR TAXONOMY

Reused, extended additively — no competing error system.

**New registry codes** (all in `ERROR_CODES`, statuses unchanged from the design's own conventions):

| Code | Status | Indonesian message | Why it is needed |
| --- | --- | --- | --- |
| `DATABASE_UNAVAILABLE` | 503 | "Data sedang tidak dapat dimuat. Silakan coba lagi." | A database that cannot be reached must be distinguishable from `INTERNAL_ERROR` so a page can offer a retry |
| `SERVICE_UNAVAILABLE` | 503 | "Terjadi gangguan sementara. Silakan coba lagi." | A dead dependency (socket refused, DNS failure) |
| `REQUEST_TIMEOUT` | 504 | "Permintaan memakan waktu terlalu lama. Silakan coba lagi." | A deadline; the outcome is UNKNOWN, so it must not be reported as failure |

No code was invented for a case an existing code already covers (`UNAUTHORIZED` = authentication required, `VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `INTERNAL_ERROR` all remain).

**Classification layer** (new, pure):

* `lib/errors/infrastructure.ts` — recognises Prisma `P1000/P1001/P1002/P1008/P1017/P2021/P2022/P2024`, `PrismaClientRustPanicError`, `PrismaClientInitializationError`, deadline errors and driver/undici network text, and returns a fault kind plus a **sanitised** detail (`"prisma P1001"`, `"network fault (econnrefused)"`) — never the driver message, which can carry the host, the user name or the statement.
  * Ordering is load-bearing and now pinned by test: timeout codes are checked **before** connection-lost, because `P1002` is both and "timed out" points an operator at load rather than at a dead host.
  * `P2002` / `P2025` are deliberately **not** classified as outages (a unique violation is our data talking), and `PrismaClientValidationError` is a bug in our query, not an outage.
* `lib/errors/classify.ts` — `classifyError()` → `{ category, code, status, message, retryable }` and `resolvePageFailure()` → `"not-found" | "sign-in" | "denied" | "unavailable" | "error"`. It derives everything through the SAME `toAppError` the API uses, so the JSON a client receives and the page outcome for the same failure cannot disagree.

---

## 13. GLOBAL ERROR BOUNDARIES

Previously the application had **no** `error.tsx`, no `global-error.tsx` and no `not-found.tsx` — every unexpected failure produced Next.js's default screen and every `notFound()` produced its black-and-white 404.

| File | Boundary | Purpose |
| --- | --- | --- |
| `app/global-error.tsx` | root layout | Last resort. Ships its own `<html lang="id">`, `<body>` and the stylesheet, because Next.js replaces the whole document here |
| `app/error.tsx` | below the root layout | Unexpected render failures on public/discovery routes |
| `app/ticketing/error.tsx` | `/ticketing/**` | Buyer-specific copy; explicitly states the order's state is unchanged and nothing can settle a payment |
| `app/dashboard/error.tsx` | `/dashboard/**` | Back-office-specific copy, and it carries the dashboard shell marker so the marketing footer stays suppressed |
| `app/not-found.tsx` | 404 | Indonesian, calm, and offers the two destinations that resolve for everybody (catalog, home) |

All four boundaries delegate to one component, so an incident cannot look like four different products. Route-level boundaries are used sparingly — only where the copy or the blast radius genuinely differs.

---

## 14. ROUTE-LEVEL ERROR HANDLING (the false-404 removal)

| Surface | Before | After |
| --- | --- | --- |
| `/ticketing/orders/[orderNumber]` | `getOwnOrder(...).catch(() => null)` → `notFound()` — every failure was a 404 | Classified: `not-found` → 404; foreign/denied → 404 (the page's documented privacy contract); `sign-in` → `loginUrlFor`; `unavailable` → in-page retry state; anything else re-thrown to the boundary |
| `/ticketing/tickets/[ticketCode]` | same pattern | same treatment (privacy contract preserved) |
| `/ticketing/tickets` (wallet) | `.catch(() => null)` → an **empty wallet** during an outage | `denied` → empty wallet (fail-closed, documented); `unavailable` → retry state; else re-thrown |
| `/ticketing/refunds` | `.catch(() => null)` → an empty list during an outage | same split |
| `/e/[slug]` (public) | `.catch(() => null)` → "event does not exist" during an outage; related-events failure silently swallowed | genuine absence → 404; anything else propagates to the boundary; the related-events failure is logged and the band omitted (a decorative supplement does not take down a rendered page) |

A test asserts, statically, that none of those files still contains `.catch(() => null)` and that each contains the classification branches.

---

## 15. API ERROR HANDLING

`lib/api/response.ts` reuses the existing envelope `{ success, code, message, details?, correlationId? }`.

* Infrastructure faults are logged as their **classified detail only** — never the raw error, which for a driver failure can embed the connection string or the statement, and this log line is what an operator pastes into a ticket. Application bugs ARE dumped, because the stack is the entire diagnosis there.
* `correlationId` is now issued for every **server-side fault** (`INTERNAL_ERROR`, `DATABASE_UNAVAILABLE`, `SERVICE_UNAVAILABLE`, `REQUEST_TIMEOUT`, `PROVIDER_UNAVAILABLE`) and not for a refusal — a 403 is not broken and its code already says why.
* Clients branch on `code`; `message` is curated Indonesian. Tests assert that the Prisma message, the SQL, the host and the error name never appear in the body.

---

## 16. DATABASE / INFRASTRUCTURE ERROR HANDLING

A read that fails is a `503 DATABASE_UNAVAILABLE` and a retryable page state; a mutation that fails reaches the error boundary with "Perubahan belum berhasil disimpan" wording available through the same taxonomy. Nothing is rendered as "not found" and nothing is rendered as an empty list. The driver text stays in the server log, keyed by correlation id.

---

## 17. PAYMENT ERROR HANDLING

**Payment semantics were not touched.** No change to webhook signature verification, settlement authority, amount verification, issuance authority, ownership, D-28/D-46/D-61, buyer-triggered issuance, or the webhook-only PAID transition. No file under `lib/ticketing/payment/**` was modified in this phase.

What was added is a `payment` variant of the retryable state whose copy is deliberately explicit: *"Pesanan Anda belum dianggap lunas"* — a provider failure can never be rendered as a success, and a page timer can never make an order paid (a test asserts the component contains no "berhasil dibayar" / "lunas." claim).

---

## 18. SESSION EXPIRATION HANDLING

Handled by a **destination-preserving redirect**, not by a dedicated screen. A request whose session no longer resolves redirects to `/login?callbackUrl=<the page they were on>`; after one sign-in the user is exactly where they were. This is strictly better than a panel that costs a second click to reach the same place, and it is what the brief permits ("if architecture does not already provide them").

*The bug this phase fixed* is that those four pages built `?next=` instead of `?callbackUrl=`, so the redirect landed on `/dashboard` — the value was silently dropped. `loginUrlFor()` is now the single producer of that URL, and it validates the path with the same `resolveSafeCallbackUrl` used for untrusted input, so a page cannot interpolate an attacker-influenced path. Both properties are asserted (`__tests__/errors/error-boundaries.test.ts` §5).

A dedicated `SessionExpiredState` component was written and then **removed**: nothing in the architecture needed it, and an unwired component is dead code. The reasoning is recorded in the boundary test file where the guarantee is asserted instead.

---

## 19. DASHBOARD ERROR HANDLING

`app/dashboard/error.tsx` keeps a failed dashboard inside the dashboard's own visual language and offers a retry. Per-widget isolation is unchanged: the expensive panels (overview, PIC fees, reports) already catch their own failures, so one unavailable number cannot blank the overview. `AccessDeniedPanel` remains the denial surface for every dashboard page.

No dashboard page or widget was rewritten in this phase; the audit found their existing `EmptyBlock` / `ErrorBlock` / `LoadingBlock` distinction already correct.

---

## 20. TICKETING ERROR HANDLING

Classification implemented per the brief: sold out / expired / already checked in / refund rejected remain **business states** (409-class, mapped to `USER` and rendered as the page's own UX); a payment timeout is a transient service error; a database failure is a system error; a foreign order is a 404 by privacy contract; unauthenticated is a redirect to login; unauthorized is the denial surface. See §14 for the exact table.

---

## 21. ERROR LOGGING

Reused the existing server-side logging; no SaaS, no new infrastructure.

* Server: the API envelope logs `[api] CODE correlationId=… fault=…` for server faults, and the full cause only for application bugs. Registration logs ignored privilege-shaped **key names** only.
* Browser: the error boundary logs the message plus React's `digest` (the only identifier React passes to a client boundary in production) and renders that digest as the reference code the user can quote to support.
* Never logged, anywhere: password, password hash, `AUTH_SECRET`, API keys, payment signature, raw JWT, session token, `Authorization` header, request bodies, or buyer PII.

---

## 22. SECURITY / ERROR LEAKAGE AUDIT

Asserted by test across every boundary and error component: no `.stack`, no `PrismaClient`, no `process.env`, no `AUTH_SECRET`, no rendered `{error.message}`. Asserted on the API side: the driver message, SQL, host and error name never appear in a response body. Verified on the wire: the 404 returned for another buyer's order contains **zero** order fields.

---

## 23. SECURITY TESTS

| Area | Suite | What it pins |
| --- | --- | --- |
| Role escalation via login | `__tests__/auth-flow/role-intent.test.ts` | The credentials call carries `identifier`, `password`, `redirect` and **no role in any spelling**; the server reads only identifier/password from `credentials`; the vocabulary is exactly the four platform roles and does not resurrect `SELLER`/`AFFILIATOR` |
| Registration escalation | `__tests__/auth-flow/register-customer-only.test.ts` | For each of `ADMIN`/`MANAGER`/`PIC` and for ten privilege-shaped keys, the row handed to `prisma.user.create` is `platformRole: "CUSTOMER"`; the create payload has exactly six keys; the attempt is logged by name and never by value; the schema strips unknown keys |
| Session trust | `__tests__/authz/session-trust.integration.test.ts` | A deleted user's valid session resolves to `null` (guards return `UNAUTHORIZED`); the D-48 bound is exactly 60 s; a pre-Phase-3 token is always stale |
| Error taxonomy | `__tests__/errors/error-classification.test.ts` | Authentication / authorization / not-found / business-state / infrastructure / unexpected are classified correctly; **an outage is never "not found"**; `P2002`/`P2025`/`PrismaClientValidationError` are not mislabelled as outages; `AuthzError` statuses are preserved |
| API envelope | `__tests__/errors/api-error-envelope.test.ts` | Statuses (401/403/404/409/503/504/500), correlation-id policy, and that nothing internal leaks into a body or a log line |
| Boundaries & wiring | `__tests__/errors/error-boundaries.test.ts` | Every boundary exists in the right place as a client component; `global-error` ships its own document; one fallback implementation; no page converts a failure into a 404; no page builds `?next=` |
| Route classification, tenant isolation, ownership, session typing, dashboard access, post-login redirect, register route | pre-existing suites | All still pass, unchanged |

---

## 24. REGRESSION / LIVE VERIFICATION

Automated (`npm test`): **1562 tests, 1528 passed, 34 failed**, 73 suites. The 34 failures are exactly `__tests__/security/m4-csp.test.ts`, `__tests__/security/csp-development-unsafe-eval.test.ts`, `__tests__/security/m3-hsts.test.ts` — the BASELINE failures already recorded in Phase 22 §16.1 and unchanged by this phase. **0 new failures. +109 net passing tests** versus the Phase 23A baseline (1419 passing / 34 failing / 1433 total), of which 193 are the new auth/error suites.

Live HTTP verification against a **production build** (`npm run start`, port 3000), with real minted sessions and the real development database (read-only; nothing written):

```
anonymous   GET  /login                                  -> 200  (form SSR-rendered:
        "Masuk ke akun Anda", ">Admin<", ">Manajer<", ">PIC<", ">Pembeli<",
        role="radiogroup", "Email / Nomor HP", "Password", "Lanjutkan dengan Google")
anonymous   GET  /register                               -> 200  ("Buat akun pembeli",
        "Nama lengkap", "Konfirmasi password", "Daftar dengan Google", no role field)
anonymous   GET  /dashboard                              -> 302  location /login?callbackUrl=%2Fdashboard
anonymous   GET  /ticketing/tickets                      -> 302  location /login?callbackUrl=%2Fticketing%2Ftickets
anonymous   GET  /this-page-does-not-exist               -> 404  (app/not-found.tsx copy)
anonymous   GET  /api/ticketing/orders/X                 -> 401

ADMIN       GET  /dashboard                              -> 200
ADMIN       GET  /ticketing/tickets                      -> 200
ADMIN       GET  /ticketing/orders/EVT-1789839425778-fec07c44 -> 200  (order page renders;
                                                                     Phase 23A intact)
ADMIN       GET  /api/ticketing/orders/EVT-1789839425778-fec07c44 -> 200
ADMIN       GET  /api/ticketing/orders/EVT-0000000000000-00000000 -> 404

CUSTOMER    GET  /dashboard                              -> 200  AccessDeniedPanel rendered
CUSTOMER    GET  /ticketing/tickets                      -> 200
CUSTOMER    GET  /ticketing/orders/EVT-1789839425778-fec07c44 -> 404  (no order data present)
CUSTOMER    GET  /api/ticketing/orders/EVT-1789839425778-fec07c44 -> 404
CUSTOMER2   GET  /ticketing/tickets                      -> 200

GHOST       GET  /dashboard                              -> 307  (signed token, deleted user:
GHOST       GET  /ticketing/tickets                      -> 307   fail-closed)
```

The database rows inspected (read-only) confirm the fixtures: buyer `reksa@gmail.com`, `platformRole = ADMIN`, order `EVT-1789839425778-fec07c44` `PENDING_PAYMENT / UNPAID`.

---

## 25. TYPESCRIPT RESULT

`npx tsc --noEmit` → **no output (clean)**.

## 26. ESLINT RESULT

`npx eslint .` → **0 errors**, 5 warnings, all of the same pre-existing class (`@next/next/no-img-element` on the Google mark and two event-page images, which predate this phase). One warning the phase introduced (an unused import in `lib/errors/classify.ts`) was found and fixed.

## 27. BUILD RESULT

`npm run build` → **success**, all 34 routes compiled and the proxy built.

## 28. PRISMA RESULT

`npx prisma validate` → valid. `npx prisma migrate status` → **23 migrations, "Database schema is up to date!"**. No migration was created, and none was needed: every change in this phase is application code plus one additive `jest.config.js` namespace.

## 29. FULL TEST RESULT / BASELINE / NEW FAILURES

* Total 1562 · passed 1528 · failed 34 · suites 73 (3 failed).
* **BASELINE failures (pre-existing, not caused by this phase):** `__tests__/security/m4-csp.test.ts`, `__tests__/security/csp-development-unsafe-eval.test.ts`, `__tests__/security/m3-hsts.test.ts` — the CSP/HSTS header suites documented in Phase 22 §16.1, same count (34) as the Phase 23A baseline.
* **NEW failures: 0.**

---

## 30. FILES CHANGED

**Created — error handling**

* `lib/errors/infrastructure.ts` — pure Prisma/driver/deadline fault detection
* `lib/errors/classify.ts` — `classifyError` / `resolvePageFailure`
* `components/errors/ErrorState.tsx`, `RetryButton.tsx`, `ReloadButton.tsx`, `InlineError.tsx`, `ErrorBoundaryFallback.tsx`, `ServiceUnavailableState.tsx`
* `app/error.tsx`, `app/global-error.tsx`, `app/not-found.tsx`, `app/dashboard/error.tsx`, `app/ticketing/error.tsx`

**Created — authentication**

* `lib/auth/roles.ts` — the pure role-intent vocabulary (never transmitted)
* `components/auth/AuthShell.tsx`, `RoleSelector.tsx`, `PasswordField.tsx`, `AuthError.tsx`

**Created — tests**

* `__tests__/errors/error-classification.test.ts`, `api-error-envelope.test.ts`, `error-boundaries.test.ts`
* `__tests__/auth-flow/role-intent.test.ts`, `register-customer-only.test.ts`
* `__tests__/authz/session-trust.integration.test.ts`

**Modified**

* `components/auth/LoginForm.tsx` — rebuilt (role selector, SSR form, uniform inline errors, intent-aware destination)
* `components/auth/RegisterForm.tsx` — rebuilt (shared field/shell, real RHF registration, distinct error treatments)
* `app/login/page.tsx`, `app/register/page.tsx` — thin server wrappers with `noindex` metadata
* `app/api/auth/register/route.ts` — explicit `platformRole`/`role: "CUSTOMER"`, privilege-key warning, allow-list create payload
* `lib/api/errors.ts` — three additive codes; infrastructure branch in `toAppError`
* `lib/api/response.ts` — fault-aware logging, correlation id for server faults
* `lib/auth/redirect.ts` — `postLoginDestination(raw, { intentDefault })`, `loginUrlFor()`
* `app/ticketing/orders/[orderNumber]/page.tsx`, `app/ticketing/tickets/[ticketCode]/page.tsx`, `app/ticketing/tickets/page.tsx`, `app/ticketing/refunds/page.tsx` — classification + `loginUrlFor`
* `app/e/[slug]/page.tsx` — outage vs absence; logged related-events failure
* `jest.config.js` — additive `__tests__/errors/*.test.ts` namespace

**Not modified:** `auth.ts`, `proxy.ts`, `lib/authz/**`, `lib/ticketing/**`, `lib/payment/**`, `lib/ticketing/payment/**`, `prisma/schema.prisma`, `prisma/migrations/**`, `types/next-auth.d.ts`, and every dashboard page.

*(The working tree also carries pre-existing uncommitted changes from earlier phases — dashboard theme files, payment modules, `app/layout.tsx`, and several reports — which are untouched by this phase.)*

---

## 31. DATABASE SAFETY — EXPLICIT CONFIRMATIONS

* **The database was NOT reset.** No `prisma migrate reset`, no `prisma db push`, no `TRUNCATE`, no `DROP`.
* **No migration was created or applied.** No schema change was needed.
* **No production/business data was deleted or modified by this phase.** The live verification issued only `SELECT`/`GET`; the automated integration suites ran against the isolated `tinggalklik_test` schema that Phase 22 established, and this phase created no new fixtures.
* **No production deployment, no commit, no push, no `git reset`, no `git clean`.**
* **No production iPaymu credential or configuration was read or changed.** Payment settlement semantics are untouched.

---

## 32. REMAINING ISSUES

1. **CSP/HSTS suites still fail (34 tests, 3 suites)** — the pre-existing baseline, unrelated to authentication. Unchanged and unfixed here.
2. **`LoginForm`/`RegisterForm` are rendered optimistically.** The already-signed-in redirect now happens in the background rather than gating the screen, so a signed-in visitor may see the form for a moment before being forwarded. This was a deliberate trade against a spinner-only server render (no form fields existed in the HTML at all). If the flash matters, the correct fix is a server-side session read in `app/login/page.tsx` and a redirect there — a change worth doing on its own, since it also makes the page fully static-free.
3. **`app/global-error.tsx` uses the shared fallback, which renders `next/link`.** The App Router context should be present there, but this boundary is the hardest one to exercise; a follow-up should force a root-layout throw in a test build once and confirm, or switch the global boundary to plain `<a>` links.
4. **Per-component 401 handling.** Four client action buttons (`CancelOrderButton`, `PayNowButton`, `IssueTicketsButton`, `RequestRefundButton`) show the API's "Silakan login terlebih dahulu." as a toast on a 401 rather than an inline session-expired state with a `callbackUrl`-preserving login link. The server already redirects correctly on the next render, so nothing is broken; this is polish.
5. **No administrative onboarding UI for platform roles.** Still a seed/audited operation. Fine for one organizer (D-05); it becomes a real need before a second tenant or a self-service PIC signup exists.
6. **Duplicate-registration disclosure.** The route reports "Email atau nomor HP sudah digunakan" (400 `CONFLICT`), which is a deliberate trade: there is no mailer, so a silent success would strand the user. If account enumeration matters more than that UX later, the answer is a verification email, not a vaguer message.
7. **`jest.config.js` was extended** with an `__tests__/errors/*.test.ts` namespace. If the project prefers a single flat namespace, these three suites can move to `__tests__/auth-flow/` instead.

## 33. RECOMMENDED NEXT PHASE

**Phase 24 — server-side session read on the auth pages, and 401 handling in the client action buttons.** Both are small, both remove a class of user-visible confusion, and together they close the remaining items in §32 without touching authority. After that, the natural next candidate is the administrative onboarding surface for `User.platformRole` (finding 5), which is the last thing standing between this codebase and a second organizer.

---

# FINAL OUTPUT

## A. AUTHENTICATION

* **ADMIN / MANAGER / PIC / CUSTOMER**: all four log in through **one** form and **one** endpoint (`signIn("credentials", { identifier, password, redirect: false })` + `POST /api/auth/callback/credentials`). Identifier may be an email *or* a phone number. The chip they click changes the copy and (as a fallback only) the destination; the destination is normally derived from the role the **server** returns. Landing surfaces: ADMIN/MANAGER → `/dashboard`, PIC → `/dashboard/pic`, CUSTOMER → `/ticketing/tickets`, each gated server-side.

## B. REGISTRATION

* **Anyone** may register (public, rate-limited 3/hour/IP, same-origin enforced). The resulting account is **always CUSTOMER**: `platformRole: "CUSTOMER"` is set by the route, and privilege-shaped keys are stripped, ignored and logged by name. Back-office roles are only granted by an auditable administrative operation.

## C. AUTHORIZATION

* **Role is trusted** from `User.platformRole` in the database (`resolveAuthzScope`), refreshed into the JWT at most 60 s stale, and re-read by the guards on every request — so a revocation is immediate where it matters. A null role resolves to CUSTOMER in both the login screen and the guards.
* **Permissions** come from the static role→permission maps plus explicit, narrowly-scoped grants (`ADMIN_GRANT_REQUIRED` for financials, D-19). No role check was added anywhere.
* **Tenant isolation**: an ACTIVE `OrganizerMember` row is required; `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty, so no platform role spans tenants. Denials are 404, never 403, so existence is not confirmed.
* **Own-resource access**: `scope.userId === ownerUserId` is checked before the capability map, so own-scope grants confer nothing over another user's records. Phase 23A's ADMIN/MANAGER own-scope fix is re-verified live.

## D. ERROR HANDLING

* **Global boundary**: `app/global-error.tsx` (own document + stylesheet), plus `app/error.tsx`, `app/dashboard/error.tsx`, `app/ticketing/error.tsx`, and a real `app/not-found.tsx`. One shared fallback component; Indonesian copy; a correlation/digest reference; **no** stack, SQL, path or secret.
* **API errors**: the existing envelope, extended with `DATABASE_UNAVAILABLE` (503), `SERVICE_UNAVAILABLE` (503) and `REQUEST_TIMEOUT` (504). Clients branch on `code`; correlation ids are issued for server faults; infrastructure faults are logged as a sanitised classification, never as the raw error.
* **Payment errors**: unchanged semantics; a provider failure renders a state that states the order is **not** paid and cannot be made paid by a refresh.
* **DB errors**: 503 + retry UI. Never a 404, never an empty list.
* **Session expiration**: destination-preserving redirect to `/login?callbackUrl=…` (the `?next=` mismatch that broke this is fixed and tested).
* **Retry**: `RetryButton` (error boundary `reset`) on boundaries and `ReloadButton` (`router.refresh()`) on server pages, so every retryable state has a working retry.

## E. UI

* **Login**: redesigned on a shared `AuthShell`, with a four-chip radio-group role selector, an accessible password field with a visibility toggle, inline uniform authentication errors, one primary action, Google, and a registration link. Server-rendered (verified live), `noindex`, keyboard-navigable with proper focus states. The dead "Ingat Saya" checkbox is gone.
* **Registration**: redesigned on the same shell, customer-only, per-field validation on blur, distinct treatment for field errors / server refusals / unexpected failures, and Google sign-up landing on the buyer surface.

## F. VERIFICATION

* Tests: **1562 total, 1528 passed, 34 failed — all 34 pre-existing `security/*` CSP/HSTS baseline, 0 new**, +109 net passing.
* TypeScript: **clean** (`tsc --noEmit`).
* ESLint: **0 errors**, 5 pre-existing `no-img-element` warnings.
* Build: **success**.
* Prisma: schema valid, 23 migrations, up to date.
* Live HTTP: recorded in §24 (including the exact Phase 23A order number, re-tested with the correct buyer's session).

## G. FILES CHANGED

See §30. 16 files created (11 application, 5 components, 6 test suites), 15 modified. `auth.ts`, `proxy.ts`, `lib/authz/**`, `lib/ticketing/**`, `lib/payment/**`, the Prisma schema and every dashboard page were **not** touched.

## H. REMAINING ISSUES

See §32: the CSP/HSTS baseline; the optimistic (non-blocking) session check on the auth pages; `next/link` inside `global-error.tsx` unverified under a forced root-layout failure; toast-not-panel 401 handling in four client order actions; no administrative role-onboarding UI; the deliberate duplicate-account disclosure; and the additive jest namespace.
