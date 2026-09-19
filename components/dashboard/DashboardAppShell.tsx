"use client";

import type { ReactNode } from "react";
import {
    BarChart3,
    CalendarDays,
    CreditCard,
    LayoutDashboard,
    MapPin,
    Receipt,
    RotateCcw,
    Settings,
    Users,
    UsersRound,
} from "lucide-react";

import type { DashboardCapabilities } from "@/lib/dashboard/scope";

import DashboardShell, {
    type ShellNavGroup,
    type ShellNavItem,
} from "./DashboardShell";

/**
 * ==========================================
 * DASHBOARD APP SHELL — ONE MENU, MANY CAPABILITIES
 * ==========================================
 *
 * This is the ONLY back-office navigation in the product. Platform administration and
 * organizer operations are not two dashboards that happen to look alike; they are one
 * dashboard whose menu is a function of the permissions the caller actually holds.
 *
 * ── HOW THE MENU IS DECLARED ────────────────────────────────────────────────
 * Every destination is a flat row carrying a `visible` boolean and the name of the
 * section it belongs to. The rows are filtered once (`visible`) and then folded into
 * `SECTION_ORDER`'s labelled groups, so a destination can never be shown in the wrong
 * section, an empty section never renders, and no capability is consulted twice in two
 * arrays that could disagree. The filter keeps the same shape the access tests pin:
 * the menu is built from capability booleans, never from a role string.
 *
 * ── THE MENU IS NOT THE ACCESS CONTROL ────────────────────────────────────────
 * Every boolean below comes from the server layout, which computed it with the same
 * `decidePlatformPermission` / `decideOrganizerPermission` functions the services and API
 * guards use. Hiding a row is a UX courtesy with a real backend behind it: if a caller
 * forged their way to `/dashboard/orders`, `listDashboardOrders` would resolve their
 * readable organizers to an empty set and the page would render an empty state — it would
 * not reveal another tenant's orders. The menu and the services cannot disagree, because
 * both read the same map.
 *
 * ── WHY ONE COMPONENT AND NOT TWO ────────────────────────────────────────────
 * The previous revision had a `PlatformShell` and an `OrganizerShell`, each building its
 * own array. Two arrays is how a section drifts: one gains a destination the other never
 * hears about, and the permission that gates it ends up existing in only one place. Here
 * the destinations are declared once and gated by the capability that owns them.
 */

type NavItem = {
    /** The capability that must hold for the row to exist at all. */
    visible: boolean;
    /** Which labelled section the row renders under. Order comes from `SECTION_ORDER`. */
    section: string;
    entry: ShellNavItem;
};

/**
 * The order of the sidebar's sections — declared once so the menu reads as a designed
 * structure rather than as the incidental order of the rows below.
 */
const SECTION_ORDER = [
    "Ringkasan",
    "Event & Tiket",
    "Penjualan",
    "Orang",
    "Laporan",
    "Venue & Pengaturan",
] as const;

export default function DashboardAppShell({
    capabilities,
    contextLabel,
    organizerLabel,
    userName,
    userEmail,
    children,
}: {
    capabilities: DashboardCapabilities;
    /** e.g. "Admin platform" or "Penyelenggara" — the caller's standing, from the server. */
    contextLabel: string;
    organizerLabel?: string;
    userName?: string | null;
    userEmail?: string | null;
    children: ReactNode;
}) {
    const items: NavItem[] = [
        {
            visible: true,
            section: "Ringkasan",
            entry: {
                label: "Dashboard",
                href: "/dashboard",
                icon: <LayoutDashboard size={18} />,
            },
        },
        {
            visible: capabilities.canReadEvents,
            section: "Event & Tiket",
            entry: {
                label: "Event",
                href: "/dashboard/events",
                icon: <CalendarDays size={18} />,
            },
        },
        {
            visible: capabilities.canReadOrders,
            section: "Penjualan",
            entry: {
                label: "Pesanan",
                href: "/dashboard/orders",
                icon: <Receipt size={18} />,
            },
        },
        {
            visible: capabilities.canReadOrders,
            section: "Penjualan",
            entry: {
                label: "Pelanggan",
                href: "/dashboard/customers",
                icon: <Users size={18} />,
            },
        },
        {
            visible: capabilities.canReadPayments,
            section: "Penjualan",
            entry: {
                label: "Pembayaran",
                href: "/dashboard/payments",
                icon: <CreditCard size={18} />,
            },
        },
        {
            visible: capabilities.canReadOrders,
            section: "Penjualan",
            entry: {
                label: "Refund",
                href: "/dashboard/refunds",
                icon: <RotateCcw size={18} />,
            },
        },
        {
            visible:
                capabilities.canAssignPic || capabilities.canManagePlatformPic,
            section: "Orang",
            entry: {
                label: "PIC",
                href: "/dashboard/pic",
                icon: <UsersRound size={18} />,
            },
        },
        {
            visible: capabilities.canReadReports,
            section: "Laporan",
            entry: {
                label: "Laporan",
                href: "/dashboard/reports",
                icon: <BarChart3 size={18} />,
            },
        },
        {
            visible: capabilities.canManageVenues,
            section: "Venue & Pengaturan",
            entry: {
                label: "Venue",
                href: "/dashboard/venues",
                icon: <MapPin size={18} />,
            },
        },
        {
            visible:
                capabilities.canManageSports ||
                capabilities.canManageGlobalVenues ||
                capabilities.canManageVenues,
            section: "Venue & Pengaturan",
            entry: {
                label: "Pengaturan",
                href: "/dashboard/settings",
                icon: <Settings size={18} />,
            },
        },
    ];

    const visibleItems = items.filter((item) => item.visible);

    const nav: ShellNavGroup[] = SECTION_ORDER.map((section) => ({
        label: section,
        items: visibleItems
            .filter((item) => item.section === section)
            .map((item) => item.entry),
    })).filter((section) => section.items.length > 0);

    const description = organizerLabel
        ? `${contextLabel} · ${organizerLabel}`
        : contextLabel;

    return (
        <DashboardShell
            nav={nav}
            sectionLabel="Dashboard"
            sectionDescription={description}
            userName={userName}
            userEmail={userEmail}
        >
            {children}
        </DashboardShell>
    );
}