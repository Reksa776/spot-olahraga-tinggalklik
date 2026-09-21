/**
 * ==========================================
 * PHASE 11 — REGISTRATION ROUTE CONTRACT
 * ==========================================
 *
 * Regression coverage for two defects found during the Phase 11 audit of
 * `app/api/auth/register/route.ts`:
 *
 *   1. A malformed payload (`registerSchema.parse` throwing a `ZodError`) used to fall
 *      into the catch-all and be answered as HTTP 500 `{ message }` — a validation error
 *      reported as a server failure, and not on the platform's error envelope.
 *   2. The state-changing POST ran without the Phase 3 same-origin check (D-56) that
 *      every other mutation route applies.
 *
 * The test drives the real route handler with a real `Request`, so it asserts the
 * observable HTTP contract rather than an internal helper. Prisma, password hashing,
 * rate limiting and NextAuth are stubbed because the contract under test is the
 * request/response shape, not persistence.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/prisma", () => ({
    prisma: {
        user: {
            findFirst: jest.fn(),
            create: jest.fn(),
        },
    },
}));

jest.mock("@/lib/password", () => ({
    hashPassword: jest.fn(async (password: string) => `hashed:${password}`),
}));

// Phase 27A: the route resolves its bucket with `clientRateLimitKey`, not `getClientIp`.
// A server with no trustworthy peer address (a dev run without a reverse proxy) must not
// collapse every client into the production "untrusted" sentinel — see lib/rate-limit.ts.
jest.mock("@/lib/rate-limit", () => ({
    clientRateLimitKey: jest.fn(() => "test-client"),
    rateLimiters: {
        register: jest.fn(() => ({ allowed: true, retryAfterMs: 0 })),
    },
}));

import { POST } from "@/app/api/auth/register/route";
import { statusForCode } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";

const ORIGIN = "http://localhost:3000";

/** The one response a duplicate account may produce, whatever detected it. */
const DUPLICATE_RESPONSE = {
    success: false,
    code: "CONFLICT",
    message: "Email atau nomor HP sudah digunakan.",
};

const VALID = {
    name: "Budi Santoso",
    email: "budi@example.test",
    phone: "",
    password: "Password1",
    confirmPassword: "Password1",
};

function post(
    body: unknown,
    options: {
        origin?: string | null;
        referer?: string | null;
        host?: string | null;
        url?: string;
    } = {}
): Request {
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };

    const origin = options.origin === undefined ? ORIGIN : options.origin;

    if (origin !== null) {
        headers.origin = origin;
    }

    const referer = options.referer === undefined ? null : options.referer;

    if (referer !== null) {
        headers.referer = referer;
    }

    const host = options.host === undefined ? null : options.host;

    if (host !== null) {
        headers.host = host;
    }

    return new Request(
        options.url ?? `${ORIGIN}/api/auth/register`,
        {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        }
    );
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue({
        id: "user_1",
        name: VALID.name,
        email: VALID.email,
        phone: null,
    });

    // The 500 path logs; the suite asserts on that log, so it is captured rather than
    // printed, and restored so nothing leaks into another suite's output.
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    consoleError.mockRestore();
});

