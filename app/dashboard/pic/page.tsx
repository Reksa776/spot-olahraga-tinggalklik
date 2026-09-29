import Link from "next/link";
import { CalendarDays, Coins, Receipt, Ticket, Wallet } from "lucide-react";

import PicAssignmentManager from "@/components/organizer/PicAssignmentManager";
import PicManager, { type PicRow } from "@/components/platform/PicManager";
import CopyLinkButton from "@/components/dashboard/CopyLinkButton";
import {
    AccountStandingNotice,
    picStandingNotice,
} from "@/components/dashboard/AccountStandingNotice";
import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { SingleSelectFilter } from "@/components/dashboard/filters/SingleSelectFilter";
import { buildFilterField } from "@/components/dashboard/filters/filter-types";
import {
    AccessDeniedPanel,
    DataRow,
    DataTable,
    EmptyBlock,
    InfoNote,
    KPI_CARD_LINK_CLASS,
    LinkPagination,
    Money,
    PageHeader,
    PrimaryAction,
    SectionCard,
    StatCard,
    StatGrid,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { PERMISSIONS, getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import {
    EVENT_STATUS_LABELS,
    PAYMENT_STATUS_LABELS,
    PIC_ASSIGNMENT_STATUS_LABELS,
} from "@/lib/dashboard/filter-options";
import { PAYMENT_STATUS_FILTERS } from "@/lib/dashboard/orders";
import { hasOrganizerPermission, hasPlatformPermission } from "@/lib/dashboard/scope";
import {
    EVENT_ACTIVE_STATUSES,
    EVENT_STATUS_FILTERS,
    parseEventStatusFilters,
} from "@/lib/events/status";
import {
    PIC_ASSIGNMENT_STATUSES,
    findActivePicProfile,
    findPicProfileStanding,
    getMyPicOverview,
    getMyPicProfile,
    getMyPicTicketSales,
    listMyAttributions,
    listMyFeeLedger,
    listMyPicAssignments,
    listMyReferralLinks,
    parsePicAssignmentStatus,
    parseTicketSalesEventId,
} from "@/lib/pic/self-service";
import {
    listMyPicPayoutRequests,
    listMyPicSettleableOrganizers,
} from "@/lib/pic/payout";
import { PicPayoutRequestDialog } from "@/components/dashboard/PicPayoutRequestDialog";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listOrganizerPicAssignments, listPicsForAdmin } from "@/lib/pic/service";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * PIC — ONE PAGE, THREE AUTHORITY DIMENSIONS
 * ==========================================
 *
 * PIC (Penanggung Jawab) is the ticketing referrer domain. It has THREE surfaces that used
 * to live at different destinations:
 *
 *   `pic.manage` (PLATFORM scope)  — create, approve and suspend PIC profiles.
 *   `pic.assign` (TENANT scope)    — attach an already-approved PIC to one of YOUR events.
 *   own ACTIVE PICProfile          — the PIC's own READ-ONLY self-service: their events,
 *                                    referral links, attributions, sales and fee ledger.
 *
 * They are the same menu row because they are the same concept, and this page renders
 * whichever one the caller actually holds. That is the whole consolidation: not a merged
 * permission (that would let an organizer approve profiles, an admin attach a referrer to
 * an event they do not own, or a PIC manage others), but one destination whose body is
 * chosen by authority.
 *
 * The three branches are ordered platform → tenant → own. A platform ADMIN with `pic.manage`
 * and an organizer MANAGER with `pic.assign` keep their operator views even if the admin also
 * owns a PIC profile; ONLY an actor holding none of those but owning an ACTIVE profile is
 * shown the self-service surface. A caller holding NEITHER sees the denial panel — not a
 * disabled page, and not an empty one, because "you cannot do this" and "there is nothing
 * here" are different answers.
 *
 * Every branch re-checks its own authority inside its service (or, for self-service, through
 * the `requireMyPic` guard in `lib/pic/self-service.ts`), so the branch below is a routing
 * decision, not the access control.
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "PIC" };

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const EVENT_STATUS_TONE: Record<string, Tone> = {
    DRAFT: "neutral",
    PENDING_REVIEW: "pending",
    PUBLISHED: "success",
    ONGOING: "info",
    COMPLETED: "info",
    CANCELLED: "neutral",
    ARCHIVED: "neutral",
};

const PAYMENT_TONE: Record<string, Tone> = {
    UNPAID: "pending",
    PENDING: "pending",
    PAID: "success",
    FAILED: "error",
    EXPIRED: "warn",
    REFUNDED: "info",
    PARTIALLY_REFUNDED: "info",
};

const LEDGER_STATUS_TONE: Record<string, Tone> = {
    PENDING: "pending",
    EARNED: "success",
    PAYABLE: "info",
    APPROVED: "info",
    SETTLED: "info",
    VOID: "neutral",
};

const ATTRIBUTION_SOURCE_LABEL: Record<string, string> = {
    ORGANIC: "Organik",
    PIC_LINK: "Tautan PIC",
    PIC_CODE: "Kode PIC",
    EVENT_PAGE_ATTRIBUTED: "Halaman event",
    ADMIN_ASSIGNED: "Penugasan admin",
};

const LEDGER_TYPE_LABEL: Record<string, string> = {
    EARLY_ACCRUAL: "Akrual awal",
    EARNED: "Fee diperoleh",
    EARNED_ADJUSTMENT: "Penyesuaian fee",
    REVERSAL: "Pembatalan",
    PAYOUT: "Pencairan",
    ADJUSTMENT: "Penyesuaian",
};

