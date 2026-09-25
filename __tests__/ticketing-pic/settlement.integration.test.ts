/**
 * ==========================================
 * PIC PAYOUT / SETTLEMENT V1 — INTEGRATION
 * ==========================================
 *
 * Runs the settlement services against the real database through the real authz guards
 * (only `@/auth` is mocked, exactly like `pic-checkout.integration.test.ts`). The ledger
 * fixtures are posted directly as append-only rows (the EARNED/REVERSAL writers are out of
 * scope here and need a full checkout; their shapes are pinned by the pic vertical slice),
 * and every assertion reads back committed rows.
 *
 * It pins the accounting matrix and the money controls:
 *
 *   accounting  prepare's gross/deduction/net, partial claw-back (CREDIT + DEBIT items),
 *               full claw-back exclusion, duplicate-window replay, batch sums.
 *   lifecycle   prepare → submit → approve → proof → paid; the PAID flips (EARNED→SETTLED,
 *               linked REVERSAL, appends one PAYOUT DEBIT per included EARNED summing to
 *               net), and the idempotent re-runs (ALREADY).
 *   guards      SoD (preparer may not approve or pay), tenant 404s, proof-required,
 *               paid-time new-reversal refusal, proof storage hardening.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { Prisma } from "@prisma/client";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { requireOrganizerAccess } from "@/lib/authz";
import { resolveAuthzScope } from "@/lib/authz";
import { PERMISSIONS, type Permission } from "@/lib/authz/permissions";
import { createEvent } from "@/lib/events/service";
import { prisma } from "@/lib/prisma";
import {
    deleteStoredProof,
    readStoredProof,
    storeSettlementProof,
} from "@/lib/ticketing/settlement/proof";
import {
    getSettlement,
    listSettlements,
    paySettlement,
    prepareSettlement,
    recordSettlementProof,
    submitSettlement,
    approveSettlement,
    failSettlement,
    cancelSettlement,
} from "@/lib/ticketing/settlement/service";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(240_000);

const SUFFIX = `settle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

/**
 * A settlement window is a `createdAt`-range over EARNED rows. The fixtures post rows
 * during the run ("now"), so every window must CONTAIN the present moment while remaining
 * pairwise-distinct — the unique (payeeType, organizerId, picProfileId, periodStart,
 * periodEnd) record would otherwise clash. Each window begins 12 hours ago (minus one
 * extra hour per index) and spans 10 days ahead, so it always covers "now".
 */
function windowOffset(day: number): { start: string; end: string } {
    const start = new Date(Date.now() - 12 * 60 * 60 * 1000 - day * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 10 * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
}

let uploadDir = "";

let orgA: { id: string };
let owner: { id: string }; // OWNER member of orgA — prepares
let manager: { id: string }; // MANAGER member of orgA — approves / pays
let strangerOrg: { id: string };
let stranger: { id: string }; // OWNER of another tenant — must be 404'd
let plainPicUser: { id: string };
let picUser: { id: string };
let picNoBankUser: { id: string };
let picEmptyUser: { id: string };

let pic: { id: string };
let picNoBank: { id: string };
let picEmpty: { id: string };

let event: { id: string };
let orderSeq = 0;
let picSeq = 0;

const createdUsers: string[] = [];
const createdProfiles: { id: string }[] = [];

type LedgerRow = { id: string; } & Record<string, unknown>;

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

async function createUser(tag: string) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });
}

/**
 * A settle-window belongs to exactly one PIC in production — operators close one period
 * before opening the next. To mirror that (and keep the unique (payeeType, organizerId,
 * picProfileId, periodStart, periodEnd) record from clashing across tests that all run
 * "now"), every test that PREPARES a settlement creates its own isolated PIC.
 */
async function makePic(): Promise<{ id: string }> {
    picSeq += 1;
    const user = await createUser(`piciso-${SUFFIX}-${picSeq}`);
    createdUsers.push(user.id);

    const profile = await prisma.pICProfile.create({
        data: {
            userId: user.id,
            picCode: `STL-ISO-${SUFFIX}-${picSeq}`,
            displayName: `PIC ISO ${SUFFIX}`,
            status: "ACTIVE",
            approvedAt: new Date(),
            bankName: "Bank Fixture",
            bankAccountName: "PIC Fixture",
            bankAccountNumber: "1234567890",
        },
        select: { id: true },
    });

    createdProfiles.push(profile);
    return profile;
}

