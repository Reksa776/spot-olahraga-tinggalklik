import Link from "next/link";

import { auth } from "@/auth";
import { getApplicationBranding } from "@/lib/app-settings";

import Brand from "./Brand";
import SearchBar from "./SearchBar";
import SiteSignOut from "./SiteSignOut";

const NAV = [
    { href: "/events", label: "Event" },
    { href: "/events#cabang-olahraga", label: "Cabang olahraga" },
];

/**
 * The header for the ticketing discovery surface.
 *
 * Why not in `app/layout.tsx`: the retail storefront (`/products`, `/cart`, `/checkout`,
 * `/orders`) is live and renders its own chrome; a global header would double up there. Ticketing
 * pages opt in via `SiteShell`, which is additive by construction.
 *
 * Sole data read is `auth()` — the cookie session, no database round-trip — so the header can sit
 * on every page without adding a query. Anything authoritative (ticket counts, order state) is
 * read by the page that needs it.
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

                    <MobileMenu signedIn={signedIn} />
                </div>
            </div>
        </header>
    );
}

/**
 * The mobile menu.
 *
 * `<details>`/`<summary>` rather than a state-driven popover: it is keyboard-accessible and
 * dismissible by default, works before hydration, and keeps the header a server component. The
 * only compromise is that it does not close on navigation — acceptable for a full page load.
 */
function MobileMenu({ signedIn }: { signedIn: boolean }) {
    const items = [
        ...NAV,
        { href: "/events", label: "Semua event" },
        ...(signedIn
            ? [
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
                <ul className="space-y-1">
                    {items.map((item) => (
                        <li key={`${item.href}-${item.label}`}>
                            <Link
                                href={item.href}
                                className="block rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                            >
                                {item.label}
                            </Link>
                        </li>
                    ))}

                    {signedIn ? (
                        <li>
                            <SiteSignOut variant="menu" />
                        </li>
                    ) : null}
                </ul>
            </div>
        </details>
    );
}
