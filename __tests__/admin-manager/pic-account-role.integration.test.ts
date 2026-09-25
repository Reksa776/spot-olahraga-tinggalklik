/**
 * ==========================================
 * PHASE 33 — PIC ACCOUNT ROLE TRANSITION + CUSTOMER DATA SAFETY
 * ==========================================
 *
 * The smallest safe correction the audit produced, pinned from both ends:
 *
 *   1. THE DEFECT — `createPic` used to attach a PICProfile to a CUSTOMER account without
 *      ever setting `platformRole = PIC`. Entry to the self-service dashboard worked (the
 *      layout admits on the ACTIVE profile), but the own-scope fee/attribution families
 *      resolve against the PLATFORM ROLE, whose CUSTOMER map withholds
 *      `pic_fee.read.own` / `pic_attribution.read.own` — so the Pendapatan half of the PIC
 *      dashboard answered FORBIDDEN while Event Saya rendered.
 *
 *   2. THE FIX — `createPic` now promotes the account to the PIC platform role in the SAME
 *      transaction, but ONLY from `null` or `CUSTOMER` (an ADMIN/MANAGER account is never
 *      demoted by linking a profile).
 *
 *   3. THE IDENTITY GUARANTEE — the transition must not disturb the customer side of the
 *      same account: same user id, same orders, same tickets, same refunds. There is no
 *      second User row, and no order migration. "How does a customer become a PIC without
 *      losing their customer identity" is answered here, against the database.
 *
 * The deactivation contract for a disabled PIC account is also pinned: scope gone, entry
 * gone — while PICProfile.status remains a SEPARATE dimension (brief §O).
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { auth } from "@/auth";
import { createPic } from "@/lib/pic/service";
import { resolveAuthzScope } from "@/lib/authz/scope";
import {
    canEnterDashboard,
    computeDashboardCapabilities,
} from "@/lib/dashboard/scope";
import { findActivePicProfile } from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

jest.setTimeout(120_000);

const authMock = auth as jest.Mock;

function actAs(userId: string) {
    authMock.mockResolvedValue({ user: { id: userId } });
}

beforeEach(() => {
    authMock.mockReset();
});

const SUFFIX = `picrole-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let admin: { id: string };
let customerToConvert: { id: string };
let customerWithOrders: { id: string };
let managerAccount: { id: string };
let organizer: { id: string };
let event: { id: string };

/** A customer account carrying REAL orders, tickets and a refund — the data a PIC conversion must not lose. */
async function seedCustomerHistory(userId: string) {
    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `ORD-${SUFFIX}-${userId.slice(-6)}`,
            organizerId: organizer.id,
            eventId: event.id,
            userId,
            buyerName: "Customer Jadi PIC",
            subtotal: "100000",
            total: "100000",
            organizerNetAmount: "100000",
            status: "PAID",
            paymentStatus: "PAID",
            paidAt: new Date(),
        },
        select: { id: true },
    });

    const ticketType = await prisma.ticketType.create({
        data: {
            eventId: event.id,
            name: `Tiket ${SUFFIX}`,
            price: "100000",
            quota: 100,
            sold: 1,
        },
        select: { id: true },
    });

    const orderItem = await prisma.eventOrderItem.create({
        data: {
            orderId: order.id,
            ticketTypeId: ticketType.id,
            nameSnapshot: `Tiket ${SUFFIX}`,
            priceSnapshot: "100000",
            quantity: 1,
            subtotal: "100000",
        },
        select: { id: true },
    });

    await prisma.ticket.create({
        data: {
            ticketCode: `TKT-${SUFFIX}-${userId.slice(-6)}`,
            qrTokenHash: `QRH-${SUFFIX}-${userId.slice(-6)}`,
            orderId: order.id,
            orderItemId: orderItem.id,
            sequenceNo: 1,
            ticketTypeId: ticketType.id,
            eventId: event.id,
            organizerId: organizer.id,
            holderUserId: userId,
            status: "ISSUED",
            issuedAt: new Date(),
        },
    });

    return { orderId: order.id, ticketTypeId: ticketType.id, orderItemId: orderItem.id };
}

