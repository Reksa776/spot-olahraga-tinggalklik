# PHASE 26A — RELEASE BASELINE REVIEW & COMMIT PREPARATION

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Inputs:** `PHASE_26_VPS_DEPLOYMENT_READINESS_RELEASE_BASELINE_REPORT.md`, `DEPLOYMENT_RUNBOOK.md`
**Mode:** audit only. **Nothing was staged, unstaged, committed, reset, cleaned or deleted. No file was modified.**

---

## 0. Executive summary

The working tree is a **coherent, shippable release delta**: all 106 modified/new paths trace to a
documented phase — except two generated files that must stay out of the commit (§8) — no secret of any
kind appears in the delta, no dependency or lockfile drift occurred, and the 16 staged deletions are
exactly the two stale retail workflows plus 14 legacy runtime-upload paths whose **files are all still
on disk**.

Three things surfaced that Phase 26 did not record, and one of them is a real defect:

1. **A payment-path concurrency defect**, exposed by a flaky test. `H1. eight simultaneous Pay clicks
   produce one provider payment, not eight` asserts that a burst of eight "Pay" clicks opens exactly
   **one** gateway session. It intermittently observes **two**, the second carrying a `#2`-suffixed
   reference. The guard is a read-then-write with a hole in it (§14.1). **It is pre-existing in `HEAD`
   and is not introduced or widened by this delta** — the file that contains it,
   `lib/ticketing/payment/service.ts`, is byte-identical to HEAD — so it does **not** block this commit,
   but it does mean the suite is **not reliably green** (2 of 3 full runs failed) and that a buyer who
   double-clicks can be handed two payable instruments for one order.
2. **A tracked test file that jest never runs.** `__tests__/ui/dialog-logic.test.ts` (353 lines,
   `describe`/`test`/`expect`) is committed at HEAD but is not matched by any `testMatch` entry, so it
   has never run. It requires `../../components/ui/Dialog`, a directory that no longer exists.
3. **The two tracked generated files flip on every command.** `HEAD`'s `next-env.d.ts` imports
   `./.next/dev/types/…`; the working tree imports `./.next/types/…` — i.e. it is whichever of
   `next dev` / `next build` ran last. `tsconfig.json` includes **both** paths, so the churn is
   permanent while these files stay tracked.

**Verdict: READY FOR OWNER REVIEW** (§16). The commit plan in §12 is exact and safe to execute; §14
lists what the owner should know before pressing it.

---

## 1. Current Git state

```
branch            main
HEAD              8628dbf  "integrasi dengan UI"          (unchanged)
tracked files     415
modified          48
staged            16   (all deletions)
untracked          58
```

### 1.1 The index contains EXACTLY the intended deletions — nothing else

`git diff --cached --name-status` returns 16 `D` entries and no `A` or `M`:

```
D  .github/workflows/deploy.yml
D  .github/workflows/test-vps.yml
D  storage/uploads/affiliate/ktp/cmshbsz3u0000u8xvmnwycont/*.jpg      (5)
D  storage/uploads/affiliate/social/cmshbsz3u0000u8xvmnwycont/*.jpg   (3)
D  storage/uploads/products/*.jpg | *.webp                            (6)
```

**Verified:** all 14 `storage/**` paths **still exist on disk** (14/14 confirmed file-by-file). Only the
two workflow files are gone from disk, which is the intent of deleting a tracked file. Both
`.github/workflows/deploy.yml` and the storage blobs are still present in `HEAD`'s object store
(`git cat-file -e HEAD:<path>` succeeds), so both deletions are reversible.

`.github/` no longer exists on disk at all (git pruned the directory after `git rm`).

### 1.2 The full delta at a glance

```
48 files changed, 2450 insertions(+), 996 deletions(-)      ← working tree
16 files changed, 61 deletions(-)                          ← index (deletions only)
```

---

## 2. Exact COMMIT paths

### 2.1 Modified — 48

46 are Phase 21–26 work (category A); **2 are generated files** (`next-env.d.ts`,
`tsconfig.tsbuildinfo`) and belong to category B. Grouped by the phase that produced them:

**Phase 21 (dashboard synchronisation / theme) — 9**

```
app/layout.tsx
app/dashboard/page.tsx
components/dashboard/DashboardProviders.tsx
components/dashboard/theme/theme-config.ts
components/dashboard/theme/theme-provider.tsx
components/dashboard/theme/theme-switcher.tsx
lib/dashboard/overview.ts
app/dashboard/events/page.tsx
app/dashboard/events/[id]/page.tsx
```

**Phase 22 (payment + database hardening) — 4**

```
lib/payment/ipaymu.ts                     ← deleted the dead IPAYMU_CONFIG; declared the provider's real
                                            SessionID spelling
lib/ticketing/payment/gateway.ts
lib/ticketing/payment/method-catalog.ts
lib/ticketing/payment/validation.ts       ← accepted set now derived from the catalog
```

**Phase 23A (order-404 root cause) — 2**

```
lib/authz/permissions.ts                  ← ADMIN/MANAGER own-scope permissions
__tests__/authz/permission-map.test.ts
```

**Phase 24 (auth UX, 401 handling, security headers) — 20**

