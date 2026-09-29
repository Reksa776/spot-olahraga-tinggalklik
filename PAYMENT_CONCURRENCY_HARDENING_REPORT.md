# PAYMENT CONCURRENCY HARDENING — BUG-01 / BUG-02

**Scope:** the two confirmed payment-concurrency defects from `PROJECT_BUG_AUDIT_REPORT.md`.
BUG-03 (deployment origin), BUG-04 (`TRUSTED_PROXY`) and BUG-05 (SSE connection cap) were
**not** touched.

**Outcome:** BUG-01 and BUG-02 are fixed. The concurrency test that used to fail now passes,
and the full suite is green.

---

## 1. BASELINE REPRODUCTION

The race is timing-dependent, so the baseline had to be captured under load as well as in
isolation.

**Full-suite baseline (before the fix):**
```
Test Suites: 1 failed, 153 passed, 154 total
Tests:       1 failed, 3339 passed, 3340 total

FAIL __tests__/ticketing-payment/payment-races.integration.test.ts
  ● H. concurrent payment creation › H1. eight simultaneous Pay clicks produce one provider
    payment, not eight

    expect(received).toHaveLength(expected)
    Expected length: 1
    Received length: 2
    Received array:  [{"body": {"amount": 150000, ...
                       "referenceId": "EVT-1790669189966-48175592"}, ...},
                      {"body": {"amount": 150000, ...
                       "referenceId": "EVT-1790669189966-48175592#2"}, ...}]

    > 230 |         expect(gatewayStub.calls).toHaveLength(1);
```

**Isolated baseline:** the same test sometimes passed and sometimes failed — 8 concurrent
"Pay" calls produced **1** provider call on a lucky interleaving and **2** on the interleaving
the assertion exists to catch. The two references `…#48175592` and `…#48175592#2` are the
signature of the bug: two *different* attempt numbers, i.e. two distinct provider sessions.

**Baseline diagnosis (instrumented, pre-fix):** concurrent claim attempts surfaced
`PrismaClientKnownRequestError P2034` (InnoDB write conflict / deadlock) from the payment
write path — a second, separate contention problem the fix also had to address (see §6).

---

## 2. BUG-01 ROOT CAUSE

`lib/ticketing/payment/service.ts`, pre-fix:

```ts
const attemptNumber = (await prisma.payment.count({ where: { orderId: order.id } })) + 1;
const paymentReference = buildPaymentReference(orderNumber, attemptNumber);
// then prisma.payment.create({ ... paymentReference ... })
```

The design's guard was the unique `paymentReference`, on the theory that "two simultaneous
Pay clicks compute the same attempt number, and the loser's insert is rejected by the
database". That is a time-of-check/time-of-use race:

1. Caller A reads `count() = 0`, computes attempt `1`, inserts `paymentReference = EVT-…`.
2. Caller A's insert **commits** and it begins its (slow, out-of-transaction) provider call.
   Its row is `UNPAID` with no URL/QR/number yet.
3. Caller B reads `count() = 1` **after A's commit**, computes attempt `2`, and therefore
   produces a **different** value: `EVT-…#2`.
4. A different value does not collide with the unique index, so B's insert **succeeds** and B
   opens a **second payable provider session** for the same order.

The pre-claim "resume" check could not stop this either, because it only treated a row as
live once it carried `paymentUrl`/`qrString`/`paymentNumber` — a bare committed claim looked
like "no attempt exists".

**Impact:** a buyer can hold two payable QRIS/VA instruments for one order; the gateway can
send two success notifications; the first settles, the second is absorbed as
`ALREADY_PAID`/`LATE_SETTLEMENT` and needs a manual refund.

---

## 3. BUG-02 ROOT CAUSE