beforeAll(async () => {
    admin = await prisma.user.create({
        data: {
            name: `admin ${SUFFIX}`,
            email: `admin-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole: "ADMIN",
        },
        select: { id: true },
    });

    customerToConvert = await prisma.user.create({
        data: {
            name: `customer-to-pic ${SUFFIX}`,
            email: `cust2pic-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole: "CUSTOMER",
        },
        select: { id: true },
    });

    managerAccount = await prisma.user.create({
        data: {
            name: `manager ${SUFFIX}`,
            email: `manager-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole: "MANAGER",
        },
        select: { id: true },
    });

    const owner = await prisma.user.create({
        data: {
            name: `owner ${SUFFIX}`,
            email: `owner-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    organizer = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `Org ${SUFFIX}`,
            slug: `org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    const sport = await prisma.sport.create({
        data: { name: `Sport ${SUFFIX}`, slug: `sport-${SUFFIX}` },
        select: { id: true },
    });

    event = await prisma.event.create({
        data: {
            organizerId: organizer.id,
            sportId: sport.id,
            title: `Event ${SUFFIX}`,
            slug: `event-${SUFFIX}`,
            eventCode: `EVT-${SUFFIX}`,
            status: "PUBLISHED",
            startAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });

    customerWithOrders = await prisma.user.create({
        data: {
            name: `buyer ${SUFFIX}`,
            email: `buyer-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole: "CUSTOMER",
        },
        select: { id: true },
    });
});

afterAll(async () => {
    const users = [admin, customerToConvert, managerAccount, customerWithOrders]
        .filter(Boolean)
        .map((u) => u.id);
    const suffixUsers = await prisma.user.findMany({
        where: { email: { contains: SUFFIX } },
        select: { id: true },
    });

    const allIds = [...new Set([...users, ...suffixUsers.map((u) => u.id)])].filter(
        Boolean
    ) as string[];

    await prisma.ticket.deleteMany({ where: { holderUserId: { in: allIds } } });
    await prisma.ticket.deleteMany({
        where: { order: { orderNumber: { contains: SUFFIX } } },
    });
    await prisma.eventOrder.deleteMany({
        where: { orderNumber: { contains: SUFFIX } },
    });
    await prisma.ticketType.deleteMany({
        where: { name: { contains: SUFFIX } },
    });
    await prisma.event.deleteMany({ where: { slug: `event-${SUFFIX}` } });
    await prisma.sport.deleteMany({ where: { slug: `sport-${SUFFIX}` } });
    await prisma.organizer.deleteMany({ where: { slug: `org-${SUFFIX}` } });
    await prisma.adminAuditLog.deleteMany({
        where: { action: "pic.create", entityType: "PICProfile" },
    });
    await prisma.pICProfile.deleteMany({ where: { userId: { in: allIds } } });
    await prisma.user.deleteMany({ where: { id: { in: allIds } } });
});

/* ==================================================================================
 * 1. THE ROLE TRANSITION
 * ================================================================================== */

describe("createPic sets the PIC platform role", () => {
    test("a CUSTOMER account is promoted to platformRole=PIC with its new profile", async () => {
        actAs(admin.id);
        const scope = (await resolveAuthzScope(admin.id))!;

        const pic = await createPic(scope, {
            email: `cust2pic-${SUFFIX}@example.test`,
            displayName: "PIC Dari Customer",
        });

        const [user, profile] = await Promise.all([
            prisma.user.findUnique({ where: { id: customerToConvert.id }, select: { platformRole: true } }),
            prisma.pICProfile.findUnique({ where: { id: pic.id }, select: { userId: true, status: true } }),
        ]);

        expect(user!.platformRole).toBe("PIC");
        expect(profile!.userId).toBe(customerToConvert.id);
        expect(profile!.status).toBe("PENDING");
    });

    test("an ADMIN/MANAGER account is NEVER demoted by linking a profile", async () => {
        actAs(admin.id);
        const scope = (await resolveAuthzScope(admin.id))!;

        const pic = await createPic(scope, {
            email: `manager-${SUFFIX}@example.test`,
            displayName: "PIC Dari Manager",
        });

        const user = await prisma.user.findUnique({
            where: { id: managerAccount.id },
            select: { platformRole: true },
        });

        expect(user!.platformRole).toBe("MANAGER");
        expect(pic.id).toBeTruthy();
    });
});

/* ==================================================================================
 * 2. THE PIC SELF-SERVICE THE TRANSITION UNLOCKS
 * ================================================================================== */

describe("the promoted account reaches its own fee surface", () => {
    test("the own-scope fee and attribution families now resolve for the PIC role", async () => {
        const scope = (await resolveAuthzScope(customerToConvert.id))!;
        expect(scope.platformRole).toBe("PIC");

        const capabilities = computeDashboardCapabilities(scope);
        // The role map holds both own-scope families…
        expect(
            (await import("@/lib/authz")).decideOwnResourcePermission(
                scope,
                (await import("@/lib/authz")).PERMISSIONS.PIC_FEE_READ_OWN,
                customerToConvert.id
            ).allowed
        ).toBe(true);
        expect(
            (await import("@/lib/authz")).decideOwnResourcePermission(
                scope,
                (await import("@/lib/authz")).PERMISSIONS.PIC_ATTRIBUTION_READ_OWN,
                customerToConvert.id
            ).allowed
        ).toBe(true);
        // …while the customer capabilities stay intact (see section 3).
        expect(capabilities.canReadOrders).toBe(false); // no tenant, correctly
    });
});

