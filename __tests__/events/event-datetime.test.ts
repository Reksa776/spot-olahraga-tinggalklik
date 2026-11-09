import fs from "node:fs/promises";
import path from "node:path";

import {
    eventTimingErrors,
    formatWibDateTime,
    parseEventDateTime,
    toWibInputValue,
    wibInputToIso,
} from "@/lib/events/datetime";
import {
    createEventSchema,
    updateEventSchema,
} from "@/lib/events/validation";

/**
 * ==========================================
 * EVENT DATE/TIME — WIB CONTRACT
 * ==========================================
 *
 * The form is only usable if three things agree: what the operator types, what is sent,
 * and what comes back. All three are pinned to WIB here, independent of the machine
 * running the test (the suite runs in whatever TZ the CI box uses).
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

describe("WIB conversions", () => {
    test("a datetime-local value is read as WIB and stored as UTC", () => {
        // 19:30 WIB = 12:30 UTC, same calendar day.
        expect(wibInputToIso("2026-11-15T19:30")).toBe(
            "2026-11-15T12:30:00.000Z"
        );
    });

    test("display converts the stored UTC instant back to WIB", () => {
        expect(toWibInputValue("2026-11-15T12:30:00.000Z")).toBe(
            "2026-11-15T19:30"
        );
        expect(formatWibDateTime("2026-11-15T12:30:00.000Z")).toBe(
            "Minggu, 15 November 2026, 19:30 WIB"
        );
    });

    test("an explicit offset is honoured, not re-interpreted", () => {
        expect(
            parseEventDateTime("2026-11-15T19:30:00+07:00")?.toISOString()
        ).toBe("2026-11-15T12:30:00.000Z");
        expect(
            parseEventDateTime("2026-11-15T12:30:00.000Z")?.toISOString()
        ).toBe("2026-11-15T12:30:00.000Z");
    });

    test("an impossible or malformed date is rejected", () => {
        expect(parseEventDateTime("2026-02-31T19:00")).toBeNull();
        expect(parseEventDateTime("not-a-date")).toBeNull();
        expect(parseEventDateTime("")).toBeNull();
    });

    test("create mode has no datetime pre-fill", () => {
        // EventForm seeds its state from `initial`, which is absent on create.
        expect(toWibInputValue(undefined)).toBe("");
        expect(toWibInputValue(null)).toBe("");
        expect(toWibInputValue("")).toBe("");
    });
});

describe("createEventSchema — schedule rules", () => {
    const startAt = new Date(Date.now() + 30 * DAY).toISOString();
    const endAt = new Date(Date.now() + 30 * DAY + 3 * HOUR).toISOString();
    const salesStartAt = new Date(Date.now() + 7 * DAY).toISOString();
    const salesEndAt = new Date(Date.now() + 29 * DAY).toISOString();

    const base = {
        title: "Event WIB",
        sportId: "sport-1",
        startAt,
    };

    function issueMessage(
        result: ReturnType<typeof createEventSchema.safeParse>,
        field: string
    ): string | undefined {
        if (result.success) return undefined;

        return result.error.issues.find(
            (issue) => issue.path.join(".") === field
        )?.message;
    }

    test("accepts a coherent schedule", () => {
        const parsed = createEventSchema.parse({
            ...base,
            endAt,
            salesStartAt,
            salesEndAt,
        });

        expect(parsed.startAt).toBeInstanceOf(Date);
        expect(parsed.endAt).toBeInstanceOf(Date);
    });

    test("accepts the datetime-local form as WIB", () => {
        const parsed = createEventSchema.parse({
            ...base,
            startAt: "2030-11-15T19:00",
        });

        expect(parsed.startAt.toISOString()).toBe("2030-11-15T12:00:00.000Z");
    });

    test("endAt must be after startAt", () => {
        const result = createEventSchema.safeParse({
            ...base,
            endAt: startAt,
        });

        expect(issueMessage(result, "endAt")).toBe(
            "Tanggal selesai harus setelah tanggal mulai."
        );
    });

    test("salesStartAt must be before the event", () => {
        const result = createEventSchema.safeParse({
            ...base,
            salesStartAt: startAt,
            salesEndAt: "2030-01-01T00:00:00.000Z",
        });

        expect(issueMessage(result, "salesStartAt")).toBe(
            "Penjualan harus dimulai sebelum event."
        );
    });

    test("salesEndAt must not pass the event start", () => {
        const result = createEventSchema.safeParse({
            ...base,
            salesStartAt,
            salesEndAt: endAt,
        });

        expect(issueMessage(result, "salesEndAt")).toBe(
            "Penjualan harus berakhir sebelum event dimulai."
        );
    });

    test("salesEndAt must not precede salesStartAt", () => {
        const result = createEventSchema.safeParse({
            ...base,
            salesStartAt: salesEndAt,
            salesEndAt: salesStartAt,
        });

        expect(issueMessage(result, "salesEndAt")).toBe(
            "Penjualan harus berakhir setelah waktu mulai penjualan."
        );
    });

    test("a missing start is refused with an operator-facing message", () => {
        const result = createEventSchema.safeParse({ ...base, startAt: "" });

        expect(issueMessage(result, "startAt")).toBe(
            "Tanggal mulai wajib diisi."
        );
    });

    test("a draft may be created with only startAt filled", () => {
        const parsed = createEventSchema.parse({ ...base, endAt: "" });

        expect(parsed.endAt).toBeNull();
        expect(parsed.salesStartAt).toBeUndefined();
    });

    test("a new event may not start in the past", () => {
        const result = createEventSchema.safeParse({
            ...base,
            startAt: new Date(Date.now() - DAY).toISOString(),
        });

        expect(issueMessage(result, "startAt")).toBe(
            "Tanggal mulai tidak boleh di masa lalu."
        );
    });

    test("an update may carry the existing past start", () => {
        const past = new Date(Date.now() - DAY).toISOString();

        expect(updateEventSchema.safeParse({ startAt: past }).success).toBe(
            true
        );
    });
});

describe("client-side schedule errors", () => {
    const now = new Date("2026-11-01T00:00:00.000Z");

    const base = {
        startAt: "2026-11-15T19:00",
        endAt: "",
        salesStartAt: "",
        salesEndAt: "",
    };

    test("end before start shows a specific message", () => {
        expect(
            eventTimingErrors(
                { ...base, endAt: "2026-11-15T18:00" },
                { mode: "create", now }
            ).endAt
        ).toBe("Tanggal selesai harus setelah tanggal mulai.");
    });

    test("an empty start is required before submit", () => {
        expect(
            eventTimingErrors(
                { ...base, startAt: "" },
                { mode: "create", now }
            ).startAt
        ).toBe("Tanggal mulai wajib diisi.");
    });

    test("a past start is refused on create", () => {
        expect(
            eventTimingErrors(
                { ...base, startAt: "2026-10-01T19:00" },
                { mode: "create", now }
            ).startAt
        ).toBe("Tanggal mulai tidak boleh di masa lalu.");
    });

    test("an unchanged past start is allowed on edit", () => {
        const values = { ...base, startAt: "2026-10-01T19:00" };

        expect(
            eventTimingErrors(values, {
                mode: "edit",
                now,
                originalStartAt: values.startAt,
            })
        ).toEqual({});

        expect(
            eventTimingErrors(
                { ...values, startAt: "2026-10-02T19:00" },
                { mode: "edit", now, originalStartAt: values.startAt }
            ).startAt
        ).toBe("Tanggal mulai tidak boleh di masa lalu.");
    });

    test("sales must start before the event and end by its start", () => {
        expect(
            eventTimingErrors(
                { ...base, salesStartAt: "2026-11-15T19:00" },
                { mode: "create", now }
            ).salesStartAt
        ).toBe("Penjualan harus dimulai sebelum event.");

        expect(
            eventTimingErrors(
                {
                    ...base,
                    salesStartAt: "2026-11-01T10:00",
                    salesEndAt: "2026-11-15T20:00",
                },
                { mode: "create", now }
            ).salesEndAt
        ).toBe("Penjualan harus berakhir sebelum event dimulai.");

        expect(
            eventTimingErrors(
                {
                    ...base,
                    salesStartAt: "2026-11-10T10:00",
                    salesEndAt: "2026-11-09T10:00",
                },
                { mode: "create", now }
            ).salesEndAt
        ).toBe("Penjualan harus berakhir setelah waktu mulai penjualan.");
    });
});

describe("event form wiring", () => {
    test("uses the WIB helpers and shows a readable preview per field", async () => {
        const source = await fs.readFile(
            path.join(process.cwd(), "components/organizer/EventForm.tsx"),
            "utf8"
        );

        expect(source).toContain("wibInputToIso");
        expect(source).toContain("formatWibDateTime");
        expect(source).toContain("wibDateTimeMin");
        expect(source).toContain('type="datetime-local"');
        expect(source).toContain("min={");
        expect(source).toContain("error={timingErrors.");
        expect(source).not.toContain("getTimezoneOffset");
        // Edit mode still fills the stored values; create mode has no default seed.
        expect(source).toContain("toWibInputValue(initial?.startAt)");
        expect(source).not.toContain("defaultEventSchedule");
    });
});
