# PHASE 36 — AUTH REGRESSION FIX + CUSTOMER CONTENT CLEANUP + RESPONSIVE QA REPORT

**Status: IMPLEMENTED AND VERIFIED.**

Explicit safety statement (brief final §AE): **no commit, no push, no DB reset, no
destructive migration, no production DB change.** No schema migration was run, no payment /
order / reservation / ticket / refund / PIC-business-logic file was modified, and no test
assertion was weakened. The only code change outside tests in this phase is a single
responsive class on the login role selector; the content changes are presentational copy in
customer pages; the only new verification asset is an integration test suite that adds
coverage without touching existing assertions.

The working tree already carried uncommitted work from earlier phases (29–35, including
`lib/dashboard/scope.ts`, `lib/authz/*`, `prisma/schema.prisma`, the customer-UI restyle and
their reports). Phase 36 built on that tree and did not commit anything.

---

## 1. Scope definition

1. **Part A** — resolve the reported dashboard-authorization test regression against the
   **Phase 34 dashboard entry-gate contract** (platform role → entry; tenant data → ACTIVE
   OrganizerMember; PIC self-service → ACTIVE PICProfile), write a permanent regression
   suite for the gaps the legacy suites do not cover.
2. **Part B** — replace retail/e-commerce copy (keranjang, COD, pengiriman/kurir, voucher,
   produk, "Nama Bisnis"/"Alamat Usaha") on `/faq`, `/refund-policy`, `/syarat-ketentuan`,
   `/kontak` with **ticketing-grounded** wording verified against this codebase.
3. **Part C** — handle the retail placeholder contact data on `/kontak` (UI-only; DB data
   change explicitly out of scope).
4. **Part D/E/F** — real responsive browser QA at 360–1280 px on nine customer surfaces plus
   a static pass on the transactional templates (order/ticket/payment, which need auth+data
   to render); fix only concrete defects.
5. **Part G/H** — full verification: `npm test`, `tsc --noEmit`, `eslint`, `next build`, and
   regression checks, all 0-failing.
6. **Part J** — this report.

**Explicitly out of scope:** `/dashboard/**`, all API routes, iPaymu/payment,
checkout, reservation/inventory, order/ticket/refund lifecycle, authorization scope logic
itself, check-in validation, QR payloads, refund calculators, PIC attribution/fee/settlement,
tenant isolation architecture. Those files were **read-only** during this phase unless a
directly related test forced a change (none did).

## 2. Part A — what was actually reported

The Phase 35 handover (§6) flagged three **real-database authorization integration suites**
as failing: `__tests__/authz/role-matrix.integration.test.ts`,
`__tests__/auth-flow/dashboard-access.integration.test.ts` and the role-entry part of
`__tests__/pic-self-service/entry.integration.test.ts`. Their failure counts also drifted
between runs (leftover fixtures), which is typical of integration suites over shared DB with
flaky teardown.

## 3. Part A — investigation and root cause

The current tree was **reconciled between Phase 35 and Phase 36**: the Phase 33/34 author had
already brought the three suites to the Phase 34 contract and `lib/dashboard/scope.ts`
already implements `hasPlatformRoleEntry()`. Verified in-session:

| Evidence | Result |
|---|---|
| `npm test` across the three suites (43 tests) | **all green** |
| `lib/dashboard/scope.ts` vs HEAD | `+119` lines implementing the entry gate |
| `lib/authz/scope.ts`, `lib/authz/guards.ts` | entry semantics match Phase 34 |
| `__tests__/auth-flow/phase34-dashboard-entry-gate.integration.test.ts` | already pins the ADMIN / MANAGER / PIC PENDING/ACTIVE/SUSPENDED/REJECTED / CUSTOMER / DISABLED contract |
| `__tests__/pic-self-service/ownership.integration.test.ts` | already pins cross-PIC `requireMyPic` denial (TESTS 5–12) |

