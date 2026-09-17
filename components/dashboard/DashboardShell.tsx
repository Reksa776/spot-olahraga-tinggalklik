"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useState, type ReactNode } from "react";
import {
    AppShell,
    Avatar,
    Badge,
    Box,
    Burger,
    Group,
    Menu,
    Text,
    UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import {
    FiChevronDown,
    FiExternalLink,
    FiLogOut,
    FiUser,
} from "react-icons/fi";

import Brand from "@/components/Brand";
import DashboardNav, { type ShellNavEntry } from "./DashboardNav";

/**
 * ==========================================
 * DASHBOARD SHELL
 * ==========================================
 *
 * The `AppShell` frame for every back-office surface (`/admin`, `/organizer`, `/platform`),
 * replacing three hand-rolled layouts that each re-implemented a sidebar, a mobile top bar and a
 * mobile overlay. Behaviourally it is a superset of what it replaced:
 *
 *   • the same destinations, including the query-differentiated Broadcast entries;
 *   • the same grouping and labels the previous sidebar used, so nobody has to relearn the menu;
 *   • the same logout semantics (`signOut` with a `/` callback, exactly as before);
 *   • plus a real active state, a collapsible group that opens itself when a child is active, a
 *     burger-driven mobile navbar, and an accessible user menu.
 *
 * The sidebar itself lives in `DashboardNav`, because the admin navigation definitions belong in
 * `components/admin/AdminNavbar.tsx` while the *rendering* of a navigation should exist once.
 *
 * AUTHORITY IS AN INPUT, NOT A DECISION
 * ------------------------------------
 * This component never decides who sees what. Callers pass the navigation they are allowed to
 * render — `PlatformShell` is handed two booleans the server layout computed from the permission
 * map, and `AdminShell` is only reachable behind the existing `role === "ADMIN"` gate. The shell
 * renders what it is given and nothing else: no menu item exists here that a caller cannot withhold.
 */

export default function DashboardShell({
    nav,
    sectionLabel,
    sectionDescription,
    userName,
    userEmail,
    children,
}: {
    nav: ShellNavEntry[];
    /** Short chip beside the brand, e.g. "Admin", "Platform", "Penyelenggara". */
    sectionLabel: string;
    /** Contextual line under the brand in the sidebar, e.g. the organiser name. */
    sectionDescription?: string;
    userName?: string | null;
    userEmail?: string | null;
    children: ReactNode;
}) {
    const pathname = usePathname();
    const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
    const [signingOut, setSigningOut] = useState(false);

    // The path is read on every navigation, so a collapsed mobile navbar closes itself instead of
    // covering the page the user just asked for.
    useEffect(() => {
        closeNav();
    }, [pathname, closeNav]);

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
        <AppShell
            header={{ height: 60 }}
            navbar={{ width: 272, breakpoint: "md", collapsed: { mobile: !navOpened } }}
            padding="lg"
            styles={{
                main: { backgroundColor: "var(--mantine-color-gray-0)", minHeight: "100vh" },
            }}
        >
            <AppShell.Header>
                <Group h="100%" px="md" justify="space-between" wrap="nowrap">
                    <Group gap="sm" wrap="nowrap">
                        <Burger
                            opened={navOpened}
                            onClick={toggleNav}
                            hiddenFrom="md"
                            size="sm"
                            aria-label="Buka menu"
                        />

                        <Box hiddenFrom="md">
                            <Brand />
                        </Box>

                        <Badge variant="light" color="brand" size="lg" radius="sm" visibleFrom="md">
                            {sectionLabel}
                        </Badge>
                    </Group>

                    <Group gap="xs" wrap="nowrap">
                        <Menu position="bottom-end" withArrow shadow="md" width={240}>
                            <Menu.Target>
                                <UnstyledButton
                                    aria-label="Menu akun"
                                    style={{ borderRadius: 8 }}
                                    px="xs"
                                    py={6}
                                >
                                    <Group gap="sm" wrap="nowrap">
                                        <Avatar color="brand" variant="light" radius="xl" size="md">
                                            {initials}
                                        </Avatar>

                                        <Box visibleFrom="sm" style={{ textAlign: "left" }}>
                                            <Text size="sm" fw={600} lineClamp={1} maw={170}>
                                                {userName ?? "Akun"}
                                            </Text>
                                            {userEmail ? (
                                                <Text size="xs" c="dimmed" lineClamp={1} maw={170}>
                                                    {userEmail}
                                                </Text>
                                            ) : null}
                                        </Box>

                                        <FiChevronDown size={14} />
                                    </Group>
                                </UnstyledButton>
                            </Menu.Target>

                            <Menu.Dropdown>
                                <Menu.Label>Akun</Menu.Label>

                                <Menu.Item
                                    leftSection={<FiUser size={15} />}
                                    component={Link}
                                    href="/profile"
                                >
                                    Profil saya
                                </Menu.Item>

                                <Menu.Item
                                    leftSection={<FiExternalLink size={15} />}
                                    component={Link}
                                    href="/"
                                >
                                    Lihat situs
                                </Menu.Item>

                                <Menu.Divider />

                                <Menu.Item
                                    color="red"
                                    leftSection={<FiLogOut size={15} />}
                                    onClick={handleSignOut}
                                    disabled={signingOut}
                                >
                                    {signingOut ? "Keluar…" : "Keluar"}
                                </Menu.Item>
                            </Menu.Dropdown>
                        </Menu>
                    </Group>
                </Group>
            </AppShell.Header>

            <AppShell.Navbar p="sm">
                <DashboardNav
                    nav={nav}
                    sectionLabel={sectionLabel}
                    sectionDescription={sectionDescription}
                    onNavigate={closeNav}
                />
            </AppShell.Navbar>

            <AppShell.Main>
                <Box maw={1400} mx="auto">
                    {children}
                </Box>
            </AppShell.Main>
        </AppShell>
    );
}

export type { ShellNavEntry };
