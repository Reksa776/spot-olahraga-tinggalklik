# PHASE 2 — PURCHASE PROOF VIA EMAIL & WHATSAPP

**Repository:** `/home/reksa/tinggalklik`
**Branch:** `main`
**Mode:** dry-run only — no SMTP connection, no WhatsApp pairing, no real message
**Reference:** `docs/PHASE_2_PRE_IMPLEMENTATION_AUDIT.md`, `PHASE_1_IMPLEMENTATION_REPORT.md`

---

## 1. Executive Summary

Phase 2 connects a verified, committed ticket settlement to the Phase 1 notification queue. When
`settleVerifiedPayment()` returns `SETTLED`, a non-throwing helper reads the order's own snapshots,
renders one versioned Indonesian receipt (`purchase-proof.v1`) and enqueues **two independent rows** —
email and WhatsApp — under the owner-approved idempotency keys.

Both webhook settlement and operator reconciliation reach the same helper because both go through
`settleVerifiedPayment()`. Duplicate webhooks and repeat reconciliations converge on the existing
rows; late settlements and every non-`SETTLED` outcome enqueue nothing. A bounded recovery sweep can
recreate a missed enqueue without a new table or migration, and it never sends.

The provider gates remain closed: SMTP and Baileys are still fail-closed stubs, no notification
module imports `nodemailer` or `@whiskeysockets/baileys`, the worker's only transports are the
dry-run pair, and a simulated result is recorded as `SKIPPED / DRY_RUN_SIMULATED`, never `SENT`.

**Verdict: CONDITIONAL PASS.** The core Phase 2 flow, queue, recovery, template, policy and security
gates are implemented and verified. The one owner-requested element not fully delivered is the QR/ticket
section in the **normal** flow: the security review passes, but tickets do not exist at settlement time
because issuance is a separate, buyer-triggered step that Phase 2 is forbidden to change. Section 8
states this precisely; it is a data-flow limitation, not a security failure.

---

## 2. Status

| Status | Meaning |
|---|---|
| **CONDITIONAL PASS** | Purchase-proof enqueue, idempotency, recovery, template, channel independence, conservative WhatsApp policy and dry-run enforcement are implemented and tested. SMTP/Baileys activation and QR-at-settlement remain owner decisions/blockers. |

No critical blocker exists for the Phase 2 **dry-run** scope. The conditions are listed in §16.

---

## 3. Files Created and Changed

### Created

| File | Purpose |
|---|---|
| `lib/notifications/contacts.ts` | Email validation and Indonesian phone normalization to `62…`; invalid values are refused, never guessed. |
| `lib/notifications/store-contact.ts` | Narrow read model over `PlatformSetting` (`platformName`, `email`, `phone`, `address`); omits absent/invalid fields and never invents contact data. |
| `lib/notifications/purchase-proof-template.ts` | `purchase-proof.v1` payload type, safe formatters and the single renderer used by email and WhatsApp. |
| `lib/notifications/purchase-proof.ts` | Snapshot builder, channel-independent enqueue, idempotency keys, settlement eligibility and recovery sweep. |
| `scripts/purchase-proof-sweep.ts` | Manual, bounded sweep entrypoint (`npm run sweep:purchase-proof`); enqueues only. |
| `__tests__/notifications/purchase-proof-template.test.ts` | Pure template/contact/store-contact tests. |
| `__tests__/notifications/purchase-proof.integration.test.ts` | Real-database enqueue, settlement-hook, idempotency, sweep and legacy-isolation tests. |
| `__tests__/notifications/purchase-proof-worker.test.ts` | Invalid-recipient skip, WhatsApp delay/cap, dry-run outcome and log-privacy tests. |
| `__tests__/notifications/purchase-proof-wiring.test.ts` | Static guards for the single integration point, provider gates, no migration/route and verbatim copy. |
| `docs/PHASE_2_IMPLEMENTATION_REPORT.md` | This report. |

### Modified

