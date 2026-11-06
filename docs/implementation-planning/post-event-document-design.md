# Post-Event Document Design

**Status:** PROPOSED — no document model, migration, route, upload or delivery exists.

**Existing condition (VERIFIED).** The only post-event artifact is `Event.documentationUrl` (`prisma/schema.prisma:924`): an optional Google Drive share link, validated as HTTPS and restricted to Drive hosts (`lib/events/validation.ts:127-184`), edited through `components/organizer/EventDocumentationManager.tsx`, and shown publicly after `COMPLETED` (`app/e/[slug]/page.tsx:321-337`). It has no private storage, recipient selection, delivery, expiry or audit. It must not be reused for private documents.

---

## 1. Evaluation of existing models before proposing new ones

| Existing model | Useful for feature 4? | Decision |
|---|---|---|
| `Event` (`schema.prisma:906`) | Defines the completed event and organizer | Reuse; add a relation only |
| `Ticket` (`:1168`) | Defines participant identity/contact and issued/refunded/void state | Reuse as eligibility source; no new contact columns |
| `EventOrder` (`:1060`) | Paid/refunded status and buyer contacts | Reuse for eligibility and fallback contact |
| `PICProfile` / `PICEventAssignment` (`:1427`, `:1470`) | Active PIC + exact-event assignment | Reuse as authority input, not as an RBAC role |
| `Notification` / `NotificationDelivery` (`:197`, `:1722`) | Outbox, per-channel delivery state, retries, idempotency | Reuse as the delivery engine |
| `AdminAuditLog` (`:260`) | Append-only operator audit | Reuse for upload/publish/revoke actions |
| `Settlement` / `Refund` evidence storage (`lib/ticketing/settlement/proof.ts`, `lib/ticketing/refunds/evidence.ts`) | Server filenames, magic bytes, private read route, no-store | Reuse the **pattern**, not the tables/paths |
| `StoreSetting` (`:136`) | Store identity | Not needed |

**Conclusion:** do not overload `documentationUrl`, `EventImage`, or the settlement/refund proof columns. A document has an independent lifecycle, recipient set, access grants and retention, so it needs its own tables.

---

## 2. Proposed data model

**PROPOSED.** All changes are additive. No migration is created or applied here. Relation fields must be added to the referenced models (`Event`, `Organizer`, `User`, `PICProfile`, `Ticket`, `EventOrder`, `NotificationDelivery`) when the migration is authored.

