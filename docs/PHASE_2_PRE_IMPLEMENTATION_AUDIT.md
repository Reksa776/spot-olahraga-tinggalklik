# PHASE 2 — PRE-IMPLEMENTATION AUDIT
## Send Purchase Proof via Email & WhatsApp (Baileys)

**Project:** TinggalKlik.Co
**Date:** 2026-11-04 (WIB)
**Repository:** `/home/reksa/tinggalklik` · branch `main` · HEAD `25cbf0c`
**Mode:** **AUDIT ONLY** — no implementation, no migration, no database write, no provider activation, no Baileys pairing, no QR, no session.
**Scope:** Phase 2 only. Phase 3/4/5 are not audited as work and not started.
**Owner decisions treated as locked:** SMTP target; Auth.js Email provider forbidden; WhatsApp via Baileys (Cloud API not used); standalone polling worker; reuse Phase 1 queue; dry-run until activation approval; no real sends.

---

## 1. Executive Summary

**Verdict: CONDITIONAL GO** — Phase 2 can be implemented in dry-run on the existing Phase 1 foundation, but **not activated** until the conditions in §13 and §16 are met.

What the audit established:

1. **A single, correct trigger point exists.** `settleVerifiedPayment()` (`lib/ticketing/payment/settlement.ts:282`) is the only engine that transitions an order to `PAID`, and it is shared by both entry paths: the webhook (`lib/ticketing/payment/webhook.ts`) and operator reconciliation (`lib/ticketing/payment/reconciliation.ts:439`). Its post-commit block (`settlement.ts:531`) already publishes realtime events **outside** the transaction. That is the seam Phase 2 should use, and it covers reconciled settlements too.
2. **The purchase-proof data is sufficient, with three gaps.** Order number, buyer name, line snapshots, quantities, prices, totals, payment method/channel, paid date, event and organizer are all persisted. Missing: a display currency formatter, a public store-contact read model for `PlatformSetting.email/phone/address`, and a WhatsApp phone normalizer. No field needs to be invented.
3. **Idempotency is already strong enough to build on.** `notification.idempotencyKey @unique` plus `UNIQUE(notificationId, channel)` plus the webhook's `WebhookEvent.providerEventId @unique` means a replayed payment or a duplicate enqueue cannot produce a second proof. The trigger must fire **only** on the `SETTLED` outcome, never on `ALREADY_PAID`, `LATE_SETTLEMENT`, `ORDER_FAILED`, or `NOT_APPLICABLE`.
4. **The queue/worker need no schema change.** Phase 1's existing columns, CAS claim, `nextRetryAt` lease, backoff and ambiguity policy are sufficient for two independent channel deliveries.
5. **Both live transports remain blocked by design.** SMTP is blocked by the unresolved Phase 0C nodemailer advisory decision (C1); Baileys is blocked by the owner's activation gate and its own unofficial-client risk (C4). Phase 2 should implement the adapters but must keep them unreachable.
6. **Three concrete reliability gaps were found** and must be addressed in Phase 2 implementation, not activation: (a) a post-commit enqueue failure can silently lose a proof; (b) buyer phone numbers are never normalised to international format; (c) the Phase 1 static guard forbids importing `lib/notifications` from `webhook.ts` and `issuance.ts` — so wiring must go in `settlement.ts`, or that guard must be narrowed deliberately.

---

## 2. Scope and audit boundaries

**In scope (audited, not implemented):** transaction/payment flow; purchase-proof data; SMTP/Nodemailer; Baileys; queue and worker; template content; trigger/integration; test matrix; blockers; files to change.

**Out of scope / not performed:** implementation; migration creation or execution; any DDL/DML; provider activation; SMTP connection or authentication; Baileys pairing, socket, QR or session; real email/WhatsApp; commit/push/deploy/reset/rebase/stash; production environment changes; Phase 3+.

**Classification used in this report:**
* **FACT** — read from the repository or measured by a command.
* **RISK** — a consequence that follows from a fact.
* **RECOMMENDATION** — a technical proposal; not a decision.
* **UNVERIFIED** — cannot be established in this environment.

---

## 3. Repository condition at audit

### 3.1 Measured

| Check | Result |
|---|---|
| Branch / HEAD | `main` / `25cbf0c` (`fix landing paaage`) |
| Pre-existing work | Phase 0A–0C modifications and Phase 1 implementation are present and **untouched** by this audit |
| Migrations | **32**, `prisma migrate status` → **Database schema is up to date** |
| Migration files added by this audit | **none** |
| Test DB | `tinggalklik_test` verified separately; Phase 1 suite runs against it |
| Phase 1 suite | `npx jest __tests__/notifications --runInBand --silent` → **51/51 pass, 4/4 suites** |
| `nodemailer` installed | **8.0.11** (exact pin) |
| `@whiskeysockets/baileys` installed | **6.7.24**, `engines.node >=20.0.0` |
| `@auth/core` peer for nodemailer | `^7.0.7 \|\| ^8.0.5` |
| Node runtime / project engines | **24.21.0** / `>=20.9.0 <25` |
| Notification code | Phase 1 only; **no production caller of `enqueueNotification`** |
| Legacy notifications | 44 rows, all `category IS NULL`; unchanged |

### 3.2 Commands actually run (no writes, no provider)

| Command | Result |
|---|---|
| `npx jest __tests__/notifications --runInBand --silent` | exit 0, 51 tests pass |
| `npx prisma migrate status` | exit 0, 32 migrations, up to date |
| `git status --porcelain prisma/migrations` | empty |
| `node -p "require('nodemailer/package.json').version"` | `8.0.11` |
| `node -p "…baileys…engines"` | `{"node":">=20.0.0"}` |
| `node -p "…@auth/core…peerDependencies"` | nodemailer `^7.0.7 \|\| ^8.0.5` |
| `git status` / `git log -1` | branch/HEAD as above; Phase 0/1 changes preserved |

**Not run:** the payment/issuance integration suites (not required for this audit), `npm audit` (Phase 0C already measured it), any real SMTP/WhatsApp operation.

**No application behaviour was changed by this audit.** Only this report and the `docs/` directory were created.

---

## 4. Transaction flow map

### 4.1 Sources of truth

