# PHASE 11 — FULL SYSTEM AUDIT & STABILIZATION REPORT

Project: **TinggalKlik.Co** · Stack: Next.js 16 · React 19 · TypeScript · Prisma 6 · MySQL/MariaDB · NextAuth v5 beta
Audit date: 2026-09-19 · Auditor: Buffy (Codebuff) · Scope: whole ticketing application (`app/`, `lib/`, `components/`, `prisma/`, `proxy.ts`, `auth.ts`)

> No commit and no push was performed. No destructive command, migration or database
> reset was run. Every change below is an application-code / config change made in the
> working tree only.

---

## 1. Executive Summary

Phase 11 began as a total audit, not a feature phase. The codebase that phases 1–10 produced
is unusually mature: authorization is centralized and fail-closed, money paths are
transactional with database-enforced idempotency, and the public/private surfaces are
separated structurally. The audit therefore found **no P0 (security / financial corruption /
tenant escape) and no P1 (broken core transaction) defects**.

It found **one P2 application bug** in a secondary route (customer registration answered a
validation failure with HTTP 500 and skipped the same-origin check), plus **P3/P4
correctness-and-hygiene defects** (two React 19 rule violations in client components,
loose `any` typing on the payment adapter, and lint noise). These were fixed. The only
substantial gaps left are **unimplemented product features** (event archival and the wider
event status lifecycle), which are recorded as deferred because they need a product/design
decision and rule §17 explicitly forbids inventing them during this phase.

Every change was validated: TypeScript PASS, **50 suites / 1129 tests PASS**, build PASS,
lint **0 errors** (down from 27).

**Final verdict: `STABLE WITH KNOWN NON-BLOCKING ISSUES`.**

---

## 2. Baseline Test Result (BEFORE changes)

Run in project root, in this order, before any edit:

| Command | Result | Notes |
| --- | --- | --- |
| `npx tsc --noEmit` | **PASS** (exit 0) | no type errors |
| `npx jest --runInBand` | **PASS** — 49 suites / 1122 tests | (`npm test` is not defined; the runner is `npx jest`) |
| `npm run build` | **PASS** (exit 0) | full route manifest emitted |
| `npm run lint` | **FAIL** — 47 problems (27 errors, 20 warnings) | errors in `__tests__/**`, `lib/payment/ipaymu.ts`, `server.js`, `scripts/*.js`, React 19 rules |

Per-failure classification of the baseline lint errors (all `application-bug = no` except where
noted):

| File:line | Rule | Classification | Related to a previous change? |
| --- | --- | --- | --- |
| `__tests__/**/*.ts` (11 sites, e.g. `authz/tenant-isolation:42`, `events/catalog:27`, `ticketing-payment/payment-harness:53`) | `@typescript-eslint/no-require-imports` | **test/tooling config issue** — CommonJS `require()` inside Jest factories is correct there; the rule was mis-scoped | pre-existing |
| `__tests__/ui/dialog-logic.test.ts:42` | `no-explicit-any` | test bug (typing) | pre-existing |
| `server.js:1-3`, `scripts/test-ipaymu-sandbox.js:11-12` | `no-require-imports` | **tooling config issue** — CJS entry point / script | pre-existing |
| `lib/payment/ipaymu.ts:480,689,1322` | `no-explicit-any` | technical debt | pre-existing |
| `lib/fetchWithRetry.ts:27-28` | `no-explicit-any` | technical debt | pre-existing |
| `lib/services/auth.ts:3` | `no-explicit-any` | technical debt | pre-existing |
| `components/auth/RegisterForm.tsx:130` | `no-explicit-any` | technical debt | pre-existing |
| `components/organizer/TicketTypeManager.tsx:193` | `react-hooks/purity` | **application correctness** (impure render) | pre-existing |
| `components/orders/ReservationCountdown.tsx:56` | `react-hooks/set-state-in-effect` | **application correctness** (cascading render) | pre-existing |

No baseline failure was classified as environment-only, and none was caused by a Phase 11
change (changes came after).

---

## 3. Authentication Audit

**Verified — no defects found.**