| File | Change |
|---|---|
| `lib/notifications/templates.ts` | Registers exactly one new business template: `purchase-proof.v1`. |
| `lib/notifications/config.ts` | Adds configurable `WHATSAPP_DAILY_CAP` (default 20) and `WHATSAPP_SEND_DELAY_MS` (default 5,000 ms), with the existing fail-closed parsing. |
| `lib/notifications/queue.ts` | Adds WIB day boundary and `countWhatsAppSendsToday` (real and simulated sends both count). |
| `lib/notifications/worker.ts` | Validates and normalizes the recipient before any transport call; marks invalid recipients `SKIPPED / INVALID_RECIPIENT`; applies the WhatsApp delay and daily cap; logs category/status metadata only. |
| `lib/ticketing/payment/settlement.ts` | The one integration point, after commit, inside the `SETTLED` branch only, wrapped defensively. |
| `jest.teardown-env.ts` | Test-only isolation: removes `purchase-proof.v1` rows from the validated TEST database after each file, so Phase 1's global queue assertions do not see another suite's rows. |
| `__tests__/notifications/queue.test.ts` | One premise updated: its “unregistered template” example used `purchase-proof.v1`, which Phase 2 now legitimately registers; it uses a still-unknown key. No assertion was weakened. |
| `package.json` | Adds `sweep:purchase-proof`. |
| `.env.example` | Documents Phase 2 policy knobs, manual sweep and the still-OFF kill switch. |

Not changed: `prisma/schema.prisma` (its existing Phase 1 modification is preserved), any migration,
any ticket issuance/validation flow, any provider credential or production environment.

---

## 4. Settlement Integration

**File:** `lib/ticketing/payment/settlement.ts`
**Function:** `settleVerifiedPayment()`
**Trigger:** after the transaction has resolved and the audit/realtime post-commit blocks have run.

```ts
if (settled.outcome === "SETTLED") {
    try {
        await enqueuePurchaseProof(input.orderId);
    } catch (error) {
        structuredLog("error", "notification.purchase_proof.hook_failed", { ... });
    }
}
```

Why this is the correct point:

* it is **after commit**, so the receipt can only describe a purchase that exists;
* it is shared by the provider **webhook** and **operator reconciliation** (`reconciliation.ts`
  reaches the same function), so both paths produce the proof without a second integration;
* it checks `outcome === "SETTLED"`, so `ALREADY_PAID`, `LATE_SETTLEMENT`, `ORDER_FAILED`,
  `NOT_APPLICABLE`, `EXPIRED`, `CANCELLED` and `RETRY_LATER` enqueue nothing;
* the helper re-proves settlement from the committed columns
  (`status = PAID`, `paymentStatus = PAID`, `paidAt != null`) rather than trusting the caller;
* `enqueuePurchaseProof` never throws, and the surrounding catch is defence in depth. A queue failure
  cannot change a committed settlement or ask the provider to redeliver it.

The integration is **not** in the webhook handler, the issuance service or the checkout route; a
static test asserts those files remain free of `lib/notifications`.

`enqueuePurchaseProof(orderId)` reads the order, item snapshots, latest paid payment, event/venue,
organizer name and issued ticket **public** codes; builds one payload; reads the optional store
contact; then enqueues each channel independently.

---

## 5. Idempotency

Owner-approved keys, one per channel, in `lib/notifications/purchase-proof.ts`:

```
purchase-proof:{orderNumber}:email:v1
purchase-proof:{orderNumber}:whatsapp:v1
```

Layers that make duplication impossible:

1. `Notification.idempotencyKey @unique` — a replayed webhook/reconciliation reuses the row.
2. `UNIQUE(notificationId, channel)` — one delivery per channel per notification.
3. The settlement CAS — only one caller receives `SETTLED`; a duplicate receives `ALREADY_PAID`.
4. Two separate keys — an email retry cannot suppress or duplicate WhatsApp, and vice versa.

`enqueueNotification` also repairs a half-written pair (notification without its delivery) on the
duplicate-key path, so an interrupted call converges instead of failing forever.

Verified by the integration suite: a second `enqueuePurchaseProof()` returns
`email: "existing", whatsapp: "existing"` and the row count remains two; a second
`settleVerifiedPayment()` returns `ALREADY_PAID` and adds no rows.

---

## 6. Recovery Sweep

