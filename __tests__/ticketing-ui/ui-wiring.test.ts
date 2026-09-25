import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 9 — UI / ARCHITECTURE WIRING GUARDS
 * ==========================================
 *
 * Static assertions over the source tree, in the style the earlier phases established: they pin
 * ARCHITECTURAL BOUNDARIES, never cosmetics. Nothing below fails because a class name or a padding
 * value changed — each test pins a rule that would be a defect if it were broken:
 *
 *   • the discovery pages are wrapped, so they cannot lose their chrome silently;
 *   • no page derives payment/ownership truth from the URL;
 *   • no UI file talks to the database or the payment provider directly;
 *   • the QR is rendered from a server-supplied payload and never assembled in a component;
 *   • the wallet list carries no credential;
 *   • check-in is a BACK-OFFICE tool, and the buyer's surfaces still carry no control for it;
 *   • the design tokens did not repaint the live retail storefront;
 *   • no UI framework was added.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
    return existsSync(path.join(ROOT, relativePath));
}

/** Every file under `dir`, recursively. Directories that do not exist yield nothing. */
function walk(dir: string): string[] {
    const absolute = path.join(ROOT, dir);

    if (!existsSync(absolute)) {
        return [];
    }

    const entries: string[] = [];

    for (const name of readdirSync(absolute)) {
        const child = path.join(dir, name);

        if (statSync(path.join(ROOT, child)).isDirectory()) {
            entries.push(...walk(child));
        } else {
            entries.push(child);
        }
    }

    return entries;
}

const TICKETING_PAGES = [
    "app/page.tsx",
    "app/events/page.tsx",
    "app/e/[slug]/page.tsx",
    "app/ticketing/tickets/page.tsx",
    "app/ticketing/tickets/[ticketCode]/page.tsx",
    "app/ticketing/orders/page.tsx",
    "app/ticketing/orders/[orderNumber]/page.tsx",
];

const PHASE_9_COMPONENTS = [
    "components/ticketing/Brand.tsx",
    "components/ticketing/SiteHeader.tsx",
    "components/ticketing/SiteFooter.tsx",
    "components/ticketing/SiteShell.tsx",
    "components/ticketing/SearchBar.tsx",
    "components/ticketing/SectionHeader.tsx",
    "components/ticketing/EmptyState.tsx",
    "components/ticketing/SportGrid.tsx",
    "components/ticketing/EventRow.tsx",
    "components/ticketing/StickyBuyBar.tsx",
    "components/ticketing/TicketCard.tsx",
    "components/ticketing/TicketStatusBadge.tsx",
    "components/ticketing/CatalogFilters.tsx",
    "components/ticketing/CatalogPagination.tsx",
    "components/events/EventCard.tsx",
];

describe("H1. every ticketing page renders through the shared shell", () => {
    it.each(TICKETING_PAGES)("%s uses SiteShell", (page) => {
        const source = read(page);

        expect(source).toContain("SiteShell");
        expect(source).toMatch(/<SiteShell>/);
    });

    it("the shell provides the header, the main landmark and the ticketing footer", () => {
        const shell = read("components/ticketing/SiteShell.tsx");

        expect(shell).toContain("SiteHeader");
        expect(shell).toContain("SiteFooter");
        expect(shell).toContain("<main");
        expect(shell).toContain("data-ticketing-shell");
    });
});

