# PHASE 27C — PAYMENT RECONCILIATION AUDIT

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Scope:** audit only. **No source file was modified. No database row was written, updated or deleted. No migration. No provider API call of any kind (iPaymu sandbox or production). No commit / push / reset / clean.**

---

## 1. VERDICT

> ### **RECONCILIATION BLOCKED — INTERNAL DESIGN GAP**
>
> The provider capability **exists** (iPaymu documents a real-time transaction status query), and
> `settleVerifiedPayment` is **reusable unchanged**. What blocks implementation is on our side: the
> existing provider query targets an **undocumented endpoint with the wrong request field and a
> success predicate that can never match the documented response**, the platform **does not persist
> the identifier** the documented query requires, and the documented status response carries **no
> amount** — so a poll alone cannot satisfy the amount-equality contract.
>
> The provider-side residue (whether the documented path behaves as published) can only be closed by
> **one sandbox verification call**, which this phase is forbidden to make. So this is *not* labelled
> a provider-capability gap: the capability is documented and reachable; our integration of it is
> wrong and unverified.

**Blocking findings**

| ID | Severity | Finding | Evidence |
|---|---|---|---|
| **G1** | **P0** | `verifyPaymentStatus` posts to `POST /api/v2/payment/status`. iPaymu's documented check-transaction endpoint is **`POST /api/v2/transaction`**. The implemented path does not appear anywhere in the documented v2 surface | `lib/payment/ipaymu.ts:1279`, `:1321` vs §4 |
| **G2** | **P0** | Its success predicate can never be true: `isPaymentConfirmed` requires `Data.Status` ∈ `"paid" \| "settlement"` (strings). The documented response is `Data.Status` **numeric — 1, 6 or 7 mean success** | `lib/payment/ipaymu.ts:1353-1363` vs §4 |
| **G3** | **P0** | Wrong request body: sends `{ sessionId }`. The documented request is `transactionId` (**the iPaymu transaction id**) plus `account` | `lib/payment/ipaymu.ts:1307-1309` vs §4 |
| **G4** | **P1** | The documented status response carries **no amount**, so the poll cannot supply the amount evidence the settlement contract requires | §4.3, §8 |
| **G5** | **P1** | The platform stores **no provider transaction id before settlement** (`Payment` has no such column; `GatewayInstruction.providerTransactionId` is dropped), so the documented query cannot be addressed from platform data for exactly the case that needs it | `prisma/schema.prisma:1204-1263`; `lib/ticketing/payment/service.ts:775` (data block `:777-790`) |
| **G6** | **P2** | `writeTicketingAudit` has a **closed** action union with no reconciliation action | `lib/ticketing/audit-log.ts:36-…`, action list |
| **G7** | **P2** | `verifyPaymentStatus` has **no test coverage anywhere** — it is an unverified, never-exercised provider client | repo-wide search: only `lib/payment/ipaymu.ts` + reports |

**What is already sufficient (no new design needed):** the authorization capability
(`PAYMENT_RECONCILE`, ORGANIZER-scoped, membership-gated, ADMIN grant-required); the settlement
transaction; the idempotency arbiter; and the audit-table infrastructure.

---

## 2. EXISTING CAPABILITY

| Artefact | Location | Consumers today |
|---|---|---|
| `verifyPaymentStatus(sessionId)` | `lib/payment/ipaymu.ts:1293` | **ZERO** |
| `isPaymentConfirmed(response)` | `lib/payment/ipaymu.ts:1353` | **ZERO** |
| `PERMISSIONS.PAYMENT_RECONCILE` = `"payment.reconcile"` | `lib/authz/permissions.ts:141` | **ZERO** (declared, granted, unwired) |
| `settleVerifiedPayment(input)` | `lib/ticketing/payment/settlement.ts:272` | one caller: `lib/ticketing/payment/webhook.ts:635` (inside `settleOutcomeSafe`) |
| `writeTicketingAudit(params)` | `lib/ticketing/audit-log.ts` | many callers; **no** `payment.reconcile` action |
| Tenant-scoped payments read model | `lib/dashboard/payments.ts`, `app/dashboard/payments/page.tsx` | dashboard list page |
| Order worklist ("Perlu tindakan") | `lib/dashboard/orders.ts` (`needsReview`), `app/dashboard/orders/page.tsx` | dashboard |
| `PaymentTransaction` (append-only money ledger) | `prisma/schema.prisma` (`PaymentTransactionType`, incl. `PAYMENT`) | written by settlement only |
| `WebhookEvent` ledger | `prisma/schema.prisma` (`providerEventId @unique`) | written by the webhook only |

The capability is a **pre-designed, deliberately-unbuilt seam** — `webhook.ts:87` states the reason
the poll is not a *settlement trigger*: *"No provider `verifyPaymentStatus` call. A server-side status
poll is not a settlement trigger … adding a second trigger would create a second path to `PAID`."*
**This audit does not disturb that lock** (§5, §9, §17).

---

## 3. `verifyPaymentStatus` — COMPLETE TRACE

