/**
 * ==========================================
 * TRANSIENT DATABASE CONTENTION (shared)
 * ==========================================
 *
 * InnoDB resolves contention on a row — and the ticketing inventory guard is deliberately
 * one conditional `UPDATE` on the `tickettype` row (design §11.2) — by choosing a deadlock
 * victim (`ER_LOCK_DEADLOCK`, 1213) or by failing a waiter
 * (`ER_LOCK_WAIT_TIMEOUT`, 1205). Prisma surfaces the first as `P2010` when it comes from
 * a raw query and as `P2034` when it recognises the conflict itself.
 *
 * These are retryable by definition: the victim's transaction rolled back completely, so
 * the database is in a state the request can be re-evaluated against. Phase 6 MEASURED
 * the cost of not retrying — 100 simultaneous buyers for one 50-seat ticket type produced
 * only 12 successes and 88 raw `P2010` failures, which is not an oversell (the invariants
 * held) but is 88 spurious failures a buyer reads as "checkout is broken".
 *
 * ── WHY THIS MODULE EXISTS (and is not a second implementation) ──────────────────
 * Phase 6 originally kept this classifier and its backoff inside
 * `lib/ticketing/checkout.ts`. Phase 7's settlement path needs the identical behaviour, and
 * brief §18 requires it there by name ("retry boundedly; use jittered backoff; re-run the
 * transaction from the beginning"). Copying it would create exactly the second
 * implementation the brief forbids, and two copies would drift. So the ONE implementation
 * lives here and both callers import it. The Phase 6 static guard that pinned the timer to
 * a single named file is re-pinned to this file — the rule it enforces ("a timer may exist
 * in exactly one named place") is unchanged and still exact.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────
 * No scheduler. `setTimeout` appears once, as a one-shot pause on the retry path only; the
 * success path never sleeps. There is no interval, no queue, no worker: design §40.11
 * assigns the persistent job runner to a different phase and brief §8 forbids inventing
 * one. See `lib/ticketing/reservations.ts` for the same boundary statement.
 */

/**
 * How many times one request may be re-attempted after a transient serialization failure.
 *
 * Bounded, and bounded the same way in both callers: an unbounded retry under contention
 * is a self-inflicted denial of service, and a retry that does not re-run the guards would
 * be worse than no retry at all.
 */
export const CONTENTION_MAX_ATTEMPTS = 10;

/**
 * Is this a transient InnoDB serialization failure?
 *
 * Note the deliberate strictness: `P2010` is Prisma's generic raw-query failure, so
 * accepting the code alone as retryable would also retry genuine SQL errors (a bad column,
 * a constraint violation, a syntax error) forever. The MySQL error number — or the message
 * text Prisma passes through — has to agree that this was contention.
 */
export function isTransientContention(error: unknown): boolean {
    if (typeof error !== "object" || error === null) {
        return false;
    }

    const candidate = error as {
        code?: string;
        meta?: { code?: unknown };
        message?: string;
    };

    if (candidate.code === "P2034") {
        return true;
    }

    const metaCode =
        typeof candidate.meta?.code === "string"
            ? candidate.meta.code
            : typeof candidate.meta?.code === "number"
              ? String(candidate.meta.code)
              : undefined;

    // 1213 = deadlock found when trying to get lock, 1205 = lock wait timeout exceeded.
    if (metaCode === "1213" || metaCode === "1205") {
        return true;
    }

    return /deadlock found|lock wait timeout|try restarting transaction/i.test(
        String(candidate.message ?? "")
    );
}

/**
 * Short, jittered pause before a retry (design §19: a deadlock victim that retries
 * instantly re-collides).
 *
 * The jitter is the point: without it, N victims of the same deadlock wake together and
 * collide again in lockstep. The delay doubles per attempt up to 100 ms and is then
 * randomised within that window, so the worst case for ten attempts stays comfortably
 * inside a request's budget while still spreading the retries out.
 */
export async function contentionBackoff(attempt: number): Promise<void> {
    const capped = Math.min(2 ** attempt, 100);

    await new Promise<void>((resolve) => {
        setTimeout(resolve, capped + Math.random() * capped);
    });
}

export type ContentionRetryResult<T> =
    | { ok: true; value: T; attempts: number }
    | { ok: false; reason: "CONTENTION_EXHAUSTED"; attempts: number };

/**
 * Run `operation`, re-running it from the beginning after a classified transient failure.
 *
 * Every attempt re-executes the whole unit of work, so a retry can never skip a guard — it
 * can only re-evaluate them against the post-rollback state. That is what makes a bounded
 * retry safe here, as opposed to the "sleep and try again" the brief rules out.
 *
 * Only `isTransientContention` failures are retried; everything else propagates
 * immediately, so a genuine error is never masked by a retry loop.
 */
export async function withContentionRetry<T>(
    operation: (attempt: number) => Promise<T>,
    options?: { maxAttempts?: number }
): Promise<ContentionRetryResult<T>> {
    const maxAttempts = options?.maxAttempts ?? CONTENTION_MAX_ATTEMPTS;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            return { ok: true, value: await operation(attempt), attempts: attempt + 1 };
        } catch (error) {
            const isLast = attempt === maxAttempts - 1;

            if (!isTransientContention(error)) {
                throw error;
            }

            if (isLast) {
                return {
                    ok: false,
                    reason: "CONTENTION_EXHAUSTED",
                    attempts: attempt + 1,
                };
            }

            await contentionBackoff(attempt);
        }
    }

    // Unreachable: the loop either returns or throws. Kept so the return type is total.
    return { ok: false, reason: "CONTENTION_EXHAUSTED", attempts: maxAttempts };
}