```
proxy.ts                                  ← +22: the /api/health classification
next.config.ts                            ← +147: the security header layer
app/login/page.tsx
app/register/page.tsx
app/ticketing/orders/[orderNumber]/page.tsx
app/ticketing/tickets/page.tsx
app/ticketing/tickets/[ticketCode]/page.tsx
app/ticketing/refunds/page.tsx
app/e/[slug]/page.tsx
app/api/auth/register/route.ts
components/auth/LoginForm.tsx
components/auth/RegisterForm.tsx
components/orders/CancelOrderButton.tsx
components/orders/PayNowButton.tsx
components/orders/RequestRefundButton.tsx
components/tickets/IssueTicketsButton.tsx
lib/auth/redirect.ts
lib/api/errors.ts
lib/api/response.ts
components/organizer/EventForm.tsx
```

**Phase 26 (this phase) — 6**

```
.env.example            ← +143/-…: rewritten template + RUNTIME section
.gitignore              ← generated artifacts + storage/
README.md               ← health-check section + runbook pointer
lib/app-origin.ts       ← removed the ephemeral tunnel host; corrected two stale comments
eslint.config.mjs       ← ecosystem.config.cjs added to the CommonJS scope
package.json            ← engines + the two test scripts
```

**Shared test infrastructure — 5**

```
jest.config.js
__tests__/ticketing-payment/payment-harness.ts
__tests__/ticketing-checkout/checkout.integration.test.ts
__tests__/ticketing-checkout/checkout-concurrency.integration.test.ts
__tests__/ui-consolidation/shadcn-dashboard.test.ts
```

**Generated — 2 (category B, NOT to be committed)**

```
next-env.d.ts            ← HEAD holds the dev-mode variant, the tree the build-mode one (§8.2)
tsconfig.tsbuildinfo     ← a rewritten tsc cache

# 9 + 4 + 2 + 20 + 6 + 5 = 46 release files, plus these 2 generated ones = the 48 modified.
```

`shadcn-dashboard.test.ts` shows a −5/+51 line delta: the single removed `expect` was **replaced by
five**, including `expect(provider).not.toMatch(/from\s+["']next-themes["']/)`. That is a
**strengthening**, not a weakened assertion. Repo-wide, the delta removes exactly one `expect(` and adds
eleven.

### 2.2 New — 58 (category A)

**Application source — 18**

```
app/api/health/route.ts
app/api/health/ready/route.ts
app/error.tsx
app/global-error.tsx
app/not-found.tsx
app/dashboard/error.tsx
app/ticketing/error.tsx
components/errors/ErrorState.tsx
components/errors/ErrorBoundaryFallback.tsx
components/errors/InlineError.tsx
components/errors/RetryButton.tsx
components/errors/ReloadButton.tsx
components/errors/ServiceUnavailableState.tsx
components/auth/AuthShell.tsx
components/auth/AuthError.tsx
components/auth/PasswordField.tsx
components/auth/RoleSelector.tsx
components/auth/GoogleMark.tsx
```

**Library code — 9**

```
lib/auth/client-session.ts
lib/auth/roles.ts
lib/auth/session-gate.ts
lib/errors/classify.ts
lib/errors/infrastructure.ts
lib/events/status.ts
jest.setup-env.ts
ecosystem.config.cjs
.nvmrc
```

**Test support — 3**

```
__tests__/support/global-setup.ts
__tests__/support/test-database.ts
__tests__/support/fixture-teardown.ts
```

**Tests — 17**

```
__tests__/auth-flow/client-session-expiry.test.ts
__tests__/auth-flow/register-customer-only.test.ts
__tests__/auth-flow/role-intent.test.ts
__tests__/auth-flow/session-gate.test.ts
__tests__/authz/session-trust.integration.test.ts
__tests__/errors/api-error-envelope.test.ts
__tests__/errors/error-boundaries.test.ts
__tests__/errors/error-classification.test.ts
__tests__/errors/global-error-render.test.ts
__tests__/events/fixture-isolation.test.ts
__tests__/events/status-presentation.test.ts
__tests__/health/health-endpoints.test.ts
__tests__/security/deployment-baseline.test.ts
__tests__/security/deployment-env-contract.test.ts
__tests__/security/phase24-headers.test.ts
__tests__/ticketing-checkout/order-ownership-404.integration.test.ts
__tests__/ticketing-payment/payment-method-contract.test.ts
```

**Migration — 1 (required, see §7)**

```
prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/migration.sql
```

**Operational script — 1**

```
scripts/setup-test-db.ts
```

**Documentation — 9**

```
DEPLOYMENT_RUNBOOK.md
PHASE_AUTH_MULTI_ROLE_AND_GLOBAL_ERROR_HANDLING_REPORT.md
PHASE_21_DASHBOARD_SYNCHRONIZATION_IMPLEMENTATION_REPORT.md
PHASE_21B_ORPHAN_EVENT_CLEANUP_REPORT.md
PHASE_22_PAYMENT_AND_DATABASE_HARDENING_REPORT.md
PHASE_23A_ORDER_404_ROOT_CAUSE_REPORT.md
PHASE_24_AUTH_UX_SECURITY_HEADERS_REPORT.md
PHASE_25_OPERATIONAL_SECURITY_PRODUCTION_READINESS_AUDIT.md
PHASE_26_VPS_DEPLOYMENT_READINESS_RELEASE_BASELINE_REPORT.md
```

