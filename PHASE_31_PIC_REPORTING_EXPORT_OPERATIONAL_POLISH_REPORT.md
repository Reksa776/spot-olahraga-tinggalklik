# PHASE 31 — PIC REPORTING, EXPORT & OPERATIONAL POLISH

**Verdict: PASS** — reporting, export, reconciliation visibility and operational polish are
implemented on top of the authoritative Phase 30 money ledger, without changing the Phase 30
financial contract.

Date: 2026-09-24 · Branch: `main` · No commit · No push · No DB reset · No destructive migration.

---

## 1. What was already implemented (audited, left unchanged)

Phase 30 shipped the authoritative money layer, and this phase consumes it rather than
re-deriving anything:

| Surface | Where | Status |
|---|---|---|
| Canonical balance `Σ CREDIT − Σ DEBIT` | `lib/pic/ledger.ts` — `getPicLedgerBalance` / `getPicLedgerBalances` | reused as-is |
| Platform PIC list total (`ledgerTotal`) | `lib/pic/service.ts` — `listPicsForAdmin` | whole-ledger, canonical |
| Platform PIC detail totals (`balance`, `totalsByType`) | `lib/pic/service.ts` — `getPicDetail` | whole-ledger aggregate; table keeps `take: 100` |
| Settlement list + detail (gross/deduction/net, items, proof) | `lib/ticketing/settlement/service.ts` + `payload.ts` | already correct |
| Carried post-paid reversal labelled | `lib/ticketing/settlement/settlement.ts` — `description: "Pembatalan sesudah dibayar (REVERSAL)"` | already visible to operators |
| Settlement detail UI renders gross/deduction/net + items with `direction`/`description` | `app/dashboard/settlements/[id]/page.tsx` | already correct |
| Tenant isolation / SoD / own-scope guards | `lib/authz` | untouched |
| Audit infrastructure (`writeTicketingAudit`, sanitizer) | `lib/ticketing/audit-log.ts` | extended, not redesigned |
| Admin aggregate regression tests (0/earned/reversal/payout/combined/>100/unknown types) | `__tests__/ticketing-pic/admin-pic-totals.integration.test.ts` | Phase 30, still green |
| Settlement + carried-reversal tests | `__tests__/ticketing-pic/settlement*.integration.test.ts` | Phase 30, still green |

**No money formula was rewritten.** Every new module calls `getPicLedgerBalance` or a
`groupBy`/`aggregate` on `direction`, in `Prisma.Decimal`.

---

## 2. What was missing

1. **No PIC own report.** `lib/pic/self-service.ts` exposed a fee *ledger list* (`listMyFeeLedger`)
   and an overview, but no filterable financial report and no canonical gross/reversal/payout/net summary.
2. **No CSV export at all.** `report.export.own_pic_fee` and `report.export.pic_fee` existed in the
   permission map but were consumed by nothing; there was no CSV writer anywhere in the repo
   (`grep` for `text/csv`/`toCsv` returned zero).
3. **No tenant (organizer) PIC financial reporting.**
4. **No reconciliation view.** The EARNED↔REVERSAL↔PAYOUT and settlement-consumption relationships
   were only inspectable by reading the ledger by hand.
5. **No export audit trail.** Financial exports, once added, had no audit action to record them.
6. **A latent full-suite flake.** Each of the ~100 database-backed Jest sandboxes builds its own
   `PrismaClient` whose pool is never closed (`forceExit` skips `$disconnect`), so a long run could
   cross MySQL's `max_connections` (151). See §17.

---

## 3. What was changed

### 3.1 `lib/csv.ts` (new, pure) — one CSV writer

- `toCsv(columns, rows)` — RFC 4180 quoting (`,` `"` CR LF), CRLF records, stable column order.
- `neutralizeCsvFormula` — prefixes `'` when a **`text`** cell starts with `= + - @ TAB CR`.
- `CsvColumn.kind` — `"text"` (untrusted free text → neutralised) vs `"value"` (default: exact
  string, never neutralised).
- `withUtf8Bom` / `UTF8_BOM`.
- **Why the `kind` split matters:** a legitimate negative money value begins with `-`. Neutralising
  every cell would corrupt the ledger's own sign; neutralising a PIC display name or event title is
  required. Money/id/date/enum/count columns are always `value` and are never passed through `Number()`.

