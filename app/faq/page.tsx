import type { Metadata } from "next";
import SiteShell from "@/components/ticketing/SiteShell";
import FaqContent from "./FaqContent";

/**
 * Only the FEATURE title: the root layout's `title.template` composes "FAQ — <platform name>".
 *
 * There is deliberately no `openGraph` block. Next.js inherits the resolved title and the
 * `description` below into `openGraph` when a page does not set them, so a second copy here could
 * only ever drift from the tab title.
 */
export const metadata: Metadata = {
    title: "FAQ",
    description:
        "Jawaban atas pertanyaan umum seputar event, pembelian tiket, pembayaran, dan pengembalian dana di TinggalKlik.Co.",
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