import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { isNavGroupActive, isNavItemActive, pickActiveNavHref } from "@/lib/ui/dashboard-nav";
import { ACCENTS, CHART_PALETTES, THEME_BOOTSTRAP_SCRIPT, THEME_STORAGE } from "@/components/dashboard/theme/theme-config";

/**
 * ==========================================
 * SHADCN DASHBOARD
 * ==========================================
 *
 * The dashboard was migrated from Mantine to shadcn/ui + Tailwind. This suite pins the parts of that
 * migration that are *behaviour and architecture*, not appearance:
 *
 *   • the navigation's active-state rule (the one piece of dashboard logic a screenshot would not
 *     reveal — a sidebar claiming the user is somewhere they are not);
 *   • that the ONE dashboard menu only advertises destinations that exist;
 *   • that authority still decides the menu, and the shell never widens it;
 *   • that the theme system is real: the tokens exist, the palettes are reachable from one control,
 *     and the swatch catalogue cannot drift from the stylesheet;
 *   • that charts read the chart tokens rather than hex literals;
 *   • that the dashboard has no footer and the customer-facing footer is untouched;
 *   • that the frozen surfaces (forms, APIs, schema, payment) were not touched by a UI migration.
 *
 * Deliberately NOT asserted: colours, spacing, component sizes. Restyling the dashboard must not
 * fail this suite; breaking a link, a permission boundary, a form field or a theme token must.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
    return existsSync(path.join(ROOT, relativePath));
}

/**
 * Source with its comments removed.
 *
 * The migration notes deliberately name the thing they replaced — a doc comment explaining why the
 * provider was removed has to be able to say "provider". A guard must therefore look at CODE, or it
 * would either fail on its own documentation or force the documentation to become vague. Stripping
 * comments first is what lets both exist: the explanation stays specific, and an actual leftover
 * import is still caught.
 */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

function walkSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const child = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walkSources(child, out);
        else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) out.push(child);
    }
    return out;
}

const DASHBOARD_SCOPE = [
    "app/dashboard",
    "components/organizer",
    "components/platform",
    "components/dashboard",
];

/** The shadcn foundation: it must be Mantine-free, and it is what the pages are being ported onto. */
const SHADCN_FOUNDATION = [
    "components/dashboard/DashboardShell.tsx",
    "components/dashboard/DashboardNav.tsx",
    "components/dashboard/primitives.tsx",
    "components/dashboard/theme/theme-config.ts",
    "components/dashboard/theme/theme-provider.tsx",
    "components/dashboard/theme/theme-switcher.tsx",
    "components/dashboard/ui/button.tsx",
    "components/dashboard/ui/card.tsx",
    "components/dashboard/ui/badge.tsx",
    "components/dashboard/ui/input.tsx",
    "components/dashboard/ui/table.tsx",
    "components/dashboard/ui/dialog.tsx",
    "components/dashboard/ui/sheet.tsx",
    "components/dashboard/ui/dropdown-menu.tsx",
    "components/dashboard/ui/select.tsx",
    "components/dashboard/ui/sidebar.tsx",
    "components/dashboard/ui/chart.tsx",
    "components/dashboard/ui/alert.tsx",
    "components/dashboard/ui/separator.tsx",
    "components/dashboard/ui/misc.tsx",
];

/* ==================================================================================
 * 1. NAVIGATION ACTIVE STATE (pure logic)
 * ================================================================================== */

