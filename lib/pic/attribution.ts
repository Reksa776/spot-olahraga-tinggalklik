/**
 * ==========================================
 * PIC ATTRIBUTION — resolver + EARNED poster
 * ==========================================
 *
 * PIC Vertical Slice V1. The two server-side things an order needs, both sharing the
 * frozen-at-checkout snapshots:
 *
 *    1. `resolveReferralAtCheckout(input)` — the ONLY place a share token becomes money
 *       intent. Runs inside the checkout transaction. Verify the token, then re-check the
 *       CURRENT pic/assignment facts, resolve the fee config, price every line, and return
 *       the attribution snapshot bundle the order is persisted against.
 *    2. `postEarnedPicFees(input)` — settlement's SETTLED hook. REPLAYS the item snapshots
 *       into EARNED `PICFeeLedger` rows; never recomputes a fee.
 */

import { Prisma } from "@prisma/client";
import type { FeeBasisType, PICFeeType } from "@prisma/client";

import { prisma } from "@/lib/prisma";

import {
    computeLinePicFee,
    DEFAULT_PIC_FEE_BASIS,
    resolvePicFeeConfig,
    type PicFeeConfig,
} from "./fee";
import { verifyPicReferralTokenForEvent } from "./referral";

/** Minimal db surface so callers can hand us a transaction. */
export type PicDb = Prisma.TransactionClient | typeof prisma;

export interface PicReferralLineInput {
    ticketTypeId: string;
    quantity: number;
    /** Pre-discount line subtotal (whole rupiah). */
    lineSubtotal: Prisma.Decimal | string;
}

export interface ResolveReferralAtCheckoutInput {
    /** Raw `?pic=`/shareToken value from the request. */
    shareToken: string | null | undefined;
    eventId: string;
    /** Order-wide gross subtotal (sum of line subtotals), for discount allocation. */
    orderSubtotal: Prisma.Decimal | string;
    /** Order-wide discount in rupiah (0 today). */
    discount: Prisma.Decimal | string;
    lines: PicReferralLineInput[];
    /** The buying user, when known — used only for the self-referral flag. */
    buyerUserId?: string;
}

export interface ResolveReferralAtCheckoutLineResult {
    ticketTypeId: string;
    /** Whole-rupiah fee for this line. */
    fee: Prisma.Decimal;
    /** The basis the fee was applied to (snapshot). */
    basisAmount: Prisma.Decimal;
}

export interface ResolveReferralAtCheckoutResult {
    picProfileId: string;
    /** True when the buyer is the PIC's own account (design §14.6 self-referral nod). */
    selfReferral: boolean;
    feeConfig: PicFeeConfig;
    lines: ResolveReferralAtCheckoutLineResult[];
    /** Whole-rupiah total of all line fees. */
    picFeeTotal: Prisma.Decimal;
}

/**
 * Resolve a checkout referral to a validated attribution + fee snapshots.
 *
 * Runs inside the checkout transaction. Read-only (no writes here — the order create in
 * checkout persists everything), idempotent, and FAIL-CLOSED: every non-attributable
 * shape returns `null` and the sale continues as a normal no-PIC order.
 *
 * Authorization is re-verified against CURRENT rows — the token is only a signed handle:
 *    - token verifies, is the right version, and names THIS event;
 *    - the PIC profile exists and is `ACTIVE`;
 *    - the event assignment exists, `isActive`, and not revoked;
 *    - the buyer (when known) is not the PIC's own account — the design records
 *      self-referral (§14.6) rather than blocking, and `selfReferral` is returned for
 *      that attribution row.
 */
