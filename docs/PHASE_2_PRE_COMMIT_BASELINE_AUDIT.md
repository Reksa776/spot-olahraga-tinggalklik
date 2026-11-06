# PHASE 2 — PRE-COMMIT BASELINE AUDIT

**Project:** TinggalKlik.Co
**Repository:** `/home/reksa/tinggalklik`
**Audit date:** 6 November 2026
**Mode:** READ-ONLY. No file was staged, committed, stashed, reset, rebased, checked out, cleaned, or deleted. No database command was run.
**Scope:** Phase 2 notification work and the uncommitted Phase 0A/0B/0C/Phase 1 work it depends on.

---

## 1. Executive Summary

A safe baseline is possible, but it cannot be one flat `git add -A` commit. The working tree contains **15 modified tracked files and 48 untracked files** (49 once this report exists), spanning four workstreams plus one unrelated local change. The notification runtime is a **single dependency-connected component**: Phase 1 and both Phase 2 features share `templates.ts`, `worker.ts`, `queue.ts`, `config.ts`, `.env.example`, `package.json`, and `jest.teardown-env.ts`. At file granularity there is **no buildable Phase 1-only commit** and **no clean purchase-proof-only vs post-issuance-only split**.

The recommended baseline is **four ordered commits**:

1. Phase 0A — fail-closed Jest database isolation.
2. Phase 0B/0C — dependency pins and reports.
3. Phase 1 + Phase 2 — the notification runtime, both hooks, both sweeps, and their tests (one atomic commit).
4. Phase 1/Phase 2 documentation.

Three items must stay out: `.cloud-attachments/` (a 1.1 MB imported conversation containing credential-shaped text), `lib/authz/permissions.ts` (an unrelated PIC permission with no consumer), and the pre-existing tracked `storage/uploads/affiliate/ktp/**` identity-card images (a separate security issue, not a Phase 2 change).

The reports are substantially accurate about the Phase 2 source, with three corrections: the post-issuance report omits the new `lib/app-origin.ts` change that the ticket helper requires; its “D-46 unresolved” statement is superseded by the owner approval; and the D-46 readiness report’s phrase “settlement and issuance callers” refers to two distinct helpers, not two callers of one helper (resolved in §7).

**Baseline status: READY WITH CONDITIONS** — no technical blocker prevents the four groups from being committed in order, but the owner must accept the mixed dependency change and the exclusions first.

---

## 2. Repository and Git State

| Check | Result |
|---|---|
| Repository root | `/home/reksa/tinggalklik` |
| Branch | `main` |
| HEAD | `25cbf0c6893f79292be4580a056003c54753ff12` — `fix landing paaage` |
| Recent history | `25cbf0c`, `05bb474 revisi flow checkout`, `22bd4de fix ui navbar1` |
| Staged changes | **none** (`git diff --cached` empty) |
| Stashes | none |
| Modified tracked files | **15** |
| Untracked files | **48** (49 after this report) |
| Ignored but present | `.env`, `.next/`, `node_modules/`, `tsconfig.tsbuildinfo`, `next-env.d.ts`, `.freebuff/` |
| Whitespace check | `git diff --check` → exit 0 |
| Working tree changed by this audit | **No** (only this report was created) |

**Modified tracked files (15):**

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

**Untracked files (48):** enumerated and classified in §3. They fall into `lib/notifications/` (17), `__tests__/notifications/` (12), `__tests__/support/` (2), `__tests__/ticketing-issuance/` (1), `scripts/` (3), root reports (6), `docs/` (5), `jest.safety.config.js` (1), and `.cloud-attachments/` (1).

**Commit diff sizes:**

| File | +/− |
|---|---|
| `.env.example` | +74 / −2 |
| `__tests__/support/test-database.ts` | +205 / −72 |
| `__tests__/support/fixture-teardown.ts` | +24 / −33 |
| `__tests__/support/global-setup.ts` | +15 / −34 |
| `jest.config.js` | +10 / −19 |
| `jest.setup-env.ts` | +2 / −16 |
| `jest.teardown-env.ts` | +23 / 0 |
| `lib/app-origin.ts` | +13 / −3 |
| `lib/authz/permissions.ts` | +4 / 0 |
| `lib/ticketing/payment/settlement.ts` | +26 / 0 |
| `lib/ticketing/tickets/issuance.ts` | +5 / 0 |
| `package-lock.json` | +741 / −90 |
| `package.json` | +11 / −5 |
| `prisma/schema.prisma` | +14 / −3 |
| `scripts/setup-test-db.ts` | +31 / −103 |

---

## 3. Complete File Classification

Legend: **M** = modified tracked, **U** = untracked, **Shared** = contains more than one workstream and cannot be split without hunk staging.

### 3.1 Phase 0A — Jest database isolation

| File | State | Notes |
|---|---|---|
| `__tests__/support/test-database.ts` | M | Replaces derivation from `DATABASE_URL` with explicit `TEST_DATABASE_URL` validation, same-server proof, `_test` suffix, alias checks, Prisma constructor guard |
| `__tests__/support/global-setup.ts` | M | Resolves the explicit test URL; never probes the application DB |
| `__tests__/support/fixture-teardown.ts` | M | Cleans only the validated test DB; application DB is no longer a target |
| `jest.setup-env.ts` | M | Delegates fail-closed validation to `applyTestDatabaseUrl` |
| `jest.config.js` | M / Shared | Phase 0A isolation comments plus the Phase 1 `__tests__/notifications` glob |
| `scripts/setup-test-db.ts` | M | Becomes read-only verification; no create/migrate/seed |
| `jest.safety.config.js` | U | Isolated config for the support tests (no global DB setup) |
| `__tests__/support/test-database.safety.test.ts` | U | Rejection/acceptance tests with mocked Prisma |
| `__tests__/support/test-database.prisma-guard.test.ts` | U | Tests the real PrismaClient binding guard without querying |
| `PHASE_0A_JEST_DATABASE_ISOLATION_REPORT.md` | U | Phase 0A report |

