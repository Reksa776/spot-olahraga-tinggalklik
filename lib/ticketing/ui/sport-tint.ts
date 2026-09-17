/**
 * ==========================================
 * PHASE 9 — SPORT TINTS (pure)
 * ==========================================
 *
 * Sports are a first-class navigation concept in this phase, so each one needs a recognisable
 * tint. This is derived from the sport's own slug by hashing it into a fixed palette — no per-sport
 * configuration table to keep in sync with the database, and no invented taxonomy.
 *
 * Deliberately NOT a "category colour" business rule: the tint carries no meaning, it only makes a
 * grid of 14 chips scannable. Every class name is a full literal so Tailwind's scanner sees them.
 */

const TINTS = [
    "bg-brand-50 text-brand-800 ring-brand-200",
    "bg-sky-50 text-sky-800 ring-sky-200",
    "bg-emerald-50 text-emerald-800 ring-emerald-200",
    "bg-violet-50 text-violet-800 ring-violet-200",
    "bg-amber-50 text-amber-800 ring-amber-200",
    "bg-rose-50 text-rose-800 ring-rose-200",
    "bg-cyan-50 text-cyan-800 ring-cyan-200",
    "bg-indigo-50 text-indigo-800 ring-indigo-200",
] as const;

/** Solid variant, for the small chip on a dark hero image. */
const SOLID_TINTS = [
    "bg-brand-600 text-white",
    "bg-sky-600 text-white",
    "bg-emerald-600 text-white",
    "bg-violet-600 text-white",
    "bg-amber-600 text-white",
    "bg-rose-600 text-white",
    "bg-cyan-700 text-white",
    "bg-indigo-600 text-white",
] as const;

function hash(value: string): number {
    let acc = 0;

    for (let index = 0; index < value.length; index += 1) {
        acc = (acc * 31 + value.charCodeAt(index)) % 100000;
    }

    return acc;
}

export function sportTint(slug: string): string {
    return TINTS[hash(slug) % TINTS.length];
}

export function sportSolidTint(slug: string): string {
    return SOLID_TINTS[hash(slug) % SOLID_TINTS.length];
}

/** `Basket`-style chip label: the sport's own name, never a renamed or invented category. */
export function sportLabel(name: string): string {
    return name.length > 0 && name.length <= 3 ? name.toUpperCase() : name;
}
