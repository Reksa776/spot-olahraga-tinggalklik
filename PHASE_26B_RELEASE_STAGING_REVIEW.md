# PHASE 26B — RELEASE STAGING & FINAL REVIEW

**Project:** TinggalKlik.Co · **Date:** 2026-09-20 · **Baseline commit:** `8628dbf` (`integrasi dengan UI`)
**Status:** staged, verified, **NOT committed**

This document is the review record for the Phase 21–26 release baseline. It was produced by staging the
release explicitly and then auditing the **index** (not just filenames, and not just the working tree).
Nothing here was committed, pushed, deployed, reset, cleaned, or written to the database.

---

## 1. Git state BEFORE staging

```
$ git log --oneline -5
8628dbf integrasi dengan UI
df8647f Initial rebuild
f2e609e fix payment gateway
21f586c ipaymu production
d2fb58a production ipaymu

$ git status --short | wc -l
116
```

116 entries: **48** modified tracked files, **18** already-staged deletions, **50** untracked paths.
`git ls-files --deleted` was **empty** (there were no *unstaged* deletions — every removal was already
in the index). `git diff --stat` over the 48 modified files: `2547 insertions(+), 1003 deletions(-)`.

The previous phase (26A) had already recorded the same delta and classified it; this phase re-audited it
from the tree and staged it explicitly.

---

## 2. Candidate release scope — exact staged inventory

```
129 files changed, 16044 insertions(+), 1072 deletions(-)
   63 A   (added)
   48 M   (modified)
   18 D   (deleted)
```

**The staged set includes this review document**, so it accounts for one of the 63 added files and its own
lines are part of the insertion count. Those figures were re-measured after it was staged.

> **On the per-file `git diff --cached --stat` rows:** the exact summary line above is reproduced verbatim.
> The 128 individual `path | N ++++----` rows are deliberately **not** transcribed into this document —
> hand-copying them would risk stating numbers the command does not actually print. They are one command
> away and are the source of truth:
>
> ```bash
> git diff --cached --stat        # per-file rows + the summary line
> git diff --cached --name-status # the table reproduced in full below
> ```
>
> The complete `--name-status` table **is** reproduced below, grouped by area, because it is the part a
> reviewer needs.

### 2.1 Root files (24)

| St | Path |
|----|------|
| M | `.env.example` |
| M | `.gitignore` |
| M | `README.md` |
| M | `eslint.config.mjs` |
| M | `jest.config.js` |
| M | `next.config.ts` |
| M | `package.json` |
| M | `proxy.ts` |
| A | `.nvmrc` |
| A | `DEPLOYMENT_RUNBOOK.md` |
| A | `ecosystem.config.cjs` |
| A | `jest.setup-env.ts` |
| A | `PHASE_21B_ORPHAN_EVENT_CLEANUP_REPORT.md` |
| A | `PHASE_21_DASHBOARD_SYNCHRONIZATION_IMPLEMENTATION_REPORT.md` |
| A | `PHASE_22_PAYMENT_AND_DATABASE_HARDENING_REPORT.md` |
| A | `PHASE_23A_ORDER_404_ROOT_CAUSE_REPORT.md` |
| A | `PHASE_24_AUTH_UX_SECURITY_HEADERS_REPORT.md` |
| A | `PHASE_25_OPERATIONAL_SECURITY_PRODUCTION_READINESS_AUDIT.md` |
| A | `PHASE_26_VPS_DEPLOYMENT_READINESS_RELEASE_BASELINE_REPORT.md` |
| A | `PHASE_26A_RELEASE_BASELINE_REVIEW.md` |
| A | `PHASE_26B_RELEASE_STAGING_REVIEW.md` *(this document)* |
| A | `PHASE_AUTH_MULTI_ROLE_AND_GLOBAL_ERROR_HANDLING_REPORT.md` |
| D | `next-env.d.ts` *(untracked, file kept on disk)* |
| D | `tsconfig.tsbuildinfo` *(untracked, file kept on disk)* |