const SETTLEMENT_STATUS_TONE: Record<string, Tone> = {
    DRAFT: "neutral",
    PENDING_APPROVAL: "pending",
    APPROVED: "info",
    PAID: "success",
    FAILED: "error",
    CANCELLED: "neutral",
    // PHASE 21 — the PIC's own request lifecycle, shown in their dashboard.
    REQUESTED: "pending",
    REJECTED: "error",
};

/**
 * The status the PIC READS. The stored enum is operator vocabulary (`REQUESTED`,
 * `PENDING_APPROVAL`); a PIC is not an operator, so their own payout history names the state
 * in their language. Unknown values fall through to the raw enum rather than hiding it — a
 * status this map has not learned yet must still be visible, not blank.
 */
const SETTLEMENT_STATUS_LABEL: Record<string, string> = {
    REQUESTED: "Menunggu Persetujuan",
    PENDING_APPROVAL: "Menunggu Persetujuan",
    APPROVED: "Disetujui",
    PAID: "Sudah Dibayar",
    REJECTED: "Ditolak",
    FAILED: "Gagal",
    CANCELLED: "Dibatalkan",
    DRAFT: "Draf",
};

/**
 * The self-service query parameters, all VALIDATED before they reach a read model.
 *
 * They are a deep-link contract as much as a control: the five KPI tiles above the table
 * navigate with them, so a tile can open "the rows behind this number" instead of a bare page.
 * An unrecognised value is dropped by the parser(s) below and renders the unfiltered list,
 * which is also what keeps a hand-edited URL from reaching a Prisma enum comparison.
 */
type PicSearchParams = {
    assignmentStatus?: string | string[];
    eventStatus?: string | string[];
    attributionPaymentStatus?: string | string[];
    /** The ticket-sales event filter — a PIC's OWN event id, shape-validated then scoped. */
    ticketSalesEventId?: string | string[];
    /** `Event Saya`'s page. */
    page?: string;
    /**
     * The ticket-sales table's page, deliberately its own key.
     *
     * The two tables paginate independently and a single shared `page` would move them both at
     * once — clicking page 2 of the sales table must not page "Event Saya" as a side effect.
     */
    ticketSalesPage?: string;
};

/** `page` is user input; anything that is not a positive integer is page 1. */
function parsePage(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);

    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/**
 * The gateway payment states the attribution list can be narrowed to.
 *
 * Re-exported from the orders read model, which is where the two order/payment lifecycles are
 * defined, so the pill options and the `paymentStatus` predicate cannot drift apart.
 */
const VALID_ATTRIBUTION_PAYMENT_STATUSES = PAYMENT_STATUS_FILTERS;

function parseAttributionPaymentStatus(
    value: string | string[] | undefined
): (typeof PAYMENT_STATUS_FILTERS)[number] | null {
    const raw = Array.isArray(value) ? value[0] : value;

    return raw && (VALID_ATTRIBUTION_PAYMENT_STATUSES as readonly string[]).includes(raw)
        ? (raw as (typeof PAYMENT_STATUS_FILTERS)[number])
        : null;
}

export default async function DashboardPicPage({
    searchParams,
}: {
    searchParams: Promise<PicSearchParams>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    if (hasPlatformPermission(scope, PERMISSIONS.PIC_MANAGE)) {
        return <PlatformPicSection />;
    }

    if (hasOrganizerPermission(scope, PERMISSIONS.PIC_ASSIGN)) {
        return <OrganizerPicSection />;
    }

    // PHASE 34 — a platform PIC whose profile is not ACTIVE may enter the dashboard shell
    // (the layout admits on the platform role alone) but has no self-service surface. Show
    // the standing state rather than the generic operator denial, and never expose another
    // PIC's data: this branch reads only the caller's own profile STATUS.
    if (scope.platformRole === "PIC") {
        const standing = await findPicProfileStanding(scope.userId);

        if (standing !== "ACTIVE") {
            return <AccountStandingNotice standing={picStandingNotice(standing)} />;
        }
    }

    // Third authority dimension (PIC SELF-SERVICE DASHBOARD V1): the caller's OWN ACTIVE
    // PICProfile. The layout admitted them on this flag, so a profile is normally present;
    // re-checking here keeps the page honest even at direct-URL entries. The service guard
    // below is the real authority — this lookup only decides which branch to draw.
    if ((await findActivePicProfile(scope.userId)) !== null) {
        return <PicSelfServiceSection userId={scope.userId} params={params} />;
    }

    return (
        <AccessDeniedPanel
            title="Akses ditolak"
            body={
                <p className="text-sm leading-relaxed">
                    Peran kamu belum memiliki izin mengelola atau menugaskan PIC.
                </p>
            }
            actionHref="/dashboard"
            actionLabel="Kembali ke ringkasan"
        />
    );
}

async function PlatformPicSection() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let result;

    try {
        result = await listPicsForAdmin(scope);
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Peran platform kamu belum memiliki izin mengelola PIC.
                    </p>
                }
                actionHref="/dashboard"
                actionLabel="Kembali ke ringkasan"
            />
        );
    }

    const pics: PicRow[] = result.items.map((pic) => ({
        id: pic.id,
        picCode: pic.picCode,
        displayName: pic.displayName,
        status: pic.status,
        defaultFeeRateBp: pic.defaultFeeRateBp,
        canSellAllEvents: pic.canSellAllEvents,
        approvedAt: pic.approvedAt,
        suspendedAt: pic.suspendedAt,
        suspendReason: pic.suspendReason,
        createdAt: pic.createdAt,
        account: pic.account,
        counts: pic.counts,
        ledgerTotal: pic.ledgerTotal,
    }));

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="PIC"
                description="Penanggung jawab penjualan tiket. Profil PIC ditautkan ke akun yang sudah terdaftar, disetujui di sini, lalu ditugaskan ke event oleh penyelenggara. Angka fee berasal dari ledger yang sudah diposting."
            />

            <PicManager pics={pics} />
        </div>
    );
}

