# PHASE 3A.2 — AUTHORIZATION TEST HARDENING REPORT

**Type:** test hardening only (plus this report). Production authorization behaviour unchanged.
**Repository:** `/home/reksa/tinggalklik` · branch `main`
**Baseline HEAD:** `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` (unchanged)
**Findings closed:** L-2, L-3, L-4, I-3
**Final status:** **PASS**

Labels used throughout: **VERIFIED** (checked in this phase, evidence shown) · **TEST RESULT**
(actually executed) · **ASSUMPTION** (reasoned, not executed) · **DEFERRED**.

---

## 1. Executive summary

The independent Phase 3A review found that the PIC authorization decider was correct but its
*test evidence* was thin in four places. This phase closed all four **without touching the
implementation**:

| Finding | Before | After |
|---|---|---|
| **L-2** — three fail-closed guards untested | no rows for `picProfile.id`, `assignment.picProfileId`, `assignment.eventId` | **11** new cases across three tables |
| **L-3** — unknown/malformed values untested | only `1` for `isActive`, only `Date`/`undefined` for `revokedAt`, only the three real enum values for `status` | **12** new cases across three tables |
| **L-4** — denial rows did not assert refusal codes | 9 denial assertions checked only `allowed === false`; helper took `code: string` | every denial goes through a 3-argument helper asserting the exact `AuthzErrorCode`, the HTTP status it maps to, and the refusal envelope; 27 call sites |
| **I-3** — assertion on a literal | asserted a literal key list that survives a widened type | compile-time exactness over `keyof PicScanAuthorizationInput` plus the runtime fixture check |

The suite grew from **42** to **65** executed tests (34 → 40 declarations; 9 `test.each` tables).
All 31 single-declaration titles from the original suite are still present, and every original
case still runs. The decider's files are byte-identical to their pre-edit state (verified by
SHA-256, §12). Tests ran under a database-free Jest configuration: **3 suites, 120 tests, 0
failures, exit 0**. `tsc --noEmit` → **exit 0**.

**No production code changed. No test was weakened or removed. No database was contacted.**

---

## 2. Baseline evidence (before any edit)

**VERIFIED** at the start of the phase:

| Check | Required | Observed |
|---|---|---|
| `git rev-parse --show-toplevel` | `/home/reksa/tinggalklik` | `/home/reksa/tinggalklik` |
| `git branch --show-current` | `main` | `main` |
| `git rev-parse HEAD` | `d0bb0e0…6bd` | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` |
| `git diff --cached --stat` | empty | empty |
| `git diff --stat` | empty | empty (all Phase 3A artifacts untracked) |

Working tree before editing — 11 untracked entries, none modified, all preserved:

```
?? .cloud-attachments/
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/authz/pic-assignment.test.ts
?? docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md
?? docs/PHASE_3A1_DOCUMENTATION_CORRECTION_REPORT.md
?? docs/PHASE_3A_AUTHORIZATION_CONTRACT.md
?? docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md
?? docs/PHASE_3A_EXECUTION_REPORT.md
?? docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md
?? docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md
?? lib/authz/pic-assignment.ts
```

Pre-edit fingerprint of the file under test (recorded so conservation can be proven later):

```
sha256  867b1d19203da7963ecf1d028adde35a81b8d62f945a37cea34b9b9c93c149f5
lines   482
declarations 34
test.each tables 3
```

Pre-edit fingerprints of the files that must **not** change:

```
e6198eea6ab03d584751019f4697cef7bff010d8f7dd0ed934be29dbb6fb930b  lib/authz/pic-assignment.ts
bede72bf6bb0a90f9e0fac5dc3acdaa7c51df2e095fff229fa6124f0d879e5a7  lib/authz/permissions.ts
1be6cca70cb40f75e394eafa26f0fc3e609f31c863073abe328ea2041e03aba5  lib/authz/errors.ts
```

---

## 3. Implementation contract reviewed (Checkpoint 1)

Read in full from `lib/authz/pic-assignment.ts` (209 lines) — the source of truth, not the
contract document. **VERIFIED.**

### 3.1 Input

```ts
type PicProfileSnapshot     = { id: string;        userId: string; status: PICStatus }
type PicAssignmentSnapshot  = { picProfileId: string; eventId: string;
                                isActive: boolean;  revokedAt: Date | null }
