# Testing and Acceptance Criteria

**Status:** PLANNING ONLY. No test, live send, SMTP connection or real-database run was performed for this document.

**Evidence rule:** a mocked test is not production proof. Every acceptance item states its evidence level:

- **PURE** — pure function/unit test.
- **MOCK** — mocked DB/transport or fake socket.
- **DRY-RUN** — real queue/worker with the dry-run transport.
- **REAL-DB** — disposable MariaDB test schema with real constraints/transactions.
- **LIVE-CONTROLLED** — one approved real recipient, explicitly authorised, with no production blast.
- **OBSERVED** — monitoring/log evidence from the deployed system.

---

## 1. Existing test baseline

**VERIFIED.**

- 184 test files in 27 directories under `__tests__/`.
- 13 notification test files: `h36-reminder`, `logging`, `purchase-proof.integration`, `purchase-proof-template`, `purchase-proof-wiring`, `purchase-proof-worker`, `queue`, `ticket-issued.integration`, `ticket-issued-template`, `ticket-issued-wiring`, `ticket-issued-worker`, `transports`, `worker`.
- The audit records a previous 3F focused run of 11 suites / 339 tests passing, but it was mocked/pure. `TEST_DATABASE_URL` is unset in this session, so no real MariaDB evidence exists.
- The warning in `.env.example` is real: Jest refuses to run without a separate `_test` database, and it refuses a schema equal to the application database.

**Do not claim** the 339-test run covers gateway, live send, SMTP or document delivery. It does not.

---

## 2. Test levels and tooling

### 2.1 Unit/pure

- Config parsing, fail-closed flags, allowlist normalization.
- Queue retry delay/jitter.
- Gateway JID validation, token verification, ack monotonicity.
- Document token signature/expiry, eligibility, dedup key, filename/path guards.
- Authz deciders (organizer/PIC/own-scope).

### 2.2 Contract with a fake socket

**PROPOSED.** Define a narrow `WhatsAppSocketLike` interface (`sendMessage`, `end`, event emitter). Test the gateway against a fake:

- no real Baileys import in CI;
- no network;
- deterministic message ids, disconnects, receipts.

### 2.3 Worker + fake gateway HTTP

Run the real worker/queue against a local fake gateway server:

- success, 503, timeout, duplicate request, `409 AMBIGUOUS`;
- verify `NotificationDelivery` transitions and attempt counts;
- verify no retry after ambiguous.

### 2.4 Real database

Provision a separate MariaDB schema whose name ends `_test`, set `TEST_DATABASE_URL`, and apply migrations. Tests must assert constraints, not just mocks:

- `Notification.idempotencyKey` unique;
- `(notificationId, channel)` unique;
- `WhatsAppGatewayMessage.deliveryId` unique;
- CAS claim under two connections;
- transaction rollback leaves no `CheckIn`/document rows.

`npm run test:db:setup` currently verifies the test DB read-only; migrations are an operator action. Do not point it at production.

### 2.5 Live controlled

Only after owner approval and one approved recipient. No CI job may perform a live send. The operator records the message id and receipt, then tests replay.

---

## 3. Gateway tests

| ID | Case | Level | Expected |
|---|---|---|---|
| GW-01 | Missing bearer token | PURE | 401, no socket call |
| GW-02 | Wrong token, length differs | PURE | 401, constant-time path |
| GW-03 | Body over limit | PURE | 413/400, no send |
| GW-04 | Group/broadcast JID | PURE | 400, no send |
| GW-05 | Invalid Indonesian number | PURE | 400, no send |
| GW-06 | Valid `08…`, `+62…`, `62…` | PURE | same `628…@s.whatsapp.net` |
| GW-07 | Two sends concurrently | PURE | serialized; no parallel socket calls |
| GW-08 | Same `deliveryId` after `SENT` | PURE/MOCK | same message id, one send |
| GW-09 | Same `deliveryId` while `SENDING` | PURE | 409, no second send |
| GW-10 | Expired `SENDING` | PURE | `AMBIGUOUS`, no resend |
| GW-11 | Send timeout then GET | MOCK | resolves `SENT` or `AMBIGUOUS`; never guesses |
| GW-12 | `loggedOut` | PURE | `LOGGED_OUT`, no reconnect loop |
| GW-13 | `replaced`/conflict | PURE | `CONFLICT`, stop |
| GW-14 | `restartRequired` | PURE | one bounded reconnect |
| GW-15 | Network close | PURE | exponential backoff with cap |
| GW-16 | Lease renewal fails | PURE | `FENCED`, socket closed |
| GW-17 | Second process/file lock | PURE | refuses startup |
| GW-18 | Encrypted state round-trip | PURE | creds/keys equal; no plaintext file |
| GW-19 | Wrong/missing session key | PURE | startup refused |
| GW-20 | Graceful SIGTERM | PURE | stops accepting, awaits send, flushes, releases |
| GW-21 | Ack `DELIVERED` then `READ` | PURE | monotonic |
| GW-22 | Ack regress `READ→DELIVERED` | PURE | ignored/refused |
| GW-23 | Log redaction | PURE | no token/recipient/body/QR |

