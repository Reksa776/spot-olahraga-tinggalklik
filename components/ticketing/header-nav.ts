import { cn } from "@/lib/utils";

/**
 * ==========================================
 * THE PUBLIC HEADER'S NAV ITEM — ONE GEOMETRY
 * ==========================================
 *
 * Every clickable item in the landing header ("Dashboard", "Pesanan saya", "Tiket saya",
 * "Keluar", "Masuk", "Buat event") is built from ONE geometry. Before this module each item
 * carried its own hand-written class string: some were `rounded-lg px-3 py-2`, others
 * `rounded-xl px-4 py-2`, some `block`, some `flex`, none had a fixed height and none set
 * `whitespace-nowrap` — so "Pesanan saya" wrapped onto two lines at narrow widths, the rows
 * had three different heights, and the row read as a pile of unrelated buttons rather than as
 * one system.
 *
 * ── WHAT THE GEOMETRY FIXES ─────────────────────────────────────────────────────
 *   `h-10 items-center justify-center` — one height, centred content, so an item with an icon
 *   (Keluar) and an item with none sit on the same baseline.
 *   `whitespace-nowrap` — a two-word label can never wrap and change the row's height.
 *   `rounded-xl px-4 text-sm font-semibold leading-none` — one radius, one horizontal padding,
 *   one type scale.
 *
 * ── WHY THERE IS DELIBERATELY NO `display` UTILITY HERE ─────────────────────────
 * The box sets no `display`; each call site does, because the two responsibilities are
 * different and conflating them broke the responsive gates. Tailwind emits `.hidden` BEFORE
 * `.inline-flex`, so an element carrying both resolves to `display:inline-flex` at EVERY width
 * — the `hidden` is dead. Any item that must be hidden below a breakpoint (`hidden
 * xl:inline-flex`) therefore cannot also inherit an unconditional `inline-flex`. Call sites
 * pass exactly one display utility; the box only describes the box.
 *
 * ── WHY IT LIVES IN ITS OWN MODULE ──────────────────────────────────────────────
 * `SiteHeader` is a SERVER component (it calls `auth()`), and the sign-out control is a CLIENT
 * component (it calls `next-auth/react`). The two must render the identical item, but a client
 * component cannot import from the server file. This module has no server imports — it is
 * `cn` and strings — so both sides can share the ONE definition without dragging either
 * runtime into the other.
 *
 * VARIANTS, NOT DIFFERENT ITEMS
 * -----------------------------
 * `quiet` (navigation), `outline` (a secondary control: "Tiket saya", "Keluar", "Masuk") and
 * `primary` ("Buat event") differ in colour, border and fill — the semantic hierarchy the
 * brief asks to keep. They differ in NOTHING else: geometry, height, padding, radius, type and
 * alignment are shared, so no variant can look like a different-sized component.
 */

/** The shared box every header item is drawn in. Carries NO display utility — see above. */
export const HEADER_NAV_ITEM =
    "h-10 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl px-4 text-sm font-semibold leading-none transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-900";

/** The semantic colour treatments, all over the SAME geometry above. */
export const HEADER_NAV_VARIANT = {
    /** Plain navigation — no border, no fill. */
    quiet: cn(HEADER_NAV_ITEM, "text-ink-600 hover:bg-ink-50 hover:text-ink-900"),
    /** A secondary control — bordered. */
    outline: cn(
        HEADER_NAV_ITEM,
        "border border-ink-200 text-ink-800 hover:border-ink-900 hover:bg-ink-50"
    ),
    /** The ONE primary action in the row. */
    primary: cn(HEADER_NAV_ITEM, "bg-ink-900 text-white hover:bg-ink-800"),
} as const;

/**
 * ==========================================
 * THE DISABLED OVERRIDE — ONE TREATMENT, LAYERED ONTO A VARIANT
 * ==========================================
 *
 * Disabled is a STATE, not a fourth colour role, so it is not a key in `HEADER_NAV_VARIANT`: the
 * item keeps the variant it always had (`primary`) and this is merged on top of it. That keeps
 * `HeaderNavVariant` meaning "the semantic roles an item can be assigned" and keeps the disabled
 * control unmistakably the SAME control as before, merely switched off.
 *
 * `cursor-not-allowed` tells a pointer user WHY the click does nothing, and `opacity-40` dims the
 * item without changing a single colour token, so it still reads as the primary CTA.
 *
 * `hover:bg-ink-900` is not decoration. The element carries `primary` too, and `cn` is
 * `tailwind-merge`: this restates the BASE colour for the hover state and therefore DROPS
 * `primary`'s `hover:bg-ink-800`. Without it the item would still brighten under the pointer —
 * the one cue that says "clickable" — on an item that is not. Styling only: nothing here needs
 * hydration, so the control looks the same before and after it.
 */
export const HEADER_NAV_DISABLED =
    "cursor-not-allowed opacity-40 hover:bg-ink-900";

export type HeaderNavVariant = keyof typeof HEADER_NAV_VARIANT;
