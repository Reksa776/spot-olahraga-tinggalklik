# MASTER FOUR-FEATURE AUDIT

**Repository:** `/home/reksa/tinggalklik` · branch `main` · HEAD
`9b8fecd99bcc74677c1805c18379241af04fddd1`
**Scope:** the four permanent product objectives — H-36 WhatsApp reminder, purchase-proof
delivery, PIC QR scanner, post-event document blast.
**Method:** every classification below cites source read in this session; no filename-only
inference and no report-only claims.

---

## 1. Executive summary

| # | Objective | Status | One-line reason |
|---|---|---|---|
| 1 | WhatsApp reminder H-36 | **NOT IMPLEMENTED** | No reminder template, recipient query, H-36 calculation, idempotency key or job. Templates explicitly defer it. |
| 2 | Purchase proof via WhatsApp/email | **IMPLEMENTED BUT NOT VERIFIED (live)** | Complete enqueue/template/worker/idempotency code exists, but every transport is clamped to dry-run. |
| 3 | PIC QR scanner | **3A–3D PASS; 3E–3G GAP** | API and transaction exist; no PIC scan page, no scan rate limit/attribution, no real-DB concurrency evidence. |
| 4 | Post-event document blast | **NOT IMPLEMENTED** (link-only partial) | Only a public `Event.documentationUrl`; no private documents, recipients, delivery, or audit. |

The notification *runtime* is the shared dependency for features 1, 2 and 4, and it is
**dry-run only by a compiled constant**, not by configuration. That is the single largest
blocker to any real WhatsApp/email objective, and it is an owner decision, not a coding gap.

---

## 2. Baseline and protected state

Captured before editing: `main` @ `9b8fecd…`, staged 0, two intentional Phase 3C tracked
modifications (`lib/ticketing/checkin/service.ts`,
`__tests__/ticketing-checkin/check-in-wiring.test.ts`), 21 untracked Phase 2–3D artifacts.
Full list and digests: `docs/MASTER-BASELINE-MANIFEST.md`. No reset, stash, checkout,
restore, clean or wildcard staging was performed, and `.cloud-attachments/` was neither read
nor modified.

---

## 3. FEATURE 1 — H-36 WhatsApp reminder

### 3.1 Evidence table

| Requirement | Classification | Evidence |
|---|---|---|
| Event start date/time | **IMPLEMENTED AND VERIFIED** | `prisma/schema.prisma:927` `startAt DateTime` |
| Event timezone | **IMPLEMENTED BUT NOT VERIFIED** | `prisma/schema.prisma:931` `timezone String @default("Asia/Jakarta")`; no reminder code reads it |
| Eligible participant query | **NOT IMPLEMENTED** | No reminder module; `grep` for reminder/h36 finds only templates comment and absence tests |
| WhatsApp provider/client | **PARTIALLY IMPLEMENTED** | `lib/notifications/transports/baileys.ts` exists but is a refusing adapter; `lib/notifications/config.ts:38` `PHASE_1_DRY_RUN_ONLY = true`; `:179-191` records a baileys request as a refusal |
| Scheduler/cron | **IMPLEMENTED (for other jobs)** | `app/api/internal/jobs/tick/route.ts` (bearer secret, constant-time), `lib/jobs/tick.ts`, `lib/jobs/lock.ts`; `JOB_NAMES` pins exactly two jobs |
| Reminder job slot | **NOT IMPLEMENTED** | `lib/jobs/tick.ts` runs only `event-lifecycle` and `reservation-reaper`; `lib/jobs/lock.ts:29-32` states "the two jobs, and only two" |
| H-36 calculation | **NOT IMPLEMENTED** | No occurrence/window code anywhere |
| Idempotency / duplicate prevention | **PARTIALLY IMPLEMENTED** | Foundation only: `Notification.idempotencyKey @unique` (`schema.prisma:203`); no reminder key producer |
| Queue and batch sending | **IMPLEMENTED (generic)** | `lib/notifications/enqueue.ts`, `queue.ts`, `worker.ts`; no reminder producer calls them |
| Retry and failure handling | **IMPLEMENTED (generic)** | `NotificationDelivery.attemptCount/maxAttempts/nextRetryAt`, `lib/notifications/queue.ts` |
| Delivery status and logs | **IMPLEMENTED (generic)** | `NotificationDelivery` (`schema.prisma:1722`), `lib/notifications/logger.ts` |
| Cancellation/rescheduling handling | **NOT IMPLEMENTED** | No reminder rows exist, so nothing to cancel or supersede |
| Template | **NOT IMPLEMENTED** | `lib/notifications/templates.ts:12` says H-36 belongs to Phase 4/5 and remains unregistered; `__tests__/notifications/purchase-proof-template.test.ts:169` asserts `hasTemplate("reminder.h36.v1") === false` |
| Tests / operational docs | **NOT IMPLEMENTED** | No reminder suite; prior decision docs mark Phase 4 NOT STARTED (`docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md:358`) |

