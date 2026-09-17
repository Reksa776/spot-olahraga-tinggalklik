# Ticketing Rebuild Audit

**Phase 0 — Ecommerce → Sports Event Ticketing Platform**
**Audit type:** read-only inspection. No source file, schema, migration, route, UI, auth, or payment code was modified. This document is the only file created.

**Repository:** `demo-marketplace` (package name `toko`), branch `main`
**Audit date:** 2026-09-16
**Method:** direct file inspection (`package.json`, `prisma/schema.prisma`, 115 API route files, 50 components, 56 `lib` modules, 16 migrations, CI workflows), plus `npx tsc --noEmit` and `npx eslint .` for objective quality signals. No runtime testing, no database access, no exploitation attempts.

---

## 1. Executive Summary

The application is a **single-merchant Indonesian ecommerce store** (Next.js 16 App Router + Prisma + MySQL + NextAuth v5 + iPaymu) with a surprisingly mature backend for payments, refunds, and transactional integrity. It is **not** a marketplace and has **no organizer/tenant concept whatsoever**.

### What is genuinely reusable (high confidence)

These are the assets that make the ticketing rebuild realistically cheap rather than a rewrite:

1. **Payment settlement engine.** `app/api/payment/ipaymu/notification/route.ts` implements a fail-closed webhook: raw-body HMAC-SHA256 signature verification, amount validation, status classification, and **atomic CAS (compare-and-swap) state transitions** via raw SQL `UPDATE ... WHERE status IN (...)`. Duplicate webhooks are idempotent by construction, and cancelled/expired/refunded orders can never be resurrected. This is exactly the property a ticketing platform needs — a ticket must never be issued by a browser redirect.
2. **Atomic inventory reservation.** `lib/checkout.ts` reserves flash-sale stock with `UPDATE flashsale SET saleStock = saleStock - n WHERE saleStock >= n` and treats `affectedRows === 0` as "sold out". That is the correct oversell-prevention primitive; ticket quota reservation should copy it verbatim.
3. **Provider-agnostic config with fail-closed validation.** `lib/payment/config.ts` (`PAYMENT_ENVIRONMENT ∈ {sandbox, production}`, per-environment credentials, base-URL allowlist, frozen config) and `lib/payment/ipaymu-production.ts`.
4. **Refund lifecycle.** `lib/refund.ts` has CAS-guarded `PENDING → PROCESSING → COMPLETED`, an idempotent `executeRefundCompletion()` shared by both admin and webhook paths, and a stock/voucher/affiliate restoration routine (`lib/order-stock.ts`).
5. **Notification foundation.** `Notification` model with a globally unique `idempotencyKey`, provider abstraction (`lib/notification/provider.ts`), and a WhatsApp provider — the same shape needed for e-ticket delivery.
6. **Auth skeleton.** NextAuth v5 with credentials + Google, JWT sessions, role in the token/session, and a route guard file (`proxy.ts`, the Next 16 rename of `middleware.ts`).
7. **Audit log.** `AdminAuditLog` + `lib/admin/audit-log.ts` — extend for check-in and organizer actions.

### What must change (the actual work)

1. **No tenant boundary.** Every ownership check in the codebase is `userId`-based. There is no `Organizer`, no scoping helper, and no reusable authorization primitive for "does this actor own this event". This is the single largest structural gap and the highest-risk area for data leakage in a multi-organizer platform.
2. **Product/Variant/Cart/Order/shipping is a retail domain.** `Product`, `ProductVariant`, `Cart`, `CartItem`, `UserAddress`, courier/`RajaOngkir`, weight, tracking numbers, and `Order_status.SHIPPED` have no place in ticketing and must be replaced by `Event` / `TicketType` / `Order` / `Ticket`.
3. **A purchase is one row; a ticket is many rows.** `OrderItem.quantity` represents N identical items. Ticketing needs **N individually identifiable `Ticket` rows with N distinct QR payloads**, a model that does not exist today.
4. **`Order` is overloaded with shipping + marketing attribution** (13 shipping fields, spin-wheel FKs, affiliate FK). It needs a clean rewrite as an event order.
5. **There is no expiry sweep and no persistent job runner.** Payment expiry currently depends on the gateway and on lazily cancelling a user's previous pending order at the next checkout. Ticket reservations (`TicketStatus.RESERVED` with `expiresAt`) require a scheduled reaper — the in-memory queue (`lib/notification/queue.ts`) explicitly self-documents as restart-lossy and is not a scheduler.
6. **`Role` (ADMIN/SELLER/CUSTOMER/AFFILIATOR) cannot express organizer/staff scoping.** `SELLER` is dead — the enum value and `/seller/dashboard` route string exist, but no seller page or seller-scoped API exists.

### Objective quality signals measured today

| Signal | Result |
| --- | --- |
| `npx tsc --noEmit` | **Clean, exit 0** (no type errors, whole project) |
| `npx eslint .` | **520 problems — 368 errors, 152 warnings** (`app/` 173e, `__tests__/` 97e, `lib/` 41e, `components/` 32e, `scripts/` 17e, `auth.ts` 4e, `server.js` 3e) |
| Test runner | `package.json` has **no `test` script**; `jest.config.js` `testMatch` covers only 5 of 15 test directories, so **~19 of 44 test files never run in any configured command** |
| Largest files | `app/buy-now/BuyNowPage.tsx` 4,009 lines; `app/checkout/CheckoutPage.tsx` 3,208; `lib/checkout.ts` 2,775 |
| Migrations | 16 (includes three consecutive `add_tiktok_pixel` migrations) |

### Verdict

Reuse is realistic for **payments, refunds, notifications, audit, auth, and the reservation/oversell pattern**. Everything user-facing and every domain model is a rebuild. The recommended path is **additive**: introduce `Organizer`/`Event`/`TicketType`/`Ticket`/`CheckIn` alongside the retail tables, re-point checkout and payment at the new order model, then delete the retail surface once no longer referenced. A destructive in-place rename of `Product` → `Event` is not recommended (see *Migration Risks*).

---

## 2. Current Technology Stack

Every row verified in the repository file named in the "Detected in" column.

| Concern | Technology | Version | Detected in |
| --- | --- | --- | --- |
| Framework | Next.js (App Router) | **16.3.0** (installed `node_modules/next/package.json`) | `package.json`, `app/layout.tsx` |
| Route guard convention | **`proxy.ts`** (Next 16 renamed `middleware.ts` → `proxy`) | — | `proxy.ts`; `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` states the `middleware` convention is deprecated |
| React | React / React DOM | 19.2.8 | `package.json` |
| Language | TypeScript | `^5`, `strict: true`, `noEmit`, path alias `@/*` | `tsconfig.json` |
| CSS | Tailwind CSS v4 via `@tailwindcss/postcss` | `tailwindcss ^4` | `postcss.config.mjs`, `app/globals.css` |
| Component library | **None** (hand-rolled) | — | `components/ui/Dialog.tsx` is the only shared primitive; + `clsx`, `tailwind-merge` |
| UI extras | framer-motion 13, swiper 14, react-icons 5, recharts 3, leaflet/react-leaflet | — | `package.json` |
| Database | **MySQL** | — | `prisma/schema.prisma` → `datasource db { provider = "mysql" }` |
| ORM | Prisma | `^6.19.3`, generator `prisma-client-js`, `binaryTargets` incl. debian openssl targets | `prisma/schema.prisma`, `lib/prisma.ts` |
| Auth | NextAuth v5 | `5.0.0-beta.32` + `@auth/prisma-adapter ^2.11.3`, **JWT session strategy** | `auth.ts`, `app/api/auth/[...nextauth]/route.ts` |
| Password hashing | bcryptjs | `^3.0.3`, cost 12 | `lib/password.ts` |
| Authorization | Role enum only (`ADMIN/SELLER/CUSTOMER/AFFILIATOR`) | — | `prisma/schema.prisma`, `lib/admin.ts`, `lib/csrf.ts` |
| Payment gateway | **iPaymu** (VA / QRIS redirect) | — | `lib/payment/ipaymu.ts`, `lib/payment/config.ts`, `lib/payment/ipaymu-production.ts` |
| Payment (dead) | Midtrans webhook route + type shim | — | `app/api/payment/midtrans/notification/route.ts`, `lib/types/midtrans.d.ts` |
| Validation | zod `^4.4.3` + react-hook-form `^7.84` + `@hookform/resolvers` | — | `lib/validations/register.ts`, `components/auth/*`; **API routes largely hand-roll validation** |
| HTTP client | axios `^1.19.0` | — | `lib/services/auth.ts`, `lib/rajaongkir.ts`, `lib/payment/ipaymu.ts` |
| State management | zustand `^5`, React Context | — | `components/products/ProductContext.tsx`, `components/providers/AuthProvider.tsx` |
| State (unused) | `@tanstack/react-query ^5` — **0 imports found** | — | `package.json` only |
| AI (unused) | `@google/genai ^2.16.0` — **0 imports found** | — | `package.json` only |
| File storage | Cloudinary `^2.10` **and** local filesystem (`storage/uploads/**` served by custom routes) | — | `lib/cloudinary.ts`, `lib/upload-to-cloudinary.ts`, `app/api/admin/upload/route.ts`, `app/api/uploads/products/[filename]/route.ts`, `UPLOAD_DIR` |
| Email | **None** | — | no mail dependency anywhere |
| Notification | WhatsApp via `@whiskeysockets/baileys 7.0.0-rc14`, provider abstraction + mock provider | — | `lib/notification/*`, `serverExternalPackages` in `next.config.ts` |
| Background jobs | **Custom in-memory queue** (self-documented as non-persistent, restart-lossy) | — | `lib/notification/queue.ts` |
| Cache | **None**; `REDIS_URL` exists only to emit a warning | — | `lib/rate-limit.ts`, `.env.example` |
| Rate limiting | Custom in-memory sliding window, per-process | — | `lib/rate-limit.ts` |
| Shipping data | RajaOngkir API + 5 normalized region tables | — | `lib/rajaongkir.ts`, `lib/rajaongkir/locations.ts`, models `Province/Regency/District/Village/RajaOngkirRegion` |
| Analytics | TikTok Pixel + custom `AnalyticsProvider` | — | `components/analytics/*` |
| Spreadsheet | `xlsx ^0.18.5` (tracking import/template, Excel reports) | — | `app/api/admin/orders/tracking-import/route.ts`, `app/api/admin/reports/excel/route.ts` |
| Testing | Jest 30 + ts-jest, node env | — | `jest.config.js`, `__tests__/**` (44 test files) |
| Deployment | GitHub Actions → SSH to VPS (`appleboy/ssh-action@v1.2.2`), Node 24 via nvm, custom `server.js` (standalone `http.createServer`) | — | `.github/workflows/deploy.yml`, `server.js` |
| Node runtime | CI uses `nvm use 24`; `@types/node ^20` | — | `.github/workflows/deploy.yml`, `package.json` |
| Docker / Compose | **None** | — | no `Dockerfile`/`compose` in repo |
| Env contract | 20+ vars incl. `DATABASE_URL`, `AUTH_SECRET`, `GOOGLE_*`, `IPAYMU_*`, `PAYMENT_ENVIRONMENT`, `RAJAONGKIR_API_KEY`, `WHATSAPP_AUTH_DIR`, `UPLOAD_DIR`, `TRUSTED_PROXY`, `REDIS_URL` | — | `.env.example` (committed), `.env` (present locally, gitignored) |

**Notable gap:** `.github/workflows/deploy.yml` runs `./deploy.sh` on the VPS, but **`deploy.sh` does not exist in the repository** — the deployment procedure is not version-controlled.

---

## 3. Current Architecture

### 3.1 Frontend

- **53 `page.tsx` files**, App Router, mixed server/client components. No `src/` directory; `@/*` maps to project root.
- Route surface (customer): `/` (landing), `/home` (catalog home), `/products`, `/products/[slug]`, `/cart`, `/buy-now`, `/checkout`, `/checkout/payment-finish`, `/checkout/success`, `/orders`, `/orders/[id]`, `/profile`, `/addresses/**`, `/campaigns`, `/promotions`, `/promos`, `/flash-sales`, `/faq`, `/kontak`, `/login`, `/register`, `/spin-wheel` (floating), legal pages.
- Route surface (admin): `/admin` + 25 sub-pages (products, orders, users, discounts, bulk-discounts, flash-sales, promotions, campaigns, vouchers, shipping-discounts, refunds, reports, settings, spin-wheel, broadcasts, whatsapp, affiliate{/manage,/payouts,/audit-log}).
- Route surface (affiliate): `/affiliate`, `/affiliate/dashboard`, `/affiliate/payouts`.
- **Dead route targets:** `proxy.ts` protects `/wishlist`, `/dashboard`, `/seller/:path*` — no corresponding pages exist.
- **Duplication:** `/` and `/home` are two separate landing implementations; `/promotions` and `/promos` overlap.
- State: local component state + `ProductContext` + `AuthProvider` (SessionProvider) + zustand. `@tanstack/react-query` is installed but unused — no consistent data-fetching layer.
- Data access: client components call `/api/*` directly with `fetch`; there is no typed API client. `lib/fetchWithRetry.ts` exists for retry behavior.
- Loading/error: `app/products/loading.tsx` + `components/skeletons/ProductSkeleton.tsx` only; most pages have no route-level `error.tsx`/`loading.tsx`.
- Responsive: Tailwind breakpoints throughout; `components/products/BottomNavbar.tsx` for mobile.

**Monolith risk:** `app/buy-now/BuyNowPage.tsx` (4,009 lines), `app/checkout/CheckoutPage.tsx` (3,208 lines) and `app/orders/[id]/page.tsx` (1,230 lines) are single-file UI + business logic. A ticketing checkout will need to be built as smaller composable pieces, not extended from these files.

### 3.2 Backend

- **115 API route handlers** under `app/api/**`. Layering is inconsistent by design:
  - `lib/**` holds real domain services: `checkout.ts`, `order-stock.ts`, `repay.ts`, `refund.ts`, `voucher.ts`, `spin-wheel.ts`, `cart-validation.ts`, `marketing/*` (12 modules), `affiliate/*` (6 modules), `notification/*` (7 modules), `payment/*`.
  - Many routes still contain their own Prisma queries and validation logic inline (`app/api/admin/**`, `app/api/affiliate/dashboard/route.ts` at 936 lines with heavy query logic in the handler).
