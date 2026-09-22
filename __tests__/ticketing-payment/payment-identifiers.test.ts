import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";

import PaymentInstruction, {
    isSandboxPayment,
    visiblePaymentIdentifiers,
} from "@/components/ticketing/PaymentInstruction";
import type { PaymentInstructionPayload } from "@/lib/ticketing/order-payload";

/**
 * ==========================================
 * SANDBOX PAYMENT IDENTIFIERS (display only)
 * ==========================================
 *
 * The payment page must show the identifiers iPaymu actually returned so a demo operator can
 * identify a transaction — and must show NOTHING that was invented. Two halves, asserted the
 * only way each can honestly be:
 *
 *   • the RENDERED card — read from `react-dom/server` markup — proves which rows appear for
 *     QRIS and for a virtual account, and that a sandbox attempt is labelled;
 *   • the server SOURCE — pinned statically — proves every identifier is mapped off the
 *     `Payment` row the gateway response populated, with no generation anywhere.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function render(instruction: PaymentInstructionPayload): string {
    return renderToStaticMarkup(
        createElement(PaymentInstruction, {
            instruction,
            amount: "150000.00",
            orderNumber: "EVT-1",
        })
    );
}

function instruction(
    overrides: Partial<PaymentInstructionPayload> = {}
): PaymentInstructionPayload {
    return {
        flow: "DIRECT",
        method: "QRIS",
        channel: "mpm",
        kind: "QR",
        url: null,
        number: null,
        qrImageUrl: "data:image/svg+xml;base64,PHN2Zy8+",
        paymentName: "iPaymu PT DEMO IPAYMU",
        providerExpiredAt: "2026-09-22T10:00:00.000Z",
        expiresAt: "2026-09-22T10:00:00.000Z",
        referenceId: "EVT-1789894187056-ef2c2a78",
        providerTransactionId: null,
        providerSessionId: null,
        environment: "SANDBOX",
        ...overrides,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: the identifier list and the sandbox rule
// ─────────────────────────────────────────────────────────────────────────────

describe("PF-ID1. visiblePaymentIdentifiers — real values only, fixed order", () => {
    it("lists Reference ID, Transaction ID and Session ID when all exist", () => {
        expect(
            visiblePaymentIdentifiers({
                referenceId: "EVT-1",
                providerTransactionId: "233592",
                providerSessionId: "SES-9",
            })
        ).toEqual([
            { label: "Reference ID", value: "EVT-1" },
            { label: "Transaction ID", value: "233592" },
            { label: "Session ID", value: "SES-9" },
        ]);
    });

    it("drops every absent, empty or whitespace-only identifier", () => {
        expect(
            visiblePaymentIdentifiers({
                referenceId: "EVT-1",
                providerTransactionId: null,
                providerSessionId: "   ",
            })
        ).toEqual([{ label: "Reference ID", value: "EVT-1" }]);

        expect(
            visiblePaymentIdentifiers({
                referenceId: null,
                providerTransactionId: null,
                providerSessionId: null,
            })
        ).toEqual([]);
    });
});

describe("PF-ID2. isSandboxPayment", () => {
    it("is true only for the SANDBOX snapshot", () => {
        expect(isSandboxPayment({ environment: "SANDBOX" })).toBe(true);
        expect(isSandboxPayment({ environment: "PRODUCTION" })).toBe(false);
        expect(isSandboxPayment({ environment: null })).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendered: QRIS
// ─────────────────────────────────────────────────────────────────────────────

describe("PF-ID3. QRIS shows the real identifiers and never a payment number", () => {
    it("shows Reference ID and Transaction ID when the provider returned them", () => {
        const html = render(
            instruction({
                referenceId: "EVT-1789894187056-ef2c2a78",
                providerTransactionId: "233592",
                providerSessionId: "SES-1",
            })
        );

        expect(html).toContain("Reference ID");
        expect(html).toContain("EVT-1789894187056-ef2c2a78");
        expect(html).toContain("Transaction ID");
        expect(html).toContain("233592");
        expect(html).toContain("Session ID");
        expect(html).toContain("SES-1");
    });

    it("renders the QR image and not a virtual-account number", () => {
        const html = render(instruction({ number: null }));

        // The QR image is the instrument; the reference must never replace it.
        expect(html).toContain("<img");
        expect(html).toContain("data:image/svg+xml;base64,PHN2Zy8+");

        // No VA/retail number, and none of that vocabulary for a QRIS code.
        expect(html).not.toContain("Nomor Virtual Account");
        expect(html).not.toContain("Kode pembayaran");
        expect(html).not.toContain("Referensi iPaymu");
    });

    it("hides a null payment number even if the row still carried one", () => {
        // A QRIS instruction with no provider number must not render an empty value card.
        const html = render(instruction({ number: null }));

        expect(html).not.toMatch(/<code[^>]*>\s*<\/code>/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendered: virtual account
// ─────────────────────────────────────────────────────────────────────────────

describe("PF-ID4. VA shows the account number plus the provider identifiers", () => {
    const va = instruction({
        method: "VIRTUAL_ACCOUNT",
        channel: "bca",
        kind: "NUMBER",
        number: "123456789012",
        paymentName: "BCA",
        qrImageUrl: null,
        referenceId: "EVT-1789894187056-ef2c2a78",
        providerTransactionId: "233707",
    });

    it("shows the bank name, the VA number and its copy affordance", () => {
        const html = render(va);

        expect(html).toContain("Nomor Virtual Account BCA");
        expect(html).toContain("123456789012");
        expect(html).toContain("Salin");
    });

    it("shows Reference ID and Transaction ID", () => {
        const html = render(va);

        expect(html).toContain("Reference ID");
        expect(html).toContain("EVT-1789894187056-ef2c2a78");
        expect(html).toContain("Transaction ID");
        expect(html).toContain("233707");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rendered: sandbox banner and missing identifiers
// ─────────────────────────────────────────────────────────────────────────────

describe("PF-ID5. sandbox labelling and hidden identifiers", () => {
    it("labels a sandbox attempt without calling it paid", () => {
        const html = render(instruction({ environment: "SANDBOX" }));

        expect(html).toContain("SANDBOX PAYMENT");
        // Still pending: the copy must not read as success.
        expect(html).toContain("PENDING");
    });

    it("shows no sandbox banner in production", () => {
        const html = render(instruction({ environment: "PRODUCTION" }));

        expect(html).not.toContain("SANDBOX PAYMENT");
    });

    it("omits the whole identifier card when no identifier exists", () => {
        const html = render(
            instruction({
                referenceId: null,
                providerTransactionId: null,
                providerSessionId: null,
            })
        );

        expect(html).not.toContain("Detail Pembayaran");
        expect(html).not.toContain("Transaction ID");
        expect(html).not.toContain("Session ID");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Server source: the identifiers are mapped off the row, never generated
// ─────────────────────────────────────────────────────────────────────────────

describe("PF-ID6. the payload maps the provider response and invents nothing", () => {
    const payload = code(read("lib/ticketing/order-payload.ts"));

    it("selects the provider identifier columns on the latest payment", () => {
        expect(payload).toContain("providerTransactionId: true");
        expect(payload).toContain("externalSessionId: true");
        expect(payload).toContain("providerEnvironment: true");
    });

    it("maps each identifier straight off the Payment row", () => {
        expect(payload).toMatch(/referenceId: payment\.paymentReference \?\? null/);
        expect(payload).toMatch(
            /providerTransactionId: payment\.providerTransactionId \?\? null/
        );
        expect(payload).toMatch(
            /providerSessionId: payment\.externalSessionId \?\? null/
        );
        expect(payload).toMatch(/environment: payment\.providerEnvironment \?\? null/);
    });

    it("generates no identifier (no random, no uuid, no fallback string)", () => {
        expect(payload).not.toMatch(/Math\.random/);
        expect(payload).not.toMatch(/crypto\.randomUUID/);
        expect(payload).not.toMatch(/uuid/i);
    });

    it("exposes no credential in the customer payload", () => {
        const component = code(read("components/ticketing/PaymentInstruction.tsx"));

        for (const secret of [
            "apiKey",
            "signature",
            "webhookSecret",
            "secretKey",
            "Authorization",
        ]) {
            expect(payload).not.toContain(secret);
            expect(component).not.toContain(secret);
        }
    });
});
