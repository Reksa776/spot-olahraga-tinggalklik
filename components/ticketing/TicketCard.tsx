import Link from "next/link";

import type { TicketWalletItem } from "@/lib/ticketing/tickets/payload";
import {
    formatEventDateShort,
    formatEventDay,
    formatEventMonthShort,
    formatEventTime,
    formatVenue,
} from "@/lib/ticketing/ui/format";
import { sportSolidTint } from "@/lib/ticketing/ui/sport-tint";

import TicketStatusBadge from "./TicketStatusBadge";

/**
 * One ticket in the wallet.
 *
 * Renders only `TicketWalletItem` — the projection the server already authorised and scoped to
 * `holderUserId`. There is no QR here by design (design §26.5): the list endpoint deliberately
 * omits it so a cached or logged list response cannot leak a scannable credential.
 *
 * ── WHY THERE IS NO EVENT BANNER ──────────────────────────────────────────────────
 * The brief's suggested card lists an event image. The wallet projection does not carry
 * `bannerUrl`, and widening it would mean editing a Phase 8 payload that a security assertion
 * pins (the detail response is asserted to contain no URL at all). Rather than weaken that, the
 * stub's visual anchor is the event's own date, over a deterministic sport tint — the same
 * identity the catalog cards use, so the wallet still reads as the same product.
 *
 * The whole card is one link and contains no nested interactive element.
 */
export default function TicketCard({ item }: { item: TicketWalletItem }) {
    return (
        <Link
            href={item.walletUrl}
            className="group flex overflow-hidden rounded-2xl border border-ink-100 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-ink-200 hover:shadow-lg hover:shadow-ink-900/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
            <div
                className={`flex w-20 shrink-0 flex-col items-center justify-center gap-1 px-2 py-4 text-center sm:w-24 ${sportSolidTint(
                    item.event.sportName
                )}`}
            >
                <span className="text-xl font-black sm:text-2xl">
                    {formatEventDay(item.event.startAt)}
                </span>
                <span className="text-[0.65rem] font-bold tracking-wider uppercase">
                    {formatEventMonthShort(item.event.startAt)}
                </span>
                <span className="mt-1 text-[0.6rem] font-semibold opacity-80">
                    {formatEventTime(item.event.startAt)}
                </span>
            </div>

            <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[0.7rem] font-bold tracking-wide text-brand-700 uppercase">
                        {item.event.sportName}
                    </span>
                    <TicketStatusBadge status={item.status} size="sm" />
                </div>

                <h3 className="line-clamp-2 text-sm leading-snug font-bold text-ink-900 group-hover:text-brand-800 sm:text-base">
                    {item.event.title}
                </h3>

                <dl className="space-y-1 text-xs text-ink-500">
                    <div className="flex items-center gap-2">
                        <dt className="sr-only">Jenis tiket</dt>
                        <dd className="truncate">{item.ticketTypeName}</dd>
                    </div>
                    <div className="flex items-center gap-2">
                        <dt className="sr-only">Lokasi</dt>
                        {/* PHASE 16 — the venue's city is part of the answer to "where am I
                         * going?", and `formatVenue` already knows how to join the two
                         * without inventing a separator. A venue with neither a name nor a
                         * city still reads as the honest placeholder. */}
                        <dd className="truncate">
                            {formatVenue(
                                item.event.venueName,
                                item.event.venueCity
                            )}
                        </dd>
                    </div>
                    <div className="flex items-center gap-2">
                        <dt className="sr-only">Jadwal</dt>
                        <dd className="truncate">
                            {formatEventDateShort(item.event.startAt)}
                        </dd>
                    </div>
                </dl>

                <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-ink-100 pt-2.5">
                    <span className="font-mono text-[0.7rem] text-ink-500">
                        {item.ticketCode}
                    </span>
                    <span className="text-xs font-bold text-brand-700 group-hover:underline">
                        Lihat tiket
                    </span>
                </div>
            </div>
        </Link>
    );
}
