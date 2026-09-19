# PHASE 16 — TICKET WALLET + QR PRESENTATION + SCANNER HARDENING

**Project:** TinggalKlik.Co
**Mode:** Audit first, then implement only what the existing contract supports
**Date:** 2026-09-19
**Companion document:** `PHASE_16_TICKET_WALLET_QR_AUDIT_REPORT.md` (the pre-implementation audit)

Labels used throughout: **IMPLEMENTED** (written in this phase) · **VERIFIED** (executed and
observed) · **PRE-EXISTING** (already in the tree before this phase) · **DEFERRED** (not done,
with a reason).

---

## 1. Executive summary

Phase 16 was a hardening phase, and the audit said so before a line was written: the ticket
wallet, the e-ticket, the QR payload, the ownership model and the check-in flow were **already
built** (Phases 8, 9, 13, 15) and already matched the Phase 14 §12 locked contract —
`TICKET:<ticketCode>`, `QR_SCAN` unused, raw token server-only.

So Phase 16 did **not** rebuild them. It closed the three real gaps the audit found, all of which
are consequences of Phase 15 making `ONGOING`/`COMPLETED` real:

1. **The QR verdict ignored the event clock.** `admission.scannable` was a function of the
   *ticket's* status alone, so an `ISSUED` ticket for a cancelled, archived or
   completed-and-past-grace event still said "Tunjukkan QR ini di pintu masuk" — while
   `checkInTicket` would refuse it with `EVENT_NOT_OPEN`. The verdict is now event-aware, using
   the **one canonical predicate** (`isEventCheckInOpen`) rather than a second opinion.
2. **The ticket said nothing about where to go.** `venue.name` was all the payload carried;
   `Venue.city` and `Venue.address` exist in the schema and `formatVenue` already accepted a
   city. Both are now surfaced (name, city, address) — public venue facts only.
3. **A ticket could not be printed usefully.** No print path existed at all. The e-ticket now
   carries `print:` utilities and the shared shell hides its chrome on paper, so Ctrl/Cmd + P
   produces a ticket sheet (QR + code + venue + manual fallback line) with no PDF engine and no
   new dependency.

| Area | Status |
| --- | --- |
| Security audit: `qrToken` / `qrTokenHash` leakage | **No leak found** — nothing to fix (VERIFIED, repo-wide) |
| QR payload contract `TICKET:<ticketCode>` | PRE-EXISTING (already the locked contract) · now asserted standalone |
| QR rendering (`qrcode.react`, SVG, quiet zone, contrast, text fallback) | PRE-EXISTING · re-verified by render |
| Event-aware admission (closing the false affordance) | IMPLEMENTED · VERIFIED |
| Ticket wallet list | PRE-EXISTING; improved only where real (venue city) |
| Ticket detail / e-ticket | PRE-EXISTING; extended (venue, print, blocked copy) |
| Scanner (manual / keyboard wedge) | PRE-EXISTING and complete; one mobile affordance added |
| Camera scanner / PDF engine / public ticket API / schema change | **Not done — and correctly so** (see §14, §24) |

---

## 2. Audit before implementation — VERIFIED

The full audit is `PHASE_16_TICKET_WALLET_QR_AUDIT_REPORT.md`, written and committed to the
working tree **before** any source file was touched. Items A–O were each classified
IMPLEMENTED / PARTIAL / DESIGN ONLY / MISSING / CONTRADICTORY. Its conclusion named exactly the
three gaps implemented above and explicitly listed what must not be built.

The audit's headline findings, unchanged:

* **(A–H, K–L) IMPLEMENTED** — ticket lifecycle, issuance, ticket API, wallet, ticket detail,
  QR/token handling, check-in flow, authorization, tests.
* **(H) PARTIAL by design** — no camera/scanner library exists; the keyboard wedge is the scanner
  Phase 14 permits.
* **(I) MISSING** — print/PDF.
* **(J) no dependency change required** — `qrcode.react@^4.2.0` already installed.
* **(M2/N3) the false affordance** — the one security-adjacent gap (not a leak: a lie).
* **(O4) DESIGN ONLY and out of scope** — `QR_SCAN` as a method, short-lived display tokens,
  camera scanning, PDF generation, `ticket.reissue`/`ticket.void`, a staff read override.