### 3.2 Acceptance criteria today

All seven fail: no participant is reminded, no occurrence idempotency exists, timezone is
unused, cancellation/reschedule cannot be honoured, failures are unobservable (nothing is
enqueued), and no scheduler runs a reminder.

### 3.3 What is genuinely reusable (so this is not a greenfield build)

- The event ticket-holder set already exists as `Ticket` rows (issuance Phase 2), with
  `holderUserId`/attendee contact; the purchase-proof module already normalises contacts
  (`lib/notifications/contacts.ts`).
- The outbox is the unique `idempotencyKey`; a reminder occurrence key of the shape
  `reminder.h36:{eventId}:{ticketId}:{channel}:v1` needs **no schema change**.
- Enqueue-at-due-time means no `scheduledFor` column is required: a tick job selects events
  whose `startAt - 36h` has passed and enqueues idempotently. `Notification` already carries
  `eventId`, `ticketId`, `templateKey`.
- The tick already runs under a DB lease, so a reminder job inherits single-flight safety.

### 3.4 Blockers

1. **Live WhatsApp transmission is impossible in this build** — `PHASE_1_DRY_RUN_ONLY`
   clamps the effective transport and Baileys is never imported. Owner decision + runtime
   pairing required; not a code gap this session can close without pretending.
2. **Template copy and reminder policy** (exact Indonesian copy, opt-out stance, whether
   reminders are per ticket or per buyer) are product decisions; the repository holds no
   approved `reminder.h36.v1` copy.
3. **Job vocabulary** — adding a third job is a deliberate change to `JOB_NAMES` and the
   pinned two-job tick tests, not an accident to slip in.

---

## 4. FEATURE 2 — Ticket purchase proof (WhatsApp or email)

### 4.1 Evidence table

| Requirement | Classification | Evidence |
|---|---|---|
| Successful payment → settlement lifecycle | **IMPLEMENTED AND VERIFIED (DB suite exists)** | `lib/ticketing/payment/settlement.ts`; post-commit hook added by Phase 2 (report and `purchase-proof-wiring.test.ts`) |
| Ticket issuance lifecycle | **IMPLEMENTED AND VERIFIED (DB suite exists)** | `lib/ticketing/issuance.ts` hook; `lib/notifications/ticket-issued.ts:218`; `__tests__/notifications/ticket-issued.integration.test.ts` |
| Proof artifact / template | **IMPLEMENTED AND VERIFIED** | `lib/notifications/purchase-proof-template.ts` (`purchase-proof.v1`), renderer shared by email and WhatsApp |
| WhatsApp integration | **PARTIALLY IMPLEMENTED** | Adapter refuses; `WHATSAPP_TRANSPORT=baileys` downgraded to dry-run (`config.ts:189-191`) |
| Email integration | **PARTIALLY IMPLEMENTED** | `transports/smtp.ts` exists but the same constant forbids a real connection |
| Participant contact info | **IMPLEMENTED AND VERIFIED** | `lib/notifications/contacts.ts`, `store-contact.ts`; template tests cover invalid-recipient exclusion |
| Message templates | **IMPLEMENTED AND VERIFIED** | Registry in `templates.ts`; `purchase-proof.v1`, `ticket-issued.v1` only |
| Attachment delivery | **NOT APPLICABLE** | Proofs are plain-text messages; no attachment is produced or sent |
| Delivery status and retry | **IMPLEMENTED AND VERIFIED (unit)** | `NotificationDelivery` state machine in `queue.ts`/`worker.ts`; worker tests |
| Duplicate prevention | **IMPLEMENTED AND VERIFIED** | `purchaseProofIdempotencyKey` (`purchase-proof.ts:102-106`) and `ticketIssuedIdempotencyKey` (`ticket-issued.ts:74`) — one row per channel |
| Payment-state validation | **IMPLEMENTED AND VERIFIED** | Settlement eligibility + `sweepMissingPurchaseProofs` (`purchase-proof.ts:390`) |
| Independent channels | **IMPLEMENTED AND VERIFIED (data model + tests)** | one `Notification` per channel; `(notificationId, channel)` unique |
| Live delivery history | **IMPLEMENTED BUT NOT VERIFIED** | No real send has occurred; dry-run writes `SKIPPED / DRY_RUN_SIMULATED` |