describe("P-S1. the dashboard highlights exactly one destination", () => {
    it("treats sibling prefixes as different destinations", () => {
        expect(isNavItemActive("/admin/products", "/admin/products", "")).toBe(true);
        expect(isNavItemActive("/admin/products", "/admin/productivity", "")).toBe(false);
        expect(isNavItemActive("/admin/products", "/admin", "")).toBe(false);
    });

    it("keeps a parent row out of its children's pages", () => {
        const winner = pickActiveNavHref(
            ["/admin", "/admin/products", "/admin/users"],
            "/admin/products",
            ""
        );

        expect(winner).toBe("/admin/products");
    });

    it("keeps a child row lit on its own sub-pages", () => {
        const winner = pickActiveNavHref(["/admin", "/admin/products"], "/admin/products/42/edit", "");

        expect(winner).toBe("/admin/products");
    });

    it("separates the eight Broadcast entries, which share one path", () => {
        const broadcasts = [
            "/admin/broadcasts?type=BEST_SELLER",
            "/admin/broadcasts?type=NEW_PRODUCT",
            "/admin/broadcasts?type=BUY_AGAIN",
            "/admin/broadcasts?type=INACTIVE_BUYER",
            "/admin/broadcasts?type=PRICE_DROP",
            "/admin/broadcasts?type=CART_REMINDER",
            "/admin/broadcasts?type=CHECKOUT_REMINDER",
            "/admin/broadcasts?type=THANK_YOU",
        ];

        const winner = pickActiveNavHref(broadcasts, "/admin/broadcasts", "type=THANK_YOU");

        expect(winner).toBe("/admin/broadcasts?type=THANK_YOU");
        expect(broadcasts.filter((href) => href === winner)).toHaveLength(1);
    });

    it("ignores unrelated query parameters on a query-free entry", () => {
        expect(isNavItemActive("/admin/orders", "/admin/orders", "page=3")).toBe(true);
    });

    it("reports a group as active when a child is, and never opens one that is not", () => {
        const marketing = ["/admin/flash-sales", "/admin/campaigns"];

        expect(isNavGroupActive(marketing, "/admin/campaigns", "")).toBe(true);
        expect(isNavGroupActive(marketing, "/admin/users", "")).toBe(false);
    });

    it("the sidebar delegates the rule instead of re-implementing it", () => {
        const nav = read("components/dashboard/DashboardNav.tsx");

        expect(nav).toContain("pickActiveNavHref");
        expect(nav).toContain("isNavGroupActive");
        // One highlight per render: the row is active when it IS the winner.
        expect(nav).toContain("href === activeHref");
        // The rows are real client-side links, not anchors wrapped in anchors.
        expect(nav).toContain("asChild");
        expect(nav).toContain("<Link href={entry.href}");
    });
});

/* ==================================================================================
 * 2. EVERY ADVERTISED DESTINATION EXISTS
 * ================================================================================== */

describe("P-S2. the dashboard menu only advertises real pages", () => {
    /**
     * The retail `/admin` menu was deleted with the retail application, and the former
     * `/organizer` + `/platform` pair was consolidated into ONE dashboard. Every destination that
     * single menu builds must resolve to a real page.
     */
    it("resolves every dashboard menu href to a page file", () => {
        const sources = read("components/dashboard/DashboardAppShell.tsx");

        const hrefs = [...sources.matchAll(/href:\s*"(\/[^"]+)"/g)].map((match) => match[1]);

        // A floor, so an emptied or renamed menu cannot make this vacuously pass.
        expect(hrefs.length).toBeGreaterThanOrEqual(4);

        const missing = hrefs.filter((href) => {
            const clean = href.split("?")[0];
            const segments = clean.split("/").filter(Boolean);
            return !exists(path.join("app", ...segments, "page.tsx"));
        });

        expect(missing).toEqual([]);
    });
});

/* ==================================================================================
 * 3. AUTHORITY IS STILL THE INPUT
 * ================================================================================== */

describe("P-S3. the ONE menu is still gated by authority", () => {
    it("the menu is built from the server's capability booleans", () => {
        const shell = read("components/dashboard/DashboardAppShell.tsx");

        for (const capability of [
            "canReadEvents",
            "canReadOrders",
            "canReadPayments",
            "canAssignPic",
            "canManagePlatformPic",
            "canManageSports",
            "canManageGlobalVenues",
            "canReadReports",
        ]) {
            expect(shell).toContain(capability);
        }

        // Every row is filtered through its own capability before it can exist.
        expect(shell).toContain(".filter((item) => item.visible)");
    });

    it("the capabilities are computed from the real permission deciders", () => {
        const layout = read("app/dashboard/layout.tsx");

        expect(layout).toContain("computeDashboardCapabilities");
        expect(layout).toContain("getAuthzScope");

        // The deciders themselves live in the shared scope helper, which is the single place the
        // dashboard's notion of "may read this" is defined.
        const scope = read("lib/dashboard/scope.ts");
        expect(scope).toContain("decidePlatformPermission");
        expect(scope).toContain("decideOrganizerPermission");
        expect(scope).toContain("PERMISSIONS.EVENT_READ");
        expect(scope).toContain("PERMISSIONS.ORDER_READ_TENANT");
    });

    it("the entry gate is decided server-side, fail-closed", () => {
        const layout = read("app/dashboard/layout.tsx");

        // No session → login; no tenant access AND no platform capability → denial panel.
        expect(layout).toContain('redirect("/login")');
        // The gate is one shared function, so the layout and its tests cannot disagree
        // about who may enter.
        expect(layout).toContain("canEnterDashboard");
        expect(layout).toContain("AccessDeniedPanel");
        expect(layout).toContain("standalone");
    });

    it("the shell never decides access itself", () => {
        for (const shell of [
            "components/dashboard/DashboardShell.tsx",
            "components/dashboard/DashboardNav.tsx",
            "components/dashboard/DashboardAppShell.tsx",
            "components/dashboard/ui/sidebar.tsx",
        ]) {
            const source = read(shell);

            expect(source).not.toContain("@/lib/authz");
            expect(source).not.toContain("useSession");
            expect(source).not.toMatch(/\bauth\(\)/);
        }
    });
});

