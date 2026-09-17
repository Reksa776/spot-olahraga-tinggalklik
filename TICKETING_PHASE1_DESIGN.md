# TICKETING PHASE 1 DESIGN

**TinggalKlik.Co — Event & Sports Ticketing Platform**
**Phase 1 deliverable: architecture & domain design. DESIGN ONLY — no implementation.**

| Field | Value |
| --- | --- |
| Repository | `demo-marketplace` (package `toko`), branch `main` |
| Baseline | `TICKETING_REBUILD_AUDIT.md` (Phase 0) |
| Document date | 2026-09-16 |
| Files created by this phase | `TICKETING_PHASE1_DESIGN.md` (this file) — **only** |
| Source code changed | **NONE** |
| Schema / migration changed | **NONE** |
| API / UI / Auth / Payment changed | **NONE** |

> **How to read this document.** Items that cannot be decided from the repository or from the given requirements are written as `DECISION REQUIRED` and collected in §39. Where I recommend an option, it is labelled **Recommendation** and the trade-off is stated — the recommendation is not a decision. All repository facts are cited with file paths; all Phase 0 numbers are re-verifiable.

---

## 1. Executive Summary

TinggalKlik.Co is to become an **event & sports ticketing platform** with an e-commerce-like browsing experience (`browse event → event detail → select ticket → checkout → payment → e-ticket/QR`) but a fundamentally different back office: event management, PIC (Penanggung Jawab / person-in-charge) attribution and fees, transaction bookkeeping, settlement, and gate check-in.

Phase 0 established that the existing application is a **single-tenant retail store**. Its **payment spine is excellent and must be preserved**; its **domain is entirely retail and must be replaced**. This phase converts that finding into a complete design: domain entities, financial model with an append-only fee ledger, role/permission matrix, tenant isolation contract, API contracts, migration mapping, security remediation plan, and a dependency-ordered implementation plan.

### The five design pillars

**Pillar 1 — Preserve the payment spine, do not rewrite it.**
`app/api/payment/ipaymu/notification/route.ts` already implements raw-body HMAC signature verification, amount verification, status classification, and **atomic CAS settlement** (`UPDATE \`order\` SET ... WHERE status IN ('PENDING','PROCESSING') AND paymentStatus NOT IN ('PAID','REFUNDED')`), which makes duplicate webhooks idempotent and makes cancelled/expired orders un-resurrectable. Phase 1 keeps this architecture and **extends** it: the settlement transaction must additionally (a) insert a `WebhookEvent` ledger row keyed on a unique `providerEventId`, (b) convert reserved quota into sold quota, and (c) issue one `Ticket` row per unit. No part of the verification chain is weakened.

**Pillar 2 — PIC replaces Affiliate, with a financial ledger, not a column.**
`Order.picFee` is explicitly rejected. The design introduces `PICProfile`, `PICEventAssignment`, `PICAttribution`, and an **append-only `PICFeeLedger`** with credits, reversals, adjustments and payouts. Every rupiah owed to a PIC is traceable from `Settlement → PICFeeLedger → PICAttribution → OrderItem → Order`, and a payment can never produce a double fee because each ledger entry carries a unique idempotency key.

**Pillar 3 — Tenant isolation is a first-class contract, not a convention.**
The audit found that ownership today is always `userId`-based, with no `organizerId` on any table and a `proxy.ts` that fails open. Phase 1 defines `Organizer` + `OrganizerMember` as the tenant root, requires `organizerId` on every scoped entity, and specifies an authorization contract (`requirePermission`, `requireOrganizerAccess`, `requireEventAccess`, `requirePICAccess`) that must be satisfied **before** any scoped query executes. Cross-tenant reads return **404, not 403**.

**Pillar 4 — Financial correctness is enforced at the database level.**
Money is `Decimal`, never float. Quota is enforced by conditional SQL (`WHERE reserved + sold + n <= quota`), never by read-then-write. Webhook replay is blocked by a unique `providerEventId`. Fee items are unique per `(orderItemId, type)`. Settlement periods are unique per payee. Ledger rows are append-only and never updated in place (adjustments are new rows).

**Pillar 5 — Legacy dies last.**
`Product → Event` is **not** a rename. Phase 1 specifies an additive transition (new tables alongside old, feature-flagged routes, legacy cleanup as the final phase), with an explicit `KEEP / ADAPT / DEPRECATE / REPLACE` verdict for every important existing component (§35).

### Corrections to the Phase 1 brief (verified against the repository)

Two assumptions in the brief do not match the code. Documented here so the design is not built on them:

| Brief claim | Actual finding | Evidence |
| --- | --- | --- |
| §32 "Audit menyebut existing project sudah memiliki **AppError** dan standard API response" | **No `AppError` exists anywhere in the repository.** There is no shared error class and no shared response helper. What exists: (a) a permissive `{ success: boolean, message: string, data?: unknown }` JSON envelope written inline in every handler; (b) `lib/marketing/errors.ts` with a `MarketingError` base + 18 subclasses used **only** by the marketing modules; (c) an ad-hoc `error.status` convention in `lib/checkout.ts`. | `grep -rn "AppError" app lib types` → **0 matches**; `lib/marketing/errors.ts:10` `export class MarketingError extends Error`; `lib/checkout.ts` sets `(error as any).status = 404` |
| §37 "belum ada `next-auth.d.ts`" | **It exists** — `types/next-auth.d.ts` declares `Session.user.{id,role}` and `JWT.{id,role}`, and `tsconfig.json` sets `"typeRoots": ["./types", "./node_modules/@types"]`. The real defect is that `role` is typed as `string`, not the Prisma `Role` union, which is why the codebase is full of `session.user as any`. | `types/next-auth.d.ts`, `tsconfig.json` |

Both corrections change work items, not architecture: Phase 2 must **create** `AppError`/`ApiResponse` (not adopt an existing one), and Phase 3 must **widen** the existing declaration (not create it).

### What this design does not do

- It does not choose business parameters (fee percentages, attribution windows, refund fee treatment). Those are `DECISION REQUIRED`.
- It does not assume iPaymu capabilities that Phase 0 could not verify. Split settlement is treated as unverified (§22, §16).
- It does not implement anything. No file in the repository is modified by Phase 1.

---

## 2. Source & Audit Baseline

### 2.1 Inputs used

| Input | Use in this phase |
| --- | --- |
| `TICKETING_REBUILD_AUDIT.md` (Phase 0) | Primary baseline: tech stack, architecture, database inventory, payment analysis, feature classification, security findings S-1…S-15, performance findings P-1…P-12, technical debt, migration risks R-1…R-15 |
| `prisma/schema.prisma` (30 models, 11 enums) | Source of truth for existing entities, enums, indexes, relation shapes |
| `app/api/payment/ipaymu/notification/route.ts` | Source of truth for the settlement state machine to be preserved |
| `lib/checkout.ts`, `lib/order-stock.ts`, `lib/refund.ts`, `lib/repay.ts`, `lib/payment/config.ts` | Source of truth for reusable financial primitives |
| `lib/notification/{provider,service,queue,types}.ts`, `lib/whatsapp/service.ts` | Source of truth for the notification boundary and its current limitations |
| `types/next-auth.d.ts`, `auth.ts`, `proxy.ts`, `lib/admin.ts`, `lib/csrf.ts`, `lib/rate-limit.ts` | Source of truth for auth/authz/zod contracts to be extended |
| `app/api/admin/users/route.ts`, `app/api/admin/reports/route.ts`, `app/api/admin/reports/excel/route.ts` | Source of truth for pagination, filtering, and Excel conventions to be followed |
| `package.json`, `jest.config.js` | Source of truth for dependency and test constraints |

### 2.2 Re-verified baseline numbers (Phase 0, unchanged)

| Metric | Value |
| --- | --- |
| `npx tsc --noEmit` | clean (exit 0) |
| `npx eslint .` | 520 problems — 368 errors, 152 warnings |
| API route handlers | 115 (`app/api/**/route.ts`) |
| Admin route handlers | 60, all with an `ADMIN` role check |
| Pages / components / lib modules | 53 / 50 / 56 |
| Test files | 44, of which ~19 never run (jest `testMatch` covers 5 of 15 test dirs) |
| `npm test` script | **does not exist** |
| Prisma migrations | 16 (baseline + 15) |
| Largest files | `app/buy-now/BuyNowPage.tsx` 4,009 / `app/checkout/CheckoutPage.tsx` 3,208 / `lib/checkout.ts` 2,775 |

### 2.3 Existing conventions the new design must follow (verified, not invented)

These are real, repeatable patterns in the repository. §8, §25–§28 and §36 reuse them instead of inventing new ones.

| Convention | Observed shape | Where verified |
| --- | --- | --- |
| JSON envelope | `{ success: true, data: {...} }` / `{ success: false, message: "..." }` | every handler |
| Pagination | `data: { items: [...], pagination: { page, limit, total, totalPages } }`, `limit` capped at 100, default 20 | `app/api/admin/users/route.ts` |
| Period filter | `Period = "7d" \| "30d" \| "90d" \| "1y"` derived from `now` | `app/api/admin/reports/route.ts` |
| Money formatting (export) | `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })` | `app/api/admin/reports/excel/route.ts` |
| Date formatting (export) | `Intl.DateTimeFormat("id-ID")` | `app/api/admin/reports/excel/route.ts` |
| Excel generation | `import * as XLSX from "xlsx"` then a workbook buffer response | `app/api/admin/reports/excel/route.ts` |
| Error status codes | 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict, 429 rate limited, 500 internal | all handlers |
| Ownership predicate | `where: { id, userId: session.user.id }` (never bare `id`) | `app/api/orders/[id]/route.ts:87`, `app/api/payment/status/route.ts:52` |
| Provider abstraction | `interface NotificationProvider { name; send(); isConfigured() }` with mock/Baileys implementations | `lib/notification/provider.ts` |
| Enum + `@@map` naming | PascalCase model, lowercase table map | `prisma/schema.prisma` |
| Middleware file | `proxy.ts` (Next 16 renamed `middleware.ts`) | `proxy.ts`; `node_modules/next/dist/docs/.../proxy.md` |

### 2.4 Phase 0 findings carried into this design

| Phase 0 ID | Finding | Where resolved in this design |
| --- | --- | --- |
| S-1 | KTP ID scans committed to git under `storage/uploads/affiliate/ktp/**` | §33 remediation plan |
| S-2 | `proxy.ts` fails open (prefix allow-lists, default pass-through) | §29.9 proxy design |
| S-3 | No tenant isolation primitive exists | §7, §16, §29 |
| S-4 | `rateLimiters.login` never called; dummy bcrypt hash is not a valid hash | §33 remediation plan |
| S-5 | No webhook event ledger (`providerEventId` unique) | §21, §31 |
| S-6 | Only `X-Signature` is cryptographically verified | §31 (must-verify list) |
| S-7 | Rate limiting is per-process; IP bucket collapses to `"untrusted"` | §33, §38 |
| S-8 | Validation is ad-hoc except registration (zod used once) | §25.0 (boundary validation), §33.10 |
| S-9 | Duplicate upload-serving routes, extension-derived content type | §33 |
| S-12 | Log/error hygiene | §29, §31 |
| S-13 | `xlsx@0.18.5`, Baileys RC, next-auth beta | §24, §38 |
| P-1 | One long interactive checkout transaction | §11, §12 |
| P-2 | No reservation expiry reaper | §11, §40 |
| P-3 | No persistent job runner | §21, §40 |
| P-5 | No caching layer | §24.8 |
| R-1…R-15 | Migration risks | §35, §41 |

---

## 3. TinggalKlik.Co Requirements

Requirement register. Every row is traced to the design section that satisfies it, and to the verification checklist in §49.

| # | Requirement (from the brief) | Design section | Status |
| --- | --- | --- | --- |
| R-01 | Event behaves like a public e-commerce catalog | §10, §25 | Designed |
| R-02 | Customer can view event list, detail, banner, date, location, sport category, ticket types, price, availability, and purchase | §10, §11, §25 | Designed |
| R-03 | Share a single event (public URL, share URL, QR, social sharing) | §10.6 | Designed (tracking linkage: `DECISION REQUIRED`) |
| R-04 | PIC replaces Affiliate; PIC linked to event sales and earns a fee | §5, §14 | Designed |
| R-05 | PIC must expose: tickets sold, transaction value, fee amount, which transactions generated fees, fee payment status, fee history, events under responsibility | §14, §15, §24 | Designed |
| R-06 | PIC tracking design (link vs order field vs hybrid) with attribution rules | §14 | Designed + `DECISION REQUIRED` |
| R-07 | PIC fee must be a ledger with traceability, not a single column | §15 | Designed |
| R-08 | Fee configurable; percentage must not be hard-locked | §15.3, §17.3 | Designed |
| R-09 | Transaction bookkeeping with defined filters and columns | §24.1 | Designed |
| R-10 | Excel export: Transaction, PIC Fee, Event Sales, Settlement | §24.2 | Designed |
| R-11 | Roles ADMIN / PIC / MANAGER enforced server-side, not by UI hiding | §5, §6, §29 | Designed |
| R-12 | Admin must not freely mutate fees, transaction amounts, settlements, or the ledger | §6, §15.5, §28.3, §29 | Designed |
| R-13 | PIC must not see other PICs' fees, platform-wide transactions, or configuration | §6.3, §14, §27.3 | Designed |
| R-14 | Manager scope: event monitoring, transactions, bookkeeping, PIC fees, settlement, reports, export, financial approval | §6, §13 | Designed |
| R-15 | Permission matrix (no `?` in the final matrix) | §6 | Designed |
| R-16 | Organizer → Event → TicketType → Order → Ticket → Payment tenant chain | §7, §8 | Designed |
| R-17 | Organizer membership with roles (OWNER / ADMIN / MANAGER / PIC / CHECKIN_STAFF / FINANCE) | §5.3, §7.3 | Designed (reconciled — see §5.3) |
| R-18 | Tenant isolation: Organizer A can never reach Organizer B data even knowing IDs | §7.4, §29.3 | Designed |
| R-19 | Authorization helper contract (`requireAdmin`, `requireManager`, `requireOrganizerAccess`, `requireOrganizerRole`, `requireEventAccess`, `requirePICAccess`) — contract only | §29.2, §29.5 | Designed |
| R-20 | Canonical domain model for all listed entities | §8, §9 | Designed |
| R-21 | Individual ticket per purchased unit | §11.5, §18 | Designed |
| R-22 | Ticket lifecycle | §18.3 | Designed |
| R-23 | Order lifecycle with valid/invalid transitions and business effects | §12 | Designed |
| R-24 | Payment lifecycle must preserve existing verified principles | §13, §31 | Designed |
| R-25 | Webhook event ledger with unique `providerEventId` | §8.1 (17), §31.2 | Designed |
| R-26 | iPaymu settlement options A/B/C compared; no unverified claims | §13.5, §16.4 | Designed + `DECISION REQUIRED` (D-20) |
| R-27 | Platform fee separated from gateway fee, PIC fee, organizer net | §17.2 | Designed |
| R-28 | Quota / overselling prevention using the Phase 0 CAS primitive | §11.2 | Designed |
| R-29 | E-ticket & QR with real security (not a bare ID) | §19 | Designed |
| R-30 | Check-in validation chain and audit record | §20 | Designed |
| R-31 | Centralized event-driven notification system (WhatsApp + Email) | §21, §22, §23 | Designed |
| R-32 | WhatsApp behind a provider boundary (business logic must not depend on Baileys) | §22 | Designed |
| R-33 | Email behind the same abstraction, provider not locked | §23 | Designed (provider: `DECISION REQUIRED`) |
| R-34 | Export architecture with role/tenant scope | §24.3 | Designed |
| R-35 | Public vs authenticated vs PIC vs Manager/Admin API separation | §25–§28 | Designed |
| R-36 | Full API contract per endpoint (method, auth, request, response, pagination, errors, idempotency, side effects) | §25–§28 | Designed |
| R-37 | Database design: tables, columns, FKs, indexes, uniques, enums, soft delete, timestamps, money strategy | §9, §36 | Designed |
| R-38 | Additive migration strategy; no destructive rename | §34, §35 | Designed |
| R-39 | Legacy payment foundation disposition (KEEP/ADAPT/DEPRECATE/REPLACE) | §34.2, §35 | Designed |
| R-40 | Security remediation plan (KTP, login rate limit, dummy hash, webhook replay) | §33 | Designed |
| R-41 | Auth architecture design on the existing Auth.js foundation | §29.6, §29.7 | Designed |
| R-42 | Proxy/middleware analysis; middleware alone is not sufficient | §29.9 | Designed |
| R-43 | Technical debt plan split by timing | §38 | Designed |
| R-44 | Test strategy across authz, ticket, payment, PIC, QR, export | §37 | Designed |
| R-45 | Standard API error codes | §25.0, §25.1 | Designed |
| R-46 | Idempotency strategy for 8 operations | §30 | Designed |
| R-47 | Audit log for financial and privileged actions | §32 | Designed |
| R-48 | Decision register (`DECISION REQUIRED`) | §39 | Designed |
| R-49 | Dependency-aware implementation order after Phase 1 | §40 | Designed |

**Non-priority features explicitly excluded from MVP:** Spin Wheel (`SpinWheelCampaign/SpinWheelReward/SpinWheelSpin`), Affiliate KYC/payout surface, Broadcast segmentation, Bulk/Shipping discounts, product reviews/ratings, courier/tracking, COD, region/address shipping data. See §4.3 and §35.

---

## 4. Product Scope

### 4.1 MVP scope (launch-blocking)

**Customer**
1. Public event catalog: list, search, filter by sport / city / date / price, sort.
2. Event detail: banner gallery, description, date/time, venue, sport category, ticket types with price, remaining availability, sales window, and the event's share controls.
3. Ticket selection with server-enforced sales window, per-order min/max, and availability.
4. Checkout with server-recomputed pricing; buyer identity (name, email, phone).
5. Payment via iPaymu (VA / QRIS) with a **server-verified webhook as the only issuance trigger**.
6. Individual e-ticket per unit with a secure, revocable QR token; "My Tickets" wallet; order history.
7. Payment status polling screen that never grants tickets.

**PIC**
8. PIC profile with status and fee configuration; PIC-linked event share links.
9. PIC dashboard: events under responsibility, tickets sold, transaction value, fee accrued/payable/paid, fee history, per-transaction fee breakdown.
10. PIC-attributed order visibility limited to PIC-attributed sales.
11. Notifications (fee created, fee paid, settlement completed).

**Manager / Admin**
12. Event management: create, edit, publish/unpublish, venue, schedule, banner upload, ticket types (price, quota, sales window, per-order limits), sport & venue master data.
13. Order monitoring, attendee lists, check-in state, transactions ledger view.
14. Financial reports + Excel exports (Transaction, PIC Fee, Event Sales, Settlement) with tenant/role scope.
15. PIC fee approval and settlement runs.
16. Refund processing (request → approve → complete) reusing the Phase 0 CAS/idempotent implementation.
17. Check-in: QR scan and manual lookup, duplicate-scan protection, check-in audit trail.

**Platform operations**
18. Roles and membership management, audit log, platform configuration (fee policy, payment environment).

### 4.2 Post-MVP

- Seat maps / numbered seating and seat selection.
- Automated settlement runs and payout proof workflow.
- Event-scoped coupons (reusing the existing `Voucher` quota/CAS machinery).
- Email e-ticket with PDF attachment; wallet passes.
- Offline-capable scanner with deferred sync; multi-gate support.
- Attendee self-service ticket transfer/name change.
- Waitlist / waiting-room for high-demand on-sales.
- Per-ticket (partial) refunds at scale.
- Caching layer (Redis) and connection-pool tuning.
- Admin analytics dashboards and scheduled report delivery.

### 4.3 Explicitly out of scope (legacy retail)

Products and variants, cart-with-shipping, courier and tracking, region data, COD, flash sales, bulk/shipping discounts, spin wheel, affiliate KYC/payouts, broadcast segmentation, product reviews. Disposition per entity is in §34.2 / §35. **Spin Wheel must not enter the MVP.** Its 3 models, 4 API areas and membership in the checkout transaction are a scope and correctness risk; the marketing value is fully covered by coupons (post-MVP).

### 4.4 Scope guardrails

- **No new feature may be added to the retail surface** after Phase 2 begins; retail is frozen.
- **No ticketing feature may depend on a retail table.** The one permitted transitional dependency is the existing `Notification` table (adapted, not replaced).
- Every new endpoint ships with its permission and test case in the same phase (see §36).

---

## 5. Actors & Roles

### 5.1 Actor inventory

| Actor | Who | Relationship to the platform |
| --- | --- | --- |
| **Customer** | Ticket buyer | Owns only their own orders and tickets |
| **PIC** | Person in charge of selling an event (replaces "Affiliator") | External or semi-external referrer; earns a fee from attributed sales |
| **CHECKIN_STAFF** | Gate operator / scanner | Operational role; valid scans for assigned events only |
| **FINANCE** | Bookkeeper | Read/approve financial data; no event editing |
| **MANAGER** | Internal operations staff | Runs events, monitors transactions, approves financial actions within limits |
| **ADMIN** | Platform administrator | Users, roles, configuration; **not** a free hand over money (see §5.5) |
| **SYSTEM** | Jobs and webhooks | Non-human actor; must be recorded as such, never impersonating a human user |

### 5.2 Two-level role model (recommended, with justification)

The brief asks for a minimum of `ADMIN`, `PIC`, `MANAGER`. A single flat role is insufficient because two independent questions must be answered: *"what may this person do on the platform?"* and *"which tenant's data may they touch?"*. Phase 0 confirmed the codebase has only the first (`User.role`) and is missing the second entirely.

**Design: platform role + tenant membership role.**

```
User.platformRole            → ADMIN | MANAGER | PIC | CUSTOMER        (capability across the platform)
OrganizerMember.role         → OWNER | MANAGER | FINANCE | CHECKIN_STAFF | PIC_VIEWER   (scope inside one tenant)
```

Effective permission = **intersection of (platform role capability) and (tenant membership scope)**, never the union of loose grants. A user may hold one platform role and zero or more memberships.

**Why `CHECKIN_STAFF` and `FINANCE` are added beyond the required minimum** (justification required by §10 of the brief):

| Added role | Why it cannot be folded into an existing role |
| --- | --- |
| `CHECKIN_STAFF` | Gate staff need *scan-only* access to one event. Granting `MANAGER` to a part-time gate volunteer would expose orders, revenue and PIC fees — a direct violation of least privilege. |
| `FINANCE` | Bookkeeping requires read access to settlements and ledgers plus the ability to prepare settlement runs, but **not** the ability to edit events or publish. Folding it into `MANAGER` gives every operations staff member the ability to move money. |
| `PIC_VIEWER` (membership-only) | Lets an organizer see which PICs are attributed to its event without granting PIC-level financial access. Optional; may be dropped if unused. |

`CUSTOMER` remains the default `User.platformRole` (matching the existing default `Role.CUSTOMER`), so registration and OAuth flows do not change behaviour.

### 5.3 Reconciliation with the brief's suggested membership roles

The brief (§15) suggests `OWNER, ADMIN, MANAGER, PIC, CHECKIN_STAFF, FINANCE`. Reconciliation:

| Brief role | Phase 1 treatment | Reason |
| --- | --- | --- |
| `OWNER` | Kept as `OrganizerMember.role = OWNER` | Exactly one owner per organizer; cannot be removed, only transferred |
| `ADMIN` (membership) | **Collapsed into `OWNER` + platform `ADMIN`** | A per-tenant "admin" duplicates the platform admin. The platform runs the tenants; a tenant-level admin would be a second, weaker admin that is hard to reason about. `DECISION REQUIRED` if organizers are meant to self-serve. |
| `MANAGER` | Kept as membership role, and also a platform role | Platform `MANAGER` = all tenants; membership `MANAGER` = one tenant |
| `PIC` | **Not a membership role.** PIC is a platform role plus an *assignment* (`PICEventAssignment`) | A PIC must be able to serve multiple organizers; making PIC a membership role ties them to one tenant and breaks the "PIC Andi, Budi, Citra on Event A" model |
| `CHECKIN_STAFF` | Kept as membership role, further scoped by event assignment | Least privilege at the gate |
| `FINANCE` | Kept as membership role | See justification above |

`DECISION REQUIRED` — D-05 in §39: is TinggalKlik.Co the **single organizer** (platform = organizer, PICs are external referrers) or a **multi-organizer** marketplace with self-service organizer onboarding? The design supports both, but the single-tenant reading is simpler and matches the requirement set (no organizer signup, no organizer-facing billing is described). Recommendation: build the tenant chain for isolation correctness but launch with TinggalKlik.Co as the sole `Organizer` row.

### 5.4 Where each role authenticates

All roles authenticate through the same NextAuth v5 credentials/OAuth flow. There is **no separate PIC login system**. A PIC is a `User` with `platformRole = PIC` plus a `PICProfile`. A customer who becomes a PIC keeps their account and order history.

### 5.5 Admin is not a financial superuser

The brief is explicit: Admin must not freely change financial fees, transaction amounts, settlements or the ledger. The design satisfies this by making **financial mutation a distinct, explicitly granted permission** rather than an admin side effect:

- `AdminAuditLog` and `PICFeeLedger` are **append-only**. No `UPDATE`/`DELETE` path is designed for either.
- Correcting a fee is an **adjustment entry** (`type = ADJUSTMENT`, positive or negative), never an edit of the original.
- Changing a fee *rate* affects only future calculations; already-computed ledger entries retain their snapshot of the rate and basis (§17.4).
- Settlement status transitions require `FINANCE_SETTLE` (Manager/Finance) and are audited; Admin without that grant cannot run a settlement.
- A `PermissionGrant` table (optional, §6.4) allows an Admin to be granted a specific financial permission deliberately, with an audit record — rather than holding it implicitly.

---

## 6. Permission Matrix

### 6.1 Legend

| Symbol | Meaning |
| --- | --- |
| `YES` | Allowed, within tenant scope |
| `OWN` | Allowed, restricted to the actor's own records (own events / own attributed sales / own fees) |
| `SCOPED` | Allowed, restricted to the actor's assigned tenant and/or assigned event |
| `NO` | Not allowed. Enforced server-side; not a UI-only restriction |
| `APPROVE` | Allowed to approve, not to originate |

**Enforcement rule:** every cell marked `YES` / `OWN` / `SCOPED` must be enforced in the **service layer** (§29), not by hiding a button. A UI may additionally hide, but that is cosmetic and is never the control.

### 6.2 Required matrix (from the brief, fully resolved — no `?`)

| Resource / Action | Admin | PIC | Manager |
| --- | :-: | :-: | :-: |
| View Event | YES | OWN | YES |
| Create Event | YES | NO | YES |
| Edit Event | YES | NO | YES |
| Publish / Unpublish Event | YES | NO | YES |
| View Own Sales | YES | OWN | YES |
| View All Sales | YES | NO | YES |
| View Own Fee | NO (no own fee exists) | OWN | NO |
| View All PIC Fee | YES | NO | YES |
| Modify Fee | APPROVE (with explicit grant) | NO | APPROVE |
| View Financial Report | YES | NO | YES |
| Export Financial Report | NO (unless explicitly granted) | NO | YES |
| Settlement | APPROVE (with explicit grant) | NO | YES |
| Manage Users | YES | NO | NO |
| Manage Roles | YES | NO | NO |

Notes on the non-obvious cells:

- **View Own Fee (Admin) = NO.** An Admin has no PIC fee of their own. If an Admin is also a PIC, the `OWN` scope comes from their `PICProfile`, not from the Admin role — the two grants do not merge into "view all fees".
- **Modify Fee.** No role edits a computed ledger entry. "Modify" means *create an adjustment entry* (§15.5) and/or *change the rate for future transactions* (§17.3). Both require the `FEE_ADJUST` permission; Manager may hold it by default, Admin must be granted it explicitly. The brief's statement that Manager handles "approval financial action" and that Admin must not freely change fees is thereby satisfied.
- **Export Financial Report.** Deliberately **not** automatic for Admin (brief §30: "Admin tidak otomatis mendapatkan financial export jika permission tidak diberikan"). Manager holds it by role because reporting is an explicit Manager duty (brief §13).
- **Settlement.** Manager/FINANCE may *prepare and execute* a settlement; Admin may *approve* one only with an explicit grant. Neither may edit the ledger behind it.
- **Manage Users / Manage Roles.** Admin only. Manager may not grant permissions to anyone (privilege-escalation guard).

### 6.3 Extended matrix (all designed roles)

| Resource / Action | Admin | Manager | FINANCE | PIC | CHECKIN_STAFF | Customer |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| **Catalog** | | | | | | |
| View public event catalog | YES | YES | YES | YES | YES | YES |
| Create / edit / publish event | YES | YES | NO | NO | NO | NO |
| Upload event banner | YES | YES | NO | NO | NO | NO |
| Manage sports master data | YES | NO | NO | NO | NO | NO |
| Manage venues | YES | YES | NO | NO | NO | NO |
| **Ticket inventory** | | | | | | |
| Create / edit ticket type | YES | YES | NO | NO | NO | NO |
| Change quota | YES | YES | NO | NO | NO | NO |
| Change price | YES | YES | NO | NO | NO | NO |
| **Orders** | | | | | | |
| View own orders | YES | YES | YES | OWN | NO | OWN |
| View all orders (tenant) | SCOPED | SCOPED | SCOPED | NO | NO | NO |
| Edit order amounts | NO | NO | NO | NO | NO | NO |
| Cancel unpaid order | YES | YES | NO | NO | NO | OWN |
| **Payment** | | | | | | |
| View payment ledger | YES | YES | YES | NO | NO | OWN |
| Reconcile payment manually | APPROVE | YES | YES | NO | NO | NO |
| Alter payment amount | NO | NO | NO | NO | NO | NO |
| **Refund** | | | | | | |
| Request refund | YES | YES | YES | NO | NO | OWN |
| Approve refund | APPROVE | YES | YES | NO | NO | NO |
| Execute refund | NO | YES | YES | NO | NO | NO |
| **PIC** | | | | | | |
| Create / suspend PIC | YES | NO | NO | NO | NO | NO |
| Assign PIC to event | YES | YES | NO | NO | NO | NO |
| View PIC attribution (own) | NO | NO | NO | OWN | NO | NO |
| View all PIC attributions | YES | YES | YES | NO | NO | NO |
| View PIC fee (own) | NO | NO | NO | OWN | NO | NO |
| View all PIC fees | YES | YES | YES | NO | NO | NO |
| Change fee rate (future only) | APPROVE | YES | NO | NO | NO | NO |
| Adjust an existing fee (new ledger entry) | APPROVE | YES | APPROVE | NO | NO | NO |
| Mark fee paid | NO | YES | YES | NO | NO | NO |
| **Settlement** | | | | | | |
| Prepare settlement run | NO | YES | YES | NO | NO | NO |
| Approve settlement | APPROVE | YES | YES | NO | NO | NO |
| Upload payout proof | NO | YES | YES | NO | NO | NO |
| **Check-in** | | | | | | |
| Scan / validate QR | YES | YES | NO | NO | SCOPED | NO |
| Manual check-in override | YES | YES | NO | NO | NO | NO |
| View check-in log | YES | YES | NO | NO | SCOPED | NO |
| **Reports & export** | | | | | | |
| View transaction report | YES | YES | YES | OWN | NO | NO |
| Export transaction report | APPROVE | YES | YES | NO | NO | NO |
| Export PIC fee report | APPROVE | YES | YES | NO | NO | NO |
| Export own PIC fee report | NO | NO | NO | OWN | NO | NO |
| View event sales report | YES | YES | YES | OWN | NO | NO |
| **Platform** | | | | | | |
| Manage users | YES | NO | NO | NO | NO | NO |
| Manage roles / grants | YES | NO | NO | NO | NO | NO |
| Platform configuration | YES | NO | NO | NO | NO | NO |
| View audit log | YES | YES | YES | NO | NO | NO |
| **Buyer actions** | | | | | | |
| Browse / buy tickets | YES | YES | YES | YES | YES | YES |
| View own tickets / QR | YES | YES | YES | YES | NO | OWN |

### 6.4 Permission representation

Three options were considered:

| Option | Shape | Verdict |
| --- | --- | --- |
| **A. Hard-coded role checks** | `if (role !== "ADMIN") throw` | **Rejected** — this is exactly today's pattern (`lib/admin.ts`, 60 inline checks). It cannot express `SCOPED`, cannot express approvals, and every new action requires editing every handler |
| **B. Permission strings + role→permission map in code** | `requirePermission("fee.adjust")` resolved from a static map + DB membership | **Recommended** |
| **C. Full RBAC tables** | `Role`, `Permission`, `RolePermission`, `UserRole` tables | Rejected for MVP — over-engineered for 6 roles; adds 4 tables and join cost per request to express what a static map + membership already expresses |

**Recommended: Option B**, with an optional, additive `PermissionGrant` table (user / organizer, permission string, grantedBy, grantedAt, revokedAt, reason) purely to satisfy §6.2's "APPROVE (with explicit grant)" cells — i.e. to give an Admin a specific financial permission deliberately, with an audit record. If that capability is not required, Option B alone is sufficient and the `APPROVE` cells collapse to `NO` for Admin.

Permission naming convention: `resource.action`, e.g. `event.publish`, `ticket_type.update`, `fee.rate.change`, `fee.adjust`, `settlement.prepare`, `settlement.approve`, `report.export.financial`, `user.manage`, `role.manage`, `checkin.scan`, `checkin.override`.

---

## 7. Multi-Organizer / Tenant Model

### 7.1 Why this is the highest-risk area

Phase 0 finding **S-3 / R-1**: the existing application has **no tenant concept**. Ownership is always expressed as `userId` (`app/api/orders/[id]/route.ts`, `lib/refund.ts`, `app/api/payment/status/route.ts`), `proxy.ts` fails open, and there is no helper that can answer "may this actor touch this event?". Introducing organizer-scoped features without a single enforcement point is the fastest way to leak one organizer's revenue, attendees and fee data to another.

### 7.2 Tenant chain (design)

```
Organizer  (tenant root)
   │  organizerId — required, immutable after creation
   ├── OrganizerMember        (who may act for this tenant, and how)
   ├── Venue                  (tenant-owned or platform-global)
   ├── Event                  (organizerId NOT NULL)
   │      ├── EventImage
   │      ├── TicketType      (eventId NOT NULL)
   │      ├── PICEventAssignment  (which PIC may sell this event)
   │      └── EventOrder      (organizerId denormalized NOT NULL)
   │             ├── OrderItem
   │             │      └── Ticket      (organizerId + eventId denormalized)
   │             ├── Payment / PaymentTransaction / WebhookEvent
   │             ├── PICAttribution     (immutable after finalization)
   │             └── Refund
   ├── PICFeeLedger           (organizerId NOT NULL)
   └── Settlement             (payee = PIC or Organizer)

CheckIn → Ticket (ticketId UNIQUE) → Event → Organizer
```

### 7.3 Membership model

```
User ──< OrganizerMember >── Organizer
                │
                └── role: OWNER | MANAGER | FINANCE | CHECKIN_STAFF | PIC_VIEWER
                └── status: INVITED | ACTIVE | SUSPENDED | REVOKED
                └── optional: eventAssignments (for CHECKIN_STAFF)
```

`OrganizerMember` fields: `id`, `organizerId`, `userId`, `role`, `status`, `invitedByUserId`, `invitedAt`, `acceptedAt`, `revokedAt`, `revokedByUserId`, `createdAt`, `updatedAt`. Unique `(organizerId, userId)`, index `(userId, status)`.

Rules:
1. Exactly **one** `ACTIVE` `OWNER` per organizer. Ownership transfer is an explicit, audited operation that demotes the previous owner and promotes the new one **in one transaction**.
2. Removing the last active MANAGER/FINANCE is allowed; removing the last OWNER is not.
3. Revoking a membership does not delete historical attribution — `PICAttribution`, `PICFeeLedger` and `AuditLog` rows keep the `userId` they were created with.
4. `CHECKIN_STAFF` additionally requires at least one `StaffEventAssignment` row; a staff member with no assignment can scan nothing.

### 7.4 Isolation guarantees (design contract)

| Guarantee | How it is enforced |
| --- | --- |
| No cross-tenant read via known ID | Every scoped read includes `organizerId` in the `where` clause **and** returns 404 when the row belongs to another tenant |
| No cross-tenant write | Every scoped write first resolves the target through a scoped read; `organizerId` is never taken from the request body |
| No cross-tenant enumeration | List endpoints always inject the scope filter; there is no "no filter" code path |
| No cross-tenant leakage through counts/aggregates | Aggregates are computed inside the same scoped query (`groupBy` with the scope filter), never by fetching then filtering in JS |
| No cross-tenant leakage through exports | Exports reuse the same scoped query builder as the on-screen report (§24.3) |
| No cross-tenant leakage through PIC scope | PIC queries are scoped by `picProfileId`, and `PICAttribution` rows are only visible to that PIC or to Manager/Finance |
| No cross-tenant leakage through errors | Existence of another tenant's resource is never revealed (404, not 403) |
| No stale-token privilege | Tenant membership is resolved from the database per request, not trusted from the JWT (§29.7) |

### 7.5 Decision required

`DECISION REQUIRED` (D-05): is the platform a **single-organizer** deployment (TinggalKlik.Co operates all events; `Organizer` exists mainly to hold settlement identity and to keep the isolation design future-proof) or a **multi-organizer marketplace** with self-service onboarding? The design supports both; the difference is onboarding workflow, per-organizer settlement accounts, and whether `ADMIN` per-tenant is needed (§5.3).

---

## 8. Canonical Domain Model

### 8.1 Entity inventory with verdicts

Legend: **Required** = must exist in Phase 2; **Optional** = designed but only built if the marked dependency is confirmed; **Reuse** = adapted from an existing model rather than created new.

| # | Entity | Status | Replaces / derived from | Owner scope |
| --- | --- | --- | --- | --- |
| 1 | `User` | Reuse (MODIFY) | existing `User` | — |
| 2 | `Organizer` | Required | new | — |
| 3 | `OrganizerMember` | Required | new (shape borrowed from `AffiliateProfile` membership pattern) | organizer |
| 4 | `StaffEventAssignment` | Optional (needed if CHECKIN_STAFF > 1 event) | new | organizer + event |
| 5 | `Sport` | Required | replaces `Product.category` free text | — |
| 6 | `Venue` | Required | new | organizer (or platform-global) |
| 7 | `Event` | Required | replaces `Product` | organizer |
| 8 | `EventImage` | Required | new | organizer + event |
| 9 | `TicketType` | Required | replaces `ProductVariant` | organizer + event |
| 10 | `TicketReservation` | Required | new (adapts flash-sale CAS semantics) | event + ticket type |
| 11 | `EventOrder` | Required | replaces `Order` | organizer |
| 12 | `OrderItem` | Required | adapts existing `OrderItem` snapshot pattern | organizer + order |
| 13 | `Ticket` | Required | new — the core missing entity | organizer + event |
| 14 | `CheckIn` | Required | new | event + ticket |
| 15 | `Payment` | Required | new (logical wrapper over the existing iPaymu flow) | organizer + order |
| 16 | `PaymentTransaction` | Required | new | organizer + order |
| 17 | `WebhookEvent` | Required | new (Phase 0 S-5 gap) | provider-global, linkable to order |
| 18 | `PICProfile` | Required | replaces `AffiliateProfile` + `AffiliateKyc` | platform |
| 19 | `PICEventAssignment` | Required | replaces `AffiliateConversion`-adjacent linking | organizer + event + PIC |
| 20 | `PICAttribution` | Required | replaces `AffiliateConversion` | organizer + order + PIC |
| 21 | `PICFeeLedger` | Required | replaces `AffiliatePayout` accounting; far stronger | organizer + PIC |
| 22 | `Settlement` | Required | adapts `AffiliatePayout` state machine | payee scope |
| 23 | `SettlementItem` | Required | new (links ledger entries to a settlement) | settlement |
| 24 | `Refund` | Reuse (MODIFY) | existing `Refund` | organizer + order |
| 25 | `Coupon` | Reuse (MODIFY) | existing `Voucher` (+ product/category restriction tables dropped) | organizer or platform |
| 26 | `Notification` | Reuse (MODIFY) | existing `Notification` | — |
| 27 | `NotificationDelivery` | Required | new (per-channel attempt record) | — |
| 28 | `NotificationTemplate` | Optional | new | — |
| 29 | `AuditLog` | Reuse (MODIFY) | existing `AdminAuditLog` | organizer optional |
| 30 | `IdempotencyKey` | Optional | new | — |
| 31 | `ExportJob` | Optional | new | organizer optional |
| 32 | `PlatformSetting` | Reuse (MODIFY) | existing `StoreSetting` | — |
| 33 | `PermissionGrant` | Optional | new | user + organizer optional |

