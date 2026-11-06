# PHASE 3A — INDEPENDENT SOURCE REVIEW

**Type:** independent, read-only source audit. No source, test or documentation file was
modified; no test suite was executed; no database was contacted.
**Repository:** `/home/reksa/tinggalklik` · branch `main`
**HEAD during review:** `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` (unchanged)
**Reviews:** `docs/PHASE_3A_EXECUTION_REPORT.md` and the four artifacts it describes
**Final status:** **PASS WITH LIMITATIONS**

This review was performed by inspecting the files on disk, `git` metadata, and read-only
text scans. Every claim below names a file and line, or records that it could not be checked.

---

## 1. Executive summary

The Phase 3A authorization core is sound. `lib/authz/pic-assignment.ts` implements exactly the
B-1 predicate, fails closed on every branch, carries no organizer/membership/grant channel, and
is covered by a matrix whose 42 cases match the 34 test declarations statically
(3 `test.each` tables expand 3 + 5 + 3). The removal of `PIC_CHECKIN_SCAN_OWN` is complete:
`lib/authz/permissions.ts` is byte-identical to `HEAD`, no `pic.checkin.*` string remains in
the vocabulary, and no PIC map holds `checkin.scan`, `checkin.override` or `checkin.log.read`.

**No CRITICAL or HIGH finding exists in the implementation.** The defects found are
documentation-citation defects and test-strength gaps:

- **MEDIUM ×2** — both are wrong pointers into the Phase 14 lock: the cited path
  `docs/PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` **does not exist** (the file is at the
  repository root), and `§6.3` is a section of the *design* document quoted *inside* the lock,
  not a section of the lock itself. The content the amendment quotes is verbatim-accurate;
  only the addresses are wrong.
- **LOW ×5** — a miscounted footnote in the execution report, five untested-but-correct
  edge states, unasserted refusal codes on nine deny rows (including the cross-event row),
  a weakly typed test helper, and unverifiable pre-existing-diff evidence in the report.
- **INFORMATIONAL ×4** — transitive `next/server` import, `reason`-string discipline that
  relies on the future caller, a structural test that asserts a literal instead of the type,
  and a pre-existing `reference.ts` comment that disagrees with issuance behaviour.

Counts: **0 CRITICAL · 0 HIGH · 2 MEDIUM · 5 LOW · 4 INFORMATIONAL · 0 blocking**.
The implementation is safe to keep; the two MEDIUM items should be corrected before this
documentation is treated as the permanent record, and no repair was performed in this audit.

---

## 2. Git baseline evidence

Verified at the start of the review:

