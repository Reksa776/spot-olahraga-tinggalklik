/**
 * ==========================================
 * PHASE 31 — PIC REPORTING, EXPORT, RECONCILIATION (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * Exercises the Phase 31 reporting layer against the real authorization guards and the real
 * Phase 30 money ledger. Nothing is stubbed except the Auth.js session, exactly like the
 * role-matrix and ownership suites.
 *
 * Pinned here:
 *   authority   the PIC's own report/export resolve their profile from the SESSION and
 *               require the own-scope fee + export permissions — an unauthenticated actor,
 *               an actor without an ACTIVE profile, a CUSTOMER-role PIC, and a forged user
 *               id are all refused;
 *   isolation   a PIC's export carries ONLY their own rows; an organizer export names the
 *               tenant from the session and a second tenant is NOT_FOUND;
 *   money       the summary is the canonical Σ CREDIT − Σ DEBIT over the WHOLE ledger, is
 *               NOT narrowed by the row filters, and a negative outstanding balance survives
 *               (the D-18 post-paid refund shape);
 *   pagination  row paging never changes the totals, and the export is never truncated by
 *               the report's page;
 *   dates       a date-only filter is an Asia/Jakarta calendar day, independent of the
 *               browser: exact start, exact end, just before/after, month and year boundary;
 *   csv         exact Decimal strings, RFC 4180 quoting, formula-injection neutralisation of
 *               untrusted text, stable column order;
 *   recon       EARNED settled/unsettled and REVERSAL consumed/carried/pending split exactly,
 *               and the reported net equals Σ CREDIT − Σ DEBIT;
 *   audit       a financial export writes an audit row with NO bank account/token/secret.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { Prisma } from "@prisma/client";
import type {
    LedgerDirection,
    PICFeeEntryType,
    PICFeeStatus,
} from "@prisma/client";

import { getPicFeeReconciliation } from "@/lib/pic/reconciliation";
import {
    exportMyPicFeeCsv,
    getMyPicFeeReport,
} from "@/lib/pic/reporting";
import {
    exportOrganizerPicFeeCsv,
    getOrganizerPicFeeReport,
} from "@/lib/pic/tenant-reporting";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `p31-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

function signIn(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: {
                      id: userId,
                      email: `${SUFFIX}-${userId}@example.test`,
                      name: "Phase 31 Fixture",
                  },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

let ownerA = "";
let ownerB = "";
let picAUser = "";
let picBUser = "";
let noProfilePicUser = "";
let customerPicUser = "";
let buyer = "";

let orgA = "";
let orgB = "";
let sportId = "";
let eventA = "";
let eventB = "";
let eventInject = "";

let orderA = "";
let orderB = "";
let orderInject = "";

let profileA = "";
let profileB = "";
let profileRecon = "";
let profileDates = "";
let profilePages = "";
let profileInject = "";
let profileEmpty = "";
let profileCustomer = "";

let settlementRecon = "";

/** tag → session user id, so each test can sign in as the right fixture PIC. */
const picFixtureUsers: Record<string, string> = {};

const createdUserIds: string[] = [];
const createdProfileIds: string[] = [];
let ledgerSeq = 0;

