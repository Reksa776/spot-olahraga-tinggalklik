# PHASE 13 — EVENT AUTOMATION + CHECK-IN / ATTENDANCE

**Project:** TinggalKlik.Co · Next.js 16 · React 19 · TypeScript · Prisma 6 · MySQL/MariaDB · NextAuth v5 beta
**Scope of this report:** the gate (check-in/attendance) and the event-automation track.
**No commit, no push, no DB reset, no destructive migration was performed.**

Baseline carried in from Phase 12: 51 suites / 1155 tests PASS · TypeScript PASS · Build PASS · ESLint 0 errors / 5 warnings.

After Phase 13: **53 suites / 1200 tests PASS** · TypeScript PASS · Build PASS · ESLint 0 errors / 5 warnings (the same 5 intentional `<img>` warnings).

---

## 1. Executive Summary

Phase 13 delivered **two of its seven goals** and stopped, deliberately and with evidence, on the rest.

**Delivered — the gate (check-in / attendance).** There was no check-in implementation of any kind before this phase: no route, no module, no component, no attendance record read path. Phase 10 had asserted that absence in a test (`__tests__/ui-consolidation/checkin-gate.test.ts`). Phase 13 opens that gate for the **one credential that provably exists end to end** — the public `Ticket.ticketCode` — and implements the manual-code admission path the design itself provides for exactly this case. The result is a complete, tenant-scoped, idempotent, race-safe admission flow with an attendance view, an audit trail, UI, and 43 new tests (23 static/pure + 20 against the real database).

**Not delivered — event automation (`PUBLISHED → ONGOING`, `ONGOING → COMPLETED`).** Two independent blockers, both documented rather than worked around:

1. **No scheduler infrastructure exists.** No BullMQ, no Redis client, no cron, no node-cron, no worker process, no `vercel.json`, and no `setInterval` outside the in-memory rate limiter. The one reaper that exists (`expireDueReservations`, the reservation expiry body) has **no production caller at all** — only tests call it. The design predicted this ("P-3 | No persistent job runner") and deferred the choice to Phase 2, which never delivered it. The brief's Part D is explicit: do not install new infrastructure silently, and do not use `setInterval` in a request process as a production scheduler.
2. **`ONGOING` has no contract.** It exists in `prisma/schema.prisma` (`DRAFT | PENDING_REVIEW | PUBLISHED | ONGOING | COMPLETED | CANCELLED | ARCHIVED`) but appears in **none** of the design's status tables: the design's `EventStatus` is `DRAFT | PUBLISHED | CANCELLED | COMPLETED | ARCHIVED` and its lifecycle diagram jumps `PUBLISHED ──event passes──> COMPLETED`. Nothing anywhere says what moves an event *into* `ONGOING`, or who may do it. Writing an automated `PUBLISHED → ONGOING` transition would be inventing state semantics, which the brief forbids in as many words.

`COMPLETED` is different: the design *does* specify it (`design §10.3`: "`PUBLISHED → COMPLETED` | System (job, after `endAt`) or Manager | past `endAt` | Sales stop; check-in allowed to continue for a grace window; event remains readable"). It is still not implemented, because it needs the same missing runner **and** a grace-window value the design never states. Both are recorded below as decisions required (§22).

**Nothing in the payment, checkout, refund or inventory core was changed.** The gate touches exactly one ticket row and writes one append-only evidence row; it moves no money, no quota, and no refund.

**FINAL VERDICT: `PHASE 13 COMPLETE WITH NON-BLOCKING GAPS`**, with the automation sub-track explicitly **BLOCKED BY INFRASTRUCTURE DECISION** (§7, §22).

---

## 2. Pre-Implementation Audit

Read before writing any code (Part A):

| Surface | Findings |
|---|---|
| `prisma/schema.prisma` | `EventStatus`, `TicketStatus (RESERVED/ISSUED/CHECKED_IN/VOID/REFUNDED)`, `OrderStatus`, `RefundStatus`, `CheckInMethod (QR_SCAN/MANUAL)`, `CheckInResult (SUCCESS/DUPLICATE/ALREADY_CHECKED_IN/INVALID_TICKET/WRONG_EVENT/UNPAID/TICKET_NOT_FOUND)`, `model CheckIn` (`ticketId String? @unique`), `model StaffEventAssignment` (`@@unique([organizerMemberId, eventId])`, `revokedAt`), `Ticket.qrTokenHash @unique`, `Ticket.checkedInAt`, `Ticket.voidedAt/voidReason` |
| `TICKETING_PHASE1_DESIGN.md` | §10.3 lifecycle table (§7 below), §19.3 QR token + hash, §20 check-in validation chain and "every scan writes a row", §20.2 check 5 (event-scoped capability) and check 6 (single admission), §7.3 rule 4 (staff need an assignment), §29 guard chain, §32.2 audit columns; **P-3 records that no persistent job runner exists** |
| `lib/events/*` | `service.ts` (create/update/publish/unpublish/cancel/archive/delete, Phase 12), `catalog.ts` (public visibility), `sales-state.ts` (pure: `isPurchasable`, per-type sales state), `access.ts` (`requireEventAccess` = narrow ownership read → `requireOrganizerAccess`) |
| `lib/ticketing/*` | `checkout.ts`, `inventory.ts` (CAS), `reservations.ts` (`expireDueReservations`, **uncalled**), `orders.ts`, `payment/*`, `tickets/{issuance,reference,payload,service}.ts`, `refunds/{eligibility,service,settlement}.ts`, `audit-log.ts` |
| Refund policy | Phase 10B: `PENDING → APPROVED → PROCESSING → REFUNDED/FAILED`; **D-R05: a CHECKED_IN ticket is never refundable**; quota returns only on confirmed settlement; iPaymu refunds are UNSUPPORTED and are never faked |
| Authorization | `lib/authz/permissions.ts` (role→permission sets), `guards.ts` (`requireAuth`, `requireOrganizerAccess`: 401 / 404 / 403), `errors.ts` (ORGANIZER_ACCESS_DENIED → **404**) |
| API routes | `app/api/organizer/events/**` (create, publish, unpublish, cancel, archive, images, ticket-types); `proxy.ts` protects `/api/organizer/` |
| Dashboard | `app/dashboard/events/{page,new,[id]}` + `components/organizer/*` (incl. Phase 12 `EventActions`) |
| Customer UI | `app/ticketing/tickets/**` — the wallet + e-ticket that render the QR payload |
| Existing check-in | **Nothing.** No route, module, component, table reader, scanner, attendance view, or check-in timestamp write. `CheckIn` rows could not exist because nothing ever inserted one |

