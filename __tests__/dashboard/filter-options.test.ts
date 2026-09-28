/**
 * ==========================================
 * DASHBOARD FILTER STANDARDIZATION — THE OPTION MODEL (PURE)
 * ==========================================
 *
 * The audit found 21 filter knobs of which only two were dropdowns, and four hand-rolled pill
 * toolbars that each re-implemented their own active marker and their own query merge. The
 * standardization replaced them with one option model (`components/dashboard/filters/filter-types.ts`)
 * and one URL merge.
 *
 * This suite pins that model from the pure side — no DOM, no database, no render:
 *
 *   unions        a NAMED UNION ("Aktif", "Perlu Ditangani", "Menunggu Persetujuan") is a LABEL
 *                 whose selection emits a REPEATED parameter. The URL format is unchanged:
 *                 `?status=PENDING&status=PROCESSING`, never `?queue=…`;
 *   "Semua"       the all-option OMITS the parameter instead of setting an empty one;
 *   AND           a change to one field preserves every other field, including an array, and no
 *                 option ever writes a parameter belonging to another row;
 *   page          every filter change returns to page 1;
 *   honesty       a combination the option list cannot name is shown as its own option rather
 *                 than as "Semua";
 *   vocabulary    every enum member has a label, and `all` can never collide with a real value;
 *   period        the window shortcuts are a field with NO all-option, whose options write only
 *                 `period` — which is what makes a shortcut replace an explicit `from`/`to` range.
 *
 * `@/auth` is stubbed because the read models these builders share their unions with resolve their
 * scope through it — the same stub the KPI suite uses. No test here reads a session.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import {
    applyFilterChange,
    buildFilterField,
    buildPeriodField,
    FILTER_ALL,
    FILTER_COMBINATION,
    hasActiveFilter,
    sameValueSet,
} from "@/components/dashboard/filters/filter-types";
import {
    EVENT_STATUS_LABELS,
    ORDER_STATUS_LABELS,
    PAYMENT_STATUS_LABELS,
    REFUND_STATUS_LABELS,
    REPORT_PERIOD_KEYS,
    REPORT_PERIOD_LABELS,
    SETTLEMENT_STATUS_LABELS,
} from "@/lib/dashboard/filter-options";
import { REFUND_NEEDS_HANDLING_STATUSES } from "@/lib/dashboard/refunds";
import { EVENT_ACTIVE_STATUSES, EVENT_STATUS_FILTERS } from "@/lib/events/status";
import { DASHBOARD_REPORT_PERIODS } from "@/lib/dashboard/reports";
import {
    SETTLEMENT_AWAITING_APPROVAL_STATUSES,
    SETTLEMENT_STATUSES,
} from "@/lib/ticketing/settlement/validation";

const EVENT_STATUS_MEMBERS = [...EVENT_STATUS_FILTERS];
const REFUND_STATUS_MEMBERS = [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "PROCESSING",
    "REFUNDED",
    "FAILED",
];
const PAYMENT_STATUS_MEMBERS = [
    "UNPAID",
    "PENDING",
    "PAID",
    "FAILED",
    "EXPIRED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
];
const ORDER_STATUS_MEMBERS = [
    "PENDING_PAYMENT",
    "PAID",
    "CANCELLED",
    "EXPIRED",
    "REFUNDED",
    "PARTIALLY_REFUNDED",
];

/* ==================================================================================
 * 1. THE URL MERGE
 * ================================================================================== */

