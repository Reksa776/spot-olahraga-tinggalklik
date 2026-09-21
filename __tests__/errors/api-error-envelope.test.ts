/**
 * ==========================================
 * API ERROR ENVELOPE (CONTRACT)
 * ==========================================
 *
 * What a client actually receives when something fails. Three properties are pinned:
 *
 *   1. **The envelope is stable.** `{ success, code, message, details?, correlationId? }`,
 *      with `code` the machine-readable value clients branch on. A client must never have to
 *      match on `message` — that is how one copy change breaks a frontend.
 *   2. **The status is the right one.** In particular an infrastructure failure is 503/504
 *      and NEVER 404. This is the JSON half of the same invariant the page-level suite
 *      asserts.
 *   3. **Nothing internal leaks.** The Prisma message, the SQL, the connection detail and
 *      the raw error object stay on the server; the response carries a generic curated
 *      sentence plus, for server-side faults only, an opaque correlation id.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { apiErrorResponse } from "@/lib/api/response";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { AuthzError, AuthzErrorCode } from "@/lib/authz/errors";

/** A Prisma-shaped error whose message is exactly the kind of thing that must not leak. */
function prismaError(code: string): Error {
    const error = new Error(
        "connect ECONNREFUSED 10.0.0.5:3306 — SELECT * FROM User WHERE email = 'a@b.c'"
    );

    error.name = "PrismaClientKnownRequestError";
    (error as { code?: string }).code = code;

    return error;
}

async function body(response: Response): Promise<Record<string, unknown>> {
    return response.json() as Promise<Record<string, unknown>>;
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
    consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    consoleError.mockRestore();
});

describe("the envelope shape", () => {
    it("always reports success: false with a stable code", async () => {
        const response = apiErrorResponse(new AppError(ERROR_CODES.SOLD_OUT));
        const payload = await body(response);

        expect(response.status).toBe(409);
        expect(payload.success).toBe(false);
        expect(payload.code).toBe("SOLD_OUT");
        expect(typeof payload.message).toBe("string");
    });

    it("carries field details for a validation failure", async () => {
        const response = apiErrorResponse(
            new AppError(ERROR_CODES.VALIDATION_ERROR, {
                details: { fields: [{ path: "email", message: "Email tidak valid" }] },
            })
        );

        const payload = await body(response);

        expect(payload.code).toBe("VALIDATION_ERROR");
        expect(payload.details).toEqual({
            fields: [{ path: "email", message: "Email tidak valid" }],
        });
    });

    it("keeps the authorization layer's own status, including its 404 for a scope denial", async () => {
        expect(
            apiErrorResponse(new AuthzError(AuthzErrorCode.UNAUTHORIZED)).status
        ).toBe(401);

        expect(apiErrorResponse(new AuthzError(AuthzErrorCode.FORBIDDEN)).status).toBe(403);

        expect(
            apiErrorResponse(new AuthzError(AuthzErrorCode.ORGANIZER_ACCESS_DENIED)).status
        ).toBe(404);
    });
});

describe("infrastructure failures are 5xx, never 404", () => {
    it("answers a database failure with 503 DATABASE_UNAVAILABLE", async () => {
        const response = apiErrorResponse(prismaError("P1001"));
        const payload = await body(response);

        expect(response.status).toBe(503);
        expect(payload.code).toBe("DATABASE_UNAVAILABLE");
        expect(payload.message).toBe("Data sedang tidak dapat dimuat. Silakan coba lagi.");
    });

    it("answers a deadline with 504", async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";

        const response = apiErrorResponse(error);

        expect(response.status).toBe(504);
        expect((await body(response)).code).toBe("REQUEST_TIMEOUT");
    });

    it("never answers a 404 for an infrastructure fault", async () => {
        for (const code of ["P1001", "P1017", "P2024", "P2021"]) {
            expect(apiErrorResponse(prismaError(code)).status).not.toBe(404);
        }
    });
});

describe("nothing internal leaks", () => {
    it("does not put the driver message, the SQL or the host in the response", async () => {
        const response = apiErrorResponse(prismaError("P1001"));
        const serialised = JSON.stringify(await body(response));

        expect(serialised).not.toContain("ECONNREFUSED");
        expect(serialised).not.toContain("10.0.0.5");
        expect(serialised).not.toContain("SELECT");
        expect(serialised).not.toContain("PrismaClientKnownRequestError");
    });

    it("does not put an unexpected error's message in the response", async () => {
        const response = apiErrorResponse(new Error("INTERNAL: column x does not exist"));
        const payload = await body(response);

        expect(payload.code).toBe("INTERNAL_ERROR");
        expect(payload.message).toBe("Terjadi kesalahan pada server.");
        expect(JSON.stringify(payload)).not.toContain("column x");
    });

    it("issues a correlation id for a server-side fault and not for a refusal", async () => {
        const outage = await body(apiErrorResponse(prismaError("P1001")));
        const internal = await body(apiErrorResponse(new Error("boom")));
        const refusal = await body(apiErrorResponse(new AppError(ERROR_CODES.FORBIDDEN)));

        expect(typeof outage.correlationId).toBe("string");
        expect(typeof internal.correlationId).toBe("string");

        // A refusal is not a fault: nothing is broken, and the code already says why.
        expect(refusal.correlationId).toBeUndefined();
    });

    it("logs infrastructure faults without dumping the raw error", () => {
        apiErrorResponse(prismaError("P1001"));

        const logged = consoleError.mock.calls.flat().map(String).join("\n");

        // The code and the classified fault are logged…
        expect(logged).toContain("DATABASE_UNAVAILABLE");
        expect(logged).toContain("prisma P1001");

        // …but not the driver message, and not the error object.
        expect(logged).not.toContain("ECONNREFUSED");
        expect(logged).not.toContain("SELECT");
    });

    it("DOES log the cause of an application bug, because the stack is the diagnosis", () => {
        const bug = new Error("Cannot read properties of undefined (reading 'id')");

        apiErrorResponse(bug);

        const logged = consoleError.mock.calls.flat().join("\n");
        expect(logged).toContain("reading 'id'");
    });
});
