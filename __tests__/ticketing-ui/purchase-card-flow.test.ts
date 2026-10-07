/**
 * ==========================================
 * PHASE B — THE PURCHASE CARD IS NOT A VIEWPORT-FOLLOWING ELEMENT
 * ==========================================
 *
 * K/L/M of the landing-visibility phase. The detail page's "Pilih tiket" card used to be
 * `lg:sticky lg:top-24`, and a `fixed inset-x-0 bottom-0` `StickyBuyBar` was rendered below `lg`
 * — two purchase affordances that tracked the viewport and could sit on top of other cards.
 *
 * A "does not follow the page" behaviour cannot be proven by unit-testing a component, so these
 * assertions do the thing this repository already does for layout invariants it can read
 * (`realtime/indicator.test.ts` reads a component's positioning classes the same way): they read
 * the source with comments REMOVED — prose is allowed to name the class it is describing, code is
 * not allowed to use it — and pin the absence of every mechanism the phase forbids, plus the
 * presence of the in-flow structure that replaces them.
 *
 * The overlap itself (that the card physically crosses no other card while scrolling) is a
 * rendered-geometry question and is checked in a real browser, not here. What is enforced here is
 * the CAUSE: no `position: sticky`, no `position: fixed`, and no scroll-driven JS.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");

const DETAIL_PAGE = "app/e/[slug]/page.tsx";
const PURCHASE_FORM = "components/events/TicketPurchaseForm.tsx";

/** Source with block and line comments removed, so prose about a class is not a use of it. */
function readCode(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** The `className` of the element carrying `id="beli"`, read out of its own JSX element. */
function purchaseCardClasses(code: string): string {
    const anchor = code.indexOf('id="beli"');

    expect(anchor).toBeGreaterThan(-1);

    const element = code.slice(anchor, code.indexOf(">", anchor));
    const match = element.match(/className="([^"]*)"/);

    expect(match).not.toBeNull();

    return match![1];
}

describe("K. the purchase card uses no sticky/fixed mechanism", () => {
    const code = readCode(DETAIL_PAGE);

    it("contains no `sticky` utility anywhere", () => {
        expect(code).not.toMatch(/sticky/);
    });

    it("contains no `fixed` utility anywhere", () => {
        expect(code).not.toMatch(/\bfixed\b/);
    });

    it("no longer renders the fixed bottom purchase bar", () => {
        expect(code).not.toContain("StickyBuyBar");
    });

    it("#beli is a plain bordered card with no positioning classes", () => {
        const classes = purchaseCardClasses(code);

        for (const forbidden of [
            "sticky",
            "fixed",
            "absolute",
            "top-0",
            "bottom-",
            "inset-",
            "z-",
        ]) {
            expect(classes).not.toContain(forbidden);
        }
    });

    it("keeps `scroll-mt-24` so an anchor jump still clears the site header", () => {
        // The one `top-`-adjacent utility that IS wanted: `scroll-margin-top` moves where the
        // anchor lands; it does not pin anything to the viewport.
        expect(purchaseCardClasses(code)).toContain("scroll-mt-24");
    });

    it("has no scroll listener or JS-driven reveal for the card", () => {
        for (const mechanism of [
            "addEventListener(\"scroll\"",
            "onscroll",
            "requestAnimationFrame",
            "getBoundingClientRect",
        ]) {
            expect(code).not.toContain(mechanism);
        }
    });

    it("dropped the `pb-24` that existed only to clear the fixed bar", () => {
        // The page reserved bottom space for an overlay it no longer renders; keeping it would
        // be dead layout that only hides the next real overlap.
        expect(code).not.toContain("pb-24");
    });
});

describe("L/M. the card stays in the document flow at every breakpoint", () => {
    const code = readCode(DETAIL_PAGE);

    it("is still the sidebar's own content — the right-hand column at `lg`+ is preserved", () => {
        // Requirement §7: desktop keeps the card in the column it was in; it is simply no longer
        // pinned. The grid and the aside are what place it there.
        expect(code).toContain("lg:grid-cols-3");
        expect(code).toContain("<aside");
        expect(code).toContain('id="beli"');
    });

    it("is a sibling of the share card, in one normal-flow column", () => {
        // Both cards live in the same `aside` with only vertical spacing between them, so the
        // column stacks and scrolls as one block on every viewport.
        const asideAt = code.indexOf("<aside");
        const shareAt = code.indexOf("Bagikan event");

        expect(asideAt).toBeGreaterThan(-1);
        expect(shareAt).toBeGreaterThan(asideAt);

        // Nothing in the sidebar is positioned.
        const sidebar = code.slice(asideAt, code.indexOf("</aside>", asideAt));

        expect(sidebar).not.toMatch(/sticky|fixed|absolute/);
    });

    it("has no responsive positioning variant that would reintroduce it at a breakpoint", () => {
        // The old bug was `lg:sticky` — a class that only engages from `lg`. Any `*:sticky` or
        // `*:fixed` form is therefore just as forbidden as the bare utility.
        expect(code).not.toMatch(/[a-z-]+:sticky|[a-z-]+:fixed/);
    });

    it("the purchase form itself adds no positioning of its own", () => {
        const form = readCode(PURCHASE_FORM);

        expect(form).not.toMatch(/[a-z-]*:?sticky|[a-z-]*:?fixed|\babsolute\b/);
    });
});

describe("the ended-event wiring the card's disabled state depends on", () => {
    const page = readCode(DETAIL_PAGE);

    it("reads the catalog's own `hasEnded` verdict rather than re-deriving a date", () => {
        expect(page).toContain("event.hasEnded");
    });

    it("combines it with D-14 availability before handing it to the form", () => {
        expect(page).toContain(
            "const purchasable = event.isAvailable && !event.hasEnded;"
        );
        expect(page).toContain("isAvailable={purchasable}");
    });

    it("labels a passed event 'Ditutup' in the hero badge", () => {
        expect(page).toMatch(/event\.hasEnded\s*\?\s*"Ditutup"/);
    });

    it("the server gate uses the same predicate, so display and enforcement cannot drift", () => {
        const checkout = readCode("lib/ticketing/checkout.ts");

        expect(checkout).toContain("isEventEnded(event, now)");
        expect(checkout).toContain('reason: "EVENT_ENDED"');
    });
});
