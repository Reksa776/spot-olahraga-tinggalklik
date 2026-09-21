import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import EventCard from "@/components/events/EventCard";
import ShareEventMenu from "@/components/events/ShareEventMenu";
import TicketPurchaseForm from "@/components/events/TicketPurchaseForm";
import SiteShell from "@/components/ticketing/SiteShell";
import StickyBuyBar from "@/components/ticketing/StickyBuyBar";
import { auth } from "@/auth";
import { parseOrThrow } from "@/lib/api/validation";
import { resolvePageFailure } from "@/lib/errors/classify";
import { getServerOrigin } from "@/lib/app-origin.server";
import { getPublicEventBySlug, listPublicEvents } from "@/lib/events/catalog";
import { catalogQuerySchema } from "@/lib/events/validation";
import {
    formatEventSchedule,
    formatPriceFrom,
    salesStateLabel,
} from "@/lib/ticketing/ui/format";
import { sportLabel, sportSolidTint } from "@/lib/ticketing/ui/sport-tint";

/**
 * ==========================================
 * PHASE 9 — PUBLIC EVENT DETAIL (/e/{slug})
 * ==========================================
 *
 * Design §10.6 fixes this as the single canonical public URL. It still resolves through
 * `getPublicEventBySlug`, the same function the public API uses, so the HTML page and the JSON
 * response cannot disagree about visibility.
 *
 * DECISION D-14 (LOCKED) — the unavailable state is preserved exactly
 * -----------------------------------------------------------------
 * A DRAFT or CANCELLED event still resolves and renders, clearly marked, with every purchase
 * affordance suppressed; only ARCHIVED 404s. That branch is untouched below apart from its styling.
 *
 * ── WHAT CHANGED ────────────────────────────────────────────────────────────────
 *   • a hero carries the identity (image, sport, title, date, venue) instead of a small banner
 *     above a text column;
 *   • the ticket picker is a sticky card at `lg`+ and a sticky bottom bar below it, so the
 *     purchase action is never more than one tap away;
 *   • related events are added, filtered from the catalog by the event's own sport — real data, no
 *     "recommended for you" fabrication;
 *   • the share affordance moved into the sidebar beside the purchase card, where the buyer already
 *     is, rather than a separate block far down the page.
 *
 * The buyer's session is read only to prefill the contact fields. The page stays public, and the
 * checkout API authenticates independently of what this render saw.
 */

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { slug } = await params;

    try {
        const origin = await getServerOrigin();
        const event = await getPublicEventBySlug(slug, origin);

        return {
            title: event.title,
            description:
                event.description ??
                `Event ${event.sport.name} di ${event.venue?.name ?? "lokasi menyusul"}.`,
            alternates: { canonical: `/e/${event.slug}` },
            openGraph: {
                title: event.title,
                description: event.description ?? undefined,
                url: event.shareUrl,
                images: event.bannerUrl ? [event.bannerUrl] : undefined,
                type: "website",
            },
        };
    } catch {
        // An unavailable event still needs a title rather than an error page.
        return { title: "Event tidak ditemukan" };
    }
}

