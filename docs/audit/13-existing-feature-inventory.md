# 13 — EXISTING FEATURE INVENTORY

Inventory of what exists in the current tree. Status values: **Built**, **Dry-run only**, **Partial**, **Missing**.

---

## 1. Product surfaces

| Area | Status | Main modules / routes | UI |
|---|---|---|---|
| Public event catalog | Built | `/api/events`, `/api/sports`, `lib/events/catalog.ts` | `/events`, `/e/[slug]` |
| Event detail/share | Built | `/api/events/[slug]`, `.../share` | public event page, share menu |
| Buyer checkout | Built | `/api/ticketing/checkout`, `lib/ticketing/checkout.ts` | `TicketPurchaseForm` |
| Buyer orders | Built | `/api/ticketing/orders*`, `lib/ticketing/orders.ts` | `/ticketing`, order page |
| Payment (iPaymu) | Built | `/pay`, `/webhook`, `lib/ticketing/payment/*` | `PaymentInstruction` |
| Ticket issuance/wallet | Built | `/issue`, `lib/ticketing/tickets/*` | `/ticketing`, `TicketQr` |
| Refunds | Built (manual rail) | `/api/ticketing/refunds*`, `lib/ticketing/refunds/*` | order/refund actions |
| Check-in (organizer) | Built | `/api/organizer/events/[id]/check-in` | event check-in page, `TicketScanner` |
| Check-in (PIC) | Built | `/api/pic/events/[id]/check-in` | `/dashboard/pic/scan/[eventId]` |
| PIC attribution/fees | Built | `lib/pic/*`, `PICAttribution`, `PICFeeLedger` | PIC dashboard/reports |
| PIC payouts | Built | `/api/pic/payouts`, settlement service | PIC payout dialog |
| Organizer events | Built | `/api/organizer/events*` | dashboard event pages |
| Ticket types | Built | `/api/organizer/events/[id]/ticket-types*` | `TicketTypeManager` |
| Venues/sports | Built | `/api/organizer/venues*`, `/api/admin/*` | managers |
| Settlements | Built | `/api/organizer/settlements*` | settlement pages |
| Reporting/exports | Built | `/api/organizer/reports/export`, `/api/reports/*` | reports page |
| Admin users/settings | Built | `/api/admin/users*`, `/api/admin/settings/*` | settings/users pages |
| Realtime invalidation | Built | `/api/realtime/stream`, `lib/realtime/*` | provider/banner |
| Notifications | **Dry-run only** | `lib/notifications/*`, worker | none |
| H-36 reminder | **Dry-run only** | `lib/notifications/h36-reminder*`, third tick job | none |
| Purchase proof | **Dry-run only** | `lib/notifications/purchase-proof*` | none |
| Ticket-issued message | **Dry-run only** | `lib/notifications/ticket-issued*` | none |
| Event documentation link | Built (public link) | `Event.documentationUrl` | `EventDocumentationManager` |
| Post-event document blast | **Missing** | — | — |

---

## 2. API inventory (75 route handlers)

**Public**
- `GET /api/events`, `/api/events/[slug]`, `/api/events/[slug]/share`, `/api/sports`
- `/api/uploads/events/[filename]`, `/api/uploads/branding/[filename]`
- `/api/health`, `/api/health/ready`
- `/api/auth/[...nextauth]`, `/api/auth/register`
- `POST /api/ticketing/payment/webhook` (HMAC, not session)
- `POST /api/internal/jobs/tick` (bearer secret, not session)

**Ticketing (session, own scope)**
- `POST /api/ticketing/checkout`
- `GET /api/ticketing/orders`, `GET /api/ticketing/orders/[orderNumber]`
- `POST /api/ticketing/orders/[orderNumber]/pay`, `/cancel`, `/issue`
- `GET /api/ticketing/tickets`, `/api/ticketing/tickets/[ticketCode]`
- `POST /api/ticketing/refunds`, `.../refunds/[refundId]/{approve,reject,execute,settle,fail}`
- `GET /api/ticketing/refunds/[refundId]/evidence/[fileName]`

**Organizer (session + tenant permission)**
- events CRUD/publish/unpublish/cancel/archive/complete/images/check-in/ticket-types
- venues, PIC assignment, PIC fee report/export
- payments reconcile, settlements and proof, refunds and evidence, report export

**PIC (session + profile/assignment)**
- `POST /api/pic/events/[id]/check-in`
- `GET/POST /api/pic/payouts`

**Admin (session + platform permission)**
- sports, venues, PIC, users, application/branding settings

**Reports**
- `/api/reports/my-pic-fee`, `/export`, `/pic-fee-reconciliation`

---

## 3. Dashboard pages (27)