```
UI / API caller . . . . . . . . . . . . . . . . . . . . NONE (zero call sites, zero tests)
        ↓
lib/payment/ipaymu.ts:1293  export async function verifyPaymentStatus(sessionId: string)
        ↓  getIpaymuConfig()  → fail-closed: throws PaymentConfigError when unset/invalid   (:1297)
        ↓  guards: !apiKey || !va → throw; !sessionId → throw                              (:1299-1305)
        ↓  body = JSON.stringify({ sessionId })                                             (:1307-1309)
        ↓  signature = generateSignature(body, va, apiKey)                                  (:1310)
        ↓  timestamp = generateTimestamp()          // YYYYMMDDHHmmss                        (:1311)
        ↓  AbortController timeout 15 000 ms                                                (:1313-1317)
        ↓
POST ${baseUrl}/api/v2/payment/status                                                   (:1321)
        headers: Content-Type: application/json, va, signature, timestamp, Accept        (:1324-1329)
        body: {"sessionId":"…"}                                                          (:1331)
        ↓
response.json()  → cast to PaymentStatusResponse, NO response.ok check, NO shape validation (:1338)
        ↓
AbortError → throw new Error("iPaymu status verification timeout."); everything else rethrown   (:1340-1347)
        ↓
caller must then use isPaymentConfirmed(response)                                        (:1355)
        Status === 200 AND (Data.Status?.toLowerCase() === "paid" | "settlement")
```

**Signature construction is correct and matches the provider's documented request scheme**
(`lib/payment/ipaymu.ts:61-77`):

```ts
bodyHash     = sha256(body).toLowerCase()
stringToSign = `POST:${va}:${bodyHash}:${apiKey}`
signature    = HMAC-SHA256(stringToSign, apiKey)
timestamp    = YYYYMMDDHHmmss      // generateTimestamp, :79-88
```

which is exactly the official sample's `$stringToSign = strtoupper($method).':'.$va.':'.$requestBody.':'.$apiKey;`
(§4.4). **The auth half is right; the request and the classification are wrong.**

---

## 4. THE iPAYMU CONTRACT (as documented, and what we implement)

**Sources.** `https://docs.ipaymu.com/en/docs` (fetched, HTTP 200) establishes the base URLs —
`https://my.ipaymu.com` (production) / `https://sandbox.ipaymu.com` (sandbox) — and header-based
signature auth (`va`, `signature`, `timestamp`). The endpoint set itself is published in the official
**iPaymu Public API v2** collection (`documenter.getpostman.com/view/40296808/2sB3WtseBT`, read in
full), corroborated independently by the official PHP sample
(`raw.githubusercontent.com/ipaymu/ipaymu-payment-v2-sample-php/main/ipaymu.php`) and two mirrored
sources. The same collection documents the **callback** contract, and it matches this repository's
Phase 27B-verified implementation byte for byte (remove `signature`, ksort, JSON, HMAC-SHA256 with
the **Merchant VA**) — which is why the collection is treated here as the authoritative contract.

### 4.1 Documented endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v2/payment` | Redirect payment session → `Data.SessionID` + `Data.Url` |
| POST | `/api/v2/payment/direct` | Direct instrument (VA / cstore / QRIS) — **already implemented and sandbox-verified by this project** (Phase 22), listed here for completeness |
| POST | `/api/v2/balance` | Balance |
| POST | `/api/v2/history` | **Transaction history**, filterable by `id`, `status`, `startdate`, `enddate`, `page`, `type`; **`account` required** |
| POST | **`/api/v2/transaction`** | **Check Transaction** — "check the status and details of a transaction in real-time using the transaction ID" |
| POST | `/callback` | Provider → us notification (form-urlencoded) |

### 4.2 The documented Check Transaction contract

```
POST https://sandbox.ipaymu.com/api/v2/transaction
headers: Content-Type: application/json, signature, va, timestamp
form:    transactionId="4719"                 ← the iPAYMU TRANSACTION ID
         (account — the iPaymu Virtual Account number — required)

200 → { "Status": 200, "Data": { "Status": 1, "TransactionId": "4719" }, "Message": "success" }
      "Successful transactions are indicated by Data->Status being 1, 6, or 7."
401 → { "Status": 401, "Message": "unauthorized" }
```

### 4.3 Side-by-side

| | Documented (iPaymu v2) | Implemented (`verifyPaymentStatus`) | Verdict |
|---|---|---|---|
| Endpoint | `POST /api/v2/transaction` | `POST /api/v2/payment/status` | ❌ **G1** |
| Identifier | `transactionId` (numeric provider trx id, e.g. `4719`) | `sessionId` (provider **SessionID**) | ❌ **G3** |
| `account` | **required** | absent | ❌ **G3** |
| Transport | `--form` fields | JSON body | ⚠️ untested difference |
| Auth headers | `va`, `signature`, `timestamp` | same | ✅ |
| Request signature | `HMAC-SHA256("POST:va:sha256(body):apiKey", apiKey)` | identical (`ipaymu.ts:61-77`) | ✅ |
| Success signal | `Data.Status` **∈ {1, 6, 7}** (numeric) | `Data.Status` string ∈ `"paid" \| "settlement"` | ❌ **G2** |
| Response fields | `Status`, `Message`, `Data{Status, TransactionId,…}` | declares `Data{Status, Amount, ReferenceId, SessionId}` | ❌ types/shape wrong |
| Amount | **not documented in this response** | declares an optional `Amount` | ❌ **G4** |
| HTTP status handling | — | `response.json()` with **no `response.ok` check** | ⚠️ tolerated only because G2 fails closed |
| Replay/freshness | — | none | ⚠️ server-to-server, signed |

