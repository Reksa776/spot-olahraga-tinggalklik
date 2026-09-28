"use client";

import type { RealtimeConnectionStatus } from "@/lib/realtime/client-core";

/**
 * ==========================================
 * REALTIME INDICATOR — SMALL, QUIET, HONEST, BOTTOM-RIGHT
 * ==========================================
 *
 * The operator asked for this only if it improves the experience, and it does: without it, a
 * paused auto-refresh (a dirty form, a hidden tab, a dropped connection) is invisible, and an
 * operator has no way to know that the number they are looking at may be behind. With it, the state
 * is a glance rather than a suspicion.
 *
 * It is deliberately the least intrusive thing that can carry that meaning:
 *
 *   • POSITION  — pinned to the BOTTOM-RIGHT of the viewport, where a status pill belongs: out of
 *                 the reading path (top-left to centre), clear of the toasts (top-right) and the
 *                 dirty-form banner (bottom-centre), and reachable without covering the
 *                 bottom-left corner where a page's own secondary actions tend to sit. It never
 *                 participates in layout: `position: fixed` takes it out of flow entirely, so it
 *                 cannot push a table, shift a grid, or change a responsive breakpoint. That is
 *                 why the class list is `fixed` and NOT `sticky`/`relative`/`absolute` — the move
 *                 is a positioning change only, and the test suite asserts exactly that.
 *   • SIZE      — one small pill with a dot. It is not a button, not a badge on a nav item, and it
 *                 carries no count.
 *   • WORDING   — an operator sees `Live` / `Memperbarui…` / `Dijeda`; a CUSTOMER sees
 *                 `Terhubung` / `Memperbarui…` / `Dijeda`. "Stream", "SSE", "reconnect" and
 *                 "syncing" are internal vocabulary and never appear on a customer surface.
 *   • A11Y      — `role="status"` with `aria-live="polite"`, so the change is announced once when
 *                 it settles rather than on every render; an `aria-label` names what the region
 *                 reports, so assistive technology gets "Status koneksi realtime: Live" instead of a
 *                 bare adjective; the visible text is the live region's content, so a transition is
 *                 announced; and the dot is `aria-hidden` because colour is never the only signal.
 *
 * ── THE MOBILE OFFSET IS NOT ARBITRARY ───────────────────────────────────────────
 * Below `lg` this pill sits ABOVE the phone-sized purchase bar
 * (`components/ticketing/StickyBuyBar.tsx` — `fixed inset-x-0 bottom-0`, `lg:hidden`), because that
 * bar's right-hand side is the event page's PRIMARY call to action and a status pill must never
 * cover it. The two share the `lg` breakpoint on purpose, and the test suite asserts they agree, so
 * moving one forces a look at the other. `env(safe-area-inset-bottom)` is added on top, following
 * the convention `StickyBuyBar` already established for the iOS home indicator.
 *
 * On desktop the inset is a plain 20 px, which is the whole point of the move.
 *
 * ── LAYERING — WHY `z-30`, NOT `z-50` ────────────────────────────────────────────
 * The project's ladder is 30 (sticky chrome: `DashboardShell`'s header) → 40 (the sticky purchase
 * bar and the dirty-form banner) → 50 (Radix dialogs, dropdowns, popovers). The pill belongs on the
 * BOTTOM rung: it must float above ordinary page content, but it is pure information and must never
 * paint over something interactive. Reaching for `z-50` (or an arbitrary value) would let it cover a
 * modal's close button for the sake of a status dot.
 */

const OPERATOR_LABELS: Record<RealtimeConnectionStatus, string> = {
    live: "Live",
    connecting: "Menyambungkan…",
    fallback: "Memperbarui…",
    paused: "Dijeda",
};

const CUSTOMER_LABELS: Record<RealtimeConnectionStatus, string> = {
    live: "Terhubung",
    connecting: "Menyambungkan…",
    fallback: "Memperbarui…",
    paused: "Dijeda",
};

/** The dot's colour. Amber is "behind, catching up"; it is never alarm-red — nothing is broken. */
const DOT_CLASS: Record<RealtimeConnectionStatus, string> = {
    live: "bg-emerald-500",
    connecting: "bg-amber-500",
    fallback: "bg-amber-500",
    paused: "bg-muted-foreground/50",
};

export function RealtimeIndicator({
    status,
    operator,
    className,
}: {
    status: RealtimeConnectionStatus;
    /** Which vocabulary to use. Defaults to the customer-facing wording. */
    operator?: boolean;
    className?: string;
}) {
    const labels = operator ? OPERATOR_LABELS : CUSTOMER_LABELS;
    const label = labels[status];

    return (
        <div
            role="status"
            aria-live="polite"
            aria-label={`Status koneksi realtime: ${label}`}
            className={[
                // Fixed, bottom-right, and out of flow: it cannot consume layout space.
                "pointer-events-none fixed z-30 right-4",
                // Mobile: clear the purchase bar (+ the iOS home indicator) — see the header.
                "bottom-[calc(4.5rem_+_env(safe-area-inset-bottom))]",
                // Desktop: a plain 20px inset from both edges.
                "lg:right-5 lg:bottom-5",
                "flex items-center gap-1.5 rounded-full border border-border/60 bg-background/85",
                "px-2.5 py-1 text-[11px] font-medium text-muted-foreground shadow-sm backdrop-blur",
                className ?? "",
            ]
                .filter(Boolean)
                .join(" ")}
        >
            <span
                aria-hidden="true"
                className={`size-1.5 rounded-full ${DOT_CLASS[status]}`}
            />
            <span>{label}</span>
        </div>
    );
}