**Acceptance:** all gateway tests pass without `@whiskeysockets/baileys` connecting; no outbound network in CI.

---

## 4. Queue/worker reliability tests

| ID | Case | Level | Expected |
|---|---|---|---|
| Q-01 | Kill switch off | DRY-RUN | no DB write/claim |
| Q-02 | Two workers claim | REAL-DB | one winner, one `SENDING` |
| Q-03 | Expired `SENDING` | REAL-DB | `FAILED/AMBIGUOUS_DELIVERY`, no resend |
| Q-04 | Transient failure | MOCK | `QUEUED` with 60s/300s backoff |
| Q-05 | Third failure | MOCK | terminal `FAILED` |
| Q-06 | Permanent invalid recipient | DRY-RUN | `SKIPPED/INVALID_RECIPIENT`, no retry |
| Q-07 | Unknown template | DRY-RUN | `SKIPPED/TEMPLATE_NOT_FOUND` |
| Q-08 | Dry-run | DRY-RUN | `SKIPPED/DRY_RUN_SIMULATED`, never `SENT` |
| Q-09 | Gateway down | MOCK | WhatsApp rows stay `QUEUED`; email unaffected |
| Q-10 | Priority order | REAL-DB | proof 10 before ticket 20 before H-36 30 before doc 40 |
| Q-11 | Transactional cap | MOCK | doc blast cannot starve proof/reminder |
| Q-12 | Document cap 0 | MOCK | no document send |
| Q-13 | Replay lost HTTP response | MOCK/GATEWAY | one socket acceptance |
| Q-14 | Ack reconciliation | REAL-DB | updates only ack fields, not `status=SENT` regression |

**Acceptance:** no path writes `SENT` without a provider id; no path automatically retries an ambiguous outcome; caps are visible and enforced.

---

## 5. H-36 tests

Existing `__tests__/notifications/h36-reminder.test.ts` covers pure boundaries/enqueue; extend with:

| ID | Case | Level | Expected |
|---|---|---|---|
| H-01 | Exactly 36h | PURE | due |
| H-02 | 36h + 1ms | PURE | not due |
| H-03 | At start | PURE | not due |
| H-04 | Event starts before tick | REAL-DB | no late enqueue |
| H-05 | Re-run | REAL-DB | no duplicate |
| H-06 | Reschedule | REAL-DB | old skipped, new row |
| H-07 | Cancel/archive | REAL-DB | no send; queued reconciled |
| H-08 | Duplicate phone | REAL-DB | one row per phone |
| H-09 | 500 tickets | REAL-DB | all processed, no truncation signal |
| H-10 | 501 tickets | REAL-DB | explicit truncation signal/alert |
| H-11 | Invalid timezone/payload | PURE | no message, counted ineligible |
| H-12 | Live controlled | LIVE | one message, provider id, replay zero |

**Launch gate:** H-09/H-10 understood before enabling an event above 500 issued tickets. Until pagination exists, do not claim support.

---

## 6. Purchase proof / ticket-issued tests

Existing template/wiring/worker/integration suites are the baseline; add/verify:

| ID | Case | Level | Expected |
|---|---|---|---|
| P-01 | Settled order | REAL-DB | email + WhatsApp rows created independently |
| P-02 | Unpaid/cancelled order | REAL-DB | no rows |
| P-03 | Replay webhook | REAL-DB | no duplicate rows |
| P-04 | Sweep after successful enqueue | REAL-DB | no duplicate |
| P-05 | Invalid phone | DRY-RUN | WhatsApp skipped; email proceeds |
| P-06 | Invalid email | DRY-RUN | email skipped; WhatsApp proceeds |
| P-07 | Enqueue failure | MOCK | no throw into settlement; logged |
| P-08 | Live email | LIVE | one SMTP send, provider id, no duplicate |
| P-09 | Live WhatsApp | LIVE | one gateway send, provider id, ack |
| P-10 | Ticket-issued after issuance | REAL-DB | posts only after commit; no row without tickets |
| P-11 | Replay issuance | REAL-DB | no duplicate |

**Acceptance:** per-channel independence and idempotency proven against real unique constraints, not only mocks.

---

## 7. PIC scanner tests (Phase 3G)

| ID | Case | Level | Expected |
|---|---|---|---|
| PIC-01 | Active profile + active assignment | REAL-DB | success |
| PIC-02 | Foreign event | REAL-DB | masked 404 |
| PIC-03 | Suspended profile | REAL-DB | denial |
| PIC-04 | Revoked/inactive assignment | REAL-DB | denial |
| PIC-05 | Two parallel scans same ticket | REAL-DB | exactly one success, one duplicate/conflict |
| PIC-06 | Forced transaction failure | REAL-DB | no `CheckIn`, ticket stays `ISSUED` |
| PIC-07 | 121st scan/minute | PURE/REAL | 429, retry hint |
| PIC-08 | Limiter throws | PURE | 503, no ticket query |
| PIC-09 | Same PIC, two events | PURE | separate buckets |
| PIC-10 | Audit persistence | REAL-DB | `actorKind=PIC`, correct `picProfileId` |
| PIC-11 | Rejected attempt | REAL-DB | `ticketId=null`, unique-safe |
| PIC-12 | Organizer path | REAL-DB | unaffected by PIC limiter |