- **Validation:** zod is used only for registration (`lib/validations/register.ts`). Every other endpoint performs ad-hoc `typeof` checks and numeric guards inline. There is no shared request schema layer.
- **Error handling:** consistent `try/catch` + `NextResponse.json({ success, message })` shape; some handlers attach `error.status` (e.g. `lib/checkout.ts` 404). Rollbacks are best-effort and log-only (`rollbackCheckoutOrder` failures are swallowed with `console.error`).
- **Transactions:** `createCheckoutOrder` runs one large `prisma.$transaction` (order creation, stock decrement, voucher CAS, flash-sale CAS, shipping-discount CAS, spin reservation) with **no explicit `timeout`**. Refund paths do set `{ timeout: 15000, maxWait: 10000 }`. External HTTP (RajaOngkir) is deliberately performed *before* the transaction; the iPaymu call is performed *after* order creation, with rollback on failure — a correct pattern worth preserving.
- **Authorization checks:** 88 of 115 route handlers call `await auth()`. All 60 `app/api/admin/**` handlers enforce an `ADMIN` role check (either `requireAdmin()` from `lib/admin.ts` or an inline `role === "ADMIN"`). `lib/csrf.ts#requireAdminSession` exists but has **zero call sites** (dead helper).
- **Middleware:** `proxy.ts` is an allow-list design — a `PUBLIC_API_PREFIXES` list, a `PROTECTED_API_PREFIXES` list (login-only check, no role check), and a default **pass-through** for anything not listed. `app/api/payment/status` is currently the only API route in neither list.

### 3.3 Cross-cutting

- `lib/rate-limit.ts` provides configured limiters for login, register, order creation, payment creation, upload, refund, repayment, shipping cost, spin, broadcast, affiliate payout.
- **`rateLimiters.login` is defined but never called** — see Security Findings S-4.
- `lib/admin/audit-log.ts` + `AdminAuditLog` model: admin actions are audited, but `adminId` is overloaded to hold `"SYSTEM"` / `"PROVIDER"` / `"PROVIDER_AUTO"` for non-human actors (`lib/refund.ts`), which will not scale to organizer/staff attribution.

---

## 4. Current Database

`prisma/schema.prisma` — MySQL, 30 models, 11 enums. 16 migrations, beginning with `0_baseline`. Default `@id @default(cuid())` for identity-ish models, `autoincrement()` for commerce tables.

> Naming inconsistency to be aware of: Prisma models are PascalCase with `@@map` to lowercase tables, but **enum names and enum members are snake/Pascal-mixed** (`Voucher_type`, `Order_status`, `Order_paymentStatus`, `Order_paymentMethod`). Prisma enum types are written (`ORDER_STATUS`) yet field names are camelCase. Any new ticketing model should use clean naming and not imitate this.

### 4.1 Identity & auth

| Model | Purpose | Keys / indexes | Ticketing reuse |
| --- | --- | --- | --- |
| `User` | Identity. `email` unique, `phone` unique, `password` nullable (OAuth), `role Role`, `referralCode` unique, `referredBy` | `@@map("user")`; unique email/phone/referralCode | **KEEP / MODIFY** — add organizer membership relations; `role` must stay for platform admin |
| `Account` | NextAuth OAuth accounts | `@@unique([provider, providerAccountId])`, index `userId` | KEEP |
| `Session` | NextAuth DB sessions | `sessionToken` unique | **DEPRECATE** — strategy is `"jwt"` in `auth.ts`, so this table is never written |
| `VerificationToken` | NextAuth email verification | composite unique | KEEP (unused today) |

### 4.2 Retail catalog & cart

| Model | Purpose | Keys / indexes | Ticketing reuse |
| --- | --- | --- | --- |
| `Product` | Store product: `slug` unique, `description`, `sold`, `rating`, `image`, `category String?`, `bestseller`, `isArchived`. Relations to discounts, flash sales, bulk discounts, campaigns, vouchers, affiliate clicks | `@@index([isArchived])` | **REPLACE** by `Event` (retail semantics: `sold`/`rating`/`bestseller` are meaningless for events) |
| `ProductVariant` | Sellable unit: `price Decimal(12,2)`, `stock Int`, `weight Int @default(100)`, `image` | `@@index([productId])` | **REPLACE** by `TicketType` (see §6) |
| `Cart` | One per user (`userId @unique`) | — | **MODIFY** — cart is optional for ticketing (direct buy is the norm), but a hold/cart helps multi-ticket-type orders |
| `CartItem` | `@@unique([cartId, variantId])`, quantity | indexes on productId, variantId | MODIFY |

### 4.3 Fulfilment (retail-only)

| Model | Purpose | Ticketing reuse |
| --- | --- | --- |
| `UserAddress` | Recipient, phone, address text, province/city/district/subdistrict/postalCode, `rajaOngkirDestinationId`, lat/long, `isDefault`, FKs to region tables. **8 indexes** | **DEPRECATE** → keep a minimal billing/contact profile; shipping fields and region FKs removable |
| `Order` | **13 shipping fields** (`shippingCost`, `shippingCourier`, `shippingService`, `trackingNumber`, `trackingUrl`, `city`, `district`, `province`, `postalCode`, lat/long), `paymentReference`, voucher fields, shipping-discount attribution, `affiliateConversion`, `spinWheelSpin`, `originalSpinWheelSpinId`, `refund` | **MODIFY → replace with `EventOrder`**; carry over only: `orderNumber` unique, `status`, `paymentStatus`, `paidAt`, `paymentReference`, `subtotal`, `total`, `voucher*`, `createdAt` |
| `OrderItem` | `productId?`/`variantId?` with `onDelete: SetNull`, **snapshot** of `productName`/`variantName`/`price`, `quantity`, `subtotal` | **MODIFY** — the price/name snapshot pattern is excellent and must be kept for ticket types |
| `Order_status` enum | `PENDING PAID PROCESSING SHIPPED COMPLETED CANCELLED REFUND_PENDING` | MODIFY → drop `SHIPPED` |
| `Order_paymentStatus` enum | `UNPAID PENDING PAID FAILED EXPIRED REFUNDED` | **KEEP** |
| `Order_paymentMethod` enum | `COD BANK_TRANSFER E_WALLET QRIS` | MODIFY → drop `COD` for ticketing |
| `Province/Regency/District/Village/RajaOngkirRegion` | 5 normalized shipping-region tables | **REMOVE (Phase 12)** |
| `StoreSetting` | Singleton `id = 1`: store name/logo/contact, `tiktokPixelId`, store address + `rajaOngkirDestinationId` (shipping origin) | MODIFY → `PlatformSetting`; per-organizer settlement identity goes on `Organizer`, not here |

### 4.4 Marketing, promo, loyalty

`Campaign` (+ `CampaignProduct`, `CampaignCategory`, enums), `ProductDiscount`, `FlashSale` (+ `FlashSalePurchase` with `@@unique([flashSaleId, userId])`), `BulkDiscount`, `ShippingDiscount` (+ quota CAS), `Voucher` (+ `VoucherProduct`, `VoucherCategory`, `VoucherUserUsage`), `Promotion` (banner), `SpinWheelCampaign/SpinWheelReward/SpinWheelSpin`.

Patterns worth carrying forward even where the model is dropped:

- `Voucher.quota` + `usedCount` with a transactional increment and post-increment limit re-check (`incrementVoucherUsage`, `incrementVoucherUserUsage` in `lib/voucher.ts`) — the *post-increment validation* is the race-safe idiom.
- `FlashSale.saleStock` + `soldCount` + `purchaseLimit` with a transactional `UPDATE ... WHERE saleStock >= n` reservation.
- `ShippingDiscount.quota` + `reserveShippingDiscountUsage` CAS.

### 4.5 Commerce operations

| Model | Purpose | Ticketing reuse |
| --- | --- | --- |
| `Notification` | Outbound message record; `idempotencyKey String @unique`, `status Notification_status`, `retryCount`/`maxRetries`, `payload`, optional `orderId`/`userId` | **KEEP** — repurpose for e-ticket delivery; extend with `ticketId` |
| `Broadcast` (+ 3 enums) | Marketing blasts by segment (BEST_SELLER, BUY_AGAIN, CART_REMINDER…) | DEPRECATE (segments are retail-specific); notification plumbing reusable |
| `AffiliateProfile/Kyc/Click/Conversion/Payout` | Full affiliate program incl. KYC (KTP image, bank account) and payout state machine | **DEPRECATE** — large surface, no ticketing requirement in MVP |
| `AdminAuditLog` | `adminId`, `action`, `entityType`, `entityId`, `description`, `metadata Json?`; 4 indexes | **KEEP + EXTEND** — the natural home for check-in and organizer audit trails |
| `Refund` | `orderId @unique`, `amount`, `reason`, `status RefundStatus`, `requestedBy`, `processedBy`, `providerRef` | **KEEP / MODIFY** — add per-ticket refund support and organizer approval |

### 4.6 Missing for ticketing (does not exist at all)

`Organizer`, `OrganizerMember`/`Staff`, `Sport`, `Venue`, `Event`, `EventImage`, `TicketType`, `Ticket` (per-attendee, QR-bearing), `CheckIn`, `PaymentTransaction`/`WebhookEvent` (raw provider event ledger), `PlatformFee`/`Settlement`/`Payout` to organizers, `TicketReservation`.

### 4.7 Index assessment

Present and useful: unique `Order.orderNumber`, `Order` indexes on `userId`, `status`, `paymentStatus`, `createdAt`, `trackingNumber`; `Notification.idempotencyKey` unique.

Gaps that will matter for ticketing:

- No **composite** indexes (e.g. `(status, paymentStatus)`, `(eventId, status)`) — the webhook and dashboard queries hit single-column indexes and will scan once data grows.
- No partial/quota-free pattern for a high-contention counter other than the raw-SQL CAS.
- No `(ticketTypeId, seatNumber)`-style unique constraint is possible today because seats do not exist.

---

## 5. Authentication & Authorization

### 5.1 Login flow (`auth.ts`)

- **Providers:** Credentials (`identifier` = email **or** phone, plus password) and Google. `pages.signIn = "/login"`.
- **Credentials path:** `prisma.user.findFirst({ OR: [{ email }, { phone }] })` → if not found, or if the user has no password (OAuth-only account), the code still calls `verifyPassword(password, "<dummy hash string>")` to equalize timing → then `bcrypt.compare`. `allowDangerousEmailAccountLinking: false` is explicitly set to prevent OAuth account takeover.
- **Session:** `strategy: "jwt"`. `jwt` callback copies `id` and `role` onto the token; `session` callback copies them onto `session.user`. Types are declared in `types/next-auth.d.ts`.
- **Registration:** `app/api/auth/register/route.ts` with `rateLimiters.register` (3/hour per IP) and zod validation via `lib/validations/register.ts`.

### 5.2 Role model

`enum Role { ADMIN, SELLER, CUSTOMER, AFFILIATOR }`.

| Role | Reality in code |
| --- | --- |
| `ADMIN` | Enforced on all 60 admin API routes and `/admin/**` pages |
| `SELLER` | **Dead** — appears in `app/api/admin/dashboard/route.ts` and two settings routes as an allowed role, in `/admin/users` display labels, and in `lib/auth.ts` (`/seller/dashboard`, no such page) |
| `CUSTOMER` | Default; no distinct capability beyond ownership of own orders/cart |
| `AFFILIATOR` | Set via `AffiliateProfile.status` flow; not used as an auth gate anywhere |

### 5.3 Enforcement layers

1. **`proxy.ts` (edge-ish guard):** for `/api/**`, returns 401 JSON when an unauthenticated request hits a `PROTECTED_API_PREFIXES` prefix. For page routes, redirects to `/login?callbackUrl=...`. **No role checks here.**
2. **Route handler (`auth()` + inline/`requireAdmin()`):** the real authorization layer. Ownership is enforced by adding `userId: session.user.id` to the `where` clause — verified in `app/api/orders/[id]/route.ts`, `app/api/payment/status/route.ts`, `lib/refund.ts` (`findFirst({ id, userId })`).
3. **Helpers:** `lib/admin.ts#requireAdmin()` (throws `UNAUTHORIZED`/`FORBIDDEN` — a thrown `Error` that route handlers must catch), `lib/csrf.ts#requireSession()` / `requireAdminSession()` (**0 call sites**, dead).

### 5.4 Assessment for a multi-organizer future

- **The isolation primitive does not exist.** There is no `organizerId` on any table, no scoping middleware, no `assertOrganizerOwnsEvent()` type helper, and no RLS (MySQL). Every organizer-facing query would have to remember to add its own ownership predicate. **This is the #1 structural risk for the ticketing platform.**
- **`proxy.ts` fails open.** Anything not in either prefix list passes through with no middleware check. A new `/api/organizer/**` route would be protected only if someone remembers to add it *and* the handler checks role + ownership.
- **Page-level protection is login-only.** `/admin/**` pages redirect unauthenticated users to login at the proxy layer, but the ADMIN role check happens per-page/per-route; a missed check is a page render for any logged-in customer.
- `role` is a plain `String` in the NextAuth type declarations (`types/next-auth.d.ts`) rather than the Prisma `Role` type, so role comparisons are stringly-typed and unverified at compile time.

---

## 6. Current Payment Architecture

### 6.1 Provider

**iPaymu** — redirect-based hosted payment (VA channels `bca/bni/bri/permata`, QRIS for QRIS and e-wallet). Config resolved by `lib/payment/config.ts`:

- `PAYMENT_ENVIRONMENT` must be exactly `sandbox` or `production` — **no default, fail-closed**.
- Credentials are read only for the selected environment (`IPAYMU_SANDBOX_VA`/`_API_KEY` vs `IPAYMU_PRODUCTION_*`).
- Base URL must be in a per-environment allowlist → blocks SSRF/misdirected funds.
- Production rejects sandbox-VA reuse and localhost/sandbox `NEXT_PUBLIC_APP_URL`.
- `buildIpaymuConfig()` returns a **frozen** object; `getIpaymuConfig()` memoizes it per process. `lib/payment/ipaymu-production.ts` adds a fail-fast validator + safe config summary (masked previews).
- Legacy vars (`IPAYMU_API_KEY`, `IPAYMU_VA`, `IPAYMU_IS_PRODUCTION`, `IPAYMU_URL`) are still read for backwards compatibility — dual-model debt.

### 6.2 Order → payment creation (`app/api/payment/ipaymu/route.ts`)

```
auth() → rate limit (orderCreation)
  → getIpaymuConfig() fail-closed
  → validate mode ∈ {CART, BUY_NOW}, paymentMethod ∈ {BANK_TRANSFER, E_WALLET, QRIS}, addressId, shipping
  → createCheckoutOrder()          [single DB transaction: pricing, voucher, shipping discount,
                                    spin reward, flash-sale CAS, stock decrement, Order + OrderItems]
  → build iPaymu product/qty/price arrays + shipping + negative discount lines
  → assert itemTotal === grossAmount (else rollback order and 500)
  → createRedirectPayment({ notifyUrl, returnUrl, cancelUrl, referenceId: order.orderNumber, expired: 1 })
  → return { paymentUrl }
  → on ANY failure: rollbackCheckoutOrder(orderId, { restoreCart: false })
```