| Control | Evidence | Result |
| --- | --- | --- |
| Credential login | `auth.ts` Credentials `authorize`; `bcryptjs` `verifyPassword` | PASS |
| User-enumeration timing | constant-time dummy verify against a **real** cost-12 bcrypt hash (`TIMING_EQUALISATION_HASH`) on user-not-found and OAuth-only paths | PASS |
| Login rate limit | `rateLimiters.login(getClientIp(request))` inside `authorize`; throttled and bad-credential outcomes are indistinguishable (both `null`) | PASS (deployment caveat: `TRUSTED_PROXY` must be set for a real per-IP bucket) |
| OAuth account takeover | `allowDangerousEmailAccountLinking: false` | PASS |
| Session strategy | JWT; `session.user.id` and `platformRole` set from token | PASS |
| Authorization authority | `authz` scope re-resolved from the **database** per request; the token copy is display-only and refreshed on a ≤60 s TTL (`AUTHZ_SCOPE_TTL_MS`) | PASS |
| Stale / revoked session | revocation takes effect immediately in the guards (DB-derived), ≤60 s in the token mirror | PASS |
| Open redirect | `resolveSafeCallbackUrl` validates `callbackUrl` by **parsing** against a `.invalid` sentinel origin; rejects absolute, protocol-relative, backslash, control-char, and loop paths | PASS |
| Proxy scope | `proxy.ts` is auth-only by decision D-49 and cannot (and does not) claim to authorize tenant access (Edge runtime, no Prisma) | PASS |
| Route classification | `__tests__/authz/route-classification.test.ts` enumerates every `app/api/**/route.ts` and fails on an unclassified route | PASS |