---

## 3. Existing ticket architecture — PRE-EXISTING (unchanged)

`Ticket` (`prisma/schema.prisma`): `ticketCode` unique public code, `qrTokenHash` unique
SHA-256 of the scanner secret, `qrVersion`, `status`
(`RESERVED | ISSUED | CHECKED_IN | VOID | REFUNDED`), `checkedInAt`, `holderUserId`,
`eventId`, `orderId`, `sequenceNo`. No schema change was needed for this phase.

Read chain: `app/api/ticketing/tickets[/\u007BticketCode\u007D]` → `lib/ticketing/tickets/service.ts`
(`listOwnTickets`, `getOwnTicket`) → `lib/ticketing/tickets/payload.ts` (one projection for both
surfaces) → `lib/ticketing/tickets/reference.ts` (codes, tokens, QR payload).

## 4. Existing QR / token architecture — PRE-EXISTING, and now re-verified

`TICKET_QR_PREFIX = "TICKET:"`; `buildTicketQrPayload(code)` → `TICKET:${code}` (throws on
anything that is not a well-formed code); `assertQrPayloadIsSafe`; `hashQrToken` (SHA-256, the
only persisted form); `generateQrToken` (32 random bytes, discarded at issuance).

| Credential | Where it lives | Where it must never appear | Actual state |
| --- | --- | --- | --- |
| `ticketCode` | wallet list, e-ticket, QR payload, **manual check-in** | — | public by design |
| `qrToken` (raw) | nowhere: minted, hashed, discarded | any response, log, audit, render | **absent everywhere (VERIFIED)** |
| `qrTokenHash` | `Ticket.qrTokenHash` (write-only) | any select, payload, log, audit | **absent everywhere (VERIFIED)** |
| `qrVersion` | payload (read-only counter) | — | server-side metadata |

`CheckInMethod.QR_SCAN` is **still unused**; the gate records `MANUAL`, exactly as Phase 14
requires. No raw token is returned, serialised, logged, audited or rendered — see §12.

---

## 5. Ticket wallet — PRE-EXISTING, one honest improvement — VERIFIED

`/ticketing/tickets` (`app/ticketing/tickets/page.tsx`, design §26.5) with the three views
`?view=upcoming|all|past` resolved by `lib/ticketing/ui/wallet.ts`. Ownership is applied as a
**predicate inside the query** (`holderUserId = session.user.id`) plus `ticket.read.own`; the page
cannot widen it, and `past` is a presentation slice of the already-authorised list.

**IMPROVED:** the card previously read `venueName ?? "Lokasi menyusul"`. It now goes through the
shared `formatVenue(name, city)`, so a buyer sees "GOR Tridharma, Bandung" when the venue has a
city and still sees the honest placeholder when it has neither.

**Not changed, deliberately:** no QR in the list (design §26.5), no buyer-side action, no event
banner (the payload does not carry one and the security assertion on the detail response forbids
adding a URL), and no new status vocabulary.

## 6. Ticket detail — PRE-EXISTING, extended — VERIFIED

`/ticketing/tickets/[ticketCode]` (`app/ticketing/tickets/[ticketCode]/page.tsx`): event header,
venue, ticket type, status badge, QR **or** a blocked explanation, the code in large mono type,
order reference, issue time and check-in time when set. `force-dynamic`, `robots: noindex`, and a
foreign or malformed code renders as `notFound()` — the same answer as a code that never existed.

**EXTENDED (IMPLEMENTED):**

* venue now shows **name, city and street address** (`venueCity`, `venueAddress`);
* `BLOCKED_REASONS` gained `EVENT_NOT_OPEN` with copy that names every way an event stops
  admitting without pretending to know which one applies;
* print behaviour (§8 below);
* a print-only line telling the reader they can speak or type the code if the QR will not scan.

**Unchanged:** no buyer check-in control, no fake validation, no fake check-in state, and the
privacy warning stays on screen.

## 7. QR payload contract — PRE-EXISTING, now pinned standalone — VERIFIED

The contract is the Phase 14 locked one and was not modified in any way:

```
payload = "TICKET:" + ticketCode        // e.g. TICKET:EVT-2345-6789
```

Deterministic (a pure function of the code), stable for the life of the ticket, contains no PII,
no money, no order number, no URL, no session/JWT, no database id, no `qrToken`/`qrTokenHash`,
and no random per-render component. A payload built from a lowercase or malformed code **throws**
rather than silently normalising — a normalised payload would encode a code the database does not
have.

New test file `__tests__/ticketing-issuance/qr-payload-contract.test.ts` (17 tests) states the
contract on its own: exact format, determinism over 50 reads, the full forbidden-character matrix,
the token/hash rejection, the `assertQrPayloadIsSafe` accept/reject table, and nine malformed
inputs.

## 8. QR rendering — PRE-EXISTING, re-verified; PRINT IMPLEMENTED — VERIFIED

* **Rendering (PRE-EXISTING):** `components/tickets/TicketQr.tsx` uses the already-installed
  `qrcode.react` (`QRCodeSVG`), renders an SVG at 220 px inside a `bg-white` surface with `p-4`
  (quiet zone) and `aria-hidden` on the wrapper. The payload arrives as a prop from a server
  component; the component cannot compute one, read a session or reach the API.
  Re-verified by rendering: SVG present, the code's plaintext is **not** in the markup (the value
  exists only as modules), and two renders of the same payload are byte-identical.
* **Print (IMPLEMENTED):** there is intentionally **no print button** — an `onClick`/`<form>` in
  the buyer files would collide with the Phase 13 guard that keeps buyer surfaces free of any
  control resembling check-in. Printing is the browser's own (Ctrl/Cmd + P) plus Tailwind v4
  `print:` utilities: `SiteShell` hides the header and footer on paper, the e-ticket drops the
  back link, the action row, the card chrome and the privacy note, and keeps the QR, the code,
  the venue and the manual-fallback line. No PDF engine, no new dependency, no schema change.

## 9. Scanner / manual input — PRE-EXISTING, one affordance added — VERIFIED

`components/organizer/CheckInPanel.tsx` is a keyboard-wedge surface and already had the full
contract: `autoFocus` on mount, `inputRef.current?.focus()` in the `finally` of every submit (so
the next wedge scan lands in the field), `autoComplete="off"`, `spellCheck={false}`, a large mono
input, Enter-to-submit via the form, a `disabled` busy state, and the code cleared **only on
success** so a refusal stays readable.

**Added (IMPLEMENTED):** `enterKeyHint="go"` so a mobile keyboard shows a go key on the field that
ends in a submit. Nothing else changed: the request body is still exactly
`{ code, gateLabel }`, the endpoint is still the organizer check-in route, and the backend still
records `MANUAL`.

**Not added (correctly):** any camera/scanner library. The audit found none installed, Phase 14
permits the manual/wedge path, and §11 forbids adding a scanner merely because the phase title
mentions one.

## 10. Check-in compatibility — PRE-EXISTING, unchanged — VERIFIED

`POST /api/organizer/events/[id]/check-in` → `checkInTicket`: event gate (`isEventCheckInOpen`) →
`checkin.scan` + `StaffEventAssignment` → ticket lookup → event match → **open-refund guard
(D-28)** → `SELECT … FOR UPDATE` → CAS `ISSUED → CHECKED_IN` → `CheckIn` row, with an append-only
refusal row + `checkin.rejected` audit on every rejection. **No line of it was modified.**
The wallet is a *presentation* of the same truth: if the QR is withheld, the gate would have
refused it — the two now agree because they read the same predicate.

| Gate state | Wallet/QR behaviour |
| --- | --- |
| `OPEN` (live, within window) | QR shown, "show this at the door" |
| `GRACE` (`endAt` → `endAt + 30m`) | QR still shown (inclusive boundary), gate labelled on the dashboard |
| `CLOSED` (cancelled, archived, past grace) | QR withheld, `EVENT_NOT_OPEN` explanation |
| `CHECKED_IN` | QR withheld, `ALREADY_CHECKED_IN` |
| `REFUNDED` | QR withheld, `TICKET_REFUNDED` (outranks the event state) |
| `VOID` | QR withheld, `TICKET_VOID` (still no writer) |
| `RESERVED` | QR withheld, `NOT_PAID` |
| wrong event / unknown code | uniform refusal, unchanged |

