/**
 * ==========================================
 * PHASE 15 — JOB RUNNER (lease + tick + route)
 * ==========================================
 *
 * Three layers, all against real state where state is involved:
 *
 *   1. the DB lease — claim, refuse an active lease, take over a stale one, release;
 *   2. the tick — two jobs, one shared `now`, per-job isolation, and the EXISTING
 *      reservation reaper actually expiring a real due reservation in MariaDB;
 *   3. the route — machine authentication by a constant-time shared secret.
 *
 * The two job MODULES are wrapped here so a failure can be injected without breaking the
 * real implementation: the wrapper delegates to the real function unless a test overrides it.
 */

jest.mock("@/lib/events/lifecycle", () => {
    const actual = jest.requireActual("@/lib/events/lifecycle");

    return {
        ...actual,
        advanceEventLifecycleBatch: jest.fn(actual.advanceEventLifecycleBatch),
    };
});

jest.mock("@/lib/ticketing/reservations", () => {
    const actual = jest.requireActual("@/lib/ticketing/reservations");

    return {
        ...actual,
        expireDueReservations: jest.fn(actual.expireDueReservations),
    };
});

import { prisma } from "@/lib/prisma";
import { advanceEventLifecycleBatch } from "@/lib/events/lifecycle";
import { expireDueReservations } from "@/lib/ticketing/reservations";
import {
    acquireJobLock,
    JOB_LEASE_MS,
    JOB_NAMES,
    readJobLocks,
    releaseJobLock,
} from "@/lib/jobs/lock";
import { runJobsTick } from "@/lib/jobs/tick";
import { POST } from "@/app/api/internal/jobs/tick/route";

const lifecycleMock = advanceEventLifecycleBatch as unknown as jest.Mock;
const reaperMock = expireDueReservations as unknown as jest.Mock;

jest.setTimeout(120_000);

