# PHASE 3C — CHECK-IN TRANSACTION DESIGN

**Status:** written before any Phase 3C edit to `service.ts` (Checkpoint 2).
**Baseline:** `main` @ `9b8fecd99bcc74677c1805c18379241af04fddd1`, Phase 3A.6 PASS, Phase 3B PASS.
**Scope:** integrate the Phase 3B QR parser and method resolver into the **existing** transaction.
No route, no UI, no authorization wiring, no schema change, no migration.

---

## 1. The existing execution path (source-audited)

Entry point: `checkInTicket({ eventId, input, request? })` —
`lib/ticketing/checkin/service.ts:301`.

| # | Step | Where | Inside the transaction? |
|---|---|---|---|
| 1 | Resolve actor authority: `requireEventAccess(eventId, checkin.scan)`, then an ACTIVE `OrganizerMember`, then — for a member without `checkin.override` — an active `StaffEventAssignment` | `:178` `requireEventCheckInAccess`; `:306` call | no (before) |
| 2 | Load the event (`status`, `endAt`, `archivedAt`, `cancelledAt`) | `:311` `prisma.event.findUniqueOrThrow` | no |
| 3 | Gate window: `isEventCheckInOpen(gate, now)` — the canonical predicate | `:369` | no |
| 4 | Normalise the presented code | `:232` `normalizeCode` (until 3C), called at `:383`… now the parser | no |
| 5 | Look the ticket up by `ticketCode` (`@unique`) | `:392` `prisma.ticket.findUnique` | no |
| 6 | Event ownership: `ticket.eventId !== gate.id` ⇒ `WRONG_EVENT` (the real event is not disclosed) | `:404` | no |
| 7 | `SELECT id FROM ticket WHERE id = ? FOR UPDATE` | `:443` | **yes** |
| 8 | Open-refund guard: any `RefundItem` whose `Refund.status ∈ PENDING/APPROVED/PROCESSING` ⇒ `REFUND_PENDING` | `:445`–`:456`, `OPEN_REFUND_STATUSES` at `:82` | **yes** |
| 9 | CAS: `updateMany({ where: { id, status: "ISSUED", checkedInAt: null }, data: { status: "CHECKED_IN", checkedInAt: now } })` | `:459` | **yes** |
| 10 | `cas.count !== 1` ⇒ read the committed state, return `STATE` | `:468` | **yes** |
| 11 | Insert the accepted `CheckIn` row (`ticketId` is `@unique`) | `:479`, schema `prisma/schema.prisma:1227` | **yes** |
| 12 | Refusals outside the transaction: append-only `CheckIn` row with `result`/`note`, then `checkin.rejected` audit, then throw `AppError` | `:242` `recordRejectedAttempt`, `:330` `refuse` | no (by design: a refusal must survive the rollback of nothing) |
| 13 | After commit: realtime invalidation, `checkin.success` audit, success payload (`method: MANUAL`) | `:566`, `:576`, `:597` | no |

Ordered sequence (actual):

```
authorize → load event → gate window open? → parse code → find ticket
   → same event? → BEGIN
        FOR UPDATE on ticket
        open-refund guard?  ── yes ──▶ rollback-free return REFUND_PENDING
        CAS ISSUED + checkedInAt IS NULL → CHECKED_IN
        cas.count !== 1 ?  ── yes ──▶ read fresh state, return STATE
        INSERT CheckIn (ticketId UNIQUE)
      COMMIT
   → publish realtime → audit success → return
```

The brief's checklist order matches, with one correction: the refund guard is evaluated **after**
the lock and **before** the CAS, which is what makes the guard race-free. The parser step sits
before the lookup, also inside the same request but outside the transaction — it reads no state,
so moving it would buy nothing.

## 2. Concurrency analysis (from source, not from the existence of `$transaction`)

- **Two simultaneous scans, same ticket.** Both reach `FOR UPDATE` on the same `ticket` row. The
  second waits; when it proceeds, the first has committed `CHECKED_IN`, so its CAS matches 0 rows
  (`status` no longer `ISSUED`, `checkedInAt` not null). It returns `STATE`, reads
  `CHECKED_IN`, answers `TICKET_ALREADY_CHECKED_IN`. The UNIQUE `CheckIn.ticketId` is a second,
  independent guarantee: a retry that somehow passed the CAS would fail on insert and roll back.
