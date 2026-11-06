# PHASE 3D — PIC SCANNER API DESIGN

**Status:** written before the route/guard edits (Checkpoint 2).
**Baseline:** same as the audit (`9b8fecd…`, Phase 3C worktree preserved).

---

## 1. Endpoint

```
POST /api/pic/events/[id]/check-in
```

- Under `/api/pic/`, already in `proxy.ts`'s `PROTECTED_API_PREFIXES` (line 134), so the edge
  requires a session and `__tests__/authz/route-classification.test.ts` classifies the new file.
- `POST` only. There is deliberately **no GET**: B-4 forbids a PIC reading the attendance log,
  and `listEventCheckIns` requires `checkin.log.read`, which no PIC holds.
- `runtime = "nodejs"` (Prisma is not available on the edge), matching the organizer gate route.

## 2. Request flow (server-side, fail-closed)

```
requireSameOrigin(request)              → 403 on missing/foreign Origin (before parsing)
requireAuth()                           → 401 when no server-side session
params.id                               → the event scope (route segment, never the body)
request.json() → checkInRequestSchema   → 400 VALIDATION_ERROR (strict)
checkInTicket({ eventId: id, input, request })
  ├─ requireEventCheckInAccess(id)
  │    ├─ organizer path (unchanged): membership + checkin.scan (+ staff assignment)
  │    └─ on an authorization refusal → PIC path:
  │         requireAuth() scope.userId
  │         PICProfile by userId (id, userId, status)
  │         PICEventAssignment by (picProfileId, eventId) (isActive, revokedAt)
  │         decidePicEventPermission({ userId, eventId, picProfile, assignment })
  │             deny → AuthzError(code) (401/403/404 per the 3A contract)
  │             allow → same CheckInAccess shape, memberId null
  ├─ gate window → parser → ticket lookup → event match
  ├─ transaction: FOR UPDATE → refund guard → CAS → CheckIn insert (method MANUAL)
  └─ refusals: append-only row + checkin.rejected audit; success: realtime + checkin.success
```

The route adds **no** authorization condition of its own: the decider is invoked inside the
service's single access guard, which is the only place the admission writer is reachable from.

## 3. Request schema (reused verbatim)

`checkInRequestSchema` (`lib/ticketing/checkin/validation.ts`), `.strict()`:

| Accepted | Type / bound |
|---|---|
| `code` | string, trimmed, 1–120 |
| `gateLabel` | string ≤ 60, `""`/`null` → null, optional |
| `deviceId` | string ≤ 120, optional |
| `clientScannedAt` | ISO string or `Date`, informational only, optional |

Anything else is a `VALIDATION_ERROR` (400). In particular `eventId`, `userId`, `picProfileId`,
`assignmentId`, `role`, `permissions`, `method`, `checkInMethod`, `result`, `status`,
`checkedInAt`, `checkedInByUserId`, `ticketId`, `organizerId` are refused — the trust boundary is
the schema, not a route-side allow-list.

## 4. Response

Success: `200 { success: true, data: CheckInSuccess }` — the Phase 3C service payload unchanged
(`result`, `event`, `ticket`, `ticketType`, `method`, `gateLabel`, `checkedInAt`). `method` is
always `"MANUAL"` for this route; `QR_SCAN` is unreachable.

Errors: the shared envelope `{ success: false, code, message, details? }`, with `correlationId`
added only for server faults. No stack trace, no Prisma text, no raw submitted code, no internal
decider `reason`.

| Situation | HTTP | `code` |
|---|---|---|
| No session / invalid session | 401 | `UNAUTHORIZED` |
| Authenticated, not a PIC and not a member | 404 | `ORGANIZER_ACCESS_DENIED` |
| PIC profile not ACTIVE | 403 | `PIC_ACCESS_DENIED` |
| No/inactive/revoked assignment, or another event | 404 | `ORGANIZER_ACCESS_DENIED` |
| Missing/blank event id | 404 | `NOT_FOUND` |
| Invalid body (including any override attempt) | 400 | `VALIDATION_ERROR` |
| Unknown or malformed code | 404 | `NOT_FOUND` (same message as an unknown ticket) |
| Wrong event ticket | 409 | `CONFLICT` (`reason: WRONG_EVENT`) |
| Not eligible (VOID/REFUNDED/RESERVED) | 409 | `CONFLICT` (`TICKET_NOT_ISSUED`) |
| Duplicate | 409 | `TICKET_ALREADY_CHECKED_IN` |
| Open refund | 409 | `CONFLICT` (`REFUND_PENDING`) |
| Gate closed | 409 | `CONFLICT` (`EVENT_NOT_OPEN`) |
| Unexpected | 500 | `INTERNAL_ERROR` + correlation id |

## 5. Event scope

The only event identity used is the `[id]` segment. The body cannot name an event (strict schema),
and the assignment is queried with **that** id and the session profile. A PIC assigned to event A
scanning event B therefore looks up no assignment, and the decider answers
`ORGANIZER_ACCESS_DENIED` 404 — indistinguishable from an event that does not exist.

## 6. CSRF and HTTP

`requireSameOrigin` runs first, exactly like every other state-changing route. JSON body only
(`request.json()`), and a non-object body is a `VALIDATION_ERROR`. No new middleware, no new
auth library, no unauthenticated path.

## 7. Phase 3F boundary

- **Rate limiting:** none added. `lib/rate-limit.ts` exists (in-memory sliding window), but no
  check-in limiter is configured; a PIC scan burst limit is Phase 3F work.
- **Audit:** the existing service writes `checkin.success` / `checkin.rejected` and preserves the
  service-level authorization. There is no PIC-distinct audit action and no durable "which PIC
  scanned" field; attribution remains Phase 3F (B-5 prefers audit JSON over a new column).
- **Attribution:** `CheckIn.checkedInByUserId` records the session user today; no PIC profile id
  is written.

## 8. Test strategy

Two focused suites, both DB-free and explicitly labelled:

1. `__tests__/ticketing-checkin/pic-scan-authz.test.ts` — the real `requireEventCheckInAccess`
   with mocked Prisma/session: staff path preserved, non-member 404, PIC allow, wrong event,
   inactive/revoked assignment, non-ACTIVE profile, unauthenticated, database failure propagates.
2. `__tests__/ticketing-checkin/pic-scan-api.test.ts` — the route handler with the check-in
   service mocked: CSRF, 401, strict-schema override attempts, exactly-once service invocation,
   error mapping, no leak, no GET.

Real-database concurrency remains Phase 3G; the Phase 3C transaction suite is re-run but proves
branch structure only.
