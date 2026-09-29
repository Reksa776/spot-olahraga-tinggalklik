"use client";

import { signOut } from "next-auth/react";

import { cn } from "@/lib/utils";

import { HEADER_NAV_VARIANT } from "./header-nav";

/**
 * The logout control for the customer-facing header.
 *
 * `signOut` needs the `next-auth/react` client, so this is the only part of the header that is a
 * client component; everything else stays server-rendered.
 *
 * ── THE SAME GEOMETRY AS EVERY OTHER HEADER ITEM ────────────────────────────────
 * The desktop control is `HEADER_NAV_VARIANT.outline` — the identical height, radius, padding,
 * type scale and alignment as "Tiket saya" beside it (see `components/ticketing/header-nav.ts`).
 * It used to hand-write its own `rounded-xl px-4 py-2` string with no fixed height, so it stood
 * taller than the plain links next to it and its icon did not share their baseline. The button
 * element carries the shared geometry directly, so an icon and a text label are centred together
 * and the row has ONE height.
 */
type Props = {
    /** "button" is the desktop outline control; "menu" is the full-width row inside the mobile drawer. */
    variant?: "button" | "menu";
};

export default function SiteSignOut({ variant = "button" }: Props) {
    const styles =
        variant === "menu"
            ? "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
            : cn(HEADER_NAV_VARIANT.outline, "hidden xl:inline-flex");

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
                className="size-4 shrink-0"
            >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            </svg>
            Keluar
        </button>
    );
}