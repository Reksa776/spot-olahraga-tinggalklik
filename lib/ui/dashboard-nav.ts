/**
 * ==========================================
 * DASHBOARD NAVIGATION — ACTIVE STATE
 * ==========================================
 *
 * Pure functions, deliberately separate from the component that uses them.
 *
 * The reason is the Broadcast group: eight of its entries point at the same path and differ only by
 * `?type=…`. Comparing the path alone would light up all eight at once, so an entry that carries a
 * query is only "active" when that query is present and equal in the current URL — and an entry
 * without a query stays active on any query, which is what makes "Orderan" keep its highlight while
 * the user is paging through `?page=2`.
 *
 * Kept out of `DashboardNav.tsx` because it is the one piece of navigation behaviour worth testing
 * on its own: it is what stops an operator from being told they are on a page they are not on.
 */

/** `/admin/broadcasts?type=X` → `/admin/broadcasts`. */
export function navPathOf(href: string): string {
    const index = href.indexOf("?");
    return index === -1 ? href : href.slice(0, index);
}

/** The query a navigation entry requires of the current URL, if any. */
export function navQueryOf(href: string): URLSearchParams {
    const index = href.indexOf("?");
    return new URLSearchParams(index === -1 ? "" : href.slice(index + 1));
}

/**
 * Whether `href` names the location the user is currently on.
 *
 * `search` accepts either a `URLSearchParams` or the raw query string, because callers hold one or
 * the other; both are normalised here rather than at the call site.
 *
 * Prefix matching is intentional and one-directional: `/admin/products/123` activates
 * `/admin/products`, but `/admin/productivity` does not — the `/` boundary is required.
 */
export function isNavItemActive(
    href: string,
    pathname: string,
    search: string | URLSearchParams = ""
): boolean {
    const path = navPathOf(href);

    const isSamePath = pathname === path || pathname.startsWith(`${path}/`);
    if (!isSamePath) return false;

    const expected = navQueryOf(href);
    if ([...expected.keys()].length === 0) return true;

    const actual =
        typeof search === "string" ? new URLSearchParams(search) : search;

    return [...expected.entries()].every(([key, value]) => actual.get(key) === value);
}

/** True when any entry inside a group is active — used to auto-open the group. */
export function isNavGroupActive(
    hrefs: readonly string[],
    pathname: string,
    search: string | URLSearchParams = ""
): boolean {
    const winner = pickActiveNavHref(hrefs, pathname, search);
    return winner !== null;
}

/**
 * The single entry that should be highlighted at this location, or `null`.
 *
 * Prefix matching alone would highlight *two* rows at once — `/admin` and `/admin/products` are
 * both "prefixes" of `/admin/products/123` — and a sidebar that claims you are in two places is
 * worse than one that claims you are in none. So among every matching entry the most specific path
 * wins, and within one path the entry that constrains the query wins over the one that does not.
 *
 * `DashboardNav` highlights exactly the href this returns; everything else is inactive.
 */
export function pickActiveNavHref(
    hrefs: readonly string[],
    pathname: string,
    search: string | URLSearchParams = ""
): string | null {
    const matches = hrefs.filter((href) => isNavItemActive(href, pathname, search));

    if (matches.length === 0) return null;

    return matches.reduce((best, candidate) => {
        const bestPath = navPathOf(best).length;
        const candidatePath = navPathOf(candidate).length;

        if (candidatePath !== bestPath) {
            return candidatePath > bestPath ? candidate : best;
        }

        const bestQuery = [...navQueryOf(best).keys()].length;
        const candidateQuery = [...navQueryOf(candidate).keys()].length;

        return candidateQuery > bestQuery ? candidate : best;
    });
}
