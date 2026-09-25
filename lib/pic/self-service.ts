import { Prisma, type PICStatus } from "@prisma/client";

import {
    AuthzError,
    AuthzErrorCode,
    PERMISSIONS,
    decideOwnResourcePermission,
    requireAuth,
    type AuthzScope,
    type Permission,
} from "@/lib/authz";
import { mintPicReferralToken } from "@/lib/pic/referral";
import { getPicLedgerBalance } from "@/lib/pic/ledger";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * PIC SELF-SERVICE (READ-ONLY)
 * ==========================================
 *
 * A PIC's own view of their referrer business, served to the PIC themselves. This is the
 * service behind `app/dashboard/pic`'s third branch (PIC SELF-SERVICE DASHBOARD V1). It
 * reads assignments, referral links, attributions, sales and the posted fee ledger — and
 * NOTHING else. Every function here is read-only, and every query is scoped by the ACTIVE
 * `PICProfile` resolved from the session user. No function accepts a `picProfileId`,
 * `eventId`, `organizerId` or money figure from the caller; the ONLY input that ever names
 * a record is the session user id (for ownership checks) and, for a referral-link lookup,
 * an `eventId` that is re-authorized against the caller's own profile + an active
 * assignment before anything is minted.
 *
 * ── THE `requireMyPic` GUARD (one definition of "who is the PIC") ────────────────
 * Every function funnels through a single fail-closed guard that establishes, in order:
 *
 *    1. requireAuth()                     → an authenticated, server-side scope; otherwise
 *                                           UNAUTHORIZED.
 *    2. identity:  `scope.userId === userId`  → the `userId` argument is a routing key,
 *                                           never an authority. A forged id (naming another
 *                                           user's records) is `PIC_ACCESS_DENIED`, so an
 *                                           actor cannot parametrise a read against someone
 *                                           else.
 *    3. profile:   an ACTIVE `PICProfile` for the SESSION user must exist, else `NOT_FOUND`
 *           (404-shaped: "no self-service for you" is indistinguishable from "no such PIC").
 *    4. own-scope permissions from the real decider, for the permission families this
 *       surface owns. A tenant membership confers nothing here — `decideOwnResourcePermission`
 *       is consulted exactly like any other own-scope consumer.
 *
 * The profile exists BEFORE the permissions are evaluated, so the two failures read
 * differently: "you are not a PIC" (NOT_FOUND) vs "you are a PIC but this family is not
 * yours" (FORBIDDEN). An account with an ACTIVE profile but a CUSTOMER platform role already
 * clears the profile step and then fails FORBIDDEN on the fee family — identity is not a
 * role escape hatch.
 *
 * Permission mapping (deliberate, see the dashboard report §9):
 *      assignments / referral links  → profile-scoped only. No dedicated permission exists
 *          (`pic.assign` is the organizer's verb, not the PIC's), and none is invented:
 *          holding an ACTIVE profile + owning the account is the authority.
 *      attributions / sales counts   → `pic_attribution.read.own`
 *      fee summary / ledger          → `pic_fee.read.own`
 *      `report.export.own_pic_fee`   → deliberately NOT consumed in V1: export is out of
 *          scope, and wiring the permission to a read it does not describe would blur it.
 *
 * ── WHY THE METRICS ARE DERIVED, NOT COUNTERS ───────────────────────────────────
 * The figures come from the same tables the operator surfaces read, never from a mutable
 * counter: assignments are counted from `PICEventAssignment`, attribution from
 * `PICAttribution` (one per order, ALL statuses — attribution happens at checkout before
 * payment), sales from `EventOrderItem`/`EventOrder` filtered to `paymentStatus = PAID`
 * (the dashboard's revenue contract), and fee figures from the append-only `PICFeeLedger`
 * grouped by direction. Companion sums for tickets/gross are narrowed to PAID exactly like
 * the tenant dashboard, so a PENDING/FAILED/CANCELLED/REFUNDED order never inflates a
 * "sold" number. Net = CREDIT − DEBIT in `Decimal`, never an integer division, never a
 * float, and never a recomputation from the CURRENT fee config.
 */

/**
 * Resolve an ACTIVE PIC profile for a user, or `null`.
 *
 * Deliberately UNGUARDED (no session requirement): this is the probe the dashboard layout
 * uses to decide whether a first-pass-denied actor was refused only because they are a PIC.
 * The layout has already authenticated them via `getAuthzScope`, and the `userId` comes
 * from that server-side session — never from the request. It returns `null` for a missing
 * or non-ACTIVE profile, so the layout's capability flag stays fail-closed.
 */
export async function findActivePicProfile(
    userId: string
): Promise<{ id: string; displayName: string; picCode: string } | null> {
    /*
     * PHASE 33 — the owning account must itself be active. `User.disabledAt` is the
     * account dimension; `PICProfile.status` is the PIC business dimension; BOTH must be
     * healthy for self-service entry (brief §O: the effective access is the AND of the
     * two, never either alone). A deactivated account resolves to null here exactly like
     * a suspended profile, so the layout's flag stays fail-closed.
     */
    return prisma.pICProfile.findFirst({
        where: { userId, status: "ACTIVE", user: { disabledAt: null } },
        select: { id: true, displayName: true, picCode: true },
    });
}

/**
 * The caller's PIC profile STANDING, whatever it is, or `null` when they have no profile.
 *
 * PHASE 34 — this is the complement of `findActivePicProfile`. A PIC account may ENTER the
 * dashboard shell on its platform role alone, but its self-service surface depends on the
 * profile standing. `findActivePicProfile` answers "may they self-serve?" (ACTIVE only);
 * this function answers "which standing state should the shell show them?" so a PENDING,
 * SUSPENDED or REJECTED profile gets an honest status instead of the generic denied panel —
 * or, worse, an empty dashboard that reads like a business with no data.
 *
 * Deliberately UNGUARDED and user-scoped exactly like `findActivePicProfile`: the `userId`
 * comes from the server-side session (the layout/landing has already authenticated), never
 * from the request. It only ever returns a STATUS — no fee, no attribution, no other PIC's
 * data — so it cannot become a data read even if misused.
 */
export async function findPicProfileStanding(
    userId: string
): Promise<PICStatus | null> {
    const profile = await prisma.pICProfile.findUnique({
        where: { userId },
        select: { status: true },
    });

    return profile?.status ?? null;
}

/**
 * The single guard every self-service read funnels through.
 *
 * See the module doc for the four-step order. `permissions` selects the own-scope
 * permission families the specific read needs; a bare `[]` means "profile-scoped only".
 */
export async function requireMyPic(
    userId: string,
    permissions: readonly Permission[]
): Promise<{ scope: AuthzScope; picProfileId: string }> {
    const scope = await requireAuth();

    // The `userId` argument is a routing key, never an authority. Authority comes from the
    // server-side session; a forged id is a refusal, not a wider filter.
    if (scope.userId !== userId) {
        throw new AuthzError(
            AuthzErrorCode.PIC_ACCESS_DENIED,
            `PIC self-service invoked for another user (session ${scope.userId})`
        );
    }

    const profile = await prisma.pICProfile.findFirst({
        where: {
            userId: scope.userId,
            status: "ACTIVE",
            // PHASE 33 — a deactivated account holds no self-service either.
            user: { disabledAt: null },
        },
        select: { id: true },
    });

    if (!profile) {
        throw new AuthzError(
            AuthzErrorCode.NOT_FOUND,
            `no ACTIVE PIC profile for session user ${scope.userId}`
        );
    }

    for (const permission of permissions) {
        const decision = decideOwnResourcePermission(
            scope,
            permission,
            userId
        );

        if (!decision.allowed) {
            throw new AuthzError(decision.code, decision.reason);
        }
    }

    return { scope, picProfileId: profile.id };
}

/** The PIC's own profile meta: name, public code and standing. */
export async function getMyPicProfile(userId: string) {
    const { picProfileId } = await requireMyPic(userId, []);

    const profile = await prisma.pICProfile.findUnique({
        where: { id: picProfileId },
        select: {
            id: true,
            displayName: true,
            picCode: true,
            status: true,
            approvedAt: true,
            createdAt: true,
        },
    });

    if (!profile) {
        throw new AuthzError(
            AuthzErrorCode.NOT_FOUND,
            "profile vanished between guard and read"
        );
    }

    return {
        id: profile.id,
        displayName: profile.displayName,
        picCode: profile.picCode,
        status: profile.status,
        approvedAt: profile.approvedAt?.toISOString() ?? null,
        createdAt: profile.createdAt.toISOString(),
    };
}

/**
 * The four numbers behind the self-service StatGrid.
 *
 * Requires BOTH own-scope families: attribution counts and the fee figures share one page,
 * so presenting one without authority for the other is a rendering lie — one guard holds
 * both. A PIC platform role holds both (`PLATFORM_ROLE_OWN_PERMISSIONS.PIC`).
 */
export async function getMyPicOverview(userId: string) {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_ATTRIBUTION_READ_OWN,
        PERMISSIONS.PIC_FEE_READ_OWN,
    ]);

    const [
        activeAssignments,
        totalAssignments,
        attributedOrders,
        tickets,
        gross,
    ] = await Promise.all([
        prisma.pICEventAssignment.count({
            where: { picProfileId, isActive: true, revokedAt: null },
        }),
        prisma.pICEventAssignment.count({ where: { picProfileId } }),
        // ALL statuses: attribution is captured at checkout, before payment settles. A
        // later refund shows up as fee REVERSAL entries instead of silently vanishing here.
        prisma.pICAttribution.count({ where: { picProfileId } }),
        prisma.eventOrderItem.aggregate({
            _sum: { quantity: true },
            where: { order: { picProfileId, paymentStatus: "PAID" } },
        }),
        prisma.eventOrder.aggregate({
            _sum: { total: true },
            where: { picProfileId, paymentStatus: "PAID" },
        }),
    ]);

    // `Σ CREDIT − Σ DEBIT` over the WHOLE ledger — the one canonical sum (Phase 30), the
    // same helper powering the platform admin views.
    const { credit, debit, net } = await getPicLedgerBalance(picProfileId);

    return {
        assignedEvents: activeAssignments,
        totalAssignments,
        attributedOrders,
        ticketsSold: tickets._sum.quantity ?? 0,
        grossSales: gross._sum.total ?? new Prisma.Decimal(0),
        feeEarned: credit,
        feeReversed: debit,
        netFee: net,
    };
}

