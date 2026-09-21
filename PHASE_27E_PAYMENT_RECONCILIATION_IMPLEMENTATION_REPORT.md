# PHASE 27E — PAYMENT RECONCILIATION IMPLEMENTATION

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Mode:** IMPLEMENTATION, bounded and end-to-end (audit first, then code)
**Verdict:** **IMPLEMENTED — READY FOR SANDBOX VERIFICATION** (the existing sandbox payment `233592` **cannot** be
reconciled — see §L; it stays exactly as it is)

---

## A. SCOPE

Turn the Phase 27C audit's recommendation and the Phase 27D-verified provider contract into a working,
operator-triggered reconciliation path for a payment that the provider settled but never successfully
notified us about (Phase 27B: the notify URL was a loopback address, so iPaymu's callback was refused
before any HTTP exchange).

Delivered, in dependency order:

| Step | Artefact |
|---|---|
| Provider client | `lib/payment/ipaymu.ts` → `fetchTransactionStatus` / `normalizeTransactionStatus` (replaces the broken `verifyPaymentStatus`) |
| Seam | `lib/ticketing/payment/gateway.ts` → `queryTransactionStatus`, `isGatewaySuccessStatus`, `providerMethodMatches` |
| Addressability | `Payment.providerTransactionId` + additive migration; captured at payment creation |
| Audit vocabulary | `TicketingAuditAction` + `"payment.reconcile"` |
| Service | `lib/ticketing/payment/reconciliation.ts` → `reconcilePayment` |
| API | `POST /api/organizer/payments/[paymentReference]/reconcile` |
| UI | `components/organizer/ReconcilePaymentButton.tsx` + an action column on `/dashboard/payments` |
| Tests | 3 new suites (65 tests) + 3 new guards in the existing wiring suite |

**Not in scope, and not done:** ticket issuance, refunds, the scheduler, `D-P19-04`, any change to the
webhook's authority, the settlement transaction, the authorization model, or payment creation semantics
beyond capturing the provider's transaction id.

---

## B. STEP 0 — PRE-IMPLEMENTATION DISCOVERY (the four questions)

The phase made this a gate: *if the existing sandbox payment cannot be reconciled without asking an
operator to type a provider transaction id, STOP the free-form path and implement only the safe
infrastructure.* Answers, each with the evidence that produced it:

**Q1 — How can a `PaymentReference` be mapped to a provider transaction id today?**
It cannot, from platform data. The only places the id ever existed were (a) an inbound callback payload
(`WebhookEvent.providerTransactionId`, written only when a callback is actually delivered — 0 rows for
`233592`) and (b) `PaymentTransaction.providerTransactionId`, written only by settlement — 0 rows,
because settlement never ran. `/api/v2/history` is the only documented reference-filtered query, its
response fields are undocumented, and Phase 27D showed the status query does not accept a reference.

**Q2 — Does any persisted field contain the real provider transaction id?**
No — and this phase fixed that going forward, without back-filling anything. Before the change:
`Payment.externalSessionId` was the only candidate, and Phase 27D proved it is **our own
`paymentReference` echoed back by the provider** (the live response's `SessionId`/`ReferenceId` were both
`EVT-1789894187056-ef2c2a78`), so it is not an independent handle and cannot address the query.

**Q3 — Does iPaymu expose a documented lookup from our reference to transaction status?**
No. The documented transaction query filters by `transactionId` (+ `account`); the alternative
(`/api/v2/history`) has no `referenceId` filter and undocumented response fields.

**Q4 — Can `233592` be reconciled without an operator-entered transaction id?**
**No.** Verified read-only against the development database (§L). Therefore, per the phase:

* the free-form transaction-id input was **not** built;
* the real reconciliation action **returns `BLOCKED` / `PROVIDER_TRANSACTION_ID_MISSING`** for that row;
* only the safe infrastructure that makes *future* payments addressable was implemented.

---

## C. PROVIDER CLIENT (`lib/payment/ipaymu.ts`)

### C.1 The three defects this replaces (27C G1–G3, all P0)

