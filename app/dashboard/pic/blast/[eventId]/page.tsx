import { notFound } from "next/navigation";

import { PicEventBlastForm } from "@/components/dashboard/PicEventBlastForm";
import {
    DataTable,
    EmptyBlock,
    InfoNote,
    PageHeader,
    SectionCard,
    TextLink,
} from "@/components/dashboard/primitives";
import { requireAuth } from "@/lib/authz";
import {
    listPicBlastParticipants,
    MAX_BLAST_RECIPIENTS,
    requireAssignedPicEvent,
} from "@/lib/pic/blast";

export const dynamic = "force-dynamic";

export const metadata = { title: "Blast Peserta" };

/** Never render a full phone number in a list a PIC can screenshot. */
function maskPhone(phone: string): string {
    return phone.length <= 6
        ? "•••"
        : `${phone.slice(0, 4)}••••${phone.slice(-3)}`;
}

export default async function PicBlastPage({
    params,
}: {
    params: Promise<{ eventId: string }>;
}) {
    const scope = await requireAuth();
    const { eventId } = await params;

    let context: Awaited<ReturnType<typeof requireAssignedPicEvent>>;

    try {
        context = await requireAssignedPicEvent(scope.userId, eventId);
    } catch {
        notFound();
    }

    const participants = await listPicBlastParticipants(eventId);

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <TextLink href="/dashboard/pic#events">
                    ← Kembali ke event saya
                </TextLink>
                <PageHeader
                    eyebrow="PIC"
                    title="Blast pasca-acara"
                    description={`Kirim dokumen dan pesan kepada peserta ${context.event.title} melalui WhatsApp.`}
                />
            </div>

            {participants.hasMore ? (
                <InfoNote tone="warn">
                    Peserta melebihi {MAX_BLAST_RECIPIENTS}. Blast akan mengirim ke{" "}
                    {MAX_BLAST_RECIPIENTS} pertama. Jalankan ulang untuk sisanya.
                </InfoNote>
            ) : null}

            <InfoNote>
                Peserta diambil dari pesanan <strong>lunas</strong> yang memiliki tiket
                berstatus terbit atau sudah check-in. Nomor diambil dari nomor pembeli pada
                pesanan (fallback ke nomor akun) dan dinormalisasi ke format 62…; nomor tidak
                valid dilewati, bukan ditebak. Pengiriman mengikuti antrean notifikasi yang
                sama dengan reminder dan bukti pembelian.
            </InfoNote>

            <SectionCard
                title={`Peserta (${participants.recipients.length})`}
                description={`${participants.scannedOrders} pesanan diperiksa · ${participants.withoutPhone} tanpa nomor valid · ${participants.duplicatePhones} nomor duplikat digabung.`}
            >
                {participants.recipients.length === 0 ? (
                    <EmptyBlock
                        title="Belum ada peserta yang bisa dihubungi"
                        description="Peserta muncul setelah pembayaran lunas dan tiket diterbitkan."
                    />
                ) : (
                    <DataTable
                        columns={[
                            { header: "Peserta" },
                            { header: "Nomor pesanan" },
                            { header: "WhatsApp" },
                        ]}
                        rows={participants.recipients.map((recipient) => ({
                            key: recipient.orderId,
                            cells: [
                                recipient.buyerName,
                                recipient.orderNumber,
                                <span
                                    key="phone"
                                    className="font-mono text-xs text-muted-foreground"
                                >
                                    {maskPhone(recipient.phone)}
                                </span>,
                            ],
                        }))}
                    />
                )}
            </SectionCard>

            <SectionCard title="Dokumen & pesan">
                <PicEventBlastForm
                    eventId={context.event.id}
                    eventTitle={context.event.title}
                />
            </SectionCard>
        </div>
    );
}
