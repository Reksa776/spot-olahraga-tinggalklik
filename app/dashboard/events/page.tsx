import { FiCalendar, FiPlus } from "react-icons/fi";

import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    PrimaryAction,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { listOrganizerEvents } from "@/lib/events/service";
import { getOrganizerPageContext } from "@/lib/organizer/context";

/**
 * Event & ticket list.
 *
 * Delegates to `listOrganizerEvents`, which scopes the query to the organizers the actor
 * can actually read (`readableOrganizerIds`). A platform admin without a membership sees
 * no events — the authorization model gives no role tenant access without one — and the
 * empty state below says so rather than rendering another tenant's rows.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const STATUS_TONE: Record<string, Tone> = {
    DRAFT: "neutral",
    PUBLISHED: "success",
    CANCELLED: "error",
    COMPLETED: "info",
    ARCHIVED: "neutral",
};

export default async function DashboardEventsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; page?: string }>;
}) {
    const params = await searchParams;
    const context = await getOrganizerPageContext();

    const result = await listOrganizerEvents(context.scope, {
        organizerId: context.currentOrganizerId,
        status: (params.status as never) ?? null,
        page: params.page ? Number(params.page) : 1,
        limit: 20,
    });

    const page = params.page ? Number(params.page) : 1;
    const totalPages = Math.ceil(result.pagination.total / 20);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Event & tiket"
                description="Event milik organizer yang bisa kamu akses. Dari sini kamu mengelola jenis tiket, kuota, harga, jendela penjualan, dan publikasi ke katalog publik."
                actions={
                    <PrimaryAction href="/dashboard/events/new">
                        <FiPlus aria-hidden />
                        Event baru
                    </PrimaryAction>
                }
            />

            <DataTable
                minWidth={860}
                empty={
                    <EmptyBlock
                        icon={<FiCalendar size={22} />}
                        title="Belum ada event"
                        description="Buat draft event pertama, lalu publikasikan setelah jenis tiket tersedia."
                        action={
                            <PrimaryAction href="/dashboard/events/new">
                                Event baru
                            </PrimaryAction>
                        }
                    />
                }
                columns={[
                    { header: "Event" },
                    { header: "Jadwal" },
                    { header: "Status" },
                    { header: "Jenis tiket", align: "right" },
                    { header: "Aksi", align: "right" },
                ]}
                rows={result.items.map((event) => ({
                    key: event.id,
                    cells: [
                        <div className="flex flex-col" key="event">
                            <span className="text-sm font-semibold">{event.title}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                                {event.eventCode} · /e/{event.slug}
                            </span>
                        </div>,
                        <span className="text-sm" key="schedule">
                            {DATE_FORMAT.format(event.startAt)}
                        </span>,
                        <StatusBadge key="status" tone={STATUS_TONE[event.status] ?? "neutral"}>
                            {event.status}
                        </StatusBadge>,
                        <span className="text-sm tabular-nums" key="types">
                            {event._count.ticketTypes}
                        </span>,
                        <TextLink key="manage" href={`/dashboard/events/${event.id}`}>
                            Kelola
                        </TextLink>,
                    ],
                }))}
                footer={
                    <LinkPagination
                        page={page}
                        totalPages={totalPages}
                        basePath="/dashboard/events"
                        query={{ status: params.status }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