### 3.2 `lib/pic/reporting.ts` (new) — the PIC's own report + export

- `resolvePicFeeReportFilters` — server-side filter parsing. Unknown `type`/`status` is a
  `VALIDATION_ERROR` (not a silently ignored filter); `from > to` is a `VALIDATION_ERROR`.
- `buildPicFeeLedgerWhere` — the Prisma `where`, always scoped to one `picProfileId`.
- `loadPicFeeReportSummary` — **canonical whole-ledger summary** (`grossEarned`, `totalReversals`,
  `totalPayouts`, `credit`, `debit`, `netBalance`) from `getPicLedgerBalance` + a `groupBy(type)`.
  Deliberately **not** narrowed by the row filters, so a filter can never create a second "balance".
- `getMyPicFeeReport(userId, query)` — rows are `select`ed with event/order refs, `settlementId`,
  `refundId`, `reversalRef`, `rateBp`, `basisType/Amount`, `quantity`, `status`, `createdAt`;
  `PIC_FEE_LEDGER_ROW_SELECT` is a fixed projection.
- `exportMyPicFeeCsv(userId, query)` — the **whole filtered set** (the report's `page`/`pageSize` are
  ignored), ordered ascending, exact `Decimal` strings.
- Authority: `requireMyPic(userId, [pic_fee.read.own] [+ report.export.own_pic_fee])`.

### 3.3 `lib/pic/tenant-reporting.ts` (new) — organizer/tenant report

- `getOrganizerPicFeeReport(organizerId, query)` — per-PIC canonical `earned/reversals/payouts/
  netBalance/entryCount` from three `groupBy`s over the whole ledger; `requireOrganizerAccess(
  organizerId, pic_fee.read.all)`. `organizerId` is a routing key, never authority.
- `exportOrganizerPicFeeCsv(organizerId, query)` — adds `report.export.pic_fee`; PIC display name is
  a neutralised `text` column, money is `value`.

### 3.4 `lib/pic/reconciliation.ts` (new) — operational reconciliation

- `getPicFeeReconciliation(picProfileId, organizerId?)` — read-only breakdown:
  - `earned`: `total` = `settled` + `unsettled` (split on `settlementId`);
  - `reversal`: `total` = `consumed` (has `settlementId`) + `carried` (its order item's unique EARNED
    is already settled → the D-18 post-paid shape) + `pending` (that EARNED is still open);
  - `payout`: total + count;
  - `balance`: canonical `credit/debit/net` from `getPicLedgerBalance`;
  - `checks`: `earnedSplits`, `reversalSplits`, `netMatchesDirection`.
- Unguarded by design (documented) — every caller authorizes first.

### 3.5 API routes (new)

| Route | Authority |
|---|---|
| `GET /api/reports/my-pic-fee` | session ACTIVE PIC profile + `pic_fee.read.own` |
| `GET /api/reports/my-pic-fee/export` | + `report.export.own_pic_fee`; `text/csv; charset=utf-8`, BOM, `Content-Disposition: attachment` |
| `GET /api/reports/pic-fee-reconciliation` | `organizerId` → `pic_fee.read.all` on that tenant; else platform `pic.manage` |
| `GET /api/organizer/pic-fee-report` | `pic_fee.read.all` on the named tenant |
| `GET /api/organizer/pic-fee-report/export` | + `report.export.pic_fee` |

`proxy.ts`: `/api/reports/` added to `PROTECTED_API_PREFIXES` (the route-classification test
enumerates every route on disk and fails on any unclassified one). `/api/organizer/` was already protected.

### 3.6 `lib/ticketing/audit-log.ts` — audit actions (Part K)

Added two actions and one entity type (additive; the sanitizer is unchanged):

- `report.export.pic_fee` and `report.export.own_pic_fee`;
- `entityType: "Report"`.

Both export functions call `writeTicketingAudit` (fire-and-forget, matching the existing
non-financial convention) with **counts and filters only** — `entityRef` is the PIC profile id
(own export) or the organizer id (tenant export). No bank account, token, secret, QR payload or
credential is ever passed; the shared sanitizer also strips forbidden keys.

### 3.7 UI (minimal, Part M)

