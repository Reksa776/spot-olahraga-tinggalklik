import Link from "next/link";

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
                <h2
                    id={id}
                    className="scroll-mt-24 text-xl font-extrabold tracking-tight text-ink-900 sm:text-2xl"
                >
                    {title}
                </h2>
                {subtitle ? (
                    <p className="mt-1 text-sm text-ink-500">{subtitle}</p>
                ) : null}
            </div>

            {href ? (
                <Link
                    href={href}
                    className="shrink-0 rounded-lg px-1 py-1 text-sm font-semibold text-brand-700 transition hover:text-brand-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                >
                    {actionLabel}
                    <span aria-hidden> →</span>
                </Link>
            ) : null}
        </div>
    );
}
