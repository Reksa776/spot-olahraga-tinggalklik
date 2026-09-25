/**
 * ==========================================
 * PHASE 30 — PIC MONEY ADMIN TOTALS (GAP-1 / GAP-2)
 * ==========================================
 *
 * Pins the operator-facing money figures to the ONE canonical PIC balance formula:
 *
 *     net = Σ CREDIT − Σ DEBIT        (over the WHOLE append-only ledger)
 *
 * The two defects this suite guards against:
 *
 *   GAP-1 — the platform PIC list used a magnitude sum (`Σ amount`), so an
 *           EARNED 100 / REVERSAL 40 / PAYOUT 100 PIC read 240 instead of −40.
 *   GAP-2 — the platform PIC detail "total" was a `take: 100` row sum that was
 *           blind to `direction`/`type`, so it was wrong past 100 rows.
 *
 * Asserted here:
 *   formula     the shared helper returns credit/debit/net for 0/earned/reversal/
 *               payout/combined ledgers, including a negative outstanding balance;
 *   batch       `getPicLedgerBalances` fills every requested id (zeroed) and agrees
 *               with the single-id helper;
 *   list        `listPicsForAdmin.ledgerTotal` equals the canonical net for every
 *               shape, and is NOT a magnitude sum;
 *   detail      `getPicDetail.balance.{credit,debit,net}` reads the WHOLE ledger
 *               (never `take: 100`) while the ledger TABLE stays capped at 100;
 *   by-type     `totalsByType` is keyed by `type`, so a non-EARNED credit type (a
 *               future/accrual entry) is its own line and can never inflate the
 *               EARNED figure;
 *   reconcile   the list total, the detail net and the helper net are the same
 *               number for the same PIC.
 *
 * The operator surfaces are exercised through the real `requirePlatformPermission`
 * guard with a mocked session, exactly like the role-matrix suite — no authorization
 * is stubbed.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { Prisma } from "@prisma/client";

import { resolveAuthzScope } from "@/lib/authz/scope";
import { getPicLedgerBalance, getPicLedgerBalances } from "@/lib/pic/ledger";
import { getPicDetail, listPicsForAdmin } from "@/lib/pic/service";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(120_000);

const SUFFIX = `admtot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let adminUserId = "";
let organizerId = "";
let eventId = "";
let orderId = "";
let sportId = "";

const createdUserIds: string[] = [];
const createdProfileIds: string[] = [];
let ledgerSeq = 0;

function signIn(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: {
                      id: userId,
                      email: `${SUFFIX}-${userId}@example.test`,
                      name: "Admin Fixture",
                  },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

async function createUser(tag: string, platformRole?: "ADMIN"): Promise<string> {
    const user = await prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
        select: { id: true },
    });
    createdUserIds.push(user.id);
    return user.id;
}

/** A real ACTIVE PIC profile (unique account per profile — one profile per user). */
async function createPic(): Promise<string> {
    const userId = await createUser(`pic-${SUFFIX}-${createdProfileIds.length}`);
    const profile = await prisma.pICProfile.create({
        data: {
            userId,
            picCode: `ADMTOT-${SUFFIX}-${createdProfileIds.length}`,
            displayName: `PIC Admin Total ${createdProfileIds.length}`,
            status: "ACTIVE",
            approvedAt: new Date(),
        },
        select: { id: true },
    });
    createdProfileIds.push(profile.id);
    return profile.id;
}

/**
 * Post one append-only ledger row. `orderItemId` is left NULL so many rows of the same
 * `type`/`reversalRef` are permitted (MySQL treats NULLs as distinct in a unique index),
 * which is what lets the >100-row case use EARNED rows without 150 order items.
 */
function postLedger(
    picProfileId: string,
    type: "EARNED" | "REVERSAL" | "PAYOUT" | "EARLY_ACCRUAL" | "ADJUSTMENT",
    direction: "CREDIT" | "DEBIT",
    amount: string
) {
    ledgerSeq += 1;
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId,
            organizerId,
            eventId,
            orderId,
            orderItemId: null,
            ticketTypeId: null,
            attributionId: null,
            type,
            direction,
            amount: new Prisma.Decimal(amount),
            currency: "IDR",
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(amount),
            quantity: 1,
            status: direction === "CREDIT" ? "EARNED" : "VOID",
            adjustmentReason: type === "REVERSAL" || type === "PAYOUT" ? type : null,
            idempotencyKey: `admtot:${SUFFIX}:${ledgerSeq}`,
        },
    });
}

async function adminScope() {
    signIn(adminUserId);
    const scope = await resolveAuthzScope(adminUserId);
    if (!scope) {
        throw new Error("admin scope did not resolve");
    }
    return scope;
}

