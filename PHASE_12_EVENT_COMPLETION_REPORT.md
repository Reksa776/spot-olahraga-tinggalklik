# PHASE 12 — EVENT MANAGEMENT COMPLETION REPORT

Project: **TinggalKlik.Co** · Stack: Next.js 16 · React 19 · TypeScript · Prisma 6 · MySQL/MariaDB · NextAuth v5 beta
Date: 2026-09-19 · Author: Buffy (Codebuff)
Scope: event lifecycle completion — archive, cancel, event-form completeness, sales window, max-tickets-per-order, banner, venue, public visibility, authorization, audit, tests.

> No commit. No push. No database reset. No destructive migration. Every change is
> application code in the working tree only. No payment / checkout / refund core logic was
> modified; the only money-path code touched is the *call* into the existing reservation
> release + payment void primitives from the event cancellation, which design §10.3
> explicitly requires.

---

## 1. Executive Summary

Phase 11 left two event features missing and one form incomplete. **All three are now
implemented, authorized, tenant-scoped, transactional, audited and regression-tested:**

| Phase 11 gap | Phase 12 status |
| --- | --- |
| Event archive had no service / API / UI | **COMPLETE** |
| Event cancel had no service / API / UI | **PARTIAL** (state transition + unpaid-order expiry; refund/void effects deferred as product decisions) |
| Event form did not expose `salesStartAt` / `salesEndAt` / `maxTicketsPerOrder` / banner | **COMPLETE** |

No P0 (tenant escape / financial corruption) or P1 (broken lifecycle transaction) defect was
found or introduced. The one commercial invariant that mattered — *cancelling an event must
not let a buyer pay a dead event* — is closed by auto-expiring the event's
`PENDING_PAYMENT` orders through the same primitives and the same per-order transaction shape
the reservation reaper uses.

The parts of design §10.3's cancel effect that are **not** safe to implement without a
product decision (automatic bulk refund, voiding issued tickets, a Finance-approval step)
were deliberately **not** invented; they are documented in §21 with exactly what decision is
needed. That is why cancel is `PARTIAL` rather than `COMPLETE`, and why the final verdict is
`EVENT COMPLETE WITH NON-BLOCKING GAPS` rather than `EVENT COMPLETE`.

Verification: **TypeScript PASS · Jest 51 suites / 1155 tests PASS · Build PASS · ESLint 0
errors / 5 intentional warnings.**

---

## 2. Existing Event Contract (audited before coding)

Sources read, not assumed:

- `TICKETING_PHASE1_DESIGN.md` §10.2 (`Event` fields), §10.3 (`EventStatus` lifecycle table + diagram), §10.4 (`EventImage`), §12.2/§12.3 (order model, used only to understand cancel's commercial effect), §13 (payment).
- `prisma/schema.prisma` — `Event` (`status`, `visibility`, `publishedAt`, `cancelledAt`, `cancelReason`, `archivedAt`, `salesStartAt`, `salesEndAt`, `maxTicketsPerOrder`, `bannerUrl`), `EventStatus`, `EventVisibility`, `OrderStatus`, `RefundStatus`, `TicketStatus`.
- `lib/events/service.ts`, `lib/events/validation.ts`, `lib/events/catalog.ts`, `lib/events/sales-state.ts`, `lib/events/access.ts`, `lib/events/images.ts`.
- `lib/ticketing/checkout.ts`, `lib/ticketing/reservations.ts`, `lib/ticketing/orders.ts`, `lib/ticketing/payment/settlement.ts`, `lib/ticketing/audit-log.ts`.
- `proxy.ts`, `lib/authz/permissions.ts`, existing tests in `__tests__/events/*`, `__tests__/ticketing-checkout/*`.

**Established definitions (no invented semantics):**

| Concept | Contract |
| --- | --- |
| `EventStatus` | `DRAFT, PENDING_REVIEW, PUBLISHED, ONGOING, COMPLETED, CANCELLED, ARCHIVED` (`PENDING_REVIEW` is reserved/unused — D-13 self-publish is LOCKED) |
| `EventVisibility` | `PUBLIC, UNLISTED` reachable; `PRIVATE` reserved and refused at the API edge |
| `archivedAt` | soft delete; hidden from all public surfaces (§10.2) |
| `cancelledAt` / `cancelReason` | event cancellation (§10.2) |
| `publishedAt` | set on **first** publish only |
| `salesStartAt` / `salesEndAt` | event-level **default**; `null` start = immediately after publish, `null` end = until event start |
| sales window | exists on **both** `Event` and `TicketType`; a ticket type's window **overrides** the event's. The single source of truth is the classifier `classifyType` in `lib/events/sales-state.ts`, not a duplicated rule |
| public visibility | one hard-coded `publicVisibilityWhere` (PUBLISHED + PUBLIC + `archivedAt: null` + not past) |
| purchase gate | `isEventPurchasable` (same rule as the catalog's available set) |
| authorization | `requireEventAccess(eventId, perm)` → `requireOrganizerAccess` (DB memberships, fail-closed, cross-tenant = 404) |
| permissions | `event.read`, `event.write`, `event.publish`, `event.banner.upload`, `ticket_type.*`, `venue.manage` |

**Conflicts found (per rule §1) and how they were resolved:**

1. **Archive source states.** Design §10.3's diagram/table allow `COMPLETED/CANCELLED → ARCHIVED`, but no automatic `ONGOING`/`COMPLETED` job exists, so `COMPLETED` is unreachable and a `PUBLISHED` event that has already happened could never be archived. Resolution: archive is permitted from **any non-archived status**, and the one *documented precondition* — “no open refunds/settlements” — is enforced. The widening is recorded as an explicit product decision (§21), not presented as the design's original rule.
2. **Cancel effect list.** §10.3 lists “unpaid orders auto-expire; issued tickets become `VOID`; refund workflow engages (post-MVP automation)”. Implemented: sales stop + unpaid-order expiry. Deferred: ticket voiding and refund automation (they are coupled to a post-MVP workflow and would strand buyers with no refund rail). Documented in §21.
3. **Cancel approval.** §10.3 says “Manager/Admin + Finance approval”; the Phase 3 permission vocabulary has no event-cancel-plus-approval capability. Resolution: gate on the existing `event.publish` lifecycle permission; the approval step is a deferred decision.

---

## 3. Event State Machine

Only transitions the codebase can actually support are marked manual/implemented. `PENDING_REVIEW` exists in the enum but is unreachable by decision D-13.

| FROM | TO | ACTOR / PERMISSION | PRECONDITION | PUBLIC VISIBILITY | ORDER EFFECT | TICKET EFFECT | QUOTA EFFECT | REFUND EFFECT |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| DRAFT | PUBLISHED | `event.publish` (Owner/Manager/Admin+member) | ≥1 active ticket type `quota>0`; `startAt` future; banner recommended | enters catalog (if PUBLIC) | none | none | none | none |
| PUBLISHED | DRAFT (unpublish) | `event.publish` | must be PUBLISHED | leaves listings; direct page = unavailable read-only (D-14) | none | none | none | none |
| PUBLISHED / ONGOING | CANCELLED | `event.publish` | not archived | direct page = unavailable, reason shown; hidden from listings | `PENDING_PAYMENT → EXPIRED` (seats released, payment voided) | **untouched** (deferred) | held seats returned only | **not triggered** (deferred) |
| any non-ARCHIVED | ARCHIVED | `event.publish` | idempotent; no open refund | 404 on every public surface | none | none | none | none |
| DRAFT | *(deleted)* | `event.write` | zero orders, zero tickets | gone | none | none | ticket types cleaned up for FK | none |
| PUBLISHED | ONGOING / COMPLETED | **system job** | time-based | unchanged | — | — | — | — |
| DRAFT | CANCELLED | — | **not allowed** | — | — | — | — | — |
| COMPLETED / CANCELLED | PUBLISHED | — | **not allowed** (guarded) | — | — | — | — | — |
| ARCHIVED | * | — | **terminal** (all mutation guards refuse) | — | — | — | — | — |

**Automatic vs manual:** publish / unpublish / cancel / archive are **manual** (implemented, authorized, audited). `ONGOING` and `COMPLETED` are **time-driven and require a scheduler**; they remain **deferred** (no job runner exists — see §21), which is precisely why archive was widened (conflict #1).

**Where each effect is enforced (one place, not two):**

- public catalog / detail visibility → `publicVisibilityWhere` + `getPublicEventBySlug` (already present)
- ticket sales stop → `isEventPurchasable`, consumed by checkout and the inventory CAS (already present)
- mutation blocking → update/publish/unpublish/delete guards + ticket-type `assertEventEditable` (already present); archive writes the columns they read
- unpaid-order expiry → `cancelEvent` (new), reusing `releaseOrderReservations` + `voidOpenPayments`

---

## 4. Event CRUD Audit

| Operation | UI | API | Service | Authz | Tenant | Validation | Audit | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Create | ✅ | ✅ | ✅ | `event.write` | `requireEventCreate` | strict Zod | `event.create` | COMPLETE |
| Read (list) | ✅ | ✅ | ✅ | `event.read` | membership-filtered | Zod query | — | COMPLETE |
| Read (detail) | ✅ | ✅ | ✅ | `event.read` | `requireEventAccess` | param | — | COMPLETE |
| Update | ✅ | ✅ | ✅ | `event.write` | `requireEventAccess` | strict Zod + sales window | `event.update` | COMPLETE (now exposes all supported fields) |
| Delete (draft only) | ✅ | ✅ | ✅ | `event.write` | `requireEventAccess` | status + history | `event.delete` | COMPLETE (unchanged, still non-destructive to history) |

No change was required to create/read/delete. Update gained the effective sales-window check and the ability to **clear** an optional date (see §9).

---

## 5. Event Lifecycle Audit

| Feature | Before | After |
| --- | --- | --- |
| Publish | COMPLETE | unchanged |
| Unpublish | COMPLETE | unchanged |
| **Cancel** | MISSING | service + API + UI + tests |
| **Archive** | MISSING (columns only) | service + API + UI + tests |
| Auto ONGOING/COMPLETED | MISSING | still missing → deferred (needs a scheduler) |
| Delete (draft) | COMPLETE | unchanged |

---

## 6. Archive Implementation — COMPLETE

`archiveEvent(scope, eventId, request?)` in `lib/events/service.ts`; `POST /api/organizer/events/[id]/archive`; `Arsipkan` action in `EventActions`.

- **Authorization:** `requireEventAccess(eventId, event.publish)` — DB-resolved membership, fail-closed, cross-tenant = 404.
- **Tenant-scoped:** the event's real `organizerId` comes from the guard, never the client.
- **State transition checked:** status CAS `UPDATE … WHERE id AND archivedAt IS NULL`; a second writer loses cleanly.
- **Same-origin:** enforced in the route (`requireSameOrigin`).
- **Validation / idempotency:** no body; archiving an already-archived event returns the row unchanged, keeps the first `archivedAt`, and writes **no** second audit row.
- **Audit:** `event.archive` with before/after and an explicit `dataDeleted: false`.
- **Non-destructive:** no order, ticket, payment, refund or ledger row is written. Verified by test with a live PAID order + ISSUED ticket.
- **Public effect:** 404 on detail (and therefore invisible in the catalog, which filters `archivedAt: null`). Dashboard list still shows ARCHIVED events (history retained).
- **Cannot be re-published / unpublished / updated:** verified by test.
- **Precondition:** refused while a refund is `PENDING`/`APPROVED`/`PROCESSING`, with `details.openRefunds` and `preconditions`.

## 7. Cancel Implementation — PARTIAL (deliberate)

`cancelEvent(scope, eventId, { reason }, request?)`; `POST /api/organizer/events/[id]/cancel`; `Batalkan event` action with a reason dialog.

**Implemented (contract-clear and safe):**

1. **Sales stop immediately.** Status CAS `PUBLISHED|ONGOING → CANCELLED` + `cancelledAt` + `cancelReason`. This single switch is already read by the catalog and by `isEventPurchasable`, so no duplicate rule was added.
2. **Unpaid orders auto-expire.** Every `PENDING_PAYMENT` order of the event is claimed with `UPDATE … WHERE status='PENDING_PAYMENT'`, then its `HELD` reservations are released and any open `Payment` is voided — using `releaseOrderReservations` / `voidOpenPayments` in the same per-order transaction shape as the reaper (order row → reservations → ticket types, the established lock order). A settlement that wins the race is respected and never resurrected.
3. **Audit:** `event.cancel` (with `refundTriggered:false`, `ticketsVoided:false` stated explicitly) + `order.expire` per expired order + `payment.expired` when sessions were voided.
4. **Idempotent** for an already-cancelled event (no second audit row, timestamp preserved).
5. **Refuses** from DRAFT, from ARCHIVED, and cross-tenant.

**NOT implemented (deferred — see §21):** automatic refund (no provider confirmation is fabricated, no `REFUNDED` status is written), voiding issued tickets, and the Finance-approval step. Cancelling **moves no money**.

## 8. Event Form Completion — COMPLETE

`components/organizer/EventForm.tsx` (create + edit) now surfaces the fields the backend already supported:

- `salesStartAt`, `salesEndAt` (datetime-local, with “empty = inherit” hints)
- `maxTicketsPerOrder` (number, 1–50, empty = no ceiling)
- `bannerUrl` (URL, with the catalog's fallback to the first uploaded image explained)

Server authority is preserved: the form still never sends `organizerId` (except as the create target the API authorizes), `status`, `publishedAt`, `sold`, `reserved` or any financial total. The payload uses `null` to clear and omits nothing, so editing cannot silently wipe a field. Client-side: Zod-parity checks (inverted window) for fast feedback, `disabled` while saving, spinner, duplicate-submit prevention, field-scoped error rendering, success notice, responsive grid.

## 9. Sales Window — COMPLETE

- **Model:** the window lives on **both** `Event` (default) and `TicketType` (override). This is the design's model, not a new one, and it is represented correctly in the UI (event window labelled as the default the ticket type may override).
- **Single source of truth:** `classifyType` in `sales-state.ts` is the only implementation; the event form, the ticket-type form, the catalog and checkout all read it.
- **Validation:** schema-level pair rule on create/update (mirrors the ticket-type schema) **plus** a service-level check against the *stored* value, so a one-sided PATCH cannot leave `start > end`.
- **Clearing:** fixed `optionalIsoDateTime` so `null` means “clear” and `undefined` means “leave”. Previously both collapsed to `undefined`, so an organizer could set a window but never remove it.
- **Timezone:** dates are entered as local wall-clock and converted to a full ISO instant (`toIso`) before sending; the server stores instants and renders in `Asia/Jakarta`. No numeric-epoch ambiguity.

## 10. Max Tickets Per Order — ALREADY ENFORCED, NOW FULLY TESTED

`Event.maxTicketsPerOrder` is enforced **server-side** in `createTicketOrder` (`ABOVE_EVENT_MAX_PER_ORDER`) across the sum of all lines, on top of each `TicketType.maxPerOrder`, and again authoritatively by the quota CAS. The frontend never decides. New tests cover `quantity = 0`, negative, `> max`, `= max` (inclusive), `= max + 1`, and — importantly — a split across two lines that sums to the cap (accepted) and one over the cap (refused), proving the cap is per **order**, not per line.

## 11. Banner / Image — COMPLETE

Existing implementation re-audited and unchanged (D-55 pipeline): authorization `event.banner.upload`, event ownership via `requireEventAccess`, MIME allow-list + magic-byte check, size limit (`MAX_EVENT_IMAGE_BYTES`), randomised stored filename with basename-only serving (`/api/uploads/events/[filename]`), delete authorization by `(id, eventId)` pair, row-before-file deletion, max 10 images/event. The event form gained the `bannerUrl` **URL** field (catalog uses `bannerUrl ?? images[0].url`), wiring a column that already existed but was unreachable from the form. Storage architecture was not changed.

## 12. Venue Assignment — COMPLETE (unchanged, re-verified)

`requireVenueRead` enforces D-64: a global venue is readable; another organizer's private venue resolves to 404. Creation/update attach only an authorised venue; a cross-tenant venue id cannot be attached (the event cannot point at another tenant's venue). Not modified in this phase.

## 13. Public Visibility — COMPLETE (consistent across endpoints)

| Status / case | `GET /api/events` (list) | `GET /api/events/[slug]` | `GET /api/events/[slug]/share` |
| --- | --- | --- | --- |
| DRAFT | hidden | available=false, reason | same detail query |
| UNLISTED | hidden | resolves by direct link | same |
| PUBLISHED (PUBLIC) | shown | available=true | same |
| CANCELLED | hidden | available=false, reason | same |
| ARCHIVED | hidden | **404** | same |
| past | hidden | available (end passed) | same |
| PRIVATE | hidden | 404 (reserved) | same |

The share endpoint reuses the detail query, so visibility cannot drift. Payloads remain explicit field maps; no internal id/`organizerId`/counters/audit fields leak.

## 14. Authorization — COMPLETE

Every event mutation uses the existing deciders: create `event.write` + `requireEventCreate`; read/update/delete `event.read`/`event.write` + `requireEventAccess`; publish/unpublish/**cancel**/**archive** `event.publish` + `requireEventAccess`. No hardcoded `ADMIN`, no client-trusted `organizerId`/`status`/ownership. Tests added/covering: ADMIN+ACTIVE membership, MANAGER+ACTIVE membership, PIC/staff (no capability → FORBIDDEN), CUSTOMER (no dashboard), ADMIN without membership (no scope), cross-tenant (404 `ORGANIZER_ACCESS_DENIED`), foreign/nonexistent event id (404), unauthenticated (401).

## 15. Audit Logging — COMPLETE

New actions `event.cancel` and `event.archive` added to the typed vocabulary; `event.create/update/publish/unpublish/delete` unchanged. Every lifecycle mutation writes an `AdminAuditLog` row with actor, `actorOrganizerId`, owning `organizerId`, `entityRef`, before/after, reason and IP/UA. Order/payment side effects of cancellation are recorded as `order.expire` (SYSTEM) and `payment.expired`. The existing defensive key filter still blocks password/token/secret/QR keys — asserted by the existing test.

## 16. Data Consistency — COMPLETE

Verified by test: cancel/archive never decrement `sold` illegally, never change a payment status, never delete a ticket, never change `refundedAmount`, and never create an automatic refund. Cancel's only inventory movement is returning *held* (never sold) quota for expired unpaid orders, in the same transaction as the order status change. `GET /api/organizer/events/[id]` returns an `archivedAt` that matches the row; the public detail is a 404 for an archived event.

## 17. Security Findings

No new P0/P1. The new surfaces were reviewed against the Phase 11 baseline: same-origin enforced, permissions resolved from DB memberships, event id used only as data, statuses not client-forgeable (cancel body accepts only a bounded `reason`; archive accepts no body), CAS transitions on every state change, audit sanitisation intact. The cancellation loop claims each order with a status predicate before touching seats, so it cannot double-release against a concurrent settlement or reaper.

## 18. Tests Added (+26)

| File | Tests | Coverage |
| --- | --- | --- |
| `__tests__/events/lifecycle-validation.test.ts` (new) | 13 | sales window ordering + null/absent, invalid date, `maxTicketsPerOrder` bounds, clear-vs-leave semantics, non-empty update, ownership/status rejection, cancel reason rules |
| `__tests__/events/event-service.integration.test.ts` | +11 | archive (visibility/404, retention, commercial safety, idempotency, open-refund block, cross-tenant/staff/unauth, terminal guards), cancel (status/reason, idempotency, unpaid-order expiry + seat return, paid-order safety, draft refusal, cross-tenant) |
| `__tests__/ticketing-checkout/checkout.integration.test.ts` | +2 | quantity 0/negative schema refusal, event cap inclusive + per-order (split lines) |

Baseline 50 suites / 1129 tests → **51 suites / 1155 tests**, all passing. No test was deleted, skipped or weakened.

## 19. Issues Fixed

| ID | Severity | Fix |
| --- | --- | --- |
| P12-01 | P2 (feature) | Event archive implemented end to end (service/API/UI/tests). |
| P12-02 | P2 (feature) | Event cancel implemented (state + unpaid-order expiry) with no money movement. |
| P12-03 | P2 (feature) | Event form now exposes sales window, max-per-order and banner. |
| P12-04 | P3 (correctness) | Optional dates could be set but never cleared on update (null collapsed to undefined). Fixed with clear-vs-leave semantics. |
| P12-05 | P3 (correctness) | One-sided PATCH could invert the sales window; added the effective-window check. |
| P12-06 | P3 (UX) | Lifecycle buttons are now shown only for applicable states (removed a permanently-disabled unpublish button). |

## 20. Issues Deferred

| ID | Severity | What is missing | Why | Decision needed |
| --- | --- | --- | --- | --- |
| P12-D1 | P2 (product) | Automatic ONGOING/COMPLETED transitions | Time-driven; no scheduler/job runner exists (Phase 11 P11-D6). Inventing one is infrastructure, not event logic. | Whether to add a job runner and the exact auto-transition rules + check-in grace window. |
| P12-D2 | P2 (product) | Cancel → void issued tickets | §10.3 lists it, but voiding a paid ticket without a refund rail strands buyers. | Product decision + refund rail. |
| P12-D3 | P2 (product) | Cancel → bulk refund workflow | §10.2/§10.3 mark it post-MVP; money must not move without provider confirmation. | Whether/when to automate bulk refunds; refund rail (P11-D7). |
| P12-D4 | P3 (product) | Cancel Finance-approval step | No such capability in the Phase 3 vocabulary. | Whether cancellation needs a second approver, and how it is modelled. |
| P12-D5 | P3 (product) | Archive source-state restriction | Design restricts to COMPLETED/CANCELLED, but COMPLETED is unreachable (P12-D1). | Confirm the widened rule (archive any non-archived event) or add the completion job first. |
| P12-D6 | P3 (product) | Show `cancelReason` on the public page | Currently a generic “event dibatalkan” message; reason is stored and audited. | Whether buyers should see the organizer's reason verbatim. |

## 21. Product Decisions Still Needed

1. **Auto-completion job** (enables the design's `COMPLETED` state and its archive path). → P12-D1
2. **Cancellation's money path**: refund automation and ticket voiding, and whether a second (Finance) approver is required. → P12-D2/D3/D4
3. **Archive source states** — accept the widened rule or restrict to `COMPLETED`/`CANCELLED` after the job exists. → P12-D5
4. **Buyer-facing cancellation reason** on the public page. → P12-D6

## 22. TypeScript Result

`npx tsc --noEmit` → **exit 0 (PASS)**.

## 23. Jest Result

`npx jest --runInBand` → **PASS — 51 suites / 1155 tests** (baseline 50 / 1129).

## 24. Build Result

`npm run build` → **exit 0 (PASS)**; both new routes (`/api/organizer/events/[id]/cancel`, `/api/organizer/events/[id]/archive`) are classified as PROTECTED by the `/api/organizer/` prefix and pass the route-classification suite.

## 25. ESLint Result

`npx eslint .` → **0 errors, 5 warnings** (`@next/next/no-img-element`, pre-existing/intentional — P11-D5).

## 26. Final Verdict

**`EVENT COMPLETE WITH NON-BLOCKING GAPS`**

Justification: the event lifecycle that the codebase can support without inventing infrastructure or money behaviour is now complete and safe — CRUD, publish/unpublish, **cancel**, **archive**, delete, ticket type, price/quota, sales window, venue, banner, preview and public visibility, each authorized, tenant-scoped, transactional, audited and regression-tested. No P0/P1 exists; the only remaining gaps are four **product decisions** (auto-completion job, cancellation refund/void policy, cancellation approval, buyer-facing reason), which are documented with the exact decision needed rather than fabricated. Cancel is therefore reported as `PARTIAL` by design, not by omission.
