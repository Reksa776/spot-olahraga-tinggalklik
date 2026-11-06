# PHASE 3C — CHECK-IN TRANSACTION EXECUTION REPORT

**Repository:** `/home/reksa/tinggalklik` · branch `main` · baseline HEAD
`9b8fecd99bcc74677c1805c18379241af04fddd1` (Phase 3A.6 PASS, Phase 3B PASS)
**Report status:** written after implementation; **untracked**, never staged.

---

## 1. Executive summary

Phase 3C wires the Phase 3B QR parser and `CheckInMethod` resolver into the **existing** check-in
transaction. It does not rewrite that transaction: ticket lookup, event match, `FOR UPDATE`,
open-refund guard, conditional `ISSUED → CHECKED_IN` update, and `CheckIn` insert keep their
order, their predicates and their single transaction.

What changed:

- `checkInTicket` now parses with `parseCheckInQrPayload(params.input.code)` and uses the
  canonical `ticketCode` for lookup and for refusal notes. Every rejection reason still answers
  the same `NOT_FOUND` / `"Tiket tidak ditemukan."` (malformed ≡ unknown).
- `normalizeCode(raw)` remains exported but **delegates** to the parser, so Phase 13's pinned
  matrix and any existing caller keep their contract with no second implementation.
- `CHECK_IN_METHOD` is now `resolveCheckInMethod("PUBLIC_TICKET_CODE")` → `MANUAL`. A camera
  scan of the public wallet QR is `MANUAL`; `QR_SCAN` remains unreachable.
- One parity correction in the Phase 3B parser: `TICKET :EVT-…` (space before the colon) was
  accepted by the Phase 3B parser and refused by the Phase 13 gate; it is now refused by both.
  This narrows acceptance by one input; nothing was widened.
- Two static assertions in the Phase 3B suite and two in the Phase 13 wiring suite pinned the
  pre-3C state ("service does not import the new modules", "constant is a bare literal"). They
  were replaced by the properties that still matter — resolver-derived `MANUAL`, one parser, no
  duplicated prefix — not deleted.

No route, UI, authorization wiring, schema change, migration, audit expansion, rate limit or
PIC persistence was added.

---

## 2. Final verdict

**PASS WITH LIMITATIONS.**

Implementation is sound and all focused checks pass, but **real two-connection database
concurrency was not exercised in this phase** (`TEST_DATABASE_URL` is absent; Jest fails closed
without it). That evidence remains Phase 3G's, exactly as §14 of the brief instructs. It is not
claimed as PASS.

---

## 3. Baseline and final Git state

Baseline (Checkpoint 0, before any write):

```
pwd      /home/reksa/tinggalklik
branch   main
HEAD     9b8fecd99bcc74677c1805c18379241af04fddd1
staged   0
tracked modifications 0
untracked 13   (the Phase 3B files + earlier reports + .cloud-attachments/)
```

Final:

```
HEAD     9b8fecd99bcc74677c1805c18379241af04fddd1   (unchanged — no commit)
branch   main
staged   0
tracked modifications 2   lib/ticketing/checkin/service.ts
                          __tests__/ticketing-checkin/check-in-wiring.test.ts
untracked 16              (13 baseline + design 3C + transaction suite + this report)
```

`.cloud-attachments/` was not read, hashed, staged or modified. No wildcard staging was used; no
commit, amend, tag, push or deploy occurred.

---

## 4. Existing transaction audit (source)

Entry point `checkInTicket` — `lib/ticketing/checkin/service.ts:301` (post-edit numbering: `:306`).

