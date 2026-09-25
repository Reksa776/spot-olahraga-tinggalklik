/**
 * ==========================================
 * PHASE 40 — CROSS-ROLE WORKFLOW AUDIT (INTEGRATION)
 * ==========================================
 *
 * The connected business workflow audit: does the system stay genuinely usable by all
 * FOUR account types (ADMIN, MANAGER, PIC, CUSTOMER) in ONE chain?
 *
 *   ADMIN  builds the event             (createEvent / ticket type / publish)
 *   MANAGER assigns a PIC to the event  (pic.assign)
 *   PIC    mints its referral link
 *   CUSTOMER buys through that link     (checkout → attribution → frozen fee snapshot)
 *   CUSTOMER pays                       (SETTLED payment posts EARNED exactly once)
 *   CUSTOMER's ticket is issued + admitted at the gate (CHECKIN_STAFF with assignment)
 *   CUSTOMER refunds                    (proportional REVERSAL)
 *   ADMIN  prepares the payout          (settlement DRAFT)
 *   MANAGER approves + evidences + pays (settlement APPROVED → PAID; EARNED → SETTLED)
 *
 * Plus the CROSS-ROLE authority matrix and the multi-role identity cases (Phase 33
 * PIC promotion, Phase 23A operator-as-buyer), all at REAL service + REAL DB level.
 * Only `@/auth` is mocked, exactly like every other integration suite in this repo.
 *
 * PART A — the connected chain (A1..A5)
 * PART B — money folds back: refund reversal → settlement (B1..B6)
 * PART C — the authority matrix as deciders + dashboard enforce it
 * PART D — multi-role identity (CUSTOMER→PIC promotion; MANAGER-as-buyer)
 * PART E — negative §19 controls (all service-level)
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { Prisma } from "@prisma/client";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { createManagedUser } from "@/lib/admin/users";
import type { AuthzScope, Permission } from "@/lib/authz";
import {
    AuthzErrorCode,
    decideOrganizerPermission,
    decideOwnResourcePermission,
    decidePlatformPermission,
    PERMISSIONS,
    requireOrganizerAccess,
    resolveAuthzScope,
} from "@/lib/authz";
import { __maps } from "@/lib/authz/permissions";
import { buildDashboardNav } from "@/components/dashboard/DashboardAppShell";
import { computeDashboardCapabilities } from "@/lib/dashboard/scope";
import { ERROR_CODES } from "@/lib/api/errors";
import { createEvent, publishEvent } from "@/lib/events/service";
import {
    assignPicToEvent,
    createPic,
    updatePicStatus,
} from "@/lib/pic/service";
import { mintPicReferralToken, PIC_REFERRAL_SECRET_ENV } from "@/lib/pic/referral";
import {
    getMyFeeSummary,
    requireMyPic,
} from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { createTicketOrder } from "@/lib/ticketing/checkout";
import { checkInTicket } from "@/lib/ticketing/checkin/service";
import { settleVerifiedPayment } from "@/lib/ticketing/payment/settlement";
import {
    approveRefund,
    executeRefund,
    requestRefund,
    settleRefund,
} from "@/lib/ticketing/refunds/service";
import {
    approveSettlement,
    paySettlement,
    prepareSettlement,
    recordSettlementProof,
    submitSettlement,
} from "@/lib/ticketing/settlement/service";
import { issueTicketsForOrder } from "@/lib/ticketing/tickets/issuance";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(240_000);

const SUFFIX = `p40-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const FUTURE_END = new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000);
const PRICE = "150000.00";
const FIXTURE_VISIBILITY = "UNLISTED" as const;

let uploadDir = "";

let admin: { id: string }; // platform ADMIN — holds the OWNER membership (bootstrap anchor)
let admin2: { id: string }; // second platform ADMIN — used for the grant-required proof
let manager: { id: string }; // platform MANAGER — product-created, ACTIVE MANAGER membership
let picUser: { id: string }; // platform PIC — product-created, ACTIVE profile
let picUserB: { id: string }; // second PIC for the grant/SoD isolation
let customer: { id: string }; // plain CUSTOMER
let gateStaff: { id: string }; // membership CHECKIN_STAFF + assignment (the door)
let gateStaffNoAssign: { id: string }; // membership CHECKIN_STAFF, NO assignment
let stranger: { id: string };

let org: { id: string };
let strangerOrg: { id: string };
let sportId: string;
let event: { id: string };
let type: { id: string };

let picProfile: { id: string };
let picProfileB: { id: string };

let order1: { orderId: string; orderNumber: string; total: string };
let order2: { orderId: string; orderNumber: string; total: string };

const createdIds: string[] = [];

function fakeRequest(urlPath: string): Request {
    return new Request("http://localhost" + urlPath);
}

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: {
                      id: userId,
                      email: `${SUFFIX}-${userId}@example.test`,
                      name: "Fixture",
                  },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

async function createUser(tag: string, platformRole?: "ADMIN" | "MANAGER" | "PIC") {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
        select: { id: true },
    });
}

async function scopeAs(userId: string): Promise<AuthzScope> {
    signInAs(userId);
    const scope = await resolveAuthzScope(userId);
    if (!scope) throw new Error("Fixture error: no scope");
    return scope;
}

async function organizerActor(
    organizerId: string,
    userId: string,
    permission: Permission
): Promise<AuthzScope> {
    signInAs(userId);
    return requireOrganizerAccess(organizerId, permission);
}

function tokenFor(picProfileId: string, eventId: string): string {
    const token = mintPicReferralToken({ picProfileId, eventId });
    if (!token) throw new Error("Fixture error: mintPicReferralToken returned null");
    return token;
}

let orderSeq = 0;

async function buyWithToken(
    tag: string,
    qty: number,
    token: string | null,
    asUserId: string
): Promise<{ orderId: string; orderNumber: string; total: string }> {
    orderSeq += 1;
    const actor = await scopeAs(asUserId);
    const result = await createTicketOrder({
        request: {
            eventId: event.id,
            items: [{ ticketTypeId: type.id, quantity: qty }],
            buyerName: `Buyer ${tag}`,
            buyerEmail: `${tag}-${SUFFIX}@example.test`,
            buyerPhone: "081234567890",
            shareToken: token,
        } as never,
        actor,
        idempotencyKey: `phase40-ck-${orderSeq}-${tag}-${SUFFIX}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
    });

    const orderId = result.payload.orderId;
    const row = await prisma.eventOrder.findUniqueOrThrow({
        where: { id: orderId },
        select: { orderNumber: true, total: true },
    });

    return { orderId, orderNumber: row.orderNumber, total: row.total.toString() };
}

async function settle(orderId: string, total: string) {
    const outcome = await settleVerifiedPayment({
        orderId,
        paymentId: null,
        provider: "ipaymu",
        providerTransactionId: null,
        providerSessionId: null,
        amountReported: total,
        providerFeeReported: null,
        statusCode: "00",
        channel: "cstore",
        eventType: "PAID",
    });

    expect(outcome.outcome).toBe("SETTLED");
}

async function issueOrder(orderNumber: string, buyerId: string) {
    const actor = await scopeAs(buyerId);
    await issueTicketsForOrder({
        orderNumber,
        actor,
        request: fakeRequest(`/api/ticketing/orders/${orderNumber}/issue`),
    });
}

async function ticketsFor(orderId: string) {
    return prisma.ticket.findMany({
        where: { orderId },
        orderBy: { sequenceNo: "asc" },
    });
}

function pdfFile(name: string): File {
    return new File([Buffer.from("%PDF-1.4 fake-transfer-proof")], `${name}.pdf`, {
        type: "application/pdf",
    });
}

beforeAll(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "phase40-proof-"));
    process.env.UPLOAD_DIR = uploadDir;
    process.env[PIC_REFERRAL_SECRET_ENV] = `phase40-secret-${SUFFIX}`;

    // ── the four roles of the audit ────────────────────────────────────────
    admin = await createUser("admin", "ADMIN");
    admin2 = await createUser("admin2", "ADMIN");
    picUser = await createUser("pic", "PIC");
    picUserB = await createUser("picb", "PIC");
    customer = await createUser("customer");
    gateStaff = await createUser("gate");
    gateStaffNoAssign = await createUser("gate-noassign");
    stranger = await createUser("stranger");

    createdIds.push(
        admin.id,
        admin2.id,
        picUser.id,
        picUserB.id,
        customer.id,
        gateStaff.id,
        gateStaffNoAssign.id,
        stranger.id
    );

    // ── the platform-owned anchor organizer (bootstrap state: a platform ADMIN
    //    holds an ACTIVE OWNER membership) ─────────────────────────────────
    org = await prisma.organizer.create({
        data: {
            ownerUserId: admin.id,
            name: `Phase40 Org ${SUFFIX}`,
            slug: `phase40-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    strangerOrg = await prisma.organizer.create({
        data: {
            ownerUserId: stranger.id,
            name: `Phase40 Stranger ${SUFFIX}`,
            slug: `phase40-stranger-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: org.id, userId: admin.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: org.id, userId: admin2.id, role: "OWNER", status: "ACTIVE" },
            {
                organizerId: strangerOrg.id,
                userId: stranger.id,
                role: "OWNER",
                status: "ACTIVE",
            },
            // The gate staff memberships — the door needs no owner power.
            {
                organizerId: org.id,
                userId: gateStaff.id,
                role: "CHECKIN_STAFF",
                status: "ACTIVE",
            },
            {
                organizerId: org.id,
                userId: gateStaffNoAssign.id,
                role: "CHECKIN_STAFF",
                status: "ACTIVE",
            },
        ],
    });

    // The product surface for the MANAGER — provisioning an ACTIVE MANAGER membership
    // is part of the Phase 38 product contract (same anchor-organizer rule).
    const adminScope = await scopeAs(admin.id);
    const managerCreated = (await createManagedUser(adminScope, {
        name: `Manager ${SUFFIX}`,
        email: `manager-${SUFFIX}@example.test`,
        password: "PasswordRahasia1",
        role: "MANAGER",
    })) as { id: string };
    manager = { id: managerCreated.id };
    createdIds.push(manager.id);

    // The PIC accounts, through the product surface too.
    const picManaged = (await createManagedUser(adminScope, {
        name: `Pic A ${SUFFIX}`,
        email: `pic-a-${SUFFIX}@example.test`,
        password: "PasswordRahasia1",
        role: "PIC",
        pic: { displayName: `Pic A ${SUFFIX}` },
    })) as { id: string };
    const picManagedB = (await createManagedUser(adminScope, {
        name: `Pic B ${SUFFIX}`,
        email: `pic-b-${SUFFIX}@example.test`,
        password: "PasswordRahasia1",
        role: "PIC",
        pic: { displayName: `Pic B ${SUFFIX}` },
    })) as { id: string };
    createdIds.push(picManaged.id, picManagedB.id);

    for (const [userId, which] of [
        [picManaged.id, "A"],
        [picManagedB.id, "B"],
    ] as const) {
        const profile = await prisma.pICProfile.findUniqueOrThrow({
            where: { userId },
            select: { id: true },
        });

        // Approval is a deliberate second step, exactly as in the product.
        await updatePicStatus(adminScope, profile.id, { status: "ACTIVE" });

        // Bank evidence is required for a MANUAL_TRANSFER payout.
        await prisma.pICProfile.update({
            where: { id: profile.id },
            data: {
                bankName: "Bank Fixture",
                bankAccountName: `Pic ${which} ${SUFFIX}`,
                bankAccountNumber: "1234567890",
            },
        });

        if (which === "A") {
            picProfile = { id: profile.id };
        } else {
            picProfileB = { id: profile.id };
        }
    }

    // ── sport + event + ticket type, the ADMIN-built inventory ─────────────
    sportId = (
        await prisma.sport.create({
            data: { name: `Sport ${SUFFIX}`, slug: `sport-${SUFFIX}`, isActive: true },
            select: { id: true },
        })
    ).id;

    const eventScope = await organizerActor(org.id, admin.id, PERMISSIONS.EVENT_WRITE);
    event = await createEvent(eventScope, org.id, {
        title: `P40 Event ${SUFFIX}`,
        sportId,
        startAt: FUTURE,
        endAt: FUTURE_END,
        visibility: FIXTURE_VISIBILITY,
    } as never);

    const typeScope = await organizerActor(org.id, admin.id, PERMISSIONS.EVENT_WRITE);
    type = await createTicketType(typeScope, event.id, {
        name: "Reguler",
        price: PRICE,
        quota: 500,
        minPerOrder: 1,
        maxPerOrder: 4,
    } as never);

    await publishEvent(typeScope, event.id);

    // The MANAGER assigns the PIC to the event (the PIC-assign step of the chain).
    const managerScope = await organizerActor(org.id, manager.id, PERMISSIONS.PIC_ASSIGN);
    await assignPicToEvent(
        managerScope,
        {
            picProfileId: picProfile.id,
            eventId: event.id,
            feeRateBp: 500,
        },
        fakeRequest("/api/organizer/events/" + event.id + "/pic")
    );

    // The second PIC too — attribution only exists for ACTIVE, non-revoked assignments
    // (lib/pic/attribution.ts), so an unassigned profile can mint no fee anywhere.
    await assignPicToEvent(
        managerScope,
        {
            picProfileId: picProfileB.id,
            eventId: event.id,
            feeRateBp: 250,
        },
        fakeRequest("/api/organizer/events/" + event.id + "/pic")
    );

    // The door itself: gateStaff keeps its CHECKIN_STAFF membership AND the explicit
    // event assignment design §7.3 demands (a gate member without one can scan nothing).
    const gateMember = await prisma.organizerMember.findFirstOrThrow({
        where: { organizerId: org.id, userId: gateStaff.id },
        select: { id: true },
    });
    await prisma.staffEventAssignment.create({
        data: {
            organizerMemberId: gateMember.id,
            eventId: event.id,
            organizerId: org.id,
            assignedByUserId: admin.id,
        },
    });
});

afterAll(async () => {
    const orderRows = await prisma.eventOrder.findMany({
        where: { eventId: event?.id },
        select: { id: true },
    });
    const orderIds = orderRows.map((r) => r.id);

    const profileIds = [picProfile?.id, picProfileB?.id].filter(Boolean) as string[];

    // Leaf tables first; every order of deletion follows an FK in the schema.
    await prisma.checkIn.deleteMany({ where: { eventId: event?.id } });
    await prisma.settlementItem.deleteMany({
        where: { settlement: { picProfileId: { in: profileIds } } },
    });
    await prisma.pICFeeLedger.deleteMany({
        where: {
            OR: [{ picProfileId: { in: profileIds } }, { orderId: { in: orderIds } }],
        },
    });
    await prisma.settlement.deleteMany({ where: { picProfileId: { in: profileIds } } });

    await prisma.refundItem.deleteMany({
        where: { refund: { eventOrderId: { in: orderIds } } },
    });
    await prisma.refund.deleteMany({ where: { eventOrderId: { in: orderIds } } });

    await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.ticketReservation.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.ticket.deleteMany({ where: { eventId: event?.id } });
    await prisma.pICAttribution.deleteMany({ where: { eventId: event?.id } });
    await prisma.eventOrderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.eventOrder.deleteMany({ where: { id: { in: orderIds } } });

    await prisma.pICEventAssignment.deleteMany({
        where: { eventId: event?.id },
    });
    await prisma.staffEventAssignment.deleteMany({ where: { eventId: event?.id } });
    await prisma.permissionGrant.deleteMany({
        where: { userId: { in: createdIds } },
    });
    await prisma.pICProfile.deleteMany({
        where: { OR: [{ id: { in: profileIds } }, { userId: { in: createdIds } }] },
    });

    await prisma.organizerMember.deleteMany({
        where: {
            OR: [
                { organizerId: { in: [org?.id, strangerOrg?.id] } },
                { userId: { in: createdIds } },
            ],
        },
    });
    await prisma.ticketType.deleteMany({ where: { eventId: event?.id } });
    await prisma.event.deleteMany({
        where: { organizerId: { in: [org?.id, strangerOrg?.id] } },
    });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizer.deleteMany({
        where: { id: { in: [org?.id, strangerOrg?.id].filter(Boolean) as string[] } },
    });

    await prisma.adminAuditLog.deleteMany({
        where: {
            OR: [
                { actorUserId: { in: createdIds } },
                { description: { contains: SUFFIX } },
            ],
        },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdIds } } });

    delete process.env.UPLOAD_DIR;
    delete process.env[PIC_REFERRAL_SECRET_ENV];
});

/* ==================================================================================
 * PART A — ONE CONNECTED WORKFLOW, FOUR ROLES
 * ================================================================================== */

