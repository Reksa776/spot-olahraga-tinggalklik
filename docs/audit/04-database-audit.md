# 04 — DATABASE AUDIT

**Engine:** MySQL/MariaDB (`provider = "mysql"`)
**ORM:** Prisma Client 6.19.3
**Schema:** `prisma/schema.prisma` (1,832 lines)
**Migrations:** 32 directories under `prisma/migrations/` + `migration_lock.toml`
**Scale in schema:** 36 models, 36 enums
**Observed database state:** none. No query was executed; `TEST_DATABASE_URL` is unset. This is a schema and write-path audit, not a live data audit.

---

## 1. Identity and platform tables

| Model → table | Purpose | Key constraints |
|---|---|---|
| `User` → `user` | One account for buyers and staff/PIC | `email @unique`, `phone @unique`, `platformRole?`, `disabledAt` |
| `Account` → `account` | OAuth accounts | `@@unique([provider, providerAccountId])` |
| `Session` → `session` | Adapter session rows (JWT is active strategy) | `sessionToken @unique` |
| `VerificationToken` | Auth.js token | `@@unique([identifier, token])` |
| `StoreSetting` → `storesetting` | Public store/legal contact data | singleton `id = 1` |
| `PlatformSetting` → `platformsetting` | Platform name, fees defaults, maintenance, branding | singleton `id = 1` |
| `AdminAuditLog` → `adminauditlog` | Append-only audit trail | indexes on action, actor, organizer+date, entity ref |
| `Notification` → `notification` | Outbox parent; subject links | `idempotencyKey @unique` |
| `NotificationDelivery` → `notificationdelivery` | Per-channel state/retry | `@@unique([notificationId, channel])` |

`User` carries **two** role dimensions: legacy `role` (`Role` enum, default `CUSTOMER`) and `platformRole` (`ADMIN | MANAGER | PIC | CUSTOMER`, nullable). Authorization reads `platformRole`; the legacy column is retained for compatibility and is not an authority source.

---

## 2. Tenant, staff and PIC tables

| Model → table | Purpose | Key constraints / relations |
|---|---|---|
| `Organizer` → `organizer` | Tenant; owner and commission defaults | `slug @unique`; owner `Restrict` |
| `OrganizerMember` → `organizermember` | Staff seat inside a tenant | `@@unique([organizerId, userId])`; role + status |
| `StaffEventAssignment` → `staffeventassignment` | Per-event grant for check-in staff | `@@unique([organizerMemberId, eventId])`; `eventId, revokedAt` index |
| `PermissionGrant` → `permissiongrant` | Explicit elevation (financial actions) | `@@unique([userId, organizerId, permission])` |
| `PICProfile` → `picprofile` | PIC business profile | `userId @unique`, `picCode @unique`, status |
| `PICEventAssignment` → `piceventassignment` | PIC authority for one event | `@@unique([picProfileId, eventId])`; active/revoked |
| `PICAttribution` → `picattribution` | One attribution per order | `orderId @unique` |
| `PICFeeLedger` → `picfeeledger` | Append-only fee ledger | `idempotencyKey @unique`; one EARNED per item via composite unique |

A PIC is **not** an `OrganizerMember`. This is structural: scanning authority comes from `PICProfile` + `PICEventAssignment`, not from the tenant role map.

---

## 3. Event and catalog tables

| Model → table | Purpose | Key fields |
|---|---|---|
| `Sport` → `sport` | Global sport taxonomy | `slug @unique`, `isActive` |
| `Venue` → `venue` | Global (`organizerId NULL`) or tenant venue | `organizerId?`; city/name index |
| `Event` → `event` | Event header and lifecycle | `slug @unique`, `eventCode @unique`, `startAt`, `endAt?`, `timezone`, `documentationUrl?`, status/visibility |
| `EventImage` → `eventimage` | Gallery metadata | `eventId, sortOrder` index |
| `TicketType` → `tickettype` | Price/quota/sales window | `price Decimal(14,2)`, `quota`, `sold`, `reserved`, `version` |
| `TicketReservation` → `ticketreservation` | DB-visible quota hold | `status`, `expiresAt`; order/ticketType/event FKs |

