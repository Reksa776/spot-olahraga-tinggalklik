# PHASE 27F-LOCAL — FIX SANDBOX LOCAL CALLBACK TESTING

**Project:** TinggalKlik.Co
**Date:** 2026-09-21
**Mode:** audit first, then the smallest correct change. Local only.
**HEAD:** `8628dbf` (unchanged throughout)

---

## 1. EXECUTIVE SUMMARY

**Exact root cause:** the iPaymu SANDBOX transaction really is paid, and the platform really is
still `PENDING_PAYMENT`, because **the callback never reached the application** — there is no
source-level defect. The `notifyUrl` we handed iPaymu is a loopback address
(`NEXT_PUBLIC_APP_URL=http://localhost:3000` → `lib/ticketing/payment/service.ts:541`), and
iPaymu posts its notification **server-to-server**, so `localhost` resolves to *iPaymu's own
machine* and the connection is refused before any HTTP exchange. This is **Case A** of the
diagnosis list.

**No application source change was required, and none was made.** No file under `app/` or
`lib/` was touched.

The deliverables are the two things the phase asks for when the correct fix is operational:

1. **Documentation** — a new **§8 “Local sandbox testing (iPaymu SANDBOX)”** in `README.md`
   explaining the whole workflow, and
2. **Automated coverage** — a **sanitized, real-shape provider callback fixture** replayed
   through the *real* webhook route by a new integration suite, which proves the full
   verification → amount → reference → settlement chain against a genuine 26-field iPaymu
   payload rather than a three-field fixture.

Plus one small, clearly dev-only helper (`scripts/replay-sandbox-callback.cjs`) that replays a
captured Tes Notify request verbatim — the “prefer a replay mechanism over a business API that
accepts arbitrary payment status” option the phase allows.

**The user does NOT need to deploy to a VPS to test Sandbox.** A public HTTPS tunnel is optional,
not required.

---

## 2. THE DECISIVE EVIDENCE (why this is Case A, not B–H)

### 2.1 The webhook ledger has never seen a single real delivery

```
webhookEvent rows in the development database: 1
  └─ the only row: providerTransactionId "TRX-P8-settle-1", PROCESSED, receivedAt 2026-09-19
     (a Phase 8 test fixture)
```

Every delivered, non-oversized request writes a `WebhookEvent` row **even when the signature is
forged or the reference is unknown** (`lib/ticketing/payment/webhook.ts#recordRejectedDelivery`
and `claimLedgerRow`). So the absence of any row for `233592`, for `233707`, or for `233710` is
proof that **no callback request of any kind has ever arrived** — not a rejected one, not an
ignored one, not one with a bad signature.

### 2.2 The gates that would have left evidence, and did not

| Diagnosis | Would have left | Observed | Verdict |
|---|---|---|---|
| **B** — signature fails | a `signatureValid=false` ledger row | none | ruled out |
| **C** — reference unresolved | an `IGNORED ignored_reference_*` row | none | ruled out |
| **D** — amount mismatch | an `IGNORED rejected_amount_mismatch` row | none | ruled out |
| **E** — status mapping rejects | an `IGNORED ignored_unknown_status` row | none | ruled out |
| **F** — settlement refuses state | a ledger row (any outcome) | none | ruled out |
| **A** — callback never delivered | **nothing at all** | **nothing at all** | **✔ the cause** |
| G — stale UI | DB disagrees with the page | DB *is* `PENDING_PAYMENT` | not the cause (the page is truthful) |
| H — other | — | — | none found |

### 2.3 The provider’s own notify URL is echoed back in its payload

The Phase 27B callback payload’s `url` field is
`http://localhost:3000/api/ticketing/payment/webhook` — the exact string produced by
`lib/ticketing/payment/service.ts:541` and sent to iPaymu when the session was created. The
provider received our loopback address and, correctly, could not call back to it.

### 2.4 The webhook itself is correct — the real signature verifies byte-for-byte

Re-derived locally from the exact Phase 27B payload (reconstructed as iPaymu sends it,
`application/x-www-form-urlencoded`) using the project’s own canonicalisation
(`normalizeCallbackBody` → `sort` → `JSON.stringify` → slash-escape) and the configured sandbox
VA:

```
VA configured: true   (length only — value never printed)
computed : 449631ce4bdee77146521514989f70cba5d979a127fb88217c02eec51e50abd2
received : 449631ce4bdee77146521514989f70cba5d979a127fb88217c02eec51e50abd2
MATCH    : true
```