async function actor(organizerId: string, userId: string, permission: Permission) {
    signInAs(userId);
    return requireOrganizerAccess(organizerId, permission);
}

async function proofActor() {
    return actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_PROOF_UPLOAD);
}

/** A minimal but valid EventOrder + one line. */
async function makeOrder(): Promise<{ order: { id: string }; item: { id: string } }> {
    orderSeq += 1;

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `STL-${SUFFIX}-${orderSeq}`,
            organizerId: orgA.id,
            eventId: event.id,
            userId: plainPicUser.id,
            buyerName: "Fixture Buyer",
            status: "PAID",
            paymentStatus: "PAID",
            subtotal: new Prisma.Decimal("200000.00"),
            platformFee: new Prisma.Decimal("0"),
            picFeeTotal: new Prisma.Decimal("0"),
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
    item: { id: string },
    amount: string,
    picProfile: { id: string } = pic
): Promise<LedgerRow> {
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId: picProfile.id,
            organizerId: orgA.id,
            eventId: event.id,
            orderId: (
                await prisma.eventOrderItem.findUniqueOrThrow({
                    where: { id: item.id },
                    select: { orderId: true },
                })
            ).orderId,
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
    });
}

async function postReversal(
    item: { id: string },
    amount: string,
    picProfile: { id: string } = pic
): Promise<LedgerRow> {
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId: picProfile.id,
            organizerId: orgA.id,
            eventId: event.id,
            orderId: (
                await prisma.eventOrderItem.findUniqueOrThrow({
                    where: { id: item.id },
                    select: { orderId: true },
                })
            ).orderId,
            orderItemId: item.id,
            type: "REVERSAL",
            direction: "DEBIT",
            amount: new Prisma.Decimal(amount),
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(amount),
            quantity: 1,
            status: "EARNED",
            idempotencyKey: `fee:reversal:${item.id}`,
        },
    });
}

async function prepare(
    orgId: string,
    picProfileId: string,
    win: { start: string; end: string },
    actorUserId: string
) {
    const a = await actor(orgId, actorUserId, PERMISSIONS.SETTLEMENT_PREPARE);
    signInAs(actorUserId);
    return prepareSettlement(
        {
            organizerId: orgId,
            picProfileId,
            periodStart: win.start,
            periodEnd: win.end,
        },
        a
    );
}

async function settleStatus(settlementId: string) {
    return prisma.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { status: true, paidAt: true, providerReference: true },
    });
}

