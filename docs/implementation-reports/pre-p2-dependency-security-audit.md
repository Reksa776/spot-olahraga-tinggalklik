# Pre-P2 Readiness — Dependency Security Audit

- **Date:** 2026-11-06
- **Project:** TinggalKlik.co (`toko@0.1.0`)
- **Mode:** Read-only audit
- **Runtime used for inspection:** Node `v24.21.0`, npm `10.9.9`, lockfileVersion `3`
- **Scope:** `package.json`, `package-lock.json`, installed dependency tree, npm advisory data, and the application code paths that could reach vulnerable packages.

> **Read-only attestation:** No package manifest, lockfile, application source, test, environment file, or production system was modified. No `npm audit fix`, install, uninstall, upgrade, or downgrade was run. The only file created is this report.

---

## 1. Executive summary

`npm audit` reports **26 vulnerable package entries**:

| Severity | Package entries |
|---|---:|
| Critical | 0 |
| High | 7 |
| Moderate | 15 |
| Low | 4 |
| **Total** | **26** |

Those 26 package entries represent **19 unique advisories**, because `nodemailer` alone carries 15 advisories and several packages are flagged transitively through the same root issue.

`npm audit --omit=dev` reports **7 high, 0 moderate, 0 low**. In other words, every high-severity package entry is in the production dependency tree; the 19 moderate/low findings are development-only (Jest, ESLint, and the `ts-jest` toolchain).

That headline is worse than the actual application exposure:

- **`nodemailer` is declared but never imported.** A repository-wide search finds only a commented `createTransport` example in `lib/notifications/transports/smtp.ts`. The SMTP adapter itself is a fail-closed Phase 1 stub: `createSmtpEmailTransport()` throws `Phase1TransportRefusedError`. The worker only instantiates dry-run transports, and `lib/notifications/config.ts` downgrades a requested `smtp` transport to `dry-run`.
- **The auth configuration has no email provider.** `auth.ts` uses `PrismaAdapter` with Google and Credentials providers. The `nodemailer`-specific path in `@auth/core` is not configured. The auth packages are used, but the vulnerable email/nodemailer code path is not invoked.
- **The Prisma high findings are CLI/config findings, not query-path findings.** `prisma` and `@prisma/config` load configuration through `deepmerge-ts`. The runtime query client is `@prisma/client@6.19.3`, which is not itself flagged. The affected code runs in the Prisma CLI during deploy/config work, not in an HTTP request.
- **All Jest/ESLint findings are development-only.** They are not in the production runtime and no application path passes untrusted input to `glob`, `minimatch`, or `deepmerge`.

**Conclusion:** No currently reachable, remotely exploitable high-severity path was found in the P1/P7 production surface. P2 is **not blocked** by this audit. The highest-value cleanup is to remove the unused `nodemailer` dependency; the Prisma 7 upgrade is a separate major change. Do not activate SMTP or add an Auth.js Email provider until the mailer issue is resolved.

---

## 2. Audit basis and commands

Read-only commands used:

```text
npm audit --json
npm audit --omit=dev --json
npm ls --all --json
npm ls --depth=0
npm view <package> version|versions|dependencies|peerDependencies|engines|dist-tags
rg / code search over application source
sha256sum package.json package-lock.json
```

`npm audit` exits `1` when vulnerabilities are present; that is expected for this report. Its metadata was:

```json
{
  "vulnerabilities": {
    "info": 0,
    "low": 4,
    "moderate": 15,
    "high": 7,
    "critical": 0,
    "total": 26
  },
  "dependencies": {
    "prod": 291,
    "dev": 599,
    "optional": 114,
    "peer": 0,
    "peerOptional": 0,
    "total": 951
  }
}
```

The dependency counts overlap by category; they are npm's classification counts, not a partition of the 951 total.

### Package entries vs. unique advisories

| Measure | Count |
|---|---:|
| Vulnerable package entries (npm audit rows) | 26 |
| Unique advisory IDs | 19 |
| Unique advisory severity: high | 4 |
| Unique advisory severity: moderate | 14 |
| Unique advisory severity: low | 1 |
| Unique advisory severity: critical | 0 |

The package-level counts are higher because one advisory propagates to multiple packages. For example, the `deepmerge-ts` advisory makes `prisma`, `@prisma/config`, and `deepmerge-ts` all appear as high.

---

## 3. Full vulnerability inventory

