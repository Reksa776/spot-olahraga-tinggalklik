/**
 * ==========================================
 * PHASE 27A — LOGIN FAILURE ACCOUNTING (F3)
 * ==========================================
 *
 * D-53's login limiter charged the wrong thing. It counted REQUESTS, so a successful
 * sign-in spent the same allowance as a wrong password and five of the operator's own
 * logins could lock a bucket; and when the bucket was empty the visitor was told their
 * password was wrong, so they retried into the wall.
 *
 * This suite pins the two halves of the fix that are testable without a browser:
 *
 *   1. `clientRateLimitKey` — the bucket key. Production must be unchanged to the byte
 *      (a trusted reverse proxy yields the real client IP, a missing TRUSTED_PROXY still
 *      fails closed into the shared sentinel), while a server with no trustworthy peer
 *      address gets a labelled bucket of its own instead of sharing production's.
 *   2. the failed-credential allowance — a read-only probe plus an explicit failure
 *      recorder, so only a failed verification can spend it.
 *
 * It also asserts the WIRING in `auth.ts` and the register route, because the defect was
 * never a wrong number: it was the wrong call at the wrong moment, and a unit test of the
 * limiter alone would pass on a `authorize()` that still charged every request.
 */

import {
    checkRateLimit,
    clientRateLimitKey,
    getClientIp,
    peekRateLimit,
    rateLimiters,
    recordRateLimitFailure,
} from "@/lib/rate-limit";
import { LOGIN_RATE_LIMITED_CODE } from "@/lib/auth/sign-in-failure";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();

function read(relativePath: string): string {
    return readFileSync(resolve(ROOT, relativePath), "utf-8");
}

/** Comments removed, so a doc comment mentioning a symbol is never mistaken for a call. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

function credentialsRequest(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost:3000/api/auth/callback/credentials", {
        method: "POST",
        headers,
    });
}

/** Unique per test, so one test's failures can never be another's. */
let keyCounter = 0;

function uniqueKey(label: string): string {
    keyCounter += 1;
    return `${label}-${keyCounter}`;
}

const ORIGINAL_TRUSTED_PROXY = process.env.TRUSTED_PROXY;
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

/**
 * Write an environment variable from a test.
 *
 * The cast is required and is not a shortcut around a real constraint: Next's
 * `next-env.d.ts` declares `readonly NODE_ENV`, which is right for application code and
 * inconvenient for a suite whose subject is what production does. Nothing about the value
 * changes at runtime, and it is restored after every test.
 */
function setEnv(name: string, value: string): void {
    (process.env as Record<string, string>)[name] = value;
}

/** Restore a variable exactly, including "it was not there". */
function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    setEnv(name, value);
}

afterEach(() => {
    // Both are read at CALL time (never captured at import), which is the only reason a
    // suite can assert production behaviour and development behaviour in one process.
    restore("TRUSTED_PROXY", ORIGINAL_TRUSTED_PROXY);
    restore("NODE_ENV", ORIGINAL_NODE_ENV);
});

/* ==================================================================================
 * 1. THE BUCKET KEY
 * ================================================================================== */