### 4.2 Acceptance criteria

Eligibility, one-proof-per-transaction, independent channel rows, duplicate-webhook safety and
auditable delivery state are implemented and covered by unit/DB suites. **Actual delivery is
not verified**: the effective transport cannot be anything but dry-run. This feature is
therefore "code complete, operationally inactive", not "done".

### 4.3 Blockers

Owner decision to leave dry-run (SMTP credentials / advisory path; WhatsApp session hosting),
`NOTIFICATIONS_ENABLED` plus transport values in a real environment, and a real-DB run of the
existing integration suites (`TEST_DATABASE_URL` is required by `jest.setup-env.ts`).

---

## 5. FEATURE 3 — PIC QR scanner

### 5.1 Phase status (as found)

| Phase | Status | Evidence |
|---|---|---|
| 3A authorization contract | **PASS** | `lib/authz/pic-assignment.ts:131` `decidePicEventPermission`; 66-test suite; `docs/PHASE_3A_EXECUTION_REPORT.md` |
| 3B QR validation | **PASS** | `lib/ticketing/checkin/qr-payload.ts:107`; 76-test suite |
| 3C check-in transaction | **PASS WITH LIMITATIONS** | `lib/ticketing/checkin/service.ts:420` `checkInTicket`; 50-test suite; real-DB concurrency deferred to 3G |
| 3D PIC scanner API | **PASS WITH LIMITATIONS** | `app/api/pic/events/[id]/check-in/route.ts`; 44-test suites; `docs/PHASE_3D_…REPORT.md` |
| 3E PIC scanner UI | **NOT IMPLEMENTED** (found) | No `app/dashboard/pic/scan/` page; `components/organizer/TicketScanner.tsx` hardcodes the organizer endpoint; no PIC entry point |
| 3F security/attribution | **NOT IMPLEMENTED** | No scan rate limit; no PIC attribution field; existing best-effort audit only |
| 3G real-DB integration | **NOT IMPLEMENTED** | No disposable MariaDB suite; `TEST_DATABASE_URL` absent |

### 5.2 3E requirements and what existed

| Requirement | Found | Note |
|---|---|---|
| PIC-only scanner page | **NOT IMPLEMENTED** | Organizer page: `app/dashboard/events/[id]/check-in/page.tsx` |
| Camera QR scanning | **IMPLEMENTED (organizer)** | `TicketScanner` — BarcodeDetector + jsQR fallback, permission diagnostics |
| Correct event context | **IMPLEMENTED (API)** | 3D route scopes by `[id]` and server lookup |
| Integration with 3D endpoint | **NOT IMPLEMENTED** | Component posts to `/api/organizer/...` unconditionally |
| Success/invalid/duplicate/refund states | **IMPLEMENTED (organizer)** | `scanFeedbackFor` in the component |
| Camera permission handling | **IMPLEMENTED** | `readCameraEnvironment` / `describeCameraError` |
| Camera release on leave | **IMPLEMENTED** | `releaseCamera` on unmount + `visibilitychange` |
| Single in-flight submission | **IMPLEMENTED** | `busyRef` + `createScanThrottle` |
| No global attendance log | **NOT APPLICABLE for PIC yet** | `canReadLog` prop already gates the list |
| No other operator identity | **NOT IMPLEMENTED** | duplicate details include `firstCheckedInBy` |
| No client-trusted identity | **IMPLEMENTED (API)** | strict schema, session-only actor (3D) |

