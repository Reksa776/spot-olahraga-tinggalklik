/**
 * ==========================================
 * PHASE 6 — RESERVATION + CHECKOUT (INTEGRATION)
 * ==========================================
 *
 * Runs the REAL service against the REAL database through the REAL `lib/authz` guards.
 * Only `@/auth` is mocked, so every ownership decision is made from actual session and
 * membership state rather than a stubbed opinion, and every inventory number is read
 * back out of the `tickettype` row.
 *
 * Coverage maps to brief §31: A (validation), B (ownership/IDOR), C (lifecycle),
 * F (checkout), G (money), H (failure safety + idempotency). Group E (real-InnoDB
 * concurrency) is the sibling `checkout-concurrency.integration.test.ts`.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { AppError } from "@/lib/api/errors";
import { ERROR_CODES } from "@/lib/api/errors";
import { AuthzError, AuthzErrorCode, resolveAuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createEvent, publishEvent } from "@/lib/events/service";
import { requireOrganizerAccess } from "@/lib/authz";
import { createTicketType, updateTicketType } from "@/lib/ticket-types/service";
import { createTicketOrder } from "@/lib/ticketing/checkout";
import { cancelOwnPendingOrder, getOwnOrder } from "@/lib/ticketing/orders";
import { expireDueReservations } from "@/lib/ticketing/reservations";
import { checkoutRequestSchema } from "@/lib/ticketing/checkout-validation";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `p6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
/**
 * PHASE 20B (D-P19-05 = A): `publishEvent` now refuses an event with no `endAt`, because such
 * an event can never complete and its gate would never close. Fixtures that publish therefore
 * carry a real end time — the same requirement a real organizer now meets.
 */
const FUTURE_END = new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000);
const PRICE = "150000.00";

let ownerA: { id: string };
let buyerA: { id: string };
let buyerB: { id: string };

let orgA: { id: string };
let orgB: { id: string };
let sportId: string;

let eventA: { id: string; slug: string };
let eventB: { id: string; slug: string };

/**
 * Active, 150 000, 1–4 per order.
 *
 * The quota is deliberately LARGE. This is the shared "happy path" type that most of
 * the suite buys from, so a small quota would make later tests fail with a legitimate
 * `SOLD_OUT` — a fixture artefact masquerading as a regression. Sold-out behaviour is
 * exercised by `typeSoldOut` (quota 0) and by the concurrency suite, both of which
 * assert exhaustion on purpose.
 */
let typeA: { id: string };
/** `minPerOrder = 2`, so a single ticket must be refused. */
let typeMin: { id: string };
/** Active but quota 0 — the sold-out gate. */
let typeSoldOut: { id: string };
/** `isActive: false`. */
let typeInactive: { id: string };
/** Sales window has not opened. */
let typeNotStarted: { id: string };
/** Sales window has closed. */
let typeEnded: { id: string };
/**
 * Dedicated to the expiry-reaper test.
 *
 * The reaper is a GLOBAL batch by design (§11.4: "bounded batch", 1-minute interval),
 * so running it against a shared type would also release every other test's holds and
 * make the counter assertion meaningless. Owning a type makes "2 seats before → 0
 * seats after" an exact statement about this order.
 */
let typeExpiry: { id: string };
/** Dedicated to the price-snapshot test, so no other test depends on its price. */
let typeSnapshot: { id: string };

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: {
                      id: userId,
                      email: `${userId}@${SUFFIX}.test`,
                      name: "Test",
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

/** Resolve an organizer actor's scope through the real permission-checking guard. */
async function organizerScope(organizerId: string, userId: string) {
    signInAs(userId);
    return requireOrganizerAccess(organizerId, "event.read");
}

/** Resolve a customer's scope from their session — no organizer involved. */
async function customerScope(userId: string) {
    signInAs(userId);
    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`Fixture error: no authz scope for ${userId}`);
    }

    return scope;
}

async function expectRejection(run: () => Promise<unknown>) {
    try {
        await run();
    } catch (error) {
        return error as AppError;
    }

    throw new Error("Expected the operation to be rejected, but it succeeded");
}

/** Read the counters straight from the row — never from a service's own report. */
async function counters(ticketTypeId: string) {
    const row = await prisma.ticketType.findUniqueOrThrow({
        where: { id: ticketTypeId },
        select: { quota: true, sold: true, reserved: true, version: true },
    });

    return row;
}

function request(overrides: Record<string, unknown> = {}) {
    return {
        eventId: eventA.id,
        items: [{ ticketTypeId: typeA.id, quantity: 2 }],
        buyerName: "Fixture Buyer",
        buyerEmail: `buyer-${SUFFIX}@example.test`,
        buyerPhone: "081234567890",
        ...overrides,
    } as never;
}