- `app/dashboard/pic/page.tsx` — an **"Ekspor CSV"** plain anchor on the "Ringkasan Fee" card
  (a plain `<a>`, because `Content-Disposition: attachment` cannot ride a client-side `<Link>`).
- `app/dashboard/pic/[id]/page.tsx` — a **"Rekonsiliasi fee"** card driven by
  `getPicFeeReconciliation`, showing EARNED settled/unsettled, REVERSAL consumed/carried/pending,
  PAYOUT, the canonical net, and the three reconciliation check badges. It is safe to call after
  `getPicDetail`, which already enforced the platform/tenant guard.

No "Withdraw" button. No automatic payout. No wallet.

### 3.8 Test infrastructure (Part L / §17)

- `jest.teardown-env.ts` (new) + `setupFilesAfterEnv` in `jest.config.js` — disconnects the
  per-sandbox Prisma pool at the end of each test file.

### 3.9 `lib/pic/self-service.ts`

- `requireMyPic` is now `export`ed (it already existed; reporting reuses it rather than
  re-implementing "who is the PIC"). No behaviour change.

---

## 4. Files changed

**New (Phase 31):**
- `lib/csv.ts`
- `lib/pic/reporting.ts`
- `lib/pic/tenant-reporting.ts`
- `lib/pic/reconciliation.ts`
- `app/api/reports/my-pic-fee/route.ts`
- `app/api/reports/my-pic-fee/export/route.ts`
- `app/api/reports/pic-fee-reconciliation/route.ts`
- `app/api/organizer/pic-fee-report/route.ts`
- `app/api/organizer/pic-fee-report/export/route.ts`
- `__tests__/ticketing-pic/pic-csv.test.ts`
- `__tests__/ticketing-pic/pic-reporting.integration.test.ts`
- `jest.teardown-env.ts`
- `PHASE_31_PIC_REPORTING_EXPORT_OPERATIONAL_POLISH_REPORT.md`

**Modified (Phase 31 hunks only):**
- `proxy.ts` — `/api/reports/` protected
- `lib/ticketing/audit-log.ts` — 2 actions + `"Report"` entity type
- `lib/pic/self-service.ts` — `export` on `requireMyPic`
- `app/dashboard/pic/page.tsx` — export link
- `app/dashboard/pic/[id]/page.tsx` — reconciliation card
- `jest.config.js` — `setupFilesAfterEnv`

**Already dirty before Phase 31 (untouched by this phase):** `__tests__/authz/role-matrix.integration.test.ts`,
`__tests__/ticketing-checkout/checkout-wiring.test.ts`, `__tests__/ticketing-refunds/refund-manual-rail.integration.test.ts`
(Phase 30), `__tests__/ui-consolidation/*`, `app/api/events/[slug]/share/route.ts`,
`app/dashboard/layout.tsx`, `app/e/[slug]/page.tsx`, `components/dashboard/DashboardAppShell.tsx`,
`components/events/TicketPurchaseForm.tsx`, `components/platform/PicManager.tsx`,
`lib/dashboard/scope.ts`, `lib/pic/service.ts`, `lib/ticketing/checkout.ts`,
`lib/ticketing/payment/settlement.ts`, `lib/ticketing/refunds/settlement.ts`,
`lib/ui/route-inventory.ts`, `prisma/schema.prisma`, plus the untracked Phase 29/30 modules,
migrations and reports.

---

## 5. Authorization matrix

| Actor | Report read | Export | Recon |
|---|---|---|---|
| PIC (own ACTIVE profile) | `pic_fee.read.own`, profile resolved from session | + `report.export.own_pic_fee` | — |
| CUSTOMER with an ACTIVE profile | **FORBIDDEN** (no fee family) | **FORBIDDEN** | — |
| Organizer OWNER/MANAGER/FINANCE | `pic_fee.read.all` on that tenant | + `report.export.pic_fee` | `pic_fee.read.all` on that tenant |
| Other tenant's OWNER | **ORGANIZER_ACCESS_DENIED** | **ORGANIZER_ACCESS_DENIED** | **ORGANIZER_ACCESS_DENIED** |
| Platform ADMIN | `pic.manage` (recon across tenants) | — (ADMIN deliberately lacks `report.export.own_pic_fee`) | `pic.manage` |
| Unauthenticated | **UNAUTHORIZED** | **UNAUTHORIZED** | **UNAUTHORIZED** |

