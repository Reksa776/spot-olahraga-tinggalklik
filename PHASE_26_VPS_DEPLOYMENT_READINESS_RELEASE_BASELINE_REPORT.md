# PHASE 26 — VPS DEPLOYMENT READINESS & RELEASE BASELINE

**Project:** TinggalKlik.Co
**Date:** 2026-09-20
**Baseline:** Phase 24 (auth UX + security headers) is the last code phase; Phase 25 is the last audit.
**Mode:** local release-readiness only. No deployment, no commit, no push, no reset, no clean, no
database reset, no production credential change, no provider call.

---

## 1. Executive summary

Phase 25 answered "is the application operationally secure?" with **READY WITH BLOCKERS** and
listed five blockers. Phase 26 turned each of them into either a bounded implementation or an
exact instruction:

| Phase 25 blocker | Phase 26 outcome |
|---|---|
| **BLOCK-1** release baseline not established in Git | **STILL OPEN — owner action.** The tree is unchanged as a *tracking* problem: 48 modified + 57 untracked release paths + 16 staged deletions. Phase 26 needed Git mutations to be reversible and therefore did **not** commit. A **proposed** categorisation of every path is in §3, so the commit is now a review rather than an investigation. |
| **BLOCK-2** `TRUSTED_PROXY` unset ⇒ platform-wide login bucket | **CODE COMPLETE / VPS CONFIG REQUIRED.** The contract is now written down and, critically, **a second half of the defect was found**: `getClientIp` reads the *first* `x-forwarded-for` entry, so the common nginx idiom `$proxy_add_x_forwarded_for` (which *appends*) would have restored IP spoofing through a header alone. §6 gives the exact safe directive. |
| **BLOCK-3** scheduler not installed | **GATED.** Ten preconditions are enumerated in §13 and in the runbook. Not installed, correctly. |
| **BLOCK-4** upload imagery has no backup contract | **CONTRACT DEFINED.** §8: persistent path outside the checkout, one backup window for uploads **and** database, restore drill as an owner action. |
| **BLOCK-5** no health endpoint, Node unpinned | **FIXED.** `.nvmrc` = `24` + `engines`; `GET /api/health` (liveness) and `GET /api/health/ready` (readiness), verified against a real production build. |

Two further defects were found and fixed in the same bounded pass:

- **An unattended deploy path.** `.github/workflows/deploy.yml` (tracked) fired on **every push to
  `main`**, SSHed into the VPS with `secrets.VPSBIZNET`, and ran `cd ~/demo-marketplace && ./deploy.sh`
  — the **deleted retail project**, at a path that no longer exists. It would have fired the moment
  this release baseline was pushed, which is precisely the moment Phase 26 exists to prepare.
- **A re-registerable third-party host in the origin allowlist.** `lib/app-origin.ts` accepted an
  ephemeral `trycloudflare.com` quick-tunnel hostname as a valid fallback origin — the origin used to
  build payment callback URLs.

Everything is verified: **1737/1737 tests across 80 suites**, `tsc` clean, `eslint` 0 errors,
`prisma validate` clean, 23 migrations up to date, `next build` clean, and the new endpoints
confirmed live against a production build.

**Verdict: BLOCKED — OWNER ACTION REQUIRED** (§24). The code-level contract is complete; what
remains cannot be done by an agent under this phase's constraints (a commit, and VPS-side
configuration).

---

## 2. Scope

**In scope:** the repository's deployment contract — what ships, what runs, what the host must
provide, how it starts, how migrations are applied, how uploads persist, how rollback works, and
the gate before the scheduler.

**Explicitly out of scope:** features, the authorization architecture, payment semantics, the
scheduler's own design (locked by D-I19-03), and every locked Phase 20A/20B decision. No locked
decision was reopened. `lib/authz/**`, `auth.ts`, `lib/ticketing/**` and `lib/payment/**` were not
touched except for the one line of origin-allowlist change described in §16.

**Constraints honoured:** no SSH, no deploy, no cron/systemd, no production environment change, no
`git commit`/`push`/`reset`/`clean`/history rewrite, no `prisma migrate reset`/`db push`, no
truncate, no deletion of business data.

---

## 3. Repository / Git baseline

### 3.1 Observed state

```
branch            main
HEAD              8628dbf "integrasi dengan UI"      (unchanged — nothing committed)
modified          48
untracked         57
staged deletions  16
```

The staged deletions are Phase 26's, and they are the only index changes:

```
D  .github/workflows/deploy.yml
D  .github/workflows/test-vps.yml
D  storage/uploads/affiliate/ktp/<…>/*.jpg      (5)
D  storage/uploads/affiliate/social/<…>/*.jpg   (3)
D  storage/uploads/products/*.jpg, *.webp       (6)
```

