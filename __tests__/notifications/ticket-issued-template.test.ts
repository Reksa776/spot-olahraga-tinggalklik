/**
 * ==========================================
 * TICKET ISSUED TEMPLATE — PURE RENDERING
 * ==========================================
 *
 * No database, no transport. The template receives a prepared snapshot and must print only
 * public ticket codes, a valid wallet link, and no scanner credential or internal id.
 */

import {
    renderTicketIssued,
    TICKET_ISSUED_OPENING,
    TICKET_ISSUED_TEMPLATE_KEY,
    type TicketIssuedPayload,
} from "@/lib/notifications/ticket-issued-template";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

function code(index: number): string {
    let value = "";

    for (let position = 0; position < 8; position += 1) {
        value += ALPHABET[(index >> (position * 5)) & 31];
    }

    return `EVT-${value.slice(0, 4)}-${value.slice(4)}`;
}

function payload(
    overrides: Partial<TicketIssuedPayload> = {}
): Record<string, unknown> {
    return {
        version: "v1",
        orderNumber: "TKL-ORD-2026-000123",
        event: {
            title: "Jakarta Run 2026",
            startAt: "2026-12-01T00:00:00.000Z",
            endAt: "2026-12-01T04:00:00.000Z",
            timezone: "Asia/Jakarta",
            venueName: "GBK",
            venueAddress: "Jl. Pintu Satu Senayan",
            venueCity: "Jakarta",
        },
        ticketCount: 2,
        tickets: [{ ticketCode: code(1) }, { ticketCode: code(2) }],
        walletUrl: "https://app.example.test/ticketing/tickets",
        store: {
            name: "TinggalKlik.Co",
            email: "halo@example.test",
            phone: "081234567890",
            address: "Jl. Contoh 1",
        },
        ...overrides,
    };
}

describe("ticket-issued.v1", () => {
    test("prints the approved opening and the snapshot fields", () => {
        const rendered = renderTicketIssued(payload());

        expect(TICKET_ISSUED_TEMPLATE_KEY).toBe("ticket-issued.v1");
        expect(rendered.text.startsWith(TICKET_ISSUED_OPENING)).toBe(true);
        expect(rendered.text).toContain("Nomor transaksi: TKL-ORD-2026-000123");
        expect(rendered.text).toContain("Event: Jakarta Run 2026");
        expect(rendered.text).toContain("GBK, Jl. Pintu Satu Senayan, Jakarta");
        expect(rendered.text).toContain("Jumlah tiket: 2");
        expect(rendered.text).toContain(`1. ${code(1)}`);
        expect(rendered.text).toContain(`2. ${code(2)}`);
        expect(rendered.text).toContain(
            "https://app.example.test/ticketing/tickets"
        );
        expect(rendered.text).toContain(
            "E-tiket ini bersifat pribadi. Jangan bagikan tangkapan layarnya."
        );
        expect(rendered.text).toContain("Kontak toko — TinggalKlik.Co:");
        expect(rendered.text).toContain("Email: halo@example.test");
        expect(rendered.text).toContain("Telepon: 081234567890");
        expect(rendered.text).toContain("Alamat: Jl. Contoh 1");
        expect(rendered.subject).toContain("Tiket Anda");
    });

    test("caps the printed codes at 20 and points to the wallet for the rest", () => {
        const tickets = Array.from({ length: 25 }, (_, index) => ({
            ticketCode: code(index),
        }));
        const rendered = renderTicketIssued(
            payload({ ticketCount: 25, tickets })
        );

        for (let index = 0; index < 20; index += 1) {
            expect(rendered.text).toContain(`${index + 1}. ${code(index)}`);
        }

        expect(rendered.text).not.toContain("21. ");
        expect(rendered.text).toContain(
            "Seluruh tiket dapat dilihat melalui halaman Tiket Saya."
        );
        expect(rendered.text).not.toMatch(/5 tiket lainnya|5 kode/i);
        expect(rendered.text).not.toContain(code(20));
    });

    test("omits malformed, duplicate and non-public ticket values", () => {
        const invalid = "not-a-ticket";
        const rendered = renderTicketIssued(
            payload({
                tickets: [
                    { ticketCode: code(1) },
                    { ticketCode: code(1) },
                    { ticketCode: invalid },
                    { ticketCode: "EVT-0000-1111" },
                ],
                ticketCount: 2,
            })
        );

        expect(rendered.text.match(new RegExp(code(1), "g"))).toHaveLength(1);
        expect(rendered.text).not.toContain(invalid);
        expect(rendered.text).not.toContain("EVT-0000-1111");
    });

    test("is resilient when optional venue, store and wallet fields are absent", () => {
        const rendered = renderTicketIssued(
            payload({
                event: {
                    title: "Event Tanpa Venue",
                    startAt: "2026-12-01T00:00:00.000Z",
                    endAt: null,
                    timezone: "Asia/Jakarta",
                    venueName: null,
                    venueAddress: null,
                    venueCity: null,
                },
                walletUrl: null,
                store: null,
            })
        );

        expect(rendered.text).not.toContain("Lokasi:");
        expect(rendered.text).not.toContain("Kontak toko");
        expect(rendered.text).toContain(
            "Buka halaman Tiket Saya di aplikasi untuk melihat e-tiket dan QR Anda."
        );
    });

    test("never prints a scanner hash, an internal id, or a forged QR payload", () => {
        const rendered = renderTicketIssued(payload());
        const body = rendered.text;

        expect(body).not.toContain("qrTokenHash");
        expect(body).not.toContain("TICKET:");
        expect(body).not.toContain("scanner");
        expect(body).not.toMatch(/orderId|eventId|organizerId|ticketId/i);
        expect(body).not.toContain("attachment");
    });

    test("rejects a non-http wallet URL instead of printing it", () => {
        const rendered = renderTicketIssued(
            payload({ walletUrl: "javascript:alert(1)" })
        );

        expect(rendered.text).not.toContain("javascript:");
        expect(rendered.text).toContain(
            "Buka halaman Tiket Saya di aplikasi untuk melihat e-tiket dan QR Anda."
        );
    });
});