| Fact | Evidence |
|---|---|
| Order header, buyer snapshot, money snapshot, statuses | `prisma/schema.prisma:1060` `model EventOrder`; `buyerName` 1066, `buyerEmail` 1067, `buyerPhone` 1068, `status` 1069, `paymentStatus` 1070, `paidAt` 1090 |
| Line snapshots (name/price/quantity/subtotal) | `schema.prisma:1129` `model EventOrderItem` (`nameSnapshot`, `priceSnapshot`, `quantity`, `subtotal`) |
| Payment attempt (method, channel, amount, provider ids) | `schema.prisma:1262` `model Payment`; `method` 1281, `channel` 1282, `amount` 1283, `status` 1285, `paymentReference` 1290 |
| Event / venue / organizer | `Event` (`schema.prisma:906`), `Venue` via `event.venue.name`, `Organizer` (`schema.prisma:727`) |
| Store/platform identity | `PlatformSetting` (`schema.prisma:1794`): `platformName`, `email`, `phone`, `address`, `logoUrl` |
| Stock/seat conversion | `confirmOrderReservations` inside settlement (`settlement.ts` step 6) |

Order statuses (`schema.prisma:468`): `PENDING_PAYMENT`, `PAID`, `CANCELLED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED`.
Payment statuses (`schema.prisma:478`): `UNPAID`, `PENDING`, `PAID`, `FAILED`, `EXPIRED`, `REFUNDED`, `PARTIALLY_REFUNDED`.

### 4.2 Flow

```
checkout (PENDING_PAYMENT / UNPAID)
   │  lib/ticketing/checkout.ts (order + item snapshots, buyer contact)
   ▼
pay session (payment row PENDING)  lib/ticketing/payment/service.ts
   │
   ├── provider webhook ──► handleGatewayWebhook (webhook.ts)
   │      signature → amount → WebhookEvent ledger → settle
   │
   └── operator reconciliation ──► reconciliation.ts:439
          provider evidence → settleVerifiedPayment
                                       │
                                       ▼
                    settleVerifiedPayment (settlement.ts:282)
                    ONE prisma.$transaction (settlement.ts:287):
                      order CAS PENDING_PAYMENT → PAID
                      settle payment row + PaymentTransaction
                      convert reservations (reserved→sold)
                      PIC EARNED ledger
                    AFTER COMMIT (settlement.ts:531):
                      publishPaymentPaid (+ PIC ledger event)
                      writeTicketingAudit
                    returns SETTLED | ALREADY_PAID | ORDER_FAILED |
                            LATE_SETTLEMENT | NOT_APPLICABLE | RETRY_LATER
```

### 4.3 Which statuses are valid for a purchase proof

| Outcome / state | Send proof? | Reason |
|---|---|---|
| `SETTLED` (order `PAID`, `paymentStatus PAID`, `paidAt` set) | **YES** | The only state that means money was verified and seats were sold. |
| `ALREADY_PAID` (same order, different/replayed event) | **NO** | Nothing changed; the first settlement already triggered the proof. |
| `PENDING` / `UNPAID` / `PENDING_PAYMENT` | **NO** | No verified money. |
| `ORDER_FAILED` / order `CANCELLED` after failure | **NO** | Payment failed; seats released. |
| `LATE_SETTLEMENT` (money arrived for CANCELLED/EXPIRED) | **NO** | `settlement.ts` deliberately keeps the order cancelled and blocks fulfilment; this is an operator alert, not a purchase. |
| `NOT_APPLICABLE` | **NO** | Order was not payable; no state change. |
| `RETRY_LATER` | **NO** | Transaction rolled back; no payment state changed. |
| Refund (`REFUNDED` / `PARTIALLY_REFUNDED`) | **NO** | Out of Phase 2 scope; refund rail is manual. |
| COD | **N/A** | Not offerable (see §4.5). |

### 4.4 Can one transaction trigger repeated sends?

**FACT:** Yes, at the raw webhook level a provider can deliver the same event repeatedly, but the platform already blocks re-processing:

* `WebhookEvent.providerEventId @unique` is the replay guard; a `PROCESSED` row returns `DUPLICATE` with no settlement (`webhook.ts` `claimLedgerRow`).
* Settlement's order CAS (`status: PENDING_PAYMENT`, `paymentStatus != PAID`) admits exactly one winner; a second event returns `ALREADY_PAID` (`settlement.ts` step 4).
* A different provider event for an already-paid order also returns `ALREADY_PAID` and does not publish.

**RISK:** A Phase 2 trigger placed at the *webhook route* or *settlement outcome handler* without an idempotency key could still enqueue twice for two different provider events that both render `SETTLED` (not possible today) or after an operator retry. The queue key is therefore still required.

**FACT — existing idempotency primitives:** `Notification.idempotencyKey @unique` (`schema.prisma:194`), `NotificationDelivery @@unique([notificationId, channel])` (`schema.prisma:1731`), and `enqueueNotification` returns the existing pair on collision (`lib/notifications/enqueue.ts:167`).

### 4.5 COD and unsupported payment states

* `PaymentMethod.COD` exists in the enum (`schema.prisma:500`) because the provider supports it, but the method catalog **deliberately does not offer it**: “A digital ticket has nothing to deliver” (`lib/ticketing/payment/method-catalog.ts:48-52`).
* A payment creation attempt with `COD` is rejected by the service (`__tests__/ticketing-payment/payment-creation.integration.test.ts:244-248`).
* **Conclusion:** COD is not a supported transaction for this product; Phase 2 needs no COD proof path. If a legacy/manual `Payment.method = COD` row is ever settled, the trigger still fires on `SETTLED`; the template must render the method label without assuming it is offerable.

### 4.6 Purchase-proof data completeness

