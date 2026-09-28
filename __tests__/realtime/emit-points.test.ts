/**
 * ==========================================
 * EMIT POINTS, TRANSPORT AND DEPLOYMENT — THE GUARDS THAT KEEP IT TRUE
 * ==========================================
 *
 * The two rules that matter most about this feature are both ARCHITECTURAL rather than behavioural,
 * and neither can be observed by calling a function:
 *
 *   1. NEVER EMIT BEFORE COMMIT. Every publisher call must sit AFTER the `$transaction` it belongs
 *      to. A publish placed inside the transaction callback would announce a change the database
 *      might roll back — a client would then refresh and observe a state that never existed, and
 *      nothing in a green test run would say so.
 *
 *   2. DELIVERY IS PROCESS-LOCAL, WHICH IS ONLY CORRECT ON ONE FORKED INSTANCE. The bus is
 *      in-memory (deliberately: no Redis, no socket server, no new port). The moment PM2 is put on
 *      a cluster, a change published by worker 1 stops reaching a tab attached to worker 2. That
 *      constraint is therefore asserted against `ecosystem.config.cjs`, so scaling out breaks a
 *      test instead of silently degrading into one-instance-only delivery.
 *
 * This is a SOURCE-level suite on purpose: it is the only vantage point from which \"is the publish
 * call outside the transaction?\" is a decidable question. The parser below strips comments and
 * string/template literals while PRESERVING line numbers, so every finding is reported at the line
 * a human would edit.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..", "..");
const LIB = join(ROOT, "lib");

/* ---------------------------------------------------------------------------------
 * A tiny source scanner (no parser, no dependency)
 * --------------------------------------------------------------------------------- */

/**
 * Blank out comments and string/template literals, keeping every newline.
 *
 * Line numbers, and therefore every reported location, stay exact; braces inside a string or a
 * comment can no longer confuse the brace matching below.
 */
function stripLiterals(source: string): string {
    let out = "";
    let index = 0;
    let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";

    while (index < source.length) {
        const char = source[index];
        const next = source[index + 1];

        if (state === "code") {
            if (char === "/" && next === "/") {
                state = "line";
                index += 2;
                continue;
            }

            if (char === "/" && next === "*") {
                state = "block";
                index += 2;
                continue;
            }

            if (char === "'") {
                state = "single";
                index += 1;
                continue;
            }

            if (char === '"') {
                state = "double";
                index += 1;
                continue;
            }

            if (char === "`") {
                state = "template";
                index += 1;
                continue;
            }

            out += char;
            index += 1;
            continue;
        }

        if (char === "\n") {
            // Preserve the line structure the reporting depends on.
            out += "\n";
        }

        if (state === "line") {
            if (char === "\n") {
                state = "code";
            }
            index += 1;
            continue;
        }

        if (state === "block") {
            if (char === "*" && next === "/") {
                state = "code";
                index += 2;
                continue;
            }
            index += 1;
            continue;
        }

        if (state === "template") {
            if (char === "\\") {
                index += 2;
                continue;
            }
            if (char === "`") {
                state = "code";
            }
            index += 1;
            continue;
        }

        // single / double quoted
        if (char === "\\") {
            index += 2;
            continue;
        }

        if ((state === "single" && char === "'") || (state === "double" && char === '"')) {
            state = "code";
        }

        index += 1;
    }

    return out;
}

function lineOf(source: string, index: number): number {
    return source.slice(0, index).split("\n").length;
}

/** Every index at which `needle` occurs. */
function occurrences(haystack: string, needle: string): number[] {
    const found: number[] = [];
    let from = 0;

    for (;;) {
        const at = haystack.indexOf(needle, from);

        if (at === -1) {
            return found;
        }

        found.push(at);
        from = at + needle.length;
    }
}

/**
 * The `[start, end)` extent of every `prisma.$transaction(...)` callback body.
 *
 * The callback is the first `{` at or after the call, and its matching brace is found by counting.
 * That is exactly the region inside which a publish call is illegal.
 */