Entities from the brief's list that are **not** created as separate tables, with reason:

| Requested | Decision | Reason |
| --- | --- | --- |
| `EventOrder` **or** `Order` | Use **`EventOrder`** | "Order" alone collides with the legacy `order` table during the additive transition (both tables would exist in the same schema, and raw SQL already has to escape `` `order` ``). `EventOrder` mapped to `eventorder` avoids ambiguity in every query, migration and log line |
| `Payment` **and** `PaymentTransaction` | Both, with distinct jobs | `Payment` = the logical attempt/intent per order (one active at a time); `PaymentTransaction` = the provider's transaction record (may be several per payment, e.g. retries, partial captures). Collapsing them loses reconciliation |
| `Settlement` | One table with `payeeType` | Prevents two near-identical tables for PIC and Organizer payouts |
| `NotificationDelivery` | Separate from `Notification` | `Notification` = the logical message (idempotent); `NotificationDelivery` = the attempt on one channel with its own provider id, status and error. A single message may be delivered on WhatsApp and fall back to Email |
| `NotificationTemplate` | Optional | Template content may live in code for MVP; a table is only needed if non-developers must edit copy |

### 8.2 Identifier strategy

| Entity | ID | Public identifier | Rationale |
| --- | --- | --- | --- |
| `User` | `cuid()` | — | matches existing |
| `Organizer` | `cuid()` | `slug` (unique) | slug used in URLs and settlement statements |
| `Event` | `cuid()` | `slug` (unique) **and** `eventCode` (unique, short) | slug for SEO/share; eventCode for reference in exports and support |
| `TicketType` | `cuid()` | — | internal |
| `EventOrder` | `cuid()` | `orderNumber` (unique, human-readable) | reuses the existing `PAY-CART-<ts>-<hex>`-style uniqueness idea with a new prefix (`EVT-`) |
| `Ticket` | `cuid()` | `ticketCode` (unique, human-readable) + `qrToken` (opaque secret) | code for manual lookup; token for scanning |
| `Payment` | `cuid()` | `paymentReference` (unique) | links to provider `referenceId` |
| `PICProfile` | `cuid()` | `picCode` (unique, short) | used in share links |
| `Settlement` | `cuid()` | `settlementNumber` (unique) | printed on statements |

**Rule:** public identifiers (`orderNumber`, `ticketCode`, `eventCode`, `picCode`) are **non-guessable by construction** — a random suffix of at least 8 hex/base32 characters is appended, exactly as `lib/checkout.ts#makeOrderNumber` already does with `crypto.randomUUID()`. Sequential integers must never be exposed.

### 8.3 Global design rules

1. **Money** — Prisma `Decimal`, never `Float`/`Number` arithmetic. Details in §36.5.
2. **Rates** — stored as integer **basis points** (500 = 5.00%) in new tables to avoid decimal drift. Legacy `Decimal(5,2)` rate columns are not reused for new tables.
3. **Timestamps** — `createdAt @default(now())` and `updatedAt @updatedAt` on every mutable table. Immutable/append-only tables (`PICFeeLedger`, `AuditLog`, `WebhookEvent`, `CheckIn`) keep `createdAt` only.
4. **Soft delete** — only where legally/operationally required (`Event.archivedAt`, `User.disabledAt`). Financial rows are **never** soft-deleted; they are reversed by a counter-entry.
5. **Enums** — new enums use clean naming (`OrderStatus`, not `Order_status`). Legacy snake-style enums are left untouched and mapped at the boundary.
6. **Tenant column** — every tenant-scoped table carries `organizerId` (denormalized where needed for scan speed, e.g. `Ticket`), with a `(organizerId, ...)`-leading composite index.
7. **Append-only tables** — `PICFeeLedger`, `AuditLog`, `WebhookEvent`, `CheckIn`, `PaymentTransaction`. No `UPDATE` path is designed except: `WebhookEvent.processingStatus`, `WebhookEvent.processedAt`, `CheckIn` never, `PaymentTransaction` never after processing. Where a status must change (webhook processing result), the change is a monotonic forward-only transition.

---

## 9. Entity Relationship Design

### 9.1 Relationship map

```
User 1────* OrganizerMember *────1 Organizer
 │                                  │
 │                                  ├─* Venue                (organizerId nullable = platform-global)
 │                                  ├─* Event
 │                                  │    ├─* EventImage
 │                                  │    ├─* TicketType
 │                                  │    │     └─* TicketReservation
 │                                  │    ├─* PICEventAssignment *── PICProfile
 │                                  │    ├─* EventOrder
 │                                  │    │     ├─* OrderItem ─* Ticket
 │                                  │    │     │                   └─1 CheckIn
 │                                  │    │     ├─1 PICAttribution ─ PICProfile
 │                                  │    │     │        └─* PICFeeLedger
 │                                  │    │     ├─* Payment ─* PaymentTransaction
 │                                  │    │     └─0..1 Refund
 │                                  │    └─* StaffEventAssignment *── OrganizerMember
 │                                  └─* PICFeeLedger
 │
 ├─* EventOrder            (buyer)
 ├─* Ticket                (holder)
 └─0..1 PICProfile         (a user may be a PIC)

Sport 1────* Event
WebhookEvent *──── Payment (nullable) / EventOrder (nullable)
Settlement 1──* SettlementItem *── PICFeeLedger (nullable) / EventOrder-attributed earnings
Notification 1──* NotificationDelivery
Coupon 1──* EventOrder
```

### 9.2 Cardinality and delete rules

| Parent → Child | Cardinality | On delete of parent | Why |
| --- | --- | --- | --- |
| `Organizer → Event` | 1..* | `Restrict` | Never delete a tenant that has events; archive instead |
| `Event → TicketType` | 1..* | `Cascade` (draft only) / `Restrict` (published) | Deleting a ticket type that has sales or reservations must be impossible |
| `Event → EventImage` | 1..* | `Cascade` | Images are presentation data |
| `EventOrder → OrderItem` | 1..* | `Cascade` | Items have no meaning without the order |
| `OrderItem → Ticket` | 1..* | `Restrict` | Issued tickets must not vanish. Deleting an order is not a designed operation; only cancel/refund |
| `OrderItem → TicketType` | *..1 | `SetNull` | Keep the snapshot fields; a renamed/removed ticket type must not break history (mirrors the existing `OrderItem` `SetNull` pattern) |
| `EventOrder → PICAttribution` | 1..0..1 | `Restrict` | Financial traceability must survive |
| `PICAttribution → PICFeeLedger` | 1..* | `Restrict` | Ledger rows are permanent |
| `EventOrder → Payment` | 1..* | `Restrict` | Payments are permanent records |
| `Ticket → CheckIn` | 1..0..1 | `Restrict` | Check-in evidence is permanent |
| `Settlement → SettlementItem` | 1..* | `Restrict` | A settlement with items must be immutable |
| `PICProfile → PICEventAssignment` | 1..* | `Restrict` | Attribution history depends on it |
| `User → Ticket` | 1..* | `Restrict` | Tickets are evidence of purchase; user deletion must be an anonymization flow, not a cascade |

**Design rule:** the schema prefers `Restrict` over `Cascade` for anything financial or evidentiary. This is a deliberate departure from the legacy schema, which cascades broadly (e.g. `Cart`, `CartItem`, `Order` items) — acceptable for a cart, unacceptable for a ledger.

### 9.3 Cross-cutting relation rules

1. `Event.organizerId`, `EventOrder.organizerId`, `Ticket.organizerId` are **denormalized** from `Event`. They are written once at creation from the server-side scope, never accepted from a client, and verified by an invariant test (see §36). The denormalization exists because check-in and settlement queries must be single-index lookups.
2. `Ticket.eventId` is denormalized for the same reason and is validated against `TicketType.eventId` on creation.
3. `PICAttribution.organizerId` is denormalized to allow per-tenant fee aggregation without joining through events.
4. Every monetary child table (`OrderItem`, `PICFeeLedger`, `SettlementItem`) stores a **snapshot** of the values it depends on (rate, basis, price), so a later configuration change cannot retroactively alter a settled figure.

---

## 10. Event Model

### 10.1 Events are the product catalog

The brief (§3.1) requires every event to be a public catalog item with the same discoverability as a product. Design maps catalog concerns onto `Event` + `EventImage` + `TicketType`.

### 10.2 `Event` fields

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `organizerId` | `String` | **required**, immutable, tenant scope root |
| `sportId` | `String` | required; drives the category filter |
| `venueId` | `String?` | optional if the event is online/door-only |
| `title` | `String` | catalog title |
| `slug` | `String @unique` | canonical public URL segment |
| `eventCode` | `String @unique` | short human reference (exports, support) |
| `description` | `String? @db.Text` | rich text (sanitized) |
| `rules` | `String? @db.Text` | event regulations / refund policy shown at checkout |
| `bannerUrl` | `String? @db.Text` | primary banner (used for OG image and cards) |
| `status` | `EventStatus` | `DRAFT \| PUBLISHED \| CANCELLED \| COMPLETED \| ARCHIVED` |
| `visibility` | `EventVisibility` | `PUBLIC \| UNLISTED` — supports private share-only events |
| `startAt` | `DateTime` | event start |
| `endAt` | `DateTime?` | nullable (running/road events with no fixed end) |
| `salesStartAt` | `DateTime?` | null = immediately after publish |
| `salesEndAt` | `DateTime?` | null = until event start |
| `timezone` | `String @default("Asia/Jakarta")` | display and export timezone |
| `maxTicketsPerOrder` | `Int?` | event-level ceiling applied on top of `TicketType.maxPerOrder` |
| `requiresCheckIn` | `Boolean @default(true)` | false for merchandise/spectator-free events |
| `contactName` / `contactPhone` | `String?` | organizer contact shown to buyers |
| `publishedAt` | `DateTime?` | set on first publish |
| `cancelledAt` / `cancelReason` | `DateTime?` / `String?` | event cancellation (triggers bulk refund workflow, post-MVP) |
| `archivedAt` | `DateTime?` | soft delete; hidden from all public surfaces |
| `createdByUserId` | `String` | audit |
| `createdAt` / `updatedAt` | `DateTime` | |

### 10.3 `EventStatus` lifecycle

```
DRAFT ──publish──> PUBLISHED ──event passes──> COMPLETED
  │                    │                        │
  │                    └──cancel──> CANCELLED   └──archive──> ARCHIVED
  └──delete (hard, draft only, no sales) ──> gone
```

| Transition | Allowed by | Precondition | Effect |
| --- | --- | --- | --- |
| `DRAFT → PUBLISHED` | Manager/Admin (`event.publish`) | at least one active `TicketType` with `quota > 0`; `startAt` in the future; banner present (recommended, not enforced) | `publishedAt` set; event appears in the public catalog; audit entry |
| `PUBLISHED → DRAFT` (unpublish) | Manager/Admin | — | **Existing orders and issued tickets are unaffected.** The event disappears from public listings; direct detail URL shows an "unavailable" state. Decision point: whether unpublishing hides the page or keeps a read-only page (`DECISION REQUIRED` — D-14) |
| `PUBLISHED → CANCELLED` | Manager/Admin + Finance approval | — | Sales stop immediately; unpaid orders auto-expire; issued tickets become `VOID`; refund workflow engages (post-MVP automation) |
| `PUBLISHED → COMPLETED` | System (job, after `endAt`) or Manager | past `endAt` | Sales stop; check-in allowed to continue for a grace window; event remains readable |
| `COMPLETED/CANCELLED → ARCHIVED` | Manager/Admin | no open refunds/settlements | Hidden from admin lists by default; data retained |
| `DRAFT → deleted` | Manager/Admin | zero orders | Hard delete allowed only for a draft with no commercial history |

`DECISION REQUIRED` (D-13): **event approval workflow.** Does publishing require platform approval (draft → pending review → published), or is it immediate for trusted organizers? Design note: `EventStatus` should include `PENDING_REVIEW` only if approval is required; adding it later is a cheap additive migration, but the UI/notification flow differs enough that it should be decided before Phase 3.

### 10.4 `EventImage`

`id`, `eventId`, `url @db.Text`, `sortOrder Int`, `altText String?`, `createdAt`. Index `(eventId, sortOrder)`. Reuses the existing validated upload pipeline (`app/api/admin/upload/route.ts` — MIME allow-list + magic-byte check + randomized filename), with the disposition in §33.6.

### 10.5 Event catalog requirements mapping

| Requirement (brief §3.1) | Design element |
| --- | --- |
| See events | `GET /api/events` with filters + pagination (§25.2) |
| See event detail | `GET /api/events/{slug}` (§25.3) |
| See image/banner | `Event.bannerUrl` + `EventImage[]` |
| See date | `Event.startAt` / `endAt` + `timezone`, rendered in `Asia/Jakarta` |
| See location | `Venue.name`, `Venue.address`, `Venue.city`, optional coordinates with a map link |
| See sport category | `Sport` (controlled master data, not free text — replaces `Product.category`) |
| See ticket type | `TicketType[]` with `name`, `description`, `price`, `sortOrder` |
| See price | `TicketType.price` (`Decimal`), snapshot-copied into `OrderItem.priceSnapshot` at order time |
| See availability | `quota - reserved - sold` computed server-side. **Never expose `reserved` or raw counters** — expose `remaining`, `isSoldOut`, `salesOpen` only |
| Purchase | §11, §12, §26 |

**Availability exposure rule (security):** the public payload must not leak business-sensitive numbers (total quota, reserved count, sold count). It exposes `remaining: Int | null` (`null` when the organizer chooses to hide it), `isSoldOut: Boolean` and `salesState: NOT_STARTED | OPEN | CLOSED | SOLD_OUT`. Whether to hide remaining stock at all is `DECISION REQUIRED` — D-15 (some organizers want scarcity visible; others do not want competitors reading their sales rate).

### 10.6 Event sharing (requirement §4)

**Design:**

| Concern | Design |
| --- | --- |
| **Canonical public URL** | `https://tinggalklik.co/e/{slug}` — the single canonical form. Server-rendered, indexable, OG-tagged |
| **Canonical tag** | `<link rel="canonical" href="/e/{slug}">` on every variant, so tracking parameters never split SEO |
| **Legacy-compatible alias** | `/events/{slug}` may 301-redirect to `/e/{slug}` if a friendlier path is preferred. Pick one and keep it forever (`DECISION REQUIRED` — D-02) |
| **Slug uniqueness** | `Event.slug` is **globally unique** (`@unique`), not per-organizer. Reason: the public URL must resolve without a tenant prefix, which is the e-commerce catalog behaviour the brief requires. Slug is generated from the title and de-duplicated with a short random suffix on collision |
| **Custom share identifier** | Supported as a separate field: `Event.shareCode String? @unique` — a human-chosen short alias (e.g. `/e/final-basketball-2026`) that resolves to the same event. It exists so the organizer can print one memorable link without renaming the SEO slug. `DECISION REQUIRED` — D-03: whether a second public identifier is worth the ambiguity |
| **Share URL** | `https://tinggalklik.co/e/{slug}?ref={shareToken}` where `shareToken` identifies the *sharer* (PIC code or a generic share id). Used for attribution only; canonical URL stripped |
| **QR** | Same URL encoded as a QR (reuses `qrcode.react`, already a dependency). Also offered as a downloadable PNG for print |
| **Social sharing** | Server-rendered OG/Twitter meta (`og:title`, `og:description`, `og:image` = banner, `og:url` = canonical). A share sheet with WhatsApp / X / Facebook / copy-link. WhatsApp is the primary channel for the Indonesian market |
| **PIC tracking link vs public share link** | **Differentiated by design.** The public share link is `/e/{slug}` (no attribution). The PIC link is `/e/{slug}?pic={picCode}` or the short form `/p/{picCode}` which resolves to the PIC's assigned event (if exactly one) or a PIC landing page listing their assigned events. Only the second carries attribution |
| **Attribution propagation** | The PIC code is captured into a first-party cookie (httpOnly=false is acceptable for a referral code; signed value preferred) with a finite TTL, then persisted to `PICAttribution` at order creation, never trusted from the client at settlement time (§14.3) |
| **Tracking PIC if the link did not come from a PIC** | `PICAttribution` is simply absent, and the order is recorded as direct (`attributionSource = NONE`). No synthetic PIC is invented |

`DECISION REQUIRED` (D-01): **PIC tracking link model** — whether the PIC link is per-(PIC, event), a single global PIC code resolving via cookie, or both (§14.2 options). `DECISION REQUIRED` (D-04): **attribution window and rule** (session-only vs 30/60/90-day cookie; last-click vs first-click). These two decisions must be made before Phase 9, because they change the `PICAttribution` schema and the cookie contract.

---

## 11. Ticket & Quota Model

### 11.1 `TicketType`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `eventId` | `String` | required |
| `name` | `String` | e.g. `Tribun`, `VIP`, `Early Bird`, `5K`, `10K` |
| `description` | `String? @db.Text` | benefits, entry rules |
| `price` | `Decimal(14,2)` | IDR; validated `>= 0` |
| `currency` | `String @default("IDR")` | reserved for future multi-currency; single value in MVP |
| `quota` | `Int` | hard cap ≥ 0 |
| `sold` | `Int @default(0)` | confirmed (paid → issued) |
| `reserved` | `Int @default(0)` | held by unexpired reservations |
| `minPerOrder` | `Int @default(1)` | |
| `maxPerOrder` | `Int?` | null = event-level/global ceiling applies |
| `salesStartAt` | `DateTime?` | null = event `salesStartAt` |
| `salesEndAt` | `DateTime?` | null = event `salesEndAt` |
| `isActive` | `Boolean @default(true)` | manual on/off switch |
| `sortOrder` | `Int @default(0)` | display order |
| `version` | `Int @default(0)` | optimistic-lock / cache-busting token |
| `createdAt` / `updatedAt` | `DateTime` | |

**Invariant:** `sold + reserved <= quota` at all times, for every row. This is enforced by the write paths in §11.2, not by a database trigger (MySQL triggers are invisible to reviewers and hard to test), and it is asserted by an invariant test that runs after every concurrency test (§36.2).

### 11.2 Overselling prevention — the reused Phase 0 primitive

Phase 0 established the correct primitive in `lib/checkout.ts` (flash-sale reservation):

```sql
UPDATE flashsale
   SET saleStock = saleStock - n, soldCount = soldCount + n
 WHERE id = ? AND isActive = true AND saleStock >= n
-- affectedRows === 0  ⇒  insufficient ⇒ abort the transaction
```

A single conditional `UPDATE` performs check-and-decrement atomically under the row lock, so no read-then-write race exists. **The design adopts exactly this shape for ticket quota** (never `SELECT` then `UPDATE`, never a JavaScript-side comparison as the guard).

**Reserve (order creation):**

```sql
UPDATE tickettype
   SET reserved = reserved + n, version = version + 1
 WHERE id = ?
   AND isActive = true
   AND reserved + sold + n <= quota
-- affectedRows === 0 ⇒ SOLD_OUT (HTTP 409, code SOLD_OUT)
```

**Confirm (payment settled, inside the settlement transaction):**

```sql
UPDATE tickettype
   SET reserved = reserved - n, sold = sold + n, version = version + 1
 WHERE id = ? AND reserved >= n
-- affectedRows === 0 ⇒ data-integrity alarm: reserved underflow (must never happen)
```

**Release (cancel / expire / failed payment):**

```sql
UPDATE tickettype
   SET reserved = GREATEST(0, reserved - n), version = version + 1
 WHERE id = ?
-- guarded so a duplicate release cannot drive reserved negative
```

Each statement is executed **inside the same transaction** as the state change it belongs to, so an order row and its reservation can never diverge.

### 11.3 Multi-ticket-type orders

An order may contain several ticket types. Two safe strategies exist:

| Strategy | Behaviour | Verdict |
| --- | --- | --- |
| **A. Per-row conditional UPDATE, ordered by `ticketTypeId` ascending** | Locks are acquired in a deterministic order | **Recommended** |
| B. `SELECT ... FOR UPDATE` then validate then update | Extra round trip; holds locks longer | Use only if a business rule needs re-reading the counters before deciding |

Deterministic lock ordering (A) prevents the classic two-transaction deadlock where order X locks type 1 then 2 while order Y locks 2 then 1. **Design rule: always iterate ticket types sorted by `ticketTypeId`.** If any row's `affectedRows === 0`, the whole transaction rolls back and the API returns `SOLD_OUT` naming the specific ticket type, so the buyer can adjust their selection.

### 11.4 Reservation, expiry and the reaper

Phase 0 finding **P-2**: today nothing releases a held resource except the gateway webhook or the user's *next* checkout attempt (`cleanupPendingCheckoutOrders`). For ticketing that produces phantom sold-out events. Design:

| Concern | Design |
| --- | --- |
| Reservation holder | One `TicketReservation` row per `(orderId, ticketTypeId)`: `id`, `orderId`, `ticketTypeId`, `eventId`, `quantity`, `status` (`HELD \| CONFIRMED \| RELEASED \| EXPIRED`), `expiresAt`, `createdAt`, `updatedAt` |
| TTL | `expiresAt = now + TTL`. `TTL` is configurable per platform (`PlatformSetting.reservationTtlMinutes`), default **30 minutes**, and must be ≤ the gateway session expiry (§13.4) |
| Reaper | A scheduled job (Phase 2 introduces the runner, §40) selects `status = HELD AND expiresAt < now()` in batches, then for each: CAS `HELD → EXPIRED`, decrement `reserved`, and transition the parent order to `EXPIRED` if all its reservations expired |
| Idempotency | The reaper's CAS (`WHERE status = 'HELD'`) plus the `GREATEST(0, ...)` release guard make a double-run safe |
| Partial expiry | If one ticket type's reservation expires while another is still held (possible only with different TTLs), the order stays `PENDING_PAYMENT` and the expired line is removed. MVP simplification: a single TTL per order, so this cannot occur — **recommended** |
| Expired-but-paid | If a webhook settles an order whose reservations already expired, the settlement must fail-safe: the order stays `PAID` with `fulfilmentBlockedAt` set, tickets are **not** issued, and an operator alert/queue entry is created (Phase 0 **R-2**). This is the "paid but unfulfillable" path and must be explicitly designed, not discovered in production |

**Job interval:** every 1 minute (worst-case reservation tail = TTL + 1 minute). Runs as a single-flight job so overlapping invocations cannot double-release (**P-3**).

### 11.5 Individual tickets per unit

The brief (§18) requires that a quantity purchase yields individual tickets:

```
EventOrder
  └── OrderItem (quantity = 3, ticketType = Tribun)
        ├── Ticket #1   ticketCode = EVT-7K3M-0A1B   qrToken = <opaque>
        ├── Ticket #2   ticketCode = EVT-7K3M-0A1C   qrToken = <opaque>
        └── Ticket #3   ticketCode = EVT-7K3M-0A1D   qrToken = <opaque>
```

Issuance happens **inside the settlement transaction** (§13.3), one row per unit, so a crash cannot produce a paid order with a partial set of tickets. Ticket-level details (fields, token, lifecycle) are in §18–§19.

### 11.6 Quota scenarios — required outcomes

| Scenario | Required outcome |
| --- | --- |
| Two buyers race for the last ticket | Exactly one reservation succeeds; the other receives `SOLD_OUT` (409). Never both |
| 100 concurrent buyers, 50 tickets | Exactly 50 successful reservations, 50 `SOLD_OUT`, `sold + reserved == quota == 50`, and zero issued tickets until payment |
| Reservation expires while payment pending | Reaper releases the quota; `sold` unchanged; the buyer's later payment attempt is blocked by the cancelled/expired order state (§12.3) |
| Payment settles after expiry | No tickets issued; `fulfilmentBlockedAt` set; operator queue (§11.4) |
| Order cancelled by the buyer before payment | Reservations released immediately; quota returns to availability |
| Refund of an issued ticket | `sold` is **not** automatically decremented (the ticket was consumed from the quota). Whether a refund returns quota to sale is a policy flag: `Event.returnQuotaOnRefund Boolean @default(false)`. `DECISION REQUIRED` — D-08 |
| Event cancelled | All `HELD` reservations released; all unpaid orders `EXPIRED`; issued tickets `VOID`; refund workflow per policy |
| Quota reduced by an organizer after sales | Allowed only down to `sold + reserved`; below that the request is rejected (`CONFLICT`) |
| Ticket type deactivated mid-sale | No new reservations; existing reservations remain valid and still confirm |

### 11.7 What is deliberately not designed

- **No waiting list / virtual queue** in MVP (§4.2). The quota CAS is sufficient for the expected volume; a queue is only warranted when a single ticket type sells thousands of units in seconds.
- **No seat-level locking** (`Seat`, `SeatHold`, seat maps) in MVP. The model is quantity-based per ticket type. Adding seats later is additive: a `Seat` table plus a unique `(ticketTypeId, seatLabel)` constraint on `Ticket`, without changing the quota logic.
- **No `SELECT FOR UPDATE`** in the hot path (see §11.3).

---

## 12. Order Model

### 12.1 `EventOrder`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `orderNumber` | `String @unique` | public identifier, e.g. `EVT-1758000000000-7f3a91c2` |
| `organizerId` | `String` | **denormalized tenant scope, required** |
| `eventId` | `String` | an order belongs to one event (multi-event carts are out of scope) |
| `userId` | `String` | buyer account |
| `buyerName` / `buyerEmail` / `buyerPhone` | `String` | contact snapshot (a buyer may buy for a different attendee; per-ticket attendee names are in §18) |
| `status` | `OrderStatus` | see §12.2 |
| `paymentStatus` | `PaymentStatus` | see §13.1 |
| `subtotal` | `Decimal(14,2)` | Σ item subtotals after ticket-level pricing, before discount |
| `discount` | `Decimal(14,2) @default(0)` | coupon discount (post-MVP coupons; field exists from day one) |
| `platformFee` | `Decimal(14,2) @default(0)` | platform's cut (snapshot) |
| `gatewayFee` | `Decimal(14,2)?` | provider fee, filled on settlement if the gateway reports it (§16.4) |
| `picFeeTotal` | `Decimal(14,2) @default(0)` | Σ PIC fees for this order (snapshot; source of truth is the ledger) |
| `total` | `Decimal(14,2)` | amount the buyer actually pays |
| `organizerNetAmount` | `Decimal(14,2)` | what the organizer is owed for this order |
| `currency` | `String @default("IDR")` | |
| `couponId` / `couponCode` | `String?` | snapshot of the applied coupon |
| `picAttributionId` | `String? @unique` | nullable; set once at creation (§14) |
| `expiresAt` | `DateTime?` | payment window; drives the expiry job |
| `paidAt` | `DateTime?` | set by the settlement CAS |
| `cancelledAt` / `cancelReason` | `DateTime?` / `String?` | buyer or system cancellation |
| `refundedAmount` | `Decimal(14,2) @default(0)` | accumulates across partial refunds |
| `fulfilmentBlockedAt` | `DateTime?` | set when settlement arrived but tickets could not be issued (§11.4) |
| `note` | `String? @db.Text` | buyer note |
| `createdAt` / `updatedAt` | `DateTime` | |

Indexes: `orderNumber` unique, `(userId, createdAt)`, `(eventId, status)`, `(organizerId, status, createdAt)`, `(status, expiresAt)`, `(paymentStatus)`, `(creatorPIC-facing) picAttributionId` unique.

**Do not carry over from the legacy `Order`:** `recipientName`, `address`, `city`, `district`, `province`, `postalCode`, `latitude`, `longitude`, `shippingCost`, `shippingCourier`, `shippingService`, `trackingNumber`, `trackingUrl`, `shippingDiscount*`, `spinWheelSpin*`, `originalSpinWheelSpinId`, `affiliateConversion`, `voucherId`/`voucherCode` (renamed to `coupon*`). Every one of these is a shipping or retail-marketing concern with no ticketing meaning.

### 12.2 `OrderStatus` and why each value exists

```
PENDING_PAYMENT → PAID → (PARTIALLY_REFUNDED) → REFUNDED
      │
      ├→ CANCELLED     (buyer cancellation, or admin cancel of an unpaid order)
      └→ EXPIRED       (payment window elapsed; reservations reaped)
```

| Status | Meaning | Explicitly added because |
| --- | --- | --- |
| `PENDING_PAYMENT` | Created, reservations held, awaiting payment | Replaces the ambiguous legacy `PENDING` (which conflated "awaiting payment" with "being processed") |
| `PAID` | Verified settlement received; tickets issued | Terminal for the sales flow; entry point for refunds and fee accrual |
| `CANCELLED` | Buyers/system cancelled before payment, or an admin cancelled | Distinguishes *deliberate human action* from *timeout* |
| `EXPIRED` | Payment window elapsed with no settlement | Distinguishes *timeout* from *human cancellation* — the two need different reporting, different notifications and different reaper handling |
| `REFUNDED` | Fully refunded | Needed for bookkeeping and for blocking resurrection |
| `PARTIALLY_REFUNDED` | Some tickets refunded, others still valid | **Required** by the individual-ticket model: a 3-ticket order where 1 is refunded cannot be labelled `REFUNDED` |
| ~~`PROCESSING`~~ | **Not added** | The brief forbids adding statuses without reason. Nothing in the ticketing flow needs a "processing" state: issuance is transactional, so there is no observable interval between `PENDING_PAYMENT` and `PAID` |
| ~~`COMPLETED`~~ | **Not added** | An event finishing is an `Event` state, not an order state. The legacy `COMPLETED` conflated delivery completion with order closure — a courier concept |
| ~~`SHIPPED`~~ | **Not added** | Courier concept |

### 12.3 Transition table

| From → To | Who | Preconditions | Quota effect | PIC fee effect | Payment effect | Ticket effect |
| --- | --- | --- | --- | --- | --- | --- |
| *(none) → `PENDING_PAYMENT` | System, on checkout | reservations acquired for all lines; pricing recomputed server-side | `reserved += n` | attribution captured (not yet a fee) | `Payment` row created | none yet |
| `PENDING_PAYMENT → PAID` | System, **webhook only** | valid signature; amount matches `total`; webhook ledger row inserted; `affectedRows = 1` on the CAS | `reserved -= n`, `sold += n` | `PICFeeLedger` credit entries created (status `EARNED`) | `Payment.status = PAID`, `PaymentTransaction` recorded | one `Ticket` per unit, status `ISSUED` |
| `PENDING_PAYMENT → CANCELLED` | Buyer (`order.cancel.own`), Manager/Admin | `paymentStatus != PAID` | `reserved -= n` (release) | none | open `Payment` voided | none |
| `PENDING_PAYMENT → EXPIRED` | System (reaper/expiry job) | `expiresAt < now`, no settlement | `reserved -= n` (release) | none | open `Payment` voided | none |
| `PAID → REFUNDED` | Manager/Finance (approve + execute) | `Refund.status` reaching `COMPLETED`; refundable amount > 0 | `sold` unchanged unless `returnQuotaOnRefund` | ledger `REVERSED` entries for the refunded quantity | refund recorded | tickets `REFUNDED`, QR invalidated |
| `PAID → PARTIALLY_REFUNDED` | Manager/Finance | as above, refunded quantity < ordered quantity | as above | `REVERSED` for the refunded portion only | refund recorded | only refunded tickets voided |
| `PAID → CANCELLED` | **Not allowed** | — | — | — | — | — | Paid orders leave the paid state only via refund. This is the Phase 0 anti-resurrection rule |
| `CANCELLED / EXPIRED → PAID` | **Not allowed** (CAS rejects) | — | — | — | Late settlement is recorded by the webhook as `paymentStatus = PAID` **without** issuing tickets, raising an operator alert (§11.4) | Special case: `paymentStatus` may become `PAID` while `status` stays `CANCELLED` — this mismatch is exactly what the operator queue exists to resolve |
| `REFUNDED → *` | **Not allowed** | — | — | — | terminal | — |
| `EXPIRED → CANCELLED` | Not needed | — | — | — | Both are terminal and semantically distinct; no cross-transition | — |

### 12.4 Repayment

Phase 0 found `lib/repay.ts` implements repayment eligibility (`FAILED`/`EXPIRED`/`PENDING` payment status) plus re-reservation of stock before a new payment attempt. **KEEP (ADAPT)**: the same shape applies to tickets, with one change — a re-reservation must re-run the quota CAS, because availability may have changed while the order was expired. If the CAS fails at repayment time, the correct response is `SOLD_OUT` for that ticket type and the buyer must adjust their order; the design does **not** silently keep the old price or the old quota.

`DECISION REQUIRED` (D-09): whether a `CANCELLED`/`EXPIRED` order may be repaid at the **original** price or must be re-priced at current `TicketType.price`. Recommendation: re-price (the old price may belong to a sales window that has closed), and show the new total for explicit confirmation.

---

## 13. Payment Model

### 13.0 Principle

The brief is explicit: keep the existing payment foundation, do not rewrite it without reason (brief §20). Phase 0 verified that `app/api/payment/ipaymu/notification/route.ts` already implements every property a ticketing platform needs. The design therefore **wraps and extends** the existing chain rather than replacing it.

| Phase 0 verified property | Preserved? |
| --- | --- |
| Raw body read before parsing (signature covers exact bytes) | Yes — unchanged |
| HMAC-SHA256 signature verification with fail-closed 401 | Yes — unchanged |
| Environment-aware credential resolution (`lib/payment/config.ts`, frozen config, base-URL allowlist) | Yes — unchanged |
| Amount verification (prefers `sub_total` over `amount`) | Yes — retargeted to `EventOrder.total` |
| Status classification into `success \| pending \| failed \| unknown` | Yes — extended with the ticketing branches |
| Atomic CAS settlement (`affectedRows === 0` ⇒ idempotent no-op or terminal state) | Yes — extended to also move quota and issue tickets |
| Terminal states never resurrected | Yes — identical guard |
| Unknown statuses acknowledged 200 and never mutate | Yes — unchanged |
| Failures release reservations and cancel dependent records | Yes — retargeted from stock/voucher to quota |
| Refund reconciliation via CAS + shared completion function | Yes — `lib/refund.ts` adapted |

### 13.1 `PaymentStatus`

`UNPAID | PENDING | PAID | FAILED | EXPIRED | REFUNDED | PARTIALLY_REFUNDED`

Mapping from the legacy `Order_paymentStatus` (`UNPAID, PENDING, PAID, FAILED, EXPIRED, REFUNDED`): identical, with `PARTIALLY_REFUNDED` added for the per-ticket refund model.

### 13.2 `Payment` and `PaymentTransaction`

**`Payment`** — one logical attempt per order (at most one in a non-terminal state at a time):

`id`, `orderId`, `organizerId`, `provider` (`ipaymu`), `providerEnvironment` (`sandbox \| production` — snapshot, so a later environment switch cannot mis-explain an old payment), `method` (`BANK_TRANSFER \| E_WALLET \| QRIS`), `channel` (`bca`, `bni`, `bri`, `permata`, `qris`), `amount Decimal(14,2)`, `currency`, `status`, `externalSessionId` (provider session), `paymentReference` (unique; the value sent as `referenceId` — equals `orderNumber` per the Phase 0 implementation, but stored explicitly so it can change independently), `paymentUrl`, `expiresAt`, `createdAt`, `updatedAt`, `createdByUserId`.

Indexes: `(orderId, status)`, `paymentReference` unique, `externalSessionId` index, `(status, expiresAt)` for the expiry job.

`DECISION REQUIRED` (D-16): the legacy route passes `expired: 1` to iPaymu and the unit (hours vs minutes) has never been verified. `Payment.expiresAt` must be derived from the **same** value as the gateway's own expiry, otherwise a customer can pay a session that the platform already considers expired (or vice versa). Verify against sandbox before Phase 7.

**`PaymentTransaction`** — the provider's record of money movement (may be several per payment: attempts, retries, captures, refunds):

`id`, `paymentId`, `orderId`, `organizerId`, `provider`, `providerTransactionId` (indexed, **not** globally unique — the same provider id may legitimately appear on multiple event types), `type` (`PAYMENT \| REFUND \| FEE`), `amount Decimal(14,2)`, `providerFee Decimal(14,2)?`, `status`, `rawSummary Json?` (redacted: no PII, no secrets), `occurredAt`, `createdAt`.

**Append-only.** No update path after creation, except `status` advancing monotonically.

### 13.3 Settlement transaction shape (the critical path)

Everything below happens in **one** database transaction, in this order. External calls are banned inside it (Phase 0 already respects this).

```
1. WebhookEvent insert (providerEventId UNIQUE)
     └─ duplicate ⇒ abort (200 no-op)  ⟵ replay/replay-storm protection
2. Resolve EventOrder by provider reference
3. Verify amount == EventOrder.total   (mismatch ⇒ 400, no mutation)
4. CAS: eventorder SET status='PAID', paymentStatus='PAID',
        paidAt=COALESCE(paidAt, now)
        WHERE id=? AND status='PENDING_PAYMENT' AND paymentStatus != 'PAID'
     └─ 0 rows ⇒ already settled (idempotent) OR terminal (cancelled/expired)
5. Payment: CAS status → PAID ; insert PaymentTransaction
6. Per OrderItem: quota CAS  reserved -= q, sold += q
     └─ failure ⇒ integrity alarm (never expected; reserved was held)
7. Per OrderItem: issue q × Ticket rows (status ISSUED, ticketCode, qrToken)
8. PICAttribution: finalize (isFinal = true, finalizedAt = now)
9. PICFeeLedger: insert credit entries (unique per (orderItemId, type))
10. EventOrder: set picFeeTotal / platformFee / organizerNetAmount snapshots
11. COMMIT
--- after commit, outside the transaction ---
12. Enqueue notification: TICKET_ISSUED (customer), ORDER_PAID (organizer/manager),
    PIC_FEE_CREATED (PIC) — all idempotent via Notification.idempotencyKey
```

Steps 4–10 being atomic is what makes "paid but ticketless" impossible except in the documented expiry-race case (§11.4), which is handled by step 4 returning 0 rows and the operator queue.

