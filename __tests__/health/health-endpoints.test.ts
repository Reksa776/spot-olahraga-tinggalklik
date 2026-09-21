/**
 * ==========================================
 * HEALTH / READINESS ENDPOINTS
 * ==========================================
 *
 * Phase 25 (BLOCK-5) found no health endpoint, so Phase 26 added two:
 *
 *   GET /api/health         liveness  — the process answers; touches NOTHING
 *   GET /api/health/ready   readiness — the database is reachable; 200 or 503
 *
 * What is pinned here is the contract an operator depends on, and in particular the three
 * properties that are easy to lose in a later refactor:
 *
 *   1. LIVENESS DOES NOT TOUCH THE DATABASE. If it did, a database outage would make a
 *      process manager restart-loop a healthy server — one fault turned into two.
 *   2. A FAILING READINESS CHECK IS 503, NOT 500. 503 is what a load balancer and a deploy
 *      script already understand, and it says "the dependency is unavailable" rather than
 *      "this code is broken".
 *   3. THE RESPONSE NEVER CARRIES THE DRIVER'S ERROR. A Prisma connection error can name the
 *      host and the port, and these endpoints are public (a probe holds no session). The
 *      detail goes to the server log, sanitised, and nowhere else.
 */

jest.mock("@/lib/prisma", () => ({
    prisma: { $queryRaw: jest.fn() },
}));

import { prisma } from "@/lib/prisma";

import { GET as liveness } from "@/app/api/health/route";
import { GET as readiness } from "@/app/api/health/ready/route";

const queryRaw = prisma.$queryRaw as unknown as jest.Mock;

/** A Prisma-shaped initialisation failure, with a host in the message — the leaky shape. */
function prismaInitError(): Error {
    const error = new Error(
        "Can't reach database server at `127.0.0.1:3306`\n\nPlease make sure your database server is running."
    );
    error.name = "PrismaClientInitializationError";
    return error;
}

beforeEach(() => {
    queryRaw.mockReset();
});

/* ==================================================================================
 * LIVENESS
 * ================================================================================== */

describe("GET /api/health — liveness", () => {
    it("answers 200 without touching the database", async () => {
        const response = await liveness();

        expect(response.status).toBe(200);
        expect(queryRaw).not.toHaveBeenCalled();
    });

    it("says only that the process is ok", async () => {
        const body = await (await liveness()).json();

        // Exactly one key. A health endpoint is public, so anything it reports is reported
        // to the internet: no version, no hostname, no environment, no build id.
        expect(body).toEqual({ status: "ok" });
        expect(Object.keys(body)).toHaveLength(1);
    });

    it("is never cached", async () => {
        // A cached "ok" would keep reporting ready after the process died.
        const response = await liveness();

        expect(response.headers.get("cache-control")).toBe("no-store");
    });
});

/* ==================================================================================
 * READINESS — the healthy path
 * ================================================================================== */

describe("GET /api/health/ready — readiness", () => {
    it("answers 200 and reports the database as ok when the ping succeeds", async () => {
        queryRaw.mockResolvedValue([{ "1": 1 }]);

        const response = await readiness();

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            status: "ready",
            checks: { database: "ok" },
        });
        expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it("is never cached", async () => {
        queryRaw.mockResolvedValue([]);

        expect((await readiness()).headers.get("cache-control")).toBe("no-store");
    });

    it("issues the cheapest possible statement, and does not write", async () => {
        queryRaw.mockResolvedValue([]);

        await readiness();

        // Called as a tagged template, so the first argument is the literal segments.
        expect(queryRaw.mock.calls[0][0].join("")).toBe("SELECT 1");
    });
});

/* ==================================================================================
 * READINESS — the failing path
 * ================================================================================== */

describe("GET /api/health/ready — a dependency is down", () => {
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
        consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        consoleError.mockRestore();
    });

    it("answers 503 (not 500) when the database cannot be reached", async () => {
        queryRaw.mockRejectedValue(prismaInitError());

        const response = await readiness();

        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({
            status: "unavailable",
            checks: { database: "error" },
        });
    });

    it("does not leak the driver's error to the client", async () => {
        queryRaw.mockRejectedValue(prismaInitError());

        const serialized = JSON.stringify(await (await readiness()).json());

        // The failure message names a host and a port. None of it may reach the response.
        expect(serialized).not.toContain("127.0.0.1");
        expect(serialized).not.toContain("3306");
        expect(serialized).not.toContain("Can't reach");
        expect(serialized).not.toContain("Prisma");
        expect(serialized).not.toContain("stack");
    });

    it("logs a sanitised diagnosis server-side", async () => {
        queryRaw.mockRejectedValue(prismaInitError());

        await readiness();

        expect(consoleError).toHaveBeenCalledTimes(1);

        const logged = String(consoleError.mock.calls[0][0]);

        // The classification is reported…
        expect(logged).toContain("DATABASE_UNAVAILABLE");
        // …but the driver message is not, because `classifyInfrastructureFault` never
        // returns the raw text — which is the whole reason it is reused here.
        expect(logged).not.toContain("127.0.0.1");
        expect(logged).not.toContain("3306");
        expect(logged).not.toContain("Can't reach");
    });

    it("still fails closed on a throw it does not recognise", async () => {
        // An unrecognised throw is a bug. The probe must report "unavailable" rather than
        // assume health, and must not put the value into the response.
        queryRaw.mockRejectedValue(new Error("kaboom: internal detail"));

        const response = await readiness();
        const serialized = JSON.stringify(await response.json());

        expect(response.status).toBe(503);
        expect(serialized).not.toContain("kaboom");
        expect(String(consoleError.mock.calls[0][0])).toContain("unrecognised error");
    });
});
