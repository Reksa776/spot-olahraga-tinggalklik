# PHASE 3D — PIC SCANNER API EXECUTION REPORT

**Repository:** `/home/reksa/tinggalklik` · branch `main` · baseline HEAD
`9b8fecd99bcc74677c1805c18379241af04fddd1` (3A.6 PASS · 3B PASS · 3C PASS WITH LIMITATIONS)
**Report status:** written after implementation; **untracked**, never staged.

---

## 1. Executive summary

Phase 3D mounts the existing admission service behind an authenticated PIC endpoint:

```
POST /api/pic/events/[id]/check-in
```

The route is a thin adapter — CSRF → `requireAuth()` → strict body → `checkInTicket` — with no
ticket logic of its own. The PIC decision is made by the Phase 3A decider inside the service's
access guard, against the session user's own `PICProfile` and the `PICEventAssignment` for the
event in the URL; only then does the single Phase 3C transaction run.

The one structural correction needed was the one the pre-implementation audit already prescribed
(`docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:925`): a PIC has no `OrganizerMember` row, so
`requireEventCheckInAccess` gains a PIC branch. The organizer path is preserved byte-for-byte in
semantics; the fallback runs only on an authorization refusal, and an actor who is neither staff
nor PIC receives the original masked 404.

No schema change, no migration, no database contact, no rate limiting, no audit expansion, no UI.
Tracked source changes: two files (one of them Phase 3C's). Everything else is new and untracked.

---

## 2. Final verdict

**PASS WITH LIMITATIONS.**

Every Phase 3D acceptance criterion is met and every focused check is green. The limitation is
evidence, not implementation: persistence and the session are mocked in both new suites, and no
real-database run occurred (`TEST_DATABASE_URL` is absent, so Jest fails closed). Real assignment
lookups, the 404 masking under a live driver, and two-connection concurrency remain Phase 3G's.

---

## 3. Baseline and final Git state

Baseline (Checkpoint 0):

```
branch main · HEAD 9b8fecd99bcc74677c1805c18379241af04fddd1
staged 0 · tracked modifications 2 (the known Phase 3C files) · untracked 16
```

Final:

```
HEAD 9b8fecd99bcc74677c1805c18379241af04fddd1   (unchanged — no commit)
staged 0 · tracked modifications 2 · untracked 22
M lib/ticketing/checkin/service.ts
M __tests__/ticketing-checkin/check-in-wiring.test.ts   (Phase 3C change, untouched here)
?? app/api/pic/events/…/check-in/route.ts
?? __tests__/ticketing-checkin/pic-scan-api.test.ts
?? __tests__/ticketing-checkin/pic-scan-authz.test.ts
?? docs/PHASE_3D_API_AUTHORIZATION_AUDIT.md
?? docs/PHASE_3D_API_DESIGN.md
?? docs/PHASE_3D_PIC_SCANNER_API_EXECUTION_REPORT.md
```

`.cloud-attachments/` untouched; no wildcard staging; no reset/stash/clean/checkout.

---

## 4. Authorization audit

Full evidence table: `docs/PHASE_3D_API_AUTHORIZATION_AUDIT.md`.

Decisive facts read from source:

- Session identity is `requireAuth()` → `auth()` → `resolveAuthzScope` (`lib/authz/guards.ts`,
  `lib/authz/scope.ts`); a deactivated account resolves to `null` and is therefore 401.
- The decider is `decidePicEventPermission` (`lib/authz/pic-assignment.ts`), pure, taking
  `{ userId, eventId, picProfile, assignment }` snapshots and returning the 3A refusal codes.
- `PICEventAssignment` is unique on `(picProfileId, eventId)` (`prisma/schema.prisma:1489`), so
  "the assignment for this PIC and this event" names at most one row.
- `requireEventCheckInAccess` was organizer-only; the Phase 3 audit prescribes the PIC branch.

**Stop conditions:** none triggered — session, assignment and decider are all established; no
schema change is needed; the service guard is reconciled by the audit-prescribed branch.

---

## 5. API contract and endpoint path

| Property | Value |
|---|---|
| Method / path | `POST /api/pic/events/[id]/check-in` |
| Runtime | `nodejs` |
| Auth | `requireAuth()` after `requireSameOrigin()` |
| Event scope | the `[id]` route segment (never the body) |
| Body | `checkInRequestSchema` — `code` (1–120), optional `gateLabel`/`deviceId`/`clientScannedAt`; `.strict()` |
| Success | `200 { success: true, data: CheckInSuccess }` (service payload unchanged) |
| GET | **absent** — B-4 forbids PIC attendance-log access |

---

## 6. Authentication / session integration

- Identity comes only from `auth()` via `requireAuth()`; no body/query/header field is consulted.
- Unauthenticated → `AuthzError(UNAUTHORIZED)` → 401 envelope; the service is never called
  (tested).
- CSRF runs *before* authentication and body parsing; a missing Origin/Referer is a 403 and
  `requireAuth` is not even reached (tested).

---

## 7. Server-side assignment resolution

`requirePicCheckInAccess` (new, in `service.ts`):

1. `requireAuth()` → session scope.
2. `prisma.event.findUnique({ id })` (narrow ownership stub).
3. `prisma.pICProfile.findUnique({ userId })` — the session user's own profile, any status.
4. `prisma.pICEventAssignment.findUnique({ picProfileId_eventId })` — exact pair.
5. `decidePicEventPermission(...)` → allow / `AuthzError(code)`.

If the event or profile is missing, the **original organizer refusal** is rethrown, preserving the
tenant guard's masked 404 for non-PIC actors.

---

## 8. Phase 3A decider integration evidence

- The real decider is called on the real path (`pic-scan-authz` static test asserts
  `decidePicEventPermission({`, the compound lookup and `picProfileId_eventId`).
- 20 focused tests exercise allow/deny through the real guard:
  - ACTIVE profile + active, non-revoked assignment for this event → allowed;
  - no assignment / inactive / revoked / another profile / another event → `ORGANIZER_ACCESS_DENIED` 404;
  - `PENDING` / `SUSPENDED` / `REJECTED` profile → `PIC_ACCESS_DENIED` 403;
  - deactivated account → 401; no session → 401.
- Phase 3A's own suite still passes 66/66 and was not modified.

---

## 9. Phase 3C service integration evidence

- The route calls `checkInTicket({ eventId: id, input, request })` exactly once (route suite),
  after `requireAuth()`; the event id is the route segment and the parsed input carries only the
  schema's keys.
- The guard now returns `CheckInAccess` from either path, so the **same** `checkInTicket` body —
  gate window, parser, lookup, event match, `FOR UPDATE`, refund guard, CAS, `CheckIn` insert,
  refusal recording, realtime and audit — runs for a PIC. No second transaction and no duplicated
  admission logic (static guard asserts the route contains none of it).
- The organizer gate was not weakened: `requireOrganizerCheckInAccess` is the previous body; the
  fallback triggers only for authorization refusals (`isAccessRefusal`). A database failure
  propagates instead of attempting the PIC path (tested).

---

## 10. Event isolation and request trust boundary

- The event is the URL segment; the body cannot name an event (`eventId` is a validation error).
- Assignment is queried with that exact `eventId`, so a PIC assigned to A scanning B finds no row
  and receives 404 — the same answer as a nonexistent event.
- 14 forbidden body fields (user, profile, assignment, role, permissions, method, status,
  timestamp, actor, ticket id, result, event, organizer, method alias) are each a 400 with the
  service never invoked (tested).

---

## 11. HTTP, CSRF and error handling

| Situation | Status / code | Evidence |
|---|---|---|
| No session | 401 `UNAUTHORIZED` | route test |
| Cross-origin POST | 403 `FORBIDDEN`, auth not reached | route test |
| Any override field | 400 `VALIDATION_ERROR` | 14-case table |
| Non-PIC non-member | 404 `ORGANIZER_ACCESS_DENIED` | authz test (original refusal rethrown) |
| PIC not ACTIVE | 403 `PIC_ACCESS_DENIED` | authz test |
| No/inactive/revoked/wrong-event assignment | 404 `ORGANIZER_ACCESS_DENIED` | authz test |
| Ticket refusals (unknown, wrong event, ineligible, duplicate, refund, closed gate) | unchanged 3C mapping | 3C suite still green |
| Unexpected failure | 500 `INTERNAL_ERROR` + correlation id, no internals | route test asserts no `prisma`, DSN or stack |

No raw submitted code is echoed on an error (tested); no Prisma error text, stack trace, or
decider `reason` reaches the client.

---

## 12. Tests and exact counts

Command: Jest with a DB-free config (`/tmp/p3d.jest.json`: no `setupFiles`, no
`globalSetup`/`globalTeardown`), `--runInBand`, `--json`.

```
Test Suites: 8 passed, 8 total
Tests:       288 passed, 288 total
```

| Suite | Tests | Kind |
|---|---|---|
| `pic-scan-api.test.ts` (new) | **24** | route contract, service mocked |
| `pic-scan-authz.test.ts` (new) | **20** | real guard + decider, Prisma/session mocked |
| `check-in-transaction.test.ts` (3C) | 50 | mocked transaction |
| `check-in-wiring.test.ts` (13/3C) | 29 | pure/static |
| `qr-payload-validation.test.ts` (3B) | 76 | pure/static |
| `pic-assignment.test.ts` (3A) | 66 | pure/static |
| `route-classification.test.ts` (3) | 6 | pure/static |
| `qr-payload-contract.test.ts` | 17 | pure/static |
| **Total** | **288** | |

Both new suites are labelled mocked in their headers; neither is presented as database evidence.

---

## 13. Phase 3A–3C regression results

- Phase 3A decider suite: 66/66 (file untouched).
- Phase 3B parser suite: 76/76 (file untouched in 3D).
- Phase 3C transaction suite: 50/50 — the PIC-branch refactor did not change the admission path;
  its mocked organizer flow (staff/owner, refund, CAS, insert failure) remains green.
- Phase 13/3C wiring suite: 29/29.
- QR payload contract: 17/17.
- Route classification: 6/6 — the new route file is classified by the existing `/api/pic/`
  protected prefix, so no proxy change was required.

---

## 14. TypeScript, lint and diff-check results

```
$ npx tsc --noEmit     → exit 0, no output
$ npx eslint <service, route, both new suites> → exit 0, no output
$ git diff --check     → exit 0, no output
```

No `any`, `@ts-ignore`, lint suppression or weakened assertion was added. (`jest.Mock` handles
are the repository's existing test idiom.)

---

## 15. Independent security review

| # | Question | Verdict | Evidence |
|---|---|---|---|
| 1 | Can an unauthenticated user call the endpoint? | **PASS** (no) | `requireAuth` after CSRF; 401 test; service not called |
| 2 | Can a Manager/unrelated user bypass PIC assignment? | **PASS** (no) | Only the decider allows; FINANCE member 403; non-member 404 |
| 3 | Can a PIC assigned to A scan at B? | **PASS** (no) | assignment queried by the URL event; null → 404 |
| 4 | Can a client submit a forged user id? | **PASS** (no) | identity from session only; `userId` body field → 400 |
| 5 | Can a client submit a forged assignment id? | **PASS** (no) | `assignmentId` body field → 400; lookup server-side |
| 6 | Can a client force `QR_SCAN`? | **PASS** (no) | `method`/`checkInMethod` → 400; service writes its own `MANUAL` constant |
| 7 | Is the Phase 3A decider on the real request path? | **PASS** | `requirePicCheckInAccess` calls it; static + behavioural tests |
| 8 | Is assignment data trusted server-side? | **PASS** | Prisma lookup by `(profile, event)`; no fabricated snapshot |
| 9 | Is the service called only after authorization? | **PASS** | route awaits `requireAuth`; guard precedes admission; unauthenticated test shows no call |
| 10 | Are refund and duplicate protections preserved? | **PASS** | 3C transaction untouched; 50/50 transaction suite; same service |
| 11 | Can an internal QR reason leak? | **PASS** (no) | 3C refusal mapping unchanged; route echoes nothing |
| 12 | Can Prisma/internal errors leak? | **PASS** (no) | 500 `INTERNAL_ERROR`; test asserts no `prisma`/DSN/stack |
| 13 | Are CSRF and validation consistent? | **PASS** | `requireSameOrigin` first; `parseOrThrow`; tests |
| 14 | Are service-level authorization checks preserved? | **PASS** | organizer path unchanged; PIC branch additive only on authz refusal |
| 15 | Are rate-limit/audit/attribution limits documented? | **PASS** | §17 and design §7 |

No FAIL or BLOCKED on a security-critical question.

---

## 16. Database and migration safety evidence

- `TEST_DATABASE_URL` / `DATABASE_URL` present in the environment: **no**; no Prisma connection
  was opened in any suite (both new suites mock the client; the others are pure/static).
- No `migrate`, `db push`, reset, seed, truncate or cleanup ran.
- `prisma/schema.prisma` sha256 `0f48e1cea685e9e33b87dd411712514b31605c07053fd89a92e0607f59ac4a99`
  — unchanged; `git status --porcelain -- prisma/` → 0 lines; newest migration still
  `20260929000000_add_payment_active_order_id`.
- No production or customer data accessed.

---

## 17. Items deferred to Phase 3F (and dependencies)

| Item | Current state | Phase 3F scope |
|---|---|---|
| Rate limiting | `lib/rate-limit.ts` exists (in-memory sliding window); **no** check-in limiter is configured | A PIC scan burst limit (the in-memory limiter is per-instance — Redis is a separate decision) |
| Durable audit | the service writes `checkin.success` / `checkin.rejected`; refusal recording is best-effort | durable/at-least-once refusal evidence, and whether the existing audit JSON suffices |
| PIC attribution | `CheckIn.checkedInByUserId` records the session user; no PIC profile id is stored (B-5 forbids a new column) | attribute "which PIC scanned" via the audit JSON mechanism, respecting `FORBIDDEN_METADATA_KEYS` |
| Own-scan visibility | the service payload includes `firstCheckedInBy` for duplicates (another staff member's name) | omit that field for a PIC surface (B-4), as Phase 3E requires |

None of these were implemented or simulated here, and no existing protection was removed because
3F will improve it.

---

## 18. Known limitations

1. **No real-database run** — persistence and session are mocked; assignment lookup behaviour
   under a live driver and the masked 404 with real rows are unverified.
2. **No two-connection concurrency evidence** — carried over from 3C; the transaction is
   unchanged, but locking/rollback is still Phase 3G's to prove.
3. **Assignment-status edge cases** rely on the decider's contract (3A-pinned), not on
   database-level checks; e.g. a re-assignment row is mutated, not duplicated, which the unique
   index guarantees.
4. **Full repository suite not run** (needs the database); no claim is made about it.
5. **`normalizeCode` remains exported** for compatibility (3C decision), though the gate no
   longer calls it.
6. **Rate limiting / PIC attribution are absent by design** until 3F; the endpoint is therefore
   bounded by session + CSRF + decider only.

---

## 19. Phase 3E–3G not implemented

No scanner UI, camera integration, page, component or client session; no audit expansion, rate
limit or attribution persistence; no integration-test infrastructure, schema change, migration,
QR secret delivery or secret verification. Confirmed by the file list in §3 and by the 288-test
run (no UI/pages touched).

---

## 20. Recommended next phase

**Phase 3E — Scanner UI.** A PIC-facing scan page that posts to this endpoint, renders only the
result of the scan just performed (B-4), and omits `firstCheckedInBy` for duplicate scans. It
requires its own approval; nothing of it was started here.

**Final verdict: PASS WITH LIMITATIONS** — implementation and authorization are sound; real
database persistence/concurrency evidence remains Phase 3G's.