describe("the login bucket key (F3)", () => {
    describe("production", () => {
        beforeEach(() => {
            setEnv("NODE_ENV", "production");
        });

        it("uses the forwarded client IP when a trusted proxy is configured", () => {
            setEnv("TRUSTED_PROXY", "1");

            expect(
                clientRateLimitKey(
                    credentialsRequest({
                        "x-forwarded-for": "203.0.113.7, 10.0.0.1",
                    })
                )
            ).toBe("203.0.113.7");
        });

        it("falls back to x-real-ip for a proxy that sends only that header", () => {
            setEnv("TRUSTED_PROXY", "1");

            expect(
                clientRateLimitKey(
                    credentialsRequest({ "x-real-ip": "203.0.113.9" })
                )
            ).toBe("203.0.113.9");
        });

        it("fails closed into the shared sentinel when TRUSTED_PROXY is unset", () => {
            delete process.env.TRUSTED_PROXY;

            /*
             * UNCHANGED from the M2 fix, and this is the assertion that proves the phase
             * did not turn "no proxy" into "trust everything": with nothing to trust, every
             * client shares one bucket rather than each being handed its own.
             */
            const key = clientRateLimitKey(
                credentialsRequest({ "x-forwarded-for": "198.51.100.9" })
            );

            expect(key).toBe("untrusted");
            expect(key).toBe(getClientIp(credentialsRequest()));
        });

        it("does not trust a spoofed x-forwarded-for when proxy trust is off", () => {
            delete process.env.TRUSTED_PROXY;

            const spoofed = credentialsRequest({
                "x-forwarded-for": "1.2.3.4",
                "x-real-ip": "5.6.7.8",
            });

            expect(clientRateLimitKey(spoofed)).toBe("untrusted");
            expect(clientRateLimitKey(spoofed)).not.toBe("1.2.3.4");
            expect(clientRateLimitKey(spoofed)).not.toBe("5.6.7.8");
        });

        it("fails closed when a trusted proxy is configured but sent no header", () => {
            setEnv("TRUSTED_PROXY", "1");

            expect(clientRateLimitKey(credentialsRequest())).toBe("untrusted");
        });
    });

    describe("development", () => {
        beforeEach(() => {
            setEnv("NODE_ENV", "development");
            delete process.env.TRUSTED_PROXY;
        });

        it("uses its own bucket instead of the production sentinel", () => {
            const key = clientRateLimitKey(credentialsRequest());

            expect(key).not.toBe("untrusted");
            expect(key).toBe("dev-local");
        });

        it("is bounded to development: the test environment gets it too, production does not", () => {
            // The gate is `=== "production"`, so nothing except an exact production build
            // can reach the fallback — and nothing except a non-production build can skip
            // the sentinel.
            expect(clientRateLimitKey(credentialsRequest())).toBe("dev-local");

            setEnv("NODE_ENV", "production");

            expect(clientRateLimitKey(credentialsRequest())).toBe("untrusted");
        });

        it("documents its own limitation: browsers on one dev server share this bucket", () => {
            /*
             * This is the honest half of F3, asserted so a future editor sees it rather
             * than discovers it. There is NO trustworthy per-browser address on this code
             * path:
             *
             *   • `next/dist/server/base-server.js:612` fills the header only when the
             *     client did not send one
             *     (`req.headers['x-forwarded-for'] ??= originalRequest?.socket?.remoteAddress`),
             *     so by the time a handler reads it, a client-supplied value and a
             *     socket-derived one are indistinguishable;
             *   • `NextRequest` declares no `ip` in Next 16.
             *
             * Reading the header anyway would re-open the M2 spoofing hole to buy
             * separation between two browsers on one laptop, so the fallback is a labelled
             * constant and the real remedy (failures only) lives in the accounting below.
             */
            const a = clientRateLimitKey(
                credentialsRequest({ "x-forwarded-for": "10.1.1.1" })
            );
            const b = clientRateLimitKey(
                credentialsRequest({ "x-forwarded-for": "10.1.1.2" })
            );

            expect(a).toBe(b);
        });
    });
});

/* ==================================================================================
 * 2. THE FAILED-CREDENTIAL ALLOWANCE
 * ================================================================================== */

