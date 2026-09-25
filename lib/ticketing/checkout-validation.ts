import { z } from "zod";

/**
 * ==========================================
 * CHECKOUT REQUEST VALIDATION (design §25.5)
 * ==========================================
 *
 * The design fixes the request body exactly:
 *
 *   `{ eventId, items: [{ ticketTypeId, quantity }], buyerName, buyerEmail,
 *      buyerPhone, couponCode?, shareToken? }`
 *   — "**no prices, no totals, no organizerId, no picProfileId**"
 *
 * That omission is the contract, and this schema enforces it by construction: a field
 * that is not declared cannot influence anything, because the parsed value is the only
 * thing the service sees.
 *
 * ── CLIENT-SUPPLIED MONEY (brief §17) ────────────────────────────────────────────
 * Brief §17: "Reject or ignore client-provided price, subtotal, total, currency as
 * financial authority." This schema **ignores** them: Zod strips unknown keys by
 * default, so a tampered `total: 1` never reaches the pricing code at all. The service
 * then recomputes every amount from the database (design §17.2). Both halves are
 * asserted by test — the stripping here and the recomputation there.
 *
 * The same applies to `organizerId`, `userId`, `customerId`, `picProfileId` and
 * `status`: they are not declared, so they cannot be injected (brief §13/§14 — those
 * values are DATA, never authority).
 *
 * ── WHY NO NUMERIC COERCION ──────────────────────────────────────────────────────
 * `quantity` is a real JSON number. `z.coerce.number()` would happily turn `"abc"` into
 * `NaN` and `"3"` into `3`, which brief §8 lists as an "unsafe coercion". A quantity
 * must arrive as a number or the request is malformed.
 *
 * Note what is deliberately NOT here: `minPerOrder` / `maxPerOrder` are properties of
 * the `TicketType` row, not of the request, so they are enforced in the service **after**
 * the row is loaded from the database. A client cannot relax them by omitting them.
 */

/** §12.3 contact snapshot fields. Free-text, so bounded rather than pattern-matched. */
const nameSchema = z.string().trim().min(1).max(120);
const emailSchema = z.string().trim().email().max(200);
const phoneSchema = z
    .string()
    .trim()
    .min(7)
    .max(20)
    .regex(/^[0-9+\-\s()]+$/, "Nomor telepon tidak valid");

export const checkoutItemSchema = z.object({
    ticketTypeId: z.string().trim().min(1).max(64),
    /**
     * Positive integer only. Zero or negative is rejected before any inventory work
     * (brief §10: "Reject invalid quantities before reservation mutation").
     *
     * Bounded at 10 000 as a transport sanity limit — the real ceiling is the ticket
     * type's `maxPerOrder` and its available quota, both checked against the database.
     */
    quantity: z.number().int().positive().max(10_000),
});

export const checkoutRequestSchema = z.object({
    eventId: z.string().trim().min(1).max(64),
    /**
     * At least one line. The upper bound is a transport guard against an unbounded
     * array (the same reason the design rate-limits this endpoint); it is not a
     * business rule — the number of purchasable lines is bounded by the event's own
     * ticket types, and duplicates for one type are merged before anything else happens.
     */
    items: z.array(checkoutItemSchema).min(1).max(50),
    buyerName: nameSchema,
    buyerEmail: emailSchema,
    buyerPhone: phoneSchema,
    /**
     * Coupons are post-MVP (design §4.2) and the field exists on the order from day one
     * (§12.1). Accepted here so the contract is stable, but no discount is computed in
     * this phase — the design says MVP `discount = 0` (§17.2), so a supplied code is
     * rejected rather than silently ignored: accepting a code and charging full price
     * would be worse than not offering the feature.
     */
    couponCode: z.string().trim().min(1).max(64).optional(),
    /** PIC share token; a hint only, resolved server-side (design §25.5). */
    shareToken: z.string().trim().min(1).max(128).optional(),
});

export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>;
export type CheckoutItemRequest = z.infer<typeof checkoutItemSchema>;

/** Idempotency keys are opaque to us; only their shape is bounded. §30.1 requires one. */
export const idempotencyKeySchema = z.string().trim().min(1).max(200);

/** Query params for the customer's own order detail (`GET /api/orders/{orderNumber}`). */
export const orderNumberParamSchema = z.string().trim().min(1).max(64);

/**
 * `GET /api/ticketing/orders` — the buyer's own order list (design §26.1).
 *
 * §26.1 declares exactly these filters, and the schema enforces §26.1's own ceiling:
 * `limit` (≤ 50). There is deliberately NO `userId`, `organizerId`, `customerId` or
 * `buyerEmail`: §26.1 states that the ownership value is "injected server-side" and that "a
 * client-supplied `userId` is ignored", and the cleanest way to ignore it is for the field
 * not to exist. Zod strips unknown keys by default, so a tampered `?userId=` never reaches
 * the service.
 *
 * `dateFrom`/`dateTo` accept any value `Date.parse` understands (ISO here) rather than a
 * single rigid format: `Date.parse` is what the service ultimately uses, so validating with
 * anything else would only move the disagreement. A malformed value is a 400 at the
 * boundary, never a silent `Invalid Date` in the query.
 */
const dateQuerySchema = z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine(
        (value) => !Number.isNaN(Date.parse(value)),
        "Tanggal tidak valid."
    );

export const orderListQuerySchema = z.object({
    status: z
        .enum([
            "PENDING_PAYMENT",
            "PAID",
            "CANCELLED",
            "EXPIRED",
            "REFUNDED",
            "PARTIALLY_REFUNDED",
        ])
        .optional(),
    dateFrom: dateQuerySchema.optional(),
    dateTo: dateQuerySchema.optional(),
    eventId: z.string().trim().min(1).max(64).optional(),
    page: z.coerce.number().int().positive().max(1000).optional(),
    limit: z.coerce.number().int().positive().max(50).optional(),
});

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;