### 3.1 Production tree — 7 high

These are the packages included by `npm audit --omit=dev`. "Production" here means the package is declared under `dependencies` and is present in the production install tree; it does **not** automatically mean the vulnerable code is reachable from the application.

| # | Package | Installed | Severity | Direct / transitive | Dependency path | Patched version / audit fix | Current use in TinggalKlik |
|---:|---|---:|---|---|---|---|---|
| 1 | `@auth/core` | `0.41.3` | High | Transitive, prod | `next-auth → @auth/core`; also `@auth/prisma-adapter → @auth/core` | No standalone patch; `0.41.3` is latest. `fixAvailable: false`. The underlying issue is `nodemailer`; a compatible auth stack would need `nodemailer >=10.1.4`, which the current peer range excludes. | Auth.js core is used for Google/Credentials sessions, but no Email provider is configured and no nodemailer code is imported. |
| 2 | `@auth/prisma-adapter` | `2.11.3` | High | **Direct**, prod | root → `@auth/prisma-adapter` → `@auth/core` | No standalone patch; `2.11.3` is latest. Same nodemailer constraint. | `PrismaAdapter` is used in `auth.ts`; only the optional email/nodemailer path is vulnerable and that path is not configured. |
| 3 | `@prisma/config` | `6.19.3` | High | Transitive, prod | `prisma → @prisma/config` | `7.10.1` (bundled with Prisma 7.10.1). `fixAvailable` requires Prisma 7.10.1, a semver-major upgrade. | Prisma CLI configuration loading, not `@prisma/client` query execution. |
| 4 | `deepmerge-ts` | `7.1.5` | High | Transitive, prod | `prisma → @prisma/config → deepmerge-ts` | `8.0.0`; Prisma `7.10.1` bundles `8.0.2`. `@prisma/config@6.19.3` pins `7.1.5`. | Only used by the Prisma CLI's config loader. No request handler passes user data into it. |
| 5 | `next-auth` | `5.0.0-beta.32` | High | **Direct**, prod | root → `next-auth` → `@auth/core`; optional peer `nodemailer` | No compatible patched release; `5.0.0-beta.32` is the latest beta. `npm audit` proposes `1.12.1` as a major "fix", which is an incompatible downgrade. | Auth runtime is used, but only Google/Credentials providers are configured. The vulnerable path is the optional email/nodemailer integration. |
| 6 | `nodemailer` | `8.0.11` | High | **Direct**, prod | root → `nodemailer`; also optional peer of `next-auth` and `@auth/core` | `>=10.1.4`; latest is `10.3.1`. `fixAvailable: false` because `next-auth@5.0.0-beta.32` / `@auth/core@0.41.3` declare `nodemailer: ^7.0.7 || ^8.0.5`. | **Not imported anywhere.** The SMTP adapter is a throwing Phase 1 stub; the worker uses dry-run transports only. |
| 7 | `prisma` | `6.19.3` | High | **Direct**, prod | root → `prisma` → `@prisma/config` → `deepmerge-ts` | `7.10.1` (semver-major). Do **not** use the `latest` dist-tag: at audit time `prisma@latest` resolves to `8.0.0-rc.30`, a release candidate. | Prisma CLI/deploy path (for example `npx prisma migrate deploy`), not the application query runtime. |

### 3.2 Development tree — 19 low/moderate

These packages are devDependencies or are only reachable through them. They are not part of a production install made with `npm ci --omit=dev`.

