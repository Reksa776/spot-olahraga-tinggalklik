import Link from "next/link";

import { formatPriceFrom } from "@/lib/ticketing/ui/format";

type Props = {
    priceFrom: number | null;
    /** Where the CTA takes the buyer — the ticket picker on the same page. */
    href: string;
    ctaLabel?: string;
    /** Why the CTA is unavailable, when it is. */
    disabledReason?: string | null;
};

/**
 * The phone-sized purchase bar.
 *
 * Shown below `lg` only, where the ticket picker is far down a long page and a buyer who has
 * decided should not have to scroll back to it. Hidden from `lg` up, because the picker's own card
 * is already sticky beside the description at that width.
 *
 * Only present when the CTA would work: a sticky bar over an event whose tickets are not on sale
 * would occupy a fifth of the viewport to say nothing useful. The price is the server's own
 * `priceFrom`, formatted by the shared helper — never recomputed from a tier list.
 *
 * `env(safe-area-inset-bottom)` is applied through `pb-[max(...)]` so the bar clears the home
 * indicator on iOS instead of sitting under it.
 */
export default function StickyBuyBar({
    priceFrom,
    href,
    ctaLabel = "Pilih tiket",
    disabledReason,
}: Props) {
    return (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink-100 bg-white/95 backdrop-blur lg:hidden">
            <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
                <div className="min-w-0">
                    <p className="text-[0.65rem] font-bold tracking-wide text-ink-400 uppercase">
                        {disabledReason ? "Status tiket" : "Harga tiket"}
                    </p>
                    <p className="truncate text-sm font-extrabold text-ink-900">
                        {disabledReason ?? formatPriceFrom(priceFrom)}
                    </p>
                </div>

                {disabledReason ? (
                    <span
                        aria-disabled
                        className="shrink-0 rounded-xl bg-ink-100 px-5 py-3 text-sm font-bold text-ink-400"
                    >
                        {ctaLabel}
                    </span>
                ) : (
                    <Link
                        href={href}
                        className="shrink-0 rounded-xl bg-brand-600 px-5 py-3 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                        {ctaLabel}
                    </Link>
                )}
            </div>
        </div>
    );
}