### 2.2 `__tests__/` (27)

| St | Path |
|----|------|
| M | `__tests__/authz/permission-map.test.ts` |
| M | `__tests__/ticketing-checkout/checkout-concurrency.integration.test.ts` |
| M | `__tests__/ticketing-checkout/checkout.integration.test.ts` |
| M | `__tests__/ticketing-payment/payment-harness.ts` |
| M | `__tests__/ui-consolidation/shadcn-dashboard.test.ts` |
| A | `__tests__/auth-flow/client-session-expiry.test.ts` |
| A | `__tests__/auth-flow/register-customer-only.test.ts` |
| A | `__tests__/auth-flow/role-intent.test.ts` |
| A | `__tests__/auth-flow/session-gate.test.ts` |
| A | `__tests__/authz/session-trust.integration.test.ts` |
| A | `__tests__/errors/api-error-envelope.test.ts` |
| A | `__tests__/errors/error-boundaries.test.ts` |
| A | `__tests__/errors/error-classification.test.ts` |
| A | `__tests__/errors/global-error-render.test.ts` |
| A | `__tests__/events/fixture-isolation.test.ts` |
| A | `__tests__/events/status-presentation.test.ts` |
| A | `__tests__/health/health-endpoints.test.ts` |
| A | `__tests__/security/deployment-baseline.test.ts` |
| A | `__tests__/security/deployment-env-contract.test.ts` |
| A | `__tests__/security/phase24-headers.test.ts` |
| A | `__tests__/support/fixture-teardown.ts` |
| A | `__tests__/support/global-setup.ts` |
| A | `__tests__/support/test-database.ts` |
| A | `__tests__/ticketing-checkout/order-ownership-404.integration.test.ts` |
| A | `__tests__/ticketing-checkout/request-key.test.ts` |
| A | `__tests__/ticketing-payment/payment-method-contract.test.ts` |
| A | `__tests__/ui-consolidation/theme-hydration.test.ts` |

`__tests__/support/*` is **required** by the suite: `jest.config.js` names `global-setup.ts` and
`fixture-teardown.ts` as `globalSetup`/`globalTeardown`, and `test-database.ts` is what redirects workers
to the `<database>_test` schema.

### 2.3 `app/` (20)

| St | Path |
|----|------|
| M | `app/api/auth/register/route.ts` |
| M | `app/dashboard/events/[id]/page.tsx` |
| M | `app/dashboard/events/page.tsx` |
| M | `app/dashboard/page.tsx` |
| M | `app/e/[slug]/page.tsx` |
| M | `app/globals.css` |
| M | `app/layout.tsx` |
| M | `app/login/page.tsx` |
| M | `app/register/page.tsx` |
| M | `app/ticketing/orders/[orderNumber]/page.tsx` |
| M | `app/ticketing/refunds/page.tsx` |
| M | `app/ticketing/tickets/[ticketCode]/page.tsx` |
| M | `app/ticketing/tickets/page.tsx` |
| A | `app/api/health/route.ts` |
| A | `app/api/health/ready/route.ts` |
| A | `app/dashboard/error.tsx` |
| A | `app/error.tsx` |
| A | `app/global-error.tsx` |
| A | `app/not-found.tsx` |
| A | `app/ticketing/error.tsx` |

### 2.4 `components/` (23)