```prisma
enum EventDocumentStatus {
  DRAFT
  SCANNING
  READY
  PUBLISHING
  PUBLISHED
  REVOKED
  DELETED
}

enum EventDocumentScanStatus {
  PENDING
  CLEAN
  INFECTED
  FAILED
}

enum EventDocumentRecipientStatus {
  ACTIVE
  REVOKED
}

model EventDocument {
  id                    String                @id @default(cuid())
  eventId               String
  organizerId           String
  uploadedByUserId      String
  uploadedByPicProfileId String?
  title                 String                @db.VarChar(200)
  description           String?               @db.Text
  originalFileName      String                @db.VarChar(255)
  storageKey            String                @unique @db.VarChar(191)
  contentType           String                @db.VarChar(100)
  sizeBytes             Int
  checksumSha256        String                @db.VarChar(64)
  status                EventDocumentStatus   @default(DRAFT)
  scanStatus            EventDocumentScanStatus @default(PENDING)
  scanMessage           String?               @db.Text
  retentionUntil        DateTime?
  publishedAt           DateTime?
  revokedAt             DateTime?
  deletedAt             DateTime?
  createdAt             DateTime              @default(now())
  updatedAt             DateTime              @updatedAt

  event       Event               @relation(fields: [eventId], references: [id], onDelete: Restrict)
  organizer   Organizer           @relation(fields: [organizerId], references: [id], onDelete: Restrict)
  uploadedBy  User                @relation(fields: [uploadedByUserId], references: [id], onDelete: Restrict)
  uploadedByPic PICProfile?       @relation(fields: [uploadedByPicProfileId], references: [id], onDelete: SetNull)
  recipients  EventDocumentRecipient[]
  deliveries  EventDocumentDelivery[]

  @@index([eventId, status])
  @@index([organizerId, status])
  @@index([retentionUntil, status])
  @@map("eventdocument")
}

model EventDocumentRecipient {
  id                  String                      @id @default(cuid())
  documentId          String
  eventId             String
  orderId             String
  /// Representative ticket; one human may hold several tickets.
  ticketId            String?
  userId              String?
  /// SHA-256 of the preferred normalized contact, used for dedupe only.
  recipientKey        String                      @db.VarChar(64)
  recipientType       NotificationRecipientType   @default(CUSTOMER)
  displayName         String?                     @db.VarChar(200)
  email               String?                     @db.VarChar(320)
  phone               String?                     @db.VarChar(32)
  recipientTicketCount Int                        @default(1)
  accessExpiresAt     DateTime
  accessRevokedAt     DateTime?
  accessCount         Int                         @default(0)
  lastAccessedAt      DateTime?
  status              EventDocumentRecipientStatus @default(ACTIVE)
  createdAt           DateTime                    @default(now())
  updatedAt           DateTime                    @updatedAt

  document  EventDocument  @relation(fields: [documentId], references: [id], onDelete: Cascade)
  event     Event          @relation(fields: [eventId], references: [id], onDelete: Restrict)
  order     EventOrder     @relation(fields: [orderId], references: [id], onDelete: Restrict)
  ticket    Ticket?        @relation(fields: [ticketId], references: [id], onDelete: SetNull)
  user      User?          @relation(fields: [userId], references: [id], onDelete: SetNull)
  deliveries EventDocumentDelivery[]

  @@unique([documentId, recipientKey])
  @@index([documentId, status])
  @@index([eventId, orderId])
  @@index([ticketId])
  @@map("eventdocumentrecipient")
}

model EventDocumentDelivery {
  id                     String                     @id @default(cuid())
  documentId             String
  recipientId            String
  channel                NotificationDeliveryChannel
  /// Null until the bounded enqueue job creates the Notification/Delivery pair.
  notificationDeliveryId String?                    @unique
  createdAt              DateTime                   @default(now())
  updatedAt              DateTime                   @updatedAt

  document     EventDocument     @relation(fields: [documentId], references: [id], onDelete: Cascade)
  recipient    EventDocumentRecipient @relation(fields: [recipientId], references: [id], onDelete: Cascade)
  notificationDelivery NotificationDelivery? @relation(fields: [notificationDeliveryId], references: [id], onDelete: SetNull)

  @@unique([recipientId, channel])
  @@index([documentId, notificationDeliveryId])
  @@map("eventdocumentdelivery")
}
```

**Design note:** `EventDocumentDelivery` deliberately has **no mutable delivery status**. `NotificationDelivery.status`, `attemptCount`, `errorCode` and the proposed ack fields are the single source of truth. Duplicating status here would create two answers to "was it sent?". The link row exists for reporting, idempotency and a stable per-recipient/channel identity.

**Relationship to `Notification`:** the notification idempotency key is
`event-document:{documentId}:{recipientId}:{channel}:v1` (approximately 100–150 characters, below the 191-character limit in `lib/notifications/enqueue.ts:41`). The notification is created only by the bounded dispatch job, never inside an upload request.

---

## 3. Recipient eligibility and selection

**PROPOSED policy, requiring owner approval:**

