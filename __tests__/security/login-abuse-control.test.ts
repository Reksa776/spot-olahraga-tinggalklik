/**
 * ==========================================
 * F-02 / F-03 — PROXY TRUST AND LOGIN ABUSE CONTROL
 * ==========================================
 *
 * Two audit findings, both about the same limiter, both pinned here from the outside:
 *
 *   F-02  `TRUSTED_PROXY` was read by TRUTHINESS. Every non-empty string enabled proxy
 *         trust, including the values an operator would write to switch it off — `false`,
 *         `no`, `0`, `off` — and junk like `nginx` or `yes`. The first client-supplied
 *         `x-forwarded-for` then became the rate-limit bucket key, so rotating that header
 *         bought a fresh login allowance per request.
 *
 *   F-03  With no valid configuration every anonymous client shared the key `"untrusted"`,
 *         and a hard refusal on that key meant five wrong passwords from one stranger
 *         stopped EVERYBODY from signing in. Raising the number would only have made the
 *         lockout more expensive; removing the limiter would have removed the protection.
 *
 * WHAT IS ASSERTED, AND WHY IN THIS ORDER
 * ---------------------------------------
 * Sections 1–3 are the F-02 contract (what enables trust, what fails closed, what a
 * spoofed header can and cannot do). Sections 4–7 are the F-03 contract: the per-client
 * refusal still exists when there IS a client, the per-identifier and platform-wide
 * controls are BOUNDED DELAYS that can never deny anybody, and nothing in the accounting
 * can reveal whether an account exists.
 *
 * The one piece of shared state these tests must respect is the platform-wide window: it
 * cannot be reset from outside, so the tests that charge it run after the tests that assert
 * it is quiet, and the file charges it exactly once.
 */

import {
    clientRateLimitKey,
    getClientIp,
    hasTrustworthyClientKey,
    loginAccountKey,
    loginAccountThrottleMs,
    loginGlobalThrottleMs,
    normaliseProxyEntry,
    parseTrustedProxy,
    peekRateLimit,
    rateLimitStoreSize,
    recordLoginAccountFailure,
    recordLoginGlobalFailure,
    clearLoginAccountFailures,
    rateLimiters,
} from "@/lib/rate-limit";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/* ==================================================================================
 * HARNESS
 * ================================================================================== */

function credentialsRequest(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost:3000/api/auth/callback/credentials", {
        method: "POST",
        headers,
    });
}

const ORIGINAL = {
    TRUSTED_PROXY: process.env.TRUSTED_PROXY,
    NODE_ENV: process.env.NODE_ENV,
};

/** `NODE_ENV` is `readonly` in next-env.d.ts; the cast is how a test asserts what prod does. */
function setEnv(name: string, value: string): void {
    (process.env as Record<string, string>)[name] = value;
}

function restore(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    setEnv(name, value);
}

/**
 * The invalid-configuration paths warn on purpose, so the whole file listens instead of
 * letting a hundred warnings reach the test output. Counting is unaffected: a spy records
 * every call it swallows.
 */
const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

afterAll(() => {
    warnSpy.mockRestore();
});

afterEach(() => {
    // Both variables are read at CALL time, never captured at import, which is the only
    // reason one process can assert production and development behaviour side by side.
    restore("TRUSTED_PROXY", ORIGINAL.TRUSTED_PROXY);
    restore("NODE_ENV", ORIGINAL.NODE_ENV);
});

let counter = 0;

/** A fresh identifier per test, so one test's account failures can never be another's. */
function uniqueIdentifier(label: string): string {
    counter += 1;
    return `${label}-${counter}@example.test`;
}

/** The values that used to enable proxy trust and must no longer. */
const NOT_AN_ADDRESS = [
    "true",
    "false",
    "yes",
    "no",
    "off",
    "on",
    "0",
    "1",
    "nginx",
    "*",
    "all",
    "0.0.0.0/0",
    "::/0",
    "localhost",
    "127.0.0.1:8080",
    "  ",
];

/* ==================================================================================
 * 1. F-02 — WHAT ENABLES PROXY TRUST
 * ================================================================================== */