Both deletion sets keep their files' content reachable from history (`git checkout HEAD -- <path>`
restores either), and the `storage/` files remain on disk untouched — verified: **15 files on disk,
0 tracked**.

### 3.2 Categorisation of every release path

| Category | Paths (representative) | Ship? |
|---|---|---|
| **1. RELEASE SOURCE** | `app/**`, `components/**`, `lib/**`, `auth.ts`, `proxy.ts`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `components.json`, `eslint.config.mjs`, `jest.config.js`, `package.json`, `package-lock.json` | yes |
| **2. MIGRATION** | `prisma/schema.prisma`, `prisma/migrations/**` — incl. the **untracked** `20260920000000_drop_unused_legacy_retail_tables/` | **yes — required** |
| **3. TEST / TEST SUPPORT** | `__tests__/**` (incl. new `__tests__/support/`, `__tests__/health/`), `jest.setup-env.ts`, `scripts/setup-test-db.ts` | yes |
| **4. DOCUMENTATION** | `README.md`, `DEPLOYMENT_RUNBOOK.md`, `PHASE_*.md` | yes |
| **5. GENERATED / SHOULD BE IGNORED** | `tsconfig.tsbuildinfo`, `next-env.d.ts` — **currently tracked** | no longer tracked (owner action, §15) |
| **6. LOCAL-ONLY / SHOULD NOT SHIP** | `.env` (ignored), `node_modules/`, `.next/`, `storage/` | never |
| **7. NEEDS OWNER DECISION** | `server.js` (dead legacy custom server), unused deps, `demosolusisejalan.my.id` | §15 |

### 3.3 The migration is part of the release

`prisma/migrations/` holds **23** migrations and `npx prisma migrate status` reports
`Database schema is up to date!`. The newest migration — `20260920000000_drop_unused_legacy_retail_tables`,
already applied to the development database in Phase 22 — is **untracked**. Committing the release
baseline without it would leave the VPS one migration behind and produce drift on the next
`migrate status`.

### 3.4 `.gitignore` effectiveness (verified, not assumed)

- `storage/` — `git check-ignore --no-index storage/uploads/events/new.png` →
  `.gitignore:34:storage/` ✅. It previously had **no effect on the 14 already-tracked files** (an
  ignore rule never applies to a tracked path); untracking them in Phase 26 made the rule total:
  `git add -A --dry-run | grep storage/` now returns nothing.
- `*.tsbuildinfo`, `next-env.d.ts`, `.env`, `.next/`, `node_modules/` — present. The first two are
  tracked, so the rules are inert until the owner runs `git rm --cached` (§1.4 of the runbook).
- No other generated artifact is untracked-but-unignored: every one of the 57 untracked entries is
  source, test, documentation, or migration.

---

## 4. Node version contract

**Before:** nothing. No `.nvmrc`, no `.node-version`, no `engines` field anywhere. The only
statement about the runtime in the repository was `nvm use 24` inside the workflow that has now been
deleted.

**After (implemented):**

| File | Value | Why |
|---|---|---|
| `.nvmrc` | `24` | the major the application is built and tested with locally (Node **v24.21.0**, npm **11.19.0**) |
| `package.json` → `engines.node` | `">=20.9.0 <25"` | the floor is not arbitrary — it is `next@16.3.0`'s own declared requirement, read from `node_modules/next/package.json`. The ceiling records that 25 is untested. |

`package-lock.json` is `lockfileVersion: 3`, and `prisma/schema.prisma` declares
`binaryTargets = ["native", "debian-openssl-1.0.x", "debian-openssl-1.1.x", "debian-openssl-3.0.x"]`
— a mismatched runtime is the classic source of "works locally, fails on the VPS" Prisma engine
errors, which is what makes the pin load-bearing rather than cosmetic.

A test derives the floor from the installed Next.js rather than hard-coding it, so a future Next.js
that raises its requirement fails the suite instead of silently invalidating the pin.

**Owner/VPS:** `nvm install 24` / `nvm use`, and PM2 must be installed **under that Node** or
`pm2 startup` will resurrect the application on a different runtime after a reboot.

---

## 5. Environment contract

Derived by grepping every `process.env` read in `app/`, `lib/`, `proxy.ts`, `auth.ts`,
`next.config.ts`, `scripts/` and the Jest setup, then cross-checked against `.env.example`.

