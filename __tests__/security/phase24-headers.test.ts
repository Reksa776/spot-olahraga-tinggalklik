import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ==========================================
 * SECURITY HEADERS — THE PHASE 24 CONTRACT
 * ==========================================
 *
 * `m3-hsts.test.ts`, `m4-csp.test.ts` and `csp-development-unsafe-eval.test.ts` describe the
 * header policy as it must be. Those suites were failing because `next.config.ts` carried no
 * `headers()` function at all, so this phase restored the policy — derived from an audit of what
 * this application actually loads, rather than restored from the deleted retail configuration.
 *
 * This suite pins the parts of the decision those three do not:
 *
 *   1. HSTS is sent in every environment EXCEPT development, where the server speaks plain HTTP
 *      and a one-year "always use HTTPS for this host" instruction is meaningless noise that
 *      outlives the dev server.
 *   2. The CSP is IDENTICAL in `test` and in `production`. Every other CSP assertion in the
 *      repository runs under `NODE_ENV=test`; that is only evidence about production if this
 *      holds.
 *   3. Both halves of the framing protection are present (the header for old browsers, the
 *      directive for browsers that ignore it).
 *   4. `allow-listing` is bounded: `img-src` names the payment gateway and nothing else, and no
 *      other directive names a third-party origin at all. This is the assertion that catches a
 *      well-meaning future `img-src https://some-cdn.example`.
 *   5. The remote asset that used to make the sign-in page depend on a third-party host is gone:
 *      the Google mark is inline SVG.
 */

type HeaderEntry = {
    source: string;
    headers: Array<{ key: string; value: string }>;
};

async function headersFor(nodeEnv: string): Promise<HeaderEntry> {
    const original = process.env.NODE_ENV;

    Object.defineProperty(process.env, "NODE_ENV", {
        value: nodeEnv,
        writable: true,
        configurable: true,
    });

    try {
        const nextConfig = (await import("../../next.config")).default as {
            headers?: () => Promise<HeaderEntry[]>;
        };

        expect(typeof nextConfig.headers).toBe("function");

        const entries = await nextConfig.headers!();

        expect(entries.length).toBe(1);
        expect(entries[0].source).toBe("/(.*)");

        return entries[0];
    } finally {
        Object.defineProperty(process.env, "NODE_ENV", {
            value: original,
            writable: true,
            configurable: true,
        });
    }
}

function byKey(entry: HeaderEntry): Record<string, string> {
    return Object.fromEntries(entry.headers.map((header) => [header.key, header.value]));
}