| Required field | Available? | Source |
|---|---|---|
| Nomor transaksi | YES | `EventOrder.orderNumber`; also `Payment.paymentReference` |
| Nama pelanggan | YES | `EventOrder.buyerName` |
| Detail produk/layanan | YES | `EventOrderItem.nameSnapshot` (+ `Event.title`) |
| Kuantitas | YES | `EventOrderItem.quantity` |
| Harga | YES | `EventOrderItem.priceSnapshot`, `subtotal` |
| Total pembayaran | YES | `EventOrder.total` (+ `subtotal`, `discount`, `platformFee`, `picFeeTotal`) |
| Metode pembayaran | YES | `Payment.method`, `Payment.channel`; human label in `PAYMENT_METHOD_OPTIONS` |
| Status pembayaran | YES | `EventOrder.paymentStatus` (PAID at trigger) |
| Tanggal transaksi | YES | `EventOrder.createdAt`, `paidAt` |
| Informasi toko | PARTIAL | `PlatformSetting.platformName/email/phone/address` exist, but `getApplicationSettings()` selects only name/logo/maintenance (`lib/app-settings.ts`) and `lib/store-settings.ts` reads the legacy retail `StoreSetting` |
| Tambahan: event/venue/jadwal | YES | `Event.title`, `startAt`, `endAt`, `Event.timezone`, `venue.name` |
| Tambahan: ticket codes/QR | NO (not at settlement) | Issuance is a separate buyer-triggered action (`issuance.ts:469`); QR must not be sent by proof |

---

## 5. Email (SMTP) audit

### 5.1 Facts