- `/dashboard` overview
- `/dashboard/events`, `/events/new`, `/events/[id]`, `/events/[id]/check-in`
- `/dashboard/orders`, `/orders/[orderNumber]`
- `/dashboard/payments`, `/refunds`, `/settlements`, `/settlements/[id]`
- `/dashboard/check-in`
- `/dashboard/pic`, `/pic/[id]`, `/pic/orders/[orderNumber]`, `/pic/scan/[eventId]`
- `/dashboard/venues`
- `/dashboard/reports`
- `/dashboard/customers`
- `/dashboard/users`
- `/dashboard/settings`, `/settings/application`, `/settings/branding`, `/settings/maintenance`, `/settings/sports`, `/settings/venues`

No page exists for document upload, recipient selection or blast history.

---

## 4. Reusable components

| Component | Reuse potential |
|---|---|
| `TicketScanner` | Already reused by organizer and PIC; endpoint prop |
| `EventDocumentationManager` | Public link only; not a document blast UI |
| `CheckInPanel` | Gate results/attendance |
| `SettlementActions` / `SettlementPrepareForm` | Money workflow patterns |
| `RefundEvidenceActions` | Private file upload/read pattern |
| `PicAssignmentManager` | Event-PIC assignment |
| `PicPayoutRequestDialog` | PIC dialog pattern |
| `primitives.tsx`, `components/dashboard/ui` | Consistent UI |
| `ReportFilters`, `charts` | Reporting |
| `RealtimeProvider` | Invalidation refresh |

---

## 5. Notifications inventory

| Producer | Trigger | Channels | Idempotency | Live? |
|---|---|---|---|---|
| Purchase proof | settlement commit | Email + WhatsApp | per channel + order | **No** |
| Ticket issued | issuance | Email + WhatsApp | per channel + order | **No** |
| H-36 reminder | tick, 36h before | WhatsApp | event+ticket+startAt+channel | **No** |

Worker: separate process, retries, delivery states. Transports: dry-run only; SMTP/Baileys stubs refuse.

---

## 6. Jobs inventory

| Job | Trigger | Effect |
|---|---|---|
| `event-lifecycle` | tick every minute | PUBLISHED→ONGOING→COMPLETED |
| `reservation-reaper` | tick | expire abandoned orders/release seats |
| `h36-reminder` | tick | enqueue reminder rows |
| notification worker | separate process | claim/send/retry deliveries |
| purchase-proof sweep | manual | enqueue missing rows |
| ticket-issued sweep | manual | enqueue missing rows |

---

## 7. Database inventory (feature-relevant)

Identity: `User`, `Account`, `Session`, `Organizer`, `OrganizerMember`, `StaffEventAssignment`, `PermissionGrant`, `PICProfile`, `PICEventAssignment`.
Catalog: `Sport`, `Venue`, `Event`, `EventImage`, `TicketType`.
Sales: `TicketReservation`, `EventOrder`, `EventOrderItem`, `Ticket`, `Payment`, `PaymentTransaction`, `WebhookEvent`.
Admission: `CheckIn`.
Money: `Refund`, `RefundItem`, `PICAttribution`, `PICFeeLedger`, `Settlement`, `SettlementItem`.
Messaging: `Notification`, `NotificationDelivery`.
Operations: `IdempotencyKey`, `JobLock`, `AdminAuditLog`, `PlatformSetting`, `StoreSetting`.

No document/recipient/distribution model.

---

## 8. Test inventory

- **184 test files** in 27 directories under `__tests__/`.
- Largest groups: auth-flow 14, ticketing-checkin 13, notifications 13, events 13, ticketing-ui 12, pic-self-service 11, ticketing-payment 10, realtime 10, security 9, ticketing-pic 9.
- Prior focused execution (Phase 3F) ran **11 suites / 339 tests**, all passing: pic-security 16, pic-assignment 66, qr-validation 76, transaction 50, wiring 29, pic API 24, pic authz 20, contract 17, pic page 13, route classification 6, h36 22.
- **No real database was used**; `TEST_DATABASE_URL` is unset. Mocked/pure suites are not DB evidence.

---

## 9. External services

| Service | State |
|---|---|
| iPaymu | Active integration, sandbox/production config |
| SMTP | Adapter stub; dry-run clamp |
| Baileys WhatsApp | Adapter stub; dry-run clamp |
| Database | MySQL/MariaDB |
| Object storage | None |
| Redis/queue | None |
| Monitoring/APM | None found |

---

## 10. Inventory conclusion

The platform is broad and operational for buying, paying, issuing, refunding, reporting and checking in. Messaging is built but cannot send. The only product objective with no implementation is the post-event document blast.