No client-supplied `picProfileId`, `organizerId` or `settlementId` ever grants authority:
`picProfileId` is resolved from the session inside `requireMyPic`; `organizerId` is re-checked by
`requireOrganizerAccess` against the session actor. The Phase 29/30 Admin authorization design is
unchanged.

---

## 6. Money formula used

Exactly one, unchanged from Phase 30:

```
net = Σ CREDIT − Σ DEBIT          (Prisma.Decimal, whole ledger, no time box, no take)
CREDIT: EARNED            DEBIT: REVERSAL, PAYOUT
```

- `lib/pic/ledger.ts` remains the only balance implementation.
- The report summary, tenant per-PIC totals and reconciliation all call it (or a `direction`
  `groupBy`), so list/detail/report/export/reconciliation cannot drift.
- The report **summary is not narrowed by the row filters** — a filter narrows the transaction list
  only, so exactly one "balance" number exists per PIC.
- No `Number()` is used for any financial calculation; `Number()` appears only in pre-existing
  display formatters (`formatIdr`) that Phase 31 did not change.

---

## 7. Export format

- `text/csv; charset=utf-8`, UTF-8 BOM, `Content-Disposition: attachment`.
- CRLF records, trailing newline, stable header order.
- Own-fee columns:
  `createdAt,event,orderNumber,orderItemId,ledgerType,direction,amount,feeType,rateBp,basisType,basisAmount,quantity,status,settlementId,refundId,reversalRef`
- Tenant columns: `picCode,picName,picStatus,earned,reversals,payouts,netBalance,entryCount`
- Money/enum/id/date cells are `"value"` (exact `Decimal(14,2)` string, never a float, never
  neutered). Free text (`event`, `picName`) is `"text"` and formula-prefix-neutralised.
- The export is the **whole filtered set** — UI pagination can never truncate a download.

---

## 8. Date/time contract

- A date-only filter (`YYYY-MM-DD`) is an **Asia/Jakarta calendar day** (`+07:00`):
  `from` → `T00:00:00.000+07:00`, `to` → `T23:59:59.999+07:00`.
- A full ISO timestamp is taken as the exact instant given.
- The browser's timezone cannot alter results; `from > to` is rejected.
- No global timezone architecture was redesigned. Settlement `periodStart`/`periodEnd` and
  `createdAt`/`paidAt` semantics are unchanged.

---

## 9. Reconciliation rules

```
EARNED    = settled (settlementId set) + unsettled (settlementId null)
REVERSAL  = consumed (settlementId set)
          + carried  (settlementId null AND its orderItem's EARNED is settled)   ← D-18
          + pending  (settlementId null AND its orderItem's EARNED is still open)
PAYOUT    = total DEBIT PAYOUT rows
net       = Σ CREDIT − Σ DEBIT
```

Checks asserted in code and in tests: `earnedSplits`, `reversalSplits`, `netMatchesDirection`.
No mathematically different formula; a reversal with a `NULL` `orderItemId` is conservatively
`pending` (never `carried`), matching the Phase 30 writer, which never produces one.

---

## 10. Tests added

`__tests__/ticketing-pic/pic-csv.test.ts` (pure, 11 tests) — RFC 4180 quoting, CRLF/trailing
newline, stable order, null/empty cells, header-only document, formula neutralisation of text,
**negative money preserved verbatim**, `withUtf8Bom`.

`__tests__/ticketing-pic/pic-reporting.integration.test.ts` (real DB + real guards, 30 tests):