**Mixed documentation:** `.env.example` adds the `TEST_DATABASE_URL` block (Phase 0A) but the file is dominated by the notification block; handled as a shared file in §5/§10.

### 3.2 Phase 0B — Payment migration

| File | State | Notes |
|---|---|---|
| `PHASE_0B_PAYMENT_MIGRATION_REPORT.md` | U | Report only. The migration `prisma/migrations/20260929000000_add_payment_active_order_id/migration.sql` is already committed (last touched by `22006bb`); `prisma/migrations` has no working-tree change |

**Conclusion:** Phase 0B has **no code or schema change** to commit. It is documentation, not a baseline dependency.

### 3.3 Phase 0C — Dependency vulnerability baseline

| File | State | Notes |
|---|---|---|
| `package.json` | M / Shared | Adds `@whiskeysockets/baileys@6.7.24`, `nodemailer@8.0.11`, `@types/nodemailer@8.0.2`; bumps Next `16.3.6→16.4.3`, axios `1.19→1.21`, zod `4.4.3→4.6.7`, `eslint-config-next`; adds three notification scripts |
| `package-lock.json` | M | Corresponding lock changes, including Next/axios/zod and the Baileys/nodemailer transitive graph |
| `PHASE_0C_DEPENDENCY_VULNERABILITY_REPORT.md` | U | Phase 0C report |

**Owner-review point:** this is not a Phase 2-only dependency change. The Next/axios/zod bumps are Phase 0C baseline changes and will be included in the same commit as the notification scripts unless the file is hunk-split.

### 3.4 Phase 1 — Notification foundation

| File | State | Notes |
|---|---|---|
| `lib/notifications/config.ts` | U | Kill switch, transport clamp, `PHASE_1_DRY_RUN_ONLY`, plus Phase 2 WhatsApp cap/delay parsing |
| `lib/notifications/enqueue.ts` | U | Idempotent enqueue; imports `templates.ts` (which registers both Phase 2 templates) |
| `lib/notifications/logger.ts` | U | Structured logging and redaction |
| `lib/notifications/queue.ts` | U | Claim/CAS/retry/lease; includes Phase 2 WIB day boundary and WhatsApp send count |
| `lib/notifications/templates.ts` | U / Shared | Registry: `phase1.dry-run.v1`, `purchase-proof.v1`, `ticket-issued.v1` |
| `lib/notifications/types.ts` | U | Transport contract; plain text only, no attachment field |
| `lib/notifications/worker-lock.ts` | U | `joblock` worker lease |
| `lib/notifications/worker.ts` | U / Shared | Batch dispatch, dry-run transports, Phase 2 recipient validation, delay, daily cap |
| `lib/notifications/transports/smtp.ts` | U | Fail-closed stub; always throws; no nodemailer import |
| `lib/notifications/transports/baileys.ts` | U | Fail-closed stub; always throws; no Baileys import |
| `lib/notifications/transports/dry-run.ts` | U | Dry-run transports used by the worker |
| `scripts/notification-worker.ts` | U | Separate polling process entrypoint |
| `__tests__/notifications/logging.test.ts` | U | Log redaction |
| `__tests__/notifications/queue.test.ts` | U | Queue CAS/retry/idempotency; one premise updated by Phase 2 to use a still-unknown template key |
| `__tests__/notifications/transports.test.ts` | U | Transport clamp and static no-provider guards |
| `__tests__/notifications/worker.test.ts` | U | Worker dry-run, lease, shutdown, ambiguity |
| `prisma/schema.prisma` | M | Phase 1 only: maps the legacy `notificationType` column with a client-side default; no DDL |
| `PHASE_1_PRE_IMPLEMENTATION_AUDIT_REPORT.md` | U | Phase 1 audit |
| `PHASE_1_IMPLEMENTATION_REPORT.md` | U | Phase 1 implementation report |

### 3.5 Phase 2 — Purchase proof

| File | State | Notes |
|---|---|---|
| `lib/notifications/contacts.ts` | U / Shared | Email/phone normalization; used by the worker and by both Phase 2 helpers |
| `lib/notifications/store-contact.ts` | U / Shared | `PlatformSetting` contact read model; used by both helpers |
| `lib/notifications/purchase-proof-template.ts` | U / Shared | `purchase-proof.v1` renderer; also exports `formatPurchaseProofDate` used by the ticket template |
| `lib/notifications/purchase-proof.ts` | U | Snapshot builder, enqueue, idempotency keys, recovery sweep |
| `scripts/purchase-proof-sweep.ts` | U | Manual enqueue-only sweep CLI |
| `__tests__/notifications/purchase-proof-template.test.ts` | U | Template/contact/store-contact tests |
| `__tests__/notifications/purchase-proof-wiring.test.ts` | U / Shared | Static guards for the settlement hook and provider gates; also asserts the issuance/ticket helper boundary |
| `__tests__/notifications/purchase-proof-worker.test.ts` | U | Recipient skip, WhatsApp delay/cap, dry-run, log privacy |
| `__tests__/notifications/purchase-proof.integration.test.ts` | U | Real-DB enqueue, settlement hook, idempotency, sweep, legacy isolation |
| `lib/ticketing/payment/settlement.ts` | M | Adds the `SETTLED`-only, post-commit `enqueuePurchaseProof` call |
| `.env.example` | M / Shared | Adds `WHATSAPP_DAILY_CAP`, `WHATSAPP_SEND_DELAY_MS`, notification worker tuning, and the Phase 0A test URL |
| `jest.teardown-env.ts` | M / Shared | Deletes `purchase-proof.v1` and `ticket-issued.v1` residue from the test DB |
| `docs/PHASE_2_PRE_IMPLEMENTATION_AUDIT.md` | U | Purchase-proof pre-implementation audit |
| `docs/PHASE_2_IMPLEMENTATION_REPORT.md` | U | Purchase-proof implementation report |