Searches run and their result: `check-in|checkin|CHECKED_IN|scanned|attendance|QR` across `app/`, `lib/`, `components/`, `__tests__/` → only the Phase 10 "gate stayed closed" suite, the `CheckIn` model, the permission keys, and the e-ticket's honest "no validate button" copy.

---

## 3. Current Event State Machine

`CURRENT IMPLEMENTED` (rows are what the code does today, verified against service + routes):

| FROM | TO | TRIGGER | ACTOR / AUTHZ | PRECONDITION | SIDE EFFECT |
|---|---|---|---|---|---|
| — | `DRAFT` | `createEvent` | tenant `event.write` | valid sport/venue/dates | `organizerId`, slug, eventCode generated server-side; `status` and `publishedAt` NOT client-writable |
| `DRAFT` | `PUBLISHED` | `publishEvent` | tenant `event.publish` | active ticket type with `quota > 0`; venue valid | `publishedAt` set; appears in catalog |
| `PUBLISHED` | `DRAFT`-equivalent (unpublish, D-14) | `unpublishEvent` | tenant `event.publish` | — | hidden from listings; read-only page preserved; **orders/tickets untouched** |
| `PUBLISHED`/`ONGOING` | `CANCELLED` | `cancelEvent` (Phase 12) | tenant `event.publish` | — | `cancelledAt` set; sales stop; **PENDING_PAYMENT orders auto-expire** (same reaper primitives, order→reservation→ticket-type lock order); open payments voided; **no refund, no ticket void** |
| any non-`ARCHIVED` | `ARCHIVED` | `archiveEvent` (Phase 12) | tenant `event.publish` | no refund in `PENDING/APPROVED/PROCESSING` | `archivedAt` set (CAS on `archivedAt: null`); hidden from every public surface; **no row deleted** |
| `DRAFT` | (deleted) | `deleteEvent` | tenant `event.publish` | draft-only, no commercial history | hard delete |
| `PUBLISHED` | `ONGOING` | — | — | — | **`DESIGN BUT NOT IMPLEMENTED`** — and undefined in the design (see §7) |
| `PUBLISHED` | `COMPLETED` | — | design: job after `endAt`, or Manager | — | **`DESIGN BUT NOT IMPLEMENTED`** (no runner; grace window unspecified) |

`CONTRADICTORY` (recorded, not resolved by Phase 13): the shipped schema carries `PENDING_REVIEW` and `ONGOING`, neither of which appears in the design's `EventStatus`; and `requiresCheckIn` is stored/editable but **read by nothing**.
`MISSING`: `PUBLISHED → ONGOING`, `PUBLISHED → COMPLETED`, any manual COMPLETED action, and any public "past event" filter beyond the catalog's existing expression.

**Public visibility is unchanged by Phase 13** and remains a single server-side expression per endpoint, with `ARCHIVED`/`CANCELLED` hidden (Phase 4/12 contract).

---

## 4. Current Ticket State Machine

| FROM | TO | TRIGGER | ACTOR / AUTHZ | PRECONDITION | SIDE EFFECT |
|---|---|---|---|---|---|
| — | `RESERVED` | order creation (Phase 6/8) | buyer (`checkout.*` own-scope) | sales window open, quota CAS available | counters `reserved += n` |
| — | `ISSUED` | `issueTicketsForOrder` (Phase 8) | buyer, own order | order `PAID`, not `fulfilmentBlockedAt` | ticketCode + `qrTokenHash` generated; `issuedAt` set; quota converted |
| `ISSUED` | `CHECKED_IN` | **`checkInTicket` (Phase 13, new)** | tenant `checkin.scan` + (staff: active `StaffEventAssignment`) | event status `PUBLISHED/ONGOING/COMPLETED`, not cancelled/archived; ticket belongs to that event; **CAS on `status = ISSUED AND checkedInAt IS NULL`** | `checkedInAt` = server clock; one `CheckIn` row (`ticketId` UNIQUE); `checkin.success` audit row. **No money, quota, order or refund change** |
| `ISSUED` | `REFUNDED` | refund settlement (Phase 10B) | staff + provider confirmation | eligibility D-R03..D-R10 | `refundedAt`; quota per event policy; order `REFUNDED`/`PARTIALLY_REFUNDED` |
| `ISSUED` | `VOID` | **not implemented** (`ticket.void` is design-only) | — | — | — |
| `CHECKED_IN` | (none) | — | — | **terminal for this phase**: D-R05 makes it non-refundable, and the CAS makes it non-re-admittable | — |
| `REFUNDED` | `CHECKED_IN` | — | — | **structurally impossible** (CAS requires `ISSUED`) | — |

