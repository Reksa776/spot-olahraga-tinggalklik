# PHASE 27B — iPaymu WEBHOOK CALLBACK FAILURE — AUDIT ONLY

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Scope:** audit only. **No source file was modified. No database row was written, updated or deleted. No migration. No commit / push / reset / clean.**

---

## 0. VERDICT

> ### **AUDIT COMPLETE — SOURCE CHANGE REQUIRED**
>
> **Scoped:** the *delivery* failure needs **no source change** — it is a configuration defect
> (the registered notify URL is a loopback address). A bounded source change **is** required to
> recover the one thing configuration can no longer fix: **an already-paid sandbox session whose
> notification can never be delivered** (the reconciliation surface Phase 25 already flagged as
> `PAYMENT_RECONCILE` with zero consumers). See §14.

**ROOT CAUSE (one sentence):** the notification URL we registered with iPaymu is
`http://localhost:3000/api/ticketing/payment/webhook` — a loopback address that exists only on the
developer's machine — so iPaymu's tester, posting from iPaymu's own infrastructure, refused the
connection before any HTTP exchange took place; **the callback never reached this application**,
which is why iPaymu reported `false` / `Response Code: 0`.

**Why `false` is not ours:** there is no code path in the webhook call chain that can serialise the
bare token `false`. Every outcome returns the platform JSON envelope (§4). A controlled live probe
(§5) produced the envelope for all four possible outcomes.

---

## 1. EXACT REPRODUCTION

### 1.1 What the iPaymu tester reported

| Field | Value |
|---|---|
| URL | `http://localhost:3000/api/ticketing/payment/webhook` |
| Method | POST |
| `Content-Type` | `application/x-www-form-urlencoded` |
| `Accept` | `application/json` |
| `X-External-ID` | `20260920155252992020` |
| `X-Signature` | `449631ce4bdee77146521514989f70cba5d979a127fb88217c02eec51e50abd2` (64 hex) |
| `X-Timestamp` | `2026-09-20T15:52:52+07:00` |
| Reported response | **`false`** |
| Reported Response Code | **`0`** |
| Reported Response Time | **`0.000135 s`** |

### 1.2 The three numbers that identify the failure before any code is read

| Observation | Meaning |
|---|---|
| `Response Code: 0` | no HTTP status was received at all — there was no HTTP exchange |
| `Response Time: 0.000135 s` = **0.135 ms** | physically impossible for a request that traversed the internet into a Node process. Our own **loopback** probe measured **6–79 ms** for the same route (§5). A refusal at connect time on the *sender's* host is the only way to answer that fast |
| `Response: false` | the tester's own boolean failure flag, not a body produced by us |

### 1.3 What the application can prove about the delivery

A delivery that reaches `POST /api/ticketing/payment/webhook` **always** leaves a `WebhookEvent`
ledger row unless it is refused by the 64 KiB body bound (`lib/ticketing/payment/webhook.ts:375`,
which returns before any database work). The reported payload is ~0.6 KB.

Read-only query against the application database (`DATABASE_URL` → `tinggalklik`):

```
total webhook rows        : 1
   2026-09-19T15:48:31.330Z | trx TRX-P8-settle-1 | statusCode 1 | sigValid true | PROCESSED / settled | ip 127.0.0.1
webhook rows for order/trx: []
```

* The only ledger row in the database is the **Phase 8 integration-test fixture** from the previous day.
* **Zero** rows for `trx_id 233592`, for `reference_id EVT-1789894187056-ef2c2a78`, or for that order id — not a `PROCESSED`, not an `IGNORED`, not even a **`signatureValid = false`** row.

**Therefore the reported delivery never reached the handler.** If it had — even with a forged
signature — the refusal would be observable in `webhookevent` by design (§31.4 of the design brief),
and it is not.

---

## 2. THE COMPLETE CALL PATH

The route was located and every service/helper it calls was read.

