# SECURITY_REMEDIATION_CLOSEOUT_REPORT.md

**Scope:** independent closeout audit of the Security Remediation phase for findings **F-01**, **F-02** and **F-03**.
**Mode:** verification only. No implementation of F-04…F-09, no auth-architecture, dashboard-routing, DB, payment/refund/settlement or unrelated-security-control changes. No CRLF normalization, no `.gitattributes`, no Git config change, no commit, no push, no reset/rebase/stash.
**Branch:** `main` · **HEAD:** `fb7013c fix ui landing page` (unchanged) · **Nothing staged.**

---

## 1. Executive summary

All three findings verify against the actual code, by three independent means: reading the implementation, running the repository's tests, and a standalone `tsx` probe that exercises the real exported functions outside Jest (**52/52 assertions passed**).

- **F-01 — PASS (actionable advisories remediated).** `next` 16.3.0 → **16.3.6**, `sharp` 0.35.3 → **0.35.5**, `nanoid` 3.3.17 → **3.3.19**, `eslint-config-next` 16.3.0 → **16.3.6**. The critical Next.js advisories, the `sharp`/libheif advisories and the `nanoid` advisory are gone from `npm audit --omit=dev`. Prisma was **not** upgraded (still 6.19.3 / `@prisma/client` 6.19.3) and no framework migration occurred: **0 packages added, 0 removed**, 42 version changes, all inside the intended blast radius.
- **F-02 — PASS.** `TRUSTED_PROXY` is parsed into an explicit IP/CIDR allow-list; 23 invalid/truthy values (including `false`, `true`, `no`, `nginx`, `*`, `0.0.0.0/0`) all fail closed and never enable proxy trust; a malformed member invalidates the whole list; non-IP forwarded values are discarded; a spoofed `x-forwarded-for` can no longer create a bucket.
- **F-03 — PASS.** A hard login refusal is now applied **only** when the bucket key names a trustworthy client. Five failed passwords from one attacker without a valid `TRUSTED_PROXY` no longer refuses anybody else; per-account and platform-wide controls are **bounded delays** (≤1500 ms / ≤1000 ms) that cannot lock out an account or the platform; the limiter's memory is hard-capped at 50 000 windows with O(1) eviction that can only forget failures; a successful verification clears the account window.
- **Residual dependency advisory** (`deepmerge-ts <8` via `prisma → @prisma/config`, CLI-only) remains **explicitly deferred** — `@prisma/config@6.19.3` pins `deepmerge-ts` to `7.1.5` exactly and the advisory covers every `<8.0.0` release, so no non-breaking fix exists.
- **One residual behavioral consequence of the F-03 fix was found and is reported, not fixed** (§5.7 and §11): with no valid `TRUSTED_PROXY`, `POST /api/auth/register` now has no rate limit at all (its former bucket was the shared sentinel, i.e. 3 registrations per hour platform-wide — itself a denial of registration). Requires `TRUSTED_PROXY` to be set; out of closeout scope.
- No new security regression was found in the diff (§8). The pre-existing PIC-dashboard/realtime work is **byte-identical** (§9).

---

## 2. Baseline captured

```
git status --short        20 modified, 3 untracked, nothing staged
                          (the 4th untracked file is this report, created by the closeout itself)
git diff --stat           20 files changed, 1861 insertions(+), 572 deletions(-)
git diff --check          exit 2 — 84 "trailing whitespace" lines, all in auth.ts (CRLF, see §8)
branch / HEAD             main / fb7013c (reflog: commit-only, no reset/rebase/amend)
git stash list            (empty)
```

### A. Security-Remediation F-01/F-02/F-03 files (verified from the diff, not assumed)

| Finding | Files |
|---|---|
| F-01 | `package.json`, `package-lock.json` |
| F-02/F-03 | `lib/rate-limit.ts`, `auth.ts`, `app/api/auth/register/route.ts`, `.env.example`, `DEPLOYMENT_RUNBOOK.md`, `ecosystem.config.cjs` |
| Tests | `__tests__/security/login-abuse-control.test.ts` (new), `__tests__/security/phase27a-login-rate-limit.test.ts`, `__tests__/auth-flow/register-route.test.ts`, `__tests__/auth-flow/register-customer-only.test.ts` |

The declared list matches the actual diff exactly. No file outside these sets and the pre-existing PIC set was modified.