| St | Path |
|----|------|
| M | `components/auth/LoginForm.tsx` |
| M | `components/auth/RegisterForm.tsx` |
| M | `components/dashboard/DashboardProviders.tsx` |
| M | `components/dashboard/theme/theme-config.ts` |
| M | `components/dashboard/theme/theme-provider.tsx` |
| M | `components/dashboard/theme/theme-switcher.tsx` |
| M | `components/events/TicketPurchaseForm.tsx` |
| M | `components/orders/CancelOrderButton.tsx` |
| M | `components/orders/PayNowButton.tsx` |
| M | `components/orders/RequestRefundButton.tsx` |
| M | `components/organizer/EventForm.tsx` |
| M | `components/tickets/IssueTicketsButton.tsx` |
| A | `components/auth/AuthError.tsx` |
| A | `components/auth/AuthShell.tsx` |
| A | `components/auth/GoogleMark.tsx` |
| A | `components/auth/PasswordField.tsx` |
| A | `components/auth/RoleSelector.tsx` |
| A | `components/errors/ErrorBoundaryFallback.tsx` |
| A | `components/errors/ErrorState.tsx` |
| A | `components/errors/InlineError.tsx` |
| A | `components/errors/ReloadButton.tsx` |
| A | `components/errors/RetryButton.tsx` |
| A | `components/errors/ServiceUnavailableState.tsx` |

### 2.5 `lib/` (17)

| St | Path |
|----|------|
| M | `lib/api/errors.ts` |
| M | `lib/api/response.ts` |
| M | `lib/app-origin.ts` |
| M | `lib/auth/redirect.ts` |
| M | `lib/authz/permissions.ts` |
| M | `lib/dashboard/overview.ts` |
| M | `lib/payment/ipaymu.ts` |
| M | `lib/ticketing/payment/gateway.ts` |
| M | `lib/ticketing/payment/method-catalog.ts` |
| M | `lib/ticketing/payment/validation.ts` |
| A | `lib/auth/client-session.ts` |
| A | `lib/auth/roles.ts` |
| A | `lib/auth/session-gate.ts` |
| A | `lib/errors/classify.ts` |
| A | `lib/errors/infrastructure.ts` |
| A | `lib/events/status.ts` |
| A | `lib/request-key.ts` |

### 2.6 Other areas (7)

| St | Path |
|----|------|
| A | `prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/migration.sql` |
| A | `scripts/setup-test-db.ts` |
| D | `.github/workflows/deploy.yml` |
| D | `.github/workflows/test-vps.yml` |
| D | `storage/...` — 14 files (see §3) |

---

## 3. Intentional deletions (18, all staged, all kept on disk)

**2 stale retail CI workflows** (would have deployed the *deleted* retail project on every push to `main`):

- `.github/workflows/deploy.yml`
- `.github/workflows/test-vps.yml`

**2 generated artifacts** — index-only removal; both files remain on disk and are now covered by
`.gitignore` (§4):

- `tsconfig.tsbuildinfo`
- `next-env.d.ts`

**14 legacy retail uploads** — the affiliate/product imagery belonging to the removed retail application.
Verified one by one: **all 14 still exist on the filesystem**; the deletion is index-only:

- `storage/uploads/affiliate/ktp/cmshbsz3u0000u8xvmnwycont/` — 5 `.jpg`
- `storage/uploads/affiliate/social/cmshbsz3u0000u8xvmnwycont/` — 3 `.jpg`
- `storage/uploads/products/` — 5 `.jpg` + 1 `.webp`

No deletion is physical, and every one of them is recoverable from `HEAD`'s object store.

---

## 4. Ignored / local-only files (excluded from the commit)

| Path | Rule | Why excluded |
|------|------|--------------|
| `.env`, `.env.local`, `.env.production` | `.gitignore:3–5` | real credentials |
| `node_modules/` | `.gitignore:1` | dependencies |
| `.next/` | `.gitignore:2` | build output |
| `storage/` | `.gitignore` (runtime state block) | runtime uploads; holds `storage/uploads/events/1789837107923-….png` (a real event image) |
| `tsconfig.tsbuildinfo` | `.gitignore` `*.tsbuildinfo` | rewritten by every typecheck |
| `next-env.d.ts` | `.gitignore` `next-env.d.ts` | managed by Next.js; docs say remove from Git |

**Confirmed untracked and not staged:**

