# PHASE 27D — iPAYMU TRANSACTION STATUS — SANDBOX VERIFICATION

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Mode:** verification only. **No source file modified. No database row written, updated or deleted. No migration created or applied. No API route created. Webhook, settlement, authorization untouched. No payment issued; no payment-creation endpoint called. No commit / push / reset / clean.**

---

## 1. VERDICT

> # A. PROVIDER CONTRACT VERIFIED
>
> `POST {sandbox}/api/v2/transaction` works against the TinggalKlik **sandbox** credentials and returns
> a response that matches the documented contract — and is **richer** than the documentation's sample.
>
> * HTTP **200**, `Status: 200`, `Success: true`, `Message: "success"`, ~1.0 s.
> * `Data.Status` = **`1`** (numeric) → inside the documented success set **{1, 6, 7}**.
> * `Data.TransactionId` = **`233592`** (numeric) → **matches** the transaction under verification.
> * **`Data.SubTotal` = 15000, `Data.Amount` = 15000, `Data.Fee` = 3500** — the amount **is** present,
>   which **overturns Phase 27C finding G4** (documented sample carried no amount).
>
> Phase 27C's **G1, G2, G3 and G4 are therefore closed at the provider-contract level.** G5
> (persistence), G6 (audit action) and the owner decisions remain — see §11.

**One request was made. No retry. No other endpoint was called.**

---

## 2. THE SINGLE REQUEST (exactly as sent)

| | |
|---|---|
| Method | `POST` |
| URL | `https://sandbox.ipaymu.com/api/v2/transaction` |
| Base URL asserted | `PAYMENT_ENVIRONMENT=sandbox` → `https://sandbox.ipaymu.com` (**sandbox confirmed**, not production) |
| Headers | `Content-Type: application/json`, `va: <redacted>`, `signature: e5ced8…f6dc (len 64)`, `timestamp: 20260920161233`, `Accept: application/json` |
| Body | `{"transactionId":"233592","account":"<VA-REDACTED>"}` |
| Timeout | 15 000 ms (not reached; elapsed 1 021 ms) |

**Signature construction — the project's existing one, replicated verbatim for this script**
(`lib/payment/ipaymu.ts:61-77`):

```
bodyHash     = sha256(body).toLowerCase()
stringToSign = `POST:${va}:${bodyHash}:${apiKey}`
signature    = HMAC-SHA256(stringToSign, apiKey)
```

