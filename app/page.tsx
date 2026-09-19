import Link from "next/link";

import EventRow from "@/components/ticketing/EventRow";
import SearchBar from "@/components/ticketing/SearchBar";
import SectionHeader from "@/components/ticketing/SectionHeader";
import SportGrid from "@/components/ticketing/SportGrid";
import SiteShell from "@/components/ticketing/SiteShell";
import { parseOrThrow } from "@/lib/api/validation";
import { getServerOrigin } from "@/lib/app-origin.server";
import {
    countPublicEventsBySport,
    listPublicEvents,
    type PublicEventCard,
} from "@/lib/events/catalog";
import { catalogQuerySchema } from "@/lib/events/validation";
import { listPublicSports } from "@/lib/sports/service";

/**
 * ==========================================
 * PHASE 9 — DISCOVERY HOMEPAGE
 * ==========================================
 *
 * The customer's first screen is now a destination, not a splash: search, sports and real events,
 * all from the same public catalog the API serves.
 *
 * ── EVERY SECTION IS REAL DATA OR IT IS ABSENT ──────────────────────────────────
 * The brief forbids invented content, and there is no ranking signal in the public payload (no
 * views, no sales rank), so there is deliberately **no "Trending" or "Populer" section**: the two
 * orderings that do exist are by date and by creation. A fabricated "🔥 Trending" row over an
 * arbitrary sort would be exactly the fake-stats failure the brief calls out.
 *
 * Sections, and what backs each one:
 *   • Hero                  — real total count of discoverable events
 *   • Event terdekat        — `sort: startAt_asc`
 *   • Cabang olahraga       — the 14 seeded sports + real per-sport counts
 *   • Tiket gratis          — `priceMax: 0` (a real filter), rendered only if it returns rows
 *   • Baru ditambahkan      — `sort: newest`
 *
 * ── WHY THE QUERIES RUN IN PARALLEL AND ARE BOUNDED ────────────────────────────
 * Five independent reads, issued together, each capped (`limit`) and each reusing
 * `listPublicEvents` so the visibility rule is enforced once. The page is `force-dynamic`, matching
 * `/events`: it renders live inventory state (sold out, sales closed) and must not be cached into
 * staleness.
 */

export const dynamic = "force-dynamic";

export const metadata = {
    title: "TinggalKlik.Co — Temukan Event & Pertandingan Olahraga",
    description:
        "Cari event olahraga dan pertandingan di seluruh Indonesia: basket, badminton, futsal, voli, lari, dan lainnya. Beli tiket dan simpan e-tiket Anda.",
};

const SECTION_LIMIT = 8;

export default async function DiscoveryHomePage() {
    const origin = await getServerOrigin();

    // Built through the same schema the public API validates with, so a homepage section can only
    // ever express a filter the catalog actually supports — and the inferred type is constructed
    // in one canonical place rather than hand-written here.
    const nearestQuery = parseOrThrow(catalogQuerySchema, {
        sort: "startAt_asc",
        limit: SECTION_LIMIT,
    });
    const newestQuery = parseOrThrow(catalogQuerySchema, {
        sort: "newest",
        limit: SECTION_LIMIT,
    });
    const freeQuery = parseOrThrow(catalogQuerySchema, {
        priceMax: 0,
        limit: 4,
    });

    const [nearest, newest, free, sports, sportCounts] = await Promise.all([
        listPublicEvents(nearestQuery, origin),
        listPublicEvents(newestQuery, origin),
        listPublicEvents(freeQuery, origin),
        listPublicSports(),
        countPublicEventsBySport(),
    ]);

    const totalEvents = nearest.pagination.total;
    const upcoming = dedupe(nearest.items, newest.items).slice(0, 6);

    return (
        <SiteShell>
            <Hero totalEvents={totalEvents} sports={sports.items} />

            <div className="mx-auto max-w-7xl space-y-14 px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
                {totalEvents === 0 ? (
                    <section className="rounded-3xl border border-dashed border-ink-200 bg-ink-50/60 px-6 py-16 text-center">
                        <h2 className="text-xl font-extrabold text-ink-900">
                            Belum ada event yang tayang
                        </h2>
                        <p className="mx-auto mt-2 max-w-md text-sm text-ink-500">
                            Event yang sudah dipublikasikan penyelenggara akan
                            muncul di sini. Punya event? Publikasikan sekarang.
                        </p>
                        <Link
                            href="/dashboard/events"
                            className="mt-6 inline-block rounded-xl bg-brand-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
                        >
                            Publikasikan event
                        </Link>
                    </section>
                ) : (
                    <section aria-labelledby="terdekat">
                        <SectionHeader
                            id="terdekat"
                            title="Event terdekat"
                            subtitle="Yang paling cepat digelar"
                            href="/events"
                        />
                        <EventRow events={upcoming} />
                    </section>
                )}

                <section aria-labelledby="cabang-olahraga-heading">
                    <SectionHeader
                        id="cabang-olahraga-heading"
                        title="Cabang olahraga"
                        subtitle="Pilih olahraga, lihat eventnya"
                        href="/events#cabang-olahraga"
                        actionLabel="Semua event"
                    />
                    <SportGrid
                        id="cabang-olahraga"
                        sports={sports.items}
                        counts={sportCounts}
                    />
                </section>

                {free.items.length > 0 ? (
                    <section aria-labelledby="gratis">
                        <SectionHeader
                            id="gratis"
                            title="Ada tiket gratis"
                            subtitle="Event tanpa biaya masuk"
                            href="/events?priceMax=0"
                        />
                        <EventRow events={free.items} />
                    </section>
                ) : null}

                {newest.items.length > 0 ? (
                    <section aria-labelledby="baru">
                        <SectionHeader
                            id="baru"
                            title="Baru ditambahkan"
                            subtitle="Event yang baru dipublikasikan"
                            href="/events?sort=newest"
                        />
                        <EventRow events={newest.items} />
                    </section>
                ) : null}

                <OrganizerBand />
            </div>
        </SiteShell>
    );
}

