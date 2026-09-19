/**
 * ==========================================
 * M4 SECURITY TEST — Content-Security-Policy
 * ==========================================
 *
 * Verifies that CSP is configured with
 * appropriate restrictive directives.
 */

import { readFileSync } from "fs";
import { resolve } from "path";

function readConfig(): string {
    return readFileSync(
        resolve(process.cwd(), "next.config.ts"),
        "utf-8"
    );
}

/* ==========================================
 * TESTS
 * ========================================== */

describe("M4 — CSP Configuration Audit", () => {
    let config: string;

    beforeAll(() => {
        config = readConfig();
    });

    test("Content-Security-Policy header exists", () => {
        expect(config).toContain("Content-Security-Policy");
    });

    test("default-src is restricted to 'self'", () => {
        expect(config).toContain("default-src 'self'");
    });

    test("script-src includes 'self'", async () => {
        // CSP is now dynamically generated — validate runtime output
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") csp = h.value;
            }
        }
        expect(csp).toMatch(/script-src\s+.*'self'/);
    });

    test("script-src includes 'unsafe-inline' (required by Next.js inline bootstrap)", async () => {
        // CSP is now dynamically generated — validate runtime output
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") csp = h.value;
            }
        }
        expect(csp).toMatch(/script-src\s+.*'unsafe-inline'/);
    });

    test("script-src does NOT allow arbitrary external script origins", async () => {
        // CSP is now dynamically generated — validate the actual runtime output
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") {
                    csp = h.value;
                }
            }
        }
        const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
        expect(scriptSrcMatch).not.toBeNull();
        if (scriptSrcMatch) {
            // Must contain only known-safe sources
            expect(scriptSrcMatch[1]).toContain("'self'");
            expect(scriptSrcMatch[1]).toContain("'unsafe-inline'");
            // No third-party script origin is permitted.
            expect(scriptSrcMatch[1]).not.toMatch(/https?:\/\//);
            // Should NOT contain eval in production
            expect(scriptSrcMatch[1]).not.toContain("'unsafe-eval'");
        }
    });

    test("style-src includes 'self' and 'unsafe-inline'", () => {
        expect(config).toMatch(/style-src.*'self'.*'unsafe-inline'/);
    });

    test("img-src allows only our own origin, data: URIs and the gateway's QR host", () => {
        // The gateway hosts were added deliberately: iPaymu serves the QRIS code as a PNG on
        // its own domain, and that image IS the payment instrument. The assertion below still
        // fails on any OTHER third-party image origin.
        expect(config).toContain(
            "img-src 'self' data: https://my.ipaymu.com https://sandbox.ipaymu.com"
        );
    });

    test("img-src allows data: URIs (for inline images)", () => {
        expect(config).toContain("img-src");
        expect(config).toContain("data:");
    });

    test("font-src is restricted to 'self'", () => {
        expect(config).toContain("font-src 'self'");
    });

    test("connect-src is restricted to 'self'", () => {
        expect(config).toContain("connect-src 'self'");
    });

    test("frame-src is set to 'none'", () => {
        expect(config).toContain("frame-src 'none'");
    });

    test("object-src is set to 'none'", () => {
        expect(config).toContain("object-src 'none'");
    });

    test("base-uri is restricted to 'self'", () => {
        expect(config).toContain("base-uri 'self'");
    });

    test("form-action is restricted to 'self'", () => {
        expect(config).toContain("form-action 'self'");
    });

    test("frame-ancestors is set to 'none'", () => {
        expect(config).toContain("frame-ancestors 'none'");
    });

    test("No eval or new Function in CSP (production)", async () => {
        // CSP without 'unsafe-eval' blocks eval() and new Function()
        // Validate the actual runtime output for production
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = await headersFn();
        const headersArray = result as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;
        let csp = "";
        for (const entry of headersArray) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") {
                    csp = h.value;
                }
            }
        }
        const scriptSrcMatch = csp.match(/script-src\s+([^;]+)/);
        expect(scriptSrcMatch).not.toBeNull();
        if (scriptSrcMatch) {
            // In the current test environment (NODE_ENV=test), unsafe-eval must not be present
            expect(scriptSrcMatch[1]).not.toContain("'unsafe-eval'");
        }
    });

    test("CSP directives are semicolon-separated", () => {
        expect(config).toContain('.join("; ")');
    });

    test("No duplicate CSP definitions", () => {
        const matches = config.match(/Content-Security-Policy/g);
        expect(matches).toHaveLength(1);
    });
});