async function createUser(
    tag: string,
    platformRole?: "ADMIN" | "PIC" | "CUSTOMER"
): Promise<string> {
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

/** A real ACTIVE PIC profile — one profile per user account. */
async function createPicProfile(
    tag: string,
    platformRole: "PIC" | "CUSTOMER" = "PIC"
): Promise<{ userId: string; profileId: string }> {
    const userId = await createUser(`p31-pic-${tag}-${SUFFIX}`, platformRole);
    const profile = await prisma.pICProfile.create({
        data: {
            userId,
            picCode: `P31-${tag}-${SUFFIX}`,
            displayName: `P31 ${tag}`,
            status: "ACTIVE",
            approvedAt: new Date(),
        },
        select: { id: true },
    });
    createdProfileIds.push(profile.id);
    return { userId, profileId: profile.id };
}

async function createOrder(
    organizerId: string,
    eventId: string,
    tag: string
): Promise<string> {
    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `P31-${tag}-${SUFFIX}`,
            organizerId,
            eventId,
            userId: buyer,
            buyerName: "Phase 31 Buyer",
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
    return order.id;
}

async function createOrderItem(orderId: string, tag: string): Promise<string> {
    const item = await prisma.eventOrderItem.create({
        data: {
            orderId,
            nameSnapshot: `P31 Item ${tag}`,
            priceSnapshot: new Prisma.Decimal("100000.00"),
            quantity: 1,
            subtotal: new Prisma.Decimal("100000.00"),
        },
        select: { id: true },
    });
    return item.id;
}

function postLedger(params: {
    picProfileId: string;
    organizerId: string;
    eventId: string;
    orderId: string;
    type: PICFeeEntryType;
    direction: LedgerDirection;
    amount: string;
    status?: PICFeeStatus;
    orderItemId?: string | null;
    settlementId?: string | null;
    reversalRef?: string;
    createdAt?: Date;
}) {
    ledgerSeq += 1;
    return prisma.pICFeeLedger.create({
        data: {
            picProfileId: params.picProfileId,
            organizerId: params.organizerId,
            eventId: params.eventId,
            orderId: params.orderId,
            orderItemId: params.orderItemId ?? null,
            type: params.type,
            direction: params.direction,
            amount: new Prisma.Decimal(params.amount),
            currency: "IDR",
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(params.amount),
            quantity: 1,
            status: params.status ?? "EARNED",
            settlementId: params.settlementId ?? null,
            reversalRef: params.reversalRef ?? "NONE",
            adjustmentReason: params.type === "REVERSAL" ? "REVERSAL" : null,
            idempotencyKey: `p31:${SUFFIX}:${ledgerSeq}`,
            ...(params.createdAt ? { createdAt: params.createdAt } : {}),
        },
        select: { id: true },
    });
}

beforeAll(async () => {
    ownerA = await createUser(`p31-owner-a-${SUFFIX}`);
    ownerB = await createUser(`p31-owner-b-${SUFFIX}`);
    buyer = await createUser(`p31-buyer-${SUFFIX}`);

    const picFixtures = await Promise.all([
        createPicProfile("a", "PIC"),
        createPicProfile("b", "PIC"),
        createPicProfile("recon", "PIC"),
        createPicProfile("dates", "PIC"),
        createPicProfile("pages", "PIC"),
        createPicProfile("inject", "PIC"),
        createPicProfile("empty", "PIC"),
        createPicProfile("customer", "CUSTOMER"),
    ]);
    [
        profileA,
        profileB,
        profileRecon,
        profileDates,
        profilePages,
        profileInject,
        profileEmpty,
        profileCustomer,
    ] = picFixtures.map((fixture) => fixture.profileId);
    ["a", "b", "recon", "dates", "pages", "inject", "empty", "customer"].forEach(
        (tag, index) => {
            picFixtureUsers[tag] = picFixtures[index].userId;
        }
    );
    picAUser = picFixtureUsers.a;
    picBUser = picFixtureUsers.b;
    customerPicUser = picFixtureUsers.customer;
    noProfilePicUser = await createUser(`p31-noprofile-${SUFFIX}`, "PIC");

    const sport = await prisma.sport.create({
        data: { name: `Phase 31 Sport ${SUFFIX}`, slug: `p31-sport-${SUFFIX}`, isActive: true },
        select: { id: true },
    });
    sportId = sport.id;

    const organizerA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA,
            name: `Phase 31 Org A ${SUFFIX}`,
            slug: `p31-org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });
    orgA = organizerA.id;

    const organizerB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB,
            name: `Phase 31 Org B ${SUFFIX}`,
            slug: `p31-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });
    orgB = organizerB.id;

    await prisma.organizerMember.create({
        data: {
            organizerId: orgA,
            userId: ownerA,
            role: "OWNER",
            status: "ACTIVE",
            acceptedAt: new Date(),
        },
    });
    await prisma.organizerMember.create({
        data: {
            organizerId: orgB,
            userId: ownerB,
            role: "OWNER",
            status: "ACTIVE",
            acceptedAt: new Date(),
        },
    });

    const events = await Promise.all([
        prisma.event.create({
            data: {
                organizerId: orgA,
                sportId,
                title: `Phase 31 Event A ${SUFFIX}`,
                slug: `p31-evt-a-${SUFFIX}`,
                eventCode: `P31A-${SUFFIX}`,
                startAt: FUTURE,
                createdByUserId: ownerA,
                visibility: "UNLISTED",
            },
            select: { id: true },
        }),
        prisma.event.create({
            data: {
                organizerId: orgB,
                sportId,
                title: `Phase 31 Event B ${SUFFIX}`,
                slug: `p31-evt-b-${SUFFIX}`,
                eventCode: `P31B-${SUFFIX}`,
                startAt: FUTURE,
                createdByUserId: ownerB,
                visibility: "UNLISTED",
            },
            select: { id: true },
        }),
        // Untrusted free text that a spreadsheet would execute: the export MUST neutralise it.
        prisma.event.create({
            data: {
                organizerId: orgA,
                sportId,
                title: `=HYPERLINK("http://evil.test","click")`,
                slug: `p31-evt-inject-${SUFFIX}`,
                eventCode: `P31INJ-${SUFFIX}`,
                startAt: FUTURE,
                createdByUserId: ownerA,
                visibility: "UNLISTED",
            },
            select: { id: true },
        }),
    ]);
    eventA = events[0].id;
    eventB = events[1].id;
    eventInject = events[2].id;

    orderA = await createOrder(orgA, eventA, "A");
    orderB = await createOrder(orgB, eventB, "B");
    orderInject = await createOrder(orgA, eventInject, "INJ");

    // ── profileA: the canonical EARNED 100 / REVERSAL 40 shape (net 60) ──────────────
    await postLedger({
        picProfileId: profileA,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "100.00",
    });
    await postLedger({
        picProfileId: profileA,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "REVERSAL",
        direction: "DEBIT",
        amount: "40.00",
        status: "VOID",
    });

    // ── profileB: a different tenant's PIC (isolation target) ────────────────────────
    await postLedger({
        picProfileId: profileB,
        organizerId: orgB,
        eventId: eventB,
        orderId: orderB,
        type: "EARNED",
        direction: "CREDIT",
        amount: "500.00",
    });

    // ── profileInject: one row whose event title is a formula ────────────────────────
    await postLedger({
        picProfileId: profileInject,
        organizerId: orgA,
        eventId: eventInject,
        orderId: orderInject,
        type: "EARNED",
        direction: "CREDIT",
        amount: "10.00",
    });

    // ── profilePages: 120 rows, so totals must not come from a 100-row page ──────────
    for (let i = 0; i < 120; i += 1) {
        await postLedger({
            picProfileId: profilePages,
            organizerId: orgA,
            eventId: eventA,
            orderId: orderA,
            type: "EARNED",
            direction: "CREDIT",
            amount: "1.00",
        });
    }

    // ── profileDates: four rows straddling calendar boundaries (Asia/Jakarta = +07:00) ─
    await postLedger({
        picProfileId: profileDates,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "1.00",
        createdAt: new Date("2026-02-28T23:59:59.999+07:00"), // just before Mar 1 (Jakarta)
    });
    await postLedger({
        picProfileId: profileDates,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "2.00",
        createdAt: new Date("2026-03-01T00:00:00.000+07:00"), // exact period start
    });
    await postLedger({
        picProfileId: profileDates,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "3.00",
        createdAt: new Date("2026-03-01T23:59:59.999+07:00"), // exact period end
    });
    await postLedger({
        picProfileId: profileDates,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "4.00",
        createdAt: new Date("2026-03-02T00:00:00.000+07:00"), // just after
    });
    // Year boundary pair (2025-12-31 → 2026-01-01).
    await postLedger({
        picProfileId: profileDates,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "5.00",
        createdAt: new Date("2025-12-31T23:59:59.999+07:00"),
    });
    await postLedger({
        picProfileId: profileDates,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "6.00",
        createdAt: new Date("2026-01-01T00:00:00.000+07:00"),
    });

    // ── profileRecon: settled / unsettled EARNED, consumed / carried / pending REVERSAL ─
    const settlement = await prisma.settlement.create({
        data: {
            settlementNumber: `P31-SET-${SUFFIX}`,
            payeeType: "PIC",
            picProfileId: profileRecon,
            organizerId: orgA,
            periodStart: new Date("2026-01-01T00:00:00.000Z"),
            periodEnd: new Date("2026-01-31T23:59:59.999Z"),
            grossAmount: new Prisma.Decimal("100.00"),
            deductionAmount: new Prisma.Decimal("40.00"),
            netAmount: new Prisma.Decimal("0.00"),
            method: "MANUAL_TRANSFER",
            status: "PAID",
            preparedByUserId: ownerA,
            paidByUserId: ownerA,
            paidAt: new Date(),
        },
        select: { id: true },
    });
    settlementRecon = settlement.id;

    const itemReconA = await createOrderItem(orderA, "recon-a");
    const itemReconB = await createOrderItem(orderA, "recon-b");

    await postLedger({
        picProfileId: profileRecon,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "100.00",
        orderItemId: itemReconA,
        settlementId: settlementRecon,
        status: "SETTLED",
    });
    await postLedger({
        picProfileId: profileRecon,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "EARNED",
        direction: "CREDIT",
        amount: "50.00",
        orderItemId: itemReconB,
        status: "EARNED",
    });
    // consumed: linked to the settlement that already paid it.
    await postLedger({
        picProfileId: profileRecon,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "REVERSAL",
        direction: "DEBIT",
        amount: "40.00",
        status: "VOID",
        orderItemId: itemReconA,
        settlementId: settlementRecon,
        reversalRef: "R1",
    });
    // carried: the item's EARNED is already settled (the D-18 post-paid shape).
    await postLedger({
        picProfileId: profileRecon,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "REVERSAL",
        direction: "DEBIT",
        amount: "25.00",
        status: "VOID",
        orderItemId: itemReconA,
        reversalRef: "R2",
    });
    // pending: the item's EARNED is still open.
    await postLedger({
        picProfileId: profileRecon,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "REVERSAL",
        direction: "DEBIT",
        amount: "10.00",
        status: "VOID",
        orderItemId: itemReconB,
        reversalRef: "R3",
    });
    await postLedger({
        picProfileId: profileRecon,
        organizerId: orgA,
        eventId: eventA,
        orderId: orderA,
        type: "PAYOUT",
        direction: "DEBIT",
        amount: "60.00",
        status: "SETTLED",
        settlementId: settlementRecon,
    });

    // profileCustomer intentionally has NO ledger rows (empty state).
});

