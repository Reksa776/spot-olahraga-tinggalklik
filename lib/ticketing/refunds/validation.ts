import { z } from "zod";

/**
 * ==========================================
 * REFUND REQUEST VALIDATION (Phase 10B, policy D-R01/D-R08/D-R13)
 * ==========================================
 *
 * The refund API deliberately accepts almost nothing from the client, because a refund is
 * a money movement and every value that determines how much money moves must be derived
 * server-side (brief §17, D-61):
 *
 *   * NO `amount`, `total`, `subtotal`, `price` or `currency` — the refundable amount is
 *     the sum of the selected tickets' purchase-time price snapshots (`EventOrderItem`),
 *     computed by `evaluateRefundEligibility`.
 *   * NO `organizerId`, `userId`, `customerId`, `status`, `refundedAmount` or
 *     `providerRef` — tenancy comes from the resolved row, status is the lifecycle's, and
 *     a provider reference is only ever written from a provider response (D-R12).
 *   * `ticketIds` selects WHICH eligible tickets to refund (D-R01/D-R08); it can never
 *     make an ineligible ticket eligible.
 *
 * Zod strips unknown keys by default and neither schema opts into `passthrough()` or
 * `catchall()`, so a tampered field never reaches the service (the same contract the
 * checkout schema states).
 */

/** The refund lifecycle statuses a list query may filter on (D-R07). */
export const REFUND_STATUSES = [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "PROCESSING",
    "REFUNDED",
    "FAILED",
] as const;

export const refundStatusSchema = z.enum(REFUND_STATUSES);

const ticketIdSchema = z.string().trim().min(1).max(64);
const orderNumberSchema = z.string().trim().min(1).max(64);

/**
 * `POST /api/ticketing/refunds` — a buyer requests a refund for their own order.
 *
 * `ticketIds` is optional: omitted means "every currently eligible ticket" (a full
 * refund, D-R01). `reason` is bounded free text; D-R13 persists it when supplied.
 */
export const refundRequestSchema = z.object({
    orderNumber: orderNumberSchema,
    ticketIds: z.array(ticketIdSchema).min(1).max(200).optional(),
    reason: z.string().trim().min(3).max(1000).optional(),
});

/**
 * `POST /api/ticketing/refunds/[refundId]/approve` — staff approve (D-R02).
 *
 * An optional internal note; the approval actor is the session, never the body.
 */
export const refundApproveSchema = z
    .object({
        note: z.string().trim().max(1000).optional(),
    })
    .optional()
    .default({});

/**
 * `POST /api/ticketing/refunds/[refundId]/reject` — staff decline (D-R02).
 *
 * A reason is REQUIRED here: D-R13 persists the decision's reason, and a rejection a
 * buyer cannot understand is a support ticket. It is a staff-facing field, not money.
 */
export const refundRejectSchema = z.object({
    reason: z.string().trim().min(3).max(1000),
});

/**
 * `POST /api/ticketing/refunds/[refundId]/execute` — staff execute (D-R02).
 *
 * The provider and the amount are chosen by the server; there is nothing a caller may
 * supply that changes the outcome, so the body is empty (and unknown keys are stripped).
 */
export const refundExecuteSchema = z
    .object({
        note: z.string().trim().max(1000).optional(),
    })
    .optional()
    .default({});

/**
 * The `[refundId]` path segment. `Refund.id` is an autoincrement Int, and the path segment
 * is a string, so the number is produced by coercion at the boundary — a non-numeric or
 * non-positive segment fails validation (400) instead of reaching Prisma as `NaN`.
 */
export const refundIdParamSchema = z.coerce.number().int().positive();

/**
 * `GET /api/ticketing/refunds` — list. Without `organizerId` a caller sees their OWN
 * refunds; with it, the caller must hold `order.read.tenant` for that organizer.
 */
export const refundListQuerySchema = z.object({
    organizerId: z.string().trim().min(1).max(64).optional(),
    orderNumber: orderNumberSchema.optional(),
    status: refundStatusSchema.optional(),
    page: z.coerce.number().int().positive().max(1000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
});

/**
 * `POST /api/ticketing/refunds/[refundId]/settle` — record the MANUAL BANK TRANSFER and
 * settle (Phase 18B, D-P17-04 = B).
 *
 * The body carries EVIDENCE and nothing else:
 *
 *   * `transferRef` — the bank/transfer reference the operator used. REQUIRED, because a
 *     refund may not reach `REFUNDED` without a recorded transfer: that is the whole point
 *     of the manual rail, and it is what makes the settlement auditable by a third party.
 *     It is persisted on `Refund.providerRef` (the column that already holds "the reference
 *     the buyer would quote in a dispute").
 *   * `note` — the operator's evidence note, persisted on `Refund.evidenceNote`.
 *
 * There is deliberately NO amount, NO currency, NO `confirmedAmount` and NO status: the
 * settled figure is the server-derived sum of the refund's own `RefundItem` rows. An
 * operator supply of a different figure is refused at the schema, so a manual rail cannot
 * become a way to move a chosen amount.
 */
export const refundSettleSchema = z
    .object({
        transferRef: z.string().trim().min(3).max(120),
        note: z.string().trim().min(3).max(1000).optional(),
    })
    .strict();

/**
 * `POST /api/ticketing/refunds/[refundId]/fail` — the transfer did not complete.
 *
 * A reason is REQUIRED and persisted as `failureReason` (D-R13): a `PROCESSING → FAILED`
 * refund that releases the ticket claims must explain itself to the buyer and to the next
 * operator. No money, no status and no ticket id are accepted — nothing here is money.
 */
export const refundFailSchema = z
    .object({
        reason: z.string().trim().min(3).max(1000),
    })
    .strict();

export type RefundRequestInput = z.infer<typeof refundRequestSchema>;
export type RefundRejectInput = z.infer<typeof refundRejectSchema>;
export type RefundSettleInput = z.infer<typeof refundSettleSchema>;
export type RefundFailInput = z.infer<typeof refundFailSchema>;
export type RefundListQuery = z.infer<typeof refundListQuerySchema>;
