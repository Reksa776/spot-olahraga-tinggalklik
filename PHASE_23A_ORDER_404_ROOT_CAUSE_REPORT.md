# PHASE 23A — TICKETING ORDER 404 + IPAYMU RETURN FLOW — ROOT CAUSE REPORT

**Project:** TinggalKlik.Co
**Reported bug:** after initiating an iPaymu sandbox payment,
`http://localhost:3000/ticketing/orders/EVT-1789839425778-fec07c44` returned
Next.js `404 — This page could not be found`.
**Scope:** local development only.
**Deployment:** **NONE.** Nothing was deployed, no VPS was touched, no production
credential was used, no production configuration was changed, no commit/push, no
git reset/clean, no `prisma migrate reset` / `db push`, and no financial, order or
payment row was deleted.

---

## 1. Exact reproduction

| # | Action | Result |
|---|---|---|
| 1 | `GET /ticketing/orders/EVT-1789839425778-fec07c44` **with the buyer's session** | **200** (fixed) / **404** (pre-fix) |
| 2 | `GET /api/ticketing/orders/EVT-1789839425778-fec07c44` **with the buyer's session** | **200** (fixed) / **403** (pre-fix) |
| 3 | `GET /ticketing/orders/EVT-1789839425778-fec07c44` **unauthenticated** | **302** → `/login?callbackUrl=…` |
| 4 | `GET /api/.../orders/EVT-1789839425778-fec07c44` **unauthenticated** | **401** |

The pre-fix page and pre-fix API were captured against a live `next dev` on
`:3000` with a **minted, valid session for the buyer** (`reksa@gmail.com`):

```
=== PRE-FIX (ADMIN own-scope empty) — same buyer session, exact reported order ===
page -> 404
api  -> 403
api body: {"success":false,"code":"FORBIDDEN","message":"Akses ditolak."}
```
The page body contained the Next.js "could not be found" text.

After the fix, the same session against the same exact URL:

```
page OWN exact   -> 200
api  OWN exact   -> 200   {"success":true,"data":{"orderId":"cmu8o6jnw000jivjvu9bkm5z2",
                            "orderNumber":"EVT-1789839425778-fec07c44","status":"PENDING_PAYMENT",
                            "paymentStatus":"UNPAID","currency":"IDR", ...}}
page OWN unknown -> 404
api  OWN unknown -> 404
page OTHER buyer -> 404
api  OTHER buyer -> 404
```

The rendered page's `<title>` is the application's own **`Pesanan tiket`**, and the
HTML contains `EVT-1789839425778-fec07c44` — it is the real order page, not a
framework not-found.

## 2. Exact HTTP status

| Surface | Pre-fix | Post-fix |
|---|---|---|
| Page, own order | **404** | **200** |
| API, own order | **403** (`FORBIDDEN`) | **200** |
| Page, unknown order | 404 | 404 |
| API, unknown order | 404 | 404 |
| Page, other buyer's order | 404 | 404 |
| API, other buyer's order | 404 | 404 |

The page returned 404 while the API returned **403** for the *same* order and the
*same* session. That page/API differential is the signature of the root cause: the
page's `.catch(() => null)` converts **every** error from `getOwnOrder` — including
an authorization refusal — into `notFound()`.

## 3. Database existence — the order is real

Development database `tinggalklik`, table `eventorder`:

| field | value |
|---|---|
| `id` | `cmu8o6jnw000jivjvu9bkm5z2` |
| `orderNumber` | `EVT-1789839425778-fec07c44` |
| `userId` | `cmsh5pkdo0000u8uozwbyh6vs` |
| `eventId` | `cmu8mqn9o0001ivjvh5kheg53` (event **Basket SCBD**, `PUBLISHED`) |
| `organizerId` | `cmu6dhvde0001ivv9270rl097` |
| `buyerName` | `Reksa` |
| `status` | `PENDING_PAYMENT` |
| `paymentStatus` | `UNPAID` |
| `subtotal` / `total` | `15000.00` / `15000.00` |
| `currency` | `IDR` |
| `createdAt` | `2026-09-19 17:37:05.804` |
| `expiresAt` | `2026-09-19 18:07:05.778` (30-minute TTL) |

