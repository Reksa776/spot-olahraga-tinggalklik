import type { TicketStatus } from "@prisma/client";

/**
 * The ticket's own status, in the buyer's words.
 *
 * One label per `TicketStatus` enum member — no new vocabulary, and no state the schema cannot
 * represent. `CHECKED_IN` is labelled even though check-in is not implemented: the enum member
 * exists in Phase 2's schema, so a row in that state must render as what it is rather than falling
 * through to an "unknown" bucket.
 */
const LABELS: Record<TicketStatus, { label: string; className: string }> = {
    ISSUED: {
        label: "Aktif",
        className: "bg-emerald-50 text-emerald-700 ring-emerald-200",
    },
    CHECKED_IN: {
        label: "Sudah check-in",
        className: "bg-sky-50 text-sky-700 ring-sky-200",
    },
    RESERVED: {
        label: "Belum dibayar",
        className: "bg-amber-50 text-amber-700 ring-amber-200",
    },
    VOID: {
        label: "Dibatalkan",
        className: "bg-ink-100 text-ink-600 ring-ink-200",
    },
    REFUNDED: {
        label: "Dana dikembalikan",
        className: "bg-violet-50 text-violet-700 ring-violet-200",
    },
};

export default function TicketStatusBadge({
    status,
    size = "md",
}: {
    status: TicketStatus;
    size?: "sm" | "md";
}) {
    const entry = LABELS[status];

    return (
        <span
            className={`inline-flex shrink-0 items-center rounded-full font-bold ring-1 ring-inset ${
                size === "sm"
                    ? "px-2 py-0.5 text-[0.65rem]"
                    : "px-2.5 py-1 text-xs"
            } ${entry.className}`}
        >
            {entry.label}
        </span>
    );
}
