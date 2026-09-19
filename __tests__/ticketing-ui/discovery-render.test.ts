import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import EventCard from "@/components/events/EventCard";
import CatalogFilters from "@/components/ticketing/CatalogFilters";
import CatalogPagination from "@/components/ticketing/CatalogPagination";
import EmptyState from "@/components/ticketing/EmptyState";
import SectionHeader from "@/components/ticketing/SectionHeader";
import SportGrid, { type SportOption } from "@/components/ticketing/SportGrid";
import StickyBuyBar from "@/components/ticketing/StickyBuyBar";
import TicketCard from "@/components/ticketing/TicketCard";
import type { PublicEventCard } from "@/lib/events/catalog";
import type { TicketWalletItem } from "@/lib/ticketing/tickets/payload";

/**
 * ==========================================
 * PHASE 9 — DISCOVERY COMPONENT RENDER
 * ==========================================
 *
 * The new UI is server-rendered, so it can be asserted as HTML without a browser or a DOM: the
 * components are pure functions of props, and the props are exactly the public payloads the server
 * produces (built here from fixtures shaped like `PublicEventCard` / `TicketWalletItem`).
 *
 * The assertions are SEMANTIC, not cosmetic — a link's destination, a badge's meaning, an
 * `aria-current`, the absence of a QR. No test below pins a colour class, so restyling the platform
 * cannot fail the suite, while breaking a link, dropping an availability badge, exposing a
 * credential or losing a preserved filter still will.
 */

function render(element: Parameters<typeof renderToStaticMarkup>[0]): string {
    return renderToStaticMarkup(element);
}

const EVENT: PublicEventCard = {
    slug: "liga-basket-bandung",
    title: "Liga Basket Bandung",
    bannerUrl: "/uploads/events/banner.jpg",
    sportName: "Basket",
    sportSlug: "basket",
    startAt: "2026-10-03T12:00:00.000Z",
    endAt: "2026-10-03T14:00:00.000Z",
    timezone: "Asia/Jakarta",
    venueName: "GOR Tridharma",
    venueCity: "Bandung",
    priceFrom: 75000,
    priceTo: 150000,
    salesState: "OPEN",
    isSoldOut: false,
    remaining: null,
    shareUrl: "https://tinggalklik.co/e/liga-basket-bandung",
};

const SPORTS: SportOption[] = [
    { id: "s1", name: "Basket", slug: "basket" },
    { id: "s2", name: "Badminton", slug: "badminton" },
    { id: "s3", name: "Lari", slug: "lari" },
];

const TICKET: TicketWalletItem = {
    ticketCode: "EVT-ABCD-2345",
    status: "ISSUED",
    sequenceNo: 1,
    attendeeName: null,
    issuedAt: "2026-09-17T03:00:00.000Z",
    checkedInAt: null,
    ticketTypeName: "Tribun Utara",
    orderNumber: "EVT-20260917-0001",
    walletUrl: "/ticketing/tickets/EVT-ABCD-2345",
    event: {
        id: "evt_1",
        slug: "liga-basket-bandung",
        title: "Liga Basket Bandung",
        startAt: "2026-10-03T12:00:00.000Z",
        endAt: null,
        venueName: "GOR Tridharma",
        venueCity: "Bandung",
        venueAddress: null,
        sportName: "Basket",
    },
};

