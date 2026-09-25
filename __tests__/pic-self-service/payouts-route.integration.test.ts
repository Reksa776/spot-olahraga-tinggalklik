/**
 * ==========================================
 * PIC PAYOUT REQUEST ROUTE (INTEGRATION, REAL DATABASE) — PHASE 21
 * ==========================================
 *
 * The ONE HTTP surface a PIC can reach for money: `POST /api/pic/payouts`. It is exercised
 * through the REAL route handler — same-origin check, `requireAuth`, the strict
 * `parseOrThrow(picPayoutRequestSchema, body)`, and the real settlement money engine — against
 * the real database. Only `@/auth` is mocked.
 *
 * It pins the route-level contract the service-only suite cannot see:
 *
 *   same-origin   a cross-site POST (or one with no Origin/Referer) is 403 before anything else;
 *   authn         an anonymous POST is 401;
 *   authz         an authenticated non-PIC account gets the never-confirming 404;
 *   strict body   ONLY `organizerId` (+ optional `notes`) is accepted — an arbitrary `amount`,
 *                 a `picProfileId` or a `status` is a 400 refusal;
 *   created       a valid request answers 201 with `status = REQUESTED`;
 *   no money      the EARNED ledger row is untouched (still EARNED, still unlinked) — a request
 *                 claims lines via `SettlementItem`, it never moves money.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { POST } from "@/app/api/pic/payouts/route";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120_000);

const ORIGIN = "https://tinggalklik.test";
const SUFFIX = `p21-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let owner: { id: string };
let picUser: { id: string };
let picProfile: { id: string };
let customer: { id: string };
let org: { id: string };
let sportId: string;
let event: { id: string };

const createdUsers: string[] = [];
const createdProfiles: string[] = [];

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: { id: userId, email: `${userId}@${SUFFIX}.test`, name: "Fixture" },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

/**
 * POST to the real route. `origin === null` sends NO Origin/Referer at all (the
 * fail-closed case); the default sends the same-origin header a browser would.
 */
async function postPayouts(
    body: unknown,
    userId: string | null,
    options: { origin?: string | null } = {}
): Promise<NextResponse> {
    signInAs(userId);

    const origin = options.origin === undefined ? ORIGIN : options.origin;
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (origin) {
        headers.origin = origin;
    }

    const request = new NextRequest(new URL(`${ORIGIN}/api/pic/payouts`), {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
    });

    return POST(request);
}

async function createUser(tag: string, platformRole: "PIC" | null = null) {
    const user = await prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
        select: { id: true },
    });

    createdUsers.push(user.id);
    return user;
}

async function postEarned(
    picProfileId: string,
    orderId: string,
    orderItemId: string,
    amount: string
) {
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId,
            organizerId: org.id,
            eventId: event.id,
            orderId,
            orderItemId,
            type: "EARNED",
            direction: "CREDIT",
            amount: new Prisma.Decimal(amount),
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(amount),
            quantity: 1,
            status: "EARNED",
            idempotencyKey: `fee:earned:${orderItemId}`,
        },
        select: { id: true },
    });
}

beforeAll(async () => {
    owner = await createUser("route-owner");
    customer = await createUser("route-customer");

    picUser = await createUser("route-pic", "PIC");

    picProfile = await prisma.pICProfile.create({
        data: {
            userId: picUser.id,
            picCode: `P21R-${SUFFIX}`.slice(0, 40),
            displayName: `PIC Route ${SUFFIX}`,
            status: "ACTIVE",
            approvedAt: new Date(),
            // A payee who cannot be paid is not offered — the engine refuses a request
            // without complete bank details, so the fixture must have them.
            bankName: "Bank Fixture",
            bankAccountName: "PIC Route Fixture",
            bankAccountNumber: "1234567890",
        },
        select: { id: true },
    });
    createdProfiles.push(picProfile.id);

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `P21 Route Org ${SUFFIX}`,
            slug: `p21-route-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `P21 Route Sport ${SUFFIX}`, slug: `p21-route-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    event = await prisma.event.create({
        data: {
            organizerId: org.id,
            sportId,
            title: `P21 Route Event ${SUFFIX}`,
            slug: `p21-route-event-${SUFFIX}`,
            eventCode: `P21R-${SUFFIX}`.slice(0, 40),
            status: "PUBLISHED",
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `P21R-${SUFFIX}`,
            organizerId: org.id,
            eventId: event.id,
            userId: owner.id,
            buyerName: "Fixture Buyer",
            status: "PAID",
            paymentStatus: "PAID",
            subtotal: new Prisma.Decimal("100000.00"),
            total: new Prisma.Decimal("100000.00"),
            organizerNetAmount: new Prisma.Decimal("100000.00"),
            paidAt: new Date(),
        },
        select: { id: true },
    });

    const orderItem = await prisma.eventOrderItem.create({
        data: {
            orderId: order.id,
            nameSnapshot: "Fixture Ticket",
            priceSnapshot: new Prisma.Decimal("100000.00"),
            quantity: 1,
            subtotal: new Prisma.Decimal("100000.00"),
        },
        select: { id: true },
    });

    await postEarned(picProfile.id, order.id, orderItem.id, "9900.00");
});