type PicScanAuthorizationInput = {
    userId?:      string | null
    picProfile?:  PicProfileSnapshot   | null
    eventId?:     string | null
    assignment?:  PicAssignmentSnapshot | null
}
```

All fields optional and nullable; all snapshot fields `readonly`. No organizer, membership,
grant or scope field exists.

### 3.2 Branches, in evaluation order (this order is itself part of the contract)

| # | Condition (line) | Code | HTTP status |
|---|---|---|---|
| 1 | `!input` (`:133`) | `ORGANIZER_ACCESS_DENIED` | 404 |
| 2 | `!isNonEmptyString(input.userId)` (`:140`) | `UNAUTHORIZED` | 401 |
| 3 | `!isNonEmptyString(input.eventId)` (`:144`) | `NOT_FOUND` | 404 |
| 4 | `!profile \|\| !isNonEmptyString(profile.id)` (`:150`) | `PIC_ACCESS_DENIED` | 403 |
| 5 | `!isNonEmptyString(profile.userId) \|\| profile.userId !== input.userId` (`:155`) | `PIC_ACCESS_DENIED` | 403 |
| 6 | `profile.status !== "ACTIVE"` (`:161`) | `PIC_ACCESS_DENIED` | 403 |
| 7 | `!assignment` (`:170`) | `ORGANIZER_ACCESS_DENIED` | 404 |
| 8 | `!isNonEmptyString(assignment.picProfileId) \|\| assignment.picProfileId !== profile.id` (`:179`) | `ORGANIZER_ACCESS_DENIED` | 404 |
| 9 | `assignment.eventId !== input.eventId` (`:187`) | `ORGANIZER_ACCESS_DENIED` | 404 |
| 10 | `assignment.isActive !== true` (`:194`) | `ORGANIZER_ACCESS_DENIED` | 404 |
| 11 | `assignment.revokedAt !== null` (`:201`) | `ORGANIZER_ACCESS_DENIED` | 404 |
| 12 | otherwise (`:208`) | allow `{ allowed: true, picProfileId }` | — |

Statuses come from `lib/authz/errors.ts:61`–`67`: `UNAUTHORIZED` 401, `FORBIDDEN` 403,
`ORGANIZER_ACCESS_DENIED` **404**, `PIC_ACCESS_DENIED` 403, `NOT_FOUND` 404.

`isNonEmptyString` (`:110`) is `typeof value === "string" && value.trim().length > 0`. Notably
`trim()` is used **only** for the emptiness test: the later comparisons use raw values, so a
whitespace-padded id denies rather than matching. That is why the new L-2/L-3 tables include
padded values.

### 3.3 Behaviour this review had to state precisely, because the tests now pin it

- **Unknown enum values** deny through branch 6 (`!== "ACTIVE"`), so `"active"`, `"DELETED"`,
  `undefined` and `null` all yield `PIC_ACCESS_DENIED` / 403.
- **Malformed booleans**: only the boolean `true` passes; `"true"`, `1`, `undefined`, `null` deny
  at branch 10 with `ORGANIZER_ACCESS_DENIED` / 404.
- **Malformed timestamps**: `revokedAt` is compared strictly against `null`, so `""`, `0`,
  `"null"` and `false` deny at branch 11 (`ORGANIZER_ACCESS_DENIED` / 404) — anything other than
  an actual `null` is treated as a revocation.
- **Reason strings** are server-side detail (`"no PIC profile"`, `"PIC profile status is …"`,
  `"assignment is for a different event"`, …) and the refusal object is exactly
  `{ allowed, code, reason }`.
- **Success condition** is only branch 12: every earlier clause passed.

**No contradiction with the approved Phase 3A contract was found**, so no STOP condition was
triggered. Where the review's summary and the code differ, the code governed (see §6 on the
L-4 count).

---

## 4. L-2 — fail-closed guard tests added

Eleven cases in three tables. Each starts from the unchanged `ctx()` allow baseline and alters
**one** field, so a failure names the guard rather than the fixture. Every case asserts denial,
the exact code, the exact status, and the refusal envelope.

| Table | Cases | Expected |
|---|---|---|
| `picProfile.id` | missing, empty, whitespace only, non-string | `PIC_ACCESS_DENIED` / **403** |
| `assignment.picProfileId` | empty, whitespace only, non-string | `ORGANIZER_ACCESS_DENIED` / **404** |
| `assignment.eventId` | missing, `null`, non-string, whitespace-padded (`" event-a"`) | `ORGANIZER_ACCESS_DENIED` / **404** |

Two properties are pinned beyond "it denies":

1. **Branch order.** An invalid `picProfile.id` also fails the later identity comparison, yet the
   decider answers **403** (`PIC_ACCESS_DENIED`), not the 404 of the assignment branch. Asserting
   the code therefore proves branch 4 fires before branch 8 — the sequence a future refactor
   could silently reorder.
2. **No accidental success.** The helper re-checks the refusal envelope, so a new
   `{ allowed: false }` shape that dropped the code would fail here, not in production.

The baseline was not weakened: `profile()` and `assignment()` default to valid values and the
`ctx()` fixture is untouched.

---

## 5. L-3 — unknown and malformed value tests added

Twelve cases in three tables.

| Table | Cases | Expected |
|---|---|---|
| profile `status` | `"active"` (lowercase), `" ACTIVE"` (padded), `"DELETED"` (outside the enum), `undefined`, `null` | `PIC_ACCESS_DENIED` / **403** |
| `isActive` | `"true"` (string), `undefined`, `null` | `ORGANIZER_ACCESS_DENIED` / **404** |
| `revokedAt` | `""`, `0`, `"null"`, `false` | `ORGANIZER_ACCESS_DENIED` / **404** |

**Type-safe construction.** The declared types forbid these values, and production types were
**not** widened. Instead one narrowly scoped helper carries the cast:

```ts
function malformed<T>(value: unknown): T {
    return value as T;
}
```

It is typed `unknown`, never `any`, and is used only at the points where an unvalidated boundary
value would really arrive (a partial `select`/JSON body). The rationale is documented in the
file: the runtime answer for `"active"` or `"true"` is part of the security contract even though
the TypeScript type excludes it.

The pre-existing rows for `isActive: 1` and `revokedAt: undefined` were kept (with their
assertions strengthened), so the original coverage is a subset of the new coverage rather than
replaced by it.

---

## 6. L-4 — exact refusal codes and helper typing

### 6.1 Re-derived count (the review's number needed correcting)

The brief asked for an exact count. **VERIFIED** from the pre-edit file: **9 denial assertions**
used `allowed(...) === false`, spread over **8 tests**:

| # | Test | Notes |
|---|---|---|
| 1 | active PIC + assignment for ANOTHER event | |
| 2 | active PIC + no assignment | |
| 3–4 | assignment A cannot authorize event B (both directions) | 2 assertions in 1 test |
| 5 | the other PIC's profile plus the original assignment | |
| 6 | a truthy-but-not-boolean `isActive` | |
| 7 | `undefined` `revokedAt` | |
| 8 | assignment with an empty event id | |
| 9 | extra organizer state ignored — "still denied without an assignment" | **omitted from the review's list of seven refs** |

So the review's figure of "nine" is right about assertions, but its line list named only seven of
them; the ninth (the widened object without an assignment, previously the last line of the
B-3 describe) was not listed. Both the count and the omission are recorded here rather than
quietly fixed.

**After hardening: 0 remain.** `grep 'allowed(...) === false'` now matches only the purity test
and the organizer-decider/map assertions, which are not contract denial rows.

### 6.2 The hardened helper

```ts
function expectDenied(
    input: PicScanAuthorizationInput | null | undefined,
    code: AuthzErrorCode,      // was: string
    status: number
): void {
    const result = decidePicEventPermission(input);

    expect(result.allowed).toBe(false);

    if (!result.allowed) {
        expect(result.code).toBe(code);
        expect(new AuthzError(result.code).status).toBe(status);
        expect(Object.keys(result).sort()).toEqual(["allowed", "code", "reason"]);
    }
}
```

Why this shape:

- `code: AuthzErrorCode` is the type **already exported** by `lib/authz/errors.ts`, so an
  invented or misspelled code literal now fails `tsc` instead of passing at runtime. No type was
  duplicated.
- The status is read from `new AuthzError(result.code).status` — the platform's one code→status
  mapping — so the test pins the real contract while `status` stays an explicit expected value at
  each call site. A copy of the mapping inside the test could drift; this cannot.
- The envelope assertion makes "no accidental success" and "no `picProfileId` on a refusal"
  structural for all 27 call sites.
- All 27 call sites pass an explicit status (401 / 403 / 404). **VERIFIED** by counting calls
  (28 including the definition line) against the status literals (27).

### 6.3 Anti-enumeration preserved

The cross-event denial still returns `ORGANIZER_ACCESS_DENIED` **404**, now asserted directly
rather than inferred, and its both-directions variant is asserted twice. The masked-404 policy is
therefore a pinned test expectation, not a comment: changing that branch to 403 turns the suite
red.

---

## 7. I-3 — assessment and outcome

**Original assertion** (pre-edit `:368`): `Object.keys(ctx()).sort()` equals
`["assignment","eventId","picProfile","userId"]`.

**Assessment.** The review was right that this is weak: it proves the *fixture* has four keys,
not that the *type* excludes a fifth. Adding `organizerId?: string` to
`PicScanAuthorizationInput` would still have passed, which is exactly the guarantee the row is
named for.

**Outcome: replaced with a type-oriented assertion** that genuinely verifies the contract:

```ts
const INPUT_KEYS = ["assignment", "eventId", "picProfile", "userId"] as const;
type ExpectedInputKeys = (typeof INPUT_KEYS)[number];
type ActualInputKeys   = keyof PicScanAuthorizationInput;

