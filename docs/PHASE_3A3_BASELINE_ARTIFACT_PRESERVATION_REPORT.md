# PHASE 3A.3 — BASELINE ARTIFACT PRESERVATION REPORT

**Type:** controlled Git audit and commit preparation (read-only; nothing staged or committed)
**Repository:** `/home/reksa/tinggalklik` · branch `main` ·
HEAD `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` (unchanged)
**Scope:** inventory the 14 untracked entries, verify provenance, review them for secrets and PII,
and propose an explicit commit manifest.

**Verdict: PASS WITH LIMITATIONS** — the audit is complete and the manifest is safe, but three
documentation inaccuracies and one repository-hygiene risk are recorded that this read-only phase
must not repair. **This verdict does not authorize committing.**

---

## 0. Superseding note — Phase 3A.3.2

This report is preserved as the Phase 3A.3 record. Its three documentation findings (F-1, F-2, F-3)
were subsequently verified against the repository and corrected by **Phase 3A.3.1**
(`docs/PHASE_3A3.1_DOCUMENTATION_REFERENCE_CORRECTION_REPORT.md`). That phase superseded this
report's F-1 line references, its F-3 finding, and every statement below that the three defects
"remain" in the tree.

The corrected position, verified against the current working tree:

| Finding | Phase 3A.3 status | Current status after Phase 3A.3.1 |
|---|---|---|
| F-1 — stale lock path in `lib/authz/pic-assignment.ts` | reported, not repaired | **corrected** — root `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §17 PIC Access at `:44`, design's §6.3 named as such at `:45` |
| F-2 — three stale citations in `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md` | reported, not repaired | **corrected** at `:57`, `:246`, `:1255` |
| F-3 — missing `docs/` prefix | reported as **two** instances | **one** genuine instance, corrected (`docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:1417`); the second was a **false positive** |

The original findings, the subsequent verification and the corrected conclusions are kept
distinguishable: each correction is recorded in place in §4.4 as a labelled note, and the superseded
statements in §9(1) and §12 are annotated rather than deleted. Nothing was silently rewritten, and
no finding was erased from the record.

---

## 1. Objective

Preserve the legitimate Phase 3A authorization artifacts before Phase 3B by (a) proving what each
untracked entry is and where it came from, (b) proving none of it is unsafe to publish, and
(c) producing an explicit, minimal commit manifest that keeps the decider, its suite and their
documentation together.

Explicitly **not** done: staging, committing, pushing, deploying, deleting, moving, renaming or
editing any artifact, and any production, schema, configuration or dependency change. Nothing was
repaired; every discrepancy below is reported instead.

---

## 2. Initial repository state (recorded before any inspection-side command)

| Check | Observed |
|---|---|
| `pwd` | `/home/reksa/tinggalklik` |
| `git branch --show-current` | `main` |
| `git rev-parse HEAD` | `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd` |
| `git status --porcelain` | **14 entries, all `??`** |
| `git diff --stat` | empty |
| `git diff --cached --stat` | empty — **nothing staged** |
| Tracked files modified | **none** (`git status --porcelain \| grep -v '^??'` → empty) |
| Phase 14 lock | `4a791a08dd4e32cd4fe367c55a94535de325488db6cf657fec7ecaf6a5dd3c91`, `git status` clean, mtime 2026-09-19 |
| `git diff --check` | exit 0 |

The state matches the previously reported baseline exactly: same HEAD, same 14 entries, no staged
or unstaged tracked change. **No stop condition was triggered.**

---

## 3. Full artifact inventory

### 3.1 Phase 3A implementation and test (2 entries)

| Path | Size / lines | sha256 | Content | Commit? |
|---|---|---|---|---|
| `lib/authz/pic-assignment.ts` | 8,551 B / 209 | `e6198eea…6fb930b` | The pure decider `decidePicEventPermission`, its input/output types and the 11-branch deny-by-default chain. Imports only `./errors` and `type PICStatus`. **No production consumer** (verified: nothing under `app/`, `lib/`, `components/` imports it). | **Yes** |
| `__tests__/authz/pic-assignment.test.ts` | 28,561 B / 675 | `4e1ad84b…64bcfb951` | 66 executed tests: 31 singles + 9 tables. Imports `type PICStatus` (erased) and three `@/lib/authz/*` modules. No Prisma client, no I/O. | **Yes** |

Both are new files, both are cited by every report in §3.2, and the suite is the only executable
proof of the contract. They must land together.

### 3.2 Phase 3A documentation and review (8 entries)

| Path | Size / lines | sha256 | Role |
|---|---|---|---|
| `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` | 18,175 B / 333 | `969d85f0…d4b17` | The written contract: B-1…B-6, the predicate, deny-by-default rules, isolation, visibility policy, credential honesty (B-2), Phase 3B–3G dependencies. |
| `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md` | 5,654 B / 119 | `5c8405e1…c0de5` | Append-only amendment `P14-AMEND-01`: exactly one lock row (Scan/validate QR) amended, override and log stay NO. |
| `docs/PHASE_3A_EXECUTION_REPORT.md` | 21,163 B / 424 | `d52aef4b…0ea0e` | What was built: B-1…B-6 as implemented, 37-row matrix (42 tests), exact command output, DB-safety confirmation. |
| `docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md` | 34,096 B / 540 | `08f35820…d3c71` | Independent review of Phase 3A; produced L-2…L-5 and I-1…I-3. |
| `docs/PHASE_3A1_DOCUMENTATION_CORRECTION_REPORT.md` | 14,050 B / 261 | `190c6ac1…4e1c5` | Corrected the lock path / section attribution in three documents (M-1, M-2). |
| `docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md` | 23,254 B / 496 | `28754ca2…1968b` | Closed L-2/L-3/L-4/I-3: 42 → 65 tests, 34 → 40 declarations. |
| `docs/PHASE_3A2_INDEPENDENT_REVIEW.md` | 29,605 B / 551 | `48e5c20d…27013` | Read-only review of 3A.2; raised L-A2-01 / L-A2-02 and five informational notes. |
| `docs/PHASE_3A2.1-LA2-01-CLOSURE_REPORT.md` | 15,695 B / 342 | `20715f66…5f2d4` | Closed L-A2-01 with one test row: 65 → 66, 120 → 121. |

All eight are self-contained Markdown with no runtime effect. They are the provenance chain the
next phases will cite, and a commit that lands the decider without them would leave code whose
contract, review history and closure evidence are untracked.

### 3.3 Earlier prerequisite artifacts (3 entries)

| Path | Size / lines | sha256 | Origin | Commit? |
|---|---|---|---|---|
| `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md` | 91,067 B / 1,463 | `022fec43…94804` | Phase 3 prerequisite audit (16 sections): produced B-1…B-6 and the Phase 3A–3G proposal. Written **before** 3A. | Separate commit — see §8 |
| `PROJECT_PRE_FEATURE_AUDIT_REPORT.md` | 27,230 B / 209 | `0b8109d2…a7870` | Project-wide pre-feature audit (13 sections, NO-GO verdict for the blast feature at that time). Root-level reports are an established convention here (104 tracked `.md`, many at root). | Separate commit — see §8 |
| `docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md` | 16,581 B / 355 | `8b2fa6e3…0124e2` | Records the four-commit Phase 0–2 baseline that produced the current HEAD; its §2/§3 are the audit trail for `d0bb0e0`. | Separate commit — see §8 |

They are legitimate project artifacts, not Phase 3A output: they document earlier phases that are
already committed, and committing them is optional bookkeeping rather than a prerequisite for
Phase 3B.

### 3.4 Runtime / imported state (1 entry) — must NOT be committed

| Path | Size | Nature |
|---|---|---|
| `.cloud-attachments/` (1 file) | 1,114,390 B · `imported-conversation-653a8b…f927a803.json` | An imported chat transcript: 16 JSON objects, keys `role`/`content`, 8 `user` + 8 `assistant` messages, mtime 2026-10-31. Not gitignored, not referenced by any code, and it is the only artifact here that contains credential-shaped and personal data (§5). |

**Decision: exclude.** It is delivery state imported by the assistant tooling, not project source.

---

## 4. Provenance and consistency findings

### 4.1 Test counts — consistent across all five reports (VERIFIED)

| Artifact | Claim | Actual / verdict |
|---|---|---|
| 3A execution report | 42 tests; 34 declarations; tables 3/5/3; `(34−3)+11=42`; trio 97 | 37-row matrix present; arithmetic consistent ✅ |
| 3A2 hardening report | 42 → 65; 34 → 40; 9 tables; trio 120 | ✅ |
| 3A2 independent review | 65/65 PIC; 120/120 trio | ✅ re-derived by that review |
| 3A2.1 closure | 66/66 PIC; 121/121 trio; lineage 97 → 120 → 121 | ✅ |
| Current suite | 40 declarations, 9 `test.each` (lines 213, 241, 260, 397, 414, 429, 451, 467, 481), 31 singles, 27 `expectDenied` | ✅ re-derived here |

The lineage is coherent and monotonic: 42 → 65 → **66** tests and 97 → 120 → **121** across the
trio, with no report claiming a count the later one contradicts.

### 4.2 Contract ↔ implementation alignment (VERIFIED)

The 11 clauses in `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` §2/§6 appear in
`lib/authz/pic-assignment.ts` in the same order with the codes the contract names:
`!input` → `ORGANIZER` 404; `userId` → `UNAUTHORIZED` 401; `eventId` → `NOT_FOUND` 404;
profile/id → `PIC` 403; owner mismatch → `PIC` 403; `status !== "ACTIVE"` → `PIC` 403;
`!assignment` → 404; `picProfileId` → 404; `eventId` mismatch → 404; `isActive !== true` → 404;
`revokedAt !== null` → 404. Contract §3/§4 tables match those refusals row for row.

### 4.3 Phase 14 references (VERIFIED against the lock itself)

The amendment and contract cite `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` **(root)** as
§17 PIC Access, lines 538–551, decision record `P14-D18` line 678, design §6.3 quote at line 540.
Reading the file: `538: ## 17. PIC Access`, `540:` the design quotation, `551:` "Phase 15 must not
pass a platform `PIC` … through the check-in guard", `678:` `P14-D18 … LOCKED`. **All four anchors
resolve exactly.** The lock is unmodified (hash above) and nothing was written to it.

### 4.4 Documentation discrepancies found (reported, not repaired)

**F-1 (Low) — the corrected-away lock path survives in the production module comment.**
`lib/authz/pic-assignment.ts:43`–`44` reads — *line numbers as of this audit; see the Phase 3A.3.2
correction note at the end of this finding, where the corrected citation occupies `:43`–`45`*:

> ` * \`docs/PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md\` §6.3; see`
> ` * \`docs/PHASE_3A_AUTHORIZATION_CONTRACT.md\` §14 and`

That path does not exist (the lock is at the repository root, and §6.3 is a *design* section, not
a lock section). PHASE_3A.1 fixed exactly this error in three documents and verified "none" — its
post-edit grep was scoped to "the three documents", so the claim is accurate as written but does
not cover the module header. The comment is in a production file, so this audit did not touch it.

> **Correction note — Phase 3A.3.2 (supersedes the line references in this finding).** Phase 3A.3.1
> corrected this comment. `:43` still opens the sentence (` * The PIC QR scanning row is an
> owner-approved amendment to`); the citation now spans `:44`–`45` and reads
> `` `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §17 PIC Access, which locks the design's §6.3
> matrix ``. The nonexistent `docs/` path is gone, and §6.3 is retained only as the design reference
> it is. Because the change replaced one comment line with two, the module is now **210 lines**
> (was 209) and every line after `:44` shifted by one — so line citations recorded elsewhere in this
> report for `lib/authz/pic-assignment.ts` no longer resolve to the same text. Verified comment-only
> and token-identical, `tsc` exit 0, 66-test suite 66/66. Evidence:
> `docs/PHASE_3A3.1_DOCUMENTATION_REFERENCE_CORRECTION_REPORT.md` §3.1, §5, §6.

**F-2 (Low) — the Phase 3 prerequisite audit carries the same two path errors.**
`docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:57` and `:1255` cite
`docs/PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` (does not exist). At `:246` it cites
`docs/PHASE_20B_FINAL_CROSS_VERTICAL_AUDIT.md`; that report exists but at the repository **root**
and is already tracked (`PHASE_20B_FINAL_CROSS_VERTICAL_AUDIT.md`), so only the prefix is wrong.
The document is a historical audit and was outside PHASE_3A.1's stated scope.

> **Correction note — Phase 3A.3.2.** Phase 3A.3.1 corrected all three citations in
> `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md`: `:57` and `:1255` now cite the root
> `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` **§17 PIC Access**, and `:246` now cites the root
> `PHASE_20B_FINAL_CROSS_VERTICAL_AUDIT.md`. `wc -l` is still 1,463. `:1416`'s unprefixed lock
> reference was deliberately left alone — the lock lives at the repository root, so no prefix is
> correct there. Evidence: 3A.3.1 report §3.2.

**F-3 (Informational) — bare filename in a historical document.**
**Corrected in Phase 3A.3.2: one genuine instance, not two.**

*Original Phase 3A.3 finding, preserved verbatim:*

> `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:1417` and
> `docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md:157` write
> `PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md`; the tracked file is
> `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md`. Cosmetic, historical text.

*Subsequent verification against the actual repository files (Phase 3A.3.1) — corrected conclusion:*

- **Genuine defect, one instance.** `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:1417` did write
  `PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md` without the prefix; the tracked file is
  `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md`. **Corrected in Phase 3A.3.1**; the same
  document already cites the same file with the prefix at `:59`, so it is now internally consistent.
- **False positive, not a defect.** `docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md:157`
  **already read** `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md`. It sits inside a `text`
  code block reproducing the `git show --stat` output of commit `d0bb0e0`, where that prefix is
  correct and required. **No edit was made in Phase 3A.3.1; the file is byte-identical**
  (`sha256 8b2fa6e3…b0124e2`, 355 lines).
- **Corrected conclusion:** only **one** of the two claimed missing `docs/` prefixes existed, and
  this finding was Informational — the single genuine instance was cosmetic. Evidence: 3A.3.1
  report §3.3, §5.

### 4.5 No report claims unimplemented work (VERIFIED)

Every report states, in its own words, that Phase 3A ships **no API, no UI, no consumer and no
database change**. Independently verified: no file under `app/`, `lib/` or `components/` imports
`pic-assignment`, so the decider is not yet wired into any route. The claims are accurate rather
than aspirational. Known limitations (no HTTP round-trip, suite untracked, L-A2-02 open) remain
documented in 3A2 §10, 3A2.1 §13 and 3A §17, consistently.

### 4.6 Earlier-phase claims verified here as well

- B-3's "the uncommitted permission was removed": `PIC_CHECKIN_SCAN_OWN` /
  `pic.checkin.scan.own` is absent from `lib/authz` **and** from `HEAD`
  (`git grep … HEAD` → nothing), so `lib/authz/permissions.ts` is genuinely back to its committed
  state and needs **no** commit. `git diff` on it is empty, confirming that independently.
- The support files the contract cites all exist: `jest.config.js`, `jest.setup-env.ts`,
  `jest.teardown-env.ts`, `__tests__/support/{test-database,global-setup,fixture-teardown}.ts`.

---

## 5. Secret and security review

### 5.1 The 13 files — clean (PASS)

Every pattern searched returned **zero** for: OpenAI-style keys (`sk-…`), AWS access keys,
GitHub tokens, Slack tokens, `-----BEGIN … PRIVATE KEY-----`, JWTs, `postgres://`,
`mongodb://`, provider `service_role` keys, and `NEXTAUTH_SECRET`. There is **no** `KEY=value`
line in any artifact, and no email-, ID-number- or phone-shaped string.

The five credential-word hits are benign, and none of them is a value:

- `docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md:358` — the review's own scan table, listing the
  patterns it searched (`API-key / secret / bearer / mysql:// / DATABASE_URL=` … "**PASS** — none").
- `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:200` — prose about audit-log actor values.
- `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:888`–`893`, `:1158`–`1159` — requirements that a test
  harness must read `TEST_DATABASE_URL`, refuse the application `DATABASE_URL`, and demand a
  `_test` suffix. Environment **variable names**, no values.
- `docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md` (`mysql://`, `api_key`) — same scan table.

**Conclusion: the 13 files are safe to publish.**

### 5.2 `.cloud-attachments/` — unsafe to publish; excluded

Inspected structurally and by aggregate metrics only; **no value is reproduced here.**

| Observation | Count / shape |
|---|---|
| Valid JSON, 16 message objects (`role`, `content`), 8 user + 8 assistant | 1,114,390 B |
| MySQL-style URLs **carrying a userinfo component** (`…://user:pass@host…`) | **25** |
| MySQL-style URLs without credentials | 2 |
| `DATABASE_URL` assignments in the text | 64 |
| Phone-shaped digit strings (10 digits, one repeated shape) | 55 |
| JWT-shaped string (~200–299 chars) | 1 |
| Distinct 40+ char tokens (non-hex; includes code/prose lines up to 1,250 chars) | 51 |
| OpenAI / AWS / GitHub / Slack keys, private-key blocks | **0** |
| `secret` / `password` / `token` keys with values | 0 |

**Finding F-4 (Medium, commit-safety only).** The file shapes like a working transcript containing
**credential-bearing connection strings and phone-number-like strings**. Two risks follow:

1. `.gitignore` (read in full) does **not** cover `.cloud-attachments/`, and
   `git check-ignore` confirms it is **not ignored** — so any `git add -A` / `git add .` would
   commit it. This is why §6 uses explicit paths only.
2. Validity of those credentials was **not** tested (no connection was attempted; none may be), so
   they are treated as real. If real, they pre-date this session and belong to the transcript's
   source, not to the repository — but publishing them would still be a leak.

**Decision: do not commit.** Recommended owner action, in a separately authorized step: delete
`.cloud-attachments/`, or add it to `.gitignore`, or move it outside the repository. This phase
did none of those.

---

## 6. Required commit manifest (Phase 3A)

**11 files — 2 implementation/test + 9 documentation.** Explicit paths only; `git add .` and
`git add -A` are prohibited and were not used.

```
git add lib/authz/pic-assignment.ts \
        __tests__/authz/pic-assignment.test.ts \
        docs/PHASE_3A_AUTHORIZATION_CONTRACT.md \
        docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md \
        docs/PHASE_3A_EXECUTION_REPORT.md \
        docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md \
        docs/PHASE_3A1_DOCUMENTATION_CORRECTION_REPORT.md \
        docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md \
        docs/PHASE_3A2_INDEPENDENT_REVIEW.md \
        docs/PHASE_3A2.1-LA2-01-CLOSURE_REPORT.md \
        docs/PHASE_3A3_BASELINE_ARTIFACT_PRESERVATION_REPORT.md
```

| # | File | Why it belongs |
|---|---|---|
| 1 | `lib/authz/pic-assignment.ts` | The implementation the whole phase exists for. Without it the tests and contract describe nothing. |
| 2 | `__tests__/authz/pic-assignment.test.ts` | Only executable proof of the predicate; 66 tests, DB-free. Must land with #1 or the contract is unverified. |
| 3 | `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` | The authoritative written contract; cited by the module, the amendment and every later report. |
| 4 | `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md` | The owner-approved, append-only exception to the locked Phase 14 row. Without it, the decider contradicts the lock. |
| 5 | `docs/PHASE_3A_EXECUTION_REPORT.md` | Records what was built and the exact verification output. |
| 6 | `docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md` | Independent review; origin of L-2…L-5, I-1…I-3. |
| 7 | `docs/PHASE_3A1_DOCUMENTATION_CORRECTION_REPORT.md` | Documents the corrections that made #3/#4/#5 accurate. |
| 8 | `docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md` | Records the hardening that closed the review's findings (42 → 65). |
| 9 | `docs/PHASE_3A2_INDEPENDENT_REVIEW.md` | Second independent review; origin of L-A2-01/02. |
| 10 | `docs/PHASE_3A2.1-LA2-01-CLOSURE_REPORT.md` | Closure of the last Low finding (65 → 66, 120 → 121). |
| 11 | `docs/PHASE_3A3_BASELINE_ARTIFACT_PRESERVATION_REPORT.md` | This report: the preservation record and manifest the owner approves. |

Notes:

- `lib/authz/permissions.ts` and `lib/authz/errors.ts` are **already tracked and unmodified**
  (`git diff` empty; the obsolete `PIC_CHECKIN_SCAN_OWN` key is absent from `HEAD`), so they need
  no commit. The Phase 3A "change" to `permissions.ts` was a *removal of an uncommitted key*, which
  leaves nothing to ship.
- Ordering within the commit is irrelevant; the two code files and their docs land atomically.
- Nothing else is required for Phase 3B.

---

## 7. Excluded artifact manifest

| Path | Reason | Risk if committed |
|---|---|---|
| `.cloud-attachments/` (1 JSON, 1.1 MB) | Imported chat transcript; not project source; not referenced by any code; contains 25 credential-shaped URLs and phone-shaped strings (§5.2) | Credential/PII leak; unrelated history bloat |

No other path among the 14 is excluded. Everything else in the inventory is either Phase 3A output
(§6) or an earlier prerequisite (§8). Nothing was deleted or moved.

---

## 8. Earlier prerequisite artifacts — recommendations

| Path | Recommendation | Rationale |
|---|---|---|
| `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md` | Commit **separately**, either immediately after Phase 3A or deferred; not a Phase 3B prerequisite | It is the evidence base for B-1…B-6 and is cited by #3/#4. Publishing it strengthens provenance. Contains F-2/F-3 path inaccuracies; fix them only in a separately authorized documentation step. |
| `PROJECT_PRE_FEATURE_AUDIT_REPORT.md` | Commit separately, or defer | Root-level reports are conventional here, and it documents the pre-feature state honestly (NO-GO). Not referenced by the Phase 3A chain. |
| `docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md` | Commit separately, or defer | Audit trail of the commits that produced the current HEAD; useful history, not required by 3A. |

Recommended: **one Phase 3A commit (§6) now, and the three prerequisites as a second, independent
commit** in a separate authorization — so a reviewer of Phase 3A is not asked to read 91 KB of
earlier audit alongside it.

---

## 9. Remaining limitations

1. **Nothing was repaired.** F-1 (stale path in `lib/authz/pic-assignment.ts`) needs a
   production-file edit, which this phase forbids; F-2/F-3 are documentation edits, also out of
   scope. All three will still be present in the proposed commit.

   *Superseded by Phase 3A.3.2: Phase 3A.3.1 repaired F-1, F-2 and F-3's one genuine instance, so
   none of the three is present in the tree any longer. This item describes the state when this
   audit was written, not the current working tree — see §0 and the §4.4 correction notes.*
2. **The attachment was reviewed structurally, not read in full.** Its 16 messages were classified
   by shape (keys, roles, pattern counts) to avoid reproducing credentials or personal data; a
   semantic review of its content was deliberately not performed.
3. **Credential validity was not tested**, by rule — no connection, no Prisma, no DB. F-4 treats the
   strings as real because that is the safe assumption.
4. **Pre-edit states remain unverifiable** (as recorded in 3A2 §10 and 3A2.1 §13): untracked files
   were overwritten in place, so the 482-line/34-declaration baseline and the "9 denial assertions"
   figure rest on recorded hashes, not on an artifact.
5. **This audit ran no test.** The 66/121 counts above are those recorded by 3A2.1 and re-derived
   from the suite's structure; the suite was not re-executed here (allowed but unnecessary for an
   inventory, and the DB-free config was already verified in the previous phase).
6. **Line numbers are as of today.** F-1/F-2 citations will shift if the files are edited later.

---

## 10. Final Git status

```
$ git status --short
?? .cloud-attachments/
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/authz/pic-assignment.test.ts
?? docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md
?? docs/PHASE_3A1_DOCUMENTATION_CORRECTION_REPORT.md
?? docs/PHASE_3A2.1-LA2-01-CLOSURE_REPORT.md
?? docs/PHASE_3A2_AUTHORIZATION_TEST_HARDENING_REPORT.md
?? docs/PHASE_3A2_INDEPENDENT_REVIEW.md
?? docs/PHASE_3A3_BASELINE_ARTIFACT_PRESERVATION_REPORT.md
?? docs/PHASE_3A_AUTHORIZATION_CONTRACT.md
?? docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md
?? docs/PHASE_3A_EXECUTION_REPORT.md
?? docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md
?? docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md
?? lib/authz/pic-assignment.ts

$ git diff --stat          # empty
$ git diff --cached --stat # empty
$ git rev-parse HEAD       # d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd
$ git branch --show-current# main
```

15 untracked entries: the 14 audited plus this report. **Nothing staged, no commit, no push, no
deploy, HEAD and branch unchanged, no artifact modified or deleted.**

---

## 11. Exact recommended commit message(s)

### Recommended: one Phase 3A commit (§6 manifest, 11 files)

```bash
git commit -m "$(cat <<'EOF'
feat: add PIC assignment-based authorization contract and decider

Add the pure, deny-by-default decider that authorizes a PIC's QR scan only
for the exact event they hold an active assignment for, with its 66-test
DB-free matrix, the append-only Phase 14 amendment P14-AMEND-01, and the
Phase 3A execution, review, hardening and closure reports.

No organizer capability, no API, no UI, no database or schema change.

🤖 Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>
EOF
)"
```

### Optional second commit (earlier prerequisites, separate authorization)

```bash
git commit -m "$(cat <<'EOF'
docs: record Phase 2 baseline and Phase 3 pre-implementation audits

Preserve the four-commit baseline report, the pre-implementation security
audit that produced decisions B-1..B-6, and the project pre-feature audit,
which were left untracked by their phases.

🤖 Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>
EOF
)"
```

The messages follow this repository's conventional-prefix style (`feat:`, `docs:`, `test:`,
`chore:`) and its existing attribution footer. **Neither command was executed.**

---

## 12. Final verdict

**PASS WITH LIMITATIONS.**

The audit did what it was scoped to do: all 14 entries are identified, hashed and classified; the
13 files are proven free of secrets and safe to publish; the provenance chain is verified
independently (counts 42 → 65 → 66 and 97 → 120 → 121, 40 declarations, 9 tables, 27 helper calls,
37 matrix rows, all four Phase 14 anchors, `PIC_CHECKIN_SCAN_OWN` absent from `HEAD`); the
implementation is proven to have no production consumer, so no report overstates what shipped; and
the tree is byte-identical to the state this phase was asked to preserve.

The limitations that qualify the verdict are real but do not block preservation:

- **F-1 / F-2 / F-3** — stale `docs/PHASE_14_…` references (one inside `lib/authz/pic-assignment.ts`)
  and a root-vs-`docs/` prefix error remain in the artifacts this commit would publish; repairing
  them requires edits this phase forbids. *(Superseded by Phase 3A.3.2: all were corrected in
  Phase 3A.3.1, and F-3's second instance proved a false positive, so only F-1, F-2 and one F-3
  citation needed repair. This bullet records the Phase 3A.3 verdict, not the current tree.)*
- **F-4** — `.cloud-attachments/` holds credential-shaped and phone-shaped strings and is **not**
  gitignored; it is excluded from the manifest, and the owner should delete or ignore it.
- The pre-edit states of earlier phases remain attested rather than re-derivable.

The manifest in §6 is explicit, minimal, and keeps the decider, its tests and their documentation
together. **Approval is required before staging or committing; this report authorizes neither, and
Phase 3B must not start from it.**