export async function resolveReferralAtCheckout(
    input: ResolveReferralAtCheckoutInput,
    db: PicDb = prisma
): Promise<ResolveReferralAtCheckoutResult | null> {
    if (!input.shareToken || input.lines.length === 0) {
        return null;
    }

    const payload = verifyPicReferralTokenForEvent(input.shareToken, input.eventId);
    if (!payload) {
        return null;
    }

    const assignment = await db.pICEventAssignment.findUnique({
        where: {
            picProfileId_eventId: {
                picProfileId: payload.picProfileId,
                eventId: payload.eventId,
            },
        },
        select: {
            isActive: true,
            revokedAt: true,
            feeRateBp: true,
            feeTypeOverride: true,
            picProfile: {
                select: {
                    id: true,
                    userId: true,
                    status: true,
                    defaultFeeRateBp: true,
                },
            },
        },
    });

    if (
        !assignment ||
        !assignment.isActive ||
        assignment.revokedAt ||
        assignment.picProfile.status !== "ACTIVE"
    ) {
        return null;
    }

    const platformSetting = await db.platformSetting.findFirst({
        select: { defaultPicFeeRateBp: true },
    });

    const config = resolvePicFeeConfig({
        feeRateBp: assignment.feeRateBp,
        feeTypeOverride: assignment.feeTypeOverride,
        // The assignment has no fixedAmount column in this slice — rate-only V1.
        fixedAmount: null,
        profileDefaultFeeRateBp: assignment.picProfile.defaultFeeRateBp,
        platformDefaultFeeRateBp: platformSetting?.defaultPicFeeRateBp ?? 0,
    });

    const orderSubtotal = new Prisma.Decimal(input.orderSubtotal);
    const discount = new Prisma.Decimal(input.discount);

    const lines = input.lines.map((line) => {
        const { fee, basisAmount } = computeLinePicFee({
            lineSubtotal: line.lineSubtotal,
            quantity: line.quantity,
            orderSubtotal,
            discount,
            config,
        });
        return { ticketTypeId: line.ticketTypeId, fee, basisAmount };
    });

    const picFeeTotal = lines.reduce(
        (sum, line) => sum.add(line.fee),
        new Prisma.Decimal(0)
    );

    return {
        picProfileId: assignment.picProfile.id,
        selfReferral: !!input.buyerUserId && input.buyerUserId === assignment.picProfile.userId,
        feeConfig: config,
        lines,
        picFeeTotal: picFeeTotal.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP),
    };
}

/* ============================================================================
 * SETTLEMENT HOOK — post EARNED rows (Phase 9)
 * ============================================================================
 */

export interface EventOrderItemPicFeeSnapshot {
    id: string;
    ticketTypeId: string | null;
    quantity: number;
    picFeeAmount: Prisma.Decimal | null;
    picFeeType: PICFeeType | null;
    basisType: FeeBasisType | null;
    rateBp: number | null;
    fixedAmount: Prisma.Decimal | null;
    basisAmount: Prisma.Decimal | null;
}

export interface PostEarnedPicFeesInput {
    db: PicDb;
    order: { id: string; organizerId: string; eventId: string; currency: string };
    items: EventOrderItemPicFeeSnapshot[];
}

/**
 * Post EARNED `PICFeeLedger` rows for a settled order, replaying item snapshots.
 *
 * Called by settlement's SETTLED branch, in the same transaction WITHOUT board. Skips the
 * order entirely when it has no attribution (a non-PIC order), and skips any item whose
 * `picFeeAmount` is null/<=0. Because checkout persisted the snapshots and the order's
 * `picFeeTotal`, this posting is a REPLAY: `Σ EARNED.amount == order.picFeeTotal` by
 * construction, and a later rate change cannot rewrite it. Idempotent via
 * `idempotencyKey = fee:earned:{orderItemId}` + the `@@unique([orderItemId, type])`
 * guard.
 */
export async function postEarnedPicFees(input: PostEarnedPicFeesInput): Promise<void> {
    const db = input.db;

    const attribution = await db.pICAttribution.findUnique({
        where: { orderId: input.order.id },
        select: { id: true, picProfileId: true },
    });
    if (!attribution) {
        // No attribution → this is a non-PIC order; nothing to post. (Design: attribution
        // is the ONLY trigger — a fee needs the buyer to have come through a PIC.)
        return;
    }

    for (const item of input.items) {
        const amount = item.picFeeAmount ? new Prisma.Decimal(item.picFeeAmount) : null;
        if (!amount || amount.lte(0)) {
            continue;
        }
        await db.pICFeeLedger.create({
            data: {
                picProfileId: attribution.picProfileId,
                organizerId: input.order.organizerId,
                eventId: input.order.eventId,
                orderId: input.order.id,
                orderItemId: item.id,
                // The reversal path (`reversePicFeesForRefund`) copies ticketTypeId and
                // attributionId FROM the EARNED row, so both must be set here.
                ticketTypeId: item.ticketTypeId,
                attributionId: attribution.id,
                type: "EARNED",
                direction: "CREDIT",
                amount,
                currency: input.order.currency,
                feeType: item.picFeeType ?? "PERCENTAGE",
                rateBp: item.rateBp,
                fixedAmount: item.fixedAmount,
                basisType: item.basisType ?? DEFAULT_PIC_FEE_BASIS,
                basisAmount: item.basisAmount ?? amount,
                quantity: item.quantity,
                status: "EARNED",
                idempotencyKey: `fee:earned:${item.id}`,
            },
        });
    }
}