# PHASE 14 — EVENT LIFECYCLE DECISION LOCK

**Project:** TinggalKlik.Co · Next.js 16 · React 19 · TypeScript · Prisma 6 · MySQL/MariaDB · NextAuth v5 beta
**Mode:** READ / AUDIT + DECISION SPEC ONLY. No source, schema, migration, API, UI, test, commit or push change was made.
**Artifact:** this document is the only file this phase produces.

**How to read this document.** Every statement is labelled:

| Label | Meaning |
|---|---|
| `SOURCE FACT` | Read directly out of code or `prisma/schema.prisma` today. |
| `DESIGN FACT` | Written in `TICKETING_PHASE1_DESIGN.md` (or a prior phase report) — a specification statement, not necessarily implemented. |
| `EXISTING BEHAVIOR` | What the shipped implementation does right now, verified in the tree. |
| `PRODUCT DECISION — LOCKED` | A business rule that was undecided and is now decided by the product owner in this phase. It is binding on Phase 15/16. |
| `OPEN QUESTION` | Still undecided. Phase 15 must not guess; the item is listed in §25. |
| `INFRASTRUCTURE DECISION` | Deployment/runtime architecture, not business logic. |

> Legacy decision IDs (`D-28`, `D-46`, `P-3`, `D-13`…) are preserved. New decisions introduced by this lock are `P14-Dnn`. Where a legacy ID is closed here it is named explicitly.

> **Phase numbering warning.** `TICKETING_PHASE1_DESIGN.md` §40.11 numbers its *own* roadmap (design-Phase 12 = check-in). The project's actual phases are the `PHASE_nn_*` reports. In this document "Phase 15" and "Phase 16" mean the project's next implementation phases, not the design's.

---

## 1. Executive Summary

Phase 13 left one track complete (manual ticket-code check-in, 53 suites / 1200 tests) and one track explicitly blocked: event automation. Phase 14 was asked to decide, not to code. It has now decided every open lifecycle question — including the ones Phase 13 correctly refused to invent.

**What changed in this phase: nine previously-undecided contracts are now LOCKED.**

1. **`ONGOING` has a contract** (`P14-D01`/`P14-D02`). It is a real, automated state derived from `startAt`: the scheduler moves `PUBLISHED → ONGOING` the moment `now >= startAt`. It is monotonic (never returns to `PUBLISHED`) and has no manual entry path.
2. **`COMPLETED` has a contract** (`P14-D04`/`P14-D05`). Automatic: `now >= endAt + grace`. Manual: an `event.publish` holder once `endAt` has passed. `endAt IS NULL` events never complete — they are cancelled or archived (`P14-D22`, derived, not invented).
3. **The grace window is 30 minutes** (`P14-D06`), fixed, not configurable, measured from `endAt`. After `endAt + 30m` the gate is closed and the event is `COMPLETED`.
4. **`D-28` is closed** (`P14-D15`): a ticket with an **open** refund (`PENDING | APPROVED | PROCESSING`) is **blocked from check-in**, with a new `CheckInResult.REFUND_PENDING` value and a real-DB race contract. `REJECTED`/`FAILED` claims do not block.
5. **`requiresCheckIn` is closed** (`P14-D13`): `false` is a **soft** signal — the event is declared gate-free (panel soft-hidden, reporting treats it as ungated) but the check-in endpoint keeps working. It never affects issuance, refund, completion or public payloads.
6. **`D-46` is closed** (`P14-D17`): the wallet QR keeps encoding `TICKET:<ticketCode>` and admission stays `MANUAL`. The raw `qrToken` continues never to leave the server; `QR_SCAN` stays unused. Phase 16 is therefore **unblocked** and is optional hardening, not a dependency.
7. **The scheduler is decided** (`P14-D09`/`P14-D10`): a DB-backed tick route (`POST /api/internal/jobs/tick`) driven by an external cron on the existing single-VPS deployment, with a DB lock-row lease for single-flight. No Redis, no BullMQ, no in-process timer.
8. **Archive policy is ratified** (`P14-D08`): the Phase 12 widening (any non-`ARCHIVED` state, blocked while a refund is in flight) becomes the contract, not a stopgap.
9. **Cancellation and attendance are ratified unchanged** (`P14-D07`, `P14-D14`): no auto-refund, no auto-void; one admission per ticket, `CHECKED_IN` terminal, no undo/re-entry.

**Divergences this lock surfaces** (design vs code, to be fixed by Phase 15 — none of them is a new business rule):

- `isEventPurchasable` currently keeps selling a `COMPLETED` event; design §10.3 says **"Sales stop"** on completion. The lock follows the design (`P14-D11`).
- `publicVisibilityWhere` lists only `status = PUBLISHED`; once `ONGOING` is reachable, a live event would vanish from the catalog (`P14-D11`).
- `publishEvent` would happily move `ONGOING → PUBLISHED` (a backward transition) once `ONGOING` exists (`P14-D19`).
- `updateEvent` has no `endAt` freeze, so a `COMPLETED` event's `endAt` is editable today (`P14-D12`).
- The check-in gate predicate (`isEventCheckInOpen`) ignores time altogether, so it cannot express the grace window (`P14-D06`, `P14-D16`).

**FINAL VERDICT: `DECISION LOCK COMPLETE`.** Phase 15 has no business rule left to guess. Legacy items outside this lock's scope (`D-08`, `D-34`, `P12-D2/D3/D4`) are listed in §25 as explicitly **non-blocking**; none of them is touched by the lifecycle, gate or scheduler contracts.

---

## 2. Source Audit

### 2.1 `prisma/schema.prisma` (read in full for the event/ticketing domain)

| Surface | Fact |
|---|---|
| `EventStatus` | `DRAFT \| PENDING_REVIEW \| PUBLISHED \| ONGOING \| COMPLETED \| CANCELLED \| ARCHIVED` (`SOURCE FACT`). |
| `EventVisibility` | `PUBLIC \| UNLISTED \| PRIVATE`. `PRIVATE` is reserved and unreachable through the API (`SOURCE FACT`, `DESIGN FACT`). |
| `Event` lifecycle columns | `status` (default `DRAFT`), `publishedAt`, `cancelledAt`, `cancelReason`, `archivedAt`, `startAt` (`DateTime`, **NOT NULL**), `endAt` (`DateTime?`), `salesStartAt`, `salesEndAt`, `requiresCheckIn` (`Boolean @default(true)`), `returnQuotaOnRefund` (`@default(false)`), `refundDeadlineAt`. **There is no `completedAt` and no `ongoingAt` column** (`SOURCE FACT`). |
| `Ticket` | `ticketCode @unique`, `qrTokenHash @unique`, `qrVersion`, `status` (`TicketStatus`), `issuedAt`, `checkedInAt`, `refundedAt`, `voidedAt/voidReason` (`SOURCE FACT`). |
| `TicketStatus` | `RESERVED \| ISSUED \| CHECKED_IN \| VOID \| REFUNDED` (`SOURCE FACT`). |
| `CheckIn` | `ticketId String? @unique`, `eventId`, `organizerId`, `checkedInAt`, `checkedInByUserId`, `checkedInByMemberId`, `method`, `gateLabel`, `deviceId`, `clientScannedAt`, `ipAddress`, `result`, `note`, append-only (no `updatedAt`) (`SOURCE FACT`). |
| `CheckInMethod` | `QR_SCAN \| MANUAL` (`SOURCE FACT`). |
| `CheckInResult` | `SUCCESS \| DUPLICATE \| ALREADY_CHECKED_IN \| INVALID_TICKET \| WRONG_EVENT \| UNPAID \| TICKET_NOT_FOUND` — **no refund-pending value** (`SOURCE FACT`). |
| `StaffEventAssignment` | `@@unique([organizerMemberId, eventId])`, `revokedAt` (`SOURCE FACT`). |
| `OrganizerMember` / `OrganizerMemberRole` | `OWNER \| ADMIN \| MANAGER \| FINANCE \| PIC \| CHECKIN_STAFF`; status `INVITED \| ACTIVE \| SUSPENDED \| REVOKED` (`SOURCE FACT`). |
| `EventOrder` / `OrderStatus` | `PENDING_PAYMENT \| PAID \| CANCELLED \| EXPIRED \| REFUNDED \| PARTIALLY_REFUNDED`; `expiresAt`, `paidAt`, `cancelledAt`, `fulfilmentBlockedAt` (`SOURCE FACT`). |
| `Payment` / `PaymentStatus` | `UNPAID \| PENDING \| PAID \| FAILED \| EXPIRED \| REFUNDED \| PARTIALLY_REFUNDED` (`SOURCE FACT`). |
| `Refund` / `RefundStatus` | `PENDING \| APPROVED \| REJECTED \| PROCESSING \| REFUNDED \| FAILED`; `RefundItem` claims per ticket; `PENDING`/`APPROVED` never restore inventory (`SOURCE FACT`). |
| `PlatformSetting` | singleton (`id @default(1)`), `reservationTtlMinutes @default(30)` (`SOURCE FACT`). |
| No job infrastructure | no `JobLock`/`JobRun` model, no queue table (`SOURCE FACT`). |

### 2.2 `TICKETING_PHASE1_DESIGN.md`

Read directly, with the sections that bear on this lock:

| Section | Content |
|---|---|
| §6.3 permission matrix | **Check-in rows**: `Scan / validate QR` = Admin YES, Manager YES, **FINANCE NO, PIC NO**, CHECKIN_STAFF `SCOPED`, Customer NO. `Manual check-in override` = Admin/Manager YES, FINANCE/PIC/CHECKIN_STAFF/Customer **NO**. `View check-in log` = Admin/Manager YES, FINANCE/PIC NO, CHECKIN_STAFF SCOPED (`DESIGN FACT` — this is a lock, not a recommendation). |
| §7.3 rule 4 | `CHECKIN_STAFF` additionally requires at least one `StaffEventAssignment`; a staff member with no assignment can scan nothing (`DESIGN FACT`). |
| §10.2 | `startAt` required; `endAt` nullable for "running/road events with no fixed end"; `salesStartAt` null = "immediately after publish"; `salesEndAt` null = "until event start"; `requiresCheckIn` `false` "for merchandise/spectator-free events" (`DESIGN FACT`). |
| §10.3 lifecycle | `DRAFT ─publish→ PUBLISHED ─event passes→ COMPLETED`; `PUBLISHED → COMPLETED` by "System (job, after `endAt`) or Manager", precondition "past `endAt`", effect "Sales stop; check-in allowed to continue for a grace window; event remains readable"; `COMPLETED/CANCELLED → ARCHIVED` precondition "no open refunds/settlements". **`ONGOING` does not appear anywhere in §10** (`DESIGN FACT` + absence). |
| §11.4 | Reservation reaper: TTL default 30 min from `PlatformSetting.reservationTtlMinutes`; **job interval every 1 minute**, single-flight so overlapping invocations cannot double-release; the reaper's CAS makes a double-run safe (`DESIGN FACT`). |
| §11.5 / §18.4 | Per-unit tickets; refund request `PENDING` leaves tickets `ISSUED` and scannable; `D-28` = should an open refund block check-in (recommendation "yes, block and warn", **not** a lock) (`DESIGN FACT`). |
| §19.2 | `TicketStatus` lifecycle; `CHECKED_IN`, `REFUNDED`, `VOID` are **terminal** (`DESIGN FACT`). |
| §19.3/§19.4 | Opaque 32-byte token, only its SHA-256 stored, per-ticket revocable; "the URL is not the security boundary; the token is" (`DESIGN FACT`). |
| §20.1–20.6 | `CheckIn` fields, seven-check validation chain (check 4 = open-refund guard `REJECTED_REFUND_PENDING`), rejected attempts also recorded, `MANUAL_CODE`/`MANUAL_OVERRIDE` methods, manual path is **not** exempt from validation (`DESIGN FACT`). |
| §21.2 | Notifications ride a **persistent job queue (DB-backed)** (`DESIGN FACT`). |
| §25.2 | Public filter is `status = PUBLISHED`, `visibility = PUBLIC`, `archivedAt IS NULL`, `startAt >= now - grace` — the word "grace" again with **no value** (`DESIGN FACT`). |
| §26.5/§26.6 | Wallet list returns **no QR**; detail returns the QR; returning the permanent `qrToken` to the browser is **Rejected**; `D-46` = short-lived display token vs server-rendered image, recommendation "server-rendered image for the web wallet" (`DESIGN FACT`). |
| §29.4 | Check-in guard chain = `requireAuth()` + `requireEventAccess(eventId, 'checkin.scan')` + assignment for `CHECKIN_STAFF` (`DESIGN FACT`). |
| §40.9 | "Redis introduces an operational dependency on a **single VPS**" (`DESIGN FACT` — the deployment shape). |
| P-3 | "No persistent job runner" — a recorded, unfixed gap; §40.11 assigned the runner to design-Phase 5, which never delivered it (`DESIGN FACT`). |