| Check | Required | Observed | Result |
|---|---|---|---|
| `git rev-parse --show-toplevel` | `/home/reksa/tinggalklik` | `/home/reksa/tinggalklik` | **PASS** |
| `git branch --show-current` | `main` | `main` | **PASS** |
| `git rev-parse HEAD` | `d0bb0e0…6bd` | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` | **PASS** |
| `git diff --cached --stat` | empty | empty | **PASS** |
| `git diff --stat` (tracked) | empty | empty | **PASS** |
| `git diff --exit-code -- lib/authz/permissions.ts` | 0 (identical to `HEAD`) | exit `0`, no output | **PASS** |
| Baseline commits | 4 | `d0bb0e0`, `dd6d32d`, `4da6dc5`, `89b6717` | **PASS** |

Working tree before the audit (9 untracked entries, 0 modified):

```
?? .cloud-attachments/
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/authz/pic-assignment.test.ts
?? docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md
?? docs/PHASE_3A_AUTHORIZATION_CONTRACT.md
?? docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md
?? docs/PHASE_3A_EXECUTION_REPORT.md
?? docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md
?? lib/authz/pic-assignment.ts
```

No stop condition was triggered: branch and HEAD match, staging is empty, and the only
difference from the Phase 3A report is the presence of the report's own artifacts. The
`M lib/authz/permissions.ts` entry that existed at Phase 3A's CHECKPOINT 0 is **absent**,
consistent with the B-3 removal described in the report.

---

## 3. The five files reviewed (read in full, not sampled)

| File | Lines | Read |
|---|---|---|
| `lib/authz/pic-assignment.ts` | 209 | in full |
| `__tests__/authz/pic-assignment.test.ts` | 482 | in full |
| `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` | 332 | in full |
| `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md` | 115 | in full |
| `docs/PHASE_3A_EXECUTION_REPORT.md` | 419 | in full |

Supporting files also read, because the contract and report make verifiable claims about them:
`lib/authz/errors.ts`, `lib/authz/permissions.ts`, `lib/authz/scope.ts` (via search with
context), `lib/dashboard/gates.ts` (via search with context), `lib/dashboard/scope.ts`
(signature), `lib/ticketing/tickets/reference.ts`, `lib/ticketing/audit-log.ts` (key list),
`prisma/schema.prisma` (check-in / PIC regions), `__tests__/support/global-setup.ts`,
`jest.setup-env.ts`, `jest.teardown-env.ts`, and the actual Phase 14 lock
(`PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md`, 891 lines).

---

## 4. Source implementation findings

### 4.1 Structure

`lib/authz/pic-assignment.ts` exports exactly: `PicProfileSnapshot`,
`PicAssignmentSnapshot`, `PicScanAuthorizationInput` (`:75`), `PicScanAuthorizationDecision`,
and `decidePicEventPermission` (`:130`). Two private constructors (`allow`, `deny`) and one
guard (`isNonEmptyString`, `:110`) complete the file. There is no other export, no I/O call,
no module-level mutable state, and no import other than a **type-only** `PICStatus` (`:1`) and
`AuthzErrorCode` from `./errors` (`:3`).

### 4.2 Clause-by-clause match with the contract

The contract's §2 predicate lists nine conjunctive clauses. Each is present, in the same order,
with no extra allow path:

| Contract clause | Code | Line |
|---|---|---|
| `userId` non-empty | `if (!isNonEmptyString(input.userId))` → `UNAUTHORIZED` | `:140` |
| `eventId` non-empty | `if (!isNonEmptyString(input.eventId))` → `NOT_FOUND` | `:144` |
| profile exists and has an id | `if (!profile \|\| !isNonEmptyString(profile.id))` | `:150` |
| profile belongs to the actor | `if (!isNonEmptyString(profile.userId) \|\| profile.userId !== input.userId)` | `:155` |
| `status === "ACTIVE"` | `if (profile.status !== "ACTIVE")` | `:161` |
| assignment exists | `if (!assignment)` | `:170` |
| assignment is this profile's | `assignment.picProfileId !== profile.id` | `:179` |
| assignment is this event's | `if (assignment.eventId !== input.eventId)` | `:187` |
| `isActive === true` | `if (assignment.isActive !== true)` | `:194` |
| `revokedAt === null` | `if (assignment.revokedAt !== null)` | `:201` |
| allow | `return allow(profile.id)` | `:208` |

The single `return allow(...)` sits after every conjunct, so **no** refusal path can reach it
and there is no default-allow branch. Ordering matches contract §2 ("checked in that order").

### 4.3 Purity, as implemented

- No `await`, no `async`, no promise, no callback, no dynamic import inside the module.
- No environment read, no `Date.now()`, no randomness.
- The argument is only read; `allow`/`deny` construct fresh objects.

The module header's claim that `decideOrganizerPermission` is not consulted is confirmed: the
file does not import `./permissions` at all. See INFORMATIONAL I-1 for the one nuance
(transitive `next/server`).

### 4.4 Defects found in the implementation

**None.** No clause is unreachable, duplicated, or evaluated in an order that could grant.
`isNonEmptyString` (`:110`) trims only for the emptiness test; comparisons use the raw values
and therefore deny on whitespace-padded input — fail-closed, as intended.

---

## 5. Security findings

### A. Identity binding — **PASS**

`userId` must be a non-empty string (`:140`); `picProfile.id` must be non-empty (`:150`);
`picProfile.userId` must equal `userId` (`:155`). Cross-PIC use is closed twice: the profile
must belong to the actor, and the assignment must name *that* profile id (`:179`). Tests
`:247`, `:254`, `:261`, `:268` prove the four cross-PIC shapes, including the "swap only the
profile, keep the assignment" construction at `:268`, which is the realistic attack.

### B. Event binding — **PASS**

`assignment.eventId !== input.eventId` (`:187`) is an exact comparison against the requested
event, after both have passed the non-empty guard. There is no organizer identifier anywhere in
the input type (`:75`–`:82`), so no organizer-wide fallback is expressible; the module imports
nothing that could supply one. Tests `:135`–`:145` (A-vs-B, both directions at `:208`) and the
"assignment with empty event id" row (`:314`) cover the failure modes.

### C. Profile state — **PASS**

`profile.status !== "ACTIVE"` (`:161`) is an exact comparison against the only accepted value.
`PENDING`, `SUSPENDED`, `REJECTED` and any unknown value all deny through the same branch —
the reason string interpolates the value (`:164`) but the decision is a deny. Tests `:150` and
`:154`–`:164`. The `PICStatus` enum in `prisma/schema.prisma:551` has exactly
`PENDING / ACTIVE / SUSPENDED / REJECTED`, so the branch is complete for the real domain.

### D. Assignment state — **PASS**

`isActive !== true` (`:194`) rejects truthy non-booleans (`1`, `"true"`); `revokedAt !== null`
(`:201`) rejects any non-null value **including `undefined`**, so a partial Prisma `select`
denies instead of granting. Tests `:287` (truthy `1`) and `:300` (`undefined`) pin exactly
these two. This is the strongest part of the implementation: both comparisons are strict, so
the two most common "looks fine in TypeScript" failures are closed.

### E. Authorization isolation — **PASS**

| Property | Evidence |
|---|---|
| No `AuthzScope` | `PicScanAuthorizationInput` (`:75`) has four fields, none of them a scope; the module never imports `./permissions` |
| No organizer membership bypass | No organizer field exists; "extra organizer state ignored" test `:375` |
| No `PermissionGrant` bypass | Grants are not read anywhere in the module; `checkin.scan` is not in `ADMIN_GRANT_REQUIRED` (`permissions.ts` set, verified), test `:449` |
| ADMIN/MANAGER not widened | No map entry changed except the removed key; `git diff` empty |
| PIC gets no `checkin.override` | Absent from all three PIC maps; test `:458` |
| PIC gets no `checkin.log.read` | Same; test `:458` and `:472` |
| Organizer decider still denies a PIC | Test `:397` calls the **real** `decideOrganizerPermission` with an ACTIVE `PIC` membership and asserts denial for all three check-in permissions |

I also confirmed independently, in `lib/authz/permissions.ts`, that
`PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC` is `toSet([])`, `MEMBERSHIP_ROLE_PERMISSIONS.PIC`
holds only `PIC_ATTRIBUTION_READ_ALL`, and `PLATFORM_ROLE_OWN_PERMISSIONS.PIC` contains no
`checkin.*` key. The three check-in permissions remain `ORGANIZER`-scope. The removal left no
dangling reference: `OWN_SCOPE` ends at `REPORT_EXPORT_OWN_PIC_FEE`, and the file compiles as
written (see Limitations — `tsc` was not re-run).

### F. Refusal behaviour — **PASS**, with one policy note

Codes map exactly as `lib/authz/errors.ts:61`–`67` defines them:

| Code used | Status in `errors.ts` | Consistent |
|---|---|---|
| `UNAUTHORIZED` | 401 | **PASS** |
| `PIC_ACCESS_DENIED` | 403 | **PASS** |
| `ORGANIZER_ACCESS_DENIED` | 404 | **PASS** |
| `NOT_FOUND` | 404 | **PASS** |

The anti-enumeration policy is applied as the contract claims: every **assignment** refusal is
`ORGANIZER_ACCESS_DENIED` (404), so "not assigned" and "event does not exist" are the same
answer, provided the future caller loads the assignment (and not the event) first. Profile
refusals are 403 — that discloses only the actor's *own* account state, not another tenant's
resources, so it is not an enumeration oracle.

Note (not a defect): the 404 asymmetry is only preserved if the Phase 3D route does **not**
pre-check event existence and answer differently. That obligation is written into contract §6
but is not enforceable in this module; it belongs on the 3D checklist.

### G. Data leakage — **PASS**

- Allow result: `{ allowed: true, picProfileId }` (`:117`–`119`) — the actor's **own** profile
  id, which the actor already knows; no assignment id, organizer id, ticket data or credential.
  Tests `:111` and `:472` assert the key set.
- Deny result: `{ allowed: false, code, reason }` (`:121`–`126`) — no profile id (test `:122`),
  no assignment contents, no organizer scope, no grant details.
- `reason` strings carry internal state (see I-2). They are documented as server-side only and
  are never placed in an HTTP body by this module, which returns a decision, not a response.

---

## 6. 42-test assertion mapping

Statically derived, without executing anything: the file contains **34** `test(...)` /
`test.each(...)` declarations, of which **3** are `test.each` tables of 3, 5 and 3 rows.
`(34 − 3) + 11 = 42`, matching the report's count. Each row below is one executed test, in
file order, with the security property it proves and the assertion that proves it.

| # | Line | Test | Security property | Assertion | Verdict |
|---|---|---|---|---|---|
| 1 | `:107` | is allowed | allow row exists | `allowed === true` | **PASS** |
| 2 | `:111` | allow carries profile id and nothing else | result shape | `keys.sort() === ["allowed","picProfileId"]`; `picProfileId === PROFILE` | **PASS** |
| 3 | `:122` | denied never carries the profile id | deny result shape | `keys.sort() === ["allowed","code","reason"]` | **PASS** |
| 4 | `:135` | active + active assignment → ALLOW | B-1 allow | `allowed === true` | **PASS** |
| 5 | `:139` | assignment for ANOTHER event → DENY | event binding | `allowed === false` | **PASS*** |
| 6 | `:146` | no assignment → DENY | default deny | `allowed === false` | **PASS*** |
| 7 | `:150` | missing profile → DENY | profile presence | `code === PIC_ACCESS_DENIED` | **PASS** |
| 8 | `:154` | PENDING profile | profile state | `code === PIC_ACCESS_DENIED` | **PASS** |
| 9 | `:155` | SUSPENDED profile | profile state | `code === PIC_ACCESS_DENIED` | **PASS** |
| 10 | `:156` | REJECTED profile | profile state | `code === PIC_ACCESS_DENIED` | **PASS** |
| 11 | `:165` | inactive assignment | assignment state | `code === ORGANIZER_ACCESS_DENIED` | **PASS** |
| 12 | `:172` | revoked assignment | assignment state | `code === ORGANIZER_ACCESS_DENIED` | **PASS** |
| 13 | `:180` | event id missing | event binding | `code === NOT_FOUND` | **PASS** |
| 14 | `:181` | event id `null` | fail closed | `code === NOT_FOUND` | **PASS** |
| 15 | `:182` | event id empty | fail closed | `code === NOT_FOUND` | **PASS** |
| 16 | `:183` | event id whitespace | fail closed | `code === NOT_FOUND` | **PASS** |
| 17 | `:184` | event id wrong type | prototype/type confusion | `code === NOT_FOUND` | **PASS** |
| 18 | `:192` | incomplete context (`undefined`, `null`) | fail closed | `code === ORGANIZER_ACCESS_DENIED` (both) | **PASS** |
| 19 | `:197` | user missing | unauthenticated | `code === UNAUTHORIZED` | **PASS** |
| 20 | `:198` | user `null` | unauthenticated | `code === UNAUTHORIZED` | **PASS** |
| 21 | `:199` | user empty | unauthenticated | `code === UNAUTHORIZED` | **PASS** |
| 22 | `:208` | A cannot authorize B, both directions | **core** event binding | `allowed === false` (both) | **PASS*** |
| 23 | `:230` | revoked after a prior allow | no caching | allow → deny → allow | **PASS** |
| 24 | `:247` | profile owned by another user | identity binding | `code === PIC_ACCESS_DENIED` | **PASS** |
| 25 | `:254` | profile with no owner id | fail closed | `code === PIC_ACCESS_DENIED` | **PASS** |
| 26 | `:261` | assignment of another profile | cross-PIC | `code === ORGANIZER_ACCESS_DENIED` | **PASS** |
| 27 | `:268` | other PIC's profile + original assignment | cross-PIC ride | `allowed === false` | **PASS*** |
| 28 | `:287` | truthy non-boolean `isActive` | fail closed | `allowed === false` | **PASS*** |
| 29 | `:300` | `undefined` `revokedAt` | fail closed | `allowed === false` | **PASS*** |
| 30 | `:314` | assignment with empty event id | event binding | `allowed === false` | **PASS*** |
| 31 | `:328` | input not mutated | purity | deep-equal snapshot after call | **PASS** |
| 32 | `:337` | frozen input | purity | `not.toThrow()` and allow | **PASS** |
| 33 | `:350` | deterministic | purity | two calls deep-equal | **PASS** |
| 34 | `:356` | no state between calls | purity | allow/deny/allow | **PASS** |
| 35 | `:368` | input carries no organizer channel | isolation | `keys.sort()` literal | **PASS** (see I-3) |
| 36 | `:375` | extra organizer state ignored | no widening | deny without assignment, allow with | **PASS** |
| 37 | `:397` | PIC never tenant-wide via real decider | isolation | 3 × `allowed === false` on `decideOrganizerPermission` | **PASS** |
| 38 | `:429` | platform PIC organizer map empty | isolation | `[...PIC].length === 0` | **PASS** |
| 39 | `:439` | no `pic.checkin.*` remains | vocabulary | `Object.entries(PERMISSIONS).filter(...)` is `[]` | **PASS** |
| 40 | `:449` | scan not grant-required | no grant bypass | not in `ADMIN_GRANT_REQUIRED`; no `checkin*` in it | **PASS** |
| 41 | `:458` | no PIC map holds scan/override/log | isolation | 3 maps × 3 permissions all `false` | **PASS** |
| 42 | `:472` | decision grants no log capability | B-4 | key set lacks `permissions`; payload lacks `checkin.log` | **PASS** (weak but valid) |

`*` = the denial is proven, but the **refusal code** the contract assigns to that state is not
asserted on this row (see L-4).

**Do the tests exercise the implementation, or restate assumptions?** They exercise it. Every
row calls the exported `decidePicEventPermission` and asserts on its return value; the two
"isolation" clusters (`:397`, `:429`) call the *real* `decideOrganizerPermission` and read the
*real* exported maps rather than re-declaring them. The only assertions that are partially
tautological are `:368` (asserts a literal key list about a test-built object — I-3) and
`:472` (asserts the absence of a key that was never designed in — a valid but low-value proof).

**False positives / over-strong-looking but weak assertions:** `:375`'s `allowed(widened) ===
true` proves the allow is *unchanged* by organizer state, but not that grants were "ignored"
in any deep sense — the decider has no code that could read them, which is the stronger fact
and is proven structurally by the import list, not by this test. No test can pass while the
implementation is wrong in the property it names.

**Contradictions between tests and contract:** none found.

---

## 7. Documentation consistency

Checked across the contract, the amendment and the execution report.

| Property | Contract | Amendment | Report | Consistent |
|---|---|---|---|---|
| Exactly one Phase 14 row reversed (scan) | §1 B-1, §14 | §2 table | §9 | **PASS** |
| Manual override stays **NO** | §8 | §2, §4 | §3 | **PASS** |
| Attendance / check-in log stays **NO** | §9 | §2, §4 | §3 | **PASS** |
| Own-scan result ≠ attendance list | §10 (explicit two-column split) | §4 | §3 B-4 | **PASS** |
| Public ticket code not identity authentication | §11 (what it does / does not prove) | §5 | §3 B-2 | **PASS** |
| B-5 forbids a migration/column | §12, §14 | §5 | §3, §16 | **PASS** |
| B-6 forbids DB writes in 3A | §13 | — (out of amendment scope) | §3, §16 | **PASS** |
| No 3B–3G authority granted | §15 | §5 | §17, §19 | **PASS** |
| `permissions.ts` edit is a removal only | §14 | §6 | §4, §10 | **PASS** |
| Decider signature / result shapes | §2 | §3 | §5, §6 | **PASS** |

Cross-checks of the documents against the rest of the repository:

| Document claim | Verified against | Result |
|---|---|---|
| `resolveAuthzScope` returns `null` for a deactivated account (contract §3) | `lib/authz/scope.ts:85`–`87` (`if (!user \|\| user.disabledAt) return null`) | **PASS** |
| Gate list resolves through `organizerIdsWith(scope, CHECKIN_SCAN)` (contract §9) | `lib/dashboard/gates.ts:56`, and `:58` returns empty when there are no tenants | **PASS** |
| Admission credential is `TICKET:<ticketCode>` (contract §11) | `lib/ticketing/tickets/reference.ts` — `TICKET_QR_PREFIX = "TICKET:"`, `buildTicketQrPayload` | **PASS** |
| 256-bit secret hashed into `Ticket.qrTokenHash`, never delivered | `reference.ts` (`QR_TOKEN_BYTES = 32`, `hashQrToken`), issuance discards the raw value | **PASS** (see I-4) |
| `CheckIn.checkedInByUserId` records the actor (contract §12) | `prisma/schema.prisma:1231`, non-null, FK to `user` | **PASS** |
| `FORBIDDEN_METADATA_KEYS` blocks token/QR keys (contract §12) | `lib/ticketing/audit-log.ts:281`–`297` — includes `token`, `secret`, `qrcode`, `qrtoken` | **PASS** |
| `PICEventAssignment` is unique per (profile, event) (contract §4) | `prisma/schema.prisma:1489` | **PASS** |
| `PICStatus` is the four-value enum (contract §3) | `prisma/schema.prisma:551`–`555` | **PASS** |
| The lock file was not edited (amendment §1, report §9) | `git diff` empty; lock persists at root | **PASS** |
| The amendment's three quoted rows | `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md:540` — verbatim match | **PASS** |
| The quoted prohibition ("must not pass a platform PIC or a membership PIC through the check-in guard") | same file `:551` — verbatim match | **PASS** |
| The repo-wide Jest command is DB-touching (report §12) | `__tests__/support/global-setup.ts` builds a `PrismaClient`; `jest.teardown-env.ts` runs `prisma.notification.deleteMany(...)` after every file | **PASS** |

**Two citation defects (M-1, M-2)** qualify the last four rows: the *content* is right, the
*address* is wrong. See §9.

---

## 8. Untracked-file hygiene

`git diff --check` cannot see untracked files, so the five artifacts were scanned directly.

| Check | Method | Result |
|---|---|---|
| Trailing whitespace | `grep -nP '[ \t]+$'` over all five | **PASS** — no matches |
| Conflict markers | `grep -nE '^(<<<<<<<\|=======\|>>>>>>>)'` | **PASS** — none |
| CRLF / mixed endings | `grep -c $'\r'` | **PASS** — `0` in every file |
| Encoding | `file -bi` | **PASS** — `charset=utf-8` in all five; no BOM (`grep`-visible content starts at byte 0) |
| Secret-like strings | API-key / password / bearer / `mysql://` / `DATABASE_URL=` / `SMTP_PASS` / `APP_KEY` patterns | **PASS** — none |
| Long opaque runs (40+ base64/hex) | `grep -nEo '[A-Za-z0-9+/]{40,}={0,2}'` | **PASS** — only the baseline SHA `d0bb0e0…` (4 occurrences) and one prose word `existence/ownership/…`; no credential |
| Environment values | spot-check of the same scan | **PASS** — no host, port, user or DSN appears |
| TODO / FIXME / XXX / HACK | `grep -nE 'TODO\|FIXME\|XXX\|HACK'` | **PASS** — none |
| Non-ASCII content | byte scan per file | **INFO** — box-drawing/em-dash/§ characters only (9 / 34 / 32 / 16 / 57 lines), consistent with the repository's existing documentation style (`permissions.ts`, `errors.ts` use the same glyphs) |

