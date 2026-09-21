"use client";

import ErrorBoundaryFallback from "@/components/errors/ErrorBoundaryFallback";

/**
 * ==========================================
 * ROOT ERROR BOUNDARY
 * ==========================================
 *
 * Catches an unhandled render failure anywhere below the root layout: a server component
 * that threw, or a client component that crashed.
 *
 * ── WHICH FAILURES ACTUALLY REACH IT ────────────────────────────────────────────
 * Fewer than it looks, and that is the point. During the audit every page-level
 * `catch(() => null)` grew a real decision:
 *
 *   • "the resource is not there / not yours" → the page calls `notFound()` (404 page);
 *   • "the database is unreachable or timed out" → the page renders
 *     `ServiceUnavailableState` with a retry (it does NOT reach this boundary, because a
 *     retry that re-runs the whole route is a worse experience than an in-place one);
 *   • everything else — a genuine bug — arrives here.
 *
 * So this boundary is the last resort for the UNKNOWN, which is exactly what a boundary is
 * for. It is not the mechanism for expected failures.
 *
 * ── WHY IT IS A CLIENT COMPONENT ────────────────────────────────────────────────
 * Required by Next.js: `reset()` is a client function. It therefore cannot render
 * server-only chrome (`SiteShell` reads the session for its header), so the fallback is the
 * shared `ErrorBoundaryFallback` — one error surface for the whole application.
 */
export default function RootError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    return (
        <div className="flex min-h-screen w-full flex-col items-center justify-center bg-white px-4 py-16 antialiased">
            <ErrorBoundaryFallback error={error} reset={reset} />
        </div>
    );
}
