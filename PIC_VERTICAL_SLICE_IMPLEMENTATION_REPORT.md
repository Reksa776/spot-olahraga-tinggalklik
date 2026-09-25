# PIC Vertical Slice V1 — Implementation Report

> Attribution → snapshot → settle → EARNED. Exactly once.

## 1. Objective

Deliver the **PIC (Partner Introducing Customer)** vertical slice: a publicly shareable,
signed `?pic=` referral link that a buyer clicks, and that — when a paid order is settled —
becomes an **EARNED** fee on the `picFeeLedger`, posted exactly once, replaying numbers
frozen at checkout rather than recomputed at settlement.

Scope boundaries honoured:

- **In slice** — referral token, landing-page transport, server-side checkout resolution,
  PIC fee computation, order/line snapshots, one-to-one attribution row, EARNED posting at
  settlement, refund-reversal compatibility.
- **Out of slice (untouched)** — Admin authz for PIC management, payout, PIC dashboard UI,
  payment integration, webhooks, reconciliation. The pre-existing `lib/pic/service.ts`
  admin surface (`createPic`, `assignPicToEvent`, `revokePicAssignment`, `updatePicStatus`,
  …) is reused as-is and is not part of this diff.

## 2. Architecture

```
[share route]                 [landing page ?pic=]
   mint token  ─────────────►  TicketPurchaseForm.shareToken
                                │  (idempotency signature + request body)
                                ▼
                          ┌───────────────────────────┐
                          │ createTicketOrder         │
                          │   resolveReferralAtCheckout│  ← verifies HMAC + cross-checks
                          │   (inside the $transaction)│    ACTIVE profile + active
                          │   └── fee engine           │    non-revoked assignment
                          │       (rate-only V1)       │
                          │   ─ order  : picFeeTotal, picProfileId
                          │   ─ items  : frozen snapshots (rate, type, basis, amounts)
                          │   ─ PICAttribution row (PIC_LINK / LINK, shareToken)
                          └───────────┬───────────────┘
                                      │
                                      ▼
                          ┌───────────────────────────┐
                          │ settleVerifiedPayment     │
                          │   SETTLED branch only      │
                          │   └── postEarnedPicFees    │  ← EARNED rows replay snapshots
                          │       (idempotent)         │
                          └───────────┬───────────────┘
                                      │
                                      ▼
                          ┌───────────────────────────┐
                          │ refund reversal           │
                          │ reversePicFeesForRefund   │  ← pre-existing; copies
                          │  (copies ticketTypeId +   │    ticketTypeId/attributionId
                          │   attributionId)          │    FROM the EARNED row
                          └───────────────────────────┘
```

### 2.1 The referral token — `lib/pic/referral.ts`

- `raw = "p1:{picProfileId}:{eventId}"`, `token = base64url(raw) . base64url(mac)`.
- `mac = HMAC-SHA256(secret, raw)` truncated to **16 bytes** (128 bits).
- **Fail-closed**: with `PIC_REFERRAL_SECRET` unset, `mint` returns `null` (no link shown,
  no weak tokens) and `verify` returns `null` (a stale link becomes an ordinary no-PIC
  purchase, never a broken one).
- **Never throws** on any input; the MAC comparison is constant-time on length-pinned
  buffers.
- `verifyPicReferralTokenForEvent` binds the payload to the locked event being bought, so a
  token minted for event A cannot be pasted onto event B's URL.

### 2.2 The fee engine — `lib/pic/fee.ts`

- `resolvePicFeeConfig` inherits rate down the chain **assignment → profile → platform
  default → 0**; `feeTypeOverride` is the only source of type (default `PERCENTAGE`);
  `basisType` is fixed at `GROSS_BEFORE_DISCOUNT` for this slice.
  - Regression-fixed: a corrupted `?? 02;` octal literal silently forced a 0.2% floor fee;
    it now behaves as `0`.