### 2.3 Safety scan of the whole delta (evidence, not assurance)

| Check | Command | Result |
|---|---|---|
| Secrets / key material | `{ git diff; git diff --cached; } \| grep -E '^\+.*(sk_live\|sk_test\|-----BEGIN\|AKIA[0-9A-Z]{16}\|…)'` | **0 matches** |
| Real values in the template | `git diff .env.example \| grep -E '^\+[A-Z_]+='` | only `${USERNAME}:${PASSWORD}` and `replace-me` placeholders |
| Destructive SQL in code | delta grep for `DROP TABLE\|TRUNCATE\|DELETE FROM\|migrate reset\|db push` | **0 matches** (the only `DROP TABLE`s are inside the migration, quoted in §7) |
| Type suppressions | delta grep for `as any` / `@ts-ignore` / `@ts-expect-error` / `eslint-disable` | **0** (one apparent hit was the phrase *"as anything else"* inside a comment) |
| Focused/skipped tests | delta grep for `it.only` / `describe.skip` / `xit` / `todo` | **0** |
| Dependency drift | sorted key comparison of `dependencies` + `devDependencies` vs `HEAD:package.json` | **identical** |
| Lockfile | `git status --porcelain package-lock.json` | **untouched** |

---

## 3. Exact IGNORE paths

| Path / pattern | Rule | Effective now? |
|---|---|---|
| `storage/` | `.gitignore:34` | **yes** — `git check-ignore --no-index storage/uploads/events/new.png` → `.gitignore:34:storage/`. Was previously **inert for the 14 tracked files**; after Phase 26's untracking, `git add -A --dry-run \| grep storage/` returns nothing. |
| `*.tsbuildinfo` | `.gitignore` | **no — the file is tracked**, so the rule cannot apply until `git rm --cached` |
| `next-env.d.ts` | `.gitignore` | **no — the file is tracked** (same reason) |
| `.env`, `.env.local`, `.env.production` | `.gitignore` | yes |
| `node_modules/`, `.next/` | `.gitignore` | yes |

**Category B (ignore) paths:** `storage/**` (all runtime uploads, present and future), `*.tsbuildinfo`,
`next-env.d.ts`, `.env*`, `node_modules/**`, `.next/**`.

---

## 4. Exact INTENTIONAL DELETE paths

**Category C — 16 paths, all staged, all intended, all recoverable.**

| Path | Why | Recoverable? |
|---|---|---|
| `.github/workflows/deploy.yml` | fired on **every push to `main`**; SSHed to the VPS with `secrets.VPSBIZNET` and ran `cd ~/demo-marketplace && ./deploy.sh` — the **deleted retail project**, at a path that no longer exists | yes — in `HEAD`'s object store |
| `.github/workflows/test-vps.yml` | manual-only SSH smoke test pointed at the same retired host (`VPSBIZNET`, `VPS_NAME`, `VPS_SSH_KEY`) | yes |
| `storage/uploads/affiliate/ktp/…/*.jpg` (5) | legacy retail runtime uploads committed at `HEAD`. **Untracked, not erased** — all 5 remain on disk untouched | yes — and still on disk |
| `storage/uploads/affiliate/social/…/*.jpg` (3) | same | yes |
| `storage/uploads/products/*.jpg`, `*.webp` (6) | same | yes |

Note on the `ktp` files: they are **national-ID-card photo paths** carrying 5 copies of one identical
blob (hash `a34b4747…`, 97 884 bytes) — placeholder content, not real identity documents. They should
still leave the index, because a tracked runtime-upload tree is a PII-shaped hazard regardless of what
this particular copy contains.

**Nothing else is staged.** The index was not modified by this review.

---

## 5. Exact OWNER DECISION paths

**Category D — 5 items. None was changed.**

| # | Path | Finding | Recommendation |
|---|---|---|---|
| 1 | `server.js` | **DEAD** (§9) | delete, or leave and never invoke it as the start command |
| 2 | `lib/app-origin.ts:132` — `hosts.add("demosolusisejalan.my.id")` | one hardcoded fallback origin (§10) | keep if the domain is ours; otherwise delete the line |
| 3 | `next.config.ts:74` — `allowedDevOrigins: ["100.88.79.104"]` | a hardcoded internal address, **dev-only** (it has no effect on a production build) | remove at leisure; publishing internal topology has reconnaissance value and no upside |
| 4 | `package.json` — 3 unused dependencies | 0 importers, **but one is transitive** (§11) | remove `next-themes` + `@radix-ui/react-popover`; **leave `@radix-ui/react-visually-hidden`** |
| 5 | `__tests__/ui/dialog-logic.test.ts` | **tracked but never run**, and it imports a deleted module (§14.2) | delete it, or rewrite its two `components/ui/Dialog` tests against `components/dashboard/ui/dialog.tsx` **and** add `__tests__/ui/*` to `testMatch` |

---

