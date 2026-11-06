# PHASE 3A.2 — INDEPENDENT SOURCE REVIEW

**Subject:** `docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md` and the hardened suite
`__tests__/authz/pic-assignment.test.ts`.
**Repository:** `/home/reksa/tinggalklik` · branch `main` · HEAD `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd`.
**Mode:** read-only. No project file was edited, created or deleted except this report. No commit,
push, deploy, stage, reset, rebase, checkout, stash or clean. No database, Prisma CLI, migration,
seed or dependency install was run.
**Verdict:** **PASS WITH LIMITATIONS** — implementation and current test state fully verified;
part of the *pre-edit* evidence is not independently recoverable (see §10).

Labels: **VERIFIED** (re-derived here from the artefact) · **TEST RESULT** (executed in this review)
· **NOT VERIFIED** (evidence insufficient) · **INFORMATIONAL**.

---

## 1. Executive summary

The four findings the hardening phase claimed to close are genuinely closed in the current
working tree, and I was able to re-derive the important claims rather than trust them:

- **L-2** — 11 new cases, three tables (4 + 3 + 4). Each mutates exactly one field of the
  unchanged `ctx()` allow baseline, and every expected code matches the branch the decider
  actually reaches. **VERIFIED.**
- **L-3** — 12 new cases (5 + 3 + 4) covering `status` outside `ACTIVE`, non-boolean `isActive`
  and non-`null` `revokedAt`. The `malformed<T>(value: unknown)` helper does not widen any
  production type and does not make a test vacuous — each case still asserts a refusal.
  **VERIFIED.**
- **L-4** — 27 helper call sites, each with an explicit expected status; `tsc` is clean, which
  proves every code is a member of the exported `AuthzErrorCode` union and every call passes all
  three arguments. A refusal now pins the decision, the exact code, the mapping-derived status and
  the envelope. **VERIFIED**, with two Low findings about residual coverage (§9).
- **I-3** — I falsified the guard *in memory* with the TypeScript compiler API, without touching
  the production type: the baseline compiles, adding a key fails, removing a key fails. This is
  the claim the hardening report could only make as an ASSUMPTION. **VERIFIED.**
- **Counts** — the PIC suite alone executes **65/65**, and the three DB-free suites execute
  **120/120**, matching the report. `tsc --noEmit` → exit 0. **TEST RESULT.**
- **Isolation** — no tracked file changed (`git diff --numstat` is empty), the Jest/package/
  tsconfig files are untouched, the Phase 14 lock is clean, and the implementation hashes equal
  the values the report recorded. **VERIFIED.**

No Critical, High or Medium finding. Two Low findings and five Informational notes, none of which
undermines the security meaning of the matrix.

The limitation that decides the verdict is not in the tests: **the pre-3A.2 suite was untracked and
has been overwritten**, so "31 titles conserved", the 482-line/34-declaration baseline and the
"9 denial assertions" re-derivation cannot be re-derived from the repository. They are internally
consistent and corroborated by the Phase 3A execution report, but they are the phase's own
attestations (§10).

---

## 2. Baseline and Git evidence

### 2.1 Repository state at review time (VERIFIED)

