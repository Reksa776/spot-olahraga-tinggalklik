import type { TicketWalletItem } from "@/lib/ticketing/tickets/payload";
import {
    WALLET_VIEWS,
    parseWalletView,
    splitWalletByTime,
} from "@/lib/ticketing/ui/wallet";

/**
 * ==========================================
 * PHASE 9 — WALLET VIEWS (pure)
 * ==========================================
 *
 * The wallet's `?view=` handling and its one derived split. Both are presentation over a list the
 * server has ALREADY authorised ("what may this buyer see" is answered by `listOwnTickets`), so the
 * assertions that matter are: an unknown view cannot invent a mode, and the upcoming/past boundary
 * is the same `event.startAt` the server uses.
 */

function item(overrides: {
    code: string;
    startAt: string;
    eventId?: string;
}): TicketWalletItem {
    return {
        ticketCode: overrides.code,
        status: "ISSUED",
        sequenceNo: 1,
        attendeeName: null,
        issuedAt: "2026-09-01T00:00:00.000Z",
        checkedInAt: null,
        ticketTypeName: "Reguler",
        orderNumber: "EVT-1",
        walletUrl: `/ticketing/tickets/${overrides.code}`,
        event: {
            id: overrides.eventId ?? "evt_1",
            slug: "liga-basket",
            title: "Liga Basket",
            startAt: overrides.startAt,
            endAt: null,
            venueName: "GOR",
            sportName: "Basket",
        },
    };
}

describe("F1. parseWalletView", () => {
    it("accepts exactly the three declared views", () => {
        for (const view of WALLET_VIEWS) {
            expect(parseWalletView(view.value)).toBe(view.value);
        }
    });

    it("falls back to 'upcoming' for anything else, including hostile input", () => {
        expect(parseWalletView(undefined)).toBe("upcoming");
        expect(parseWalletView("")).toBe("upcoming");
        expect(parseWalletView("all; drop table")).toBe("upcoming");
        expect(parseWalletView("PAST")).toBe("upcoming");
        expect(parseWalletView("../admin")).toBe("upcoming");
    });

    it("declares the three buyer-facing labels", () => {
        expect(WALLET_VIEWS.map((view) => view.label)).toEqual([
            "Akan datang",
            "Semua",
            "Sudah lewat",
        ]);
    });
});

describe("F2. splitWalletByTime", () => {
    const now = new Date("2026-09-17T10:00:00.000Z");

    it("splits on the event's own start instant", () => {
        const split = splitWalletByTime(
            [
                item({ code: "A", startAt: "2026-09-18T10:00:00.000Z" }),
                item({ code: "B", startAt: "2026-09-16T10:00:00.000Z" }),
                item({ code: "C", startAt: "2026-10-01T10:00:00.000Z" }),
            ],
            now
        );

        expect(split.upcoming.map((t) => t.ticketCode)).toEqual(["A", "C"]);
        expect(split.past.map((t) => t.ticketCode)).toEqual(["B"]);
    });

    it("counts an event starting right now as upcoming (the server's boundary)", () => {
        const split = splitWalletByTime(
            [item({ code: "NOW", startAt: now.toISOString() })],
            now
        );

        expect(split.upcoming).toHaveLength(1);
        expect(split.past).toHaveLength(0);
    });

    it("preserves the server's ordering rather than re-sorting", () => {
        const split = splitWalletByTime(
            [
                item({ code: "FIRST", startAt: "2026-09-20T10:00:00.000Z" }),
                item({ code: "SECOND", startAt: "2026-09-21T10:00:00.000Z" }),
            ],
            now
        );

        expect(split.upcoming.map((t) => t.ticketCode)).toEqual([
            "FIRST",
            "SECOND",
        ]);
    });

    it("is exhaustive: every authorised row appears in exactly one side", () => {
        const items = [
            item({ code: "A", startAt: "2026-09-18T10:00:00.000Z" }),
            item({ code: "B", startAt: "2026-09-16T10:00:00.000Z" }),
        ];

        const split = splitWalletByTime(items, now);

        expect(split.upcoming.length + split.past.length).toBe(items.length);
    });

    it("handles an empty wallet without inventing rows", () => {
        const split = splitWalletByTime([], now);

        expect(split).toEqual({ upcoming: [], past: [] });
    });
});