## 6. Exact DO NOT SHIP paths

**Category E — never committed, now or later.**

| Path | Why |
|---|---|
| `.env` | live credentials (present on disk, correctly ignored) |
| `storage/uploads/**` | runtime event imagery. **Including the one new untracked file that appeared during this review:** `storage/uploads/events/1789837107923-ea3ed5f51b4a49bb6af066f0d549059c.png` — a real upload from the running dev app, correctly ignored by the new `storage/` rule |
| `node_modules/**` | reproducible from the lockfile |
| `.next/**` | build output |
| `tsconfig.tsbuildinfo`, `next-env.d.ts` | generated (tracked today — §8) |

---

## 7. Prisma migration verification

**File:** `prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/migration.sql` (untracked)

**Contents:** a header documenting the evidence (8 tables, 0 rows each, no inbound foreign keys, no
Prisma models, no code references, all belonging to the retired retail/voucher/flash-sale/RajaOngkir
domains) followed by exactly eight statements, quoted verbatim:

```sql
DROP TABLE IF EXISTS `campaigncategory`;
DROP TABLE IF EXISTS `campaignproduct`;
DROP TABLE IF EXISTS `vouchercategory`;
DROP TABLE IF EXISTS `voucherproduct`;
DROP TABLE IF EXISTS `voucheruserusage`;
DROP TABLE IF EXISTS `flashsalepurchase`;
DROP TABLE IF EXISTS `promotion`;
DROP TABLE IF EXISTS `rajaongkirregion`;
```

(Child tables first; `IF EXISTS` keeps it idempotent.)

**Is it the migration already applied to the development database? — YES.**

```
$ npx prisma migrate status
23 migrations found in prisma/migrations
Database schema is up to date!
```

23 directories exist under `prisma/migrations/`, this one included, and the database reports itself
consistent with all 23. The migration is the **newest** entry, so it is the Phase 22 drop.

**Conclusion:** it **must be committed**. Omitting it would leave the repository's migration chain one
step behind the schema the development database is actually running, and a fresh `prisma migrate deploy`
elsewhere would not reproduce this schema. It is **unmodified and not to be rewritten** — its content
is a historical record of a decision already taken (the tables it names were dropped in Phase 22).

**Honest caveat for the first VPS deploy:** it is destructive in name and effect (`DROP TABLE`). See
`DEPLOYMENT_RUNBOOK.md` §8.1 — take the backup before `migrate deploy`.

---

## 8. Generated-file handling

### 8.1 They are TRACKED — and nothing was executed

```
$ git ls-files | grep -E 'tsbuildinfo|next-env.d.ts'
next-env.d.ts
tsconfig.tsbuildinfo
```

`git rm --cached` was **not** run, per the brief.

**Exact owner command required later (not now, not by this phase):**

```bash
git rm --cached tsconfig.tsbuildinfo next-env.d.ts
```

Both files stay on disk. `next dev` / `next build` / `tsc` regenerate them, and `.gitignore` then
applies.

### 8.2 Evidence that they will churn forever while tracked

| File | `HEAD` | Working tree |
|---|---|---|
| `next-env.d.ts` | `import "./.next/dev/types/routes.d.ts"` + `…/root-params.d.ts` | `import "./.next/types/routes.d.ts"` + `…/root-params.d.ts` |

The content depends on whether `next dev` or `next build` ran last. `tsconfig.json` includes **both**
`.next/types/**/*.ts` **and** `.next/dev/types/**/*.ts`, so the file legitimately differs between dev
and build — it can never be stable in Git.

`tsconfig.tsbuildinfo` is the same story: a single-line JSON cache (`"incremental": true`) listing
`./.next/dev/types/…` and `./.next/types/…`, rewritten by every typecheck.

**Practical consequence for whoever commits:** after committing, the very next `npm run dev` or
`npm run build` will dirty both files again. That is expected, and it is why §12's commit *includes*
their current content rather than trying to exclude them — excluding them is the follow-up owner
command in §8.1.

---

## 9. `server.js` conclusion

**Verdict: DEAD. Not used, not referenced by the deployment, not invocable by any documented path.**

Every reference in the tree (excluding docs that merely discuss it):

| Location | Kind of reference |
|---|---|
| `eslint.config.mjs:20` | a `files:` scope entry granting it CommonJS `require()` permission — a lint allowance, not a use |
| `ecosystem.config.cjs:36` | a doc comment explaining that this file reads `process.env.HOSTNAME` (a trap) — prose only |

- **package scripts:** none. `package.json` declares `dev`, `build`, `start` (`next start`), `lint`,
  `audit:ipaymu`, `seed:organizer`, `test`, `test:db:setup`. `server.js` appears in none of them.
- **PM2:** `ecosystem.config.cjs` runs `node_modules/next/dist/bin/next` with `args: "start -H 127.0.0.1"`,
  and contains no reference to `server.js` except the explanatory comment.
- **Deployment:** the only deployment automation that ever referenced it (the now-deleted
  `deploy.yml`) ran a remote `deploy.sh`; it never invoked `server.js`.
