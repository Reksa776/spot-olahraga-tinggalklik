# 14 — FEATURE GAP ANALYSIS

Status is based on current source, not on the original premise. Features 1–3 are already built to different degrees; feature 4 is not.

---

## 1. Summary table

| Feature | Existing Module | Missing Module | Required Changes | Complexity |
|---|---|---|---|---|
| H-36 Reminder | Event `startAt`/`timezone`, issued tickets, contacts, outbox, worker, templates, third tick job | Live WhatsApp transport, approved copy/ops, large-event pagination, monitoring | Owner activation, provider hosting, copy approval, pagination, alerts | **Medium** |
| Purchase Proof Delivery | Settlement/issuance hooks, templates, two-channel enqueue, worker, retries, idempotency | Live SMTP/WhatsApp, PDF attachment (if required), delivery monitoring UI | Activate transports, verify one real send per channel, decide PDF, add monitoring | **Low–Medium** |
| PIC QR Scanner | PIC page, API, assignment decider, CAS admission, 3F rate limit/audit | Real-DB concurrency proof (3G), shared limiter, `Retry-After` | Integration tests, optional shared limiter, scanner backoff | **Low–Medium** |
| Post-Event Document Blast | `COMPLETED` lifecycle, tickets/contacts, PIC assignment, private-file patterns, notification runtime | Document model, private upload, recipient selection, document template, blast job, access route, UI, retention, malware scan | Proposed migration + storage + authz + batch delivery + UI + audit | **High–Critical** |

Complexity reasons are in §6.

---

## 2. FEATURE 1 — H-36 WhatsApp Reminder

1. **Current condition.** Built, dry-run only. `runH36ReminderSweep` enqueues one WhatsApp row per phone per event at `startAt - 36h`; a third tick job runs it. No live message can leave the host.
2. **Available modules.** `lib/notifications/h36-reminder.ts`, `h36-reminder-template.ts`, `templates.ts`, `enqueue.ts`, `queue.ts`, `worker.ts`, contacts, `lib/jobs/tick.ts`, `lib/jobs/lock.ts`.
3. **Missing modules.** Live WhatsApp transport/hosting, approved production copy, queue/lease alerting, pagination beyond 500 tickets/event, a late-reminder policy.
4. **Related files.** `lib/notifications/h36-reminder.ts` (sweep, offset, key), `h36-reminder-template.ts` (payload/render/timezone), `lib/jobs/tick.ts:169`, `lib/jobs/lock.ts:36`, `lib/notifications/config.ts:38`, `__tests__/notifications/h36-reminder.test.ts` (22 tests).
5. **Database tables.** `Event` (`startAt`, `timezone`, `status`, `cancelledAt`, `archivedAt`), `Ticket` (`status`, phone), `EventOrder` (`PAID`), `User.phone`, `Notification`, `NotificationDelivery`.
6. **Existing API endpoints.** `POST /api/internal/jobs/tick` (machine only). No reminder-specific endpoint.
7. **Needed API endpoints.** None for the core flow. Optional admin endpoint for reminder run/status is not required and would add a new authority surface.
8. **Backend changes.** Owner-approved transport activation; pagination/cursor; alerting; optional email channel if product expands beyond WhatsApp.
9. **Frontend changes.** None required. Optional delivery-status view for operators.
10. **External integrations.** A live WhatsApp provider (Baileys hosting or an approved business API) and a supervised worker.
11. **Security considerations.** Phone numbers are PII; logs must not include them. One message per phone per event; idempotency prevents duplicates. A provider ban/rate limit must not cause retry storms. Do not add a public resend endpoint.
12. **Implementation risks.** Missed tick → no reminder after start; 500-ticket cap; reschedule creates a new occurrence (intended); provider policy/hosting; no live evidence.
13. **Recommendation.** Keep the dry-run engine, add pagination/monitoring, and make live activation an OPS decision. Do not claim H-36 delivered until one controlled live message is observed.

---

## 3. FEATURE 2 — Ticket Purchase Proof Delivery