### 13.4 `PaymentState` machine

```
(none) → UNPAID → PENDING → PAID
                     │  │
                     │  ├→ FAILED    (provider failure)      → order CANCELLED
                     │  └→ EXPIRED   (session/window elapsed) → order EXPIRED
                     │
                     └→ (PAID) → PARTIALLY_REFUNDED → REFUNDED
```

| Transition | Trigger | Side effects |
| --- | --- | --- |
| `UNPAID → PENDING` | `POST /checkout` after the gateway session is created | `Payment` row (PENDING), `expiresAt` set, order `expiresAt` aligned |
| `PENDING → PAID` | verified webhook | §13.3 steps 4–11 |
| `PENDING → FAILED` | webhook failed classification | release reservations; cancel attributed commission/PIC fee (none exists yet); order `CANCELLED` with `paymentStatus = FAILED`; notify buyer |
| `PENDING → EXPIRED` | expiry job (server clock) **or** gateway expiry webhook | release reservations; order `EXPIRED`; notify buyer with a resume-payment link |
| `PAID → PARTIALLY_REFUNDED` | refund completion with refunded qty < ordered qty | ledger reversal for the refunded portion; tickets voided |
| `PAID → REFUNDED` | refund completion, full | ledger reversal for all; all tickets voided |
| any → `PAID` after terminal | **Blocked** | The CAS cannot resurrect. The webhook records the mismatch and raises an operator alert (§11.4) |

### 13.5 Gateway abstraction boundary

Phase 0 has `lib/payment/config.ts`, `lib/payment/ipaymu.ts`, `lib/payment/ipaymu-production.ts`. The design keeps those and adds a thin seam so ticketing code never imports iPaymu directly:

```
lib/ticketing/payment/service.ts
    createSession(order)        → { paymentUrl, providerSessionId, expiresAt }
    settlementFor(webhookEvent) → { verdict: PAID | PENDING | FAILED | UNKNOWN, reference }
    refund(order, amount)       → { providerRef }        (post-MVP / if supported)

        implemented by →  lib/payment/ipaymu/ (existing code, adapted)
        future        →  another provider, same seam
```

`DECISION REQUIRED` (D-17): whether a second payment provider (e.g. a direct bank VA or a local QRIS aggregator) must be supported at launch. If yes, the seam above is mandatory in Phase 7; if no, it is still cheap insurance and is recommended.

### 13.6 Idempotency and replay summary (details in §30–§31)

| Risk | Guard |
| --- | --- |
| Duplicate webhook delivery | `WebhookEvent.providerEventId` unique → second insert fails → 200 no-op |
| Replay of an old valid payload | Same unique constraint, plus the order CAS |
| Double ticket issuance | Issuance runs only after the CAS returns `affectedRows === 1`; `Ticket.(orderItemId, sequenceNo)` unique |
| Double PIC fee | `PICFeeLedger.(orderItemId, type)` unique |
| Double refund | `Refund` CAS + unique constraint per order (MVP) or per ticket |
| Double notification | `Notification.idempotencyKey` unique (already in Phase 0) |

---

## 14. PIC Attribution Model

### 14.1 Entities

**`PICProfile`** (replaces `AffiliateProfile`; the name "affiliate" is not used in the new domain)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `userId` | `String @unique` | one PIC profile per user |
| `picCode` | `String @unique` | short, non-guessable (e.g. `ANDI-7K3M`), used in share links |
| `displayName` | `String` | name shown on statements and landing pages |
| `status` | `PICStatus` | `PENDING \| ACTIVE \| SUSPENDED \| REJECTED` |
| `defaultFeeRateBp` | `Int @default(0)` | default PIC fee rate in **basis points** (500 = 5.00%); 0 means "use the platform default" |
| `canSellAllEvents` | `Boolean @default(false)` | true = may earn on any published event; false = only assigned events |
| `bankName` / `bankAccountName` / `bankAccountNumber` | `String?` | settlement destination |
| `taxId` / `identityNote` | `String?` | **deliberately not an image upload** — see §33.2 (no KTP scans in the repository) |
| `approvedByUserId` / `approvedAt` | `String?` / `DateTime?` | |
| `suspendedAt` / `suspendReason` | `DateTime?` / `String?` | |
| `createdAt` / `updatedAt` | `DateTime` | |

**`PICEventAssignment`** — which PIC may sell which event, and on what terms:

`id`, `picProfileId`, `eventId`, `organizerId`, `feeRateBp Int?` (null = inherit), `feeTypeOverride PICFeeType?`, `assignedByUserId`, `assignedAt`, `revokedAt`, `isActive Boolean @default(true)`, timestamps. Unique `(picProfileId, eventId)`. Indexes `(eventId, isActive)`, `(picProfileId, isActive)`.

**`PICAttribution`** — one row per order (business decision: attribution is per order, not per item — see D-06):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `orderId` | `String @unique` | one attribution per order |
| `organizerId` | `String` | denormalized |
| `eventId` | `String` | |
| `picProfileId` | `String` | |
| `source` | `PICAttributionSource` | `LINK \| MANUAL \| NONE` |
| `method` | `PICAttributionMethod?` | `FIRST_TOUCH \| LAST_TOUCH \| MANUAL_OVERRIDE \| PIC_LANDING` |
| `shareToken` | `String?` | the token that was actually clicked (audit evidence) |
| `firstTouchAt` / `lastTouchAt` | `DateTime?` | cookie-derived evidence |
| `capturedAt` | `DateTime @default(now())` | when the order inherited the attribution |
| `isFinal` | `Boolean @default(false)` | false while the order is unpaid |
| `finalizedAt` | `DateTime?` | set by the settlement transaction |
| `overriddenByUserId` / `overrideReason` | `String?` / `String?` | manual override with reason (audited) |
| `createdAt` / `updatedAt` | `DateTime` | |

Indexes: `orderId` unique, `(picProfileId, createdAt)`, `(eventId, createdAt)`, `(organizerId, createdAt)`.

### 14.2 The three options analysed (brief §6)

| | **Option A — PIC link only** | **Option B — PIC on the order only** | **Option C — hybrid** |
| --- | --- | --- | --- |
| How the PIC is identified | A unique link per (PIC, event) carrying `?pic=` | A manager/operator selects the PIC when creating or reviewing the order | A: link capture where possible, B: manual fallback |
| Where attribution is stored | Derivable from the click; must still be materialized onto the order | `order.picId` chosen by a human | `PICAttribution` with `source` discriminating the two |
| Can attribution change? | Only before order creation (cookie) | Any time a human edits it — **dangerous by default** | Only before payment; after payment only via an audited adjustment |
| When is it final? | At payment | Unclear — the weak point of B | At payment (`isFinal = true`) |
| Refund effect | Fee reversed for the refunded portion | Same | Same |
| Cancellation effect | No fee (never earned) | No fee | No fee |
| Duplicate attribution | Possible if the buyer opens two PIC links (last/first-click rule required) | Structurally impossible | Prevented by the single-attribution-per-order constraint plus a deterministic rule |
| Direct / non-PIC orders | No attribution row | Needs an explicit "none" convention | `source = NONE` — explicit, unambiguous |
| Audit strength | Weak if the click is not persisted | Weak (human memory) | Strong: click evidence + who set it + when |
| Failure mode | Attribution lost if cookies are blocked | Money allocated by whoever last edited the order | Link capture degrades to manual, never to silent loss |

**Analysis.** Option A alone is unacceptable because cookie loss (private browsing, in-app browsers, iOS restrictions) would silently orphan sales that the PIC genuinely drove — the PIC loses real money through no fault of their own. Option B alone is unacceptable for the opposite reason: a fee obligation would depend entirely on a human's memory and could be changed after the fact, which is precisely the financial-integrity failure the brief warns about (§11 forbids freely mutating fees). Option C is the only design that degrades safely: automated capture when possible, audited manual attribution when not, with the same immutable record shape for both.

**Recommendation: Option C**, with these rules:

1. **Capture** — the PIC code in the URL is stored in a signed, httpOnly cookie (`pic_ref`) with a configurable TTL, on any `/e/{slug}?pic=...` or `/p/{picCode}` visit. The cookie holds `{ picCode, shareToken, firstTouchAt, lastTouchAt }`; `lastTouchAt` is refreshed on each visit.
2. **Persist** — at `POST /checkout`, the server resolves the cookie to an *active* `PICEventAssignment` for the requested event. If none exists, the code is ignored and no attribution is created (no fee is owed for an event the PIC is not assigned to).
3. **Validate server-side** — the client never sends `picProfileId`. Only an opaque `shareToken` is ever sent, and only as a hint; the server re-resolves it against the DB.
4. **Materialize** — one `PICAttribution` row is created with `source = LINK` and `isFinal = false`.
5. **Manual fallback** — a Manager may create an attribution with `source = MANUAL` for an order whose buyer genuinely came through a PIC but whose cookie was lost. This is permissioned (`pic.attribution.manual`) and always audited with a reason.
6. **Finalize** — the settlement transaction sets `isFinal = true, finalizedAt = now`. From then on the row is immutable; corrections happen as ledger adjustments (§15.5), never by editing `PICAttribution`.
7. **Rule tie-break** — a single deterministic rule resolves multiple touches. `DECISION REQUIRED` (D-04): first-click vs last-click, and the window. Recommendation: **last-click within the event's sales window, with a 30-day cookie**, because last-click is what a PIC can reason about, and a bounded window prevents a single click from claiming a sale a year later.

### 14.3 Duplicate-attribution prevention

