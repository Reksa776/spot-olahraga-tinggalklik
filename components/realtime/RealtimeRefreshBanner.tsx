"use client";

/**
 * ==========================================
 * REFRESH BANNER — THE CHOICE, NOT THE OVERWRITE
 * ==========================================
 *
 * Shown only when a realtime change has arrived AND the automatic refresh is being held back to
 * protect input the user is in the middle of. It is the visible half of the dirty-form rule: the
 * product never silently replaces what a person is typing, and it never silently drops an update
 * either — it asks.
 *
 *   [ Muat data terbaru ]  applies the held refresh NOW (the user accepts losing their edits)
 *   [ Abaikan ]            drops the held refresh until something changes again
 *
 * Doing NOTHING is always safe: the pending refresh survives, and it is applied automatically the
 * moment the field loses focus or the form becomes clean. That is why neither button is
 * emphasized as "the right answer" — both are legitimate, and the default is patience.
 *
 * ── WHY IT IS FIXED, NOT INLINE ──────────────────────────────────────────────────
 * An inline banner would shift the layout exactly when the user's cursor is in a table cell, which
 * is the moment a layout shift is most disruptive. Positioned at the bottom centre, above the
 * indicator and clear of the toasts, it costs nothing to ignore and cannot move anything the user is
 * interacting with.
 *
 * ── WHY IT IS NOT A TOAST ────────────────────────────────────────────────────────
 * A toast disappears on its own. This decision must not expire: if the banner vanished while the
 * user kept typing, the held refresh would look like a lost update.
 */

export function RealtimeRefreshBanner({
    onRefresh,
    onDismiss,
}: {
    onRefresh: () => void;
    onDismiss: () => void;
}) {
    return (
        <div
            role="alertdialog"
            aria-live="polite"
            aria-label="Data berubah di server"
            className={[
                "fixed bottom-14 left-1/2 z-40 w-[min(94vw,26rem)] -translate-x-1/2",
                "rounded-lg border border-border bg-background/95 p-3 shadow-lg backdrop-blur",
                "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
            ].join(" ")}
        >
            <div className="min-w-0">
                <p className="text-sm font-semibold">Data berubah di server.</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                    Penyegaran otomatis ditahan agar isian yang sedang Anda kerjakan tidak
                    tertimpa.
                </p>
            </div>

            <div className="flex shrink-0 items-center gap-2">
                <button
                    type="button"
                    onClick={onRefresh}
                    className={[
                        "rounded-md border border-primary bg-primary px-3 py-1.5 text-xs font-semibold",
                        "text-primary-foreground transition-colors hover:bg-primary/90",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    ].join(" ")}
                >
                    Muat data terbaru
                </button>
                <button
                    type="button"
                    onClick={onDismiss}
                    className={[
                        "rounded-md border border-border px-3 py-1.5 text-xs font-semibold",
                        "transition-colors hover:bg-muted",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    ].join(" ")}
                >
                    Abaikan
                </button>
            </div>
        </div>
    );
}
