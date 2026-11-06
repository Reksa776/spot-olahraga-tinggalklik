# PHASE 3B — QR VALIDATION & `CheckInMethod` EXECUTION REPORT

**Repository:** `/home/reksa/tinggalklik` · branch `main` · baseline HEAD
`9b8fecd99bcc74677c1805c18379241af04fddd1` (Phase 3A, PASS)
**Report status:** written after implementation; this file is **untracked** and unstaged.

---

## 1. Executive summary

Phase 3B adds two pure, unreferenced modules and one DB-free suite:

- `lib/ticketing/checkin/qr-payload.ts` — validates whatever a scanner or keyboard produced
  against the **existing locked payload** (`TICKET:<ticketCode>`), returning either the canonical
  code or a classified refusal. No admission decision, no I/O, no database.
- `lib/ticketing/checkin/method.ts` — the `CheckInMethod` labelling contract: the schema's two
  values, an exhaustive compile-time list, and a resolver that yields `QR_SCAN` **only** for a
  verified scanner secret and `MANUAL` for everything else — including a camera scan of the
  wallet QR, because that QR carries a public code, not a secret.
- `__tests__/ticketing-checkin/qr-payload-validation.test.ts` — **76 tests**, all passing, with no
  database, no session and no HTTP.
- `docs/PHASE_3B_QR_VALIDATION_DESIGN.md` — the design contract, written before the code.

Nothing existing was modified: the diff is four new untracked files. The Phase 3A decider, the
check-in service, the Prisma schema, the migrations, the API routes and the UI are untouched, and
the new modules have **no production consumer** — Phase 3C wires them.

**Verdict: PASS.**

---

## 2. Final verdict

**PASS** — see §17 for the acceptance-criteria checklist.

---

## 3. Repository baseline and final Git state

Baseline (verified at Checkpoint 0, before any write):

```
pwd      /home/reksa/tinggalklik
branch   main
HEAD     9b8fecd99bcc74677c1805c18379241af04fddd1
staged   0
tracked modifications 0
untracked 8   (.cloud-attachments/, 3 prerequisite docs, 4 Phase 3A reports)
```

Final state (after implementation and verification):

```
HEAD     9b8fecd99bcc74677c1805c18379241af04fddd1   (unchanged — no commit)
branch   main
staged   0
tracked modifications 0
untracked 12
??  .cloud-attachments/
??  PROJECT_PRE_FEATURE_AUDIT_REPORT.md
??  __tests__/ticketing-checkin/qr-payload-validation.test.ts      ← new
??  docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md
??  docs/PHASE_3A4_FINAL_COMMIT_READINESS_REPORT.md
??  docs/PHASE_3A5.1_FINAL_PRE_COMMIT_VERIFICATION_REPORT.md
??  docs/PHASE_3A5_CONTROLLED_STAGING_REPORT.md
??  docs/PHASE_3A6_CONTROLLED_COMMIT_REPORT.md
??  docs/PHASE_3B_QR_VALIDATION_DESIGN.md                          ← new
??  docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md
??  lib/ticketing/checkin/method.ts                                ← new
??  lib/ticketing/checkin/qr-payload.ts                            ← new
```

`git diff --stat` is empty and `git diff --cached --name-only` is empty. The four Phase 3B files
are untracked, as required. `.cloud-attachments/` was not read, hashed, staged or modified.

---

## 4. QR payload format discovered (source references)