### 5.3 Blockers

None structural: 3E is a page plus a prop, exactly as `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:729-751`
concluded. It was implemented in this execution (report
`docs/MASTER-EXECUTION-PHASE-3E-REPORT.md`).

---

## 6. FEATURE 4 — Post-event document blast

### 6.1 Evidence table

| Requirement | Classification | Evidence |
|---|---|---|
| PIC authorization for document distribution | **NOT IMPLEMENTED** | No document route/module; `requirePicScanAccess` is scan-only |
| Event completion/eligibility | **PARTIALLY IMPLEMENTED** | Public documentation is shown after `COMPLETED` (`app/e/[slug]/page.tsx:320-337`); no distribution eligibility rule |
| Document upload and storage | **NOT IMPLEMENTED** | Only image upload exists (`UPLOAD_DIR`, `/api/uploads/events/…`); no document model |
| Participant recipient selection | **NOT IMPLEMENTED** | No recipient query |
| WhatsApp/email delivery | **PARTIALLY IMPLEMENTED (generic runtime)** | Adapters dry-run only; no document template/event |
| Batch sending and queueing | **PARTIALLY IMPLEMENTED (generic)** | Worker/queue can carry messages; no producer |
| Delivery status and retry | **PARTIALLY IMPLEMENTED (generic)** | `NotificationDelivery`; no document rows |
| Duplicate prevention | **NOT IMPLEMENTED** | No document idempotency key |
| File access controls | **NOT IMPLEMENTED** | `Event.documentationUrl` (`schema.prisma:924`) is a public link; anyone with it can open the Drive file |
| Download expiry / secure attachment | **NOT IMPLEMENTED** | No signed URL, no expiry, no attachment pipeline |
| Audit trail | **NOT IMPLEMENTED** | No document audit action |

### 6.2 Acceptance criteria

None can be met by the current link feature: there is no PIC distribution authority, no
event isolation boundary, no recipient selection, no tracked delivery and no private file
access. The existing link is *organizer-authored public documentation*, not a blast.

### 6.3 Blockers

1. **Schema**: private documents need at least a document table + recipient/delivery linkage;
   no such model exists. The brief permits only a *proposed* migration, not an applied one.
2. **Storage/privacy**: files must not be publicly enumerable; the current upload pattern
   serves images publicly, so a new access-controlled read path is required.
3. **Live transport**: same dry-run clamp as features 1–2.
4. **Product rules**: who is eligible (all ticket holders? attended only?), retention, and
   expiry are not written anywhere.

---

## 7. Security risks found

| # | Risk | Evidence | Severity |
|---|---|---|---|
| S-1 | Public documentation link is unrestricted | `Event.documentationUrl` + public render | Medium (product-accepted for a Drive link, unacceptable for documents) |
| S-2 | No scan rate limit | no limiter in check-in path; `lib/rate-limit.ts` is in-memory/per-process | Medium |
| S-3 | PIC attribution absent | `CheckIn.checkedInByUserId` is the user; no PIC profile recorded | Medium (Phase 3F) |
| S-4 | Dry-run is indistinguishable from success in logs unless read carefully | `SKIPPED / DRY_RUN_SIMULATED` | Low, documented |
| S-5 | Per-instance rate limiting | `lib/rate-limit.ts` header; `REDIS_URL` unused | Low on single VPS, blocking on multi-instance |

---

## 8. Database dependencies

