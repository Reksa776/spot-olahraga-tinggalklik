# 06 — EVENT MANAGEMENT AUDIT

---

## 1. Event data model

`Event` (`prisma/schema.prisma:906`) carries:

- identity: `id`, `slug @unique`, `eventCode @unique`, optional `shareCode @unique`;
- tenant: `organizerId`, `createdByUserId`;
- catalog: sport, optional venue, title, description, rules, banner;
- time: `startAt`, optional `endAt`, `salesStartAt`, `salesEndAt`, `timezone` (default `Asia/Jakarta`);
- lifecycle: `status` (`DRAFT`, `PENDING_REVIEW`, `PUBLISHED`, `ONGOING`, `COMPLETED`, `CANCELLED`, `ARCHIVED`), `visibility`, `publishedAt`, `cancelledAt`, `cancelReason`, `completedAt`, `archivedAt`;
- policy: `maxTicketsPerOrder`, `requiresCheckIn`, `returnQuotaOnRefund`, `refundDeadlineAt`;
- contact: `contactName`, `contactPhone`;
- post-event: `documentationUrl` (public Google Drive link, shown after completion).

Related tables: `EventImage`, `TicketType`, `TicketReservation`, `EventOrder`, `Ticket`, `CheckIn`, `PICEventAssignment`, `StaffEventAssignment`, `Notification`.

---

## 2. Event APIs

| Route | Methods | Authority |
|---|---|---|
| `/api/events` | GET | Public catalog |
| `/api/events/[slug]` | GET | Public detail |
| `/api/events/[slug]/share` | GET | Public share metadata |
| `/api/organizer/events` | GET, POST | Active membership + `event.read` / `event.write` |
| `/api/organizer/events/[id]` | GET, PATCH, DELETE | `requireEventAccess` |
| `/api/organizer/events/[id]/publish` | POST | `event.publish` |
| `/api/organizer/events/[id]/unpublish` | POST | `event.publish` |
| `/api/organizer/events/[id]/cancel` | POST | event write/publish policy |
| `/api/organizer/events/[id]/archive` | POST | event write policy |
| `/api/organizer/events/[id]/complete` | POST | manual completion after `endAt` |
| `/api/organizer/events/[id]/ticket-types` | GET, POST | `ticket_type.write` |
| `/api/organizer/events/[id]/ticket-types/[ticketTypeId]` | PATCH, DELETE | ticket-type authority |
| `/api/organizer/events/[id]/check-in` | GET, POST | `checkin.scan` / `checkin.log.read` |
| `/api/organizer/events/[id]/images` | GET, POST, PATCH | `event.write` + banner upload |
| `/api/organizer/pic` | GET, POST | `pic.assign` |
| `/api/organizer/pic/[id]` | PATCH, DELETE | `pic.assign` |

All organizer routes require an authenticated session and resolve the organizer from the event row, not from a caller-supplied tenant id. Cross-tenant access is masked as 404.

---

## 3. Create / update / publish

- **Create:** `POST /api/organizer/events`; event starts `DRAFT`; organizer comes from authorized context, never from the body.
- **Update:** `PATCH /api/organizer/events/[id]`; validated by `lib/events/validation.ts`; status changes are not free-form (lifecycle routes own them).
- **Publish:** `POST .../publish` requires `event.publish`; publication sets `publishedAt` and makes the event visible according to `visibility`.
- **Unpublish:** `POST .../unpublish` returns it to a non-public state.
- **Delete:** a `DELETE` handler exists on `/api/organizer/events/[id]`. This audit did not execute it and did not verify whether it hard-deletes or is constrained by orders/tickets; operators should prefer cancel/archive for events with sales. The schema uses `Restrict` on most event-owned relations, so a hard delete of an event with tickets/orders would be refused by the database.
- **Cancel:** records `cancelledAt` + reason; cancellation is distinct from status and is checked by the H-36 reminder query.
- **Archive:** sets `archivedAt`; archived events are excluded from lifecycle and reminders.
- **Manual complete:** `mayCompleteManually` allows completion only after `endAt`; no early completion path.

---

## 4. Lifecycle automation

`lib/events/lifecycle.ts` is the canonical lifecycle:

```
PUBLISHED ──startAt──▶ ONGOING ──endAt + 30m──▶ COMPLETED
```

