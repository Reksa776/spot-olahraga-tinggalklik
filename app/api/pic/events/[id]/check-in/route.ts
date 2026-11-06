import type { NextRequest } from "next/server";

import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { parseOrThrow } from "@/lib/api/validation";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { checkInTicket } from "@/lib/ticketing/checkin/service";
import { checkInRequestSchema } from "@/lib/ticketing/checkin/validation";

/**
 * ==========================================
 * PHASE 3D — PIC SCANNER API
 * ==========================================
 *
 * `POST /api/pic/events/[id]/check-in` — the authenticated PIC's scan endpoint.
 *
 * ── WHAT THIS ROUTE IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────────────
 * It is a THIN adapter: CSRF → session → strict body → the existing admission service. It
 * contains no ticket logic, no transaction and no second authorization rule. The PIC
 * decision lives in `requireEventCheckInAccess`'s PIC branch, which runs the Phase 3A
 * decider (`decidePicEventPermission`) against the session user's own `PICProfile` and the
 * `PICEventAssignment` for THIS event; only then does the single Phase 3C transaction run.
 *
 * There is no GET. B-4 forbids a PIC reading the attendance log, and `listEventCheckIns`
 * requires `checkin.log.read`, which no PIC holds — so there is nothing for a GET to return
 * legitimately, and not mounting one keeps that boundary structural.
 *
 * ── TRUST BOUNDARY ──────────────────────────────────────────────────────────────
 * The actor comes from the session (`requireAuth()`), the event comes from the route
 * segment, and the assignment is read from the database by `(profile, event)`. The body
 * may carry only the presented code and the existing non-authoritative scanner metadata
 * (`gateLabel`, `deviceId`, `clientScannedAt`). `checkInRequestSchema` is `.strict()`, so a
 * body naming a user, a profile, an assignment, a role, a permission, a method, a ticket
 * status, an actor or an event is a 400 — never an override.
 *
 * ── METHOD LABELLING ────────────────────────────────────────────────────────────
 * The public wallet QR contains a public ticket code, not a scanner secret, so every
 * admission this route can produce is `MANUAL` (Phase 3B/3C). The route has no parameter
 * that could ask for `QR_SCAN`, and the service writes only its own constant.
 *
 * ── PROXY ───────────────────────────────────────────────────────────────────────
 * `/api/pic/` is already in `proxy.ts` PROTECTED_API_PREFIXES, so the subtree is
 * session-gated at the edge; `requireAuth()` below is the real control and the proxy entry
 * is defence in depth. `__tests__/authz/route-classification.test.ts` fails if this file is
 * ever left unclassified.
 */

export const runtime = "nodejs";

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        await requireAuth();

        const { id } = await params;

        const body = await request.json().catch(() => null);

        if (body !== null && typeof body !== "object") {
            throw AppError.validation("Body JSON tidak valid.");
        }

        const input = parseOrThrow(checkInRequestSchema, body ?? {});

        const result = await checkInTicket({
            eventId: id,
            input,
            request,
        });

        return ok(result);
    });
}
