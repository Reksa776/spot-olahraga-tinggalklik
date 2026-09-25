/**
 * ==========================================
 * PHASE 30 — PIC MONEY INTEGRITY: POST-PAID CLAW-BACK NET-OFF (D-18 / BUG-1)
 * ==========================================
 *
 * Runs the settlement services against the real database through the real authz guards.
 * This suite pins the BUG-1 behaviour: a refund that lands AFTER a payout's earned row
 * was settled must still be clawed back — not by rewriting the paid row, but by NETTING
 * the post-paid reversal off the NEXT settlement (D-18).
 *
 * Asserted here:
 *   carry       a post-paid reversal is selected by prepare as a deduction, and paid
 *               consumes it (linked + SettlementItem DEBIT);
 *   pooling     the appended PAYOUT rows are reduced by the carried total so they sum
 *               EXACTLY to netAmount — earliest EARNED first, never below zero — and no
 *               negative or double payout appears;
 *   refusal     a window whose carried deficit outweighs its earnings is NOTHING_SETTLEABLE
 *               (the deficit carries onward instead of overpaying);
 *   once-only   a consumed reversal is never deducted a second time;
 *   tenancy     a reversal on organizer B never offsets organizer A's settlement — even
 *               for the SAME PIC;
 *   scoping     a reversal for an item whose EARNED is NOT yet settled (and is outside
 *               this window) is not treated as carried.
 *
 * Ledger rows are fixtures posted directly (append-only), exactly like the existing
 * settlement suite; every money assertion is read back from the database.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { Prisma } from "@prisma/client";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { requireOrganizerAccess } from "@/lib/authz";
import { PERMISSIONS, type Permission } from "@/lib/authz/permissions";
import { createEvent } from "@/lib/events/service";
import { prisma } from "@/lib/prisma";
import {
    approveSettlement,
    paySettlement,
    prepareSettlement,
    recordSettlementProof,
    submitSettlement,
} from "@/lib/ticketing/settlement/service";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(240_000);

const SUFFIX = `carry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

type Org = { organizerId: string; ownerId: string; managerId: string; eventId: string };

let uploadDir = "";
let sportId = "";
let orderSeq = 0;
let picSeq = 0;
let orgSeq = 0;
let revSeq = 0;

const createdUsers: string[] = [];
const createdProfiles: { id: string }[] = [];
const createdOrgs: Org[] = [];

function windowOffset(day: number): { start: string; end: string } {
    const start = new Date(Date.now() - 12 * 60 * 60 * 1000 - day * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 10 * 86_400_000);
    return { start: start.toISOString(), end: end.toISOString() };
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

async function actor(organizerId: string, userId: string, permission: Permission) {
    signInAs(userId);
    return requireOrganizerAccess(organizerId, permission);
}

/**
 * An organizer with OWNER (prepares) + MANAGER (approves/proofs/pays) members and one
 * event, mirroring the partition of duties the operator is required to have.
 */