### 2.3 Phase 12 report (`PHASE_12_EVENT_COMPLETION_REPORT.md`)

- Archive widened to any non-`ARCHIVED` status, precondition "no open refunds" enforced, recorded as an explicit product decision (`EXISTING BEHAVIOR`, ratified in §15).
- `ONGOING`/`COMPLETED` automation deferred: "Time-driven; no scheduler/job runner exists" (`P12-D1`). Cancel → void / bulk refund / finance approval deferred (`P12-D2/D3/D4`).
- Cancel contract from Phase 12: sales stop, `PENDING_PAYMENT` orders expire, open payments void, **no refund, no ticket void** (`EXISTING BEHAVIOR`).
- `EventStatus` recorded with `PENDING_REVIEW` "reserved/unused — D-13 self-publish is LOCKED".

### 2.4 Phase 13 report (`PHASE_13_EVENT_AUTOMATION_CHECKIN_REPORT.md`)

- `ONGOING` "has no contract"; automation **BLOCKED BY INFRASTRUCTURE DECISION**; grace window value unknown; completion-vs-open-commercial-state unknown; `endAt IS NULL` unknowable (`EXISTING BEHAVIOR`).
- Check-in implemented for `Ticket.ticketCode` + `MANUAL`, gate predicate `isEventCheckInOpen` (status ∈ {`PUBLISHED`,`ONGOING`,`COMPLETED`} and no `cancelledAt`/`archivedAt`), CAS `status='ISSUED' AND checkedInAt IS NULL`, UNIQUE `CheckIn.ticketId`, refusals recorded (`EXISTING BEHAVIOR`).
- Open refunds admitted today (CAS admits; nothing reads `RefundItem`) (`EXISTING BEHAVIOR`).
- `requiresCheckIn` stored/editable, read by nothing (`EXISTING BEHAVIOR`).
- Scheduler audit: no BullMQ, Redis client, cron, node-cron, worker process, `vercel.json`; only `setInterval` is the in-memory rate-limit prune; `expireDueReservations` is unwired (`EXISTING BEHAVIOR`).

### 2.5 Existing implementation (traced, not grepped by filename)

| File | What it does today |
|---|---|
| `lib/events/sales-state.ts` | Pure. `summarizeSales`, `classifySalesState` (type window overrides event window; null end falls back to `event.startAt`), `isEventPurchasable` (status ∈ `PUBLISHED\|ONGOING\|COMPLETED`, not PRIVATE, not archived, not cancelled), `isEventCheckInOpen` (status ∈ `PUBLISHED\|ONGOING\|COMPLETED`, no cancelled/archived — **no time input**). |
| `lib/events/service.ts` | `createEvent`, `updateEvent` (updatable keys include `startAt`,`endAt`,`requiresCheckIn`; no status-derived freeze), `publishEvent` (refuses `PUBLISHED`, `CANCELLED`, `COMPLETED`; requires future `startAt` + sellable quota), `unpublishEvent` (`PUBLISHED` only), `cancelEvent` (CAS from `PUBLISHED\|ONGOING` + `cancelledAt: null`; expires `PENDING_PAYMENT` orders via `releaseOrderReservations` + `voidOpenPayments`), `archiveEvent` (any non-archived; refuses `OPEN_REFUND_STATUSES`; CAS on `archivedAt: null`), `deleteEvent` (DRAFT only, zero orders/tickets). |
| `lib/events/catalog.ts` | `publicVisibilityWhere`: `status: "PUBLISHED"`, `visibility: "PUBLIC"`, `archivedAt: null`, past-filter `endAt >= now` else `startAt >= now`. Detail: `isAvailable` for `PUBLISHED\|ONGOING\|COMPLETED`; `ARCHIVED` → 404; `PRIVATE` → 404. `requiresCheckIn` deliberately **not** exposed. |
| `lib/ticketing/reservations.ts` | `expireDueReservations({batchSize=100, now})` — bounded, CAS-guarded, one transaction per order, per-order lock order (order row → reservations → ticket types), unwired outside tests. |
| `lib/ticketing/checkin/service.ts` | `requireEventCheckInAccess` (`checkin.scan` + assignment when the actor lacks `checkin.override`), `normalizeCode` (accepts `EVT-XXXX-XXXX` and `TICKET:…`), gate predicate check, `WRONG_EVENT`, transactional CAS + `CheckIn` insert, `ALREADY_CHECKED_IN` with first-admission details, refusals recorded, `checkin.success`/`checkin.rejected` audits. |
| `lib/ticketing/refunds/eligibility.ts` | Pure `D-R03..D-R10`; `D-R05` refuses a refund for a `CHECKED_IN` ticket; `D-R10` refuses a second claim via `RefundItem` uniqueness. |
| `lib/authz/permissions.ts` | `ORGANIZER_SCOPE` includes the three `checkin.*` keys; `OWNER`/`MANAGER`/platform `ADMIN` hold `scan`+`override`+`log.read`; `CHECKIN_STAFF` holds only `scan`+`log.read`; `FINANCE` holds **none** of them; platform `PIC` holds no organizer capability; membership `PIC` holds only `pic_attribution.read.all`. |
| `app/api/organizer/events/**` | `route.ts`, `[id]/{route,publish,unpublish,cancel,archive,images,ticket-types,check-in}`. **No `complete` route, no `ongoing` route, no internal/jobs route.** |
| `app/dashboard/events/[id]/page.tsx` + `components/organizer/{EventActions,CheckInPanel}.tsx` | Actions gated on current status (DRAFT→publish/delete, PUBLISHED→unpublish/cancel/archive, ONGOING→cancel/archive, COMPLETED→archive, CANCELLED→archive, ARCHIVED→none). Panel rendered only when the server resolved `checkin.scan` and the gate is open. **No "complete" action.** |
| `lib/ticketing/tickets/reference.ts` / `payload.ts` | `TICKET_QR_PREFIX = "TICKET:"`; `buildTicketQrPayload` = `TICKET:<ticketCode>`; `generateQrToken` (32 bytes, base64url) + `hashQrToken` (SHA-256) exist and are used at issuance only; wallet list excludes the QR; detail returns `{payload, renderer:"qrcode.react", version}` and `admission.scannable`. |
| `jest.config.js`, `__tests__/**` | 59 detected test files, 53 suites / 1200 tests at the Phase 13 baseline; the check-in suites already pin `qrTokenHash` never being read and `QR_SCAN` never being written. |

### 2.6 Deployment / infrastructure (new evidence this phase)

| Fact | Evidence |
|---|---|
| Target is a **single VPS** | `.github/workflows/deploy.yml` SSHes to a VPS secret and runs `./deploy.sh` in `~/demo-marketplace`; design §40.9 names "a single VPS" (`SOURCE FACT`). |
| Custom Node server | `server.js` (`next({dev:false})` + `http.createServer`) exists; production start path is not Vercel (`SOURCE FACT`). |
| No platform cron | no `vercel.json`; not a Vercel deployment (`SOURCE FACT`). |
| No Redis/queue/cron dependency | `package.json` dependencies contain no `bullmq`, `ioredis`/`redis`, `node-cron`, or `agenda`; scripts are only `dev`, `build`, `start`, `lint`, `audit:ipaymu`, `seed:organizer` (`SOURCE FACT`). |
| No internal job route | `app/api/internal/**` does not exist (`SOURCE FACT`). |

---

## 3. Current State Machine — `CURRENT WHAT CODE DOES`

| FROM | TO | Trigger | Actor / authz | Precondition | Side effect | Status |
|---|---|---|---|---|---|---|
| — | `DRAFT` | `createEvent` | `event.write` | valid sport/venue/dates; `startAt` future; `endAt > startAt` | slug/eventCode server-side; `status` not client-writable | `EXISTING BEHAVIOR` |
| `DRAFT` | `PUBLISHED` | `publishEvent` | `event.publish` | ≥1 active `TicketType` with `quota > 0`; `startAt` future | `publishedAt` first-publish; appears in catalog | `EXISTING BEHAVIOR` |
| `PUBLISHED` | `DRAFT` | `unpublishEvent` | `event.publish` | status is exactly `PUBLISHED` | hidden from listings; read-only detail kept; orders/tickets untouched | `EXISTING BEHAVIOR` (D-14) |
| `PUBLISHED`/`ONGOING` | `CANCELLED` | `cancelEvent` | `event.publish` | CAS `status ∈ {PUBLISHED,ONGOING} AND archivedAt IS NULL` | `cancelledAt`; `PENDING_PAYMENT` orders → `EXPIRED` (seats released, payments voided); **no refund, no ticket void** | `EXISTING BEHAVIOR` |
| any non-`ARCHIVED` | `ARCHIVED` | `archiveEvent` | `event.publish` | no `Refund.status ∈ {PENDING,APPROVED,PROCESSING}`; CAS `archivedAt IS NULL` | `archivedAt`; hidden from every public surface; nothing deleted | `EXISTING BEHAVIOR` |
| `DRAFT` | deleted | `deleteEvent` | `event.publish` | zero orders, zero tickets | hard delete (+ ticket types/reservations in one transaction) | `EXISTING BEHAVIOR` |
| `PUBLISHED` | `ONGOING` | — | — | — | **not implemented; `ONGOING` unreachable** | `EXISTING BEHAVIOR` |
| `PUBLISHED` | `COMPLETED` | — | — | — | **not implemented** | `EXISTING BEHAVIOR` |
| `ISSUED` | `CHECKED_IN` | `checkInTicket` | `checkin.scan` (+ assignment for staff without `checkin.override`) | gate open; ticket belongs to event; CAS `status='ISSUED' AND checkedInAt IS NULL` | `checkedInAt`; one `CheckIn` row (UNIQUE `ticketId`); `checkin.success` | `EXISTING BEHAVIOR` |
| `ISSUED` | `REFUNDED` | refund settlement | provider confirmation | `D-R03..D-R10`; `D-R05` refuses `CHECKED_IN` | `refundedAt`; quota per policy; order refunded totals | `EXISTING BEHAVIOR` |
| `ISSUED` | `VOID` | — | — | `ticket.void` is design-only | — | **not implemented** |

**Contradictions recorded (not resolved by Phase 13):** `PENDING_REVIEW` and `ONGOING` exist in the enum but not in the design's `EventStatus`; `requiresCheckIn` is stored, editable, and read by nothing; the gate predicate cannot express time; `COMPLETED` is purchasable and its `endAt` is editable.

---

## 4. Final Event State Machine

