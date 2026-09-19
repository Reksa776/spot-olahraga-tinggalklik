import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * ONE VISUAL IDENTITY
 * ==========================================
 *
 * Before this phase the application ran two palettes: `ink`/`brand` on the discovery surface and
 * `rose` everywhere else (auth, retail chrome, admin sidebar, back offices, the dialog). The
 * blend is what made one product read as three applications, so the accent was consolidated onto
 * `ink`/`brand` for every surface that carries branding or navigation.
 *
 * These tests pin the RULE, not the styling:
 *
 *   • the charter that defines which colours mean what lives in globals.css and is still there;
 *   • no chrome file carries the retired accent — the files here are the ones whose job is
 *     branding and navigation;
 *   • the semantic exceptions stay semantic: a failure state must NOT be repainted brand, because
 *     "your payment failed" in the buy-now colour is a defect, and a sport tint is categorical;
 *   • there is exactly one brand lockup, and every surface renders it.
 *
 * The list of chrome files is deliberately explicit rather than a glob: a glob would silently
 * enlarge the rule's reach the moment someone adds a file, and these are the files the phase
 * actually changed.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * Surfaces whose primary job is identity: they render the mark, the navigation or the product's
 * primary actions. These must speak `ink`/`brand` only.
 */
const IDENTITY_CHROME = [
    "components/Brand.tsx",
    "components/ticketing/Brand.tsx",
    "components/ticketing/SiteHeader.tsx",
    "components/ticketing/SiteFooter.tsx",
    "components/ticketing/SiteShell.tsx",
    "app/login/page.tsx",
    "app/register/page.tsx",
    "components/auth/LoginForm.tsx",
    "components/auth/RegisterForm.tsx",
    // The dashboard's single layout and chrome. The same rule applies to them: identity
    // surfaces carry ink/brand, never an ad-hoc accent.
    "app/dashboard/layout.tsx",
    "components/dashboard/DashboardShell.tsx",
    "components/dashboard/DashboardNav.tsx",
    "components/dashboard/DashboardAppShell.tsx",
    "components/dashboard/DashboardProviders.tsx",
];

/**
 * Retail chrome that used to be on the list above and was deleted with the retail application.
 *
 * Asserted as absent rather than merely dropped from the list: if one of these paths comes back,
 * the retail surface came back with it, and that is a product decision rather than a refactor.
 */
const DELETED_RETAIL_CHROME = [
    "components/Footer.tsx",
    "components/products/BottomNavbar.tsx",
    "components/admin/AdminNavbar.tsx",
    "components/admin/AdminMenuCard.tsx",
    "components/dashboard/AdminShell.tsx",
];

/**
 * `rose`/`red` still appear in these two files ON PURPOSE, and this list is the reason they are
 * not in the set above. It exists so the exception is stated in code rather than in a comment
 * someone can forget.
 */
const SEMANTIC_COLOUR_FILES: Record<string, string> = {
    "app/ticketing/orders/[orderNumber]/page.tsx":
        "EXPIRED / FAILED / held-order states — failure semantics, not brand",
    "lib/ticketing/ui/sport-tint.ts":
        "categorical sport hues — chosen to be distinguishable, not to express brand",
};

describe("P10-5. the accent contract is declared where the tokens are", () => {
    it("globals.css states the contract and the canonical class strings", () => {
        const css = read("app/globals.css");

        expect(css).toContain("ACCENT CONTRACT (PHASE 10)");
        expect(css).toContain("bg-brand-600 text-white hover:bg-brand-700");
        expect(css).toContain("bg-ink-900   text-white hover:bg-ink-800");
        expect(css).toContain("focus-visible:outline-brand-600");
    });

    it("does not weaken the Phase 9 rule that no default Tailwind token was redefined", () => {
        // The Phase 9 suite owns this assertion; repeating it here is deliberate, because the
        // contract block was added to the same file in Phase 10 and could have carried a token.
        expect(read("app/globals.css")).not.toMatch(/--color-(gray|blue|rose|slate|red)-\d+:/);
    });
});

