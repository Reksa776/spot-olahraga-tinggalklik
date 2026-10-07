/**
 * ==========================================
 * CHECKOUT DRAFT — PRESERVE THE FORM ACROSS LOGIN
 * ==========================================
 *
 * A guest who fills in the purchase card on `/e/{slug}` and presses "Pesan tiket" is refused by
 * the proxy with a `401` (the checkout route is session-protected), and
 * `lib/auth/client-session.ts` sends them to `/login?callbackUrl=%2Fe%2F{slug}`. The return path
 * already worked — this module exists for the part that did not: the form itself lived in React
 * state, the navigation to `/login` is a full document load, and every field the buyer had typed
 * was destroyed on the way. They signed in and came back to an empty form, which is exactly the
 * "ketik ulang" the flow is supposed to remove.
 *
 * ── WHY `sessionStorage`, AND WHY NOTHING ELSE ──────────────────────────────────
 * The draft is TRANSIENT, TAB-SCOPED, CLIENT-ONLY state. Each of those is a requirement, not a
 * convenience:
 *
 *   • TRANSIENT — a draft that outlives the interruption would resurrect a stale selection and
 *     quantity days later, so every entry carries `savedAt` and reading expires it
 *     (`CHECKOUT_DRAFT_TTL_MS`).
 *   • TAB-SCOPED — the interruption is a trip to `/login` and back in the SAME tab, so
 *     `sessionStorage` covers it and nothing about a purchase on this machine leaks to a second
 *     tab, a second tab's user, or a later browser session. `localStorage` would be shared by
 *     every tab and would survive a closed browser; a cookie would be sent to the server on every
 *     request, which is not needed for a restore that only the form reads, and would make the
 *     draft part of the request surface.
 *   • CLIENT-ONLY — the point of the feature is to restore what the BUYER typed locally. Nothing
 *     here is an input to pricing, inventory, ownership or payment, and none of it is ever sent to
 *     the server (see SECURITY below).
 *
 * There is no existing cart/draft/session mechanism in this project to reuse: the ticketing
 * checkout is a single-page form whose only durable state is the order the server creates, and that
 * creation is what this flow is trying to delay until the buyer signs in.
 *
 * ── BOUND TO ONE EVENT, AND ONLY ONE DRAFT ─────────────────────────────────────
 * The record names the `eventId` it belongs to, and `readCheckoutDraft`/`consumeCheckoutDraft`
 * REFUSE a record whose `eventId` is not the one being opened. That is the whole of the
 * cross-event guarantee: a buyer who fills in Event A, is bounced to login, opens Event B in
 * another tab or returns to a different slug, gets an EMPTY form — Event A's name, email, phone
 * and quantities cannot be applied to Event B, because the reader compares before it returns
 * anything.
 *
 * There is deliberately ONE storage key, not one per event. A purchase intent is singular: the
 * buyer is not "holding" drafts for several events. A new save overwrites the previous one, which
 * keeps a single tab from accumulating an ever-growing trail of abandoned personal data.
 *
 * ── SECURITY ───────────────────────────────────────────────────────────────────
 *   • WHAT IS STORED is the buyer's own contact fields, the tier/quantity selection, the PIC share
 *     token (as a `null`-or-string record of the intent) and a timestamp. Never a password, never
 *     a session/auth token, never a payment credential, and never a server-owned figure —
 *     **no price, no subtotal, no total, no availability, no quota**.
 *   • WHAT IS TRUSTED is nothing. The record is read back through `normalize…` helpers that
 *     rebuild it from primitives, drop anything unexpected and cap every string, so a tampered
 *     entry cannot inject extra keys or an unbounded payload into the module's consumers.
 *   • WHAT IT CANNOT DO is change what the buyer is charged. The checkout still recomputes every
 *     amount from `TicketType.price` in the database, still re-validates availability and quota,
 *     still derives the buyer from the session and still runs the existing payment/inventory
 *     checks (`lib/ticketing/checkout.ts`). A restored draft is a form prefill and nothing more:
 *     the request the form sends carries the same five fields it always did, and a quantity that
 *     no longer fits a tier's `maxPerOrder` is clamped by `restoreDraftQuantities` before it is
 *     even offered to the buyer.
 *
 * ── FAILURES ARE SILENT, BY DESIGN ─────────────────────────────────────────────
 * `sessionStorage` throws on ACCESS in some privacy modes (it is not merely absent), an entry can
 * be corrupted, and a JSON payload can be anything. Every read is wrapped, every parse validates,
 * and every failure resolves to `null` — i.e. "no draft", which renders the normal empty/default
 * form. Restoring a form is a convenience; it must never be able to break the page.
 */

