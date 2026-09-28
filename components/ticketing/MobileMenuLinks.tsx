"use client";

import type { ReactNode } from "react";
import Link from "next/link";

/**
 * ==========================================
 * THE MOBILE DRAWER'S LINK LIST
 * ==========================================
 *
 * The rows of the header's `<details>` drawer. It is a CLIENT component for exactly one
 * behaviour, and everything about it is otherwise the markup the server used to render:
 *
 * ── WHY THIS EXISTS: A NEXT.JS `<Link>` DOES NOT CLOSE A `<details>` ───────────
 * `<details>`/`<summary>` was chosen for the drawer precisely because it is native: it
 * toggles, it escapes, and it is keyboard-accessible before any JavaScript runs. What it does
 * NOT know about is client-side navigation — `<Link>` swaps the page without a document load,
 * so the drawer stayed open, floating over the page the visitor had just navigated to. The
 * only way to close it is to remove the `open` attribute, which is a DOM write, which needs a
 * client component. That is this file and nothing else: the row list, the decision about WHICH
 * rows exist (including the capability-gated Dashboard row) and the sign-out control all still
 * come from `SiteHeader`, a server component.
 *
 * ── WHY IT CLOSES THE DRAWER IT IS INSIDE RATHER THAN HOLDING AN `open` PROP ─────
 * Lifting the drawer's state into React would buy nothing and cost something: `<details>` would
 * stop working before hydration and the native toggle/keyboard semantics would have to be
 * re-implemented. `closest("details")` closes whatever drawer rendered these rows, so the row
 * markup stays renderer-agnostic and a second drawer could reuse it.
 *
 * ── KEYBOARD AND FOCUS ARE UNTOUCHED ───────────────────────────────────────────
 * This adds no key handler and no `tabIndex`: activating a row with Enter or Space fires the
 * same `click` event, so the close happens on the keyboard path too. Focus is left exactly where
 * the browser puts it for a navigation — the close does not steal or move it.
 */

/** One drawer row. Plain data, so `SiteHeader` owns the list and this file owns the rendering. */
export type MobileMenuItem = {
    href: string;
    label: string;
};

export default function MobileMenuLinks({
    items,
    children,
}: {
    items: MobileMenuItem[];
    /** The sign-out row, which is its own client control (`SiteSignOut`). */
    children?: ReactNode;
}) {
    function closeDrawer(event: React.MouseEvent<HTMLAnchorElement>) {
        const drawer = event.currentTarget.closest("details");

        // The guard is for a row rendered outside a `<details>` (a future reuse): nothing to
        // close is not an error, and `removeAttribute` on a missing attribute is a no-op.
        if (!drawer?.hasAttribute("open")) {
            return;
        }

        drawer.removeAttribute("open");
    }

    return (
        <ul className="space-y-1">
            {items.map((item) => (
                <li key={`${item.href}-${item.label}`}>
                    <Link
                        href={item.href}
                        onClick={closeDrawer}
                        className="block rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-700 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                    >
                        {item.label}
                    </Link>
                </li>
            ))}

            {children}
        </ul>
    );
}
