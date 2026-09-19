# PHASE 16 — TICKET WALLET + QR PRESENTATION AUDIT REPORT

**Project:** TinggalKlik.Co
**Type:** Pre-implementation audit. No code was changed to produce it.
**Sources read:** `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md`, `PHASE_15_EVENT_AUTOMATION_IMPLEMENTATION_REPORT.md`, `PHASE_13_EVENT_AUTOMATION_CHECKIN_REPORT.md`, `PHASE_12_EVENT_COMPLETION_REPORT.md`, `TICKETING_PHASE1_DESIGN.md`, `prisma/schema.prisma`, and the live source tree.

Classification vocabulary: **IMPLEMENTED** (works, verified) · **PARTIAL** (exists but incomplete) ·
**DESIGN ONLY** (specified in the design, not built) · **MISSING** (absent) · **CONTRADICTORY**
(source disagrees with the locked contract).

---

## A. Existing ticket lifecycle — IMPLEMENTED

`prisma/schema.prisma` → `model Ticket`:

| Field | Meaning |
| --- | --- |
| `ticketCode` `@unique` | `EVT-XXXX-XXXX` public lookup code (`lib/ticketing/tickets/reference.ts`) |
| `qrTokenHash` `@unique` | SHA-256 of the 32-byte scanner secret; the raw value is never stored |
| `qrVersion` `Int @default(1)` | reissue counter (no writer yet; `ticket.reissue` is a later phase) |
| `status` | `TicketStatus`: `RESERVED \| ISSUED \| CHECKED_IN \| VOID \| REFUNDED` |
| `checkedInAt`, `issuedAt`, `refundedAt` | timestamps; `checkedInAt` is the canonical admission state |
| `holderUserId` | the buyer; the ownership anchor for every read |
| `eventId`, `orderId`, `orderItemId`, `ticketTypeId`, `sequenceNo` | relations and 1..N position |

`VOID` has **no writer** anywhere in the tree and `voidedAt` is not a column — design vocabulary
without a phase. Not a gap for this phase.

## B. Existing issuance — IMPLEMENTED

`lib/ticketing/tickets/issuance.ts`: `issueTicketsForOrder` mints `ticketCode` +
`qrTokenHash: hashQrToken(generateQrToken())` inside the settlement-guarded transaction,
idempotent on replay, retried on unique collision. The raw token is discarded — nothing has a
variable for it. Covered by the Phase 8 suites.

## C. Existing ticket API — IMPLEMENTED

| Route | Contract |
| --- | --- |
| `GET /api/ticketing/tickets` | `listOwnTickets` — `holderUserId = session.user.id` inside the `where`, plus `ticket.read.own`; **no `qr` in the list** (design §26.5) |
| `GET /api/ticketing/tickets/[ticketCode]` | `getOwnTicket` — same ownership predicate, returns `qr.payload`; a foreign or malformed code is an indistinguishable **404** |

Both sit under `/api/ticketing/`, which `proxy.ts` lists in `PROTECTED_API_PREFIXES`, and each
handler also calls `requireAuth()` itself. There is no public ticket API, and no
`/api/public/tickets/**`.

## D. Existing buyer wallet — IMPLEMENTED

`app/ticketing/tickets/page.tsx` (design §26.5) with `?view=upcoming|all|past`
(`lib/ticketing/ui/wallet.ts`), rendering `components/ticketing/TicketCard.tsx`. Ownership is
resolved by the service, never by the page. `?view=past` is a presentation slice of the
authorised list, not a second query.

## E. Existing ticket detail — IMPLEMENTED

`app/ticketing/tickets/[ticketCode]/page.tsx` (design §26.6): event header, venue, ticket type,
status badge, QR (or a blocked panel), the code in large mono type, order reference, issue time,
and check-in time **when it is set**. `force-dynamic`, `robots: noindex`.

## F. Existing QR / token handling — IMPLEMENTED (matches the locked contract)

`lib/ticketing/tickets/reference.ts`:

* `TICKET_QR_PREFIX = "TICKET:"`, `buildTicketQrPayload(ticketCode)` → `` TICKET:${ticketCode} ``
  — **exactly the Phase 14 D-46 contract.** It throws on a value that is not a well-formed code.
* `assertQrPayloadIsSafe(payload)` — rejects a payload that is not exactly a namespaced ticket code.
* `hashQrToken` — the only representation of the token that is ever persisted.

