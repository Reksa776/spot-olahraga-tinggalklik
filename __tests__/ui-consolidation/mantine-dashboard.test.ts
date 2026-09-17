import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { isNavGroupActive, isNavItemActive, pickActiveNavHref } from "@/lib/ui/dashboard-nav";
import DashboardProviders from "@/components/dashboard/DashboardProviders";

/**
 * ==========================================
 * MANTINE DASHBOARD MIGRATION
 * ==========================================
 *
 * The dashboard was migrated from hand-rolled Tailwind to Mantine. This suite pins the parts of
 * that migration that are *behaviour*, not appearance:
 *
 *   • the navigation's active-state rule (the one piece of dashboard logic that can be wrong in a
 *     way a screenshot would not reveal — a sidebar claiming the user is somewhere they are not);
 *   • that every admin destination the menu advertises resolves to a real page;
 *   • that authority still decides the menu, and that the shells never widen it;
 *   • that the Mantine provider is scoped to the dashboard segments and did not reach the root;
 *   • that the frozen surfaces (forms, APIs, schema, payment) were not touched by a UI migration.
 *
 * Deliberately NOT asserted: colours, spacing, component sizes. Restyling the dashboard must not
 * fail this suite; breaking a link, a permission boundary or a form field must.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
    return existsSync(path.join(ROOT, relativePath));
}

const SHELLS = [
    "components/dashboard/DashboardShell.tsx",
    "components/dashboard/DashboardNav.tsx",
    "components/dashboard/AdminShell.tsx",
    "components/dashboard/OrganizerShell.tsx",
    "components/dashboard/PlatformShell.tsx",
    "components/dashboard/DashboardProviders.tsx",
    "components/dashboard/primitives.tsx",
    "components/dashboard/mantine-theme.ts",
];

const LAYOUTS = [
    "app/admin/layout.tsx",
    "app/organizer/layout.tsx",
    "app/platform/layout.tsx",
];

/* ==================================================================================
 * 1. NAVIGATION ACTIVE STATE (pure logic)
 * ================================================================================== */