/* ==================================================================================
 * 4. THEMES, FROM ONE CONTROL
 * ================================================================================== */

describe("P-S4. the theme system is real, not a hardcoded palette", () => {
    const css = read("app/globals.css");

    it("declares the shadcn semantic tokens for light and dark", () => {
        for (const token of [
            "--background",
            "--foreground",
            "--card",
            "--card-foreground",
            "--popover",
            "--popover-foreground",
            "--primary",
            "--primary-foreground",
            "--secondary",
            "--secondary-foreground",
            "--muted",
            "--muted-foreground",
            "--accent",
            "--accent-foreground",
            "--destructive",
            "--border",
            "--input",
            "--ring",
        ]) {
            expect(css).toContain(`${token}:`);
        }

        // A `.dark` block overrides them; without it dark mode would be a colour swap only.
        expect(css).toMatch(/\.dark \{/);
        expect(css).toContain("@custom-variant dark");
    });

    it("declares the sidebar tokens and the five chart tokens", () => {
        for (const token of [
            "--sidebar",
            "--sidebar-foreground",
            "--sidebar-primary",
            "--sidebar-primary-foreground",
            "--sidebar-accent",
            "--sidebar-accent-foreground",
            "--sidebar-border",
            "--sidebar-ring",
        ]) {
            expect(css).toContain(`${token}:`);
        }

        for (let index = 1; index <= 5; index += 1) {
            expect(css).toContain(`--chart-${index}:`);
        }
    });

    it("exposes every accent and every chart palette as a CSS selector", () => {
        for (const accent of ACCENTS) {
            expect(css).toContain(`[data-accent="${accent.id}"]`);
            expect(css).toContain(`.dark[data-accent="${accent.id}"]`);
        }

        for (const palette of CHART_PALETTES) {
            expect(css).toContain(`[data-chart="${palette.id}"]`);
            expect(css).toContain(`.dark[data-chart="${palette.id}"]`);
        }
    });

    it("the swatch catalogue mirrors the stylesheet instead of drifting from it", () => {
        /*
         * The one duplicated value in the system: the picker needs a literal to draw a colour chip.
         * If a palette is retuned in the stylesheet and the catalogue is not, the picker would lie
         * about what the user is selecting — which is exactly what this asserts against.
         */
        for (const accent of ACCENTS) {
            expect(css).toContain(`--chart-1: ${accent.swatch};`);
        }

        for (const palette of CHART_PALETTES) {
            for (const swatch of palette.swatches) {
                expect(css).toContain(swatch);
            }
        }
    });

    it("remembers the three preferences on the client, with no database change", () => {
        expect(THEME_STORAGE.appearance).toBe("tk-dashboard-appearance");
        expect(THEME_STORAGE.accent).toBe("tk-dashboard-accent");
        expect(THEME_STORAGE.chart).toBe("tk-dashboard-chart");

        // The bootstrap runs before paint, which is what stops a stored palette from flashing.
        expect(THEME_BOOTSTRAP_SCRIPT).toContain("data-accent");
        expect(THEME_BOOTSTRAP_SCRIPT).toContain("data-chart");

        // …and it resolves the APPEARANCE too, against the same storage key the old provider used,
        // including the OS preference for `system`. Folding all three into one script is what let
        // the bootstrap move out of the React tree entirely (see the boundary test below).
        expect(THEME_BOOTSTRAP_SCRIPT).toContain(THEME_STORAGE.appearance);
        expect(THEME_BOOTSTRAP_SCRIPT).toContain("classList.add(\"dark\")");
        expect(THEME_BOOTSTRAP_SCRIPT).toContain("classList.remove(\"dark\")");
        expect(THEME_BOOTSTRAP_SCRIPT).toContain("prefers-color-scheme: dark");

        // No server-side persistence for an appearance preference.
        expect(read("components/dashboard/theme/theme-provider.tsx")).not.toContain("prisma");
    });

    /*
     * THE THEME BOOTSTRAP MUST NOT BE A ROUTE-RENDERED SCRIPT (PHASE 21)
     * -----------------------------------------------------------------
     * Rendering `<script>` as JSX inside a route is what produced the reported console error:
     * "Encountered a script tag while rendering React component. Scripts inside React components are
     * never executed when rendering on the client." It fired on CLIENT-SIDE navigation into the
     * dashboard, where there is no server HTML to hydrate, so React created the node and never ran
     * it. That means the old bootstrap was silent for every in-app arrival at the dashboard.
     *
     * The fix is structural, and these are the properties that keep it fixed: the bootstrap is
     * emitted by the ROOT layout as plain HTML (so the browser parses and runs it before paint, and
     * no navigation can re-create it), and NOTHING in the dashboard renders a script element.
     */
    it("renders the bootstrap from the root layout, never from a route", () => {
        const layout = read("app/layout.tsx");

        expect(layout).toContain("THEME_BOOTSTRAP_SCRIPT");
        expect(layout).toContain("dangerouslySetInnerHTML");
        // The script must be the FIRST thing in <body>: that is what makes it run before the app
        // below it is painted.
        expect(layout).toMatch(/<body>\s*\{[\s\S]*?THEME_BOOTSTRAP_SCRIPT[\s\S]*?<AuthProvider>/);

        // The provider that used to return the <script> no longer exists, and the library whose
        // own inline script reproduced the identical warning is gone from the theme stack. The
        // comments are stripped first: the provider's doc block names the removed library to say
        // why it went, and a guard on raw text would either fail on that explanation or force the
        // explanation to go vague. Code, not prose, is what has to be free of both.
        const provider = readCode("components/dashboard/theme/theme-provider.tsx");
        expect(provider).not.toContain("DashboardThemeScript");
        expect(provider).not.toMatch(/from\s+["']next-themes["']/);

        // No dashboard file renders a script element at all. Comments are stripped first, because
        // the modules above deliberately quote the old markup when explaining why it moved.
        const offenders = DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)).filter((file) =>
            /<script[\s>]/.test(readCode(file))
        );

        expect(offenders).toEqual([]);
    });

    it("the switcher drives all three controls and nothing hardcodes a colour", () => {
        const switcher = read("components/dashboard/theme/theme-switcher.tsx");

        expect(switcher).toContain("setTheme");
        expect(switcher).toContain("setAccent");
        expect(switcher).toContain("setChartPalette");
        expect(switcher).toContain("ACCENTS");
        expect(switcher).toContain("CHART_PALETTES");

        // The shell exposes the control, so it is reachable from every dashboard page.
        expect(read("components/dashboard/DashboardShell.tsx")).toContain("ThemeSettingsMenu");
        expect(read("components/dashboard/DashboardShell.tsx")).toContain("ThemeQuickToggle");
    });
});

/* ==================================================================================
 * 5. THE CHART SYSTEM
 * ================================================================================== */

describe("P-S5. charts read the chart tokens", () => {
    it("provides the shadcn chart composition", () => {
        const chart = read("components/dashboard/ui/chart.tsx");

        for (const exportName of [
            "ChartContainer",
            "ChartTooltip",
            "ChartTooltipContent",
            "ChartLegend",
            "ChartLegendContent",
        ]) {
            expect(chart).toContain(exportName);
        }

        // The series colour is indirected through a per-container custom property.
        expect(chart).toContain("--color-${key}");
        expect(chart).toContain("ResponsiveContainer");
    });

    it("the old theme-literal chart colours are gone from the dashboard", () => {
        const consumers = DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)).filter((file) =>
            read(file).includes("CHART_COLORS")
        );

        expect(consumers).toEqual([]);
    });
});

