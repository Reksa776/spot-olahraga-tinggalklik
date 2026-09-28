import type { RefundStatus } from "@prisma/client";

import { FilterBar } from "@/components/dashboard/filters/FilterBar";
import { buildFilterField } from "@/components/dashboard/filters/filter-types";
import { RefundDecisionActions } from "@/components/dashboard/RefundDecisionActions";
import { RefundEvidenceActions } from "@/components/dashboard/RefundEvidenceActions";
import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
    StatusBadge,
    TextLink,
    type Tone,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { REFUND_STATUS_LABELS } from "@/lib/dashboard/filter-options";
import {
    REFUND_NEEDS_HANDLING_STATUSES,
    listDashboardRefunds,
} from "@/lib/dashboard/refunds";
import { refundStaffEvidenceUrl } from "@/lib/ticketing/refunds/payload";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Refunds.
 *
 * The staff surface for the refund lifecycle (Phase 10B, re-scoped by Phase 18B): it lists
 * the refunds a tenant has and offers the decisions the lifecycle allows — `PENDING` →
 * approve/reject, `APPROVED` → claim for processing, `PROCESSING` → record the bank transfer
 * (which settles) or fail it. Every button posts to the authorized API routes; this page only
 * draws them. The amount shown is the confirmed amount once a refund has settled and the
 * requested amount before that, so a completed refund never appears to have moved more or
 * less than it did.
 *
 * ── "PERLU DITANGANI" IS A PILL, NOT A NEW URL FORMAT ───────────────────────────
 * The operator worklist is `PENDING` ∪ `PROCESSING` — the SAME union the overview's "Refund perlu
 * ditangani" tile counts — and it is still expressed as the repeated parameter
 * (`?status=PENDING&status=PROCESSING`) the read model and `LinkPagination` already handle. The
 * pill's members are passed by reference from `REFUND_NEEDS_HANDLING_STATUSES`, so the label and
 * the predicate cannot drift. The individual lifecycle statuses remain single-value pills.
 *
 * ── THE MANUAL RAIL NEEDS RECONCILIATION EVIDENCE ON THIS PAGE ──────────────────
 * Because the production rail is a manual bank transfer (D-P17-04 = B), the operator cannot
 * look to a provider dashboard for the truth. Two columns carry it instead: the transfer
 * reference + evidence note recorded at settlement, and how long a refund has been
 * `PROCESSING`. `PROCESSING` is shown as an outstanding task, never as "money sent" — only
 * `REFUNDED`, which requires recorded evidence, claims that.
 *
 * An actor without `order.read.tenant` in any organizer gets the empty state (the read model
 * resolves to an empty filter, never an unscoped query).
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Refunds" };

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const STATUS_TONE: Record<string, Tone> = {
    PENDING: "pending",
    APPROVED: "info",
    PROCESSING: "info",
    REFUNDED: "success",
    REJECTED: "neutral",
    FAILED: "error",
};

const VALID_STATUSES: RefundStatus[] = [
    "PENDING",
    "APPROVED",
    "REJECTED",
    "PROCESSING",
    "REFUNDED",
    "FAILED",
];

/**
 * How long a refund has been `PROCESSING`, as a short human string.
 *
 * Deliberately coarse (minutes → hours → days): this is a worklist age, not a timestamp, and
 * the exact `processedAt` is shown next to it. Nothing here is a deadline or an SLA — the
 * product decision leaves a stuck refund to an operator, and inventing a threshold would
 * invent a policy.
 */
function processingAge(from: Date | null, now: Date): string | null {
    if (!from) {
        return null;
    }

    const minutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000));

    if (minutes < 60) {
        return `${minutes} menit`;
    }

    const hours = Math.floor(minutes / 60);

    if (hours < 24) {
        return `${hours} jam`;
    }

    return `${Math.floor(hours / 24)} hari`;
}

function parseStatuses(value: string | string[] | undefined): RefundStatus[] {
    if (value === undefined) {
        return [];
    }

    const values = Array.isArray(value) ? value : [value];
    const seen = new Set<RefundStatus>();

    for (const candidate of values) {
        if ((VALID_STATUSES as readonly string[]).includes(candidate)) {
            seen.add(candidate as RefundStatus);
        }
    }

    return [...seen];
}

/** Set equality (order-independent), used to recognise the "Perlu Ditangani" worklist. */
function sameStatusSet(
    selected: readonly RefundStatus[],
    expected: readonly RefundStatus[]
): boolean {
    return (
        selected.length === expected.length &&
        expected.every((status) => selected.includes(status))
    );
}

