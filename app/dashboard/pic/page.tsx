import { BarChart3, CalendarDays, Receipt } from "lucide-react";

import PicAssignmentManager from "@/components/organizer/PicAssignmentManager";
import PicManager, { type PicRow } from "@/components/platform/PicManager";
import CopyLinkButton from "@/components/dashboard/CopyLinkButton";
import {
    AccountStandingNotice,
    picStandingNotice,
} from "@/components/dashboard/AccountStandingNotice";
import {
    AccessDeniedPanel,
    DataRow,
    DataTable,
    EmptyBlock,
    InfoNote,
    Money,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { PERMISSIONS, getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import { hasOrganizerPermission, hasPlatformPermission } from "@/lib/dashboard/scope";
import {
    findActivePicProfile,
    findPicProfileStanding,
    getMyPicOverview,
    getMyPicProfile,
    listMyAttributions,
    listMyFeeLedger,
    listMyPicAssignments,
    listMyReferralLinks,
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

export default async function DashboardPicPage() {
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
        return <PicSelfServiceSection userId={scope.userId} />;
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
 * value.
 */
async function PicSelfServiceSection({ userId }: { userId: string }) {
    type SelfServiceView = {
        profile: Awaited<ReturnType<typeof getMyPicProfile>>;
        overview: Awaited<ReturnType<typeof getMyPicOverview>>;
        assignments: Awaited<ReturnType<typeof listMyPicAssignments>>;
        attributions: Awaited<ReturnType<typeof listMyAttributions>>;
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
            ledgerEntries,
            requests,
            settleable,
            referralLinks,
        ] = await Promise.all([
            getMyPicProfile(userId),
            getMyPicOverview(userId),
            listMyPicAssignments(userId),
            listMyAttributions(userId),
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
        ledgerEntries,
        requests,
        settleable,
        referralLinks,
    } = view;

    const noAssignments = assignments.length === 0;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Ringkasan PIC"
                description={`Ringkasan penjualan untuk ${profile.displayName} (${profile.picCode}). Semua angka berasal dari data yang sudah diposting: atribusi dihitung per pesanan dan angka fee dihitung dari ledger.`}
            />

            <StatGrid>
                <StatCard
                    label="Event Ditugaskan"
                    value={overview.assignedEvents}
                    hint={`${overview.totalAssignments} total penugasan`}
                    icon={<CalendarDays size={18} />}
                />
                <StatCard
                    label="Pesanan Atribusi"
                    value={overview.attributedOrders}
                    hint="Dari seluruh penugasan, semua status"
                    icon={<Receipt size={18} />}
                />
                <StatCard
                    label="Tiket Terjual"
                    value={overview.ticketsSold}
                    hint="Pesanan berstatus lunas"
                    icon={<BarChart3 size={18} />}
                />
                <StatCard
                    label="Fee Bersih"
                    value={formatIdr(Number(overview.netFee))}
                    hint="Kredit dikurangi pembatalan"
                    tone="success"
                    icon={<BarChart3 size={18} />}
                />
            </StatGrid>

            <div id="events" className="scroll-mt-16 flex flex-col gap-6">
                <SectionCard
                    title="Event Saya"
                    description="Event yang kamu ditugaskan sebagai penanggung jawab penjualan."
                >
                    {noAssignments ? (
                        <EmptyBlock
                            title="Belum ada event yang ditugaskan."
                            description="Hubungi admin platform atau penyelenggara untuk ditugaskan ke event."
                        />
                    ) : (
                        <DataTable
                            columns={[
                                { header: "Event" },
                                { header: "Status Event" },
                                { header: "Penugasan" },
                                { header: "Ditugaskan", align: "right" },
                            ]}
                            rows={assignments.map((assignment) => ({
                                key: assignment.id,
                                cells: [
                                    <div key="title" className="min-w-0">
                                        <p className="truncate text-sm font-semibold leading-tight">
                                            {assignment.eventTitle}
                                        </p>
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
                                    assignment.revokedAt
                                        ? DATE_FORMAT.format(new Date(assignment.revokedAt))
                                        : DATE_FORMAT.format(new Date(assignment.assignedAt)),
                                ],
                            }))}
                        />
                    )}
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

                <SectionCard
                    title="Atribusi Terbaru"
                    description="Pesanan yang mencatat penjualan atas namamu. Atribusi dicatat saat checkout, sebelum pembayaran lunas."
                >
                    {attributions.length === 0 ? (
                        <EmptyBlock
                            title="Belum ada penjualan dari referral Anda."
                            description="Bagikan tautan referral untuk mulai mendapatkan atribusi."
                        />
                    ) : (
                        <DataTable
                            columns={[
                                { header: "No. Pesanan" },
                                { header: "Event" },
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
                                    <Money key="total" value={formatIdr(Number(attribution.orderTotal))} />,
                                    DATE_FORMAT.format(
                                        new Date(attribution.capturedAt)
                                    ),
                                ],
                            }))}
                        />
                    )}
                </SectionCard>

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
                        meta="Kredit dari entri fee yang diposting"
                        trailing={
                            <Money value={formatIdr(Number(overview.feeEarned))} />
                        }
                    />
                    <DataRow
                        title="Fee Pembatalan"
                        meta="Debit dari entri pembatalan"
                        trailing={
                            <Money value={formatIdr(Number(overview.feeReversed))} />
                        }
                    />
                    <DataRow
                        title="Fee Bersih"
                        trailing={
                            <Money value={formatIdr(Number(overview.netFee))} />
                        }
                    />
                    <div className="pt-2">
                        <InfoNote>
                            Angka ini berasal dari ledger append-only. Pencairan dikelola
                            penyelenggara: setelah disiapkan, disetujui, dan dibayar,
                            saldonya muncul sebagai debit PAYOUT di ledger di bawah.
                        </InfoNote>
                    </div>
                </SectionCard>

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

                <SectionCard
                    title="Pencairan"
                    description="Ajukan pencairan fee kamu; penyelenggara meninjau, melakukan transfer bank manual, lalu mencatatnya. Status menjadi PAID hanya setelah bukti transfer tercatat. Jumlah yang diajukan dihitung server dari fee yang belum dicairkan."
                    actions={<PicPayoutRequestDialog organizers={settleable} />}
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
                                        {request.status}
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
    );
}