| Step | Location | In transaction |
|---|---|---|
| Authorize (`checkin.scan` + membership + assignment) | `:178` / call `:306` | no |
| Load event + gate window `isEventCheckInOpen` | `:311`, `:369` | no |
| Parse the presented code | `:383` (was `normalizeCode` at `:232`) | no |
| Ticket lookup by `ticketCode` (`@unique`) | `:392` | no |
| Event match (`WRONG_EVENT`, foreign event not disclosed) | `:404` | no |
| `SELECT id FROM ticket … FOR UPDATE` | `:443` | **yes** |
| Open-refund guard (`PENDING/APPROVED/PROCESSING`) | `:445`–`:456` | **yes** |
| CAS `ISSUED + checkedInAt IS NULL → CHECKED_IN` | `:459` | **yes** |
| Lost-CAS read (`cas.count !== 1`) | `:468` | **yes** |
| Accepted `CheckIn` insert (`ticketId @unique`) | `:479` | **yes** |
| Refusal row + `checkin.rejected` audit + throw | `:242`, `:330` | no (by design) |
| Realtime publish + `checkin.success` audit | `:566`, `:576` | no |

Ordering is the brief's sequence with one deliberate detail: the refund guard runs **after** the
lock and **before** the CAS, which is what makes it race-free. The parser runs before the lookup;
it reads no state, so moving it inside the transaction would buy nothing.

---

## 5. Before / after sequence

**Before (Phase 13):**

```
authorize → event + gate → normalizeCode → findUnique(ticketCode)
  → same event? → BEGIN
        FOR UPDATE
        refundItem guard (open claim?)
        CAS ISSUED + checkedInAt IS NULL → CHECKED_IN
        cas.count !== 1 ? fresh state
        INSERT CheckIn
      COMMIT
  → publish → audit → success (method "MANUAL")
```

**After (Phase 3C):**

```
authorize → event + gate → parseCheckInQrPayload → findUnique(canonical ticketCode)
  → same event? → BEGIN
        FOR UPDATE
        refundItem guard (open claim?)
        CAS ISSUED + checkedInAt IS NULL → CHECKED_IN
        cas.count !== 1 ? fresh state
        INSERT CheckIn (method = resolveCheckInMethod("PUBLIC_TICKET_CODE") = MANUAL)
      COMMIT
  → publish → audit → success (method MANUAL)
```

Same transaction boundary, same lock point, same predicates, same insert. Only the parse call and
the method's definition differ.

---

## 6. QR parser integration and compatibility evidence

- Integration: `parseCheckInQrPayload(params.input.code)` (`service.ts:383`); lookup uses
  `presented.ticketCode`; refusal note is the constant `UNRECOGNIZED_CODE_FORMAT`; the caller's
  answer is unchanged (`NOT_FOUND`, same message) for every reason.
- `normalizeCode` delegates (`:232`), so there is exactly one parser.
- **Parity matrix:** 24-input differential test (`C1`) runs the Phase 13 formula as an oracle and
  asserts parser and `normalizeCode` agree on every row: bare/upper/lower/mixed, prefixed,
  surrounding whitespace, post-namespace whitespace, empty, whitespace-only, `TICKET:` alone,
  double prefix, wrong namespace, URL, `mailto:`, code+segment, `TICKET :…`, invalid alphabet,
  short code, 64-hex, SQL fragment, 200-char payload.
- `TICKET :EVT-2345-6789` — the single Phase 3B divergence — is now `null` from both. Tested
  explicitly twice.
- Phase 13's own parser matrix (`check-in-wiring.test.ts` P13-1) is **unchanged** and still
  passes (29/29 in that suite), which is a second, independent confirmation.

---

## 7. `CheckInMethod` behaviour

| Input / situation | Recorded method |
|---|---|
| Typed or pasted `EVT-XXXX-XXXX` | `MANUAL` |
| `TICKET:<code>` from the wallet QR (keyboard wedge or camera) | `MANUAL` |
| Refusal rows | `MANUAL` |
| `resolveCheckInMethod("VERIFIED_SCANNER_SECRET")` | `QR_SCAN` (no producer exists; never written by this gate) |
| `null`, `undefined`, unknown, mis-cased, client-supplied `"QR_SCAN"` | `MANUAL` |