**Conclusion:** `verifyPaymentStatus` was written against an assumed contract, not the published one.
Its auth is right, everything else is wrong, and `isPaymentConfirmed` is **dead code that cannot
return true against the real API** — `Data.Status?.toLowerCase()` on a number is `undefined`.

---

## 5. `settleVerifiedPayment` REUSE ASSESSMENT — **REUSABLE UNCHANGED**

| Property | Implementation | Reusable by reconciliation? |
|---|---|---|
| Transaction boundary | ONE `prisma.$transaction(..., { timeout: 20_000 })` wrapped in `withContentionRetry` (`:276-278`) | ✅ |
| Order CAS | `UPDATE … WHERE id AND status='PENDING_PAYMENT' AND paymentStatus != 'PAID'` → `PAID/PAID/paidAt = COALESCE(paidAt, now)`; `count` is the decision (`:301-315`) | ✅ the arbiter |
| `count === 0` meanings | `paymentStatus === 'PAID'` → `ALREADY_PAID` · `CANCELLED`/`EXPIRED` → `LATE_SETTLEMENT` (records `paymentStatus=PAID` + `fulfilmentBlockedAt`, **no inventory movement**) · else `NOT_APPLICABLE` (`:316-386`) | ✅ |
| Payment transition | `UPDATE payment SET status='PAID' WHERE id AND status IN ('UNPAID','PENDING')`; `count === 0` → no-op (CAS at `:234`) | ✅ |
| `PaymentTransaction` | append-only INSERT of exactly one `PAYMENT` row, only on a won Payment CAS (insert via `recordProviderTransaction`, called at `:248`) | ✅ |
| Reservation / inventory | `confirmOrderReservations(tx, orderId)` — CAS `HELD → CONVERTED` + `reserved -= q / sold += q`; **throws on underflow → whole transaction rolls back** (`:414`) | ✅ |
| Anomalies | converted ≠ ordered → `fulfilmentBlockedAt` set (`:429-447`) | ✅ |
| Idempotency | the two CAS predicates; nothing is pre-checked-and-acted | ✅ |
| Duplicate execution | second caller gets `ALREADY_PAID`; money written once | ✅ |
| Already-`PAID` | `ALREADY_PAID`, no mutation | ✅ |
| Amount used | `input.amountReported ?? order.total` — **the caller must have verified equality first** (`:367`, `:400`) | ⚠️ **caller obligation** — see §8 |
| Audit | `writeTicketingAudit({ action: "payment.success", actorType: "PROVIDER" })` **after commit** — one row for `SETTLED` (`:482`) and a second `payment.success` row for `LATE_SETTLEMENT` (`:514`) | ⚠️ actor must become the **operator**, see §10 |

**Verdict:** it is a pure state-machine primitive that takes verified facts and nothing else. A
reconciliation caller must supply the same inputs the webhook supplies, and must not need a single
line changed inside it. **No modification proposed.**

---

## 6. `PAYMENT_RECONCILE` AUTHORIZATION

| Question | Answer | Evidence |
|---|---|---|
| Permission key | `payment.reconcile` | `lib/authz/permissions.ts:141` |
| **Scope** | **`ORGANIZER`** (in `ORGANIZER_SCOPE_FINANCIAL`, declared `:288`; key at `:289`) — *tenant* financial authority, not OWN, not PLATFORM | `:288-301` |
| Held by role (**platform**) | `MANAGER` | `:390` |
| Held by role (**membership**) | `OWNER` (`:442`), `MANAGER` (`:477`), `FINANCE` (`:504`) | |
| **Platform `ADMIN`** | **grant-required** — present in `ADMIN_GRANT_REQUIRED`, so an active `PermissionGrant` for that organizer is mandatory | `:620-628` |
| `CUSTOMER` | **no** — platform roles resolve per map; CUSTOMER's map holds only OWN-scope keys | `:597` |
| `PIC` | **no** — `PIC: toSet([])`; a PIC's reads are OWN-scoped only | `:415-416` |
| Membership requirement | **every** organizer-scoped decision requires an ACTIVE `OrganizerMember` row. `ORGANIZER_SPANNING_PLATFORM_ROLES` is **empty**, so *no* platform role — not ADMIN, not MANAGER — reaches a tenant without one | `:633-641`, `decideOrganizerPermission:777-847` |
| Denial shape | no membership → `ORGANIZER_ACCESS_DENIED` → **HTTP 404** (never reveals the tenant exists) | `lib/authz/errors.ts:53-59` |
| Existing consumers / routes / UI / tests | **none** (only the permission-map and role-matrix tests assert the *grant*) | `__tests__/authz/permission-map.test.ts:151`, `__tests__/authz/role-matrix.integration.test.ts:271` |