| # | Stage | Exact location |
|---|---|---|
| 1 | Route entry / method | `app/api/ticketing/payment/webhook/route.ts` → `export async function POST` (only POST exists; GET → 405) |
| 2 | `Content-Type` handling | none: the raw body is read **unconditionally** as text — `app/api/ticketing/payment/webhook/route.ts:52` `const rawBody = await request.text()` |
| 3 | Raw-body extraction | same call — the signature covers these exact bytes; the body is never re-serialised |
| 4 | Signature header lookup | `:48` `const SIGNATURE_HEADER = "x-signature"`; `:56` `signatureHeader: request.headers.get(SIGNATURE_HEADER)` (call site `:54-58`) |
| 5 | Handler entry | `lib/ticketing/payment/webhook.ts:366` `handleGatewayWebhook({ rawBody, signatureHeader, remoteIp })` |
| 6 | Body bound | `lib/ticketing/payment/webhook.ts:375` → `> 64 KiB (MAX_WEBHOOK_BODY_BYTES)` ⇒ **413**, before any parse or DB work |
| 7 | Signature verification | `webhook.ts:384` `verifyCallbackSignature(...)` → `lib/ticketing/payment/gateway.ts:858` → `lib/payment/ipaymu.ts:1198 verifyWebhookSignature` |
| 8 | Body-field signature fallback | `lib/payment/ipaymu.ts:1234` `raw.signature` removed from the canonical payload, accepted when no header is present (exactly one value is ever checked) |
| 9 | Form-urlencoded parsing | `lib/payment/ipaymu.ts:1215` `new URLSearchParams(rawBody)` (verification) and `gateway.ts:779 readCallback` (interpretation) |
| 10 | Normalisation | `gateway.ts:658 normalizeNotification` → `lib/payment/ipaymu.ts:1085 normalizeCallbackBody` (typed: int / bool / array / string) |
| 11 | Status classification | `lib/payment/ipaymu.ts classifyIpaymuNotification` (four-value vocabulary: success / pending / failed / unknown) |
| 12 | Amount verification | `webhook.ts:341 amountVerdict` — `sub_total` preferred over `amount`, compared with `Prisma.Decimal.equals` against `EventOrder.total` |
| 13 | Order lookup | `webhook.ts:268 resolveTicketingTarget` — by **`Payment.paymentReference`** (unique), then the `EVT-` namespace guard |
| 14 | Payment lookup | same call (`prisma.payment.findUnique({ where: { paymentReference } })`) |
| 15 | Idempotency / replay guard | `webhook.ts:186 claimLedgerRow` — INSERT into `webhookevent`, `providerEventId` `@unique`; `P2002` ⇒ read the existing row; only `PROCESSED` blocks a later delivery |
| 16 | Settlement | `lib/ticketing/payment/settlement.ts settleVerifiedPayment` (one transaction: CAS order → PAID, CAS payment → PAID + `PaymentTransaction`, `reserved -= q / sold += q`) |
| 17 | Ledger finalisation + response | `webhook.ts:657 applySettlementOutcome` → route `:63-85` (4xx/5xx envelope, then `ok({ message }, status)`) |

**Nothing in this chain performs an outbound call, and nothing outside it can write `PAID`** — the
settlement trigger remains webhook-only, exactly as Phase 22–26 recorded.

---

## 3. WHERE THE BODY `false` CAN ORIGINATE — SEARCH RESULT: NOWHERE

Searched the entire active webhook chain (route → `webhook.ts` → `gateway.ts` → `ipaymu.ts` →
`settlement.ts` → `lib/api/response.ts`) for `false`, `Response(false)`, `NextResponse.json(false)`,
`JSON.stringify(false)`, `return false`.

**Every `return false` in the chain is an internal boolean predicate, never a response body:**

| File | Occurrences | What they are |
|---|---|---|
| `lib/payment/ipaymu.ts` | 8 (`:883`, `:905`, `:930`, `:1050`, `:1205`, `:1210`, `:1257`, `:1263`) | validation predicates; `:1205`/`:1210`/`:1257`/`:1263` are `verifyWebhookSignature`'s fail-closed branches |
| `lib/ticketing/payment/gateway.ts` | 1 (`:145`) | `isConfigured()` |
| `lib/api/response.ts` | — | `ok()` always wraps: `NextResponse.json({ success: true, data }, { status })` |