| Class | Variables |
|---|---|
| **REQUIRED PRODUCTION** | `DATABASE_URL`, `AUTH_SECRET`, `AUTH_URL`, `NEXT_PUBLIC_APP_URL`, `PAYMENT_ENVIRONMENT`, `IPAYMU_PRODUCTION_VA`, `IPAYMU_PRODUCTION_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JOBS_TICK_SECRET`, `TRUSTED_PROXY`, `UPLOAD_DIR`, `PORT` |
| **OPTIONAL PRODUCTION** | `IPAYMU_PRODUCTION_BASE_URL` (defaults to `https://my.ipaymu.com`, allowlisted) |
| **LOCAL / DEVELOPMENT ONLY** | `IPAYMU_SANDBOX_VA`, `IPAYMU_SANDBOX_API_KEY`, `IPAYMU_SANDBOX_BASE_URL` |
| **LEGACY / UNUSED** | `REDIS_URL` (declared, read only to emit a warning), `IPAYMU_API_KEY`, `IPAYMU_VA`, `IPAYMU_URL`, `IPAYMU_IS_PRODUCTION` (read only by manual operator scripts) |
| **DANGEROUS / MISLEADING** | `HOSTNAME` (not read by `next start`; usually already set by the shell), `PORT` set inside `.env` (resolved by the CLI before `.env` is loaded) |

Three findings worth stating explicitly, all confirmed against the source:

1. `AUTH_SECRET`, `AUTH_URL` and `DATABASE_URL` have **no `process.env` read in the tree** — Auth.js
   reads the first two internally and Prisma resolves the third from the schema. They are still
   mandatory, which is why a grep-based audit alone would miss them.
2. `next start` takes its default port from `process.env.PORT` **before** it loads `.env`
   (`node_modules/next/dist/bin/next`: `.default(3000).env('PORT')`), so a `PORT` line in `.env`
   would look like configuration while doing nothing.
3. `next start` has **no `.env('HOSTNAME')`** — it binds `0.0.0.0` unless `-H` is passed. On a Linux
   shell `HOSTNAME` is already set to the machine name, so relying on it fails *silently*. (The dead
   `server.js` reads exactly that variable.)

**Implemented in `.env.example`:** a RUNTIME section documenting `PORT`/`HOSTNAME`/`NODE_ENV` and
the two traps above. `HOSTNAME=` and `PORT=` are deliberately **not** active assignments, and a test
asserts they never become one.

**Where the environment lives (REQUIRED on the VPS):** not in the repository. The process
environment (systemd/PM2) or a `chmod 600` file the host loads — **one** source of truth, because
Next.js also loads `.env`/`.env.production` from `cwd` by itself.

---

## 6. `TRUSTED_PROXY` and the client-IP contract

### 6.1 What the code does

`lib/rate-limit.ts#getClientIp`, pinned by `__tests__/security/m2-ip-spoofing.test.ts`:

| `TRUSTED_PROXY` | Behaviour |
|---|---|
| unset | forwarding headers **ignored**; every client is `"untrusted"` and shares one bucket |
| set (any non-empty value) | **first** entry of `x-forwarded-for`; else `x-real-ip` |

The consequence of the first row is BLOCK-2: the login bucket is **5 attempts / 15 minutes**, so one
attacker can exhaust it and lock **every** user out of the platform.

### 6.2 The finding Phase 25 did not record

`TRUSTED_PROXY` is a **boolean switch, not an address check** — the code never compares the peer
address to the configured value. That is acceptable, but only because of a coupling that must be
maintained deliberately:

> `ecosystem.config.cjs` binds **`127.0.0.1`**, so nginx on the same host is the only client that can
> reach the process. Loopback binding is what makes the forwarding headers trustworthy.

And, more importantly:

> Because `getClientIp` reads the **first** comma-separated entry, nginx must **OVERWRITE**
> `x-forwarded-for`, not append to it.

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;   # ✗ APPENDS — spoofable
proxy_set_header X-Forwarded-For $remote_addr;                 # ✓ OVERWRITES
```

`$proxy_add_x_forwarded_for` appends the real peer to whatever the client sent, producing
`<attacker-supplied>, <real client ip>` — and the application reads the attacker's value. That
restores a fresh rate-limit bucket per request **without touching a line of application code**. This
is the reason the runbook names the append form as forbidden rather than merely preferring the safe
one.

### 6.3 REQUIRED on the VPS

1. Set `TRUSTED_PROXY` to a non-empty value **and** keep the loopback binding. Setting one without
   the other is a regression in a different direction: `TRUSTED_PROXY` + `0.0.0.0` lets any client
   forge the header, i.e. no throttle at all.
2. Use the §6.2 overwrite directives.
3. `client_max_body_size 8m` — nginx's default is 1 MB, while the application accepts 5 MB event
   images (`lib/images/process.ts#MAX_EVENT_IMAGE_BYTES`), so the default would reject a legal upload
   with a 413 before it reached the application.
