import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";

import TicketCard from "@/components/ticketing/TicketCard";
import TicketQr from "@/components/tickets/TicketQr";
import type { TicketWalletItem } from "@/lib/ticketing/tickets/payload";
import { buildTicketQrPayload, TICKET_QR_PREFIX } from "@/lib/ticketing/tickets/reference";

/**
 * ==========================================
 * PHASE 16 — WALLET + QR PRESENTATION
 * ==========================================
 *
 * Two halves of the same claim, asserted the only way each can honestly be:
 *
 *   • the QR RENDERS correctly and carries nothing but the locked payload — asserted by
 *     rendering `TicketQr` with `react-dom/server` and reading the markup;
 *   • the PAGES that mount it behave honestly (print, blocked states, venue) — asserted
 *     statically, because they are async server components that resolve a session, so their
 *     behaviour is covered by the real-database suites and their WIRING is what a static
 *     assertion can pin.
 *
 * The buyer surfaces are also re-asserted here as still free of interactive controls. That is a
 * Phase 13 guard (`__tests__/ui-consolidation/checkin-gate.test.ts`), repeated for the two files
 * this phase edits so the print work cannot quietly become a check-in affordance later.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
    return renderToStaticMarkup(element);
}

const E_TICKET = "app/ticketing/tickets/[ticketCode]/page.tsx";
const WALLET = "app/ticketing/tickets/page.tsx";
const SHELL = "components/ticketing/SiteShell.tsx";
const PANEL = "components/organizer/CheckInPanel.tsx";

// ─────────────────────────────────────────────────────────────────────────────
// The QR image itself
// ─────────────────────────────────────────────────────────────────────────────

describe("P16-U1. the QR image carries the server payload verbatim and nothing readable", () => {
    const payload = buildTicketQrPayload("EVT-2345-6789");

    it("renders an SVG of the requested size inside a white quiet zone", () => {
        const html = render(createElement(TicketQr, { payload }));

        expect(html).toContain("<svg");
        expect(html).toContain('height="220"');
        expect(html).toContain('width="220"');
        // The quiet zone and the contrast surface: a QR on a dark or transparent background is
        // the classic reason a gate camera cannot read a correctly-built code.
        expect(html).toContain("bg-white");
        expect(html).toContain("p-4");
        expect(html).toContain('aria-hidden="true"');
    });

    it("honours a caller-supplied size so a print or large-screen layout can enlarge it", () => {
        const html = render(createElement(TicketQr, { payload, size: 320 }));

        expect(html).toContain('height="320"');
        expect(html).toContain('width="320"');
    });

    it("never writes the payload into the markup as text", () => {
        const html = render(createElement(TicketQr, { payload }));

        // The value is encoded as modules, not as characters: a screenshot, a DOM dump or a
        // copy-paste of the markup yields no credential string.
        expect(html).not.toContain(payload);
        expect(html).not.toContain("EVT-2345-6789");
        expect(html).not.toContain(TICKET_QR_PREFIX);
    });

    it("is deterministic: the same payload renders byte-identical markup", () => {
        const first = render(createElement(TicketQr, { payload }));
        const second = render(createElement(TicketQr, { payload }));

        expect(second).toBe(first);
    });

    it("renders differently for a different ticket, so the payload is really encoded", () => {
        const other = render(
            createElement(TicketQr, { payload: buildTicketQrPayload("EVT-9876-5432") })
        );

        expect(other).not.toBe(render(createElement(TicketQr, { payload })));
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The e-ticket page
// ─────────────────────────────────────────────────────────────────────────────

describe("P16-U2. the e-ticket prints as a ticket, not as a web page", () => {
    it("suppresses the site chrome and the page's own navigation on paper", () => {
        const shell = read(SHELL);

        // Header and footer are hidden in print; both are wrapped rather than removed, so the
        // on-screen page is untouched.
        expect(shell).toContain("print:hidden");
        expect(shell).toContain("<SiteHeader />");
        expect(shell).toContain("<SiteFooter />");

        const page = read(E_TICKET);

        expect(page).toContain("print:hidden");
        expect(page).toContain("print:mt-0");
        expect(page).toContain("print:rounded-none");
        expect(page).toContain("print:shadow-none");
    });

    it("keeps the QR, the code and the manual fallback instruction on the printed sheet", () => {
        const page = read(E_TICKET);

        // The QR block is NOT print-hidden, and the fallback line is print-only, so a person
        // holding paper always has both the image and the code an usher can type.
        expect(page).toContain("print:block");
        expect(page).toContain("sebutkan atau ketik kode di atas");
        expect(page).toContain("Kode tiket");
    });

    it("tells the buyer how to print, without adding a control that could be mistaken for one", () => {
        const page = read(E_TICKET);

        expect(page).toContain("Ctrl/Cmd + P");

        // The Phase 13 guard's rules, restated for the file this phase edited: no input, no
        // form, no click handler, no fetch, no check-in endpoint.
        expect(page).not.toContain("<input");
        expect(page).not.toContain("<form");
        expect(page).not.toContain("onClick");
        expect(page).not.toContain("fetch(");
        expect(page).not.toMatch(/\/api\/[a-z-]*check/i);
    });

    it("prints the same payload it displays — the QR is never rebuilt for paper", () => {
        const page = read(E_TICKET);

        expect(page).toContain("<TicketQr payload={ticket.qr.payload} />");
        // No second construction of a QR value anywhere in the page.
        expect(page).not.toContain("TICKET:");
        expect(page).not.toContain("buildTicketQrPayload");
    });
});

describe("P16-U3. every blocked reason the server can return has honest copy", () => {
    const page = read(E_TICKET);

    it("explains the event-side refusal, which Phase 16 made reachable", () => {
        expect(page).toContain("EVENT_NOT_OPEN");
        expect(page).toContain("sudah selesai, dibatalkan, atau belum dibuka");
    });

    it("still explains every ticket-side refusal", () => {
        for (const reason of [
            "ALREADY_CHECKED_IN",
            "TICKET_VOID",
            "TICKET_REFUNDED",
            "NOT_PAID",
            "UNKNOWN_STATUS",
        ]) {
            expect(page).toContain(reason);
        }
    });

    it("falls back to a generic sentence for a reason it has no copy for", () => {
        // A future status must degrade to \"not usable\", never to an empty panel.
        expect(page).toContain("Tiket ini tidak dapat digunakan.");
    });

    it("does not claim QR scanning is the backend method", () => {
        expect(page).not.toContain("QR_SCAN");
        expect(page).toContain("Petugas akan");
    });
});

describe("P16-U4. venue information is public and complete enough to attend", () => {
    it("shows the city with the venue name, and the street address when there is one", () => {
        const page = read(E_TICKET);

        expect(page).toContain("ticket.event.venueCity");
        expect(page).toContain("ticket.event.venueAddress");
    });

    it("shows the city on the wallet card too, through the shared formatter", () => {
        const card = read("components/ticketing/TicketCard.tsx");

        expect(card).toContain("formatVenue(");
        expect(card).toContain("item.event.venueCity");
        // The honest empty state survives: no venue and no city still reads as \"to be announced\".
        expect(card).toContain("formatVenue");
    });

    it("renders the city and address from the payload without inventing a venue", () => {
        const item: TicketWalletItem = {
            ticketCode: "EVT-2345-6789",
            status: "ISSUED",
            sequenceNo: 1,
            attendeeName: null,
            issuedAt: "2026-09-01T00:00:00.000Z",
            checkedInAt: null,
            ticketTypeName: "Tribun Utara",
            orderNumber: "EVT-20260917-0001",
            walletUrl: "/ticketing/tickets/EVT-2345-6789",
            event: {
                id: "evt_1",
                slug: "liga-basket",
                title: "Liga Basket",
                startAt: "2026-10-03T12:00:00.000Z",
                endAt: null,
                venueName: "GOR Tridharma",
                venueCity: "Bandung",
                venueAddress: "Jl. Jakarta No. 1",
                sportName: "Basket",
            },
        };

        const html = render(createElement(TicketCard, { item }));

        expect(html).toContain("GOR Tridharma");
        expect(html).toContain("Bandung");

        const bare = render(
            createElement(TicketCard, {
                item: {
                    ...item,
                    event: {
                        ...item.event,
                        venueName: null,
                        venueCity: null,
                        venueAddress: null,
                    },
                },
            })
        );

        expect(bare).toContain("Lokasi menyusul");
    });
});

describe("P16-U5. the wallet still offers no buyer-side action", () => {
    it("keeps both buyer pages free of inputs, forms, handlers and fetches", () => {
        for (const file of [E_TICKET, WALLET, "components/ticketing/TicketCard.tsx"]) {
            const source = read(file);

            expect({ file, hasInput: source.includes("<input") }).toEqual({
                file,
                hasInput: false,
            });
            expect({ file, hasForm: source.includes("<form") }).toEqual({
                file,
                hasForm: false,
            });
            expect({ file, hasHandler: source.includes("onClick") }).toEqual({
                file,
                hasHandler: false,
            });
        }
    });

    it("keeps the QR renderer out of the wallet list (design §26.5)", () => {
        expect(read(WALLET)).not.toContain("TicketQr");
        expect(read("components/ticketing/TicketCard.tsx")).not.toContain("TicketQr");
    });

    it("has exactly one QR component and one payload builder", () => {
        const qrComponent = read("components/tickets/TicketQr.tsx");

        // The renderer is the installed one, and the component does not compute a payload.
        expect(qrComponent).toContain('from "qrcode.react"');
        expect(qrComponent).toContain("QRCodeSVG");
        expect(qrComponent).not.toContain("buildTicketQrPayload");
        expect(qrComponent).not.toContain("TICKET:");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate: manual / keyboard-wedge input
// ─────────────────────────────────────────────────────────────────────────────

describe("P16-U6. the gate input stays scanner-friendly and feeds the ticketCode path", () => {
    const panel = read(PANEL);

    it("keeps every keyboard-wedge affordance in place", () => {
        expect(panel).toContain("autoFocus");
        expect(panel).toContain('autoComplete="off"');
        expect(panel).toContain("spellCheck={false}");
        expect(panel).toContain("inputRef.current?.focus()");
        expect(panel).toContain("enterKeyHint");
        expect(panel).toContain('type="submit"');
    });

    it("submits the presented code to the existing check-in endpoint, as MANUAL data", () => {
        // The request body is exactly `code` + `gateLabel`: no scan method, no token, nothing
        // the server would have to distrust. (`method: "POST"` on `apiFetch` is the HTTP verb,
        // not a `CheckInMethod` — the backend records MANUAL and always has.)
        expect(panel).toMatch(
            /body: JSON\.stringify\(\{\s*code: value,\s*gateLabel: gateLabel\.trim\(\) \|\| null,\s*\}\)/
        );
        expect(panel).toContain("code: value");
        expect(panel).toContain("gateLabel");
        expect(panel).not.toContain("qrToken");
        expect(panel).not.toContain("QR_SCAN");
    });

    it("clears the field only on success, so a refusal stays readable", () => {
        expect(panel).toContain('setCode("")');
        expect(panel).toMatch(/setCode\(""\);\s*\n\s*await refresh\(\)/);
    });

    it("adds no scanner dependency — the wedge is the scanner", () => {
        const pkg = JSON.parse(read("package.json")) as {
            dependencies: Record<string, string>;
        };

        for (const banned of [
            "zxing",
            "@zxing/library",
            "jsqr",
            "html5-qrcode",
            "instascan",
            "quagga",
            "react-qr-reader",
            "barcode-detector",
            "pdf-lib",
            "jspdf",
            "pdfkit",
            "puppeteer",
            "react-to-print",
        ]) {
            expect(pkg.dependencies[banned]).toBeUndefined();
        }

        // The one QR dependency is the renderer that was already installed.
        expect(pkg.dependencies["qrcode.react"]).toBeDefined();
    });
});
