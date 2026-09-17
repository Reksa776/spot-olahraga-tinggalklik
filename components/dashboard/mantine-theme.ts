import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * ==========================================
 * TINGGALKLIK.CO — MANTINE THEME (DASHBOARD)
 * ==========================================
 *
 * The theme is the bridge between the two design systems in this repository: Mantine's own token
 * set, and the `ink`/`brand` scales that `app/globals.css` declares and the customer-facing
 * surfaces already use. The numeric values below are **copied from that stylesheet**, so the
 * dashboard's primary button and the discovery hero's primary button are the same orange rather
 * than two oranges that almost match.
 *
 * WHY THIS FILE IS PLAIN TYPESCRIPT
 * ---------------------------------
 * No `"use client"`, no JSX. The theme is data, so it can be imported from a server component, from
 * a client component, from a test, and read by a script without dragging a React boundary with it.
 *
 * WHY THE SHADES ARE CHOSEN RATHER THAN DEFAULTED
 * ----------------------------------------------
 * `primaryShade` is **7**, not Mantine's default 6. The filled variant puts white text on the shade
 * it picks, and white on brand-600 (`#e04e05`) is only ~3.9:1 — under WCAG AA for body-sized text.
 * brand-700 (`#b93d07`) is ~5.6:1, which passes. The brief asks for comfortable, legible controls,
 * so the accessible shade is the default and brand-600/500 remain available for borders, hovers
 * and accents.
 *
 * Sizes: Mantine defaults *inputs* to `sm` (36px) and *buttons* to `md` (36px). The brief calls the
 * previous dashboard's controls too small, so inputs are raised to `md` (42px) and buttons keep
 * `md` with `lg` reserved for a page's primary action. Nothing is inflated beyond that — hierarchy
 * is the point, not size.
 */

/** The `brand` scale, verbatim from `app/globals.css` (50 → 900, ten shades). */
const BRAND: MantineColorsTuple = [
    "#fff5ed",
    "#ffe7d5",
    "#ffcaaa",
    "#ffa674",
    "#ff8038",
    "#f96311",
    "#e04e05",
    "#b93d07",
    "#93320d",
    "#782c0e",
];

/**
 * The `ink` scale, verbatim from `app/globals.css`. That stylesheet declares eleven steps (50 → 950)
 * and a Mantine tuple holds exactly ten, so `ink-600` (`#35466a`) is the one dropped: it is the
 * step with no distinct role here — 700/800 carry the sidebar and heading weights, and 500/400
 * carry muted text. This is the only place the two scales differ, and it is deliberate.
 */
const INK: MantineColorsTuple = [
    "#f4f6fb",
    "#e7ebf4",
    "#c9d2e5",
    "#9aa9c8",
    "#6c7fa8",
    "#4a5c85",
    "#263455",
    "#1a2540",
    "#101a2e",
    "#0a1120",
];

/**
 * Literal scale values, for the one library that cannot read the theme: Recharts paints SVG
 * presentation attributes (`stroke`, `fill`), where a CSS custom property is not reliably
 * substituted. Exporting them here keeps a single source for the palette — a chart cannot drift
 * from the buttons beside it.
 */
export const CHART_COLORS = {
    brand: BRAND[6],
    brandSoft: BRAND[3],
    ink: INK[8],
    grid: "#e7ebf4",
    axis: "#6c7fa8",
} as const;

/** The same system stack Tailwind's preflight applies, so type does not shift at the shell edge. */
const FONT_STACK =
    'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"';

export const dashboardTheme = createTheme({
    colors: {
        brand: BRAND,
        ink: INK,
    },
    primaryColor: "brand",
    primaryShade: { light: 7, dark: 7 },

    fontFamily: FONT_STACK,
    fontFamilyMonospace:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',

    headings: {
        fontFamily: FONT_STACK,
        fontWeight: "700",
        sizes: {
            h1: { fontSize: "1.75rem", lineHeight: "1.25" },
            h2: { fontSize: "1.375rem", lineHeight: "1.3" },
            h3: { fontSize: "1.125rem", lineHeight: "1.35" },
        },
    },

    defaultRadius: "md",
    cursorType: "pointer",
    respectReducedMotion: true,
    autoContrast: true,

    components: {
        // Inputs are raised from Mantine's `sm` default: the dashboard's forms are dense and were
        // criticised as cramped, and 42px is a comfortable pointer target on both desktop and touch.
        TextInput: { defaultProps: { size: "md" } },
        PasswordInput: { defaultProps: { size: "md" } },
        NumberInput: { defaultProps: { size: "md" } },
        Textarea: { defaultProps: { size: "md" } },
        Select: { defaultProps: { size: "md" } },
        MultiSelect: { defaultProps: { size: "md" } },
        DateInput: { defaultProps: { size: "md" } },
        FileInput: { defaultProps: { size: "md" } },
        Checkbox: { defaultProps: { size: "md" } },
        Radio: { defaultProps: { size: "md" } },
        Switch: { defaultProps: { size: "md" } },

        // Tables: roomy by default. `highlightOnHover` is on so a row is scannable across eleven
        // columns, which is what the order and product tables actually look like.
        Table: {
            defaultProps: {
                highlightOnHover: true,
                withTableBorder: true,
                horizontalSpacing: "md",
                verticalSpacing: "sm",
                fz: "sm",
            },
        },

        Card: { defaultProps: { withBorder: true, radius: "md", padding: "lg" } },
        Paper: { defaultProps: { withBorder: true, radius: "md" } },
        Badge: { defaultProps: { radius: "sm", variant: "light" } },
        Modal: { defaultProps: { radius: "md", centered: true, overlayProps: { blur: 2 } } },
        Drawer: { defaultProps: { radius: "md" } },
    },
});
