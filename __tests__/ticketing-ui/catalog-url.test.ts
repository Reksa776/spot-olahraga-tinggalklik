import {
    CATALOG_SORT_OPTIONS,
    DEFAULT_CATALOG_SORT,
    buildCatalogHref,
    isActiveParam,
    normalizeCatalogParams,
} from "@/lib/ticketing/ui/catalog-href";
import {
    CATALOG_SORT_VALUES,
    catalogQuerySchema,
} from "@/lib/events/validation";

/**
 * ==========================================
 * PHASE 9 — CATALOG URL STATE (pure)
 * ==========================================
 *
 * The discovery surfaces filter through the URL, so these are the rules the whole experience rests
 * on: a shareable link must carry exactly the filters the server accepts, an empty control must
 * REMOVE its parameter rather than send `?sport=`, and changing a filter must not leave the buyer
 * on page 4 of a 1-page result.
 *
 * Nothing here touches the database or a renderer.
 */

describe("D1. normalizeCatalogParams", () => {
    it("keeps only the parameters the catalog actually accepts", () => {
        const normalized = normalizeCatalogParams({
            q: "basket",
            sport: "basket",
            city: "Bandung",
            dateFrom: "2026-10-01",
            dateTo: "2026-10-31",
            priceMax: "150000",
            hasTickets: "true",
            sort: "newest",
            page: "2",
            // Everything below is dropped: either not a catalog parameter, or the legacy share
            // attributes that legitimately appear on a public link (design §10.6).
            ref: "share-9",
            utm_source: "whatsapp",
            status: "PAID",
            admin: "1",
        });

        expect(normalized).toEqual({
            q: "basket",
            sport: "basket",
            city: "Bandung",
            dateFrom: "2026-10-01",
            dateTo: "2026-10-31",
            priceMax: "150000",
            hasTickets: "true",
            sort: "newest",
            page: "2",
        });
    });

    it("drops empty and whitespace-only values instead of sending empty filters", () => {
        expect(
            normalizeCatalogParams({
                q: "",
                sport: "   ",
                city: "",
                priceMax: "",
                sort: "",
            })
        ).toEqual({});
    });
});

describe("D2. buildCatalogHref", () => {
    const current = {
        q: "basket",
        sport: "basket",
        city: "Bandung",
        sort: "price_asc",
        page: "3",
    };

    it("preserves every active filter when nothing is overridden", () => {
        const href = buildCatalogHref(current);

        expect(href).toContain("/events?");
        expect(href).toContain("q=basket");
        expect(href).toContain("sport=basket");
        expect(href).toContain("city=Bandung");
        expect(href).toContain("sort=price_asc");
        expect(href).toContain("page=3");
    });

    it("removes a parameter when its override is undefined (the 'Semua cabang' chip)", () => {
        const href = buildCatalogHref(current, { sport: undefined });

        expect(href).not.toContain("sport=");
        expect(href).toContain("q=basket");
    });

    it("resets pagination when a FILTER changes, so page 3 of a narrowed result is never shown", () => {
        const href = buildCatalogHref(current, { city: "Jakarta" });

        expect(href).toContain("city=Jakarta");
        expect(href).not.toContain("page=");
    });

    it("keeps the page only when the page itself is what changed", () => {
        const href = buildCatalogHref(current, { page: "4" });

        expect(href).toContain("page=4");
        expect(href).toContain("sport=basket");
    });

    it("returns the bare path when nothing is applied, rather than a trailing '?'", () => {
        expect(buildCatalogHref({})).toBe("/events");
        expect(buildCatalogHref({ q: "", sport: "" })).toBe("/events");
    });

    it("escapes values rather than interpolating them raw", () => {
        const href = buildCatalogHref({}, { q: "lari 10km & fun" });

        expect(href).toContain("q=lari+10km");
        expect(href).not.toMatch(/[ &]/);
    });

    it("uses /events as the base path and allows another one", () => {
        expect(buildCatalogHref({ city: "Bogor" }, {}, "/")).toBe(
            "/?city=Bogor"
        );
    });
});

describe("D3. isActiveParam", () => {
    it("reports presence and exact matches", () => {
        expect(isActiveParam({}, "sport")).toBe(true);
        expect(isActiveParam({ sport: "basket" }, "sport")).toBe(false);
        expect(isActiveParam({ sport: "basket" }, "sport", "basket")).toBe(true);
        expect(isActiveParam({ sport: "basket" }, "sport", "running")).toBe(false);
    });
});

describe("D4. the UI sort list cannot invent a sort the server rejects", () => {
    it("matches the server's allow-list exactly", () => {
        expect(CATALOG_SORT_OPTIONS.map((option) => option.value).sort()).toEqual(
            [...CATALOG_SORT_VALUES].sort()
        );
    });

    it("defaults to a value the server accepts", () => {
        expect(CATALOG_SORT_VALUES).toContain(DEFAULT_CATALOG_SORT);
    });

    it("accepts every UI-built href's query string through the server schema", () => {
        const href = buildCatalogHref(
            {
                q: "basket",
                sport: "basket",
                city: "Bandung",
                dateFrom: "2026-10-01",
                priceMax: "0",
                sort: DEFAULT_CATALOG_SORT,
                page: "2",
            },
            { hasTickets: "true" }
        );

        const search = new URLSearchParams(href.split("?")[1]);
        const parsed = catalogQuerySchema.safeParse(
            Object.fromEntries(search.entries())
        );

        expect(parsed.success).toBe(true);
    });
});