// Type-only, and deliberately the PURE source of the union (`lib/events/sales-state.ts` imports
// nothing), so this client-safe module never pulls Prisma or the catalog into the browser bundle.
import type { SalesState } from "@/lib/events/sales-state";

/**
 * The single storage key. The `.v1` suffix means a future shape change can simply use a new key
 * rather than having to migrate or defensively re-parse the old one in place.
 */
export const CHECKOUT_DRAFT_STORAGE_KEY = "tinggalklik.checkout-draft.v1";

/**
 * How long a draft stays usable. Long enough to cover a sign-in (including creating an account,
 * a failed attempt and a retry), short enough that a selection abandoned half an hour ago is not
 * resurrected as if it were the buyer's current intent.
 */
export const CHECKOUT_DRAFT_TTL_MS = 30 * 60 * 1000;

/** Defensive ceilings, so a tampered entry cannot carry an unbounded payload. */
export const CHECKOUT_DRAFT_MAX_ITEMS = 50;
export const CHECKOUT_DRAFT_MAX_ID_LENGTH = 128;
export const CHECKOUT_DRAFT_MAX_TEXT_LENGTH = 200;
export const CHECKOUT_DRAFT_MAX_TOKEN_LENGTH = 200;

/**
 * Tolerance for a `savedAt` that is slightly in the future (browser clock skew). A record that
 * claims to have been saved in the future is not evidence of anything, and it must not be able to
 * read as permanently fresh — but a few seconds of skew is normal and is allowed.
 */
const CLOCK_SKEW_MS = 60 * 1000;

/** One line of the buyer's tier selection. */
export type CheckoutDraftItem = {
    ticketTypeId: string;
    quantity: number;
};

/**
 * The preserved purchase form, as stored. Everything the form needs to put itself back, and
 * nothing the server would ever be asked to trust.
 */
export type CheckoutDraft = {
    /** The event this draft belongs to. A reader refuses a record for any other event. */
    eventId: string;
    items: CheckoutDraftItem[];
    buyerName: string;
    buyerEmail: string;
    buyerPhone: string;
    /**
     * The PIC token from the shared `?pic=` link, recorded so the draft describes the purchase
     * intent it was saved from. It is NOT applied on restore: the URL is the authority for which
     * link the buyer arrived through, and the server — never this record — decides whether the
     * token names a real, active PIC (`lib/pic/attribution.ts`).
     */
    shareToken: string | null;
    /** `Date.now()` at save time. The only thing that makes a draft expire. */
    savedAt: number;
};

/** What the caller supplies on save; `savedAt` is added here. */
export type CheckoutDraftInput = Omit<CheckoutDraft, "savedAt">;

/** The parts of a public ticket type the restore needs to re-validate a selection. */
export type RestorableTicketType = {
    id: string;
    minPerOrder: number;
    maxPerOrder: number | null;
    salesState: SalesState;
    isSoldOut: boolean;
};

/* ==================================================================================
 * STORAGE ACCESS — never throws
 * ================================================================================== */

function storage(): Storage | null {
    try {
        if (typeof window === "undefined") {
            return null;
        }

        // Accessing the property itself can throw (a privacy mode that blocks storage), which is
        // why this is inside the `try` and not merely a `typeof` check.
        return window.sessionStorage ?? null;
    } catch {
        return null;
    }
}

function removeDraft(): void {
    try {
        storage()?.removeItem(CHECKOUT_DRAFT_STORAGE_KEY);
    } catch {
        // A storage that refuses a removal is a storage whose read will fail too.
    }
}

