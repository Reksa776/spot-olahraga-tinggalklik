# 08 — QR CODE & CHECK-IN SYSTEM AUDIT

---

## 1. Files

| Concern | File |
|---|---|
| QR reference/payload builder | `lib/ticketing/tickets/reference.ts`, `payload.ts` |
| Check-in QR parser | `lib/ticketing/checkin/qr-payload.ts` |
| Admission service | `lib/ticketing/checkin/service.ts` (857 lines) |
| Request validation | `lib/ticketing/checkin/validation.ts` |
| PIC rate limit | `lib/ticketing/checkin/pic-rate-limit.ts` |
| Organizer API | `app/api/organizer/events/[id]/check-in/route.ts` |
| PIC API | `app/api/pic/events/[id]/check-in/route.ts` |
| Organizer page | `app/dashboard/events/[id]/check-in/page.tsx` |
| PIC page | `app/dashboard/pic/scan/[eventId]/page.tsx` |
| Scanner component | `components/organizer/TicketScanner.tsx` (1,393 lines) |
| Buyer QR render | `components/tickets/TicketQr.tsx`, `qrcode.react` |

---

## 2. QR payload and generation

- Format: **`TICKET:<ticketCode>`** (locked by `P14-D17`).
- The parser also accepts a bare code (keyboard-wedge/manual entry), trims whitespace, strips an optional `TICKET:` prefix, upper-cases, and requires the ticket-code pattern.
- Anything containing another colon (URL, `mailto:`, other product payload) is refused as `UNSUPPORTED_FORMAT`.
- The raw payload is never echoed in a refusal, UI message or audit payload.
- At issuance, a 32-byte random token is hashed into `Ticket.qrTokenHash`; the raw token is **never delivered**.
- The wallet renders the public ticket code, not the hash token.

**Interpretation:** the QR is an identifier, not an unforgeable credential. The design decision is deliberate (D-46 Option A); the security consequence is documented in section 7.

---

## 3. Admission service

`checkInTicket({ eventId, input, request })`:

1. **Access resolution**
   - Organizer path: `checkin.scan` in the event's organizer + active assignment when required.
   - If that is an authorization refusal, PIC fallback: active `PICProfile` + active `PICEventAssignment` for the exact event.
   - Database/programming errors are never converted into a second authorization attempt.
2. **PIC rate limit** — only `actorKind === "PIC"`; 120 requests/60s per `(session userId, eventId)`, before the first ticket query.
3. **Gate query** — event status, `endAt`, `archivedAt`, `cancelledAt`; `isEventCheckInOpen`.
4. **Input normalization** — `parseCheckInQrPayload`; malformed and unknown both become `NOT_FOUND`.
5. **Ticket lookup** — by `ticketCode`; wrong event is `WRONG_EVENT`.
6. **Eligibility** — unpaid/reserved, void/refunded, open refund (`REFUND_PENDING`) refused.
7. **Atomic admission** — conditional `updateMany` (`status: ISSUED → CHECKED_IN`) inside a transaction; creates one `CheckIn` row. Zero rows updated means a concurrent scan won; the loser reads the fresh state and reports `ALREADY_CHECKED_IN`.
8. **Audit** — `checkin.success` or `checkin.rejected`; accepted row has event, method, gate label, `actorKind`, `picProfileId`; no participant PII or QR secret.
9. **Realtime** — accepted admission publishes a ticket-checked-in invalidation; refusals are silent.

---

## 4. Duplicate-scan prevention

Two independent guarantees:

1. **Conditional status transition** — only a row currently `ISSUED` can become `CHECKED_IN`; concurrent callers race on the same condition, and only one receives `count === 1`.
2. **`CheckIn.ticketId @unique`** — at most one row with a non-null ticket id can exist. Rejected scans use `ticketId = NULL`, which MySQL allows multiple times, so they do not consume the unique slot.

The `CheckIn` row and ticket transition are in one transaction, so a successful admission always has its ledger row and vice versa. The client-side cooldown in `TicketScanner` is only UX; the server is authoritative.

---

## 5. Scanner implementation

