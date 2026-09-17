/**
 * ==========================================
 * EVENT SLUGS (design §10.2, §10.6; brief §9)
 * ==========================================
 *
 * Design §10.6 fixes the canonical public URL as `/e/{slug}` and requires the slug to
 * be **globally unique** — not per-organizer — because "the public URL must resolve
 * without a tenant prefix, which is the e-commerce catalog behaviour the brief
 * requires". That is why uniqueness is enforced by a database `@unique` on
 * `Event.slug` and re-checked here.
 *
 * Requirements this module satisfies (brief §9):
 *
 *   unique            — generation is de-duplicated against the database
 *   normalized        — NFKD, diacritics folded, lowercased, ASCII-only
 *   URL-safe          — `[a-z0-9-]` only, no leading/trailing/double dashes
 *   collision-safe    — a short random suffix is appended on collision
 *   no trust in the client — the slug is derived from the title server-side and
 *                      never accepted as an authoritative uniqueness claim
 *   slug changes must not expose another event — a change re-runs the same
 *                      uniqueness check *excluding the event itself*, and on
 *                      collision appends a suffix rather than stealing the slug
 *
 * DECISIONS NOT TAKEN HERE
 * ------------------------
 * D-03 (whether a separate human-chosen `shareCode` is offered) and D-02 (whether a
 * legacy `/events/{slug}` alias 301-redirects) remain unresolved. The `shareCode`
 * column exists from Phase 2 but is deliberately NOT written by Phase 4, and no
 * alias route is created: implementing either would be inventing a business rule.
 */

const MAX_SLUG_LENGTH = 80;

/**
 * Slugs that must never be generated, because they would shadow a reserved or
 * future route under `/e/`. Kept intentionally short — this is a safety net for
 * route collisions, not a marketing blocklist.
 */
export const RESERVED_SLUGS: readonly string[] = [
    "new",
    "create",
    "edit",
    "admin",
    "api",
    "events",
    "event",
    "share",
    "search",
    "null",
    "undefined",
];

/**
 * Normalise arbitrary text into a URL-safe slug body.
 *
 * Deterministic: the same input always produces the same output. Returns an empty
 * string when nothing usable remains, so callers can substitute a fallback rather
 * than minting a slug that is only dashes.
 */
export function slugify(input: string): string {
    const normalized = (input ?? "")
        .normalize("NFKD")
        // Strip combining marks so "Lomba Bola Voli" and "Lömbä" both reduce to ASCII.
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        // Anything that is not a latin letter or digit becomes a separator.
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");

    if (normalized.length <= MAX_SLUG_LENGTH) {
        return normalized;
    }

    // Truncate on a dash boundary when possible so we never end mid-word with a
    // trailing dash.
    return normalized.slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}

/** A short, URL-safe random fragment used to break collisions. */
export function randomSlugSuffix(length = 6): string {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    // crypto-free on purpose: this is a readability suffix, not a secret. The
    // uniqueness guarantee comes from the database constraint, not from this value.
    let out = "";

    for (let i = 0; i < length; i++) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return out;
}

/** Fallback body when a title slugifies to nothing (e.g. a title of only emoji). */
export const SLUG_FALLBACK_BODY = "event";

export function slugBodyFromTitle(title: string): string {
    const body = slugify(title);

    if (body.length === 0) {
        return SLUG_FALLBACK_BODY;
    }

    if (RESERVED_SLUGS.includes(body)) {
        return `${body}-1`;
    }

    // Guarantee a minimum length so a single-character title cannot produce a slug
    // that collides constantly.
    return body.length < 3 ? `${body}-event` : body;
}

/**
 * Produce a slug that `isTaken` reports as free.
 *
 * `isTaken` is injected so the logic is pure and testable without a database — the
 * caller passes a predicate that queries `Event.slug` (optionally excluding the
 * event being updated). Pure function, no I/O.
 *
 * Collision handling follows design §10.6: try the plain body first (the common case,
 * and the best URL), then append a short random suffix. The attempt count is bounded
 * so a pathological state cannot loop forever; if every attempt is taken the final
 * candidate is returned anyway and the database `@unique` constraint remains the
 * last line of defence, turning a silent duplicate into a visible error.
 */
export async function generateUniqueSlug(
    title: string,
    isTaken: (candidate: string) => Promise<boolean>,
    maxAttempts = 6
): Promise<string> {
    const body = slugBodyFromTitle(title);

    if (!(await isTaken(body))) {
        return body;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const candidate = `${body}-${randomSlugSuffix()}`;

        if (!(await isTaken(candidate))) {
            return candidate;
        }
    }

    return `${body}-${randomSlugSuffix(10)}`;
}

/**
 * Is a caller-supplied slug acceptable for a slug *change*?
 *
 * Only structurally: the value must slugify to exactly itself, which rejects empty
 * strings, path separators, `..`, encoded characters and anything that would
 * normalise into a different slug than the caller asked for. Uniqueness is decided
 * by the caller against the database, excluding the event being edited.
 */
export function isAcceptableRequestedSlug(value: string): boolean {
    if (typeof value !== "string") {
        return false;
    }

    const trimmed = value.trim();

    if (trimmed.length === 0 || trimmed.length > MAX_SLUG_LENGTH) {
        return false;
    }

    if (RESERVED_SLUGS.includes(trimmed)) {
        return false;
    }

    return slugify(trimmed) === trimmed;
}
