# PHASE 3B — QR VALIDATION & `CheckInMethod` DESIGN CONTRACT

**Status:** design, written before implementation (Phase 3B).
**Baseline:** `main` @ `9b8fecd99bcc74677c1805c18379241af04fddd1` (Phase 3A committed).
**Scope:** pure QR payload validation + a `CheckInMethod` labelling contract. **No** check-in
transaction, API route, UI, audit write, rate limit, attribution column or migration.

---

## 1. Source-backed audit mapping

Every row below was read from the repository during Checkpoint 1; nothing here is assumed.

| Concern | Existing implementation (file:symbol) | Authoritative rule | Phase 3B action |
|---|---|---|---|
| QR payload format | `lib/ticketing/tickets/reference.ts:137` `TICKET_QR_PREFIX = "TICKET:"`; `:157` `buildTicketQrPayload(code)` → `TICKET:<code>` | `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md:677` `P14-D17`, `:397`, `:820` — **LOCKED**, exactly `TICKET:<ticketCode>`, no PII/URL/secret | **Reuse, do not change.** Parse the existing payload. |
| Is the QR a ticket id / token / URL? | Not a URL, not the secret: it is the **public lookup code**. `reference.ts:29-73` explains the two identifiers; `PHASE_3A_AUTHORIZATION_CONTRACT.md:245` states the credential | Owner decision **B-2** + `P14-D17`: the public code is the admission lookup credential and proves *existence*, not authenticity | Document as a limitation; never label it authenticity. |
| Where generated | `reference.ts:157-167` (`buildTicketQrPayload`), consumed by `lib/ticketing/tickets/payload.ts:206` (`buildTicketDetail` → `qr.payload`) | `P14-D17`; design §26.6 rejects returning a token to the browser | Pure parse only; builder untouched. |
| Where validated today | `lib/ticketing/checkin/service.ts:224-234` `normalizeCode(raw)` → trim, strip optional `TICKET:` (case-insensitive), upper-case, `isTicketCode`; consumed at `:378` | `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:158`; malformed ≡ unknown (`:42`, design §20.2 check 1) | New parser must **agree** with this normalisation (same trim/prefix/case rules) so wiring it later is behaviour-preserving. |
| Ticket identity | `Ticket.ticketCode` — `reference.ts:70-101` `generateTicketCode`, `TICKET_CODE_PATTERN` | `prisma/schema.prisma` `Ticket.ticketCode @unique`; design §19.1 | Validate the code shape only; no lookup. |
| Event relationship | `CheckInTicketRow.eventId` compared to `gate.id` — `service.ts`, `WRONG_EVENT` | Phase 13 / `P14-D16`; not a QR concern | **Not here.** Requires a row; documented as a separate check. |
| Status eligibility | `TicketStatus` enum (`RESERVED/ISSUED/CHECKED_IN/VOID/REFUNDED`); only `ISSUED` is admissible — `payload.ts` `describeStatusAdmission`, `service.ts` CAS `status:"ISSUED"` | Design §19.4 ("only `ISSUED` validates"); Phase 13 CAS | **Not here.** No state is read or written. |
| `CheckInMethod` values | `prisma/schema.prisma:528-531` `enum CheckInMethod { QR_SCAN MANUAL }` | Schema = `SOURCE FACT`; `PHASE_14…:64` reproduces it; `PHASE_10_REPORT.md:246` records that design §20.1's `MANUAL_CODE`/`MANUAL_OVERRIDE` were **not** shipped | Represent exactly these two; **no new member**, no migration. |
| Which method is written today | `service.ts:65` `const CHECK_IN_METHOD: CheckInMethod = "MANUAL"`; used for accepted rows and refusals | `P14-D17` (`:677`), lock `:808`/`:825`, audit `PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:959` | Encode the labelling rule as a pure function; **do not** change `service.ts`. |
| `QR_SCAN` semantics | Unwritten everywhere (`PHASE_16_TICKET_WALLET_QR_REPORT.md:95`; audit `:1408`) | `P14-D17`: `QR_SCAN` unused until a **secret** reaches a scanner; 3B stop condition: "a `QR_SCAN` label without a verified secret ⇒ STOP" | `QR_SCAN` resolvable **only** from a `VERIFIED_SCANNER_SECRET` credential, which no caller supplies today. |
| Admission credential | `TICKET:<ticketCode>` (`reference.ts`), accepted by `normalizeCode` | B-2 / `P14-D17` / contract §11 | A public-code scan resolves to `MANUAL` — camera or keyboard alike. |
| Tests | `__tests__/ticketing-issuance/qr-payload-contract.test.ts` (payload shape), `__tests__/ticketing-checkin/check-in-wiring.test.ts:54-69` (`normalizeCode` matrix) | Existing suites | New pure suite; existing suites must stay green. |

### Rules that are **not** documented, and therefore not implemented

- No token/secret field on the check-in request (design §19.3 token path is undecided; the raw
  token has never been delivered to a client — audit §3, `TICKETING_PHASE10_REPORT.md:244`).
- No `MANUAL_CODE` / `MANUAL_OVERRIDE` enum member (design-only; adding one is a migration and a
  separate owner decision).
- No event/status/refund eligibility logic in the parser (needs database state).
- No "QR proves holder identity" claim anywhere.

---

## 2. QR validation contract

Module: `lib/ticketing/checkin/qr-payload.ts` — pure, no I/O, no database, no framework, no clock.

```
parseCheckInQrPayload(raw: unknown): CheckInQrPayloadResult
```