---

## 5. Current Refund State Machine

`PENDING → APPROVED → PROCESSING → REFUNDED | FAILED`, unchanged by Phase 13 (Phase 10B semantics preserved exactly):

| FROM | TO | TRIGGER | ACTOR/SYSTEM | SIDE EFFECT |
|---|---|---|---|---|
| — | `PENDING` | `requestRefund` | buyer, own order (`refund.request.own`); eligibility must pass | `RefundItem` claims (UNIQUE per ticket); **no money, no quota** |
| `PENDING` | `APPROVED` | `approveRefund` | tenant `refund.approve` | claim held; still no money |
| `PENDING` | `REJECTED` | `rejectRefund` | tenant `refund.approve` | claims released |
| `APPROVED` | `PROCESSING` | `executeRefund` | tenant `refund.execute` | provider called; provider-UNSUPPORTED (`iPaymu`) never faked |
| `PROCESSING` | `REFUNDED` | provider confirmation (`refund.settle`) | PROVIDER actor | tickets `REFUNDED`, quota per policy, order `refundedAmount`/status, PIC fee reversal, `refund.*` audit |
| `PROCESSING` | `FAILED` | provider refusal | PROVIDER/SYSTEM | claims released; `refund.fail` |

**Check-in's relationship to this machine is a hard constraint on both sides:** D-R05 refuses a refund for a `CHECKED_IN` ticket, and the ticket CAS refuses admission for anything that is not `ISSUED` (so `REFUNDED`/`VOID` can never be admitted). Both directions are asserted against the real services in `P13-D`/`P13-E`.

---

## 6. Scheduler Audit (Part D)

| Mechanism | Present? | Evidence |
|---|---|---|
| BullMQ / Redis queue | **No** | not in `package.json`; no client, no worker entrypoint |
| node-cron / cron expression | **No** | no dependency, no `crontab`, no `scripts.cron` |
| PM2 / process manager config | **No** | no `ecosystem.config.*` |
| Next.js cron / `vercel.json` | **No** | no `vercel.json`; deployment target unknown |
| Worker process | **No** | `package.json` scripts are only `dev`, `build`, `start`, `lint`, `audit:ipaymu`, `seed:organizer` |
| `setInterval` in a request process | Only in `lib/rate-limit.ts` (an in-memory bucket prune). `jest.config.js` documents that it is not `unref()`-ed and that `forceExit` works around it. The brief forbids using this pattern as a production scheduler |
| Existing reaper | **Exists but unwired**: `expireDueReservations` in `lib/ticketing/reservations.ts` is a bounded, re-runnable, single-flight-safe batch body whose only callers are tests |
| Design | `design P-3`: "No persistent job runner" — recorded as a known gap; §21/§40 promised the runner in Phase 2 (never delivered); line 1776 lists "persistent job queue (DB-backed)" as the intended shape; line 829 says the reaper job interval is every 1 minute and must be single-flight |

**Conclusion:** there is **no** existing mechanism to reuse, and none may be installed silently. The minimal options (to be chosen by the user — see §22) are:
1. **DB-backed job table + an externally invoked tick route** (`POST /api/internal/jobs/tick`, single-flight via a DB lock row / `SKIP LOCKED`), driven by system cron, PM2 cron, or the platform's scheduler. No new infrastructure, deployable anywhere, and it also finally wires the reservation reaper.
2. **Platform cron** if the deployment target offers one (e.g. Vercel Cron), calling the same protected route.
3. **BullMQ + Redis** worker — the design's implied shape (line 1776, 3823) but the only option that adds a stateful dependency and an operational constraint the design itself flags.

Any of the three must be idempotent, CAS-guarded, tenant-safe, and must never touch payment/refund state.

---

## 7. Event Automation Contract (Part C) — `DEFERRED`

**`PUBLISHED → ONGOING` — `BLOCKED BY PRODUCT DECISION`.**
`ONGOING` is in the shipped enum but **not in the design**: §10's `EventStatus` is `DRAFT | PUBLISHED | CANCELLED | COMPLETED | ARCHIVED`, and §10's lifecycle diagram goes `PUBLISHED ──event passes──> COMPLETED` with no intermediate state. No table, note or decision assigns a trigger, an actor, or a set of effects to `ONGOING`. It may be a "sales closed, event not started" marker derived from `startAt`, a manual marker, or a redundant status that should be collapsed into `PUBLISHED`. **Nothing was implemented**; deciding this is a product/design task, not an implementation detail.

