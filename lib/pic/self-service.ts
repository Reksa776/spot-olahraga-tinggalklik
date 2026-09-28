import {
    Prisma,
    type EventStatus,
    type PaymentStatus,
    type PICStatus,
} from "@prisma/client";

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
import { getPicFeeEntitlement, getPicLedgerBalance } from "@/lib/pic/ledger";
import { prisma } from "@/lib/prisma";

/** The zero of every money aggregate in this module — never a JS `0` in a `Decimal` sum. */
const ZERO = new Prisma.Decimal(0);

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
 *
 * PIC DASHBOARD V2 — two of those fee figures are now separated so the page can stop calling
 * an ENTITLEMENT a settlement. `fee.potential` is `Σ EARNED − Σ REVERSAL` (what the sales have
 * earned the PIC), while `payout.approvedTotal` is `Σ Settlement.netAmount` over `APPROVED` ∪
 * `PAID` (what the settlement engine has approved for transfer). Neither is derived from the
 * other, and neither is a new fee formula — the first aggregates existing ledger rows (see
 * `getPicFeeEntitlement`), the second sums amounts the money engine already stored.
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

/**
 * The PIC's own profile meta: name, public code, standing — and their OWN bank details.
 *
 * ── THE ONE PLACE THE RAW ACCOUNT NUMBER IS EXPOSED ──────────────────────────────
 * Every other surface masks it (`maskAccountNumber` → `••••` + last four): the operator
 * settlement list and detail, the PIC's own payout history, the admin PIC detail page.
 * This function is the deliberate exception, and it is safe for a specific reason: it is
 * own-scope and identity-gated by `requireMyPic`, so the raw value can only ever reach the
 * authenticated owner of the profile — the same party who can change it. The dialog needs
 * the real digits to pre-fill an EDITABLE field; a masked value cannot be corrected.
 *
 * The exception is scoped by construction, not by convention:
 *   * it is NOT part of `PIC_PAYOUT_SELECT` / the payout-history payload;
 *   * it is NOT part of `buildSettlementPayload` (the operator/admin view);
 *   * it must never be logged or placed in a URL.
 *
 * `bankDetailsComplete` single-sources the money engine's own all-or-nothing rule
 * (`settlement.ts` refuses with `BANK_DETAILS_MISSING` unless all three are present), so
 * the dialog can show its "Data rekening belum lengkap" state from the same predicate the
 * server will enforce — rather than a second, drift-prone copy of it.
 */
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
            bankName: true,
            bankAccountName: true,
            bankAccountNumber: true,
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
        // OWNER-ONLY, RAW — see the docblock above.
        bankName: profile.bankName,
        bankAccountName: profile.bankAccountName,
        bankAccountNumber: profile.bankAccountNumber,
        bankDetailsComplete: Boolean(
            profile.bankName &&
                profile.bankAccountName &&
                profile.bankAccountNumber
        ),
    };
}