No file needed repair, and none was touched.

---

## 9. Findings by severity

### CRITICAL — 0

None. No path allows a PIC to scan an unassigned event, another PIC's assignment, or an event
under a non-ACTIVE profile; no path widens organizer authority.

### HIGH — 0

None.

### MEDIUM — 2

**M-1 — The Phase 14 lock is cited at a path where it does not exist.**
`docs/PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` is referenced at
`docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md:5`, `:18`, and
`docs/PHASE_3A_AUTHORIZATION_CONTRACT.md:330`. That path does not exist
(`ls` → "No such file"; `git ls-files docs` → no Phase 14 document). The actual file is
`PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` at the **repository root** (891 lines), alongside
`PHASE_17_*`, `PHASE_18A_*` and `PHASE_20A_*` decision locks. Impact: an append-only amendment
whose entire authority is "this amends that lock, which stands unedited" points a reader at
nothing; the verification trail breaks at the first hop. The amendment's other statements
about the lock are accurate — only the address is wrong.

**M-2 — `§6.3` is cited as a section of the lock, but the lock has no §6.3.**
The amendment's header (`:5`), opening (`:18`), table captions (`:21`, `:39`), preservation
note (`:85`) and precedence clause (`:112`–`:113`) all treat "§6.3" as a section of the Phase 14
lock. The lock's own headings run `## 6. COMPLETED Contract` (`:246`) straight to
`## 7. Grace Window` (`:267`) — there is no §6.3. `§6.3` is a section of the **design**
document (`TICKETING_PHASE1_DESIGN.md`) that the lock *quotes* at `:80`; the locked PIC rows
themselves live at `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md:538`–`551` (**§17 PIC Access**)
and in the decision table as `P14-D18` (`:678`). Impact: a reader checking "§6.3 of the lock"
finds nothing, and cannot confirm that the amendment targets the right text. Correct addresses:
**lock §17 + `P14-D18`, quoting design §6.3**.