`account` was supplied as the sandbox merchant VA (the documented field is "the iPaymu Virtual Account
number", per the balance sample `account="1179000899"`). **`233592` was passed directly in the request
only** — it was **not** inserted into the database, and nothing was updated.

**No secret value appears anywhere in this report**: the VA, the API key, the full signature and all
buyer PII are redacted, and every output in §3 passed through a redactor that strips any string
containing a configured secret.

---

## 3. RESPONSE EVIDENCE (sanitised)

```json
{
  "Status": 200,
  "Success": true,
  "Message": "success",
  "Data": {
    "TransactionId": 233592,
    "SessionId": "EVT-1789894187056-ef2c2a78",
    "ReferenceId": "EVT-1789894187056-ef2c2a78",
    "RelatedId": 0,
    "Sender": "System",
    "Receiver": "<merchant name redacted>",
    "SubTotal": 15000,
    "Fee": 3500,
    "Amount": 15000,
    "Status": 1,
    "StatusDesc": "Berhasil",
    "PaidStatus": "paid",
    "IsLocked": false,
    "Type": 7,
    "TypeDesc": "VA & Transfer Bank",
    "Notes": "Pembayaran EVT-1789894187056-ef2c2a78",
    "CreatedDate": "2026-09-20 15:50:02",
    "SuccessDate": "2026-09-20 15:51:44",
    "ExpiredDate": "2026-09-20 16:50:02",
    "SettlementDate": "2026-09-20 15:51:44",
    "PaymentMethod": "va",
    "PaymentChannel": "BNI",
    "PaymentCode": "<payment code — matches the callback's payment_no>",
    "PaymentName": "iPaymu <merchant>",
    "BuyerName": "<PII-REDACTED>",
    "BuyerPhone": "<PII-REDACTED>",
    "BuyerEmail": "<PII-REDACTED>"
  }
}
```

**This is unmistakably our transaction**, corroborated by five independent fields: the transaction id
`233592`, `SessionId`/`ReferenceId` = our reference `EVT-1789894187056-ef2c2a78`, `Notes` = the
comment this platform sent at creation (`Pembayaran EVT-…`), `SubTotal`/`Amount` = 15000 (our
`EventOrder.total`), and `PaymentMethod: "va"` / `PaymentChannel: "BNI"` matching
`Payment.method = VIRTUAL_ACCOUNT` / `channel = bni`. Every timestamp also matches the Phase 27B
callback (`created 15:50:02`, `paid 15:51:44`, `expired 16:50:02`, `settlement_status settled`).

---

## 4. SUCCESS PREDICATE — VERIFIED

| Question | Observed | Verdict |
|---|---|---|
| Does `Data` exist? | yes (28 keys) | ✅ |
| `Data.Status` type | **`number`** | ✅ as documented |
| `Data.Status` value | **`1`** | ✅ |
| `1 ∈ {1, 6, 7}` (documented success set) | **true** | ✅ **success predicate confirmed against a real transaction** |
| Is the documented `"Successful transactions are indicated by Data->Status being 1, 6, or 7"` accurate? | yes for value 1 | ✅ |
| Corroborating field | `StatusDesc: "Berhasil"`, `PaidStatus: "paid"`, `SuccessDate` set, `SettlementDate` set, `IsLocked: false` | consistent |
| Phase 27C **G2** (`isPaymentConfirmed` compares `Data.Status?.toLowerCase()` to `"paid"`/`"settlement"`) | on a **number** this is `undefined` ⇒ the existing classifier **cannot** return true | ✅ **G2 confirmed, contract now known** |

**Note for implementation (not implemented):** the real payload *also* carries a string
`PaidStatus: "paid"`. The safe predicate remains the **documented numeric `Status ∈ {1,6,7}`**;
`PaidStatus` may be used only as corroboration, never as the sole signal.

**No provider value was converted into any application state.**

---

## 5. TRANSACTION IDENTITY — VERIFIED

| Question | Observed |
|---|---|
| `Data.TransactionId` | **`233592`**, type **`number`** (not a string) |
| `String(Data.TransactionId) === "233592"` | **true** |
| Comparison note for the Phase 27C proposal (require the response to match the stored provider transaction id) | **string-normalise before comparing** — the request sends `"233592"` (string) and the response returns `233592` (number); a strict `===` on mixed types would fail a correct response |
| `Data.SessionId` | `EVT-1789894187056-ef2c2a78` — i.e. **the `referenceId` we sent**, echoed back |

**Related finding (reinforces 27C G5):** read-only inspection shows
`Payment.externalSessionId == Payment.paymentReference` (the `EVT-…` string we generated). It is
therefore **our own reference echoed by the provider, not an independent provider handle** — it cannot
be used to address the status query. The query must be addressed by the provider **`transactionId`**,
which the platform does not persist before settlement.

---

## 6. CONTRACT vs DOCUMENTATION

| Element | Documented | Observed in sandbox | Match |
|---|---|---|---|
| Endpoint | `POST /api/v2/transaction` | same | ✅ |
| Auth headers | `va`, `signature`, `timestamp`, `Content-Type: application/json` | accepted as sent | ✅ |
| Request signature | `HMAC-SHA256("POST:va:sha256(body):apiKey", apiKey)` | accepted (HTTP 200 `success`, not 401) | ✅ |
| Request body | `transactionId` + `account` | accepted; JSON transport works (the docs' `--form` example was not needed) | ✅ |
| Envelope | `{ Status, Message, Data }` | `{ Status: 200, Success: true, Message: "success", Data: {…} }` — an extra `Success` boolean | ✅ superset |
| `Data.Status` numeric, success = 1/6/7 | yes | `1` | ✅ |
| `Data.TransactionId` | shown as string `"4719"` | **number** `233592` | ⚠️ type differs from the doc sample (normalise) |
| `Data` field set | sample shows only `{ Status, TransactionId }` | **28 fields**, including `SubTotal`, `Fee`, `Amount`, `StatusDesc`, `PaidStatus`, `Type/TypeDesc`, `PaymentMethod/PaymentChannel/PaymentCode`, `CreatedDate/SuccessDate/ExpiredDate/SettlementDate`, `SessionId`, `ReferenceId` | ✅ far richer than documented |
| Amount | **not in the documented sample** | **present** (`SubTotal` 15000, `Amount` 15000, `Fee` 3500) | ✅ **G4 overturned** |
| 401 shape | `{ "Status": 401, "Message": "unauthorized" }` | not exercised (call succeeded) | — |
| Buyer PII in the response | not documented | `BuyerName`, `BuyerPhone`, `BuyerEmail` present | ⚠️ must never be logged or persisted by a reconciliation surface |

**Materially different from documentation?** No. Two refinements only: `TransactionId` is a **number**,
and the real response is a **superset** of the documented sample (which is good news, not a mismatch).

---

## 7. DATABASE STATE — BEFORE AND AFTER (read-only)

| Check | Before the call | After the call | Changed? |
|---|---|---|---|
| `EventOrder.status` | `PENDING_PAYMENT` | `PENDING_PAYMENT` | **no** |
| `EventOrder.paymentStatus` | `PENDING` | `PENDING` | **no** |
| `EventOrder.paidAt` | `null` | `null` | **no** |
| `EventOrder.updatedAt` | `2026-09-20T08:50:02.437Z` | `2026-09-20T08:50:02.437Z` | **no** |
| `Payment.status` | `PENDING` | `PENDING` | **no** |
| `Payment.method / channel` | `VIRTUAL_ACCOUNT / bni` | `VIRTUAL_ACCOUNT / bni` | **no** |
| `Payment.updatedAt` | `2026-09-20T08:50:02.426Z` | `2026-09-20T08:50:02.426Z` | **no** |
| `PaymentTransaction` count | 0 | 0 | **no** |
| `Ticket` count | 0 | 0 | **no** |
| `TicketReservation` | 1 × `HELD` | 1 × `HELD` | **no** |
| `WebhookEvent` rows for trx `233592` | 0 | 0 | **no** |

**All timestamps are byte-identical before and after**, which is the strongest available proof that the
provider call touched nothing: an `@updatedAt` column cannot be written without changing its value.
An independent read-only re-check after the call reproduced the same state
(`PENDING_PAYMENT` / `PENDING` / `paidAt null` / 0 tickets / 1 × `HELD` / 0 transactions / 0 ledger rows).

**The real sandbox payment remains exactly as it was: money paid at the provider, still unsettled here.**

---

## 8. WHAT THIS CLOSES IN PHASE 27C

| 27C finding | Status after this verification |
|---|---|
| **G1** — implemented endpoint `/api/v2/payment/status` is not the documented one | ✅ **CLOSED** — `/api/v2/transaction` works (200, `success`) with our credentials and signature scheme |
| **G2** — `isPaymentConfirmed` predicate can never match | ✅ **CLOSED** — the real predicate is verified: numeric `Data.Status ∈ {1, 6, 7}`, observed `1` |
| **G3** — wrong request body (`sessionId`, no `account`) | ✅ **CLOSED** — `{transactionId, account}` with the existing signature is **accepted** |
| **G4** — no amount in the status response, so the poll cannot supply amount evidence | ✅ **OVERTURNED/CLOSED** — `SubTotal` / `Amount` / `Fee` are present for real transactions, so **amount-backed reconciliation is feasible without `POST /api/v2/history`** |
| **G5** — no provider transaction id persisted before settlement | ❌ **STILL OPEN** (and now sharper: `externalSessionId` is only our own reference echoed back, so it cannot address the query) |
| **G6** — no reconciliation audit action | ❌ **STILL OPEN** |
| **G7** — `verifyPaymentStatus` has no test coverage | ❌ **STILL OPEN** |

**Nothing was implemented.** The Phase 27C implementation plan (§14 Steps 1–5) now needs no
provider-side guesswork: Step 1 is a rewrite against a **verified** contract, and its tests can assert
the exact observed shape.

---

## 9. EXACT CONTRACT TO IMPLEMENT (recorded, not implemented)

```
POST {baseUrl}/api/v2/transaction                 // baseUrl is the environment-allow-listed origin
headers: Content-Type: application/json, va, signature, timestamp, Accept: application/json
body:    JSON.stringify({ transactionId: String(trxId), account: va })
signature: existing generateSignature(body, va, apiKey)   // unchanged
timeout:  15s + AbortController                            // existing pattern
CHECK response.ok / HTTP status FIRST                      // the existing client does not
parse:    { Status: number, Success?: boolean, Message: string,
            Data?: { TransactionId: number|string, Status: number|string, SubTotal?: number,
                     Amount?: number, Fee?: number, PaymentCode?: string, PaidStatus?: string,
                     SessionId?: string, ReferenceId?: string, … } }
success:  numeric Data.Status ∈ {1, 6, 7}  AND  normalised Data.TransactionId === requested id
refuse:   any non-200, unparseable body, absent Data, or status outside the set
NEVER log/persist: BuyerName / BuyerPhone / BuyerEmail (present in the response)
```

---

## 10. REMAINING BLOCKERS (unchanged from 27C, restated)

1. **Provider transaction-id persistence (G5).** The documented query needs the provider
   `transactionId`; the platform stores none before settlement, and `Payment.externalSessionId` is
   just our own reference echoed back. Requires an **additive nullable column + owner-approved
   non-destructive migration**, and capture at session creation (`recordSession` / `recordInstruction`
   already receive `providerTransactionId` and drop it).
2. **Amount evidence decision.** Now *feasible* from the status response (`SubTotal`/`Amount`), but the
   owner must still decide the standard: provider amount equality against `EventOrder.total` from the
   **status response**, versus requiring a **signature-verified callback** where one exists. (The
   webhook's evidentiary standard is stronger; a poll's is new — it must be chosen, not assumed.)
3. **Reconciliation audit action (G6).** `TicketingAuditAction` is a closed union; a new
   operator-attributed action is required. **Audit durability** (post-commit, fire-and-forget) should
   be decided at the same time.
4. **`D-P19-04` — money on a terminal order** (`CANCELLED`/`EXPIRED` + paid). Still **UNDECIDED**;
   reconciliation must not answer it by shipping a button.
5. **Implementation tests (G7)** — including a regression guard that the endpoint string, the request
   fields and the **numeric** success set cannot silently drift back.
6. **Migration approval** (items 1) and a decision on whether the legacy `/api/v2/payment/status`
   client is **rewritten or deleted**.
7. **Concurrency/idempotency** — already sufficient (`settleVerifiedPayment`'s CAS is the arbiter;
   verified in 27C §9). No change needed.
8. **The sandbox payment itself** remains unsettled; it is now *reconcilable in principle* (its
   `transactionId` `233592` and its amount `15000` are both verifiable), pending items 1–3.

---

## 11. SAFETY STATEMENT (verification §13)

| Item | Status |
|---|---|
| `git status` | `HEAD` = `8628dbf`; `git diff --name-only` → **empty**; untracked = the three Phase 27B/27C/27D reports only |
| Any **source file changed** | **NONE** |
| Any **database row changed** | **NONE** — only `SELECT`/`count`; `updatedAt` timestamps byte-identical before/after |
| **Provider request result** | `POST /api/v2/transaction` → **HTTP 200**, `Status: 200`, `Success: true`, `Data.Status: 1`, `Data.TransactionId: 233592` |
| Number of provider calls | **exactly 1** — no retry, no `/api/v2/payment`, no `/api/v2/payment/direct`, no `/api/v2/payment/status`, no `/api/v2/history`, no payment creation |
| Any **migration** created or applied | **NONE** — latest migration is still `20260920000000_drop_unused_legacy_retail_tables`; `prisma migrate status` → "23 migrations found … Database schema is up to date!" |
| Commit / push / reset / clean | **NONE** |
| Secrets printed | **NONE** — VA, API key, full signature and buyer PII all redacted; the script printed secret *presence/length*, never values |
| Settlement attempted | **NONE** — `settleVerifiedPayment` was not called; no `PAID` transition, no `PaymentTransaction`, no reservation conversion, no ticket, no settlement audit |

**Report written to:** `PHASE_27D_IPAYMU_TRANSACTION_STATUS_SANDBOX_VERIFICATION_REPORT.md`

---

## 12. FINAL VERDICT

> ### **A. PROVIDER CONTRACT VERIFIED**
>
> One sandbox call to `POST /api/v2/transaction` returned HTTP 200 with `Status: 200`, `Success: true`,
> `Data.Status: 1` (numeric, in the documented `{1, 6, 7}` success set) and
> `Data.TransactionId: 233592` matching the transaction under verification — plus an amount
> (`SubTotal`/`Amount` 15000) that the documentation's sample omitted. Phase 27C findings **G1–G4 are
> closed**; **G5, G6, G7** and the owner decisions in §10 remain. No source file, database row,
> migration, route, webhook, settlement or authorization was touched.