The response is produced in exactly two places, both envelope-shaped:

* **Success / any handled outcome** — `app/api/ticketing/payment/webhook/route.ts:85`
  `return ok({ message: result.message }, result.httpStatus)`
  → `{"success":true,"data":{"message":"…"}}`
* **Error** — `handleApi` → `apiErrorResponse` (`lib/api/response.ts`)
  → `{"success":false,"code":"…","message":"…","correlationId":"…"}`

and the proxy never touches this path (`proxy.ts` → `PUBLIC_API_PREFIXES` entry
`"/api/ticketing/payment/webhook"`, matched before the protected prefix, so no 401 is injected).

**A body of exactly `false` is not producible by this application.** The live probe in §5 confirms
it empirically for all four outcomes.

---

## 4. THE ACTUAL HTTP STATUS FOR THIS REQUEST

The tester's `Response Code: 0` is **not** our status code — it means "no response received".

Because the tester's own numbers cannot answer "what would our endpoint have said", the endpoint was
exercised directly, without changing any code:

* **Isolation guard:** the application was started as a **production build** (`next start`, port
  3210) with `DATABASE_URL` rewritten to a **sibling database name that does not exist**
  (`tinggalklik_audit_27b_absent`). Readiness was checked **first** and returned **503** — proof the
  override took effect, so **no probe could reach, let alone write, any real database**. The server
  log confirms it: `Database 'tinggalklik_audit_27b_absent' does not exist`.
* The probes posted the **exact reported body** (all 26 fields, in order, form-urlencoded) with the
  exact reported header set.

| Probe | Request | HTTP | Body |
|---|---|---|---|
| **P1** | exact body + **exact reported `X-Signature`** | **503** | `{"success":false,"code":"DATABASE_UNAVAILABLE","message":"Data sedang tidak dapat dimuat. Silakan coba lagi.","correlationId":"26ddf4ea-…"}` |
| **P2** | exact body + tampered signature | **401** | `{"success":false,"code":"UNAUTHORIZED","message":"Signature tidak valid."}` |
| **P3** | exact body + no signature | **401** | `{"success":false,"code":"UNAUTHORIZED","message":"Signature tidak valid."}` |
| **P4** | body > 64 KiB | **413** | `{"success":false,"code":"INVALID_WEBHOOK","message":"Payload terlalu besar."}` |
| **P5** | GET | **405** | (empty) |

**P1 is the load-bearing result.** It differs from P2/P3, which means the **reported `X-Signature`
passed verification** — with no database available the handler advanced past the signature gate and
only then failed on the read. Reproduced locally, the request took **0.079 s** (P1), **0.014 s** (P2)
— three orders of magnitude slower than the tester's `0.000135 s`.

**What the endpoint would have answered had the delivery actually arrived** (dev database is
reachable, and §8 shows the reference resolves with an exactly matching amount):

```
HTTP 200  {"success":true,"data":{"message":"Pembayaran berhasil diselesaikan."}}
```

**504 / 0 / `false` is therefore not a status this route can emit under any input.**

---

## 5. CONTENT-TYPE HANDLING — CORRECT FOR `application/x-www-form-urlencoded`

| Question | Answer |
|---|---|
| Does the route read the body as JSON first? | **No.** `request.text()` only (`route.ts:52`). There is no `request.json()` anywhere in the chain |
| Is `application/x-www-form-urlencoded` supported? | **Yes** — parsing is `new URLSearchParams(rawBody)` (`ipaymu.ts:1215`, `gateway.ts:779`, `webhook.ts` rejection path). Content-Type is never branched on, and never needs to be |
| Is the exact information required for signature verification preserved? | **Yes.** The signature is computed over the **exact raw bytes** as received. `request.formData()` would have lost the bytes; `request.json()` would have thrown on this body; `request.text()` + `URLSearchParams` is the only combination that preserves both the bytes *and* the field values |
| Would a JSON callback also work? | Not for signature purposes — but that is not the provider's contract. iPaymu posts form-urlencoded, which is what arrives and what is handled |

---

