# PHASE 35 — CUSTOMER-FACING UI MODERNIZATION REPORT

**Status: IMPLEMENTED AND VERIFIED (UI-only).**

Explicit safety statement (brief §AE): **no commit, no push, no DB reset, no destructive
migration, no business data deletion.** No schema, API, authorization, payment, order,
reservation, refund, or PIC logic was touched. Every change is presentational (JSX +
Tailwind) plus a handful of inline-SVG swaps that replace `react-icons` imports in the auth
surface.

The working tree already carried uncommitted work from earlier phases (29–33, including
`lib/dashboard/scope.ts`, `lib/authz/*`, `prisma/schema.prisma` and their reports). Phase 35
did not modify any of that WIP. The full-suite test result below therefore reflects the whole
tree, not just this phase.

---

## 1. Scope definition

Modernize every customer-facing surface toward a single, restrained system:

- plain backgrounds and hairline borders instead of gradients, boxes and shadow-stacks;
- radius normalized to `xl`/`2xl` (no `3xl`, no decorative `rounded-full` on cards/tags);
- shared catalog/chrome surfaces speak `ink`/`brand` only; failure/refund states stay
  semantic (**amber/red/emerald** — never repainted brand);
- content with no data shows the honest placeholder, never a fabricated number.

**Explicitly out of scope:** `/dashboard/**`, all API routes, iPaymu/payment, checkout,
reservation/inventory, order/ticket/refund lifecycle, authorization, and `lib/ticketing/ui/`
formatting helpers (money formatting is byte-identical).

## 2. What was changed (file by file)

### 2.1 Shared discovery primitives

| File | Change |
|---|---|
| `components/events/EventCard.tsx` | Rebuilt: `rounded-xl` card, no gradient wash, no calendar chip over the photo, no image `group-hover:scale`; availability moved beside the price as a text label (`Tiket habis`/`Segera`/`Ditutup`); date + time + venue in one `<dl>`; fallback banner now a quiet `bg-ink-100` with the sport name. The single `<a>` contract, `loading="lazy"`, `alt={title}`, `formatPriceFrom` ("Mulai …"/"Harga menyusul") and badge vocabulary are unchanged. |
| `components/ticketing/SectionHeader.tsx` | Removed the trailing `→` glyph from the "See all" action. |
| `components/ticketing/SportGrid.tsx` | Tile cards flattened: `rounded-xl`, no lift/shadow on hover, tint reduced to a small `h-9` monogram square; `chip` variant untouched. |
| `components/ticketing/EmptyState.tsx` | Dashed card and boxed icon removed; now a quiet centered column (small line icon, message, one next step). |
| `components/ticketing/TicketCard.tsx` | `rounded-xl`, hover ring replaced by a hairline colour change (no translate/shadow); sport label muted from `brand-700 uppercase` to `ink-500`; left tinted date strip kept as the wallet identity anchor. |
| `components/ticketing/StickyBuyBar.tsx` | Dropped the all-caps mini-label; label and price now normal-case muted. `pb-[max(...)]` safe-area and CTA semantics preserved. |
| `components/ticketing/CatalogFilters.tsx` | Panel `rounded-xl`, dropped `shadow-sm`. Controls/form untouched. |
| `components/ticketing/SearchBar.tsx` | Field `rounded-xl`, dropped `shadow-lg`/`shadow-sm` (raised focus ring retained). |

### 2.2 Pages

