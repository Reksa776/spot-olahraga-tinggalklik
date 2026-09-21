"use client";

import { useEffect } from "react";

import ErrorState from "./ErrorState";
import RetryButton from "./RetryButton";

/**
 * ==========================================
 * ERROR BOUNDARY FALLBACK
 * ==========================================
 *
 * What every `error.tsx` renders. One implementation, four boundaries
 * (`app/error.tsx`, `app/global-error.tsx`, `app/dashboard/error.tsx`, `app/ticketing/error.tsx`),
 * so an unexpected failure cannot look like four different products.
 *
 * ── WHY IT DOES NOT CLASSIFY ────────────────────────────────────────────────────
 * Deliberately not. The classifier (`lib/errors/classify.ts`) reaches `lib/api/errors.ts`,
 * which imports `next/server` — a server-only module. Importing it here would push it into
 * the client bundle and break the build. More importantly it is not NEEDED: by the time a
 * boundary renders, the failure is by definition one the page did not know how to classify
 * (a classified 404 redirects, a classified outage renders `ServiceUnavailableState`).
 *
 * ── WHAT IT DOES WITH THE ERROR ─────────────────────────────────────────────────
 * Logs it, once, from the browser — where the operator will otherwise see nothing, because
 * the server render that failed already returned. `digest` is the only identifier React
 * passes to a client boundary in production (the real message is withheld there on purpose),
 * so it is what gets shown as the reference code and what a support conversation can quote.
 *
 * The user is told what is true: something broke on our side, their data is safe, and there
 * is a way to try again.
 */
export function ErrorBoundaryFallback({
    error,
    reset,
    title = "Terjadi masalah",
    description,
    homeHref = "/",
    homeLabel = "Kembali ke beranda",
    /** Render as a whole page surface rather than a centred card. */
    standalone = false,
    /** Adds the back-office shell marker, so the marketing footer stays suppressed. */
    dashboard = false,
}: {
    error: Error & { digest?: string };
    reset: () => void;
    title?: string;
    description?: React.ReactNode;
    homeHref?: string;
    homeLabel?: string;
    standalone?: boolean;
    dashboard?: boolean;
}) {
    useEffect(() => {
        /*
         * The message only, plus the digest — never a request body, a token, a header or a
         * session object. A browser console is a semi-public place: a log-capturing
         * extension, a shared machine or a screenshot all leak it.
         */
        console.error(
            `[boundary] unhandled render failure digest=${error.digest ?? "none"}`,
            error.message
        );
    }, [error]);

    return (
        <div
            data-dashboard-shell={dashboard ? "" : undefined}
            className={
                standalone
                    ? "flex min-h-screen w-full flex-col items-center justify-center bg-background px-4 py-16 text-foreground"
                    : "mx-auto w-full max-w-xl"
            }
        >
            <ErrorState
                tone="warning"
                title={title}
                reference={error.digest}
                description={
                    description ?? (
                        <p>
                            Kami mengalami kendala saat memuat halaman ini. Data Anda tetap
                            aman dan tidak ada perubahan yang tercatat.
                        </p>
                    )
                }
                actions={[{ href: homeHref, label: homeLabel, variant: "secondary" }]}
            >
                <RetryButton onClick={reset} />
            </ErrorState>
        </div>
    );
}

export default ErrorBoundaryFallback;