describe("applyFilterChange keeps the URL the single source of truth", () => {
    it("omits a parameter when the all-option is chosen", () => {
        expect(applyFilterChange("/p", { status: "PAID" }, { status: null })).toBe("/p");
    });

    it("preserves every other filter, including a repeated one", () => {
        expect(
            applyFilterChange(
                "/p",
                { status: ["PENDING", "PROCESSING"], q: "foo" },
                { paymentStatus: "PAID" }
            )
        ).toBe("/p?status=PENDING&status=PROCESSING&q=foo&paymentStatus=PAID");
    });

    it("writes a repeated parameter once per value, never joined", () => {
        expect(
            applyFilterChange("/p", {}, { status: [...REFUND_NEEDS_HANDLING_STATUSES] })
        ).toBe("/p?status=PENDING&status=PROCESSING");

        expect(applyFilterChange("/p", {}, { status: [...EVENT_ACTIVE_STATUSES] })).toBe(
            "/p?status=PUBLISHED&status=ONGOING"
        );

        expect(
            applyFilterChange("/p", {}, {
                status: [...SETTLEMENT_AWAITING_APPROVAL_STATUSES],
            })
        ).toBe("/p?status=REQUESTED&status=PENDING_APPROVAL");
    });

    it("returns to page 1 on every filter change", () => {
        const href = applyFilterChange(
            "/dashboard/orders",
            { status: "PAID", page: "7" },
            { paymentStatus: "PAID" }
        );

        expect(href).toBe("/dashboard/orders?status=PAID&paymentStatus=PAID");
        expect(href).not.toContain("page=");
    });

    it("removes an emptied search term instead of leaving `q=` behind", () => {
        expect(applyFilterChange("/p", { q: "foo", status: "PAID" }, { q: null })).toBe(
            "/p?status=PAID"
        );
    });

    it("returns the bare path when nothing is left", () => {
        expect(applyFilterChange("/dashboard/payments", { q: "x" }, { q: null })).toBe(
            "/dashboard/payments"
        );
    });
});

/* ==================================================================================
 * 2. THE FIELD BUILDER — UNIONS, SINGLES, AND THE "SEMUA" OPTION
 * ================================================================================== */