describe("PART A — ADMIN builds · MANAGER assigns · PIC links · CUSTOMER buys · gate admits", () => {
    test("A1: the ADMIN-built event is purchasable (created DRAFT → published)", async () => {
        const row = await prisma.event.findUniqueOrThrow({
            where: { id: event.id },
            select: { status: true, organizerId: true },
        });
        expect(row.status).toBe("PUBLISHED");
        expect(row.organizerId).toBe(org.id);

        const tt = await prisma.ticketType.findUniqueOrThrow({
            where: { id: type.id },
            select: { quota: true, sold: true, reserved: true },
        });
        expect(tt.quota).toBe(500);
        expect(tt.quota - tt.sold - tt.reserved).toBeGreaterThan(0); // purchasable inventory
    });

    test("A2: the MANAGER assigned the PIC (pic.assign ran as the manager)", async () => {
        const assignment = await prisma.pICEventAssignment.findUniqueOrThrow({
            where: { picProfileId_eventId: { picProfileId: picProfile.id, eventId: event.id } },
            select: {
                organizerId: true,
                feeRateBp: true,
                isActive: true,
                assignedByUserId: true,
            },
        });

        expect(assignment.organizerId).toBe(org.id);
        expect(assignment.feeRateBp).toBe(500);
        expect(assignment.isActive).toBe(true);
        expect(assignment.assignedByUserId).toBe(manager.id);
    });

    test("A3: the CUSTOMER's purchase through the PIC link freezes fee + attribution", async () => {
        order1 = await buyWithToken("order1", 2, tokenFor(picProfile.id, event.id), customer.id);

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order1.orderId },
            select: {
                picProfileId: true,
                subtotal: true,
                picFeeTotal: true,
                organizerNetAmount: true,
                total: true,
                items: {
                    select: {
                        picFeeAmount: true,
                        picFeeType: true,
                        basisType: true,
                        rateBp: true,
                        basisAmount: true,
                        quantity: true,
                    },
                },
            },
        });

        expect(orderRow.picProfileId).toBe(picProfile.id);
        // D-23: organizer ABSORBS the fee; the buyer's total is untouched.
        expect(orderRow.subtotal.toString()).toBe("300000");
        expect(orderRow.picFeeTotal.toString()).toBe("15000");
        expect(orderRow.total.toString()).toBe("300000");
        expect(orderRow.organizerNetAmount.toString()).toBe("285000");

        const item = orderRow.items[0];
        expect(item).toMatchObject({
            picFeeType: "PERCENTAGE",
            basisType: "GROSS_BEFORE_DISCOUNT",
            rateBp: 500,
            quantity: 2,
        });
        expect(item.picFeeAmount?.toString()).toBe("15000");
        expect(item.basisAmount?.toString()).toBe("300000");

        const attribution = await prisma.pICAttribution.findUniqueOrThrow({
            where: { orderId: order1.orderId },
            select: {
                picProfileId: true,
                source: true,
                method: true,
                selfReferral: true,
            },
        });
        expect(attribution.picProfileId).toBe(picProfile.id);
        expect(attribution.source).toBe("PIC_LINK");
        expect(attribution.method).toBe("LINK");
        expect(attribution.selfReferral).toBe(false);
    });

    test("A4: settling the payment posts the EARNED fee exactly once (the replay)", async () => {
        await settle(order1.orderId, order1.total);

        const rows = await prisma.pICFeeLedger.findMany({
            where: { orderId: order1.orderId },
        });
        expect(rows).toHaveLength(1);

        expect(rows[0]).toMatchObject({
            type: "EARNED",
            direction: "CREDIT",
            status: "EARNED",
            rateBp: 500,
            feeType: "PERCENTAGE",
            basisType: "GROSS_BEFORE_DISCOUNT",
            quantity: 2,
            picProfileId: picProfile.id,
            orderItemId: expect.anything(),
        });
        expect(rows[0].amount.toString()).toBe("15000");
        expect(rows[0].basisAmount.toString()).toBe("300000");
        expect(rows[0].idempotencyKey).toBe(`fee:earned:${rows[0].orderItemId}`);

        // Re-delivering the same verified payment is an idempotent no-op.
        const replay = await settleVerifiedPayment({
            orderId: order1.orderId,
            paymentId: null,
            provider: "ipaymu",
            providerTransactionId: null,
            providerSessionId: null,
            amountReported: order1.total,
            providerFeeReported: null,
            statusCode: "00",
            channel: "cstore",
            eventType: "PAID",
        });
        expect(replay.outcome).toBe("ALREADY_PAID");
        expect(await prisma.pICFeeLedger.count({ where: { orderId: order1.orderId } })).toBe(1);
    });

    test("A5: the buyer's ticket is issued, then admitted by the assigned gate staff", async () => {
        await issueOrder(order1.orderNumber, customer.id);
        const tickets = await ticketsFor(order1.orderId);
        expect(tickets).toHaveLength(2);

        const gateScope = await organizerActor(org.id, gateStaff.id, PERMISSIONS.CHECKIN_SCAN);
        expect(gateScope.userId).toBe(gateStaff.id);

        const admitted = await checkInTicket({
            eventId: event.id,
            input: { code: tickets[0].ticketCode },
            request: fakeRequest(`/api/organizer/events/${event.id}/check-in`),
        });

        expect(admitted.result).toBe("SUCCESS");
        expect(admitted.ticket.status).toBe("CHECKED_IN");

        const fresh = await prisma.ticket.findUniqueOrThrow({
            where: { id: tickets[0].id },
            select: { status: true, checkedInAt: true },
        });
        expect(fresh.status).toBe("CHECKED_IN");
        expect(fresh.checkedInAt).not.toBeNull();
    });
});