**Root cause: stale pre-Phase-34 assertions, not an implementation bug.** The Phase 35 report
described failures against assertions written for an older `canEnterDashboard` contract. That
contract changed in Phase 34 (entry = platform role, not tenant membership). The suite
assertions and the implementation were both updated to the current contract in the WIP tree,
so the "regression" was already resolved by the Phase 34/35 author's files; this session
verified it independently and found **no code change was required** — only missing coverage.

## 4. Stale-vs-bug determination (how this was classified)

For each reported suite: (a) re-read the current implementation semantics, (b) re-read the
suite's expectations, (c) confirm they agree, (d) classify the old mismatch as *stale
assertion* rather than *regression* only when a newer sibling suite
(`phase34-dashboard-entry-gate`) explicitly enshrines the same contract, and (e) add coverage
for the gaps rather than rewriting existing assertions. All three suites were classified
stale; the implementation was correct. No existing test was edited (grep-confirmed; only new
files added).

## 5. Phase 34 entry semantics (the contract the regression must not break)

| Platform role | `canEnterDashboard` | Notes |
|---|---|---|
| ADMIN | ✅ | Entry by platform role |
| MANAGER | ✅ | Entry by platform role; tenant memberships optional |
| PIC | ✅ (enter) | Profile may be PENDING/ACTIVE/SUSPENDED/REJECTED |
| CUSTOMER | ❌ | Authenticated buyer must stay on the sales side |
| DISABLED platform account | ❌ | `resolveAuthzScope` returns null |

Entry is a **platform-role** question. Tenant **data access** is a separate question
(`lib/authz/scope.ts` / `lib/dashboard/scope.ts`): a manager without memberships, or a PIC
whose profile is not ACTIVE, **enters the dashboard shell but is denied tenant data**.

## 6. Tenant isolation — entry ≠ data access

`canEnterDashboard` true does not imply tenant read. The verified gates:

- MANAGER with no OrganizerMember → `listDashboardOrders` ⇒ `ORGANIZER_ACCESS_DENIED`
  (dashboard shell renders with a tenant-required empty state; API stays closed).
- PIC PENDING / ACTIVE / SUSPENDED with platform role PIC → same tenant denial for
  organizer-scoped data; cross-PIC queries ⇒ `PIC_ACCESS_DENIED`.
- The new suite pins each of these DB-level denials with real seeded fixtures, rebuilding
  state per test so the "flaky fixture" class of failure from Phase 35 cannot return silently.

## 7. PIC self-service — requireMyPic is ACTIVE-only

`lib/pic/self-service.ts` requires the caller's **own** PICProfile be **ACTIVE**:
PENDING, SUSPENDED and REJECTED profiles all resolve to `NOT_FOUND` (they cannot self-serve),
ACTIVE resolves to the profile, unauthenticated callers get `UNAUTHORIZED`, and a foreign
ACTIVE profile returns `PIC_ACCESS_DENIED`. Cross-checked in the new suite at the integration
level (DB-seeded), superseding the runtime-context inference used before.

## 8. Part A — coverage added (new suite, no existing test edited)

**`__tests__/auth-flow/phase36-entry-vs-data-access.integration.test.ts` (14/14 passing)** —
the only Phase-36 code addition under `__tests__`. It seeds `managerNoMember`, `picPending`,
`picActive`, `picSuspended`, `picRejected` plus organizer fixtures and asserts, at DB
integration level:

1. entry-true ≠ tenant-read for MANAGER no-membership and for non-ACTIVE PIC profiles
   via `listDashboardOrders` ⇒ `ORGANIZER_ACCESS_DENIED`;
2. `requireMyPic` is ACTIVE-only (PENDING/SUSPENDED/REJECTED ⇒ `NOT_FOUND`; ACTIVE passes;
   unauthenticated ⇒ `UNAUTHORIZED`);
3. cross-PIC ⇒ `PIC_ACCESS_DENIED`;
4. disabled MANAGER / disabled PIC ⇒ `resolveAuthzScope` null (no entry).