Repository-wide search for `qrToken` / `qrTokenHash` / `qrVersion`:

| Location | Verdict |
| --- | --- |
| `lib/ticketing/tickets/issuance.ts` (write path) | correct — `qrTokenHash: hashQrToken(generateQrToken())`, raw value never bound |
| `lib/ticketing/tickets/payload.ts` | selects `qrVersion` only; **never** `qrTokenHash` |
| `app/api/ticketing/tickets/**` | payload/comment only; no secret selected or returned |
| `lib/ticketing/tickets/reference.ts` | generator + hash + comments |
| `prisma/schema.prisma`, migration SQL | column definition |
| all other files | prose in comments and assertions in tests |

**No API returns, serialises, logs, audits, or renders `qrToken` or `qrTokenHash`.** No leak to
fix. The wallet list deliberately carries no QR at all; the detail carries
`TICKET:<ticketCode>` and nothing else.

`CheckInMethod.QR_SCAN` — **unused**, exactly as Phase 14 requires (the gate records `MANUAL`).

## G. Existing check-in flow — IMPLEMENTED

`POST /api/organizer/events/[id]/check-in` → `checkInTicket` (`lib/ticketing/checkin/service.ts`):
event gate (`isEventCheckInOpen`) → `checkin.scan` + `StaffEventAssignment` → ticket lookup →
event match → **open-refund guard (D-28)** → `SELECT … FOR UPDATE` → CAS
`ISSUED → CHECKED_IN` → `CheckIn` insert, with an append-only refusal row + `checkin.rejected`
audit on every rejection. It consumes `input.code` (a ticket code), i.e. exactly what the QR
carries once the `TICKET:` prefix is stripped.

## H. Existing scanner capability — PARTIAL (by design)

No camera/scanner library exists (`zxing`, `jsqr`, `html5-qrcode`, `barcode`, `quagga` — none
installed, none referenced). `components/organizer/CheckInPanel.tsx` is the **keyboard-wedge**
scanner surface and already has: `autoFocus` on mount, `inputRef.current?.focus()` in the
`finally` of every submit (so a wedge can fire the next code), `autoComplete="off"`,
`spellCheck={false}`, a large mono input (`h-12 text-base tracking-wider`), Enter-to-submit via
`<form>`, a `disabled` state while busy, and a visible success/error/duplicate outcome.

Phase 14's contract permits exactly this ("manual field / keyboard-wedge scanner"), so no scanner
framework will be added.

## I. Existing print / PDF capability — MISSING

No print affordance, no `print:` utility classes anywhere in `app/**` or `components/**`, no PDF
engine (`jspdf`, `pdfkit`, `puppeteer`, `react-to-print` — none installed). A dynamic
`/api/ticketing/tickets/[ticketCode]` route returning a PDF does not exist.

## J. Existing dependencies — no change required

Already installed and sufficient: `qrcode.react@^4.2.0` (QR rendering, already used by
`components/tickets/TicketQr.tsx`), `zod`, `@prisma/client`, Tailwind v4 (`print:` variants
available). No QR/scanner/PDF/UI package is needed for this phase.

## K. Existing authorization — IMPLEMENTED

* Buyer reads: `ticket.read.own` + a `holderUserId` predicate in the query itself; a foreign or
  unknown code is a 404, never a 403 (no existence oracle).
* Gate: `checkin.scan`, tenant scoping, `StaffEventAssignment`, and `checkin.log.read` for the
  admissions list. `PIC` and `FINANCE` hold neither permission.
* No new permission key exists to invent; `ticket.view.any` / `ticket.qr.view.any` are absent
  from the Phase 3 map and must stay absent.

## L. Existing tests — IMPLEMENTED