const noExtraInputKey:   [ActualInputKeys] extends [ExpectedInputKeys] ? true : never = true;
const noMissingInputKey: [ExpectedInputKeys] extends [ActualInputKeys] ? true : never = true;

expect(Object.keys(ctx()).sort()).toEqual([...INPUT_KEYS].sort());
expect([noExtraInputKey, noMissingInputKey]).toEqual([true, true]);
```

Adding any field widens `ActualInputKeys` and resolves the conditional to `never`, so `= true`
stops compiling; removing one fails the opposite direction. The runtime half keeps the fixture
honest, so the type check is about the type the tests actually exercise. The original title is
preserved.

**ASSUMPTION (stated, not executed):** I did not mutate `lib/authz/pic-assignment.ts` to watch
the guard fail, because production files are out of scope for this phase. The mechanism is
standard conditional-type narrowing, and `tsc` accepts the `= true` assignments today, but the
negative case is reasoned rather than demonstrated.

---

## 8. Exact files changed

| Path | Change | Pre → post |
|---|---|---|
| `__tests__/authz/pic-assignment.test.ts` | L-2 (11 cases), L-3 (12 cases), L-4 (helper + 27 call sites), I-3 (type-level assertion) | 482 → 674 lines, sha256 `867b1d19…` → `cbb2fe8a…` |
| `docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md` | this report (new) | — |

**Not modified — VERIFIED by SHA-256 after the edit:**

| File | Hash (identical to pre-edit) |
|---|---|
| `lib/authz/pic-assignment.ts` | `e6198eea…930b` |
| `lib/authz/permissions.ts` | `bede72bf…5a7` |
| `lib/authz/errors.ts` | `1be6cca7…ba5` |

Neither `lib/authz/gates.ts`, `scope.ts`, any route/UI/service/schema/migration, nor any Phase
3A / 3A.1 document nor the review nor the Phase 14 lock was touched. Timestamps confirm it: the
suite is the only artifact with a new mtime (11:12), while the implementation (10:37) and the
review (10:56) retain theirs.

**Test conservation — VERIFIED:** all **31** original single-declaration titles are present
(`kept=31 missing=0`), and the three original `test.each` tables were kept with the same cases
(3, 5 and 3), several with stronger assertions.

---

## 9. Test commands, results and counts

### 9.1 Why the default `npx jest` was avoided (Checkpoint: execution safety)

**VERIFIED** by reading the configuration:

- `package.json:19` — `"test": "jest"` (the default config).
- `jest.config.js` sets `globalSetup: __tests__/support/global-setup.ts`, which constructs a
  `PrismaClient` against `TEST_DATABASE_URL`, and `globalTeardown:
  __tests__/support/fixture-teardown.ts`.
- `jest.config.js` sets `setupFilesAfterEnv: jest.teardown-env.ts`, whose `afterAll` runs
  `prisma.notification.deleteMany(...)` for **every** test file — a real `DELETE`.
- `jest.setup-env.ts` fails closed unless an explicit isolated `TEST_DATABASE_URL` exists.

Running the default config would therefore require a database connection and would execute
destructive teardown. The Phase 3A DB-free invocation was recoverable from
`docs/PHASE_3A_EXECUTION_REPORT.md` §12 and reused verbatim: an inline `--config` that replaces
the whole configuration, so no `setupFiles`, no `setupFilesAfterEnv`, no `globalSetup`, no
`globalTeardown`, and no Prisma import in the suite.

### 9.2 Command actually run

```
npx jest --config '{"preset":"ts-jest","testEnvironment":"node",
  "moduleNameMapper":{"^@/(.*)$":"<rootDir>/$1"},
  "testMatch":["**/__tests__/authz/pic-assignment.test.ts",
               "**/__tests__/authz/permission-map.test.ts",
               "**/__tests__/authz/reconciliation-authorization.test.ts"],
  "transform":{"^.+\\.tsx?$":["ts-jest",{"tsconfig":"tsconfig.json"}]},
  "forceExit":true}' --runInBand
