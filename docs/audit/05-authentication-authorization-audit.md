# 05 — AUTHENTICATION & AUTHORIZATION AUDIT

---

## 1. Authentication mechanism

| Aspect | Implementation | Evidence |
|---|---|---|
| Library | Auth.js / NextAuth v5 beta | `auth.ts`, `package.json` |
| Providers | Google OAuth + Credentials (email/phone + password) | `auth.ts` |
| Password storage | bcrypt hash, cost 12 | `lib/password.ts`, `auth.ts` |
| Session | **JWT** strategy (not DB session) | `auth.ts` `session.strategy = "jwt"` |
| Adapter | Prisma adapter for users/accounts | `@auth/prisma-adapter` |
| Cookie | Auth.js session cookie, `SameSite=Lax` | documented in `lib/csrf.ts` |
| OAuth linking | `allowDangerousEmailAccountLinking: false` | `auth.ts` |
| Registration | `POST /api/auth/register`; role never accepted from body | `app/api/auth/register/route.ts` |
| Account disable | `User.disabledAt` makes `resolveAuthzScope` return `null` | `lib/authz/scope.ts` |
| Login abuse control | per-client/per-account/platform throttles in `lib/rate-limit.ts` | `auth.ts` |

Login failure responses are deliberately uniform. A locked bucket throws a distinct `CredentialsSignin` code so the UI can say "wait", without revealing whether an account exists. Timing is equalised with a real bcrypt hash for unknown users.

---

## 2. Session and scope resolution

`resolveAuthzScope(userId)` (`lib/authz/scope.ts`) is the single gate into authority. It reads, in parallel:

1. `User` (`platformRole`, `disabledAt`);
2. **all** `OrganizerMember` rows (including suspended/revoked, so the decision function can refuse them);
3. active `PermissionGrant` rows.

No part of the scope is built from a request body, query string, path segment or cookie value. The scope is cached in the JWT for at most **60 seconds** (`AUTHZ_SCOPE_TTL_MS`); a revoked membership takes effect immediately for a new request that refreshes, and within 60 seconds for an existing cached token.

`requireAuth()`, `requireOrganizerAccess()`, `requireOrganizerMember()`, `requireOwnResource()` and `requirePlatformPermission()` **throw** on denial (`lib/authz/guards.ts`). This is deliberate: a boolean return could be ignored by a route.

---

## 3. Role model

### 3.1 Platform roles (`User.platformRole`)

| Role | Platform capabilities | Tenant capabilities |
|---|---|---|
| `ADMIN` | Sports, global venues, PIC management, users, roles, platform config, audit log, application settings, maintenance, branding | Event/refund/PIC management **inside an active membership**; financial actions require an explicit grant |
| `MANAGER` | Audit log read only at platform level | Full operational tenant role: events, ticket types, orders, payments, refunds, PIC, settlements, reports, check-in |
| `PIC` | None | None via tenant maps; own-scope fees/attribution/payout; event scanning via assignment decider |
| `CUSTOMER` | None | Own orders, payments, tickets, refund requests |

### 3.2 Organizer membership roles (`OrganizerMember.role`)

| Role | Summary |
|---|---|
| `OWNER` | Full tenant operations and financial actions |
| `MANAGER` | Full operational + financial tenant role |
| `FINANCE` | Orders/payments/refunds/settlements/reports; cannot edit/publish events |
| `PIC` | Read PIC attribution only (tenant-side view) |
| `CHECKIN_STAFF` | `checkin.scan` and `checkin.log.read` only |
| `ADMIN` | **Deliberately unmapped** (D-05) — resolves to zero permissions |

The legacy `User.role` (`ADMIN/SELLER/CUSTOMER/AFFILIATOR`) is **not** an authority source for ticketing. It remains because the session contract and some legacy guards (`requireAdminSession`) still read it; new code uses `platformRole` + `lib/authz`.

---

## 4. Permission architecture