### LOW — 5

**L-1 — The execution report's `test.each` footnote miscounts its own expansion mechanism.**
`docs/PHASE_3A_EXECUTION_REPORT.md:275` reads "(Rows 11, 13, 5–7 are `test.each` tables, so 37
rows expand to 42 executed tests.)". Rows 5–7 are three *rows of one* table
(`__tests__/authz/pic-assignment.test.ts:154`), not tables, and contribute no expansion; the
+5 comes from the event-id table (5 cases, `:179`, split across rows 10–11) and the user table
(3 cases, `:197`, row 13). The total of 42 is correct — verified statically as 34 declarations
minus 3 tables plus 3+5+3 cases — but the explanation of it is wrong, and the explanation is
what a future auditor would use to re-derive the count. Also, the table's row 11
("Empty / whitespace-only / non-string event id") omits the `null` case that the table at
`:181` actually runs, which is why row 10 + row 11 must total 5 rather than 4.

**L-2 — Three fail-closed guards are correct but untested.** The decider guards
`picProfile.id` (`lib/authz/pic-assignment.ts:150`), `assignment.picProfileId` (`:179`) and
`assignment.eventId` (`:187`) with `isNonEmptyString`/exact comparison, but the suite only
exercises the whitespace/missing form for `eventId` (`test:183`). Whitespace-only profile ids,
a non-string `assignment.eventId`, and an empty `picProfile.id` have no row. The code is right;
the coverage is not, and a future refactor of `isNonEmptyString` would not be caught here.

