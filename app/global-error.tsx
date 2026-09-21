"use client";

import ErrorBoundaryFallback from "@/components/errors/ErrorBoundaryFallback";

import "./globals.css";

/**
 * ==========================================
 * GLOBAL ERROR BOUNDARY
 * ==========================================
 *
 * The last line of defence: it catches a failure thrown by the ROOT LAYOUT itself, which
 * `app/error.tsx` cannot, because that boundary lives inside the layout it would need.
 *
 * ── WHY IT MUST SHIP ITS OWN <html> AND <body> ──────────────────────────────────
 * When this renders, the root layout's output is unavailable — Next.js replaces the entire
 * document. So the tag structure, the language and the stylesheet have to be supplied here,
 * or the user gets unstyled HTML in the wrong language.
 *
 * ── WHY THE STYLESHEET IS IMPORTED ──────────────────────────────────────────────
 * Because the theme tokens (`ink-*`, `brand-*`) used by the fallback come from
 * `globals.css`. Without the import this one screen renders with no design at all, which is
 * precisely the "blank, broken page" outcome the brief forbids.
 *
 * The theme bootstrap script is deliberately NOT re-emitted: if the root layout could not
 * run, a personalised palette is the least of the user's problems, and the default
 * (light) palette is correct and legible.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <html lang="id">
            <body>
                <div className="flex min-h-screen w-full flex-col items-center justify-center bg-white px-4 py-16 antialiased">
                    <ErrorBoundaryFallback error={error} reset={reset} />
                </div>
            </body>
        </html>
    );
}
