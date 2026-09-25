"use client";

import type { ReactNode } from "react";
import {
    Banknote,
    BarChart3,
    CalendarDays,
    CreditCard,
    Image as ImageIcon,
    LayoutDashboard,
    MapPin,
    QrCode,
    Receipt,
    RotateCcw,
    Settings,
    ShieldCheck,
    UserCog,
    Users,
    UsersRound,
    Wrench,
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
    // PHASE 32 — APPLICATION CONTROL. A separate section rather than more rows under
    // "Venue & Pengaturan", because these are the ONE class of destination that separates
    // a system owner from a fully operational operator. A MANAGER's sidebar simply has no
    // such section, which makes the separation legible to the person holding the session as
    // well as enforced by the API.
    "Sistem",
] as const;

/**
 * Builds the sidebar from a capability set. Extracted (pure) so the menu can be pinned in
 * `__tests__/pic-self-service/menu.test.ts`: the PIC rows appear exactly when the flag is true,
 * the generic tenant row appears exactly when it is false, and a role string is never consulted —
 * the only input is the same `DashboardCapabilities` object the layout computed.
 */
export function buildDashboardNav(
    capabilities: DashboardCapabilities
): ShellNavGroup[] {
    const items: NavItem[] = [
        {
            // A pure PIC lives on their own-scope surface; the generic tenant dashboard row
            // belongs to operators (and to a PIC who also holds tenant/platform capability,
            // for whom the flag below stays false). `hasActivePicProfile` is only ever true
            // when the actor was admitted by their ACTIVE PIC profile alone.
            visible: !capabilities.hasActivePicProfile,
            section: "Ringkasan",
            entry: {
                label: "Dashboard",
                href: "/dashboard",
                icon: <LayoutDashboard size={18} />,
            },
        },
        // ── PIC SELF-SERVICE (own-scope, read-only) ───────────────────────────────
        // Each row is an anchor into the single self-service section on `/dashboard/pic`
        // (the same destination an ADMIN/ORGANIZER uses for PIC management — the page picks
        // the body by authority). The menu is a rendering of the capability flag, never a
        // role string, exactly like every other row in this file.
        {
            visible: capabilities.hasActivePicProfile,
            section: "Ringkasan",
            entry: {
                label: "Ringkasan PIC",
                href: "/dashboard/pic",
                icon: <LayoutDashboard size={18} />,
            },
        },
        {
            visible: capabilities.hasActivePicProfile,
            section: "Ringkasan",
            entry: {
                label: "Event Saya",
                href: "/dashboard/pic#events",
                icon: <CalendarDays size={18} />,
            },
        },
        {
            visible: capabilities.hasActivePicProfile,
            section: "Ringkasan",
            entry: {
                label: "Referral",
                href: "/dashboard/pic#referrals",
                icon: <UsersRound size={18} />,
            },
        },
        {
            visible: capabilities.hasActivePicProfile,
            section: "Ringkasan",
            entry: {
                label: "Pendapatan",
                href: "/dashboard/pic#earnings",
                icon: <BarChart3 size={18} />,
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
            visible: capabilities.canCheckIn,
            section: "Event & Tiket",
            entry: {
                label: "Scan Tiket",
                href: "/dashboard/check-in",
                icon: <QrCode size={18} />,
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
            // PIC payout / settlement V1 — one row for the whole lifecycle. The capability
            // is `settlement.prepare` (the same permission the list + detail reads require);
            // the financial FINAL steps additionally demand `settlement.approve` + proof
            // upload, resolved against the row's OWN tenant in the API service.
            visible: capabilities.canManageSettlements,
            section: "Penjualan",
            entry: {
                label: "Pencairan PIC",
                href: "/dashboard/settlements",
                icon: <Banknote size={18} />,
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
        // ── SISTEM (PHASE 32, ADMIN ONLY) ──────────────────────────────────────────
        // The three application-control destinations. Each is gated by ITS OWN capability
        // from the server-computed set, which is itself derived from `decidePlatformPermission`
        // — the same function the endpoints call. A MANAGER therefore sees none of these rows
        // and is denied by every one of the endpoints if they navigate directly; the row and
        // the rule are the same decision rendered twice.
        {
            visible: capabilities.canManageUsers,
            section: "Sistem",
            entry: {
                label: "Pengguna",
                href: "/dashboard/users",
                icon: <UserCog size={18} />,
            },
        },
        {
            visible: capabilities.canManageApplicationSettings,
            section: "Sistem",
            entry: {
                label: "Aplikasi",
                href: "/dashboard/settings/application",
                icon: <ShieldCheck size={18} />,
            },
        },
        {
            visible: capabilities.canManageBranding,
            section: "Sistem",
            entry: {
                label: "Branding",
                href: "/dashboard/settings/branding",
                icon: <ImageIcon size={18} />,
            },
        },
        {
            visible: capabilities.canManageMaintenance,
            section: "Sistem",
            entry: {
                label: "Maintenance",
                href: "/dashboard/settings/maintenance",
                icon: <Wrench size={18} />,
            },
        },
    ];

    const visibleItems = items.filter((item) => item.visible);

    return SECTION_ORDER.map((section) => ({
        label: section,
        items: visibleItems
            .filter((item) => item.section === section)
            .map((item) => item.entry),
    })).filter((section) => section.items.length > 0);
}

export default function DashboardAppShell({
    capabilities,
    contextLabel,
    organizerLabel,
    userName,
    userEmail,
    logoSrc = null,
    children,
}: {
    capabilities: DashboardCapabilities;
    /** e.g. "Admin platform" or "Penyelenggara" — the caller's standing, from the server. */
    contextLabel: string;
    organizerLabel?: string;
    userName?: string | null;
    userEmail?: string | null;
    /** PHASE 32 — configured application logo, resolved server-side by the layout. */
    logoSrc?: string | null;
    children: ReactNode;
}) {
    const nav = buildDashboardNav(capabilities);

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
            logoSrc={logoSrc}
        >
            {children}
        </DashboardShell>
    );
}