describe("F-02: TRUSTED_PROXY is parsed, never tested for truthiness", () => {
    it("treats unset, empty and whitespace-only as 'no configuration'", () => {
        expect(parseTrustedProxy(undefined)).toBeNull();
        expect(parseTrustedProxy(null)).toBeNull();
        expect(parseTrustedProxy("")).toBeNull();
        expect(parseTrustedProxy("   ")).toBeNull();
    });

    it("accepts a single IPv4 address", () => {
        expect(parseTrustedProxy("10.0.0.1")).toEqual(["10.0.0.1"]);
        expect(parseTrustedProxy("  10.0.0.1  ")).toEqual(["10.0.0.1"]);
    });

    it("accepts an IPv6 address, bare or bracketed, and loopback", () => {
        expect(parseTrustedProxy("::1")).toEqual(["::1"]);
        expect(parseTrustedProxy("[::1]")).toEqual(["::1"]);
        expect(parseTrustedProxy("2001:db8::4")).toEqual(["2001:db8::4"]);
    });

    it("accepts CIDR blocks within the family's width", () => {
        expect(parseTrustedProxy("10.0.0.0/8")).toEqual(["10.0.0.0/8"]);
        expect(parseTrustedProxy("172.16.0.0/12")).toEqual(["172.16.0.0/12"]);
        expect(parseTrustedProxy("192.168.1.0/24")).toEqual(["192.168.1.0/24"]);
        expect(parseTrustedProxy("2001:db8::/32")).toEqual(["2001:db8::/32"]);
        expect(parseTrustedProxy("10.0.0.1/32")).toEqual(["10.0.0.1/32"]);
    });

    it("accepts a comma-separated list", () => {
        expect(parseTrustedProxy("127.0.0.1, ::1")).toEqual([
            "127.0.0.1",
            "::1",
        ]);
        expect(parseTrustedProxy("10.0.0.0/8,172.16.0.0/12")).toEqual([
            "10.0.0.0/8",
            "172.16.0.0/12",
        ]);
    });

    it("rejects every truthy value that is not an address — the F-02 regression", () => {
        for (const value of NOT_AN_ADDRESS) {
            expect(parseTrustedProxy(value)).toBeNull();
            expect(normaliseProxyEntry(value.trim())).toBeNull();
        }
    });

    it("rejects an out-of-range octet, an over-wide prefix and a wildcard", () => {
        for (const value of [
            "10.0.0.256",
            "999.1.1.1",
            "10.0.0.0/33",
            "::1/129",
            "10.0.0.0/-1",
            "10.0.0.0/8/8",
            "10.0.0.1:8080",
            "http://10.0.0.1",
            "::::",
            "1:2:3:4:5:6:7:8:9",
        ]) {
            expect(normaliseProxyEntry(value)).toBeNull();
        }
    });

    it("invalidates the WHOLE list when one member is malformed", () => {
        // A typo must not quietly reduce the set the operator believes they configured.
        expect(parseTrustedProxy("10.0.0.1, nginx")).toBeNull();
        expect(parseTrustedProxy("10.0.0.1, false")).toBeNull();
        expect(parseTrustedProxy("10.0.0.1,,10.0.0.2")).toEqual([
            "10.0.0.1",
            "10.0.0.2",
        ]);
    });
});

/* ==================================================================================
 * 2. F-02 — WHAT A SPOOFED HEADER CAN AND CANNOT DO
 * ================================================================================== */