beforeAll(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "settlement-proof-"));
    process.env.UPLOAD_DIR = uploadDir;

    owner = await createUser(`owner-${SUFFIX}`);
    manager = await createUser(`manager-${SUFFIX}`);
    stranger = await createUser(`stranger-${SUFFIX}`);
    plainPicUser = await createUser(`plain-${SUFFIX}`);
    picUser = await createUser(`pic-${SUFFIX}`);
    picNoBankUser = await createUser(`picnobank-${SUFFIX}`);
    picEmptyUser = await createUser(`picempty-${SUFFIX}`);

    orgA = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `Settle Org A ${SUFFIX}`,
            slug: `settle-org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    strangerOrg = await prisma.organizer.create({
        data: {
            ownerUserId: stranger.id,
            name: `Settle Org B ${SUFFIX}`,
            slug: `settle-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: orgA.id, userId: owner.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgA.id, userId: manager.id, role: "MANAGER", status: "ACTIVE" },
            { organizerId: strangerOrg.id, userId: stranger.id, role: "OWNER", status: "ACTIVE" },
        ],
    });

    pic = await prisma.pICProfile.create({
        data: {
            userId: picUser.id,
            picCode: `STL-${SUFFIX}`,
            displayName: `PIC ${SUFFIX}`,
            status: "ACTIVE",
            approvedAt: new Date(),
            bankName: "Bank Fixture",
            bankAccountName: "PIC Fixture",
            bankAccountNumber: "1234567890",
        },
        select: { id: true },
    });

    picNoBank = await prisma.pICProfile.create({
        data: {
            userId: picNoBankUser.id,
            picCode: `STL-NO-BANK-${SUFFIX}`,
            displayName: `PIC NoBank ${SUFFIX}`,
            status: "ACTIVE",
            approvedAt: new Date(),
        },
        select: { id: true },
    });

    createdProfiles.push(pic, picNoBank);
    createdUsers.push(picUser.id, picNoBankUser.id);

    picEmpty = await prisma.pICProfile.create({
        data: {
            userId: picEmptyUser.id,
            picCode: `STL-EMPTY-${SUFFIX}`,
            displayName: `PIC Empty ${SUFFIX}`,
            status: "ACTIVE",
            approvedAt: new Date(),
            bankName: "Bank Fixture",
            bankAccountName: "PIC Fixture",
            bankAccountNumber: "1234567890",
        },
        select: { id: true },
    });

    createdProfiles.push(picEmpty);
    createdUsers.push(picEmptyUser.id);

    const sport = await prisma.sport.create({
        data: { name: `Settle Sport ${SUFFIX}`, slug: `settle-sport-${SUFFIX}`, isActive: true },
        select: { id: true },
    });

    const eventScope = await actor(orgA.id, owner.id, PERMISSIONS.EVENT_READ);

    event = await createEvent(
        eventScope,
        orgA.id,
        {
            title: `Settle Event ${SUFFIX}`,
            sportId: sport.id,
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            visibility: "UNLISTED",
        } as never
    );
});

afterAll(async () => {
    const profileIds = createdProfiles.map((p) => p.id);

    await prisma.settlementItem.deleteMany({
        where: { settlement: { picProfileId: { in: profileIds } } },
    });
    await prisma.pICFeeLedger.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.settlement.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.eventOrderItem.deleteMany({
        where: { order: { eventId: event.id } },
    });
    await prisma.eventOrder.deleteMany({ where: { eventId: event.id } });
    await prisma.pICProfile.deleteMany({ where: { id: { in: profileIds } } });
    await prisma.organizerMember.deleteMany({
        where: { organizerId: { in: [orgA.id, strangerOrg.id] } },
    });
    await prisma.event.deleteMany({ where: { organizerId: orgA.id } });
    await prisma.organizer.deleteMany({ where: { id: { in: [orgA.id, strangerOrg.id] } } });
    await prisma.user.deleteMany({
        where: {
            id: {
                in: [
                    ...createdUsers,
                    owner.id,
                    manager.id,
                    stranger.id,
                    plainPicUser.id,
                    picUser.id,
                    picNoBankUser.id,
                    picEmptyUser.id,
                ],
            },
        },
    });
    await fs.rm(uploadDir, { recursive: true, force: true });
    delete process.env.UPLOAD_DIR;
});