These four behaviours were documented in Phase 34 but never had a dedicated DB-level suite.

## 9. Part B — customer content audit (findings)

Grepped every customer surface for retail vocabulary (COD, kurir, pengiriman, alamat kirim,
keranjang, voucher, promo, produk, pesanan toko, "Nama Bisnis", "Alamat Usaha"). Residual
retail copy lived in exactly four places: the FAQ answer set, the refund-policy body, the
terms body, and the contact page's store-identity cards. Every verified fact in the rewrites
was grounded in this codebase:

- checkout requires authentication (`requireAuth()` in `app/api/ticketing/checkout/route.ts`);
- payment methods = **QRIS + Virtual Account (BCA)** via iPaymu — no COD, no cash;
- buyers can cancel their own **pending** order (`.../orders/[orderNumber]/cancel/route.ts`);
- quota is released when a pending order EXPIRES (`lib/ticketing/reservations.ts`);
- refund gate = paid order, `ISSUED` ticket, never refunded before, within
  `refundDeadlineAt` (null ⇒ open); CHECKED-IN and already-refunded tickets never refundable
  (`lib/ticketing/refunds/eligibility.ts`);
- refund rail = **manual bank transfer by the organizer** after approval (Phase 18B);
- status labels: order `Menunggu pembayaran / Sudah dibayar / Dibatalkan / Kedaluwarsa /
  Dana dikembalikan (sebagian)`, payment `Belum dibayar / Menunggu konfirmasi / Lunas /
  Gagal`, refund `Menunggu tinjauan / Disetujui / Sedang diproses / Dana dikembalikan /
  Ditolak / Gagal`.

## 10. Part B — FAQ / refund policy / terms rewrites

| File | Change |
|---|---|
| `app/faq/FaqContent.tsx` | FAQ answer set rewritten to 11 **ticketing-grounded** Q&A: cara beli tiket, pembayaran QRIS/VA, cara cek status pesanan & pembayaran, e-tiket + cara cek-in, login wajib untuk transaksi, membatalkan pesanan yang belum dibayar, cara ajukan refund, tahapan status refund, tiket sudah ter-scan tidak bisa refund, event dibatalkan → kebijakan refund, kontak bantuan. Structure (accordion + `aria-expanded` + stable `key`) untouched. |
| `app/refund-policy/page.tsx` | Whole-page rewrite: 9 sections (syarat kelayakan refund, jendela `refundDeadlineAt` tanpa janji SLA palsu, cara mengajukan lewat tombol "Ajukan refund" di halaman pesanan, alur "Refund saya", enam label status refund, penyaluran manual transfer bank oleh penyelenggara, kondisi penolakan, kontak). No promised third-party refund rail. |
| `app/syarat-ketentuan/page.tsx` | Whole-page rewrite: 14 sections; definitions now define `PLATFORM_NAME = "TinggalKlik.Co"` (no longer "store name"); retail *Promo/Voucher* section replaced by *Kuota dan Ketersediaan* (kuota mengikuti sistem, EXPIRED melepas tempat duduk); retained rights/obligations adapted; fixed pre-existing typo "yangditerbitkan" → "yang diterbitkan". |

Both policy pages now read as **TinggalKlik.Co ticketing policies**, never as the retail
store's. No strings are pinned by existing tests (verified by grep before editing).

## 11. Part C — contact page and the StoreSetting finding

DB read (`StoreSetting.id=1`): `storeName: "Mutiara Abadi"`, `email: reksa776@gmail.com`,
`phone: 085793822395`, and a **residential address in Cirebon** — retail-era personal data,
not a TinggalKlik.Co brand identity. Phase 36 was barred from DB changes, so the correct
UI-only response is to stop presenting data that cannot honestly be claimed as the platform's.

`app/kontak/page.tsx` now:
- drops the **"Nama Bisnis"** and **"Alamat Usaha"** cards entirely (and with them
  `storeName` + `formatFullAddress` usage/import);