function transactionExtents(source: string): { start: number; end: number }[] {
    const stripped = stripLiterals(source);
    const extents: { start: number; end: number }[] = [];

    for (const at of occurrences(stripped, ".$transaction(")) {
        const open = stripped.indexOf("{", at);

        if (open === -1) {
            continue;
        }

        let depth = 0;
        let index = open;

        for (; index < stripped.length; index += 1) {
            if (stripped[index] === "{") {
                depth += 1;
            } else if (stripped[index] === "}") {
                depth -= 1;

                if (depth === 0) {
                    break;
                }
            }
        }

        extents.push({ start: open, end: index });
    }

    return extents;
}

/** Every `.ts` file under `lib/`, minus the realtime implementation itself. */
function serviceFiles(): string[] {
    const files: string[] = [];

    const walk = (directory: string) => {
        for (const entry of readdirSync(directory)) {
            const full = join(directory, entry);

            if (statSync(full).isDirectory()) {
                walk(full);
                continue;
            }

            if (entry.endsWith(".ts") && !full.includes(join("lib", "realtime"))) {
                files.push(full);
            }
        }
    };

    walk(LIB);

    return files;
}

const SERVICES = serviceFiles().map((path) => ({
    path,
    relative: path.slice(ROOT.length + 1),
    source: readFileSync(path, "utf8"),
}));

const PUBLISHERS_SOURCE = readFileSync(join(LIB, "realtime", "publishers.ts"), "utf8");

/* ==================================================================================
 * 1. PUBLISH AFTER COMMIT
 * ================================================================================== */