- **Scan racing a refund.** `requestRefund` locks the same rows
  (`lib/ticketing/refunds/service.ts:234–241`, `SELECT id, status, checkedInAt … ORDER BY id FOR
  UPDATE`), then re-checks `checkedInAt !== null` (`:257`) and `status !== "ISSUED"` (`:268`)
  **inside** its transaction. The gate locks one row and reads `refundItem` after the lock. The
  two orders are therefore the only two possible outcomes: refund first ⇒ gate sees the claim and
  answers `REFUND_PENDING`; check-in first ⇒ refund sees `checkedInAt` and refuses. Rows are
  locked in ascending id order on the refund side, which a single-row lock cannot invert, so the
  pair cannot deadlock.
- **Status change without evidence / evidence without status.** Both writes are in one
  `$transaction`; the CAS and the insert either both commit or neither does. A throwing insert
  propagates out of `$transaction`, rolling the CAS back (MariaDB/InnoDB, default
  `REPEATABLE READ`, turned into `READ COMMITTED`-style freshness for the locked row by the
  explicit `FOR UPDATE`).
- **Lock before the checks that depend on it.** Yes: `FOR UPDATE` (`:443`) precedes the refund
  read (`:445`) and the CAS (`:459`). A guard read before the lock would be a TOCTOU hole; it is
  not.
- **Failure paths.** Every refusal that happens after the transaction began is a *return value*
  (`AdmissionOutcome`), so the transaction commits nothing and the refusal is recorded outside it.
  Authorization failures, wrong event and unknown ticket never open a transaction at all.

**What is inferred rather than proven here:** the above is a source-level argument plus the
existing real-DB suites in the repository (`check-in.integration.test.ts`,
`check-in-refund-gate.integration.test.ts`), which Phase 3C does **not** re-run (no
`TEST_DATABASE_URL` in this environment) and does not extend. Real two-connection concurrency
evidence remains Phase 3G.

## 3. QR parser integration point

`service.ts` now:

1. imports `parseCheckInQrPayload` from `./qr-payload` and calls it on `params.input.code`
   (`:383`), replacing the inline normaliser;
2. treats **every** rejection identically — `AppError.notFound("Tiket tidak ditemukan.")`,
   `result: "INVALID_TICKET"`, `note: "UNRECOGNIZED_CODE_FORMAT"` — so the reason enum never
   reaches the client and malformed ≡ unknown (design §20.2 check 1);
3. uses `presented.ticketCode` (the canonical, upper-case, prefix-stripped code) as the lookup
   key and the `note` on refusals;
4. keeps the exported `normalizeCode(raw)` as a **delegation** to the parser, so Phase 13's
   pinned tests and any existing caller keep their contract without a second implementation.

No raw submitted payload is stored: the refusal note is the constant string, and an unknown code
stores only the *canonical* code (already the case before 3C).

## 4. Compatibility matrix

`legacy` = the Phase 13 formula (`trim → optional "TICKET:" via startsWith → upper-case →
isTicketCode`). `parser` = `parseCheckInQrPayload` after the 3C parity correction.

| Input | legacy | parser | Outcome |
|---|---|---|---|
| `EVT-2345-6789` | accept | accept | identical |
| `evt-2345-6789` | accept | accept | identical |
| `  TICKET:EVT-2345-6789  ` | accept | accept | identical |
| `TICKET:  EVT-2345-6789` | accept | accept | identical |
| `ticket:evt-2345-6789` | accept | accept | identical |
| `TICKET :EVT-2345-6789` | **reject** | **reject** (3C) | parser previously accepted; corrected |
| `EVT-2345-6789:extra` | reject | reject (`UNSUPPORTED_FORMAT`) | identical externally |
| `TIKET:EVT-2345-6789` | reject | reject | identical externally |
| `https://…`, `mailto:…` | reject | reject | identical externally |
| `TICKET:` / `ticket:` | reject | reject | identical externally |
| `""` / `"   "` | reject | reject | identical externally |
| `EVT-0000-0000`, 64-hex, base64url, SQL/path junk | reject | reject | identical externally |
| >120 chars | reject | reject earlier | identical externally |

**The one change:** Phase 3B's parser split at the first `:` and trimmed the namespace, so
`TICKET :EVT-2345-6789` was accepted by the parser but refused by the gate. Phase 3C changes the
parser to `startsWith("TICKET:")` + "any other colon ⇒ unsupported", which is exactly the legacy
acceptance set. This narrows by one input; it widens nothing.

The differential test in `__tests__/ticketing-checkin/check-in-transaction.test.ts` runs the
legacy formula as an oracle over a 24-input matrix and asserts the parser and `normalizeCode`
agree on every row. Phase 13's own parser matrix (`check-in-wiring.test.ts` P13-1) is left
unchanged and still passes, which is the second, independent check on the same surface.

