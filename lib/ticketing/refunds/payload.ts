import { Prisma } from "@prisma/client";

import { moneyString } from "../order-payload";

/**
 * ==========================================
 * REFUND RESPONSE PAYLOAD (Phase 10B)
 * ==========================================
 *
 * One builder for every refund response, so the request, approve, reject and execute
 * endpoints cannot drift apart.
 *
 * ── MONEY IS STRINGS (D-61 / §36.5) ──────────────────────────────────────────────
 * `requestedAmount` and `confirmedAmount` are rendered with `moneyString`, i.e. the exact
 * stored `Decimal(14,2)` as a fixed 2-decimal string. Never a JSON number, never a
 * `Number(...).toFixed(2)` round trip.
 *
 * ── WHAT IS DELIBERATELY ABSENT ──────────────────────────────────────────────────
 * No `organizerId`, no `requestedByUserId`, no `approvedByUserId`, no
 * `processedByUserId`, no `idempotencyKey`, no internal ledger ids. Those are tenant and
 * platform internals (brief §24); a buyer reads their own refund, and a staff member reads
 * the same shape. The one provider value exposed is `providerRef`, because it is the
 * reference the buyer would quote in a dispute and D-R12 exists to make it available.
 */

export type RefundPayloadItem = {
    ticketCode: string;
    amount: string;
};

export type RefundPayload = {
    refundId: number;
    refundNumber: string | null;
    orderNumber: string;
    status: string;
    requestedAmount: string;
    confirmedAmount: string;
    reason: string | null;
    /** The rejection/failure explanation, when the lifecycle ended unsuccessfully. */
    failureReason: string | null;
    providerRef: string | null;
    currency: string;
    createdAt: string;
    approvedAt: string | null;
    processedAt: string | null;
    completedAt: string | null;
    failedAt: string | null;
    items: RefundPayloadItem[];
    /**
     * Whether a transfer-evidence file is attached to this refund.
     *
     * PHASE 20B — ADDITIVE, and deliberately a BOOLEAN. The evidence exists so a buyer can
     * see what was transferred, so a buyer payload must be able to say that it is there. It
     * must NOT be able to say WHERE it is: the storage key is the server-generated basename
     * the serving route compares against, and no JSON response carries it (see the note on
     * `refundEvidenceUrl` below).
     */
    hasEvidence: boolean;
};

/**
 * The buyer's evidence-serve route, built from values the SERVER already holds.
 *
 * This is the ONLY place the buyer-facing evidence URL is assembled, and it points at the
 * route that already exists (`app/api/ticketing/refunds/[refundId]/evidence/[fileName]`) —
 * no second delivery mechanism is introduced. Because that route is keyed by the stored
 * basename, the href necessarily contains it; that is why this builder is used by
 * server-rendered pages only and why the value is never placed on `RefundPayload`, which is
 * what `GET /api/ticketing/refunds` returns as JSON.
 *
 * `encodeURIComponent` is belt-and-braces: the writer only ever emits
 * `<millis>-<32 hex><.ext>`, so encoding is a no-op today and the URL stays correct if that
 * ever changes.
 */
export function refundEvidenceUrl(refundId: number, fileName: string): string {
    return `/api/ticketing/refunds/${refundId}/evidence/${encodeURIComponent(fileName)}`;
}

/**
 * The STAFF evidence-serve route, built from the same server-held values.
 *
 * The operator twin of `refundEvidenceUrl`, and the only place the staff URL shape is
 * written down: it points at the route that already exists
 * (`app/api/organizer/refunds/[refundId]/evidence/[fileName]`), which re-checks the
 * refund's own tenant + `REFUND_EXECUTE` on every request. The dashboard's refunds board
 * renders it so an operator can review the receipt behind a recorded transfer reference;
 * the buyer never sees this value (the buyer payload carries only `hasEvidence`). No
 * second storage or delivery mechanism is introduced.
 *
 * `encodeURIComponent` is belt-and-braces: the writer only ever emits
 * `<millis>-<32 hex><.ext>`, so encoding is a no-op today and the URL stays correct if that
 * ever changes.
 */
export function refundStaffEvidenceUrl(refundId: number, fileName: string): string {
    return `/api/organizer/refunds/${refundId}/evidence/${encodeURIComponent(fileName)}`;
}

/**
 * The row shape the builder consumes, and (next to it) the Prisma `select` that produces
 * it. Kept adjacent so a new field cannot be added to one without the other.
 */
export type RefundRow = {
    id: number;
    refundNumber: string | null;
    status: string;
    /**
     * The server-generated storage key, read ONLY so the payload can answer `hasEvidence`.
     * It is never projected into `RefundPayload` — the builder below turns it into a boolean
     * and drops it.
     */
    evidenceFileKey: string | null;
    requestedAmount: Prisma.Decimal;
    confirmedAmount: Prisma.Decimal;
    reason: string | null;
    failureReason: string | null;
    providerRef: string | null;
    createdAt: Date;
    approvedAt: Date | null;
    processedAt: Date | null;
    completedAt: Date | null;
    failedAt: Date | null;
    eventOrder: { orderNumber: string; currency: string } | null;
    items: {
        amount: Prisma.Decimal;
        ticket: { ticketCode: string };
    }[];
};

export const REFUND_SELECT = {
    id: true,
    refundNumber: true,
    status: true,
    evidenceFileKey: true,
    requestedAmount: true,
    confirmedAmount: true,
    reason: true,
    failureReason: true,
    providerRef: true,
    createdAt: true,
    approvedAt: true,
    processedAt: true,
    completedAt: true,
    failedAt: true,
    eventOrder: { select: { orderNumber: true, currency: true } },
    items: {
        select: {
            amount: true,
            ticket: { select: { ticketCode: true } },
        },
        orderBy: { createdAt: "asc" as const },
    },
} as const;

export function buildRefundPayload(row: RefundRow): RefundPayload {
    return {
        refundId: row.id,
        refundNumber: row.refundNumber,
        // A refund always belongs to an order; the fallback is defensive only and never
        // occurs for a row the service created.
        orderNumber: row.eventOrder?.orderNumber ?? "",
        status: row.status,
        requestedAmount: moneyString(row.requestedAmount),
        confirmedAmount: moneyString(row.confirmedAmount),
        reason: row.reason,
        failureReason: row.failureReason,
        providerRef: row.providerRef,
        currency: row.eventOrder?.currency ?? "IDR",
        createdAt: row.createdAt.toISOString(),
        approvedAt: row.approvedAt?.toISOString() ?? null,
        processedAt: row.processedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        failedAt: row.failedAt?.toISOString() ?? null,
        items: row.items.map((item) => ({
            ticketCode: item.ticket.ticketCode,
            amount: moneyString(item.amount),
        })),
        // A boolean, never the key. See the note on `refundEvidenceUrl`.
        hasEvidence: row.evidenceFileKey !== null,
    };
}