| Question | Answer | Source |
|---|---|---|
| What is generated? | `TICKET:<ticketCode>` — a namespaced **public ticket code**, e.g. `TICKET:EVT-2345-6789` | `lib/ticketing/tickets/reference.ts:137` `TICKET_QR_PREFIX = "TICKET:"`; `:157-167` `buildTicketQrPayload` |
| Is it an id, token, UUID, URL or signed payload? | **None of those.** It is the human-readable `Ticket.ticketCode` (`EVT-XXXX-XXXX`) behind a `TICKET:` namespace. Not a URL, not a JWT, not signed, not the 256-bit secret | `reference.ts:29-73` (the two identifiers); `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md:677` `P14-D17` (LOCKED) |
| Where generated? | `buildTicketQrPayload` → consumed by `buildTicketDetail().qr.payload` for the wallet detail only (the list deliberately omits the QR) | `lib/ticketing/tickets/payload.ts:206`, `:117` |
| Where validated today? | `normalizeCode(raw)` in the check-in service: trim → strip optional `TICKET:` (case-insensitive) → upper-case → `isTicketCode` | `lib/ticketing/checkin/service.ts:224-234`, used at `:378` |
| Authoritative ticket identifier? | `Ticket.ticketCode`, generated from a 32-symbol ambiguity-free alphabet, `@unique` in the schema | `reference.ts:70-101`, `TICKET_CODE_PATTERN` `:92`; `prisma/schema.prisma` (`ticketCode String @unique`) |
| Statuses that make a ticket eligible? | Only `ISSUED` is admissible; `RESERVED` = unpaid, `CHECKED_IN` = used, `VOID`/`REFUNDED` = revoked | `payload.ts` `describeStatusAdmission`; `service.ts` CAS `status: "ISSUED"`; design §19.4 |
| Is a token comparison implemented? | **No.** `qrTokenHash` is never read by the gate; the raw token has never been delivered to a client | `service.ts:29-40`; `TICKETING_PHASE10_REPORT.md:244` |
| Existing QR tests? | `__tests__/ticketing-issuance/qr-payload-contract.test.ts` (payload shape), `__tests__/ticketing-checkin/check-in-wiring.test.ts:54-69` (`normalizeCode` matrix) | read, not modified |

**What the QR proves:** the text is a well-formed reference to a ticket code. It does **not** prove
existence, event, status, unused-ness, or that the presenter is the holder. That is owner decision
B-2 and `P14-D17`, restated in `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md:235-262`.

**What was NOT invented:** no new payload format, no token field, no checksum, no URL, no signed
envelope, no second namespace.

---

## 5. `CheckInMethod` contract and authoritative values

| Value | Meaning | Written today? |
|---|---|---|
| `MANUAL` | Admission resolved from the **public ticket code** — typed, pasted, or decoded from the wallet QR by a camera. The QR is a carrier of a public code, not a credential. | **Yes** — the only value (`service.ts:65` `const CHECK_IN_METHOD: CheckInMethod = "MANUAL"`) |
| `QR_SCAN` | Admission justified by verifying a **scanner secret** against `Ticket.qrTokenHash`. | **No** — and no writer may be added while no token reaches a scanner |

Authority: `prisma/schema.prisma:528-531` (the shipped enum), `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md:64`, `:677` (`P14-D17`), `:808` (`Phase 15 must not … write QR_SCAN`), `:399`, and `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:959` ("record `QR_SCAN` **only** when a genuine secret was verified; otherwise stay `MANUAL`").

**Design divergence, handled not hidden:** design §20.1 (`TICKETING_PHASE1_DESIGN.md:1683`) names
`QR_SCAN | MANUAL_CODE | MANUAL_OVERRIDE`; the shipped enum has `QR_SCAN | MANUAL`
(`PHASE_10_REPORT.md:246`). Phase 3B represents **the schema**, adds no member, and runs no
migration. `MANUAL_CODE`/`MANUAL_OVERRIDE` remain design-only values — adding one is an `ALTER` and
a separate owner decision.

Persisted or pass-through: `CheckIn.method` is persisted, but **this phase writes nothing**. The
contract exists so Phase 3C cannot inline a wrong label beside a camera path.

Invalid/missing method: `isCheckInMethod` refuses anything outside the two values; the resolver
fails closed to `MANUAL` for `null`, `undefined`, unknown strings, mis-cased spellings and the
public-code credential.

---

## 6. Audit findings and design decisions

**Findings (all from source, none assumed):**

1. The QR is a **public code carrier**; authenticity is enforced by staff/PIC authorization, not by
   the QR (`docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:42`). → Phase 3B must not claim otherwise, and
   must not label a public-code scan `QR_SCAN`.
2. `CheckInMethod.QR_SCAN` already exists in the schema, so **no migration is needed** for a
   labelling contract — and none was attempted.
