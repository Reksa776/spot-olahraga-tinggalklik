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

jest.mock("@/lib/rate-limit", () => ({
    getClientIp: jest.fn(() => "test-ip"),
    rateLimiters: {
        register: jest.fn(() => ({ allowed: true, retryAfterMs: 0 })),
    },
}));

import { POST } from "@/app/api/auth/register/route";
import { prisma } from "@/lib/prisma";

const ORIGIN = "http://localhost:3000";

const VALID = {
    name: "Budi Santoso",
    email: "budi@example.test",
    phone: "",
    password: "Password1",
    confirmPassword: "Password1",
};

function post(
    body: unknown,
    options: { origin?: string | null; url?: string } = {}
): Request {
    const headers: Record<string, string> = {
        "content-type": "application/json",
    };

    const origin = options.origin === undefined ? ORIGIN : options.origin;

    if (origin !== null) {
        headers.origin = origin;
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

beforeEach(() => {
    jest.clearAllMocks();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue({
        id: "user_1",
        name: VALID.name,
        email: VALID.email,
        phone: null,
    });
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

    it("reports a duplicate account as 400 CONFLICT", async () => {
        (prisma.user.findFirst as jest.Mock).mockResolvedValue({
            id: "existing",
        });

        const response = await POST(post(VALID));

        expect(response.status).toBe(400);

        const body = await response.json();

        expect(body.code).toBe("CONFLICT");
        expect(prisma.user.create).not.toHaveBeenCalled();
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
});