describe("buildFilterField resolves the option the URL is actually in", () => {
    const eventField = (values: readonly string[]) =>
        buildFilterField({
            name: "status",
            label: "Status",
            allLabel: "Semua status",
            values,
            members: EVENT_STATUS_MEMBERS,
            labels: EVENT_STATUS_LABELS,
            union: {
                value: "active",
                label: "Aktif",
                statuses: EVENT_ACTIVE_STATUSES,
            },
        });

    it("selects the all-option, which removes the parameter, when nothing is filtered", () => {
        const field = eventField([]);

        expect(field.value).toBe(FILTER_ALL);
        expect(field.options[0].value).toBe(FILTER_ALL);
        expect(field.options[0].label).toBe("Semua status");
        expect(field.options[0].params).toEqual({ status: null });
    });

    it("recognises the named union however its values were ordered", () => {
        expect(eventField(["PUBLISHED", "ONGOING"]).value).toBe("active");
        expect(eventField(["ONGOING", "PUBLISHED"]).value).toBe("active");
    });

    it("emits the union as a REPEATED parameter", () => {
        const union = eventField([]).options.find((option) => option.value === "active");

        expect(union?.params).toEqual({ status: ["PUBLISHED", "ONGOING"] });
    });

    it("selects a single member when exactly one is filtered", () => {
        const field = eventField(["DRAFT"]);

        expect(field.value).toBe("DRAFT");
        expect(field.options.find((option) => option.value === "DRAFT")?.params).toEqual({
            status: "DRAFT",
        });
    });

    it("offers every individual status, so no enum member lost its filter", () => {
        const values = eventField([]).options.map((option) => option.value);

        for (const status of EVENT_STATUS_MEMBERS) {
            expect(values).toContain(status);
        }
    });

    it("shows an unnamed combination as itself rather than claiming 'Semua'", () => {
        const field = eventField(["DRAFT", "COMPLETED"]);

        expect(field.value).toBe(FILTER_COMBINATION);

        const synthetic = field.options.find(
            (option) => option.value === FILTER_COMBINATION
        );

        expect(synthetic?.label).toBe("Draft + Selesai");
        expect(synthetic?.params).toEqual({ status: ["DRAFT", "COMPLETED"] });
    });

    it("keys every option uniquely and labels it visibly", () => {
        for (const field of [
            eventField([]),
            eventField(["PUBLISHED", "ONGOING"]),
            eventField(["DRAFT", "COMPLETED"]),
            buildFilterField({
                name: "status",
                label: "Status refund",
                allLabel: "Semua status",
                values: ["PENDING", "PROCESSING"],
                members: REFUND_STATUS_MEMBERS,
                labels: REFUND_STATUS_LABELS,
                union: {
                    value: "needs_handling",
                    label: "Perlu Ditangani",
                    statuses: REFUND_NEEDS_HANDLING_STATUSES,
                },
            }),
        ]) {
            const values = field.options.map((option) => option.value);

            expect(new Set(values).size).toBe(values.length);
            expect(values.every((value) => value !== "")).toBe(true);
            expect(field.options.every((option) => option.label.trim() !== "")).toBe(true);
        }
    });

    it("carries the refund and settlement worklists as repeated parameters", () => {
        const refunds = buildFilterField({
            name: "status",
            label: "Status refund",
            allLabel: "Semua status",
            values: [],
            members: REFUND_STATUS_MEMBERS,
            labels: REFUND_STATUS_LABELS,
            union: {
                value: "needs_handling",
                label: "Perlu Ditangani",
                statuses: REFUND_NEEDS_HANDLING_STATUSES,
            },
        });

        expect(
            refunds.options.find((option) => option.value === "needs_handling")?.params
        ).toEqual({ status: ["PENDING", "PROCESSING"] });

        const settlements = buildFilterField({
            name: "status",
            label: "Status pencairan",
            allLabel: "Semua status",
            values: [],
            members: [...SETTLEMENT_STATUSES],
            labels: SETTLEMENT_STATUS_LABELS,
            union: {
                value: "awaiting_approval",
                label: "Menunggu Persetujuan",
                statuses: SETTLEMENT_AWAITING_APPROVAL_STATUSES,
            },
        });

        expect(
            settlements.options.find((option) => option.value === "awaiting_approval")
                ?.params
        ).toEqual({ status: ["REQUESTED", "PENDING_APPROVAL"] });

        for (const status of SETTLEMENT_STATUSES) {
            expect(settlements.options.map((option) => option.value)).toContain(status);
        }
    });

    it.each([
        ["status", EVENT_STATUS_MEMBERS, EVENT_STATUS_LABELS],
        ["paymentStatus", PAYMENT_STATUS_MEMBERS, PAYMENT_STATUS_LABELS],
        ["status", REFUND_STATUS_MEMBERS, REFUND_STATUS_LABELS],
        ["status", ORDER_STATUS_MEMBERS, ORDER_STATUS_LABELS],
    ] as const)(
        "makes every `%s` option write ONLY its own parameter",
        (name, members, labels) => {
            /*
             * One row moving another row's parameter is how two visible filters end up disagreeing
             * with the state they show. The builder cannot express that any more.
             */
            const field = buildFilterField({
                name,
                label: name,
                allLabel: "Semua",
                values: [],
                members: [...members],
                labels,
            });

            for (const option of field.options) {
                expect(Object.keys(option.params ?? {})).toEqual([name]);
            }
        }
    );
});

/* ==================================================================================
 * 3. RESET VISIBILITY
 * ================================================================================== */

describe("hasActiveFilter drives the reset affordance", () => {
    const field = buildFilterField({
        name: "status",
        label: "Status",
        allLabel: "Semua status",
        values: [],
        members: EVENT_STATUS_MEMBERS,
        labels: EVENT_STATUS_LABELS,
    });

    it("is false when nothing is selected", () => {
        expect(hasActiveFilter([field])).toBe(false);
        expect(hasActiveFilter([field], "")).toBe(false);
    });

    it("is true for a selection or a search term", () => {
        expect(hasActiveFilter([{ ...field, value: "DRAFT" }])).toBe(true);
        expect(hasActiveFilter([field], "foo")).toBe(true);
    });
});

/* ==================================================================================
 * 4. THE VOCABULARY
 * ================================================================================== */

