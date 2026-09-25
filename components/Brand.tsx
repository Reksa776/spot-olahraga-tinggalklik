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
 *   dashboard shell           components/dashboard/DashboardNav.tsx (and the mobile top bar in
 *                             components/dashboard/DashboardShell.tsx), used by the ONE
 *                             dashboard layout at app/dashboard/layout.tsx
 *
 * It lives at `components/Brand.tsx` rather than under `components/ticketing/` because it is no
 * longer a ticketing detail: importing it from the auth or dashboard layer via a ticketing path
 * would state a dependency that does not exist. `components/ticketing/Brand.tsx` re-exports
 * this file so the Phase 9 imports keep working — one implementation, two import paths, no
 * churn.
 *
 * A typographic mark rather than an image: no asset pipeline, no layout shift, and it inherits
 * the ink/brand tokens. The square is `aria-hidden` because the wordmark beside it already
 * names the destination — a screen reader announcing "TK, TinggalKlik.Co" would be noise.
 *
 * ── PHASE 32 — THE CONFIGURED LOGO, WITH THE MARK AS ITS FALLBACK ────────────────
 * `logoSrc` is the ADMIN-configured application logo (`PlatformSetting.logoUrl`, resolved
 * server-side by `getApplicationBranding()`). When it is present the lockup renders it
 * BESIDE the wordmark — exactly the `[LOGO] Application Name` shape the brief asks for — and
 * when it is absent, or the value is `null` because the logo was removed, the typographic
 * mark above renders instead.
 *
 * There is deliberately no third state: an upload that fails never writes `logoUrl`, so the
 * database cannot hold a reference to a file that does not exist, and a removed logo is
 * `null` rather than an empty string. That is what makes "no broken image, no 404, no empty
 * gap" a structural property instead of a defensive `onError` handler.
 *
 * The logo is passed IN rather than fetched here on purpose: this component is rendered by
 * CLIENT components too (the dashboard shell and sidebar), where a database read is
 * impossible. The server surfaces fetch once and hand the value down, so every surface
 * renders the same source of truth without a second configuration.
 */
export default function Brand({
    tone = "ink",
    logoSrc = null,
}: {
    tone?: "ink" | "light";
    /** Persistent logo URL, or `null`/omitted to use the built-in mark. */
    logoSrc?: string | null;
}) {
    const text = tone === "light" ? "text-white" : "text-ink-900";
    const accent = tone === "light" ? "text-brand-400" : "text-brand-600";
    const chip =
        tone === "light" ? "bg-white/10 text-white" : "bg-ink-900 text-white";

    return (
        <Link
            href="/"
            className="flex shrink-0 items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
            {logoSrc ? (
                /*
                 * A plain `<img>` rather than `next/image`, deliberately. The source is a
                 * user-uploaded asset served from our own origin, it is replaced rarely, and
                 * its intrinsic size is unknown to the server render — `next/image` would
                 * require declared dimensions, and a wrong aspect ratio silently distorts the
                 * mark. `object-contain` with a bounded height keeps any uploaded shape
                 * undistorted, and the empty `alt` is correct: the wordmark next to it names
                 * the destination, so a second announcement would be noise (the same reason
                 * the `TK` square is `aria-hidden`).
                 */
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={logoSrc}
                    alt=""
                    aria-hidden
                    className="h-9 w-auto max-w-[9rem] shrink-0 object-contain"
                />
            ) : (
                <span
                    aria-hidden
                    className={`grid h-9 w-9 place-items-center rounded-xl text-[0.8rem] font-black tracking-tight ${chip}`}
                >
                    TK
                </span>
            )}
            <span className={`text-lg font-extrabold tracking-tight ${text}`}>
                TinggalKlik
                <span className={accent}>.Co</span>
            </span>
        </Link>
    );
}
