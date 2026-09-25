/**
 * ==========================================
 * PIC VERTICAL SLICE — FEE ENGINE (PURE)
 * ==========================================
 *
 * `lib/pic/fee.ts` is the only place a PIC fee is ever computed. These tests pin the
 * inheritance chain, the rounding discipline (whole rupiah, half-up, once), the basis
 * allocation, and the regression against the planted `02` fallback bug — when nothing is
 * configured the rate MUST be 0, not 2.
 */

import { Prisma } from "@prisma/client";

import {
    computeLinePicFee,
    resolvePicFeeConfig,
    roundToRupiah,
    type PicAssignmentConfigInput,
    type PicFeeConfig,
} from "@/lib/pic/fee";

const noFee = (overrides: Partial<PicAssignmentConfigInput> = {}) =>
    ({
        feeRateBp: null,
        feeTypeOverride: null,
        fixedAmount: null,
        profileDefaultFeeRateBp: 0,
        platformDefaultFeeRateBp: 0,
        ...overrides,
    } as PicAssignmentConfigInput);

function feeString(decimal: Prisma.Decimal): string {
    return decimal.toFixed(2);
}

describe("resolvePicFeeConfig — the inheritance chain", () => {
    test("the assignment rate wins outright", () => {
        const config = resolvePicFeeConfig(
            noFee({ feeRateBp: 700, profileDefaultFeeRateBp: 500, platformDefaultFeeRateBp: 300 })
        );

        expect(config.rateBp).toBe(700);
    });

    test("a positive profile default is inherited when the assignment does not set one", () => {
        const config = resolvePicFeeConfig(noFee({ profileDefaultFeeRateBp: 500 }));

        expect(config.rateBp).toBe(500);
    });

    test("the platform default is the last real tier", () => {
        const config = resolvePicFeeConfig(noFee({ platformDefaultFeeRateBp: 300 }));

        expect(config.rateBp).toBe(300);
    });

    test("REGRESSION: an all-null/all-zero config resolves to 0, never to the planted 02", () => {
        const config = resolvePicFeeConfig(noFee());

        expect(config.rateBp).toBe(0);
    });

    test("a configured-but-zero profile default does not suppress the platform fallback", () => {
        const config = resolvePicFeeConfig(noFee({ platformDefaultFeeRateBp: 300 }));

        expect(config.rateBp).toBe(300);
    });

    test("a zero platform default never suppresses the profile default", () => {
        const config = resolvePicFeeConfig(noFee({ profileDefaultFeeRateBp: 500 }));

        expect(config.rateBp).toBe(500);
    });

    test("feeTypeOverride is the only type source (PERCENTAGE is the default)", () => {
        expect(resolvePicFeeConfig(noFee()).feeType).toBe("PERCENTAGE");
        expect(
            resolvePicFeeConfig(noFee({ feeTypeOverride: "HYBRID" })).feeType
        ).toBe("HYBRID");
    });

    test("the basis is fixed at GROSS_BEFORE_DISCOUNT for this slice", () => {
        expect(resolvePicFeeConfig(noFee()).basisType).toBe("GROSS_BEFORE_DISCOUNT");
    });
});

