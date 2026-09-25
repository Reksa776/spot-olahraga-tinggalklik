import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { getAppOrigin } from "@/lib/app-origin";
import { getMaintenanceState } from "@/lib/app-settings";
import { getPublicEventBySlug } from "@/lib/events/catalog";
import { assertNotInMaintenance } from "@/lib/maintenance";

/**
 * GET /api/events/[slug] — public event detail (design §25.3)
 *
 * PUBLIC. Resolves by `slug` **or** `shareCode` (§25.3).
 *
 * Status handling follows decision D-14 (LOCKED): an unpublished (DRAFT) event still
 * resolves, but its payload carries `isAvailable: false` and an
 * `unavailableReason`, so the page can render a clearly unavailable read-only state
 * instead of a 404. ARCHIVED events return 404 — design §10.3 requires them hidden
 * from all public surfaces.
 *
 * The payload is built by explicit field mapping from narrow `select`s, so no
 * organizer id, tenant membership data, audit field or financial field can reach the
 * response. `remaining` is returned as `null` because D-15 is undecided
 * (see `lib/events/sales-state.ts`).
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    return handleApi(async () => {
        // PHASE 32 — the public application is closed as a whole while maintenance is ON, and
        // this is the JSON form of the event page, so it closes with it.
        assertNotInMaintenance(await getMaintenanceState());

        const { slug } = await params;

        const origin = getAppOrigin(request);

        const event = await getPublicEventBySlug(slug, origin);

        return ok(event);
    });
}