const SUFFIX = `p15j-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SECRET = `secret-${SUFFIX}`;

let owner: { id: string };
let org: { id: string };
let sport: { id: string };

beforeAll(async () => {
    owner = await prisma.user.create({
        data: {
            name: `Jobs Owner ${SUFFIX}`,
            email: `jobs-owner-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `Jobs Org ${SUFFIX}`,
            slug: `jobs-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sport = await prisma.sport.create({
        data: {
            name: `Jobs Sport ${SUFFIX}`,
            slug: `jobs-sport-${SUFFIX}`,
        },
        select: { id: true },
    });

    // Start from a known lease state so "first run" behaviour is deterministic.
    await prisma.jobLock.deleteMany({
        where: { name: { in: [JOB_NAMES.EVENT_LIFECYCLE, JOB_NAMES.RESERVATION_REAPER] } },
    });
});

afterAll(async () => {
    const eventIds = (
        await prisma.event.findMany({
            where: { organizerId: org.id },
            select: { id: true },
        })
    ).map((row) => row.id);

    if (eventIds.length > 0) {
        await prisma.ticketReservation.deleteMany({
            where: { eventId: { in: eventIds } },
        });
        await prisma.ticket.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.eventOrder.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.ticketType.deleteMany({ where: { eventId: { in: eventIds } } });
        await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    }

    await prisma.jobLock.deleteMany({
        where: { name: { in: [JOB_NAMES.EVENT_LIFECYCLE, JOB_NAMES.RESERVATION_REAPER] } },
    });
    await prisma.adminAuditLog.deleteMany({ where: { actorUserId: owner.id } });
    await prisma.organizerMember.deleteMany({ where: { userId: owner.id } });
    await prisma.organizer.deleteMany({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: owner.id } });
    await prisma.sport.deleteMany({ where: { id: sport.id } });
});

/** A published event with one active ticket type, for reservation fixtures. */
async function seedEventWithType(tag: string) {
    const event = await prisma.event.create({
        data: {
            organizerId: org.id,
            sportId: sport.id,
            title: `Jobs Event ${tag} ${SUFFIX}`,
            slug: `jobs-event-${tag}-${SUFFIX}`,
            eventCode: `TKL-EVT-J-${tag}-${SUFFIX}`.slice(0, 40),
            startAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
            status: "PUBLISHED",
            publishedAt: new Date(),
            createdByUserId: owner.id,
        },
        select: { id: true },
    });

    const ticketType = await prisma.ticketType.create({
        data: {
            eventId: event.id,
            name: `Jobs Type ${tag}`,
            price: 100_000,
            quota: 10,
            reserved: 1,
        },
        select: { id: true },
    });

    return { event, ticketType };
}

/** A `PENDING_PAYMENT` order holding ONE already-due reservation. */
async function seedDueReservation(tag: string) {
    const { event, ticketType } = await seedEventWithType(tag);

    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `EVT-JOBS-${tag}-${SUFFIX}`,
            organizerId: org.id,
            eventId: event.id,
            userId: owner.id,
            buyerName: `Jobs Buyer ${SUFFIX}`,
            subtotal: 100_000,
            total: 100_000,
            organizerNetAmount: 100_000,
            status: "PENDING_PAYMENT",
        },
        select: { id: true, orderNumber: true },
    });

    await prisma.ticketReservation.create({
        data: {
            orderId: order.id,
            ticketTypeId: ticketType.id,
            eventId: event.id,
            quantity: 1,
            status: "HELD",
            expiresAt: new Date(Date.now() - 60 * 60_000),
        },
    });

    return { order, event, ticketType };
}

beforeEach(() => {
    lifecycleMock.mockClear();
    reaperMock.mockClear();
});

/* ==============================================================
 * THE LEASE
 * ============================================================== */

describe("P15-E. the job lease is DB-backed and single-flight", () => {
    test("first claim wins, a second concurrent claim is refused", async () => {
        await prisma.jobLock.deleteMany({
            where: { name: JOB_NAMES.EVENT_LIFECYCLE },
        });

        const now = new Date();

        expect(
            await acquireJobLock(JOB_NAMES.EVENT_LIFECYCLE, {
                now,
                lockedBy: "a",
            })
        ).toBe(true);

        // The lease is ACTIVE, so a concurrent invocation cannot take it.
        expect(
            await acquireJobLock(JOB_NAMES.EVENT_LIFECYCLE, {
                now,
                lockedBy: "b",
            })
        ).toBe(false);

        const rows = await readJobLocks();
        const row = rows.find((r) => r.name === JOB_NAMES.EVENT_LIFECYCLE);

        expect(row?.lockedBy).toBe("a");
        expect(row?.lockedUntil?.getTime()).toBe(now.getTime() + JOB_LEASE_MS);

        await releaseJobLock(JOB_NAMES.EVENT_LIFECYCLE, { now, status: "OK" });
    });

    test("a stale lease is taken over without operator action", async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 10 * 60_000);

        // Simulate a crashed run: a lease whose deadline has already passed.
        await releaseJobLock(JOB_NAMES.RESERVATION_REAPER, {
            now: past,
            status: "FAILED",
        });
        await acquireJobLock(JOB_NAMES.RESERVATION_REAPER, {
            now: past,
            lockedBy: "crashed",
        });

        expect(
            await acquireJobLock(JOB_NAMES.RESERVATION_REAPER, {
                now,
                lockedBy: "recovered",
            })
        ).toBe(true);

        const row = (await readJobLocks()).find(
            (r) => r.name === JOB_NAMES.RESERVATION_REAPER
        );

        expect(row?.lockedBy).toBe("recovered");

        await releaseJobLock(JOB_NAMES.RESERVATION_REAPER, { now, status: "OK" });
    });

    test("release records the run and frees the lease", async () => {
        const now = new Date();

        await releaseJobLock(JOB_NAMES.EVENT_LIFECYCLE, { now, status: "OK" });

        const row = (await readJobLocks()).find(
            (r) => r.name === JOB_NAMES.EVENT_LIFECYCLE
        );

        expect(row?.lockedUntil).toBeNull();
        expect(row?.lockedBy).toBeNull();
        expect(row?.lastRunAt?.getTime()).toBe(now.getTime());
        expect(row?.lastStatus).toBe("OK");
    });

    test("only the two declared jobs exist", () => {
        expect(Object.values(JOB_NAMES).sort()).toEqual([
            "event-lifecycle",
            "reservation-reaper",
        ]);
    });
});

/* ==============================================================
 * THE TICK
 * ============================================================== */

describe("P15-F. runJobsTick runs both jobs with one instant", () => {
    test("both jobs receive the SAME now, and the result is structured per job", async () => {
        const now = new Date("2026-09-19T12:00:00.000Z");

        const result = await runJobsTick({ now });

        expect(result.now).toBe(now.toISOString());
        expect(result.ok).toBe(true);
        expect(result.jobs.eventLifecycle.job).toBe("event-lifecycle");
        expect(result.jobs.reservationExpiry.job).toBe("reservation-reaper");

        // One instant for the whole tick: no boundary can be straddled mid-run.
        expect(lifecycleMock).toHaveBeenCalledTimes(1);
        expect(reaperMock).toHaveBeenCalledTimes(1);
        expect(lifecycleMock.mock.calls[0][0].now.toISOString()).toBe(
            now.toISOString()
        );
        expect(reaperMock.mock.calls[0][0].now.toISOString()).toBe(
            now.toISOString()
        );

        // Batch ceilings are bounded (P14-D10).
        expect(lifecycleMock.mock.calls[0][0].batchSize).toBe(200);
        expect(reaperMock.mock.calls[0][0].batchSize).toBe(100);
    });

    test("JOB 2 is the EXISTING reaper: a real due reservation is expired", async () => {
        const { order, ticketType } = await seedDueReservation("reap");

        const result = await runJobsTick({ now: new Date() });

        expect(result.jobs.reservationExpiry.ran).toBe(true);
        expect(result.jobs.reservationExpiry.ok).toBe(true);
        expect(result.jobs.reservationExpiry.ordersExpired).toBeGreaterThanOrEqual(1);
        expect(result.jobs.reservationExpiry.reservationsExpired).toBeGreaterThanOrEqual(
            1
        );

        const freshOrder = await prisma.eventOrder.findUniqueOrThrow({
            where: { id: order.id },
            select: { status: true },
        });
        const freshType = await prisma.ticketType.findUniqueOrThrow({
            where: { id: ticketType.id },
            select: { reserved: true, sold: true },
        });
        const reservation = await prisma.ticketReservation.findFirstOrThrow({
            where: { orderId: order.id },
            select: { status: true },
        });

        expect(freshOrder.status).toBe("EXPIRED");
        expect(reservation.status).toBe("EXPIRED");
        // Seats came back and nothing was sold.
        expect(freshType.reserved).toBe(0);
        expect(freshType.sold).toBe(0);
    });

    test("a second tick is a no-op (idempotent, lease released each time)", async () => {
        const first = await runJobsTick({ now: new Date() });
        const second = await runJobsTick({ now: new Date() });

        expect(first.jobs.reservationExpiry.ok).toBe(true);
        expect(second.jobs.reservationExpiry.ordersExpired).toBe(0);
        expect(second.jobs.reservationExpiry.reservationsExpired).toBe(0);

        // The lease is free after every run, so the next minute's cron is never blocked.
        const rows = await readJobLocks();

        expect(rows.every((row) => row.lockedUntil === null)).toBe(true);
        expect(rows.map((row) => row.lastStatus)).toContain("OK");
    });

    test("a JOB 1 failure does NOT prevent JOB 2 (isolation)", async () => {
        lifecycleMock.mockImplementationOnce(() =>
            Promise.reject(new Error("lifecycle exploded"))
        );

        const result = await runJobsTick({ now: new Date() });

        expect(result.ok).toBe(false);
        expect(result.jobs.eventLifecycle.ok).toBe(false);
        expect(result.jobs.eventLifecycle.error).toContain("lifecycle exploded");

        // The other job still ran and reported real work.
        expect(result.jobs.reservationExpiry.ran).toBe(true);
        expect(result.jobs.reservationExpiry.ok).toBe(true);
        expect(reaperMock).toHaveBeenCalledTimes(1);

        // …and the failure is visible on the lease row.
        const row = (await readJobLocks()).find(
            (r) => r.name === JOB_NAMES.EVENT_LIFECYCLE
        );

        expect(row?.lastStatus).toBe("FAILED");
        expect(row?.lockedUntil).toBeNull();
    });

    test("a JOB 2 failure does NOT prevent JOB 1 (isolation)", async () => {
        reaperMock.mockImplementationOnce(() =>
            Promise.reject(new Error("reaper exploded"))
        );

        const result = await runJobsTick({ now: new Date() });

        expect(result.ok).toBe(false);
        expect(result.jobs.reservationExpiry.ok).toBe(false);
        expect(result.jobs.reservationExpiry.error).toContain("reaper exploded");

        expect(result.jobs.eventLifecycle.ran).toBe(true);
        expect(result.jobs.eventLifecycle.ok).toBe(true);
        expect(lifecycleMock).toHaveBeenCalledTimes(1);

        const row = (await readJobLocks()).find(
            (r) => r.name === JOB_NAMES.RESERVATION_REAPER
        );

        expect(row?.lastStatus).toBe("FAILED");
    });

    test("a held lease makes a job SKIP rather than duplicate work", async () => {
        const now = new Date();

        // Hold the lifecycle lease as if a slow run were still in progress.
        await prisma.jobLock.deleteMany({
            where: { name: JOB_NAMES.EVENT_LIFECYCLE },
        });
        await acquireJobLock(JOB_NAMES.EVENT_LIFECYCLE, { now, lockedBy: "slow-run" });

        const result = await runJobsTick({ now });

        expect(result.jobs.eventLifecycle.ran).toBe(false);
        // A skip is not a failure: the tick is still healthy.
        expect(result.jobs.eventLifecycle.ok).toBe(true);
        expect(result.ok).toBe(true);
        // The real batch was never called.
        expect(lifecycleMock).not.toHaveBeenCalled();

        // The other job proceeded normally.
        expect(result.jobs.reservationExpiry.ran).toBe(true);

        await prisma.jobLock.deleteMany({
            where: { name: JOB_NAMES.EVENT_LIFECYCLE },
        });
    });
});

/* ==============================================================
 * THE ROUTE
 * ============================================================== */

describe("P15-G. POST /api/internal/jobs/tick is machine-authenticated", () => {
    const original = process.env.JOBS_TICK_SECRET;

    afterAll(() => {
        if (original === undefined) {
            delete process.env.JOBS_TICK_SECRET;
        } else {
            process.env.JOBS_TICK_SECRET = original;
        }
    });

    function tickRequest(headers: Record<string, string> = {}): Request {
        return new Request("https://tinggalklik.test/api/internal/jobs/tick", {
            method: "POST",
            headers,
        });
    }

    test("fails closed when no secret is configured", async () => {
        delete process.env.JOBS_TICK_SECRET;

        const response = await POST(tickRequest({ authorization: `Bearer ${SECRET}` }));

        expect(response.status).toBe(401);
        // An unconfigured deployment never even reveals whether a secret was expected.
        expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    });

    test("refuses a missing, malformed or wrong secret with an identical 401", async () => {
        process.env.JOBS_TICK_SECRET = SECRET;

        const candidates: Record<string, string>[] = [
            {},
            { authorization: SECRET },
            { authorization: "Bearer" },
            { authorization: "Bearer " },
            { authorization: "Bearer wrong-secret" },
            { authorization: `Basic ${SECRET}` },
        ];

        for (const headers of candidates) {
            const response = await POST(tickRequest(headers));

            expect(response.status).toBe(401);

            const body = (await response.json()) as Record<string, unknown>;

            expect(body.code).toBe("UNAUTHORIZED");
            // No oracle: the refusal never echoes the presented value.
            expect(JSON.stringify(body)).not.toContain(SECRET);
        }
    });

    test("runs both jobs with the correct secret and leaks no configuration", async () => {
        process.env.JOBS_TICK_SECRET = SECRET;

        const response = await POST(
            tickRequest({ authorization: `Bearer ${SECRET}` })
        );

        expect(response.status).toBe(200);

        const body = (await response.json()) as {
            success: boolean;
            ok: boolean;
            jobs: Record<string, unknown>;
        };

        expect(body.success).toBe(true);
        expect(body.ok).toBe(true);
        expect(Object.keys(body.jobs).sort()).toEqual([
            "eventLifecycle",
            "reservationExpiry",
        ]);

        const serialised = JSON.stringify(body);

        expect(serialised).not.toContain(SECRET);
        expect(serialised).not.toContain("JOBS_TICK_SECRET");
    });

    test("the route is classified in the proxy as a machine-authenticated pass-through", () => {
        const { readFileSync } = require("fs") as typeof import("fs");
        const proxy = readFileSync("proxy.ts", "utf-8");

        // The proxy cannot authenticate a cron, so the route is a pass-through there and the
        // handler's secret is the control. What must NOT happen is the route being listed as
        // session-protected, which would make it unusable by its only legitimate caller.
        expect(proxy).toContain('"/api/internal/"');

        const protectedBlock = proxy.slice(proxy.indexOf("PROTECTED_API_PREFIXES"));

        expect(protectedBlock).not.toContain("/api/internal/");
    });
});

describe("P20B-D1. the deployment contract is documented (D-I19-03 = A)", () => {
    /**
     * PHASE 20A §11 established that the application side of the scheduler was already
     * complete — the route, the secret, the lease and both idempotent jobs — while NOTHING in
     * the repository proved a scheduler was calling it. The owner's Option A is VPS cron, so
     * Phase 20B's deliverable for this decision is the deployment contract itself: an operator
     * must be able to install the schedule from the repository alone.
     *
     * These assertions are deliberately about DOCUMENTATION. They cannot prove cron is
     * installed on a host (no test can), which is why §1 of the README states plainly that
     * neither background behaviour runs without it.
     */
    const { readFileSync } = require("fs") as typeof import("fs");

    test("README documents the endpoint, the secret, the schedule and how to verify a run", () => {
        const readme = readFileSync("README.md", "utf-8");

        expect(readme).toContain("POST /api/internal/jobs/tick");
        expect(readme).toContain("JOBS_TICK_SECRET");
        // The exact cron invocation, so the schedule can be copied without interpretation.
        expect(readme).toContain("* * * * * curl -fsS -X POST");
        // …and the only way to tell whether it ran, since there is no UI for the lease.
        expect(readme).toContain("SELECT name, lastRunAt, lastStatus, lockedUntil FROM joblock");
        // The two behaviours that are inert without the schedule are named.
        expect(readme).toContain("reservation");
        expect(readme).toContain("lifecycle");
    });

    test("README no longer recommends a deployment where the cron cannot exist", () => {
        const readme = readFileSync("README.md", "utf-8");

        // Phase 20A §11.2 recorded the contradiction: the README's only deployment guidance
        // was "Deploy on Vercel", while the scheduler requires a host with crontab. The
        // section is replaced with the real contract rather than left to mislead.
        expect(readme).not.toContain("Deploy on Vercel");
        expect(readme).toContain("VPS cron");
        expect(readme).toContain("systemd timer");
    });

    test(".env.example still carries the secret and the example schedule", () => {
        const env = readFileSync(".env.example", "utf-8");

        expect(env).toContain("JOBS_TICK_SECRET");
        expect(env).toContain("/api/internal/jobs/tick");
        expect(env).toContain("openssl rand -hex 32");
    });
});
