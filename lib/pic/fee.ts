/**
 * ==========================================
 * PIC FEE ENGINE (pure, no I/O)
 * ==========================================
 *
 * PIC Vertical Slice V1 — the only place a PIC fee is ever computed. Deliberately pure:
 * no Prisma client, no environment, no I/O. `Prisma.Decimal` end to end, rupiah as a
 * whole number, rounded half-up once at persist time — the same discipline as checkout's
 * `roundToRupiah`, so `picFeeTotal == Σ line fees` holds by construction, not by
 * tolerance.
 *
 * THE TWO PUBLIC CONTRACTS ──────────────────────────────────────────────────────────────
 *
 *   1) `resolvePicFeeConfig(input)` — which rate/type/fixed a checkout actually inherits.
 *
 *      Inheritance (mirrors the `feeRateBp` schema comments and design D-24):
 *
 *          rateBp       assignment.feeRateBp                       (per-event override)
 *                     ?? profile.defaultFeeRateBp (>0 = owned) ... profile carries the rate
 *                     ?? platformSetting.defaultPicFeeRateBp       (platform fallback)
 *                     ?? 0                                        (no fee configured)
 *
 *      Note the two middle tiers only count when strictly POSITIVE — the schema defines
 *      `0` as "inherit", so a configured-but-zero platform rate never suppresses a real
 *      profile rate. `feeTypeOverride` exists only at the assignment tier (FIXED/HYBRID are
 *      per-event type decisions, never global). `fixedAmount` has NO schema column in this
 *      slice — `PICEventAssignment` carries only `feeRateBp` + `feeTypeOverride` — so V1 is
 *      rate-only in practice; the input keeps the field so a FIXED/HYBRID configuration can
 *      flow through the same path the day the schema grows one, and the resolver always
 *      supplies `null` today.
 *
 *   2) `computeLinePicFee(input)` — the fee for ONE order line plus the basis it was
 *      applied to (snapshot fields for the ledger).
 *
 *      BASIS (design §15.1; `FeeBasisType`):
 *          GROSS_BEFORE_DISCOUNT  line subtotal, before any order discount.
 *          GROSS_AFTER_DISCOUNT   line subtotal minus a proportional share of the order
 *                                 discount. Discount is 0 today, so this equals the
 *                                 gross — the allocation path is still implemented and
 *                                 unit-tested so the engine is not a one-shape fixture.
 *          NET_AFTER_GATEWAY      treated as GROSS_AFTER_DISCOUNT. The gateway fee is a
 *                                 `PaymentTransaction` fact, not an order field, so it is
 *                                 never knowable at checkout; the D-22 (fee from a
 *                                 settled transaction) variant is documented in the
 *                                 implementation report as deliberately out of slice.
 *
 *      FEE (design D-21; never compounded — components ADD):
 *          PERCENTAGE  rateBp × basis / 10_000
 *          FIXED       fixedAmount × quantity                 (per ticket)
 *          HYBRID      rateBp × basis / 10_000 + fixedAmount × quantity
 *
 * The slice fixes the basis at GROSS_BEFORE_DISCOUNT (the defensible default at checkout)
 * while the engine supports all three, so a later config switch needs no math changes and
 * the GROSS_AFTER_DISCOUNT branch is executable by tests rather than dead by design.
 */

import { Prisma } from "@prisma/client";
import type { FeeBasisType, PICFeeType } from "@prisma/client";

/** The basis every referral checkout in this slice uses (design §15.3). */
export const DEFAULT_PIC_FEE_BASIS: FeeBasisType = "GROSS_BEFORE_DISCOUNT";

/** Whole-rupiah, half-up — the single rounding point (matches checkout's `roundToRupiah`). */
export function roundToRupiah(value: Prisma.Decimal | string | number): Prisma.Decimal {
    return new Prisma.Decimal(value).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
}

