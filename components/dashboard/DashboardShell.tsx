"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, LogOut, Ticket } from "lucide-react";

import Brand from "@/components/Brand";
import { Avatar, AvatarFallback } from "@/components/dashboard/ui/misc";
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
    Sidebar,
    SidebarProvider,
    SidebarTrigger,
    useSidebar,
} from "@/components/dashboard/ui/sidebar";
import { ThemeQuickToggle, ThemeSettingsMenu } from "./theme/theme-switcher";
import DashboardNav, {
    type ShellNavEntry,
    type ShellNavGroup,
    type ShellNavItem,
} from "./DashboardNav";

export type { ShellNavEntry, ShellNavGroup, ShellNavItem };

/**
 * ==========================================
 * DASHBOARD SHELL
 * ==========================================
 *
 * The frame for every back-office surface (`/admin`, `/organizer`, `/platform`), shared by all
 * three so the sections cannot drift apart:
 *
 *   SIDEBAR   `components/dashboard/ui/sidebar.tsx` — persistent rail from `md` up, drawer below it
 *   TOPBAR    below — page context, theme controls, account menu
 *   CONTENT   one capped, consistently padded canvas
 *
 * WHAT CHANGED IN THE SHADCN REWRITE
 * ----------------------------------
 * The shell used to be a Mantine `AppShell`. It is now plain Tailwind over the shared sidebar
 * primitives, and three things are new:
 *
 *   1. **A real top bar.** Left: the mobile navigation trigger and a two-line page context — the
 *      section ("Admin") above the current destination ("Produk"). The destination label is read
 *      from the caller's own navigation, so the bar can never claim the user is somewhere the menu
 *      does not offer; there is no separate route-title table to fall out of date. Right: the theme
 *      controls (light/dark, accent colour, chart palette) and the account menu. No notification
 *      bell and no search box exist, because neither has a backend to read from.
 *   2. **A capped content canvas.** The page content is padded once and stops growing at 1440px, so
 *      a form cannot stretch across an ultrawide monitor and every page starts at the same optical
 *      margin.
 *   3. **No footer.** The root element carries `data-dashboard-shell`, which is what
 *      `app/globals.css` uses to suppress the rest of the chrome for back-office routes.
 *
 * AUTHORITY IS AN INPUT, NOT A DECISION
 * ------------------------------------
 * This component never decides who sees what. The caller passes the navigation it is allowed to
 * render — `DashboardAppShell` builds it from capability booleans that `app/dashboard/layout.tsx`
 * computed with the real permission deciders. The shell renders what it is given and nothing else:
 * no menu item exists here that a caller cannot withhold.
 */

/** The label of the destination the user is currently on, or `null` if none matches. */
function findActiveLabel(nav: ShellNavGroup[], pathname: string): string | null {
    const candidates = nav.flatMap((group) =>
        group.items.map((item) => ({
            href: item.href.split("?")[0],
            label: item.label,
        }))
    );

    // Deepest matching path wins, and an exact match beats a prefix: the same rule the sidebar uses
    // for its highlight, expressed for labels rather than for hrefs.
    const matches = candidates
        .filter(
            (candidate) =>
                pathname === candidate.href || pathname.startsWith(`${candidate.href}/`)
        )
        .sort((a, b) => b.href.length - a.href.length);

    return matches[0]?.label ?? null;
}

type DashboardShellProps = {
    nav: ShellNavGroup[];
    /** Short chip beside the brand, e.g. "Admin", "Platform", "Penyelenggara". */
    sectionLabel: string;
    /** Contextual line under the brand in the sidebar, e.g. the organiser name. */
    sectionDescription?: string;
    userName?: string | null;
    userEmail?: string | null;
    /**
     * PHASE 32 — the ADMIN-configured application logo URL, or `null` for the built-in mark.
     *
     * Passed in rather than fetched: this is a client component, so it cannot read the
     * database, and the layout has already resolved the value server-side. The SAME value
     * reaches the desktop sidebar and the mobile top bar, so there is one logo and one
     * source of truth across the whole back office.
     */
    logoSrc?: string | null;
    children: ReactNode;
};

/**
 * The shell's public entry point: it mounts the sidebar context and renders the frame.
 *
 * The provider has to be INSIDE the shell (rather than at the layout) because the mobile drawer,
 * the collapsed rail and the navigation all read the same context, and the layouts are server
 * components that cannot create it.
 */
export default function DashboardShell(props: DashboardShellProps) {
    return (
        <SidebarProvider>
            <DashboardShellFrame {...props} />
        </SidebarProvider>
    );
}

