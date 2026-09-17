import { z } from "zod";

/**
 * ==========================================
 * TICKETING PAYMENT VALIDATION
 * ==========================================
 *
 * The payment-creation request carries NO financial field, by construction. Brief §7:
 * the client must not be able to submit `amount`, `subtotal`, `total`, `currency`,
 * `organizerId`, `userId`, `paymentStatus` or `order status`. Brief §17 adds that the
 * server must "reject or ignore client-provided price, subtotal, total, currency as
 * financial authority".
 *
 * This schema does BOTH: the fields are not declared, so Zod (which strips unknown keys)
 * removes them before the service sees the body, and the service then derives every
 * amount from the persisted `EventOrder` (design §13.3 step 3 / §17.2). A tampered
 * `total: 1` therefore cannot reach any code path at all. Asserted by test.
 *
 * ── WHAT IS ACCEPTED ─────────────────────────────────────────────────────────────
 * Only the two *presentation* choices the provider's hosted page needs, and both are
 * whitelisted:
 *
 *   method  — `QRIS | BANK_TRANSFER | E_WALLET`, mapped to the provider's own
 *             method/channel pair by `lib/ticketing/payment/gateway.ts`
 *   channel — an optional provider bank code, validated against the provider's list
 *
 * Neither influences the amount. Design §13.2 stores both on the `Payment` row as a
 * record of what the buyer chose, and §26.3's contract does not define these fields, so
 * they are optional with a documented default rather than required — an MVP UI may omit
 * them entirely.
 *
 * ── WHY NO NUMERIC COERCION ANYWHERE ─────────────────────────────────────────────
 * There is no numeric field in this schema at all. That is deliberate: brief §8 lists
 * "unsafe numeric coercion" as a hazard, and the way to avoid it in the payment path is
 * to accept no numbers from the client.
 */

/** `PaymentMethod` values a buyer may pick. The rest of the enum is not purchasable. */
export const PURCHASABLE_PAYMENT_METHODS = [
    "QRIS",
    "BANK_TRANSFER",
    "E_WALLET",
] as const;

/**
 * MVP default when the buyer expresses no preference.
 *
 * QRIS is the provider's most general page (its own mapping sends e-wallets to QRIS too)
 * and needs no channel code. This is a presentation default, not a pricing or
 * eligibility rule — it cannot move money and it is visible in the response.
 */
export const DEFAULT_PAYMENT_METHOD = "QRIS" as const;

export const paymentCreateRequestSchema = z.object({
    method: z.enum(PURCHASABLE_PAYMENT_METHODS).optional(),
    /** Provider bank/channel code; ignored if the provider does not recognise it. */
    channel: z
        .string()
        .trim()
        .toLowerCase()
        .min(2)
        .max(16)
        .regex(/^[a-z0-9]+$/, "Kode channel tidak valid")
        .optional(),
});

export type PaymentCreateRequest = z.infer<typeof paymentCreateRequestSchema>;

/**
 * Upper bound on the raw webhook body we are willing to hash and parse.
 *
 * The webhook is unauthenticated by definition (the provider cannot hold a session), so
 * it is the one ticketing endpoint an anonymous caller can post to at will. A cap keeps
 * an oversized body from becoming a memory/CPU vector before signature verification
 * runs. Real iPaymu callbacks are well under 4 KB; 64 KB leaves an order of magnitude of
 * headroom for additional provider fields.
 */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