```

**TEST RESULT — PASS:**

```
PASS __tests__/authz/permission-map.test.ts
PASS __tests__/authz/pic-assignment.test.ts
PASS __tests__/authz/reconciliation-authorization.test.ts

Test Suites: 3 passed, 3 total
Tests:       120 passed, 120 total
Time:        1.868 s
exit code    0
```

### 9.3 Counts

| Quantity | Value | How verified |
|---|---|---|
| PIC suite declarations | **40** | `grep -cE '^\s+test(\.each)?\('` (was 34) |
| PIC suite `test.each` tables | **9** | `grep -cE '^\s+test\.each\(\['` (was 3) |
| PIC suite executed tests | **65** | 31 single + (3+5+3) original + (4+3+4) L-2 + (5+3+4) L-3; and 120 total − 55 from the two regression suites |
| New cases this phase | **23** | 11 (L-2) + 12 (L-3) |
| Other suites' tests | 55 | `permission-map` + `reconciliation-authorization`, unchanged |
| Failures | **0** | run output above |

`permission-map.test.ts` remains the material regression guard for the B-3 vocabulary removal
(every declared permission has a scope; `PERMISSION_SCOPE.size === ALL_PERMISSIONS.size`).

---

## 10. TypeScript and diff-check results

| Check | Command | Result |
|---|---|---|
| TypeScript | `npx tsc --noEmit` | **exit 0**, no diagnostics — **PASS** |
| Whitespace/conflict check | `git diff --check` | **exit 0**, no output — **PASS** |

`tsc` also validates the I-3 conditional types: both `= true` assignments compile, which they
would not if the input type had gained or lost a field.

Hygiene of the edited suite: no trailing whitespace, no conflict markers, no CRLF (`0`), UTF-8.

---

## 11. Database safety confirmation

- Database connections: **NONE.** The run's configuration has no `globalSetup`,
  `globalTeardown`, `setupFiles` or `setupFilesAfterEnv`; `jest.setup-env.ts` (the
  `TEST_DATABASE_URL` guard) is therefore not loaded, and the suite imports no Prisma client.
- Database writes: **NONE.** No `deleteMany`, no fixture teardown.
- Migrations, seeds, resets, cleanups, truncations: **NONE.**
- DB integration tests: **NONE RUN.**
- Prisma CLI: **not invoked.**
- Dependencies: **none installed or changed.**
- Environment files: **not read, not modified.**

The only processes started were `jest` (with the inline DB-free config) and `tsc`.

---

## 12. Git safety confirmation

| Check | Required | Observed | Result |
|---|---|---|---|
| `git rev-parse HEAD` | unchanged | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` | **PASS** |
| `git branch --show-current` | `main` | `main` | **PASS** |
| `git diff --cached --stat` | empty | empty | **PASS** |
| `git diff --stat` | empty | empty (artifacts untracked) | **PASS** |
| `git diff --check` | clean | exit 0 | **PASS** |
| `git status --short` | same 11 entries + this report | verified; no `M` entry | **PASS** |
| Phase 14 lock | clean | no porcelain entry | **PASS** |
| Staging / commit / push / deploy | none | none | **PASS** |
| `reset` / `rebase` / `checkout` / `stash` / `clean` | none | none | **PASS** |
| Existing untracked files | preserved | preserved, including both reports | **PASS** |