The client is then redirected to the hosted iPaymu page. **The browser redirect is never the source of truth.**

### 6.3 Webhook settlement (`app/api/payment/ipaymu/notification/route.ts`)

Order of operations, all verified in code:

1. **Raw body read first** (`request.text()`) because the signature covers exact bytes.
2. **Header presence gate:** `X-Signature`, `X-Timestamp`, `X-External-ID` must all exist → else 401. (Only `X-Signature` is cryptographically verified; the route comments state that the real header set must be confirmed against a live sandbox transaction.)
3. **Config resolve** → `const { va } = getIpaymuConfig()`; missing VA → 500 (fail closed).
4. **Signature:** `verifyWebhookSignature(text, signature, va)` — HMAC-SHA256 with the merchant VA as key over the canonicalized body (parse → type-normalize → sort keys → `JSON.stringify` → escape `/`), timing-safe compare. Invalid → 401.
5. **Parse** form-urlencoded → map snake_case to the internal `IpaymuNotification` shape, including `status_code` 1→200 / 0→150 / ≥4→400.
6. **Safe logging only:** `reference_id`, `trx_id`, `status_code`, `has_sid` — no PII payload dump.
7. **Order lookup** by `ReferralId || SessionId` → `orderNumber`. Unknown order returns **200** so the gateway stops retrying.
8. **Amount validation:** `verifyNotificationAmount(body, order.total)` (prefers `sub_total`, excludes gateway fee). Mismatch → 400.
9. **Classification:** `classifyIpaymuNotification()` → `success | pending | failed | unknown`; unrecognized values are acknowledged with 200 and **never** mutate the order.
10. **Success → atomic CAS settlement:**
    ```sql
    UPDATE `order`
       SET status='PAID', paymentStatus='PAID',
           paidAt=IFNULL(paidAt, CURRENT_TIMESTAMP),
           paymentReference=COALESCE(?, paymentReference)
     WHERE id=? AND status IN ('PENDING','PROCESSING')
       AND paymentStatus NOT IN ('PAID','REFUNDED')
    ```
    `affectedRows === 0` ⇒ duplicate webhook (idempotent no-op) **or** a terminal state (CANCELLED/EXPIRED/REFUNDED) that cannot be resurrected. On success: selective cart cleanup, then out-of-band notification trigger (fire-and-forget with `.catch`).
11. **Pending:** CAS `status='PENDING', paymentStatus='PENDING'` guarded by `status IN ('PENDING','PROCESSING') AND paymentStatus != 'PAID'`.
12. **Failed:** CAS → `CANCELLED/FAILED`, then `releaseStockAndVoucherForOrder(tx, orderId)` and `cancelCommissionForOrder(tx, orderId, "ORDER_PAYMENT_FAILED")` in the same transaction.
13. **Refund:** detects `refund`/`refunded` statuses, finds-or-creates the `Refund` row (server-authoritative amount from `order.total`), `transitionRefundForWebhook()` CAS, then `executeRefundCompletion()`.
14. **Unhandled:** acknowledged 200, order untouched.
15. **Catch-all:** 500 so the gateway retries (deliberate, in case the DB is down).

### 6.4 What is solid vs. what is missing

| Property | Status | Evidence |
| --- | --- | --- |
| Server-side verification is source of truth | **Yes** | webhook CAS + amount check; redirect only for UX |
| Signature verification | **Yes, fail-closed** | `verifyWebhookSignature`, 401 paths |
| Duplicate webhook handling | **Yes** | CAS `affectedRows` semantics |
| Resurrection prevention | **Yes** | `status IN ('PENDING','PROCESSING') AND paymentStatus NOT IN ('PAID','REFUNDED')` |
| Amount/config tampering | **Yes** | server-side total, allowlisted base URL, frozen config |
| Refund lifecycle with idempotency | **Yes** | `lib/refund.ts`, `Refund.orderId @unique` |
| Stock/voucher restoration on failure | **Yes** | `lib/order-stock.ts` (documented idempotent) |
| **Expiration sweep** | **No** | no cron/job; relies on gateway expiry + `cleanupPendingCheckoutOrders()` cancelling the user's previous pending order during the *next* checkout |
| **Webhook event ledger** | **No** | no table storing raw provider events keyed by provider transaction id; replay detection is indirect (order state + `Refund.orderId` unique) |
| **Provider refund API call** | **Partial** | `executeRefundCompletion` completes the local record; `lib/payment/ipaymu.ts` refund capability must be verified for production |
| **Platform fee / split settlement** | **Absent** | `grossAmount = subtotal - discounts + shipping`; one merchant VA receives everything |
| **Repayment race** | Handled | `lib/repay.ts` re-reserves stock and re-enforces flash limits before a new attempt |

---

## 7. Ecommerce Feature Classification

Classifications: **KEEP** (reuse as-is / near-as-is) · **MODIFY** (good foundation, domain logic changes) · **REPLACE** (a different ticketing concept takes its place) · **DEPRECATE** (may remain temporarily, must disappear) · **REMOVE** (no meaningful ticketing role).

| Current Feature | Classification | Ticketing Replacement | Reason |
| --- | --- | --- | --- |
| User / Account / VerificationToken | **KEEP** | `User` | Identity, OAuth linking, unique email/phone are domain-neutral |
| `Session` table | **DEPRECATE** | — | JWT strategy is configured; the table is never written |
| `Role` enum (ADMIN/SELLER/CUSTOMER/AFFILIATOR) | **MODIFY** | Add `ORGANIZER` role + `OrganizerMember` scoping | Role alone cannot express "which organizer"; SELLER is already dead |
| `Product` | **REPLACE** | `Event` | Retail fields (`sold`, `rating`, `bestseller`) are meaningless for events |
| `ProductVariant` | **REPLACE** | `TicketType` | Price + stock + per-variant identity ≈ ticket type with quota + sales window |
| `Product.category` (free-text) | **REPLACE** | `Sport` (+ optional `EventCategory`) | Sports communities need a controlled taxonomy |
| Stock/inventory (`ProductVariant.stock`) | **MODIFY** | `TicketType.quota/sold/reserved` + reservation CAS | The atomic conditional-update pattern is reusable; the field semantics must split into reserved vs issued |
| `Cart` / `CartItem` | **MODIFY** | Optional ticket cart / hold | Useful for multi-ticket-type orders; must gain reservation expiry |
| `UserAddress` | **MODIFY** | Customer contact profile (name/phone/email) | Ticketing needs a buyer identity, not a shipping destination |
| Address region FKs + `Province/Regency/District/Village/RajaOngkirRegion` | **REMOVE** | — | Pure logistics data |
| RajaOngkir integration (`lib/rajaongkir.ts`, `/api/rajaongkir/**`) | **REMOVE** | — | No shipping in ticketing |
| Shipping cost verification (`verifyShippingCost`, `/api/shipping/cost`) | **REMOVE** | — | No shipping |
| Weight on variants | **REMOVE** | — | Logistics-only |
| `Order` | **MODIFY** | `EventOrder` | Keep order number, status machine, payment status, paidAt, totals, audit; drop all 13 shipping fields and marketing FKs |
| `OrderItem` | **KEEP / MODIFY** | `OrderItem` (ticket type line) | The name/price **snapshot** design is exactly right and must be preserved |
| `Order_status.SHIPPED` / `PROCESSING` shipment flow | **REMOVE** | — | Replaced by ticket issuance + check-in |
| Tracking number/URL, `TrackingTimeline`, tracking import/template/error reports | **REMOVE** | — | Courier logistics |
| COD payment method | **REMOVE** | — | Ticket orders must be prepaid; unpaid = no ticket |
| iPaymu integration (`lib/payment/*`) | **KEEP** | Same gateway, new order model | Fail-closed config + CAS settlement is production-grade |
| Webhook settlement CAS | **KEEP** | Same, extended to issue tickets | Only trustworthy issuance trigger |
| `Refund` | **MODIFY** | `Refund` (+ per-ticket refund) | Keep CAS + idempotency; add organizer approval and ticket voiding |
| `Notification` | **KEEP / MODIFY** | E-ticket delivery + event reminders | `idempotencyKey` unique is the right foundation |
| `Broadcast` | **DEPRECATE** | Event announcement to attendees | Segments are retail-specific (BEST_SELLER, BUY_AGAIN, PRICE_DROP) |
| WhatsApp provider (Baileys) | **MODIFY** | Same, for e-tickets | Works, but see dep/ToS risk and in-memory queue |
| In-memory notification queue | **REPLACE** | Persistent job runner (DB-backed or BullMQ+Redis) | Self-documented as restart-lossy |
| `Voucher` (+ product/category restrictions, per-user usage) | **KEEP / MODIFY** | Coupon scoped to event/organizer | Quota CAS + per-user limit machinery is directly reusable |
| `FlashSale` (+ `FlashSalePurchase`) | **MODIFY** | Early-bird / presale window with per-buyer limit | Sales-window + limit + atomic stock is exactly the early-bird problem |
| `ProductDiscount` | **DEPRECATE** | Ticket price periods | Superseded by `TicketType` time-based pricing |
| `BulkDiscount` | **DEPRECATE** | Group/team bundle pricing (optional) | Nothing depends on it for ticket sales |
| `ShippingDiscount` | **REMOVE** | — | No shipping |
| `Campaign` (multi-product/category markdown) | **DEPRECATE** | Event promo badge (optional) | Built around product catalogs |
| `Promotion` (banner) | **MODIFY** | Event promo banner | Banner placement is generic |
| `SpinWheel*` | **DEPRECATE** | Promo gamification for ticket discounts (optional) | 3 models + CAS logic for a non-core feature |
| `Affiliate*` (5 models, KYC, payouts) | **DEPRECATE** | Organizer referral (optional, later) | Large surface with no MVP ticketing requirement |
| `AdminAuditLog` | **KEEP / MODIFY** | Audit for admin, organizer, and check-in actions | Extend `entityType`/`metadata`; add organizer scope |
| `StoreSetting` | **MODIFY** | `PlatformSetting` | Single-merchant model; organizer settlement identity must move to `Organizer` |
| Midtrans route/types/`MidtransItem`/`getEnabledPayments` | **REMOVE** | — | Dead code; only iPaymu is wired |
| `rating` / `sold` counters / review UX | **REMOVE** | Event popularity via real ticket sales if needed | No reviews in scope |
| `/checkout/payment-finish` polling (`/api/payment/status`) | **KEEP** | Same pattern, ticket-aware | Correct: UI polls, webhook decides |
| Root `products.ts` demo catalog, `=`, `toko_backup.sql` | **REMOVE** | — | Dead artifacts |

---

## 8. Reusable Foundations

Ranked by rebuild leverage.

1. **iPaymu payment adapter + fail-closed config** — `lib/payment/ipaymu.ts` (1,036 lines), `config.ts`, `ipaymu-production.ts`, `app/api/payment/ipaymu/route.ts`. Reuse wholesale; only the item/description lines change (ticket types instead of products) and a platform-fee line is added.
2. **Webhook settlement state machine** — `app/api/payment/ipaymu/notification/route.ts`. Reuse; extend the success branch to issue `Ticket` rows (inside the same transaction) and to write a `WebhookEvent` ledger row.
3. **Atomic reservation / oversell guard** — the `UPDATE ... WHERE saleStock >= n` + `affectedRows === 0` idiom in `lib/checkout.ts`. Copy for `TicketType.quota`.
4. **`releaseStockAndVoucherForOrder` (`lib/order-stock.ts`)** — the "give the held resource back" routine. Becomes `releaseTicketReservationForOrder`.
5. **`lib/refund.ts`** — CAS transitions, shared `executeRefundCompletion`, provider-refund reconciliation, `transitionRefundForWebhook` (which handles "provider confirmed before admin approved"). Directly reusable for ticket refunds.
6. **`lib/repay.ts`** — repayment eligibility + re-reservation. Reusable for "pay later / resume payment" on ticket orders.
7. **`lib/rate-limit.ts`** — configured limiters. Reuse (and actually wire `login`, and move to Redis for multi-instance).
8. **`lib/admin/audit-log.ts` + `AdminAuditLog`** — reuse and extend for check-in audit.
9. **`lib/notification/*`** — provider abstraction, idempotency key, retry counters. Reuse for e-ticket delivery; replace the queue.
10. **Auth (`auth.ts`, `types/next-auth.d.ts`, `lib/admin.ts`)** — reuse; add organizer/staff claims.
11. **`lib/voucher.ts`** — enhanced validation with product/category restrictions, per-user usage and post-increment race check. Reuse with event scoping.
12. **UI shell** — `components/products/Header.tsx`, `BottomNavbar.tsx`, `Footer.tsx`, `components/ui/Dialog.tsx`, skeletons, `lib/app-origin.ts`, `lib/fetchWithRetry.ts`, toast patterns.
13. **Ops** — `.github/workflows/deploy.yml` (SSH deploy), `server.js`, CSP/security headers in `next.config.ts`, Jest setup.

---

## 9. Features To Modify

| Feature | Current shape | Required change |
| --- | --- | --- |
| `Role` / authorization | 4 flat roles, `userId`-only ownership | Add `ORGANIZER` + `OrganizerMember` (owner/manager/staff), a single `requireOrganizerScope()` helper, and make every organizer query pass through it |
| `Order` | Retail order with 13 shipping fields + marketing FKs | New `EventOrder` (event-scoped, platform fee, organizer amount); keep number/status/paidAt/paymentReference |
| `OrderItem` | Snapshot product/variant name + price | Snapshot ticket-type name + unit price; add `quantity` + link to issued tickets |
| Inventory | `ProductVariant.stock` decrement | Split `quota` into `reserved` vs `sold`; reserve → confirm on payment; release on expiry |
| `Cart` | Variant quantities, no expiry | Optional: reserve ticket types on add with `expiresAt`, or switch to direct buy-now |
| Checkout (`lib/checkout.ts`) | 2,775-line retail checkout | New, smaller `lib/ticketing/checkout.ts`; do not extend this file |
| `UserAddress` | Shipping destination + region FKs | Reduce to buyer contact (name/phone); keep address only if invoicing needs it |
| `Voucher` | Product/category restrictions, min purchase | Restrict by event/organizer/sport; keep quota + per-user CAS |
| `FlashSale` | Variant-scoped flash price | Presale/early-bird window on `TicketType` |
| `Refund` | Per-order refund | Support per-ticket-type / per-ticket refund; organizer-initiated |
| `Notification` | Order status changes | Ticket issued, event reminder, refund, check-in receipt; add `ticketId` |
| `AdminAuditLog` | `adminId` string | Add actor type (admin/organizer/staff/system) + organizer scope for filtered views |
| `StoreSetting` | Single store identity | `PlatformSetting`; merchant identity per `Organizer` |
| `proxy.ts` | Prefix allow-lists, auth-only | Add `/api/organizer/**` + `/api/check-in/**`, and make the default **deny** for new protected namespaces |
| Pagination/filtering APIs | Ad-hoc per route | Shared typed query layer (zod schema + `orderBy` allowlist) — note `lib/security`-style sortBy allowlisting already exists in tests (`__tests__/security/l2-sortby-injection.test.ts`) |

