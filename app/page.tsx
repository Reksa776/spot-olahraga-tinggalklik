import type { Metadata } from "next";
import Link from "next/link";

import EventRow from "@/components/ticketing/EventRow";
import SearchBar from "@/components/ticketing/SearchBar";
import SectionHeader from "@/components/ticketing/SectionHeader";
import SportGrid from "@/components/ticketing/SportGrid";
import SiteShell from "@/components/ticketing/SiteShell";
import Reveal from "@/components/ui/Reveal";
import { parseOrThrow } from "@/lib/api/validation";
import { getServerOrigin } from "@/lib/app-origin.server";
import { getApplicationBranding } from "@/lib/app-settings";
import {
    countPublicEventsBySport,
    listPublicEvents,
    type PublicEventCard,
} from "@/lib/events/catalog";
import { catalogQuerySchema } from "@/lib/events/validation";
import { platformTitle } from "@/lib/metadata";
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

/**
 * The landing page's title, with the brand composed rather than spelled out.
 *
 * `title.absolute` is used deliberately: this route IS the segment the root layout's
 * `title.template` is defined in, so a template is not applied to it. Composing here through the
 * SAME helper the layout uses is what keeps "Home — TinggalKlik.Co" identical in shape to every other
 * page's title while still following a renamed platform.
 */
export async function generateMetadata(): Promise<Metadata> {
    const branding = await getApplicationBranding();

    return {
        title: { absolute: platformTitle("Home", branding.platformName) },
        description:
            "Cari event olahraga dan pertandingan di seluruh Indonesia: basket, badminton, futsal, voli, lari, dan lainnya. Beli tiket dan simpan e-tiket Anda.",
    };
}

const SECTION_LIMIT = 8;

/**
 * When the empty state arrives, in milliseconds. One step behind the hero's cascade, which ends at
 * 300ms, so the page reads as one sequence arriving rather than as two unrelated ones.
 */
const EMPTY_STATE_DELAY_MS = 360;

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
                    /*
                     * The empty state is the page's smallest event — one centred card with no grid
                     * under it — so it takes the subtle `up` step rather than the `section`
                     * treatment the four real sections use. That difference is the point: a
                     * fallback state should not arrive with more force than the content it is
                     * standing in for.
                     *
                     * It is the one block below the hero that reveals ON PAINT rather than on
                     * scroll, and the delay is why: this card sits inside the first screen at every
                     * viewport (its top lands between 75% and 90% of the window height), so the
                     * observer would classify it as "already on screen" and leave it to appear
                     * without motion — which is exactly what a fallback state must not do, since
                     * "nothing is on sale" is the message the visitor has to receive. Revealing it
                     * on the clock, one step behind the hero's cascade, gives it the page's quietest
                     * entrance and no way to be missed.
                     */
                    <Reveal
                        as="section"
                        variant="up"
                        delay={EMPTY_STATE_DELAY_MS}
                        className="rounded-xl border border-ink-100 bg-white px-6 py-16 text-center"
                    >
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
                    </Reveal>
                ) : (
                    <Reveal as="section" scroll variant="section" aria-labelledby="terdekat">
                        <SectionHeader
                            id="terdekat"
                            title="Event terdekat"
                            subtitle="Yang paling cepat digelar"
                            href="/events"
                        />
                        <EventRow events={upcoming} />
                    </Reveal>
                )}

                <Reveal
                    as="section"
                    scroll
                    variant="section"
                    aria-labelledby="cabang-olahraga-heading"
                >
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
                </Reveal>

                {free.items.length > 0 ? (
                    <Reveal as="section" scroll variant="section" aria-labelledby="gratis">
                        <SectionHeader
                            id="gratis"
                            title="Ada tiket gratis"
                            subtitle="Event tanpa biaya masuk"
                            href="/events?priceMax=0"
                        />
                        <EventRow events={free.items} />
                    </Reveal>
                ) : null}

                {newest.items.length > 0 ? (
                    <Reveal as="section" scroll variant="section" aria-labelledby="baru">
                        <SectionHeader
                            id="baru"
                            title="Baru ditambahkan"
                            subtitle="Event yang baru dipublikasikan"
                            href="/events?sort=newest"
                        />
                        <EventRow events={newest.items} />
                    </Reveal>
                ) : null}

                
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
                    <Reveal as="p" className="text-sm font-semibold text-brand-300">
                        Event &amp; olahraga
                    </Reveal>

                    <Reveal
                        as="h1"
                        delay={80}
                        className="mt-3 text-3xl leading-[1.1] font-black tracking-tight sm:text-4xl lg:text-5xl"
                    >
                        Temukan Event &amp; Pertandingan Favoritmu
                    </Reveal>

                    <Reveal
                        as="p"
                        delay={160}
                        className="mt-4 max-w-xl text-sm leading-relaxed text-ink-200 sm:text-base"
                    >
                        Dari liga basket komunitas sampai lomba lari akhir pekan.
                        Cari, pilih tiket, dan simpan e-tiket di satu tempat.
                    </Reveal>

                    <Reveal
                        variant="scale"
                        delay={240}
                        className="mt-8 max-w-2xl"
                    >
                        <SearchBar
                            size="lg"
                            placeholder="Cari event, pertandingan, atau olahraga…"
                        />
                    </Reveal>

                    {shortcuts.length > 0 ? (
                        <Reveal
                            delay={300}
                            className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2"
                        >
                            <span className="text-sm font-semibold text-ink-300">
                                Cabang:
                            </span>
                            {shortcuts.map((sport) => (
                                <Link
                                    key={sport.id}
                                    href={`/events?sport=${encodeURIComponent(
                                        sport.slug
                                    )}`}
                                    className="text-sm font-semibold text-white underline decoration-white/40 underline-offset-4 transition hover:decoration-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                                >
                                    {sport.name}
                                </Link>
                            ))}
                        </Reveal>
                    ) : null}

                    <Reveal
                        as="p"
                        delay={300}
                        className="mt-8 text-sm font-medium text-ink-300"
                    >
                        {totalEvents > 0
                            ? `${totalEvents} event akan datang`
                            : "Event baru akan segera tayang"}
                    </Reveal>
                </div>
            </div>
        </section>
    );
}

/** The organiser call to action — a real destination, not a placeholder form. */
// function OrganizerBand() {
//     return (
//         <section className="overflow-hidden rounded-3xl bg-ink-900 px-6 py-10 text-white sm:px-10 lg:py-12">
//             <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
//                 <div className="max-w-xl">
//                     <h2 className="text-xl font-extrabold tracking-tight sm:text-2xl">
//                         Punya event atau kompetisi?
//                     </h2>
//                     <p className="mt-2 text-sm leading-relaxed text-ink-200">
//                         Buat event, atur jenis tiket, dan pantau penjualannya dari
//                         dasbor penyelenggara.
//                     </p>
//                 </div>

//                 <Link
//                     href="/dashboard/events"
//                     className="shrink-0 rounded-xl bg-brand-600 px-6 py-3.5 text-sm font-bold text-white transition hover:bg-brand-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
//                 >
//                     Mulai buat event
//                 </Link>
//             </div>
//         </section>
//     );
// }

/** Keep the soonest-first ordering while dropping anything already shown twice. */
function dedupe(
    primary: PublicEventCard[],
    secondary: PublicEventCard[]
): PublicEventCard[] {
    const seen = new Set(primary.map((event) => event.slug));

    return [...primary, ...secondary.filter((event) => !seen.has(event.slug))];
}
