# PHASE 2 — D-46 FINAL DECISION & READINESS AUDIT

**Project:** TinggalKlik.Co
**Repository:** `/home/reksa/tinggalklik`
**Audit date:** 6 November 2026
**Mode:** READ-ONLY audit. No source, test, schema, migration, environment, provider, or Git mutation.
**Reference documents:** `docs/PHASE_2_PRE_IMPLEMENTATION_AUDIT.md`, `docs/PHASE_2_IMPLEMENTATION_REPORT.md`, `docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_AUDIT.md`, `docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_IMPLEMENTATION_REPORT.md`

---

## 1. Owner Decision — FINAL

**D-46: APPROVED — OPTION A (`code_link`).**

The owner explicitly authorizes, for ticket-issued notifications only:

| # | Authorized element | Status in this audit |
|---|---|---|
| 1 | Public ticket codes sent directly by email | **MATCHES** |
| 2 | Public ticket codes sent directly by WhatsApp | **MATCHES** |
| 3 | Authenticated ticket wallet URL included | **MATCHES** |
| 4 | Maximum 20 ticket codes per notification | **MATCHES** |
| 5 | No QR image and no QR attachment | **MATCHES** |

This decision authorizes the **ticket-code exposure policy only**. It does **not** authorize SMTP or Baileys activation, provider credentials, or any real message delivery. Those remain separate, unapproved decisions.

