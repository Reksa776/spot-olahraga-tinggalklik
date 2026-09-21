/**
 * ==========================================
 * GET /api/health — LIVENESS
 * ==========================================
 *
 * Is this Node process alive and answering HTTP?
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
 * Phase 25 (BLOCK-5) found no health endpoint at all, which means there was nothing for
 * PM2, the reverse proxy or an uptime monitor to poll: an operator had no way to tell a
 * running deployment from a wedged one except by loading a page by hand. Every other
 * question about the deployment ("did the reload work?", "is the process up?") therefore
 * had to be answered through the application UI, which is exactly what a health check
 * exists to avoid.
 *
 * ── WHY LIVENESS AND READINESS ARE TWO ENDPOINTS ─────────────────────────────────
 * This one touches NOTHING. It does not open a database connection, call a provider or
 * read a table, by design: a liveness probe answers "should this process be restarted?",
 * and restarting the application cannot fix a database that is down. A single endpoint
 * that checked the database would answer "not ready" during an outage and invite a process
 * manager to restart-loop a perfectly healthy server — turning one fault into two.
 *
 * The dependency check lives in `./ready/route.ts`, which is what a load balancer or the
 * deployment runbook polls before sending traffic.
 *
 * ── WHAT IT DISCLOSES ────────────────────────────────────────────────────────────
 * A fixed `{"status":"ok"}` and nothing else. No version, no environment name, no
 * hostname, no uptime, no dependency detail, no build id — a health endpoint is public
 * (a probe holds no session), so anything it reports is reported to the internet. The
 * server identity an operator needs is in the logs, not here.
 *
 * `no-store` because a cached "ok" is worse than no health check: it would keep reporting
 * ready after the process died.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(): Response {
    return Response.json(
        { status: "ok" },
        { status: 200, headers: { "Cache-Control": "no-store" } }
    );
}