- **Provenance:** tracked since `0a33787 Initial commit` (the retail project's first commit).

It is a hand-written `http.createServer` wrapper that would **also be actively wrong** if adopted: it
reads `process.env.HOSTNAME`, which on a Linux shell is usually already set to the machine name, so it
would attempt to bind the hostname rather than an interface. It is a trap, not a fallback.

**Recommendation:** delete it (and the `eslint.config.mjs` line that exists only for it). Low severity
— it is inert as long as nobody runs it. **Owner decision; not changed.**

---

## 10. Hard-coded origin conclusion

**Value:** `demosolusisejalan.my.id`
**Every reference in the tree:** exactly one executable line — `lib/app-origin.ts:132`
(`hosts.add("demosolusisejalan.my.id")`). Everything else is documentation about it.

**What it does:** `buildAllowedHosts()` assembles the host allowlist used to validate a
`Host` / `x-forwarded-host` header when `getAppOrigin()` falls back to request headers.

**When it is reached:** only when `NEXT_PUBLIC_APP_URL` is unset or unparseable, because
`getAppOrigin` returns the env var first (verified: the env branch precedes the `buildAllowedHosts()`
call, and `__tests__/security/deployment-baseline.test.ts` asserts that ordering). In production
`NEXT_PUBLIC_APP_URL` is effectively mandatory — `lib/payment/config.ts` refuses to build a payment
session without it and rejects localhost/sandbox values — so on a correct deployment this list is never
consulted.

**Classification: OWNER DECISION — harmless as-is, with a real edge.** It is not a live vulnerability:
a `.my.id` domain is controlled by its registrant, not re-registerable by a stranger in the way the
tunnel hostname beside it was (that one was removed in Phase 26). The residual risk is the general one
for any hardcoded origin: if the domain ever lapses or changes hands, whoever holds it becomes a
validated origin **for the header-fallback path** — which is where payment callback URLs are built.

Two clean resolutions, owner's choice: keep the line (it is our domain), or delete it and rely on
`NEXT_PUBLIC_APP_URL` + the loopback variants. **Not changed.**

---

## 11. Unused dependency conclusion

**Nothing was uninstalled. `package-lock.json` is untouched and the dependency key sets are identical
to `HEAD`.**

| Package | Source imports | Test imports | Config imports | Transitive dependents | Safe to remove? | Lockfile effect |
|---|---|---|---|---|---|---|
| `next-themes` | **0** | 0 | 0 | **none** (only the root manifest declares it) | **yes** | shrinks |
| `@radix-ui/react-popover` | **0** | 0 | 0 | **none** (only the root) | **yes** | shrinks |
| `@radix-ui/react-visually-hidden` | **0** | 0 | 0 | **yes — `@radix-ui/react-select` and `@radix-ui/react-tooltip` both depend on it, and both ARE used** | **removing the direct entry is safe but pointless** | **will not shrink**: npm keeps it installed for its two parents |

Evidence for `next-themes` in particular is stronger than a grep: the delta **adds** a test that
forbids it —

```ts
// __tests__/ui-consolidation/shadcn-dashboard.test.ts
expect(provider).not.toMatch(/from\s+["']next-themes["']/);
```

Its only other occurrences are comments in `components/dashboard/theme/*` explaining that Phase 21
removed it. Phase 22 already logged it as `L2 — LOW`.

`@radix-ui/react-popover` and `@radix-ui/react-visually-hidden` appear **only** in `package.json` and in
audit reports — no import anywhere in `app/`, `components/`, `lib/`, `__tests__/` or `scripts/`.

**Recommendation:** `npm uninstall next-themes @radix-ui/react-popover`. **Leave
`@radix-ui/react-visually-hidden` declared** — dropping the direct entry removes nothing from the
installed tree (its two real consumers still need it), so the change buys only cosmetic tidiness while
making the manifest say less than the truth about what the dashboard UI depends on.

**Lockfile effect if the two are removed:** `package-lock.json` is rewritten (it is a
`lockfileVersion: 3` file, and both packages' entries plus any now-orphaned transitive entries would be
pruned). That rewrite is why this needs explicit approval and was not done.

---

## 12. Recommended staging commands

**Advisory only. None of these was executed. `git add` was never run in this review.**

```bash
# ── 0. Confirm you are where you expect to be, and that HEAD has not moved.
git log --oneline -1
git status --short

# ── 1. Stage the 48 modified release files, EXCEPT the two generated ones (§8).
#      Listing the exceptions feels awkward because `git add -u` would be simpler — but
#      `git add -u` DOES include next-env.d.ts and tsconfig.tsbuildinfo, and including them
#      means committing a build cache that the next `npm run dev` immediately dirties.
git add -u -- .
git restore --staged next-env.d.ts tsconfig.tsbuildinfo

# ── 2. Stage the 58 new files, and nothing else.
#      `git add -A` is safe here ONLY because storage/ is now ignored; verify that first.
git check-ignore -v --no-index storage/uploads/events/x.png      # expect: .gitignore:34:storage/
git add .nvmrc ecosystem.config.cjs jest.setup-env.ts
git add app components lib __tests__ scripts
git add prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/migration.sql
git add DEPLOYMENT_RUNBOOK.md PHASE_21_DASHBOARD_SYNCHRONIZATION_IMPLEMENTATION_REPORT.md \
        PHASE_21B_ORPHAN_EVENT_CLEANUP_REPORT.md PHASE_22_PAYMENT_AND_DATABASE_HARDENING_REPORT.md \
        PHASE_23A_ORDER_404_ROOT_CAUSE_REPORT.md PHASE_24_AUTH_UX_SECURITY_HEADERS_REPORT.md \
        PHASE_25_OPERATIONAL_SECURITY_PRODUCTION_READINESS_AUDIT.md \
        PHASE_26_VPS_DEPLOYMENT_READINESS_RELEASE_BASELINE_REPORT.md \
        PHASE_26A_RELEASE_BASELINE_REVIEW.md

# ── 3. The 16 deletions are ALREADY staged. Nothing to do — do not re-add them.

# ── 4. REVIEW BEFORE COMMITTING. Check the COMPONENTS, not a single total:
git diff --cached --stat
git diff --cached --name-status | sort | awk '{print $1}' | uniq -c
#     expect: 16 D  (the two workflows + 14 storage paths)
#             59 A  (the 59 untracked files, including PHASE_26A_RELEASE_BASELINE_REVIEW.md)
#             46 M  (the 48 modified minus the 2 generated files)
git diff --cached | grep -iE 'sk_live|-----BEGIN|password\s*[:=]\s*"'   # expect: no output

# ── 5. Confirm the two generated files are NOT in the index.
git diff --cached --name-only | grep -E 'tsbuildinfo|next-env.d.ts'    # expect: no output

# ── 6. Confirm no storage path is staged for addition.
git diff --cached --name-status | grep '^A.*storage/'                  # expect: no output

# ── 7. Re-verify the exact tree (read-only; the migration must NOT be applied here).
npx prisma validate
npx prisma migrate status
npx tsc --noEmit
npx eslint .
npm test -- --runInBand     # see §14.1: this may flake on payment-races H1
```

> **Note on `git add -A`:** it is *safe today* only because the `storage/` rule is now effective and
> nothing else untracked is ignorable. Prefer the explicit form above; if you use `git add -A`, run the
> `git check-ignore` line first and then `git diff --cached --name-only | sort` before committing.

---

## 13. Recommended commit message

One commit, because the delta is one coherent release step; a split would separate the migration from
the schema work that depends on it.

```
Establish the ticketing release baseline (Phases 21–26)

Consolidate six phases of ticketing work into one reviewable baseline: the
single-dashboard UI and theme, payment/database hardening, the order-404
root-cause fix, multi-role auth hardening with global error handling, auth UX
and security headers, and the VPS deployment contract.

Deployment-contract additions (Phase 26):
  - .nvmrc + package.json engines pin the Node runtime (24) and its floor,
    which is derived from next@16.3.0's own declared requirement.
  - GET /api/health (liveness, touches nothing) and /api/health/ready
    (readiness, one SELECT 1, 200/503) give the deployment something to probe;
    neither leaks version, host, dependency detail or business data.
  - ecosystem.config.cjs defines how the server actually runs: one forked
    instance (the rate limiter is per-process) bound to loopback, which is what
    makes TRUSTED_PROXY safe.
  - DEPLOYMENT_RUNBOOK.md carries the environment, client-IP, upload-backup,
    migration (forward-only) and rollback contracts, and gates the scheduler.

Removals:
  - .github/workflows/deploy.yml and test-vps.yml: an unattended SSH deploy
    that fired on every push to main against the deleted retail project.
  - The ephemeral trycloudflare host in the origin allowlist, which any third
    party could re-register and thereby be handed the origin used for payment
    callback URLs.
  - storage/** from the index (14 legacy retail upload paths). The files remain
    on disk; they were tracked runtime data, so the ignore rule could not apply.

Adds the Phase 22 migration that dropped eight provably unused, empty legacy
retail tables. It is already applied to the development database and is
required for the schema to be reproducible.

Verified: 1737 tests across 80 suites (payment-races H1 is flaky under
full-suite execution — see the Phase 26A review), tsc clean, eslint 0 errors,
prisma validate clean, 23 migrations up to date, next build clean.

🤖 Generated with Codebuff
Co-Authored-By: Codebuff <noreply@codebuff.com>
```

*(The exact total in the `git diff --cached --name-only | wc -l` step is stated as `122` for
orientation only — read the actual number from the command rather than trusting it.)*

---

## 14. Risks before commit

### 14.1 **A payment-path concurrency defect — pre-existing, does not block this commit**

The flake Phase 25 recorded as "payment-races had an intermittent full-suite flake" is not noise. It
is one test detecting a real gap:

```
FAIL __tests__/ticketing-payment/payment-races.integration.test.ts
  ● H. concurrent payment creation › H1. eight simultaneous Pay clicks produce one provider payment, not eight

    expect(received).toHaveLength(expected)
    Expected length: 1
    Received length: 2
    Received array: [
      { referenceId: "EVT-…d5ffed39"    , amount: 150000, … },
      { referenceId: "EVT-…d5ffed39#2"  , amount: 150000, … }
    ]
  > 230 |  expect(gatewayStub.calls).toHaveLength(1);
```

**Mechanism** (`lib/ticketing/payment/service.ts`, unmodified vs `HEAD`):

1. `findLivePayment(orderId)` looks for a `PENDING`/`UNPAID` row that has something payable on it — a
   hosted URL, a QR payload, or a payment number. A row inserted but not yet answered by the provider
   has none of those, so it is deliberately **not** "live".
2. `attemptNumber = (await prisma.payment.count({ where: { orderId } })) + 1` — read **outside any
   transaction or lock**.
3. The insert is claimed to be the concurrency guard: *"two simultaneous 'Pay' clicks compute the same
   attempt number, and the loser's insert is rejected by the database"* (`paymentReference` is
   `@unique`).