### 3.6 Phase 2 — Post-issuance ticket notification

| File | State | Notes |
|---|---|---|
| `lib/notifications/ticket-issued-template.ts` | U | `ticket-issued.v1` renderer; 20-code cap; no QR/attachment |
| `lib/notifications/ticket-issued.ts` | U | Snapshot, per-channel enqueue, 30-minute window, sweep |
| `scripts/ticket-issued-sweep.ts` | U | Manual enqueue-only sweep CLI |
| `__tests__/notifications/ticket-issued-template.test.ts` | U | Opening sentence, 20-cap, invalid codes, no secret |
| `__tests__/notifications/ticket-issued-wiring.test.ts` | U | Static guards for the issuance hook, no `qrTokenHash`, no route/migration |
| `__tests__/notifications/ticket-issued-worker.test.ts` | U | TICKET row simulation, invalid recipient, cap, log privacy |
| `__tests__/notifications/ticket-issued.integration.test.ts` | U | Independent keys, partial repair, 20-cap, sweep window, legacy isolation |
| `__tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts` | U | Issuance commit-visibility and hook-once test |
| `lib/ticketing/tickets/issuance.ts` | M | Adds one import and one post-commit `enqueueTicketIssued(order.id)` call |
| `lib/app-origin.ts` | M | Adds `getConfiguredAppOrigin()`; the ticket helper imports it. **Not listed in the post-issuance report’s changed-files table** |
| `package.json` | M / Shared | Adds the `sweep:ticket-issued` script (and the Phase 1 proof/worker scripts) |
| `jest.teardown-env.ts` | M / Shared | As above |
| `docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_AUDIT.md` | U | Post-issuance audit |
| `docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_IMPLEMENTATION_REPORT.md` | U | Post-issuance implementation report |
| `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md` | U | D-46 Option A readiness audit |
| `docs/PHASE_2_PRE_COMMIT_BASELINE_AUDIT.md` | U | This report |

### 3.7 Unrelated, unknown, or pre-existing

| File | State | Classification |
|---|---|---|
| `lib/authz/permissions.ts` | M | **Unrelated.** Adds `PIC_CHECKIN_SCAN_OWN` and grants it to own-scope/PIC roles. No consumer exists anywhere outside this file (grep). Pre-dates Phase 2; likely incomplete PIC QR-scanner work. Do not bundle |
| `.cloud-attachments/imported-conversation-653a8b1c5e11c97b09d85f6c7578c5fdf848240cb630df34c0c8ab06f927a803.json` | U | **Unrelated/local artifact.** 1.1 MB imported conversation; contains 27 `mysql://`, 5 `AUTH_SECRET`, 40 `IPAYMU`, 2 `SMTP_PASS`, 907 `DATABASE_URL`, and 9 `password` occurrences (counts only; values not read). Never commit |
| `PROJECT_PRE_FEATURE_AUDIT_REPORT.md` | U | **Context, not Phase 2.** Pre-feature audit of all four owner requests (2026-10-29). Optional historical documentation; not part of the baseline |
| `toko_backup.sql` | Tracked (HEAD) | **Pre-existing.** 0 bytes, tracked since the initial commit; not a real backup and not part of this change. Do not rely on it or delete it here |
| `storage/uploads/affiliate/ktp/**` (17 tracked files) | Tracked (HEAD) | **Pre-existing PII.** Identity-card images are committed in the repository. Not modified by this work, but a serious repository-level exposure requiring a separate owner-approved remediation (history rewrite + rotation). Do not touch in this commit |
| `scripts/verify-phase33-live.js` | Tracked (HEAD) | **Pre-existing.** Credential-shaped literal detected by the scan; not part of this change. Separate security review |
| `.env` | Ignored | Present on disk, never tracked. Never force-add |

---

## 4. Dependency Analysis

### 4.1 Why the notification runtime is one component

The production import graph is:

```
settlement.ts ──► purchase-proof.ts ──► enqueue.ts ──► templates.ts ──► purchase-proof-template.ts
      │                 │                                  └──────────► ticket-issued-template.ts
      │                 ├──► contacts.ts
      │                 ├──► logger.ts
      │                 └──► store-contact.ts

issuance.ts ───► ticket-issued.ts ──► enqueue.ts / contacts.ts / logger.ts / store-contact.ts
      │                 ├──► ticket-issued-template.ts ──► purchase-proof-template.ts (date formatter)
      │                 └──► app-origin.ts (getConfiguredAppOrigin; new in working tree)

worker.ts ──► config.ts / logger.ts / contacts.ts / queue.ts / templates.ts / transports/dry-run.ts / worker-lock.ts
scripts/*.ts ──► the corresponding lib module
```

Consequences:

