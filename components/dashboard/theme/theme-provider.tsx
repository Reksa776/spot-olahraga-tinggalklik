"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
    type ReactNode,
} from "react";

import { useBrowserValue } from "@/lib/ui/browser-value";

import {
    APPEARANCES,
    DEFAULT_ACCENT,
    DEFAULT_APPEARANCE,
    DEFAULT_CHART_PALETTE,
    THEME_STORAGE,
    isAccentId,
    isChartPaletteId,
    type AccentId,
    type AppearanceId,
    type ChartPaletteId,
} from "./theme-config";

/**
 * ==========================================
 * DASHBOARD THEME PROVIDER
 * ==========================================
 *
 * Three settings, one mechanism each — and, deliberately, NO inline script:
 *
 *   APPEARANCE (light / dark / system) → `class="dark"` on <html> (and, through CSS, `color-scheme`)
 *   ACCENT                             → `data-accent` on <html>
 *   CHART PALETTE                      → `data-chart` on <html>
 *
 * The three attributes are applied BEFORE PAINT by `THEME_BOOTSTRAP_SCRIPT`, which
 * `app/layout.tsx` emits once as a plain inline `<script>` from the root Server Component. This
 * provider then re-applies them while the user is in the dashboard, and owns the picker state.
 *
 * ── WHY THE BOOTSTRAP IS NOT A COMPONENT IN THIS FILE ANY MORE ───────────────────
 * It used to be a `<script>` element returned by this module and rendered by `DashboardProviders`.
 * That is wrong in the App Router in two ways, and both were observed, not assumed:
 *
 *   1. React DOM warns ("Encountered a script tag while rendering React component …") because a
 *      `<script>` inside a route is a host element React must render. The warning fires when the
 *      route is entered by CLIENT-SIDE navigation, where there is no server HTML to hydrate and
 *      React therefore CREATES the node.
 *   2. The message is literal: on that path the script never executes, so the bootstrap silently
 *      did nothing for exactly the users who navigated into the dashboard (the post-login
 *      redirect, every in-app link) rather than hard-loading it.
 *
 * Moving it to the root layout as a plain inline `<script>` fixes both: the server renders it into
 * the first child of `<body>`, so the browser runs it during parsing, pre-paint, and it is not part
 * of any React segment, so no navigation re-renders it. A `next/script strategy="beforeInteractive"`
 * was tried first and rejected — for an INLINE script Next defers it past `DOMContentLoaded`
 * (verified against this app's Next version), which reintroduces the flash the script removes.
 *
 * The `next-themes` provider that used to sit here was removed for the same reason: it renders an
 * inline `<script>` of its own inside whatever segment mounts it, so it produced the identical
 * warning (and the identical no-op on client navigation) from a second source. Its behaviour —
 * `class="dark"`, system-preference following, `enableColorScheme`, `disableTransitionOnChange` and
 * the bare-string storage value — is reproduced below, against the same storage key.
 *
 * ── WHY THE PALETTES ARE ATTRIBUTES AND NOT REACT STATE-DRIVEN PROPS ─────────────
 * Setting an attribute makes the browser re-resolve the CSS custom properties, so every button,
 * link, ring, sidebar row, chart line and legend dot repaints in one pass. If the palettes were
 * threaded through props instead, a chart could keep an old colour until every consumer was updated
 * — and the brief's whole point is that a palette change must not require editing components.
 *
 * The state below exists only so the PICKER can show which option is selected. It is seeded from
 * the DOM attribute on mount, which is also what keeps it in step with the bootstrap script (the
 * script has already applied the attribute before React runs).
 *
 * ── NO HYDRATION MISMATCH ───────────────────────────────────────────────────────
 * The server render and the first client render both use the defaults; the real values are read
 * after mount through `useBrowserValue`. Nothing theme-dependent is rendered during that first
 * pass (the switcher guards on the same `mounted` signal), so React's markup always agrees, while
 * the CSS was already personalised by the bootstrap script — the user sees the right palette from
 * the first frame without React having to agree with it.
 */

type ResolvedAppearance = "light" | "dark";