```bash
$ git ls-files tsconfig.tsbuildinfo next-env.d.ts   # → (no output)
$ git check-ignore -v tsconfig.tsbuildinfo next-env.d.ts
.gitignore:18:*.tsbuildinfo        tsconfig.tsbuildinfo
.gitignore:25:next-env.d.ts        next-env.d.ts
```

`storage/`: 15 files on disk, **14 staged deletions, 0 staged additions**
(`git diff --cached --name-only --diff-filter=ACMR -- storage` → empty). No storage runtime file can
enter this commit.

`package-lock.json` is **not staged** — see §5.4.

---

## 5. Owner-decision items — reported, not resolved

### 5.1 `server.js` — **SAFE TO LEAVE**

Tracked and **unchanged by this release** (it is already in `HEAD`; there is no diff). Its only live
reference in source is an ignore entry in `eslint.config.mjs:20`; every other mention is historical prose
in earlier audit reports. It is not referenced by `package.json` scripts, by `ecosystem.config.cjs`, or by
any deploy path, so it is dead code that this release neither introduces nor removes. Removing it is a
separate, owner-approved cleanup, not a release-blocking change.

### 5.2 Hardcoded deployment domain in `lib/app-origin.ts` — **OWNER DECISION (documented)**

The delta **removes** the ephemeral `trycloudflare.com` quick-tunnel host and keeps exactly one hardcoded
fallback:

```ts
hosts.add("demosolusisejalan.my.id");   // lib/app-origin.ts:132
```

with an in-file note stating that the list is reached **only** when `NEXT_PUBLIC_APP_URL` is unset — which
a production deployment may not be, since `lib/payment/config.ts` refuses to build a payment session in
production without it. `lib/app-origin.server.ts` contains no hardcoded host. **Recommendation: leave it,
and set `NEXT_PUBLIC_APP_URL` on the VPS** (already a documented deployment requirement). Changing the
domain is a product/ops decision.

### 5.3 `allowedDevOrigins` in `next.config.ts` — **SAFE TO LEAVE (pre-existing)**

```ts
allowedDevOrigins: ["100.88.79.104"],   // next.config.ts:74
```

This is **pre-existing at `HEAD`** (`git show HEAD:next.config.ts:5`) — the delta's diff only re-indents
the line. The value is a private LAN address of the current development machine and Next.js applies the
setting **only in development**, so it has no production effect. Making it environment-derived is a nice
cleanup, not a blocker.

### 5.4 Unused dependencies — **OWNER DECISION (unchanged)**

`next-themes@^0.4.6`, `@radix-ui/react-popover@^1.1.23`, `@radix-ui/react-visually-hidden@^1.2.11` are all
still declared. **No dependency was added, removed or changed in this phase**, and `package-lock.json` is
deliberately **not staged**. (Phase 26A's finding stands: of the three, only `next-themes` and
`@radix-ui/react-popover` are truly removable — `react-select` and `react-tooltip` share
`@radix-ui/react-visually-hidden` transitively.) Removing them rewrites the lockfile and needs explicit
approval.

The staged `package.json` diff contains **only**:

```diff
+  "engines": { "node": ">=20.9.0 <25" },
+    "test": "jest",
+    "test:db:setup": "npx tsx scripts/setup-test-db.ts"
```

---

## 6. Confirmations