1. **`templates.ts` imports both Phase 2 templates.** Committing it before either template file produces a TypeScript error.
2. **`enqueue.ts` imports `templates.ts`.** A Phase 1-only commit that includes `enqueue.ts` but not both Phase 2 templates cannot compile.
3. **`worker.ts` imports `contacts.ts`.** `contacts.ts` is classified as Phase 2 purchase proof, yet the worker needs it; a Phase 1-only worker commit cannot compile.
4. **`ticket-issued.ts` imports `getConfiguredAppOrigin`.** That function exists only in the working-tree modification of `lib/app-origin.ts` (HEAD exports only `getAppOrigin`). A commit of `lib/notifications/**` without `lib/app-origin.ts` cannot compile.
5. **`settlement.ts` imports `purchase-proof.ts` and `logger.ts`.** A commit of the settlement hook alone cannot compile.
6. **`issuance.ts` imports `ticket-issued.ts`.** A commit of the issuance hook alone cannot compile.
7. **`jest.teardown-env.ts` references both template keys.** It is safe alone (a delete against no rows), but belongs with the Phase 2 runtime.
8. **`package.json` scripts reference `scripts/notification-worker.ts`, `purchase-proof-sweep.ts`, and `ticket-issued-sweep.ts`.** The file is install-safe without them, but `npm run worker:notifications`/`sweep:*` fail until the runtime commit.
9. **`prisma/schema.prisma` is a runtime dependency, not just a type dependency.** The live `notification` table has `notificationType VARCHAR(191) NOT NULL` with no default; without the mapping, inserts fail with a null-constraint violation. This is why Phase 1’s schema change must ship with the enqueue code.
10. **`jest.config.js` is mixed.** Its Phase 1 notification glob is harmless in a Phase 0A commit (it matches nothing until the tests are committed), which is why it can ship first.

### 4.2 Dependency-ordered answer

| If you commit only… | Result |
|---|---|
| `lib/notifications/**` | **Fails typecheck**: `ticket-issued.ts` needs the new `getConfiguredAppOrigin`; `templates.ts` needs both templates (present if whole dir, but `app-origin` is not) |
| `lib/ticketing/payment/settlement.ts` | **Fails typecheck**: missing `lib/notifications/purchase-proof` and `logger` |
| `lib/ticketing/tickets/issuance.ts` | **Fails typecheck**: missing `lib/notifications/ticket-issued` |
| `__tests__/notifications/**` | **Fails typecheck**: missing `lib/notifications` |
| `scripts/*.ts` | **Fails typecheck**: missing `lib/notifications` |
| `package.json` alone | Lock mismatch risk; scripts point at uncommitted files (runtime only) |
| `package-lock.json` alone | `npm ci` mismatch with `package.json` |
| `prisma/schema.prisma` alone | Valid, but notification inserts still cannot run without the enqueue code |
| `lib/app-origin.ts` alone | Safe; no consumer until `ticket-issued.ts` exists |
| `jest.config.js` alone | Safe; the unmatched glob matches nothing |
| `jest.teardown-env.ts` alone | Safe; deletes against absent template keys |

**Therefore:** the safe unit is **one commit containing the complete notification runtime plus both hooks, both sweeps, the schema mapping, the origin helper, and all notification tests.** Splitting Phase 2 into purchase-proof and post-issuance commits would require hunk-level staging of at least `templates.ts`, `worker.ts`, `config.ts`, `queue.ts`, `.env.example`, `package.json`, `jest.teardown-env.ts`, and `purchase-proof-wiring.test.ts` — and the resulting intermediate tree would not have been tested. That is not a safe baseline.

---

## 5. Diff Review of the Proposed Phase 2 Files

### 5.1 Production changes

| File | Diff | Assessment |
|---|---|---|
| `lib/ticketing/payment/settlement.ts` | +26, no deletions | One post-commit `if (settled.outcome === "SETTLED")` block with `try/catch`; imports `logger` and `purchase-proof`. Non-throwing by contract. No change inside the transaction |
| `lib/ticketing/tickets/issuance.ts` | +5, no deletions | One import and one `await enqueueTicketIssued(order.id)` after `writeTicketingAudit`, inside `if (created.length > 0)`. Transaction, locking, retry, return values untouched |
| `lib/app-origin.ts` | +13 / −3 | Extracts `getConfiguredAppOrigin()` from `getAppOrigin()`; behavior of `getAppOrigin` unchanged (it delegates to the new function). Required by the ticket helper |
| `prisma/schema.prisma` | +14 / −3 | Adds `notificationType String @default("SYSTEM")` and comments. **No migration, no DDL.** Needed because the live column is `NOT NULL` without a DB default |
| `.env.example` | +74 / −2 | Adds `TEST_DATABASE_URL`, `NOTIFICATIONS_ENABLED="false"`, dry-run transports, commented SMTP/WA placeholders, Phase 2 cap/delay, worker tuning. No real credentials |
| `jest.teardown-env.ts` | +23 | Deletes `purchase-proof.v1` and `ticket-issued.v1` rows from the test DB only. Test isolation, no production code |
| `package.json` | +11 / −5 | Dependency pins and three scripts. Mixed Phase 0C + Phase 1/2 |
| `package-lock.json` | +741 / −90 | Lock update for the above; includes Next 16.4.3, axios 1.21, zod 4.6.7, nodemailer 8.0.11, Baileys 6.7.24 and their transitive graph |
| `lib/authz/permissions.ts` | +4 | **Unrelated** PIC scan permission; no consumer. Excluded from the baseline |

### 5.2 New modules

