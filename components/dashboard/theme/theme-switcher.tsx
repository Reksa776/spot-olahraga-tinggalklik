"use client";

import { useBrowserValue } from "@/lib/ui/browser-value";
import { Check, Monitor, Moon, Paintbrush, Sun, SunMoon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/dashboard/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/dashboard/ui/dropdown-menu";
import {
    ACCENTS,
    APPEARANCES,
    CHART_PALETTES,
    type AccentId,
    type AppearanceId,
    type ChartPaletteId,
} from "./theme-config";
import { useDashboardTheme } from "./theme-provider";

/**
 * ==========================================
 * THEME SETTINGS
 * ==========================================
 *
 * The dashboard's own appearance panel, in the top bar. One menu covers all three user-facing
 * controls the brief asks for:
 *
 *   Tampilan      Terang · Gelap · Ikuti sistem     (class on <html>)
 *   Warna tema    six accent hues                   (data-accent)
 *   Palet grafik  six chart palettes                (data-chart)
 *
 * All three are provided by `DashboardThemeProvider`; the appearance half used to come from
 * `next-themes`, which was replaced because its own inline `<script>` reproduced the theme-bootstrap
 * console error this phase fixes (see `theme-provider.tsx`).
 *
 * WHY A DROPDOWN AND NOT A SETTINGS PAGE
 * --------------------------------------
 * The preference is personal, device-local and momentary — a user tries a palette and keeps it or
 * does not. A menu keeps that a two-click loop, where a settings page would mean leaving the screen
 * the user is judging the colours on. Nothing here is persisted server-side, because no database
 * change is wanted for an appearance preference.
 *
 * Every option renders a real swatch, so the choice is made by looking rather than by reading a
 * colour name.
 */
export function ThemeSettingsMenu() {
    const { theme, setTheme, accent, chartPalette, setAccent, setChartPalette } =
        useDashboardTheme();

    // `theme` is still the default during the server render; the panel only shows a selection once
    // the client knows the real value, which is what keeps the menu from flashing "Terang" over a
    // dark session. Read through `useBrowserValue` rather than `useState` + `useEffect`: same timing
    // (false on the server and on the first client pass, true immediately after), without a state
    // update inside an effect.
    const mounted = useBrowserValue(() => true, false);

    const currentAppearance: AppearanceId = mounted ? theme : "system";

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Pengaturan tampilan"
                    className="text-muted-foreground hover:text-foreground"
                >
                    <SunMoon />
                </Button>
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel className="flex items-center gap-2">
                    <Monitor className="size-3.5" /> Tampilan
                </DropdownMenuLabel>

                {APPEARANCES.map((appearance) => (
                    <DropdownMenuItem
                        key={appearance.id}
                        onSelect={() => setTheme(appearance.id)}
                        className="justify-between"
                    >
                        <span className="flex items-center gap-2.5">
                            {appearance.id === "light" ? (
                                <Sun className="size-4" />
                            ) : appearance.id === "dark" ? (
                                <Moon className="size-4" />
                            ) : (
                                <Monitor className="size-4" />
                            )}
                            {appearance.label}
                        </span>

                        {currentAppearance === appearance.id ? (
                            <Check className="size-4 text-primary" />
                        ) : null}
                    </DropdownMenuItem>
                ))}

                <DropdownMenuSeparator />

                <DropdownMenuLabel className="flex items-center gap-2">
                    <Paintbrush className="size-3.5" /> Warna tema
                </DropdownMenuLabel>

                {ACCENTS.map((option) => (
                    <DropdownMenuItem
                        key={option.id}
                        onSelect={() => setAccent(option.id as AccentId)}
                        className="justify-between"
                    >
                        <span className="flex items-center gap-2.5">
                            <span
                                aria-hidden
                                className="size-4 rounded-full border border-border"
                                style={{ backgroundColor: option.swatch }}
                            />
                            <span className="flex flex-col">
                                <span>{option.label}</span>
                                <span className="text-[0.6875rem] font-normal text-muted-foreground">
                                    {option.hint}
                                </span>
                            </span>
                        </span>

                        {accent === option.id ? (
                            <Check className="size-4 text-primary" />
                        ) : null}
                    </DropdownMenuItem>
                ))}

                <DropdownMenuSeparator />

                <DropdownMenuLabel className="flex items-center gap-2">
                    <Paintbrush className="size-3.5" /> Palet grafik
                </DropdownMenuLabel>

                {CHART_PALETTES.map((palette) => (
                    <DropdownMenuItem
                        key={palette.id}
                        onSelect={() => setChartPalette(palette.id as ChartPaletteId)}
                        className="justify-between"
                    >
                        <span className="flex items-center gap-2.5">
                            <span aria-hidden className="flex gap-0.5">
                                {palette.swatches.map((color) => (
                                    <span
                                        key={color}
                                        className="h-4 w-1.5 rounded-full"
                                        style={{ backgroundColor: color }}
                                    />
                                ))}
                            </span>
                            <span className="flex flex-col">
                                <span>{palette.label}</span>
                                <span className="text-[0.6875rem] font-normal text-muted-foreground">
                                    {palette.hint}
                                </span>
                            </span>
                        </span>

                        {chartPalette === palette.id ? (
                            <Check className="size-4 text-primary" />
                        ) : null}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** A one-click light/dark switch for the top bar, for the common case. */
export function ThemeQuickToggle({ className }: { className?: string }) {
    const { resolvedTheme, setTheme } = useDashboardTheme();
    const mounted = useBrowserValue(() => true, false);

    const isDark = mounted && resolvedTheme === "dark";

    return (
        <Button
            variant="ghost"
            size="icon"
            aria-label={isDark ? "Aktifkan mode terang" : "Aktifkan mode gelap"}
            className={cn("text-muted-foreground hover:text-foreground", className)}
            onClick={() => setTheme(isDark ? "light" : "dark")}
        >
            {isDark ? <Sun /> : <Moon />}
        </Button>
    );
}
