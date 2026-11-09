/**
 * Calls the existing authenticated job-tick route once at startup and every minute.
 * PM2 supervises this small scheduler; the route remains the single job entry point.
 */

import "dotenv/config";

const INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

function resolveTickUrl(): string {
    const port = process.env.PORT?.trim() || "3003";
    const raw = process.env.JOBS_TICK_URL?.trim() ||
        `http://127.0.0.1:${port}/api/internal/jobs/tick`;
    const url = new URL(raw);

    if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.pathname !== "/api/internal/jobs/tick"
    ) {
        throw new Error("JOBS_TICK_URL must target the local job-tick endpoint over HTTP.");
    }

    return url.toString();
}

async function main(): Promise<void> {
    const secret = process.env.JOBS_TICK_SECRET?.trim() ?? "";
    if (secret.length < 32) {
        throw new Error("JOBS_TICK_SECRET is required and must be at least 32 characters.");
    }

    const url = resolveTickUrl();
    let running = false;
    let stopping = false;

    const tick = async () => {
        if (running || stopping) return;
        running = true;

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { authorization: `Bearer ${secret}` },
                cache: "no-store",
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            const result = await response.json().catch(() => null) as {
                ok?: boolean;
                jobs?: { h36Reminder?: { ran?: boolean; ok?: boolean; enqueued?: number; failed?: number } };
            } | null;
            const reminder = result?.jobs?.h36Reminder;

            console.log(JSON.stringify({
                event: "jobs.tick.scheduler_result",
                httpStatus: response.status,
                success: response.ok && result?.ok === true,
                h36Ran: reminder?.ran ?? null,
                h36Ok: reminder?.ok ?? null,
                h36Enqueued: reminder?.enqueued ?? null,
                h36Failed: reminder?.failed ?? null,
                at: new Date().toISOString(),
            }));
        } catch (error) {
            console.error(JSON.stringify({
                event: "jobs.tick.scheduler_error",
                error: error instanceof Error ? error.message : "REQUEST_FAILED",
                at: new Date().toISOString(),
            }));
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => void tick(), INTERVAL_MS);
    const shutdown = () => {
        stopping = true;
        clearInterval(timer);
        const finish = () => process.exit(0);
        if (running) setTimeout(finish, REQUEST_TIMEOUT_MS + 1_000).unref();
        else finish();
    };

    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);

    console.log(JSON.stringify({ event: "jobs.tick.scheduler_started", intervalMs: INTERVAL_MS }));
    await tick();
}

main().catch((error: unknown) => {
    console.error(JSON.stringify({
        event: "jobs.tick.scheduler_fatal",
        error: error instanceof Error ? error.message : "STARTUP_FAILED",
    }));
    process.exitCode = 1;
});