/* ==================================================================================
 * NORMALISATION — rebuild from primitives, never trust the shape
 * ================================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeText(value: unknown, maxLength: number): string {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeItems(value: unknown): CheckoutDraftItem[] {
    if (!Array.isArray(value)) {
        return [];
    }

    const items: CheckoutDraftItem[] = [];

    for (const raw of value.slice(0, CHECKOUT_DRAFT_MAX_ITEMS)) {
        if (!isRecord(raw)) {
            continue;
        }

        const id = raw.ticketTypeId;
        const quantity = raw.quantity;

        if (
            typeof id !== "string" ||
            id.length === 0 ||
            id.length > CHECKOUT_DRAFT_MAX_ID_LENGTH
        ) {
            continue;
        }

        // A quantity that is not a finite number is not a quantity. Truncation is deliberate: the
        // form only ever offers whole tickets.
        if (typeof quantity !== "number" || !Number.isFinite(quantity)) {
            continue;
        }

        const whole = Math.trunc(quantity);

        if (whole <= 0) {
            continue;
        }

        items.push({ ticketTypeId: id, quantity: whole });
    }

    return items;
}

/**
 * Turn an untrusted value into a usable draft, or `null`.
 *
 * `null` is the answer for every failure — a malformed body, an item list with nothing usable in
 * it, an entry for a different event, and an entry past its TTL all mean the same thing to the
 * caller: render the normal form.
 */
function normalizeDraft(
    value: unknown,
    now: number
): CheckoutDraft | null {
    if (!isRecord(value)) {
        return null;
    }

    const eventId = normalizeText(value.eventId, CHECKOUT_DRAFT_MAX_ID_LENGTH);

    if (eventId.length === 0) {
        return null;
    }

    const items = normalizeItems(value.items);

    // A draft with no restorable selection carries nothing the form cannot derive itself.
    if (items.length === 0) {
        return null;
    }

    const savedAt = value.savedAt;

    if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) {
        return null;
    }

    if (savedAt > now + CLOCK_SKEW_MS || now - savedAt > CHECKOUT_DRAFT_TTL_MS) {
        return null;
    }

    const shareToken = value.shareToken;

    return {
        eventId,
        items,
        buyerName: normalizeText(value.buyerName, CHECKOUT_DRAFT_MAX_TEXT_LENGTH),
        buyerEmail: normalizeText(value.buyerEmail, CHECKOUT_DRAFT_MAX_TEXT_LENGTH),
        buyerPhone: normalizeText(value.buyerPhone, CHECKOUT_DRAFT_MAX_TEXT_LENGTH),
        shareToken:
            typeof shareToken === "string" && shareToken.length > 0
                ? shareToken.slice(0, CHECKOUT_DRAFT_MAX_TOKEN_LENGTH)
                : null,
        savedAt,
    };
}

/* ==================================================================================
 * SAVE
 * ================================================================================== */

/**
 * Persist a purchase form so the buyer does not have to type it again after signing in.
 *
 * Called on the ONE path that interrupts a purchase: the `401` that means "you must sign in".
 * Returns the stored record, or `null` when there is no usable storage — the caller does not need
 * to care, because the redirect happens either way and a missing draft only costs the buyer the
 * prefill.
 */
export function saveCheckoutDraft(
    input: CheckoutDraftInput,
    now: number = Date.now()
): CheckoutDraft | null {
    const target = storage();

    if (!target) {
        return null;
    }

    const draft = normalizeDraft({ ...input, savedAt: now }, now);

    // The input has just been through the same normalisation the reader applies, so anything
    // rejected here (no items, no event id) would be rejected on the way back out as well.
    if (!draft) {
        return null;
    }

    try {
        target.setItem(CHECKOUT_DRAFT_STORAGE_KEY, JSON.stringify(draft));

        return draft;
    } catch {
        // A full or refusing store is not worth an error the buyer cannot act on.
        return null;
    }
}

/* ==================================================================================
 * READ / CONSUME
 * ================================================================================== */

function readRaw(): unknown {
    const target = storage();

    if (!target) {
        return null;
    }

    let serialized: string | null;

    try {
        serialized = target.getItem(CHECKOUT_DRAFT_STORAGE_KEY);
    } catch {
        return null;
    }

    if (serialized === null) {
        return null;
    }

    try {
        return JSON.parse(serialized);
    } catch {
        return null;
    }
}