Step 3 holds only while both clicks compute **the same** number. They need not: if attempt A's row
commits before attempt B's `count()` runs, B computes `N+1`, mints a **different** unique reference
(`…#2`), and its insert succeeds. The unique constraint is then satisfied and the gateway is called a
second time. Observed exactly that: two calls, references `…#` and `…#2`.

**Impact.** Both sessions carry the **same order** and the **same amount** (the order total, computed
server-side), so this is not amount manipulation and no other buyer's data is involved. Paying both
produces two settlements for one order; the second is handled as a late settlement — recorded,
fulfilment blocked, surfaced under "Perlu tindakan" for manual resolution (`README.md` §5). No double
ticket issuance and no double quota/seat consumption. So the exposure is **a buyer can be shown two
payable instruments for one order and can pay twice, generating manual reconciliation work** — not
platform money loss. The window needs genuinely concurrent clicks; the test uses eight to force it.

**Is it this delta's fault? — No.**

| Check | Result |
|---|---|
| `git status --porcelain lib/ticketing/payment/service.ts` | empty → **byte-identical to HEAD** |
| `buildPaymentReference` (`lib/ticketing/payment/reference.ts`) | not modified |
| Delta hits on `findLivePayment` / `attemptNumber` / `paymentReference` | **none** |
| Payment files the delta does touch | `gateway.ts`, `method-catalog.ts`, `validation.ts` (Phase 22 method-catalog work) — and the gateway is **stubbed** in this test, so its changes cannot affect the race |