describe("settlement prepare — accounting", () => {
    test("refuses a PIC with no bank snapshot", async () => {
        const win = windowOffset(1);

        await expect(
            prepare(orgA.id, picNoBank.id, win, owner.id)
        ).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });
    });

    test("derives gross/deduction/net and masks the bank; a repeated window replays", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "150000.00", solo);

        const win = windowOffset(2);

        const first = await prepare(orgA.id, solo.id, win, owner.id);

        expect(first.status).toBe("DRAFT");
        expect(first.grossAmount).toBe("150000.00");
        expect(first.deductionAmount).toBe("0.00");
        expect(first.netAmount).toBe("150000.00");
        expect(first.method).toBe("MANUAL_TRANSFER");
        expect(first.picProfileId).toBe(solo.id);
        expect(first.organizerId).toBe(orgA.id);
        expect(first.itemCount).toBe(1);
        expect(first.items?.[0].amount).toBe("150000.00");
        expect(first.items?.[0].direction).toBe("CREDIT");
        // BOTH payee fields are populated on a PIC settlement (schema doc says "exactly
        // one"; this service deliberately sets both so the tenant index can scope reads).
        expect(first.itemCount).toBeGreaterThan(0);
        // Bank is masked, never exposed in full.
        expect(first.bankAccountNumber).toBe("••••7890");

        const second = await prepare(orgA.id, solo.id, win, owner.id);
        expect(second.id).toBe(first.id);
        expect(second.status).toBe("DRAFT");
    });

    test("partial claw-back includes CREDIT + DEBIT items and nets the offset", async () => {
        const solo = await makePic();
        const { item: a } = await makeOrder();
        const { item: b } = await makeOrder();
        await postEarned(a, "150000.00", solo);
        await postReversal(a, "50000.00", solo);
        await postEarned(b, "100000.00", solo);

        const settlement = await prepare(orgA.id, solo.id, windowOffset(3), owner.id);

        expect(settlement.grossAmount).toBe("250000.00");
        expect(settlement.deductionAmount).toBe("50000.00");
        expect(settlement.netAmount).toBe("200000.00");
        expect(settlement.itemCount).toBe(3);

        const items = settlement.items ?? [];
        const credits = items.filter((i) => i.direction === "CREDIT");
        const debits = items.filter((i) => i.direction === "DEBIT");

        expect(credits).toHaveLength(2);
        expect(debits).toHaveLength(1);
        expect(debits[0].amount).toBe("50000.00");
    });

    test("full claw-back excludes the item entirely (nothing settleable)", async () => {
        const solo = await makePic();
        const { item: a } = await makeOrder();
        const { item: b } = await makeOrder();
        await postEarned(a, "150000.00", solo);
        await postReversal(a, "150000.00", solo);
        await postEarned(b, "100000.00", solo);

        // The net is still positive (b is not offset), so prepare succeeds with ONLY b.
        const settlement = await prepare(orgA.id, solo.id, windowOffset(4), owner.id);

        expect(settlement.netAmount).toBe("100000.00");
        expect(settlement.itemCount).toBe(1);
        expect(settlement.items?.[0].amount).toBe("100000.00");
        expect(settlement.items?.[0].direction).toBe("CREDIT");
    });

    test("a window with nothing settleable is refused", async () => {
        await expect(
            prepare(orgA.id, picEmpty.id, windowOffset(5), owner.id)
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("a closed window (cancelled) refuses a fresh prepare", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "75000.00", solo);

        const win = windowOffset(6);
        const settlement = await prepare(orgA.id, solo.id, win, owner.id);
        const { id } = settlement;

        const cancelled = await cancelSettlement(id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE));
        expect(cancelled.id).toBe(id);

        await expect(prepare(orgA.id, solo.id, win, owner.id)).rejects.toMatchObject({
            code: "CONFLICT",
        });
    });
});