- Event must be `COMPLETED` (`completedAt` set), not `CANCELLED` and not archived.
- Order must be `PAID` with `paymentStatus = PAID` and `paidAt` non-null, matching the existing settled-order rule (`lib/notifications/purchase-proof.ts:205-217`).
- Ticket must be `ISSUED` or `CHECKED_IN`; exclude `REFUNDED`, `VOID`, `CANCELLED`.
- Contact preference: attendee phone/email first, then holder user phone/email. Normalize with `normalizeIndonesianPhone()`/`normalizeEmail()` (`lib/notifications/contacts.ts`). A ticket with no usable contact is excluded and reported as `NO_CONTACT`; it is never guessed.
- Deduplicate by `recipientKey` so one human with three tickets receives one message, not three. `recipientTicketCount` records the grouping; the representative ticket is retained for audit.
- The client may submit **recipient ids only**, never raw phone/email values. The server re-reads each id and revalidates that it belongs to the document/event. A forged id is a 404, not a send.
- The PIC selection list is masked (display name plus masked phone/email). It is a new privacy surface; it does not grant access to the attendance log or raw contact export.

**Do not** expose an "export all recipients" action by default. If reporting requires it, add a separate permission and audit.

---

## 4. Authorization

### 4.1 Organizer staff

**PROPOSED.** Add organizer-scope permission strings to `lib/authz/permissions.ts`:

- `event.document.manage` — upload, edit metadata, revoke, delete within the tenant.
- `event.document.read` — read document metadata and delivery report.

Add these to the organizer role maps deliberately (OWNER/MANAGER; FINANCE/CHECKIN_STAFF should not receive them). Every access re-checks `requireOrganizerAccess(event.organizerId, permission)`; the tenant is derived from the event row, never from the request.

### 4.2 PIC

**PROPOSED.** A PIC may publish a document only when all are true:

1. authenticated user;
2. own `PICProfile` with `status = ACTIVE`;
3. active, non-revoked `PICEventAssignment` for **this exact event**;
4. event is `COMPLETED`;
5. document belongs to that event/organizer;
6. the document is `READY` and its scan is `CLEAN`.

Implement a pure `decidePicEventDocumentPermission()` alongside `lib/authz/pic-assignment.ts:120-220`, reusing the profile/assignment snapshot shape but **not** the `checkin.scan` permission. Scanning authority and document-publishing authority are different capabilities. A revoked assignment must immediately block upload/publish and must not invalidate already-sent recipient links (the document is already published); owner may revoke the document explicitly.

### 4.3 Recipients

**PROPOSED.** Two access paths:

1. **Signed link** for email/WhatsApp recipients. Possession of the link is a bearer grant, because attendees may not have accounts.
2. **Authenticated portal** for logged-in holders, own-scope only, with no token in the URL; lists published documents for events where the user holds an eligible ticket.

The signed link is generated at send/render time and is **not stored**:

- Token payload: `v1`, `documentId`, `recipientId`, `expiresAt` (epoch seconds).
- Signature: HMAC-SHA256 with `DOCUMENT_LINK_SECRET` (32 random bytes, host-only).
- Encoding: base64url payload + `.` + base64url signature.
- Server verifies signature in constant time, expiry, `EventDocument.status = PUBLISHED`, `recipient.status = ACTIVE`, `accessRevokedAt = null`, and document/recipient relationship.
- No raw token in `Notification.payload`, database, logs or analytics. The payload stores only ids and expiry; the template signs at render time.
- Secret rotation invalidates outstanding links; use a versioned key if zero-downtime rotation is required.

**Residual risk:** a forwarded link works until expiry/revocation. If the owner requires identity proof, add OTP or require login for account holders before launch; do not pretend the token is identity.

---

## 5. Private storage and document validation

**PROPOSED.**

- Root: `<UPLOAD_DIR>/event-documents/<documentId>/<random>.<ext>`.
- Not under `events/` or `branding/`; no public static route.
- Server-generated path components only; `documentId` validated as a cuid/opaque id, random name from `crypto.randomBytes(16)`. Original filename is metadata only.
- Max size: 10 MB proposed (existing image/proof cap is 5 MB). Configurable only through a reviewed constant/env; no per-request override.
- Accepted types: PDF (`%PDF-`), JPEG, PNG, WebP. Reject SVG, HTML, Office, ZIP, executables and anything whose magic bytes do not match. Client MIME is ignored.
- Check actual bytes after buffering; write to `.tmp`, `fsync`, `rename`, `chmod 0600`; directory `0700`.
- SHA-256 checksum stored; optional duplicate detection.
- Malware scan: `DocumentScanner` interface with ClamAV (or approved equivalent). `PENDING` blocks publish; `INFECTED`/`FAILED` blocks publish and alerts. If the scanner is unavailable, **fail closed** (do not publish). No scanner exists in the repository today; this is a deployment prerequisite.
- PDFs are served as `Content-Disposition: attachment`; never inline, so the browser does not render active content. `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`.
- Delete path uses the stored key, never a caller path; missing file is idempotent.

