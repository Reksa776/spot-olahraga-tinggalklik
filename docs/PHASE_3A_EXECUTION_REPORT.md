# PHASE 3A — EXECUTION REPORT

**Subject:** PIC assignment-based authorization contract
**Repository:** `/home/reksa/tinggalklik` · branch `main`
**HEAD at completion:** `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` (unchanged)
**Scope executed:** Phase 3A ONLY
**Final status:** **PASS WITH LIMITATIONS**

Legend used throughout: **PASS** · **FAIL** · **BLOCKED** · **NOT RUN** · **NOT APPLICABLE**.
Nothing is reported as passing unless it was executed in this session.

---

## 1. Executive summary

Phase 3A established the authorization foundation for PIC QR scanning and nothing else.

Delivered:

1. `lib/authz/pic-assignment.ts` — a pure decider, `decidePicEventPermission`, that allows a
   scan only when an ACTIVE `PICProfile` owned by the actor is paired with an active,
   non-revoked `PICEventAssignment` for **the exact event**.
2. `__tests__/authz/pic-assignment.test.ts` — **42** pure matrix tests, **42 passed**.
3. `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` — the 15-section written contract.
4. `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md` — an append-only amendment that
   reverses **only** the "Scan / validate QR" row (design §6.3, locked at Phase 14 §17 /
   `P14-D18`), preserving the historical text and the `NO` answers for manual override and
   attendance-log access.
5. Removal of the unusable uncommitted `PIC_CHECKIN_SCAN_OWN` permission (owner decision B-3),
   which restored `lib/authz/permissions.ts` to its committed state.

No QR validation, ticket-scanning API, scanner UI, check-in service change, schema,
migration, audit write, rate limit or notification change was made. No database was
contacted; no commit, stage or push occurred.

One limitation is recorded in §18: the repository-wide Jest command could not be used for the
pure suite, because this repo's `globalSetup` connects to the test database and its
`setupFilesAfterEnv` teardown performs `DELETE` statements. Owner decision B-6 forbids
database writes in this phase, so the pure suite was run under an equivalent DB-free config
(§12).

---

## 2. Initial Git baseline evidence (CHECKPOINT 0)

| Check | Expected | Observed | Result |
|---|---|---|---|
| `git rev-parse --show-toplevel` | `/home/reksa/tinggalklik` | `/home/reksa/tinggalklik` | **PASS** |
| `git branch --show-current` | `main` | `main` | **PASS** |
| `git rev-parse HEAD` | `d0bb0e0…6bd` | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` | **PASS** |
| Baseline commits | 4 present | `d0bb0e0`, `dd6d32d`, `4da6dc5`, `89b6717` | **PASS** |
| `git diff --cached --stat` | empty | empty | **PASS** |
| `M lib/authz/permissions.ts` | exactly +4 lines | exactly +4 insertions, no deletions | **PASS** |
| `?? .cloud-attachments/` | present | present | **PASS** |
| `?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md` | present | present | **PASS** |
| `?? docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md` | present | present | **PASS** |
| Audit report present | allowed | `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md` | **PASS** |
| Unexpected modification | none | none | **PASS** |

The pre-existing diff was inspected in full before any edit. It contained exactly three
insertions (one declaration plus two map entries) and one explanatory comment line, all
`PIC_CHECKIN_SCAN_OWN`; no unrelated hunk existed. A repository-wide search found no consumer
outside that file — the permission was inert, as the audit reported (B-3).

---

## 3. Owner decisions B-1 … B-6 as implemented

| ID | Implemented by |
|---|---|
| B-1 | `decidePicEventPermission` — ACTIVE profile + active, non-revoked assignment for the exact event; contract §2–§6 |
| B-2 | Contract §11 states the guarantee accurately (existence/ownership/state/refund/authorization), and states plainly what it does **not** prove (holder identity, QR authenticity). No credential code touched. |
| B-3 | Dedicated decider added; `pic.checkin.scan.own` removed from the vocabulary, from `OWN_SCOPE` and from `PLATFORM_ROLE_OWN_PERMISSIONS.PIC`. Organizer decider untouched. |
| B-4 | Contract §10 — own-scan result allowed, attendance list/history/other PICs' results/`checkin.log.read` forbidden. Policy only; no UI, no API, no permission granted. |
| B-5 | No `CheckIn.checkedInByPicProfileId`, no migration, no schema edit, no audit write. Attribution direction recorded in contract §12. |
| B-6 | No database connection, migration, seed, reset or DB-writing test. Pure and static verification only. |

---

## 4. Previous permission diff and the exact replacement

**Removed (3 functional lines + 1 comment), all uncommitted:**

```diff
     CHECKIN_LOG_READ: "checkin.log.read",
