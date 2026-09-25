import type { ReactNode } from "react";
import Link from "next/link";

/**
 * ==========================================
 * AUTH SHELL — THE SHARED FRAME
 * ==========================================
 *
 * The frame login and registration sit in. Before this, the two pages were two hand-rolled
 * copies of the same layout with two different gradients, two different back-link styles and
 * two different card elevations — the kind of drift that makes one product look like two.
 *
 * ── WHAT BELONGS HERE, AND WHAT DOES NOT ────────────────────────────────────────
 * HERE: the page background, the centred single column, the card, the exit, and the footer
 * slot. All of it is styling and none of it knows anything about authentication.
 *
 * NOT HERE: the brand lockup and the page heading. Each form renders its own — deliberately,
 * because the surface must visibly render the shared `<Brand />` (asserted by
 * `__tests__/ui-consolidation`), and hiding it one level down would make that guarantee a
 * property of a wrapper rather than of the page a visitor is looking at.
 *
 * ── WHY THIS IS NOT A CLIENT COMPONENT ──────────────────────────────────────────
 * It has no state and no handlers, so it stays a server component and the chrome costs
 * nothing on the client. `RoleSelector`, `PasswordField` and the forms are the client parts.
 *
 * ── THE LAYOUT RULES ────────────────────────────────────────────────────────────
 *   • ONE column at `max-w-md`: an authentication form that spans a desktop monitor is a form
 *     people mistype.
 *   • `px-5 py-10` so it never touches the screen edge on a phone.
 *   • A single elevation (`shadow-sm`) and a hairline border — a product, not a template.
 *   • The exit link is always the same and always first in the tab order, so a keyboard user
 *     can always leave without hunting.
 */
export function AuthShell({
    children,
    footer,
    backHref = "/",
    backLabel = "Kembali ke Beranda",
}: {
    children: ReactNode;
    /** Below the card: the "already have an account?" line. */
    footer?: ReactNode;
    backHref?: string;
    backLabel?: string;
}) {
    return (
        <section className="flex min-h-screen items-center justify-center bg-ink-50/60 px-5 py-10">
            <div className="w-full max-w-md">
                <Link
                    href={backHref}
                    className="mb-6 inline-flex items-center gap-2 rounded-xl border border-ink-200 bg-white px-4 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50 hover:text-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                >
                    <svg
                        aria-hidden
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-3.5 w-3.5"
                    >
                        <path d="M19 12H5M12 19l-7-7 7-7" />
                    </svg>
                    {backLabel}
                </Link>

                <div className="rounded-2xl border border-ink-100 bg-white p-7 shadow-sm sm:p-8">
                    {children}
                </div>

                {footer ? (
                    <div className="mt-6 text-center text-sm text-ink-600">{footer}</div>
                ) : null}
            </div>
        </section>
    );
}

export default AuthShell;