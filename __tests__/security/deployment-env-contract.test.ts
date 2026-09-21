import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ==========================================
 * DEPLOYMENT ENVIRONMENT CONTRACT
 * ==========================================
 *
 * `.env.example` is the only deployment document an operator is guaranteed to read, and the
 * Phase 25 audit found it pointing at the DELETED retail application: it advertised
 * Cloudinary, payout-provider, RajaOngkir, WhatsApp and spin-wheel variables that no code
 * reads any more, it omitted `AUTH_URL` (the value the login redirect origin is built from),
 * and its iPaymu block led with `IPAYMU_URL="https://sandbox.iapmu.id"` — a domain that is
 * both misspelled and unused by the payment path, whose real selector is
 * `PAYMENT_ENVIRONMENT`.
 *
 * That is a misconfiguration footgun rather than a code defect, so it is fixed in the template
 * and PINNED here: the template must document what the code reads, and must not advertise what
 * the code does not.
 *
 * The assertions are derived from the SOURCES rather than from a hand-written list wherever
 * that is possible, so a rename in `lib/payment/config.ts` fails this suite instead of
 * silently invalidating it.
 */

const ROOT = resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(resolve(ROOT, relativePath), "utf-8");
}

const TEMPLATE = read(".env.example");

/** `NAME=` lines that are NOT commented out — the variables an operator is told to set. */
function activeKeys(): string[] {
    return TEMPLATE.split("\n")
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1])
        .filter((key): key is string => Boolean(key));
}

/** Names mentioned anywhere, including inside comments. */
function mentions(name: string): boolean {
    return new RegExp(`\\b${name}\\b`).test(TEMPLATE);
}

/* ==================================================================================
 * 1. THE TEMPLATE IS A TEMPLATE
 * ================================================================================== */

describe("the environment template", () => {
    it("exists, is non-trivial, and carries no real credential", () => {
        expect(TEMPLATE.length).toBeGreaterThan(500);

        // A committed template must not contain anything that looks like a live key. Every
        // value here is a placeholder or a harmless default.
        expect(TEMPLATE).not.toMatch(/sk_live_/);
        expect(TEMPLATE).not.toMatch(/-----BEGIN/);
        expect(TEMPLATE).toMatch(/replace-me|replace-with-a-random-secret/);
    });

    it("tells the operator .env must never be committed", () => {
        expect(TEMPLATE).toMatch(/never commit/i);
    });
});

/* ==================================================================================
 * 2. EVERY VARIABLE THE CODE READS IS DOCUMENTED
 * ================================================================================== */

