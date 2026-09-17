# TICKETING PHASE 3 — Auth + Organizer + RBAC + Tenant Isolation

**Repository:** `demo-marketplace` · branch `main`
**Baselines read:** `TICKETING_PHASE1_DESIGN.md`, `TICKETING_PHASE2_5_REPORT.md`, `TICKETING_PHASE2_REPORT.md`, `TICKETING_REBUILD_AUDIT.md`
**Date:** 2026-09-16
**Deliverables:** `lib/authz/**` (5 modules), `__tests__/authz/**` (4 suites, 63 tests), `TICKETING_PHASE3_REPORT.md`

---

## 1. Status

```text
PHASE 3 STATUS: PASS WITH WARNINGS
```

**This report supersedes the earlier `BLOCKED` version of this file.** Phase 3 was first stopped at
STEP 2 because decisions D-05 and D-19 were unresolved. Those decisions — and the four other
decisions the design gates on Phase 3 — have since been answered (§3), the gate opened, and the phase
was implemented and verified.

`PASS` because every acceptance criterion in the brief §28 is met and independently checked (§12).
`WITH WARNINGS` because of two operational facts that this phase cannot resolve on its own and will
not paper over: the login limiter's IP bucket is currently degenerate (§14.1), and no user holds a
platform role yet (§14.2).

---

## 2. Executive Summary

Phase 3 built the authentication, tenancy and authorization foundation the ticketing platform needs,
and nothing else. There is no Event CRUD, no ticket CRUD, no checkout, no payment, no PIC fee
calculation and no settlement — all deliberately absent (§13).

**What was implemented**

1. **Typed session (fixes a Phase 0/1 finding).** `types/next-auth.d.ts` declared `role: string` and
   knew nothing about `platformRole`. It now uses the real Prisma `Role` type and adds
   `platformRole: PlatformRole | null`. The subtle part is *which* module to augment: the Auth.js
   convention is `next-auth/jwt`, but in the installed beta that file is only
   `export * from "@auth/core/jwt"`, so augmenting it is silently ignored and token fields stay
   `unknown`. Augmenting `@auth/core/jwt` is what actually works. Both facts are asserted in tests so
   the fix cannot silently revert.
2. **A single authorization module, `lib/authz/`.** Permission vocabulary, capability maps, pure
   decision functions, a database-backed scope resolver, and fail-closed `require*` guards. The
   decision logic imports no database, no NextAuth and no `next/server`, so it is pure and testable.
3. **Tenant isolation as a structural property, not a convention.** Authority comes from an ACTIVE
   `OrganizerMember` row. Passing another organizer's id — from a URL, a query string or a body —
   cannot grant access, because the id is *data* the caller supplies while the membership list is the
   *authority* the guard reads from the database. Cross-tenant denial returns **404, not 403**, so the
   response cannot be used to probe which organizers exist.
4. **D-19 encoded structurally.** `ADMIN` has no financial capability by default; the eight financial
   permissions are absent from its capability map and can only be satisfied by an explicit
   `PermissionGrant`. Because there is no permission string for editing an order amount, altering a
   payment amount or writing a ledger entry, those actions are unreachable for every role — the brief's
   "Admin must not freely change fees / amounts / settlements / the ledger" is enforced by absence, not
   by a conditional someone could edit.
5. **Login rate limiting at the verified earliest point (D-53).** Verified, not assumed: the installed
   `@auth/core` declares `authorize(credentials, request: Request)`, so the original request — and thus
   the client IP — is reachable inside `authorize()`. Implemented there.
6. **A real CSRF origin check (D-56).** The file that documented itself as "CSRF PROTECTION" was in
   fact only checking the session, which is the thing a CSRF attack rides on. It now also does an
   Origin/Referer check, fail-closed, for state-changing methods.
7. **The proxy fail-open gap closed without guessing (D-49 + §15).** Three of 115 API routes were
   unclassified and therefore fell through the proxy unauthenticated. None was a live vulnerability
   (§9), but the mechanism was fragile. All 115 are now explicitly classified, and a test fails if a
   future route is added without classifying it.

**Two defects found and fixed in the auth boundary itself**

* **The anti-enumeration sleep was not sleeping.** The "constant-time response" dummy hash was the
  literal string `"$2a$12$x dummy hash to prevent timing attack"`, which is not a valid bcrypt hash.
  Measured: a real cost-12 comparison takes **~253 ms/op**; the malformed string takes
  **~0.000 ms/op** — about **3.2 million times faster**. The mitigation did nothing, and an attacker
  could distinguish "no such user" from "wrong password" with a stopwatch. Replaced with a real
  cost-12 hash.
* **Dead logic in the Google sign-in path.** The `signIn` callback looked a user up by email and then
  returned `true` on both branches, so the query could not affect the outcome. Removed (one fewer
  round-trip per Google sign-in); behaviour is unchanged.

