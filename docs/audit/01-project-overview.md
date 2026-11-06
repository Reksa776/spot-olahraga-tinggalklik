# 01 — PROJECT OVERVIEW

**Project:** TinggalKlik.co — event ticketing and event management
**Audit date:** 2026-11-06
**Repository:** `/home/reksa/tinggalklik`
**Baseline:** branch `main`, HEAD `9b8fecd99bcc74677c1805c18379241af04fddd1`
**Type:** read-only technical audit. No source, schema, migration, dependency, environment, database or production configuration was changed. This document set lives only under `docs/audit/`.

---

## 1. Purpose and business context

TinggalKlik.co is a sports/event ticketing platform. The product covers event discovery, ticket purchase, payment via iPaymu, ticket issuance with QR codes, gate check-in, PIC (partner/affiliate) attribution and fee settlement, refunds, and a unified back-office dashboard.

The audit was requested before four new objectives:

1. **H-36 WhatsApp reminder** — message ticket holders 36 hours before an event.
2. **Purchase-proof delivery** — send a receipt/e-ticket over WhatsApp or email.
3. **PIC QR scanner** — let an assigned PIC scan at their event, safely.
4. **Post-event document blast** — let a PIC send private documents to participants after the event.

**Important correction to the original premise:** features 1–3 are no longer greenfield. Current source already contains an H-36 reminder engine, purchase-proof and ticket-issued delivery pipelines, a PIC scanner page/API, Phase 3F rate limiting, and durable PIC audit attribution. Feature 4 remains unimplemented beyond a public documentation link. This audit therefore distinguishes **built**, **dry-run only**, and **missing**, instead of repeating the older "not implemented" baseline.

---

## 2. Method

- Read the current source, schema and migrations; did not infer from filenames or old reports.
- Cross-checked every status against a source file or schema line.
- Reports separate **fact**, **interpretation** and **recommendation**.
- Did not connect to any database, payment provider, SMTP server or WhatsApp socket.
- Did not run the application or send a message.
- Ran no destructive command and did not touch `.cloud-attachments/`.

**Limitation:** no database was available in this session (`TEST_DATABASE_URL` is unset). Database behaviour described here is schema/write-path analysis, not observed query output. The previously executed focused suites (11 suites, 339 tests) are cited as prior evidence only where stated.

---

## 3. Status at a glance

| Area | Status | Evidence summary |
|---|---|---|
| Next.js application | **Present** | App Router, 75 route handlers, 27 dashboard pages |
| Authentication | **Present** | Auth.js v5 JWT, Google + credentials, Prisma adapter |
| Authorization | **Present** | DB-resolved scope, permission maps, tenant/PIC deciders |
| Event lifecycle | **Present** | DRAFT→PUBLISHED→ONGOING→COMPLETED, cancel/archive, DB-leased tick |
| Checkout and inventory | **Present** | Server pricing, idempotency, quota CAS, reservations |
| iPaymu payment | **Present** | Direct/redirect, HMAC webhook, replay ledger, reconciliation |
| Ticket issuance | **Present** | Idempotent issuance, unique sequence, wallet QR |
| Check-in | **Present** | Organizer + PIC, CAS + unique CheckIn, audit, rate limit |
| Notifications | **Present but dry-run only** | Queue/worker/templates, transports clamped by code constant |
| H-36 reminder | **Built, dry-run only** | Third tick job, template, idempotent enqueue, 22 tests |
| Purchase proof | **Built, dry-run only** | Two channels, post-commit enqueue, idempotency keys |
| PIC scanner | **Built; real-DB proof missing** | Page + API + assignment authz + 3F controls |
| Post-event document blast | **Not implemented** | Only public `Event.documentationUrl` Google Drive link |
| Private file access | **Partial** | Settlement/refund evidence protected; no participant documents |
| Test database | **Not configured** | `TEST_DATABASE_URL` absent in this environment |

---

## 4. Key findings

1. **The notification layer cannot send a live message.** `PHASE_1_DRY_RUN_ONLY = true` (`lib/notifications/config.ts:38`) clamps SMTP/Baileys to dry-run. This blocks live H-36 and live purchase proofs regardless of configuration.
2. **Feature 4 is not a small extension.** There is no document entity, no participant-recipient selection, no private document storage and no blast endpoint. The current `documentationUrl` is a public Drive link shown after completion.
3. **PIC scanning is structurally separate from tenant RBAC.** PICs have no `OrganizerMember` row; authority comes from `PICProfile` + `PICEventAssignment` (`lib/authz/pic-assignment.ts`). This is sound, but it means feature 4 must add a document-specific PIC decision rather than reuse `checkin.scan`.
4. **Duplicate prevention is database-backed.** Unique keys cover webhook events, order-item ticket slots, check-in tickets, notification idempotency and issuance sequences. This is the strongest part of the system.
5. **The public ticket code is the scan credential.** The wallet QR is `TICKET:<ticketCode>`; the separate random QR token is hashed and never delivered. Possession/knowledge of a ticket code is therefore sufficient to attempt admission. This is an owner-level design decision (D-46), not a bug hidden by this audit.
6. **Operational activation is the main gap, not code volume.** SMTP/WhatsApp hosting, worker process supervision, a disposable test database and approved message copy are prerequisites for claiming production readiness.
7. **Feature 4 needs the only likely schema change.** Private documents, recipients and delivery state have no existing models; a migration proposal is required before implementation.

---

## 5. Document map

| File | Contents |
|---|---|
| `01-project-overview.md` | Scope, method, status, key findings |
| `02-technology-stack.md` | Versions, dependencies, commands, deployment |
| `03-project-architecture.md` | Layers, routing, request lifecycle, diagrams |
| `04-database-audit.md` | 36 models, relations, constraints, feature mapping |
| `05-authentication-authorization-audit.md` | Login, sessions, roles, permissions, PIC analysis |
| `06-event-management-audit.md` | Event CRUD, lifecycle, organizer/PIC links |
| `07-ticketing-transaction-audit.md` | Checkout → payment → issuance → wallet |
| `08-qr-scanner-checkin-audit.md` | QR payload, scanner, admission guarantees |
| `09-whatsapp-email-integration-audit.md` | Providers, templates, worker, dry-run |
| `10-background-job-scheduler-audit.md` | Cron, job locks, retries, H-36 readiness |
| `11-file-storage-document-audit.md` | Uploads, private files, document gap |
| `12-security-audit.md` | Access control, IDOR, CSRF, webhook, abuse |
| `13-existing-feature-inventory.md` | Modules, routes, UI, tests |
| `14-feature-gap-analysis.md` | Required 13-point analysis per feature |
| `15-implementation-roadmap.md` | Safe phase order and exit criteria |

---

## 6. Audit boundary

**In scope:** current application source, Prisma schema/migrations, route inventory, job/worker code, storage code, UI components, tests as artifacts.

**Out of scope:** production database contents, live provider dashboards, VPS/nginx/PM2 runtime state, penetration testing, load testing, dependency vulnerability rescans, legal/privacy review.

**No credentials, tokens, passwords or secrets are reproduced in this document set.**