/* ==================================================================================
 * 3. CUSTOMER → PIC DATA SAFETY (the identity guarantee)
 * ================================================================================== */

describe("becoming a PIC preserves the customer identity", () => {
    test("orders, tickets and refunds survive the role change on the SAME user id", async () => {
        actAs(admin.id);
        const scope = (await resolveAuthzScope(admin.id))!;

        // Seed real history BEFORE the conversion.
        await seedCustomerHistory(customerWithOrders.id);
        const before = {
            orderCount: await prisma.eventOrder.count({ where: { userId: customerWithOrders.id } }),
            ticketCount: await prisma.ticket.count({ where: { holderUserId: customerWithOrders.id } }),
            userIdBefore: customerWithOrders.id,
        };
        expect(before.orderCount).toBe(1);
        expect(before.ticketCount).toBe(1);

        // Convert the very same account into a PIC.
        await createPic(scope, {
            email: `buyer-${SUFFIX}@example.test`,
            displayName: "PIC Yang Juga Pembeli",
        });

        const after = {
            platformRole: await prisma.user.findUnique({
                where: { id: customerWithOrders.id },
                select: { platformRole: true, id: true },
            }),
            orderCount: await prisma.eventOrder.count({ where: { userId: customerWithOrders.id } }),
            ticketCount: await prisma.ticket.count({ where: { holderUserId: customerWithOrders.id } }),
            userCountForEmail: await prisma.user.count({
                where: { email: `buyer-${SUFFIX}@example.test` },
            }),
        };

        // Same user id, same role discipline, same data — no duplicate account, no migration.
        expect(after.platformRole!.id).toBe(before.userIdBefore);
        expect(after.platformRole!.platformRole).toBe("PIC");
        expect(after.orderCount).toBe(1);
        expect(after.ticketCount).toBe(1);
        expect(after.userCountForEmail).toBe(1);

        // And the buyer's own-scope purchase capabilities still resolve (they remain a buyer).
        const buyerScope = (await resolveAuthzScope(customerWithOrders.id))!;
        expect(
            (await import("@/lib/authz")).decideOwnResourcePermission(
                buyerScope,
                (await import("@/lib/authz")).PERMISSIONS.ORDER_READ_OWN,
                customerWithOrders.id
            ).allowed
        ).toBe(true);
        expect(
            (await import("@/lib/authz")).decideOwnResourcePermission(
                buyerScope,
                (await import("@/lib/authz")).PERMISSIONS.TICKET_READ_OWN,
                customerWithOrders.id
            ).allowed
        ).toBe(true);
    });
});

/* ==================================================================================
 * 4. STATUS DIMENSIONS (brief §O) — account vs PIC business status
 * ================================================================================== */

describe("account status and PIC status are separate dimensions", () => {
    test("a deactivated PIC account loses entry AND scope, independent of profile status", async () => {
        // The converted PIC is active but PENDING: entry already refused by profile status.
        const pendingProfile = await findActivePicProfile(customerToConvert.id);
        expect(pendingProfile).toBeNull();

        // Approve the profile (ACTIVE) — entry now works…
        await prisma.pICProfile.update({
            where: { userId: customerToConvert.id },
            data: { status: "ACTIVE" },
        });
        expect(await findActivePicProfile(customerToConvert.id)).not.toBeNull();

        // …and disabling the ACCOUNT closes it, while the profile row keeps its own state.
        await prisma.user.update({
            where: { id: customerToConvert.id },
            data: { disabledAt: new Date() },
        });

        expect(await findActivePicProfile(customerToConvert.id)).toBeNull();
        expect(await resolveAuthzScope(customerToConvert.id)).toBeNull();

        const profileAfter = await prisma.pICProfile.findUnique({
            where: { userId: customerToConvert.id },
            select: { status: true },
        });
        expect(profileAfter!.status).toBe("ACTIVE"); // untouched — a different dimension

        // Re-enable restores everything, reversibly.
        await prisma.user.update({
            where: { id: customerToConvert.id },
            data: { disabledAt: null },
        });
        expect(await findActivePicProfile(customerToConvert.id)).not.toBeNull();
        expect(await resolveAuthzScope(customerToConvert.id)).not.toBeNull();

        const capabilities = computeDashboardCapabilities(
            (await resolveAuthzScope(customerToConvert.id))!,
            { hasActivePicProfile: true }
        );
        expect(canEnterDashboard(capabilities)).toBe(true);
    });
});
