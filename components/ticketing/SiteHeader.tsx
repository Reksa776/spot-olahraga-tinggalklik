import Link from "next/link";

import { auth } from "@/auth";
import { getApplicationBranding } from "@/lib/app-settings";
import { shouldShowDashboardNav } from "@/lib/dashboard/scope";

import Brand from "./Brand";
import MobileMenuLinks from "./MobileMenuLinks";
import SearchBar from "./SearchBar";
import SiteSignOut from "./SiteSignOut";

const NAV = [
    { href: "/events", label: "Event" },
    { href: "/events#cabang-olahraga", label: "Cabang olahraga" },
];

/**
 * The back office, as ONE definition rendered in two places (desktop link, mobile drawer row).
 *
 * The label and the path live here rather than in each rendering so the two cannot drift and
 * so "exactly one Dashboard destination" is a property of the source, not a promise. It is
 * gated by `shouldShowDashboardNav` — never by this constant alone.
 */
const DASHBOARD_NAV_ITEM = { href: "/dashboard", label: "Dashboard" } as const;

/**
 * The header for the ticketing discovery surface.
 *
 * Why not in `app/layout.tsx`: the retail storefront (`/products`, `/cart`, `/checkout`,
 * `/orders`) is live and renders its own chrome; a global header would double up there. Ticketing
 * pages opt in via `SiteShell`, which is additive by construction.
 *
 * Sole data read is `auth()` — the cookie session, no database round-trip — so the header can sit
 * on every page without adding a query. Anything authoritative (ticket counts, order state) is
 * read by the page that needs it. That is also why the Dashboard item is gated on the session's
 * PLATFORM ROLE rather than on a resolved capability set: the role is already in the session (the
 * D-48 mirror `auth.ts` refreshes from the database), whereas capabilities would mean the `User`
 * row plus every membership and grant, on every public page, for every signed-in visitor. See
 * `shouldShowDashboardNav` for the argument and for the one asymmetry it accepts.
 *
 * DASHBOARD VISIBILITY IS UX ONLY. `/dashboard` is gated server-side by the layout and by every
 * service under it, so an account that is not offered the link is refused exactly as before, and
 * an account that is offered it gains nothing by seeing it.
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
     * One helper decides, for both renderings below. A GUEST has no session at all and a
     * CUSTOMER resolves to `false`; ADMIN, MANAGER and PIC resolve to `true`. The
     * destination is always `DASHBOARD_NAV_ITEM.href`, and nothing here is a security
     * boundary — see the header.
     */
    const showDashboard =
        signedIn && shouldShowDashboardNav(session?.user.platformRole);

    return (
        <header className="sticky top-0 z-40 border-b border-ink-100 bg-white/90 backdrop-blur">
            <div className="mx-auto flex h-16 max-w-7xl items-center gap-6 px-4 sm:px-6 lg:px-8">
                <Brand logoSrc={branding.logoUrl} />

                <nav
                    aria-label="Navigasi utama"
                    className="hidden items-center gap-1 lg:flex"
                >
                    {NAV.map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-600 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                        >
                            {item.label}
                        </Link>
                    ))}
                </nav>

                <div className="hidden flex-1 justify-end md:flex lg:max-w-xl">
                    <SearchBar size="sm" placeholder="Cari event atau olahraga…" />
                </div>

                <div className="ml-auto flex items-center gap-2 md:ml-0">
                    {signedIn ? (
                        <>
                            {/*
                             * DASHBOARD NAVBAR — the back-office entrance for the accounts
                             * that HAVE one (ADMIN / MANAGER / PIC).
                             *
                             * It sits with the other signed-in actions rather than in the
                             * public `NAV` above, because it is not a public link: a visitor
                             * without a session would be sent a link that only bounces to
                             * /login, exactly the reason "Pesanan saya" is here too.
                             *
                             * Styled as the QUIET nav link (the same treatment as "Pesanan
                             * saya") and not as a chip: "Buat event" beside it is the primary
                             * call to action, and a second bordered button would read as a
                             * second one. Recognisable, not competing.
                             */}
                            {showDashboard ? (
                                <Link
                                    href={DASHBOARD_NAV_ITEM.href}
                                    className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-ink-600 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 sm:block"
                                >
                                    {DASHBOARD_NAV_ITEM.label}
                                </Link>
                            ) : null}

                            {/*
                             * PHASE 20B — "Pesanan saya" (the buyer's order history).
                             *
                             * Deliberately NOT added to `NAV` above: that list is rendered for
                             * every visitor and `/ticketing/orders` requires a session, so a
                             * signed-out shopper would be sent a link that only bounces to
                             * /login. It is the storefront's job to invite; a private list
                             * belongs in the signed-in actions, exactly like the wallet beside
                             * it. Rendered as a quiet nav link rather than a second bordered
                             * button so the header keeps ONE primary action per state.
                             */}
                            <Link
                                href="/ticketing/orders"
                                className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-ink-600 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 sm:block"
                            >
                                Pesanan saya
                            </Link>

                            <Link
                                href="/ticketing/tickets"
                                className="hidden rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-800 transition hover:border-ink-900 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 sm:block"
                            >
                                Tiket saya
                            </Link>

                            <SiteSignOut />
                        </>
                    ) : (
                        <Link
                            href="/login"
                            className="hidden rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-800 transition hover:border-ink-900 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 sm:block"
                        >
                            Masuk
                        </Link>
                    )}

                    <Link
                        href="/dashboard/events"
                        className="hidden rounded-xl bg-ink-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 xl:block"
                    >
                        Buat event
                    </Link>

                    <MobileMenu signedIn={signedIn} showDashboard={showDashboard} />
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
 */
function MobileMenu({
    signedIn,
    showDashboard,
}: {
    signedIn: boolean;
    /**
     * The SAME decision the desktop link uses, passed down rather than recomputed: there is one
     * call to `shouldShowDashboardNav` per render, so the two renderings of the item cannot
     * disagree about who is offered it.
     */
    showDashboard: boolean;
}) {
    const items = [
        ...NAV,
        { href: "/events", label: "Semua event" },
        ...(signedIn
            ? [
                  ...(showDashboard ? [DASHBOARD_NAV_ITEM] : []),
                  { href: "/ticketing/orders", label: "Pesanan saya" },
                  { href: "/ticketing/tickets", label: "Tiket saya" },
              ]
            : [{ href: "/login", label: "Masuk" }]),
        { href: "/dashboard/events", label: "Buat event" },
    ];

    return (
        <details className="relative lg:hidden">
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