- `computeLinePicFee` computes `round(lineBasis × rateBp / 10_000)` (FIXED adds
  `fixedAmount × quantity`; HYBRID is additive, never compound); **rounding is half-up to
  whole rupiah, once** — `picFeeTotal == Σ line fees` holds by construction.
- Documented scope limits kept honest: `GROSS_AFTER_DISCOUNT` (proportional discount share)
  and the `NET_AFTER_GATEWAY` fall-through to gross exist in the engine but are not
  reachable from resolution today.

### 2.3 Checkout resolution — `lib/ticketing/checkout.ts` + `lib/pic/attribution.ts`

`resolveReferralAtCheckout(db, …)` runs **inside the checkout transaction**:

1. Verifies the token against the event being purchased, then re-checks **current** rows:
   assignment `isActive`, not `revokedAt`, profile `status == "ACTIVE"`.
2. Resolves the fee config (never touching a `fixedAmount` — the assignment has no such
   column; V1 is rate-only) and computes per-line fees over **order subtotal and discount**
   (line share for `GROSS_AFTER_DISCOUNT`).
3. The order is created with `picFeeTotal` (rounded `Σ lines`) and `picProfileId`.
4. Each `eventOrderItem` freezes a full snapshot: `picFeeAmount`, `picFeeType`, `basisType`,
   `rateBp`, `fixedAmount` (`0.00` today), `basisAmount`. A later admin rate change can
   never rewrite a sold line.
