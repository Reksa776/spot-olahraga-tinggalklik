import type { Metadata } from "next";
import { redirect } from "next/navigation";

import LoginForm from "@/components/auth/LoginForm";
import { getApplicationBranding } from "@/lib/app-settings";
import { decideSessionGate, readCallbackUrlParam } from "@/lib/auth/session-gate";
import { getAuthzScope } from "@/lib/authz";

/**
 * ==========================================
 * /login
 * ==========================================
 *
 * The page is a thin wrapper: `LoginForm` owns the form and renders the `<Brand />` lockup,
 * while `LoginShell` owns the frame, so there is exactly one place that can change how signing
 * in looks.
 *
 * ── BRANDING IS RESOLVED HERE, SERVER-SIDE ──────────────────────────────────────
 * `getApplicationBranding()` reads `PlatformSetting.logoUrl` / `.platformName` and the result
 * is handed to the form as a prop, so the configured logo is in the server-rendered HTML.
 * There is no client fetch and therefore no blank-logo flash. The read runs in parallel with
 * the session gate, so it adds no serial latency.
 *
 * It stays a SERVER component so none of the page chrome (the shell, the exit link, the
 * card) ships to the browser. Only the form and its fields are interactive.
 *
 * ── THE SERVER GATE ─────────────────────────────────────────────────────────────
 * A visitor who is ALREADY signed in is redirected by the server, before any HTML is sent, so
 * they never see the sign-in form at all. That check reads `resolveAuthzScope`, i.e. the role
 * on the `User` ROW — not the request, not the login screen's role selector, and not the
 * session token's mirror of the role. See `lib/auth/session-gate.ts` for why `null` means
 * "render the form": it covers both an anonymous visitor and a session whose user has been
 * deleted, and the latter would otherwise loop between this page and the dashboard.
 *
 * `LoginForm` keeps its own client-side session check as a fallback for the case this gate
 * cannot cover: a session established in the browser after this HTML was served (a second tab,
 * or a soft navigation whose payload was rendered earlier). The two agree because both call
 * the same pure helpers.
 *
 * `robots: noindex` is deliberate: an indexable login page invites credential-phishing
 * clones to be ranked beside the real one, and there is nothing here for a search engine to
 * describe.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Masuk",
    description: "Masuk ke akun TinggalKlik.Co untuk membeli tiket dan mengelola event.",
    robots: { index: false, follow: false },
};

export default async function LoginPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const callbackUrl = readCallbackUrlParam((await searchParams).callbackUrl);

    /*
     * The branding read (a request-cached database read plus one `fs.access`) and the scope
     * read are independent, so they overlap. A redirecting visitor pays for neither more than
     * they already did, and a visitor seeing the form has the logo in the first byte.
     */
    const [scope, branding] = await Promise.all([
        getAuthzScope(),
        getApplicationBranding(),
    ]);

    const decision = decideSessionGate(scope, callbackUrl);

    if (decision.action === "redirect") {
        redirect(decision.to);
    }

    return <LoginForm branding={branding} />;
}