## 11. Authorization — PRE-EXISTING, unchanged — VERIFIED

Buyer reads require a session + `ticket.read.own` + a `holderUserId` predicate **inside the
query**; a foreign ticket and a non-existent ticket are both `404` (no existence oracle), asserted
against the real database. The gate keeps `checkin.scan` + assignment + tenant scope; `PIC` and
`FINANCE` still hold no gate permission. **No permission key was added** (`ticket.view.any` /
`ticket.qr.view.any` remain absent), and no public ticket API exists.

## 12. Security audit — VERIFIED (no leak found)

Repo-wide search for `qrToken`, `qrTokenHash`, `qrVersion`, `CheckInMethod.QR_SCAN`, `TICKET:`,
`QRCode`, `QR`:

| Question | Result |
| --- | --- |
| Any API returning `qrToken`/`qrTokenHash`? | **No** — the payload selects `qrVersion` only |
| Any log, audit row or error carrying either? | **No** — only prose comments mention them |
| Any client component importing a secret-bearing select? | **No** — `payload.ts` is server-only and every UI import of it is `import type` |
| Any raw token rendered into the QR or a URL? | **No** — the payload is `TICKET:<ticketCode>` |
| Any camera scanner that could re-introduce a token path? | **No scanner installed** |
| Mutation on view / render / print? | **None** — both read paths are SELECT-only |

**Gap found and fixed (the only one):** the *false affordance* described in §1 — not a leak, but a
statement the product could not honour. Fixed by wiring the canonical predicate; regression
covered by the pure and real-database suites.

No `qrToken` is logged, audited, serialised or rendered anywhere in the tree.

---

## 13. API changes — none required — VERIFIED

* **No new route.** `GET /api/ticketing/tickets` and `GET /api/ticketing/tickets/[ticketCode]`
  are unchanged in shape and remain ownership-gated. `qr.payload` and `admission` are still the
  only QR-related fields, and the list still carries **no** `qr` at all.
* **Widened payload (additive, non-secret):** `event.venueCity`, `event.venueAddress`, and the
  event columns the verdict reads (`status`, `archivedAt`, `cancelledAt`) are now selected.
  The response gained `event.venueCity` / `event.venueAddress`; nothing was removed or renamed.
* **Signature:** `getOwnTicket(code, actor, now = new Date())` — an injectable clock, the same
  pattern as `isEventCheckInOpen` / `advanceEventLifecycleBatch` / `expireDueReservations`, so a
  test can assert the grace boundary exactly instead of racing it. Production callers omit it.

## 14. UI changes — IMPLEMENTED — VERIFIED

| File | Change |
| --- | --- |
| `lib/ticketing/tickets/payload.ts` | event-aware `admission` via `isEventCheckInOpen`; venue `city`/`address` in the projection; `buildTicketDetail(row, now)` |
| `lib/ticketing/tickets/service.ts` | `getOwnTicket(..., now)` | 
| `app/ticketing/tickets/[ticketCode]/page.tsx` | venue name+city+address; `EVENT_NOT_OPEN` copy; print utilities; print-only fallback line; honest browser-print instruction |
| `components/ticketing/SiteShell.tsx` | header/footer hidden on paper |
| `components/ticketing/TicketCard.tsx` | venue city through `formatVenue` |
| `components/organizer/CheckInPanel.tsx` | `enterKeyHint="go"` |

No cosmetic churn, no restructuring, and no buyer-facing control was added.

## 15. Dependency changes — none — VERIFIED

`package.json` unchanged. QR rendering keeps `qrcode.react@^4.2.0` (already installed). Nothing was
added: no scanner (`zxing`, `jsqr`, `html5-qrcode`, `instascan`, `quagga`, `react-qr-reader`), no
PDF engine (`jspdf`, `pdfkit`, `pdf-lib`, `puppeteer`, `react-to-print`). The test suite asserts
each of those absences explicitly.

## 16. Database / migration — none required — VERIFIED

