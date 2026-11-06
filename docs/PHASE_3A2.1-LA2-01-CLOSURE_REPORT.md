# PHASE 3A.2.1 — L-A2-01 CLOSURE REPORT

**Date:** 2026-11-06 · **Repository:** `/home/reksa/tinggalklik` · branch `main` ·
HEAD `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` (unchanged throughout).
**Scope:** test-only. Exactly one test row added; exactly one document created. No production
change, no database access, no staging, no commit, no push, no deploy.

**Verdict: PASS.**

---

## 1. Objective and original finding

The Phase 3A.2 independent review recorded one Low finding:

> **L-A2-01 — `assignment.picProfileId` table omits the missing/`undefined` case.**
> The `picProfile.id` and `assignment.eventId` tables both include a `missing` row; the
> `assignment.picProfileId` table covers `""`, `"   "` and the number `7` only. The
> `typeof value !== "string"` half of `isNonEmptyString` is therefore exercised for this field
> with a number but not with `undefined`/`null`, which is the shape a partial `select` actually
> produces.
> — `docs/PHASE_3A2_INDEPENDENT_REVIEW.md` §9

and flagged it again in its §12 recommendation 2: "add the `undefined` row to the
`assignment.picProfileId` table for symmetry with the other L-2 tables".

**Objective of this phase:** close exactly that gap with one test row, without touching production
authorization behaviour, other tests, fixtures, helpers or reports.

**Out of scope, and deliberately not done:** asserting refusal `reason` strings (L-A2-02), adding
any other row, refactoring, widening a production TypeScript type, any production or configuration
edit, and any Phase 3B work.

---

## 2. Initial state (recorded before editing)