/* ==================================================================================
 * PART B — THE MONEY CHAIN FOLDS BACK: REFUND REVERSAL → SETTLEMENT
 * ================================================================================== */

describe("PART B — refund reversal · settlement prepare/approve/evidence/pay", () => {
    test("B1: a partial refund reverses the PIC fee proportionally (D-P17-12)", async () => {
        order2 = await buyWithToken("order2", 2, tokenFor(picProfile.id, event.id), customer.id);
        await settle(order2.orderId, order2.total);
        await issueOrder(order2.orderNumber, customer.id);

        const tickets = await ticketsFor(order2.orderId);
        expect(tickets).toHaveLength(2);

        const buyer = await scopeAs(customer.id);
        const requested = await requestRefund(
            {
                orderNumber: order2.orderNumber,
                ticketIds: [tickets[0].id],
                reason: "Berubah pikiran",
            },
            buyer,
            fakeRequest("/api/ticketing/refunds")
        );

        const managerScope = await organizerActor(
            org.id,
            manager.id,
            PERMISSIONS.REFUND_APPROVE
        );
        await approveRefund(requested.refundId, managerScope, {}, fakeRequest("/api/ticketing/refunds"));
        await executeRefund(requested.refundId, managerScope, {}, fakeRequest("/api/ticketing/refunds"));
        await settleRefund(
            requested.refundId,
            { transferRef: `BCA-P40-${SUFFIX}` },
            managerScope,
            fakeRequest("/api/ticketing/refunds")
        );

        const refundRow = await prisma.refund.findUniqueOrThrow({
            where: { id: requested.refundId },
            select: { status: true, feeTreatment: true, confirmedAmount: true },
        });
        expect(refundRow.status).toBe("REFUNDED");
        expect(refundRow.feeTreatment).toBe("REVERSED");
        expect(refundRow.confirmedAmount.toFixed(2)).toBe("150000.00");

        const reversals = await prisma.pICFeeLedger.findMany({
            where: { orderId: order2.orderId, type: "REVERSAL" },
            orderBy: { createdAt: "asc" },
        });
        expect(reversals).toHaveLength(1);
        expect(reversals[0]).toMatchObject({
            direction: "DEBIT",
            status: "VOID",
            quantity: 1,
        });
        expect(reversals[0].amount.toFixed(2)).toBe("7500.00");
        expect(reversals[0].reversalRef).toBe(String(requested.refundId));
    });

    test("B2: ADMIN prepares the payout window; ADMIN may not approve its own work (SoD)", async () => {
        const win = {
            start: new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString(),
            end: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        };

        const adminScope = await organizerActor(org.id, admin.id, PERMISSIONS.SETTLEMENT_PREPARE);
        const prepared = await prepareSettlement(
            { organizerId: org.id, picProfileId: picProfile.id, periodStart: win.start, periodEnd: win.end },
            adminScope
        );

        expect(prepared.id).toBeTruthy();
        expect(prepared.picProfileId).toBe(picProfile.id);
        // The window catches BOTH paid orders: 15000 + 15000, minus the 7500 reversal.
        expect(prepared.grossAmount).toBe("30000.00");
        expect(prepared.deductionAmount).toBe("7500.00");
        expect(prepared.netAmount).toBe("22500.00");
        expect(prepared.status).toBe("DRAFT");
        expect(prepared.preparedByUserId).toBe(admin.id);

        // The ADMIN preparer must not approve their own work either — here the D-19
        // grant gate fires first (no grant, so the decider refuses before SoD can).
        await expect(
            approveSettlement(prepared.id, adminScope)
        ).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });

        // The MANAGER approves by role — no grant exists and none is needed.
        const managerScope = await organizerActor(
            org.id,
            manager.id,
            PERMISSIONS.SETTLEMENT_APPROVE
        );
        await submitSettlement(prepared.id, adminScope);
        const approved = await approveSettlement(prepared.id, managerScope);
        expect(approved.status).toBe("APPROVED");
    });

    test("B3: evidence + manual payment; EARNED flips to SETTLED and PAYOUT posts", async () => {
        const settlementRow = await prisma.settlement.findFirstOrThrow({
            where: { picProfileId: picProfile.id },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });

        const managerScope = await organizerActor(
            org.id,
            manager.id,
            PERMISSIONS.SETTLEMENT_PROOF_UPLOAD
        );
        await recordSettlementProof(
            settlementRow.id,
            pdfFile("p40-proof"),
            managerScope,
            fakeRequest("/api/organizer/settlements/x/proof")
        );

        const paidScope = await organizerActor(org.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE);
        const paid = await paySettlement(
            settlementRow.id,
            { providerReference: `TRF-P40-${SUFFIX}` },
            paidScope
        );
        expect(paid.status).toBe("PAID");

        const earned = await prisma.pICFeeLedger.findMany({
            where: { picProfileId: picProfile.id, type: "EARNED" },
            orderBy: { createdAt: "asc" },
        });
        expect(earned).toHaveLength(2);
        for (const row of earned) {
            expect(row.status).toBe("SETTLED");
            expect(row.settlementId).toBe(settlementRow.id);
        }

        const reversal = await prisma.pICFeeLedger.findFirstOrThrow({
            where: { picProfileId: picProfile.id, type: "REVERSAL" },
        });
        expect(reversal.settlementId).toBe(settlementRow.id);

        const payouts = await prisma.pICFeeLedger.findMany({
            where: { picProfileId: picProfile.id, type: "PAYOUT" },
            orderBy: { createdAt: "asc" },
        });
        expect(payouts).toHaveLength(2);
        const payoutTotal = payouts.reduce(
            (sum, r) => sum.plus(r.amount),
            new Prisma.Decimal(0)
        );
        expect(payoutTotal.toFixed(2)).toBe("22500.00");
        // One PAYOUT row per included EARNED, each net of its reversal offset:
        // order1 15000 (no reversal) and order2 15000 − 7500.
        expect(payouts.map((r) => r.amount.toFixed(2)).sort()).toEqual([
            "15000.00",
            "7500.00",
        ]);
    });

    test("B4: an ADMIN without a grant cannot approve (D-19); the grant unlocks it", async () => {
        // A second PIC + one paid order through the real chain, so the second
        // settlement has items of its own.
        await buyWithToken("order3", 1, tokenFor(picProfileB.id, event.id), customer.id).then(
            async (order3) => {
                await settle(order3.orderId, order3.total);
            }
        );

        const win = {
            start: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
            end: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        };

        // MANAGER prepares a second settlement; admin2 is a bystander.
        const managerScope = await organizerActor(org.id, manager.id, PERMISSIONS.SETTLEMENT_PREPARE);
        const prepared = await prepareSettlement(
            { organizerId: org.id, picProfileId: picProfileB.id, periodStart: win.start, periodEnd: win.end },
            managerScope
        );
        expect(prepared.netAmount).toBe("3750.00"); // 1 ticket @ picProfileB's 250bp override
        await submitSettlement(prepared.id, managerScope);

        // A MANAGER does hold approve by role — so for THEM the SoD guard is the
        // first rejection the preparer meets (D-R22: never approve your own payout).
        await expect(approveSettlement(prepared.id, managerScope)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
            details: { reason: "SEPARATION_OF_DUTIES" },
        });

        const admin2Scope = await scopeAs(admin2.id);
        // Without the grant the decider refuses before the map is even consulted.
        expect(
            decideOrganizerPermission(admin2Scope, org.id, PERMISSIONS.SETTLEMENT_APPROVE).allowed
        ).toBe(false);

        await expect(approveSettlement(prepared.id, admin2Scope)).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
        });

        // The explicit, audited grant is the single channel that unlocks it. A scope is
        // a snapshot of its grants, so admin2's scope is re-resolved afterwards.
        await prisma.permissionGrant.create({
            data: {
                userId: admin2.id,
                organizerId: org.id,
                permission: PERMISSIONS.SETTLEMENT_APPROVE,
                grantedByUserId: admin.id,
            },
        });

        const admin2GrantedScope = await scopeAs(admin2.id);
        const after = decideOrganizerPermission(
            admin2GrantedScope,
            org.id,
            PERMISSIONS.SETTLEMENT_APPROVE
        );
        expect(after.allowed).toBe(true);

        const approved = await approveSettlement(prepared.id, admin2GrantedScope);
        expect(approved.status).toBe("APPROVED");
    });
});

