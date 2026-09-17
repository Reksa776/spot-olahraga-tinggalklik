import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { getOwnTicket } from "@/lib/ticketing/tickets/service";
import { ticketCodeParamSchema } from "@/lib/ticketing/tickets/validation";

/**
 * GET /api/ticketing/tickets/[ticketCode] — one ticket, with its QR (design §26.6).
 *
 * PROTECTED. See `app/api/ticketing/tickets/route.ts` for why the path is
 * `/api/ticketing/**` rather than the design's `/api/tickets/{ticketCode}`.
 *
 * ── THE ONE PLACE A QR IS RETURNED, AND WHAT IT CONTAINS ────────────────────────
 * The response carries `qr.payload` — the exact string to encode, derived on the server
 * from the ticket's public code. It is NOT the ticket's scanner secret: `Ticket.qrTokenHash`
 * is a one-way hash and the plaintext is unretrievable by design (§19.1), and §26.6
 * explicitly rejects handing the permanent token to a browser. See
 * `lib/ticketing/tickets/reference.ts` for the full argument, including why the QR is a
 * stable public reference rather than a short-lived token — and the `D-46` note in the
 * Phase 8 report.
 *
 * ── OWNERSHIP, AND WHY A MISS IS 404 ────────────────────────────────────────────
 * Brief §15: "Cross-customer access MUST return 404. Do not return 403 where it would
 * disclose that the ticket exists." The lookup is `{ ticketCode, holderUserId: session }`,
 * so someone else's ticket is indistinguishable from a code that was never issued.
 *
 * Design §26.6 allows "an authorized staff/support override that is audited". No such
 * permission exists in the Phase 3 map and inventing one would be new authority, so Phase 8
 * implements the customer path only; staff read is a later phase's decision (recorded in the
 * Phase 8 report).
 */

export const runtime = "nodejs";

export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ ticketCode: string }> }
) {
    return handleApi(async () => {
        const scope = await requireAuth();
        const { ticketCode } = await params;

        const ticket = await getOwnTicket(
            parseOrThrow(ticketCodeParamSchema, ticketCode),
            scope
        );

        return ok(ticket);
    });
}
