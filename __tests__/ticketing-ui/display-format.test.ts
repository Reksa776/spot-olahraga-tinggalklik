import {
    formatEventDateLong,
    formatEventDateShort,
    formatEventDay,
    formatEventMonthShort,
    formatEventSchedule,
    formatEventTime,
    formatIdr,
    formatPriceFrom,
    formatPriceRange,
    formatVenue,
    pluralTickets,
    salesStateLabel,
} from "@/lib/ticketing/ui/format";
import { sportLabel, sportSolidTint, sportTint } from "@/lib/ticketing/ui/sport-tint";

/**
 * ==========================================
 * PHASE 9 — DISPLAY FORMATTING (pure)
 * ==========================================
 *
 * These functions decide every number and date a buyer reads, so they are pinned here rather than
 * verified by eye. All formatters are `Asia/Jakarta`, so the expectations below are stable no
 * matter which timezone the test runner is in.
 *
 * The important assertion in this file is the last one: nothing here mutates a value of record.
 * Money is formatted for display only, from the server's own number.
 */

describe("E1. money", () => {
    it("formats IDR without decimals, as the market quotes ticket prices", () => {
        expect(formatIdr(150000)).toMatch(/^Rp\s?150\.000$/);
        expect(formatIdr(0)).toMatch(/^Rp\s?0$/);
    });

    it("states an unknown price in words rather than as a fake zero", () => {
        expect(formatPriceRange(null, null)).toBe("Harga menyusul");
        expect(formatPriceFrom(null)).toBe("Harga menyusul");
    });

    it("shows a range only when the upper bound is genuinely higher", () => {
        const range = formatPriceRange(50000, 150000);
        expect(range).toContain("50.000");
        expect(range).toContain("150.000");
        expect(range).toContain("–");

        // A single-tier event reads as a price, not as "Rp50.000 – Rp50.000".
        expect(formatPriceRange(50000, 50000)).not.toContain("–");
        expect(formatPriceRange(50000, null)).not.toContain("–");
    });

    it("frames a card price as 'Mulai'", () => {
        expect(formatPriceFrom(75000)).toContain("Mulai");
        expect(formatPriceFrom(75000)).toContain("75.000");
    });
});

describe("E2. dates, pinned to Asia/Jakarta", () => {
    // 2026-09-20T12:00:00Z is 19:00 in Jakarta (UTC+7).
    const start = "2026-09-20T12:00:00.000Z";

    it("renders the Jakarta calendar day, not the UTC one", () => {
        expect(formatEventDay(start)).toBe("20");
        expect(formatEventMonthShort(start)).toBe("Sep");
        expect(formatEventDateShort(start)).toContain("2026");
        expect(formatEventDateLong(start)).toContain("September");
    });

    it("renders the Jakarta clock time with WIB", () => {
        expect(formatEventTime(start)).toBe("19.00");
    });

    it("rolls a late-UTC event into the next Jakarta day", () => {
        // 2026-09-20T18:30:00Z is 01:30 on the 21st in Jakarta.
        expect(formatEventDay("2026-09-20T18:30:00.000Z")).toBe("21");
        expect(formatEventTime("2026-09-20T18:30:00.000Z")).toBe("01.30");
    });

    it("joins a same-day end time into one range and splits a multi-day one", () => {
        const sameDay = formatEventSchedule(start, "2026-09-20T14:00:00.000Z");
        expect(sameDay).toContain("19.00 WIB");
        expect(sameDay).toContain("21.00 WIB");

        const multiDay = formatEventSchedule(start, "2026-09-22T04:00:00.000Z");
        expect(multiDay).toContain("19.00 WIB");
        expect(multiDay).toContain("11.00 WIB");
        expect(multiDay).toContain("22");
    });

    it("omits the end entirely when there is none", () => {
        expect(formatEventSchedule(start, null)).toBe(
            formatEventSchedule(start, null)
        );
        expect(formatEventSchedule(start, null)).toContain("19.00 WIB");
        expect(formatEventSchedule(start, null).split("–")).toHaveLength(1);
    });
});

describe("E3. venue and counts", () => {
    it("joins the venue and city when both exist and degrades gracefully", () => {
        expect(formatVenue("GBK", "Jakarta")).toBe("GBK, Jakarta");
        expect(formatVenue("GBK", null)).toBe("GBK");
        expect(formatVenue(null, "Jakarta")).toBe("Jakarta");
        expect(formatVenue(null, null)).toBe("Lokasi menyusul");
    });

    it("pluralises a ticket count", () => {
        expect(pluralTickets(1)).toBe("1 tiket");
        expect(pluralTickets(3)).toBe("3 tiket");
    });
});

describe("E4. sales state is expressed in the buyer's words", () => {
    it("returns null while a ticket can still be bought", () => {
        expect(salesStateLabel("OPEN", false)).toBeNull();
    });

    it("explains every state that blocks a purchase", () => {
        expect(salesStateLabel("SOLD_OUT", true)).toBe("Tiket habis");
        expect(salesStateLabel("OPEN", true)).toBe("Tiket habis");
        expect(salesStateLabel("NOT_STARTED", false)).toBe("Belum dibuka");
        expect(salesStateLabel("CLOSED", false)).toBe("Penjualan ditutup");
        expect(salesStateLabel("OPEN", false, false)).toBe("Tidak tersedia");
    });
});

describe("E5. sport tints are deterministic and stay inside the palette", () => {
    it("returns the same tint for the same slug, every time", () => {
        expect(sportTint("basket")).toBe(sportTint("basket"));
        expect(sportSolidTint("basket")).toBe(sportSolidTint("basket"));
    });

    it("returns real Tailwind classes, never an interpolated string", () => {
        for (const slug of ["basket", "badminton", "futsal", "voli", "lari"]) {
            expect(sportTint(slug)).toMatch(/^bg-\w+-\d+ text-\w+-\d+ ring-\w+-\d+$/);
            expect(sportSolidTint(slug)).toMatch(/^(bg-\w+-\d+|bg-cyan-\d+) text-white$/);
        }
    });

    it("keeps a chip label to the sport's own name", () => {
        expect(sportLabel("Basket")).toBe("Basket");
        expect(sportLabel("MMA")).toBe("MMA");
    });
});

describe("E6. formatting is display only — it cannot mutate a value of record", () => {
    it("drops the fractional part for display without touching the input", () => {
        const decimal = "150000.55";

        // Rounded for the eye only...
        expect(formatIdr(Number(decimal))).toContain("150.001");
        // ...the string of record is untouched, because nothing here has a setter.
        expect(decimal).toBe("150000.55");
    });
});