The schema enum is unchanged (`prisma/schema.prisma:528`); no migration, no new member. The
request schema `.strict()` refuses `method`, `checkInMethod`, `result`, `checkedInAt`,
`checkedInByUserId`, `ticketId` (tested). The gate writes only `CHECK_IN_METHOD`.

---

## 8. Admission, refund, duplicate and event checks

Unchanged and re-verified by tests:

- Unknown ticket ⇒ `NOT_FOUND`, no transaction opened, refusal row `TICKET_NOT_FOUND`.
- Malformed vs unsupported ⇒ identical code, message and status.
- Foreign event ⇒ `CONFLICT` / `WRONG_EVENT`; the foreign event id is not in `details`.
- `VOID` / `REFUNDED` ⇒ `CONFLICT` / `TICKET_NOT_ISSUED`, refusal `INVALID_TICKET`.
- `RESERVED` ⇒ `CONFLICT` / `TICKET_NOT_ISSUED`, refusal `UNPAID`.
- Open refund ⇒ `CONFLICT` / `REFUND_PENDING`, CAS not attempted, refusal `REFUND_PENDING`.
- Duplicate ⇒ `TICKET_ALREADY_CHECKED_IN` with first timestamp/gate/staff, no accepted insert.
- Closed/cancelled/archived/ended event ⇒ `CONFLICT` / `EVENT_NOT_OPEN` before parsing or lookup.

---

## 9. Locking / CAS / atomicity analysis

- `FOR UPDATE` (`:443`) precedes the refund read (`:445`) and the CAS (`:459`) — verified by
  source-index ordering test and by invocation order in the mocked run.
- CAS predicates are both present: `status: "ISSUED"` and `checkedInAt: null`; a lost race is
  detected with `cas.count !== 1`.
- The accepted `CheckIn` insert is in the same `$transaction` as the CAS; `CheckIn.ticketId` is
  `@unique` (`schema.prisma:1227`), the second independent duplicate guarantee.
- The refund writer locks the same ticket rows
  (`lib/ticketing/refunds/service.ts:234–241`, ascending id) and re-checks `checkedInAt` (`:257`)
  and `status` (`:268`) inside its own transaction, so exactly one order is possible.
- Refusals after the transaction began are return values, not writes, so the transaction commits
  nothing and the append-only refusal is recorded outside it.
- **Not proven here:** InnoDB behaviour under two real connections. See §16.

---

## 10. Files created and modified

| File | State | Lines | sha256 |
|---|---|---|---|
| `lib/ticketing/checkin/service.ts` | **modified (tracked)** | 661 | `88600853…a651b98e` |
| `__tests__/ticketing-checkin/check-in-wiring.test.ts` | **modified (tracked)** | — | `07d09594…4cc345` |
| `lib/ticketing/checkin/qr-payload.ts` | modified (untracked 3B file) | 165 | `2c36fb83…41a107` |
| `__tests__/ticketing-checkin/qr-payload-validation.test.ts` | modified (untracked 3B file) | 479 | `4034af50…4e43bb` |
| `lib/ticketing/checkin/method.ts` | unchanged | 106 | `8ab1d840…46b812` |
| `__tests__/ticketing-checkin/check-in-transaction.test.ts` | **created** | 624 | `e03387fa…cedd6a5` |
| `docs/PHASE_3C_TRANSACTION_DESIGN.md` | **created** (before code) | 201 | `8bc37de7…f131c310` |
| `docs/PHASE_3C_CHECKIN_TRANSACTION_EXECUTION_REPORT.md` | **created** (this file) | — | — |

`qr-payload.ts` changes are limited to the namespace test (`startsWith("TICKET:")`, any other
colon ⇒ `UNSUPPORTED_FORMAT`). `qr-payload-validation.test.ts` changes are limited to two guards
that asserted the pre-3C service; the behavioural assertions are untouched.

---

## 11. Tests and exact counts