/** The PIC's own event assignments — profile-scoped, no dedicated permission. */
export async function listMyPicAssignments(userId: string) {
    const { picProfileId } = await requireMyPic(userId, []);

    const rows = await prisma.pICEventAssignment.findMany({
        where: { picProfileId },
        select: {
            id: true,
            eventId: true,
            feeRateBp: true,
            isActive: true,
            revokedAt: true,
            assignedAt: true,
            event: {
                select: { title: true, slug: true, status: true, startAt: true },
            },
        },
        orderBy: [{ assignedAt: "desc" }, { createdAt: "desc" }],
        take: 100,
    });

    return rows.map((assignment) => ({
        id: assignment.id,
        eventId: assignment.eventId,
        eventTitle: assignment.event.title,
        eventSlug: assignment.event.slug,
        eventStatus: assignment.event.status,
        eventStartAt: assignment.event.startAt.toISOString(),
        feeRateBp: assignment.feeRateBp,
        isActive: assignment.isActive,
        revokedAt: assignment.revokedAt?.toISOString() ?? null,
        assignedAt: assignment.assignedAt.toISOString(),
    }));
}

/** The PIC's own attributions, newest first — `pic_attribution.read.own`. */
export async function listMyAttributions(userId: string) {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_ATTRIBUTION_READ_OWN,
    ]);

    const rows = await prisma.pICAttribution.findMany({
        where: { picProfileId },
        select: {
            id: true,
            orderId: true,
            eventId: true,
            source: true,
            method: true,
            selfReferral: true,
            capturedAt: true,
            order: {
                select: {
                    orderNumber: true,
                    total: true,
                    status: true,
                    paymentStatus: true,
                },
            },
            event: { select: { title: true, slug: true } },
        },
        orderBy: [{ capturedAt: "desc" }],
        take: 20,
    });

    return rows.map((attribution) => ({
        id: attribution.id,
        orderId: attribution.orderId,
        orderNumber: attribution.order.orderNumber,
        orderTotal: attribution.order.total,
        orderStatus: attribution.order.status,
        paymentStatus: attribution.order.paymentStatus,
        eventTitle: attribution.event.title,
        eventSlug: attribution.event.slug,
        source: attribution.source,
        method: attribution.method,
        selfReferral: attribution.selfReferral,
        capturedAt: attribution.capturedAt.toISOString(),
    }));
}

