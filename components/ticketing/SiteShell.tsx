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
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <SiteFooter />
        </div>
    );
}