**Role matrix (as coded and tested):** `ADMIN` without an ACTIVE `OrganizerMember` gets **no**
tenant data (confirmed: `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty and the membership gate is
unconditional). `MANAGER` is tenant-scoped by membership. `PIC` holds only OWN-scope plus
`PIC_ATTRIBUTION_READ_ALL` via a `PIC` membership row. `CUSTOMER` cannot enter the dashboard.

---

## 4. Authorization Audit

37 API route files. Every one is classified in `proxy.ts` (public or protected) and every
mutation/read additionally resolves authority in the service layer. Full inventory:

| METHOD | PATH | AUTH | PERMISSION | TENANT SCOPING | OWNERSHIP | STATE CHECK | ORIGIN | RATE LIMIT | VALIDATION |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GET | /api/events | public | — | visibility hard-coded | — | — | n/a | — | Zod query |
| GET | /api/events/[slug] | public | — | D-14/D-10.3 | — | ARCHIVED→404 | n/a | — | param |
| GET | /api/events/[slug]/share | public | — | reuses detail query | — | — | n/a | — | param |
| GET | /api/sports | public | — | active only | — | — | n/a | — | — |
| GET | /api/uploads/events/[filename] | public | — | basename-only path | — | — | n/a | — | basename guard |
| POST | /api/ticketing/payment/webhook | public (HMAC) | — | reference→our Payment | — | verdict | signature | body cap | gateway verify |
| POST | /api/auth/register | public | — | — | — | — | ✅ (added) | ✅ | ✅ (fixed) |
| * | /api/auth/[...nextauth] | NextAuth | — | — | — | — | — | — | — |
| GET | /api/admin/sports | protected | `sport.manage` | platform | — | — | n/a | — | — |
| POST | /api/admin/sports | protected | `sport.manage` | platform | — | — | ✅ | — | ✅ strict |
| PATCH/DELETE | /api/admin/sports/[id] | protected | `sport.manage` | platform | — | refs block delete | ✅ | — | ✅ strict |
| GET | /api/admin/venues | protected | `venue.manage.global` | platform | — | — | n/a | — | — |
| POST | /api/admin/venues | protected | `venue.manage.global` | platform | — | — | ✅ | — | ✅ strict |
| PATCH/DELETE | /api/admin/venues/[id] | protected | resolves ownership class | platform/tenant | DB-resolved | refs block delete | ✅ | — | ✅ strict |
| GET | /api/admin/pic | protected | `pic.manage` | platform | — | — | n/a | — | — |
| POST | /api/admin/pic | protected | `pic.manage` | platform | — | — | ✅ | — | ✅ strict |
| GET | /api/admin/pic/[id] | protected | `pic.manage` | platform | — | — | n/a | — | param |
| PATCH | /api/admin/pic/[id] | protected | `pic.manage` | platform | — | status enum | ✅ | — | ✅ strict |
| GET | /api/organizer/events | protected | `event.read` | membership-derived filter | — | — | n/a | — | Zod query |
| POST | /api/organizer/events | protected | `event.write` | `requireEventCreate(organizerId)` | — | status forced DRAFT | ✅ | — | ✅ strict |
| GET | /api/organizer/events/[id] | protected | `event.read` | `requireEventAccess` | event→organizer | — | n/a | — | param |
| PATCH | /api/organizer/events/[id] | protected | `event.write` | `requireEventAccess` | event→organizer | archived block, dates | ✅ | — | ✅ strict |
| DELETE | /api/organizer/events/[id] | protected | `event.write` | `requireEventAccess` | event→organizer | DRAFT + no history | ✅ | — | param |
| POST | .../events/[id]/publish | protected | `event.publish` | `requireEventAccess` | event→organizer | preconditions | ✅ | — | — |
| POST | .../events/[id]/unpublish | protected | `event.publish` | `requireEventAccess` | event→organizer | must be PUBLISHED | ✅ | — | — |
| GET | .../events/[id]/images | protected | `event.banner.upload` | `requireEventAccess` | event→organizer | — | n/a | — | — |
| POST | .../events/[id]/images | protected | `event.banner.upload` | `requireEventAccess` | event→organizer | MIME/magic bytes | ✅ | ✅ upload | multipart guard |
| DELETE | .../images/[imageId] | protected | `event.banner.upload` | `requireEventAccess` | `(id, eventId)` pair | — | ✅ | — | — |
| GET | .../events/[id]/ticket-types | protected | `event.read` | `requireEventAccess` | event→organizer | — | n/a | — | — |
| POST | .../events/[id]/ticket-types | protected | `ticket_type.write` | `requireEventAccess` | event→organizer | editable-event | ✅ | — | ✅ strict |
| GET | .../ticket-types/[ticketTypeId] | protected | `event.read` | `requireTicketTypeAccess` | type→event→organizer | — | n/a | — | param |
| PATCH | .../ticket-types/[ticketTypeId] | protected | `write` + `quota.change` / `price.change` | `requireTicketTypeAccess` | type→event→organizer | quota ≥ sold+reserved | ✅ | — | ✅ strict |
| DELETE | .../ticket-types/[ticketTypeId] | protected | `ticket_type.write` | `requireTicketTypeAccess` | type→event→organizer | refs block delete | ✅ | — | param |
| GET | /api/organizer/venues | protected | `event.read` | membership-derived | — | — | n/a | — | Zod query |
| POST | /api/organizer/venues | protected | `venue.manage` | `requireVenueCreate` | — | — | ✅ | — | ✅ strict |
| GET | /api/organizer/venues/[id] | protected | `requireVenueRead` | global/tenant split | DB-resolved | — | n/a | — | param |
| PATCH/DELETE | /api/organizer/venues/[id] | protected | `requireVenueManage` | global/tenant split | DB-resolved | refs block delete | ✅ | — | ✅ strict |
| GET | /api/organizer/pic | protected | `pic.assign` | `requireOrganizerAccess` | — | — | n/a | — | query |
| POST | /api/organizer/pic | protected | `pic.assign` | event→organizer | event→organizer | — | ✅ | — | ✅ strict |
| DELETE | /api/organizer/pic/[id] | protected | `pic.assign` | assignment→organizer | DB-resolved | soft revoke | ✅ | — | param |
| POST | /api/ticketing/checkout | protected | customer | server pricing | — | quota CAS | ✅ | — | ✅ + Idempotency-Key |
| GET | /api/ticketing/orders/[orderNumber] | protected | `order.read.own` | `userId` predicate | own | — | n/a | — | param |
| POST | .../orders/[orderNumber]/pay | protected | own | ownership predicate | own | eligibility, D-09 | ✅ | ✅ | ✅ strict |
| POST | .../orders/[orderNumber]/cancel | protected | `order.cancel.own` | ownership predicate | own | PENDING_PAYMENT only | ✅ | — | param |
| POST | .../orders/[orderNumber]/issue | protected | `ticket.issue.own` | ownership predicate | own | must be PAID+settled | ✅ | — | param |
| GET/POST | /api/ticketing/refunds | protected | own / `order.read.tenant` | own or tenant | own predicate | eligibility | ✅ (POST) | — | ✅ |
| POST | .../refunds/[refundId]/approve | protected | `refund.approve` | refund→organizer | — | PENDING CAS + SoD | ✅ | — | ✅ |
| POST | .../refunds/[refundId]/reject | protected | `refund.approve` | refund→organizer | — | PENDING CAS + SoD | ✅ | — | ✅ |
| POST | .../refunds/[refundId]/execute | protected | `refund.execute` | refund→organizer | — | APPROVED CAS + SoD | ✅ | — | ✅ |
| GET | /api/ticketing/tickets | protected | `ticket.read.own` | `holderUserId` predicate | own | — | n/a | — | Zod query |
| GET | /api/ticketing/tickets/[ticketCode] | protected | `ticket.read.own` | `(ticketCode, holderUserId)` | own | — | n/a | — | ✓ |

**Anti-patterns searched and NOT found in routes:** authentication-without-authorization
routes, `organizerId` from body treated as authority, client-supplied `userId`, `findById`
without an ownership predicate, client-supplied price/total/status/payment-state/quota/role.
Where an id is accepted from the request it is fed through the real decider
(`requireOrganizerAccess` / `requireOwnResource`) and fails closed as 404 on cross-tenant.

---

## 5. Tenant Isolation Audit

**Verified — no defects found.**

- Isolation is structural: an organizer-scoped permission requires **both** a capability
  source **and** an ACTIVE `OrganizerMember` row. `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty,
  so even `ADMIN` cannot reach a tenant without membership.
- Cross-tenant denials map to **404** (`ORGANIZER_ACCESS_DENIED`), so a denial cannot confirm a
  resource exists. `toAppError` deliberately preserves that status rather than re-deriving 403.
- Dashboard read models all funnel through `resolveOrganizerFilter(scope, permission, requested)`,
  which re-decides a requested organizer rather than trusting it — the same decision function
  the API guards use, so a list cannot be scoped more loosely than the API behind it.
- Per-domain narrow-ownership guards (`requireEventAccess`, `requireTicketTypeAccess`,
  `requireVenueRead/Manage`) read **only** the ownership columns before deciding.

---

## 6. Event Audit

Confirmed implemented and correct: create (status forced `DRAFT`, ownership authorized, sport
usable, venue attachable, future-start, slug generated uniquely, audit), list (membership
filter), detail (+ sales summary), update (strict schema; `organizerId`/`status`/`publishedAt`
not accepted; slug-collision refused; date invariants; audit diff), publish (D-13
self-publish; §10.3 preconditions; `publishedAt` set on first publish only), unpublish (D-14;
status→DRAFT, no order/ticket/payment/refund side effects), delete (DRAFT + zero commercial
history only; referential cleanup in one transaction).

**Gap found — EVENT ARCHIVE IS NOT IMPLEMENTED (deferred).** `Event.archivedAt`, the
`ARCHIVED` status, and D-10.3's "hidden from all public surfaces" are **enforced** everywhere
(update/publish/unpublish/delete guards, public catalog 404), but **nothing can set them**:
there is no archive service function, no route, and no UI action. This is a missing feature,
not a broken one.

Matrix (`UI / API / SERVICE / DB / AUTHZ / TEST`):

| Feature | UI | API | Service | DB | Authz | Test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Create Event | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Edit Event | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE (sales window / maxPerOrder not surfaced in form — see §18) |
| Publish | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Unpublish | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Archive | ❌ | ❌ | ❌ | ✅ (columns) | ✅ (enforced) | partial | **MISSING (deferred)** |
| Cancel (status) | ❌ | ❌ | ❌ | ✅ | ✅ | partial | **MISSING (deferred)** |
| Delete (draft only) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Ticket Type CRUD | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Price / Quota (separately permissioned) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Sales Window (ticket type) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Venue assignment | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Images / banner | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |
| Public preview | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | COMPLETE |

---

## 7. Public Catalog Audit

**Verified — no defects found.**

- List is filtered by a single hard-coded `publicVisibilityWhere`
  (`PUBLISHED` + `PUBLIC` + `archivedAt: null` + not past). No "no filter" branch exists, so no
  query parameter can widen it.
- Detail resolves PUBLISHED/ONGOING/COMPLETED as available, DRAFT/CANCELLED as unavailable
  (D-14 read-only state), ARCHIVED and reserved `PRIVATE` as 404.
- Payloads are built by **explicit field mapping** from narrow `select`s (never a row spread),
  so internal ids, `organizerId`, audit fields, membership data, quota/sold/reserved counters,
  PIC fee and payment data cannot leak. `remaining` is intentionally `null` while D-15 is
  undecided.
- Share endpoint reuses the detail query, so visibility rules cannot drift between card and
  page. Tracking token is `null` (PIC model deliberately not fabricated).

---

## 8. Checkout Audit

**Verified — no defects found.**

- `Idempotency-Key` header is **mandatory**, scoped to `(userId, endpoint, key)` with a unique
  DB constraint; a missing header is refused rather than silently made unique.
- Money is server-derived; the Zod request schema declares no financial field, so a
  client-supplied `price`/`total`/`subtotal`/`currency`/`organizerId`/`userId`/`status` cannot
  reach the service.
- Quota acquisition is a single conditional `UPDATE … WHERE reserved + sold + n <= quota`
  (never SELECT-then-UPDATE). Reservation rows and counters commit in one transaction.
- Reservation TTL comes from `PlatformSetting.reservationTtlMinutes` (default 30), reaper body
  is idempotent, and the reaper claims the order row **before** releasing seats (phase-7 lock
  ordering) so it cannot race a settlement.
- Transient InnoDB contention is retried with bounded jittered backoff, re-running the whole
  unit of work each attempt.

---

## 9. Payment Audit

**Verified — no defects found.**

- The signature-verified, idempotent webhook is the **only** settlement trigger; no client
  endpoint can mark PAID, change an amount, a payment status, a reference, or settle manually.
- Ordering is the security property: raw body → HMAC verify (fail-closed) → amount verify →
  insert `WebhookEvent` (unique `providerEventId` = replay guard) → classify → settle in one
  transaction. Only a `PROCESSED` row blocks a later delivery, so key-squatting on an unverified
  payload cannot lock out the genuine one.
- Amount comparison uses `Prisma.Decimal` (float-free) and prefers `sub_total` per §13.0.
- QRIS / VA / retail / redirect methods flow through the same session-creation path; the polling
  read surface is display-only and reads the order row, never derives "paid" from a redirect.
- Late settlement of a terminal order is recorded with `fulfilmentBlockedAt` and moves **no**
  inventory (verified by test E2).

---

## 10. Refund Audit

**Verified — no defects found.**

- Lifecycle PENDING→APPROVED→PROCESSING→REFUNDED / PENDING→REJECTED / PROCESSING→FAILED is
  CAS-guarded at every transition. Approve/reject/execute each CAS from the expected prior state;
  the execute CAS to PROCESSING happens **before** the provider call, so a duplicate execute
  never calls the provider twice.
- Separation of duties: the requester can never approve, reject or execute their own request
  (enforced in the service, not the UI).
- CHECKED_IN tickets are not refundable; refund amount ≤ order's remaining refundable balance;
  `RefundItem.ticketId` is UNIQUE (no duplicate claims); duplicate refund cannot occur.
- Quota returns **only** after confirmed settlement and only when the event opted in
  (`returnQuotaOnRefund`); `refundedAmount` and order/payment status change **only** after
  confirmation. Failed refunds move no financial state. Provider reference comes only from the
  provider.
- Provider rail: the default refund provider reports UNSUPPORTED (documented D-R17), so with no
  live refund rail wired the path ends FAILED with `PROVIDER_UNSUPPORTED` and moves no money —
  it never fabricates a reference.

---

## 11. Ticket Audit

**Verified — no defects found.**

- Issuance is idempotent at the database level (`Ticket.(orderItemId, sequenceNo)` unique); the
  eligible order must already be PAID and settled, so issuance never makes an order paid.
- `Ticket.qrTokenHash` is one-way; the wallet **list** omits the QR entirely, and only the single
  ticket endpoint returns `qr.payload` (a public reference, not the scanner secret).
- Ownership is a query predicate (`holderUserId = session.user.id`); a cross-customer read is
  404, not 403, so it cannot disclose that a ticket exists.

---

## 12. Customer Audit

**Verified.** There is no `Customer` model; a customer is a `User` with orders. The dashboard
customer list is scoped by `order.read.tenant` over the actor's readable organizers, and the
buyer search matches only the buyer's own columns. No IDOR was found: a customer's order/ticket
reads are own-scoped, and one organizer cannot read another's customers.

**Note (P4, deferred):** `listDashboardCustomers` computes the total by loading all `groupBy`
rows (`allUserGroups.length`) into application memory rather than a `count`. Correct but not
bounded; recorded for a later optimization.

---

## 13. PIC Audit

**Verified — no defects found.**

- Platform PIC management is gated on `pic.manage` (platform scope) in every service entry
  (`listPicsForAdmin`, `createPic`, `updatePicStatus`, `getPicDetail`).
- Organizer assignment is gated on `pic.assign` and authorized against the **event's real
  organizer**, so an assignment cannot be written naming another tenant's event; a missing event
  and a foreign event are both NOT_FOUND.
- Revocation is soft (`isActive:false` + `revokedAt`) so attributions/fee history are not
  orphaned. Fee reversal on refund is append-only (`type=REVERSAL`) with a unique
  `(orderItemId, type)` guard, so a single order item can be reversed at most once.

---

## 14. Venue Audit

**Verified — no defects found.**

- D-64's two ownership classes are enforced by two separate permission strings
  (`venue.manage` vs `venue.manage.global`). A global venue requires the platform permission
  (an organizer member cannot mutate it); a private venue requires tenant `venue.manage`
  (another organizer gets 404).
- The organizer namespace requires an `organizerId` and cannot mint a global venue; the admin
  namespace cannot reassign a venue's ownership class (`organizerId` absent from the update
  schema).