| # | Package | Installed | Severity | Direct / transitive | Dependency path | Patched version / audit fix | Current use |
|---:|---|---:|---|---|---|---|---|
| 8 | `@jest/core` | `30.4.2` | Moderate | Transitive, dev | `jest → @jest/core`; also `jest → jest-cli → @jest/core` | No verified forward fix. Latest `30.5.2`; top-level `jest` audit fix is a downgrade to `25.1.0`. | Jest test runner. |
| 9 | `@jest/reporters` | `30.4.1` | Moderate | Transitive, dev | `jest → @jest/core → @jest/reporters` | Latest `30.5.2` still depends on `glob ^13.0.6`, inside the affected range. | Jest reporting. |
| 10 | `@typescript-eslint/eslint-plugin` | `8.66.0` | Moderate | Transitive, dev | `eslint-config-next → typescript-eslint → @typescript-eslint/eslint-plugin` | No compatible fix; latest `typescript-eslint@8.72.1` still resolves `minimatch ^10.2.2`. | Lint rules. |
| 11 | `@typescript-eslint/parser` | `8.66.0` | Moderate | Transitive, dev | same chain as above | No compatible fix; same `minimatch` constraint. | Lint parser. |
| 12 | `@typescript-eslint/type-utils` | `8.66.0` | Moderate | Transitive, dev | `... -> @typescript-eslint/eslint-plugin -> @typescript-eslint/type-utils` | No compatible fix. | Lint utilities. |
| 13 | `@typescript-eslint/typescript-estree` | `8.66.0` | Moderate | Transitive, dev | `... -> typescript-eslint -> @typescript-eslint/typescript-estree` | No compatible fix; latest `8.72.1` still depends `minimatch ^10.2.2`. | Lint AST/glob matching. |
| 14 | `@typescript-eslint/utils` | `8.66.0` | Moderate | Transitive, dev | `... -> typescript-eslint -> @typescript-eslint/utils` | No compatible fix. | Lint utilities. |
| 15 | `deepmerge` | `4.3.1` | Low | Transitive, dev | `jest → @jest/core → jest-config → deepmerge`; also `jest → jest-cli → jest-config → deepmerge` | **No patched release exists**: latest is `4.3.1`, which is inside `>=4.2.0 <=4.3.1`. | Jest config merging. |
| 16 | `eslint-config-next` | `16.4.3` | Moderate | **Direct**, dev | root → `eslint-config-next` → `typescript-eslint` | No security fix; latest `16.4.5` still depends `typescript-eslint ^8.56.0`. Updating is routine maintenance, not remediation. | Next.js ESLint config. |
| 17 | `glob` | `10.5.0` | Moderate | Transitive, dev | `jest → @jest/core → @jest/reporters → glob`; also Jest config/runtime paths | Fixed in `14.0.2+` (latest `14.0.4`), but Jest 30.5.2 depends `glob ^13.0.6`, so a force-upgrade is major and unsupported. | Jest file discovery. The separate `glob@7.2.3` under `ts-jest` is not affected by this advisory. |
| 18 | `jest` | `30.4.2` | Low | **Direct**, dev | root → `jest` → `@jest/core` / `jest-cli` | No verified forward fix; latest `30.5.2` still affected. Audit suggests `25.1.0`, an incompatible downgrade. | Test runner. |
| 19 | `jest-circus` | `30.4.2` | Moderate | Transitive, dev | `jest → @jest/core → jest-config → jest-circus` | No verified forward fix; bundled with Jest 30.x. | Jest test runner internals. |
| 20 | `jest-cli` | `30.4.2` | Low | Transitive, dev | `jest → jest-cli` | No verified forward fix. | Jest CLI. |
| 21 | `jest-config` | `30.4.2` | Moderate | Transitive, dev | `jest → @jest/core → jest-config`; also `jest → jest-cli → jest-config` | No verified forward fix; latest `30.5.2` still uses affected `glob`/`deepmerge`. | Jest configuration. |
| 22 | `jest-runner` | `30.4.2` | Moderate | Transitive, dev | `jest → @jest/core → jest-runner`; config chain also reaches it | No verified forward fix. | Jest runner. |
| 23 | `jest-runtime` | `30.4.2` | Moderate | Transitive, dev | `jest → @jest/core → jest-runtime`; runner/config chains also reach it | No verified forward fix. | Jest runtime. |
| 24 | `minimatch` | `10.2.6` and `9.0.9` | Moderate | Transitive, dev | `eslint-config-next → typescript-eslint → @typescript-eslint/typescript-estree → minimatch` (`10.2.6`); `jest → ... → glob → minimatch` (`9.0.9`) | Fixed in `11.0.1+` (latest `11.0.5`), but consumers require `^10.2.2` / `^9.0.4`; no compatible fix without a major override. | Lint and Jest glob matching. The `minimatch@3.1.5` copies under ESLint/ts-jest are not in the affected range. |
| 25 | `ts-jest` | `29.4.12` | Low | **Direct**, dev | root → `ts-jest`; peer of `jest` 30 | No fix; latest `29.4.15` still has the same Jest peer exposure. Audit suggests `25.5.1`, an incompatible downgrade. | TypeScript transform for Jest. |
| 26 | `typescript-eslint` | `8.66.0` | Moderate | Transitive, dev | `eslint-config-next → typescript-eslint` | No fix; latest `8.72.1` still depends `minimatch ^10.2.2`. | ESLint TypeScript integration. |

