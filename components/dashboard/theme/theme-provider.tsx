"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useState,
    type ReactNode,
} from "react";

import { useBrowserValue } from "@/lib/ui/browser-value";

import {
    DEFAULT_ACCENT,
    DEFAULT_CHART_PALETTE,
    THEME_BOOTSTRAP_SCRIPT,
    THEME_STORAGE,
    isAccentId,
    isChartPaletteId,
    type AccentId,
    type ChartPaletteId,
} from "./theme-config";

/**
 * ==========================================
 * DASHBOARD THEME PROVIDER
 * ==========================================
 *
 * Three settings, two mechanisms:
 *
 *   APPEARANCE (light / dark / system) → `next-themes`, which toggles `class="dark"` on <html>
 *   and already knows how to follow the OS and persist the choice.
 *
 *   ACCENT + CHART PALETTE → `data-accent` / `data-chart` on <html>, set from localStorage.
 *
 * WHY THE TWO PALETTES ARE ATTRIBUTES AND NOT REACT STATE-DRIVEN PROPS
 * -------------------------------------------------------------------
 * Setting an attribute makes the browser re-resolve the CSS custom properties, so every button,
 * link, ring, sidebar row, chart line and legend dot repaints in one pass. If the palettes were
 * threaded through props instead, a chart could keep an old colour until every consumer was updated
 * — and the brief's whole point is that a palette change must not require editing components.
 *
 * The state below exists only so the *picker UI* can show which option is selected. It is seeded
 * from the DOM attribute on mount, which is also what keeps it in step with the bootstrap script
 * (the script has already applied the attribute before React runs).
 *
 * NO HYDRATION MISMATCH: the initial render deliberately uses the defaults and the real values are
 * applied in an effect. React therefore renders the same markup on the server and on the first
 * client pass, while the CSS was already personalised by the inline script — so the user sees the
 * right palette from the first frame without React having to agree with it.
 */

type DashboardThemeContextValue = {
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
 * The inline bootstrap. Rendered by the dashboard layouts so it is in the initial HTML and runs
 * before paint; it is a plain script tag rather than a module because it must not wait for the
 * client bundle.
 */
export function DashboardThemeScript() {
    return <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />;
}

export function DashboardThemeProvider({ children }: { children: ReactNode }) {
    return (
        <NextThemesProvider
            attribute="class"
            defaultTheme="light"
            enableSystem
            storageKey={THEME_STORAGE.appearance}
            disableTransitionOnChange
        >
            <DashboardPaletteProvider>{children}</DashboardPaletteProvider>
        </NextThemesProvider>
    );
}

function DashboardPaletteProvider({ children }: { children: ReactNode }) {
    /*
     * ADOPT, THEN OVERRIDE
     * --------------------
     * The selection has two possible sources and both are needed:
     *
     *   `readStoredAccent()`  what the browser is ALREADY showing — the bootstrap script applied it
     *                         before paint, so this is the value the user is looking at. It is read as
     *                         a client snapshot, which is what makes the first client render use the
     *                         default (matching the server's markup, so no hydration mismatch) and
     *                         the very next one use the real value.
     *
     *   `accentOverride`      what the user picked in THIS session.
     *
     * The override wins, so a click repaints immediately without a read-back, and `null` until the
     * user chooses means the picker shows the adopted value rather than a default that would
     * contradict the dashboard around it.
     */
    const [accentOverride, setAccentOverride] = useState<AccentId | null>(null);
    const [chartOverride, setChartOverride] = useState<ChartPaletteId | null>(null);

    const storedAccent = useBrowserValue<AccentId | null>(readStoredAccent, null);
    const storedChart = useBrowserValue<ChartPaletteId | null>(readStoredChartPalette, null);

    const accent = accentOverride ?? storedAccent ?? DEFAULT_ACCENT;
    const chartPalette = chartOverride ?? storedChart ?? DEFAULT_CHART_PALETTE;

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
        () => ({ accent, chartPalette, setAccent, setChartPalette, reset }),
        [accent, chartPalette, setAccent, setChartPalette, reset]
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
