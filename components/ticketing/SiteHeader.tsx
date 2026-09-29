import Link from "next/link";
import type { PlatformRole } from "@prisma/client";

import { auth } from "@/auth";
import { getApplicationBranding } from "@/lib/app-settings";
import { getDashboardPath, shouldShowDashboardNav } from "@/lib/dashboard/scope";
import { cn } from "@/lib/utils";

import Brand from "./Brand";
import MobileMenuLinks from "./MobileMenuLinks";
import SearchBar from "./SearchBar";
import SiteSignOut from "./SiteSignOut";
import { HEADER_NAV_VARIANT, type HeaderNavVariant } from "./header-nav";

const NAV = [
    { href: "/events", label: "Event" },
    { href: "/events#cabang-olahraga", label: "Cabang olahraga" },
];

/**
 * The label of the back-office entrance, in ONE place so the desktop link and the mobile
 * drawer row cannot drift. The DESTINATION is not a constant: it follows the account's
 * platform role (`getDashboardPath`) — `/dashboard` for ADMIN/MANAGER, `/dashboard/pic` for a
 * PIC. A single hardcoded `/dashboard` is the defect this replaces; see `signedInNavItems`.
 */
const DASHBOARD_NAV_LABEL = "Dashboard";

/** The organiser call to action, as one definition shared by the desktop link and the drawer. */
const BUAT_EVENT_ITEM = { href: "/dashboard/events", label: "Buat event" } as const;

/** One link rendered by the desktop row and pushed into the mobile drawer. */
export type HeaderNavItem = {
    href: string;
    label: string;
    variant: HeaderNavVariant;
};

/**
 * ==========================================
 * THE SIGNED-IN NAV ITEMS — ONE LIST, ONE ROLE-AWARE DESTINATION
 * ==========================================
 *
 * Every signed-in item the header shows, in ONE array that BOTH renderings consume: the
 * desktop link row (`DesktopNavLinks`) and the mobile drawer (`MobileMenu`). The drawer used
 * to spread a single hardcoded constant; now it spreads this list, so the two renderings cannot
 * disagree about WHICH items exist or WHERE they point.
 *
 * ── THE ROLE-ROUTING CONTRACT ───────────────────────────────────────────────────
 *   ADMIN    → /dashboard       (operator back office)
 *   MANAGER  → /dashboard       (operator back office)
 *   PIC      → /dashboard/pic   (PIC self-service — NOT the operator overview)
 *   CUSTOMER → no Dashboard item at all
 *
 * `shouldShowDashboardNav` decides who is offered the item and `getDashboardPath` decides
 * where it points. Both are the project's existing helpers: the path one DERIVES from the
 * login flow's own `LOGIN_ROLE_INTENT_META` table, so the navbar and the post-login redirect
 * can never disagree about where a PIC belongs, and no second role→path mapping exists.
 *
 * ── WHY THIS IS A PURE FUNCTION ─────────────────────────────────────────────────
 * It takes the platform role and returns data, with no session, no database and no rendering.
 * That is what makes the routing decision directly testable for every role — including a
 * RENDERED check that the desktop row really emits `href="/dashboard/pic"` for a PIC (see
 * `__tests__/auth-flow/dashboard-navigation.test.ts`). Nothing here is an authorization: the
 * destination page re-decides its own read on the server.
 */
export function signedInNavItems(
    platformRole: PlatformRole | null | undefined
): HeaderNavItem[] {
    const items: HeaderNavItem[] = [];

    if (shouldShowDashboardNav(platformRole)) {
        items.push({
            href: getDashboardPath(platformRole),
            label: DASHBOARD_NAV_LABEL,
            variant: "quiet",
        });
    }

    items.push({
        href: "/ticketing/orders",
        label: "Pesanan saya",
        variant: "quiet",
    });
    items.push({
        href: "/ticketing/tickets",
        label: "Tiket saya",
        variant: "outline",
    });

    return items;
}

/**
 * The desktop signed-in link row — the SAME items as the drawer, rendered with the shared nav
 * geometry (`components/ticketing/header-nav.ts`). Exported and pure so a test can render it
 * for a role and assert the actual `href` the browser would receive.
 *
 * The `hidden sm:inline-flex` is the responsive contract the row already had: below `sm` the
 * links live in the mobile drawer instead, and the geometry's `inline-flex` is restored at
 * `sm`, so the item is never `display:none` at desktop widths.
 */
