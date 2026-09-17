import { AuthzErrorCode, isAuthzError } from "@/lib/authz/errors";

/**
 * ==========================================
 * API ERROR CONTRACT
 * ==========================================
 *
 * Design §25.0 specifies an `AppError` class and §25.1 an error-code registry, and
 * §25.0 assigns that work to Phase 2 — which was deliberately database-only, so the
 * module never existed. Phase 4 is the first phase with a public API surface, so it
 * is created here.
 *
 * The registry below is NOT invented: every code and HTTP status is copied from the
 * design's §25.1 table. The design's own rule is preserved verbatim —
 *
 *   "a code is added only when a caller must behave differently"
 *
 * so `INTERNAL_ERROR` is never used for a case that has a specific code, and no code
 * exists that the design did not list. Codes that only later phases can raise
 * (SOLD_OUT, DUPLICATE_WEBHOOK, …) are declared now because the registry is a
 * contract clients branch on; declaring a code is not implementing its feature.
 *
 * WHY `details` EXISTS
 * --------------------
 * §25.1 requires `details` for several codes so the UI can point at the exact
 * offending field or ticket type without parsing `message`. `message` is human
 * Indonesian; `code` is the stable machine-readable value clients must branch on.
 */

export const ERROR_CODES = {
    // 400
    VALIDATION_ERROR: "VALIDATION_ERROR",
    INVALID_WEBHOOK: "INVALID_WEBHOOK",
    // 401
    UNAUTHORIZED: "UNAUTHORIZED",
    // 403
    FORBIDDEN: "FORBIDDEN",
    ORGANIZER_ACCESS_DENIED: "ORGANIZER_ACCESS_DENIED",
    PIC_ACCESS_DENIED: "PIC_ACCESS_DENIED",
    // 404
    NOT_FOUND: "NOT_FOUND",
    INVALID_TICKET: "INVALID_TICKET",
    // 409
    CONFLICT: "CONFLICT",
    DUPLICATE_WEBHOOK: "DUPLICATE_WEBHOOK",
    SOLD_OUT: "SOLD_OUT",
    QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
    LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
    SALES_NOT_OPEN: "SALES_NOT_OPEN",
    ORDER_NOT_PAYABLE: "ORDER_NOT_PAYABLE",
    REFUND_NOT_ALLOWED: "REFUND_NOT_ALLOWED",
    SETTLEMENT_STATE_INVALID: "SETTLEMENT_STATE_INVALID",
    TICKET_ALREADY_CHECKED_IN: "TICKET_ALREADY_CHECKED_IN",
    // 402
    PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
    PAYMENT_FAILED: "PAYMENT_FAILED",
    // 429
    RATE_LIMITED: "RATE_LIMITED",
    // 5xx
    INTERNAL_ERROR: "INTERNAL_ERROR",
    PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * HTTP status per code — §25.1 verbatim.
 *
 * `ORGANIZER_ACCESS_DENIED` is 403 in the design's table while the Phase 3
 * authorization layer returns 404 for the same condition (design §7.4: "Scope
 * failures return 404, never 403"). That is not a contradiction: they describe
 * different surfaces. §7.4 governs **resource** resolution, where confirming
 * existence would be a cross-tenant leak; §25.1's 403 applies when the actor's
 * *membership* is the subject. `toAppError` therefore preserves the status the
 * authorization layer decided rather than re-deriving it, so the stricter 404
 * behaviour Phase 3 verified in tests cannot be silently downgraded here.
 */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
    VALIDATION_ERROR: 400,
    INVALID_WEBHOOK: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    ORGANIZER_ACCESS_DENIED: 403,
    PIC_ACCESS_DENIED: 403,
    NOT_FOUND: 404,
    INVALID_TICKET: 404,
    CONFLICT: 409,
    DUPLICATE_WEBHOOK: 409,
    SOLD_OUT: 409,
    QUOTA_EXCEEDED: 409,
    LIMIT_EXCEEDED: 409,
    SALES_NOT_OPEN: 409,
    ORDER_NOT_PAYABLE: 409,
    REFUND_NOT_ALLOWED: 409,
    SETTLEMENT_STATE_INVALID: 409,
    TICKET_ALREADY_CHECKED_IN: 409,
    PAYMENT_REQUIRED: 402,
    PAYMENT_FAILED: 402,
    RATE_LIMITED: 429,
    INTERNAL_ERROR: 500,
    PROVIDER_UNAVAILABLE: 503,
};

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
    VALIDATION_ERROR: "Data yang dikirim tidak valid.",
    INVALID_WEBHOOK: "Webhook tidak valid.",
    UNAUTHORIZED: "Silakan login terlebih dahulu.",
    FORBIDDEN: "Akses ditolak.",
    ORGANIZER_ACCESS_DENIED: "Akses ditolak.",
    PIC_ACCESS_DENIED: "Akses ditolak.",
    NOT_FOUND: "Data tidak ditemukan.",
    INVALID_TICKET: "Tiket tidak valid.",
    CONFLICT: "Permintaan tidak dapat diproses pada status saat ini.",
    DUPLICATE_WEBHOOK: "Webhook sudah diproses.",
    SOLD_OUT: "Tiket sudah habis.",
    QUOTA_EXCEEDED: "Jumlah tiket melebihi kuota yang tersedia.",
    LIMIT_EXCEEDED: "Jumlah tiket melebihi batas yang diizinkan.",
    SALES_NOT_OPEN: "Penjualan tiket belum dibuka.",
    ORDER_NOT_PAYABLE: "Pesanan ini tidak dapat dibayar.",
    REFUND_NOT_ALLOWED: "Refund tidak diizinkan.",
    SETTLEMENT_STATE_INVALID: "Status settlement tidak valid.",
    TICKET_ALREADY_CHECKED_IN: "Tiket sudah pernah check-in.",
    PAYMENT_REQUIRED: "Tiket belum dibayar.",
    PAYMENT_FAILED: "Pembayaran gagal.",
    RATE_LIMITED: "Terlalu banyak permintaan. Coba lagi nanti.",
    INTERNAL_ERROR: "Terjadi kesalahan pada server.",
    PROVIDER_UNAVAILABLE: "Layanan sedang tidak tersedia.",
};