describe("F-02: forwarded headers behind a validated configuration", () => {
    beforeEach(() => {
        setEnv("NODE_ENV", "production");
    });

    it("ignores both headers when nothing valid is configured", () => {
        delete process.env.TRUSTED_PROXY;

        const headerSets: Record<string, string>[] = [
            { "x-forwarded-for": "1.2.3.4" },
            { "x-forwarded-for": "1.2.3.4, 10.0.0.1" },
            { "x-real-ip": "5.6.7.8" },
            { "x-forwarded-for": "1.2.3.4", "x-real-ip": "5.6.7.8" },
            {},
        ];

        for (const header of headerSets) {
            expect(getClientIp(credentialsRequest(header))).toBe("untrusted");
        }
    });

    it("ignores both headers for every invalid configuration (F-02)", () => {
        for (const value of NOT_AN_ADDRESS) {
            setEnv("TRUSTED_PROXY", value);

            expect(
                getClientIp(
                    credentialsRequest({
                        "x-forwarded-for": "1.2.3.4",
                        "x-real-ip": "5.6.7.8",
                    })
                )
            ).toBe("untrusted");
        }
    });

    it("uses the first forwarded address once the configuration is valid", () => {
        setEnv("TRUSTED_PROXY", "10.0.0.1");

        expect(
            getClientIp(
                credentialsRequest({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })
            )
        ).toBe("203.0.113.7");
    });

    it("falls back to x-real-ip, and to the sentinel with no header at all", () => {
        setEnv("TRUSTED_PROXY", "10.0.0.1");

        expect(getClientIp(credentialsRequest({ "x-real-ip": "203.0.113.9" }))).toBe(
            "203.0.113.9"
        );

        // A configured proxy that sent neither header leaves no client identity: the
        // fail-closed answer is the shared sentinel, never a client-supplied guess.
        expect(getClientIp(credentialsRequest())).toBe("untrusted");
    });

    it("discards a forwarded value that is not an address instead of keying on it", () => {
        setEnv("TRUSTED_PROXY", "10.0.0.1");

        for (const junk of [
            "not-an-ip",
            "<script>alert(1)</script>",
            "1.2.3.4; DROP TABLE",
            "  ",
            "0.0.0.0.0",
            "10.0.0.1:8080",
        ]) {
            // Falling back to nothing is the point: before F-02 this string became a
            // bucket key, and an attacker who could choose it could rotate buckets.
            expect(getClientIp(credentialsRequest({ "x-forwarded-for": junk }))).toBe(
                "untrusted"
            );
        }
    });

    it("supports IPv6 clients", () => {
        setEnv("TRUSTED_PROXY", "::1");

        expect(
            getClientIp(credentialsRequest({ "x-forwarded-for": "2001:db8::5" }))
        ).toBe("2001:db8::5");

        expect(
            getClientIp(credentialsRequest({ "x-forwarded-for": "[2001:db8::6]" }))
        ).toBe("2001:db8::6");
    });

    it("warns ONCE per distinct invalid value, and never for a valid one", () => {
        const invalidValue = `not-an-address-${++counter}`;

        setEnv("TRUSTED_PROXY", invalidValue);

        const before = warnSpy.mock.calls.length;

        getClientIp(credentialsRequest({ "x-forwarded-for": "1.2.3.4" }));
        getClientIp(credentialsRequest({ "x-forwarded-for": "5.6.7.8" }));

        // A request loop must not be able to flood the log with configuration warnings.
        expect(warnSpy.mock.calls.length - before).toBe(1);
        expect(String(warnSpy.mock.calls[before][0])).toContain("TRUSTED_PROXY");

        setEnv("TRUSTED_PROXY", "10.0.0.1");

        const quiet = warnSpy.mock.calls.length;

        getClientIp(credentialsRequest({ "x-forwarded-for": "1.2.3.4" }));

        expect(warnSpy.mock.calls.length - quiet).toBe(0);
    });
});

/* ==================================================================================
 * 3. F-02/F-03 — THE BUCKET KEY, PER ENVIRONMENT
 * ================================================================================== */

describe("the login bucket key with a trustworthy proxy", () => {
    it("production: a valid address and a forwarded IP yield that IP", () => {
        setEnv("NODE_ENV", "production");
        setEnv("TRUSTED_PROXY", "10.0.0.0/8");

        const request = credentialsRequest({
            "x-forwarded-for": "203.0.113.7, 10.0.0.1",
        });

        expect(clientRateLimitKey(request)).toBe("203.0.113.7");
        expect(hasTrustworthyClientKey(request)).toBe(true);
    });

    it("production: no valid configuration yields the shared sentinel, and NO client identity", () => {
        setEnv("NODE_ENV", "production");
        delete process.env.TRUSTED_PROXY;

        const request = credentialsRequest({ "x-forwarded-for": "203.0.113.7" });

        expect(clientRateLimitKey(request)).toBe("untrusted");
        expect(hasTrustworthyClientKey(request)).toBe(false);
    });

    it("production: a truthy-but-invalid value yields no client identity either (F-02)", () => {
        setEnv("NODE_ENV", "production");

        for (const value of ["1", "true", "false", "no", "nginx"]) {
            setEnv("TRUSTED_PROXY", value);

            const request = credentialsRequest({ "x-forwarded-for": "1.2.3.4" });

            expect(clientRateLimitKey(request)).toBe("untrusted");
            expect(hasTrustworthyClientKey(request)).toBe(false);
        }
    });

    it("development: the labelled bucket keeps per-client behaviour (unchanged)", () => {
        setEnv("NODE_ENV", "development");
        delete process.env.TRUSTED_PROXY;

        const a = credentialsRequest({ "x-forwarded-for": "10.1.1.1" });
        const b = credentialsRequest({ "x-forwarded-for": "10.1.1.2" });

        // The old behaviour, asserted rather than assumed: a dev server has no trustworthy
        // peer address, so both browsers share one labelled bucket — and that bucket IS a
        // client identity as far as the refusal is concerned.
        expect(clientRateLimitKey(a)).toBe("dev-local");
        expect(clientRateLimitKey(b)).toBe("dev-local");
        expect(hasTrustworthyClientKey(a)).toBe(true);
    });
});

