import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import SiteShell from "@/components/ticketing/SiteShell";
import TicketQr from "@/components/tickets/TicketQr";
import TicketStatusBadge from "@/components/ticketing/TicketStatusBadge";
import { getAuthzScope } from "@/lib/authz";
import { getOwnTicket } from "@/lib/ticketing/tickets/service";
import {
    formatEventDateLong,
    formatEventTime,
    formatVenue,
} from "@/lib/ticketing/ui/format";
import { sportLabel, sportSolidTint } from "@/lib/ticketing/ui/sport-tint";

/**
 * ==========================================
 * PHASE 9 — E-TICKET (/ticketing/tickets/{ticketCode})
 * ==========================================
 *
 * Design §26.6's ticket detail, presented as an actual digital ticket.
 *
 * ── WHAT IS NOT ON THIS PAGE, ON PURPOSE ────────────────────────────────────────
 * Brief §24: "Do not add: fake check-in status, fake validation button, fake payment verification,
 * fake ticket scanner. If check-in is not implemented, the UI must not pretend that it is."
 * Check-in is a later phase, so there is no "validate" button, no scanner and no invented
 * check-in state — only the factually recorded `checkedInAt` (always null in this build, because
 * nothing can set it yet).
 *
 * ── WHERE THE QR COMES FROM ─────────────────────────────────────────────────────
 * `getOwnTicket` resolves the ticket for the session user and returns the exact payload to encode,
 * which `TicketQr` passes to the renderer verbatim. The page never assembles a QR value from a code
 * it holds, and the payload is not the ticket's scanner secret — see
 * `lib/ticketing/tickets/reference.ts`. Design §19.3's raw token is never returned by any endpoint.
 *
 * ── PRIVACY ─────────────────────────────────────────────────────────────────────
 * Brief §25/§37: an opaque code does not make a ticket page public, and another buyer's code renders
 * as 404 — the same answer as a code that was never issued.
 *
 * ── PHASE 16 — WHAT AN EVENT-AWARE VERDICT MEANS HERE ───────────────────────────
 * `admission.scannable` now answers both halves of the gate's own question (is the TICKET still a
 * credential, and is the EVENT still admitting), so a ticket for a cancelled, archived or
 * completed-and-past-grace event shows the blocked explanation instead of a live QR that the
 * check-in API would refuse with `EVENT_NOT_OPEN`. The buyer still reaches the ticket, the code and
 * the record of what they bought — the page merely stops claiming the door is open when it is not.
 *
 * ── PRINT ────────────────────────────────────────────────────────────────────────
 * There is deliberately NO print button: `__tests__/ui-consolidation/checkin-gate.test.ts` pins this
 * file (and its siblings) as free of interactive controls, so that no buyer surface can grow a
 * check-in affordance by accident. Printing is therefore the browser's own (Ctrl/Cmd + P) plus
 * `print:` utilities that drop the site chrome and the action row and keep the QR, the code and the
 * venue on the sheet — which is the "browser-print-friendly view" the brief allows, with no PDF
 * engine and no new dependency.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
    title: "Tiket elektronik",
    robots: { index: false, follow: false },
};

/**
 * Why a QR is not shown, when it is not.
 *
 * The reasons come from the server-side status decision, not from a guess here. A revoked or
 * already-used ticket must not present a live-looking credential.
 */
const BLOCKED_REASONS: Record<string, string> = {
    ALREADY_CHECKED_IN: "Tiket ini sudah dipakai untuk masuk.",
    TICKET_VOID: "Tiket ini sudah dibatalkan dan tidak berlaku.",
    TICKET_REFUNDED: "Tiket ini sudah dikembalikan dananya dan tidak berlaku lagi.",
    NOT_PAID: "Pembayaran pesanan ini belum dikonfirmasi.",
    UNKNOWN_STATUS: "Status tiket ini tidak dikenal. Hubungi penyelenggara.",
    // PHASE 16 — the event half of the verdict, decided server-side by the same predicate the
    // check-in API uses. It covers every way an event stops admitting (cancelled, archived, or
    // past `endAt + 30 minutes`) without pretending to know which one applies, because naming a
    // reason the buyer cannot act on differently would be noise. "Hubungi penyelenggara" is the
    // honest next step for all of them.
    EVENT_NOT_OPEN:
        "Event ini sudah selesai, dibatalkan, atau belum dibuka, sehingga QR tidak lagi dipindai di pintu masuk. Hubungi penyelenggara bila Anda memerlukan informasi lebih lanjut.",
};

