# Implementation Phases

**Status:** PLANNING ONLY. Nothing in this document has been executed. No source, schema, dependency, environment or account was changed.

**Rule:** do not start a phase until its predecessor's exit criteria are met and the owner has approved the phase. Phase 4 (document blast) must not begin before its schema/privacy design is approved.

---

## 1. Recommended sequence at a glance

```
P0 decisions / approvals
  └─ P1 runtime + operability baseline
       └─ P2 gateway core (no real account)
            └─ P3 controlled pairing + one live send
                 └─ P4 reliability integration (gateway transport, acks, caps)
                      ├─ P5 H-36 controlled activation
                      ├─ P6 purchase proof + ticket-issued activation
                      └─ P8 document design + proposed migration
                           └─ P9 document backend
                                └─ P10 document UI + controlled blast
P7 PIC scanner real-DB verification (independent of P2)
P11 scale/hardening (only if needed)
```

**Critical path:** P0 → P1 → P2 → P3 → P4 → P5/P6. Feature 4 adds P8 → P9 → P10 and cannot skip P4 because it reuses the transport and queue.

---

## 2. Phase 0 — Decisions and approval (no code)

**Goal:** resolve product/security decisions that otherwise get invented in code.

Decisions:

1. Approve this planning set and the deployment target (single VPS, one number).
2. Approve the Baileys risk and the ban/recovery operating model.
3. Approve `WA_AUTH_DIR` location and encryption/key custody.
4. Approve the initial transactional and document WhatsApp caps.
5. Approve H-36 copy and the >500-ticket policy.
6. Approve purchase-proof format (text vs PDF) and SMTP provider.
7. Approve feature-4 eligibility, PIC selection visibility, retention and link-bearer policy.
8. Approve adding `tsx` and `dotenv` as direct dependencies, or approve compiled output for worker/gateway.
9. Approve the proposed migration **in principle**, not apply it.

**Exit:** written decisions; no repository change. **Rollback:** not applicable.

---

## 3. Phase 1 — Runtime and operability baseline

**Goal:** make the existing asynchronous system deployable and observable before adding a live transport.

Work:

- Add `tsx` and `dotenv` as explicit runtime dependencies, or produce compiled JS for `scripts/notification-worker.ts`.
- Add `tinggalklik-worker` to `ecosystem.config.cjs` with `instances:1`, `fork`, no port, `kill_timeout: 30000`, timestamps, restart delay, log rotation.
- Add monitoring for `joblock` heartbeats and `NotificationDelivery` depth/failures.
- Verify cron calls `/api/internal/jobs/tick` with the secret; verify failure closes.
- Document backup/restore for `UPLOAD_DIR` and the database.
- Keep `NOTIFICATIONS_ENABLED=false`; worker does no writes.

**Files:** `package.json`, `package-lock.json`, `ecosystem.config.cjs`, deployment runbook, monitoring config. No application logic.

**DB:** none.

**Exit:** worker starts under PM2 with the kill switch off; health/heartbeat visible; cron verified.

**Rollback:** remove the worker PM2 app and restore `package.json`/lock. No data change.

**Why before gateway:** a gateway that sends into a queue with no supervised worker is not operable.

---

## 4. Phase 2 — Gateway core, no real account

**Goal:** build and test the gateway without pairing or sending.

Work:

- Add the proposed schema: `WhatsAppGatewayMessage`, ack fields on `NotificationDelivery`, `NotificationCategory.DOCUMENT`, indexes.
- Implement encrypted auth-state adapter, file lock, DB lease, loopback HTTP server, health/ready, graceful shutdown.
- Implement send serialization, JID validation, idempotency state machine.
- Implement a worker-side `WhatsAppTransport` HTTP client and typed `AmbiguousDeliveryError`.
- Add a fake-socket adapter and a fake gateway for tests; **no Baileys network**.
- Add a pairing CLI that can be tested with a fake/no-op and refuses to run in CI.

**Files (new):** `lib/whatsapp/gateway/*`, `scripts/whatsapp-gateway.ts`, `scripts/whatsapp-pair.ts`, `lib/notifications/transports/whatsapp-gateway.ts`, tests.

**DB:** proposed migration only; apply in a disposable environment after approval. No production migration in this phase.

**Exit:** unit/contract tests pass without a real account; gateway refuses a second owner; restart preserves encrypted state; ambiguous idempotency is proven; no outbound network in CI.

**Rollback:** drop new tables/columns only if no code/data depends; stop gateway; worker stays dry-run.

**Security gate:** no QR web route, no plaintext credentials, no token in logs, loopback only.

---

## 5. Phase 3 — Controlled pairing and one live send

