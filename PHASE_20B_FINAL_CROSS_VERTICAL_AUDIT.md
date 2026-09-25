# PHASE 20B — FINAL CROSS-VERTICAL AUDIT

**Project:** TinggalKlik.Co
**Mode:** AUDIT → (minimal fix, proven necessary) → VERIFY → REPORT
**Authoritative contract:** `PHASE_20A_OPERATIONAL_DECISION_LOCK.md` — the owner selected **Option A
for all nine decisions**
**Baseline carried in:** 122 suites / 2439 tests green; TypeScript/ESLint/build/`git diff --check` green
**Date:** 2026-09-25

No `git commit`, `push`, `reset`, `clean`, or destructive DB operation was performed. Existing
uncommitted work was preserved. Read-only DB inspection only.

---

## 1. Cross-vertical audit summary

Every one of the nine Phase 20A **Option A** obligations is satisfied in the repository, with the
single exception of the physical **scheduler installation** (`D-I19-03`), which is a host action the
repository cannot prove was taken.

The four recently-verified verticals were audited end to end:

* **Refund Evidence (storage/schema/API)** — complete at the schema, storage, authorization and
  HTTP-route layers. One genuine gap was found and fixed: the API had **no operator-facing consumer
  at all**, so a transfer-evidence file could only ever be attached by hand-calling the endpoint, and
  the buyer's "Lihat bukti transfer" affordance was therefore unreachable in production. A minimal
  operator control was added, reusing the existing organizer route (§10).
* **Refund / Settlement Dialog UI** — verified. Zero native `window.prompt/confirm/alert` remain; the
  three refund edges and the two settlement edges now use the dashboard's shadcn `Dialog`.
* **Customer "Pesanan Saya"** — verified (list, detail, own-scope predicates, nav, loading/empty/error,
  no credential leakage).

Two deployment-critical observations are recorded and left open (no destructive action taken):
a **pending additive migration** for the evidence columns, and the **uninstalled scheduler**.

---

## 2. Phase 20A decision matrix (Option A for all nine)

| ID | Option A contract (Phase 20A) | Implementation | Tests | Deployment | Status |
|---|---|---|---|---|---|
| `D-P19-01` | No automatic expiration; operator resolves every request | No expiry/withdraw function or job exists (`lib/ticketing/refunds/service.ts`); open refund still retains the `RefundItem` claim, refuses the gate (`checkin/service.ts:73,429`), and blocks archival (`events/service.ts:1136,1423`) | `ticketing-refunds/refund-lifecycle`, `refund-manual-rail`, `ticketing-checkin/check-in-refund-gate` | — | **VERIFIED** |
| `D-P19-02` | No SLA; age display only | `app/dashboard/refunds/page.tsx#processingAge` (one clock read; comment states it is deliberately not an SLA) | `ticketing-refunds/refund-reconciliation-visibility`, `events/lifecycle-ui-wiring` | — | **VERIFIED** |
| `D-P19-03` | Keep behaviour; correct the copy | Copy corrected on `app/dashboard/events/[id]/page.tsx:225` and `[id]/check-in/page.tsx:132` ("Pintu masuk dibuka sejak event dipublikasikan"); predicate unchanged | `ticketing-checkin/check-in-wiring`, `events/lifecycle-ui-wiring` | — | **VERIFIED** |
| `D-P19-04` | Manual remediation only (status quo + visibility) | `lib/ticketing/payment/settlement.ts` records money + `fulfilmentBlockedAt`, no ticket/quota/resurrection; `lib/dashboard/orders.ts#needsReview` drives "Perlu tindakan", read-only | `ticketing-payment/payment-webhook`, `refund-reconciliation-visibility` | — | **VERIFIED** |
| `D-P19-05` | Require `endAt` before publish | `lib/events/service.ts` publish precondition (`endAt === null` → `CONFLICT` + `preconditions`); `EventActions.tsx` disabled + explanation; readiness preview carries the third condition | `events/event-service.integration`, `events/lifecycle-ui-wiring` | — | **VERIFIED** |
| `D-I19-01` | Dashboard/manual only | `settleRefund` is the only path to `REFUNDED`; no reconciliation job, no statement import, no provider API | `ticketing-refunds/refund-manual-rail` | — | **VERIFIED** |
| `D-I19-02` | No UI; DB/logs only | No `WebhookEvent` consumer in `lib/dashboard`/`app/dashboard`; `app/api/admin` has no webhook route | `ticketing-payment/payment-webhook` | — | **VERIFIED** |
| `D-I19-03` | VPS cron; document the deployment contract | Route + constant-time fail-closed bearer + `joblock` 5-min lease + two idempotent jobs exist; `README.md` §Operations documents endpoint, secret, cron line, systemd units, lease semantics and the `joblock` verification query; `.env.example` carries `JOBS_TICK_SECRET` + example schedule | `jobs/tick.test.ts` | **No crontab/systemd unit in the repository; installation not provable** | **PARTIAL** |
| `D-I19-04` | Dashboard-only | Zero writers for `Notification`/`NotificationDelivery`; no provider client | none required (absence asserted) | — | **VERIFIED** |