beforeAll(async () => {
    ownerA = await createUser("owner-a");
    buyerA = await createUser("buyer-a");
    buyerB = await createUser("buyer-b");

    const ownerB = await createUser("owner-b");

    orgA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `P6 Org A ${SUFFIX}`,
            slug: `p6-org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    orgB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `P6 Org B ${SUFFIX}`,
            slug: `p6-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: orgA.id, userId: ownerA.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgB.id, userId: ownerB.id, role: "OWNER", status: "ACTIVE" },
        ],
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `P6 Sport ${SUFFIX}`, slug: `p6-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    // Events and ticket types are created through the real Phase 4/5 services, so the
    // fixtures cannot be in a state the application itself could not produce.
    const scopeA = await organizerScope(orgA.id, ownerA.id);

    eventA = await createEvent(
        scopeA,
        orgA.id,
        {
            title: `P6 Event A ${SUFFIX}`,
            sportId,
            startAt: FUTURE,
            endAt: FUTURE_END,
        } as never
    );

    const scopeB = await organizerScope(orgB.id, ownerB.id);

    eventB = await createEvent(
        scopeB,
        orgB.id,
        {
            title: `P6 Event B ${SUFFIX}`,
            sportId,
            startAt: FUTURE,
            endAt: FUTURE_END,
        } as never
    );

    const scopeA2 = await organizerScope(orgA.id, ownerA.id);

    typeA = await createTicketType(scopeA2, eventA.id, {
        name: "Reguler",
        price: PRICE,
        quota: 500,
        minPerOrder: 1,
        maxPerOrder: 4,
    } as never);

    typeMin = await createTicketType(scopeA2, eventA.id, {
        name: "Berpasangan",
        price: "250000.00",
        quota: 200,
        minPerOrder: 2,
        maxPerOrder: null,
    } as never);

    typeSoldOut = await createTicketType(scopeA2, eventA.id, {
        name: "Habis",
        price: "100000.00",
        quota: 0,
    } as never);

    typeInactive = await createTicketType(scopeA2, eventA.id, {
        name: "Nonaktif",
        price: "100000.00",
        quota: 10,
    } as never);

    typeNotStarted = await createTicketType(scopeA2, eventA.id, {
        name: "Belum Dibuka",
        price: "100000.00",
        quota: 10,
        salesStartAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    } as never);

    typeEnded = await createTicketType(scopeA2, eventA.id, {
        name: "Sudah Tutup",
        price: "100000.00",
        quota: 10,
        salesStartAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        salesEndAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    } as never);

    typeExpiry = await createTicketType(scopeA2, eventA.id, {
        name: "Kedaluwarsa",
        price: "100000.00",
        quota: 20,
    } as never);

    typeSnapshot = await createTicketType(scopeA2, eventA.id, {
        name: "Snapshot",
        price: PRICE,
        quota: 50,
    } as never);

    await publishEvent(scopeA2, eventA.id);

    // eventB needs its own active type FIRST: the Phase 4 publish precondition is
    // "at least one ACTIVE TicketType with quota > 0", and Phase 5 made it reachable.
    // Omitting this is not a fixture detail — `publishEvent` refuses without it, which is
    // the integration this phase exists to complete.
    const scopeB2 = await organizerScope(orgB.id, ownerB.id);

    await createTicketType(scopeB2, eventB.id, {
        name: "Reguler",
        price: PRICE,
        quota: 5,
    } as never);

    // NOTE: re-resolve rather than reusing `scopeB`. `requireOrganizerAccess` derives the
    // actor from the LIVE session at call time, and the session has since moved to
    // ownerA — so a stale scope silently authorizes as the wrong user. The guard is
    // right; a fixture that caches a scope across a sign-in change is the bug.
    await publishEvent(await organizerScope(orgB.id, ownerB.id), eventB.id);

    // Deactivate the one that must be inactive, through the real service.
    const scopeA3 = await organizerScope(orgA.id, ownerA.id);
    await updateTicketType(scopeA3, typeInactive.id, {
        isActive: false,
    } as never);
});

afterAll(async () => {
    const eventIds = [eventA.id, eventB.id];

    // Children first, and only rows this suite could have created.
    await prisma.ticketReservation.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.eventOrderItem.deleteMany({ where: { order: { eventId: { in: eventIds } } } });
    await prisma.idempotencyKey.deleteMany({ where: { userId: { in: [buyerA.id, buyerB.id, ownerA.id] } } });
    await prisma.eventOrder.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.eventImage.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });

    // Audit rows are append-only in production, but TEST audit rows are still residue.
    // Filtered to this suite's users, tenants and the SYSTEM reaper rows it produced.
    await prisma.adminAuditLog.deleteMany({
        where: {
            OR: [
                { actorUserId: { in: [buyerA.id, buyerB.id, ownerA.id] } },
                { organizerId: { in: [orgA.id, orgB.id] } },
                { AND: [{ action: "order.expire" }, { actorType: "SYSTEM" }] },
            ],
        },
    });

    await prisma.organizerMember.deleteMany({
        where: { organizerId: { in: [orgA.id, orgB.id] } },
    });
    await prisma.organizer.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.user.deleteMany({
        where: { email: { contains: SUFFIX } },
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// A. Reservation validation
// ─────────────────────────────────────────────────────────────────────────────

describe("A. the purchase gate refuses what the design says it must", () => {
    test("a valid request reserves quota and returns a PENDING_PAYMENT order", async () => {
        const actor = await customerScope(buyerA.id);

        const before = await counters(typeA.id);

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 2 }] }),
            actor,
            idempotencyKey: `valid-${SUFFIX}`,
        });

        expect(outcome.replayed).toBe(false);
        expect(outcome.payload.status).toBe("PENDING_PAYMENT");
        expect(outcome.payload.paymentStatus).toBe("UNPAID");
        expect(outcome.payload.items).toHaveLength(1);
        expect(outcome.payload.items[0].quantity).toBe(2);

        const after = await counters(typeA.id);

        expect(after.reserved).toBe(before.reserved + 2);
        expect(after.sold).toBe(before.sold);
        expect(after.quota).toBe(before.quota);
    });

    test("below minPerOrder is refused with a machine-readable reason", async () => {
        const actor = await customerScope(buyerA.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    items: [{ ticketTypeId: typeMin.id, quantity: 1 }],
                }),
                actor,
                idempotencyKey: `below-min-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.LIMIT_EXCEEDED);
        expect(error.details?.reason).toBe("BELOW_MIN_PER_ORDER");
        expect(await counters(typeMin.id)).toMatchObject({ reserved: 0 });
    });

    test("exactly minPerOrder is accepted", async () => {
        const actor = await customerScope(buyerB.id);

        const outcome = await createTicketOrder({
            request: request({
                items: [{ ticketTypeId: typeMin.id, quantity: 2 }],
            }),
            actor,
            idempotencyKey: `at-min-${SUFFIX}`,
        });

        expect(outcome.payload.items[0].quantity).toBe(2);
        expect((await counters(typeMin.id)).reserved).toBe(2);
    });

    test("above maxPerOrder is refused and names the bound", async () => {
        const actor = await customerScope(buyerA.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({ items: [{ ticketTypeId: typeA.id, quantity: 5 }] }),
                actor,
                idempotencyKey: `above-max-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.LIMIT_EXCEEDED);
        expect(error.details?.reason).toBe("ABOVE_MAX_PER_ORDER");
        expect(error.details?.maxPerOrder).toBe(4);
    });

    test("exactly maxPerOrder is accepted, and maxPerOrder = null has no ceiling below quota", async () => {
        const actor = await customerScope(buyerA.id);

        const atMax = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 4 }] }),
            actor,
            idempotencyKey: `at-max-${SUFFIX}`,
        });

        expect(atMax.payload.items[0].quantity).toBe(4);

        // typeMin has maxPerOrder = null and quota 10: 6 is legal and bounded only by quota.
        const noCeiling = await createTicketOrder({
            request: request({
                items: [{ ticketTypeId: typeMin.id, quantity: 6 }],
            }),
            actor,
            idempotencyKey: `null-max-${SUFFIX}`,
        });

        expect(noCeiling.payload.items[0].quantity).toBe(6);
    });

    test("quantity 0 and negative quantities are refused by the request schema, before any inventory work", () => {
        // Brief §10: "Reject invalid quantities before reservation mutation." The schema
        // is the first gate, so no order, reservation or counter is ever touched.
        const base = {
            eventId: "event-x",
            buyerName: "Buyer",
            buyerEmail: "buyer@example.test",
            buyerPhone: "081234567890",
        };

        for (const quantity of [0, -1, -100]) {
            const parsed = checkoutRequestSchema.safeParse({
                ...base,
                items: [{ ticketTypeId: "type-x", quantity }],
            });

            expect(parsed.success).toBe(false);
        }

        // And a positive integer passes, so the refusal above is about the value and
        // not about the shape of the fixture.
        const ok = checkoutRequestSchema.safeParse({
            ...base,
            items: [{ ticketTypeId: "type-x", quantity: 1 }],
        });

        expect(ok.success).toBe(true);
    });

    test.each([
        ["inactive", () => typeInactive.id, "INACTIVE"],
        ["not yet started", () => typeNotStarted.id, "NOT_STARTED"],
        ["already ended", () => typeEnded.id, "CLOSED"],
    ])("a %s ticket type cannot be purchased", async (_label, typeId, reason) => {
        const actor = await customerScope(buyerB.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    items: [{ ticketTypeId: typeId(), quantity: 1 }],
                }),
                actor,
                idempotencyKey: `window-${_label}-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.SALES_NOT_OPEN);
        expect(error.details?.reason).toBe(reason);
        expect(await counters(typeId())).toMatchObject({ reserved: 0 });
    });

    test("a sold-out ticket type is refused", async () => {
        const actor = await customerScope(buyerB.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    items: [{ ticketTypeId: typeSoldOut.id, quantity: 1 }],
                }),
                actor,
                idempotencyKey: `sold-out-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.SOLD_OUT);
    });

    test("a draft event is not purchasable and its existence is not confirmed", async () => {
        const scopeA = await organizerScope(orgA.id, ownerA.id);

        const draft = await createEvent(
            scopeA,
            orgA.id,
            { title: `P6 Draft ${SUFFIX}`, sportId, startAt: FUTURE } as never
        );

        const draftType = await createTicketType(scopeA, draft.id, {
            name: "Reguler",
            price: PRICE,
            quota: 5,
        } as never);

        const actor = await customerScope(buyerA.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    eventId: draft.id,
                    items: [{ ticketTypeId: draftType.id, quantity: 1 }],
                }),
                actor,
                idempotencyKey: `draft-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.NOT_FOUND);

        await prisma.ticketType.deleteMany({ where: { eventId: draft.id } });
        await prisma.event.deleteMany({ where: { id: draft.id } });
    });

    test("a cancelled event is refused as sales-not-open, not as missing", async () => {
        const scopeA = await organizerScope(orgA.id, ownerA.id);

        const cancelled = await createEvent(
            scopeA,
            orgA.id,
            { title: `P6 Cancelled ${SUFFIX}`, sportId, startAt: FUTURE } as never
        );

        const cancelledType = await createTicketType(scopeA, cancelled.id, {
            name: "Reguler",
            price: PRICE,
            quota: 5,
        } as never);

        await prisma.event.update({
            where: { id: cancelled.id },
            data: { status: "CANCELLED", cancelledAt: new Date() },
        });

        const actor = await customerScope(buyerA.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    eventId: cancelled.id,
                    items: [{ ticketTypeId: cancelledType.id, quantity: 1 }],
                }),
                actor,
                idempotencyKey: `cancelled-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.SALES_NOT_OPEN);
        expect(error.details?.reason).toBe("EVENT_CANCELLED");

        await prisma.ticketType.deleteMany({ where: { eventId: cancelled.id } });
        await prisma.event.deleteMany({ where: { id: cancelled.id } });
    });

    test("a ticket type belonging to ANOTHER event is not honoured", async () => {
        const actor = await customerScope(buyerA.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                // typeMin belongs to eventA; claim eventB.
                request: request({
                    eventId: eventB.id,
                    items: [{ ticketTypeId: typeMin.id, quantity: 1 }],
                }),
                actor,
                idempotencyKey: `cross-event-type-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.NOT_FOUND);
    });

    test("an event-level maxTicketsPerOrder is enforced across lines", async () => {
        const scopeA = await organizerScope(orgA.id, ownerA.id);

        const capped = await createEvent(
            scopeA,
            orgA.id,
            {
                title: `P6 Capped ${SUFFIX}`,
                sportId,
                startAt: FUTURE,
                endAt: FUTURE_END,
            } as never
        );

        const cappedType = await createTicketType(scopeA, capped.id, {
            name: "Reguler",
            price: PRICE,
            quota: 50,
        } as never);

        await prisma.event.update({
            where: { id: capped.id },
            data: { maxTicketsPerOrder: 3 },
        });

        await publishEvent(scopeA, capped.id);

        const actor = await customerScope(buyerA.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    eventId: capped.id,
                    items: [{ ticketTypeId: cappedType.id, quantity: 4 }],
                }),
                actor,
                idempotencyKey: `event-cap-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.LIMIT_EXCEEDED);
        expect(error.details?.reason).toBe("ABOVE_EVENT_MAX_PER_ORDER");

        await prisma.ticketType.deleteMany({ where: { eventId: capped.id } });
        await prisma.event.deleteMany({ where: { id: capped.id } });
    });

    test("the event-level maxTicketsPerOrder is inclusive: exactly the cap is accepted", async () => {
        const scopeA = await organizerScope(orgA.id, ownerA.id);

        const capped = await createEvent(
            scopeA,
            orgA.id,
            {
                title: `P6 Capped At ${SUFFIX}`,
                sportId,
                startAt: FUTURE,
                endAt: FUTURE_END,
            } as never
        );

        const cappedType = await createTicketType(scopeA, capped.id, {
            name: "Reguler",
            price: PRICE,
            quota: 50,
        } as never);

        await prisma.event.update({
            where: { id: capped.id },
            data: { maxTicketsPerOrder: 3 },
        });

        // Across TWO lines that sum to exactly the cap: the limit is per ORDER, not per
        // line, so splitting the purchase must not evade it (and must not over-refuse it).
        // Built BEFORE switching the session to a buyer, because `createTicketType`
        // authorizes against the session.
        const cappedType2 = await createTicketType(scopeA, capped.id, {
            name: "Tribun",
            price: PRICE,
            quota: 50,
        } as never);

        await publishEvent(scopeA, capped.id);

        const actor = await customerScope(buyerB.id);

        const accepted = await createTicketOrder({
            request: request({
                eventId: capped.id,
                items: [
                    { ticketTypeId: cappedType.id, quantity: 2 },
                    { ticketTypeId: cappedType2.id, quantity: 1 },
                ],
            }),
            actor,
            idempotencyKey: `event-cap-exact-${SUFFIX}`,
        });

        expect(accepted.payload.items).toHaveLength(2);

        const refused = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    eventId: capped.id,
                    items: [
                        { ticketTypeId: cappedType.id, quantity: 2 },
                        { ticketTypeId: cappedType2.id, quantity: 2 },
                    ],
                }),
                actor,
                idempotencyKey: `event-cap-split-${SUFFIX}`,
            })
        );

        expect(refused.code).toBe(ERROR_CODES.LIMIT_EXCEEDED);
        expect(refused.details?.reason).toBe("ABOVE_EVENT_MAX_PER_ORDER");

        // The accepted order holds order items whose ticket types are `Restrict`, so the
        // order (and its cascading items/reservations) goes first.
        await prisma.eventOrder.deleteMany({ where: { eventId: capped.id } });
        await prisma.ticketType.deleteMany({ where: { eventId: capped.id } });
        await prisma.event.deleteMany({ where: { id: capped.id } });
    });

    test("coupons are refused rather than silently ignored (MVP discount = 0)", async () => {
        const actor = await customerScope(buyerA.id);

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({ couponCode: "HACK50" }),
                actor,
                idempotencyKey: `coupon-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.VALIDATION_ERROR);
        expect(error.details?.reason).toBe("COUPONS_NOT_AVAILABLE_IN_MVP");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. Ownership / IDOR