function DashboardShellFrame({
    nav,
    sectionLabel,
    sectionDescription,
    userName,
    userEmail,
    logoSrc = null,
    children,
}: DashboardShellProps) {
    const pathname = usePathname();
    const { setMobileOpen } = useSidebar();

    // A collapsed mobile drawer closes itself on navigation instead of covering the page the user
    // just asked for.
    useEffect(() => {
        setMobileOpen(false);
    }, [pathname, setMobileOpen]);

    const initials = (userName ?? userEmail ?? "?")
        .split(" ")
        .map((part) => part[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase();

    const activeLabel = findActiveLabel(nav, pathname) ?? sectionLabel;

    const [signingOut, setSigningOut] = useState(false);

    async function handleSignOut() {
        try {
            setSigningOut(true);
            await signOut({ callbackUrl: "/" });
        } finally {
            setSigningOut(false);
        }
    }

    return (
        <div
            data-dashboard-shell
            className="flex min-h-screen w-full bg-background text-foreground"
        >
            <DashboardNavSlot
                nav={nav}
                sectionLabel={sectionLabel}
                sectionDescription={sectionDescription}
                userName={userName}
                userEmail={userEmail}
                logoSrc={logoSrc}
            />

            <div className="flex min-w-0 flex-1 flex-col">
                {/* ── TOP BAR ──────────────────────────────────────────────────────── */}
                <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur sm:px-6">
                    <SidebarTrigger />

                    <div className="md:hidden">
                        <Brand logoSrc={logoSrc} />
                    </div>

                    {/* Page context: where the user is, stated from the navigation they were given. */}
                    <div className="flex min-w-0 flex-col">
                        <span className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">
                            {sectionLabel}
                        </span>
                        <span className="truncate text-sm font-semibold leading-tight">
                            {activeLabel}
                        </span>
                    </div>

                    <div className="ml-auto flex items-center gap-1">
                        <ThemeQuickToggle />

                        <ThemeSettingsMenu />

                        <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            className="hidden text-muted-foreground hover:text-foreground sm:inline-flex"
                        >
                            <Link href="/">
                                <ExternalLink />
                                Lihat situs
                            </Link>
                        </Button>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    aria-label="Menu akun"
                                    className="flex items-center gap-2 rounded-field p-1 pr-2 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                    <Avatar>
                                        <AvatarFallback>{initials}</AvatarFallback>
                                    </Avatar>

                                    <span className="hidden flex-col items-start sm:flex">
                                        <span className="max-w-[10rem] truncate text-[0.8125rem] font-semibold leading-tight">
                                            {userName ?? "Akun"}
                                        </span>
                                        {userEmail ? (
                                            <span className="max-w-[10rem] truncate text-[0.6875rem] leading-tight text-muted-foreground">
                                                {userEmail}
                                            </span>
                                        ) : null}
                                    </span>
                                </button>
                            </DropdownMenuTrigger>

                            <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Akun</DropdownMenuLabel>

                                <DropdownMenuItem asChild>
                                    <Link href="/ticketing/tickets">
                                        <Ticket />
                                        Tiket saya
                                    </Link>
                                </DropdownMenuItem>

                                <DropdownMenuItem asChild>
                                    <Link href="/">
                                        <ExternalLink />
                                        Lihat situs
                                    </Link>
                                </DropdownMenuItem>

                                <DropdownMenuSeparator />

                                <DropdownMenuItem
                                    variant="destructive"
                                    disabled={signingOut}
                                    onSelect={(event) => {
                                        event.preventDefault();
                                        void handleSignOut();
                                    }}
                                >
                                    <LogOut />
                                    {signingOut ? "Keluar…" : "Keluar"}
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                </header>

                {/* ── CONTENT ──────────────────────────────────────────────────────── */}
                <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">
                    <div className="mx-auto w-full max-w-[1440px]">{children}</div>
                </main>
            </div>
        </div>
    );
}

/** The sidebar column. Split out so the shell body stays readable. */
function DashboardNavSlot({
    nav,
    sectionLabel,
    sectionDescription,
    userName,
    userEmail,
    logoSrc,
}: {
    nav: ShellNavGroup[];
    sectionLabel: string;
    sectionDescription?: string;
    userName?: string | null;
    userEmail?: string | null;
    logoSrc?: string | null;
}) {
    const { setMobileOpen } = useSidebar();

    return (
        <Sidebar>
            <DashboardNav
                nav={nav}
                sectionLabel={sectionLabel}
                sectionDescription={sectionDescription}
                userName={userName}
                userEmail={userEmail}
                logoSrc={logoSrc}
                onNavigate={() => setMobileOpen(false)}
            />
        </Sidebar>
    );
}

export { SidebarProvider };
export type { DashboardShellProps };