| Part L item | Tests |
|---|---|
| 1 PIC own report authorization | UNAUTHORIZED, NOT_FOUND (no profile), FORBIDDEN (CUSTOMER-role), session-scoped read |
| 2 PIC cross-PIC denial | forged `userId` → `PIC_ACCESS_DENIED` (report + export) |
| 3 organizer tenant isolation | own tenant exact, other tenant denied, second owner sees only their own, unauthenticated |
| 4 admin aggregate correctness | covered by Phase 30 `admin-pic-totals` (canonical list/detail/helper reconcile) |
| 5 >100 ledger rows | 120 rows: totals 120.00 regardless of page |
| 6–8 CSV format/escaping/injection | `pic-csv` suite + `=HYPERLINK` event title neutralised in the real export |
| 9 Decimal preservation | `100.00`/`40.00`/`0.01`/`0.02` exact, no `Number()` round-trip, negative balance `-40.00` |
| 10 date boundaries | exact start, exact end, just before, just after, month, year, exact ISO instant |
| 11 settlement report correctness | Phase 30 `settlement.integration.test.ts` (gross/deduction/net, masked bank, replay) |
| 12 reconciliation correctness | settled/unsettled, consumed/carried/pending, checks, empty PIC |
| 13 empty states | zero rows → zeros + header-only export; empty reconciliation all checks true |
| 14 pagination not affecting totals | page 1 vs page 2 same summary; pageSize capped at 200; export 120 rows |
| 15 export not leaking unauthorized rows | own export excludes the other PIC; tenant export excludes the other tenant |
| extra | export writes an audit row with no bank/token/secret in metadata; unknown filter → `VALIDATION_ERROR` |

---

## 11. Full test result

```
Test Suites: 107 passed, 107 total
Tests:       2148 passed, 2148 total
Snapshots:   2 passed, 2 total
```

Also green with the brief's exact command:

```
npm test -- --runInBand   →  Test Suites: 107 passed, 107 total
                             Tests:       2148 passed, 2148 total
```

Focused Phase 31 run: `__tests__/ticketing-pic/pic-reporting.integration.test.ts` +
`pic-csv.test.ts` = **41 tests passed**. Focused
`ticketing-pic + pic-self-service + authz + ui-consolidation + ticketing-refunds + ticketing-checkout`
= **36 suites / 618 tests passed**.

---

## 12. Typecheck

`npx tsc --noEmit` → **clean** (no output).

## 13. Lint

`npm run lint` → **0 errors**, 3 pre-existing `@next/next/no-img-element` warnings in
`app/e/[slug]/page.tsx` and `components/events/EventCard.tsx` (not touched by this phase).

## 14. Build

`npm run build` → **PASS** (all routes compiled; `/api/reports/*` and
`/api/organizer/pic-fee-report/*` present; proxy/middleware compiled).

## 15. Prisma validation

`npx prisma validate` → **"The schema at prisma/schema.prisma is valid 🚀"**.
**No schema change in Phase 31.**

## 16. Migration status

`npx prisma migrate status` → 27 migrations found; **3 not applied to the development DB**
(the pre-existing Phase 29/30 additions):

```
20260922000000_add_event_documentation_url
20260923000000_add_pic_fee_snapshots
20260924000000_add_pic_fee_proportional_reversals
```

Left unapplied, as instructed. The **test** database (which the suites use) already has all 27
(`global-setup` refuses a run whose test DB is behind). No migration was created in Phase 31.

---

## 17. Security findings

1. **Fixed (test environment): MySQL connection exhaustion.** Each Jest sandbox builds its own
   `PrismaClient` (pool = `cpus*2+1` = 17 here) and `forceExit` skips `$disconnect`, so pools
   accumulated until MySQL's `max_connections=151` was crossed (`Max_used_connections = 152`).
   Symptom: `Too many database connections opened: ERROR HY000 (1040)` in a *different, unrelated*
   suite each run (first run: `payment-races`, `session-gate`, `session-trust`, `dashboard-access`;
   second run: `pic-self-service/entry`, `session-gate`, `session-trust`) — every one of which passes
   in isolation. This is a capacity race, not a logic bug. Fixed in test infrastructure only
   (`jest.teardown-env.ts` + `setupFilesAfterEnv`), which disconnects each file's pool while leaving
   the pool size at its default so the genuine 5–8-way concurrency tests keep exercising real races.
   Verified: two consecutive full runs (including `--runInBand`) are green. No application code,
   schema or migration was changed for this.
2. **Formula injection** is neutralised for untrusted text only; money keeps its sign (see §7).
3. **No over-broad logging:** export audit rows carry counts and filters, never a bank account,
   token, secret or credential.
4. **No new authorization path:** every read/export re-checks the existing guards; no client id is
   trusted as authority.
5. **Cross-tenant attempts are denied** (`ORGANIZER_ACCESS_DENIED` / `PIC_ACCESS_DENIED`), proven by tests.

---

## 18. Remaining gaps

- The three additive dev/DB migrations still need `prisma migrate deploy` in a deployment step
  (unchanged from Phase 30; not applied here by instruction).