/**
 * The five numbers behind the self-service StatGrid.
 *
 * Requires BOTH own-scope families: attribution counts and the fee figures share one page,
 * so presenting one without authority for the other is a rendering lie — one guard holds
 * both. A PIC platform role holds both (`PLATFORM_ROLE_OWN_PERMISSIONS.PIC`). The payout
 * block reads the PIC's own `Settlement` rows, which is the same authority the payout
 * request surface resolves (`pic_fee.read.own`), so no extra capability is claimed here.
 *
 * ── FEE ENTITLEMENT vs FEE SETTLED (two different questions) ─────────────────────
 * `fee.potential` is the ledger EARNED minus REVERSAL — what the PIC's sales have earned
 * them ("Potensi Fee"). `payout.approvedTotal` is the Σ `netAmount` of the PIC's OWN
 * settlements that reached `APPROVED` or `PAID` ("Fee Bersih") — what has actually been
 * approved for transfer. They are deliberately different numbers: one is derived from the
 * sales ledger, the other from the settlement engine's own stored amounts, and neither is
 * computed from the other.
 *
 * ── WHY `APPROVED ∪ PAID` IS THE "FEE BERSIH" DEFINITION ────────────────────────
 * The settlement lifecycle is `REQUESTED → APPROVED → PAID` (`settlement.ts`): `APPROVED`
 * means "transfer bank kini boleh dieksekusi" with the amount already frozen at prepare
 * time, and `PAID` is that same approved payout after the transfer was evidenced — a state
 * a row can only reach FROM `APPROVED`. Counting only the rows still sitting in `APPROVED`
 * would make the figure DROP the moment the money was actually transferred, which is the
 * opposite of what a cumulative "fee bersih" must do; `PAID` alone would hide everything
 * approved but not yet transferred. The union is therefore the approved-and-beyond set, and
 * the two legs are reported separately (`approvedAmount` / `paidAmount`) so the tile can say
 * which is which instead of asserting a single ambiguous total. `REQUESTED`, `REJECTED`,
 * `FAILED`, `CANCELLED` and `DRAFT` are all excluded: a request that was refused, or never
 * reviewed, has approved nothing.
 *
 * No money is recomputed: the amounts are the settlements' stored `netAmount`, written by
 * the money engine at prepare time.
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
        entitlement,
        payoutGroups,
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
        // Fee ENTITLEMENT from sales: Σ EARNED − Σ REVERSAL (payouts excluded — see the
        // helper's docblock).
        getPicFeeEntitlement(picProfileId),
        // The PIC's own payouts, grouped by the settlement engine's own status enum: one
        // read gives both the approved legs and the count, so the tile and its hint cannot
        // describe two different sets.
        prisma.settlement.groupBy({
            by: ["status"],
            where: { payeeType: "PIC", picProfileId },
            _count: { _all: true },
            _sum: { netAmount: true },
        }),
    ]);

    const payoutSum = (status: string) =>
        payoutGroups.find((group) => group.status === status)?._sum.netAmount ?? ZERO;
    const payoutCount = (status: string) =>
        payoutGroups.find((group) => group.status === status)?._count._all ?? 0;

    const approvedAmount = payoutSum("APPROVED");
    const paidAmount = payoutSum("PAID");

    // `Σ CREDIT − Σ DEBIT` over the WHOLE ledger — the one canonical sum (Phase 30), the
    // same helper powering the platform admin views.
    const { credit, debit, net } = await getPicLedgerBalance(picProfileId);

    return {
        assignedEvents: activeAssignments,
        totalAssignments,
        attributedOrders,
        ticketsSold: tickets._sum.quantity ?? 0,
        grossSales: gross._sum.total ?? ZERO,
        fee: {
            /** Σ EARNED credits — the fee posted from settled sales. */
            earned: entitlement.earned,
            /** Σ REVERSAL debits — fee given back on refunds. */
            reversed: entitlement.reversed,
            /** `earned − reversed`: the fee the PIC's sales have earned. */
            potential: entitlement.potential,
            /** Σ CREDIT − Σ DEBIT over the whole ledger (payouts included). */
            netBalance: net,
            credit,
            debit,
        },
        payout: {
            /** APPROVED ∪ PAID — the "Fee Bersih" figure. */
            approvedTotal: approvedAmount.add(paidAmount),
            /** Approved, transfer not yet evidenced. */
            approvedAmount,
            /** Transfer evidenced (`PAID`). */
            paidAmount,
            approvedCount: payoutCount("APPROVED"),
            paidCount: payoutCount("PAID"),
        },
    };
}

/*
 * ============================================================================
 * "EVENT SAYA" — STATUS FILTERS (assignment + event)
 * ============================================================================
 *
 * Two dimensions, and both come from the data that is actually stored rather than from a
 * status vocabulary invented for the filter:
 *
 *   ASSIGNMENT  `PICEventAssignment` carries a boolean (`isActive`) plus the revocation
 *               stamp (`revokedAt`), and `revokePicAssignment` writes both together. The
 *               filter's two members are therefore exactly the two states the row can hold:
 *               `ACTIVE` (`isActive && !revokedAt`) and `REVOKED` (`!isActive`). There is no
 *               third state and no enum to widen — the table's own badge renders the same
 *               pair ("Aktif" / "Dicabut").
 *
 *   EVENT       the Prisma `EventStatus` enum, narrowed by the same dashboard list the
 *               events page offers (`EVENT_STATUS_FILTERS`; `PENDING_REVIEW` is absent
 *               because no code path can produce it).
 *
 * An unknown value is not a filter: the page narrows the URL parameter through
 * `parsePicAssignmentStatus` / `parseEventStatusFilters` before calling this service, so a
 * hand-edited `?assignmentStatus=NOPE` renders "Semua penugasan" instead of reaching Prisma
 * (where a comparison against a non-member would raise rather than render a page).
 */

/** The two states a `PICEventAssignment` row can hold. */
export const PIC_ASSIGNMENT_STATUSES = ["ACTIVE", "REVOKED"] as const;

export type PicAssignmentStatus = (typeof PIC_ASSIGNMENT_STATUSES)[number];