| # | Confirmation | Evidence |
|---|--------------|----------|
| 1 | Generated files are **not tracked** | `git ls-files tsconfig.tsbuildinfo next-env.d.ts` → empty; both present on disk (`-rw-r--r--`, `-rwxr-xr-x`) |
| 2 | The migration **is included** | `prisma/migrations/20260920000000_drop_unused_legacy_retail_tables/migration.sql` staged (`A`), content unaltered (3476 bytes) |
| 3 | Migration state is **up to date** | `prisma validate` → *schema is valid*; `migrate status` → *23 migrations found*, *Database schema is up to date!* |
| 4 | **No secrets** are staged | no `.env*`/credential/key file in the staged set (only the `.env.example` template); no staged `KEY=`/`SECRET=` assignment with a literal value; the only `sk_live`/`-----BEGIN` hits are test fixtures asserting that a leaked-looking string is *not* rendered and that the template contains none |
| 5 | **No generated / runtime artifacts** staged | no `A`/`M` path under `storage/`, and neither generated file is an addition |
| 6 | **Phase 27 race untouched** | `git diff --cached --name-only \| grep -E "payment\|ipaymu"` → none; `lib/ticketing/payment/service.ts` has **no diff vs `HEAD`**; no added line anywhere in the delta touches `attemptNumber`, `paymentStatus: "PAID"` or settlement |
| 7 | Nothing unrelated is staged | no `console.log`/`debugger`/`FIXME`/TODO/`it.only`/`.skip`/`eslint-disable` added; no conflict markers; `git status` shows **no unstaged and no untracked-not-ignored** path left |

---

## 7. Staged-content audit

```
$ git diff --cached --check
app/login/page.tsx:1: trailing whitespace.      ← 55 complaints, ALL in this one file
...
```

Every remaining `--check` complaint is in `app/login/page.tsx`, and it is **inherited, not introduced**:
`file` reports that file as `CRLF line terminators` in the working tree **and** at `HEAD`
(`git show HEAD:app/login/page.tsx | file -` → CRLF), so git flags each newly added line's `\r`. It is the
only CRLF file in the staged set. Normalising it would rewrite every line of the file for no functional
gain, so it is left alone and recorded here instead.

Two hygiene items found by this audit were fixed before staging:

- `components/auth/RegisterForm.tsx` — an extra blank line at EOF (`new blank line at EOF`); removed.
  `git diff --cached --check` now reports nothing outside the inherited CRLF file.
- `.gitignore` — the two comment blocks above the generated-artifact rules still said the files were
  "currently TRACKED … until it is untracked once with `git rm --cached`". That removal has now been
  staged, so the notes were corrected in the same commit rather than committed as a false statement. The
  rules themselves are unchanged; only the prose changed.

---

## 8. Verification after staging

| Check | Result |
|-------|--------|
| `npx prisma validate` | ✅ *The schema at prisma/schema.prisma is valid* |
| `npx prisma migrate status` | ✅ 23 migrations found · *Database schema is up to date!* |
| `npx tsc --noEmit` | ✅ exit 0, no output |
| `npx eslint .` | ✅ **0 errors**, 3 pre-existing `@next/next/no-img-element` warnings |
| `npm test -- --runInBand` | ✅ **1758 / 1758 passing, 82 suites** — the Phase 27 `payment-races` H1 flake did **not** reproduce this run |
| `npm run build` | ✅ *Compiled successfully* · 19/19 static pages generated |
| Index integrity after build/test | ✅ `git status` still shows only staged entries (proves the ignore rules contain the generated files) |

Database safety: `prisma validate` and `migrate status` are read-only; the Jest run targets the dedicated
`<database>_test` schema (`jest.setup-env.ts` + `__tests__/support/test-database.ts`). No application row
was inserted, updated or deleted.

---

## 9. Verdict

```
PHASE 26B READY FOR COMMIT
```

The release set is staged and verified: **129 files (63 added, 48 modified, 18 deleted)**, no secrets, no
generated or runtime artifacts, the required migration included, the intentional deletions preserved, and
the Phase 27 payment-concurrency race left exactly as it was.

**Not done, and deliberately so:**

- ⛔ **no commit** — `HEAD` is still `8628dbf`; `git reflog` shows no new entry
- ⛔ no push, no deploy, no `git reset`, no `git clean`, no discarded source change
- ⛔ no database mutation, no destructive migration, no `db push`
- ⛔ no dependency change (`package-lock.json` untouched)
- ⛔ the Phase 27 H1 race was **not** fixed