| Check | Observed |
|---|---|
| `pwd` | `/home/reksa/tinggalklik` |
| `git branch --show-current` | `main` |
| `git rev-parse HEAD` | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` — **same HEAD as the reviewed baseline** |
| `git status --short` | 13 entries, all `??` (12 pre-existing + the 3A.2 review report) |
| `git diff --numstat` | 0 lines — no tracked file modified |
| `git diff --cached --stat` | empty — nothing staged |
| Phase 14 lock | `git status --porcelain PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` → clean |
| `__tests__/authz/pic-assignment.test.ts` | sha256 `cbb2fe8a…e5c203820`, 674 lines, mtime 11:12 |
| `lib/authz/pic-assignment.ts` | sha256 `e6198eea…6fb930b`, mtime 10:37 |
| `lib/authz/permissions.ts` | sha256 `bede72bf…879e5a7` |
| `lib/authz/errors.ts` | sha256 `1be6cca7…1e03aba5` |
| `docs/PHASE_3A2_INDEPENDENT_REVIEW.md` | sha256 `48e5c20d…d81927013`, mtime 11:27 |
| `docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md` | sha256 `28754ca2…3901968b` |

All artefact hashes equal the values recorded by the Phase 3A.2 hardening report and the independent
review, so the tree is the same object that was reviewed. **No material discrepancy was found**, so
the phase proceeded. Nothing from the previous phase was modified or deleted.

---

## 3. Exact file changed

**Modified:** `__tests__/authz/pic-assignment.test.ts` (untracked before and after).

- 674 → **675 lines** (+1).
- sha256 `cbb2fe8a…e5c203820` → `4e1ad84b…64bcfb951`.
- Declarations unchanged: **40** `test(...)`/`test.each(...)` (9 tables, 31 singles).
- `expectDenied` call sites unchanged: **27**.

**Created:** `docs/PHASE_3A2.1-LA2-01-CLOSURE_REPORT.md` (this file).

**Nothing else changed** (§10).

---

## 4. Exact test added

One row, added as the **first** row of the existing `assignment.picProfileId` table in the
`describe("L-2 — assignment.picProfileId must name the same profile")` block — the same position and
the same wording convention ("`missing`") as the `picProfile.id` and `assignment.eventId` tables:

```ts
describe("L-2 — assignment.picProfileId must name the same profile", () => {
    test.each([
        ["missing", malformed<string>(undefined)],
        ["empty", ""],
        ["whitespace only", "   "],
        ["a non-string", malformed<string>(7)],
    ])("assignment.picProfileId is refused when it is %s", (_label, picProfileId) => {
        expectDenied(
            ctx({ assignment: assignment({ picProfileId }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });
});
```

- Table cases: 3 → **4**; the `%s` title renders "assignment.picProfileId is refused when it is
  missing".
- Reuses the existing helpers unchanged: `ctx()`, `assignment()`, `malformed<T>(value: unknown)`
  and `expectDenied(input, code, status)`. No helper was edited, added or widened.
- **Only the targeted field changes.** `assignment()` is `{ ...defaults, ...over }`, so passing
  `undefined` *overrides* the valid default (`picProfileId: PROFILE`) with `undefined`; the spread
  order is what makes this row a real `undefined` rather than a silent fallback to the valid value.
  `userId`, `picProfile` (id, userId, status), `eventId`, `isActive` and `revokedAt` all keep their
  valid baseline values.
- Provider of the cast is the pre-existing `malformed()` used by every neighbouring row; it is typed
  `unknown` → `T`, never `any`, and no production type was widened.

**Proof that exactly one line was added:** deleting the added line (line 415) from the current file
and re-hashing reproduces the pre-edit hash **byte for byte**:

```
$ awk -v n=415 'NR!=n' __tests__/authz/pic-assignment.test.ts | sha256sum
cbb2fe8a2a9414c57ad401d242259400f1d0dd3066002db49229332e5c203820  -
pre-edit hash : cbb2fe8a2a9414c57ad401d242259400f1d0dd3066002db49229332e5c203820  (identical)
```

No other byte in the file changed — no reformatting, no reordering, no comment edit.

---

## 5. Expected code and status, and why the row reaches that branch

- **Expected:** `AuthzErrorCode.ORGANIZER_ACCESS_DENIED`, HTTP **404**.
- **Branch reached:** `lib/authz/pic-assignment.ts:178`–`184` —
  `if (!isNonEmptyString(assignment.picProfileId) || assignment.picProfileId !== profile.id)`
  → `ORGANIZER_ACCESS_DENIED`. With `picProfileId === undefined`, the first operand is true.
- **No earlier branch can fire:** input present (branch 1), `userId` non-empty string (2),
  `eventId = EVENT_A` (3), profile present with non-empty `id` (4), `profile.userId === USER` (5),
  `status === "ACTIVE"` (6), assignment present (7).
- **The assertion is exact, not merely a refusal:** `expectDenied` asserts `allowed === false`, the
  literal code, `new AuthzError(result.code).status === 404` (the real code→status mapping) and the
  refusal envelope keys `["allowed", "code", "reason"]`. A row that fell through to a later guard
  (9/10/11, also 404) would still be caught only by the code — and 404 for a *profile* mismatch
  versus 404 for a *revoked* assignment is distinguished by the `reason`, which L-A2-02 deliberately
  leaves unasserted; here the single-field construction guarantees branch 8 is the only candidate.
- The row fails loudly if the guard is removed: without it, the profile-id mismatch would be
  compared and would still deny at branch 8, so the regression signal for this specific clause comes
  from the code + the single-field construction — the same guarantee every other row in this table
  already relies on. No new weakness is introduced.

---

## 6. Focused test result — PIC authorization suite

Command (the verified DB-free inline configuration; the project's default configuration, which
contains the database `globalSetup`/`globalTeardown`, was **not** used):

```bash
npx jest --config '{"preset":"ts-jest","testEnvironment":"node","moduleNameMapper":{"^@/(.*)$":"<rootDir>/$1"},"testMatch":["<rootDir>/__tests__/authz/pic-assignment.test.ts"],"transform":{"^.+\\.tsx?$":["ts-jest",{"tsconfig":"tsconfig.json"}]},"forceExit":true}' --runInBand
```

```
Test Suites: 1 passed, 1 total
Tests:       66 passed, 66 total
Snapshots:   0 total
Time:        1.573 s
exit code    0
```

**66/66 — matches the expected count** (65 + 1). The new row executed and passed; no test was
skipped.

---

## 7. Combined DB-free result — three suites

The three pure suites documented by the Phase 3A execution report §12 (97 tests before Phase 3A.2)
and used by the 3A.2 hardening report (120 tests):

```bash
npx jest --config '<same DB-free inline config, testMatch = the three files>' --runInBand
```

```
PASS __tests__/authz/pic-assignment.test.ts
PASS __tests__/authz/permission-map.test.ts
PASS __tests__/authz/reconciliation-authorization.test.ts

Test Suites: 3 passed, 3 total
Tests:       121 passed, 121 total
Snapshots:   0 total
Time:        2.083 s
exit code    0
```

**121/121 — matches the expected count** (120 + 1).

Arithmetic check: 66 (PIC) + 17 (`permission-map`) + 38 (`reconciliation-authorization`) = 121;
the previous run of the same trio was 120.

> **Note on method, for transparency:** my first combined attempt used
> `permission-map` + `route-classification` + `pic-assignment` and produced **103/103 passing**
> (exit 0). That set is not the trio the previous phases used, so it could not answer the "121
> expected" check; I then read the trio's identity out of `docs/PHASE_3A_EXECUTION_REPORT.md`
> §12 and re-ran the documented set. Both runs passed; the 103 run is recorded here rather than
> omitted, and it changed nothing in the tree. It also confirmed `route-classification` is an
> additional DB-free suite that this phase does not claim.

---

## 8. TypeScript result

```bash
npx tsc --noEmit
exit code 0
```

No output. The new row type-checks under the project's `strict` configuration, which also proves
`AuthzErrorCode.ORGANIZER_ACCESS_DENIED` is a member of the exported union and that
`expectDenied` still receives all three arguments.

---

## 9. Diff-check result

```bash
git diff --check
exit code 0
```

Because the suite is **untracked**, `git diff --check` cannot inspect it; the file was therefore also
checked directly:

```bash
grep -nP '[ \t]+$' __tests__/authz/pic-assignment.test.ts
# trailing whitespace: none
```

No trailing whitespace, no tabs-vs-spaces drift introduced (`file -bi` → UTF-8, no CRLF).

---

## 10. Production isolation verification

| Check | Evidence | Result |
|---|---|---|
| Only the permitted test file changed | `git diff --numstat` → 0 tracked lines; the sole content change is the +1 line proven in §4 | **PASS** |
| `lib/authz/pic-assignment.ts` untouched | sha256 `e6198eea6ab03d584751019f4697cef7bff010d8f7dd0ed934be29dbb6fb930b` — identical to the reviewed value; mtime still 10:37 | **PASS** |
| `lib/authz/permissions.ts` untouched | sha256 `bede72bf…879e5a7` — identical | **PASS** |
| `lib/authz/errors.ts` untouched | sha256 `1be6cca7…1e03aba5` — identical | **PASS** |
| Other authz suites untouched | `permission-map` `d8fc5d1c…`, `reconciliation-authorization` `98955769…` — unchanged (they were only read/run, never written) | **PASS** |
| Jest / package / tsconfig configuration | `jest.config.js` `283d2e6b…`, `package.json` `593775f2…`; no tracked diff on either | **PASS** |
| Existing reports untouched | 3A.2 report still `28754ca2…3901968b`; independent review still `48e5c20d…d81927013`, mtime 11:27 | **PASS** |
| Phase 14 decisions/lock | `git status --porcelain PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` → clean; mtime 2026-09-19 | **PASS** |
| No existing untracked artefact deleted or overwritten | all 13 pre-existing `??` entries are still present (the report adds a 14th) | **PASS** |
| No authorization behaviour change | test-only edit; production hash set identical; behaviour assertions unchanged | **PASS** |

---

## 11. Database safety verification

- **No** database connection, query, Prisma command, migration, seed, reset or teardown was executed.
- The project's default Jest configuration — the one that wires
  `globalSetup: __tests__/support/global-setup.ts`,
  `globalTeardown: __tests__/support/fixture-teardown.ts`,
  `setupFiles: jest.setup-env.ts`, `setupFilesAfterEnv: jest.teardown-env.ts` (the last of which
  runs `prisma.notification.deleteMany(...)` after every file) — was **never** used.
- Both runs used the inline DB-free `--config`, which replaces the project config entirely.
  `--showConfig` on that inline config reports:

  ```
  "setupFiles": [],
  "setupFilesAfterEnv": [],
  ```

  and **no** `globalSetup` / `globalTeardown` keys.
- The only Prisma references in the executed suites are type-only imports that are erased at
  compile time: `import type { PICStatus } from "@prisma/client"` (pic-assignment) and
  `import type { OrganizerMemberRole, PlatformRole } from "@prisma/client"`
  (reconciliation-authorization). No `PrismaClient` is constructed, no `TEST_DATABASE_URL` is read,
  and no database is contacted — which is why both runs succeed with no database reachable.
- No dependency was installed; `node_modules` was used as-is.

---

## 12. Final Git status

```
$ git status --short
?? .cloud-attachments/
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/authz/pic-assignment.test.ts
?? docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md
?? docs/PHASE_3A1_DOCUMENTATION_CORRECTION_REPORT.md
?? docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md
?? docs/PHASE_3A2_INDEPENDENT_REVIEW.md
?? docs/PHASE_3A2.1-LA2-01-CLOSURE_REPORT.md
?? docs/PHASE_3A_AUTHORIZATION_CONTRACT.md
?? docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md
?? docs/PHASE_3A_EXECUTION_REPORT.md
?? docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md
?? docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md
?? lib/authz/pic-assignment.ts

$ git diff --numstat          # 0 lines
$ git diff --cached --stat    # empty
$ git rev-parse HEAD          # d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd
$ git branch --show-current   # main
```

14 untracked entries (13 pre-existing + this report). **Nothing staged, no commit, no push, no
deploy, no branch or HEAD change.** All changes remain unstaged for owner review.

---

## 13. Remaining limitations

1. **L-A2-02 remains open by instruction.** Refusal `reason` strings are still unasserted, so
   within a code family (403 `PIC_ACCESS_DENIED`, 404 `ORGANIZER_ACCESS_DENIED`) branch identity is
   guaranteed by the one-field-per-row construction rather than by the assertion. This row follows
   that rule.
2. **Pre-edit hash is attestation-based.** The single-line proof (§4) compares against
   `cbb2fe8a…`, the hash recorded by the Phase 3A.2 report and the independent review. The file is
   untracked, so git cannot corroborate it independently — but the reconstruction is deterministic
   and reproducible by anyone with the current file.
3. **No HTTP-level round-trip.** The status is proven through `AuthzError`'s mapping, not through a
   route response.
4. **The suite is still untracked.** The guarantee lives only in this working tree until the
   artefacts are committed.
5. **No production consumer exists yet**, so the matrix proves the rule rather than an end-to-end
   scan.
6. **The full Jest suite was not run** — it requires the database setup this phase forbade.

---

## 14. Final verdict

**PASS.**

Every mandatory verification was performed and passed: the targeted suite is **66/66** and the
documented DB-free trio is **121/121** (both exit 0), `npx tsc --noEmit` exits 0, `git diff --check`
exits 0 with no trailing whitespace, the change is provably one added line, only the permitted test
file was touched, no production or configuration hash changed, no database was contacted, and
nothing was staged, committed, pushed or deployed. The initial HEAD was unchanged from the reviewed
baseline, so no discrepancy had to be reported.

L-A2-01 is **CLOSED**. L-A2-02 and the informational notes from the 3A.2 review are untouched and
remain owner decisions.

**Stopping here for owner review; not starting Phase 3B.**