* SMTP adapter exists only as a fail-closed skeleton: `lib/notifications/transports/smtp.ts` `createSmtpEmailTransport()` **always throws** `Phase1TransportRefusedError`; it has **no `nodemailer` import**, no connection, no auth.
* `readSmtpAdapterConfig()` reads `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `EMAIL_FROM` but deliberately **not** `SMTP_PASS` (the password is not in `SmtpAdapterConfig`).
* Config clamping: `lib/notifications/config.ts` `PHASE_1_DRY_RUN_ONLY = true`; `EMAIL_TRANSPORT=smtp` is downgraded to `dry-run` with a refusal recorded.
* Installed `nodemailer` **8.0.11**; `@auth/core@0.41.3` peer is `nodemailer: ^7.0.7 || ^8.0.5` → **peer-compatible today**. Upgrading to ≥10 (the only line without the advisories, per Phase 0C) breaks that peer range, and `--force`/`overrides` are forbidden.
* Auth.js providers: `auth.ts` has Google + Credentials only; no Email provider, no magic link. **C2 intact.**
* Buyer email is validated at checkout by Zod `.email().max(200)` (`lib/ticketing/checkout-validation.ts`, `emailSchema`), but `EventOrder.buyerEmail` is **nullable** in the schema, and nothing re-validates at send time.

### 5.2 Risks

| # | Risk | Consequence |
|---|---|---|
| E1 | Nodemailer 8.0.11 carries 4 High advisories (Phase 0C, accepted residual) | Activating SMTP would put the vulnerable parser on a live code path with recipient data |
| E2 | Upgrading to ≥10 to silence advisories violates the Auth.js peer range | `ERESOLVE`/nested duplicate; forbidden workaround |
| E3 | `nodemailer` is already installed as a peer of `@auth/core` | Even an unused import path is a temptation; keep the adapter isolated and lazily imported |
| E4 | SMTP credentials could leak through logs/config | Adapter throws before reading a password; Phase 1 log redaction masks secret-named fields and connection strings |
| E5 | Missing/invalid `EMAIL_FROM` | Must fail closed at worker start when SMTP is activated, not send with an invented identity |
| E6 | SPF/DKIM/reputation is an operational responsibility | Proofs may land in spam or be rejected; not solvable in code |
| E7 | Buyer email may be null (schema) or stale | Delivery would fail; must skip with a terminal reason, not retry forever |
| E8 | Timeouts/retry semantics | SMTP can hang; the adapter contract must set connection/socket timeouts and let the queue own retry/backoff |

### 5.3 Recommendations (technical, no owner-decision change)

1. **Keep SMTP unreachable until activation approval.** Implement the real adapter in `lib/notifications/transports/smtp.ts` with a **dynamic import** of `nodemailer` inside `createSmtpTransport()`, so the module graph stays clean when inactive.
2. Use exactly the documented contract already in the file: `tls.rejectUnauthorized: true`, `connectionTimeout: 10_000`, `socketTimeout: 20_000`, `disableFileAccess: true`, `disableUrlAccess: true`, no `raw`, no attachments, plain text, `from = EMAIL_FROM`, recipient from the queue row.
3. Do **not** upgrade/override nodemailer in Phase 2. Activation remains blocked on C1 (Phase 0C §2.4/§12).
4. Validate recipient format server-side immediately before send (reuse the checkout email predicate or an equivalent); invalid → `SKIPPED / INVALID_RECIPIENT`, non-retryable.
5. Never log recipient, subject body, credentials, or the SMTP host on failure. Use `sanitizeErrorMessage` (Phase 1) before writing `errorMessage`.
6. Treat provider responses as evidence only: store `providerMessageId` from `info.messageId` as soon as the send resolves, then mark `SENT`.

---

## 6. WhatsApp (Baileys) audit

### 6.1 Facts

* Adapter skeleton: `lib/notifications/transports/baileys.ts` `createBaileysWhatsAppTransport()` **always throws** `Phase1WhatsAppRefusedError`; **no Baileys import**, no socket, no `makeWASocket`, no `useMultiFileAuthState`, no QR, no session directory.
* Installed **6.7.24**; `engines.node >=20.0.0`; project Node is **24.21.0** (project range `<25`) → runtime compatible.
* No advisory for Baileys in Phase 0C; risk is operational/ToS, not CVE.
* Phase 1 worker refuses an injected transport whose `kind` is `"baileys"` (`lib/notifications/worker.ts` guard) — a live adapter cannot be smuggled in.
* Queue delivery state is per channel; WhatsApp concurrency is fixed at **1** (`config.ts` `whatsappConcurrency`).

### 6.2 Risks

| # | Risk | Consequence / mitigation direction |
|---|---|---|
| W1 | Baileys is an **unofficial** client | Account ban, ToS breach, session loss. Owner accepted the choice; activation remains gated. |
| W2 | Pairing = full account control | QR must never be rendered in a web route. Host-only pairing, `WA_AUTH_DIR` 0700/0600, outside the checkout, encrypted backup. |
| W3 | Two sockets on one credential disconnect each other | One socket per session, serialised by a `joblock` row (e.g. `whatsapp-session`); do not run WhatsApp in the web process. |
| W4 | Session invalid / logout | `DisconnectReason.loggedOut` must **stop** and require re-pair, never reconnect-loop (loop invites a ban). |
| W5 | Reconnect storm | Exponential backoff 2 s → 5 min; bounded attempts; surface state. |
| W6 | Rate limits / bulk sending | One message at a time, deliberate delay, daily cap; no broadcast (Phase 4 concern, but Phase 2 must not create the habit). |
| W7 | Phone format | Checkout only regex-validates `[0-9+\-\s()]`, 7–20 chars; **no E.164 normalization exists anywhere** (search for `normalizePhone`/`E.164` → 0 results). Indonesian `08…` must become `62…` for a WhatsApp JID. |
| W8 | Unregistered / unreachable number | Provider/Baileys may accept the send and never deliver. Treat as a send attempt, not a guaranteed delivery; record provider id; do not auto-resend blindly. |
| W9 | No provider idempotency key | A retry can duplicate a message. Store the Baileys message key/id ASAP; ambiguous outcome is terminal (`AMBIGUOUS_DELIVERY`), never auto-retried. |
| W10 | Session keys in logs | Log only ids/status; never JIDs, auth state, QR payload, or message bodies. |
| W11 | Graceful shutdown | Close the socket after the in-flight message; the DB lease/CAS already protects against a second worker. |
| W12 | Pairing during Phase 2 implementation | Forbidden by the owner brief for this stage. Implementation must ship adapter code that is unreachable until activation approval. |

### 6.3 Recommendations

1. Build the real adapter with a **lazy import** and a constructor that refuses unless an explicit activation gate is satisfied. Keep `PHASE_1_DRY_RUN_ONLY` (or its Phase 2 successor) clamping `WHATSAPP_TRANSPORT=baileys` to dry-run until the owner approves activation.
2. Implement a `normalizeWhatsAppRecipient` helper: strip spaces/dashes/parentheses; leading `0` → `62`; require 8–15 digits after normalization; reject otherwise as `SKIPPED / INVALID_RECIPIENT`.
3. Session lifecycle: `useMultiFileAuthState(WA_AUTH_DIR)` (host-only), a `joblock` session lease, reconnect with backoff, stop on `loggedOut`, health state written to the lease row.
4. Send one message at a time; add an inter-message delay and a cap; keep WhatsApp out of the web process entirely.
5. Store the Baileys message id as `providerMessageId`; on disconnect mid-send, let the lease expire into `FAILED / AMBIGUOUS_DELIVERY`, never an automatic resend.
6. Add a test that asserts the adapter module has **no top-level** Baileys import and that the factory throws while activation is off.

---

## 7. Notification queue audit

### 7.1 Facts

* Models: `Notification` (`schema.prisma:189`) and `NotificationDelivery` (`schema.prisma:1711`); `idempotencyKey @unique`; `UNIQUE(notificationId, channel)`; `INDEX(status, nextRetryAt)`.
* `enqueueNotification()` (`lib/notifications/enqueue.ts:167`) is the only writer; it creates one notification + one delivery atomically, requires `category`, requires a registered `templateKey`, and returns the existing pair on a duplicate key.
* Claim: `claimDueDeliveries()` (`lib/notifications/queue.ts`) selects `QUEUED` rows for allowed channels and CAS-es each one, setting `SENDING`, `attemptCount+1`, `nextRetryAt = now + lease`.
* Lease: Phase 1 reuses `nextRetryAt` as the per-row lease deadline while `SENDING` (decision D2 in `PHASE_1_IMPLEMENTATION_REPORT.md`; no `lockedUntil` column was added).
* Retry: 60 s ±20 % then 5 min ±20 %, then `FAILED`; permanent errors are terminal.
* Ambiguity: expired `SENDING` → `FAILED / AMBIGUOUS_DELIVERY`; never re-queued automatically.
* Dry-run: simulated sends become `SKIPPED / DRY_RUN_SIMULATED`, never `SENT`.
* Legacy isolation: claim query requires `notification.category IS NOT NULL` **and** `templateKey IS NOT NULL`; the worker re-checks after claim.

### 7.2 Fit for Phase 2

**FACT:** The structure supports two independent deliveries per order, because each channel is its own delivery row. The current enqueue API creates **one** channel per call, so Phase 2 should call it twice with channel-specific idempotency keys (e.g. `purchase-proof:{orderNumber}:email:v1` and `…:whatsapp:v1`). This gives independent retry and independent terminal states, which the brief explicitly requires.

**RISK:** If Phase 2 instead extends `enqueueNotification` to accept multiple channels in one call, one channel's constraint failure could prevent the other from being enqueued. Either design is acceptable; the two-call design is simpler and already proven by Phase 1.

### 7.3 Recommendations

* Use `category: "ORDER"` (the proof is a purchase record, not a payment-state change). `PAYMENT` is defensible but would blur the distinction with payment notifications.
* Use `recipientType: "CUSTOMER"`, `eventOrderId`, `eventId`, `organizerId`, `userId` from the order.
* Keep `templateKey = "purchase-proof.v1"` explicit; never render from `payload` without the registry.
* Do **not** change the queue schema. No migration is expected for Phase 2.
* Keep the legacy filter untouched. Do not test against the 44 legacy rows; create test rows with unique keys and clean them up.

---

## 8. Worker audit

### 8.1 Facts

* Standalone process: `scripts/notification-worker.ts`, `npm run worker:notifications` / `-- --once`; no HTTP dependency, no `setInterval`, no in-process SSE.
* Poll loop with `joblock: notification-dispatch`; heartbeat between channel stages; release records `lastRunAt`/`lastStatus`.
* Concurrency: email 3, WhatsApp 1.
* Graceful shutdown: `stop()` waits for the in-flight batch; tests cover “in-flight completes, next row not claimed”.
* Two workers: tested — concurrent batches claim one row exactly once; a held lease yields `LEASE_HELD`.
* Dry-run/real separation: dry-run transports only; the worker throws on an injected `smtp`/`baileys`-kind transport.
* Logging: structured JSON; secret keys redacted; recipients masked; error messages stripped of credentials and email/phone-shaped text.

### 8.2 What Phase 2 must add

1. Real transports instantiated **only** when the activation gate is on; otherwise the existing dry-run pair. The current guard that throws on a live injected transport should remain as defence in depth, but must be conditioned on the gate rather than permanently rejecting all real adapters.
2. Purchase-proof template registration and rendering.
3. A **recovery sweep** for missed enqueues (see §11, R1): scan `PAID` orders older than a small grace window that have no `purchase-proof:*` notification, and enqueue idempotently. This is the only way to recover a post-commit enqueue failure without a new table.
4. Worker-side contact validation and normalisation before calling a transport (email predicate; phone → international digits).
5. Observability fields for activation: transport kind, attempt, outcome code — never recipient, body, session key or credential.

### 8.3 Risks

| # | Risk | Consequence |
|---|---|---|
| R1 | No transaction between settlement commit and enqueue | A crash/DB error between them loses the proof silently |
| R2 | Long single send vs 120 s batch lease | Batch lease may expire; per-row CAS still prevents duplication, and the row lease surfaces ambiguity |
| R3 | WhatsApp socket inside PM2 reload | Must disconnect gracefully; otherwise a reconnect loop on restart |
| R4 | Two workers with one WhatsApp socket | Correctness is protected by the row CAS, but two sockets are prohibited; the session lease must make this explicit |
| R5 | Dry-run logs mistaken for delivery | Logs say `simulated`, status is `SKIPPED`; keep that wording |

---

## 9. Template audit (purchase proof)

### 9.1 Available data (no invention needed)

| Section | Fields |
|---|---|
| Header | `PlatformSetting.platformName` (fallback `TinggalKlik.Co`); store contact pending read model |
| Transaction | `EventOrder.orderNumber`, `paidAt`, `createdAt`, `currency` |
| Buyer | `buyerName` (never echo the full email/phone back in the body unless the owner asks) |
| Items | `EventOrderItem.nameSnapshot`, `quantity`, `priceSnapshot`, `subtotal` |
| Totals | `EventOrder.subtotal`, `discount`, `platformFee`, `picFeeTotal`, `total` |
| Payment | `Payment.method` + `channel` + `status`; human label from `PAYMENT_METHOD_OPTIONS` |
| Event | `Event.title`, `startAt`, `endAt`, `Event.timezone`, `venue.name`, `organizer.name` |
| Reference | `Payment.paymentReference` (optional; useful for support) |

### 9.2 Missing or not ready

| Field | Status | Recommended source |
|---|---|---|
| Store email/phone/address in the proof | Not exposed by `getApplicationSettings()` | Extend a Phase 2 read model over `PlatformSetting.email/phone/address` (no schema change) |
| IDR display formatting | No notification formatter; `moneyString` returns the canonical decimal string used by the API | Add a notification-only formatter (e.g. `Rp 150.000`) |
| Local date/time | `Event.timezone` exists; no notification formatter | Add a formatter with `Asia/Jakarta` fallback |
| Payment method label | Available in `lib/ticketing/payment/method-catalog.ts`, but it is a client-safe module | Use the catalog's `label`; keep it server-side in the renderer |
| Ticket codes / QR | Not available at settlement; issuance is buyer-triggered (`issuance.ts:469`) | Do **not** include in Phase 2 proof; a QR in a chat message is a security regression |
| Tax breakdown | Not modelled | Omit; do not invent |
| Refund policy text | Exists on the site, not as a field | Omit or use approved static copy (owner decision) |

### 9.3 Recommended format

* **Shared renderer** returns `{ subject, text }`; email uses both, WhatsApp uses `text` only.
* **Plain text only**, no HTML, no attachments, no `raw` content; consistent section order: greeting → order number/date → items → totals → payment method/status → event schedule → support contact.
* **Cap the item list** (e.g. first 10 lines + “dan N tiket lainnya”) so a large order cannot produce an unbounded WhatsApp message.
* **Never include** the buyer's full email/phone, internal ids, QR material, provider credentials, or a payment URL that has expired.
* **Wording must not claim delivery.** In dry-run the log/status says simulated; the message itself is only ever sent for real when activation is approved.
* **Version the template** (`purchase-proof.v1`). Changing copy requires a new key only if the *meaning* changes; a cosmetic change can stay in v1, but the queue key must include the template version to avoid mixing.

---

## 10. Recommended integration point

### 10.1 Recommendation

Hook **inside `settleVerifiedPayment()` after the transaction commits**, in the existing post-commit block at `lib/ticketing/payment/settlement.ts:531`, and only when `settled.outcome === "SETTLED"`.

Why this seam:

| Reason | Evidence |
|---|---|
| It is after the commit | `settlement.ts:531` is outside `prisma.$transaction` (transaction ends before `result.value` is inspected) |
| It covers both settlement entry paths | webhook `webhook.ts` → `settleVerifiedPayment`; reconciliation `reconciliation.ts:439` → the same function |
| It has the settled identity (orderNumber/organizer/user) | `readOrderIdentity(input.orderId)` already called there |
| It never runs for no-op outcomes | Only `SETTLED`/`LATE_SETTLEMENT` publish; the hook adds a `SETTLED`-only branch |
| It does not leak PII to provider-facing code | The enqueue helper is in `lib/notifications`, not in the webhook route |

**Do NOT** hook in `webhook.ts` or `issuance.ts`:
* `webhook.ts` is the provider-facing handler; a failure there can make the provider retry and must not be coupled to messaging.
* `issuance.ts` is a buyer-triggered action after payment; proof must exist before/without issuance.
* The Phase 1 static guard explicitly asserts that `webhook.ts`, `issuance.ts` and the checkout route do **not** import `lib/notifications` (`__tests__/notifications/transports.test.ts`, “the request path never imports the notification worker”). `settlement.ts` is not in that list, so the recommended seam keeps the guard green.

### 10.2 Enqueue shape

```
after SETTLED commit:
  enqueuePurchaseProof(orderId)            // new lib/notifications/purchase-proof.ts
    ├── load order + items + event/venue + organizer + settled Payment + PlatformSetting
    ├── build one immutable payload snapshot (money as strings)
    ├── enqueueNotification({ key: `purchase-proof:${orderNumber}:email:v1`,   channel: EMAIL })
    └── enqueueNotification({ key: `purchase-proof:${orderNumber}:whatsapp:v1`, channel: WHATSAPP })