describe("POST /api/auth/register", () => {
    it("creates an account for a valid same-origin payload", async () => {
        const response = await POST(post(VALID));

        expect(response.status).toBe(201);

        const body = await response.json();

        expect(body.success).toBe(true);
        expect(body.user.id).toBe("user_1");
        expect(prisma.user.create).toHaveBeenCalledTimes(1);
    });

    it("rejects a weak password with 400 VALIDATION_ERROR, not 500", async () => {
        const response = await POST(
            post({ ...VALID, password: "password", confirmPassword: "password" })
        );

        expect(response.status).toBe(400);

        const body = await response.json();

        expect(body.success).toBe(false);
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(Array.isArray(body.details.fields)).toBe(true);
        expect(body.details.fields.length).toBeGreaterThan(0);

        // The 500 path must not be reachable for a validation failure.
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("rejects a password mismatch with 400", async () => {
        const response = await POST(
            post({ ...VALID, confirmPassword: "Password2" })
        );

        expect(response.status).toBe(400);

        const body = await response.json();

        expect(body.code).toBe("VALIDATION_ERROR");
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("rejects a payload with neither email nor phone with 400", async () => {
        const response = await POST(
            post({ ...VALID, email: "", phone: "" })
        );

        expect(response.status).toBe(400);

        const body = await response.json();

        expect(body.code).toBe("VALIDATION_ERROR");
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("reports a duplicate account as 409 CONFLICT", async () => {
        (prisma.user.findFirst as jest.Mock).mockResolvedValue({
            id: "existing",
        });

        const response = await POST(post(VALID));

        /*
         * 409, because that is the status the platform's own registry assigns to this
         * code (`lib/api/errors.ts`: `CONFLICT: 409`). The route used to answer 400 while
         * sending code `CONFLICT`, so a client branching on the code and one branching on
         * the status disagreed about the same response.
         */
        expect(response.status).toBe(409);
        expect(statusForCode("CONFLICT")).toBe(409);

        const body = await response.json();

        expect(body).toEqual(DUPLICATE_RESPONSE);
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("maps a raced duplicate (Prisma P2002) to the same 409, not a 500", async () => {
        /*
         * The `findFirst` pre-check has no lock, so two concurrent registrations for one
         * email both pass it and the loser hits the unique index. Prisma reports that as
         * P2002; the route used to fall into the catch-all and answer 500 for what is
         * really the same duplicate account.
         */
        (prisma.user.create as jest.Mock).mockRejectedValue(
            Object.assign(
                new Error("Unique constraint failed on the fields: (`email`)"),
                {
                    name: "PrismaClientKnownRequestError",
                    code: "P2002",
                    meta: { target: ["email"] },
                    clientVersion: "6.19.1",
                }
            )
        );

        const response = await POST(post(VALID));
        const body = await response.json();

        expect(response.status).toBe(409);

        /*
         * The SAME object the pre-check test asserts. Comparing both paths against one
         * shared constant is what makes "a client cannot tell which ran" true by
         * construction rather than by reading the two literals.
         */
        expect(body).toEqual(DUPLICATE_RESPONSE);

        // Nothing about Prisma reaches the client.
        const serialised = JSON.stringify(body);

        expect(serialised).not.toContain("P2002");
        expect(serialised).not.toContain("Unique constraint");
        expect(serialised).not.toContain("clientVersion");
        expect(serialised).not.toContain("PrismaClientKnownRequestError");

        // …and an expected race is not logged as an outage.
        expect(consoleError).not.toHaveBeenCalled();
    });

    it("still answers an unexpected database failure with 500 INTERNAL_ERROR", async () => {
        (prisma.user.create as jest.Mock).mockRejectedValue(
            new Error("connect ECONNREFUSED 127.0.0.1:3306")
        );

        const response = await POST(post(VALID));
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body.code).toBe("INTERNAL_ERROR");

        // Sanitised: the driver's message is not the client's business.
        expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");

        // …but it IS logged, for the operator.
        expect(consoleError).toHaveBeenCalled();
    });

    it("refuses a cross-origin mutation with 403 before touching the database", async () => {
        const response = await POST(
            post(VALID, { origin: "https://evil.example" })
        );

        expect(response.status).toBe(403);
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("refuses a mutation with no Origin/Referer at all (fail closed)", async () => {
        const response = await POST(post(VALID, { origin: null }));

        expect(response.status).toBe(403);
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    /*
     * PHASE 27G — the 403 root cause. `request.url` inside a self-hosted Next.js
     * server is built from the server's BIND hostname+port
     * (node_modules/next/dist/server/next-server.js, attachRequestMeta:
     * `initUrl = protocol://fetchHostname:port + req.url`), so on a server bound to
     * `0.0.0.0` / `127.0.0.1` / a LAN IP the URL host can never equal a browser
     * Origin. The expected host MUST come from the request's own `Host` header —
     * the host the browser actually addressed — or every legitimate same-origin
     * POST is rejected as FORBIDDEN.
     */
    it.each([
        [
            "LAN-bound server (0.0.0.0) reached via its IP",
            "100.88.79.104:3000",
            "http://100.88.79.104:3000",
            "http://0.0.0.0:3000/api/auth/register",
        ],
        [
            "wildcard-bound server reached via localhost",
            "localhost:3000",
            "http://localhost:3000",
            "http://0.0.0.0:3000/api/auth/register",
        ],
        [
            "loopback-bound server behind a reverse proxy",
            "tinggalklik.co",
            "https://tinggalklik.co",
            "http://127.0.0.1:3000/api/auth/register",
        ],
    ])(
        "accepts a same-origin POST when the Host header matches the Origin, even though request.url names the bind address (%s)",
        async (_scenario, host, origin, url) => {
            const response = await POST(post(VALID, { host, origin, url }));

            expect(response.status).toBe(201);
            expect(prisma.user.create).toHaveBeenCalledTimes(1);
        }
    );

    it("still refuses a cross-origin POST even when the request carries a Host header", async () => {
        const response = await POST(
            post(VALID, { host: "localhost:3000", origin: "https://evil.example" })
        );

        expect(response.status).toBe(403);
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("accepts a same-origin POST identified by Referer when Origin is absent", async () => {
        const response = await POST(
            post(VALID, {
                origin: null,
                referer: "http://localhost:3000/register",
            })
        );

        expect(response.status).toBe(201);
        expect(prisma.user.create).toHaveBeenCalledTimes(1);
    });
});