**Function:** `sweepMissingPurchaseProofs()` in `lib/notifications/purchase-proof.ts`
**Entrypoint:** `npm run sweep:purchase-proof -- --limit 20`

The idempotency key is the outbox. A paid order with no `purchase-proof.v1` notification for a
channel is, by definition, an enqueue that never completed. The sweep:

* queries `status = PAID AND paymentStatus = PAID AND paidAt <= now - grace`;
* only where the **email** or **whatsapp** proof row is absent (`notifications: { none: … }`);
* is bounded (`limit` 1–100, default 20) and ordered oldest-first;
* calls the **same** `enqueuePurchaseProof` with the **same** keys, so it races safely with a live
  enqueue;
* **never claims a delivery and never sends** — the worker remains the only sender;
* never reads, rewrites or deletes a legacy row (`category IS NULL`);
* supports an optional `orderIds` filter for targeted operator recovery and deterministic tests
  (an addition over the audit, §17).

`minAgeMs` defaults to 120 s so the sweep does not race a settlement whose normal enqueue is still in
flight. **No production cron was installed.** Recommended future scheduling: the existing
machine-authenticated tick route, a PM2 cron restart, or a system timer — all call the same idempotent
function.

Verified: the sweep finds a proof-less paid order, creates exactly two rows, a second run creates
none, no delivery becomes `SENT`, batch size is respected, and a legacy row is byte-for-byte unchanged.

---

## 7. Purchase Proof Template

**Key:** `purchase-proof.v1`
**Language/style:** Indonesian, professional
**Opening sentence, verbatim and asserted by test:**

> Bukti pembelian Anda telah berhasil dikonfirmasi. Simpan pesan ini sebagai referensi transaksi Anda.

Both channels use the same payload and the same renderer, so totals/wording cannot diverge.

Content: transaction number, settlement date (event timezone, `id-ID`), buyer name, organizer,
per-line item name/quantity/unit price/subtotal from the **checkout snapshot**, subtotal, discount
(only when non-zero), total, payment method/channel, payment status (“Lunas”), event name, schedule,
venue/location, optional store contact, and public ticket codes when they exist.

Guards:

* money is formatted textually from the stored `Decimal#toFixed(2)` — no float round-trip;
* no internal database id, payment URL, provider id, credential, session or QR secret;
* buyer email/phone are **not** printed in the body (they are delivery addresses, not receipt lines);
* at most 10 item **lines**, with `… dan N item lainnya.` when truncated;
* all stored strings are stripped of control characters/newlines and length-bounded, so a product
  name cannot inject a new line or markup;
* plain text only; no attachment and no HTML.

---

## 8. QR / Ticket Code Security Review

**Inspected mechanism:** `lib/ticketing/tickets/reference.ts`, `Ticket` schema, the wallet route
`app/api/ticketing/tickets/[ticketCode]/route.ts` and the issuance service.

**Facts found**

| Question | Finding |
|---|---|
| Does the QR carry a bearer scanner secret? | **No.** The wallet QR payload is `TICKET:<ticketCode>`. `Ticket.qrTokenHash` is a one-way hash whose plaintext is not retrievable and is never returned to the wallet or this module. |
| Is `ticketCode` a secret? | **No.** It is documented as the PUBLIC lookup code, printed on the e-ticket and quoted in email subjects. |
| Can a ticket code be used without authorization? | A code is not authorization; it is a lookup key. The public QR payload contains no URL and no token. |
| Is there a revocation mechanism? | The schema carries `qrVersion`/`ticketCode`; Phase 2 changes neither. |
| Can Phase 2 create a new QR token or public endpoint? | **No** — and it does not. No new token is minted and no route was added. |

**Decision:** the security gate **passes for the public `ticketCode` + `TICKET:<code>` payload**. The
renderer prints only values matching the public ticket-code alphabet; any other value is discarded.
It never reads `qrTokenHash`, never prints a scanner token, and never logs a ticket code.

**Blocking limitation (owner-visible):** in the normal flow the proof is enqueued at settlement, but
tickets are created by the separate buyer-triggered `POST /api/ticketing/orders/{n}/issue`. Phase 2 is
forbidden from changing issuance, so at settlement `tickets` is usually empty and the receipt says:

> Tiket akan tersedia di halaman pesanan Anda setelah diterbitkan.

The QR/ticket section is therefore **implemented and tested with fixture tickets but not populated in
the ordinary settlement proof**. Delivering an actual QR image/attachment was also not implemented:
that needs a separate security/attachment design and is out of scope. To put QR/tickets into the
proof, the owner must approve either earlier ticket issuance or a separate ticket-issued
notification. This is the main reason the verdict is CONDITIONAL PASS rather than PASS.

---

## 9. Store Contact

`lib/notifications/store-contact.ts` is the narrow read model the audit asked for:

* reads `PlatformSetting` id 1, selecting only `platformName`, `email`, `phone`, `address`;
* validates email with the same contact rules and the phone with the Indonesian normalizer;
* omits an absent, blank or invalid field;
* returns `null` when no contact field exists, so the whole “Kontak toko” block disappears rather
  than showing placeholders;
* a database/read error returns `null` and cannot fail the proof or cause a retry;
* read-only; no schema/migration and no writer changes.

`StoreSetting` (the legacy retail singleton) was deliberately not used; the audit identified
`PlatformSetting` as the ticketing platform's read model.

---

## 10. Email and Phone Normalization

`lib/notifications/contacts.ts`:

* email: trim, one `@`, dotted domain, ≤ 254 chars; domain lower-cased, local part preserved;
* phone: strip spaces/`.`/`-`/parentheses, accept a single leading `+`, convert `0…` to `62…`,
  accept `62…`, and accept a bare `8…` as the implied-country-code form; require `628` followed by
  7–10 subscriber digits; landlines and anything ambiguous are refused;
* **the order's stored `buyerEmail`/`buyerPhone` are never modified**;
* the normalized value is what the transport receives; the queue row keeps the enqueue value;
* an empty contact skips the channel with no row (there is no address to store);
* a non-empty but invalid contact is enqueued so the worker can mark it
  `SKIPPED / INVALID_RECIPIENT` — a durable terminal outcome rather than a silent drop or an endless
  sweep retry;
* one channel's invalid contact cannot stop the other: email and WhatsApp are separate rows and
  separate enqueue attempts.

Tests cover `08… → 628…`, `+62…`, `62…`, bare `8…`, landlines, malformed values, invalid email and
missing email. Integration tests cover “email missing, WhatsApp created”.

---

## 11. Conservative WhatsApp Policy

* **One proof per transaction**, enforced by the per-channel idempotency key; no broadcast/blast
  command or endpoint exists.
* **Concurrency one** for WhatsApp (Phase 1 config), plus a configurable pause before every send
  (`WHATSAPP_SEND_DELAY_MS`, default 5,000 ms). Email remains concurrency 3.
* **Daily cap** (`WHATSAPP_DAILY_CAP`, default 20) counted from real `SENT` and simulated
  `SKIPPED / DRY_RUN_SIMULATED` rows since midnight Asia/Jakarta (WIB, UTC+7, no DST).
* When the cap is reached, the remaining rows are **left QUEUED** — deferred, not failed, no attempt
  consumed — and the worker logs `notification.whatsapp.daily_cap_reached`.