/* ==================================================================================
 * PART C — THE AUTHORITY MATRIX (deciders + dashboard surface)
 * ================================================================================== */

describe("PART C — the authority matrix as the deciders enforce it", () => {
    test("C1: platform map — system control is ADMIN-only; MANAGER keeps audit read", async () => {
        const adminScope = await scopeAs(admin.id);
        const managerScope = await scopeAs(manager.id);
        const picScope = await scopeAs(picUser.id);

        expect(decidePlatformPermission(adminScope, PERMISSIONS.USER_MANAGE).allowed).toBe(true);
        expect(decidePlatformPermission(adminScope, PERMISSIONS.PIC_MANAGE).allowed).toBe(true);
        expect(decidePlatformPermission(adminScope, PERMISSIONS.APPLICATION_SETTINGS).allowed).toBe(true);

        expect(decidePlatformPermission(managerScope, PERMISSIONS.USER_MANAGE).allowed).toBe(false);
        expect(decidePlatformPermission(managerScope, PERMISSIONS.ROLE_MANAGE).allowed).toBe(false);
        expect(decidePlatformPermission(managerScope, PERMISSIONS.APPLICATION_SETTINGS).allowed).toBe(false);
        expect(decidePlatformPermission(managerScope, PERMISSIONS.AUDIT_LOG_READ).allowed).toBe(true);

        expect(decidePlatformPermission(picScope, PERMISSIONS.USER_MANAGE).allowed).toBe(false);
    });

    test("C2: organizer map — MANAGER is fully operational; a no-grant ADMIN is not financial", async () => {
        const adminScope = await scopeAs(admin.id);
        const managerScope = await scopeAs(manager.id);

        for (const permission of [
            PERMISSIONS.EVENT_WRITE,
            PERMISSIONS.EVENT_PUBLISH,
            PERMISSIONS.REFUND_APPROVE,
            PERMISSIONS.REFUND_EXECUTE,
            PERMISSIONS.SETTLEMENT_PREPARE,
            PERMISSIONS.SETTLEMENT_APPROVE,
            PERMISSIONS.FEE_RATE_CHANGE,
            PERMISSIONS.PIC_ASSIGN,
        ]) {
            expect({
                permission,
                allowed: decideOrganizerPermission(managerScope, org.id, permission).allowed,
            }).toEqual({ permission, allowed: true });
        }

        // D-19: the ADMIN role holds no financial consent by default.
        for (const permission of [
            PERMISSIONS.SETTLEMENT_APPROVE,
            PERMISSIONS.REFUND_APPROVE,
            PERMISSIONS.FEE_ADJUST,
            PERMISSIONS.REPORT_EXPORT_FINANCIAL,
        ]) {
            expect({
                permission,
                allowed: decideOrganizerPermission(adminScope, org.id, permission).allowed,
            }).toEqual({ permission, allowed: false });
        }

        // …and the same for an ADMIN with a membership role of ADMIN (D-05: unmapped).
        const memberAdminUser = await createUser("member-admin");
        createdIds.push(memberAdminUser.id);
        await prisma.organizerMember.create({
            data: {
                organizerId: org.id,
                userId: memberAdminUser.id,
                role: "ADMIN",
                status: "ACTIVE",
            },
        });
        const memberAdminScope = await scopeAs(memberAdminUser.id);
        expect(
            decideOrganizerPermission(memberAdminScope, org.id, PERMISSIONS.EVENT_READ).allowed
        ).toBe(false);
        expect(
            decideOrganizerPermission(memberAdminScope, org.id, PERMISSIONS.SETTLEMENT_APPROVE).allowed
        ).toBe(false);
    });

    test("C3: own-scope map — a tenant membership buys nothing on another user's records", async () => {
        const maps = __maps.PLATFORM_ROLE_OWN_PERMISSIONS;

        // Deliberate PIC asymmetry (Phase 8): issue own tickets, but never cancel them.
        expect(maps.CUSTOMER.has(PERMISSIONS.ORDER_CANCEL_OWN)).toBe(true);
        expect(maps.PIC.has(PERMISSIONS.ORDER_CANCEL_OWN)).toBe(false);
        expect(maps.PIC.has(PERMISSIONS.TICKET_ISSUE_OWN)).toBe(true);

        expect(maps.PIC.has(PERMISSIONS.PIC_FEE_READ_OWN)).toBe(true);
        expect(maps.PIC.has(PERMISSIONS.PIC_ATTRIBUTION_READ_OWN)).toBe(true);
        expect(maps.CUSTOMER.has(PERMISSIONS.PIC_FEE_READ_OWN)).toBe(false);

        // Identity gate: cross-user own-scope reads are refused with the 404-class code.
        const managerScope = await scopeAs(manager.id);
        const crossUser = decideOwnResourcePermission(
            managerScope,
            PERMISSIONS.ORDER_READ_OWN,
            customer.id
        );
        expect(crossUser).toMatchObject({
            allowed: false,
            code: AuthzErrorCode.PIC_ACCESS_DENIED,
        });

        // A member MANAGER may not reach a PIC's earnings through own-scope either.
        const feePeek = decideOwnResourcePermission(
            managerScope,
            PERMISSIONS.PIC_FEE_READ_OWN,
            picUser.id
        );
        expect(feePeek.allowed).toBe(false);
    });

    test("C4: tenant isolation — a foreign organizer answers 404, not 403", async () => {
        const managerScope = await scopeAs(manager.id);
        expect(
            decideOrganizerPermission(managerScope, strangerOrg.id, PERMISSIONS.EVENT_READ)
        ).toMatchObject({ allowed: false, code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });

        await expect(
            prepareSettlement({
                organizerId: strangerOrg.id,
                picProfileId: picProfile.id,
                periodStart: new Date(Date.now() - 3600_000).toISOString(),
                periodEnd: new Date(Date.now() + 86_400_000).toISOString(),
            }, managerScope)
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });

        const strangerScope = await scopeAs(stranger.id);
        for (const permission of [
            PERMISSIONS.EVENT_READ,
            PERMISSIONS.ORDER_READ_TENANT,
            PERMISSIONS.CHECKIN_SCAN,
        ]) {
            expect(
                decideOrganizerPermission(strangerScope, org.id, permission).allowed
            ).toBe(false);
        }
    });

    test("C5: membership roles are least-privilege (FINANCE · CHECKIN_STAFF · PIC_VIEWER)", async () => {
        const finance = await createUser("finance-member");
        const picViewer = await createUser("pic-member");
        createdIds.push(finance.id, picViewer.id);
        await prisma.organizerMember.createMany({
            data: [
                { organizerId: org.id, userId: finance.id, role: "FINANCE", status: "ACTIVE" },
                { organizerId: org.id, userId: picViewer.id, role: "PIC", status: "ACTIVE" },
            ],
        });

        const financeScope = await scopeAs(finance.id);
        expect(decideOrganizerPermission(financeScope, org.id, PERMISSIONS.REPORT_TRANSACTION_READ).allowed).toBe(true);
        expect(decideOrganizerPermission(financeScope, org.id, PERMISSIONS.EVENT_WRITE).allowed).toBe(false);
        expect(decideOrganizerPermission(financeScope, org.id, PERMISSIONS.SETTLEMENT_APPROVE).allowed).toBe(true);

        const checkinStaffScope = await scopeAs(gateStaff.id);
        expect(decideOrganizerPermission(checkinStaffScope, org.id, PERMISSIONS.CHECKIN_SCAN).allowed).toBe(true);
        expect(decideOrganizerPermission(checkinStaffScope, org.id, PERMISSIONS.EVENT_WRITE).allowed).toBe(false);
        expect(decideOrganizerPermission(checkinStaffScope, org.id, PERMISSIONS.ORDER_READ_TENANT).allowed).toBe(false);

        // §5.3 PIC_VIEWER sees WHO is attributed, never the money.
        const picViewerScope = await scopeAs(picViewer.id);
        expect(decideOrganizerPermission(picViewerScope, org.id, PERMISSIONS.PIC_ATTRIBUTION_READ_ALL).allowed).toBe(true);
        expect(decideOrganizerPermission(picViewerScope, org.id, PERMISSIONS.PIC_FEE_READ_ALL).allowed).toBe(false);
    });

    test("C6: the MANAGER dashboard is operational, but system control is absent", async () => {
        const managerScope = await scopeAs(manager.id);
        const capabilities = computeDashboardCapabilities(managerScope);
        const hrefs = buildDashboardNav(capabilities)
            .flatMap((group) => group.items)
            .map((item) => item.href);

        expect(capabilities.hasTenantAccess).toBe(true);
        expect(capabilities.canManageEvents).toBe(true);
        expect(capabilities.canManageSettlements).toBe(true);
        expect(capabilities.canAssignPic).toBe(true);

        expect(capabilities.canManageUsers).toBe(false);
        expect(capabilities.canManageApplicationSettings).toBe(false);
        expect(capabilities.canManagePlatformPic).toBe(false);

        for (const systemHref of [
            "/dashboard/users",
            "/dashboard/settings/application",
            "/dashboard/settings/branding",
            "/dashboard/settings/maintenance",
        ]) {
            expect(hrefs).not.toContain(systemHref);
        }
        for (const operationalHref of [
            "/dashboard/events",
            "/dashboard/orders",
            "/dashboard/settlements",
            "/dashboard/check-in",
            "/dashboard/pic",
        ]) {
            expect(hrefs).toContain(operationalHref);
        }
    });
});

