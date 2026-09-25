/**
 * ==========================================
 * PIC SELF-SERVICE PAYOUT REQUEST (INTEGRATION, REAL DATABASE) — PHASE 21
 * ==========================================
 *
 * The PIC's own payout request, exercised through the REAL authz guards (`requireMyPic`)
 * and the REAL settlement money engine, against the real database. Only `@/auth` is mocked.
 *
 * It pins the properties the feature exists to guarantee:
 *
 *   own-scope     a PIC sees and requests only their OWN tenant's settleable fee;
 *   identity      a forged `userId` is PIC_ACCESS_DENIED, and a role without the new
 *                 `pic_payout.request.own` is FORBIDDEN even with an ACTIVE profile;
 *   derived money the amount is NEVER the client's: it equals the server-computed
 *                 settleable net (EARNED minus unsettled reversals);
 *   claim         the request lands as REQUESTED and claims the ledger rows through
 *                 `SettlementItem.picFeeLedgerId @unique` — so a second request finds
 *                 nothing, and two concurrent requests cannot consume the same fee twice;
 *   review        an operator approves or rejects; a rejection REQUIRES a reason, stores it
 *                 where the PIC reads it, and releases the claim;
 *   separation    the PIC can NEVER approve, reject or pay their own request;
 *   paid gate     PAID still requires proof + a transfer reference.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { Prisma } from "@prisma/client";

import { resolveAuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
    createMyPicPayoutRequest,
    listMyPicPayoutRequests,
    listMyPicSettleableOrganizers,
} from "@/lib/pic/payout";
import {
    approveSettlement,
    paySettlement,
    rejectSettlement,
} from "@/lib/ticketing/settlement/service";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(240_000);

const SUFFIX = `p21-payout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let owner: { id: string };
let manager: { id: string };
let stranger: { id: string };
let buyer: { id: string };

let orgA: { id: string };
let orgB: { id: string };
let sportId: string;
let event: { id: string };

const createdUsers: string[] = [];
const createdProfiles: string[] = [];
let picSeq = 0;

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: { id: userId, email: `${SUFFIX}-${userId}@example.test`, name: "Fixture" },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

async function createUser(
    tag: string,
    platformRole: "PIC" | "CUSTOMER" | null = null
): Promise<{ id: string }> {
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

/** A fresh ACTIVE PIC profile (with or without bank details) — one per scenario. */
async function makePic(
    tag: string,
    options: { platformRole?: "PIC" | "CUSTOMER"; withBank?: boolean; organizerId?: string } = {}
) {
    const user = await createUser(tag, options.platformRole ?? "PIC");
    const profile = await prisma.pICProfile.create({
        data: {
            userId: user.id,
            picCode: `P21-${(picSeq += 1)}-${SUFFIX}`,
            displayName: `PIC ${tag} ${SUFFIX}`,
            status: "ACTIVE",
            approvedAt: new Date(),
            ...(options.withBank === false
                ? {}
                : {
                      bankName: "Bank Fixture",
                      bankAccountName: "PIC Fixture",
                      bankAccountNumber: "1234567890",
                  }),
        },
        select: { id: true },
    });

    createdProfiles.push(profile.id);
    return { user, profile };
}