/**
 * The single error type thrown by ticketing services and API handlers.
 *
 * `expose: false` means the message must be replaced by the generic one before the
 * response is written — used for anything whose text could leak internals.
 */
export class AppError extends Error {
    readonly code: ErrorCode;
    readonly httpStatus: number;
    readonly details?: Record<string, unknown>;
    readonly expose: boolean;

    constructor(
        code: ErrorCode,
        options: {
            message?: string;
            details?: Record<string, unknown>;
            expose?: boolean;
            /** Override the registry status. Used only to preserve a stricter
             *  decision already made by the authorization layer (see above). */
            status?: number;
        } = {}
    ) {
        super(options.message ?? DEFAULT_MESSAGE[code]);
        this.name = "AppError";
        this.code = code;
        this.httpStatus = options.status ?? STATUS_BY_CODE[code];
        this.details = options.details;
        this.expose = options.expose ?? true;
        Object.setPrototypeOf(this, AppError.prototype);
    }

    static notFound(message?: string): AppError {
        return new AppError(ERROR_CODES.NOT_FOUND, { message });
    }

    static validation(
        message?: string,
        details?: Record<string, unknown>
    ): AppError {
        return new AppError(ERROR_CODES.VALIDATION_ERROR, { message, details });
    }

    static conflict(
        message?: string,
        details?: Record<string, unknown>
    ): AppError {
        return new AppError(ERROR_CODES.CONFLICT, { message, details });
    }

    static forbidden(message?: string): AppError {
        return new AppError(ERROR_CODES.FORBIDDEN, { message });
    }
}

export function isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
}

export function statusForCode(code: ErrorCode): number {
    return STATUS_BY_CODE[code];
}

export function messageForCode(code: ErrorCode): string {
    return DEFAULT_MESSAGE[code];
}

/**
 * Normalise anything thrown into an `AppError`.
 *
 * `AuthzError` is translated by **preserving its own code and status** rather than
 * being re-derived from the §25.1 table. That matters: the authorization layer maps
 * `ORGANIZER_ACCESS_DENIED` to 404 deliberately (design §7.4 — a cross-tenant
 * denial must not confirm the resource exists), and Phase 3 tests assert it. A
 * naive re-derivation from §25.1's 403 would silently undo that guarantee.
 *
 * Every code `AuthzError` can produce exists in this registry with the same spelling,
 * so the mapping is total.
 */
export function toAppError(error: unknown): AppError {
    if (isAppError(error)) {
        return error;
    }

    if (isAuthzError(error)) {
        const code = error.code as ErrorCode;

        return new AppError(code, {
            message: error.message,
            status: error.status,
        });
    }

    if (error instanceof Error) {
        return new AppError(ERROR_CODES.INTERNAL_ERROR);
    }

    return new AppError(ERROR_CODES.INTERNAL_ERROR);
}

/** Is this `AuthzErrorCode` present in the API registry? (Used by tests.) */
export function isKnownErrorCode(value: string): value is ErrorCode {
    return Object.prototype.hasOwnProperty.call(ERROR_CODES, value);
}

/** Every `AuthzErrorCode`, for the registry-coverage test. */
export const AUTHZ_ERROR_CODES: readonly string[] = Object.values(
    AuthzErrorCode
);