| File | Change |
|---|---|
| `app/page.tsx` | Hero: decorative `rounded-full` badge → plain text eyebrow; "Populer:" pill chips → underlined text links labelled "Cabang:"; total-events caption toned down; empty-catalog panel flattened (`rounded-xl` white card, no dashed border). |
| `app/events/page.tsx` | No change needed — already on the ink/brand system and clean. |
| `app/e/[slug]/page.tsx` | Documentation panel `rounded-xl` without shadow; removed `→` arrows from action labels; rules panel `rounded-xl`. Hero, D-14 unavailable state and sidebar untouched. |
| `app/ticketing/orders/[orderNumber]/page.tsx` | Receipt card `rounded-3xl shadow-card` → `rounded-2xl shadow-sm`; semantic status colours kept. |
| `app/ticketing/tickets/[ticketCode]/page.tsx` | Ticket article `rounded-3xl shadow-card` → `rounded-2xl shadow-sm` **with all `print:` classes and pinned copy intact**; blocked banner `rounded-2xl` → `rounded-xl`. |
| `components/ticketing/SiteHeader.tsx` | Account dropdown `rounded-2xl shadow-xl` → `rounded-xl shadow-lg`. |
| `components/ticketing/PaymentInstruction.tsx` | Panel `rounded-xl` on white; **removed the 🧪 emoji** from the sandbox banner while keeping the pinned strings `SANDBOX PAYMENT` and `PENDING`. Identifier/QRIS/VA behaviour unchanged. |

### 2.3 Auth surface (react-icons → inline SVG)

| File | Change |
|---|---|
| `components/auth/AuthShell.tsx` | Flat `bg-ink-50/60` (gradient removed); card `rounded-2xl shadow-sm` (was `rounded-3xl shadow-card`); `FaArrowLeft` → inline SVG. |
| `components/auth/LoginForm.tsx` | `FaEnvelope` → inline SVG; `react-icons/fa` import removed. Credentials payload untouched (`signIn("credentials", { identifier, password, redirect: false })`). |
| `components/auth/RegisterForm.tsx` | `FaUser`/`FaEnvelope`/`FaPhone` → inline SVGs; `react-icons/fa` import removed. |
| `components/auth/PasswordField.tsx` | `FaLock`/`FaEye`/`FaEyeSlash` → inline SVGs; `react-icons/fa` import removed. Toggle a11y (`aria-pressed`, `aria-controls`, labels) preserved. |

### 2.4 Info pages (legacy retail UI → shared ticketing chrome)

All four pages are now wrapped in `<SiteShell>` (header/footer + `data-ticketing-shell`), the
`bg-gray-50` retail background is replaced by the ink band + white content, emoji pills
(`❓` `📞` `💰` `📜`) are gone, and every `gray-*`/`rose-*` cosmetic token moved to `ink-*` /
`brand-*`. Page files are unchanged in count — `route-inventory` (38 pages) still passes.
The **body copy is preserved verbatim** (see §7).

| File | Change |
|---|---|
| `app/faq/page.tsx` | Chrome + header band; metadata description de-retailed. |
| `app/faq/FaqContent.tsx` | `FiChevronDown` → inline SVG chevron; `gray-*` → `ink-*`; `rounded-xl`; `aria-expanded` on the toggle; stable `key` (question). FAQ text kept as-is. |
| `app/kontak/page.tsx` | Rebuilt: neutral `bg-ink-100` icon squares with inline SVG icons (replaces 🏪✉️📞📍 boxes in rose/blue/green/amber), `brand-700` links, `ink` text. |
| `app/refund-policy/page.tsx` | Chrome + band; links → `brand-700`; policy text unchanged. |
| `app/syarat-ketentuan/page.tsx` | Same treatment; terms text unchanged. |

## 3. What was deliberately NOT touched

- `app/not-found.tsx`, `app/error.tsx`, `app/global-error.tsx`, `app/ticketing/error.tsx`,
  `components/errors/*` — already minimal and pinned by `error-boundaries`; copy that the
  tests pin was kept untouched.
- `TicketPurchaseForm`, `TicketQr`, order/refund actions, `IssueTicketsButton` — none carry
  the anti-patterns; `checkin-gate`/`wallet-qr` pins left untouched.
- `RoleSelector`, `AuthError`, `TicketStatusBadge`, `GoogleMark` — semantic colors fall
  outside `identity-consolidation`'s chrome set and stay as-is.
