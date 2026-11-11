import { notFound } from "next/navigation";

import { PicEventBlastForm } from "@/components/dashboard/PicEventBlastForm";
import {
    InfoNote,
    PageHeader,
    SectionCard,
    TextLink,
} from "@/components/dashboard/primitives";
import { requireAuth } from "@/lib/authz";
import {
    listPicBlastHistory,
    MAX_BLAST_RECIPIENTS,
    requireAssignedPicEvent,
} from "@/lib/pic/blast";

export const dynamic = "force-dynamic";

export const metadata = { title: "Blast Peserta" };

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

    const history = await listPicBlastHistory(eventId);

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

            {history.hasMore ? (
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
                title={`Peserta (${history.recipients.length})`}
                description={`${history.scannedOrders} pesanan diperiksa · ${history.withoutPhone} tanpa nomor valid · ${history.duplicatePhones} nomor duplikat digabung.`}
            >
                <p className="text-sm text-muted-foreground">
                    Penerima adalah pembeli dengan pesanan lunas dan tiket aktif. Peserta yang check-in maupun yang belum check-in tetap termasuk.
                </p>
            </SectionCard>

            <SectionCard title="Tautan dokumen">
                <PicEventBlastForm
                    eventId={context.event.id}
                    initialHistory={history}
                />
            </SectionCard>
        </div>
    );
}
