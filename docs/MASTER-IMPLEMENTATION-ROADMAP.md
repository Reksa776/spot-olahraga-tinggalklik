# MASTER IMPLEMENTATION ROADMAP — FOUR CORE FEATURES

Authoritative order for the four permanent product objectives. Evidence for every status is
in `docs/MASTER-FOUR-FEATURES-AUDIT.md`; this file is the plan, not a second audit.

**Baseline:** `main` @ `9b8fecd99bcc74677c1805c18379241af04fddd1`, staged 0.
**Rule:** one phase per change set; no phase may claim a live delivery or a database guarantee
it did not observe.

---

## Status board

| Phase | Objective | Status | Depends on |
|---|---|---|---|
| 3A–3D | PIC authorization, QR validation, transaction, API | **DONE** (3C/3D with limitations) | — |
| **3E** | **PIC scanner UI** | **DONE in this execution** | 3D |
| 4 | H-36 WhatsApp reminder (dry-run engine) | NEXT | notification runtime, tick |
| 3F | Scan rate limit, durable audit, PIC attribution | PLANNED | 3E |
| 3G | Real MariaDB integration for check-in | PLANNED | test DB provisioning |
| 5 | Post-event document blast | PLANNED | migration approval, storage privacy |
| OPS-1 | Activate live email/WhatsApp | BLOCKED (owner) | SMTP/Baileys decision |
| OPS-2 | Activate H-36/live proofs in production | BLOCKED (owner) | OPS-1 + approved copy |

---

## Phase 3E — PIC scanner UI (DONE)

**Goal:** an authorized PIC scans a ticket at an event they are assigned to, from a phone,
with the same engine the staff gate uses.

**Delivered:**

- `app/dashboard/pic/scan/[eventId]/page.tsx` — server-authorized page; denial is `notFound()`
  (no event-existence oracle); renders the shared scanner only while the canonical gate is open.
- `components/organizer/TicketScanner.tsx` — accepts an `endpoint` override; organizer default
  unchanged.
- `lib/ticketing/checkin/service.ts` — `requirePicScanAccess` for the page and
  `actorKind` so a PIC response never carries another operator's name.
- PIC "Event Saya" rows link to the page for active assignments.

**Explicitly not in 3E:** camera library changes, offline mode, attendance list for PIC,
rate limiting, audit changes, schema.

**Exit criteria:** page compiles, uses the 3D endpoint, passes the focused page suite, and the
3A–3D regression suites stay green. Met (see phase report).

---

## Phase 4 — H-36 WhatsApp reminder (next)

**Goal:** every eligible ticket holder for a published event receives exactly one reminder per
channel when the event is 36 hours away, and nothing when the event is cancelled or moved.

**Design constraints learned from the audit:**

- Enqueue at due time; do not add a `scheduledFor` column. The unique
  `Notification.idempotencyKey` is the occurrence record:
  `reminder.h36:{eventId}:{ticketId}:{channel}:v1`.
- Add one job to `JOB_NAMES`/`runJobsTick` — a deliberate widening of the pinned two-job
  vocabulary, with `__tests__/jobs/tick.test.ts` updated to expect three.
- Select events by `startAt` inside a bounded window using the **event's** `timezone` for any
  human-facing copy, but compute the boundary in UTC instants. Skip `CANCELLED`, `ARCHIVED`,
  and events whose `startAt` changed after enqueue by keying the occurrence to the event and
  the ticket (a reschedule keeps the same key, so the stale row is corrected, not re-sent).
- Recipients come from issued tickets (Phase 2 issuance), never from a client request.
- Reuse `contacts.ts`, `enqueue.ts`, `templates.ts`, worker retry; no second outbox.
- Template `reminder.h36.v1` must be added to the registry **and** the "absent" assertion in
  `__tests__/notifications/purchase-proof-template.test.ts:169` must be replaced by a positive
  assertion — an intentional test change, documented.

**Deliverables:** migration-free code, template copy, third tick job, unit tests for window
boundary/idempotency/cancellation, dry-run evidence. Live delivery is out of scope until OPS-1.

**Exit:** dry-run enqueues exactly one row per ticket/channel; a second tick adds none; a
cancelled event adds none; a rescheduled event does not duplicate.

---

## Phase 3F — Scanner security and attribution

**Goal:** the PIC surface is rate-limited, every scan attempt is durably attributable, and no
operator identity leaks to a PIC.

**Scope:**

- Per-session/per-event scan limiter using the existing `lib/rate-limit.ts`; document the
  per-process limitation. No Redis unless a multi-instance deployment is proven.
- Attach the PIC profile to the existing `checkin.success`/`checkin.rejected` audit payload
  using permitted metadata only (`FORBIDDEN_METADATA_KEYS` respected). No new column unless
  proven unavoidable.
- Confirm the duplicate-scan response for a PIC carries no other operator's name (3E already
  nulls it); add a behavioural test at the service level.

**Exit:** burst scans are throttled; audit rows identify the PIC; no secret, token, phone or
email appears in the payload.

---

## Phase 3G — Real database integration for check-in

**Goal:** prove the PIC path against MariaDB, not mocks.

**Scope:**

- Disposable `_test` schema via `TEST_DATABASE_URL` (must end `_test`, per `jest.setup-env.ts`).
- Real `PICProfile`/`PICEventAssignment` lookups; masked 404 for a foreign event.
- Two connections admitting the same ticket: exactly one success, one duplicate; rollback on
  forced failure leaves no `CheckIn` row.
- No production access, no seed of real data.

**Exit:** committed (unstaged) integration suite with deterministic results and recorded
counts; mocked suites are no longer the only evidence.

---

## Phase 5 — Post-event document blast

**Goal:** an authorized PIC sends event documents to that event's participants over WhatsApp
or email, with tracked, retryable, auditable delivery.

**Prerequisites (all must exist before code):**

1. Approved data model: private document, event binding, recipient selection, delivery linkage
   — delivered as a **proposed** migration, not applied.
2. Private storage/read path (no public URL, no enumerable directory), with expiry or signed
   access.
3. PIC authorization for distribution: event assignment + active profile, reusing the 3A
   decider shape (a document decider must not be inferred from the scan permission).
4. Product rules: who is eligible (holder vs attendee), retention, and what happens on refund.
5. Live transport decision (OPS-1).

**Explicitly out of scope until approved:** schema changes, public file serving, WhatsApp
broadcast, bulk recipient export.

---

## OPS-1 / OPS-2 — Live delivery activation (owner)

Not build phases. Required decisions: SMTP credential path and nodemailer advisory acceptance;
Baileys hosting/pairing and session storage; WhatsApp template approval if a business API is
chosen; production `NOTIFICATIONS_ENABLED` and transport values; monitoring for
`DRY_RUN_SIMULATED` remaining in production. After that, a controlled verification run with
one real recipient.

---

## Cross-phase invariants

- No feature may bypass the unique idempotency keys; a retry never creates a second effect.
- No client value may establish identity, tenant, event scope, recipient or channel.
- No public URL may expose a private document.
- A mocked suite never counts as database evidence.
- Each phase reports exact test counts and exact Git state; all work stays unstaged.

---

## Order rationale

3E came first because it needed no new dependency and closed a product-visible gap. Phase 4
comes next because its foundation is entirely present and its remaining work is migration-free.
3F precedes 3G because a rate limit is a production control that needs no database, while 3G is
evidence work. Phase 5 is last because it requires the only thing this repository cannot supply
by itself: an approved schema/storage design and a live transport.