## 6. SIGNATURE VERIFICATION vs THE iPAYMU CALLBACK CONTRACT

### 6.1 Implementation vs contract

| Contract element | Implementation | Verdict |
|---|---|---|
| Signature location | Header **or** body field, header first, exactly one checked | ✅ (`route.ts:48`, `ipaymu.ts:1234`) |
| Remove `signature` before hashing | `delete raw.signature` before canonicalisation | ✅ (`ipaymu.ts:1235`) |
| Alphabetical key sort | `phpKsort` (`localeCompare`, A–Z) | ✅ (`ipaymu.ts:1124`) |
| Type normalisation | `trx_id`, `status_code`, `transaction_status_code`, `paid_off` → int; `is_escrow` → bool; `additional_info` → array; `additional_info` defaulted in when absent; everything else → string | ✅ (`ipaymu.ts:1085`) |
| JSON serialisation + slash escaping | `JSON.stringify` then `/` → `\/` (PHP `json_encode` parity) | ✅ (`ipaymu.ts:1147`) |
| HMAC-SHA256 | `crypto.createHmac("sha256", VA)` | ✅ (`ipaymu.ts:1167`) |
| **Merchant VA as the secret** | `getIpaymuConfig().va` | ✅ — **proven for this exact payload in §6.2** (the API key does **not** reproduce it) |
| Timing-safe comparison | `crypto.timingSafeEqual` after a length check | ✅ (`ipaymu.ts:1250-1267`; compare at `:1260`) |
| Fail-closed | missing signature → `MISSING_SIGNATURE` ⇒ 401; unconfigured VA → `NOT_CONFIGURED` ⇒ **500, never a fall-through** | ✅ (`gateway.ts:858`) |
| `X-Timestamp` | **not verified** — see §7 | ⚠️ accepted as-is (design-sanctioned relaxation, §31.6 item 1) |
| `X-External-ID` | **not used** | ⚠️ informational only |

### 6.2 The signature input for THIS callback, derived

Nine candidate canonicalisation schemes were computed and compared against the received signature
(the merchant VA and the transaction VA are **not printed**):

| # | Candidate | Match? |
|---|---|---|
| **A** | **typed normalise + ksort + `JSON.stringify` + slash-escape, secret = configured VA** | **✅ MATCH** |
| B | same, without slash escaping | no |
| C | all values kept as strings | no |
| D | same as A but secret = **API key** | no |
| E | HMAC over the raw urlencoded body | no |
| F | raw-string ksort, escaped | no |
| G | canonical JSON with the `va` field removed | no |
| H | canonical JSON with `va` + `url` removed | no |

**Exact serialised string used (VA-derived values masked; real length 667 bytes):**

```
{"additional_info":[],"amount":"15000","buyer_email":"dodi@gmail.com","buyer_name":"dodi","buyer_phone":"085793822395","channel":"bni","created_at":"2026-09-20 15:50:02","expired_at":"2026-09-20 16:50:02","fee":"3500","is_escrow":false,"paid_at":"2026-09-20 15:51:44","paid_off":11500,"payment_no":"<VA-number-MASKED>","reference_id":"EVT-1789894187056-ef2c2a78","settlement_status":"settled","sid":"EVT-1789894187056-ef2c2a78","status":"berhasil","status_code":1,"sub_total":"15000","system_notes":"Sandbox notify","total":"15000","transaction_status_code":1,"trx_id":233592,"url":"http:\/\/localhost:3000\/api\/ticketing\/payment\/webhook","va":"<VA-number-MASKED>","via":"va"}
```

| | |
|---|---|
| Normalized object / sorted keys | as above — typed values, keys ascending |
| Secret source | `IPAYMU_SANDBOX_VA` (`PAYMENT_ENVIRONMENT=sandbox`) — **configured: yes**, **length: 16**, digits-only: true — **value never printed** |
| Computed signature | `449631ce4bdee77146521514989f70cba5d979a127fb88217c02eec51e50abd2` |
| Received signature | `449631ce4bdee77146521514989f70cba5d979a127fb88217c02eec51e50abd2` |
| **Match** | **YES** |
| API key configured / length | yes / 43 — and it is **not** the secret (candidate D fails) |