**Goal:** prove the real account path with the smallest possible blast radius.

Preconditions: P2 complete; owner-approved dedicated number; host access; encrypted volume; one internal test recipient; no real customer queue.

Work:

1. Pair on host via CLI; store encrypted state.
2. Start gateway; verify one socket, lease, `/readyz`.
3. Start worker with `NOTIFICATIONS_ENABLED=true`, `WHATSAPP_TRANSPORT=baileys`, `WHATSAPP_LIVE_MODE=allowlist`, one recipient.
4. Enqueue one synthetic approved notification or one controlled purchase proof.
5. Verify one provider message id and one actual receipt; replay the enqueue/send; verify zero duplicate.
6. Kill/restart gateway; verify reconnect without a second socket; verify in-flight ambiguity is not auto-resent.
7. Log out deliberately on a test account; verify `LOGGED_OUT`, no loop, re-pair procedure works.

**Exit:** one live message observed, one provider id, no duplicate on replay, restart/reconnect safe, logout handled. This is the first point at which a live send is allowed.

**Rollback:** disable notifications, stop worker/gateway, revert to dry-run; queued rows remain. Unpair/clear test session per procedure.

---

## 6. Phase 4 — Reliability integration

**Goal:** make live delivery production-safe.

Work:

- Replace the hard-coded dry-run clamp with a fail-closed live gate (allowlist first).
- Worker stops claiming WhatsApp when gateway is not ready; leaves rows `QUEUED`.
- Typed retry classification: transient vs permanent vs ambiguous.
- Add ack reconciliation from `WhatsAppGatewayMessage` to `NotificationDelivery` (monotonic).
- Claim order by `priority ASC, queuedAt ASC`; category-aware caps; absolute cap.
- Add `WHATSAPP_DOCUMENT_DAILY_CAP` default 0.
- Add monitoring/alerts and operator runbook for ambiguous/failed rows.
- Keep email dry-run until P6.

**Files:** `lib/notifications/config.ts`, `worker.ts`, `queue.ts`, `types.ts`, `transports/whatsapp-gateway.ts`, jobs/monitoring, tests.

**DB:** ack fields/gateway table from P2; no new tables if already applied.

**Exit:** two workers claim once; gateway timeout resolves without duplicate; logged-out session queues; cap/priority proven; controlled live send still works; kill switch/allowlist tested.

**Rollback:** revert worker transport selection and claim ordering; keep additive schema; disable live mode.

---

## 7. Phase 5 — H-36 activation

**Goal:** one controlled reminder, then a bounded rollout.

Preconditions: P4; approved copy; event with ≤500 issued tickets; one internal recipient; tick healthy.

Work:

- Add truncation guard/alert for exactly 500 tickets; document the launch limit.
- Approve/review timezone copy; no template redesign unless required.
- Controlled event at T-36h; verify one row per phone, one send, replay zero.
- Verify reschedule/cancel/archive and already-started behavior.
- Widen to a small real event; monitor queue/ack.

**Exit:** one live reminder observed; re-run adds zero; cancellation produces none; truncation is visible; rollback tested.

**Rollback:** dry-run/disable; queued reminders stay; no deletion.

**Open blocker:** >500-ticket events require a pagination/cursor design; do not claim support.

---

## 8. Phase 6 — Purchase proof, ticket-issued and SMTP

**Goal:** live email + WhatsApp for one settled order.

Preconditions: P4; SMTP implemented/tested; nodemailer advisory decision recorded; one controlled paid order.

Work:

- Implement real SMTP transport behind the existing interface; fail closed without host/from.
- Enable `EMAIL_TRANSPORT=smtp` in allowlist mode; WhatsApp already live.
- Controlled order: email and WhatsApp independent; one provider id per channel.
- Replay webhook, run `sweep:purchase-proof`, verify zero duplicates.
- Run ticket-issued for the same/next controlled order.
- Decide PDF separately; do not add attachments here.
- Add delivery visibility to the operator runbook.

**Exit:** one live email and one live WhatsApp proof observed; replay zero; invalid contact skips only its channel; ticket-issued same; kill switch works.

**Rollback:** set both transports dry-run / notifications off; queued rows remain; no payment data changed.

---

## 9. Phase 7 — PIC scanner real-DB verification (independent)

**Goal:** replace mocked evidence with recorded MariaDB evidence.

Work:

- Provision disposable `_test` schema; run real integration tests.
- Two-connection check-in race: one success, one duplicate.
- Rollback on forced failure; no `CheckIn` row.
- Foreign event/unassigned/suspended PIC: masked 404/403.
- Rate limit 120/min keyed by `(userId,eventId)`; limiter failure → 503; `Retry-After` decision.
- Audit persistence `actorKind`, `picProfileId`.
- Record command, exit status and counts.