// ─────────────────────────────────────────────────────────────────────────────

describe("B. order ownership is enforced server-side", () => {
    let orderNumber: string;

    beforeAll(async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({
                items: [{ ticketTypeId: typeA.id, quantity: 1 }],
            }),
            actor,
            idempotencyKey: `ownership-${SUFFIX}`,
        });

        orderNumber = outcome.payload.orderNumber;
    });

    test("the owner can read their own order", async () => {
        const actor = await customerScope(buyerA.id);
        const order = await getOwnOrder(orderNumber, actor);

        expect(order.orderNumber).toBe(orderNumber);
        expect(order.items[0].unitPrice).toBe(PRICE);
    });

    test("another customer is refused, and cannot tell the order exists", async () => {
        const actor = await customerScope(buyerB.id);

        const error = await expectRejection(() => getOwnOrder(orderNumber, actor));


        // 404, not 403 — the same anti-enumeration rule Phase 3 applies to organizers.
        // NOT_FOUND, not 403: an order the actor does not own is indistinguishable from
        // one that does not exist, so a probe cannot enumerate other buyers' orders.
        expect((error as unknown as { code: string }).code).toBe("NOT_FOUND");
    });

    test("an unauthenticated caller cannot read an order", async () => {
        signInAs(null);

        const error = await expectRejection(async () => {
            const { requireAuth } = await import("@/lib/authz");
            return requireAuth();
        });

        expect((error as unknown as AuthzError).code).toBe(
            AuthzErrorCode.UNAUTHORIZED
        );
    });

    test("another customer cannot cancel someone else's order", async () => {
        const actor = await customerScope(buyerB.id);

        await expectRejection(() => cancelOwnPendingOrder(orderNumber, actor));

        // …and the order is still the owner's, untouched.
        const owner = await customerScope(buyerA.id);
        const still = await getOwnOrder(orderNumber, owner);

        expect(still.status).toBe("PENDING_PAYMENT");
    });

    test("a manipulated customerId in the payload is not authority", async () => {
        // The schema has no such field, so it cannot reach the service; assert the strip
        // and then assert the service still scopes to the authenticated actor.
        const parsed = checkoutRequestSchema.parse({
            eventId: eventA.id,
            items: [{ ticketTypeId: typeA.id, quantity: 1 }],
            buyerName: "Fixture Buyer",
            buyerEmail: `buyer-${SUFFIX}@example.test`,
            buyerPhone: "081234567890",
            customerId: buyerB.id,
            userId: buyerB.id,
            organizerId: orgB.id,
        } as never);

        expect(parsed).not.toHaveProperty("customerId");
        expect(parsed).not.toHaveProperty("userId");
        expect(parsed).not.toHaveProperty("organizerId");

        const actor = await customerScope(buyerA.id);
        const order = await getOwnOrder(orderNumber, actor);

        expect(order.orderNumber).toBe(orderNumber);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. Reservation lifecycle
// ─────────────────────────────────────────────────────────────────────────────

describe("C. reservation lifecycle", () => {
    test("checkout holds exactly one HELD reservation per line, with a server-derived expiry", async () => {
        const actor = await customerScope(buyerA.id);
        const requestedAt = new Date();

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 3 }] }),
            actor,
            idempotencyKey: `lifecycle-create-${SUFFIX}`,
            now: requestedAt,
        });

        const reservations = await prisma.ticketReservation.findMany({
            where: { orderId: outcome.payload.orderId },
            select: { status: true, quantity: true, expiresAt: true },
        });

        expect(reservations).toHaveLength(1);
        expect(reservations[0].status).toBe("HELD");
        expect(reservations[0].quantity).toBe(3);

        // Design §11.2's default TTL is 30 minutes, sourced from PlatformSetting.
        const ttlMinutes =
            (reservations[0].expiresAt.getTime() - requestedAt.getTime()) / 60_000;

        expect(ttlMinutes).toBeGreaterThan(29);
        expect(ttlMinutes).toBeLessThan(31);
    });

    test("cancelling releases the seats, marks the order CANCELLED and is not repeatable", async () => {
        const actor = await customerScope(buyerA.id);

        const before = await counters(typeA.id);

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 2 }] }),
            actor,
            idempotencyKey: `lifecycle-cancel-${SUFFIX}`,
        });

        const held = await counters(typeA.id);
        expect(held.reserved).toBe(before.reserved + 2);

        const cancelled = await cancelOwnPendingOrder(
            outcome.payload.orderNumber,
            actor,
            "fixture cancel"
        );

        expect(cancelled.status).toBe("CANCELLED");
        expect(cancelled.canCancel).toBe(false);

        const released = await counters(typeA.id);
        expect(released.reserved).toBe(before.reserved);
        expect(released.sold).toBe(before.sold);

        const rows = await prisma.ticketReservation.findMany({
            where: { orderId: outcome.payload.orderId },
            select: { status: true },
        });

        expect(rows.map((r) => r.status)).toEqual(["RELEASED"]);

        // Second cancel: refused, and reserved does not go negative.
        const error = await expectRejection(() =>
            cancelOwnPendingOrder(outcome.payload.orderNumber, actor)
        );

        expect(error.code).toBe(ERROR_CODES.ORDER_NOT_PAYABLE);
        expect((await counters(typeA.id)).reserved).toBe(before.reserved);
    });

    test("the expiry reaper releases seats and is safe to run twice", async () => {
        const actor = await customerScope(buyerA.id);

        // `typeExpiry` is used by this test alone, so "2 before → 0 after" is exact even
        // though the reaper sweeps every due order in the database.
        const before = await counters(typeExpiry.id);
        expect(before.reserved).toBe(0);

        const outcome = await createTicketOrder({
            request: request({
                items: [{ ticketTypeId: typeExpiry.id, quantity: 2 }],
            }),
            actor,
            idempotencyKey: `lifecycle-expire-${SUFFIX}`,
        });

        expect((await counters(typeExpiry.id)).reserved).toBe(2);

        // Run the batch "in the future" so this order's HELD row is due.
        const runAt = new Date(Date.now() + 60 * 60 * 1000);
        const first = await expireDueReservations({ now: runAt, batchSize: 500 });

        expect(first.reservationsExpired).toBeGreaterThanOrEqual(1);

        const after = await counters(typeExpiry.id);
        expect(after.reserved).toBe(0);
        // Expiry returns seats to availability; it never turns a hold into a sale.
        expect(after.sold).toBe(before.sold);

        const rows = await prisma.ticketReservation.findMany({
            where: { orderId: outcome.payload.orderId },
            select: { status: true },
        });

        expect(rows.map((r) => r.status)).toEqual(["EXPIRED"]);

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: outcome.payload.orderId },
            select: { status: true },
        });

        expect(orderRow.status).toBe("EXPIRED");

        // Idempotent: a second pass finds nothing HELD and changes nothing.
        const second = await expireDueReservations({ now: runAt, batchSize: 500 });

        expect(second.reservationsExpired).toBe(0);
        expect((await counters(typeExpiry.id)).reserved).toBe(0);
    });

    test("cancelling an already-expired order is refused (no resurrection)", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor,
            idempotencyKey: `lifecycle-expired-cancel-${SUFFIX}`,
        });

        await expireDueReservations({
            now: new Date(Date.now() + 60 * 60 * 1000),
            batchSize: 500,
        });

        const error = await expectRejection(() =>
            cancelOwnPendingOrder(outcome.payload.orderNumber, actor)
        );

        expect(error.code).toBe(ERROR_CODES.ORDER_NOT_PAYABLE);

        const orderRow = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: outcome.payload.orderId },
            select: { status: true },
        });

        // PENDING_PAYMENT → EXPIRED is the only transition that happened.
        expect(orderRow.status).toBe("EXPIRED");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. Checkout