export default async function EventDetailPage({ params }: Props) {
    const { slug } = await params;

    const origin = await getServerOrigin();

    const session = await auth().catch(() => null);

    /*
     * A 404 from the catalog (unknown slug, or an archived event) becomes a genuine 404 page. A
     * DRAFT or CANCELLED event resolves and is handled by the unavailable branch below.
     *
     * A catalog read that FAILS is not a 404. `.catch(() => null)` used to erase that difference,
     * so a database outage on a public event page told every visitor the event did not exist —
     * including the organiser checking their own event. It is classified instead, and anything
     * that is not genuinely absent propagates to the root error boundary, which offers a retry.
     */
    let event: Awaited<ReturnType<typeof getPublicEventBySlug>>;

    try {
        event = await getPublicEventBySlug(slug, origin);
    } catch (error) {
        if (resolvePageFailure(error).action === "not-found") {
            notFound();
        }

        throw error;
    }

    // Related events: the same sport, excluding this event. Runs after the event resolves because
    // the sport slug is the filter, and is a bounded read of the public catalog — no new query path.
    //
    // A failure here is logged and the section is omitted, NOT rethrown: this is a decorative
    // supplement to a page whose main content has already rendered, and taking the whole event
    // page down because a "related events" query failed would be a worse outcome than showing one
    // fewer band. The failure is still recorded, so it is not silent.
    let related: Awaited<ReturnType<typeof listPublicEvents>>["items"] = [];

    try {
        const result = await listPublicEvents(
            parseOrThrow(catalogQuerySchema, { sport: event.sport.slug, limit: 5 }),
            origin
        );

        related = result.items
            .filter((item) => item.slug !== event.slug)
            .slice(0, 4);
    } catch (error) {
        console.warn(
            `[events/detail] related events unavailable (${resolvePageFailure(error).classification.code})`
        );
    }

    const closedReason = salesStateLabel(
        event.sales.salesState,
        event.sales.isSoldOut,
        event.isAvailable
    );

    const venueLines = event.venue
        ? [event.venue.name, event.venue.address, event.venue.city, event.venue.province]
              .filter(Boolean)
              .join(", ")
        : "Lokasi menyusul";

    const mapHref =
        event.venue &&
        event.venue.latitude !== null &&
        event.venue.longitude !== null
            ? `https://www.google.com/maps/search/?api=1&query=${event.venue.latitude},${event.venue.longitude}`
            : null;

    return (
        <SiteShell>
            <article className="pb-24 lg:pb-0">
                {/* ── Hero ──────────────────────────────────────────────────────── */}
                <header className="relative isolate overflow-hidden bg-ink-950">
                    {event.bannerUrl ? (
                        <img
                            src={event.bannerUrl}
                            alt=""
                            className="absolute inset-0 h-full w-full object-cover opacity-45"
                        />
                    ) : null}
                    <div
                        aria-hidden
                        className="absolute inset-0 bg-linear-to-t from-ink-950 via-ink-950/80 to-ink-950/40"
                    />

                    <div className="relative mx-auto max-w-7xl px-4 pt-8 pb-10 sm:px-6 lg:px-8 lg:pt-10 lg:pb-14">
                        <nav
                            aria-label="Breadcrumb"
                            className="text-xs text-ink-300"
                        >
                            <Link
                                href="/"
                                className="font-semibold transition hover:text-white"
                            >
                                Beranda
                            </Link>
                            <span aria-hidden className="px-2">
                                /
                            </span>
                            <Link
                                href={`/events?sport=${encodeURIComponent(
                                    event.sport.slug
                                )}`}
                                className="font-semibold transition hover:text-white"
                            >
                                {event.sport.name}
                            </Link>
                        </nav>

                        <div className="mt-6 flex flex-wrap items-center gap-2">
                            <span
                                className={`rounded-full px-3 py-1 text-xs font-bold ${sportSolidTint(
                                    event.sport.slug
                                )}`}
                            >
                                {sportLabel(event.sport.name)}
                            </span>

                            {closedReason ? (
                                <span className="rounded-full bg-white/95 px-3 py-1 text-xs font-bold text-ink-900">
                                    {closedReason}
                                </span>
                            ) : null}
                        </div>

                        <h1 className="mt-4 max-w-4xl text-2xl leading-tight font-black tracking-tight text-white sm:text-4xl lg:text-5xl">
                            {event.title}
                        </h1>

                        <dl className="mt-6 grid gap-4 text-sm text-ink-200 sm:grid-cols-2 lg:max-w-3xl">
                            <div>
                                <dt className="text-[0.7rem] font-bold tracking-wider text-ink-400 uppercase">
                                    Jadwal
                                </dt>
                                <dd className="mt-1 font-semibold text-white">
                                    {formatEventSchedule(event.startAt, event.endAt)}
                                </dd>
                            </div>
                            <div>
                                <dt className="text-[0.7rem] font-bold tracking-wider text-ink-400 uppercase">
                                    Lokasi
                                </dt>
                                <dd className="mt-1 font-semibold text-white">
                                    {venueLines}
                                </dd>
                                {mapHref ? (
                                    <a
                                        href={mapHref}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mt-1 inline-block text-xs font-semibold text-brand-300 hover:text-brand-200"
                                    >
                                        Buka di Google Maps
                                    </a>
                                ) : null}
                            </div>
                        </dl>

                        <p className="mt-6 text-xs font-semibold text-ink-300">
                            Diselenggarakan oleh {event.organizer.name}
                        </p>
                    </div>
                </header>

                <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
                    {/* D-14: a read-only, clearly unavailable state — never a silent blank. */}
                    {!event.isAvailable ? (
                        <div
                            role="status"
                            className="mb-8 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4"
                        >
                            <svg
                                aria-hidden
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
                            >
                                <path d="M12 9v4m0 4h.01M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
                            </svg>
                            <div>
                                <p className="font-bold text-amber-900">
                                    Event ini tidak tersedia
                                </p>
                                <p className="mt-1 text-sm text-amber-800">
                                    {event.unavailableReason ??
                                        "Event ini sedang tidak dipublikasikan."}{" "}
                                    Informasi di bawah ditampilkan hanya sebagai
                                    arsip, dan pembelian tiket tidak dapat
                                    dilakukan.
                                </p>
                            </div>
                        </div>
                    ) : null}

                    <div className="grid grid-cols-1 gap-8 lg:grid-cols-3 lg:gap-10">
                        <div className="space-y-10 lg:col-span-2">
                            {event.description ? (
                                <section>
                                    <h2 className="text-lg font-extrabold text-ink-900">
                                        Tentang event
                                    </h2>
                                    <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-ink-600">
                                        {event.description}
                                    </p>
                                </section>
                            ) : null}

                            {event.rules ? (
                                <section>
                                    <h2 className="text-lg font-extrabold text-ink-900">
                                        Peraturan &amp; kebijakan
                                    </h2>
                                    <div className="mt-3 rounded-2xl border border-ink-100 bg-ink-50/60 p-5">
                                        <p className="text-sm leading-relaxed whitespace-pre-line text-ink-600">
                                            {event.rules}
                                        </p>
                                    </div>
                                </section>
                            ) : null}

                            {event.images.length > 1 ? (
                                <section>
                                    <h2 className="text-lg font-extrabold text-ink-900">
                                        Galeri
                                    </h2>
                                    <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                                        {event.images.map((image) => (
                                            <img
                                                key={image.url}
                                                src={image.url}
                                                alt={image.altText ?? event.title}
                                                loading="lazy"
                                                className="h-32 w-full rounded-xl border border-ink-100 object-cover lg:h-40"
                                            />
                                        ))}
                                    </div>
                                </section>
                            ) : null}

                            <section>
                                <h2 className="text-lg font-extrabold text-ink-900">
                                    Informasi penting
                                </h2>
                                <ul className="mt-3 space-y-2 text-sm text-ink-600">
                                    <li className="flex gap-2">
                                        <span aria-hidden>•</span>
                                        <span>
                                            Tiket diterbitkan setelah pembayaran
                                            terverifikasi. Buka halaman pesanan,
                                            lalu temukan tiket Anda di menu{" "}
                                            <Link
                                                href="/ticketing/tickets"
                                                className="font-semibold text-brand-700 hover:underline"
                                            >
                                                Tiket saya
                                            </Link>
                                            .
                                        </span>
                                    </li>
                                    <li className="flex gap-2">
                                        <span aria-hidden>•</span>
                                        <span>
                                            Menunjukkan QR dari e-tiket Anda di
                                            pintu masuk.
                                        </span>
                                    </li>
                                    <li className="flex gap-2">
                                        <span aria-hidden>•</span>
                                        <span>
                                            Harga tiket dapat berubah sebelum
                                            pembayaran diselesaikan. Harga akhir
                                            selalu dihitung oleh sistem saat
                                            pemesanan.
                                        </span>
                                    </li>
                                </ul>
                            </section>
                        </div>

                        {/* ── Sidebar: the purchase card, sticky at `lg`+ ────────── */}
                        <aside className="space-y-5">
                            <div
                                id="beli"
                                className="scroll-mt-24 rounded-2xl border border-ink-100 bg-white p-5 shadow-card lg:sticky lg:top-24"
                            >
                                <div className="flex items-baseline justify-between gap-3">
                                    <h2 className="text-base font-extrabold text-ink-900">
                                        Pilih tiket
                                    </h2>
                                    <span className="text-xs font-bold text-ink-500">
                                        {formatPriceFrom(event.sales.priceFrom)}
                                    </span>
                                </div>

                                {/*
                                 * PHASE 6 — the purchase form. Tier prices and availability are
                                 * rendered from this same catalog payload (one source of truth for
                                 * what the buyer sees); the request the form sends carries no
                                 * amounts at all, because the server recomputes every figure
                                 * (design §17.2).
                                 *
                                 * `event.id` is passed because §25.5's checkout contract takes an
                                 * `eventId`; see the note on `DETAIL_SELECT`.
                                 */}
                                <TicketPurchaseForm
                                    eventId={event.id}
                                    ticketTypes={event.ticketTypes}
                                    isAvailable={event.isAvailable}
                                    defaultBuyer={{
                                        name: session?.user?.name ?? null,
                                        email: session?.user?.email ?? null,
                                        phone: null,
                                    }}
                                />
                            </div>

                            <div className="rounded-2xl border border-ink-100 bg-white p-5 shadow-sm">
                                <h2 className="text-sm font-extrabold text-ink-900">
                                    Bagikan event
                                </h2>
                                <div className="mt-3">
                                    <ShareEventMenu
                                        canonicalUrl={event.shareUrl}
                                        title={event.title}
                                        disabled={!event.isAvailable}
                                    />
                                </div>
                            </div>
                        </aside>
                    </div>

                    {related.length > 0 ? (
                        <section className="mt-14 border-t border-ink-100 pt-10">
                            <div className="mb-5 flex items-end justify-between gap-4">
                                <h2 className="text-xl font-extrabold tracking-tight text-ink-900">
                                    Event {event.sport.name} lainnya
                                </h2>
                                <Link
                                    href={`/events?sport=${encodeURIComponent(
                                        event.sport.slug
                                    )}`}
                                    className="shrink-0 rounded-lg text-sm font-semibold text-brand-700 hover:text-brand-800"
                                >
                                    Lihat semua →
                                </Link>
                            </div>

                            <ul className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
                                {related.map((item) => (
                                    <li key={item.slug}>
                                        <EventCard event={item} />
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : null}
                </div>
            </article>

            {/* The phone-sized purchase bar. Only when the CTA would actually work. */}
            {event.isAvailable ? (
                <StickyBuyBar
                    priceFrom={event.sales.priceFrom}
                    href="#beli"
                    ctaLabel="Pilih tiket"
                    disabledReason={closedReason}
                />
            ) : null}
        </SiteShell>
    );
}