- Deletion is refused while any event references the venue (the FK is `SetNull`, which would
  silently blank event history). Venue archival is deliberately not implemented — the schema has
  no status/`archivedAt` column and inventing one is a design decision.

---

## 15. Error Handling Audit

**Verified.** The platform has a single error contract (`AppError` + `ERROR_CODES`,
`apiErrorResponse`, `handleApi`). Handlers wrap work in `handleApi`, so a thrown value becomes
`{ success:false, code, message, details? }`; unknown errors become a generic 500 with a
correlation id and are logged server-side. No route returns a stack trace, a raw Prisma error or
SQL details to a client. `AuthzError` is translated preserving its own code and status.

**Fixed:** the registration route was the one handler outside this contract (validation → 500
`{message}`). See §21.

---

## 16. Input Validation Audit

**Verified.** Every mutation parses a Zod schema via `parseOrThrow`, which raises
`VALIDATION_ERROR` with `details.fields`. Schemas are strict where it matters: event, ticket-type,
venue, sport and PIC update/create schemas omit ownership, status and counters, so mass assignment
is not possible. Money is carried as a decimal **string** end-to-end (no `Number()` round trip).
Enum/status values are validated. The one exception was registration (fixed, §21).

---

## 17. Database / Transaction Audit

**Verified — no defects found.**