### 6.1 Who should be allowed (derived, not invented)

**Allowed:** an actor with an **ACTIVE membership** in the payment's organizer whose membership role is
`OWNER`, `MANAGER` or `FINANCE`; or a platform `MANAGER` **with** such a membership; or a platform
`ADMIN` **with both** an active `PermissionGrant` for that organizer **and** the membership.

**Forbidden:** the buyer (CUSTOMER), any PIC, and every platform role acting without a membership.
Nothing new is needed — `requireOrganizerAccess(order.organizerId, PERMISSIONS.PAYMENT_RECONCILE)` is
the entire control, and it is already the pattern used by every organizer route.

### 6.2 SoD (§7 of the task)

* **Buyer:** excluded by construction (the capability is tenant-scoped; a buyer holds only `*.own`
  keys). Reconciliation is **not** self-service and must never be offered on the buyer's order page.
* **PIC:** excluded by construction (`PIC: toSet([])`); a PIC must not be able to settle money.
* **Finance/platform staff:** allowed, as above.
* **Organizer-scoped, not platform-global:** correct and non-negotiable — the permission's scope is
  `ORGANIZER`, and the cross-tenant error is a 404.
* **No second SoD control is required here.** The refund rail needed SoD because the same human both
  requested and disbursed; reconciliation is not a discretionary money movement — it makes the
  **provider's** already-true state visible. There is no "own request" to approve, and the actor
  cannot choose the amount, the reference or the outcome. *(If the owner later wants a second pair of
  eyes, that is a new decision, not a gap this audit found.)*

---

## 7. SAFE STATE MATRIX

For each state: is reconciliation **allowed**, and what does the existing transaction do?

| # | Order | Payment | Provider poll | Safe? | Behaviour if reconciled |
|---|---|---|---|---|---|
| 1 | `PENDING_PAYMENT` | `PENDING` | SUCCESS (1/6/7) | ✅ **the target case** | `SETTLED` — order/payment `PAID`, one `PaymentTransaction`, reservations converted |
| 2 | `PENDING_PAYMENT` | `PENDING` | PENDING (0) | ✅ but **no-op** | poll says pending → record the attempt, change nothing, do **not** call settle |
| 3 | `PENDING_PAYMENT` | `PENDING` | FAILED / EXPIRED (−2, 2, 4, 5) | ⚠️ **allowed only as the failure branch** | `failVerifiedPayment` releases reservations and cancels the order — *if* the owner wants operator-triggered failure at all; otherwise **block** and report |
| 4 | `PENDING_PAYMENT` (past `expiresAt`, never swept) | `PENDING` | SUCCESS | ✅ **still safe and valuable** — the reaper is not installed (Phase 26 **BLOCK-3**), the CAS accepts `PENDING_PAYMENT` regardless of `expiresAt`, and the hold is still `HELD` | `SETTLED` |
| 5 | `PENDING_PAYMENT` | `PENDING` | **unknown / unparseable / HTTP error** | ❌ **BLOCK** | fail closed; no settlement, record the refusal |
| 6 | `CANCELLED` | any | SUCCESS | ⚠️ allowed by the transaction (`LATE_SETTLEMENT`), **but not by a reconciliation button** | records `paymentStatus=PAID` + `fulfilmentBlockedAt`, **no tickets, no inventory** — a product decision (Phase 20A `D-P19-04`, still **UNDECIDED**), not an operator convenience |
| 7 | `EXPIRED` | any | SUCCESS | ⚠️ same as #6 | same |
| 8 | any | **already `PAID`** | SUCCESS | ✅ idempotent | `ALREADY_PAID`, zero writes |
| 9 | any | `FAILED` | SUCCESS | ⚠️ order is normally `CANCELLED` ⇒ #6 path | as #6 |
| 10 | duplicate concurrent requests | — | SUCCESS ×2 | ✅ | one `SETTLED`, one `ALREADY_PAID` (§9) |
| 11 | **`Payment` row absent** | — | — | ❌ **BLOCK** | nothing to address; `paymentId` may be `null` in the settlement input but a reconciliation must require the row |

**The only states a bounded operator flow should act on: #1 and #4 (settle), and #2 (record "still
pending, no change").** Everything marked ⚠️ is a *product* decision about money on a terminal order
and must not be shipped as a side effect of a reconciliation button.

---

## 8. AMOUNT VERIFICATION

**Requirement:** the provider's amount is the only authoritative evidence; the operator may never
enter, choose or override an amount; any mismatch must **BLOCK**.

| Source | Available? | Notes |
|---|---|---|
| `EventOrder.total` | ✅ authoritative internal | `Prisma.Decimal(14,2)`, whole rupiah, compared with `Decimal.equals` (never `Number`) |
| `Payment.amount` | ✅ | written from `order.total` at creation, so it corroborates rather than independently verifies |
| Callback `sub_total` | ✅ **when a callback is delivered** | already preferred over `amount`/`total` (`webhook.ts:341-364`) — but this is exactly what was missing in the Phase 27B case |
| **Check Transaction response** | ❌ **not documented** | the published sample carries `Data{Status, TransactionId}` only |
| `/api/v2/history` (`id` filter) | ⚠️ documented, **response fields undocumented** | the only documented amount-bearing query; **unverified**, and it needs `account` + a date window |