| | old `verifyPaymentStatus` | new `fetchTransactionStatus` |
|---|---|---|
| Endpoint | `POST /api/v2/payment/status` — **not in the documented surface** | `POST /api/v2/transaction` (Phase 27D-verified, live) |
| Identifier | `{ sessionId }` | `{ transactionId, account }` |
| Success predicate | `Data.Status` compared to the **strings** `"paid"`/`"settlement"` → `undefined` on the real numeric response → **could never be true** | numeric `Data.Status ∈ {1, 6, 7}` |
| Callers | none | the reconciliation service |
| Tests | none | 25 |

It was **deleted, not repaired**: a second, permanently-false success predicate inside the payment
module is a liability that an auditor cannot distinguish from the live one.

### C.2 The verified wire contract, pinned literally

```
POST {baseUrl}/api/v2/transaction          ← asserted as an exact string in the tests
body    { "transactionId": "<id>", "account": "<merchant VA>" }
headers Content-Type, va, signature, timestamp   ← signature asserted equal to generateSignature(body, va, apiKey)
```

`TransactionId` arrives as a **JSON number**; it is normalised to a string at the seam (one place), so
`233592 === "233592"` is never asked to be true upstream.

### C.3 Fail-closed normalisation

`normalizeTransactionStatus(raw, environment, httpStatus)` is pure, exported and exhaustively tested.
Every refusal is a typed `{ ok: false, reason }`, and it never throws:

| reason | condition |
|---|---|
| `HTTP_ERROR` | non-2xx |
| `NOT_SUCCESS_ENVELOPE` | `Status !== 200` **or** `Success !== true` — `Success` alone is never evidence |
| `MALFORMED` | non-object body, missing `Data`, missing/empty `TransactionId`, non-numeric `Status`, **missing amount** (never defaulted to `0`) |
| `TRANSPORT_ERROR` | DNS/TLS/socket/timeout (abort) |
| `NOT_CONFIGURED` | unusable credentials — **no request is sent at all** |

---

## D. SCHEMA / MIGRATION

```prisma
/// ── PROVIDER TRANSACTION IDENTITY (operator reconciliation) ────────────────
providerTransactionId String?     // nullable, no index, no back-fill
```

* Migration: `prisma/migrations/20260920010000_add_payment_provider_transaction_id/migration.sql` —
  **one `ALTER TABLE … ADD COLUMN … NULL`**. Additive and non-destructive; existing rows are untouched
  and impossible to break (no default, no constraint, no data statement).
* Applied with **`npx prisma migrate deploy`** (never `db push`, never `migrate reset`): dev DB →
  *"24 migrations found … Database schema is up to date!"*.
* Test DB (`tinggalklik_test`) → `npm run test:db:setup` (idempotent; `CREATE DATABASE IF NOT EXISTS` +
  `migrate deploy` + taxonomy seed). The Jest `globalSetup` guard would otherwise refuse to run, which is
  exactly how the "test DB is behind" case was detected.
* **No back-fill, by design.** An identity may only ever come from a provider response. Rows written
  before this column — including `233592` — keep `NULL` and reconcile as `BLOCKED`.

Captured at creation in `recordInstruction` (`lib/ticketing/payment/service.ts`), from
`GatewayInstruction.providerTransactionId`, which `gateway.ts` already parsed out of the direct
response (`String(data.TransactionId)`). The `REDIRECT` session type carries no transaction id — the
provider's own redirect response returns only `SessionId`/`Url` — so hosted-page payments stay `NULL`.

---

## E. THE SERVICE (`lib/ticketing/payment/reconciliation.ts`)

`reconcilePayment(scope, paymentReference, { request })` — one decision path, in this order:

