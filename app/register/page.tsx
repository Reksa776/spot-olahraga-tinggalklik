import type { Metadata } from "next";
import { redirect } from "next/navigation";

import RegisterForm from "@/components/auth/RegisterForm";
import { getApplicationBranding } from "@/lib/app-settings";
import { decideSessionGate, readCallbackUrlParam } from "@/lib/auth/session-gate";
import { getAuthzScope } from "@/lib/authz";

/**
 * ==========================================
 * /register — PUBLIC CUSTOMER REGISTRATION
 * ==========================================
 *
 * A thin wrapper, exactly like `/login`, and a SERVER component: `RegisterForm` owns the form
 * and the `<Brand />` lockup, while `LoginShell` owns the frame, so there is one place to change.
 *
 * ── BRANDING IS RESOLVED HERE, SERVER-SIDE ──────────────────────────────────────
 * `getApplicationBranding()` reads `PlatformSetting.logoUrl` / `.platformName` and the result
 * is handed to the form as a prop, so the register screen renders the SAME configured branding
 * as the sign-in screen, in the server HTML, with no client-side fetch.
 *
 * ── WHAT THIS PAGE CANNOT DO ────────────────────────────────────────────────────
 * It creates CUSTOMER accounts and nothing else. There is no role field, no organizer field
 * and no plan selector, because the endpoint behind it derives the role server-side and
 * ignores anything the request says about it. Back-office access is granted by an auditable
 * administrative operation, never by a public form.
 *
 * ── THE SERVER GATE ─────────────────────────────────────────────────────────────
 * A signed-in visitor is redirected to the surface their own database role belongs to, before
 * any HTML is sent, exactly as on `/login`. Registering a second account while holding a
 * session is not a flow this application offers — a new account has to be created from a
 * signed-out browser — and the redirect is what makes that a property of the page rather than
 * a race the client-side check could lose. `RegisterForm` retains its client-side check as the
 * fallback for a session established after this HTML was served.
 *
 * `robots: noindex` — a registration page needs no search presence, and keeping it out of
 * the index keeps credential-phishing clones of it out of the results too.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Daftar akun",
    description:
        "Buat akun TinggalKlik.Co untuk membeli tiket, menyimpan e-tiket, dan mengikuti event favorit Anda.",
    robots: { index: false, follow: false },
};

export default async function RegisterPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const callbackUrl = readCallbackUrlParam((await searchParams).callbackUrl);

    // Overlapped with the scope read, exactly as on /login: no serial branding latency.
    const [scope, branding] = await Promise.all([
        getAuthzScope(),
        getApplicationBranding(),
    ]);

    const decision = decideSessionGate(scope, callbackUrl);

    if (decision.action === "redirect") {
        redirect(decision.to);
    }

    return <RegisterForm branding={branding} />;
}