**Consequence:** a reconciliation built only on the documented Check Transaction **cannot meet the
amount-equality contract**, because the provider supplies no amount to compare. Two honest options:

* **Option A (recommended):** require amount evidence from a **verified callback payload** when one
  exists, and otherwise use `/api/v2/history` — both server-side; the operator never sees or supplies
  an amount.
* **Option B:** accept a status-only verification and *document* that the amount is corroborated
  against `EventOrder.total`/`Payment.amount` rather than independently proven — weaker than the
  webhook path and must be an explicit owner decision, not a silent default.

Either way: `input.amountReported` must be the **provider-derived** value, and the equality check must
happen **before** `settleVerifiedPayment` is called, mirroring `amountVerdict` (including its
`MATCH`/`ABSENT`/`MISMATCH` vocabulary — and note that `ABSENT` tolerance was justified *because the
signature was verified first*; that justification does **not** transfer to a poll, §8/§16).

---

## 9. IDEMPOTENCY / CONCURRENCY

**Question:** can two operators reconcile the same payment concurrently into two settlements?

**No — the existing transaction is sufficient, and no new guard is required**, because every
mutation is a conditional UPDATE whose affected-row count is the decision:

```
Operator A                         Operator B
  read order PENDING_PAYMENT         read order PENDING_PAYMENT      ← both pass any pre-check
  settleVerifiedPayment()            settleVerifiedPayment()
    tx: UPDATE order WHERE status='PENDING_PAYMENT' AND paymentStatus != 'PAID'
        → count = 1 ⇒ WINS          → count = 0 ⇒ reads paymentStatus='PAID' ⇒ ALREADY_PAID
        PaymentTransaction INSERTed  no PaymentTransaction
        reservations converted       no inventory movement
        COMMIT                       COMMIT (nothing to commit)
```

* Order CAS is a single atomic statement — the DB is the arbiter, exactly as `settleVerifiedPayment`'s
  own header states for the webhook path.
* `PaymentTransaction` is written only behind a **second** CAS (`Payment.status IN (UNPAID,PENDING)`),
  so even the `LATE_SETTLEMENT` branch (which ignores the order-update count) cannot double-write the
  money ledger.
* The **only** thing the webhook has that a poll does not is the `WebhookEvent.providerEventId`
  unique key. That key exists to arbitrate *deliveries*; a poll has no delivery, so its absence
  changes nothing about settlement safety.
* Duplicate *polling* is harmless (read-only).

**Missing guard: none identified.** The requirement is that reconciliation **must call
`settleVerifiedPayment` and must not write `PAID` itself** — any direct `UPDATE … SET status='PAID'`
would forfeit this entire argument.

---

## 10. AUDIT TRAIL

| Requirement | Existing mechanism | Status |
|---|---|---|
| actor | `AdminAuditLog.actorUserId` + `actorRole` (snapshotted) via `AuthzScope` | ✅ |
| payment / order | `entityType: "Payment"`, `entityRef: <payment cuid>`; `organizerId` | ✅ (`"Payment"` is in the entity union) |
| provider status / reference / amount / reason | `afterState` / `beforeState` / `reason` (JSON, sanitised by a forbidden-key filter) | ✅ |
| timestamp | `createdAt` | ✅ |
| IP / UA | `ipAddress` / `userAgent` when `request` is passed | ✅ |
| **action** | `TicketingAuditAction` is a **closed union** with no reconciliation member — and the settlement writes `payment.success` with `actorType: "PROVIDER"`, which would be **wrong** for an operator-driven reconciliation | ❌ **G6** |