async function OrganizerPicSection() {
    const context = await getOrganizerPageContext();

    if (!context.currentOrganizerId) {
        return (
            <SectionCard title="PIC">
                <EmptyBlock
                    title="Tidak ada organizer aktif"
                    description="Belum ada organizer yang bisa dipilih, sehingga penugasan PIC belum tersedia."
                />
            </SectionCard>
        );
    }

    let result;

    try {
        result = await listOrganizerPicAssignments(
            context.scope,
            context.currentOrganizerId
        );
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Peran kamu di organizer ini belum memiliki izin mengatur penugasan
                        PIC.
                    </p>
                }
                actionHref="/dashboard/events"
                actionLabel="Lihat event"
            />
        );
    }

    const currentOrganizer = context.organizers.find(
        (organizer) => organizer.id === context.currentOrganizerId
    );

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="PIC"
                description={`Atur penanggung jawab penjualan untuk event ${currentOrganizer?.name ?? "organizer ini"}. Hanya PIC yang sudah disetujui admin platform yang dapat ditugaskan, dan penugasan ini yang menentukan siapa yang layak mendapat atribusi penjualan tiket event tersebut.`}
            />

            <PicAssignmentManager
                assignments={result.assignments}
                events={result.events}
                pics={result.pics}
            />
        </div>
    );
}

/**
 * ────────────────────────────────────────────────────────────────────────────────────
 * PIC SELF-SERVICE (OWN-SCOPE, READ-ONLY) — third authority dimension
 * ────────────────────────────────────────────────────────────────────────────────────
 * Everything here is scoped by `requireMyPic` in the service layer: the ACTIVE profile of
 * the SESSION user, own-scope permissions for attribution/fee reads, and the identity check
 * that makes a forged `userId` a denial. None of the section bodies below trust any client
 * value — the query parameters only ever SELECT among the caller's own rows.
 *
 * ── THE FIVE KPI TILES ARE LINKS ─────────────────────────────────────────────────
 * Each tile wraps its `StatCard` in a `<Link>` to the section that actually produces the
 * number, so "where does this figure come from?" is answered by the product rather than by
 * the reader. The destinations are the sections of THIS page — there is no separate
 * PIC revenue page or self-service settlement route to point at — and the one dimension the
 * tiles express as a filter is the one the read model really implements (`assignmentStatus`).
 * No tile links to a Manager surface: a PIC holds no `settlement.*` permission, so
 * `/dashboard/settlements` would be a denial panel.
 *
 * ── "TIKET TERJUAL" IS ITS OWN SECTION, NOT A FILTERED ATTRIBUTION LIST ──────────
 * The tile used to link to `?attributionPaymentStatus=PAID#attributions`, which dropped the
 * reader on the SAME order list they had just scrolled past — the dashboard appeared to loop.
 * The two questions are genuinely different ("which orders came through me?" vs "which orders
 * have actually SOLD?"), so the tile points at `#tickets-sold`, an order-level table built
 * from the identical PAID-only set the tile counts and filterable BY EVENT
 * (`?ticketSalesEventId=`) — the filter runs in the read model, not after the fetch. The
 * attribution list keeps its payment-status filter and its per-order `Tiket` column, so the
 * ticket count is readable where the orders are too — but it is no longer the tile's target.
 */