/** Narrow a query-string value to an assignment state, or `null` for "no filter". */
export function parsePicAssignmentStatus(
    value: string | string[] | undefined
): PicAssignmentStatus | null {
    const raw = Array.isArray(value) ? value[0] : value;

    return raw !== undefined &&
        (PIC_ASSIGNMENT_STATUSES as readonly string[]).includes(raw)
        ? (raw as PicAssignmentStatus)
        : null;
}

/** How many assignments one page of "Event Saya" shows. */
export const PIC_ASSIGNMENT_PAGE_SIZE = 10;

export type PicAssignmentFilters = {
    /** `ACTIVE` = still assigned, `REVOKED` = withdrawn. `null` = both. */
    assignmentStatus?: PicAssignmentStatus | null;
    /** The event statuses to keep (already validated against `EventStatus`). Empty = all. */
    eventStatuses?: readonly EventStatus[];
    page?: number;
    limit?: number;
};

/**
 * The PIC's own event assignments — profile-scoped, no dedicated permission.
 *
 * ── FILTERED AND COUNTED BY THE DATABASE, NOT BY THE PAGE ────────────────────────
 * `assignmentStatus` and `eventStatuses` are `where` predicates, so the table, the row count
 * and the pager all describe the SAME narrowed set. Filtering the already-fetched page in
 * JavaScript would make the pager lie (page 1 of "Dicabut" showing four rows out of the two
 * that survived a filter applied after the fetch), which is the defect this shape prevents.
 *
 * ── THE PER-EVENT SALES COLUMNS ─────────────────────────────────────────────────
 * Each row carries the two figures the PIC dashboard's `Pesanan Atribusi` and `Tiket Terjual`
 * KPIs are made of, for THAT event:
 *
 *   attributedOrders  `PICAttribution` rows for the event — one per attributed order, ALL
 *                     statuses. Attribution is captured at checkout, before payment, so a
 *                     pending order still counts as an attributed order (exactly the
 *                     dashboard `attributedOrders` contract). It is also the SAME table the
 *                     KPI counts, so the column cannot disagree with the tile above it.
 *   paidTickets       Σ `EventOrderItem.quantity` over orders whose `paymentStatus` is `PAID`
 *                     — the dashboard revenue contract, unchanged from the KPI. One order
 *                     with three tickets is three tickets and ONE order, which is why the two
 *                     columns are counted from two different tables rather than from one row
 *                     count.
 *
 * The two sources describe the same set of orders because checkout writes them together: an
 * order's `picProfileId` and its one `PICAttribution` row are created in the SAME transaction
 * (`lib/ticketing/checkout.ts`), so "an attributed order" cannot be true of one table and false
 * of the other.
 *
 * Both are fetched for the WHOLE page of events in two queries (a `groupBy`, and the narrow
 * order-line projection the reports module also folds in JavaScript) instead of one query per
 * row.
 *
 * Amounts are never recomputed here: `quantity` and the attribution rows are stored facts.
 */
export async function listMyPicAssignments(
    userId: string,
    filters: PicAssignmentFilters = {}
) {
    const { picProfileId } = await requireMyPic(userId, []);

    const page = Math.max(1, Math.trunc(filters.page ?? 1));
    const limit = Math.max(1, Math.trunc(filters.limit ?? PIC_ASSIGNMENT_PAGE_SIZE));

    const assignmentStatus = filters.assignmentStatus ?? null;
    const eventStatuses = filters.eventStatuses ?? [];

    const where: Prisma.PICEventAssignmentWhereInput = {
        picProfileId,
        // `ACTIVE` is the read model's own definition (both columns), never just `isActive`:
        // the same predicate `assignedEvents` and the referral links use.
        ...(assignmentStatus === "ACTIVE"
            ? { isActive: true, revokedAt: null }
            : {}),
        ...(assignmentStatus === "REVOKED" ? { isActive: false } : {}),
        ...(eventStatuses.length > 0
            ? { event: { status: { in: [...eventStatuses] } } }
            : {}),
    };

    const [total, rows] = await Promise.all([
        prisma.pICEventAssignment.count({ where }),
        prisma.pICEventAssignment.findMany({
            where,
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
            skip: (page - 1) * limit,
            take: limit,
        }),
    ]);

    const eventIds = rows.map((row) => row.eventId);

    const attributedByEvent = new Map<string, number>();
    const ticketsByEvent = new Map<string, number>();

    if (eventIds.length > 0) {
        const [attributionGroups, paidItemRows] = await Promise.all([
            prisma.pICAttribution.groupBy({
                by: ["eventId"],
                where: { picProfileId, eventId: { in: eventIds } },
                _count: { _all: true },
            }),
            prisma.eventOrderItem.findMany({
                where: {
                    order: {
                        picProfileId,
                        paymentStatus: "PAID",
                        eventId: { in: eventIds },
                    },
                },
                select: { quantity: true, order: { select: { eventId: true } } },
            }),
        ]);

        for (const group of attributionGroups) {
            attributedByEvent.set(group.eventId, group._count._all);
        }

        for (const item of paidItemRows) {
            const eventId = item.order.eventId;
            ticketsByEvent.set(eventId, (ticketsByEvent.get(eventId) ?? 0) + item.quantity);
        }
    }

    return {
        items: rows.map((assignment) => ({
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
            attributedOrders: attributedByEvent.get(assignment.eventId) ?? 0,
            paidTickets: ticketsByEvent.get(assignment.eventId) ?? 0,
        })),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        },
    };
}