- `ONGOING` is derived from `startAt`; there is no stored `ongoingAt`.
- `COMPLETED` is automatic at `endAt + CHECK_IN_GRACE_MS` (30 minutes) or manual after `endAt`.
- An event with no `endAt` can never auto-complete.
- Transitions use `updateMany` with the full predicate (CAS) and write one audit row per successful transition.
- The tick passes one `now` to every job, so boundaries cannot be straddled mid-run.
- A scheduler outage is recovered by the next tick: a late run resolves the final state, not a fabricated intermediate one.

**Manager control:** a manager with `event.write`/`event.publish` controls publish/unpublish/cancel/archive and manual completion. Automatic transitions cannot be overridden except by cancellation/archival.

---

## 5. Organizer, manager, PIC and participant links

| Relationship | Mechanism |
|---|---|
| Event → organizer | `Event.organizerId` (required, `Restrict`) |
| Organizer → manager/staff | `OrganizerMember` with role + status; authorization requires `ACTIVE` |
| Staff → event | optional `StaffEventAssignment` for `checkin.scan` without `checkin.override` |
| Event → PIC | `PICEventAssignment` (`picProfileId`, `eventId`, active flag, revokedAt) |
| PIC → user | `PICProfile.userId @unique` |
| Participant → event | `EventOrder` + `Ticket` (`holderUserId`, attendee name/email/phone); there is **no separate participant table** |
| Participant → check-in | `CheckIn` via `ticketId` |
| Event → attribution | `PICAttribution` per order, `PICFeeLedger` per item |

There is no `EventParticipant` model. Participant identity is the ticket holder/attendee fields on `Ticket`, plus buyer fields on `EventOrder`. Any feature that needs "select participants" must define whether it means ticket holders, attendees, or buyers — this is a product decision, not an existing query.

---

## 6. Timezone and scheduling

- `Event.timezone` is stored and used by notification templates for human-readable event time (H-36 uses `formatH36EventTime` with the zone).
- Database timestamps are instants (`DateTime`); timezone is presentation/interpretation, not a separate offset.
- Sales windows (`salesStartAt/salesEndAt`) and ticket-type windows are evaluated server-side in `lib/events/sales-state.ts`.
- The gate window includes `endAt + 30 minutes`; the same constant is used by lifecycle completion and check-in.
- The buyer's browser clock never decides availability or gate state.

**Risk:** a timezone string is not validated at the schema level; invalid zones are rejected by the reminder payload builder and counted as ineligible, but other surfaces may render incorrectly. Event form validation should be checked when changing timezone behavior.

---

## 7. Post-event documentation link

`Event.documentationUrl` (schema:924) is an optional Google Drive URL:

- validated as HTTPS and restricted to Google Drive hosts (`lib/events/validation.ts:98-120`);
- edited via `components/organizer/EventDocumentationManager.tsx`;
- displayed publicly on `app/e/[slug]/page.tsx:320-337` only when the event is `COMPLETED`;
- **anyone with the link can open it**; there is no per-participant authorization, expiry, recipient list or delivery tracking.

This is a link-sharing feature, **not** the requested post-event document blast.

---

## 8. Findings

| # | Finding | Severity |
|---|---|---|
| E-1 | Event lifecycle and sales windows are centralized and CAS-guarded | Strength |
| E-2 | Manager control via membership + permission map is clear | Strength |
| E-3 | PIC event scope uses a separate assignment table and decider | Strength |
| E-4 | `documentationUrl` is public and unsuitable for private post-event documents | High for feature 4 |
| E-5 | No `EventParticipant` model; "participant" must be defined per feature | Medium |
| E-6 | Delete semantics for events with sales were not executed/verified | Medium |
| E-7 | Timezone is free text and not DB-validated | Low/Medium |

---

## 9. Recommendations

1. Keep lifecycle transitions in `lib/events/lifecycle.ts`; do not add ad-hoc status writes for feature 4.
2. Use `COMPLETED` + an explicit document eligibility rule for post-event blast, but do not reuse the public `documentationUrl` for private files.
3. Define recipients as ticket holders (or attendees) explicitly, and include refunded/void tickets only by product decision.
4. Validate timezone against `Intl.supportedValuesOf("timeZone")` or an allow-list before storing it, if timezone becomes input-critical for reminders.
5. Document deletion vs cancel/archive; prefer archive for any event with financial history.
