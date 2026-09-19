# Ticketing Cleanup + Admin Sync + Payment Gateway — Final Report

Scope: remove the obsolete retail/e-commerce application from this repository, make
Admin an unambiguous ticketing product, replace the legacy Affiliate concept with the
ticketing **PIC** domain, and give QRIS / Virtual Account a real, gateway-generated
in-checkout experience.

**Status headline:** the retail application is deleted (not hidden), the three PIC
surfaces are built on the schema's pre-existing PIC models, the payment path now uses
iPaymu's **Direct Payment API** so QRIS/VA values are real, and `tsc`, `prisma validate`,
**984/984 tests** and the **production build** all pass. The one thing that **cannot be
verified from this repository** is whether the iPaymu account has the channels enabled and
the webhook URL configured — see §20.

---

## 1. What was removed

The repository contained **two applications sharing one database**: a legacy retail
marketplace (`toko`) and the ticketing product. Only ticketing remains.

- **176** files under `app/` (pages + API routes), **48** components, **44** lib modules,
  **38** test suites, **4** prisma files — **316 deletions** in total.
- Retail route groups deleted outright: `/home`, `/products`, `/cart`, `/checkout`,
  `/buy-now`, `/orders`, `/profile`, `/addresses`, `/affiliate`, `/promos`,
  `/campaigns`, `/flash-sales`, `/promotions`, and **all 25 `/admin/**` pages**.
- Retail API namespaces deleted: `/api/admin/**` (retail), `/api/checkout`, `/api/orders`,
  `/api/cart`, `/api/products`, `/api/address(es)`, `/api/affiliate/**`,
  `/api/spin-wheel`, `/api/shipping`, `/api/rajaongkir/**`, `/api/voucher*`,
  `/api/campaigns`, `/api/promotions`, `/api/broadcasts`, `/api/refunds`, `/api/profile`.
- Retail libs deleted: `lib/checkout.ts`, `lib/refund.ts`, `lib/repay.ts`,
  `lib/voucher.ts`, `lib/cart-validation.ts`, `lib/order-stock.ts`, `lib/rajaongkir*`,
  `lib/spin-wheel.ts`, `lib/affiliate/**`, `lib/marketing/**`, `lib/notification/**`,
  `lib/whatsapp/**`, `lib/cloudinary.ts`, `lib/upload-to-cloudinary.ts`,
  `lib/analytics/tiktok.ts`, `lib/admin/**`.
- Retail components deleted: `components/products/**`, `components/cart/**`,
  `components/admin/**`, `components/SpinWheel*`, `components/VoucherPickerModal`,
  `components/orders/OrdersPage.tsx`, `components/profile/**`, `components/analytics/**`.
- Kept surfaces that still pointed at retail were repaired: `app/layout.tsx`,
  `app/page.tsx`, `components/auth/LoginForm.tsx`, `components/auth/RegisterForm.tsx`,
  `lib/validations/register.ts`, `app/api/auth/register/route.ts`, the dashboard shells
  (`OrganizerShell`, `PlatformShell`, `DashboardNav`, `sidebar`), `proxy.ts`,
  `next.config.ts` (CSP) and `lib/rate-limit.ts`.
- Dead tooling removed: `scripts/.audit-residue.js` (a throwaway residue scanner),
  `prisma/seed-regions.{ts,js}`, the prisma `.bak` / `.after-pull` scratch files.

No retail route was redirected — there is no retail surface for an old URL to land on.

## 2. Affiliate → PIC

**There was no rename.** The audit found the retail `Affiliate` and the ticketing `PIC` are
different domain objects:

- The retail Affiliate converted against `Product` and the retail `Order`, was paid on
  `Order.subtotal`, carried KYC uploads and a payout provider.
- The ticketing **PIC** models (`PICProfile`, `PICEventAssignment`, `PICAttribution`,
  `PICFeeLedger`, `PlatformRole.PIC`) already existed in the schema, were already
  referenced by `lib/ticketing/checkout.ts` and `lib/ticket-types/service.ts`, and had
  **no UI**.

