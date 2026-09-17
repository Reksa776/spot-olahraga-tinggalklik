import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 10 — THE CHECK-IN GATE STAYED CLOSED
 * ==========================================
 *
 * The brief's Part 15 says to STOP before implementing check-in if its dependencies are not
 * locked, and to build no fake security if they are not. This suite proves the stop happened, and
 * pins the *reason* so the gate cannot be quietly opened by a later change that only looks
 * harmless.
 *
 * The blockers, from the repository (each is evidenced in TICKETING_PHASE10_REPORT.md §7):
 *
 *   1. D-46 / scanner-token delivery — the credential the design mandates is the raw `qrToken`,
 *      whose SHA-256 is `qrTokenHash`. No delivery channel has ever emitted it (Phase 8), so the
 *      only credential in existence is `ticketCode`, which design §19.3 rejects as a bearer
 *      credential in as many words.
 *   2. D-28 — whether a ticket with an open refund request may be admitted (validation-chain
 *      check 4) is unanswered, and `CheckInResult` has no value to record either answer's refusal.
 *   3. Design↔schema divergence — design §20.1 specifies
 *      `QR_SCAN | MANUAL_CODE | MANUAL_OVERRIDE` and
 *      `ACCEPTED | REJECTED_DUPLICATE | REJECTED_INVALID | REJECTED_WRONG_EVENT |
 *       REJECTED_NOT_ISSUED | REJECTED_UNAUTHORIZED | REJECTED_REFUND_PENDING`;
 *      the shipped schema has `QR_SCAN | MANUAL` and a different result set. A faithful
 *      implementation therefore needs additive enum values — a migration, which this phase's
 *      brief requires to be raised rather than assumed.
 *   4. Issuance invocation — the design says tickets are created at settlement; the shipped
 *      implementation is buyer-triggered and has no settlement hook. A ticket that was never
 *      issued cannot be checked in, so this is a check-in dependency too.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function walk(dir: string, out: string[] = []): string[] {
    const absolute = path.join(ROOT, dir);

    if (!existsSync(absolute)) return out;

    for (const name of readdirSync(absolute)) {
        const rel = path.posix.join(dir, name);
        const abs = path.join(ROOT, rel);

        if (statSync(abs).isDirectory()) {
            if (["node_modules", ".git", ".next"].includes(name)) continue;
            walk(rel, out);
        } else {
            out.push(rel);
        }
    }

    return out;
}

describe("P10-10. nothing was built for check-in", () => {
    it("adds no check-in API route", () => {
        const routes = walk("app/api").filter((f) => f.endsWith("route.ts"));

        for (const route of routes) {
            expect(route).not.toMatch(/checkin|check-in|scan|gate/i);
        }
    });

    it("adds no check-in module, service or component", () => {
        const files = [...walk("lib"), ...walk("components")];

        expect(files.filter((f) => /check(i|-)in|gate-?scan/i.test(f))).toEqual([]);
    });

    it("wires no check-in permission into a route", () => {
        // `checkin.scan` is declared in the Phase 3 permission map (and must stay declared —
        // deleting it would be the opposite mistake). What must not exist is a caller.
        expect(read("lib/authz/permissions.ts")).toContain("checkin.scan");

        for (const file of walk("app/api")) {
            expect(read(file)).not.toContain("CHECKIN_SCAN");
        }
    });

    it("adds no scanner dependency", () => {
        const pkg = JSON.parse(read("package.json")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        const names = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
        ].join(" ");

        expect(names).not.toMatch(/qr-scanner|zxing|barcode|html5-qrcode|jsqr|instascan|quagga/i);
    });

    it("offers no fake 'validate' affordance in the ticket UI", () => {
        /*
         * The rule is "no affordance", not "no vocabulary". These files legitimately *discuss*
         * check-in — the e-ticket's header comment explains why there is no validate button, and
         * `admission.scannable` is a server-computed fact the copy renders honestly. What must
         * not exist is an interactive control that appears to do the job: an input, a form, a
         * click handler, or a call to a check-in endpoint.
         */
        for (const file of [
            "app/ticketing/tickets/[ticketCode]/page.tsx",
            "app/ticketing/tickets/page.tsx",
            "components/ticketing/TicketCard.tsx",
            "components/tickets/TicketQr.tsx",
        ]) {
            const source = read(file);

            expect(source).not.toContain("<input");
            expect(source).not.toContain("<form");
            expect(source).not.toContain("onClick");
            expect(source).not.toContain("fetch(");
            expect(source).not.toMatch(/\/api\/[a-z-]*check/i);
        }
    });
});

describe("P10-11. the blockers are still the blockers", () => {
    it("the schema still lacks the design's CheckIn enum values", () => {
        const schema = read("prisma/schema.prisma");

        // If a later phase adds these, that phase must also answer D-28 and the delivery
        // question — failing here is the reminder, not an obstacle.
        expect(schema).not.toContain("MANUAL_OVERRIDE");
        expect(schema).not.toContain("REJECTED_REFUND_PENDING");
        expect(schema).not.toContain("REJECTED_UNAUTHORIZED");
    });

    it("the check-in infrastructure that IS locked is left intact", () => {
        const schema = read("prisma/schema.prisma");

        // Phase 3's tenant-scoped staff authority, and the DB-level duplicate guarantee: the one
        // gate dependency that needs no decision. Deleting either would make check-in harder to
        // build later, so their presence is asserted deliberately.
        expect(schema).toContain("model StaffEventAssignment {");
        expect(schema).toContain("@@unique([organizerMemberId, eventId])");
        expect(schema).toContain("model CheckIn {");
        expect(schema).toContain("ticketId            String?       @unique");
    });

    it("the raw scanner token is still never emitted to any client", () => {
        // Phase 8's finding, re-asserted because it is blocker #1's whole substance: the token
        // exists (it is what a scanner would have to present) but no response projection carries
        // it. `payload.ts` names it only in the list of things the buyer may not see.
        const payload = read("lib/ticketing/tickets/payload.ts");

        expect(payload).toContain("no `qrTokenHash`");
        // A projection field would look like `qrTokenHash:`. A doc reference does not.
        expect(payload).not.toMatch(/qrTokenHash\s*:/);

        // And the QR the buyer is shown is derived from the public lookup code instead.
        const reference = read("lib/ticketing/tickets/reference.ts");

        expect(reference).toContain('TICKET_QR_PREFIX = "TICKET:"');
    });
});