Because the suite is untracked, `git diff` cannot show its change. Conservation was proven
instead by the pre-edit SHA-256 recorded in §2, the post-edit SHA-256 in §8, the title inventory
(31/31 kept), and the test counts (42 → 65 with no removals).

---

## 13. Deferred findings and limitations

**DEFERRED (out of scope for a test-hardening phase):**

- **I-1** — `lib/authz/pic-assignment.ts` imports `./errors`, which imports `next/server`. Purity
  is behavioural; the module graph still needs the Next runtime. Unchanged.
- **I-2** — deny `reason` strings carry internal state and rely on the future caller not
  serialising them. The hardened helper asserts the envelope, but the discipline itself belongs
  to Phase 3D's error mapping.
- **I-4** — the stale `reference.ts` comment about the raw QR token is a different file and a
  different phase.
- **L-5** — the Phase 3A report's pre-existing-diff evidence remains unverifiable; the state no
  longer exists.

**LIMITATIONS of this phase's verification:**

1. **Statuses are asserted through the real mapping, not over HTTP.** `new AuthzError(code).status`
   is the same function `authzErrorResponse` uses, so a wrong code would fail — but no request was
   sent, so response serialisation is not covered. A route-level round trip is Phase 3D work.
2. **The full Jest suite was not run** (its setup/teardown is database-dependent). No claim is
   made about suites outside `__tests__/authz/`.