/* ==================================================================================
 * PART D — MULTI-ROLE IDENTITY (Phase 33 promotion · Phase 23A operator-as-buyer)
 * ================================================================================== */

describe("PART D — one account, two worlds", () => {
    test("D1: a CUSTOMER promoted to PIC keeps buyers' rights and gains the PIC self-service", async () => {
        const dual = await createUser("dual");
        createdIds.push(dual.id);

        // 1. As a plain CUSTOMER they buy, settle and cannot touch PIC fee space.
        await buyWithToken("dual-buy", 1, null, dual.id);
        const customerScope2 = await scopeAs(dual.id);
        expect(
            decideOwnResourcePermission(customerScope2, PERMISSIONS.ORDER_READ_OWN, dual.id).allowed
        ).toBe(true);
        expect(
            decideOwnResourcePermission(customerScope2, PERMISSIONS.PIC_FEE_READ_OWN, dual.id).allowed
        ).toBe(false);

        // 2. The ADMIN promotes the same account (Phase 33: platformRole PIC, same row).
        //    `user.manage`-style PIC_MANAGE is platform-scope — a plain platform scope,
        //    not an organizer tenant scope, is exactly what the rail takes.
        const adminScope = await scopeAs(admin.id);
        const promoted = (await createPic(adminScope, {
            email: `dual-${SUFFIX}@example.test`,
            displayName: `Dual ${SUFFIX}`,
            defaultFeeRateBp: 500,
            bankName: "Bank Fixture",
            bankAccountName: "Dual Fixture",
            bankAccountNumber: "1234567890",
        })) as { id: string };
        await updatePicStatus(adminScope, promoted.id, { status: "ACTIVE" });
        await prisma.pICProfile.update({
            where: { id: promoted.id },
            data: { bankAccountName: "Dual Fixture" },
        });

        await assignPicToEvent(
            await organizerActor(org.id, manager.id, PERMISSIONS.PIC_ASSIGN),
            { picProfileId: promoted.id, eventId: event.id, feeRateBp: 500 },
            fakeRequest("/api/organizer/events/" + event.id + "/pic")
        );

        const picScope = await scopeAs(dual.id);
        expect(picScope.platformRole).toBe("PIC");
        expect(
            decideOwnResourcePermission(picScope, PERMISSIONS.PIC_FEE_READ_OWN, dual.id).allowed
        ).toBe(true);
        expect(
            decideOwnResourcePermission(picScope, PERMISSIONS.ORDER_READ_OWN, dual.id).allowed
        ).toBe(true);
        expect(
            decideOwnResourcePermission(picScope, PERMISSIONS.ORDER_CANCEL_OWN, dual.id).allowed
        ).toBe(false); // the PIC map deliberately withholds cancel

        // 3. They buy again — through their OWN link — and it is a SELF-REFERRAL, not blocked.
        const selfToken = tokenFor(promoted.id, event.id);
        const selfBuy = await buyWithToken("self-buy", 1, selfToken, dual.id);
        await settle(selfBuy.orderId, selfBuy.total);

        const attribution = await prisma.pICAttribution.findUniqueOrThrow({
            where: { orderId: selfBuy.orderId },
            select: { selfReferral: true, picProfileId: true },
        });
        expect(attribution.selfReferral).toBe(true);
        expect(attribution.picProfileId).toBe(promoted.id);

        // 4. The promoted PIC self-service now reads the fee money of their own account.
        await scopeAs(dual.id);
        const viaSelfService = await requireMyPic(dual.id, [PERMISSIONS.PIC_FEE_READ_OWN]);
        expect(viaSelfService.picProfileId).toBe(promoted.id);
        const summary = await getMyFeeSummary(dual.id);
        expect(summary.earned.toFixed(2)).toBe("7500.00"); // self-buy 1 ticket @500bp
    });

    test("D2: a MANAGER-the-buyer owns their purchase, and the membership buys nothing extra", async () => {
        const managerBuy = await buyWithToken("mgr-buy", 1, null, manager.id);
        await settle(managerBuy.orderId, managerBuy.total);
        await issueOrder(managerBuy.orderNumber, manager.id);

        const tickets = await ticketsFor(managerBuy.orderId);
        expect(tickets).toHaveLength(1);

        const managerScope = await scopeAs(manager.id);
        expect(
            decideOwnResourcePermission(managerScope, PERMISSIONS.ORDER_READ_OWN, manager.id).allowed
        ).toBe(true);
        expect(
            decideOwnResourcePermission(managerScope, PERMISSIONS.TICKET_ISSUE_OWN, manager.id).allowed
        ).toBe(true);

        // …but the same scope still cannot read the CUSTOMER's own-scope order.
        expect(
            decideOwnResourcePermission(managerScope, PERMISSIONS.ORDER_READ_OWN, customer.id)
        ).toMatchObject({ allowed: false, code: AuthzErrorCode.PIC_ACCESS_DENIED });
    });
});

