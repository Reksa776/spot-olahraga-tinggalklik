/**
 * ==========================================
 * SANITIZED iPAYMU SANDBOX CALLBACK FIXTURE (not a suite)
 * ==========================================
 *
 * A captured, real-world provider callback, kept as a FIELD SET rather than as raw bytes.
 *
 * ── WHY A FIELD SET AND NOT A SIGNED BODY ────────────────────────────────────────
 * The provider signs its callback with the merchant VA, which is a credential. A committed
 * fixture must never carry it, and a committed signature would be a signature nobody could
 * reproduce anyway (it is keyed to that VA). So the fixture keeps only the *shape* — the exact
 * field names, and the value TYPES the provider uses (numeric strings, `is_escrow=false`,
 * `additional_info=[]`, slash-bearing URLs). The test re-signs it with the configured VA at
 * run time, through the platform's own `computeCanonicalJson` / `computeWebhookSignature`, so
 * the fixture exercises `normalizeCallbackBody` against the real field set instead of the
 * handful of fields the thin `signedCallback` helper sends.
 *
 * That distinction is the whole value of this fixture. `normalizeCallbackBody` has four
 * special cases (`trx_id`/`status_code`/`transaction_status_code`/`paid_off` → int,
 * `is_escrow` → bool, `additional_info` → array, everything else → string) and a slash-escape
 * step. A callback carrying only `reference_id`/`status_code`/`sub_total` never touches most of
 * them, so a regression there would pass every thin test and still reject every real delivery
 * as `INVALID_SIGNATURE` — silently, because the provider only sees a 401 and retries.
 *
 * ── PROVENANCE ───────────────────────────────────────────────────────────────────
 * Field names and value types are taken from a callback the iPaymu SANDBOX actually delivered
 * (Phase 27B), and from the provider's own published callback sample. PII is replaced with
 * obviously-fake values, and the payment VA/`payment_no` is a placeholder. Nothing here is a
 * secret: the merchant VA is never part of the payload, and the test supplies it at run time.
 *
 * ── THIS FILE IS NOT A SUITE ─────────────────────────────────────────────────────
 * It is not named `*.test.ts`, so `jest.config.js#testMatch` never runs it. It is imported by
 * `sandbox-callback-replay.test.ts`.
 */

/**
 * The exact field NAMES the provider sends, in no particular order (the signature sorts them).
 *
 * Asserted by the replay suite so this list cannot silently shrink: dropping a field would
 * remove the very coverage this fixture exists to provide.
 */
export const SANDBOX_CALLBACK_FIELDS = [
    "trx_id",
    "sid",
    "reference_id",
    "status",
    "status_code",
    "sub_total",
    "total",
    "amount",
    "fee",
    "paid_off",
    "created_at",
    "expired_at",
    "paid_at",
    "settlement_status",
    "transaction_status_code",
    "is_escrow",
    "system_notes",
    "via",
    "channel",
    "payment_no",
    "buyer_name",
    "buyer_email",
    "buyer_phone",
    "additional_info",
    "url",
    "va",
] as const;

/**
 * The captured callback, sanitized.
 *
 * `reference_id` is a placeholder here and is always overridden by the suite with the real
 * `Payment.paymentReference`; the same goes for `trx_id`, which is suffixed so teardown can
 * find any ledger row the delivery leaves behind.
 */
export const SANDBOX_CALLBACK: Readonly<Record<string, string>> = Object.freeze({
    trx_id: "233592",
    sid: "EVT-0000000000000-fixture0",
    reference_id: "EVT-0000000000000-fixture0",
    status: "berhasil",
    status_code: "1",
    sub_total: "15000",
    total: "15000",
    amount: "15000",
    fee: "3500",
    paid_off: "11500",
    created_at: "2026-09-20 15:50:02",
    expired_at: "2026-09-20 16:50:02",
    paid_at: "2026-09-20 15:51:44",
    settlement_status: "settled",
    transaction_status_code: "1",
    is_escrow: "false",
    system_notes: "Sandbox notify",
    via: "va",
    channel: "bni",
    payment_no: "000000000000",
    buyer_name: "Sandbox Buyer",
    buyer_email: "sandbox-buyer@example.test",
    buyer_phone: "0800000000",
    additional_info: "[]",
    url: "http://localhost:3000/api/ticketing/payment/webhook",
    va: "000000000000",
});

/**
 * The captured callback with overrides applied.
 *
 * A `null`/`undefined` override REMOVES the field, so a test can prove that a callback missing
 * an optional field still verifies (the provider's field set is not fully guaranteed).
 */
export function buildSandboxCallback(
    overrides: Record<string, string | null | undefined> = {}
): Record<string, string> {
    const fields: Record<string, string> = { ...SANDBOX_CALLBACK };

    for (const [key, value] of Object.entries(overrides)) {
        if (value === null || value === undefined) {
            delete fields[key];
        } else {
            fields[key] = value;
        }
    }

    return fields;
}