describe("computeLinePicFee — the money math", () => {
    // The fixture that the checkout/refund integration tests reuse: 150000 × 2, rate 500.
    test("PERCENTAGE: rateBp × basis / 10_000, rounded once", () => {
        const config = resolvePicFeeConfig(noFee({ feeRateBp: 500 }));
        const { fee, basisAmount } = computeLinePicFee({
            lineSubtotal: "300000.00",
            quantity: 2,
            orderSubtotal: "300000.00",
            discount: "0",
            config,
        });

        expect(feeString(fee)).toBe("15000.00");
        expect(feeString(basisAmount)).toBe("300000.00");
    });

    test("FIXED: fixedAmount × quantity", () => {
        const config = resolvePicFeeConfig(
            noFee({ feeTypeOverride: "FIXED", fixedAmount: 2500, feeRateBp: null })
        );

        const { fee } = computeLinePicFee({
            lineSubtotal: "100000.00",
            quantity: 3,
            orderSubtotal: "100000.00",
            discount: "0",
            config,
        });

        expect(feeString(fee)).toBe("7500.00");
    });

    test("HYBRID: the two components ADD, never compound", () => {
        const config = resolvePicFeeConfig(
            noFee({ feeTypeOverride: "HYBRID", fixedAmount: 1000, feeRateBp: 500 })
        );

        const { fee } = computeLinePicFee({
            lineSubtotal: "200000.00",
            quantity: 2,
            orderSubtotal: "200000.00",
            discount: "0",
            config,
        });

        // 5% of 200000 = 10000 … + 1000 × 2 = 12000
        expect(feeString(fee)).toBe("12000.00");
    });

    test("a 0 rate yields a 0 fee", () => {
        const config = resolvePicFeeConfig(noFee());
        const { fee } = computeLinePicFee({
            lineSubtotal: "300000.00",
            quantity: 2,
            orderSubtotal: "300000.00",
            discount: "0",
            config,
        });

        expect(feeString(fee)).toBe("0.00");
    });

    test("GROSS_AFTER_DISCOUNT allocates the discount proportionally", () => {
        const config: PicFeeConfig = {
            feeType: "PERCENTAGE",
            rateBp: 1000,
            fixedAmount: new Prisma.Decimal(0),
            basisType: "GROSS_AFTER_DISCOUNT",
        };

        // Two lines of 10000 each, order discount 10000 (half off the whole order): each
        // line's allocated share is 5000, so each fee is 10% of 5000 = 500.
        const lineA = computeLinePicFee({
            lineSubtotal: "10000.00",
            quantity: 1,
            orderSubtotal: "20000.00",
            discount: "10000.00",
            config,
        });
        const lineB = computeLinePicFee({
            lineSubtotal: "10000.00",
            quantity: 1,
            orderSubtotal: "20000.00",
            discount: "10000.00",
            config,
        });

        expect(feeString(lineA.fee)).toBe("500.00");
        expect(feeString(lineA.basisAmount)).toBe("5000.00");
        expect(feeString(lineB.fee)).toBe("500.00");
    });

    test("NET_AFTER_GATEWAY falls through to the gross (documented D-22 scope)", () => {
        const config: PicFeeConfig = {
            feeType: "PERCENTAGE",
            rateBp: 500,
            fixedAmount: new Prisma.Decimal(0),
            basisType: "NET_AFTER_GATEWAY",
        };

        const { fee, basisAmount } = computeLinePicFee({
            lineSubtotal: "100000.00",
            quantity: 1,
            orderSubtotal: "100000.00",
            discount: "0",
            config,
        });

        expect(feeString(basisAmount)).toBe("100000.00");
        expect(feeString(fee)).toBe("5000.00");
    });

    test("rounding is half-up to whole rupiah, once", () => {
        const config = resolvePicFeeConfig(noFee({ feeRateBp: 1 }));
        const run = (lineSubtotal: string) =>
            computeLinePicFee({
                lineSubtotal,
                quantity: 3,
                orderSubtotal: lineSubtotal,
                discount: "0",
                config,
            }).fee;

        // 165000 × 1 bp = 16.5 → 17 (half-up). 164999 × 1 bp = 16.4999 → 16.
        expect(feeString(run("165000.00"))).toBe("17.00");
        expect(feeString(run("164999.00"))).toBe("16.00");
    });
});

describe("roundToRupiah", () => {
    test("matches checkout's rounding discipline", () => {
        expect(feeString(roundToRupiah("100.499"))).toBe("100.00");
        expect(feeString(roundToRupiah("100.5"))).toBe("101.00");
        expect(feeString(roundToRupiah("-100.5"))).toBe("-101.00");
    });
});