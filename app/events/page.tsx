import Link from "next/link";

import EventCard from "@/components/events/EventCard";
import CatalogFilters from "@/components/ticketing/CatalogFilters";
import CatalogPagination from "@/components/ticketing/CatalogPagination";
import EmptyState from "@/components/ticketing/EmptyState";
import SiteShell from "@/components/ticketing/SiteShell";
import { parseOrThrow } from "@/lib/api/validation";
import { getServerOrigin } from "@/lib/app-origin.server";
import { listPublicEvents } from "@/lib/events/catalog";
import { catalogQuerySchema } from "@/lib/events/validation";
import { listPublicSports } from "@/lib/sports/service";
import { normalizeCatalogParams } from "@/lib/ticketing/ui/catalog-href";

/**
 * ==========================================
 * PHASE 9 — PUBLIC EVENT DISCOVERY (/events)
 * ==========================================
 *
 * Still entirely server-rendered from `listPublicEvents` — the same function the public API uses —
 * so the visibility rules (PUBLISHED + PUBLIC, nothing archived, nothing past) stay enforced in one
 * place. The page never queries Prisma directly.
 *
 * What changed in this phase is the experience, not the contract:
 *   • every supported filter is now reachable (city, price, date range, sort, pagination), where
 *     before only search / sport / sort had controls;
 *   • filter state lives in the URL and every control is a link or a GET form, so a filtered view is
 *     shareable and works without JavaScript;
 *   • the empty state distinguishes "nothing matched your filters" (with the way out) from
 *     "there are no events at all".
 *
 * `force-dynamic` is unchanged from the previous version: availability (sold out, sales closed) is
 * live state and must not be served stale.
 */

export const dynamic = "force-dynamic";

export const metadata = {
    title: "Event & Pertandingan Olahraga — TinggalKlik.Co",
    description:
        "Jelajahi event olahraga dan pertandingan: filter berdasarkan cabang olahraga, kota, harga, dan tanggal.",
};

type SearchParams = {
    q?: string;
    sport?: string;
    city?: string;
    dateFrom?: string;
    dateTo?: string;
    priceMax?: string;
    hasTickets?: string;
    sort?: string;
    page?: string;
};

export default async function EventsCatalogPage({
    searchParams,
}: {
    searchParams: Promise<SearchParams>;
}) {
    const params = await searchParams;

    // The same schema the public API validates with, including the `sort` allow-list, so a
    // hand-edited URL cannot reach the query builder with an arbitrary value.
    const query = parseOrThrow(catalogQuerySchema, {
        q: params.q,
        sport: params.sport,
        city: params.city,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        priceMax: params.priceMax,
        hasTickets: params.hasTickets,
        sort: params.sort,
        page: params.page,
    });

    const origin = await getServerOrigin();

    const [result, sports] = await Promise.all([
        listPublicEvents(query, origin),
        listPublicSports(),
    ]);

    // Link state, kept in its string form: what the URL carried, allow-listed and non-empty.
    const hrefParams = normalizeCatalogParams(params);
    const activeSport = sports.items.find((sport) => sport.slug === query.sport);
    const hasFilters = Boolean(
        query.q ||
            query.sport ||
            query.city ||
            query.priceMax !== undefined ||
            query.dateFrom ||
            query.dateTo
    );

    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10">
                    <nav aria-label="Breadcrumb" className="text-xs text-ink-500">
                        <Link
                            href="/"
                            className="font-semibold transition hover:text-ink-900"
                        >
                            Beranda
                        </Link>
                        <span aria-hidden className="px-2">
                            /
                        </span>
                        <span className="font-semibold text-ink-900">Event</span>
                    </nav>

                    <h1 className="mt-3 text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        {activeSport
                            ? `Event ${activeSport.name}`
                            : "Event & Pertandingan Olahraga"}
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm text-ink-500">
                        Cari berdasarkan cabang olahraga, kota, tanggal, dan harga.
                        Setiap hasil bisa dibagikan lewat tautan.
                    </p>
                </div>
            </div>

            <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
                <CatalogFilters
                    params={hrefParams}
                    sports={sports.items}
                    total={result.pagination.total}
                />

                {query.q ? (
                    <p className="mt-6 text-sm text-ink-500">
                        Hasil untuk{" "}
                        <span className="font-bold text-ink-900">
                            “{query.q}”
                        </span>
                    </p>
                ) : null}

                {result.items.length === 0 ? (
                    <div className="mt-6">
                        <EmptyState
                            title={
                                hasFilters
                                    ? "Belum ada event yang cocok"
                                    : "Belum ada event yang tayang"
                            }
                            description={
                                hasFilters
                                    ? "Coba hapus beberapa filter, atau pilih cabang olahraga lain."
                                    : "Event yang sudah dipublikasikan penyelenggara akan muncul di sini."
                            }
                            action={
                                hasFilters
                                    ? { href: "/events", label: "Hapus semua filter" }
                                    : undefined
                            }
                            secondaryAction={
                                hasFilters
                                    ? { href: "/", label: "Kembali ke beranda" }
                                    : { href: "/dashboard/events", label: "Buat event" }
                            }
                        />
                    </div>
                ) : (
                    <ul className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {result.items.map((event) => (
                            <li key={event.slug}>
                                <EventCard event={event} />
                            </li>
                        ))}
                    </ul>
                )}

                <CatalogPagination
                    params={hrefParams}
                    page={result.pagination.page}
                    totalPages={result.pagination.totalPages}
                />
            </div>
        </SiteShell>
    );
}
