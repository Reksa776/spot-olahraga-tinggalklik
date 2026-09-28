import Link from "next/link";

import Reveal from "@/components/ui/Reveal";

/**
 * The heading cascade. 80ms per step — a sequence, not a queue.
 *
 * Each step is its own `Reveal` rather than one wrapper around all three, because the whole point
 * is that the heading, its sub-line and its action arrive in that order. They are `scroll` reveals,
 * so the cascade plays as the section enters the viewport instead of on first paint at the top of
 * a document the visitor has not scrolled yet.
 */
const SUBTITLE_DELAY_MS = 80;
const ACTION_DELAY_MS = 80;

type Props = {
    title: string;
    subtitle?: string;
    /** Where "lihat semua" goes. Omitted when the section *is* the whole list. */
    href?: string;
    actionLabel?: string;
    /** `id` for the section's own heading, so a page can link to it (`/events#cabang-olahraga`). */
    id?: string;
};

/**
 * The heading above a homepage/discovery section.
 *
 * The action is a link rather than a button because it navigates — middle-click, open-in-new-tab
 * and keyboard behaviour all come for free, and it stays a server component.
 */
export default function SectionHeader({
    title,
    subtitle,
    href,
    actionLabel = "Lihat semua",
    id,
}: Props) {
    return (
        <div className="mb-4 flex items-end justify-between gap-4 sm:mb-6">
            <div className="min-w-0">
                <Reveal
                    as="h2"
                    scroll
                    variant="section"
                    id={id}
                    className="scroll-mt-24 text-xl font-extrabold tracking-tight text-ink-900 sm:text-2xl"
                >
                    {title}
                </Reveal>
                {subtitle ? (
                    <Reveal
                        as="p"
                        scroll
                        delay={SUBTITLE_DELAY_MS}
                        className="mt-1 text-sm text-ink-500"
                    >
                        {subtitle}
                    </Reveal>
                ) : null}
            </div>

            {href ? (
                // A `div` wrapper rather than revealing the anchor itself: the reveal attribute must
                // land on a plain element, and a nested link is invalid HTML. `shrink-0` moves from
                // the anchor to the wrapper, so the flex row is laid out exactly as before.
                <Reveal
                    scroll
                    delay={ACTION_DELAY_MS}
                    className="shrink-0"
                >
                    <Link
                        href={href}
                        className="rounded-lg px-1 py-1 text-sm font-semibold text-brand-700 transition hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                    >
                        {actionLabel}
                    </Link>
                </Reveal>
            ) : null}
        </div>
    );
}