**Conclusion:** the reported `X-Signature` is a **valid** signature under this platform's
implementation. iPaymu's signer and `verifyWebhookSignature` agree on the algorithm, the secret and
the canonicalisation, **byte for byte** — independently reproduced end-to-end by live probe **P1**
(§4), where the same signature was accepted by the running endpoint.

**Note on the payload's `va` field:** it carries `000094444106` — the **per-transaction** VA /
`payment_no` for that sandbox BNI payment — which is **not** the configured merchant VA (16 digits).
It is part of the signed payload but irrelevant to verification, and it confirms the callback was
generated from a **real sandbox transaction**, not a hand-written fixture.

---

## 7. HEADER HANDLING

| Header | Behaviour | Assessment |
|---|---|---|
| `X-Signature` | read (case-insensitive), the only cryptographically meaningful credential | ✅ correct |
| `X-Timestamp` | **ignored** — no freshness window is enforced | ⚠️ **informational, not a live risk here** |
| `X-External-ID` | **ignored** | ⚠️ informational |

On `X-Timestamp`: a replay of a byte-identical, correctly-signed delivery is **already harmless** —
`providerEventId` is `@unique`, the row is `PROCESSED`, and the replay path returns
`DUPLICATE` / `200` **with no mutation** (`webhook.ts:186`, `blocksReprocessing`). A freshness window
would be defence in depth against replaying *a delivery whose ledger row was later deleted*, which
nothing does. It is recorded here as a contract question for a later phase, **not** as a defect
introduced or aggravated by this callback.

---

## 8. PAYLOAD FIELD-TYPE HANDLING FOR THIS REAL CALLBACK

| Field | Arrives as (form-encoded) | Handled as | Result |
|---|---|---|---|
| `trx_id` | `"233592"` | `int` 233592 | ✅ `providerTransactionId` |
| `status_code` | `"1"` | `int` 1 → `Status` 200 | ✅ → **success** |
| `transaction_status_code` | `"1"` | `int` 1 | ✅ fallback classification input |
| `paid_off` | `"11500"` | `int` 11500 | ✅ (informational; not used as the paid amount) |
| `is_escrow` | `"false"` | `bool` false | ✅ |
| `additional_info` | `"[]"` | `[]` | ✅ |
| `amount` | `"15000"` | decimal string `15000.00` | ✅ (not preferred — see next) |
| `total` | `"15000"` | string | ✅ |
| **`sub_total`** | `"15000"` | decimal string `15000.00` | ✅ **preferred** for the amount check |
| `payment_no` | `"000094444106"` | string | ✅ preserved verbatim |
| `va` | `"000094444106"` | string | ✅ preserved verbatim |
| `fee` | `"3500"` | decimal string `3500.00` | ✅ recorded as a provider *fact* only |
| `status` | `"berhasil"` | string | ✅ → **success** (string branch, `ipaymu.ts:964`) |

`via`/`channel` (`va`/`bni`) are used for the channel record only. **No field is trusted as money**
except `sub_total`/`amount`, and only against `EventOrder.total`.

---

## 9. ORDER AND PAYMENT MATCHING (READ-ONLY)

### 9.1 `reference_id` → existing order

```
Payment.paymentReference = EVT-1789894187056-ef2c2a78   →  FOUND
  status                  : PENDING
  amount                  : 15000
  method / channel        : VIRTUAL_ACCOUNT / bni          ← matches the callback's via=va / channel=bni
  providerEnvironment     : SANDBOX                        ← matches PAYMENT_ENVIRONMENT=sandbox
  externalSessionId set   : yes
  order.orderNumber       : EVT-1789894187056-ef2c2a78
  order.status            : PENDING_PAYMENT
  order.paymentStatus     : PENDING
  order.total             : 15000                          ← matches sub_total "15000" EXACTLY
  order.currency          : IDR
  order.paidAt            : (null)
  order.expiresAt         : 2026-09-20T09:19:47.056Z (16:19:47 WIB)
```