/** Strip comments, so prose that NAMES a remote URL is not read as a remote URL in use. */
function readCode(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf-8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

function directive(csp: string, name: string): string {
    return (
        csp
            .split(";")
            .map((part) => part.trim())
            .find((part) => part.startsWith(`${name} `)) ?? ""
    );
}

const THIRD_PARTY_ORIGIN = /https?:\/\/[^\s;'"]+/g;

/* ==================================================================================
 * 1. HSTS
 * ================================================================================== */

describe("HSTS is sent everywhere except development", () => {
    it("is present with a one-year max-age in production", async () => {
        const headers = byKey(await headersFor("production"));

        expect(headers["Strict-Transport-Security"]).toBe(
            "max-age=31536000; includeSubDomains"
        );
    });

    it("is present under NODE_ENV=test, which is what the contract suites assert", async () => {
        const headers = byKey(await headersFor("test"));

        expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
        expect(headers["Strict-Transport-Security"]).toContain("includeSubDomains");
    });

    it("is NOT sent in development, where the server speaks plain HTTP", async () => {
        const headers = byKey(await headersFor("development"));

        expect(headers["Strict-Transport-Security"]).toBeUndefined();

        // …and the rest of the policy is still in force there: the omission is about HTTPS
        // only, not an excuse to drop the other headers.
        expect(headers["X-Content-Type-Options"]).toBe("nosniff");
        expect(headers["Content-Security-Policy"]).toBeTruthy();
    });

    it("does not enable preload, which is a deployment-owner decision", async () => {
        for (const env of ["production", "test"]) {
            const headers = byKey(await headersFor(env));

            expect(headers["Strict-Transport-Security"]).not.toContain("preload");
        }
    });
});

/* ==================================================================================
 * 2. THE CSP IS THE SAME IN production AND test
 * ================================================================================== */

describe("the CSP does not vary between production and the test environment", () => {
    it("produces a byte-identical policy", async () => {
        const production = byKey(await headersFor("production"))["Content-Security-Policy"];
        const test = byKey(await headersFor("test"))["Content-Security-Policy"];

        expect(test).toBe(production);
    });

    it("adds 'unsafe-eval' in development only, and to script-src only", async () => {
        const development = byKey(await headersFor("development"))["Content-Security-Policy"];
        const production = byKey(await headersFor("production"))["Content-Security-Policy"];

        expect(directive(development, "script-src")).toContain("'unsafe-eval'");
        expect(directive(production, "script-src")).not.toContain("'unsafe-eval'");

        // Nothing else in the policy is environment-dependent: removing the one extra token
        // yields the production policy exactly.
        expect(development.replace(/ ?'unsafe-eval'/, "")).toBe(production);
    });

    it("never allows eval outside development, in any spelling", async () => {
        for (const env of ["production", "test"]) {
            const csp = byKey(await headersFor(env))["Content-Security-Policy"];

            expect(csp).not.toContain("unsafe-eval");
            expect(csp).not.toContain("'unsafe-hashes'");
            expect(csp).not.toContain("*");
        }
    });
});

/* ==================================================================================
 * 3. WHATEVER IS ALLOWED, IS BOUNDED
 * ================================================================================== */

describe("the policy allows only what the application actually loads", () => {
    it("names exactly the two payment-gateway image origins, and no other third party", async () => {
        const csp = byKey(await headersFor("production"))["Content-Security-Policy"];

        const eachDirective = csp.split(";").map((part) => part.trim());
        const origins: string[] = [];

        for (const part of eachDirective) {
            // `form-action`, `base-uri` etc. legitimately name `'self'`; only real URLs count.
            origins.push(...(part.match(THIRD_PARTY_ORIGIN) ?? []));
        }

        expect([...new Set(origins)].sort()).toEqual([
            "https://my.ipaymu.com",
            "https://sandbox.ipaymu.com",
        ]);
    });

    it("keeps script-src, style-src, font-src and connect-src third-party free", async () => {
        const csp = byKey(await headersFor("production"))["Content-Security-Policy"];

        for (const name of ["script-src", "style-src", "font-src", "connect-src"]) {
            expect(directive(csp, name)).not.toMatch(/https?:\/\//);
        }
    });

    it("covers the base directives the application relies on", async () => {
        const csp = byKey(await headersFor("production"))["Content-Security-Policy"];

        expect(directive(csp, "default-src")).toBe("default-src 'self'");
        expect(directive(csp, "object-src")).toBe("object-src 'none'");
        expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
        expect(directive(csp, "form-action")).toBe("form-action 'self'");

        // The inline theme bootstrap in `app/layout.tsx` and Next's inline style injection are
        // why `'unsafe-inline'` is required; it is a real constraint, not an oversight.
        expect(directive(csp, "script-src")).toContain("'unsafe-inline'");
        expect(directive(csp, "style-src")).toContain("'unsafe-inline'");

        // No iframe is embedded anywhere (Google sign-in is a full-page redirect).
        expect(directive(csp, "frame-src")).toBe("frame-src 'none'");
    });

    it("denies framing twice over", async () => {
        for (const env of ["production", "test", "development"]) {
            const headers = byKey(await headersFor(env));

            expect(headers["X-Frame-Options"]).toBe("DENY");
            expect(directive(headers["Content-Security-Policy"], "frame-ancestors")).toBe(
                "frame-ancestors 'none'"
            );
        }
    });

    it("delegates the camera to this origin and restricts the capabilities it does not use", async () => {
        const headers = byKey(await headersFor("production"));

        // The gate scanner needs the camera for THIS origin. `camera=()` disables the
        // feature for the document too (getUserMedia -> NotAllowedError even with a granted
        // site permission); `camera=(self)` is the value that actually works. Microphone and
        // geolocation stay denied outright.
        expect(headers["Permissions-Policy"]).toBe(
            "camera=(self), microphone=(), geolocation=()"
        );
        expect(headers["X-Content-Type-Options"]).toBe("nosniff");
        expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    });

    it("does not advertise the framework", async () => {
        const nextConfig = (await import("../../next.config")).default as {
            poweredByHeader?: boolean;
        };

        expect(nextConfig.poweredByHeader).toBe(false);
    });
});

/* ==================================================================================
 * 4. THE HEADERS ARE ACTUALLY APPLIED TO EVERY RESPONSE
 * ================================================================================== */

describe("the headers are attached globally, not per route", () => {
    const source = readCode("next.config.ts");

    it("uses one global source pattern", async () => {
        // Read through the runtime value as well as the file, so a reordered config cannot
        // satisfy a text match while missing the actual request.
        const entry = await headersFor("production");

        expect(entry.source).toBe("/(.*)");
    });

    it("does not restrict them to /api", () => {
        expect(source).not.toMatch(/source:\s*["']\/api\//);
    });

    it("sends the policy on a page route, which is the whole point", () => {
        // The document surfaces (login, checkout, the order page) are what the policy exists to
        // protect; a header set that only covered `/api` would still fail this reasoning.
        expect(source).toContain('source: "/(.*)"');
    });
});

/* ==================================================================================
 * 5. NO THIRD-PARTY ASSET ON THE AUTH PAGES
 * ================================================================================== */

describe("the sign-in screens load no third-party asset", () => {
    it.each([
        "components/auth/LoginForm.tsx",
        "components/auth/RegisterForm.tsx",
    ])("%s renders the Google mark inline", (file) => {
        const code = readCode(file);

        expect(code).toContain("GoogleMark");
        expect(code).not.toContain("http://");
        expect(code).not.toContain("https://");
        expect(code).not.toContain("<img");
    });

    it("the Google mark is inline SVG with no remote reference", () => {
        const code = readCode("components/auth/GoogleMark.tsx");

        expect(code).toContain("<svg");
        expect(code).not.toContain("https://");
        expect(code).not.toContain("<image");
    });
});