**Conclusion:** pre-existing. Committing the delta neither introduces nor widens it. It **does** mean
the suite is not reliably green: **3 full-suite runs in this review — 1 passed, 2 failed** (plus a
green run in Phase 26). Anyone wiring CI must expect a ~50 % flake on this test, and the fix belongs in
its own change (a real concurrency guard — e.g. a serialising transaction, or making a provider-less row
still "live" so a sibling attempt resumes the in-flight claim instead of minting `#2`).

**Not fixed here** — the brief is commit preparation, and this is a payment-path change that needs its
own phase.

### 14.2 A tracked test file jest has never run

| Check | Result |
|---|---|
| `__tests__/ui/dialog-logic.test.ts` | 353 lines, real `describe`/`test`/`expect`, tracked at `HEAD` since `8628dbf` |
| jest `testMatch` | has `**/__tests__/ui-consolidation/*.test.ts` but **no** `**/__tests__/ui/*.test.ts` |
| `npx jest --listTests` | 80 suites; this file is not among them |
| Can it be run on demand? | **No** — `--testPathPatterns` cannot reach it; `testMatch` filters it out first |
| What it imports | `require("../../components/ui/Dialog")` — **`components/ui/` does not exist** (only `components/dashboard/ui/dialog.tsx`) |

Two files on disk are uncollected: this one and `__tests__/auth/register-rate-limit.test.ts`. The
latter is **documented** as intentional in `jest.config.js` ("it has no `describe`/`it`, so enrolling it
here would fail the run"). **This one is not documented anywhere** — its existence is presumably *why*
`__tests__/ui/` was never added.

Its first ~280 lines test a self-contained `DialogSimulator`, not the real component; only the last two
tests require the deleted module. So it is a legacy orphan from the retail component library.

**Impact on the commit: none** — it is already at `HEAD` and unchanged by the delta. **Impact on
confidence: real** — "1737 tests" is the count of the suites jest *collects*, and one committed suite
is silently outside that set. Resolve it either by deleting the file (it tests a simulation and a
deleted module) or by rewriting those two tests against `components/dashboard/ui/dialog.tsx` **and**
adding `__tests__/ui/*.test.ts` to `testMatch` — the second option has to be done as a pair, or the
file stays dark. **Owner decision; not changed.**

### 14.3 Other items to know before pressing commit

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | The migration is **destructive in name and effect** (`DROP TABLE` × 8). It is already applied locally, so committing it is safe — but the first `migrate deploy` on a real database runs it | **HIGH for the future deploy, NONE for this commit** | runbook §8.1: back up uploads + database first |
| 2 | `next-env.d.ts` / `tsconfig.tsbuildinfo` will re-dirty immediately after any `next dev`/`build`/`tsc`. A reviewer who runs the app *after* staging will see a dirty tree and may "helpfully" re-add them | MEDIUM (process) | §8.1's `git rm --cached` follow-up; verify with the §12 step 5 check |
| 3 | The two workflow deletions remove the only CI configuration in the repository | MEDIUM | intended (they deployed the deleted retail project); add a lint/test/build workflow separately if CI is wanted |
| 4 | 9 `PHASE_*.md` reports enter the repository (~500 KB of documentation) | LOW | intended — they are the decision record referenced by the runbook |
| 5 | `.env.example` was rewritten (+143/−…). A stale local `.env` copied from the old template may be missing `AUTH_URL` | LOW | `AUTH_URL` is now documented as required; compare with `git diff .env.example` |
| 6 | `storage/` is ignored, but the 15 files on disk include one **live event image** (`events/1789837107923-…png`) | LOW | that is runtime data and stays out of Git — as intended. Remember §6 in the runbook: it needs a backup, not a commit |
| 7 | The commit will include the *build-mode* variant of `next-env.d.ts` | INFO | harmless; §8.1 removes the file from tracking altogether |

---

## 15. Verification performed

All read-only or non-mutating. **No file was written, staged, committed, reset or deleted. No database
migration was applied. No deployment, no SSH.**

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Tree state | `git status --short`, `git diff --stat`, `git diff --cached --stat`, counts | 48 M / 16 staged-D / 58 ?? ; HEAD `8628dbf` unchanged |
| 2 | Index contents | `git diff --cached --name-status` | exactly 16 `D`, no `A`/`M` |
| 3 | Deletions recoverable | `git cat-file -e HEAD:<path>` for a workflow and a storage blob | both present in the object store |
| 4 | Deleted files still on disk | file-by-file existence check over the staged set | **14/14 storage files present**; only the 2 workflows (intentionally) removed |
| 5 | Secrets in the delta | pattern grep over `git diff` + `git diff --cached` | 0 matches |
| 6 | Blast-radius scan | delta grep for destructive SQL / type suppressions / focused+skipped tests | 0 / 0 / 0 |
| 7 | Dependency + lockfile drift | sorted `dependencies`/`devDependencies` diff vs `HEAD:package.json`; `git status` on the lockfile | identical; lockfile untouched |
| 8 | Test-assertion integrity | removed vs added `expect(` in `__tests__` | 1 removed (replaced by 5), 11 added |
| 9 | Every test file is collected | `find … -name '*.test.ts'` vs `npx jest --listTests` | **2 orphans found** — one documented (`auth/`), one not (`ui/`) → §14.2 |
| 10 | Migration content + applied state | `cat migration.sql`; `npx prisma migrate status` | 8 `DROP TABLE IF EXISTS`; `23 migrations found` · `Database schema is up to date!` |
| 11 | Generated files | `git ls-files`, `git diff next-env.d.ts` | both **tracked**; `HEAD` = dev variant, tree = build variant → §8.2 |
| 12 | `server.js` references | grep for `server.js`; package scripts; PM2 config | only an eslint scope entry + a doc comment → **DEAD** |
| 13 | Hardcoded origin | grep for `demosolusisejalan` | exactly one executable line: `lib/app-origin.ts:132` |
| 14 | Unused dependencies | grep for each name; `package-lock.json` dependent analysis | 0 importers for all three; **`react-visually-hidden` is required by `react-select` + `react-tooltip`** |
| 15 | Typecheck | `npx tsc --noEmit` | exit 0, no output |
| 16 | Lint | `npx eslint .` | 0 errors, 3 warnings (pre-existing `no-img-element`) |
| 17 | Schema | `npx prisma validate` | valid |
| 18 | Full test suite | `npm test -- --runInBand` (×3) | **1 pass (1737/1737, 80 suites), 2 fail (1736/1737, 1 failed suite)** — same test each time → §14.1 |
| 19 | Flaky suite in isolation | `npx jest __tests__/ticketing-payment/payment-races…` | **8/8 pass** → confirms it is a full-suite interleaving effect, not a deterministic failure |
| 20 | Failure detail captured | `/tmp/flake-1.log` | exact assertion, both `referenceId` values and the expectation quoted in §14.1 |

**Not verified (stated, not glossed):** nothing on the VPS; the production `next build` (Phase 26
verified it and no code has changed since — only documentation was added); whether the
`payment-races` race reproduces against a stubbed-gateway production build.

---

## 16. FINAL VERDICT

**PHASE 26A READY FOR OWNER REVIEW**

The commit plan is exact and safe: 48 modified + 58 new + 16 intended deletions, no secret anywhere in
the delta, no dependency or lockfile drift, no weakened assertion, no focused or skipped test, the
required migration present and consistent with the development database, and every deletion verified
recoverable with its files still on disk.

Three findings are carried forward to the owner rather than silently fixed, per the brief:

- **§14.1** a pre-existing payment-path concurrency defect (two payable sessions for one order under a
  concurrent click burst) — visible as a ~50 % flake in `payment-races H1`. **Does not block this
  commit**; should be fixed before public launch.
- **§14.2** a committed test file jest has never run, importing a module that no longer exists.
- **§14.3** seven items, none blocking, the most likely to bite being the two tracked generated files
  re-dirtying the tree right after the commit.

Nothing in the tree was changed by this review: **no staging, no commit, no push, no reset, no clean,
no deletion, no database modification, no deployment.**
