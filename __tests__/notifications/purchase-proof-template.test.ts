/**
 * ==========================================
 * PHASE 2 — PURCHASE PROOF TEMPLATE, CONTACTS, STORE CONTACT (PURE)
 * ==========================================
 *
 * No database and no network. These assertions are the owner's content decisions made
 * checkable: the exact opening sentence, Indonesian professional wording, snapshot money,
 * optional store contact, bounded item list, and a ticket section that carries only the PUBLIC
 * code — never a scanner token, a payment URL or an internal id.
 */

import {
    normalizeEmail,
    normalizeIndonesianPhone,
    normalizeRecipient,
} from "@/lib/notifications/contacts";
import {
    PURCHASE_PROOF_OPENING,
    PURCHASE_PROOF_TEMPLATE_KEY,
    formatPurchaseProofMoney,
    renderPurchaseProof,
} from "@/lib/notifications/purchase-proof-template";
import { buildStoreContact } from "@/lib/notifications/store-contact";
import { hasTemplate } from "@/lib/notifications/templates";

function payload(overrides: Record<string, unknown> = {}) {
    return {
        version: "v1",
        orderNumber: "TKL-ORD-2026-000123",
        buyerName: "Budi Santoso",
        paidAt: "2026-11-04T10:15:00.000Z",
        createdAt: "2026-11-04T10:00:00.000Z",
        currency: "IDR",
        items: [
            {
                name: "VIP",
                quantity: 2,
                unitPrice: "150000.00",
                subtotal: "300000.00",
            },
            {
                name: "Reguler",
                quantity: 1,
                unitPrice: "75000.00",
                subtotal: "75000.00",
            },
        ],
        itemCount: 3,
        subtotal: "375000.00",
        discount: "0.00",
        total: "375000.00",
        paymentMethod: "VIRTUAL_ACCOUNT",
        paymentChannel: "bca",
        paymentStatus: "PAID",
        event: {
            title: "Jakarta Marathon 2026",
            startAt: "2026-12-01T00:00:00.000Z",
            endAt: "2026-12-01T04:00:00.000Z",
            timezone: "Asia/Jakarta",
            venueName: "GBK",
            venueAddress: "Jl. Pintu Satu Senayan",
            venueCity: "Jakarta",
        },
        organizerName: "Panitia Lari Nusantara",
        store: {
            name: "TinggalKlik.Co",
            email: "halo@tinggalklik.test",
            phone: "081234567890",
            address: "Jl. Contoh No. 1, Jakarta",
        },
        tickets: [{ ticketCode: "EVT-7K3M-9A2B" }],
        ...overrides,
    };
}

describe("contact normalization", () => {
    test.each([
        ["081234567890", "6281234567890"],
        ["0812-3456-7890", "6281234567890"],
        ["+62 812 3456 7890", "6281234567890"],
        ["62 812 3456 7890", "6281234567890"],
        ["81234567890", "6281234567890"],
    ])("%s becomes %s", (input, expected) => {
        expect(normalizeIndonesianPhone(input)).toBe(expected);
    });

    test.each([
        ["", null],
        ["abc", null],
        ["0212345678", null], // landline: WhatsApp cannot receive it
        ["+1 415 555 0100", null],
        ["0812", null],
        ["0812+3456789", null],
    ])("an unusable number %s is refused", (input, expected) => {
        expect(normalizeIndonesianPhone(input)).toBe(expected);
    });

    test("email keeps its local part and lower-cases only the domain", () => {
        expect(normalizeEmail(" Budi.Santoso@Example.TEST ")).toBe(
            "Budi.Santoso@example.test"
        );
        expect(normalizeEmail("not-an-email")).toBeNull();
        expect(normalizeEmail("a@b")).toBeNull();
        expect(normalizeEmail("")).toBeNull();
        expect(normalizeEmail(null)).toBeNull();
    });

    test("recipient normalization is channel-specific", () => {
        expect(normalizeRecipient("EMAIL", "budi@example.test")).toBe(
            "budi@example.test"
        );
        expect(normalizeRecipient("WHATSAPP", "0812-3456-7890")).toBe(
            "6281234567890"
        );
    });
});