3. The gate already normalises payloads (`normalizeCode`), so a parser that disagrees would be a
   behavioural change under the guise of validation. → Parity was designed in: same trim, optional
   namespace, case fold, code pattern.
4. `assertQrPayloadIsSafe` is an **assertion** for server-generated payloads and throws by design;
   it is the wrong tool for untrusted input, which must return a refusal. → The parser validates
   with `isTicketCode` and rebuilds the canonical payload with `buildTicketQrPayload`.
5. The existing check-in tests pin `"MANUAL"` and the old `normalizeCode` matrix. → They are left
   untouched; the new suite adds static guards proving the shipped path still writes `MANUAL` and
   never selects the hash.

**Design decisions:**

- Result is a discriminated union on `valid`, with **one reason enum** and no echoed input.
- Reasons distinguish *unsupported format* (`https:`, another namespace, `EVT-…:junk`) from
  *missing code* (`TICKET:` alone) from *invalid code* (`EVT-0000-0000`, a token, an email). The
  classification is internal; the route must keep mapping all of them to one response.
- `presentedAs` records prefix-vs-bare, and is explicitly **not** allowed to influence
  `CheckInMethod` — that is the mistake this phase exists to prevent.
- `CheckInMethodValue` **aliases** Prisma's generated enum (type-only) rather than re-declaring it,
  and `CheckInMethodListIsExhaustive` turns an enum change into a compile error.