| Module | Contract | Safety review |
|---|---|---|
| `config.ts` | Kill switch + transport clamp; `PHASE_1_DRY_RUN_ONLY = true`; Phase 2 cap/delay | A live transport cannot be selected |
| `enqueue.ts` | One notification + one delivery per call; unique key; registered template only | No sender |
| `logger.ts` | Structured JSON; redacts secret-named fields, masks recipients, sanitizes errors | No credential/recipient leaks |
| `queue.ts` | CAS claim, lease, retry/backoff, ambiguity recovery, WhatsApp daily count | No sender |
| `templates.ts` | Registry of exactly three keys | Unknown key is terminal |
| `types.ts` | Plain-text email/WhatsApp message shapes | **No attachment field** |
| `worker.ts` | Separate-process batch; dry-run transports; recipient validation; WhatsApp pause/cap | Refuses injected `smtp`/`baileys` kinds |
| `worker-lock.ts` | `joblock` lease | Single-flight |
| `transports/smtp.ts` | Always throws; no `nodemailer` import | Inactive |
| `transports/baileys.ts` | Always throws; no Baileys import, no session/QR | Inactive |
| `transports/dry-run.ts` | Simulated sends | Never `SENT` |
| `contacts.ts` | Email predicate; Indonesian `08…` → `62…`; invalid refused | No guessing |
| `store-contact.ts` | Narrow `PlatformSetting` read | Only populated fields |
| `purchase-proof-template.ts` | `purchase-proof.v1`; 10 items, 20 tickets; IDR/date formatting | No internal IDs/QR |
| `purchase-proof.ts` | Snapshot + two independent keys + sweep | Enqueue only |
| `ticket-issued-template.ts` | `ticket-issued.v1`; 20 codes; wallet link; no QR | No `TICKET:`/`qrTokenHash` |
| `ticket-issued.ts` | Public codes only; 30-min window; two independent keys; sweep | Enqueue only; non-throwing |
| `scripts/*.ts` | Operator worker/sweeps | No send path in the sweeps |

**No source change in the proposed set activates SMTP or Baileys, performs a real send, alters the schema, or adds a migration.**

---

## 6. Do the Reports Represent the Current Source?

| Report claim | Current source | Verdict |
|---|---|---|
| Post-issuance hook is at `issuance.ts` line 644, inside `if (created.length > 0)`, after `writeTicketingAudit` | Import line 7; branch line 610; audit line 618; call line 644 | **Accurate** |
| `ticket-issued.v1` caps at 20 codes | `const MAX_TICKETS = 20`; `codes.slice(0, MAX_TICKETS)` | **Accurate** |
| 30-minute window shared by hook and sweep | `TICKET_NOTIFICATION_WINDOW_MS = 30 * 60_000`; `isWithinTicketNotificationWindow` | **Accurate** |
| Independent keys `ticket-issued:{orderNumber}:{channel}:v1` | `ticketIssuedIdempotencyKey` | **Accurate** |
| `ticketId: null`, `category: "TICKET"` | `enqueueOneChannel` | **Accurate** |
| Never selects `qrTokenHash`; no raw token | `ORDER_SELECT` selects only `ticketCode`; no `generateQrToken` | **Accurate** |
| Wallet URL from `getConfiguredAppOrigin()`; no request header | `ticket-issued.ts:186`; guard test rejects `next/headers`/`x-forwarded-host` | **Accurate, but see next row** |
| Report §14 “Files Changed” lists all changed production files | `lib/app-origin.ts` is a changed production file required by the helper, but is **missing** from the report’s list | **Inaccurate/incomplete** |
| “D-46 is unresolved” (`§17`/`§20`) | D-46 Option A is now approved; `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md` records it | **Superseded, not wrong at the time** |
| “The one owner-requested element not fully delivered is the QR/ticket section in the normal flow” (purchase-proof report) | The separate post-issuance `ticket-issued.v1` feature now delivers codes + wallet link after issuance; proof at settlement still has no tickets (correct by design) | **Historical; the gap is now closed by the separate feature** |
| Test totals 36 + 32 + 3,628 | Not rerun in this audit; test files and names exist | **NOT VERIFIED** (historical evidence) |
| Phase 0B “no changes to `prisma/` in the working tree” | Current tree has `prisma/schema.prisma` modified (Phase 1 mapping); migration itself is committed | **Stale as a current-state description** |
| Phase 1 “10 pre-existing modified + 8 untracked” | Current tree is 15 modified + 48 untracked | **Stale as a current-state description** |
| D-46 audit: “settlement and issuance paths are the only callers” | Two separate helpers, one production caller each; see §7 | **Wording imprecise, substance correct** |

**Overall:** the Phase 2 reports accurately describe the Phase 2 implementation logic and security properties. They are less reliable as a *commit inventory*: the post-issuance report omits `lib/app-origin.ts`, and the Phase 0/1 reports describe an earlier, smaller working tree.

---

## 7. Resolution of the Issuance/Settlement Caller Discrepancy

There is **no contradiction in the code**. There are two distinct helpers, one hook each:

### 7.1 Purchase proof

- Helper: `enqueuePurchaseProof(orderId)` in `lib/notifications/purchase-proof.ts:303`.
- Production caller: `settleVerifiedPayment()` in `lib/ticketing/payment/settlement.ts:629-631`.
- Condition: `settled.outcome === "SETTLED"` only; after commit.
- Key: `purchase-proof:{orderNumber}:{channel}:v1`.
- Business event: money verified and seats sold.

### 7.2 Ticket issued

- Helper: `enqueueTicketIssued(orderId)` in `lib/notifications/ticket-issued.ts:272`.
- Production caller: `issueTicketsForOrder()` in `lib/ticketing/tickets/issuance.ts:644`.
- Condition: `created.length > 0` only (`ALREADY_ISSUED` never enters); after commit.
- Key: `ticket-issued:{orderNumber}:{channel}:v1`.
- Business event: ticket rows actually created.

### 7.3 Why the earlier wording was ambiguous

- The post-issuance report says “the helper” and “the issuance hook” because that report is about `enqueueTicketIssued` only. It is correct.
- The D-46 readiness report said “settlement and issuance paths are the only callers.” That means the two **integration paths** — settlement for the proof, issuance for the ticket message — not two callers of one helper. It should have said “the settlement and issuance paths are the only production integration points.”
- The authoritative static guard is `__tests__/notifications/purchase-proof-wiring.test.ts`:
  - settlement imports `enqueuePurchaseProof` once and calls it once;
  - issuance imports `enqueueTicketIssued` once and calls it once;
  - no webhook, webhook route, checkout route, issue route, settlement, or purchase-proof module imports `ticket-issued`.