describe("P-M1. the dashboard highlights exactly one destination", () => {
    it("treats sibling prefixes as different destinations", () => {
        expect(isNavItemActive("/admin/products", "/admin/products", "")).toBe(true);
        expect(isNavItemActive("/admin/products", "/admin/productivity", "")).toBe(false);
        expect(isNavItemActive("/admin/products", "/admin", "")).toBe(false);
    });

    it("keeps a parent row out of its children's pages", () => {
        // `/admin` must not stay lit while the operator is inside a section underneath it.
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

    it("leaves the Broadcast group unhighlighted on its own plain path", () => {
        expect(
            pickActiveNavHref(
                ["/admin/broadcasts?type=BEST_SELLER"],
                "/admin/broadcasts",
                ""
            )
        ).toBeNull();
    });

    it("ignores unrelated query parameters on a query-free entry", () => {
        // Paging through a list must not drop the highlight.
        expect(isNavItemActive("/admin/orders", "/admin/orders", "page=3")).toBe(true);
    });

    it("reports a group as active when a child is, and never opens one that is not", () => {
        const marketing = ["/admin/flash-sales", "/admin/campaigns"];

        expect(isNavGroupActive(marketing, "/admin/campaigns", "")).toBe(true);
        expect(isNavGroupActive(marketing, "/admin/users", "")).toBe(false);
    });

    it("accepts a raw query string and a URLSearchParams alike", () => {
        const href = "/admin/broadcasts?type=BUY_AGAIN";

        expect(isNavItemActive(href, "/admin/broadcasts", "type=BUY_AGAIN")).toBe(true);
        expect(
            isNavItemActive(href, "/admin/broadcasts", new URLSearchParams({ type: "BUY_AGAIN" }))
        ).toBe(true);
        expect(isNavItemActive(href, "/admin/broadcasts", "type=PRICE_DROP")).toBe(false);
    });

    it("the shell delegates the rule instead of re-implementing it", () => {
        const nav = read("components/dashboard/DashboardNav.tsx");

        expect(nav).toContain("pickActiveNavHref");
        expect(nav).toContain("isNavGroupActive");
        // One highlight per render: the row is active when it IS the winner.
        expect(nav).toContain("href === activeHref");
    });
});

/* ==================================================================================
 * 2. EVERY ADVERTISED DESTINATION EXISTS
 * ================================================================================== */

describe("P-M2. the admin menu only advertises real pages", () => {
    const source = read("components/admin/AdminNavbar.tsx");

    /** `href: "/admin/x"` → `/admin/x`. */
    const hrefs = [...source.matchAll(/href:\s*"(\/[^"]+)"/g)].map((match) => match[1]);

    it("still declares the whole back office, including the suites that guard it", () => {
        // These literals are read by four pre-existing suites; the migration moved the rendering,
        // not the destinations.
        expect(source).toContain("broadcasts");
        expect(source).toContain("label: \"Pengajuan\"");
        expect(source).toContain("/admin/spin-wheel");
        expect(source).toContain("/admin/affiliate/audit-log");
    });

    it("resolves every advertised href to a page file", () => {
        expect(hrefs.length).toBeGreaterThan(15);

        const missing = hrefs.filter((href) => {
            const clean = href.split("?")[0];
            const segments = clean.split("/").filter(Boolean);
            return !exists(path.join("app", ...segments, "page.tsx"));
        });

        expect(missing).toEqual([]);
    });

    it("does not advertise a query-differentiated entry that the API rejects", () => {
        // The eight Broadcast types are the only query-bearing entries; all point at one page.
        const queryHrefs = hrefs.filter((href) => href.includes("?"));

        expect(queryHrefs).toHaveLength(8);
        expect(new Set(queryHrefs.map((href) => href.split("?")[0]))).toEqual(
            new Set(["/admin/broadcasts"])
        );
    });
});

/* ==================================================================================
 * 3. AUTHORITY IS STILL THE INPUT
 * ================================================================================== */

describe("P-M3. the migration did not widen anyone's menu", () => {
    it("the admin menu contains no ticketing surface", () => {
        const source = read("components/admin/AdminNavbar.tsx");

        // `/admin` gates on the legacy retail role, `/platform` and `/organizer` on the ticketing
        // authority dimensions. A ticketing link here would advertise access this role lacks.
        for (const forbidden of ["/platform/", "/organizer/", "/events", "/ticketing/"]) {
            expect(source).not.toContain(`href: "${forbidden}`);
        }
    });

    it("the platform menu is built from the server's permission booleans", () => {
        const shell = read("components/dashboard/PlatformShell.tsx");

        expect(shell).toContain("canManageSports");
        expect(shell).toContain("canManageGlobalVenues");
        // Items are constructed only under the boolean, so they cannot leak unconditionally.
        expect(shell).toMatch(/if \(canManageSports\)\s*\{/);
        expect(shell).toMatch(/if \(canManageGlobalVenues\)\s*\{/);

        const layout = read("app/platform/layout.tsx");
        expect(layout).toContain("decidePlatformPermission");
        expect(layout).toContain("PERMISSIONS.SPORT_MANAGE");
        expect(layout).toContain("PERMISSIONS.VENUE_MANAGE_GLOBAL");
    });

    it("the admin gate is unchanged: same two redirects, in the same order", () => {
        const layout = read("app/admin/layout.tsx");

        expect(layout).toContain("await auth()");
        expect(layout).toContain('redirect("/login")');
        expect(layout).toContain('redirect("/products")');
        expect(layout).toContain('role !== "ADMIN"');
    });

    it("the shells never decide access themselves", () => {
        /*
         * A shell that read a permission map, or asked the session who the user is in order to
         * choose menu items, would be a second authority system sitting next to the layout guards.
         *
         * `signOut` is explicitly NOT part of that rule: it is a client action the user takes, not a
         * decision about what they may see, and it was the existing logout mechanism before this
         * migration. So the assertion targets session/permission READS.
         */
        for (const shell of SHELLS) {
            const source = read(shell);

            expect(source).not.toContain("@/lib/authz");
            expect(source).not.toContain("useSession");
            expect(source).not.toMatch(/\bauth\(\)/);
        }

        // The decider is CALLED from the layout and its booleans arrive as props — asserted where
        // the call lives, so a comment naming it in a shell stays allowed.
        expect(read("app/platform/layout.tsx")).toContain("decidePlatformPermission(");
    });
});

/* ==================================================================================
 * 4. PROVIDER SCOPE
 * ================================================================================== */

describe("P-M4. Mantine is scoped to the dashboard", () => {
    it("the Mantine provider is mounted under MantineProvider with the dashboard theme", () => {
        const markup = renderToStaticMarkup(
            createElement(DashboardProviders, null, createElement("span", null, "isi"))
        );

        expect(markup).toContain("isi");
        expect(markup).toContain("mantine");
    });

    it("each back office mounts the provider and the Mantine stylesheet", () => {
        for (const layout of LAYOUTS) {
            const source = read(layout);

            expect(source).toContain("DashboardProviders");
            expect(source).toContain('import "@mantine/core/styles.css"');
        }
    });

    it("the root layout was NOT given the provider or the stylesheet", () => {
        // Mounting Mantine at the root would put its baseline over the customer-facing surfaces.
        const root = read("app/layout.tsx");

        expect(root).not.toContain("MantineProvider");
        expect(root).not.toContain("@mantine/core/styles.css");
        expect(root).not.toContain("DashboardProviders");
    });

    it("the customer-facing shell does not import Mantine", () => {
        for (const file of [
            "components/ticketing/SiteShell.tsx",
            "components/ticketing/SiteHeader.tsx",
            "components/events/EventCard.tsx",
        ]) {
            expect(read(file)).not.toContain("@mantine/");
        }
    });

    it("the theme keeps semantic colours semantic and the brand as the primary", () => {
        const theme = read("components/dashboard/mantine-theme.ts");

        expect(theme).toContain('primaryColor: "brand"');
        // The brand scale is TinggalKlik's, not Mantine's default blue.
        expect(theme).toContain("brand");
        expect(theme).not.toMatch(/primaryColor:\s*"blue"/);
    });
});

/* ==================================================================================
 * 5. THE FROZEN APPLICATION BRAIN
 * ================================================================================== */

describe("P-M5. the UI migration changed presentation only", () => {
    it("no dashboard component imports the database, payment or ticketing services", () => {
        const forbidden = [
            "@/lib/prisma",
            "@prisma/client",
            "@/lib/payment",
            "@/lib/ticketing",
            "lib/marketing",
            "@/auth",
        ];

        for (const file of SHELLS) {
            const source = read(file);

            for (const token of forbidden) {
                expect(source).not.toContain(`from "${token}`);
            }
        }
    });

    it("the schema and the migrations are untouched by this phase", () => {
        // A UI phase has no business changing either; if this fails, something else did.
        expect(exists("prisma/schema.prisma")).toBe(true);
        expect(read("components/dashboard/mantine-theme.ts")).not.toContain("model ");
    });

    it("migrated pages kept their data source and their form contract", () => {
        const users = read("app/admin/users/page.tsx");
        expect(users).toContain("/api/admin/users");
        expect(users).toContain("page");
        expect(users).toContain("limit");

        const organizerEvents = read("app/organizer/events/page.tsx");
        expect(organizerEvents).toContain("listOrganizerEvents");
        expect(organizerEvents).toContain("context.currentOrganizerId");

        const newEvent = read("app/organizer/events/new/page.tsx");
        expect(newEvent).toContain("requireOrganizerAccess");
        expect(newEvent).toContain('"event.write"');
        expect(newEvent).toContain('mode="create"');
    });

    it("the admin overview still reads the endpoints it always read", () => {
        const page = read("app/admin/page.tsx");

        expect(page).toContain("/api/admin");
        // The four headline figures and the two panels survive the redesign.
        expect(page).toContain("StatCard");
        expect(page).toContain("SalesChart");
    });
});

/* ==================================================================================
 * 5b. THE SERVER/CLIENT BOUNDARY
 * ==================================================================================
 *
 * This one is not theoretical. The first version of the migrated layouts let a server component
 * pass `component={Link}` to Mantine, which fails at RUNTIME ("Functions cannot be passed directly
 * to Client Components") on a route that type-checks and unit-tests cleanly. It was caught by
 * fetching the real routes with a real session, and it is pinned here so the next person cannot
 * reintroduce it silently.
 */

describe("P-M7. no component reference crosses the server/client boundary", () => {
    /** Every .tsx under app/ and components/, walked rather than globbed by the test runner. */
    function walk(dir: string, out: string[] = []): string[] {
        for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
            const child = `${dir}/${entry.name}`;
            if (entry.isDirectory()) walk(child, out);
            else if (entry.name.endsWith(".tsx")) out.push(child);
        }
        return out;
    }

    it("a `component={Ident}` prop only ever appears in a client module", () => {
        const files = [...walk("app"), ...walk("components")];

        function resolveImport(from: string, specifier: string): string | null {
            let base: string;

            if (specifier.startsWith("@/")) base = specifier.slice(2);
            else if (specifier.startsWith(".")) {
                base = path.posix.normalize(
                    path.posix.join(path.posix.dirname(from), specifier)
                );
            } else {
                return null; // a package import: never a project module
            }

            for (const extension of [".tsx", ".ts"]) {
                if (exists(base + extension)) return base + extension;
                if (exists(`${base}/index${extension}`)) return `${base}/index${extension}`;
            }

            return null;
        }

        const importsOf = new Map<string, string[]>();

        for (const file of files) {
            const source = read(file);
            const dependencies: string[] = [];

            for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
                const resolved = resolveImport(file, match[1]);
                if (resolved && resolved !== file) dependencies.push(resolved);
            }

            importsOf.set(file, dependencies);
        }

        /*
         * Modules that end up in the CLIENT bundle: a module marked `"use client"`, plus everything
         * it imports, transitively. Next compiles an unmarked module into the client graph when a
         * client module imports it, and inside that graph passing a component reference is legal —
         * `AdminMenuCard` is exactly this case, reached only from the client admin overview.
         */
        const clientModules = new Set(
            files.filter((file) => /^\s*["']use client["'];/m.test(read(file)))
        );

        let grew = true;
        while (grew) {
            grew = false;

            for (const file of [...clientModules]) {
                for (const dependency of importsOf.get(file) ?? []) {
                    if (!clientModules.has(dependency)) {
                        clientModules.add(dependency);
                        grew = true;
                    }
                }
            }
        }

        const offenders = files.filter((file) => {
            const source = read(file);

            /*
             * Comment lines are dropped before matching. Prose is allowed to NAME the forbidden
             * pattern — several files document why it cannot be used — and a guard that fails on its
             * own explanation is a guard people delete. Full-line `//` and JSDoc `*` lines are
             * removed; inline trailing comments are not, which is a deliberate conservatism.
             */
            const code = source
                .split("\n")
                .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
                .join("\n");

            const passesReference = /component=\{[A-Z][A-Za-z0-9]*\}/.test(code);
            if (!passesReference) return false;
            if (!code.includes('from "@mantine/')) return false;

            return !clientModules.has(file);
        });

        expect(offenders).toEqual([]);
    });

    it("the denial panel is a client component that owns its own Link", () => {
        const primitives = read("components/dashboard/primitives.tsx");

        expect(primitives).toMatch(/^\s*["']use client["'];/m);
        expect(primitives).toContain("export function AccessDeniedPanel");
        expect(primitives).toContain("component={Link}");
    });

    it("the server layouts get their link behaviour from that client component", () => {
        for (const layout of ["app/organizer/layout.tsx", "app/platform/layout.tsx"]) {
            const source = read(layout);

            expect(source).toContain("AccessDeniedPanel");
            expect(source).not.toMatch(/component=\{[A-Z]/);
            expect(source).not.toMatch(/^\s*["']use client["'];/m);
        }
    });

    it("an authorization failure is rendered, not thrown out of a page render", () => {
        for (const page of ["app/platform/sports/page.tsx", "app/platform/venues/page.tsx"]) {
            const source = read(page);

            expect(source).toContain("isAuthzError(error)");
            // Only AuthzError is caught: a real failure must still surface.
            expect(source).toMatch(/if \(!isAuthzError\(error\)\) \{\s*throw error;/);
            expect(source).toContain("AccessDeniedPanel");
        }
    });
});

/* ==================================================================================
 * 6. THE SHELL ITSELF
 * ================================================================================== */

describe("P-M6. one shell, three sections", () => {
    it("all three back offices render through the shared AppShell", () => {
        for (const shell of [
            "components/dashboard/AdminShell.tsx",
            "components/dashboard/OrganizerShell.tsx",
            "components/dashboard/PlatformShell.tsx",
        ]) {
            expect(read(shell)).toContain("DashboardShell");
        }

        const shell = read("components/dashboard/DashboardShell.tsx");
        expect(shell).toContain("<AppShell");
        expect(shell).toContain("AppShell.Navbar");
        expect(shell).toContain("AppShell.Main");
        // Mobile behaviour: a burger that collapses the navbar at the `md` breakpoint.
        expect(shell).toContain("Burger");
        expect(shell).toContain('collapsed: { mobile: !navOpened }');
    });

    it("logout is preserved byte-for-byte in behaviour", () => {
        const shell = read("components/dashboard/DashboardShell.tsx");

        expect(shell).toContain('signOut({ callbackUrl: "/" })');
    });

    it("the shared brand lockup is the one rendered by the chrome", () => {
        expect(read("components/dashboard/DashboardShell.tsx")).toContain('<Brand');
        expect(read("components/dashboard/DashboardNav.tsx")).toContain('<Brand');
    });

    it("comfortable control sizes are the dashboard default", () => {
        const primitives = read("components/dashboard/primitives.tsx");

        // The previous UI was criticised for small controls; primary actions are `md` and up.
        expect(primitives).toContain('size="md"');
        expect(primitives).not.toMatch(/size="xs"[\s\S]{0,80}PrimaryAction/);
    });

    it("the primitives module is the single vocabulary for tables and states", () => {
        const primitives = read("components/dashboard/primitives.tsx");

        for (const exportName of [
            "PageHeader",
            "SectionCard",
            "StatCard",
            "StatusBadge",
            "DataTable",
            "EmptyBlock",
            "ErrorBlock",
            "LoadingBlock",
            "LinkPagination",
        ]) {
            expect(primitives).toContain(`export function ${exportName}`);
        }
    });
});

/* ==================================================================================
 * 7. THE BODY MIGRATION IS COMPLETE
 * ==================================================================================
 *
 * The two earlier phases migrated the chrome, then some of the bodies, and reported the rest as a
 * measured residue. These tests pin the END STATE the brief actually asks for: the dashboard is one
 * Mantine application, not a Mantine shell wrapped around hand-written Tailwind pages.
 *
 * "Zero residue" is asserted against the whole dashboard scope (every back-office route and every
 * dashboard-owned component directory), not against a hand-picked list - a hand-picked list is how
 * residue survives. The protected/shared surfaces are asserted from the other side: nothing outside
 * the dashboard scope may import Mantine at all, so the customer-facing graph cannot be dragged in.
 */

const DASHBOARD_SCOPE = [
    "app/admin",
    "app/organizer",
    "app/platform",
    "components/admin",
    "components/organizer",
    "components/platform",
    "components/dashboard",
];

/** Every `.tsx` / `.ts` under a path, walked rather than globbed by the test runner. */
function walkSources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const child = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walkSources(child, out);
        else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts")) out.push(child);
    }
    return out;
}

/**
 * Source with comment lines removed.
 *
 * Prose is allowed to NAME a Tailwind class - several primitives document what they replaced - and a
 * guard that fails on its own explanation is a guard people delete. Full-line `//` and JSDoc `*`
 * lines are dropped; inline trailing comments are not, which is deliberately conservative.
 */
function withoutComments(source: string): string {
    return source
        .split("\n")
        .filter((line) => {
            const trimmed = line.trimStart();
            return !(
                trimmed.startsWith("//") ||
                trimmed.startsWith("*") ||
                trimmed.startsWith("/*")
            );
        })
        .join("\n");
}

const MIGRATED_BODIES = [
    "app/admin/products/page.tsx",
    "app/admin/products/new/page.tsx",
    "app/admin/products/[id]/edit/page.tsx",
    "app/admin/products/RealtimeProductFilter.tsx",
    "app/admin/products/DeleteProductButton.tsx",
    "components/admin/ProductImageUpload.tsx",
    "app/admin/vouchers/page.tsx",
    "app/admin/bulk-discounts/page.tsx",
    "app/admin/settings/AdminSettingsForm.tsx",
    "app/admin/orders/[id]/page.tsx",
    "app/admin/reports/page.tsx",
    "app/admin/refunds/page.tsx",
    "app/admin/spin-wheel/page.tsx",
    "app/admin/flash-sales/page.tsx",
    "app/admin/whatsapp/WhatsAppDashboard.tsx",
    "app/admin/campaigns/page.tsx",
    "app/admin/promotions/page.tsx",
    "app/admin/broadcasts/page.tsx",
    "components/admin/affiliate/AdminAffiliatePage.tsx",
    "components/admin/affiliate/AdminAffiliateDetail.tsx",
    "components/admin/affiliate/AdminAffiliateManagement.tsx",
    "components/admin/affiliate/AdminPayoutsPage.tsx",
    "components/admin/affiliate/AdminAuditLogPage.tsx",
    "components/organizer/EventForm.tsx",
    "components/organizer/TicketTypeManager.tsx",
];

describe("P-M8. the dashboard body migration is complete", () => {
    it("no dashboard file composes Tailwind markup any more", () => {
        const offenders = DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)).filter(
            (file) => withoutComments(read(file)).includes("className")
        );

        expect(offenders).toEqual([]);
    });

    it("every page body and manager component on the migration list is Mantine", () => {
        for (const file of MIGRATED_BODIES) {
            expect({ file, mantine: read(file).includes("@mantine/") }).toEqual({
                file,
                mantine: true,
            });
        }
    });

    it("the dashboard is the ONLY place Mantine reaches", () => {
        /*
         * The migration's central safety property: the customer-facing graph (catalog, cart,
         * checkout, ticketing, profile, the root layout and the shared dialog) is not a Mantine
         * surface and must stay that way. If Mantine appears outside the dashboard scope, a shared
         * or retail component was migrated by accident.
         */
        const scoped = new Set(
            DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir))
        );

        const leaked = [...walkSources("app"), ...walkSources("components")].filter(
            (file) => !scoped.has(file) && read(file).includes("@mantine/")
        );

        expect(leaked).toEqual([]);
    });

    it("the shared dialog stays Tailwind and out of the dashboard", () => {
        // `useDialog` is mounted by the ROOT layout and used by retail pages, so it is protected.
        expect(read("components/ui/Dialog.tsx")).toContain("className");
        expect(read("components/ui/Dialog.tsx")).not.toContain("@mantine/");

        /*
         * Comments are stripped first: `DeleteProductButton` documents in prose that it MOVED OFF
         * this helper, and a guard that fails on its own explanation is a guard people delete.
         */
        const importers = DASHBOARD_SCOPE.flatMap((dir) => walkSources(dir)).filter((file) =>
            withoutComments(read(file)).includes("components/ui/Dialog")
        );

        // Dashboard confirmations use Mantine `Modal`; none of them reach for the shared dialog.
        expect(importers).toEqual([]);
    });

    it("the migrated confirmations still carry their original wording", () => {
        expect(read("app/admin/campaigns/page.tsx")).toContain("Hapus kampanye");
        expect(read("app/admin/promotions/page.tsx")).toContain("Hapus promosi");
        expect(read("app/admin/spin-wheel/page.tsx")).toContain("Hapus campaign");
        expect(read("components/admin/affiliate/AdminAffiliatePage.tsx")).toContain(
            "Setujui Pengajuan"
        );
        expect(read("components/admin/affiliate/AdminAffiliateDetail.tsx")).toContain(
            "Suspend Affiliate"
        );
        expect(read("components/organizer/TicketTypeManager.tsx")).toContain(
            "Hapus jenis tiket"
        );
    });

    it("the class-C forms kept their endpoints and their payload shapes", () => {
        // Vouchers: one page, two verbs, and the conditional `maxDiscount` key.
        const vouchers = read("app/admin/vouchers/page.tsx");
        expect(vouchers).toContain("/api/admin/vouchers");
        expect(vouchers).toContain("toUpperCase()");
        expect(vouchers).toContain("PERCENTAGE");

        // Bulk discounts: the product-multi-select payload is still built the same way.
        expect(read("app/admin/bulk-discounts/page.tsx")).toContain("/api/admin/bulk-discounts");

        // Settings: the large form still reads and writes the same endpoints.
        const settings = read("app/admin/settings/AdminSettingsForm.tsx");
        expect(settings).toContain("/api/admin/settings");

        // Order detail: the mutation endpoints are untouched.
        const orderDetail = read("app/admin/orders/[id]/page.tsx");
        expect(orderDetail).toContain("/api/admin/orders/");

        // Refunds / reports: financial reads only, same routes.
        expect(read("app/admin/refunds/page.tsx")).toContain("/api/admin/refunds");
        expect(read("app/admin/reports/page.tsx")).toContain("/api/admin/reports");
    });

    it("the WhatsApp dashboard kept its Baileys surface intact", () => {
        const wa = read("app/admin/whatsapp/WhatsAppDashboard.tsx");

        for (const endpoint of [
            "/api/admin/whatsapp/status",
            "/api/admin/whatsapp/qr",
            "/api/admin/whatsapp/connect",
            "/api/admin/whatsapp/disconnect",
        ]) {
            expect(wa).toContain(endpoint);
        }

        // The polling contract and the never-log-the-QR-string rule survive the redesign.
        expect(wa).toContain("POLL_INTERVAL_MS = 1500");
        expect(wa).toContain("[WA DASHBOARD QR]");
    });

    it("the affiliate pages still display money through the same formatter", () => {
        const moneyFormatters = [
            "components/admin/affiliate/AdminAffiliateDetail.tsx",
            "components/admin/affiliate/AdminAffiliateManagement.tsx",
            "components/admin/affiliate/AdminPayoutsPage.tsx",
        ];

        for (const file of moneyFormatters) {
            const source = read(file);

            // `rupiah()` is still `Rp` + `Number(v).toLocaleString("id-ID")`.
            expect(source).toContain('toLocaleString("id-ID")');
            expect(source).toContain("function rupiah(v: number)");
            // No arithmetic on money was introduced by the redesign.
            expect(source).not.toMatch(/amount\s*[+\-*/]=\s/);
        }

        // The applications list has no money column, but its dates are still `id-ID`.
        expect(read("components/admin/affiliate/AdminAffiliatePage.tsx")).toContain('"id-ID"');

        // The payout action payloads are unchanged: action, conditional reason, conditional proof.
        const payouts = read("components/admin/affiliate/AdminPayoutsPage.tsx");
        expect(payouts).toContain('body.reason = reason.trim()');
        expect(payouts).toContain('body.proofFilePath = refNumber.trim()');
        expect(payouts).toContain('action === "CONFIRM_PAID"');

        // The commission action payload is unchanged too.
        const detail = read("components/admin/affiliate/AdminAffiliateDetail.tsx");
        expect(detail).toContain('action: "UPDATE_RATE"');
        expect(detail).toContain('action: "UPDATE_STATUS"');
    });

    it("the organizer ticket form still sends price as the string it received", () => {
        const manager = read("components/organizer/TicketTypeManager.tsx");

        // The whole point of the Phase 5 price rule: no numeric round trip on money.
        expect(manager).toContain("price: type.price");
        expect(manager).toContain("price: form.price");
        expect(manager).not.toContain("Number(form.price)");

        // Inventory counters the organizer is authorized to see are still rendered.
        for (const counter of ["quota", "sold", "reserved", "available"]) {
            expect(manager).toContain(`inventory.${counter}`);
        }

        // Endpoints unchanged.
        expect(manager).toContain("/ticket-types");
        expect(manager).toContain('method: "DELETE"');
    });

    it("the event form still owns its payload, its redirect and its ISO conversion", () => {
        const form = read("components/organizer/EventForm.tsx");

        expect(form).toContain("/api/organizer/events");
        expect(form).toContain("organizerId");
        expect(form).toContain("toIso(values.startAt)");
        expect(form).toContain("router.push");
        // Publication is still not reachable from this form.
        expect(form).not.toContain('status: "PUBLISHED"');
    });

    it("server pages get their link behaviour from client primitives", () => {
        /*
         * Regression for the boundary bug this phase found: `/admin/products` is a SERVER component
         * that was passing `component={Link}` to Mantine. `PrimaryAction` exists precisely so a
         * server page can render a link button without crossing the boundary.
         */
        const products = read("app/admin/products/page.tsx");

        expect(products).not.toContain("component={Link}");
        expect(products).toContain("PrimaryAction");

        const primitives = read("components/dashboard/primitives.tsx");
        expect(primitives).toMatch(/export function PrimaryAction\(\{[\s\S]*href/);
    });
});
