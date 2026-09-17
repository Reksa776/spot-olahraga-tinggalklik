import { z } from "zod";

import { TICKET_CODE_PATTERN } from "./reference";

/**
 * ==========================================
 * TICKETING TICKET VALIDATION (brief §27)
 * ==========================================
 *
 * Two read-only surfaces and one state-changing one, and none of them accepts an
 * authoritative value from the client.
 *
 * ── WHAT CANNOT BE SENT ─────────────────────────────────────────────────────────
 * There is no `userId`, `holderUserId`, `organizerId`, `eventId` (as authority),
 * `paymentStatus`, `ticketStatus`, `paidAt`, `issuedAt`, `ticketCode` (as a body field),
 * `qrPayload` or `sequenceNo` in any schema below — brief §27 names every one of those as
 * forbidden. Identity comes from the session and every authoritative value is derived from
 * the row being acted on.
 *
 * The wallet's `status` and `eventId` ARE accepted, because brief §27 allows a
 * "non-authoritative query filter". They narrow what the caller is shown *within their own
 * tickets*; the ownership predicate is applied regardless, so neither can widen the result
 * set. `eventId` is a filter, never an assertion that the caller may see that event's
 * tickets.
 *
 * ── NO FAILURE-MODE COERCION ────────────────────────────────────────────────────
 * `z.coerce.boolean()` is deliberately NOT used for `upcoming`: `Boolean("false")` is
 * `true`, so the string `"false"` would silently mean the opposite of what it says. This is
 * the same trap `lib/events/validation.ts` documents for `hasTickets`, handled the same
 * way.
 */

/** The ticket statuses the wallet will filter on. The enum is the schema's own vocabulary. */
export const WALLET_STATUS_VALUES = [
    "RESERVED",
    "ISSUED",
    "CHECKED_IN",
    "VOID",
    "REFUNDED",
] as const;

export const ticketWalletQuerySchema = z.object({
    /** Non-authoritative filter, applied *inside* the caller's own tickets. */
    status: z.enum(WALLET_STATUS_VALUES).optional(),
    /** Non-authoritative filter, applied *inside* the caller's own tickets. */
    eventId: z.string().trim().min(1).max(64).optional(),
    /**
     * Design §26.5's `upcoming (default)`. Accepts a real boolean as well as the
     * query-string forms, so a server component can pass either.
     */
    // `.optional()` is applied LAST, so the field stays optional in the inferred type.
    // A `.optional().transform()` chain would make the key required-but-possibly-undefined
    // and force every server-side caller to write `upcoming: undefined` for no benefit.
    upcoming: z
        .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
        .transform((value) =>
            typeof value === "boolean" ? value : value === "true" || value === "1"
        )
        .optional(),
    page: z.coerce.number().int().min(1).max(10_000).optional(),
    /** Design §26.5's pagination, with the same 50 cap §26.1 puts on the order list. */
    limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type TicketWalletQuery = z.infer<typeof ticketWalletQuerySchema>;

/**
 * `ticketCode` path parameter.
 *
 * Validated by SHAPE and not merely non-empty. The format is fixed and drawn from an
 * ambiguity-free alphabet (`./reference.ts`), so anything else cannot be a real code: a
 * 40-character SQL fragment or a path traversal attempt is refused before a query is built.
 */
export const ticketCodeParamSchema = z
    .string()
    .trim()
    .regex(TICKET_CODE_PATTERN, "Kode tiket tidak valid.");
