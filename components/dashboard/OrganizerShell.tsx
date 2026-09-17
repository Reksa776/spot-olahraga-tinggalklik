"use client";

import type { ReactNode } from "react";
import { FiCalendar, FiMapPin } from "react-icons/fi";

import DashboardShell, { type ShellNavEntry } from "./DashboardShell";

/**
 * The `/organizer` back-office navigation.
 *
 * Unchanged from the inline header it replaces: Event and Venue. The organiser names the caller
 * actually has access to are passed in as the sidebar context line — the layout already resolved
 * them through `getOrganizerPageContext`, so this component displays authority rather than
 * deciding it.
 */
const ORGANIZER_NAV: ShellNavEntry[] = [
    { label: "Event", href: "/organizer/events", icon: <FiCalendar size={18} /> },
    { label: "Venue", href: "/organizer/venues", icon: <FiMapPin size={18} /> },
];

export default function OrganizerShell({
    organizerLabel,
    userName,
    userEmail,
    children,
}: {
    /** The organiser(s) this caller belongs to, resolved server-side by the layout. */
    organizerLabel?: string;
    userName?: string | null;
    userEmail?: string | null;
    children: ReactNode;
}) {
    return (
        <DashboardShell
            nav={ORGANIZER_NAV}
            sectionLabel="Penyelenggara"
            sectionDescription={organizerLabel}
            userName={userName}
            userEmail={userEmail}
        >
            {children}
        </DashboardShell>
    );
}
