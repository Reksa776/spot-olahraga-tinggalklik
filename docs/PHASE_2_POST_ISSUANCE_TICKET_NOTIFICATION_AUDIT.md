# PHASE 2 — POST-ISSUANCE TICKET NOTIFICATION DESIGN AUDIT

**Repository:** `/home/reksa/tinggalklik`
**Branch:** `main`
**Type:** audit and design only — no implementation, no schema change, no migration, no provider activity
**Date:** 2026-11-04

**References read:** `docs/PHASE_2_IMPLEMENTATION_REPORT.md`,
`docs/PHASE_2_PRE_IMPLEMENTATION_AUDIT.md`, `PHASE_1_IMPLEMENTATION_REPORT.md`,
`app/api/ticketing/orders/[orderNumber]/issue/route.ts`, `lib/ticketing/tickets/issuance.ts`,
`lib/ticketing/tickets/reference.ts`, `lib/ticketing/tickets/payload.ts`,
`lib/ticketing/checkin/service.ts`, `prisma/schema.prisma`,
`lib/notifications/{queue,enqueue,worker,templates,purchase-proof}.ts`.

---

## 1. Executive Summary

Owner decision **OPSI B** is viable: keep the purchase proof at settlement, and add a
**separate ticket notification after issuance commits**. It must not change issuance timing,
must not be merged into `purchase-proof.v1`, and must reuse the Phase 1 queue and dry-run
worker.

The issuance path is already suitable for this. `issueTicketsForOrder()` creates all
`SUM(quantity)` ticket rows in one transaction, returns only after the transaction has
resolved, and returns `ALREADY_ISSUED` on every repeat. Its post-commit block
(`issuance.ts:595-640`) is the only correct new seam. A non-throwing enqueue helper can be
called there, with the same recovery-by-idempotency-key pattern Phase 2 already uses.

The important finding is about the **QR image**, not the QR payload:

* `Ticket.ticketCode` is public and the wallet QR payload is exactly
  `TICKET:<ticketCode>` (`reference.ts:18-42`, `:158-165`).
* The current check-in flow does **not** verify the scanner token; it resolves the public
  ticket code as a manual code (`checkin/service.ts:28-43`, `:224-232`, `:389-391`). So the
  code is, in practice, the admission credential today. Sending it to email/WhatsApp
  increases its exposure, even though it is not `qrTokenHash`.
* Email and WhatsApp transports are **plain text only, with no attachment field**
  (`lib/notifications/types.ts:38-50`). A scannable QR image therefore cannot be delivered
  by the current transport contract. The server-side `qrcode` package is installed and could
  render a PNG, but there is no reviewed path to attach or embed it in either channel.

**Recommendation: CONDITIONAL GO.** Implement the ticket-issued notification as a code-first
message (public ticket codes + authenticated wallet link) after owner approval. Do **not**
claim that a scannable QR image is delivered until a separate attachment/transport security
design is approved. If the owner requires a scannable QR image in the message as a condition
of OPSI B, the QR-image portion is **NO-GO** for this increment.

---

## 2. Audit Issuance Flow

### 2.1 Facts (source inspection)

| # | Question | Finding | Evidence |
|---|---|---|---|
| 1 | Source of truth for issuance | `issueTicketsForOrder()`; the committed `Ticket` rows are the issued state, not an `issued` flag. | `lib/ticketing/tickets/issuance.ts:469`; `:549-577` |
| 2 | Where issuance commits | Inside `prisma.$transaction` returned at `:516-580`; the result is consumed at `:595`, after the transaction resolved. | `issuance.ts:516`, `:579`, `:595` |
| 3 | Several tickets in one transaction | Yes. The plan is `SUM(EventOrderItem.quantity)`; each `(orderItemId, sequenceNo)` is one row. | `issuance.ts:530-576`; `schema.prisma:1211` |
| 4 | Can issuance be called again | Yes. Missing sequences are diffed from existing rows; the unique slot is the arbiter. | `issuance.ts:538-576`; `schema.prisma:1211` |
| 5 | How new vs already complete is distinguished | `created.length > 0` → `ISSUED`; otherwise `ALREADY_ISSUED`. | `issuance.ts:648` |
| 6 | Partial issuance | A failed transaction rolls back. A pre-existing partial state is completed by the missing-sequence diff; the count invariant refuses an inconsistent result. | `issuance.ts:423-458`, `:577` |
| 7 | Parallel issuance | `SELECT … FOR UPDATE` on `eventorder` serialises callers; the unique slot constraint is the final arbiter; contention is retried. | `issuance.ts:515-518`, `:577`; `schema.prisma:1211` |
| 8 | Can notification be added after commit | Yes, but only after the transaction resolves, inside the post-commit block; never inside `$transaction`. | `issuance.ts:595`, `:609-640` |

