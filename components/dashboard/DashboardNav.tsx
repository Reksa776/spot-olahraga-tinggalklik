"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { useState, type ReactNode } from "react";import {
    AppShell,
    Box,
    Divider,
    NavLink,
    ScrollArea,
    Stack,
    Text,
} from "@mantine/core";
import { FiExternalLink, FiLogOut } from "react-icons/fi";

import Brand from "@/components/Brand";
import { isNavGroupActive, pickActiveNavHref } from "@/lib/ui/dashboard-nav";

/**
 * ==========================================
 * DASHBOARD NAVIGATION
 * ==========================================
 *
 * The sidebar's *contents* — the lockup, the section label, the grouped links and the footer
 * actions — as opposed to `DashboardShell`, which owns the `AppShell` frame around them. The split
 * exists so the admin navigation can live in `components/admin/AdminNavbar.tsx` (where four
 * pre-existing test suites look for it, and where the group definitions belong) while the rendering
 * logic stays in exactly one place.
 *
 * ACTIVE STATE
 * ------------
 * Matching is on the path *and* on the query, and exactly ONE row wins — see
 * `lib/ui/dashboard-nav.ts`, which owns the rule and is tested directly. In short: the Broadcast
 * group's eight entries all point at `/admin/broadcasts` and differ only by `?type=…`, so comparing
 * the path alone would highlight all eight at once, and `/admin` must not stay lit while the user is
 * inside `/admin/products`. Group headers open themselves when one of their children is active,
 * which is what the previous sidebar did too.
 *
 * The footer keeps the two actions the previous sidebar had — "Lihat situs" and "Keluar" — with the
 * same `signOut({ callbackUrl: "/" })` behaviour and the same in-flight label.
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

function isGroup(entry: ShellNavEntry): entry is ShellNavGroup {
    return "items" in entry;
}

export default function DashboardNav({
    nav,
    sectionLabel,
    sectionDescription,
    onNavigate,
}: {
    nav: ShellNavEntry[];
    sectionLabel: string;
    sectionDescription?: string;
    onNavigate?: () => void;
}) {
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const [signingOut, setSigningOut] = useState(false);
    const currentQuery = searchParams.toString();

    // Every destination the caller supplied, flattened. The winner among them is the only row that
    // renders as active, so the sidebar can never claim two current pages at once.
    const allHrefs = nav.flatMap((entry) =>
        isGroup(entry) ? entry.items.map((item) => item.href) : [entry.href]
    );

    const activeHref = pickActiveNavHref(allHrefs, pathname, currentQuery);

    function itemActive(href: string): boolean {
        return href === activeHref;
    }

    function groupActive(group: ShellNavGroup): boolean {
        return isNavGroupActive(
            group.items.map((item) => item.href),
            pathname,
            currentQuery
        );
    }

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
            <AppShell.Section>
                <Box px="xs" py="sm">
                    <Brand />
                </Box>

                <Stack gap={0} px="xs" pb="xs">
                    <Text size="xs" fw={700} tt="uppercase" c="dimmed" style={{ letterSpacing: "0.06em" }}>
                        {sectionLabel}
                    </Text>
                    {sectionDescription ? (
                        <Text size="xs" c="dimmed" lineClamp={2}>
                            {sectionDescription}
                        </Text>
                    ) : null}
                </Stack>

                <Divider my="xs" />
            </AppShell.Section>

            <AppShell.Section grow component={ScrollArea} type="auto" offsetScrollbars>
                <Stack gap={2}>
                    {nav.map((entry) => {
                        if (!isGroup(entry)) {
                            return (
                                <NavLink
                                    key={entry.href}
                                    component={Link}
                                    href={entry.href}
                                    label={entry.label}
                                    leftSection={entry.icon}
                                    active={itemActive(entry.href)}
                                    onClick={onNavigate}
                                    variant="light"
                                    color="brand"
                                />
                            );
                        }

                        return (
                            <NavLink
                                key={entry.label}
                                label={entry.label}
                                leftSection={entry.icon}
                                childrenOffset={28}
                                defaultOpened={groupActive(entry)}
                                variant="light"
                                color="brand"
                            >
                                {entry.items.map((item) => (
                                    <NavLink
                                        key={`${item.href}-${item.label}`}
                                        component={Link}
                                        href={item.href}
                                        label={item.label}
                                        leftSection={item.icon}
                                        active={itemActive(item.href)}
                                        onClick={onNavigate}
                                        color="brand"
                                    />
                                ))}
                            </NavLink>
                        );
                    })}
                </Stack>
            </AppShell.Section>

            <AppShell.Section>
                <Divider my="xs" />

                <NavLink
                    component={Link}
                    href="/"
                    label="Lihat situs"
                    leftSection={<FiExternalLink size={18} />}
                    color="gray"
                />

                <NavLink
                    label={signingOut ? "Keluar…" : "Keluar"}
                    leftSection={<FiLogOut size={18} />}
                    color="red"
                    onClick={handleSignOut}
                    style={{ cursor: "pointer" }}
                />
            </AppShell.Section>
        </>
    );
}
