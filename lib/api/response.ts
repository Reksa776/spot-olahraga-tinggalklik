import { NextResponse } from "next/server";
import crypto from "crypto";

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
export function apiErrorResponse(error: unknown): NextResponse {
    const appError = toAppError(error);

    const correlationId = crypto.randomUUID();

    if (appError.code === ERROR_CODES.INTERNAL_ERROR && !appError.expose) {
        console.error(
            `[api] INTERNAL_ERROR correlationId=${correlationId}`,
            error
        );
    } else if (
        appError.code === ERROR_CODES.INTERNAL_ERROR ||
        !appError.expose
    ) {
        console.error(
            `[api] ${appError.code} correlationId=${correlationId}:`,
            error
        );
    }

    const body: Record<string, unknown> = {
        success: false,
        code: appError.code,
        message: appError.expose
            ? appError.message
            : "Terjadi kesalahan pada server.",
    };

    if (appError.details) {
        body.details = appError.details;
    }

    if (appError.code === ERROR_CODES.INTERNAL_ERROR) {
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