// ─────────────────────────────────────────────────────────────────────────────

describe("F. checkout", () => {
    test("a multi-line order creates one order with one item and one reservation per line", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({
                items: [
                    { ticketTypeId: typeMin.id, quantity: 2 },
                    { ticketTypeId: typeA.id, quantity: 1 },
                ],
            }),
            actor,
            idempotencyKey: `multi-line-${SUFFIX}`,
        });

        expect(outcome.payload.items).toHaveLength(2);
        expect(outcome.payload.reservations).toHaveLength(2);

        // Lines are PROCESSED by ticketTypeId ascending (§11.3), but the persisted item
        // order is by `createdAt` — so compare the set of line amounts, not positions,
        // and assert the per-line arithmetic instead.
        const order = await getOwnOrder(outcome.payload.orderNumber, actor);

        expect(order.items).toHaveLength(2);
        // typeA 150 000 × 1 = 150 000; typeMin 250 000 × 2 = 500 000.
        expect(order.items.map((i) => Number(i.subtotal)).sort((a, b) => a - b)).toEqual(
            [150000, 500000]
        );

        for (const item of order.items) {
            expect(Number(item.subtotal)).toBe(
                Number(item.unitPrice) * item.quantity
            );
        }

        expect(Number(order.totals.subtotal)).toBe(650000);
        expect(order.totals.total).toBe(order.totals.subtotal);
    });

    test("repeated lines for one ticket type are merged into a single reservation", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({
                items: [
                    { ticketTypeId: typeMin.id, quantity: 2 },
                    { ticketTypeId: typeMin.id, quantity: 2 },
                ],
            }),
            actor,
            idempotencyKey: `merged-lines-${SUFFIX}`,
        });

        expect(outcome.payload.items).toHaveLength(1);
        expect(outcome.payload.items[0].quantity).toBe(4);

        const rows = await prisma.ticketReservation.findMany({
            where: { orderId: outcome.payload.orderId },
            select: { quantity: true },
        });

        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(4);
    });

    test("the order records the event and the owning organizer from the database", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor,
            idempotencyKey: `ownership-columns-${SUFFIX}`,
        });

        const row = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: outcome.payload.orderId },
            select: { eventId: true, organizerId: true, userId: true },
        });

        expect(row.eventId).toBe(eventA.id);
        expect(row.organizerId).toBe(orgA.id);
        expect(row.userId).toBe(buyerA.id);
    });

    test("the order's name/price snapshot survives a later ticket-type edit", async () => {
        const buyer = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({
                items: [{ ticketTypeId: typeSnapshot.id, quantity: 2 }],
            }),
            actor: buyer,
            idempotencyKey: `snapshot-${SUFFIX}`,
        });

        expect(outcome.payload.items[0].unitPrice).toBe(PRICE);
        expect(outcome.payload.totals.subtotal).toBe("300000.00");

        // The organizer edits the price AFTER the order exists…
        await updateTicketType(await organizerScope(orgA.id, ownerA.id), typeSnapshot.id, {
            price: "999999.00",
            name: "Snapshot (baru)",
        } as never);

        // …and re-resolve the buyer's own scope, because the session has just changed.
        // `requireOwnResource` reads the LIVE session, so a cached actor would authorize
        // as the organizer. That is the guard working, not a test workaround.
        const order = await getOwnOrder(
            outcome.payload.orderNumber,
            await customerScope(buyerA.id)
        );

        // The historical price is untouched by the edit: it lives on the order line.
        expect(order.items[0].unitPrice).toBe(PRICE);
        expect(order.items[0].name).toBe("Snapshot");
        expect(order.totals.subtotal).toBe("300000.00");
        expect(order.totals.total).toBe("300000.00");

        // …and the ticket type really did change, so the assertion above is not vacuous.
        const current = await prisma.ticketType.findUniqueOrThrow({
            where: { id: typeSnapshot.id },
            select: { price: true },
        });

        expect(current.price.toString()).toBe("999999");
    });

    test("the customer order payload carries no organizer or inventory internals", async () => {
        const actor = await customerScope(buyerA.id);

        const order = await getOwnOrder(
            (
                await createTicketOrder({
                    request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
                    actor,
                    idempotencyKey: `payload-shape-${SUFFIX}`,
                })
            ).payload.orderNumber,
            actor
        );

        const serialized = JSON.stringify(order);

        // Precise tokens, not a word-scan: `totals.picFeeTotal` is part of the design's
        // §25.5 contract and legitimately present (it is the buyer-visible total, not the
        // PIC's private fee ledger). The forbidden things are organizer identity,
        // inventory counters, authorization internals and PIC secrets.
        for (const forbidden of [
            "organizerId",
            "" + "quota",
            "reserved",
            "permissionGrant",
            "picProfileId",
            "shareToken",
            "OrganizerMember",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }

        expect(order).not.toHaveProperty("organizerId");
        expect(order).not.toHaveProperty("quota");
        // The fee line exists and is zero in MVP (design §17.2), not omitted.
        expect(order.totals.picFeeTotal).toBe("0.00");
        expect(JSON.parse(serialized)).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. Money
// ─────────────────────────────────────────────────────────────────────────────

describe("G. money is Decimal-safe and server-derived", () => {
    test("totals are computed from the database price, exactly", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 3 }] }),
            actor,
            idempotencyKey: `money-total-${SUFFIX}`,
        });

        const totals = outcome.payload.totals;

        expect(totals.subtotal).toBe("450000.00");
        expect(totals.total).toBe("450000.00");
        // MVP: every fee is 0 until configured (design §17.2 / D-11).
        expect(totals.discount).toBe("0.00");
        expect(totals.platformFee).toBe("0.00");
        expect(totals.picFeeTotal).toBe("0.00");
        expect(totals.organizerNetAmount).toBe("450000.00");
    });

    test("money is serialized as fixed-2dp strings, never JSON numbers", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor,
            idempotencyKey: `money-format-${SUFFIX}`,
        });

        for (const value of Object.values(outcome.payload.totals)) {
            expect(typeof value).toBe("string");
            expect(value).toMatch(/^\d+\.\d{2}$/);
        }

        expect(outcome.payload.items[0].unitPrice).toBe(PRICE);
    });

    test("a client-supplied total or price is not financial authority", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({
                items: [{ ticketTypeId: typeA.id, quantity: 2 }],
                total: "1.00",
                subtotal: "1.00",
                price: "1.00",
                currency: "USD",
            }),
            actor,
            idempotencyKey: `money-tamper-${SUFFIX}`,
        });

        expect(outcome.payload.totals.total).toBe("300000.00");
        expect(outcome.payload.currency).toBe("IDR");
    });

    test("the raw JSON body cannot smuggle a client price past the schema", () => {
        const parsed = checkoutRequestSchema.parse({
            eventId: eventA.id,
            items: [
                { ticketTypeId: typeA.id, quantity: 1, price: "1.00", subtotal: "1.00" },
            ],
            buyerName: "Fixture Buyer",
            buyerEmail: `buyer-${SUFFIX}@example.test`,
            buyerPhone: "081234567890",
            total: "1.00",
            currency: "USD",
        } as never);

        expect(parsed.items[0]).toEqual({ ticketTypeId: typeA.id, quantity: 1 });
        expect(parsed).not.toHaveProperty("total");
        expect(parsed).not.toHaveProperty("currency");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// §15 Audit logging — brief §27
// ─────────────────────────────────────────────────────────────────────────────

describe("audit logging reuses the Phase 4/5 logger", () => {
    test("a created order writes one order.create row naming the tenant and the money", async () => {
        const actor = await customerScope(buyerA.id);

        const outcome = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 2 }] }),
            actor,
            idempotencyKey: `audit-create-${SUFFIX}`,
        });

        const rows = await prisma.adminAuditLog.findMany({
            where: {
                action: "order.create",
                entityRef: outcome.payload.orderNumber,
            },
        });

        expect(rows).toHaveLength(1);

        const row = rows[0];

        // The actor is the customer; the ORGANIZER is the order's tenant. Two columns.
        expect(row.actorType).toBe("USER");
        expect(row.actorUserId).toBe(buyerA.id);
        expect(row.actorOrganizerId).toBeNull();
        expect(row.organizerId).toBe(orgA.id);
        expect(row.entityType).toBe("EventOrder");
        expect(row.adminId).toBe(buyerA.id);

        const after = row.afterState as Record<string, unknown>;

        expect(after.orderNumber).toBe(outcome.payload.orderNumber);
        expect(after.total).toBe("300000.00");
        expect(after.status).toBe("PENDING_PAYMENT");
        expect(after.quantities).toEqual([2]);

        // No buyer PII in the audit payload (brief §27).
        const serialized = JSON.stringify({ after, description: row.description });

        for (const forbidden of ["Fixture Buyer", "buyer-", "081234567890"]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    test("the Phase 5 ticket-type audit path records the acting user", async () => {
        // DIAGNOSTIC + GUARD. Every `ticket_type.*` row in the database has a NULL
        // `actorUserId` while still carrying `actorRole`, which suggests the actor passed
        // to the audit writer is missing its `userId`. This suite cannot fix Phase 5, but
        // it can prove whether the ACTOR is recorded on that path — and the assertion is
        // worth keeping either way, because "who changed the quota" is the whole point of
        // an audit row.
        const scope = await organizerScope(orgA.id, ownerA.id);

        const created = await createTicketType(scope, eventA.id, {
            name: `Audit Actor ${SUFFIX}`,
            price: PRICE,
            quota: 3,
        } as never);

        const rows = await prisma.adminAuditLog.findMany({
            where: { action: "ticket_type.create", entityRef: created.id },
            select: { actorUserId: true, adminId: true, actorRole: true },
        });

        expect(rows).toHaveLength(1);
        expect(rows[0].actorUserId).toBe(ownerA.id);
        expect(rows[0].adminId).toBe(ownerA.id);
    });

    test("an idempotent replay does NOT write a second audit row", async () => {
        const actor = await customerScope(buyerA.id);
        const key = `audit-replay-${SUFFIX}`;

        const first = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor,
            idempotencyKey: key,
        });

        await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor,
            idempotencyKey: key,
        });

        const rows = await prisma.adminAuditLog.count({
            where: { action: "order.create", entityRef: first.payload.orderNumber },
        });

        expect(rows).toBe(1);
    });

    test("a rolled-back checkout writes no audit row at all", async () => {
        const actor = await customerScope(buyerA.id);

        const before = await prisma.adminAuditLog.count({
            where: { action: "order.create", actorUserId: buyerA.id },
        });

        await expectRejection(() =>
            createTicketOrder({
                request: request({
                    items: [
                        { ticketTypeId: typeA.id, quantity: 1 },
                        { ticketTypeId: typeSoldOut.id, quantity: 1 },
                    ],
                }),
                actor,
                idempotencyKey: `audit-rollback-${SUFFIX}`,
            })
        );

        const after = await prisma.adminAuditLog.count({
            where: { action: "order.create", actorUserId: buyerA.id },
        });

        expect(after).toBe(before);
    });

    test("a cancellation and an expiry are each recorded once, with the right actor type", async () => {
        const actor = await customerScope(buyerA.id);

        const cancelled = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeExpiry.id, quantity: 1 }] }),
            actor,
            idempotencyKey: `audit-cancel-${SUFFIX}`,
        });

        await cancelOwnPendingOrder(
            cancelled.payload.orderNumber,
            actor,
            "audit fixture"
        );

        const cancelRows = await prisma.adminAuditLog.findMany({
            where: {
                action: "order.cancel",
                entityRef: cancelled.payload.orderNumber,
            },
        });

        expect(cancelRows).toHaveLength(1);
        expect(cancelRows[0].actorType).toBe("USER");
        expect(cancelRows[0].actorUserId).toBe(buyerA.id);
        expect(cancelRows[0].reason).toBe("audit fixture");

        const expired = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeExpiry.id, quantity: 1 }] }),
            actor,
            idempotencyKey: `audit-expire-${SUFFIX}`,
        });

        await expireDueReservations({
            now: new Date(Date.now() + 60 * 60 * 1000),
            batchSize: 500,
        });

        const expireRows = await prisma.adminAuditLog.findMany({
            where: {
                action: "order.expire",
                entityRef: expired.payload.orderNumber,
            },
        });

        // The reaper is not a user: it records an explicit SYSTEM actor rather than a
        // sentinel user id (design §32.1).
        expect(expireRows).toHaveLength(1);
        expect(expireRows[0].actorType).toBe("SYSTEM");
        expect(expireRows[0].actorUserId).toBeNull();
        expect(expireRows[0].organizerId).toBe(orgA.id);
        expect(expireRows[0].reason).toBe("RESERVATION_TTL_ELAPSED");

        // Re-running the batch is a no-op, so it must not append a second row.
        await expireDueReservations({
            now: new Date(Date.now() + 2 * 60 * 60 * 1000),
            batchSize: 500,
        });

        expect(
            await prisma.adminAuditLog.count({
                where: {
                    action: "order.expire",
                    entityRef: expired.payload.orderNumber,
                },
            })
        ).toBe(1);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. Failure safety & idempotency