### 3.3 Direct vs. transitive — summary

**Direct (7):**

| Environment | Packages |
|---|---|
| Production | `@auth/prisma-adapter@2.11.3`, `next-auth@5.0.0-beta.32`, `nodemailer@8.0.11`, `prisma@6.19.3` |
| Development | `eslint-config-next@16.4.3`, `jest@30.4.2`, `ts-jest@29.4.12` |

**Transitive (19):**

| Environment | Packages |
|---|---|
| Production | `@auth/core@0.41.3`, `@prisma/config@6.19.3`, `deepmerge-ts@7.1.5` |
| Development | `@jest/core@30.4.2`, `@jest/reporters@30.4.1`, `@typescript-eslint/eslint-plugin@8.66.0`, `@typescript-eslint/parser@8.66.0`, `@typescript-eslint/type-utils@8.66.0`, `@typescript-eslint/typescript-estree@8.66.0`, `@typescript-eslint/utils@8.66.0`, `deepmerge@4.3.1`, `glob@10.5.0`, `jest-circus@30.4.2`, `jest-cli@30.4.2`, `jest-config@30.4.2`, `jest-runner@30.4.2`, `jest-runtime@30.4.2`, `minimatch@10.2.6`/`9.0.9`, `typescript-eslint@8.66.0` |

### 3.4 Root advisories and propagation

Five root issues explain all 26 rows:

| Root issue | Direct package | Propagates to |
|---|---|---|
| `nodemailer` advisory set (15 advisories) | `nodemailer@8.0.11` | `@auth/core`, `@auth/prisma-adapter`, `next-auth` |
| `deepmerge-ts` stack exhaustion | `deepmerge-ts@7.1.5` | `@prisma/config`, `prisma` |
| `glob` AbortSignal bypass | `glob@10.5.0` | `@jest/core`, `@jest/reporters`, `jest`, `jest-config`, `jest-runtime`, etc. |
| `minimatch` globparts amplification | `minimatch@10.2.6`/`9.0.9` | `@typescript-eslint/*`, `typescript-eslint`, `glob` |
| `deepmerge` prototype poisoning | `deepmerge@4.3.1` | `jest-config`, `jest` |

---

## 4. Full advisory detail (19 unique advisories)

The GHSA identifiers below resolve at `https://github.com/advisories/<GHSA-ID>`.

### 4.1 Auth / nodemailer chain

`nodemailer@8.0.11` is affected by all 15 advisories. The **minimum version that clears every one of them is `10.1.4`**; latest is `10.3.1`.

| Advisory | Severity | Affected range | Patched | Issue |
|---|---|---|---|---|
| `GHSA-p6gq-j5cr-w38f` | High | `<=9.0.0` | `9.0.1` (stack-safe: `10.1.4`) | Message-level `raw` option bypasses `disableFileAccess`/`disableUrlAccess`, enabling arbitrary file read and full-response SSRF. |
| `GHSA-8m3c-c648-2xjj` | Moderate | `<=9.1.0` | `9.1.1` (stack-safe: `10.1.4`) | `resolveContent()` on a `MailMessage` bypasses the file/URL access flags with the legacy signature. |
| `GHSA-wmmp-3585-3rmp` | Moderate | `<9.1.0` | `9.1.0` | IDN/Punycode domain allow-list bypass can deliver to an attacker-controlled domain. |
| `GHSA-2x7j-588g-ccc2` | High | `<9.1.0` | `9.1.0` | Quadratic addressparser complexity allows remote denial of service via a crafted address list. |
| `GHSA-cc9r-2j5m-2m83` | Moderate | `>=6.9.16 <9.1.0` | `9.1.0` | RFC 5322 comment mis-parsing bypasses recipient-domain validation. |
| `GHSA-6vj9-mwq6-2f5v` | Moderate | `>=5.0.0 <10.0.2` | `10.0.2` | Process-global DNS cache reuses TLS `servername`, enabling cross-tenant SMTP credential disclosure. |
| `GHSA-8vvx-rff5-p5rq` | Moderate | `<10.0.2` | `10.0.2` | Nested structured recipient arrays bypass the parser depth limit and cause stack exhaustion. |
| `GHSA-v53p-9fqp-m79j` | High | `<=10.0.5` | `10.0.6` | Quadratic backtracking in the addressparser free-text fallback allows remote denial of service. |
| `GHSA-39m8-27wv-hr27` | Moderate | `>=3.0.0 <=10.0.9` | `10.0.10` | Quadratic DKIM header unfolding causes denial of service during signing. |
| `GHSA-8c8m-p3m8-cjg8` | Moderate | `>=3.0.0 <10.1.4` | `10.1.4` | A nested comment ends early, releasing the rest of the comment as a recipient. |
| `GHSA-m943-m63m-w62w` | Moderate | `>=3.0.0 <10.1.4` | `10.1.4` | A `;` inside a quoted string/comment ends an address group early, turning display text into a recipient. |
| `GHSA-85x2-q946-cp5h` | Moderate | `>=3.0.0 <10.1.4` | `10.1.4` | A `>` inside a quoted local part ends an angle-addr early, delivering to a domain the header does not name. |
| `GHSA-4ffr-jq9g-5ffx` | Moderate | `>=3.0.0 <=10.0.12` | `10.0.13` | Quadratic backtracking in SMTP AUTH mechanism detection allows pre-auth denial of service. |
| `GHSA-g73g-hqqh-jr95` | Moderate | `>=3.0.0 <=10.0.12` | `10.0.13` | RFC 5322 comment inside an angle-bracket address is never stripped. |
| `GHSA-4g23-2xm8-66gc` | Moderate | `>=3.0.0 <=10.0.9` | `10.0.10` | Quadratic SMTP client reply parsing lets a malicious server or MITM cause pre-auth denial of service. |

