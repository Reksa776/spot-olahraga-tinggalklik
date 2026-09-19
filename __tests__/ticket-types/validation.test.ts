/**
 * ==========================================
 * PHASE 5 — TICKET TYPE VALIDATION (pure)
 * ==========================================
 *
 * Brief §8 requires that money use the repository's `Decimal` representation with no
 * floating-point arithmetic and no unsafe coercion; brief §29 lists "no unsafe numeric
 * coercion" and "no negative quota" as security properties.
 *
 * These tests attack the parsing directly, because a coercion bug here is silent: an
 * empty quota field becoming `0` or a price losing its decimals would both pass a naive
 * happy-path test and produce wrong inventory or wrong money in production.
 *
 * No database, no Next.js — pure schema behaviour only.
 */

import fs from "fs";
import path from "path";

import {
    createTicketTypeSchema,
    updateTicketTypeSchema,
    TICKET_TYPE_LIMITS,
} from "@/lib/ticket-types/validation";

const VALID = {
    name: "Tribun",
    price: "150000",
    quota: "100",
};

function issuePaths(result: {
    success: boolean;
    error?: { issues: { path: (string | number | symbol)[] }[] };
}): string[] {
    if (result.success) return [];

    return (result.error?.issues ?? []).map((issue) => issue.path.join("."));
}

describe("money is parsed as an exact decimal, never a float", () => {
    test("a whole amount is accepted and canonicalised to 2 decimals", () => {
        const parsed = createTicketTypeSchema.safeParse({
            ...VALID,
            price: "150000",
        });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.price).toBe("150000.00");
    });

    test("a large whole amount survives exactly, with a string result", () => {
        const parsed = createTicketTypeSchema.safeParse({
            ...VALID,
            // This is the size a float round trip destroys.
            price: "1234567",
        });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.price).toBe("1234567.00");
        // The parsed value is a decimal STRING, never a JS number.
        expect(typeof (parsed.success && parsed.data.price)).toBe("string");
    });

    test("a whole-rupiah amount is canonicalised to the column scale", () => {
        const parsed = createTicketTypeSchema.safeParse({
            ...VALID,
            price: "0",
        });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.price).toBe("0.00");
    });

    test.each([
        ["-1", "negative"],
        ["-0.01", "negative with decimals"],
        ["", "empty"],
        ["   ", "whitespace"],
        ["abc", "not a number"],
        ["1,000", "grouping separator"],
        ["1.000,50", "locale format"],
        ["1e3", "scientific notation"],
        ["1.234", "more than 2 decimals"],
        // ── PHASE 18B (D-P17-05 = A): no fractional rupiah ───────────────────────
        ["150000.50", "half a rupiah"],
        ["150000.25", "a quarter rupiah"],
        ["150000.01", "one sen"],
        ["1234567.89", "two decimal places"],
        ["0x10", "hex"],
        ["NaN", "NaN"],
        ["Infinity", "Infinity"],
        ["+5", "explicit sign"],
    ])("price %p is rejected (%s)", (price) => {
        const result = createTicketTypeSchema.safeParse({ ...VALID, price });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("price");
    });

    test("a negative price is refused with a specific message, not a shape error", () => {
        const result = createTicketTypeSchema.safeParse({ ...VALID, price: "-5" });

        expect(result.success).toBe(false);

        const messages = (result as unknown as {
            error: { issues: { message: string }[] };
        }).error.issues.map((issue) => issue.message);

        expect(messages.join(" ")).toContain("negatif");
    });

    test("a price beyond DECIMAL(14,2) precision is refused", () => {
        // 13 integer digits — one more than the column can hold.
        const tooBig = createTicketTypeSchema.safeParse({
            ...VALID,
            price: "9999999999999",
        });

        expect(tooBig.success).toBe(false);

        // The largest WHOLE rupiah the column can hold is accepted (Phase 18B: a fractional
        // rupiah is refused, so `…999.99` is no longer a valid price).
        const atLimit = createTicketTypeSchema.safeParse({
            ...VALID,
            price: "999999999999",
        });

        expect(atLimit.success).toBe(true);
        expect(atLimit.success && atLimit.data.price).toBe("999999999999.00");
    });

    test("trailing zeroes are canonicalised so equivalent inputs compare equal", () => {
        const forms = ["1500", "1500.0", "1500.00", "01500"];

        const canonical = forms.map((price) => {
            const parsed = createTicketTypeSchema.safeParse({ ...VALID, price });

            expect(parsed.success).toBe(true);
            return parsed.success ? parsed.data.price : "";
        });

        expect(new Set(canonical).size).toBe(1);
        expect(canonical[0]).toBe("1500.00");
    });

    test("a JSON number is accepted but does not become a float downstream", () => {
        const parsed = createTicketTypeSchema.safeParse({
            ...VALID,
            price: 150000,
        });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.price).toBe("150000.00");
    });
});