- Dashboard, brand lockup (`components/Brand.tsx`), `globals.css` tokens (contract block
  intended to match test expectations byte-for-byte).

## 4. Design tokens used

All new classes come from the existing `ink`/`brand` scales plus semantic exceptions
(`brand-600` CTA, `amber`/`red`/`emerald`/`sky` status). No `gray`/`blue`/`rose` default
Tailwind tokens were introduced anywhere; `identity-consolidation` (P10-5/P10-6) passes.

## 5. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | Clean. |
| `npm run lint` | 0 errors. 4 warnings, all pre-existing and untouched (3× `@next/next/no-img-element` on the `<img>` catalog pattern used since Phase 9; 1 unused var in `scripts/verify-phase33-live.js`). |
| `npm run build` | ✓ Compiled successfully; 28/28 static pages generated; route inventory unchanged. |
| `npm test` (full) | **2234/2236 passing.** All UI/presentation suites green (discovery-render, ui-wiring, wallet-qr-presentation, wallet-views, route-inventory, identity-consolidation, checkin-gate, payment-identifiers, error-boundaries, all auth-flow suites, phase24-headers, shadcn-dashboard, etc.). |
| Runtime smoke (`npm run dev`) | HTTP 200 on `/`, `/events`, `/e/basket-scbd`, `/faq`, `/kontak`, `/refund-policy`, `/syarat-ketentuan`, `/login`, `/register`. Dev log: zero warnings, zero errors, zero hydration/unique-key messages. |

## 6. Pre-existing failures (not caused by Phase 35)

The only failing suites are **real-database authorization integration tests**:
`__tests__/authz/role-matrix.integration.test.ts`,
`__tests__/auth-flow/dashboard-access.integration.test.ts`,
`__tests__/pic-self-service/entry.integration.test.ts`. They assert
`canEnterDashboard(capabilities) === false` for pure PIC/MANAGER, but the uncommitted
Phase 29–33 WIP in `lib/dashboard/scope.ts` made those cases admit entry. They hit the live
MariaDB and their pass/fail count changes between runs with leftover fixtures (one run: 4
suites / 7 tests; next: 1 suite / 2 tests). They are business-logic tests over files Phase 35
must not modify; the fix belongs to the Phase 33/34 author's domain.

## 7. Known remaining residue (recommended follow-up, out of UI scope)

- `/faq` answers and `/refund-policy` + `/syarat-ketentuan` sections still describe the
  **retail flow** (keranjang, COD, pengiriman/kurir, voucher, produk). Copy was preserved
  verbatim per the "restyle-only" rule. Correcting it is a product-copy decision — suggest a
  dedicated content phase with kata per official Kebijakan Refund TinggalKlik.Co.
- `getPublicStoreSetting()` still serves retail placeholder contact data on `/kontak`;
  updating store settings is a data change, not a UI change.
- A visual (browser) pass at 360–1280px is recommended before shipping; this phase
  validated server-rendered HTML and dev-console cleanliness rather than pixels.

## 8. Files changed (Phase 35 only)

`components/events/EventCard.tsx` · `components/ticketing/`{`SectionHeader`, `SearchBar`,
`CatalogFilters`, `SportGrid`, `EmptyState`, `TicketCard`, `StickyBuyBar`, `SiteHeader`,
`PaymentInstruction`}.tsx · `components/auth/`{`AuthShell`, `LoginForm`, `RegisterForm`,
`PasswordField`}.tsx · `app/page.tsx` · `app/e/[slug]/page.tsx` ·
`app/ticketing/orders/[orderNumber]/page.tsx` ·
`app/ticketing/tickets/[ticketCode]/page.tsx` · `app/faq/page.tsx` ·
`app/faq/FaqContent.tsx` · `app/kontak/page.tsx` · `app/refund-policy/page.tsx` ·
`app/syarat-ketentuan/page.tsx`

---

**NO COMMIT · NO PUSH · NO DB RESET · NO DESTRUCTIVE MIGRATION.**