`prisma/schema.prisma`, pre-fix: `Payment.paymentReference` was `@unique`, but there was **no
constraint binding an order to a single *active* attempt**. `@@index([orderId, status])` is an
index, not a constraint. The design comment in `lib/ticketing/payment/reference.ts` even
records that the shipped schema has **no `activePaymentKey`** ("The shipped Phase 2 schema has
no `activePaymentKey`") — so the intended structural mechanism had never been built, leaving
only the racy application check of BUG-01.

---

## 4. CHOSEN CONCURRENCY STRATEGY

Both halves are database-side; no Redis, no in-memory locks, no flags, no sleeps as a guard.

1. **Atomic transactional claim, serialized on the `eventorder` row.** The resume-or-claim
   decision moved into one interactive transaction whose first statement is
   `SELECT id FROM eventorder WHERE id = ? FOR UPDATE`. Only the lock holder may read the
   active attempt and create a new one. (This is the design-consistent "atomic order-row
   locking/serialization" option; the same row is already the lock root for cancel,
   settlement and the reaper, so the lock ORDER is unchanged.)
2. **Durable, DB-enforced uniqueness.** A new nullable `Payment.activeOrderId` is set to the
   order id while the attempt is non-terminal and `NULL` once it is terminal, with
   `@@unique([activeOrderId])`. This is the `activePaymentKey` the design asked for, expressed
   as a column plus a unique index. It is enforced by the database, so a caller that bypassed
   the claim still cannot create a second active attempt.

Activity is decided by **`status` alone** (`UNPAID`/`PENDING`); instrument fields are used only
to distinguish "resume this session" from "creation is in progress".

---

## 5. DATABASE INVARIANT

> For every `EventOrder` there is **at most one** `Payment` whose status is `UNPAID` or
> `PENDING`.

- `activeOrderId = orderId` while active; `NULL` when terminal.
- MySQL/MariaDB treat multiple `NULL`s as distinct in a unique index, so terminal attempts
  accumulate freely as history and a retry after `FAILED`/`EXPIRED` is always possible.
- Enforced by `UNIQUE KEY payment_activeOrderId_key (activeOrderId)`, verified present:
  ```
  SHOW INDEX FROM payment WHERE Key_name='payment_activeOrderId_key';
  → payment_activeOrderId_key  seq 1  column activeOrderId  non_unique=0  BTREE
  ```
- Terminal writers release the slot in the same statement as the status change:
  `settlePaymentRow` (`PAID`), `failVerifiedPayment` (`FAILED`),
  `service.ts#failAttempt` (`FAILED`), `voidOpenPayments` (`EXPIRED`).

---

## 6. TRANSACTION / LOCKING BEHAVIOR

`claimActivePayment()` runs inside `prisma.$transaction` with `{ timeout: 20_000 }`:

1. `lockEventOrderRow(tx, order.id)` → `SELECT id FROM eventorder WHERE id = ? FOR UPDATE`.
2. Re-read the locked order and re-run the payable gate (`assertOrderStatePayable`) — a
   settlement or cancel that won the row between the pre-read snapshot and the lock is caught.
3. Self-heal: clear `activeOrderId` on any **terminal** row that still holds it (defence
   against a stale pointer; terminal writers also clear it).
4. Find the single active attempt **by status only**. If found → `resume` (if it has an
   instrument) or `in_progress` (if it does not).
5. Otherwise compute the attempt number and `create` the claim with
   `activeOrderId = orderId`. Only the lock holder reaches this step, so the attempt number is
   computed against a stable set of rows.

**Contention handling (measured, not assumed).** With 8 concurrent claims the transactions
serialize, but InnoDB still occasionally chose one as a deadlock victim (`P2034`) — in the
claim, and (discovered during verification) in the post-provider `recordSession`/
`recordInstruction` write. Both are now wrapped in the project's existing
`withContentionRetry` (`lib/ticketing/db-contention.ts`) — the same bounded, jittered retry the
settlement path uses:

- the claim is retried whole, so a retry re-evaluates the guards and can only observe the
  active attempt (`in_progress`);
- the post-provider write is a guarded, idempotent `updateMany` (`paymentUrl: null`), so
  re-running it is safe; exhaustion is surfaced as a retryable
  `PROVIDER_UNAVAILABLE / PAYMENT_ROW_CONTENTION`, never a 500.

The raw `SELECT … FOR UPDATE` lives in a new named primitive
`lib/ticketing/order-lock.ts#lockEventOrderRow`, because
`__tests__/ticketing-payment/payment-wiring.test.ts` forbids raw SQL inside
`lib/ticketing/payment/*` and that guard must keep passing.

---

## 7. PROVIDER-CALL BEHAVIOR

External calls stay **outside** any transaction (design §13.3), unchanged:

- The claim transaction commits the `UNPAID` claim row and returns; only then does the caller
  invoke the gateway.
- Because the committed claim row is ACTIVE, any concurrent caller that acquires the order
  lock afterwards sees it and is refused (`in_progress`) or resumed (if the instrument has
  since landed). There is no window in which a second caller can create a second claim.
- Exactly one caller per order owns provider creation; the gateway is called at most once per
  active attempt.

---

## 8. HOW PAYMENT_CREATION_IN_PROGRESS IS HANDLED

- A committed `UNPAID`/`PENDING` row **with no instrument is ACTIVE**, and a new attempt is
  refused with:
  ```json
  { "code": "CONFLICT", "details": { "reason": "PAYMENT_CREATION_IN_PROGRESS" } }
  ```
- The same refusal is produced when contention retries are exhausted (another claim is
  racing), via the shared `paymentCreationInProgress()` helper so the two branches cannot
  drift.
- The `UNPAID`-forever case (a process dying between the claim commit and the provider
  response) is bounded by the existing reservation TTL / reaper, which voids the open payment
  (`voidOpenPayments`) — preserving the existing expiry semantics rather than inventing a new
  one.

---

## 9. PROVIDER FAILURE BEHAVIOR

Unchanged in shape, hardened in state:

- A provider failure calls `failAttempt`, which sets the claim row to `FAILED`, records the
  channel, and **releases `activeOrderId`**. The order stays `PENDING_PAYMENT` / `UNPAID`.
- Because `FAILED` is terminal, the next request creates a **new** attempt (`…#2`), exactly as
  before. The release of the active slot guarantees the durable unique index can never wedge
  that retry.
- A webhook-reported failure (`failVerifiedPayment`) likewise sets `FAILED` +
  `activeOrderId: null` while cancelling the order and releasing reservations.
- Expiry, webhook, settlement, reconciliation and refund behavior are otherwise untouched.

---

## 10. BEFORE / AFTER PAYMENT FLOW

**Before**
```
Pay → ownership check → payable check → find "live" (instrument only)
    → count() attempts → insert Payment(reference = …)          ← racy
    → provider call → record session
```
A second caller arriving after the first insert committed computed `…#2` and opened a second
session.

**After**
```
Pay → ownership check → payable check
    → CLAIM (one transaction):
         SELECT … FOR UPDATE on eventorder       ← serialization
         re-validate against the locked row
         clear activeOrderId on terminal rows
         find active attempt BY STATUS
           found + instrument → resume
           found, no instrument → PAYMENT_CREATION_IN_PROGRESS
           none → insert Payment(activeOrderId = orderId)   ← unique-active invariant
    → provider call (outside the transaction) → record session (retried)
```

---

## 11. TESTS ADDED / CHANGED

**Changed — `__tests__/ticketing-payment/payment-races.integration.test.ts` (H1):** added the
invariant assertions the test's name promises — exactly one ACTIVE attempt, exactly one
`Payment` row, and no reference containing `#` (i.e. no `…#2`). A temporary debug probe used
during diagnosis was removed.

**Added — `__tests__/ticketing-payment/payment-active-attempt.integration.test.ts` (7 tests):**

| Test | Spec item | Asserts |
| --- | --- | --- |
| A1 bare claim is IN_PROGRESS | §9.6 | committed `UNPAID` row with no instrument → `CONFLICT / PAYMENT_CREATION_IN_PROGRESS`, **0** provider calls, 1 row |
| A2 active + instrument resumes | §9.5 | second call `resumed: true`, same reference/URL, 1 provider call, 1 row |
| A3 EXPIRED terminal does not block | §9.8 | real `voidOpenPayments` write → new attempt (`…#2`), rows `[EXPIRED, PENDING]`, exactly one active |
| A4 FAILED terminal does not block | §9.9 | provider 503 → row `FAILED` with `activeOrderId = NULL` → retry creates a new attempt, 2 calls, 2 rows |
| A5 provider failure does not wedge | §9.10 | order stays `PENDING_PAYMENT`/`UNPAID`; retry succeeds with `…#2` |
| A6 DB rejects a second active attempt | §9.2/§9.3, BUG-02 | direct insert of a second ACTIVE row (distinct reference) → `P2002`; still 1 row |
| A7 terminal attempts coexist | §9.7 | two `NULL`-pointer terminal rows coexist; a new attempt is still creatable |

Concurrency (spec §9.1–§9.4) remains covered by H1 in `payment-races`, now with the stronger
assertions. Existing webhook/settlement suites are unchanged and green (§9.11).

---

## 12. TEST RESULTS

```
# focused race suite (spec §10.A), 6 consecutive runs
payment-races.integration.test.ts   PASS 6/6   (was failing)

# payment directory
Test Suites: 10 passed, 10 total
Tests:       161 passed, 161 total

# FULL suite (spec §10.B)
Test Suites: 155 passed, 155 total      (was 153 passed / 1 failed)
Tests:       3347 passed, 3347 total    (was 3339 passed / 1 failed)
Snapshots:   2 passed, 2 total
Time:        107.82 s
```
**No failures remain.** The previously failing H1 test now passes, and the new suite adds 7
tests.

---

## 13. TYPECHECK RESULT

```
npx tsc --noEmit --incremental false
→ exit 0 (clean)
```

## 14. LINT RESULT

```
npm run lint
→ exit 0
✖ 4 problems (0 errors, 4 warnings)
```
The 4 warnings are pre-existing and unrelated (`no-img-element` x3 in
`app/e/[slug]/page.tsx` and `components/events/EventCard.tsx`; an unused `custCookies` in
`scripts/verify-phase33-live.js`).

## 15. BUILD RESULT

```
npm run build
→ exit 0 (production build completed)
```

---

## 16. MIGRATION DETAILS

- **Name:** `20260929000000_add_payment_active_order_id`
- **File:** `prisma/migrations/20260929000000_add_payment_active_order_id/migration.sql`
- **Schema change:** `Payment.activeOrderId String?` + `@@unique([activeOrderId])`
- **SQL-level invariant:**
  ```sql
  ALTER TABLE `payment` ADD COLUMN `activeOrderId` VARCHAR(191) NULL;

  -- Back-fill: the NEWEST active attempt per order claims the slot (window function,
  -- MariaDB 10.2+ / MySQL 8.0+). Any pre-existing duplicate active attempts contribute only
  -- their newest row; the older ones keep their status and get a NULL pointer, so the unique
  -- index can be created. No status is rewritten and no row is deleted.
  UPDATE `payment` p
  JOIN ( SELECT `id` FROM (
           SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `orderId`
                                           ORDER BY `createdAt` DESC, `id` DESC) AS `rn`
           FROM `payment` WHERE `status` IN ('UNPAID','PENDING')
         ) ranked WHERE ranked.`rn` = 1
  ) newest ON newest.`id` = p.`id`
  SET p.`activeOrderId` = p.`orderId`;

  CREATE UNIQUE INDEX `payment_activeOrderId_key` ON `payment`(`activeOrderId`);
  ```
- **MariaDB/MySQL compatibility:** verified by **actually applying** it to MariaDB 11.8 — the
  windowed `UPDATE … JOIN (derived table)` form is used so source and target are not the same
  open table in one statement, and `VARCHAR(191)` suits the `utf8mb4` index limit.
- **Actually applied?** **Yes — to the TEST database** (`tinggalklik_test`) through
  `npm run test:db:setup` → `prisma migrate deploy` (non-destructive, additive):
  ```
  Applying migration `20260929000000_add_payment_active_order_id`
  All migrations have been successfully applied.
  ```
  **Not applied to the application database** (`tinggalklik`); `prisma migrate status` still
  lists it as pending there. It was left pending deliberately (this phase must not mutate the
  application database) and is a normal pre-deploy state — `prisma migrate deploy` in the
  deployment step will apply it.
- **Validation:** `npx prisma validate` → *"The schema at prisma/schema.prisma is valid"*.

---

## 17. EXISTING DB ROWS AFFECTED

No status was changed, no row was inserted or deleted. The only effect is the additive column
populated on non-terminal rows.

- Pre-migration check (both databases): **0** orders with more than one active attempt, so no
  dedup path was exercised.
  ```
  tinggalklik       active_rows=6    orders_with_multi_active=0
  tinggalklik_test  active_rows=125  orders_with_multi_active=0
  ```
- Post-migration verification on `tinggalklik_test`:
  ```
  active_without_pointer   0
  terminal_with_pointer    0
  ```

---

## 18. FILES CHANGED

**Modified (5):**
| File | Change |
| --- | --- |
| `prisma/schema.prisma` | +`Payment.activeOrderId` (documented invariant) and `@@unique([activeOrderId])` (+14 lines) |
| `lib/ticketing/payment/service.ts` | the transactional claim (`claimActivePayment`), status-only activity detection, `paymentCreationInProgress()`, `writePaymentRow()` contention retry, `assertOrderStatePayable()` extraction, `activeOrderId` release on `FAILED`, reference from the created row |
| `lib/ticketing/payment/void.ts` | release `activeOrderId` with the terminal status |
| `lib/ticketing/payment/settlement.ts` | release `activeOrderId` on `PAID` / `FAILED` |
| `__tests__/ticketing-payment/payment-races.integration.test.ts` | H1 invariant assertions |

**Added (3):**
| File | Purpose |
| --- | --- |
| `prisma/migrations/20260929000000_add_payment_active_order_id/migration.sql` | the migration |
| `lib/ticketing/order-lock.ts` | shared `SELECT … FOR UPDATE` primitive (keeps raw SQL out of the payment layer) |
| `__tests__/ticketing-payment/payment-active-attempt.integration.test.ts` | the invariant suite |

**Pre-existing untracked (from the audit phase, not part of this phase):**
`PROJECT_BUG_AUDIT_REPORT.md`.

**Process note (transparency):** during implementation an initial `prettier`/`prisma format`
pass re-indented the touched files from the project's 4-space style to prettier defaults,
producing a large formatting-only diff. That was discarded with
`git checkout -- <the 4 touched files>` and every logical edit was re-applied by hand in the
project's existing style; no committed work was affected and the final diff above is
intentional. (Not a `reset`, `rebase`, `stash` or `push`.)

---

## 19. REMAINING RISKS

- **Migration not yet applied to the application database.** The code and a migrated schema
  are required together: `prisma.payment.create` writes `activeOrderId`, so the app DB must be
  migrated (`prisma migrate deploy`) before this code is deployed. This is the standard
  deploy-order requirement and is called out rather than hidden.
- **Two statements per claim** (lock + read + optional create) inside one transaction, each
  bounded by a 20 s timeout and the shared contention retry. Under extreme contention a claim
  can be refused with `PAYMENT_CREATION_IN_PROGRESS` (retryable) rather than creating a second
  session — the safe direction.
- **A crash between the claim commit and the provider response** leaves an ACTIVE `UNPAID`
  row. This is now *deliberately* blocking (spec §3/§5) and is cleared by the existing
  reservation TTL / reaper; the alternative (treating it as absent) is BUG-01.
- **The self-heal `updateMany`** adds one narrow write to the claim path. It is retained as
  the safety net against a stale pointer wedging a retry; every terminal writer also releases
  the slot.
- BUG-03, BUG-04, BUG-05 remain open by design (out of scope).

---

## 20. GIT STATUS

```
$ git status --porcelain
 M __tests__/ticketing-payment/payment-races.integration.test.ts
 M lib/ticketing/payment/service.ts
 M lib/ticketing/payment/settlement.ts
 M lib/ticketing/payment/void.ts
 M prisma/schema.prisma
?? PROJECT_BUG_AUDIT_REPORT.md
?? __tests__/ticketing-payment/payment-active-attempt.integration.test.ts
?? lib/ticketing/order-lock.ts
?? prisma/migrations/20260929000000_add_payment_active_order_id/

$ git log --oneline -1
23f4faf fix redirect dashboatd2          # unchanged: no commit was made
$ git stash list | wc -l
0
```
No files staged; HEAD unchanged.

---

## 21. CONFIRMATION

- **No commit** was performed.
- **No push** was performed.
- **No reset** was performed.
- **No rebase** was performed.
- **No stash** was performed (`git stash list` is empty).
- **No destructive database command** was run. The only database write was the additive,
  non-destructive `prisma migrate deploy` against the dedicated **test** database; the
  application database was left untouched (the migration is reported as pending on it).
- `npm audit fix --force` was **not** run, no dependency was changed, and no unrelated module
  was refactored.