1. **Current condition.** Built, dry-run only. Settlement and issuance enqueue email/WhatsApp rows post-commit/after issuance; worker retries; no live send.
2. **Available modules.** `purchase-proof.ts`, `purchase-proof-template.ts`, `ticket-issued.ts`, `ticket-issued-template.ts`, contacts, enqueue/queue/worker, settlement and issuance hooks.
3. **Missing modules.** Live SMTP/WhatsApp, PDF invoice/e-ticket generator (if required), delivery monitoring/resend UI, alerting.
4. **Related files.** `lib/notifications/purchase-proof.ts:102` (keys), `lib/ticketing/payment/settlement.ts:625-631` (post-commit hook), `lib/notifications/ticket-issued.ts:74`, `lib/ticketing/tickets/issuance.ts:644`, `lib/notifications/config.ts:38`.
5. **Database tables.** `EventOrder`, `Payment`, `Ticket`, `StoreSetting`, `Notification`, `NotificationDelivery`.
6. **Existing API endpoints.** `POST /api/ticketing/payment/webhook`, `POST /api/organizer/payments/[paymentReference]/reconcile`, `POST /api/ticketing/orders/[orderNumber]/issue`.
7. **Needed API endpoints.** None public. Optional authenticated operator endpoint to inspect/retry a delivery; not necessary for launch.
8. **Backend changes.** Activate transports, verify one real send per channel, decide text vs PDF, add queue alerts, optionally expose delivery status.
9. **Frontend changes.** Optional delivery-status column on order detail; optional resend (operator) action.
10. **External integrations.** SMTP (Nodemailer) and WhatsApp (Baileys or approved provider).
11. **Security considerations.** Recipient PII; normalized/validated contacts; no raw payload in logs; idempotency per channel; attachments require malware/size controls; do not expose a public resend endpoint.
12. **Implementation risks.** Provider failures, queue stuck without worker, duplicate sends if idempotency bypassed, text proof may not meet "bukti pembelian" expectations, live evidence absent.
13. **Recommendation.** Low-risk activation once transport is approved; add monitoring before increasing volume. Treat PDF as a separate product decision.

---

## 4. FEATURE 3 — PIC QR Scanner

1. **Current condition.** Built end-to-end: assignment-based authz, PIC page, POST API, shared scanner, CAS admission, 3F rate limit and audit attribution. Real-DB concurrency and multi-instance limits remain unproven.
2. **Available modules.** `lib/authz/pic-assignment.ts`, `requirePicScanAccess` / `checkInTicket`, `app/api/pic/events/[id]/check-in/route.ts`, `app/dashboard/pic/scan/[eventId]/page.tsx`, `TicketScanner`, `pic-rate-limit.ts`.
3. **Missing modules.** Phase 3G real MariaDB integration suite; shared/distributed limiter; `Retry-After` handling; real-device acceptance evidence in this audit.
4. **Related files.** `lib/ticketing/checkin/service.ts:350-520`, `pic-rate-limit.ts`, `qr-payload.ts`, `components/organizer/TicketScanner.tsx:532-592`, `__tests__/ticketing-checkin/*`.
5. **Database tables.** `PICProfile`, `PICEventAssignment`, `Ticket`, `CheckIn`, `Event`, `AdminAuditLog`.
6. **Existing API endpoints.** `POST /api/pic/events/[id]/check-in`; organizer `GET/POST /api/organizer/events/[id]/check-in`.
7. **Needed API endpoints.** None for the core requirement. A PIC GET/attendance or override endpoint is deliberately absent and should not be added without a new decision.
8. **Backend changes.** Add real-DB integration tests (two connections), optionally replace the per-process limiter, emit `Retry-After` for 429.
9. **Frontend changes.** Honor 429 with a visible cooldown; optional offline queue is out of scope.
10. **External integrations.** Browser camera APIs only (`getUserMedia`, `BarcodeDetector`/jsQR).
11. **Security considerations.** PIC must remain event-scoped and assignment-checked; no attendance list; no other operator identity; rate limit; audit; public code credential caveat.
12. **Implementation risks.** Real concurrency could produce a duplicate if the CAS/unique guarantee is misunderstood; multi-instance rate bypass; scanner camera failures; shared ticket codes.
13. **Recommendation.** Close 3G before production sign-off; keep the separate PIC decider; do not widen PIC permissions for feature 4 by reuse.