-    /** PIC scan authority is limited to events with an active PIC assignment. */
-    PIC_CHECKIN_SCAN_OWN: "pic.checkin.scan.own",

     P.REPORT_EXPORT_OWN_PIC_FEE,
-    P.PIC_CHECKIN_SCAN_OWN,
 ];

         P.REPORT_EXPORT_OWN_PIC_FEE,
-        P.PIC_CHECKIN_SCAN_OWN,
```

**Replacement:** `decidePicEventPermission` in `lib/authz/pic-assignment.ts`. No replacement
permission string was invented, because no `PermissionScope` value can express "this exact
event": `PLATFORM` has no tenant context, `ORGANIZER` resolves through membership, and `OWN`
resolves through record ownership. Adding a fourth scope kind would have changed the global
scope machinery — a stop condition — whereas a separate decider leaves the existing
machinery exactly as it was.

**Post-removal state:** `git diff -- lib/authz/permissions.ts` exits `0` with no output, i.e.
the file is byte-identical to `HEAD` again. `M lib/authz/permissions.ts` no longer appears in
`git status`. No unrelated content was touched in that file.

---

## 5. Authorization architecture

```
caller (future phase)                    this phase
─────────────────────                    ──────────
resolve session userId
load PICProfile(userId)
load PICEventAssignment(picProfileId, eventId)
        │
        ▼
decidePicEventPermission({ userId, picProfile, eventId, assignment })
        │
        ├── { allowed: true,  picProfileId }
        └── { allowed: false, code, reason }
```

The decider is pure: no Prisma, no session, no network, no filesystem, no environment, no
module state, no mutation. It is deliberately NOT reachable through `decideOrganizerPermission`
and takes no `AuthzScope` — so there is no organizer, membership or grant channel to widen.

Refusal codes reuse the existing contract: `UNAUTHORIZED` (401), `NOT_FOUND` (404, missing
event id), `PIC_ACCESS_DENIED` (403, profile problems), `ORGANIZER_ACCESS_DENIED` (404,
assignment problems). Assignment refusals are 404 for the same reason the tenant guard is:
a PIC must not be able to distinguish "not yours" from "does not exist".

---

## 6. PIC assignment predicate

```
ALLOW iff  userId non-empty
       AND eventId non-empty
       AND picProfile.id non-empty AND picProfile.userId === userId
       AND picProfile.status === "ACTIVE"
       AND assignment exists
       AND assignment.picProfileId === picProfile.id
       AND assignment.eventId === eventId
       AND assignment.isActive === true          (boolean, not truthy)
       AND assignment.revokedAt === null         (strict; undefined denies)
