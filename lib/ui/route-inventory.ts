/**
 * ==========================================
 * ROUTE / PAGE INVENTORY
 * ==========================================
 *
 * WHY THIS IS CODE AND NOT PROSE
 * ------------------------------
 * A markdown table cannot be checked, so the table lives here and
 * `__tests__/ui-consolidation/route-inventory.test.ts` proves it against the filesystem: every
 * `app/**\/page.tsx` must appear exactly once, every entry must point at a file that exists, and
 * every entry marked reachable must carry a reference that is not "NO inbound reference".
 *
 * WHAT CHANGED
 * ------------
 * The back office used to be TWO sections with their own layouts — `/organizer/**` (5 pages) and
 * `/platform/**` (4 pages) — plus a 21-page ticketing surface. It is now ONE dashboard at
 * `/dashboard/**` with permission-driven navigation, so those nine pages were replaced by the
 * dashboard's own set: an overview plus events, orders, customers, payments, refunds, PIC,
 * reports and settings. The retired prefixes are 307-redirected in `next.config.ts`, so no inbound link is
 * broken even though no page exists at the old path.
 *
 * `referencedBy` is produced mechanically — matching each route as a complete URL token — and the
 * test re-derives each route from its own file path, so a row cannot drift from the tree.
 */

export type RouteStatus = "KEEP" | "REFACTOR" | "REDIRECT" | "REMOVE" | "BLOCKED";

export type RouteEntry = {
    /** The route as Next serves it. */
    route: string;
    /** The file that implements it, relative to the repository root. */
    file: string;
    status: RouteStatus;
    /** Where it is linked from, or why it has no link. Never empty. */
    referencedBy: string;
};