**No schema change and no migration.** Every field this phase needed already existed
(`Venue.city`, `Venue.address`, `Event.status/endAt/archivedAt/cancelledAt`,
`Ticket.qrVersion`). `prisma validate` passes; `prisma migrate status` reports the schema up to
date against the 21 migrations applied by Phase 15. The pre-existing drift (30 orphaned legacy
retail tables + `refund_backup_phase10b`) was **not touched**, per §27.

## 17. Tests — IMPLEMENTED · VERIFIED

| Suite | Tests | Kind |
| --- | --- | --- |
| `__tests__/ticketing-issuance/qr-payload-contract.test.ts` (new) | 17 | pure: exact format, determinism, no PII/URL/token, malformed input |
| `__tests__/ticketing-issuance/wallet-qr.integration.test.ts` (new) | 12 | **real MariaDB**: event-aware admission, exact grace boundary, cancelled/archived/completed, status precedence, venue facts, multi-ticket addressability, cross-user 404, no secret |
| `__tests__/ticketing-ui/wallet-qr-presentation.test.ts` (new) | 23 | render + static: QR markup, quiet zone, print classes, blocked copy, venue render, no buyer control, scanner wiring, dependency absence |
| `__tests__/ticketing-ui/discovery-render.test.ts` (extended) | 23 | fixture updated for the two new payload fields |
| `__tests__/ticketing-ui/wallet-views.test.ts` (extended) | 8 | fixture updated for the two new payload fields |

Every item of the brief's §22 list is covered: (A–D) QR format/determinism/no-PII/no-token →
`qr-payload-contract`; (E–G, L, M) ownership, cross-user, refunded/checked-in presentation,
multi-ticket orders → the real-DB suite; (J–K) the API never returns `qrToken`/`qrTokenHash` →
real-DB assertions plus the repo-wide search; (N) ticketCode fallback → the payload contract and
the gate panel wiring; (O–P) CheckInPanel wiring and QR/manual compatibility →
`wallet-qr-presentation`; (Q) no duplicate QR implementation → the same suite; (R–T) existing
check-in, refund and issuance suites all still green.

No existing test was deleted, weakened, or replaced with a mock. The two fixtures edited gained
the fields the payload now returns — no assertion was relaxed.

## 18. TypeScript — VERIFIED

`npx tsc --noEmit` → **clean** (exit 0, no output).

## 19. Build — VERIFIED

`npm run build` → `✓ Compiled successfully`. The four ticket routes are present in the manifest
(`/ticketing/tickets`, `/ticketing/tickets/[ticketCode]`, `/api/ticketing/tickets`,
`/api/ticketing/tickets/[ticketCode]`).

## 20. ESLint — VERIFIED

`npx eslint .` → **0 errors, 5 warnings**, all five the pre-existing
`@next/next/no-img-element` notices (unchanged baseline: Phase 13/15 reported the same five).
No suppression was added.

## 21. Runtime verification — VERIFIED

Production build served on a spare port, anonymous surfaces exercised over HTTP:

| # | Check | Result |
| --- | --- | --- |
| 1 | `GET /ticketing/tickets`, anonymous | **302** → `/login?callbackUrl=%2Fticketing%2Ftickets` |
| 2 | `GET /ticketing/tickets/EVT-2345-6789`, anonymous | **302** → `/login?callbackUrl=…%2FEvT-2345-6789` (encoded) |
| 3 | `GET /api/ticketing/tickets`, anonymous | **401** `{"success":false,"message":"Silakan login terlebih dahulu."}` |
| 4 | `GET /api/ticketing/tickets/EVT-2345-6789`, anonymous | **401** (same body — no oracle) |
| 5 | `GET /api/events` | **200**, public catalog unaffected |
| 6 | QR pipeline (real code) | payload `TICKET:EVT-7K3M-9ABC`; SVG rendered (1 790 bytes); the code's plaintext is **not** in the markup |
| 7 | authenticated wallet / detail / cross-user detail / checked-in / refunded / completed-event tickets | executed against the real database by the Phase 16 integration suite (12 tests) and the Phase 8/13 suites — a browser session is not obtainable from the shell, so these were verified through the production services rather than over HTTP |