- No wiring: the service does not import the new modules, keeping Phase 3B free of behavioural
  change (and keeping `normalizeCode`'s tests meaningful until 3C replaces it deliberately).

---

## 7. Files created and modified

| File | Status | Lines | Bytes | sha256 |
|---|---|---|---|---|
| `lib/ticketing/checkin/qr-payload.ts` | created | 166 | 7 344 | `7b10f68893e733038708d56fecc6952a2f06ae2a8eec87649cbe115de98ceca6` |
| `lib/ticketing/checkin/method.ts` | created | 106 | 5 198 | `8ab1d8402c90f931ecafad8a7c1019984e975fe6a84a5edebb1c0f97e346b812` |
| `__tests__/ticketing-checkin/qr-payload-validation.test.ts` | created | 479 | 20 116 | `38c10e51fed5e0167c54d5885f2356cc8f053d9e6f229cdae159cbe945d84135` |
| `docs/PHASE_3B_QR_VALIDATION_DESIGN.md` | created (before code) | 144 | 10 199 | `ed5421a7a6a01720b20a7a2ac1fa4f0403d1d4bbd6af0a64e4de24eded81dd98` |
| `docs/PHASE_3B_QR_VALIDATION_EXECUTION_REPORT.md` | created (this file) | — | — | — |

**Modified: none.** `git diff --stat` is empty; no tracked file changed, so Phase 3A authorization,
the check-in service, the schema, migrations, routes and UI are all byte-identical to `9b8fecd`.

---

## 8. Validation rules implemented

`parseCheckInQrPayload(raw: unknown) → CheckInQrAccepted | CheckInQrRejected`

Accepted grammar (identical to the gate's current normalisation):

```
payload     := WSP? namespace? code-text WSP?
namespace   := "TICKET" ":"        (case-insensitive)
code-text   := /^EVT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/i
```

| # | Rule | Result |
|---|---|---|
| 1 | Non-string (`42`, `null`, `undefined`, `{}`, `[]`, `true`) | `NOT_A_STRING` |
| 2 | Empty / whitespace-only | `EMPTY_PAYLOAD` |
| 3 | Longer than 120 characters (the request schema's `code` bound) | `PAYLOAD_TOO_LONG` |
| 4 | Any namespace other than `TICKET:` (`https:`, `mailto:`, `TIKET:`, bare code + `:junk`) | `UNSUPPORTED_FORMAT` |
| 5 | `TICKET:` with no code | `MISSING_CODE` |
| 6 | Wrong shape, wrong alphabet, extra segments, PII, URL, token, SHA-256 hex, SQL/path junk | `INVALID_CODE_FORMAT` |
| 7 | Well-formed code, optional prefix, any casing, surrounding whitespace | `valid: true` with canonical `ticketCode`, `canonicalPayload`, `presentedAs` |

`resolveCheckInMethod(credential)`:

| Input | Method |
|---|---|
| `"VERIFIED_SCANNER_SECRET"` (exact) | `QR_SCAN` |
| `"PUBLIC_TICKET_CODE"` | `MANUAL` |
| `null`, `undefined`, `""`, `"QR_SCAN"`, `"verified_scanner_secret"`, `" VERIFIED_SCANNER_SECRET"`, `"TICKET:EVT-2345-6789"` | `MANUAL` |

`isCheckInMethod`: true only for `"QR_SCAN"` and `"MANUAL"`.

---

## 9. Unit test inventory and exact results

**Command (DB-free inline config; replaces the repo's DB harness):**

```
npx jest --config '{"preset":"ts-jest","testEnvironment":"node",
  "moduleNameMapper":{"^@/(.*)$":"<rootDir>/$1"},
  "testMatch":["<rootDir>/__tests__/ticketing-checkin/qr-payload-validation.test.ts"],
  "transform":{"^.+\\.tsx?$":["ts-jest",{"tsconfig":"tsconfig.json"}]},
  "forceExit":true}' --runInBand
```

```
PASS __tests__/ticketing-checkin/qr-payload-validation.test.ts
Test Suites: 1 passed, 1 total
Tests:       76 passed, 76 total
Snapshots:   0 total
Time:        1.418 s
exit 0
```

76 `✓` marks, 0 `✕`, 7 describe blocks. The suite's isolation is proven by `--showConfig`:

```
"setupFiles": [],
"setupFilesAfterEnv": [],
"testEnvironment": ".../jest-environment-node/build/index.js"
```

with **no** `globalSetup` / `globalTeardown` key — so the repo's `jest.setup-env.ts`,
`global-setup.ts` and `fixture-teardown.ts` (which validate `TEST_DATABASE_URL`) never ran.

Coverage by group:

| Group | Tests | What it pins |
|---|---|---|
| B1 accepted | 7 | prefix + bare, casing, whitespace, canonical payload equals `buildTicketQrPayload`, exact result keys, refusal carries no echo |
| B2 rejections (payload) | 30 | `NOT_A_STRING` ×6, `EMPTY_PAYLOAD` ×3, `PAYLOAD_TOO_LONG` ×1, `UNSUPPORTED_FORMAT` ×6, `MISSING_CODE` ×3, `INVALID_CODE_FORMAT` ×12 |
| B2 classification | 2 | every rejection is invalid with no code/payload key; a valid code in another namespace is never silently repaired |
| B3 purity/isolation | 9 | determinism ×50, call independence, no throw on null byte/emoji/RTL/junk, static: no `@/lib/prisma`, no `PrismaClient`, no `@prisma/client` runtime import, no service import, no `fetch`, no `process.env`, no `new Date`, no `Math.random`; format imported from `reference.ts` (no second regex, no second `"TICKET:"` literal) |
| C1 method list | 13 | tuple equals `["QR_SCAN","MANUAL"]`, exhaustiveness, `isCheckInMethod` accept/refuse matrix |
| C2 labelling | 11 | `QR_SCAN` only from `VERIFIED_SCANNER_SECRET`; public code/null/undefined/mis-cased all `MANUAL`; resolved values always members; type-only Prisma import; no second enum |
| C3 shipped path unchanged | 4 | service still pins `MANUAL`, writes no `"QR_SCAN"`, never selects/hashes `qrTokenHash`, imports none of the new modules |
| **Total** | **76** | `Test Suites: 1 passed`, `Tests: 76 passed, 76 total` |

---

## 10. Phase 3A regression results

```
PASS __tests__/authz/pic-assignment.test.ts
Test Suites: 1 passed, 1 total
Tests:       66 passed, 66 total
```

Same DB-free inline config. No Phase 3A source, test or document was modified
(`git diff --stat` empty), so this is a re-run of the committed suite, not a re-baseline.

---

## 11. TypeScript and diff-check results

```
$ npx tsc --noEmit
(no output)
tsc_exit=0

$ git diff --check
(no output)
worktree_diff_check=0
```

`tsc` covers all four new/edited files (they are in the project graph). It also evaluates the
compile-time assertions `CheckInMethodListIsExhaustive` and the `satisfies readonly
CheckInMethod[]` clause, so an enum drift would fail here.

Note on `git diff --check`: it inspects **tracked** changes, and Phase 3B adds only untracked files.
The new files were therefore also checked directly for trailing whitespace and conflict markers
(§15) — reported separately rather than implied by the `git` result.

---

## 12. Independent security review (Checkpoint 6)

| Property | Evidence | Result |
|---|---|---|
| No Phase 3A behaviour changed | `git diff --stat` empty; 66/66 3A tests pass | **PASS** |
| No authorization bypass introduced | New modules import no authz module and take no session/scope; they cannot grant anything | **PASS** |
| No ticket status mutation | No `prisma`, `$transaction`, `updateMany`, `status:` or `checkedInAt` in either module (grep: none) | **PASS** |
| No check-in transaction | Neither module writes or reads a row; no `prisma` import at all | **PASS** |
| No API endpoint added | No file under `app/`; no route handler, no `NextResponse` | **PASS** |
| No UI change | No component, no `use client`, no `useState`, no `router` | **PASS** |
| No migration executed | `prisma/` status clean, schema sha256 `0f48e1ce…` unchanged, last migration still `20260929000000_add_payment_active_order_id` | **PASS** |
| No unrelated refactoring | Only 4 new files; no existing file touched | **PASS** |
| No secrets or sensitive data | Secret scan across the three new code/test files: no password, key, DSN or private-key block | **PASS** |
| No test-only shortcut in production code | No `process.env.NODE_ENV` branch, no `__tests__` import, no exported test hook | **PASS** |
| Every rule source-backed | §4/§5 cite file:symbol for each rule; refusals/limits documented in the design doc | **PASS** |

**Phase-specific risk reviews:**

- *Can a forged QR pass?* Yes, structurally — anyone can encode `TICKET:<a code they saw>`. That is
  exactly what B-2 accepts, and why this module deliberately claims no authenticity. It is
  documented as a limitation (§14), not disguised.
- *Can a parse result be escalated into admission?* No. The result carries no authorization, no
  method upgrade and no state; `presentedAs` is informational and unused.
- *Can `QR_SCAN` be written by accident?* Only `resolveCheckInMethod("VERIFIED_SCANNER_SECRET")`
  returns it, and the service does not import the resolver. The audit trail therefore cannot claim a
  token verification that never happened.
- *Can a malformed scan probe the code space?* The refusal carries a reason and no input echo; the
  route must still map all reasons to one response (documented, Phase 3C obligation).

---

## 13. Explicitly out of scope — verified not implemented

- Check-in transaction / ticket status mutation — **not implemented** (no `prisma`, no `update`).
- PIC scanner API or route handlers — **not implemented** (no `app/` file).
- Session/authentication middleware — **untouched**.
- PIC authorization changes — **none**; Phase 3A files unchanged.
- Scanner UI / camera integration — **none**.
- Audit logging implementation — **none**.
- Rate limiting — **none**.
- PIC attribution persistence — **none** (no schema/column change).
- Database integration tests (Phase 3G) — **none run**.
- Deployment / push — **none**.
- Unrelated refactoring — **none**.

Phase 3C–3G work was not started.

---

## 14. Known limitations and unresolved dependencies

1. **No production consumer.** The modules are unreferenced by `app/`, `lib/` (other than their own
   files) or `components/`; acceptance is by test. Phase 3C must wire them and delete/replace
   `normalizeCode` deliberately.
2. **Parity is reviewed, not differentially tested.** The parser mirrors `normalizeCode`'s rules,
   but the suite cannot import that function without pulling Prisma and the authz barrel
   (`service.ts` → `@/lib/authz` → `next-auth`). The parity claim rests on reading both
   implementations plus the existing `check-in-wiring` matrix, which was **not** re-run (it imports
   the service and is not DB-free by construction).
3. **A structurally valid payload is not an admissible ticket.** Existence, event match, `ISSUED`
   status, duplicate detection and open-refund refusal are Phase 3C checks and are untested here.
4. **The QR proves no authenticity.** Copied/forged codes are undetectable until the first scan
   (B-2). `QR_SCAN` remains unreachable until a scanner secret is actually delivered to a client —
   a separate decision with a delivery mechanism, not a schema tweak.
5. **`MANUAL_CODE` / `MANUAL_OVERRIDE` do not exist** in the database; using them would require an
   additive enum migration, which this phase is forbidden to run.
6. **Only focused suites were run.** The repo-wide Jest config needs a live `TEST_DATABASE_URL`; the
   full suite was not run, and this report makes no claim about it. Existing QR contract (17) and
   Phase 3A (66) were run explicitly; the rest were not.
7. **No lint/build was run** — not requested; `tsc --noEmit` is the type gate.
8. **The 120-character bound is inherited**, not independently derived: it matches the request
   schema's `.max(120)` so a payload the route would reject cannot look valid to the parser.

---

## 15. Evidence of no database connection or migration

- Neither production module imports `@/lib/prisma`, constructs `PrismaClient`, or calls any query
  API. `method.ts` imports Prisma **type-only** (`import type { CheckInMethod }`), erased at compile
  time; `qr-payload.ts` imports only the pure `reference.ts`.
- The suite's resolved config has `setupFiles: []`, `setupFilesAfterEnv: []` and no
  `globalSetup`/`globalTeardown`, so the database guards never executed.
- No `TEST_DATABASE_URL` or `DATABASE_URL` was read; no migration, seed, truncate or reset was run.
- `prisma/schema.prisma` sha256 `0f48e1cea685e9e33b87dd411712514b31605c07053fd89a92e0607f59ac4a99`,
  `git status --porcelain -- prisma/` → 0 lines; the newest migration is still
  `20260929000000_add_payment_active_order_id`.
- New-file hygiene (the untracked files `git diff --check` cannot see): no trailing whitespace, no
  conflict markers.

---

## 16. Evidence of no staging, commit, push or deployment

- `git diff --cached --name-only` → 0 lines; `staged=0` at every checkpoint.
- HEAD is unchanged at `9b8fecd99bcc74677c1805c18379241af04fddd1`; `git log -1` still shows the
  Phase 3A commit. No commit, amend, tag, push or deploy was performed.
- 12 untracked entries, all pre-existing reports plus the four Phase 3B files; nothing was staged.
- `.gitignore` untouched; no wildcard `git add` was used at any point; `.cloud-attachments/` not
  read, hashed, staged, moved or modified.

---

## 17. Acceptance criteria and recommended next phase

| Criterion | Result |
|---|---|
| Existing QR format correctly identified from source | **PASS** — §4, every row cited |
| Validation contract follows authoritative decisions | **PASS** — `P14-D17`, B-2, Phase 3 audit §3B |
| `CheckInMethod` values grounded in existing requirements | **PASS** — shipped enum + `service.ts:65` |
| QR parsing deterministic and side-effect free | **PASS** — purity/determinism tests, static no-I/O guards |
| Focused unit tests pass | **PASS** — 76/76 |
| Existing Phase 3A authorization tests pass | **PASS** — 66/66 |
| TypeScript checks pass | **PASS** — `tsc --noEmit` exit 0 |
| Diff checks pass | **PASS** — `git diff --check` exit 0; untracked files checked for whitespace/markers |
| No Phase 3C–3G work introduced | **PASS** — §13 |
| No database operation or migration | **PASS** — §15 |
| No unauthorized Git operation | **PASS** — §16 |
| Report contains reproducible evidence | **PASS** — commands and outputs quoted |

**Recommended next phase: Phase 3C — Check-in Transaction.** It must (a) replace `normalizeCode`
with `parseCheckInQrPayload` without changing which inputs are admitted, (b) keep
`resolveCheckInMethod("PUBLIC_TICKET_CODE")` → `MANUAL` at the write site, and (c) prove the
existing `FOR UPDATE` → refund guard → CAS → `CheckIn` insert transaction is sufficient for the PIC
path without rewriting it. Phase 3C requires its own explicit approval; none of it was started here.

**Final verdict: PASS.**