- The sweep functions call their own helper internally (recovery), and tests call them directly; these are not additional production hooks.

**Resolution:** no code change is required. The correct baseline description is: **one settlement hook for purchase proof, one issuance hook for ticket-issued, both post-commit and non-throwing.**

---

## 8. Secrets, Credentials, Local Data, and Generated Artifacts

| Item | Finding | Action |
|---|---|---|
| `.env` | Present on disk; ignored by `.gitignore:3` | Never force-add; never read into a commit |
| `.env.example` | Only placeholders (`USERNAME`, `PASSWORD`, `replace-with-a-random-secret`); `SMTP_PASS` commented empty | Safe to commit |
| `.cloud-attachments/…json` | 1.1 MB imported conversation; 27 `mysql://`, 5 `AUTH_SECRET`, 40 `IPAYMU`, 2 `SMTP_PASS`, 907 `DATABASE_URL`, 9 `password` occurrences (counts only) | **Exclude.** Do not `git add -A`; consider a later approved `.gitignore` entry (`/.cloud-attachments/`) |
| `storage/uploads/affiliate/ktp/**` | **17 tracked files**, identity-card images | **Pre-existing PII incident.** Do not include in this commit; owner-approved removal/history rewrite required. Do not delete in this audit |
| `toko_backup.sql` | Tracked, 0 bytes, initial commit | No data leak; exclude from the commit narrative; separate cleanup decision |
| `scripts/verify-phase33-live.js` | Tracked; credential-shaped literal detected | Pre-existing; not part of this change; separate security review |
| `tsconfig.tsbuildinfo`, `.next/`, `next-env.d.ts` | Ignored generated artifacts | Never stage |
| Phase 2 code/docs | No private-key/cloud-key/session-token pattern found | Safe |
| Test fixtures | Use fake addresses/phones and `mysql://app:secret@…` test URLs | Acceptable test data; scanners may flag, but no real credential |
| `docs/` reports | No credential values found | Safe, subject to the report-accuracy note in §6 |

**Secret-scan commands (paths/counts only, values not printed):**

```
grep -rIlE 'AKIA…|BEGIN … PRIVATE KEY|ghp_…|sk-…|eyJ…' lib/notifications scripts __tests__/notifications docs .env.example package.json
→ none found

grep -c 'mysql://|AUTH_SECRET|IPAYMU|SMTP_PASS|DATABASE_URL|password' .cloud-attachments/…json
→ 27 / 5 / 40 / 2 / 907 / 9 occurrences
```

---

## 9. Potential Accidental Inclusion Risks

| Command / action | Risk |
|---|---|
| `git add -A` or `git add .` | Stages `.cloud-attachments/` (1.1 MB conversation with credential-shaped text), all reports, and every untracked file. **Do not use** |
| `git commit -a` | Stages `lib/authz/permissions.ts` (unrelated PIC permission) together with the Phase 2 hooks. **Do not use** |
| `git add lib/notifications` | Typecheck fails: `ticket-issued.ts` needs the new `getConfiguredAppOrigin`; `templates.ts` needs both templates |
| `git add lib/ticketing/payment/settlement.ts` | Typecheck fails: missing `lib/notifications/purchase-proof` and `logger` |
| `git add lib/ticketing/tickets/issuance.ts` | Typecheck fails: missing `lib/notifications/ticket-issued` |
| `git add __tests__/notifications` | Typecheck fails: missing `lib/notifications` |
| `git add scripts/notification-worker.ts` (or either sweep) | Typecheck fails: missing `lib/notifications` |
| `git add package.json` without `package-lock.json` | `npm ci` lock mismatch |
| `git add package-lock.json` without `package.json` | Same |
| `git add storage` or `git add -f storage` | Adds/refreshes tracked KTP identity images; **never** |
| `git add -f .env` | Leaks real credentials; **never** |
| `git add docs` | Safe, but includes this audit and all reports; intended only in the docs commit |
| `git add prisma/schema.prisma` alone | Valid, but a notification insert would still fail without the enqueue code; harmless alone, but pointless |
| `git add lib/app-origin.ts` alone | Safe; no consumer until the ticket helper exists |

**Additional risk:** the repo has no `.gitignore` entry for `.cloud-attachments/`; an IDE “stage all” or a future `git add -A` will include it. Adding the ignore rule is a configuration change requiring separate owner approval.

---

## 10. Proposed Commit Groups

The groups are file-level and ordered so every commit is independently checkable. Paths are exact.

### Commit 1 — Phase 0A: fail-closed Jest database isolation

**Rationale:** independent of notifications; changes the test harness that every later check relies on. The notification glob in `jest.config.js` is harmless here because no notification tests are committed yet.

```
__tests__/support/test-database.ts
__tests__/support/test-database.safety.test.ts
__tests__/support/test-database.prisma-guard.test.ts
__tests__/support/global-setup.ts
__tests__/support/fixture-teardown.ts
jest.setup-env.ts
jest.config.js
jest.safety.config.js
scripts/setup-test-db.ts
PHASE_0A_JEST_DATABASE_ISOLATION_REPORT.md
```

**Note:** `jest.config.js` contains the Phase 1 notification test glob. If the owner wants a pure 0A commit, hunk-split that 5-line block into Commit 3; the file-level plan above is build-safe.

**Optional hunk:** `.env.example` `TEST_DATABASE_URL` block. If not hunk-split, it ships in Commit 3.

### Commit 2 — Phase 0B/0C: dependency baseline and reports