```

* Each channel is attempted independently; a failure in one must not roll back the other.
* The helper must **never throw** into settlement: catch, log a structured error, and rely on the sweep (§8.2/§11 R1).
* Normalise/validate contacts first; missing or invalid channel contact → do not enqueue that channel (or enqueue and let the worker skip; prefer not enqueuing invalid data).
* The payload is a snapshot, not a live read: a later price/name edit must not change a past proof.

### 10.3 Duplicate/edge behaviour to implement

| Situation | Expected |
|---|---|
| Replayed webhook (same event id) | `DUPLICATE`, no settlement, no enqueue |
| Second different event for a paid order | `ALREADY_PAID`, no enqueue |
| Reconciliation finds the same paid order | `ALREADY_SETTLED`, no enqueue |
| Enqueue called twice (retry/sweep) | unique key returns the same row, one delivery |
| Email enqueue fails, WhatsApp succeeds | WhatsApp proof exists; sweep retries email later |
| Worker dead | Order remains PAID; queue rows wait; business flow unaffected |
| Enqueue crashes after commit | Sweep reconstructs from the order and enqueues idempotently |

---

## 11. Security and reliability risks

### 11.1 Security

| # | Risk | Evidence / current control | Required before activation |
|---|---|---|---|
| S1 | Nodemailer High advisories | `nodemailer@8.0.11`; Phase 0C C1; SMTP adapter throws | Owner decision on C1; adapter remains unreachable until then |
| S2 | Auth.js Email provider | `auth.ts` has none | Keep absent; no magic link |
| S3 | SMTP credentials | Only worker env; adapter config excludes password; log redaction | Host env only, rotation, no repo secrets |
| S4 | Baileys account takeover via QR | No QR/pairing code exists; web never renders one | Host-only pairing, file permissions, encrypted backup |
| S5 | Session keys in logs | Structured logger masks secret keys/connection strings | Add explicit tests for Baileys auth state never logged |
| S6 | Buyer PII in messages/logs | Queue holds recipient; logs mask it | Do not echo full contact in body; do not log payload |
| S7 | QR/e-ticket leakage through proof | No ticket data at settlement | Do not include QR; ticket wallet remains authenticated |
| S8 | Enqueue in a payment transaction | Recommended seam is post-commit | Keep it out of `$transaction` |
| S9 | Provider error leaking a connection string | `sanitizeErrorMessage()` strips `scheme://user:pass@` and emails/phones | Reuse it for every stored error |
| S10 | Webhook failure caused by messaging | Not wired into the webhook | Keep enqueue non-throwing and post-commit |