Command (DB-free inline config; the repo's `setupFiles`/`globalSetup`/`globalTeardown` removed):

```
npx jest --config '{"preset":"ts-jest","testEnvironment":"node",
  "moduleNameMapper":{"^@/(.*)$":"<rootDir>/$1"},
  "testMatch":[ …five files… ],
  "transform":{"^.+\\.tsx?$":["ts-jest",{"tsconfig":"tsconfig.json"}]},
  "forceExit":true}' --runInBand
```

```
PASS __tests__/ticketing-checkin/check-in-transaction.test.ts
PASS __tests__/ticketing-checkin/check-in-wiring.test.ts
PASS __tests__/ticketing-checkin/qr-payload-validation.test.ts
PASS __tests__/authz/pic-assignment.test.ts
PASS __tests__/ticketing-issuance/qr-payload-contract.test.ts
Test Suites: 5 passed, 5 total
Tests:       238 passed, 238 total
exit 0
```

| Suite | Tests | Kind |
|---|---|---|
| `check-in-transaction.test.ts` (new) | **50** | pure/static + mocked transaction |
| `check-in-wiring.test.ts` | 29 | pure/static (Phase 13 + 3C updates) |
| `qr-payload-validation.test.ts` (3B) | 76 | pure/static |
| `pic-assignment.test.ts` (3A) | 66 | pure/static |
| `qr-payload-contract.test.ts` | 17 | pure/static |
| **Total** | **238** | |

New suite breakdown: C1 parity/integration **29**, C2 mocked transaction **12**, C3 method **4**,
C4 static invariants **5**.

The mocked block is labelled `MOCKED TRANSACTION` in its describe name and in the file header.

---

## 12. TypeScript, lint and diff-check results

```
$ npx tsc --noEmit            → exit 0, no output
$ git diff --check            → exit 0, no output
$ npx eslint <5 touched files> → exit 0, no output
```

No `any`, no `@ts-ignore`, no lint suppression was added. (`jest.Mock` handles are the project's
existing test idiom; production code has no casts.)

---

## 13. Phase 3A and 3B regression results

- Phase 3A `pic-assignment.test.ts`: **66/66 passed** (unchanged file, unchanged source).
- Phase 3B `qr-payload-validation.test.ts`: **76/76 passed** after two static guards were
  updated to the intended 3C consumer relationship (behavioural assertions untouched).
- Phase 13 wiring: **29/29 passed**, including the untouched P13-1 parser matrix, CAS/static
  guards and the "never reads `qrTokenHash`" guard.
- QR payload contract: **17/17 passed**.

---

## 14. Independent security review

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Can malformed QR reach ticket lookup? | **PASS** (no) | Parser runs first; rejection returns before `findUnique`; mocked test asserts `findUnique` not called; all reasons share one 404 |
| 2 | Can a public code be misclassified `QR_SCAN`? | **PASS** (no) | Resolver exact-match secret; gate passes `PUBLIC_TICKET_CODE`; prefixed payload test stays `MANUAL`; no `QR_SCAN` in written data |
| 3 | Can a client force `CheckInMethod`? | **PASS** (no) | `.strict()` schema rejects `method`/`checkInMethod`/`result`/actor fields; service writes only the constant |
| 4 | Can a ticket be checked in twice concurrently? | **BLOCKED (evidence)** | Source: `FOR UPDATE` + CAS + `UNIQUE ticketId`. Real two-connection proof not run in 3C (no `TEST_DATABASE_URL`) → Phase 3G |
| 5 | Can a failed transition still create a `CheckIn`? | **PASS** (no) | CAS lost ⇒ return `STATE`; accepted insert only after `cas.count === 1`; mocked test asserts `tx.checkIn.create` not called |
| 6 | Can a failed insert leave the ticket checked in? | **PASS WITH LIMITATION** | Same transaction ⇒ rollback by MariaDB; mocked test proves no success response/publish/audit, not physical rollback |
| 7 | Can a refunded or refund-blocked ticket be admitted? | **PASS** (no) | `REFUNDED` fails the CAS; open claim refused before CAS; both tested (mocked); real-DB suite not re-run |
| 8 | Can another event's ticket be admitted? | **PASS** (no) | Pre-transaction event match; foreign id not disclosed; tested |
| 9 | Can the parser's reason leak to the caller? | **PASS** (no) | Identical code/message/status for malformed and unsupported; reason only in the internal note/audit |
| 10 | Was existing authorization weakened? | **PASS** (no) | `requireEventCheckInAccess` untouched; static guards for scan/override/assignment still pass; 3A suite 66/66 |
| 11 | Did any unrelated ticketing behaviour change? | **PASS** (no) | Only parse call, method constant, `normalizeCode` body, parser namespace narrowing; 238 tests green |
| 12 | Is concurrency proven by database tests or inferred? | **INFERRED / MOCKED ONLY** | This is the limitation behind the verdict |

---

## 15. Database and migration safety evidence

- `TEST_DATABASE_URL` present in the environment: **no**; `DATABASE_URL`: **no**.
- No `prisma migrate dev|deploy|reset`, `db push`, drop, truncate or data cleanup was run.
- `prisma/schema.prisma` sha256 `0f48e1cea685e9e33b87dd411712514b31605c07053fd89a92e0607f59ac4a99`
  — identical to the Phase 3B baseline; `git status --porcelain -- prisma/` → 0 lines.
- Newest migration still `20260929000000_add_payment_active_order_id`; no directory added.
- No production or customer data was accessed. The dummy `DATABASE_URL` used for the DB-free Jest
  run was a localhost string that never connected (no query executed in those suites; the
  transaction suite mocks Prisma).

---

## 16. Mocked versus real database evidence

- **Mocked:** every `C2` test — branch structure, data written, ordering, refusal rows, error
  mapping. It cannot prove row locks, isolation levels or physical rollback.
- **Pure/static:** `C1`, `C3`, `C4`, plus all Phase 3A/3B/contract suites.
- **Real database:** **not run.** `check-in.integration.test.ts` and
  `check-in-refund-gate.integration.test.ts` need a validated `TEST_DATABASE_URL`, and Jest's
  global setup fails closed without one. They were not simulated, and their concurrency assertions
  are not claimed. This is Phase 3G's scope.

---

## 17. Known limitations and unresolved risks

1. **No 3C real-DB concurrency evidence** (see §16) — the reason for `PASS WITH LIMITATIONS`.
2. **Rollback is relied upon, not observed**: the accepted insert and CAS share a transaction;
   only MariaDB can demonstrate the rollback.
3. **Parser namespace narrowing** (`TICKET :…` now refused by both paths) — intentional parity
   restoration; no production consumer existed between 3B and 3C.
4. **`normalizeCode` remains exported** for compatibility; Phase 3D/3G may retire it once no
   caller depends on it.
5. **Refusal recording is best-effort** (unchanged): a failed refusal write is swallowed and never
   changes the response.
6. **Full repository suite not run** (needs the database); no claim is made about it.
7. **PIC-specific authorization is still absent** by design — Phase 3D wires the decider.

---

## 18. Phase 3D–3G not implemented

No PIC scanner API/route, no UI or camera change, no authorization middleware, no audit-log
expansion, no rate limiting, no PIC attribution persistence, no DB integration infrastructure, no
schema change, no migration, no QR secret delivery. Confirmed by `git status` (two source edits,
all additions listed in §10) and by the 238-test run.

---

## 19. Recommended next phase

**Phase 3D — PIC Scanner API.** Mount the existing service behind an authenticated,
PIC-scoped route (the Phase 3A decider becomes its consumer), keep the public-code path at
`MANUAL`, and leave `QR_SCAN` unreachable until a scanner secret exists. Phase 3D requires its own
approval; nothing of it was started here.

**Final verdict: PASS WITH LIMITATIONS** — implementation sound; real database concurrency
remains unproven and is deferred to Phase 3G.
