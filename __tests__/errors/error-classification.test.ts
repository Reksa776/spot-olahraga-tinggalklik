/**
 * ==========================================
 * ERROR CLASSIFICATION (PURE)
 * ==========================================
 *
 * The whole point of this phase's error work is one invariant:
 *
 *     a database outage, a provider outage, a timeout or a bug
 *     must NEVER be rendered as "not found".
 *
 * Every assertion below is a face of that invariant, asserted against the real classifier
 * rather than argued about in a comment. The classifier is pure — no database, no
 * `next/navigation` — so this suite needs no fixtures and no network.
 *
 * A second, quieter invariant is checked here too: the mapping must not MISLABEL in the
 * other direction. A unique-constraint violation (`P2002`) is an application outcome, not an
 * outage, and `PrismaClientValidationError` is a bug in our own query — labelling either as
 * "database unavailable" would send an operator looking for a server that is perfectly fine.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { classifyError, resolvePageFailure } from "@/lib/errors/classify";
import { classifyInfrastructureFault } from "@/lib/errors/infrastructure";
import {
    AppError,
    ERROR_CODES,
    statusForCode,
    toAppError,
} from "@/lib/api/errors";
import { AuthzError, AuthzErrorCode } from "@/lib/authz/errors";

/** A Prisma-shaped error, built the way the generated client builds one. */
function prismaError(name: string, code?: string): Error {
    const error = new Error("Some driver detail that must never reach a user");

    error.name = name;

    if (code) {
        (error as { code?: string }).code = code;
    }

    return error;
}

function networkError(message: string, name = "Error"): Error {
    const error = new Error(message);
    error.name = name;
    return error;
}

/* ==================================================================================
 * 1. INFRASTRUCTURE DETECTION
 * ================================================================================== */

describe("classifyInfrastructureFault recognises real infrastructure failures", () => {
    it.each([
        ["P1001", "DATABASE_CONNECTION_LOST", "cannot reach database server"],
        ["P1002", "DATABASE_TIMEOUT", "database server timed out"],
        ["P1008", "DATABASE_TIMEOUT", "operations timed out"],
        ["P1017", "DATABASE_CONNECTION_LOST", "server closed the connection"],
        ["P2024", "DATABASE_TIMEOUT", "timed out fetching a connection"],
        ["P2021", "DATABASE_UNAVAILABLE", "table does not exist (deploy skew)"],
    ])("maps Prisma %s to %s", (code, kind) => {
        const fault = classifyInfrastructureFault(
            prismaError("PrismaClientKnownRequestError", code)
        );

        expect(fault?.kind).toBe(kind);
    });

    it("classifies an engine panic and an init failure", () => {
        expect(
            classifyInfrastructureFault(prismaError("PrismaClientRustPanicError"))?.kind
        ).toBe("DATABASE_UNAVAILABLE");

        expect(
            classifyInfrastructureFault(
                prismaError("PrismaClientInitializationError", "P1001")
            )?.kind
        ).toBe("DATABASE_CONNECTION_LOST");

        expect(
            classifyInfrastructureFault(
                prismaError("PrismaClientInitializationError")
            )?.kind
        ).toBe("DATABASE_UNAVAILABLE");
    });

    it("recognises socket and DNS failures", () => {
        expect(
            classifyInfrastructureFault(networkError("connect ECONNREFUSED 127.0.0.1:3306"))
                ?.kind
        ).toBe("NETWORK_FAILURE");

        expect(countKind(networkError("getaddrinfo ENOTFOUND db.internal"))).toBe(
            "NETWORK_FAILURE"
        );
    });

    it("recognises a deadline", () => {
        expect(classifyInfrastructureFault(networkError("timed out", "TimeoutError"))?.kind).toBe(
            "REQUEST_TIMEOUT"
        );

        expect(classifyInfrastructureFault(networkError("connect ETIMEDOUT"))?.kind).toBe(
            "REQUEST_TIMEOUT"
        );
    });

    it("does NOT mislabel an application outcome as an outage", () => {
        // A unique-constraint violation and a "record not found" are the database telling us
        // about our DATA. Calling either a 503 would be its own misdirection.
        expect(
            classifyInfrastructureFault(
                prismaError("PrismaClientKnownRequestError", "P2002")
            )
        ).toBeNull();

        expect(
            classifyInfrastructureFault(
                prismaError("PrismaClientKnownRequestError", "P2025")
            )
        ).toBeNull();

        // A validation error means OUR query is malformed — a bug, not an outage.
        expect(
            classifyInfrastructureFault(prismaError("PrismaClientValidationError"))
        ).toBeNull();

        // `PrismaClientKnownRequestError` with no code: no opinion rather than a guess.
        expect(
            classifyInfrastructureFault(prismaError("PrismaClientKnownRequestError"))
        ).toBeNull();

        // Ordinary application errors and non-errors.
        expect(classifyInfrastructureFault(new Error("Sold out"))).toBeNull();
        expect(classifyInfrastructureFault("a string")).toBeNull();
        expect(classifyInfrastructureFault(null)).toBeNull();
        expect(classifyInfrastructureFault(undefined)).toBeNull();
    });

    it("never copies the driver message into the fault detail", () => {
        const fault = classifyInfrastructureFault(
            prismaError("PrismaClientKnownRequestError", "P1001")
        );

        // The detail is what reaches the log line, so it must not carry the message.
        expect(fault?.detail).toBe("prisma P1001");
        expect(fault?.detail).not.toContain("Some driver detail");
    });
});

