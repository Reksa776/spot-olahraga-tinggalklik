/**
 * ==========================================
 * PHASE 22 — PAYMENT METHOD CONTRACT (regression)
 * ==========================================
 *
 * Run: npx jest __tests__/ticketing-payment/payment-method-contract.test.ts
 *
 * No database and no live provider: every assertion here is about the contract BETWEEN
 * the layers, which is exactly where the three defects this phase found lived. Each test
 * below fails on the code as it was before the fix.
 *
 * ── THE DEFECTS THESE PIN DOWN ───────────────────────────────────────────────────
 *
 * 1. `validation.ts` hand-listed `QRIS | BANK_TRANSFER | E_WALLET` while the buyer's
 *    picker was driven by the catalog (`QRIS | VIRTUAL_ACCOUNT | RETAIL_OUTLET |
 *    CREDIT_CARD`). Zod rejects an unknown enum member, so three of the four methods a
 *    buyer could choose were answered `400 VALIDATION_ERROR` before the service — and
 *    therefore the gateway — was reached. Only QRIS could be paid.
 *
 * 2. The credit-card path sent an EMPTY `paymentChannel`, because the catalog gave
 *    `CREDIT_CARD` no default channel and the mapper stringified the absence to `""`.
 *    iPaymu re-normalises the body it receives and drops an empty field, so the body
 *    hash it verified no longer matched the one signed and it answered
 *    `401 unauthorized signature` (reproduced against the provider's sandbox).
 *
 * 3. The same mapper round-tripped the internal method through a table that has no
 *    credit-card bucket, so a card payment was persisted as `BANK_TRANSFER` — a false
 *    entry in a financial record.
 *
 * …plus the redirect session id, which the provider returns as `SessionID` and the code
 * read as `SessionId`, so `Payment.externalSessionId` was always null.
 */

import fs from "fs";
import path from "path";

import {
    PAYMENT_METHOD_OPTIONS,
    PURCHASABLE_METHOD_VALUES,
    channelIsAllowed,
    findPaymentMethodOption,
} from "@/lib/ticketing/payment/method-catalog";
import {
    PURCHASABLE_PAYMENT_METHODS,
    paymentCreateRequestSchema,
} from "@/lib/ticketing/payment/validation";
import {
    createSession,
    resolvePaymentSelection,
} from "@/lib/ticketing/payment/gateway";
import { resetIpaymuConfigCache } from "@/lib/payment/config";

const ROOT = path.resolve(__dirname, "../..");