describe("the failed-credential allowance (F3)", () => {
    it("keeps the D-53 values: five failures per fifteen minutes", () => {
        expect(rateLimiters.login.maxFailures).toBe(5);
        expect(rateLimiters.login.windowMs).toBe(15 * 60 * 1000);
    });

    it("is not consumed by a probe, however many times it is asked", () => {
        const key = uniqueKey("probe");

        for (let i = 0; i < 50; i++) {
            const result = rateLimiters.login.check(key);

            expect(result.allowed).toBe(true);
        }

        // 50 successful sign-ins' worth of probing, and the full allowance is intact.
        expect(rateLimiters.login.check(key).remaining).toBe(5);
    });

    it("is consumed by a failed verification, one per failure", () => {
        const key = uniqueKey("failures");

        // Four failures leave the allowance intact…
        for (let i = 1; i <= 4; i++) {
            expect(rateLimiters.login.recordFailure(key)).toBe(i);
            expect(rateLimiters.login.check(key).allowed).toBe(true);
        }

        // …and the fifth exhausts it, which is exactly "five failures per fifteen
        // minutes": a fifth wrong password is answered by the limiter, not by bcrypt.
        expect(rateLimiters.login.recordFailure(key)).toBe(5);
        expect(rateLimiters.login.check(key).allowed).toBe(false);
        expect(rateLimiters.login.check(key).remaining).toBe(0);
    });

    it("refuses the sixth verification and reports when to retry", () => {
        const key = uniqueKey("sixth");

        for (let i = 0; i < 5; i++) {
            rateLimiters.login.recordFailure(key);
        }

        const refused = rateLimiters.login.check(key);

        expect(refused.allowed).toBe(false);
        expect(refused.remaining).toBe(0);
        expect(refused.retryAfterMs).toBeGreaterThan(0);
        expect(refused.retryAfterMs).toBeLessThanOrEqual(15 * 60 * 1000);
    });

    it("a refused check does not extend or reset the lockout", () => {
        const key = uniqueKey("stable");

        for (let i = 0; i < 5; i++) {
            rateLimiters.login.recordFailure(key);
        }

        const first = rateLimiters.login.check(key);
        const second = rateLimiters.login.check(key);

        // The window is fixed, so retrying cannot push the unlock further away — which is
        // the property that makes a retry loop harmless rather than self-perpetuating.
        expect(second.allowed).toBe(false);
        expect(second.retryAfterMs).toBeLessThanOrEqual(first.retryAfterMs);
    });

    it("keeps one bucket per client key", () => {
        const attacked = uniqueKey("attacked");
        const innocent = uniqueKey("innocent");

        for (let i = 0; i < 5; i++) {
            rateLimiters.login.recordFailure(attacked);
        }

        expect(rateLimiters.login.check(attacked).allowed).toBe(false);
        expect(rateLimiters.login.check(innocent).allowed).toBe(true);
        expect(rateLimiters.login.check(innocent).remaining).toBe(5);
    });

    it("namespaces its bucket, so a raw key cannot collide with another limiter", () => {
        const key = uniqueKey("namespaced");

        expect(checkRateLimit(`login:${key}`, 5, 15 * 60 * 1000).remaining).toBe(4);
        expect(peekRateLimit(`login:${key}`, 5, 15 * 60 * 1000).remaining).toBe(4);
    });

    it("keeps the request-counting primitive intact for the buckets that need it", () => {
        // The other buckets (upload, payment creation, registration) still count REQUESTS,
        // and their semantics must not have drifted while the login bucket changed shape.
        const key = uniqueKey("primitive");

        expect(checkRateLimit(key, 3, 60_000).remaining).toBe(2);
        expect(checkRateLimit(key, 3, 60_000).remaining).toBe(1);
        expect(checkRateLimit(key, 3, 60_000).remaining).toBe(0);
        expect(checkRateLimit(key, 3, 60_000).allowed).toBe(false);

        // …and the recorder is not wired into it: recording is an explicit, separate act
        // on its own key, counting up from one.
        const recorded = uniqueKey("recorded");

        expect(recordRateLimitFailure(recorded, 60_000)).toBe(1);
        expect(recordRateLimitFailure(recorded, 60_000)).toBe(2);
    });
});

/* ==================================================================================
 * 3. WIRING — WHAT `authorize()` ACTUALLY CALLS
 * ================================================================================== */