**Exit:** real-DB suite passes with recorded output; no production data touched.

**Rollback:** tests isolated; revert code if needed; no schema change.

**Dependency:** none on WhatsApp; can run in parallel with P2-P4.

---

## 10. Phase 8 — Feature 4 design and migration approval

**Goal:** approve the document design before code.

Work:

- Finalize schema, indexes, relations, retention, recipient eligibility, PIC visibility, link-bearer policy.
- Produce proposed SQL/Prisma diff and rollback plan; apply nothing.
- Threat model: forwarded links, malware, PII, cross-tenant, blast abuse.
- Approve ClamAV/scanner operational prerequisite.
- Approve initial document cap and recipient limit per campaign.

**Exit:** signed design/migration approval; no DDL applied.

**Rollback:** not applicable (documentation only).

---

## 11. Phase 9 — Feature 4 backend

**Goal:** private upload, frozen recipients, bounded enqueue, secure access, reporting.

Work:

- Apply approved additive migration in a controlled environment.
- Storage/validation/scanner; fail closed.
- Organizer/PIC authorization; recipient selection IDs only.
- `event-document-dispatch` bounded job (e.g. 100 recipients/tick); template; secure link.
- Access route; audit; retention/revocation.
- Tests: authz matrix, duplicate, cross-tenant, expiry, malware failure, large batch.

**Exit:** PIC can upload to assigned completed event; selected recipient can access; unselected cannot; delivery tracked; no public path; no duplicate on replay.

**Rollback:** disable document routes/job; keep tables; revoke links; do not delete notifications. Drop tables only after export/approval.

---

## 12. Phase 10 — Feature 4 UI and controlled blast

**Goal:** usable PIC surface and a small live blast.

Work:

- Upload/metadata, masked recipient selection, channel choice, confirmation, progress/history.
- No public link, no bulk raw export, no "send to all" without explicit confirmation.
- Dry-run first; then one internal recipient; then a small approved cohort.
- Verify caps, priority, access revocation, failure report.

**Exit:** controlled blast observed; unselected recipient denied; re-run adds none; audit complete; rollback tested.

**Rollback:** revoke document/links, disable job, keep audit; storage purge per policy.

---

## 13. Phase 11 — Hardening (conditional)

Only if the deployment moves beyond one process/VPS:

- shared rate-limit store (Redis or approved equivalent);
- object storage with private access;
- horizontal worker/gateway ownership design;
- CSP nonce to remove `'unsafe-inline'`;
- deeper queue analytics/APM.

Do not start this phase to compensate for a missing single-owner design.

---

## 14. Exact implementation dependencies

### 14.1 Runtime and packages

| Dependency | Current state | Needed for |
|---|---|---|
| `@whiskeysockets/baileys@6.7.24` | **present** (`package.json:45`) | Gateway |
| `nodemailer@8.0.11` | **present** (`package.json:55`) | SMTP |
| `tsx` | **not a direct dependency** | Worker/gateway scripts |
| `dotenv` | **not a direct dependency**; imported by worker | Worker/gateway env loading |
| `qrcode` | **present** | Terminal pairing QR |
| ClamAV/approved scanner | **not present** | Document upload |
| `DOCUMENT_LINK_SECRET` | **not present** | Signed links |
| `WA_GATEWAY_TOKEN` / `WA_SESSION_ENCRYPTION_KEY` | **not present** | Gateway auth/session |
| SMTP credentials/provider | **not present** | Email |
| Real MariaDB `_test` | **unavailable** (`TEST_DATABASE_URL` unset) | DB evidence |

### 14.2 Operational dependencies

- persistent encrypted volume for `WA_AUTH_DIR`;
- persistent `UPLOAD_DIR` with backup;
- PM2 (or equivalent) supervision and startup-on-boot;
- cron for `/api/internal/jobs/tick`;
- monitoring/alert channel;
- host-only pairing access;
- approved WhatsApp number and recipient for the controlled test.

### 14.3 Sequencing dependencies

- P1 before P2/P3: worker must be runnable/supervised.
- P2 before P3: no pairing until encrypted state/ownership/idempotency exist.
- P3 before P5/P6: no live feature activation before one controlled send.
- P4 before P5/P6/P9: retry/ambiguity/caps must be correct.
- P7 independent; do not block scanner verification on WhatsApp.
- P8 before P9; P9 before P10.
- Do not start feature 4 before P4 even though its schema is independent; it reuses the transport.

---

## 15. Files expected to change, by phase