The authenticated row is the honest boundary of this verification: the HTTP surfaces that need a
session were exercised through the real services against real MariaDB rows, not by forging a
session cookie.

## 22. Regression audit (the brief's §26 list) — VERIFIED

| # | Claim | Evidence |
| --- | --- | --- |
| 1 | No raw `qrToken` leak | repo-wide search + real-DB serialisation assertions |
| 2 | No `qrTokenHash` leak | same; the stored hash is asserted **absent** from the payload |
| 3 | QR payload is exactly `TICKET:<ticketCode>` | `qr-payload-contract` + real-DB `detail.qr.payload` |
| 4 | QR carries no PII | 15-character forbidden matrix + malformed-input matrix |
| 5 | A buyer cannot see another buyer's ticket | real-DB 404 for a stranger, on both surfaces |
| 6 | A buyer cannot see a ticket by guessing a URL | malformed/hostile codes → `NOT_FOUND`; anonymous → 302/401 |
| 7 | A refunded ticket cannot be checked in | Phase 13/15 suites (unchanged) |
| 8 | A checked-in ticket cannot be refunded | Phase 10B/13 suites (unchanged) |
| 9 | An open refund blocks check-in | D-28 suite (unchanged) |
| 10 | A completed event's ticket remains accessible | new real-DB assertion: the QR is withheld, the ticket is still readable |
| 11 | Completion does not auto-refund | Phase 15 suite (unchanged); no refund code path in the wallet |
| 12 | The wallet does not mutate ticket state | read-only SELECTs; asserted snapshots |
| 13 | Rendering the QR does not mutate state | the renderer takes a string prop; no service import |
| 14 | Printing does not mutate state | print is CSS-only; no handler, no fetch |
| 15 | QR presentation has no payment/refund side effects | no payment/refund import in any wallet file |
| 16 | Check-in remains the only admission mutation | Phase 8 guard (no `prisma.checkIn.*` in ticket files) still green |
| 17 | Phase 15 lifecycle unchanged | `__tests__/events/*` and `__tests__/jobs/*` green |
| 18 | Phase 10B refund lifecycle unchanged | `__tests__/ticketing-refunds/*` green |
| 19 | No new permission keys | `permission-map` suite green; no key added |
| 20 | No new scheduler | `__tests__/jobs/*` green; no job added |

## 23. Failures and root causes

**New regressions: none.** Final full run: **61 suites / 1 333 tests passed** (Phase 15 baseline:
58 / 1 281).

Three failures were hit while developing the new integration suite, all in the fixture, none in
production code, and each was investigated to its root cause:

1. **`SALES_NOT_OPEN` / `Event tidak ditemukan`** — the suite bought tickets *after* moving the
   event's dates into the past, so the real sales window correctly refused. **TEST HARNESS
   FAILURE.** Fixed by buying while the event is legitimately on sale (as a real buyer would) and
   arranging the time state afterwards.
2. **`expected SETTLED, got DUPLICATE`** — the payment ledger keys on `providerEventId`, and the
   harness's synthetic `TRX-P8-settle-N` counter restarts every process. My suite's first
   teardown did not delete its own `WebhookEvent` rows, so an earlier failing run's rows collided
   with the next run's first settlement (the ledger's `orderId` is `SetNull`, so rows survive an
   order delete). **TEST HARNESS FAILURE**, with a **PRE-EXISTING fragility** behind it: any suite
   using the harness must delete its own ledger rows (the Phase 7/8 suites do). Fixed by deleting
   webhooks *before* the orders, and the 12 orphaned rows my earlier runs left were removed with a
   targeted delete of `providerEventId LIKE '%TRX-P8-%'` rows (synthetic test ids only).
3. **Two fixture type errors** after the payload gained `venueCity`/`venueAddress`.
   **TEST HARNESS FAILURE.** Fixed by extending the fixtures; no assertion was changed.

**Environment failures: none. Pre-existing application failures: none.**

## 24. Deferred items

* **DEFERRED by the locked contract (Phase 14 ratified D-46):** `QR_SCAN` as a method,
  short-lived/rotating display tokens, per-view QR tokens, a QR that encodes anything other than
  `TICKET:<ticketCode>`, a camera scanner, and PDF generation. All are recorded in the audit
  report as DESIGN ONLY.