Event timezone defaults to `Asia/Jakarta`; both `startAt` and `timezone` are used by the H-36 reminder payload. `documentationUrl` is a **public post-event link**, not a private document.

---

## 4. Order, ticket and check-in tables

| Model → table | Purpose | Duplicate/consistency guard |
|---|---|---|
| `EventOrder` → `eventorder` | Order aggregate and money snapshot | `orderNumber @unique`; status/paymentStatus |
| `EventOrderItem` → `eventorderitem` | Immutable line snapshot + PIC fee snapshot | order index; ticket type nullable |
| `Ticket` → `ticket` | One row per admittee | `ticketCode @unique`, `qrTokenHash @unique`, `@@unique([orderItemId, sequenceNo])` |
| `CheckIn` → `checkin` | Admission/refusal ledger | `ticketId @unique` (nullable, success only); actor + event indexes |

`Ticket.status` transitions `RESERVED → ISSUED → CHECKED_IN` (or `VOID/REFUNDED`). `CheckIn.ticketId` is nullable so rejected scans can be recorded; the unique index allows only one row with a non-null ticket id, which is the second guarantee (after the status CAS) against double admission.

---

## 5. Payment, webhook and refund tables

| Model → table | Purpose | Key constraints |
|---|---|---|
| `Payment` → `payment` | Payment attempt | `paymentReference @unique`, `activeOrderId @unique` (one non-terminal attempt), provider transaction id |
| `PaymentTransaction` → `paymenttransaction` | Append-only provider movements | no unique replay key; redacted summary |
| `WebhookEvent` → `webhookevent` | Replay ledger | `providerEventId @unique`, `payloadHash`, status |
| `Refund` → `refund` | Refund header | `refundNumber @unique`, `idempotencyKey @unique`, evidence file fields |
| `RefundItem` → `refunditem` | One line per refunded ticket | `ticketId @unique` — a ticket cannot be refunded twice |

`Payment.activeOrderId` is the structural "one active attempt per order" rule: it equals `orderId` while `UNPAID/PENDING`, then becomes `NULL` at terminal state. MySQL treats multiple `NULL`s as distinct, so history is preserved without allowing a second active attempt.

---

## 6. Settlement, fee and notification tables

| Model → table | Purpose | Key constraints |
|---|---|---|
| `Settlement` → `settlement` | PIC/organizer payout | `settlementNumber @unique`; unique payee+period |
| `SettlementItem` → `settlementitem` | Settlement lines | `picFeeLedgerId @unique` (no double settlement) |
| `PICFeeLedger` → `picfeeledger` | Fee accounting | `idempotencyKey @unique`; `@@unique([orderItemId, type, reversalRef])` |
| `Notification` → `notification` | Outbox | `idempotencyKey @unique` |
| `NotificationDelivery` → `notificationdelivery` | Channel state | `@@unique([notificationId, channel])`, retry fields |
| `IdempotencyKey` → `idempotencykey` | Request replay | `@@unique([userId, scope, key])` |
| `JobLock` → `joblock` | Scheduler lease | `name` primary key, `lockedUntil`, `lastStatus` |

---

## 7. Relationships (principal paths)

```
User 1─* OrganizerMember *─1 Organizer 1─* Event 1─* TicketType
User 1─1 PICProfile 1─* PICEventAssignment *─1 Event
User 1─* EventOrder *─1 Event
EventOrder 1─* EventOrderItem 1─* Ticket
Ticket 1─0..1 CheckIn
EventOrder 1─* Payment 1─* PaymentTransaction
Payment 1─* WebhookEvent
EventOrder 1─* Refund 1─* RefundItem
EventOrder 1─0..1 PICAttribution
PICProfile 1─* PICFeeLedger *─1 Settlement
EventOrder 1─* Notification 1─* NotificationDelivery
```