---

## 6. Access route

**PROPOSED.** `GET /api/event-documents/access/[token]` (Node runtime):

1. Parse token; reject malformed/oversized input.
2. Verify HMAC and expiry in constant time.
3. Load recipient + document; enforce `PUBLISHED`, `ACTIVE`, not revoked/deleted.
4. Check `retentionUntil`; expired → `410`.
5. Rate-limit by token/recipient/IP (the existing in-memory limiter can be used initially; note it is per-process).
6. Atomically increment `accessCount`, set `lastAccessedAt` (best effort; a failure must not block the download).
7. Stream bytes from the private path with `attachment`, stored content type, `nosniff`, `private, no-store`.
8. No directory listing, no public filename, no token logging. A wrong token is a plain 404.

The route is intentionally not a Next.js page; no HTML wrapper, no analytics script, no referrer leakage. The global `Referrer-Policy` in `next.config.ts` is `strict-origin-when-cross-origin`; a token in a URL path is still visible in the recipient's browser history and to the messaging provider, so link expiry/revocation are mandatory.

---

## 7. Batch delivery

**PROPOSED flow:**

```
1. PIC/staff uploads → DRAFT → scan → READY
2. prepare (server):
   - re-check event COMPLETED, authority, scan CLEAN
   - freeze eligible recipients (deduped) + channels
   - create EventDocumentDelivery rows (notificationDeliveryId = null)
   - status = PUBLISHING
3. tick job event-document-dispatch:
   - select ≤100 pending EventDocumentDelivery rows for PUBLISHING docs
   - enqueueNotification(key, channel, recipient snapshot, template event-document.v1,
     category DOCUMENT, priority 40, payload with documentId/recipientId/expiry/origin)
   - link the returned delivery id
   - when every row is linked, status = PUBLISHED
4. existing worker claims and sends; retries apply
5. report joins EventDocumentDelivery → NotificationDelivery
```

Why a job instead of creating all notifications in the HTTP request: a 500-recipient blast must not hold an upload request open, and an unbounded fan-out can exhaust the queue. The job is bounded, idempotent and resumable; a crash after enqueue but before linking self-heals because `enqueueNotification` returns the existing delivery for the same key (`lib/notifications/enqueue.ts:224-280`).

**Channels:**

- **Email:** plain-text link. No attachment in MVP. The existing `OutboundEmail` type is text-only (`lib/notifications/types.ts:36-40`).
- **WhatsApp:** text + signed link. No attachment in MVP.
- **Attachments:** evaluate later. Baileys can send a `document` message, but attachments increase ban/size/malware risk, cannot be revoked, and require buffering/streaming from private storage. If approved, add a separate gateway endpoint with MIME/size checks, malware scan proof, and no caller-supplied URL/path. Email attachments require the same. Do not bolt attachments onto the text path.

**Caps:** document WhatsApp uses `WHATSAPP_DOCUMENT_DAILY_CAP`, default 0/disabled until owner approval. It is separate from the 20/day transactional cap and still subject to the absolute platform cap. Transactional messages (proof, ticket, H-36) have priority.

---

## 8. Reporting, audit and retention

**PROPOSED.**

