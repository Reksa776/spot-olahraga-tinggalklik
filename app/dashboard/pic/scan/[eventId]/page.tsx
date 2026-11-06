import { notFound } from "next/navigation";

import TicketScanner from "@/components/organizer/TicketScanner";
import {
    InfoNote,
    SectionCard,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { isAuthzError } from "@/lib/authz";
import { isEventCheckInOpen } from "@/lib/events/sales-state";
import { eventStatusTone } from "@/lib/events/status";
import { prisma } from "@/lib/prisma";
import { requirePicScanAccess } from "@/lib/ticketing/checkin/service";

/**
 * ==========================================
 * PHASE 3E — PIC SCANNER PAGE
 * ==========================================
 *
 * The PIC's door into the SAME admission engine the staff gate uses, mounted on the
 * authenticated Phase 3D route `POST /api/pic/events/[eventId]/check-in`.
 *
 * ── AUTHORIZATION HAPPENS HERE, ON THE SERVER ─────────────────────────────────────
 * `requirePicScanAccess` asks only the Phase 3A question: the session user's own ACTIVE
 * `PICProfile`, an active non-revoked `PICEventAssignment` for THIS event, and the decider.
 * It never accepts an event, user, assignment, role or permission from the request — the
 * only client input is the route's event id, and that id is used to LOOK UP authority, not
 * to assert it. Every refusal is `notFound()`: an event the caller cannot scan at is
 * indistinguishable from an event that does not exist, so the page is not an existence
 * oracle. The API repeats the check on every scan, so a direct request cannot bypass it.
 *
 * ── WHAT A PIC MAY SEE ────────────────────────────────────────────────────────────
 * The shared scanner renders the result of the scan just performed. It is mounted with
 * `canReadLog={false}` — no attendance list, no other attendee's history, no totals beyond
 * the scans this device made. The service additionally nulls `firstCheckedInBy` for a PIC
 * caller, so another operator's identity never reaches the browser. There is no GET call:
 * the route is POST-only by design (B-4).
 *
 * ── WHY THE PAGE IS A THIN SHELL ──────────────────────────────────────────────────
 * Camera permission handling, the BarcodeDetector/jsQR fallback, the duplicate-frame
 * throttle, the single in-flight submission guard and camera release on unmount all live in
 * `TicketScanner`. Reimplementing any of them here would fork the device that the staff gate
 * has already proven; this page supplies only the event context and the endpoint.
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Pindai Tiket" };

export default async function PicScannerPage({
    params,
}: {
    params: Promise<{ eventId: string }>;
}) {
    const { eventId } = await params;

    let access: Awaited<ReturnType<typeof requirePicScanAccess>>;

    try {
        access = await requirePicScanAccess(eventId);
    } catch (error) {
        if (isAuthzError(error)) {
            // No event-existence oracle: unassigned, revoked, inactive and unknown all 404.
            notFound();
        }

        throw error;
    }

    // Display fields only — authorization already happened above, and the row is fetched by
    // the id the guard just authorized.
    const event = await prisma.event.findUnique({
        where: { id: access.event.id },
        select: {
            id: true,
            title: true,
            eventCode: true,
            slug: true,
            status: true,
            startAt: true,
            endAt: true,
            archivedAt: true,
            cancelledAt: true,
            requiresCheckIn: true,
        },
    });

    if (!event) {
        notFound();
    }

    // The window is the canonical server-side predicate — the same one the API enforces.
    // The browser clock never decides whether the gate is open.
    const now = new Date();
    const checkInOpen = isEventCheckInOpen(event, now);
    const inGraceWindow =
        checkInOpen &&
        event.endAt !== null &&
        now.getTime() > event.endAt.getTime();

    const gateState: "OPEN" | "GRACE" | "CLOSED" = !checkInOpen
        ? "CLOSED"
        : inGraceWindow
          ? "GRACE"
          : "OPEN";

    return (
        <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
                <TextLink href="/dashboard/pic#events">
                    ← Kembali ke event saya
                </TextLink>

                <h1 className="mt-1 text-2xl font-bold leading-tight tracking-tight">
                    {event.title}
                </h1>

                <p className="text-sm text-muted-foreground">
                    {event.eventCode} ·{" "}
                    <span className="font-mono">/e/{event.slug}</span>
                </p>

                <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <span>Status:</span>
                    <StatusBadge tone={eventStatusTone(event.status)}>
                        {event.status}
                    </StatusBadge>
                </p>

                <p className="text-xs text-muted-foreground">
                    Hanya hasil pemindaianmu yang ditampilkan di halaman ini. Daftar
                    kehadiran dan identitas petugas lain tidak ditampilkan.
                </p>
            </div>

            <SectionCard title="Pindai tiket">
                {checkInOpen ? (
                    <TicketScanner
                        eventId={event.id}
                        endpoint={`/api/pic/events/${event.id}/check-in`}
                        canReadLog={false}
                        initialItems={[]}
                        initialTotal={0}
                        gateState={gateState}
                        requiresCheckIn={event.requiresCheckIn}
                    />
                ) : (
                    <InfoNote tone="warn">
                        Event ini tidak menerima check-in pada statusnya saat ini
                        {event.status === "CANCELLED"
                            ? " karena sudah dibatalkan"
                            : event.archivedAt !== null
                              ? " karena sudah diarsipkan"
                              : event.status === "COMPLETED"
                                ? " karena sudah selesai dan masa tenggang check-in telah berakhir"
                                : " karena belum dipublikasikan"}
                        . Hubungi penyelenggara bila kamu yakin pintu masuk seharusnya
                        masih terbuka.
                    </InfoNote>
                )}
            </SectionCard>
        </div>
    );
}