4. With a second proxy in front (Cloudflare/LB), use nginx's `real_ip` module so `$remote_addr` is
   the visitor, and leave the directives unchanged.
5. Verify with the runbook's §4.4 check: six attempts with a forged header must be throttled as **one**
   client.

---

## 7. Health / readiness

**Before:** nothing. No endpoint, no probe, no documented way to answer "is the running deployment
healthy?" other than loading a page by hand (Phase 25 BLOCK-5).

**Implemented:**

| Endpoint | Meaning | Status | Touches |
|---|---|---|---|
| `GET /api/health` | liveness — the process answers | always `200` | nothing |
| `GET /api/health/ready` | readiness — the process can serve | `200` / `503` | one `SELECT 1` |

Design decisions, each with a reason:

- **Two endpoints, because they answer different questions.** Liveness answers "should this process
  be restarted?". A database outage cannot be fixed by restarting Node, so liveness touches nothing
  — a single endpoint that checked the database would invite a process manager to restart-loop a
  healthy server, turning one fault into two.
- **`503`, not `500`.** The request was valid; a dependency is unavailable. That is what `503` means
  and what a load balancer and a deploy script already understand.
- **No error detail in the response.** These endpoints are public (a probe holds no session) and a
  Prisma connection error can carry the host and port. The diagnosis is logged server-side using
  `classifyInfrastructureFault` — the same helper the API error layer uses, whose `detail` is
  documented never to include the driver's message — so there is one definition of "safe to log".
- **No mutation, no provider call.** One `SELECT 1`. Deliberately not checking iPaymu: a slow payment
  provider is not a reason to take the site out of rotation, and a probe must never generate provider
  traffic.
- **`no-store`.** A cached "ok" would keep reporting ready after the process died.
- **Public in `proxy.ts`.** The classification test enumerates every `route.ts` and fails on an
  unclassified route, so the new prefix was added deliberately with its rationale.

**Verified live** against `next build && next start` on port 3100 (§17.7).

---

## 8. Upload persistence and backup

### 8.1 How storage works (verified)

- Only `lib/images/process.ts` writes. Target: `<UPLOAD_DIR>/events`, default `./storage/uploads/events`
  **relative to the process working directory**.
- Filenames are generated server-side (`Date.now()` + 16 random bytes + a format-derived extension);
  the client's filename never reaches the filesystem. Path traversal is structurally impossible.
- **The original upload is never written to disk** — validation, metadata stripping and storage are
  all in memory (D-55), so no unprocessed file ever exists at a servable path.
- Serving is by the application (`GET /api/uploads/events/<name>`, public by contract for catalog and
  Open Graph, `immutable` cache, `nosniff`, basename-only).
- The database references the file by URL. **The file exists only on disk.**

### 8.2 The gap

The default path resolves **inside the checkout**. A deploy that replaces the checkout
(fresh clone, `rsync --delete`, `git clean`) would delete every uploaded image while the image rows
survive — broken banners across the catalog. PM2 restart/reload does not touch it, so restarts are
safe either way; it is *deploys* that are dangerous.

### 8.3 REQUIRED contract

1. **`UPLOAD_DIR` = an absolute path outside the checkout** (e.g.
   `/var/lib/tinggalklik/uploads`), owned by the PM2 user.
2. **Back up uploads and the database in the same window, with one timestamp** — a row without its
   file is a broken banner, a file without its row is an orphan. The runbook gives the exact
   `tar` + `mysqldump --single-transaction` pair and names the two archives with a shared `$STAMP` as
   the restore unit.
3. Copy both off the host — a backup on the same disk is not a backup.
4. **Take the pair immediately before every `prisma migrate deploy`** (§10).
5. No cloud storage provider was introduced. This is `tar` + `mysqldump` to a path the operator
   chooses.

**Owner action:** perform one restore drill before going live. An untested backup is a hypothesis,
and Phase 26 could not run one without a server.

---

## 9. PM2 / runtime contract

**Before:** no process definition of any kind. "How does this run in production?" had no answer in the
repository.

**Implemented:** `ecosystem.config.cjs`, with each choice justified in the file:

| Setting | Value | Why |
|---|---|---|
| `script` | `node_modules/next/dist/bin/next` | `pm2 start npm -- start` makes PM2 supervise **npm**, so signals go to npm, the exit code PM2 sees is npm's, and a crash can look like a clean exit |
| `args` | `start -H 127.0.0.1` | binds loopback; the only ingress is nginx. Load-bearing for §6.2 |
| `instances` / `exec_mode` | `1` / `fork` | **correctness, not resources**: `lib/rate-limit.ts` is in-memory and per-process, so a second instance would silently multiply every rate limit |
| `env` | `NODE_ENV=production`, `PORT=3000` | the port's single source of truth |
| `kill_timeout` | `10000` | in-flight payment callbacks and checkouts get time before SIGKILL |
| `time`, `merge_logs` | on | log lines correlate with an incident |
| `env_file` | **absent, deliberately** | secrets come from the process environment; Next.js already loads `.env` from `cwd`, so an `env_file` entry would be a second source of truth |