The `EVT-` namespace guard (`webhook.ts:303`, `isTicketingReference`) passes.

### 9.2 Resulting decision path (had the delivery arrived)

| Gate | Result |
|---|---|
| Reference resolves to **our own** `Payment` row | ✅ |
| Amount: `sub_total 15000` vs `order.total 15000` | ✅ **MATCH** (not `ABSENT`, not `MISMATCH` — so **no 400**) |
| `isRefund` (no field contains "refund") | ✅ false — payment notification, not the manual-refund rail |
| Verdict | **`PAID`** (`status: "berhasil"` / `status_code: 1`) |
| Settlement CAS | would succeed: the order is `PENDING_PAYMENT` and the predicate excludes only `CANCELLED`/`EXPIRED`. **No `expiresAt` check exists in the CAS** |
| Reservation | `HELD`, quantity 1, and `confirmReservation` requires only `reserved >= quantity` — **no expiry predicate** |
| Ledger | INSERT `webhookevent` → `PROCESSED / settled` |

### 9.3 Current authoritative state (this is a real, unsettled payment)

```
order.status                 : PENDING_PAYMENT     order.paymentStatus : PENDING
order.paidAt                 : (null)              tickets for order   : 0
reservations                 : 1 × HELD (expires 2026-09-20T09:19:47Z)
paymentTransactions          : []                  webhook rows        : []
now                          : 2026-09-20T08:59:05Z   expired now?     : false
```

**The money was genuinely paid at iPaymu sandbox** (`paid_at 2026-09-20 15:51:44`, `settlement_status:
settled`, `status: berhasil`) **while the platform still holds the order unpaid.** This is a real
provider-paid / platform-unsettled divergence — in the sandbox, but the same shape a production
missed callback would take.

---

## 10. GATE-BY-GATE REJECTION ANALYSIS (A–L, as requested)

| Gate | Verdict for this delivery |
|---|---|
| **A. Content-Type** | **NOT a gate.** Not branched on; `application/x-www-form-urlencoded` is what the code handles |
| **B. Body parsing** | **NOT a gate.** `request.text()` + `URLSearchParams`; reproduced live in P1 |
| **C. Signature** | **NOT a gate — passed.** Derived (§6.2) *and* accepted by the live endpoint (P1 vs P2/P3) |
| **D. Timestamp** | **NOT evaluated** — no freshness check exists (by design, §7) |
| **E. Schema** | **NOT a gate.** All fields classify correctly (§8) |
| **F. Order lookup** | **NOT a gate.** The reference resolves in the application database (§9.1) |
| **G. Payment lookup** | **NOT a gate.** The `Payment` row exists, `PENDING`, sandbox, matching channel |
| **H. Amount mismatch** | **NOT a gate.** `sub_total 15000 == order.total 15000` |
| **I. Payment state** | **NOT a gate.** `PENDING` is payable; the CAS predicate accepts it |
| **J. Idempotency** | **NOT a gate.** No prior row for `trx 233592`; `claimed` would be the first |
| **K. Settlement** | **NOT reached** — but nothing there would have refused it (§9.2) |
| **L. Response serialisation** | **NOT a gate.** The envelope is the only shape produced (§3, §4) |
| **★ The actual gate** | **the request never arrived.** `localhost` is not an address iPaymu can route to (§11) |

---

## 11. EXACT ROOT CAUSE

### 11.1 Where the notify URL comes from

| File / symbol | Behaviour |
|---|---|
| `lib/ticketing/payment/service.ts:541` | `const notifyUrl = \`${origin}/api/ticketing/payment/webhook\`` |
| `lib/app-origin.ts` `getAppOrigin()` | returns `process.env.NEXT_PUBLIC_APP_URL` **verbatim** when it is set and absolute |
| `.env` | `NEXT_PUBLIC_APP_URL=http://localhost:3000` |
| ⇒ effective `notifyUrl` | **`http://localhost:3000/api/ticketing/payment/webhook`** |

`lib/payment/config.ts` refuses a **production** config whose `NEXT_PUBLIC_APP_URL` contains
`localhost` / `127.0.0.1` / `sandbox` — but `PAYMENT_ENVIRONMENT=sandbox`, so that guard does **not**
apply and a loopback notify URL is accepted. That is the configuration trap this callback fell into.

