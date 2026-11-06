# Existing Feature Activation Plan

**Status:** PLANNING ONLY. No live WhatsApp account was connected, no message/email was sent, and no production environment was changed.

**Scope:** activate H-36 reminder, purchase proof, and PIC QR scanner verification on top of the existing implementation. Ticket-issued messaging is included because it shares the same transport and must be activated with the same gate.

---

## 1. Shared activation gate

### 1.1 Why a single switch is not enough

**VERIFIED.** `PHASE_1_DRY_RUN_ONLY = true` (`lib/notifications/config.ts:38`) is not the clamp. The clamp is unconditional at `lib/notifications/config.ts:173-181`; the worker also refuses live transports at `lib/notifications/worker.ts:398-404`. Therefore activation needs a reviewed code change, not merely an environment edit.

### 1.2 Proposed live gate

**PROPOSED.** Keep fail-closed defaults and add an explicit live mode:

| Gate | Default | Activation |
|---|---|---|
| `NOTIFICATIONS_ENABLED` | `false` | `true` only during the approved window |
| `WHATSAPP_TRANSPORT` | `dry-run` | `baileys` only after the gateway is healthy |
| `EMAIL_TRANSPORT` | `dry-run` | `smtp` only after SMTP is implemented and tested |
| `WHATSAPP_LIVE_MODE` | `dry-run` | `allowlist` for first send; `live` after acceptance |
| `EMAIL_LIVE_MODE` | `dry-run` | same staged progression |
| `WHATSAPP_LIVE_ALLOWLIST` | empty | one internal test number for the first send |
| `WHATSAPP_DAILY_CAP` | 20 | approved transactional ceiling |
| `WHATSAPP_DOCUMENT_DAILY_CAP` | 0 | 0 until feature 4 is separately approved |

**PROPOSED worker rule:** in `allowlist` mode, a delivery whose normalized recipient is not in the allowlist is left `QUEUED` (deferred), not skipped and not failed. This prevents an accidental blast while preserving the row for the real rollout. The allowlist must be normalized with the same `normalizeIndonesianPhone()`/`normalizeEmail()` functions (`lib/notifications/contacts.ts:53-107`).

The gateway must be `ready` before the worker starts claiming WhatsApp. If it is not, leave WhatsApp rows `QUEUED` and alert; email continues.

### 1.3 Activation sequence (common)

1. Freeze the code at a reviewed commit; run the full baseline test suite.
2. Verify `tsx`/`dotenv` are resolvable in the production install (or deploy compiled output).
3. Start the gateway in dry-run/no-pairing mode and confirm `/healthz`/`/readyz` semantics.
4. Pair the dedicated number on the host (operator CLI), never in a web page.
5. Confirm the gateway holds `joblock:whatsapp-gateway` and one socket.
6. Start the notification worker under PM2; confirm it holds `joblock:notification-dispatch`.
7. Run `--once` with `NOTIFICATIONS_ENABLED=false`; expect no writes.
8. Enable with `WHATSAPP_LIVE_MODE=allowlist`, one test recipient.
9. Observe exactly one send, one provider id, ack state, and no duplicate on replay.
10. Remove the allowlist only after sign-off; keep the kill switch and cap.

---

## 2. H-36 event reminder

### 2.1 Current implementation

**VERIFIED.**

| Concern | Location |
|---|---|
| Offset constant 36h | `lib/notifications/h36-reminder.ts:49` |
| Due predicate | `h36ReminderTargetAt`/`isH36ReminderDue` (`:64-82`) |
| Idempotency key includes start instant | `h36ReminderIdempotencyKey` (`:95-110`) |
| Bounds: 25 events, 500 tickets/event, 200 reconcile | `:52-54` |
| Reconcile stale/cancelled/rescheduled queued rows | `:170-238` |
| Sweep query and enqueue | `runH36ReminderSweep` (`:266-436`) |
| Third tick job | `lib/jobs/tick.ts:169-173`; `lib/jobs/lock.ts:39` |
| Template | `lib/notifications/h36-reminder-template.ts`; registry `templates.ts:70` |
| Existing tests | `__tests__/notifications/h36-reminder.test.ts` (22 tests in the audit record) |

**VERIFIED.** Eligibility is `PUBLISHED`, not cancelled/archived, `startAt` in `(now, now+36h]`, `ISSUED` tickets on `PAID/PAID` orders with `paidAt`. Recipient is attendee phone, else holder phone; one per normalized phone per event (`:293-405`).

**VERIFIED limitations.**

- If the event starts before a tick runs, the query excludes it; no late reminder.
- The 500-ticket `take` has no cursor/pagination (`:317`). Tickets beyond 500 may never be enqueued.
- No email channel; WhatsApp only.
- No live send because of the shared gate.