It has **1 order item** (`Early`, 1 × Rp15 000). The row was **not modified**.
**Case A (order does not exist) is ruled out.**

**Secondary corroboration:** the order has **0 `Payment` rows**. The buyer's
iPaymu "initiation" never produced a payment — which is exactly what the same root
cause predicts, because `POST /api/ticketing/orders/[orderNumber]/pay` →
`createOrderPayment` → `requireOwnOrderForPayment` applies the *same*
`order.read.own` own-scope gate and was refused before any provider call.

## 4. Database used by the running Next.js process

`DATABASE_URL` (database name only) = **`tinggalklik`**, host `127.0.0.1:3306`.
The dev server loads `.env`. The reported order exists **only in `tinggalklik`**,
**not** in `tinggalklik_test`:

```
=== order in TEST db? ===
(0 rows)
```

The Phase 22 test-database isolation is working as designed:
* Jest runs against **`tinggalklik_test`** (`jest.setup-env.ts` →
  `__tests__/support/test-database.ts` derives `<DATABASE_URL database>_test`, and
  `global-setup.ts` refuses a run whose test DB is missing/behind).
* `next dev` runs against the **normal development** `tinggalklik`.

Confirmed live: the test suite's SQL log shows every query scoped to
``tinggalklik_test``, while the dev server's SQL log shows ``tinggalklik``.
**Cases G and H (wrong database / test-database redirection) are ruled out.**

## 5. Current authenticated user

The buyer is `userId = cmsh5pkdo0000u8uozwbyh6vs` — `reksa@gmail.com`, name
`Reksa`. Critically:

```
| id                        | email           | role  | platformRole |
| cmsh5pkdo0000u8uozwbyh6vs | reksa@gmail.com | ADMIN | ADMIN        |
```

`resolveAuthzScope` reads **`User.platformRole`** (the legacy `User.role` column is
deliberately *not* bridged), so this user's authorization scope is
`platformRole = "ADMIN"`. Across the whole database there is exactly **one**
platform-role `ADMIN` (this user, who owns 3 orders) and 274 `CUSTOMER`s — so the
operator is also the only buyer hit by this bug, which is consistent with a bug
that was reported by the developer's own test purchase.

## 6. Ownership result

`lib/ticketing/orders.ts#findOwnOrderRow` uses the correct predicate:

```ts
prisma.eventOrder.findFirst({ where: { orderNumber, userId: actor.userId } })
```

For this order and this session the row **is found** — ownership passes. Then the
**second gate** runs:

```ts
await requireOwnResource(PERMISSIONS.ORDER_READ_OWN, actor.userId);
```

`requireOwnResource` → `decideOwnResourcePermission(scope, "order.read.own", owner)`
→ `PLATFORM_ROLE_OWN_PERMISSIONS[scope.platformRole].has(permission)`.
`PLATFORM_ROLE_OWN_PERMISSIONS` had:

```ts
ADMIN:   toSet([]),
MANAGER: toSet([]),
```

So the capability check **denied the owner their own order** with
`AuthzError(AuthzErrorCode.FORBIDDEN)` → HTTP **403**. The ownership predicate was
never the problem; the own-scope *capability map* was.

**Case C applies:** the order exists, belongs to the current buyer, and the service
throws. Cases B, D, E, F are ruled out below.

## 7. API result — 403, not 404

`GET /api/ticketing/orders/[orderNumber]` → `requireAuth()` (passes) →
`getOwnOrder(...)` throws `AuthzError(FORBIDDEN)` → `handleApi` → `toAppError`
**preserves** the authz status → **403** `{"success":false,"code":"FORBIDDEN","message":"Akses ditolak."}`.
The API was *already* returning a non-404; it was the page that masked the refusal.