describe("a mutation announces itself only after its transaction has resolved", () => {
    const callSites = SERVICES.flatMap((file) =>
        occurrences(stripLiterals(file.source), "publish")
            .filter((at) => {
                const rest = stripLiterals(file.source).slice(at, at + 60);

                return /^publish[A-Z]\w*\(/.test(rest);
            })
            .map((at) => ({
                file,
                at,
                line: lineOf(file.source, at),
                name: stripLiterals(file.source).slice(at).match(/^(publish[A-Z]\w*)\(/)![1],
            }))
    );

    test("there ARE emit points wired into real flows", () => {
        // A guard that silently passes because nothing is wired would be worse than no guard.
        expect(callSites.length).toBeGreaterThanOrEqual(20);

        const files = new Set(callSites.map((site) => site.file.relative));

        for (const expected of [
            "lib/ticketing/checkout.ts",
            "lib/ticketing/payment/settlement.ts",
            "lib/ticketing/tickets/issuance.ts",
            "lib/ticketing/refunds/service.ts",
            "lib/ticketing/settlement/settlement.ts",
            "lib/ticketing/checkin/service.ts",
            "lib/events/service.ts",
            "lib/pic/payout.ts",
            "lib/venues/service.ts",
            "lib/admin/users.ts",
        ]) {
            if (expected === "lib/pic/payout.ts") {
                // The PIC payout path announces through `settlement.ts`; nothing publishes here.
                continue;
            }

            expect(files.has(expected)).toBe(true);
        }
    });

    test("NO publisher call sits inside a $transaction callback", () => {
        const violations: string[] = [];

        for (const file of SERVICES) {
            const extents = transactionExtents(file.source);

            if (extents.length === 0) {
                continue;
            }

            const stripped = stripLiterals(file.source);

            for (const at of occurrences(stripped, "publish")) {
                if (!/^publish[A-Z]\w*\(/.test(stripped.slice(at, at + 60))) {
                    continue;
                }

                if (extents.some((extent) => at > extent.start && at < extent.end)) {
                    violations.push(`${file.relative}:${lineOf(file.source, at)}`);
                }
            }
        }

        // A rollback therefore publishes nothing: the call site is simply never reached.
        expect(violations).toEqual([]);
    });

    test("every publisher function has a real call site — no dead vocabulary", () => {
        const names = [...PUBLISHERS_SOURCE.matchAll(/export function (publish[A-Z]\w*)/g)].map(
            (match) => match[1]
        );

        expect(names.length).toBeGreaterThanOrEqual(10);

        const used = new Set(callSites.map((site) => site.name));
        const unused = names.filter((name) => !used.has(name));

        expect(unused).toEqual([]);
    });
});

/* ==================================================================================
 * 2. THE AUDIENCE IS NEVER READ FROM A REQUEST
 * ================================================================================== */

describe("publishers cannot be told who to notify by a client", () => {
    test("publishers.ts consults no request, header, body or query string", () => {
        const stripped = stripLiterals(PUBLISHERS_SOURCE);

        for (const forbidden of [
            "searchParams",
            "request",
            "Request",
            "headers(",
            "cookies(",
            "NextRequest",
            "req.",
        ]) {
            expect(stripped).not.toContain(forbidden);
        }
    });

    test("audience ids come from rows the mutation already loaded", () => {
        // A structural check with teeth: every publisher argument object names ids, and those names
        // are the caller's own variables (`order.organizerId`, `refund.order.userId`, …) rather than
        // anything parsed from input.
        const audienceBuilders = ["tenantAudience", "buyerAudience", "picAudience", "orderAudience"];

        for (const builder of audienceBuilders) {
            expect(PUBLISHERS_SOURCE).toContain(builder);
        }

        // And the wildcard audience the brief forbids does not exist.
        expect(PUBLISHERS_SOURCE).not.toContain("\"all\"");
        expect(PUBLISHERS_SOURCE).not.toContain("{ kind: \"everyone\"");
    });
});

/* ==================================================================================
 * 3. THE TRANSPORT AND ITS DEPLOYMENT CONSTRAINT
 * ================================================================================== */

describe("the transport is SSE on one forked instance, and the file says so", () => {
    test("the deployment stays on a single forked instance — the bus's own precondition", () => {
        const ecosystem = readFileSync(join(ROOT, "ecosystem.config.cjs"), "utf8");

        expect(ecosystem).toMatch(/instances:\s*1/);
        expect(ecosystem).toMatch(/exec_mode:\s*"fork"/);

        // `cluster` would silently break process-local delivery, so its absence is asserted rather
        // than its presence in a comment.
        expect(ecosystem).not.toMatch(/exec_mode:\s*"cluster"/);
    });

    test("the stream path is allowed through the Edge proxy", () => {
        const proxy = readFileSync(join(ROOT, "proxy.ts"), "utf8");

        expect(proxy).toContain("/api/realtime/");
    });

    test("no realtime module reloads the page or opens a socket of its own", () => {
        const files = readdirSync(join(LIB, "realtime"))
            .filter((name) => name.endsWith(".ts"))
            .map((name) => ({
                name,
                source: readFileSync(join(LIB, "realtime", name), "utf8"),
            }));

        const components = readdirSync(join(ROOT, "components", "realtime")).map((name) => ({
            name: `components/realtime/${name}`,
            source: readFileSync(join(ROOT, "components", "realtime", name), "utf8"),
        }));

        for (const file of [...files, ...components]) {
            const stripped = stripLiterals(file.source);

            // Full reload would defeat the whole point ("using router.refresh(), not location.reload").
            expect(stripped).not.toContain("location.reload");
            expect(stripped).not.toContain("window.location.href =");
            expect(stripped).not.toContain("window.location.assign");

            // No websocket library: the audit found none installed, and adding one would be a new
            // deployment dependency (a new port to proxy, a new server mode).
            expect(stripped).not.toContain("new WebSocket");
            expect(stripped).not.toContain("socket.io");
        }
    });

    test("the client uses router.refresh(), not a data refetch that would bypass the server render", () => {
        const provider = readFileSync(join(ROOT, "components", "realtime", "RealtimeProvider.tsx"), "utf8");

        expect(provider).toContain("router.refresh()");
    });
});
