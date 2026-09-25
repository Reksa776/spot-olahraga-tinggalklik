import type { Metadata } from "next";
import SiteShell from "@/components/ticketing/SiteShell";
import FaqContent from "./FaqContent";

export const metadata: Metadata = {
    title: "FAQ | Pertanyaan Umum",
    description:
        "Jawaban atas pertanyaan umum seputar event, pembelian tiket, pembayaran, dan pengembalian dana di TinggalKlik.Co.",
    openGraph: {
        title: "FAQ | Pertanyaan Umum",
        description:
            "Jawaban atas pertanyaan umum seputar event, pembelian tiket, pembayaran, dan pengembalian dana.",
    },
};

export default function FaqPage() {
    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        Pertanyaan Umum
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm text-ink-500">
                        Temukan jawaban atas pertanyaan yang
                        sering ditanyakan oleh pengunjung kami.
                    </p>
                </div>
            </div>

            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
                <FaqContent />
            </div>
        </SiteShell>
    );
}