- Inventory mutations are parameterised `$executeRaw` CAS statements (tagged templates, no
  interpolation); `GREATEST(0, …)` guards prevent duplicate releases from driving counters
  negative.
- Reservation transitions are conditional `updateMany` CAS on the current status (the state
  transition is the guard, not a prior read), and the inventory mutation commits in the same
  transaction as the state change.
- Lock order is consistent across checkout, cancel, settle and reaper (order row → reservations →
  ticket types), which prevents deadlock and the "paid but ticketless" race.
- Idempotency is enforced by DB unique constraints (`WebhookEvent.providerEventId`,
  `RefundItem.ticketId`, `PICFeeLedger.(orderItemId,type)`, `Ticket.(orderItemId,sequenceNo)`),
  never by a check-then-insert.
- No external API call is made inside a DB transaction: the refund provider call happens outside
  the transaction, and the webhook settles in a transaction after verification.
- No destructive migration or DB reset was performed during this phase.

---

## 18. Frontend Audit

The unified dashboard is server-rendered with capability-driven menus; loading/empty/error/
unauthorized states are implemented via shared primitives. Every action button is wired to a
real endpoint — no fake functionality was found. A static `checkin-gate` test proves the UI does
not pretend check-in exists.

**Fixed (correctness):**

- `components/organizer/TicketTypeManager.tsx` called `Date.now()` during render
  (`react-hooks/purity`) — impure/non-idempotent render. Now compares against a **server-supplied**
  `serverNow` prop, so the readiness preview is server-derived and render is pure.