Renaming Affiliate → PIC would have produced the *second* PIC system the brief forbids, so
the Affiliate was **deleted with the retail application** and the existing PIC models were
given the management surface they never had. No user-facing "Affiliate" terminology
remains (see §13).

## 3. Shipping / Ongkir removal

Tickets are not physical products, so there is **no shipping in the ticketing flow at
all** — no address, courier, shipping fee, delivery method or ongkir field in checkout
(`lib/ticketing/checkout-validation.ts` collects only event, items, buyer name/email/phone
and payment). The entire shipping stack was deleted: `lib/rajaongkir*`, shipping-discount
marketing, `app/api/admin/settings/{destination,locations,regions}`, the tracking-import
admin endpoints and `app/addresses/**`. `StoreSetting` (contact/legal pages) lost its
retail geo/courier columns. No shipping component, service or route survives.

## 4. Spin Wheel removal

Removed completely: `lib/spin-wheel.ts`, `components/SpinWheel*`,
`/api/spin-wheel`, the Spin Wheel admin pages, its marketing discount coupling, its
rate-limit bucket, its Prisma models (`SpinWheelSpin`, `SpinWheelPrize`-family) and its
tests. Remaining "spin" matches are `animate-spin` (CSS loaders) and comments — see §13.

## 5. Admin → Landing Page ticket sync

Already correct and left as-is. `app/page.tsx` and `app/events/page.tsx` read **real DB
data** through `listPublicEvents()` (`lib/events/catalog.ts`) with visibility
`PUBLISHED + PUBLIC + not archived + not past` and real price/quota/sale-window. There is
**no mock ticket dataset**. Admin (`/organizer/events/**`) is the single source of truth:
create → publish → the ticket appears on the public landing page automatically. Draft,
inactive, expired and archived tickets are not shown or purchasable.

## 6. Ticket availability

Server-side and authoritative. `lib/ticketing/inventory.ts` + `lib/ticketing/reservations.ts`
reserve quota inside the checkout transaction; status, sale window and remaining quota are
re-validated server-side on every order/payment request. Concurrency is covered by
`__tests__/ticketing-checkout/checkout-concurrency.integration.test.ts` and
`__tests__/ticket-types/inventory-concurrency.integration.test.ts`. No second inventory
mechanism was introduced.

## 7. QRIS — real gateway data

iPaymu's Redirect API returns only `SessionId` + `Url`, so it can never show a QR in-app.
This change adds the **Direct Payment API** (`POST /api/v2/payment/direct`, method `qris`,
channel `mpm`) in `lib/payment/ipaymu.ts` → `createDirectPayment()`. The response
`Data.QrString` / `Data.QrImage` / `Data.PaymentNo` / `Data.Expired` are persisted verbatim
on the `Payment` row (`qrString`, `qrImageUrl`, `paymentNumber`, `providerExpiredAt`,
`providerFlow = DIRECT`) and rendered by `components/ticketing/PaymentInstruction.tsx`:
the gateway's own PNG, the copyable QRIS payload, the server-derived amount, a countdown
from the gateway's expiry, and the order's live status. **No QR is generated locally**; if
the gateway returned no image, the panel says so instead of drawing a scannable fake.

## 8. Virtual Account — real gateway data

Bank transfer selects a supported bank (BCA, BNI, BRI, Mandiri, BSI, CIMB, Permata,
Danamon, Muamalat, BPD Bali, BAG), creates a Direct Payment (`va`), and renders the
**gateway-issued** `PaymentNo`, `PaymentName`, amount, expiry and a copy button. No VA
number is hard-coded.

## 9. Supported payment methods

Defined once in `lib/ticketing/payment/method-catalog.ts`, taken field-by-field from
iPaymu's published API v2 collection, and shared by the client picker and the server
validator:

| Method | Flow | Channels |
|---|---|---|
| QRIS | Direct | `qris` / `mpm` |
| Virtual Account | Direct | 11 documented banks |
| Retail outlet | Direct | `alfamart`, `indomaret` |
| Credit/debit card | Redirect | provider-hosted page |

Deliberately **not** offered: **COD** (nothing to deliver for a digital ticket),
**PayLater** (no matching bucket in the `PaymentMethod` enum — recording a credit product
as e-wallet would falsify a financial record), and **E_WALLET** as a separate tile
(e-wallets pay by scanning QRIS; a second tile would open the same instrument).

## 10. Webhook / payment-status lifecycle

`app/api/ticketing/payment/webhook/route.ts` is public **by contract** (a provider cannot
hold a session) and its trust boundary is an HMAC-SHA256 signature over the exact raw
bytes, verified fail-closed before parsing (`lib/ticketing/payment/webhook.ts`). Processing
is idempotent and transactional: a duplicate callback finds the `Payment` already in a
terminal state and makes no second mutation; order status flips to paid **only** from a
verified callback, never from a successful create. Statuses: `PENDING`, `PAID`, `EXPIRED`,
`FAILED`, `CANCELLED`.

## 11. Files/routes/services added

- **PIC:** `lib/pic/service.ts`, `lib/pic/validation.ts`,
  `app/api/admin/pic/route.ts`, `app/api/admin/pic/[id]/route.ts`,
  `app/api/organizer/pic/route.ts`, `app/api/organizer/pic/[id]/route.ts`,
  `components/platform/PicManager.tsx`, `app/platform/pic/page.tsx`,
  `app/platform/pic/[id]/page.tsx`, `components/organizer/PicAssignmentManager.tsx`,
  `app/organizer/pic/page.tsx`. Auth: platform `pic.manage` for create/approve/suspend,
  tenant `pic.assign` for assignment.
- **Payments:** `lib/ticketing/payment/method-catalog.ts`,
  `components/ticketing/PaymentInstruction.tsx`,
  `prisma/migrations/20260917000000_add_payment_direct_instructions/migration.sql`.

## 12. Files/routes/services deleted

See §1. Full list: `git status --porcelain` → 316 `D` entries. Retail test suites
(`__tests__/admin/**`, `affiliate`, `marketing`, `p0`, `spin-wheel`, `shipping`,
`voucher-picker`, `broadcast`, `order-refund`, `transaction`, the retail security scanners)
and the Mantine dashboard test were removed with the code they tested.

## 13. Prisma changes

- Removed: all retail models (`Product*`, `Cart*`, `Order*` retail, `UserAddress`,
  `RajaOngkirRegion`, `Voucher*`, `Campaign*`, `FlashSale*`, `Promotion*`,
  `BulkDiscount*`, `SpinWheel*`, `Affiliate*`, `Broadcast*`, `Notification*`,
  `Marketing*`) and their enums.
- Retained deliberately: the legacy `User.role` enum including `AFFILIATOR` — it is
  `NOT NULL` with a default and typed on the Auth.js session, and dropping an enum value is
  a destructive `ALTER TABLE`. Authority in ticketing comes from `platformRole` + `lib/authz`,
  never this column. Documented inline in `prisma/schema.prisma`.
- Added (additive, non-destructive): `Payment.providerFlow`, `paymentNumber`, `qrString`,
  `qrImageUrl`, `paymentName`, `providerExpiredAt`.
- `npx prisma validate` → **valid**; `npx prisma migrate status` → **up to date** (19
  migrations). No generated client file was hand-edited.

## 14. Intentionally retained legacy identifiers

- `User.role` / `Role.AFFILIATOR` (see §13).
- `AdminAuditLog.adminId` (`String NOT NULL`) and `entityId` (`Int`) — the ticketing audit
  writer sets them rather than widening a live column.