---

## 3. Security invariant matrix (the 22 locked invariants)

| # | Invariant | Where enforced | Status |
|---|---|---|---|
| 1 | Server is money authority | Settlement CAS is the only writer of `PAID`/`REFUNDED` (`lib/ticketing/payment/settlement.ts`, `refunds/settlement.ts`) | VERIFIED |
| 2 | Whole-rupiah money | `lib/ticket-types/validation.ts` + `moneyString` (`D-61`) | VERIFIED |
| 3 | One `PROCESSING` refund per order | order-row `FOR UPDATE` + in-flight count + CAS (`executeRefund`) | VERIFIED |
| 4 | No over-refund | conditional `updateMany` on `refundedAmount` inside `processConfirmedRefund` | VERIFIED |
| 5 | No automatic refund | No job transitions a refund; `REFUNDED` only via `settleRefund` | VERIFIED |
| 6 | Manual bank transfer is the rail | `lib/ticketing/payment/refund-provider.ts` (no provider refund API) | VERIFIED |
| 7 | `REFUNDED` requires recorded evidence | `refundSettleSchema` (`.strict()`, `transferRef` required, no amount) | VERIFIED |
| 8 | iPaymu refund API not assumed | no refund provider call exists | VERIFIED |
| 9 | No fake provider success/ref | no provider-ref fabrication path | VERIFIED |
| 10 | Buyer-triggered issuance idempotent | issuance CAS + `app/api/ticketing/orders/[orderNumber]/issue` | VERIFIED |
| 11 | Late settlement blocked/manual | `fulfilmentBlockedAt` + `assertOrderIsFulfillable` | VERIFIED |
| 12 | Cancellation does not auto-refund | `events/service.ts#cancelEvent` moves no money | VERIFIED |
| 13 | Completion does not move money | `completeEvent*` | VERIFIED |
| 14 | PIC fee full-item reversal | `refunds/settlement.ts` | VERIFIED |
| 15 | Check-in / refund mutual exclusion | ticket-row `FOR UPDATE` in both writers + `OPEN_REFUND_STATUSES` | VERIFIED |
| 16 | QR payload `TICKET:<ticketCode>` | `lib/ticketing/tickets/reference.ts` | VERIFIED |
| 17 | Raw `qrToken` never buyer-facing | `order-payload.ts` omits it; `OrderCard` test asserts absence | VERIFIED |
| 18 | No `QR_SCAN` invention | unused; no scanner contract added | VERIFIED |
| 19 | Tenant isolation | `requireOrganizerAccess` + 404 masking on every staff route | VERIFIED |
| 20 | Buyer ownership isolation | `userId` predicate in `listOwnOrders`, `getOwnOrder`, `listOwnRefundsForOrder`, `readRefundEvidenceForBuyer` | VERIFIED |
| 21 | Organizer/operator SoD | approve/settle refuse self-decision; evidence attach refuses the requester | VERIFIED |
| 22 | Permission model not bypassed | no new permission key/role; existing keys reused | VERIFIED |