**Decision-record note.** The repository already used the identifier `D-46` for a different question — wallet QR *display* mechanism (short-lived display token vs server-rendered image), closed by `P14-D17` as `TICKET:<ticketCode>` with `MANUAL` admission (`PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §35, `TICKETING_PHASE1_DESIGN.md` §26.7). This report uses **D-46 Option A** in the owner's current sense: the **notification** ticket-code exposure policy. Both readings are compatible, but the identifier is overloaded; the owner may wish to disambiguate it in the decision register. This is a documentation risk, not an implementation conflict.

---

## 2. Executive Summary

The existing Phase 2 implementation **already matches D-46 Option A** in source and in its static guards. The public `EVT-XXXX-XXXX` code list and the authenticated wallet URL are rendered by one shared template for both email and WhatsApp; the printed list is hard-capped at 20; no QR image, attachment, `TICKET:` payload, `qrTokenHash`, or raw scanner token is selected, rendered, or logged.

The implementation is **not ready to deliver**, because the owner has not authorized provider activation: SMTP and Baileys remain fail-closed stubs, the worker only instantiates dry-run transports, and `PHASE_1_DRY_RUN_ONLY` is a compile-time `true`. Several operational gaps also remain (no scheduler for the recovery sweep, a 30-minute window that also gates legitimate late issuance, no delivery-status surface, uncommitted work).

Historical evidence records 68 ticket-notification tests and a 3,628-test full suite passing. This audit did **not** rerun Jest, because every matched suite initializes the test database and its teardown deletes rows; the audit locks forbid database mutation. The read-only checks rerun here (`tsc`, `prisma validate`, `prisma migrate status`) pass.

**Verdict: PASS WITH LIMITATIONS** — the decision matches the implementation, but production readiness is gated on provider activation and the operational items in §10.

---

## 3. Repository and Git State

Measured at audit time with read-only commands.

| Check | Result |
|---|---|
| Repository root | `/home/reksa/tinggalklik` |
| Branch | `main` |
| HEAD | `25cbf0c6893f79292be4580a056003c54753ff12` — `fix landing paaage` |
| Recent history | `25cbf0c`, `05bb474 revisi flow checkout`, `22bd4de fix ui navbar1`, `22006bb fix ui navbar`, `23f4faf fix redirect dashboatd2` |
| Stashes | none |
| Modified tracked files | **15** |
| Untracked entries | **17** (including `lib/notifications/`, `docs/`, `__tests__/notifications/`) |
| Phase 2 feature code committed? | **No.** `lib/notifications/` is untracked; `lib/ticketing/tickets/issuance.ts` and `lib/ticketing/payment/settlement.ts` are modified but uncommitted |
| Diff size of the two integration points | `settlement.ts` +26, `issuance.ts` +5 (31 insertions, 0 deletions) |
| Working tree changed by this audit | **No** |

Modified tracked paths:

```
.env.example
__tests__/support/fixture-teardown.ts
__tests__/support/global-setup.ts
__tests__/support/test-database.ts
jest.config.js
jest.setup-env.ts
jest.teardown-env.ts
lib/app-origin.ts
lib/authz/permissions.ts
lib/ticketing/payment/settlement.ts
lib/ticketing/tickets/issuance.ts
package-lock.json
package.json
prisma/schema.prisma
scripts/setup-test-db.ts
```

Untracked paths:

```
.cloud-attachments/
PHASE_0A_JEST_DATABASE_ISOLATION_REPORT.md
PHASE_0B_PAYMENT_MIGRATION_REPORT.md
PHASE_0C_DEPENDENCY_VULNERABILITY_REPORT.md
PHASE_1_IMPLEMENTATION_REPORT.md
PHASE_1_PRE_IMPLEMENTATION_AUDIT_REPORT.md
PROJECT_PRE_FEATURE_AUDIT_REPORT.md
__tests__/notifications/
__tests__/support/test-database.prisma-guard.test.ts
__tests__/support/test-database.safety.test.ts
__tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts
docs/
jest.safety.config.js
lib/notifications/
scripts/notification-worker.ts
scripts/purchase-proof-sweep.ts
scripts/ticket-issued-sweep.ts
```

**Finding (readiness, not correctness):** the entire Phase 2 feature is an uncommitted working-tree change. It has no release baseline, is not reviewable as a diff against `main` by a second party, and can be lost by a careless checkout. The audit was forbidden to commit, so this remains an owner/operator action.

The pre-existing `prisma/schema.prisma` modification is Phase 1's client-side mapping of the legacy `notificationType` column; this audit did not touch it and found no Phase 2 schema change.

---

## 4. Scope of Inspection

Read in full or at the relevant sections:

| Area | Files / symbols |
|---|---|
| Owner/Phase 2 reports | `docs/PHASE_2_*.md` (4 documents) |
| Ticket notification helper | `lib/notifications/ticket-issued.ts` |
| Ticket template | `lib/notifications/ticket-issued-template.ts` |
| Template registry | `lib/notifications/templates.ts` |
| Configuration / kill switch | `lib/notifications/config.ts` |
| Worker | `lib/notifications/worker.ts`, `scripts/notification-worker.ts` |
| Transports | `lib/notifications/transports/smtp.ts`, `.../baileys.ts`, `lib/notifications/types.ts` |
| Integration points | `lib/ticketing/tickets/issuance.ts`, `lib/ticketing/payment/settlement.ts` |
| Public code and QR contract | `lib/ticketing/tickets/reference.ts` |
| Origin / wallet | `lib/app-origin.ts`, `app/ticketing/tickets/page.tsx` |
| Guards/tests | `__tests__/notifications/ticket-issued-*.test.ts`, `purchase-proof-wiring.test.ts`, `__tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts` |
| Config/ops surface | `package.json`, `.env.example`, `jest.config.js` |

---

## 5. Source-Level Verification Against D-46 Option A

### 5.1 Rendering path

`lib/notifications/ticket-issued.ts` is a post-commit **enqueue-only** helper. It never sends, claims a delivery, or touches a transport.

```
issueTicketsForOrder() transaction commits
  → if (created.length > 0)
      publishTicketIssued()            (existing)
      writeTicketingAudit()            (existing)
      enqueueTicketIssued(order.id)    (Phase 2 addition, non-throwing)
```

Evidence: `lib/ticketing/tickets/issuance.ts` imports `enqueueTicketIssued` once and calls it once at line 644, inside the `created.length > 0` branch, after the transaction has resolved (`const { created, tickets } = dispatched.value`). The static guard asserts the call is inside that branch and after `writeTicketingAudit`.

`enqueueTicketIssued()`:

1. loads a narrow order projection (event, venue, buyer contact, `ISSUED` tickets);
2. refuses non-`PAID` orders, `CANCELLED`/`ARCHIVED` events, closed windows, and orders with no valid issued code;
3. builds one immutable payload snapshot;
4. resolves the wallet URL;
5. enqueues `EMAIL` and `WHATSAPP` sequentially with independent keys.

### 5.2 Element-by-element match

| D-46 Option A element | Implementation evidence | Result |
|---|---|---|
| Public ticket codes by email | One payload rendered by `renderTicketIssued`; `enqueueNotification({ channel: "EMAIL", templateKey: "ticket-issued.v1" })` | **MATCHES** |
| Public ticket codes by WhatsApp | Same payload and renderer; second independent `enqueueNotification({ channel: "WHATSAPP" })` | **MATCHES** |
| Authenticated wallet URL | `walletUrlForTicketNotification()` builds `${origin}/ticketing/tickets` from `getConfiguredAppOrigin()` only; template prints it after validating `http`/`https`; wallet page redirects unauthenticated users to login and reads through the ownership-scoped `listOwnTickets` | **MATCHES** |
| Max 20 codes per notification | `const MAX_TICKETS = 20`; `const shown = codes.slice(0, MAX_TICKETS)`; beyond 20 prints a factual "all tickets are in Tiket Saya" line, no omitted count and no truncated pseudo-code | **MATCHES** |
| No QR image / attachment | Transport contract `OutboundEmail = { to, subject, text }` and `OutboundWhatsApp = { to, text }` has no attachment/media field; template imports no `qrcode`; no `attachments:`, no `TICKET:`, no `buildTicketQrPayload`; no route was added | **MATCHES** |

### 5.3 Code selection and allow-list

`ORDER_SELECT` selects `tickets: { where: { status: "ISSUED" }, select: { ticketCode: true } }`, ordered deterministically by `(orderItemId asc, sequenceNo asc)`.

Both the helper and the renderer re-filter with `isTicketCode()` (`/^EVT-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/`). Therefore malformed values, duplicates, and anything not shaped as a public code are discarded, not repaired or truncated. `VOID`, `REFUNDED`, and `CHECKED_IN` rows are excluded by the `status: "ISSUED"` predicate.

The message identifies the order (`Nomor transaksi`), event, schedule, location, count, numbered codes, wallet link, entry instruction, privacy warning, and optional store contact. No internal database ID, payment URL, or provider data is present.

### 5.4 Wallet URL condition

The URL is emitted only when `NEXT_PUBLIC_APP_URL` is set to an `http(s)` origin. When absent, the template prints an instruction to open Tiket Saya instead of inventing a URL. This is fail-safe, but it means D-46's "include the authenticated wallet URL" is satisfied **only on a deployment that configures the origin** — which payments already require. This is a deployment prerequisite, not a code defect.

The page `/ticketing/tickets` is the existing authenticated wallet: it calls `getAuthzScope()` and redirects to login when there is no scope; its data path is `listOwnTickets` with `holderUserId = session.user.id`. No public ticket or QR route was added, and a static guard asserts the absence of `app/api/ticketing/ticket-issued`, `.../tickets/qr`, and `.../tickets/[ticketCode]/qr`.

---

## 6. Scanner Credential and Logging Exclusion

| Check | Evidence | Result |
|---|---|---|
| `qrTokenHash` never selected | `ORDER_SELECT` selects only `ticketCode`; static guard asserts `ticketCode: true` and rejects `qrTokenHash: true` / `qrToken: true` | **PASS** |
| Raw scanner token never generated/read | Helper does not import or call `generateQrToken`; the token is generated only at issuance and never stored in plaintext | **PASS** |
| QR payload not rendered | Template has no `TICKET:`, `buildTicketQrPayload`, `qrcode`, or attachment path | **PASS** |
| Logs free of codes/recipients/bodies | Every `structuredLog` block in the helper carries only order number, channel, outcome, error code, and sanitized message; a static test scans all blocks for `ticketCode`, `tickets`, `recipient`, `payload`, `body`, `text` | **PASS** |
| Payload free of internal IDs/secrets | Payload type contains order number, event fields, `ticketCount`, `tickets[{ticketCode}]`, `walletUrl`, store contact — no DB id, no token, no hash, no payment URL | **PASS** |

The scanner secret is therefore outside the D-46 exposure surface. The **public** code remains the admission credential accepted by the current manual check-in gate; D-46 Option A expressly accepts that exposure. It is a product/security acceptance, not a coding bug.

---

## 7. Idempotency and Channel Independence

Keys, built by `ticketIssuedIdempotencyKey(orderNumber, channel)`:

```
ticket-issued:{orderNumber}:email:v1
ticket-issued:{orderNumber}:whatsapp:v1
```

| Layer | Guarantee |
|---|---|
| `Notification.idempotencyKey @unique` | Replay converges on the existing notification row |
| `UNIQUE(notificationId, channel)` | One delivery per channel per notification |
| Separate keys per channel | An email replay cannot suppress or duplicate WhatsApp, and vice versa |
| `enqueueNotification()` duplicate path | Repairs a notification left without its delivery row |
| Issuance `ALREADY_ISSUED` path | Never enters the `created.length > 0` branch, so no second enqueue |
| Sweep | Re-calls the same helper with the same keys; per-channel `notifications.none` clauses repair only the missing channel |

The helper catches a per-channel failure and returns `"failed"`; the other channel still runs, and the function as a whole never throws. The issuance call site does not check the result, so a queue failure cannot change a committed issuance or the issue route's status code.

---

## 8. Dry-Run Enforcement and Provider Activation Status

| Control | Verified state |
|---|---|
| `PHASE_1_DRY_RUN_ONLY` | `true` — compile-time constant in `lib/notifications/config.ts`, not an environment variable |
| Effective transports | `resolveNotificationConfig()` can only return `disabled` or `dry-run`; `EMAIL_TRANSPORT=smtp` and `WHATSAPP_TRANSPORT=baileys` are recorded as refusals and downgraded |
| SMTP adapter | `createSmtpEmailTransport()` always throws `Phase1TransportRefusedError`; no `nodemailer` import |
| Baileys adapter | `createBaileysWhatsAppTransport()` always throws `Phase1WhatsAppRefusedError`; no Baileys import, no socket, no session directory, no QR |
| Worker | Uses only `createDryRunEmailTransport()` / `createDryRunWhatsAppTransport()` by default; throws if an injected transport reports `kind: "smtp"` or `kind: "baileys"` |
| Simulated outcome | Written as `SKIPPED / DRY_RUN_SIMULATED` with `providerMessageId = null`; never `SENT` |
| `.env.example` | `NOTIFICATIONS_ENABLED="false"`, `EMAIL_TRANSPORT="dry-run"`, `WHATSAPP_TRANSPORT="dry-run"` |
| Local `.env` | **NOT VERIFIED** — environment files are not readable under this audit's tool policy. This does not weaken the effective state: the code clamp and throwing adapters make a live send impossible even if the flag were `"true"` |
| Auth.js Email provider | Absent (`auth.ts` has Google + Credentials only) — unchanged |

**Provider activation status: INACTIVE / DRY-RUN ONLY.** No SMTP connection, authentication, Baileys pairing, session, socket, QR, or message transmission exists in the implementation. D-46 Option A did not and cannot change this.

---

## 9. Test Evidence

### 9.1 Newly executed in this audit (read-only)

| Command | Result |
|---|---|
| `git rev-parse --show-toplevel`, `--abbrev-ref HEAD`, `rev-parse HEAD`, `git log -5`, `git status --porcelain`, `git stash list` | exit 0; state recorded in §3 |
| `npx tsc --noEmit --incremental false` | **exit 0** |
| `npx prisma validate` | **exit 0** — schema valid |
| `npx prisma migrate status` | **exit 0** — 32 migrations, "Database schema is up to date!" |
| Source and guard inspection (read-only) | Completed; findings in §5–§8 |

`--incremental false` was used so the typecheck wrote no build artifact. `git status` after these checks is identical to the recorded working tree.

### 9.2 Historical evidence (recorded in the Phase 2 reports; **not rerun**)

| Evidence | Recorded result | Why not rerun |
|---|---|---|
| `ticket-issued-template` + `ticket-issued-wiring` + `purchase-proof-wiring` | 3 suites, **36 tests passed** | Static suites still invoke Jest global setup/teardown, which connects to and cleans the test database — a DB write the audit locks forbid |
| `ticket-issued-worker` + `ticket-issued.integration` + `ticket-issued-hook.integration` | 3 suites, **32 tests passed** | Database-backed; writes fixtures and cleans up |
| Full suite `npm test` | **172 suites / 3,628 tests passed**, 2 snapshots, ~236 s | Same reason |
| `npx tsc --noEmit` | exit 0 (after fixing untyped mocks in the new worker test) | Replaced by the read-only rerun above |
| `npm run lint` | exit 0, 4 pre-existing warnings, none in Phase 2 files | Not rerun |
| `npm run build` | exit 0 | Not rerun (writes `.next`) |

**Classification:** historical results are credible but are not independent verification of the current tree. The tree has not changed since those runs by any evidence found, and the typecheck rerun is clean, but the full suite remains **NOT VERIFIED for this audit**.

### 9.3 Coverage relevant to D-46 (from the guard/test inventory)

- At most 20 codes printed; 25-ticket order prints 20 plus the wallet note.
- Malformed, duplicate, `VOID`, `REFUNDED`, and `CHECKED_IN` codes are not printed.
- Independent email/WhatsApp keys; replay reuses rows; email-only and WhatsApp-only partial states repaired.
- Ticket notification and purchase proof remain independent.
- Sweep window: 120 s grace, `endAt + 30 min` inclusive boundary, `CANCELLED`/`ARCHIVED` skipped, no-issued-ticket skipped, batch cap respected, legacy row untouched, one order's failure isolated.
- Worker: TICKET row simulated (never `SENT`), invalid recipient terminal skip, legacy `category NULL` never claimed, WhatsApp cap defers, no code/recipient/body logged.
- Static: single post-commit call; no worker/transport/provider import in issuance; trusted origin only; no `qrTokenHash` selection; no image/attachment/`TICKET:`; no new route; no migration.

---

## 10. Remaining Blockers and Operational Risks

### 10.1 Activation blockers (unchanged by D-46)

| ID | Blocker | Effect |
|---|---|---|
| **B1** | `nodemailer@8.0.11` carries High advisories; upgrading to ≥10 breaks the `@auth/core` peer range (`^7.0.7 \|\| ^8.0.5`), and `--force`/overrides are forbidden | SMTP cannot be activated without an owner decision on the advisory trade-off |
| **B2** | Baileys is an unofficial client: pairing is full account control, with ban/ToS risk; it needs a host-only session, one socket, reconnect/logout policy, and a rate policy | WhatsApp cannot be activated; adapter remains unreachable |
| **B3** | No real-delivery evidence exists: no SMTP handshake, no WhatsApp pairing, no client rendering, no spam/reputation test | Deliverability and message rendering are unproven |
| **B4** | `NEXT_PUBLIC_APP_URL` must be a real public origin for the wallet link to appear | A misconfigured deployment silently omits the D-46 wallet URL |

### 10.2 Operational risks

| # | Risk | Consequence | Current mitigation |
|---|---|---|---|
| R1 | **Recovery is manual.** No cron, PM2 app, or scheduler calls `sweep:ticket-issued` | A post-commit enqueue lost after the window stays lost | Operator command documented; idempotent and safe to repeat |
| R2 | **The 30-minute window gates the issuance hook itself**, not only recovery | A legitimate issuance more than 30 minutes after `endAt` enqueues nothing | Deliberate single policy; still an owner decision |
| R3 | **`endAt = null` produces no ticket notification** | Events without an end time never notify | Fail-safe refusal (`END_AT_UNKNOWN`); owner decision needed |
| R4 | **No delivery-status surface** | Failed/skipped sends are visible only in DB/logs; support cannot see them in the app | Structured logs only; UI deferred |
| R5 | **Codes cannot be rotated or revoked in the message** | A forwarded code remains usable until check-in/void; the message cannot promise otherwise | Template makes no revocation claim; `VOID`/`REFUNDED` blocks admission |
| R6 | **Public code is the manual admission credential** | First holder can attempt admission; messaging widens the audience | D-46 Option A accepts this; privacy copy and no code logging |
| R7 | **Uncommitted baseline** | No reviewable diff, no rollback point; loss risk | This audit could not commit; owner action |
| R8 | **Store contact may be absent** | Footer section is omitted rather than invented | Correct fail-safe, but copy may be incomplete |
| R9 | **Scaffolding is not wired into PM2** | The worker is not running anywhere; queue rows would wait | Deliberate; starting a process is an operator/owner action |
| R10 | **Decision-ID collision** (`D-46` used for two different questions) | Future readers may misapply the approval | Documented here; recommend registering `D-46` as "notification ticket-code exposure" and renaming the wallet-QR item |

### 10.3 What is explicitly **not** a risk

- No QR image, attachment, media transport, or `TICKET:` payload is created or claimed.
- No `qrTokenHash` or raw scanner token is selected, rendered, or logged.
- No schema change or migration was introduced by Phase 2.
- No request path (webhook, checkout, issue route) imports the notification helper; the settlement and issuance paths are the only callers, both post-commit and non-throwing.
- No real email or WhatsApp message has been sent by any Phase 2 code path.

---

## 11. Roadmap — Exact Phase Names and Statuses

**Finding:** there is **no single file named `ROADMAP`** and no dedicated canonical phase-status register in the repository. Three separate roadmaps exist, and they use different numbering. Per instruction, none is completed or renamed by inference.

### 11.1 Design roadmap — `TICKETING_PHASE1_DESIGN.md` §40.11, "Roadmap after Phase 2 (dependency-ordered)"

Exact objectives as written:

| Phase | Title / objective (verbatim) | Status in this repository |
|---|---|---|
| 3 | Auth + Organizer + RBAC: `resolveActor`, guards, scoped repositories, proxy hardening, login rate limiting, login-hash fix | **NOT RECORDED** in that table; a `PHASE_3` report exists, but design numbering is not project numbering (see §11.3) |
| 4 | Event + Venue + Sport: CRUD, images (EXIF-stripped, consolidated upload), publish/unpublish, slug/share | **NOT RECORDED** |
| 5 | Ticket type + quota: quota CAS, sales windows, limits, reservation reaper (job runner) | **NOT RECORDED** |
| 6 | Customer + checkout + order: pricing, reservations, idempotency, buyer identity, **PIC attribution capture** | **NOT RECORDED** |
| 7 | Payment + iPaymu: `Payment`, session creation, webhook retarget, `WebhookEvent`, expiry job | **NOT RECORDED** |
| 8 | Ticket + QR + delivery: issuance, tokens, wallet, **notification foundation + WhatsApp delivery** | **NOT RECORDED** |
| 9 | PIC + fee ledger: rate resolution, ledger entries, fee dashboard, reversals | **NOT RECORDED** |
| 10 | Dashboard + reports + Excel | **NOT RECORDED** |
| 11 | Email channel + preferences + operational notifications | **NOT RECORDED** |
| 12 | Check-in: scan chain, duplicate guard, manual override, live counters | **NOT RECORDED** |
| 13 | Platform admin: organizers, sports, venues, transactions, refunds, settlements, settings, audit | **NOT RECORDED** |
| 14 | Legacy cleanup: remove the retail surface, dependencies and scripts | **NOT RECORDED** |

The table lists only **gates to enter**, not statuses. Assigning completed/in-progress states would require inference from the `PHASE_nn_*` reports, which use a different numbering.

### 11.2 Migration roadmap — `TICKETING_REBUILD_AUDIT.md` §23, "Recommended Migration Strategy"

Exact phase titles: Phase 0 — Audit (this document); Phase 1 — Domain & database design; Phase 2 — Database migration (additive); Phase 3 — Event management (organizer); Phase 4 — Ticket management (quota, pricing, reservations); Phase 5 — Customer event discovery; Phase 6 — Checkout (order + reservation, no gateway yet); Phase 7 — Payment gateway (iPaymu on the new model); Phase 8 — E-ticket & QR; Phase 9 — Organizer dashboard; Phase 10 — QR check-in; Phase 11 — Admin platform.

No statuses are recorded in this roadmap either, and its numbering conflicts with §11.1 (e.g. design Phase 8 is "Ticket + QR + delivery", rebuild Phase 8 is "E-ticket & QR").

### 11.3 Project phase reports — the actual `PHASE_nn_*` numbering

The project explicitly warns that the design's numbering is **not** the project's:

> "`TICKETING_PHASE1_DESIGN.md` §40.11 numbers its *own* roadmap (design-Phase 12 = check-in). The project's actual phases are the `PHASE_nn_*` reports."
> — `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md`, Phase numbering warning

The repository contains `TICKETING_PHASE1_DESIGN.md`, `TICKETING_PHASE2_REPORT.md` … `TICKETING_PHASE10B_*`, and `PHASE_11` … `PHASE_40` reports, plus the Phase 0/1/2 notification reports. There is **no index** mapping those numbers to titles and statuses. Reporting "all phases" with authoritative titles and statuses from this set is therefore **NOT VERIFIED**.

### 11.4 Notification workstream — the numbering the Phase 1/2 documents actually use

These names and statuses are directly evidenced by the Phase 1/2 documents (not inferred):

| Phase | Exact name as used | Status | Evidence |
|---|---|---|---|
| Phase 1 | Email/WhatsApp foundation + delivery queue | **IMPLEMENTED — PASS (dry-run)** | `PHASE_1_IMPLEMENTATION_REPORT.md` §0 |
| Phase 2 | Purchase proof via email & WhatsApp | **IMPLEMENTED — CONDITIONAL PASS** | `docs/PHASE_2_IMPLEMENTATION_REPORT.md` §1–2 |
| Phase 2 (post-issuance extension) | Post-issuance ticket notification | **IMPLEMENTED — PASS** | `docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_IMPLEMENTATION_REPORT.md` §1–2 |
| Phase 3 | PIC QR scanning | **NOT STARTED** | `docs/PHASE_2_IMPLEMENTATION_REPORT.md` ("start Phase 3 (PIC QR scanning)"); `docs/PHASE_2_PRE_IMPLEMENTATION_AUDIT.md` ("Phase 3/4/5 … not started") |
| Phase 4 | Reminder H-36 | **NOT STARTED** | `PHASE_1_PRE_IMPLEMENTATION_AUDIT_REPORT.md`; `lib/notifications/templates.ts` ("belong to Phases 4/5 and remain unregistered") |
| Phase 5 | Post-event document blast | **NOT STARTED** | same two sources |

This is the closest thing to a canonical roadmap for the current workstream, but it is **narrative, not a maintained register**. The owner should treat §11.4 as authoritative for Phase 2 readiness and commission a single roadmap index before Phase 3, rather than reconciling three conflicting numbering schemes.

---

## 12. Recommended Next Action

D-46 is now recorded, and no code change is required to comply with it. The next action should **not** be Phase 3.

1. **Accept and baseline this report, then commit the Phase 2 work as a reviewable baseline** (owner-authorized Git action; this audit was forbidden to commit). Without a commit, the feature has no rollback point or independent review surface.
2. **Decide provider activation separately**, in this order:
   - resolve the `nodemailer` advisory path (B1) without breaking the `@auth.js` peer range;
   - define Baileys custody: host-only pairing, `WA_AUTH_DIR` permissions/backup, one socket, logout/reconnect policy, daily cap;
   - run a controlled single-recipient delivery test per channel, with a real `NEXT_PUBLIC_APP_URL`, before enabling the worker in production.
3. **Decide the recovery operations**: keep `sweep:ticket-issued` operator-run or attach it to an approved scheduler; decide the policy for `endAt = null` and for issuance after `endAt + 30 minutes` (R2/R3). These are owner decisions, and they affect whether a buyer can be left without a ticket message.
4. **Add a delivery-status read surface** (R4) before declaring the feature operable; today failures are visible only in the database and logs.
5. **Disambiguate the D-46 identifier** in the decision register (R10): notification ticket-code exposure vs wallet QR display mechanism.
6. Only after the above is accepted should Phase 3 planning begin — and the roadmap should first be consolidated into one index (§11).

---

## 13. Final Verdict

# PASS WITH LIMITATIONS

**Why not PASS:** the decision matches the implementation, but the feature is not *ready* to deliver: providers are inactive, no real delivery has been proven, the recovery sweep has no scheduler, the notification window can suppress legitimate late issuance, there is no delivery-status surface, and the whole feature is uncommitted.

**Why not BLOCKED:** the evidence is sufficient and consistent. Every element of D-46 Option A is present in source and guarded by tests; nothing in the implementation conflicts with the decision. The remaining gaps are activation and operations, not implementation correctness.

**Limitations of this audit, stated plainly:**

- Jest was **not rerun**; all test counts in §9.2 are historical.
- The local `.env` was **not read**; `NOTIFICATIONS_ENABLED` there is **NOT VERIFIED**, though the code clamp makes a live send impossible regardless.
- No SMTP connection, WhatsApp pairing, message delivery, build, or lint run was performed.
- Roadmap phase statuses outside the notification workstream are **NOT VERIFIED**; the repository has three conflicting roadmaps and no status register.

**STOP — audit complete. No source, test, schema, environment, or Git state was modified. Awaiting owner approval.**