| Vector | Guard |
| --- | --- |
| One order, two PIC cookies (two tabs) | `PICAttribution.orderId` is `@unique`; only the first materialization wins. The losing touch is recorded in `shareToken`/`lastTouchAt` evidence fields if useful, but no second row is created |
| Same buyer, re-purchase later | New order ⇒ new attribution; a cookie that still lives claims it — intended behaviour of the chosen window |
| PIC bought through their own link | **Allowed by default**, flagged (`PICAttribution.selfReferral = true`) and excluded from fee calculation unless the platform allows it. `DECISION REQUIRED` — D-07: are self-referrals (and PIC buying their own event's tickets) fee-eligible? Recommendation: exclude, and surface the volume in reporting |
| Multiple PICs assigned to one event | Assignment is per (PIC, event) and is many-to-many by design (brief §5: Event A → PIC Andi, Budi, Citra). Attribution picks exactly one via the touch rule |
| PIC suspended mid-flight | Attribution already materialized stays valid for orders already created; new checkouts resolve to `NONE` because the assignment is inactive. `DECISION REQUIRED` (D-10): does a suspension cancel *unpaid* attributed orders' future fee? Recommendation: yes for unpaid, never for paid |
| Late manual override after payment | Blocked unless `fee.adjust` is held; the result is a ledger adjustment, not an attribution edit |

### 14.4 Non-PIC orders

An order with no PIC is stored with **no `PICAttribution` row at all** — not a sentinel PIC. Reporting treats "no attribution" as direct/platform sales. This keeps `SUM(picFee)` correct, keeps the PIC list free of a fake "PLATFORM" PIC, and makes "how much came from PICs?" a simple `NOT NULL` join count.

`DECISION REQUIRED` (D-06): attribution granularity — **per order** (simpler, one fee per sale) or **per order line** (needed only if different ticket types on one order can belong to different PICs, which is not an observed requirement). Recommendation: per order.

---

## 15. PIC Fee Ledger

### 15.1 Why a ledger, not a column

The brief (§7) requires financial traceability: not `Order.picFee`, but a chain that explains where every rupiah came from and where it went:

```
EventOrder
   └── OrderItem            (snapshot: ticket type, unit price, quantity)
         └── PICAttribution  (who gets credit, why, and with what evidence)
               └── PICFeeLedger    (append-only entries: earned, reversed, adjusted, paid)
                     └── SettlementItem → Settlement (when it was actually paid out)
```

Properties a column cannot provide, and the ledger can:

| Requirement | Column (`Order.picFee`) | Ledger |
| --- | --- | --- |
| Audit a single transaction | Needs a join to whatever the rate was at the time (unknowable if the rate changed) | Each entry stores the rate and basis it used |
| Partial refund | Must recompute and overwrite | New `REVERSED` entry for the refunded portion; the original stays |
| Rate change | Historical rows silently disagree with the new rate | Entries keep their snapshots; only future entries use the new rate |
| Dispute ("PIC claims 20 sales") | Reconstruct from orders and guess the rate | Sum the ledger; every entry points at its order item |
| Settlement | No way to know what has been paid | `SettlementItem` links exactly which entries a payout covered |
| Adjustment (goodwill, correction) | Impossible without lying about the original | `ADJUSTMENT` entry with a reason and an author |
| Idempotency | A re-run of the settlement recomputes and may double-count | Unique key per (order item, type) makes double-crediting impossible |
| Reversal on refund | Ambiguous (was it ever accrued?) | Explicit `REVERSED` entry with a link to the `Refund` |

### 15.2 `PICFeeLedger` fields

Append-only. `createdAt` only; **no `updatedAt`**, because nothing updates.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `picProfileId` | `String` | payee |
| `organizerId` | `String` | tenant scope (denormalized for aggregation) |
| `eventId` | `String` | |
| `orderId` | `String` | |
| `orderItemId` | `String?` | null for order-level or manual adjustments |
| `ticketTypeId` | `String?` | snapshot for reporting |
| `type` | `PICFeeEntryType` | `EARNED \| REVERSED \| ADJUSTMENT \| PAYOUT \| PAYOUT_REVERSAL` |
| `direction` | `LedgerDirection` | `CREDIT \| DEBIT` (a PAYOUT is a DEBIT against the payable balance) |
| `amount` | `Decimal(14,2)` | **always positive**; the sign is carried by `direction` |
| `currency` | `String @default("IDR")` | |
| `feeType` | `PICFeeType` | `PERCENTAGE \| FIXED_PER_TICKET \| FIXED_PER_ORDER` |
| `rateBp` | `Int?` | basis points used (snapshot; null for `FIXED_*`) |
| `fixedAmount` | `Decimal(14,2)?` | for `FIXED_*` (snapshot) |
| `basisType` | `FeeBasisType` | `GROSS_TICKET_AMOUNT \| NET_TICKET_AMOUNT \| TICKET_QUANTITY \| ORDER_TOTAL` |
| `basisAmount` | `Decimal(14,2)` | the number the rate was applied to (snapshot; quantity for per-ticket fees) |
| `quantity` | `Int` | number of tickets the entry covers |
| `status` | `PICFeeStatus` | `EARNED \| PAYABLE \| PAID \| REVERSED` (§15.4) |
| `refundId` | `String?` | set on `REVERSED` entries |
| `settlementId` | `String?` | set when a settlement pays this entry |
| `adjustmentReason` | `String? @db.Text` | required for `ADJUSTMENT` |
| `createdByUserId` | `String?` | required for `ADJUSTMENT`; `SYSTEM` for automatic entries |
| `idempotencyKey` | `String @unique` | e.g. `pic-fee:EARNED:{orderItemId}` — the double-credit guard |
| `createdAt` | `DateTime @default(now())` | |

Indexes: `(picProfileId, status, createdAt)`, `(organizerId, createdAt)`, `(eventId, createdAt)`, `(orderId)`, `(settlementId)`, `idempotencyKey` unique, plus `@@unique([orderItemId, type])` for automatic entry types (MySQL treats `NULL` as distinct, so `ADJUSTMENT` rows with a null `orderItemId` are unaffected).

### 15.3 Fee configuration (must not be hard-locked)

Resolution order — first match wins, and the **resolved values are snapshotted into the ledger entry**:

```
1. PICEventAssignment.feeRateBp / feeTypeOverride      (per PIC per event — most specific)
2. PICProfile.defaultFeeRateBp                         (per PIC)
3. Organizer.defaultPicFeeRateBp                       (per tenant)
4. PlatformSetting.defaultPicFeeRateBp                 (platform default)
```

`DECISION REQUIRED` (D-11): **the actual values** of every level above (platform default, whether per-tenant overrides are needed, and whether per-PIC overrides are allowed at all). The brief explicitly forbids locking 5%. The design therefore ships **no default percentage**: `defaultPicFeeRateBp` defaults to `0` (= no fee) until a business value is configured. A `0` rate produces no ledger entry, which makes "fee = 0" a valid, explicit configuration rather than a silent 5%.

`DECISION REQUIRED` (D-12): **fee basis** — percentage of gross ticket price (simplest, most common), percentage of net after discount, or fixed per ticket. The default recommendation is `GROSS_TICKET_AMOUNT` with `PERCENTAGE`, because it is the easiest to explain to a PIC and the hardest to dispute.

### 15.4 Entry lifecycle

```
EARNED ──settlement──> PAID
   │
   └──refund/cancel──> REVERSED

ADJUSTMENT (CREDIT) ──settlement──> PAID
ADJUSTMENT (DEBIT)  (reduces the payable balance; no separate status)
PAYOUT (DEBIT)      (created by a settlement; always paired with SettlementItem rows)
```

| Status | Meaning | Settleable? |
| --- | --- | --- |
| `EARNED` | Accrued from a paid order; owed to the PIC | Yes (after any policy hold period) |
| `PAYABLE` | Optional intermediate state if a hold period is used (e.g. only settle after the event ends) | Yes |
| `PAID` | Covered by a completed settlement | No |
| `REVERSED` | Cancelled by a refund; never payable | No |

**Balance formula (single source of truth for "what do we owe this PIC?"):**

```
payable(PIC) = Σ amount WHERE direction = CREDIT AND status IN (EARNED, PAYABLE)
             - Σ amount WHERE direction = DEBIT  AND type = PAYOUT_REVERSAL
             - Σ amount WHERE type = PAYOUT (already paid out, direction = DEBIT)
```

A `PICBalance` snapshot table is **not** designed for MVP; balances are computed with an indexed aggregate (`(picProfileId, status)`), which is fast at the expected volume. If a balance list becomes slow (>50k ledger rows per PIC), add a materialized snapshot refreshed by the settlement job — additive, no schema break.

### 15.5 Adjustments (the answer to "Modify Fee")

There is no code path that edits a ledger entry. Corrections are new rows:

| Situation | Entry |
| --- | --- |
| A sale was attributed to the wrong PIC and the order is paid | `ADJUSTMENT` DEBIT on the wrong PIC's balance + `ADJUSTMENT` CREDIT on the right PIC's balance, both with `adjustmentReason`, both audited, both linked to the same `orderId` |
| Goodwill payment | `ADJUSTMENT` CREDIT |
| Claw-back of an overpaid fee | `ADJUSTMENT` DEBIT |
| Refund after settlement (fee already paid) | `REVERSED` on the original + a negative carry-forward DEBIT in the next settlement (`DECISION REQUIRED` — D-18: claw back in cash, or net it off the next payout? Recommendation: net off, and only escalate to cash recovery if it exceeds a configured threshold) |

Every `ADJUSTMENT` requires `fee.adjust` permission, a non-empty `adjustmentReason`, and produces an `AuditLog` row (§32).

### 15.6 Queries the ledger must answer (requirement §5)

| Business question | Query shape |
| --- | --- |
| How many tickets did this PIC sell? | `SUM(quantity)` over `CREDIT EARNED` entries for the PIC (or `COUNT(Ticket)` joined through `PICAttribution` — the ledger figure is authoritative for money, the ticket count for volume) |
| Total transaction value attributed? | `SUM(OrderItem.subtotal)` over orders with `PICAttribution.picProfileId = ?` |
| What is the PIC fee? | `Σ CREDIT EARNED − Σ REVERSED − Σ PAYOUT` (formula in §15.4) |
| Which transactions generated fees? | Ledger rows joined to `EventOrder.orderNumber` |
| Fee payment status | `PICFeeStatus` per entry + settlement state |
| Fee history | All entries ordered by `createdAt`, with type and reason |
| Events under this PIC's responsibility | `PICEventAssignment` where `isActive` |

### 15.7 Refund and cancellation effects on fees

| Event | Effect |
| --- | --- |
| Order cancelled before payment | No ledger entry ever existed (fees are created only at settlement) |
| Payment failed / expired | Same — no entry |
| Full refund of a paid order | `REVERSED` entry (CREDIT EARNED fully offset), `refundId` set. If already `PAID` via a settlement, see §15.5 |
| Partial refund (some tickets) | `REVERSED` entry covering only the refunded quantity, with the same snapshotted rate as the original |
| Refund where the fee basis included a discount | Reversal uses the **same basis snapshot** as the original entry, so the arithmetic is symmetric |
| Event cancelled (all tickets voided) | Bulk `REVERSED` per PIC per order (post-MVP automation) |
| PIC suspended after earning | Already-`EARNED` entries remain payable (the sale happened); new attribution stops. `DECISION REQUIRED` — D-10 |

---

## 16. Settlement Model

### 16.1 `Settlement`

One table, discriminated by payee type, so PIC payouts and organizer payouts share one auditable state machine (Phase 0's `AffiliatePayout` is the template).

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `settlementNumber` | `String @unique` | e.g. `STL-2026-09-0007` |
| `payeeType` | `SettlementPayeeType` | `PIC \| ORGANIZER` |
| `picProfileId` | `String?` | set when `payeeType = PIC` |
| `organizerId` | `String?` | set when `payeeType = ORGANIZER` |
| `periodStart` / `periodEnd` | `DateTime` | the covered window |
| `grossAmount` | `Decimal(14,2)` | Σ credits included |
| `deductionAmount` | `Decimal(14,2) @default(0)` | Σ reversals/adjustment debits included |
| `netAmount` | `Decimal(14,2)` | `gross − deduction` — the amount actually payable |
| `currency` | `String @default("IDR")` | |
| `status` | `SettlementStatus` | `DRAFT \| PENDING_APPROVAL \| APPROVED \| PROCESSING \| PAID \| FAILED \| CANCELLED` |
| `method` | `SettlementMethod` | `BANK_TRANSFER \| MANUAL \| GATEWAY` |
| `bankName` / `bankAccountName` / `bankAccountNumber` | `String?` | **snapshot** of the payee's account at settlement time |
| `providerReference` / `providerStatus` | `String?` | if a disbursement API is used |
| `proofFilePath` | `String?` | transfer receipt (access-controlled, §33) |
| `preparedByUserId` / `preparedAt` | `String` / `DateTime` | |
| `approvedByUserId` / `approvedAt` | `String?` / `DateTime?` | separation of duties |
| `paidByUserId` / `paidAt` | `String?` / `DateTime?` | |
| `failureReason` | `String? @db.Text` | |
| `notes` | `String? @db.Text` | |
| `createdAt` / `updatedAt` | `DateTime` | |

Indexes: `settlementNumber` unique, `(payeeType, picProfileId, status)`, `(organizerId, status)`, `(status, createdAt)`, and a uniqueness guard `@@unique([payeeType, picProfileId, periodStart, periodEnd])` (with `organizerId` variants) to make double-settlement of the same period structurally impossible.

### 16.2 `SettlementItem`

`id`, `settlementId`, `picFeeLedgerId?`, `orderId?`, `amount Decimal(14,2)`, `direction LedgerDirection`, `description`, `createdAt`.

Purpose: exact traceability of *which* ledger entries a payout covered. A settlement that cannot enumerate its items is not auditable, and the brief requires that a PIC can see the transactions that generated fees.

Index: `(settlementId)`, `(picFeeLedgerId)` unique where non-null (an entry is paid by at most one settlement).

### 16.3 Status machine and segregation of duties

```
DRAFT ──submit──> PENDING_APPROVAL ──approve──> APPROVED ──process──> PROCESSING ──confirm──> PAID
  │                     │                            │                  │
  └──cancel──>CANCELLED  └──reject──>CANCELLED       └──fail──>FAILED ──retry──>PROCESSING
```

| Transition | Permission | Rule |
| --- | --- | --- |
| `DRAFT → PENDING_APPROVAL` | `settlement.prepare` (Manager/Finance) | Items computed from `EARNED` entries in the period; snapshot of payee bank details captured |
| `PENDING_APPROVAL → APPROVED` | `settlement.approve` (Manager/Finance; Admin only with an explicit grant) | **The approver must not be the preparer** when the amount exceeds a configured threshold. `DECISION REQUIRED` — D-19: the threshold, or whether strict two-person control always applies. Recommendation: always require a different approver — the volume does not justify the risk of self-approval |
| `APPROVED → PROCESSING` | `settlement.process` | Records the transfer attempt |
| `PROCESSING → PAID` | `settlement.process` | On confirmation: all included ledger entries move to `PAID`, `settlementId` set, and a `PAYOUT` DEBIT entry is created for the payee's balance |
| `PROCESSING → FAILED` | `settlement.process` | Ledger entries stay `EARNED`/`PAYABLE` so they can be included in the next run |
| any → `CANCELLED` | `settlement.approve` | Releases included entries back to payable |

Every transition writes an `AuditLog` row with `beforeState`/`afterState` (§32).

### 16.4 The settlement decision the brief demands be explicit (brief §22)

Money can reach a payee in three architecturally different ways. The brief forbids assuming gateway capability, so all three are designed and compared.

| | **Option A — Platform collects, settles internally** | **Option B — Gateway split settlement** | **Option C — Hybrid / manual** |
| --- | --- | --- | --- |
| Flow | All payments land in the platform's iPaymu account. The platform owes each PIC and organizer per the ledger, and transfers manually or via a disbursement API | The gateway splits the payment at settlement time: organizer/PIC share routed to their own account, platform fee retained | Gateway collects; settlements are produced automatically but executed manually (bank transfer with proof upload) |
| Requires from iPaymu | Nothing beyond what is already verified | **Per-sub-merchant accounts, split rules, sub-merchant KYC, and a settlement API — ALL UNVERIFIED** | Nothing beyond Option A |
| `Settlement` role | **The** source of truth for what is owed | Becomes a reconciliation record against gateway statements | Same as A |
| Time to launch | Fastest — no gateway dependency for payouts | Blocked until gateway capability and commercial terms are confirmed | Fast (automate the report, keep the transfer manual) |
| Risk | The platform holds other people's money (cash-flow and trust exposure) | Depends entirely on unverified capability | Same as A, with an extra manual step |
| Ledger fit | Perfect — the ledger already computes exactly what is owed | Ledger still needed for the platform's fee, but the payable balance becomes partly informational | Perfect |
| Refund after payout | Handled by the ledger (claw-back or net-off) | Must be reconciled with the gateway's own split reversal rules | Manual |

**Recommendation for MVP: Option C**, which is Option A's architecture with an automated settlement report and a manual transfer plus proof upload. It satisfies the brief's requirement for bookkeeping and fee tracking without depending on unverified gateway features. Option B may replace the *execution* step later without changing the ledger, the entities, or the reports — which is precisely why the ledger is designed as the source of truth rather than the gateway.

**Unverified iPaymu facts that must be confirmed before Option B could ever be chosen** (Phase 0 §14.3, repeated here because the brief requires an explicit `DECISION REQUIRED`):

1. Per-organizer sub-accounts / virtual accounts exist.
2. Automatic split rules (fixed/percentage) exist and are configurable per transaction.
3. Settlement delay (`T+X`) and its effect on refunds.
4. Refund API support (full and partial) and who absorbs the gateway fee.
5. Whether the gateway fee is reported per transaction in the webhook payload or only in a report file.
6. Marketplace/aggregator contractual and KYC requirements for each organizer.
7. Whether session creation is idempotent per `referenceId`.

`DECISION REQUIRED` (D-20): **which option** (A, B, or C). Recommendation: C, with the ledger authority unchanged if B is adopted later.

### 16.5 Settlement schedule and holds

`DECISION REQUIRED` (D-21): settlement cadence (on demand, weekly, monthly, or after the event ends) and whether a hold period applies (e.g. PIC fees only become payable after the event completes, to protect against event cancellation and refunds). Recommendation: a **hold until the event ends** for PIC fees, configurable per platform, because it makes mass refunds on cancellation tractable. The ledger already models this as the `EARNED → PAYABLE` transition.

---

## 17. Financial Calculation

### 17.1 The required separation

The brief (§23) requires these components be separable, with the **final formula not locked**:

```
Ticket Gross
  − Discount
  − Gateway Fee
  − Platform Fee
  − PIC Fee
  = Organizer / Business Net
```

### 17.2 Order-level calculation (server-side only)

```
subtotal          = Σ (OrderItem.priceSnapshot × OrderItem.quantity)
discount          = coupon discount (MVP: 0; field exists)
grossAfterDisc    = subtotal − discount

platformFee       = f(grossAfterDisc)            ← configurable (D-22)
                     0 for MVP unless configured
picFeeTotal       = Σ per-PIC ledger amounts     ← computed by the fee engine (§15.3)
gatewayFee        = provider-reported (post-settlement) or estimated; never assumed

total (buyer pays) = grossAfterDisc + (platformFee if passToBuyer) 
                                   + (picFee if passToBuyer)
organizerNetAmount = grossAfterDisc − platformFee − picFeeTotal
                     − (gatewayFee if absorbedByOrganizer)
```

**Snapshot rule:** every component above is stored on `EventOrder` at creation/settlement (`subtotal`, `discount`, `platformFee`, `picFeeTotal`, `gatewayFee`, `total`, `organizerNetAmount`). Reports never recompute from current configuration — they read the snapshot. This is what makes historical transactions immune to future policy changes (brief §23).

### 17.3 Who bears each fee

| Component | Who bears it | Configurable? |
| --- | --- | --- |
| Gateway fee | **`DECISION REQUIRED`** — D-22. Platform, organizer, or passed to buyer | Yes — `Organizer.gatewayFeeBearer` or `PlatformSetting` |
| Platform fee | Organizer (default) or buyer | Yes — `PlatformSetting.platformFeeMode` |
| PIC fee | Organizer (it is a cost of sale, since the platform already takes its own cut) | `DECISION REQUIRED` — D-23 |
| Discount (coupon) | Organizer (default) or shared | `DECISION REQUIRED` — D-24 |

Because this is undecided, the **stored fields are independent of the mode**: `platformFee`, `picFeeTotal` and `gatewayFee` all exist on the order regardless of who pays them. Switching between "pass to buyer" and "absorb" is then a change to *how `total` is assembled*, not a schema change, and historical orders remain readable.

### 17.4 Worked examples (illustrative numbers, not policy)

The brief forbids locking 5%; the numbers below exist only to prove the arithmetic separates cleanly.

**A. Organizer absorbs both fees**
```
Ticket price           100,000   (1 ticket)
subtotal               100,000
platformFee 5%           5,000
gatewayFee (actual)      2,900   ← from the provider, never estimated in the snapshot
picFee 5%                5,000
total (buyer pays)     100,000   ← buyer sees the ticket price
grossAfterDisc         100,000
organizerNet           ~87,100   (100,000 − 5,000 − 5,000 − 2,900)
```

**B. Platform fee passed to the buyer**
```
subtotal               100,000
platformFee 5%           5,000
total (buyer pays)     105,000
organizerNet            95,000   (100,000 − 5,000 PIC − 0 platform if absorbed by buyer's side)
```

**C. Partial refund of example A (1 of 3 tickets)**
```
Original: 3 tickets × 100,000 = 300,000 ; picFee 15,000 ; platformFee 15,000
Refund 1 ticket:        100,000
  → PICFeeLedger REVERSED entry: 5,000   (same rate snapshot as the original)
  → platformFee snapshot unchanged for the 2 surviving tickets
  → Order.status = PARTIALLY_REFUNDED ; 1 Ticket → REFUNDED, 2 remain ISSUED
  → organizerNet recalculated at settlement time, not by editing the snapshot blindly
```

### 17.5 Rounding policy

| Concern | Rule |
| --- | --- |
| Currency precision | IDR is effectively integer rupiah. All amounts are `Decimal(14,2)` for future-proofing, but computed values are **rounded half-up to the nearest rupiah** before being stored |
| Rounding point | Round **once**, at the point a monetary value is first persisted (order line, ledger entry). Never round intermediate multiplications in a way that makes the sum of parts differ from the total |
| Sum consistency invariant | `Σ OrderItem.subtotal == EventOrder.subtotal` and `Σ PICFeeLedger(EARNED) == EventOrder.picFeeTotal` must both hold exactly. This is asserted by tests (§36.2), not assumed |
| Largest-remainder allocation | When a *proportional* split is ever needed (e.g. allocating an order-level discount across lines for fee basis), use largest-remainder so the parts sum exactly to the whole. `DECISION REQUIRED` — D-25 only if proration is ever required; MVP has no order-level discount, so allocation is per line |
| Display | `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })` — the convention already used by `app/api/admin/reports/excel/route.ts` |

### 17.6 Free-ticket handling

A `price = 0` ticket type must not produce a zero-amount gateway session (the gateway will reject it). Two options: (a) skip the gateway and settle the order as `PAID` with `paymentStatus = PAID` and a `Payment` row of method `FREE`, or (b) forbid free types in MVP. `DECISION REQUIRED` — D-26. Recommendation: (a) is cheap and common for VIP/committee quotas, but it introduces a settlement path that does **not** go through the webhook, which must then still issue tickets through the same transactional issuance function (never a separate code path).

---

## 18. Refund Model

### 18.1 Reuse decision

Phase 0 verified `lib/refund.ts` as production-grade: CAS transitions (`PENDING → PROCESSING → COMPLETED`), an idempotent shared `executeRefundCompletion()`, a webhook-path transition helper (`transitionRefundForWebhook`) that handles "provider confirmed before admin approved", and dependency cleanup (stock/voucher/commission/spin).

**Verdict: KEEP (ADAPT).** The state machine, the CAS discipline and the shared completion function are reused as-is. What changes:

| Legacy behaviour | Ticketing behaviour |
| --- | --- |
| Restores `ProductVariant.stock` / flash-sale stock | Releases or retains ticket quota per `Event.returnQuotaOnRefund` (D-08) |
| Restores voucher usage | Restores coupon usage (post-MVP coupons) |
| Cancels the affiliate conversion | Reverses PIC fee ledger entries |
| Cancels the spin-wheel reward | Not applicable — spin wheel is out of scope |
| `Refund.orderId @unique` (one refund per order) | Needs per-ticket refunds, so uniqueness moves to a finer grain (§18.3) |
| Order → `CANCELLED` | Order → `REFUNDED` or `PARTIALLY_REFUNDED` (a paid order is never "cancelled") |

### 18.2 `Refund` fields (adapted)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `refundNumber` | `String @unique` | public reference |
| `orderId` | `String` | **unique constraint dropped** for per-ticket refunds |
| `organizerId` | `String` | denormalized scope |
| `amount` | `Decimal(14,2)` | **server-authoritative** — computed from the snapshotted ticket prices, never from client input |
| `reason` | `String? @db.Text` | buyer-supplied or admin-supplied |
| `status` | `RefundStatus` | `PENDING \| PROCESSING \| COMPLETED \| FAILED \| REJECTED` |
| `requestedByUserId` | `String` | buyer or staff |
| `requestedByRole` | `String` | distinguishes buyer-initiated from staff-initiated |
| `approvedByUserId` / `approvedAt` | `String?` / `DateTime?` | |
| `processedByUserId` | `String?` | who executed it |
| `providerRef` | `String?` | provider refund reference |
| `feeTreatment` | `RefundFeeTreatment?` | `GATEWAY_FEE_NON_REFUNDABLE \| FULL \| PARTIAL` — snapshot of the applied policy (D-27) |
| `idempotencyKey` | `String @unique` | prevents duplicate refund creation from retries |
| `createdAt` / `updatedAt` | `DateTime` | |

### 18.3 `RefundItem` (new — enables per-ticket refunds)

`id`, `refundId`, `ticketId`, `orderItemId`, `amount Decimal(14,2)`, `createdAt`.

Unique `(refundId, ticketId)` and `ticketId` unique across non-rejected refunds. The `amount` per ticket is the `OrderItem.priceSnapshot` for that ticket, so a partial refund never has to re-derive a price from current configuration.

**Why per-ticket and not per-order:** the brief requires individual tickets (§18), and the moment a single ticket exists independently the refund unit becomes the ticket. A 3-ticket order where one attendee cannot attend must be refundable without voiding the other two — an order-level refund model cannot express that, and `PARTIALLY_REFUNDED` would be meaningless.

### 18.4 Refund lifecycle and effects

```
PENDING ──approve──> PROCESSING ──provider confirms──> COMPLETED
   │                     │
   └──reject──>REJECTED    └──provider fails──>FAILED ──retry──>PROCESSING
```

| Step | Effect |
| --- | --- |
| Request created (`PENDING`) | Order is **not** mutated yet in the ticketing model (unlike the legacy `REFUND_PENDING` order status, which is not carried over). Tickets stay `ISSUED` and remain scannable until the refund completes. `DECISION REQUIRED` — D-28: should a ticket under an open refund request be blocked from check-in? Recommendation: **yes, block and warn the gate** — paying for admission then admitting a refunded attendee is a loss |
| Approved (`PROCESSING`) | Provider refund initiated (if supported); audit entry |
| Completed (`COMPLETED`) | Per refund item: `Ticket.status = REFUNDED`, QR token invalidated; `RefundItem` rows written; `PICFeeLedger` `REVERSED` entries; optionally quota returned (D-08); order becomes `REFUNDED` or `PARTIALLY_REFUNDED`; notifications sent |
| Failed (`FAILED`) | No order/ticket mutation; the request may be retried or rejected |
| Rejected (`REJECTED`) | No mutation; tickets remain valid; buyer notified with the reason |

### 18.5 Refund policy inputs (business decisions)

| Question | Status |
| --- | --- |
| Is refund allowed after the event has started? | `DECISION REQUIRED` — D-29 |
| Is the gateway fee refunded to the buyer? | `DECISION REQUIRED` — D-27. Recommendation: no (the provider usually keeps it) and the policy must be shown at checkout |
| Is the platform fee refunded? | `DECISION REQUIRED` — D-30 |
| Does a refund return quota to sale? | `DECISION REQUIRED` — D-08 (field `Event.returnQuotaOnRefund` already designed) |
| Who approves buyer-initiated refunds? | Designed: Manager/Finance (`refund.approve`); buyer cannot self-approve |
| Refund deadline (e.g. H-1) enforced server-side? | `DECISION REQUIRED` — D-29; if yes, add `Event.refundDeadlineAt` |

### 18.6 Refund and tenant isolation

A PIC may **never** trigger or approve a refund (brief §12). A refund always flows through Manager/Finance, and the resulting ledger reversal is attributed to the PIC whose fee is affected — the PIC sees the reversal in their own fee history, with the reason, but cannot act on it.

---

## 19. E-Ticket & QR Model

### 19.1 `Ticket` entity

Individual ticket entity (§18 of the brief) — one row per purchased unit.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `ticketCode` | `String @unique` | human-readable lookup code, e.g. `EVT-7K3M-0A1B` (non-sequential, random suffix) |
| `qrTokenHash` | `String @unique` | **SHA-256 of the opaque QR token.** The raw token is never stored — a DB leak must not yield scannable tickets |
| `qrVersion` | `Int @default(1)` | incremented when a token is reissued (ticket transfer, staff reissue) — old versions stop validating |
| `orderId` | `String` | |
| `orderItemId` | `String` | |
| `sequenceNo` | `Int` | 1..n within the order item. Unique `(orderItemId, sequenceNo)` |
| `ticketTypeId` | `String` | |
| `eventId` | `String` | denormalized for gate-speed validation |
| `organizerId` | `String` | denormalized for tenant scope |
| `holderUserId` | `String?` | account holder at purchase (nullable for guest purchase, D-33) |
| `attendeeName` | `String?` | per-ticket attendee name, editable by the buyer until a deadline (post-MVP) |
| `attendeeEmail` / `attendeePhone` | `String?` | for per-ticket delivery |
| `status` | `TicketStatus` | §19.2 |
| `issuedAt` | `DateTime?` | set when the settlement transaction issues it |
| `checkedInAt` | `DateTime?` | denormalized from `CheckIn` for fast lists |
| `refundedAt` | `DateTime?` | |
| `voidedAt` / `voidReason` | `DateTime?` / `String?` | event cancellation, staff action |
| `seatLabel` | `String?` | future seat maps; a unique `(eventId, seatLabel)` constraint is added when seats exist |
| `createdAt` / `updatedAt` | `DateTime` | |

Indexes: `ticketCode` unique, `qrTokenHash` unique, `(orderId)`, `(orderItemId, sequenceNo)` unique, `(eventId, status)`, `(organizerId, status)`, `(holderUserId)`, `(ticketTypeId, status)`.

### 19.2 `TicketStatus` and lifecycle

```
RESERVED ──payment settled──> ISSUED ──scan──> CHECKED_IN
   │                            │  │
   │                            │  ├──refund──> REFUNDED
   │                            │  └──void────> VOID
   └──reservation expired──> EXPIRED
```

| Status | Meaning | Terminal? |
| --- | --- | --- |
| `RESERVED` | Reserved but unpaid. Only used if tickets are pre-created at checkout; in the recommended design tickets are created at settlement and this status is unused for MVP (kept for the pre-issued-quantity model, D-31) | No |
| `ISSUED` | Paid and valid; scannable | No |
| `CHECKED_IN` | Admitted at the gate | **Yes** |
| `REFUNDED` | Refunded; QR invalid | **Yes** |
| `VOID` | Invalidated (event cancelled, staff action, reissue) | **Yes** |
| `EXPIRED` | Reservation expired without payment | **Yes** |

### 19.3 QR payload design

The brief warns that a bare ID is insufficient if it creates a security risk. A bare `ticketId` is indeed unacceptable: it is guessable in structure, it leaks the existence of other tickets, it cannot be revoked, and it lets anyone who ever saw the URL reproduce a valid QR.

**Two candidate designs:**

| | **A. Signed payload (stateless HMAC)** | **B. Opaque random token (stateful lookup)** |
| --- | --- | --- |
| Payload | `v1.{"tid":"...","ev":"...","iat":...}.HMAC(secret, ...)` | 32 random bytes, base64url; only its SHA-256 is stored |
| Validation | Verify HMAC, then look up the ticket to check status | Hash the presented token, look up `qrTokenHash`, check status |
| Revocable? | Only by rotating the secret (invalidates **all** tickets) | **Yes** — per ticket, by nulling/rotating `qrTokenHash` (exactly what a refund needs) |
| PII in the QR | Risk — anything in the payload is readable by any phone camera | None — a random blob |
| Offline validation | Possible (verify signature without the DB) | Needs a cached manifest of hashes |
| DB round trip | Still needed (status check) | One indexed lookup |
| Failure mode | A leaked secret forges every ticket | A leaked hash is useless (pre-image resistant) |

**Recommendation: B (opaque random token) as the primary design**, because revocation is a hard requirement — a refunded or voided ticket **must** stop working immediately, and per-ticket revocation is impossible with a stateless HMAC scheme without rotating a shared secret. `qrToken = base64url(randomBytes(32))`, stored only as `qrTokenHash`.

The QR image encodes a **short URL**, not the raw token: `https://tinggalklik.co/t/{ticketCode}?k={token}` — so a phone camera scan opens a human-readable validation page, while the scanner app extracts the token from the query string. The URL is not the security boundary; the token is.

**Offline mode (post-MVP)** may add design A as a *secondary* mechanism: the scanner caches a signed manifest of `{ticketId, ticketCode, qrTokenHash}` per event, validates offline, and syncs `CheckIn` rows later. The token remains the same opaque value; only the validation path differs.

### 19.4 QR requirements checklist (brief §25)

| Requirement | Design answer |
| --- | --- |
| Token format | 32 random bytes, base64url; stored as SHA-256 only; never logged |
| Uniqueness | Collision-free by construction plus a `@unique` DB constraint; `(orderItemId, sequenceNo)` unique prevents duplicate issue on retry |
| Validation | Hash → lookup → status → event match → payment state → duplicate check (§20.2) |
| Replay protection | The token is single-use for admission (`CheckIn.ticketId` unique); replay of the *same* token at the gate yields an explicit "already checked in" response with the original timestamp |
| Duplicate check-in | Enforced by the database, not by a check-then-insert in application code |
| Event validation | `Ticket.eventId` must equal the scanned event; mismatch is a distinct error (`WRONG_EVENT`), not "invalid ticket" |
| Payment validation | Only `ISSUED` tickets validate. A `RESERVED` ticket is rejected with `UNPAID` |
| Delivery | WhatsApp and/or Email, idempotent, with a link to the wallet page (never the raw token in a plain-text log) |
| PII | The QR contains no PII; attendee names appear only on the authenticated wallet page |

### 19.5 Ticket reissue and transfer

| Case | Design |
| --- | --- |
| Staff reissues a ticket (lost phone) | New `qrToken`, `qrVersion += 1`, old token invalidated. Permissioned (`ticket.reissue`) and audited |
| Attendee name change before the event | Allowed for the holder until a configurable cutoff; audited; post-MVP |
| Ticket transfer to another person | Out of scope for MVP (§4.2). The `holderUserId`/`attendeeName` split already accommodates it |
| Event cancelled | All tickets → `VOID`; QR stops validating; communication sent |

---

## 20. Check-in Model

### 20.1 `CheckIn` entity

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `ticketId` | `String @unique` | **the duplicate-scan guarantee.** One admission per ticket, enforced by the database |
| `eventId` | `String` | denormalized for gate queries and live counters |
| `organizerId` | `String` | denormalized scope |
| `checkedInAt` | `DateTime @default(now())` | server clock (see offline note) |
| `checkedInByUserId` | `String` | staff or manager who performed it |
| `checkedInByMemberId` | `String?` | `OrganizerMember` row, for tenant-scoped attribution |
| `method` | `CheckInMethod` | `QR_SCAN \| MANUAL_CODE \| MANUAL_OVERRIDE` |
| `gateLabel` | `String?` | which gate/door (multi-gate events) |
| `deviceId` | `String?` | scanner device fingerprint/reference |
| `clientScannedAt` | `DateTime?` | client-side timestamp, for offline reconciliation |
| `ipAddress` | `String?` | recorded for audit; see the PII note below |
| `result` | `CheckInResult` | `ACCEPTED \| REJECTED_DUPLICATE \| REJECTED_INVALID \| REJECTED_WRONG_EVENT \| REJECTED_NOT_ISSUED \| REJECTED_UNAUTHORIZED \| REJECTED_REFUND_PENDING` |
| `note` | `String?` | mandatory for `MANUAL_OVERRIDE` |
| `createdAt` | `DateTime @default(now())` | append-only; no `updatedAt` |

Indexes: `ticketId` unique, `(eventId, checkedInAt)`, `(checkedInByUserId, checkedInAt)`, `(organizerId, checkedInAt)`.

**Rejected attempts are also recorded.** The brief requires that a duplicate check-in "produce a clear response"; storing the rejected attempt (with `result`) gives the gate a real audit trail and lets operations see how many duplicate/forged attempts occurred. The unique constraint on `ticketId` therefore applies **only to accepted rows** — implemented as `ticketId` nullable-with-unique plus `result = ACCEPTED`, or (cleaner) a generated column `acceptedTicketId` that is null for rejected rows and unique for accepted ones. `DECISION REQUIRED` — D-32 (mechanics choice; MySQL allows a unique index on a nullable column, so `ticketId` nullable + unique + a check that accepted rows always have it is the simplest correct form).

### 20.2 Validation chain (brief §26 — all seven checks, in order)

The order matters: cheap and security-critical checks first, so an attacker cannot use the endpoint to probe the database.

| # | Check | Failure response |
| --- | --- | --- |
| 1 | **Ticket exists** (hash of the presented token → `Ticket`) | `REJECTED_INVALID` / 404, generic message. Never reveal whether the token was malformed vs unknown |
| 2 | **Ticket belongs to the scanned event** (`Ticket.eventId === route eventId`) | `REJECTED_WRONG_EVENT` / 409 with the *correct* event name shown to staff only if they have access to it |
| 3 | **Payment/status valid** (`Ticket.status === ISSUED`) | `REJECTED_NOT_ISSUED` / 409 with the status reason (`REFUNDED`, `VOID`, `RESERVED`, `EXPIRED`) |
| 4 | **Open refund guard** (no non-rejected `RefundItem` on this ticket — D-28) | `REJECTED_REFUND_PENDING` / 409 |
| 5 | **Staff has access to the event** (Manager/Admin, or `CHECKIN_STAFF` with an active `StaffEventAssignment` for this event, within the tenant scope) | `UNAUTHORIZED` / 403. Checked **before** touching ticket data where possible |
| 6 | **Not already checked in** (insert `CheckIn` with `result = ACCEPTED`; unique violation ⇒ duplicate) | `REJECTED_DUPLICATE` / 409 **including the original `checkedInAt` and who admitted them** — the single most useful gate message |
| 7 | **QR validity** — i.e. the presented token hashes to the stored `qrTokenHash` at the current `qrVersion` | Folded into check 1; an old `qrVersion` token returns `REJECTED_INVALID` |

Implementation shape: one transaction that (a) CAS `Ticket.status ISSUED → CHECKED_IN` (`affectedRows === 1` required), and (b) inserts the `CheckIn` row. Either alone would be sufficient; together they make a duplicate impossible even if one guard is later refactored away.

### 20.3 Recorded information (brief §26)

Ticket ✓ · event ✓ · `checkedInAt` ✓ · `checkedInBy` (user + member) ✓ · device/reference ✓ (`method`, `deviceId`, `gateLabel`) · audit information ✓ (`result`, `ipAddress`, plus an `AuditLog` entry for overrides).

**PII note:** storing `ipAddress` is operationally useful (dispute resolution, fraud pattern detection) but is personal data. Recommendation: store it, restrict it to Manager/Admin, exclude it from exports, and define a retention window. `DECISION REQUIRED` — D-34 (retention period for check-in PII).

### 20.4 Duplicate and fraud responses (brief §20/§26)

| Scenario | Response |
| --- | --- |
| First valid scan | `200 ACCEPTED` + attendee name + ticket type + `gateLabel` |
| Rescan of the same ticket | `409 REJECTED_DUPLICATE` + `firstCheckedInAt`, `firstCheckedInBy` (name), `gateLabel`. Phrased as information, not an error: "Sudah check-in pada 19:42 oleh Gate A" |
| Forged/edited QR | `404 REJECTED_INVALID` + a generic message. The attempt is logged (hash only, never the raw token) and rate limited per device |
| Valid ticket for another event | `409 REJECTED_WRONG_EVENT` |
| Unpaid / refunded / voided ticket | `409 REJECTED_NOT_ISSUED` with the reason |
| Staff not assigned to the event | `403 UNAUTHORIZED` |
| Manual override (manager admits someone without a valid QR) | Allowed only with `checkin.override`, requires a `note`, creates `CheckIn.method = MANUAL_OVERRIDE`, and writes an `AuditLog` entry. This is how a genuine edge case (dead phone battery) is handled **without** weakening the normal path |

### 20.5 Throughput and offline readiness (Phase 0 P-8)

| Concern | MVP | Designed-for-later |
| --- | --- | --- |
| Single scan latency | One indexed lookup + one short transaction | — |
| Batch scan | Not in MVP | API accepts an array of tokens with a single transaction; `CheckIn` rows carry `clientScannedAt` |
| Offline | Not in MVP | Scanner caches a signed manifest per event; on sync, tokens are revalidated server-side and duplicates still collapse on `ticketId` unique |
| Rate limiting | Dedicated limiter per device/caller | Shares the platform's shared store (§33.4) |
| Live counters | `COUNT` over `(eventId, checkedInAt)` | Optionally a denormalized counter on `Event` refreshed by the job runner |

### 20.6 Manual check-in (no QR)

A staff member may search by `ticketCode`, attendee name or phone within the event. This path is **not** exempt from validation (checks 3, 4, 6, 7 still apply) and is recorded as `method = MANUAL_CODE`. It exists because gate reality includes dead phones and broken screens; it must not become a bypass.

---

## 21. Notification Architecture

### 21.1 Requirement and current state

The brief (§27) requires centralized, event-driven automation over WhatsApp and Email, with notification logic **not scattered across services**. Phase 0 found a partially built foundation that must be reused rather than replaced:

| Existing asset | Verdict |
| --- | --- |
| `Notification` model with `idempotencyKey @unique`, `status`, `retryCount`, `maxRetries`, `errorCode`, `errorMessage` | **KEEP (ADAPT)** — add `ticketId`, `eventId`, `organizerId`, `picProfileId`, `recipientType` |
| `lib/notification/provider.ts` (`interface NotificationProvider { name; send(); isConfigured() }`) | **KEEP** — extend with `channel` and a typed payload union |
| `lib/notification/service.ts` (`NotificationService`) | **KEEP (ADAPT)** — generalise from "order status changed" to an event registry |
| `lib/notification/mock-provider.ts` | **KEEP** — invaluable for tests |
| `lib/notification/baileys-provider.ts` | **KEEP** — behind the boundary (§22) |
| `lib/notification/queue.ts` (in-memory, restart-lossy) | **REPLACE** — a persistent queue is mandatory (Phase 0 P-3). Notification *records* already exist in the DB; the worker just needs to resume from them |
| `lib/notification/types.ts` (`NotificationType = "ORDER_STATUS_CHANGED"` only) | **REPLACE (EXTEND)** — replaced by the event registry below |
| `lib/whatsapp/service.ts` (Baileys singleton with reconnect/logout handling) | **KEEP** — a solid transport; must stay behind the provider |

### 21.2 Architecture

```
Business action (checkout, webhook, refund, fee, settlement)
        │
        │  emits ONE domain event (no transport knowledge)
        ▼
 lib/ticketing/notifications/emit.ts
        │  resolves: template + recipients + channels + preferences
        ▼
 Notification (logical message, idempotent)  ── persisted BEFORE any send
        │
        ▼
 persistent job queue (DB-backed)
        │
        ▼
 NotificationDelivery (one row per channel attempt)
        │
        ├── WhatsAppProvider → lib/whatsapp/service.ts → Baileys
        ├── EmailProvider    → (provider TBD, §23)
        └── InAppProvider    → notifications table row for the UI bell
```

**Boundary rule (enforced by review and by a lint-level convention):** no business module may import a transport, and no transport may contain business branching. `lib/whatsapp/*` and the email provider are importable **only** from their provider files. This is what makes §22 and §23 satisfiable.

### 21.3 Domain event registry (brief §27)

| Event | Recipients | Channels (default) | Trigger point |
| --- | --- | --- | --- |
| `ORDER_CREATED` | Customer | In-app (WhatsApp optional) | Checkout success (after commit) |
| `PAYMENT_PENDING` | Customer | WhatsApp | Payment session created, with the payment link and expiry |
| `PAYMENT_SUCCESS` | Customer, Organizer/Manager | WhatsApp | Settlement transaction, post-commit (usually merged with `TICKET_ISSUED` to avoid two messages) |
| `PAYMENT_FAILED` | Customer | WhatsApp | Webhook failed branch |
| `PAYMENT_EXPIRED` | Customer | WhatsApp | Expiry job, with a resume link |
| `TICKET_ISSUED` | Customer (per ticket or one message with N tickets) | WhatsApp + Email | Settlement transaction, post-commit. **The primary e-ticket delivery** |
| `CHECKIN_SUCCESS` | Customer (optional, low value) | In-app | Check-in accepted. `DECISION REQUIRED` — D-35: send or not (it costs message volume for little value; an in-app record is usually enough) |
| `REFUND_CREATED` | Customer, Manager/Finance | WhatsApp, In-app | Refund request created |
| `REFUND_COMPLETED` | Customer, PIC (if fee reversed) | WhatsApp | Refund completion |
| `PIC_FEE_CREATED` | PIC | WhatsApp + In-app | Ledger credit entries written |
| `PIC_FEE_PAID` | PIC | WhatsApp + In-app | Settlement reaches `PAID` |
| `SETTLEMENT_COMPLETED` | PIC or Organizer (the payee), Finance | WhatsApp + In-app | Settlement `PAID` |
| `EVENT_PUBLISHED` | Organizer/Manager | In-app | Event publish |
| `EVENT_CANCELLED` | All ticket holders, PICs | WhatsApp + Email | Event cancellation |
| `PIC_ATTRIBUTED` | PIC | In-app | Attribution materialized on an order |
| `EVENT_REMINDER` (H-1 / H-3) | Ticket holders | WhatsApp | Scheduled job — post-MVP but designed |

### 21.4 Recipient types

`CUSTOMER | PIC | ORGANIZER | MANAGER | FINANCE | ADMIN` — resolved by the emitter, never supplied by a caller. A `NotificationRecipient` resolution must be tenant-scoped: a manager is only notified about their own tenant's events.

### 21.5 `Notification` (adapted) and `NotificationDelivery` (new)

**`Notification`** — the logical message. Existing fields kept, plus: `ticketId?`, `eventId?`, `organizerId?`, `picProfileId?`, `recipientType`, `templateKey`, `payloadJson` (existing `payload`), `priority`. The existing `idempotencyKey @unique` remains the dedup guarantee; its format is extended, e.g. `ticket-issued:{ticketId}:whatsapp`, `pic-fee-created:{ledgerId}`.

**`NotificationDelivery`** — one row per channel attempt:
`id`, `notificationId`, `channel` (`WHATSAPP | EMAIL | IN_APP`), `provider` (name string), `status` (`QUEUED | PROCESSING | SENT | FAILED | SKIPPED`), `attemptCount`, `maxAttempts`, `providerMessageId?`, `errorCode?`, `errorMessage?`, `queuedAt`, `sentAt?`, `failedAt?`, `nextRetryAt?`, `createdAt`, `updatedAt`.

Unique `(notificationId, channel)` prevents duplicate channel rows. Index `(status, nextRetryAt)` drives the worker.

### 21.6 Delivery guarantees

| Property | Design |
| --- | --- |
| Idempotency | `Notification.idempotencyKey` unique (logical) + `(notificationId, channel)` unique (delivery) |
| At-least-once | The worker claims rows with a CAS (`QUEUED → PROCESSING`) so two workers cannot send the same delivery |
| Retry | Exponential backoff via `nextRetryAt` (e.g. 1m, 5m, 15m, 1h) up to `maxAttempts` (default 3, configurable per channel). Reuses the existing `retryCount`/`maxRetries` semantics |
| Failure handling | Terminal failure sets `FAILED`, records the error, and (for critical types such as `TICKET_ISSUED`) raises an operational signal. The ticket itself is **never** invalidated because a message failed — the wallet page is always the source of truth |
| Dead-letter | `FAILED` rows after `maxAttempts` stay queryable and are surfaced in an admin view; the existing `Broadcast`/notification UI pattern can host it |
| Ordering | Not guaranteed between event types; each event is self-contained. Within one notification, channel attempts are independent |
| Persistence | The record is written **before** the send is attempted, so a crash between emit and send loses nothing |

### 21.7 Notification preferences

`UserNotificationPreference`: `id`, `userId`, `notificationType`, `whatsapp Boolean`, `email Boolean`, `inApp Boolean`, timestamps. Unique `(userId, notificationType)`.

**Transactional vs marketing:** transactional messages (`TICKET_ISSUED`, `PAYMENT_SUCCESS`, `REFUND_COMPLETED`) are **not** opt-out-able — they are the delivery of a purchased product. Preferences only affect non-essential types (`EVENT_REMINDER`, `CHECKIN_SUCCESS`, `EVENT_PUBLISHED`). This distinction must be modelled explicitly (`NotificationType.category = TRANSACTIONAL | OPERATIONAL | MARKETING`) so that a preference can never suppress a ticket.

### 21.8 What is deliberately not designed

No SMS/Push provider implementation (the existing `NotificationChannel` enum lists `sms`/`push`; they remain unused values). No marketing broadcast segmentation (legacy `Broadcast` types are retail-specific and not carried over). No template editing UI in MVP (`DECISION REQUIRED` — D-36: templates in code vs `NotificationTemplate` table).

---

## 22. WhatsApp Architecture

### 22.1 Boundary (brief §28)

The brief requires that business logic must not depend on Baileys. Phase 0 verified that a preliminary version of this boundary already exists: `lib/notification/order-status-handler.ts` loads `BaileysWhatsAppProvider` via **dynamic `import()`** specifically so `@whiskeysockets/baileys` never enters the static module graph, and `next.config.ts` declares it in `serverExternalPackages`. That decision is preserved and formalised.

```
Business event
   ↓  (emits a domain event — no transport import)
Notification Service  (lib/ticketing/notifications/*)
   ↓  (resolves channel + recipient)
NotificationDelivery (channel = WHATSAPP)
   ↓
WhatsAppProvider    (implements NotificationProvider)
   ↓  (dynamic import, server-only)
lib/whatsapp/service.ts   → Baileys
```

| Layer | May import | Must not import |
| --- | --- | --- |
| Business/domain (`lib/ticketing/**`) | nothing transport-related | Baileys, `lib/whatsapp/*` |
| Notification service | provider interfaces only | Baileys directly |
| `lib/notification/baileys-provider.ts` | `lib/whatsapp/service.ts` (dynamic import) | domain/business modules |
| `lib/whatsapp/service.ts` | Baileys, `fs`, `path` | domain/business modules |

Because the provider is loaded lazily, an event that needs only Email never pays the Baileys startup cost, and a broken WhatsApp session cannot crash an unrelated route.

### 22.2 What already exists and is kept

Phase 0 verified a complete session lifecycle in `lib/whatsapp/service.ts`: states (`DISCONNECTED/CONNECTING/CONNECTED/RECONNECTING/LOGGED_OUT/ERROR`), exponential-backoff reconnect (5 attempts, 2s→60s), QR delivery via a callback for the admin dashboard, `loggedOut` handling that clears auth state, `shutdown()` that preserves auth, and a `globalThis` singleton. The admin connect/QR/status/disconnect/test routes exist. **All of this is reused unchanged.**

### 22.3 Risks of the Baileys approach (must be stated, not hidden)

| Risk | Severity | Mitigation / decision |
| --- | --- | --- |
| Unofficial WhatsApp Web client — account ban or ToS enforcement | **High** for a payment-critical notification path | Never the sole channel for e-tickets: Email is the fallback, and the ticket wallet page is always authoritative. Consider an official provider (WhatsApp Cloud API / a local BSP) — `DECISION REQUIRED` — D-37 |
| `@whiskeysockets/baileys@7.0.0-rc14` is a release candidate | Medium | Pin the exact version; test before any upgrade |
| Session state on local disk (`WHATSAPP_AUTH_DIR`, default `data/whatsapp-auth`) | Medium — loses delivery if the container moves, and is sensitive (a hijacked session sends messages as the platform) | Move to a persistent volume with restrictive permissions; ensure it is **never** committed (`.gitignore` currently lists `data/whatsapp-auth/` ✓) |
| Single session = single sender identity | Medium — rate limits and one number for all traffic | Design the provider to allow multiple sessions later; MVP uses one |
| Message deliverability / silent drops | Medium | Delivery status is captured per attempt (`NotificationDelivery`), with retries and a visible failure list |
| No official delivery receipts | Low | `providerMessageId` is recorded; true read receipts are not available |
| Business logic coupling | High if unmanaged | Solved by §22.1 |

### 22.4 Message content rules

| Rule | Reason |
| --- | --- |
| Never include the raw `qrToken` in a message body | The message would then contain a credential, and messages are screenshot/forwarded freely. Send the wallet **link** instead; the token is only fetched after authenticated login |
| Include `ticketCode`, event name, date, venue, ticket type | Enough to be useful even if the link is not tapped |
| Keep a stable template per event type | Simplifies support and testing |
| Escape/limit user-provided values (event title, attendee name) | Prevents message-format injection and layout breakage |
| Language | Indonesian (`id-ID`) for MVP, matching the existing product | |
| Include an unsubscribe/opt-out note only for MARKETING category | Transactional messages are exempt (§21.7) |

### 22.5 Provider contract

```
interface NotificationProvider {
  readonly name: string
  readonly channel: NotificationChannel      // extended from Phase 0
  isConfigured(): boolean
  send(payload: SendNotificationPayload): Promise<SendNotificationResult>
}

SendNotificationPayload = {
  deliveryId, notificationId, channel,
  recipientType, recipient, templateKey,
  variables: Record<string,string>,          // resolved template variables
  category: 'TRANSACTIONAL'|'OPERATIONAL'|'MARKETING'
}
```

Provider rules (carried over from the existing interface contract): a provider must **not throw**; it returns a structured failure so the worker can retry. `isConfigured()` gates whether a delivery is attempted or marked `SKIPPED`.

---

## 23. Email Architecture

### 23.1 Same boundary, different transport

The brief (§29) requires the identical abstraction. Email uses the same `NotificationProvider` interface, the same `Notification`/`NotificationDelivery` records, and the same worker. The only difference is the transport implementation.

```
Business event → Notification Service → NotificationDelivery(EMAIL)
                                        → EmailProvider (implements NotificationProvider)
                                        → SMTP / API provider  ← NOT CHOSEN YET
```

### 23.2 Provider selection is deliberately open

`DECISION REQUIRED` — D-38: **which email provider.** No email dependency exists in the repository today (Phase 0 verified: no mail package in `package.json`, no mail code). The design therefore specifies only the contract, plus the operational requirements any candidate must satisfy:

| Requirement | Why |
| --- | --- |
| Transactional API (not marketing-only) | Ticket delivery is transactional |
| Attachment support (PDF ticket) | Post-MVP, but the provider should support it |
| Delivery webhooks or a status API | Feeds `NotificationDelivery.status` |
| Reasonable Indonesian deliverability | The audience is Indonesian; Gmail/Yahoo bulk sending requires proper DNS setup |
| Per-message cost clarity at expected volume | Cost model |
| No shared-IP reputation risk for transactional mail | Ticket delivery must not be affected by marketing blasts |

Candidates to evaluate (not chosen, and to be researched before Phase 11): an SMTP relay (e.g. a hosted SMTP service) versus a transactional API provider. **The design does not assume any specific vendor.**

### 23.3 Domain and deliverability prerequisites (independent of provider)

| Item | Requirement |
| --- | --- |
| Sending domain | A dedicated subdomain (e.g. `mail.tinggalklik.co`) so reputation is isolated from marketing |
| SPF | Authorize the provider's sending hosts |
| DKIM | Sign with a provider-issued key |
| DMARC | `p=quarantine` minimum, with a reporting address |
| Reply-to | A monitored mailbox, referenced in the email body |
| Unsubscribe | Required for MARKETING category; transactional mail is exempt but should still document why it cannot be unsubscribed |

### 23.4 Content rules for e-ticket email

| Element | Rule |
| --- | --- |
| Subject | `E-Ticket {eventName} — {ticketCode}` (one message per order, N tickets inline or attached) |
| Body | Plain-text + HTML alternative; ticket code, event, date/time (Asia/Jakarta), venue, ticket type, quantity |
| QR | Rendered from the wallet link. **The QR must be the wallet-derived image, never a raw token embedded as a scan payload without authentication** — consistent with §22.4 |
| Attachment | Post-MVP: a PDF per order containing all QRs |
| Fallback link | Always present, pointing at the authenticated wallet |
| PII | Send only to the buyer's own address; never CC multiple buyers |

### 23.5 Why Email matters more than usual here

WhatsApp delivery depends on an unofficial client (§22.3) and on the customer having WhatsApp at all. Email is the **independence mechanism**: if WhatsApp fails, is banned, or the customer is unreachable, the e-ticket must still arrive. Therefore:

1. `TICKET_ISSUED` and `EVENT_CANCELLED` are designed as **dual-channel** by default.
2. A WhatsApp failure triggers an automatic Email delivery for the same notification (escalation policy in the worker), not a silent dead-letter.
3. `DECISION REQUIRED` — D-39: is Email mandatory at launch, or may MVP ship WhatsApp + wallet page only? Recommendation: **Email is a launch requirement for e-ticket delivery**, precisely because the WhatsApp channel carries ban risk.

### 23.6 Testing without a provider

The existing `MockNotificationProvider` is reused: all notification tests run against the mock, asserting the *records* (idempotency, recipient resolution, channel selection, retry behaviour) rather than the transport. A real-provider smoke test runs manually against a sandbox account before launch (`DECISION REQUIRED` — D-40: is a provider sandbox available for CI?).

---

## 24. Reporting & Excel Export

### 24.1 Transaction Report (brief §8)

**Required filters** (all optional, combined with AND):

| Filter | Type | Notes |
| --- | --- | --- |
| `dateFrom` / `dateTo` | date (inclusive) | Interpreted in the report timezone (§24.4) |
| `eventId` | id or `eventCode` | |
| `ticketTypeId` | id | |
| `picProfileId` | id or `picCode` | Filter by attributed PIC (or `NONE` for direct sales) |
| `paymentStatus` | enum | |
| `orderStatus` | enum | |
| `refundStatus` | enum / `NONE` / `PARTIAL` / `FULL` | Derived from `Refund` + `RefundItem` |
| `organizerId` | id | Injected by scope, not selectable for non-platform roles |
| `search` | string | `orderNumber`, buyer name, buyer phone, buyer email, `ticketCode` |

**Required columns** (brief §8): `orderNumber`, customer, event, ticket (type + quantity), gross amount, discount, payment fee, platform fee, PIC fee, net amount, payment status, order status, created at — plus: `eventCode`, `ticketCodes` (comma-joined or one row per ticket for the ticket-level export), `paidAt`, `refundedAmount`, `picCode`/`picName` (or `-` for direct), `organizerName`, `currency`.

**Row grain (must be decided and be consistent):** order-level rows for the financial report; ticket-level rows for the attendee/check-in export. `DECISION REQUIRED` — D-41: does the Transaction export default to order grain or ticket grain? Recommendation: **order grain** for financial reconciliation (one row = one payment), with ticket-level detail available via a separate "Attendee" export, because mixing grains makes totals ambiguous.

**Scope enforcement:** the same query builder that powers the on-screen report powers the export, with the actor's scope filter applied at the root of the `where` clause. A PIC calling the export endpoint gets `picProfileId = self` injected; there is no parameter that can remove it (§24.5).

### 24.2 The four required exports (brief §9)

| Export | Filters | Columns | Permission |
| --- | --- | --- | --- |
| **Transaction Export** | §24.1 | §24.1 | `report.export.financial` (Manager/Finance; Admin only with a grant) |
| **PIC Fee Export** | date range, PIC, event, fee status, entry type | `entryId`, `createdAt`, `picCode`, `picName`, `eventCode`, `orderNumber`, `ticketType`, `quantity`, `type` (EARNED/REVERSED/ADJUSTMENT/PAYOUT), `direction`, `feeType`, `rate`, `basisAmount`, `amount`, `status`, `settlementNumber`, `adjustmentReason` | PIC: `OWN` only (`report.export.pic.own`); Manager/Finance: all in scope |
| **Event Sales Export** | date range, event, sport, status | `eventCode`, `eventName`, `sport`, `venue`, `startAt`, `status`, `ticketsSold`, `ticketsAvailable`, `grossSales`, `netSales`, `refundedAmount`, `platformFee`, `picFeeTotal`, `organizerNet`, `ordersCount` | `report.export.financial` |
| **Settlement Export** | date range, payee type, payee, settlement status | `settlementNumber`, `payeeType`, `payeeName`, `periodStart`, `periodEnd`, `grossAmount`, `deductionAmount`, `netAmount`, `status`, `method`, `paidAt`, `proofReference`, `itemCount` | `report.export.financial` |

### 24.3 Export architecture (brief §30)

```
Report filter (validated by a zod schema)
        ↓
Authorization  ── requirePermission + scope injection
        ↓        ── (PIC → own scope; Manager → tenant; Admin → platform)
Query builder (shared with the on-screen report — ONE implementation)
        ↓
Row count check
   ├── ≤ EXPORT_SYNC_MAX_ROWS (default 5,000) → generate in-request → stream .xlsx
   └──  > EXPORT_SYNC_MAX_ROWS               → create ExportJob → 202 Accepted + link to poll
        ↓
XLSX generation (xlsx)
        ↓
Response (attachment) or object/storage URL (job path)

Every export writes an AuditLog row:
  { action: "REPORT_EXPORT", reportType, filters, rowCount, format, actorType, organizerId }
```

**Design rules**

1. **One query builder per report.** The screen and the export must never diverge; a filter added to the UI is automatically in the export because both call the same function.
2. **Scope is applied last and is not overridable.** Scope injection happens after filter parsing, so no client-supplied parameter can widen it.
3. **Export without permission is refused, not degraded** — no "export just your own rows" fallback for a role that should not export at all.
4. **Synchronous below the threshold, background above it.** Background jobs need the persistent runner (§40) and an `ExportJob` record (`id`, `requestedByUserId`, `reportType`, `filtersJson`, `status`, `rowCount?`, `filePath?`, `expiresAt`, `errorMessage?`, timestamps) because a large export must not hold an HTTP request open (Phase 0 P-9/P-10: single VPS, no queue).
5. **Never expose raw IDs to the client** in an export — `eventCode`, `orderNumber`, `picCode`, `settlementNumber` are used instead, consistent with §8.2.

### 24.4 Timezone and currency conventions

| Concern | Convention | Rationale |
| --- | --- | --- |
| Storage | UTC (`DateTime`) | Prisma/MySQL baseline; never store local time |
| Display and filters | `Asia/Jakarta` (WIB) | The operating market. `Event.timezone` is stored per event so a future out-of-region event stays correct |
| Date filter semantics | `dateFrom 00:00:00 WIB` .. `dateTo 23:59:59.999 WIB`, converted to UTC before querying | Prevents the classic off-by-one-day bug in financial reports |
| Excel date format | `dd/mm/yyyy HH:mm` with the timezone stated in a header note | The existing export uses `Intl.DateTimeFormat("id-ID")`; the ticketing exports add the explicit timezone note |
| Currency format | `Intl.NumberFormat("id-ID", { style: "currency", currency: "IDR", maximumFractionDigits: 0 })` | Matches the existing convention |
| Numeric columns | Money exported as **numbers with a currency format**, not as strings | So Excel can sum them; the existing export formats to a currency *string*, which breaks summation — a deliberate, documented improvement. `DECISION REQUIRED` — D-42: keep the legacy string format for consistency, or switch to numeric for usability? Recommendation: numeric, plus a formatted display column |
| Rounding in exports | Values as stored (already rounded at persistence, §17.5) | An export must match the ledger exactly |

### 24.5 File naming convention

```
{report}-{scope}-{yyyyMMdd}-{yyyyMMdd}-{generatedAt(ISO compact)}.xlsx

transactions-all-20260901-20260930-20260916T1015.xlsx
transactions-event-FINALBASKET2026-20260901-20260930-20260916T1015.xlsx
pic-fees-pic-ANDI7K3M-20260901-20260930-20260916T1015.xlsx
event-sales-all-20260901-20260930-20260916T1015.xlsx
settlements-pic-ANDI7K3M-20260901-20260930-20260916T1015.xlsx
```

Rules: lowercase, hyphen-separated, no user-supplied text beyond the validated identifiers, no spaces, no personal names (so a filename never leaks customer PII into a shared folder or email thread). `DECISION REQUIRED` — D-43: whether the platform prefix (`tinggalklik-`) should lead the filename for tidiness.

### 24.6 Workbook structure

| Sheet | Content |
| --- | --- |
| `Data` | The report rows |
| `Summary` | Totals for the applied filters (row count, Σ gross, Σ discount, Σ fees, Σ net) |
| `Meta` | Generated at, generated by (role, not name where avoidable), filters applied, timezone, currency, platform version, and an explicit note that figures are snapshots |

The `Meta` sheet is what makes an exported file self-explaining six months later — a requirement implied by the brief's "pembukuan yang jelas".

### 24.7 Why the legacy `xlsx@0.18.5` dependency is a problem here

Phase 0 **S-13**: `xlsx@0.18.5` carries known advisories and is not maintained on the public npm registry. It is already used in five admin routes. For ticketing, export volume and file size grow (every transaction, every ticket), so the risk grows with it. **Recommendation:** replace it with a maintained writer (`exceljs`) **before** Phase 10, and use a streaming writer for the background path so a 50k-row export does not exhaust memory on the single VPS. This is a dependency decision that must be approved: `DECISION REQUIRED` — D-44.

### 24.8 Report performance

| Concern | Design |
| --- | --- |
| Large ranges | Background `ExportJob` above the row threshold |
| Aggregations | Computed in SQL (`groupBy`/`aggregate`), never by fetching rows and summing in JS (Phase 0 P-9) |
| Required indexes | `(organizerId, createdAt)`, `(eventId, createdAt)`, `(picProfileId, createdAt)`, `(status, createdAt)` on orders and ledger tables (§36) |
| Pagination on screen | The existing `{ items, pagination }` envelope with `limit ≤ 100` (§2.3) |
| Caching | Not for financial reports — a stale financial figure is worse than a slow one. Only taxonomy/banner reads are cached (Phase 0 P-5) |

---

## 25. Public API Contract

### 25.0 Conventions, response envelope and error contract

**Namespace convention:** the existing repository uses `/api/<area>/...` with prefix-based protection in `proxy.ts`. Ticketing follows it: `/api/events*`, `/api/orders*`, `/api/tickets*`, `/api/pic/*`, `/api/admin/*`. A separate `/api/manager/*` namespace is **not** created — manager and admin share `/api/admin/*` and are separated by **permission checks inside the service layer**, because the two roles act on the same resources with different grants. Two namespaces would duplicate dozens of routes and invite drift.

**Response envelope (kept from the existing codebase, extended additively):**

```jsonc
// success
{ "success": true, "data": { /* payload */ } }

// list
{ "success": true, "data": { "items": [ /* … */ ],
    "pagination": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 } } }

// error (extended: adds `code` and optional `details`; existing clients ignore them)
{ "success": false, "code": "SOLD_OUT", "message": "Tiket Tribun sudah habis.",
  "details": { "ticketTypeId": "…", "remaining": 0 } }
```

`code` is a stable machine-readable string; `message` is human-facing Indonesian. Clients must branch on `code`, never on `message`.

**Error class design (Phase 2 must CREATE this — there is no `AppError` today, see §2 corrections):**

```
class AppError extends Error {
  code: ErrorCode
  httpStatus: number
  details?: Record<string, unknown>
  expose: boolean            // false ⇒ message is replaced by a generic one
}

All domain errors extend AppError. Route handlers translate AppError → envelope.
Unknown errors → 500 + generic message + server-side log with a correlation id.
```

The existing `MarketingError` family (`lib/marketing/errors.ts`, 18 subclasses) is the template; it should be migrated onto `AppError` when marketing modules are removed (§34).

### 25.1 Error code registry (brief §41)

| HTTP | Code | Meaning | Notes |
| --- | --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Malformed/invalid input | `details` names the offending fields |
| 400 | `INVALID_WEBHOOK` | Webhook failed verification/parsing | Signature or amount failure |
| 401 | `UNAUTHORIZED` | No/expired session, or invalid webhook signature | |
| 403 | `FORBIDDEN` | Authenticated but not permitted | Generic message; no resource confirmation |
| 403 | `ORGANIZER_ACCESS_DENIED` | Actor not in the required tenant | |
| 403 | `PIC_ACCESS_DENIED` | Actor not the PIC or not permitted for that PIC's data | |
| 404 | `NOT_FOUND` | Resource missing **or out of scope** | Scope failures return 404, never 403 (§7.4) |
| 404 | `INVALID_TICKET` | QR token does not resolve | Never distinguishes "malformed" from "unknown" |
| 409 | `CONFLICT` | Generic state conflict | |
| 409 | `DUPLICATE_WEBHOOK` | Provider event already processed | Returned as 200 in practice (§31) |
| 409 | `SOLD_OUT` | Quota unavailable for a ticket type | `details.ticketTypeId` |
| 409 | `QUOTA_EXCEEDED` | Requested quantity exceeds remaining quota | Distinct from `SOLD_OUT` (partial availability) |
| 409 | `LIMIT_EXCEEDED` | Per-order or per-type min/max violated | |
| 409 | `TICKET_ALREADY_CHECKED_IN` | Duplicate check-in | `details` includes the original timestamp and staff |
| 409 | `SALES_NOT_OPEN` | Outside the sales window | |
| 409 | `ORDER_NOT_PAYABLE` | Order cannot be paid in its current state | |
| 409 | `REFUND_NOT_ALLOWED` | Policy or state prevents the refund | |
| 409 | `SETTLEMENT_STATE_INVALID` | Illegal settlement transition | |
| 402 | `PAYMENT_REQUIRED` | Action requires a settled payment | Reserved for ticket access before payment |
| 402 | `PAYMENT_FAILED` | Payment attempt failed | |
| 429 | `RATE_LIMITED` | Too many requests | Includes `Retry-After` |
| 500 | `INTERNAL_ERROR` | Unexpected failure | Never leaks internals |
| 503 | `PROVIDER_UNAVAILABLE` | Payment/provider/notification dependency down | |

**Rule:** a code is added only when a caller must behave differently. `INTERNAL_ERROR` must not be used for a case that has a specific code.

### 25.2 `GET /api/events` — public catalog

| Property | Value |
| --- | --- |
| Auth | None (public) |
| Authorization | Public filter is hard-coded: `status = PUBLISHED`, `visibility = PUBLIC`, `archivedAt IS NULL`, `startAt >= now - grace` (past events hidden by default) |
| Query params | `q` (text search over title/venue/description), `sport` (slug), `city`, `dateFrom`, `dateTo`, `priceMax`, `hasTickets` (boolean), `sort` (`startAt_asc` default, `price_asc`, `price_desc`, `newest`), `page`, `limit` (≤ 50) |
| Response | `items[]`: `slug`, `title`, `bannerUrl`, `sportName`, `startAt`, `endAt`, `timezone`, `venueName`, `venueCity`, `priceFrom`, `priceTo`, `salesState`, `isSoldOut`, `remaining?` (§10.5), `shareUrl` |
| Pagination | Envelope as above |
| Sorting | Allow-listed values only (Phase 0 S-8 — never interpolate a client `sortBy` into SQL) |
| Errors | `VALIDATION_ERROR` |
| Idempotency | Read-only |
| Side effects | None. Cacheable (short TTL, §24.8) |

### 25.3 `GET /api/events/{slug}` — event detail

Public. Resolves by `slug` **or** `shareCode`. Returns event fields, images, venue, sport, organizer display name, and `ticketTypes[]` with `name`, `description`, `price`, `minPerOrder`, `maxPerOrder`, `salesState`, `remaining?`, `isSoldOut`. **Never** returns `quota`, `reserved`, or `sold` totals (§10.5). Sold-out and sales-closed types may still be listed (marked) or omitted — `DECISION REQUIRED` — D-45: show sold-out types greyed out, or hide them? Recommendation: show sold-out types (helps buyers pick a different tier and reduces support questions), hide types that have not opened yet only if the organizer opts out.

Errors: `NOT_FOUND` for unknown/archived/unpublished slugs. An `UNLISTED` event is reachable by direct link but excluded from listings.

### 25.4 `GET /api/events/{slug}/tickets` — availability refresh

Public, lightweight, polled by the event page to refresh availability without re-fetching everything. Returns per ticket type: `id`, `price`, `salesState`, `remaining?`, `isSoldOut`, `version`. Rate-limited (a public endpoint must not become a scraping channel, and it is the endpoint a competitor would poll to read sales velocity — a further argument for hiding `remaining`, D-15).

### 25.5 `POST /api/checkout` — create an order and reserve quota

| Property | Value |
| --- | --- |
| Auth | Required (customer session). Guest checkout is `DECISION REQUIRED` — D-33 |
| Request | `{ eventId, items: [{ ticketTypeId, quantity }], buyerName, buyerEmail, buyerPhone, couponCode? , shareToken? }` — **no prices, no totals, no organizerId, no picProfileId** |
| Validation | zod schema; quantities positive integers; per-type and per-order limits; sales window; event published; total tickets per order ceiling |
| Authorization | The buyer is the owner of the resulting order; the share token is only a hint, resolved server-side |
| Response | `201 { orderId, orderNumber, status: PENDING_PAYMENT, totals: { subtotal, discount, platformFee, total }, expiresAt, paymentUrl }` |
| Pricing | Fully recomputed server-side from `TicketType.price` and configuration; the client never sends an amount (§17.2) |
| Side effects | Creates `EventOrder` + `OrderItem[]` + `TicketReservation[]`; quota CAS `reserved += n`; creates `PICAttribution` if a valid assignment matches; creates `Payment` + provider session |
| Idempotency | **Required** — see §30.1. A repeated submit with the same `Idempotency-Key` returns the existing order instead of double-reserving |
| Errors | `SOLD_OUT`, `QUOTA_EXCEEDED`, `LIMIT_EXCEEDED`, `SALES_NOT_OPEN`, `VALIDATION_ERROR`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE` |

### 25.6 `GET /api/events/{slug}/share` — share metadata

Public. Returns the canonical URL, `shareUrl` (with a tracking token when called by an authorized PIC for an assigned event), the OG image URL, and a QR image URL for download. **The PIC variant requires authentication** — an anonymous caller can only obtain the un-tracked public link, so the share surface cannot be abused to fabricate attribution.

---

## 26. Authenticated API Contract

All endpoints below require a session. Every one applies an **ownership predicate** (`userId = session.user.id`) in addition to any permission check — the Phase 0 pattern (`where: { id, userId }`, verified in `app/api/orders/[id]/route.ts`) is preserved and is mandatory.

### 26.1 `GET /api/orders` — my orders

| Property | Value |
| --- | --- |
| Authorization | Own orders only. `userId` injected server-side; a client-supplied `userId` is ignored |
| Filters | `status`, `dateFrom`, `dateTo`, `eventId`, `page`, `limit` (≤ 50) |
| Response | `items[]`: `orderNumber`, `eventTitle`, `eventSlug`, `startAt`, `venueName`, `ticketSummary`, `ticketCount`, `total`, `status`, `paymentStatus`, `createdAt`, `canPay`, `canRefund` |
| Errors | `UNAUTHORIZED`, `VALIDATION_ERROR` |

### 26.2 `GET /api/orders/{orderNumber}` — order detail

Ownership enforced. Returns items, tickets (with `ticketCode` but **without** the QR token), totals breakdown, payment state, refund state, and the e-ticket wallet link. Using `orderNumber` rather than a numeric id is deliberate (§8.2) — non-guessable public identifiers prevent enumeration even if an ownership predicate is ever forgotten.

### 26.3 `POST /api/orders/{orderNumber}/pay` — create or resume payment

Used when the payment session expired or was abandoned. Reuses the Phase 0 repayment logic (`lib/repay.ts` shape): validate eligibility → re-reserve quota if it was released → create a new provider session. If the quota CAS fails, respond `SOLD_OUT` for that ticket type (§12.4). Rate-limited via `rateLimiters.repayment`-style limiter.

### 26.4 `POST /api/orders/{orderNumber}/cancel` — cancel an unpaid order

Allowed only while `PENDING_PAYMENT`. Releases reservations (`reserved -= n`), voids the open `Payment`, and sets `CANCELLED`. A paid order **cannot** be cancelled — `NOT_ALLOWED`/409 with a pointer to the refund flow (§12.3). This mirrors the Phase 0 `cancelOwnPendingOrder()` behaviour.

### 26.5 `GET /api/tickets` — my tickets

Ownership enforced. Filters: `status`, `eventId`, `upcoming` (default), `page`, `limit`. Returns `ticketCode`, `eventTitle`, `eventSlug`, `startAt`, `venueName`, `ticketTypeName`, `attendeeName`, `status`, `checkedInAt`, and a wallet URL. **The QR token is not returned by the list endpoint** — only by the single-ticket endpoint, so a list response cached or logged anywhere cannot leak scannable credentials.

### 26.6 `GET /api/tickets/{ticketCode}` — ticket detail (wallet)

Ownership enforced (`holderUserId = session.user.id`, or an authorized staff/support override that is audited). Returns: event details, attendee name, `ticketCode`, `status`, `checkedInAt`, and a **short-lived, single-purpose QR token** for display (see below).

**QR token handling for the wallet (security-critical):**

| Option | Risk | Verdict |
| --- | --- | --- |
| Return the permanent `qrToken` to the browser | It lives in the DOM, in browser history, in screenshots, and in any XSS-reachable context; it cannot be revoked per-view | **Rejected** |
| Return a short-lived signed display token minted per request (e.g. 5–15 min TTL), validated by the same scanner endpoint and bound to the ticket | Leaked display token expires quickly; revoking the underlying ticket still works | **Recommended** |
| Render the QR server-side as an image (no token reaches JS) | Same benefit, no client token handling at all; adds a server round trip and makes offline display impossible | Acceptable alternative |

`DECISION REQUIRED` — D-46: short-lived display token vs server-rendered QR image. Recommendation: server-rendered image for the web wallet, short-lived token for the (future) mobile app.

### 26.7 `GET /api/payments/{paymentReference}` — payment status (polling)

Ownership enforced, mirroring the Phase 0 `app/api/payment/status` route that the payment-finish page already polls. **Display-only:** it reports `paymentStatus` and never changes it, and it is explicitly documented as not being an issuance trigger (the webhook is). If it ever returned "paid" derived from anything other than the order row, it would become a forgery vector.

### 26.8 `POST /api/refunds` — request a refund

Ownership enforced. Request body: `orderId`/`orderNumber`, `ticketIds[]` (per-ticket, §18.3), `reason`. Server computes `amount` from snapshots — a client-supplied amount is ignored (Phase 0 already enforces this in `lib/refund.ts`). Enforces the refund policy (§18.5), the refund deadline, and `rateLimiters.refundRequest`-style limiting. Response: `201 { refundNumber, status: PENDING, amount }`.

### 26.9 Profile endpoints

`GET/PATCH /api/profile` already exist and are reused (`app/api/profile/route.ts` — phone uniqueness, session-derived `userId`, no mass assignment). Ticketing adds optional notification preferences (§21.7) on the same route or a sibling.

### 26.10 Own PIC surface for a PIC-role user

A user with `platformRole = PIC` accesses their own financial data through the PIC namespace (§27.3) rather than through the customer endpoints. The scoping is by `picProfileId`, which resolves from the session — never from a query parameter.

---

## 27. Organizer/PIC API Contract

### 27.1 Organizer-scoped event management

Routes live under `/api/admin/events/**` (the existing admin namespace) but are **permission-gated** rather than admin-gated, so a Manager can use them while an Admin without `event.publish` cannot publish. Every handler resolves the tenant from the session/membership and passes `organizerId` explicitly to the service.

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /api/admin/events` | `event.view` | Paginated; scope-injected; filters: `status`, `sportId`, `venueId`, `q`, date range |
| `POST /api/admin/events` | `event.create` | Creates a `DRAFT`; `organizerId` from scope; slug generated and de-duplicated |
| `GET /api/admin/events/{id}` | `event.view` | 404 if out of scope |
| `PATCH /api/admin/events/{id}` | `event.update` | Whitelisted fields only; `organizerId` immutably ignored if present in the body |
| `POST /api/admin/events/{id}/publish` | `event.publish` | Validates at least one active ticket type with quota (§10.3); idempotent (publishing a published event is a no-op) |
| `POST /api/admin/events/{id}/unpublish` | `event.publish` | Existing orders/tickets unaffected |
| `POST /api/admin/events/{id}/cancel` | `event.cancel` + `settlement.approve`-class confirmation | Bulk effect designed, automation post-MVP |
| `POST /api/admin/events/{id}/archive` | `event.update` | Requires no open refunds/settlements |
| `POST /api/admin/events/{id}/images` | `event.update` | Reuses the validated upload pipeline (§33.6) |
| `GET/POST/PATCH /api/admin/events/{id}/ticket-types` | `ticket_type.manage` | Quota reduction blocked below `sold + reserved` (§11.6) |
| `GET /api/admin/events/{id}/availability` | `event.view` | Internal view — **may** show quota/reserved/sold (this is the authorized surface, unlike §25.4) |

### 27.2 Organizer operational endpoints

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /api/admin/orders` | `order.view` | Scope-injected; filters per §24.1 |
| `GET /api/admin/orders/{orderNumber}` | `order.view` | Includes tickets and check-in state |
| `GET /api/admin/attendees` | `order.view` | Ticket-level rows with check-in state; supports CSV/Excel export |
| `GET /api/admin/events/{id}/sales-summary` | `report.view` | Aggregates in SQL |
| `POST /api/admin/checkin/scan` | `checkin.scan` + event scope | §20.2 chain; the primary gate endpoint |
| `POST /api/admin/checkin/manual` | `checkin.override` | Requires a note; audited |
| `GET /api/admin/checkin/log` | `checkin.view` | Event-scoped, paginated |
| `POST /api/admin/tickets/{ticketCode}/reissue` | `ticket.reissue` | New token, `qrVersion += 1` (§19.5); audited |
| `GET /api/admin/reports/{reportType}` | `report.view` | §24 |
| `POST /api/admin/reports/{reportType}/export` | `report.export.financial` | §24.3 |

### 27.3 PIC endpoints (`/api/pic/**`)

The PIC namespace is deliberately separate so that a PIC's entire effective surface can be enumerated and tested in one place. Every route requires `platformRole = PIC` with an `ACTIVE` `PICProfile`, and every query is filtered by **`picProfileId` resolved from the session**.

| Endpoint | Permission | Returns | Explicitly cannot return |
| --- | --- | --- | --- |
| `GET /api/pic/me` | `pic.view.own` | Profile, `picCode`, status, fee rate (effective), bank details (masked) | — |
| `GET /api/pic/events` | `pic.view.own` | Events this PIC is assigned to, with per-event metrics | Events not assigned to them |
| `GET /api/pic/sales` | `pic.view.own` | Orders attributed to this PIC: `orderNumber`, `eventCode`, `ticketType`, `quantity`, `subtotal`, `feeAmount`, `status`, `createdAt` | Any order without their attribution |
| `GET /api/pic/sales/{orderNumber}` | `pic.view.own` | Detail of one attributed order (buyer identity **redacted** — see below) | Orders not attributed to them |
| `GET /api/pic/fees` | `pic.view.own` | Ledger entries with type, status, rate, basis, amount | Any other PIC's entries |
| `GET /api/pic/fees/summary` | `pic.view.own` | `earned`, `reversed`, `adjustments`, `paid`, `payable` | Platform-wide totals |
| `GET /api/pic/settlements` | `pic.view.own` | Their own settlements and statuses | Others' settlements |
| `GET /api/pic/settlements/{number}` | `pic.view.own` | Items included | Others' items |
| `GET /api/pic/links` | `pic.view.own` | Their share links, per assigned event, with click counts | — |
| `POST /api/pic/links/{eventId}` | `pic.view.own` | Generate/rotate their own share token for an assigned event | Tokens for unassigned events |
| `POST /api/pic/reports/export` | `report.export.pic.own` | Their own fee/sales export (§24.2) | Any row outside their scope |

**PIC data minimisation (brief §12).** A PIC sees that a sale happened and what it earned — not the buyer's personal data. The design therefore returns the **buyer name masked** (`Andi S***`) and **never** the buyer email, phone, address or other orders. `DECISION REQUIRED` — D-47: does a PIC need the buyer's name or phone at all (e.g. to follow up on a group booking)? Recommendation: **no by default**; if needed for event-day operations, a Manager can export a PIC-specific attendee list with explicit approval, audited.

**Explicitly forbidden for PIC (enforced by absence of routes, not by a flag):**

```
✗ view other PICs' fees, sales or settlements
✗ modify any fee, rate or ledger entry (no write route exists in /api/pic/**)
✗ modify payment amounts
✗ access platform-wide transaction lists
✗ access platform configuration
✗ create, edit, publish or cancel events
✗ issue refunds or approve them
✗ scan tickets (a PIC is not gate staff)
✗ export platform-wide reports
```

This "forbidden by absence" approach is stronger than a permission flag: a route that does not exist cannot be misconfigured.

### 27.4 Attribution and share-token endpoints

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/pic/attribution/manual` | `pic.attribution.manual` (Manager) | Creates a `MANUAL` attribution before payment with a mandatory reason; audited |
| `GET /api/pic/attribution/{orderNumber}` | `pic.view.own` / Manager | Shows the attribution and its evidence (source, method, timestamps) |
| `POST /api/events/{id}/track` | Public, rate-limited | Records a click for a PIC share token (`shareToken`, coarse metadata only). **Stores no PII** — no full IP persistence beyond a hashed daily bucket, per privacy minimisation. Feeds click counts only |

### 27.5 Tenant scoping illustration

```
Manager M (Organizer A) calls GET /api/admin/orders

1. session → user → membership(Organizer A, role MANAGER)   ← resolved from DB, not JWT
2. requirePermission("order.view", actor) → OK
3. scope = actor.organizerIds = [A]                          ← derived, never from query
4. query: WHERE organizerId IN (A) AND <filters>             ← injected last

→ Organizer B's orders are not filtered out after the fact; they are never selected.
→ GET /api/admin/orders/{B-orderNumber} → NOT_FOUND (404), not 403.
```

---

## 28. Admin/Manager API Contract

### 28.1 Split of duties in one namespace

Admin and Manager share `/api/admin/**`. Separation is by permission, evaluated in the service layer:

| Area | Admin | Manager | FINANCE |
| --- | --- | --- | --- |
| Users / roles / grants | full | — | — |
| Platform configuration | full | — | — |
| Sports master data | full | — | — |
| Venues | full | full | — |
| Events (create/edit/publish/cancel) | full | full | — |
| Order monitoring | full | full | read |
| Refunds | approve (grant) | approve + execute | approve + execute |
| PIC management (create/suspend/assign) | full | assign only | — |
| Fee rate change (future) | approve (grant) | full | — |
| Fee adjustment (new ledger entry) | approve (grant) | full | approve |
| Settlement | approve (grant) | prepare/approve/execute | prepare/execute |
| Reports / exports | view (export by grant) | full | full |
| Audit log | full | read | read |
| Check-in | full | full | — |

### 28.2 Endpoint map

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET/PATCH /api/admin/users` , `/api/admin/users/{id}` | `user.manage` | Existing route is extended, not duplicated (`app/api/admin/users/route.ts` already paginates + searches correctly) |
| `POST /api/admin/users/{id}/role` | `role.manage` | Changing a platform role is audited; a user cannot change their own role |
| `POST /api/admin/users/{id}/grants` , `DELETE …/grants/{grantId}` | `role.manage` | §6.4 `PermissionGrant`; cannot grant a permission the actor does not hold (no privilege escalation) |
| `GET/POST/PATCH /api/admin/organizers` | `organizer.manage` | Tenant CRUD, status, default fee rates, settlement bank details |
| `GET/POST/DELETE /api/admin/organizers/{id}/members` | `organizer.member.manage` | Membership + role; last-OWNER removal blocked (§7.3) |
| `GET/POST /api/admin/sports` | `sport.manage` | Admin only |
| `GET/POST/PATCH /api/admin/venues` | `venue.manage` | Manager allowed |
| `GET/POST/PATCH /api/admin/pics` | `pic.manage` | Create/suspend PIC profiles; Admin only for create/suspend |
| `POST /api/admin/pics/{id}/assign` | `pic.assign` | Assign to an event with an optional rate override |
| `GET /api/admin/pic-fees` | `fee.view` | Ledger read; filters: PIC, event, type, status, date |
| `POST /api/admin/pic-fees/adjust` | `fee.adjust` | Creates an `ADJUSTMENT` entry; reason required; audited |
| `POST /api/admin/pics/{id}/fee-rate` | `fee.rate.change` | Affects **future** calculations only |
| `GET /api/admin/transactions` | `transaction.view` | Payment ledger view (Payment + PaymentTransaction) |
| `GET /api/admin/webhooks` | `webhook.view` | WebhookEvent ledger — every delivery, valid or not, with processing result |
| `POST /api/admin/refunds/{id}/approve` \| `/execute` \| `/reject` | `refund.approve` / `refund.execute` | Reuses `lib/refund.ts` CAS transitions |
| `GET/POST /api/admin/settlements` | `settlement.prepare` | Prepare a run for a payee + period |
| `POST /api/admin/settlements/{id}/approve` \| `/execute` \| `/paid` \| `/cancel` | `settlement.approve` / `settlement.process` | Two-person control (§16.3) |
| `POST /api/admin/settlements/{id}/proof` | `settlement.process` | Upload transfer proof; private storage (§33.3) |
| `GET /api/admin/audit-log` | `audit.view` | Existing route reused/extended |
| `GET /api/admin/dashboard` | `report.view` | Aggregates in SQL |
| `GET/PATCH /api/admin/settings` | `platform.configure` | Extends `StoreSetting` → `PlatformSetting` |
| `POST /api/admin/jobs/{jobName}/run` | `platform.configure` | Manual trigger for the reaper/expiry/settlement jobs (ops convenience + testability) |

### 28.3 Financial-action safeguards (brief §11)

The brief forbids Admin from freely changing fees, amounts, settlements or the ledger. The API encodes that structurally rather than by convention:

| Forbidden action | Why it is impossible in this design |
| --- | --- |
| Edit a computed fee | No `PATCH /pic-fees/{id}` route exists. Corrections are `POST /pic-fees/adjust`, which **creates** an entry |
| Change an order's amount | No route accepts a monetary field for update. `EventOrder` totals are written only by the checkout and settlement paths |
| Manipulate a settlement | Only the defined state transitions exist (§16.3); each is permissioned, and `netAmount` is computed from ledger items, not accepted as input |
| Alter the ledger | `PICFeeLedger` is append-only; there is no update or delete route for it anywhere |
| Perform a Manager action | Permissions are explicit; an Admin without `settlement.execute` receives `FORBIDDEN` |
| Self-approve | The settlement transition requires a different approver when the amount exceeds the threshold (or always, per D-19) |
| Grant themselves a permission | `POST /users/{id}/grants` refuses to grant a permission the actor does not already hold |

### 28.4 Admin/Manager operational endpoints

| Endpoint | Permission | Notes |
| --- | --- | --- |
| `GET /api/admin/orders/attention` | `order.view` | **The "paid but unfulfillable" queue** (§11.4): orders where `paymentStatus = PAID` and tickets were not issued, plus `paymentStatus`/`status` mismatches. Operational necessity — without it, the expiry race becomes a silent customer complaint |
| `GET /api/admin/notifications` , `POST …/{id}/retry` | `notification.manage` | Dead-letter visibility and manual retry |
| `GET /api/admin/events/{id}/checkin-stats` | `checkin.view` | Live admitted/expected counters |
| `GET /api/admin/available-origins` style helpers | — | Not designed (no shipping/region features) |

---

## 29. Authorization Rules

### 29.1 The problem being solved

Phase 0 found three structural authorization gaps:

1. **No scope primitive** (S-3): ownership is always `userId`; there is no way to express "this actor may act for Organizer A, on Event 42, in the FINANCE capacity".
2. **Fail-open middleware** (S-2): `proxy.ts` uses prefix allow-lists and passes anything unmatched straight through.
3. **Stringly-typed roles** (Phase 0 §5.4): `types/next-auth.d.ts` types `role` as `string`, so every comparison is an unchecked `as any` cast; a typo silently becomes "false", which has already forced the codebase into 60+ inline checks.

This section defines the contract that fixes all three. **No helper is implemented in Phase 1** (brief §16 forbids it); only the contract and the rules are specified.

### 29.2 Authorization helper contract

The brief names six helpers. The design defines them as returning a **discriminated result** rather than throwing, because Phase 0 showed that the throwing variant (`lib/admin.ts#requireAdmin`) pushes error translation into every caller and is easy to call incorrectly.

```
// Actor context — resolved once per request, from the DB
ActorContext = {
  userId: string
  platformRole: 'ADMIN' | 'MANAGER' | 'PIC' | 'CUSTOMER'
  permissions: Set<Permission>          // resolved from role map + grants
  memberships: Array<{ organizerId, role, eventIds?: string[] }>
  picProfileId?: string
}

// Resolver (single entry point)
resolveActor(): Promise<ActorContext | null>

// Guards — all return the same shape
GuardResult = { ok: true, actor: ActorContext, scope: Scope } | { ok: false, error: AppError }

requireAuth()                        // any authenticated user
requirePermission(permission)         // platform-level capability
requireAdmin()                        // sugar for requirePermission('*')
requireManager()                      // sugar for the Manager capability set
requireOrganizerAccess(organizerId)   // actor is an active member of this tenant
requireOrganizerRole(organizerId, roles[])  // …with one of the given roles
requireEventAccess(eventId, capability?)    // resolves event → organizer → membership
requirePICAccess(picProfileId)        // actor IS this PIC, or holds fee.* over it

Scope = {
  organizerIds: string[]        // tenant filter injected into every query
  eventIds?: string[]           // narrower, for CHECKIN_STAFF
  picProfileId?: string         // for PIC self-scope
  isPlatformWide: boolean       // ADMIN/MANAGER only
}
```

### 29.3 Usage rules (mandatory)

1. **Every scoped handler begins with a guard.** No Prisma call may precede it. A handler that queries first and authorizes second is a defect, not a style choice.
2. **The scope object is passed into the service function**, not re-derived there. Services must accept `scope` as a required parameter, so a service call without a scope cannot compile.
3. **Repositories never expose an unscoped finder.** There is no `findOrderById(id)`; the only exported finders are `findOrderByIdInScope(id, scope)`. This is the mechanism that makes a forgotten filter a compile error rather than a data leak.
4. **`organizerId` is never read from the request.** It comes from the resolved actor or from a resource already validated by a guard.
5. **Scope failures return `NOT_FOUND` (404)**, never `FORBIDDEN`, to avoid confirming the existence of another tenant's resource.
6. **Guard results are asserted, not assumed.** `const g = await requireEventAccess(id, 'event.update'); if (!g.ok) return error(g.error);`
7. **Cross-cutting tests are mandatory.** Every scoped endpoint gets a test that calls it with another tenant's (and another PIC's) identifiers and asserts 404/403 (§36.1).

### 29.4 Decision matrix — which guard for which route

| Route class | Guard chain |
| --- | --- |
| Public catalog | none (hard-coded published filter) |
| Customer own-resources | `requireAuth()` + ownership predicate on `userId` |
| Customer checkout | `requireAuth()` + rate limit + event eligibility (published, sales open) |
| PIC namespace | `requireAuth()` + `requirePICAccess(session.picProfileId)`; scope = `{ picProfileId }` |
| Organizer operations | `requireAuth()` + `requireEventAccess(eventId, capability)` → scope = `{ organizerIds: [tenant] }` |
| Organizer lists | `requireAuth()` + `requirePermission(perm)` → scope from memberships |
| Check-in | `requireAuth()` + `requireEventAccess(eventId, 'checkin.scan')` (CHECKIN_STAFF additionally requires a `StaffEventAssignment`) |
| Financial reads | `requireAuth()` + `requirePermission('fee.view' \| 'report.view')` + scope |
| Financial writes (adjust/approve) | `requireAuth()` + `requirePermission('fee.adjust' \| 'settlement.approve')` + scope + audit write |
| Platform config | `requireAuth()` + `requirePermission('platform.configure')` (ADMIN only) |
| Webhooks | no session — signature verification **is** the authorization (§31) |

### 29.5 Anti-patterns explicitly banned

| Banned | Why |
| --- | --- |
| `if (role !== 'ADMIN') return 403` inline in a handler | The Phase 0 pattern; cannot express scope, and each new handler is a fresh opportunity to omit it |
| Trusting `role` from the JWT for tenant decisions | A stale token would grant access after a membership was revoked (§29.7) |
| Accepting `organizerId`/`picProfileId` from the body or query | The classic IDOR vector; Phase 0 already avoids it for `userId` and the rule is extended to all scopes |
| UI-only hiding | Brief §10 forbids it; the server is the control |
| Checking permission **after** fetching the row | Data has already been read; authorization must precede it |
| Returning `FORBIDDEN` for another tenant's resource | Confirms existence (enumeration oracle) |
| A "no filter" branch in a list query | One forgotten branch leaks the platform |
| Reusing `session.user as any` in new code | Type-safety is the cheapest enforcement tool available |

### 29.6 Auth architecture (brief §37)

**Decision: the existing Auth.js (NextAuth v5) foundation is KEPT.** Phase 0 verified it is sound and there is no reason to replace it:

| Verified property | Evidence | Verdict |
| --- | --- | --- |
| OAuth account-takeover protection | `auth.ts` sets `allowDangerousEmailAccountLinking: false` with an explanatory comment | **KEEP** — a real, deliberate security control |
| Timing-attack mitigation attempt | `auth.ts` runs a dummy verify on user-not-found | **FIX** — the dummy is not a valid bcrypt hash (§33.4), so the mitigation is currently ineffective |
| Constant-time-ish credential lookup | `findFirst({ OR: [email, phone] })` then bcrypt compare | **KEEP** — but add login rate limiting (§33.4) |
| JWT session strategy | `session: { strategy: 'jwt' }` | **KEEP** |
| Role carried in token/session | `jwt`/`session` callbacks copy `id` and `role` | **ADAPT** — see §29.7 |
| Typed session | `types/next-auth.d.ts` exists (the brief's claim that it does not is incorrect — §2) | **ADAPT** — widen `role` from `string` to the Prisma union and type the JWT identically |
| Registration | `app/api/auth/register/route.ts` with zod + `rateLimiters.register` | **KEEP** |

**Session model options:**

| Option | Consequence | Verdict |
| --- | --- | --- |
| Keep JWT-only (current) | No DB read per request; but role/membership changes are invisible until token refresh | KEEP for identity + platform role |
| Keep JWT, add DB resolution for **scope** | Identity and `platformRole` come from the token; tenant memberships and permissions are resolved from the DB per request (cached briefly) | **Recommended** |
| Switch to database sessions (the `Session` table already exists but is unused) | Always-fresh data, but adds a DB round trip per request and re-enables a table Phase 0 flagged as dead | Rejected for MVP |

### 29.7 Membership and permission freshness (the decision that matters)

A JWT claim is a **snapshot**. If an organizer membership is revoked, a token minted an hour earlier must not keep granting access. The design therefore splits the two concerns:

```
JWT (token)                      → identity only: userId, platformRole, email
                                    short TTL (e.g. 15–60 min), refreshed on activity

DB (per request, cached ≤ 60s)   → memberships, permissions, memberships' eventIds
                                    authoritative for every authorization decision
```

| Rule | Reason |
| --- | --- |
| Tenant scope is **never** taken from the JWT | Revocation and role changes must be effective immediately |
| `platformRole` may come from the JWT, but is treated as a **hint** validated against `User` on the first DB resolution | Prevents a role downgrade from being ignored until token expiry |
| Permission changes take effect within the cache TTL (≤ 60 s) | Documented, bounded staleness; acceptable for an operational platform |
| The cache key includes `userId` only, never a request-supplied value | Prevents cache-poisoning of scope |
| A membership revocation also invalidates the cache entry explicitly | Immediacy for the sensitive case |

`DECISION REQUIRED` — D-48: is bounded staleness (≤ 60 s) acceptable, or is strict immediacy required? If strict, resolve scope from the DB on every request and drop the cache (simpler, slower).

### 29.8 Authorization boundary summary

```
Layer 1  proxy.ts            → coarse: is there a session? (never the only control)
Layer 2  route handler       → resolveActor() + guard + scope injection
Layer 3  service              → receives scope; logic only, no authorization decisions
Layer 4  repository           → scope-required signatures; no unscoped finders exist
Layer 5  database            → unique constraints + FKs as the final invariant (quota,
                               duplicate check-in, idempotency keys, one attribution per order)
```

Authorization is enforced at layers 2–4. Layer 5 exists so that a bug in 2–4 cannot produce financial or admission errors; it cannot substitute for them.

### 29.9 Proxy / middleware analysis (brief §38)

Phase 0 (S-2) described `proxy.ts` as an allow-list that fails open, and the brief requires that middleware not be treated as sufficient. Analysis and target design:

**Current behaviour (verified)**

| Aspect | Today | Problem |
| --- | --- | --- |
| Public API list | `PUBLIC_API_PREFIXES` (13 entries) bypasses auth | A new ticketing prefix that matches none is handled by the next branch |
| Protected API list | `PROTECTED_API_PREFIXES` (18 entries) returns 401 when unauthenticated | **Role is never checked** — any logged-in user passes |
| Unlisted routes | Fall through with no check (`return;`) | **Fail-open by default** |
| Page routes | Redirect to `/login` when unauthenticated | No role check; `/admin` renders for any logged-in user if a page-level check is missed |
| Matcher | Enumerated prefixes | A new top-level route is not matched at all |

**Target design**

| Rule | Design |
| --- | --- |
| Default deny for API | Any `/api/**` request is rejected unless explicitly declared public. The public list becomes the only allow-list; the protected list is **deleted** because "protected = everything not public" |
| No role checks in the proxy | The brief's own principle: middleware cannot know the resource's tenant. It performs **authentication gating only** |
| Tenant/role checks stay in the service layer | Layers 2–4 (§29.8) remain authoritative |
| Redirect UX | Unauthenticated page requests still redirect to `/login?callbackUrl=…`; authenticated-but-forbidden requests are handled **in the page/route**, not by redirecting (a redirect would mask the 403 and confuse users) |
| Matcher | Broad (`/((?!_next/static|_next/image|favicon.ico|public assets).*)`) so new routes are covered automatically, with the public allow-list doing the work |
| Defence in depth | Even with a correct proxy, every handler re-authorizes. The proxy reduces noise and stops obvious unauthenticated traffic; it never grants access |
| Server-only guarantee | The proxy must not import heavy domain modules. It resolves the session and matches a prefix list using **local constants**, keeping the edge bundle small (Phase 0 performance P-5/P-10) |

**Failure-mode test:** a new route `/api/organizer/x` added without touching the proxy must be **rejected** for unauthenticated callers and still handled correctly for authenticated ones. That test is part of the Phase 2 acceptance criteria (§40).

`DECISION REQUIRED` — D-49: should the proxy also enforce *platform-role* gating for `/admin` pages (defence in depth), knowing that a stale JWT role could then deny a legitimately promoted user until refresh? Recommendation: no role gating in the proxy; keep it authentication-only and rely on layers 2–4, which resolve scope from the DB.

---

## 30. Idempotency Strategy

### 30.1 Matrix (brief §42)

The brief names eight operations that must be idempotent. Each is satisfied by a **database constraint**, not by application-side checking, because only the database can arbitrate concurrent duplicates.

| # | Operation | Key | Unique constraint | Behaviour on duplicate |
| --- | --- | --- | --- | --- |
| 1 | **Checkout / order creation** | Client-supplied `Idempotency-Key` header, scoped to `(userId, endpoint, key)` | `IdempotencyKey.(userId, scope, key)` unique; also `EventOrder` is created inside the same transaction that records the key | Returns the **existing** order (200/201) instead of reserving quota twice |
| 2 | **Payment session creation** | `Payment.(orderId)` where `status IN (PENDING, UNPAID)` | Partial-unique semantics via a non-null `activePaymentKey` column (e.g. `orderId`) set only while active, or a transactional check + CAS | Returns the existing `paymentUrl` rather than creating a second session |
| 3 | **Webhook** | `providerEventId` (provider-side event/transaction id) | `WebhookEvent.providerEventId` unique | Second insert fails → 200 no-op; the order CAS is a second guard |
| 4 | **Ticket issuance** | `(orderItemId, sequenceNo)` and `qrTokenHash` | Both unique | Re-issue attempt collides → nothing new is created. Issuance additionally runs only when the settlement CAS reports `affectedRows = 1` |
| 5 | **Refund** | `Refund.idempotencyKey` (derived from order + requested ticket ids + attempt, or a client key) | `idempotencyKey` unique; plus `RefundItem.ticketId` unique among non-rejected refunds | Returns the existing refund; a second refund for the same ticket is refused |
| 6 | **PIC fee creation** | `PICFeeLedger.idempotencyKey` = `pic-fee:{type}:{orderItemId}` and `(orderItemId, type)` | Both unique | A repeated settlement run inserts nothing |
| 7 | **Settlement** | `(payeeType, payeeId, periodStart, periodEnd)` | Unique | A duplicate run for the same period is refused with `CONFLICT` |
| 8 | **Notification** | `Notification.idempotencyKey` (+ `(notificationId, channel)` on delivery) | Unique (already exists in Phase 0) | Duplicate event emits one message |

### 30.2 `IdempotencyKey` table (optional but recommended for #1)

`id`, `userId`, `scope` (e.g. `POST /api/checkout`), `key`, `requestHash` (hash of the normalized body), `responseRef` (the created resource id), `status` (`IN_PROGRESS | COMPLETED | FAILED`), `expiresAt`, `createdAt`.

Rules:

| Case | Behaviour |
| --- | --- |
| Same key, same `requestHash` | Return the stored `responseRef` (no side effects) |
| Same key, **different** `requestHash` | `409 CONFLICT` — the client reused a key for a different payload. Silently treating it as the same request would hide a real bug |
| Key expired | Treat as new; the TTL (e.g. 24 h) bounds table growth and matches the order's useful retry window |
| Concurrent same key | Insert loses the race → the loser reads the winner's row and waits/returns it |

Without this table, a double-submitted checkout would create **two** orders, reserve quota twice, and send two payment sessions — the exact class of bug this phase exists to prevent.

### 30.3 Why not "check then act"

Every case above could be naively implemented as *read → if exists return else create*, which is a time-of-check/time-of-use race: two concurrent requests both read "not exists" and both create. The design relies on the database rejecting the second write (`P2002` unique-violation), which is the only correct approach under concurrency. The application treats the violation as the expected duplicate path, not as an error.

### 30.4 Retry semantics for callers

| Caller | Expected behaviour |
| --- | --- |
| Browser checkout form | Generates one `Idempotency-Key` per submit intent; a network retry reuses it |
| Mobile app (future) | Same contract; the key is persisted until a response is received |
| Webhook provider | Retries are expected and handled (§31) |
| Internal jobs | Re-runnable by design; each iteration's CAS makes a second run a no-op |
| Admin actions | Deliberate duplicates (e.g. two refunds for two tickets) are distinct requests with distinct keys |

---

## 31. Webhook Strategy

### 31.1 The Phase 0 gap being closed

Phase 0 **S-5**: duplicate-delivery protection today is *indirect* — it relies on the order-state CAS and on `Refund.orderId @unique`. There is no record of how many times a provider event was delivered, no key that identifies a provider event, and no visibility into rejected deliveries. The brief (§21) requires a dedicated ledger whose unique constraint prevents replay.

### 31.2 `WebhookEvent` entity

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `provider` | `String` | `ipaymu` (extensible) |
| `providerEventId` | `String` | **`@unique`** — the replay guard. Derived from the provider's transaction id (and the event type if one transaction can produce several event types) |
| `eventType` | `String` | `payment.success \| payment.pending \| payment.failed \| refund.completed \| unknown` |
| `payloadHash` | `String` | SHA-256 of the raw body. Two different payloads with the same `providerEventId` are a red flag and are stored with a note |
| `payloadJson` | `Json?` | **Redacted** snapshot (no PII beyond what is needed, no secrets). Needed for dispute investigation |
| `signatureValid` | `Boolean` | Recorded even for rejections |
| `amountReported` | `Decimal(14,2)?` | From the payload, for audit |
| `orderId` / `paymentId` | `String?` | Resolved when possible; null when the reference was unknown |
| `processingStatus` | `WebhookProcessingStatus` | `RECEIVED \| PROCESSED \| IGNORED_DUPLICATE \| IGNORED_UNKNOWN \| REJECTED_SIGNATURE \| REJECTED_AMOUNT \| FAILED` |
| `processingResult` | `String?` | Human-readable outcome, e.g. `settled` |
| `errorMessage` | `String? @db.Text` | For `FAILED` |
| `receivedAt` | `DateTime @default(now())` | |
| `processedAt` | `DateTime?` | |
| `remoteIp` | `String?` | Provider IP; useful to detect unexpected senders |

Indexes: `providerEventId` unique, `(provider, receivedAt)`, `(processingStatus, receivedAt)`, `(orderId)`.

**Append-only with one forward-only mutation:** `processingStatus`/`processedAt`/`processingResult` advance after the row is inserted. Nothing is ever deleted (the brief's auditability requirement; also the only evidence trail if a provider disputes a settlement).

### 31.3 Insert-first flow (the ordering that matters)

```
1. read raw body (Phase 0 — unchanged)
2. verify signature  → invalid ⇒ insert WebhookEvent(REJECTED_SIGNATURE) THEN return 401
3. verify amount     → mismatch ⇒ insert WebhookEvent(REJECTED_AMOUNT)  THEN return 400
4. INSERT WebhookEvent(providerEventId, RECEIVED)
      └─ unique violation ⇒ IGNORED_DUPLICATE ⇒ return 200 (no mutation)
5. classify status
      └─ unknown ⇒ update row IGNORED_UNKNOWN ⇒ return 200 (never mutates)
6. settlement transaction (§13.3) — order CAS, quota, tickets, attribution, ledger
7. update row PROCESSED / FAILED
8. return 200 (except genuine server errors ⇒ 500 so the provider retries)
```

Insert-first is essential: it means a replay storm costs one failed insert per delivery instead of a full settlement transaction, and it leaves evidence even for requests that are rejected.

### 31.4 Replay and storm handling

| Attack / condition | Outcome |
| --- | --- |
| Same event delivered 10 times | 1 × `PROCESSED`, 9 × `IGNORED_DUPLICATE`; zero extra side effects |
| Old valid payload replayed days later | Same key ⇒ `IGNORED_DUPLICATE` |
| Replay with a **different** `providerEventId` but the same order | Order CAS rejects (`affectedRows = 0`) because the order is already `PAID`; the row records a settlement attempt that changed nothing |
| Replay after the order was cancelled/expired | CAS rejects (terminal state); the row records the attempt. If `amountReported > 0` and the order is not payable, an operator alert is raised (§11.4) |
| Forged signature | Rejected 401 and recorded (`signatureValid = false`) — visible in `/api/admin/webhooks` so an attack is observable |
| Provider retry storm (many distinct events, e.g. many buyers) | Naturally parallel; the ledger insert is the fastest possible first operation, keeping transaction time minimal (P-4) |
| Same `providerEventId`, different payload | Stored with both hashes recorded; the mismatch is surfaced for investigation (a provider bug or a tampering attempt) |

### 31.5 Security rules preserved from Phase 0

These are non-negotiable and must survive the retargeting of the handler:

1. Raw body is read before any parsing; the signature covers exact bytes.
2. Signature verification is fail-closed: missing signature, missing configuration, or a verification error ⇒ 401/500, **never** a fall-through to processing.
3. The webhook is the **only** trigger for settlement and issuance. The browser redirect and the polling endpoint never mutate state.
4. Terminal states never resurrect.
5. Amount is verified against the server-side order total; a client-influenced amount is never trusted.
6. Unknown statuses are acknowledged and never mutate.
7. Secrets and full payloads are never logged (§29 anti-patterns, §33.7).

### 31.6 Must-verify items before Phase 7 (carried from Phase 0 S-6 / §14.3)

| # | Item | Blocking consequence if unverified |
| --- | --- | --- |
| 1 | The exact callback header set (`X-Signature` alone, or with `X-Timestamp`/`X-External-ID`) | The current route requires three headers but verifies one; a live sandbox test must confirm, or legitimate callbacks will be rejected |
| 2 | Whether the provider supplies a stable, unique event/transaction id suitable as `providerEventId` | Without it, the replay guard degrades to a payload hash (workable but weaker) |
| 3 | Whether a timestamp exists and is trustworthy | A freshness window could be enforced in addition to the unique key |
| 4 | Retry policy (attempt count, total window, backoff) | Determines how long a `FAILED` row may legitimately be retried and when a stuck settlement needs human intervention |
| 5 | Whether the payment amount can legitimately differ from the order total (fees added by the provider) | The current handler already prefers `sub_total`; a ticketing retarget must preserve that exact logic or amount checks will fail intermittently |

**Recommendation:** Phase 7 begins with a sandbox transaction recorded end-to-end into `WebhookEvent`, and that recorded payload becomes the fixture for the webhook test suite (§36.3). No webhook test should be written against a guessed payload shape.

---

## 32. Audit Log Strategy

### 32.1 Current state and verdict

Phase 0 verified `AdminAuditLog` (`adminId`, `action`, `entityType`, `entityId`, `description`, `metadata Json?`, `createdAt`, 4 indexes) plus `lib/admin/audit-log.ts#createAuditLog`. It is useful but insufficient for a financial platform for three reasons: `adminId` is a required string that is overloaded with `"SYSTEM"`, `"PROVIDER"`, `"PROVIDER_AUTO"` (verified in `lib/refund.ts`), there is no actor type, no tenant scope, and no before/after state.

**Verdict: KEEP (ADAPT/EXTEND).**

### 32.2 `AuditLog` (extended)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `String @id @default(cuid())` | |
| `action` | `String` | namespaced, e.g. `fee.adjust`, `settlement.approve`, `event.publish`, `checkin.override`, `report.export`, `role.change`, `permission.grant`, `ticket.reissue` |
| `actorType` | `AuditActorType` | `USER \| SYSTEM \| PROVIDER \| JOB` — **fixes the `adminId="SYSTEM"` overload** |
| `actorUserId` | `String?` | null for system/provider/job |
| `actorRole` | `String?` | snapshot of the role at the time (roles change) |
| `actorOrganizerId` | `String?` | the tenant the actor acted *as* |
| `entityType` | `String` | `PICFeeLedger`, `Settlement`, `EventOrder`, `Event`, `Ticket`, `Refund`, `OrganizerMember`, `PermissionGrant`, `ExportJob`, … |
| `entityId` | `String?` | string (not Int) because new entities use cuid |
| `organizerId` | `String?` | tenant scope for filtered views |
| `description` | `String` | human-readable, no PII |
| `beforeState` | `Json?` | redacted snapshot of the changed fields only |
| `afterState` | `Json?` | same |
| `reason` | `String? @db.Text` | **required** for financial adjustments, overrides, and manual attributions |
| `metadata` | `Json?` | extra context (e.g. filters used for an export, row count) |
| `ipAddress` | `String?` | for privileged actions |
| `userAgent` | `String?` | |
| `correlationId` | `String?` | ties one request's audit rows together |
| `createdAt` | `DateTime @default(now())` | |

Indexes: `(entityType, entityId)`, `(action, createdAt)`, `(actorUserId, createdAt)`, `(organizerId, createdAt)`, `(createdAt)`.

**Append-only by contract:** no update or delete route, no service function that mutates an audit row, and no soft-delete flag. Retention: retain indefinitely for financial actions (the brief requires bookkeeping traceability); retention limits, if any, apply only to non-financial operational rows. `DECISION REQUIRED` — D-50.

### 32.3 Mandatory audit events (brief §43)

| Action | Trigger | Captured | Mandatory reason? |
| --- | --- | --- | --- |
| `fee.rate.change` | Platform/organizer/PIC rate changed | before/after rate, scope, effective-from | Yes |
| `fee.adjust` | Adjustment ledger entry created | amount, direction, target PIC, linked order | **Yes** |
| `fee.reverse` | Refund reversal created | refundId, quantity, amount | No (system) |
| `transaction.adjust` | Any manual correction touching an order's financial fields (should be rare; designed to be auditable even if discouraged) | before/after | **Yes** |
| `refund.request` / `refund.approve` / `refund.reject` / `refund.complete` / `refund.fail` | Each refund transition | amount, ticketIds, actor | No (except reject) |
| `settlement.create` / `approve` / `execute` / `paid` / `fail` / `cancel` | Each settlement transition | netAmount, item count, payee, approver vs preparer | **Yes** for cancel/reject |
| `role.change` | Platform role changed | before/after, target user | Yes |
| `permission.grant` / `permission.revoke` | `PermissionGrant` created/revoked | permission string, target, expiry | **Yes** |
| `organizer.member.add` / `remove` / `role.change` | Membership change | before/after role, target user | Yes for remove |
| `event.publish` / `event.unpublish` / `event.cancel` / `event.archive` | State transitions | before/after status | **Yes** for cancel |
| `event.settings.change` | Price/quota/date change | before/after of changed fields only | Yes for price/quota decrease |
| `checkin.override` | Manual admission without a valid QR | ticket, gate, staff, note | **Yes** |
| `checkin.rejected` | Rejected scan (invalid/duplicate/wrong event) | result, token hash (never the raw token), device | No |
| `ticket.reissue` | New QR token issued | ticket, old/new `qrVersion` | Yes |
| `ticket.void` | Ticket invalidated | ticket, reason | Yes |
| `report.export` | Any export | reportType, filters, rowCount, filename | No |
| `pic.attribution.manual` | Manual attribution | order, PIC, reason | **Yes** |
| `user.impersonate` (if ever added) | Support login as a user | target, duration | **Yes** — and the design recommends **not** adding impersonation at all |
| `platform.settings.change` | Platform configuration change | before/after of sensitive fields | Yes |

**Rule:** if an action can move money, change a permission, change an event's commercial state, or admit a person, it must produce an audit row **in the same transaction** as the change it describes. An audit row written after a successful action can be lost by a crash, leaving an unexplained financial state.

### 32.4 Audit read access

| Viewer | Sees |
| --- | --- |
| Admin | All rows (users, roles, all tenants) |
| Manager | Rows for their tenant(s) + their own actions |
| Finance | Financial rows in their tenant(s) |
| PIC | **Only their own fee-related rows** (`PIC_FEE_CREATED`, `PIC_FEE_PAID` projections), not the raw audit log |

`DECISION REQUIRED` — D-51: should a PIC see the audit rows about their own fees, or only the derived fee history? Recommendation: derived fee history only (simpler, and the raw log may contain internal notes).

### 32.5 What the audit log is not

The audit log is **not** a substitute for the domain ledgers. `PICFeeLedger` is the financial source of truth; `AuditLog` explains *who did what and why*. Where both exist (a fee adjustment), the ledger records the money and the audit log records the intent. Neither duplicates the other's role.

---

## 33. Security Remediation Plan

Phase 0 produced 15 findings (S-1…S-15). This section turns each into a concrete plan with an owner phase. **Nothing is remediated in Phase 1** (brief §36 and §47 forbid it); this is the plan only.

### 33.1 Overview

| ID | Severity | Remediation phase | Blocking launch? |
| --- | --- | --- | --- |
| S-1 | **Critical** — committed KTP scans | Phase 2 (before any feature work) | **YES** |
| S-2 | High — `proxy.ts` fails open | Phase 3 (with RBAC) | **YES** |
| S-3 | High — no tenant isolation | Phase 3 (RBAC core) | **YES** |
| S-4 | High — login unrate-limited + invalid dummy hash | Phase 3 | **YES** |
| S-5 | High — no webhook replay ledger | Phase 7 | **YES** |
| S-6 | Medium — unverified header set | Phase 7 (sandbox verification) | **YES** |
| S-7 | Medium — per-process rate limiting | Phase 2 (shared store) | Recommended |
| S-8 | Medium — ad-hoc validation | Phase 2/3 (zod boundary) | **YES** for new code |
| S-9 | Medium — duplicate upload routes / content type | Phase 4 (upload consolidation) | No |
| S-10 | Medium — internal hosts committed | Phase 2 | Recommended |
| S-11 | Medium — CSRF helper is decorative | Phase 3 | Recommended |
| S-12 | Low–Med — log/error hygiene | Continuous | Recommended |
| S-13 | Low–Med — risky dependencies | Phase 2 (`xlsx`), Phase 11 (email) | Recommended |
| S-14 | Low — dead authz helpers | Phase 3 (replaced by the new helper layer) | No |
| S-15 | Low — page guard lacks role check | Phase 3 / §29.9 proxy redesign | No |

### 33.2 S-1 — committed PII (KTP scans) — **Critical**

**Finding (verified):** `storage/uploads/affiliate/ktp/**` is tracked in git (Phase 0: `git ls-files storage` returns KTP files), and `.gitignore` covers only `node_modules/`, `.next/`, `.env*`, `npm-debug.log*`, `data/whatsapp-auth/`. These are Indonesian national ID card photographs — among the most sensitive personal documents in the market.

**Plan:**

| Step | Action | Detail |
| --- | --- | --- |
| 1 | **Purge from git history** | A history rewrite (`git filter-repo` / BFG) is required — deleting the files in a new commit leaves them retrievable. Requires: a maintenance window, a fresh clone by every contributor, and coordination with anyone who has a fork |
| 2 | **Rotate exposure assumptions** | Treat any credential or document in the repository's history as disclosed. If any of the KTP images were ever mirrored to a CI artifact, a backup, or a public deploy, include those in the purge scope |
| 3 | **`.gitignore` hardening** | Ignore `storage/`, `uploads/`, `data/` wholesale (not just the whatsapp subdirectory). Rule: **no user-supplied file is ever inside the repository working tree** |
| 4 | **Storage strategy** | Private object storage (or a private server directory outside the web root) with **signed, short-lived URLs**. Never a public path, never a guessable filename |
| 5 | **Access control** | KYC-type documents may be read only by the document owner and by Admin/FINANCE with an explicit permission; every read is audited (who, when, which document) |
| 6 | **Retention** | Define a maximum retention for identity documents after verification, and a deletion job. `DECISION REQUIRED` — D-52: is identity documentation collected at all in the new domain? The Phase 1 design deliberately models **no** KTP upload: `PICProfile` stores `taxId`/`identityNote` as text, not images |
| 7 | **Migration** | If existing KTP data must be preserved (legal/contractual), migrate it to private storage with a documented access log, then confirm the repository and its history no longer contain it |
| 8 | **Secrets/credentials** | Confirm no credential was ever committed. `.env` is gitignored (verified), but `next.config.ts` leaks internal IPs and a tunnel hostname (S-10) |
| 9 | **Verification** | A scan of the full history for image files and for the strings `ktp`, `KTP`, `storage/uploads` must return nothing before this item is closed |

**Design consequence already applied:** the new domain stores no identity documents (§14.1). Affiliate-style KYC does not exist in the ticketing model, so the flow that created the problem has no successor. If KYC is reintroduced for organizer payouts, it must start from step 4 — private storage first, never the repository.

### 33.3 S-3 / S-15 — tenant isolation and page-level guards

Covered structurally by §7.4, §29.2–§29.5 (scope-required repositories, guards before queries, 404 for scope failures, negative tests in §36.1), and §29.9 (proxy redesign). Listed here so the remediation list is complete rather than implied.

### 33.4 S-4 / S-7 — login rate limiting and shared rate limiting

**S-4 (verified):** `rateLimiters.login` is defined in `lib/rate-limit.ts` but **has zero call sites**, and `auth.ts` calls `verifyPassword(password, "$2a$12$x dummy hash to prevent timing attack")` — a string that is not a valid bcrypt hash (real hashes are 60 characters of structured base64). `bcryptjs.compare` therefore returns `false` without performing the expensive comparison, so the intended user-enumeration defence does not work.

**Plan:**

| Step | Action |
| --- | --- |
| 1 | Replace the dummy with a **real, precomputed** bcrypt hash of a random string, generated once and stored as a constant (never recomputed per request — hashing on every miss would itself be a DoS vector) |
| 2 | Wire login rate limiting at the credentials path, keyed by **identifier hash + IP**, e.g. 5 attempts / 15 min per identifier and 20 / 15 min per IP. Where the check lives must be verified against the Auth.js v5 credentials flow (inside `authorize()`, or by wrapping the credentials callback route) — `DECISION REQUIRED` — D-53: the exact integration point, to be confirmed against the installed `next-auth@5.0.0-beta.32` API before Phase 3 |
| 3 | Add progressive delay/lockout after repeated failures for the same identifier, with a recovery path (never a permanent lockout of a legitimate user) |
| 4 | Ensure the limiter does not become an **account-lockout DoS** (an attacker locking a victim out). Mitigation: prefer IP+identifier combined thresholds over identifier-only, and keep the window short |
| 5 | Record failed attempts in the audit log (count only, no password material, no full identifier) |

**S-7 (verified):** the limiter is an in-process `Map`; `REDIS_URL` only triggers a warning; and `getClientIp()` returns the literal `"untrusted"` unless `TRUSTED_PROXY` is set, so **every** untrusted client shares one bucket — both useless for throttling and a self-DoS for legitimate users.

| Step | Action |
| --- | --- |
| 1 | Adopt a shared store (Redis-compatible) for limits that must hold across instances: login, register, checkout, payment creation, check-in scan, refund, export |
| 2 | Keep the existing anti-spoofing logic (`TRUSTED_PROXY`-gated header trust) — it is correct and must not be weakened |
| 3 | Bucket by a stable, server-derived identity where possible (session user id) in addition to IP, so one attacker cannot exhaust the shared bucket for everyone |
| 4 | Ensure the in-memory fallback (dev/single instance) is documented as non-production |

`DECISION REQUIRED` — D-54: introduce Redis in Phase 2 (extra infrastructure on a single VPS) or accept per-instance limiting until scale requires it? Recommendation: introduce it in Phase 2 — a ticketing on-sale is precisely the moment per-instance limiting fails, and the cost is one service.

### 33.5 S-5 / S-6 — webhook replay protection and verification completeness

Fully designed in §21 and §31.2–§31.6. Summary of the remediation: add the `WebhookEvent` ledger with a unique `providerEventId`, insert it **before** any state change, record rejected deliveries, and verify the real provider header set against a sandbox transaction before Phase 7 completion. The Phase 0 signature verification itself is **not** weakened or rewritten.

### 33.6 S-9 — upload handling

**Verified today:** `app/api/admin/upload/route.ts` already validates the MIME allow-list, enforces a 5 MB cap, checks **magic bytes** (JPEG/PNG/WebP), randomizes the filename, and writes outside the public path. That is good work and is kept.

Remaining issues and the plan:

| Issue | Plan |
| --- | --- |
| Two near-identical serving routes (`/api/uploads/products/[filename]` and `/api/admin/upload/products/[filename]`) with the same logic | Consolidate into one serving route; the second is a duplicate (Phase 4) |
| `Content-Type` derived from the file extension | Keep the allow-list mapping, but always send `X-Content-Type-Options: nosniff`, and never serve with a `text/html`-capable type |
| Public `Cache-Control: immutable` on all uploads | Fix: even immutable-looking images can be replaced by a re-upload. Serving must be stable but not blindly cacheable forever for sensitive categories. Correct for public banners; must be **private/signed** for anything non-public (settlement proof, any identity document) |
| No virus/malware scanning | Acceptable for images validated by magic bytes at MVP; required before accepting PDFs/archives (post-MVP PDF tickets are generated server-side, not uploaded, which avoids the issue) |
| Upload rate limiting | `rateLimiters.upload` exists (20/min per user) — must be applied to every upload path, verified per route |
| Image re-encoding | Recommended (strip EXIF, which can contain GPS coordinates) for event banners and any user-supplied image. `DECISION REQUIRED` — D-55: re-encode at MVP or post-MVP? Recommendation: MVP — EXIF GPS from an organizer's phone photo is an unintended location disclosure |

### 33.7 S-12 — logging and error hygiene

| Rule | Rationale |
| --- | --- |
| Never log: QR tokens, passwords, `Authorization` headers, provider secrets, full webhook payloads, KTP/document contents, or buyer PII beyond an identifier | Phase 0 already follows a "safe fields only" convention in the webhook — formalise and extend it |
| Log identifiers, not payloads: `orderNumber`, `ticketCode`, `providerEventId` | Enough for correlation |
| Client responses never include internal messages or stack traces; `AppError.expose = false` resolves to a generic message | The existing suite already contains an `L1-error-info-leak` test — preserve that guarantee |
| Every log line for a financial action carries a `correlationId` | Ties the logs, the audit row and the ledger entry together |
| Replace ad-hoc `console.log` in hot paths with a levelled logger (§38 debt item) | Phase 0 P-11 |
| Do not log the raw scanned QR token on check-in failure — log the token **hash** | A log is a copy of a credential |

### 33.8 S-10 — committed internal infrastructure

`next.config.ts` hardcodes `allowedDevOrigins` with three internal IPs and a `trycloudflare.com` tunnel host. Plan (Phase 2): move to environment-driven configuration, remove the tunnel host, and keep only what local development genuinely needs. Dev-only, but it publishes internal topology and a tunnel hostname that could be re-registered.

### 33.9 S-11 — the CSRF helper

`lib/csrf.ts` documents itself as CSRF protection but only checks for a session, and two of its three exports have zero call sites. Phase 0 assessed the real protection as NextAuth's `SameSite` cookies (adequate). Plan: either implement a real origin check (`Origin`/`Sec-Fetch-Site` validation) on state-changing routes, or delete the helper and document the actual mechanism. Recommendation: implement the origin check — it is ~10 lines, it is defence in depth for cookie-based auth, and it also protects the ticketing checkout. `DECISION REQUIRED` — D-56.

### 33.10 S-8 — validation at the boundary

Phase 0: zod is used only for registration; every other endpoint hand-rolls checks. Plan: **one zod schema per endpoint** for all new ticketing routes (request body, query params, and route params), with a shared parser that converts issues into `AppError(VALIDATION_ERROR)` with field details. Sorting and filtering values are **allow-listed enums**, never free strings interpolated into queries — the existing `sortby-injection` security test documents that this rule matters.

This is a launch requirement for new code (not a retrofit of the 115 legacy handlers, which are removed in Phase 14).

### 33.11 S-13 — dependency risk

| Dependency | Risk | Plan |
| --- | --- | --- |
| `xlsx@0.18.5` | Known advisories; unmaintained on the public registry | Replace with a maintained writer before the export features are built (§24.7). `DECISION REQUIRED` — D-44 |
| `@whiskeysockets/baileys@7.0.0-rc14` | Release candidate; unofficial client; ban/ToS risk | Pin exactly; keep behind the provider boundary; dual-channel delivery so a ban is survivable (§22.3, §23.5). Consider an official provider — D-37 |
| `next-auth@5.0.0-beta.32` | Beta | Monitor for a stable release; pin and test upgrades. The credentials/rate-limit work (D-53) must be verified against this exact version |
| `@google/genai`, `@tanstack/react-query` | Unused (verified: zero imports) | Remove (Phase 2 housekeeping) |
| `axios` | Used in one file | Keep or replace with `fetch` when that file is refactored |
| No `npm audit` in CI | Unknown advisories go unnoticed | Add an audit/OSV step to CI (Phase 2) |

### 33.12 S-14 — dead authorization helpers

`lib/csrf.ts#requireSession` / `requireAdminSession` have zero call sites; `lib/admin.ts#requireAdmin` throws a bare `Error("UNAUTHORIZED")` that every caller must translate. Plan: Phase 3 replaces all three with the §29.2 guard contracts and deletes the legacy helpers, so there is exactly **one** way to authorize.

### 33.13 Additional hardening requirements for the ticketing build

These are not Phase 0 findings but follow directly from the new attack surface:

| Requirement | Why |
| --- | --- |
| Signed share/PIC cookie (never trusted as an identity) | A cookie value must never unlock data; it is only a hint re-resolved server-side (§14.2) |
| Rate-limit the public availability endpoint | It is a scraping channel for sales velocity (§25.4) |
| No PII in QR, in exports' filenames, or in notification bodies beyond what is necessary | §19.3, §24.5, §22.4 |
| Settlement proof files are private and access-audited | They may show bank account details (§33.6) |
| Check-in token hashing; never store or log the raw token | §19.1, §33.7 |
| Admin must be unable to grant themselves a permission they do not hold | Privilege-escalation guard (§28.3) |
| Money fields are never accepted from a client on any write path | §17.2, §28.3 |
| Every new endpoint is added to the authorization test matrix in the same phase | Freezes the isolation guarantee as the codebase grows |

---

## 34. Legacy Ecommerce Mapping

### 34.1 Entity mapping (brief §34)

Verdicts: **REUSE** (keep, minor change) · **ADAPT** (same concept, different fields/semantics) · **REPLACE** (a new entity takes its role) · **DEPRECATE** (stays temporarily, dies in Phase 14) · **DELETE** (no ticketing meaning; removed later, data not migrated).

| Legacy entity | Verdict | Ticketing entity | Notes |
| --- | --- | --- | --- |
| `User` | **ADAPT** | `User` | Add `platformRole`; keep credentials/OAuth/phone uniqueness. `role` enum values change (see §34.3) |
| `Account`, `VerificationToken` | **REUSE** | unchanged | Auth.js internals |
| `Session` | **DELETE** | — | JWT strategy; the table is never written (Phase 0) |
| `Product` | **REPLACE** | `Event` | Retail fields (`sold`, `rating`, `bestseller`, `isArchived`) have no ticketing meaning |
| `ProductVariant` | **REPLACE** | `TicketType` | `price`+`stock`+identity ≈ `price`+`quota`+identity |
| `Product.category` (free text) | **REPLACE** | `Sport` (controlled master data) | A taxonomy, not a string |
| `Cart`, `CartItem` | **DELETE** | — | Ticket buying is direct; multi-type selection happens on the event page. A hold-style cart is post-MVP and would be a new entity |
| `UserAddress` | **DELETE** | — | Buyer identity is captured on the order (`buyerName/Email/Phone`). No shipping destination exists |
| `Province`, `Regency`, `District`, `Village`, `RajaOngkirRegion` | **DELETE** | — | Pure logistics data |
| `Order` | **REPLACE** | `EventOrder` | Carried over: `orderNumber` (unique, non-guessable), `status`, `paymentStatus`, `paidAt`, `paymentReference`, `subtotal`, `total`, `createdAt`. Dropped: all 13 shipping fields, voucher→coupon rename, affiliate/spin relations |
| `OrderItem` | **ADAPT** | `OrderItem` | **Keep the name/price snapshot pattern** — a genuinely good design worth carrying forward verbatim |
| `Order_status` enum | **REPLACE** | `OrderStatus` | New values; `SHIPPED`/`COMPLETED`/`PROCESSING` dropped, `PENDING_PAYMENT`/`EXPIRED`/`PARTIALLY_REFUNDED` added |
| `Order_paymentStatus` | **REUSE** | `PaymentStatus` | Same values + `PARTIALLY_REFUNDED` |
| `Order_paymentMethod` | **ADAPT** | `PaymentMethod` | `COD` dropped |
| `StoreSetting` | **ADAPT** | `PlatformSetting` | Add fee defaults, reservation TTL, export threshold, settlement cadence. Remove the store's shipping origin |
| `Voucher` (+ `VoucherProduct`, `VoucherCategory`, `VoucherUserUsage`) | **ADAPT** | `Coupon` | Keep quota + `usedCount` + per-user limits + the CAS increment + post-increment re-check (the race-safe idiom). Replace product/category restrictions with event/organizer/sport restrictions |
| `Campaign`, `CampaignProduct`, `CampaignCategory` | **DEPRECATE** | — | Built around product catalogs. Optional event-level promo flags can be modelled directly on `Event` |
| `ProductDiscount` | **DEPRECATE** | — | Superseded by ticket-type pricing/sales windows |
| `FlashSale`, `FlashSalePurchase` | **ADAPT (conceptually)** | `TicketType` sales window + limits | The *primitive* is reused (CAS reservation, per-user limit); the models are not migrated |
| `BulkDiscount` | **DEPRECATE** | — | No equivalent requirement |
| `ShippingDiscount` | **DELETE** | — | No shipping |
| `Promotion` (banner) | **DEPRECATE** | `Event.bannerUrl` + `EventImage` | The banner concept moves onto the event itself |
| `SpinWheelCampaign`, `SpinWheelReward`, `SpinWheelSpin` | **DEPRECATE** | — | **Explicitly excluded from MVP** (§4.3). A large surface (3 models, 4 route areas, checkout participation) for no required outcome |
| `AffiliateProfile` | **REPLACE** | `PICProfile` | The affiliate concept becomes PIC. **No KYC image storage** (§33.2 step 6) |
| `AffiliateKyc` | **DELETE** | — | The source of the Phase 0 critical PII finding; not re-created |
| `AffiliateClick` | **ADAPT** | `PICClick` (lightweight, optional) | Or fold click counting into `PICAttribution.firstTouchAt` evidence. Click records must not store PII |
| `AffiliateConversion` | **REPLACE** | `PICAttribution` + `PICFeeLedger` | One conversion becomes an attribution plus ledger entries — far stronger traceability |
| `AffiliatePayout` | **ADAPT** | `Settlement` (+ `SettlementItem`) | The payout state machine is reused; scope is widened to organizer payouts too |
| `Notification` | **REUSE/ADAPT** | `Notification` (+ `NotificationDelivery`) | `idempotencyKey @unique` is kept; ticket/event/PIC fields added |
| `Broadcast` (+ enums) | **DEPRECATE** | — | Retail segments (BEST_SELLER, BUY_AGAIN, CART_REMINDER) have no ticketing meaning. Event announcements are a notification event, not a campaign |
| `AdminAuditLog` | **ADAPT** | `AuditLog` | Add `actorType`, tenant scope, before/after state (§32.2) |
| `Refund` | **ADAPT** | `Refund` (+ `RefundItem`) | Keep CAS + idempotency; add per-ticket refunds |
| Midtrans remnants (`app/api/payment/midtrans/**`, `lib/types/midtrans.d.ts`, `MidtransItem`, `getEnabledPayments`) | **DELETE** | — | Dead code; only iPaymu is wired |

### 34.2 Service/component disposition (brief §35)

The brief asks for an explicit verdict on the reusable components Phase 0 identified.

| Component | Verdict | Detail |
| --- | --- | --- |
| `app/api/payment/ipaymu/notification/route.ts` | **KEEP (ADAPT)** | The verified verification chain and CAS are preserved; the handler is retargeted to `EventOrder`, extended with the WebhookEvent ledger, quota conversion, and ticket issuance. **Add alongside, do not mutate in place while retail is live** — the legacy order path must keep working until Phase 14 |
| `lib/payment/config.ts` | **KEEP** | Fail-closed environment resolution, credential isolation, base-URL allowlist, frozen config. Reused unchanged |
| `lib/payment/ipaymu.ts` | **KEEP (ADAPT)** | Session creation reused; the item/description builders are retargeted from products to ticket types, and a fee line is added |
| `lib/payment/ipaymu-production.ts` | **KEEP** | Production config validator and safe summary |
| `lib/checkout.ts` | **REPLACE (concept) / KEEP (primitives)** | The 2,775-line retail checkout is **not** extended. The reusable primitives are extracted: batch pricing avoidance, the transactional shape, the CAS reservation idiom, and the rollback-on-failure discipline. New code lives in small, focused modules |
| `lib/order-stock.ts` | **ADAPT** | `releaseStockAndVoucherForOrder` becomes `releaseReservationsForOrder` (quota + coupon) with the same idempotent, transaction-scoped design |
| `lib/refund.ts` | **KEEP (ADAPT)** | CAS transitions, `executeRefundCompletion`, `transitionRefundForWebhook`. Retarget: quota instead of stock, ledger reversal instead of commission cancellation |
| `lib/repay.ts` | **KEEP (ADAPT)** | Eligibility + re-reservation shape; re-price and re-run the quota CAS (§12.4) |
| `lib/notification/*` | **KEEP (ADAPT) + REPLACE (queue)** | Service, provider interface, mock provider, Baileys provider kept; the in-memory queue is replaced by a persistent worker (§21.1) |
| `lib/whatsapp/service.ts` | **KEEP** | Complete session lifecycle already implemented; stays behind the provider boundary |
| `AdminAuditLog` + `lib/admin/audit-log.ts` | **KEEP (ADAPT)** | Extended per §32.2 |
| `lib/rate-limit.ts` | **KEEP (ADAPT)** | Limiter set reused; storage moves to a shared store; `login` is finally wired |
| `lib/voucher.ts` | **ADAPT** | Becomes the coupon engine (event/sport scoping, same quota CAS) |
| `lib/rajaongkir*`, `/api/shipping/**`, tracking routes | **DELETE** | No ticketing meaning (Phase 14; no new dependency in the meantime) |
| `lib/marketing/*` (12 modules) | **DEPRECATE / DELETE** | Only the pricing-batch avoidance idea survives (re-implemented inside ticketing pricing). Overlapping pricing engines (`pricing.ts` vs `batch-pricing.ts`) are deleted, not migrated |
| `lib/affiliate/*` (6 modules) | **REPLACE** | Rewritten as PIC modules; **not** renamed, because the ledger and attribution model differ fundamentally from commission tracking |
| `lib/spin-wheel.ts` | **DEPRECATE** | Out of MVP |
| Upload pipeline (`app/api/admin/upload/route.ts`) | **KEEP (CONSOLIDATE)** | Magic-byte validation, size cap, randomized names kept; duplicate serving route removed; private storage for non-public files |
| `app/api/admin/**` (60 routes) | **MIXED** | Auth/role checks (`user.manage`, settings, audit log) adapted; product/order/shipping/marketing/campaign/spin/affiliate/broadcast routes deprecated then deleted |
| `proxy.ts` | **REPLACE** | Default-deny design (§29.9) |
| `auth.ts`, `types/next-auth.d.ts` | **KEEP (ADAPT)** | Keep Auth.js; widen the role type; fix the dummy hash; add login rate limiting |
| `components/products/*`, `components/cart/*` | **DEPRECATE → DELETE** | Product/cart UI has no ticketing equivalent. The shell components (`Header`, `Footer`, `BottomNavbar`) are **kept** and rebranded |
| `components/ui/Dialog.tsx`, skeletons, `lib/fetchWithRetry.ts`, `lib/app-origin.ts` | **KEEP** | Generic UI/utility primitives |

### 34.3 Role mapping

| Legacy `Role` | Ticketing `platformRole` | Treatment |
| --- | --- | --- |
| `ADMIN` | `ADMIN` | direct |
| `SELLER` | **removed** | Dead in the legacy code (no seller pages exist). Any row holding it must be migrated to `MANAGER` or `CUSTOMER` — `DECISION REQUIRED` — D-57 (which one, per user) |
| `CUSTOMER` | `CUSTOMER` | direct (and the default) |
| `AFFILIATOR` | `PIC` | becomes PIC; requires a `PICProfile` to be created. Affiliates without a profile become `CUSTOMER` |
| *(new)* | `MANAGER` | no legacy equivalent; assigned by an Admin |

### 34.4 Data migration scope

The brief forbids destructive renames. Data migration is therefore **selective and optional**:

| Legacy data | Migrate? | Why |
| --- | --- | --- |
| `User` rows | **Yes** | Identity continuity; passwords/OAuth links must keep working |
| Product/order/cart data | **No** | Historical retail orders are not ticketing orders. Keep the legacy tables readable (or export to an archive) rather than fabricating `EventOrder` rows |
| `StoreSetting` | **Yes** → `PlatformSetting` | Configuration continuity |
| `Payment`-related evidence | **Read-only keep** | Audit/accounting history must remain queryable until the statutory retention period ends. `DECISION REQUIRED` — D-58: retention period and whether historical orders need an archival export before deletion |
| Affiliate data | **No** | Replaced by design; migrating commission history into a fee ledger would create false financial records |
| KTP documents | **Purge** (§33.2) | PII that should never have been in the repository |

---

## 35. Migration Strategy

### 35.1 Principle

The brief forbids direct renames (`Product → Event`, `FlashSale → TicketType`) when they risk breaking existing behaviour. The design therefore follows a four-stage strategy:

```
Stage 1  Existing Ecommerce Domain            (production, untouched)
              +
         New Ticketing Domain               (additive tables, feature-flagged routes)
              ↓
Stage 2  Migration / Transition             (ticketing goes live; retail frozen but serving)
              ↓
Stage 3  Ticketing                           (primary revenue path)
              ↓
Stage 4  Legacy Cleanup                     (retail tables/routes/deps removed)
```

### 35.2 Why not rename in place

| Risk of renaming `Product` → `Event` | Consequence |
| --- | --- |
| Live orders, cart rows and marketing FKs reference `product` | Every FK must be rewritten in the same migration; a partial failure leaves the database unusable |
| Three overlapping migrations already exist for `tiktokPixelId`, and the schema has two stale backup files | Migration drift is already a real risk (Phase 0 R-6); a large rename amplifies it |
| Rollback becomes impossible | A reverse migration of a rename plus data reshaping is not realistically reversible under pressure |
| `Product` has different semantics (rating/sold/bestseller, weight) | A rename would carry dead columns and misleading names into the new domain |
| The legacy store keeps selling during the transition | Renaming breaks revenue during the busiest window |

**Conclusion: additive only.** New tables (`event`, `tickettype`, `eventorder`, `ticket`, …) are created next to the legacy ones. No legacy table is renamed, dropped, or column-mutated during Phases 2–13.

### 35.3 Coexistence rules during the transition

| Rule | Reason |
| --- | --- |
| New tables only — no column added to legacy tables except where explicitly listed (§35.4) | Keeps the legacy app running unmodified |
| Webhook handlers are **added**, not swapped | The legacy `PAY-*` order path must keep settling while retail traffic exists. A dispatcher resolves which handler owns a reference (legacy `PAY-*` vs new `EVT-*` prefix) |
| `EVT-` order-number prefix distinguishes the two order models | Cheap, greppable, and makes accidental cross-model queries obvious |
| Feature flags gate every ticketing surface | Instant rollback without a deploy |
| Retail is frozen (no new features) from Phase 2 | Prevents work moving in the wrong direction |
| Legacy data is never converted, only aged out | Historical retail orders are not ticketing orders |

### 35.4 The only legacy-table touches permitted

| Table | Change | Why it cannot wait |
| --- | --- | --- |
| `user` | Add `platformRole` (or reuse `role` with new values) | Identity and role continuity; every authz path needs it |
| `storesetting` | Add platform-level fee/TTL/threshold fields, or supersede entirely with `platformsetting` | Configuration must exist before Phase 3; superseding the table is preferable (additive, no mutation) |
| `adminauditlog` | Add nullable `actorType`, `organizerId`, `beforeState`, `afterState`, `reason`, `correlationId` | Nullable, additive, backward compatible with the legacy writer |
| `notification` | Add nullable `ticketId`, `eventId`, `organizerId`, `picProfileId`, `recipientType`, `templateKey` | The Phase 0 notification foundation is explicitly reused |

Every change above is nullable and additive, so the legacy application continues to function against the same database.

### 35.5 Deployment and cutover sequence

| Step | Action | Rollback |
| --- | --- | --- |
| 1 | Verify migration state on a **copy** of production (`prisma migrate status`, `migrate diff`) | n/a |
| 2 | Take a full backup with a verified restore test | Restore |
| 3 | Apply additive migrations (`prisma migrate deploy`) in a maintenance window | The migrations only create tables/columns; a rollback drops the new objects |
| 4 | Deploy the application with all ticketing flags **off** | Redeploy the previous build |
| 5 | Create the reference rows (`Organizer`, `Sport` list, `PlatformSetting`) | Data-only; reversible |
| 6 | Enable for a pilot event with a small audience | Disable the flag |
| 7 | Observe: settlement success, issuance count vs paid count, notification delivery, check-in acceptance | Disable the flag; the legacy path is unaffected |
| 8 | Widen to all events | Disable the flag |
| 9 | After the agreed window, run the Phase 14 cleanup as a **separate, reviewed** migration | Restore from backup — this step is deliberately last and least reversible |

### 35.6 Migration-order rationale (dependency analysis, brief §45)

The brief proposes an order and invites a different one if dependencies demand it. The order is confirmed with two adjustments:

| Phase | Brief order | Design order | Change and reason |
| --- | --- | --- | --- |
| 2 | Database foundation | **Database foundation + platform hardening** | Security remediation that is not feature-coupled (S-1 PII purge, `.gitignore`, shared rate-limiter store, `AppError`, `npm audit` in CI) belongs here, because every later phase inherits it. Doing it later means writing thousands of lines on a foundation that must then change |
| 3 | Auth + Organizer + RBAC | **unchanged** | Nothing can be tenant-scoped before this exists. This is the true critical path |
| 4 | Event + Venue + Sport | **unchanged** | |
| 5 | Ticket Type + Quota | **unchanged** | Requires the persistent job runner (reservation reaper) — the runner is delivered here, not later |
| 6 | Customer + Checkout + Order | **unchanged** | Depends on quota and on customer identity |
| 7 | Payment + iPaymu | **unchanged** | Depends on orders AND on the sandbox verification (§31.6) — the verification is a **gate** for this phase, not a parallel task |
| 8 | Ticket + QR | **unchanged** | Depends on settlement |
| 9 | PIC + Fee Ledger | **unchanged** | Depends on paid orders (fees are created at settlement). Note: PIC *attribution* must exist by Phase 6 (it is captured at checkout), so the PICProfile/assignment/attribution entities land in Phase 6 and only the **ledger + dashboard** land in Phase 9 |
| 10 | Dashboard + Reports + Excel | **unchanged** | Depends on orders, fees and (for the attendee export) tickets |
| 11 | Notification WA + Email | **SHOULD MOVE EARLIER (partially)** | E-ticket delivery is part of Phase 8's definition of done — a ticket the buyer cannot receive is not delivered. Recommendation: the **notification foundation + WhatsApp delivery** land in Phase 8, and Phase 11 becomes "Email channel + preferences + operational notifications" |
| 12 | Check-in | **unchanged** | Depends on issued tickets and staff scoping |
| 13 | Platform Admin | **unchanged** | Depends on everything it administers |
| 14 | Legacy Ecommerce Cleanup | **unchanged** | Must be last |

**Two ordering corrections, both driven by "what must exist for the previous phase to be complete":**

1. **PIC attribution entities move up to Phase 6**, because attribution is captured at checkout and cannot be retrofitted onto orders that already exist. Only the fee ledger, fee dashboard and settlement stay in Phase 9.
2. **Notification delivery moves up to Phase 8**, because `TICKET_ISSUED` delivery is the last step of the issuance story. Email and preferences may stay in Phase 11.

Everything else in the brief's order is confirmed: schema → authz → catalog → inventory → checkout → payment → ticket → money → reporting → notification → check-in → admin → cleanup.

### 35.7 Cutover risk controls

| Control | Purpose |
| --- | --- |
| Reference-prefix dispatch (`PAY-` vs `EVT-`) in the webhook | The two order models cannot cross-settle |
| Flags per feature, not one global flag | A problem in check-in does not require disabling sales |
| Reconciliation query: `COUNT(Ticket WHERE orderId = paid order)` vs ordered quantity, run daily during the pilot | Catches any issuance gap immediately |
| Legacy tables remain writable until Phase 14 | The store keeps working if ticketing is disabled |
| Archive/export plan for historical retail orders before any drop | Legal/accounting retention (D-58) |

---

## 36. Index & Constraint Strategy

### 36.1 Index principles

1. **Tenant-leading composites.** Every scoped table's primary access pattern starts with `organizerId` (or `eventId`, which implies the tenant), so a missing scope filter produces a visibly worse query plan rather than a silent leak.
2. **Serves the actual queries, nothing speculative.** Each index below is justified by a named query. Unused indexes cost write throughput on the hot settlement path.
3. **Unique constraints are the last line of financial and admission safety.** Where a business rule must hold under concurrency, it is expressed as a unique key, not only as application logic.
4. **No composite index longer than four columns**; MySQL will not use the trailing columns effectively anyway.
5. **Money/counter writes stay narrow.** The quota CAS touches `tickettype` only, so `tickettype` must have short rows and a minimal index set (it is the highest-contention table).

### 36.2 Constraint register (the invariants that must be impossible to violate)

| # | Invariant | Mechanism | Consequence if violated |
| --- | --- | --- | --- |
| C-01 | `providerEventId` processed once | `WebhookEvent.providerEventId` UNIQUE | Double settlement, double issuance |
| C-02 | One attribution per order | `PICAttribution.orderId` UNIQUE | Fee paid twice, or two PICs paid for one sale |
| C-03 | One fee entry per (order item, type) | `PICFeeLedger.(orderItemId, type)` UNIQUE + `idempotencyKey` UNIQUE | Double fee on webhook retry |
| C-04 | One ticket per sequence slot | `Ticket.(orderItemId, sequenceNo)` UNIQUE | Duplicate issuance beyond the paid quantity |
| C-05 | One admission per ticket | `CheckIn.ticketId` UNIQUE (accepted rows) | Gate bypass by rescanning |
| C-06 | Ticket lookups are unambiguous | `Ticket.ticketCode` UNIQUE, `Ticket.qrTokenHash` UNIQUE | Wrong ticket resolved, or a token collision |
| C-07 | One settlement per payee per period | `Settlement.(payeeType, payeeId, periodStart, periodEnd)` UNIQUE | Double payout of the same money |
| C-08 | One ledger entry per settlement | `SettlementItem.picFeeLedgerId` UNIQUE (non-null) | An entry paid twice |
| C-09 | Exactly one active OWNER per organizer | Application-level (MySQL cannot express it without a trigger); enforced in one transaction + an invariant test | A tenant with no owner, or two owners fighting |
| C-10 | One PIC per (PIC, event) assignment | `PICEventAssignment.(picProfileId, eventId)` UNIQUE | Ambiguous per-event rate resolution |
| C-11 | One membership per (organizer, user) | `OrganizerMember.(organizerId, userId)` UNIQUE | Duplicated permissions with conflicting roles |
| C-12 | Public identifiers are unique | `Event.slug`, `Event.eventCode`, `EventOrder.orderNumber`, `Ticket.ticketCode`, `PICProfile.picCode`, `Settlement.settlementNumber` UNIQUE | Ambiguous routing and reference confusion |
| C-13 | One payment session active per order | Enforced by a transactional check + CAS (MySQL cannot express a partial unique index); an invariant test asserts it | Two simultaneous gateway sessions for one order |
| C-14 | Quota cannot be exceeded | The conditional `UPDATE … WHERE reserved + sold + n <= quota` (§11.2) + an invariant test | Overselling |
| C-15 | A paid order has exactly the paid number of tickets | Issuance inside the settlement transaction + `(orderItemId, sequenceNo)` UNIQUE + a reconciliation query | Paid but ticketless, or over-issued |

### 36.3 Index register by table

**`event`**
| Index | Serves |
| --- | --- |
| `slug` UNIQUE | Public detail routing |
| `eventCode` UNIQUE | Exports/support reference |
| `(status, visibility, startAt)` | The public catalog list (the hottest read) |
| `(organizerId, status, startAt)` | Organizer event list |
| `(sportId, status, startAt)` | Sport filter |
| `(venueId)` | Venue's events |
| optional FULLTEXT `(title, description)` | Text search `q` — `DECISION REQUIRED` D-59: FULLTEXT vs `LIKE`. Recommendation: `LIKE` initially (small dataset, simpler, no index maintenance), revisit with real volume |

**`tickettype`**
| Index | Serves |
| --- | --- |
| `(eventId, isActive, sortOrder)` | Event detail ticket list |
| `(eventId, salesStartAt, salesEndAt)` | Sales-window evaluation |
| `(eventId, name)` UNIQUE (optional) | Duplicate-name guard — D-60 |

**`ticketreservation`**
| Index | Serves |
| --- | --- |
| `(status, expiresAt)` | The reaper's scan (must be highly selective; index the most selective column first in practice) |
| `(orderId)` | Order detail and release-on-cancel |

**`eventorder`**
| Index | Serves |
| --- | --- |
| `orderNumber` UNIQUE | Customer lookup, webhook reference resolution |
| `picAttributionId` UNIQUE | One attribution per order (C-02) |
| `(userId, createdAt DESC)` | "My orders" |
| `(organizerId, status, createdAt DESC)` | Organizer order list (tenant-leading) |
| `(eventId, status)` | Per-event sales |
| `(status, expiresAt)` | The expiry job |
| `(paymentStatus)` | Reconciliation and the attention queue |
| `(picProfileId)` via attribution join — or denormalize `picProfileId` on the order for direct filtering (recommended: denormalize, it is written once and read constantly in PIC dashboards) |

**`ticket`**
| Index | Serves |
| --- | --- |
| `ticketCode` UNIQUE | Manual gate lookup + wallet link |
| `qrTokenHash` UNIQUE | **The scan path — the single most latency-sensitive lookup in the system** |
| `(orderItemId, sequenceNo)` UNIQUE | Issuance idempotency (C-04) |
| `(eventId, status)` | Attendee lists, live counters |
| `(organizerId, status)` | Tenant-scoped attendee queries |
| `(holderUserId, status)` | "My tickets" |
| `(ticketTypeId, status)` | Per-type sales reporting |
| `(eventId, checkedInAt)` | Live check-in counters |

**`checkin`**
| Index | Serves |
| --- | --- |
| `ticketId` UNIQUE | Duplicate prevention (C-05) |
| `(eventId, checkedInAt)` | Live stats, log pagination |
| `(checkedInByUserId, checkedInAt)` | Staff activity |
| `(organizerId, checkedInAt)` | Tenant reporting |

**`picattribution`**
| Index | Serves |
| --- | --- |
| `orderId` UNIQUE | C-02 |
| `(picProfileId, createdAt DESC)` | PIC sales list |
| `(eventId, createdAt)` | Per-event PIC performance |
| `(organizerId, createdAt)` | Tenant aggregation |

**`picfeeledger`** (append-only, high write volume at settlement)
| Index | Serves |
| --- | --- |
| `idempotencyKey` UNIQUE | C-03 |
| `(orderItemId, type)` UNIQUE | C-03 (belt and braces) |
| `(picProfileId, status, createdAt)` | PIC balance and history |
| `(organizerId, createdAt)` | Tenant financial reporting |
| `(settlementId)` | Settlement contents |
| `(settlementId)` UNIQUE where non-null — see C-08 via `SettlementItem` | |
| `(eventId, createdAt)` | Event-level fee reporting |
| `(orderId)` | "Which transactions generated this fee?" |

**`payment`**
| `paymentReference` UNIQUE | Provider reference matching |
| `(orderId, status)` | Active-session resolution (C-13) |
| `(status, expiresAt)` | Expiry job |
| `(externalSessionId)` | Provider callbacks that reference only the session |

**`webhookevent`**
| `providerEventId` UNIQUE | C-01, replay guard |
| `(provider, receivedAt DESC)` | Ops inspection |
| `(processingStatus, receivedAt)` | Failure monitoring |
| `(orderId)` | Order dispute investigation |

**`settlement`**
| `settlementNumber` UNIQUE | Reference |
| `(payeeType, picProfileId, status)` , `(organizerId, status)` | Payee views |
| `(status, createdAt)` | Ops queue |
| period uniqueness | C-07 |

**`notification` / `notificationdelivery`**
| `idempotencyKey` UNIQUE (existing) | Duplicate emit suppression |
| `(notificationId, channel)` UNIQUE | One delivery row per channel |
| `(status, nextRetryAt)` | Worker claim query |
| `(ticketId)` , `(orderId)` , `(picProfileId)` | Support lookups |

### 36.4 Foreign keys and referential rules

- Every relation is a real FK. No "soft link" columns (the legacy `Order.paymentReference`-style loose coupling is kept only where the provider forces it, and is documented as such).
- `Restrict` for financial/evidentiary parents; `Cascade` only for presentation data (§9.2).
- Note for MySQL: `Restrict` prevents accidental deletion but also blocks legitimate cleanup. That is intended — the design has no "delete an order" operation.

### 36.5 Monetary and numeric representation (brief §33)

| Concern | Decision |
| --- | --- |
| Storage type | `Decimal(14,2)` for amounts, `Decimal(14,2)` or `BigInt` for large aggregates if needed. **Never `Float`/`Double`** — binary floating point cannot represent 0.1 exactly and produces cent-level drift that accumulates into ledger disagreements |
| Why not integer cents | IDR has no meaningful subunit in practice, but `Decimal(14,2)` keeps the door open for a currency with cents and matches the existing schema's convention (`Decimal(12,2)` throughout), minimising surprise for anyone reading both schemas |
| Runtime handling | Always Prisma `Decimal` (decimal.js). Never `Number(decimal)` in arithmetic. The legacy code's `Math.round(Number(price))` pattern is acceptable only for whole-rupiah display, never for ledger math |
| Rates | Integer **basis points** (`500` = 5.00%). Avoids decimal-rate drift, is exact, and is trivially serializable. Chosen over `Decimal(5,2)` rates (the legacy convention) because a percentage multiplied by an amount then rounded is exactly where sub-cent disagreements originate |
| Rounding | Half-up to the nearest rupiah at first persistence, once (§17.5) |
| Currency | `currency` column on every monetary row, defaulting to `IDR`. Single-currency MVP, multi-currency not designed |
| Aggregates | Computed in SQL (`SUM(Decimal)` returns a decimal); never summed in JavaScript floats |
| Serialization to JSON | Sent as **strings** (e.g. `"100000.00"`) or as integers-with-explicit-currency, never as JSON numbers, so no client-side float rounding occurs. `DECISION REQUIRED` — D-61: string decimals vs integer rupiah in the API. Recommendation: integer rupiah for IDR-only MVP (unambiguous, matches user expectation), documented as a deliberate API contract |

### 36.6 Soft delete and timestamps

| Entity | Soft delete? | Field | Reason |
| --- | --- | --- | --- |
| `Event` | Yes | `archivedAt` | Needs to disappear from public surfaces while retaining reporting history |
| `Organizer` | Yes | `status = SUSPENDED` | Similar |
| `User` | Yes | `disabledAt` | A user with orders/tickets cannot be hard-deleted; anonymization is the only destructive option (D-62) |
| `TicketType` | Yes | `isActive = false` | Deactivate, never delete (orders reference it) |
| `PICProfile` | Yes | `status = SUSPENDED` | |
| `EventOrder`, `OrderItem`, `Ticket`, `Payment`, `PICFeeLedger`, `Settlement`, `CheckIn`, `AuditLog`, `WebhookEvent`, `Refund` | **No** | — | Financial/evidentiary records are never deleted; they are reversed or voided with a new record |

Every mutable table carries `createdAt` + `updatedAt`; append-only tables carry `createdAt` only (`updatedAt` on an append-only table is a design smell that invites mutation).

---

## 37. Test Strategy

### 37.0 The blocker to fix first

Phase 0 measured the current state: **`package.json` has no `test` script**, `jest.config.js` `testMatch` covers only 5 of 15 test directories, and therefore **~19 of 44 existing test files never run in any configured command** (the unrun set includes `__tests__/checkout/lifecycle.test.ts`, `__tests__/spin-wheel/**`, `__tests__/admin/**`, `__tests__/shipping/**`). One file is excluded explicitly and for no documented reason.

**Requirement: before Phase 2 code is written, add `npm test` (plus a coverage report) and a CI job that runs it.** Writing a new suite on top of a runner that silently skips half the existing tests would institutionalise the problem. `DECISION REQUIRED` — D-63: does the CI test job block deploys, or warn? Recommendation: block (a financial platform with a red suite should not deploy).

### 37.1 Authorization tests (brief §40)

Every scoped endpoint is tested from the *attacker's* perspective. These are the tests that protect the tenant isolation guarantee (§7.4) from regressions.

| # | Test | Expected |
| --- | --- | --- |
| A-01 | Admin attempts to modify a computed ledger entry via the adjustment endpoint | Allowed **only** with `fee.adjust`; produces a NEW entry, never an edit; audited with a reason |
| A-02 | Admin without `fee.adjust` attempts an adjustment | `403 FORBIDDEN`; no ledger row |
| A-03 | Admin attempts to change an order's amount | Route does not exist / `403`; the amount is unchanged |
| A-04 | Admin without `settlement.execute` attempts to execute a settlement | `403`; settlement state unchanged |
| A-05 | PIC A requests PIC B's fees (`/api/pic/fees` with B's identifiers, or a scope-manipulation attempt) | Own scope only; B's rows are absent (**not** an error — the scope filter simply excludes them) |
| A-06 | PIC A requests `/api/pic/sales/{orderNumber}` for an order attributed to B | `404` |
| A-07 | PIC attempts any write to a fee, payment amount or ledger | Route absent → `404`/`405` |
| A-08 | PIC requests another organizer's event data | `404` |
| A-09 | Manager of Organizer A requests Organizer B's orders/events/settlements/attendees/revenue/PICs | `404` for every endpoint |
| A-10 | Manager of Organizer A attempts to export Organizer B's data by tampering with the export filter | The filter is ignored; only A's rows are exported |
| A-11 | Manager attempts `user.manage` / `role.manage` | `403` |
| A-12 | Manager attempts to grant themselves a permission | `403` |
| A-13 | CHECKIN_STAFF scans an event they are not assigned to | `403` |
| A-14 | Revoked membership still holds a previously issued JWT and calls a scoped endpoint | Denied (scope is DB-resolved, §29.7) — the token alone must not grant anything |
| A-15 | Unauthenticated call to every `/api/admin/**`, `/api/pic/**`, `/api/orders*`, `/api/tickets*` route | `401` |
| A-16 | A route added without updating `proxy.ts` | Rejected for unauthenticated callers (default-deny, §29.9) |
| A-17 | Scope-filtered list with `organizerId` in the query string | The parameter is ignored |
| A-18 | Ownership: user A requests user B's order/ticket by `orderNumber`/`ticketCode` | `404` |

### 37.2 Ticket and quota tests (brief §40)

| # | Test | Expected |
| --- | --- | --- |
| T-01 | **Concurrency**: 100 parallel buyers for 50 tickets in one type | Exactly 50 reservations succeed, 50 `SOLD_OUT`; `sold + reserved == 50`; no negative counters |
| T-02 | Two concurrent requests for the last single ticket | Exactly one succeeds |
| T-03 | Multi-type order where one type runs out mid-transaction | Whole order rolls back; no partial reservation remains |
| T-04 | Sold out (`reserved + sold == quota`) | `409 SOLD_OUT` with `ticketTypeId`; no order created |
| T-05 | Per-order limits (`minPerOrder`/`maxPerOrder`, event ceiling) | `409 LIMIT_EXCEEDED` server-side even if the client bypasses the UI |
| T-06 | Sales window not started / already ended | `409 SALES_NOT_OPEN` |
| T-07 | Reservation expires while unpaid | Reaper releases quota within TTL+1min; order `EXPIRED`; `sold` unchanged |
| T-08 | Reaper runs twice concurrently | Idempotent: quota released exactly once |
| T-09 | Payment settles successfully | Quota `reserved → sold`; exactly N tickets `ISSUED` |
| T-10 | Buyer cancels before payment | Quota released; order `CANCELLED`; no tickets |
| T-11 | Refund of 1 of 3 tickets | 1 ticket `REFUNDED`, 2 remain `ISSUED`; order `PARTIALLY_REFUNDED`; quota behaviour follows `returnQuotaOnRefund` |
| T-12 | Refund of all tickets | All `REFUNDED`; order `REFUNDED`; fee fully reversed |
| T-13 | Quota reduced by an organizer below `sold + reserved` | Rejected `CONFLICT` |
| T-14 | Ticket type deactivated mid-sale | New reservations blocked; existing reservations still confirm |
| T-15 | Invariant assertion after every concurrency test | `sold + reserved <= quota` for every ticket type |

### 37.3 Payment and webhook tests (brief §40)

All fixtures derive from a **real recorded sandbox payload** (§31.6), not from a guessed shape.

| # | Test | Expected |
| --- | --- | --- |
| P-01 | Valid webhook, correct signature and amount | Order `PAID`; quota moved; N tickets issued; ledger credits written; 1 `WebhookEvent PROCESSED` |
| P-02 | Invalid signature | `401`; `WebhookEvent(REJECTED_SIGNATURE)`; **no** order/ticket mutation |
| P-03 | Missing signature header | `401`; recorded; no mutation |
| P-04 | Wrong amount | `400`; `WebhookEvent(REJECTED_AMOUNT)`; no mutation |
| P-05 | Duplicate webhook (same `providerEventId`) | `200`; `IGNORED_DUPLICATE`; no second issuance, no second fee |
| P-06 | Replay after 24 h, same payload | Same as P-05 |
| P-07 | Replay with a different event id for an already-paid order | `IGNORED`; order untouched; recorded |
| P-08 | Webhook for a `CANCELLED` order | Order **not** resurrected; tickets **not** issued; the mismatch is recorded and surfaced in the attention queue |
| P-09 | Webhook for an `EXPIRED` order whose quota was released | Same as P-08 (§11.4 paid-but-unfulfillable path) |
| P-10 | Unknown `status_code` | `200`; `IGNORED_UNKNOWN`; no mutation |
| P-11 | Webhook referencing an unknown order | `200` (no provider retry storm); recorded |
| P-12 | Webhook failure mid-transaction (forced error) | Full rollback: no partial issuance, no partial quota move; `WebhookEvent FAILED`; the provider's retry can then succeed |
| P-13 | Concurrent duplicate webhooks (both racing the same `providerEventId`) | Exactly one `PROCESSED`; the other `IGNORED_DUPLICATE` |
| P-14 | Settlement transaction asserts issuance count == paid quantity | Exactly equal |
| P-15 | Provider `pending` status | Order stays `PENDING_PAYMENT`; no tickets |

### 37.4 PIC attribution and fee tests (brief §40)

| # | Test | Expected |
| --- | --- | --- |
| F-01 | PIC link → checkout → payment | One `PICAttribution(LINK)`, finalized at settlement; ledger credits with the resolved rate |
| F-02 | Two PIC links clicked (two tabs), then one order | Exactly one attribution row; single fee |
| F-03 | PIC not assigned to the event, link clicked | No attribution; `source = NONE` semantics (no row) |
| F-04 | Rate resolution order (assignment override > PIC default > organizer > platform) | The most specific rate is used and snapshotted |
| F-05 | Fee recalculation after a rate change | Historical entries unchanged; only new entries use the new rate |
| F-06 | Full refund | A `REVERSED` entry offsets the credit exactly; payable balance returns to zero |
| F-07 | Partial refund | Reversal covers only the refunded quantity, at the original rate snapshot |
| F-08 | Cancellation before payment | No ledger entries exist at all |
| F-09 | Failed payment | No ledger entries; the attribution may remain unfinalized (and must not be payable) |
| F-10 | Duplicate settlement run on the same period | `CONFLICT`; no double payout |
| F-11 | Adjustment entry | New row, reason required, audited; original untouched |
| F-12 | Refund after the fee was already paid | Designated claw-back path (§15.5) behaves as configured (net-off or recovery) |
| F-13 | PIC balance query | `Σ credits − Σ reversals − Σ payouts` matches the ledger exactly |
| F-14 | Self-referral (if disallowed by D-07) | No fee entry; flagged in reporting |
| F-15 | Sum invariant | `Σ PICFeeLedger(EARNED) == EventOrder.picFeeTotal` for random sampled orders |

### 37.5 QR and check-in tests (brief §40)

| # | Test | Expected |
| --- | --- | --- |
| Q-01 | Valid QR, staff has access, ticket `ISSUED` | `200 ACCEPTED`; `CheckIn` row; ticket `CHECKED_IN` |
| Q-02 | Malformed/unknown token | `404 INVALID_TICKET`; no info leakage about why |
| Q-03 | Token for another event | `409 WRONG_EVENT` |
| Q-04 | Ticket `RESERVED` / `REFUNDED` / `VOID` | `409` with the specific reason |
| Q-05 | Already checked in | `409 TICKET_ALREADY_CHECKED_IN` including the original timestamp and staff |
| Q-06 | **Concurrent duplicate scans of the same ticket** | Exactly one `ACCEPTED`; the other a duplicate (database-enforced) |
| Q-07 | Old `qrVersion` token after reissue | `404 INVALID_TICKET` |
| Q-08 | Staff not assigned to the event | `403` |
| Q-09 | Unauthenticated scan | `401` |
| Q-10 | Manual override without a note | `400 VALIDATION_ERROR` |
| Q-11 | Ticket with an open refund request (if D-28 = block) | `409 REFUND_PENDING` |
| Q-12 | Rejected scans are recorded | `CheckIn` rows with the matching `result`, no accepted row |

### 37.6 Export tests (brief §40)

| # | Test | Expected |
| --- | --- | --- |
| E-01 | PIC exports their fee report | Only their rows; columns per §24.2 |
| E-02 | Manager exports transactions | Only their tenant's rows |
| E-03 | Admin without `report.export.financial` | `403` |
| E-04 | Filter correctness (date range across a timezone boundary, event, ticket type, PIC, statuses) | Row set matches an independently computed expected set |
| E-05 | Timezone boundary | A transaction at 23:30 WIB on the `dateTo` day is included |
| E-06 | Large range above the threshold | `202` + `ExportJob`; the job produces an equivalent file |
| E-07 | Filename convention and `Meta` sheet | Matches §24.5 / §24.6 |
| E-08 | Totals in the export equal the ledger/database totals | Exact equality |
| E-09 | Every export writes an audit row | Present, with filters and row count |

### 37.7 Test infrastructure requirements

| Requirement | Detail |
| --- | --- |
| Test database | MySQL (not SQLite) — the design depends on MySQL semantics: `DECIMAL`, `UPDATE … WHERE` row locking, unique-violation behaviour, and the absence of partial indexes (C-13). A SQLite test DB would validate the wrong engine |
| Concurrency tests | Real parallel connections (`Promise.all` over distinct Prisma clients or explicit multi-transaction orchestration), not simulated interleaving |
| Clock control | The reservation reaper and expiry jobs need injectable time |
| Provider stubs | Mock provider for notifications; recorded fixtures for webhooks; a stub gateway client |
| Invariant harness | A shared assertion (`assertQuotaInvariant()`, `assertFeeSumInvariant()`, `assertIssuanceCount()`) run after mutating suites |
| Coverage expectation | Authorization, payment, quota and fee modules: high coverage. Coverage percentage is not the goal; the enumerated cases above are the goal |
| No mocking of the database for financial tests | Money correctness must be proven against real transactional semantics |

---

## 38. Technical Debt Plan

Phase 0 measured: `tsc --noEmit` **clean**, `eslint .` **520 problems (368 errors / 152 warnings)**, no `test` script, ~19 of 44 test files never run, and several very large files. **Nothing is fixed in Phase 1** (brief §39). This section assigns each item to one of the four buckets the brief requires.

### 38.1 Bucket 1 — Must Fix Before Production

Items that are launch-blocking for a financial platform. All are in earlier phases, deliberately.

| ID | Item | Evidence | Phase |
| --- | --- | --- | --- |
| D1-01 | Committed KTP PII purged from the repository **and its history**, and `.gitignore` hardened | Phase 0 S-1 | 2 |
| D1-02 | `npm test` script + CI job running the full suite | `package.json` has no `test`; `jest.config.js` covers 5/15 dirs | 2 |
| D1-03 | Shared error/response layer created (`AppError`, `ErrorCode`) — note it does **not** exist today (see §2 corrections) | 0 `AppError` matches | 2 |
| D1-04 | Login rate limiting wired; dummy bcrypt hash replaced with a real precomputed hash | `rateLimiters.login` unused; `auth.ts` dummy string | 3 |
| D1-05 | Tenant scope layer (`resolveActor`, guards, scope-required repositories) | Phase 0 S-3 | 3 |
| D1-06 | `proxy.ts` default-deny redesign | Phase 0 S-2 | 3 |
| D1-07 | Webhook replay ledger with unique `providerEventId` | Phase 0 S-5 | 7 |
| D1-08 | Sandbox verification of the real callback header set and expiry semantics | Phase 0 S-6 | 7 (gate) |
| D1-09 | zod validation at every new endpoint boundary + allow-listed sort/filter values | Phase 0 S-8 | 3+ (per endpoint) |
| D1-10 | Shared rate-limiting store for login/checkout/payment/scan | Phase 0 S-7 | 2 |
| D1-11 | Quota invariant + concurrency tests green before any sales go live | Phase 0 R-3 | 5 |
| D1-12 | Issuance reconciliation (paid quantity == issued tickets) in place before launch | Phase 0 R-8 | 8 |
| D1-13 | Persistent notification queue (in-memory queue replaced) | Phase 0 P-3 | 8 |

### 38.2 Bucket 2 — Can Fix During Migration

Debt that does not block launch but should be resolved as the relevant area is rebuilt, because the rebuilt area is where the cost is paid anyway.

| ID | Item | Why it can wait for its own phase |
| --- | --- | --- |
| D2-01 | 368 ESLint errors / 152 warnings (mostly `no-explicit-any`, `require()` in scripts) | The new modules are written clean; the count drops naturally as legacy code is deleted. A blanket "fix all lint" pass would touch files slated for deletion |
| D2-02 | `role` typed as `string` in `types/next-auth.d.ts` + pervasive `session.user as any` | Fixed by the RBAC phase, which replaces every call site |
| D2-03 | `xlsx@0.18.5` replacement | Belongs with the export implementation (Phase 10) |
| D2-04 | Duplicate pricing engines (`lib/marketing/pricing.ts` vs `batch-pricing.ts` vs inline logic) | The ticketing pricing module replaces the concept; deleting them happens in cleanup |
| D2-05 | Duplicate upload-serving routes | Consolidated when the event image pipeline is built (Phase 4) |
| D2-06 | Duplicate address namespaces, `/promotions` vs `/promos`, `/` vs `/home` | Zero ticketing impact; removed with the retail surface (Phase 14) |
| D2-07 | Giant page files (`BuyNowPage.tsx` 4,009; `CheckoutPage.tsx` 3,208; `lib/checkout.ts` 2,775) | Not extended; the ticketing equivalents are built modular. Deleted later |
| D2-08 | Dead code (`lib/csrf.ts` helpers, `Session` model, `Role.SELLER`, `/wishlist` guard, `MidtransItem`, `getEnabledPayments`, empty `=`/`toko_backup.sql`, stale `.bak` schemas, root `products.ts`) | Removed in cleanup, except the CSRF/authorization helpers which the RBAC phase supersedes |
| D2-09 | Unused deps (`@google/genai`, `@tanstack/react-query`) | Trivial; remove in Phase 2 housekeeping |
| D2-10 | `console.log` in hot paths; no leveled logger | Introduced alongside the notification work (Phase 8/11) |
| D2-11 | Migration drift (16 migrations, baseline, three `tiktokPixel` migrations, two stale schema files) | Re-baseline on a scratch DB in Phase 2 **before** adding migrations |
| D2-12 | `deploy.sh` not version-controlled | Add during Phase 2 hardening so migration steps are reproducible |
| D2-13 | No `prisma generate` on install (`postinstall`/`prebuild`) | Add in Phase 2 |
| D2-14 | `allowedDevOrigins` internal IPs + tunnel host | Phase 2 |

### 38.3 Bucket 3 — Can Fix After Migration

Real debt with no launch impact and no coupling to the rebuild.

| ID | Item | Rationale for deferral |
| --- | --- | --- |
| D3-01 | Remaining lint warnings in files that survive (shell components, utilities) | Cosmetic after the structural work |
| D3-02 | Test coverage thresholds and mutation testing | Useful, not blocking |
| D3-03 | Observability: structured logging, metrics, tracing, alerting | Phase 13+; the attention queue (D-16 in §28.4) covers the acute operational risk in the meantime |
| D3-04 | Load testing an on-sale burst at production scale | Should happen before the first large event, which may be post-launch |
| D3-05 | Bundle-size work on the shell | Not a correctness concern |
| D3-06 | Dependency freshness sweep and Renovate/Dependabot | After the risky-dep items above |

### 38.4 Bucket 4 — Legacy Cleanup

Deferred to Phase 14 by design (brief §34, §45). Grouped so the deletion can be planned as one reviewed change.

| Group | Content |
| --- | --- |
| Retail domain tables | `product`, `productvariant`, `cart`, `cartitem`, `useraddress`, `province`, `regency`, `district`, `village`, `rajaongkirregion`, `flashsale`, `flashsalepurchase`, `productdiscount`, `bulkdiscount`, `shippingdiscount`, `campaign`, `campaignproduct`, `campaigncategory`, `promotion`, `spinwheel*`, `affiliate*`, `broadcast` |
| Retail order data | `order`, `orderitem`, `voucher*`, `refund` (after archival per D-58) |
| Retail routes | `/api/products*`, `/api/cart*`, `/api/buy-now*`, `/api/rajaongkir*`, `/api/shipping*`, `/api/admin/orders/tracking*`, `/api/admin/reports/excel` (legacy shape), `/api/spin-wheel*`, `/api/affiliate*`, `/api/admin/affiliate*`, `/api/admin/campaigns*`, `/api/admin/discounts*`, `/api/admin/bulk-discounts*`, `/api/admin/flash-sales*`, `/api/admin/promotions*`, `/api/admin/vouchers*`, `/api/admin/shipping-discounts*`, `/api/admin/broadcasts*`, `/api/admin/whatsapp*`, `/api/payment/midtrans/*` |
| Retail UI | `app/products*`, `app/cart`, `app/buy-now`, `app/checkout/*` (legacy), `app/orders/*` (legacy), `app/addresses*`, `app/affiliate*`, `app/campaigns`, `app/promotions`, `app/promos`, `app/flash-sales`, `app/spin-wheel*`, `components/products/*` (except shell), `components/cart/*`, `components/order` timeline, `components/VoucherPickerModal`, `components/admin/*` product/campaign/spin/affiliate panels |
| Dependencies | `xlsx` (if replaced), `leaflet`/`react-leaflet` (maps were only used for address picking), `swiper` (if banners are reimplemented), `recharts` (only if no ticketing chart uses it), `@whiskeysockets/baileys` (retained if WhatsApp remains) |
| Scripts/artifacts | `scripts/test-ipaymu-*.js`, `scripts/dbcheck.ts`, `scripts/dbg.ts`, `scripts/affiliate-*`, `scripts/backfill-commission-completed.ts`, `prisma/seed-regions.*`, `prisma/schema.prisma.bak`, `prisma/schema.after-pull.prisma`, `products.ts`, `=`, `toko_backup.sql`, `AUDIT-REMEDIATION-REPORT.md` (archive, do not delete — historical record) |

**Cleanup preconditions (all must hold before Phase 14 executes):**

1. No route, service, component or query references a retail entity (grep + build verification).
2. Historical retail orders are exported/archived per the retention decision (D-58).
3. A full backup with a **tested** restore exists.
4. The cleanup migration is reviewed as its own change, with a documented one-way door.
5. No analytics report or export still consumes retail data.

### 38.5 Debt deliberately accepted in the new design

Honesty about the trade-offs taken, so they are not rediscovered as surprises:

| Accepted debt | Why acceptable | Exit path |
| --- | --- | --- |
| `organizerId` denormalized on orders/tickets | Single-index tenant queries and fast gate scans; the invariant test guards drift | None needed |
| Scope resolution (memberships) may be cached ≤60 s | Avoids a DB round trip per request | Drop the cache if strict immediacy is required (D-48) |
| No `PICBalance` snapshot table | Simple and always correct; aggregate queries are fast at expected volume | Add a snapshot refreshed by the settlement job if a balance list slows |
| No seat maps | Quantity-based tickets meet the stated requirements | Additive `seat` + unique `(ticketTypeId, seatLabel)` |
| No waiting room | Quota CAS handles the expected load | Add a queue in front of checkout |
| One event per order | Matches how tickets are actually bought | Multi-event orders would need a different pricing/attribution model — explicitly out of scope |
| Two-person settlement control may be a manual process | Volume is low at launch | Automate when volume justifies it |

---

## 39. Decision Required

Nothing in this register is decided by the design. Each item cannot be inferred from the repository or from the given requirements, and each has a concrete architectural consequence. The phase column states where the decision becomes blocking — decisions can be made earlier, but not later.

### 39.1 The thirteen decisions the brief names explicitly

| # | Brief item | ID | The question | Options | Why it cannot be inferred | Blocking phase | Recommendation (not a decision) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | PIC attribution model | **D-01**, **D-04**, **D-06** | How is a sale attributed to a PIC, and for how long does a click claim a sale? | Link-only / order-field-only / hybrid (D-01); first-touch vs last-touch and cookie TTL (D-04); per order vs per line (D-06) | The repository has no PIC concept at all; the legacy affiliate used `AffiliateConversion` (per order) with a click table but no documented window, and no requirement states the window | **Phase 6** (attribution is captured at checkout; entities must exist) | Hybrid (D-01=C): link capture with audited manual fallback; last-touch with a 30-day window (D-04); per order (D-06) |
| 2 | PIC fee model | **D-11**, **D-12**, **D-18** | What is the fee — percentage, fixed per ticket, fixed per order — on what basis, at what value? | PERCENTAGE / FIXED_PER_TICKET / FIXED_PER_ORDER (D-11/D-12); full/partial reversal handling (D-18) | The brief explicitly forbids locking 5% and gives no business value. The legacy `AffiliateProfile.commissionRate` default (5.00) is a retail leftover, not a stated policy | **Phase 9** | PERCENTAGE on GROSS_TICKET_AMOUNT, configurable at 4 levels, `0` until configured (so no accidental fee). Claw-back by net-off with a threshold (D-18) |
| 3 | Fee charged to buyer vs absorbed | **D-22**, **D-23** | Does the buyer pay the platform fee (and/or PIC fee) on top of the ticket price, or does the organizer absorb it? | Pass-to-buyer / absorbed-by-organizer / hybrid per event | No requirement states pricing display policy. The legacy app had no fee concept at all (`grossAmount = subtotal − discount + shipping`) | **Phase 6** (affects the checkout total shown) | Absorbed by the organizer for MVP — the buyer sees the ticket price, which is what the catalog implies. Fields are modelled either way, so switching later is not a migration |
| 4 | iPaymu split settlement capability | **D-20** | Does the account support per-organizer sub-accounts, split rules and a settlement API? | Verified capability / verified absence / cannot verify | **Phase 0 could not verify this** and the brief forbids assuming it. Requires confirmation from the provider (technical + contractual) | **Phase 16 (Settlement)** / immediately for design freeze | Treat as unavailable until proven; build Option C (platform collects, ledger authority, internal settlement) |
| 5 | Organizer settlement model | **D-20**, **D-21** | Platform-collects-then-settles vs gateway-split vs hybrid; and what cadence/holds apply? | Options A/B/C (§16.4); cadence on-demand/weekly/monthly/after-event; hold or no hold | Depends on D-20 and on commercial terms the repository cannot reveal | **Phase 16** | Option C (hybrid/manual execution) with a configurable hold until the event ends |
| 6 | Manager vs Admin exact permission boundary | **D-19**, plus the matrix in §6.2/§6.3 | Which financial actions may a Manager take alone, which need Admin approval, and does Admin hold any financial power by default? | Manager-full/Admin-approve (recommended) vs Admin-full/Manager-limited vs explicit grants for both | The brief states the constraints ("Admin must not freely change fees…"; "Manager handles financial approval") but does not enumerate the boundary | **Phase 3** (the permission map is code) | Manager: prepare/approve/execute settlement, adjust fees, export financials. Admin: users/roles/config by default; financial actions only via explicit `PermissionGrant`; never edits a ledger entry |
| 7 | Customer account requirement | **D-33** | Must a buyer have an account, or is guest checkout allowed (with an email/phone-only ticket)? | Account required / guest allowed with a claimable ticket / guest with a magic link | The legacy app requires an account for checkout, but ticketing commonly allows guest purchase. No requirement states it | **Phase 6** | Account required for MVP (simplest, strongest ownership model, reuses the existing auth); design the ticket so a guest path could be added later without schema change (`holderUserId` is already nullable) |
| 8 | Refund fee treatment | **D-27**, **D-30**, **D-29**, **D-08** | On refund, are the gateway fee and platform fee returned? Is refund allowed after the event starts? Does a refund return quota? | Gateway fee refunded or not; platform fee refunded or not; deadline policy; quota return yes/no | Commercial policy; nothing in the code implies it. The legacy refund reverses the full `order.total` and restores stock, which suggests a full-refund assumption that does not fit ticketing economics | **Phase 9** (policy must be shown at checkout, so it must exist before sales) | Gateway fee non-refundable (matches provider reality); platform fee non-refundable; refund allowed until a configurable deadline (e.g. H-1); quota **not** returned by default (`returnQuotaOnRefund = false`) |
| 9 | Payment gateway fee treatment | **D-22** | Who bears the provider fee, and is it known per transaction? | Platform / organizer / buyer; known per transaction vs estimated | Depends on what the provider reports in the webhook (unverified — §14.3 item 5) | **Phase 7** | Organizer absorbs it (it is a cost of sale), recorded per order from the provider's own figure when available, never estimated into the snapshot |
| 10 | WhatsApp provider / final implementation | **D-37**, **D-35** | Keep the self-hosted Baileys client, or move to an official provider (WhatsApp Cloud API / BSP)? | Baileys (current) / official API / hybrid (Baileys now, migrate later) | The repository shows Baileys is implemented and working; whether that is acceptable for production ticket delivery is a business/risk decision, not a technical one | **Phase 8–11** | Dual-channel (WhatsApp + Email) so a Baileys ban is survivable; evaluate an official provider before scale. Decide `CHECKIN_SUCCESS` messaging (recommend: in-app only) |
| 11 | Email provider | **D-38**, **D-39**, **D-40** | Which email provider, and is email mandatory at launch? | SMTP relay / transactional API / none at launch | No email dependency exists in the repository; no provider is implied anywhere | **Phase 11** (but D-39 by Phase 8) | A transactional API provider on a dedicated subdomain; **email mandatory** for e-ticket delivery because the WhatsApp channel carries ban risk |
| 12 | Venue ownership | **D-64** | Are venues platform-global master data, tenant-owned, or both? | Platform-global only / tenant-owned only / both (global with tenant additions) | The requirement lists venues as event attributes but never says who creates or owns them | **Phase 4** | **Both**: platform-global canonical venues (for consistent city/filter data) plus tenant-private venues for ad-hoc locations (`Venue.organizerId` nullable) — the design already models it this way, but the *permission* to create a global venue must be decided |
| 13 | Event approval / publishing workflow | **D-13**, **D-14** | Do events require platform approval before publishing, and what does unpublishing do to existing sales? | Self-publish / approval required / approval only for new organizers | Unknown whether TinggalKlik.Co curates events or organizers self-serve. This also interacts with D-05 (single vs multi organizer) | **Phase 4** | Self-publish for the platform's own events (TinggalKlik.Co is the organizer during launch); add `PENDING_REVIEW` only if third-party organizers self-onboard. Unpublish hides the event from listings but keeps a read-only page for buyers who already hold tickets |

### 39.2 Full decision register

Grouped by area. "Blocking" = the phase in which the answer becomes required.

**Product & catalog**

| ID | Decision | Options | Blocking | Recommendation |
| --- | --- | --- | --- | --- |
| D-02 | Canonical public URL (`/e/{slug}` vs `/events/{slug}`) | pick one forever | Phase 5 | `/e/{slug}` (short, shareable); 301 any alternative |
| D-03 | Custom share identifier (`Event.shareCode`)? | yes / no | Phase 5 | No for MVP — one public identifier avoids ambiguity; add later if organizers ask |
| D-15 | Expose `remaining` stock publicly? | show exact / show coarse ("last few") / hide | Phase 5 | Show a coarse band ("tersedia" / "terbatas" / "habis") — useful to buyers, unhelpful to competitors reading your sales rate |
| D-45 | Show sold-out ticket types? | show greyed / hide | Phase 5 | Show (reduces support questions, helps buyers pick a tier) |
| D-59 | Search implementation | FULLTEXT / LIKE | Phase 5 | `LIKE` initially |
| D-60 | Unique `(eventId, ticketType.name)`? | yes / no | Phase 2 | Yes — duplicate tier names confuse buyers and reports |

**Event operations**

| ID | Decision | Options | Blocking | Recommendation |
| --- | --- | --- | --- | --- |
| D-05 | Single organizer vs multi-organizer marketplace | single tenant / multi with self-onboarding | Phase 3 | Build the tenant chain for correctness; launch with TinggalKlik.Co as the sole organizer |
| D-13 | Event approval workflow | self-publish / approval / approval for new organizers only | Phase 4 | Self-publish at launch |
| D-14 | Effect of unpublishing | hide from listings + read-only page / hide completely | Phase 4 | Read-only page for existing ticket holders |
| D-64 | Venue ownership | global / tenant / both | Phase 4 | Both (`organizerId` nullable); restrict global creation to Admin |
| D-55 | Strip EXIF from uploaded images? | yes / no | Phase 4 | Yes — a phone photo can carry GPS coordinates |

**Orders, tickets & inventory**

| ID | Decision | Options | Blocking | Recommendation |
| --- | --- | --- | --- | --- |
| D-31 | Pre-create `RESERVED` tickets at checkout, or issue only at settlement? | pre-create / issue-at-settlement | Phase 5 | Issue at settlement (fewer rows, no orphan cleanup); keep `RESERVED` in the enum unused |
| D-08 | Does a refund return quota to sale? | yes / no / configurable per event | Phase 8 | No by default; configurable via `Event.returnQuotaOnRefund` |
| D-09 | Repayment at the original price or re-priced? | original / current | Phase 6 | Re-price with explicit confirmation (the old window may have closed) |
| D-26 | Free (zero-price) ticket types | support via a `FREE` payment path / forbid in MVP | Phase 6 | Support, but every issuance path must remain the single transactional one |
| D-28 | Block check-in for a ticket with an open refund request? | block / allow | Phase 8 | Block and warn the gate |
| D-32 | Store rejected check-in attempts + uniqueness mechanics | nullable `ticketId` + unique / partial unique via a generated column | Phase 2 | Nullable `ticketId` unique + require it for accepted rows |
| D-33 | Customer account required? | account / guest | Phase 6 | Account required (see §39.1 #7) |
| D-61 | API money representation | decimal string / integer rupiah | Phase 6 | Integer rupiah for IDR-only MVP, documented explicitly |

**PIC & money**

| ID | Decision | Options | Blocking | Recommendation |
| --- | --- | --- | --- | --- |
| D-07 | Self-referral fee-eligible? | yes / no / flagged-but-allowed | Phase 9 | No; flag the volume in reporting |
| D-10 | Suspended PIC's unpaid attributed orders | still payable / cancelled | Phase 9 | Cancelled for **unpaid** orders only; paid orders remain payable |
| D-18 | Refund after the fee was already paid | claw back cash / net off next payout / write off | Phase 16 | Net off, with a cash-recovery escalation above a threshold |
| D-19 | Settlement two-person control | always / above a threshold / none | Phase 16 | Always require a different approver than the preparer |
| D-21 | Settlement cadence + hold period | on demand / weekly / monthly / after event; hold or not | Phase 16 | After the event ends (or monthly), with a configurable hold |
| D-22 | Who bears the gateway fee | platform / organizer / buyer | Phase 7 | Organizer |
| D-23 | Who bears the PIC fee | organizer / buyer | Phase 9 | Organizer (it is a cost of sale) |
| D-24 | Who bears a discount | organizer / platform / shared | Phase 10 (coupons) | Organizer |
| D-25 | Proration method (only if an order-level discount ever exists) | largest remainder / proportional | not blocking | Largest remainder (exact sum) |
| D-27 | Gateway fee refunded to the buyer? | yes / no | Phase 9 | No; disclose the policy at checkout |
| D-29 | Refund after the event starts / a deadline | allowed / cut-off at H-n | Phase 9 | Configurable cut-off (default H-1); must be shown at checkout |
| D-30 | Platform fee refunded? | yes / no | Phase 9 | No |
| D-11 | Fee values (platform / organizer / PIC defaults) | numeric business values | Phase 9 | Ship `0` (no fee) until configured — never a silent default |
| D-12 | Fee basis | gross ticket / net after discount / per quantity | Phase 9 | `GROSS_TICKET_AMOUNT` with `PERCENTAGE` |

**Reporting & export**

| ID | Decision | Options | Blocking | Recommendation |
| --- | --- | --- | --- | --- |
| D-41 | Transaction export row grain | order / ticket | Phase 10 | Order grain for finance; a separate attendee export at ticket grain |
| D-42 | Export money format | currency string / numeric | Phase 10 | Numeric (so Excel can sum) + a formatted display column |
| D-43 | Filename platform prefix | with / without | Phase 10 | Without (shorter; the file is already scoped in the app) |
| D-44 | Replace `xlsx@0.18.5`? | replace with `exceljs` / keep | Phase 10 | Replace, with a streaming writer for the background path |
| D-56 | Implement a real CSRF origin check or delete the helper? | implement / delete | Phase 3 | Implement (~10 lines, defence in depth for cookie auth) |
| D-50 | Audit log retention | indefinite for financial rows / bounded | Phase 13 | Indefinite for financial, bounded for operational |
| D-51 | PIC sees raw audit rows about their fees? | yes / derived history only | Phase 9 | Derived fee history only |
| D-34 | Check-in PII retention (`ipAddress`, `deviceId`) | retain indefinitely / bounded window | Phase 12 | Bounded window (e.g. 12 months), Manager/Admin only, excluded from exports |
| D-58 | Retention of historical retail orders | archive then delete / retain indefinitely | Phase 14 | Archive to a file, then delete tables — but only after the statutory period is confirmed with accounting |

**Platform, auth & infrastructure**

| ID | Decision | Options | Blocking | Recommendation |
| --- | --- | --- | --- | --- |
| D-48 | Scope staleness tolerance | ≤60 s cache / strict immediacy | Phase 3 | ≤60 s cache with explicit invalidation on revocation |
| D-49 | Proxy enforces platform-role gating? | yes / auth-only | Phase 3 | Auth-only in the proxy; roles resolved from the DB in the service layer |
| D-53 | Login rate-limit integration point (Auth.js v5 credentials) | inside `authorize()` / wrapping route | Phase 3 | Verify against the installed beta's API, then implement the earliest possible check; must be verified, not assumed |
| D-54 | Introduce a shared rate-limit store (Redis) | Phase 2 / later | Phase 2 | Phase 2 — an on-sale is exactly when per-instance limits fail |
| D-52 | Collect identity documents (KYC) in the new domain? | yes / no | Phase 9 (if yes) | **No.** If later required, private storage + signed URLs + access audit from day one (§33.2) |
| D-57 | Migration target for legacy `SELLER` users | `MANAGER` / `CUSTOMER` | Phase 14 | Per-user review before the migration; default `CUSTOMER` (least privilege) |
| D-62 | User deletion / anonymization policy | hard delete / anonymize | Phase 13 | Anonymize (orders and tickets are evidence); retain a deletion request log |
| D-63 | Does the CI test job block deploys? | block / warn | Phase 2 | Block |
| D-16 | iPaymu `expired` unit semantics | hours / minutes (must be verified) | Phase 7 | Verify in sandbox; derive `Payment.expiresAt` from the same value |
| D-17 | Second payment provider at launch? | yes / no | Phase 7 | No, but keep the provider seam so adding one is not a rewrite |
| D-36 | Notification templates in code or in a table? | code / `NotificationTemplate` table | Phase 8 | Code for MVP (type-safe, reviewable); a table only when non-developers must edit copy |
| D-35 | Send a `CHECKIN_SUCCESS` message to the attendee? | yes / in-app only | Phase 12 | In-app only (message cost with little value) |
| D-37 | WhatsApp: Baileys or an official provider? | Baileys / official / hybrid | Phase 8–11 | Dual-channel so a ban is survivable; evaluate an official provider |
| D-38 | Email provider selection | SMTP / transactional API | Phase 11 | Transactional API on a dedicated subdomain |
| D-39 | Is email mandatory at launch? | yes / no | Phase 8 | Yes (it is the fallback for the WhatsApp risk) |
| D-40 | Provider sandbox available for CI? | yes / no | Phase 11 | If no, keep provider tests to the mock and run one manual sandbox smoke test |

### 39.3 Decisions that gate which phase

```
Before Phase 2 : D-32, D-54, D-60, D-63  (+ security remediation is not a decision, it is a task)
Before Phase 3 : D-05, D-19 (boundary), D-48, D-49, D-53, D-56
Before Phase 4 : D-13, D-14, D-55, D-64
Before Phase 5 : D-02, D-03, D-15, D-31, D-45, D-59
Before Phase 6 : D-01, D-04, D-06, D-09, D-22, D-26, D-33, D-61
Before Phase 7 : D-16, D-17, D-20 (must be answered, even if the answer is "unavailable")
Before Phase 8 : D-08, D-28, D-39, D-46
Before Phase 9 : D-07, D-10, D-11, D-12, D-23, D-27, D-29, D-30, D-51, D-52
Before Phase 10: D-24, D-25, D-41, D-42, D-43, D-44
Before Phase 11: D-35, D-36, D-37, D-38, D-40
Before Phase 12: D-34
Before Phase 13: D-50, D-62
Before Phase 14: D-57, D-58
```

**Nothing in Phase 2 is blocked by an unresolved business decision** — that is why the implementation plan in §40 starts there. The earliest genuinely blocking business decision is D-05/D-19 before Phase 3 (RBAC), and the first commercial decision is D-01/D-04/D-22 before Phase 6 (checkout).

---

## 40. Phase 2 Implementation Plan

### 40.1 Objective

Create the additive database foundation **and** close the platform-level security/compliance items that every later phase would otherwise inherit as permanent debt. Phase 2 delivers **no user-visible ticketing feature**; it makes the foundation safe to build on.

### 40.2 In scope

**A. Security & compliance (from §33, not feature-coupled)**

| # | Task | Verifiable outcome |
| --- | --- | --- |
| A1 | Purge committed KTP/PII from the repository **and history**; harden `.gitignore` (`storage/`, `uploads/`, `data/`); verify by scanning history for image files and the strings `ktp`/`storage/uploads` | A fresh clone contains no PII; the scan returns nothing |
| A2 | Add `npm test` + coverage, fix `jest.config.js` `testMatch` to include all suites, add a CI job that runs tests | `npm test` runs every test file; CI is green/red visibly |
| A3 | Introduce `AppError` + `ErrorCode` + the response envelope helper (**created new — it does not exist today**) | A thrown `AppError` maps to the documented status/code in one place |
| A4 | Shared rate-limit store (Redis-compatible) behind the existing `lib/rate-limit.ts` interface; keep the in-memory fallback for dev | Limits hold across processes; `TRUSTED_PROXY` behaviour preserved |
| A5 | `allowedDevOrigins` moved to environment configuration; tunnel host removed | `next.config.ts` contains no internal addresses |
| A6 | `npm audit` / OSV step in CI | Advisories surface on a pull request |
| A7 | `postinstall`/`prebuild` → `prisma generate`; add `deploy.sh` to version control with an explicit list of migration steps | A fresh clone builds; the deploy procedure is reviewable |
| A8 | Remove unused dependencies (`@google/genai`, `@tanstack/react-query`) | `package.json` has no unused entries |
| A9 | Re-baseline migration state on a scratch DB (`migrate status`, `migrate diff`) before adding anything | A known-good baseline commit/state |

**B. Database foundation (additive only — §35.3)**

| # | Task | Notes |
| --- | --- | --- |
| B1 | New enum types (`OrderStatus`, `PaymentStatus`, `TicketStatus`, `EventStatus`, `EventVisibility`, `PICStatus`, `PICFeeEntryType`, `PICFeeStatus`, `FeeBasisType`, `LedgerDirection`, `SettlementStatus`, `SettlementPayeeType`, `CheckInResult`, `CheckInMethod`, `WebhookProcessingStatus`, `AuditActorType`, `SettlementMethod`, `PICAttributionSource`, `PICAttributionMethod`, `RefundStatus`) | Clean naming; legacy snake-case enums untouched (§8.3) |
| B2 | Tenant entities: `Organizer`, `OrganizerMember`, `StaffEventAssignment`, `PermissionGrant` (optional) | §7 |
| B3 | Catalog entities: `Sport`, `Venue`, `Event`, `EventImage` | §10 |
| B4 | Inventory: `TicketType`, `TicketReservation` | §11 |
| B5 | Ordering: `EventOrder`, `OrderItem` (new table), `Ticket` | §11.5, §12, §19.1 |
| B6 | Money: `Payment`, `PaymentTransaction`, `WebhookEvent` | §13.2, §31.2 |
| B7 | PIC: `PICProfile`, `PICEventAssignment`, `PICAttribution`, `PICFeeLedger` | §14, §15 |
| B8 | Payout: `Settlement`, `SettlementItem` | §16 |
| B9 | Ops: `CheckIn`, `Refund` (new), `RefundItem`, `Coupon` (adapted), `NotificationDelivery`, `AuditLog` (extended), `IdempotencyKey`, `ExportJob` | §18, §19, §21, §30, §32, §33 |
| B10 | Additive legacy touches: `user.platformRole`; nullable `adminauditlog` columns; nullable `notification` columns; `PlatformSetting` | §35.4 — **the only legacy changes permitted** |
| B11 | All indexes and unique constraints from §36.2/§36.3 | The invariants are the deliverable |
| B12 | Seed data: the `Sport` list, one `Organizer` (TinggalKlik.Co), `PlatformSetting` defaults (reservation TTL, export threshold, fee rate `0`) | Idempotent seeds |
| B13 | Migration review: verify every statement is additive (`CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN NULL`) — no `DROP`, no `MODIFY` on an existing column | Reviewable as one change |

**C. Cross-cutting scaffolding (no features yet)**

| # | Task |
| --- | --- |
| C1 | `lib/authz/*` contract implementation skeleton (resolver + guards) **without** any feature route — required before Phase 3 features, so its tests land early |
| C2 | `proxy.ts` default-deny redesign + the "unlisted route is rejected" test (§29.9) |
| C3 | zod request-parsing helper + the standard envelope serializer |
| C4 | Persistent job runner skeleton (single-flight, CAS-claimed) with one no-op job, plus the manual trigger endpoint |
| C5 | Invariant test harness (`assertQuotaInvariant`, `assertFeeSumInvariant`, `assertIssuanceCount`) |
| C6 | MySQL test database provisioning for the suite |

### 40.3 Out of scope for Phase 2

No event CRUD, no checkout, no payment changes, no ticketing UI, no PIC dashboard, no check-in. Any of those appearing in a Phase 2 diff is a scope violation, because they depend on RBAC (Phase 3) which does not exist yet.

### 40.4 Files and areas affected

| Area | Change |
| --- | --- |
| `prisma/schema.prisma` | Added models/enums (additive) |
| `prisma/migrations/**` | One or more new additive migrations |
| `prisma/seed-*` | Sport/organizer/platform-setting seeds |
| `lib/authz/**` | New (skeleton + tests) |
| `lib/errors/**` | New (`AppError`, `ErrorCode` mapping) |
| `lib/rate-limit.ts` | Storage backend swapped behind the existing interface |
| `lib/prisma.ts` | No behavioural change (connection settings documented) |
| `proxy.ts` | Default-deny rewrite |
| `package.json` / lockfile | `test` script, CI-oriented scripts, dependency removals, `prisma generate` hook |
| `jest.config.js` | `testMatch` corrected; MySQL test setup |
| `.gitignore` | Hardened |
| `.github/workflows/**` | Test job, audit step |
| `next.config.ts` | Environment-driven dev origins |
| `deploy.sh` | Added to version control |
| `.env.example` | New keys documented (`REDIS_URL` semantics, export threshold, reservation TTL, email/WhatsApp provider keys as placeholders) |
| **Not touched** | All existing feature routes, all UI, `auth.ts` behaviour (the login-rate-limit work is Phase 3 per D-53) |

### 40.5 Database impact

New tables only, plus four nullable additive columns (§35.4). No data migration. Estimated shape: ~35 new tables (the entity inventory in §8.1), each with its §36 index set. The migration must be applied in a maintenance window on a backed-up database, and a rollback (drop the new objects) must be documented even though it should never be needed because nothing references them yet.

### 40.6 API impact

None. `/api/**` behaviour is unchanged except the proxy's default-deny tightening, which cannot break existing routes because they are all already covered by the current prefix lists (this must be verified explicitly: enumerate all 115 routes against the new allow-list and assert coverage). That verification is part of the acceptance criteria.

### 40.7 UI impact

None.

### 40.8 Dependencies

| Dependency | Status |
| --- | --- |
| Nothing from Phases 3+ | Phase 2 is the root of the dependency graph |
| Decisions D-32, D-54, D-60, D-63 | To be answered before starting (all are small and technical) |
| A stored-DB credential for the test suite | Required |
| Permission to rewrite git history (A1) | **Requires explicit approval and a coordination plan** — every contributor must re-clone |

### 40.9 Risks

| Risk | Mitigation |
| --- | --- |
| History rewrite disrupts contributors or breaks an existing fork/CI clone | Schedule it, notify, verify by re-cloning and building in CI before merging anything else |
| Migration drift discovered during A9 (the live DB may not match the schema) | Re-baseline on a scratch DB first; never hand-edit migration SQL; take a backup before applying |
| The failing/skipped tests revealed by A2 are numerous | Budget for it: fix or explicitly quarantine each, with a tracked reason — silently deleting failing tests is not acceptable for a financial platform |
| Redis introduces an operational dependency on a single VPS | Health check + graceful fallback to in-memory with a loud warning; document the constraint |
| Scope creep into Phase 3 features | Reviewed against §40.3 explicitly |

### 40.10 Acceptance criteria (what "Phase 2 complete" means)

1. `npx tsc --noEmit` clean.
2. `npm test` exists, runs the entire suite, and is wired into CI.
3. Every new table exists with its documented constraints and indexes; `prisma migrate status` is clean.
4. All §36.2 invariant constraints exist and are asserted by at least one test each.
5. `proxy.ts` is default-deny, and all 115 existing routes are verified to still behave correctly (a coverage test enumerating them).
6. A fresh clone contains no PII; the history scan returns nothing.
7. `AppError`/`ErrorCode` exist and are used by a sample route (adopted incrementally afterwards).
8. No file under `app/**` (excluding `proxy.ts`) or any existing feature route is modified.
9. `git status --short` shows only the intended new/modified files, with the legacy files that were expected to change listed explicitly in the phase report.

### 40.11 Roadmap after Phase 2 (dependency-ordered)

| Phase | Objective | Gate to enter |
| --- | --- | --- |
| 3 | Auth + Organizer + RBAC: `resolveActor`, guards, scoped repositories, proxy hardening, login rate limiting, login-hash fix | Phase 2 accepted |
| 4 | Event + Venue + Sport: CRUD, images (EXIF-stripped, consolidated upload), publish/unpublish, slug/share | D-13, D-14, D-55, D-64 |
| 5 | Ticket type + quota: quota CAS, sales windows, limits, reservation reaper (job runner) | D-02, D-03, D-15, D-31, D-45, D-59 |
| 6 | Customer + checkout + order: pricing, reservations, idempotency, buyer identity, **PIC attribution capture** | D-01, D-04, D-06, D-09, D-22, D-26, D-33, D-61 |
| 7 | Payment + iPaymu: `Payment`, session creation, webhook retarget, `WebhookEvent`, expiry job | D-16, D-17, D-20 answered; sandbox verification done |
| 8 | Ticket + QR + delivery: issuance, tokens, wallet, **notification foundation + WhatsApp delivery** | D-08, D-28, D-39, D-46 |
| 9 | PIC + fee ledger: rate resolution, ledger entries, fee dashboard, reversals | D-07, D-10, D-11, D-12, D-23, D-27, D-29, D-30, D-51, D-52 |
| 10 | Dashboard + reports + Excel | D-24, D-25, D-41, D-42, D-43, D-44 |
| 11 | Email channel + preferences + operational notifications | D-35, D-36, D-37, D-38, D-40 |
| 12 | Check-in: scan chain, duplicate guard, manual override, live counters | D-34 |
| 13 | Platform admin: organizers, sports, venues, transactions, refunds, settlements, settings, audit | D-50, D-62 |
| 14 | Legacy cleanup: remove the retail surface, dependencies and scripts | D-57, D-58; all preconditions in §38.4 |

Each phase ships behind a flag, with its own tests (§37) green before the next begins. **No phase starts before its predecessor is accepted** — the ordering exists because later phases assume earlier invariants (scope, quota, settlement) are already enforced.

---

## 41. Risks & Open Questions

### 41.1 Delivery risks

| # | Risk | Likelihood | Impact | Mitigation in this design |
| --- | --- | --- | --- | --- |
| RK-01 | **Cross-tenant data leak** from a missed scope filter | Medium if built without discipline | Critical | Scope-required repository signatures (a missing filter is a compile error) + a mandatory negative test per scoped endpoint (§37.1) |
| RK-02 | **Overselling** under concurrent purchase | Medium if the CAS idiom is not followed | Critical | Conditional SQL only, never read-then-write; concurrency tests with exact-count assertions (§37.2 T-01) |
| RK-03 | **Paid but ticketless** (expiry race, issuance crash) | Low with the transactional design | High | Issuance inside the settlement transaction + the attention queue for the documented expiry race (§11.4) + a daily reconciliation query |
| RK-04 | **Financial figure disputes** (PIC claims a different fee) | Medium | High | Append-only ledger with snapshotted rate/basis, per-entry idempotency keys, and a PIC-facing history showing every entry and its reason |
| RK-05 | **Gateway capability assumption** (assuming split settlement exists) | High if forgotten | High | Settlement Option C requires no unverified capability; D-20 must be answered regardless (§16.4, §39.1 #4) |
| RK-06 | **WhatsApp channel failure** (ban, RC bug, session loss) | Medium–High | High (delivery) | Dual-channel with Email; the wallet page is always authoritative; provider behind a boundary so a swap is contained (§22, §23) |
| RK-07 | **Migration accident** (destructive rename or a non-additive statement slipping in) | Low with review | Critical | Additive-only rule, an explicit review checklist (B13), a backup with a tested restore, and cleanup deliberately deferred to Phase 14 |
| RK-08 | **QR forgery / ticket fraud** | Low with the design | High | Opaque 32-byte token, hash-only storage, per-ticket revocation, DB-enforced single admission, HMAC never used as the sole control (§19.3) |
| RK-09 | **PII exposure recurrence** (KYC-style documents returning) | Medium if a payout KYC feature is added | Critical | The design deliberately stores no identity documents; if KYC returns, private storage + signed URLs + access audit are prerequisites (§33.2) |
| RK-10 | **Scope creep from the legacy app** (spin wheel/affiliate/broadcast leaking into MVP) | Medium | Medium (delay) | §4.3 exclusion list + §38.4 cleanup bucket + the rule that financing features are estimated from ledger balance, not from legacy behavior |
| RK-11 | **Test debt hides a regression** (CI red/absent) | High today | High | The `npm test` + CI fix is Phase 2 task A2, before any feature code |
| RK-12 | **Single VPS / no read replica** limits the first large on-sale | Medium | Medium | Short transactions, no external calls inside transactions, indexes designed for the read paths, connection limits set explicitly, and a load test before the first big event (Phase 0 P-10) |
| RK-13 | **Decision lateness** (a business decision arrives after its phase) | Medium | Medium–High | §39.3 maps each decision to its blocking phase; Phase 2 is deliberately decision-free so progress can start immediately |
| RK-14 | **PIC attribution disputes with no evidence** | Medium | Medium | Evidence fields on `PICAttribution` (source, method, share token, first/last touch timestamps) + audited manual overrides with a mandatory reason |
| RK-15 | **Refund abuse** (buy, attend, then refund) | Medium | Medium | Refund deadline, ticket voiding on refund, optional check-in blocking for refund-pending tickets (D-28), and staff-approval requirement |

### 41.2 Open questions (beyond the decision register)

These are questions the design raises that are not yet in §39 because they may be answerable by inspection or by the product owner during review:

| # | Question | Who can answer |
| --- | --- | --- |
| OQ-01 | Does a PIC need to see the buyer's name/phone at all (§27.3, D-47)? This is the single largest PIC-privacy question | Product owner |
| OQ-02 | Is the PIC an individual, a community/club, or both? A club may need multiple users under one PIC code | Product owner |
| OQ-03 | Can one PIC be paid to two different bank accounts (e.g. a club and an individual)? Affects `Settlement` snapshotting | Finance |
| OQ-04 | Is there an existing accounting system the exports must feed (a specific column layout/format)? | Finance |
| OQ-05 | Are there tax/faktur requirements on ticket sales or PIC fees that imply extra fields (NPWP, PPN)? | Finance/legal |
| OQ-06 | Does any event type need a different ticket-fulfillment model (e.g. running events with bib numbers, or league passes)? | Product owner |
| OQ-07 | Are spectators/coaches free-entry (implying zero-price types, D-26)? | Product owner |
| OQ-08 | Is multi-day or multi-session admission needed (a pass valid across days)? Affects `TicketType` scoping: per event vs per session | Product owner |
| OQ-09 | Should a PIC be able to see *attributed order counts* and *conversion*, or only money? | Product owner |
| OQ-10 | Who monitors the "paid but unfulfillable" queue operationally, and what is the SLA for resolving it? | Operations |
| OQ-11 | Does the platform need to display organizer branding, or is everything TinggalKlik-branded? | Product owner |
| OQ-12 | What is the volume expectation for the largest on-sale (tickets and concurrent users)? This sizes the load test and whether a waiting room is needed | Product owner/operations |

### 41.3 Assumptions this design makes (stated so they can be falsified)

| # | Assumption | If wrong |
| --- | --- | --- |
| AS-01 | IDR is the only currency for the foreseeable future | The `currency` columns exist, so adding a currency is additive, but multi-currency pricing/settlement/tax would be a design phase of its own |
| AS-02 | One order belongs to one event | Multi-event orders would need a different pricing, attribution and fee-splitting model |
| AS-03 | Buyers are in Indonesia and WhatsApp-first | The dual-channel design already hedges; a primarily non-WhatsApp market would elevate email to primary |
| AS-04 | The platform operates the events (TinggalKlik.Co is the organizer) at launch, with PICs as referrers | If third-party organizers self-onboard, D-05, D-13, D-52 and the per-tenant `PermissionGrant`/settlement design all become immediate requirements |
| AS-05 | Ticket sales happen ahead of the event, not at the gate | Gate sales would need a fast, low-friction purchase path and a different settlement timing |
| AS-06 | MySQL remains the database | The design uses MySQL-specific behaviour (conditional `UPDATE`, unique-violation handling, no partial indexes). A move to Postgres would allow partial unique indexes (simplifying C-13) but is not planned |
| AS-07 | The existing iPaymu account remains usable and its verification behaviour is unchanged | A provider change is isolated behind the §13.5 seam |

---

## 42. Final Architecture Summary

### 42.1 One-paragraph architecture

TinggalKlik.Co becomes a **multi-tenant-ready ticketing platform** whose public surface mirrors an e-commerce catalog (`Event` as the product, `TicketType` as the variant) while its back office is built around **individual tickets, a tenant root, and an append-only financial ledger**. Authentication stays on the existing Auth.js v5 foundation; authorization becomes a single DB-resolved scope layer; the payment spine keeps the Phase 0 verification chain and adds a webhook ledger, quota conversion and transactional ticket issuance; PIC fees are recorded as ledger entries rather than columns; settlement reads that ledger rather than recomputing it. The legacy retail domain stays live but frozen throughout, and is deleted only at the end.

### 42.2 The design in one diagram

```
                         ┌──────────────────── PUBLIC ────────────────────┐
                         │  /api/events  /api/events/{slug}               │
                         │  (published filter, no PII, no raw counters)   │
                         └────────────────────┬───────────────────────────┘
                                              │ checkout
Customer ────────────────────────────────────┼──────────────────────────────┐
                                              ▼                              │
                              ┌── EventOrder (PENDING_PAYMENT) ──┐            │
                              │   TicketReservation (TTL held)   │            │
                              │   PICAttribution (unfinalized)   │            │
                              └───────────────┬──────────────────┘            │
                                              │ Payment session (iPaymu)      │
                                              ▼                               │
   ┌───────────── webhook (signature + amount verified) ──────────────┐       │
   │  1 WebhookEvent(providerEventId UNIQUE)   ← replay guard          │       │
   │  2 CAS order → PAID                       ← terminal states hold   │       │
   │  3 reserved −= n, sold += n               ← quota moved            │       │
   │  4 issue n × Ticket (opaque qrTokenHash)  ← issuance               │       │
   │  5 finalize PICAttribution                                        │       │
   │  6 PICFeeLedger credits (idempotency keys)                        │       │
   │  7 COMMIT  → then notify (persistent queue, idempotent)           │       │
   └───────────────────────────────┬───────────────────────────────────┘       │
                                   │                                           │
        ┌──────────────────────────┴───────────────────────┐                   │
        ▼                          ▼                       ▼                   │
   Ticket wallet            Organizer/Manager          PIC dashboard           │
   (QR display)             (sales, attendees)         (sales, fees, history)  │
        │                          │                       │                   │
        ▼                          ▼                       ▼                   │
   Gate check-in           Refunds (CAS)             Settlement ◄── PICFeeLedger
   (ticketId UNIQUE)       Excel exports (scoped)    (payee: PIC | ORGANIZER)
        │
        └── CheckIn row + AuditLog  →  immutable admission evidence

Tenant scope flows through everything:
   ActorContext(organizerIds, picProfileId, permissions) → guards → services → repositories
   Scope failures return 404.
```

### 42.3 The ten non-negotiable rules

1. **The webhook is the only issuance trigger.** The browser redirect and the polling endpoint never grant a ticket.
2. **Terminal states never resurrect.** A cancelled or expired order cannot become paid; the mismatch is recorded and escalated.
3. **Quota is enforced by conditional SQL**, never by read-then-write.
4. **Every unit is an individually identified, revocable ticket.** No quantity-only fulfilment.
5. **The QR token is opaque, hashed at rest, and revocable per ticket.** No raw token in a QR, a log, a message body or a list endpoint.
6. **Fees are ledger entries, not columns**, and the ledger is append-only. Corrections are new entries.
7. **`organizerId` and `picProfileId` are never taken from a request.** They are resolved from the session and passed explicitly.
8. **No scoped query executes without a scope.** Repositories do not expose unscoped finders.
9. **Every monetary and admission invariant is a database constraint**, not only application logic.
10. **Legacy is deleted last, and only after the new path is proven.**

### 42.4 What changes for each actor, in one line each

| Actor | Before | After |
| --- | --- | --- |
| Customer | Browses products, buys with shipping, tracks a parcel | Browses events, buys tickets, shows a QR at the gate |
| PIC (was Affiliator) | Commission tracked loosely, payout on request, KYC documents uploaded | A data-clean referral code, per-transaction fee ledger, transparent history and settlement status |
| Manager (was `SELLER`, dead) | No working surface existed | Runs events, approves refunds, prepares and approves settlements, exports scoped reports |
| Admin | Everything, implicitly, including money | Users, roles, configuration, moderation — **no implicit financial power**; financial acts require explicit grants and are audited |
| Organizer (new) | Did not exist | The tenant that owns events, orders, revenue and payouts |
| System | Order status webhooks, lossy in-memory queue | Verified settlement + issuance, a persistent job runner, and an operational queue for anomalies |

### 42.5 Deliverables and status of Phase 1

| Item | Status |
| --- | --- |
| Design document | This file (`TICKETING_PHASE1_DESIGN.md`) |
| Source code changes | **None** |
| Schema / migration changes | **None** |
| API / UI / Auth / Payment changes | **None** |
| Files created by Phase 1 | **1** (this document) |
| Files modified or deleted by Phase 1 | **0** |
| Repository baseline preserved | `tsc --noEmit` clean; no new lint findings introduced (no source file changed) |

### 42.6 What happens next

Phase 2 may begin once this document is reviewed. It is deliberately gated on **no business decision** (§39.3), so review can proceed in parallel with foundation work. The two items that need a human decision before they can even be scheduled are the **PII history purge** (requires contributor coordination and explicit approval) and any decision that touches money (§39.1 #1–#4), which must be resolved before Phases 6, 7 and 9 respectively.

**Do not proceed to Phase 2 until this design is reviewed and approved.**