async function PicSelfServiceSection({
    userId,
    params,
}: {
    userId: string;
    params: PicSearchParams;
}) {
    const assignmentStatus = parsePicAssignmentStatus(params.assignmentStatus);
    const eventStatuses = parseEventStatusFilters(params.eventStatus);
    const attributionPaymentStatus = parseAttributionPaymentStatus(
        params.attributionPaymentStatus
    );
    // Shape-validated here, existence deliberately not: the read model AND-s this with the
    // caller's own `picProfileId`, so a foreign event id is an empty result, never a leak.
    const ticketSalesEventId = parseTicketSalesEventId(params.ticketSalesEventId);
    const page = parsePage(params.page);
    const ticketSalesPage = parsePage(params.ticketSalesPage);

    type SelfServiceView = {
        profile: Awaited<ReturnType<typeof getMyPicProfile>>;
        overview: Awaited<ReturnType<typeof getMyPicOverview>>;
        assignments: Awaited<ReturnType<typeof listMyPicAssignments>>;
        attributions: Awaited<ReturnType<typeof listMyAttributions>>;
        ticketSales: Awaited<ReturnType<typeof getMyPicTicketSales>>;
        ledgerEntries: Awaited<ReturnType<typeof listMyFeeLedger>>;
        requests: Awaited<ReturnType<typeof listMyPicPayoutRequests>>;
        settleable: Awaited<ReturnType<typeof listMyPicSettleableOrganizers>>;
        referralLinks: Awaited<ReturnType<typeof listMyReferralLinks>>;
    };

    let view: SelfServiceView;

    try {
        const [
            profile,
            overview,
            assignments,
            attributions,
            ticketSales,
            ledgerEntries,
            requests,
            settleable,
            referralLinks,
        ] = await Promise.all([
            getMyPicProfile(userId),
            getMyPicOverview(userId),
            listMyPicAssignments(userId, {
                assignmentStatus,
                eventStatuses,
                page,
            }),
            listMyAttributions(userId, { paymentStatus: attributionPaymentStatus }),
            getMyPicTicketSales(userId, {
                eventId: ticketSalesEventId,
                page: ticketSalesPage,
            }),
            listMyFeeLedger(userId),
            listMyPicPayoutRequests(userId),
            listMyPicSettleableOrganizers(userId),
            listMyReferralLinks(userId),
        ]);

        view = {
            profile,
            overview,
            assignments,
            attributions,
            ticketSales,
            ledgerEntries,
            requests,
            settleable,
            referralLinks,
        };
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Profil PIC kamu belum dapat mengakses ringkasan ini.
                    </p>
                }
                actionHref="/dashboard"
                actionLabel="Kembali ke ringkasan"
            />
        );
    }

    const {
        profile,
        overview,
        assignments,
        attributions,
        ticketSales,
        ledgerEntries,
        requests,
        settleable,
        referralLinks,
    } = view;

    const eventRows = assignments.items;
    const eventPagination = assignments.pagination;
    const payout = overview.payout;

    const assignmentField = buildFilterField({
        name: "assignmentStatus",
        label: "Status penugasan",
        allLabel: "Semua penugasan",
        values: assignmentStatus ? [assignmentStatus] : [],
        members: PIC_ASSIGNMENT_STATUSES,
        labels: PIC_ASSIGNMENT_STATUS_LABELS,
    });

    const eventStatusField = buildFilterField({
        name: "eventStatus",
        label: "Status event",
        allLabel: "Semua status event",
        values: eventStatuses,
        members: EVENT_STATUS_FILTERS,
        labels: EVENT_STATUS_LABELS,
        union: {
            value: "active",
            label: "Aktif",
            statuses: EVENT_ACTIVE_STATUSES,
        },
    });

    const attributionPaymentField = buildFilterField({
        name: "attributionPaymentStatus",
        label: "Status pembayaran",
        allLabel: "Semua pembayaran",
        values: attributionPaymentStatus ? [attributionPaymentStatus] : [],
        members: VALID_ATTRIBUTION_PAYMENT_STATUSES,
        labels: PAYMENT_STATUS_LABELS,
    });

    /* Every filter row is built from this ONE state, so a selection in any of them preserves the
     * other two (and `page` is dropped by `applyFilterChange`, which returns to page 1). */
    const filterState = {
        assignmentStatus: assignmentStatus ?? undefined,
        eventStatus: eventStatuses.length > 0 ? eventStatuses : undefined,
        attributionPaymentStatus: attributionPaymentStatus ?? undefined,
        // Carried by every other control and by both pagers, so choosing an event here — or
        // paging either table — never silently drops a filter the reader set somewhere else.
        ticketSalesEventId: ticketSalesEventId ?? undefined,
    };

    /* The event selector's OWN hidden state: the page's other filters, minus the parameter the
     * selector writes and minus both page numbers (a filter change returns to page 1). */
    const ticketSalesPreservedFilters = {
        assignmentStatus: assignmentStatus ?? undefined,
        eventStatus: eventStatuses.length > 0 ? eventStatuses : undefined,
        attributionPaymentStatus: attributionPaymentStatus ?? undefined,
    };

    const hasEventFilter = Boolean(assignmentStatus) || eventStatuses.length > 0;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Ringkasan PIC"
                description={`Ringkasan penjualan untuk ${profile.displayName} (${profile.picCode}). Semua angka berasal dari data yang sudah diposting: atribusi dihitung per pesanan dan angka fee dihitung dari ledger.`}
            />

            <StatGrid className="xl:grid-cols-5">
                <Link
                    href="/dashboard/pic?assignmentStatus=ACTIVE#events"
                    className={KPI_CARD_LINK_CLASS}
                >
                    <StatCard
                        label="Event Ditugaskan"
                        value={overview.assignedEvents}
                        hint={`${overview.totalAssignments} total penugasan`}
                        icon={<CalendarDays size={18} />}
                    />
                </Link>
                <Link href="/dashboard/pic#attributions" className={KPI_CARD_LINK_CLASS}>
                    <StatCard
                        label="Pesanan Atribusi"
                        value={overview.attributedOrders}
                        hint="Dari seluruh penugasan, semua status"
                        icon={<Receipt size={18} />}
                    />
                </Link>
                <Link href="/dashboard/pic#tickets-sold" className={KPI_CARD_LINK_CLASS}>
                    <StatCard
                        label="Tiket Terjual"
                        value={overview.ticketsSold}
                        hint="Tiket pada pesanan berstatus lunas"
                        tone="info"
                        icon={<Ticket size={18} />}
                    />
                </Link>
                <Link href="/dashboard/pic#fees" className={KPI_CARD_LINK_CLASS}>
                    <StatCard
                        label="Potensi Fee"
                        value={formatIdr(Number(overview.fee.potential))}
                        hint="Fee diperoleh dari penjualan, dikurangi fee pembatalan"
                        icon={<Coins size={18} />}
                    />
                </Link>
                <Link href="/dashboard/pic#payouts" className={KPI_CARD_LINK_CLASS}>
                    <StatCard
                        label="Fee Bersih"
                        value={formatIdr(Number(payout.approvedTotal))}
                        hint={`Disetujui ${formatIdr(
                            Number(payout.approvedAmount)
                        )} · Sudah dibayar ${formatIdr(Number(payout.paidAmount))}`}
                        tone="success"
                        icon={<Wallet size={18} />}
                    />
                </Link>
            </StatGrid>

            <div id="events" className="scroll-mt-16 flex flex-col gap-6">
                <SectionCard
                    title="Event Saya"
                    description="Event yang kamu ditugaskan sebagai penanggung jawab penjualan. Filter di bawah berjalan di server, jadi angka pada kolom Pesanan dan Tiket terjual selalu menggambarkan baris yang tampil."
                >
                    <FilterBar
                        bare
                        basePath="/dashboard/pic"
                        current={filterState}
                        fields={[assignmentField, eventStatusField]}
                    />

                    <DataTable
                        minWidth={980}
                        empty={
                            <EmptyBlock
                                icon={<CalendarDays size={22} />}
                                title={
                                    hasEventFilter
                                        ? "Tidak ada event dengan filter tersebut."
                                        : "Belum ada event yang ditugaskan."
                                }
                                description={
                                    hasEventFilter
                                        ? "Coba pilih filter lain, atau lihat semua penugasan."
                                        : "Hubungi admin platform atau penyelenggara untuk ditugaskan ke event."
                                }
                                action={
                                    hasEventFilter ? (
                                        <PrimaryAction
                                            href="/dashboard/pic#events"
                                            variant="outline"
                                        >
                                            Lihat semua event
                                        </PrimaryAction>
                                    ) : undefined
                                }
                            />
                        }
                        columns={[
                            { header: "Event" },
                            { header: "Status Event" },
                            { header: "Penugasan" },
                            { header: "Pesanan", align: "right" },
                            { header: "Tiket Terjual", align: "right" },
                            { header: "Ditugaskan", align: "right" },
                        ]}
                        rows={eventRows.map((assignment) => ({
                            key: assignment.id,
                            cells: [
                                <div key="title" className="min-w-0">
                                    <TextLink href={`/e/${assignment.eventSlug}`}>
                                        <span className="text-sm font-semibold">
                                            {assignment.eventTitle}
                                        </span>
                                    </TextLink>
                                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                        {assignment.eventSlug}
                                    </p>
                                </div>,
                                <StatusBadge
                                    key="status"
                                    tone={EVENT_STATUS_TONE[assignment.eventStatus] ?? "neutral"}
                                >
                                    {assignment.eventStatus}
                                </StatusBadge>,
                                <StatusBadge
                                    key="active"
                                    tone={assignment.isActive ? "success" : "neutral"}
                                >
                                    {assignment.isActive ? "Aktif" : "Dicabut"}
                                </StatusBadge>,
                                <span key="orders" className="text-sm tabular-nums">
                                    {assignment.attributedOrders}
                                </span>,
                                <span key="tickets" className="text-sm tabular-nums">
                                    {assignment.paidTickets}
                                </span>,
                                assignment.revokedAt
                                    ? DATE_FORMAT.format(new Date(assignment.revokedAt))
                                    : DATE_FORMAT.format(new Date(assignment.assignedAt)),
                            ],
                        }))}
                        footer={
                            <LinkPagination
                                page={eventPagination.page}
                                totalPages={eventPagination.totalPages}
                                basePath="/dashboard/pic"
                                query={filterState}
                                label="Halaman"
                            />
                        }
                    />
                </SectionCard>

                <div id="referrals" className="scroll-mt-16 flex flex-col gap-6">
                    <SectionCard
                        title="Tautan Referral"
                        description="Tautan yang bisa kamu bagikan untuk mendapatkan atribusi penjualan. Tautan dibuat untuk penugasan yang aktif."
                    >
                        {referralLinks.length === 0 ? (
                            <EmptyBlock
                                title="Belum ada tautan referral aktif."
                                description="Tautan dibuat dari penugasan yang aktif dan belum dicabut."
                            />
                        ) : (
                            <DataTable
                                columns={[
                                    { header: "Event" },
                                    { header: "Tautan", align: "right" },
                                ]}
                                rows={referralLinks.map((link) => ({
                                    key: link.assignmentId,
                                    cells: [
                                        <div key="title" className="min-w-0">
                                            <p className="truncate text-sm font-semibold leading-tight">
                                                {link.eventTitle}
                                            </p>
                                            {link.sharePath ? (
                                                <TextLink href={`/e/${link.eventSlug}`}>
                                                    /e/{link.eventSlug}
                                                </TextLink>
                                            ) : null}
                                        </div>,
                                        link.sharePath ? (
                                            <CopyLinkButton
                                                key={link.assignmentId}
                                                sharePath={link.sharePath}
                                            />
                                        ) : (
                                            <span
                                                key="unavailable"
                                                className="text-xs text-muted-foreground"
                                            >
                                                Tautan tidak tersedia
                                            </span>
                                        ),
                                    ],
                                }))}
                            />
                        )}
                    </SectionCard>
                </div>

                <div id="attributions" className="scroll-mt-16">
                    <SectionCard
                        title="Atribusi Terbaru"
                        description="Pesanan yang mencatat penjualan atas namamu — termasuk yang belum lunas, karena atribusi dicatat saat checkout. Kolom Tiket menunjukkan jumlah tiket pada pesanan itu. Untuk penjualan yang benar-benar sudah lunas, lihat bagian Tiket Terjual di bawah."
                    >
                        <FilterBar
                            bare
                            basePath="/dashboard/pic"
                            current={filterState}
                            fields={[attributionPaymentField]}
                        />

                        {attributions.length === 0 ? (
                            <EmptyBlock
                                title={
                                    attributionPaymentStatus
                                        ? "Tidak ada atribusi dengan status pembayaran tersebut."
                                        : "Belum ada penjualan dari referral Anda."
                                }
                                description={
                                    attributionPaymentStatus
                                        ? "Coba pilih status lain, atau lihat semua atribusi."
                                        : "Bagikan tautan referral untuk mulai mendapatkan atribusi."
                                }
                            />
                        ) : (
                            <DataTable
                                minWidth={820}
                                columns={[
                                    { header: "No. Pesanan" },
                                    { header: "Event" },
                                    { header: "Tiket", align: "right" },
                                    { header: "Sumber" },
                                    { header: "Status Bayar" },
                                    { header: "Total", align: "right" },
                                    { header: "Dicatat", align: "right" },
                                ]}
                                rows={attributions.map((attribution) => ({
                                    key: attribution.id,
                                    cells: [
                                        <span
                                            key="order"
                                            className="text-sm font-semibold tabular-nums"
                                        >
                                            {attribution.orderNumber}
                                        </span>,
                                        attribution.eventTitle,
                                        <span
                                            key="tickets"
                                            className="text-sm tabular-nums"
                                        >
                                            {attribution.ticketQuantity}
                                        </span>,
                                        ATTRIBUTION_SOURCE_LABEL[attribution.source] ??
                                            attribution.source,
                                        <StatusBadge
                                            key="payment"
                                            tone={
                                                PAYMENT_TONE[attribution.paymentStatus] ??
                                                "neutral"
                                            }
                                        >
                                            {attribution.paymentStatus}
                                        </StatusBadge>,
                                        <Money
                                            key="total"
                                            value={formatIdr(Number(attribution.orderTotal))}
                                        />,
                                        DATE_FORMAT.format(
                                            new Date(attribution.capturedAt)
                                        ),
                                    ],
                                }))}
                            />
                        )}
                    </SectionCard>
                </div>

                {/*
                 * The section the `Tiket Terjual` tile points at: ONE ROW PER PAID ORDER, so the
                 * figure on the tile can be traced to the orders that produced it and from there
                 * to the order detail behind each one. The event selector narrows the SAME `where`
                 * the rows, the footer totals and the pager all read, so the three cannot describe
                 * different sets.
                 *
                 * The row granularity is not an implementation detail here, it is the contract, so
                 * it is visible in the header: `Event | Nomor Pesanan | Jumlah Tiket | Penjualan`.
                 * Two PAID orders on ONE event are TWO rows — never one row whose ticket count is
                 * the event's. `Jumlah Tiket` and `Penjualan` are that ORDER's own figures.
                 */}
                <div id="tickets-sold" className="scroll-mt-16">
                    <SectionCard
                        title="Tiket Terjual"
                        description="Pesanan yang sudah lunas atas namamu, satu baris per pesanan, dengan definisi yang sama seperti kartu Tiket Terjual di atas: tiket pada pesanan berstatus lunas. Jumlah tiket diambil dari baris tiket pesanan itu, bukan dari rekap event, sehingga nilai satu pesanan bisa ditelusuri sampai detailnya."
                    >
                        {/* The selector is offered only where there is something to filter (or a
                            filter is already applied and must be clearable). */}
                        {ticketSales.eventOptions.length > 0 || ticketSalesEventId ? (
                            <SingleSelectFilter
                                action="/dashboard/pic"
                                name="ticketSalesEventId"
                                label="Event"
                                allLabel="Semua event"
                                value={ticketSalesEventId ?? ""}
                                options={ticketSales.eventOptions.map((event) => ({
                                    value: event.id,
                                    label: event.title,
                                }))}
                                preserve={ticketSalesPreservedFilters}
                            />
                        ) : null}

                        {ticketSales.items.length === 0 ? (
                            <EmptyBlock
                                icon={<Ticket size={22} />}
                                title={
                                    ticketSalesEventId
                                        ? "Tidak ada tiket terjual untuk event tersebut."
                                        : "Belum ada tiket terjual."
                                }
                                description={
                                    ticketSalesEventId
                                        ? "Hanya pesanan lunas yang dihitung, dan pilihan event di atas hanya mencakup event yang sudah pernah menghasilkan penjualan atas namamu. Pilih Semua event untuk melihat seluruh penjualan."
                                        : "Tiket baru dihitung setelah pembayaran pesanan atas namamu lunas. Pesanan yang masih menunggu tampil di Atribusi Terbaru."
                                }
                            />
                        ) : (
                            <DataTable
                                minWidth={820}
                                columns={[
                                    { header: "Event" },
                                    { header: "Nomor Pesanan" },
                                    { header: "Jumlah Tiket", align: "right" },
                                    { header: "Penjualan", align: "right" },
                                    { header: "Status Pembayaran" },
                                ]}
                                rows={ticketSales.items.map((sale) => ({
                                    key: sale.orderId,
                                    cells: [
                                        <span key="event" className="text-sm">
                                            {sale.eventTitle}
                                        </span>,
                                        <TextLink
                                            key="order"
                                            href={`/dashboard/pic/orders/${sale.orderNumber}`}
                                        >
                                            <span className="text-sm font-semibold tabular-nums">
                                                {sale.orderNumber}
                                            </span>
                                        </TextLink>,
                                        <span
                                            key="tickets"
                                            className="text-sm font-semibold tabular-nums"
                                        >
                                            {sale.ticketQuantity}
                                        </span>,
                                        <Money
                                            key="total"
                                            value={formatIdr(Number(sale.orderTotal))}
                                        />,
                                        <StatusBadge
                                            key="payment"
                                            tone={
                                                PAYMENT_TONE[sale.paymentStatus] ?? "neutral"
                                            }
                                        >
                                            {PAYMENT_STATUS_LABELS[sale.paymentStatus] ??
                                                sale.paymentStatus}
                                        </StatusBadge>,
                                    ],
                                }))}
                                footer={
                                    <div className="flex flex-col gap-2">
                                        {/* Totals over the WHOLE filtered set, from the read
                                            model's own aggregate — never a sum of this page. */}
                                        <p className="text-xs text-muted-foreground">
                                            Total pesanan: {ticketSales.totals.orders} · Total
                                            tiket terjual: {ticketSales.totals.ticketsSold} ·
                                            Total penjualan:{" "}
                                            {formatIdr(Number(ticketSales.totals.sales))}
                                        </p>
                                        <LinkPagination
                                            page={ticketSales.pagination.page}
                                            totalPages={ticketSales.pagination.totalPages}
                                            basePath="/dashboard/pic"
                                            query={filterState}
                                            pageParam="ticketSalesPage"
                                            label="Halaman"
                                        />
                                    </div>
                                }
                            />
                        )}
                    </SectionCard>
                </div>

                <div id="fees" className="scroll-mt-16">
                    <SectionCard
                        title="Ringkasan Fee"
                        description="Fee dihitung dari ledger yang sudah diposting, bukan dari konfigurasi fee saat ini."
                        actions={
                            // A plain anchor: the endpoint returns Content-Disposition: attachment,
                            // which a client-side <Link> navigation cannot carry.
                            <a
                                href="/api/reports/my-pic-fee/export"
                                className="text-sm font-semibold text-primary underline-offset-4 hover:underline"
                            >
                                Ekspor CSV
                            </a>
                        }
                    >
                        <DataRow
                            divider={false}
                            title="Total Penjualan"
                            meta="Pesanan lunas atas namamu"
                            trailing={
                                <Money value={formatIdr(Number(overview.grossSales))} />
                            }
                        />
                        <DataRow
                            title="Fee Diperoleh"
                            meta="Kredit dari entri fee EARNED yang diposting"
                            trailing={
                                <Money value={formatIdr(Number(overview.fee.earned))} />
                            }
                        />
                        <DataRow
                            title="Fee Pembatalan"
                            meta="Debit dari entri REVERSAL saat pesanan direfund"
                            trailing={
                                <Money value={formatIdr(Number(overview.fee.reversed))} />
                            }
                        />
                        <DataRow
                            title="Potensi Fee"
                            meta="Fee diperoleh dikurangi pembatalan — pencairan belum mengurangi angka ini"
                            trailing={
                                <Money value={formatIdr(Number(overview.fee.potential))} />
                            }
                        />
                        <DataRow
                            title="Fee Bersih"
                            meta={`Dari pencairan yang disetujui: ${payout.approvedCount} disetujui · ${payout.paidCount} sudah dibayar`}
                            trailing={
                                <Money value={formatIdr(Number(payout.approvedTotal))} />
                            }
                        />
                        <div className="pt-2">
                            <InfoNote>
                                Potensi Fee adalah hak fee dari penjualan (entri EARNED
                                dikurangi pembatalan) dan memakai ledger append-only; entri
                                PAYOUT tidak menguranginya karena pencairan memindahkan uang,
                                bukan membatalkan fee. Fee Bersih hanya mengambil pencairan
                                yang sudah disetujui penyelenggara — permintaan yang masih
                                menunggu atau ditolak tidak dihitung.
                            </InfoNote>
                        </div>
                    </SectionCard>
                </div>

                <div id="earnings" className="scroll-mt-16 flex flex-col gap-6">
                    <SectionCard
                        title="Ledger Terbaru"
                        description="Entri fee yang diposting, terbaru di atas. Kredit menambah fee, debit menguranginya."
                    >
                        {ledgerEntries.length === 0 ? (
                            <EmptyBlock
                                title="Belum ada entri fee."
                                description="Fee muncul setelah pembayaran pesanan atas namamu diselesaikan."
                            />
                        ) : (
                            <DataTable
                                columns={[
                                    { header: "Waktu", align: "right" },
                                    { header: "Jenis" },
                                    { header: "Status" },
                                    { header: "Event" },
                                    { header: "Jumlah", align: "right" },
                                ]}
                                rows={ledgerEntries.map((entry) => {
                                    const isCredit = entry.direction === "CREDIT";
                                    const amount = `${isCredit ? "+" : "−"}${formatIdr(
                                        Number(entry.amount)
                                    )}`;

                                    return {
                                        key: entry.id,
                                        cells: [
                                            DATE_FORMAT.format(
                                                new Date(entry.createdAt)
                                            ),
                                            LEDGER_TYPE_LABEL[entry.type] ??
                                                entry.type,
                                            <StatusBadge
                                                key="status"
                                                tone={
                                                    LEDGER_STATUS_TONE[entry.status] ??
                                                    "neutral"
                                                }
                                            >
                                                {entry.status}
                                            </StatusBadge>,
                                            entry.eventTitle,
                                            <span
                                                key="amount"
                                                className="whitespace-nowrap tabular-nums"
                                            >
                                                {amount}
                                            </span>,
                                        ],
                                    };
                                })}
                            />
                        )}
                    </SectionCard>
                </div>

                <div id="payouts" className="scroll-mt-16">
                    <SectionCard
                        title="Pencairan"
                        description="Ajukan pencairan fee kamu; penyelenggara meninjau, melakukan transfer bank manual, lalu mencatatnya. Status menjadi PAID hanya setelah bukti transfer tercatat. Angka Fee Bersih di atas adalah jumlah dari pencairan berstatus disetujui dan sudah dibayar di tabel ini."
                        actions={
                            <PicPayoutRequestDialog
                                organizers={settleable}
                                // The PIC's OWN bank destination, RAW. `getMyPicProfile` is
                                // own-scope and identity-gated, so these values reach the
                                // profile's owner only — which is what makes an EDITABLE
                                // pre-fill possible at all. Every other surface (this page's
                                // history table below, the operator views, the admin detail)
                                // keeps the account number masked.
                                bank={{
                                    bankName: profile.bankName,
                                    bankAccountName: profile.bankAccountName,
                                    bankAccountNumber: profile.bankAccountNumber,
                                    bankDetailsComplete: profile.bankDetailsComplete,
                                }}
                            />
                        }
                    >
                        <div className="mb-4 flex flex-col">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                Saldo yang dapat dicairkan
                            </p>
                            {settleable.length === 0 ? (
                                <DataRow
                                    divider={false}
                                    title="Belum ada saldo yang dapat dicairkan"
                                    meta="Fee yang sudah lunas akan tersedia untuk dicairkan."
                                    trailing={<Money value={formatIdr(0)} />}
                                />
                            ) : (
                                settleable.map((organizer, index) => (
                                    <DataRow
                                        key={organizer.organizerId}
                                        divider={index > 0}
                                        title={organizer.organizerName}
                                        meta="Belum dicairkan"
                                        trailing={
                                            <Money
                                                value={formatIdr(
                                                    Number(organizer.settleableNet)
                                                )}
                                            />
                                        }
                                    />
                                ))
                            )}
                        </div>

                        {requests.length === 0 ? (
                            <EmptyBlock
                                title="Belum ada pencairan."
                                description="Ajukan pencairan bila saldo fee kamu sudah dapat dicairkan."
                            />
                        ) : (
                            <DataTable
                                minWidth={1000}
                                columns={[
                                    { header: "Pencairan" },
                                    { header: "Penyelenggara" },
                                    { header: "Status" },
                                    { header: "Tujuan" },
                                    { header: "Jumlah", align: "right" },
                                    { header: "Dibayar", align: "right" },
                                ]}
                                rows={requests.map((request) => ({
                                    key: request.id,
                                    cells: [
                                        <div key="number" className="flex flex-col">
                                            <span className="font-mono text-xs">
                                                {request.settlementNumber}
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {DATE_FORMAT.format(
                                                    new Date(request.createdAt)
                                                )}
                                            </span>
                                        </div>,
                                        request.organizerName ?? "—",
                                        <StatusBadge
                                            key="status"
                                            tone={
                                                SETTLEMENT_STATUS_TONE[
                                                    request.status
                                                ] ?? "neutral"
                                            }
                                        >
                                            {SETTLEMENT_STATUS_LABEL[request.status] ??
                                                request.status}
                                        </StatusBadge>,
                                        <div
                                            key="destination"
                                            className="flex flex-col"
                                        >
                                            <span className="text-xs">
                                                {request.bankName ?? "—"}
                                            </span>
                                            {request.bankAccountNumber ? (
                                                <span className="font-mono text-xs text-muted-foreground">
                                                    {request.bankAccountNumber}
                                                </span>
                                            ) : null}
                                        </div>,
                                        <span
                                            key="amount"
                                            className="whitespace-nowrap tabular-nums"
                                        >
                                            <Money
                                                value={formatIdr(
                                                    Number(request.netAmount)
                                                )}
                                            />
                                        </span>,
                                        <span
                                            key="paid"
                                            className="text-xs text-muted-foreground"
                                        >
                                            {request.paidAt
                                                ? DATE_FORMAT.format(
                                                      new Date(request.paidAt)
                                                  )
                                                : "—"}
                                        </span>,
                                    ],
                                }))}
                            />
                        )}

                        {requests.some(
                            (request) =>
                                request.status === "REJECTED" && request.rejectionReason
                        ) ? (
                            <div className="mt-4 flex flex-col gap-2">
                                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                    Alasan penolakan
                                </span>
                                {requests
                                    .filter(
                                        (request) =>
                                            request.status === "REJECTED" &&
                                            request.rejectionReason
                                    )
                                    .slice(0, 5)
                                    .map((request) => (
                                        <p
                                            key={request.id}
                                            className="rounded-md bg-destructive/10 p-3 text-xs leading-relaxed"
                                        >
                                            {request.settlementNumber}:{" "}
                                            {request.rejectionReason}
                                        </p>
                                    ))}
                            </div>
                        ) : null}
                    </SectionCard>
                </div>
            </div>
        </div>
    );
}
