# 15 — IMPLEMENTATION ROADMAP

**Purpose:** safe order for closing the gaps identified in this audit. This is a recommendation, not an approval to code. No phase below was executed during the audit.

---

## 1. Guiding dependencies

1. **Live transport is a shared dependency** for features 1, 2 and 4. It is an owner/operations decision, not a coding sprint.
2. **Feature 4 requires a schema and privacy design** before any code.
3. **PIC scanner is already built**; remaining work is evidence and scale hardening, not new UI.
4. **Every phase must state whether it is mocked, dry-run, or real-DB evidence.** A mocked suite is not production proof.
5. **No phase may bypass idempotency keys, tenant/PIC decisions, or the dry-run clamp without explicit approval.**

---

## 2. Recommended phase order

### Phase 0 — Approval and decisions (no code)

**Goal:** resolve the decisions that block implementation.

- Approve this audit and the feature-4 scope.
- Decide live transport: Baileys hosting vs WhatsApp business provider; SMTP provider/credential ownership.
- Approve H-36 copy and whether reminders are per ticket or per phone (current: one per phone).
- Decide purchase proof format: text vs PDF e-ticket.
- Decide feature-4 eligibility (ticket holder vs attendee, refunded/void inclusion), retention and expiry.
- Approve a proposed migration in principle, not apply it.

**Exit:** written decisions; no source change.

---

### Phase 1 — Operability baseline (parallel, low risk)

**Goal:** make the existing asynchronous system observable before adding volume.

- Supervise the notification worker (PM2 or equivalent).
- Add monitoring for `JobLock.lastRunAt/lastStatus`, queued/failed `NotificationDelivery`, and cron heartbeat.
- Verify the tick endpoint secret and cron on the target host.
- Back up `UPLOAD_DIR` and document restore.

**Exit:** worker and cron are supervised; a failed/stuck job is visible without reading raw logs.

---

### Phase 2 — Phase 3G real-database verification

**Goal:** replace mocked evidence for check-in with MariaDB evidence.

- Provision a disposable `_test` schema (`TEST_DATABASE_URL`, name ends `_test`).
- Real PIC assignment lookups; masked 404 for foreign event.
- Two connections admitting the same ticket: exactly one success, one duplicate.
- Forced transaction failure leaves no `CheckIn` row.
- Real audit persistence and `picProfileId` attribution.

**Exit:** deterministic integration suite with recorded counts; no production data.

**Why before live scanner marketing:** the whole duplicate guarantee is a DB claim.

---

### Phase 3 — H-36 production readiness

**Goal:** one controlled live reminder, then bounded rollout.

- Approve copy and sender identity.
- Add pagination/cursor for >500 tickets per event.
- Decide late-reminder policy when the event starts before a tick.
- Add queue/lease alerts.
- Run a controlled live test with one internal recipient.
- Verify idempotency by re-running the tick: no second message.

**Exit:** observed one live WhatsApp reminder; re-run produces zero duplicates; cancellation/archive produces none.

**Dependency:** Phase 0 transport decision + Phase 1 worker.

---

### Phase 4 — Purchase proof production verification

**Goal:** one live proof per channel and a recovery path.

- Activate SMTP/WhatsApp for a controlled order.
- Verify email and WhatsApp independently; one failure must not block the other.
- Verify replay/reconciliation does not duplicate.
- Decide and, if required, implement PDF attachment (separate backend work).
- Add delivery-status visibility for operators.

**Exit:** observed live email and WhatsApp proof for one paid order; duplicate webhook adds none.

**Dependency:** Phase 0 transport decision + Phase 1 worker.

---

### Phase 5 — Feature 4 design and migration proposal

**Goal:** approve a safe document-distribution design **without applying it**.

Deliverables:

1. Proposed schema: document, event binding, uploader, private storage key, checksum, MIME/size, created/expiry, delivery/recipient linkage.
2. Private storage design: path, access route, authorization matrix, retention/deletion.
3. PIC authorization decider: active profile + active assignment + `COMPLETED` event; **separate from `checkin.scan`**.
4. Recipient definition and query (holder vs attendee; refund/void policy).
5. Template copy and channel policy.
6. Bulk-send limits, batching, idempotency and failure handling.
7. Threat model: public URL leakage, enumeration, malware, PII, abuse.
8. Rollback/compatibility plan for the migration.

**Exit:** approved design + proposed migration; no applied DDL, no production change.

---

### Phase 6 — Feature 4 backend (only after Phase 5 approval)

**Goal:** private document upload, recipient selection and tracked delivery.

- Apply the approved migration in a controlled environment.
- Implement private storage with magic-byte validation, server filenames and malware scanning/sanitisation.
- Implement the document-specific PIC decider and recipient query.
- Implement a bounded batch producer using the notification outbox; unique key per document+recipient+channel.
- Implement authenticated download (recipient/PIC scope) and audit.
- Add retention/expiry cleanup job.
- Tests: authorization matrix, duplicate delivery, cross-tenant, expiry, large batch.

**Exit:** a PIC can upload a document for an assigned completed event; a selected recipient can access it; an unselected user cannot; delivery is tracked and retryable.

---

### Phase 7 — Feature 4 UI and rollout

**Goal:** usable PIC surface with safe bulk sending.

- PIC document page: upload, recipient selection, channel choice, confirmation, progress, history.
- No public link; no recipient export by default.
- Batch size/cap approved by product; dry-run first, then controlled live.
- Operator monitoring for failed deliveries.

**Exit:** controlled live blast to a small recipient set; duplicate re-run adds none; audit shows uploader, recipients and outcomes.

---

### Phase 8 — Scale and hardening (conditional)

Only if deployment moves beyond a single process/VPS:

- Shared rate-limit store (Redis or equivalent).
- Object storage with private access/signed URLs.
- Real queue/worker autoscaling.
- CSP nonce to remove `'unsafe-inline'`.
- Retire legacy `User.role` guard and dual-role debt.

---

## 3. Dependency graph

```
Phase 0 decisions
   ├── Phase 1 operability
   │      ├── Phase 3 H-36 live
   │      └── Phase 4 proof live
   ├── Phase 2 (3G real DB) ── scanner production claim
   └── Phase 5 design/migration
          └── Phase 6 backend ── Phase 7 UI/rollout
Phase 8 only if multi-instance/scale
```

---

## 4. Testing and evidence per phase

| Phase | Minimum evidence |
|---|---|
| 1 | Worker/cron heartbeat observed; alert fires on a stopped worker |
| 2 | Real MariaDB suite: duplicate race, rollback, attribution |
| 3 | One live reminder; re-run zero duplicates; cancelled event zero |
| 4 | One live proof per channel; replay zero duplicates |
| 5 | Reviewed design + proposed SQL; no applied migration |
| 6 | Authz matrix + duplicate + retention tests; private route proof |
| 7 | Controlled live blast; unselected recipient denied; audit complete |
| 8 | Load/scale evidence for the changed component |

---

## 5. What must **not** be done

- Do not flip `PHASE_1_DRY_RUN_ONLY` without the owner's transport decision and a controlled recipient.
- Do not apply a document migration before Phase 5 approval.
- Do not reuse `Event.documentationUrl` or the public `events/` upload tree for private documents.
- Do not reuse `checkin.scan` as the document permission; design a separate decider.
- Do not claim production readiness from mocked tests.
- Do not add a public document URL, public QR endpoint or public resend endpoint.
- Do not bypass the unique idempotency keys for bulk sending.

---

## 6. Recommended immediate next step

**Approve Phase 0 decisions and Phase 1 operability.** The highest-value engineering work that is safe today is Phase 2 (real-DB check-in evidence), because it validates an already-built, security-sensitive feature without touching transport or schema.

Feature 4 should remain in design until its migration, storage privacy and PIC authorization are approved.