| Feature | Schema need | Status |
|---|---|---|
| 1 — reminder | None proven: unique `Notification.idempotencyKey` + existing `eventId/ticketId/templateKey` suffice for enqueue-at-due-time | **No migration required** for dry-run implementation |
| 2 — proof | None; already shipped | No migration |
| 3F — attribution | None proven; audit JSON + `CheckIn` actor columns exist | Prefer no migration; document if a column is truly required |
| 3G — tests | None; needs a disposable `_test` database, not DDL | Infrastructure only |
| 4 — documents | New document/recipient/delivery model(s) almost certainly required | **Migration proposal only**; not applied |

---

## 9. External service dependencies

| Service | Use | Current state |
|---|---|---|
| SMTP (Nodemailer) | purchase proof, ticket issued, future reminder/blast | Adapter present, refused by `PHASE_1_DRY_RUN_ONLY`; credentials absent |
| WhatsApp (Baileys) | same | Adapter present, not imported, pairing never performed |
| iPaymu | payments | Active sandbox config path (`lib/payment/config.ts`) |
| MariaDB/MySQL | all persistence | Application DB configured; test DB absent |

No service was provisioned or contacted in this session.

---

## 10. Tests already available vs missing

**Available (not all run this session):**

- `__tests__/notifications/` — 12 files: template, wiring, worker, integration for both proof
  and ticket-issued, queue, transports, logging.
- `__tests__/ticketing-checkin/` — pic-assignment (66), qr validation (76), transaction (50),
  wiring (29), PIC API/authz (44), scanner loop/fallback/wiring suites.
- `__tests__/jobs/tick.test.ts` — real DB lease/tick.
- `__tests__/authz/route-classification.test.ts` — route protection classification.

**Missing:**

- Any H-36 reminder suite (recipient selection, window boundary, idempotency, cancellation).
- Any PIC scan page suite (added in 3E).
- Real-DB PIC assignment + two-connection concurrency (3G).
- Document distribution suite (none can exist before the feature).
- Rate-limit and PIC-attribution suites (3F).

---

## 11. Cross-feature dependencies

```
notification runtime (dry-run) ──┬── Feature 2 (implemented)
                                 ├── Feature 1 (needs template + job + recipient query)
                                 └── Feature 4 (needs template + documents + recipients)
PIC identity/assignment (3A/3D) ──┬── Feature 3E/3F
                                 └── Feature 4 (PIC authorization for documents)
event lifecycle (Phase 15) ───────┬── Feature 1 (startAt window)
                                 └── Feature 4 (COMPLETED eligibility)
storage/uploads ────────────────── Feature 4 (private document access)
```

---

## 12. Recommended execution order (evidence-based)

1. **Phase 3E — PIC scanner UI** (completed in this execution). Highest safe value: the API
   is already authorized, the device already exists, no schema or provider is needed.
2. **Phase 4 — H-36 reminder, dry-run first.** The outbox, contact normalisation, template
   registry, event `startAt/timezone` and DB-leased tick all exist; only a job, a template and
   a recipient query are missing. Live send stays blocked on the owner.
3. **Phase 3F — scan rate limit, durable attribution, audit.** Small, no schema proven
   necessary, closes a real abuse gap before the scanner is exposed to PICs.
4. **Phase 3G — disposable MariaDB integration.** Needed before claiming production
   readiness for check-in; independent of the other features.
5. **Phase 5 — document blast.** Last because it needs a proposed schema change, storage
   privacy design and product eligibility rules.
6. **Feature 2 live activation** when credentials/transport decision exists (not a build
   phase; an operational switch plus verification).

This differs from the brief's suggested order only by putting 3F before 3G: the rate limit is
a production-facing control that does not need the test database, while 3G is evidence work.

---

## 13. Exact next phases

| Phase | Deliverable | Blocking dependency |
|---|---|---|
| 3E | PIC scan page + shared scanner endpoint | none — done |
| 4 | `reminder.h36.v1`, third tick job, recipient query, idempotency, tests (dry-run) | approved copy; live send later |
| 3F | rate limit on PIC/organizer check-in, PIC attribution in audit, visibility fix | none |
| 3G | disposable `_test` DB, real assignment lookups, two-connection race | DB provisioning |
| 5 | document model proposal, private file read, recipient selection, delivery | migration approval + product rules |
