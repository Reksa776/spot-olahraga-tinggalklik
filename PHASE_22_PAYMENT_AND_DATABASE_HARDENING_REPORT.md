# PHASE 22 — PAYMENT & DATABASE HARDENING REPORT

**Project:** TinggalKlik.Co
**Scope:** full payment-flow audit, iPaymu sandbox diagnosis, obsolete database structure cleanup,
test/database isolation, and verification.
**Deployment:** **NONE. Nothing was deployed. No production credential was used.**

---

## 1. Executive Summary

The report that "payment is not usable even in sandbox" was accurate, and the cause was **not**
credentials, the resolver, the signature scheme, or the endpoint. Sandbox credentials were correctly
configured and the gateway answered **200** on a live call. The break was in the application's own
request contract:

> The buyer's method picker was driven by the payment **method catalog**
> (`QRIS | VIRTUAL_ACCOUNT | RETAIL_OUTLET | CREDIT_CARD`), while the route's request schema still
> hand-listed the three **retired** names (`QRIS | BANK_TRANSFER | E_WALLET`) from before the catalog
> existed. Zod rejects an unknown enum member, so **three of the four methods a buyer could choose
> were answered `400 VALIDATION_ERROR` before the service — and therefore the gateway — was ever
> reached.** Only QRIS could be paid.

Four further defects were found and fixed in the same path, including a credit-card flow that iPaymu
answers with **`401 unauthorized signature`** because the code sent an empty `paymentChannel`
(verified against sandbox, both before and after).

All four methods now complete end-to-end against the real iPaymu sandbox through the real gateway code.

On the database side, 36 tables had no Prisma model. **Eight** of them were provably unused — empty,
unreferenced by any foreign key, referenced nowhere in code — and were removed by a targeted
migration. The other 28 hold historical business or financial rows and were **deliberately retained**.

Finally, the test suites were *sharing the development database*. They now run against a dedicated
`<DATABASE_URL database>_test`, which fixed the leak that produced the ghost events of Phase 21B and
also removed 53 phantom test failures and 175 seconds from the run.

| | Before | After |
|---|---|---|
| Browser-payable methods | **1 of 4** | **4 of 4** |
| Methods verified against live sandbox | 1 | 4 |
| Tables in the database | 72 | 64 |
| Tables with no Prisma model | 36 | 28 |
| Database size | 7.18 MB | 6.77 MB |
| Failing Jest suites | 14 | **3** (all pre-existing, unrelated) |
| Failing Jest tests | 164 | **34** (all pre-existing, unrelated) |
| Jest wall time | 214.6 s | **40–57 s** (machine-dependent; 40.0 s and 56.6 s observed) |

---

## 2. Exact Payment Failure Root Cause

### 2.1 The primary defect — method-enum drift between the picker and the schema

`lib/ticketing/payment/validation.ts` declared the accepted methods by hand:

```ts
export const PURCHASABLE_PAYMENT_METHODS = ["QRIS", "BANK_TRANSFER", "E_WALLET"] as const;
```

`components/orders/PayNowButton.tsx` renders its picker from
`lib/ticketing/payment/method-catalog.ts`:

```ts
export const PAYMENT_METHOD_OPTIONS = [ QRIS, VIRTUAL_ACCOUNT, RETAIL_OUTLET, CREDIT_CARD ];
```

`app/api/ticketing/orders/[orderNumber]/pay/route.ts` validates the body with
`paymentCreateRequestSchema`, whose `method` field is `z.enum(PURCHASABLE_PAYMENT_METHODS)`.

**Therefore:** submitting `VIRTUAL_ACCOUNT`, `RETAIL_OUTLET` or `CREDIT_CARD` produced
`400 VALIDATION_ERROR` at the route, before `createOrderPayment` ran. Confirmed by direct probe of the
route's validation path:

```
QRIS            -> accepted
VIRTUAL_ACCOUNT -> 400  (not in the enum)
RETAIL_OUTLET   -> 400  (not in the enum)
CREDIT_CARD     -> 400  (not in the enum)
```

The catalog's own docstring had already recorded that the schema was stale ("Kept in the request enum
for compatibility"), so the two lists were *known* to disagree and nobody had reconciled them.

### 2.2 Why the test suite never caught it

The integration suite that covers this path (`__tests__/ticketing-payment/payment-creation.integration.test.ts`)
calls **`createOrderPayment` directly**, not the route:

```ts
async function pay(buyerId, orderNumber, request = {}) {
    const actor = await customerScope(buyerId);
    return createOrderPayment({ orderNumber, actor, request, httpRequest: nextRequest() });
}
```

so the Zod schema was never exercised by it. The only test that touched the schema
(`payment-wiring.test.ts`) asserted that it declares **no financial field** — never that it accepts the
methods the UI offers. A drift between two lists in two files with no test spanning them is invisible
by construction. Test `payment-method-contract.test.ts` (added) spans them.

### 2.3 The secondary defect — credit card returns `401 unauthorized signature`

`gateway.ts#providerMethodFor` gave `CREDIT_CARD` a channel of `option.defaultChannel ?? ""` — the
catalog declared no default channel for it, so the request went to iPaymu with `"paymentChannel": ""`.

iPaymu signs the body *as received* after its own normalisation, which drops an empty field, so the
hash it verified no longer matched the one signed:

```
REDIRECT cc / channel ""   -> HTTP 401  "unauthorized signature"
REDIRECT cc / channel "cc" -> HTTP 200  Success
```

Both lines are live sandbox results. (This is the same hazard the file already documented for
`formatProductName`: *"Prevents trailing ' - ' which changes the JSON body hash and causes iPaymu 401."*)

### 2.4 The third defect — a credit-card payment booked as `BANK_TRANSFER`

`resolvePaymentSelection` round-tripped the internal method through `mapPaymentMethod`, a retail-era
table that knows only `qris | va | banktransfer | cstore`. `cc` fell through its default branch:

```ts
mapPaymentMethod("cc", "") === "BANK_TRANSFER"   // false entry in a financial record
```

