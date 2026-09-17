/**
 * ==========================================
 * PHASE 5 — ROUTE & PERMISSION WIRING (source analysis)
 * ==========================================
 *
 * These are structural assertions, and they exist because the properties they protect
 * are invisible in a passing behaviour test: a mutation route that forgets
 * `requireSameOrigin` still returns the right JSON, and a service that stops checking
 * `ticket_type.quota.change` still lets an OWNER change a quota.
 *
 * Two of the checks below are the only available evidence for a real gap rather than a
 * redundant restatement of one:
 *
 *   1. The quota/price permission split cannot be exercised by any role today — every
 *      role holding `ticket_type.write` also holds both sub-permissions — so the
 *      *existence* of the separate checks is asserted here and the latent-ness is
 *      recorded in the Phase 5 report as a WARNING.
 *   2. CSRF on the two new mutation routes is otherwise only observable through a real
 *      HTTP request, which this suite cannot make.
 */

import fs from "fs";
import path from "path";

const ROUTE_DIR = path.join(
    process.cwd(),
    "app/api/organizer/events/[id]/ticket-types"
);

const COLLECTION = path.join(ROUTE_DIR, "route.ts");
const ITEM = path.join(ROUTE_DIR, "[ticketTypeId]/route.ts");
const SERVICE = path.join(process.cwd(), "lib/ticket-types/service.ts");