- The report/export/reconciliation are exposed as APIs plus a PIC export link and a reconciliation
  card. There is no dedicated standalone "Reports" page for them; if one is wanted it is a pure UI
  add-on over the existing endpoints.
- A `REVERSAL` row with `orderItemId = NULL` is reported as `pending` (conservative), though the
  Phase 30 writer never creates one.
- Report row paging has no total-row-count cap beyond `pageSize ≤ 200`; the export is always the
  whole filtered set (intentional — a download must not be truncated).

---

## 19. Git status

```
 M __tests__/authz/role-matrix.integration.test.ts          (pre-existing)
 M __tests__/ticketing-checkout/checkout-wiring.test.ts     (pre-existing)
 M __tests__/ticketing-refunds/refund-manual-rail.integration.test.ts   (Phase 30)
 M __tests__/ui-consolidation/route-inventory.test.ts       (pre-existing)
 M __tests__/ui-consolidation/shadcn-dashboard.test.ts      (pre-existing)
 M app/api/events/[slug]/share/route.ts                     (pre-existing)
 M app/dashboard/layout.tsx                                 (pre-existing)
 M app/dashboard/pic/[id]/page.tsx                          (Phase 31 hunk + pre-existing)
 M app/dashboard/pic/page.tsx                               (Phase 31 hunk + pre-existing)
 M app/e/[slug]/page.tsx                                    (pre-existing)
 M components/dashboard/DashboardAppShell.tsx               (pre-existing)
 M components/events/TicketPurchaseForm.tsx                 (pre-existing)
 M components/platform/PicManager.tsx                       (pre-existing)
 M jest.config.js                                           (Phase 31)
 M lib/dashboard/scope.ts                                   (pre-existing)
 M lib/pic/service.ts                                       (pre-existing)
 M lib/ticketing/audit-log.ts                               (Phase 31 hunk + pre-existing)
 M lib/ticketing/checkout.ts                                (pre-existing)
 M lib/ticketing/payment/settlement.ts                      (pre-existing)
 M lib/ticketing/refunds/settlement.ts                      (pre-existing)
 M lib/ui/route-inventory.ts                                (pre-existing)
 M prisma/schema.prisma                                     (pre-existing)
 M proxy.ts                                                 (Phase 31)
?? PHASE_29A_…, PHASE_29_…, PHASE_30_… (reports)
?? PHASE_31_PIC_REPORTING_EXPORT_OPERATIONAL_POLISH_REPORT.md (Phase 31)
?? PIC_BUSINESS_FLOW…, PIC_PAYOUT_SETTLEMENT…, PIC_SELF_SERVICE…, PIC_VERTICAL_SLICE…
?? __tests__/pic-self-service/, __tests__/ticketing-pic/     (incl. Phase 31 tests)
?? app/api/organizer/pic-fee-report/                         (Phase 31)
?? app/api/reports/                                          (Phase 31)
?? app/api/organizer/settlements/, app/dashboard/settlements/, components/dashboard/{CopyLinkButton,SettlementActions,SettlementPrepareForm}.tsx
?? jest.teardown-env.ts                                      (Phase 31)
?? lib/csv.ts, lib/pic/reconciliation.ts, lib/pic/reporting.ts, lib/pic/tenant-reporting.ts   (Phase 31)
?? lib/pic/attribution.ts, lib/pic/fee.ts, lib/pic/ledger.ts, lib/pic/referral.ts, lib/pic/self-service.ts   (Phase 29/30)
?? lib/ticketing/settlement/, prisma/migrations/2026… snapshots + reversals
```

Files marked "(pre-existing)" were already dirty when Phase 31 began and were **not** touched by
this phase. `app/dashboard/pic/page.tsx` and `lib/ticketing/audit-log.ts` contain both earlier
uncommitted work and this phase's hunks (the Phase 31 hunks are described in §3).

---

## 20. Explicit confirmation

- **No commit.**
- **No push.**
- **No DB reset.** (`prisma migrate reset` was never run.)
- **No destructive migration.** No migration was created in Phase 31; Prisma schema is unchanged.

Phase 30 financial contract preserved: append-only ledger · `Decimal` money · idempotency ·
CAS/concurrency · future net-off · proportional reversal · tenant isolation · SoD · existing
Admin authorization.
