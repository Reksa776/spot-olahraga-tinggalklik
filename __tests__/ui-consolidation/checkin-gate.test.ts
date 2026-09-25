import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 13 — THE CHECK-IN GATE, AND WHY IT OPENED
 * ==========================================
 *
 * Through Phase 10 this suite asserted the opposite of what it asserts now: that nothing had been
 * built for check-in, because the credential the design mandates did not exist end to end. Phase 13
 * opened the gate for the ONE credential that does exist, and this suite records precisely that —
 * the decision, the alternative it rejected, and the blocker that is still standing.
 *
 * ── WHAT CHANGED, AND WHY IT WAS SAFE TO CHANGE ──────────────────────────────────────────────
 *
 * Design §19.3/§20.2 admit a ticket by hashing the presented `qrToken` and comparing it to
 * `Ticket.qrTokenHash`. That token is minted at issuance (32 random bytes) and its hash is stored
 * — but the raw token has NEVER been emitted to any client: no email, no response projection, no
 * page. Decision **D-46** (how a scanner obtains a token) is therefore still open, and a scanner
 * cannot present a secret nobody has been given.
 *
 * Phase 13 did not invent a way around that. It implemented the path the design ALREADY provides
 * for the case a token cannot be used — `CheckInMethod.MANUAL`, the usher reading a code aloud —
 * and used `Ticket.ticketCode`, the value the wallet QR encodes (`TICKET:<ticketCode>`) and the
 * only ticket reference that has ever been delivered to a buyer.
 *
 * That is a narrower claim than "QR scan verification is implemented", and the narrowness is what
 * these assertions defend:
 *
 *   • the raw `qrToken`/`qrTokenHash` is STILL never read by the scan path, and still never
 *     projected to a client (the Phase 8 finding is unchanged, so D-46 is still the blocker);
 *   • `QR_SCAN` is still unused, so the enum's other value cannot be mistaken for a working path;
 *   • no QR-decoding dependency was added;
 *   • the buyer's own surfaces still offer no check-in control — the gate is a back-office tool;
 *   • the schema still carries the shipped enum (`QR_SCAN | MANUAL`), not the design's
 *     `QR_SCAN | MANUAL_CODE | MANUAL_OVERRIDE` set, so the divergence is documented rather than
 *     papered over with a migration.
 *
 * The gate's correctness — authorization, tenant isolation, idempotency, the refund boundary —
 * was never assertable by a static suite. It is covered by
 * `__tests__/ticketing-checkin/check-in.integration.test.ts` against the real database.
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

describe("P13-10. the gate exists, and only where it should", () => {
    it("has exactly one check-in route, under the protected organizer prefix", () => {
        const routes = walk("app/api")
            .filter((file) => file.endsWith("route.ts"))
            .filter((file) => /check-?in/i.test(file));

        expect(routes).toEqual(["app/api/organizer/events/[id]/check-in/route.ts"]);
        expect(read("proxy.ts")).toContain('"/api/organizer/"');
    });

    it("has one service module, and it is server-only", () => {
        const modules = walk("lib/ticketing/checkin").sort();

        expect(modules).toEqual([
            "lib/ticketing/checkin/service.ts",
            "lib/ticketing/checkin/validation.ts",
        ]);

        // The service reads the session and the database, so it belongs to server code only.
        // No CLIENT component may import it…
        for (const file of walk("components")) {
            expect(read(file)).not.toContain("ticketing/checkin/service");
        }

        // …and the one page that does is a server component, which is what lets the panel be
        // handed data it did not fetch and lets `checkin.scan` be resolved before render.
        const page = read("app/dashboard/events/[id]/page.tsx");

        expect(page).toContain("ticketing/checkin/service");
        expect(page).not.toContain('"use client"');
    });

    it("wires `checkin.scan` into a caller, instead of leaving the permission declared", () => {
        // Declared by the Phase 3 permission map (and it must stay declared)…
        expect(read("lib/authz/permissions.ts")).toContain("checkin.scan");

        // …and now held by a real caller, which is the change Phase 13 made.
        expect(read("lib/ticketing/checkin/service.ts")).toContain(
            "PERMISSIONS.CHECKIN_SCAN"
        );
    });
});