describe("settlement lifecycle — money moves exactly once", () => {
    test("submit → approve → proof → paid flips the ledger and appends one PAYOUT per EARNED", async () => {
        const solo = await makePic();
        const { item: a } = await makeOrder();
        const { item: b } = await makeOrder();
        const earnedA = await postEarned(a, "150000.00", solo);
        const earnedB = await postEarned(b, "100000.00", solo);

        const win = windowOffset(10);
        const settlement = await prepare(orgA.id, solo.id, win, owner.id);
        const { id } = settlement;

        const sub = await submitSettlement(
            id,
            await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE)
        );
        expect(sub.id).toBe(id);

        const approver = await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE);
        const approved = await approveSettlement(id, approver);
        expect(approved.id).toBe(id);

        const proof = await recordSettlementProof(id, pdfFile("transfer"), await proofActor());
        expect(proof.status).toBe("APPROVED");
        expect(proof.proofAvailable).toBe(true);
        expect(proof.proofFileName).toBeTruthy();

        const paid = await paySettlement(
            id,
            { providerReference: "TRF-FIXTURE-001", note: "BCA 15.30" },
            await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE)
        );
        expect(paid.status).toBe("PAID");
        expect(paid.providerReference).toBe("TRF-FIXTURE-001");

        const after = await settleStatus(id);
        expect(after.status).toBe("PAID");
        expect(after.paidAt).not.toBeNull();

        const earnedAnow = await prisma.pICFeeLedger.findUniqueOrThrow({ where: { id: earnedA.id } });
        const earnedBnow = await prisma.pICFeeLedger.findUniqueOrThrow({ where: { id: earnedB.id } });

        expect(earnedAnow.status).toBe("SETTLED");
        expect(earnedAnow.settlementId).toBe(id);
        expect(earnedBnow.status).toBe("SETTLED");
        expect(earnedBnow.settlementId).toBe(id);

        const payouts = await prisma.pICFeeLedger.findMany({
            where: { picProfileId: solo.id, settlementId: id, type: "PAYOUT" },
            orderBy: { amount: "asc" },
        });

        expect(payouts).toHaveLength(2);
        const sum = payouts.reduce(
            (total, payout) => total.plus(payout.amount),
            new Prisma.Decimal(0)
        );
        expect(sum.toFixed(2)).toBe("250000.00");
        expect(payouts.every((p) => p.direction === "DEBIT")).toBe(true);
        expect(payouts.every((p) => p.status === "SETTLED")).toBe(true);
        expect(payouts.map((p) => p.idempotencyKey).sort()).toEqual(
            [`fee:payout:${id}:${earnedA.id}`, `fee:payout:${id}:${earnedB.id}`].sort()
        );
    });

    test("re-running submit/approve/paid is idempotent (ALREADY)", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "50000.00", solo);

        const settlement = await prepare(orgA.id, solo.id, windowOffset(11), owner.id);
        const { id } = settlement;

        const approver = await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE);

        await submitSettlement(id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE));
        await approveSettlement(id, approver);
        await recordSettlementProof(id, pdfFile("transfer2"), await proofActor());
        await paySettlement(id, { providerReference: "TRF-FIXTURE-002" }, approver);

        const again = await paySettlement(id, { providerReference: "TRF-DUP" }, approver);
        expect(again.id).toBe(id);

        const after = await settleStatus(id);
        expect(after.providerReference).toBe("TRF-FIXTURE-002");

        const payouts = await prisma.pICFeeLedger.findMany({
            where: { picProfileId: solo.id, settlementId: id, type: "PAYOUT" },
        });

        expect(payouts).toHaveLength(1);
    });

    test("paid refuses without proof", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "40000.00", solo);

        const settlement = await prepare(orgA.id, solo.id, windowOffset(12), owner.id);
        const { id } = settlement;

        const approver = await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE);

        await submitSettlement(id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE));
        await approveSettlement(id, approver);

        await expect(
            paySettlement(id, { providerReference: "TRF-NO-PROOF" }, approver)
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("paid refuses when a fresh reversal lands after prepare", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "80000.00", solo);

        const settlement = await prepare(orgA.id, solo.id, windowOffset(13), owner.id);
        const { id } = settlement;

        const approver = await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE);

        await submitSettlement(id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE));
        await approveSettlement(id, approver);
        await recordSettlementProof(id, pdfFile("transfer3"), await proofActor());

        // A refund reverses the item AFTER prepare — the settlement no longer covers it.
        await postReversal(item, "80000.00", solo);

        await expect(
            paySettlement(id, { providerReference: "TRF-STALE" }, approver)
        ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    test("fail releases the claim lines and requires a reason; cancel does the same pre-approval", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "60000.00", solo);

        // Fail path (APPROVED).
        const winA = windowOffset(14);
        const sA = await prepare(orgA.id, solo.id, winA, owner.id);
        const approver = await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE);
        await submitSettlement(sA.id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE));
        await approveSettlement(sA.id, approver);

        const failed = await failSettlement(
            sA.id,
            { reason: "Rekening PIC salah" },
            await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE)
        );
        expect(failed.id).toBe(sA.id);

        const failRow = await prisma.settlement.findUniqueOrThrow({
            where: { id: sA.id },
        });
        expect(failRow.status).toBe("FAILED");
        expect(failRow.failureReason).toBe("Rekening PIC salah");
        expect(
            await prisma.settlementItem.count({ where: { settlementId: sA.id } })
        ).toBe(0);

        // Confirm the ledger row is still EARNED + unlinked (consumable again).
        const ledger = await prisma.pICFeeLedger.findFirst({
            where: { orderItemId: item.id },
        });
        expect(ledger?.status).toBe("EARNED");
        expect(ledger?.settlementId).toBeNull();
    });
});

