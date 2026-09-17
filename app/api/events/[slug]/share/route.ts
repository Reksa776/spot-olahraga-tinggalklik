import type { NextRequest } from "next/server";

import { handleApi, ok } from "@/lib/api/response";
import { getAppOrigin } from "@/lib/app-origin";
import { getPublicEventBySlug } from "@/lib/events/catalog";

/**
 * GET /api/events/[slug]/share — share metadata (requirement §4, design §25.6)
 *
 * PUBLIC. This is the surface behind "Bisa share satu event": the canonical link, the
 * Open Graph payload a chat client renders as a rich card, and the exact string to
 * encode as a QR.
 *
 * WHY IT REUSES THE DETAIL QUERY
 * ------------------------------
 * It calls `getPublicEventBySlug` rather than issuing its own query. That is a
 * correctness choice, not convenience: the visibility rules (ARCHIVED → 404,
 * reserved PRIVATE → 404, DRAFT resolves but is marked unavailable, PUBLISHED →
 * available) are then guaranteed to be identical to the detail page. A separate
 * query would be a second place for the visibility filter to drift, and a drift here
 * would leak an unpublished event's metadata into a shareable card.
 *
 * WHY THE PIC-TRACKED VARIANT IS ABSENT
 * -------------------------------------
 * Design §25.6 specifies that an authorized PIC for an assigned event receives a
 * `shareUrl` carrying a **tracking token**, while "an anonymous caller can only obtain
 * the un-tracked public link, so the share surface cannot be abused to fabricate
 * attribution."
 *
 * The PIC model — `PICProfile`, `PICEventAssignment`, attribution windows (D-01, D-04)
 * — is Phase 9 and does not exist yet, so this endpoint always returns the un-tracked
 * link and `trackingToken: null`. It deliberately does NOT mint a token that nothing
 * can validate: a fabricated attribution value would be worse than none, because it
 * would have to be trusted at settlement time. Recorded in the Phase 4 report as a
 * Phase 9 dependency.
 *
 * WHY THERE IS NO QR IMAGE URL
 * ---------------------------
 * §25.6 mentions "a QR image URL for download". Producing a PNG server-side would add
 * a QR encoder dependency to a project that does not have one, while the design notes
 * (§10.6) that `qrcode.react@^4.2.0` is **already installed** and renders QR codes
 * client-side. `qr.payload` is therefore returned as the precise string to encode, and
 * the client renders it with the existing dependency. No package is added, and the
 * content of the QR is fixed server-side so the client cannot encode something else.
 */

export const runtime = "nodejs";

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    return handleApi(async () => {
        const { slug } = await params;

        const origin = getAppOrigin(request);

        const event = await getPublicEventBySlug(slug, origin);

        const canonicalUrl = event.shareUrl;

        return ok({
            slug: event.slug,
            title: event.title,
            /** Canonical public URL (design §10.6). Never carries tracking params. */
            canonicalUrl,
            shareUrl: canonicalUrl,
            /**
             * Always null in Phase 4 — the PIC attribution model is Phase 9
             * (D-01/D-04 unresolved). See the module note above.
             */
            trackingToken: null,
            isAvailable: event.isAvailable,
            unavailableReason: event.unavailableReason,
            og: {
                title: event.title,
                description:
                    event.description ??
                    `${event.sport.name} · ${event.venue?.name ?? "Lokasi menyusul"}`,
                imageUrl: event.bannerUrl,
                url: canonicalUrl,
                type: "website",
            },
            qr: {
                /** The value the client encodes with the existing `qrcode.react`. */
                payload: canonicalUrl,
                /** The client already has this dependency (design §10.6). */
                renderer: "qrcode.react",
            },
            schedule: {
                startAt: event.startAt,
                endAt: event.endAt,
                timezone: event.timezone,
            },
            venue: event.venue ? { name: event.venue.name, city: event.venue.city } : null,
            sport: event.sport,
        });
    });
}