So a replayed Tes Notify request **passes** verification; nothing in the verifier needs changing.

---

## 3. WHY THE LOCAL ORDER STAYS PENDING — in one line

`Ticket checkout → create EventOrder → POST /api/ticketing/orders/[n]/pay → notifyUrl =
http://localhost:3000/... → iPaymu stores it → buyer pays in SANDBOX → iPaymu tries to POST the
callback to localhost (i.e. to *itself*) → connection refused → platform never hears about the
money → order stays Menunggu Pembayaran.`

The order state is **honest**: the platform has no provider-verified evidence that the money
arrived, and design §31.5 rule 3 forbids treating a browser return or a dashboard screenshot as
PAID.

---

## 4. THE CORRECT LOCAL WORKFLOW (documented, not invented here)

1. Sandbox does **not** require a verified IP/domain.
2. `localhost` is a valid local application environment.
3. iPaymu’s **callback server cannot reach `localhost`** — the one broken link.
4. Use Sandbox **“Tes Notify”**, which generates a real callback request for the transaction.
5. **Copy the exact request** (raw form-urlencoded body + the `X-Signature` value).
6. **POST it to `http://localhost:3000/api/ticketing/payment/webhook`** — via
   `scripts/replay-sandbox-callback.cjs` or `curl --data-binary`.
7. **Do not edit the payload or the signature.**
8. The local webhook runs the **real** HMAC + amount + reference + ledger + settlement chain, so
   a successful replay is a genuine settlement.
9. A public HTTPS tunnel is **optional** for fully automatic callback testing.

Full text: `README.md` §8.

---

## 5. IMPLEMENTATION

### 5.1 Did source code require modification?

**No.** Nothing under `app/` or `lib/` changed; no schema, no migration, no config. The webhook,
the settlement engine, the payment service and the reconciliation path are byte-identical to the
Phase 27E baseline.

### 5.2 Files changed

| File | Status | Why |
|---|---|---|
| `README.md` | modified | New **§8 “Local sandbox testing (iPaymu SANDBOX)”** — the operational contract. |
| `__tests__/ticketing-payment/sandbox-callback-fixture.ts` | **new** | Sanitized, real-shape captured provider callback (26 fields), as a field set re-signed at run time so no credential is committed. |
| `__tests__/ticketing-payment/sandbox-callback-replay.test.ts` | **new** | 7-case integration suite replaying that payload through the real route. |
| `scripts/replay-sandbox-callback.cjs` | **new** | Dev-only helper that posts a captured callback verbatim to the local webhook. |
| `PHASE_27F_LOCAL_SANDBOX_CALLBACK_TESTING_REPORT.md` | **new** | This report. |

### 5.3 Why the fixture is a *field set* and not a signed body

The provider signs with the merchant VA, which is a credential, and a committed signature would
be keyed to that VA and unreproducible anyway. The fixture keeps the **shape** — the exact field
names and value types (`trx_id`/`status_code`/`transaction_status_code`/`paid_off` numeric,
`is_escrow=false`, `additional_info=[]`, slash-bearing `url`) — and the test re-signs it with the
configured VA via the platform’s own helpers.

That is the value of this fixture: `normalizeCallbackBody` has four type special-cases and a
slash-escape step, and the existing thin `signedCallback` helper (used by the big webhook suite)
sends only `reference_id`/`status_code`/`sub_total`/`trx_id`/`fee`/`via`/`channel`. A regression
in the other branches would pass every thin test and still reject every **real** delivery as
`INVALID_SIGNATURE` — silently, because the provider only sees a 401 and retries.

### 5.4 The dev-only helper

`scripts/replay-sandbox-callback.cjs`:

* takes the raw body from `--body-file` or stdin and posts it **byte-for-byte**;
* passes the signature as the `X-Signature` header when given, otherwise relies on the body’s
  own `signature` field (exactly the two places the verifier reads);
* **refuses to run when `NODE_ENV=production`**, and warns loudly if the target is not loopback;
* has no write path — it does not sign, does not edit, does not touch the database. It cannot
  bypass the webhook because the webhook is what it calls.

It is not imported by the application, is not in the Next.js build, and exposes no route.

---

## 6. THE REPLAY TEST — WHAT IT PROVES

`__tests__/ticketing-payment/sandbox-callback-replay.test.ts` (7 cases, all green):