---

## 10. Features To Deprecate

Keep in the database for migration/backward compatibility, delete in Phase 12:

- `SpinWheelCampaign`, `SpinWheelReward`, `SpinWheelSpin` (+ the floating button/popup UI).
- `AffiliateProfile`, `AffiliateKyc`, `AffiliateClick`, `AffiliateConversion`, `AffiliatePayout` and the entire `/affiliate/**` + `/admin/affiliate/**` surface.
- `Broadcast` + `app/admin/broadcasts`, `app/admin/whatsapp`.
- `ProductDiscount`, `BulkDiscount`, `ShippingDiscount`.
- `Campaign`, `CampaignProduct`, `CampaignCategory`.
- `Province/Regency/District/Village/RajaOngkirRegion` (after shipping code stops querying them).
- `UserAddress` shipping-specific columns (`weight`, courier origins, region FKs).
- Old Midtrans type shims (`lib/types/midtrans.d.ts`) — prefer `REMOVE`; listed here only because tests may import them.

---

## 11. Features To Remove

No meaningful ticketing role — delete, do not migrate data:

- Shipping: `shippingCost`/`shippingCourier`/`shippingService`/`trackingNumber`/`trackingUrl` on `Order`; `TrackingTimeline` component; `/api/orders/[id]/tracking`; `/api/admin/orders/[id]/tracking`; `tracking-import`, `tracking-template`, `tracking-error-report` routes; `/api/shipping/*`; `lib/rajaongkir*`; `verifyShippingCost`; `getShippingCost`; `ProductVariant.weight`.
- `Order_status.SHIPPED` and `Order_paymentMethod.COD` (and the COD branch in `/api/orders`).
- Region/address API surface: `/api/rajaongkir/**`, `/api/admin/settings/regions/**`, `LocationPickerMap`, `app/addresses/**`, `lib/rajaongkir/locations.ts`, `prisma/seed-regions.{js,ts}`.
- Marketing/promo engines not carried forward: `lib/marketing/bulk-discount.ts`, `shipping-discount.ts`, `promotion.ts` (if banners are re-implemented), `lib/marketing/pricing.ts` **or** `batch-pricing.ts` (pick one — they overlap).
- Dead code & artifacts: `app/api/payment/midtrans/notification/route.ts`, `lib/types/midtrans.d.ts`, `getEnabledPayments()`, `MidtransItem`/`createMidtransItemDetails`/`validateItemDetailsTotal` (retail-specific naming), `products.ts` (root demo catalog), `prisma/schema.prisma.bak`, `prisma/schema.after-pull.prisma`, empty `=` and `toko_backup.sql` files, `app/api/address/route.ts` (duplicate of `app/api/addresses`), `/promos` **or** `/promotions`, `/` **or** `/home`.
- Unused dependencies: `@google/genai`, `@tanstack/react-query`, and (after affiliate removal) `axios` if it becomes single-use, `qrcode-terminal`.
- **Committed PII:** `storage/uploads/affiliate/ktp/**` (KTP ID scans) — must be purged from the working tree *and history*, and `storage/` added to `.gitignore`. See S-1.

---

## 12. Proposed Ticketing Architecture

### 12.1 Shape

```
PLATFORM (ADMIN)
│   users, sports, venues, organizers, transactions, fees, refunds, config
│
├── ORGANIZER A (owner, managers, staff)
│   ├── events (draft → published → live → ended → settled)
│   │   ├── ticket types (quota, price, sales window, per-buyer limit)
│   │   └── attendees / orders / revenue / check-in
│   └── payouts (settlement statements)
│
└── ORGANIZER B
    └── event, ticket types, attendees...
```

### 12.2 Layering (target)

| Layer | Module | Rule |
| --- | --- | --- |
| Route handlers | `app/api/**` | Thin: parse + validate (zod) + authorize + call service |
| Authorization | `lib/authz/*` | **Single** source of truth: `requireAdmin()`, `requireOrganizerScope(organizerId)`, `requireEventScope(eventId, capability)`, `requireStaffForEvent(eventId)` |
| Domain services | `lib/ticketing/*` | `events.ts`, `ticket-types.ts`, `orders.ts`, `reservations.ts`, `issuance.ts`, `checkin.ts`, `pricing.ts`, `fees.ts` |
| Data access | Prisma in services only; no Prisma in route handlers | Eliminates the current inline-query sprawl |
| Payments | `lib/payment/*` (existing) + `lib/ticketing/payable.ts` | Gateway-agnostic: a service exposes `createPayment(order)` / `settleWebhook(event)` |
| Jobs | `lib/jobs/*` + a real runner (cron endpoint or worker) | `expireReservations`, `autoCancelUnpaidOrders`, `sendTicketEmails`, `settleOrganizer` |
| Notifications | existing `lib/notification/*` with a DB-backed queue | Idempotent, retryable, restart-safe |

### 12.3 Capability matrix (single source of truth for authz)

| Capability | Admin | Organizer owner | Organizer manager | Staff | Customer |
| --- | --- | --- | --- | --- | --- |
| Manage sports/venues | ✅ | — | — | — | — |
| Approve organizers | ✅ | — | — | — | — |
| Create/edit/publish event | — | ✅ | ✅ | optional | — |
| Manage ticket types/prices/quota | — | ✅ | ✅ | — | — |
| View orders/attendees/revenue | ✅ | ✅ (own) | ✅ (own) | limited | own orders |
| Refund / void tickets | ✅ | ✅ (own) | optional | `validate` only | request |
| Scan/validate QR | ✅ | ✅ | ✅ | ✅ (assigned events) | — |
| Platform fee config | ✅ | — | — | — | — |
| View/settle payouts | ✅ | ✅ (own) | — | — | — |

Enforcement: each handler resolves the actor → `ActorContext { userId, role, organizerId?, staffEvents[] }` → passes it to the service, which **must** receive `organizerId` (never derive it from request body/query).

---

## 13. Proposed Data Model

Proposed only — **no schema changes were made in this phase.**

### `User` (MODIFY)
Keep as-is (id cuid, unique email/phone, bcrypt password, `role`). Add relations: `ownedOrganizers Organizer[]`, `organizerMemberships OrganizerMember[]`, `orders EventOrder[]`, `tickets Ticket[]`, `checkIns CheckIn[]`.
- Indexes: existing unique email/phone. Add `@@index([role])` if admin user lists grow.

### `Organizer` (NEW)
Purpose: tenant boundary. Owner entity for events and settlement.
Fields: `id`, `ownerUserId`, `name`, `slug @unique`, `description`, `logoUrl`, `phone`, `email`, `status OrganizerStatus` (`PENDING|ACTIVE|SUSPENDED|REJECTED`), `verifiedAt`, `commissionRate Decimal(5,2)` (platform fee %), `bankName`/`bankAccountName`/`bankAccountNumber` (settlement identity), `createdAt`, `updatedAt`.
Indexes: `slug` unique, `ownerUserId`, `status`.

### `OrganizerMember` (NEW)
Staff/manager membership and the basis for staff permissions.
Fields: `id`, `organizerId`, `userId`, `role MemberRole` (`OWNER|MANAGER|STAFF|FINANCE`), `status` (`INVITED|ACTIVE|REVOKED`), `permissions Json?` (capability overrides), `invitedBy`, timestamps.
Indexes: `@@unique([organizerId, userId])`, `@@index([userId])`, `@@index([organizerId, role])`.

### `Sport` (NEW)
Controlled taxonomy: `id`, `name`, `slug @unique`, `iconUrl`, `isActive`, `sortOrder`.
Indexes: `slug` unique, `(isActive, sortOrder)`.

### `Venue` (NEW)
`id`, `organizerId?` (nullable = platform-global venue), `name`, `address`, `city`, `province`, `latitude Decimal(10,7)?`, `longitude Decimal(10,7)?`, `capacity Int?`, timestamps.
Indexes: `organizerId`, `(city, name)`.

### `Event` (NEW — replaces `Product`)
Fields: `id`, `organizerId` (**required**, isolation key), `sportId`, `venueId`, `title`, `slug @unique`, `description @db.Text`, `bannerUrl`, `status EventStatus` (`DRAFT|PUBLISHED|CANCELLED|COMPLETED`), `isPublished Boolean`, `startAt`, `endAt` (nullable for running events), `salesStartAt`, `salesEndAt`, `timezone`, `requiresCheckIn Boolean`, `maxTicketsPerOrder Int?`, `refundPolicy @db.Text`, `publishedAt`, `createdByUserId`, timestamps, optional `deletedAt` (soft delete).
Indexes: `@@index([status, startAt])`, `@@index([organizerId, status])`, `@@index([sportId, startAt])`, `slug` unique. Optional MySQL `FULLTEXT` index on `(title, description)` for search.
Rules: `organizerId` is immutable after creation (audit); `salesEndAt <= startAt` validated in service.

### `EventImage` (NEW)
`id`, `eventId`, `url @db.Text`, `sortOrder`, `createdAt`. Index `eventId`.

### `TicketType` (NEW — replaces `ProductVariant`)
Fields: `id`, `eventId`, `name` (e.g. "Tribun", "VIP", "Early Bird"), `description`, `price Decimal(12,2)`, `currency` (default `IDR`), `quota Int` (hard cap), `sold Int @default(0)`, `reserved Int @default(0)`, `minPerOrder Int @default(1)`, `maxPerOrder Int?`, `salesStartAt`, `salesEndAt`, `isActive Boolean`, `sortOrder`, `version Int @default(0)` (optimistic lock), timestamps.
Indexes: `@@index([eventId, isActive, sortOrder])`, `@@index([eventId, salesStartAt, salesEndAt])`, optional `@@unique([eventId, name])`.
Invariants: `reserved + sold <= quota` (enforced by conditional UPDATE, not by a trigger); `price >= 0`.

### `EventOrder` (NEW — replaces `Order`)
Fields: `id`, `orderNumber String @unique`, `organizerId` (**denormalized isolation key**), `eventId`, `userId`, `buyerName`, `buyerEmail`, `buyerPhone`, `status OrderStatus` (`PENDING|PAID|CANCELLED|EXPIRED|REFUNDED|COMPLETED`), `paymentStatus PaymentStatus` (`UNPAID|PENDING|PAID|FAILED|EXPIRED|REFUNDED|PARTIALLY_REFUNDED`), `subtotal`, `discount`, `platformFee`, `paymentFee`, `total`, `organizerAmount`, `voucherId?`, `voucherCode?`, `paidAt`, `expiresAt` (payment window), `paymentReference`, `paymentMethod`, `note`, timestamps.
Indexes: `orderNumber` unique, `@@index([userId, createdAt])`, `@@index([eventId, status])`, `@@index([organizerId, status])`, `@@index([status, paymentStatus])`, `@@index([expiresAt])`.
Rules: totals are computed server-side only; `organizerAmount = subtotal - discount - platformFee` (fees never derived from client input).

### `OrderItem` (MODIFY)
`id`, `orderId`, `ticketTypeId?` (`SetNull`), `nameSnapshot`, `priceSnapshot Decimal(12,2)`, `quantity`, `subtotal`, `createdAt`. Indexes: `orderId`, `ticketTypeId`.
Snapshot-first design (carried over from the retail `OrderItem`) so a later ticket-type rename never rewrites history.

### `Ticket` (NEW — the core missing entity)
One row **per attendee**, generated on settlement.
Fields: `id`, `ticketCode String @unique` (human-readable, e.g. `EVT-XXXX-XXXX`), `qrPayloadHash String @unique` (or `qrSecret` for HMAC), `orderId`, `orderItemId`, `ticketTypeId`, `eventId` (**denormalized** for fast validation), `organizerId` (denormalized), `userId`, `attendeeName`, `attendeeEmail?`, `attendeePhone?`, `status TicketStatus` (`RESERVED|ISSUED|CHECKED_IN|VOID|REFUNDED|EXPIRED`), `issuedAt`, `reservedUntil` (only meaningful while `RESERVED`), `checkedInAt`, `seatLabel?`, `createdAt`, `updatedAt`.
Indexes: `ticketCode` unique, `qrPayloadHash` unique, `@@index([orderId])`, `@@index([eventId, status])`, `@@index([userId, status])`, `@@index([ticketTypeId, status])`, `@@index([reservedUntil])`.

### `CheckIn` (NEW)
`id`, `ticketId **@unique**` (this single constraint is the duplicate-scan guarantee), `eventId`, `staffUserId`, `staffOrganizerMemberId?`, `scannedAt`, `method` (`QR_SCAN|MANUAL`), `deviceId?`, `ipAddress?`, `result` (`ACCEPTED|REJECTED_ALREADY_CHECKED_IN|REJECTED_INVALID|REJECTED_WRONG_EVENT|REJECTED_UNPAID`), `note`, `createdAt`.
Indexes: `ticketId` unique, `@@index([eventId, scannedAt])`, `@@index([staffUserId, scannedAt])`.

### `Payment` / `PaymentTransaction` (NEW)
- `Payment`: logical attempt per order — `id`, `orderId`, `provider` (`ipaymu`), `method`, `channel`, `amount`, `status`, `externalSessionId`, `paymentUrl`, `expiresAt`, `createdAt`, `updatedAt`. Index `orderId`, `(orderId, status)`, `externalSessionId`.
- `PaymentTransaction` / `WebhookEvent`: append-only provider-event ledger — `id`, `paymentId?`, `orderId?`, `provider`, `providerEventId String` (**unique** = replay/replay-insert protection), `providerTransactionId`, `eventType`, `statusCode`, `amount`, `rawPayload Json` (redacted), `signatureValid Boolean`, `processingResult`, `processedAt`, `createdAt`. Indexes: `providerEventId` unique, `(orderId, createdAt)`, `(provider, createdAt)`.
Purpose: make webhook replay-deduplication a database guarantee rather than an inference from order state, and make payment disputes auditable.

