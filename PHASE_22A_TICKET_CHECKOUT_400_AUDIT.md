# PHASE 22A — TICKET CHECKOUT 400 AUDIT

**Type:** AUDIT ONLY — read-only. No source, schema, migration, or data was modified.
**Repository:** `/home/reksa/tinggalklik` · branch `main` · HEAD `107d5f6` (`fix workflow pencairan pic`)
**Date of audit:** 2026-09-25

---

## 1. Incident

A customer on the live deployment `https://tinggalklik.demosolusisejalan.my.id/e/futsal-rizky`
pressed the purchase action. The browser sent:

| Property | Value |
|---|---|
| Method / path | `POST /api/ticketing/checkout` |
| `Content-Type` | `application/json` |
| `Content-Length` | `214` |
| `Idempotency-Key` | `f6f27aa3-9ffc-495c-b862-b60c8bf241e4` (present) |
| `Origin` / `Referer` | `https://tinggalklik.demosolusisejalan.my.id` (same-origin) |
| Browser | Firefox 155 on Linux, HTTP/3 via Cloudflare |
| Session | cookie present (authenticated) |

The response was **HTTP 400** with the JSON message:

> `"Data yang dikirim tidak valid."`

That sentence is the **registry default message for `VALIDATION_ERROR`** —
`lib/api/errors.ts` → `DEFAULT_MESSAGE.VALIDATION_ERROR`. It is emitted only when the
failure is constructed *without* a custom message, which is exactly what
`validationError()` (`lib/api/response.ts:181`) does. This single fact already narrows the
fault to the **Zod parse of the checkout body**, and rules out every other 400-producing
branch of the route, each of which supplies its own distinct message (§5, §6).

---

## 2. Exact Browser Request Contract

The request is built in exactly one place: `components/events/TicketPurchaseForm.tsx`,
`submit()` → `fetch("/api/ticketing/checkout", …)` at **lines 180–195**:

```ts
const response = await fetch("/api/ticketing/checkout", {
    method: "POST",
    headers: {
        "content-type": "application/json",
        "Idempotency-Key": pendingIntent.current.key,
    },
    body: JSON.stringify({
        eventId,
        items,
        buyerName: buyerName.trim(),
        buyerEmail: buyerEmail.trim(),
        buyerPhone: buyerPhone.trim(),
        shareToken: shareToken?.trim() || null,   // ← line 192
    }),
});
```

There is **no** checkout hook, helper, or client-side Zod schema on this path — the form
constructs the body inline and sends it directly. No other component POSTs to
`/api/ticketing/checkout` (the only other purchase affordance, `StickyBuyBar`, is a plain
anchor to `#beli`). `shareToken` originates from the page's `?pic=` search param:

- `app/e/[slug]/page.tsx`: `const { pic } = await searchParams;` → passed as
  `shareToken={pic}` to `TicketPurchaseForm`.
- The reported URL `/e/futsal-rizky` carries **no query string**, so `pic` is `undefined`.

---

## 3. Frontend Payload

For `/e/futsal-rizky` with no `?pic=`, the body actually sent is:

```json
{
  "eventId": "<event cuid>",
  "items": [{ "ticketTypeId": "<ticketType cuid>", "quantity": <number> }],
  "buyerName": "<trimmed string>",
  "buyerEmail": "<trimmed string>",
  "buyerPhone": "<trimmed string>",
  "shareToken": null
}
```

Field-by-field evidence:

| Field | Source | Actual type sent | Notes |
|---|---|---|---|
| `eventId` | prop `eventId` (`app/e/[slug]/page.tsx` passes `event.id`) | string (**cuid ID, not slug**) | correct |
| `items` | `Object.entries(quantities)` → `.filter(q > 0)` | array of objects, min 1 | numbers, sorted only for the idempotency signature |
| `items[].ticketTypeId` | object key of `quantities` (`type.id`) | string (**cuid ID**) | correct |
| `items[].quantity` | `Record<string, number>` state | **real JSON number** | `JSON.stringify` never coerces to string |
| `buyerName` | `buyerName.trim()` | non-empty string | client-side required input |
| `buyerEmail` | `buyerEmail.trim()` | string | client-side required input |
| `buyerPhone` | `buyerPhone.trim()` | string | client-side required input |
| **`shareToken`** | `shareToken?.trim() \|\| null` | **`null` (present key, JSON `null`)** | **← the failure** |

Key properties of the payload:

- **`shareToken` is ALWAYS present as a key.** Because `shareToken` is `undefined` on this
  URL, `undefined?.trim()` → `undefined`, and `undefined || null` → `null`. `JSON.stringify`
  serialises an own property whose value is `null` as `"shareToken":null`. It is *not*
  omitted.
- `couponCode` is **not** sent at all (the form has no coupon input).
- No `price`/`subtotal`/`total`/`currency`/`organizerId`/`userId`/`status` is sent.
- No `notes`, no table/context fields exist in this form.
- No field is conditionally omitted. The one conditional expression in the body —
  `shareToken?.trim() || null` — *guarantees* a concrete value rather than omission.

