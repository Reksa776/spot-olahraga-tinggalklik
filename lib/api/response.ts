import { NextResponse } from "next/server";
import crypto from "crypto";

import { classifyInfrastructureFault } from "@/lib/errors/infrastructure";

import { AppError, ERROR_CODES, toAppError } from "./errors";

/**
 * ==========================================
 * API RESPONSE ENVELOPE
 * ==========================================
 *
 * Design §25.0 fixes the envelope and requires it be kept "from the existing
 * codebase, extended additively":
 *
 *   success → { success: true, data: {...} }
 *   list    → { success: true, data: { items: [...], pagination: {...} } }
 *   error   → { success: false, code, message, details? }
 *
 * The two extra error keys (`code`, `details`) are additive, so existing retail
 * clients that only read `success` and `message` keep working — which is why this
 * helper is published for new ticketing routes while the retail handlers were left
 * untouched (phase 4 brief §25 forbids retail rewrites).
 *
 * CONTRACT FOR CLIENTS: branch on `code`, never on `message`.
 */

export type Pagination = {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
};

/** `{ success: true, data }` with HTTP 200 (or `status`). */
export function ok<T>(data: T, status = 200): NextResponse {
    return NextResponse.json({ success: true, data }, { status });
}

/** 201 for creates. */
export function created<T>(data: T): NextResponse {
    return ok(data, 201);
}

/** `{ success: true, data: { items, pagination } }` (design §25.0). */
export function paginated<T>(
    items: readonly T[],
    params: { page: number; limit: number; total: number }
): NextResponse {
    return ok({
        items,
        pagination: buildPagination(params),
    });
}

export function buildPagination(params: {
    page: number;
    limit: number;
    total: number;
}): Pagination {
    return {
        page: params.page,
        limit: params.limit,
        total: params.total,
        totalPages: params.limit > 0 ? Math.ceil(params.total / params.limit) : 0,
    };
}

/**
 * Convert any thrown value into the error envelope.
 *
 * Unknown errors become a generic 500: the design requires that internals are never
 * leaked, so the client gets `INTERNAL_ERROR` and the server logs the real cause
 * under a correlation id the operator can grep for.
 *
 * Never logs request bodies, headers, tokens or buyer PII — the design's §32.3
 * logging rules apply to the error path too.
 */
/**
 * Codes that mean "the server failed", as opposed to "your request was refused".
 *
 * These are the ones that earn a correlation id and a sanitised server log line: they are
 * operator-actionable (an outage, a bug, a dead dependency) and are exactly the cases a
 * buyer or an organiser will phone support about. A 403 or a 404 does not need one —
 * nothing is broken and the code already says why.
 */
const SERVER_FAULT_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.INTERNAL_ERROR,
    ERROR_CODES.DATABASE_UNAVAILABLE,
    ERROR_CODES.SERVICE_UNAVAILABLE,
    ERROR_CODES.REQUEST_TIMEOUT,
    ERROR_CODES.PROVIDER_UNAVAILABLE,
]);

/**
 * The generic message substituted for anything not safe to show, so the fallback text
 * exists in exactly one place and cannot drift from the log-line wording.
 */
const INTERNAL_FALLBACK_MESSAGE = "Terjadi kesalahan pada server.";

export function apiErrorResponse(error: unknown): NextResponse {
    const appError = toAppError(error);

    const correlationId = crypto.randomUUID();

    /*
     * SERVER-SIDE LOGGING — what is written, and what is deliberately not.
     *
     * An infrastructure fault (Prisma/driver/socket) is logged as its CLASSIFIED detail only
     * — "prisma P1001", "network fault (econnrefused)". The raw error object is NOT dumped:
     * a driver error can embed the host, the port, the user name or the failing statement,
     * and this log line is the artefact an operator pastes into a ticket. The fault's detail
     * is produced by `lib/errors/infrastructure.ts`, which never copies the message through.
     *
     * An application bug (an unexpected throw, or an `AppError` the services did not intend
     * to expose) IS dumped: the stack trace is the entire diagnostic value there, and there is
     * no connection string in it.
     */
    const fault = classifyInfrastructureFault(error);

    if (SERVER_FAULT_CODES.has(appError.code)) {
        console.error(
            `[api] ${appError.code} correlationId=${correlationId}${
                fault ? ` fault=${fault.detail}` : ""
            }`
        );

        if (!fault) {
            console.error("[api] cause:", error);
        }
    } else if (!appError.expose) {
        console.error(`[api] ${appError.code} correlationId=${correlationId}`);
    }

    const body: Record<string, unknown> = {
        success: false,
        code: appError.code,
        message: appError.expose
            ? appError.message
            : INTERNAL_FALLBACK_MESSAGE,
    };

    if (appError.details) {
        body.details = appError.details;
    }

    if (SERVER_FAULT_CODES.has(appError.code)) {
        body.correlationId = correlationId;
    }

    return NextResponse.json(body, { status: appError.httpStatus });
}

/**
 * Run a route body, converting any `AppError` / `AuthzError` (or unexpected throw)
 * into the envelope.
 *
 * This is the preferred shape for new ticketing routes:
 *
 *   export const GET = async (request: Request) =>
 *       handleApi(async () => ok(await listEvents()));
 *
 * It exists so that a handler cannot forget the try/catch and leak a stack trace —
 * the failure mode the design's §25.0 warns about ("Unknown errors → 500 + generic
 * message + server-side log").
 */
export async function handleApi<T>(
    handler: () => Promise<NextResponse<T> | NextResponse>
): Promise<NextResponse> {
    try {
        return await handler();
    } catch (error) {
        return apiErrorResponse(error);
    }
}

/**
 * Build a `VALIDATION_ERROR` from a Zod failure, keeping `details` field-scoped as
 * §25.1 requires ("details names the offending fields").
 */
export function validationError(
    issues: readonly { path: (string | number | symbol)[]; message: string }[]
): AppError {
    return new AppError(ERROR_CODES.VALIDATION_ERROR, {
        details: {
            fields: issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
            })),
        },
    });
}