async function makeOrderItem(picProfileId: string, organizerId = orgA.id) {
    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `P21-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
            organizerId,
            eventId: event.id,
            userId: buyer.id,
            buyerName: "Fixture Buyer",
            status: "PAID",
            paymentStatus: "PAID",
            subtotal: new Prisma.Decimal("200000.00"),
            total: new Prisma.Decimal("200000.00"),
            organizerNetAmount: new Prisma.Decimal("200000.00"),
            paidAt: new Date(),
        },
        select: { id: true },
    });

    const item = await prisma.eventOrderItem.create({
        data: {
            orderId: order.id,
            nameSnapshot: "Fixture Ticket",
            priceSnapshot: new Prisma.Decimal("100000.00"),
            quantity: 1,
            subtotal: new Prisma.Decimal("100000.00"),
        },
        select: { id: true },
    });

    return { order, item };
}

async function postEarned(
    picProfileId: string,
    organizerId: string,
    item: { id: string },
    amount: string,
    orderId: string
) {
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId,
            organizerId,
            eventId: event.id,
            orderId,
            orderItemId: item.id,
            type: "EARNED",
            direction: "CREDIT",
            amount: new Prisma.Decimal(amount),
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(amount),
            quantity: 1,
            status: "EARNED",
            idempotencyKey: `fee:earned:${item.id}`,
        },
        select: { id: true },
    });
}

async function postReversal(
    picProfileId: string,
    organizerId: string,
    item: { id: string },
    amount: string,
    orderId: string
) {
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId,
            organizerId,
            eventId: event.id,
            orderId,
            orderItemId: item.id,
            type: "REVERSAL",
            direction: "DEBIT",
            amount: new Prisma.Decimal(amount),
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(amount),
            quantity: 1,
            status: "VOID",
            reversalRef: `rev-${item.id}`,
            idempotencyKey: `fee:reversal:${item.id}`,
        },
        select: { id: true },
    });
}

beforeAll(async () => {
    owner = await createUser(`p21-owner-${SUFFIX}`);
    manager = await createUser(`p21-manager-${SUFFIX}`);
    stranger = await createUser(`p21-stranger-${SUFFIX}`);
    buyer = await createUser(`p21-buyer-${SUFFIX}`);

    orgA = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `P21 Org A ${SUFFIX}`,
            slug: `p21-org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    orgB = await prisma.organizer.create({
        data: {
            ownerUserId: stranger.id,
            name: `P21 Org B ${SUFFIX}`,
            slug: `p21-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: orgA.id, userId: owner.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgA.id, userId: manager.id, role: "MANAGER", status: "ACTIVE" },
            { organizerId: orgB.id, userId: stranger.id, role: "OWNER", status: "ACTIVE" },
        ],
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `P21 Sport ${SUFFIX}`, slug: `p21-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    event = await prisma.event.create({
        data: {
            organizerId: orgA.id,
            sportId,
            title: `P21 Event ${SUFFIX}`,
            slug: `p21-event-${SUFFIX}`,
            eventCode: `P21-${SUFFIX}`.slice(0, 40),
            status: "PUBLISHED",
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });
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
    await prisma.eventOrderItem.deleteMany({ where: { order: { userId: buyer.id } } });
    await prisma.eventOrder.deleteMany({ where: { userId: buyer.id } });
    await prisma.pICProfile.deleteMany({ where: { id: { in: createdProfiles } } });
    await prisma.event.deleteMany({ where: { id: event.id } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizerMember.deleteMany({
        where: { organizerId: { in: [orgA.id, orgB.id] } },
    });
    await prisma.organizer.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
});

describe("PHASE 21 — a PIC requests their own payout", () => {
    test("the settleable amount is derived from EARNED minus reversals, per tenant", async () => {
        const { user, profile } = await makePic(`settle-${SUFFIX}`);
        const a = await makeOrderItem(profile.id);
        const b = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, a.item, "4000.00", a.order.id);
        await postEarned(profile.id, orgA.id, b.item, "6000.00", b.order.id);
        await postReversal(profile.id, orgA.id, b.item, "1000.00", b.order.id);

        signInAs(user.id);
        const organizers = await listMyPicSettleableOrganizers(user.id);

        expect(organizers).toHaveLength(1);
        expect(organizers[0].organizerId).toBe(orgA.id);
        expect(organizers[0].settleableNet).toBe("9000.00");
    });

    test("creating a request derives the amount server-side and lands it as REQUESTED", async () => {
        const { user, profile } = await makePic(`create-${SUFFIX}`);
        const a = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, a.item, "7500.00", a.order.id);

        signInAs(user.id);
        const request = await createMyPicPayoutRequest(user.id, {
            organizerId: orgA.id,
        });

        expect(request.status).toBe("REQUESTED");
        expect(request.netAmount).toBe("7500.00");
        expect(request.organizerName).toContain("P21 Org A");

        const row = await prisma.settlement.findUniqueOrThrow({
            where: { id: request.id },
            select: { status: true, payeeType: true, organizerId: true, picProfileId: true },
        });
        expect(row.status).toBe("REQUESTED");
        expect(row.payeeType).toBe("PIC");
        expect(row.organizerId).toBe(orgA.id);
        expect(row.picProfileId).toBe(profile.id);

        // The claim exists, but the ledger row is NOT yet settled (no money moved).
        const items = await prisma.settlementItem.count({
            where: { settlementId: request.id },
        });
        expect(items).toBe(1);
        const ledger = await prisma.pICFeeLedger.findFirstOrThrow({
            where: { picProfileId: profile.id },
            select: { status: true, settlementId: true },
        });
        expect(ledger.status).toBe("EARNED");
        expect(ledger.settlementId).toBeNull();
    });

    test("a second request finds nothing left to claim (fees already claimed)", async () => {
        const { user, profile } = await makePic(`second-${SUFFIX}`);
        const a = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, a.item, "3000.00", a.order.id);

        signInAs(user.id);
        await createMyPicPayoutRequest(user.id, { organizerId: orgA.id });

        await expect(
            createMyPicPayoutRequest(user.id, { organizerId: orgA.id })
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("two concurrent requests never consume the same fee twice", async () => {
        const { user, profile } = await makePic(`race-${SUFFIX}`);
        const a = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, a.item, "12000.00", a.order.id);

        signInAs(user.id);

        const results = await Promise.allSettled([
            createMyPicPayoutRequest(user.id, { organizerId: orgA.id }),
            createMyPicPayoutRequest(user.id, { organizerId: orgA.id }),
        ]);

        // At least one succeeds; the other either finds nothing left or is refused for a
        // claim collision — never a second claim on the same ledger row.
        expect(results.some((r) => r.status === "fulfilled")).toBe(true);

        const claimed = await prisma.settlementItem.count({
            where: { settlement: { picProfileId: profile.id } },
        });
        expect(claimed).toBe(1);
    });

    test("a REVERSAL cannot create an overpayment (it reduces the settleable amount)", async () => {
        const { user, profile } = await makePic(`reversal-${SUFFIX}`);
        const a = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, a.item, "10000.00", a.order.id);
        await postReversal(profile.id, orgA.id, a.item, "4000.00", a.order.id);

        signInAs(user.id);
        const request = await createMyPicPayoutRequest(user.id, {
            organizerId: orgA.id,
        });

        expect(request.netAmount).toBe("6000.00");
    });
});

describe("PHASE 21 — PIC identity, isolation and permission", () => {
    test("a forged userId is PIC_ACCESS_DENIED", async () => {
        const a = await makePic(`forged-a-${SUFFIX}`);
        const b = await makePic(`forged-b-${SUFFIX}`);
        const item = await makeOrderItem(a.profile.id);
        await postEarned(a.profile.id, orgA.id, item.item, "5000.00", item.order.id);

        signInAs(b.user.id);
        await expect(
            createMyPicPayoutRequest(a.user.id, { organizerId: orgA.id })
        ).rejects.toMatchObject({ code: "PIC_ACCESS_DENIED" });
        await expect(listMyPicPayoutRequests(a.user.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });

    test("one PIC never sees another PIC's requests", async () => {
        const a = await makePic(`iso-a-${SUFFIX}`);
        const item = await makeOrderItem(a.profile.id);
        await postEarned(a.profile.id, orgA.id, item.item, "2200.00", item.order.id);
        signInAs(a.user.id);
        await createMyPicPayoutRequest(a.user.id, { organizerId: orgA.id });

        const b = await makePic(`iso-b-${SUFFIX}`);
        signInAs(b.user.id);
        expect(await listMyPicPayoutRequests(b.user.id)).toEqual([]);
    });

    test("a CUSTOMER role with an ACTIVE profile is FORBIDDEN on the new permission", async () => {
        const c = await makePic(`cust-${SUFFIX}`, { platformRole: "CUSTOMER" });
        const item = await makeOrderItem(c.profile.id);
        await postEarned(c.profile.id, orgA.id, item.item, "1500.00", item.order.id);

        signInAs(c.user.id);
        await expect(
            createMyPicPayoutRequest(c.user.id, { organizerId: orgA.id })
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    test("a PIC without complete bank details cannot request", async () => {
        const { user, profile } = await makePic(`nobank-${SUFFIX}`, { withBank: false });
        const item = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, item.item, "1800.00", item.order.id);

        signInAs(user.id);
        await expect(
            createMyPicPayoutRequest(user.id, { organizerId: orgA.id })
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("requesting against a tenant the PIC did not earn in finds nothing", async () => {
        const { user } = await makePic(`foreign-${SUFFIX}`);
        signInAs(user.id);

        await expect(
            createMyPicPayoutRequest(user.id, { organizerId: orgB.id })
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });
});

describe("PHASE 21 — operator review and separation of duties", () => {
    test("the author (PIC) can never approve, reject or pay their own request", async () => {
        const { user, profile } = await makePic(`sod-${SUFFIX}`);
        const item = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, item.item, "4400.00", item.order.id);

        signInAs(user.id);
        const request = await createMyPicPayoutRequest(user.id, {
            organizerId: orgA.id,
        });

        const scope = await resolveAuthzScope(user.id);
        expect(scope).not.toBeNull();

        await expect(
            approveSettlement(request.id, scope!)
        ).rejects.toBeDefined();
        await expect(
            rejectSettlement(request.id, { reason: "nope nope" }, scope!)
        ).rejects.toBeDefined();
        await expect(
            paySettlement(request.id, { providerReference: "TRX-1" }, scope!)
        ).rejects.toBeDefined();
    });

    test("an operator approves, and PAID still requires proof and a reference", async () => {
        const { user, profile } = await makePic(`paid-${SUFFIX}`);
        const item = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, item.item, "3300.00", item.order.id);

        signInAs(user.id);
        const request = await createMyPicPayoutRequest(user.id, {
            organizerId: orgA.id,
        });

        // Operator (MANAGER holds settlement.approve) approves.
        signInAs(manager.id);
        const managerScope = await resolveAuthzScope(manager.id);
        const approved = await approveSettlement(request.id, managerScope!);
        expect(approved.status).toBe("APPROVED");

        // No proof yet ⇒ PAID is refused.
        await expect(
            paySettlement(request.id, { providerReference: "TRX-9001" }, managerScope!)
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("an operator rejects with a reason; the PIC sees it and the claim is released", async () => {
        const { user, profile } = await makePic(`reject-${SUFFIX}`);
        const item = await makeOrderItem(profile.id);
        await postEarned(profile.id, orgA.id, item.item, "2600.00", item.order.id);

        signInAs(user.id);
        const request = await createMyPicPayoutRequest(user.id, {
            organizerId: orgA.id,
        });

        signInAs(manager.id);
        const managerScope = await resolveAuthzScope(manager.id);
        const rejected = await rejectSettlement(
            request.id,
            { reason: "Rekening belum diverifikasi" },
            managerScope!
        );
        expect(rejected.status).toBe("REJECTED");
        expect(rejected.rejectionReason).toBe("Rekening belum diverifikasi");

        // The claim lines are released — the fee can be requested again.
        expect(
            await prisma.settlementItem.count({ where: { settlementId: request.id } })
        ).toBe(0);

        // …and the PIC reads the reason, and still owns their ledger rows.
        signInAs(user.id);
        const own = await listMyPicPayoutRequests(user.id);
        expect(own).toHaveLength(1);
        expect(own[0].status).toBe("REJECTED");
        expect(own[0].rejectionReason).toBe("Rekening belum diverifikasi");

        const organizers = await listMyPicSettleableOrganizers(user.id);
        expect(organizers[0]?.settleableNet).toBe("2600.00");
    });
});