```

Authority is the pair `(picProfileId, eventId)`. Assignment to event A authorizes A only; a
PIC holding both assignments is still checked against the one supplied.

---

## 7. Fail-closed behaviour

| Input state | Code | Status |
|---|---|---|
| `undefined` / `null` context | `ORGANIZER_ACCESS_DENIED` | 404 |
| missing / empty / whitespace / non-string `userId` | `UNAUTHORIZED` | 401 |
| missing / empty / whitespace / non-string `eventId` | `NOT_FOUND` | 404 |
| no profile, or profile without id | `PIC_ACCESS_DENIED` | 403 |
| profile owned by another user, or no owner id | `PIC_ACCESS_DENIED` | 403 |
| `PENDING` / `SUSPENDED` / `REJECTED` | `PIC_ACCESS_DENIED` | 403 |
| no assignment | `ORGANIZER_ACCESS_DENIED` | 404 |
| assignment of another profile | `ORGANIZER_ACCESS_DENIED` | 404 |
| assignment for another event | `ORGANIZER_ACCESS_DENIED` | 404 |
| `isActive !== true` (incl. truthy non-boolean) | `ORGANIZER_ACCESS_DENIED` | 404 |
| `revokedAt !== null` (incl. `undefined`) | `ORGANIZER_ACCESS_DENIED` | 404 |

Every clause is an explicit allow or an explicit deny; there is no default-allow branch. The
strict `revokedAt` comparison is the fail-closed direction: a partial `select` that leaves the
field `undefined` produces a denial rather than a silent grant.

---

## 8. Organizer isolation analysis

Verified by test against the **real** `decideOrganizerPermission`, not by inspection alone:

| Assertion | Result |
|---|---|
| `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC` is empty | **PASS** |
| A PIC with an ACTIVE `PIC` membership is denied `checkin.scan` at that organizer | **PASS** |
| The same PIC is denied `checkin.override` | **PASS** |
| The same PIC is denied `checkin.log.read` | **PASS** |
| No PIC map holds `checkin.scan` / `checkin.override` / `checkin.log.read` | **PASS** |
| `checkin.scan` is not in `ADMIN_GRANT_REQUIRED` (no `PermissionGrant` bypass) | **PASS** |
| Adding `platformRole`, `organizerScopes` and `grants` to the decider's input changes nothing | **PASS** |
| The input shape contains no organizer/membership/grant field at all | **PASS** |
| The obsolete `pic.checkin.*` vocabulary is gone | **PASS** |

ADMIN and MANAGER semantics were not touched: no map used by them was edited except the
removal of a key they never held.

---

## 9. Decision amendment reference

`docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md` (amendment `P14-AMEND-01`).

- Marked append-only; the Phase 14 lock file was **not** edited.
- Reverses exactly one row: "Scan / validate QR" (design §6.3; locked at Phase 14 §17,
  `P14-D18`) → YES **only** for events assigned to that PIC with an active profile and an
  active, non-revoked assignment.
- Explicitly preserves `NO` for manual check-in override and attendance/check-in log access,
  and preserves the prohibitions on organizer-wide and cross-event authority.
- Records `pic.checkin.scan.own` as a superseded, rejected artifact that must not be re-added.
- States its own precedence and its exclusions (no credential decision, no 3B–3G authority).

---

## 10. Files created and modified

**Created (5):**

| File | Purpose |
|---|---|
| `lib/authz/pic-assignment.ts` | the pure decider + contract types |
| `__tests__/authz/pic-assignment.test.ts` | 42 pure matrix tests |
| `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` | 15-section written contract |
| `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md` | append-only amendment |
| `docs/PHASE_3A_EXECUTION_REPORT.md` | this report |

**Modified: 0 tracked files.** `lib/authz/permissions.ts` was edited by deletion (B-3) and now
matches `HEAD` exactly, so it appears in neither `git status` nor `git diff`.

**Untouched and preserved:** `.cloud-attachments/`, `PROJECT_PRE_FEATURE_AUDIT_REPORT.md`,
`docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md`, and the audit report
`docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md`.

---

## 11. Pure test matrix (42 tests)

| # | Case | Expected | Result |
|---|---|---|---|
| 1 | ACTIVE PIC + active assignment for requested event | ALLOW | **PASS** |
| 2 | ACTIVE PIC + assignment for another event | DENY | **PASS** |
| 3 | ACTIVE PIC + no assignment | DENY | **PASS** |
| 4 | Missing PIC profile | DENY | **PASS** |
| 5 | PENDING profile | DENY | **PASS** |
| 6 | SUSPENDED profile | DENY | **PASS** |
| 7 | REJECTED profile | DENY | **PASS** |
| 8 | Inactive assignment | DENY | **PASS** |
| 9 | Revoked assignment | DENY | **PASS** |
| 10 | Missing event id | DENY | **PASS** |
| 11 | Empty / `null` / whitespace-only / non-string event id | DENY | **PASS** |
| 12 | Incomplete context (`undefined`, `null`) | DENY | **PASS** |
| 13 | Unauthenticated (`undefined`, `null`, `""` user) | DENY | **PASS** |
| 14 | Assignment A cannot authorize event B (both directions) | DENY | **PASS** |
| 15 | Revocation observed on a later call; earlier call unaffected | DENY | **PASS** |
| 16 | Profile owned by another user | DENY | **PASS** |
| 17 | Profile with no owner id | DENY | **PASS** |
| 18 | Assignment belonging to another profile | DENY | **PASS** |
| 19 | Swapped profile + original assignment (cross-PIC ride) | DENY | **PASS** |
| 20 | Truthy non-boolean `isActive` | DENY | **PASS** |
| 21 | `undefined` `revokedAt` | DENY | **PASS** |
| 22 | Assignment with empty event id vs non-empty request | DENY | **PASS** |
| 23 | Input not mutated by the call | **PASS** |
| 24 | Frozen input does not throw | **PASS** |
| 25 | Deterministic result for identical input | **PASS** |
| 26 | No state carried between calls | **PASS** |
| 27 | Input shape carries no organizer/membership/grant channel | **PASS** |
| 28 | Extra organizer/grant state ignored (deny stays deny, allow stays allow) | **PASS** |
| 29 | PIC with ACTIVE membership cannot `checkin.scan` (real decider) | **PASS** |
| 30 | Platform PIC organizer map is empty | **PASS** |
| 31 | No `pic.checkin.*` permission remains | **PASS** |
| 32 | `checkin.scan` not grant-required | **PASS** |
| 33 | No PIC map holds scan / override / log access | **PASS** |
| 34 | Allow result carries only `allowed` + `picProfileId` | **PASS** |
| 35 | Deny result carries only `allowed` + `code` + `reason` | **PASS** |
| 36 | Deny result never carries the profile id | **PASS** |
| 37 | Allow result carries no capability/permission string | **PASS** |

(The suite has **34** `test(...)` / `test.each(...)` declarations. Its three `test.each` tables
(3, 5 and 3 cases) account for 11 executed tests, so (34 − 3) + 11 = **42**. The 37 numbered
rows above are a presentation of those cases, not one test per row: rows 10–11 carry the
5-case event-id table and row 13 the 3-case user table.)

No assertion was weakened, skipped or marked `todo` at any point. The one failing check in
this phase was a TypeScript error in the test file (`[...PERMISSIONS]` on an object); it was
fixed in the source, not in the assertion.

---

## 12. Test command and exact results

The repository's default `npx jest` configuration is not usable for a DB-write-free phase:
`globalSetup` opens a Prisma client against `TEST_DATABASE_URL` to verify migrations, and
`setupFilesAfterEnv` (`jest.teardown-env.ts`) runs `prisma.notification.deleteMany(...)` in
`afterAll` for **every** test file — a real `DELETE`. Per B-6 that is forbidden here, so the
suite was run under an equivalent configuration with the DB hooks omitted:

```
npx jest --config '{"preset":"ts-jest","testEnvironment":"node",
  "moduleNameMapper":{"^@/(.*)$":"<rootDir>/$1"},
  "testMatch":["**/__tests__/authz/pic-assignment.test.ts"],
  "transform":{"^.+\\.tsx?$":["ts-jest",{"tsconfig":"tsconfig.json"}]},
  "forceExit":true}' --runInBand