**Acceptance:** recorded real-DB output for PIC-05, PIC-06, PIC-10. No production data.

---

## 8. Document tests

| ID | Case | Level | Expected |
|---|---|---|---|
| D-01 | Upload PDF/JPEG/PNG/WebP by magic | PURE | accepted |
| D-02 | SVG/HTML/ZIP/exe | PURE | rejected |
| D-03 | Oversize / declared-size lie | PURE | rejected on bytes |
| D-04 | Path traversal filename | PURE | server path unchanged |
| D-05 | Scanner unavailable | PURE | `SCAN_FAILED`, cannot publish |
| D-06 | Infected file | PURE | `INFECTED`, no publish |
| D-07 | Clean file | PURE | `READY` |
| D-08 | Organizer cross-tenant | REAL-DB | 404 |
| D-09 | PIC unassigned/revoked | REAL-DB | 404 |
| D-10 | PIC valid completed event | REAL-DB | upload/publish allowed |
| D-11 | Recipient forged id | REAL-DB | 404, no send |
| D-12 | Duplicate contact | REAL-DB | one recipient per `recipientKey` |
| D-13 | Refunded/void ticket | REAL-DB | excluded |
| D-14 | Prepare twice | REAL-DB | one recipient/delivery set |
| D-15 | Bounded enqueue 100 | REAL-DB | 100/tick, resumable |
| D-16 | Crash after enqueue before link | REAL-DB | next run links existing delivery, no duplicate |
| D-17 | Valid signed link | PURE | 200, attachment headers |
| D-18 | Expired link | PURE | 410/404 |
| D-19 | Revoked doc/recipient | PURE | 404/410 |
| D-20 | Wrong signature | PURE | 404, no timing oracle |
| D-21 | Link token in logs/payload | PURE | absent |
| D-22 | Replay blast | REAL-DB | zero duplicate |
| D-23 | Retention expiry | REAL-DB | link dead, file purged, audit retained |
| D-24 | Unselected recipient | REAL-DB | denied |
| D-25 | WhatsApp/email channel failure | MOCK | independent; report reflects |
| D-26 | 500 recipients load | REAL-DB | bounded enqueue, no request timeout |

**Acceptance:** authz matrix, duplicate, expiry, malware failure and cross-tenant proven against real DB where relevant; secure link is not a public path.

---

## 9. Security tests

- No secret/token/QR/recipient in logs; reuse/verify `lib/notifications/logger.ts` redaction (SEC-01).
- Gateway bind is loopback; not reachable through nginx (SEC-02).
- Session directory permissions 0700/files 0600; no plaintext on disk (SEC-03).
- Document path cannot escape storage root (SEC-04).
- `Content-Disposition: attachment`, `nosniff`, `private, no-store` (SEC-05).
- PIC cannot use document permission to read attendance or other events (SEC-06).
- Cross-tenant document access masked 404 (SEC-07).
- Rate limit shared-state limitation documented; no claim of multi-instance safety (SEC-08).
- No public resend/broadcast endpoint (SEC-09).
- Replayed webhook/tick does not duplicate (SEC-10).

---

## 10. Acceptance criteria summary

| Feature | Minimum evidence to call it active |
|---|---|
| Gateway | PURE + MOCK + REAL-DB ownership/idempotency; one LIVE-CONTROLLED send |
| H-36 | DRY-RUN queue + REAL-DB eligibility/replay + one LIVE-CONTROLLED reminder |
| Purchase proof | REAL-DB idempotency + one LIVE-CONTROLLED email and WhatsApp; replay zero |
| Ticket-issued | Same as proof |
| PIC scanner | REAL-DB race/rollback/authz/audit; no live dependency |
| Document blast | Design approval + REAL-DB authz/duplicate/expiry + one controlled cohort |
| Deployment | PM2 restart/reboot, health/heartbeat alerts, backup restore |

A feature is **not** "production-ready" because it compiles, because dry-run passed, or because a mock returned success.

---

## 11. Test commands and CI gates

**Expected commands (to be run in implementation phases):**

```bash
npx tsc --noEmit
npm run lint
npm test -- --runInBand
npm test -- __tests__/notifications
```

Real-DB suites require an operator-provisioned `TEST_DATABASE_URL`; do not run them against production. Record the exact command, exit status and counts in the phase report.

**CI gates proposed:**

- typecheck and lint;
- unit/contract tests;
- no outbound network/live send in CI;
- schema drift check against the approved migration;
- secret scan on docs/log fixtures;
- dependency advisory review (Baileys/ nodemailer);
- real-DB suite in a controlled job (once provisioned), not on every PR if unavailable.

---

## 12. Limitations of this plan

- No real MariaDB was available in this session (`TEST_DATABASE_URL` unset).
- No WhatsApp account was connected and no message was sent.
- No SMTP connection was made.
- No ClamAV/scanner exists or was tested.
- No load test was run.
- Live acceptance requires owner approval, one controlled recipient, and a recorded receipt. Until then, all live claims remain unverified.