`__tests__/ticketing-issuance/issuance.integration.test.ts` (QR payload format/stability, no-PII
serialisation, wallet list carries no QR, cross-user 404, multi-ticket orders),
`__tests__/ticketing-ui/wallet-views.test.ts`, `__tests__/ticketing-ui/discovery-render.test.ts`,
`__tests__/ticketing-ui/ui-wiring.test.ts` (§H4 "the QR is server-supplied and never assembled in
the UI"; §H5 "check-in is a back-office tool"),
`__tests__/ui-consolidation/checkin-gate.test.ts` (§P13-11/§P13-12),
`__tests__/ticketing-checkin/*` (the gate and D-28).

## M. Security gaps

| # | Finding | Severity |
| --- | --- | --- |
| M1 | **No secret leak.** `qrToken`/`qrTokenHash` are written once (hashed) and never read back into any payload, log, audit or render. | none |
| M2 | **The ticket's `admission` verdict ignores the event clock.** `describeAdmission(status)` is a function of the ticket status alone, so an `ISSUED` ticket for an event that has been **cancelled, archived or completed past its grace window** still renders a live QR with "Tunjukkan QR ini di pintu masuk" — while the Phase 15 gate would refuse it with `EVENT_NOT_OPEN`. Not a leak; a **false affordance** the buyer can rely on and be turned away at the door. | medium (product honesty) |
| M3 | Buyer ticket files are statically asserted to contain no `<input>`, `<form>`, `onClick`, `fetch(`, or check-in endpoint call. | none — a guard to preserve |
| M4 | The check-in endpoint has no rate limiting. It is session-, permission- and assignment-gated, and §20 forbids inventing a second limiter; recorded, not changed. | low, pre-existing |
| M5 | No ticket-view audit rows (correct: viewing must not be noisy) and no QR-render auditing. | none |

## N. UX gaps

| # | Finding |
| --- | --- |
| N1 | **No print path.** A buyer cannot hand a printed ticket to a phone-less gate; only Ctrl+P exists and the page prints with the site chrome and the action row. |
| N2 | **Venue is name-only.** `TICKET_WALLET_SELECT` selects `venue.name`; `Venue` carries `city` and `address`, and `formatVenue(name, city)` already supports a city — the buyer is not told where to go. |
| N3 | A COMPLETED/CANCELLED event's ticket says nothing about the event being over (same root cause as M2). |
| N4 | Mobile QR size (220 px + 32 px quiet zone) fits a 320 px viewport, the code is printed beneath the QR, and the code is not colour-dependent — no change needed. |
| N5 | The gate input already meets the keyboard-wedge contract; only `enterKeyHint` is missing for mobile keyboards. |

## O. Contract gaps

| # | Finding |
| --- | --- |
| O1 | `buildTicketQrPayload` **already** implements the locked `TICKET:<ticketCode>` contract, but there is no test file that states the QR contract checklist on its own (exact format, determinism, no PII, no token, no URL, unusual-but-valid code). Those properties are currently covered only incidentally inside the issuance suite. |
| O2 | No buyer-facing route or component may add an interactive control (M3), so any print affordance must not be an `onClick`/`<form>` in those files. |
| O3 | `TicketQr` already supplies a quiet zone (`p-4`), contrast (`bg-white` on a fixed white surface), an `aria-hidden` image with the code printed as text, and a stable `level="M"`; nothing in the locked contract requires a change. |
| O4 | **Design-only, out of scope:** `QR_SCAN` as a method, short-lived display tokens, per-view QR tokens, a camera scanner, PDF generation, `ticket.reissue`/`ticket.void`, and a staff/support ticket-read override. Phase 14 closed D-46 by **ratifying** the current mechanism, so none of these are Phase 16 work. |

---

## Audit conclusion — what Phase 16 will and will not do

**Already correct and therefore unchanged:** the wallet, the ticket detail, the QR payload
contract, `TicketQr`, ownership/scoping, the whole check-in flow, the D-28 gate, the dependency
set, and the database schema.

**To implement (all supported by the existing contract, no new product decision):**

1. **M2/N3 →** make the ticket's `admission` verdict event-aware by reusing the ONE canonical
   predicate `isEventCheckInOpen(event, now)` from Phase 15 (never a second definition), so a
   cancelled/archived/completed ticket stops claiming to be usable at the door while remaining
   fully accessible in the wallet.
2. **N2 →** surface `venue.city` + `venue.address` (public venue facts already in the schema,
   already supported by `formatVenue`) in the ticket payload and the e-ticket.
3. **N1/O2 →** make the e-ticket print correctly with Tailwind `print:` utilities and an honest
   instruction line — no button, no `onClick`, no `<form>`, no PDF dependency.
4. **N5 →** add `enterKeyHint="go"` to the gate input (no other scanner change).
5. **O1 →** add the QR-contract test file the brief requires, plus wallet/e-ticket presentation
   and real-database suites for the new event-aware behaviour.

**Explicitly not done:** no new dependency, no camera scanner, no PDF engine, no public ticket
API, no schema change, no migration, no new permission key, no change to `QR_SCAN` or to the
`TICKET:<ticketCode>` payload, and no change to the check-in service.