| # | Check | Outcome if it fails |
|---|---|---|
| 1 | payment/order already `PAID` | `ALREADY_SETTLED` (idempotent, **no provider call**) |
| 2 | `Payment.status ∈ {PENDING, UNPAID}` | `BLOCKED / PAYMENT_STATE_INVALID` |
| 3 | order is **not** `CANCELLED`/`EXPIRED` | `BLOCKED / TERMINAL_ORDER` (**no provider call**) |
| 4 | order is exactly `PENDING_PAYMENT` | `BLOCKED / STATE_CHANGED` |
| 5 | `Payment.providerTransactionId` exists (**from the row, never the request**) | `BLOCKED / PROVIDER_TRANSACTION_ID_MISSING` (**no provider call**) |
| 6 | provider query succeeds | `PROVIDER_ERROR` (typed reason) |
| 7 | `status.transactionId === payment.providerTransactionId` | `BLOCKED / TRANSACTION_ID_MISMATCH` |
| 8 | `status.environment === payment.providerEnvironment` | `BLOCKED / ENVIRONMENT_MISMATCH` |
| 9 | echoed `SessionId`/`ReferenceId` is ours (when present) | `BLOCKED / REFERENCE_MISMATCH` |
| 10 | `mapPaymentMethod(provider method/channel) === payment.method` | `BLOCKED / METHOD_MISMATCH` |
| 11 | provider amount **exactly equals** `Payment.amount` **and** `EventOrder.total` (decimal, never float) | `BLOCKED / AMOUNT_MISMATCH` |
| 12 | numeric status ∈ {1, 6, 7} | `PENDING_PROVIDER` (no-op) |
| 13 | → `settleVerifiedPayment(...)` | `RECONCILED` / `ALREADY_SETTLED` / `BLOCKED` |

**Reuse, not reimplementation.** `settleVerifiedPayment` is called **unchanged** — one 20 s transaction,
the order CAS as the arbiter, one `PaymentTransaction`, the canonical `confirmOrderReservations`
conversion, `fulfilmentBlockedAt` on anomalies. Nothing here writes `Payment.status`,
`EventOrder.status`, a counter or a ledger row. `settleVerifiedPayment` itself was **not modified**
(`git diff` shows only `service.ts`, `gateway.ts`, `webhook.ts` (a doc comment), `ipaymu.ts`, the
schema, the audit union and the dashboard files).

**Terminal orders are refused** (`D-P19-04` is undecided). The webhook keeps its existing
late-settlement branch — that records something that already happened — but an operator pressing a
button would be *making* that decision, so reconciliation stops before settlement and says why. A race
that slips past step 3 surfaces as `BLOCKED / ORDER_BECAME_TERMINAL`, reporting what the engine did
rather than repeating it.

**`RETRY_LATER` → `PROVIDER_ERROR`** with `SETTLEMENT_CONTENTION`/`SETTLEMENT_INTEGRITY`, because a
settlement that could not commit is safe to retry and must never look like a business answer.

---

## F. AUTHORIZATION — unchanged model, resolved from the record

* Enforced inside the service: `requireOrganizerAccess(payment.organizerId, PERMISSIONS.PAYMENT_RECONCILE)`
  — the payment's own `organizerId`, **never** a body/query value.
* The tenant is the payment's, so a caller cannot name an organizer, and a cross-tenant identifier is
  refused by the authorization layer with the platform's existing **404** (`ORGANIZER_ACCESS_DENIED`),
  not a 403 that would confirm the row exists.
* Allowed: ACTIVE membership as `OWNER`/`MANAGER`/`FINANCE`; platform `MANAGER`/`PIC`/`CUSTOMER` **with**
  such a membership; platform `ADMIN` with **both** a membership and an active `PermissionGrant`
  (D-19 → `ADMIN_GRANT_REQUIRED`). Forbidden: any platform role without a membership
  (`ORGANIZER_SPANNING_PLATFORM_ROLES` is empty), a buyer acting on their own payment, `CHECKIN_STAFF`,
  and an organizer-level `PIC`.
* **No new permission, no second authorization system, no change to the map** — asserted by the new
  25-test matrix suite (which also pins the refusal *code*).

---

## G. AUDIT

New action `payment.reconcile` in the closed `TicketingAuditAction` union, written for **every** verdict
— including the refusals, which are the ones an incident review needs (`"an operator looked at this and
the evidence did not match"`).

Recorded per attempt: actor user id + platform role, `organizerId`, `entityType: "Payment"`,
`entityRef: payment.id` (a cuid), order number, `orderStatus`, payment status, `localAmount`,
`orderTotal`, `result`, `reason`, provider transaction id, numeric provider status, provider amount,
settlement counts, and `ipAddress`/`userAgent` from the request. The existing forbidden-key filter runs
on top.

**Never logged:** API key, signature, session id, raw provider payload, buyer name/email/phone.
`JSON.stringify(afterState)` is asserted not to match `/buyer|email|phone/i`, and the API result is
asserted not to match `/signature|apiKey|secret/i`.