| Phase | Files (proposed or existing) |
|---|---|
| P1 | `package.json`, lockfile, `ecosystem.config.cjs`, deployment runbook |
| P2 | new `lib/whatsapp/gateway/*`, `scripts/whatsapp-gateway.ts`, `scripts/whatsapp-pair.ts`, `lib/notifications/transports/whatsapp-gateway.ts`, `prisma/schema.prisma` (proposed), tests |
| P3 | environment/host only; no code expected except operational scripts |
| P4 | `lib/notifications/config.ts`, `worker.ts`, `queue.ts`, `types.ts`, `transports/whatsapp-gateway.ts`, `lib/jobs/tick.ts` (ack/cap), monitoring |
| P5 | `lib/notifications/h36-reminder.ts`, template/registry if copy changes, tests |
| P6 | `lib/notifications/transports/smtp.ts`, config/worker selection, tests, operator UI optional |
| P7 | tests only; `lib/ticketing/checkin/*` only if a defect is found |
| P8 | `docs/implementation-planning/*`, proposed migration file (not applied) |
| P9 | `prisma/schema.prisma` + migration, `lib/event-documents/*`, API routes, template, jobs, tests |
| P10 | `app/dashboard/events/[id]/documents/*`, `app/dashboard/pic/documents/*`, components, tests |
| P11 | infra/scale changes only |

No file in this table is changed by the planning task itself.

---

## 16. Database changes proposed

| Phase | Change | Applied? |
|---|---|---|
| P2/P4 | `WhatsAppGatewayMessage` + state enum; ack fields/enum on `NotificationDelivery`; `NotificationCategory.DOCUMENT`; indexes | No |
| P8/P9 | `EventDocument`, `EventDocumentRecipient`, `EventDocumentDelivery`; enums; relation fields; indexes | No |
| None | No change to `Event.documentationUrl`; no data migration/backfill | No |

**All migrations require separate approval and a controlled environment.** No migration was generated or run.

---

## 17. Security risks and gates

| Risk | Gate |
|---|---|
| Account takeover via QR/session | Host-only pairing; encrypted state; 0700/0600; no web route; no QR in logs |
| Split-brain socket | DB lease + file lock; `replaced` stops; no cluster |
| Duplicate send after timeout | Gateway dispatch idempotency; terminal ambiguous |
| Spam/ban | One socket, delay, caps, priority, no broadcast endpoint |
| PII exposure | Masked logs; recipient only in queue; document list masked; no token in payload/logs |
| Malware | Magic bytes + ClamAV; fail closed; attachment disposition |
| Cross-tenant/cross-event | Event-derived organizer; exact PIC assignment; 404 masking |
| Authz reuse | Document permission separate from `checkin.scan` |
| Secret leakage | Host env/secret manager; no `env_file` in PM2; no secret in docs/logs |
| Stale session backup | Treat as `PAIRING_REQUIRED`; never replay blindly |

---

## 18. Testing requirements

Minimum by phase:

| Phase | Evidence |
|---|---|
| P1 | Worker heartbeat + alert when stopped; no database writes with switch off |
| P2 | Unit/contract tests with fake socket; no outbound network; ownership/idempotency |
| P3 | One controlled live send; replay zero; restart/reconnect; logout handling |
| P4 | Two-worker claim; timeout/ambiguous; cap/priority; queue-on-gateway-down |
| P5 | One live reminder; replay zero; cancel/reschedule; truncation |
| P6 | One live email + WhatsApp; replay zero; independent channel failure |
| P7 | Real MariaDB race/rollback/authz/rate-limit evidence |
| P8 | Reviewed design + proposed SQL; no applied DDL |
| P9 | Authz matrix, duplicate, cross-tenant, expiry, malware failure, large batch |
| P10 | Controlled blast; unselected denied; revoke; audit complete |
| P11 | Load/scale evidence for the changed component |

See `testing-and-acceptance-criteria.md` for cases.

---

## 19. Rollback summary

1. Set `NOTIFICATIONS_ENABLED=false` or live mode `dry-run`; stop worker/gateway.
2. Keep queue rows; never delete delivery history to "reset".
3. Revert code/PM2; keep additive schema until a safe migration rollback.
4. Revoke document links; disable document job; export audit before dropping tables.
5. Re-pair WhatsApp only if the session is invalid; do not restore a stale session and replay.

---

## 20. Final recommendation

Approve P0 and P1 first. The highest-value safe engineering work is P1 plus P7 (real-DB check-in evidence), because it improves operability and verifies an already-built security feature without connecting WhatsApp. P2/P3 must wait for explicit approval of session custody and the dedicated number. Feature 4 remains design-only until P8 is signed off.
