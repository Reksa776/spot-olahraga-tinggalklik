import Link from "next/link";

/**
 * ==========================================
 * THE BRAND LOCKUP
 * ==========================================
 *
 * ONE implementation for the whole product (Phase 10). Before this phase the application
 * carried four different lockups — `TK / TinggalKlik.Co` on the discovery surface,
 * `Admin Panel`, `Admin Platform` and `Panel Penyelenggara` on the three back offices — which
 * is precisely what made it read as several applications sharing a database. Every surface
 * now renders this component:
 *
 *   discovery header/footer   components/ticketing/SiteHeader.tsx, SiteFooter.tsx
 *   auth screens              components/auth/LoginForm.tsx, RegisterForm.tsx
 *   retail storefront chrome  (unchanged markup, still retail-owned)
 *   admin sidebar             components/admin/AdminNavbar.tsx
 *   platform back office      app/platform/layout.tsx
 *   organiser back office     app/organizer/layout.tsx
 *
 * It lives at `components/Brand.tsx` rather than under `components/ticketing/` because it is no
 * longer a ticketing detail: importing it from the auth or admin layer via a ticketing path
 * would state a dependency that does not exist. `components/ticketing/Brand.tsx` re-exports
 * this file so the Phase 9 imports keep working — one implementation, two import paths, no
 * churn.
 *
 * A typographic mark rather than an image: no asset pipeline, no layout shift, and it inherits
 * the ink/brand tokens. The square is `aria-hidden` because the wordmark beside it already
 * names the destination — a screen reader announcing "TK, TinggalKlik.Co" would be noise.
 */
export default function Brand({ tone = "ink" }: { tone?: "ink" | "light" }) {
    const text = tone === "light" ? "text-white" : "text-ink-900";
    const accent = tone === "light" ? "text-brand-400" : "text-brand-600";
    const chip =
        tone === "light" ? "bg-white/10 text-white" : "bg-ink-900 text-white";

    return (
        <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
            <span
                aria-hidden
                className={`grid h-9 w-9 place-items-center rounded-xl text-[0.8rem] font-black tracking-tight ${chip}`}
            >
                TK
            </span>
            <span className={`text-lg font-extrabold tracking-tight ${text}`}>
                TinggalKlik
                <span className={accent}>.Co</span>
            </span>
        </Link>
    );
}
