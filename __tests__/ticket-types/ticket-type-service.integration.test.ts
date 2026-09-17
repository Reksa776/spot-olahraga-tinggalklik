/**
 * ==========================================
 * PHASE 5 — TICKET TYPE SERVICE (INTEGRATION)
 * ==========================================
 *
 * Runs the REAL service against the REAL database through the REAL `lib/authz` guards.
 * Only `@/auth` is mocked, so every permission decision is made from actual membership
 * rows rather than a stubbed opinion.
 *
 * Brief §22 requires coverage of CRUD, tenant isolation (including a caller-supplied
 * organizer id being unable to bypass scope), inactive membership, unauthenticated
 * access, the quota floor, and delete semantics.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { AppError } from "@/lib/api/errors";
import { AuthzErrorCode } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createEvent } from "@/lib/events/service";
import { getOrganizerEvent } from "@/lib/events/service";
import { requireAuth, requireOrganizerAccess } from "@/lib/authz";
import {
    createTicketType,
    deleteTicketType,
    getOrganizerTicketType,
    listEventTicketTypes,
    updateTicketType,
} from "@/lib/ticket-types/service";
import { reserveQuota } from "@/lib/ticketing/inventory";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const SUFFIX = `p5s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let ownerA: { id: string };
let ownerB: { id: string };
let financeA: { id: string };
let staffA: { id: string };
let suspendedA: { id: string };

let orgA: { id: string };
let orgB: { id: string };
let sportId: string;

let eventA: { id: string; slug: string };
let eventB: { id: string; slug: string };

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: { id: userId, email: `${userId}@${SUFFIX}.test`, name: "Test" },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

/**
 * Resolve an actor's scope the same way a route does, then sign them in.
 *
 * Uses the permission-checking guard, so it only works for actors who actually hold
 * `event.read`. Actors who do NOT (CHECKIN_STAFF, a suspended member) must be resolved
 * with `rawScopeFor` instead — otherwise the fixture throws before the behaviour under
 * test is ever reached, which would look like a passing test of the wrong thing.
 */
async function scopeFor(userId: string, organizerId = orgA.id) {
    signInAs(userId);

    const scope = await requireOrganizerAccess(organizerId, "event.read");

    return scope;
}

/** Sign in and resolve the raw session scope, with no permission decision applied. */
async function rawScopeFor(userId: string) {
    signInAs(userId);

    const { resolveAuthzScope } = await import("@/lib/authz");
    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`Fixture error: no authz scope for ${userId}`);
    }

    return scope;
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
 * A minimal real order, used only as the FK target for a `TicketReservation`.
 *
 * `TicketReservation.orderId` is a real foreign key, so a placeholder string cannot be
 * used — the fixture has to be a genuine row. Phase 5 does not create orders, so this
 * is inserted directly and removed in `afterAll`.
 */
async function seedOrder(tag: string) {
    return prisma.eventOrder.create({
        data: {
            orderNumber: `P5-${tag}-${SUFFIX}`.slice(0, 60),
            organizerId: orgA.id,
            eventId: eventA.id,
            userId: ownerA.id,
            buyerName: "Fixture Buyer",
            subtotal: "0.00",
            total: "0.00",
            organizerNetAmount: "0.00",
        },
        select: { id: true },
    });
}

/** Expect a thrown `AppError`/`AuthzError` and return it for assertion. */
async function expectRejection(run: () => Promise<unknown>) {
    try {
        await run();
    } catch (error) {
        return error as AppError;
    }

    throw new Error("Expected the operation to be rejected, but it succeeded");
}