**Test result:** 63 new tests, all passing, and the full suite is **byte-for-byte identical to
baseline** in its failures — the same 6 suites and the same 2 tests, all pre-existing (§11).

**No database change was needed.** No schema edit, no migration (§10, §16).

---

## 3. Business Decisions

All six decisions the design gates on Phase 3 were confirmed unresolved before implementation
(design §39 preamble: *"Nothing in this register is decided by the design"*), put to the user, and
answered. These answers are the specification this phase implements.

| ID | Question | Answer chosen | Where it is encoded |
| --- | --- | --- | --- |
| **D-05** | Single organizer vs multi-organizer marketplace | **Single organizer at launch.** TinggalKlik.Co is the sole Organizer; PICs are external referrers; no self-onboarding; tenant-level membership `ADMIN` stays collapsed into `OWNER` + platform `ADMIN`. | `lib/authz/permissions.ts` — `MEMBERSHIP_ROLE_PERMISSIONS` has no `ADMIN` entry |
| **D-19** | Manager vs Admin financial boundary | **Grant-required.** Admin holds no financial power by default; the §6.2 `APPROVE` cells need an explicit `PermissionGrant`; Manager prepares/approves/executes settlement and adjusts fees **by role**; nobody edits a ledger entry. | `ADMIN_GRANT_REQUIRED` + the absence of those permissions from `ADMIN`'s maps |
| **D-48** | Scope staleness tolerance | **≤60 s cache with invalidation on revocation.** | `AUTHZ_SCOPE_TTL_MS = 60_000`; `isScopeStale()`; the `jwt` callback refresh |
| **D-49** | Does the proxy enforce platform-role gating? | **Auth-only.** Roles resolved from the database in the service layer. | `proxy.ts` docblock; no role logic added there |
| **D-53** | Login rate-limit integration point | **Inside `authorize()`, at the earliest verified point.** | `auth.ts`, top of the credentials `authorize` |
| **D-56** | Implement a real CSRF origin check, or delete the helper? | **Implement.** | `lib/csrf.ts` → `isSameOrigin()`, `requireSameOrigin()` |

### 3.1 Two judgement calls made explicit

Two things the design left genuinely ambiguous were resolved deliberately and are flagged here so
they can be revisited in one place rather than discovered later.

**(a) §5.3 says a platform MANAGER spans "all tenants"; §6.3 marks the same rows `SCOPED`.** These
cannot both hold. Phase 3 takes the stricter reading — **every organizer-scoped permission requires
an ACTIVE membership, for every role including `ADMIN` and `MANAGER`** — because §7.4 and §16 state
cross-organizer denial as a hard security requirement. The alternative is one line:
`ORGANIZER_SPANNING_PLATFORM_ROLES` in `lib/authz/permissions.ts` is deliberately exported and
deliberately **empty**.

**(b) `PermissionGrant` is confined to the financial permissions.** Design §6.4 says the table exists
"purely to satisfy §6.2's APPROVE (with explicit grant) cells". An early version of this code let a
grant satisfy *any* permission, which would have made it a privilege-escalation primitive — a grant
of `role.manage` for a Manager would have been indistinguishable from a designed capability. Grants
are now consulted **only** for `ADMIN_GRANT_REQUIRED` permissions. A test asserts this.

---

## 4. Auth Changes

### 4.1 `auth.ts` (the only behavioural auth change)

| Change | Detail | Decision |
| --- | --- | --- |
| `authorize(credentials)` → `authorize(credentials, request)` | The second parameter is the original `Request`, **verified** in `node_modules/@auth/core/providers/credentials.d.ts` | D-53 |
| Login rate limit at the top of `authorize()` | `rateLimiters.login(getClientIp(request))`; on denial returns `null` so the caller cannot distinguish "throttled" from "bad credentials" | D-53 |
| Timing-equalisation hash fixed | Malformed string → a real cost-12 bcrypt hash (see §2) | audit S-4 |
| Dead `signIn` lookup removed | Behaviour unchanged; one fewer DB round-trip per Google sign-in | — |
| `jwt`/`session` callbacks de-`any`-ed | `(user as any).id` etc. → typed reads; `platformRole` added to both | §7 |
| Platform-role mirror refresh | `if (isScopeStale(token.authzScopeRefreshedAt))` → re-resolve from DB, stamp `Date.now()` | D-48 |

**Unchanged deliberately:** the Credentials + Google providers, `strategy: "jwt"`,
`allowDangerousEmailAccountLinking: false` (correctly hardened), `pages.signIn`, and the legacy `role`
claim. Retail login behaves exactly as before apart from the new throttle.

### 4.2 What the session does **not** carry

