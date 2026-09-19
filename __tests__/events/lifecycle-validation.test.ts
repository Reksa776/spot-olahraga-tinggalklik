/**
 * ==========================================
 * PHASE 12 — EVENT LIFECYCLE VALIDATION (unit)
 * ==========================================
 *
 * Pure schema tests for the fields the event form gained in Phase 12 (`salesStartAt`,
 * `salesEndAt`, `maxTicketsPerOrder`) plus the cancel body. No database is involved, so
 * every assertion is about the contract at the API edge — which is where a client-side
 * bug must be turned into a 400 rather than reaching the service.
 *
 * The `salesStartAt`/`salesEndAt` semantics under test come from design §10.2:
 *
 *   null salesStartAt = "immediately after publish"
 *   null salesEndAt   = "until event start"
 *
 * so an absent window is legitimate and only a contradictory pair is invalid. On UPDATE,
 * `null` means "clear this column" and `undefined` means "leave it alone" — the two states
 * must stay distinguishable or an organizer could never remove a window once set.
 */

import {
    cancelEventSchema,
    createEventSchema,
    updateEventSchema,
} from "@/lib/events/validation";

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const START = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
const END = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();

const BASE_CREATE = {
    title: "Event Validasi",
    sportId: "sport-1",
    startAt: FUTURE,
};

describe("createEventSchema — sales window", () => {
    test("accepts a well-ordered sales window", () => {
        const parsed = createEventSchema.parse({
            ...BASE_CREATE,
            salesStartAt: START,
            salesEndAt: END,
        });

        expect(parsed.salesStartAt).toBeInstanceOf(Date);
        expect(parsed.salesEndAt).toBeInstanceOf(Date);
    });

    test("accepts a null/absent window (inherit defaults)", () => {
        const parsed = createEventSchema.parse({
            ...BASE_CREATE,
            salesStartAt: null,
            salesEndAt: "",
        });

        expect(parsed.salesStartAt).toBeNull();
        expect(parsed.salesEndAt).toBeNull();
    });

    test("rejects an inverted sales window on salesEndAt", () => {
        const result = createEventSchema.safeParse({
            ...BASE_CREATE,
            salesStartAt: END,
            salesEndAt: START,
        });

        expect(result.success).toBe(false);

        if (!result.success) {
            const paths = result.error.issues.map((issue) => issue.path.join("."));
            expect(paths).toContain("salesEndAt");
        }
    });

    test("rejects an invalid date string", () => {
        const result = createEventSchema.safeParse({
            ...BASE_CREATE,
            salesStartAt: "not-a-date",
        });

        expect(result.success).toBe(false);
    });

    test("maxTicketsPerOrder is bounded 1..50", () => {
        expect(
            createEventSchema.safeParse({
                ...BASE_CREATE,
                maxTicketsPerOrder: 1,
            }).success
        ).toBe(true);

        expect(
            createEventSchema.safeParse({
                ...BASE_CREATE,
                maxTicketsPerOrder: 50,
            }).success
        ).toBe(true);

        for (const bad of [0, -1, 51]) {
            expect(
                createEventSchema.safeParse({
                    ...BASE_CREATE,
                    maxTicketsPerOrder: bad,
                }).success
            ).toBe(false);
        }
    });
});

describe("updateEventSchema — clear vs leave-untouched", () => {
    test("an explicit null clears a window column (sent as null, not dropped)", () => {
        const parsed = updateEventSchema.parse({ salesEndAt: null });

        expect(parsed.salesEndAt).toBeNull();
    });

    test("a missing window column stays undefined (do not touch)", () => {
        const parsed = updateEventSchema.parse({ title: "Judul baru" });

        expect(parsed.salesEndAt).toBeUndefined();
        expect(parsed.salesStartAt).toBeUndefined();
    });

    test("rejects an inverted window inside one payload", () => {
        const result = updateEventSchema.safeParse({
            salesStartAt: END,
            salesEndAt: START,
        });

        expect(result.success).toBe(false);
    });

    test("still refuses an empty update", () => {
        expect(updateEventSchema.safeParse({}).success).toBe(false);
    });

    test("ownership and status are not accepted from the client", () => {
        for (const key of ["organizerId", "status", "publishedAt", "archivedAt"]) {
            const result = updateEventSchema.safeParse({ [key]: "x" });

            expect(result.success).toBe(false);
        }
    });
});

describe("cancelEventSchema", () => {
    test("accepts a bounded reason", () => {
        expect(cancelEventSchema.parse({ reason: "Banjir bandang" }).reason).toBe(
            "Banjir bandang"
        );
    });

    test("treats an omitted or blank reason as null", () => {
        expect(cancelEventSchema.parse({}).reason).toBeNull();
        expect(cancelEventSchema.parse({ reason: "" }).reason).toBeNull();
        expect(cancelEventSchema.parse({ reason: null }).reason).toBeNull();
    });

    test("refuses a too-short or too-long reason and unknown keys", () => {
        expect(cancelEventSchema.safeParse({ reason: "ab" }).success).toBe(false);
        expect(
            cancelEventSchema.safeParse({ reason: "x".repeat(501) }).success
        ).toBe(false);
        expect(
            cancelEventSchema.safeParse({ reason: "ok", status: "DRAFT" }).success
        ).toBe(false);
    });
});