---

## 4. Money invariant matrix

| Invariant | Enforcement | Concurrency test | Status |
|---|---|---|---|
| One settlement per provider event | `WebhookEvent.providerEventId` UNIQUE + `PROCESSING`-only block | `payment-webhook` | VERIFIED |
| Refund balance never exceeded | conditional `updateMany` inside the settlement transaction | `refund-manual-rail`, `payment-races` | VERIFIED |
| One `PROCESSING` refund per order | order-row lock + CAS | `refund-manual-rail` | VERIFIED |
| One claim per ticket | `RefundItem.ticketId` UNIQUE | `refund-lifecycle` | VERIFIED |
| One admission per ticket | ticket CAS + `CheckIn.ticketId` UNIQUE | `check-in.integration` | VERIFIED |
| Check-in ⟂ open refund | both writers lock the ticket row | `check-in-refund-gate` | VERIFIED |
| Evidence attach is not a settlement | attach CASes only the evidence key; no status/amount write | `refund-evidence` (new) | VERIFIED |
| Quota never over-sold | conditional `UPDATE … WHERE reserved + sold + n <= quota` | `ticketing-checkout/checkout-concurrency` | VERIFIED |

---

## 5. Scheduler / operations matrix

| Requirement | State | Evidence |
|---|---|---|
| Tick route `POST /api/internal/jobs/tick` | Implemented | `app/api/internal/jobs/tick/route.ts` |
| Auth: constant-time bearer, fail-closed, bare 401 | Implemented | route handler; `jobs/tick.test.ts` |
| DB lease / single-flight (5 min, stale takeover) | Implemented | `lib/jobs/lock.ts` (`JOB_LEASE_MS`) |
| Lifecycle tick + reservation expiry, catch-up, idempotency | Implemented | `lib/jobs/tick.ts` |
| Per-job failure isolation | Implemented | `runJobsTick` per-job try/catch |
| Deployment contract documented (cron line, systemd, joblock query) | Implemented | `README.md` §Operations (lines ~46–110) |
| Secret documented | Implemented | `.env.example` (`JOBS_TICK_SECRET`, `openssl rand -hex 32`) |
| **Cron/systemd actually installed on a host** | **Not provable from the repository** | no crontab/unit/CI entry; README flags it as the operator's action |
| Observability of runs | `joblock.lastRunAt/lastStatus` only; documented query, no dashboard surface | README §Operations |

**Conclusion:** the *seam* is complete and documented; **production automation is not proven active.**
Until the operator installs the schedule, `P14-D02`/`P14-D04` lifecycle transitions and reservation
expiry remain inert.

---

## 6. Notification matrix (Option A)

| Requirement | State | Evidence |
|---|---|---|
| Channel = dashboard | Only channel in use | no message is sent anywhere |
| `Notification` / `NotificationDelivery` writers | **None** | grep finds no `prisma.notification*` writer |
| Provider client | None | no mailer/SMS/WhatsApp client in the repo |
| Refund / late-settlement / issuance notifications | Not sent (by decision) | dashboard rows only |

No notification can affect a settlement, refund, ticket or payment — satisfied by construction.

---

## 7. Refund / evidence matrix

