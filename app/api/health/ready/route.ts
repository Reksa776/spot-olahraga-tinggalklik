import { prisma } from "@/lib/prisma";
import { classifyInfrastructureFault } from "@/lib/errors/infrastructure";

/**
 * ==========================================
 * GET /api/health/ready — READINESS
 * ==========================================
 *
 * Can this process actually serve requests right now?
 *
 * The only dependency that makes every request fail is the database, so that is the only
 * one checked. It is checked with a single `SELECT 1` — the cheapest statement the driver
 * can issue — because a readiness probe runs on a schedule forever and must not itself
 * become load. Nothing is mutated: no row is written, no lock is taken, no provider is
 * called. (Deliberately NOT checked: iPaymu. A payment provider being slow is not a reason
 * to take the whole site out of rotation, and a probe must never generate provider traffic.)
 *
 * ── STATUS SEMANTICS ─────────────────────────────────────────────────────────────
 *   200 `{"status":"ready"}`      — the process answers and the database is reachable.
 *   503 `{"status":"unavailable"}` — the process answers but cannot serve.
 *
 * 503 rather than 500 is deliberate: the request was valid and the failure is that a
 * dependency is unavailable, which is precisely what 503 means, and it is the status a load
 * balancer and a deployment script both already understand.
 *
 * ── WHY THE BODY CONTAINS NO ERROR DETAIL ────────────────────────────────────────
 * This route is public (a probe cannot hold a session). A Prisma connection error can carry
 * the database host, the port and sometimes the failing statement, so the response carries
 * only `database: "error"` while the server log gets the SANITISED classification from
 * `classifyInfrastructureFault`, whose `detail` is documented never to include the driver's
 * message. That is the same helper the API error layer uses, so there is one definition of
 * "safe to log" rather than a second one invented here.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<Response> {
    try {
        await prisma.$queryRaw`SELECT 1`;

        return Response.json(
            { status: "ready", checks: { database: "ok" } },
            { status: 200, headers: { "Cache-Control": "no-store" } }
        );
    } catch (error) {
        const fault = classifyInfrastructureFault(error);

        /*
         * `fault.detail` is a driver error code or a fixed phrase ("prisma init"), never the
         * raw message. When the throw is not recognised as infrastructure at all, only the
         * fact that it was unrecognised is logged — an unrecognised throw here is a bug, and
         * the readiness probe should report "unavailable" rather than assume health.
         */
        console.error(
            `[health/ready] database check failed: ${
                fault ? `${fault.kind} (${fault.detail})` : "unrecognised error"
            }`
        );

        return Response.json(
            { status: "unavailable", checks: { database: "error" } },
            { status: 503, headers: { "Cache-Control": "no-store" } }
        );
    }
}