```
                    createEvent
                        │
                        ▼
                     DRAFT ──────────delete (hard, draft+zero commercial history)───► gone
                        │
                   publish (manual, event.publish)
                        ▼
                    PUBLISHED ─────unpublish (manual, event.publish)──────────────► DRAFT
                        │
        scheduler: now >= startAt  (automatic, monotonic)
                        ▼
                     ONGOING
                        │
   scheduler: now >= endAt + 30m   ────────┐
   manual: event.publish, endAt passed ────┤
                        ▼                  ▼
                    COMPLETED ◄────────────┘
                        │
  PUBLISHED/ONGOING/COMPLETED/CANCELLED ──archive (manual, event.publish)──► ARCHIVED (terminal)
                        │
  PUBLISHED/ONGOING ────cancel (manual, event.publish)──────────────────────► CANCELLED
                        │
                    (CANCELLED) ──archive──► ARCHIVED (terminal)
```

`ONGOING` is entered **only** automatically. `CANCELLED` is entered **only** manually. `ARCHIVED` is terminal for every state.

### 4.1 Answers to the mandatory lifecycle questions (brief §4)

| # | Question | Answer | Label |
|---|---|---|---|
| 1 | Is `ONGOING` retained? | **Yes**, as a real automated state. | `PRODUCT DECISION — LOCKED` (P14-D01) |
| 2 | What does `ONGOING` mean? | "This event has started and has not finished." It is the interval `[startAt, endAt + grace)`. | `PRODUCT DECISION — LOCKED` |
| 3 | Which of: event running / sales finished / gate active / combination? | **Event running** and, as a consequence, **the gate is active**. It does **not** mean sales are finished. | `PRODUCT DECISION — LOCKED` |
| 4 | Trigger `PUBLISHED → ONGOING`? | The **scheduler**, when `now >= startAt`. No manual entry. | `PRODUCT DECISION — LOCKED` |
| 5 | Is `startAt` required for `ONGOING`? | Yes, and it is guaranteed: `Event.startAt` is `DateTime` NOT NULL. | `SOURCE FACT` |
| 6 | What if `startAt` is null? | Impossible — the column is NOT NULL. (The handler still treats a null defensively as "not yet started".) | `SOURCE FACT` |
| 7 | What if `startAt` has already passed when the event is first published? | Cannot happen at publish time: `publishEvent` requires `startAt` in the future. After publish it is normal, and the next tick makes it `ONGOING` (catch-up). | `EXISTING BEHAVIOR` + `DESIGN FACT` §10.3 |
| 8 | May a `PUBLISHED` event without `startAt` be sold? | Moot (`startAt` is required). A `PUBLISHED` event sells per its sales window, not per `startAt`. | `SOURCE FACT` |
| 9 | May `ONGOING` be set manually? | **No.** The state exists to be derived; a manual entry is not offered. | `PRODUCT DECISION — LOCKED` (P14-D02) |
| 10 | Who may perform manual transitions? | An actor holding **`event.publish`** in the event's tenant (OWNER, MANAGER, platform ADMIN-with-membership). No new permission key is introduced. | `DESIGN FACT` §6.3 + `EXISTING BEHAVIOR` |
| 11 | May `ONGOING` return to `PUBLISHED`? | **No.** Monotonic. `publishEvent` must refuse `ONGOING` (today it would not — Phase 15 fix). | `PRODUCT DECISION — LOCKED` (P14-D03) |
| 12 | May `ONGOING` go directly to `CANCELLED`? | **Yes** (existing contract). | `EXISTING BEHAVIOR` |
| 13 | May `ONGOING` be `ARCHIVED`? | **Yes** (archive is permitted from any non-archived state — ratified). | `PRODUCT DECISION — LOCKED` (P14-D08) |
| 14 | Is `COMPLETED` reachable manually? | **Yes** — `event.publish` holder, once `endAt` has passed. | `DESIGN FACT` §10.3 + `PRODUCT DECISION — LOCKED` (P14-D05) |
| 15 | Is `COMPLETED` automatic? | **Yes** — scheduler at `now >= endAt + grace`. | `PRODUCT DECISION — LOCKED` (P14-D04) |
| 16 | Can `COMPLETED` be reached only when `endAt` exists? | **Yes.** Auto and manual completion both require `endAt IS NOT NULL`. | `DESIGN FACT` §10.3 (precondition "past `endAt`") + `PRODUCT DECISION — LOCKED` (P14-D22) |
| 17 | What if `endAt` is null? | The event **never completes**. It stays `PUBLISHED`/`ONGOING` (gate open, sales per window) until it is **cancelled** or **archived**. This is the conservative reading of a precondition that cannot be satisfied. | `PRODUCT DECISION — LOCKED` (P14-D22, derived) |
| 18 | Is `COMPLETED` terminal before `ARCHIVED`? | **Yes.** `COMPLETED` is terminal except for `→ ARCHIVED`. | `PRODUCT DECISION — LOCKED` |
| 19 | Can `COMPLETED` be `CANCELLED`? | **No.** | `PRODUCT DECISION — LOCKED` |
| 20 | Can `CANCELLED` be `COMPLETED`? | **No.** | `PRODUCT DECISION — LOCKED` |
| 21 | Is `ARCHIVED` always terminal? | **Yes.** No transition leaves `ARCHIVED`. | `EXISTING BEHAVIOR` + `PRODUCT DECISION — LOCKED` |

**No `PRODUCT DECISION REQUIRED` remains in this section.**

---

## 5. ONGOING Contract

**Definition (`PRODUCT DECISION — LOCKED`, P14-D01).** `ONGOING` is the automated statement "this event has begun". It is a derived state over the pair (`startAt`, `endAt`), not a business workflow:

```
ONGOING  ⇔  status ∈ {PUBLISHED, ONGOING}  ∧  now >= startAt  ∧  NOT (now >= endAt + grace)   [endAt ≠ null]
ONGOING  ⇔  status ∈ {PUBLISHED, ONGOING}  ∧  now >= startAt                                 [endAt = null]
```

| Property | Contract |
|---|---|
| Trigger | Scheduler tick when `now >= startAt`. |
| Actor | `SYSTEM` (audit `actorType: SYSTEM`), organizer from the event row. |
| Permission | None — system-only. |
| Manual entry | **Forbidden.** No endpoint, no service export, no status field on the edit form. |
| Preconditions | `status = 'PUBLISHED'` AND `archivedAt IS NULL` AND `cancelledAt IS NULL` AND `startAt <= now` AND (`endAt IS NULL` OR `endAt + 30m > now`). |
| Side effects | `status = 'ONGOING'` only. **No** order, ticket, payment, refund, quota or notification change. |
| Idempotency | The conditional `UPDATE` is the guard: a second run finds no `PUBLISHED` row past `startAt` and reports 0. |
| Reversibility | None (monotonic). `ONGOING → PUBLISHED` is impossible by contract. |
| Display | Catalog listings **include** `ONGOING`; public detail already treats `ONGOING` as available. |
| Sales | `ONGOING` does **not** stop sales by itself; the sales window does (§8). |
| Gate | `ONGOING` keeps the gate open until `endAt + grace`. |

**Catch-up rule.** A single tick that is late (scheduler downtime) must resolve the final state in one pass without inventing intermediate history: if `now >= endAt + grace`, the row goes `PUBLISHED → COMPLETED` directly; the design's `ONGOING` interval is derivable from `startAt` and needs no stored trace. No `ongoingAt` column is added (`PRODUCT DECISION — LOCKED`, P14-D20).

---

## 6. COMPLETED Contract

**Definition (`PRODUCT DECISION — LOCKED`).** `COMPLETED` means "this event is over". The completion instant is `endAt + 30 minutes`.

| Property | Contract |
|---|---|
| Automatic trigger | Scheduler tick when `now >= endAt + CHECK_IN_GRACE` and `endAt IS NOT NULL`. From `PUBLISHED` or `ONGOING` (catch-up allowed). |
| Manual trigger | `event.publish` holder, precondition `endAt IS NOT NULL AND now >= endAt`. Idempotent: completing a `COMPLETED` event returns the row unchanged and writes no second audit row. |
| Preconditions (both paths) | `archivedAt IS NULL` AND `cancelledAt IS NULL` AND `endAt IS NOT NULL`. |
| Allowed FROM | `PUBLISHED`, `ONGOING`. |
| Allowed TO | `COMPLETED` only. |
| Terminal? | Terminal for every transition except `→ ARCHIVED`. |
| Side effects | `status = 'COMPLETED'`, `completedAt = <observation instant>`. Sales **stop** (§8). Check-in continues **only** while `now <= endAt + grace` (which, for an automatic completion, is already false — the grace is what defines the boundary). No order, payment, refund, ticket or quota mutation. |
| Timing semantics | `completedAt` records **when the platform committed the transition** (like `Ticket.checkedInAt` = server clock), not the scheduled instant. The scheduled instant stays derivable as `endAt + 30m`. A single tick passes **one** `now` to every job so a boundary cannot be straddled mid-run. |
| `endAt` null | Never completes (auto or manual). Paths out of `PUBLISHED`/`ONGOING` are `CANCELLED` or `ARCHIVED` (`P14-D22`). |
| Reversal | `COMPLETED → ONGOING` and `COMPLETED → PUBLISHED` are impossible. `COMPLETED → CANCELLED` is impossible. |
| `endAt` after completion | Frozen — further edits are rejected (§20). |
| Public display | Detail page available and readable (`isAvailable` already true); listings exclude it via the past-event filter and via status (§8). |

---

## 7. Grace Window

`PRODUCT DECISION — LOCKED` (P14-D06): **`CHECK_IN_GRACE_MINUTES = 30`.**