export function DesktopNavLinks({ items }: { items: HeaderNavItem[] }) {
    return (
        <>
            {items.map((item) => (
                <Link
                    key={item.href}
                    href={item.href}
                    className={cn(
                        HEADER_NAV_VARIANT[item.variant],
                        "hidden xl:inline-flex"
                    )}
                >
                    {item.label}
                </Link>
            ))}
        </>
    );
}

/**
 * The header for the ticketing discovery surface.
 *
 * Why not in `app/layout.tsx`: the retail storefront (`/products`, `/cart`, `/checkout`,
 * `/orders`) is live and renders its own chrome; a global header would double up there. Ticketing
 * pages opt in via `SiteShell`, which is additive by construction. Every route that renders this
 * header — `/`, `/events`, `/e/[slug]`, the legal pages — renders THE SAME header: there is one
 * public navbar in the product, and this is it.
 *
 * Sole data read is `auth()` — the cookie session, no database round-trip — so the header can sit
 * on every page without adding a query. Anything authoritative (ticket counts, order state) is
 * read by the page that needs it. That is also why the Dashboard item is gated on the session's
 * PLATFORM ROLE rather than on a resolved capability set: the role is already in the session (the
 * D-48 mirror `auth.ts` refreshes from the database), whereas capabilities would mean the `User`
 * row plus every membership and grant, on every public page, for every signed-in visitor. See
 * `shouldShowDashboardNav` for the argument and for the one asymmetry it accepts.
 *
 * DASHBOARD VISIBILITY AND DESTINATION ARE UX ONLY. `/dashboard` and `/dashboard/pic` are gated
 * server-side by the dashboard layout and by every service under it, so an account that is not
 * offered the link is refused exactly as before, and an account that is offered it gains nothing
 * by seeing it — including by typing `/dashboard` by hand.
 *
 * Mobile deliberately has no inline search field: at 375px the row would be brand + field +
 * actions, which is the "overcrowded" failure the brief warns about. Search is a full-width
 * primary action inside the page instead (hero on `/`, top of `/events`), which is the pattern
 * the reference products use.
 */