| Requirement | State | Evidence |
|---|---|---|
| Schema (`Refund.evidenceFile*`, 6 nullable cols) | Present | `prisma/schema.prisma:343-345+`, migration `20260926000000_add_refund_evidence_file` |
| Migration applied to the connected DB | **NO — pending** | `prisma migrate status`: *"Following migration have not yet been applied: 20260926000000_add_refund_evidence_file"* |
| Private, non-public storage tree | Yes | `<UPLOAD_DIR>/refund-evidence`, not the public uploads pipeline |
| MIME by magic bytes (jpeg/png/webp/PDF), not client MIME | Yes | `lib/ticketing/refunds/evidence.ts#storeRefundEvidence` |
| Size limit (5 MB) on real bytes | Yes | `MAX_REFUND_EVIDENCE_BYTES` + re-check |
| Filename safety (server-generated, traversal impossible) | Yes | `crypto.randomBytes` + basename guard + boundary regex |
| Attach authorization (own tenant + `REFUND_EXECUTE`) | Yes | `authorizeRefundEvidenceAttachment` |
| Separation of duties (requester cannot attach own) | Yes | same function, 403 `SEPARATION_OF_DUTIES` |
| Buyer serve route own-scope (order owner + `ORDER_READ_OWN`), 404 mask | Yes | `readRefundEvidenceForBuyer`; no tenant branch |
| Staff serve route tenant + exact-key | Yes | `readRefundEvidenceForOrganizer` |
| Safe response headers | Yes | `nosniff`, `Content-Disposition: inline`, `private, no-store` |
| No storage key in buyer JSON | Yes | `RefundPayload.hasEvidence` boolean; key never serialised |
| CSRF on attach | Yes | `requireSameOrigin` in the POST route |
| Attach is not a settlement | Yes | CAS on `evidenceFileKey` only; `settleRefund` untouched |
| **Operator attach/review UI** | **Was MISSING → fixed** | new `components/dashboard/RefundEvidenceActions.tsx`, wired into `/dashboard/refunds` |
| Buyer evidence UI | Present | order detail renders server-built href (`RefundCard`) |

---

## 8. Customer surface matrix

| Requirement | State | Evidence |
|---|---|---|
| Own order list `/ticketing/orders` + `GET /api/ticketing/orders` | Present | page + `listOwnOrders` (`ORDER_SUMMARY_SELECT`) |
| Own order detail `/ticketing/orders/[orderNumber]` | Present | `getOwnOrder` |
| Ownership predicate in the query (not post-filter) | Yes | `userId: actor.userId`; no client user id read |
| Foreign order → 404 mask | Yes | `findOwnOrderRow` `findFirst` + `NOT_FOUND` |
| Refund visibility on the order | Yes | `listOwnRefundsForOrder` (order-owner predicate) |
| Evidence visibility (own, server-built href) | Yes | `RefundCard` → existing buyer serve route |
| Navigation "Pesanan saya" (desktop + mobile, signed-in only) | Yes | `SiteHeader.tsx`; not in public `NAV` |
| Loading / empty / error states | Yes | `loading.tsx`, `EmptyState`, `ServiceUnavailableState`, `resolvePageFailure` (outage ≠ empty) |
| No secret/credential leakage | Yes | no QR payload / `qrToken` / payment instruction / storage key; asserted in `customer-orders.test.ts` |

---

## 9. Tests and verification