### B. Pre-existing PIC-dashboard/realtime work — fingerprints captured before this phase

| File | sha256(diff)[:16] | diffstat |
|---|---|---|
| `app/dashboard/pic/page.tsx` | `de8f74f7c5ee8731` | 162 |
| `components/dashboard/primitives.tsx` | `7e0bbd614f1092c2` | 12 |
| `lib/pic/self-service.ts` | `c345ccaa490ef6ba` | 357 |
| `lib/realtime/taxonomy.ts` | `8fd95935452fde32` | 9 |
| `lib/ui/route-inventory.ts` | `e93762f9179fda7c` | 13 |
| `__tests__/pic-self-service/dashboard-filters.integration.test.ts` | `d0b7720819ba13d2` | 303 |
| `__tests__/pic-self-service/dashboard-kpi-navigation.test.ts` | `04ab021152d6ffb2` | 205 |
| `__tests__/realtime/taxonomy.test.ts` | `9155a251958743a2` | 8 |
| `__tests__/ui-consolidation/route-inventory.test.ts` | `7babefcb1160acab` | 17 |
| *untracked* `app/dashboard/pic/orders/[orderNumber]/page.tsx` | `c31b961ccac0d955` | — |
| *untracked* `components/dashboard/filters/SingleSelectFilter.tsx` | `cb544c8f3cde43f3` | — |

PIC subtotal: **884 insertions / 202 deletions** across 9 files.

---

## 3. F-01 closeout

### Dependency versions (verified)

| Package | Declared | Resolved | Notes |
|---|---|---|---|
| `next` | `^16.3.6` | **16.3.6** | was `^16.3.0` / 16.3.0 |
| `eslint-config-next` | `16.3.6` (exact, devDep) | **16.3.6** | was `16.3.0` |
| `sharp` | *not a direct dependency* | **0.35.5** `overridden` | optional dependency of `next` (`^0.35.3`) |
| `nanoid` | *not a direct dependency* | **3.3.19** `overridden` | transitive via `postcss` (`^3.3.16`) |
| `overrides` | `{ "nanoid": "^3.3.19", "sharp": "^0.35.5" }` | — | honoured (npm marks both `overridden`) |
| `prisma` / `@prisma/client` | `^6.19.3` | **6.19.3** | **unchanged, same major line** |
| `deepmerge-ts` | transitive | **7.1.5** | via `prisma → @prisma/config@6.19.3` |
| `react` / `react-dom` / `next-auth` / `zod` | `^19.2.8` / `^19.2.8` / `^5.0.0-beta.32` / `^4.4.3` | unchanged | no unrelated dependency migration |

`npm ls next sharp nanoid deepmerge-ts @prisma/config prisma` confirms: `next@16.3.6`, `sharp@0.35.5 overridden`, `nanoid@3.3.19 overridden` (both `postcss` instances deduped), `prisma@6.19.3 → @prisma/config@6.19.3 → deepmerge-ts@7.1.5`.

### Lockfile change surface (verified by diffing the package key sets before/after)