No organizer context and no resolved permission list. Caching tenant authority in the token would
bake in a shape D-05 does not require and is large and unbounded in a cookie. Guards resolve
memberships and grants from the database per call instead.

### 4.3 Rate-limit key — read this before deploying

`getClientIp()` returns the sentinel `"untrusted"` when `TRUSTED_PROXY` is unset. `TRUSTED_PROXY` is
**unset** in `.env` (present only in `.env.example`). With `rateLimiters.login` at 5 attempts / 15
minutes, that means **all clients currently share one bucket** — five failed logins throttle
everyone. This is the project's existing convention (register, voucher, shipping all key the same
way) and is spoof-proof by design, so it was followed rather than quietly replaced with a different
policy. It is the top item in §14.1.

---

## 5. Session Type Changes

### 5.1 Before → after

| Field | Before | After |
| --- | --- | --- |
| `Session.user.id` | `string` | `string` (unchanged) |
| `Session.user.role` | **`string`** | **`Role`** (the real Prisma type) |
| `Session.user.platformRole` | **did not exist** | **`PlatformRole \| null`** |
| `JWT.id` / `JWT.role` | `string` / `string`, never actually applied | `id?: string`, `role?: Role` |
| `JWT.platformRole`, `JWT.authzScopeRefreshedAt` | did not exist | `platformRole?: PlatformRole \| null`, `authzScopeRefreshedAt?: number` |
| `User.role` / `User.platformRole` | absent | added (Auth.js `User` augmentation) |
| `(session.user as any)` sites | **27** | **0** |

### 5.2 Why `Role` and not a hand-rolled union — and why that mattered

The obvious fix, declaring `role` as a TypeScript `enum`, would have been the *wrong* one. Prisma 6
generates enums as **string-literal unions** (`export type Role = (typeof Role)[keyof typeof Role]`),
verified by probe. That distinguishes two outcomes for the ~53 existing sites that compare
`session.user.role !== "ADMIN"`:

* with a real TS `enum` → **TS2367 × ~53**, forcing a rewrite of retail authorization, which the
  brief §14 says to document rather than rewrite;
* with the Prisma union → they keep compiling **and** gain type safety (a typo like `"ADMN"` is now
  a compile error).

Because the union won, this phase could tighten the type *and* delete all 27 `as any` casts with no
change to retail logic.

### 5.3 The augmentation trap (worth knowing)

The first attempt augmented `"next-auth/jwt"`, as Auth.js docs show. The typecheck then reported
`Argument of type 'unknown' is not assignable to parameter of type 'number | undefined'` at
`isScopeStale(token.authzScopeRefreshedAt)`. Cause: `next-auth/jwt.d.ts` is only
`export * from "@auth/core/jwt"`, and the callbacks type their `token` from the **original** interface
in `@auth/core/jwt` (`interface JWT extends Record<string, unknown>`). Augmenting the shim is silently
ignored — a declaration file that looks right and provides no safety. Fixed by augmenting
`@auth/core/jwt`, and `__tests__/authz/session-typing.test.ts` now asserts the specifier **and**
contains compile-time shape assertions that fail the suite if it regresses.

---

## 6. RBAC

### 6.1 Model: two independent dimensions

```
User.platformRole                   ADMIN | MANAGER | PIC | CUSTOMER   (capability across the platform)
OrganizerMember.role                OWNER | MANAGER | FINANCE | CHECKIN_STAFF | PIC
                                    (+ ADMIN present in the schema but deliberately unmapped — D-05)
OrganizerMember.status              must be ACTIVE to authorize anything
Effective access = capability source AND active tenant scope
```

There is no `isAdmin` boolean anywhere. Platform role and tenant membership are never merged.

### 6.2 The approved permission map, as implemented

Concretely, in `lib/authz/permissions.ts`:

| Capability | ADMIN | MANAGER | FINANCE (member) | CHECKIN_STAFF | PIC | CUSTOMER |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| Manage users / roles / platform config / sports / PICs | YES | NO | NO | NO | NO | NO |
| View audit log | YES | YES | YES | NO | NO | NO |
| Create / edit / publish events, venues | YES | YES | NO | NO | NO | NO |
| Ticket type / quota / price | YES | YES | NO | NO | NO | NO |
| View tenant orders & payments | YES | YES | YES | **NO** | NO | NO |
| Cancel unpaid order | YES | YES | NO | NO | NO | NO |
| Request refund | YES | YES | YES | NO | NO | NO |
| **Approve refund** | **grant** | YES | YES | NO | NO | NO |
| Execute refund | **NO** | YES | YES | NO | NO | NO |
| Assign PIC | YES | YES | NO | NO | NO | NO |
| View all PIC attribution / fees | YES | YES | YES | NO | NO | NO |
| **Change fee rate / adjust fee** | **grant** | YES | adj only | NO | NO | NO |
| Mark fee paid | **NO** | YES | YES | NO | NO | NO |
| **Prepare settlement** | **NO** | YES | YES | NO | NO | NO |
| **Approve settlement** | **grant** | YES | YES | NO | NO | NO |
| Check-in scan / log | YES | YES | NO | SCOPED | NO | NO |
| Manual check-in override | YES | YES | NO | NO | NO | NO |
| **Export financial / transaction / PIC-fee reports** | **grant** | YES | YES | NO | NO | NO |
| Own PIC fee / attribution | NO | NO | NO | NO | OWN | NO |
| Own orders / payments | — | — | — | — | OWN | OWN |

