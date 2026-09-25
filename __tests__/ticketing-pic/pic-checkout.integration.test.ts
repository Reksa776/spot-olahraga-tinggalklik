/**
 * ==========================================
 * PIC VERTICAL SLICE — CHECKOUT → SETTLEMENT → EARNED (INTEGRATION)
 * ==========================================
 *
 * Runs the real services against the real database through the real authz guards
 * (only `@/auth` is mocked). It proves the whole attribution path end to end:
 *
 *   `?pic=` token → checkout snapshot → attribution row → SETTLED payment →
 *   exactly-one EARNED ledger row replaying the snapshot → idempotent re-delivery →
 *   FAIL-CLOSED shapes stay ordinary no-PIC purchases.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { Prisma } from "@prisma/client";

import { resolveAuthzScope } from "@/lib/authz";
import { requireOrganizerAccess } from "@/lib/authz";
import { createEvent, publishEvent } from "@/lib/events/service";
import {
    mintPicReferralToken,
    PIC_REFERRAL_SECRET_ENV,
} from "@/lib/pic/referral";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { createTicketOrder } from "@/lib/ticketing/checkout";
import { getOwnOrder } from "@/lib/ticketing/orders";
import { settleVerifiedPayment } from "@/lib/ticketing/payment/settlement";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `pic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const FUTURE_END = new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000);
const PRICE = "150000.00";

// Every fixture event is UNLISTED so a stranded fixture never leaks to a public listing.
const FIXTURE_VISIBILITY = "UNLISTED" as const;

let owner: { id: string };
let picUser: { id: string };
let suspendedPicUser: { id: string };
let buyer: { id: string };

let org: { id: string };
let sportId: string;
let event: { id: string };
let type: { id: string };

let picProfile: { id: string; picCode: string };
let suspendedProfile: { id: string; picCode: string };

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

async function organizerScope(organizerId: string, userId: string) {
    signInAs(userId);
    return requireOrganizerAccess(organizerId, "event.read");
}

function checkoutRequest(overrides: Record<string, unknown> = {}) {
    return {
        eventId: event.id,
        items: [{ ticketTypeId: type.id, quantity: 2 }],
        buyerName: "Fixture Buyer",
        buyerEmail: `pic-if-buyer-${SUFFIX}@example.test`,
        buyerPhone: "081234567890",
        ...overrides,
    } as never;
}

function tokenFor(picProfileId: string, eventId: string): string {
    const token = mintPicReferralToken({ picProfileId, eventId });

    if (!token) {
        throw new Error("Fixture error: mintPicReferralToken returned null");
    }

    return token;
}

async function createPicOrder(
    token: string | null,
    buyerUserId: string
): Promise<string> {
    signInAs(buyerUserId);
    const actor = await resolveAuthzScope(buyerUserId);

    if (!actor) {
        throw new Error("Fixture error: no authz scope");
    }

    const outcome = await createTicketOrder({
        request: checkoutRequest({ shareToken: token }),
        actor,
        idempotencyKey: `pic-ck-${token ? token.slice(0, 12) : "none"}-${SUFFIX}-${Math.random()}`,
    });

    return outcome.payload.orderId;
}

beforeAll(async () => {
    // The referral module reads the secret at call time, so setting it here is enough.
    process.env[PIC_REFERRAL_SECRET_ENV] = `pic-slice-secret-${SUFFIX}`;

    owner = await createUser("pic-owner");
    picUser = await createUser("pic-user");
    suspendedPicUser = await createUser("pic-suspended");
    buyer = await createUser("pic-buyer");

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `PIC Org ${SUFFIX}`,
            slug: `pic-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.create({
        data: {
            organizerId: org.id,
            userId: owner.id,
            role: "OWNER",
            status: "ACTIVE",
        },
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `PIC Sport ${SUFFIX}`, slug: `pic-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    const scope = await organizerScope(org.id, owner.id);

    event = await createEvent(
        scope,
        org.id,
        {
            title: `PIC Event ${SUFFIX}`,
            sportId,
            startAt: FUTURE,
            endAt: FUTURE_END,
            visibility: FIXTURE_VISIBILITY,
        } as never
    );

    const typeScope = await organizerScope(org.id, owner.id);

    type = await createTicketType(typeScope, event.id, {
        name: "Reguler",
        price: PRICE,
        quota: 500,
        minPerOrder: 1,
        maxPerOrder: 4,
    } as never);

    // Publishing is what makes the event purchasable — same as the Phase 6 suite.
    await publishEvent(typeScope, event.id);

    picProfile = await prisma.pICProfile.create({
        data: {
            userId: picUser.id,
            picCode: `PIC-${SUFFIX}`,
            displayName: `PIC ${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true, picCode: true },
    });

    suspendedProfile = await prisma.pICProfile.create({
        data: {
            userId: suspendedPicUser.id,
            picCode: `PIC-S-${SUFFIX}`,
            displayName: `Suspended PIC ${SUFFIX}`,
            status: "SUSPENDED",
        },
        select: { id: true, picCode: true },
    });

    await prisma.pICEventAssignment.create({
        data: {
            picProfileId: picProfile.id,
            eventId: event.id,
            organizerId: org.id,
            feeRateBp: 500,
            assignedByUserId: owner.id,
        },
    });

    await prisma.pICEventAssignment.create({
        data: {
            picProfileId: suspendedProfile.id,
            eventId: event.id,
            organizerId: org.id,
            feeRateBp: 500,
            assignedByUserId: owner.id,
        },
    });
});

afterAll(async () => {
    delete process.env[PIC_REFERRAL_SECRET_ENV];
});

describe("checkout resolves a PIC referral into frozen snapshots", () => {
    test("a valid token prices the PIC fee (organizer absorbs, buyer total unchanged)", async () => {
        const orderId = await createPicOrder(
            tokenFor(picProfile.id, event.id),
            buyer.id
        );

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: {
                picProfileId: true,
                picFeeTotal: true,
                total: true,
                subtotal: true,
                organizerNetAmount: true,
            },
        });

        expect(row.picProfileId).toBe(picProfile.id);
        expect(row.subtotal.toString()).toBe("300000");
        expect(row.total.toString()).toBe("300000");
        expect(row.picFeeTotal.toString()).toBe("15000");
        // D-23: the organizer ABSORBS the fee; the buyer's total is untouched.
        expect(row.organizerNetAmount.toString()).toBe("285000");
    });

    test("the item snapshot freezes rate, type, basis and amount at checkout", async () => {
        const orderId = await createPicOrder(
            tokenFor(picProfile.id, event.id),
            buyer.id
        );

        const item = await prisma.eventOrderItem.findFirstOrThrow({
            where: { orderId },
        });

        expect(item.quantity).toBe(2);
        expect(item.picFeeAmount?.toString()).toBe("15000");
        expect(item.picFeeType).toBe("PERCENTAGE");
        expect(item.basisType).toBe("GROSS_BEFORE_DISCOUNT");
        expect(item.rateBp).toBe(500);
        expect(item.fixedAmount?.toString()).toBe("0");
        expect(item.basisAmount?.toString()).toBe("300000");
    });

    test("the one-to-one attribution row records provenance, not money", async () => {
        const token = tokenFor(picProfile.id, event.id);
        const orderId = await createPicOrder(token, buyer.id);

        const attribution = await prisma.pICAttribution.findUniqueOrThrow({
            where: { orderId },
            select: {
                organizerId: true,
                eventId: true,
                picProfileId: true,
                source: true,
                method: true,
                shareToken: true,
                selfReferral: true,
            },
        });

        expect(attribution.organizerId).toBe(org.id);
        expect(attribution.eventId).toBe(event.id);
        expect(attribution.picProfileId).toBe(picProfile.id);
        expect(attribution.source).toBe("PIC_LINK");
        expect(attribution.method).toBe("LINK");
        expect(attribution.shareToken).toBe(token);
        expect(attribution.selfReferral).toBe(false);
    });

    test("a token minted for another event dissolves into a no-PIC order", async () => {
        const orderId = await createPicOrder(
            tokenFor(picProfile.id, "evt_elsewhere"),
            buyer.id
        );

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: { picProfileId: true, picFeeTotal: true },
        });

        expect(row.picProfileId).toBeNull();
        expect(row.picFeeTotal.toString()).toBe("0");

        expect(await prisma.pICAttribution.count({ where: { orderId } })).toBe(0);
    });

    test("a suspended PIC cannot ride a signed token to a fee", async () => {
        const orderId = await createPicOrder(
            tokenFor(suspendedProfile.id, event.id),
            buyer.id
        );

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: { picProfileId: true, picFeeTotal: true },
        });

        expect(row.picProfileId).toBeNull();
        expect(row.picFeeTotal.toString()).toBe("0");
    });

    test("a token with an assignment but no secret never mints (fail-closed)", async () => {
        delete process.env[PIC_REFERRAL_SECRET_ENV];

        expect(
            mintPicReferralToken({ picProfileId: picProfile.id, eventId: event.id })
        ).toBeNull();

        process.env[PIC_REFERRAL_SECRET_ENV] = `pic-slice-secret-${SUFFIX}`;
    });

    test("a purchase without a token leaves no PIC artefacts", async () => {
        const orderId = await createPicOrder(null, buyer.id);

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: { picProfileId: true, picFeeTotal: true },
        });

        expect(row.picProfileId).toBeNull();
        expect(row.picFeeTotal.toString()).toBe("0");
        expect(await prisma.pICAttribution.count({ where: { orderId } })).toBe(0);
    });

    test("the PIC's own account is flagged as a self-referral, not blocked", async () => {
        const orderId = await createPicOrder(
            tokenFor(picProfile.id, event.id),
            picUser.id
        );

        const attribution = await prisma.pICAttribution.findUniqueOrThrow({
            where: { orderId },
            select: { selfReferral: true },
        });

        expect(attribution.selfReferral).toBe(true);
    });

    test("the buyer-visible order payload stays free of PIC internals", async () => {
        const orderId = await createPicOrder(
            tokenFor(picProfile.id, event.id),
            buyer.id
        );

        signInAs(buyer.id);
        const authz = await resolveAuthzScope(buyer.id);

        if (!authz) {
            throw new Error("Fixture error: no authz scope");
        }

        const orderNumber = (
            await prisma.eventOrder.findUniqueOrThrow({
                where: { id: orderId },
                select: { orderNumber: true },
            })
        ).orderNumber;

        const payload = await getOwnOrder(orderNumber, authz);

        const serialized = JSON.stringify(payload);

        expect(serialized).toContain('"picFeeTotal":"15000.00"');
        expect(serialized).toContain('"organizerNetAmount":"285000.00"');
        expect(serialized).not.toContain("picProfileId");
        expect(serialized).not.toContain("shareToken");
        expect(serialized).not.toContain("PIC_LINK");
    });
});

describe("settlement posts the EARNED fee, exactly once, as a replay", () => {
    async function settle(orderId: string) {
        const order = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: { orderNumber: true, organizerId: true, total: true },
        });

        return settleVerifiedPayment({
            orderId,
            paymentId: null,
            provider: "ipaymu",
            providerTransactionId: null,
            providerSessionId: null,
            amountReported: order.total.toString(),
            providerFeeReported: null,
            statusCode: "00",
            channel: "cstore",
            eventType: "PAID",
        });
    }

    test("settling a PIC order writes one EARNED row that replays the snapshot", async () => {
        const orderId = await createPicOrder(
            tokenFor(picProfile.id, event.id),
            buyer.id
        );

        const outcome = await settle(orderId);

        expect(outcome.outcome).toBe("SETTLED");

        const rows = await prisma.pICFeeLedger.findMany({
            where: { orderId },
        });

        expect(rows).toHaveLength(1);

        const row = rows[0];

        expect(row.type).toBe("EARNED");
        expect(row.direction).toBe("CREDIT");
        expect(row.amount.toString()).toBe("15000");
        expect(row.currency).toBe("IDR");
        expect(row.rateBp).toBe(500);
        expect(row.feeType).toBe("PERCENTAGE");
        expect(row.basisType).toBe("GROSS_BEFORE_DISCOUNT");
        expect(row.basisAmount.toString()).toBe("300000");
        expect(row.quantity).toBe(2);
        expect(row.fixedAmount?.toString()).toBe("0");
        expect(row.status).toBe("EARNED");
        expect(row.picProfileId).toBe(picProfile.id);
        expect(row.organizerId).toBe(org.id);
        expect(row.eventId).toBe(event.id);
        expect(row.attributionId).not.toBeNull();
        expect(row.ticketTypeId).toBe(type.id);
        // `fee:earned:{orderItemId}` — the exact key the refund reversal seeds expect.
        expect(row.idempotencyKey).toBe(`fee:earned:${row.orderItemId}`);
    });

    test("re-delivering the same verified payment is an idempotent no-op", async () => {
        const orderId = await createPicOrder(
            tokenFor(picProfile.id, event.id),
            buyer.id
        );

        const first = await settle(orderId);
        const second = await settle(orderId);

        expect(first.outcome).toBe("SETTLED");
        expect(second.outcome).toBe("ALREADY_PAID");

        expect(await prisma.pICFeeLedger.count({ where: { orderId } })).toBe(1);
    });

    test("a non-PIC order settles with no ledger rows at all", async () => {
        const orderId = await createPicOrder(null, buyer.id);

        const outcome = await settle(orderId);

        expect(outcome.outcome).toBe("SETTLED");
        expect(await prisma.pICFeeLedger.count({ where: { orderId } })).toBe(0);
    });

    test("Σ EARNED rows equal the order's picFeeTotal (the replay invariant)", async () => {
        // quantity 3 × 150000 = 450000 @ 500bp → 22500. The snapshot and the ledger must
        // agree with the order total purely because settlement REPLAYS the snapshot —
        // never because anything recomputed the fee at settlement time.
        signInAs(buyer.id);
        const actor = await resolveAuthzScope(buyer.id);

        if (!actor) {
            throw new Error("Fixture error: no authz scope");
        }

        const outcome = await createTicketOrder({
            request: {
                eventId: event.id,
                items: [{ ticketTypeId: type.id, quantity: 3 }],
                buyerName: "Fixture Buyer",
                buyerEmail: `pic-if-buyer-${SUFFIX}@example.test`,
                buyerPhone: "081234567890",
                shareToken: tokenFor(picProfile.id, event.id),
            } as never,
            actor,
            idempotencyKey: `pic-sum-${SUFFIX}-${Math.random()}`,
        });

        const orderId = outcome.payload.orderId;
        await settle(orderId);

        const earned = await prisma.pICFeeLedger.findMany({
            where: { orderId, type: "EARNED" },
            orderBy: { createdAt: "asc" },
        });

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: orderId },
            select: { picFeeTotal: true },
        });

        const sum = earned.reduce((acc, row) => acc.add(row.amount), new Prisma.Decimal(0));

        expect(earned).toHaveLength(1);
        expect(sum.toString()).toBe(orderRow.picFeeTotal.toString());
        expect(earned[0].amount.toString()).toBe("22500");
    });
});