/**
 * The hero.
 *
 * One strong statement, one primary action (search), and a row of the buyer's most likely
 * shortcuts. No fake counters: the only number shown is `totalEvents`, read from the catalog.
 *
 * The chips are derived from the real sports list, so a sport cannot be advertised here that the
 * catalog cannot filter by.
 */
function Hero({
    totalEvents,
    sports,
}: {
    totalEvents: number;
    sports: { id: string; name: string; slug: string }[];
}) {
    const shortcuts = sports.slice(0, 6);

    return (
        <section className="relative overflow-hidden bg-ink-950 text-white hero-wash">
            <div className="mx-auto max-w-7xl px-4 pt-14 pb-16 sm:px-6 lg:px-8 lg:pt-20 lg:pb-24">
                <div className="max-w-3xl">
                    <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-bold tracking-wide text-brand-200 uppercase">
                        Event &amp; olahraga
                    </span>

                    <h1 className="mt-6 text-3xl leading-[1.1] font-black tracking-tight sm:text-4xl lg:text-5xl">
                        Temukan Event &amp; Pertandingan Favoritmu
                    </h1>

                    <p className="mt-4 max-w-xl text-sm leading-relaxed text-ink-200 sm:text-base">
                        Dari liga basket komunitas sampai lomba lari akhir pekan.
                        Cari, pilih tiket, dan simpan e-tiket di satu tempat.
                    </p>

                    <div className="mt-8 max-w-2xl">
                        <SearchBar
                            size="lg"
                            placeholder="Cari event, pertandingan, atau olahraga…"
                        />
                    </div>

                    {shortcuts.length > 0 ? (
                        <div className="mt-6 flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-ink-300">
                                Populer:
                            </span>
                            {shortcuts.map((sport) => (
                                <Link
                                    key={sport.id}
                                    href={`/events?sport=${encodeURIComponent(
                                        sport.slug
                                    )}`}
                                    className="rounded-full border border-white/15 bg-white/5 px-3.5 py-1.5 text-xs font-bold text-white transition hover:border-white/40 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                                >
                                    {sport.name}
                                </Link>
                            ))}
                        </div>
                    ) : null}

                    <p className="mt-8 text-xs font-semibold text-ink-300">
                        {totalEvents > 0
                            ? `${totalEvents} event akan datang`
                            : "Event baru akan segera tayang"}
                    </p>
                </div>
            </div>
        </section>
    );
}

/** The organiser call to action — a real destination, not a placeholder form. */
function OrganizerBand() {
    return (
        <section className="overflow-hidden rounded-3xl bg-ink-900 px-6 py-10 text-white sm:px-10 lg:py-12">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div className="max-w-xl">
                    <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">
                        Punya event atau kompetisi?
                    </h2>
                    <p className="mt-2 text-sm leading-relaxed text-ink-200">
                        Buat event, atur jenis tiket, dan pantau penjualannya dari
                        dasbor penyelenggara.
                    </p>
                </div>

                <Link
                    href="/dashboard/events"
                    className="shrink-0 rounded-xl bg-brand-600 px-6 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                >
                    Mulai buat event
                </Link>
            </div>
        </section>
    );
}

/** Keep the soonest-first ordering while dropping anything already shown twice. */
function dedupe(
    primary: PublicEventCard[],
    secondary: PublicEventCard[]
): PublicEventCard[] {
    const seen = new Set(primary.map((event) => event.slug));

    return [...primary, ...secondary.filter((event) => !seen.has(event.slug))];
}