export default async function SiteHeader() {
    // PHASE 32: the public header renders the ADMIN-configured logo. Fetched beside the
    // session rather than after it, so the two reads overlap; `getApplicationBranding` is
    // request-cached, so the footer and the maintenance page share this one query.
    const [session, branding] = await Promise.all([
        auth(),
        getApplicationBranding(),
    ]);
    const signedIn = Boolean(session?.user);

    /*
     * ONE decision per render, shared by both renderings: the platform role is read once, the
     * item list is built once from it, and the desktop row and the mobile drawer both consume
     * that same list. A GUEST has no session and a CUSTOMER resolves to no Dashboard item;
     * ADMIN, MANAGER and PIC get one, pointing at `/dashboard`, `/dashboard`, `/dashboard/pic`
     * respectively. Nothing here is a security boundary — see the header.
     */
    const platformRole = session?.user.platformRole;
    const navItems = signedIn ? signedInNavItems(platformRole) : [];

    return (
        <header className="sticky top-0 z-40 border-b border-ink-100 bg-white/90 backdrop-blur">
            {/*
             * ── THE ROW'S FLEX CONTRACT ─────────────────────────────────────────────
             * The row is a four-region flex line: [BRAND] [PRIMARY NAV] [SEARCH] [USER NAV].
             * Each region declares its shrink behaviour EXPLICITLY, because the previous
             * header left it to the default and flexbox resolved the overflow by crushing the
             * one item that happened to be shrinkable — the brand lockup.
             *
             *   BRAND     `shrink-0` — a logo + name is ONE unit and never gives way. The
             *             shared `Brand` lockup carries `min-w-0` + `truncate` for surfaces
             *             with a genuinely narrow rail (the dashboard sidebar); inside this
             *             non-shrinking region that text can never be ellipsized, so the name
             *             renders WHOLE and cannot be overlapped by "Event".
             *   NAV       `shrink-0` — its items are already `whitespace-nowrap`; the region
             *             must not shrink below them or they would spill over the brand.
             *   SEARCH    `min-w-0 flex-1` — the ONE region allowed to yield. It grows into
             *             free space and shrinks first when there is none.
             *   USER NAV  `shrink-0` — the signed-in controls keep their shared `h-10` box.
             *
             * With the brand and both navigation regions pinned, the only order in which space
             * is conceded is: search first, then (below `xl`) the signed-in links move into the
             * existing mobile drawer. Nothing ever overlaps and nothing is ever truncated.
             */}
            <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
                {/* BRAND REGION — `flex: 0 0 auto`, so the lockup is never squeezed. */}
                <div className="flex shrink-0 items-center">
                    <Brand logoSrc={branding.logoUrl} />
                </div>

                <nav
                    aria-label="Navigasi utama"
                    className="hidden shrink-0 items-center gap-1 lg:flex"
                >
                    {/* The public links use the SAME nav geometry as the signed-in controls,
                        so the header reads as one system whether or not a visitor is signed in. */}
                    {NAV.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={cn(
                                HEADER_NAV_VARIANT.quiet,
                                "inline-flex"
                            )}
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>

                <div className="hidden min-w-0 flex-1 justify-end md:flex lg:max-w-xl">
                    <SearchBar size="sm" placeholder="Cari event atau olahraga…" />
                </div>

                <div className="ml-auto flex shrink-0 items-center gap-1.5 md:ml-0">
                    {signedIn ? (
                        <>
                            {/*
                             * THE SIGNED-IN ROW. "Dashboard" and "Pesanan saya" are quiet nav
                             * links, "Tiket saya" and "Keluar" are bordered secondary controls,
                             * and "Buat event" beside them is the ONE primary action — all four
                             * drawn on the shared nav geometry so the row reads as one system
                             * rather than as buttons of four different sizes.
                             *
                             * The Dashboard row's href comes from `signedInNavItems`, i.e. from
                             * the account's platform role. It is NOT a constant.
                             */}
                            <DesktopNavLinks items={navItems} />
                            <SiteSignOut />
                        </>
                    ) : (
                        <Link
                            href="/login"
                            className={cn(
                                HEADER_NAV_VARIANT.outline,
                                "hidden xl:inline-flex"
                            )}
                        >
                            Masuk
                        </Link>
                    )}

                    <Link
                        href={BUAT_EVENT_ITEM.href}
                        className={cn(
                            HEADER_NAV_VARIANT.primary,
                            "hidden xl:inline-flex"
                        )}
                    >
                        {BUAT_EVENT_ITEM.label}
                    </Link>

                    <MobileMenu signedIn={signedIn} navItems={navItems} />
                </div>
            </div>
        </header>
    );
}

/**
 * The mobile menu.
 *
 * `<details>`/`<summary>` rather than a state-driven popover: it is keyboard-accessible and
 * dismissible by default, works before hydration, and keeps the header a server component.
 *
 * The rows are rendered by `MobileMenuLinks`, which is the only client component here, and for
 * one reason: a `<details>` drawer does not close when a Next.js `<Link>` navigates on the
 * client, so tapping any row — Dashboard included — used to leave the open drawer sitting over
 * the page it had just navigated to. That component closes the drawer it is inside; the
 * `<summary>` remains the native toggle, so the keyboard and no-JavaScript behaviour are
 * unchanged.
 *
 * It receives the SAME `navItems` array the desktop row renders, so the drawer and the desktop
 * link cannot disagree about who is offered the back-office entrance or where it points.
 */
function MobileMenu({
    signedIn,
    navItems,
}: {
    signedIn: boolean;
    /** Built once by `SiteHeader` from the session's platform role. */
    navItems: HeaderNavItem[];
}) {
    const items = [
        ...NAV,
        { href: "/events", label: "Semua event" },
        ...(signedIn ? navItems : [{ href: "/login", label: "Masuk" }]),
        BUAT_EVENT_ITEM,
    ];

    return (
        <details className="relative xl:hidden">
            <summary
                className="grid h-10 w-10 cursor-pointer list-none place-items-center rounded-xl border border-ink-200 text-ink-700 transition hover:border-ink-900 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                aria-label="Buka menu navigasi"
            >
                <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="h-5 w-5"
                >
                    <path d="M4 7h16M4 12h16M4 17h16" />
                </svg>
            </summary>

            <div className="absolute right-0 z-50 mt-3 w-64 rounded-xl border border-ink-100 bg-white p-3 shadow-lg shadow-ink-900/10">
                <div className="px-1 pb-3">
                    <SearchBar size="sm" placeholder="Cari event…" />
                </div>

                <MobileMenuLinks items={items}>
                    {signedIn ? (
                        <li>
                            <SiteSignOut variant="menu" />
                        </li>
                    ) : null}
                </MobileMenuLinks>
            </div>
        </details>
    );
}
