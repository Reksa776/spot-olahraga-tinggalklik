/**
 * ==========================================
 * PIC SELF-SERVICE — OWNERSHIP ISOLATION (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * TESTS 5–12: the guard (`requireMyPic`) is the whole security story of the own-scope
 * surface. Every function must:
 *
 *   identity    — refuse an unauthenticated actor (UNAUTHORIZED),
 *   profile     — refuse an actor with no ACTIVE profile (NOT_FOUND),
 *   forged id   — refuse ANY read that names another user's records (PIC_ACCESS_DENIED),
 *   ownership   — return ONLY the session user's own rows, never a neighbour PIC's,
 *   permission  — deny the fee/attribution families to an account whose platform role
 *                 lacks them (FORBIDDEN), while profile-scoped reads stay available,
 *   link        — mint a referral link ONLY for an active, non-revoked assignment.
 *
 * Two PICs (A and B), one revoked assignment, one SUSPENDED profile, one CUSTOMER who owns
 * an ACTIVE profile, and one buyer give every shape a real other-side to fail against.
 * Fixtures are direct inserts so the tests exercise the READ boundary, not the checkout.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import type {
    LedgerDirection,
    OrderStatus,
    PaymentStatus,
    PICFeeEntryType,
    PICFeeStatus,
} from "@prisma/client";

import { PIC_REFERRAL_SECRET_ENV } from "@/lib/pic/referral";
import {
    getMyPicOverview,
    getMyPicProfile,
    getMyReferralLink,
    listMyFeeLedger,
    listMyPicAssignments,
    listMyReferralLinks,
} from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `picss-own-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let owner: { id: string };
let picA: { id: string };
let picB: { id: string };
let suspendedUser: { id: string };
let customerPic: { id: string };
let buyer: { id: string };

let org: { id: string };
let sportId: string;
let evtA: { id: string };
let evtB: { id: string };

let profileA: { id: string };
let profileB: { id: string };
let profileCustomer: { id: string };

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

async function createUser(tag: string, platformRole: "PIC" | "CUSTOMER" | null = null) {
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

async function createActiveProfile(userId: string): Promise<{ id: string }> {
    return prisma.pICProfile.create({
        data: {
            userId,
            picCode: `PICSS-${SUFFIX}-${userId}`,
            displayName: `Fixture ${userId.slice(0, 8)}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });
}

async function createAssignment(
    picProfileId: string,
    eventId: string,
    overrides: { active?: boolean } = {}
) {
    const active = overrides.active ?? true;
    return prisma.pICEventAssignment.create({
        data: {
            picProfileId,
            eventId,
            organizerId: org.id,
            feeRateBp: 500,
            assignedByUserId: owner.id,
            isActive: active,
            revokedAt: active ? null : new Date(),
        },
        select: { id: true, eventId: true, isActive: true },
    });
}

async function createOrder(
    picProfileId: string,
    eventId: string,
    overrides: { paymentStatus?: PaymentStatus; total?: string } = {}
) {
    const paymentStatus = overrides.paymentStatus ?? "PAID";
    const total = overrides.total ?? "50000.00";
    const orderNumber = `ORD-${SUFFIX}-${picProfileId.slice(0, 6)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;

    return prisma.eventOrder.create({
        data: {
            orderNumber,
            organizerId: org.id,
            eventId,
            userId: buyer.id,
            buyerName: "Fixture Buyer",
            status: (paymentStatus === "PAID" ? "PAID" : "PENDING_PAYMENT") as OrderStatus,
            paymentStatus,
            subtotal: total,
            total,
            organizerNetAmount: total,
            picProfileId,
        },
        select: { id: true, picProfileId: true },
    });
}

async function createLedger(
    picProfileId: string,
    orderId: string,
    eventId: string,
    overrides: {
        direction?: LedgerDirection;
        type?: PICFeeEntryType;
        amount?: string;
        status?: PICFeeStatus;
    } = {}
) {
    const direction = overrides.direction ?? "CREDIT";
    const amount = overrides.amount ?? "1000.00";

    return prisma.pICFeeLedger.create({
        data: {
            picProfileId,
            organizerId: org.id,
            eventId,
            orderId,
            type: overrides.type ?? "EARNED",
            direction,
            amount,
            feeType: "PERCENTAGE",
            basisType: "GROSS_BEFORE_DISCOUNT",
            basisAmount: "50000.00",
            quantity: 1,
            status: overrides.status ?? "EARNED",
            rateBp: 500,
            idempotencyKey: `picss-own-${SUFFIX}-${direction}-${orderId}-${Math.random()
                .toString(36)
                .slice(2, 8)}`,
        },
        select: { id: true, picProfileId: true },
    });
}

beforeAll(async () => {
    process.env[PIC_REFERRAL_SECRET_ENV] = `picss-own-secret-${SUFFIX}`;

    owner = await createUser("picss-own-owner");
    picA = await createUser("picss-own-a", "PIC");
    picB = await createUser("picss-own-b", "PIC");
    suspendedUser = await createUser("picss-own-suspended", "PIC");
    customerPic = await createUser("picss-own-customer", "CUSTOMER");
    buyer = await createUser("picss-own-buyer");

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `PICSS Own Org ${SUFFIX}`,
            slug: `picss-own-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sportId = (
        await prisma.sport.create({
            data: {
                name: `PICSS Own Sport ${SUFFIX}`,
                slug: `picss-own-sport-${SUFFIX}`,
            },
            select: { id: true },
        })
    ).id;

    evtA = await prisma.event.create({
        data: {
            organizerId: org.id,
            sportId,
            title: `PICSS Own Event A ${SUFFIX}`,
            slug: `picss-own-evt-a-${SUFFIX}`,
            eventCode: `EVT-A-${SUFFIX}`,
            status: "PUBLISHED",
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });

    evtB = await prisma.event.create({
        data: {
            organizerId: org.id,
            sportId,
            title: `PICSS Own Event B ${SUFFIX}`,
            slug: `picss-own-evt-b-${SUFFIX}`,
            eventCode: `EVT-B-${SUFFIX}`,
            status: "PUBLISHED",
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });

    profileA = await createActiveProfile(picA.id);
    profileB = await createActiveProfile(picB.id);
    profileCustomer = await createActiveProfile(customerPic.id);
    await createActiveProfile(suspendedUser.id);
    await prisma.pICProfile.update({
        where: { userId: suspendedUser.id },
        data: { status: "SUSPENDED" },
    });

    // A: evtA active + evtB revoked. B: evtB active. Customer: evtA active.
    await createAssignment(profileA.id, evtA.id);
    await createAssignment(profileA.id, evtB.id, { active: false });
    await createAssignment(profileB.id, evtB.id);
    await createAssignment(profileCustomer.id, evtA.id);

    // Orders: A owns ONE (paid), B owns ONE (paid).
    const orderA = await createOrder(profileA.id, evtA.id, { total: "150000.00" });
    const orderB = await createOrder(profileB.id, evtB.id, { total: "250000.00" });

    // Ledger: A has a CREDIT and a REVERSAL; B has a CREDIT.
    await createLedger(profileA.id, orderA.id, evtA.id, { amount: "4000.00" });
    await createLedger(profileA.id, orderA.id, evtA.id, {
        direction: "DEBIT",
        type: "REVERSAL",
        amount: "500.00",
        status: "VOID",
    });
    await createLedger(profileB.id, orderB.id, evtB.id, { amount: "9000.00" });
});

afterAll(async () => {
    const userIds = [owner, picA, picB, suspendedUser, customerPic, buyer]
        .filter(Boolean)
        .map((user) => user.id);

    await prisma.pICFeeLedger.deleteMany({
        where: { picProfileId: { in: [profileA?.id, profileB?.id] } },
    });
    await prisma.eventOrderItem.deleteMany({
        where: { order: { userId: buyer.id } },
    });
    await prisma.eventOrder.deleteMany({ where: { userId: buyer.id } });
    await prisma.pICEventAssignment.deleteMany({
        where: { picProfileId: { in: [profileA?.id, profileB?.id, profileCustomer?.id] } },
    });
    await prisma.pICProfile.deleteMany({
        where: { userId: { in: userIds.filter(Boolean) } },
    });
    await prisma.event.deleteMany({ where: { id: { in: [evtA?.id, evtB?.id] } } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizer.deleteMany({ where: { id: org?.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

/* ==================================================================================
 * TEST 5 — unauthenticated is UNAUTHORIZED
 * ================================================================================== */

