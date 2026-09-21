import { ERROR_CODES, toAppError, type ErrorCode } from "@/lib/api/errors";

/**
 * ==========================================
 * ERROR CLASSIFICATION (PURE)
 * ==========================================
 *
 * One function that answers, for anything thrown anywhere in the application:
 *
 *   • WHAT KIND of failure is this?
 *   • what stable CODE do I branch on?
 *   • what HTTP status does it mean?
 *   • is it worth offering the user a retry?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
 * The Phase 23A defect was an authorization refusal rendered as a 404. The generalisation
 * of that bug is a page writing
 *
 *     const x = await service().catch(() => null);
 *     if (!x) notFound();
 *
 * which reports EVERY failure mode — an outage, a timeout, a bug — as "this does not
 * exist". The buyer of a real, paid order is told their purchase is gone; the operator
 * sees a 404 instead of an outage; and no retry is ever offered.
 *
 * The fix is not "stop using notFound()" — a genuine 404 is correct and must stay. The fix
 * is to DECIDE, in one place, which failures are which, so a page can map:
 *
 *   NOT_FOUND      → notFound()            (404 — the resource really is not visible)
 *   AUTHENTICATION → login                 (the session ended, not the data)
 *   AUTHORIZATION  → AccessDenied / 404     (per the privacy contract of the surface)
 *   USER           → the page's own UX      (validation, business state)
 *   EXTERNAL/INFRA → retry UI, never 404    (a database must never look like a 404)
 *   UNEXPECTED     → the error boundary     (a bug is a bug)
 *
 * ── PURITY ───────────────────────────────────────────────────────────────────────
 * No database, no React, no `next/navigation`. It takes a thrown value and returns a plain
 * object, so the whole mapping is unit-testable and cannot perform I/O. The `notFound()`
 * and `redirect()` CALLS stay in the pages, where they belong.
 *
 * ── ONE SOURCE OF TRUTH ──────────────────────────────────────────────────────────
 * The translation from "any thrown value" to a code is `toAppError` in `lib/api/errors.ts`
 * — the SAME function every API route uses. This module therefore cannot disagree with the
 * JSON a client would receive for the same failure, which is what makes "the API says 503
 * and the page says 404" impossible rather than merely unlikely.
 */

/**
 * The six failure families from the brief, plus `NOT_FOUND`.
 *
 * `NOT_FOUND` is listed separately rather than folded into `USER` because it is the one
 * outcome that must NEVER be produced by a failure: it means "the resource is genuinely
 * not visible to you", and every other category must be kept out of it.
 */
export type ErrorCategory =
    /** Invalid input or a business state (sold out, expired, already checked in). */
    | "USER"
    /** No session, or a session that no longer resolves to a user. */
    | "AUTHENTICATION"
    /** Authenticated, but not permitted: no permission, no tenant, not the owner. */
    | "AUTHORIZATION"
    /** The resource does not exist, or exists but is not this actor's to see. */
    | "NOT_FOUND"
    /** An external dependency failed (payment provider, provider 5xx, malformed response). */
    | "EXTERNAL_SERVICE"
    /** The database or the runtime underneath it failed. */
    | "INFRASTRUCTURE"
    /** A bug: an unclassified throw. */
    | "UNEXPECTED";

export type ClassifiedError = {
    category: ErrorCategory;
    /** Stable, machine-readable. Clients branch on this and never on `message`. */
    code: ErrorCode;
    status: number;
    /** Safe, user-facing, Indonesian. Already curated — never a raw exception message. */
    message: string;
    /** Whether offering the user a "Coba lagi" is the honest next step. */
    retryable: boolean;
};

/**
 * Codes that are a BUSINESS STATE rather than a fault.
 *
 * These are "the request was understood and refused for a reason the user can act on or
 * accept" — sold out, expired, already checked in, a settlement in the wrong state. They
 * are not errors to retry and they are not outages.
 */
const USER_STATE_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.VALIDATION_ERROR,
    ERROR_CODES.INVALID_WEBHOOK,
    ERROR_CODES.CONFLICT,
    ERROR_CODES.DUPLICATE_WEBHOOK,
    ERROR_CODES.SOLD_OUT,
    ERROR_CODES.QUOTA_EXCEEDED,
    ERROR_CODES.LIMIT_EXCEEDED,
    ERROR_CODES.SALES_NOT_OPEN,
    ERROR_CODES.ORDER_NOT_PAYABLE,
    ERROR_CODES.REFUND_NOT_ALLOWED,
    ERROR_CODES.SETTLEMENT_STATE_INVALID,
    ERROR_CODES.TICKET_ALREADY_CHECKED_IN,
    ERROR_CODES.PAYMENT_REQUIRED,
    ERROR_CODES.PAYMENT_FAILED,
    ERROR_CODES.RATE_LIMITED,
]);