// ─────────────────────────────────────────────────────────────────────────────

describe("H. failure safety and idempotency", () => {
    test("repeating a request with the same Idempotency-Key returns the same order and reserves once", async () => {
        const actor = await customerScope(buyerA.id);
        const before = await counters(typeA.id);
        const key = `idem-replay-${SUFFIX}`;

        const first = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 2 }] }),
            actor,
            idempotencyKey: key,
        });

        const second = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 2 }] }),
            actor,
            idempotencyKey: key,
        });

        expect(first.replayed).toBe(false);
        expect(second.replayed).toBe(true);
        expect(second.payload.orderNumber).toBe(first.payload.orderNumber);

        const after = await counters(typeA.id);

        // Exactly ONE hold, not two.
        expect(after.reserved).toBe(before.reserved + 2);

        const orderCount = await prisma.eventOrder.count({
            where: { orderNumber: first.payload.orderNumber },
        });

        expect(orderCount).toBe(1);
    });

    test("the same key with a different body is a conflict, not a silent second order", async () => {
        const actor = await customerScope(buyerA.id);
        const key = `idem-mismatch-${SUFFIX}`;

        await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor,
            idempotencyKey: key,
        });

        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({ items: [{ ticketTypeId: typeA.id, quantity: 3 }] }),
                actor,
                idempotencyKey: key,
            })
        );

        expect(error.code).toBe(ERROR_CODES.CONFLICT);
        expect(error.details?.reason).toBe(
            "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST"
        );
    });

    test("a different customer using the same key string is unaffected (scope is per user)", async () => {
        const key = `idem-cross-user-${SUFFIX}`;

        const actorA = await customerScope(buyerA.id);
        const actorB = await customerScope(buyerB.id);

        const a = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor: actorA,
            idempotencyKey: key,
        });

        const b = await createTicketOrder({
            request: request({ items: [{ ticketTypeId: typeA.id, quantity: 1 }] }),
            actor: actorB,
            idempotencyKey: key,
        });

        expect(b.replayed).toBe(false);
        expect(b.payload.orderNumber).not.toBe(a.payload.orderNumber);
    });

    test("a failed line leaves NO other line reserved and no order behind", async () => {
        const actor = await customerScope(buyerA.id);
        const before = await counters(typeA.id);

        const ordersBefore = await prisma.eventOrder.count({
            where: { eventId: eventA.id },
        });

        // Line 1 is purchasable; line 2 is sold out. The whole request must fail.
        const error = await expectRejection(() =>
            createTicketOrder({
                request: request({
                    items: [
                        { ticketTypeId: typeA.id, quantity: 2 },
                        { ticketTypeId: typeSoldOut.id, quantity: 1 },
                    ],
                }),
                actor,
                idempotencyKey: `partial-failure-${SUFFIX}`,
            })
        );

        expect(error.code).toBe(ERROR_CODES.SOLD_OUT);

        const after = await counters(typeA.id);
        expect(after.reserved).toBe(before.reserved);
        expect(after.sold).toBe(before.sold);

        const ordersAfter = await prisma.eventOrder.count({
            where: { eventId: eventA.id },
        });

        expect(ordersAfter).toBe(ordersBefore);
    });

    test("no reservation ever exists without an owning order (no stranded hold)", async () => {
        const actor = await customerScope(buyerA.id);

        await createTicketOrder({
            request: request({
                items: [
                    { ticketTypeId: typeA.id, quantity: 1 },
                    { ticketTypeId: typeMin.id, quantity: 2 },
                ],
            }),
            actor,
            idempotencyKey: `stranded-check-${SUFFIX}`,
        });

        // Every reservation for this event has a real, PENDING_PAYMENT parent.
        const orphans = await prisma.ticketReservation.findMany({
            where: { eventId: eventA.id, status: "HELD" },
            select: { orderId: true, quantity: true },
        });

        expect(orphans.length).toBeGreaterThan(0);

        for (const reservation of orphans) {
            const parent = await prisma.eventOrder.findUnique({
                where: { id: reservation.orderId },
                select: { status: true },
            });

            expect(parent).not.toBeNull();
            expect(parent?.status).toBe("PENDING_PAYMENT");
        }
    });

    test("the sum of HELD reservations plus sold never exceeds quota", async () => {
        const types = await prisma.ticketType.findMany({
            where: { eventId: eventA.id },
            select: { id: true, quota: true, sold: true, reserved: true },
        });

        expect(types.length).toBeGreaterThan(0);

        for (const type of types) {
            expect(type.sold).toBeGreaterThanOrEqual(0);
            expect(type.reserved).toBeGreaterThanOrEqual(0);
            expect(type.sold + type.reserved).toBeLessThanOrEqual(type.quota);

            const heldQuantity = await prisma.ticketReservation.aggregate({
                where: { ticketTypeId: type.id, status: "HELD" },
                _sum: { quantity: true },
            });

            expect(heldQuantity._sum.quantity ?? 0).toBe(type.reserved);
        }
    });

    test("no payment provider was invoked and no ticket was issued", async () => {
        const order = await prisma.eventOrder.findFirstOrThrow({
            where: { eventId: eventA.id },
            select: { id: true, paymentStatus: true },
        });

        const payments = await prisma.payment.count({ where: { orderId: order.id } });
        const issued = await prisma.ticket.count({ where: { orderId: order.id } });

        expect(payments).toBe(0);
        expect(issued).toBe(0);
        expect(order.paymentStatus).toBe("UNPAID");
    });
});