/* ==================================================================================
 * 4. F-03 — THE PER-CLIENT REFUSAL IS UNCHANGED WHEN THERE IS A CLIENT
 * ================================================================================== */

describe("F-03: the per-client allowance still exists — five failures, fifteen minutes", () => {
    it("keeps the D-53 numbers", () => {
        expect(rateLimiters.login.maxFailures).toBe(5);
        expect(rateLimiters.login.windowMs).toBe(15 * 60 * 1000);
    });

    it("five failures from one attacker exhaust only that attacker's bucket", () => {
        const attacker = `attacker-${++counter}`;
        const other = `other-${++counter}`;

        for (let i = 0; i < 5; i++) {
            expect(rateLimiters.login.recordFailure(attacker)).toBe(i + 1);
        }

        expect(rateLimiters.login.check(attacker).allowed).toBe(false);

        // …and an unrelated client is untouched: one attacker cannot spend anybody else's
        // allowance. This is the property F-03 destroyed when every client shared a key.
        expect(rateLimiters.login.check(other).allowed).toBe(true);
        expect(rateLimiters.login.check(other).remaining).toBe(5);
    });

    it("failures from several unrelated clients stay independent", () => {
        const clients = [1, 2, 3].map((n) => `client-${n}-${++counter}`);

        for (const [index, key] of clients.entries()) {
            for (let i = 0; i < index + 1; i++) {
                rateLimiters.login.recordFailure(key);
            }
        }

        expect(rateLimiters.login.check(clients[0]).remaining).toBe(4);
        expect(rateLimiters.login.check(clients[1]).remaining).toBe(3);
        expect(rateLimiters.login.check(clients[2]).remaining).toBe(2);
    });

    it("the shared sentinel is never a per-client limit — that is what auth.ts acts on", () => {
        setEnv("NODE_ENV", "production");
        delete process.env.TRUSTED_PROXY;

        // The limiter itself is unchanged: a bucket built on the sentinel still counts and
        // still refuses. What changed is the CALLER: `hasTrustworthyClientKey` is false, so
        // `auth.ts` does not apply that refusal — see the assertion below and
        // `__tests__/security/phase27a-login-rate-limit.test.ts`, which pins the wiring.
        const sentinel = clientRateLimitKey(credentialsRequest());

        expect(sentinel).toBe("untrusted");
        expect(hasTrustworthyClientKey(credentialsRequest())).toBe(false);

        const authCode = readFileSync(resolve(process.cwd(), "auth.ts"), "utf-8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");

        expect(authCode).toContain("hasClientIdentity &&");
        expect(authCode).toContain("hasTrustworthyClientKey(request)");
    });
});

/* ==================================================================================
 * 5. F-03 — THE PER-ACCOUNT CONTROL IS A BOUNDED DELAY, NEVER A LOCKOUT
 * ================================================================================== */

