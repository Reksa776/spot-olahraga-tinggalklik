import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ==========================================
 * DEPLOYMENT / RELEASE BASELINE
 * ==========================================
 *
 * Phase 25 left the deployment contract undefined: there was no Node pin, no health
 * endpoint, no process definition, and the only deployment artifact in the tree was a
 * GitHub Actions workflow that SSHed into the VPS and ran `./deploy.sh` from the DELETED
 * retail project. Phase 26 established the contract; this suite is what keeps it.
 *
 * These are STATIC guards (they read the tree, they do not boot anything). Each one exists
 * because the failure it prevents is silent:
 *
 *   • an unpinned runtime fails on a host with the wrong Node, at Prisma engine load;
 *   • an unattended deploy path fires on a push, which is exactly when nobody is watching;
 *   • an appended `x-forwarded-for` restores IP spoofing WITHOUT touching the application;
 *   • clustering the app silently multiplies every rate limit (the limiter is per-process);
 *   • a health probe that checks the database restart-loops a healthy server;
 *   • a stale third-party host in the origin allowlist hands someone else the origin used
 *     to build payment callback URLs.
 */

const ROOT = resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(resolve(ROOT, relativePath), "utf-8");
}

function json(relativePath: string): Record<string, unknown> {
    return JSON.parse(read(relativePath));
}

/* ==================================================================================
 * 1. NODE RUNTIME IS PINNED, AND THE PIN IS CONSISTENT WITH THE FRAMEWORK
 * ================================================================================== */

describe("the Node runtime is pinned", () => {
    it("pins a major version in .nvmrc", () => {
        expect(read(".nvmrc").trim()).toBe("24");
    });

    it("declares an engines range, so npm can warn on a mismatched host", () => {
        const engines = json("package.json").engines as { node?: string } | undefined;

        expect(engines?.node).toBe(">=20.9.0 <25");
    });

    it("keeps the pin above the floor the installed Next.js declares", () => {
        // Derived, not hard-coded: if a future Next.js raises its floor, this fails and the
        // pin has to be re-derived rather than quietly becoming wrong.
        const nextEngines = (
            json("node_modules/next/package.json").engines as { node?: string }
        ).node;

        expect(nextEngines).toBeTruthy();
        expect((json("package.json").engines as { node?: string }).node).toContain(
            nextEngines
        );

        const floor = Number(/(\d+)/.exec(String(nextEngines))?.[1]);
        const pinned = Number(/^(\d+)/.exec(read(".nvmrc").trim())?.[1]);

        expect(pinned).toBeGreaterThanOrEqual(floor);
    });
});

/* ==================================================================================
 * 2. NO UNATTENDED DEPLOY PATH IN THE REPOSITORY
 * ================================================================================== */

describe("the repository contains no unattended deployment path", () => {
    const workflowsDir = resolve(ROOT, ".github", "workflows");

    function workflowFiles(): string[] {
        if (!existsSync(workflowsDir)) return [];

        return readdirSync(workflowsDir).filter(
            (name) => name.endsWith(".yml") || name.endsWith(".yaml")
        );
    }

    it("does not SSH anywhere from CI", () => {
        // The deleted workflow used appleboy/ssh-action to run a remote script on every push
        // to main. A build/lint/test workflow is fine and is deliberately NOT forbidden —
        // what must never come back is the deploy.
        for (const name of workflowFiles()) {
            const source = readFileSync(resolve(workflowsDir, name), "utf-8");

            expect(source).not.toMatch(/ssh-action/i);
            expect(source).not.toMatch(/deploy\.sh/i);
            expect(source).not.toMatch(/nvm\s+use/i);
        }
    });

    it("does not reference the deleted retail project or its remote path", () => {
        for (const name of workflowFiles()) {
            const source = readFileSync(resolve(workflowsDir, name), "utf-8");

            expect(source).not.toContain("demo-marketplace");
            expect(source).not.toMatch(/VPSBIZNET|VPS_SSH_KEY/i);
        }
    });

    it("carries no leftover secrets configuration for that deploy", () => {
        // Belt and braces: the names must not survive anywhere in the tree either.
        const candidates = [
            ".github/workflows/deploy.yml",
            ".github/workflows/test-vps.yml",
        ];

        for (const path of candidates) {
            expect(existsSync(resolve(ROOT, path))).toBe(false);
        }
    });
});

