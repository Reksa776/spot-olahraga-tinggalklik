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
                    description={`Bagikan tautan dokumen Google Drive kepada pembeli tiket ${context.event.title}.`}
                />
            </div>

            {participants.hasMore ? (
                <InfoNote tone="warn">
                    Jumlah peserta melebihi batas {MAX_BLAST_RECIPIENTS} pesanan per blast. Hubungi admin untuk mengirim ke seluruh peserta.
                </InfoNote>
            ) : null}

            <InfoNote>
                Pesan dikirim kepada pembeli dengan pesanan <strong>lunas</strong> dan setidaknya
                satu tiket terbit. Status check-in tidak menjadi syarat; tiket void atau refund
                tidak disertakan. Nomor yang digunakan adalah WhatsApp dari form pemesanan.
                Pastikan tautan Drive dapat dibuka oleh penerima.
            </InfoNote>

            <SectionCard
                title={`Peserta (${participants.recipients.length})`}
                description={`${participants.scannedOrders} pesanan diperiksa · ${participants.withoutPhone} tanpa nomor valid · ${participants.duplicatePhones} nomor duplikat digabung.`}
            >
                {participants.recipients.length === 0 ? (
                    <EmptyBlock
                        title="Belum ada peserta yang bisa dihubungi"
                        description="Penerima muncul setelah pesanan lunas dan tiket diterbitkan."
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

            <SectionCard title="Tautan dokumen">
                <PicEventBlastForm
                    eventId={context.event.id}
                    recipientCount={participants.recipients.length}
                />
            </SectionCard>
        </div>
    );
}
