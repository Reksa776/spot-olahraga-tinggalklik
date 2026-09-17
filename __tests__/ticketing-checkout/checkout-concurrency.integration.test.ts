/**
 * ==========================================
 * PHASE 6 — CONCURRENCY (REAL INNODB)
 * ==========================================
 *
 * Brief §29: "This phase MUST preserve Phase 5's real InnoDB concurrency testing style.
 * Do NOT replace real concurrency tests with mocks." So every race below is `Promise.all`
 * against the live MySQL InnoDB database, and every assertion reads the counters back out
 * of the `tickettype` row — never a value a service reported about itself.
 *
 * The headline case is the design's own §11.6 scenario: 100 buyers racing for 50 seats
 * **through the Phase 6 reservation flow** (the gate, the conditional UPDATE, the order
 * row and the reservation row), not just through the bare primitive Phase 5 already
 * proved. That distinction matters: a checkout wraps the CAS in a longer transaction, so
 * a seat could be lost to a rollback, doubled by a retry, or stranded by an ordering bug
 * that the isolated primitive would never show.
 *
 * Expected invariant, from the brief:
 *   successful reservations = 50
 *   sold   = 0
 *   reserved = 50
 *   oversell = 0
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { ERROR_CODES } from "@/lib/api/errors";
import { resolveAuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createEvent, publishEvent } from "@/lib/events/service";
import { requireOrganizerAccess } from "@/lib/authz";
import { createTicketType } from "@/lib/ticket-types/service";
import { createTicketOrder } from "@/lib/ticketing/checkout";
import { cancelOwnPendingOrder } from "@/lib/ticketing/orders";
import { expireDueReservations } from "@/lib/ticketing/reservations";
import {
    confirmReservation,
    releaseReservation,
    reserveQuota,
} from "@/lib/ticketing/inventory";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(600_000);

const SUFFIX = `p6c-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const PRICE = "100000.00";
const SEATS = 50;
const BUYERS = 100;

let owner: { id: string };
let org: { id: string };
let sportId: string;
let event: { id: string; slug: string };
let typeRace: { id: string };

const buyerIds: string[] = [];

function signInAs(userId: string): void {
    auth.mockResolvedValue({
        user: { id: userId, email: `${userId}@${SUFFIX}.test`, name: "Test" },
        expires: new Date(Date.now() + 60_000).toISOString(),
    });
}

async function customerScope(userId: string) {
    signInAs(userId);

    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`Fixture error: no authz scope for ${userId}`);
    }

    return scope;
}

async function organizerScope() {
    signInAs(owner.id);
    return requireOrganizerAccess(org.id, "event.read");
}

async function counters(ticketTypeId: string) {
    return prisma.ticketType.findUniqueOrThrow({
        where: { id: ticketTypeId },
        select: { quota: true, sold: true, reserved: true, version: true },
    });
}

function request(eventId: string, ticketTypeId: string, quantity = 1) {
    return {
        eventId,
        items: [{ ticketTypeId, quantity }],
        buyerName: "Race Buyer",
        buyerEmail: `race-${SUFFIX}@example.test`,
        buyerPhone: "081234567890",
    } as never;
}

beforeAll(async () => {
    owner = await prisma.user.create({
        data: {
            name: `Race Owner ${SUFFIX}`,
            email: `race-owner-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `P6C Org ${SUFFIX}`,
            slug: `p6c-org-${SUFFIX}`,
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

    // 100 distinct buyers, because idempotency is scoped to (userId, scope, key) — one
    // buyer firing 100 requests would be a different (and less faithful) test.
    const created = await prisma.$transaction(
        Array.from({ length: BUYERS }, (_, i) =>
            prisma.user.create({
                data: {
                    name: `Race Buyer ${i} ${SUFFIX}`,
                    email: `race-buyer-${i}-${SUFFIX}@example.test`,
                    role: "CUSTOMER",
                },
                select: { id: true },
            })
        )
    );

    buyerIds.push(...created.map((u) => u.id));

    sportId = (
        await prisma.sport.create({
            data: { name: `P6C Sport ${SUFFIX}`, slug: `p6c-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    const scope = await organizerScope();

    event = await createEvent(
        scope,
        org.id,
        { title: `P6C Event ${SUFFIX}`, sportId, startAt: FUTURE } as never
    );

    typeRace = await createTicketType(await organizerScope(), event.id, {
        name: "Race",
        price: PRICE,
        quota: SEATS,
    } as never);

    await publishEvent(await organizerScope(), event.id);
});

afterAll(async () => {
    await prisma.ticketReservation.deleteMany({ where: { eventId: event.id } });
    await prisma.eventOrderItem.deleteMany({
        where: { order: { eventId: event.id } },
    });
    await prisma.idempotencyKey.deleteMany({ where: { userId: { in: buyerIds } } });
    await prisma.eventOrder.deleteMany({ where: { eventId: event.id } });
    await prisma.ticketType.deleteMany({ where: { eventId: event.id } });
    await prisma.event.deleteMany({ where: { id: event.id } });

    // The 100 racing buyers each wrote an order.create audit row, and the expiry race
    // wrote a SYSTEM order.expire row. Test audit rows are residue too.
    //
    // `owner.id` is in the filter because the ticket-type FIXTURES are created through the
    // Phase 5 service as the organizer, so each one writes a `ticket_type.create` row
    // under the OWNER's id — not the buyers'. Omitting it left 5 rows behind per run.
    await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: [...buyerIds, owner.id] } },
    });
    await prisma.adminAuditLog.deleteMany({
        where: { AND: [{ action: "order.expire" }, { actorType: "SYSTEM" }] },
    });
    await prisma.organizerMember.deleteMany({ where: { organizerId: org.id } });
    await prisma.organizer.deleteMany({ where: { id: org.id } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.user.deleteMany({ where: { email: { contains: SUFFIX } } });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. The headline race: 100 buyers, 50 seats
// ─────────────────────────────────────────────────────────────────────────────

describe("E. 100 buyers race for 50 seats through the Phase 6 reservation flow", () => {
    const succeeded: string[] = [];
    const rejected: string[] = [];

    beforeAll(async () => {
        const scopes = [];

        for (const buyerId of buyerIds) {
            scopes.push(await customerScope(buyerId));
        }

        // Signed in once more as an organizer, then hand the pre-resolved scopes to the
        // races. Each call re-reads the session, so re-sign as the matching buyer inside
        // the thunk — the guard derives the actor from the live session by design.
        const results = await Promise.all(
            scopes.map(async (scope, index) => {
                signInAs(buyerIds[index]);

                try {
                    const outcome = await createTicketOrder({
                        request: request(event.id, typeRace.id, 1),
                        actor: scope,
                        idempotencyKey: `race-${index}-${SUFFIX}`,
                    });

                    return { ok: true as const, orderNumber: outcome.payload.orderNumber };
                } catch (error) {
                    return {
                        ok: false as const,
                        code: (error as { code?: string }).code ?? "UNKNOWN",
                    };
                }
            })
        );

        for (const result of results) {
            if (result.ok) {
                succeeded.push(result.orderNumber);
            } else {
                rejected.push(result.code);
            }
        }
    });

    test("exactly 50 of the 100 requests succeeded", () => {
        expect(succeeded).toHaveLength(SEATS);
    });

    test("the 50 losers failed for a legitimate reason", () => {
        expect(rejected).toHaveLength(BUYERS - SEATS);

        const tally = rejected.reduce<Record<string, number>>((acc, code) => {
            acc[code] = (acc[code] ?? 0) + 1;
            return acc;
        }, {});

        // Every rejection must be "no seats left" — never an internal error, never a
        // contention artefact, and never a silent success. Asserting the exact tally
        // (rather than merely "one of the allowed codes") is what makes a spurious
        // CONTENTION regression visible instead of tolerated.
        expect(tally).toEqual({ [ERROR_CODES.SOLD_OUT]: BUYERS - SEATS });
    });

    test("reserved = 50 and sold = 0 — nothing was oversold and nothing was sold", async () => {
        const row = await counters(typeRace.id);

        expect(row.quota).toBe(SEATS);
        expect(row.reserved).toBe(SEATS);
        expect(row.sold).toBe(0);
        expect(row.reserved + row.sold).toBeLessThanOrEqual(row.quota);
    });

    test("there are exactly 50 HELD reservations summing to 50 seats", async () => {
        const held = await prisma.ticketReservation.findMany({
            where: { ticketTypeId: typeRace.id, status: "HELD" },
            select: { quantity: true, orderId: true },
        });

        expect(held).toHaveLength(SEATS);
        expect(held.reduce((sum, r) => sum + r.quantity, 0)).toBe(SEATS);

        // …and 50 distinct owning orders, one hold each.
        expect(new Set(held.map((r) => r.orderId)).size).toBe(SEATS);
    });

    test("exactly 50 orders exist, all PENDING_PAYMENT with no payment row", async () => {
        const orders = await prisma.eventOrder.findMany({
            where: { eventId: event.id },
            select: { id: true, status: true, paymentStatus: true, total: true },
        });

        expect(orders).toHaveLength(SEATS);

        for (const order of orders) {
            expect(order.status).toBe("PENDING_PAYMENT");
            expect(order.paymentStatus).toBe("UNPAID");
            expect(order.total.toString()).toBe("100000");
        }

        const payments = await prisma.payment.count({
            where: { orderId: { in: orders.map((o) => o.id) } },
        });

        expect(payments).toBe(0);
    });

    test("the row version moved once per successful reservation and never for a loser", async () => {
        // `version` is bumped by the CAS only when the UPDATE matches. 50 successes must
        // therefore have produced 50 increments and no more — a loser that still wrote
        // would show up here even if the counters happened to look right.
        const row = await counters(typeRace.id);

        expect(row.version).toBe(SEATS);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reservation transition races
// ─────────────────────────────────────────────────────────────────────────────

describe("E. reservation transition races keep the counters honest", () => {
    test("concurrent cancellations of one order release its seats exactly once", async () => {
        const buyerId = buyerIds[0];

        const buyer = await customerScope(buyerId);

        // A dedicated type so the crate-wide race numbers above stay comparable.
        const scope = await organizerScope();

        const solo = await createTicketType(scope, event.id, {
            name: "Race Solo",
            price: PRICE,
            quota: 10,
        } as never);

        const order = await createTicketOrder({
            request: request(event.id, solo.id, 3),
            actor: await customerScope(buyerId),
            idempotencyKey: `cancel-race-${SUFFIX}`,
        });

        expect(await counters(solo.id)).toMatchObject({ reserved: 3 });

        // 5 simultaneous cancels of the SAME order.
        const attempts = await Promise.all(
            Array.from({ length: 5 }, async () => {
                signInAs(buyerId);

                try {
                    await cancelOwnPendingOrder(order.payload.orderNumber, buyer);
                    return "ok";
                } catch (error) {
                    return (error as { code?: string }).code ?? "UNKNOWN";
                }
            })
        );

        const wins = attempts.filter((a) => a === "ok");

        // Exactly one transition; the rest lose the guarded CAS.
        expect(wins).toHaveLength(1);

        const row = await counters(solo.id);

        // 3 released ONCE — never twice, never negative.
        expect(row.reserved).toBe(0);
        expect(row.sold).toBe(0);
        expect(row.version).toBe(1 + 1);

        await prisma.ticketReservation.deleteMany({ where: { ticketTypeId: solo.id } });
        await prisma.eventOrderItem.deleteMany({ where: { order: { eventId: event.id } } });
        await prisma.eventOrder.deleteMany({ where: { id: order.payload.orderId } });
        await prisma.ticketType.deleteMany({ where: { id: solo.id } });
    });

    test("concurrent confirmation of one hold sells it exactly once", async () => {
        const scope = await organizerScope();

        const solo = await createTicketType(scope, event.id, {
            name: "Race Confirm",
            price: PRICE,
            quota: 10,
        } as never);

        // Reserve 4 seats directly through the canonical primitive, then race 5 confirms
        // on the same hold. Phase 6 does not confirm (that is Phase 7 settlement), so
        // this races the primitive's state guard rather than a Phase 6 entry point.
        const reserved = await reserveQuota(solo.id, 4);
        expect(reserved.ok).toBe(true);

        const confirms = await Promise.all(
            Array.from({ length: 5 }, () => confirmReservation(solo.id, 4))
        );

        const wins = confirms.filter((c) => c.ok);

        expect(wins).toHaveLength(1);

        const row = await counters(solo.id);

        expect(row.sold).toBe(4);
        expect(row.reserved).toBe(0);
        expect(row.version).toBe(2);

        // The four losers must have failed on the guard, not silently double-counted.
        for (const loser of confirms.filter((c) => !c.ok)) {
            expect((loser as { reason: string }).reason).toBe("RESERVED_UNDERFLOW");
        }

        await prisma.ticketType.deleteMany({ where: { id: solo.id } });
    });

    test("release racing confirmation releases or sells the seats exactly once", async () => {
        const scope = await organizerScope();

        const solo = await createTicketType(scope, event.id, {
            name: "Race ReleaseConfirm",
            price: PRICE,
            quota: 10,
        } as never);

        await reserveQuota(solo.id, 5);

        const [release, confirm] = await Promise.all([
            releaseReservation(solo.id, 5),
            confirmReservation(solo.id, 5),
        ]);

        const row = await counters(solo.id);

        // NOTE: `release.ok` is `true` even when it released nothing — by design. §11.2
        // specifies `SET reserved = GREATEST(0, reserved - n)`, which always matches and
        // always succeeds, and §11.4 relies on that for a safe double-run. So the
        // "exactly one winner" claim has to be read off the EFFECT (`sold`) and off
        // `confirm`'s guard, not off the two `ok` flags.
        expect(row.reserved).toBe(0);
        expect(row.reserved).toBeGreaterThanOrEqual(0);
        expect([0, 5]).toContain(row.sold);
        expect(row.sold + row.reserved).toBeLessThanOrEqual(row.quota);

        if (confirm.ok) {
            // The hold was sold; the release found nothing left to return.
            expect(row.sold).toBe(5);
        } else {
            // The release won, so the conversion found nothing to confirm.
            expect(confirm.reason).toBe("RESERVED_UNDERFLOW");
            expect(row.sold).toBe(0);
        }

        // Either way the five seats were accounted for exactly once: sold XOR released.
        expect(row.sold === 5 || row.sold === 0).toBe(true);

        await prisma.ticketType.deleteMany({ where: { id: solo.id } });
    });

    test("the expiry reaper racing a cancellation releases the seats exactly once", async () => {
        const buyerId = buyerIds[1];

        const scope = await organizerScope();

        const solo = await createTicketType(scope, event.id, {
            name: "Race ExpireCancel",
            price: PRICE,
            quota: 10,
        } as never);

        const order = await createTicketOrder({
            request: request(event.id, solo.id, 2),
            actor: await customerScope(buyerId),
            idempotencyKey: `expire-cancel-race-${SUFFIX}`,
        });

        expect(await counters(solo.id)).toMatchObject({ reserved: 2 });

        const buyer = await customerScope(buyerId);

        // The reaper sweeps "now + 1h"; the cancel races it on the same reservation.
        const [, cancelResult] = await Promise.all([
            expireDueReservations({
                now: new Date(Date.now() + 60 * 60 * 1000),
                batchSize: 500,
            }),
            (async () => {
                signInAs(buyerId);

                try {
                    await cancelOwnPendingOrder(order.payload.orderNumber, buyer);
                    return "ok";
                } catch (error) {
                    return (error as { code?: string }).code ?? "UNKNOWN";
                }
            })(),
        ]);

        // Whichever won, one of them had to lose cleanly.
        expect(["ok", ERROR_CODES.ORDER_NOT_PAYABLE]).toContain(cancelResult);

        const row = await counters(solo.id);

        // The seats came back exactly once, and never went negative.
        expect(row.reserved).toBe(0);
        expect(row.sold).toBe(0);
        expect(row.version).toBeGreaterThanOrEqual(1);

        const reservation = await prisma.ticketReservation.findFirstOrThrow({
            where: { orderId: order.payload.orderId },
            select: { status: true },
        });

        expect(["RELEASED", "EXPIRED"]).toContain(reservation.status);

        // A second sweep changes nothing.
        await expireDueReservations({
            now: new Date(Date.now() + 2 * 60 * 60 * 1000),
            batchSize: 500,
        });

        expect(await counters(solo.id)).toMatchObject({ reserved: 0, sold: 0 });

        await prisma.ticketReservation.deleteMany({ where: { ticketTypeId: solo.id } });
        await prisma.eventOrderItem.deleteMany({ where: { order: { eventId: event.id } } });
        await prisma.eventOrder.deleteMany({ where: { id: order.payload.orderId } });
        await prisma.ticketType.deleteMany({ where: { id: solo.id } });
    });
});
