import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
    PIC_SCAN_MAX_REQUESTS,
    PIC_SCAN_WINDOW_MS,
    rateLimiters,
    type RateLimitResult,
} from "@/lib/rate-limit";

/**
 * ==========================================
 * PHASE 3F — PIC SCAN RATE LIMIT
 * ==========================================
 *
 * The bucket identity is `(session user id, event id)` and nothing else:
 *
 *   • the user id comes from `requireAuth()` / `requireEventCheckInAccess`, never from
 *     the request body, so rotating `deviceId`, `gateLabel` or `picProfileId` cannot buy
 *     a fresh allowance;
 *   • the event id is the route's event, already authorized before this runs, so one
 *     PIC's scan flood at event A cannot exhaust their allowance at event B;
 *   • a different PIC is a different user id and therefore a different bucket.
 *
 * The bucket is consumed BEFORE any ticket lookup, so a flood cannot be turned into a
 * database probe. It is consumed only for `actorKind === "PIC"`; the organizer path is
 * unchanged.
 *
 * FAIL-CLOSED ON LIMITER FAILURE. The backing store is the existing in-process sliding
 * window, whose only failure mode is a programming error. If it throws, admitting the
 * scan would turn that bug into an unbounded scanner — so the request is refused with
 * 503 instead. A 503 is retryable and leaks nothing: no user id, event id, ticket code
 * or participant data appears in the error.
 *
 * The allowance is deliberately generous — 120 scans per rolling minute (two per
 * second sustained) — because a legitimate gate scans a few tickets per second at most
 * and shared devices are expected. It bounds abuse without interrupting normal use.
 */

export type PicScanRateLimitIdentity = {
    userId: string;
    eventId: string;
};

export function enforcePicScanRateLimit(
    identity: PicScanRateLimitIdentity,
    consume: (
        userId: string,
        eventId: string
    ) => RateLimitResult = rateLimiters.checkInScan
): void {
    let result: RateLimitResult;

    try {
        result = consume(identity.userId, identity.eventId);
    } catch {
        throw new AppError(ERROR_CODES.SERVICE_UNAVAILABLE, {
            message:
                "Pembatasan laju pemindaian sedang tidak tersedia. Coba lagi.",
            details: { reason: "RATE_LIMIT_UNAVAILABLE" },
        });
    }

    if (!result.allowed) {
        throw new AppError(ERROR_CODES.RATE_LIMITED, {
            message: "Terlalu banyak pemindaian. Tunggu sebentar lalu coba lagi.",
            details: {
                reason: "PIC_SCAN_RATE_LIMITED",
                retryAfterMs: Math.max(1, result.retryAfterMs),
            },
        });
    }
}

/** Re-exported for the report and tests, so the documented limit cannot drift. */
export { PIC_SCAN_MAX_REQUESTS, PIC_SCAN_WINDOW_MS };