describe("F-03: the per-identifier control", () => {
    it("costs nothing for the first five failures", () => {
        const key = loginAccountKey(uniqueIdentifier("free"));

        expect(loginAccountThrottleMs(key)).toBe(0);

        for (let i = 1; i <= 5; i++) {
            expect(recordLoginAccountFailure(key)).toBe(i);
        }

        expect(loginAccountThrottleMs(key)).toBe(0);
    });

    it("grows linearly after the free allowance and then stops at a ceiling", () => {
        const key = loginAccountKey(uniqueIdentifier("ramp"));

        for (let i = 0; i < 6; i++) {
            recordLoginAccountFailure(key);
        }

        expect(loginAccountThrottleMs(key)).toBe(150);

        recordLoginAccountFailure(key);

        expect(loginAccountThrottleMs(key)).toBe(300);

        for (let i = 0; i < 40; i++) {
            recordLoginAccountFailure(key);
        }

        // Bounded: a legitimate owner of a heavily-guessed account waits 1.5s, not minutes.
        expect(loginAccountThrottleMs(key)).toBe(1500);
    });

    it("NEVER refuses: there is no API that can answer 'account locked'", () => {
        const key = loginAccountKey(uniqueIdentifier("no-lockout"));

        for (let i = 0; i < 100; i++) {
            recordLoginAccountFailure(key);
        }

        // The only question the account control can be asked is "how long should this
        // attempt wait?", and the answer stays finite. Nothing here can deny a sign-in —
        // which is exactly why an attacker cannot lock an account by failing from
        // somewhere else (the audit's requirement C).
        expect(loginAccountThrottleMs(key)).toBeLessThanOrEqual(1500);
        expect(loginAccountThrottleMs(key)).toBeGreaterThan(0);

        // The account surface is a delay, a recorder and a clear — and no function that
        // returns a decision about the account (no `allowed`, no `locked`).
        expect(typeof rateLimiters.login.accountThrottleMs).toBe("function");
        expect(Object.keys(rateLimiters.login).sort()).toEqual([
            "accountKey",
            "accountThrottleMs",
            "check",
            "clearAccountFailures",
            "maxFailures",
            "recordAccountFailure",
            "recordFailure",
            "windowMs",
        ]);
    });

    it("a successful verification clears the throttle", () => {
        const key = loginAccountKey(uniqueIdentifier("cleared"));

        for (let i = 0; i < 8; i++) {
            recordLoginAccountFailure(key);
        }

        expect(loginAccountThrottleMs(key)).toBeGreaterThan(0);

        clearLoginAccountFailures(key);

        // The person who knows the password is not the attacker. This is the second reason
        // the control cannot lock an account out.
        expect(loginAccountThrottleMs(key)).toBe(0);
    });

    it("keeps one bucket per identifier, independent of the others", () => {
        const attacked = loginAccountKey(uniqueIdentifier("attacked"));
        const innocent = loginAccountKey(uniqueIdentifier("innocent"));

        for (let i = 0; i < 10; i++) {
            recordLoginAccountFailure(attacked);
        }

        expect(loginAccountThrottleMs(attacked)).toBeGreaterThan(0);
        expect(loginAccountThrottleMs(innocent)).toBe(0);
    });

    it("windows the failures: the delay is not permanent", () => {
        const key = loginAccountKey(uniqueIdentifier("window"));

        recordLoginAccountFailure(key);

        // The window is the same fifteen minutes the per-client allowance uses, and it is
        // the window — not the attempt count — that expires it. Asserted through the
        // exported shape rather than by waiting fifteen minutes.
        expect(rateLimiters.login.windowMs).toBe(15 * 60 * 1000);

        const peek = peekRateLimit(`login-account:${key}`, 5, 15 * 60 * 1000);

        expect(peek.remaining).toBe(4);
    });
});

/* ==================================================================================
 * 6. F-03 — THE PLATFORM-WIDE SAFEGUARD SLOWS, IT DOES NOT REFUSE
 * ================================================================================== */

describe("F-03: the platform-wide safeguard", () => {
    it("is quiet for a handful of failures — five from one client change nothing", () => {
        const key = `one-client-${++counter}`;

        for (let i = 0; i < 5; i++) {
            rateLimiters.login.recordFailure(key);
        }

        // THE F-03 REGRESSION, ASSERTED DIRECTLY: five failures cannot make sign-in slower
        // for everyone, let alone lock them out.
        expect(loginGlobalThrottleMs()).toBe(0);
    });

    it("stays quiet just below its threshold", () => {
        // Charging the shared window is one-way within a process, so this test runs before
        // the one below and charges a known, small amount.
        expect(loginGlobalThrottleMs()).toBe(0);

        for (let i = 0; i < 5; i++) {
            recordLoginGlobalFailure();
        }

        expect(loginGlobalThrottleMs()).toBe(0);
    });

    it("slows every sign-in once the window is genuinely flooded — and still never refuses", () => {
        // Bounded by the threshold the implementation declares: the loop stops as soon as
        // the safeguard engages, so a regression that never engages fails on the assertion
        // below rather than hanging the suite.
        for (let i = 0; i < 1_000 && loginGlobalThrottleMs() === 0; i++) {
            recordLoginGlobalFailure();
        }

        const delay = loginGlobalThrottleMs();

        expect(delay).toBeGreaterThan(0);
        expect(delay).toBeLessThanOrEqual(1000);

        // No matter how large the flood, the answer is a bounded wait. A REFUSING cap here
        // would be F-03 again at a bigger threshold: an attacker who can drive the counter
        // would be able to stop everyone from signing in.
        for (let i = 0; i < 5_000; i++) {
            recordLoginGlobalFailure();
        }

        expect(loginGlobalThrottleMs()).toBeLessThanOrEqual(1000);

        // …and it cannot be reached by one client, because a client with an identity is
        // refused after five failures and therefore cannot charge the platform window at
        // all beyond those five.
        expect(rateLimiters.login.maxFailures).toBe(5);
    });
});