- **0 package entries added, 0 removed.**
- 42 version changes, all inside the intended blast radius: `next`, `@next/env`, `@next/eslint-plugin-next`, all 9 `@next/swc-*` platform binaries, `@swc/helpers` (Next's own dep), `sharp`, all 25 `@img/sharp-*` / `@img/sharp-libvips-*` platform packages, `nanoid`, `eslint-config-next`, and `fastq` 1.20.1 → 1.20.3.
- `fastq` was **not** advisory-driven: it is a dev-tool transitive (`eslint-config-next@16.3.6 → @next/eslint-plugin-next → fast-glob → @nodelib/fs.walk → fastq`), a patch bump, not covered by any advisory.
- Root dependency map changed for exactly one entry (`next`); root devDependency map for exactly one (`eslint-config-next`). `overrides` is stored in `package.json` (npm 10 does not mirror it into the lock root) and takes effect, as `npm ls` shows.

### `npm audit --omit=dev` result

```
deepmerge-ts  <8.0.0   high   GHSA-ggr8-5vv4-36mx (stack exhaustion)
  @prisma/config  6.13.0-dev.1 - 8.1.0-dev.4   depends on vulnerable deepmerge-ts
    prisma        6.13.0-dev.1 - 8.1.0-dev.4   depends on vulnerable @prisma/config

3 high severity vulnerabilities   ← one root cause
```

**Resolved:** the two `next` advisories (critical: unauth RCE on Windows-hosted servers; unauth RCE in the Image Optimization API with AVIF), the `sharp`/libheif advisories, and `nanoid`.
**Advisory entries remaining:** `@prisma/config`, `deepmerge-ts`, `prisma` — i.e. **one** root cause, and it is the only residual dependency advisory. Confirmed by listing the audit entry names.

### Why the Prisma/deepmerge-ts residual remains deferred

1. The advisory range is **`<8.0.0`**, so no 7.x release fixes it; only an 8.x force-override would.
2. `@prisma/config@6.19.3` pins `"deepmerge-ts": "7.1.5"` **exactly** — an override to 8.x would sit outside a hard-pinned range of a package that loads Prisma config, i.e. an unverified major bump of a transitive dependency (the same class of "blind upgrade" the remediation was told to avoid).
3. `npm audit fix --force` proposes `prisma@6.12.0`, a **downgrade** — worse, not better. Not run.
4. Reachability is limited: the chain is `prisma` (CLI) → `@prisma/config` (config-file loader) → `deepmerge-ts`. `@prisma/client` does not depend on `@prisma/config`, so this is **not on the request path**; the flaw needs an attacker-controlled, deeply-recursive object at CLI time. It appears under `--omit=dev` only because `prisma` sits in `dependencies`.
5. Recommended follow-up (deployment decision, not applied): move `prisma`/`@prisma/client` forward when upstream moves to `deepmerge-ts` 8, and/or move the CLI to `devDependencies` if the host never runs Prisma CLI commands at runtime.

---

## 4. F-02 closeout

### Parser

`lib/rate-limit.ts` exports `parseTrustedProxy(raw)` and `normaliseProxyEntry(entry)`; `getClientIp()` calls the parser and reads forwarding headers **only** when it returned a non-null allow-list. There is no truthiness test anywhere on this path — verified in source (`getClientIp` at line 293, `parseTrustedProxy` at 468, `normaliseProxyEntry` at 420, `firstClientAddress` at 502, `hasTrustworthyClientKey` at 629).

### Accepted formats (verified behaviourally, not from comments)

`10.0.0.1` · `127.0.0.1,::1` · `127.0.0.1, ::1` (whitespace tolerated) · `172.16.0.0/12` · `2001:db8::/32` · `[::1]/128` → parsed to the normalised list; empty parts are ignored (`10.0.0.1,,10.0.0.2` → two entries). With a valid list and a header: first `x-forwarded-for` hop is the client, `x-real-ip` is the fallback, and **no header** yields the `"untrusted"` sentinel (fail-closed).

### Rejected formats → trust stays OFF (all verified by executing the parser and `getClientIp`)

`false` · `true` · `yes` · `no` · `on` · `off` · `0` · `1` · `nginx` · `all` · `localhost` · `*` · `0.0.0.0/0` · `::/0` · `127.0.0.1:8080` · `http://10.0.0.1` · `10.0.0.256` · `10.0.0.0/33` · `::1/129` · `::::` · `1:2:3:4:5:6:7:8:9` · `10.0.0.1/8/8` · whitespace-only.

For **every** one of those, `parseTrustedProxy(v) === null` and `getClientIp(spoofed x-forwarded-for + x-real-ip) === "untrusted"`.

### Fail-closed behaviour

- Malformed member invalidates the **whole list** (`10.0.0.1, nginx` → `null`), so a typo cannot silently shrink what the operator configured.
- No valid configuration ⇒ both forwarding headers ignored ⇒ shared sentinel ⇒ `hasTrustworthyClientKey() === false`.
- A forwarded value that is not an IP (`not-an-ip`, `<script>…`, `1.2.3.4; DROP TABLE`, `0.0.0.0.0`, `10.0.0.1:8080`) is **discarded** rather than used as a bucket key.
- Warning behaviour: one `console.warn` per distinct invalid value (repeat requests do not re-warn), **no** warning for a valid value. The warning prints only the bounded config value (≤48 chars) — no credentials, no identifiers. Verified with a spy in the suite and observed in the probe.

### Spoofing results

| Scenario | Result |
|---|---|
| No `TRUSTED_PROXY`, spoofed `x-forwarded-for` | `"untrusted"` — spoof ignored; no per-request bucket |
| No `TRUSTED_PROXY`, spoofed `x-real-ip` | `"untrusted"` |
| `TRUSTED_PROXY="false"` (or any of the 22 other invalid values), spoofed headers | `"untrusted"` |
| Valid config + spoofed **junk** forwarded value | `"untrusted"` (discarded) |
| Valid config + real forwarded IP | that IP, and `hasTrustworthyClientKey() === true` |
| `m2-ip-spoofing.test.ts` (8 tests, unmodified) | passes — the M2 guarantee is intact |

---

## 5. F-03 closeout

### 5.1 Old shared-lockout behaviour

`clientRateLimitKey()` returns the sentinel `"untrusted"` in production when no valid proxy configuration produced a client address; `auth.ts` applied a hard **5-failures/15-min** refusal on that key, so every anonymous visitor shared one bucket: five wrong passwords from one stranger refused every other user's sign-in. The runbook itself documented this as "a platform-wide throttle: one attacker can lock every user out".

### 5.2 New control model

| Control | Key | Effect | Can it refuse? |
|---|---|---|---|
| Per-client refusal (unchanged) | real client IP (valid proxy) or `dev-local` in development | 5 failures / 15 min, thrown as `LoginRateLimited` | **Yes — only when `hasTrustworthyClientKey()` is true** |
| Per-identifier throttle (new) | `HMAC-SHA256(normalised identifier)` keyed by a per-process random 256-bit secret, truncated to 96 bits | first 5 failures free, then +150 ms each, capped at **1500 ms**; window 15 min; cleared on success | **No** (delay only) |
| Platform-wide throttle (new) | fixed `login-global` key | from 200 failures / 5 min, +250 ms per further 200, capped at **1000 ms**; warns once a minute | **No** (delay only) |

The account/global surfaces expose **only** `accountKey`, `accountThrottleMs`, `recordAccountFailure`, `clearAccountFailures` and `throttleMs`, `recordFailure` — there is no `allowed`, no `locked`, no boolean decision about an account or the platform (asserted structurally and by key-set equality in the probe).

### 5.3 Per-client refusal rule (verified in `auth.ts`)

```ts
const loginKey = clientRateLimitKey(request);
const hasClientIdentity = hasTrustworthyClientKey(request);
if (hasClientIdentity && !rateLimiters.login.check(loginKey).allowed) { … throw new LoginRateLimited(); }
```
This is the **only** `.allowed` refusal site in `auth.ts` (line 162). Ordering verified: refusal → malformed-credential early return (`return null`, charges nothing) → identifier/password → account key → summed bounded delay → one charge helper → DB lookup → password verify → 4 failure branches → success clears.

Critical property, verified by probe: with no valid `TRUSTED_PROXY`, a spoofed header keeps the sentinel, `hasTrustworthyClientKey()` is `false`, and the guard cannot fire. Even when five failures are charged **directly** to the `untrusted` bucket (more than `auth.ts` would ever do), an unrelated client's bucket is untouched, the global throttle stays at 0 and an unrelated account is not throttled.

### 5.4 Charge accounting (verified by counting in the diff)

- `chargeLoginFailure()` call sites: **4** — unknown user (284), deactivated account (302), no password (323), wrong password (339).
- Inside the helper: exactly **one** `rateLimiters.login.recordFailure(loginKey)`, and it is charged **only** when `hasClientIdentity`; the account and global counters are always charged.
- Success path (358): `clearAccountFailures(accountKey)` appears **before** `return {`, with **no** `chargeLoginFailure` at or after it.
- No duplicate charging, no success charging, no failure-path inconsistency.

### 5.5 Enumeration resistance

- The identifier is never stored; the bucket key is an HMAC under a per-process random key, so digests are not reversible and not comparable across restarts/processes. Probe confirms the key is 24 hex chars containing no fragment of the identifier.
- Unknown identifiers accumulate windows exactly like real ones, and the delay depends only on the failure count — so no count, delay or timing (including the probe's synthetic case) distinguishes them.
- Structural: `lib/rate-limit.ts` references no Prisma/DB symbol, so the accounting *cannot* consult account existence; the throttle is computed before the user lookup.
- No new message surface: the refusal keeps the one shared machine code; the three visitor-facing sentences are unchanged and none names an account state.
- Only two `console.warn` calls were added in the whole remediation diff (invalid `TRUSTED_PROXY`; platform-wide failure count) — neither logs identifiers, passwords or tokens.

### 5.6 Memory bound and delays

`MAX_STORE_ENTRIES = 50_000`, with O(1) eviction of the oldest insertion at the cap and a `store.has(key)` guard so an update never evicts another window. Eviction can only *forget* failures (loosen a limit), never invent one — verified: after a 60 000-key flood, a fresh key still has zero delay and the store is ≤ 50 000 (probe: `before=… after=50000`; jest test asserts the same). Account delay verified `0 → 150 → 1500` (capped) and global delay `0 → … → 1000` (capped), both finite under arbitrary failure volume.

### 5.7 Registration route — same root-cause fix, and its residual consequence

`app/api/auth/register/route.ts` no longer applies its 3-per-hour bucket to a key that does not name a client (`if (hasTrustworthyClientKey(req)) { … 429 … }`). That removes the identical platform-wide DoS (three registrations per hour, globally).

**Residual risk, reported rather than silently fixed (closeout scope):** in a deployment with **no valid `TRUSTED_PROXY`**, `POST /api/auth/register` now has no rate limit at all. It retains same-origin CSRF enforcement, Zod validation, the unique-constraint duplicate check and audit-visible logging, but bulk account creation with distinct emails becomes possible. Mitigation is configuration (set `TRUSTED_PROXY` to the proxy's address — now documented as required for per-client limits in `.env.example` and `DEPLOYMENT_RUNBOOK.md` §4). A generous *global* hard cap for registration would restore a bounded limit without a lockout, but that is new behaviour outside this phase's scope and was **not** implemented.

---

## 6. Test results

| Run | Result |
|---|---|
| `npm test -- --runInBand __tests__/security/login-abuse-control.test.ts __tests__/security/phase27a-login-rate-limit.test.ts __tests__/security/m2-ip-spoofing.test.ts` | **3 suites, 84 tests passed** |
| `npm test -- --runInBand __tests__/auth-flow/register-route.test.ts __tests__/auth-flow/register-customer-only.test.ts` | **2 suites, 26 tests passed** |
| `npm test -- --runInBand` (full regression) | **153 suites, 3304 tests, 2 snapshots — all passed** (117 s) |

Full-suite counts match the remediation baseline **exactly** (153 / 3304 / 2) — no difference to explain, and no test was skipped or made conditional.

**Independent probe (outside Jest):** `npx tsx` against the real exported functions — **52 assertions, 52 passed, exit 0** — covering all 23 rejected values, 6 accepted forms, whole-list invalidation, header fallback, non-IP discard, `hasTrustworthyClientKey` in both environments, the sentinel-refusal property, account delay ramp/cap/clear, global delay cap, store bound, and the no-refusal API surface.

---

## 7. Typecheck / lint / Prisma / build

| Command | Result |
|---|---|
| `npx tsc --noEmit --incremental false` | **PASS** — exit 0, no output |
| `npm run lint` | **PASS** — 0 errors, the same 4 pre-existing warnings (`app/e/[slug]/page.tsx` ×2 and `components/events/EventCard.tsx` no-img-element; `scripts/verify-phase33-live.js` unused `custCookies`). No new warnings or errors. |
| `npx prisma validate` | **PASS** — "The schema at prisma/schema.prisma is valid 🚀" |
| `rm -rf .next && npm run build` | **PASS** — exit 0, "✓ Compiled successfully in 23.8s"; route table rendered; no TypeScript errors. (A pre-existing, non-fatal turbopack dynamic-`require`/`path.join` tracing warning referencing `lib/branding/logo.ts` — untouched by this work — is the only noise.) |

---

## 8. `git diff --check` result

```
$ git diff --check      → exit 2
auth.ts:9: trailing whitespace.
auth.ts:141: trailing whitespace.
… 84 lines, all "auth.ts:<line>: trailing whitespace", each followed by the content line
```

**Investigated; CRLF-related; nothing normalized, no config changed.**

| Check | Result |
|---|---|
| Files flagged | **only `auth.ts`** — 84 flagged headers ↔ 84 content lines |
| Flagged lines carrying *real* trailing whitespace (space/tab before the CR) | **0** |
| Flagged lines not ending in CR | **0** |
| `HEAD:auth.ts` line endings | **408 CRLF / 0 lone LF** |
| worktree `auth.ts` line endings | **486 CRLF / 0 lone LF** |
| `.gitattributes` | absent |
| `core.whitespace` / `core.autocrlf` | both unset |
| Every other remediation file | `i/lf w/lf` — not flagged |

Conclusion: the warning is git's default whitespace rule treating the pre-existing CR at end-of-line as trailing whitespace. The added lines follow the file's existing (and unchanged) CRLF convention; no whitespace was introduced. Any edit to `auth.ts` produces this, and the only remedies (normalize the file to LF, add `.gitattributes`, or set `core.whitespace`) are repository-hygiene changes explicitly out of scope for this phase. **Reported, not fixed** — the security diff is not rewritten for it.

---

## 9. PIC-dashboard/realtime worktree integrity

Every fingerprint re-measured after all closeout commands and compared with the baseline captured before this phase:

| File | Baseline | Now | Verdict |
|---|---|---|---|
| `app/dashboard/pic/page.tsx` | `de8f74f7c5ee8731` | `de8f74f7c5ee8731` | identical |
| `components/dashboard/primitives.tsx` | `7e0bbd614f1092c2` | `7e0bbd614f1092c2` | identical |
| `lib/pic/self-service.ts` | `c345ccaa490ef6ba` | `c345ccaa490ef6ba` | identical |
| `lib/realtime/taxonomy.ts` | `8fd95935452fde32` | `8fd95935452fde32` | identical |
| `lib/ui/route-inventory.ts` | `e93762f9179fda7c` | `e93762f9179fda7c` | identical |
| `__tests__/pic-self-service/dashboard-filters.integration.test.ts` | `d0b7720819ba13d2` | `d0b7720819ba13d2` | identical |
| `__tests__/pic-self-service/dashboard-kpi-navigation.test.ts` | `04ab021152d6ffb2` | `04ab021152d6ffb2` | identical |
| `__tests__/realtime/taxonomy.test.ts` | `9155a251958743a2` | `9155a251958743a2` | identical |
| `__tests__/ui-consolidation/route-inventory.test.ts` | `7babefcb1160acab` | `7babefcb1160acab` | identical |
| *untracked* `app/dashboard/pic/orders/[orderNumber]/page.tsx` | `c31b961ccac0d955` | `c31b961ccac0d955` | present, identical |
| *untracked* `components/dashboard/filters/SingleSelectFilter.tsx` | `cb544c8f3cde43f3` | `cb544c8f3cde43f3` | present, identical |

PIC subtotal unchanged at **884 insertions / 202 deletions**. Nothing was staged, reverted or "cleaned up". **PASS.**

---

## 10. Files changed by this phase

**Code/asset files:** none. This phase created **one** new file:

- `SECURITY_REMEDIATION_CLOSEOUT_REPORT.md` (this report, untracked, not staged)

All diagnostic artifacts were written outside the repository (`/tmp/build.log`, `/tmp/closeout-build.log`, `/tmp/check.log`, `/tmp/changed.txt`). No dependency, source, configuration, test or documentation file was modified during the closeout; `git diff --stat` totals are unchanged from the phase baseline (1861 / 572) and all PIC fingerprints are identical.

---

## 11. Diff review (security regression scan) — no new issue found

| Category | Finding |
|---|---|
| Auth architecture | **None.** `auth.ts` hunks touch only the import line and the body of `authorize`. No hunk touches `session:`, `strategy`, `callbacks`, `jwt`, `signIn`, `redirect`, `adapter`, `Google(`, `providers:` or `pages:`. |
| Session behaviour / cookies | **None** — no change to session, JWT, or cookie configuration. |
| Authorization / tenant isolation / CSRF | **None** — no file under `lib/authz`, `lib/csrf.ts`, `proxy.ts` or middleware appears in the diff. |
| Payment / refund / settlement | **None** — no such file appears in the diff. |
| Dashboard routing | **None** by this remediation (the PIC dashboard files in the tree are the pre-existing work, fingerprints unchanged). |
| DB schema/migrations | **None.** |
| Secrets introduced | **None.** The only key-shaped addition is `LOGIN_ACCOUNT_KEY_SECRET`, which is a `randomBytes(32)` value generated at process start (a documented per-process HMAC key), not a stored secret. No credential literal anywhere in the diff. |
| Logging of credentials/identifiers | **None.** Only two `console.warn` calls were added: the invalid-`TRUSTED_PROXY` warning (bounded config value only) and the platform-wide flood warning (counts only, once per 60 s). |
| New enumeration surface | **None** — HMAC-keyed, existence-independent accounting; no new message or code. |
| New rate-limit bypass | **None on the login path.** One deliberate behavioral consequence on the registration path when `TRUSTED_PROXY` is unset — reported in §5.7, not hidden. |
| Trust of arbitrary forwarded headers | **Fixed** — headers read only after an explicit allow-list parse, and only if the value is a real IP. |
| Hard refusal on attacker-controlled account/global keys | **None** — refusals exist only for the per-client key when it names a trustworthy client. |
| Unbounded memory growth | **Fixed** — 50 000-window cap, O(1) eviction, `has()` guard; no sweep in the hot path. |
| Duplicate / success-path charging | **None** — 4 charges, one helper, none after the success `return`. |

Residual risk carried into the findings list: the registration-path limitation in §5.7 (requires `TRUSTED_PROXY`), and the deferred dependency advisory (§3).

---

## 12. Remaining security findings — all deferred, none implemented

| ID | Severity | Status | Notes |
|---|---|---|---|
| **F-01 residual** | high (tooling-only) | **DEFERRED** | `deepmerge-ts <8` via `prisma → @prisma/config`; parent pins `7.1.5` exactly; advisory covers all `<8.0.0`; not on the request path. Fix belongs with an upstream Prisma move or a deliberate, tested major override. |
| **F-04** | P2 | **DEFERRED** | Settlement SoD compares the actor only to `preparedByUserId`; the same operator can approve and then mark a settlement paid. No settlement/refund/payment file was touched. |
| **F-05** | P3 | **DEFERRED** | In-memory, per-process limiter; safe because `ecosystem.config.cjs` pins `instances: 1`. Partially mitigated now: the store is hard-capped. `REDIS_URL` remains inert (warns only). |
| **F-06** | P3 | **DEFERRED** | No persistent login-failure audit row (still `console.warn`). The new counters make this more valuable, but it is a new feature, not part of F-01/F-02/F-03. |
| **F-07** | P3 | **DEFERRED** | `AdminAuditLog` remains write-only — no viewer/API despite the `audit_log.read` permission existing. |
| **F-08** | P3 | **DEFERRED** | Dead `requireSession` / `requireAdminSession` in `lib/csrf.ts` (legacy `session.user.role` gate); removing them is unrelated cleanup. |
| **F-09** | P3 | **DEFERRED** | Session `maxAge` is still the framework default; authorization is re-resolved per request from the DB, which bounds the impact. |
| Registration rate limit without a configured proxy | P3 | **REPORTED, DEFERRED** | See §5.7 — a consequence of the F-03 fix rather than a new vulnerability; the remedy is `TRUSTED_PROXY` (documented) or a future generous global cap. |

---

## 13. Final conclusion

- **F-01: PASS for the actionable advisories.** The critical `next` advisories and the `sharp` and `nanoid` advisories are resolved by the smallest compatible upgrade (Next 16.3.6, sharp 0.35.5, nanoid 3.3.19, eslint-config-next 16.3.6) with **0 packages added or removed**, Prisma untouched on its existing 6.x line, and no unrelated framework migration.
- **The Prisma/`deepmerge-ts` advisory is explicitly deferred**, with the reason recorded: the chain pins `deepmerge-ts 7.1.5` exactly, the advisory covers all `<8.0.0`, and the recommended `--force` action is a Prisma downgrade.
- **F-02: PASS.** Proxy trust is granted only by an explicit, well-formed IP/CIDR configuration; every truthy-but-invalid value and every malformed member fails closed; spoofed or non-IP forwarded values cannot become bucket keys; warning behaviour is intentional and non-repeating.
- **F-03: PASS.** No shared sentinel bucket can refuse a sign-in; the per-client refusal applies only to a trustworthy client key; per-account and platform-wide protections are bounded delays that can lock out neither an account nor the platform; memory is capped; accounting is enumeration-resistant and charges exactly once per real failure, never on success or on malformed input; registration received the same root-cause fix.
- **No unrelated security finding was implemented**; F-04…F-09 and the two residuals are documented as deferred.
- **No destructive Git operation occurred:** no commit, push, reset, rebase, stash, stage, revert or file normalization. The pre-existing PIC-dashboard/realtime work is byte-identical, and the F-01/F-02/F-03 remediation remains in the working tree.
