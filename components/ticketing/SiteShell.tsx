import type { ReactNode } from "react";

import SiteFooter from "./SiteFooter";
import SiteHeader from "./SiteHeader";

type Props = {
    children: ReactNode;
};

/**
 * The chrome for every ticketing page: header, content, footer.
 *
 * `data-ticketing-shell` marks the subtree so tests and static guards can assert that a page is
 * wrapped, and so the discovery palette is documented as belonging to these routes rather than to
 * the retail ones sharing the same root layout.
 */
export default function SiteShell({ children }: Props) {
    return (
        <div
            data-ticketing-shell
            className="flex min-h-screen flex-col bg-white text-ink-900 antialiased"
        >
            {/* PHASE 16 — the chrome is suppressed on paper. A printed e-ticket is carried to a
             * gate; navigation, search and the footer are noise there, and the ticket is the
             * only thing worth the paper. `print:hidden` is presentation only: nothing here
             * changes what a screen reader or a browser sees on screen. */}
            <div className="print:hidden">
                <SiteHeader />
            </div>

            <main className="flex-1">{children}</main>

            <div className="print:hidden">
                <SiteFooter />
            </div>
        </div>
    );
}
