/**
 * ==========================================
 * INFRASTRUCTURE FAULT DETECTION (PURE)
 * ==========================================
 *
 * Recognises the failure modes that are NOT "the user did something wrong" and NOT
 * "the resource does not exist": the database being unreachable, a query timing out, a
 * connection being refused, an external service dropping the socket.
 *
 * ── WHY THIS MODULE EXISTS, AND WHY IT IS SEPARATE ───────────────────────────────
 * The Phase 23A defect was a permission refusal rendered as a 404. The same class of bug
 * exists in the other direction and is worse: a page that writes
 *
 *     const order = await getOwnOrder(...).catch(() => null);
 *     if (!order) notFound();
 *
 * reports a database outage as "this order does not exist". The buyer is told their
 * purchase is gone, the operator sees a 404 in the logs instead of an outage, and no
 * retry is ever offered.
 *
 * Distinguishing those cases needs a single place that answers "is this error
 * infrastructure, or is it the application telling me something?" — and that answer must
 * be reachable from both the API layer (`lib/api/errors.ts`) and the page layer
 * (`lib/errors/classify.ts`).
 *
 * ── WHY NO IMPORTS ───────────────────────────────────────────────────────────────
 * This module imports NOTHING. `lib/api/errors.ts` imports it, and the classifiers import
 * `lib/api/errors.ts`, so anything this file imported would be a step towards a cycle.
 * Detection is done by shape (`name`, `code`, `message`), which is also why it works for
 * error instances that come from a different copy of the Prisma client inside a test
 * fixture — `instanceof` would not.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────
 * It does not swallow, log, or rethrow. It classifies and returns `null` when it has no
 * opinion, so the caller keeps its existing behaviour (fail to `INTERNAL_ERROR`).
 */

/** A recognised infrastructure fault. Every kind is retryable. */
export type InfrastructureFaultKind =
    /** The database cannot be reached / is not accepting connections. */
    | "DATABASE_UNAVAILABLE"
    /** A previously-good connection was lost mid-query (pool reset, server restart). */
    | "DATABASE_CONNECTION_LOST"
    /** The database answered but the operation exceeded its deadline. */
    | "DATABASE_TIMEOUT"
    /** The clock at the other end of a network call ran out. */
    | "REQUEST_TIMEOUT"
    /** A socket was refused/reset, DNS failed, or `fetch` could not complete. */
    | "NETWORK_FAILURE";

export type InfrastructureFault = {
    kind: InfrastructureFaultKind;
    /**
     * Server-side description. Safe to log; never sent to a client. It carries the driver
     * error code but NOT the SQL, the parameters or the connection string.
     */
    detail: string;
};

/**
 * Prisma error codes that mean "infrastructure", not "your data".
 *
 * Taken from the Prisma error reference and kept to the ones that are genuinely
 * infrastructure. `P2002` (unique violation) and `P2025` (record not found) are
 * deliberately ABSENT: those are ordinary application outcomes that the services already
 * translate, and re-labelling them as an outage would be its own misdirection.
 *
 *   P1000 authentication failed          → the credentials are wrong / the server is gone
 *   P1001 cannot reach database server   → host down, port closed, VPC misconfigured
 *   P1002 database server timed out      → reachable but unresponsive
 *   P1008 operations timed out           → pool exhaustion
 *   P1017 server closed the connection   → the classic mid-flight drop
 *   P2024 timed out fetching connection  → pool exhaustion (Prisma 4+)
 *   P2021/P2022 missing table/column     → schema drift (deploy skew): an outage from the
 *                                          user's point of view, and certainly not a 404
 */
const INFRASTRUCTURE_PRISMA_CODES: ReadonlySet<string> = new Set([
    "P1000",
    "P1001",
    "P1002",
    "P1008",
    "P1017",
    "P2021",
    "P2022",
    "P2024",
]);

/** Codes that specifically mean "the connection went away" rather than "never reachable". */
const CONNECTION_LOST_PRISMA_CODES: ReadonlySet<string> = new Set([
    "P1017",
    "P1001",
]);

/**
 * Codes that mean a DEADLINE rather than a refusal.
 *
 * Checked BEFORE the connection-lost set, because P1002 ("the database server was reached but
 * timed out") is both: it is a reachability problem AND a deadline, and telling an operator
 * "timed out" points them at load or pool exhaustion instead of at a dead host. Getting that
 * backwards sends the investigation in the wrong direction, so the order here is load-bearing.
 */
const TIMEOUT_PRISMA_CODES: ReadonlySet<string> = new Set([
    "P1002",
    "P1008",
    "P2024",
]);

/**
 * Message fragments that are unambiguous network/driver faults.
 *
 * Matching on text is normally a smell. It is justified here because these strings are
 * emitted by the Node driver and by `undici`, not by application code, and because the
 * alternative is that a socket error is reported to a buyer as "not found".
 */
const NETWORK_MESSAGE_PATTERNS: readonly string[] = [
    "econnrefused",
    "econnreset",
    "epipe",
    "enotfound",
    "eai_again",
    "etimedout",
    "socket hang up",
    "connection lost",
    "connection closed",
    "connection refused",
    "server has gone away",
    "too many connections",
    "fetch failed",
    "network error",
    "socket disconnected before secure tls",
    "getaddrinfo",
];