The `instances: 1` decision is **cross-checked by a test** against `lib/rate-limit.ts`, so if the
limiter ever moves out of process the suite becomes the signal that clustering is now possible.

| Concern | Answer |
|---|---|
| Start / reload | `pm2 start ecosystem.config.cjs` / `pm2 reload tinggalklik` |
| Logs | `~/.pm2/logs/tinggalklik-{out,error}.log` (the defaults; no new directory in the repo) |
| Rotation | **not configured** — `pm2 install pm2-logrotate` (owner action) |
| After reboot | `pm2 startup` once, `pm2 save` after every process change |

Not claimed: `pm2 reload` on a single fork instance is effectively a restart (a few hundred
milliseconds). It is not zero-downtime, and zero-downtime would require clustering, which the
in-memory limiter forbids.

---

## 10. Prisma migration deployment contract

**State:** 23 migrations, `prisma validate` clean, `migrate status` → `Database schema is up to date!`.
There is no `prisma.config.ts`; `DATABASE_URL` is resolved from `prisma/schema.prisma` via
`env("DATABASE_URL")`.

**REQUIRED procedure (forward-only):**

```bash
npx prisma migrate deploy      # the only supported command on a server
npx prisma migrate status      # must report up to date
npx prisma generate            # idempotent; `npm ci` already runs it via @prisma/client's postinstall
```

**Never on a deployment host:** `migrate dev` (can prompt, can reset), `migrate reset`, `db push`
(bypasses history and causes drift).

`@prisma/client`'s own `postinstall` (`node scripts/postinstall.js`) generates the client, so
`npm ci` is sufficient; the explicit `generate` is belt-and-braces for a restored `node_modules`.

**The first deploy runs a destructive migration.**
`20260920000000_drop_unused_legacy_retail_tables` **drops tables**. It is already applied locally.
On the VPS it will run — so the §8.3 backup is not a formality on the first deploy, it is the
difference between a recoverable and an unrecoverable outcome.

**Rollback reality — stated plainly, because a wrong belief here is expensive:**

- **Prisma has no down-migrations.** `migrate deploy` applies forward only. There is no
  `prisma migrate rollback`; a migration that has run is permanent from Prisma's point of view.
- Rolling back the **application** (`git checkout <sha>` + `npm ci` + `build` + reload) does **not**
  undo a migration.
- Rolling back the **schema** means **restoring the pre-deploy dump**, and that discards every write
  since — orders, payments, tickets, refunds. It is a business decision, not a deployment step.
- **Do not hand-write reverse SQL as a rollback plan.** An untested inverse may not preserve data and
  will not update `_prisma_migrations` unless written as a real migration — which makes the history
  disagree with the schema.

---

## 11. Deployment runbook

`DEPLOYMENT_RUNBOOK.md` is the deliverable, and `README.md` now links to it and documents the health
checks. It covers: how to read it (CONTRACT / REQUIRED / OWNER ACTION), the release baseline, the
Node contract, the environment contract, `TRUSTED_PROXY`, health/readiness, upload persistence and
backup, PM2, migrations, the deploy procedure, rollback, the scheduler gate, and the release
checklist.

The procedure, condensed:

**PRE-DEPLOY** — confirm the checkout is clean and record the release SHA; `nvm use` (24); check disk;
confirm the environment **names** are present (never their values); **back up uploads + database in
one window**; `prisma migrate status`; confirm TLS.

**DEPLOY**

```bash
git fetch --all --tags && git checkout <release-sha>   # not `git pull`
npm ci
npx prisma migrate deploy
npx prisma migrate status
npx prisma generate
npm run build
pm2 reload tinggalklik
```

**VERIFY** — `/api/health`, `/api/health/ready` (the deployment gate), security headers, the public
catalog; then by hand: sign-in per role, dashboard, the own-order page (200 for its buyer, 404 for
another account), upload serving, and the rate-limit check from §6.3.

---

## 12. Rollback runbook

| What | How | Caveat |
|---|---|---|
| Application | `git checkout <previous-sha>` → `npm ci` → `npm run build` → `pm2 reload` → verify readiness | Cheap and correct |
| Database | **No rollback.** Either accept the migration (usual) or restore the pre-deploy dump | Restoring loses every write since the dump |
| Uploads | Code rollback does not touch them | If the database was also restored, images written since the dump become harmless orphans |
| Full restore | Only when the schema is restored from a dump **without** its matching uploads tarball | §8.3 gives the pair |