async function makeOrg(tag: string): Promise<Org> {
    orgSeq += 1;
    const owner = await createUser(`own-${tag}-${orgSeq}`);
    const manager = await createUser(`mgr-${tag}-${orgSeq}`);
    createdUsers.push(owner.id, manager.id);

    const organizer = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `${tag} ${SUFFIX}`,
            slug: `${tag.toLowerCase()}-${SUFFIX}-${orgSeq}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: organizer.id, userId: owner.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: organizer.id, userId: manager.id, role: "MANAGER", status: "ACTIVE" },
        ],
    });

    const scope = await actor(organizer.id, owner.id, PERMISSIONS.EVENT_READ);

    const event = await createEvent(
        scope,
        organizer.id,
        {
            title: `${tag} Event ${SUFFIX}`,
            sportId,
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            visibility: "UNLISTED",
        } as never
    );

    const org: Org = {
        organizerId: organizer.id,
        ownerId: owner.id,
        managerId: manager.id,
        eventId: event.id,
    };
    createdOrgs.push(org);
    return org;
}

async function makePic(): Promise<{ id: string }> {
    picSeq += 1;
    const user = await createUser(`piciso-${SUFFIX}-${picSeq}`);
    createdUsers.push(user.id);

    const profile = await prisma.pICProfile.create({
        data: {
            userId: user.id,
            picCode: `CARRY-ISO-${SUFFIX}-${picSeq}`,
            displayName: `PIC Carry ${SUFFIX}`,
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

async function makeOrder(org: Org): Promise<{ order: { id: string }; item: { id: string } }> {
    orderSeq += 1;

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `CARRY-${SUFFIX}-${orderSeq}`,
            organizerId: org.organizerId,
            eventId: org.eventId,
            userId: (createdUsers[0]),
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

async function postLedger(
    kind: { type: "EARNED" | "REVERSAL"; direction: "CREDIT" | "DEBIT" },
    item: { id: string },
    amount: string,
    opts: {
        org: Org;
        pic: { id: string };
        status?: "EARNED" | "VOID";
        createdAt?: Date;
    }
) {
    revSeq += 1;
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId: opts.pic.id,
            organizerId: opts.org.organizerId,
            eventId: opts.org.eventId,
            orderId: (
                await prisma.eventOrderItem.findUniqueOrThrow({
                    where: { id: item.id },
                    select: { orderId: true },
                })
            ).orderId,
            orderItemId: item.id,
            ticketTypeId: null,
            attributionId: null,
            type: kind.type,
            direction: kind.direction,
            amount: new Prisma.Decimal(amount),
            currency: "IDR",
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(amount),
            quantity: 1,
            status: opts.status ?? (kind.type === "REVERSAL" ? "VOID" : "EARNED"),
            refundId: null,
            adjustmentReason: kind.type === "REVERSAL" ? "REFUND" : null,
            idempotencyKey: `carry:${SUFFIX}:${revSeq}`,
            createdAt: opts.createdAt ?? undefined,
        },
    });
}

const postEarned = (item: { id: string }, amount: string, org: Org, pic: { id: string }) =>
    postLedger({ type: "EARNED", direction: "CREDIT" }, item, amount, { org, pic });

const postReversal = (
    item: { id: string },
    amount: string,
    org: Org,
    pic: { id: string },
    createdAt?: Date
) =>
    postLedger({ type: "REVERSAL", direction: "DEBIT" }, item, amount, {
        org,
        pic,
        status: "VOID",
        createdAt,
    });

async function prepare(orgId: string, picId: string, win: { start: string; end: string }, actorUserId: string) {
    const a = await actor(orgId, actorUserId, PERMISSIONS.SETTLEMENT_PREPARE);
    signInAs(actorUserId);
    return prepareSettlement(
        {
            organizerId: orgId,
            picProfileId: picId,
            periodStart: win.start,
            periodEnd: win.end,
        },
        a
    );
}

async function settleThroughPaid(settlementId: string, org: Org, ref: string) {
    await submitSettlement(
        settlementId,
        await actor(org.organizerId, org.ownerId, PERMISSIONS.SETTLEMENT_PREPARE)
    );
    await approveSettlement(
        settlementId,
        await actor(org.organizerId, org.managerId, PERMISSIONS.SETTLEMENT_APPROVE)
    );
    await recordSettlementProof(
        settlementId,
        pdfFile(`transfer-${ref}`),
        await actor(org.organizerId, org.managerId, PERMISSIONS.SETTLEMENT_PROOF_UPLOAD)
    );
    await paySettlement(
        settlementId,
        { providerReference: ref, note: "BCA 15.30" },
        await actor(org.organizerId, org.managerId, PERMISSIONS.SETTLEMENT_APPROVE)
    );
}

function pdfFile(name: string): File {
    const body = Buffer.concat([
        Buffer.from("%PDF-1.7\n"),
        Buffer.from(`%% ${name} ${SUFFIX}`),
    ]);
    return new File([body], `${name}.pdf`, { type: "application/pdf" });
}

beforeAll(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "settlement-carry-proof-"));
    process.env.UPLOAD_DIR = uploadDir;

    const sport = await prisma.sport.create({
        data: { name: `Carry Sport ${SUFFIX}`, slug: `carry-sport-${SUFFIX}`, isActive: true },
        select: { id: true },
    });
    sportId = sport.id;
});

afterAll(async () => {
    const profileIds = createdProfiles.map((p) => p.id);
    const orgIds = createdOrgs.map((o) => o.organizerId);

    await prisma.settlementItem.deleteMany({
        where: { settlement: { picProfileId: { in: profileIds } } },
    });
    await prisma.pICFeeLedger.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.settlement.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.eventOrderItem.deleteMany({ where: { order: { event: { organizerId: { in: orgIds } } } } });
    await prisma.eventOrder.deleteMany({ where: { organizerId: { in: orgIds } } });
    await prisma.pICProfile.deleteMany({ where: { id: { in: profileIds } } });
    await prisma.organizerMember.deleteMany({ where: { organizerId: { in: orgIds } } });
    await prisma.event.deleteMany({ where: { organizerId: { in: orgIds } } });
    await prisma.organizer.deleteMany({ where: { id: { in: orgIds } } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.user.deleteMany({
        where: { id: { in: createdUsers } },
    });
    await fs.rm(uploadDir, { recursive: true, force: true });
    delete process.env.UPLOAD_DIR;
});

describe("post-paid claw-back nets the NEXT settlement (D-18 / BUG-1)", () => {
    test("a reversal landed after payout is deducted from the next window and payouts are pooled down to netAmount exactly", async () => {
        const org = await makeOrg("netoff");
        const solo = await makePic();
        const { item: a } = await makeOrder(org);

        // First window: A is earned and PAID — money has left the ledger.
        await postEarned(a, "6000.00", org, solo);
        const s1 = (await prepare(org.organizerId, solo.id, windowOffset(1), org.ownerId)).id;
        await settleThroughPaid(s1, org, "CARRY-S1");

        expect(
            (await prisma.pICFeeLedger.findFirstOrThrow({
                where: { orderItemId: a.id, type: "EARNED" },
            })).settlementId
        ).toBe(s1);

        // The refund lands AFTER the payout → the post-paid reversal must offset the NEXT
        // window, not the paid one.
        const reversal = await postReversal(a, "6000.00", org, solo);

        const { item: b } = await makeOrder(org);
        const { item: c } = await makeOrder(org);
        await postEarned(b, "10000.00", org, solo);
        await postEarned(c, "4000.00", org, solo);

        const s2 = await prepare(org.organizerId, solo.id, windowOffset(2), org.ownerId);
        expect(s2.id).toBeTruthy();
        expect(s2.grossAmount).toBe("14000.00");
        expect(s2.deductionAmount).toBe("6000.00");
        expect(s2.netAmount).toBe("8000.00");

        // The carried reversal is one of the prepared DEBIT lines.
        const items = s2.items ?? [];
        const debits = items.filter((i) => i.direction === "DEBIT");
        expect(debits).toHaveLength(1);
        expect(debits[0].amount).toBe("6000.00");

        await settleThroughPaid(s2.id, org, "CARRY-S2");

        // Consumed: the reversal is linked to S2.
        const reversalNow = await prisma.pICFeeLedger.findUniqueOrThrow({
            where: { id: reversal.id },
        });
        expect(reversalNow.settlementId).toBe(s2.id);

        // Payout pool reduced: B (earliest, 10000) absorbs 6000 -> 4000; C (4000) is next
        // but carriedToOffset is spent, so the two rows sum to netAmount (10000).
        const payouts = await prisma.pICFeeLedger.findMany({
            where: { picProfileId: solo.id, settlementId: s2.id, type: "PAYOUT" },
            orderBy: { amount: "asc" },
        });
        const payoutSum = payouts.reduce(
            (sum, row) => sum.plus(row.amount),
            new Prisma.Decimal(0)
        );
        expect(payoutSum.toFixed(2)).toBe(s2.netAmount);
        expect(payouts.length).toBe(2);
        expect(payouts.map((p) => p.amount.toFixed(2)).sort()).toEqual([
            "4000.00",
            "4000.00",
        ]);
        expect(payouts.every((p) => p.direction === "DEBIT")).toBe(true);

        // Ledger-level reconciliation: Σ CREDIT − Σ DEBIT == 0 (everything earned is
        // either recovered or paid out) — the carried net-off does not strand money.
        const credit = await prisma.pICFeeLedger.aggregate({
            where: { picProfileId: solo.id, direction: "CREDIT" },
            _sum: { amount: true },
        });
        const debit = await prisma.pICFeeLedger.aggregate({
            where: { picProfileId: solo.id, direction: "DEBIT" },
            _sum: { amount: true },
        });
        expect((credit._sum.amount ?? new Prisma.Decimal(0)).toFixed(2)).toBe("20000.00");
        expect((debit._sum.amount ?? new Prisma.Decimal(0)).toFixed(2)).toBe("20000.00");
    });

    test("a carried deficit larger than a window's earnings refuses settleable (the deficit carries, it is not paid)", async () => {
        const org = await makeOrg("deficit");
        const solo = await makePic();
        const { item: a } = await makeOrder(org);

        await postEarned(a, "6000.00", org, solo);
        const s1 = (await prepare(org.organizerId, solo.id, windowOffset(3), org.ownerId)).id;
        await settleThroughPaid(s1, org, "CARRY-DEF-S1");

        await postReversal(a, "6000.00", org, solo);

        const { item: b } = await makeOrder(org);
        await postEarned(b, "4000.00", org, solo);

        // Only 4000 of new earnings vs 6000 carried: preparing would PAY a negative net.
        const refused = await prepare(org.organizerId, solo.id, windowOffset(4), org.ownerId)
            .then(() => null)
            .catch((error: unknown) => error);
        expect(refused).toMatchObject({ code: "CONFLICT" });

        // The deficit is not lost: adding another 4000 of earnings makes the window settleable.
        const { item: c } = await makeOrder(org);
        await postEarned(c, "4000.00", org, solo);

        const s2 = await prepare(org.organizerId, solo.id, windowOffset(5), org.ownerId);
        expect(s2.netAmount).toBe("2000.00"); // 8000 − 6000
        await settleThroughPaid(s2.id, org, "CARRY-DEF-S2");

        const payouts = await prisma.pICFeeLedger.findMany({
            where: { settlementId: s2.id, type: "PAYOUT" },
            orderBy: { createdAt: "asc" },
        });
        const sum = payouts.reduce(
            (total, p) => total.plus(p.amount),
            new Prisma.Decimal(0)
        );
        expect(sum.toFixed(2)).toBe("2000.00");
        expect(payouts.length).toBe(1);
        expect(payouts[0].amount.toFixed(2)).toBe("2000.00");
    });

    test("a consumed reversal is never deducted a second time", async () => {
        const org = await makeOrg("once");
        const solo = await makePic();
        const { item: a } = await makeOrder(org);
        const { item: b } = await makeOrder(org);
        const { item: c } = await makeOrder(org);

        await postEarned(a, "6000.00", org, solo);
        const s1 = (await prepare(org.organizerId, solo.id, windowOffset(10), org.ownerId)).id;
        await settleThroughPaid(s1, org, "CARRY-ONCE-S1");

        const reversal = await postReversal(a, "6000.00", org, solo);

        await postEarned(b, "10000.00", org, solo);
        const s2 = await prepare(org.organizerId, solo.id, windowOffset(11), org.ownerId);
        expect(s2.netAmount).toBe("4000.00");
        await settleThroughPaid(s2.id, org, "CARRY-ONCE-S2");

        expect(
            (await prisma.pICFeeLedger.findUniqueOrThrow({ where: { id: reversal.id } })).settlementId
        ).toBe(s2.id);

        // A THIRD window with a fresh earning has nothing carried to offset.
        await postEarned(c, "5000.00", org, solo);
        const s3 = await prepare(org.organizerId, solo.id, windowOffset(12), org.ownerId);
        expect(s3.deductionAmount).toBe("0.00");
        expect(s3.netAmount).toBe("5000.00");
        await settleThroughPaid(s3.id, org, "CARRY-ONCE-S3");

        const payoutsS3 = await prisma.pICFeeLedger.findMany({
            where: { settlementId: s3.id, type: "PAYOUT" },
        });
        expect(
            payoutsS3.reduce((sum, p) => sum.plus(p.amount), new Prisma.Decimal(0)).toFixed(2)
        ).toBe("5000.00");
    });

    test("a reversal on organizer B never offsets organizer A's settlement for the same PIC (tenant isolation)", async () => {
        const orgA = await makeOrg("isoA");
        const orgB = await makeOrg("isoB");
        const solo = await makePic();

        // B: earned and paid, then refunded (post-paid reversal under B only).
        const { item: x } = await makeOrder(orgB);
        await postEarned(x, "2500.00", orgB, solo);
        const sB1 = (await prepare(orgB.organizerId, solo.id, windowOffset(20), orgB.ownerId)).id;
        await settleThroughPaid(sB1, orgB, "CARRY-ISO-B1");
        const reversal = await postReversal(x, "1000.00", orgB, solo);

        // A: new earning. A's settlement must be completely independent of B's reversal.
        const { item: y } = await makeOrder(orgA);
        await postEarned(y, "3000.00", orgA, solo);
        const sA = await prepare(orgA.organizerId, solo.id, windowOffset(21), orgA.ownerId);
        expect(sA.deductionAmount).toBe("0.00");
        expect(sA.netAmount).toBe("3000.00");

        // B's next window DOES net its own reversal.
        const { item: z } = await makeOrder(orgB);
        await postEarned(z, "2000.00", orgB, solo);
        const sB2 = await prepare(orgB.organizerId, solo.id, windowOffset(22), orgB.ownerId);
        expect(sB2.deductionAmount).toBe("1000.00");
        expect(sB2.netAmount).toBe("1000.00");

        expect(
            (await prisma.pICFeeLedger.findUniqueOrThrow({ where: { id: reversal.id } })).settlementId
        ).toBeNull();
    });

    test("a reversal for an item whose EARNED is not yet settled is NOT carried into a window that does not contain it", async () => {
        const org = await makeOrg("scoping");
        const solo = await makePic();

        // An OLD earning that never got settled, plus its reversal — both outside the
        // settlement window's createdAt range.
        const { order: uOrder, item: u } = await makeOrder(org);
        const old = new Date(Date.now() - 30 * 86_400_000);
        await prisma.pICFeeLedger.create({
            data: {
                picProfileId: solo.id,
                organizerId: org.organizerId,
                eventId: org.eventId,
                orderId: uOrder.id,
                orderItemId: u.id,
                type: "EARNED",
                direction: "CREDIT",
                amount: new Prisma.Decimal("9000.00"),
                currency: "IDR",
                feeType: "PERCENTAGE",
                basisType: "NET_AFTER_GATEWAY",
                basisAmount: new Prisma.Decimal("9000.00"),
                quantity: 1,
                status: "EARNED",
                idempotencyKey: `carry-old-earned:${SUFFIX}`,
                createdAt: old,
            },
        });
        const oldReversal = await postLedger(
            { type: "REVERSAL", direction: "DEBIT" },
            u,
            "9000.00",
            { org, pic: solo, status: "VOID", createdAt: new Date(Date.now() - 29 * 86_400_000) }
        );

        // A fresh earning in window range.
        const { item: v } = await makeOrder(org);
        await postEarned(v, "5000.00", org, solo);

        const s = await prepare(org.organizerId, solo.id, windowOffset(30), org.ownerId);
        expect(s.netAmount).toBe("5000.00");
        expect(s.deductionAmount).toBe("0.00");

        // The old reversal is untouched, still consumable when the operator finally
        // settles the window that contains u.
        expect(
            (await prisma.pICFeeLedger.findUniqueOrThrow({ where: { id: oldReversal.id } })).settlementId
        ).toBeNull();
    });
});