### 2.5 The fourth defect — the provider's session id was silently discarded

`createRedirectPayment`'s consumer read `response.Data.SessionId`, but the redirect endpoint answers
`SessionID` (capital D) — confirmed verbatim in a live sandbox response:

```
[REDIRECT cc/channel='cc'] OK  Status=200 DataKeys=["SessionID","Url"]
```

so `Payment.externalSessionId` was always `null` for a hosted-page payment, and the session could not
be reconciled through `POST /api/v2/payment/status`.

### 2.6 The fifth defect — a stale channel table for QRIS

`providerMethodFor` had its own channel table and said QRIS's channel was `qris`. The catalog, iPaymu's
documentation (`qris → mpm`) and a live sandbox call all say `mpm`. Found by the new regression test on
its first run. Not reachable through the service (which passes the catalog's `defaultChannel`), but it
was a second source of truth for the same fact — the exact condition that produced §2.3.

---

## 3. Sandbox Configuration Audit

Reported by **presence and format only**. No value was printed, logged or committed.

| Variable | Status | Notes |
|---|---|---|
| `PAYMENT_ENVIRONMENT` | **SET** | resolves to `sandbox` |
| `IPAYMU_SANDBOX_VA` | **SET** | 16 chars, numeric (schema requires 10–20 digits) |
| `IPAYMU_SANDBOX_API_KEY` | **SET** | 43 chars (schema requires ≥10) |
| `IPAYMU_SANDBOX_BASE_URL` | **SET** | resolves to `https://sandbox.ipaymu.com` (allow-listed) |
| `IPAYMU_PRODUCTION_VA` | SET (unused in sandbox) | never read while `PAYMENT_ENVIRONMENT=sandbox` |
| `IPAYMU_PRODUCTION_API_KEY` | SET (unused in sandbox) | never read while `PAYMENT_ENVIRONMENT=sandbox` |

**Resolver trace:** `getIpaymuConfig()` → `buildIpaymuConfig(process.env)` → `resolvePayEnvironment`.
Fail-closed, no default, per-environment credential names, base-URL allow-list. **No stale name, no
wrong environment, no wrong URL, no credential-handling defect.** The configuration was correct all
along; §2 is what was broken.

**Legacy environment surface (drift removed):** `lib/payment/ipaymu.ts` exported an `IPAYMU_CONFIG`
constant that read four *retired* variables (`IPAYMU_API_KEY`, `IPAYMU_VA`, `IPAYMU_URL`,
`IPAYMU_IS_PRODUCTION`) at module load. It was referenced by nothing, but the module is imported by the
live ticketing payment path, so a deployment that set only the legacy names would have acquired a
second, contradictory config object. **Deleted**, and pinned by a test.

Two scripts still read the legacy names and are now stale/unreachable-in-spirit:
`scripts/test-ipaymu-sandbox.js` and `scripts/audit-ipaymu.ts`. They are operator diagnostics, not
runtime code. Reported, not modified.

---

## 4. iPaymu API Contract Audit

Checked field-by-field against the provider's current official documentation
(*Direct Payment*, *Redirect Payment*), not against project memory.

| Claim | Source | Verdict |
|---|---|---|
| Sandbox host `https://sandbox.ipaymu.com` | docs | ✅ matches constant |
| Direct endpoint `POST /api/v2/payment/direct` | docs | ✅ |
| Redirect endpoint `POST /api/v2/payment` | docs | ✅ (code sends a trailing slash; sandbox answers 200 — see Findings) |
| Required headers `va`, `signature`, `timestamp`, `Content-Type` | docs | ✅ all four sent |
| Signature `HMAC-SHA256("POST:"+va+":"+lowercase(sha256hex(body))+":"+apiKey, apiKey)` | docs + provider libraries | ✅ |
| Direct required fields `name, phone, email, amount, notifyUrl, referenceId, paymentMethod, paymentChannel` | docs | ✅ all sent |
| `qris → paymentChannel mpm` | docs | ✅ **was wrong in one mapper; fixed (§2.6)** |
| `va → bca, bni, bri, mandiri, bsi, cimb, permata, danamon, bmi, bag, bpd_bali` | docs | ✅ catalog matches |
| `cstore → alfamart, indomaret` | docs | ✅ |
| `cc → paymentChannel cc` | docs | ✅ **was sent empty; fixed (§2.3)** |
| `expired` is in **hours**, capped per channel (BSI 3h, BRI 2h, BCA/Alfamart/QRIS not customisable) | docs | ✅ code sends `ceil(ttl/60)` = 1 for a 30-min TTL; sandbox accepted it on every channel |
| `expiredType` (present in the docs' example, absent from the parameter table) | docs | ✅ not sent — correctly treated as undocumented |
| Direct response `Data.PaymentNo` (VA/cstore), `QrString`/`QrImage` (QRIS), `Expired` | docs | ✅ read verbatim; nothing fabricated |
| Redirect response `Data.SessionID` + `Data.Url` | docs + live sandbox | ✅ **casing bug fixed (§2.5)** |
| Callback signature: drop `signature`, `ksort` keys, `JSON.stringify`, HMAC-SHA256 with **VA** as secret | docs | ✅ implementation matches exactly |

**Nothing was implemented from a guess.** Methods deliberately *not* offered remain correctly
un-offered: `cod` (nothing to deliver for a digital ticket), `paylater` (no honest ledger bucket), and
e-wallets (they settle over the QRIS channel `mpm`).

---

## 5. Payment Flow Audit

| Stage | Location | Verdict |
|---|---|---|
| Checkout → order | `lib/ticketing/checkout.ts` | ✅ unchanged; server-priced |
| Order → payment claim | `service.ts` `createOrderPayment` | ✅ `Payment` row inserted `UNPAID` **before** the network call; `paymentReference @unique` is the concurrency guard |
| Eligibility gate | `assertOrderPayable` | ✅ status, `paymentStatus`, server-clock window, held reservations, zero-amount (D-26) |
| Method → provider mapping | `gateway.ts` | ❌→✅ **four defects, fixed** |
| Transport + signing | `lib/payment/ipaymu.ts` | ✅ correct (verified live) |
| Direct instruction persistence | `recordInstruction` | ✅ guard on `paymentUrl/paymentNumber/qrString`; provider `Expired` wins over our TTL |
| Redirect session persistence | `recordSession` | ✅ guard on `paymentUrl` |
| Callback → verdict | `readCallback` / `classifyIpaymuNotification` | ✅ explicit 4-value vocabulary; `2`/`3` are never success |
| Signature verification | `verifyCallbackSignature` | ✅ fail-closed, timing-safe, HMAC over the exact raw bytes |
| Settlement | `webhook.ts` → `settlement.ts` | ✅ webhook-only; no service can mark an order PAID |
| Ticket issuance | buyer-triggered | ✅ unchanged |
| Authority | server-side | ✅ the request schema declares **no** amount/total/currency/identity field |

**Money:** the single numeric coercion is `requireSafeRupiah` in the gateway (integer-checked,
`isSafeInteger`, non-negative). No float arithmetic anywhere in the payment path. Unchanged.

---

## 6. Webhook Audit

`app/api/ticketing/payment/webhook/route.ts` → `handleGatewayWebhook`.

| Property | Verdict |
|---|---|
| Raw body read (`await request.text()`), never re-serialised | ✅ |
| Signature required; accepted from the `X-Signature` header **or** the documented body field | ✅ exactly one value is ever checked |
| `crypto.timingSafeEqual`, length-checked first | ✅ |
| Fail-closed: missing signature / unconfigured VA / mismatch → refuse | ✅ no fall-through path exists |
| No session, no CSRF token, no user context | ✅ correct — the provider cannot hold a session |
| Malformed payload → `unknown` verdict → acknowledged, **no state change** | ✅ |
| Duplicate / late callback → `WebhookEvent` ledger + idempotency | ✅ covered by `payment-webhook.integration.test.ts` |
| Amount compared against the persisted order total (`sub_total` preferred over `amount`) | ✅ |
| Unknown payment / wrong merchant reference | ✅ refused |
| Atomicity | ✅ settlement is one transaction; external calls are banned inside it |
| Security weakened? | ❌ **No.** Signature verification, fail-closed behaviour and the amount check are all untouched. |

**Security posture of the webhook is unchanged by this phase.**

---

## 7. Payment UI Audit

`components/orders/PayNowButton.tsx`, `components/ticketing/PaymentInstruction.tsx`,
`app/ticketing/orders/[orderNumber]/page.tsx`.

| Requirement | Verdict |
|---|---|
| Offered methods == backend-supported methods | ❌→✅ **now literally the same module** (`method-catalog`) for both |
| Unsupported methods not exposed | ✅ `E_WALLET`/`BANK_TRANSFER` gone from both picker and schema |
| QRIS shows the **gateway's** QR | ✅ `qrImageUrl` / `qrString` from the `Payment` row; a missing instruction says so rather than drawing a placeholder |
| VA shows the **gateway's** number | ✅ `paymentNumber` + `paymentName`, server-rendered |
| Nothing fabricated | ✅ no locally generated QR, VA, `PaymentNo` or reference |
| Expiry shown | ✅ ISO instants from the database; label states WIB |
| Redirect URL works | ✅ provider URL, and the link is the gateway's |
| Client sends no financial value | ✅ `{ method, channel }` only |
| Return from the provider is not proof of payment | ✅ the page re-reads the row; no `?status=` trust |
| Duplicate payment cannot fork the order | ✅ a live session is *resumed*, not re-created |
| Expired/cancelled order cannot become paid | ✅ server-clock window + terminal-state refusal |
| Redirect flow tells the buyer they are leaving | ✅ |

**One UI-visible consequence of the fix, worth stating:** the bank `<select>` appears only when a method
declares more than one channel. `CREDIT_CARD` still declares exactly one, so it stays hidden — the
catalog change is invisible in the UI.

---

## 8. Database Inventory

**After cleanup:** 64 tables, 36 of them Prisma models, 27 retained legacy tables, plus
`_prisma_migrations`. Data 2.58 MB + index 4.19 MB = **6.77 MB**.

### 8.1 Active Prisma model tables (36) — category A

`account`, `adminauditlog` (1 238), `checkin`, `event` (14), `eventimage` (1), `eventorder` (13),
`eventorderitem` (15), `idempotencykey` (11), `joblock`, `notification` (44), `notificationdelivery`,
`organizer` (31), `organizermember` (47), `payment` (9), `paymenttransaction` (1), `permissiongrant`,
`picattribution`, `piceventassignment`, `picfeeledger`, `picprofile`, `platformsetting`, `refund` (6),
`refunditem`, `session`, `settlement`, `settlementitem`, `sport` (26), `staffeventassignment` (8),
`storesetting` (1), `ticket`, `ticketreservation` (15), `tickettype` (62), `user` (275), `venue` (1),
`verificationtoken`, `webhookevent` (1).

Largest single object: **`adminauditlog` at 1.72 MB** — active, untouched.

### 8.2 Retained legacy tables (27) — category C

| Table | Rows | Domain | Why retained |
|---|---|---|---|
| `order` | 149 | retail | financial/historical orders |
| `orderitem` | 141 | retail | order lines |
| `product` | 5 | retail | catalogue history |
| `productvariant` | 8 | retail | variant history |
| `productdiscount` | 1 | retail | pricing history |
| `bulkdiscount` | 2 | retail | pricing history |
| `cart` / `cartitem` | 5 / 3 | retail | shopper history |
| `voucher` | 1 | voucher | commercial history |
| `shippingdiscount` | 1 | shipping | commercial history |
| `flashsale` | 2 | flash sale | commercial history |
| `campaign` | 1 | marketing | commercial history |
| `broadcast` | 5 | marketing | send history |
| `affiliateprofile` | 15 | affiliate | party records |
| `affiliateclick` | 7 | affiliate | attribution history |
| `affiliateconversion` | 17 | affiliate | **financial** attribution |
| `affiliatekyc` | 2 | affiliate | KYC records |
| `affiliatepayout` | 5 | affiliate | **financial payouts** |
| `spinwheelcampaign` | 1 | spin wheel | promotion history |
| `spinwheelreward` | 7 | spin wheel | **financial** reward ledger |
| `spinwheelspin` | 13 | spin wheel | **financial** entitlement ledger |
| `useraddress` | 13 | shipping | customer data |
| `province` / `regency` / `district` / `village` | 54 / 1 003 / 1 811 / 1 178 | RajaOngkir | reference data |
| `refund_backup_phase10b` | 6 | refund | **pre-migration snapshot of refunds** |

≈4 456 rows of historical data. **Not one row was deleted.**

### 8.3 `refund_backup_phase10b` — classification and decision

- **Created by no migration.** It is the only table in the database (besides Prisma's own
  `_prisma_migrations`) with no `CREATE TABLE` anywhere in `prisma/migrations/`. It was made out of
  band by a Phase 10B script.
- **Not in the Prisma schema.** No model, no `@@map`.
- **Referenced by no code** anywhere under `app/`, `lib/`, `components/`, `scripts/`, `__tests__/`.
- **Content:** 6 rows, ids `1, 5, 6, 7, 8, 9` — exactly the six ids of the live `refund` table — but in
  the **pre-lifecycle shape** (`amount`, `orderId`, `requestedBy`, `processedBy`) with the **pre-migration
  statuses** (`COMPLETED`) where the live table now reads `REFUNDED`.

**Decision: RETAIN, reported for manual review.** It is the only surviving evidence of six refunds'
pre-migration state. Deleting it would destroy history to recover 0.02 MB. If the operator decides it is
not needed, the safe procedure is a new `DROP TABLE IF EXISTS` migration — never a manual drop, and
never before exporting it.

### 8.4 Schema ↔ database consistency

- `npx prisma validate` → **valid**.
- `npx prisma migrate status` → **23 migrations, "Database schema is up to date!"**.
- Models with no physical table: **none**. Tables matching a model: **36 / 36**.
- No foreign-key errors; no retained table was broken by the cleanup.

### 8.5 Known schema drift (reported, not changed)

The **active** `notification` table carries an `orderId` column with a foreign key to the **legacy**
`order` table. The Prisma `Notification` model has no such field — it has `eventOrderId`, `ticketId`,
`eventId`, `organizerId`, `picProfileId`. So the table has an extra column and constraint that Prisma
does not know about.

Consequences: `order` cannot be dropped while this constraint exists, and a `prisma migrate dev` would
propose dropping the column. No code reads or writes `notification.orderId`.

**Deliberately not fixed:** dropping the column destroys the retail notification linkage for 44 rows and
is a schema change with data loss. It needs an explicit decision and a data export first.

---

## 9. Legacy Tables Identified

36 tables had no Prisma model. Classification:

| Category | Count | Meaning |
|---|---|---|
| A — active | 36 | Prisma models in use |
| B — required by relations | 0 | (all model tables are category A) |
| C — legacy with historical/business/financial data | **27** | retained |
| D — test/fixture residue | 0 tables (rows only — see §12) | |
| E — completely unused and safe to remove | **8** | removed |
| — infrastructure | 1 | `_prisma_migrations` (Prisma's own ledger) |

### 9.1 The eight removed tables (category E)

`campaigncategory`, `campaignproduct`, `vouchercategory`, `voucherproduct`, `voucheruserusage`,
`flashsalepurchase`, `promotion`, `rajaongkirregion`.

Each satisfied **all** of the following, verified against the live database:

1. **0 rows** — nothing was deleted; only empty structures were removed.
2. **No inbound foreign key** from any table (checked `information_schema.KEY_COLUMN_USAGE` for
   `REFERENCED_TABLE_NAME`). Their own outgoing keys point only at retained parents.
3. **No Prisma model, no `@@map`, no relation.**
4. **No code reference** — word-boundary `grep` across `app/`, `lib/`, `components/`, `scripts/`,
   `__tests__/`, `types/` returns **zero**. The only mentions in the whole repository are the
   `CREATE TABLE` statements in `prisma/migrations/`.
5. **Not reachable from the ticketing domain.**

They belong to four retired features: marketing campaign compartments, voucher sub-tables,
flash-sale purchases, and the RajaOngkir region cache.

---

## 10. Tables/Data Safely Removed

**One migration:** `prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/migration.sql`,
applied with `npx prisma migrate deploy`. Eight `DROP TABLE IF EXISTS` statements, children first.

### Why a migration rather than a manual `DROP TABLE`

**Every one of the eight was created by an earlier migration still in the history**
(`0_baseline`, `20260820095404_add_marketing_affiliate_foundation`,
`20260909000000_add_shipping_discount_quota`). A hand-run `DROP TABLE` would have left the database
disagreeing with its own migration chain, and a fresh `migrate deploy` would have silently recreated
them. Appending the drop makes the chain self-consistent.

**Verified reproducible:** the fresh test database was provisioned from the same chain *after* the drop
migration existed, and all eight tables are **absent** from it — create → drop → absent.

### Storage actually reclaimed

| | Before | After | Δ |
|---|---|---|---|
| Tables | 72 | 64 | −8 |
| Data | 2.70 MB | 2.58 MB | −0.12 MB |
| Index | 4.48 MB | 4.19 MB | −0.29 MB |
| **Total** | **7.18 MB** | **6.77 MB** | **−0.41 MB** |

**Stated plainly: the storage argument for this cleanup is weak.** 0.41 MB is not why it was worth
doing; the value is that eight dead structures no longer appear to be part of the domain. The
largest object in the database is the **active** `adminauditlog` at 1.72 MB — roughly four times
everything reclaimed here — and it must not be touched.

### Should `OPTIMIZE TABLE` be run?

Dropping a table returns its pages to the InnoDB tablespace but does not compact existing files. If the
operator wants the file space back on disk, the safe procedure is `OPTIMIZE TABLE` on the **retained**
tables only (it rebuilds a table and its indexes; it is not run here because it is a maintenance
operation with its own downtime characteristics). Running it on the whole schema is unnecessary.

---

## 11. Tables Intentionally Retained and Why

| Group | Tables | Reason |
|---|---|---|
| Historical retail commerce | `order`, `orderitem`, `product`, `productvariant`, `productdiscount`, `bulkdiscount`, `cart`, `cartitem`, `voucher`, `shippingdiscount`, `flashsale`, `campaign`, `broadcast` | Business history. `order` is additionally undroppable (§8.5). |
| Affiliate | `affiliateprofile`, `affiliateclick`, `affiliateconversion`, `affiliatekyc`, `affiliatepayout` | Contains **financial** attribution and payout records. |
| Spin wheel | `spinwheelcampaign`, `spinwheelreward`, `spinwheelspin` | **Financial** reward and entitlement ledger, plus order linkage. |
| Shipping reference data | `province`, `regency`, `district`, `village` | 4 046 rows of address reference data; `useraddress` still has foreign keys into them. |
| Customer addresses | `useraddress` | Customer data. |
| Refund snapshot | `refund_backup_phase10b` | Pre-migration financial snapshot — see §8.3. |
| Prisma bookkeeping | `_prisma_migrations` | Prisma's own ledger. Dropping it would break the migration system. |

**Rule applied:** a table is removed only when it is *empty* **and** *unreferenced* **and** *unmentioned
in code*. Anything with rows is retained and reported. Nothing was deleted on the basis of a name, a
resemblance to a removed feature, or an assumption.

---

## 12. Fixture / Test Data Cleanup

### 12.1 Residue present in the development database

| Object | Count | State |
|---|---|---|
| users `@example.test` | 84 | fixture |
| organizers (`p6-org-*`, `p7-org-*`) | 30 | fixture |
| organizer members | 46 | fixture |
| sports (`p6-sport-*`, `p7-sport-*`) | 12 | **0 active** ✅ |
| events (`P6 …`, `P7 …`) | 12 | **all `ARCHIVED` + `archivedAt` set** ✅ |
| ticket types | 60 | on archived fixture events |
| orders | 11 | **financial rows — retained** |
| payments | 9 | **financial rows — retained** |
| tickets / refunds | 0 / 0 | — |
| reservations | 13 | on archived fixture events |

**Publicly listable fixture events: 0.** Every fixture event is `ARCHIVED` with `archivedAt` set, so
`publicVisibilityWhere` excludes it; every fixture sport is `isActive: false`, so
`listPublicSports` excludes it. The Phase 21B teardown is doing its job.

### 12.2 What this phase did and did not delete

**Did not delete** the 11 orders and 9 payments. They are financial rows, and the task's own rule is
explicit: *"do not destroy financial history merely to save storage"* and *"if uncertain whether data is
safe to delete: DO NOT DELETE IT."* Deleting them would also require deleting their 30 organizers, 84
users and 46 memberships, and would prove nothing. **Reported for manual review.**

**Deleted:** nothing this phase. Phase 21B removed 12 verified-empty fixtures and deactivated 10
fixture sports; the residue above is what was deliberately left behind.

### 12.3 The real fix — the suites no longer touch the development database

This is the root cause of the whole ghost-event class of problem, and it is now closed (see §12.4).
Comparing the counts above before and after two full Jest runs inside this phase:

| | Before the runs | After the runs |
|---|---|---|
| Fixture users in **development** DB | 84 | **84** |
| Fixture events in **development** DB | 12 | **12** |
| Fixture orders in **development** DB | 11 | **11** |
| Fixture payments in **development** DB | 9 | **9** |

Unchanged — while the **test** database accumulated the fixtures those runs created (20 users, 8
organizers, 32 orders, 1 payment, 1 ticket). **The suites now write where they belong.**

---

## 13. Code Fixes

### Payment (all in the ticketing payment path)

| # | File | Fix |
|---|---|---|
| **F1** | `lib/ticketing/payment/validation.ts` | The accepted method set is now derived from the catalog (`PURCHASABLE_PAYMENT_METHODS = PURCHASABLE_METHOD_VALUES`). **This is the fix that makes VA, retail outlet and credit card payable.** It makes the class of drift impossible rather than merely corrected — there is one list. |
| **F2** | `lib/ticketing/payment/gateway.ts` | `providerMethodFor` can no longer produce an empty channel, and no longer keeps a channel table of its own: both flows read the catalog's `providerMethod`/`defaultChannel`. Fixes the credit-card `401` **and** the QRIS `qris`→`mpm` error (§2.6). |
| **F3** | `lib/ticketing/payment/gateway.ts` | `resolvePaymentSelection` records a catalogued method as the buyer's own choice instead of round-tripping it through the lossy retail mapper. A credit-card payment can no longer be booked as `BANK_TRANSFER`. |
| **F4** | `lib/payment/ipaymu.ts` | The redirect response's `SessionID` is read as well as `SessionId`, so `Payment.externalSessionId` is populated and hosted-page sessions are reconcilable. |
| **F5** | `lib/ticketing/payment/method-catalog.ts` | `CREDIT_CARD` declares its documented channel (`cc`) instead of none — the inconsistency that produced F2. Also corrected the stale "`E_WALLET` kept in the request enum" note. |
| **F6** | `lib/payment/ipaymu.ts` | Deleted the dead legacy `IPAYMU_CONFIG` object that read four retired environment variables at module load inside the live payment path. |

**Not changed:** the signature scheme, the resolver, the base-URL allow-list, the webhook verifier, the
settlement path, the amount logic, ticket issuance, the refund path, `.env`, `.env.example`, and
`next.config.ts`.

### Database

| # | Change |
|---|---|
| **D1** | New migration `20260920000000_drop_unused_legacy_retail_tables` — eight empty, unreferenced, unreachable legacy tables. |

### Test infrastructure (Part 12)

| # | File | Change |
|---|---|---|
| **T1** | `__tests__/support/test-database.ts` *(new)* | Derives `<DATABASE_URL database>_test` deterministically and points the process at it. Idempotent. |
| **T2** | `jest.setup-env.ts` *(new)* | `setupFiles` entry: redirects every worker **before** the test module graph imports `lib/prisma.ts`. |
| **T3** | `__tests__/support/global-setup.ts` *(new)* | Refuses to start a run whose test database is missing or behind, naming the exact fix command. |
| **T4** | `scripts/setup-test-db.ts` *(new)* + npm `test:db:setup` | One command: creates the database with the app database's charset/collation, applies all migrations, seeds the baseline taxonomy. Never drops or resets. |
| **T5** | `jest.config.js` | Wires `setupFiles` + `globalSetup`; sets `maxWorkers: 1` (one writer per database). |
| **T6** | `__tests__/support/fixture-teardown.ts` | The safety net now sweeps **both** databases — the test one (where fixtures are created now) and the development one (legacy residue). |
| **T7** | `package.json` | Added `test` and `test:db:setup`. |

`maxWorkers: 1` deserves its own justification, because it is a behaviour change: with the default
worker pool, several suites assert on **global** facts (public catalogue contents, the seeded sport
taxonomy) and one suite's fixture is another suite's unexpected row. Parallel: **87 failing tests (11
suites)**. Serial: **34 failing tests (3 suites)**. The other 53 were pure interference — and critically,
they were indistinguishable from real breakage, so a genuine regression had nowhere to show up.
Serialising costs ~20 s and buys a run whose failures mean something.

---

## 14. Tests Added / Changed

### Added

- **`__tests__/ticketing-payment/payment-method-contract.test.ts`** — 13 tests, no database, no provider.
  Fails on the pre-fix code. Covers:
  - the schema accepts **every** method the catalog offers, and each is named on failure;
  - the exported method list **is** the catalog's, not a second copy;
  - the retired names (`E_WALLET`, `BANK_TRANSFER`) are gone from both;
  - every catalogued method resolves to a **non-empty** channel the method actually has;
  - `CREDIT_CARD` → `cc`/`cc` and is never booked as `BANK_TRANSFER`;
  - the documented provider mapping per method (`qris→mpm`, `va→bca`, `cstore→alfamart`);
  - a channel from another method is refused, never silently swapped;
  - the redirect path persists `SessionID`, asserted against a stubbed provider response, **and** that
    the bytes actually put on the wire carry `paymentChannel: "cc"`;
  - the payment transport has exactly one configuration source and no legacy `process.env` reads.

### Changed

**None.** No assertion was weakened, no test was skipped, no timeout was loosened, and no existing test
was edited to accommodate the fixes. The two suites from Phase 21B (`fixture-isolation`,
`status-presentation`) were not touched.

---

## 15. Sandbox Smoke-Test Result

**Performed, against the real iPaymu sandbox, through the real gateway code.** Credentials were already
configured; `PAYMENT_ENVIRONMENT=sandbox` was forced in the process environment so a production
credential could not be selected. No secret value was printed.

### 15.1 All four methods, through the gateway seam, using the selection the service computes

```
========== SANDBOX CONFIG ==========
environment: sandbox | baseUrl: https://sandbox.ipaymu.com
[QRIS]           DIRECT   OK  channel=mpm       number=yes qr=yes  expired=+5m
[VIRTUAL_ACCOUNT] DIRECT  OK  channel=bca       number=yes qr=no   expired=+1h
[RETAIL_OUTLET]  DIRECT   OK  channel=alfamart  number=yes qr=no   expired=+24h
[CREDIT_CARD]    REDIRECT OK  channel=cc storedMethod=CREDIT_CARD sessionId=present
```

**4 of 4.** Before the fix, three of these could not even be submitted, and the fourth returned `401`.

### 15.2 Before / after on the credit-card path (live sandbox)

```
REDIRECT cc / paymentChannel ""   -> HTTP 401  "unauthorized signature"     [BEFORE]
REDIRECT cc / paymentChannel "cc" -> HTTP 200  Success, SessionID + Url     [AFTER]
```

### 15.3 The ten-point verification list from the task

| # | Item | Status |
|---|---|---|
| 1 | create order | ⚠️ **not run end-to-end over HTTP.** Covered at the service level by `payment-creation.integration.test.ts` (18/18 pass). |
| 2 | initiate sandbox payment | ✅ **real sandbox calls** |
| 3 | receive a valid gateway response | ✅ **real sandbox 200s**, all four methods |
| 4 | payment reference persisted | ⚠️ covered by the integration suite (`Payment.paymentReference`, unique), not by a live end-to-end run |
| 5 | payment status correct | ⚠️ as above (`UNPAID → PENDING`) |
| 6 | webhook settlement works | ✅ `payment-webhook.integration.test.ts` passes |
| 7 | order PAID only after valid settlement | ✅ unchanged, and asserted by the suite |
| 8 | ticket issuance correct | ✅ `ticketing-issuance/*` pass |
| 9 | duplicate callback idempotent | ✅ asserted by the suite |
| 10 | invalid callback rejected | ✅ asserted by the suite |

**Honest statement of the gap:** items 4, 5 and 1 were **not** verified by driving an order through the
HTTP checkout and pay routes against the live sandbox in this session. Items 2 and 3 were verified
against the live sandbox at the transport layer, where the defects were; items 6–10 are verified by the
integration suites against the real database. **Nothing was faked to close this gap.**

---

## 16. Full Test Result

```
Test Suites: 3 failed, 63 passed, 66 total
Tests:       34 failed, 1376 passed, 1410 total
Time:        39.997 s
```

Reproduced on three consecutive full runs (40.0 s / 40.0 s / 56.6 s — the wall time varies with
machine load; the counts do not). No `[fixture-teardown] skipped` warning is emitted, i.e. both
databases were reachable and swept cleanly.

### 16.1 The 34 failures — all pre-existing, all in one cause

`__tests__/security/m4-csp.test.ts`, `__tests__/security/m3-hsts.test.ts`,
`__tests__/security/csp-development-unsafe-eval.test.ts`.

They fail with `Expected substring: "Content-Security-Policy"` and
`TypeError: headersFn is not a function` — because `next.config.ts` is:

```ts
const nextConfig: NextConfig = { poweredByHeader: false, allowedDevOrigins: ["100.88.79.104"] };
```

**There is no security response header anywhere in the application** — not in `next.config.ts`, not in
`proxy.ts`, not in any route. These suites assert a control that was never implemented. They are not
caused by any change in this phase and were failing before it. See §21, finding **H1**.

### 16.2 Progress against the start of this phase

| | Start of phase | End of phase |
|---|---|---|
| Failing suites | 14 | **3** |
| Failing tests | 164 | **34** |
| Wall time | 214.6 s | 40–57 s |

Not one assertion was weakened to achieve this. Eleven suites that were failing on the shared database
— including `events/event-service`, `venues/venue-and-sport` and `ticketing-payment/payment-creation` —
now pass, because they were fighting residue rather than testing behaviour.

The three remaining suites are also the only ones whose failure is a genuine gap rather than a
broken environment.

---

## 17. TypeScript Result

```
npx tsc --noEmit   →   clean (exit 0, no output)
```

The only new type interaction of note: `z.enum(PURCHASABLE_PAYMENT_METHODS)` still type-checks against
Zod 4.4.3's `_enum<const T extends readonly string[]>(values: T)`, so the schema's inferred `method`
type remains the Prisma `PaymentMethod` union with no cast.

---

## 18. Build Result

```
npm run build   →   succeeded
```

All application routes compiled; the printed route table includes `/ticketing/orders/[orderNumber]`,
`/api/ticketing/**` and the dashboard. No warnings related to the payment or database changes.

---

## 19. ESLint Result

```
npx eslint .   →   5 problems (0 errors, 5 warnings)
```

The five warnings are pre-existing `@next/next/no-img-element` advisories in
`app/e/[slug]/page.tsx`, `components/auth/LoginForm.tsx`, `components/auth/RegisterForm.tsx` and
`components/events/EventCard.tsx`. **No new lint issue was introduced.**

---

## 20. Remaining Blockers

### 20.1 Blockers for production

| # | Blocker | Detail |
|---|---|---|
| **P1** | `PAYMENT_ENVIRONMENT` must be set | Fail-closed by design; unset means every payment operation throws. |
| **P2** | Production credentials | `IPAYMU_PRODUCTION_VA` and `IPAYMU_PRODUCTION_API_KEY` must be real production values. A sandbox VA reused in production is refused by the resolver. |
| **P3** | `NEXT_PUBLIC_APP_URL` must be the real HTTPS origin | Validated at config time; it must not contain `localhost`, `127.0.0.1` or `sandbox`, because it is the host of the provider's `notifyUrl`. |
| **P4** | Production iPaymu requires a **static IP and a registered domain** | Stated at the top of the provider's own docs for both endpoints. If the VPS egress IP is dynamic, production calls will be refused and **no amount of application code will change that.** |
| **P5** | `AUTH_SECRET` / `AUTH_URL` | Required by the app; not touched here. |
| **P6** | Email and phone on the buyer | Both are sent to the provider on every payment call. The checkout path must supply them; the resolver does not substitute mock values. |

### 20.2 Blockers for the sandbox

**None.** All four methods complete against the live sandbox.

### 20.3 Not verified

- Items 1, 4 and 5 of §15.3 (a full HTTP checkout → pay → webhook settlement chain against the live
  sandbox).
- Callback signature verification against a **real** iPaymu callback. The scheme matches the provider's
  documentation exactly, and the suite covers fabricated payloads, but no genuine provider callback was
  replayed in this session.
- Whether the iPaymu **account** has every channel activated. Feature/health status per channel lives
  behind `GET /api/v2/payment-channels`, which needs credentials this build does not call at request
  time. Sandbox accepted all four, which is good evidence but not a production guarantee.

---

## 21. Remaining Warnings

### Findings

**H1 — HIGH (pre-existing) — no security response headers are configured.**
`next.config.ts` exports no `headers()`, and nothing sets them in `proxy.ts` or any route. There is no
CSP, no HSTS, no `X-Frame-Options`, no `Referrer-Policy`. Three suites (34 assertions) document the
intended policy and fail. **Not implemented in this phase** — a correct CSP needs a decided allow-list
(e.g. the iPaymu QR image host and the inline theme bootstrap both matter), and that is a security
policy decision, not a bug fix to be guessed at. Evidence: `next.config.ts`; failing suites under
`__tests__/security/`.

**M1 — MEDIUM — active/legacy schema drift on `notification.orderId`.**
The live `notification` table has an `orderId` column with an FK to the legacy `order` table, which no
Prisma model declares and no code uses. It makes `order` undroppable and would be *dropped* by a
`migrate dev`. Needs a decision plus a data export; not changed. See §8.5.

**M2 — MEDIUM — stale diagnostic scripts read retired environment variables.**
`scripts/test-ipaymu-sandbox.js` reads `IPAYMU_API_KEY`/`IPAYMU_VA`/`IPAYMU_URL` and calls the endpoint
directly with its own hand-written body — i.e. it can report "success" while the application path is
broken (it did not exercise the method catalog at all). `scripts/audit-ipaymu.ts` imports
`lib/payment/ipaymu-production.ts`, which still reads the same retired names. Since the runtime no
longer reads them, these scripts can mislead an operator into thinking a credential is configured when
the application rejects it. Recommend rewriting both against `getIpaymuConfig()`.

**M3 — MEDIUM — `refund_backup_phase10b` is an unexplained out-of-band table.**
Six refund rows in their pre-migration shape, created by no migration, referenced by no code. Retained
(§8.3) but it should either be documented as an intentional archive or removed deliberately — not left
as an undocumented object that looks like a schema artefact.

**L1 — LOW — comment contradicts code in the webhook verifier.**
`verifyWebhookSignature` says "The header remains first: if both are present and only one verifies, the
header is what the caller believed it was checking", but the code compares
`bodySignature ?? receivedSignature` — the **body** field wins. Not a security weakness (both are
HMAC-verified over the same canonical payload, and the provider documents the body field), but the
comment should be corrected or the precedence flipped deliberately.

**L2 — LOW — `next-themes` is still a dependency.**
`package.json` lists `next-themes@^0.4.6`, but Phase 21 removed its last usage from the dashboard theme
provider. Harmless; dead weight in the dependency tree.

**L3 — LOW — the redirect endpoint is called with a trailing slash.**
The provider documents `POST /api/v2/payment`; the code calls `/api/v2/payment/`. A live sandbox call
returned **200**, so it is tolerated — but it is an undocumented spelling.

**I1 — INFO — QRIS expiry returned by sandbox disagrees with the documentation.**
The docs say the QRIS code cannot be customised and defaults to 5 minutes; the sandbox returned a
one-hour window. The platform stores the **provider's** `Expired` value, which is the correct behaviour
regardless of whose number is right, so nothing was changed.

**I2 — INFO — dead exports in `lib/payment/ipaymu.ts`.**
`computeLegacyWebhookSignature` (which implements a signature scheme the provider does not use),
`formatProductName`, `isPaymentConfirmed` and `isSuccessNotification` have zero call sites. Left in
place — removing them is churn with no security benefit — but they are candidates for a future sweep.

---

## 22. Exact Production Blockers

Checklist that must hold before a production deployment. **None of this was executed.**

- [ ] `PAYMENT_ENVIRONMENT=production`
- [ ] `IPAYMU_PRODUCTION_VA` — real production VA, **different** from the sandbox VA
- [ ] `IPAYMU_PRODUCTION_API_KEY` — real production key
- [ ] `IPAYMU_PRODUCTION_BASE_URL=https://my.ipaymu.com` (or unset; the default is allow-listed)
- [ ] `NEXT_PUBLIC_APP_URL=https://<real-domain>` — HTTPS, no `localhost`, no `127.0.0.1`, no `sandbox`
- [ ] iPaymu account: **static egress IP registered**, **domain registered** (provider requirement)
- [ ] All four payment channels activated on the production account
- [ ] `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL` set
- [ ] `npx prisma migrate deploy` run on the production database (includes the Phase 22 drop migration)
- [ ] A real end-to-end sandbox-then-production payment verified through the browser (still outstanding)
- [ ] Decide H1 (security headers) and M1 (`notification.orderId`) before or immediately after launch
- [ ] **Do not** reuse sandbox credentials — the resolver refuses it, so a mistake fails closed

---

## 23. Confirmation

**Nothing was deployed.**

- ✅ **No deployment** to any VPS, host or environment
- ✅ **No PM2, no Nginx, no cron, no production domain** configured
- ✅ **No production migration** run — the only migration applied was to the local development database
- ✅ **No production iPaymu credential used** — every sandbox call forced `PAYMENT_ENVIRONMENT=sandbox`
- ✅ **No `git commit`, no `git push`**
- ✅ **No `git reset`, no `git clean`, no `git checkout -- .`**
- ✅ **No `prisma migrate reset`, no `db push`, no database reset**
- ✅ **No `TRUNCATE`**
- ✅ **No table dropped except the eight proven-unused empty ones** (§9.1)
- ✅ **No financial, order or payment row deleted** anywhere
- ✅ **No legitimate business data deleted**
- ✅ **No webhook security weakened** — signature verification, fail-closed behaviour and the amount
  check are byte-identical to before
- ✅ **No authorization weakened**
- ✅ **No test weakened, skipped or deleted** — no assertion relaxed, no timeout loosened
- ✅ **No locked contract changed** — D-28, D-46, D-61, the event lifecycle, `endAt` before publish, the
  manual bank-transfer refund rail, the absence of a fake iPaymu refund API, no automatic refund,
  buyer-triggered issuance, server-side money authority, webhook fail-closed, tenant isolation and
  refund SoD are all untouched
- ✅ **No secret value printed, logged or committed** — environment variables are reported by presence,
  length and first two characters only

**Temporary files created during the audit were removed.** No `.tmp*` file remains.

### Files changed

**Payment:** `lib/ticketing/payment/validation.ts`, `lib/ticketing/payment/gateway.ts`,
`lib/ticketing/payment/method-catalog.ts`, `lib/payment/ipaymu.ts`

**Database:** `prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/migration.sql` (new)

**Tests:** `__tests__/ticketing-payment/payment-method-contract.test.ts` (new),
`__tests__/support/test-database.ts` (new), `__tests__/support/global-setup.ts` (new),
`jest.setup-env.ts` (new), `scripts/setup-test-db.ts` (new), `jest.config.js`,
`__tests__/support/fixture-teardown.ts`, `package.json`

### Files intentionally not changed

`next.config.ts` · `proxy.ts` · `lib/payment/config.ts` (the resolver was already correct) ·
`lib/payment/ipaymu-production.ts` · `lib/ticketing/payment/service.ts` · `lib/ticketing/payment/webhook.ts` ·
`lib/ticketing/payment/settlement.ts` · all refund code · `.env` · `.env.example` ·
`prisma/schema.prisma` · every existing migration · every existing test assertion ·
`scripts/test-ipaymu-sandbox.js` · `scripts/audit-ipaymu.ts` · the retained legacy tables and their rows ·
`refund_backup_phase10b`

> **Note on generated artefacts:** `next-env.d.ts` and `tsconfig.tsbuildinfo` show as modified because
> `npm run build` rewrote them. They are generated; safe to discard.

---

**Report status:** complete. No claim in this document is made without evidence recorded above, and
every gap that could **not** be verified is stated as a gap rather than presented as verified.
