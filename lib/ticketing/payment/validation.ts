import { z } from "zod";

import { PURCHASABLE_METHOD_VALUES } from "./method-catalog";

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
 *   method  — a member of `lib/ticketing/payment/method-catalog`, mapped to the
 *             provider's own method/channel pair by `lib/ticketing/payment/gateway.ts`
 *   channel — an optional provider bank code, validated against the provider's list
 *
 * Neither influences the amount. Design §13.2 stores both on the `Payment` row as a
 * record of what the buyer chose, and §26.3's contract does not define these fields, so
 * they are optional with a documented default rather than required — an MVP UI may omit
 * them entirely.
 *
 * ── WHY THE ACCEPTED SET IS READ OUT OF THE CATALOG, NEVER RE-LISTED HERE ────────
 * It used to be a hand-written tuple (`QRIS | BANK_TRANSFER | E_WALLET`) written before
 * the catalog existed. The buyer's picker is driven by the catalog, so once the catalog
 * moved to the provider's real capability the two lists stopped agreeing: the picker
 * offered `VIRTUAL_ACCOUNT`, `RETAIL_OUTLET` and `CREDIT_CARD` while this schema still
 * demanded the three retired names. Zod rejects an unknown enum member, so three of the
 * four methods a buyer could actually choose were answered `400 VALIDATION_ERROR`
 * before the service — and therefore the gateway — was ever reached. Only QRIS worked.
 *
 * Deriving the set from `PURCHASABLE_METHOD_VALUES` is what makes that class of drift
 * impossible rather than merely fixed: there is exactly one list, and a method cannot be
 * offered to a buyer without also being acceptable here.
 *
 * ── WHY NO NUMERIC COERCION ANYWHERE ─────────────────────────────────────────────
 * There is no numeric field in this schema at all. That is deliberate: brief §8 lists
 * "unsafe numeric coercion" as a hazard, and the way to avoid it in the payment path is
 * to accept no numbers from the client.
 */

/**
 * `PaymentMethod` values a buyer may pick, taken from the catalog.
 *
 * Re-exported under the name the rest of the payment path already uses, so the schema
 * below and the buyer's picker can never disagree — see the module note above for the
 * defect that made this necessary.
 */
export const PURCHASABLE_PAYMENT_METHODS = PURCHASABLE_METHOD_VALUES;

/**
 * MVP default when the buyer expresses no preference.
 *
 * QRIS is the provider's most general instrument (verified against iPaymu sandbox: the
 * direct endpoint answers `qris`/`mpm` with a QR payload) and it needs no channel code.
 * This is a presentation default, not a pricing or eligibility rule — it cannot move
 * money and it is visible in the response.
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