**Durability — stated honestly.** `writeTicketingAudit` is **fire-and-forget**, as it is for every other
ticketing action; this phase did not change that. The money movement itself is recorded durably by
settlement's own append-only `PaymentTransaction` (plus settlement's existing `payment.success` audit
row), so a lost audit row can never lose a money event. Making `payment.reconcile` itself transactional
is a decision about the audit subsystem, not about reconciliation, and is listed as remaining work
(§O). `correlationId` is not populated because the existing logger accepts no correlation input — it was
not invented here.

---

## H. API

```
POST /api/organizer/payments/[paymentReference]/reconcile
```

* `requireSameOrigin(request)` → `requireAuth()` → service → envelope. Body is **empty**:
  `request.json()` is never called, and a static guard asserts the route contains no `transactionId` and
  no `amount` (and does not reach into the gateway or the settlement engine directly).
* Protected in depth by `proxy.ts`'s existing `/api/organizer/` prefix, and enumerated by the existing
  route-classification test (which fails the build if a route is left unclassified).
* Result mapping: `RECONCILED` / `ALREADY_SETTLED` / `PENDING_PROVIDER` / `BLOCKED` → **200** with
  `data.result` + a safe Indonesian `message`; `PROVIDER_ERROR` → **503 `PROVIDER_UNAVAILABLE`**, so a
  provider outage is never reported as a successful verification (the audit row is already written).
* Live check (production build, anonymous): **401** `{"success":false,"code":"UNAUTHORIZED"}` — the proxy
  answers before the handler runs, so no reference probe can learn whether a payment exists.

---

## I. UI

`/dashboard/payments` gains one **Tindakan** column:

* Rendered **only** where `decideOrganizerPermission(scope, payment.organizerId, PAYMENT_RECONCILE)` allows
  it; otherwise a neutral `—`.
* A row whose provider transaction id was never captured shows the reason
  (*"ID transaksi provider tidak tersedia"*) instead of a button that must fail (phase 12 §15: no
  inapplicable controls).
* The control sends an **empty POST** to a path that names the payment. No transaction-id field, no
  amount field, no status selector, no "mark as paid" — asserted statically.
* Answers are rendered verbatim from the server (`"Pembayaran berhasil diverifikasi dan diselesaikan."`,
  `"Provider belum menyatakan pembayaran berhasil."`, `"Pembayaran sudah diselesaikan."`,
  `"Verifikasi belum dapat dilakukan karena bukti provider tidak lengkap."`,
  `"Provider tidak dapat dihubungi. Silakan coba lagi."`).
* A **401** is handled as a SESSION state (code `UNAUTHORIZED`), not as a failed verification: the
  operator is sent to `/login?callbackUrl=…` with this page as the return path, and the payment is never
  described as failed. 403/404/409/503 keep their own meanings.
* `router.refresh()` after `RECONCILED`/`ALREADY_SETTLED` re-reads the server-rendered row. Nothing
  client-side computes a payment status.

---

## J. TESTS

| Suite | Tests | Covers |
|---|---|---|
| `__tests__/ticketing-payment/transaction-status-client.test.ts` | **25** | the numeric `{1,6,7}` set, the exact endpoint/body/headers/signature, numeric-vs-string `TransactionId`, statuses 1/6/7, non-success status, non-2xx, both envelope halves, missing `Data`/id/amount, non-JSON body, transport error, abort, `NOT_CONFIGURED` with **no** request, and that no credential appears in body or URL |
| `__tests__/ticketing-payment/reconciliation.integration.test.ts` | **16** | real DB: settle + full state assertion; idempotent second call with **no** provider call; amount / transaction-id / reference / environment / instrument mismatch all with a full **financial snapshot equality** on zero writes; missing transaction id and terminal order with **no** provider call; provider pending; transport error; 5xx; **two concurrent reconciliations → one settlement, one `PaymentTransaction`, one conversion**; unknown reference → `NOT_FOUND`; cross-tenant → `ORGANIZER_ACCESS_DENIED`; audit attribution; audit written on refusal |
| `__tests__/authz/reconciliation-authorization.test.ts` | **24** | the full membership × platform-role matrix, ADMIN grant requirement, cross-organizer denial, the refusal code, and "reconciliation is not an `*.own` capability" |
| `__tests__/ticketing-payment/payment-wiring.test.ts` | **+3** (31 total) | the caller set of the settlement primitives, the reconciliation call-site contract, the route's empty body + CSRF, and the operator-surface guard |