describe("settlement guards — SoD, tenancy, proof hardening", () => {
    test("separation of duties: the preparer cannot approve or pay", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "30000.00", solo);

        const settlement = await prepare(orgA.id, solo.id, windowOffset(20), owner.id);
        const { id } = settlement;

        await submitSettlement(id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE));

        // The OWNER prepared this — approving it themselves is forbidden.
        await expect(
            approveSettlement(id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_APPROVE))
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    test("tenancy: another tenant's OWNER is refused everywhere", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "45000.00", solo);

        // A stranger cannot even prepare in orgA.
        await expect(
            prepare(orgA.id, solo.id, windowOffset(21), stranger.id)
        ).rejects.toMatchObject({ code: "ORGANIZER_ACCESS_DENIED" });

        // And cannot list it by forging the organizerId.
        const strangerScope = (await resolveAuthzScope(stranger.id))!;
        await expect(
            listSettlements(strangerScope, { organizerId: orgA.id })
        ).rejects.toMatchObject({ code: "ORGANIZER_ACCESS_DENIED" });
    });

    test("proof hardening: bad magic / oversize are refused, traversal is a miss", async () => {
        const badMagic = new File([Buffer.from("not-an-image-or-pdf")], "proof.txt", {
            type: "text/plain",
        });
        await expect(storeSettlementProof(badMagic)).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });

        const fakeSize = new File([Buffer.alloc(MAX_BYTES_PLUS_ONE)], "big.png", {
            type: "image/png",
        });
        await expect(storeSettlementProof(fakeSize)).rejects.toMatchObject({
            code: "VALIDATION_ERROR",
        });

        // A traversal name never resolves to a real read.
        await expect(readStoredProof("../../etc/passwd")).resolves.toBeNull();
        await expect(readStoredProof("sub/nested.png")).resolves.toBeNull();

        // deleteStoredProof is idempotent and refuses separators silently.
        await expect(deleteStoredProof("../x.png")).resolves.toBeUndefined();
    });

    test("proof replacement deletes the superseded file only after commit", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "55000.00", solo);

        const settlement = await prepare(orgA.id, solo.id, windowOffset(22), owner.id);
        const { id } = settlement;

        const approver = await actor(orgA.id, manager.id, PERMISSIONS.SETTLEMENT_APPROVE);
        await submitSettlement(id, await actor(orgA.id, owner.id, PERMISSIONS.SETTLEMENT_PREPARE));
        await approveSettlement(id, approver);

        const first = await recordSettlementProof(id, pdfFile("transfer4"), await proofActor());
        const firstFile = first.proofFileName!;

        // Re-upload replaces it; the old file must be gone, the new one present.
        const second = await recordSettlementProof(id, pdfFile("transfer5"), await proofActor());
        expect(second.proofFileName).not.toBe(firstFile);

        await expect(
            fs.access(path.join(uploadDir, "settlement-proof", firstFile))
        ).rejects.toBeTruthy();
        await expect(
            fs.access(path.join(uploadDir, "settlement-proof", second.proofFileName!))
        ).resolves.toBeUndefined();
    });

    test("detail read refuses a mismatched proof filename", async () => {
        const solo = await makePic();
        const { item } = await makeOrder();
        await postEarned(item, "35000.00", solo);

        const settlement = await prepare(orgA.id, solo.id, windowOffset(23), owner.id);
        const { id } = settlement;

        const ownerScope = (await resolveAuthzScope(owner.id))!;

        const detail = await getSettlement(id, ownerScope);
        expect(detail.status).toBe("DRAFT");

        signInAs(manager.id);
        const managerScope = (await resolveAuthzScope(manager.id))!;
        const detailManager = await getSettlement(id, managerScope);
        expect(detailManager.id).toBe(id);
    });
});

const MAX_BYTES_PLUS_ONE = 5 * 1024 * 1024 + 1;

function pdfFile(name: string): File {
    // A minimal but valid magic-bytes PDF body.
    const body = Buffer.concat([
        Buffer.from("%PDF-1.7\n"),
        Buffer.from(`%% ${name} ${SUFFIX}`),
    ]);
    return new File([body], `${name}.pdf`, { type: "application/pdf" });
}