### 4.2 Prisma CLI

| Advisory | Severity | Affected range | Patched | Issue |
|---|---|---|---|---|
| `GHSA-ggr8-5vv4-36mx` | High | `<8.0.0` | `8.0.0` | `deepmerge-ts` stack exhaustion when merging recursive object graphs. Prisma 7.10.1 bundles `deepmerge-ts@8.0.2`. |

### 4.3 Jest / lint tooling

| Advisory | Severity | Affected range | Patched | Issue |
|---|---|---|---|---|
| `GHSA-3g3m-2fjr-6pw4` | Moderate | `>=9.0.0 <=14.0.1` | `14.0.2` | `glob` AbortSignal cancellation bypass allows post-timeout filesystem traversal. |
| `GHSA-g3hv-75wg-m249` | Moderate | `>=7.0.0 <11.0.1` | `11.0.1` | `minimatch` potential denial of service via globparts amplification. |
| `GHSA-gcqx-w48m-w2h4` | Low | `>=4.2.0 <=4.3.1` | **No patched release** | `deepmerge` `mergeObject()` allows prototype poisoning of returned objects. Latest `4.3.1` remains affected. |

---

## 5. Direct and transitive classification

### 5.1 Direct dependencies

| Package | Environment | Vulnerable? | Why it matters |
|---|---|---|---|
| `@auth/prisma-adapter@2.11.3` | Production | High, via `@auth/core` → `nodemailer` | Used by `auth.ts`, but the vulnerable module is the optional email path, not the adapter's database methods. |
| `next-auth@5.0.0-beta.32` | Production | High, via `@auth/core`/`nodemailer` | Auth runtime is used; no Email provider is configured. |
| `nodemailer@8.0.11` | Production | High | Declared direct dependency, zero application imports. |
| `prisma@6.19.3` | Production | High, via `@prisma/config` → `deepmerge-ts` | CLI/deploy tool, not request runtime. |
| `eslint-config-next@16.4.3` | Development | Moderate, via `typescript-eslint` → `minimatch` | Lint only. |
| `jest@30.4.2` | Development | Low, via Jest internals → `glob`/`deepmerge` | Test only. |
| `ts-jest@29.4.12` | Development | Low, via `jest` | Test transform only. |

### 5.2 Transitive dependencies

The 19 transitive entries are listed in §3.2. Only three are production:

- `@auth/core@0.41.3` — auth runtime, vulnerable only through optional `nodemailer`.
- `@prisma/config@6.19.3` — Prisma CLI config loader.
- `deepmerge-ts@7.1.5` — Prisma CLI config merge.

The remaining 16 are Jest/ESLint/TypeScript-ESLint tooling and are absent from a production install.

---

## 6. Production exposure analysis

### 6.1 Auth and nodemailer — high nominal severity, no current reachable path

Evidence from the repository:

- `auth.ts` configures:
  - `PrismaAdapter(prisma)`;
  - `Google(...)`;
  - `Credentials(...)`;
  - JWT sessions.
- `auth.ts` has **no** `EmailProvider` and no email sign-in flow.
- A repository-wide search finds **no import of `nodemailer`** or `createTransport()`. The only match is the commented example in `lib/notifications/transports/smtp.ts`.
- `lib/notifications/transports/smtp.ts` contains only a type import from `../types`; `createSmtpEmailTransport()` always throws `Phase1TransportRefusedError` with code `PHASE_1_TRANSPORT_REFUSED`.
- `lib/notifications/config.ts` records a requested `EMAIL_TRANSPORT=smtp` as a refusal and forces the effective transport to `dry-run`.
- `lib/notifications/worker.ts` defaults to `createDryRunEmailTransport()` and explicitly refuses to run with a live `kind: "smtp"` transport.
- The outbound email contract is plain text only: `{ to, subject, text }`; there is no `raw`, attachment, HTML, DKIM, or custom header field.

Therefore the 15 nodemailer advisories are **not reachable through the configured auth providers or the Phase 1 worker**. The four high package entries in this chain (`nodemailer`, `@auth/core`, `@auth/prisma-adapter`, `next-auth`) are a packaging exposure, not a currently exploitable request path.

This would change immediately if someone:

1. adds an Auth.js `EmailProvider` (which loads the optional nodemailer integration), or
2. replaces the throwing SMTP stub with a working nodemailer transport.

The existing SMTP design notes already require `disableFileAccess`, `disableUrlAccess`, no `raw`, no attachments, fixed `from`, and a queue-row recipient. Those controls address several advisories, but they do not remove the dependency risk or the addressparser/SMTP denial-of-service advisories.

### 6.2 Prisma — high nominal severity, CLI/deploy exposure

- `@prisma/client@6.19.3` is the runtime query client and is **not** flagged.
- The flagged chain is `prisma → @prisma/config → deepmerge-ts`.
- `@prisma/config` is used while the Prisma CLI loads configuration (for example `npx prisma migrate deploy`). It is not on the HTTP request path and does not parse user-supplied JSON.
- The `deepmerge-ts` advisory requires merging a recursive object graph. The input here is operator-controlled Prisma configuration, not a buyer/scanner payload.
- Actual risk is therefore low, but the package is correctly classified as production because `prisma` is in `dependencies` and the deploy path uses it.

### 6.3 Jest / ESLint / ts-jest — development-only

- The 19 moderate/low entries are all in the development toolchain.
- A production install using `npm ci --omit=dev` excludes them.
- No application request path calls `glob`, `minimatch`, or `deepmerge` with user input.
- The practical exposure is to a developer/CI machine running tests or lint against untrusted repository content, not to a TinggalKlik visitor or buyer.
- `jest-config`/`deepmerge` and `glob`/`minimatch` advisories are still real supply-chain hygiene issues, but they are not P2 blockers.

### 6.4 Exposure ranking

| Rank | Issue | Nominal severity | Actual current exposure | Reason |
|---:|---|---|---|---|
| 1 | Unused `nodemailer` + auth transitive chain | High (4 package entries) | **None found today**, but high if email is activated | No import, no EmailProvider, SMTP stub refuses, worker dry-run only. |
| 2 | Prisma CLI `deepmerge-ts` | High (3 package entries) | **Low** | CLI config only; no untrusted request data. |
| 3 | Jest `glob`/`deepmerge` chain | Low/moderate (many entries) | **Low** | Dev/CI only; no production install. |
| 4 | ESLint `minimatch` chain | Moderate (many entries) | **Low** | Lint only; developer-controlled paths. |
| 5 | Auth beta maintenance risk | High nominal | **Low now**, medium long-term | `next-auth` 5 beta and `@auth/core` have no newer compatible release; monitor upstream. |

---

## 7. Safe remediation recommendations

### 7.1 First: remove the unused nodemailer dependency

**Recommended, lowest-risk production cleanup.**

Evidence supporting removal:

- no `import`/`require`/dynamic import of `nodemailer`;
- SMTP adapter is a throwing stub;
- config resolver cannot select SMTP;
- worker refuses live SMTP and defaults to dry-run;
- no Auth.js Email provider.

Proposed change, **not applied**:

```text
# Proposed only — do not run as part of this read-only audit.
npm uninstall nodemailer @types/nodemailer
npm audit --omit=dev
```

Expected effect: the four high entries in the auth/nodemailer chain (`nodemailer`, `@auth/core`, `@auth/prisma-adapter`, `next-auth`) should disappear, leaving the three Prisma-chain high entries. Re-run the audit to confirm rather than relying on this prediction.

Trade-off: this blocks future SMTP/email sign-in until a maintained mailer is reintroduced. That is acceptable for Phase 1 because email is explicitly inactive. If P2 needs email, treat email activation as a separate project and choose a supported mailer/auth combination *before* removing the package.

Do **not** simply install `nodemailer@10.3.1` under the current auth stack. It is the patched version, but `next-auth@5.0.0-beta.32` and `@auth/core@0.41.3` declare a peer range of `^7.0.7 || ^8.0.5`. An `overrides` entry would install an unsupported combination and would require a full auth/email regression suite.

### 7.2 Second: upgrade Prisma in an isolated change

**Recommended after the nodemailer cleanup, as a separate major upgrade.**

- Upgrade both `prisma` and `@prisma/client` to **`7.10.1`**, not `latest` (the `latest` tag currently points to `8.0.0-rc.30`).
- Prisma 7.10.1 bundles `@prisma/config@7.10.1` and `deepmerge-ts@8.0.2`, clearing the three Prisma-chain highs.
- Node engine requirement: `^20.19 || ^22.12 || >=24.0`. The inspected runtime is `v24.21.0`, so it qualifies; a deployment on Node 20.9–20.18 would not.
- Regenerate the Prisma client and run the full integration suite, not only a build.
- Review Prisma 7's client/generator/config changes before merging. This is a semver-major upgrade, not a patch.

Proposed command, **not applied**:

```text
# Proposed only — do not run as part of this read-only audit.
npm install prisma@7.10.1 @prisma/client@7.10.1
npx prisma generate
```

### 7.3 If email is activated: use a supported combination

- `nodemailer >=10.1.4` clears all 15 mailer advisories; latest is `10.3.1`.
- The current Auth.js beta does not accept that major version.
- Options, in order of safety:
  1. Wait for a `next-auth`/`@auth/core` release whose peer range accepts nodemailer 10.x, then upgrade the auth stack and mailer together.
  2. Isolate the mailer from Auth.js and call it from the notification worker only, with the Phase 1 plain-text contract and the documented `disableFileAccess`/`disableUrlAccess` controls.
  3. Do **not** use `overrides` to force nodemailer 10 under the current auth peer range unless the full Google/Credentials/email flows are tested; the peer range is a compatibility statement, not a suggestion.
- If email remains inactive, removing nodemailer is safer than keeping a vulnerable unused parser on the install image.

### 7.4 Development tooling: wait for upstream, do not downgrade

- `jest@30.5.2` (latest) still resolves `glob ^13.0.6`, which is inside the affected range; `deepmerge@4.3.1` has no patched release.
- `typescript-eslint@8.72.1` (latest) still depends on `minimatch ^10.2.2`; the patched minimatch is `11.0.1+`.
- `eslint-config-next@16.4.5` (latest) still brings `typescript-eslint ^8.56.0`; it is not a security fix.
- `npm audit`'s suggested "fixes" for these packages are downgrades (`jest@25.1.0`, `eslint-config-next@15.5.29`, `ts-jest@25.5.1`) that are incompatible with the installed Jest 30/Next 16/TypeScript setup. Do not apply them.
- Safe action now: none required for P2. Schedule a toolchain refresh when upstream releases a compatible patched `glob`/`minimatch`/`jest`/`typescript-eslint` combination; re-run lint and test suites at that point.
- A `glob` 14 or `minimatch` 11 override is technically possible but major; it can break Jest file discovery or ESLint path matching. Treat it as an engineering change, not a security patch.

### 7.5 Add a production-only audit gate

After the nodemailer cleanup, add a CI check along the lines of:

```text
npm audit --omit=dev --audit-level=high
```

This keeps development-tool noise out of the gate and ensures a new production high blocks the build. If Prisma 7 is not yet upgraded, record its three remaining entries as an explicit, time-bounded exception rather than suppressing the whole check.

---

## 8. Breaking-change risks

