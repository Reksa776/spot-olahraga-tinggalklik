import type { NextRequest } from "next/server";

import { getAuthzScope } from "@/lib/authz";
import { handleApi, ok } from "@/lib/api/response";
import { getAppOrigin } from "@/lib/app-origin";
import { getMaintenanceState } from "@/lib/app-settings";
import { getPublicEventBySlug } from "@/lib/events/catalog";
import { assertNotInMaintenance } from "@/lib/maintenance";
import { mintPicReferralToken } from "@/lib/pic/referral";
import { prisma } from "@/lib/prisma";

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
 * WHY THE PIC-TRACKED VARIANT IS SAFE TO MINT HERE
 * ------------------------------------------------
 * Design §25.6: an authorized PIC for an assigned event receives a `shareUrl`
 * carrying a **tracking token**, while "an anonymous caller can only obtain the
 * un-tracked public link, so the share surface cannot be abused to fabricate
 * attribution."
 *
 * The mint is gated by the session + CURRENT database facts, so a token can never be
 * fabricated for attribution:
 *   - the caller is signed in, and their OWN `PICProfile` is ACTIVE, AND
 *   - the event has an assignment for that profile with `isActive` and no `revokedAt`
 *     (the same facts the checkout resolver re-checks before the token becomes money).
 * A token that fails any of these — including a revoked/suspended PIC riding on a
 * stale session — resolves to the plain un-tracked link, never to a fabricated core.
 * The token itself is later verified + re-authorized server-side at checkout; minting
 * here confers nothing by itself.
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

/**
 * Resolve the tracking variant for a signed-in actor, or `null` for the anonymous one.
 *
 * The event id comes back from the public catalog; the actor's id comes from the
 * server-side session — never from the request. Both the profile status and the
 * assignment's activity are re-read from CURRENT rows so a revoked or suspended PIC
 * cannot mint.
 */
async function resolveTrackedShareToken(
    userId: string,
    eventId: string
): Promise<string | null> {
    // The actor's OWN profile only — a tenant membership confers nothing here.
    const profile = await prisma.pICProfile.findFirst({
        where: { userId, status: "ACTIVE" },
        select: { id: true },
    });

    if (!profile) {
        return null;
    }

    const assignment = await prisma.pICEventAssignment.findUnique({
        where: {
            picProfileId_eventId: { picProfileId: profile.id, eventId },
        },
        select: { isActive: true, revokedAt: true },
    });

    if (!assignment?.isActive || assignment.revokedAt !== null) {
        return null;
    }

    // Fail-closed: an unset PIC_REFERRAL_SECRET means no link is exposed at all.
    return mintPicReferralToken({ picProfileId: profile.id, eventId });
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ slug: string }> }
) {
    return handleApi(async () => {
        // PHASE 32 — a shareable Open Graph card is a public surface: while the application is
        // closed, a chat client must not render a rich preview of a catalogue nobody can open.
        assertNotInMaintenance(await getMaintenanceState());

        const { slug } = await params;

        const origin = getAppOrigin(request);

        const event = await getPublicEventBySlug(slug, origin);

        const canonicalUrl = event.shareUrl;

        const scope = await getAuthzScope();

        // §25.6: an anonymous caller gets the un-tracked link; a signed-in, ACTIVE,
        // assigned PIC gets one carrying a signed token. `url.searchParams.append` is
        // avoided deliberately — the token is base64url, and appending is a one-liner.
        const trackingToken = scope?.userId
            ? await resolveTrackedShareToken(scope.userId, event.id)
            : null;

        const shareUrl = trackingToken
            ? `${canonicalUrl}?pic=${encodeURIComponent(trackingToken)}`
            : canonicalUrl;

        return ok({
            slug: event.slug,
            title: event.title,
            /** Canonical public URL (design §10.6). Never carries tracking params. */
            canonicalUrl,
            /**
             * `shareUrl` carries `?pic=<trackingToken>` when the caller is a signed-in,
             * ACTIVE PIC with an active assignment for this event (design §25.6);
             * otherwise it is exactly the canonical URL.
             */
            shareUrl,
            /**
             * Signed PIC referral token, or null — never a token nothing can validate.
             * The checkout resolver re-authors it server-side before it can become money.
             */
            trackingToken,
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