/**
 * The most recent attributions on the PIC's own orders — `pic_attribution.read.own`.
 *
 * ── AN ORDER LIST, NOT A SALES REPORT ────────────────────────────────────────────
 * This answers "which orders came through me?", so it deliberately spans EVERY payment state
 * (attribution is captured at checkout, before payment). It is NOT the destination of the
 * `Tiket Terjual` tile: that tile counts PAID tickets only, and it belongs to the dedicated
 * ticket-sales section built by `getMyPicTicketSales` below. Keeping the two apart is the
 * whole point — a PIC clicking "Tiket Terjual" must not land on a list of pending orders.
 *
 * `paymentStatus` narrows the list to the orders in ONE gateway payment state, and it is a
 * `where` on the ORDER (attribution happens before payment, so the state lives there). The
 * value is expected to be an already-validated `PaymentStatus` member: an unknown string is a
 * Prisma enum comparison that would raise, so the page narrows it before calling (the same
 * division of labour every other dashboard list uses).
 *
 * ── ONE QUANTITY PER ROW, WITHOUT AN N+1 ────────────────────────────────────────
 * Each row carries `ticketQuantity` = Σ `EventOrderItem.quantity` for THAT order — the same
 * stored fact the dashboard's `Tiket Terjual` KPI is built from, so "how many tickets did this
 * order buy?" is answerable on the row instead of on another page. It is read for the whole
 * page of orders in ONE grouped query, never one query per attribution. The figure is shown
 * whatever the payment state says: a PENDING order did buy those tickets, it simply has not
 * been paid for yet — which is exactly the distinction the status column exists to carry.
 */
