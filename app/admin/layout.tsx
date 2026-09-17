import { ReactNode } from "react";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

// The Mantine stylesheet is imported HERE and not at the application root: Next gives each layout
// segment its own CSS, so Mantine's baseline (`body { margin: 0; font-family: … }`) and its
// component styles reach `/admin/**` only. The customer-facing ticketing and retail surfaces keep
// Tailwind's reset untouched — see `components/dashboard/DashboardProviders.tsx`.
import "@mantine/core/styles.css";

import AdminShell from "@/components/dashboard/AdminShell";
import DashboardProviders from "@/components/dashboard/DashboardProviders";

/**
 * The admin layout.
 *
 * The authorization decision below is UNCHANGED and is still made server-side before anything
 * renders — the same `auth()` call, the same two redirects, in the same order. This phase replaced
 * only what is rendered after the gate passes: `AdminNavbar` (hand-rolled Tailwind sidebar) became
 * `AdminShell` (Mantine `AppShell`), and the page wrapper moved into the shell.
 */
export default async function AdminLayout({
    children,
}: {
    children: ReactNode;
}) {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = session.user.role;

    if (role !== "ADMIN") {
        redirect("/products");
    }

    return (
        <DashboardProviders>
            <AdminShell userName={session.user.name} userEmail={session.user.email}>
                {children}
            </AdminShell>
        </DashboardProviders>
    );
}