## 5. Transaction invariants (must remain true after this phase)

1. The ticket row is locked (`FOR UPDATE`) before the refund guard and the CAS.
2. The refund guard is read *inside* the transaction, after the lock.
3. The status transition is conditional: `status = 'ISSUED'` **and** `checkedInAt IS NULL`.
4. The accepted `CheckIn` insert is in the same transaction as the CAS.
5. `CheckIn.ticketId` is `@unique` (schema `:1227`).
6. No duplicate admission is possible even if (3) or (5) alone were removed.
7. The event relationship is checked before the transaction, and the tenant comes from the event
   row, never from the request body.
8. Refusals never carry `ticketId` (it is unique and belongs to the one admission).
9. No client-supplied field chooses `method`, `result`, `selectedTicket` or the actor.

Phase 3C edits **none** of these; the only edits are the parse call, the method constant's
definition, and the `normalizeCode` body.

## 6. `CheckInMethod` selection

`const CHECK_IN_METHOD = resolveCheckInMethod("PUBLIC_TICKET_CODE")` → `"MANUAL"`.

That value is written on the accepted row and on every refusal row. It is independent of:
camera use, QR decoding, the `TICKET:` prefix, `presentedAs`, and any request field. `QR_SCAN`
stays unreachable because no scanner-secret verification exists (D-46). The Prisma enum is
unchanged (`prisma/schema.prisma:528`), and `CheckInMethodValue` aliases it (Phase 3B).

## 7. Error and rollback behaviour

- Parser rejection → `NOT_FOUND` (404), `INVALID_TICKET` refusal row, audit `checkin.rejected`.
- Unknown code → same 404 and same message; note is the canonical code.
- Wrong event → `CONFLICT` 409, `reason: WRONG_EVENT`; the other event is not named.
- Refund pending → `CONFLICT` 409, `reason: REFUND_PENDING`, `result: REFUND_PENDING`.
- CAS lost → `TICKET_ALREADY_CHECKED_IN` 409 with first-admission metadata.
- Non-`ISSUED` → `CONFLICT` 409, `reason: TICKET_NOT_ISSUED`, result `UNPAID` for `RESERVED`,
  else `INVALID_TICKET`.
- Gate closed → `CONFLICT` 409, `reason: EVENT_NOT_OPEN`.
- A throwing accept-insert propagates: no success payload, no realtime publish, no success audit.

## 8. Test strategy

New `__tests__/ticketing-checkin/check-in-transaction.test.ts`:

- **A. Integration + parity (pure/static):** legacy-oracle matrix, `normalizeCode` parity
  including `TICKET :…`, canonical lookup key, static checks that the service calls the parser and
  resolver and keeps lock → guard → CAS → insert in that order.
- **B. Mocked transaction:** success ordering, refund-pending, CAS-lost, `VOID`/`RESERVED`,
  insert failure, wrong event, unknown ticket, malformed/unsupported, closed gate, no raw echo.
  Explicitly labelled mocked — it proves the branch structure and the data written, **not** InnoDB
  locking or isolation.
- **C. Method:** `PUBLIC_TICKET_CODE` ⇒ `MANUAL`, prefixed payload ⇒ `MANUAL`, request schema
  refuses `method`/`checkInMethod`/`result`/actor fields, no `QR_SCAN` written.
- **D. Regression:** Phase 3B (76), Phase 3A (66), QR contract (17), and the existing Phase 13
  wiring suite (parser matrix, CAS/static guards) under a DB-free config.

Real-database suites (`check-in.integration.test.ts`, `check-in-refund-gate.integration.test.ts`)
are **not run** in this phase: `TEST_DATABASE_URL` is absent from the environment and Jest's
guard fails closed. That evidence belongs to Phase 3G and is reported as a limitation, never
simulated with mocks.

## 9. Known risks

1. **No real two-connection proof in 3C.** Mitigated by unchanged transaction code, the existing
   real-DB suites (not re-run), and static ordering guards.
2. **Parser integration changes the surface `normalizeCode` exposes.** Mitigated by delegation
   plus the parity matrix and Phase 13's untouched expectations.
3. **`presentedAs` could tempt a future method escalation.** Mitigated by the resolver contract
   and a test that the prefixed payload still records `MANUAL`.
4. **Refusal rows are written outside the transaction.** Unchanged from Phase 13; a failure of
   that best-effort write is swallowed and never changes the response.
5. **`TICKET :…` is now refused by both paths** — a behaviour narrowing relative to Phase 3B's
   untracked module, restoring Phase 13 parity. No production consumer existed between the two
   phases.