type Props = { params: Promise<{ ticketCode: string }> };

export default async function TicketDetailPage({ params }: Props) {
    const { ticketCode } = await params;

    const scope = await getAuthzScope();

    if (!scope) {
        redirect(
            `/login?next=${encodeURIComponent(`/ticketing/tickets/${ticketCode}`)}`
        );
    }

    // `getOwnTicket` throws NOT_FOUND both for a malformed code and for another buyer's ticket, so
    // both render identically here.
    const ticket = await getOwnTicket(ticketCode, scope).catch(() => null);

    if (!ticket) {
        notFound();
    }

    return (
        <SiteShell>
            <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:py-12">
                <Link
                    href="/ticketing/tickets"
                    className="inline-flex items-center gap-2 text-sm font-semibold text-ink-500 transition hover:text-ink-900 print:hidden"
                >
                    <span aria-hidden>←</span> Tiket saya
                </Link>

                {/* ── The ticket itself ─────────────────────────────────────────── */}
                <article className="mt-4 overflow-hidden rounded-3xl border border-ink-100 bg-white shadow-card print:mt-0 print:rounded-none print:border-0 print:shadow-none">
                    <header
                        className={`relative px-6 py-6 text-white ${sportSolidTint(
                            ticket.event.sportName
                        )}`}
                    >
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full bg-black/20 px-2.5 py-1 text-[0.7rem] font-bold">
                                {sportLabel(ticket.event.sportName)}
                            </span>
                            <span className="rounded-full bg-white/95 px-2.5 py-1 text-[0.7rem] font-bold text-ink-900">
                                E-tiket
                            </span>
                        </div>

                        <h1 className="mt-3 text-xl leading-snug font-black tracking-tight sm:text-2xl">
                            {ticket.event.title}
                        </h1>

                        <p className="mt-1.5 text-sm font-semibold opacity-90">
                            {formatEventDateLong(ticket.event.startAt)} ·{" "}
                            {formatEventTime(ticket.event.startAt)} WIB
                        </p>
                    </header>

                    <div className="px-6 py-6">
                        <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                            <div>
                                <dt className="text-[0.7rem] font-bold tracking-wider text-ink-400 uppercase">
                                    Lokasi
                                </dt>
                                <dd className="mt-1 font-semibold text-ink-900">
                                    {formatVenue(
                                        ticket.event.venueName,
                                        ticket.event.venueCity
                                    )}
                                </dd>
                                {ticket.event.venueAddress ? (
                                    <dd className="mt-0.5 text-xs leading-relaxed text-ink-500">
                                        {ticket.event.venueAddress}
                                    </dd>
                                ) : null}
                            </div>
                            <div>
                                <dt className="text-[0.7rem] font-bold tracking-wider text-ink-400 uppercase">
                                    Jenis tiket
                                </dt>
                                <dd className="mt-1 font-semibold text-ink-900">
                                    {ticket.ticketTypeName}
                                </dd>
                            </div>
                            {ticket.attendeeName ? (
                                <div>
                                    <dt className="text-[0.7rem] font-bold tracking-wider text-ink-400 uppercase">
                                        Pemegang tiket
                                    </dt>
                                    <dd className="mt-1 font-semibold text-ink-900">
                                        {ticket.attendeeName}
                                    </dd>
                                </div>
                            ) : null}
                            <div>
                                <dt className="text-[0.7rem] font-bold tracking-wider text-ink-400 uppercase">
                                    Status
                                </dt>
                                <dd className="mt-1.5">
                                    <TicketStatusBadge status={ticket.status} />
                                </dd>
                            </div>
                        </dl>

                        {/* A perforation line, drawn rather than imaged. */}
                        <div
                            aria-hidden
                            className="my-6 border-t border-dashed border-ink-200"
                        />

                        <div className="flex flex-col items-center">
                            {ticket.admission.scannable ? (
                                <TicketQr payload={ticket.qr.payload} />
                            ) : (
                                <div
                                    role="status"
                                    className="w-full rounded-2xl border border-amber-200 bg-amber-50 px-5 py-8 text-center"
                                >
                                    <p className="text-sm font-bold text-amber-900">
                                        QR tidak ditampilkan
                                    </p>
                                    <p className="mt-1 text-sm text-amber-800">
                                        {BLOCKED_REASONS[
                                            ticket.admission.reason ?? ""
                                        ] ?? "Tiket ini tidak dapat digunakan."}
                                    </p>
                                </div>
                            )}

                            {ticket.admission.scannable ? (
                                <p className="mt-4 text-center text-xs text-ink-500">
                                    Tunjukkan QR ini di pintu masuk. Petugas akan
                                    memindai kodenya.
                                </p>
                            ) : null}

                            {/* The QR is the credential and the code below it is the
                             * keyboard-wedge/manual fallback, so a printout carries both. The
                             * advice is on screen only — on paper the reader already holds the
                             * ticket. */}
                            <p className="mt-2 hidden text-center text-[0.7rem] text-ink-500 print:block">
                                Bila QR tidak terbaca, sebutkan atau ketik kode di atas.
                            </p>

                            <p className="mt-5 font-mono text-lg font-extrabold tracking-[0.15em] text-ink-900">
                                {ticket.ticketCode}
                            </p>
                            <p className="mt-1 text-[0.7rem] font-semibold text-ink-400">
                                Kode tiket
                            </p>
                        </div>
                    </div>

                    <footer className="border-t border-ink-100 bg-ink-50/60 px-6 py-5">
                        <dl className="space-y-2 text-xs text-ink-600">
                            <div className="flex justify-between gap-3">
                                <dt>Nomor pesanan</dt>
                                <dd className="font-mono font-semibold text-ink-900">
                                    {ticket.orderNumber}
                                </dd>
                            </div>
                            <div className="flex justify-between gap-3">
                                <dt>Tiket ke-</dt>
                                <dd className="font-semibold text-ink-900">
                                    {ticket.sequenceNo}
                                </dd>
                            </div>
                            <div className="flex justify-between gap-3">
                                <dt>Diterbitkan</dt>
                                <dd className="font-semibold text-ink-900">
                                    {ticket.issuedAt
                                        ? `${formatEventDateLong(
                                              ticket.issuedAt
                                          )} · ${formatEventTime(ticket.issuedAt)} WIB`
                                        : "—"}
                                </dd>
                            </div>
                            {ticket.checkedInAt ? (
                                <div className="flex justify-between gap-3">
                                    <dt>Waktu masuk</dt>
                                    <dd className="font-semibold text-ink-900">
                                        {formatEventDateLong(ticket.checkedInAt)} ·{" "}
                                        {formatEventTime(ticket.checkedInAt)} WIB
                                    </dd>
                                </div>
                            ) : null}
                        </dl>
                    </footer>
                </article>

                <div className="mt-5 flex flex-wrap items-center gap-3 print:hidden">
                    <Link
                        href={`/ticketing/orders/${encodeURIComponent(
                            ticket.orderNumber
                        )}`}
                        className="rounded-xl border border-ink-200 bg-white px-5 py-2.5 text-sm font-bold text-ink-800 transition hover:border-ink-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900"
                    >
                        Lihat pesanan
                    </Link>

                    {ticket.event.slug ? (
                        <Link
                            href={`/e/${ticket.event.slug}`}
                            className="rounded-xl px-3 py-2.5 text-sm font-semibold text-ink-600 transition hover:text-ink-900"
                        >
                            Halaman event
                        </Link>
                    ) : null}
                </div>

                <p className="mt-5 text-xs leading-relaxed text-ink-500 print:hidden">
                    E-tiket ini bersifat pribadi. Jangan bagikan tangkapan layarnya —
                    siapa pun yang memiliki kode QR dapat memakainya untuk masuk. Ingin
                    versi cetak? Gunakan cetak halaman dari peramban Anda (Ctrl/Cmd + P)
                    untuk mencetak atau menyimpan tiket sebagai PDF.
                </p>
            </div>
        </SiteShell>
    );
}