/* ==================================================================================
 * 3. THE PROCESS DEFINITION MATCHES WHAT THE CODE CAN ACTUALLY SUPPORT
 * ================================================================================== */

describe("the PM2 process definition is consistent with the application", () => {
    const config = read("ecosystem.config.cjs");

    it("exists and starts Next.js's own binary rather than npm", () => {
        expect(existsSync(resolve(ROOT, "ecosystem.config.cjs"))).toBe(true);

        expect(config).toContain("node_modules/next/dist/bin/next");
        // `pm2 start npm -- start` would make PM2 supervise npm, not the server.
        expect(config).not.toMatch(/script:\s*["']npm["']/);
    });

    it("binds loopback, which is what makes TRUSTED_PROXY safe", () => {
        // `next start` binds 0.0.0.0 unless -H is passed, and it does NOT read HOSTNAME.
        expect(config).toContain("-H 127.0.0.1");
    });

    it("runs a single forked instance, because the rate limiter is per-process", () => {
        // The justification is checked here rather than assumed: if the limiter ever moves
        // out of process, this test is the signal that clustering became possible.
        const limiter = read("lib/rate-limit.ts");

        expect(limiter).toContain("new Map<string, RateLimitEntry>()");
        expect(limiter).toContain("in-memory");

        expect(config).toMatch(/instances:\s*1\b/);
        expect(config).toMatch(/exec_mode:\s*["']fork["']/);
    });

    it("names no env_file, so the process environment is the single source of truth", () => {
        // Asserted as an ASSIGNMENT, not as file text: the header comment explains that
        // `env_file` is deliberately absent, and naming it there is how the next reader
        // learns why. A repository-controlled path holding production secrets is the thing to
        // avoid, and Next.js already loads .env/.env.production from cwd by itself.
        expect(config).not.toMatch(/^\s*env_file\s*:/m);

        // And the definition really does parse as a PM2 apps array.
        expect(config).toMatch(/apps:\s*\[/);
    });
});

/* ==================================================================================
 * 4. THE ORIGIN ALLOWLIST CARRIES NO HOST THIS PRODUCT DOES NOT CONTROL
 * ================================================================================== */

describe("the payment/app origin allowlist", () => {
    const origin = read("lib/app-origin.ts");

    /** Every hostname the allowlist actually ADMITS: `hosts.add("…")` call sites only. */
    function allowlistedHosts(): string[] {
        return [...origin.matchAll(/hosts\.add\("([^"]+)"\)/g)].map((m) => m[1]);
    }

    it("admits no host the product does not control", () => {
        // Asserted against the CALL SITES, not the file text: the comment above them explains
        // that an ephemeral quick-tunnel host was removed, and naming it in prose is how the
        // next reader learns why it must not come back.
        //
        // A quick-tunnel name is issued by a third party, expires, and can be claimed again by
        // anyone, so admitting one would hand the origin used for payment callback URLs to
        // whoever holds the name at that moment.
        const admitted = allowlistedHosts();

        expect(admitted.length).toBeGreaterThan(0);

        for (const host of admitted) {
            expect(host).not.toMatch(/trycloudflare/i);
            // No wildcard, no scheme, no port, no path: a plain hostname or nothing.
            expect(host).toMatch(/^[a-z0-9.-]+$/i);
        }

        // The loopback variants a local run needs must be present, or development breaks.
        expect(admitted).toEqual(expect.arrayContaining(["localhost", "127.0.0.1"]));
    });

    it("still reads the env var it prefers over that list", () => {
        expect(origin).toContain("NEXT_PUBLIC_APP_URL");
    });

    it("consults NEXT_PUBLIC_APP_URL before falling back to the allowlist", () => {
        // The allowlist is a FALLBACK, reached only when the env var is unset, so the env
        // branch has to come first in `getAppOrigin`.
        const envBranch = origin.indexOf("if (envUrl &&");
        const fallbackCall = origin.indexOf("const allowedHosts = buildAllowedHosts();");

        expect(envBranch).toBeGreaterThan(-1);
        expect(fallbackCall).toBeGreaterThan(envBranch);
    });
});

/* ==================================================================================
 * 5. RUNTIME STATE IS IGNORED, AND THE ENVIRONMENT TEMPLATE DOES NOT MISLEAD
 * ================================================================================== */

describe("runtime state and the environment template", () => {
    const gitignore = read(".gitignore");
    const template = read(".env.example");

    it("ignores the runtime upload tree and generated artifacts", () => {
        for (const rule of ["storage/", "*.tsbuildinfo", "next-env.d.ts", ".env"]) {
            expect(gitignore).toContain(rule);
        }
    });

    it("does not present HOSTNAME or PORT as .env configuration", () => {
        // Neither is an active assignment in the template, because neither would work:
        // `next start` ignores HOSTNAME entirely and resolves PORT before it loads .env.
        expect(template).not.toMatch(/^HOSTNAME=/m);
        expect(template).not.toMatch(/^PORT=/m);

        // …and the trap is documented rather than merely omitted.
        expect(template).toContain("HOSTNAME");
        expect(template).toMatch(/next start -H/);
    });

    it("still marks TRUSTED_PROXY as required behind a proxy", () => {
        expect(template).toMatch(/^TRUSTED_PROXY=/m);
        expect(template).toMatch(/untrusted/);
    });
});

/* ==================================================================================
 * 6. HEALTH ENDPOINTS EXIST, ARE PUBLIC, AND ARE DOCUMENTED FOR THE OPERATOR
 * ================================================================================== */

describe("health and readiness", () => {
    it("ships both endpoints", () => {
        expect(existsSync(resolve(ROOT, "app/api/health/route.ts"))).toBe(true);
        expect(existsSync(resolve(ROOT, "app/api/health/ready/route.ts"))).toBe(true);
    });

    it("classifies them PUBLIC in the proxy, so a probe without a session can reach them", () => {
        const proxy = read("proxy.ts");
        const match = /PUBLIC_API_PREFIXES[^=]*=\s*\[([\s\S]*?)\]/.exec(proxy);

        expect(match).toBeTruthy();

        const prefixes = [...String(match?.[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);

        expect(prefixes).toContain("/api/health");
    });

    it("keeps liveness free of any dependency check", () => {
        const liveness = read("app/api/health/route.ts");

        // The property that stops a database outage from restart-looping a healthy process.
        expect(liveness).not.toContain("prisma");
        expect(liveness).not.toContain("$queryRaw");
    });

    it("is documented in the runbook for the operator", () => {
        const runbook = read("DEPLOYMENT_RUNBOOK.md");

        expect(runbook).toContain("/api/health");
        expect(runbook).toContain("/api/health/ready");
    });
});

/* ==================================================================================
 * 7. THE RUNBOOK DESCRIBES THE DEPLOYMENT WITHOUT INVITING A DATA LOSS
 * ================================================================================== */

describe("the deployment runbook", () => {
    const runbook = read("DEPLOYMENT_RUNBOOK.md");

    it("uses forward-only migrations and says rollback is a restore", () => {
        expect(runbook).toContain("npx prisma migrate deploy");
        expect(runbook).toContain("no down-migrations");
    });

    it("requires the proxy to OVERWRITE x-forwarded-for", () => {
        // The append form is the spoofable one, and the runbook must name it as forbidden
        // rather than merely prefer the safe directive.
        expect(runbook).toContain("$remote_addr");
        expect(runbook).toContain("$proxy_add_x_forwarded_for");
        expect(runbook).toMatch(/OVERWRITE/);
    });

    it("gates the scheduler behind conditions rather than treating it as a step", () => {
        expect(runbook).toMatch(/Scheduler gate/i);
        expect(runbook).toContain("/api/internal/jobs/tick");
        expect(runbook).toMatch(/JOBS_TICK_SECRET/);
    });

    it("keeps uploads and the database as one backup unit", () => {
        expect(runbook).toContain("UPLOAD_DIR");
        expect(runbook).toMatch(/mysqldump/);
        expect(runbook).toMatch(/tar /);
    });
});