**L-3 — Unknown-value fail-closed paths are untested.** `profile.status !== "ACTIVE"`
(`:161`) denies unknown strings, `undefined`, `null` and lowercase variants, but the suite only
runs the three other enum members (`test:154`–`:156`). Similarly, `isActive: "true"` (string)
is denied by `:194` but only the numeric `1` is tested (`test:287`), and a malformed
`revokedAt` such as `""` is denied by `:201` but only `Date` and `undefined` are tested. These
are the states a partial `select` or an untyped JSON boundary would actually produce, so they
are the most valuable rows to add when tests are next authorized to change.

**L-4 — Nine deny rows assert the decision but not the refusal code.** Rows at `test:139`,
`:146`, `:208`, `:268`, `:287`, `:300`, `:314` use the `allowed(...)` helper, which returns
only `.allowed`; the surrounding test therefore proves "denied" but not "`ORGANIZER_ACCESS_DENIED`
(404)". This matters most for `:139`/`:208` (assignment for another event), because the
anti-enumeration design in contract §6 rests on that state being a **404**, not a **403** — a
future change from `ORGANIZER_ACCESS_DENIED` to `PIC_ACCESS_DENIED` on the cross-event branch
would leave every test green while turning the masked 404 into an oracle. The `expectDenied`
helper exists and types its `code` as `string` (`test:89`–`:91`) rather than
`AuthzErrorCode`, so a typo'd expectation would not be caught at compile time either.