### 11.2 Independent confirmation from the payload itself

iPaymu echoes the notify URL it was given back in the callback body:

```
"url": "http://localhost:3000/api/ticketing/payment/webhook"
```

That value **is** our `notifyUrl`, produced by `service.ts:541` — so the provider was told to call a
loopback address. `http://localhost:3000` resolves inside **iPaymu's own** network, where nothing is
listening, so the connection is refused immediately: `Response Code: 0`, `Response Time: 0.000135 s`,
`Response: false`.

### 11.3 The exact statement

> **ROOT CAUSE — CONFIGURATION, NOT CODE.**
> The `notifyUrl` registered with iPaymu is a **loopback address**
> (`http://localhost:3000/api/ticketing/payment/webhook`, from `NEXT_PUBLIC_APP_URL` via
> `lib/ticketing/payment/service.ts:541`). iPaymu's callback is issued server-to-server from the
> provider's own infrastructure, where `localhost` is **not** this application, so the delivery is
> refused at connect time and never reaches `app/api/ticketing/payment/webhook/route.ts`.
> iPaymu's tester reports that refusal as `Response: false` / `Response Code: 0`.
> **Nothing in this application refused the callback, and nothing in it can return the body `false`.**

Supporting evidence, independent of one another: (i) the payload's own `url` field; (ii) **zero**
ledger rows for this delivery, when every delivered non-413 request leaves a row; (iii) the tester's
0.135 ms response time vs our measured 6–79 ms; (iv) source search showing no `false`-returning
response path; (v) a live probe answering the envelope for all four outcomes.

---

## 12. WHAT DID *NOT* HAPPEN

| Question | Answer | Evidence |
|---|---|---|
| Was the payment settled? | **NO** | order `PENDING_PAYMENT`, `paidAt: null`, `paymentTransactions: []` |
| Did the order become `PAID`? | **NO** | `order.paymentStatus = PENDING` |
| Were tickets issued? | **NO** | `ticket` count for the order = `0` (and issuance is buyer-triggered, never webhook-side) |
| Was any ledger row written? | **NO** | 0 rows for the order / `trx 233592`; the only row in the table is the 2026-09-19 test fixture |
| Did any payment business rule, signature rule or settlement authority change? | **NO** | no source file touched |
| Was the money actually paid at the provider? | **YES (sandbox)** | callback `status: berhasil`, `paid_at 15:51:44`, `settlement_status: settled` |

---

## 13. PHASE 22 WEBHOOK SECURITY CONTRACT — PRESERVED

Every control the contract requires is present in the code as audited, and this callback only
**exercised** them (it did not need to be delivered for them to be verified):

| Contract property | Status |
|---|---|
| Raw-body security (signature over exact bytes) | ✅ `route.ts:52` → `webhook.ts:384` |
| Fail-closed signature validation | ✅ 401 on missing/invalid; 500 on unconfigured — never a fall-through |
| Amount validation before any mutation | ✅ `amountVerdict` (`sub_total` preferred, `Decimal` equality) |
| Idempotent settlement | ✅ unique `providerEventId`; `P2002` ⇒ `DUPLICATE`/200, no mutation |
| `PAID` only from a verified webhook | ✅ written only inside `settleVerifiedPayment` |
| Exactly-once inventory movement | ✅ single CAS (`reserved -= q / sold += q`) in one transaction |
| No browser-controlled payment success | ✅ return/poll surfaces never mutate (`readPaymentState` is read-only) |
| No weakening of webhook authentication | ✅ unchanged (and independently reproduced by the derived HMAC) |

**Additions found worthwhile but NOT implemented (audit-only phase):** a freshness window for
`X-Timestamp` (§7) and the reconciliation surface (§14).

---

## 14. SAFE FIX OPTIONS

Ranked. **None is implemented** in this phase.

