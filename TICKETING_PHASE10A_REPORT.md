# TICKETING PHASE 10A REPORT

## Closing D-61 (money representation) and D-16 (iPaymu `expired` unit)

**Scope.** Local inspection and decision-closure only. This phase answers the two open
decisions carried by the Phase 9 audit and phase reports, and records whether either needs
a code change. It does **not** re-audit or redesign the transaction flow, change the
provider, change `AUTH_URL`, or touch deployment configuration. **No source file was
modified.**

**Method.** Decisions were resolved from the repository's own code, comments, migrations
and tests. No value was guessed, and no production behavior was changed on an assumption.

---

## 1. D-61 — Current state

Money is represented uniformly across every layer. The inventory:

| Layer | Representation | Evidence |
| --- | --- | --- |
| Database | Every monetary column is `Decimal(14,2)`; no `Float`/`Double` for money. `currency String @default("IDR")` on `TicketType`, `Payment`, `PICFeeLedger`. | `prisma/schema.prisma` (money comment at :334); `TicketType.price`; `EventOrder.{subtotal,discount,platformFee,gatewayFee,picFeeTotal,total,organizerNetAmount,refundedAmount}`; `EventOrderItem.{priceSnapshot,subtotal}`; `Payment.amount`; `PaymentTransaction.{amount,providerFee,amountReported}`; `PICFeeLedger.{amount,fixedAmount,basisAmount}` |
| Service / domain | `Prisma.Decimal` (decimal.js) throughout; arithmetic is decimal, rounding happens once at first persistence (`roundToRupiah`). | `lib/ticketing/checkout.ts` (`new Prisma.Decimal(type.price)`, `roundToRupiah(unitPrice.mul(quantity))`) |
| API (customer payload) | Fixed 2-decimal **strings**, never JSON numbers. `moneyString` is `new Prisma.Decimal(value).toFixed(2)`. | `lib/ticketing/order-payload.ts:19-46`; reused by payment payload (`lib/ticketing/payment/service.ts:157`) and webhook (`lib/ticketing/payment/webhook.ts:849`) |
| API (dashboard aggregation) | `_sum` in `Prisma.Decimal`, rendered `.toFixed(2)`; averages `.toDecimalPlaces(2)`. | `lib/dashboard/reports.ts:145-197`, `lib/dashboard/overview.ts:216`, `lib/dashboard/customers.ts:159` |
| Frontend | Display-only `Intl.NumberFormat("id-ID")` (`maximumFractionDigits: 0`). The payload type is `string`; `Number(...)` appears only inside `formatIdr` and is never written back. | `lib/ticketing/ui/format.ts:1-26,71-73`; `app/ticketing/orders/[orderNumber]/page.tsx:46` |
| iPaymu wire boundary | One deliberate `Decimal|string → number` coercion, `requireSafeRupiah`, which **refuses** non-finite, negative, non-integer, or `> 2^53-1` values. | `lib/ticketing/payment/gateway.ts:74-122` |

There is **no float money arithmetic anywhere**. The single `Number` conversion is a
transport serialization at the provider edge and is guarded, not trusted. Tests already
lock this: `__tests__/ticketing-payment/payment-wiring.test.ts:191-260` forbids
`Number(x).toFixed(2)` and requires `requireSafeRupiah`;
`__tests__/ticket-types/validation.test.ts:38-81` and
`ticket-type-service.integration.test.ts:262` lock exact decimal round-trips;
`__tests__/ticketing-ui/display-format.test.ts:148-153` confirms display formatting never
mutates the decimal string.

**Finding: the current money representation is consistent and safe. No defect was found.**

## 2. D-61 — Recommendation (one canonical representation)

Adopt the representation already implemented, and stop treating it as open:

- **Database:** `Decimal(14,2)` + `currency` column. Unchanged; no migration.
- **Service / aggregation:** `Prisma.Decimal`; decimal arithmetic only, round once at
  first persistence. Unchanged.
- **API contract:** fixed 2-decimal **strings** (`"300000.00"`) — this is the binding rule
  at `TICKETING_PHASE1_DESIGN.md` §36.5 ("strings … **never as JSON numbers**").
- **Frontend:** display-only formatting; never parse-and-write-back.
- **iPaymu boundary:** whole-rupiah `number` via `requireSafeRupiah` only.

The register's non-binding *suggestion* of "integer rupiah" (`TICKETING_PHASE1_DESIGN.md`
:3331, :3641) is **declined as a change**: it would be a breaking API-contract change for
no correctness benefit, because storage is already exact `Decimal(14,2)` and IDR amounts
are whole-rupiah anyway. The canonical string form is documented as
`"<integer>.00"` for IDR.

## 3. D-61 — Implementation change

**None.** The implementation already matches the recommendation; the only work was to
settle the decision and record it (this report). No migration, no API change, no test
change.

---

## 4. D-16 — Current implementation

The `expired` field exists on two different iPaymu request types, and the application
uses both, so the unit is reported per endpoint.