**L-5 — The execution report's pre-existing-diff evidence is no longer verifiable.** Report §2
claims the initial `lib/authz/permissions.ts` diff was "exactly +4 lines" and §4 reproduces
that hunk (one comment + three `PIC_CHECKIN_SCAN_OWN` lines). Because the change was uncommitted
and has since been reverted, no repository record of it exists: the claim cannot be confirmed
or refuted from git, and the reproduction cannot be checked against the object it quotes. The
final state *is* verifiable (`git diff --exit-code` → 0, no `pic.checkin.*` in
`permissions.ts`), so this is an evidentiary limitation rather than a contradiction.

### INFORMATIONAL — 4

**I-1 — "Pure" is behavioural, not dependency-free.** `lib/authz/pic-assignment.ts:3` imports
`AuthzErrorCode` from `./errors`, and `lib/authz/errors.ts:1` imports `next/server`
(`NextResponse`). The decider therefore pulls the Next runtime into its module graph. That is
harmless where it runs today (Next app, ts-jest with `next` installed) and it performs no I/O,
but it means the module cannot be reused from a plain Node worker or CLI without a shim — worth
knowing before any phase moves scanning into a background process.

**I-2 — `reason` content is safe only by caller discipline.** Deny reasons name internal state
(`"PIC profile status is SUSPENDED"`, `:164`; `"assignment is for a different event"`,
`:190`). Contract §6 forbids rendering them, and nothing in the module enforces that: the
decision object is a plain value, so a future route that `JSON.stringify`s it would leak the
distinction between "no profile", "wrong profile" and "no assignment". The existing
`AuthzError` path is the safe adapter — it logs `detail` server-side and returns only the
generic message (`errors.ts:83`–`102`). Phase 3D should map decisions through it rather than
serialise them.