* A partial allowance claims only the remaining quota.
* The cap and delay are configurable; no value is asserted as a production limit. The dry-run
  defaults are deliberately conservative. Before activation, the owner should approve production
  values (a sensible initial range is 20–30 messages/day with a 5–10 s pause, to be reviewed against
  the real number's behaviour).
* An invalid number is never sent; the row is terminally skipped.

Tests inject the delay and the day counter so the policy is deterministic without sleeping or
exhausting a shared daily budget.

---

## 12. SMTP and Baileys Status

| Item | Status |
|---|---|
| SMTP | **INACTIVE.** `lib/notifications/transports/smtp.ts` still throws on construction; no `nodemailer` import on the worker/proof path; no connection test and no authentication. `nodemailer@8.0.11` was not upgraded, overridden or replaced; Auth.js peer compatibility is untouched. |
| Auth.js Email provider / magic link | **Not used.** No Auth.js configuration was changed. |
| Baileys | **INACTIVE.** `lib/notifications/transports/baileys.ts` still throws; no import, socket, QR, pairing, session directory, reconnect loop or pairing CLI/route. |
| `NOTIFICATIONS_ENABLED` | `false` in `.env.example`; absent/invalid values remain OFF. No environment file or production configuration was changed. |
| Effective transport | dry-run or disabled only, clamped by `PHASE_1_DRY_RUN_ONLY`. |
| Real provider reachable | **No.** No code path in the proof/worker flow can instantiate SMTP or Baileys. |

WhatsApp Cloud API was not introduced (owner decision: Baileys target).

---

## 13. Proof That No Real Message Was Sent

1. `createDryRunEmailTransport()` / `createDryRunWhatsAppTransport()` are the only transports the
   worker instantiates unless a test injects one; the worker **refuses** an injected `smtp`/`baileys`
   transport before claiming work.
2. The dry-run result is written as `SKIPPED`, `errorCode = DRY_RUN_SIMULATED`; `sentAt` and
   `providerMessageId` stay null. `markDeliverySent` is unreachable in Phase 2.
3. No `nodemailer` or Baileys import exists in `lib/notifications/**` or the proof path — asserted by
   a static test.
4. No SMTP host/credential is read on the proof path; no WhatsApp session directory is touched.
5. The worker test with a valid proof payload ends `SKIPPED / DRY_RUN_SIMULATED`, `sent: 0`.
6. The application database still has **0** notification deliveries and **0** job locks; the worker
   was not run against it during this phase.
7. No email/WhatsApp was sent, no pairing was attempted, and no provider authentication occurred.

---

## 14. Database and Migration Status

* **Migration created: NO.**
* **Migration executed: NO.**
* **Schema changed this phase: NO.** No new table, column, index or enum.
* `npx prisma migrate status`: **32 migrations found; database schema is up to date.**
* `git status prisma/migrations`: **empty.**
* Lease still uses the Phase 1 `nextRetryAt` idiom; no `lockedUntil`/`lockedBy` was added to
  `NotificationDelivery`.
* Application database (read-only verification, after all tests):

```json
{"notifications":44,"legacyNullCategory":44,"deliveries":0,"jobLocks":0,"appliedMigrations":32}
```

Legacy data is untouched: 44 rows, all `category IS NULL`, none claimed, none rewritten, none deleted.

---

## 15. Test and Validation Results

All commands were run in this session. Results are actual, not projected.

| Check | Result |
|---|---|
| `npx tsc --noEmit` | **exit 0** |
| `npx eslint` on changed Phase 2 source/tests | **exit 0**, no warnings/errors |
| `npx prisma validate` | **valid** |
| `npm run build` | **exit 0** |
| `git diff --check` | **exit 0** |
| `npx prisma migrate status` | **32 migrations, up to date** |
| Notification suite (`npx jest __tests__/notifications --runInBand`) | **8 suites / 102 tests passed** |
| **Full Jest suite** | **167 suites / 3,569 tests passed**, 2 snapshots passed, exit 0 |
| Phase 1 suite | Still passes unchanged (the only edit is the now-registered template key in one premise, noted in §3/§17). |

Phase 2 test coverage includes:

* `SETTLED` enqueues; `ALREADY_PAID`, late settlement, pending, cancelled and failed orders do not;
* webhook replay and duplicate reconciliation create no duplicate rows;
* separate email/WhatsApp keys; enqueue failure cannot fail settlement;
* invalid/empty email and phone; one channel succeeds while the other skips;
* template opening, snapshots, discount, long-list truncation, store contact absent/present,
  ticket-code allow-list and no internal/secret data;
* sweep finds a missed proof, is repeatable, bounded, never sends and never touches legacy;
* worker: no SMTP/Baileys connection, no `SENT`, invalid recipient terminal skip, WhatsApp delay,
  daily cap deferral, partial allowance, concurrency one;
* logs contain no recipient, body, ticket code or order-level personal data;
* static guards over the single integration point, request-path imports, provider imports, schema,
  migrations and routes.

No old assertion was deleted, skipped, relaxed or suppressed.

---

## 16. Remaining Risks and Blockers

| # | Item | Status / action |
|---|---|---|
| B1 | SMTP activation with `nodemailer@8.0.11` and the Phase 0C advisories | **Owner decision + separate dependency audit.** No upgrade/override was made. |
| B2 | Baileys activation: pairing, session storage, reconnect/logout, ban risk | **Owner/operator decision.** Adapter remains fail-closed; no session exists. |
| B3 | QR/ticket code in the normal proof | **Implemented but usually empty** because tickets are issued after settlement. Needs an approved design (earlier issuance or a separate ticket-issued message). No workaround was built. |
| B4 | QR image/attachment delivery | **Not implemented.** Needs a separate attachment/security review; the proof is plain text only. |
| B5 | Nullable buyer email/phone | Missing contact skips that channel. Adding contact capture belongs to checkout/product, outside Phase 2. |
| B6 | Proof copy beyond the owner-fixed opening | Professional Indonesian draft implemented; owner may review wording before activation. |
| B7 | Delivery-status UI | Out of scope; status is queryable in the queue tables. |
| B8 | Production WhatsApp cap/delay values | Not agreed; defaults are dry-run conservative. Owner must approve before activation. |
| B9 | Sweep scheduling | Manual command only; no production cron installed. |
| B10 | Enqueue is not transactional with settlement | **Mitigated** by the non-throwing helper plus the idempotent sweep; a process crash in the gap is recoverable. |

Residual security posture: no credential, token, session or QR secret is logged or stored by this
phase; no SMTP connection, provider authentication, pairing or real send occurred; the dependency
surface was not changed.

---

## 17. Deviations From the Audit and Why

1. **QR/ticket recommendation reversed by the owner, with the gate preserved.** The audit
   recommended omitting QR/ticket. The owner approved YES; the implementation includes only the
   PUBLIC code and `TICKET:<code>` payload, not the scanner secret, a new token, an image/attachment
   or a public route. The normal-flow emptiness is reported as a blocker (§8), not hidden.
2. **Store contact source:** `PlatformSetting` (the audit's identified read model), not the legacy
   retail `StoreSetting`.
3. **Sweep `orderIds` filter added.** It narrows recovery to specific orders for operators and makes
   tests deterministic; the default remains all eligible paid orders.
4. **Recipient validation is in the worker as well as the helper.** An invalid non-empty contact is
   enqueued and terminally skipped (`INVALID_RECIPIENT`) so it has a durable audit row and the sweep
   does not retry it forever.
5. **Test isolation:** `jest.teardown-env.ts` now removes `purchase-proof.v1` rows from the isolated
   TEST database after each file. Without this, the new, legitimate post-settlement rows changed the
   outcome of Phase 1's global queue assertions depending on suite order. No production behaviour and
   no assertion was changed.
6. **One Phase 1 test premise updated:** its “unregistered template” example was
   `purchase-proof.v1`, which Phase 2 now registers; it uses a template key that is still unknown.
   The refusal-before-write property is unchanged and still asserted.
7. **No new queue columns.** As in Phase 1, `nextRetryAt` doubles as the lease while `SENDING`;
   adding `lockedUntil`/`lockedBy` would require a migration that Phase 2 is forbidden to create/run.
8. **`itemCount` counts item LINES**, not seats, because the template caps lines and the omission
   note must describe the list it truncated.

---

## 18. Work Not Permitted Before Owner Approval

Do **not** do any of the following until the owner reviews this report and gives explicit approval:

* set `NOTIFICATIONS_ENABLED=true` in any environment;
* construct/activate the SMTP transport, perform an SMTP connection/authentication test, or send a
  real email;
* import Baileys on a running path, pair a number, create a QR, open a socket or store a session;
* upgrade/override `nodemailer` or change Auth.js peer dependencies;
* enable the Auth.js Email provider/magic link;
* change ticket issuance so tickets exist before settlement, or add QR images/attachments/public QR
  routes;
* create or run a migration, add a table/column, or modify production data;
* install a production cron for the sweep without an operational decision;
* start Phase 3 (PIC QR scanning) or any later phase;
* commit, push, deploy, reset, rebase or stash.

---

**Phase 2 dry-run implementation is complete. STOP — awaiting owner review.**