**DIRECT endpoint (the live ticketing path: QRIS, Virtual Account, retail outlet).**

- Type field: `IpaymuDirectRequest.expired?: number` — documented as **HOURS**, advisory.
  `lib/payment/ipaymu.ts:285-292`.
- Value sent: `Math.max(1, Math.ceil(input.ttlMinutes / 60))` — a minutes→hours
  conversion. `lib/ticketing/payment/gateway.ts:414-417`.
- Authoritative expiry: the response's `Expired` string is parsed by `parseProviderExpiry`
  (`gateway.ts:336`) and persisted as `Payment.providerExpiredAt`. When present,
  `recordInstruction` also sets `Payment.expiresAt` to the provider's instant
  (`lib/ticketing/payment/service.ts:790-795`).
- Which methods use it: `option.flow === "DIRECT"` (`service.ts:570-586`); this covers
  QRIS / VA / retail. Only credit card is `REDIRECT`.

**REDIRECT endpoint (hosted page — credit card only).**

- Type field: `IpaymuRedirectRequest.expired?: number` — **no unit documented**.
  `lib/payment/ipaymu.ts:206`.
- Value sent: `gatewaySessionExpiryValue(ttlMinutes)` = `Math.max(1, Math.trunc(ttlMinutes))`
  — the raw platform TTL, i.e. **minutes**. `gateway.ts:204-206, 583, 602`.
- The create response `IpaymuResponse.Data` carries only `SessionId` and `Url`
  (`ipaymu.ts:209-216`), so there is no expiry to read back; `Payment.expiresAt` stays the
  order window and no provider expiry is available for this path.
- The code's own D-16 note (`gateway.ts:168-206`) states the unit is unverified and that
  the value is deliberately direction-safe: minutes ⇒ provider window equals ours; hours
  ⇒ provider window is longer. The forbidden case (provider lapses while the platform
  still considers the order payable) cannot occur.

## 5. D-16 — Evidence

For the **DIRECT** endpoint the unit is determinable from repository documentation:

- `lib/payment/ipaymu.ts:285-292` quotes the provider's own collection — *"Custom expired
  payment code in hours"* — and the real per-channel hour ceilings (BSI VA max 3h, BRI VA
  max 2h, BCA VA not customisable), which is why the value is advisory and the response
  `Expired` is authoritative (`ipaymu.ts:289-290`, `618-622`).
- The code converts minutes→hours accordingly (`gateway.ts:417`).
- `__tests__/ticketing-payment/payment-creation.integration.test.ts:200-205` asserts the
  direct `body.expired` is the hour-ceiling in `[1, 24]` and states the unit is HOURS.

For the **REDIRECT** endpoint:

> **Cannot conclusively determine unit from repository.**

The redirect request type documents no unit (`ipaymu.ts:206`); the create response has no
expiry to read back (`ipaymu.ts:209-216`); `gateway.ts:178-182` explicitly records that
"the repository contains no sandbox evidence that settles the unit" and that the
`expired: 1` diagnostic value cannot settle it. The remaining evidence supports only the
direction-safety argument, not a unit.

## 6. D-16 — External verification required?

- **DIRECT:** No immediate external check required for correctness — the value is advisory,
  the code already uses HOURS, and the authoritative expiry comes from the response. A
  sandbox capture that echoes the issued `Expired` would be confirmatory only.
- **REDIRECT:** **EXTERNAL VERIFICATION REQUIRED.** The unit must be confirmed against the
  iPaymu sandbox before this path is relied on. Because the current value is direction-safe
  under both candidates, **no production behavior is changed on the assumption**; if the
  sandbox returns "hours", the only change is inside `gatewaySessionExpiryValue`.

## 7. Files changed

None. This phase produced documentation only (`TICKETING_PHASE10A_REPORT.md`). No source,
schema, migration, test, or configuration file was modified.

## 8. Tests

No new tests, because neither decision required a behavior change. Existing tests that
lock the two surfaces were confirmed present and passing:

- Money: `payment-wiring.test.ts`, `ticket-types/validation.test.ts`,
  `ticket-type-service.integration.test.ts`, `display-format.test.ts`,
  `payment-webhook.integration.test.ts`.
- Expiry/`expired`: `payment-creation.integration.test.ts` (direct `expired` unit + real
  reservation reaper), `issuance.integration.test.ts`, `payment-races.integration.test.ts`.

## 9. TypeScript

`npx tsc --noEmit` → **0 errors**.

## 10. Build

`npm run build` → **succeeds** (all routes compiled; no errors). Jest baseline re-confirmed:
**45 suites / 1035 tests passed**.

## 11. Remaining open decisions

- **D-16 (redirect endpoint only)** — unit verification deferred to iPaymu sandbox
  (EXTERNAL VERIFICATION REQUIRED); no code change pending.
- Unchanged from prior reports and out of scope here: D-01, D-04, D-06, D-08, D-09,
  D-20, D-22, D-26, D-28, D-32/34, D-33, D-39, D-46, D-60. D-61 is now **closed** as
  "canonical = fixed 2-decimal strings".