describe("G1. EventCard", () => {
    it("links to the canonical detail URL and shows the identifying facts", () => {
        const html = render(createElement(EventCard, { event: EVENT }));

        expect(html).toContain('href="/e/liga-basket-bandung"');
        expect(html).toContain("Liga Basket Bandung");
        expect(html).toContain("Basket");
        expect(html).toContain("GOR Tridharma");
        expect(html).toContain("Mulai");
        expect(html).toContain("75.000");
    });

    it("renders the banner with the event title as alt text", () => {
        const html = render(createElement(EventCard, { event: EVENT }));

        expect(html).toContain('src="/uploads/events/banner.jpg"');
        expect(html).toContain('alt="Liga Basket Bandung"');
        expect(html).toContain('loading="lazy"');
    });

    it("badges a sold-out event and a not-yet-open one, and leaves an on-sale event unbadged", () => {
        const soldOut = render(
            createElement(EventCard, {
                event: { ...EVENT, salesState: "SOLD_OUT", isSoldOut: true },
            })
        );
        const soon = render(
            createElement(EventCard, {
                event: { ...EVENT, salesState: "NOT_STARTED" },
            })
        );
        const open = render(createElement(EventCard, { event: EVENT }));

        expect(soldOut).toContain("Tiket habis");
        expect(soon).toContain("Segera");
        expect(open).not.toContain("Tiket habis");
        expect(open).not.toContain("Penjualan ditutup");
    });

    it("degrades to a sport-tinted panel instead of a broken image when there is no banner", () => {
        const html = render(
            createElement(EventCard, { event: { ...EVENT, bannerUrl: null } })
        );

        expect(html).not.toContain("<img");
        expect(html).toContain("Basket");
    });

    it("says 'Harga menyusul' rather than inventing a price", () => {
        const html = render(
            createElement(EventCard, {
                event: { ...EVENT, priceFrom: null, priceTo: null },
            })
        );

        expect(html).toContain("Harga menyusul");
        expect(html).not.toContain("Rp");
    });

    it("renders exactly ONE link and no nested interactive element", () => {
        const html = render(createElement(EventCard, { event: EVENT }));

        expect(html.match(/<a /g) ?? []).toHaveLength(1);
        expect(html).not.toContain("<button");
    });
});

describe("G2. SportGrid", () => {
    it("links every sport to the catalog filtered by its own slug", () => {
        const html = render(
            createElement(SportGrid, { sports: SPORTS, counts: { basket: 4 } })
        );

        expect(html).toContain('href="/events?sport=basket"');
        expect(html).toContain('href="/events?sport=badminton"');
        expect(html).toContain('href="/events?sport=lari"');
    });

    it("shows a real count and falls back to an invitation, never a fabricated number", () => {
        const html = render(
            createElement(SportGrid, { sports: SPORTS, counts: { basket: 4 } })
        );

        expect(html).toContain("4 event");
        expect(html).toContain("Lihat event");
        expect(html).not.toContain("0 event");
    });

    it("marks the active chip with aria-current and offers a way back to all sports", () => {
        const html = render(
            createElement(SportGrid, {
                sports: SPORTS,
                variant: "chip",
                activeSlug: "badminton",
            })
        );

        expect(html).toContain('href="/events"');
        expect(html).toContain("Semua cabang");
        expect(html).toContain('aria-current="true"');
    });

    it("renders nothing at all when the platform has no sports, rather than an empty heading", () => {
        expect(render(createElement(SportGrid, { sports: [] }))).toBe("");
    });
});

describe("G3. TicketCard", () => {
    it("links to the e-ticket and shows the code, type and status", () => {
        const html = render(createElement(TicketCard, { item: TICKET }));

        expect(html).toContain('href="/ticketing/tickets/EVT-ABCD-2345"');
        expect(html).toContain("EVT-ABCD-2345");
        expect(html).toContain("Tribun Utara");
        expect(html).toContain("Liga Basket Bandung");
        expect(html).toContain("Aktif");
    });

    it("carries no QR payload and no secret — the wallet list never does (design §26.5)", () => {
        const html = render(createElement(TicketCard, { item: TICKET }));

        expect(html).not.toContain("TICKET:");
        expect(html).not.toContain("qrToken");
        expect(html).not.toContain("<svg"); // no QR renderer is mounted in the list
    });
});