**`PUBLISHED → COMPLETED` — `BLOCKED BY INFRASTRUCTURE DECISION` (rules partially known).**
What the design does fix (§10.3 line 691): the trigger is *the system after `endAt`, or a Manager*; sales stop; **check-in continues for a grace window**; the event stays readable. What it does **not** fix, and what therefore cannot be implemented honestly:

- the **length of the check-in grace window** (the word "grace" appears once, with no value);
- how `endAt IS NULL` events ever complete (the schema allows a null end);
- whether an event may complete while a refund is `PENDING/APPROVED/PROCESSING`, or while an unpaid order is still open;
- whether completion is reversible if `endAt` is later moved;
- whether `COMPLETED → CANCELLED` or `CANCELLED → COMPLETED` should ever be reachable (the brief forbids both without evidence — and there is none).

**What was implemented instead:** nothing that fabricates these rules. The `COMPLETED` *status already* behaves correctly wherever it is read — the catalog displays it, `isPurchasable` keeps selling it, and (new in Phase 13) `isEventCheckInOpen` keeps its gate open — so a manually-set `COMPLETED` event is fully handled by every existing consumer. Only the *transition* is missing.

---

## 8. Check-in Contract (Part E/I)

**Chosen credential: `Ticket.ticketCode` (public, human-readable, printed on the ticket, and the value the wallet QR encodes as `TICKET:<ticketCode>`), via `CheckInMethod.MANUAL`.**

Why not the design's `qrToken` (design §19.3/§20.2 verify it by hashing against `Ticket.qrTokenHash`): the raw 32-byte token is minted at issuance and its hash is stored, but **it has never been delivered to any client** — no email, no projection, no page — because nothing in the tree emits it (the Phase 8 finding, re-asserted by test). **D-46** ("how does a scanner obtain the token?") is still open. A scanner cannot present a secret nobody has been given, so the phase implements the path the design provides for exactly that case (a manual code) and **does not claim QR-token verification**: `QR_SCAN` is unused, and neither `qrToken` nor `qrTokenHash` is read by the scan path — both facts are pinned by static guards.

Contract as implemented:

| Question (Part E) | Answer |
|---|---|
| Who may admit? | An actor holding `checkin.scan` **inside the event's own tenant**, and — for a member without `checkin.override` (i.e. `CHECKIN_STAFF`) — holding an active `StaffEventAssignment` for that exact event |
| Permission | `checkin.scan` (declared Phase 3; first caller is this phase) |
| Organizer member? | Yes — resolved from the DB via `requireEventAccess`, never from the request |
| May a PIC? | No. A platform `PIC` has no tenant-wide capability and no `checkin.scan`. **Product decision pending** if gate access for PICs is desired |
| May a platform admin? | Only with an active membership in the event's organizer (`ADMIN` + `ACTIVE OrganizerMember` → yes, as the role sets intend) |
| May a customer self-admit? | No. There is no buyer-facing route; `/api/ticketing/**` gained none |
| Must the ticket be `ISSUED`? | Yes — the CAS requires it |
| May a `REFUNDED` ticket be admitted? | No (CAS) |
| May a `VOID` ticket be admitted? | No (CAS) |
| May a `CANCELLED` event admit? | No — `isEventCheckInOpen` fails closed |
| May an `ARCHIVED` event admit? | No — same predicate |
| Is a duplicate scan idempotent? | Deterministically refused with `TICKET_ALREADY_CHECKED_IN` (409) carrying the first admission's **time, staff name and gate label** |
| Two simultaneous scanners? | Exactly one winner (conditional `UPDATE … WHERE status = 'ISSUED' AND checkedInAt IS NULL` inside one transaction), the loser gets the duplicate response; additionally guaranteed by `CheckIn.ticketId @unique` |
| `checkedInAt` needed? | Yes — `Ticket.checkedInAt` (server clock) |
| `checkedInBy` needed? | Yes — `CheckIn.checkedInByUserId` + `checkedInByMemberId` |
| Check-in history? | Yes — the `CheckIn` table is append-only and records **refusals too** (`ALREADY_CHECKED_IN`, `TICKET_NOT_FOUND`, `WRONG_EVENT`, `UNPAID`, `INVALID_TICKET`) |
| Device/scanner identity? | Optional, non-authoritative: `gateLabel`, `deviceId`, `clientScannedAt` are recorded for reconciliation; they never decide anything |
| Is the existing QR token enough? | No — see above (D-46) |
| Is the raw QR secret still unpersisted? | Yes — unchanged; the scan path never touches `qrTokenHash` |

**Responses.** Success returns only what a gate needs: ticket code, ticket type name, attendee name, event id/title, `checkedInAt`, method, gate label. It exposes no QR secret, no payment data, no buyer email/phone, and no internal audit fields.

**Malformed vs unknown.** By design §20.2 check 1 the two must be indistinguishable; both answer the same `NOT_FOUND` with the same message, so the error shape is not an oracle for probing the code space.

---

## 9. Authorization

Every mutation goes through the existing guards; nothing is hardcoded and nothing from the client is trusted.