/** The PIC's posted fee figures from the append-only ledger — `pic_fee.read.own`. */
export async function getMyFeeSummary(userId: string) {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_FEE_READ_OWN,
    ]);

    const { credit, debit, net } = await getPicLedgerBalance(picProfileId);

    return {
        earned: credit,
        reversed: debit,
        net,
    };
}

/** The PIC's own fee ledger entries, newest first — `pic_fee.read.own`. */
export async function listMyFeeLedger(userId: string) {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_FEE_READ_OWN,
    ]);

    const rows = await prisma.pICFeeLedger.findMany({
        where: { picProfileId },
        select: {
            id: true,
            type: true,
            direction: true,
            amount: true,
            currency: true,
            feeType: true,
            status: true,
            createdAt: true,
            event: { select: { title: true } },
        },
        orderBy: [{ createdAt: "desc" }],
        take: 50,
    });

    return rows.map((entry) => ({
        id: entry.id,
        type: entry.type,
        direction: entry.direction,
        amount: entry.amount,
        currency: entry.currency,
        feeType: entry.feeType,
        status: entry.status,
        eventTitle: entry.event.title,
        createdAt: entry.createdAt.toISOString(),
    }));
}

/**
 * The PIC's own settlements — the read half of PIC payout / settlement V1.
 *
 * Profile-scoped like every other self-service read, gated by the SAME
 * `pic_fee.read.own` permission the fee ledger uses (this is the PIC reading their OWN
 * money, read-only, in their own-scope dashboard). The PIC cannot prepare, approve or pay
 * anything here — there is no mutation on this surface by construction; every money step
 * is an organizer action on `/api/organizer/settlements/*`.
 *
 * Amounts are the exact stored Decimal strings (never a JSON-number round trip); the
 * masked rendering lives in the page.
 */
