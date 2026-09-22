"use client";

import { signOut } from "next-auth/react";

/**
 * The logout control for the customer-facing header.
 *
 * `signOut` needs the `next-auth/react` client, so this is the only part of the header that is a
 * client component; everything else stays server-rendered.
 */
type Props = {
    /** "button" is the desktop outline chip; "menu" is the full-width row inside the mobile drawer. */
    variant?: "button" | "menu";
};

export default function SiteSignOut({ variant = "button" }: Props) {
    const styles =
        variant === "menu"
            ? "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
            : "hidden items-center gap-2 rounded-xl border border-ink-200 px-4 py-2 text-sm font-semibold text-ink-800 transition hover:border-ink-900 hover:bg-ink-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900 sm:flex";

    return (
        <button
            type="button"
            onClick={() => signOut({ callbackUrl: "/" })}
            className={styles}
        >
            <svg
                aria-hidden
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 shrink-0"
            >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Keluar
        </button>
    );
}