- `components/orders/ReservationCountdown.tsx` called `setState` synchronously inside an effect
  (`react-hooks/set-state-in-effect`), causing a cascading render. Replaced with
  `useSyncExternalStore` (clock as an external store; server snapshot `null` for hydration
  safety). Behaviour preserved: server-derived deadline, one `router.refresh()` at zero, no
  mutation.

**Deferred (P4):** the event edit form does not surface `salesStartAt`/`salesEndAt`/
`maxTicketsPerOrder`/banner (they are simply not sent, so no data loss occurs — they are not
editable from the event form; sales windows are editable per ticket type). Five `<img>` LCP
warnings remain pending a `next/image` configuration decision.

---

## 19. Security Findings

| ID | Severity | Domain | Root cause | Affected file | Attack scenario | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P11-S1 | P3 | CSRF | `POST /api/auth/register` was the only state-changing route without the D-56 same-origin check | `app/api/auth/register/route.ts` | Cross-site POST creating accounts (no session to ride, but inconsistent with the platform baseline) | Added `requireSameOrigin` (fails closed on absent/unparseable Origin/Referer) | `__tests__/auth-flow/register-route.test.ts` (cross-origin & no-Origin 403) |
| P11-S2 | P2 (info) | Error/validation | Validation failure reported as HTTP 500 | `app/api/auth/register/route.ts` | No direct exploit; confuses clients and mislabels input errors as server faults | `safeParse` → 400 `VALIDATION_ERROR` with field details | same suite |
| P11-S3 | info | Input integrity | `(this as any)._outerResolve` in a test helper | `__tests__/ui/dialog-logic.test.ts` | none (test-only) | typed private field | lint |