Accepted input grammar (identical to what `normalizeCode` already accepts at the gate):

```
payload     := [ WSP ] namespace? code-text [ WSP ]
namespace   := "TICKET" ":"        (case-insensitive)
code-text   := ticket code, case-insensitive, surrounding WSP ignored
ticket code := /^EVT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/
```

Result is a discriminated union:

| Case | Result |
|---|---|
| valid | `{ valid: true, ticketCode, canonicalPayload: "TICKET:<code>", presentedAs: "TICKET_PREFIX" \| "BARE_CODE" }` |
| not a string (number, object, null, undefined) | `{ valid: false, reason: "NOT_A_STRING" }` |
| empty / whitespace-only | `{ valid: false, reason: "EMPTY_PAYLOAD" }` |
| longer than 120 chars (the request schema's `code` bound) | `{ valid: false, reason: "PAYLOAD_TOO_LONG" }` |
| a different namespace (`http:…`, `EVT-…:x`) | `{ valid: false, reason: "UNSUPPORTED_FORMAT" }` |
| `TICKET:` with nothing valid after it | `{ valid: false, reason: "MISSING_CODE" }` |
| wrong shape / wrong alphabet / extra segments / PII / URL | `{ valid: false, reason: "INVALID_CODE_FORMAT" }` |

Properties:

1. **Side-effect free.** No mutation, no global state, no clock, no randomness; repeated calls on
   the same input return deep-equal results.
2. **No database.** The module imports only `@/lib/ticketing/tickets/reference` (itself pure) — no
   Prisma client, no `@/lib/prisma`, no service import.
3. **Fail-closed.** Any input that is not a well-formed code — including a well-formed *token* or a
   SHA-256 hash — is rejected; nothing is trimmed into validity or repaired.
4. **Canonical output only.** `canonicalPayload` is produced by the existing
   `buildTicketQrPayload`, so a downstream caller cannot construct a payload the wallet would not
   have produced.
5. **`assertQrPayloadIsSafe` is not called on input.** It is an assertion for server-generated
   payloads and throws by design; a parser must *return* a refusal, not throw on user input. The
   same guarantee is obtained structurally: the code is validated before the payload is built.

### What a valid parse proves — and does not

Proves: the presented text is a well-formed `TICKET:<EVT-XXXXXXXX>` reference.
Does **not** prove: that the ticket exists, belongs to this event, is `ISSUED`, is unpaid/refunded/
void, has not been scanned, or that the presenter is its holder. Those are the Phase 3C+ checks
(§4).

---

## 3. `CheckInMethod` contract

Module: `lib/ticketing/checkin/method.ts` — pure.

| Value | Meaning | Persisted today? | Authority |
|---|---|---|---|
| `MANUAL` | Admission resolved from the **public ticket code** — typed, pasted, or decoded from the wallet QR by a camera. The QR is a carrier, not a credential. | **Yes** — the only value written (`service.ts:65`) | `P14-D17`; B-2; lock §11/§24 |
| `QR_SCAN` | Admission where a **scanner secret** was verified against `Ticket.qrTokenHash`. | **No writer** — and none may be added while no token reaches a scanner | `P14-D17`; lock `:808`; audit 3B rule 1 |

```
resolveCheckInMethod(credential): "QR_SCAN" | "MANUAL"
```

- `"VERIFIED_SCANNER_SECRET"` → `QR_SCAN` (**only** exact match).
- every other value, including `null`, `undefined`, an unknown string, a camera-sourced code → `MANUAL`.
- The type `CheckInMethodValue` is an alias of Prisma's generated `CheckInMethod`, and
  `CHECK_IN_METHODS` is a literal tuple whose exhaustiveness is proven at compile time — so a future
  enum change breaks `tsc` instead of drifting silently.

**Why a camera scan is still `MANUAL`:** the wallet QR carries the public `ticketCode`, which anyone
who has seen the code can re-encode. Labelling that `QR_SCAN` would assert a secret was verified and
turn the audit trail into a false statement (audit §3B security requirement 1). Phase 3B therefore
makes the rule executable rather than adding a second opinion.

**Missing/invalid method:** nothing is persisted by this phase. When Phase 3C writes a row it must
use this resolver; `QR_SCAN` is unreachable without a verified secret, so a malformed credential
cannot upgrade the label.

---

## 4. Eligibility is deliberately out of the parser

| Layer | Owner | State needed |
|---|---|---|
| QR/payload structure | **Phase 3B (this)** | none |
| Ticket existence | Phase 3C (`findUnique({ ticketCode })`) | row |
| Ticket ↔ event | Phase 3C (`WRONG_EVENT`) | row |
| Status eligible (`ISSUED` only) | Phase 3C (CAS) | row |
| Already checked in | Phase 3C (`ALREADY_CHECKED_IN`, UNIQUE `CheckIn.ticketId`) | row |
| Open refund (`REFUND_PENDING`) | Phase 3C / 3E | row + refund |
| Authorization (staff or PIC) | Phase 3A decider + Phase 3D wiring | assignment |

A structurally valid QR for a refunded, wrong-event or already-scanned ticket is *valid input* and
must still be refused by the later layers. Phase 3B makes no admission decision.

---

## 5. Scope guard

Not implemented in Phase 3B (see the execution report §13 for the verified list): check-in
transaction, ticket mutation, scanner API/route, session/authz change, scanner UI/camera, audit
write, rate limiting, PIC attribution persistence, DB integration tests, migration, deploy, push.