### 2.2 The actual flow

`POST /api/ticketing/orders/[orderNumber]/issue` is protected by `requireSameOrigin` and
`requireAuth`, then calls the service (`issue/route.ts:57-76`). The service:

1. looks up the order **with the buyer ownership predicate in the query**
   (`issuance.ts:483-489`), so another buyer's order is a 404;
2. re-resolves the live permission (`requireOwnResource(TICKET_ISSUE_OWN)`, `:496-500`);
3. validates the persisted lines and computes expected ticket count (`:502-509`);
4. performs a fast eligibility check (`:512`), then re-checks under the lock (`:518-526`);
5. reads existing tickets and creates only missing `(orderItemId, sequenceNo)` slots
   (`:538-576`);
6. reads the complete set back and asserts the count invariant (`:577`);
7. returns `{ created, tickets }` from the transaction (`:579`).

After commit it publishes realtime **only if new rows were created** (`:609-616`) and writes
one audit row (`:618-640`). A duplicate call therefore creates no ticket, no realtime event and
no audit row; it returns `ALREADY_ISSUED`.

### 2.3 Response and duplicate semantics

The route returns **201** when `outcome = ISSUED`, otherwise **200**
(`issue/route.ts:79`). The response includes the created/complete ticket references, including
`ticketCode` (`issuance.ts:106-134`, `:648-653`). There is no idempotency-key table for
issuance; idempotency is structural (`Ticket.@@unique([orderItemId, sequenceNo])`).

### 2.4 Is there an operator issuance path?

No separate operator issuance route was found. `issueTicketsForOrder` is called by the buyer
route and by test harnesses only (`issue/route.ts:73`; test harness at
`__tests__/ticketing-issuance/issuance-harness.ts:294`). Issuance remains buyer-triggered,
matching the locked decision `D-P17-18`.

### 2.5 Conclusion for notification

The transaction boundary is clean. The post-commit block is safe for a queue write because:

* the tickets are committed;
* the helper cannot alter the order or ticket state;
* the helper must not throw into the issuance response;
* a crash between commit and enqueue is recoverable by an idempotent sweep.

**Do not** add the enqueue inside `$transaction`: that would hold the order lock during a
queue write and could make issuance fail on a notification error, contrary to the Phase 2
rule that a side effect must not break the financial/fulfilment operation.

---

## 3. QR and Ticket Security

### 3.1 What the existing mechanism actually has

| Data | Meaning | Safe in a buyer message? |
|---|---|---|
| `ticketCode` (`EVT-XXXX-XXXX`) | Public lookup code printed on the e-ticket and encoded by the wallet QR. | **Yes, with care**; it is not a scanner secret, but it is the code the current gate accepts. |
| QR payload `TICKET:<ticketCode>` | Exact wallet payload; no URL, no PII, no secret. | **Yes as the reference value**, but not a substitute for a scannable image. |
| `qrTokenHash` | SHA-256 hash of the 256-bit scanner token; plaintext is never returned. | **Never**. Do not select, render, or log it. |
| Raw `qrToken` | Generated at issuance and immediately hashed; never stored in plaintext or returned. | **Unavailable**, so no design may depend on it. |
| Internal `Ticket.id` / `EventOrder.id` | Database identifiers. | **Never** in a message. |
| Payment/provider data | Not part of a ticket. | **Never** in a ticket notification. |

Evidence: `prisma/schema.prisma:1168-1175` (`ticketCode`, `qrTokenHash`), `reference.ts:18-42`
(the two identifiers and why the wallet encodes the public code), `:158-165`
(`buildTicketQrPayload`), `payload.ts:145-147` (`walletUrlFor`).

### 3.2 Is `TICKET:<ticketCode>` still the correct payload?

