import Link from "next/link";

import Brand from "@/components/Brand";
import {
    DEFAULT_MAINTENANCE_MESSAGE,
    getApplicationBranding,
    getMaintenanceState,
} from "@/lib/app-settings";

/**
 * ==========================================
 * PHASE 32 — APPLICATION MAINTENANCE PAGE
 * ==========================================
 *
 * The page the root layout redirects to while maintenance is ON. PUBLIC by necessity — it
 * is shown to anonymous visitors — and deliberately tiny: the operator's message, the
 * optional "back at …" line, and the brand lockup.
 *
 * ── IT RENDERS EVEN WHEN MAINTENANCE IS OFF ────────────────────────────────────
 * The switch being off does not make this URL invalid; it makes it a page that says the site
 * is available. Two reasons. First, the ADMIN needs a preview of what visitors will see, and
 * routing that preview through a special-cased flag would make the preview a second
 * implementation of the page. Second, a URL that 404s when "nothing is wrong" is a support
 * ticket waiting to happen — someone will bookmark or share it.
 *
 * ── IT USES THE CONFIGURED BRANDING ────────────────────────────────────────────
 * The same `getApplicationBranding()` the landing page and the dashboard lockup read —
 * one source of truth, so a positively identified site stays identified while it is closed.
 * There is no second logo configuration here.
 *
 * The page is `force-dynamic`: it prints the live maintenance message, and a cached copy
 * would keep showing a notice the operator has already cleared.
 */

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Maintenance — TinggalKlik.Co",
    description: "Website sedang dalam maintenance.",
    // A maintenance notice has no business being indexed.
    robots: { index: false, follow: false },
};

export default async function MaintenancePage() {
    const [maintenance, branding] = await Promise.all([
        getMaintenanceState(),
        getApplicationBranding(),
    ]);

    const message = maintenance.message || DEFAULT_MAINTENANCE_MESSAGE;

    return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-ink-50 px-4 py-16 text-center">
            <Brand logoSrc={branding.logoUrl} />

            <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white px-6 py-10 shadow-sm sm:px-10">
                <span className="inline-flex items-center gap-2 rounded-full border border-ink-200 bg-ink-50 px-3.5 py-1.5 text-xs font-bold uppercase tracking-wide text-ink-600">
                    {maintenance.enabled ? "Maintenance" : "Status"}
                </span>

                <h1 className="mt-6 text-2xl font-black tracking-tight text-ink-900 sm:text-3xl">
                    {maintenance.enabled
                        ? "Website sedang dalam maintenance"
                        : "Website kembali normal"}
                </h1>

                <p className="mt-4 text-sm leading-relaxed text-ink-600">
                    {maintenance.enabled
                        ? message
                        : "Situs sedang tidak dalam maintenance. Silakan lanjut beraktivitas."}
                </p>

                {maintenance.enabled && maintenance.etaMessage ? (
                    <p className="mt-2 text-sm leading-relaxed text-ink-500">
                        {maintenance.etaMessage}
                    </p>
                ) : null}

                <Link
                    href="/"
                    className="mt-8 inline-block rounded-xl bg-brand-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                >
                    Coba buka beranda
                </Link>
            </div>
        </main>
    );
}