### `Refund` (MODIFY)
Add `organizerId`, `ticketIds Json?` (or a `RefundTicket` join table for partial refunds), `approvedByUserId`, keep `orderId @unique` **only if** one refund per order is acceptable for MVP; otherwise drop the unique and add `@@index([orderId, status])`.

### `Coupon` (reuse `Voucher` with MODIFY)
Add `organizerId?` (null = platform-wide), `eventId?`, `sportId?`; keep `code @unique`, `quota`/`usedCount`, `maxUsagePerUser`, `minPurchase`, `startDate`/`endDate`, `eligibility`. Keep the CAS increment + post-increment limit check.

### `Notification` (MODIFY)
Add `ticketId?`, `eventId?`, `organizerId?`, template key; keep `idempotencyKey @unique` and retry fields.

### `OrganizerPayout` / `Settlement` (NEW, post-MVP)
`id`, `organizerId`, `periodStart`, `periodEnd`, `grossAmount`, `platformFee`, `paymentFee`, `netAmount`, `status` (`PENDING|PROCESSING|PAID|FAILED`), `providerReference`, `proofFilePath`, `processedByUserId`, timestamps. Indexes: `(organizerId, periodStart)`, `status`, unique `(organizerId, periodStart, periodEnd)`.
Reuse the existing affiliate payout state machine's shape as a template.

### `PlatformSetting` (MODIFY of `StoreSetting`)
Platform identity, default fee rate, fee mode (`ABSORB_BY_ORGANIZER|PASS_TO_BUYER`), payment provider environment, support contacts.

### Removed from the target model
`Product`, `ProductVariant`, `Cart`/`CartItem` (unless a hold cart is kept → MODIFY), `UserAddress` shipping fields, all region tables, `ShippingDiscount`, `BulkDiscount`, `ProductDiscount`, `FlashSale*`, `Campaign*`, `SpinWheel*`, `Affiliate*`, `Broadcast`.

---

## 14. Payment Architecture

### 14.1 Target lifecycle

```
Order created (PENDING / UNPAID)
   ↓  ticket types reserved atomically (reserved += n, guarded by quota)
Payment created (provider session + Payment row, expiresAt set)
   ↓  customer redirected to gateway (UX ONLY)
Customer pays
   ↓
Webhook received (server-to-server)
   ↓  1. read raw body
   ↓  2. verify signature (HMAC) → 401 on failure
   ↓  3. verify amount == order.total → 400 on mismatch
   ↓  4. insert WebhookEvent(providerEventId UNIQUE) → duplicate ⇒ 200 no-op
   ↓  5. CAS: order UNPAID/PENDING → PAID   (terminal states never resurrected)
   ↓  6. in the SAME transaction: reserved -= n, sold += n
   ↓  7. ISSUE one Ticket row per seat/quantity (status ISSUED, code + QR secret)
   ↓  8. commit
   ↓  (after commit, idempotently) enqueue E-TICKET delivery + organizer notification
PAID  →  organizer dashboard reflects sales
```

**The browser redirect never grants a ticket.** The polling endpoint (`/api/payment/status` pattern, already implemented) is display-only.

### 14.2 Edge-case matrix

| Case | Required behaviour | Reuse from today |
| --- | --- | --- |
| Payment expiration | Scheduler sets `Order.EXPIRED` + `paymentStatus EXPIRED`, releases `reserved` quota, voids the gateway session. Never rely on the user to come back. | **Missing** — must be built (F-1) |
| Failed payment | CAS to `CANCELLED/FAILED` + release reservations + cancel commissions, in one transaction | Yes — webhook failed branch |
| Cancelled by user | Allowed only while `PENDING/UNPAID`; release quota; preserve audit trail | Partially — `cancelOwnPendingOrder()` exists |
| Duplicate webhook | `WebhookEvent.providerEventId` unique → 200 no-op; CAS is a second guard | Yes (CAS); ledger is new |
| Webhook replay (valid signature, old body) | Ledger insert fails on unique → no-op; state CAS also fails | Partially |
| Unknown/ambiguous status codes | Acknowledge 200, never mutate | Yes — `classifyIpaymuNotification` |
| Quota race / overselling | Conditional `UPDATE tickettype SET reserved = reserved + n WHERE reserved + sold + n <= quota`; `affectedRows === 0` ⇒ sold out. Optionally `SELECT ... FOR UPDATE` for multi-row orders. | Yes — flash-sale idiom |
| Order spanning multiple ticket types | All reservations inside a single short transaction; any failure ⇒ full rollback | Yes — `createCheckoutOrder` pattern |
| Ticket issuance crash mid-flow | Issuance is inside the settlement transaction ⇒ atomic. A reconciliation job re-issues if `PAID` and ticket count < paid quantity | New |
| Refund lifecycle | `PENDING → PROCESSING → COMPLETED/FAILED` with CAS; void tickets; return quota (or not, per policy — decide explicitly); organizer approval optional | Yes — `lib/refund.ts` |
| Partial refund | Per-ticket refund: void only the refunded tickets, keep the rest `ISSUED` | New — needs `RefundTicket` |
| Repayment | Reuse `lib/repay.ts` shape: eligibility + re-reserve quota before a new gateway session | Yes |

### 14.3 Gateway facts that must be verified with iPaymu before design freeze

1. **`expired` semantics.** The code passes `expired: 1` — confirm the unit (hours vs minutes) and whether the gateway enforces it, then set `Order.expiresAt` from the same value.
2. **Callback header set.** The route requires `X-Signature` + `X-Timestamp` + `X-External-ID` but only verifies the signature. Confirm against a live sandbox transaction; if the extra headers are absent, relax only the header checks — never the signature.
3. **Refund API.** Confirm whether iPaymu supports programmatic refunds, full vs partial, and the resulting callback; `executeRefundCompletion` currently completes locally.
4. **Multi-tenant settlement.** Confirm whether the account can support per-organizer sub-accounts / escrow / split disbursement, or whether settlement is a platform-controlled bank transfer after the fact. **This determines the entire payout architecture.**
5. **Fee disclosure.** Confirm whether the gateway fee can be reported per transaction and whether the payload distinguishes `sub_total` (order amount) from `amount` (with fee) — the current code depends on `sub_total` being the order total.
6. **Idempotent session creation.** Confirm whether a duplicate `/payment` call for the same `referenceId` returns the same session or creates a new one.

---

## 15. Ticket Lifecycle

```
  Ticket Available  (quota - reserved - sold > 0, within sales window)
        ↓  add to cart / buy now
     Reserved       (reserved += n, reservedUntil = now + TTL, e.g. 15–30 min)
        ↓  order created + gateway session created
   Payment Pending  (Order PENDING/UNPAID)
        ↓  verified webhook
      Paid          (Order PAID, reserved -= n, sold += n)
        ↓  issuance (same transaction)
      Issued        (Ticket row, ticketCode + QR secret, delivered)
        ↓  staff scan (first time)
    Checked In      (CheckIn row inserted; Ticket.status = CHECKED_IN)  ← terminal
```

Terminal states: `CHECKED_IN`, `VOID`, `REFUNDED`, `EXPIRED`.

| Event | Handling |
| --- | --- |
| Reservation expired | Job: `Ticket` where `status=RESERVED AND reservedUntil < now` → `EXPIRED`, `reserved -= 1`, order auto-cancelled if fully expired. Idempotent CAS. |
| Failed payment | Order `CANCELLED/FAILED`; reservations released; no tickets issued. |
| Cancelled order | Only from `PENDING/UNPAID`; late payment webhook for a cancelled order is rejected by CAS (documented resurrection guard) and should raise an **operator alert** (money received but no tickets) — a manual-refund queue. |
| Refunded ticket | `Ticket.status = REFUNDED`, `VOID` QR; decide whether quota returns to sale (policy flag on event). |
| Duplicate QR scan | `CheckIn.ticketId` unique ⇒ second insert fails; API returns 409 with `alreadyCheckedInAt` + staff identity. |
| Invalid QR | Signature/HMAC check on the QR payload fails → `CheckIn.result = REJECTED_INVALID`, 400. Never log the raw scanned payload. |
| Ticket from another event | QR decodes to a ticket whose `eventId !== scannedEventId` → `REJECTED_WRONG_EVENT`, 409. Compare against the **signed** payload, not the URL. |
| Already checked-in | `REJECTED_ALREADY_CHECKED_IN` with the original scan timestamp and staff — the single most useful operational error message. |
| Unpaid ticket | `Ticket.status !== ISSUED` → reject with the reason. |

---

## 16. QR Check-in Architecture

**QR payload (signed, stateless-friendly):**

```
base64url( JSON: { v:1, tid: <ticketId>, ev: <eventId>, t: <ticketCode>, iat, exp } )
  + "." + base64url( HMAC-SHA256(serverSecret, payloadPart) )
```

Encode with `qrcode.react` (already a dependency) into an image for the app; use a short URL wrapper as a fallback for scanning with a phone camera. The QR must **not** contain PII.

**Validation order on scan (server-side, `/api/organizer/events/[id]/check-in` or `/api/staff/check-in`):**

1. **Auth:** session required; resolve `ActorContext` and assert scan capability for `eventId` (organizer member/staff assignment or platform admin).
2. **Event validation:** event exists, belongs to actor's organizer scope, `status = PUBLISHED` (or in an allowed check-in window), check-in not disabled.
3. **Signature validation:** HMAC over the payload; expiry check.
4. **Ticket lookup:** by `ticketId` + `ticketCode`; verify `ticket.eventId === scannedEventId` (defence against a valid ticket for another event).
5. **Payment/status validation:** require `Ticket.status = ISSUED`. Reject `RESERVED`, `VOID`, `REFUNDED`, `EXPIRED`.
6. **Duplicate prevention:** insert `CheckIn` with `ticketId @unique` inside a transaction that also CAS-es `Ticket.status ISSUED → CHECKED_IN`. `affectedRows === 0` or a unique-violation ⇒ already checked in; return the existing scan's timestamp/staff.
7. **Record:** `scannedAt` (server clock), `staffUserId`, `staffOrganizerMemberId`, `method`, `deviceId`, `ipAddress`.
8. **Audit:** write `AdminAuditLog` (`entityType: "CheckIn"`) as well as the `CheckIn` row.

**Operational requirements**

- **Offline tolerance (post-MVP):** devices cache a signed ticket-code manifest per event and sync `CheckIn` rows later; `ticketId` uniqueness still de-duplicates on sync. Design the API to accept a client-generated `scannedAt` + `deviceId` so offline scans are reconcilable.
- **Rate limiting + throughput:** check-in gate traffic is bursty. Use a dedicated limiter, allow batch scan (array of codes) with a single transaction, and index `(eventId, scannedAt)` for live dashboards.
- **Idempotency for the scanner:** the client should send a scan UUID so a retried request does not create a second audit entry.
- **Never leak:** the response must not return the QR secret, the full attendee phone, or other attendees' data.

---

## 17. Organizer Architecture

### 17.1 Can the current app safely support multiple organizers?

**No — not today.** The application is single-tenant by construction:

| Requirement | Current state | Gap |
| --- | --- | --- |
| Organizer entity | Absent | Must be created; it is the isolation root |
| Organizer↔user membership | Absent (`AffiliateProfile` is the only profile pattern) | `OrganizerMember` needed |
| `organizerId` on domain rows | Absent on every table | Must be mandatory on `Event`, `EventOrder`, `Ticket` (denormalized for scan speed) |
| Scoped authorization helper | Absent; `userId` predicates only | `requireOrganizerScope()` must exist before the first organizer route ships |
| Role model | `ADMIN/SELLER/CUSTOMER/AFFILIATOR` | Add `ORGANIZER` + membership-role separation so *owner ≠ staff* |
| Middleware scoping | `proxy.ts` prefix allow-list, auth-only | Add `/api/organizer/**`, and default-deny for new namespaces |
| Audit attribution | `adminId` string incl. `"SYSTEM"`/`"PROVIDER"` | Needs `actorType` + `organizerId` |
| Per-organizer payments | Single iPaymu merchant account | Needs a settlement decision (see §14.3 #4) |

### 17.2 Isolation rules (must be enforced in code, not convention)

1. `organizerId` is **never** accepted from the request body or query string. It is derived from the session, or from a resource whose ownership was just verified.
2. Every organizer-scoped query goes through a repository function that **requires** an `organizerId` argument — no "find by id" methods are exported without it.
3. `Event`, `EventOrder`, `TicketType` and `Ticket` all carry `organizerId`, and composite indexes start with it (`(organizerId, status)`), so a missing filter is visible in query plans and code review.
4. Cross-tenant access returns **404, not 403** (do not confirm the existence of another organizer's event).
5. Staff access is scoped twice: by `OrganizerMember.organizerId` **and** by event assignment for the `STAFF` role.
6. Check-in validates `ticket.eventId` against the scanning event, and the ticket's `organizerId` against the actor's scope.

### 17.3 Organizer capability set (as requested)

- Events: create, edit, publish/unpublish, cancel, duplicate, archive; venue + date/time; banner upload (reuse the magic-byte-validated upload route); rich description.
- Ticket types: create/edit, price, quota, sales window, min/max per order, activate/deactivate, sort order.
- Sales visibility: orders (filter by status/date/ticket type), attendees (name + ticket type + check-in state), sales summary, revenue, per-ticket-type breakdown, export.
- Check-in: live scanner, manual lookup by ticket code/name, per-event check-in counter, staff assignment.
- Settlements: settlement statements, payout history (post-MVP).
- Coupons: event-scoped promo codes (reuse `Voucher` machinery).

---

## 18. Platform Fee Architecture

**Current reality:** there is no fee concept. `grossAmount = subtotal - discount - spinWheelDiscount + shippingCost` (`lib/checkout.ts`) and the whole amount is charged to the platform's single merchant VA. Nothing is owed to a third party because there is only one merchant.

**Required design (no settlement mechanism is assumed):**

1. **Model the fee explicitly on the order** rather than deriving it at read time:
   `subtotal`, `discount`, `platformFee`, `paymentFee`, `total`, `organizerAmount`, with `organizerAmount = subtotal - discount - platformFee`.
   Store `platformFeeRate` (snapshot) and `feeMode` on the order so historical orders stay explainable after a rate change.
2. **Fee mode decision (must be made explicitly):**
   - `PASS_TO_BUYER`: `total = subtotal - discount + platformFee` — the customer pays Rp105,000 for a Rp100,000 ticket; organizer is owed Rp100,000.
   - `ABSORB_BY_ORGANIZER`: `total = subtotal - discount` — the customer pays Rp100,000; organizer is owed Rp95,000 (5% fee).
   Both are legitimate; the choice changes the checkout UI, the gateway item lines, and the refund math, so it must be decided once and stored per event/organizer override.
3. **Gateway item lines:** add an explicit fee line (`id: "PLATFORM_FEE"`) for `PASS_TO_BUYER` so the gateway's own item-total check and the organizer's receipt both reconcile. Negative-line handling already exists for vouchers, so this pattern is available.
4. **Refund math with fees:** define who bears the fee on a refund (gateway fees are usually non-refundable). `Refund.amount` must be computed server-side from the order snapshot, never from client input (the current implementation already does this).
5. **Settlement:** a `Settlement`/`OrganizerPayout` record per period, computed from **PAID** orders only, minus gateway fees and refunds, with a status machine and payout proof (mirror `AffiliatePayout`).

### Must be verified with the selected payment gateway before building payouts

| # | Question | Why it blocks the design |
| --- | --- | --- |
| 1 | Can the account create **per-organizer sub-accounts / VAs** with automatic split settlement? | Determines whether money is routed at payment time (escrow/split) or pooled and paid out later |
| 2 | **Settlement delay** (T+X)? | Determines when an organizer can be paid and how refunds after payout are handled |
| 3 | Are **partial refunds** supported via API, and who absorbs the gateway fee? | Refund and fee policy |
| 4 | Is the **gateway fee** reported per transaction in the webhook payload or only in a report file? | Whether `paymentFee` can be stored per order automatically or reconciled manually |
| 5 | Are **marketplace/aggregator** contractual requirements applicable (KYC per organizer, escrow licensing)? | Legal readiness before onboarding real organizers |
| 6 | Does the gateway support **idempotent session creation** on a `referenceId`? | Repayment and retry behaviour |
| 7 | Is there an **IP allow-list** for webhooks and a **retry schedule** (how many attempts, over what window)? | Replay-safety and the ability to stop retries after a durable failure |

Until #1 is answered, **MVP should collect everything into the platform account and track `organizerAmount` as a payable ledger**, settling manually. That keeps the launch unblocked and does not bake in a mechanism that may be unavailable.

---

## 19. Security Findings

All findings are from code/config inspection. Nothing was exploited. Severity is my assessment of the risk to the current app and to the future platform.

| ID | Severity | Finding | Evidence | Recommendation |
| --- | --- | --- | --- | --- |
| **S-1** | **Critical (data protection)** | **Indonesian ID card (KTP) scans and affiliate media are committed to git.** `storage/uploads/affiliate/ktp/**` is tracked; `.gitignore` lists only `node_modules`, `.next`, `.env*`, `npm-debug.log*`, `data/whatsapp-auth/`. | `git ls-files storage` returns KTP files; `.gitignore` | Purge from the working tree **and history**, add `storage/` + `uploads/` to `.gitignore`, move to private object storage with signed URLs. This is a personal-data exposure that predates ticketing and must be fixed before any organizer onboard KYC. |
| **S-2** | High (authz) | **`proxy.ts` fails open.** Requests to `/api/**` that match neither the public nor the protected prefix list pass through with no middleware check. `app/api/payment/status` is in neither list (it does its own `auth()`, but the pattern is fragile). | `proxy.ts` default `return;` branches | Invert to a **default-deny** model: only explicitly public prefixes bypass auth. Add `/api/organizer/**` and `/api/check-in/**` to the protected set as part of the same change. |
| **S-3** | High (multi-tenancy, future) | **No tenant isolation primitive exists.** Ownership is always `userId`; there is no `organizerId`, no scope helper, no RLS. Any organizer feature built without a mandatory scoping layer risks cross-organizer data exposure. | Absence across `prisma/schema.prisma` and all 115 route handlers | Build `lib/authz/*` (`requireOrganizerScope`, `requireEventScope`) **before** the first organizer endpoint; require `organizerId` on all scoped repository functions. |
| **S-4** | High | **Login is not rate limited and the timing-equalization hash is invalid.** `rateLimiters.login` (5 attempts / 15 min) is defined but has **zero call sites**, and the credentials path calls `verifyPassword(password, "$2a$12$x dummy hash to prevent timing attack")` — that is not a valid 60-char bcrypt hash, so `bcrypt.compare` returns false without performing the expensive comparison, defeating the intended constant-time behaviour. | `lib/rate-limit.ts` (`login` limiter), `auth.ts` (dummy hash) | Wire per-identifier + per-IP login limiting in the credentials flow (NextAuth `authorize` or a wrapper route), and replace the dummy with a real precomputed bcrypt hash of a random string. Add account lockout/backoff. |
| **S-5** | High (replay) | **No webhook event ledger / replay store.** Duplicate protection relies on order-state CAS and on `Refund.orderId @unique`. A validly signed body can be replayed indefinitely; the only thing preventing a second settlement is the CAS (good) — but there is no record of *how many times* a provider event was delivered, and no way to detect provider-side duplicates that carry different status codes. | `app/api/payment/ipaymu/notification/route.ts` | Add `WebhookEvent`/`PaymentTransaction` with `providerEventId UNIQUE` inserted before any state change; log every delivery, valid or not. Add a timestamp-freshness window if iPaymu supplies a trusted timestamp. |
| **S-6** | Medium (verification incomplete) | **Only `X-Signature` is cryptographically verified.** `X-Timestamp` and `X-External-ID` are presence-checked only. The route's own comment states this must be confirmed against a real sandbox transaction. | notification route header gate | Confirm the real header set in sandbox; if timestamps are available, enforce a freshness window; never weaken signature checks. Add a production smoke test that fails the deploy if a signed sandbox callback is rejected. |
| **S-7** | Medium | **Rate limiting is per-process and effectively single-bucket per client.** In-memory `Map`, no Redis (only a warning if `REDIS_URL` is set), and `getClientIp()` returns the literal string `"untrusted"` unless `TRUSTED_PROXY` is set — meaning **every** untrusted client shares one counter. | `lib/rate-limit.ts` | Move to a shared store (Redis/Upstash) for the ticketing launch; keep the anti-spoofing logic but bucket by a stable session/device identifier where possible. Note the inverse DoS: one attacker can exhaust the shared bucket and lock out all users. |
| **S-8** | Medium | **Validation is inconsistent server-side.** zod is used only for registration; the rest of the API hand-rolls `typeof` checks, and the giant checkout input (`addressId`, `shipping`, `voucherCode`, `spinWheelSpinId`, `selectedCartItemIds`) is validated piecemeal. | `app/api/payment/ipaymu/route.ts`, `lib/checkout.ts` | Adopt one zod schema per endpoint (or a shared validation middleware) from the start of the ticketing build. The security test suite already contains a `sortby-injection` case — formalize that allowlist approach. |
| **S-9** | Medium | **File upload serves from the app origin with extension-derived `Content-Type`.** Magic bytes are validated (good), filenames are randomized and `path.basename` is applied (good), but files are served publicly with `Cache-Control: public, immutable` and no `Content-Disposition`/`X-Content-Type-Options`-forcing for non-image extensions. Two separate serving routes exist (`/api/uploads/products/[filename]` public vs `/api/admin/upload/products/[filename]`). | `app/api/admin/upload/route.ts`, `app/api/uploads/products/[filename]/route.ts` | Consolidate to one serving route, drop the admin duplicate, always send `X-Content-Type-Options: nosniff`, and prefer Cloudinary/object storage with signed URLs for anything sensitive. |
| **S-10** | Medium | **Internal infrastructure addresses are committed.** `next.config.ts` hardcodes `192.168.2.49`, `103.93.132.214`, `202.73.25.122` and a `trycloudflare.com` tunnel host in `allowedDevOrigins`. | `next.config.ts` | Move to environment-driven config; remove the tunnel host (it is also declared in `allowedDevOrigins`, which only affects dev, but publishing internal IPs aids reconnaissance). |
| **S-11** | Medium | **CSRF relies on cookie semantics only.** `lib/csrf.ts` documents itself as a CSRF helper but only checks that a session exists; it does not validate an origin/token. Two of its three exports are unused. SameSite cookies do provide the primary protection, so this is a documentation/expectation risk rather than an open hole. | `lib/csrf.ts` (0 call sites for `requireSession`/`requireAdminSession`) | Either implement real origin checking (`Origin`/`Sec-Fetch-Site`) for state-changing routes or delete the misleading helper and document the actual protection. |
| **S-12** | Low–Medium | **`Order`-scoped logs and error messages.** The webhook logs `reference_id`/`trx_id`; checkout logs full line items and discounts; `lib/checkout.ts` distinguishes "Product not found" from other failures. Amount/PII leakage is bounded (the code explicitly avoids dumping payloads), but checkout errors are returned with `status` derived from `error.status`. | notification route, `lib/checkout.ts` | Keep the "safe fields only" logging convention; centralize error mapping so internal messages never reach clients (the L1 security test suggests this was already addressed once — preserve the rule). |
| **S-13** | Low–Medium | **Risky/outdated dependencies.** `xlsx@0.18.5` (known prototype-pollution/ReDoS advisories; not maintained on the public npm registry) is used in 5 admin import/export routes; `@whiskeysockets/baileys@7.0.0-rc14` is a release candidate and an unofficial WhatsApp client (account-ban/ToS risk) holding session state on disk; `next-auth@5.0.0-beta.32` is a beta. No `npm audit` gate in CI. | `package.json`, tracking/report routes, `lib/notification/baileys-provider.ts` | Replace `xlsx` with a maintained reader (`exceljs`/`node-xlsx`) or process imports through a sandboxed worker; pin and monitor Baileys; add `npm audit` (or Socket/OSV) to CI. |
| **S-14** | Low | **Dead authz helpers invite misuse.** `requireAdminSession`/`requireSession` are unused while `requireAdmin()` throws `Error("UNAUTHORIZED")`, requiring every caller to catch and translate it. | `lib/csrf.ts`, `lib/admin.ts` | Standardize on one helper that returns a discriminated result (the `requireSession` shape is the better one) and delete the other. |
| **S-15** | Low | **Middleware protects pages from unauthenticated users but not by role.** `/admin/**` renders for any logged-in user if a page-level check is missed. | `proxy.ts` | Add role-aware checks in the proxy for `/admin` and `/organizer` namespaces as defence-in-depth, keeping server-side checks authoritative. |

**Not found (checked, no issue):** mass-assignment via `...body` into Prisma updates (handlers whitelist fields, e.g. `app/api/profile/route.ts`); SQL injection in user input (raw SQL uses Prisma parameterization throughout — `$executeRaw` tagged templates); path traversal on upload serving (`path.basename`); OAuth account takeover (`allowDangerousEmailAccountLinking: false`, correctly set); committed `.env` (gitignored).

---

## 20. Performance & Scalability Findings

### 20.1 Tickets go on sale at a known second — the current design is not built for that

| # | Finding | Evidence | Impact | Fix in MVP? |
| --- | --- | --- | --- | --- |
| **P-1** | **One long interactive transaction per checkout.** `createCheckoutOrder` wraps pricing, voucher CAS, shipping-discount CAS, flash-sale CAS, stock decrement, order + items insert in a single `$transaction` with **no explicit timeout**. | `lib/checkout.ts` (~2,775 lines), cf. `lib/refund.ts` which does set `{ timeout: 15000 }` | Under a 10k-user on-sale spike this holds row locks (voucher, flash sale, variant rows) for the duration; lock waits cascade into 500s | **Yes** — split into short transactions: (1) reserve quota atomically, (2) create order, (3) settle. Never call HTTP inside a transaction (already respected) |
| **P-2** | **No reservation expiry / reaper.** Nothing releases a held resource unless the user checks out again (`cleanupPendingCheckoutOrders`) or the gateway sends a failure webhook. | `lib/checkout.ts`, no cron/job config anywhere | Abandoned carts silently consume retail stock; for ticketing this means **phantom sold-out events** | **Yes** — `reservedUntil` + a scheduled reaper job with idempotent CAS |
| **P-3** | **No persistent job runner.** The only queue is in-memory and self-documented as losing jobs on restart. | `lib/notification/queue.ts` header | Ticket delivery, expiry sweeps, settlements and reminders cannot be reliably scheduled | **Yes** — DB-backed job table + cron endpoint/worker (the existing `Notification` table can hold the retry state) |
| **P-4** | **Webhook bursts have no dedupe table and no batch path.** Each duplicate webhook performs a find + CAS + (for failures) a full stock-restore transaction. | notification route | A gateway retry storm amplifies DB load; failures are expensive by design | **Yes** — add the `WebhookEvent` ledger (S-5) and return 200 immediately after insert for duplicates |
| **P-5** | **No caching layer at all.** Category/sport lists, banners, event lists and detail pages hit MySQL per request. | No Redis, no `unstable_cache`/`revalidate` usage found | Event discovery pages will be the hottest read path during on-sale | **Yes (light)** — HTTP cache headers + short-TTL in-process cache for taxonomy/banners; add Redis when multi-instance |
| **P-6** | **Rate limiting is per-instance and single-bucket for untrusted clients** (see S-7). In-memory `Map` also grows unboundedly between 5-minute cleanups. | `lib/rate-limit.ts` | Cannot throttle a ticket-bot wave across instances | **Yes** for the ticketing launch |
| **P-7** | **Missing composite indexes.** Single-column `Order.status`, `Order.paymentStatus`; no `(eventId, status)`-style indexes exist because the tables do not exist. | `prisma/schema.prisma` | Organizer dashboards and check-in queries will scan | **Yes** — bake `organizerId`-leading composite indexes into the new schema from day one |
| **P-8** | **Check-in is not designed for burst throughput or offline.** No `CheckIn` model, no batch endpoint, no device reconciliation. | absent | Gate congestion at popular events | **Partial** — single-scan MVP is fine; design the API for batch + offline from the start (cheap now, expensive later) |
| **P-9** | **Heavy read endpoints live in route handlers** (e.g. `app/api/affiliate/dashboard/route.ts`, 936 lines) with no pagination contract. | route files | Response-time variance and unbounded queries | Post-MVP for retail code; **MVP** for organizer dashboards: enforce pagination + aggregates via SQL, not in JS |
| **P-10** | **Single MySQL instance on a single VPS, no read replica, no connection-pool tuning visible.** Prisma pool defaults; `deploy.sh` is not in the repo so the server side is unknown. | `deploy.yml`, `lib/prisma.ts` | On-sale burst saturates connections | Post-MVP, but **measure** connection count during the first on-sale and set `connection_limit` explicitly |
| **P-11** | **`console.log` in hot paths** (every notification, every checkout event, upload banners). | `lib/notification/*`, `lib/checkout.ts` | Log I/O amplification under load | Yes (trivial) — route through a leveled logger |
| **P-12** | **`prisma` logs every query in development** (`log: ["query"]`) while `globalThis` caching is dev-only. | `lib/prisma.ts` | Fine in dev; verify production log level is `error,warn` (it is) | No |

### 20.2 MVP vs later

**Solve in MVP:** P-1 (short settle transactions), P-2 (reservation TTL + reaper), P-3 (persistent jobs), P-4 (webhook ledger), P-6 (shared rate limiting), P-7 (indexes), plus explicit `connection_limit` and a load test of the settlement path (e.g. 200 concurrent buyers × 50 available tickets, asserting exactly 50 issued).

**Defer:** read replicas, CDN-level caching, seat-map concurrency, offline check-in, queue-based ticket PDF generation, `EXPLAIN`-driven query tuning beyond the designed indexes, analytics warehouse.

---

## 21. Technical Debt

**Types & lint (measured)**
- `npx tsc --noEmit` → **clean** (exit 0). Good starting point.
- `npx eslint .` → **520 problems: 368 errors, 152 warnings.** Distribution: `app/` 173e/67w, `__tests__/` 97e/15w, `lib/` 41e/11w, `components/` 32e/42w, `scripts/` 17e/6w, `auth.ts` 4e, `server.js` 3e, `prisma/` 1e/11w. Dominant rule: `@typescript-eslint/no-explicit-any` (handlers, `session.user as any`), plus `no-require-imports` in `scripts/*.js` and `server.js`.
- `tsconfig.json` sets `strict: true` but **not** `noUncheckedIndexedAccess`, `noImplicitOverride`, or `exactOptionalPropertyTypes`.

**Tests**
- **`package.json` has no `test` script.** Tests can only be run via `npx jest`.
- `jest.config.js` `testMatch` covers only `__tests__/ipaymu`, `__tests__/marketing`, `__tests__/p0`, `__tests__/order-refund`, `__tests__/security` — **44 test files exist, ~19 never run** in any configured command (`admin/`, `affiliate/`, `auth/`, `broadcast/`, `checkout/`, `shipping/`, `spin-wheel/`, `transaction/`, `ui/`, `voucher-picker/`). One test file is explicitly excluded (`marketing/pricing-engine.test.ts`) without a documented reason.
- No coverage thresholds, no CI job that runs tests (`.github/workflows/` contains only `deploy.yml` and `test-vps.yml`), no load/performance test.

**Duplication**
- Three overlapping pricing implementations: `lib/marketing/pricing.ts`, `lib/marketing/batch-pricing.ts`, and inline logic in `lib/checkout.ts`.
- Two upload-serving routes (`/api/uploads/products/[filename]` and `/api/admin/upload/products/[filename]`) with near-identical bodies.
- Two address namespaces (`app/api/address` and `app/api/addresses`).
- Two landing pages (`app/page.tsx`, `app/home/page.tsx`); two promo pages (`/promotions`, `/promos`).
- Region seed duplicated (`prisma/seed-regions.ts` + `prisma/seed-regions.js`).
- Midtrans remnants inside an iPaymu codebase: `app/api/payment/midtrans/notification/route.ts`, `lib/types/midtrans.d.ts`, `MidtransItem`, `createMidtransItemDetails`, `validateItemDetailsTotal`, `getEnabledPayments`.

**Dead code & artifacts**
- `lib/csrf.ts`: `requireSession` / `requireAdminSession` (0 call sites).
- `rateLimiters.login` and `rateLimiters.paymentCreation` (0 call sites).
- `Session` model (JWT strategy) — never written.
- `Role.SELLER` + `/seller/dashboard` route string + `/wishlist`, `/dashboard` page guards with no pages.
- Empty files `=` and `toko_backup.sql`; stale `prisma/schema.prisma.bak`, `prisma/schema.after-pull.prisma`; root `products.ts` demo catalog.
- Unused deps: `@google/genai`, `@tanstack/react-query`.

**Inconsistency**
- Prisma naming: PascalCase models vs `Voucher_type` / `Order_status` / `Order_paymentStatus` enum types; `@@map` lowercase tables; raw SQL must escape `` `order` ``.
- Validation strategy split between zod (register) and ad-hoc guards (everything else).
- Error contract drift: some handlers return `{ success, message }`, some attach `error.status`, some return raw `NextResponse.json` shapes.
- `console.log` formatting varies (banner blocks, `[CHECKOUT]` prefixes, bare objects).
- Three consecutive migrations named `add_tiktok_pixel` suggest migration-collision churn.
- `types/next-auth.d.ts` types `role` as `string` instead of the Prisma `Role` union.

**Missing validation / error handling**
- Swallowed failures: `catch { /* non-critical */ }` around audit logs and shipping-discount calculation; rollback failures only `console.error`d (a failed rollback leaves stock/orders inconsistent with no alerting).
- `lib/checkout.ts` mixes input parsing, pricing, persistence, and rollback in one 2,775-line file.
- No global error boundary / `app/error.tsx`; no request-id correlation across logs.

**Risky/outdated dependencies**
- `xlsx@0.18.5` (advisories, unmaintained npm distribution), `@whiskeysockets/baileys@7.0.0-rc14` (RC + unofficial client), `next-auth@5.0.0-beta.32` (beta), plus several `^` ranges on fast-moving majors (`next`, `react`, `framer-motion`, `recharts`, `swiper`, `tailwind`). No `npm audit` in CI, no lockfile-integrity check.

**Process**
- `deploy.sh` is referenced by CI but **not version-controlled**.
- No `postinstall`/`prebuild` `prisma generate`, so a fresh clone may fail to build until `prisma generate` is run manually.
- No `prisma.seed` configuration despite `seed-regions` scripts.

---

## 22. Migration Risks

| # | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| **R-1** | **Cross-organizer data leakage** from a missed scope filter | High if built without a guard | Critical (trust + legal) | Build `lib/authz` first; require `organizerId` in every scoped repository function; add automated tests that attempt cross-tenant reads for every organizer endpoint |
| **R-2** | **Money received for a cancelled/expired order**, leaving the buyer paid but ticketless | Medium | High (support load, chargebacks) | Keep the CAS resurrection guard; add an explicit "paid but unfulfillable" queue with an operator alert and a manual-refund path |
| **R-3** | **Overselling** during an on-sale burst | Medium if reservations are implemented in application code instead of conditional SQL | Critical (event-day chaos) | Conditional `UPDATE ... WHERE reserved + sold + n <= quota`; row-level uniqueness per ticket; a concurrency test asserting exactly `quota` successes |
| **R-4** | **Settlement/fee mechanism chosen before gateway capability is confirmed** (split payment may not exist) | Medium | High (rework + accounting) | Answer §14.3 questions first; ship MVP with a payable ledger and manual settlement |
| **R-5** | **Destructive rename of retail tables** (`Product` → `Event`) breaks live orders, cart, and marketing FK graph | High if attempted in place | High | **Additive migration**: new tables alongside old; feature-flag ticketing routes; delete retail tables only in Phase 12 after data export |
| **R-6** | **Prisma migration drift** — 16 migrations, a `0_baseline`, three duplicate `add_tiktok_pixel`, and two stale schema files; the live DB may already differ from the schema | Medium–High | High (broken deploys) | Before any schema work: run `prisma migrate status` and `prisma migrate diff` against a DB dump; re-baseline on a scratch DB; never hand-edit migration SQL |
| **R-7** | **Committed PII (KTP) in git history** resurfaces when the affiliate module is copied into ticketing | Certain if unaddressed | Critical | Purge history now; add `storage/` to `.gitignore`; never store identity documents until an organizer KYC flow is deliberately designed |
| **R-8** | **Ticket issuance crash** leaves a PAID order with no tickets | Low (issuance is transactional) | High | Keep issuance inside the settlement transaction; add a reconciliation job for `paymentStatus=PAID AND ticketCount < paidQuantity` |
| **R-9** | **QR forgery** if the payload is a bare, unsigned ticket id | Medium | High (free admission, fraud) | HMAC-sign the payload with a server secret; validate the signature before any DB lookup; rotate secrets per event if compromised |
| **R-10** | **Duplicate check-in** from concurrent scans of the same ticket | Medium at gates | Medium | `CheckIn.ticketId @unique` + CAS on `Ticket.status`; return the original scan details instead of erroring opaquely |
| **R-11** | **In-memory queue restart** loses e-ticket deliveries | High (current queue design) | Medium | Persistent job records before enqueue; resumable worker; delivery is idempotent via `Notification.idempotencyKey` |
| **R-12** | **Legacy payment flows keep working during the transition** and settle into the old order model | Medium | High (split-brain accounting) | Route new events exclusively through the new model; freeze retail product creation; monitor orders by `orderNumber` prefix |
| **R-13** | **Test coverage collapse**: ~19 of 44 test suites never run, and the checkout/payment suites are the ones that must stay green | High | High | Add a `test` script and CI job **before** starting the rebuild; extend `testMatch`; require a concurrency test for quota |
| **R-14** | **`allowedDevOrigins` / CSP drift** breaks the redirect return path in production | Low | Medium | Smoke-test the full redirect → webhook → ticket issuance path in the sandbox environment as a deploy gate |
| **R-15** | **Single VPS + no Docker + unversioned `deploy.sh`** makes schema migrations risky to roll out | Medium | High | Version-control the deploy script; make `prisma migrate deploy` an explicit, logged step with a pre-migration backup |

---

## 23. Recommended Migration Strategy

**Guiding principles**

1. **Additive first.** New tables + new routes + a feature flag; retail stays intact and sellable until Phase 12.
2. **One isolation layer.** `lib/authz` lands before the first organizer endpoint.
3. **Money paths reuse the proven machinery.** iPaymu adapter + webhook CAS + refund CAS, extended — not rewritten.
4. **Every phase is independently shippable and reversible** (feature flag off = no behaviour change).
5. **The old retail paths are frozen, not refactored.** No new features on products/cart/shipping from Phase 1 onward.

### Phase 0 — Audit (this document)
- **Objective:** establish the baseline, classifications, target architecture, and risk register.
- **Deliverable:** `TICKETING_REBUILD_AUDIT.md` (only file created).
- **DB/API/UI impact:** none.
- **Dependencies:** none.
- **Risks:** none. Follow-ups: answer the gateway capability questions (§14.3) and purge committed PII (S-1).

### Phase 1 — Domain & database design
- **Objective:** freeze the target model (users, organizers, sports, venues, events, ticket types, orders, tickets, payments, check-ins) and the API contract before writing code.
- **Features:** entity spec, status enums, index plan, authz capability matrix, API surface list, fee mode decision.
- **Files likely affected:** `prisma/schema.prisma` (additive models only), new `docs/ticketing-domain.md`, `lib/authz/*` design.
- **DB impact:** schema design only; **re-baseline migrations on a scratch DB first (R-6)**.
- **API impact:** contract design (OpenAPI-ish markdown), no routes.
- **UI impact:** wireframes/inventory of screens (discovery, event detail, checkout, my tickets, organizer console, scanner).
- **Dependencies:** Phase 0; gateway answers for the payment/fee design.
- **Risks:** designing the fee model before gateway confirmation (R-4); under-specifying authz (R-1).

### Phase 2 — Database migration (additive)
- **Objective:** land the new tables without touching existing ones.
- **Features:** `Organizer`, `OrganizerMember`, `Sport`, `Venue`, `Event`, `EventImage`, `TicketType`, `EventOrder`, `OrderItem` (new), `Ticket`, `CheckIn`, `Payment`, `PaymentTransaction`/`WebhookEvent`, `PlatformSetting`, plus `User`/`Notification`/`Refund` relation additions.
- **Files likely affected:** `prisma/schema.prisma`, `prisma/migrations/*` (new), `prisma/seed-sports.*`.
- **DB impact:** new tables + composite indexes; **no data backfill of retail tables**.
- **API impact:** none.
- **UI impact:** none (flag off).
- **Dependencies:** Phase 1.
- **Risks:** migration drift (R-6); long DDL on a live DB — schedule a maintenance window and take a backup.

### Phase 3 — Event management (organizer)
- **Objective:** organizers can create and publish events with ticket types.
- **Features:** organizer onboarding + `OrganizerMember`; venue + sport assignment; event CRUD with draft/publish; ticket types with price/quota/sales window/per-order limits; banner upload (reuse the validated upload route); audit log entries.
- **Files likely affected:** new `app/api/organizer/**`, new `app/organizer/**` pages, `lib/ticketing/events.ts`, `lib/ticketing/ticket-types.ts`, `lib/authz/*`, `proxy.ts` (add namespaces, default-deny).
- **DB impact:** reads/writes the new tables only.
- **API impact:** new organizer endpoints; no changes to retail endpoints.
- **UI impact:** new organizer console (shell, event list, event editor, ticket-type editor).
- **Dependencies:** Phase 2, `lib/authz` complete.
- **Risks:** the first real cross-tenant exposure surface (R-1) — ship with explicit negative tests.

### Phase 4 — Ticket management (quota, pricing, reservations)
- **Objective:** sellable inventory with correct concurrency.
- **Features:** quota split (`quota`/`reserved`/`sold`), atomic reserve/release, sales-window enforcement, per-order limits, reservation TTL; unit + concurrency tests.
- **Files likely affected:** `lib/ticketing/reservations.ts`, `lib/ticketing/pricing.ts`, new job `lib/jobs/expire-reservations.ts`.
- **DB impact:** no schema change beyond Phase 2; index validation via query plans.
- **API impact:** internal service API (used by checkout); organizer availability views.
- **UI impact:** availability display on the organizer console.
- **Dependencies:** Phase 3; a job runner **must exist now** (P-3).
- **Risks:** overselling (R-3), phantom sold-out without the reaper (P-2).

### Phase 5 — Customer event discovery
- **Objective:** public, fast, searchable event browsing.
- **Features:** event list (upcoming/near me/sport), search, filters (sport, city, date, price), event detail with ticket types + availability + sales window, share/SEO metadata, banners.
- **Files likely affected:** new `app/events/**`, new `app/api/events/**` (public prefixes in `proxy.ts`), reuse of `Header`/`Footer`/`BottomNavbar`/skeletons.
- **DB impact:** reads; add `FULLTEXT` for search if needed.
- **API impact:** new public read endpoints (paginated, allowlisted sort/filter — see S-8).
- **UI impact:** new discovery pages; retail home untouched until Phase 12.
- **Dependencies:** Phase 3 (published events).
- **Risks:** hot read path (P-5) — add light caching from the start.

### Phase 6 — Checkout (order + reservation, no gateway yet)
- **Objective:** create ticket orders with reservations, priced server-side.
- **Features:** buy-now and (optional) cart flows; server-side price/availability recomputation; buyer identity capture; order creation with `platformFee`/`organizerAmount` snapshot; reservation confirmation; abandonment release.
- **Files likely affected:** new `lib/ticketing/checkout.ts` (small, not an extension of the 2,775-line retail file), `lib/ticketing/orders.ts`, new `app/api/ticketing/orders/**`, new checkout UI.
- **DB impact:** writes `EventOrder`/`OrderItem`/`Ticket`(RESERVED) or reservation rows.
- **API impact:** new checkout endpoints.
- **UI impact:** new checkout page (much smaller than the retail one).
- **Dependencies:** Phase 4.
- **Risks:** long-transaction lock contention (P-1) — enforce short transactions here.

### Phase 7 — Payment gateway (iPaymu on the new model)
- **Objective:** take money and settle it as the single source of truth.
- **Features:** `Payment` creation with `expiresAt`; gateway session per order; webhook handler with signature + amount verification, `WebhookEvent` ledger, CAS settlement; expiry job; failure release; repayment; reconciliation.
- **Files likely affected:** new `app/api/ticketing/payments/**`, `app/api/ticketing/payments/notification/route.ts` (or extend the existing handler behind a flag), `lib/ticketing/payments.ts`, reuse `lib/payment/*`.
- **DB impact:** `Payment`, `PaymentTransaction`/`WebhookEvent`.
- **API impact:** new endpoints; the retail notification route stays untouched to avoid regressions.
- **UI impact:** payment-finish polling page for tickets.
- **Dependencies:** Phases 4–6; gateway capability answers (§14.3).
- **Risks:** R-2 (paid-but-unfulfillable), R-5 (mutating the proven handler) — add, don't rewrite.

### Phase 8 — E-ticket & QR
- **Objective:** issue and deliver immutable, individually verifiable tickets.
- **Features:** issue one `Ticket` per unit inside the settlement transaction; `ticketCode` + HMAC-signed QR payload; "My Tickets" page with QR; delivery via the notification service (idempotent); PDF/image fallback; voiding rules.
- **Files likely affected:** `lib/ticketing/issuance.ts`, `lib/ticketing/qr.ts`, new `app/tickets/**`, new `app/api/tickets/**`, `lib/notification/*` (template + `ticketId`).
- **DB impact:** `Ticket` writes; `Notification.ticketId`.
- **API impact:** buyer ticket endpoints (ownership-scoped).
- **UI impact:** ticket wallet + QR display (reuse `qrcode.react`).
- **Dependencies:** Phase 7 (issuance must be webhook-triggered, never redirect-triggered).
- **Risks:** QR forgery (R-9), delivery loss (R-11).

### Phase 9 — Organizer dashboard
- **Objective:** organizers can run their event from sales data.
- **Features:** orders list + filters, attendees with check-in state, sales/revenue summaries per event and ticket type, export, event performance, staff/member management.
- **Files likely affected:** `app/organizer/**` pages, `app/api/organizer/reports/**`, aggregate SQL in services.
- **DB impact:** reads (composite indexes from Phase 2).
- **API impact:** organizer reporting endpoints (paginated, aggregate-in-DB).
- **UI impact:** organizer console completion.
- **Dependencies:** Phases 3, 6, 7.
- **Risks:** unbounded queries / N+1 (P-9) — paginate and aggregate in SQL.

### Phase 10 — QR check-in
- **Objective:** fast, fraud-resistant, auditable gate validation.
- **Features:** scan endpoint with the 8-step validation order (§16); `CheckIn` model with `ticketId @unique`; manual lookup; live check-in counter; staff scoping; batch/offline-ready API shape; audit trail.
- **Files likely affected:** `lib/ticketing/checkin.ts`, new `app/api/organizer/events/[id]/check-in/route.ts`, new `app/organizer/events/[id]/scan/page.tsx`, `proxy.ts`.
- **DB impact:** `CheckIn` writes + `(eventId, scannedAt)` index.
- **API impact:** check-in endpoints (staff-scoped).
- **UI impact:** scanner UI (camera) + manual search.
- **Dependencies:** Phase 8 (issued tickets only).
- **Risks:** duplicate scans (R-10), gate throughput (P-8).

### Phase 11 — Admin platform
- **Objective:** the platform operator can run the marketplace.
- **Features:** users, organizers (approve/suspend), sports/venues CRUD, events moderation, transactions/payments ledger, refunds (reusing `lib/refund.ts` logic), platform fee config, settlements, reports/export, platform settings, audit log views.
- **Files likely affected:** new `app/admin/{organizers,sports,venues,events,transactions,settlements}/**`, `app/api/admin/**` extensions, `lib/authz/*`.
- **DB impact:** `PlatformSetting`, `Settlement`/`OrganizerPayout` (if in scope).
- **API impact:** admin endpoints; extend, do not duplicate.
- **UI impact:** admin console additions.
- **Dependencies:** Phases 3–10.
- **Risks:** fee/settlement correctness (R-4); audit completeness.

### Phase 12 — Cleanup / deprecation
- **Objective:** remove the retail surface and dead code with zero remaining references.
- **Features:** delete retail models and routes (products, cart, shipping, region, addresses, voucher-by-product, flash sale, bulk/shipping discounts, campaigns, spin wheel, affiliate, broadcasts, Midtrans remnants, tracking); remove unused deps; add `storage/` to `.gitignore` after PII purge; consolidate duplicate pricing/upload/address modules; split the giant page files.
- **Files likely affected:** broad deletion across `app/api/**`, `app/**`, `components/**`, `lib/**`, `prisma/schema.prisma`, `prisma/migrations` (new drop migration).
- **DB impact:** **destructive** — requires a verified backup, an export of historical orders, and a rollback plan.
- **API impact:** removed endpoints must have returned 410/redirect for a deprecation window first.
- **UI impact:** removed pages must redirect to their ticketing equivalents.
- **Dependencies:** Phase 11; confirmed absence of references (grep + build).
- **Risks:** irreversible data loss — do this last, in a maintenance window, with `prisma migrate deploy` and a snapshot.

---

## 24. MVP Scope

### MVP — required to launch

**Customer**
1. Event discovery: list, search, filter (sport, city, date), event detail with availability.
2. Ticket selection with sales-window and per-order limits enforced **server-side**.
3. Checkout that recomputes prices server-side; buyer identity (name, email/phone).
4. Payment via iPaymu (VA/QRIS) with server-side verified webhook settlement.
5. Automatic per-attendee ticket issuance with a unique, **HMAC-signed QR**.
6. "My Tickets" wallet: list, ticket detail, QR display, order history.
7. Payment status polling page that never grants tickets.

**Organizer**
8. Organizer account + membership; event CRUD (create/edit/publish/unpublish); venue + date/time; banner upload.
9. Ticket types: name, price, quota, sales window, min/max per order.
10. Orders + attendee list with check-in state; basic sales/revenue totals.
11. Manual check-in (search by code/name) and QR scanner.
12. Staff assignment with event-scoped access (permission separated from owner).

**Platform admin**
13. Users, organizers (approve/suspend), sports, venues.
14. Events moderation (unpublish/flag), transactions/payment ledger view.
15. Refunds: request → approve → complete (CAS, idempotent).
16. Platform settings (identity, fee rate, payment environment) + audit log.

**Non-negotiable security/payment requirements in MVP (do not defer)**
- Webhook signature verification + amount verification + webhook ledger (`WebhookEvent.providerEventId` unique).
- Atomic CAS settlement; terminal states never resurrected; browser redirect grants nothing.
- Atomic quota reservation (no overselling) + reservation expiry reaper.
- HMAC-signed QR; `CheckIn.ticketId @unique` duplicate prevention; event-match validation.
- Tenant isolation enforced by a single authz layer, with negative tests.
- Shared (not per-instance) rate limiting on login, register, checkout, payment creation, scan, and refund.
- Working `test` npm script + CI running the payment/refund/security/concurrency suites.
- PII purge from git before ANY organizer KYC is designed.

### Post-MVP — useful, not required for first release
- Seat maps / numbered seating and reserved-seat selection.
- Organizer settlements and payouts (automatic or assisted), settlement statements.
- Event-scoped coupon codes (reuse `Voucher` machinery), referral codes for organizers.
- Email delivery of e-tickets (PDF with QR) in addition to the wallet/WhatsApp.
- Refunds at ticket granularity, with organizer-initiated approval.
- Offline-capable scanner with later sync; multi-device gate support.
- Team/group ticket bundles, attendee self-service transfers.
- Broadcast/announcement to an event's attendees (reuse `Notification`).
- Admin analytics dashboards, scheduled reports, Excel/CSV export.
- Caching layer (Redis) + connection-pool tuning.

### Future — advanced
- Waiting room / virtual queue for high-demand on-sales.
- Dynamic/segmented pricing (early bird → tiered → door price) with automated transitions.
- Multi-currency and multi-country tax handling.
- Ticket resale/transfer marketplace with caps and price ceilings.
- Sponsor/merchandise add-ons at checkout.
- Affiliate/referral engine for events (only if the existing affiliate module is deliberately revived, not migrated by accident).
- Native mobile app + Apple/Google Wallet passes.
- Fraud/anti-bot scoring at checkout (device fingerprinting, velocity checks).
- ML-based demand forecasting and pricing suggestions.
- Public API/webhooks for organizers' own systems.

---

## 25. Phase-by-Phase Implementation Summary

| Phase | Objective | Primary deliverables | DB impact | API impact | UI impact | Key risk |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | Audit baseline | This report | None | None | None | None |
| 1 | Domain & DB design | Entity spec, capability matrix, API contract, fee mode decision | Design only | Contract only | Wireframes | Fee model before gateway facts (R-4) |
| 2 | Additive schema | New tables + indexes + seeds | New tables only | None | None | Migration drift (R-6) |
| 3 | Event management | Organizer scope + event/ticket-type CRUD | New tables | New organizer API | Organizer console shell | Cross-tenant leakage (R-1) |
| 4 | Ticket inventory | Quota split, reserve/release CAS, TTL, reaper | None (indexes) | Service API | Availability display | Overselling (R-3), job runner (P-3) |
| 5 | Discovery | Searchable event list + detail | Reads (+FULLTEXT) | Public read API | New discovery pages | Hot read path (P-5) |
| 6 | Checkout | Reservation-based order creation | EventOrder/OrderItem writes | New checkout API | New checkout page | Transaction length (P-1) |
| 7 | Payment | Gateway session + verified webhook settlement + ledger | Payment/WebhookEvent | New payment API | Payment-finish polling | Paid-but-unfulfillable (R-2) |
| 8 | E-ticket & QR | Per-attendee issuance, signed QR, wallet, delivery | Ticket writes | Buyer ticket API | Ticket wallet/QR | Forgery (R-9), delivery loss (R-11) |
| 9 | Organizer dashboard | Orders/attendees/sales/revenue/staff | Reads | Reporting API | Console completion | Query performance (P-9) |
| 10 | QR check-in | Scan validation chain, duplicate guard, audit | CheckIn writes | Scan API | Scanner UI | Duplicate scan (R-10), throughput (P-8) |
| 11 | Admin platform | Organizers, sports, venues, transactions, refunds, fees, reports | Settings/settlement | Admin API | Admin console | Fee/settlement correctness (R-4) |
| 12 | Cleanup | Delete retail domain + dead code + unused deps | **Destructive** | Endpoint removal | Redirects | Irreversible loss (backup + window) |

**Recommended sequencing shortcut:** Phases 1–2 are pure design/schema and can run in parallel with answering the gateway capability questions (§14.3) and purging the committed PII (S-1). Do not start Phase 7 until those gateway answers exist — the fee and settlement design depends on them.

---

## Appendix A — Evidence Index

| Claim area | Primary files inspected |
| --- | --- |
| Stack & scripts | `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `jest.config.js`, `server.js` |
| Deployment | `.github/workflows/deploy.yml`, `.github/workflows/test-vps.yml`, `next.config.ts` (`allowedDevOrigins`) |
| Schema | `prisma/schema.prisma` (30 models, 11 enums), `prisma/migrations/**` (16), `prisma/schema.prisma.bak`, `prisma/schema.after-pull.prisma` |
| Auth | `auth.ts`, `app/api/auth/[...nextauth]/route.ts`, `app/api/auth/register/route.ts`, `lib/password.ts`, `lib/validations/register.ts`, `types/next-auth.d.ts` |
| Authorization | `proxy.ts`, `lib/admin.ts`, `lib/csrf.ts`, `lib/auth.ts`, `app/api/admin/**` (60 route files) |
| Payment | `app/api/payment/ipaymu/route.ts`, `app/api/payment/ipaymu/notification/route.ts`, `app/api/payment/status/route.ts`, `lib/payment/ipaymu.ts`, `lib/payment/config.ts`, `lib/payment/ipaymu-production.ts`, `tools` in `scripts/test-ipaymu-*.js` |
| Checkout & stock | `lib/checkout.ts` (2,775 lines), `lib/order-stock.ts`, `lib/repay.ts`, `lib/cart-validation.ts`, `app/api/checkout/route.ts`, `app/api/buy-now/route.ts` |
| Refund | `lib/refund.ts`, `app/api/orders/[id]/refund/route.ts`, `app/api/admin/refunds/route.ts`, `app/api/admin/orders/[id]/refund/route.ts` |
| Notifications | `lib/notification/{service,queue,provider,order-status-handler,baileys-provider,mock-provider}.ts`, `lib/whatsapp/*` |
| Marketing | `lib/marketing/*` (12 modules), `lib/voucher.ts`, `lib/spin-wheel.ts` |
| Affiliate | `lib/affiliate/*` (6 modules), `app/api/admin/affiliate/**`, `app/affiliate/**` |
| Uploads & storage | `app/api/admin/upload/route.ts`, `app/api/uploads/products/[filename]/route.ts`, `app/api/uploads/affiliate/[...path]/route.ts`, `lib/cloudinary.ts`, `storage/uploads/**` (tracked in git) |
| Shipping | `lib/rajaongkir.ts`, `lib/rajaongkir/locations.ts`, `app/api/rajaongkir/**`, `app/api/shipping/**`, region models, `prisma/seed-regions.*` |
| Quality measurement | `npx tsc --noEmit` (exit 0), `npx eslint .` (520 problems: 368 errors / 152 warnings), `find` counts (115 API routes, 53 pages, 50 components, 56 lib modules, 44 tests) |

## Appendix B — Constraints Observed During This Phase

This phase was strictly **audit only**. No source file, Prisma schema, migration, API route, UI, authentication, or payment implementation was modified. No packages were installed or removed. No destructive or write command was executed. The only filesystem write was the creation of this report. Read-only commands used: `ls`, `find`, `wc`, `grep`, `git log`/`git ls-files`/`git status`, `cat`/`head`/`sed`, `npx tsc --noEmit`, `npx eslint .`.