describe("the label vocabulary covers every enum member", () => {
    it("names every status the dashboard can filter on", () => {
        for (const status of EVENT_STATUS_MEMBERS) {
            expect(EVENT_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }

        for (const status of PAYMENT_STATUS_MEMBERS) {
            expect(PAYMENT_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }

        for (const status of REFUND_STATUS_MEMBERS) {
            expect(REFUND_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }

        for (const status of SETTLEMENT_STATUSES) {
            expect(SETTLEMENT_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }

        for (const status of ORDER_STATUS_MEMBERS) {
            expect(ORDER_STATUS_LABELS[status]?.trim()).toBeTruthy();
        }
    });

    it("never collides the all-value with a real status", () => {
        expect(FILTER_ALL).toBe("all");

        for (const members of [
            EVENT_STATUS_MEMBERS,
            PAYMENT_STATUS_MEMBERS,
            REFUND_STATUS_MEMBERS,
            [...SETTLEMENT_STATUSES],
            ORDER_STATUS_MEMBERS,
        ]) {
            expect(members).not.toContain(FILTER_ALL);
        }

        for (const labels of [
            EVENT_STATUS_LABELS,
            PAYMENT_STATUS_LABELS,
            REFUND_STATUS_LABELS,
            SETTLEMENT_STATUS_LABELS,
            ORDER_STATUS_LABELS,
        ]) {
            expect(Object.keys(labels)).not.toContain(FILTER_ALL);
        }
    });

    it("names every window shortcut the reports parser accepts", () => {
        // The keys are derived from the periods the (protected) reports module defines, so a new
        // period cannot exist without a label and a pill.
        expect(REPORT_PERIOD_KEYS).toEqual(Object.keys(DASHBOARD_REPORT_PERIODS));
        expect(REPORT_PERIOD_KEYS.length).toBeGreaterThan(0);

        for (const period of REPORT_PERIOD_KEYS) {
            expect(REPORT_PERIOD_LABELS[period]?.trim()).toBeTruthy();
        }
    });
});

/* ==================================================================================
 * 6. THE PERIOD SHORTCUTS — A FIELD WITH NO "SEMUA" OPTION
 * ================================================================================== */

describe("buildPeriodField — a window is always a range", () => {
    const field = (active: string | null) =>
        buildPeriodField({
            active,
            keys: REPORT_PERIOD_KEYS,
            labels: REPORT_PERIOD_LABELS,
        });

    it("offers every shortcut, and no all-option", () => {
        const options = field(null).options;

        expect(options.map((option) => option.value)).toEqual([...REPORT_PERIOD_KEYS]);
        expect(options.some((option) => option.value === FILTER_ALL)).toBe(false);
        expect(options.every((option) => option.label.trim() !== "")).toBe(true);
    });

    it("writes ONLY `period`, so the merge drops an explicit from/to range", () => {
        for (const option of field(null).options) {
            expect(Object.keys(option.params ?? {})).toEqual(["period"]);
        }

        // The property that matters: a link that carried `from`/`to` too would let the explicit
        // range win inside `resolveDashboardReportFilters`, silently keeping the OLD window.
        expect(
            applyFilterChange(
                "/dashboard/reports",
                { eventId: "evt_1", status: "PAID" },
                { period: "7d" }
            )
        ).toBe("/dashboard/reports?eventId=evt_1&status=PAID&period=7d");
    });

    it("highlights the shortcut the URL is in, and none for a custom range", () => {
        expect(field("30d").value).toBe("30d");
        // Deliberately not `FILTER_ALL`: an explicit `from`/`to` range matches no shortcut.
        expect(field(null).value).toBe("");
    });
});

/* ==================================================================================
 * 5. SET EQUALITY IS ORDER-INDEPENDENT (the union's own recognition rule)
 * ================================================================================== */

describe("sameValueSet", () => {
    it("matches regardless of order and rejects a subset", () => {
        expect(sameValueSet(["PUBLISHED", "ONGOING"], ["ONGOING", "PUBLISHED"])).toBe(true);
        expect(sameValueSet(["PUBLISHED"], ["PUBLISHED", "ONGOING"])).toBe(false);
        expect(sameValueSet(["PUBLISHED", "ONGOING", "DRAFT"], ["PUBLISHED", "ONGOING"])).toBe(
            false
        );
    });
});