/** A configured per-event assignment fee (the override surface). */
export interface PicAssignmentConfigInput {
    /** `PICEventAssignment.feeRateBp` — `null` means inherit. */
    feeRateBp: number | null;
    /** `PICEventAssignment.feeTypeOverride` — `null` means PERCENTAGE. */
    feeTypeOverride: PICFeeType | null;
    /** Per-ticket fixed rupiah for FIXED/HYBRID; the assignment has no column for it in
     * this slice, so `resolvePicFeeConfig` always receives `null` and V1 is rate-only. */
    fixedAmount: Prisma.Decimal | string | number | null;
    /** `PICProfile.defaultFeeRateBp` — `0` means inherit. */
    profileDefaultFeeRateBp: number;
    /** `PlatformSetting.defaultPicFeeRateBp` — `0` means none. */
    platformDefaultFeeRateBp: number;
}

export interface PicFeeConfig {
    feeType: PICFeeType;
    /** Basis points resolved by the inheritance chain. */
    rateBp: number;
    /** Per-ticket fixed rupiah for FIXED/HYBRID; 0 for PERCENTAGE. */
    fixedAmount: Prisma.Decimal;
    basisType: FeeBasisType;
}

/* Resolve the config a checkout actually inherits (frozen at checkout). */
export function resolvePicFeeConfig(input: PicAssignmentConfigInput): PicFeeConfig {
    const rateBp =
        input.feeRateBp ??
        (input.profileDefaultFeeRateBp > 0 ? input.profileDefaultFeeRateBp : null) ??
        (input.platformDefaultFeeRateBp > 0 ? input.platformDefaultFeeRateBp : null) ??
        0;

    return {
        feeType: input.feeTypeOverride ?? "PERCENTAGE",
        rateBp,
        fixedAmount: roundToRupiah(input.fixedAmount ?? 0),
        basisType: DEFAULT_PIC_FEE_BASIS,
    };
}

export interface ComputeLinePicFeeInput {
    /** Pre-discount line subtotal (whole rupiah). */
    lineSubtotal: Prisma.Decimal | string;
    quantity: number;
    /** Order-wide gross subtotal (affects discount allocation only). */
    orderSubtotal: Prisma.Decimal | string;
    /** Order-wide discount in rupiah (0 today's checkout). */
    discount: Prisma.Decimal | string;
    config: PicFeeConfig;
}

export interface ComputedLinePicFee {
    /** The fee for the whole line, whole rupiah, half-up rounded. */
    fee: Prisma.Decimal;
    /** The basis it was applied to, whole rupiah — snapshot for the ledger. */
    basisAmount: Prisma.Decimal;
}

/**
 * Compute the fee for ONE order line.
 *
 * The basis is frozen at checkout so the later EARNED posting and the full-item refund
 * reversal are REPLAYS of this snapshot set — never a recomputation under rates that may
 * have changed in between (the reason every fee value, and the basis it rested on, is
 * persisted as snapshots).
 */
export function computeLinePicFee(input: ComputeLinePicFeeInput): ComputedLinePicFee {
    const lineSubtotal = new Prisma.Decimal(input.lineSubtotal);
    const orderSubtotal = new Prisma.Decimal(input.orderSubtotal);
    const discount = new Prisma.Decimal(input.discount);

    let basis = lineSubtotal;
    if (
        input.config.basisType === "GROSS_AFTER_DISCOUNT" &&
        orderSubtotal.gt(0) &&
        discount.gt(0) &&
        discount.lte(orderSubtotal)
    ) {
        // Proportional share of the order discount for THIS line, rounded whole-rupiah.
        const lineShare = roundToRupiah(lineSubtotal.mul(discount).div(orderSubtotal));
        basis = roundToRupiah(lineSubtotal.sub(lineShare));
    }
    // NET_AFTER_GATEWAY deliberately falls through to the gross (documented at the top).

    let fee = new Prisma.Decimal(0);
    if (input.config.feeType === "PERCENTAGE" || input.config.feeType === "HYBRID") {
        fee = roundToRupiah(basis.mul(input.config.rateBp).div(10000));
    }
    if (input.config.feeType === "FIXED" || input.config.feeType === "HYBRID") {
        fee = roundToRupiah(fee.add(input.config.fixedAmount.mul(input.quantity)));
    }

    return { fee, basisAmount: basis };
}