/** Codes that mean "a dependency is down" — retryable. */
const EXTERNAL_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.PROVIDER_UNAVAILABLE,
    ERROR_CODES.SERVICE_UNAVAILABLE,
    ERROR_CODES.REQUEST_TIMEOUT,
]);

/** Codes that mean "not found, or not yours to see" (the privacy contract). */
const NOT_FOUND_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.NOT_FOUND,
    ERROR_CODES.INVALID_TICKET,
    ERROR_CODES.ORGANIZER_ACCESS_DENIED,
]);

/** Codes that mean "authenticated but refused". */
const AUTHORIZATION_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.FORBIDDEN,
    ERROR_CODES.PIC_ACCESS_DENIED,
]);

/**
 * Classify a thrown value.
 *
 * Never throws, never logs, never touches the network. An unrecognised value is
 * `UNEXPECTED` / `INTERNAL_ERROR` — the fail-closed answer, and the same one the API
 * envelope produces.
 */
export function classifyError(error: unknown): ClassifiedError {
    const appError = toAppError(error);
    const base = {
        code: appError.code,
        status: appError.httpStatus,
        message: appError.expose
            ? appError.message
            : "Terjadi kesalahan pada server.",
    };

    if (appError.code === ERROR_CODES.UNAUTHORIZED) {
        return {
            ...base,
            category: "AUTHENTICATION",
            retryable: false,
        };
    }

    if (AUTHORIZATION_CODES.has(appError.code)) {
        return { ...base, category: "AUTHORIZATION", retryable: false };
    }

    if (NOT_FOUND_CODES.has(appError.code)) {
        return { ...base, category: "NOT_FOUND", retryable: false };
    }

    if (USER_STATE_CODES.has(appError.code)) {
        // `RATE_LIMITED` is the one user-state code where waiting genuinely helps.
        return {
            ...base,
            category: "USER",
            retryable: appError.code === ERROR_CODES.RATE_LIMITED,
        };
    }

    if (EXTERNAL_CODES.has(appError.code)) {
        return { ...base, category: "EXTERNAL_SERVICE", retryable: true };
    }

    if (appError.code === ERROR_CODES.DATABASE_UNAVAILABLE) {
        return { ...base, category: "INFRASTRUCTURE", retryable: true };
    }

    return {
        ...base,
        category: "UNEXPECTED",
        retryable: false,
    };
}

/* ==================================================================================
 * PAGE-LEVEL MAPPING
 * ================================================================================== */

/**
 * What a PAGE should do about a failure.
 *
 * Deliberately separate from `ClassifiedError`: the same failure is a 503 JSON response in
 * an API route and a retry panel in a page, and conflating "what is this" with "what does
 * a page render" is how the two drift apart.
 */
export type PageFailureAction =
    /** Render the 404 page. Only for genuinely-not-found / not-yours. */
    | "not-found"
    /** Redirect to login, preserving where they were. */
    | "sign-in"
    /** Render the access-denied surface (403 UX). */
    | "denied"
    /** Render a retryable error state. Never a 404. */
    | "unavailable"
    /** Re-throw to the nearest `error.tsx` boundary. */
    | "error";

export type PageFailure = {
    action: PageFailureAction;
    classification: ClassifiedError;
};

/**
 * Map a failure onto a page outcome.
 *
 * `AUTHORIZATION` maps to `denied` by default. A surface whose privacy contract requires
 * indistinguishability (the buyer's order/ticket pages — design §7.4, brief §14) must map
 * `denied` to `notFound()` itself rather than being given a different classifier, so the
 * stricter behaviour is a visible, local decision at the page instead of a hidden default
 * here.
 */
export function resolvePageFailure(error: unknown): PageFailure {
    const classification = classifyError(error);

    switch (classification.category) {
        case "NOT_FOUND":
            return { action: "not-found", classification };

        case "AUTHENTICATION":
            return { action: "sign-in", classification };

        case "AUTHORIZATION":
            return { action: "denied", classification };

        case "EXTERNAL_SERVICE":
        case "INFRASTRUCTURE":
            return { action: "unavailable", classification };

        case "USER":
            // A malformed path parameter (a bad order number, an invalid ticket code shape)
            // is a request for something that cannot exist. That is a legitimate 404.
            return { action: "not-found", classification };

        default:
            return { action: "error", classification };
    }
}

/** Convenience predicates, so a page reads as prose. */
export function isNotFoundFailure(error: unknown): boolean {
    return resolvePageFailure(error).action === "not-found";
}

export function isRetryableFailure(error: unknown): boolean {
    const action = resolvePageFailure(error).action;
    return action === "unavailable";
}