### 11.2 Reliability

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R1 | **Post-commit enqueue is not transactional with settlement** | A crash/DB failure loses the proof with no retry | Best-effort enqueue + idempotent **sweep** over paid orders; never throw into settlement |
| R2 | Enqueue failure turns into a 500 and the provider retries | Retry settles as `ALREADY_PAID`, so a SETTLED-only hook would not re-enqueue | Same sweep; plus explicit non-throwing enqueue |
| R3 | Phone format | WhatsApp cannot address `08…`/spaced numbers | Normalizer + invalid → `SKIPPED` |
| R4 | Null/stale buyer contact | Channel fails permanently | Validate at enqueue and again at send; skip terminal |
| R5 | Two channels, one slow | One blocks the other | Separate rows, separate claims; WhatsApp concurrency 1 |
| R6 | Ambiguous send | Possible duplicate if blindly retried | Phase 1 policy: `FAILED / AMBIGUOUS_DELIVERY`, no auto-retry |
| R7 | Worker restart during batch | Row stuck `SENDING` until lease expiry | Lease recovery marks ambiguous; operator decides |
| R8 | Batch lease (120 s) shorter than a slow send | Batch lease may expire while one send runs | Per-row CAS still correct; consider a larger batch lease when SMTP is activated |
| R9 | No delivery-status UI | Operators cannot see failures from the app | Phase 2 can log/read-only; UI is later |
| R10 | No per-recipient rate limit | WhatsApp ban risk | One-at-a-time + delay + cap (activation gate) |

### 11.3 Unverified in this environment

* Actual provider acceptance, deliverability, spam placement, and SMTP identity reputation.
* Baileys behaviour against a live WhatsApp account (no pairing allowed); reconnect/logout semantics are documented but not measured here.
* Whether the production host has SMTP egress or a WhatsApp-capable network path.
* Whether the owner wants proof for reconciled settlements (the recommended seam would include them).
* Production store contact values in `PlatformSetting` (the row may be absent; `app-settings.ts` has fallbacks).

---

## 12. Test matrix

All tests must remain **no-real-send**: dry-run transports, stubbed provider sockets, or source-level guards. Database tests use the isolated `tinggalklik_test` schema only.

| # | Scenario | Expected result | Level |
|---|---|---|---|
| T1 | Successful payment (`SETTLED`) | 2 queue rows (EMAIL, WHATSAPP), delivery `QUEUED`; after dry-run batch both `SKIPPED / DRY_RUN_SIMULATED` | Integration |
| T2 | Unpaid order | No enqueue; no delivery rows | Integration |
| T3 | Failed payment (`ORDER_FAILED`) | No proof; order cancelled; no enqueue | Integration |
| T4 | Cancelled order (before payment) | No proof | Integration |
| T5 | Late settlement | No proof; `fulfilmentBlockedAt` set; operator alert only | Integration |
| T6 | COD attempt | Payment creation rejected; no proof path | Existing integration + no new test needed |
| T7 | Duplicate payment event (same `providerEventId`) | `DUPLICATE`; one set of queue rows only | Integration |
| T8 | Second different event for a paid order | `ALREADY_PAID`; no second enqueue | Integration |
| T9 | Duplicate enqueue (same key) | Same notification/delivery ids; `created:false`; counts remain 1 | Unit/DB |
| T10 | Invalid email | Email channel skipped/not enqueued; WhatsApp unaffected | Unit |
| T11 | Invalid phone (`abc`, too short, >15 digits) | WhatsApp channel skipped; email unaffected | Unit |
| T12 | `08…` phone | Normalised to `62…`; WhatsApp delivery proceeds (dry-run) | Unit |
| T13 | SMTP failure (simulated `nodemailer` reject) | Retry scheduled with backoff; `errorMessage` sanitised; no credentials | Unit |
| T14 | SMTP permanent reject | `FAILED` terminal; no infinite retry | Unit |
| T15 | Baileys disconnect mid-send | Lease expires → `FAILED / AMBIGUOUS_DELIVERY`; not auto-resent | Integration/unit |
| T16 | Baileys logout | Adapter/worker stops; no reconnect loop; state visible | Unit (no live socket) |
| T17 | Retry after failure | Not claimed before `nextRetryAt`; claimed after; `attemptCount` increments | Existing Phase 1 pattern |
| T18 | Worker restart during batch | Row recovered as ambiguous; no duplicate send | Integration |
| T19 | Two workers concurrently | One claim per delivery; WhatsApp/Email independent | Existing Phase 1 pattern |
| T20 | One channel fails, other succeeds | Independent statuses; no cross-coupling | Integration |
| T21 | Legacy `category IS NULL` rows (44) | Never claimed; counts unchanged | Existing guard + regression |
| T22 | Notification activation OFF | Worker claims nothing; no provider touched | Existing Phase 1 pattern |
| T23 | Enqueue failure after commit | Settlement stays committed; sweep later enqueues idempotently | Integration (new) |
| T24 | Static no-provider guard | No top-level `nodemailer`/Baileys import in the foundation; adapters throw while inactive | Source-level |