/**
 * PHASE 18B (D-P17-05 = A) — SELLABLE PRICES ARE WHOLE RUPIAH.
 *
 * Why this is a product-level invariant and not a formatting preference: checkout converted
 * each line with `roundToRupiah(unitPrice × quantity)` while refund eligibility summed each
 * ticket's un-rounded `priceSnapshot`. A fractional unit price made those two disagree, which
 * stranded a final ticket (its remaining balance below its own price) and, under concurrency,
 * could push `refundedAmount` past `total`. With whole rupiah both sums are identical by
 * construction, so the balance guard in settlement is a backstop rather than the only defense.
 *
 * Enforced on CREATE and UPDATE because both feed the only writer (`lib/ticket-types/service`).
 */
describe("PHASE 18B — a price carries no fractional rupiah", () => {
    test.each([
        ["100000", "whole rupiah"],
        ["100000.00", "whole rupiah, explicit scale"],
        ["100500", "Rp100.500"],
        ["0", "free"],
    ])("create accepts %p (%s)", (price) => {
        const parsed = createTicketTypeSchema.safeParse({ ...VALID, price });

        expect(parsed.success).toBe(true);
    });

    test.each([
        ["100000.50", "half a rupiah"],
        ["100000.25", "a quarter rupiah"],
        ["100000.01", "one sen"],
    ])("create refuses %p (%s) with the whole-rupiah message", (price) => {
        const result = createTicketTypeSchema.safeParse({ ...VALID, price });

        expect(result.success).toBe(false);

        const messages = (result as unknown as {
            error: { issues: { message: string }[] };
        }).error.issues.map((issue) => issue.message);

        expect(messages).toContain(TICKET_TYPE_LIMITS.WHOLE_RUPIAH_MESSAGE);
    });

    test("update refuses a fractional price too", () => {
        const result = updateTicketTypeSchema.safeParse({ price: "100000.50" });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("price");
    });

    test("a JSON number with a fractional part is refused as well", () => {
        // 100000.5 as a JSON number must not sneak past the string path.
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            price: 100000.5,
        });

        expect(result.success).toBe(false);
    });

    test("no route that writes a price bypasses the schema", () => {
        // The service is the only writer, and it is fed by these two schemas (Phase 18B
        // audit). A raw number reaching Prisma would re-open the invariant.
        const sources = [
            fs.readFileSync(
                path.resolve(__dirname, "../../lib/ticket-types/service.ts"),
                "utf8"
            ),
        ];

        for (const source of sources) {
            // The only price write is the validated string from the parsed input.
            expect(source).toMatch(/price: input\.price/);
            expect(source).not.toMatch(/price: Number\(/);
        }
    });
});

describe("quota is a non-negative integer, with no unsafe coercion", () => {
    test("an integer string is accepted and becomes a number", () => {
        const parsed = createTicketTypeSchema.safeParse({ ...VALID, quota: "100" });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.quota).toBe(100);
    });

    test("zero quota is explicitly allowed (a tier may exist before it goes on sale)", () => {
        const parsed = createTicketTypeSchema.safeParse({ ...VALID, quota: "0" });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.quota).toBe(0);
    });

    test.each([
        ["", "empty string"],
        ["   ", "whitespace"],
        ["-1", "negative"],
        ["1.5", "fractional"],
        ["1e3", "scientific notation"],
        ["abc", "not a number"],
        ["1,000", "grouping separator"],
        ["0x10", "hex"],
        [" ", "space"],
    ])("quota %p is rejected (%s)", (quota) => {
        const result = createTicketTypeSchema.safeParse({ ...VALID, quota });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("quota");
    });

    test("an empty quota does NOT silently become zero", () => {
        // This is the concrete failure mode `z.coerce.number()` would produce:
        // `Number("") === 0`, so a blank form field would mean "zero quota".
        const result = createTicketTypeSchema.safeParse({ ...VALID, quota: "" });

        expect(result.success).toBe(false);
    });

    test("a quota above the accepted ceiling is refused", () => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            quota: String(TICKET_TYPE_LIMITS.MAX_QUOTA + 1),
        });

        expect(result.success).toBe(false);
    });

    test("a missing quota is required, not defaulted", () => {
        const result = createTicketTypeSchema.safeParse({
            name: "Tribun",
            price: "150000",
        });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("quota");
    });
});