| Question (brief §6) | Answer |
|---|---|
| Value | **30 minutes.** |
| Basis | The design fixes the instant (`past endAt`) but no value. 30 minutes is chosen as the product owner's decision; it is short enough that a `COMPLETED` event is honest and long enough to absorb the tail of a live gate (queue at the door, a late scan, a scanner reconnect). It also keeps the worst-case completion lag at 31 minutes with the design's 1-minute tick. |
| Configurable globally? | **No.** A fixed exported constant, one source of truth. No `PlatformSetting` column is added (avoids a migration and an untestable configuration surface). |
| Per event? | **No.** |
| Per ticket type? | **No.** |
| Fixed? | **Yes** — a single exported constant. |
| Measured from | `endAt` (`endAt + grace`). Never from `startAt`. |
| Scheduler predicate | `now >= endAt + grace` (inclusive `>=`, matching the gate's strict `<` window). |

**Behaviour table (R = required, this is the gate contract):**

| Instant | Gate status | Event status |
|---|---|---|
| `now < endAt` (or `endAt` null and status live) | check-in **allowed** | `PUBLISHED` or `ONGOING` |
| `endAt <= now < endAt + 30m` | check-in **allowed** (grace) | `PUBLISHED`/`ONGOING`, or `COMPLETED` if manually completed inside the window |
| `now >= endAt + 30m` | check-in **denied** (`EVENT_NOT_OPEN`, `details.reason = EVENT_NOT_OPEN`, `status: COMPLETED`) | `COMPLETED` |
| `cancelledAt` or `archivedAt` set | check-in **denied** (fail-closed) | `CANCELLED`/`ARCHIVED` |

**COMPLETED timing is explicit** (brief §6): completion happens exactly at `endAt + 30m` (observed by the next tick within 1 minute), or earlier only by an explicit manual action after `endAt`.

**Underlying divergence to fix (`EXISTING BEHAVIOR`):** `isEventCheckInOpen` today takes `{status, archivedAt, cancelledAt}` and returns true for `COMPLETED` **forever**. Phase 15 must widen it (see §23) to include `endAt` and `now`; until then, a `COMPLETED` event keeps its gate open indefinitely, which contradicts this lock.

---

## 8. Sales Window Relationship

`isPurchasable` has exactly one source of truth after this lock (`PRODUCT DECISION — LOCKED`, P14-D11):

```
purchasable(event, ticketType, now)
  = event.status ∈ {PUBLISHED, ONGOING}          ← lifecycle gate (COMPLETED excluded)
    ∧ event.visibility ≠ PRIVATE
    ∧ event.archivedAt IS NULL
    ∧ event.cancelledAt IS NULL
    ∧ classifySalesState(ticketType, event, now) = OPEN
```

| Question (brief §5) | Answer | Label |
|---|---|---|
| Does `ONGOING` stop sales? | **No.** `ONGOING` is a time statement, not a commercial one. | `PRODUCT DECISION — LOCKED` |
| Does `COMPLETED` stop sales? | **Yes.** Design §10.3: "Sales stop". Today's code keeps selling a `COMPLETED` event — that divergence is closed in favour of the design. | `DESIGN FACT` + `PRODUCT DECISION — LOCKED` |
| Relationship to `salesStartAt`/`salesEndAt` | Unchanged: the **ticket type** window overrides the event window (`type.salesStartAt ?? event.salesStartAt ?? null`; `type.salesEndAt ?? event.salesEndAt ?? event.startAt`). Null start = "immediately after publish"; null end = "until event start" (design §10.2). | `SOURCE FACT` + `DESIGN FACT` |
| May `salesEndAt` be later than `endAt`? | **Allowed** (no new validation is added). But because completion closes sales, an event completing at `endAt + 30m` stops selling then regardless of a later `salesEndAt`. The effective window end is `min(salesEndAt, endAt + grace)`. | `PRODUCT DECISION — LOCKED` |
| May an event still be sold while `ONGOING`? | **Yes**, if the window is open. | `PRODUCT DECISION — LOCKED` |
| Does a ticket-type window override the lifecycle? | **No.** Ticket-type windows are an inner gate; the lifecycle/visibility/cancellation gate is outer and cannot be opened by any window. | `PRODUCT DECISION — LOCKED` |
| `isPurchasable` source of truth | `lib/events/sales-state.ts#isEventPurchasable` (used by checkout + reservation CAS). The catalog's inline availability expression must agree with it; the two must be reconciled, not forked. | `SOURCE FACT` |

**Catalog listing rule (`PRODUCT DECISION — LOCKED`).** `publicVisibilityWhere` must include `status ∈ {PUBLISHED, ONGOING}` (today it is `PUBLISHED` only, which would hide every live event the moment `ONGOING` becomes reachable). `CANCELLED`, `ARCHIVED`, `DRAFT` remain excluded; the existing past-event filter (`endAt >= now`, else `startAt >= now`) is retained unchanged — the graceful filter for the past-event display is **out of scope** (`P14-D24`).

---

## 9. Refund vs Check-in — `D-28` closed

`PRODUCT DECISION — LOCKED` (P14-D15): **a ticket with an OPEN refund request is blocked from check-in.**

**Definition of "open".** A `RefundItem` exists for the ticket whose parent `Refund.status ∈ {PENDING, APPROVED, PROCESSING}` (`DESIGN FACT` §18.4 names `PENDING` as the request state; §18.2's enum gives the three in-flight values).

| Refund state | Check-in | Reason |
|---|---|---|
| `PENDING` | **Blocked** | A claimed ticket must not also be admitted — design §18.4: admitting a refunded attendee is a loss. |
| `APPROVED` | **Blocked** | Money is authorised; quota has not moved but the claim is live. |
| `PROCESSING` | **Blocked** | Provider call in flight; admitting would create an admitted-but-refunding attendee. |
| `REJECTED` | **Allowed** | Claim released; the ticket is valid and unsold. |
| `FAILED` | **Allowed** | Nothing moved; retryable. |
| `REFUNDED` | **Impossible** (CAS) | `Ticket.status = REFUNDED`, so the admission CAS (`status='ISSUED'`) refuses. |

**Error / result contract.**

| Layer | Value |
|---|---|
| `CheckInResult` | New value **`REFUND_PENDING`** — additive enum migration (`ALTER TABLE checkin MODIFY result ENUM(...)`, appended). The design's name is `REJECTED_REFUND_PENDING`; the shipped enum uses un-prefixed names, so the shipped convention wins (precedent: `WRONG_EVENT`, not `REJECTED_WRONG_EVENT`). |
| HTTP | `409 CONFLICT` (same class as `TICKET_NOT_ISSUED`/`WRONG_EVENT`). |
| Body | `details.reason = "REFUND_PENDING"` (no refund amounts, no requester identity, no order data). |
| Evidence | A refusal `CheckIn` row (`ticketId: null`, `result: REFUND_PENDING`, code kept in `note`) + a `checkin.rejected` audit row with `reason = REFUND_PENDING`. |
| Reuse of `INVALID_TICKET` | **Rejected.** It would destroy the distinction between "not a valid credential" and "valid but commercially claimed", which is the whole point of recording refusals. |

**Invariants (both directions, both old and new).**

1. No `CHECKED_IN → REFUNDED`: `D-R05` refuses the claim (`REFUND_NOT_ALLOWED`) — `EXISTING BEHAVIOR`, unchanged.
2. No `REFUNDED → CHECKED_IN`: the admission CAS requires `ISSUED` — `EXISTING BEHAVIOR`, unchanged.
3. **New:** no committed pair (open refund ∧ `CHECKED_IN`). A ticket that is `CHECKED_IN` may not be under an open refund, and a ticket under an open refund may not be admitted.

**Race contract (brief §7).** The two writers are `checkInTicket` (CAS on `Ticket`) and `requestRefund` (creates a `RefundItem`). Phase 15 must guarantee that they contend so that only one of the two states commits:

- The open-refund predicate is evaluated **inside** the admission transaction, immediately before the CAS — never in a separate pre-read that decides the outcome by itself.
- Both paths must serialize on the **ticket row** with one documented lock order (ticket → `RefundItem`), and the `RefundItem` uniqueness for the ticket (`D-R10`) remains the second, structural guard.
- A real-DB concurrent test must prove exactly one winner (see §23 tests). The implementation mechanism (a locking read on the ticket row, or a single conditional `UPDATE … WHERE status='ISSUED' AND NOT EXISTS (open refund claim)`) is an implementation choice, but the **outcome** is fixed by this contract.
- Because `Refund` rows can be created by a buyer (`refund.request.own`) without an organizer in the loop, the guard must be evaluated per request, not cached per event.

**Migration note (`PRODUCT DECISION — LOCKED`, P14-D20).** Exactly one schema change is required for `D-28`: append `REFUND_PENDING` to the `CheckInResult` enum. Adding a value is non-destructive; removing/renaming values is not, and is not proposed.

---

## 10. `requiresCheckIn`

`PRODUCT DECISION — LOCKED` (P14-D13): **`false` is a SOFT gate-free declaration.** The field describes whether admission is a *product requirement*, not whether the endpoint is technically usable.

| Surface | `requiresCheckIn = true` (default) | `requiresCheckIn = false` |
|---|---|---|
| Meaning (design §10.2) | The event has a real gate; attendance is tracked per ticket. | "Merchandise / spectator-free" event — no admission gate is required. |
| Dashboard check-in panel | Shown (when `checkin.scan` resolves and the gate predicate is open). | **Soft-hidden by default**: the section is not offered as the primary workflow; if shown at all it must be explicitly labelled as optional/not required. |
| Check-in endpoint | Works as today. | **Still works.** No change to authorization, CAS, or the ticket contract. A staff member who needs to admit someone is never locked out by a flag they cannot change at the door. |
| Attendance semantics | Admission count is the attendance contract. | Admission rows remain valid evidence but are **informational**: reporting must not treat "not checked in" as an anomaly on an ungated event. |
| Ticket issuance | Unaffected. | Unaffected. |
| Ticket validity | Unaffected. | Unaffected — the ticket does not "stay valid longer". |
| Event completion | Unaffected: completion is time-driven, never attendance-driven. | Unaffected. |
| Refund | Unaffected: `D-R05` still refuses a refund for a ticket that *was* checked in. | Unaffected. |
| Public UI / API | `requiresCheckIn` stays **out** of the public payload (catalog deliberately omits it — `SOURCE FACT`). | Same. |
| Reporting | Gate metrics are meaningful. | Gate metrics are labelled as not-required. |

**Explicit non-effects.** `requiresCheckIn` does not gate publishing, does not affect the sales window, does not stop the scheduler, does not change `CheckInResult`, and does not create an override path around `D-28`. It is a declaration consumed by the dashboard and reporting only.

---

## 11. QR / `D-46` — closed

`PRODUCT DECISION — LOCKED` (P14-D17): **Option A — the Phase 13 contract is ratified as the final contract.**

| Question (brief §9) | Final answer | Label |
|---|---|---|
| 1. Where is the raw token available? | **Nowhere.** It is minted at issuance (`generateQrToken`, 32 bytes, base64url) and returned only inside the issuance/booking path that consumes it; it is delivered to no client, no email, no page. | `SOURCE FACT` + `PRODUCT DECISION — LOCKED` |
| 2. Is it stored in the database? | **No.** Only `Ticket.qrTokenHash` (SHA-256) is persisted. This is the design's §19.1/§19.3 requirement ("a DB leak must not yield scannable tickets"). | `SOURCE FACT` |
| 3. May a ticket payload API contain the raw token? | **No.** The wallet list already excludes the QR; the detail returns the **public-code** payload only. | `SOURCE FACT` (design §26.5) |
| 4. May a browser client receive the raw token? | **No.** Design §26.6 marks "return the permanent `qrToken` to the browser" as **Rejected**. | `DESIGN FACT` |
| 5. QR value | **`TICKET:<ticketCode>`** — namespaced, non-PII, not a URL, stable for the ticket's life. | `SOURCE FACT` + `PRODUCT DECISION — LOCKED` |
| 6. Is `ticketCode` still the fallback? | It is not a fallback; it is **the** credential this cycle. The manual path (design §20.6) is the supported admission path. | `PRODUCT DECISION — LOCKED` |
| 7. Are both `QR_SCAN` and `MANUAL` retained? | `MANUAL` is written. **`QR_SCAN` remains unused** and must not be written while no token ever reaches a scanner. | `EXISTING BEHAVIOR` + `PRODUCT DECISION — LOCKED` |
| 8. Raw token in a URL? | **Forbidden.** (Design §19.3's `?k=` URL is part of the *other* candidate design, which is not adopted.) | `PRODUCT DECISION — LOCKED` |
| 9. Raw token in logs? | **Forbidden.** | `DESIGN FACT` §19.4 + `PRODUCT DECISION — LOCKED` |
| 10. Raw token in analytics? | **Forbidden.** | `PRODUCT DECISION — LOCKED` |
| 11. Raw token in audit state? | **Forbidden.** `qrToken` is on the audit deny-list; `entityRef` carries the `ticketCode`, which is a public reference, never a secret. | `SOURCE FACT` |

**Consequence.** `D-46` no longer blocks anything. Phase 16 is **not blocked**; it is reduced to optional hardening under this contract (§24).

**Accepted trade-off (stated, not hidden).** The admitted credential is a **public code**, so its safety rests on authorization (tenant-scoped `checkin.scan`, plus `StaffEventAssignment` for pure gate staff), the one-admission CAS, and the UNIQUE `CheckIn.ticketId` — exactly as Phase 13 documented. The design's stronger token credential stays available for a future reversal of `D-46`, but is not required now.

---

## 12. Scheduler Options

`INFRASTRUCTURE DECISION — LOCKED` (P14-D09): **Option A — DB-backed tick route + external cron.**

Deployment facts that decide this (`SOURCE FACT`): target is a **single VPS** deployed by `deploy.sh` from GitHub Actions; a custom `server.js` runs Next in production; there is no `vercel.json`; no Redis/queue/cron dependency exists; the design itself flags Redis as a stateful single-VPS burden (§40.9) while specifying a "persistent job queue (DB-backed)" (§21.2).

| Criterion | A: DB tick + external cron | B: platform cron | C: BullMQ + Redis |
|---|---|---|---|
| New dependency | **None** (a table + an env secret) | None, but requires a platform that is not the deployment target | Redis + BullMQ + a worker runtime |
| Deployment complexity | One crontab line on the VPS already running the app | N/A here (not a Vercel deployment) | New supervised process, persistence, monitoring, health checks |
| Persistence | DB rows are the truth; the lock row survives restarts | Same as A, plus a vendor scheduler | Queue state in Redis; a Redis loss must be designed for |
| Retry | Re-entrant by construction: the next tick re-runs the same predicates | Same as A | Built-in, with its own semantics to reconcile with our CAS rules |
| Idempotency | CAS + lease: a duplicate invocation is a no-op | Same as A | Supported, but must be mapped onto the same CAS rules anyway |
| Observability | Tick response JSON + `JobLock.lastRunAt/lastStatus` + per-transition audit rows | Vendor logs | Redis/BullMQ UI + worker logs |
| VPS compatibility | **Native** | Poor (wrong target) | Possible but adds the dependency §40.9 warns about |
| Local development | `curl` the tick route, or call the service directly in tests — no infra | Not local | Needs a local Redis for every developer and for CI |
| Architecture compatibility | Matches P-3's recorded gap and §21.2's DB-backed shape; reuses `expireDueReservations` as-is | Same | Design's implied shape, largest change |
| Impact on reservation reaper | **Wires it**: JOB 2 is the existing, already-tested `expireDueReservations` | Same | Requires porting the reaper into a worker |

Option A is chosen because it adds no new runtime dependency on the single VPS, is deployable with the mechanism the project already uses, is testable without infrastructure, and finally closes the unwired-reaper gap that Phase 13 flagged.

---

## 13. Final Scheduler Contract

**Business logic never lives in cron.** The scheduler only triggers; the service owns authorization/system-actor, state predicate, CAS, idempotency, transaction and audit (`PRODUCT DECISION — LOCKED`, P14-D10).

### 13.1 Trigger

| Property | Contract |
|---|---|
| Endpoint | `POST /api/internal/jobs/tick` (new, under `/api/internal/**`). |
| Authentication | `Authorization: Bearer $JOBS_TICK_SECRET`, compared in constant time. Missing/incorrect ⇒ `401` with no detail. The route is session-independent and must **not** be reachable as an organizer route; the secret is the only authorization. |
| Invocation | VPS crontab, **every 1 minute** (`* * * * *`), matching design §11.4's stated reaper cadence. Invoked via `curl` (or a tiny `scripts/jobs-tick.mjs`) from the deploy target's crontab; documented in the Phase 15 report. |
| Response | `200` with a per-job summary: `{ ok, now, jobs: { eventLifecycle: {toOngoing, toCompleted, scanned}, reservationExpiry: {ordersExpired, reservationsExpired, seatsReleased, scanned} }, durationMs }`. Per-job failure is reported as `ok:false` with the error, **without** failing the other job. |
| Idempotency | Every job is a bounded, re-runnable batch guarded by conditional writes; running the tick twice in a row is a no-op. |
| Overlap | Prevented by a DB lease (§13.3); if two ticks race anyway, the CAS write is what decides the winner, not the lease. |

### 13.2 Jobs — exactly two

| Job | Body | Frequency | Batch | Transaction boundary | Tenant safety |
|---|---|---|---|---|---|
| **JOB 1 — Event lifecycle** | `advanceEventLifecycleBatch(now, batchSize)`: `PUBLISHED → ONGOING` for rows with `startAt <= now` and not yet `endAt + grace`; then `{PUBLISHED, ONGOING} → COMPLETED` for rows with `endAt + grace <= now`. One conditional `updateMany` per step carrying the full predicate. | Every tick (1 min) | 200 events per run, ordered `endAt asc, id asc` (nulls last for step 1 by `startAt asc, id asc`) | **None needed**: a single-statement state change with no dependent rows. One audit row per transitioned event, written after commit. | Global scan, but each row is transitioned by its own id + status predicate; `organizerId` for the audit comes from the row. No tenant data crosses. |
| **JOB 2 — Reservation expiry** | The existing `expireDueReservations({ now, batchSize: 100 })`. **No rewrite.** | Every tick (1 min) | 100 orders per run | Already one transaction per order (order row → reservations → ticket types), unchanged. | Unchanged. Job is status-based, not tenant-based; each order keeps its own `organizerId` for the audit. |

**No third job is introduced.** Notifications, counters, payouts and cleanup remain out of scope (`P14-D24`).

### 13.3 Single-flight / lock strategy

- A new `JobLock` row per job (`name` primary key: `tick:event-lifecycle`, `tick:reservation-expiry`) with `lockedUntil`, `lockedBy`, `lastRunAt`, `lastStatus`.
- Acquisition is a conditional write (CAS): claim only when `lockedUntil IS NULL OR lockedUntil < now`, setting `lockedUntil = now + 5 minutes` and a per-invocation `lockedBy`. `count === 1` means this invocation owns the job.
- Lease expiry (5 minutes) allows takeover after a crash; the transition CAS still guarantees correctness even if two invocations ever ran concurrently (the lease is an efficiency and observability guard, not the correctness guard).
- Release on completion by clearing `lockedUntil` and recording `lastRunAt`/`lastStatus`.
- Rejected alternative: MySQL `GET_LOCK` — connection-scoped, unreliable through Prisma's pool. Rejected alternative: process-level `setInterval` — forbidden by the brief and wrong on a multi-instance VPS (Phase 13 recorded this).
- Every attempt, accepted or skipped, is observable via `lastRunAt`/`lastStatus`; skipped invocations do not write audit rows.

### 13.4 Failure, retry, duplicate invocation

| Case | Contract |
|---|---|
| JOB 1 fails (DB error) | JOB 2 still runs. Response marks `eventLifecycle.ok = false` with the error; the lease is released so the next minute retries. |
| JOB 2 fails | Mirror of the above. |
| Tick invoked twice concurrently | Lease admits one; even without the lease, the conditional writes make the second a no-op. |
| Tick invoked while a previous run is mid-batch | The lease blocks it; a stale lease (>5 min) is taken over and the CAS protects correctness. |
| Cron not installed / down for hours | No corruption: the next tick resolves the final state in one pass (catch-up), because every job is a predicate over current time, not a queue of missed events. |
| Failure of one event inside the batch | The batch statement is atomic per step; an audit write failure must not roll back the transition (consistent with the existing cancel/archive pattern) and must be reported as a warning in the response. |

---

## 14. Cancellation

`PRODUCT DECISION — LOCKED` (P14-D07): **the Phase 12 contract is ratified exactly.** No auto-refund, no auto-void, no money reversal, no callback into the ledger.

| Property | Contract |
|---|---|
| Allowed FROM | `PUBLISHED`, `ONGOING` (unchanged). **Not** from `COMPLETED`, `DRAFT`, `ARCHIVED`. |
| Actor / permission | `event.publish` (unchanged). No Finance-approval step is added (`P12-D4` remains out of scope). |
| CAS | `status = expectedCurrent AND archivedAt IS NULL`; a losing writer gets a conflict. |
| Side effects | `cancelledAt` + `cancelReason`; every `PENDING_PAYMENT` order → `EXPIRED` with seats released and open payments voided; **no refund, no ticket void**; audit `event.cancel` with explicit `refundTriggered: false`, `ticketsVoided: false`. |
| Paid orders / issued tickets | Untouched. |
| Already-admitted people | Stay `CHECKED_IN` (Phase 13 guarantee). |
| Gate after cancel | Closed, fail-closed (`cancelledAt` is in the predicate). |
| Idempotency | Cancelling an already-cancelled event returns the row unchanged and writes no second audit row. |
| Scheduler treatment | **`CANCELLED`: skipped.** Every job predicate requires `cancelledAt IS NULL`. `ARCHIVED`: **skipped** (`archivedAt IS NULL`). `COMPLETED`: **skipped** (not in the FROM set). |

---

## 15. Archive

`PRODUCT DECISION — LOCKED` (P14-D08): **keep the Phase 12 widening — Option B.**

| Option | Contract | Consequence |
|---|---|---|
| A: only `COMPLETED`/`CANCELLED` | Design §10.3's diagram | Would require a completed event before archiving. Now technically available (completion ships in Phase 15), but it would still forbid archiving a `PUBLISHED` event that is simply being retired without a cancellation claim. |
| **B: any non-`ARCHIVED`** (chosen) | Archiving is permitted from any state except `ARCHIVED`, subject to the documented precondition. | A live event can be hidden deliberately; the precondition still protects money. Consequence stated: `ARCHIVED` is reachable from `PUBLISHED`, which is a *wider* rule than the design's — recorded as the decision, not presented as the design's rule. |

| Property | Contract |
|---|---|
| Allowed FROM | `DRAFT`, `PENDING_REVIEW`, `PUBLISHED`, `ONGOING`, `COMPLETED`, `CANCELLED` |
| Precondition | **No open refund** (`Refund.status ∈ {PENDING, APPROVED, PROCESSING}` for the event's orders). Unchanged. |
| Actor / permission | `event.publish`. |
| CAS | `archivedAt: null`; idempotent replay returns the row unchanged. |
| Side effects | `status = 'ARCHIVED'`, `archivedAt` set. No order/ticket/payment/refund/ledger mutation, no row deleted. |
| Public surfaces | Hidden from listings and detail (`ARCHIVED` → 404). |
| Gate | Closed (fail-safe), even for a `COMPLETED`-within-grace event that is archived. |
| Terminal | Yes. |
| Scheduler | Skipped (predicate requires `archivedAt IS NULL`). |

---

## 16. Attendance

`PRODUCT DECISION — LOCKED` (P14-D14): **ratify the Phase 13 attendance model as the final contract.**

| Question (brief §15) | Answer | Source |
|---|---|---|
| May a ticket be admitted more than once? | **No.** One admission per ticket, guaranteed twice: the CAS (`status='ISSUED' AND checkedInAt IS NULL`) and `CheckIn.ticketId @unique`. | `DESIGN FACT` §20.1/§20.2 + `EXISTING BEHAVIOR` |
| Is `CHECKED_IN` terminal? | **Yes** — terminal for the ticket's lifecycle (design §19.2). | `DESIGN FACT` |
| Is re-entry required? | **No re-entry in this cycle.** No "exit and re-enter" state exists, and none is added. | `PRODUCT DECISION — LOCKED` |
| May an operator undo a check-in? | **No.** No undo endpoint, no timestamp reset, no status rollback. | `PRODUCT DECISION — LOCKED` |
| Is manual correction needed? | **Not in this cycle.** Correction is out of scope; `checkin.override` remains an authorization concept (skip the assignment requirement), not an action. | `PRODUCT DECISION — LOCKED` |
| Is check-in history immutable? | **Yes.** `CheckIn` is append-only (no `updatedAt`), and refusals are recorded too. Duplicate/refused attempts cannot carry `ticketId` (it is UNIQUE and belongs to the accepted admission) and are linked by the code in `note`. | `SOURCE FACT` + `EXISTING BEHAVIOR` |
| Canonical admission state | `Ticket.checkedInAt` / `Ticket.status`. `CheckIn` rows are evidence. | `EXISTING BEHAVIOR` |
| Gate credential | `Ticket.ticketCode` via `MANUAL` (§11). | `PRODUCT DECISION — LOCKED` |

---

## 17. PIC Access

`DESIGN FACT` — a lock, not a gap. Design §6.3: `Scan / validate QR` = **PIC NO**; `Manual check-in override` = **PIC NO**; `View check-in log` = **PIC NO**.

| Question (brief §16) | Answer |
|---|---|
| May a PIC scan? | **No.** |
| May a PIC only view attendance? | **No** — `View check-in log` is NO for PIC in the design matrix. |
| May a PIC override? | **No.** |
| Does a PIC need an assignment? | Not applicable — a PIC holds no `checkin.*` capability, so no assignment could grant one. |
| Must a PIC be bound to an event? | A PIC is bound to events for *attribution* (`PICEventAssignment`), which is unrelated to the gate. |
| Current implementation match | Exactly matches: platform `PIC` resolves to no organizer capability; membership `PIC` holds only `pic_attribution.read.all`. |

**State: LOCKED — no authz change.** Phase 15 must not pass a platform `PIC` or a membership `PIC` through the check-in guard. A future reversal would be a deliberate authz design change, not a Phase 15 side effect.

---

## 18. Finance Access

`DESIGN FACT` — likewise a lock. Design §6.3: check-in rows for `FINANCE` are **NO** (scan NO, override NO, log NO), while FINANCE keeps orders/payments/refunds/settlement/report permissions.

| Surface | Current (`SOURCE FACT`) | Desired contract |
|---|---|---|
| `checkin.scan` | not held by `FINANCE` | **not held** |
| `checkin.override` | not held | **not held** |
| `checkin.log.read` | not held | **not held** |
| Refund approve/execute | held | unchanged |
| Event read | held (`event.read`) | unchanged |
| Event write/publish (and therefore cancel/archive/complete) | **not** held | unchanged — FINANCE cannot complete an event |

`EXISTING BEHAVIOR` already refuses FINANCE at the gate (403 `FORBIDDEN`, asserted against the real DB in Phase 13). **State: LOCKED — no permission change.**

---

## 19. Completion vs Open Commercial State

`PRODUCT DECISION — LOCKED` (P14-D16): **completion is a time statement and never waits for commercial state. It also never moves money.**

| Condition at the moment completion is due | May the event complete? | Scheduler behaviour / rationale |
|---|---|---|
| A. `Refund` `PENDING` exists | **Yes** | Completion moves no money. The refund continues through its own workflow; refunds remain available on a `COMPLETED` event (existing phase-13 record). |
| B. `Refund` `APPROVED` | **Yes** | Same; `REFUNDED` settlement remains the only point where quota/tickets move. |
| C. `Refund` `PROCESSING` | **Yes** | Same. The event is not a ledger participant in the settlement path. |
| D. An unpaid `EventOrder` exists | **Yes** | The reservation TTL reaper (JOB 2) expires it and releases seats; completion does not touch orders. |
| E. A `TicketReservation` (`HELD`) exists | **Yes** | Same reaper; a settlement that arrives after expiry follows the existing `fulfilmentBlockedAt` fail-safe path. |
| F. A `Payment` in a non-terminal state (`UNPAID`/`PENDING`) | **Yes** | Payments are not voided by completion; they follow their own expiry. |

**Blocking conditions: none.** The only event-level precondition for completion is `endAt IS NOT NULL AND now >= endAt` (manual) or `endAt + 30m <= now` (automatic), plus not cancelled/archived.

**Explicitly forbidden side effects of completion:** no automatic refund, no refund approval, no ticket void, no quota mutation, no order expiry, no payment void, no ledger entry, no notification requirement. If any of those is ever wanted, it is a separate product decision (see §26).

**Contrast with archive**, which *does* have a commercial precondition (no open refunds). That asymmetry is deliberate and now explicit: completion is a status statement (reversible in the sense of being followed by refunds), while archival hides the surfaces a finance reviewer works from.

---

## 20. `endAt` Mutation

`PRODUCT DECISION — LOCKED` (P14-D12 for `endAt`, P14-D03 for `startAt`).

| State | `endAt` may move earlier? | `endAt` may move later? | `startAt` may move? | Effect on the scheduler |
|---|---|---|---|---|
| `DRAFT` | Yes (must stay `> startAt`) | Yes | Yes (must stay in the future) | None until publish. |
| `PUBLISHED` | **Yes** | **Yes** | **Yes** (future start still enforced) | The new value is honoured live: a later tick derives `ONGOING`/`COMPLETED` from the stored columns. Moving `endAt` into the past while `PUBLISHED`/`ONGOING` means the next tick (or the manual action) completes the event. |
| `ONGOING` | **Yes** | **Yes** | **No** — frozen (the state was derived from it; moving it would falsify the derivation) | Same as `PUBLISHED`. |
| `COMPLETED` | **Rejected** | **Rejected** | **No** | `endAt`/`startAt` edits return a conflict; the status is never recomputed. |
| `CANCELLED` | Currently editable (`SOURCE FACT`) | Currently editable | Currently editable | Out of this lock's scope; the scheduler skips cancelled events regardless. |
| `ARCHIVED` | Rejected (existing guard) | Rejected | Rejected | Skipped. |

**Answer to the brief's question "if `endAt` moves after `COMPLETED`":** the edit is **rejected** (conflict), the event **remains `COMPLETED`**, and there is **no reopen**. Moving `endAt` is therefore only possible while the event is `DRAFT`, `PUBLISHED` or `ONGOING`. The existing validation (`endAt > startAt`) is unchanged and still applies to every accepted edit.

---

## 21. Manual vs Automatic Transitions

| Transition | Trigger | Actor | Permission | Automatic? | Manual? | Allowed from | Allowed to | Side effects | Idempotency |
|---|---|---|---|---|---|---|---|---|---|
| `— → DRAFT` | `createEvent` | tenant member | `event.write` | No | Yes | — | `DRAFT` | slug/eventCode; status not client-writable | N/A (create) |
| `DRAFT → PUBLISHED` | `publishEvent` | tenant member | `event.publish` | No | Yes | `DRAFT` only | `PUBLISHED` | `publishedAt` (first publish); catalog listing | Re-publishing a `PUBLISHED`/`ONGOING` event is refused |
| `PUBLISHED → DRAFT` | `unpublishEvent` | tenant member | `event.publish` | No | Yes | `PUBLISHED` only | `DRAFT` | hidden from listings; read-only detail kept; orders/tickets untouched | Refused from any other status |
| `PUBLISHED → ONGOING` | scheduler tick | `SYSTEM` | none | **Yes** | **No** | `PUBLISHED` with `startAt <= now`, not cancelled/archived, not yet complete | `ONGOING` | status only + `event.ongoing` audit | CAS on status; second run → no-op |
| `ONGOING → COMPLETED` | scheduler tick | `SYSTEM` | none | **Yes** | **No** | `ONGOING` with `endAt + grace <= now` | `COMPLETED` | `completedAt`; sales stop; `event.complete` audit | CAS; second run → no-op |
| `PUBLISHED → COMPLETED` | scheduler tick (catch-up) or manual | `SYSTEM` or tenant member | none / `event.publish` | **Yes** | **Yes** | `PUBLISHED` with `endAt + grace <= now` (system) · `endAt` passed (manual) | `COMPLETED` | as above | CAS; replay of a manual complete returns unchanged, no second audit |
| `PUBLISHED → CANCELLED` | `cancelEvent` | tenant member | `event.publish` | No | Yes | `PUBLISHED` | `CANCELLED` | `cancelledAt`/reason; unpaid orders expire; no refund/void | Replay returns unchanged |
| `ONGOING → CANCELLED` | `cancelEvent` | tenant member | `event.publish` | No | Yes | `ONGOING` | `CANCELLED` | as above | as above |
| `COMPLETED → ARCHIVED` | `archiveEvent` | tenant member | `event.publish` | No | Yes | `COMPLETED` | `ARCHIVED` | `archivedAt`; hidden; nothing deleted | CAS on `archivedAt: null` |
| `CANCELLED → ARCHIVED` | `archiveEvent` | tenant member | `event.publish` | No | Yes | `CANCELLED` | `ARCHIVED` | as above | as above |
| any non-`ARCHIVED` → `ARCHIVED` | `archiveEvent` | tenant member | `event.publish` | No | Yes | any non-archived (chosen policy) | `ARCHIVED` | as above; blocked by open refunds | as above |
| `DRAFT → deleted` | `deleteEvent` | tenant member | `event.publish` | No | Yes | `DRAFT`, zero orders/tickets | (gone) | hard delete | Refused otherwise |

**Forbidden transitions (must be unreachable, enforced by predicate, not by UI):** `PUBLISHED → ONGOING` twice · `ONGOING → COMPLETED` twice · `ONGOING → PUBLISHED` · `COMPLETED → ONGOING` · `COMPLETED → CANCELLED` · `CANCELLED → COMPLETED` · `CANCELLED → ONGOING` · `ARCHIVED → anything` · `ONGOING → CANCELLED → ONGOING` (no resurrect) · completion while `cancelledAt`/`archivedAt` set.

**DB-conditional shape (contract, not code):**

```sql
-- PUBLISHED -> ONGOING (automatic, catch-up safe)
UPDATE event
   SET status = 'ONGOING'
 WHERE status = 'PUBLISHED'
   AND archivedAt IS NULL
   AND cancelledAt IS NULL
   AND startAt <= :now
   AND (endAt IS NULL OR endAt + INTERVAL 30 MINUTE > :now);

-- {PUBLISHED,ONGOING} -> COMPLETED (automatic)
UPDATE event
   SET status = 'COMPLETED', completedAt = :now
 WHERE status IN ('PUBLISHED','ONGOING')
   AND archivedAt IS NULL
   AND cancelledAt IS NULL
   AND endAt IS NOT NULL
   AND endAt + INTERVAL 30 MINUTE <= :now;
```

Every transition is a conditional write; `count === 1` means this caller won. Never read-then-write.

---

## 22. Final Decision Table

Status legend: **LOCKED** = binding on Phase 15/16. **OPEN** = listed in §25; Phase 15 must not guess.

| ID | Decision | Final contract | Source / reason | Status | Phase |
|---|---|---|---|---|---|
| `P14-D01` | `ONGOING` exists? | Yes — real derived state, `[startAt, endAt+grace)`. | Product decision (ONGOING absent from design §10). | **LOCKED** | 15 |
| `P14-D02` | `ONGOING` trigger / manual entry | Scheduler `now >= startAt`; **no manual entry**. | Product decision. | **LOCKED** | 15 |
| `P14-D03` | `ONGOING` monotonic; `startAt` frozen in `ONGOING`/`COMPLETED` | No backward transition; `startAt` immutable once `ONGOING`. | Product decision + derived-state integrity. | **LOCKED** | 15 |
| `P14-D04` | `COMPLETED` automatic | Scheduler at `now >= endAt + 30m`; catch-up allowed. | Design §10.3 + product decision on the value. | **LOCKED** | 15 |
| `P14-D05` | `COMPLETED` manual | `event.publish` holder, `endAt != null AND now >= endAt`; idempotent. | Design §10.3 ("or Manager"). | **LOCKED** | 15 |
| `P14-D06` | Grace window | `CHECK_IN_GRACE_MINUTES = 30`, fixed, from `endAt`, not configurable. | Product decision (design states "a grace window" with no value). | **LOCKED** | 15 |
| `P14-D07` | Cancellation policy | Phase 12 contract ratified: no auto-refund, no auto-void, no money movement. | Design §10.2/§10.3 + Phase 12 + product decision. | **LOCKED** | 15 |
| `P14-D08` | Archive policy | Any non-`ARCHIVED` state, blocked while a refund is open. Phase 12 widening ratified. | Product decision (design restricts to COMPLETED/CANCELLED). | **LOCKED** | 15 |
| `P14-D09` | Scheduler architecture | Option A: DB-backed tick route + external cron on the VPS. | Infrastructure decision on recorded deployment facts. | **LOCKED** | 15 |
| `P14-D10` | Scheduler contract | 1-minute tick; JOB 1 lifecycle, JOB 2 reservation expiry; DB lease single-flight; per-job isolation; no logic in cron. | Design §11.4 + §21.2 + P-3. | **LOCKED** | 15 |
| `P14-D11` | Sales vs lifecycle | `isPurchasable` = `{PUBLISHED, ONGOING}` ∪ window; `COMPLETED` stops sales; type window is inner, lifecycle is outer; catalog lists `{PUBLISHED, ONGOING}`. | Design §10.3 ("Sales stop") + §11.6 + product decision. | **LOCKED** | 15 |
| `P14-D12` | `endAt` mutation | Editable in `DRAFT`/`PUBLISHED`/`ONGOING`; **rejected when `COMPLETED`**; no reopen. | Product decision. | **LOCKED** | 15 |
| `P14-D13` | `requiresCheckIn` | Soft: `false` = gate-free declaration (panel soft-hidden, reporting ungated); endpoint still works; no effect on issuance/completion/refund/ticket/public payload. | Product decision + design §10.2. | **LOCKED** | 15 |
| `P14-D14` | Attendance | One admission per ticket; `CHECKED_IN` terminal; no re-entry; no undo/correction; `CheckIn` append-only incl. refusals. | Design §19.2/§20.1–20.3. | **LOCKED** | 15 |
| `P14-D15` | **`D-28`** refund vs check-in | Block check-in for `PENDING`/`APPROVED`/`PROCESSING`; new `CheckInResult.REFUND_PENDING`; 409; refusal recorded. | Product decision (design recommends, never locked). | **LOCKED** | 15 |
| `P14-D16` | Completion vs open commercial state | Completion never waits for refunds/unpaid orders/reservations/payments; moves no money. | Product decision (design silent). | **LOCKED** | 15 |
| `P14-D17` | **`D-46`** QR delivery | Ratify Phase 13: QR = `TICKET:<ticketCode>`, method `MANUAL`, raw token never delivered/stored/logged; `QR_SCAN` unused. | Product decision + design §26.6 + Phase 8/13. | **LOCKED** | 16 |
| `P14-D18` | PIC gate access | No scan/override/log. | Design §6.3. | **LOCKED** | 15 |
| `P14-D19` | Finance gate access | No scan/override/log. | Design §6.3. | **LOCKED** | 15 |
| `P14-D20` | Schema additions for Phase 15 | `Event.completedAt DateTime?`; `CheckInResult` + `REFUND_PENDING`; `JobLock` table. Additive only. | Required by the locks above. | **LOCKED** | 15 |
| `P14-D21` | Audit vocabulary additions | `event.ongoing`, `event.complete` (system and manual), reuse of `checkin.rejected`. | Existing audit-log pattern. | **LOCKED** | 15 |
| `P14-D22` | Events with `endAt IS NULL` | Never auto-complete and never manually complete; leave `PUBLISHED`/`ONGOING` (gate open) until `CANCELLED` or `ARCHIVED`. | Design §10.2 + §10.3's unsatisfiable "past `endAt`" precondition — conservative, does less not more. | **LOCKED** | 15 |
| `P14-D23` | Publish/unpublish guards after `ONGOING` exists | Publish only from `DRAFT`; refuse `ONGOING`; unpublish only from `PUBLISHED`. | Derived from monotonicity (P14-D03). | **LOCKED** | 15 |
| `P14-D24` | Past-event display grace (design §25.2 `startAt >= now - grace`) | Out of scope; the existing past-event filter is retained unchanged. | Explicit non-decision (§26). | **LOCKED (out of scope)** | — |
| `P14-D25` | Manual transition authority | Existing `event.publish` only; **no new permission key**. | Design §6.3 + existing authz. | **LOCKED** | 15 |

No row carries status `OPEN`.

---

## 23. Phase 15 Implementation Contract

Read this section and code. Nothing below requires a new business decision.

### 23.1 Constants and pure predicates

```
lib/events/lifecycle.ts   (new, pure, no DB)
  CHECK_IN_GRACE_MINUTES = 30
  CHECK_IN_GRACE_MS      = 30 * 60_000
  completionDueAt(endAt)            → endAt + grace            (null-safe)
  isOngoingDue(event, now)          → status==='PUBLISHED' && !cancelled && !archived && startAt <= now && !isCompletionDue(event, now)
  isCompletionDue(event, now)       → status ∈ {PUBLISHED,ONGOING} && !cancelled && !archived && endAt != null && now >= endAt + grace
  mayCompleteManually(event, now)   → status ∈ {PUBLISHED,ONGOING} && endAt != null && now >= endAt
```

```
lib/events/sales-state.ts   (edit existing pure module)
  isEventCheckInOpen({ status, archivedAt, cancelledAt, endAt }, now)
    closed if cancelledAt || archivedAt
    closed if status ∈ {DRAFT, PENDING_REVIEW, CANCELLED, ARCHIVED}
    open if status ∈ {PUBLISHED, ONGOING} && (endAt == null || now <= endAt + grace)
    open if status === 'COMPLETED' && endAt != null && now <= endAt + grace
    closed otherwise
  isEventPurchasable(event)  → status ∈ {PUBLISHED, ONGOING}  (COMPLETED removed)
  CHECKIN_OPEN_STATUSES      → keep, but the time predicate is now mandatory
```

Rules: **one** grace constant, **one** gate predicate, **one** purchasability predicate. No second copy anywhere (checkout, catalog, dashboard, UI must import these).

### 23.2 Migration (additive only)

| Change | SQL shape | Notes |
|---|---|---|
| `Event.completedAt DateTime?` | `ALTER TABLE event ADD COLUMN completedAt DATETIME(3) NULL` | Observation instant. `ongoingAt` is **not** added (derivable from `startAt`). |
| `CheckInResult` | `ALTER TABLE checkin MODIFY result ENUM(<existing…>, 'REFUND_PENDING')` | Append at the end so existing rows keep their ordinal meaning. |
| `joblock` table | `CREATE TABLE joblock (name VARCHAR(64) PK, lockedUntil DATETIME(3) NULL, lockedBy VARCHAR(64) NULL, lastRunAt DATETIME(3) NULL, lastStatus VARCHAR(32) NULL, updatedAt DATETIME(3))` | One row per job. Insert-if-missing on first tick; document the two `name` values. |

No destructive statement, no column drop, no enum reordering.

### 23.3 Services

| Function | File | Contract |
|---|---|---|
| `advanceEventLifecycleBatch({ now, batchSize = 200 })` | `lib/events/lifecycle.ts` | Step 1 `PUBLISHED → ONGOING` (`updateMany`, full predicate, `startAt asc, id asc`); Step 2 `{PUBLISHED,ONGOING} → COMPLETED` with `completedAt = now` (`endAt asc, id asc`). Returns `{ toOngoing, toCompleted, scanned }`. Writes one `event.ongoing` / `event.complete` audit row per transitioned row (`actorType: SYSTEM`, `organizerId` from the row). **No** other table touched. |
| `completeEvent(scope, eventId, request?)` | `lib/events/service.ts` | `requireEventAccess(eventId, 'event.publish')`; refuse archived/cancelled; refuse `endAt == null` (`P14-D22`); refuse when `now < endAt`; CAS `updateMany` with the full predicate; idempotent replay returns the row unchanged with no second audit row; audit `event.complete` with `beforeState.status`/`afterState.status`. |
| `runJobsTick({ now = new Date() })` | `lib/jobs/tick.ts` | Acquire the two leases (§13.3); run JOB 1 and JOB 2 with **the same `now`**; per-job try/catch so one failure does not abort the other; release leases; return the §13.1 response. JOB 2 calls the existing `expireDueReservations({ now, batchSize: 100 })` **unchanged**. |
| `checkInTicket` | `lib/ticketing/checkin/service.ts` | Add the open-refund guard inside the transaction, before/with the CAS: block when a `RefundItem` exists for the ticket with parent `Refund.status ∈ {PENDING, APPROVED, PROCESSING}`; refuse with `CONFLICT` + `details.reason = 'REFUND_PENDING'`; record a `CheckIn` refusal row with `result: 'REFUND_PENDING'` and a `checkin.rejected` audit row. Keep `WRONG_EVENT` before the refund check (event scope first, price-free). |
| `publishEvent` / `unpublishEvent` | `lib/events/service.ts` | Publish only from `DRAFT` (refuse `ONGOING` explicitly) — `P14-D23`. Unpublish only from `PUBLISHED` (unchanged). |
| `updateEvent` | `lib/events/service.ts` | Refuse `startAt` changes when status ∈ {`ONGOING`, `COMPLETED`}; refuse `endAt` changes when `status === 'COMPLETED'` (conflict, and record the refusal reason). |
| `publicVisibilityWhere` | `lib/events/catalog.ts` | `status: { in: ['PUBLISHED','ONGOING'] }`; keep `visibility PUBLIC`, `archivedAt null`, and the existing past-event filter. |
| `cancelEvent` / `archiveEvent` / `deleteEvent` | `lib/events/service.ts` | **Unchanged** apart from the guard interactions above. |

### 23.4 Routes

| Route | Method | Auth | Contract |
|---|---|---|---|
| `/api/internal/jobs/tick` | `POST` | `Authorization: Bearer $JOBS_TICK_SECRET` (constant-time compare) | Runs the tick. 401 without/with a wrong secret. Not session-scoped; must not be reachable via the organizer guard chain. No body. |
| `/api/organizer/events/[id]/complete` | `POST` | session + same-origin + `event.publish` | Manual completion (`completeEvent`). Optional `{ note? }` (strict schema) recorded in the audit row. |

`proxy.ts` must keep `/api/organizer/**` protected; `/api/internal/**` must **not** be added to any session-protected matcher silently — its secret is the control (document this in the route header and the Phase 15 report).

### 23.5 UI

| Surface | Change |
|---|---|
| `components/organizer/EventActions.tsx` | Add "Selesaikan event" for `PUBLISHED`/`ONGOING` (and keep `COMPLETED` without it). Confirmation copy must state: sales stop, nothing is deleted, refunds continue to work. |
| `components/organizer/CheckInPanel.tsx` | Show the §7 window state honestly: open before `endAt`, "grace" between `endAt` and `endAt + 30m`, closed after. When `requiresCheckIn === false`, render the optional/soft state (§10) instead of the primary panel. |
| `app/dashboard/events/[id]/page.tsx` | Pass `endAt`, `status`, `requiresCheckIn` into the panel decision; keep resolving `checkin.scan`/`checkin.log.read` server-side. Disable/annotate the "Selesaikan" control when `endAt` is null. |
| Public surfaces | No new field. `requiresCheckIn` stays out of the public payload. |

### 23.6 Concurrency rules (binding)

1. Every lifecycle state move is a conditional write whose predicate carries the expected current status **and** the time condition; never read-then-write.
2. The tick passes **one** `now` to all steps and jobs.
3. Admission: gate predicate → ticket lookup → event match → open-refund guard → CAS (`ISSUED AND checkedInAt IS NULL`) → `CheckIn` insert, all inside one transaction; the ticket row is the serialization point for admission-vs-refund.
4. Refund request: `D-R05` refusal on `checkedInAt != null` stays, plus the same ticket-row serialization so `D-28` cannot be raced.
5. Completion and cancellation must never run concurrently against the same row: completion's predicate requires `cancelledAt IS NULL`, and cancel's CAS requires the exact current status, so the loser is a no-op/conflict by construction.
6. Archive vs completion: both are conditional on `archivedAt`/status; the loser is a no-op.

### 23.7 Audit requirements (binding)

- `event.ongoing` and `event.complete` actions added to `lib/ticketing/audit-log.ts`, with real writers only.
- System transitions use `actorType: 'SYSTEM'`, `actorOrganizerId: null`, `organizerId` from the event row, `entityType: 'Event'`, `entityRef: event.id`, `beforeState/afterState` carrying `status` (and `completedAt`), no PII, no secret.
- Manual completion carries the acting scope like `event.cancel` does.
- A no-op tick writes **no** audit row. Skips are observable via `JobLock.lastRunAt/lastStatus`.
- `checkin.rejected` is reused for `REFUND_PENDING` — no new audit action for it.

### 23.8 Tests required (binding) — all must run against the real DB where state is involved

| # | Test | Asserts |
|---|---|---|
| 1 | `isEventCheckInOpen` matrix (pure) | The §7 table exactly: open before `endAt`; open within grace; closed after grace; closed for `CANCELLED`/`ARCHIVED`/`DRAFT`; open for manually-completed-within-grace; `endAt IS NULL` stays open while live. |
| 2 | `isEventPurchasable` matrix (pure) | `COMPLETED` is **not** purchasable; `PUBLISHED`/`ONGOING` are; window/quota rules unchanged; PRIVATE/archived/cancelled excluded. |
| 3 | Lifecycle batch integration | `PUBLISHED → ONGOING` at `startAt`; `ONGOING → COMPLETED` at `endAt + 30m`; catch-up goes straight `PUBLISHED → COMPLETED`; `endAt IS NULL` never transitions; `CANCELLED`/`ARCHIVED` skipped; `completedAt` set; audit rows written once. |
| 4 | Lifecycle concurrency (real DB) | Two concurrent ticks → exactly one transition per event; a second sequential tick is a no-op with no second audit row. |
| 5 | Lifecycle side-effect purity | Before/after equivalence of `EventOrder`, `Ticket`, `Payment`, `Refund`, `TicketType` counters around both transitions. |
| 6 | Tick route | 401 without a secret and with a wrong secret; 200 with the correct secret; per-job isolation (a forced JOB 1 failure still runs JOB 2); lease prevents overlap; stale lease takeover. |
| 7 | Reaper wiring | The tick expires due reservations exactly as `expireDueReservations` does; a `PAID` order is never expired; idempotent re-run. |
| 8 | `D-28` gate | `PENDING`/`APPROVED`/`PROCESSING` block with `REFUND_PENDING` + refusal row + audit; `REJECTED`/`FAILED` do not block; `REFUNDED` still refused by the CAS; the ticket is untouched on a refusal. |
| 9 | `D-28` race (real DB) | Concurrent check-in vs refund request → exactly one of (open refund, `CHECKED_IN`) commits; the loser observes the winner's state. |
| 10 | Manual completion | Authz (owner/manager yes, FINANCE no, customer 404), precondition (`now >= endAt`, non-null `endAt`), idempotent replay, audit row, refusal when archived/cancelled. |
| 11 | Edit freezes | `endAt` edit rejected when `COMPLETED`; `startAt` edit rejected when `ONGOING`/`COMPLETED`; edits still allowed in `DRAFT`/`PUBLISHED`. |
| 12 | Publish guards | `publishEvent` refuses `ONGOING`; the only source is `DRAFT`. |
| 13 | Catalog | An `ONGOING` event is listed; a `COMPLETED`/`CANCELLED`/`ARCHIVED` event is not; detail availability unchanged. |
| 14 | UI wiring | The gap state is rendered from the server's predicate; `requiresCheckIn === false` renders the soft state; no check-in control appears on buyer surfaces. |

### 23.9 Phase 15 blockers

**None.** All decisions in §22 are LOCKED.

### 23.10 Phase 15 must not

- introduce a new permission key, a new role, or a new authz path;
- add a job beyond JOB 1 and JOB 2;
- move money, void a ticket, or refund automatically;
- add a manual `ONGOING` action;
- write `QR_SCAN`;
- change `CheckIn`/`Ticket`/`Refund` semantics other than the single `REFUND_PENDING` value;
- touch `PENDING_REVIEW` (D-13 remains `DRAFT → PUBLISHED` self-publish).

---

## 24. Phase 16 Implementation Contract — QR / e-ticket

`D-46` is closed (`P14-D17`), so **Phase 16 is unblocked and has no mandatory lifecycle work.** Its contract is a hardening contract under the ratified design:

| Topic | Contract |
|---|---|
| QR payload | `TICKET:<ticketCode>` — namespaced, no PII, no URL, no secret, immutable for the ticket's life. Built server-side only (`buildTicketQrPayload`). |
| Raw token lifecycle | Minted at issuance (32 random bytes, base64url); its SHA-256 persisted as `Ticket.qrTokenHash`; the raw value never leaves the server, is never stored, never returned by any endpoint, never logged, never audited, never placed in analytics. |
| Storage | `qrTokenHash @unique` and `qrVersion` remain the only persisted token artifacts. If a future decision enables token scanning, revocation stays per ticket by rotating the hash and incrementing `qrVersion`. |
| API response | Wallet **list**: no QR (design §26.5). Wallet **detail**: `{ payload, renderer: "qrcode.react", version }` + `admission.scannable/reason` — **no token, no hash**. |
| Wallet rendering | Client renders the server-supplied `payload` with the pinned renderer; the client assembles no payload, fetches nothing for the QR, and never sees a secret. |
| Scanner | The supported scanner is the gate UI's manual-code field (keyboard-wedge QR guns type the payload into it) → the same `POST /api/organizer/events/[id]/check-in` with `method = MANUAL`. `QR_SCAN` stays unwritten. |
| Manual fallback | Always available to an actor with `checkin.scan` (+ `StaffEventAssignment` for pure gate staff) — design §20.6; it is the primary path under this contract, and it is not exempt from validation (including the `D-28` guard). |
| Hashing | `hashQrToken` (unsalted SHA-256) exists and is used at issuance only. If token scanning is ever enabled, the lookup is `hash → qrTokenHash (UNIQUE index) → status → event match → refund guard → CAS`, per design §20.2; a slower KDF is not used (uniform 256-bit input, indexed lookup). |
| Check-in validation order | Unchanged from Phase 13 plus the new guard: (1) event gate predicate incl. grace, (2) event-scoped authorization, (3) code/token → ticket, (4) event match, (5) `D-28` open-refund guard, (6) CAS `ISSUED → CHECKED_IN`, (7) `CheckIn` insert. Malformed ≡ unknown. |
| Logging rules | Never log the raw token or the hash. The `ticketCode` may appear as `entityRef` (public reference) but not as free-form log content. `clientScannedAt`/`gateLabel`/`deviceId` are informational and never decide anything. |
| Security rules | Tenant-scoped authorization + per-event assignment is the control; refusal responses stay uniform (unknown ≡ malformed, `WRONG_EVENT` never names the real event, authz denial is 404). No QR secret in any response, error body, audit state or log line. |
| Optional hardening backlog (not required to call Phase 16 complete) | Print/PDF e-ticket, offline scanner manifest, per-actor rate limiting at the gate, ticket reissue/transfer (`ticket.reissue`, still out of scope), visual regression of the wallet. |

**Phase 16 blockers:** none.

---

## 25. Open Decisions

**Business decisions blocking Phase 15: none.**
**Business decisions blocking Phase 16: none.**

The following are legacy items outside this lock's scope. They are recorded so they are not mistaken for decisions taken here, and **none of them blocks the lifecycle, gate or scheduler contracts**:

| ID | Item | Why it is not decided here | Does it block 15/16? |
|---|---|---|---|
| `D-08` | Does a refund return quota to sale? (`Event.returnQuotaOnRefund`) | Money/inventory policy, untouched by this phase; the existing default (`false`) and settlement behaviour stand. | No |
| `D-29` | Refund allowed after the event has started? (`refundDeadlineAt`) | Money policy; the completion contract deliberately does not depend on it (a `COMPLETED` event can still be refunded). | No |
| `D-27`/`D-30` | Gateway fee / platform fee refunded? | Money policy; unchanged. | No |
| `D-34` | Check-in PII (`ipAddress`) retention | Privacy policy; `ipAddress` is already stored and restricted. | No |
| `P12-D2` | Cancel → void issued tickets | Requires a refund rail; explicitly not added (P14-D07). | No |
| `P12-D3` | Cancel → bulk refund workflow | Money automation; explicitly not added (P14-D07). | No |
| `P12-D4` | Cancel → Finance-approval step | New authz capability; not added (P14-D25 keeps `event.publish`). | No |
| `P14-D24` | Past-event display grace (design §25.2 `now - grace`) | Date-arithmetic/display policy, independent of the check-in grace; the existing filter is retained. | No |
| `P13-J` | Attendance counter + `CHECKIN_SUCCESS` notification | Needs a notification channel and is explicitly out of scope (`P14-D24` scope note). | No |
| `P13-K` | `CheckInResult.DUPLICATE` unused | `ALREADY_CHECKED_IN` carries more information; no consumer needs it. | No |

---

## 26. Explicit Non-Decisions

Stated so the absence of these is not read as an omission (brief §27):

1. **No automatic refund on cancellation or completion.** Cancellation expires unpaid orders and voids nothing; completion moves no money. Confirmed, not deferred silently.
2. **No ticket voiding.** `ISSUED → VOID` remains design-only (`ticket.void` is not implemented, design §19.5 belongs to a later phase). `VOID` is only refused by the gate CAS, never written.
3. **No re-entry, no undo, no manual correction of a check-in** (P14-D14).
4. **No manual `ONGOING`** and no new permission key; `event.publish` remains the single lifecycle authority.
5. **`ticket.reissue` / ticket transfer / seat maps** untouched.
6. **`PENDING_REVIEW`** stays unreachable (D-13 self-publish LOCKED in Phase 4; this phase does not reopen it).
7. **Notifications, denormalized counters, exports** untouched.
8. **`TicketReservationStatus.CONFIRMED` vs `CONVERTED`** naming divergence (schema wins) left as recorded by the ticketing phases.
9. **Money representation (`D-61`)** untouched.
10. **No rate limiting at the gate** was added (Phase 13's finding stands; the endpoint is authenticated, tenant-scoped, assignment-bounded and fully audited).
11. **`salesEndAt` later than `endAt` is not rejected** — explicit choice, documented consequence in §8.
12. **No `ongoingAt` column** — `ONGOING` timing is exactly `startAt`.

---

## 27. Final Verdict

**`DECISION LOCK COMPLETE`**

Justification, against the brief's own criterion ("do not call it COMPLETE if Phase 15 still requires guessing"):

- Every one of the 21 lifecycle questions in §4 has a final answer.
- Every item the brief enumerated as product-decision-territory — `ONGOING`, grace window, `requiresCheckIn`, `D-28`, `D-46`, scheduler, archive policy, cancellation refund policy, `endAt` mutation — is now LOCKED with a named rationale, and none is disguised as a source fact.
- `FACT` and `DECISION` are separated throughout: the source/design facts are labelled, the decisions are labelled, and the four code-vs-design divergences the lock exposes are listed explicitly rather than papered over.
- Phase 15 has a complete implementation contract (§23) including migrations, services, routes, UI, concurrency rules, audit requirements and a 14-item test mandate. Nothing in it requires a guess.
- Phase 16 is unblocked by `D-46` being closed and has a hardening contract (§24).
- The remaining legacy items (§25) are outside this lock's scope and do not intersect the lifecycle, gate or scheduler paths.

**No commit, no push, no schema change, no migration, no test change, no source change, no DB reset was performed by this phase.**
