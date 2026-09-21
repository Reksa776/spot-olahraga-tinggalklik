import { FiCalendar, FiPlus } from "react-icons/fi";

import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    PrimaryAction,
    StatusBadge,
    TableToolbar,
    TextLink,
} from "@/components/dashboard/primitives";
import { listOrganizerEvents } from "@/lib/events/service";
import { EVENT_STATUS_FILTERS, eventStatusTone, parseEventStatusFilter } from "@/lib/events/status";
import { getOrganizerPageContext } from "@/lib/organizer/context";

/**
 * Event & ticket list.
 *
 * Delegates to `listOrganizerEvents`, which scopes the query to the organizers the actor
 * can actually read (`readableOrganizerIds`). A platform admin without a membership sees
 * no events — the authorization model gives no role tenant access without one — and the
 * empty state below says so rather than rendering another tenant's rows.
 *
 * ── THE STATUS FILTER IS VALIDATED, NOT FORWARDED ────────────────────────────────
 * `?status=` is a user-controlled string, and `EventStatus` is a Prisma enum: handing an
 * unrecognised value to the query layer raises instead of returning a page. `parseEventStatusFilter`
 * narrows it against the statuses the product can actually produce, and anything else is treated
 * as "no filter" — the same defensive shape the orders, payments and refunds lists use.
 *
 * ── STATUS COLOUR COMES FROM THE SHARED TABLE ────────────────────────────────────
 * `eventStatusTone` (lib/events/status.ts) is the ONE place a status is mapped to a tone. This page,
 * the event detail header and the overview panel all read it, so `ONGOING` cannot render as a
 * neutral grey here while meaning something else there — which is what it did before this phase.
 *
 * ── PAGINATION COMES FROM THE SERVICE ────────────────────────────────────────────
 * `result.pagination.totalPages` is computed by `listOrganizerEvents` from the SAME `limit` it
 * applied. Re-deriving it here from a second copy of the page size is how a footer ends up
 * disagreeing with the rows it paginates.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

export default async function DashboardEventsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; page?: string }>;
}) {
    const params = await searchParams;
    const context = await getOrganizerPageContext();

    const status = parseEventStatusFilter(params.status);
    const page = params.page ? Number(params.page) : 1;

    const result = await listOrganizerEvents(context.scope, {
        organizerId: context.currentOrganizerId,
        status,
        page,
        limit: 20,
    });

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

            {/*
                The status filter the service already supported but no control exposed. It is a row
                of links — like the orders page's worklist switch — so it stays a server-rendered
                page with no client state, and every filter is a shareable URL.
            */}
            <TableToolbar>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
                    <TextLink href="/dashboard/events">
                        {status === null ? "• Semua status" : "Semua status"}
                    </TextLink>

                    {EVENT_STATUS_FILTERS.map((value) => (
                        <TextLink
                            key={value}
                            href={`/dashboard/events?status=${value}`}
                        >
                            {status === value ? `• ${value}` : value}
                        </TextLink>
                    ))}
                </div>
            </TableToolbar>

            <DataTable
                minWidth={860}
                empty={
                    <EmptyBlock
                        icon={<FiCalendar size={22} />}
                        title={
                            status === null
                                ? "Belum ada event"
                                : `Tidak ada event berstatus ${status}`
                        }
                        description={
                            status === null
                                ? "Buat draft event pertama, lalu publikasikan setelah jenis tiket dan waktu selesai tersedia."
                                : "Coba pilih status lain, atau lihat semua event."
                        }
                        action={
                            status === null ? (
                                <PrimaryAction href="/dashboard/events/new">
                                    Event baru
                                </PrimaryAction>
                            ) : (
                                <PrimaryAction
                                    href="/dashboard/events"
                                    variant="outline"
                                >
                                    Lihat semua event
                                </PrimaryAction>
                            )
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
                        <StatusBadge
                            key="status"
                            tone={eventStatusTone(event.status)}
                        >
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
                        totalPages={result.pagination.totalPages}
                        basePath="/dashboard/events"
                        query={{ status: params.status }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