### Option 1 — Make the notify target reachable (configuration only) — *fixes the local test*
1. Expose the dev app on a **public HTTPS origin** (a tunnel, or the VPS once deployed).
2. Set `NEXT_PUBLIC_APP_URL` to that origin and restart.
3. **Create the payment session again** (or re-run iPaymu's notification test) so the provider is
   given the new `notifyUrl`.

*Why the last step matters:* `notifyUrl` is baked into the session **when the session is created**.
An already-paid session cannot be re-pointed — its callback will keep going to `localhost`.
*Note on `lib/app-origin.ts`:* when `NEXT_PUBLIC_APP_URL` is set, `getAppOrigin()` returns it directly
and the host allowlist is **not** consulted, so a tunnel origin works without touching the allowlist.

**Bounded, reversible, no source change. This is what unblocks local sandbox testing.**

### Option 2 — Reconciliation surface (source change, required next) — *fixes the money state*
An operator-triggered, server-side pull that:
* retrieves the payment's provider state (`verifyPaymentStatus` exists and is **currently unused** —
  the capability `PAYMENT_RECONCILE` is granted but surfaced nowhere, Phase 25), and
* settles through the **same** `settleVerifiedPayment` transaction, under its own permission,
  its own audit entry and its own idempotency.

Constraints that must hold: server-side only (never browser-triggerable), provider-verified result
rather than a client claim, amount compared against `EventOrder.total`, ownership unchanged, and
**no new path to `PAID` outside a verified provider answer**.

This is the only correct recovery for **already-paid, undelivered** sessions — including the sandbox
one in §9.3, which now cannot be fixed by re-registering a URL.

### Option 3 — Guardrail (small, optional)
Refuse to create a payment session, or log a loud structured warning, when the resolved `notifyUrl`
host is a loopback/private address. Careful: refusing outright breaks the ordinary local flow, so a
warning (or a sandbox-only refusal) is the safer form. A related idea is to record the `notifyUrl`
actually sent on the `Payment` row, which would make this class of failure diagnosable without
reading application logs.

### Rejected for this defect
Adding retries, lowering signature requirements, adding a "trust the redirect" or amount-less
settlement shortcut, or accepting unsigned notifications. **None of these is implicated**: the
signature is valid, the amounts match, and the failure is a routability problem in front of the
application.

---

## 15. WHAT COULD NOT BE VERIFIED

* The **tester's own** behaviour (it is a remote, black-box tool). The refusal is inferred from the
  three reported numbers plus the absence of any ledger row; the request could not be observed
  arriving (there is nothing to observe — it did not arrive).
* The **settle** verdict was derived from code + database state, not observed: reaching it end-to-end
  would require a reachable callback URL, i.e. the very thing that is broken — or a database write,
  which this phase forbids. (The signature gate *was* observed live, in P1.)
* Whether iPaymu retries an unreachable notification, and on what schedule. If it does, the
  settlement may yet occur passively once the origin is public **and** iPaymu's retry still targets
  the old URL — which for a loopback URL it cannot.

---

## 16. SAFETY STATEMENT

| Item | Status |
|---|---|
| Source files modified | **NONE** — verified: `git diff --name-only` is **empty**, and the only untracked path is this report (`git status --porcelain`) |
| Database rows written / updated / deleted | **NONE** — all inspection was `SELECT`/`count`; the HTTP probe ran against a **non-existent** database name (readiness 503 as the guard, `Database … does not exist` in the log) |
| Migration created / applied | **NONE** |
| `prisma db push` / `migrate reset` / truncate | **NONE** |
| Provider call (outbound to iPaymu) | **NONE** — no request was made to iPaymu; the callback was inspected, not initiated |
| Production credentials touched | **NONE** — sandbox only; no secret value printed anywhere in this report or in any command output |
| Commit / push / deploy / reset / clean | **NONE** |

**Report written to:** `PHASE_27B_IPAYMU_WEBHOOK_CALLBACK_FAILURE_AUDIT.md`

---

**AUDIT COMPLETE — SOURCE CHANGE REQUIRED**
*(scoped: the delivery failure itself is configuration — see §14 Option 1; a bounded source change is
required for the reconciliation of an already-paid, undelivered session — see §14 Option 2.)*
