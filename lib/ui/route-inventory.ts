/**
 * ==========================================
 * ROUTE / PAGE INVENTORY (PHASE 10)
 * ==========================================
 *
 * WHY THIS IS CODE AND NOT PROSE
 * ------------------------------
 * The brief asks for a page inventory with per-route evidence, and for deletions to be backed by
 * proof. A markdown table cannot be checked, so the table lives here and
 * `__tests__/ui-consolidation/route-inventory.test.ts` proves it against the filesystem: every
 * `app/**\/page.tsx` must appear exactly once, every entry must point at a file that exists, and
 * every entry marked reachable must carry a reference that is not "NO inbound reference".
 *
 * HOW `referencedBy` WAS PRODUCED
 * -------------------------------
 * Mechanically, not by memory. A throwaway probe walked `app/**`, `components/**`, `lib/**`,
 * `__tests__/**` and `proxy.ts` and matched each route as a **complete URL token** — quote,
 * backtick, `(`, `)`, `?`, `#`, whitespace, comma or end of line after it — plus a
 * template-literal prefix match (`/e/${slug}`) for dynamic segments. Two false-positive classes
 * were found and eliminated while building it, and both matter for reading this table:
 *
 *   1. A plain substring search reported `/promotions` as "referenced" by
 *      `/api/admin/promotions`, and similarly inflated `/orders`, `/products` and `/checkout`
 *      from `/api/...` imports. The v1 probe therefore printed *every* route as reachable,
 *      including three that are not.
 *   2. Requiring a quote before the route hid concatenated URLs
 *      (`${base}/checkout/payment-finish?orderId=…`), which made a live route look dead.
 *
 * The first two columns are stable; `policy` and `note` are the parts a human should review.
 *
 * WHAT THE DATA SAYS
 * ------------------
 * 64 pages. 0 with no inbound reference *of any kind* except the three below, which are reachable
 * only by typing the URL. Nothing in the tree is provably orphaned, which is why this phase
 * deleted no page: the evidence for a safe removal simply is not there.
 *
 *   KEEP      reachable and already on the consolidated identity, or coloured semantically
 *   REFACTOR  reachable, still needed, but its page body (or the client component it renders)
 *             still carries the legacy `rose`/`blue` accent. The accent sweep was deliberately
 *             left out of this phase's scope — see TICKETING_PHASE10_REPORT.md §3
 *   REDIRECT  none. No route was retired, so nothing needs to keep an old URL alive
 *   REMOVE    none. No route met the evidence bar
 *   BLOCKED   reachable neither from navigation nor from another page, and not provably obsolete
 *             either — see the note on each
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

/**
 * The audited inventory, sorted the way the probe emits it (path order, `app/` stripped).
 *
 * Every row was verified against the tree in this phase. `REFACTOR` rows are the accent-sweep
 * backlog: they are *not* dead, and treating this column as a deletion list would break live
 * retail and admin screens.
 */