**Bold** rows are `ADMIN_GRANT_REQUIRED` — reachable by an Admin only through an explicit,
non-revoked `PermissionGrant` (D-19). "grant" is not a softer `YES`: a test asserts an ungranted
Admin is denied, that a grant unlocks exactly the named permission, and that revoking the grant takes
effect without a re-login.

Deliberately **absent** from the vocabulary, so they deny for everyone: editing an order amount,
altering a payment amount, and any ledger mutation.

### 6.3 Membership `ADMIN` is unmapped (D-05)

Phase 2's schema contains `OrganizerMemberRole.ADMIN`, which the brief suggested but design §5.3
collapsed. With D-05 answered as single-organizer, that value is **vestigial**. It was **not**
removed — that would be a destructive migration, and D-05 could change. Instead it is simply absent
from `MEMBERSHIP_ROLE_PERMISSIONS`, so an actor holding it resolves to **no** organizer permissions
(fail closed) rather than to an invented tier. A test asserts exactly that.

**Recorded as a finding:** an enum value exists whose reachability is a business decision. If D-05 is
ever revisited, this one map plus one migration is the whole change.

---

## 7. Organizer / Tenant Isolation

### 7.1 How isolation is enforced

One enforcement point, `requireOrganizerAccess(organizerId, permission)`:

1. identity comes from the **server-side session** (`auth()`), never a request value;
2. authority comes from **`resolveAuthzScope(userId)`**, which reads the `User` row, the user's
   `OrganizerMember` rows and their non-revoked `PermissionGrant` rows from the database;
3. the target `organizerId` is matched against that resolved membership list. A `SUSPENDED`,
   `INVITED` or `REVOKED` membership does not authorize;
4. denial is `ORGANIZER_ACCESS_DENIED` → **HTTP 404**, not 403, so the response cannot confirm that
   the organizer exists.

The caller may take `organizerId` from anywhere — path segment, query string, body — because its
presence is never treated as authority. This is what makes cases B and C in §11 structural rather
than incidental.

### 7.2 What an organizer cannot reach

