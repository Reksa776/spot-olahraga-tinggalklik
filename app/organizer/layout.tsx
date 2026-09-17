import type { ReactNode } from "react";

import { Text } from "@mantine/core";

import DashboardProviders from "@/components/dashboard/DashboardProviders";
import OrganizerShell from "@/components/dashboard/OrganizerShell";
import { AccessDeniedPanel } from "@/components/dashboard/primitives";
import { getOrganizerPageContext } from "@/lib/organizer/context";

import "@mantine/core/styles.css";

/**
 * ==========================================
 * ORGANIZER BACK OFFICE LAYOUT
 * ==========================================
 *
 * The access decision is made HERE, server-side, from the session and the database —
 * never by hiding links. `getOrganizerPageContext` redirects an anonymous visitor to
 * the login page and returns an empty organizer list for an authenticated actor with
 * no readable tenant, which renders the explicit "no access" panel below rather than an
 * empty page that looks like a bug.
 *
 * This is presentation-layer defence-in-depth only. Every mutation still goes through
 * the API, which runs `requireOrganizerAccess` on the real membership rows — so
 * removing this layout would not grant anyone a single extra permission.
 *
 * PHASE MANTINE: the decision above is untouched. What changed is that the chrome is now the
 * shared Mantine `AppShell` (so the organiser back office matches `/admin` and `/platform`
 * instead of being a third hand-rolled header), the "no access" panel is the shared Mantine
 * `AccessDeniedPanel`, and the organiser names the caller can actually read are passed into the
 * shell as context.
 *
 * NOTE for future edits: this is a SERVER component. Mantine's `Button`/`Card`/`Anchor` accept a
 * `component` prop, but a component *reference* cannot cross the server/client boundary — the
 * `AccessDeniedPanel` used below is a client component that builds its own `<Link>` internally for
 * exactly that reason.
 */

export const dynamic = "force-dynamic";

export default async function OrganizerLayout({
    children,
}: {
    children: ReactNode;
}) {
    const context = await getOrganizerPageContext();

    if (context.organizerIds.length === 0) {
        return (
            <DashboardProviders>
                <AccessDeniedPanel
                    title="Belum ada akses organizer"
                    body={
                        <Text size="sm">
                            Akun kamu belum terhubung ke organizer mana pun, sehingga halaman ini
                            tidak menampilkan data apa pun. Hubungi admin platform untuk diberikan
                            akses.
                        </Text>
                    }
                    actionHref="/events"
                    actionLabel="Lihat katalog event"
                />
            </DashboardProviders>
        );
    }

    const organizerLabel = context.organizers.map((organizer) => organizer.name).join(", ");

    return (
        <DashboardProviders>
            <OrganizerShell organizerLabel={organizerLabel}>
                {children}
            </OrganizerShell>
        </DashboardProviders>
    );
}