afterAll(async () => {
    await prisma.pICFeeLedger.deleteMany({
        where: { picProfileId: { in: createdProfiles } },
    });
    await prisma.settlementItem.deleteMany({
        where: { settlement: { picProfileId: { in: createdProfiles } } },
    });
    await prisma.settlement.deleteMany({
        where: { picProfileId: { in: createdProfiles } },
    });
    await prisma.eventOrderItem.deleteMany({ where: { order: { userId: owner.id } } });
    await prisma.eventOrder.deleteMany({ where: { userId: owner.id } });
    await prisma.pICProfile.deleteMany({ where: { id: { in: createdProfiles } } });
    await prisma.event.deleteMany({ where: { id: event.id } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizer.deleteMany({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
});

describe("POST /api/pic/payouts — same-origin and authentication", () => {
    it("refuses a cross-site POST with 403 before any parsing", async () => {
        const response = await postPayouts(
            { organizerId: org.id },
            picUser.id,
            { origin: "https://evil.example" }
        );

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe("FORBIDDEN");
    });

    it("refuses a state-changing POST with no Origin/Referer at all (fail-closed)", async () => {
        const response = await postPayouts(
            { organizerId: org.id },
            picUser.id,
            { origin: null }
        );

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe("FORBIDDEN");
    });

    it("refuses an anonymous POST with 401", async () => {
        const response = await postPayouts({ organizerId: org.id }, null);

        expect(response.status).toBe(401);
        expect((await response.json()).code).toBe("UNAUTHORIZED");
    });

    it("gives an authenticated non-PIC the never-confirming 404", async () => {
        const response = await postPayouts({ organizerId: org.id }, customer.id);

        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe("NOT_FOUND");
    });
});

describe("POST /api/pic/payouts — the body accepts only organizerId + optional notes", () => {
    it("rejects an arbitrary client `amount`", async () => {
        const response = await postPayouts(
            { organizerId: org.id, amount: 999999 },
            picUser.id
        );

        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(body.details?.fields ?? [])).toContain("amount");
    });

    it("rejects a client-supplied `picProfileId`", async () => {
        const response = await postPayouts(
            { organizerId: org.id, picProfileId: picProfile.id },
            picUser.id
        );

        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(body.details?.fields ?? [])).toContain("picProfileId");
    });

    it("rejects a client-supplied `status`", async () => {
        const response = await postPayouts(
            { organizerId: org.id, status: "APPROVED" },
            picUser.id
        );

        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(body.details?.fields ?? [])).toContain("status");
    });
});

describe("POST /api/pic/payouts — a valid request creates REQUESTED without moving money", () => {
    it("answers 201 with status REQUESTED and leaves the ledger untouched", async () => {
        const response = await postPayouts(
            { organizerId: org.id, notes: "Mohon diproses" },
            picUser.id
        );

        expect(response.status).toBe(201);

        const body = await response.json();

        expect(body.success).toBe(true);
        expect(body.data.status).toBe("REQUESTED");
        expect(body.data.organizerName).toContain("P21 Route Org");
        expect(body.data.netAmount).toBe("9900.00");

        const stored = await prisma.settlement.findUniqueOrThrow({
            where: { id: body.data.id },
            select: { status: true, payeeType: true, picProfileId: true, organizerId: true },
        });

        expect(stored.status).toBe("REQUESTED");
        expect(stored.payeeType).toBe("PIC");
        expect(stored.picProfileId).toBe(picProfile.id);
        expect(stored.organizerId).toBe(org.id);

        // The claim exists, but no fee row has been settled: request time moves no money.
        expect(
            await prisma.settlementItem.count({ where: { settlementId: body.data.id } })
        ).toBe(1);

        const ledger = await prisma.pICFeeLedger.findFirstOrThrow({
            where: { picProfileId: picProfile.id },
            select: { status: true, settlementId: true },
        });

        expect(ledger.status).toBe("EARNED");
        expect(ledger.settlementId).toBeNull();
    });
});