describe("TEST 5 — an unauthenticated actor is refused", () => {
    test("every read fails closed with UNAUTHORIZED", async () => {
        signInAs(null);

        await expect(listMyFeeLedger(picA.id)).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });
        await expect(getMyPicProfile(picA.id)).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });
        await expect(getMyReferralLink(picA.id, evtA.id)).rejects.toMatchObject({
            code: "UNAUTHORIZED",
        });
    });
});

/* ==================================================================================
 * TEST 6 — authenticated but no ACTIVE profile is NOT_FOUND
 * ================================================================================== */

describe("TEST 6 — an actor without an ACTIVE profile gets NOT_FOUND", () => {
    test("the profile-scoped read fails closed", async () => {
        signInAs(owner.id);
        await expect(getMyPicProfile(owner.id)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });

    test("the permission-gated read fails closed too", async () => {
        signInAs(owner.id);
        await expect(getMyPicOverview(owner.id)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });

    test("a SUSPENDED profile is equally NOT_FOUND", async () => {
        signInAs(suspendedUser.id);
        await expect(getMyPicProfile(suspendedUser.id)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        await expect(getMyPicOverview(suspendedUser.id)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });
});

/* ==================================================================================
 * TEST 7 — a forged userId is a denial, not a wider filter
 * ================================================================================== */

describe("TEST 7 — reading another user's records is PIC_ACCESS_DENIED", () => {
    test("A naming B's id is refused on every family", async () => {
        signInAs(picA.id);

        await expect(listMyFeeLedger(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
        await expect(getMyPicOverview(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
        await expect(getMyPicProfile(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
        await expect(listMyPicAssignments(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
        await expect(listMyReferralLinks(picB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });

    test("A naming B's id for a referral link is refused before the event is even consulted", async () => {
        signInAs(picA.id);
        await expect(getMyReferralLink(picB.id, evtB.id)).rejects.toMatchObject({
            code: "PIC_ACCESS_DENIED",
        });
    });
});

/* ==================================================================================
 * TEST 8 — reads return only the session user's own rows
 * ================================================================================== */

describe("TEST 8 — every read is scoped to the session user's own profile", () => {
    test("A sees their own assignments, including the revoked one, and never B's", async () => {
        signInAs(picA.id);
        const assignments = await listMyPicAssignments(picA.id);

        const events = assignments.map((a) => a.eventSlug).sort();
        expect(events).toEqual([
            `picss-own-evt-a-${SUFFIX}`,
            `picss-own-evt-b-${SUFFIX}`,
        ]);

        const revoked = assignments.find((a) => a.eventSlug === `picss-own-evt-b-${SUFFIX}`);
        expect(revoked!.isActive).toBe(false);
        expect(revoked!.revokedAt).not.toBeNull();
    });

    test("A's ledger has A's credit and reversal only — never B's", async () => {
        signInAs(picA.id);
        const entries = await listMyFeeLedger(picA.id);

        expect(entries).toHaveLength(2);
        const credits = entries.filter((e) => e.direction === "CREDIT");
        const debits = entries.filter((e) => e.direction === "DEBIT");
        expect(credits).toHaveLength(1);
        expect(Number(credits[0].amount)).toBe(4000);
        expect(debits).toHaveLength(1);
        expect(Number(debits[0].amount)).toBe(500);
        expect(debits[0].status).toBe("VOID");
    });

    test("B's ledger has only B's entry", async () => {
        signInAs(picB.id);
        const entries = await listMyFeeLedger(picB.id);

        expect(entries).toHaveLength(1);
        expect(Number(entries[0].amount)).toBe(9000);
    });

    test("B's referral links cover B's one active assignment only", async () => {
        signInAs(picB.id);
        const links = await listMyReferralLinks(picB.id);

        expect(links).toHaveLength(1);
        expect(links[0].eventSlug).toBe(`picss-own-evt-b-${SUFFIX}`);
        expect(links[0].sharePath).not.toBeNull();
    });
});

/* ==================================================================================
 * TEST 9 — profile ownership is not a role escape hatch
 * ================================================================================== */

describe("TEST 9 — a CUSTOMER owning a profile may read profile-scoped data, not fee/attribution", () => {
    test("profile-scoped reads succeed for the account's own profile", async () => {
        signInAs(customerPic.id);

        const profile = await getMyPicProfile(customerPic.id);
        expect(profile.status).toBe("ACTIVE");
        expect(profile.id).toBe(profileCustomer.id);

        const assignments = await listMyPicAssignments(customerPic.id);
        expect(assignments.map((a) => a.eventSlug)).toEqual([
            `picss-own-evt-a-${SUFFIX}`,
        ]);
    });

    test("the fee family is FORBIDDEN for a CUSTOMER role", async () => {
        signInAs(customerPic.id);
        await expect(getMyPicOverview(customerPic.id)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        await expect(listMyFeeLedger(customerPic.id)).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });
});

/* ==================================================================================
 * TEST 10 — an ACTIVE profile is required even for the owner
 * ================================================================================== */

describe("TEST 10 — a PIC-role user with a suspended profile is NOT_FOUND", () => {
    test("the profile probe drives the guard, not the platform role", async () => {
        signInAs(suspendedUser.id);

        // The role is PIC (would hold the permissions); the profile is the blocker.
        await expect(getMyPicProfile(suspendedUser.id)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        await expect(listMyFeeLedger(suspendedUser.id)).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
    });
});

/* ==================================================================================
 * TESTS 11 & 12 — referral links mint ONLY for active, non-revoked assignments
 * ================================================================================== */

describe("TESTS 11 & 12 — getMyReferralLink is assignment-gated", () => {
    test("an active assignment yields a signed share path", async () => {
        signInAs(picA.id);

        const sharePath = await getMyReferralLink(picA.id, evtA.id);

        expect(sharePath).not.toBeNull();
        expect(sharePath!.startsWith(`/e/picss-own-evt-a-${SUFFIX}?pic=`)).toBe(
            true
        );
    });

    test("a revoked assignment yields NO link", async () => {
        signInAs(picA.id);
        expect(await getMyReferralLink(picA.id, evtB.id)).toBeNull();
    });

    test("an event without any assignment yields NO link", async () => {
        signInAs(picB.id);
        // B holds evtB only; A's evtA is not B's to link.
        expect(await getMyReferralLink(picB.id, evtA.id)).toBeNull();
    });

    test("the same facts gate the list surface", async () => {
        signInAs(picA.id);
        const links = await listMyReferralLinks(picA.id);

        // Only the ACTIVE assignment (evtA) becomes a link — the revoked evtB does not.
        expect(links.map((l) => l.eventSlug)).toEqual([
            `picss-own-evt-a-${SUFFIX}`,
        ]);
    });
});