### 2.2 Activation work

**PROPOSED.**

1. Add a **truncation guard**: if exactly 500 tickets were read for an event, count an explicit `truncatedEvents` result and log/alert. Do not silently claim full coverage.
2. Decide large-event policy before marketing H-36:
   - Option A (recommended for launch): cap eligibility at 500 issued tickets and state that limit in product copy/ops; do not enable events above it.
   - Option B: implement keyset pagination over `Ticket (createdAt, id)` with a bounded per-run loop and a persistent occurrence cursor. This requires a design/DB decision and is not part of the first activation.
3. Add `Retry-After`/operator visibility only if needed; the producer itself is enqueue-only.
4. Approve the exact WhatsApp copy and sender identity. The template already renders a timezone-aware time (`h36-reminder-template.ts`); no new copy should invent a time format.
5. Test reschedule/cancel/archive: old queued rows are `SKIPPED` by reconciliation; a new `startAt` creates a new key.
6. Run one controlled event with one internal ticket/phone; verify re-running the tick adds zero rows.
7. Observe the gateway send, provider id and ack; then widen to a small real event.

### 2.3 Acceptance

- At `startAt - 36h`, exactly one WhatsApp row per normalized phone per event.
- Re-run tick: zero new rows/sends.
- Reschedule: old occurrence skipped, new occurrence eligible.
- Cancel/archive before send: no send.
- Event already started: no new enqueue.
- Event with 501+ tickets: explicit truncation signal, not a silent partial success.
- One controlled live send observed; no duplicate after replay.

### 2.4 Rollback

Set `NOTIFICATIONS_ENABLED=false` or `WHATSAPP_LIVE_MODE=dry-run`, stop the worker/gateway; queued rows remain (no send). Revert the copy/pagination code if needed. Do not delete delivery history.

---

## 3. Purchase proof (and ticket-issued) delivery

### 3.1 Current implementation

**VERIFIED.**

| Concern | Location |
|---|---|
| Purchase-proof key | `lib/notifications/purchase-proof.ts:102-107` |
| Eligible order predicate | `isSettledOrder` (`:205-217`): `PAID`, `paymentStatus=PAID`, `paidAt != null` |
| Two channels | `enqueuePurchaseProof` (`:303-380`) |
| Post-commit hook | `lib/ticketing/payment/settlement.ts:625-633` |
| Recovery sweep | `sweepMissingPurchaseProofs` (`purchase-proof.ts:389-474`) |
| Template | `lib/notifications/purchase-proof-template.ts`; registry `templates.ts:69` |
| Ticket-issued key | `lib/notifications/ticket-issued.ts:74-79` |
| Ticket hook | `lib/ticketing/tickets/issuance.ts:644` |
| Ticket sweep | `ticket-issued.ts:391-471` |
| Existing tests | `purchase-proof*.test.ts`, `ticket-issued*.test.ts` |

**VERIFIED.** Each channel is queued independently; a failure in one does not decide the other. A replayed webhook or sweep converges on the unique key. Missing contact skips that channel; a non-empty invalid contact is queued and terminally skipped by the worker. Neither function throws into the payment/issuance transaction.

**VERIFIED limitation.** The proof is plain text, not a PDF invoice/e-ticket. There is no attachment path in `templates.ts` or `types.ts` (`OutboundEmail`/`OutboundWhatsApp` are text-only).

### 3.2 Activation work

**PROPOSED.**

1. Implement the SMTP adapter (Nodemailer) behind the existing `EmailTransport`; it must not be constructed until SMTP is configured. Resolve the nodemailer advisory decision recorded in the audit before production.
2. Implement the gateway-backed WhatsApp transport; see `whatsapp-gateway-design.md`.
3. Add the live-mode gate and allowlist from §1.2.
4. Verify one paid order in a controlled environment:
   - email row and WhatsApp row exist independently;
   - one provider id per channel;
   - replayed webhook adds no row;
   - `sweep:purchase-proof` adds no duplicate;
   - invalid phone skips only WhatsApp;
   - invalid email skips only email.
5. Repeat for ticket-issued, because it shares the transport and is already hooked after issuance.
6. Decide PDF separately. If required, attachments need a new message type, size/MIME validation, malware scanning and a separate approval; do not smuggle a PDF through the text template.

### 3.3 Acceptance

- One settled order produces at most one `purchase-proof.v1` row per channel.
- Replay/reconcile/sweep: no second row, no second send.
- Email failure does not block WhatsApp; WhatsApp failure does not block email.
- `SENT` only after a provider id exists; dry-run remains `SKIPPED`.
- One controlled live email and one live WhatsApp proof observed.
- Queue status is visible to an operator; no recipient appears in logs.