describe("sales window and per-order bounds are logically validated", () => {
    test("an end before the start is refused, on the end field", () => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            salesStartAt: "2026-10-01T10:00:00.000Z",
            salesEndAt: "2026-10-01T09:00:00.000Z",
        });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("salesEndAt");
    });

    test("an end equal to the start is accepted (a zero-length window is a choice)", () => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            salesStartAt: "2026-10-01T10:00:00.000Z",
            salesEndAt: "2026-10-01T10:00:00.000Z",
        });

        expect(result.success).toBe(true);
    });

    test("omitting the window is legitimate — it inherits the event's", () => {
        const result = createTicketTypeSchema.safeParse({ ...VALID });

        expect(result.success).toBe(true);
        expect(result.success && result.data.salesStartAt).toBeNull();
        expect(result.success && result.data.salesEndAt).toBeNull();
    });

    test("an invalid date string is refused rather than becoming Invalid Date", () => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            salesStartAt: "not-a-date",
        });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("salesStartAt");
    });

    test("maxPerOrder below minPerOrder is refused on the max field", () => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            minPerOrder: "5",
            maxPerOrder: "2",
        });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("maxPerOrder");
    });

    test("minPerOrder below 1 is refused", () => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            minPerOrder: "0",
        });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("minPerOrder");
    });

    test("maxPerOrder omitted means null, which inherits the event ceiling", () => {
        const result = createTicketTypeSchema.safeParse({ ...VALID, maxPerOrder: "" });

        expect(result.success).toBe(true);
        expect(result.success && result.data.maxPerOrder).toBeNull();
    });
});

describe("inventory counters and ownership cannot be supplied by a client", () => {
    test.each([
        ["sold", 5],
        ["reserved", 5],
        ["version", 9],
        ["currency", "USD"],
        ["eventId", "someone-elses-event"],
        ["organizerId", "someone-elses-organizer"],
        ["id", "forced-id"],
        ["createdAt", "2026-01-01T00:00:00.000Z"],
    ])("create rejects a client-supplied %s", (key, value) => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            [key]: value,
        });

        expect(result.success).toBe(false);
    });

    test.each([
        ["sold", 5],
        ["reserved", 5],
        ["version", 9],
        ["currency", "USD"],
        ["eventId", "someone-elses-event"],
        ["organizerId", "someone-elses-organizer"],
    ])("update rejects a client-supplied %s", (key, value) => {
        const result = updateTicketTypeSchema.safeParse({ [key]: value });

        expect(result.success).toBe(false);
    });

    test("update accepts a genuinely partial payload", () => {
        const result = updateTicketTypeSchema.safeParse({ name: "VIP" });

        expect(result.success).toBe(true);
    });

    test("update refuses an empty payload rather than silently succeeding", () => {
        const result = updateTicketTypeSchema.safeParse({});

        expect(result.success).toBe(false);
    });

    test("update still applies the money and window rules", () => {
        expect(updateTicketTypeSchema.safeParse({ price: "-1" }).success).toBe(false);
        expect(updateTicketTypeSchema.safeParse({ quota: "2.5" }).success).toBe(false);
        expect(
            updateTicketTypeSchema.safeParse({
                salesStartAt: "2026-10-01T10:00:00.000Z",
                salesEndAt: "2026-10-01T09:00:00.000Z",
            }).success
        ).toBe(false);
    });
});

describe("names are bounded and trimmed", () => {
    test("a one-character name is refused", () => {
        const result = createTicketTypeSchema.safeParse({ ...VALID, name: "A" });

        expect(result.success).toBe(false);
        expect(issuePaths(result)).toContain("name");
    });

    test("a name is trimmed before storage", () => {
        const result = createTicketTypeSchema.safeParse({
            ...VALID,
            name: "  Tribun Utara  ",
        });

        expect(result.success).toBe(true);
        expect(result.success && result.data.name).toBe("Tribun Utara");
    });
});

describe("D-60 is not decided by this schema", () => {
    test("two ticket types may be created with the same name (no uniqueness rule is applied)", () => {
        // D-60 (whether `(eventId, name)` should be unique) is intentionally UNRESOLVED
        // in the Phase 1 design. Validation must therefore impose no uniqueness on the
        // name — that is a database/service concern, and inventing it here would be
        // making the business decision by accident.
        const first = createTicketTypeSchema.safeParse({ ...VALID, name: "Tribun" });
        const second = createTicketTypeSchema.safeParse({ ...VALID, name: "Tribun" });

        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
    });
});