3. **The I-3 compile-time guard was not falsified experimentally** (§7, ASSUMPTION): production
   types could not be mutated in this phase to observe `tsc` fail.
4. **The decider still has no production consumer**, so these tests prove the rule, not an
   end-to-end PIC scan. That remains Phase 3D.
5. **No pre-edit copy of the suite was kept on disk** — an extra file would have violated the
   two-path scope. Conservation rests on the recorded hash, the 31/31 title check and the counts.

---

## 14. Recommendation for independent review

The four findings are closed with evidence that is stronger than a passing run: every denial now
pins *which branch* fired (code) and *what the caller would receive* (status), the malformed
inputs are exercised through one documented cast boundary, and the input-shape guarantee is
enforced by the type checker rather than by a fixture.

Suggested review focus:

1. Confirm the L-2/L-3 expected codes match the branch order in §3.2 — they are the assertions a
   future refactor would break first.
2. Confirm the helper's status source (`AuthzError`) is the mapping you want tests to depend on,
   rather than a duplicated table.
3. Decide whether the ninth L-4 assertion the review missed should be called out in the review
   itself (it is now covered, and re-derived here in §6.1).

No implementation change was needed or made, so no new authorization review of
`lib/authz/pic-assignment.ts` is required by this phase. Phase 3B–3G were not started.
