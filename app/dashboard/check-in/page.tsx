import { FiCamera } from "react-icons/fi";

import {
    DataTable,
    EmptyBlock,
    PageHeader,
    PrimaryAction,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { listCheckInGateEvents } from "@/lib/dashboard/gates";
import { eventStatusTone } from "@/lib/events/status";
import { getOrganizerPageContext } from "@/lib/organizer/context";

/**
 * "Scan Tiket" hub — pick which open event to admit tickets at.
 *
 * The rows come from `listCheckInGateEvents`, which scopes by the actor's `checkin.scan`
 * tenants AND the canonical `isEventCheckInOpen` predicate — the same two gates the
 * check-in API enforces per request. A `CHECKIN_STAFF` member (who holds no `event.read`)
 * sees exactly the events they are assigned to scan, and nothing else.
 *
 * Every row links to the event-scoped scanner at `/dashboard/events/[id]/check-in`, which
 * itself re-authorizes with `requireEventCheckInAccess` — the menu, the hub and the page
 * cannot widen each other, because each of them independently goes through a server
 * decider.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

export default async function DashboardCheckInHubPage() {
    const context = await getOrganizerPageContext();

    const result = await listCheckInGateEvents(context.scope);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Scan Tiket"
                description="Event yang sedang menerima check-in. Pilih event, lalu pindai QR tiket peserta — atau ketik kodenya secara manual sebagai cadangan."
            />

            <DataTable
                minWidth={760}
                empty={
                    <EmptyBlock
                        icon={<FiCamera size={22} />}
                        title="Tidak ada event yang sedang menerima check-in"
                        description="Pintu masuk terbuka sejak event dipublikasikan hingga 30 menit setelah waktu selesai. Belum ada event yang sedang berada dalam jendela itu."
                        action={
                            <PrimaryAction href="/dashboard/events" variant="outline">
                                Lihat semua event
                            </PrimaryAction>
                        }
                    />
                }
                columns={[
                    { header: "Event" },
                    { header: "Jadwal" },
                    { header: "Status" },
                    { header: "Aksi", align: "right" },
                ]}
                rows={result.items.map((event) => ({
                    key: event.id,
                    cells: [
                        <div className="flex flex-col" key="event">
                            <span className="text-sm font-semibold">
                                {event.title}
                            </span>
                            <span className="font-mono text-xs text-muted-foreground">
                                {event.eventCode} · {event.organizer.name}
                            </span>
                        </div>,
                        <span className="text-sm" key="schedule">
                            {DATE_FORMAT.format(event.startAt)}
                        </span>,
                        <StatusBadge
                            key="status"
                            tone={eventStatusTone(event.status)}
                        >
                            {event.status}
                        </StatusBadge>,
                        <TextLink
                            key="scan"
                            href={`/dashboard/events/${event.id}/check-in`}
                        >
                            Scan
                        </TextLink>,
                    ],
                }))}
            />
        </div>
    );
}