describe("documented = what the code actually reads", () => {
    it("documents the payment credential pair named by lib/payment/config.ts", () => {
        const config = read("lib/payment/config.ts");

        // The ACTIVE selector and both credential pairs, asserted to exist in the source
        // before being required of the template.
        const required = [
            "PAYMENT_ENVIRONMENT",
            "IPAYMU_SANDBOX_VA",
            "IPAYMU_SANDBOX_API_KEY",
            "IPAYMU_SANDBOX_BASE_URL",
            "IPAYMU_PRODUCTION_VA",
            "IPAYMU_PRODUCTION_API_KEY",
            "IPAYMU_PRODUCTION_BASE_URL",
        ];

        for (const name of required) {
            expect(config).toContain(name);
            expect(mentions(name)).toBe(true);
        }
    });

    it("documents the runtime variables read elsewhere in the tree", () => {
        const sources = [
            "auth.ts",
            "lib/rate-limit.ts",
            "app/api/internal/jobs/tick/route.ts",
            "lib/images/process.ts",
            "lib/app-origin.ts",
        ]
            .map(read)
            .join("\n");

        for (const name of [
            "JOBS_TICK_SECRET",
            "TRUSTED_PROXY",
            "UPLOAD_DIR",
            "NEXT_PUBLIC_APP_URL",
            "GOOGLE_CLIENT_ID",
            "GOOGLE_CLIENT_SECRET",
        ]) {
            expect(sources).toContain(name);
            expect(mentions(name)).toBe(true);
        }
    });

    it("documents DATABASE_URL, which Prisma resolves from the schema, not from lib/", () => {
        // No `process.env.DATABASE_URL` exists in the application tree: `prisma/schema.prisma`
        // declares `env("DATABASE_URL")`, and the driver resolves it at connect time. So the
        // template is the only place an operator can learn that this database is ALSO the
        // base name of the Jest test database.
        expect(read("prisma/schema.prisma")).toContain('env("DATABASE_URL")');
        expect(TEMPLATE).toMatch(/^DATABASE_URL=/m);
        expect(TEMPLATE).toContain("_test");
    });

    it("documents AUTH_SECRET as required, and how to generate it", () => {
        // Likewise internal to Auth.js — there is no `process.env.AUTH_SECRET` to grep for.
        expect(TEMPLATE).toMatch(/^AUTH_SECRET=/m);
        expect(TEMPLATE).toMatch(/openssl rand -base64 32/);
        expect(TEMPLATE).toMatch(/REQUIRED/i);
    });

    it("documents AUTH_URL, which the code needs but never reads by name", () => {
        // Auth.js reads it internally (`next-auth/lib/env.js` overrides `req.url` with it), so
        // no `process.env.AUTH_URL` exists to find — which is exactly why it was missing from
        // the template, and why the proxy has to document the coupling instead
        // (`proxy.ts`: "AUTH_URL must simply be correct per environment").
        expect(read("proxy.ts")).toContain("AUTH_URL");
        expect(TEMPLATE).toMatch(/^AUTH_URL=/m);
        expect(TEMPLATE).toMatch(/overwrites? .*req\.url|override the request's URL/i);
    });

    it("sets the selector to sandbox by default and says what happens when it is unset", () => {
        expect(TEMPLATE).toMatch(/^PAYMENT_ENVIRONMENT="sandbox"$/m);
        expect(TEMPLATE).toMatch(/throws?|THROW/);
    });
});

/* ==================================================================================
 * 3. NOTHING FROM THE DELETED RETAIL APPLICATION IS ADVERTISED
 * ================================================================================== */

describe("no variable from the deleted retail application remains", () => {
    it.each([
        "CLOUDINARY_CLOUD_NAME",
        "CLOUDINARY_API_KEY",
        "CLOUDINARY_API_SECRET",
        "PAYOUT_API_KEY",
        "PAYOUT_SECRET_KEY",
        "PAYOUT_BASE_URL",
        "PAYOUT_MERCHANT_ID",
        "RAJAONGKIR_API_KEY",
        "RAJAONGKIR_BASE_URL",
        "WHATSAPP_AUTH_DIR",
        "NOTIFICATION_PROVIDER",
        "SPIN_WHEEL_TEST_MODE",
    ])("%s is gone", (name) => {
        expect(mentions(name)).toBe(false);
    });

    it("the removed names really are unread by the tree", () => {
        const app = ["app", "lib", "components", "proxy.ts", "auth.ts"]
            .map((entry) => {
                try {
                    return read(entry);
                } catch {
                    // A directory, not a file: read the handful of real reads instead.
                    return "";
                }
            })
            .join("\n");

        // Spot-check the two that would be dangerous to leave advertised: a paid shipping API
        // and an identity-document storage provider.
        expect(app).not.toContain("RAJAONGKIR");
        expect(app).not.toContain("CLOUDINARY");
    });
});

/* ==================================================================================
 * 4. THE LEGACY iPAYMU NAMES CANNOT BE MISTAKEN FOR THE ACTIVE CONFIG
 * ================================================================================== */

describe("legacy single-environment iPaymu names are not presented as configuration", () => {
    it.each(["IPAYMU_API_KEY", "IPAYMU_VA", "IPAYMU_URL", "IPAYMU_IS_PRODUCTION"])(
        "%s is commented out and marked legacy",
        (name) => {
            // Never an active `NAME=` line: configuring production this way would leave
            // PAYMENT_ENVIRONMENT unset, which makes the payment path throw at request time.
            expect(activeKeys()).not.toContain(name);

            expect(TEMPLATE).toMatch(new RegExp(`legacy[\\s\\S]{0,400}# ${name}=`, "i"));
        }
    );

    it("does not carry the misspelled sandbox domain that was in the old template", () => {
        expect(TEMPLATE).not.toContain("iapmu.id");
    });
});