describe("P13-11. the scanner credential the design wants is still unavailable", () => {
    it("the raw scanner token is still never emitted to any client", () => {
        const payload = read("lib/ticketing/tickets/payload.ts");

        expect(payload).toContain("no `qrTokenHash`");
        expect(payload).not.toMatch(/qrTokenHash\s*:/);

        // The QR the buyer is shown is derived from the public lookup code instead.
        expect(read("lib/ticketing/tickets/reference.ts")).toContain(
            'TICKET_QR_PREFIX = "TICKET:"'
        );
    });

    it("the scan path never reads the token or its hash, and never claims QR_SCAN", () => {
        const service = read("lib/ticketing/checkin/service.ts");

        expect(service).not.toMatch(/qrTokenHash\s*:/);
        expect(service).not.toMatch(/hashQrToken/);
        expect(service).toContain('const CHECK_IN_METHOD: CheckInMethod = "MANUAL"');
    });

    it("the schema still lacks the design's CheckIn enum values", () => {
        const schema = read("prisma/schema.prisma");

        // A faithful implementation of the design's full vocabulary needs additive enum values —
        // a migration this phase did not run, because the shipped values cover the manual path.
        expect(schema).not.toContain("MANUAL_OVERRIDE");
        expect(schema).not.toContain("REJECTED_REFUND_PENDING");
        expect(schema).not.toContain("REJECTED_UNAUTHORIZED");

        // The shipped vocabulary is intact.
        expect(schema).toContain("enum CheckInMethod {");
        expect(schema).toContain("QR_SCAN");
        expect(schema).toContain("MANUAL");
    });

    it("the check-in infrastructure that IS locked is left intact", () => {
        const schema = read("prisma/schema.prisma");

        // Phase 3's tenant-scoped staff authority, and the DB-level duplicate guarantee.
        expect(schema).toContain("model StaffEventAssignment {");
        expect(schema).toContain("@@unique([organizerMemberId, eventId])");
        expect(schema).toContain("model CheckIn {");
        expect(schema).toContain("ticketId            String?       @unique");
    });

    it("adds only the intentional jsQR fallback decoder", () => {
        const pkg = JSON.parse(read("package.json")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        const names = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
        ].join(" ");

        // PHASE 21 — jsQR is a deliberate, minimal addition so the laptop webcam scans
        // without the browser-native BarcodeDetector; nothing else is added.
        expect(names).toMatch(/\bjsqr\b/i);
        expect(names).not.toMatch(
            /qr-scanner|zxing|html5-qrcode|instascan|quagga/i
        );
    });
});

describe("P13-12. the buyer's surfaces still offer no check-in affordance", () => {
    it("offers no fake 'validate' control in the ticket UI", () => {
        /*
         * The rule is "no affordance", not "no vocabulary". These files legitimately *discuss*
         * check-in — the e-ticket's header comment explains why there is no validate button, and
         * `admission.scannable` is a server-computed fact the copy renders honestly. What must
         * not exist is an interactive control that appears to do the job: an input, a form, a
         * click handler, or a call to a check-in endpoint.
         *
         * This is unchanged by Phase 13: the gate is a back-office tool, and a buyer has no
         * business admitting their own ticket.
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

    it("keeps the gate behind the organizer dashboard, permission-gated on the server", () => {
        // The panel is rendered only where the page has already resolved `checkin.scan` from the
        // database — a UI visibility decision is never the security control.
        const page = read("app/dashboard/events/[id]/page.tsx");

        expect(page).toContain("requireOrganizerAccess(");
        expect(page).toContain('"checkin.scan"');
        expect(page).toContain('"checkin.log.read"');
        // PHASE 15: the predicate is now time-aware, so the page must pass the SERVER clock
        // it already captured. Asserting the exact call (not a substring) is what keeps a
        // future edit from quietly dropping `now` and re-opening the grace-window bug.
        expect(page).toContain("isEventCheckInOpen(event, now)");
    });
});