---

## 13. Scheduler gate

**Not installed, and not this phase's job.** `POST /api/internal/jobs/tick` is the only driver of
event-lifecycle transitions (`PUBLISHED → ONGOING → COMPLETED`) and reservation expiry. Without it an
event never completes and abandoned checkouts keep their inventory indefinitely. Its contract is
locked (D-I19-03) and was not re-designed: bearer `JOBS_TICK_SECRET`, constant-time comparison,
fails closed with `401` when unset, one lease row per job in `joblock`.

**Install only when ALL TEN hold:** the app is deployed and reachable over HTTPS; HTTPS works with a
valid certificate; the production environment is verified; `JOBS_TICK_SECRET` is configured and
present in the running process; the tick returns `401` without the header and `200` with it; both
health endpoints answer; `migrate status` is up to date; PM2 persistence across a reboot is verified;
upload persistence is verified; the release is accepted as production-ready.

Then confirm it actually ran (there is no UI):

```sql
SELECT name, lastRunAt, lastStatus, lockedUntil FROM joblock;
```

`lastRunAt` is `NULL` on a live deployment only when the schedule is missing or failing.

---

## 14. Blockers

| # | Blocker | Class | Evidence |
|---|---|---|---|
| 1 | Release baseline is uncommitted (48 modified + 57 untracked + 16 staged deletions), including the applied migration | **OWNER ACTION** | `git status --porcelain`; §3 |
| 2 | `TRUSTED_PROXY` unset on the VPS ⇒ one platform-wide login bucket | **VPS CONFIG** | `lib/rate-limit.ts#getClientIp`; §6.1 |
| 3 | nginx must **overwrite** `x-forwarded-for`; the common append idiom restores spoofing | **VPS CONFIG** | §6.2 |
| 4 | Scheduler not installed ⇒ no lifecycle transitions, no seat release | **GATED** | §13 |
| 5 | `UPLOAD_DIR` currently defaults inside the checkout; imagery has no backup | **VPS CONFIG** | §8.2 |
| 6 | No backup/restore drill has ever been performed | **OWNER ACTION** | §8.3 |
| 7 | nginx `client_max_body_size` default (1 MB) is below the application's 5 MB upload cap | **VPS CONFIG** | §6.3 |
| 8 | `AUTH_URL` / `NEXT_PUBLIC_APP_URL` must be the real HTTPS origin | **VPS CONFIG** | §5; `proxy.ts` documents that Auth.js overwrites `req.url` |

Items 2–5 and 7–8 are **configuration**, not code: each has an exact instruction in the runbook.
Item 1 is the only one that blocks *establishing the release*.

---

## 15. Owner actions

| # | Action | Command / decision |
|---|---|---|
| 1 | Commit and push the release baseline **after review** | see §3.2 for the categorisation |
| 2 | Untrack the two generated files | `git rm --cached tsconfig.tsbuildinfo next-env.d.ts` |
| 3 | Decide the fate of the hardcoded origin `demosolusisejalan.my.id` | keep (it is ours) or delete the line |
| 4 | Approve removal of 3 unused dependencies (`next-themes`, `@radix-ui/react-popover`, `@radix-ui/react-visually-hidden`) — rewrites the lockfile | `npm uninstall …` |
| 5 | Delete or formally retire `server.js` (dead legacy custom server; never use it as the start command) | — |
| 6 | Configure the VPS: `TRUSTED_PROXY`, nginx overwrite directives, `client_max_body_size 8m`, `UPLOAD_DIR` outside the checkout, `AUTH_URL`, `NEXT_PUBLIC_APP_URL` | runbook §3/§4/§6 |
| 7 | `pm2 startup` + `pm2 save`, under the pinned Node | runbook §7 |
| 8 | `pm2 install pm2-logrotate` | runbook §7 |
| 9 | Perform one backup/restore drill | runbook §6.3 |
| 10 | Install the scheduler **only** after the ten gate conditions | runbook §10 |
| 11 | Optional: remove `allowedDevOrigins: ["100.88.79.104"]` (dev-only, but it publishes an internal address) | `next.config.ts` |

---

## 16. Safe bounded fixes implemented