- Permission strings are declared once in `PERMISSIONS` (`lib/authz/permissions.ts`) and classified as `PLATFORM`, `ORGANIZER` or `OWN`.
- Effective authority is the **intersection** of a capability source (platform role map, membership role map, or active grant) and a scope (active membership / ownership).
- `ADMIN_GRANT_REQUIRED` financial permissions are absent from ADMIN's tenant map; an explicit `PermissionGrant` is required.
- Cross-tenant denial is `ORGANIZER_ACCESS_DENIED`, mapped to **404**, so a caller cannot confirm that another tenant's resource exists.
- `lib/events/access.ts` performs a narrow ownership lookup first, then authorizes, then the caller reads business fields. This avoids the banned "fetch then check" pattern.

**Relevant check-in permissions:**

| Permission | Held by |
|---|---|
| `checkin.scan` | ADMIN, MANAGER, OWNER, membership MANAGER, CHECKIN_STAFF |
| `checkin.override` | ADMIN, MANAGER, OWNER, membership MANAGER |
| `checkin.log.read` | ADMIN, MANAGER, OWNER, FINANCE (via audit), CHECKIN_STAFF |

A PIC holds **none** of these. PIC scanning is a separate capability, explained below.

---

## 5. How event scope is enforced

- Organizer path: `requireEventAccess(eventId, CHECKIN_SCAN)` → load event stub → `requireOrganizerAccess(organizerId, permission)`.
- If the member lacks `checkin.override`, an active `StaffEventAssignment` for that event is required.
- PIC path: only after an **authorization refusal** (never after a database/programming error), `requirePicCheckInAccess` loads the active `PICProfile` and the `PICEventAssignment` for the exact event, then calls the pure `decidePicEventPermission`.
- PIC page uses `requirePicScanAccess`, which asks only the PIC question and returns masked 404 on any refusal.
- The PIC API route repeats the service check on every scan; a direct request cannot bypass the page.

---

## 6. Can PICs safely use the QR scanner?

**Yes, structurally — with two caveats.**

**Why it is sound:**

1. A PIC has no `OrganizerMember` row, so tenant RBAC cannot accidentally grant organizer-wide access.
2. Scanning requires an ACTIVE profile **and** an active, non-revoked assignment for the exact event (`PICEventAssignment`).
3. The assignment is checked on every request, not cached in a client value.
4. `decidePicEventPermission` is pure and fail-closed; missing/partial/inactive data denies.
5. The page returns 404 for unassigned/revoked/unknown events; it is not an existence oracle.
6. The PIC response nulls `firstCheckedInBy`; the PIC page renders no attendance log (`canReadLog={false}`).
7. Phase 3F adds a 120/min per-user/per-event rate limit and audit metadata (`actorKind`, `picProfileId`).
8. Manager control remains intact: the manager assigns/revokes `PICEventAssignment`; revocation is effective immediately on the next request.

**Caveats:**

1. **Real-database evidence is missing (Phase 3G).** The CAS/unique admission path and assignment lookups are covered by mocked or pure suites, not by two real connections against MariaDB.
2. **The QR payload is the public ticket code.** A PIC is authorized to scan, but the credential itself proves knowledge of a code, not cryptographic authenticity. The raw scanner token is never delivered to clients; this is a product-level decision, not something the PIC feature can fix alone.

---

## 7. Authorization risks

| # | Risk | Evidence | Severity | Recommendation |
|---|---|---|---|---|
| A-1 | 60-second scope staleness after revocation | `AUTHZ_SCOPE_TTL_MS` | Low | Accept or shorten for high-risk actions; document |
| A-2 | Legacy `User.role` still guards some admin paths | `lib/csrf.ts` `requireAdminSession` | Medium | Migrate/retire legacy guard after inventory |
| A-3 | ADMIN requires an active membership for tenant actions | `lib/authz/permissions.ts` intersection rule | Low (intended) | Document operator workflow |
| A-4 | PIC cannot read attendance or override | design decision | Low | Keep; do not widen for feature 4 without a separate decider |
| A-5 | PIC assignment revocation relies on app checks, not DB session invalidation | `PICEventAssignment.revokedAt` | Low | Next-request check is sufficient |
| A-6 | No real DB test of PIC assignment | `TEST_DATABASE_URL` absent | High for release claim | Phase 3G |

---

## 8. Conclusion

The authentication and authorization model is the strongest part of the codebase: identity is session-derived, authority is database-derived, denials throw, tenant boundaries are masked as 404, and PIC access is a separate least-privilege axis. The main work is evidence (real DB) and legacy-role cleanup, not a redesign.