function read(file: string): string {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

/** Strip comments, so a comment DESCRIBING a pattern is not mistaken for the pattern. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The picker and the request schema are ONE list
// ─────────────────────────────────────────────────────────────────────────────

describe("the buyer's picker and the request schema cannot drift apart", () => {
    test("the schema accepts every method the catalog offers", () => {
        expect(PAYMENT_METHOD_OPTIONS.length).toBeGreaterThan(0);

        const rejected = PAYMENT_METHOD_OPTIONS.filter(
            (option) =>
                !paymentCreateRequestSchema.safeParse({ method: option.method })
                    .success
        ).map((option) => option.method);

        // Named rather than boolean, so a failure says WHICH method became unpayable.
        expect(rejected).toEqual([]);
    });

    test("the exported method list IS the catalog's, not a second copy", () => {
        expect([...PURCHASABLE_PAYMENT_METHODS]).toEqual([
            ...PURCHASABLE_METHOD_VALUES,
        ]);
    });

    test("every method the schema accepts is actually offerable", () => {
        for (const method of PURCHASABLE_PAYMENT_METHODS) {
            expect(findPaymentMethodOption(method)).not.toBeNull();
        }
    });

    test("the retired names the schema used to demand are gone", () => {
        // `E_WALLET` and `BANK_TRANSFER` were in the old hand-written enum and are not
        // purchasable here: the provider exposes e-wallets as the QRIS channel, and a bank
        // transfer is a VIRTUAL_ACCOUNT. Leaving either in the accepted set would keep a
        // method a caller could submit that no picker ever offers.
        for (const retired of ["E_WALLET", "BANK_TRANSFER"]) {
            expect(findPaymentMethodOption(retired)).toBeNull();
            expect([...PURCHASABLE_PAYMENT_METHODS]).not.toContain(retired);
            expect(
                paymentCreateRequestSchema.safeParse({ method: retired }).success
            ).toBe(false);
        }
    });

    test("the request schema still declares no financial or identity field", () => {
        const source = code(read("lib/ticketing/payment/validation.ts"));

        for (const banned of [
            "amount",
            "total",
            "subtotal",
            "currency",
            "price",
            "organizerId",
            "userId",
            "orderId",
        ]) {
            expect(source).not.toMatch(new RegExp(`\\b${banned}:\\s*z\\.`));
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Selection: never an empty channel, never a mislabelled method
// ─────────────────────────────────────────────────────────────────────────────

describe("resolving a payment selection", () => {
    test("every catalogued method resolves to a non-empty channel it actually has", () => {
        for (const option of PAYMENT_METHOD_OPTIONS) {
            const selection = resolvePaymentSelection(option.method, null);

            // An empty string is not "no channel" — it is a field iPaymu drops before
            // hashing, which turns the request into a 401. It must never be produced.
            expect(selection.channel).not.toBe("");
            expect(channelIsAllowed(option.method, selection.channel)).toBe(true);
        }
    });

    test("a catalogued method is recorded as the buyer's own choice", () => {
        for (const option of PAYMENT_METHOD_OPTIONS) {
            expect(resolvePaymentSelection(option.method, null).method).toBe(
                option.method
            );
        }
    });

    test("credit card resolves to cc/cc and is never booked as a bank transfer", () => {
        const selection = resolvePaymentSelection("CREDIT_CARD", null);

        expect(selection).toEqual({ method: "CREDIT_CARD", channel: "cc" });
        // The historical mapper has no `cc` bucket and defaulted to BANK_TRANSFER; a
        // credit-card payment must not be recorded as one.
        expect(selection.method).not.toBe("BANK_TRANSFER");
    });

    test("the documented provider mapping per method is unchanged", () => {
        expect(resolvePaymentSelection("QRIS", null)).toEqual({
            method: "QRIS",
            channel: "mpm",
        });
        expect(resolvePaymentSelection("VIRTUAL_ACCOUNT", null)).toEqual({
            method: "VIRTUAL_ACCOUNT",
            channel: "bca",
        });
        expect(resolvePaymentSelection("RETAIL_OUTLET", null)).toEqual({
            method: "RETAIL_OUTLET",
            channel: "alfamart",
        });
    });

    test("a channel from another method is refused, never silently swapped", () => {
        // The service checks this before the gateway is contacted (`createOrderPayment`),
        // so a buyer who chose BNI can never be handed a BCA number.
        expect(channelIsAllowed("QRIS", "bca")).toBe(false);
        expect(channelIsAllowed("CREDIT_CARD", "bca")).toBe(false);
        expect(channelIsAllowed("RETAIL_OUTLET", "bca")).toBe(false);
        expect(channelIsAllowed("VIRTUAL_ACCOUNT", "bca")).toBe(true);
        expect(channelIsAllowed("RETAIL_OUTLET", "indomaret")).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The redirect session keeps the provider's own session id
// ─────────────────────────────────────────────────────────────────────────────

describe("the hosted-page session id survives the provider's own casing", () => {
    const oldEnv = { ...process.env };

    afterEach(() => {
        resetIpaymuConfigCache();
        process.env = { ...oldEnv };
        jest.restoreAllMocks();
    });

    test("iPaymu answers `SessionID` and the id is persisted, not discarded", async () => {
        process.env = {
            ...process.env,
            PAYMENT_ENVIRONMENT: "sandbox",
            IPAYMU_SANDBOX_VA: "1234567890",
            IPAYMU_SANDBOX_API_KEY: "PKEY_0123456789",
        };
        resetIpaymuConfigCache();

        // The debug logging the transport does outside production is noise here.
        jest.spyOn(console, "log").mockImplementation(() => undefined);

        const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
            new Response(
                JSON.stringify({
                    Status: 200,
                    Message: "Success",
                    // Verbatim from a live sandbox call: capital D.
                    Data: {
                        SessionID: "SES-1",
                        Url: "https://sandbox.ipaymu.com/payment/SES-1",
                    },
                }),
                { status: 200, headers: { "content-type": "application/json" } }
            )
        );

        const result = await createSession({
            referenceId: "EVT-TEST-1-1",
            amount: "10000.00",
            currency: "IDR",
            buyerName: "Buyer",
            buyerEmail: "buyer@example.test",
            buyerPhone: "081234567890",
            items: [{ name: "Tiket", quantity: 1, unitPrice: "10000.00" }],
            notifyUrl: "https://example.test/api/ticketing/payment/webhook",
            returnUrl: "https://example.test/ticketing/orders/EVT-TEST-1",
            cancelUrl: "https://example.test/ticketing/orders/EVT-TEST-1",
            method: "CREDIT_CARD",
            channel: null,
            ttlMinutes: 30,
        });

        expect(result.ok).toBe(true);

        if (!result.ok) {
            return;
        }

        expect(result.session.providerSessionId).toBe("SES-1");
        expect(result.session.paymentUrl).toBe(
            "https://sandbox.ipaymu.com/payment/SES-1"
        );

        // What actually went on the wire, for the method that used to 401.
        const call = fetchSpy.mock.calls[0] as unknown as [
            string,
            { body: string },
        ];
        const sent = JSON.parse(call[1].body) as Record<string, unknown>;

        expect(sent.paymentMethod).toBe("cc");
        expect(sent.paymentChannel).toBe("cc");
        expect(sent.paymentChannel).not.toBe("");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. One configuration source, and no legacy env surface
// ─────────────────────────────────────────────────────────────────────────────

describe("the payment transport has exactly one configuration source", () => {
    test("no second config object reads the retired environment names", () => {
        const source = code(read("lib/payment/ipaymu.ts"));

        expect(source).not.toMatch(/IPAYMU_CONFIG/);
        expect(source).not.toMatch(/process\.env\.IPAYMU_API_KEY/);
        expect(source).not.toMatch(/process\.env\.IPAYMU_VA\b/);
        expect(source).not.toMatch(/process\.env\.IPAYMU_URL/);
        expect(source).not.toMatch(/process\.env\.IPAYMU_IS_PRODUCTION/);

        // …because it resolves through the strict, environment-aware resolver instead.
        expect(source).toMatch(/getIpaymuConfig\(\)/);
    });

    test("the ticketing payment layer never reads process.env for credentials", () => {
        const dir = path.join(ROOT, "lib/ticketing/payment");
        const files = fs
            .readdirSync(dir)
            .filter((name) => name.endsWith(".ts"));

        for (const name of files) {
            const source = code(read(`lib/ticketing/payment/${name}`));

            expect(source).not.toMatch(/process\.env\.IPAYMU_/);
            expect(source).not.toMatch(/IPAYMU_CONFIG/);
        }
    });
});