**Rationale:** pins the dependency graph that later commits and tests assume. Phase 0B has no code; its migration is already in HEAD. `package.json` and `package-lock.json` must ship together.

```
package.json
package-lock.json
PHASE_0B_PAYMENT_MIGRATION_REPORT.md
PHASE_0C_DEPENDENCY_VULNERABILITY_REPORT.md
```

**Note:** `package.json` also adds the Phase 1/2 scripts; they are inert until Commit 3. `npm run worker:notifications` / `sweep:*` will fail between Commit 2 and Commit 3 — expected and harmless. The dependency diff also contains Next/axios/zod upgrades from Phase 0C, not Phase 2; the owner should accept them as part of the baseline.

### Commit 3 — Phase 1 + Phase 2: notification runtime, hooks, sweeps, tests

**Rationale:** this is the first buildable and testable state. It is one commit because the modules form a single import closure and the shared files carry both Phase 2 features (see §4).

```
lib/notifications/config.ts
lib/notifications/contacts.ts
lib/notifications/enqueue.ts
lib/notifications/logger.ts
lib/notifications/purchase-proof-template.ts
lib/notifications/purchase-proof.ts
lib/notifications/queue.ts
lib/notifications/store-contact.ts
lib/notifications/templates.ts
lib/notifications/ticket-issued-template.ts
lib/notifications/ticket-issued.ts
lib/notifications/transports/baileys.ts
lib/notifications/transports/dry-run.ts
lib/notifications/transports/smtp.ts
lib/notifications/types.ts
lib/notifications/worker-lock.ts
lib/notifications/worker.ts
lib/ticketing/payment/settlement.ts
lib/ticketing/tickets/issuance.ts
lib/app-origin.ts
prisma/schema.prisma
.env.example
jest.teardown-env.ts
scripts/notification-worker.ts
scripts/purchase-proof-sweep.ts
scripts/ticket-issued-sweep.ts
__tests__/notifications/logging.test.ts
__tests__/notifications/queue.test.ts
__tests__/notifications/transports.test.ts
__tests__/notifications/worker.test.ts
__tests__/notifications/purchase-proof-template.test.ts
__tests__/notifications/purchase-proof-wiring.test.ts
__tests__/notifications/purchase-proof-worker.test.ts
__tests__/notifications/purchase-proof.integration.test.ts
__tests__/notifications/ticket-issued-template.test.ts
__tests__/notifications/ticket-issued-wiring.test.ts
__tests__/notifications/ticket-issued-worker.test.ts
__tests__/notifications/ticket-issued.integration.test.ts
__tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts
```

**Why these files together:**

- `templates.ts` cannot compile without both template modules.
- `ticket-issued.ts` cannot compile without `lib/app-origin.ts`.
- `settlement.ts` cannot compile without `purchase-proof.ts`/`logger.ts`.
- `issuance.ts` cannot compile without `ticket-issued.ts`.
- `prisma/schema.prisma` is required for the notification insert at runtime.
- The tests import all of the above; committing them earlier breaks typecheck.

**Verification before commit (suggested):** `npx tsc --noEmit`; `npx jest __tests__/notifications --runInBand` and `npx jest __tests__/ticketing-issuance/ticket-issued-hook.integration.test.ts --runInBand` with the validated `TEST_DATABASE_URL`.

### Commit 4 — Phase 1/Phase 2 documentation

**Rationale:** the reports describe the code committed in Commit 3; keeping them separate makes the code commit reviewable without 200 KB of prose.

```
PHASE_1_PRE_IMPLEMENTATION_AUDIT_REPORT.md
PHASE_1_IMPLEMENTATION_REPORT.md
docs/PHASE_2_PRE_IMPLEMENTATION_AUDIT.md
docs/PHASE_2_IMPLEMENTATION_REPORT.md
docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_AUDIT.md
docs/PHASE_2_POST_ISSUANCE_TICKET_NOTIFICATION_IMPLEMENTATION_REPORT.md
docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md
docs/PHASE_2_PRE_COMMIT_BASELINE_AUDIT.md
```

**Optional:** `PROJECT_PRE_FEATURE_AUDIT_REPORT.md` is a historical context document, not a Phase 2 report. Commit it separately if the owner wants the audit trail complete; it is excluded from the baseline above.

### Explicitly not in any baseline commit

```
lib/authz/permissions.ts                         # unrelated PIC permission, no consumer
.cloud-attachments/…json                         # local conversation artifact, credential-shaped text
PROJECT_PRE_FEATURE_AUDIT_REPORT.md              # optional context doc, not Phase 2
toko_backup.sql                                  # pre-existing 0-byte tracked file
storage/uploads/affiliate/ktp/**                 # pre-existing tracked PII, separate security remediation
scripts/verify-phase33-live.js                   # pre-existing, separate security review
```

---

## 11. Required Ordering

| Order | Commit | Why it must come here |
|---|---|---|
| 1 | Phase 0A isolation | Later test runs depend on the explicit `TEST_DATABASE_URL` guard; it is independent of notification code |
| 2 | Phase 0B/0C dependency + reports | Pins the dependency graph and lockfile for later installs/tests; Phase 0B documentation is inert |
| 3 | Phase 1 + Phase 2 runtime | First buildable state containing all notification imports, the schema mapping, the origin helper, and both hooks |
| 4 | Documentation | Describes the committed code; no build dependency |

**Do not reorder 1 and 3:** without the Phase 0A guard, a test run can write to a non-isolated schema. **Do not reorder 2 and 3:** without the lockfile update, `npm ci` on a clean checkout can install a different dependency graph than the one tested. **Do not move Commit 3’s hooks ahead of the runtime:** `settlement.ts` and `issuance.ts` import modules that would not exist.