---

## 5. FEATURE 4 — Post-Event Document Blast

1. **Current condition.** **Not implemented.** Only `Event.documentationUrl`, a public Google Drive link shown after `COMPLETED`. No private document, recipient list, delivery, or audit.
2. **Available modules.** Lifecycle completion, ticket/participant contact data, PIC assignment decider, private-file patterns (settlement/refund evidence), notification queue/worker (dry-run), audit writer, dashboard UI primitives.
3. **Missing modules.** Document entity and migration; private upload/storage; recipient selection; document template; blast producer/batch job; authorized download route; PIC document authorization; delivery history; retention/expiry; malware scanning; UI.
4. **Related files.** `prisma/schema.prisma:924` (`documentationUrl`), `lib/events/validation.ts:98-120`, `app/e/[slug]/page.tsx:320-337`, `components/organizer/EventDocumentationManager.tsx`, `lib/ticketing/settlement/proof.ts` (reusable pattern), `lib/authz/pic-assignment.ts` (pattern, not reusable permission), `lib/notifications/templates.ts` (no document template).
5. **Database tables.** Existing: `Event`, `Ticket`, `EventOrder`, `PICEventAssignment`, `PICProfile`, `Notification`, `NotificationDelivery`, `AdminAuditLog`. **Missing:** document, event-document binding, recipient/delivery linkage, access/expiry metadata.
6. **Existing API endpoints.** None for documents. `documentationUrl` is edited through the organizer event page, not a document API.
7. **Needed API endpoints (proposal only).** `POST /api/pic/events/[id]/documents` (upload), `GET .../documents` (list), `POST .../documents/[documentId]/send` (select recipients), `GET .../documents/[documentId]/deliveries`, and an authenticated download route. Paths/names are proposals, not current code.
8. **Backend changes.** Proposed migration; private storage tree; document-specific PIC decider (do not reuse `checkin.scan`); recipient query from tickets; unique delivery keys; batch job with cap/cursor; audit; expiry cleanup; content validation/scanning.
9. **Frontend changes.** PIC document page with upload, participant selection, channel choice, progress/status and history; no public link.
10. **External integrations.** Live WhatsApp/email (currently dry-run), optionally malware scanning; no cloud storage integration exists.
11. **Security considerations.** Private-by-default; per-recipient access; PIC only for assigned completed events; no public URLs; prevent recipient enumeration; bulk-send abuse limits; PII minimisation; audit; retention; file type/size/magic-byte validation.
12. **Implementation risks.** Highest of the four: schema migration, privacy/legal exposure, mass-send provider limits, storage durability, accidental public serving, duplicate sends, undefined eligibility (holder vs attendee, refunded tickets).
13. **Recommendation.** Run a design/approval phase first. Produce a **proposed migration and threat model**, obtain owner decisions on eligibility/retention/provider, then implement backend, then UI. Do not extend `documentationUrl` or the public image route.

---

## 6. Complexity rationale

| Feature | Rating | Why |
|---|---|---|
| H-36 | **Medium** | Code exists; remaining work is live transport, copy approval, ops and scale edges. No schema. |
| Purchase proof | **Low–Medium** | Code exists; activation and verification; PDF only if required. |
| PIC scanner | **Low–Medium** | Feature built; remaining work is evidence (3G), shared limiter, small UX backoff. |
| Document blast | **High–Critical** | New schema, private storage, new authorization axis, recipient model, batch delivery, UI, retention and legal/privacy decisions. |

---

## 7. Cross-feature dependencies

```
Live transport (OPS-1) ──┬── H-36 live
                         ├── Purchase proof live
                         └── Document blast delivery

PIC assignment ──────────┬── PIC scanner (done)
                         └── Document blast authorization

Event COMPLETED ─────────┴── Document blast eligibility

Private storage pattern ──── Document upload/download
Notification outbox ──────── Document delivery tracking / retries
```

**Do not start feature 4 implementation before the migration/storage/authorization design is approved.**