| Change | Risk | Why / mitigation |
|---|---|---|
| Remove `nodemailer` + `@types/nodemailer` | **Low current risk**, medium product risk | No code imports it. Future SMTP/email sign-in would need a supported mailer. Do it only if P2 does not require email; otherwise plan email activation first. |
| `nodemailer` 8 → 10.3.1 | **High** | Major version plus peer conflict with `next-auth@5.0.0-beta.32` / `@auth/core@0.41.3`. Unsupported without auth regression tests. |
| Prisma 6.19.3 → 7.10.1 | **High** | Semver-major CLI/client change; requires client regeneration, config review, migration/test pass, and Node >=20.19. Current Node 24.21 qualifies. |
| Next-auth 5 beta → another major | **High** | Auth route, providers, session/JWT callbacks, and adapter behavior can change. No compatible patched beta exists. |
| Force `@auth/core` / adapter override | **High** | Unsupported package combination; can break auth flows and is not a guaranteed fix. |
| Force `glob` 14 under Jest 30 | **High** | Jest declares `glob ^13.0.6`; major override can break test discovery/reporting. |
| Force `minimatch` 11 under ESLint | **High** | `typescript-eslint` declares `^10.2.2`; major override can break lint path matching. |
| Apply `npm audit fix` broadly | **High** | It proposes downgrades to Jest 25, eslint-config-next 15, and ts-jest 25, which are incompatible with the current majors. |
| Update `eslint-config-next` 16.4.3 → 16.4.5 | **Low** | Routine patch, but it does **not** fix the `minimatch` advisory. |
| Update `jest` 30.4.2 → 30.5.2 | **Low/medium** | Bugfix release, but still affected by `glob`/`deepmerge`; not a security remediation. |
| Remove `prisma` from production dependencies | **Medium** | The deploy path uses the CLI (`npx prisma migrate deploy`). Moving it to devDependencies can break production deployment unless the deploy image installs dev dependencies or uses a separate migration image. |

---

## 9. Recommended remediation order

| Order | Action | Expected result | Effort / risk |
|---:|---|---|---|
| 1 | Remove unused `nodemailer` and `@types/nodemailer`; re-run `npm audit --omit=dev` | Expected to clear 4 of 7 production highs; confirms whether the auth packages drop out of the audit | Low effort; low current risk. Verify no email/SMTP feature is planned for P2. |
| 2 | Upgrade `prisma` and `@prisma/client` to `7.10.1` in a separate branch | Clears `prisma`, `@prisma/config`, and `deepmerge-ts` highs | High effort; semver-major. Regenerate and run the full suite. |
| 3 | Re-audit the auth/email decision | If email is inactive, no action. If email is planned, choose a patched nodemailer plus a compatible auth release or isolated mailer | Medium/high effort; do not use overrides without auth tests. |
| 4 | Leave Jest/ESLint findings for an upstream toolchain refresh | No production exposure; keep them visible in the backlog | Low urgency; no safe forward fix today. Do not apply suggested downgrades. |
| 5 | Add `npm audit --omit=dev` to CI with documented exceptions | Prevents a new production high from slipping in | Low effort. |

**P2 decision:** none of the current high findings is reachable from the P1/P7 production path, so P2 can proceed. The only condition is that P2 must not activate SMTP or add an Auth.js Email provider while `nodemailer@8` remains installed. If P2 includes email, remediation item 3 becomes a prerequisite, not a follow-up.

---

## 10. Limitations

- `npm audit` is a point-in-time registry advisory match; it does not prove exploitability.
- No exploit was attempted and no dynamic analysis was run.
- No production system, database, credential, or environment variable was accessed.
- The audit cannot detect a vulnerable code path introduced by a future change (for example, adding an Email provider or replacing the SMTP stub).
- The package-level count is not the number of unique advisories; §2 explains the difference.
- `npm ls` reported some extraneous optional WASM packages (`@emnapi/*`, `@img/sharp-wasm32`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util`). They are not part of the audit findings and were not changed.

---

## 11. Read-only confirmation

- **No** `npm audit fix` was run.
- **No** package was installed, uninstalled, upgraded, or downgraded.
- **No** change was made to `package.json`, `package-lock.json`, application source, tests, environment files, or production systems.
- **No** commit or push was made.
- `package.json` and `package-lock.json` SHA-256 hashes were captured before and after the audit and are unchanged.
- The only file created by this task is `docs/implementation-reports/pre-p2-dependency-security-audit.md`.

**Stop point:** this report is complete. P2 was not started.