/** The audited inventory, in path order with `app/` stripped. */
export const ROUTE_INVENTORY: RouteEntry[] = [
    {
        route: "/",
        file: "app/page.tsx",
        status: "KEEP",
        referencedBy: "the application root; entered directly and linked from the dashboard shell",
    },
    {
        route: "/dashboard",
        file: "app/dashboard/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx",
    },
    {
        route: "/dashboard/customers",
        file: "app/dashboard/customers/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx",
    },
    {
        route: "/dashboard/events/[id]",
        file: "app/dashboard/events/[id]/page.tsx",
        status: "KEEP",
        referencedBy: "app/dashboard/events/page.tsx, components/organizer/EventForm.tsx",
    },
    {
        route: "/dashboard/events/new",
        file: "app/dashboard/events/new/page.tsx",
        status: "KEEP",
        referencedBy: "app/dashboard/events/page.tsx",
    },
    {
        route: "/dashboard/events",
        file: "app/dashboard/events/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx, app/page.tsx, app/events/page.tsx, components/organizer/EventActions.tsx",
    },
    {
        route: "/dashboard/orders/[orderNumber]",
        file: "app/dashboard/orders/[orderNumber]/page.tsx",
        status: "KEEP",
        referencedBy: "app/dashboard/orders/page.tsx, app/dashboard/payments/page.tsx",
    },
    {
        route: "/dashboard/orders",
        file: "app/dashboard/orders/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx",
    },
    {
        route: "/dashboard/payments",
        file: "app/dashboard/payments/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx",
    },
    {
        route: "/dashboard/refunds",
        file: "app/dashboard/refunds/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx",
    },
    {
        route: "/dashboard/pic/[id]",
        file: "app/dashboard/pic/[id]/page.tsx",
        status: "KEEP",
        referencedBy: "components/platform/PicManager.tsx",
    },
    {
        route: "/dashboard/pic",
        file: "app/dashboard/pic/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx, app/dashboard/pic/[id]/page.tsx",
    },
    {
        route: "/dashboard/reports",
        file: "app/dashboard/reports/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx",
    },
    {
        route: "/dashboard/settings/sports",
        file: "app/dashboard/settings/sports/page.tsx",
        status: "KEEP",
        referencedBy: "app/dashboard/settings/page.tsx",
    },
    {
        route: "/dashboard/settings/venues",
        file: "app/dashboard/settings/venues/page.tsx",
        status: "KEEP",
        referencedBy: "app/dashboard/settings/page.tsx",
    },
    {
        route: "/dashboard/settings",
        file: "app/dashboard/settings/page.tsx",
        status: "KEEP",
        referencedBy: "components/dashboard/DashboardAppShell.tsx",
    },
    {
        route: "/dashboard/venues",
        file: "app/dashboard/venues/page.tsx",
        status: "KEEP",
        referencedBy: "app/dashboard/settings/page.tsx",
    },
    {
        route: "/e/[slug]",
        file: "app/e/[slug]/page.tsx",
        status: "KEEP",
        referencedBy: "components/events/EventCard.tsx, components/ticketing/StickyBuyBar.tsx, app/ticketing/orders/[orderNumber]/page.tsx, app/dashboard/events/[id]/page.tsx, app/dashboard/pic/[id]/page.tsx",
    },
    {
        route: "/events",
        file: "app/events/page.tsx",
        status: "KEEP",
        referencedBy: "components/ticketing/SiteHeader.tsx, components/ticketing/SiteFooter.tsx, app/dashboard/layout.tsx",
    },
    {
        route: "/faq",
        file: "app/faq/page.tsx",
        status: "KEEP",
        referencedBy: "components/ticketing/SiteFooter.tsx",
    },
    {
        route: "/kontak",
        file: "app/kontak/page.tsx",
        status: "KEEP",
        referencedBy: "components/ticketing/SiteFooter.tsx",
    },
    {
        route: "/login",
        file: "app/login/page.tsx",
        status: "KEEP",
        referencedBy: "components/ticketing/SiteHeader.tsx, components/events/TicketPurchaseForm.tsx, proxy.ts",
    },
    {
        route: "/refund-policy",
        file: "app/refund-policy/page.tsx",
        status: "KEEP",
        referencedBy: "components/ticketing/SiteFooter.tsx",
    },
    {
        route: "/register",
        file: "app/register/page.tsx",
        status: "KEEP",
        referencedBy: "components/auth/LoginForm.tsx, components/ticketing/SiteFooter.tsx",
    },
    {
        route: "/syarat-ketentuan",
        file: "app/syarat-ketentuan/page.tsx",
        status: "KEEP",
        referencedBy: "components/ticketing/SiteFooter.tsx",
    },
    {
        route: "/ticketing/orders/[orderNumber]",
        file: "app/ticketing/orders/[orderNumber]/page.tsx",
        status: "KEEP",
        referencedBy: "components/events/TicketPurchaseForm.tsx, components/tickets/IssueTicketsButton.tsx",
    },
    {
        route: "/ticketing/refunds",
        file: "app/ticketing/refunds/page.tsx",
        status: "KEEP",
        referencedBy: "app/ticketing/orders/[orderNumber]/page.tsx",
    },
    {
        route: "/ticketing/tickets/[ticketCode]",
        file: "app/ticketing/tickets/[ticketCode]/page.tsx",
        status: "KEEP",
        referencedBy: "app/ticketing/tickets/page.tsx, app/ticketing/orders/[orderNumber]/page.tsx",
    },
    {
        route: "/ticketing/tickets",
        file: "app/ticketing/tickets/page.tsx",
        status: "KEEP",
        referencedBy: "components/ticketing/SiteHeader.tsx, components/ticketing/SiteFooter.tsx, components/dashboard/DashboardShell.tsx",
    },
];

/**
 * Files that carry an entire page's worth of dead weight but are not routes.
 *
 * The two zero-byte retail profile components that an earlier revision reported here were
 * deleted with the retail application, so this list is empty. It is kept as an explicit empty
 * list rather than removed so the audit question ("what is unreachable?") keeps having an answer
 * that is checked by the test suite.
 */
export const UNUSED_FILE_CANDIDATES: readonly {
    file: string;
    evidence: string;
    recommendation: string;
}[] = [];

export function routesByStatus(status: RouteStatus): RouteEntry[] {
    return ROUTE_INVENTORY.filter((entry) => entry.status === status);
}
