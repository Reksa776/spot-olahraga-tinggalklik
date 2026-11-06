/**
 * ==========================================
 * PHASE 2 — STATIC GUARDS
 * ==========================================
 *
 * The properties that make Phase 2 safe are easy to undo with one innocent import. These read
 * the source and assert the boundaries:
 *
 *   • one integration point, inside the SETTLED branch, after the commit;
 *   • the webhook / issuance / checkout request paths stay notification-free;
 *   • no SMTP or Baileys module on the proof path, and no scanner secret in the snapshot;
 *   • no new migration / no new table / no public route;
 *   • the kill switch stays OFF in the environment template;
 *   • the owner's opening sentence stays verbatim.
 */

import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relative: string): string {
    return fs.readFileSync(path.join(root, relative), "utf8");
}

describe("the settlement hook is singular and post-commit", () => {
    test("settlement.ts imports the helper and calls it once, inside the SETTLED branch", () => {
        const source = read("lib/ticketing/payment/settlement.ts");

        expect(source).toContain(
            'import { enqueuePurchaseProof } from "@/lib/notifications/purchase-proof"'
        );
        expect(source.match(/await enqueuePurchaseProof\(/g)).toHaveLength(1);
        expect(source).toMatch(
            /if \(settled\.outcome === "SETTLED"\) \{\s*try \{\s*await enqueuePurchaseProof\(input\.orderId\)/
        );

        // The call is after the transaction result, not inside the `$transaction` callback.
        const transactionEnd = source.indexOf("const settled = result.value;");
        const call = source.indexOf("await enqueuePurchaseProof(");

        expect(transactionEnd).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(transactionEnd);
    });

    test("no request path imports the notification foundation", () => {
        const guarded = [
            "lib/ticketing/payment/webhook.ts",
            "app/api/ticketing/payment/webhook/route.ts",
            "app/api/ticketing/checkout/route.ts",
            "app/api/ticketing/orders/[orderNumber]/issue/route.ts",
        ];

        for (const file of guarded) {
            expect(read(file)).not.toContain("lib/notifications");
        }
    });

    test("issuance imports only the approved post-commit ticket-issued helper", () => {
        const source = read("lib/ticketing/tickets/issuance.ts");

        expect(source).toContain(
            'import { enqueueTicketIssued } from "@/lib/notifications/ticket-issued"'
        );
        expect(source.match(/await enqueueTicketIssued\(/g)).toHaveLength(1);
        expect(source).not.toMatch(/lib\/notifications\/(worker|transports)/);
        expect(source).not.toMatch(/nodemailer|baileys/i);
        expect(source).not.toMatch(/prisma\.notification/);

        // The call is inside the `created.length > 0` post-commit branch, after the audit.
        const branch = source.indexOf("if (created.length > 0)");
        const call = source.indexOf("await enqueueTicketIssued(");
        expect(branch).toBeGreaterThan(-1);
        expect(call).toBeGreaterThan(branch);
    });

    test("the ticket helper is not imported by a request path or purchase proof", () => {
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

describe("no live provider is reachable from the proof path", () => {
    test("the proof service and template import neither nodemailer nor Baileys", () => {
        for (const file of [
            "lib/notifications/purchase-proof.ts",
            "lib/notifications/purchase-proof-template.ts",
            "lib/notifications/contacts.ts",
            "lib/notifications/store-contact.ts",
            "lib/notifications/enqueue.ts",
            "lib/notifications/worker.ts",
        ]) {
            const source = read(file);

            expect(source).not.toMatch(/from\s+["']nodemailer["']/);
            expect(source).not.toMatch(/from\s+["']@whiskeysockets\/baileys["']/);
        }
    });

    test("the adapter stubs still throw and cannot be constructed", () => {
        expect(read("lib/notifications/transports/smtp.ts")).toContain(
            "throw new Phase1TransportRefusedError"
        );
        expect(read("lib/notifications/transports/baileys.ts")).toContain(
            "throw new Phase1WhatsAppRefusedError"
        );
    });

    test("the proof snapshot never selects a scanner secret or a payment URL", () => {
        const source = read("lib/notifications/purchase-proof.ts");

        // The comment may NAME the column it refuses to select; the query must not select it.
        expect(source).not.toMatch(/qrTokenHash\s*:\s*true/);
        expect(source).not.toMatch(/qrToken\s*:\s*true/);
        expect(source).not.toContain("paymentUrl");
        expect(source).not.toContain("providerTransactionId");
    });
});

describe("Phase 2 adds no schema, migration, route or activation", () => {
    test("the environment template keeps the kill switch OFF and adds only policy knobs", () => {
        const env = read(".env.example");

        expect(env).toContain('NOTIFICATIONS_ENABLED="false"');
        expect(env).toContain('EMAIL_TRANSPORT="dry-run"');
        expect(env).toContain('WHATSAPP_TRANSPORT="dry-run"');
        expect(env).toContain("WHATSAPP_DAILY_CAP=");
        expect(env).toContain("WHATSAPP_SEND_DELAY_MS=");
    });

    test("no Phase 2 migration directory exists and no queue column was added", () => {
        const migrations = fs
            .readdirSync(path.join(root, "prisma", "migrations"), {
                withFileTypes: true,
            })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        expect(
            migrations.some((name) => /purchase.?proof|ticket.?issued/i.test(name))
        ).toBe(false);

        const schema = read("prisma/schema.prisma");
        const delivery = schema
            .split("model NotificationDelivery {")[1]
            .split("\n}")[0];

        expect(delivery).not.toMatch(/lockedUntil|lockedBy/);
    });

    test("no public QR/ticket route was added for the proof", () => {
        const route = path.join(
            root,
            "app",
            "api",
            "ticketing",
            "purchase-proof"
        );

        expect(fs.existsSync(route)).toBe(false);
        expect(
            read("lib/notifications/purchase-proof-template.ts")
        ).not.toMatch(/qrTokenHash\s*:\s*true/);
    });
});

describe("the owner's copy is verbatim", () => {
    test("the opening sentence matches exactly", () => {
        expect(read("lib/notifications/purchase-proof-template.ts")).toContain(
            '"Bukti pembelian Anda telah berhasil dikonfirmasi. Simpan pesan ini sebagai referensi transaksi Anda."'
        );
    });
});