### 3.4 Rollback

Disable the channel (`WHATSAPP_TRANSPORT=dry-run`, `EMAIL_TRANSPORT=dry-run`) or the global kill switch; stop worker/gateway. Rows remain queued/skipped and can be reviewed. No payment data is touched.

---

## 4. PIC QR scanner verification

### 4.1 Current implementation

**VERIFIED.**

| Concern | Location |
|---|---|
| PIC page | `app/dashboard/pic/scan/[eventId]/page.tsx` |
| PIC API | `app/api/pic/events/[id]/check-in/route.ts` (POST only) |
| Authorization decider | `lib/authz/pic-assignment.ts:120-220` |
| Service branch | `lib/ticketing/checkin/service.ts:359-405`, `:473-490` |
| Rate limit | `lib/ticketing/checkin/pic-rate-limit.ts:1-74`; `lib/rate-limit.ts:828-895` |
| Limit | `PIC_SCAN_MAX_REQUESTS=120`, window 60s, keyed by `(userId,eventId)` |
| Audit fields | `actorKind`, `picProfileId` in `checkInTicket` (`service.ts:478`, `:547-548`, `:778-779`) |
| Existing tests | `__tests__/ticketing-checkin/*`, PIC security/assignment tests (see audit 3F record) |

**VERIFIED.** The PIC route is thin: CSRF, session, strict body, existing admission service. The PIC branch consumes the rate limit before any ticket lookup and fails closed with 503 if the limiter throws. Assignment refusal uses a masked 404. No GET/attendance log is mounted.

### 4.2 Activation/verification work

**PROPOSED.**

1. Provision a disposable real MariaDB `_test` schema and set `TEST_DATABASE_URL`; run the existing integration suites. This is the missing Phase 3G evidence.
2. Add/execute concurrency tests:
   - two parallel `checkInTicket` calls for one `Ticket` → exactly one success, one duplicate/conflict;
   - forced transaction failure → no `CheckIn` row, ticket remains `ISSUED`;
   - foreign event/unassigned PIC → masked 404;
   - suspended/revoked profile/assignment → denial;
   - two PICs, same event → separate rate buckets;
   - same PIC, two events → separate buckets;
   - limiter failure injection → 503, no DB query.
3. Verify audit rows persist `actorKind=PIC` and the correct `picProfileId`; rejected attempts carry no `ticketId` (unique).
4. Add `Retry-After` to the 429 response if the API error layer supports it; otherwise document that `details.retryAfterMs` is the only client hint. This is an edit to the error/route layer, not a new authorization rule.
5. Confirm scanner camera permission remains `camera=(self)` (`next.config.ts` Permissions-Policy) and no new CSP origin is introduced.
6. Do not claim production readiness from mocked tests; require recorded real-DB output.

### 4.3 Acceptance

- Exactly one accepted admission under a real two-connection race.
- One `CheckIn` row per successful ticket; unique constraint holds.
- PIC cannot read attendance or scan another event.
- 121st scan in a minute is refused with a retry hint; organizer path is unaffected.
- Audit attribution is correct.
- No Baileys/gateway dependency is involved in scanner verification.

### 4.4 Rollback

No schema change. Revert route/rate-limit code and redeploy. Scanner remains unavailable rather than admitting twice. Database rows from tests are isolated in `_test`.

---

## 5. Activation dependency matrix

| Feature | Gateway | SMTP | Worker | Real DB | Product copy | DB migration |
|---|---|---|---|---|---|---|
| H-36 | Required (WhatsApp) | No | Required | Recommended | Required | No |
| Purchase proof | Required for WA | Required for email | Required | Recommended | Optional PDF decision | No |
| Ticket-issued | Required for WA | Required for email | Required | Recommended | No | No |
| PIC scanner | No | No | No | **Required** | No | No |
| Document blast | Required for WA | Required for email | Required plus new batch job | Required | Required | **Yes, proposed** |

---

## 6. What must not be done during activation

- Do not set `NOTIFICATIONS_ENABLED=true` before the worker/gateway are supervised and the allowlist is configured.
- Do not send to a real customer as the first message.
- Do not remove the kill switch, caps or ambiguous-delivery refusal to "make testing easier".
- Do not interpret `SENT` as delivered.
- Do not reuse the H-36 idempotency key for a different start time or channel.
- Do not use the PIC scanner's `checkin.scan` authority for document publishing.
- Do not activate feature 4 before its migration/storage/authz design is approved.