/* ==================================================================================
 * 7. F-03 — NO ENUMERATION, NO UNBOUNDED MEMORY, NO CONCURRENCY LOSS
 * ================================================================================== */

describe("F-03: the accounting cannot reveal an account or exhaust the process", () => {
    it("keys an identifier to an HMAC that contains nothing of the identifier", () => {
        const identifier = "Someone@Example.test";
        const key = loginAccountKey(identifier);

        expect(key).toMatch(/^[0-9a-f]{24}$/);
        expect(key.toLowerCase()).not.toContain("someone");
        expect(key.toLowerCase()).not.toContain("example");
        expect(key).not.toContain("@");
    });

    it("normalises case and whitespace, so case cannot multiply an allowance", () => {
        expect(loginAccountKey("  User@Example.test  ")).toBe(
            loginAccountKey("user@example.test")
        );
        expect(loginAccountKey("USER@EXAMPLE.TEST")).toBe(
            loginAccountKey("user@example.test")
        );
    });

    it("gives different identifiers different buckets", () => {
        const keys = new Set(
            [
                "a@example.test",
                "b@example.test",
                "08123456789",
                "08234567890",
            ].map((identifier) => loginAccountKey(identifier))
        );

        expect(keys.size).toBe(4);
    });

    it("charges an identifier that does not exist EXACTLY like one that does", () => {
        /*
         * The limiter has no way to know whether an account exists: it never queries the
         * database. That is the structural half of the enumeration guarantee — the other
         * half is that all four refusal paths in `auth.ts` charge the same counters, which
         * `phase27a-login-rate-limit.test.ts` pins.
         */
        const source = readFileSync(resolve(process.cwd(), "lib/rate-limit.ts"), "utf-8");

        expect(source).not.toContain("@/lib/prisma");
        expect(source).not.toMatch(/\bprisma\b/);
        expect(source).not.toContain("findFirst");
        expect(source).not.toContain("findUnique");

        const invented = loginAccountKey(uniqueIdentifier("definitely-not-real"));
        const real = loginAccountKey(uniqueIdentifier("known"));

        for (let i = 0; i < 9; i++) {
            recordLoginAccountFailure(invented);
            recordLoginAccountFailure(real);
        }

        expect(loginAccountThrottleMs(invented)).toBe(loginAccountThrottleMs(real));
    });

    it("produces no account-specific error surface", () => {
        const messages = readFileSync(
            resolve(process.cwd(), "lib/auth/sign-in-failure.ts"),
            "utf-8"
        ).toLowerCase();

        // Nothing a visitor reads may name an account state. (The message contract itself
        // is pinned in __tests__/auth-flow/sign-in-failure.test.ts; this is the F-03 half:
        // the throttle must not have introduced a new sentence.)
        for (const phrase of [
            "terkunci",
            "diblokir",
            "percobaan gagal",
            "akun tidak ditemukan",
            "tidak terdaftar",
        ]) {
            expect(messages).not.toContain(phrase);
        }
    });

    it("counts concurrent failures exactly once each", async () => {
        const key = loginAccountKey(uniqueIdentifier("concurrent"));

        const results = await Promise.all(
            Array.from({ length: 25 }, () =>
                Promise.resolve(recordLoginAccountFailure(key))
            )
        );

        // No lost updates: the window ends at exactly the number of failures recorded.
        expect(new Set(results).size).toBe(25);
        expect(Math.max(...results)).toBe(25);
        expect(recordLoginAccountFailure(key)).toBe(26);
    });

    it("bounds its memory under a flood of distinct keys", () => {
        const before = rateLimitStoreSize();

        // The account key is derived from an attacker-supplied identifier, so this is the
        // exact shape of a memory-exhaustion attempt against the limiter.
        for (let i = 0; i < 60_000; i++) {
            recordLoginAccountFailure(`flood-${i}`);
        }

        const after = rateLimitStoreSize();

        expect(after).toBeLessThanOrEqual(50_000); // MAX_STORE_ENTRIES
        expect(after).toBeLessThanOrEqual(before + 50_000);

        // Eviction can only FORGET failures (which loosens a limit), never invent one: a
        // fresh key still gets its full allowance.
        const fresh = loginAccountKey(uniqueIdentifier("after-flood"));

        expect(loginAccountThrottleMs(fresh)).toBe(0);
    });
});