describe("store contact is optional and never invented", () => {
    test("a configured row yields only what is present", () => {
        expect(
            buildStoreContact({
                platformName: "TinggalKlik.Co",
                email: "halo@example.test",
                phone: "081234567890",
                address: "Jl. Contoh 1",
            })
        ).toEqual({
            name: "TinggalKlik.Co",
            email: "halo@example.test",
            phone: "081234567890",
            address: "Jl. Contoh 1",
        });
    });

    test("blank or invalid fields are omitted, and no contact block is invented", () => {
        expect(
            buildStoreContact({
                platformName: "TinggalKlik.Co",
                email: "not-an-email",
                phone: "abc",
                address: "   ",
            })
        ).toBeNull();

        expect(
            buildStoreContact({
                platformName: "TinggalKlik.Co",
                email: null,
                phone: "081234567890",
                address: "Jl. Contoh 1",
            })
        ).toEqual({
            name: "TinggalKlik.Co",
            email: null,
            phone: "081234567890",
            address: "Jl. Contoh 1",
        });
    });

    test("a missing singleton row yields null", () => {
        expect(buildStoreContact(null)).toBeNull();
    });
});

describe("purchase-proof.v1 content", () => {
    test("is registered; later phases register their own templates", () => {
        expect(hasTemplate(PURCHASE_PROOF_TEMPLATE_KEY)).toBe(true);
        expect(hasTemplate("purchase-proof.v2")).toBe(false);
        // Phase 4 registers its own reminder; Phase 5's document template stays absent.
        expect(hasTemplate("reminder.h36.v1")).toBe(true);
        expect(hasTemplate("event-document.v1")).toBe(false);
    });

    test("opens with the owner's sentence, verbatim", () => {
        const rendered = renderPurchaseProof(payload());

        expect(rendered.text.split("\n")[0]).toBe(PURCHASE_PROOF_OPENING);
        expect(rendered.subject).toBe(
            "Bukti pembelian TKL-ORD-2026-000123 — Jakarta Marathon 2026"
        );
    });

    test("prints the stored snapshots, not current catalogue values", () => {
        const text = renderPurchaseProof(payload()).text;

        expect(text).toContain("Nomor transaksi: TKL-ORD-2026-000123");
        expect(text).toContain("Nama pembeli: Budi Santoso");
        expect(text).toContain("VIP — 2 × Rp150.000 = Rp300.000");
        expect(text).toContain("Reguler — 1 × Rp75.000 = Rp75.000");
        expect(text).toContain("Subtotal: Rp375.000");
        expect(text).toContain("Total pembayaran: Rp375.000");
        expect(text).toContain(
            "Metode pembayaran: Transfer bank (Virtual Account) — BCA"
        );
        expect(text).toContain("Status pembayaran: Lunas");
        expect(text).toContain("Penyelenggara: Panitia Lari Nusantara");
    });

    test("shows the venue and the configured store contact", () => {
        const text = renderPurchaseProof(payload()).text;

        expect(text).toContain("Lokasi: GBK, Jl. Pintu Satu Senayan, Jakarta");
        expect(text).toContain("Kontak toko — TinggalKlik.Co:");
        expect(text).toContain("Email: halo@tinggalklik.test");
        expect(text).toContain("Telepon: 081234567890");
        expect(text).toContain("Alamat: Jl. Contoh No. 1, Jakarta");
    });

    test("an empty store contact renders no contact section and does not throw", () => {
        const text = renderPurchaseProof(payload({ store: null })).text;

        expect(text).not.toContain("Kontak toko");
        expect(text).toContain("Total pembayaran: Rp375.000");
    });

    test("a long item list is capped with an explicit omission note", () => {
        const items = Array.from({ length: 15 }, (_, index) => ({
            name: `Kategori ${index + 1}`,
            quantity: 1,
            unitPrice: "10000.00",
            subtotal: "10000.00",
        }));

        const text = renderPurchaseProof(
            payload({ items, itemCount: 15, subtotal: "150000.00", total: "150000.00" })
        ).text;

        expect(text).toContain("Kategori 10");
        expect(text).not.toContain("Kategori 11");
        expect(text).toContain("… dan 5 item lainnya.");
    });

    test("discount is shown only when it is non-zero", () => {
        expect(renderPurchaseProof(payload()).text).not.toContain("Diskon:");
        expect(
            renderPurchaseProof(
                payload({ discount: "25000.00", total: "350000.00" })
            ).text
        ).toContain("Diskon: -Rp25.000");
    });

    test("tickets print the public code and the public QR payload only", () => {
        const text = renderPurchaseProof(payload()).text;

        expect(text).toContain("- EVT-7K3M-9A2B (QR: TICKET:EVT-7K3M-9A2B)");
        // A malformed/secret-looking value is refused rather than echoed.
        const rejected = renderPurchaseProof(
            payload({
                tickets: [
                    { ticketCode: "qr-secret-token-value" },
                    { ticketCode: "EVT-0000-1111" },
                ],
            })
        ).text;

        expect(rejected).not.toContain("qr-secret-token-value");
        expect(rejected).not.toContain("EVT-0000-1111");
        expect(rejected).toContain(
            "Tiket akan tersedia di halaman pesanan Anda setelah diterbitkan."
        );
    });

    test("a missing ticket snapshot states the fact instead of inventing a code", () => {
        expect(
            renderPurchaseProof(payload({ tickets: [] })).text
        ).toContain(
            "Tiket akan tersedia di halaman pesanan Anda setelah diterbitkan."
        );
    });

    test("carries no internal id, payment URL, contact, token or provider handle", () => {
        const rendered = renderPurchaseProof(
            payload({
                orderId: "cm_internal_cuid_should_never_print",
                paymentUrl: "https://gateway.example/pay/expired",
                buyerEmail: "budi@example.test",
                buyerPhone: "081234567890",
                qrToken: "raw-scanner-secret",
                ticketId: "cm_ticket_internal",
                // The store's OWN phone is legitimately printed by the receipt; this test is
                // about the buyer's contact and internal fields, so the block is absent.
                store: null,
            })
        );
        const all = `${rendered.subject}\n${rendered.text}`;

        expect(all).not.toContain("cm_internal_cuid");
        expect(all).not.toContain("gateway.example");
        expect(all).not.toContain("budi@example.test");
        expect(all).not.toContain("081234567890");
        expect(all).not.toContain("raw-scanner-secret");
        expect(all).not.toContain("cm_ticket_internal");
    });

    test("a newline in a product name cannot become a new message line", () => {
        const text = renderPurchaseProof(
            payload({
                items: [
                    {
                        name: "VIP\nTotal pembayaran: Rp0",
                        quantity: 1,
                        unitPrice: "150000.00",
                        subtotal: "150000.00",
                    },
                ],
                itemCount: 1,
            })
        ).text;

        expect(text).toContain(
            "VIP Total pembayaran: Rp0 — 1 × Rp150.000 = Rp150.000"
        );
        expect(text).not.toContain("\nTotal pembayaran: Rp0");
    });
});

describe("money formatting stays exact", () => {
    test("groups rupiah without a binary-float round trip", () => {
        expect(formatPurchaseProofMoney("1234567.00", "IDR")).toBe("Rp1.234.567");
        expect(formatPurchaseProofMoney("1234567.50", "IDR")).toBe(
            "Rp1.234.567,50"
        );
        expect(formatPurchaseProofMoney("0.00", "IDR")).toBe("Rp0");
        expect(formatPurchaseProofMoney("not-money", "IDR")).toBe("—");
        expect(formatPurchaseProofMoney("100.00", "USD")).toBe("USD 100");
    });
});
