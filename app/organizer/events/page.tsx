import { FiCalendar, FiPlus } from "react-icons/fi";
import { Stack, Text } from "@mantine/core";

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
 * Organizer event list.
 *
 * Delegates to `listOrganizerEvents`, which scopes the query to the organizers the
 * actor can actually read (`readableOrganizerIds`). The page therefore cannot show
 * another tenant's event even if a query parameter is edited.
 *
 * Presentation is Mantine (`DataTable` / `StatusBadge` / `LinkPagination`) so the table behaves
 * like every other back-office table: horizontal scroll rather than collapsed columns, and a real
 * empty state instead of an empty `<tbody>`.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

/** The previous status tint map, re-expressed in the shared semantic vocabulary. */
const STATUS_TONE: Record<string, Tone> = {
    DRAFT: "neutral",
    PUBLISHED: "success",
    CANCELLED: "error",
    COMPLETED: "info",
    ARCHIVED: "neutral",
};

export default async function OrganizerEventsPage({
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
        <Stack gap="lg">
            <PageHeader
                eyebrow="Penyelenggara"
                title="Event"
                description="Semua event milik organizer yang bisa kamu akses."
                actions={
                    <PrimaryAction href="/organizer/events/new">
                        <FiPlus aria-hidden />
                        <Text span ml={8}>
                            Event baru
                        </Text>
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
                            <PrimaryAction href="/organizer/events/new">Event baru</PrimaryAction>
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
                        <Stack gap={0} key="event">
                            <Text size="sm" fw={600}>{event.title}</Text>
                            <Text size="xs" c="dimmed" ff="monospace">
                                {event.eventCode} · /e/{event.slug}
                            </Text>
                        </Stack>,
                        <Text size="sm" key="schedule">{DATE_FORMAT.format(event.startAt)}</Text>,
                        <StatusBadge key="status" tone={STATUS_TONE[event.status] ?? "neutral"}>
                            {event.status}
                        </StatusBadge>,
                        <Text size="sm" key="types">{event._count.ticketTypes}</Text>,
                        <TextLink key="manage" href={`/organizer/events/${event.id}`}>
                            Kelola
                        </TextLink>,
                    ],
                }))}
                footer={
                    <LinkPagination
                        page={page}
                        totalPages={totalPages}
                        basePath="/organizer/events"
                        query={{ status: params.status }}
                        label="Halaman"
                    />
                }
            />
        </Stack>
    );
}