describe("P10-6. no identity surface carries the retired accent", () => {
    it.each(DELETED_RETAIL_CHROME)("%s stays deleted", (file) => {
        expect(existsSync(path.join(ROOT, file))).toBe(false);
    });

    it.each(IDENTITY_CHROME)("%s is free of rose/blue accents", (file) => {
        expect(existsSync(path.join(ROOT, file))).toBe(true);

        const source = read(file);

        expect(source).not.toMatch(/\brose-\d+/);
        // `blue-` only: `sky-` is informational and stays legal.
        expect(source).not.toMatch(/\bblue-\d+/);
    });

    it("the ticketing Brand path is a re-export, so one implementation serves every surface", () => {
        const shim = read("components/ticketing/Brand.tsx");

        expect(shim).toContain('export { default } from "@/components/Brand"');
        // A re-export has no JSX of its own; if the implementation were duplicated here, both
        // files would drift and the split would come back.
        expect(shim).not.toContain("<Link");
    });
});

describe("P10-7. the exceptions stay exceptions", () => {
    it.each(Object.keys(SEMANTIC_COLOUR_FILES))("%s keeps its semantic colour", (file) => {
        // Not a tautology: if a later pass "finishes" the sweep by replacing these with brand,
        // the failure and category states become indistinguishable from the primary CTA, and
        // this test is what stops that.
        expect(read(file)).toMatch(/\b(rose|sky|violet|emerald|amber)-\d+/);
    });
});

describe("P10-8. one lockup, rendered by every surface", () => {
    /*
     * Re-pointed when the back-office chrome moved into the shared dashboard shell. The assertion is
     * unchanged — every surface that renders chrome renders the shared lockup, and nothing
     * re-implements it — but the files that DO the rendering are now the shells rather than the
     * section layouts, which simply pass authority and content through.
     */
    const LOCKUP_CONSUMERS = [
        "components/ticketing/SiteHeader.tsx",
        "components/auth/LoginForm.tsx",
        "components/auth/RegisterForm.tsx",
        "components/dashboard/DashboardShell.tsx",
        "components/dashboard/DashboardNav.tsx",
    ];

    it.each(LOCKUP_CONSUMERS)("%s renders the shared Brand", (file) => {
        expect(read(file)).toContain("<Brand");
    });

    it("defines the wordmark in exactly one place", () => {
        const definition = read("components/Brand.tsx");

        expect(definition).toContain("TinggalKlik");
        expect(definition).toContain(".Co");

        /*
         * The real assertion: no consumer re-implements the mark. Prose naming the product is
         * fine and encouraged (the login screen says "akun TinggalKlik.Co"), so the test looks
         * for the lockup's own markup — the aria-hidden `TK` square — rather than the string.
         * Three private copies of the brand (`Admin Panel`, `Admin Platform`, `Panel
         * Penyelenggara`) is exactly what this replaced.
         */
        for (const file of LOCKUP_CONSUMERS) {
            // `>TK<` is the aria-hidden square inside the lockup, and it exists in exactly one
            // file. Anywhere else it would be a second implementation.
            expect(read(file)).not.toContain(">TK<");
        }
    });

    it("the dashboard identifies itself with a chip, not a second brand", () => {
        // The one shell keeps a section chip beside the mark, so the surface is still
        // identifiable without inventing a second brand. The chip is now a single "Dashboard"
        // label with the caller's standing as its context line.
        expect(read("components/dashboard/DashboardAppShell.tsx")).toContain('sectionLabel="Dashboard"');

        // The context line distinguishes platform from organizer without a second shell.
        expect(read("app/dashboard/layout.tsx")).toContain("Platform ·");
        expect(read("app/dashboard/layout.tsx")).toContain("Penyelenggara");
    });
});

describe("P10-9. the back offices offer a way back to the public site", () => {
    /*
     * Re-pointed twice, and both times for the same reason: the assertion is about the SURFACE
     * offering an exit, not about where the JSX lives.
     *
     *   1. When the chrome moved into the shared dashboard shell, the shell took over the exit.
     *   2. When the layouts were fixed to stop passing a component reference across the client
     *      boundary (a server component cannot), the denial panels' links became `actionHref` props
     *      on the client `AccessDeniedPanel`.
     *
     * The platform denial goes to the site root; the organiser denial goes to the public event
     * catalogue, which is the more useful destination for an organiser without a tenant.
     */
    it.each([
        ["components/dashboard/DashboardNav.tsx", 'href="/"', "Lihat situs"],
        ["components/dashboard/DashboardShell.tsx", 'href="/"', "Lihat situs"],
        ["app/dashboard/layout.tsx", 'actionHref="/events"', "Lihat katalog event"],
    ])("%s offers a way out to a public page", (file, expectedHref, expectedLabel) => {
        const source = read(file);

        expect(source).toContain(expectedHref);
        expect(source).toContain(expectedLabel);
    });
});