**I-3 — Row 35 proves a literal, not the type.** `test:368` asserts
`Object.keys(ctx()).sort()` equals a four-element array — i.e. the shape of the object the
*test* built. The actual guarantee ("no organizer channel exists") comes from the exported type
at `:75` and from the module's import list; the test would still pass if the type gained an
optional `organizerId` field, as long as the fixture did not set it. A type-level assertion
(e.g. an `Exclude`-based check or a `satisfies` on a widened object) would be strictly stronger.

**I-4 — A pre-existing comment in `reference.ts` disagrees with issuance.** The header says the
raw token is "shown once at issuance" / "returned exactly once", while issuance discards it
(`qrTokenHash: hashQrToken(generateQrToken())` — the value is never bound). Phase 3A's contract
§11 follows the *code*, which is the correct behaviour, so this is a stale comment outside
Phase 3A's files, recorded because the contract's B-2 reasoning depends on it.

---

## 10. Limitations

1. **No test was executed**, by instruction. The report's "42 passed / 42 total / exit 0" is
   therefore **not independently re-verified**; what this review verified is that exactly 42
   test cases exist and that each asserts the property attributed to it (§6). A green run
   remains the report's claim.
2. **`tsc --noEmit` was not re-run** (no source change was made, and this review stayed
   static). The report's "exit 0" is accepted as reported; the type-level claims this review
   makes are from reading the types, not from the compiler.