**Ordering caveat:** the settlement's audit row is written **after the commit** and is
fire-and-forget (`audit-log.ts` catches and logs). For a *financial, operator-initiated* action the
existing file already notes this limitation ("Financial actions in later phases are specified to
require a durable audit row and will need a stronger guarantee"). The reconciliation action should be
recorded with the operator as the actor (e.g. a new `payment.reconcile` action, `actorType: "USER"`,
`reason` = the provider verdict, `afterState` = provider status/trx id/amount/outcome), and the
durability question should be decided rather than inherited.

---

## 11. MINIMAL API / UI SURFACE

**Route (recommended shape — not implemented):**

```
GET  /api/organizer/payments?reconcile=1      list candidates (tenant-scoped read)
POST /api/organizer/payments/[paymentReference]/reconcile
```

**Why this shape, from the existing architecture:**

* `/api/organizer/` is already in `PROTECTED_API_PREFIXES` (`proxy.ts`), and
  `__tests__/authz/route-classification.test.ts` **fails the build** if a new route is left
  unclassified — so the placement cannot silently ship unprotected.
* Every organizer mutating route already follows the same recipe: `requireSameOrigin(request)` →
  resolve the tenant **from the record, never from the request** → `requireOrganizerAccess(
  organizerId, PERMISSION )` → service → envelope. The tenant comes from
  `Payment.organizerId` (which equals `EventOrder.organizerId`), so a caller cannot name an organizer.
* The alternative `/api/admin/...` placement is **wrong**: the permission is ORGANIZER-scoped, and the
  admin namespace is platform-scoped.
* A **buyer-facing** route is wrong by construction (§6.2).

**UI:** put the candidate list on the **existing** `app/dashboard/payments/page.tsx`, reusing
`lib/dashboard/payments.ts` (already tenant-scoped via `resolveOrganizerFilter`), and mirror the
"Perlu tindakan" idiom already used by `lib/dashboard/orders.ts` / `app/dashboard/orders/page.tsx` —
rather than building a new dashboard section. The action itself should be one button per row with an
explicit confirmation, and **no amount field anywhere**.

---

## 12. EXACT FILES / FUNCTIONS INVOLVED

| File | Symbol | Role in the plan |
|---|---|---|
| `lib/payment/ipaymu.ts` | `verifyPaymentStatus` (`:1293`), `isPaymentConfirmed` (`:1353`), `PaymentStatusResponse` (`:1282`) | **must be rewritten against `/api/v2/transaction`** (endpoint, body, response type, numeric success set) — or replaced by a new, correctly-typed function and the old one deleted |
| `lib/payment/ipaymu.ts` | `generateSignature` (`:61-77`), `generateTimestamp` (`:79-88`) | ✅ reused unchanged |
| `lib/ticketing/payment/webhook.ts` | `amountVerdict` (`:341`), `resolveTicketingTarget` (`:268`), `handleGatewayWebhook` (`:366`) | the contract to mirror: amount vocabulary, `EVT-` namespace guard, ordering |
| `lib/ticketing/payment/settlement.ts` | `settleVerifiedPayment` (`:272`), `settlementFailureOutcome` (`:559`), `failVerifiedPayment` (`:612`) | ✅ reused unchanged |
| `lib/ticketing/payment/service.ts` | `recordInstruction` (`:775`, payload `:777-790`), `recordSession` (`:728`) | **stores no provider transaction id** (G5) |
| `prisma/schema.prisma` | `Payment` (`:1204-1263`) | has `externalSessionId`; **no** provider transaction id column (G5) |
| `lib/ticketing/audit-log.ts` | `TicketingAuditAction`, `writeTicketingAudit` | needs a reconciliation action (G6) |
| `lib/authz/permissions.ts` | `PAYMENT_RECONCILE` (`:141`), `ORGANIZER_SCOPE_FINANCIAL` (`:289`), `decideOrganizerPermission` (`:777`) | ✅ unchanged — the control already exists |
| `lib/authz/guards.ts` | `requireOrganizerAccess` (`:135`) | ✅ the guard to call |
| `lib/dashboard/payments.ts` | `PAYMENT_SELECT`, `listPayments` | candidate list / UI |
| `lib/dashboard/orders.ts` | `needsReview` | the worklist idiom to mirror |
| `app/api/organizer/**` | every route | the route recipe (CSRF → tenant from record → guard → envelope) |

---

## 13. THE REAL SANDBOX PAYMENT (`EVT-1789894187056-ef2c2a78`) — **READ ONLY**

Current state (re-verified read-only; unchanged since Phase 27B):

```
order.status  = PENDING_PAYMENT     order.paymentStatus = PENDING     paidAt = null
Payment.status = PENDING            amount = 15000                  providerEnvironment = SANDBOX
Payment.externalSessionId = present (a SessionID — a UUID string, NOT a transaction id)
PaymentTransaction = 0              WebhookEvent = 0                Ticket = 0
reservation = 1 × HELD (quota still held)                           provider says: berhasil / settled / 15000
```

**What reconciliation would have to verify before allowing settlement, and what is missing today:**

| # | Requirement | Available? |
|---|---|---|
| 1 | The `Payment` row exists and belongs to an organizer the actor is a member of | ✅ |
| 2 | Provider evidence of success, fetched **server-side** from iPaymu | ❌ **no usable client** (G1–G3) |
| 3 | The query must be **addressable**: the documented endpoint needs `transactionId` (+ `account`) | ❌ **G5** — the platform stores only `externalSessionId`; the provider transaction id `233592` exists **only in the callback payload the developer received**, not in the database |
| 4 | Amount equality against `EventOrder.total` (15000) | ⚠️ **G4** — the status response carries no amount; `15000` would come from the callback's `sub_total` or `/api/v2/history` |
| 5 | Namespace guard (`EVT-`) and environment consistency (payment is `SANDBOX`, config is `sandbox`) | ✅ available |
| 6 | Idempotent, transactional settlement | ✅ `settleVerifiedPayment`, CAS-arbitrated (§9) |
| 7 | Actor + audit row | ⚠️ **G6** (action union) |
| 8 | The operator never supplies an amount | ✅ by design |

**Read-only conclusion:** with today's code, this payment **cannot** be reconciled through the
platform. With G1–G3 fixed and a provider query addressed by the transaction id, it would settle
cleanly (`PENDING_PAYMENT` + `HELD` ⇒ `SETTLED`; the order is not expired in the CAS sense and the
reservation conversion needs only `reserved >= quantity`). **A one-off settlement of this row by hand
is exactly what §17 forbids.**

---

## 14. IMPLEMENTATION PLAN (proposed — **NOT executed**)

Ordered so that each step is independently verifiable. Steps 1–3 are prerequisites this audit found.

**Step 0 — owner decision (blocks everything).** Ratify the reconciliation contract: which states may
be reconciled (§7: #1, #4 settle; #2 record), and whether a **status-only** poll with amount
corroborated against internal records is acceptable, or whether amount evidence must come from a
callback / `/api/v2/history` (§8 Option A vs B). *Do not let code decide this.*

**Step 1 — provider query, rebuilt against the published contract.**
Replace `verifyPaymentStatus`/`isPaymentConfirmed` with a typed, correctly-addressed client:
`POST ${baseUrl}/api/v2/transaction`, body `{ transactionId, account }`, headers
`va`/`signature`/`timestamp` (reuse `generateSignature`), **`response.ok` checked**, response parsed
as `{ Status: number, Message: string, Data?: { Status?: number|string, TransactionId?: string } }`,
success = numeric `Data.Status ∈ {1, 6, 7}` with a defensive string branch. Fail closed on any
unparseable body — and **never** treat `Status !== 200` as anything but a refusal.

**Step 2 — make the payment addressable (schema, additive).**
Persist the provider transaction id: an additive nullable `Payment.providerTransactionId` (and set it
in `recordInstruction`/`recordSession` from the create responses, which already carry it). Forward-only
no-op for existing rows. Requires a **non-destructive migration** + owner approval; without it, the
documented query cannot be addressed for the very case reconciliation exists for.

**Step 3 — the service (no new settlement logic).**
`reconcilePayment(paymentReference, actor)`:
`requireAuth` → load `Payment`+`order` (by `paymentReference`, which is unique) → capture
`order.organizerId` → `requireOrganizerAccess(organizerId, PAYMENT_RECONCILE)` → refuse unless the
payment/order state is in the §7 allow-list → **server-side** provider query (Step 1) → require
`Data.TransactionId === payment.providerTransactionId` and the environment to match
`payment.providerEnvironment` → obtain amount evidence and compare with `EventOrder.total`
(`Prisma.Decimal.equals`) → **only then** `settleVerifiedPayment(...)` with the provider-derived
facts → map the outcome to an envelope code → write the audit row with the **operator** as actor.

**Step 4 — route + UI** (§11), behind `requireSameOrigin`, tenant resolved from the record, plus the
candidate list on the existing payments page.

**Step 5 — tests** (§15) and a sandbox verification of Step 1 with a real transaction id.

**Explicitly out of scope for the implementation phase:** anything that changes the webhook's
authority, the settlement transaction, the amount rules, or the authorization model.

---

## 15. TESTS REQUIRED

| # | Test | Kind |
|---|---|---|
| 1 | Provider client sends `POST /api/v2/transaction` with `transactionId` + `account` and the documented signature; a fake response of `Data.Status = 1/6/7` confirms; `0`, `-2`, `2`, `4`, `5` do **not** | unit (stubbed fetch) |
| 2 | `response.ok === false` / non-JSON / absent `Data` ⇒ **refusal**, never a confirmation | unit |
| 3 | Reconciliation of a `PENDING_PAYMENT` + `PENDING` payment with verified success ⇒ `SETTLED`; order/payment `PAID`; exactly one `PaymentTransaction`; reservation `CONVERTED`; counters moved once | integration (real DB, `_test`) |
| 4 | Amount mismatch ⇒ **blocked, zero writes**, no `PaymentTransaction`, order untouched | integration |
| 5 | Provider says paid, `Data.TransactionId` ≠ stored id **or** environment mismatch ⇒ blocked | integration |
| 6 | Provider says not-success (`0`/`−2`) ⇒ no settlement; state unchanged | integration |
| 7 | **Concurrency:** 2 (and N) parallel reconciliations ⇒ exactly one `SETTLED`, rest `ALREADY_PAID`, one `PaymentTransaction`, counters moved once | integration |
| 8 | Already-`PAID` payment ⇒ `ALREADY_PAID`, zero writes | integration |
| 9 | `CANCELLED`/`EXPIRED` order ⇒ blocked by the *route* (or routed to the product decision), and if reached, no inventory movement | integration |
| 10 | Authorization: CUSTOMER ⇒ 403/404; PIC ⇒ denied; organizer-A member reconciling organizer-B's payment ⇒ **404**; ADMIN **without** a grant ⇒ denied; ADMIN **with** grant + membership ⇒ allowed | integration (`lib/authz`) |
| 11 | CSRF: cross-origin / no-`Origin` POST ⇒ 403 | integration |
| 12 | Audit: exactly one row, `actorUserId` = operator, `action` = the new action, `afterState` carries provider status/trx id/amount/outcome; **no PII, no secret** | integration |
| 13 | **Regression guard (static):** nothing outside `lib/ticketing/payment/settlement.ts` writes `PAID`, and the reconciliation route calls `settleVerifiedPayment` — the same guard style as `payment-wiring.test.ts:307` | static |
| 14 | Buyer surfaces expose no reconciliation action | static/UI |
| 15 | `verifyPaymentStatus`'s old contract can never regress silently: assert the endpoint string, the request field names and the numeric success set | static |

---

## 16. RISKS / REMAINING BLOCKERS

1. **Unverified provider contract (the largest one).** Everything in §4 for Check Transaction comes
   from the provider's published collection, not from a sandbox response observed by this project.
   **Closing it needs one sandbox call — forbidden in this phase.** Until then, Step 1 is a rewrite
   against documentation, and the amount path (`/api/v2/history`) has **undocumented response fields**.
2. **No stored provider transaction id (G5).** Even a perfect client cannot address the query for an
   unsettled payment. Additive migration + owner approval required.
3. **Amount evidence is materially weaker than the webhook's (G4).** The webhook verifies the amount
   inside a *signed* delivery; a poll returns no amount at all. A status-only reconciliation is a
   *different* evidentiary standard and must be an explicit decision (§8), not an assumption.
4. **The "second path to PAID" optics are real.** The design lock says a poll is not a *trigger*.
   Reconciliation is defensible only if it is (a) human-initiated, (b) fetches provider evidence
   server-side, (c) goes through the same transaction, and (d) is authorized and audited. Any drift
   from that turns a recovery tool into a settlement backdoor. **The locked wording should be
   amended explicitly when this ships, rather than quietly reinterpreted.**
5. **`D-P19-04` (money on a terminal order) is still UNDECIDED.** §7 rows 6/7/9 must not be answered
   by an operator button; they need the owner's product decision.
6. **Audit durability.** The settlement's audit write is post-commit and fire-and-forget; for a
   financial operator action the stronger guarantee flagged in `audit-log.ts` should be decided.
7. **The specific sandbox payment remains unsettled** and is *not* fixable by configuration alone
   (Phase 27B §14). Its money is at the provider; the platform shows it unpaid. Reconciliation is the
   designed remedy — which is why this blocker matters operationally, not just architecturally.
8. **No behavioural change to the webhook is proposed or needed** — the delivery path is verified
   correct (Phase 27B).

---

## 17. EXPLICITLY REJECTED DESIGNS (security review — task §14)

Each of these is **rejected**, with the reason:

| Rejected design | Why it must never ship |
|---|---|
| Browser/return-URL success ⇒ PAID | Phase 27B: the redirect is player-controlled; the webhook is the only verified trigger |
| Client-supplied status or amount | A client claim is not evidence; amounts come from `EventOrder.total` |
| Operator types a provider transaction id and the system trusts it | The id is only an *address*; the provider's response must confirm status **and** match the stored id/env/amount |
| Trusting unsigned/hand-copied provider data | Every provider answer is fetched signed, server-side, from the allow-listed base URL |
| Skipping amount validation | `settleVerifiedPayment` expects a pre-verified amount; §8 forbids the skip |
| `UPDATE order SET status='PAID'` / `UPDATE payment SET status='PAID'` directly | Forfeits the CAS that makes settlement exactly-once, and the `PaymentTransaction`/inventory invariants |
| Anything bypassing `settleVerifiedPayment` | It is the single reviewed money-movement transaction; a second implementation is a second source of truth |
| A generic "admin override / mark as paid" | Admin control of money is explicitly forbidden by this module family (`lib/dashboard/payments.ts` header states it) |
| Reusing `verifyPaymentStatus` **as-is** | It posts to an undocumented path with a predicate that can never be true (§4.3, G1–G3) |
| Making reconciliation a scheduled job now | Adds a third job against `P14-D10` ("two jobs only") and would fire without a state-machine decision |

---

## 18. SAFETY STATEMENT

| Item | Status |
|---|---|
| Source files modified | **NONE** |
| Database rows written / updated / deleted | **NONE** — all inspection was `SELECT`/`count` |
| Migration created / applied · `db push` · reset | **NONE** |
| **iPaymu API call (sandbox or production)** | **NONE** — no request was made to any iPaymu endpoint; only the provider's **public documentation** was read |
| Production credentials touched | **NONE**; no secret value copied into this report |
| Commit / push / deploy / reset / clean | **NONE** |

**Report written to:** `PHASE_27C_PAYMENT_RECONCILIATION_AUDIT.md`

---

## 19. FINAL VERDICT

> ### **RECONCILIATION BLOCKED — INTERNAL DESIGN GAP**
>
> `settleVerifiedPayment` is ready to reuse unchanged, the authorization capability already exists and
> is correctly scoped, and idempotency is already guaranteed by the database. The blockers are ours:
> the provider query targets an undocumented endpoint with the wrong identifier and a success
> predicate that can never match (`G1`–`G3`), the platform cannot address the documented query because
> it stores no provider transaction id before settlement (`G5`), the documented status response
> carries no amount so the poll alone cannot satisfy the amount contract (`G4`), and the audit action
> union has no reconciliation member (`G6`). The provider's capability itself is documented and
> reachable — closing the remaining provider-side uncertainty requires **one sandbox verification
> call**, which this phase was not permitted to make.