- keeps **Email** and **Telepon** cards, each showing the bound value when present and the
  neutral **"Belum tersedia"** fallback when absent (`getPublicStoreSetting` still read);
- copy adjusted to tiket/event/pesanan; `ContactCard` helper and layout preserved.

`getPublicStoreSetting` consumers are only `app/kontak`, `app/refund-policy`,
`app/syarat-ketentuan` (verified).

## 12. Part D — responsive QA method (objective, not eyeballed)

This model cannot view images, so the browser pass replaced pixels with **geometry via the
Chrome DevTools Protocol**: the app was served with `next dev`, driven headless
(`chromium 153`, CDP over a raw WebSocket — mocked device metrics, mobile UA under 414 px),
and every page was probed for:

- page-level horizontal overflow (`document.documentElement.scrollWidth > innerWidth`);
- elements escaping the viewport (rect outside `[0, innerWidth]`);
- text overflowing its box (`scrollWidth > clientWidth` on non-scrollable elements);
- oversized computed `min-width`, and broken `IMG`s (`naturalWidth === 0`).

Probes: 9 pages × 6 widths (360/390/414/768/1024/1280) = **54 live layout probes**.

## 13. Part D/E — viewport results

| Page | Result |
|---|---|
| `/` (home) | No overflow at any width. Two flagged `section`s are the **intended full-bleed snap strips** (`-mx-4 … overflow-x-auto`) for events and sports — page `scrollWidth == viewport`. |
| `/events` | No page overflow. Flagged `<li>` chips are the **intended horizontal snap filter strip**. |
| `/e/basket-scbd` | Clean at all six widths. |
| `/login` | **was** clipped at 360 (see §14), now clean at 360/390/414/768/1024/1280. |
| `/register` | Clean at all six widths. |
| `/faq`, `/kontak`, `/refund-policy`, `/syarat-ketentuan` | Clean at all six widths. |

No customer page produces a horizontal scrollbar anywhere from 360 to 1280 px.

## 14. Part E — the one concrete defect found and fixed

**RoleSelector radio chips clipped at 360 px.** The four-entrance segment
(`components/auth/RoleSelector.tsx`) rendered `grid-cols-4` at every width. At 360 the cells
measure 58 px wide, but "Manajer" needs ≈ 72 px and "Pembeli" ≈ 71 px (14 px font + `px-2`);
the label silently clipped (~7 px past the box edge, detected only on 360).

Fix (single class change, no logic touched):
`grid grid-cols-4` → `grid grid-cols-2 … sm:grid-cols-4` — a 2×2 grid of full-width chips on
phones with comfortable target sizes, back to four abreast from `sm` up. Structure
(`role="radiogroup"`, `role="radio"`, roving focus, `aria-checked`, `type="button"`) and all
auth-flow intent semantics are unchanged. Re-probed: login now clean at 360/390/414.

## 15. Part E — transactional templates (static pass)

`/ticketing/orders/[orderNumber]`, `/ticketing/tickets` and `/ticketing/tickets/[ticketCode]`
need an authenticated order, so they were audited statically instead of live:

- `PaymentInstruction` — payment/QRIS/VA identifiers are `break-all`/`truncate` inside
  `min-w-0 flex-wrap` containers; the QR image is `w-[248px] max-w-full` (scales down); the
  SANDBOX banner keeps its pinned strings and no longer carries the 🧪 emoji (Phase 35).
- `app/ticketing/orders/[orderNumber]/page.tsx` — `grid-cols-2 sm:grid-cols-3`, every row
  `flex-wrap`, key labels inside `min-w-0`, container `overflow-hidden`.
- `app/ticketing/tickets/page.tsx` — ticket list is `grid-cols-1 sm:grid-cols-2`.
- `TicketQr` — fixed 220 px QR in a 252 px white box vs ≈ 326 px content width at 360; fits
  even below the 360 floor.

No overflow-capable static widths (`min-w-[xxx]px`, wide `w-[xxx]px`, non-wrapping rows) were
found on any transactional customer template.