/**
 * Read the preserved form FOR ONE EVENT, without consuming it.
 *
 * Returns `null` when there is no draft, when it is malformed or expired, or when it belongs to a
 * different event. Exposure for tests and diagnostics; the restore path uses
 * `consumeCheckoutDraft`.
 */
export function readCheckoutDraft(
    eventId: string,
    now: number = Date.now()
): CheckoutDraft | null {
    const draft = normalizeDraft(readRaw(), now);

    if (!draft || draft.eventId !== eventId) {
        return null;
    }

    return draft;
}

/**
 * Read the preserved form for one event AND remove it, so it is restored exactly once.
 *
 * The entry is removed only when it is OURS (`eventId` matches). A record for another event is
 * left untouched: this tab may still be in the middle of that other purchase, and consuming it
 * because a different page was opened would silently destroy a draft the buyer is about to need.
 * It is removed even when the rest of the record turns out to be unusable — an expired or
 * malformed entry for THIS event has no future, and leaving it behind is how a stale entry
 * survives to be read again.
 *
 * This is what makes a browser refresh after the restore harmless (there is nothing left to
 * re-apply, so the form keeps whatever the buyer has since typed) and what stops the same draft
 * from being applied twice (a refresh, a back navigation, or an accidental remount).
 */
export function consumeCheckoutDraft(
    eventId: string,
    now: number = Date.now()
): CheckoutDraft | null {
    const raw = readRaw();

    if (raw === null) {
        return null;
    }

    const parsed = isRecord(raw)
        ? normalizeText(raw.eventId, CHECKOUT_DRAFT_MAX_ID_LENGTH)
        : "";

    if (parsed !== eventId) {
        // Not our draft — another event's in-flight selection. Leave it exactly as it is.
        return null;
    }

    removeDraft();

    return normalizeDraft(raw, now);
}

/** Drop the preserved form. Exposed for tests and for any future "abandon purchase" affordance. */
export function clearCheckoutDraft(): void {
    removeDraft();
}

/* ==================================================================================
 * RESTORE — re-validate against the catalog the page actually rendered
 * ================================================================================== */

/**
 * Rebuild the quantity selection from a draft, USING THE CURRENT CATALOG as the authority.
 *
 * The draft is a record of what the buyer typed, not of what is still on sale. Between the save
 * and the restore the buyer signed in, which is at least one full page load and possibly minutes,
 * so a tier can have sold out, closed, or been removed from the event. This function therefore:
 *
 *   • drops a tier the event no longer offers (an unknown id cannot be bought — and it must never
 *     be replayed to a server that would have to refuse it);
 *   • drops a tier that is no longer on sale (`OPEN` and not sold out);
 *   • clamps the quantity into the tier's CURRENT per-order maximum, so a selection that was legal
 *     when it was saved cannot be submitted as one that is not.
 *
 * A minimum is deliberately NOT enforced upwards. Raising a saved `1` to a tier's `minPerOrder: 2`
 * would be silently changing what the buyer chose and charging them for it; the form's own submit
 * check says so instead, and the buyer decides.
 *
 * The result is a plain `Record<ticketTypeId, quantity>` — the same shape the form keeps in state —
 * with entries omitted rather than set to zero, so an empty result means "nothing to restore".
 */
export function restoreDraftQuantities(
    items: readonly CheckoutDraftItem[],
    ticketTypes: readonly RestorableTicketType[],
    fallbackMaxPerSelection: number
): Record<string, number> {
    const byId = new Map(ticketTypes.map((type) => [type.id, type]));
    const quantities: Record<string, number> = {};

    for (const item of items) {
        const type = byId.get(item.ticketTypeId);

        if (!type || type.salesState !== "OPEN" || type.isSoldOut) {
            continue;
        }

        const max = type.maxPerOrder ?? fallbackMaxPerSelection;
        const quantity = Math.min(Math.trunc(item.quantity), max);

        if (quantity > 0) {
            quantities[item.ticketTypeId] = quantity;
        }
    }

    return quantities;
}