| # | Case | Assertion |
|---|---|---|
| R1 | the fixture still carries the provider’s full field set | guards the fixture against silent shrinkage; numeric/boolean/array typing present |
| R2 | a captured-shape callback with a valid signature settles through the **real route** | 200 · order `PAID`/`PAID`/`paidAt` set · one payment row `PAID` · exactly one `PaymentTransaction` with the provider’s `trx_id` · reservation `CONVERTED` · **0 tickets** · ledger `PROCESSED`/`signatureValid=true` with the **redacted** payload (buyer email absent) |
| R3 | byte-identical replay is idempotent | second 200, counters/money unchanged, still exactly one `PaymentTransaction` and one reservation |
| R4 | amount mismatch | **400**, zero state change, ledger `IGNORED rejected_amount_mismatch` |
| R5 | unknown reference | **200** acknowledged, order untouched, no transaction |
| R6 | optional fields (`additional_info`, `is_escrow`) omitted | still verifies and settles — the normalizer’s defaults hold |
| R7 | unsigned replay at the handler seam | **401 `REJECTED_SIGNATURE`**, order untouched — there is no localhost/dev exemption |

The R2 amount is *not* overridden: the fixture’s captured `sub_total` (`15000`) is compared
against a real order whose total is exactly `15000.00`, so the happy path runs on the payload as
captured.

---

## 7. LIVE SANDBOX TEST

**Not performed — and the reason is not a skip.** The phase’s live procedure requires two
*provider-dashboard* actions that cannot be driven from this codebase:

* **“simulate successful payment”** in the iPaymu SANDBOX dashboard, and
* **“Tes Notify”** to generate the callback request,

and then it requires a **reachable notify URL** for the automatic delivery — the very thing that
does not exist locally. Creating a new sandbox payment without being able to simulate or notify
would only strand another `PENDING_PAYMENT` row, which the phase explicitly warns against
(“do not create a second payment if the first callback test fails”).

What *was* done instead, without any provider call and without any database write:

* the **real captured signature was re-derived and verified** against the live sandbox VA
  (§2.4) — so the provider’s signer and our verifier agree;
* the **real route was exercised live** on a production build (§9);
* the **whole chain is proven by the integration suite** (§6).

**Payment state before and after this phase — unchanged:**

```
EVT-1789965890566-5857a72f  payment PENDING  order PENDING_PAYMENT  paidAt null  trx 0  tickets 0  reservation HELD
EVT-1789965401569-f6713b4f  payment PENDING  order PENDING_PAYMENT  paidAt null  trx 0  tickets 0  reservation HELD
EVT-1789894187056-ef2c2a78  payment PENDING  order PENDING_PAYMENT  paidAt null  trx 0  tickets 0  reservation HELD
webhookEvent rows: 1 (unchanged)
```

> Note for the operator: the two 2026-09-21 sessions **do** carry a persisted
> `providerTransactionId` (`233710`, `233707`), so they can be settled either by replaying their
> Tes Notify request or through the operator reconciliation path. `233592`
> (`EVT-1789894187056-ef2c2a78`) predates that column, so it is **`BLOCKED /
> PROVIDER_TRANSACTION_ID_MISSING`** for reconciliation — it must be replayed, or left as-is.

**Old transaction 233592 — unchanged:** payment `PENDING`, `providerTransactionId` NULL, 0
`PaymentTransaction`, reservation still `HELD`, 0 tickets, 0 webhook events. It was **not**
settled, and its callback was deliberately **not** replayed against the live server (the phase
requires it to remain unchanged).

---

## 8. VERIFICATION MATRIX

| Check | Result |
|---|---|
| `npx prisma validate` | **valid** |
| `npx prisma migrate status` | **Database schema is up to date!** (24 migrations) |
| `npx tsc --noEmit` | **clean** (exit 0) |
| `npx eslint .` | **0 errors / 3 warnings**, all 3 pre-existing `<img>` warnings in `app/e/[slug]/page.tsx` and `components/events/EventCard.tsx`; no new warning |
| focused `__tests__/ticketing-payment` | **139/139, 8/8 suites** |
| full `npm test -- --runInBand` | **1878/1878, 88/88 suites** |
| baseline comparison | Phase 27E was **1871/1871 (87 suites)** → **+1 suite, +7 tests**, **0 regressions**; the known Phase 27 H1 `payment-races` flake did **not** fire this run |
| `npm run build` | **succeeded** (all routes compiled) |

### Live HTTP (production build, port 3100, non-mutating probes)