describe("H2. no page derives authoritative state from the URL", () => {
    it("the order page takes no search parameters at all", () => {
        const source = read("app/ticketing/orders/[orderNumber]/page.tsx");

        expect(source).not.toContain("searchParams");
        // The buyer-visible payment facts come from the order payload.
        expect(source).toContain("order.paymentStatus");
        expect(source).toContain("order.status");
    });

    it("the e-ticket page takes no search parameters either", () => {
        expect(read("app/ticketing/tickets/[ticketCode]/page.tsx")).not.toContain(
            "searchParams"
        );
    });

    it("no ticketing page trusts a query flag as proof of payment", () => {
        for (const page of TICKETING_PAGES) {
            const source = read(page);

            // `\b` matters: `order.paymentStatus === "PAID"` is the DEFAULT the page must make, and
            // it must not be flagged. What is banned is reading a bare `status`/`paid` flag — i.e.
            // something a URL could have supplied.
            expect(source).not.toMatch(/\bstatus\s*===?\s*["'](paid|success|settled)["']/i);
            expect(source).not.toMatch(/\bpaid\s*===?\s*["']?1/);
            expect(source).not.toContain("?status=paid");
            expect(source).not.toContain("searchParams.status");
        }
    });

    it("only the catalog and the wallet read URL state, and only as filters/views", () => {
        const catalog = read("app/events/page.tsx");
        const wallet = read("app/ticketing/tickets/page.tsx");

        expect(catalog).toContain("catalogQuerySchema");
        expect(wallet).toContain("parseWalletView");
    });
});

describe("H3. the UI never talks to the database, the provider or the session store directly", () => {
    it("no discovery component imports Prisma or a data service", () => {
        for (const component of PHASE_9_COMPONENTS) {
            const source = read(component);

            expect(source).not.toMatch(/from "@\/lib\/prisma"/);
            expect(source).not.toMatch(/from "@\/lib\/payment/);

            // A TYPE import of an enum is fine (the badge maps `TicketStatus` to a label and the
            // compiler erases it); a VALUE import would put the ORM client in the browser bundle.
            for (const line of source.split("\n")) {
                if (line.includes('from "@prisma/client"')) {
                    expect(line.trim()).toMatch(/^import type\b/);
                }
            }
        }
    });

    it("no page queries Prisma directly — every read goes through a service", () => {
        for (const page of TICKETING_PAGES) {
            const source = read(page);

            expect(source).not.toContain('from "@/lib/prisma"');
            expect(source).not.toContain("prisma.");
        }
    });

    it("only the header reads the session, and only for its own actions", () => {
        expect(read("components/ticketing/SiteHeader.tsx")).toContain(
            'from "@/auth"'
        );

        for (const component of PHASE_9_COMPONENTS.filter(
            (file) => !file.endsWith("SiteHeader.tsx")
        )) {
            expect(read(component)).not.toMatch(/from "@\/auth"/);
        }
    });

    it("no ticketing UI imports a retail component or the retail payment library", () => {
        for (const file of [...PHASE_9_COMPONENTS, ...TICKETING_PAGES]) {
            const source = read(file);

            expect(source).not.toMatch(/from "@\/components\/products/);
            expect(source).not.toMatch(/from "@\/lib\/payment/);
        }
    });
});

describe("H4. the QR is server-supplied and never assembled in the UI", () => {
    it("the renderer takes the payload as a prop and computes nothing", () => {
        const source = read("components/tickets/TicketQr.tsx");

        expect(source).toContain("payload: string");
        expect(source).not.toContain("fetch(");
        expect(source).not.toContain("useEffect");
        expect(source).not.toContain("ticketCode");
        expect(source).not.toContain("qrToken");
    });

    it("the e-ticket page passes the server's payload verbatim", () => {
        const source = read("app/ticketing/tickets/[ticketCode]/page.tsx");

        expect(source).toContain("payload={ticket.qr.payload}");
        expect(source).not.toContain("TICKET:");
    });

    it("the wallet list mounts no QR renderer and exposes no credential", () => {
        const page = read("app/ticketing/tickets/page.tsx");
        const card = read("components/ticketing/TicketCard.tsx");

        for (const source of [page, card]) {
            expect(source).not.toContain("TicketQr");
            expect(source).not.toContain("QRCodeSVG");
            expect(source).not.toContain("qrToken");
        }
    });
});

describe("H5. check-in is a back-office tool, not a buyer-facing one", () => {
    it("the gate lives under the organizer dashboard, not in the ticketing UI", () => {
        const apiRoutes = walk("app/api").filter((file) =>
            file.endsWith("route.ts")
        );

        // A sanity floor so an empty enumeration cannot make the assertion below
        // vacuous. The ticketing surface has ~30 route files.
        expect(apiRoutes.length).toBeGreaterThan(20);

        // Phase 13 added exactly one gate route, and it is an organizer route. The public
        // ticketing namespace (`app/api/ticketing/**`, which the buyer's session reaches)
        // gained none: a buyer cannot admit their own ticket.
        expect(
            apiRoutes.filter((file) => /checkin|check-in|scan/i.test(file))
        ).toEqual(["app/api/organizer/events/[id]/check-in/route.ts"]);

        expect(
            apiRoutes.filter(
                (file) => file.startsWith("app/api/ticketing/") && /check-?in/i.test(file)
            )
        ).toEqual([]);
    });

    it("no buyer page or component offers a scanner, a validate button or a fake check-in state", () => {
        // Unchanged by Phase 13: the gate is rendered from the organizer event page, so the
        // public ticketing surfaces must still carry no permission, no staff vocabulary and
        // no state-changing control.
        for (const file of [...TICKETING_PAGES, ...PHASE_9_COMPONENTS]) {
            const source = read(file);

            expect(source).not.toMatch(/checkin\.scan|checkin\.override/);
            expect(source).not.toMatch(/StaffEventAssignment/);
            // A gate action would have to be a state-changing control; the e-ticket has none.
            expect(source).not.toMatch(/validateTicket|scanTicket/);
            expect(source).not.toMatch(/ticketing\/checkin/);
        }
    });

    it("the e-ticket tells the buyer what it is and offers no false action", () => {
        const source = read("app/ticketing/tickets/[ticketCode]/page.tsx");

        expect(source).toContain("Tunjukkan QR ini di pintu masuk");
        expect(source).not.toContain("<button");
    });
});

describe("H6. the design tokens did not repaint the live retail storefront", () => {
    const css = read("app/globals.css");

    it("declares the two new namespaced scales", () => {
        expect(css).toContain("--color-ink-900");
        expect(css).toContain("--color-brand-600");
    });

    it("redefines no default Tailwind colour or font token", () => {
        expect(css).not.toMatch(/--color-(gray|blue|rose|slate|red)-\d+:/);
        expect(css).not.toMatch(/--font-geist-(sans|mono):\s*[^v]/);
    });

    it("no longer needs a footer-suppression rule, because there is no global footer", () => {
        // The retail `<Footer>` used to be mounted by `app/layout.tsx` on every route, and the
        // ticketing shell suppressed it with a `body:has([data-ticketing-shell])` rule. Both the
        // component and the global mount point were deleted with retail, so the suppression rule
        // went with them rather than surviving as dead CSS.
        expect(css).not.toMatch(/footer\[data-global-footer\]\s*\{/);
        expect(read("app/layout.tsx")).not.toContain("<Footer");
        expect(existsSync(path.join(ROOT, "components/Footer.tsx"))).toBe(false);
    });
});

describe("H7. no UI framework or component library was added", () => {
    const pkg = JSON.parse(read("package.json")) as {
        dependencies: Record<string, string>;
    };
    const dependencies = Object.keys(pkg.dependencies);

    it("the new UI imports no component/animation/state framework", () => {
        // Asserted at the import site rather than against `package.json`: the retail storefront
        // already ships `@tanstack/react-query` and `framer-motion`, and this phase may not touch
        // retail — so what matters is that no file this phase wrote reaches for one.
        const forbidden = /(shadcn|@radix-ui|@headlessui|lucide|framer-motion|@tanstack|antd|@mui|@chakra|@mantine)/i;

        for (const file of [...PHASE_9_COMPONENTS, ...TICKETING_PAGES]) {
            expect(read(file)).not.toMatch(forbidden);
        }
    });

    it("reuses the QR renderer already installed by the project", () => {
        expect(dependencies).toContain("qrcode.react");
        expect(read("components/tickets/TicketQr.tsx")).toContain(
            'from "qrcode.react"'
        );
    });

    it("adds no icon library: the new UI inlines the few decorative SVGs it needs", () => {
        for (const component of PHASE_9_COMPONENTS) {
            expect(read(component)).not.toMatch(/from "react-icons/);
        }
    });
});

describe("H8. no unsafe rendering or leaked internals in the new UI", () => {
    it("no dangerouslySetInnerHTML and no raw secret in any ticketing UI file", () => {
        for (const file of [...PHASE_9_COMPONENTS, ...TICKETING_PAGES]) {
            const source = read(file);

            expect(source).not.toContain("dangerouslySetInnerHTML");
            expect(source).not.toMatch(/qrTokenHash|IPAYMU_|PAYMENT_SECRET/);
        }
    });

    it("the discovery components exist where the pages import them from", () => {
        for (const component of PHASE_9_COMPONENTS) {
            expect(exists(component)).toBe(true);
        }
    });
});