/** Message fragments that mean a deadline, not a refusal. */
const TIMEOUT_MESSAGE_PATTERNS: readonly string[] = [
    "timed out",
    "timeout",
    "etimedout",
];

/** Error names meaning "the caller's deadline expired". */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
    "AbortError",
    "TimeoutError",
    "RequestTimeout",
    "PrismaClientKnownRequestError", // only reached via the P-code path below
]);

function readString(value: unknown): string {
    return typeof value === "string" ? value : "";
}

/**
 * Prisma's generated client sets `name` to one of these. Checking the prefix rather than
 * `instanceof` is deliberate (see the header).
 */
function isPrismaError(error: Error): boolean {
    return error.name.startsWith("PrismaClient");
}

/**
 * Classify a thrown value as an infrastructure fault, or return `null` when it is not one.
 *
 * Order matters: the Prisma code (an exact, documented identifier) is consulted before any
 * message heuristic, so a driver error whose message happens to contain "timeout" is still
 * reported as a database fault rather than as a generic request timeout.
 */
export function classifyInfrastructureFault(
    error: unknown
): InfrastructureFault | null {
    if (!(error instanceof Error)) {
        return null;
    }

    const name = readString(error.name);
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === "string" ? rawCode : "";
    const message = readString(error.message);

    // ── 1. Prisma, by documented code ────────────────────────────────────────────
    if (isPrismaError(error) && code) {
        if (!INFRASTRUCTURE_PRISMA_CODES.has(code)) {
            // A *known* Prisma error code that is not an infrastructure code (P2002,
            // P2025, …) is an application outcome. Return null rather than guessing.
            return null;
        }

        const kind: InfrastructureFaultKind = TIMEOUT_PRISMA_CODES.has(code)
            ? "DATABASE_TIMEOUT"
            : CONNECTION_LOST_PRISMA_CODES.has(code)
              ? "DATABASE_CONNECTION_LOST"
              : "DATABASE_UNAVAILABLE";

        // `PrismaClientInitializationError` carries the driver's own `errorCode`
        // (e.g. P1001); the detail names it without the connection string.
        return { kind, detail: `prisma ${code}` };
    }

    // ── 2. Prisma, by error name only ────────────────────────────────────────────
    // `PrismaClientInitializationError` for a bad `DATABASE_URL` has no `code` on some
    // versions; `PrismaClientRustPanicError` means the engine died.
    if (name === "PrismaClientInitializationError") {
        /*
         * An init failure is ALWAYS a database-unavailable condition — the client could not be
         * constructed at all — so there is no `null` answer to return here. The message is
         * consulted only to be more specific (a deadline rather than a refusal); with no
         * recognisable fragment the generic answer stands.
         */
        return (
            guessFromMessage(message, "prisma init") ?? {
                kind: "DATABASE_UNAVAILABLE",
                detail: "prisma init",
            }
        );
    }

    if (name === "PrismaClientRustPanicError") {
        return { kind: "DATABASE_UNAVAILABLE", detail: "prisma engine panic" };
    }

    // `PrismaClientValidationError` is a BUG IN OUR QUERY, not an outage. Falling
    // through leaves it as `INTERNAL_ERROR`, which is the honest answer.
    if (name === "PrismaClientValidationError") {
        return null;
    }

    // `PrismaClientKnownRequestError` with no code reached here: do not guess.
    if (name === "PrismaClientKnownRequestError") {
        return null;
    }

    if (name === "PrismaClientUnknownRequestError") {
        return { kind: "DATABASE_UNAVAILABLE", detail: "prisma unknown request error" };
    }

    // ── 3. Deadline errors ───────────────────────────────────────────────────────
    if (TIMEOUT_ERROR_NAMES.has(name)) {
        return { kind: "REQUEST_TIMEOUT", detail: `timeout (${name})` };
    }

    // ── 4. Message heuristics (driver / undici text) ─────────────────────────────
    return guessFromMessage(message, "network");
}

/**
 * Fall back to the message, but only for fragments that are unambiguous.
 *
 * The returned `detail` never includes the message itself: a driver error can embed the
 * host, the user name or the failing query, and `detail` is written to logs.
 */
function guessFromMessage(
    message: string,
    source: string
): InfrastructureFault | null {
    const haystack = message.toLowerCase();

    for (const pattern of NETWORK_MESSAGE_PATTERNS) {
        if (haystack.includes(pattern)) {
            const isTimeout = TIMEOUT_MESSAGE_PATTERNS.some((fragment) =>
                haystack.includes(fragment)
            );

            return {
                kind: isTimeout ? "REQUEST_TIMEOUT" : "NETWORK_FAILURE",
                detail: `${source}: network fault (${pattern})`,
            };
        }
    }

    return null;
}

/** True when the fault is the database rather than an external HTTP service. */
export function isDatabaseFault(fault: InfrastructureFault): boolean {
    return fault.kind.startsWith("DATABASE_");
}