Another organizer's events, tickets, orders, customers, revenue, PICs, fees and settlements — even
with the resource id in hand, and even as a platform `ADMIN`, because `ADMIN` also needs an ACTIVE
membership. `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty and exported so the choice is visible.

### 7.3 The database half of the guarantee

The schema's own constraints back the application logic: `OrganizerMember @@unique([organizerId,
userId])` prevents duplicate memberships, `@@index([userId, status])` serves the resolver's query, and
`PermissionGrant @@unique([userId, organizerId, permission])` prevents duplicate grants. Cascade
behaviour (`organizerMember` → `Organizer` on delete) means removing an organizer removes its access
grants.

---

## 8. Authorization Helpers

`lib/authz/` — five modules, one public surface via `index.ts`.

| Module | Responsibility |
| --- | --- |
| `errors.ts` | `AuthzError`, `AuthzErrorCode` (UNAUTHORIZED / FORBIDDEN / ORGANIZER_ACCESS_DENIED / PIC_ACCESS_DENIED / NOT_FOUND), the code→HTTP map (404 for cross-tenant), `isAuthzError()`, `authzErrorResponse()` |
| `permissions.ts` | The vocabulary, `PERMISSION_SCOPE` classification (PLATFORM / ORGANIZER / OWN), the capability maps, `ADMIN_GRANT_REQUIRED`, `ORGANIZER_SPANNING_PLATFORM_ROLES`, and the **pure** decisions `decidePlatformPermission`, `decideOrganizerPermission`, `decideOwnResourcePermission` |
| `scope.ts` | `resolveAuthzScope(userId)`, `AUTHZ_SCOPE_TTL_MS`, `isScopeStale()` |
| `guards.ts` | `getAuthzScope`, `requireAuth`, `requirePlatformPermission`, `requirePlatformRole`, `requireOrganizerAccess`, `requireOrganizerMember`, `requireOwnResource` |
| `index.ts` | Barrel export |

### 8.1 Design rules the helpers enforce

* **Throw on deny, never return a boolean.** The codebase already had both shapes — `lib/admin.ts`
  throws bare strings, `lib/csrf.ts` returns `{ error }` — and a returned error is easy to ignore
  (a caller that only destructures `userId` proceeds). Throwing cannot be ignored.
* **Fail closed.** Missing session, missing user row, unknown permission, or unclassifiable scope all
  deny. There is no path in the module where an unknown state becomes an allow.
* **The decision logic is pure.** `permissions.ts` imports no database and no `next/server`, so every
  rule is unit-testable without I/O and an authorization check cannot itself have side effects.
* **No `as any`.** Asserted by test across the whole module.

### 8.2 Consequence for callers

```ts
try {
    await requireOrganizerAccess(organizerId, PERMISSIONS.EVENT_WRITE);
} catch (error) {
    if (isAuthzError(error)) return authzErrorResponse(error);
    throw error;
}
```

Responses use the project's existing `{ success, message }` envelope, plus a machine-readable `code`.

---

## 9. Route / API Protection

### 9.1 Proxy reviewed, no role logic added (D-49)

Per the approved answer the proxy stays **auth-only**. It runs in the Edge runtime where Prisma is
unavailable, so it physically cannot answer "may this actor touch this organizer?" — and a proxy that
only appears to authorize is worse than one that plainly authenticates. The three real layers are the
proxy, the `lib/authz` guards, and membership/ownership in the service layer.

### 9.2 The fail-open gap — measured, then closed without guessing

Phase 0 finding S-3: an `/api/*` path absent from both allow-lists falls through unauthenticated.
Measured across all **115** route files: **95 protected, 17 public, 3 unclassified.**

| Route | Was it a vulnerability? | Action |
| --- | --- | --- |
| `/api/campaigns` | **No.** Source says "PUBLIC CAMPAIGN LIST … No ADMIN auth required." Unclassified only because the allow-list entry ends in a slash (`/api/campaigns/`), so it never matched the list endpoint itself. | Added to `PUBLIC_API_PREFIXES` (behaviour unchanged — unclassified also passed through; intent is now explicit) |
| `/api/promotions` | **No.** Same cause, same documented public intent. | Same |
| `/api/payment/status` | **No.** Its own handler already returns 401 when unauthenticated and scopes rows by `session.user.id`. | Added to `PROTECTED_API_PREFIXES` — it already returned 401 with an identical body, so nothing observable changes; the gap just closes |

**The durable fix is the test, not the three entries.**
`__tests__/authz/route-classification.test.ts` enumerates every route file and fails if any is
unclassified, so a new route cannot silently ship unprotected. It also asserts the two lists do not
overlap (the proxy checks public first, so an overlap would silently make a "protected" route public)
and that webhook callbacks stay public (providers cannot authenticate).

### 9.3 Existing retail routes

Not migrated to the new model, deliberately. `lib/admin.ts` (`requireAdmin`) and `lib/csrf.ts`
(`requireAdminSession`) still test the **legacy** `Role.ADMIN`, because `User.platformRole` is
nullable and unpopulated — switching these 22 retail files to it would lock every existing admin out.
Phase 3's change to them is type-only.

---

## 10. Database Changes

**None. This is a deliberate outcome, not an omission.**

* `prisma/schema.prisma` was **not modified** (its diff is still exactly the Phase 2 1,419 insertions).
* **No migration was created.** Everything Phase 3 needs — `Organizer`, `OrganizerMember`,
  `PermissionGrant`, `PlatformRole`, `OrganizerMemberRole`, `OrganizerMemberStatus`,
  `User.platformRole` — already exists from Phase 2 and was reused, not duplicated.
* `prisma migrate status` → **18 migrations, "Database schema is up to date!"**

The only database work the design assigned to Phase 3 is the **platform-role population**. It was
deliberately **not** performed as a migration, and no implicit bridge was written from the legacy
retail `Role.ADMIN` to `PlatformRole.ADMIN`: deriving a platform privilege from a legacy column is a
hidden grant, which the brief §21 forbids. `platformRole` is assigned by an explicit, auditable
operation — see §14.2.

---

## 11. Tests

### 11.1 Baseline vs final

| | Suites | Suites failed | Tests | Tests failed | Tests passed |
| --- | --- | --- | --- | --- | --- |
| Baseline (before Phase 3) | 26 | 6 | 634 | 2 | 632 |
| After Phase 3 | 30 | 6 | 697 | 2 | 695 |

**The same 6 suites and the same 2 tests fail, before and after** — zero regressions:

* `B. Payout PAID consumes commissions` and `E. Admin affiliate detail executes against MariaDB`, both
  in `__tests__/p0/remediation.integration.test.ts`;
* load failures in `__tests__/ipaymu/production-hardening.test.ts` and four `__tests__/marketing/*`
  suites.

The other +4 suites and +63 tests are the new `authz` suite, all passing.

### 11.2 New tests — 63 across 4 suites

| Suite | Kind | Covers |
| --- | --- | --- |
| `permission-map.test.ts` | pure, no DB | fail-closed fundamentals, D-19 grant semantics, separation of duties, D-05 vestigial membership, isolation cases as decisions, own-scope |
| `tenant-isolation.integration.test.ts` | **real DB** | cases A–F through the real guards, plus D-19 end-to-end and own-scope guards |
| `route-classification.test.ts` | source analysis | §15/D-49: every API route classified |
| `session-typing.test.ts` | compile-time + source scan | session/JWT shapes; augmentation target; no `as any` |

`jest.config.js` gained one `testMatch` line so the new suite actually runs. Worth noting: it
previously matched only 5 of the 15 test directories, which is why `__tests__/auth/register-rate-limit.test.ts`
has never run. That pre-existing gap is unchanged and reported in §14.4.

### 11.3 The six required cases

| Case | Requirement | Test evidence | Result |
| --- | --- | --- | --- |
| **A** | Same-organizer access per role/permission | owner of A writes events in A; scope resolved from DB; CHECKIN_STAFF scans but cannot read tenant orders | **PASS** |
| **B** | Different-organizer access denied | member of A → organizer B is `ORGANIZER_ACCESS_DENIED` with **HTTP 404**; the actor's resolved scope contains A but not B | **PASS** |
| **C** | Manipulated `organizerId` rejected | identical permission, two ids, opposite outcomes; a fabricated id denied even for `ADMIN`; empty id → `NOT_FOUND` | **PASS** |
| **D** | No escalation from client-side values | a PIC is denied `event.write`; **a session that claims `platformRole: "ADMIN"` and `role: "ADMIN"` is still denied**, and the resolved platform role is `PIC` — the database wins | **PASS** |
| **E** | Unauthenticated rejected | `requireAuth` and the organizer guard both raise `UNAUTHORIZED` / 401, never a tenant denial; 401 response body asserted | **PASS** |
| **F** | Inactive membership cannot authorize | `SUSPENDED` denied (`INVITED`, `REVOKED` too, in the pure suite) while the row remains visible to the resolver — the *status* is what denies | **PASS** |

Case D is the one worth reading closely: feeding the guards a session that asserts admin is the
direct escalation attempt, and the guards ignore it because `platformRole` is read from the `User`
row. The rest of the suite is designed so that a passing test cannot pass vacuously.

---

## 12. Verification

| Check | Command | Result |
| --- | --- | --- |
| Prisma schema valid | `npx prisma validate` | **exit 0** — "The schema at prisma/schema.prisma is valid 🚀" |
| Prisma client generates | `npx prisma generate` | **exit 0** — "Generated Prisma Client (v6.19.3)" |
| TypeScript | `npx tsc --noEmit` | **exit 0** — no errors |
| Migration status | `npx prisma migrate status` | **exit 0** — 18 migrations, DB up to date |
| Migration needed | — | **None** (§10, §16) |
| New authz suite | `npx jest __tests__/authz` | **4/4 suites, 63/63 tests passing** |
| Full suite | `npx jest` | 6 failed / 24 passed suites, 2 failed / 695 passed tests — **identical failures to baseline** |

No result above is claimed without having been executed and its exit status observed.

---

## 13. Scope Compliance

```text
Event                        NO      Ticket                       NO
Checkout                     NO      Payment                      NO
iPaymu                       NO      Settlement                   NO
PIC fee calculation          NO      WhatsApp                     NO
Email                        NO      Marketing                    NO
Spinwheel                    NO      KTP history                  NO
Retail data                  NO      D-60                         NO
prisma/schema.prisma changed NO      Migration created            NO
Git history rewritten        NO      Unrelated retail cleanup     NO
```

Supporting detail:

* **Events / tickets / checkout / payment / settlement / PIC fees:** no route, service, component or
  page was added. `lib/authz` is a decision layer; it implements no business workflow.
* **The retail application is intact.** 24 files changed type-only
  (`(session.user as any).role` → `session.user.role`). `lib/admin.ts` and `lib/csrf.ts` keep testing
  legacy `Role.ADMIN`. No retail route was moved to the new model, and no retail behaviour changed
  except the three proxy classifications in §9.2.
* **`prisma/schema.prisma` untouched**, no migration, no backfill, no data migrated.
* **D-60 remains unresolved** — no unique `(eventId, name)` was added.
* **KTP / Git history untouched** — no `filter-repo`, `filter-branch`, `rebase --root` or
  `push --force`. No `.gitignore` rule added for `storage/` (outside this phase's authority).
* **No `AppError` framework was created.** Design §40.2 assigned it to Phase 2, which was
  database-only, so it does not exist. Rather than invent a platform-wide error framework inside an
  authorization phase, `AuthzError` delivers only what Phase 3 needs. Noted in §14.4.

---

## 14. Known Risks

### 14.1 Requires a deployment action — highest priority

1. **`TRUSTED_PROXY` is unset, so the login limiter's IP bucket is degenerate.** `getClientIp()`
   returns `"untrusted"` for everyone, so `rateLimiters.login` (5 / 15 min) is a **global** bucket:
   five failed logins throttle all users. This is the existing project convention, followed rather
   than silently replaced, and it is spoof-proof by design — but the limiter is only meaningful once
   `TRUSTED_PROXY` is set behind the reverse proxy. **Until then, enabling D-53's limiter trades a
   brute-force weakness for an availability one.**
2. **The limiter is per-instance, in-memory.** Decision D-54 (shared store / Redis) was assigned to
   Phase 2 and is not implemented; the module logs a warning when `REDIS_URL` is set. On any
   multi-instance deployment the effective limit is 5 × instances.

### 14.2 Requires an operational decision

3. **No user holds a `platformRole`.** `User.platformRole` is nullable and unpopulated, and no
   implicit bridge was written (§10). Consequence: the ticketing platform-role surface is closed
   until someone is explicitly assigned. That is fail-closed and intentional, but it must be done
   before any ticketing admin feature can be used — including by whoever is meant to administer it.
4. **Organizer rows do not exist yet** (0 in the database). Isolation is enforced and tested against
   rows tests create; the production operator must create the TinggalKlik.Co organizer and its
   membership.

### 14.3 Accepted, with evidence

5. **`proxy.ts` remains an allow-list.** The fail-open *mechanism* still exists for a hypothetical
   route that is neither protected nor public; what changed is that this can no longer happen
   silently — the classification test fails instead (§9.2). Inverting to deny-by-default was rejected
   because it would risk breaking unlisted public retail endpoints (§20).
6. **`requireAdmin()` still throws bare `Error("UNAUTHORIZED")` strings**, not `AuthzError`. Left
   as-is to avoid changing the response contract of 22 live retail routes; new ticketing code uses
   `lib/authz`.
7. **JWT revocation is bounded by the token, not by the scope TTL.** The 60 s bound (D-48) covers the
   platform-role mirror, and tenant/grant authority is re-read per request — strictly tighter than
   approved. But a *signed-out-then-stolen* token, or any claim the token itself carries, is
   bounded by JWT expiry, which this phase did not change. A token version/denylist is the standard
   remedy and is out of scope here.
8. **`__tests__/authz/tenant-isolation.integration.test.ts` writes to the real development
   database** (with a unique suffix and `afterAll` cleanup), matching the convention of
   `__tests__/p0/remediation.integration.test.ts`. A run killed mid-flight could leave `p3-*` rows
   behind.

### 14.4 Pre-existing, documented, not fixed

9. **Legacy `as any` in retail admin routes (~7 sites).** `user.role as any`,
   `metadata as any`, `(order as any).subtotal`. These narrow values that came from the **database**,
   not roles from a request, so they are not authorization holes — and the brief §22 excludes global
   cleanup. This is why the `as any` test is scoped to Phase 3's footprint (§11.2).
   ```
   lib/admin/audit-log.ts                      metadata as any
   app/api/admin/broadcasts/route.ts           type/status as any
   app/api/admin/campaigns/route.ts            rawStatus as any
   app/api/admin/dashboard/route.ts            user.role as any
   app/api/admin/orders/[id]/refund/route.ts   auditActions[action] as any
   app/api/admin/reports/route.ts              (order as any).subtotal
   app/api/admin/settings/tracking/route.ts    user.role as any  (×2)
   ```
10. **The jest coverage gap is unchanged.** `testMatch` still matches only 6 of 15 test directories;
    `__tests__/auth/*`, `admin`, `affiliate`, `broadcast`, `checkout`, `shipping`, `transaction`,
    `ui`, `voucher-picker` do not run in CI.
11. Unchanged from Phase 0/2.5: KTP scans in Git history and no `storage/` rule in `.gitignore`;
    the 520 ESLint problems; `toko_backup.sql` as a 0-byte tracked file; `0_baseline`'s incomplete
    coverage (reconciled in Phase 2.5, but `db push` drift can reappear).

---

## 15. Files Changed

### 15.1 Created

```
lib/authz/errors.ts
lib/authz/permissions.ts
lib/authz/scope.ts
lib/authz/guards.ts
lib/authz/index.ts

__tests__/authz/permission-map.test.ts
__tests__/authz/tenant-isolation.integration.test.ts
__tests__/authz/route-classification.test.ts
__tests__/authz/session-typing.test.ts

TICKETING_PHASE3_REPORT.md
```

### 15.2 Modified

```
types/next-auth.d.ts        typed session: Role + PlatformRole, JWT augmentation corrected
auth.ts                     D-53 rate limit, D-48 mirror, timing hash fix, as-any removal
lib/csrf.ts                 D-56 origin check; accurate docs; as-any removal
lib/admin.ts                as-any removal (type-only); behaviour unchanged
proxy.ts                    3 routes classified + D-49 scope documented; arrays exported for tests
jest.config.js              +1 testMatch line for __tests__/authz

# type-only: (session.user as any).role -> session.user.role   (24 files)
app/admin/layout.tsx
app/admin/products/page.tsx
app/admin/settings/page.tsx
app/admin/whatsapp/page.tsx
app/api/admin/broadcasts/route.ts
app/api/admin/broadcasts/[id]/route.ts
app/api/admin/broadcasts/[id]/audience/route.ts
app/api/admin/broadcasts/[id]/send/route.ts
app/api/admin/bulk-discounts/route.ts
app/api/admin/bulk-discounts/[id]/route.ts
app/api/admin/products/route.ts
app/api/admin/products/[id]/route.ts
app/api/admin/settings/route.ts
app/api/admin/settings/destination/route.ts
app/api/admin/settings/regions/route.ts
app/api/admin/settings/regions/destination/route.ts
app/api/admin/settings/regions/provinces/route.ts
app/api/admin/shipping-discounts/route.ts
app/api/admin/shipping-discounts/[id]/route.ts
app/api/admin/upload/route.ts
app/api/admin/users/route.ts
app/api/spin-wheel/route.ts
app/api/spin-wheel/spin/route.ts
app/api/uploads/affiliate/[...path]/route.ts
```

**Not modified:** `prisma/schema.prisma`, any migration, `lib/checkout.ts`, `lib/refund.ts`,
`lib/repay.ts`, `lib/payment/**`, `app/api/payment/ipaymu/notification/route.ts`, any WhatsApp or
email module, any marketing module, `prisma/seed-*.ts`.

### 15.3 Pre-existing changes preserved

`next-env.d.ts`, `package-lock.json` and `prisma/seed-regions.js` were left exactly as found. No
`git reset --hard`, `git clean`, `git checkout -- .` or `git restore` was used. The only `git checkout`
was of `tsconfig.tsbuildinfo`, a TypeScript incremental-build cache regenerated by the validation runs.

---

## 16. Migration Safety

**No migration was created, so there is no fresh-database replay to report** — and that is the correct
outcome: §10 explains why no schema change was required. All Phase 3 schema needs were satisfied by
Phase 2's additive foundation, which Phase 2.5 verified on a freshly provisioned database.

The Phase 2.5 lesson still governs any future migration: applying to the current database is not
sufficient, and fresh-database replay must also pass. The chain is in the state Phase 2.5 left it —
**18 migrations, fresh and live structurally identical, zero drift.** Phase 3 touched no migration.

---

## 17. Git Status

```text
Commit created?      NO
Push performed?      NO
History rewritten?   NO
`git reset --hard` / `git clean` / `git restore` run?   NO
```

---

## Appendix A — Decisions answered, and where they live in code

| ID | Answer | File |
| --- | --- | --- |
| D-05 | Single organizer; membership `ADMIN` vestigial | `lib/authz/permissions.ts` — `MEMBERSHIP_ROLE_PERMISSIONS` |
| D-19 | Grant-required for Admin | `lib/authz/permissions.ts` — `ADMIN_GRANT_REQUIRED`, `grantApplies()` |
| D-48 | ≤60 s cache, invalidate on revocation | `lib/authz/scope.ts`, `auth.ts` `jwt` callback |
| D-49 | Proxy auth-only | `proxy.ts` docblock |
| D-53 | Inside `authorize()` | `auth.ts` |
| D-56 | Implement origin check | `lib/csrf.ts` |

## Appendix B — Evidence for the timing-equalisation finding

Measured with the project's own dependency (`bcryptjs`, `compareSync`, 200 iterations, this machine):

```text
valid $2b$12 hash:      252.820 ms/op
old malformed dummy:      0.000 ms/op
ratio:              3,243,563x
```

The old value — `"$2a$12$x dummy hash to prevent timing attack"` — is not a valid bcrypt hash, so
bcryptjs rejects it structurally and returns without performing the key derivation. The "constant-time
response" comment above it was therefore untrue, and the user-enumeration mitigation it was meant to
provide did not exist. Replaced with a real cost-12 hash of a value nobody knows.

## Appendix C — Next phase

Phase 4 (Event + Venue + Sport management) is **not started**. Phase 3's decisions are recorded in
§3; the next gates per design §39.3 are **D-13, D-14, D-55, D-64 before Phase 4**.