export async function listMyAttributions(
    userId: string,
    filters: { paymentStatus?: PaymentStatus | null } = {}
) {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_ATTRIBUTION_READ_OWN,
    ]);

    const rows = await prisma.pICAttribution.findMany({
        where: {
            picProfileId,
            ...(filters.paymentStatus
                ? { order: { paymentStatus: filters.paymentStatus } }
                : {}),
        },
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

    const orderIds = rows.map((attribution) => attribution.orderId);
    const ticketsByOrder = new Map<string, number>();

    if (orderIds.length > 0) {
        const ticketGroups = await prisma.eventOrderItem.groupBy({
            by: ["orderId"],
            where: { orderId: { in: orderIds } },
            _sum: { quantity: true },
        });

        for (const group of ticketGroups) {
            ticketsByOrder.set(group.orderId, group._sum.quantity ?? 0);
        }
    }

    return rows.map((attribution) => ({
        id: attribution.id,
        orderId: attribution.orderId,
        orderNumber: attribution.order.orderNumber,
        ticketQuantity: ticketsByOrder.get(attribution.orderId) ?? 0,
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

/**
 * ============================================================================
 * "TIKET TERJUAL" — the PAID sales performance, aggregated PER EVENT
 * ============================================================================
 *
 * The companion of `listMyAttributions`, deliberately a different question and a different
 * shape. Attributions answer "which orders came through me?" (order-level, all payment
 * states). This answers "how many tickets have actually been SOLD?" — an event-level rollup
 * of the PAID orders only, so a PIC can see where tickets are moving rather than re-reading
 * a list of orders they already saw one section above.
 *
 * ── THE DEFINITIONS, UNCHANGED FROM THE KPI ─────────────────────────────────
 * The dashboard's `Tiket Terjual` KPI is `Σ EventOrderItem.quantity` over the PIC's orders
 * whose `paymentStatus = PAID` (`getMyPicOverview`), so that is exactly what this rolls up
 * per event:
 *
 *   paidOrders   the COUNT of those PAID orders. One order with three tickets is ONE order
 *                and THREE tickets, so the two columns are counted from two different tables
 *                (a `groupBy` over orders and a folded sum over their lines) rather than
 *                from a single row count that could only be one of the two numbers.
 *   ticketsSold  Σ `EventOrderItem.quantity` for those orders.
 *   sales        Σ `EventOrder.total` for those orders — the SAME stored column the fee
 *                section already calls "Total Penjualan" (`overview.grossSales`), never a
 *                recomputation from the current fee config, and never a new money formula.
 *                An event whose sales are zero therefore renders `Rp 0`, not a hidden
 *                column.
 *
 * Because the set is the KPI's own set, the table's totals equal the tile above it by
 * construction; a test pins that (the two reads can never drift into describing two
 * different populations).
 *
 * ── WHY ONLY EVENTS THAT HAVE SOLD ──────────────────────────────────────────
 * The rows come from a `groupBy` over PAID orders, so an assigned event with no paid order
 * simply has no row — this section is a sales summary, not a second copy of "Event Saya".
 * The page's empty state covers the "nothing sold yet" case explicitly.
 *
 * ── QUERY SHAPE ─────────────────────────────────────────────────────────────
 * Two aggregations plus one event-metadata lookup, whatever the number of events: the order
 * totals are grouped in the database, the ticket quantities are folded from a narrow
 * order-line projection (the same pattern `listMyPicAssignments` and the reports module
 * use), and the titles come from a single `findMany` over the resulting event ids. No query
 * per event and no query per order.
 *
 * Everything is scoped by `requireMyPic`, so another PIC's orders on the SAME event are
 * invisible here exactly as they are in the KPI.
 */
export async function getMyPicTicketSales(userId: string) {
    const { picProfileId } = await requireMyPic(userId, [
        PERMISSIONS.PIC_ATTRIBUTION_READ_OWN,
        PERMISSIONS.PIC_FEE_READ_OWN,
    ]);

    const [orderGroups, paidItemRows] = await Promise.all([
        prisma.eventOrder.groupBy({
            by: ["eventId"],
            where: { picProfileId, paymentStatus: "PAID" },
            _count: { _all: true },
            _sum: { total: true },
        }),
        prisma.eventOrderItem.findMany({
            where: { order: { picProfileId, paymentStatus: "PAID" } },
            select: { quantity: true, order: { select: { eventId: true } } },
        }),
    ]);

    const eventIds = orderGroups.map((group) => group.eventId);

    if (eventIds.length === 0) {
        return {
            items: [] as {
                eventId: string;
                eventTitle: string;
                eventSlug: string | null;
                paidOrders: number;
                ticketsSold: number;
                sales: Prisma.Decimal;
            }[],
            totals: { paidOrders: 0, ticketsSold: 0, sales: ZERO },
        };
    }

    const events = await prisma.event.findMany({
        where: { id: { in: eventIds } },
        select: { id: true, title: true, slug: true },
    });

    const eventById = new Map(events.map((event) => [event.id, event]));

    const ticketsByEvent = new Map<string, number>();

    for (const item of paidItemRows) {
        const eventId = item.order.eventId;
        ticketsByEvent.set(eventId, (ticketsByEvent.get(eventId) ?? 0) + item.quantity);
    }

    // Best sellers first; the sales figure breaks a ticket tie deterministically so the table
    // does not reshuffle between two renders of unchanged data.
    const items = orderGroups
        .map((group) => ({
            eventId: group.eventId,
            eventTitle: eventById.get(group.eventId)?.title ?? "—",
            eventSlug: eventById.get(group.eventId)?.slug ?? null,
            paidOrders: group._count._all,
            ticketsSold: ticketsByEvent.get(group.eventId) ?? 0,
            sales: group._sum.total ?? ZERO,
        }))
        .sort(
            (left, right) =>
                right.ticketsSold - left.ticketsSold || right.sales.comparedTo(left.sales)
        );

    const totals = items.reduce(
        (accumulator, item) => ({
            paidOrders: accumulator.paidOrders + item.paidOrders,
            ticketsSold: accumulator.ticketsSold + item.ticketsSold,
            sales: accumulator.sales.add(item.sales),
        }),
        { paidOrders: 0, ticketsSold: 0, sales: ZERO }
    );

    return { items, totals };
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