**One existing test was updated, and here is why (no test was weakened or deleted):**
`payment-wiring.test.ts` asserted `expect(importers).toEqual([WEBHOOK_MODULE])` — *"the webhook is the
only settlement trigger"*. Design §31.5 rule 3 forbids a browser or an operator from **declaring** a
payment paid; it cannot be read as "the provider's callback is the only way to learn what the provider
did", which is precisely what Phase 27B disproved (a loopback notify URL and money that genuinely
moved). The assertion is now an explicit two-element allow-list **plus** three new guards that make the
rule's substance testable rather than nominal: reconciliation must read the id from the persisted column,
must be `requireOrganizerAccess`-gated on `PAYMENT_RECONCILE`, must gate on the provider's numeric
success predicate, and must not write a paid state itself. That is strictly more coverage than the
single-name assertion had.

`npm test` → **1871/1871 passing, 87 suites** (baseline before this phase: 1803 total, 84 suites). The
intermittent Phase 27 H1 payment-race flake did not fire on this run; no payment-race file is in this
diff.

Focused run, all green: `npx jest __tests__/security __tests__/authz __tests__/auth-flow __tests__/errors __tests__/ticketing-payment --runInBand` → **710/710 passing, 34 suites**.

---

## K. REAL SANDBOX VERIFICATION — what was and was not done

* **No new sandbox payment was created.** The phase forbids it without explicit owner approval, and
  creating one is the only way to prove `providerTransactionId` persistence end-to-end against the real
  provider. **This is the one item still unverified (see §O).**
* **No provider call was made by this phase.** The only network exercise of the new client is against a
  stubbed socket (`response.status` is asserted literally in the tests).
* **Live HTTP check performed** (production build, local, spare port, no DB writes): `GET /` → 200;
  `POST /api/organizer/payments/EVT-nonexistent/reconcile` → **401** `UNAUTHORIZED` (both with and
  without an `Origin` header, i.e. the proxy answers first and the handler cannot be reached
  anonymously).

---

## L. EXISTING SANDBOX PAYMENT `233592` — DISPOSITION (READ ONLY, UNCHANGED)

`paymentReference = EVT-1789894187056-ef2c2a78`, provider transaction id `233592`.

Re-verified against the development database after implementation, read-only:

```
order          EVT-1789894187056-ef2c2a78   PENDING_PAYMENT / PENDING / paidAt=null
payment        PENDING   providerTransactionId = null      providerFlow = DIRECT
PaymentTransaction 0        WebhookEvent 0        Ticket 0
ticketReservation  1 × HELD (quantity 1)
new column present: providerTransactionId  varchar  IS_NULLABLE=YES
```

**Disposition: `BLOCKED / PROVIDER_TRANSACTION_ID_MISSING`.** The platform cannot address the provider
query for this payment, and the phase's explicit rule is that it must not invent an identity, must not
back-fill, and must not offer a free-form transaction-id input. So reconciliation refuses it with the
honest operator message, and **nothing about this row was changed by this phase**.

Two corrections to the Phase 27C record, from re-measurement:

1. `providerFlow` is **`DIRECT`**, not a redirect session as 27C's §13 implies. So the id *would* have
   been captured had this column existed at creation — it is a timing/ordering gap, not a
   provider-contract gap.