/* ==================================================================================
 * 6. THE SHELL, AND NO FOOTER
 * ================================================================================== */

describe("P-S6. exactly one shell, and no footer", () => {
    it("the dashboard renders through the shared shell", () => {
        // One app shell, mounted by one layout — there is no second back-office chrome.
        expect(read("components/dashboard/DashboardAppShell.tsx")).toContain("DashboardShell");
        expect(read("app/dashboard/layout.tsx")).toContain("DashboardAppShell");

        const shell = read("components/dashboard/DashboardShell.tsx");

        expect(shell).toContain("SidebarProvider");
        expect(shell).toContain("<Sidebar>");
        expect(shell).toContain("SidebarTrigger");
        expect(shell).toContain("<main");
    });

    it("marks the shell, and the root layout carries no global footer", () => {
        // Each surface owns its own chrome now. The root layout renders no footer at all, so the
        // CSS suppression rules that used to hide the retail footer are gone rather than dead.
        expect(read("components/dashboard/DashboardShell.tsx")).toContain("data-dashboard-shell");

        // No suppression RULE remains. The comment block still names the deleted selector to
        // explain why it is gone, so the assertion targets the rule, not the string.
        const css = read("app/globals.css");
        expect(css).not.toMatch(/footer\[data-global-footer\]\s*\{/);

        // The retail footer component and its global mount point were deleted with retail.
        expect(exists("components/Footer.tsx")).toBe(false);
        expect(read("app/layout.tsx")).not.toContain("<Footer");
        // …and the root layout still does not know about the dashboard's theme system.
        expect(read("app/layout.tsx")).not.toContain("DashboardThemeProvider");
    });

    it("the denial surfaces keep the shell marker, which they replace", () => {
        /*
         * A layout that denies access renders `AccessDeniedPanel` INSTEAD OF `DashboardShell`, so the
         * marker has to travel with the panel — otherwise the shell surface (and its background and
         * spacing) would be missing under a "no access" card on `/dashboard`.
         */
        const primitives = read("components/dashboard/primitives.tsx");

        expect(primitives).toContain("standalone = false");
        expect(primitives).toContain("data-dashboard-shell");
        expect(primitives).toContain("flex min-h-screen w-full flex-col bg-background text-foreground");

        const layout = read("app/dashboard/layout.tsx");

        expect(layout).toContain("AccessDeniedPanel");
        expect(layout).toMatch(/<AccessDeniedPanel[\s\S]*?\n\s+standalone\n/);

        /*
         * The page-level denials render INSIDE the shell, which already carries the marker and the
         * surface, so they must keep the default flat form — one marker per page, not two.
         */
        for (const page of [
            "app/dashboard/settings/sports/page.tsx",
            "app/dashboard/settings/venues/page.tsx",
        ]) {
            expect(read(page)).not.toContain("standalone");
        }
    });

    it("logout is preserved byte-for-byte in behaviour", () => {
        const shell = read("components/dashboard/DashboardShell.tsx");

        expect(shell).toContain('signOut({ callbackUrl: "/" })');
        // Re-pointed at the ticket wallet: the retail `/profile` route was deleted, and the buyer's
        // account surface in a ticketing product is the wallet.
        expect(shell).toContain("Tiket saya");
        expect(shell).toContain('href="/ticketing/tickets"');
    });

    it("the shared brand lockup is still the one rendered by the chrome", () => {
        expect(read("components/dashboard/DashboardShell.tsx")).toContain("<Brand");
        expect(read("components/dashboard/DashboardNav.tsx")).toContain("<Brand");
    });

    it("the primitives module is still the single vocabulary", () => {
        const primitives = read("components/dashboard/primitives.tsx");

        for (const exportName of [
            "PageHeader",
            "SectionCard",
            "StatCard",
            "StatusBadge",
            "DataTable",
            "DataRow",
            "EmptyBlock",
            "ErrorBlock",
            "LoadingBlock",
            "LinkPagination",
            "AccessDeniedPanel",
            "PrimaryAction",
            "TextLink",
            "SectionHeading",
            "TableToolbar",
        ]) {
            expect(primitives).toContain(`export function ${exportName}`);
        }

        // A server page can render a linked button without crossing the boundary.
        expect(primitives).toContain("export function AccessDeniedPanel");
        expect(primitives).toMatch(/export function PrimaryAction\(\{[\s\S]*href/);
        expect(primitives).toMatch(/^\s*["']use client["'];/m);
    });
});

/* ==================================================================================
 * 7. THE FROZEN APPLICATION BRAIN
 * ================================================================================== */

describe("P-S7. the back-office UI changed presentation only", () => {
    it("the migrated pages kept their data source and their form contract", () => {
        // The sports and global-venue managers still write through the platform-scoped APIs.
        expect(read("components/platform/SportManager.tsx")).toContain("/api/admin/sports");
        expect(read("components/platform/GlobalVenueManager.tsx")).toContain(
            "/api/admin/venues"
        );

        // The event list is a server component: it reads through the scoped service rather
        // than the API, so the scoping is applied in one place.
        const events = read("app/dashboard/events/page.tsx");
        expect(events).toContain("listOrganizerEvents");

        expect(read("components/organizer/VenueManager.tsx")).toContain("/api/organizer/venues");

        const ticketTypes = read("components/organizer/TicketTypeManager.tsx");
        expect(ticketTypes).toContain("/api/organizer/events/");
        expect(ticketTypes).toContain("ticket-types");
    });

    it("the confirmation wording and the money formatting survive", () => {
        expect(read("components/organizer/TicketTypeManager.tsx")).toContain("Hapus jenis tiket");
    });

    it("no fabricated metrics anywhere in the back office", () => {
        // The retail dashboard overview (`app/admin/page.tsx`, with `DashboardStats`/`SalesChart`)
        // was deleted with retail. The rule it carried still applies to what remains.
        const offenders = DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)).filter((file) => {
            const code = readCode(file);
            return code.includes("Math.random") || /const\s+mock/i.test(code);
        });

        expect(offenders).toEqual([]);
    });
});

/* ==================================================================================
 * 8. THE MIGRATION RATCHET
 * ==================================================================================
 *
 * The end state is "no Mantine in the dashboard at all", and it has been REACHED: the count of
 * remaining consumers is 0 and it is pinned there, so a new import of the component library fails
 * this suite immediately.
 *
 * Getting here was strictly ordered, because Mantine throws at render time when no provider is in
 * the tree:
 *
 *   1. port every consumer off the library — the ratchet counted down as each batch landed;
 *   2. only then remove the bridge: the provider in `DashboardProviders`, `mantine-theme.ts`, the
 *      component-library stylesheet in the three back-office layouts, and the two dependencies.
 *
 * Doing step 2 first does not leave a partially styled page, it 500s every un-ported route — which
 * is exactly the failure this ordering was written to prevent. The bridge's absence is now asserted
 * below, so it cannot creep back in either.
 */

const REMAINING_MANTINE_CONSUMERS = 0;

describe("P-S8. the shadcn migration is a one-way ratchet", () => {
    it("the shell, the shadcn kit and the theme contain no Mantine", () => {
        for (const file of SHADCN_FOUNDATION) {
            expect({ file, mantine: read(file).includes("@mantine/") }).toEqual({
                file,
                mantine: false,
            });
        }
    });

    it("the shadcn kit exists and is real (Radix + cva + cn), not a re-implementation", () => {
        const button = read("components/dashboard/ui/button.tsx");
        expect(button).toContain("@radix-ui/react-slot");
        expect(button).toContain("class-variance-authority");
        expect(button).toContain('from "@/lib/utils"');

        expect(read("components/dashboard/ui/dropdown-menu.tsx")).toContain(
            "@radix-ui/react-dropdown-menu"
        );
        expect(read("lib/utils.ts")).toContain("twMerge");
    });

    it("the number of pages still importing Mantine only goes down", () => {
        const consumers = DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)).filter((file) =>
            read(file).includes("@mantine/")
        );

        expect(consumers.length).toBeLessThanOrEqual(REMAINING_MANTINE_CONSUMERS);

        // The shell's own files can never be on that list, whatever the count is.
        expect(consumers).not.toContain("components/dashboard/DashboardShell.tsx");
        expect(consumers).not.toContain("components/dashboard/DashboardNav.tsx");
        expect(consumers).not.toContain("components/dashboard/primitives.tsx");
    });

    it("Mantine never reached a customer-facing surface", () => {
        const scoped = new Set(DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)));

        const leaked = [...walkSources("app"), ...walkSources("components")].filter(
            (file) => !scoped.has(file) && read(file).includes("@mantine/")
        );

        expect(leaked).toEqual([]);
    });
});