/** Small helper so the multi-line calls above stay readable. */
function countKind(error: unknown): string | undefined {
    return classifyInfrastructureFault(error)?.kind;
}

/* ==================================================================================
 * 2. THROWN VALUE → TRANSPORT-LEVEL ERROR  (the API half)
 * ================================================================================== */

describe("toAppError translates infrastructure failures", () => {
    it("maps a database fault to 503 DATABASE_UNAVAILABLE", () => {
        const appError = toAppError(
            prismaError("PrismaClientKnownRequestError", "P1001")
        );

        expect(appError.code).toBe(ERROR_CODES.DATABASE_UNAVAILABLE);
        expect(appError.httpStatus).toBe(503);
    });

    it("maps a socket failure to 503 SERVICE_UNAVAILABLE", () => {
        const appError = toAppError(networkError("connect ECONNREFUSED"));

        expect(appError.code).toBe(ERROR_CODES.SERVICE_UNAVAILABLE);
        expect(appError.httpStatus).toBe(503);
    });

    it("maps a deadline to 504 REQUEST_TIMEOUT", () => {
        const appError = toAppError(networkError("timed out", "TimeoutError"));

        expect(appError.code).toBe(ERROR_CODES.REQUEST_TIMEOUT);
        expect(appError.httpStatus).toBe(504);
    });

    it("still maps an unknown throw to 500 INTERNAL_ERROR", () => {
        const appError = toAppError(new Error("a bug"));

        expect(appError.code).toBe(ERROR_CODES.INTERNAL_ERROR);
        expect(appError.httpStatus).toBe(500);
    });

    it("preserves an AuthzError's own code and status rather than re-deriving it", () => {
        // Phase 3 maps a cross-tenant denial to 404 deliberately (design §7.4). Re-deriving
        // from the registry's 403 for ORGANIZER_ACCESS_DENIED would undo that guarantee, and
        // the Phase 3 suite asserts it — this is the belt to that braces.
        const appError = toAppError(
            new AuthzError(AuthzErrorCode.ORGANIZER_ACCESS_DENIED)
        );

        expect(appError.code).toBe(ERROR_CODES.ORGANIZER_ACCESS_DENIED);
        expect(appError.httpStatus).toBe(404);
    });

    it("passes an AppError through untouched", () => {
        const original = new AppError(ERROR_CODES.SOLD_OUT);
        expect(toAppError(original)).toBe(original);
    });
});

/* ==================================================================================
 * 3. CODE → CATEGORY  (the decision every page and widget branches on)
 * ================================================================================== */