beforeAll(async () => {
    ownerA = await createUser("owner-a");
    ownerB = await createUser("owner-b");
    financeA = await createUser("finance-a");
    staffA = await createUser("staff-a");
    suspendedA = await createUser("suspended-a");

    orgA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `P5 Org A ${SUFFIX}`,
            slug: `p5-org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    orgB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `P5 Org B ${SUFFIX}`,
            slug: `p5-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            { organizerId: orgA.id, userId: ownerA.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgB.id, userId: ownerB.id, role: "OWNER", status: "ACTIVE" },
            { organizerId: orgA.id, userId: financeA.id, role: "FINANCE", status: "ACTIVE" },
            {
                organizerId: orgA.id,
                userId: staffA.id,
                role: "CHECKIN_STAFF",
                status: "ACTIVE",
            },
            {
                organizerId: orgA.id,
                userId: suspendedA.id,
                role: "MANAGER",
                status: "SUSPENDED",
            },
        ],
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `P5 Sport ${SUFFIX}`, slug: `p5-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    // Events are created through the real Phase 4 service so the fixtures are
    // guaranteed to be valid for the publish precondition path.
    const scopeA = await scopeFor(ownerA.id, orgA.id);
    eventA = await createEvent(
        scopeA,
        orgA.id,
        {
            title: `P5 Event A ${SUFFIX}`,
            sportId,
            startAt: FUTURE,
        } as never
    );

    signInAs(ownerB.id);
    const scopeB = await requireOrganizerAccess(orgB.id, "event.read");
    eventB = await createEvent(
        scopeB,
        orgB.id,
        {
            title: `P5 Event B ${SUFFIX}`,
            sportId,
            startAt: FUTURE,
        } as never
    );
});

afterAll(async () => {
    const eventIds = [eventA?.id, eventB?.id].filter(Boolean) as string[];
    const organizerIds = [orgA?.id, orgB?.id].filter(Boolean) as string[];
    const userIds = [ownerA, ownerB, financeA, staffA, suspendedA]
        .filter(Boolean)
        .map((user) => user.id);

    if (eventIds.length > 0) {
        await prisma.ticketReservation.deleteMany({
            where: { eventId: { in: eventIds } },
        });
        await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.eventOrder.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }

    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.adminAuditLog.deleteMany({
        where: { actorUserId: { in: userIds } },
    });
    await prisma.organizerMember.deleteMany({
        where: { organizerId: { in: organizerIds } },
    });
    await prisma.organizer.deleteMany({ where: { id: { in: organizerIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("create", () => {
    test("an owner creates a tier; counters start at zero and price is exact", async () => {
        const scope = await scopeFor(ownerA.id);

        const created = await createTicketType(scope, eventA.id, {
            name: "Tribun",
            price: "1234567.89",
            quota: 100,
            description: "Tribun utara",
            minPerOrder: 1,
            maxPerOrder: 4,
            sortOrder: 1,
        } as never);

        expect(created.name).toBe("Tribun");
        // Exact decimal round trip — no float drift.
        expect(created.price).toBe("1234567.89");
        expect(created.currency).toBe("IDR");
        expect(created.inventory).toEqual({
            quota: 100,
            sold: 0,
            reserved: 0,
            available: 100,
            committed: 0,
        });
        expect(created.isActive).toBe(true);
        expect(created.version).toBe(0);
    });

    test("the counter columns in the database are untouched by a create", async () => {
        const scope = await scopeFor(ownerA.id);

        const created = await createTicketType(scope, eventA.id, {
            name: "Counter Check",
            price: "10000",
            quota: 5,
        } as never);

        const row = await prisma.ticketType.findUniqueOrThrow({
            where: { id: created.id },
            select: { sold: true, reserved: true, version: true },
        });

        expect(row).toEqual({ sold: 0, reserved: 0, version: 0 });
    });

    test("an explicit inactive tier is created inactive", async () => {
        const scope = await scopeFor(ownerA.id);

        const created = await createTicketType(scope, eventA.id, {
            name: "Belum dijual",
            price: "50000",
            quota: 10,
            isActive: false,
        } as never);

        expect(created.isActive).toBe(false);
    });

    test("the audit trail records the creation", async () => {
        const scope = await scopeFor(ownerA.id);

        const created = await createTicketType(scope, eventA.id, {
            name: "Audited Tier",
            price: "20000",
            quota: 3,
        } as never);

        const audit = await prisma.adminAuditLog.findFirst({
            where: { entityRef: created.id, action: "ticket_type.create" },
            orderBy: { createdAt: "desc" },
        });

        expect(audit).not.toBeNull();
        expect(audit?.entityType).toBe("TicketType");
        expect(audit?.organizerId).toBe(orgA.id);
        expect(audit?.actorUserId).toBe(ownerA.id);
    });

    test("the price is stored as a Decimal, not a float column", async () => {
        const scope = await scopeFor(ownerA.id);

        const created = await createTicketType(scope, eventA.id, {
            name: "Decimal Check",
            price: "0.07",
            quota: 1,
        } as never);

        const raw = await prisma.$queryRaw<{ price: string }[]>`
            SELECT CAST(price AS CHAR) AS price FROM tickettype WHERE id = ${created.id}
        `;

        expect(raw[0]?.price).toBe("0.07");
    });
});

describe("read", () => {
    test("a FINANCE member may read the tier list (event.read) but not write", async () => {
        const financeScope = await scopeFor(financeA.id);

        const list = await listEventTicketTypes(financeScope, eventA.id);

        expect(list.items.length).toBeGreaterThan(0);

        const rejection = await expectRejection(() =>
            createTicketType(financeScope, eventA.id, {
                name: "Not allowed",
                price: "1000",
                quota: 1,
            } as never)
        );

        // An ACTIVE member who simply lacks the capability is `FORBIDDEN` (403), not
        // `ORGANIZER_ACCESS_DENIED` (404) — the latter is reserved for "you are not in
        // this tenant at all", so the two stay distinguishable.
        expect(rejection.code).toBe(AuthzErrorCode.FORBIDDEN);
    });

    test("a CHECKIN_STAFF member is refused even the read", async () => {
        // Resolved WITHOUT a permission check, so the refusal being asserted is the
        // one from the operation under test, not from the fixture.
        const staffScope = await rawScopeFor(staffA.id);

        const rejection = await expectRejection(() =>
            listEventTicketTypes(staffScope, eventA.id)
        );

        // Member of the tenant, but `event.read` is not a CHECKIN_STAFF capability.
        expect(rejection.code).toBe(AuthzErrorCode.FORBIDDEN);
    });

    test("an unauthenticated caller is refused with UNAUTHORIZED", async () => {
        // Every ticketing route's first line. With no session it must fail before any
        // scope, membership or permission is even considered.
        signInAs(null);

        const rejection = await expectRejection(() => requireAuth());

        expect(rejection.code).toBe(AuthzErrorCode.UNAUTHORIZED);
    });

    test("the list includes inactive tiers, unlike the public payload", async () => {
        const scope = await scopeFor(ownerA.id);

        const list = await listEventTicketTypes(scope, eventA.id);

        expect(list.items.some((item) => !item.isActive)).toBe(true);
    });

    test("the list is ordered by sortOrder then creation", async () => {
        const scope = await scopeFor(ownerA.id);

        const list = await listEventTicketTypes(scope, eventA.id);
        const orders = list.items.map((item) => item.sortOrder);

        expect(orders).toEqual([...orders].sort((a, b) => a - b));
    });

    test("reading a single tier returns the authorized inventory view", async () => {
        const scope = await scopeFor(ownerA.id);

        const list = await listEventTicketTypes(scope, eventA.id);
        const one = await getOrganizerTicketType(scope, list.items[0].id);

        expect(one.id).toBe(list.items[0].id);
        expect(one.inventory.quota).toBe(list.items[0].inventory.quota);
    });
});

describe("tenant isolation", () => {
    test("organizer A cannot list organizer B's event tiers", async () => {
        const scopeA = await scopeFor(ownerA.id);

        const rejection = await expectRejection(() =>
            listEventTicketTypes(scopeA, eventB.id)
        );

        expect(rejection.code).toBe(AuthzErrorCode.ORGANIZER_ACCESS_DENIED);
    });

    test("organizer A cannot read or mutate a tier belonging to organizer B", async () => {
        // Create a tier inside B, then attack it as A.
        const scopeB = await scopeFor(ownerB.id, orgB.id);
        const bTier = await createTicketType(scopeB, eventB.id, {
            name: "B Secret Tier",
            price: "99000",
            quota: 10,
        } as never);

        const scopeA = await scopeFor(ownerA.id);

        const readRejection = await expectRejection(() =>
            getOrganizerTicketType(scopeA, bTier.id)
        );
        expect(readRejection.code).toBe(AuthzErrorCode.ORGANIZER_ACCESS_DENIED);

        const updateRejection = await expectRejection(() =>
            updateTicketType(scopeA, bTier.id, { name: "hijacked" } as never)
        );
        expect(updateRejection.code).toBe(AuthzErrorCode.ORGANIZER_ACCESS_DENIED);

        const deleteRejection = await expectRejection(() =>
            deleteTicketType(scopeA, bTier.id)
        );
        expect(deleteRejection.code).toBe(AuthzErrorCode.ORGANIZER_ACCESS_DENIED);

        // And B's row is genuinely unchanged.
        const stillThere = await prisma.ticketType.findUniqueOrThrow({
            where: { id: bTier.id },
            select: { name: true },
        });
        expect(stillThere.name).toBe("B Secret Tier");
    });

    test("naming another organizer's event in the URL cannot bypass scope", async () => {
        // The route passes an eventId from the URL; the service resolves the tenant from
        // the event row itself. So this is the "caller-supplied id is data" case.
        const scopeA = await scopeFor(ownerA.id);

        const rejection = await expectRejection(() =>
            createTicketType(scopeA, eventB.id, {
                name: "Cross tenant",
                price: "1000",
                quota: 1,
            } as never)
        );

        expect(rejection.code).toBe(AuthzErrorCode.ORGANIZER_ACCESS_DENIED);

        const leaked = await prisma.ticketType.count({
            where: { eventId: eventB.id, name: "Cross tenant" },
        });
        expect(leaked).toBe(0);
    });

    test("a suspended membership is refused", async () => {
        const suspendedScope = await rawScopeFor(suspendedA.id);

        const rejection = await expectRejection(() =>
            createTicketType(suspendedScope, eventA.id, {
                name: "Suspended",
                price: "1000",
                quota: 1,
            } as never)
        );

        // A SUSPENDED membership is not an active membership, so this is the
        // "not in this tenant" denial (404), distinct from FORBIDDEN above.
        expect(rejection.code).toBe(AuthzErrorCode.ORGANIZER_ACCESS_DENIED);
    });

    test("an unrecognized id yields NOT_FOUND, not a permission error", async () => {
        const scope = await scopeFor(ownerA.id);

        const rejection = await expectRejection(() =>
            getOrganizerTicketType(scope, `missing-${SUFFIX}`)
        );

        expect(rejection.code).toBe("NOT_FOUND");
    });
});

describe("update", () => {
    // `quota` is a NUMBER here: the service consumes the post-Zod shape (integers are
    // numbers, price is a decimal string). These tests call the service directly, so
    // the fixtures are already-parsed values rather than wire-format strings.
    async function freshTier(quota = 10, name = "Updatable") {
        const scope = await scopeFor(ownerA.id);

        return createTicketType(scope, eventA.id, {
            name: `${name} ${Math.random().toString(36).slice(2, 7)}`,
            price: "50000",
            quota,
        } as never);
    }

    test("descriptive fields update", async () => {
        const tier = await freshTier();
        const scope = await scopeFor(ownerA.id);

        const updated = await updateTicketType(scope, tier.id, {
            name: "Renamed",
            description: "new description",
            minPerOrder: 2,
            maxPerOrder: 6,
            sortOrder: 5,
        } as never);

        expect(updated.name).toBe("Renamed");
        expect(updated.description).toBe("new description");
        expect(updated.minPerOrder).toBe(2);
        expect(updated.maxPerOrder).toBe(6);
        expect(updated.sortOrder).toBe(5);
    });

    test("an empty update is refused at the service, not only at the route", async () => {
        const tier = await freshTier();
        const scope = await scopeFor(ownerA.id);

        // The route's Zod schema already refuses an empty body, but the service is a
        // public surface in its own right (server components and tests call it too), so
        // a no-op update must be refused here as well. Without the service-level guard
        // this test would silently pass while returning a 200 that changed nothing.
        const rejection = await expectRejection(() =>
            updateTicketType(scope, tier.id, {} as never)
        );

        expect(rejection.code).toBe("VALIDATION_ERROR");
    });

    test("activation and deactivation round trip", async () => {
        const tier = await freshTier();
        const scope = await scopeFor(ownerA.id);

        const off = await updateTicketType(scope, tier.id, {
            isActive: false,
        } as never);
        expect(off.isActive).toBe(false);

        const on = await updateTicketType(scope, tier.id, {
            isActive: true,
        } as never);
        expect(on.isActive).toBe(true);
    });

    test("a price change is recorded as its own audit action", async () => {
        const tier = await freshTier();
        const scope = await scopeFor(ownerA.id);

        await updateTicketType(scope, tier.id, { price: "75000" } as never);

        const audit = await prisma.adminAuditLog.findFirst({
            where: { entityRef: tier.id, action: "ticket_type.price_change" },
        });

        expect(audit).not.toBeNull();
        const after = audit?.afterState as { price?: string } | null;
        expect(after?.price).toBe("75000.00");
    });

    test("an ordinary edit does not move sold, reserved or the sale counters", async () => {
        const tier = await freshTier(10);
        const scope = await scopeFor(ownerA.id);

        // Put real inventory state in place, then rename the tier.
        expect((await reserveQuota(tier.id, 4)).ok).toBe(true);

        await updateTicketType(scope, tier.id, { name: "Renamed Mid-Sale" } as never);

        const row = await prisma.ticketType.findUniqueOrThrow({
            where: { id: tier.id },
            select: { sold: true, reserved: true },
        });

        expect(row).toEqual({ sold: 0, reserved: 4 });
    });
});

describe("quota changes respect the invariant (design §11.6)", () => {
    test("a quota increase is allowed", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Increase Me",
            price: "10000",
            quota: 10,
        } as never);

        const updated = await updateTicketType(scope, tier.id, {
            quota: 30,
        } as never);

        expect(updated.inventory.quota).toBe(30);
        expect(updated.inventory.available).toBe(30);
    });

    test("a reduction to exactly sold + reserved is allowed", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Reduce To Floor",
            price: "10000",
            quota: 100,
        } as never);

        expect((await reserveQuota(tier.id, 4)).ok).toBe(true);

        const updated = await updateTicketType(scope, tier.id, {
            quota: 4,
        } as never);

        expect(updated.inventory.quota).toBe(4);
        expect(updated.inventory.reserved).toBe(4);
        expect(updated.inventory.available).toBe(0);
    });

    test("a reduction below sold + reserved is refused with minimumQuota", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Cannot Go Below",
            price: "10000",
            quota: 10,
        } as never);

        // 8 seats committed (the brief's worked example).
        expect((await reserveQuota(tier.id, 8)).ok).toBe(true);

        const rejection = await expectRejection(() =>
            updateTicketType(scope, tier.id, { quota: 5 } as never)
        );

        expect(rejection.code).toBe("CONFLICT");
        expect(rejection.details?.minimumQuota).toBe(8);
        expect(rejection.details?.quota).toBe(10);
        expect(rejection.details?.reserved).toBe(8);

        // Nothing moved: neither quota nor the counters were silently adjusted.
        const row = await prisma.ticketType.findUniqueOrThrow({
            where: { id: tier.id },
            select: { quota: true, sold: true, reserved: true },
        });

        expect(row).toEqual({ quota: 10, sold: 0, reserved: 8 });
    });

    test("sold tickets also raise the floor", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Sold Floor",
            price: "10000",
            quota: 10,
        } as never);

        expect((await reserveQuota(tier.id, 3)).ok).toBe(true);

        // Move the hold into sold, the way a settlement would.
        await prisma.ticketType.update({
            where: { id: tier.id },
            data: { sold: 3, reserved: 0 },
        });

        const rejection = await expectRejection(() =>
            updateTicketType(scope, tier.id, { quota: 2 } as never)
        );

        expect(rejection.details?.minimumQuota).toBe(3);
    });

    test("a quota change is audited as its own action with before/after", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Audited Quota",
            price: "10000",
            quota: 10,
        } as never);

        await updateTicketType(scope, tier.id, { quota: 20 } as never);

        const audit = await prisma.adminAuditLog.findFirst({
            where: { entityRef: tier.id, action: "ticket_type.quota_change" },
        });

        expect(audit).not.toBeNull();
        expect(audit?.beforeState).toMatchObject({ quota: 10 });
        expect(audit?.afterState).toMatchObject({ quota: 20 });
    });

    test("the audit log never receives a forbidden key", async () => {
        const scope = await scopeFor(ownerA.id);

        const tier = await createTicketType(scope, eventA.id, {
            name: "No Secrets",
            price: "10000",
            quota: 1,
        } as never);

        const audits = await prisma.adminAuditLog.findMany({
            where: { entityRef: tier.id },
        });

        expect(audits.length).toBeGreaterThan(0);

        // Assert on KEYS, not on a substring of the serialised row. A substring scan
        // would match innocent values (a tier legitimately named "No Secrets" appears
        // in `description`), which is the same over-broad-scan mistake that produced
        // false positives in the Phase 4 `as any` check.
        const forbidden = [
            "password",
            "passwordhash",
            "token",
            "accesstoken",
            "refreshtoken",
            "secret",
            "apikey",
            "authorization",
            "cookie",
            "qrcode",
            "qrtoken",
            "ktp",
        ];

        for (const audit of audits) {
            for (const state of [audit.beforeState, audit.afterState]) {
                if (!state || typeof state !== "object") continue;

                for (const key of Object.keys(state as Record<string, unknown>)) {
                    expect(forbidden).not.toContain(key.toLowerCase());
                }
            }
        }
    });
});

describe("delete", () => {
    test("an unused tier deletes cleanly", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Typo Tier",
            price: "10000",
            quota: 1,
        } as never);

        const result = await deleteTicketType(scope, tier.id);
        expect(result.id).toBe(tier.id);

        const gone = await prisma.ticketType.findUnique({ where: { id: tier.id } });
        expect(gone).toBeNull();
    });

    test("a tier with held inventory cannot be deleted and points at deactivation", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Held Tier",
            price: "10000",
            quota: 10,
        } as never);

        const order = await seedOrder("held");
        const reservation = await prisma.ticketReservation.create({
            data: {
                orderId: order.id,
                ticketTypeId: tier.id,
                eventId: eventA.id,
                quantity: 2,
                status: "HELD",
                expiresAt: new Date(Date.now() + 60_000),
            },
            select: { id: true },
        });

        try {
            const rejection = await expectRejection(() =>
                deleteTicketType(scope, tier.id)
            );

            expect(rejection.code).toBe("CONFLICT");
            expect(rejection.details?.reservations).toBe(1);
            expect(rejection.details?.supportedAction).toBe("DEACTIVATE");

            // And the row really is still there — the refusal is not cosmetic.
            expect(
                await prisma.ticketType.findUnique({ where: { id: tier.id } })
            ).not.toBeNull();
        } finally {
            await prisma.ticketReservation.delete({ where: { id: reservation.id } });
            await prisma.eventOrder.delete({ where: { id: order.id } });
        }
    });

    test("deleting is still possible after the reference is gone", async () => {
        const scope = await scopeFor(ownerA.id);
        const tier = await createTicketType(scope, eventA.id, {
            name: "Freed Tier",
            price: "10000",
            quota: 1,
        } as never);

        const order = await seedOrder("freed");
        const reservation = await prisma.ticketReservation.create({
            data: {
                orderId: order.id,
                ticketTypeId: tier.id,
                eventId: eventA.id,
                quantity: 1,
                status: "HELD",
                expiresAt: new Date(Date.now() + 60_000),
            },
            select: { id: true },
        });

        await prisma.ticketReservation.delete({ where: { id: reservation.id } });
        await prisma.eventOrder.delete({ where: { id: order.id } });

        await expect(deleteTicketType(scope, tier.id)).resolves.toMatchObject({
            id: tier.id,
        });
    });
});

describe("event lifecycle is respected (brief §16)", () => {
    test("a tier cannot be created on a terminal event", async () => {
        const scope = await scopeFor(ownerA.id);

        const cancelled = await prisma.event.create({
            data: {
                organizerId: orgA.id,
                sportId,
                title: `Cancelled ${SUFFIX}`,
                slug: `cancelled-${SUFFIX}`,
                eventCode: `TKL-EVT-CAN-${SUFFIX}`.slice(0, 40),
                startAt: FUTURE,
                status: "CANCELLED",
                createdByUserId: ownerA.id,
            },
            select: { id: true },
        });

        try {
            const rejection = await expectRejection(() =>
                createTicketType(scope, cancelled.id, {
                    name: "Too Late",
                    price: "1000",
                    quota: 1,
                } as never)
            );

            expect(rejection.code).toBe("CONFLICT");
        } finally {
            await prisma.event.delete({ where: { id: cancelled.id } });
        }
    });

    test("deactivation is still permitted on a terminal event (safety valve)", async () => {
        const scope = await scopeFor(ownerA.id);

        // Archive the event AFTER creating the tier, so the state under test is "tier
        // exists on an event that has since been archived" — exactly the situation an
        // operator must be able to clean up.
        const created = await createTicketType(scope, eventA.id, {
            name: `Safety Valve ${SUFFIX}`,
            price: "1000",
            quota: 1,
        } as never);

        const archived = await prisma.event.create({
            data: {
                organizerId: orgA.id,
                sportId,
                title: `Archived ${SUFFIX}`,
                slug: `archived-${SUFFIX}`,
                eventCode: `TKL-EVT-ARC-${SUFFIX}`.slice(0, 40),
                startAt: FUTURE,
                status: "ARCHIVED",
                createdByUserId: ownerA.id,
            },
            select: { id: true },
        });

        const archivedTier = await prisma.ticketType.create({
            data: {
                eventId: archived.id,
                name: `Archived Tier ${SUFFIX}`,
                price: "1000.00",
                quota: 5,
                isActive: true,
            },
            select: { id: true },
        });

        try {
            // A non-status change on the archived event is refused...
            const rejection = await expectRejection(() =>
                updateTicketType(scope, archivedTier.id, { name: "nope" } as never)
            );
            expect(rejection.code).toBe("CONFLICT");

            // ...but retiring the inventory is not, because a cancelled/archived event
            // whose tiers are still active must remain fixable.
            const off = await updateTicketType(scope, archivedTier.id, {
                isActive: false,
            } as never);

            expect(off.isActive).toBe(false);
        } finally {
            await prisma.ticketType.delete({ where: { id: archivedTier.id } });
            await prisma.event.delete({ where: { id: archived.id } });
        }

        // The tier created on the live event is unaffected by any of it.
        expect(created.isActive).toBe(true);
    });

    test("managing a tier never changes the event's status", async () => {
        const scope = await scopeFor(ownerA.id);

        const before = await prisma.event.findUniqueOrThrow({
            where: { id: eventA.id },
            select: { status: true, publishedAt: true },
        });

        await createTicketType(scope, eventA.id, {
            name: "Status Neutral",
            price: "1000",
            quota: 1,
        } as never);

        const after = await prisma.event.findUniqueOrThrow({
            where: { id: eventA.id },
            select: { status: true, publishedAt: true },
        });

        expect(after).toEqual(before);
        expect(after.status).toBe("DRAFT");
    });
});

describe("the event read surface includes tier inventory for the organizer", () => {
    test("getOrganizerEvent exposes activeTicketTypeCount, which Phase 5 now fills", async () => {
        const scope = await scopeFor(ownerA.id);

        const event = await getOrganizerEvent(scope, eventA.id);

        expect(event.sales.activeTicketTypeCount).toBeGreaterThan(0);
    });
});