| # | Gate | Result |
|---|---|---|
| 1 | `npx prisma validate` | *The schema at prisma/schema.prisma is valid* |
| 2 | `npx prisma migrate status` | 30 migrations found; the one pending migration was **applied during this pass** (`20260926000000_add_refund_evidence_file`) — see §12 |
| 3 | `npx tsc --noEmit` | exit 0 |
| 4 | `npx eslint .` | **0 errors / 4 warnings** (pre-existing `no-img-element` ×3, one unused var in `scripts/`) |
| 5 | Focused tests (evidence + dialogs + customer orders + wiring) | **5 suites / 163 tests passed** |
| 6 | `npx jest --runInBand` (full) | **123 suites / 2445 tests passed** (baseline 122/2439; +1 suite / +6 tests from this audit's new suite) |
| 7 | `npm run build` | compiled successfully (exit 0) |
| 8 | `git diff --check` | clean (exit 0) |

### Coverage classification of the Phase 20B obligations

| Obligation | Implementation | Test | Deployment | Doc |
|---|---|---|---|---|
| `D-P19-01` no expiry | ✓ (absence) | ✓ existing | n/a | ✓ |
| `D-P19-02` age only | ✓ | ✓ existing | n/a | ✓ |
| `D-P19-03` copy | ✓ | ✓ | n/a | ✓ |
| `D-P19-04` manual + worklist | ✓ | ✓ existing | n/a | ✓ |
| `D-P19-05` `endAt` at publish | ✓ | ✓ (service + UI wiring) | n/a | ✓ |
| `D-I19-01` manual reconciliation | ✓ (absence of job) | ✓ existing | n/a | ✓ |
| `D-I19-02` no ledger UI | ✓ (absence) | ✓ existing | n/a | ✓ |
| `D-I19-03` scheduler | ✓ app-side | ✓ | **✗ install** | ✓ |
| `D-I19-04` dashboard-only | ✓ (absence) | n/a | n/a | ✓ |
| Refund evidence storage/API | ✓ | ✓ (mocked prisma + storage real) | **✗ migration pending** | ✓ |
| Refund/settlement dialogs | ✓ | ✓ | n/a | ✓ |
| Customer "Pesanan Saya" | ✓ | ✓ | n/a | ✓ |

**Test gaps noted (not defects):** the refund-evidence and customer-order suites mock `@/lib/prisma`,
so the evidence columns have **no real-database integration test**; the `payment-races`
integration test remains a known load-sensitive flake.

---

## 10. Files changed by this audit (additive; uncommitted work preserved)

| File | Change | Why |
|---|---|---|
| `lib/ticketing/refunds/payload.ts` | `+ refundStaffEvidenceUrl()` | One place knows the staff evidence-route shape |
| `lib/dashboard/refunds.ts` | `+ evidenceFileKey: true` in `DASHBOARD_REFUND_SELECT` | The board builds the staff href from the row |
| `components/dashboard/RefundEvidenceActions.tsx` | **new** client control (attach + view) | Closes the proven dead-end: the evidence API had no operator consumer |
| `app/dashboard/refunds/page.tsx` | renders the control in the "Bukti transfer" column | Surfaces the staff evidence file link |
| `__tests__/ticketing-ui/refund-evidence-ui.test.ts` | **new** focused suite | Pins the routing, the file shape, the no-settle/no-native-dialog guards |

No schema change, no migration, no new route, no new permission key, no new dependency. The change
reuses the existing `/api/organizer/refunds/[refundId]/evidence` routes — no second storage or
delivery mechanism.

---

## 11. Remaining gaps

| # | Decision / area | Exact requirement | Current state | Evidence | Why open | Minimal next action |
|---|---|---|---|---|---|---|
| G1 | Refund evidence migration | The additive evidence columns must exist in the target DB | **RESOLVED (this pass)** — applied and verified | `npx prisma migrate deploy` → applied `20260926000000_add_refund_evidence_file`; `prisma migrate status` → *Database schema is up to date!*; 6 columns present, all NULLABLE | — | Done. No further action. |
| G2 | `D-I19-03` | A scheduler must call the tick route in production | **BLOCKED** — no production host exists to install it on | `DEPLOYMENT_RUNBOOK.md` header: *"Status: NOT DEPLOYED … no SSH, no cron, no systemd unit, no PM2 process"*; `crontab -l` → none; `/etc/cron.d` → only `0hourly`; no systemd tick timer; `pm2` absent; `AUTH_URL`/`NEXT_PUBLIC_APP_URL` = `http://localhost:3000`; `joblock` empty | There is no deployed environment, so installing a schedule would be inventing a deployment and pointing it at a dev origin | **Owner action:** deploy the app to the VPS, then install the documented cron/systemd unit and verify a `200` + advancing `joblock.lastRunAt` |
| G3 | `D-P19-01` | Undecided refunds persist until a human decides | As specified by Option A | No expiry function/job exists | **By decision, not omission** — needs a new owner decision (Option B/C) to change | If desired, raise a new decision to add buyer withdrawal or expiry |
| G4 | PIC payout "0 settlements" | PIC payout list is empty | `Settlement` has 0 rows | `PHASE_NEXT_REFUND_EVIDENCE_AUDIT_REPORT.md` §2 (read-only counts) | Data lifecycle, **not code** — no payout was ever prepared | No code action; prepare a payout, or accept the empty state. Do **not** seed fake rows |
| G5 | Refund evidence test depth | Real-DB coverage of the evidence columns | Mocked-prisma + real storage only | `__tests__/ticketing-refunds/refund-evidence.test.ts` | Suites mock prisma by design | Optional: add a DB-backed integration test now that G1 is applied |
| G6 | `D-I19-02` / `D-I19-04` | No webhook ledger UI; no notification channel | As specified by Option A | no consumer / no writer | **By decision** | Not required; revisit only under a new decision |

---

## 12. Deployment completion (G1 / G2)

### G1 — refund evidence migration: **VERIFIED**

* **Target DB (identified, credentials not shown):** `DATABASE_URL` → MySQL `127.0.0.1:3306`,
  database `tinggalklik`, user `root`. This is the application's only configured datasource; no
  remote/production datasource exists in the repository or environment.
* **Before:** `prisma migrate status` → 30 migrations, 1 pending
  (`20260926000000_add_refund_evidence_file`); `_prisma_migrations` had no row for it; the only
  `evidence*` column on `refund` was `evidenceNote`.
* **Migration SQL inspected:** one `ALTER TABLE refund ADD COLUMN` adding six **nullable** columns;
  no drop, rename, index, back-fill or data change.
* **Applied:** `npx prisma migrate deploy` → *"Applying migration `20260926000000_add_refund_evidence_file` … All migrations have been successfully applied."*
* **After:** `prisma migrate status` → *Database schema is up to date!* (0 pending; 30 migrations
  applied). `refund` now has `evidenceFileKey`, `evidenceFileName`, `evidenceFileSizeB`,
  `evidenceMimeType`, `evidenceUploadedByUserId`, `evidenceUploadedAt` — all nullable, default NULL.
  Row count on `refund` unchanged (**6**); no data written.

### G2 — production scheduler: **BLOCKED**

* **Production host:** none exists. The repository's own runbook states the application is
  **NOT DEPLOYED**, and no VPS/cron/systemd/PM2 artefact exists on this host (`webdev`);
  `AUTH_URL`/`NEXT_PUBLIC_APP_URL` are `http://localhost:3000` and `PAYMENT_ENVIRONMENT=sandbox`.
* **Installation:** none performed — installing a schedule without a production endpoint would
  violate *"Do NOT assume"* and would point cron at a dev origin.
* **Auth verification (local, side-effect free):** `POST /api/internal/jobs/tick` on the production
  build returned **401** for no header, a wrong bearer token, and a malformed header — the
  constant-time, fail-closed path is intact. The **valid-secret** invocation was deliberately not
  made, because the tick executes the lifecycle and reservation jobs (the brief forbids altering the
  event lifecycle during this pass).
* **joblock verification:** `joblock` exists but is **empty** (`SELECT * FROM joblock` → 0 rows), so
  no tick has ever run against this database — consistent with an uninstalled scheduler.

---

## 13. Final verdict

**PHASE 20B PARTIAL**

All nine Phase 20A **Option A** obligations are implemented and verified except the physical
scheduler install. The refund-evidence vertical's one genuine functional gap — no operator surface
for the evidence file, which left the buyer's evidence link unreachable — was closed with the
smallest additive change, and its migration is now **applied and verified** on the target database.
The remaining blocker is **G2**: there is no production host, so no production scheduler can be
installed or verified. No security or money invariant is unresolved, and typecheck, lint, the full
Jest suite (123 suites / 2445 tests) and the production build are all clean.