| Actor | Capability resolved from DB | Outcome |
|---|---|---|
| `OWNER` membership + `ACTIVE` | `checkin.scan` + `checkin.override` | allowed, no assignment needed |
| `MANAGER` membership + `ACTIVE` | same | allowed |
| platform `ADMIN` + `ACTIVE` membership | same | allowed |
| `CHECKIN_STAFF` + assignment on this event | `checkin.scan`, `checkin.log.read` | allowed |
| `CHECKIN_STAFF` **without** assignment | — | **403 `FORBIDDEN`, `details.reason = "NO_STAFF_ASSIGNMENT"`** |
| `FINANCE` membership | no check-in permission | **403 `FORBIDDEN`** |
| `CUSTOMER` / no membership | — | **404 `ORGANIZER_ACCESS_DENIED`** |
| no session | — | **401 `UNAUTHORIZED`**. (As in every organizer route, the guard chain resolves the *event id* to its owner before demanding a session — that is `requireEventAccess`'s Phase 4 ordering, not a Phase 13 choice. No business field, no ticket and no check-in row is read, and the response discloses nothing about the event) |
| cross-tenant organizer owner | — | **404 `ORGANIZER_ACCESS_DENIED`** (deliberately 404, not 403, so a denial cannot confirm the event exists) |

The guard chain is the existing one — `requireEventAccess(eventId, permission)` (narrow ownership read → `requireOrganizerAccess` resolved from the database) plus, for pure gate staff, an active `StaffEventAssignment` lookup. Phase 13 added no new authorization primitive.

UI visibility is never the control: the dashboard section is *additionally* gated on `checkin.scan` resolved server-side, but the API refuses independently.

**No client-supplied authority exists to forge.** The request schema is `.strict()` and rejects `organizerId`, `eventId`, `ticketId`, `status`, `checkedInAt`, `checkedInBy*`, `result`. The event comes from the route and is authorized against the actor's own memberships; the tenant, the ticket, the timestamp and the actor are all read server-side.

---

## 10. Tenant Isolation

- `requireEventAccess(eventId, "checkin.scan")` performs a **narrow ownership read** (id + `organizerId` only) and then authorizes against the actor's `ACTIVE` memberships; business fields are never read before the decision.
- A foreign `eventId` yields 404 without disclosing existence; a foreign **ticket** (owned by another event) yields `WRONG_EVENT` **without naming the ticket's real event** — revealing it would confirm another event's existence to an actor who may not be able to see it.
- A `WRONG_EVENT` refusal writes its row scoped to the event being worked (`organizerId` = the scanned event's tenant), so the refusal log never leaks across tenants either.
- Asserted against the real database for: another tenant's owner scanning an eventA ticket (404), and eventA's owner scanning an eventB ticket (`WRONG_EVENT`, with tenant B's order state unchanged).

---

## 11. Concurrency

| Case | Guarantee | Test |
|---|---|---|
| Same ticket, two simultaneous requests | Exactly one `CHECKED_IN`; the other gets `TICKET_ALREADY_CHECKED_IN`; exactly one accepted `CheckIn` row | `P13-B` (real `Promise.allSettled`, real DB) |
| Duplicate request from the same scanner | Deterministic response carrying the first admission's timestamp/staff/label; a refusal row + `checkin.rejected` audit row | `P13-B` |
| Two `CheckIn` rows for one ticket | Impossible twice over: the CAS and `CheckIn.ticketId @unique` | schema + CAS assertions |
| Race against refund settlement | Structurally impossible in both directions (CAS requires `ISSUED`; D-R05 refuses `CHECKED_IN`) | `P13-D`, `P13-E` |
| Race against cancel | The gate is re-read from the event row inside the attempt; once `cancelledAt` is set the status check refuses and the CAS is irrelevant | `P13-F` |
| Race against checkout/payment | None: the gate writes only `Ticket.status/checkedInAt` and one `CheckIn` row. Asserted that counters, order status/payment status/total and payment rows are byte-identical before and after | `P13-A` ("changes nothing…") |

All state moves are database-conditional. There is no read-then-write in the admission path.

---

## 12. Refund Interaction (Part F)

Locked and asserted in both directions:

- **`CHECKED_IN → REFUNDED` cannot happen.** `requestRefund` refuses the ticket (Phase 10B D-R05) with `REFUND_NOT_ALLOWED`, and **no `Refund`, `RefundItem` or ticket change** results (asserted: 0 refund rows, 0 claims, ticket still `CHECKED_IN`, `refundedAt` still null).
- **`REFUNDED → CHECKED_IN` cannot happen.** The admission CAS requires `status = ISSUED`; a `REFUNDED` ticket is refused and its row is untouched.
- **`VOID`** is refused by the same mechanism.
- **Not decided / not implemented:** the brief's Part F edge case "admission while a refund request is *open* (`PENDING`) on that ticket" is **design D-28**, still unanswered, and the shipped `CheckInResult` has no value to record such a refusal. Phase 13 therefore does not pin a behaviour as a test: today the CAS admits it (the ticket is still `ISSUED`). Recorded in §22 as a product decision required.

---

## 13. Cancel Interaction (Part G)

- Cancelling closes the gate: `isEventCheckInOpen` reads `status` **and** `cancelledAt`, so a cancelled event refuses admission with `CONFLICT` / `details.reason = "EVENT_NOT_OPEN"` / `details.status = "CANCELLED"`. The same predicate the catalog and purchase path reason about is reused, so the three cannot drift.
- **Already-admitted people stay admitted.** Cancelling does not void tickets (Phase 12 made no ticket/refund change on cancel, and Phase 13 did not add one). Asserted: after cancel, the checked-in ticket is still `CHECKED_IN` with its `checkedInAt` intact.
- **No refund policy was invented.** Who gets refunded after a cancellation, whether `ISSUED` tickets become `VOID`, and who approves it remain undecided (§22). The gate's refusal is the only new behaviour.

---

## 14. Archive Interaction (Part H/N)

- Archiving closes the gate for the same reason (`archivedAt` is part of the predicate). Asserted after archiving.
- Archive does not delete or alter any ticket/check-in evidence; the Phase 12 rule (no order/ticket/payment/refund mutation, refused while a refund is in flight) is untouched.
- **Archive policy (Part N) — reviewed, deliberately unchanged.** Phase 12 allows archiving any non-`ARCHIVED` event after its preconditions; the design's narrower rule is `COMPLETED/CANCELLED → ARCHIVED`. Restricting the action today would make it **impossible to archive a healthy event that simply ran**: there is no `COMPLETED` automation and no manual COMPLETE action, and cancelling a successful event to archive it would be factually wrong (it would also expire unpaid orders and assert a cancellation that never happened). Consequence, stated plainly: until the automation decision in §22 is made, `ARCHIVED` is reachable only from a non-`ARCHIVED` state, and a `PUBLISHED` event can be archived directly. Both are hidden from every public surface either way.
- **`COMPLETED` vs refunds (`PART H`):** the design does not say whether completion may coexist with open refunds; and since completion is not automated, the existing refund rules (which already allow a refund on a `COMPLETED` event, and never before provider confirmation) are the only ones in force. Nothing was changed.

---

## 15. API

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/organizer/events/[id]/check-in` | `POST` | session + same-origin + `checkin.scan` (+ assignment for pure gate staff) | Admit the ticket the presented code names |
| `/api/organizer/events/[id]/check-in` | `GET` | session + `checkin.log.read` | The event's recent admissions (`?limit=1..50`, default 20) with `total` |

- Both are inside `/api/organizer/`, already classified protected by `proxy.ts` (defence in depth; the real control is the guard chain).
- `POST` body: `{ code (required), gateLabel?, deviceId?, clientScannedAt? }`, strict. Everything else is rejected.
- `POST` success: ticket code/attendee, ticket type name, event id/title, `checkedInAt`, method, gate label.
- Failure codes: `NOT_FOUND` (unknown **or** malformed), `CONFLICT` (`WRONG_EVENT`, `TICKET_NOT_ISSUED`, `EVENT_NOT_OPEN`), `TICKET_ALREADY_CHECKED_IN` (409 with first-admission details), `FORBIDDEN`, `ORGANIZER_ACCESS_DENIED` (404), `UNAUTHORIZED`.
- Only one check-in route exists whose path matches `check-?in`, and it is asserted to be that path by test.

---

## 16. UI

`components/organizer/CheckInPanel.tsx`, rendered from the server page `app/dashboard/events/[id]/page.tsx` inside a `SectionCard` ("Check-in & kehadiran") that is rendered **only** when the server has already resolved `checkin.scan` for that event.

- **Manual code entry with scanner-friendly ergonomics** — a large monospace field, autofocused, that a keyboard-wedge QR gun types into; no camera library and no new dependency (the brief forbids adding one for convenience). This is the "manual ticket-code fallback" of Part L, and it is in fact the primary path for the reason given in §8.
- Optional gate label (e.g. "Pintu Utama"), so a multi-door event can attribute admissions.
- **States:** success (green note with attendee, type, code, time), duplicate (amber note: "sudah check-in", with the first time and staff name from the server's `details`), refusal (error block with the server's own message and the offending code), in-flight (`busy` disables the button and shows "Memproses…"), and an empty state for the attendance list.
- **No duplicate submit:** `busy` short-circuits the handler and the input is cleared only on success (so a rejected code stays visible while the operator reads the message).
- **Responsive and permission-honest:** the panel is absent for anyone without `checkin.scan`; if the gate is closed (cancelled/archived/not-yet-published) the panel is replaced by an explanation rather than a form the API would refuse.
- **No fake analytics.** The attendance view shows real rows (`ticketCode`, attendee, type, time, gate, actor) and a real total. No charts, no "check-in rate", no invented metrics — the design's denormalized counter (line 1738) does not exist and was not faked.
- The buyer's surfaces (`app/ticketing/tickets/**`) still offer **no** check-in control; that is asserted by test.

---

## 17. Audit Logging (Part K)

Two new action names in the existing vocabulary (`lib/ticketing/audit-log.ts`), each with a real writer:

| Action | When | Recorded |
|---|---|---|
| `checkin.success` | accepted admission | actor + role snapshot, `actorOrganizerId`/`organizerId`, `entityType: "Ticket"`, `entityRef = ticketCode`, before `{status: ISSUED}` → after `{status: CHECKED_IN, eventId, method, gateLabel}`, ip/user-agent |
| `checkin.rejected` | every refusal (unknown/malformed code, wrong event, not issued, already checked in, closed gate) | same metadata plus `reason` and `afterState {reason, result}` |

There is deliberately **no** `checkin.override` action: admitting without a valid ticket is a distinct capability (`checkin.override` is the *authorization* to skip the assignment requirement) that this phase did not implement as an action, and declaring an action with no writer is the "vocabulary invented for symmetry" earlier phases rejected.
The existing deny-list (password/token/secret/API key/cookie/QR token/KTP/bank account + `qrToken`) still strips forbidden keys defensively. No raw code is ever stored in audit `before/after` state; the ticket code appears as `entityRef`, which is the design's intended reference column.

---

## 18. Tests (Part O)

**New — 43 tests** (plus 2 net additions in the two rewritten suites, for the +45 total in §24).

`__tests__/ticketing-checkin/check-in-wiring.test.ts` (23, no DB, no Next.js) — code parser (both accepted shapes, alphabet rejection, path-traversal/garbage rejected); malformed ≡ unknown; the gate predicate matrix (open only for `PUBLISHED/ONGOING/COMPLETED` with no `cancelledAt`/`archivedAt`; failed-closed for `DRAFT/PENDING_REVIEW/CANCELLED/ARCHIVED` and for a live-looking status with a cancellation/archival stamp); schema strictness (`organizerId`/`eventId`/`ticketId`/`status`/`checkedInAt`/`checkedInByUserId`/`result` all rejected; required code; bad timestamp rejected; list bounds); the service's CAS + `updateMany` + `tx.checkIn.create` shape; tenant-scoped permission and staff-assignment requirement; `qrTokenHash`/`hashQrToken` never read; `MANUAL` only, `QR_SCAN` unused; both audit actions written; no money/inventory handle; route auth + same-origin + validation; no scanner secret in the response; no QR-decoding dependency; the wallet prefix reused.

`__tests__/ticketing-checkin/check-in.integration.test.ts` (**20, real MariaDB**) — tickets produced by the real chain (checkout → payment → HMAC-verified settlement → issuance):

- **Happy path:** `ISSUED → CHECKED_IN` with `checkedInAt`, `method = MANUAL`, actor + member recorded, gate label stored, `checkin.success` audit row; the wallet payload (`TICKET:…`) accepted; gate staff's `checkedInByMemberId` recorded; **counters, order status/payment status/total are identical before and after**.
- **Once only:** second scan refused with the first admission's time/staff; exactly 1 accepted + 1 refused row; 1 `checkin.rejected` audit row; two simultaneous requests → exactly one winner.
- **Authorization:** unauthenticated (401, ticket untouched), customer (404), `FINANCE` (403), gate staff without assignment (**403 `NO_STAFF_ASSIGNMENT`**, ticket untouched), other tenant's owner (404, no row written), foreign ticket (`WRONG_EVENT`, tenant B's order unchanged), unknown ≡ malformed.
- **Statuses:** `VOID`, `REFUNDED`, `RESERVED` (classified `UNPAID`) all refused with the ticket untouched.
- **Refund boundary:** a checked-in ticket cannot be refunded — `REFUND_NOT_ALLOWED`, 0 refund rows, 0 claims, ticket unchanged.
- **Lifecycle:** cancel closes the gate (`EVENT_NOT_OPEN`, `status: CANCELLED`) while the already-admitted ticket stays `CHECKED_IN`; archive keeps it closed.
- **Attendance read:** buyer denied (404), `FINANCE` denied (403), gate staff allowed with a real list.

**Modified / rewritten (no assertion weakened, none deleted).**

- `__tests__/ui-consolidation/checkin-gate.test.ts` — the Phase 10 suite asserted *"nothing was built for check-in"*. That premise is now false by design decision, so the suite was rewritten (not deleted) as the record of **why the gate opened**: exactly one gate route under `/api/organizer/`, no route under `/api/ticketing/`, the service is server-only, `checkin.scan` now has a caller, the raw token is still never emitted and never read, `QR_SCAN` still unused, the schema still lacks the design's `MANUAL_OVERRIDE`/`REJECTED_*` values (recorded divergence, not papered over with a migration), the locked `StaffEventAssignment`/`CheckIn` infrastructure intact, no scanner dependency, the buyer UI still control-free, and the page resolving `checkin.scan`/`checkin.log.read`/`isEventCheckInOpen` server-side. Every assertion that was still true was kept verbatim.
- `__tests__/ticketing-ui/ui-wiring.test.ts` (H5) — flipped from "no check-in route or module was created" to "the gate is a back-office route and the buyer surface still has none", preserving every buyer-side assertion and adding the `/api/ticketing/**` non-existence check.
- `jest.config.js` — the new `__tests__/ticketing-checkin/*.test.ts` namespace enrolled.

**Regression:** the entire pre-existing suite still passes (53 suites / 1200 tests), including payment, checkout, issuance and refund.

---

## 19. TypeScript

`npx tsc --noEmit` → **PASS (0 errors).**

---

## 20. Build

`npm run build` → **PASS.** The new route `/api/organizer/events/[id]/check-in` compiles and the dashboard event page builds.

---

## 21. ESLint

`npx eslint .` → **0 errors / 5 warnings** — the same five pre-existing `@next/next/no-img-element` warnings present at the Phase 12 baseline. No new warning or error was introduced.

---

## 22. Deferred Product Decisions

| # | Decision needed | Why it is not implemented | What it blocks |
|---|---|---|---|
| A | **Scheduler/runner choice** (DB-backed tick route + external cron · platform cron · BullMQ+Redis worker) | No runner exists (`design P-3`); the brief forbids installing infrastructure silently or using request-process `setInterval` | Both automation transitions; also the unwired reservation reaper |
| B | **What `ONGOING` means, and what triggers it** | Not in the design's `EventStatus`; no trigger/actor/effect documented anywhere | `PUBLISHED → ONGOING` |
| C | **Check-in grace window after `endAt`** | The design says "a grace window" and never states a duration | `→ COMPLETED` (check-in behaviour at completion) |
| D | **Completion vs open commercial state** — may an event be `COMPLETED` with refunds `PENDING/APPROVED/PROCESSING`, or with unpaid orders? And is `endAt IS NULL` completable? Is completion reversible if `endAt` moves? | Design's lifecycle table does not say | `→ COMPLETED` correctness |
| E | **Scanner-token delivery (D-46)** — how does a scanner obtain the raw `qrToken`? | The token has never been emitted by any channel | True `QR_SCAN` admission; the design's full enum/method set |
| F | **D-28 — may a ticket with an OPEN refund request be admitted?** | Undecided, and `CheckInResult` has no value to record the refusal | The gate's behaviour on a `PENDING` refund claim |
| G | **Cancellation refund/void policy** — who is refunded, are `ISSUED` tickets voided, who approves | Phase 12 recorded this as undecided; inventing it would fabricate a money policy | Any auto-refund/auto-void on cancel |
| H | **`requiresCheckIn` semantics** — does `false` disable the gate? | The flag is stored and editable but read by nothing, and the design does not define it | Whether the panel should hide when `false` |
| I | **PIC gate access** — may a PIC ever admit tickets? | Platform `PIC` has no tenant-wide capability; granting one is an authz design change | PIC-run gates |
| J | **Attendance counter / check-in notifications** (`CHECKIN_SUCCESS` message type, denormalized counter) | Requires the job runner and a delivery channel; the brief forbids fake analytics | Reporting and buyer/staff notifications |
| K | **Manual `COMPLETED` action + `CheckInResult.DUPLICATE`** | A manual complete action has no contract; `DUPLICATE` is unused because `ALREADY_CHECKED_IN` carries more information | UI parity with the design's status table |

---

## 23. Security Findings

**P0 (tenant escape, financial corruption): none found.**
**P1 (broken lifecycle/transaction): none found.**

Observations, all `LOW` and none blocking:

1. **The admitted credential is a public code, not a secret** — by construction. The safety therefore rests entirely on authorization (tenant-scoped `checkin.scan` + per-event assignment for pure gate staff), the single-admission CAS, and the UNIQUE constraint. This is stated openly in the module header rather than presented as token verification, and it is the reason `QR_SCAN` remains unused. If the design's stronger credential is ever required, D-46 is the decision to make.
2. **No rate limit on the check-in endpoint.** No organizer route in this codebase has one, so adding it here would be an inconsistent architectural change. Practical exposure is bounded: the endpoint requires an authenticated, tenant-scoped, assignment-bounded actor, and every attempt (accepted or refused) is written to the append-only `CheckIn` table and the audit log, so a probing actor is fully accountable. Recommendation (not implemented): a per-actor limit if gate abuse is ever observed.
3. **The rejection row cannot reference the ticket** (`CheckIn.ticketId` is UNIQUE and belongs to the accepted admission), so duplicate/refused attempts are linked by the code in `note`. This is the schema's own shape (design D-32's nullable-unique decision), documented at the call site rather than worked around with a second table.
4. **Refusal disclosure is deliberately uniform**: unknown and malformed codes are indistinguishable, a wrong-event ticket does not name its real event, and an authz denial is 404 rather than 403.
5. The dashboard panel's visibility is **not** the security control; the API refuses independently (asserted).

---

## 24. Final Verdict

**`PHASE 13 COMPLETE WITH NON-BLOCKING GAPS`**

- **Check-in / attendance: `COMPLETE`.** Service, route, authorization, tenant isolation, idempotency, concurrency, audit, UI, and 43 tests (20 against the real database) — with the credential restriction stated honestly rather than overstated.
- **Event automation: `BLOCKED BY INFRASTRUCTURE DECISION`** (no job runner exists; `design P-3` records the gap) **and, for `ONGOING`, by a missing contract** (§22 A–D). Not implemented, not faked, and not silently compensated with `setInterval`.
- **Archive policy: `UNCHANGED (deliberate)`** — widening was reviewed against the design and kept, with the consequence documented (§14).
- **Payment / checkout / refund / inventory core: untouched.** The gate writes one ticket row and one evidence row, and asserts (by test) that no money, quota, order or refund value moves.
- No commit, no push, no database reset, no destructive migration. No test skipped, deleted, or weakened — the one Phase 10 suite whose premise Phase 13 intentionally invalidated was rewritten with every still-true assertion preserved, and the reason for the change is recorded in the file itself.

**Baseline → now:** 51 suites / 1155 tests → **53 suites / 1200 tests** · TypeScript PASS · Build PASS · ESLint 0 errors / 5 warnings.
