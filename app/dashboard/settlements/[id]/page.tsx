import { PageHeader, StatusBadge, TextLink, type Tone } from "@/components/dashboard/primitives";
import { SettlementActions } from "@/components/dashboard/SettlementActions";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/dashboard/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/dashboard/ui/table";
import { getAuthzScope } from "@/lib/authz";
import { getSettlement } from "@/lib/ticketing/settlement/service";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Pencairan PIC — detail + lifecycle actions (Phase 5 / V1).
 *
 * The operator's single view of one payout: the derived amounts (gross, deduction, net),
 * the snapshotted payee bank (masked), the evidence recorded so far (transfer reference,
 * proof, failure reason) and the claim lines. Every enabled button posts to the authorized
 * API route; the SoD and the permission set live in the service, so the person who
 * prepared a payout can click "Setujui" here and will receive the server's `FORBIDDEN`
 * rather than a silent lie.
 *
 * The tenant guard is the row's OWN organizer — this page can never be argued into showing
 * another organizer's payout by any query value.
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
    // PHASE 21 — a PIC-initiated request awaiting review, and a refused request.
    REQUESTED: "pending",
    REJECTED: "error",
};

export default async function DashboardSettlementDetailPage({
    params,
}: {
    params: Promise<{ settlementId: string }>;
}) {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const { settlementId } = await params;

    const settlement = await getSettlement(settlementId, scope);

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard · Pencairan PIC"
                title={settlement.settlementNumber}
                description={`Pencairan ${
                    settlement.picDisplayName ?? settlement.picCode ?? "PIC"
                } · periode ${DATE_FORMAT.format(
                    new Date(settlement.periodStart)
                )} s.d. ${DATE_FORMAT.format(new Date(settlement.periodEnd))}`}
            />

            <div className="flex flex-wrap items-center gap-3">
                <StatusBadge
                    tone={STATUS_TONE[settlement.status] ?? "neutral"}
                >
                    {settlement.status}
                </StatusBadge>

                <SettlementActions
                    settlementId={settlement.id}
                    status={
                        settlement.status as
                            | "DRAFT"
                            | "PENDING_APPROVAL"
                            | "APPROVED"
                            | "REQUESTED"
                    }
                    proofAvailable={settlement.proofAvailable}
                />
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle>Ringkasan</CardTitle>
                        <CardDescription>
                            Jumlah diturunkan dari fee EARNED PIC pada periode; tidak ada
                            nominal yang diketik.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                                Bruto
                            </span>
                            <span className="text-sm tabular-nums">
                                {formatIdr(Number(settlement.grossAmount))}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                                Potongan (pembatalan)
                            </span>
                            <span className="text-sm tabular-nums">
                                −{formatIdr(Number(settlement.deductionAmount))}
                            </span>
                        </div>
                        <div className="flex items-center justify-between border-t pt-3">
                            <span className="text-sm font-semibold">Jumlah dibayar</span>
                            <span className="text-lg font-bold tabular-nums">
                                {formatIdr(Number(settlement.netAmount))}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                                Metode
                            </span>
                            <span className="text-sm">
                                {settlement.method === "MANUAL_TRANSFER"
                                    ? "Transfer bank manual"
                                    : settlement.method}
                            </span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-muted-foreground">
                                Disiapkan
                            </span>
                            <span className="text-sm">
                                {DATE_FORMAT.format(new Date(settlement.preparedAt))}
                            </span>
                        </div>
                        {settlement.approvedAt ? (
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-muted-foreground">
                                    Disetujui
                                </span>
                                <span className="text-sm">
                                    {DATE_FORMAT.format(new Date(settlement.approvedAt))}
                                </span>
                            </div>
                        ) : null}
                        {settlement.paidAt ? (
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-muted-foreground">
                                    Dibayar
                                </span>
                                <span className="text-sm">
                                    {DATE_FORMAT.format(new Date(settlement.paidAt))}
                                </span>
                            </div>
                        ) : null}
                        {settlement.notes ? (
                            <p className="mt-2 rounded-md bg-muted p-3 text-xs leading-relaxed">
                                {settlement.notes}
                            </p>
                        ) : null}
                    </CardContent>
                </Card>

                <div className="flex flex-col gap-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Bank penerima</CardTitle>
                            <CardDescription>
                                Di-snapshot dari profil PIC saat penyiapan.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                            {settlement.bankName ? (
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-muted-foreground">
                                        Bank
                                    </span>
                                    <span className="text-sm">{settlement.bankName}</span>
                                </div>
                            ) : null}
                            {settlement.bankAccountName ? (
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-muted-foreground">
                                        Atas nama
                                    </span>
                                    <span className="text-sm">
                                        {settlement.bankAccountName}
                                    </span>
                                </div>
                            ) : null}
                            {settlement.bankAccountNumber ? (
                                <div className="flex items-center justify-between">
                                    <span className="text-sm text-muted-foreground">
                                        Rekening
                                    </span>
                                    <span className="font-mono text-sm">
                                        {settlement.bankAccountNumber}
                                    </span>
                                </div>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    Tidak tersedia.
                                </p>
                            )}
                        </CardContent>
                    </Card>

                    <Card>
                        <CardHeader>
                            <CardTitle>Bukti & evidence</CardTitle>
                            <CardDescription>
                                Referensi transfer dan berkas bukti manual.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-muted-foreground">
                                    Referensi transfer
                                </span>
                                <span className="font-mono text-sm">
                                    {settlement.providerReference ?? "—"}
                                </span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="text-sm text-muted-foreground">
                                    Bukti transfer
                                </span>
                                {settlement.proofAvailable && settlement.proofFileName ? (
                                    <TextLink
                                        href={`/api/organizer/settlements/${settlement.id}/proof/${encodeURIComponent(
                                            settlement.proofFileName
                                        )}`}
                                    >
                                        <span className="text-sm">Lihat bukti</span>
                                    </TextLink>
                                ) : (
                                    <span className="text-sm text-muted-foreground">
                                        —
                                    </span>
                                )}
                            </div>
                            {settlement.failureReason ? (
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm text-muted-foreground">
                                        Alasan kegagalan
                                    </span>
                                    <p className="rounded-md bg-destructive/10 p-3 text-xs leading-relaxed">
                                        {settlement.failureReason}
                                    </p>
                                </div>
                            ) : null}
                            {settlement.rejectionReason ? (
                                <div className="flex flex-col gap-1">
                                    <span className="text-sm text-muted-foreground">
                                        Alasan penolakan (terlihat oleh PIC)
                                    </span>
                                    <p className="rounded-md bg-destructive/10 p-3 text-xs leading-relaxed">
                                        {settlement.rejectionReason}
                                    </p>
                                </div>
                            ) : null}
                        </CardContent>
                    </Card>
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Line yang diklaim</CardTitle>
                    <CardDescription>
                        Baris EARNED yang dibayarkan dan baris REVERSAL yang menguranginya.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Pesanan</TableHead>
                                <TableHead>Deskripsi</TableHead>
                                <TableHead>Arah</TableHead>
                                <TableHead className="text-right">Jumlah</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {settlement.items?.map((item) => (
                                <TableRow key={item.id}>
                                    <TableCell className="font-mono text-xs">
                                        {item.orderNumber ?? "—"}
                                    </TableCell>
                                    <TableCell className="text-sm">
                                        {item.description ?? "—"}
                                    </TableCell>
                                    <TableCell>
                                        <StatusBadge
                                            tone={
                                                item.direction === "DEBIT"
                                                    ? "neutral"
                                                    : "info"
                                            }
                                        >
                                            {item.direction}
                                        </StatusBadge>
                                    </TableCell>
                                    <TableCell
                                        className={
                                            item.direction === "DEBIT"
                                                ? "text-right text-sm text-muted-foreground tabular-nums"
                                                : "text-right text-sm font-semibold tabular-nums"
                                        }
                                    >
                                        {item.direction === "DEBIT"
                                            ? `−${formatIdr(Number(item.amount))}`
                                            : formatIdr(Number(item.amount))}
                                    </TableCell>
                                </TableRow>
                            ))}
                            {!settlement.items || settlement.items.length === 0 ? (
                                <TableRow>
                                    <TableCell
                                        colSpan={4}
                                        className="text-center text-sm text-muted-foreground"
                                    >
                                        Tidak ada baris.
                                    </TableCell>
                                </TableRow>
                            ) : null}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    );
}