| Request | Result |
|---|---|
| `GET /api/health` | **200** |
| `POST /api/ticketing/payment/webhook` with a 200 KB body | **413** `{"success":false,"code":"INVALID_WEBHOOK","message":"Payload terlalu besar."}` — refused by the body bound **before** any ledger write |
| `GET /api/ticketing/payment/webhook` | **405** |

The deeper webhook assertions (settlement, idempotency, amount/reference gates) are covered by
the integration suite against the real database, because exercising them live would have written
to the development database — which this phase forbids.

---

## 9. DATABASE SAFETY

* **No DB reset, no `prisma db push`, no `prisma migrate reset`, no migration created or
  applied.** `prisma migrate status` reports up to date.
* **No row created, updated or deleted.** Every read in this phase was `SELECT`/`count`. The
  three tracked payments and the single `WebhookEvent` row are byte-identical before and after.
* The 200 KB live probe returns **before** the ledger insert by construction (the body bound is
  step 1 of `handleGatewayWebhook`), so it wrote nothing.

## 10. GIT / DEPLOYMENT SAFETY

* **No commit. No push. No `git reset`. No `git clean`.** `HEAD` is still `8628dbf`.
* **Nothing was staged.** `README.md` shows `MM` because it was *already* staged by the Phase 26B
  baseline and now also carries this phase’s unstaged edit; the three new files are untracked.
  *(Owner action, if desired: `git add README.md __tests__/ticketing-payment/sandbox-callback-fixture.ts
  __tests__/ticketing-payment/sandbox-callback-replay.test.ts scripts/replay-sandbox-callback.cjs` —
  not done here.)*
* **No deployment. No VPS access. No production credentials. No provider payment call of any kind.
  No cron/scheduler installed.**

---

## 11. SECURITY REVIEW — WHAT WAS *NOT* DONE

Explicitly rejected and absent from this change:

* ✗ a `/api/dev/mark-paid` (or any dev-only) settlement endpoint;
* ✗ a `?status=paid` / `transactionId`-in-body settlement path;
* ✗ any client-side PAID mutation;
* ✗ an unsigned webhook path, or disabled signature validation;
* ✗ a localhost bypass in webhook authentication;
* ✗ an amount bypass or environment-based PAID shortcut;
* ✗ any manual `UPDATE Payment SET PAID` / `UPDATE EventOrder SET PAID`.

The replay helper does not weaken any of this: it calls the same canonical webhook, which still
verifies the HMAC over the exact bytes, the amount against `EventOrder.total`, the reference
against our own `Payment`, and the replay ledger — and enters the same
`settleVerifiedPayment()` transaction. Production webhook behaviour is **semantically
unchanged**; no runtime file under `app/` or `lib/` was modified.

---

## 12. REMAINING ISSUES

1. **The live sandbox end-to-end run still needs one human step** (§7): simulate the payment in
   the iPaymu dashboard and copy the Tes Notify request, then run the replay. This is inherent to
   sandbox + localhost and is now documented.
2. **`notifyUrl` is still loopback in local sandbox sessions.** Phase 27B’s bounded suggestion —
   warn (or refuse) in sandbox when the resolved notify URL host is loopback, and persist the
   sent `notifyUrl` on the `Payment` row — remains a *proposed* change, deliberately **not**
   implemented here because it alters runtime behaviour beyond this phase’s “operational fix”
   scope. It is a good candidate for a later, owner-approved phase.
3. **`233592` is unrecoverable via reconciliation** (no persisted provider transaction id, by
   design — no back-fill). It can only be settled by replaying its callback.
4. **No manual webhook-replay UI** — deliberate (README §7). The replay helper is a developer
   tool; the operator path is reconciliation.
5. `scripts/test-ipaymu-sandbox.js` still reads legacy env names (`IPAYMU_API_KEY`/`IPAYMU_VA`)
   and is unrelated to this change — left untouched.

---

## 13. FINAL VERDICT

**AUDIT COMPLETE — SOURCE CHANGE NOT REQUIRED (operational fix); DOCS + TEST COVERAGE ADDED**

* Exact root cause: **Case A** — iPaymu’s server-to-server callback cannot reach a loopback
  `notifyUrl`, so the delivery never arrives; proven by zero `WebhookEvent` rows and a
  byte-for-byte signature match.
* Source code required modification: **no** — no `app/`/`lib/`/schema change.
* Live Sandbox payment: **not created** (its dashboard-simulation steps cannot be performed from
  the codebase) — **no provider call made, no database row changed**.
* No commit, no push, no reset, no clean, no deploy, no DB reset, no `db push`, no destructive
  data change.
