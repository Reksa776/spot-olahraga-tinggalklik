/**
 * ==========================================
 * POST-ISSUANCE TICKET NOTIFICATION — STATIC GUARDS
 * ==========================================
 *
 * These read source, not the database. They protect the boundaries that are easiest to break
 * with one convenient import: issuance must call exactly one approved helper after commit; the
 * helper must not select the scanner credential or run a transport; the template must not
 * pretend a QR image was attached; and no public QR route or migration may appear.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relative: string): string {
    return fs.readFileSync(path.join(root, relative), "utf8");
}

function exists(relative: string): boolean {
    return fs.existsSync(path.join(root, relative));
}

describe("issuance integration is post-commit and singular", () => {
    const issuance = read("lib/ticketing/tickets/issuance.ts");

    test("imports the approved helper once and calls it once", () => {
        expect(issuance).toContain(
            'import { enqueueTicketIssued } from "@/lib/notifications/ticket-issued"'
        );
        expect(issuance.match(/enqueueTicketIssued/g)).toHaveLength(2);
        expect(issuance.match(/await enqueueTicketIssued\(/g)).toHaveLength(1);
    });

    test("the call is inside the post-commit created-rows branch", () => {
        const branch = issuance.indexOf("if (created.length > 0)");
        const call = issuance.indexOf("await enqueueTicketIssued(");

        expect(branch).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(branch);
        expect(issuance.slice(branch, call)).toContain("writeTicketingAudit");
    });

    test("issuance cannot reach the worker, a transport or a provider", () => {
        expect(issuance).not.toMatch(/lib\/notifications\/(worker|transports)/);
        expect(issuance).not.toMatch(/nodemailer|baileys/i);
        expect(issuance).not.toMatch(/prisma\.notification/);
        expect(issuance).not.toMatch(/\.send\s*\(/);
    });

    test("no request path or settlement path imports the ticket helper", () => {
        for (const file of [
            "lib/ticketing/payment/webhook.ts",
            "app/api/ticketing/payment/webhook/route.ts",
            "app/api/ticketing/checkout/route.ts",
            "app/api/ticketing/orders/[orderNumber]/issue/route.ts",
            "lib/ticketing/payment/settlement.ts",
            "lib/notifications/purchase-proof.ts",
        ]) {
            expect(read(file)).not.toContain("ticket-issued");
        }
    });
});

describe("the ticket helper is queue-only and selector-safe", () => {
    const helper = read("lib/notifications/ticket-issued.ts");

    test("uses the trusted configured origin, never a request header", () => {
        expect(helper).toContain(
            'import { getConfiguredAppOrigin } from "@/lib/app-origin"'
        );
        expect(helper).not.toContain("next/headers");
        expect(helper).not.toContain("request.headers");
        expect(helper).not.toContain("x-forwarded-host");
    });

    test("selects public codes only, never the scanner credential", () => {
        expect(helper).toMatch(/ticketCode:\s*true/);
        expect(helper).not.toMatch(/qrTokenHash\s*:\s*true/);
        expect(helper).not.toMatch(/qrToken\s*:\s*true/);
        expect(helper).not.toContain("generateQrToken");
    });

    test("contains no send, provider, worker or attachment path", () => {
        expect(helper).not.toMatch(/\bfetch\s*\(/);
        expect(helper).not.toMatch(/nodemailer|baileys/i);
        expect(helper).not.toMatch(/lib\/notifications\/(worker|transports)/);
        expect(helper).not.toMatch(/processNotificationBatch|claimDueDeliveries/);
        expect(helper).not.toMatch(/prisma\.notification/);
        expect(helper).not.toMatch(/attachments\s*:/);
        expect(helper).not.toContain("qrcode");
    });

    test("structured log fields never carry a ticket code, body or recipient", () => {
        const blocks = helper.match(/structuredLog\([\s\S]*?\n\s*\}\);/g) ?? [];

        expect(blocks.length).toBeGreaterThan(0);

        for (const block of blocks) {
            expect(block).not.toMatch(
                /\b(ticketCode|tickets|recipient|payload|body|text)\s*:/
            );
        }
    });

    test("uses the owner's exact independent idempotency keys and category", () => {
        expect(helper).toContain("`ticket-issued:${orderNumber}:${channel}:${TICKET_ISSUED_VERSION}`");
        expect(helper).toContain('category: "TICKET"');
        expect(helper).toContain('templateKey: TICKET_ISSUED_TEMPLATE_KEY');
        expect(helper).toContain("ticketId: null");
    });

    test("enforces the 30-minute recovery window and the bounded sweep", () => {
        expect(helper).toContain("30 * 60_000");
        expect(helper).toContain("options.limit ?? 20");
        expect(helper).toContain("Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100)");
        expect(helper).toContain("options.minAgeMs ?? 120_000");
        expect(helper).toContain('status: "PAID"');
        expect(helper).toContain('paymentStatus: "PAID"');
        expect(helper).toContain('tickets: { some: { status: "ISSUED" } }');
        expect(helper).toContain('status: { notIn: ["CANCELLED", "ARCHIVED"] }');
    });
});

describe("the template remains code-link only", () => {
    const template = read("lib/notifications/ticket-issued-template.ts");
    const registry = read("lib/notifications/templates.ts");

    test("is registered as ticket-issued.v1", () => {
        expect(registry).toContain(
            "TICKET_ISSUED_TEMPLATE_KEY]: renderTicketIssued"
        );
        expect(template).toContain('export const TICKET_ISSUED_TEMPLATE_KEY = "ticket-issued.v1"');
    });

    test("does not create an image, attachment, or public QR payload", () => {
        expect(template).not.toMatch(/from\s+["']qrcode/);
        expect(template).not.toMatch(/attachments\s*:/);
        expect(template).not.toContain("TICKET:");
        expect(template).not.toContain("buildTicketQrPayload");
        expect(template).not.toContain("qrTokenHash");
    });

    test("prints at most 20 public codes", () => {
        expect(template).toContain("const MAX_TICKETS = 20");
        expect(template).toContain("codes.slice(0, MAX_TICKETS)");
    });
});

describe("the manual sweep is enqueue-only", () => {
    const sweep = read("scripts/ticket-issued-sweep.ts");
    const pkg = JSON.parse(read("package.json")) as {
        scripts?: Record<string, string>;
    };

    test("calls the bounded helper and no sender", () => {
        expect(sweep).toContain("sweepMissingTicketNotifications");
        expect(sweep).not.toMatch(/lib\/notifications\/(worker|transports)/);
        expect(sweep).not.toMatch(/nodemailer|baileys/i);
        expect(sweep).not.toMatch(/processNotificationBatch|\.send\s*\(/);
    });

    test("is exposed as a manual npm script, not a scheduler", () => {
        expect(pkg.scripts?.["sweep:ticket-issued"]).toBe(
            "npx tsx scripts/ticket-issued-sweep.ts"
        );
    });
});

describe("no new public surface or migration was introduced", () => {
    test("no ticket-issued or QR route directory exists", () => {
        expect(exists("app/api/ticketing/ticket-issued")).toBe(false);
        expect(exists("app/api/ticketing/tickets/qr")).toBe(false);
        expect(exists("app/api/ticketing/tickets/[ticketCode]/qr")).toBe(false);
    });

    test("no migration directory was added", () => {
        const migrations = fs
            .readdirSync(path.join(root, "prisma", "migrations"), {
                withFileTypes: true,
            })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        expect(
            migrations.some((name) => /ticket.?issued|ticket.?notification/i.test(name))
        ).toBe(false);
    });

    test("check-in and wallet modules were not wired to this feature", () => {
        expect(read("lib/ticketing/checkin/service.ts")).not.toContain(
            "ticket-issued"
        );
        expect(read("app/api/ticketing/tickets/[ticketCode]/route.ts")).not.toContain(
            "ticket-issued"
        );
    });

    test("the kill switch and dry-run transports stay configured off", () => {
        const env = read(".env.example");

        expect(env).toContain('NOTIFICATIONS_ENABLED="false"');
        expect(env).toContain('EMAIL_TRANSPORT="dry-run"');
        expect(env).toContain('WHATSAPP_TRANSPORT="dry-run"');
    });
});