describe("auth.ts charges the right event and no other", () => {
    const code = readCode("auth.ts");

    it("resolves its bucket with clientRateLimitKey, not getClientIp", () => {
        expect(code).toContain("clientRateLimitKey(request)");
        expect(code).not.toContain("getClientIp");
    });

    it("probes the allowance and records only failures", () => {
        expect(code).toContain("rateLimiters.login.check(loginKey)");
        expect(code).toContain("rateLimiters.login.recordFailure(loginKey)");

        // The old single-call shape consumed on the request; it must not return.
        expect(code).not.toMatch(/rateLimiters\.login\(/);
    });

    it("records exactly three failures — unknown user, no password, wrong password", () => {
        const recordings = code.match(/rateLimiters\.login\.recordFailure\(/g) ?? [];

        expect(recordings.length).toBe(3);
        expect(code).toContain("if (!user) {");
        expect(code).toContain("if (!user.password) {");
        expect(code).toContain("if (!valid) {");
    });

    it("returns null — without charging the allowance — for missing credentials", () => {
        const missing = code.slice(
            code.indexOf("!credentials?.identifier"),
            code.indexOf("const identifier =")
        );

        expect(missing).toContain("return null");
        expect(missing).not.toContain("recordFailure");
    });

    it("does not charge the allowance on the success path", () => {
        const tail = code.slice(code.indexOf("if (!valid) {"));

        const recordedAt = tail.indexOf("recordFailure");
        const successAt = tail.indexOf("return {");

        // Only the failure branch records, and the `return {` that authorizes a session
        // comes after it with no recorder between the two or beyond it. (No newline is
        // matched here: this file is CRLF.)
        expect(recordedAt).toBeGreaterThan(-1);
        expect(successAt).toBeGreaterThan(recordedAt);
        expect(tail.slice(successAt)).not.toContain("recordFailure");
    });

    it("refuses a throttled sign-in with a code the browser can read", () => {
        expect(code).toContain("class LoginRateLimited extends CredentialsSignin");
        expect(code).toContain("code = LOGIN_RATE_LIMITED_CODE");
        expect(code).toContain("throw new LoginRateLimited()");

        // No literal duplication: the value exists once, in the shared module both the
        // server and the client import.
        expect(code).not.toContain('"rate_limited"');
        expect(LOGIN_RATE_LIMITED_CODE).toBe("rate_limited");
    });

    it("does not spend the allowance for the new refusal itself", () => {
        const refusal = code.slice(
            code.indexOf("if (!rateLimiters.login.check(loginKey).allowed)"),
            code.indexOf("credentials?.identifier")
        );

        // A refusal must not count as another failure: that would turn a fixed window into
        // a self-extending one.
        expect(refusal).toContain("throw new LoginRateLimited()");
        expect(refusal).not.toContain("recordFailure");
    });
});

describe("the register route uses the same bucket contract", () => {
    const code = readCode("app/api/auth/register/route.ts");

    it("resolves its bucket with clientRateLimitKey, not getClientIp", () => {
        expect(code).toContain("clientRateLimitKey(req)");
        expect(code).not.toContain("getClientIp");
    });

    it("answers a duplicate with the status the error registry assigns", () => {
        expect(code).toContain("statusForCode(ERROR_CODES.CONFLICT)");
        expect(code).not.toMatch(/code:\s*"CONFLICT"[\s\S]{0,80}status:\s*400/);
    });

    it("maps the raced unique violation onto the same response", () => {
        expect(code).toContain('=== "P2002"');
        expect(code).toContain("duplicateAccountResponse()");

        // The pre-check and the race handler must share one response builder, and the
        // race handler must run before the generic log so a benign duplicate is not
        // reported as an outage.
        expect(code.indexOf("isUniqueConstraintError(error)")).toBeLessThan(
            code.indexOf('console.error("REGISTER ERROR:"')
        );
    });

    it("still refuses a cross-origin mutation before the body is read (D-56)", () => {
        expect(code.indexOf("requireSameOrigin(req)")).toBeLessThan(
            code.indexOf("await req.json()")
        );
    });
});