- Comments in ticketing files that record *why* a path or mapping was chosen when retail
  existed (updated to past tense where they would otherwise read as current).

## 15. TypeScript

`npx tsc --noEmit` → **clean** (0 errors).

## 16. ESLint

`npx eslint .` → **45 problems (27 errors, 18 warnings)**, all **pre-existing** and outside
the new/changed surface: `no-explicit-any` in legacy `lib/services/auth.ts`,
`scripts/*`, `server.js` `require()` imports, `<img>` warnings, test-harness `any`.
The code I added/changed contributes **no new errors**; the only warning is an unused
`scope` parameter in `lib/pic/service.ts` — the identical convention (and warning) the
existing `lib/sports/service.ts` uses for API symmetry. The errors were **not** silently
"fixed" because they belong to files this task did not touch.

## 17. Prisma validation

Valid (see §13).

## 18. Tests

`npx jest --runInBand` → **43 suites passed, 984 tests passed, 0 failed.**
Architecture guards were updated to the new reality rather than deleted: the route
inventory now pins **21 pages** (including the three PIC surfaces), the authz
route-classification enumerates the ticketing-only API tree, and the CSP tests match the
narrowed origin set.

## 19. Production build

`npm run build` → **success.** All 25 API route groups and 21 pages compile; the three PIC
routes (`/api/admin/pic`, `/api/organizer/pic`, `/platform/pic*`, `/organizer/pic`) are in
the route manifest.

## 20. Remaining issues / manual configuration — READ THIS

1. **iPaymu channel activation (unverified).** The code calls the documented Direct
   Payment endpoint, but whether the merchant **account** has QRIS / VA / c-store enabled
   is not visible from this repository. `GET /api/v2/payment-channels` needs request-time
   credentials this build does not use. A channel the account has not activated is refused
   by iPaymu and surfaces as a failed attempt. **Enable the channels in the iPaymu dashboard
   before considering QRIS/VA live.**
2. **Webhook URL (unverified).** `notifyUrl` is derived from `getAppOrigin()`, which is
   allowlist-bound. The iPaymu account must point its callback at
   `POST /api/ticketing/payment/webhook` on the deployed origin with the same API key / VA
   used to sign. Until that is set, paid orders will not leave `PENDING` — the app will not
   mark them paid by itself.
3. **Credential presence.** `.env` contains iPaymu sandbox and production values, so the
   integration is configured, but no real sandbox transaction was executed as part of this
   task. **I am not claiming the live payment flow is proven end-to-end.** What is proven:
   correct endpoint, correct signed request, real returned fields persisted and rendered,
   and webhook-only status transition.

## 21. Remaining grep matches (and why each is acceptable)

Repository search for `affiliate|spin|wheel|shipping|Shipping|ongkir|courier|delivery`
across `app/ lib/ components/ prisma/ proxy.ts`:

- **`affiliate`** — only in comments explaining that the retail Affiliate was deleted
  (`lib/pic/service.ts`, `proxy.ts`, `prisma/schema.prisma`, register route/form, upload
  route, `lib/ticketing/audit-log.ts`, `lib/rate-limit.ts`, route inventory test). No
  user-facing string, no identifier, no route.
- **`spin` / `wheel`** — `animate-spin`/`Spinner` CSS in loaders, comments, and a test
  asserting the models are gone. No Spin Wheel feature.
- **`shipping` / `ongkir` / `courier` / `delivery`** — comments only: `deprecated: "…COD has
  nothing to deliver for a digital ticket"` in `method-catalog.ts` / `ipaymu.ts`,
  `rajaongkir` in the historical rate-limit note, `README`/report prose. No shipping field,
  route or calculation exists.
- **Markdown reports** (`TICKETING_*.md`, `TICKINGKLIK_*.md`) and `README.md` — historical
  documentation, left intact as the migration record.
- **`Role.AFFILIATOR`** — intentionally retained enum value (see §14).
