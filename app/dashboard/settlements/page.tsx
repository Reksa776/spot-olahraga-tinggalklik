import { PERMISSIONS, getAuthzScope } from "@/lib/authz";
import { organizerIdsWith } from "@/lib/dashboard/scope";
import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { SettlementPrepareForm } from "@/components/dashboard/SettlementPrepareForm";
import { prisma } from "@/lib/prisma";
import { listSettlements } from "@/lib/ticketing/settlement/service";
import { SETTLEMENT_STATUSES } from "@/lib/ticketing/settlement/validation";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Pencairan PIC — the operator's settlement worklist (Phase 5 / V1).
 *
 * ONE surface drives the whole life of a manual-transfer payout. Preparing (top of the
 * page) snapshots nothing by hand: it claims the PIC's EARNED fee rows for one period, and
 * the figure shown everywhere is that claim's net. Every row deep-links to a detail page
 * with the lifecycle actions; the amount cell always shows `netAmount`, and the bank
 * account is always the masked `••••` + last four.
 *
 * The read is tenant-scoped by the REAL decider: `listSettlements` resolves the actor's
 * `settlement.prepare` tenants (or refuses a forged `organizerId` as 404), so an actor
 * with no settleable tenant simply sees an empty state — never another organizer's payout.
 *
 * ── STATUS FILTER ───────────────────────────────────────────────────────────────────
 * `?status=` mirrors the settlement enums. An unknown value is ignored (the page never
 * builds a query the schema would reject), exactly like the refunds board.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const STATUS_TONE: Record<string, Tone> = {
    DRAFT: "neutral",
    PENDING_APPROVAL: "pending",
    APPROVED: "info",
    PAID: "success",
    FAILED: "error",
    CANCELLED: "neutral",
};

function parseStatus(
    value: string | undefined
): (typeof SETTLEMENT_STATUSES)[number] | null {
    return value && (SETTLEMENT_STATUSES as readonly string[]).includes(value)
        ? (value as (typeof SETTLEMENT_STATUSES)[number])
        : null;
}

export default async function DashboardSettlementsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string; page?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const status = parseStatus(params.status);
    const page = params.page ? Number(params.page) : 1;

    const [result, organizers, pics] = await Promise.all([
        listSettlements(scope, {
            status: status ?? undefined,
            page,
            limit: 20,
        }),
        (async () => {
            const ids = organizerIdsWith(scope, PERMISSIONS.SETTLEMENT_PREPARE);

            if (ids.length === 0) {
                return [];
            }

            const rows = await prisma.organizer.findMany({
                where: { id: { in: ids } },
                select: { id: true, name: true },
                orderBy: { name: "asc" },
            });

            return rows;
        })(),
        prisma.pICProfile.findMany({
            where: {
                status: "ACTIVE",
                bankName: { not: null },
                bankAccountName: { not: null },
                bankAccountNumber: { not: null },
            },
            select: { id: true, displayName: true, picCode: true },
            orderBy: { displayName: "asc" },
            take: 500,
        }),
    ]);

    const totalPages = Math.max(1, Math.ceil(result.total / 20));

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pencairan PIC"
                description="Pembayaran fee PIC secara transfer bank manual, dengan kontrol sistem: siapkan, ajukan, setujui, unggah bukti transfer, lalu tandai dibayar. Pencairan hanya menjadi PAID setelah bukti transfer tercatat. Setiap langkah keuangan diverifikasi hak akses dan pemisahan tugas dari dalam."
            />

            <SettlementPrepareForm
                organizers={organizers}
                pics={pics.map((pic) => ({
                    id: pic.id,
                    name: pic.displayName,
                    picCode: pic.picCode,
                }))}
            />

            <DataTable
                minWidth={1100}
                empty={
                    <EmptyBlock
                        title={
                            status
                                ? `Belum ada pencairan ${status}`
                                : "Belum ada pencairan"
                        }
                        description="Pencairan yang disiapkan akan muncul di sini. Gunakan formulir di atas untuk menyiapkan pencairan baru."
                    />
                }
                columns={[
                    { header: "Pencairan" },
                    { header: "PIC" },
                    { header: "Periode" },
                    { header: "Jumlah dibayar", align: "right" },
                    { header: "Status" },
                    { header: "Bank" },
                    { header: "Dibuat" },
                ]}
                rows={result.items.map((settlement) => ({
                    key: settlement.id,
                    cells: [
                        <TextLink
                            key="number"
                            href={`/dashboard/settlements/${settlement.id}`}
                        >
                            <span className="font-mono text-xs">
                                {settlement.settlementNumber}
                            </span>
                        </TextLink>,
                        <div className="flex flex-col" key="pic">
                            <span className="text-sm font-semibold">
                                {settlement.picDisplayName ?? "—"}
                            </span>
                            {settlement.picCode ? (
                                <span className="text-xs text-muted-foreground">
                                    {settlement.picCode}
                                </span>
                            ) : null}
                        </div>,
                        <div className="flex flex-col" key="period">
                            <span className="text-xs">
                                {DATE_FORMAT.format(new Date(settlement.periodStart))}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                s.d. {DATE_FORMAT.format(new Date(settlement.periodEnd))}
                            </span>
                        </div>,
                        <span
                            className="text-sm font-semibold tabular-nums"
                            key="amount"
                        >
                            {formatIdr(Number(settlement.netAmount))}
                        </span>,
                        <StatusBadge
                            key="status"
                            tone={STATUS_TONE[settlement.status] ?? "neutral"}
                        >
                            {settlement.status}
                        </StatusBadge>,
                        <div className="flex flex-col" key="bank">
                            {settlement.bankName ? (
                                <span className="text-xs">{settlement.bankName}</span>
                            ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                            )}
                            {settlement.bankAccountNumber ? (
                                <span className="font-mono text-xs text-muted-foreground">
                                    {settlement.bankAccountNumber}
                                </span>
                            ) : null}
                        </div>,
                        <span
                            key="created"
                            className="text-xs text-muted-foreground"
                        >
                            {DATE_FORMAT.format(new Date(settlement.createdAt))}
                        </span>,
                    ],
                }))}
                footer={
                    <LinkPagination
                        page={page}
                        totalPages={totalPages}
                        basePath="/dashboard/settlements"
                        query={{ status: params.status }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}