export async function listMySettlements(userId: string) {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_FEE_READ_OWN,
    ]);

    const rows = await prisma.settlement.findMany({
        where: { picProfileId },
        select: {
            id: true,
            settlementNumber: true,
            status: true,
            method: true,
            periodStart: true,
            periodEnd: true,
            grossAmount: true,
            deductionAmount: true,
            netAmount: true,
            currency: true,
            paidAt: true,
            createdAt: true,
        },
        orderBy: [{ createdAt: "desc" }],
        take: 50,
    });

    return rows.map((row) => ({
        id: row.id,
        settlementNumber: row.settlementNumber,
        status: row.status,
        method: row.method,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        grossAmount: row.grossAmount,
        deductionAmount: row.deductionAmount,
        netAmount: row.netAmount,
        currency: row.currency,
        paidAt: row.paidAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
    }));
}

/**
 * The PIC's referral links: one per ACTIVE assignment, signed server-side.
 *
 * Profile-scoped (no dedicated permission). Only active, non-revoked assignments yield a
 * link — the SAME facts the checkout resolver re-checks before a token can become money.
 * `sharePath` is the canonical event URL plus the signed `?pic=` token, or `null` when the
 * signing secret is unset (fail-closed: no weak link is ever exposed).
 */
export async function listMyReferralLinks(userId: string) {
    const { picProfileId } = await requireMyPic(userId, []);

    const assignments = await prisma.pICEventAssignment.findMany({
        where: { picProfileId, isActive: true, revokedAt: null },
        select: {
            id: true,
            eventId: true,
            event: { select: { title: true, slug: true } },
        },
        orderBy: [{ assignedAt: "desc" }],
        take: 100,
    });

    return assignments.map((assignment) => {
        const token = mintPicReferralToken({
            picProfileId,
            eventId: assignment.eventId,
        });

        return {
            assignmentId: assignment.id,
            eventId: assignment.eventId,
            eventTitle: assignment.event.title,
            eventSlug: assignment.event.slug,
            sharePath: token
                ? `/e/${assignment.event.slug}?pic=${encodeURIComponent(token)}`
                : null,
        };
    });
}

/**
 * One referral link for a specific event, or `null` when the PIC holds no ACTIVE
 * assignment for it (or the signing secret is unset).
 *
 * The `eventId` is re-authorized against the caller's OWN profile before anything is
 * minted — an unassigned or revoked event resolves to `null`, never to a link. `null` here
 * means "no link", not "error"; only the guard itself throws.
 */
export async function getMyReferralLink(
    userId: string,
    eventId: string
): Promise<string | null> {
    const { picProfileId } = await requireMyPic(userId, []);

    if (!eventId || typeof eventId !== "string") {
        return null;
    }

    const assignment = await prisma.pICEventAssignment.findFirst({
        where: {
            picProfileId,
            eventId,
            isActive: true,
            revokedAt: null,
        },
        select: { event: { select: { slug: true } } },
    });

    if (!assignment) {
        return null;
    }

    const token = mintPicReferralToken({ picProfileId, eventId });

    if (!token) {
        return null;
    }

    return `/e/${assignment.event.slug}?pic=${encodeURIComponent(token)}`;
}