describe("classifyError", () => {
    it("classifies authentication failures", () => {
        expect(classifyError(new AuthzError(AuthzErrorCode.UNAUTHORIZED)).category).toBe(
            "AUTHENTICATION"
        );
    });

    it("classifies authorization failures separately from not-found", () => {
        expect(classifyError(new AuthzError(AuthzErrorCode.FORBIDDEN)).category).toBe(
            "AUTHORIZATION"
        );

        expect(
            classifyError(new AuthzError(AuthzErrorCode.PIC_ACCESS_DENIED)).category
        ).toBe("AUTHORIZATION");

        // The cross-tenant denial IS a not-found, by design and by test.
        expect(
            classifyError(new AuthzError(AuthzErrorCode.ORGANIZER_ACCESS_DENIED)).category
        ).toBe("NOT_FOUND");
    });

    it("classifies business states as USER, and only rate limiting as retryable", () => {
        for (const code of [
            ERROR_CODES.SOLD_OUT,
            ERROR_CODES.ORDER_NOT_PAYABLE,
            ERROR_CODES.TICKET_ALREADY_CHECKED_IN,
            ERROR_CODES.VALIDATION_ERROR,
            ERROR_CODES.CONFLICT,
        ]) {
            const classification = classifyError(new AppError(code));

            expect(classification.category).toBe("USER");
            expect(classification.retryable).toBe(false);
        }

        expect(classifyError(new AppError(ERROR_CODES.RATE_LIMITED))).toMatchObject({
            category: "USER",
            retryable: true,
        });
    });

    it("classifies provider and infrastructure failures as retryable, never as not-found", () => {
        for (const code of [
            ERROR_CODES.PROVIDER_UNAVAILABLE,
            ERROR_CODES.SERVICE_UNAVAILABLE,
            ERROR_CODES.REQUEST_TIMEOUT,
            ERROR_CODES.DATABASE_UNAVAILABLE,
        ]) {
            const classification = classifyError(new AppError(code));

            expect(classification.retryable).toBe(true);
            expect(classification.category === "NOT_FOUND").toBe(false);
            expect(classification.status).toBeGreaterThanOrEqual(503);
        }
    });

    it("classifies an unknown throw as UNEXPECTED and does not offer a retry", () => {
        expect(classifyError(new Error("boom"))).toMatchObject({
            category: "UNEXPECTED",
            code: ERROR_CODES.INTERNAL_ERROR,
            retryable: false,
        });
    });

    it("reads the registry status, so API and page can never disagree", () => {
        for (const code of Object.values(ERROR_CODES)) {
            expect(classifyError(new AppError(code)).status).toBe(statusForCode(code));
        }
    });
});

/* ==================================================================================
 * 4. CODE → PAGE OUTCOME  (the invariant this phase exists for)
 * ================================================================================== */

describe("resolvePageFailure", () => {
    it("renders a real 404 only for a real absence", () => {
        expect(resolvePageFailure(new AppError(ERROR_CODES.NOT_FOUND)).action).toBe(
            "not-found"
        );

        // A malformed path parameter asks for something that cannot exist.
        expect(
            resolvePageFailure(new AppError(ERROR_CODES.VALIDATION_ERROR)).action
        ).toBe("not-found");
    });

    it("NEVER renders an outage as not-found", () => {
        const outages = [
            new AppError(ERROR_CODES.DATABASE_UNAVAILABLE),
            new AppError(ERROR_CODES.SERVICE_UNAVAILABLE),
            new AppError(ERROR_CODES.REQUEST_TIMEOUT),
            new AppError(ERROR_CODES.PROVIDER_UNAVAILABLE),
            prismaError("PrismaClientKnownRequestError", "P1001"),
            prismaError("PrismaClientInitializationError", "P1001"),
            networkError("connect ECONNREFUSED"),
            networkError("timed out", "TimeoutError"),
        ];

        for (const outage of outages) {
            const failure = resolvePageFailure(outage);

            expect(failure.action).toBe("unavailable");
            expect(failure.action).not.toBe("not-found");
        }
    });

    it("sends an expired session to sign-in, and a refusal to the denied surface", () => {
        expect(resolvePageFailure(new AuthzError(AuthzErrorCode.UNAUTHORIZED)).action).toBe(
            "sign-in"
        );

        expect(resolvePageFailure(new AuthzError(AuthzErrorCode.FORBIDDEN)).action).toBe(
            "denied"
        );
    });

    it("sends a bug to the error boundary", () => {
        expect(resolvePageFailure(new Error("boom")).action).toBe("error");
        expect(resolvePageFailure("not even an error").action).toBe("error");
    });

    it("carries a message that is safe to render", () => {
        const classification = resolvePageFailure(
            prismaError("PrismaClientKnownRequestError", "P1001")
        ).classification;

        expect(classification.message).toBe("Data sedang tidak dapat dimuat. Silakan coba lagi.");
        expect(classification.message).not.toContain("driver detail");
    });
});
