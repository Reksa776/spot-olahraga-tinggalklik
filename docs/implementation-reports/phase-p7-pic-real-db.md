# Phase P7 — PIC Real Database Verification

- **Date:** 2026-11-06
- **Status:** Complete for the approved P7 scope
- **Scope:** Verify the existing PIC check-in path against an isolated MariaDB schema: duplicate/concurrent scans, the atomic `ISSUED → CHECKED_IN` transition, transaction rollback, PIC event-assignment authorization, cross-event denial, rate limiting, and audit logging.
- **Out of scope:** Changing PIC, payment, ticket issuance, or notification business logic; production database access; production migrations; WhatsApp activation.

## Guardrails observed

- No production database credentials or production schema were used.
- `TEST_DATABASE_URL` was required and pointed at an isolated schema.
- No migration was run against production.
- No PIC production code was modified. This phase added test coverage only.
- Existing uncommitted user changes were preserved. No commit or push was made.
- P2 was not started.

## Files modified

| File | Change |
|---|---|
| `__tests__/ticketing-checkin/check-in.integration.test.ts` | Added a real-database PIC assignment/cross-event scenario, its profile/assignment fixture and cleanup, and the transaction-rollback scenario. |
| `docs/implementation-reports/phase-p7-pic-real-db.md` | **New.** This report. |

No production code, Prisma schema, migration, payment code, ticket issuance code, or notification business logic was changed in P7.

## Test database

| Item | Value |
|---|---|
| Engine | MariaDB |
| Host / port | `127.0.0.1:3306` |
| Isolated test schema | `tinggalklik_test` |
| Application schema | `tinggalklik` (not used for test writes) |
| Required test variable | `TEST_DATABASE_URL` |
| Guard | Test URL must be explicit, differ from `DATABASE_URL`, and name a schema ending in `_test`. |

`npm run test:db:setup` exited `0` and reported:

```text
Verified isolated test schema 'tinggalklik_test'.
```

No production database access was detected. The test database is a separate local schema; no production migration or production data was involved.

## Coverage and evidence

### 1. Concurrent duplicate scans

**Test:** `P13-B. a ticket is admitted once` → `resolves two simultaneous scans to exactly one winner`.

Two `checkInTicket` calls are launched concurrently against the real database with `Promise.allSettled`.

Actual result:

- exactly **1 fulfilled** and **1 rejected**;
- the rejected call carries `TICKET_ALREADY_CHECKED_IN`;
- exactly **1** `CheckIn` row with `result: SUCCESS`;
- the ticket ends in `CHECKED_IN`.

The duplicate guarantee is the database's UNIQUE `CheckIn.ticketId`, not an application-only check.

### 2. Atomic `ISSUED → CHECKED_IN` transition

Real-database integration coverage includes:

- `moves one ISSUED ticket to CHECKED_IN and records who did it`;
- `changes nothing about the order, the payment or the inventory`;
- the concurrent check-in vs. refund tests in `check-in-refund-gate.integration.test.ts`;
- the transaction-order/CAS tests in `check-in-transaction.test.ts`.

The admission writer performs the guarded conditional update inside one transaction and writes accepted evidence only after the CAS succeeds. The real-database test confirms the ticket, the single accepted `CheckIn`, and the order/payment/inventory state remain consistent.

### 3. Transaction rollback

**Test:** `rolls the ticket update back when the accepted evidence cannot be written`.

The test inserts a conflicting accepted `CheckIn` for the same ticket first, then calls the real `checkInTicket`. The subsequent UNIQUE conflict is `P2002`.

Actual result:

- the call rejects with `P2002`;
- the ticket is back to `status: ISSUED`, `checkedInAt: null`;
- only the deliberately pre-existing `CheckIn` row remains.

This proves the ticket update does not commit without accepted evidence.

### 4. PIC event-assignment authorization against MariaDB

**Test:** `authorizes a PIC against the real assignment, and refuses an unassigned event`.

The fixture creates, in the real test database:

- a normal `User`;
- an `ACTIVE` `PICProfile` owned by that user;
- an active `PICEventAssignment` for event A, assigned by tenant A's owner.

The test signs in as that PIC and calls the production `checkInTicket` path.

Actual result for the assigned event:

- admission succeeds with `result: SUCCESS`, `method: MANUAL`;
- the audit row has `actorUserId` equal to the PIC user;
- `organizerId` is tenant A;
- `afterState` contains `actorKind: "PIC"` and the real `picProfileId`.

The same PIC then targets event B, for which no assignment exists.

Actual result:

- the call is refused with `ORGANIZER_ACCESS_DENIED`, status `404`;
- refusal happens before event B's ticket can be read.

This exercises the real compound profile/assignment lookup and the real audit write, not a mocked Prisma response.

### 5. Cross-event access restrictions

Real-database coverage:

- a tenant-A scanner presenting a tenant-B ticket gets `CONFLICT` / `WRONG_EVENT`;
- tenant B's ticket remains `ISSUED` and its order remains `PAID`;
- a PIC assigned to event A is refused at event B with the masked `404`.

Pure-decider coverage in `__tests__/authz/pic-assignment.test.ts` additionally checks:

- assignment A cannot authorize event B;
- no assignment, inactive assignment, revoked assignment, and missing profile all deny;
- a profile owned by another user cannot borrow the assignment;
- authority does not become tenant-wide.

### 6. Rate limiting

`__tests__/ticketing-checkin/pic-scan-security.test.ts` covers:

- requests are allowed up to the documented allowance;
- the next request is refused with a retry delay;
- each PIC identity has an independent bucket;
- each event has an independent bucket for the same PIC;
- identity/scope are not taken from arbitrary client keys;
- a backend failure fails closed with `503` and no identifiers;
- the bucket key is server-derived from the session user and authorized event.

**Important limitation:** this limiter is in-memory and per-process. The tests prove its local behavior, not distributed rate limiting across multiple app instances.

### 7. Audit logging

- The real-database integration suite asserts `checkin.success` with the admitting organizer user, organizer id, and `actorType: "USER"`.
- The new PIC scenario asserts `checkin.success` with the PIC's session user, the real organizer id, `actorKind: "PIC"`, and the server-derived `picProfileId`.
- The duplicate-scan test asserts one `checkin.rejected` audit row for the losing scan.
- `pic-scan-security.test.ts` checks that audit payloads store no participant PII, raw QR payload, secret, or token; that entity references use the normalized ticket code; that authorization internals are not exposed; and that the writer remains append-only with secret-shaped key filtering.

## Tests executed and actual results

| Check | Scope | Actual result |
|---|---|---|
| Test schema setup | `npm run test:db:setup` | Exit `0`; verified isolated `tinggalklik_test` schema. |
| P7-only Jest | 10 explicit suites | **10 suites passed, 325 tests passed**, exit `0`. |
| Combined P1 + P7 regression | 14 explicit suites | **14 suites passed, 376 tests passed**, exit `0`. |
| Check-in integration suite | `check-in.integration.test.ts` | **22 tests passed** within the P7 run. |
| TypeScript | `npx tsc --noEmit` | Exit `0`. |
| Diff whitespace check | `git diff --check` | Exit `0`. |

### Intermediate correction

The first run of the new PIC assertion expected `httpStatus: 404`. The actual authorization error exposes `status`, not `httpStatus`; the assertion was corrected to `status: 404`. No production code was changed, and the final runs above are clean.

### Jest note

Jest printed:

```text
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
```

All tests passed, but this warning means open handles may be masking a cleanup issue. It is recorded as a test-hygiene risk, not reported as a pass for handle cleanliness.

## Remaining risks

1. **Rate limiting is not distributed.** It is an in-memory, per-process bucket. Running multiple application instances would weaken the effective limit. Fixing this requires a shared limiter design; it was outside P7.
2. **PIC real-DB matrix is not exhaustive.** Real MariaDB coverage proves the active-assignment allow and the no-assignment deny. Revoked/inactive assignments, suspended PICs, malformed rows, and some API/page error mappings are covered by pure or mocked tests rather than real-database rows.
3. **Route and page tests are mocked.** `pic-scan-authz`, `pic-scan-api`, and `pic-scan-page` exercise the real deciders/service wiring where applicable, but their Prisma/API boundaries are still mocked. They are not a substitute for a full HTTP + MariaDB end-to-end run.
4. **Concurrency is limited to two simultaneous scans.** There is no sustained load, high-contention, or multi-process soak test. The single-winner invariant is proven for the tested pair, not for arbitrary production load.
5. **Local MariaDB is not production topology.** The engine is the same family, but production connection pooling, latency, and deployment topology were not reproduced.
6. **Jest force-exits.** Open handles remain a possible source of flakiness or resource leakage.
7. **No production verification.** No production check-in or production PIC account was used. This is intentional.

## Rollback instructions

P7 changed tests only. There is no production schema migration and no production code to roll back.

1. Revert only the additions to `__tests__/ticketing-checkin/check-in.integration.test.ts`:
   - the PIC fixture variables and beforeAll setup;
   - the PIC assignment/audit test;
   - the rollback test;
   - the PIC cleanup in `afterAll`.
2. If the work was committed, prefer `git revert <release-sha>`. Do not run a blanket `git checkout -- .`; the working tree contains unrelated user changes.
3. If the isolated test schema must be discarded, drop **only** `tinggalklik_test`; never drop or modify the application schema as part of this rollback.
4. No production database, queue, payment, ticket, or notification rollback is required.

## Stop point

P1 and P7 are complete. P2 and all subsequent phases were not started and require explicit approval.