**If the owner insists on separating purchase proof from post-issuance:** the only safe way is hunk-level staging of the eight shared files in §4, followed by a full typecheck and targeted test run at the intermediate state. That intermediate state was never tested and is therefore **not recommended** for a first baseline. The file-level four-commit plan is the safer choice.

---

## 12. Blockers to Safely Creating a Baseline

| # | Blocker | Effect | Resolution |
|---|---|---|---|
| B1 | `lib/authz/permissions.ts` is unrelated and unclassified | `git commit -a` would smuggle an unapproved PIC permission into the Phase 2 baseline | Exclude it; decide separately whether to commit, keep, or revert (reverting is a code change and needs owner approval) |
| B2 | `.cloud-attachments/` is untracked but not ignored | Any “stage all” includes a 1.1 MB conversation with credential-shaped text | Exclude explicitly; add an approved `.gitignore` entry later |
| B3 | `package.json`/lock mix Phase 0C upgrades with Phase 1/2 scripts | The baseline includes Next `16.4.3`, axios, zod, and ESLint config bumps not introduced by Phase 2 | Owner accepts them as the Phase 0C baseline, or authorizes a hunk-split |
| B4 | `lib/app-origin.ts` is required but missing from the post-issuance report’s file list | A reviewer following the report would omit it and break the build | Include it in Commit 3; correct the report inventory in a follow-up (this report records it) |
| B5 | Test evidence is historical | The exact 36 + 32 + 3,628 counts were not rerun (Jest touches the test DB; this audit forbids DB mutation) | Before Commit 3, run the targeted suites with the validated `TEST_DATABASE_URL`; before release, run the full suite |
| B6 | Pre-existing tracked KTP images (`storage/uploads/affiliate/ktp/**`) | The repository contains identity documents; this is a security incident independent of Phase 2 | Separate owner-approved remediation (remove from index/history, rotate/review); do not touch in this commit |
| B7 | No commit authorization | The audit is read-only by instruction | Owner must approve this grouping before any staging |
| B8 | `toko_backup.sql` is a 0-byte tracked file and `scripts/verify-phase33-live.js` has a credential-shaped literal | Misleading/unsafe repository artifacts, pre-existing | Separate cleanup/security review; not part of this baseline |
| B9 | Provider activation remains unapproved | The code is dry-run only; do not treat this commit as delivery readiness | Keep `NOTIFICATIONS_ENABLED="false"`, SMTP/Baileys stubs; activation is a separate decision |

**No blocker prevents the four commits from being created after owner approval.** The blockers are acceptance, exclusion, and verification decisions, not code defects.

---

## 13. Recommended Next Action

1. **Owner review of this grouping.** Approve the four commits, the exclusion list, and the Phase 0C dependency bumps.
2. **Before staging anything:** confirm `.cloud-attachments/` and `lib/authz/permissions.ts` are not in the staging area, and never use `git add -A` / `git commit -a`.
3. **Commit 1:** stage exactly the ten Phase 0A paths; run `npx tsc --noEmit` and `npx jest --config jest.safety.config.js`; commit.
4. **Commit 2:** stage `package.json`, `package-lock.json`, and the Phase 0B/0C reports; run `npm ci` (or `npm install`) and `npx tsc --noEmit`; commit.
5. **Commit 3:** stage exactly the 39 runtime/hook/test paths; run `npx tsc --noEmit`, then the notification and issuance-hook suites with the validated `TEST_DATABASE_URL`; commit.
6. **Commit 4:** stage the eight documentation paths; commit.
7. **Separate owner decisions:** `lib/authz/permissions.ts`, `.cloud-attachments` ignore rule, tracked KTP remediation, `toko_backup.sql`/`verify-phase33-live.js` cleanup.
8. **Do not treat the baseline as provider activation.** SMTP and Baileys remain inactive; no real message may be sent.

**Final rule honored:** nothing has been staged, committed, pushed, stashed, reset, rebased, checked out, cleaned, or deleted. This report is the only artifact created by this audit.

---

## Appendix A — Commands Run (read-only)

```
git rev-parse --show-toplevel / --abbrev-ref HEAD / HEAD
git log -3 --oneline
git status --porcelain=v1 -uall
git diff --stat / --numstat
git diff -- <each modified file>
git check-ignore -v .env .env.local storage toko_backup.sql tsconfig.tsbuildinfo .next
git ls-files | grep -E '...'
git ls-files --others --exclude-standard
git show HEAD:lib/app-origin.ts
git log -1 -- prisma/migrations/20260929000000_add_payment_active_order_id/migration.sql
git diff --check
git diff --cached --stat          # empty
grep -rn 'enqueuePurchaseProof|enqueueTicketIssued'
grep -rn 'lib/notifications'
grep -rn 'getConfiguredAppOrigin|PIC_CHECKIN_SCAN_OWN'
grep -rIlE '<secret patterns>' lib/notifications scripts __tests__/notifications docs .env.example package.json
grep -c '<credential markers>' .cloud-attachments/…json   # counts only
```

**Not run:** any `git add`, `git commit`, `git push`, `git stash`, `git reset`, `git rebase`, `git checkout`, `git clean`, Jest (would touch the test database), Prisma migrate/DDL/DML, SMTP, Baileys, or real message delivery.

## Appendix B — File Counts

| Category | Count |
|---|---|
| Modified tracked | 15 |
| Untracked (before this report) | 48 |
| Untracked (after this report) | 49 |
| Proposed Commit 1 | 10 |
| Proposed Commit 2 | 4 |
| Proposed Commit 3 | 39 |
| Proposed Commit 4 | 8 |
| Explicitly excluded | 6 paths/groups |

**STOP — audit complete. No staging or commit was performed. Awaiting owner review.**