* **DEFERRED (no writer exists):** `ticket.reissue` / `ticket.void`; `Ticket.voidedAt` does not
  exist and `VOID` has no transition. The wallet renders `VOID` honestly if a row ever is in it.
* **DEFERRED (needs a product decision, not this phase):** staff/support ticket read
  (design §26.6's "audited override") — it would be a new permission key.
* **OBSERVED, NOT CHANGED (pre-existing, out of scope):** the check-in endpoint has no rate
  limiting (it is session-, permission- and assignment-gated); and the database still carries 30
  orphaned legacy retail tables plus `refund_backup_phase10b`, which §27 explicitly forbids
  dropping here.
* **OBSERVED (pre-existing, documented in `proxy.ts`):** the anonymous redirect uses the
  configured `AUTH_URL` origin (`http://localhost:3000`) rather than the request origin.

## 25. Final verdict

**PHASE 16 COMPLETE.**

The wallet, the e-ticket and the QR are the same mechanisms Phase 8/9/13 built — **no competing
implementation was created**, no duplicate QR path exists, the payload is still
`TICKET:<ticketCode>`, and the raw token is still server-only. Phase 16 closed the three genuine
gaps the audit found, each of them a consequence of Phase 15's real lifecycle: the QR verdict now
reflects the event clock (through the one canonical predicate, not a second one), the ticket says
where to go, and it prints as a ticket. Scanner hardening was verification plus one mobile
affordance, because the wedge path was already complete.

The verdict is not based on compilation: **61 suites / 1 333 tests** pass against the real
MariaDB, TypeScript is clean, Prisma validates with the schema up to date, the production build
succeeds, ESLint is at its pre-existing baseline of 0 errors, and the anonymous HTTP surfaces were
smoke-tested on a live server.

No dependency, no schema change, no migration, no new permission key, no new scheduler, and no
destructive database action. No commit, no push, no reset; the pre-existing uncommitted tree was
preserved.

---

### Final response summary

* **Files changed:** 6 source/UI files (`payload.ts`, `service.ts`, the e-ticket page,
  `SiteShell.tsx`, `TicketCard.tsx`, `CheckInPanel.tsx`), 2 test fixtures extended
  (`discovery-render`, `wallet-views`), 3 new test suites, 2 reports. **No API route, no
  component contract, and no schema file changed.**
* **Migration needed:** **No.** Additive schema change unnecessary; nothing was created.
* **QR security result:** no leak found; payload exactly `TICKET:<ticketCode>`; no PII, URL or
  token; 17 pure + real-DB assertions pin it.
* **Wallet result:** unchanged mechanism, improved venue line; ownership still a query predicate.
* **Ticket detail result:** now event-aware (withheld QR past the gate's window), shows venue
  city/address, prints correctly, and still offers the buyer no control.
* **Scanner / check-in result:** backend flow untouched; wedge affordances verified and locked by
  tests; `enterKeyHint` added; no scanner library introduced.
* **Authorization result:** unchanged — session + `ticket.read.own` + `holderUserId`, 404 for
  foreign tickets, no new permission key.
* **Tests:** 61 suites / 1 333 tests passing (+52 tests, +3 suites over Phase 15).
* **TypeScript:** clean. **Build:** successful. **ESLint:** 0 errors / 5 pre-existing warnings.
* **Runtime:** anonymous wallet/detail redirect to login, anonymous APIs 401, public catalog 200,
  QR pipeline renders without leaking the code.
* **Failures:** none new (three test-harness issues found and fixed; root causes in §23).
* **Deferred:** design-only D-46 alternatives, camera scanner, PDF, reissue/void, staff read
  override.
* **Final verdict:** **`PHASE 16 COMPLETE`**

### git status (evidence)

```
$ git status --short | wc -l
485
```

The tree is **not** clean and was not cleaned: it carried the Phase 1–15 uncommitted working set
(474 entries at the end of Phase 15) before this phase started, and Phase 16 added its own — the
six edited source/UI files, the two extended test fixtures, the three new test suites, and the two
reports (this one and the audit). Nothing else was touched, and no commit or push was made.