3. **The pre-existing diff in report §2/§4 is unverifiable** (L-5) — the state no longer exists
   anywhere in the repository.
4. **No runtime probing.** Nothing was imported, executed or mocked. Behaviour under a real
   Next request, a real Prisma `select`, or a real session is out of scope; the decider's
   correctness is established for the snapshots it is handed.
5. **The future wiring is unverified by nature.** Whether Phase 3D loads the assignment for the
   *requested* event (rather than any assignment of the PIC), and whether it avoids an
   existence pre-check that would reintroduce the 404/403 oracle, cannot be assessed — no such
   code exists.
6. **M-1/M-2 were established by filesystem and heading inspection**, not by a documentation
   index; if the Phase 14 lock is mirrored elsewhere under `docs/` in a later commit, the
   finding reduces to a stale path only.

---

## 11. Recommendation

**PASS WITH LIMITATIONS.** The authorization rule is implemented correctly, fails closed on
every branch, is isolated from organizer authority by construction rather than by convention,
and is pinned by a matrix whose 42 cases match its 34 declarations. The `PIC_CHECKIN_SCAN_OWN`
removal is complete and leaves the permission vocabulary consistent.

Recommended before this documentation is treated as final, in a **separately authorized**
documentation-only pass:

1. Fix the two citations (M-1, M-2): point at
   `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §17 + `P14-D18`, and state that design §6.3 is
   the quoted source rather than a lock section.
2. Correct the report's `test.each` footnote and add the `null` event-id case to the row list
   (L-1).
3. When tests may change again, add the unknown-value and whitespace-id rows (L-2, L-3) and
   assert the refusal **code** on the cross-event rows (L-4) — the 404 there is a security
   property, not a detail.

No repair was performed during this audit, no Phase 3B work was started, and no Phase 3B prompt
was drafted. Awaiting owner review.

---

## 12. Final git verification

| Check | Required | Observed | Result |
|---|---|---|---|
| HEAD | unchanged | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` | **PASS** |
| Branch | `main` | `main` | **PASS** |
| Staging | empty | empty | **PASS** |
| Source/test changed by this audit | none | `git diff` empty; `lib/authz/permissions.ts` identical to `HEAD` | **PASS** |
| Files added by this audit | this report only | `?? docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md` | **PASS** |
| Commit / push / deploy | none | none | **PASS** |
| Database writes | none | none (no connection, no test run, no migration/seed/reset/cleanup) | **PASS** |
