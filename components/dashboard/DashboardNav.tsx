"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState, type ReactNode } from "react";
import { ExternalLink, LogOut } from "lucide-react";

import Brand from "@/components/Brand";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback } from "@/components/dashboard/ui/misc";
import {
    SidebarContent,
    SidebarFooter,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuLabel,
    SidebarCollapseToggle,
    useSidebar,
} from "@/components/dashboard/ui/sidebar";
import { isNavGroupActive, pickActiveNavHref } from "@/lib/ui/dashboard-nav";

/**
 * ==========================================
 * DASHBOARD NAVIGATION
 * ==========================================
 *
 * The sidebar's *contents* — the lockup, the section label, the grouped destinations and the
 * footer actions — as opposed to `DashboardShell`, which owns the frame around them. The split
 * exists so `DashboardAppShell` can declare the destinations while the rendering logic stays in
 * exactly one place.
 *
 * SECTIONS, NOT ACCORDIONS
 * ------------------------
 * Every top-level entry is a labelled section whose children render flat underneath it. None of
 * the sections collapse: a destination buried behind a chevron is a destination forgotten, and
 * this menu is small enough that every row can stay visible. A section whose label lights up
 * when one of its children is the active page, and exactly ONE row is highlighted at a time.
 *
 * ACTIVE STATE
 * ------------
 * Matching is on the path *and* on the query, and exactly ONE row wins — see
 * `lib/ui/dashboard-nav.ts`, which owns the rule and is tested directly. A parent stay unlit
 * while the user is inside a child, and a child keeps its light on its own sub-pages.
 *
 * SHADCN REWRITE
 * --------------
 * This file renders through `components/dashboard/ui/sidebar.tsx`. Every behaviour is preserved:
 * the same single-highlight rule, the same close-on-select `onNavigate`, the same logout
 * semantics, and the same collapsible desktop rail and mobile drawer. What changed is the
 * surface: a deep-navy band with a brand-coloured active row, labelled sections instead of a
 * flat list, and an identity block in the footer so the rail reads as one composed surface.
 *
 * WHY THE LOCKUP IS STILL THE TAILWIND `Brand`
 * -------------------------------------------
 * There is exactly ONE brand lockup in this product (`components/Brand.tsx`, asserted by
 * `identity-consolidation.test.ts`), and it already has a dark tone — it was written for the dark
 * footer band. The sidebar renders that same component in its light tone rather than re-drawing the
 * mark in shadcn classes, which is how the dashboard redesign avoids launching a second logo.
 */

export type ShellNavItem = {
    label: string;
    href: string;
    icon?: ReactNode;
};

export type ShellNavGroup = {
    label: string;
    icon?: ReactNode;
    items: ShellNavItem[];
};

export type ShellNavEntry = ShellNavItem | ShellNavGroup;