| # | Change | File(s) | Why it was safe |
|---|---|---|---|
| 1 | Node pin | `.nvmrc` (new), `package.json` | additive; nothing reads it at runtime |
| 2 | Liveness + readiness endpoints | `app/api/health/route.ts`, `app/api/health/ready/route.ts` (new), `proxy.ts` | additive; one read-only `SELECT 1`; no mutation, no provider call |
| 3 | PM2 process definition | `ecosystem.config.cjs` (new), `eslint.config.mjs` | inert without PM2 installed; no secrets; path-independent via `__dirname` |
| 4 | Removed the unattended deploy path | `.github/workflows/deploy.yml`, `test-vps.yml` (deleted) | both deploy the **deleted retail project**; content recoverable from history |
| 5 | Removed the re-registerable tunnel host | `lib/app-origin.ts` | only consulted when `NEXT_PUBLIC_APP_URL` is unset; a correct deployment cannot notice |
| 6 | Untracked legacy runtime uploads | 14 `storage/**` paths (index only) | files remain on disk; `git checkout HEAD -- <path>` reverses it |
| 7 | Documented the runtime traps | `.env.example` | documentation only; `HOSTNAME`/`PORT` deliberately not active assignments |
| 8 | Deployment/rollback runbook + README pointers | `DEPLOYMENT_RUNBOOK.md` (new), `README.md` | documentation |
| 9 | Regression tests | `__tests__/health/`, `__tests__/security/deployment-baseline.test.ts`, `jest.config.js` | test-only |

Nothing in `lib/ticketing/**`, `lib/payment/**`, `lib/authz/**`, `auth.ts`, the webhook, settlement,
ticket issuance or refund logic was modified. **Verified by diff** — see §19.

---

## 17. Tests and verification

### 17.1 Commands

| Command | Result |
|---|---|
| `npx prisma validate` | ✅ `The schema at prisma/schema.prisma is valid 🚀` |
| `npx prisma migrate status` | ✅ `23 migrations found` · `Database schema is up to date!` |
| `npx tsc --noEmit` | ✅ exit 0, no output |
| `npx eslint .` | ✅ **0 errors**, 3 warnings (all pre-existing `@next/next/no-img-element`) — unchanged from Phase 25's baseline |
| `npm test -- --runInBand` | ✅ **1737 passed / 1737 total across 80 suites, 0 failures** (Phase 25 baseline: 1703 / 78 suites) |
| `npm run build` | ✅ exit 0 |

**New tests: 34** — `__tests__/health/health-endpoints.test.ts` (10) and
`__tests__/security/deployment-baseline.test.ts` (24). No existing test was weakened, skipped or
deleted; the full suite was green *before* these were added and is green after.

### 17.2 What the new tests actually pin

- **Liveness touches nothing** — asserts `prisma.$queryRaw` is never called. This is the property
  that stops a database outage from restart-looping a healthy process.
- **Readiness is `503`, not `500`**, and on a Prisma init error the response contains neither the
  host, the port, `"Can't reach"`, `"Prisma"` nor a stack — while the **server log** carries the
  sanitised `DATABASE_UNAVAILABLE` classification. Both halves are asserted, so the leak cannot be
  reintroduced in either direction.
- **Unrecognised throws still fail closed** (503, body clean, logged as `unrecognised error`).
- **The Node pin is consistent with the framework's own floor**, derived from the installed Next.js.
- **No unattended deploy path**: no workflow may use `ssh-action`, `deploy.sh`, `nvm use`, or name
  `demo-marketplace`/`VPSBIZNET`/`VPS_SSH_KEY`. A plain lint/test workflow is deliberately *not*
  forbidden.
- **`instances: 1` is justified against the source** (the limiter really is an in-process `Map`), so
  the assertion becomes a signal when the limiter moves out of process.
- **The origin allowlist admits no re-registerable host**, asserted against the `hosts.add("…")` call
  sites (so the comment explaining the removal does not have to be deleted to keep the test honest).
- **`HOSTNAME`/`PORT` never become `.env` assignments**, and the trap is documented.

### 17.3 Live verification (production build)

`next build` then `next start -H 127.0.0.1` on port 3100 with the real development environment:

```
GET /api/health         → 200  {"status":"ok"}          cache-control: no-store
GET /api/health/ready   → 200  {"status":"ready","checks":{"database":"ok"}}  cache-control: no-store
```

Security headers are present on both new routes (`X-Content-Type-Options: nosniff`,
`X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`,
full `Content-Security-Policy`) plus `Strict-Transport-Security` under `NODE_ENV=production` —
confirming the Phase 24 header layer covers the new surface rather than being scoped per route.

Anonymous gating is unchanged: `GET /dashboard → 302` to
`http://localhost:3000/login?callbackUrl=%2Fdashboard` (the origin comes from `AUTH_URL`, exactly as
`proxy.ts` documents). `GET /ticketing/orders/EVT-DOES-NOT-EXIST` → `302` for an anonymous caller,
which is the login gate, not a 404 — the 404-for-unknown-order contract is asserted by
`__tests__/ticketing-checkout/order-ownership-404.integration.test.ts`, which passes.