```

**Result — PASS:** `Test Suites: 1 passed, 1 total` · `Tests: 42 passed, 42 total` ·
`Time: 1.666 s` · exit code `0`.

**Regression run** (same DB-free config, three pure suites):

**Result — PASS:** `PASS __tests__/authz/permission-map.test.ts`,
`PASS __tests__/authz/reconciliation-authorization.test.ts`,
`PASS __tests__/authz/pic-assignment.test.ts` · `Test Suites: 3 passed, 3 total` ·
`Tests: 97 passed, 97 total` · exit code `0`.

`permission-map.test.ts` is the material regression check for this phase: it asserts that every
declared permission has a scope classification and that `PERMISSION_SCOPE.size` equals
`ALL_PERMISSIONS.size`, which is exactly what a careless vocabulary removal would break.

Prisma was never initialised by either run. The suite imports only the decider, the error
codes and the permission maps; no client is constructed and no connection string is read.

---

## 13. TypeScript result

`npx tsc --noEmit` → exit code **0**, no diagnostics. **PASS.**

---

## 14. `git diff --check` result

`git diff --check` → exit code **0**, no whitelisted trailing-whitespace or conflict-marker
output. **PASS.** (`git diff --stat` is empty, since no tracked file differs from `HEAD`.)

---

## 15. Scope compliance

| Item | Result |
|---|---|
| `lib/authz/permissions.ts` — only the B-3 removal | **PASS** (diff vs `HEAD` is empty) |
| `lib/schema`, `prisma/schema.prisma`, `prisma/migrations/**` | **NOT TOUCHED** |
| `lib/ticketing/**` (checkin, validation, issuance, reference, refunds, payment) | **NOT TOUCHED** |
| `app/api/**`, `app/dashboard/**`, `app/ticketing/**` | **NOT TOUCHED** |
| `components/**`, `proxy.ts`, `lib/dashboard/**`, `lib/pic/**` | **NOT TOUCHED** |
| `lib/notifications/**` (dry-run unchanged, no SMTP/Baileys) | **NOT TOUCHED** |
| `package.json`, `package-lock.json` (no install/version change) | **NOT TOUCHED** |
| `.env*`, `.cloud-attachments/**`, the two preserved reports | **NOT TOUCHED** |
| Additional files beyond the approved list | **NONE** — no scope expansion was needed |
| Staging area | **EMPTY** |

`git status --porcelain` filtered against every forbidden path returned `none`.

---

## 16. Database safety confirmation

- Database writes: **NONE.** No connection was opened by this phase's work; both test runs used
  a configuration with no `globalSetup`, no `setupFilesAfterEnv` teardown and no Prisma import.
- Migrations: **NONE.** Seeds: **NONE.** Resets: **NONE.** Cleanups: **NONE.**
- DB-writing integration tests: **NONE RUN.** The `tinggalklik_test` approval (B-6) is for a
  future, separately authorized phase and was not exercised.
- Schema: unchanged. `CheckIn.checkedInByPicProfileId` deliberately not added (B-5).
- Audit records: **NONE WRITTEN** (B-5); Phase 3A adds no audit call site.

---

## 17. Phase 3B–3G exclusion confirmation

Not started, not partially started, not scaffolded:

| Phase | Status |
|---|---|
| 3B — QR validation / `CheckInMethod` labelling | **NOT STARTED** |
| 3C — check-in transaction changes | **NOT STARTED** |
| 3D — PIC scanner API route | **NOT STARTED** |
| 3E — PIC scanner UI | **NOT STARTED** |
| 3F — audit durability, rate limit, PIC attribution | **NOT STARTED** |
| 3G — DB integration tests | **NOT STARTED** |

Confirmed absent: no new API route, no scanner page or component, no `CheckInMethod` or
`CheckInResult` change, no change to `lib/ticketing/checkin/service.ts`, no QR payload or token
change, no rate limiting, no column, no migration, no audit write, no SMTP/Baileys activation,
and no change to the notification dry-run setting.

---

## 18. Remaining risks and limitations

1. **LIMITATION — the repo-wide Jest command was not used.** Its global setup connects to the
   test database and its per-file teardown issues `DELETE`s, both incompatible with B-6. The
   pure suite was therefore run under an equivalent DB-free config (§12). The tests themselves
   are unchanged; only the harness differed. **Consequence:** the full suite was **NOT RUN**,
   so this report makes no claim about integration suites.
2. **LIMITATION — the decider has no consumer yet.** Nothing loads a profile or assignment from
   the database, because that is a later phase. The contract is therefore proven as a rule, not
   as an end-to-end path; a Phase 3D wiring mistake would not be caught by these tests.
3. **RESIDUAL RISK — attribution.** A PIC's scan is attributable only through the existing
   `CheckIn.checkedInByUserId` plus audit JSON (B-5). There is no PIC-specific column, by
   decision. A later migration would be an additive change to decide then, not now.
4. **RESIDUAL RISK — credential (B-2).** The admission credential remains the public ticket
   code. The decider authorizes the *actor*, not the *ticket*; replay by a non-holder before
   the first scan stays undetectable. This is an accepted product decision and is recorded in
   contract §11 so it cannot be quietly re-described as authenticity validation.
5. **RESIDUAL RISK — staleness.** A revocation is observed on the next decision; any future
   cached wiring inherits the existing `AUTHZ_SCOPE_TTL_MS` (≤60 s) bound. The decider itself
   is stateless, so it adds no new staleness.
6. **OUT OF SCOPE — attendance-log masking.** `ALREADY_CHECKED_IN` currently exposes
   `firstCheckedInBy`; contract §10 records that Phase 3E must omit it on a PIC surface. Not a
   defect in this phase, but it must not be forgotten.

---

## 19. Final recommendation

**Phase 3A: PASS WITH LIMITATIONS.** The authorization foundation is implemented, documented,
and pinned by a 42-test pure matrix, with TypeScript clean and no tracked-file change; the two
limitations are the intentionally different test harness and the deliberate absence of wiring.

Phase 3B–3G remain locked. Recommended next step after owner review: authorize **Phase 3B**
only — deciding how `CheckInMethod` is labelled given B-2 — since the credential decision
(public code, not a secret) is what keeps 3B small. No Phase 3B work has begun.

**No commit, no push, no deployment was performed.** HEAD is still
`d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` and the staging area is empty.