5. One `PICAttribution` row per order (`source=PIC_LINK`, `method=LINK`, `shareToken`,
   `eventId`, `picProfileId`, first/last touch = now, `selfReferral` when the buyer **is**
   the PIC's own account — flagged, not blocked).
6. The buyer-total is **untouched** (D-23); the organizer absorbs: `organizerNetAmount =
   total − picFeeTotal`.

The buyer-visible order payload shows `picFeeTotal`/`organizerNetAmount` but never leaks
`picProfileId`, the `shareToken`, or attribution internals.

### 2.4 Landing transport

- `app/e/[slug]/page.tsx` awaits `searchParams` (Next 16 promise form) and passes
  `shareToken` into `TicketPurchaseForm`.
- `TicketPurchaseForm` carries `shareToken` into the idempotency signature and the checkout
  request body (`shareToken?.trim() || null`); validation already bounds it to 1–128
  chars.

### 2.5 The share route — `app/api/events/[slug]/share/route.ts`

`resolveTrackedShareToken(userId, eventId)` mints a token **only** when the session actor's
own `PICProfile` is `ACTIVE` **and** its `PICEventAssignment` for that event is active and
not revoked. Anonymous visitors keep `shareUrl === canonicalUrl` (`trackingToken: null`);
every minting failure is spite-safe for the public listing.

### 2.6 Settlement → EARNED — `lib/ticketing/payment/settlement.ts`

`postEarnedPicFees` is called **once**, in the `SETTLED` branch of `settleVerifiedPayment`
(after inventory conversion, before the `SETTLED` return). It replays the line snapshots
into `picFeeLedger`:

- `type=EARNED`, `direction=CREDIT`, `status=EARNED`, `currency=IDR`;
- `rateBp`, `feeType`, `basisType`, `fixedAmount`, `basisAmount`, `quantity`, `amount`
  all copied from the snapshot (counterfactual-math-free);
- `ticketTypeId: item.ticketTypeId` and `attributionId: attribution.id` — the fields the
  pre-existing refund reversal (`reversePicFeesForRefund`) depends on; it copies them FROM
  the EARNED row, so those columns must be set on create;
- `idempotencyKey = fee:earned:{orderItemId}` — exactly the key the refund manual-rail
  integration seed uses.

**Exactly-once** is guaranteed three ways: the `ALREADY_PAID` short-circuit returns
*before* any posting, the ledger's implicit `@@unique([orderItemId, type])` rejects
duplicates, and the unique `idempotencyKey` does the same at the application layer.

### 2.7 Schema — `prisma/schema.prisma` + migration `20260923000000_add_pic_fee_snapshots`

Six nullable `eventorderitem` columns are added (additive, no index):
`picFeeAmount Decimal?`, `picFeeType PICFeeType?`, `basisType FeeBasisType?`,
`rateBp Int?`, `fixedAmount Decimal?`, `basisAmount Decimal?`.

## 3. Security properties

| Threat | Control |
|---|---|
| Forged/edited `?pic=` value | 128-bit truncated HMAC; constant-time compare; length pinned |
| Token pasted onto another event | `verifyPicReferralTokenForEvent` binds `eventId`; resolver cross-checks against the purchased event id |
| Revoked/suspended PIC rides a stale token | Resolver re-reads **current** rows: `isActive`, `revokedAt`, profile `status` |
| Secret leakage | Read from env (`PIC_REFERRAL_SECRET`) at call time; never stored or logged; fail-closed when unset |
| NotImplemented DoS / crypto misuse | `verify` never throws; `Buffer.from(..., "base64url")` only |
| Double-paid settlement posts twice | `ALREADY_PAID` short-circuit + two uniqueness constraints |

## 4. Test coverage

| Suite | Nature | Cases |
|---|---|---|
| `ticketing-pic/referral.test.ts` | pure | round trip, determinism, event binding, fail-closed (unset/blank/different secret), tampered MAC, malformed shapes, never-throws |
| `ticketing-pic/fee.test.ts` | pure | inheritance chain, **`02` octal regression**, PERCENTAGE/FIXED/HYBRID math, proportional discount share, NET→gross fallback, half-up rounding, checkout rounding parity |
| `ticketing-pic/pic-wiring.test.ts` | static | fee engine is the sole computer; EARNED posted exactly once in the SETTLED branch; only attribution + refund reversal touch the ledger; EARNED contract fields; idempotency-key parity; resolver never writes |
| `ticketing-pic/pic-checkout.integration.test.ts` | integration | token → fee priced (15000 on 300000, organizer net 285000, buyer total unchanged); snapshot freeze; one-to-one attribution; wrong-event/suspended/secretless/untokened all dissolve to no-PIC orders; self-referral flagged; payload hides internals; settle → EARNED replay; re-delivery idempotent (still one row); non-PIC settles empty; `Σ EARNED == picFeeTotal` |
| `ticketing-checkout/checkout-wiring.test.ts` | structural pin (updated) | attribution written only through the shared resolver, nowhere else in any phase-6 file |

**52 new tests.** Verification run:

- `npx tsc --noEmit` — clean
- `npm run lint` — 0 errors (3 pre-existing `<img>` warnings unaffected)
- `npx jest` — **98 suites / 2029 tests passed** (incl. the reset 2049-line checkout,
  refund manual-rail, and catalogue suites — no regressions, non-PIC orders still show
  `picFeeTotal "0.00"`, anonymous share still returns `trackingToken: null`)
- `npm run build` — production build succeeds

## 5. Configuration

- Set `PIC_REFERRAL_SECRET` in the environment once. Until it is set, the slice is
  fail-closed (real purchases work; PIC links simply don't resolve).
- Test DB: `npm run test:db:setup` deploys the new migration idempotently.

## 6. Known limits (by design)

- V1 is **rate-only**: assignment `fixedAmount` does not exist; the resolver always passes
  `fixedAmount: null` and snapshots `0.00`.
- Basis is `GROSS_BEFORE_DISCOUNT`. `GROSS_AFTER_DISCOUNT` is implemented and unit-tested
  but unreachable from resolution; `NET_AFTER_GATEWAY` deliberately falls through to gross
  (D-22 — gateway clearing isn't modelled in this slice).
- No payment-webhook/reconciliation changes, no payout, no PIC dashboard, no Admin
  authz changes.