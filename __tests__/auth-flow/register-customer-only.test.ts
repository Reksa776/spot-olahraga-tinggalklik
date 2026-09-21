/**
 * ==========================================
 * PUBLIC REGISTRATION CREATES A CUSTOMER
 * ==========================================
 *
 * `/api/auth/register` is the application's only unauthenticated write into `User`, so it is
 * the only place where "can a stranger grant themselves a role?" is even a question. The
 * answer must be no, and it must stay no for the four roles the product actually has.
 *
 * The route is driven directly with a real `Request`, so this asserts the OBSERVABLE
 * contract — the arguments the database is handed — rather than an internal helper. Prisma,
 * hashing, rate limiting and the session are stubbed because persistence is not what is
 * under test; the payload the route builds is.
 *
 * The window shape of the assertions matters: `prisma.user.create` is inspected to prove the
 * created row is a CUSTOMER even when the request demanded ADMIN. A test that only checked
 * the HTTP status would pass just as happily on a route that stored `platformRole: "ADMIN"`.
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

// Phase 27A: the route resolves its bucket with `clientRateLimitKey`, not `getClientIp`,
// so a dev server without a reverse proxy does not collapse every client into the
// production "untrusted" sentinel. See lib/rate-limit.ts.
jest.mock("@/lib/rate-limit", () => ({
    clientRateLimitKey: jest.fn(() => "test-client"),
    rateLimiters: {
        register: jest.fn(() => ({ allowed: true, retryAfterMs: 0 })),
    },
}));

import { POST } from "@/app/api/auth/register/route";
import { prisma } from "@/lib/prisma";
import { registerSchema } from "@/lib/validations/register";

const ORIGIN = "http://localhost:3000";

const VALID = {
    name: "Budi Santoso",
    email: "budi@example.test",
    phone: "",
    password: "Password1",
    confirmPassword: "Password1",
};

function post(body: unknown): Request {
    return new Request(`${ORIGIN}/api/auth/register`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            origin: ORIGIN,
        },
        body: JSON.stringify(body),
    });
}

/** The `data` object handed to `prisma.user.create`. */
function createdData(): Record<string, unknown> {
    expect(prisma.user.create).toHaveBeenCalledTimes(1);

    const call = (prisma.user.create as jest.Mock).mock.calls[0][0] as {
        data: Record<string, unknown>;
    };

    return call.data;
}

let consoleWarn: jest.SpyInstance;

beforeEach(() => {
    jest.clearAllMocks();

    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (prisma.user.create as jest.Mock).mockResolvedValue({
        id: "user_1",
        name: VALID.name,
        email: VALID.email,
        phone: null,
    });

    consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
    consoleWarn.mockRestore();
});

/* ==================================================================================
 * 1. THE ROLE IS DECIDED BY THE SERVER
 * ================================================================================== */

describe("a public signup is always a CUSTOMER", () => {
    it("sets platformRole and role explicitly, not by column default", async () => {
        const response = await POST(post(VALID));

        expect(response.status).toBe(201);

        const data = createdData();

        expect(data.platformRole).toBe("CUSTOMER");
        expect(data.role).toBe("CUSTOMER");
    });

    it.each(["ADMIN", "MANAGER", "PIC"])(
        "ignores a request that asks for %s",
        async (wanted) => {
            const response = await POST(post({ ...VALID, platformRole: wanted }));

            expect(response.status).toBe(201);
            expect(createdData().platformRole).toBe("CUSTOMER");
        }
    );

    it("ignores every privilege-shaped key a client could try", async () => {
        await POST(
            post({
                ...VALID,
                platformRole: "ADMIN",
                role: "ADMIN",
                roles: ["ADMIN"],
                permissions: ["user.manage", "role.manage"],
                organizerId: "org_attacker",
                tenantId: "org_attacker",
                memberships: [{ organizerId: "org_attacker", role: "OWNER" }],
                isAdmin: true,
                grants: [{ permission: "role.manage" }],
                permissionGrants: [{ permission: "user.manage" }],
            })
        );

        const data = createdData();

        expect(data.platformRole).toBe("CUSTOMER");
        expect(data.role).toBe("CUSTOMER");

        // Nothing else from the body reached the row: the create payload is an allow-list of
        // five keys, and four of them come from the validated schema.
        expect(Object.keys(data).sort()).toEqual([
            "email",
            "name",
            "password",
            "phone",
            "platformRole",
            "role",
        ]);
    });

    it("records an attempt for the operator without recording any value", async () => {
        await POST(post({ ...VALID, platformRole: "ADMIN", permissions: ["role.manage"] }));

        const logged = consoleWarn.mock.calls.flat().join("\n");

        // The NAMES are reported…
        expect(logged).toContain("platformRole");
        expect(logged).toContain("permissions");

        // …and no value is, so the log cannot become a place to inject anything.
        expect(logged).not.toContain("ADMIN");
    });

    it("does not log anything for an ordinary signup", async () => {
        await POST(post(VALID));

        expect(consoleWarn).not.toHaveBeenCalled();
    });
});

/* ==================================================================================
 * 2. THE SCHEMA STRIPS UNKNOWN KEYS
 * ================================================================================== */

describe("the registration schema is an allow-list", () => {
    it("drops unknown keys rather than passing them through", () => {
        const parsed = registerSchema.parse({ ...VALID, platformRole: "ADMIN" });

        expect(Object.keys(parsed).sort()).toEqual([
            "confirmPassword",
            "email",
            "name",
            "password",
            "phone",
        ]);

        expect("platformRole" in parsed).toBe(false);
    });

    it("still enforces the password policy and the identifier rule", () => {
        expect(() =>
            registerSchema.parse({ ...VALID, password: "password", confirmPassword: "password" })
        ).toThrow();

        expect(() =>
            registerSchema.parse({ ...VALID, email: "", phone: "" })
        ).toThrow();
    });
});

/* ==================================================================================
 * 3. SELF-REGISTRATION IS UNCHANGED OTHERWISE (no weakened baseline)
 * ================================================================================== */

describe("the anti-abuse and validation behaviour is preserved", () => {
    it("still refuses without an Origin and touches nothing (D-56)", async () => {
        const response = await POST(
            new Request(`${ORIGIN}/api/auth/register`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(VALID),
            })
        );

        expect(response.status).toBe(403);
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("still reports a duplicate as a conflict — now with the registry's 409", async () => {
        (prisma.user.findFirst as jest.Mock).mockResolvedValue({ id: "existing" });

        const response = await POST(post(VALID));
        const payload = await response.json();

        // The status was 400 while the code was `CONFLICT`; the registry says 409. The
        // body is unchanged, so nothing a client already reads has moved.
        expect(response.status).toBe(409);
        expect(payload.code).toBe("CONFLICT");
        expect(payload.message).toBe("Email atau nomor HP sudah digunakan.");
        expect(prisma.user.create).not.toHaveBeenCalled();
    });

    it("still returns a validation error, with field details, for a weak password", async () => {
        const response = await POST(
            post({ ...VALID, password: "weak", confirmPassword: "weak" })
        );

        const payload = await response.json();

        expect(response.status).toBe(400);
        expect(payload.code).toBe("VALIDATION_ERROR");
        expect(payload.details.fields.length).toBeGreaterThan(0);
    });
});