## 8. Page result — 404

`app/ticketing/orders/[orderNumber]/page.tsx`:

```ts
const order = await getOwnOrder(orderNumber, scope).catch(() => null);
if (!order) notFound();
```

The catch-all turns the authz refusal into `notFound()` → the Next.js **404**. The
page is intentionally defensive (a wrong buyer must be a 404), but it also
swallows *authorization* errors, which is how a legitimate owner saw "page not
found" instead of their order.

`params` handling is correct for Next.js 16 (`type Props = { params: Promise<…> }`
and `await params` on both the page and the API route), so **Case D is ruled out.**

## 9. iPaymu redirect chain

Traced end to end:

```
Checkout (createTicketOrder) → orderNumber = EVT-{epochMillis}-{8 hex}
   → POST /api/ticketing/orders/[orderNumber]/pay
   → createOrderPayment(orderNumber, actor, request, httpRequest)
   → const returnUrl = `${origin}/ticketing/orders/${encodeURIComponent(orderNumber)}`
   → gateway redirect session (iPaymu) → provider hosted page
   → iPaymu returns the buyer to returnUrl
```

* The local return URL is built in `lib/ticketing/payment/service.ts` from the
  **order's own `orderNumber`** — not from `paymentReference`, `Payment.id`,
  `eventId`, `ticketTypeId` or `sessionId`. `paymentReference` is a distinct value
  (`EVT-…#2` for the 2nd attempt) and is used only as the provider `referenceId`.
* `origin` comes from `lib/app-origin.ts#getAppOrigin` (env-first, host-allowlisted).
* The return lands on the canonical order page — there is no separate callback route
  that could mark the order paid. Settlement remains **webhook-only**.
* **Case E and Case F are ruled out.**

The new regression test asserts the wire body's `returnUrl` equals
`http://localhost:3000/ticketing/orders/EVT-1789839425778-fec07c44` exactly.

The reason no `Payment` row exists for the reported order is the same root cause:
`POST …/pay` was refused by `requireOwnOrderForPayment`'s own-scope gate (403)
before the provider was ever called.

## 10. Exact root cause

> **`PLATFORM_ROLE_OWN_PERMISSIONS` mapped the platform roles `ADMIN` and `MANAGER`
> to an empty own-scope set. A platform `ADMIN` who buys a ticket through the public
> checkout therefore fails the second authorization gate
> (`requireOwnResource("order.read.own", ownUserId)`) on their OWN order. The order
> page converts that refusal — like every error — into `notFound()`, producing a
> 404 for a real, owned, payable order.**

