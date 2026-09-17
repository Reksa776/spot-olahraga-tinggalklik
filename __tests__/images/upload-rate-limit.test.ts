/**
 * ==========================================
 * PHASE 4 — EVENT IMAGE UPLOAD RATE LIMIT
 * ==========================================
 *
 * Brief §16 requires that event image uploads "apply upload rate limiting". Two things
 * need proving, and they are different:
 *
 *   1. the bucket behaves as documented (20/minute, keyed per user), and
 *   2. the upload route actually consults it, *before* reading the multipart body.
 *
 * The second matters more: a route that rate-limits after parsing the body has already
 * paid the memory cost the limit exists to prevent. It is asserted by reading the route
 * source, so removing the check — or moving it after `request.formData()` — fails here
 * rather than silently regressing.
 */

import fs from "fs";
import path from "path";

import { rateLimiters } from "@/lib/rate-limit";

/** A fresh key per test, so the shared module-level store cannot bleed between them. */
function uniqueUser(tag: string): string {
    return `p4-upload-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("the upload bucket policy", () => {
    test("allows the documented 20 requests per minute and denies the 21st", () => {
        const user = uniqueUser("policy");

        for (let attempt = 1; attempt <= 20; attempt++) {
            const result = rateLimiters.upload(user);

            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(20 - attempt);
        }

        const denied = rateLimiters.upload(user);

        expect(denied.allowed).toBe(false);
        expect(denied.remaining).toBe(0);
        expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    test("the bucket is per user, so one tenant cannot exhaust another's allowance", () => {
        const first = uniqueUser("a");
        const second = uniqueUser("b");

        for (let attempt = 0; attempt < 20; attempt++) {
            rateLimiters.upload(first);
        }

        expect(rateLimiters.upload(first).allowed).toBe(false);
        // The second user is untouched: exhaustion is not global.
        expect(rateLimiters.upload(second).allowed).toBe(true);
    });

    test("the denial reports a sane retry window within the one-minute policy", () => {
        const user = uniqueUser("retry");

        for (let attempt = 0; attempt < 20; attempt++) {
            rateLimiters.upload(user);
        }

        const denied = rateLimiters.upload(user);

        expect(denied.retryAfterMs).toBeGreaterThan(0);
        expect(denied.retryAfterMs).toBeLessThanOrEqual(60 * 1000);
    });
});

describe("the upload route consults the limiter", () => {
    const routePath = path.join(
        process.cwd(),
        "app/api/organizer/events/[id]/images/route.ts"
    );

    const source = fs.readFileSync(routePath, "utf8");

    /** Strip comments so prose about the limiter cannot satisfy the assertions. */
    const code = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");

    test("the POST handler calls rateLimiters.upload with the authenticated user id", () => {
        expect(code).toMatch(/rateLimiters\.upload\(\s*scope\.userId\s*\)/);
    });

    test("the limit is checked before the multipart body is parsed", () => {
        const limitAt = code.indexOf("rateLimiters.upload(");
        const bodyAt = code.indexOf("request.formData(");

        expect(limitAt).toBeGreaterThan(-1);
        expect(bodyAt).toBeGreaterThan(-1);
        expect(limitAt).toBeLessThan(bodyAt);
    });

    test("a denial raises RATE_LIMITED rather than a generic error", () => {
        expect(code).toMatch(/ERROR_CODES\.RATE_LIMITED/);
        expect(code).toMatch(/retryAfterMs/);
    });

    test("the limiter is keyed on the server-side identity, never a request value", () => {
        // No `body`, `searchParams` or header value may reach the limiter's key.
        expect(code).not.toMatch(/rateLimiters\.upload\([^)]*(searchParams|headers|body)/);
    });
});
