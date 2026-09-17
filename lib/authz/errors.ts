import { NextResponse } from "next/server";

/**
 * ==========================================
 * PHASE 3 — AUTHORIZATION ERROR CONTRACT
 * ==========================================
 *
 * Every authorization failure in the ticketing platform is raised as an
 * `AuthzError` and converted to an HTTP response in exactly one place
 * (`authzErrorResponse`). Nothing in the authorization layer returns a bare
 * boolean that a caller could accidentally ignore, and nothing throws a loose
 * string the way the legacy `requireAdmin()` does (`throw new Error("FORBIDDEN")`).
 *
 * FAIL-CLOSED RULE (design §29 / phase 3 brief §21)
 * ------------------------------------------------
 * An authorization error means DENY. There is no code path in this module that
 * can turn an unknown or unestablished authorization state into an ALLOW.
 *
 * NOTE ON `AppError`
 * ------------------
 * Design §40.2 assigned a general `AppError`/`ErrorCode` contract to Phase 2,
 * but Phase 2 was deliberately database-only, so no such module exists (verified:
 * `grep -rn "AppError" app lib types` returns nothing). Rather than invent a
 * platform-wide error framework inside an authorization phase, this file
 * delivers the subset Phase 3 actually needs. Phase 4+ may generalise it.
 */

export const AuthzErrorCode = {
    /** No authenticated session. Maps to HTTP 401. */
    UNAUTHORIZED: "UNAUTHORIZED",
    /** Authenticated, but the platform-level action is not permitted. HTTP 403. */
    FORBIDDEN: "FORBIDDEN",
    /** Authenticated, but lacks an active membership for the target organizer. HTTP 404. */
    ORGANIZER_ACCESS_DENIED: "ORGANIZER_ACCESS_DENIED",
    /** Authenticated PIC acting on another PIC's records. HTTP 403. */
    PIC_ACCESS_DENIED: "PIC_ACCESS_DENIED",
    /** The target organizer does not exist. HTTP 404. */
    NOT_FOUND: "NOT_FOUND",
} as const;

export type AuthzErrorCode =
    (typeof AuthzErrorCode)[keyof typeof AuthzErrorCode];

/**
 * HTTP status per error code.
 *
 * `ORGANIZER_ACCESS_DENIED` deliberately maps to **404, not 403**. Returning 403
 * would confirm that the requested organizer exists, which is a cross-tenant
 * information leak (design §7.4: the isolation guarantee is that Organizer A
 * cannot even learn about Organizer B's resources). An actor without a
 * membership cannot distinguish "does not exist" from "not yours".
 */
const STATUS_BY_CODE: Record<AuthzErrorCode, number> = {
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    ORGANIZER_ACCESS_DENIED: 404,
    PIC_ACCESS_DENIED: 403,
    NOT_FOUND: 404,
};

const DEFAULT_MESSAGE: Record<AuthzErrorCode, string> = {
    UNAUTHORIZED: "Silakan login terlebih dahulu.",
    FORBIDDEN: "Akses ditolak.",
    ORGANIZER_ACCESS_DENIED: "Akses ditolak.",
    PIC_ACCESS_DENIED: "Akses ditolak.",
    NOT_FOUND: "Data tidak ditemukan.",
};

export class AuthzError extends Error {
    readonly code: AuthzErrorCode;
    readonly status: number;

    /**
     * @param code machine-readable code
     * @param detail optional server-side detail. NEVER sent to the client —
     *               it is for logs only, so it may name the missing permission
     *               without leaking authorization internals to the caller.
     */
    constructor(
        code: AuthzErrorCode,
        readonly detail?: string
    ) {
        super(DEFAULT_MESSAGE[code]);
        this.name = "AuthzError";
        this.code = code;
        this.status = STATUS_BY_CODE[code];
        Object.setPrototypeOf(this, AuthzError.prototype);
    }
}

export function isAuthzError(value: unknown): value is AuthzError {
    return value instanceof AuthzError;
}

/**
 * Convert an authorization failure into the response the rest of the codebase
 * already uses: `{ success: false, message }` (the project's existing envelope).
 * The `code` is included so API clients can branch on it.
 */
export function authzErrorResponse(error: unknown): NextResponse {
    const err = isAuthzError(error)
        ? error
        : new AuthzError(AuthzErrorCode.FORBIDDEN);

    // Server-side only. The client gets the generic message.
    if (err.detail) {
        console.warn(
            `[authz] ${err.code}: ${err.detail}`
        );
    }

    return NextResponse.json(
        { success: false, code: err.code, message: err.message },
        { status: err.status }
    );
}