/* ==========================================
 * EXTERNAL ORIGIN VERIFICATION
 * ==========================================
 *
 * The three checks that used to live here verified that the origins allowed by the CSP matched the
 * components that used them — the TikTok pixel, Leaflet map tiles and Leaflet marker images. All
 * three components belonged to the retail application and were deleted with it, and the
 * corresponding CSP allowances were removed rather than left as unused policy.
 *
 * The replacement guard is the inverse, and it is what actually matters now: the CSP must allow no
 * third-party script or image origin at all.
 */

describe("M4 — External Origin Verification", () => {
    test("no third-party script or image origin is allowed", async () => {
        const nextConfig = (await import("../../next.config")).default;
        const headersFn = nextConfig.headers as () => Promise<unknown>;
        const result = (await headersFn()) as Array<{
            source: string;
            headers: Array<{ key: string; value: string }>;
        }>;

        let csp = "";
        for (const entry of result) {
            for (const h of entry.headers) {
                if (h.key === "Content-Security-Policy") csp = h.value;
            }
        }

        // The deleted retail integrations must not survive as dead CSP policy.
        expect(csp).not.toContain("analytics.tiktok.com");
        expect(csp).not.toContain("openstreetmap.org");
        expect(csp).not.toContain("unpkg.com");
        expect(csp).not.toContain("susercontent.com");

        // script-src is still our own origin only. img-src names exactly two third-party
        // origins — the payment gateway's — and nothing else, because the QRIS image it hosts
        // is the payment instrument and cannot be re-encoded locally.
        const scriptSrc = csp.match(/script-src\s+([^;]+)/)?.[1] ?? "";
        const imgSrc = csp.match(/img-src\s+([^;]+)/)?.[1] ?? "";

        expect(scriptSrc).toContain("'self'");
        expect(scriptSrc).not.toMatch(/https?:\/\//);
        expect(imgSrc).toContain("'self'");

        const imgOrigins =
            imgSrc.match(/https?:\/\/[^\s;]+/g)?.map((value) => value.trim()) ?? [];

        expect(imgOrigins.sort()).toEqual([
            "https://my.ipaymu.com",
            "https://sandbox.ipaymu.com",
        ]);
    });
});

/* ==========================================
 * REGRESSION CHECKS
 * ========================================== */

describe("M4 — No regression to other fixes", () => {
    test("HSTS still present (M3 not broken)", () => {
        const config = readConfig();
        expect(config).toContain("Strict-Transport-Security");
        expect(config).toContain("max-age=31536000");
    });

    test("Other security headers still present", () => {
        const config = readConfig();
        expect(config).toContain("X-Content-Type-Options");
        expect(config).toContain("X-Frame-Options");
        expect(config).toContain("Referrer-Policy");
        expect(config).toContain("Permissions-Policy");
    });

    test("iPaymu outgoing signature still works (H2 not broken)", async () => {
        const { generateSignature } = await import(
            "@/lib/payment/ipaymu"
        );
        const sig = generateSignature(
            '{"amount":10000}',
            "1179000899",
            "test-key"
        );
        expect(sig).toMatch(/^[a-f0-9]{64}$/);
    });

    test("getClientIp still works (M2 not broken)", async () => {
        const { getClientIp } = await import(
            "@/lib/rate-limit"
        );
        delete process.env.TRUSTED_PROXY;
        const req = new Request("https://example.com", {
            headers: { "x-forwarded-for": "1.2.3.4" },
        });
        expect(getClientIp(req)).toBe("untrusted");
    });
});