/** Strip comments so prose about a guard cannot satisfy an assertion about the code. */
function codeOf(file: string): string {
    return fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

describe("the ticket type routes exist at the documented paths", () => {
    test.each([COLLECTION, ITEM])("%s is present", (file) => {
        expect(fs.existsSync(file)).toBe(true);
    });

    test("the collection route exposes GET and POST", () => {
        const code = codeOf(COLLECTION);

        expect(code).toMatch(/export async function GET\(/);
        expect(code).toMatch(/export async function POST\(/);
    });

    test("the item route exposes GET, PATCH and DELETE", () => {
        const code = codeOf(ITEM);

        expect(code).toMatch(/export async function GET\(/);
        expect(code).toMatch(/export async function PATCH\(/);
        expect(code).toMatch(/export async function DELETE\(/);
    });
});

describe("every handler resolves identity server-side", () => {
    test.each([COLLECTION, ITEM])("%s calls requireAuth in each handler", (file) => {
        const code = codeOf(file);

        const handlerCount = (
            code.match(/export async function (GET|POST|PATCH|DELETE)\(/g) ?? []
        ).length;

        expect(handlerCount).toBeGreaterThan(0);
        expect((code.match(/await requireAuth\(\)/g) ?? []).length).toBe(
            handlerCount
        );
    });

    test("no route authorizes with a legacy role comparison", () => {
        for (const file of [COLLECTION, ITEM]) {
            const code = codeOf(file);

            expect(code).not.toMatch(/session\.user\.role/);
            expect(code).not.toMatch(/platformRole\s*===\s*"ADMIN"/);
            expect(code).not.toMatch(/isAdmin\(/);
        }
    });
});

describe("state-changing handlers keep the Phase 3 CSRF check", () => {
    test.each([COLLECTION, ITEM])(
        "%s checks same-origin in every mutating handler",
        (file) => {
            const code = codeOf(file);

            const mutating = (
                code.match(/export async function (POST|PATCH|DELETE)\(/g) ?? []
            ).length;

            expect(mutating).toBeGreaterThan(0);
            // `requireSameOrigin` is synchronous (it returns `{ error }`), matching the
            // Phase 4 convention — so the assertion must not require `await`.
            expect((code.match(/requireSameOrigin\(request\)/g) ?? []).length).toBe(
                mutating
            );
        }
    );

    test("GET handlers do NOT require same-origin (they are safe reads)", () => {
        const code = codeOf(COLLECTION);

        // The GET handler body must not contain the check; only mutations do.
        const getBody = code.slice(
            code.indexOf("export async function GET("),
            code.indexOf("export async function POST(")
        );

        expect(getBody).not.toMatch(/requireSameOrigin/);
    });
});

describe("routes delegate to the service rather than touching inventory", () => {
    test.each([COLLECTION, ITEM])("%s never writes a ticket type directly", (file) => {
        const code = codeOf(file);

        expect(code).not.toMatch(/prisma\.ticketType\.(update|delete|create)/);
        expect(code).not.toMatch(/\$executeRaw/);
    });

    test("routes never name an inventory counter", () => {
        for (const file of [COLLECTION, ITEM]) {
            const code = codeOf(file);

            expect(code).not.toMatch(/\bsold\b/);
            expect(code).not.toMatch(/\breserved\b/);
            expect(code).not.toMatch(/\bversion\b/);
        }
    });

    test("the routes reuse the shared response and validation infrastructure", () => {
        for (const file of [COLLECTION, ITEM]) {
            const code = codeOf(file);

            expect(code).toMatch(/from "@\/lib\/api\/response"/);
            expect(code).toMatch(/handleApi/);
        }

        expect(codeOf(COLLECTION)).toMatch(/parseOrThrow/);
        expect(codeOf(ITEM)).toMatch(/parseOrThrow/);
    });
});

describe("the quota/price permission split is wired (latent today)", () => {
    const service = codeOf(SERVICE);

    test("creating and updating require ticket_type.write", () => {
        expect(service).toMatch(/PERMISSIONS\.TICKET_TYPE_WRITE/);
    });

    test("changing the QUOTA requires its own separate permission check", () => {
        // The assertion is on the specific permission being passed to a guard, not on
        // the constant merely appearing.
        expect(service).toMatch(
            /requireOrganizerAccess\(\s*access\.organizerId,\s*PERMISSIONS\.TICKET_TYPE_QUOTA_CHANGE\s*\)/
        );
    });

    test("changing the PRICE requires its own separate permission check", () => {
        expect(service).toMatch(
            /requireOrganizerAccess\(\s*access\.organizerId,\s*PERMISSIONS\.TICKET_TYPE_PRICE_CHANGE\s*\)/
        );
    });

    test("the three permissions are three distinct strings", async () => {
        // Imported from the pure permissions module, NOT the `@/lib/authz` barrel:
        // the barrel pulls in the Auth.js/NextAuth module graph, which is why the
        // Phase 3 pure suite deliberately imports the leaf modules.
        const { PERMISSIONS } = await import("@/lib/authz/permissions");

        const trio = [
            PERMISSIONS.TICKET_TYPE_WRITE,
            PERMISSIONS.TICKET_TYPE_QUOTA_CHANGE,
            PERMISSIONS.TICKET_TYPE_PRICE_CHANGE,
        ];

        expect(new Set(trio).size).toBe(3);
    });
});

describe("the service never writes an inventory counter", () => {
    const service = codeOf(SERVICE);

    test("no counter is assigned into Prisma update/create data", () => {
        // Targeted deliberately. The service DOES legitimately mention these fields —
        // in type annotations (`sold: number;`) and in audit payloads
        // (`beforeState: { sold: before.sold }`) — so a bare `\bsold\s*:` scan
        // produces false positives. That is the same over-broad-scan trap that
        // generated phantom mismatches in Phase 2.5 and Phase 4.
        //
        // What must genuinely never happen is a counter being *mutated* here: a
        // read-modify-write against these fields is exactly how overselling is
        // introduced, and it is what the atomic inventory module exists to replace.
        expect(service).not.toMatch(/data\.(sold|reserved|version)\s*=/);
        expect(service).not.toMatch(/\b(sold|reserved|version)\s*[-+*/]=/);
        expect(service).not.toMatch(/increment:\s*[^,}]*(sold|reserved|version)/);
    });

    test("no raw SQL in the service (counting belongs to the inventory module)", () => {
        expect(service).not.toMatch(/\$executeRaw/);
    });
});