/* ==================================================================================
 * PART E — NEGATIVE §19 CONTROLS, ALL AT THE SERVICE LEVEL
 * ================================================================================== */

describe("PART E — the negative controls that complete the audit", () => {
    test("E1: a CUSTOMER cannot even reach the settlement rail", async () => {
        const customerScope2 = await scopeAs(customer.id);
        await expect(
            prepareSettlement({
                organizerId: org.id,
                picProfileId: picProfile.id,
                periodStart: new Date(Date.now() - 3600_000).toISOString(),
                periodEnd: new Date(Date.now() + 86_400_000).toISOString(),
            }, customerScope2)
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });

    test("E2: an unassigned gate staff member cannot admit (NO_STAFF_ASSIGNMENT)", async () => {
        signInAs(gateStaffNoAssign.id);
        await expect(
            checkInTicket({
                eventId: event.id,
                input: { code: `EVT-P40-X${Math.random().toString(36).slice(2, 5)}` },
                request: fakeRequest(`/api/organizer/events/${event.id}/check-in`),
            })
        ).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
            details: { reason: "NO_STAFF_ASSIGNMENT" },
        });
    });

    test("E3: a CUSTOMER with no membership is answered as if the event did not exist", async () => {
        signInAs(customer.id);
        await expect(
            checkInTicket({
                eventId: event.id,
                input: { code: "EVT-AAAA-BBBB" },
                request: fakeRequest(`/api/organizer/events/${event.id}/check-in`),
            })
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });

    test("E4: a MANAGER cannot manage PIC accounts (platform-admin-only)", async () => {
        const managerScope = await scopeAs(manager.id);
        expect(
            decidePlatformPermission(managerScope, PERMISSIONS.PIC_MANAGE).allowed
        ).toBe(false);

        await expect(
            updatePicStatus(managerScope, picProfile.id, { status: "SUSPENDED", reason: "nope" })
        ).rejects.toMatchObject({ code: AuthzErrorCode.FORBIDDEN });
    });

    test("E5: the requester cannot settle their own refund (SoD)", async () => {
        const e5Buy = await buyWithToken("e5", 1, null, customer.id);
        await settle(e5Buy.orderId, e5Buy.total);
        await issueOrder(e5Buy.orderNumber, customer.id);
        const tickets = await ticketsFor(e5Buy.orderId);

        const buyer = await scopeAs(customer.id);
        const requested = await requestRefund(
            { orderNumber: e5Buy.orderNumber, ticketIds: [tickets[0].id], reason: "coba" },
            buyer,
            fakeRequest("/api/ticketing/refunds")
        );

        const managerScope = await organizerActor(
            org.id,
            manager.id,
            PERMISSIONS.REFUND_APPROVE
        );
        await approveRefund(
            requested.refundId,
            managerScope,
            {},
            fakeRequest("/api/ticketing/refunds")
        );
        await executeRefund(
            requested.refundId,
            managerScope,
            {},
            fakeRequest("/api/ticketing/refunds")
        );

        // (a) Service-level SoD: an operator presenting the requester's own identity is
        //     refused before any transfer evidence is recorded.
        await expect(
            settleRefund(
                requested.refundId,
                { transferRef: `BCA-E5-${SUFFIX}` },
                buyer,
                fakeRequest("/api/ticketing/refunds")
            )
        ).rejects.toMatchObject({
            code: ERROR_CODES.FORBIDDEN,
            details: { reason: "SEPARATION_OF_DUTIES" },
        });

        // (b) Route-equivalent: with the CUSTOMER as the live session the rail answers
        //     404, not 403 — the buyer cannot even reach the settle action.
        signInAs(customer.id);
        await expect(
            settleRefund(
                requested.refundId,
                { transferRef: `BCA-E5-${SUFFIX}` },
                buyer,
                fakeRequest("/api/ticketing/refunds")
            )
        ).rejects.toMatchObject({ code: AuthzErrorCode.ORGANIZER_ACCESS_DENIED });
    });
});