beforeAll(async () => {
    adminUserId = await createUser(`admin-${SUFFIX}`, "ADMIN");

    const sport = await prisma.sport.create({
        data: { name: `Admin Total Sport ${SUFFIX}`, slug: `adm-total-sport-${SUFFIX}`, isActive: true },
        select: { id: true },
    });
    sportId = sport.id;

    const owner = await createUser(`owner-${SUFFIX}`);
    const organizer = await prisma.organizer.create({
        data: {
            ownerUserId: owner,
            name: `Admin Total Org ${SUFFIX}`,
            slug: `adm-total-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });
    organizerId = organizer.id;

    const event = await prisma.event.create({
        data: {
            organizerId,
            sportId,
            title: `Admin Total Event ${SUFFIX}`,
            slug: `adm-total-event-${SUFFIX}`,
            eventCode: `ADMTOT-${SUFFIX}`,
            startAt: FUTURE,
            createdByUserId: owner,
            visibility: "UNLISTED",
        },
        select: { id: true },
    });
    eventId = event.id;

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `ADMTOT-${SUFFIX}`,
            organizerId,
            eventId,
            userId: owner,
            buyerName: "Admin Total Buyer",
            status: "PAID",
            paymentStatus: "PAID",
            subtotal: new Prisma.Decimal("100000.00"),
            platformFee: new Prisma.Decimal("0"),
            picFeeTotal: new Prisma.Decimal("0"),
            total: new Prisma.Decimal("100000.00"),
            organizerNetAmount: new Prisma.Decimal("100000.00"),
            paidAt: new Date(),
        },
        select: { id: true },
    });
    orderId = order.id;
});

afterAll(async () => {
    const profileIds = [...createdProfileIds];
    await prisma.settlementItem.deleteMany({
        where: { settlement: { picProfileId: { in: profileIds } } },
    });
    await prisma.pICFeeLedger.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.settlement.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.eventOrder.deleteMany({ where: { organizerId } });
    await prisma.event.deleteMany({ where: { organizerId } });
    await prisma.organizer.deleteMany({ where: { id: organizerId } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

describe("canonical PIC ledger balance (the shared money formula)", () => {
    test("zero rows read as 0/0/0", async () => {
        const pic = await createPic();

        const balance = await getPicLedgerBalance(pic);
        expect(balance.credit.toFixed(2)).toBe("0.00");
        expect(balance.debit.toFixed(2)).toBe("0.00");
        expect(balance.net.toFixed(2)).toBe("0.00");
    });

    test("earned only: net = credit", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "100.00");

        const balance = await getPicLedgerBalance(pic);
        expect(balance.credit.toFixed(2)).toBe("100.00");
        expect(balance.debit.toFixed(2)).toBe("0.00");
        expect(balance.net.toFixed(2)).toBe("100.00");
    });

    test("earned + reversal: net = credit − debit", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "100.00");
        await postLedger(pic, "REVERSAL", "DEBIT", "40.00");

        const balance = await getPicLedgerBalance(pic);
        expect(balance.credit.toFixed(2)).toBe("100.00");
        expect(balance.debit.toFixed(2)).toBe("40.00");
        expect(balance.net.toFixed(2)).toBe("60.00");
    });

    test("earned + payout: net = credit − debit", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "100.00");
        await postLedger(pic, "PAYOUT", "DEBIT", "100.00");

        const balance = await getPicLedgerBalance(pic);
        expect(balance.net.toFixed(2)).toBe("0.00");
    });

    test("earned + reversal + payout: the canonical −40, never the magnitude 240", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "100.00");
        await postLedger(pic, "REVERSAL", "DEBIT", "40.00");
        await postLedger(pic, "PAYOUT", "DEBIT", "100.00");

        const balance = await getPicLedgerBalance(pic);
        expect(balance.credit.toFixed(2)).toBe("100.00");
        expect(balance.debit.toFixed(2)).toBe("140.00");
        expect(balance.net.toFixed(2)).toBe("-40.00");
    });

    test("getPicLedgerBalances zeroes every requested id and agrees with the single-id helper", async () => {
        const empty = await createPic();
        const rich = await createPic();
        await postLedger(rich, "EARNED", "CREDIT", "250.00");
        await postLedger(rich, "PAYOUT", "DEBIT", "100.00");

        const batch = await getPicLedgerBalances([empty, rich]);
        expect(batch.get(empty)?.net.toFixed(2)).toBe("0.00");
        expect(batch.get(rich)?.net.toFixed(2)).toBe("150.00");

        const single = await getPicLedgerBalance(rich);
        expect(batch.get(rich)?.credit.toFixed(2)).toBe(single.credit.toFixed(2));
        expect(batch.get(rich)?.debit.toFixed(2)).toBe(single.debit.toFixed(2));
        expect(batch.get(rich)?.net.toFixed(2)).toBe(single.net.toFixed(2));

        expect((await getPicLedgerBalances([])).size).toBe(0);
    });
});

describe("platform PIC list total (GAP-1)", () => {
    test("ledgerTotal is the canonical net for every shape, including negative", async () => {
        const zero = await createPic();
        const earned = await createPic();
        const reversed = await createPic();
        const paid = await createPic();
        const combined = await createPic();

        await postLedger(earned, "EARNED", "CREDIT", "100.00");
        await postLedger(reversed, "EARNED", "CREDIT", "100.00");
        await postLedger(reversed, "REVERSAL", "DEBIT", "40.00");
        await postLedger(paid, "EARNED", "CREDIT", "100.00");
        await postLedger(paid, "PAYOUT", "DEBIT", "100.00");
        await postLedger(combined, "EARNED", "CREDIT", "100.00");
        await postLedger(combined, "REVERSAL", "DEBIT", "40.00");
        await postLedger(combined, "PAYOUT", "DEBIT", "100.00");

        const list = await listPicsForAdmin(await adminScope());
        const total = (id: string) =>
            list.items.find((item) => item.id === id)?.ledgerTotal;

        expect(total(zero)).toBe("0.00");
        expect(total(earned)).toBe("100.00");
        expect(total(reversed)).toBe("60.00");
        expect(total(paid)).toBe("0.00");
        // The GAP-1 bug would have read "240.00" here (|100| + |40| + |100|).
        expect(total(combined)).toBe("-40.00");
    });

    test("a negative outstanding balance survives the list untouched and is not clamped", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "500.00");
        await postLedger(pic, "REVERSAL", "DEBIT", "500.00");
        await postLedger(pic, "REVERSAL", "DEBIT", "250.00");

        const list = await listPicsForAdmin(await adminScope());
        expect(list.items.find((item) => item.id === pic)?.ledgerTotal).toBe("-250.00");
    });
});

describe("platform PIC detail totals (GAP-2)", () => {
    test("balance reads the WHOLE ledger while the ledger table stays capped at 100", async () => {
        const pic = await createPic();

        // 150 credit rows of 10.00 = 1500.00, plus 20 debit rows of 1.00 = 20.00.
        for (let i = 0; i < 150; i += 1) {
            await postLedger(pic, "EARNED", "CREDIT", "10.00");
        }
        for (let i = 0; i < 20; i += 1) {
            await postLedger(pic, "REVERSAL", "DEBIT", "1.00");
        }

        const detail = await getPicDetail(await adminScope(), pic);

        // Totals are independent of the 100-row page.
        expect(detail.balance.credit).toBe("1500.00");
        expect(detail.balance.debit).toBe("20.00");
        expect(detail.balance.net).toBe("1480.00");

        // Pagination remains for the TABLE only.
        expect(detail.ledger).toHaveLength(100);

        // And the list total agrees with the detail net.
        const list = await listPicsForAdmin(await adminScope());
        expect(list.items.find((item) => item.id === pic)?.ledgerTotal).toBe("1480.00");
    });

    test("totalsByType is keyed by type: a non-EARNED credit is its own line and cannot inflate EARNED", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "100.00");
        // A future/accrual CREDIT type — direction-credit, but NOT "earned".
        await postLedger(pic, "EARLY_ACCRUAL", "CREDIT", "50.00");
        await postLedger(pic, "REVERSAL", "DEBIT", "40.00");

        const detail = await getPicDetail(await adminScope(), pic);

        const byType = new Map(detail.totalsByType.map((entry) => [entry.type, entry.amount]));
        expect(byType.get("EARNED")).toBe("100.00");
        expect(byType.get("EARLY_ACCRUAL")).toBe("50.00");
        expect(byType.get("REVERSAL")).toBe("40.00");

        // The direction total legitimately includes the accrual; the TYPE total does not
        // leak it into EARNED.
        expect(detail.balance.credit).toBe("150.00");
        expect(detail.balance.debit).toBe("40.00");
        expect(detail.balance.net).toBe("110.00");
    });

    test("an unknown-but-typed DEBIT never inflates earned either", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "100.00");
        await postLedger(pic, "ADJUSTMENT", "DEBIT", "30.00");

        const detail = await getPicDetail(await adminScope(), pic);
        const byType = new Map(detail.totalsByType.map((entry) => [entry.type, entry.amount]));

        expect(byType.get("EARNED")).toBe("100.00");
        expect(byType.get("ADJUSTMENT")).toBe("30.00");
        expect(detail.balance.net).toBe("70.00");
    });
});

describe("operator totals reconcile with the canonical formula (Part L/O)", () => {
    test("list total === detail net === helper net for the same PIC", async () => {
        const pic = await createPic();
        await postLedger(pic, "EARNED", "CREDIT", "321.00");
        await postLedger(pic, "REVERSAL", "DEBIT", "21.00");
        await postLedger(pic, "PAYOUT", "DEBIT", "100.00");

        const scope = await adminScope();
        const helper = await getPicLedgerBalance(pic);
        const list = await listPicsForAdmin(scope);
        const detail = await getPicDetail(scope, pic);

        expect(list.items.find((item) => item.id === pic)?.ledgerTotal).toBe("200.00");
        expect(detail.balance.net).toBe("200.00");
        expect(helper.net.toFixed(2)).toBe("200.00");
    });
});