`components/organizer/TicketScanner.tsx`:

- Continuous camera loop; one Start action; no per-ticket submit.
- `BarcodeDetector` when available; `jsQR` fallback over an off-screen canvas.
- Camera diagnostics: secure context, `mediaDevices`, `getUserMedia`, detector support; maps `NotAllowedError`, `NotFoundError`, `NotReadableError`, `OverconstrainedError`, `SecurityError`, `AbortError` to actionable messages.
- Waits for real video pixels before detection; pauses when tab hidden; releases tracks on unmount and `visibilitychange`.
- `busyRef` ensures one in-flight submission; a 1.5s same-payload cooldown suppresses repeated frames.
- Payload is capped/sanitized, never persisted or logged.
- `endpoint` prop defaults to `/api/organizer/events/{id}/check-in`; PIC page passes `/api/pic/events/{id}/check-in`.
- `canReadLog={false}` on the PIC page removes the attendance list and its fetch.

---

## 6. Authorization at the endpoints

| Endpoint | Guards | Notes |
|---|---|---|
| `POST /api/organizer/events/[id]/check-in` | CSRF + `requireAuth` + service `checkin.scan` + assignment | Organizer/staff |
| `GET /api/organizer/events/[id]/check-in` | CSRF not required; `checkin.log.read` | Attendance list |
| `POST /api/pic/events/[id]/check-in` | CSRF + `requireAuth` + PIC profile+assignment | POST only; no GET |
| PIC page | `requirePicScanAccess`; masked `notFound()` | Server-rendered; no client identity |

The route accepts only the event id from the path and a strict body (`code`, optional `gateLabel`, `deviceId`, `clientScannedAt`). It does not accept `ticketId`, `status`, `checkedInAt`, `checkedInBy*`, `organizerId` or `role`. All state is server-derived.

---

## 7. Security analysis

| Threat | Control | Residual risk |
|---|---|---|
| Forged scan request | Session + assignment + event scope | None found |
| Cross-event scan | Event id must match ticket's event and assignment | None found |
| Double admission | CAS + unique CheckIn | Concurrency unproven on real DB |
| PIC scan flood | 120/min per user+event; fail-closed limiter | Per-process; resets on restart |
| PIC sees other operator | `firstCheckedInBy` null for PIC; no log | None found |
| PII leak to PIC | Response includes attendee name only; no contact | Attendee name is necessary for gate UX |
| Raw QR leak | Payload never logged/audited; no token delivered | **Code itself is public** |
| Revoked PIC scans | Assignment re-checked every request | 60s scope cache does not cache assignment decision |
| Malformed payload probing | Same NOT_FOUND shape | None found |
| Camera permission failure | Explicit diagnostics | No functional scanner without camera (manual fallback exists) |

**Most important residual risk:** a valid ticket code can be guessed/shared. There is no cryptographic proof that the presenter owns the ticket. Rate limiting and event/status checks reduce abuse but do not eliminate screenshot/shared-code admission. This is a product decision that should be explicit before marketing the scanner as "secure QR".

---

## 8. Real-database evidence

Not available in this audit. The admission transaction, unique insert under two connections, PIC assignment lookup against real rows, and audit persistence are covered by mocked/pure suites (50 transaction tests, 44 PIC API/authz tests, 16 3F security tests, 13 page tests), not by a live MariaDB run. Phase 3G remains open.

---

## 9. Findings and recommendations

| # | Finding | Recommendation |
|---|---|---|
| Q-1 | PIC scanner page, API, assignment authz and rate limiting exist | Keep; add real-DB tests |
| Q-2 | QR is the public ticket code | Decide whether a scanner token is required; do not call it cryptographic verification |
| Q-3 | Duplicate prevention is CAS + unique | Preserve both; never replace with a read check |
| Q-4 | PIC cannot see attendance | Keep unless a new permission is designed |
| Q-5 | Rate limit is per-process | Use shared store if multi-instance |
| Q-6 | 429 lacks `Retry-After` header | Add if scanner should back off automatically |
| Q-7 | Real concurrency unverified | Phase 3G before production claim |