| Check | Observed |
|---|---|
| `git rev-parse --show-toplevel` | `/home/reksa/tinggalklik` |
| `git branch --show-current` | `main` |
| `git rev-parse HEAD` | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` (expected) |
| `git diff --numstat` | **0 lines** — no tracked file modified |
| `git diff --cached --stat` | empty — nothing staged |
| `git diff --check` | exit 0 — no whitespace errors |
| Phase 14 lock (`git status --porcelain`) | empty — clean |
| `git ls-files --error-unmatch __tests__/authz/pic-assignment.test.ts` | "Did you forget to `git add`?" — **untracked** |
| `git status --porcelain` | 12 entries, all `??` |

Untracked entries (12): the 11 that pre-dated Phase 3A.2 plus
`docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md`. This review then adds
`docs/PHASE_3A2_INDEPENDENT_REVIEW.md` (13).

### 2.2 Artefact fingerprints

| File | sha256 | Report's claim |
|---|---|---|
| `lib/authz/pic-assignment.ts` | `e6198eea6ab0…6fb930b` | `e6198eea…930b` — **matches** |
| `lib/authz/permissions.ts` | `bede72bf6bb0…879e5a7` | `bede72bf…5a7` — **matches** |
| `lib/authz/errors.ts` | `1be6cca70cb4…1e03aba5` | `1be6cca7…ba5` — **matches** |
| `__tests__/authz/pic-assignment.test.ts` | `cbb2fe8a2a94…e5c203820` | `cbb2fe8a…` — **matches** |
| `docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md` | `28754ca274ab…3901968b` | — |

The tracked files (`permissions.ts`, `errors.ts`) are additionally proven unmodified **by git**,
independently of the report: HEAD is unchanged and no tracked path differs. For the untracked
`pic-assignment.ts` the only git-level statement is "untracked"; see §8 for the additional
line-anchor evidence.

The report's file was read in full (496 lines) and was not modified by this review; its mtime
(11:14:30) still precedes every read in this review, and the independent Phase 3A review's mtime
(10:56:56) is unchanged.

### 2.3 What cannot be checked

The pre-edit suite (`867b1d19…`, 482 lines, 34 declarations, 3 tables) no longer exists on disk:
the file is untracked, so git holds no copy, and the phase deliberately kept no backup. Every
statement about the *before* state therefore rests on records made by the phase under review, not
on an artefact. Marked **NOT VERIFIED** below where it matters.

---

## 3. Review — L-2 (fail-closed guards)

Three tables, 11 cases. For each case I re-derived the branch the input reaches from
`lib/authz/pic-assignment.ts` and compared it with the asserted code and status.

### 3.1 `picProfile.id` — 4 cases, expected `PIC_ACCESS_DENIED` / 403

`missing` (`malformed<string>(undefined)`), `""`, `"   "`, `malformed<string>(42)`.

All four fail `!profile || !isNonEmptyString(profile.id)` (line 150) → `PIC_ACCESS_DENIED`
→ 403. The only other candidate branch that could also have fired is the
`assignment.picProfileId !== profile.id` comparison (line 179) → `ORGANIZER_ACCESS_DENIED` / 404,
so the asserted **403 vs 404 is exactly what proves branch 4 answered before branch 8** — the
report's claim in §4 is sound. `ctx()` keeps `userId`, `eventId`, `status` and the assignment
defaults intact, so branches 5, 6 and 7 cannot fire.

Exactly one field is mutated per row (`profile({ id })`). **VERIFIED.**

### 3.2 `assignment.picProfileId` — 3 cases, expected `ORGANIZER_ACCESS_DENIED` / 404

`""`, `"   "`, `malformed<string>(7)`.

Each reaches `!isNonEmptyString(...) || ... !== profile.id` (line 179) → 404. Branch 7
(`!assignment`) cannot fire (an assignment object is supplied). One field mutated. **VERIFIED.**

Gap noted as **L-A2-01** (§9): unlike the other two tables, this one has no
`missing`/`undefined` row, so the `typeof value !== "string"` half of `isNonEmptyString` is
exercised for this field only with the number `7`. Behaviourally covered (same clause), but
asymmetric with the described "missing, empty, whitespace, non-string" pattern.

### 3.3 `assignment.eventId` — 4 cases, expected `ORGANIZER_ACCESS_DENIED` / 404

`undefined`, `null`, `malformed<string>(42)`, `" event-a"`.

`assignment.eventId !== input.eventId` (line 187) → 404 for all four. The padded case is
important and correct: `isNonEmptyString` trims only for the *emptiness* test, while the
comparison uses the raw value, so `" event-a"` must deny — and it does. No earlier branch can
intercept (profile, owner, status and `picProfileId` are valid). One field mutated. **VERIFIED.**

### 3.4 Summary for L-2

| Case group | Count | Expected | Branch | Correct? |
|---|---|---|---|---|
| `picProfile.id` | 4 | `PIC_ACCESS_DENIED` 403 | 4 | ✅ |
| `assignment.picProfileId` | 3 | `ORGANIZER_ACCESS_DENIED` 404 | 8 | ✅ |
| `assignment.eventId` | 4 | `ORGANIZER_ACCESS_DENIED` 404 | 9 | ✅ |
| **Total** | **11** | | | matches report |

No baseline weakening: `profile()`, `assignment()` and `ctx()` defaults are unchanged
(`ACTIVE`, `USER`, `PROFILE`, `EVENT_A`, `isActive: true`, `revokedAt: null`), and `ctx()` is
still the single allow fixture used by the original matrix.

---

## 4. Review — L-3 (malformed values)

### 4.1 `status` — 5 cases, expected `PIC_ACCESS_DENIED` / 403

`"active"`, `" ACTIVE"`, `"DELETED"`, `undefined`, `null`.

`profile.status !== "ACTIVE"` (line 161) → 403 for all five. `" ACTIVE"` is correctly expected to
deny because the comparison is raw (no trim), unlike the id checks. `"DELETED"` is outside
`PICStatus` yet denied safely at runtime. Branches 4 and 5 cannot fire (`id`/`userId` valid).
**VERIFIED.**

### 4.2 `isActive` — 3 cases, expected `ORGANIZER_ACCESS_DENIED` / 404

`"true"` (string), `undefined`, `null`.

`assignment.isActive !== true` (line 194) → 404. The pre-existing row `isActive: 1` is still
present separately in the "fail closed" describe, so the truthy-non-boolean family is covered by
four values, not three. **VERIFIED.**

### 4.3 `revokedAt` — 4 cases, expected `ORGANIZER_ACCESS_DENIED` / 404

`""`, `0`, `"null"`, `false`.

`assignment.revokedAt !== null` (line 201) → 404. Every value is non-`null`, so each is treated as
a revocation — the fail-closed direction. The pre-existing `revokedAt: undefined` row is retained
(also 404). Notably `0` and `false` are *falsy*, and would have been the fail-open candidates if
the guard had been written as a truthiness test; asserting them is the right shape of test.
**VERIFIED.**

### 4.4 Is `malformed<T>(value: unknown)` acceptable?

```ts
function malformed<T>(value: unknown): T {
    return value as T;
}
```

- **No production type changed.** `lib/authz/pic-assignment.ts` is byte-identical to the recorded
  pre-edit hash; `PicProfileSnapshot.status` is still `PICStatus`, `isActive` still `boolean`,
  `revokedAt` still `Date | null`.
- **No `any`.** `grep -nw 'any'` matches only two prose words in comments; the parameter is
  `unknown` and the cast is `as T`, i.e. one explicit, localised unchecked assertion per call
  site, all of them inside the L-3 tables.
- **Does it hide a weak test?** No: the cast only *constructs* the input. Every case still asserts
  `allowed === false` **and** the exact code and status, so a decider that accepted `"active"` or
  `"true"` would fail the test rather than pass it silently. The one thing a cast can do — make a
  case unreachable — is not the situation here: each value reaches the branch its label names
  (§4.1–4.3).
- **Residual concern:** 19 `malformed<…>` invocations are all compile-time-typed to the *declared*
  type, so a reader cannot tell from the signature alone which values are unrealistic. The
  nearby doc comment and the `%s` labels mitigate this. **INFORMATIONAL.**

---

## 5. Review — L-4 (exact refusal assertions)

### 5.1 Call-site inventory

`grep -cE '^\s+expectDenied\('` → **27**. Each call site is a separate line; `grep -c 'expectDenied'`
→ 29 (27 calls + definition + one comment). All 27 pass three arguments: `tsc --noEmit` exits 0,
and a missing argument or a non-`AuthzErrorCode` string would be a compile error. **VERIFIED.**

Distribution by expected code/status (from the source):

| Code | Status | Call sites |
|---|---|---|
| `ORGANIZER_ACCESS_DENIED` | 404 | 16 |
| `PIC_ACCESS_DENIED` | 403 | 7 |
| `UNAUTHORIZED` | 401 | 3 |
| `NOT_FOUND` | 404 | 5 |
| **Total** | | **27** (two tests contain two calls each) |

`NOT_FOUND` (event-id table, 5 cases) and `ORGANIZER_ACCESS_DENIED` include the cross-event rows;
`PIC_ACCESS_DENIED` covers the status, owner and profile-id families; `UNAUTHORIZED` covers the
three user-id cases. Every pairing is confirmed by the green run: the helper compares the literal
status with `new AuthzError(result.code).status`, so a swapped pair cannot pass.

### 5.2 The helper's guarantees

```ts
expect(result.allowed).toBe(false);
if (!result.allowed) {
    expect(result.code).toBe(code);
    expect(new AuthzError(result.code).status).toBe(status);
    expect(Object.keys(result).sort()).toEqual(["allowed", "code", "reason"]);
}
```

- **Exact code** — asserted against the union-typed parameter. ✅
- **Exact status through the real mapping** — `AuthzError` is the same mapping
  `authzErrorResponse` uses (`errors.ts:61`–`67`, `:96`), so the test cannot drift from the
  runtime contract while the literal at the call site keeps the expectation visible. ✅
- **Envelope** — a refusal with an extra key (notably `picProfileId`) fails; a refusal missing
  `reason` fails. `sort()` makes key order irrelevant. ✅
- **Anti-enumeration** — cross-event denies with `ORGANIZER_ACCESS_DENIED` (404) on *both*
  directions, now asserted rather than inferred. Changing that branch to 403 or to
  `PIC_ACCESS_DENIED` turns the suite red. ✅

### 5.3 Blind spots found

1. **No `reason` assertion** (**L-A2-02**). Codes are pinned, but branches 4/5/6 all return
   `PIC_ACCESS_DENIED`/403 and branches 7/8/9/10/11 all return `ORGANIZER_ACCESS_DENIED`/404.
   Branch identity within a family is guaranteed only by the *construction* (one field mutated
   from a valid baseline), not by the assertion. That is sufficient today — every L-2/L-3 row
   leaves exactly one clause as a candidate — but a future row that changed two fields at once
   could go green while proving the wrong guard. Asserting the `reason` prefix would close it at
   the cost of coupling tests to detail strings (which the contract treats as server-side only).
2. **`allowed === false` asserted twice per call** (once in the helper, once via the narrowing
   `if`). Harmless, only redundancy.
3. **`status: number` is unconstrained.** Not exploitable: the comparison is against the mapping,
   so only 401/403/404 can pass. **INFORMATIONAL.**

### 5.4 One refusal row outside the helper

The test "a denied decision never carries the profile id" (`:170`–`:177`) calls
`decision(ctx({ assignment: null }))`, asserts `allowed === false` and the envelope, but **not**
the code/status; the purity test at `:529`–`:531` also asserts a bare `false`. Neither weakens the
matrix (the same denial is asserted fully elsewhere), but the hardening report's absolute phrasing
— "every denial goes through a 3-argument helper" — is not literally true. **INFORMATIONAL**
(I-A2-01), report accuracy only.

### 5.5 The count correction in the hardening report

The report says the Phase 3A review's "nine deny rows" actually lists seven references, one of
which (`test:208`) contains two assertions, plus one omitted row. **Consistent with the review as
written**: the Phase 3A review's L-4 paragraph cites `test:139`, `:146`, `:208`, `:268`, `:287`,
`:300`, `:314` = 7 refs; `:208` is the both-directions row (2 assertions) → 8; the 9th is the
"extra organizer state / still denied without an assignment" assertion, which the Phase 3A
execution report documents as matrix row 28 ("deny stays deny"). The phase's arithmetic therefore
reconciles. However, the pre-edit file is gone, so the 9-vs-8 distribution cannot be independently
re-verified. **PARTIALLY VERIFIED** (see §10).

---

## 6. Review — I-3 (compile-time exactness)

### 6.1 The assertion as written

```ts
const INPUT_KEYS = ["assignment", "eventId", "picProfile", "userId"] as const;
type ExpectedInputKeys = (typeof INPUT_KEYS)[number];
type ActualInputKeys = keyof PicScanAuthorizationInput;
const noExtraInputKey:   [ActualInputKeys]   extends [ExpectedInputKeys] ? true : never = true;
const noMissingInputKey: [ExpectedInputKeys] extends [ActualInputKeys]   ? true : never = true;
expect(Object.keys(ctx()).sort()).toEqual([...INPUT_KEYS].sort());
expect([noExtraInputKey, noMissingInputKey]).toEqual([true, true]);
```

`keyof PicScanAuthorizationInput` today is exactly
`"userId" | "picProfile" | "eventId" | "assignment"`. The tuple-wrapped conditionals give a
two-way exact-equality test, and `= true` on a `never` annotation is a compile error.

### 6.2 Experimental falsification (executed in memory, no file written)

The hardening report could only call this an ASSUMPTION. I reproduced the type and assertion in
memory with the TypeScript compiler API (`ts.createCompilerHost` serving a virtual source; no
project file touched, production type untouched) — **TypeScript 5.9.3**, `strict`:

| Variant | Result |
|---|---|
| baseline, four exact keys | **compiles cleanly** |
| plus `organizerId?: string \| null` | **TYPE ERROR — Type 'true' is not assignable to type 'never'.** |
| minus `eventId` | **TYPE ERROR — Type 'true' is not assignable to type 'never'.** |

Both directions of the guard are therefore **real, not theoretical**. The runtime half keeps the
fixture honest about the four fields the contract names, so the compile-time check is applied to
the type the tests actually exercise. **VERIFIED.**

### 6.3 Residual notes

- The guard protects the *input type's own keys*, not the shape of the nested snapshots (e.g. a
  new `organizerId` inside `PicProfileSnapshot` would not trip it). That is the correct scope for
  the row's claim ("the input carries no organizer channel").
- A future index signature (`[key: string]: unknown`) on the input type would make
  `keyof …` = `string | number` and the guard would fail — the desired direction.

---

## 7. Test integrity and conservation

### 7.1 Shape of the current suite (VERIFIED)

| Quantity | Observed |
|---|---|
| Lines | 674 |
| `test(...)` / `test.each(...)` declarations | **40** |
| `test.each` tables | **9** |
| Single-declaration tests | **31** (40 − 9) |
| Executed tests (PIC suite alone) | **65/65 PASS**, exit 0 |
| Executed tests (3 DB-free suites) | **120/120 PASS**, exit 0 |
| `expect(...)` assertions | 35 |
| `expectDenied` call sites | 27 |
| Skipped / focused / todo (`test.skip`, `.only`, `test.todo`, `xit`, `xdescribe`) | **none** |

Count reconciliation: 31 singles + 11 original table cases (3 + 5 + 3) + 11 L-2 + 12 L-3 = **65**,
matching the report's §9.3 formula. **TEST RESULT.**

### 7.2 Conservation of the original cases

Two independent angles:

1. **Against the Phase 3A execution report's matrix** (written before 3A.2, untracked but not
   edited by this phase — mtime 11:02, before the suite edit at 11:12). All 37 numbered rows are
   still represented in the current suite: allow/delay rows 1–9, the 5-case event-id table (rows
   10–11), incomplete context (12), the 3-case user table (13), both-direction cross-event (14),
   revocation-on-later-call (15), the four cross-PIC rows (16–19), truthy non-boolean `isActive`
   (20), `undefined` `revokedAt` (21), empty assignment event id (22), the four purity tests
   (23–26), the input-shape row (27, now strengthened), organizer state ignored (28), the
   organizer-decider rows (29–30), the vocabulary/map rows (31–33), the allow envelope (34), the
   deny envelope (35), "deny never carries the profile id" (36) and "allow carries no capability"
   (37).
2. **Against the report's 31-title inventory**: all 31 titles are present verbatim
   (`kept=31 missing=0`).

The second check uses the report's own list, so it is circular in isolation; the first does not,
and it is the stronger evidence. **Conservation: STRONGLY CORROBORATED**, with the caveat that the
literal pre-edit file cannot be compared line-for-line.

### 7.3 No weakening

- No assertion was relaxed: every original denial row that only checked `allowed` now checks code
  + status + envelope (§5).
- The three original tables keep their exact case sets (3 statuses, 5 event ids, 3 users).
- The baseline fixture is unchanged, so "still passes" is not the result of an easier fixture.
- No `skip`/`only`/`todo` sneaked in (§7.1).
- `tsc --noEmit` exits 0, so no `@ts-expect-error`-style suppression is carrying the suite.

### 7.4 The DB-free configuration is genuinely DB-free (VERIFIED)

`npx jest --config '<inline DB-free JSON>' --showConfig` reports:

```
"setupFiles": [],
"setupFilesAfterEnv": [],
```

and contains **no** `globalSetup` / `globalTeardown` keys. The inline `--config` replaces the
project configuration entirely, so the hooks in `jest.config.js`
(`globalSetup: __tests__/support/global-setup.ts`,
`globalTeardown: __tests__/support/fixture-teardown.ts`,
`setupFiles: jest.setup-env.ts`, `setupFilesAfterEnv: jest.teardown-env.ts`) never load.
`jest.teardown-env.ts` is the one that would execute
`prisma.notification.deleteMany(...)` in `afterAll` for every file — a real `DELETE` — so omitting
it is the difference between a read-only run and a destructive one.

The suite's imports are `import type { PICStatus } from "@prisma/client"` (type-only, erased) and
three `@/lib/authz/*` modules. There is no `@/lib/prisma` import and no `prisma` identifier outside
comments. The run produced no database error and needed no `TEST_DATABASE_URL`, which is itself
evidence that no client was constructed.

**Caveat:** `@/lib/authz/errors` imports `next/server` at runtime, so the "pure" suite still loads
the Next runtime (the known I-1). No database surface, but not dependency-free.

---

## 8. Production isolation

| Check | Evidence | Result |
|---|---|---|
| No tracked file modified | `git diff --numstat` → 0 lines; HEAD unchanged | **VERIFIED** |
| `lib/authz/pic-assignment.ts` unchanged | sha256 `e6198eea…930b` equals the report's pre-edit value; branch anchors still at the documented lines (133, 140, 144, 150, 155, 161, 170, 179, 187, 194, 201, 208) and the reason strings at `:157`, `:164`, `:173`, `:183`, `:190`, `:197`, `:204` still match both the code and the Phase 3A review's citations | **VERIFIED (hash is the phase's own record; line anchors are independent)** |
| `lib/authz/permissions.ts`, `errors.ts` unchanged | exact hashes + git shows no modification | **VERIFIED** |
| Routes / UI / services / schema / migrations | no tracked diff; no new tracked path | **VERIFIED** |
| Jest / package / tsconfig configuration | `git diff -- jest.config.js package.json package-lock.json tsconfig.json` → empty | **VERIFIED** |
| Phase 14 lock | `git status --porcelain PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` → clean | **VERIFIED** |
| Phase 3A / 3A.1 documents and the Phase 3A review | not modified; review mtime still 10:56:56 | **VERIFIED** |
| Hidden side effects of the test edit | the only non-test path written by the phase is its own report; the suite is untracked and imported by nothing outside `__tests__/authz` | **VERIFIED** |

---

## 9. Findings

### CRITICAL — none

### HIGH — none

### MEDIUM — none

### LOW

**L-A2-01 — `assignment.picProfileId` table omits the missing/`undefined` case.**
The `picProfile.id` and `assignment.eventId` tables both include a `missing` row; the
`assignment.picProfileId` table covers `""`, `"   "` and the number `7` only. The
`typeof value !== "string"` half of `isNonEmptyString` is therefore exercised for this field with
a number but not with `undefined`/`null`, which is the shape a partial `select` actually
produces. Behaviour is covered by the same clause and the risk is low, but the asymmetry is worth
one line in a future test-only phase. *No production action; not a defect.*

**L-A2-02 — Refusal `reason` strings are never asserted, so branch identity within a code family
rests on fixture construction.**
Branches 4/5/6 share `PIC_ACCESS_DENIED`/403 and 7/8/9/10/11 share
`ORGANIZER_ACCESS_DENIED`/404. Today every row mutates exactly one field from a valid baseline, so
only one clause can fire and the test does pin the intended guard. A future row that changed two
fields would still pass while testing a different branch than its title claims. Options: assert a
`reason` prefix (couples tests to server-side detail), or keep the one-field rule as an explicit
review checklist item (cheaper). *No change needed now.*

### INFORMATIONAL

**I-A2-01 — The hardening report's "every denial goes through" the helper is imprecise.**
One contract refusal row (`:170`–`:177`) asserts the envelope without the code, and the purity
probe (`:531`) asserts a bare `false`. Both are intentional; the sentence should read "every
contract denial row except the envelope test".

**I-A2-02 — `expectDenied`'s `status` is `number`, not a union.** Not exploitable, because the
value is compared with `AuthzError`'s mapping, which admits only 401/403/404. Tightening it would
add a second source of truth; leaving it is reasonable.

**I-A2-03 — The "9 denial assertions" re-derivation is only partially verifiable.** It reconciles
with the Phase 3A review's seven references plus the documented row 28, but the pre-edit file no
longer exists. The phase recorded this as a limitation itself (§13.5) — good practice, and the
reason this review does not treat it as a defect.

**I-A2-04 — The hardened suite is untracked, so the guarantee currently lives only in the working
tree.** This is correct for a phase forbidden to commit, but it means CI and any other clone do not
yet have the 23 new cases, and a `git clean` would erase them. The next authorized step should
include the commit.

**I-A2-05 — The suite still loads `next/server` transitively** (`@/lib/authz/errors` → `next/server`),
so "pure" remains behavioural (Phase 3A I-1). No database or network access occurs, and no I/O is
performed by the decider.

---

## 10. Limitations of this review

1. **Pre-edit artefacts are not recoverable.** The suite was untracked and was overwritten in
   place; no backup was kept (deliberately, to respect the two-path scope). Consequently the
   482-line / 34-declaration / 3-table baseline, the 31-title inventory and the "9 assertions over
   8 tests" figure are **NOT VERIFIED** as historical fact. They are consistent with each other,
   with the Phase 3A execution report and with the current 65-test run.
2. **No HTTP-level verification.** Statuses are asserted through `AuthzError`'s mapping, not
   through a route response. Serialisation (`{ success: false, code, message }`) is out of scope and
   remains Phase 3D work.
3. **The full Jest suite was not run** — by design, because its `globalSetup`/`teardown` require a
   database and perform writes. No statement is made about suites outside `__tests__/authz/`.
4. **The I-3 experiment used a faithful replica of the type** (the four optional fields and their
   nested snapshot shapes), not the imported type itself. It demonstrates the conditional-type
   mechanics; `tsc --noEmit` on the real project demonstrates that the real assertion holds today.
5. **No production consumer exists**, so these tests prove the rule, not an end-to-end scan.

---

## 11. Verdict

**PASS WITH LIMITATIONS.**

Rationale: the hardening phase's four findings are genuinely closed, with verification that is
stronger than the phase could claim for itself — the I-3 guard was falsified in memory in both
directions, the 27 helper call sites are proven well-typed by a clean `tsc`, the 65/120 counts
reproduce exactly, no test is skipped or weakened, the DB-free configuration provably has no DB
hooks, and no production or configuration artefact changed.

The limitations are evidentiary, not behavioural: the *before* state cannot be re-derived from the
repository, statuses are not exercised over HTTP, and the hardened suite is not yet committed. Two
Low findings (one missing `undefined` row in one table; no `reason` assertion) are noted for a
future test-only phase and do not affect the security meaning of the matrix.

No Critical, High or Medium finding was found, so the "stop and report" rule was not triggered.

---

## 12. Recommended next steps

1. **Commit the Phase 3A/3A.2 artefacts** (suite + decider + the four documents) so the 23 new
   cases become durable and CI-visible; the working tree is currently the only copy
   (I-A2-04).
2. In a future test-only phase, add the `undefined` row to the `assignment.picProfileId` table for
   symmetry with the other L-2 tables (L-A2-01).
3. Decide explicitly whether refusal `reason` strings should be asserted (L-A2-02); my
   recommendation is to keep them unasserted and instead keep the "one field per row" rule as a
   standing review check, because reasons are documented as server-side detail.
4. Proceed to Phase 3D's consumption work only when authorized: map `PicScanAuthorizationDecision`
   through `AuthzError`/`authzErrorResponse` rather than serialising it, which is what actually
   resolves I-2.
5. Do **not** treat this review as approval to start Phase 3B–3G; nothing beyond 3A.2 was examined.

---

## Appendix — files read and created by this review

**Read (no modification):**
`__tests__/authz/pic-assignment.test.ts` · `lib/authz/pic-assignment.ts` ·
`lib/authz/errors.ts` · `lib/authz/permissions.ts` · `jest.config.js` ·
`jest.setup-env.ts` · `jest.teardown-env.ts` ·
`docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md` ·
`docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md` (L-2…I-3 sections) ·
`docs/PHASE_3A_EXECUTION_REPORT.md` §11–§12.

**Created:** `docs/PHASE_3A2_INDEPENDENT_REVIEW.md` (this file).

**Executed (read-only):** `git rev-parse/status/diff/ls-files` · `sha256sum` · `grep` ·
`wc` · `npx jest --config '<DB-free inline>' --showConfig` ·
`npx tsc --noEmit` · `node` with the TypeScript compiler API on an **in-memory** virtual source.

**Not executed:** default `npx jest`, any Prisma command, any database connection, any
installation, any git write operation.