---

## 13. Blockers

| ID | Blocker | Type | Effect |
|---|---|---|---|
| **B1** | nodemailer 8.0.11 High advisories; upgrade breaks the Auth.js peer range | Owner decision (C1) | SMTP cannot be activated; Phase 2 implementation stays dry-run |
| **B2** | Baileys activation (pairing, host session, number reputation, ToS/ban) | Owner activation (C4) | WhatsApp cannot send; adapter stays unreachable |
| **B3** | No phone normalisation to international format anywhere | Implementation gap | WhatsApp addresses would be invalid for Indonesian local numbers |
| **B4** | No post-commit enqueue recovery | Implementation gap | A crash/DB error can silently lose a proof |
| **B5** | Buyer email/phone nullable in schema | Data-shape risk | Must skip/handle missing contacts; no schema change required |
| **B6** | No approved purchase-proof copy/template | Owner/content decision | Message cannot be finalised |
| **B7** | `PlatformSetting` contact fields have no public read model | Implementation gap | Store contact section cannot be filled consistently |
| **B8** | Phase 1 static guard forbids `lib/notifications` in `webhook.ts`/`issuance.ts` | Constraint | Use `settlement.ts` as the seam; do not wire provider-facing files |
| **B9** | No delivery-status read surface | Scope limitation | Failures visible only in DB/logs until a later phase |

**No blocker prevents writing Phase 2 code in dry-run**, except B6 (final copy) and B3/B4/B7, which must be solved in that implementation.

---

## 14. Files that will need to change later

| File | Planned change |
|---|---|
| `lib/notifications/templates.ts` | Register `purchase-proof.v1`; shared plain-text renderer |
| `lib/notifications/purchase-proof.ts` (new) | Load order snapshot, validate/normalise contacts, enqueue both channels idempotently |
| `lib/notifications/phone.ts` (new) | E.164/Indonesian normalisation + validation |
| `lib/notifications/transports/smtp.ts` | Real nodemailer adapter behind the activation gate; lazy import; still throws while inactive |
| `lib/notifications/transports/baileys.ts` | Real Baileys adapter behind the activation gate; lazy import; still throws while inactive |
| `lib/notifications/config.ts` | Activation-gate plumbing; **keep the dry-run clamp until owner approval** |
| `lib/notifications/worker.ts` | Instantiate live transports only when the gate is on; keep defence-in-depth refusal otherwise |
| `lib/notifications/transports/dry-run.ts` | Possibly nothing; used by tests and pre-activation |
| `lib/ticketing/payment/settlement.ts` | `SETTLED`-only, post-commit, non-throwing hook to `enqueuePurchaseProof` |
| `lib/app-settings.ts` or `lib/notifications/store-info.ts` | Read `PlatformSetting.email/phone/address` for the message footer |
| `lib/notifications/worker.ts` or a sweep module | Idempotent backfill for paid orders without a proof row |
| `__tests__/notifications/*` | New tests for template, normalisation, trigger, sweep, adapters, independence |
| `__tests__/ticketing-payment/*` | Trigger tests; ensure the existing guard on payment files stays green (no direct provider imports) |
| `.env.example` | Only if a new non-secret setting is introduced; no new secret placeholders beyond the existing commented SMTP/WA block |
| `docs/PHASE_2_IMPLEMENTATION_REPORT.md` | Written after implementation (not now) |

**No migration file is expected.** The queue and order data already exist.

**Guard tests to respect (not weaken):**
* `__tests__/notifications/transports.test.ts` — “the request path never imports the notification worker” (webhook/issuance/checkout route).
* `__tests__/ticketing-payment/payment-wiring.test.ts:533` — no `whatsapp|baileys|nodemailer` or `prisma.notification.create` in any `lib/ticketing/payment/*.ts`; no buyer PII in audit payloads.
* `__tests__/ticketing-issuance/issuance-wiring.test.ts:437` — same for the ticket modules.

---

## 15. Recommended implementation order

1. **Contact layer** — email predicate + phone normaliser, pure, fully tested (T10/T11/T12).
2. **Template** — `purchase-proof.v1` renderer from a snapshot; no DB read inside the renderer; tests for escaping, line caps, money/date formatting.
3. **Snapshot/enqueue helper** — `enqueuePurchaseProof(orderId)`; per-channel keys; never throws; tests for T9/T20/T23.
4. **Trigger** — one `SETTLED`-only call in `settlement.ts` after commit; tests for T1–T8/T18.
5. **Sweep** — idempotent recovery for paid orders with no proof row; tests T23.
6. **Store-info read model** — platform contact footer; tests for absent row/fallbacks.
7. **Adapters (inactive)** — SMTP + Baileys real code behind a closed gate; lazy imports; tests that both still throw/skip while inactive and that no socket/QR is created.
8. **Worker wiring** — select transports by gate; keep dry-run default; tests T13–T19/T22/T24.
9. **Full verification** — typecheck, lint, build, targeted Jest, Phase 1 regression.