All tenant-owned tables carry `organizerId`; a cross-tenant lookup must resolve the event/venue/order first and then authorize against its organizer. Service-layer masking returns 404 for cross-tenant denials.

---

## 8. Migration chain

32 migration directories span:

- retail-era baseline and later removals (`0_baseline`, 2026-08 migrations, `drop_unused_legacy_retail_tables`);
- notification tables (`20260820000000_add_notification_tables`);
- refund system and lifecycle (`20260827000000_add_refund_system`, `20260918000000_add_refund_lifecycle`, evidence columns);
- ticketing foundation (`20260916000000_ticketing_phase2_foundation`);
- event lifecycle + job lock (`20260919000000_add_event_lifecycle_and_joblock`);
- event documentation link (`20260922000000_add_event_documentation_url`);
- PIC fee snapshots/reversals and payout requests;
- payment active-attempt fix (`20260929000000_add_payment_active_order_id`);
- platform maintenance/branding and user deactivation.

The migration for `documentationUrl` is additive and explicitly notes it is a link, never a table index.

**Schema integrity in this session:** `prisma/schema.prisma` sha256 `0f48e1cea685e9e33b87dd411712514b31605c07053fd89a92e0607f59ac4a99`; `prisma/` and `prisma/migrations/` were clean before this audit. No migration, generate, push, reset, seed or truncate was run.

---

## 9. Feature dependency map

| Feature | Existing tables | Missing tables |
|---|---|---|
| H-36 reminder | `Event(startAt, timezone, status)`, `Ticket`, `EventOrder`, `Notification`, `NotificationDelivery`, `User` | **None required**; occurrence key fits `Notification.idempotencyKey` |
| Purchase proof | `EventOrder`, `Payment`, `Ticket`, `Notification`, `NotificationDelivery`, `StoreSetting` | **None** |
| PIC scanner | `PICProfile`, `PICEventAssignment`, `Ticket`, `CheckIn`, `Event`, `AdminAuditLog` | **None**; 3F uses existing actor column + audit metadata |
| Post-event blast | `Event.documentationUrl` only | **Document, document-event binding, recipient selection, delivery linkage** (proposal required) |

---

## 10. Database-level risks

| # | Risk | Evidence | Severity |
|---|---|---|---|
| D-1 | No document/recipient model | schema has no document table; only `Event.documentationUrl` | **Critical for feature 4** |
| D-2 | Public ticket code is the lookup credential | `Ticket.ticketCode` unique; QR payload is the code; raw `qrToken` never delivered | High (design-level) |
| D-3 | `CheckIn.ticketId` nullable-unique is subtle | Rejected rows use `NULL`; any future writer that sets a ticket id on a refusal will collide | Medium (documented) |
| D-4 | No DB-level check that settlement has exactly one payee | MySQL/Prisma cannot express XOR; service enforces | Medium |
| D-5 | Notification worker progress is not observable in this audit | No DB access; worker relies on `NotificationDelivery` state | Medium (operational) |
| D-6 | Real concurrency behaviour unverified | No `TEST_DATABASE_URL`; suites are mocked | High for production claim |
| D-7 | Legacy `Role` and `platformRole` coexist | two columns with different semantics | Low/Medium (debt) |
| D-8 | No document retention/expiry fields | feature 4 needs policy before schema | High (product) |

---

## 11. Recommendations

1. Keep the no-migration approach for H-36, purchase proof and scanner attribution; the existing unique keys are sufficient.
2. Before feature 4, produce a **proposed** migration only: `EventDocument`, `EventDocumentRecipient`/delivery linkage, private storage key, uploader, checksum, size/MIME, created/expiry. Do not apply it during audit.
3. Add real-database integration tests for the check-in CAS and notification idempotency before production sign-off.
4. Treat `Ticket.ticketCode` as a low-entropy admission credential in the threat model, or implement the owner decision for a scanner token.