**Case C** (with the twist that the "lookup failure" is an authorization refusal,
not a null row). Case A ruled out (§3), B ruled out (it *is* the buyer's order, §6),
D ruled out (§8 — Next.js 16 `params` is handled correctly), E/F ruled out (§9),
G/H ruled out (§4).

## 11. Files changed

**Fix (1 file):**

| File | Change |
|---|---|
| `lib/authz/permissions.ts` | `PLATFORM_ROLE_OWN_PERMISSIONS.ADMIN` and `.MANAGER` now hold the buyer own-scope set (`order.read.own`, `order.cancel.own`, `payment.read.own`, `ticket.read.own`, `ticket.issue.own`, `refund.request.own`) — identical to `CUSTOMER`. No other map changed.

**Tests (2 files):**

| File | Change |
|---|---|
| `__tests__/authz/permission-map.test.ts` | +3 pure tests: CUSTOMER/ADMIN/MANAGER all resolve the buyer own-scope set; own-scope stays identity-gated for an ADMIN; granting it adds no platform/tenant power nor the admin financial own-scope capability. |
| `__tests__/ticketing-checkout/order-ownership-404.integration.test.ts` | **new** — 6 integration tests against the real DB/guards/route/page (§12). |

**Generated (safe to discard):** `tsconfig.tsbuildinfo` (rewritten by
`npm run build`). No source file outside the above was touched by this phase.

**Not changed (deliberately):** `lib/ticketing/orders.ts`, both order routes,
the page component, `lib/ticketing/payment/service.ts`, `lib/payment/ipaymu.ts`,
`proxy.ts`, the webhook/settlement/amount/ticket-issuance code, refund code,
`prisma/schema.prisma`, every migration, `.env` / `.env.example`, and every
existing test assertion.

## 12. Regression test added

`__tests__/ticketing-checkout/order-ownership-404.integration.test.ts` — real
database, real services, real `lib/authz` guards, the real Next route handler and
the real page component (only `@/auth` and the provider socket are stubbed):

1. **Owner can open their own order** — the platform `ADMIN` buyer resolves a
   scope and `getOwnOrder` returns the payload.
2. **Page and API agree for the owner** — `GET /api/…` → **200**; the page renders
   (does not throw `notFound()`).
3. **Wrong buyer → 404** — another signed-in buyer's `getOwnOrder` rejects
   `NOT_FOUND`; API → 404; page throws (404).
4. **Unknown order → 404** — API → 404; page throws.
5. **Correct `orderNumber` resolves** — asserted at both the service and API layers.
6. **Payment return preserves the exact `orderNumber`** — after a redirect-method
   payment creation, the provider request body's `returnUrl` equals
   `http://localhost:3000/ticketing/orders/{orderNumber}`.
7. **No Next.js 16 params regression** — the page and the route both receive their
   `orderNumber` through `params: Promise<…>` and resolve it correctly.

Plus the 3 pure permission-map tests.

**Pre-fix proof:** with the map temporarily reverted to empty, these suites fail
exactly as reported — `getOwnOrder` throws `AuthzError: Akses ditolak.`, the API
returns **403**, and the page test fails because it called `notFound()`:

```
Test Suites: 2 failed, 2 total
Tests:       5 failed, 32 passed, 37 total
  ● the ADMIN buyer resolves a scope and can read their OWN order → AuthzError: Akses ditolak.
  ● GET /api/ticketing/orders/{orderNumber} returns 200 for the owner → Expected: 200, Received: 403
  ● the page renders (does NOT call notFound) for the owner
  ● the provider returnUrl is built from the order's own orderNumber → AuthzError
  ● CUSTOMER, ADMIN and MANAGER all resolve the same buyer own-scope set
```

## 13. Test results

With the fix applied:

* Targeted (`permission-map` + new suite): **37 / 37 pass**.
* Full suite: **1419 tests, 1385 passed, 34 failed (3 suites)** — the **3 failed
  suites are the pre-existing `__tests__/security/*` CSP/HSTS suites** documented in
  Phase 22 §16.1 (`next.config.ts` configures no security response headers). They
  are unrelated to this phase and were failing before it. Baseline before this
  phase: 1410 total / 34 failed; after: 1419 total / 34 failed (**+9 tests, 0 new
  failures**).

```
Test Suites: 3 failed, 64 passed, 67 total
Tests:       34 failed, 1385 passed, 1419 total
Time:        53.672 s
```

No existing assertion was weakened, skipped or removed.

## 14. Build / typecheck / lint / prisma

| Check | Result |
|---|---|
| `npx prisma validate` | **valid** |
| `npx prisma migrate status` | **23 migrations, "Database schema is up to date!"** |
| `npx tsc --noEmit` | **clean (exit 0)** |
| `npx eslint .` | **5 problems (0 errors, 5 warnings)** — the same pre-existing `@next/next/no-img-element` warnings as Phase 22 |
| `npm run build` | **succeeded**; route table includes `ƒ /ticketing/orders/[orderNumber]`, the `/api/ticketing/**` routes and **`ƒ Proxy (Middleware)`** |

## 15. Security impact

**No security guarantee was weakened; one was repaired.**

* **Ownership is unchanged.** The ownership predicate
  (`where: { orderNumber, userId: actor.userId }`) still runs **first**, and a
  cross-user order is still answered `NOT_FOUND` (404) — never a page confirming it
  exists. `findUnique({ where: { orderNumber } })` was **not** introduced.
* **Own-scope is identity-gated.** `decideOwnResourcePermission` still denies unless
  `scope.userId === ownerUserId`, so granting these permissions to `ADMIN`/`MANAGER`
  confers no access to any other user's records. The wrong-buyer 404 is asserted.
* **No tenant or platform power was granted.** `PLATFORM_ROLE_*` and
  `MEMBERSHIP_ROLE_*` organizer maps and `ORGANIZER_SPANNING_PLATFORM_ROLES`
  (still empty) are untouched — an `ADMIN` still needs an ACTIVE organizer
  membership for tenant data.
* **D-19 intact.** The admin-only own-scope *financial* capabilities
  (`pic_fee.read.own`, `pic_attribution.read.own`, `report.export.own_pic_fee`)
  remain withheld; the existing pinned test "an ADMIN has no own-scope fee,
  matching §6.2" still passes.
* **No public order access, no capability URL, no client-controlled buyer identity,
  no query-string bypass, no payment-status trust from a redirect.** The canonical
  page stays `/ticketing/orders/{actualOrderNumber}` and settlement stays
  webhook-only. D-28, D-46, D-61, buyer-triggered issuance and the webhook-only
  PAID transition are untouched.

## 16. Confirmation that no deployment occurred

* No deployment to any host/VPS; no PM2/Nginx/cron/domain touched.
* No production migration; only local commands were run.
* No production iPaymu credential used; `PAYMENT_ENVIRONMENT=sandbox` throughout.
* No `git commit`, `git push`, `git reset`, `git clean` or `git checkout -- .`.

## 17. Confirmation that no financial/order/payment data was deleted

* **Zero** rows deleted or modified anywhere. The reported `EventOrder` and its item
  were **read only**. No `TRUNCATE`, no table dropped, no `prisma migrate reset`,
  no `prisma db push`, no schema change.
* The test run wrote only to `tinggalklik_test` (by design) and cleaned up its own
  fixtures; the development database was untouched by tests.

## 18. Remaining issues / notes

1. **The page swallows authorization errors into 404 (by design, but worth noting).**
   `getOwnOrder(...).catch(() => null)` is what made an authz refusal look like a
   missing page. It is intentional for "wrong buyer = 404", and it is now correct
   because a legitimate owner no longer gets refused. If future debugging value is
   wanted, the deliberate distinction could be logged server-side without changing
   the client-visible status. **Not changed** (would be scope creep).
2. **`MANAGER` was given the same fix.** A platform `MANAGER` buying a ticket had
   the identical defect; the set is shared and asserted.
3. **Pre-existing, unrelated:** the 3 `__tests__/security/*` suites still fail
   because no CSP/HSTS/`X-Frame-Options` headers are configured anywhere
   (Phase 22 finding H1). Unchanged by this phase.
4. **Pre-existing, unrelated:** `next-themes` remains an unused dependency
   (Phase 22 finding L2).
5. **iPaymu return flow is correct** and now covered by a regression test; no change
   was needed there. The absent `Payment` row for the reported order is explained by
   the same root cause (the pay call was refused pre-fix), not by a broken return URL.

---

### Bottom line

The 404 was never a routing, params, database or iPaymu problem. `EVT-1789839425778-fec07c44`
is a real, owned, payable order; the buyer is a platform `ADMIN`; and
`PLATFORM_ROLE_OWN_PERMISSIONS.ADMIN` was empty, so the own-scope gate denied the
owner their own order and the page rendered that refusal as "not found". Granting
`ADMIN`/`MANAGER` the buyer own-scope set (identity-gated, so ownership and isolation
are unchanged) fixes the exact URL. Re-tested against a live `next dev` with the
correct authenticated buyer session, `http://localhost:3000/ticketing/orders/EVT-1789839425778-fec07c44`
now returns **200**, while unknown orders and other buyers' orders remain **404**.
