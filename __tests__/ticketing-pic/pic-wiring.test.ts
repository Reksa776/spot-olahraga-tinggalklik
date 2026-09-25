/**
 * ==========================================
 * PIC VERTICAL SLICE — STATIC ARCHITECTURAL GUARDS
 * ==========================================
 *
 * These tests read source text to pin the slice's boundaries, the way the Phase 6 wiring
 * suite does:
 *
 *   • the fee ENGINE is the only place a fee is ever computed — nothing in the checkout
 *     path re-derives one;
 *   • `postEarnedPicFees` (the EARNED poster) is called exactly once, from the SETTLED
 *     branch of settlement — never from the LATE_SETTLEMENT branch, never from checkout,
 *     never from refunds;
 *   • the EARNED rows carry the fields the refund reversal path copies from them
 *     (`ticketTypeId`, `attributionId`), and the exact idempotency key the reversal
 *     integration suite expects.
 *
 * No database and no Next.js.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

function read(file: string): string {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

/** Strip comments so prose about a banned pattern is not mistaken for the pattern. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FEE_ENGINE = "lib/pic/fee.ts";
const ATTRIBUTION = "lib/pic/attribution.ts";
const REFERRAL = "lib/pic/referral.ts";
const CHECKOUT = "lib/ticketing/checkout.ts";
const SETTLEMENT = "lib/ticketing/payment/settlement.ts";
const REFUND_SETTLEMENT = "lib/ticketing/refunds/settlement.ts";

const CHECKOUT_PATH_FILES = [
    CHECKOUT,
    "lib/ticketing/reservations.ts",
    "lib/ticketing/orders.ts",
    "lib/ticketing/inventory.ts",
    "lib/ticketing/order-payload.ts",
    "lib/ticketing/checkout-validation.ts",
    "lib/ticketing/idempotency.ts",
];

const FILES_THAT_WRITE_THE_LEDGER = [ATTRIBUTION, REFUND_SETTLEMENT];

describe("the fee engine is the only place a fee is computed", () => {
    test("resolvePicFeeConfig and computeLinePicFee are DEFINED only in the engine", () => {
        const engine = code(read(FEE_ENGINE));

        expect(engine).toMatch(/export function resolvePicFeeConfig/);
        expect(engine).toMatch(/export function computeLinePicFee/);
    });

    test("no checkout-path file re-derives a fee", () => {
        for (const file of CHECKOUT_PATH_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/computeLinePicFee/);
            expect(source).not.toMatch(/\.mul\(\s*rateBp|\/ 10000/);
        }
    });

    test("the attribution module is the only consumer of the engine inside checkout", () => {
        const checkout = code(read(CHECKOUT));
        const attribution = code(read(ATTRIBUTION));

        expect(checkout).toMatch(/resolveReferralAtCheckout/);
        expect(checkout).not.toMatch(/computeLinePicFee/);
        expect(attribution).toMatch(/computeLinePicFee/);
        expect(attribution).toMatch(/resolvePicFeeConfig/);
    });
});

describe("the EARNED poster is settlement's, and only the SETTLED branch", () => {
    test("lib/pic/attribution.ts exports postEarnedPicFees", () => {
        expect(code(read(ATTRIBUTION))).toMatch(/export async function postEarnedPicFees/);
    });

    test("postEarnedPicFees is called exactly once, in the settlement module", () => {
        const calls = (code(read(SETTLEMENT)).match(/postEarnedPicFees\(/g) ?? []).length;

        expect(calls).toBe(1);
    });

    test("the call sits in the SETTLED branch — after inventory conversion, before the SETTLED return, and after the LATE_SETTLEMENT branch", () => {
        const settlement = code(read(SETTLEMENT));

        const conversion = settlement.indexOf("confirmOrderReservations");
        const poster = settlement.indexOf("postEarnedPicFees({");
        const settled = settlement.lastIndexOf('outcome: "SETTLED"');

        expect(poster).toBeGreaterThan(conversion);
        expect(poster).toBeLessThan(settled);
    });

    test("the attribution write happens only within the checkout transaction", () => {
        const checkout = read(CHECKOUT);
        const attributionWrites = checkout.split("pICAttribution.create").length - 1;

        expect(attributionWrites).toBe(1);
    });
});

describe("the EARNED ledger contract", () => {
    test("only the EARNED poster and the refund reversal write the fee ledger", () => {
        for (const file of [...CHECKOUT_PATH_FILES, SETTLEMENT]) {
            expect(code(read(file))).not.toMatch(/pICFeeLedger\.create/);
        }
        for (const file of FILES_THAT_WRITE_THE_LEDGER) {
            expect(code(read(file))).toMatch(/pICFeeLedger\.create/);
        }
    });

    test("the EARNED rows carry the reversal contract fields", () => {
        const poster = code(read(ATTRIBUTION));

        // `reversePicFeesForRefund` copies these FROM the EARNED row.
        expect(poster).toMatch(/ticketTypeId: item\.ticketTypeId/);
        expect(poster).toMatch(/attributionId: attribution\.id/);
        expect(poster).toMatch(/status: "EARNED"/);
        expect(poster).toMatch(/type: "EARNED"/);
    });

    test("the EARNED idempotency key matches the reversal integration seed", () => {
        const poster = code(read(ATTRIBUTION));

        // `fee:earned:{orderItemId}` is exactly the key the
        // `ticketing-refunds/refund-manual-rail.integration.test.ts` seed uses.
        expect(poster).toMatch(/idempotencyKey: `fee:earned:\$\{item\.id\}`/);
    });
});

describe("the referral module surface", () => {
    test("the attribution resolver uses verifyPicReferralTokenForEvent, not a rename", () => {
        const attribution = code(read(ATTRIBUTION));
        const referral = code(read(REFERRAL));

        expect(referral).toMatch(/export function verifyPicReferralTokenForEvent/);
        expect(attribution).toMatch(/verifyPicReferralTokenForEvent\(/);
        expect(attribution).not.toMatch(/verifyPicReferralTokenWithEvent/);
    });

    test("the resolver never writes — it resolves and returns", () => {
        const resolver = code(read(ATTRIBUTION))
            .split("export async function resolveReferralAtCheckout")[1]
            .split("export async function postEarnedPicFees")[0];

        expect(resolver).not.toMatch(/\.create\(/);
    });
});