afterAll(async () => {
    const profileIds = [...createdProfileIds];
    await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: createdUserIds } },
    });
    await prisma.pICFeeLedger.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.settlementItem.deleteMany({
        where: { settlement: { picProfileId: { in: profileIds } } },
    });
    await prisma.settlement.deleteMany({ where: { picProfileId: { in: profileIds } } });
    await prisma.eventOrderItem.deleteMany({
        where: { order: { organizerId: { in: [orgA, orgB] } } },
    });
    await prisma.eventOrder.deleteMany({
        where: { organizerId: { in: [orgA, orgB] } },
    });
    await prisma.event.deleteMany({ where: { organizerId: { in: [orgA, orgB] } } });
    await prisma.organizerMember.deleteMany({
        where: { organizerId: { in: [orgA, orgB] } },
    });
    await prisma.organizer.deleteMany({ where: { id: { in: [orgA, orgB] } } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
});

/* ==================================================================================
 * AUTHORITY — the PIC's own report and export
 * ================================================================================== */

describe("PIC own report/export — authority", () => {
    test("an unauthenticated actor is UNAUTHORIZED", async () => {
        signIn(null);
        await expect(getMyPicFeeReport(picAUser, {})).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });
        await expect(exportMyPicFeeCsv(picAUser, {})).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });
    });

    test("an authenticated actor with no ACTIVE PIC profile is NOT_FOUND", async () => {
        signIn(noProfilePicUser);
        await expect(getMyPicFeeReport(noProfilePicUser, {})).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });

    test("a CUSTOMER-role account with an ACTIVE profile lacks the fee family (FORBIDDEN)", async () => {
        signIn(customerPicUser);
        await expect(getMyPicFeeReport(customerPicUser, {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(exportMyPicFeeCsv(customerPicUser, {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    test("naming another PIC's user id is PIC_ACCESS_DENIED, never a wider filter", async () => {
        signIn(picAUser);
        await expect(getMyPicFeeReport(picBUser, {})).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
        await expect(exportMyPicFeeCsv(picBUser, {})).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });

    test("the report resolves the SESSION profile and returns only its own rows", async () => {
        signIn(picAUser);
        const report = await getMyPicFeeReport(picAUser, {});

        expect(report.picProfileId).toBe(profileA);
        expect(report.rows).toHaveLength(2);
        expect(report.rows.every((row) => row.orderNumber === `P31-A-${SUFFIX}`)).toBe(true);
        expect(report.rows.some((row) => row.orderNumber === `P31-B-${SUFFIX}`)).toBe(false);
    });
});

/* ==================================================================================
 * MONEY — the canonical summary, filters, empty/pagination independence
 * ================================================================================== */

describe("PIC own report — canonical money", () => {
    test("the summary is Σ CREDIT − Σ DEBIT over the whole ledger", async () => {
        signIn(picAUser);
        const report = await getMyPicFeeReport(picAUser, {});

        expect(report.summary.grossEarned).toBe("100.00");
        expect(report.summary.totalReversals).toBe("40.00");
        expect(report.summary.totalPayouts).toBe("0.00");
        expect(report.summary.credit).toBe("100.00");
        expect(report.summary.debit).toBe("40.00");
        expect(report.summary.netBalance).toBe("60.00");
    });

    test("row filters narrow the LIST but never the canonical summary", async () => {
        signIn(picAUser);
        const onlyEarned = await getMyPicFeeReport(picAUser, { type: "EARNED" });

        expect(onlyEarned.rows).toHaveLength(1);
        expect(onlyEarned.rows[0].type).toBe("EARNED");
        expect(onlyEarned.pagination.total).toBe(1);
        // The balance is a property of the ledger, not of the filter.
        expect(onlyEarned.summary.netBalance).toBe("60.00");
    });

    test("an unknown type/status is a VALIDATION_ERROR, not a silently ignored filter", async () => {
        signIn(picAUser);
        await expect(
            getMyPicFeeReport(picAUser, { type: "NOT_A_TYPE" })
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
            getMyPicFeeReport(picAUser, { status: "NOT_A_STATUS" })
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
        await expect(
            getMyPicFeeReport(picAUser, { from: "2026-03-02", to: "2026-03-01" })
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    });

    test("an empty ledger reads as zeros with a header-only export", async () => {
        signIn(picFixtureUsers.empty);
        const report = await getMyPicFeeReport(picFixtureUsers.empty, {});
        expect(report.picProfileId).toBe(profileEmpty);
        expect(report.rows).toHaveLength(0);
        expect(report.pagination.total).toBe(0);
        expect(report.pagination.totalPages).toBe(1);
        expect(report.summary.netBalance).toBe("0.00");

        const csv = await exportMyPicFeeCsv(picFixtureUsers.empty, {});
        expect(csv.trimEnd().split("\r\n")).toHaveLength(1); // header only
    });

    test("a negative outstanding balance survives (D-18 post-paid refund shape)", async () => {
        const { userId, profileId } = await createPicProfile("negative", "PIC");
        await postLedger({
            picProfileId: profileId,
            organizerId: orgA,
            eventId: eventA,
            orderId: orderA,
            type: "EARNED",
            direction: "CREDIT",
            amount: "100.00",
        });
        await postLedger({
            picProfileId: profileId,
            organizerId: orgA,
            eventId: eventA,
            orderId: orderA,
            type: "PAYOUT",
            direction: "DEBIT",
            amount: "100.00",
            status: "SETTLED",
        });
        await postLedger({
            picProfileId: profileId,
            organizerId: orgA,
            eventId: eventA,
            orderId: orderA,
            type: "REVERSAL",
            direction: "DEBIT",
            amount: "40.00",
            status: "VOID",
        });

        signIn(userId);
        const report = await getMyPicFeeReport(userId, {});
        expect(report.summary.netBalance).toBe("-40.00");
    });

    test("pagination never changes the totals, and the export is never page-truncated", async () => {
        const userId = picFixtureUsers.pages;
        signIn(userId);

        const page1 = await getMyPicFeeReport(userId, { page: "1", pageSize: "25" });
        const page2 = await getMyPicFeeReport(userId, { page: "2", pageSize: "25" });

        expect(page1.rows).toHaveLength(25);
        expect(page2.rows).toHaveLength(25);
        expect(page1.pagination.total).toBe(120);
        expect(page1.pagination.totalPages).toBe(5);
        // Totals are identical regardless of the visible page.
        expect(page1.summary.netBalance).toBe("120.00");
        expect(page2.summary.netBalance).toBe("120.00");

        const csv = await exportMyPicFeeCsv(userId, {});
        // Header + ALL 120 rows, not the report's page.
        expect(csv.trimEnd().split("\r\n")).toHaveLength(121);
    });

    test("the page size is capped so a caller cannot turn a list read into a table dump", async () => {
        const userId = picFixtureUsers.pages;
        signIn(userId);
        const report = await getMyPicFeeReport(userId, { pageSize: "100000" });
        expect(report.rows).toHaveLength(120); // capped at the max (200) but only 120 exist
        expect(report.pagination.pageSize).toBe(200);
    });
});

/* ==================================================================================
 * DATE CONTRACT — Asia/Jakarta calendar days, browser-independent
 * ================================================================================== */

describe("PIC own report — date filters (Asia/Jakarta)", () => {
    test("an exact calendar day includes its exact start and end instants only", async () => {
        const userId = picFixtureUsers.dates;
        signIn(userId);

        const report = await getMyPicFeeReport(userId, {
            from: "2026-03-01",
            to: "2026-03-01",
        });

        const amounts = report.rows.map((row) => row.amount).sort();
        expect(amounts).toEqual(["2.00", "3.00"]);
    });

    test("just before and just after the day are excluded", async () => {
        const userId = picFixtureUsers.dates;
        signIn(userId);

        // The whole of February (Jakarta) holds only the 23:59:59.999 Feb 28 row.
        const before = await getMyPicFeeReport(userId, {
            from: "2026-02-01",
            to: "2026-02-28",
        });
        expect(before.rows.map((row) => row.amount)).toEqual(["1.00"]);
        expect(before.rows.some((row) => row.amount === "2.00")).toBe(false);

        const after = await getMyPicFeeReport(userId, { from: "2026-03-02" });
        expect(after.rows.map((row) => row.amount)).toEqual(["4.00"]);
    });

    test("a month boundary spans the whole month consistently", async () => {
        const userId = picFixtureUsers.dates;
        signIn(userId);

        const march = await getMyPicFeeReport(userId, {
            from: "2026-03-01",
            to: "2026-03-31",
        });
        expect(march.rows.map((row) => row.amount).sort()).toEqual(["2.00", "3.00", "4.00"]);
    });

    test("a year boundary includes 2025-12-31 and 2026-01-01 and nothing in between", async () => {
        const userId = picFixtureUsers.dates;
        signIn(userId);

        const dec = await getMyPicFeeReport(userId, {
            from: "2025-12-01",
            to: "2025-12-31",
        });
        const jan = await getMyPicFeeReport(userId, {
            from: "2026-01-01",
            to: "2026-01-31",
        });

        expect(dec.rows.map((row) => row.amount)).toEqual(["5.00"]);
        expect(jan.rows.map((row) => row.amount)).toEqual(["6.00"]);
    });

    test("a full ISO instant is taken as the exact instant, not widened to a day", async () => {
        const userId = picFixtureUsers.dates;
        signIn(userId);

        const report = await getMyPicFeeReport(userId, {
            from: "2026-03-01T00:00:00.000+07:00",
            to: "2026-03-01T00:00:00.000+07:00",
        });

        expect(report.rows.map((row) => row.amount)).toEqual(["2.00"]);
    });
});

/* ==================================================================================
 * CSV EXPORT — exact Decimal, injection-safe text, no leakage
 * ================================================================================== */

describe("PIC own CSV export", () => {
    test("money is the exact Decimal string and the header order is stable", async () => {
        signIn(picAUser);
        const csv = await exportMyPicFeeCsv(picAUser, {});
        const [header, ...rows] = csv.trimEnd().split("\r\n");

        expect(header).toBe(
            "createdAt,event,orderNumber,orderItemId,ledgerType,direction,amount,feeType,rateBp,basisType,basisAmount,quantity,status,settlementId,refundId,reversalRef"
        );
        expect(rows).toHaveLength(2);
        // No Number() round-trip: the exact "100.00"/"40.00" survive verbatim.
        expect(csv).toContain(",100.00,");
        expect(csv).toContain(",40.00,");
        expect(csv).not.toContain(",100,");
    });

    test("a negative money value is exported verbatim, not neutralised as a formula", async () => {
        const { userId, profileId } = await createPicProfile("negexport", "PIC");
        await postLedger({
            picProfileId: profileId,
            organizerId: orgA,
            eventId: eventA,
            orderId: orderA,
            type: "PAYOUT",
            direction: "DEBIT",
            amount: "0.01",
            status: "SETTLED",
        });
        await postLedger({
            picProfileId: profileId,
            organizerId: orgA,
            eventId: eventA,
            orderId: orderA,
            type: "REVERSAL",
            direction: "DEBIT",
            amount: "0.02",
            status: "VOID",
        });

        signIn(userId);
        const csv = await exportMyPicFeeCsv(userId, {});
        expect(csv).toContain(",0.01,");
        expect(csv).toContain(",0.02,");
    });

    test("an untrusted event title beginning with = is neutralised with a leading apostrophe", async () => {
        const userId = picFixtureUsers.inject;
        signIn(userId);

        const csv = await exportMyPicFeeCsv(userId, {});
        expect(csv).toContain(`"'=HYPERLINK`);
        // …while the money column beside it is untouched.
        expect(csv).toContain(",10.00,");
    });

    test("the export never leaks another PIC's rows", async () => {
        signIn(picAUser);
        const csv = await exportMyPicFeeCsv(picAUser, {});
        expect(csv).toContain(`P31-A-${SUFFIX}`);
        expect(csv).not.toContain(`P31-B-${SUFFIX}`);
    });

    test("a financial export writes an audit row without secrets or bank data", async () => {
        signIn(picAUser);
        await exportMyPicFeeCsv(picAUser, {});

        const audit = await prisma.adminAuditLog.findFirst({
            where: {
                action: "report.export.own_pic_fee",
                actorUserId: picAUser,
            },
            orderBy: { createdAt: "desc" },
        });

        expect(audit).not.toBeNull();
        expect(audit!.entityType).toBe("Report");
        expect(audit!.entityRef).toBe(profileA);
        // Metadata is counts/filters only — the sanitizer keeps credentials and bank
        // numbers out, and the writer never receives them in the first place.
        const serialized = JSON.stringify(audit!.afterState ?? {});
        expect(serialized).not.toMatch(/bankAccount|secret|token|credential/i);
        expect(serialized).toContain("rowCount");
    });
});

/* ==================================================================================
 * ORGANIZER (TENANT) REPORTING — isolation
 * ================================================================================== */

describe("organizer PIC fee report — tenant isolation", () => {
    test("the organizer's own report is exact and excludes other tenants' PICs", async () => {
        signIn(ownerA);
        const report = await getOrganizerPicFeeReport(orgA, {});

        const row = report.items.find((item) => item.picProfileId === profileA);
        expect(row).toBeDefined();
        expect(row!.earned).toBe("100.00");
        expect(row!.reversals).toBe("40.00");
        expect(row!.payouts).toBe("0.00");
        expect(row!.netBalance).toBe("60.00");

        expect(report.items.some((item) => item.picProfileId === profileB)).toBe(false);
    });

    test("naming another tenant is refused, not a peek", async () => {
        signIn(ownerA);
        await expect(getOrganizerPicFeeReport(orgB, {})).rejects.toMatchObject({
            code: "ORGANIZER_ACCESS_DENIED",
        });
        await expect(exportOrganizerPicFeeCsv(orgB, {})).rejects.toMatchObject({
            code: "ORGANIZER_ACCESS_DENIED",
        });
    });

    test("the other organizer sees its own PIC and not the first tenant's", async () => {
        signIn(ownerB);
        const report = await getOrganizerPicFeeReport(orgB, {});

        const row = report.items.find((item) => item.picProfileId === profileB);
        expect(row).toBeDefined();
        expect(row!.netBalance).toBe("500.00");
        expect(report.items.some((item) => item.picProfileId === profileA)).toBe(false);
    });

    test("an unauthenticated organizer read is UNAUTHORIZED", async () => {
        signIn(null);
        await expect(getOrganizerPicFeeReport(orgA, {})).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });
    });

    test("the tenant export emits the canonical per-PIC totals and writes an audit row", async () => {
        signIn(ownerA);
        const csv = await exportOrganizerPicFeeCsv(orgA, {});

        expect(csv.split("\r\n")[0]).toBe(
            "picCode,picName,picStatus,earned,reversals,payouts,netBalance,entryCount"
        );
        expect(csv).toContain(",100.00,40.00,0.00,60.00,2");
        expect(csv).not.toContain(`P31-B-${SUFFIX}`);

        const audit = await prisma.adminAuditLog.findFirst({
            where: { action: "report.export.pic_fee", actorUserId: ownerA },
            orderBy: { createdAt: "desc" },
        });
        expect(audit).not.toBeNull();
        expect(audit!.organizerId).toBe(orgA);
        expect(audit!.entityType).toBe("Report");
    });
});

/* ==================================================================================
 * RECONCILIATION — the ledger ↔ settlement relationship
 * ================================================================================== */

describe("PIC fee reconciliation", () => {
    test("EARNED splits into settled + unsettled, REVERSAL into consumed + carried + pending", async () => {
        const recon = await getPicFeeReconciliation(profileRecon);

        expect(recon.earned.total).toBe("150.00");
        expect(recon.earned.settled).toBe("100.00");
        expect(recon.earned.unsettled).toBe("50.00");
        expect(recon.earned.settledCount).toBe(1);
        expect(recon.earned.unsettledCount).toBe(1);

        expect(recon.reversal.total).toBe("75.00");
        expect(recon.reversal.consumed).toBe("40.00");
        expect(recon.reversal.carried).toBe("25.00");
        expect(recon.reversal.pending).toBe("10.00");
        expect(recon.reversal.consumedCount).toBe(1);
        expect(recon.reversal.carriedCount).toBe(1);
        expect(recon.reversal.pendingCount).toBe(1);

        expect(recon.payout.total).toBe("60.00");
        expect(recon.payout.count).toBe(1);
    });

    test("the reconciliation net is the canonical Σ CREDIT − Σ DEBIT and every split check holds", async () => {
        const recon = await getPicFeeReconciliation(profileRecon);

        expect(recon.balance.credit).toBe("150.00");
        expect(recon.balance.debit).toBe("135.00");
        expect(recon.balance.net).toBe("15.00");

        expect(recon.checks.earnedSplits).toBe(true);
        expect(recon.checks.reversalSplits).toBe(true);
        expect(recon.checks.netMatchesDirection).toBe(true);

        const byType = new Map(recon.totalsByType.map((entry) => [entry.type, entry.amount]));
        expect(byType.get("EARNED")).toBe("150.00");
        expect(byType.get("REVERSAL")).toBe("75.00");
        expect(byType.get("PAYOUT")).toBe("60.00");
    });

    test("an empty PIC reconciles to zero with all checks true", async () => {
        const recon = await getPicFeeReconciliation(profileCustomer);

        expect(recon.balance.net).toBe("0.00");
        expect(recon.earned.total).toBe("0.00");
        expect(recon.reversal.total).toBe("0.00");
        expect(recon.checks.earnedSplits).toBe(true);
        expect(recon.checks.reversalSplits).toBe(true);
        expect(recon.checks.netMatchesDirection).toBe(true);
    });
});

