/**
 * ==========================================
 * PM2 PROCESS DEFINITION — TinggalKlik.Co
 * ==========================================
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 reload tinggalklik
 *
 * Phase 25 (BLOCK-5) found that the deployment had no defined start command at all: the
 * only deployment artifact in the tree was a GitHub Actions workflow that SSHed into the
 * VPS and ran `./deploy.sh` from the DELETED retail project. So "how does this application
 * run in production" had no answer in the repository, and an operator would have had to
 * invent one. This file is that answer, and the runbook in `DEPLOYMENT_RUNBOOK.md` is the
 * procedure around it.
 *
 * ── WHY `node_modules/next/dist/bin/next`, AND NOT `npm start` ─────────────────────
 * `pm2 start npm -- start` interposes npm between PM2 and the server. PM2 then supervises
 * npm, so `pm2 reload` sends the signal to npm, the exit code PM2 sees is npm's rather than
 * the server's, and a crash can be reported as a clean npm exit. Invoking Next's own
 * binary directly makes PM2 the supervisor of the actual server process.
 *
 * ── WHY ONE FORKED INSTANCE ────────────────────────────────────────────────────────
 * `instances: 1` / `exec_mode: "fork"` is a CORRECTNESS setting, not a resource one.
 * `lib/rate-limit.ts` is an in-memory, per-process limiter, so the login bucket (5 attempts
 * per 15 minutes) is per-process: running two instances would silently double every limit
 * and let an attacker rotate across them. Clustering is therefore not available until the
 * limiter is moved out of process — see `lib/rate-limit.ts` and the Phase 25 report. One
 * instance is what the code actually supports.
 *
 * ── WHY THE HOSTNAME IS PINNED ─────────────────────────────────────────────────────
 * `next start` binds `0.0.0.0` unless `-H` is given, which would expose the application
 * directly on its port in addition to the reverse proxy. It is bound to loopback instead,
 * so the ONLY ingress is nginx. Change it only if the reverse proxy runs on a different
 * host. (Note that `HOSTNAME` in the environment is NOT used by `next start` — it is a
 * CLI-only option, and on most Linux shells `HOSTNAME` is already set to the machine name,
 * so relying on it would have been a silent failure. The legacy `server.js` in this
 * repository reads exactly that variable and would bind to the hostname.)
 *
 * ── WHY PORT IS SET HERE, AND WHY 3003 ────────────────────────────────────────────
 * `next start -p` reads `PORT` from the environment, so this is the single place the port
 * is decided. Keep it in step with the nginx `proxy_pass` upstream.
 *
 * 3003 is deliberate: on the production host :3000 is occupied by a DIFFERENT
 * application, so TinggalKlik must not bind it. Pinning the port here means
 * `pm2 reload tinggalklik` can never make `next start` fall back to its default 3000 —
 * which is exactly what happened while the process was started via `npm start` with no
 * `PORT` in the PM2 env. Do NOT "simplify" this back to the Next.js default.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────────────
 *   * NO `env_file`. Secrets belong in the host environment (or a file the host loads),
 *     not in a repository-controlled path that this file would have to name. Next.js also
 *     loads `.env.production` / `.env` from `cwd` by itself, so a `env_file` entry would be
 *     a second, competing source of truth. See the runbook.
 *   * NO `out_file` / `error_file`. The defaults (`~/.pm2/logs/…`) need no directory to
 *     exist in the repository and are what `pm2 logs` already reads. Rotation is an
 *     operator concern: `pm2 install pm2-logrotate`.
 *   * The job tick runs as the separate `tinggalklik-jobs-tick` PM2 process below.
 *
 * ── THE NOTIFICATION WORKER (PHASE P1) ────────────────────────────────────────────
 * `tinggalklik-worker` is a SEPARATE process, not an extra Next.js instance. It owns the
 * notification queue loop and is deliberately a single forked instance: the queue's CAS and
 * the `joblock: notification-dispatch` lease are what make overlap safe, but one poller is
 * what keeps the daily WhatsApp cap and the 5-second send cadence meaningful. It never binds
 * a port, never serves HTTP, and never owns the WhatsApp socket.
 *
 * `kill_timeout: 30000` is larger than the web app's 10 seconds because SIGTERM must let the
 * worker finish the delivery it has already claimed. The entrypoint handles SIGTERM/SIGINT
 * and calls `worker.stop()`, which stops claiming and awaits the in-flight batch. PM2 sends
 * SIGINT first and only escalates to SIGKILL after this window.
 *
 * `restart_delay` + `min_uptime` prevent a crash loop from hammering MariaDB. If the worker
 * reaches its restart limit, fix the cause and `pm2 restart tinggalklik-worker` explicitly;
 * do not mask it with an unbounded restart policy.
 *
 * This app inherits the host environment. No secret, database URL or notification switch is
 * written here: an operator enables the worker in the host environment, and the existing
 * SMTP/Baileys or dry-run is selected explicitly in the host environment.
 */

module.exports = {
    apps: [
        {
            name: "tinggalklik",
            // Resolved from this file's own location, so the checkout can live anywhere.
            cwd: __dirname,
            script: "node_modules/next/dist/bin/next",
            args: "start -H 127.0.0.1",
            instances: 1,
            exec_mode: "fork",
            env: {
                NODE_ENV: "production",
                // :3000 belongs to another application on this host — TinggalKlik is :3003.
                PORT: "3003",
                /*
                 * TRUSTED_PROXY is deliberately absent here (see the header: secrets and
                 * host facts belong to the host environment, not to a repository file).
                 * Set it there to the reverse proxy's ADDRESS or CIDR — it is not a switch,
                 * and an unparseable value now fails closed with a warning rather than
                 * silently enabling proxy trust (F-02). See DEPLOYMENT_RUNBOOK.md §4.
                 */
            },
            autorestart: true,
            // Give in-flight requests (a payment callback, a checkout) time to finish before
            // SIGKILL. PM2 sends SIGINT first and escalates after this window.
            // Allow the embedded gateway to finish its graceful shutdown as well.
            kill_timeout: 30000,
            max_memory_restart: "512M",
            // Timestamps on every line, so a log can be correlated with an incident.
            time: true,
            merge_logs: true,
        },
        {
            name: "tinggalklik-worker",
            cwd: __dirname,
            // Run the installed tsx CLI directly. `npx` would add a resolver process between
            // PM2 and the worker and could fetch a package at start-up; both are wrong for a
            // supervised production process.
            script: "node_modules/tsx/dist/cli.mjs",
            args: "scripts/notification-worker.ts",
            interpreter: "node",
            instances: 1,
            exec_mode: "fork",
            env: {
                NODE_ENV: "production",
            },
            autorestart: true,
            // A crash loop must be visible as `errored`, not hidden by endless restarts.
            min_uptime: "30s",
            max_restarts: 10,
            restart_delay: 5000,
            // Longer than the worker's graceful-shutdown window: it awaits the claimed batch.
            kill_timeout: 30000,
            max_memory_restart: "256M",
            time: true,
            merge_logs: true,
        },
        {
            name: "tinggalklik-jobs-tick",
            cwd: __dirname,
            script: "node_modules/tsx/dist/cli.mjs",
            args: "scripts/jobs-tick-scheduler.ts",
            interpreter: "node",
            instances: 1,
            exec_mode: "fork",
            env: {
                NODE_ENV: "production",
            },
            autorestart: true,
            min_uptime: "30s",
            max_restarts: 10,
            restart_delay: 5000,
            kill_timeout: 10000,
            max_memory_restart: "128M",
            time: true,
            merge_logs: true,
        },
    ],
};