No IDOR, privilege escalation, tenant escape, open redirect, missing auth, missing permission,
mass assignment, payment/refund manipulation, replay, webhook forgery or rate-limit bypass was
found. The webhook's trust boundary is HMAC over raw bytes; replay is a DB constraint; the
register route was already rate-limited.

---

## 20. Test Coverage Gaps

Baseline coverage is broad (event lifecycle, ticket types, inventory CAS/concurrency, reservation
lifecycle, checkout + concurrency, payment creation/verification/settlement/webhook
replay/races, refunds eligibility + approve/settle, issuance + QR + wallet, venue/sport,
Authorization role-matrix, tenant isolation, route classification).

Gaps identified (and how they are handled):

| Domain | Gap | Action |
| --- | --- | --- |
| Auth | No test for the registration **route contract** | **Added** `register-route.test.ts` (7 tests) |
| Event | Archive/cancel lifecycle untested | deferred with the feature |
| Events | Public visibility of ARCHIVED/unlisted/ past | covered by `events/catalog` suite (existing) |
| Check-in | No check-in implementation | intentionally not tested (gate test asserts absence) |
| Notifications | WhatsApp/email not implemented | out of scope |

Per rule §18, regression tests were added **only** for the defects found.

---

## 21. Issues Fixed

| ID | Severity | Domain | Status | Root cause | Fix | Test |
| --- | --- | --- | --- | --- | --- | --- |
| P11-01 | P2 | Auth/Registration | **FIXED** | `registerSchema.parse()` threw `ZodError` into the catch-all (500); route skipped CSRF and used `any` | `safeParse` → 400 `VALIDATION_ERROR` + `details.fields`; added `requireSameOrigin`; typed `unknown`; consistent envelope | `__tests__/auth-flow/register-route.test.ts` |
| P11-02 | P3 | Frontend/Event UI | **FIXED** | `TicketTypeManager` read `Date.now()` during render | compare against server-supplied `serverNow` prop | typecheck + lint (`react-hooks/purity` cleared) |
| P11-03 | P3 | Frontend/Checkout UI | **FIXED** | `ReservationCountdown` `setState` synchronously in effect | `useSyncExternalStore` clock store | lint (`set-state-in-effect` cleared); build |
| P11-04 | P3 | Types | **FIXED** | loose `any` in `ipaymu.ts` (×3), `fetchWithRetry.ts` (×2), `lib/services/auth.ts`, `RegisterForm.tsx`, test helper | narrowed `unknown` + typed causes; `RegisterInput` param; typed struct | `tsc --noEmit` |
| P11-05 | P4 | Lint config | **FIXED** | Jest harnesses / scripts / custom server are CJS but the TS rule forbade `require()`; `_`-prefixed intentional unused bindings flagged | scoped overrides + `argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern: "^_"` | `eslint .` → 0 errors |
| P11-06 | P4 | Dead code | **FIXED** | unused `JPEG_RETAINED_APP_MARKER`, unused `crypto` import, unused `storeName`, unused params/vars | removed / `_`-prefixed | `eslint .` |