- Per document: recipient count, channel counts, `QUEUED/SENDING/SENT/FAILED/SKIPPED`, ack counts, access count.
- Per recipient: masked contact, channels, last status, error code, access count/last access. Raw contact is visible only to authorized organizer staff, never PIC by default.
- Audit (`AdminAuditLog`, `schema.prisma:260`): `event_document.uploaded`, `scanned`, `published`, `revoked`, `deleted`, `recipient_selection_changed`. Do not write a row for every download; use counters and aggregate reports.
- `retentionUntil` is set at publish by policy (owner decision; a 90-day default is a proposal, not a legal conclusion). A retention job:
  1. marks `DELETED`, revokes links;
  2. after a grace window, deletes the private file;
  3. leaves audit/report rows intact.
- A deleted/revoked document returns 404/410, never a stale cached file.

---

## 9. Threat model

| Threat | Control |
|---|---|
| Public URL guessing | No static path; 256-bit signed token; 404 on invalid; rate limit |
| Forwarded link | Short expiry, revocation, access counts; bearer risk documented |
| Cross-tenant access | Event-derived organizer + membership check; PIC exact assignment; 404 masking |
| PIC sees all participant PII | Masked list, dedicated permission, no raw export; product approval |
| Malicious PDF/image | Magic bytes, size cap, ClamAV/approved scanner, fail closed, attachment disposition |
| Path traversal | Server-generated path; basename guard; no caller path |
| Token in logs/payload | Token generated at render from HMAC; payload holds ids/expiry only; logger redaction |
| Replay/duplicate blast | Unique document+recipient+channel; Notification idempotency key; link job idempotent |
| Blast spam/ban | Separate cap, priority, delay, transaction reservation, no public trigger |
| Data retention breach | `retentionUntil`, revoke + purge job, encrypted backup policy |
| Stale document after event | Publish only for completed event; revoke action; status check on every access |

---

## 10. Proposed files and surfaces

| Area | Proposed path |
|---|---|
| Storage/validation | `lib/event-documents/storage.ts`, `validation.ts`, `scanner.ts` |
| Authorization | `lib/event-documents/authz.ts` (organizer + PIC deciders) |
| Access token | `lib/event-documents/access-token.ts` |
| Recipient selection | `lib/event-documents/recipients.ts` |
| Batch enqueue | `lib/event-documents/dispatch.ts`, `scripts/event-document-sweep.ts` |
| Template | `lib/notifications/event-document-template.ts`; register `event-document.v1` |
| API | `app/api/organizer/events/[id]/documents/*`, `app/api/pic/events/[id]/documents/*`, `app/api/event-documents/access/[token]/route.ts` |
| UI | `app/dashboard/events/[id]/documents/*`, `app/dashboard/pic/documents/[eventId]/*` |
| Audit/retention | `lib/event-documents/retention.ts`; audit actions |
| Tests | `__tests__/event-documents/*` |

No route, model, template or UI above exists today.

---

## 11. Migration and rollback proposal

**PROPOSED migration, not created:**

- new enums `EventDocumentStatus`, `EventDocumentScanStatus`, `EventDocumentRecipientStatus`;
- new tables `eventdocument`, `eventdocumentrecipient`, `eventdocumentdelivery`;
- new enum value `NotificationCategory.DOCUMENT`;
- relation fields on existing models;
- indexes shown above;
- no change to `Event.documentationUrl` and no data backfill.

**Rollback:** stop document writers/worker; disable feature flag; export audit; drop the three tables and relation fields; remove `DOCUMENT` enum value only if no rows use it. Because MySQL enum changes are not trivially reversible, prefer keeping `DOCUMENT` once deployed and rolling back code only. Never delete notifications/deliveries as part of rollback.

**Compatibility:** all new columns/tables are additive; existing notification code must continue to work if the document feature is disabled. The `DOCUMENT` category must be handled explicitly by caps/reporting, not fall through to an unclassified path.

---

## 12. Open product decisions

1. Include non-attending but paid ticket holders, or only checked-in attendees?
2. Retain documents for 30/90/365 days after the event?
3. Allow PIC to select individual recipients, or only "all eligible"?
4. Are email/WhatsApp attachments ever required, or is a signed link sufficient?
5. Is the signed link acceptable as bearer access, or must account holders log in/OTP?
6. Who approves a blast above the initial recipient/cap threshold?
