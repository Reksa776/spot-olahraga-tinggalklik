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

    test("two decimal places survive exactly", () => {
        const parsed = createTicketTypeSchema.safeParse({
            ...VALID,
            // This is the value a float round trip destroys.
            price: "1234567.89",
        });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data.price).toBe("1234567.89");
    });

    test("no float ever touches the value: the parsed result is a string", () => {
        const parsed = createTicketTypeSchema.safeParse({
            ...VALID,
            price: "0.1",
        });

        expect(parsed.success).toBe(true);
        expect(typeof (parsed.success && parsed.data.price)).toBe("string");
        // 0.1 + 0.2 === 0.30000000000000004 in float; as decimal strings it is exact.
        expect(parsed.success && parsed.data.price).toBe("0.10");
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

        // The exact boundary value is accepted.
        const atLimit = createTicketTypeSchema.safeParse({
            ...VALID,
            price: TICKET_TYPE_LIMITS.MAX_MONEY,
        });

        expect(atLimit.success).toBe(true);
        expect(atLimit.success && atLimit.data.price).toBe("999999999999.99");
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
