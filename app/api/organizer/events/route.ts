import type { NextRequest } from "next/server";
import type { EventStatus } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import { created, handleApi, paginated } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { requireSameOrigin } from "@/lib/csrf";
import { createEvent, listOrganizerEvents } from "@/lib/events/service";
import { parseOrThrow } from "@/lib/api/validation";
import { createEventSchema } from "@/lib/events/validation";

/**
 * /api/organizer/events — organizer event management (design §27.1)
 *
 * PROTECTED. Classified in `proxy.ts` PROTECTED_API_PREFIXES, and independently
 * guarded here by `requireAuth()` plus the organizer-scoped permission decision, so
 * the proxy is defence in depth rather than the control.
 *
 * THE ONE RULE THAT MATTERS ON THIS ROUTE
 * ---------------------------------------
 * `organizerId` is read from the request on POST, and it is **never** treated as
 * authority. It names the target, and `createEvent` passes it through
 * `requireOrganizerAccess(organizerId, "event.write")`, which resolves the actor's
 * ACTIVE memberships from the database. A caller can therefore name any organizer it
 * likes and will receive 404 unless it genuinely belongs to that one.
 */

export const runtime = "nodejs";

const EVENT_STATUSES: readonly string[] = [
    "DRAFT",
    "PENDING_REVIEW",
    "PUBLISHED",
    "ONGOING",
    "COMPLETED",
    "CANCELLED",
    "ARCHIVED",
];

export async function GET(request: NextRequest) {
    return handleApi(async () => {
        const scope = await requireAuth();

        const params = request.nextUrl.searchParams;

        const rawStatus = params.get("status");
        let status: EventStatus | null = null;

        if (rawStatus) {
            if (!EVENT_STATUSES.includes(rawStatus)) {
                throw AppError.validation("Status tidak valid.", {
                    fields: [{ path: "status", message: "Status tidak valid." }],
                });
            }

            status = rawStatus as EventStatus;
        }

        const result = await listOrganizerEvents(scope, {
            organizerId: params.get("organizerId"),
            status,
            q: params.get("q"),
            page: params.get("page") ? Number(params.get("page")) : undefined,
            limit: params.get("limit") ? Number(params.get("limit")) : undefined,
        });

        return paginated(result.items, result.pagination);
    });
}

export async function POST(request: NextRequest) {
    return handleApi(async () => {
        const csrf = requireSameOrigin(request);
        if (csrf.error) {
            return csrf.error;
        }

        const scope = await requireAuth();

        const body = (await request.json().catch(() => null)) as
            | Record<string, unknown>
            | null;

        if (!body) {
            throw AppError.validation("Body JSON tidak valid.");
        }

        // The ownership target is pulled out BEFORE validation and never enters the
        // event payload: `createEventSchema` is strict and has no `organizerId` field,
        // so ownership cannot be smuggled into the entity through the fields an event
        // actually has.
        const organizerId = body.organizerId;

        if (typeof organizerId !== "string" || organizerId.length === 0) {
            throw AppError.validation("organizerId wajib diisi.", {
                fields: [{ path: "organizerId", message: "Wajib diisi." }],
            });
        }

        const { organizerId: _target, ...eventFields } = body;

        const input = parseOrThrow(createEventSchema, eventFields);

        const event = await createEvent(scope, organizerId, input, request);

        return created(event);
    });
}