export default function DashboardNav({
    nav,
    sectionLabel,
    sectionDescription,
    userName,
    userEmail,
    logoSrc = null,
    onNavigate,
}: {
    nav: ShellNavGroup[];
    sectionLabel: string;
    sectionDescription?: string;
    userName?: string | null;
    userEmail?: string | null;
    /** PHASE 32 — configured application logo, resolved server-side. */
    logoSrc?: string | null;
    onNavigate?: () => void;
}) {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [signingOut, setSigningOut] = useState(false);
    const currentQuery = searchParams.toString();
    const { collapsed } = useSidebar();

    // Every destination the caller supplied, flattened. The winner among them is the only row that
    // renders as active, so the sidebar can never claim two current pages at once.
    const allHrefs = nav.flatMap((group) =>
        group.items.map((item) => item.href)
    );

    const activeHref = pickActiveNavHref(allHrefs, pathname, currentQuery);

    function itemActive(href: string): boolean {
        return href === activeHref;
    }

    function sectionActive(group: ShellNavGroup): boolean {
        return isNavGroupActive(
            group.items.map((item) => item.href),
            pathname,
            currentQuery
        );
    }

    const initials = (userName ?? userEmail ?? "?")
        .split(" ")
        .map((part) => part[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("")
        .toUpperCase();

    async function handleSignOut() {
        try {
            setSigningOut(true);
            await signOut({ callbackUrl: "/" });
        } finally {
            setSigningOut(false);
        }
    }

    return (
        <>
            {/* ── LOCKUP + SECTION CONTEXT ───────────────────────────────────────── */}
            <SidebarHeader>
                <div className={cn("min-w-0 flex-1", collapsed && "md:hidden")}>
                    {/* The lockup is a link to `/` (see `components/Brand.tsx`), so clicking the
                        dashboard logo returns to the public landing page — the behaviour the brief
                        asks for, and normal internal navigation rather than a `window.location`. */}
                    <Brand tone="light" logoSrc={logoSrc} />

                    <div className="mt-2.5 flex flex-col gap-1">
                        <span className="w-fit rounded-full bg-sidebar-accent px-2 py-0.5 text-[0.6875rem] font-bold uppercase tracking-wider text-sidebar-accent-foreground">
                            {sectionLabel}
                        </span>

                        {sectionDescription ? (
                            <span className="line-clamp-2 text-[0.6875rem] leading-relaxed text-sidebar-foreground/55">
                                {sectionDescription}
                            </span>
                        ) : null}
                    </div>
                </div>

                <SidebarCollapseToggle />
            </SidebarHeader>

            {/* ── DESTINATIONS, BY LABELLED SECTION ──────────────────────────────── */}
            <SidebarContent>
                {nav.map((group) => (
                    <section
                        key={group.label}
                        className="flex min-w-0 flex-col gap-0.5"
                    >
                        <SidebarGroupLabel
                            className={cn(
                                sectionActive(group) &&
                                    "text-sidebar-foreground"
                            )}
                        >
                            {group.label}
                        </SidebarGroupLabel>

                        <SidebarMenu>
                            {group.items.map((entry) => (
                                <SidebarMenuItem key={entry.href}>
                                    <SidebarMenuButton
                                        asChild
                                        isActive={itemActive(entry.href)}
                                        tooltip={entry.label}
                                    >
                                        <Link href={entry.href} onClick={onNavigate}>
                                            {entry.icon}
                                            <SidebarMenuLabel>
                                                {entry.label}
                                            </SidebarMenuLabel>
                                        </Link>
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </section>
                ))}
            </SidebarContent>

            {/* ── FOOTER: WHO IS SIGNED IN, THEN THE EXIT ACTIONS ───────────────── */}
            <SidebarFooter>
                <div
                    className={cn(
                        "flex items-center gap-3 px-2 py-1.5",
                        collapsed && "md:hidden"
                    )}
                >
                    <Avatar className="size-9 shrink-0">
                        <AvatarFallback className="border border-sidebar-border bg-sidebar-accent text-sidebar-accent-foreground">
                            {initials}
                        </AvatarFallback>
                    </Avatar>

                    <div className="min-w-0 flex-1">
                        <p className="truncate text-[0.8125rem] font-semibold leading-tight text-sidebar-foreground">
                            {userName ?? "Akun"}
                        </p>
                        <p className="truncate text-[0.6875rem] leading-tight text-sidebar-foreground/55">
                            {userEmail ?? "Masuk sebagai operator"}
                        </p>
                    </div>
                </div>

                <SidebarMenuButton asChild tooltip="Lihat situs">
                    <Link href="/">
                        <ExternalLink className="size-[18px] shrink-0" />
                        <SidebarMenuLabel>Lihat situs</SidebarMenuLabel>
                    </Link>
                </SidebarMenuButton>

                {/* The sign-out row keeps its own hover tone — a red wash rather than the neutral
                    white one — so a destructive action is never mistaken for a destination. Its
                    `signOut` call and in-flight label are unchanged. */}
                <SidebarMenuButton
                    tooltip={signingOut ? "Keluar…" : "Keluar"}
                    onClick={handleSignOut}
                    disabled={signingOut}
                    className="hover:bg-red-500/15 hover:text-red-200"
                >
                    <LogOut className="size-[18px] shrink-0" />
                    <SidebarMenuLabel>{signingOut ? "Keluar…" : "Keluar"}</SidebarMenuLabel>
                </SidebarMenuButton>
            </SidebarFooter>
        </>
    );
}