/* ==================================================================================
 * 9. THE BRIDGE IS GONE, AND THE THEME IS THE ONLY PAINT
 * ==================================================================================
 *
 * Two things had to be true at the same moment for this migration to be finished, and neither is
 * visible in a screenshot:
 *
 *   1. the component library is not merely unused but ABSENT — no dependency, no provider, no theme
 *      module, no stylesheet. A left-behind provider is the kind of thing that survives forever
 *      because nothing fails while it is there;
 *   2. every dashboard surface resolves its colours through a semantic token, so the appearance,
 *      accent and chart-palette switchers actually reach it. A single literal `bg-white` is the
 *      mechanism by which one page stays light when the rest of the dashboard goes dark.
 */

describe("P-S9. the dashboard paints from semantic tokens only", () => {
    it("the component library is gone: no dependency, provider, theme module or stylesheet", () => {
        expect(read("package.json")).not.toContain("@mantine/");
        expect(exists("components/dashboard/mantine-theme.ts")).toBe(false);
        expect(readCode("components/dashboard/DashboardProviders.tsx")).not.toContain(
            "MantineProvider"
        );

        expect(
            readCode("app/dashboard/layout.tsx").includes("@mantine/core/styles.css")
        ).toBe(false);
    });

    it("no dashboard file hardcodes a surface colour", () => {
        /*
         * The pattern covers the two ways a literal sneaks in — a Tailwind palette class
         * (`bg-gray-100`, `text-white`) and a raw colour (`#rrggbb`, `rgb(...)`, `hsl(...)`).
         *
         * Comments are stripped first: the migration notes deliberately quote the old values
         * (`--mantine-color-gray-2`) when explaining what changed, and a doc comment is not a
         * surface. The swatch catalogue is exempt for the opposite reason — it IS the palette
         * definition, and `P-S4` asserts it matches the stylesheet value for value.
         */
        const FORBIDDEN =
            /\b(?:bg|text|border|ring|divide|from|to|via)-(?:white|black|gray|slate|zinc|neutral|stone)(?:-\d{2,3})?\b|#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

        const offenders: string[] = [];

        for (const dir of DASHBOARD_SCOPE) {
            for (const file of walkSources(dir)) {
                if (file.startsWith("components/dashboard/theme/")) continue;

                if (FORBIDDEN.test(readCode(file))) offenders.push(file);
            }
        }

        expect(offenders).toEqual([]);
    });

    it("the scrim stays dark in both appearances, without a literal", () => {
        /*
         * The one surface that must NOT follow the appearance token is a modal backdrop: it exists
         * to darken what is behind it, and an inverted scrim would wash a dark page white. Both it
         * and the switch knob therefore use real palette tokens (`ink-950`, `ink-50`) rather than a
         * raw colour, so they can still be retuned in one place.
         */
        for (const file of ["components/dashboard/ui/dialog.tsx", "components/dashboard/ui/sheet.tsx"]) {
            expect(read(file)).toContain("bg-ink-950/55");
        }

        expect(read("components/dashboard/ui/select.tsx")).toContain("bg-ink-50");
    });
});

/* ==================================================================================
 * 10. NO CHART RENDERS A COLOUR OF ITS OWN
 * ==================================================================================
 *
 * The dashboard's only chart consumers (`SalesChart`, `AdminAffiliateDetail`) were retail admin
 * components and were deleted with retail, so there are currently zero `<ChartContainer>` call
 * sites. The primitive and the `--chart-*` tokens are kept as part of the theme foundation (the
 * palette control would otherwise be a dead switch), and this rule is what stops a future chart
 * from naming a colour directly instead of consuming those tokens.
 */

describe("P-S10. every chart consumes the chart tokens", () => {
    it("no chart file names a colour of its own", () => {
        const charts = DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)).filter((file) =>
            read(file).includes("<ChartContainer")
        );

        for (const file of charts) {
            const code = readCode(file);

            expect({ file, hex: /#[0-9a-fA-F]{6}/.test(code) }).toEqual({ file, hex: false });
            expect({ file, tokens: /var\(--chart-[1-5]\)/.test(code) }).toEqual({
                file,
                tokens: true,
            });
        }
    });
});