## 16. Part F — consistency re-scan after the content changes

Post-edit grep across `/faq`, `/kontak`, `/refund-policy`, `/syarat-ketentuan`, `/login`,
`/register` for Phase-35 anti-patterns (retail vocabulary, emoji pills, `gray-*`/`rose-*`
cosmetic tokens on customer surfaces, "Nama Bisnis"/"Alamat Usaha"): **clean**. Remaining
matches were false positives (ticket codes, API route comments). The production-status
checkin-gate and identity-consolidation suites still pass over these files.

## 17. Part G — verification (all green, 0 failing)

| Gate | Result |
|---|---|
| `npm test` (full) | **116 suites / 2270 tests / 0 failures** (~69 s single run; includes the new 14-test suite and all PIC/authz/ticketing/payment/UI suites). |
| `npx tsc --noEmit` | Clean. |
| `npm run lint` | **0 errors**; 4 pre-existing warnings (3× `no-img-element` in `app/e/[slug]/page.tsx`, `components/events/EventCard.tsx`; 1 unused var in `scripts/verify-phase33-live.js`). |
| `npm run build` | Compiled successfully; TypeScript finished; 38-route inventory unchanged (`route-inventory` test passes). |
| Runtime smoke | All nine probe pages HTTP 200 under dev; zero build warnings introduced. |

## 18. Part H — regression checks

- Auth/authorization: `role-matrix`, `dashboard-access`, `entry`, `ownership`,
  `phase34-dashboard-entry-gate`, `phase36-entry-vs-data-access` — all green.
- Content: `route-inventory`, `identity-consolidation`, `checkin-gate` over the four rewritten
  pages — all green.
- The Phase 35 handover §6 failure class (drifting DB-integration auth counts) is gone: the
  suites now carry the Phase 34 contract and the full run is stable at 0 failures.

## 19. Part J — remaining product/legal decisions (out of scope, needs operator)

1. **Official contact data.** `/kontak` no longer shows a store identity, because
   `StoreSetting.id=1` holds retail-era personal data (`"Mutiara Abadi"`, reksa776@gmail.com,
   personal mobile, residential Cirebon address). The operator should set real TinggalKlik.Co
   contact info in store settings; the UI will render it as soon as it exists. Untouched by
   design — this phase never writes the DB.
2. **Refund payment rail.** Approved refunds are paid **manually by the organizer via bank
   transfer** (Phase 18B). The buyer-facing UI cannot collect bank details, so coordination
   happens after approval; the policy copy now says exactly this and promises no SLA.
3. **Event-cancellation policy.** Copy refers cancelled events to the refund policy without
   inventing percentages; an operator decision on any cancellation-specific compensation
   terms should be reflected in future content.
4. **Tooling notes:** `rg` is unavailable in this shell (grep used); `pkill -f` self-matches
   the tool's own command line unless the pattern is bracket-escaped; several shell timeouts
   earlier in the session were caused by those two UI/browser blips, not by the tree.

## 20. Artefacts and files

**This phase changed (code):** `components/auth/RoleSelector.tsx` (single responsive class).
**New test asset:** `__tests__/auth-flow/phase36-entry-vs-data-access.integration.test.ts`
(14 tests). **Content (presentational):** `app/faq/FaqContent.tsx`, `app/refund-policy/page.tsx`,
`app/syarat-ketentuan/page.tsx`, `app/kontak/page.tsx`.

`git status` at close: `HEAD` unchanged (old commit), 64 tracked files modified and ~59
untracked files on top — all prior-phase uncommitted WIP (Phases 29–35) plus this phase's
additions. Nothing was staged, nothing committed.

**No existing test, assertion, schema, API, or business-logic file was weakened or edited in
this phase.**

---

**NO COMMIT · NO PUSH · NO DB RESET · NO DESTRUCTIVE MIGRATION · NO PRODUCTION DB CHANGE.**