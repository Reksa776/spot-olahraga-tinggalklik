import Link from "next/link";

type Kind = "search" | "ticket" | "calendar" | "blocked";

type Props = {
    title: string;
    description?: string;
    kind?: Kind;
    /** Primary next step. A real link, since every empty state here leads somewhere. */
    action?: { href: string; label: string };
    /** Optional secondary step, rendered as a quieter link. */
    secondaryAction?: { href: string; label: string };
};

const PATHS: Record<Kind, string> = {
    search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35",
    ticket:
        "M4 9V7a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2a3 3 0 0 0 0 6v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a3 3 0 0 0 0-6Z",
    calendar: "M4 7h16v13H4zM4 11h16M9 4v4M15 4v4",
    blocked:
        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8",
};

/**
 * What the buyer sees when a list is legitimately empty.
 *
 * Always states why (there is nothing here / nothing matched) and offers a way out, because an
 * empty screen with no next step is where a purchase journey is abandoned.
 *
 * Phase 35 empties the shell itself: no dashed card, no boxed icon. A quiet centered column — a
 * small line icon, the message, and a single next step.
 */
export default function EmptyState({
    title,
    description,
    kind = "search",
    action,
    secondaryAction,
}: Props) {
    return (
        <div className="px-6 py-12 text-center">
            <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                className="mx-auto h-8 w-8 text-ink-300"
            >
                <path d={PATHS[kind]} />
            </svg>

            <h3 className="mt-4 text-base font-bold text-ink-900">{title}</h3>
            {description ? (
                <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-500">
                    {description}
                </p>
            ) : null}

            {action || secondaryAction ? (
                <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
                    {action ? (
                        <Link
                            href={action.href}
                            className="rounded-xl bg-ink-900 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                        >
                            {action.label}
                        </Link>
                    ) : null}
                    {secondaryAction ? (
                        <Link
                            href={secondaryAction.href}
                            className="rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-600 transition hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                        >
                            {secondaryAction.label}
                        </Link>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}