---

## 22. Issues Deferred

| ID | Severity | Domain | Reason for deferral |
| --- | --- | --- | --- |
| P11-D1 | P2 (feature) | Event archive | `Event.archivedAt`/`ARCHIVED` are enforced but nothing sets them. Implementing needs a semantics decision (effect on orders/tickets/refunds/quotas) — rule §17 forbids inventing it this phase |
| P11-D2 | P3 (feature) | Event status lifecycle | No ONGOING/COMPLETED/CANCELLED transitions; needs product rules (auto-transition? who cancels? buyer handling) |
| P11-D3 | P3 (feature) | Event form scope | Sales window / maxPerOrder / banner not editable from the event form (ticket-type window exists) — needs UX decision |
| P11-D4 | P4 | Dashboard customers | `count` computed in memory for pagination total — optimization only |
| P11-D5 | P4 | Images | 5 `<img>` LCP warnings — needs `next/image` loader/config decision |
| P11-D6 | P3 (deployment) | Rate limiting | `TRUSTED_PROXY` must be set for a real per-IP login/register bucket; otherwise one global bucket (documented in `auth.ts`) |
| P11-D7 | P3 (integration) | Refund rail | Default refund provider reports UNSUPPORTED (D-R17); a real provider must be wired before refunds can move money |

---

## 23. Remaining Known Errors

- **TypeScript:** none (`npx tsc --noEmit` exit 0).
- **Jest:** none (`50 suites / 1129 tests` pass; 0 failures, 0 skipped).
- **Build:** none (`next build` exit 0).
- **Lint:** 0 errors; 5 warnings, all `@next/next/no-img-element` (deliberate; see P11-D5).
- Known non-blocking **behavioral** gaps: event archive/cancel not implemented (P11-D1/D2);
  refund provider not wired (P11-D7); `TRUSTED_PROXY` deployment caveat (P11-D6).

No failure was removed, skipped, or weakened to achieve a pass. The baseline test count
increased by 7 (1122 → 1129) purely by adding new regression coverage.

---

## 24. Recommended Phase 12

1. **Event lifecycle completion** — decide and implement archive/cancel semantics (what happens
   to live orders, tickets, quotas, refunds), then wire UI + API + tests.
2. **Refund rail** — integrate a real refund provider (replace the UNSUPPORTED default) and
   cover the provider-confirmation path end to end.
3. **Deployment hardening** — set `TRUSTED_PROXY`; enable a durable rate-limit store; schedule
   the reservation reaper (the body exists but is not scheduled).
4. **Event form completeness** — expose sales window / max-per-order / banner; adopt
   `next/image` with the project's storage/loader contract.
5. **Data-scale cleanup** — bound the dashboard customers total and audit pagination on large
   tenants.

---

## 25. Final Verification

Run after all fixes, in project root:

```
npx tsc --noEmit          → exit 0 (PASS)
npx jest --runInBand      → 50 suites / 1129 tests PASS
npm run build             → exit 0 (PASS)
npx eslint .              → 0 errors, 5 warnings (@next/next/no-img-element)
```

Baseline vs. after:

| Check | Before | After |
| --- | --- | --- |
| TypeScript | PASS | PASS |
| Tests | 49 suites / 1122 | **50 suites / 1129** |
| Build | PASS | PASS |
| Lint errors | 27 | **0** |
| Lint warnings | 20 | **5** (intentional) |

**FINAL VERDICT: `STABLE WITH KNOWN NON-BLOCKING ISSUES`.**

Justification: no P0 or P1 defect exists; the single P2 application bug found was fixed and
regression-tested; tenant isolation, authorization, and the payment/refund/inventory money paths
are transactional and database-enforced. The remaining issues are unimplemented product features
(event archive/cancel, live refund rail) and P4 polish that require product or infrastructure
decisions — they do not destabilize the shipped core.

*Not claimed: "production ready" — that would require the deferred items above plus live-provider
and deployment validation to be completed.*