`Content-Length: 214` is consistent with this seven-key body. The literal
`,"shareToken":null` is 18 bytes; without it the observed body would have been ~196 bytes.
(This is corroboration only — the buyer's own name/email/phone lengths are unknown.)

---

## 4. Backend Expected Payload

The authoritative schema is `checkoutRequestSchema` in
`lib/ticketing/checkout-validation.ts` (lines 61–84):

```ts
export const checkoutRequestSchema = z.object({
    eventId: z.string().trim().min(1).max(64),
    items: z.array(checkoutItemSchema).min(1).max(50),
    buyerName: nameSchema,                                  // string trim 1..120
    buyerEmail: emailSchema,                                // string trim email max 200
    buyerPhone: phoneSchema,                                // string trim 7..20, /^[0-9+\-\s()]+$/
    couponCode: z.string().trim().min(1).max(64).optional(),
    shareToken: z.string().trim().min(1).max(128).optional(),   // ← line 82
});
```

`z.object` without `.strict()` → unknown keys are **stripped**, not rejected, so extra keys
cannot cause a 400. Every declared key is optional-or-required as shown; **`shareToken` is
declared `.optional()`, which in Zod means `string | undefined` — it does NOT admit `null`.**

### Frontend-sends vs backend-expects

| Field | Frontend sends | Backend expects | Match? | Evidence |
|---|---|---|---|---|
| `eventId` | string (cuid id) | `z.string().trim().min(1).max(64)` | ✔ | `TicketPurchaseForm.tsx:187`; `checkout-validation.ts:62` |
| `items` | array ≥ 1 | `z.array(...).min(1).max(50)` | ✔ | `TicketPurchaseForm.tsx:188`; `checkout-validation.ts:70` |
| `items[].ticketTypeId` | string (cuid) | `z.string().trim().min(1).max(64)` | ✔ | `checkout-validation.ts:50` |
| `items[].quantity` | number | `z.number().int().positive().max(10000)` | ✔ | `checkout-validation.ts:57` |
| `buyerName` | non-empty string | `z.string().trim().min(1).max(120)` | ✔ | `checkout-validation.ts:43` |
| `buyerEmail` | string | `z.string().trim().email().max(200)` | ✔ | `checkout-validation.ts:44` |
| `buyerPhone` | string | `z.string().trim().min(7).max(20).regex(...)` | ✔ | `checkout-validation.ts:45` |
| `couponCode` | **not sent** | optional string | ✔ (absent) | `checkout-validation.ts:80` |
| **`shareToken`** | **`null`** (explicitly present) | **`z.string()…optional()` = `string \| undefined`** | **✘ MISMATCH** | `TicketPurchaseForm.tsx:192` vs `checkout-validation.ts:82` |

Note the internal inconsistency that proves this is drift rather than intent: **every
downstream consumer accepts `null`** —
`lib/pic/attribution.ts:42` (`shareToken: string | null | undefined`),
`lib/ticketing/idempotency.ts:72` (`shareToken?: string | null`),
`lib/ticketing/checkout.ts:281/492/549` (`request.shareToken ?? null`). Only the boundary
schema refuses `null`. The service layer was written for the frontend's representation; the
schema was not.

---

## 5. Exact Validation Failure

**Exact failing field:** `shareToken` (top-level body key).
**Exact failing condition:** Zod `invalid_type` — the value is `null`, the schema requires a
string; `.optional()` permits only `undefined`.
**Exact error:** `"Invalid input: expected string, received null"` at path `["shareToken"]`.

Reproduced against the project's own Zod (**v4.4.3**, from `node_modules`) using a
verbatim copy of the schema and a verbatim copy of the browser body:

```
success = false
[
  {
    "expected": "string",
    "code": "invalid_type",
    "path": ["shareToken"],
    "message": "Invalid input: expected string, received null"
  }
]
shareToken omitted (undefined) => success = true     ← proves .optional() is satisfied by absence
```

The `valid` object the existing test suite feeds this schema (`reservation-lifecycle.test.ts:408`)
**omits `shareToken` entirely**, which is why the suite is green while production is not.

**Exact code location of the failure:** `app/api/ticketing/checkout/route.ts:101`

```ts
const input = parseOrThrow(checkoutRequestSchema, body);
```

→ `lib/api/validation.ts#parseOrThrow` → `safeParse` fails → `throw validationError(result.error.issues)`
→ `lib/api/response.ts:181` builds `new AppError(ERROR_CODES.VALIDATION_ERROR, { details })`
with **no message argument**, so `AppError`'s constructor (`lib/api/errors.ts`) falls back to
`DEFAULT_MESSAGE.VALIDATION_ERROR` = **`"Data yang dikirim tidak valid."`** — the exact string
the browser received. `STATUS_BY_CODE.VALIDATION_ERROR = 400`.

The error class is `AppError` (code `VALIDATION_ERROR`, status 400); the response mapping is
`apiErrorResponse()` → `{ success:false, code:"VALIDATION_ERROR", message:"Data yang dikirim tidak valid.", details:{fields:[{path:"shareToken",message:"Invalid input: expected string, received null"}]} }`.

---

## 6. Request Processing Trace

`app/api/ticketing/checkout/route.ts#POST`, in order:

| # | Step | Line | On the reported request | Result |
|---|---|---|---|---|
| 0 | `handleApi(...)` wrapper | 58 | — | entered |
| 1 | `requireSameOrigin(request)` | 60 | Origin + Referer same-origin | **pass** (a failure would be a different, non-generic error) |
| 2 | `await requireAuth()` | 65 | session cookie present | **pass** (failure = 401 `"Silakan login terlebih dahulu."`) |
| 3 | `assertPurchasingAvailable(await getMaintenanceState())` | 76 | site not in maintenance | **pass** (failure = 503, not 400) |
| 4 | `request.headers.get("idempotency-key")` | 78 | header present | **pass** |
| 5 | `if (!rawKey) throw AppError.validation("Header idempotency-key wajib diisi.")` | 80–89 | header present | **skipped** (its message would differ) |
| 6 | `parseOrThrow(idempotencyKeySchema, rawKey)` | 90 | 36-char UUID | **pass** (opaque 1–200 chars) |
| 7 | `await request.json()` | 92 | valid JSON, 214 bytes | **pass** |
| 8 | `if (!body || typeof body !== "object") throw AppError.validation("Body JSON tidak valid.")` | 94–96 | body is an object | **skipped** (its message would differ) |
| 9 | **`parseOrThrow(checkoutRequestSchema, body)`** | **101** | **`shareToken: null`** | **✘ THROWS → HTTP 400 `"Data yang dikirim tidak valid."`** |
| 10 | `createTicketOrder({...})` | 103 | — | **never reached** |
| 11 | `created(payload)` / `ok(payload)` | 108 | — | never reached |

**The request dies at step 9.** Steps 10–11 — the entire transactional order/reservation
creation — are not executed.

---

## 7. Payment Gateway Reachability

**Payment gateway is not the current failure point.**

Evidence:

1. `createTicketOrder` is called at `route.ts:103`, *after* the throwing parse at line 101.
   The route's own header documents the boundary: *"No payment session, no iPaymu call, no
   ticket rows, no QR. The response is a payment-ready order in `PENDING_PAYMENT` with
   `paymentUrl: null`."*
2. `lib/ticketing/checkout.ts` imports **no** payment module. Its imports are `prisma`,
   `lib/api/errors`, `lib/authz/permissions`, `lib/events/sales-state`,
   `lib/pic/attribution`, `./checkout-validation`, `./idempotency`, `./audit-log`,
   `./db-contention`, `./inventory`, `./order-payload`, `./reservations`. There is no
   `lib/payment/*`, no iPaymu client, no `Payment` write.
3. Payment is a **separate endpoint** — `app/api/ticketing/orders/[orderNumber]/pay/route.ts`
   → `lib/ticketing/payment/service.ts#createOrderPayment`, reached only after checkout has
   returned `orderNumber`. That request was never made because checkout never returned 201.

The architecture is exactly as stated: event page → `TicketPurchaseForm` → validation →
transactional `EventOrder(PENDING_PAYMENT)` + `TicketReservation(HELD)` → **later** payment
creation → iPaymu. The 400 occurs **before** the first mutation, therefore before payment
creation and before any iPaymu call.

---

## 8. Event/Ticket Data

**Not implicated, and not verifiable from this checkout.**

- The failure at `route.ts:101` happens **before any database access**. `createTicketOrder`
  — which resolves the `Event`, loads `TicketType` rows and enforces
  `isActive`/quota/`minPerOrder`/`maxPerOrder`/sales window — is at line 103 and is never
  reached. No event or ticket row is read, so no event/ticket property can cause this 400.
- **Local evidence:** the local development database (`tinggalklik`, a separate datasource
  from production) contains **16 events, none with slug `futsal-rizky`** (read-only `SELECT`).
  So the production event's `id`, ticket-type ids, availability, and min/max cannot be
  inspected from this repository.
- **Consequence for the report:** the event data for `/e/futsal-rizky` is
  **NOT VERIFIED**. It is nonetheless irrelevant to the 400, which is decided at the schema
  boundary. (`G. EVENT/TICKET DATA MISMATCH` is therefore excluded by construction, not
  merely by absence of evidence.)
- The only path-mediated input from the event page is `shareToken={pic}`, already covered in §3.

---

## 9. Production vs Local Revision

**NOT VERIFIED — production runtime revision unknown.**

What can be established from the repository alone:

| Fact | Evidence |
|---|---|
| Local HEAD | `107d5f60753fa7f1c53074031dee6325d3cde36f` |
| `origin/main` | identical to HEAD (`107d5f6`) |
| Working tree | clean (`git status --short` empty) |
| App is not deployed locally | `DEPLOYMENT_RUNBOOK.md` — *"Status: NOT DEPLOYED"*; `AUTH_URL`/`NEXT_PUBLIC_APP_URL` = `http://localhost:3000` |
| Deployment contract | `ecosystem.config.cjs` (`cwd: __dirname`, `next start -H 127.0.0.1`, `PORT=3000`); runbook §7 assumes checkout at `/srv/tinggalklik`, PM2 process `tinggalklik`, reloaded via `pm2 reload tinggalklik` **after `npm run build`** |
| No artifact/timestamp in-repo identifies the running build | no build manifest, no release tag, no recorded deploy SHA |

Because production is a distinct host reached over Cloudflare and no read-only channel to it
is available from this environment, **the running revision cannot be confirmed**. It is
explicitly **not** assumed that local source equals production source.

However, the *history* shows when the defect entered the codebase, and it is self-contained
within this repository — so the defect exists in HEAD regardless of what production runs:

| Commit | Effect | Verdict |
|---|---|---|
| `df8647f` *Initial rebuild* | schema already declares `shareToken: … .optional()` (`git log -S shareToken` returns only this commit for the schema — it has **never** been changed) | baseline |
| `b20e507` *testing vps* | `TicketPurchaseForm` body has **five keys only** — no `shareToken` at all | cannot trigger the 400 |
| **`7286b65` *fix pic fitur*** | `TicketPurchaseForm` adds `shareToken: shareToken?.trim() \|\| null` → every non-PIC checkout now sends explicit `null` | **defect introduced** |
| `7286b65..HEAD` | `dcd37a6`, `7b41212`, `107d5f6` — none touch this line | defect persists |

`git merge-base --is-ancestor 7286b65 HEAD` → **yes**: the defect is in HEAD. Any deployed
revision at or after `7286b65` returns this 400 for every checkout from a URL without
`?pic=` — which is the reported scenario. Whether production is such a revision is
**NOT VERIFIED** (no deploy record in-repo; do not SSH).

---

## 10. Existing Test Coverage

Relevant suites: `__tests__/ticketing-checkout/*` (`checkout-wiring`, `reservation-lifecycle`,
`checkout.integration`, `checkout-concurrency.integration`, `order-ownership-404.integration`,
`request-key`), plus `__tests__/ticketing-pic/pic-checkout.integration.test.ts`,
`__tests__/auth-flow/phase40-cross-role-workflow.integration.test.ts`,
`__tests__/ui-consolidation/*`, `__tests__/ticketing-ui/*`.

**Gap: yes.** There is **no test that feeds the browser-shaped body to
`checkoutRequestSchema`.** Specifically:

- `reservation-lifecycle.test.ts:407–508` unit-tests the schema, but its fixture
  `const valid = { eventId, items, buyerName, buyerEmail, buyerPhone }` (lines 408–414)
  contains **no `shareToken` key at all**. The test at line 506
  (`"couponCode and shareToken remain optional"`) parses that same fixture — it proves
  *absence* is allowed, which is **not** what the browser sends.
- `pic-checkout.integration.test.ts` sends `shareToken: <real token string>` (lines 122, 510)
  or omits it. `phase40-cross-role-workflow.integration.test.ts:192` sends a real token.
- `checkout-concurrency.integration.test.ts:105–111` builds the request object and casts it
  `as never`, bypassing the schema.

So every existing test sends either a **string** or **omits** the key. **Zero tests send
`shareToken: null`**, and **no test asserts frontend-payload ⇄ route-schema compatibility**
(the schema tests use hand-written fixtures, not the object the form actually serialises).
The drift was invisible to the entire suite, including `checkout-wiring.test.ts`, which
asserts architecture by reading source text but never checks that the two source files agree
on the `shareToken` representation. This is precisely the class of failure a
**contract/compatibility test** exists to catch.

---

## 11. Root Cause Classification

## **C. FRONTEND/BACKEND CONTRACT DRIFT**

The frontend and the backend disagree about how "no PIC referral token" is represented on the
wire:

- **Frontend** (`components/events/TicketPurchaseForm.tsx:192`) represents it as an
  **explicitly present `null`**, via `shareToken: shareToken?.trim() || null`.
- **Backend** (`lib/ticketing/checkout-validation.ts:82`) declares the field as
  `z.string().trim().min(1).max(128).optional()`, i.e. **absent or a string** — `null` is
  rejected.

Neither side is internally broken; they are two different conventions meeting at the API
boundary. The mismatch is **proven by reproduction in this repository** (§5) and is
**independent of production revision** (§9). It is drift, not a typo and not a data problem:

- it is **not** `A. FRONTEND PAYLOAD BUG` alone — because the service layer
  (`lib/pic/attribution.ts:42`, `lib/ticketing/idempotency.ts:72`,
  `lib/ticketing/checkout.ts:281`) already accepts `null`, so the schema is equally the
  outlier;
- it is **not** `B. BACKEND VALIDATION BUG` — the schema faithfully implements its documented
  contract (`buyerPhone, couponCode?, shareToken?`);
- it is **not** `D. PRODUCTION DEPLOYMENT DRIFT` — derivable from HEAD without invoking
  production state (though production revision remains NOT VERIFIED, §9);
- it is **not** `E/F/G/H` — same-origin and auth pass (§6), the idempotency key is present and
  merely *checked after* the body-parse order places the body first, and no DB access occurs
  before the throw (§7, §8).

**Exact failing field/condition:** body key `shareToken` = `null`;
Zod `invalid_type`, `"Invalid input: expected string, received null"`.

---

## 12. Evidence

**Source (read-only):**

| File | Lines | What it proves |
|---|---|---|
| `components/events/TicketPurchaseForm.tsx` | 180–195 (esp. **192**) | body includes `shareToken: … \|\| null` |
| `components/events/TicketPurchaseForm.tsx` | 62 | prop type `string \| null` |
| `app/e/[slug]/page.tsx` | `searchParams` → `shareToken={pic}` | `?pic=` absent on `/e/futsal-rizky` ⇒ `undefined` ⇒ `null` |
| `lib/ticketing/checkout-validation.ts` | 61–84 (esp. **82**) | `shareToken: … .optional()` |
| `app/api/ticketing/checkout/route.ts` | 60, 65, 76, 78–90, 92–96, **101**, 103 | processing order; throw site |
| `lib/api/validation.ts` | `parseOrThrow` | Zod failure → `validationError` |
| `lib/api/response.ts` | 120–152, **181** | `VALIDATION_ERROR` response; `details.fields`; no log for this code |
| `lib/api/errors.ts` | `DEFAULT_MESSAGE`, `STATUS_BY_CODE` | message `"Data yang dikirim tidak valid."`, status 400 |
| `lib/pic/attribution.ts` | 42 | service accepts `null` |
| `lib/ticketing/idempotency.ts` | 72 | hash input accepts `null` |
| `lib/ticketing/checkout.ts` | 281, 492, 549; imports | consumes `?? null`; **no payment/iPaymu import** |
| `app/api/ticketing/orders/[orderNumber]/pay/route.ts` | 13–14 | payment is a **separate** endpoint |

**Reproduction (safe, no writes):** `node` with the repository's `zod@4.4.3`, exact schema +
exact browser body → `success=false`, issue `{path:["shareToken"], code:"invalid_type",
message:"Invalid input: expected string, received null"}`; omitting the key → `success=true`.

**Git (read-only):**

- HEAD = `origin/main` = `107d5f6`; working tree clean.
- `git log -S 'shareToken' -- lib/ticketing/checkout-validation.ts` → only `df8647f` (schema
  never changed).
- `git show b20e507:components/events/TicketPurchaseForm.tsx` → 5-key body, no `shareToken`.
- `git log -S 'shareToken: shareToken?.trim() || null' -- components/events/TicketPurchaseForm.tsx` → `7286b65`.
- `git merge-base --is-ancestor 7286b65 HEAD` → true.

**Database (read-only `SELECT` only):** local dev DB has 16 events; **no `futsal-rizky`**. No
production database was accessed. No data was written.

**Not obtainable here:** production build SHA, PM2 status, production `Event`/`TicketType`
rows, the raw captured request/response body. All marked NOT VERIFIED.

---

## 13. Recommended Fix

> **PROPOSAL ONLY. Nothing below was implemented. No source, schema, migration, or data was changed.**

The drift can be closed from either side; **choose one** so the two representations agree.

**Option 1 — make the frontend omit the key (smallest behavioural change on the wire).**
In `components/events/TicketPurchaseForm.tsx` (line 192, and the matching signature at 164),
send the field only when a token exists, e.g. spread the key conditionally instead of
`shareToken: shareToken?.trim() || null`. This satisfies `.optional()` as written and removes
the 18-byte `,"shareToken":null` from every non-PIC body. Note the idempotency signature
(line 164) already normalises to `null` for hashing, and the hash input type accepts
`null` (`idempotency.ts:72`), so the signature need not change — only the transmitted body.

**Option 2 — make the backend accept `null` (smallest behavioural change on the server).**
In `lib/ticketing/checkout-validation.ts:82`, change `shareToken` to accept `null` as an alias
for "no referral", e.g. `z.string()…optional().nullable()` (or `.nullish()`). This matches what
the frontend already sends and what every downstream consumer already accepts
(`attribution.ts:42`, `idempotency.ts:72`, `checkout.ts` `?? null`).

**Assessment.** Option 2 aligns the boundary with the rest of the codebase — the service,
the hash, and the PIC resolver already treat `null` as the canonical "no referral" value, so
the schema is the single outlier. Option 1 is equally valid and slightly tighter on the wire.
**Whichever is chosen, add the compatibility test in §14 so this class of drift cannot recur.**

Do **not** "fix" this by adding a client-side `shareToken` filter that silently drops errors,
and do not weaken `buyerPhone`/`buyerName` validation. The failure is a representation
mismatch for exactly one optional field.

---

## 14. Verification Plan

**A. Confirm the diagnosis without changing anything (on the live deployment).**

1. Open DevTools → Network → the failing `POST /api/ticketing/checkout` → **Response** tab.
   The body is the error envelope and it **already contains the field-level cause** (see
   §Observability note below), which should read:
   `details.fields: [{ path: "shareToken", message: "Invalid input: expected string, received null" }]`.
   If that is present, the diagnosis is confirmed on production with no code change.
2. Re-run the same purchase from `/e/futsal-rizky?pic=<any non-empty value>` (or any URL
   carrying `?pic=`). `shareToken` becomes a non-empty string and the 400 should disappear —
   proving the field is the trigger. (Use a non-PIC token; the server fails closed to a normal
   order if the token is not a real, active PIC.)

**B. Regression test to add with the fix (does not exist today, §10).**

- **Schema accept/reject test** at `__tests__/ticketing-checkout/reservation-lifecycle.test.ts`
  (schema block, ~line 407): assert the chosen representation parses — i.e. if Option 1,
  `{...valid, shareToken: null}` is rejected and the *omitted* key is accepted by the shipped
  frontend; if Option 2, `{...valid, shareToken: null}` parses to `shareToken: null`.
- **Payload ⇄ schema compatibility test** (the real gap): construct the body exactly as
  `TicketPurchaseForm` does for a no-`?pic=` page — including the conditional —
  run it through `checkoutRequestSchema`, and assert success. Prefer extracting the body
  builder from the form (a pure function) and importing it in the test, so the test fails if
  either side changes unilaterally. A static guard in `checkout-wiring.test.ts` asserting the
  two source files agree on `shareToken`'s representation is an acceptable second line.
- Keep/extend the existing PIC integration coverage (`pic-checkout.integration.test.ts`)
  so both branches — token present and token absent — remain asserted end-to-end.

**C. Full gates after the fix (`npm` toolchain, as used in this repo).**

- `npx tsc --noEmit`
- `npx eslint .`
- `npx jest --runInBand` (targeted first: `__tests__/ticketing-checkout`, `__tests__/ticketing-pic`)
- `npm run build`

**D. Production verification (owner action).** Because the running revision is unknown (§9),
after deploying the fix confirm **which SHA is live** (`git log --oneline -1` in the production
checkout, per `DEPLOYMENT_RUNBOOK.md` §9.1/§9.2) and that `pm2 reload tinggalklik` followed a
fresh `npm run build`. Then repeat step A.1/A.2 against production.

### Observability note (no logging added)

For `VALIDATION_ERROR` the server **does not log** the Zod issues: `VALIDATION_ERROR` is not in
`SERVER_FAULT_CODES` (`lib/api/response.ts:104–110`) and `expose === true`, so neither the
`console.error` branch nor the `!expose` branch runs. The field-level cause is, however,
**deliberately returned to the client** in `details.fields` (`response.ts:144`). The UI hides it
because `TicketPurchaseForm` renders only `payload?.message` (line ~205). Therefore the safest
place to read the actual validation error is the **browser Network tab response body** — no new
logging, no secrets, no PII. (If server-side logging of validation failures is ever wanted, it
must be added as a separate, reviewed change; it was not made here.)

---

## Audit summary

| Question | Answer |
|---|---|
| **Exact failing field/condition** | Body key `shareToken` = `null`; Zod `invalid_type` — `z.string().optional()` accepts `string \| undefined`, never `null` |
| **Exact source file + code location** | Sent: `components/events/TicketPurchaseForm.tsx:192` (`shareToken: shareToken?.trim() \|\| null`). Rejected: `lib/ticketing/checkout-validation.ts:82` (`shareToken: z.string().trim().min(1).max(128).optional()`), thrown at `app/api/ticketing/checkout/route.ts:101` |
| **Actual frontend payload shape** | `{ eventId, items:[{ticketTypeId, quantity}], buyerName, buyerEmail, buyerPhone, shareToken: null }` (6 keys; `shareToken` always present) |
| **Backend expected shape** | `{ eventId, items:[{ticketTypeId, quantity}], buyerName, buyerEmail, buyerPhone, couponCode?, shareToken? }` with `shareToken` = string **or absent** |
| **Root-cause category** | **C. FRONTEND/BACKEND CONTRACT DRIFT** |
| **Is iPaymu involved?** | **No.** Payment gateway is not the current failure point — the 400 occurs before `createTicketOrder`, before any order/reservation, and payment creation lives in a separate `/orders/[orderNumber]/pay` endpoint that is never called |
| **Production revision verified?** | **NOT VERIFIED — production runtime revision unknown.** The defect is proven present in HEAD (`7286b65…107d5f6`); production's running SHA could not be read |
| **Test gap** | Yes — no test sends `shareToken: null` to `checkoutRequestSchema` (the schema fixture omits the key), and no test asserts frontend-payload ⇄ route-schema compatibility |
| **Files inspected** | `components/events/TicketPurchaseForm.tsx`; `app/e/[slug]/page.tsx`; `app/api/ticketing/checkout/route.ts`; `app/api/ticketing/orders/[orderNumber]/pay/route.ts`; `lib/ticketing/checkout-validation.ts`; `lib/ticketing/checkout.ts`; `lib/ticketing/idempotency.ts`; `lib/pic/attribution.ts`; `lib/api/validation.ts`; `lib/api/errors.ts`; `lib/api/response.ts`; `lib/request-key.ts`; `__tests__/ticketing-checkout/reservation-lifecycle.test.ts`; `__tests__/ticketing-checkout/checkout-wiring.test.ts`; `__tests__/ticketing-pic/pic-checkout.integration.test.ts`; `__tests__/auth-flow/phase40-cross-role-workflow.integration.test.ts`; `DEPLOYMENT_RUNBOOK.md`; `ecosystem.config.cjs`; git history |
| **Source/schema/data modified?** | **NONE.** This audit ran only reads: file reads, `git log`/`show`/`merge-base`, a `node`+`zod` in-memory parse, and one read-only `SELECT` against the local dev database. No file was written (other than this report), no schema/migration changed, no data written, no dependency installed, nothing committed or pushed. |