2. The provider's `233592` exists only in the callback payload that was received manually and in
   `/tmp`-style artefacts — **nowhere in the database**. A safe recovery would therefore require an
   owner-approved, explicitly documented one-off mechanism (an operator confirming the id against the
   provider's own dashboard and the *signature-verified* payload they hold) — that is a product/owner
   decision about a manual write, and is deliberately **not** implemented.

---

## M. SECURITY REVIEW

**Designs explicitly rejected** (none exists in the code):

| Rejected | Why it is impossible here |
|---|---|
| Browser return/redirect success as evidence | no redirect state is read anywhere in the path |
| Client-supplied payment status | the route reads no body at all |
| Client-supplied amount | amount comes from the provider response and is compared exactly to **two** internal decimals |
| Operator-entered provider transaction id | the id comes only from `Payment.providerTransactionId` |
| Unsigned provider data | the query is authenticated with the platform's own HMAC signature (reused, not re-implemented) |
| Skipping amount validation | step 11 blocks on any mismatch, with zero writes |
| `UPDATE order/payment SET PAID` directly | no such write exists outside `settlement.ts` (asserted) |
| Bypassing `settleVerifiedPayment` | it is the only settlement call in the module (asserted) |
| Generic admin override | `ADMIN` needs both membership and an active grant (D-19) |

**Preserved, verified by test:** webhook signature verification, the webhook's ledger and replay guard,
amount verification on the webhook path, exactly-once settlement and inventory movement, PAID only from
verified provider evidence, exactly-once ticket issuance (reconciliation issues **no** tickets), buyer
isolation, tenant isolation (404 on cross-tenant), and `D-28`/`D-46`/`D-61` behaviour (untouched).

---

## N. VERIFICATION MATRIX

| Command / check | Result |
|---|---|
| `npx prisma validate` | ✅ *The schema at prisma/schema.prisma is valid* |
| `npx prisma migrate status` | ✅ *24 migrations found … Database schema is up to date!* |
| `npx tsc --noEmit` | ✅ clean (0 errors) |
| `npx eslint .` | ✅ **0 errors** / 3 pre-existing warnings (`<img>` in `app/e/[slug]/page.tsx` ×2, `components/events/EventCard.tsx` ×1) — the Phase 24/26 baseline, untouched |
| `npm test -- --runInBand` | ✅ **1871/1871 passing, 87 suites** |
| `npm run build` | ✅ compiled; `/api/organizer/payments/[paymentReference]/reconcile` present in `.next/routes-manifest.json` |
| Live HTTP (production build) | ✅ anonymous `POST` → 401 `UNAUTHORIZED`; `GET /` → 200 |
| Provider calls made | **0** (socket stubbed in every test) |
| Database writes | schema only: the additive column via `migrate deploy` (dev + `_test`). **No business row was created, updated or deleted by this phase.** |
| `git diff --cached --check` | unchanged from the Phase 27B note (pre-existing CR-at-EOL lines in the staged baseline) |

---

## O. REMAINING ISSUES / BLOCKERS

| # | Item | Severity | Owner action |
|---|---|---|---|
| 1 | **`providerTransactionId` persistence is not proven end-to-end.** The capture code path is covered by integration tests through the real payment service with a stubbed socket, but a real sandbox create has not been run since the column exists. Proving it requires creating one sandbox payment. | **P1** | approve one sandbox payment creation (then the flow can be verified live, end to end) |
| 2 | **`233592` cannot be reconciled** (§L) — no persisted identity, and a manual back-fill is forbidden by this phase. | P1 | decide whether a documented one-off recovery mechanism is wanted |
| 3 | **Audit durability.** `payment.reconcile` inherits the existing fire-and-forget writer; the money event itself is durable (`PaymentTransaction`). | P2 | decide whether financial actions get a transactional audit |
| 4 | **No scheduled sweep.** `PAYMENT_RECONCILE` is an organizer authority, so an unattended job would need a SYSTEM actor and a policy for amount-only evidence; Phase 26's scheduler gate is still closed. | P2 | future phase, after the scheduler gate opens |
| 5 | **`D-P19-04` still undecided** (money on a cancelled/expired order). Reconciliation deliberately refuses terminal orders; the webhook's late-settlement branch is unchanged. | P2 | product decision |
| 6 | **The staged index holds a stale `ipaymu.ts` and `gateway.ts`** (both show `MM`: the Phase 26B/27A version is staged, this phase's version is in the worktree). Nothing was staged in this phase, per instruction. | P2 | re-stage those two files before committing (exact command in §Q) |
| 7 | `lib/csrf.ts` unreferenced 401 helpers, `X-XSS-Protection`, tracked `tsconfig.tsbuildinfo` — unchanged from the Phase 25/26 lists. | P3 | already tracked elsewhere |

---

## P. EXACT CHANGED FILES

**New (7 + this report):**

```
prisma/migrations/20260920010000_add_payment_provider_transaction_id/migration.sql
lib/ticketing/payment/reconciliation.ts
app/api/organizer/payments/[paymentReference]/reconcile/route.ts
components/organizer/ReconcilePaymentButton.tsx
__tests__/ticketing-payment/transaction-status-client.test.ts
__tests__/ticketing-payment/reconciliation.integration.test.ts
__tests__/authz/reconciliation-authorization.test.ts
PHASE_27E_PAYMENT_RECONCILIATION_IMPLEMENTATION_REPORT.md
```

**Modified (9):**

| File | Change |
|---|---|
| `lib/payment/ipaymu.ts` | deleted `verifyPaymentStatus`/`isPaymentConfirmed`/`PaymentStatusResponse`; added `fetchTransactionStatus`, `normalizeTransactionStatus`, `IPAYMU_SUCCESS_STATUSES`, `isIpaymuSuccessStatus`, the typed result union; corrected one stale doc comment |
| `lib/ticketing/payment/gateway.ts` | seam: `queryTransactionStatus`, `isGatewaySuccessStatus`, `providerMethodMatches`, type re-exports |
| `lib/ticketing/payment/service.ts` | `recordInstruction` persists `providerTransactionId` (doc updated) |
| `lib/ticketing/audit-log.ts` | `"payment.reconcile"` added to the closed union |
| `lib/ticketing/payment/webhook.ts` | **doc comment only** — records that an operator-triggered poll now exists and why it is not a second authority |
| `prisma/schema.prisma` | `Payment.providerTransactionId String?` (documented) |
| `lib/dashboard/payments.ts` | selects `providerTransactionId`; worklist doc |
| `app/dashboard/payments/page.tsx` | Tindakan column, per-row capability gate, updated page doc |
| `__tests__/ticketing-payment/payment-wiring.test.ts` | the settlement-caller guard (justified above) + 3 new guards |

---

## Q. GIT STATE

* **No commit. No push. No reset. No clean. Nothing staged.** `HEAD` is still **`8628dbf`**.
* The Phase 26B/27A staged baseline is **untouched**: **137 files**, +17667/−1121 — identical to Phase
  27A's end state. None of this phase's new files are staged.
* Two files are `MM` (`lib/payment/ipaymu.ts`, `lib/ticketing/payment/gateway.ts`): the index still holds
  their Phase 26B/27A content while the worktree holds this phase's version. **Before committing, the
  owner must re-stage them** (along with the rest of this phase's work):

```
git add lib/payment/ipaymu.ts lib/ticketing/payment/gateway.ts \
        lib/ticketing/payment/service.ts lib/ticketing/payment/webhook.ts \
        lib/ticketing/audit-log.ts lib/dashboard/payments.ts \
        app/dashboard/payments/page.tsx prisma/schema.prisma \
        prisma/migrations/20260920010000_add_payment_provider_transaction_id \
        lib/ticketing/payment/reconciliation.ts \
        components/organizer/ReconcilePaymentButton.tsx \
        "app/api/organizer/payments/[paymentReference]/reconcile" \
        __tests__/ticketing-payment/transaction-status-client.test.ts \
        __tests__/ticketing-payment/reconciliation.integration.test.ts \
        __tests__/authz/reconciliation-authorization.test.ts \
        __tests__/ticketing-payment/payment-wiring.test.ts \
        PHASE_27E_PAYMENT_RECONCILIATION_IMPLEMENTATION_REPORT.md
```

* **No deployment. No VPS access. No production credentials. No production payment call. No database
  reset, drop or truncation. No destructive migration. No financial, order or payment data created,
  modified or deleted** — the additive column is the only schema change, and the only data written was
  by the test suites, against the dedicated `tinggalklik_test` database.

---

## FINAL VERDICT

**IMPLEMENTED — READY FOR SANDBOX VERIFICATION.**

The reconciliation path is implemented, authorized, audited, fail-closed, tested (65 new tests + 3 new
guards, 1871/1871 green), type-clean, lint-clean and building, and it reuses the existing settlement
engine rather than adding a second one. It is **not** proven against the live provider end to end,
because that requires creating a sandbox payment (§K/§O-1), and the one existing sandbox payment
**cannot** be reconciled from persisted state (§L) — reported as `BLOCKED`, with nothing fabricated and
nothing back-filled.