export const ROUTE_INVENTORY: RouteEntry[] = [
    ["/addresses/[id]/edit", "app/addresses/[id]/edit/page.tsx", "REFACTOR", "app/addresses/page.tsx"],
    ["/addresses/new", "app/addresses/new/page.tsx", "REFACTOR", "app/addresses/page.tsx"],
    ["/addresses", "app/addresses/page.tsx", "REFACTOR", "app/profile/ProfileContent.tsx, app/addresses/[id]/edit/page.tsx"],
    ["/admin/affiliate/audit-log", "app/admin/affiliate/audit-log/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/affiliate/manage/[id]", "app/admin/affiliate/manage/[id]/page.tsx", "KEEP", "components/admin/affiliate/AdminAffiliateManagement.tsx"],
    ["/admin/affiliate/manage", "app/admin/affiliate/manage/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/affiliate", "app/admin/affiliate/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx, components/admin/affiliate/AdminAffiliateDetail.tsx"],
    ["/admin/affiliate/payouts", "app/admin/affiliate/payouts/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/broadcasts", "app/admin/broadcasts/page.tsx", "REFACTOR", "components/admin/AdminNavbar.tsx"],
    ["/admin/bulk-discounts", "app/admin/bulk-discounts/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/campaigns", "app/admin/campaigns/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/discounts", "app/admin/discounts/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/flash-sales", "app/admin/flash-sales/page.tsx", "REFACTOR", "components/admin/AdminNavbar.tsx"],
    ["/admin/orders/[id]", "app/admin/orders/[id]/page.tsx", "REFACTOR", "app/admin/refunds/page.tsx"],
    ["/admin/orders", "app/admin/orders/page.tsx", "KEEP", "app/admin/page.tsx, components/admin/AdminNavbar.tsx"],
    ["/admin", "app/admin/page.tsx", "REFACTOR", "app/platform/layout.tsx, components/admin/AdminNavbar.tsx"],
    ["/admin/products/[id]/edit", "app/admin/products/[id]/edit/page.tsx", "REFACTOR", "app/admin/products/DeleteProductButton.tsx"],
    ["/admin/products/new", "app/admin/products/new/page.tsx", "REFACTOR", "app/admin/products/page.tsx"],
    ["/admin/products", "app/admin/products/page.tsx", "REFACTOR", "app/admin/page.tsx, components/admin/AdminNavbar.tsx"],
    ["/admin/promotions", "app/admin/promotions/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/refunds", "app/admin/refunds/page.tsx", "REFACTOR", "components/admin/AdminNavbar.tsx"],
    ["/admin/reports", "app/admin/reports/page.tsx", "REFACTOR", "app/admin/page.tsx, components/admin/AdminNavbar.tsx"],
    ["/admin/settings", "app/admin/settings/page.tsx", "REFACTOR", "components/admin/AdminNavbar.tsx"],
    ["/admin/shipping-discounts", "app/admin/shipping-discounts/page.tsx", "REFACTOR", "components/admin/AdminNavbar.tsx"],
    ["/admin/spin-wheel", "app/admin/spin-wheel/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/users", "app/admin/users/page.tsx", "REFACTOR", "app/admin/page.tsx, components/admin/AdminNavbar.tsx"],
    ["/admin/vouchers", "app/admin/vouchers/page.tsx", "KEEP", "components/admin/AdminNavbar.tsx"],
    ["/admin/whatsapp", "app/admin/whatsapp/page.tsx", "REFACTOR", "components/admin/AdminNavbar.tsx"],
    ["/affiliate/dashboard", "app/affiliate/dashboard/page.tsx", "KEEP", "app/affiliate/AffiliateContent.tsx, app/affiliate/payouts/page.tsx"],
    ["/affiliate", "app/affiliate/page.tsx", "REFACTOR", "app/profile/ProfileContent.tsx, app/affiliate/dashboard/AffiliateDashboard.tsx"],
    ["/affiliate/payouts", "app/affiliate/payouts/page.tsx", "REFACTOR", "app/affiliate/dashboard/AffiliateDashboard.tsx"],
    ["/buy-now", "app/buy-now/page.tsx", "REFACTOR", "components/products/ProductDetail.tsx, proxy.ts"],
    [
        "/campaigns",
        "app/campaigns/page.tsx",
        "BLOCKED",
        "NO inbound reference. Renders components/products/CampaignsList.tsx, which reads the live /api/campaigns. Not proven obsolete: the retail WhatsApp broadcast feature and existing shared links may target it. Either link it from a retail menu entry or retire it behind a redirect — a product decision, so this phase changed nothing.",
    ],
    ["/cart", "app/cart/page.tsx", "REFACTOR", "components/products/BottomNavbar.tsx, components/ticketing/SiteFooter.tsx"],
    ["/checkout", "app/checkout/page.tsx", "REFACTOR", "components/ticketing/SiteFooter.tsx, components/ticketing/SiteHeader.tsx"],
    ["/checkout/payment-finish", "app/checkout/payment-finish/page.tsx", "REFACTOR", "app/api/buy-now/ipaymu/route.ts, app/api/orders/[id]/repay/route.ts"],
    ["/checkout/success", "app/checkout/success/page.tsx", "KEEP", "app/buy-now/BuyNowPage.tsx, app/checkout/CheckoutPage.tsx"],
    ["/e/[slug]", "app/e/[slug]/page.tsx", "KEEP", "app/ticketing/orders/[orderNumber]/page.tsx, components/events/EventCard.tsx"],
    ["/events", "app/events/page.tsx", "KEEP", "app/organizer/layout.tsx, components/ticketing/SiteHeader.tsx"],
    ["/faq", "app/faq/page.tsx", "REFACTOR", "components/Footer.tsx, components/ticketing/SiteFooter.tsx"],
    [
        "/flash-sales",
        "app/flash-sales/page.tsx",
        "BLOCKED",
        "NO inbound reference. Renders components/products/FlashSalesList.tsx over the live /api/flash-sales. Same reasoning as /campaigns: unlinked, not provably dead.",
    ],
    ["/home", "app/home/page.tsx", "REFACTOR", "components/Footer.tsx, components/products/BottomNavbar.tsx"],
    ["/kontak", "app/kontak/page.tsx", "REFACTOR", "components/Footer.tsx, components/ticketing/SiteFooter.tsx"],
    ["/login", "app/login/page.tsx", "KEEP", "app/platform/layout.tsx, components/Footer.tsx"],
    ["/orders/[id]", "app/orders/[id]/page.tsx", "REFACTOR", "app/admin/orders/[id]/page.tsx, app/admin/refunds/page.tsx"],
    ["/orders", "app/orders/page.tsx", "KEEP", "app/profile/ProfileContent.tsx, components/products/BottomNavbar.tsx"],
    ["/organizer/events/[id]", "app/organizer/events/[id]/page.tsx", "KEEP", "components/organizer/EventActions.tsx, components/organizer/EventForm.tsx"],
    ["/organizer/events/new", "app/organizer/events/new/page.tsx", "KEEP", "app/organizer/events/page.tsx"],
    ["/organizer/events", "app/organizer/events/page.tsx", "KEEP", "app/organizer/layout.tsx, components/ticketing/SiteHeader.tsx"],
    ["/organizer/venues", "app/organizer/venues/page.tsx", "KEEP", "app/organizer/layout.tsx, components/ticketing/SiteFooter.tsx"],
    ["/", "app/page.tsx", "KEEP", "the application root; entered directly"],
    ["/platform/sports", "app/platform/sports/page.tsx", "KEEP", "app/platform/layout.tsx"],
    ["/platform/venues", "app/platform/venues/page.tsx", "KEEP", "app/platform/layout.tsx"],
    ["/products/[slug]", "app/products/[slug]/page.tsx", "KEEP", "app/admin/products/DeleteProductButton.tsx, app/admin/products/[id]/edit/page.tsx"],
    ["/products", "app/products/page.tsx", "REFACTOR", "components/Footer.tsx, components/products/BottomNavbar.tsx"],
    ["/profile", "app/profile/page.tsx", "KEEP", "components/products/BottomNavbar.tsx, app/addresses/page.tsx"],
    ["/promos", "app/promos/page.tsx", "REFACTOR", "app/profile/ProfileContent.tsx"],
    [
        "/promotions",
        "app/promotions/page.tsx",
        "BLOCKED",
        "NO inbound reference. Renders components/products/PromotionsList.tsx over the live /api/promotions. NOT a duplicate of /promos: that page is the buyer's own spin-wheel reward vouchers ('Promo Saya'), this one is the public store-wide promotion list.",
    ],
    ["/refund-policy", "app/refund-policy/page.tsx", "REFACTOR", "components/Footer.tsx, components/ticketing/SiteFooter.tsx"],
    ["/register", "app/register/page.tsx", "KEEP", "components/Footer.tsx, components/ticketing/SiteFooter.tsx"],
    ["/syarat-ketentuan", "app/syarat-ketentuan/page.tsx", "REFACTOR", "components/Footer.tsx, components/ticketing/SiteFooter.tsx"],
    ["/ticketing/orders/[orderNumber]", "app/ticketing/orders/[orderNumber]/page.tsx", "KEEP", "app/ticketing/tickets/[ticketCode]/page.tsx, components/events/TicketPurchaseForm.tsx"],
    ["/ticketing/tickets/[ticketCode]", "app/ticketing/tickets/[ticketCode]/page.tsx", "KEEP", "app/ticketing/orders/[orderNumber]/page.tsx, lib/ticketing/tickets/payload.ts"],
    ["/ticketing/tickets", "app/ticketing/tickets/page.tsx", "KEEP", "components/ticketing/SiteFooter.tsx, components/ticketing/SiteHeader.tsx"],
].map(([route, file, status, referencedBy]) => ({
    route,
    file,
    status: status as RouteStatus,
    referencedBy,
}));

/**
 * Files that carry an entire page's worth of dead weight but are not routes.
 *
 * Both were **empty (0 bytes)** when this phase audited them and are imported from nowhere in
 * `app/**`, `components/**`, `lib/**` or `__tests__/**`. They are the only artifacts in the tree
 * that meet a strict "provably unreachable" bar, and even so **they were not deleted** — the
 * operator asked for an evidence-only pass with no removals, so they are reported and left
 * exactly as found. Removing two 0-byte files needs no further analysis; it was simply not this
 * phase's mandate.
 */
export const UNUSED_FILE_CANDIDATES = [
    {
        file: "components/profile/MenuList.tsx",
        evidence: "0 bytes on disk; no import of it anywhere in the tree",
        recommendation: "REMOVE (safe: a zero-byte module cannot execute)",
    },
    {
        file: "components/profile/ProfileHeader.tsx",
        evidence: "0 bytes on disk; no import of it anywhere in the tree",
        recommendation: "REMOVE (safe: a zero-byte module cannot execute)",
    },
] as const;

export function routesByStatus(status: RouteStatus): RouteEntry[] {
    return ROUTE_INVENTORY.filter((entry) => entry.status === status);
}
