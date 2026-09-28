import { FiCalendar, FiPlus } from "react-icons/fi";

import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { buildFilterField } from "@/components/dashboard/filters/filter-types";
import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    PrimaryAction,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { EVENT_STATUS_LABELS } from "@/lib/dashboard/filter-options";
import { listOrganizerEvents } from "@/lib/events/service";
import {
    EVENT_ACTIVE_STATUSES,
    EVENT_STATUS_FILTERS,
    eventStatusTone,
    isEventActiveStatusFilter,
    parseEventStatusFilters,
} from "@/lib/events/status";
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
 * unrecognised value to the query layer raises instead of returning a page. `parseEventStatusFilters`
 * narrows it against the statuses the product can actually produce, and anything else is treated
 * as "no filter" — the same defensive shape the orders, payments and refunds lists use.
 *
 * ── STATUS FILTERING IS A VISIBLE ROW OF PILLS ──────────────────────────────────
 * Every status the list can be narrowed to is on screen, the applied one is highlighted, and a pill
 * is a LINK — so the filter is one click, needs no JavaScript, is shareable, and survives a refresh.
 * Nothing about the query changed: each pill resolves to the same `?status=` value, the "Aktif" pill
 * still emits the REPEATED parameter (`status=PUBLISHED&status=ONGOING`, built from
 * `EVENT_ACTIVE_STATUSES` so the union cannot drift from the union the overview tile counts), and the
 * same validated list still reaches Prisma.
 *
 * ── SEARCH ──────────────────────────────────────────────────────────────────────
 * `listOrganizerEvents` has always accepted `q` (title, event code, slug) and no control ever
 * exposed it. The search box is that control; it adds a parameter, not a predicate.
 *
 * ── STATUS COLOUR COMES FROM THE SHARED TABLE ────────────────────────────────────
 * `eventStatusTone` (lib/events/status.ts) is the ONE place a status is mapped to a tone. This page,
 * the event detail header and the overview panel all read it, so `ONGOING` cannot render as a
 * neutral grey here while meaning something else there.
 *
 * ── PAGINATION COMES FROM THE SERVICE ────────────────────────────────────────────
 * `result.pagination.totalPages` is computed by `listOrganizerEvents` from the SAME `limit` it
 * applied. Re-deriving it here from a second copy of the page size is how a footer ends up
 * disagreeing with the rows it paginates.
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Events" };

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

export default async function DashboardEventsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string | string[]; page?: string; q?: string }>;
}) {
    const params = await searchParams;
    const context = await getOrganizerPageContext();

    /*
     * A repeated `?status=` is the union the "Event aktif" KPI needs (`PUBLISHED` + `ONGOING`),
     * so the page reads the whole set and hands the validated list to the scoped service. A single
     * value still renders exactly as before.
     */
    const statuses = parseEventStatusFilters(params.status);
    const isActiveUnion = isEventActiveStatusFilter(statuses);
    const page = params.page ? Number(params.page) : 1;
    const q = params.q ?? null;

    const result = await listOrganizerEvents(context.scope, {
        organizerId: context.currentOrganizerId,
        statuses,
        q,
        page,
        limit: 20,
    });

    const statusField = buildFilterField({
        name: "status",
        label: "Status",
        allLabel: "Semua status",
        values: statuses,
        members: EVENT_STATUS_FILTERS,
        labels: EVENT_STATUS_LABELS,
        union: {
            value: "active",
            label: "Aktif",
            statuses: EVENT_ACTIVE_STATUSES,
        },
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

            <FilterBar
                basePath="/dashboard/events"
                current={{
                    status: statuses.length > 0 ? statuses : undefined,
                    q: params.q,
                }}
                fields={[statusField]}
                search={{
                    label: "Cari event",
                    placeholder: "Nama, kode, atau slug",
                    value: params.q,
                }}
            />

            <DataTable
                minWidth={860}
                empty={
                    <EmptyBlock
                        icon={<FiCalendar size={22} />}
                        title={
                            statuses.length === 0
                                ? "Belum ada event"
                                : isActiveUnion
                                  ? "Tidak ada event aktif"
                                  : `Tidak ada event berstatus ${statuses.join(", ")}`
                        }
                        description={
                            statuses.length === 0
                                ? "Buat draft event pertama, lalu publikasikan setelah jenis tiket dan waktu selesai tersedia."
                                : "Coba pilih status lain, atau lihat semua event."
                        }
                        action={
                            statuses.length === 0 ? (
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
                        query={{
                            status: statuses.length > 0 ? statuses : undefined,
                            q: params.q,
                        }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