**Not verified, and stated as such:** the readiness `503` path against a real database outage (that
would require stopping MySQL, which this phase must not do — it is covered by unit test), any
browser-side behaviour, and anything on the VPS itself.

---

## 18. Files changed

| File | Change |
|---|---|
| `.nvmrc` | **new** — Node 24 |
| `package.json` | `engines.node` = `">=20.9.0 <25"` |
| `app/api/health/route.ts` | **new** — liveness |
| `app/api/health/ready/route.ts` | **new** — readiness |
| `proxy.ts` | `/api/health` classified PUBLIC, with rationale |
| `ecosystem.config.cjs` | **new** — PM2 process definition |
| `eslint.config.mjs` | `ecosystem.config.cjs` added to the CommonJS scope |
| `.github/workflows/deploy.yml`, `test-vps.yml` | **deleted** (stale retail auto-deploy) |
| `lib/app-origin.ts` | removed the ephemeral tunnel host; corrected two comments that claimed a source the code never read |
| `.gitignore` | *(Phase 25's `storage/`, `*.tsbuildinfo`, `next-env.d.ts` rules are now effective for `storage/` after the untracking)* |
| `storage/**` (14 paths) | **untracked** (index only; files untouched on disk) |
| `.env.example` | added the RUNTIME section |
| `DEPLOYMENT_RUNBOOK.md` | **new** |
| `README.md` | health-check section + runbook pointer |
| `jest.config.js` | `__tests__/health/*.test.ts` added to `testMatch` |
| `__tests__/health/health-endpoints.test.ts` | **new** (10 tests) |
| `__tests__/security/deployment-baseline.test.ts` | **new** (24 tests) |
| `PHASE_26_VPS_DEPLOYMENT_READINESS_RELEASE_BASELINE_REPORT.md` | **new** — this report |

---

## 19. Database and payment safety verification

- **No schema or data command was run.** Execution was limited to `prisma validate` and
  `prisma migrate status` (both read-only) plus `count()` queries.
- **No `migrate reset`, no `db push`, no `DROP`, no `TRUNCATE`, no `DELETE`.** No destructive
  migration was authored or applied.
- **Jest targets the dedicated test database.** `jest.config.js` → `setupFiles: jest.setup-env.ts` →
  `applyTestDatabaseUrl()` redirects `DATABASE_URL` to `<database>_test` in every worker before the
  test module graph is imported; `globalSetup` refuses to start a run whose test database is missing
  or behind. The development schema is not written to by a suite.
- **Development database, read-only observation after the phase:** `users 275`, `events 14`,
  `eventOrders 14`, `payments 9`, `tickets 0`, `sports 26`. No row was inserted, updated or deleted by
  Phase 26.
- **No payment code was modified.** `lib/payment/**` and `lib/ticketing/payment/**` were not touched;
  network access was limited to `127.0.0.1` requests against the local production build.
- **No iPaymu call was made**, in sandbox or production. No credential was read, changed or printed.

---

## 20. Explicit statements

- **No deployment was performed.** No SSH, no VPS access, no PM2 process, no reverse-proxy change.
- **No commit and no push.** `HEAD` is still `8628dbf`; all Phase 26 changes are unstaged/staged in
  the working tree only.
- **No `git reset`, no `git clean`, no history rewrite, no `git checkout -- .`.**
- **No database reset**, no `migrate reset`, no `db push`, no truncate.
- **No production data was modified or deleted.** The only index deletions are the two stale
  workflows and 14 legacy runtime-upload paths whose **files remain on disk**.
- **The scheduler was not installed.** No cron entry, no systemd unit, no scheduler configuration,
  and no change to `JOBS_TICK_SECRET`.
- **No files were deleted to make Git clean.** Both deletion sets were approved explicitly and are
  recoverable from history.
- **Nothing could be verified on the VPS, and nothing is claimed about the VPS state.**

---

## 21. FINAL VERDICT

**PHASE 26 BLOCKED — OWNER ACTION REQUIRED**

The deployment contract is complete and verified: the runtime is pinned, the environment and IP
contracts are written down (including the `x-forwarded-for` overwrite defect that would otherwise
have silently disabled rate limiting), health and readiness exist and were proven against a real
production build, the release has a process definition, migrations have a forward-only procedure
with an honest rollback statement, uploads have a persistence and backup contract, and the scheduler
has a ten-condition gate.

The blockers that remain are not code: **the release baseline has not been committed** (§3, §14.1),
and the VPS must be configured per §6.3, §8.3 and §15. Fixing any of those from inside this phase
would have required exactly the actions the phase forbade.