Yes, for the existing wallet and scanner contract. `normalizeCode()` accepts the bare code or
the namespaced payload (`checkin/service.ts:224-232`), and the scanner lookup is
`ticketCode`-based (`:389-391`). No change to that mechanism is proposed.

### 3.3 The critical security fact: today the public code is the admission credential

Despite the design language calling `ticketCode` a public lookup code, the shipped check-in
service explicitly implements **manual code** admission, not token verification:

* the raw scanner token has never been delivered to a client (`checkin/service.ts:30-34`);
* `CHECK_IN_METHOD = "MANUAL"` (`:65`);
* the server resolves `ticketCode` and applies the one-admission CAS (`:389-391`, `:517`).

Therefore anyone who obtains a ticket code can attempt to be admitted first. This is an
existing product/security limitation (D-46), not introduced by Phase 2. Sending the code in a
message **widens the distribution surface**: email forwarding, shared WhatsApp screenshots,
and mailbox/device compromise all become paths to the code.

**Mitigations required for the notification:**

* send only to the buyer's stored email/phone after normalisation; never to a guessed or
  shared address;
* one ticket notification per order (see §4), never a broadcast;
* never log the code, the payload, or the message body;
* do not add a public QR endpoint or make the ticket page unauthenticated;
* include the existing privacy instruction from the wallet UI ("E-tiket ini bersifat pribadi.
  Jangan bagikan tangkapan layarnya…", `app/ticketing/tickets/[ticketCode]/page.tsx:335-339`);
* before production activation, revisit D-46: a scanner token or holder identity check would
  materially reduce the “first person with the code wins” risk.

### 3.4 Can a QR image be generated from existing code?

**Generation:** yes, in principle. The repository already depends on `qrcode@^1.5.4` (server
capable) and `qrcode.react` (wallet renderer), so a PNG/SVG can be produced from
`TICKET:<ticketCode>` without adding a dependency.

**Delivery:** no, not with the current notification contract. `OutboundEmail` is
`{ to, subject, text }` and `OutboundWhatsApp` is `{ to, text }`
(`lib/notifications/types.ts:38-50`). There is no `attachments`, `html`, `image`, or `media`
field, and both live adapters remain fail-closed. Encoding a QR as plain text is not a
scannable QR; an ASCII QR is not reliable in email/WhatsApp typography and must not be
presented as a working QR without a rendering test.

**Conclusion:** actual QR-image delivery requires a separate, reviewed change to the transport
contract plus attachment/media handling and provider-specific tests. That is outside this
design's safe scope and is a blocker if the owner requires a scannable image.

### 3.5 Public endpoint / bearer URL

The wallet URL is relative (`/ticketing/tickets/{code}`, `payload.ts:145-147`) and the route is
authenticated and ownership-scoped (`app/api/ticketing/tickets/[ticketCode]/route.ts:35-50`).
An absolute link must be built with the existing allow-listed origin helper
(`lib/app-origin.ts`), never from an unvalidated host header. No new public route is needed.

A ticket page URL is not a bearer credential, but the `ticketCode` inside it is sensitive
under current admission semantics. Use the link, do not put a scanner token in a URL.

### 3.6 Revocation, invalidation, regeneration

`TicketStatus` includes `VOID` and `REFUNDED` (`schema.prisma:520-526`), and both are refused
by the ticket/wallet admission decision and by the check-in CAS. `qrVersion` exists
(`schema.prisma:1175`) but no reissue/regeneration endpoint or service was found; the
`ticket.reissue` action is explicitly a later phase. **UNKNOWN/not implemented:** rotating a
ticket code after leakage. The notification must not imply that sharing the code is safe or
that the code can be revoked independently.

---

## 4. Recommended Notification Unit

### Recommendation: one order-level notification per channel

Use **one business notification for the order**, materialised as two `Notification` rows by
the existing per-channel enqueue contract (one email, one WhatsApp). The payload carries all
valid ticket codes for that order.

```text
Notification (EMAIL)     eventOrderId = order.id, ticketId = null
Notification (WHATSAPP)  eventOrderId = order.id, ticketId = null
category                  TICKET
templateKey               ticket-issued.v1
recipientType             CUSTOMER
```

Do **not** create one notification per ticket.

Why:

* one issuance call creates all missing tickets and returns only after the count invariant
  passes (`issuance.ts:538-579`); the order is the natural unit;
* per-ticket messages multiply email/WhatsApp volume, hit the conservative WhatsApp cap, and
  turn one retry into N independent retries;
* per-ticket notifications would need N idempotency keys and would produce a partial
  notification set if one channel fails;
* the buyer made one purchase and needs one message with all codes plus the wallet link.

**Limit:** display at most 20 ticket codes (the existing proof template already uses
`MAX_TICKETS = 20`, `purchase-proof-template.ts:46`). If an order somehow has more, include
the first 20 and a factual line pointing to the authenticated wallet/order page for the rest.
This is a presentation cap, not an issuance limit. Owner approval is required for a different
cap.

**Limitation:** if a future phase supports incremental issuance into an existing order, an
order-level key would not cover the new batch. The current issuance flow is all-or-nothing per
call, so this design is correct **only while that remains true**. Revisit the key with a
batch/revision token if incremental issuance is introduced.

---

## 5. Idempotency Recommendation

Use keys that are separate from purchase proof and stable across retries:

```text
ticket-issued:{orderNumber}:email:v1
ticket-issued:{orderNumber}:whatsapp:v1
```

Implementation contract:

* `ticketIssuedIdempotencyKey(orderNumber, channel)` in a new
  `lib/notifications/ticket-issued.ts`;
* `enqueueNotification` with `templateKey = "ticket-issued.v1"`,
  `category = "TICKET"`, `eventOrderId = order.id`, `userId = order.userId`,
  `eventId = order.eventId`, `organizerId = order.organizerId`;
* one key per channel, never one key for both;
* never reuse `purchase-proof:*` keys (`purchase-proof.ts:102-106`);
* the duplicate-key path in `enqueueNotification` reuses the existing notification and repairs
  a missing delivery row (`enqueue.ts:229-280`).

Properties:

| Event | Result |
|---|---|
| First issuance, enqueue succeeds | one email row + one WhatsApp row |
| Duplicate issuance (`ALREADY_ISSUED`) | hook is not entered because `created.length === 0`; no new row |
| Enqueue retried after success | existing rows returned; no duplicate |
| Email fails, WhatsApp succeeds | independent rows; no cross-channel rollback |
| Purchase proof already exists | unaffected; different keys and template |
| Issuance committed, enqueue crashed | sweep creates the missing rows using the same keys |

The unique constraints are the final arbiter:
`Notification.idempotencyKey @unique` (`schema.prisma:205`) and
`@@unique([notificationId, channel])` (`:1742`).

---

## 6. Recommended Post-Commit Integration Point

**File:** `lib/ticketing/tickets/issuance.ts`
**Location:** after the transaction result is available (`:595`), inside the existing
`if (created.length > 0)` block (`:609`), after the realtime/audit writes.

Proposed shape:

```ts
if (created.length > 0) {
    publishTicketIssued({ ... });
    await writeTicketingAudit({ ... });

    try {
        await enqueueTicketIssued(order.id);
    } catch (error) {
        structuredLog("error", "notification.ticket_issued.hook_failed", {
            orderNumber: order.orderNumber,
            error: sanitizeErrorMessage(error),
        });
    }
}
```

Rules:

1. **Never inside `$transaction`.** The transaction must not wait on, or fail because of, a
   queue insert.
2. **Only when `created.length > 0`.** A repeated issuance is a no-op and must not enqueue.
3. **Never throw into the route.** The helper returns a result; the surrounding catch is
   defence in depth. An enqueue failure must not change the 201/200 response or the tickets.
4. **No direct send.** The helper only writes queue rows.
5. **No change to `outcome`, `tickets`, `ticketsIssued`, or the audit payload.**
6. **Do not call this from settlement, webhook, checkout, or the issue route.** Issuance is the
   source of truth; a route-level call would miss internal callers and duplicate the hook.

### Existing static guard must be deliberately narrowed

`__tests__/notifications/purchase-proof-wiring.test.ts:46-56` currently asserts that
`lib/ticketing/tickets/issuance.ts` does **not** contain `lib/notifications`. Adding the
import will fail that guard. The guard's purpose is “the request path never imports the
notification worker/provider”, not “issuance may never enqueue”. The implementation should:

* update the guard to allow the single business helper import (e.g.
  `@/lib/notifications/ticket-issued`) in `issuance.ts`;
* keep asserting that `worker.ts`, transports, `nodemailer`, Baileys, and `prisma.notification`
  are absent from issuance;
* keep the guard unchanged for webhook, checkout, and the issue route, which must not enqueue
  directly.

This is a **test change plan**, not a reason to hide the import behind an indirect module.

---

## 7. Recovery Strategy

There is no outbox table, and none may be added. The idempotency key is the outbox, exactly as
Phase 2 does for purchase proof.

**Proposed:** `sweepMissingTicketNotifications()` in `lib/notifications/ticket-issued.ts`, plus
a manual script `scripts/ticket-issued-sweep.ts` (`npm run sweep:ticket-issued`). No cron in
this increment.

Eligibility query:

```text
EventOrder.status = PAID
EventOrder.paymentStatus = PAID
EventOrder.paidAt != null (older than grace)
tickets: some { status = ISSUED }
notifications: none { templateKey = "ticket-issued.v1", channel = "email"
                      OR channel = "whatsapp" }
event.status not CANCELLED / ARCHIVED
```

Notes:

* `tickets.some status = ISSUED` prevents sending a ticket notification for an order whose
  only tickets are already `CHECKED_IN`, `VOID`, or `REFUNDED`.
* Choose an event window (for example, do not send after `endAt + 30 minutes`) as an owner
  policy. The existing `isEventCheckInOpen` predicate describes admission, not notification,
  so do not import it by reflex; decide the recovery window explicitly.
* `minAgeMs` default 120 s, limit 1–100 (default 20), oldest first.
* The sweep calls the **same** `enqueueTicketIssued()` and the **same** keys. It never claims a
  delivery and never sends; the worker is the only sender.
* Running it repeatedly is safe. It must not touch `category IS NULL` legacy rows.
* If an order is `PAID` but has zero tickets, it is not eligible; issuance is still
  buyer-triggered and this design does not auto-issue.

This closes the crash-after-commit-before-enqueue gap without a migration.

---

## 8. Template Content Proposal

**Proposed key:** `ticket-issued.v1`
**Language/style:** Indonesian, professional
**Subject:** `Tiket Anda — {event title} ({orderNumber})`

### Proposed body

```text
Tiket Anda telah berhasil diterbitkan.

Nomor transaksi: {orderNumber}
Event: {eventTitle}
Jadwal: {startAt} – {endAt}
Lokasi: {venue, address, city — only when available}

Jumlah tiket: {count}

Kode tiket:
1. EVT-XXXX-XXXX
2. EVT-XXXX-XXXX

Buka e-tiket dan QR Anda:
{absolute, allow-listed wallet URL}

Tunjukkan QR atau sebutkan kode tiket kepada petugas di pintu masuk.
E-tiket ini bersifat pribadi. Jangan bagikan tangkapan layarnya.

Kontak toko:
Email: ...
Telepon: ...
Alamat: ...
```

### Content rules

* **Opening** is a proposal; the owner has not fixed a sentence for this template. The
  purchase-proof opening must not be reused verbatim because this is a different event.
* **Ticket codes** are the public `EVT-XXXX-XXXX` shape only; validate with the same
  ticket-code allow-list used by `publicTicketCodes()` (`purchase-proof-template.ts:219-247`).
* **QR line:** because no image transport exists, do not write “QR terlampir”. Write the code
  and point to the authenticated wallet page where the QR is rendered. If the owner later
  approves image delivery, the image must be generated from `TICKET:<code>` and never from a
  new token.
* **Entry instructions** must come from existing UI copy, not invented event rules:
  “Tunjukkan QR ini di pintu masuk…” (`app/ticketing/tickets/[ticketCode]/page.tsx:255-258`)
  and the privacy warning at `:335-339`. Event-specific rules, if needed, come from
  `Event.rules`; do not invent a dress code, age limit, or arrival window.
* **Store contact** uses the Phase 2 read model (`PlatformSetting`), only populated fields,
  no placeholders.
* **Never include:** internal IDs, `qrTokenHash`, raw scanner token, provider/payment URL,
  payment credential, recipient email/phone in the body, or attendee personal data beyond what
  the buyer needs.
* **Length:** with 20 codes, the message remains well within WhatsApp/email practical limits.
  Do not list 100 codes; use the wallet link and the 20-code cap.

### QR image (if the owner requires it later)

`qrcode` (already installed) can render a PNG server-side. Delivering it requires:

1. extending the transport contract with a reviewed image/attachment field;
2. activating and testing the SMTP/Baileys adapters — both still inactive;
3. an ownership/privacy review for image caching and provider storage;
4. a test that the image contains only `TICKET:<code>` and no scanner secret.

None of that is in this design's safe scope.

---

## 9. Provider / Dry-Run Compatibility

The design is compatible with Phase 2's current state and does not activate anything:

| Control | Status |
|---|---|
| `NOTIFICATIONS_ENABLED` | remains `false` |
| SMTP | inactive; no connection/authentication |
| Baileys | inactive; no pairing, QR, socket, session |
| Worker transports | dry-run only; live SMTP/Baileys refused (`worker.ts:398-402`) |
| Dry-run result | `SKIPPED / DRY_RUN_SIMULATED`, never `SENT` (`worker.ts:301-316`) |
| Real send path | unreachable while no live transport exists (`worker.ts:319`) |
| Legacy rows | claim query excludes `category IS NULL` (`queue.ts:111-114`) |
| Template registration | add only `ticket-issued.v1`; no Phase 4/5 templates |
| Enqueue failure | caught and logged; issuance unaffected |

No provider activation, pairing, QR generation, or real message is proposed.

---

## 10. Test Matrix (design only — none run)

### A. Issuance

| ID | Scenario | Expected |
|---|---|---|
| I-01 | Valid paid order issues | all `SUM(quantity)` tickets, `ISSUED`, post-commit enqueue called once |
| I-02 | Ineligible/unpaid order | issuance refused; no tickets; no notification |
| I-03 | Duplicate issuance | `ALREADY_ISSUED`, zero created, no new notification |
| I-04 | Retry after transient contention | one complete set, one notification |
| I-05 | Two concurrent issuers | one set; one notification |
| I-06 | Many tickets in one order | all tickets; one order-level notification |
| I-07 | Pre-existing partial ticket set | missing rows completed; invariant passes; one notification |
| I-08 | Enqueue throws | issuance still returns success; tickets remain; error logged sanitized |

### B. Idempotency and independence

| ID | Scenario | Expected |
|---|---|---|
| N-01 | First ticket enqueue | one email row, one WhatsApp row |
| N-02 | Duplicate issuance | no additional rows |
| N-03 | Retry enqueue | existing rows reused; no duplicate |
| N-04 | Email already exists, WhatsApp missing | repair creates only WhatsApp |
| N-05 | Purchase proof exists for same order | ticket notification uses distinct keys and template |
| N-06 | Purchase proof enqueue unaffected | proof rows unchanged |

### C. QR and security

| ID | Scenario | Expected |
|---|---|---|
| Q-01 | Payload is `TICKET:<valid code>` | valid, no PII, no URL |
| Q-02 | Payload contains scanner secret | impossible/unreachable; test asserts no `qrTokenHash` selection |
| Q-03 | Renderer receives invalid code | code omitted; no throw |
| Q-04 | Template includes `qrTokenHash`/raw token | static guard fails |
| Q-05 | Logs contain ticket code/body/recipient | log test fails |
| Q-06 | New public QR endpoint/route | route inventory test fails |
| Q-07 | Ticket validation/admission changed | existing issuance/check-in tests fail |
| Q-08 | QR image claimed without transport | design/test must fail or remain marked unsupported |

### D. Queue and worker

| ID | Scenario | Expected |
|---|---|---|
| W-01 | Only `ticket-issued.v1`/`TICKET` rows claimed | yes |
| W-02 | Legacy `category IS NULL` | never claimed; unchanged |
| W-03 | Dry-run | `SKIPPED/DRY_RUN_SIMULATED`; never `SENT` |
| W-04 | WhatsApp cap reached | remaining rows stay `QUEUED` |
| W-05 | Expired lease | `FAILED/AMBIGUOUS_DELIVERY`; no auto-resend |
| W-06 | Worker restart after simulated send | no duplicate message; idempotency at queue row |
| W-07 | Sweep run twice | no duplicate rows |
| W-08 | Sweep with missing proof | creates two rows; no send |
| W-09 | Sweep sees refunded/void/checked-in-only | skipped |

### E. Static guards

* issuance imports only the business enqueue helper, never `worker`, `transports`,
  `nodemailer`, Baileys, or `prisma.notification`;
* webhook/checkout/issue route import no notification module;
* templates registry contains exactly the allowed business keys;
* no schema/migration change.

No test in this audit may write the application database or send a message. The implementation
phase should use the isolated Jest schema established by Phase 0A/1.

---

## 11. File Change Plan (not executed)

### Source files

| File | Change | Risk | Protecting tests |
|---|---|---|---|
| `lib/notifications/ticket-issued.ts` **new** | load order/tickets, build payload, enqueue per channel, never throw, sweep | Contact/payload staleness; duplicate if key wrong | N-01…N-06, W-07…W-09 |
| `lib/notifications/ticket-issued-template.ts` **new** | `ticket-issued.v1` renderer, code allow-list, text sanitisation | Code/log leakage; malformed payload | C-01…C-08, template unit tests |
| `lib/notifications/templates.ts` | register only `ticket-issued.v1` | Accidental Phase 4/5 key | registry guard |
| `lib/ticketing/tickets/issuance.ts` | post-commit `enqueueTicketIssued` for `created.length > 0`; no transaction change | Import guard; hook timing; error propagation | I-01…I-08 |
| `scripts/ticket-issued-sweep.ts` **new** (optional) | manual bounded sweep CLI | Operator misuse | W-07…W-09 |
| `package.json` | add `sweep:ticket-issued` script | None | command check |

### Test files

| File | Change |
|---|---|
| `__tests__/notifications/ticket-issued-template.test.ts` **new** | copy, codes, QR payload gate, sanitisation, empty contact |
| `__tests__/notifications/ticket-issued.integration.test.ts` **new** | issue → enqueue, duplicates, sweep, legacy, channel independence |
| `__tests__/notifications/ticket-issued-worker.test.ts` **new** | dry-run, legacy exclusion, cap, no `SENT` |
| `__tests__/notifications/ticket-issued-wiring.test.ts` **new** | static guards, single integration point, no public route |
| `__tests__/notifications/purchase-proof-wiring.test.ts` | narrow the existing import guard for `issuance.ts` only |
| `__tests__/ticketing-issuance/*` | add/extend an issuance integration case for the hook; do not weaken existing assertions |

### Documentation

| File | Change |
|---|---|
| `docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_AUDIT.md` | this audit |
| `docs/PHASE_2_IMPLEMENTATION_REPORT.md` | later addendum only after implementation, if owner asks |

### Environment / configuration

No new required variable. Optional only if a sweep needs an event window or cap; do not add
provider credentials. `.env.example` changes are not needed for this design.

### Schema / migration

**No change.** No new table, column, enum, index, or migration. The queue, unique keys, and
lead fields already exist (`schema.prisma:197-244`, `:1722-1745`).

---

## 12. Risks and Blockers

### Facts

* F1 — Issuance is one transaction, idempotent by unique slot, and post-commit-safe
  (`issuance.ts:516-595`, `:609`).
* F2 — Public code and `TICKET:<code>` payload are the only buyer-visible ticket identifiers
  (`reference.ts:18-42`, `:158-165`).
* F3 — Current check-in uses the public code as a manual credential and does not verify the
  scanner token (`checkin/service.ts:28-43`, `:65`, `:389-391`).
* F4 — Notification transports are plain text with no attachment field
  (`lib/notifications/types.ts:38-50`).
* F5 — `qrcode` is installed, but no reviewed image/attachment delivery exists.
* F6 — Existing issuance audit writes `ticketCodes` into `afterState`
  (`issuance.ts:629-638`). Notification logging must not add a second code trail.
* F7 — The existing static guard forbids `lib/notifications` in `issuance.ts`
  (`purchase-proof-wiring.test.ts:46-56`).

### Risks

| # | Risk | Severity | Mitigation / status |
|---|---|---|---|
| R1 | A scannable QR image cannot be delivered by the current transport contract | **High for OPSI B as “QR”** | Code + authenticated wallet link only; separate attachment design; **blocker for image** |
| R2 | Sending `ticketCode` widens exposure; first holder of the code can be admitted | **High** | Verified contact only; no logging; privacy copy; revisit D-46 before activation |
| R3 | No ticket-code rotation/reissue exists | Medium | Do not promise revocation; status VOID/REFUNDED still blocks admission |
| R4 | Multi-ticket message length / WhatsApp cap | Medium | One order notification, cap 20 codes, wallet link for remainder |
| R5 | Enqueue failure after commit | Medium | Non-throwing helper + idempotent sweep |
| R6 | Duplicate issuance creates duplicate notification | Low if guarded | Only `created.length > 0`; unique keys |
| R7 | Sweep sends a stale ticket for a refunded/void/checked-in ticket | Medium | Require `tickets.some status = ISSUED`; event window policy |
| R8 | Static guard regression | Low | Deliberately narrow one guard; keep provider guards |
| R9 | Ticket notification and purchase proof confuse buyer | Low | Distinct subject/opening; proof remains at settlement; ticket message only after issuance |
| R10 | Message content drift between email/WhatsApp | Low | One renderer, one payload |

### Blockers requiring decision

1. **QR image delivery** — current contract cannot attach/embed an image. Either accept
   code + wallet link, or approve a separate attachment/transport security design.
2. **Admission semantics** — current check-in treats the public code as the credential. Owner
   must accept the increased exposure of emailing/WhatsApping it, or make D-46 (scanner token /
   holder identity) a prerequisite for activation.
3. **Entry instructions** — use existing UI copy; event-specific rules require an owner-approved
   source (for example `Event.rules`), not invented text.

---

## 13. Complexity Estimate

**Low–medium.** The queue, idempotency primitives, dry-run worker, and issuance seam already
exist. The increment needs:

* two new notification modules (helper + template);
* one post-commit hook in issuance;
* one bounded sweep and optional CLI;
* one deliberate guard-test amendment;
* unit/integration/static tests.

No schema change, no migration, no provider activation, no new dependency. The main complexity
is security review of ticket-code exposure and the decision about QR image delivery, not the
queue plumbing.

---

## 14. Verdict

### **CONDITIONAL GO**

**Go** for a separate, order-level `ticket-issued.v1` notification after issuance commit,
reusing the Phase 1 queue/worker and dry-run transport, with public ticket codes and an
authenticated wallet link.

**Conditions:**

1. Owner accepts that the first increment sends **codes + wallet link**, not a scannable QR
   image. QR image delivery is blocked by the plain-text transport contract and requires a
   separate approved design.
2. Owner accepts or mitigates the current admission semantics (public code is the manual
   credential), or makes D-46 a prerequisite before enabling real delivery.
3. The existing static guard is deliberately narrowed for the issuance enqueue helper, without
   permitting worker/transport/provider imports in issuance.
4. Dry-run remains enforced: `NOTIFICATIONS_ENABLED=false`, SMTP/Baileys inactive, no pairing,
   no real messages.

If the owner requires a scannable QR image as part of this increment, the QR-image portion is
**NO-GO** under the current transport contract; the code-based ticket notification can still
proceed separately.

---

## 15. Owner Decisions Still Required

| # | Decision | Recommendation |
|---|---|---|
| D1 | Is “QR” satisfied by a ticket code + authenticated wallet link, or is a scannable image mandatory? | Start with code + link; image is a separate security/transport increment |
| D2 | Accept sending the public ticket code by email/WhatsApp given current manual check-in? | Yes only with verified contacts and no logging; prioritize D-46 before activation |
| D3 | One notification per order or per ticket? | One per order (two channel rows) |
| D4 | Maximum ticket codes per message | 20, plus wallet link |
| D5 | Approved entry-instruction copy and event-specific rules | Use existing wallet copy; `Event.rules` only if populated |
| D6 | Recovery window for the sweep (e.g. stop after event end) | Define explicitly before implementation |
| D7 | Approve narrowing the `issuance.ts` import guard | Yes, narrowly, with provider/worker guards retained |
| D8 | Keep provider activation out of this increment | Yes — dry-run only |

---

**AUDIT COMPLETE — NO IMPLEMENTATION. STOP AND AWAIT OWNER APPROVAL.**
