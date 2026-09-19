/**
 * ==========================================
 * DASHBOARD THEME CONFIGURATION
 * ==========================================
 *
 * The catalogue behind the two appearance controls. It is data — no JSX, no `"use client"` — so the
 * server layout, the settings panel and a test can all read the same list.
 *
 * WHERE THE ACTUAL COLOURS LIVE
 * -----------------------------
 * In `app/globals.css`, as CSS custom properties keyed by attribute:
 *
 *     [data-accent="violet"] { --primary: …; --ring: … }
 *     [data-chart="ocean"]   { --chart-1: … }
 *
 * That is deliberate. Swapping a palette is a cascade, so it repaints instantly, needs no React
 * re-render, cannot desynchronise two components, and survives hydration. If the colours were
 * objects in this file instead, every chart would have to be re-rendered on change and a single
 * missed prop would leave one card in the old palette.
 *
 * The `swatch` values below are MIRRORS of the first CSS variable each palette sets, and they exist
 * only so the picker can draw a colour chip next to the label. They are the one place a hex value
 * is duplicated, they are asserted against the stylesheet by
 * `__tests__/ui-consolidation/shadcn-dashboard.test.ts`, and nothing else in the dashboard reads
 * them.
 */

export const ACCENTS = [
    { id: "orange", label: "Orange", hint: "Identitas TinggalKlik.Co", swatch: "#e04e05" },
    { id: "blue", label: "Blue", hint: "Tenang dan netral", swatch: "#2563eb" },
    { id: "violet", label: "Violet", hint: "Kontras tinggi", swatch: "#7c3aed" },
    { id: "emerald", label: "Emerald", hint: "Nuansa finansial", swatch: "#059669" },
    { id: "rose", label: "Rose", hint: "Hangat dan tegas", swatch: "#e11d48" },
    { id: "slate", label: "Slate", hint: "Minimal dan formal", swatch: "#475569" },
] as const;

export type AccentId = (typeof ACCENTS)[number]["id"];

export const CHART_PALETTES = [
    {
        id: "default",
        label: "Default",
        hint: "Campuran lima warna",
        swatches: ["#e04e05", "#0e7490", "#7c3aed", "#ca8a04", "#1d4ed8"],
    },
    {
        id: "ocean",
        label: "Ocean",
        hint: "Biru dan teal",
        swatches: ["#0369a1", "#0891b2", "#14b8a6", "#0e7490", "#38bdf8"],
    },
    {
        id: "violet",
        label: "Violet",
        hint: "Ungu",
        swatches: ["#6d28d9", "#8b5cf6", "#a855f7", "#4c1d95", "#c084fc"],
    },
    {
        id: "emerald",
        label: "Emerald",
        hint: "Hijau",
        swatches: ["#047857", "#059669", "#10b981", "#065f46", "#34d399"],
    },
    {
        id: "sunset",
        label: "Sunset",
        hint: "Oranye dan merah",
        swatches: ["#c2410c", "#ea580c", "#f59e0b", "#dc2626", "#db2777"],
    },
    {
        id: "monochrome",
        label: "Monochrome",
        hint: "Abu-abu netral",
        swatches: ["#1f2937", "#475569", "#64748b", "#94a3b8", "#cbd5e1"],
    },
] as const;

export type ChartPaletteId = (typeof CHART_PALETTES)[number]["id"];

export const APPEARANCES = [
    { id: "light", label: "Terang" },
    { id: "dark", label: "Gelap" },
    { id: "system", label: "Ikuti sistem" },
] as const;

export type AppearanceId = (typeof APPEARANCES)[number]["id"];

export const DEFAULT_ACCENT: AccentId = "orange";
export const DEFAULT_CHART_PALETTE: ChartPaletteId = "default";
export const DEFAULT_APPEARANCE: AppearanceId = "light";

/**
 * Client-side persistence only. The brief is explicit that no database change is wanted for an
 * appearance preference, and none is needed: these are read by the inline bootstrap script and by
 * the settings provider, and they never reach the server.
 */
export const THEME_STORAGE = {
    appearance: "tk-dashboard-appearance",
    accent: "tk-dashboard-accent",
    chart: "tk-dashboard-chart",
} as const;

export function isAccentId(value: string | null): value is AccentId {
    return ACCENTS.some((accent) => accent.id === value);
}

export function isChartPaletteId(value: string | null): value is ChartPaletteId {
    return CHART_PALETTES.some((palette) => palette.id === value);
}

/**
 * The bootstrap script, rendered into the dashboard layout.
 *
 * It runs BEFORE first paint and before hydration, which is what removes the flash of the default
 * palette on a page the user has already personalised — the same technique `next-themes` uses for
 * light/dark, extended to the two palettes. A failure (storage disabled, private mode) leaves the
 * CSS defaults in place rather than throwing.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(function(){try{var d=document.documentElement;var a=localStorage.getItem(${JSON.stringify(
    THEME_STORAGE.accent
)});if(a){d.setAttribute("data-accent",a);}var c=localStorage.getItem(${JSON.stringify(
    THEME_STORAGE.chart
)});if(c){d.setAttribute("data-chart",c);}}catch(e){}})();`;
