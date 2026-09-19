import Link from "next/link";
import { notFound } from "next/navigation";

import {
    DataRow,
    DataTable,
    EmptyBlock,
    PageHeader,
    SectionCard,
    StatCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";
import { Button } from "@/components/dashboard/ui/button";
import { getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import { getPicDetail } from "@/lib/pic/service";

/**
 * One PIC: profile, per-event assignments and the posted fee ledger.
 *
 * `getPicDetail` enforces the platform `pic.manage` permission. This view shows an outside
 * referrer's figures, which is why it is a platform surface rather than an organizer one —
 * an organizer needs to know WHO is assigned to its event, not what the referrer earns
 * elsewhere.
 *
 * The ledger is displayed, never edited: `PICFeeLedger` is append-only, so a correction is
 * a new REVERSAL/ADJUSTMENT row posted by the settlement work, and this page must not offer
 * a way to rewrite history.
 *
 * The bank account number is MASKED. The full value is a payment credential; the operator
 * needs to recognise the account, not to read it out of a screen or a screenshot.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

const STATUS_TONE: Record<string, Tone> = {
    PENDING: "pending",
    ACTIVE: "success",
    SUSPENDED: "warn",
    REJECTED: "error",
};

const STATUS_LABEL: Record<string, string> = {
    PENDING: "Menunggu",
    ACTIVE: "Aktif",
    SUSPENDED: "Ditangguhkan",
    REJECTED: "Ditolak",
};

function formatFeeRate(bp: number): string {
    return bp === 0
        ? "Ikut default"
        : `${(bp / 100).toLocaleString("id-ID", { maximumFractionDigits: 2 })}%`;
}

function formatRupiah(value: string): string {
    const numeric = Number(value);

    if (!Number.isFinite(numeric)) {
        return value;
    }

    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    }).format(numeric);
}

/** Keep the last four digits only — enough to recognise, not enough to reuse. */
function maskAccountNumber(value: string | null): string {
    if (!value) {
        return "—";
    }

    const digits = value.replace(/\s+/g, "");

    if (digits.length <= 4) {
        return `••••${digits}`;
    }

    return `••••${digits.slice(-4)}`;
}

export default async function DashboardPicDetailPage({
    params,
}: {
    params: Promise<{ id: string }>;
}) {
    const { id } = await params;

    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let result;

    try {
        result = await getPicDetail(scope, id);
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        // An unknown id and an unauthorized caller both land here, and both should look like
        // "no such PIC" rather than like a server failure.
        notFound();
    }

    const { pic, assignments, ledger } = result;

    const ledgerTotal = ledger
        .filter((entry) => entry.direction === "CREDIT")
        .reduce((sum, entry) => sum + Number(entry.amount), 0);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard · PIC"
                title={pic.displayName}
                description={`Kode PIC ${pic.picCode} · ${pic.account.email ?? "tanpa email"}`}
                actions={
                    <Button variant="outline" asChild>
                        <Link href="/dashboard/pic">Kembali ke daftar</Link>
                    </Button>
                }
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard label="Event ditugaskan" value={pic.counts.assignments} />
                <StatCard label="Order teratribusi" value={pic.counts.orders} />
                <StatCard
                    label="Total fee (kredit)"
                    value={formatRupiah(String(ledgerTotal))}
                />
            </div>

            <SectionCard title="Profil">
                <div className="flex flex-col">
                    <DataRow
                        title="Status"
                        divider={false}
                        trailing={
                            <StatusBadge tone={STATUS_TONE[pic.status] ?? "neutral"}>
                                {STATUS_LABEL[pic.status] ?? pic.status}
                            </StatusBadge>
                        }
                    />
                    <DataRow
                        title="Tarif default"
                        meta="Dipakai bila event tidak menimpa tarif"
                        trailing={formatFeeRate(pic.defaultFeeRateBp)}
                    />
                    <DataRow
                        title="Cakupan"
                        meta="Bila aktif, PIC dapat menjual seluruh event"
                        trailing={
                            pic.canSellAllEvents
                                ? "Semua event"
                                : "Hanya event yang ditugaskan"
                        }
                    />
                    <DataRow
                        title="Disetujui"
                        trailing={
                            pic.approvedAt
                                ? DATE_FORMAT.format(new Date(pic.approvedAt))
                                : "—"
                        }
                    />
                    <DataRow
                        title="Ditangguhkan"
                        meta={pic.suspendReason ?? undefined}
                        trailing={
                            pic.suspendedAt
                                ? DATE_FORMAT.format(new Date(pic.suspendedAt))
                                : "—"
                        }
                    />
                    <DataRow title="Bank" trailing={pic.bankName ?? "—"} />
                    <DataRow title="Nama rekening" trailing={pic.bankAccountName ?? "—"} />
                    <DataRow
                        title="Nomor rekening"
                        trailing={maskAccountNumber(pic.bankAccountNumber)}
                    />
                    <DataRow title="NPWP" trailing={pic.taxId ?? "—"} />
                    <DataRow title="Telepon" trailing={pic.account.phone ?? "—"} />
                </div>
            </SectionCard>

            <SectionCard
                title="Penugasan event"
                description="Satu PIC hanya dapat ditugaskan sekali per event. Pencabutan bersifat lunak agar riwayat atribusi tetap tersimpan."
            >
                <DataTable
                    minWidth={720}
                    columns={[
                        { header: "Event" },
                        { header: "Status event" },
                        { header: "Tarif", align: "right" },
                        { header: "Ditugaskan" },
                        { header: "Dicabut" },
                        { header: "Aktif", align: "right" },
                    ]}
                    rows={assignments.map((assignment) => ({
                        key: assignment.id,
                        cells: [
                            <Link
                                key="event"
                                href={`/e/${assignment.eventSlug}`}
                                className="text-sm font-semibold text-primary hover:underline"
                            >
                                {assignment.eventTitle}
                            </Link>,
                            <span
                                key="event-status"
                                className="text-xs text-muted-foreground"
                            >
                                {assignment.eventStatus}
                            </span>,
                            <span key="fee" className="text-sm tabular-nums">
                                {assignment.feeRateBp === null
                                    ? "Ikut default"
                                    : formatFeeRate(assignment.feeRateBp)}
                            </span>,
                            <span key="assigned" className="text-sm text-muted-foreground">
                                {DATE_FORMAT.format(new Date(assignment.assignedAt))}
                            </span>,
                            <span key="revoked" className="text-sm text-muted-foreground">
                                {assignment.revokedAt
                                    ? DATE_FORMAT.format(new Date(assignment.revokedAt))
                                    : "—"}
                            </span>,
                            <StatusBadge
                                key="active"
                                tone={assignment.isActive ? "success" : "neutral"}
                            >
                                {assignment.isActive ? "Aktif" : "Dicabut"}
                            </StatusBadge>,
                        ],
                    }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada penugasan"
                            description="PIC ini belum ditugaskan ke event mana pun. Penugasan dilakukan penyelenggara dari dashboard mereka."
                        />
                    }
                />
            </SectionCard>

            <SectionCard
                title="Ledger fee"
                description="Ledger bersifat append-only: koreksi dicatat sebagai baris reversal/adjustment, bukan dengan mengubah baris lama."
            >
                <DataTable
                    minWidth={720}
                    columns={[
                        { header: "Dicatat" },
                        { header: "Tipe" },
                        { header: "Arah" },
                        { header: "Status" },
                        { header: "Jumlah", align: "right" },
                    ]}
                    rows={ledger.map((entry) => ({
                        key: entry.id,
                        cells: [
                            <span
                                key="created"
                                className="text-sm text-muted-foreground"
                            >
                                {DATE_FORMAT.format(new Date(entry.createdAt))}
                            </span>,
                            <span key="type" className="font-mono text-xs">
                                {entry.type}
                            </span>,
                            <StatusBadge
                                key="direction"
                                tone={entry.direction === "CREDIT" ? "info" : "warn"}
                            >
                                {entry.direction === "CREDIT" ? "Kredit" : "Debit"}
                            </StatusBadge>,
                            <span key="status" className="text-xs text-muted-foreground">
                                {entry.status}
                            </span>,
                            <span key="amount" className="text-sm tabular-nums">
                                {formatRupiah(entry.amount)}
                            </span>,
                        ],
                    }))}
                    empty={
                        <EmptyBlock
                            title="Belum ada entri ledger"
                            description="Fee dicatat saat order teratribusi dibayar. Belum ada entri untuk PIC ini."
                        />
                    }
                />
            </SectionCard>
        </div>
    );
}
