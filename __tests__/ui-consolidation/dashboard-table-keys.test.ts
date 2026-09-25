/**
 * ==========================================
 * DASHBOARD TABLE — NO MISSING-KEY WARNING (PHASE 33)
 * ==========================================
 *
 * The reported defect:
 *
 *   "Each child in a list should have a unique key prop.
 *    Check the render method of `DataTable`.
 *    It was passed a child from DashboardPaymentsPage."
 *
 * A React key warning names the parent whose render produced the unkeyed array, and the
 * owner of the offending element. This suite renders the SAME shapes the payments page
 * passes (`cells` arrays, an inline conditional cell, a component cell, a link cell) and
 * fails if React emits the warning again — so the fix is pinned instead of the symptom being
 * suppressed.
 *
 * `react-dom/server` is used because the repository has no jsdom/testing-library; that is
 * also sufficient here, because the warning is raised during element creation/validation,
 * which the server renderer exercises identically.
 */

import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    DataTable,
    LinkPagination,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";

/*
 * React 19's `createElement` overloads fold declared `children` into the props object, so
 * passing children as the third argument to a component whose props declare them is a type
 * error — even though it is exactly what the dashboard page's JSX compiles down to. The
 * probe casts to a props-loose component so the render matches production usage without
 * changing the components under test.
 */
type LooseProps = Record<string, unknown>;
const LooseTextLink = TextLink as ComponentType<LooseProps>;
const LooseStatusBadge = StatusBadge as ComponentType<LooseProps>;
const LooseLinkPagination = LinkPagination as ComponentType<LooseProps>;

/** Collect every `console.error` produced while rendering. */
function warningsFrom(render: () => ReactNode): string[] {
    const messages: string[] = [];
    const original = console.error;

    console.error = (...args: unknown[]) => {
        messages.push(args.map((value) => String(value)).join(" "));
    };

    try {
        renderToStaticMarkup(createElement("div", null, render()));
    } finally {
        console.error = original;
    }

    return messages.filter((message) => message.includes("unique \"key\""));
}

const COLUMNS = [
    { header: "Referensi" },
    { header: "Pesanan" },
    { header: "Jumlah", align: "right" as const },
    { header: "Tindakan" },
];

describe("DataTable emits no missing-key warning", () => {
    test("a payments-shaped table with a conditional and a component cell is warning-free", () => {
        const messages = warningsFrom(() =>
            createElement(DataTable, {
                minWidth: 1220,
                columns: COLUMNS,
                rows: [
                    {
                        key: "pay-1",
                        cells: [
                            createElement("span", { key: "ref" }, "PAY-1"),
                            createElement(
                                "span",
                                { key: "order" },
                                "EVT-1"
                            ),
                            createElement(
                                "span",
                                { key: "amount" },
                                "Rp100.000"
                            ),
                            // The inline conditional the page uses: a component in one
                            // branch, a plain element in the other.
                            true
                                ? createElement(
                                      "button",
                                      { key: "action", type: "button" },
                                      "Verifikasi"
                                  )
                                : createElement(
                                      "span",
                                      { key: "action" },
                                      "—"
                                  ),
                        ],
                    },
                    {
                        key: "pay-2",
                        cells: [
                            createElement("span", { key: "ref" }, "PAY-2"),
                            createElement(
                                "span",
                                { key: "order" },
                                "EVT-2"
                            ),
                            createElement(
                                "span",
                                { key: "amount" },
                                "Rp50.000"
                            ),
                            createElement("span", { key: "action" }, "—"),
                        ],
                    },
                ],
            })
        );

        expect(messages).toEqual([]);
    });

    test("PROBE — the real cell components (TextLink, StatusBadge) and footer are warning-free", () => {
        const messages = warningsFrom(() =>
            createElement(DataTable, {
                columns: [{ header: "Pesanan" }, { header: "Status" }],
                rows: [
                    {
                        key: "pay-1",
                        cells: [
                            createElement(
                                LooseTextLink,
                                { key: "order", href: "/dashboard/orders/EVT-1" },
                                createElement("span", { key: "inner" }, "EVT-1")
                            ),
                            createElement(
                                LooseStatusBadge,
                                { key: "status", tone: "success" },
                                createElement("span", { key: "inner" }, "PAID")
                            ),
                        ],
                    },
                ],
                footer: createElement(LooseLinkPagination, {
                    page: 2,
                    totalPages: 5,
                    basePath: "/dashboard/payments",
                }),
            })
        );

        expect(messages).toEqual([]);
    });

    test("a table named by a `columns` array of plain strings is warning-free", () => {
        const messages = warningsFrom(() =>
            createElement(DataTable, {
                columns: [{ header: "A" }, { header: "B" }],
                rows: [
                    { key: "r1", cells: ["a1", "b1"] },
                    { key: "r2", cells: ["a2", "b2"] },
                ],
            })
        );

        expect(messages).toEqual([]);
    });

    test("the empty, loading and error states are warning-free too", () => {
        expect(
            warningsFrom(() =>
                createElement(DataTable, {
                    columns: COLUMNS,
                    rows: [],
                    empty: createElement("p", null, "kosong"),
                })
            )
        ).toEqual([]);

        expect(
            warningsFrom(() =>
                createElement(DataTable, {
                    columns: COLUMNS,
                    rows: [],
                    loading: true,
                })
            )
        ).toEqual([]);

        expect(
            warningsFrom(() =>
                createElement(DataTable, {
                    columns: COLUMNS,
                    rows: [],
                    error: createElement("p", null, "gagal"),
                })
            )
        ).toEqual([]);
    });
});