Steps 1–6 can be implemented and merged in dry-run without any activation decision. Steps 7–8 can be coded but must remain unreachable until B1/B2 are approved.

---

## 16. Decisions still requiring owner approval

| # | Decision | Why it matters |
|---|---|---|
| D1 | When SMTP activation happens (C1 path) | Blocks real email; nodemailer advisory trade-off |
| D2 | Baileys activation, pairing host/number, session backup policy | Blocks real WhatsApp; account/ban risk |
| D3 | Final purchase-proof copy, tone, language, branding, subject line | Cannot finalise template |
| D4 | Whether reconciled settlements also send proof | Recommended seam would; confirm product behaviour |
| D5 | Whether proof is sent for `LATE_SETTLEMENT` | Recommendation: **no**; confirm |
| D6 | Whether ticket codes/e-tickets are part of the proof | Recommendation: **no QR**; ticket delivery remains the wallet |
| D7 | Store contact details to print (platform email/phone/address) | Source row may be empty |
| D8 | WhatsApp daily cap / messaging window / rate policy | Ban-risk policy |
| D9 | Data retention for message bodies/payload snapshots | PII retention; queue currently stores payload |
| D10 | Whether a preference/opt-out model is required | No preference table exists; transactional proof is normally exempt |

---

## 17. Final verdict

# CONDITIONAL GO

**Conditions (all must hold before activation):**

1. **Dry-run only until explicit approval.** `NOTIFICATIONS_ENABLED` stays OFF by default; SMTP and Baileys remain unreachable; no real email/WhatsApp in implementation or tests.
2. **C1 resolved** for nodemailer/SMTP activation, without forcing the Auth.js peer range.
3. **C4 operational plan** for Baileys: host-only pairing, session permissions/backup, reconnect/logout policy, one socket, rate limits.
4. **Phone normalisation + email validation** implemented server-side, with terminal skips for invalid contacts.
5. **Post-commit enqueue is non-throwing and recoverable** (idempotent sweep); settlement must never depend on messaging success.
6. **Approved template copy** (`purchase-proof.v1`) and store-contact read model.
7. **Trigger is `SETTLED` only**, placed after commit in `settlement.ts`; no enqueue in the webhook or issuance modules.
8. **All listed tests pass in dry-run**, including the legacy 44-row isolation and two-worker/ambiguity cases.

**NO-GO triggers:** any request to send real messages during implementation; any request to enable Auth.js Email provider; any attempt to add a queue table or migration without owner approval; any attempt to render a pairing QR in a web route.

---

## Appendix A — Evidence index

| Subject | Path / symbol |
|---|---|
| Settlement engine | `lib/ticketing/payment/settlement.ts:282` `settleVerifiedPayment`; transaction at `:287`; post-commit publish at `:531` |
| Webhook | `lib/ticketing/payment/webhook.ts` `handleGatewayWebhook`, `claimLedgerRow`, `applySettlementOutcome` |
| Reconciliation | `lib/ticketing/payment/reconciliation.ts:439` |
| Webhook route | `app/api/ticketing/payment/webhook/route.ts` |
| Order/payment schema | `prisma/schema.prisma:1060` `EventOrder`; `:1262` `Payment`; `:1129` `EventOrderItem`; `:468` `OrderStatus`; `:478` `PaymentStatus`; `:493` `PaymentMethod` |
| Notification schema | `prisma/schema.prisma:189` `Notification`; `:1711` `NotificationDelivery`; `:1780` `JobLock` |
| Checkout validation | `lib/ticketing/checkout-validation.ts` `emailSchema`, `phoneSchema`, `checkoutRequestSchema` |
| Order projection | `lib/ticketing/order-payload.ts` `ORDER_PAYLOAD_SELECT`, `OrderPayload`, `moneyString` |
| Issuance | `lib/ticketing/tickets/issuance.ts:469` `issueTicketsForOrder`; `:610` `publishTicketIssued` |
| Payment method catalog | `lib/ticketing/payment/method-catalog.ts:48-52` (COD not offered) |
| COD rejection test | `__tests__/ticketing-payment/payment-creation.integration.test.ts:244-248` |
| Phase 1 config clamp | `lib/notifications/config.ts` `PHASE_1_DRY_RUN_ONLY`, `resolveNotificationConfig` |
| Phase 1 SMTP skeleton | `lib/notifications/transports/smtp.ts` `createSmtpEmailTransport` |
| Phase 1 Baileys skeleton | `lib/notifications/transports/baileys.ts` `createBaileysWhatsAppTransport` |
| Phase 1 templates | `lib/notifications/templates.ts` (`phase1.dry-run.v1` only) |
| Phase 1 enqueue | `lib/notifications/enqueue.ts:167` |
| Phase 1 queue | `lib/notifications/queue.ts` claim/retry/recovery |
| Phase 1 worker | `lib/notifications/worker.ts`; `scripts/notification-worker.ts` |
| Phase 1 guard | `__tests__/notifications/transports.test.ts` (“the request path never imports the notification worker”) |
| Payment guard | `__tests__/ticketing-payment/payment-wiring.test.ts:533` |
| Issuance guard | `__tests__/ticketing-issuance/issuance-wiring.test.ts:437` |
| Settings | `lib/app-settings.ts` (`PlatformSetting` read model); `lib/store-settings.ts` (legacy retail) |

## Appendix B — Commands and outputs recorded

```
npx jest __tests__/notifications --runInBand --silent
  → 4 suites passed, 51 tests passed, exit 0

npx prisma migrate status
  → 32 migrations found; Database schema is up to date! exit 0

git status --porcelain prisma/migrations
  → (empty)

node -p require('nodemailer/package.json').version
  → 8.0.11

node -p JSON.stringify(require('@whiskeysockets/baileys/package.json').engines)
  → {"node":">=20.0.0"}

node -p JSON.stringify(require('@auth/core/package.json').peerDependencies)
  → {"…":"…","nodemailer":"^7.0.7 || ^8.0.5"}
```

No SMTP connection, SMTP authentication, Baileys socket, QR generation, pairing, session write, real message, migration, DDL/DML, commit, push, deploy, reset, rebase or stash was performed during this audit.

**STOP.** Phase 2 is not implemented. Awaiting owner review and approval.