describe("G4. CatalogPagination", () => {
    it("renders nothing for a single page", () => {
        expect(
            render(
                createElement(CatalogPagination, {
                    params: {},
                    page: 1,
                    totalPages: 1,
                })
            )
        ).toBe("");
    });

    it("preserves the active filters through a page change", () => {
        const html = render(
            createElement(CatalogPagination, {
                params: { sport: "basket", q: "final" },
                page: 2,
                totalPages: 4,
            })
        );

        expect(html).toContain("page=3");
        expect(html).toContain("sport=basket");
        expect(html).toContain("q=final");
    });

    it("marks the current page and offers previous/next only when they exist", () => {
        const middle = render(
            createElement(CatalogPagination, {
                params: {},
                page: 2,
                totalPages: 3,
            })
        );
        const first = render(
            createElement(CatalogPagination, {
                params: {},
                page: 1,
                totalPages: 3,
            })
        );
        const last = render(
            createElement(CatalogPagination, {
                params: {},
                page: 3,
                totalPages: 3,
            })
        );

        expect(middle).toContain('aria-current="page"');
        expect(middle).toContain("Sebelumnya");
        expect(middle).toContain("Berikutnya");
        expect(first).not.toContain("Sebelumnya");
        expect(last).not.toContain("Berikutnya");
    });
});

describe("G5. CatalogFilters", () => {
    it("is a GET form to /events, so filtering stays server-side and shareable", () => {
        const html = render(
            createElement(CatalogFilters, {
                params: {},
                sports: SPORTS,
                total: 0,
            })
        );

        expect(html).toContain('action="/events"');
        expect(html).toContain('method="get"');
        // Sport filtering is offered as links into the same server-side filter, not as local state.
        expect(html).toContain("Semua cabang");
        expect(html).toContain('href="/events?sport=basket"');
    });

    it("carries the current search and sport through an advanced-filter submit", () => {
        const html = render(
            createElement(CatalogFilters, {
                params: { q: "final", sport: "basket", city: "Bandung" },
                sports: SPORTS,
                total: 3,
            })
        );

        expect(html).toContain('name="q" value="final"');
        expect(html).toContain('name="sport" value="basket"');
        // An applied advanced filter is never hidden: the panel opens itself and says so.
        expect(html).toContain("<details");
        expect(html).toContain("aktif");
        expect(html).toContain('value="Bandung"');
    });

    it("offers exactly the sorts the server accepts", () => {
        const html = render(
            createElement(CatalogFilters, {
                params: {},
                sports: SPORTS,
                total: 0,
            })
        );

        for (const value of ["startAt_asc", "newest", "price_asc", "price_desc"]) {
            expect(html).toContain(`value="${value}"`);
        }
    });

    it("reports the real result count from the server, not a hard-coded claim", () => {
        const html = render(
            createElement(CatalogFilters, {
                params: {},
                sports: SPORTS,
                total: 12,
            })
        );

        expect(html).toContain("12 event ditemukan");
    });
});

describe("G6. StickyBuyBar is a real CTA or an honest refusal", () => {
    it("links to the ticket picker with the server's own price", () => {
        const html = render(
            createElement(StickyBuyBar, {
                priceFrom: 75000,
                href: "#beli",
            })
        );

        expect(html).toContain('href="#beli"');
        expect(html).toContain("Pilih tiket");
        expect(html).toContain("75.000");
    });

    it("shows no link at all when buying is impossible, and says why", () => {
        const html = render(
            createElement(StickyBuyBar, {
                priceFrom: 75000,
                href: "#beli",
                disabledReason: "Tiket habis",
            })
        );

        expect(html).not.toContain('href="#beli"');
        expect(html).toContain("Tiket habis");
        expect(html).toContain("aria-disabled");
    });
});

describe("G7. EmptyState and SectionHeader", () => {
    it("always offers a way out of an empty list", () => {
        const html = render(
            createElement(EmptyState, {
                title: "Belum ada event yang cocok",
                description: "Coba hapus beberapa filter.",
                action: { href: "/events", label: "Hapus semua filter" },
            })
        );

        expect(html).toContain("Belum ada event yang cocok");
        expect(html).toContain('href="/events"');
        expect(html).toContain("Hapus semua filter");
    });

    it("renders a section heading with a link, and without one when there is nowhere to go", () => {
        const withLink = render(
            createElement(SectionHeader, {
                title: "Event terdekat",
                href: "/events",
            })
        );
        const withoutLink = render(
            createElement(SectionHeader, { title: "Cabang olahraga" })
        );

        expect(withLink).toContain("Event terdekat");
        expect(withLink).toContain('href="/events"');
        expect(withoutLink).not.toContain("<a ");
    });
});