type DashboardThemeContextValue = {
    /** The user's choice, which may be `system`. */
    theme: AppearanceId;
    /** `light` or `dark` — `system` already resolved against the OS preference. */
    resolvedTheme: ResolvedAppearance;
    setTheme: (appearance: AppearanceId) => void;
    accent: AccentId;
    chartPalette: ChartPaletteId;
    setAccent: (accent: AccentId) => void;
    setChartPalette: (palette: ChartPaletteId) => void;
    reset: () => void;
};

const DashboardThemeContext = createContext<DashboardThemeContextValue | null>(null);

function readAttribute(name: string, fallback: string): string {
    if (typeof document === "undefined") return fallback;
    return document.documentElement.getAttribute(name) ?? fallback;
}

function readStorage(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function isAppearanceId(value: string | null): value is AppearanceId {
    return APPEARANCES.some((appearance) => appearance.id === value);
}

/**
 * The accent the browser is already showing: storage first, then the attribute the bootstrap script
 * set. Returns `null` when the stored value is not a palette this build knows, so the caller falls
 * back to the default rather than rendering a selection the CSS cannot honour.
 */
function readStoredAccent(): AccentId | null {
    const value = readStorage(THEME_STORAGE.accent) ?? readAttribute("data-accent", "");

    return isAccentId(value) ? value : null;
}

function readStoredChartPalette(): ChartPaletteId | null {
    const value = readStorage(THEME_STORAGE.chart) ?? readAttribute("data-chart", "");

    return isChartPaletteId(value) ? value : null;
}

/**
 * The stored appearance, or `null` when the user has never chosen one.
 *
 * `null` is meaningful and different from `light`: it means "the bootstrap script is still the
 * authority", which is what stops the mount effect below from clearing a `dark` class the script
 * just applied for a `system` user on a dark OS.
 */
function readStoredAppearance(): AppearanceId | null {
    const value = readStorage(THEME_STORAGE.appearance);

    return isAppearanceId(value) ? value : null;
}

/**
 * Suppress transitions for one frame while the appearance swaps, then remove the suppression.
 *
 * The one visible reason this exists: without it, toggling light/dark animates every element that
 * carries a `transition` utility, which reads as a slow smear rather than a theme change. This
 * reproduces the previous provider's `disableTransitionOnChange`.
 */
function withoutTransitions(apply: () => void): void {
    const style = document.createElement("style");

    style.appendChild(
        document.createTextNode(
            "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}"
        )
    );

    document.head.appendChild(style);

    try {
        apply();
        // Force the browser to resolve the styles it just set before the suppression is lifted.
        window.getComputedStyle(document.body);
    } finally {
        window.setTimeout(() => style.remove(), 1);
    }
}

export function DashboardThemeProvider({ children }: { children: ReactNode }) {
    return <DashboardThemeProviderInner>{children}</DashboardThemeProviderInner>;
}

function DashboardThemeProviderInner({ children }: { children: ReactNode }) {
    /*
     * ADOPT, THEN OVERRIDE
     * --------------------
     * Each selection has two possible sources and both are needed:
     *
     *   `readStored*()`   what the browser is ALREADY showing — the bootstrap script applied it
     *                     before paint, so this is the value the user is looking at. It is read as
     *                     a client snapshot, which is what makes the first client render use the
     *                     default (matching the server's markup, so no hydration mismatch) and the
     *                     very next one use the real value.
     *
     *   `*Override`       what the user picked in THIS session.
     *
     * The override wins, so a click repaints immediately without a read-back, and `null` until the
     * user chooses means the picker shows the adopted value rather than a default that would
     * contradict the dashboard around it.
     */
    const [themeOverride, setThemeOverride] = useState<AppearanceId | null>(null);
    const [accentOverride, setAccentOverride] = useState<AccentId | null>(null);
    const [chartOverride, setChartOverride] = useState<ChartPaletteId | null>(null);

    const storedAppearance = useBrowserValue<AppearanceId | null>(readStoredAppearance, null);
    const storedAccent = useBrowserValue<AccentId | null>(readStoredAccent, null);
    const storedChart = useBrowserValue<ChartPaletteId | null>(readStoredChartPalette, null);

    /*
     * The OS preference, subscribed rather than sampled: a user whose OS flips to dark while the
     * dashboard is open (or whose `system` selection is already active) must follow it live. `null`
     * means "not known yet", which is what keeps the mount effect below from fighting the
     * bootstrap script before matchMedia has been read.
     */
    const [systemPrefersDark, setSystemPrefersDark] = useState<boolean | null>(null);

    useEffect(() => {
        const query = window.matchMedia("(prefers-color-scheme: dark)");
        const sync = () => setSystemPrefersDark(query.matches);

        sync();
        query.addEventListener("change", sync);

        return () => query.removeEventListener("change", sync);
    }, []);

    const theme = themeOverride ?? storedAppearance ?? DEFAULT_APPEARANCE;
    const accent = accentOverride ?? storedAccent ?? DEFAULT_ACCENT;
    const chartPalette = chartOverride ?? storedChart ?? DEFAULT_CHART_PALETTE;

    const resolvedTheme: ResolvedAppearance =
        theme === "system"
            ? systemPrefersDark
                ? "dark"
                : "light"
            : theme;

    /*
     * WHICH APPEARANCE IS ALLOWED TO TOUCH <html>
     * -------------------------------------------
     * The bootstrap script has already applied the correct class, so this effect must only run once
     * it knows something the script did not encode:
     *
     *   - a session override (the user clicked), or
     *   - the stored value (so a `system` selection can be re-resolved live).
     *
     * Until then it stays out of the way. Without this guard the first effect pass would run with
     * `theme = DEFAULT_APPEARANCE` and `systemPrefersDark = null`, i.e. it would strip the `dark`
     * class from a `system` user on a dark OS for one frame.
     */
    const appearanceKnown = themeOverride !== null || storedAppearance !== null;

    useEffect(() => {
        if (!appearanceKnown) return;
        if (theme === "system" && systemPrefersDark === null) return;

        withoutTransitions(() => {
            const root = document.documentElement;

            if (resolvedTheme === "dark") {
                root.classList.add("dark");
            } else {
                root.classList.remove("dark");
            }

            /*
             * `enableColorScheme` (native scrollbars, form widgets and spinners in the right mode)
             * is NOT set here. It follows the class: `app/globals.css` declares
             * `html { color-scheme: light }` / `html.dark { color-scheme: dark }`, so the CSS engine
             * applies it in the same frame as the class change above.
             *
             * Setting `root.style.colorScheme` from here — and from the bootstrap script — is what
             * made <html> carry an inline `style` attribute the server-rendered markup does not,
             * i.e. a hydration mismatch on every page load. Declaring it in CSS is what removed it;
             * expressing it as a class-derived rule is what keeps the effects identical.
             */
        });
    }, [appearanceKnown, theme, systemPrefersDark, resolvedTheme]);

    const setTheme = useCallback((next: AppearanceId) => {
        setThemeOverride(next);

        try {
            window.localStorage.setItem(THEME_STORAGE.appearance, next);
        } catch {
            /* storage unavailable: the choice still applies for this session */
        }
    }, []);

    const setAccent = useCallback((next: AccentId) => {
        setAccentOverride(next);
        document.documentElement.setAttribute("data-accent", next);

        try {
            window.localStorage.setItem(THEME_STORAGE.accent, next);
        } catch {
            /* storage unavailable: the palette still applies for this session */
        }
    }, []);

    const setChartPalette = useCallback((next: ChartPaletteId) => {
        setChartOverride(next);
        document.documentElement.setAttribute("data-chart", next);

        try {
            window.localStorage.setItem(THEME_STORAGE.chart, next);
        } catch {
            /* storage unavailable: the palette still applies for this session */
        }
    }, []);

    const reset = useCallback(() => {
        setAccent(DEFAULT_ACCENT);
        setChartPalette(DEFAULT_CHART_PALETTE);
    }, [setAccent, setChartPalette]);

    const value = useMemo(
        () => ({
            theme,
            resolvedTheme,
            setTheme,
            accent,
            chartPalette,
            setAccent,
            setChartPalette,
            reset,
        }),
        [
            theme,
            resolvedTheme,
            setTheme,
            accent,
            chartPalette,
            setAccent,
            setChartPalette,
            reset,
        ]
    );

    return (
        <DashboardThemeContext.Provider value={value}>
            {children}
        </DashboardThemeContext.Provider>
    );
}

export function useDashboardTheme(): DashboardThemeContextValue {
    const context = useContext(DashboardThemeContext);

    if (!context) {
        throw new Error("useDashboardTheme must be used inside DashboardThemeProvider");
    }

    return context;
}