export default async function DashboardRefundsPage({
    searchParams,
}: {
    searchParams: Promise<{ status?: string | string[]; page?: string; q?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    /*
     * A repeated `?status=` is how the "Perlu Ditangani" union is expressed
     * (`PENDING` + `PROCESSING`). Every value is narrowed against `RefundStatus` before it reaches
     * the scoped read, and an invalid value is dropped rather than forwarded.
     */
    const statuses = parseStatuses(params.status);
    const isNeedsHandling = sameStatusSet(
        statuses,
        REFUND_NEEDS_HANDLING_STATUSES
    );
    const page = params.page ? Number(params.page) : 1;
    // One clock read for the whole render, so every "PROCESSING for N" cell is consistent.
    const now = new Date();

    const result = await listDashboardRefunds(scope, {
        statuses,
        q: params.q ?? null,
        page,
        limit: 20,
    });

    const statusField = buildFilterField({
        name: "status",
        label: "Status refund",
        allLabel: "Semua status",
        values: statuses,
        members: VALID_STATUSES,
        labels: REFUND_STATUS_LABELS,
        // The worklist is a repeated parameter, exactly as the KPI tile deep-links it.
        union: {
            value: "needs_handling",
            label: "Perlu Ditangani",
            statuses: REFUND_NEEDS_HANDLING_STATUSES,
        },
    });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Refund"
                description="Permintaan pengembalian dana dari pembeli. Setujui atau tolak permintaan, mulai proses yang sudah disetujui, lalu catat bukti transfer bank untuk menyelesaikannya. Refund hanya menjadi REFUNDED setelah bukti transfer dicatat. Pemohon tidak dapat memutuskan permintaannya sendiri."
            />

            <FilterBar
                basePath="/dashboard/refunds"
                current={{
                    status: statuses.length > 0 ? statuses : undefined,
                    q: params.q,
                }}
                fields={[statusField]}
                search={{
                    label: "Cari refund",
                    placeholder: "Nomor refund, pesanan, atau pembeli",
                    value: params.q,
                }}
            />

            <DataTable
                minWidth={1240}
                empty={
                    <EmptyBlock
                        title={
                            statuses.length === 0
                                ? "Belum ada permintaan refund"
                                : isNeedsHandling
                                  ? "Tidak ada refund yang perlu ditangani"
                                  : `Tidak ada refund berstatus ${statuses.join(", ")}`
                        }
                        description="Permintaan refund dari pembeli akan muncul di sini."
                    />
                }
                columns={[
                    { header: "Refund" },
                    { header: "Pesanan" },
                    { header: "Pembeli" },
                    { header: "Tiket", align: "right" },
                    { header: "Jumlah", align: "right" },
                    { header: "Status" },
                    { header: "Bukti transfer" },
                    { header: "Diproses" },
                    { header: "Dibuat" },
                    { header: "Tindakan", align: "right" },
                ]}
                rows={result.items.map((refund) => {
                    const settled = refund.status === "REFUNDED";
                    const amount = settled
                        ? refund.confirmedAmount
                        : refund.requestedAmount;
                    const age =
                        refund.status === "PROCESSING"
                            ? processingAge(refund.processedAt, now)
                            : null;

                    return {
                        key: String(refund.id),
                        cells: [
                            <span className="font-mono text-xs" key="number">
                                {refund.refundNumber ?? `#${refund.id}`}
                            </span>,
                            refund.eventOrder ? (
                                <TextLink
                                    key="order"
                                    href={`/dashboard/orders/${refund.eventOrder.orderNumber}`}
                                >
                                    <span className="font-mono text-xs">
                                        {refund.eventOrder.orderNumber}
                                    </span>
                                </TextLink>
                            ) : (
                                <span key="order" className="text-xs text-muted-foreground">
                                    —
                                </span>
                            ),
                            <div className="flex flex-col" key="buyer">
                                <span className="text-sm font-semibold">
                                    {refund.eventOrder?.buyerName ?? "—"}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                    {refund.eventOrder?.buyerEmail ?? "—"}
                                </span>
                            </div>,
                            <span className="text-sm tabular-nums" key="tickets">
                                {refund._count.items}
                            </span>,
                            <span
                                className="text-sm font-semibold tabular-nums"
                                key="amount"
                            >
                                {formatIdr(Number(amount))}
                            </span>,
                            <StatusBadge
                                key="status"
                                tone={STATUS_TONE[refund.status] ?? "neutral"}
                            >
                                {refund.status}
                            </StatusBadge>,
                            <div className="flex max-w-64 flex-col" key="evidence">
                                {refund.providerRef ? (
                                    <span className="font-mono text-xs">
                                        {refund.providerRef}
                                    </span>
                                ) : null}
                                {refund.evidenceNote ? (
                                    <span className="text-xs text-muted-foreground">
                                        {refund.evidenceNote}
                                    </span>
                                ) : null}
                                {refund.failureReason ? (
                                    <span className="text-xs text-destructive">
                                        {refund.failureReason}
                                    </span>
                                ) : null}
                                {!refund.providerRef &&
                                !refund.evidenceNote &&
                                !refund.failureReason ? (
                                    <span className="text-xs text-muted-foreground">
                                        —
                                    </span>
                                ) : null}

                                {/*
                                 * The transfer-evidence FILE, attached through the existing
                                 * organizer route. The href is built SERVER-side from the row
                                 * (`refundStaffEvidenceUrl`), never assembled by the client,
                                 * and the control only offers attach while the refund is open.
                                 */}
                                <RefundEvidenceActions
                                    refundId={refund.id}
                                    status={refund.status}
                                    evidenceUrl={
                                        refund.evidenceFileKey
                                            ? refundStaffEvidenceUrl(
                                                  refund.id,
                                                  refund.evidenceFileKey
                                              )
                                            : null
                                    }
                                />
                            </div>,
                            <div className="flex flex-col" key="processing">
                                {refund.processedAt ? (
                                    <span className="text-xs text-muted-foreground">
                                        {DATE_FORMAT.format(refund.processedAt)}
                                    </span>
                                ) : (
                                    <span className="text-xs text-muted-foreground">
                                        —
                                    </span>
                                )}
                                {age ? (
                                    <span className="text-xs font-medium">
                                        {age} berjalan
                                    </span>
                                ) : null}
                            </div>,
                            <span
                                key="created"
                                className="text-xs text-muted-foreground"
                            >
                                {DATE_FORMAT.format(refund.createdAt)}
                            </span>,
                            <RefundDecisionActions
                                key="actions"
                                refundId={refund.id}
                                status={refund.status}
                            />,
                        ],
                    };
                })}
                footer={
                    <LinkPagination
                        page={page}
                        totalPages={result.pagination.totalPages}
                        basePath="/dashboard/refunds"
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
