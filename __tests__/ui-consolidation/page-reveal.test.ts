/**
 * ==========================================
 * CUSTOMER PAGE ENTRANCE — MOTION CONTRACT
 * ==========================================
 *
 * The four customer-facing pages (/, /events, /ticketing/tickets, /ticketing/orders) share ONE
 * CSS-only entrance system. This suite pins the properties that make it safe rather than pretty:
 *
 *   1. IT MOVES ONLY `opacity` AND `transform` — never `width`/`height`/`top`/`left`. A
 *      layout-triggering animation is a defect, not a style choice.
 *   2. IT IS NEUTRALISED UNDER `prefers-reduced-motion`, with content forced visible.
 *   3. IT IS CSS + data attributes, so the server and the client render identical markup and no
 *      hydration mismatch can be introduced.
 *   4. THE STAGGER IS CAPPED, so a long list cannot queue an unbounded number of delays.
 *   5. THE CARD COMPONENTS THEMSELVES STAY ANIMATION-FREE — the reveal is applied to the list
 *      item as one unit, never to every nested element inside a card.
 *   6. NO ANIMATION LIBRARY WAS ADDED.
 *   7. THE ENTRANCE RUNS ON THE CLOCK, ONCE — one shared observer starts each element when it
 *      enters the viewport, so the motion is the same 500-650ms for every visitor instead of
 *      tracking the scroll position (where a 40px heading's whole entrance passes inside a
 *      single wheel notch and is never seen). No scroll listener, no rAF loop, no observer per
 *      element, and the CSS on its own still animates where the bundle never runs.
 *   8. NOTHING IS EVER PAUSED, AND NO LIVE ANIMATION'S TIMELINE IS EVER REASSIGNED. Arming used
 *      to hold each element at its first keyframe with `animation-play-state: paused` and detach
 *      its `view()` animation with `animation-timeline: auto`, then start it by switching the
 *      play state back to `running`. In Chrome that resolutions the start time of the resumed
 *      animation from the progress it had on the OLD timeline, which landed it in the FUTURE —
 *      measured at 1.6s for the first element and growing by about a frame per element in
 *      document order, 37s for the last. A heading reached full opacity 4.7s after entering the
 *      viewport, most of a phone's sport grid never appeared, and the footer's last line stayed
 *      at `opacity: 0` for the whole visit: the page below the hero looked static because it
 *      measurably was. The one-shot path now CREATES the entrance when the element is revealed.
 *   9. THE TRIGGER IS A LENGTH, NOT A VIEWPORT PERCENTAGE, so the deepest block on a page can
 *      always be reached whatever the window height.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import Reveal, {
    REVEAL_MAX_DELAY_MS,
    REVEAL_STEP_MS,
    revealDelay,
} from "@/components/ui/Reveal";
import EventRow from "@/components/ticketing/EventRow";
import SectionHeader from "@/components/ticketing/SectionHeader";
import SportGrid, {
    SPORT_TILE_MOBILE_MAX_DELAY_MS,
    SPORT_TILE_MOBILE_STEP_MS,
    sportTileMobileDelay,
    type SportOption,
} from "@/components/ticketing/SportGrid";
import type { PublicEventCard } from "@/lib/events/catalog";

const ROOT = path.resolve(__dirname, "..", "..");

function read(relative: string): string {
    return readFileSync(path.join(ROOT, relative), "utf8");
}

/** Comments removed: prose about motion is not the motion. */
function readCode(relative: string): string {
    return read(relative)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

const CSS = readCode("app/globals.css");

const REVEAL_PAGES = [
    "app/page.tsx",
    "app/events/page.tsx",
    "app/ticketing/tickets/page.tsx",
    "app/ticketing/orders/page.tsx",
];

/* ==================================================================================
 * 1. THE CSS CONTRACT
 * ================================================================================== */

describe("the entrance system animates only compositor-safe properties", () => {
    it("declares exactly two keyframes and lets the distance come from tokens", () => {
        expect(CSS).toContain("@keyframes tk-reveal-up");
        expect(CSS).toContain("@keyframes tk-reveal-scale");
        expect(CSS).toContain("--tk-reveal-shift");

        /*
         * EXACTLY TWO movement definitions, however many rhythm steps exist.
         *
         * The section and quiet steps were added for the landing page by moving tokens only; this
         * assertion is what keeps a future variant from quietly becoming a third, differently
         * shaped animation.
         */
        expect(CSS.match(/@keyframes tk-reveal-/g)).toHaveLength(2);

        /*
         * The BASE distance, read from the token block itself rather than from anywhere in the
         * file. Reading "anywhere" stopped being meaningful once responsive overrides existed: a
         * `toMatch` would be satisfied by the desktop value even if the phone value were absurd.
         */
        const head = CSS.slice(
            CSS.indexOf("--tk-reveal-duration:"),
            CSS.indexOf("@keyframes tk-reveal-up")
        );
        const shifts = [...head.matchAll(/--tk-reveal-shift:\s*(\d+)px/g)].map((match) =>
            Number(match[1])
        );

        expect(shifts.length).toBeGreaterThanOrEqual(2);

        // A small rise — the brief's 8-16px band.
        expect(shifts[0]).toBeGreaterThanOrEqual(10);
        expect(shifts[0]).toBeLessThanOrEqual(16);

        // Every narrower viewport moves LESS, never more: the shift can only shrink.
        for (const override of shifts.slice(1)) {
            expect(override).toBeLessThan(shifts[0]);
        }

        // Duration inside the brief's 400-600ms band.
        expect(CSS).toMatch(/--tk-reveal-duration:\s*(?:4\d\d|5\d\d)ms/);
    });

    it("steps every rhythm distance DOWN on a narrower viewport, never up", () => {
        const head = CSS.slice(
            CSS.indexOf("--tk-reveal-duration:"),
            CSS.indexOf("@keyframes tk-reveal-up")
        );

        for (const step of ["section", "card", "quiet"]) {
            const values = [
                ...head.matchAll(new RegExp(`--tk-reveal-shift-${step}:\\s*(\\d+)px`, "g")),
            ].map((match) => Number(match[1]));

            // Desktop, then the tablet and phone overrides.
            expect(values).toHaveLength(3);
            expect(values[1]).toBeLessThan(values[0]);
            expect(values[2]).toBeLessThan(values[1]);
        }

        /*
         * THE PAGE'S CADENCE, read off the tokens rather than off the call sites: the footer is the
         * quietest movement, the default step sits between, and a section is the largest treatment
         * below the hero. A future edit that flattens the page onto one distance fails here.
         */
        const base = Number(head.match(/--tk-reveal-shift:\s*(\d+)px/)![1]);
        const section = Number(head.match(/--tk-reveal-shift-section:\s*(\d+)px/)![1]);
        const card = Number(head.match(/--tk-reveal-shift-card:\s*(\d+)px/)![1]);
        const quiet = Number(head.match(/--tk-reveal-shift-quiet:\s*(\d+)px/)![1]);

        expect(quiet).toBeLessThan(base);
        expect(card).toBeGreaterThanOrEqual(base);
        expect(card).toBeLessThan(section);
    });

    it("keeps the page to ONE tiny scale, and never scales a whole section", () => {
        // Two factors exist because two steps scale; anything below 0.96 would be a zoom, not a
        // landing.
        const heroFactor = Number(CSS.match(/--tk-reveal-scale-factor:\s*([\d.]+)/)![1]);
        const cardFactor = Number(CSS.match(/--tk-reveal-scale-factor-card:\s*([\d.]+)/)![1]);

        expect(heroFactor).toBeGreaterThanOrEqual(0.96);
        expect(cardFactor).toBeGreaterThanOrEqual(0.96);
        expect(cardFactor).toBeLessThanOrEqual(heroFactor);
        expect(cardFactor).toBeLessThan(1);

        // The keyframe takes the factor from the token, so there is one scale definition in total.
        const scale = CSS.slice(
            CSS.indexOf("@keyframes tk-reveal-scale"),
            CSS.indexOf("/*", CSS.indexOf("@keyframes tk-reveal-scale"))
        );
        expect(scale).toContain("scale(var(--tk-reveal-scale-factor))");

        /*
         * A full-width section must MOVE, not resize: scaling one would drag its own contents
         * around, which is exactly the layout shift this system exists to avoid.
         */
        for (const step of ["section", "quiet", "up"]) {
            const source = `[data-reveal="${step}"],`;
            const start = CSS.indexOf(source);

            if (start === -1) {
                continue;
            }

            expect(CSS.slice(start, CSS.indexOf("}", start))).not.toContain("scale");
        }

        // …and the two steps that DO scale say so explicitly.
        for (const step of ["scale", "card"]) {
            const start = CSS.indexOf(`[data-reveal="${step}"],`);
            expect(start).toBeGreaterThan(-1);
            expect(CSS.slice(start, CSS.indexOf("}", start))).toContain(
                "animation-name: tk-reveal-scale"
            );
        }
    });

    it("never animates layout properties", () => {
        // The whole motion block, isolated so an unrelated later rule cannot satisfy it.
        const start = CSS.indexOf("@keyframes tk-reveal-up");
        const end = CSS.indexOf("prefers-reduced-motion: reduce", start);
        const motion = CSS.slice(start, end);

        for (const property of ["width", "height", "top", "left", "margin", "padding"]) {
            expect(motion).not.toMatch(new RegExp(`(^|[{;\\s])${property}\\s*:`, "m"));
        }

        // It DOES animate opacity and transform.
        expect(motion).toContain("opacity");
        expect(motion).toContain("transform");
    });

    it("uses data attributes so server and client markup are identical", () => {
        expect(CSS).toContain("[data-reveal]");
        expect(CSS).toContain('[data-reveal="scale"]');
        expect(CSS).toContain("[data-reveal-scroll]");
        // The scroll variant only hides when the browser can also reveal it.
        expect(CSS).toContain("@supports (animation-timeline: view())");

        // The one-shot layer is driven by the three attributes the observer writes at runtime.
        for (const attribute of [
            "data-reveal-armed",
            "data-reveal-in",
            "data-reveal-static",
        ]) {
            expect(CSS).toContain(attribute);
        }
    });
});

/* ==================================================================================
 * 2. REDUCED MOTION — CONTENT MUST BE IMMEDIATELY USABLE
 * ================================================================================== */

describe("prefers-reduced-motion is honoured for both variants", () => {
    it("disables the animation and forces the resting state", () => {
        const reduceBlock = CSS.slice(
            CSS.lastIndexOf("@media (prefers-reduced-motion: reduce)")
        );

        expect(reduceBlock).toContain("[data-reveal]");
        expect(reduceBlock).toContain("[data-reveal-scroll]");
        expect(reduceBlock).toMatch(/animation:\s*none\s*!important/);
        expect(reduceBlock).toMatch(/opacity:\s*1\s*!important/);
        expect(reduceBlock).toMatch(/transform:\s*none\s*!important/);
    });    it("keeps the scroll variant behind a no-preference guard too", () => {
        // Belt and braces: `animation-timeline` is only attached when the visitor has NOT asked
        // for reduced motion, so there is no path where a scroll-driven reveal can hide content.
        const supportsStart = CSS.indexOf("@supports (animation-timeline: view())");
        const reduceStart = CSS.indexOf(
            "@media (prefers-reduced-motion: reduce)",
            supportsStart
        );

        expect(supportsStart).toBeGreaterThan(-1);
        expect(reduceStart).toBeGreaterThan(supportsStart);

        const supportsBlock = CSS.slice(supportsStart, reduceStart);

        expect(supportsBlock).toContain("prefers-reduced-motion: no-preference");
    });

    it("has nothing left to reset on the way in — no animation is ever paused", () => {
        /*
         * The whole `animation-play-state` mechanism is gone, which is the point of the fix rather
         * than a detail of it: a paused animation is one that has to be resumed, and resuming one
         * is what put every reveal's start time in the future. With no paused state there is also
         * no paused state to neutralise here, so the reduce block only has to force the resting
         * values.
         */
        expect(CSS).not.toContain("animation-play-state");
        expect(CSS).not.toContain("paused");
    });
});

/* ==================================================================================
 * 3. THE PRIMITIVE
 * ================================================================================== */

describe("Reveal is a server component with a capped stagger", () => {
    it("is not a client component and carries no runtime behaviour", () => {
        const source = readCode("components/ui/Reveal.tsx");

        expect(source).not.toContain('"use client"');
        expect(source).not.toContain("useEffect");
        expect(source).not.toContain("useState");
        expect(source).not.toContain("IntersectionObserver");
    });

    it("caps the stagger instead of scaling it with the list length", () => {
        expect(revealDelay(0)).toBe(0);
        expect(revealDelay(1)).toBe(REVEAL_STEP_MS);
        expect(revealDelay(100)).toBe(REVEAL_MAX_DELAY_MS);
        expect(revealDelay(100, 120)).toBe(120 + REVEAL_MAX_DELAY_MS);
        // A hundred cards and a thousand cards cost the same final delay.
        expect(revealDelay(1000)).toBe(revealDelay(100));
    });

    it("uses a step that reads as a sequence and a cap that keeps a long row short", () => {
        // Below ~40ms the items look simultaneous; above ~90ms the row feels like it is loading.
        expect(REVEAL_STEP_MS).toBeGreaterThanOrEqual(50);
        expect(REVEAL_STEP_MS).toBeLessThanOrEqual(80);

        // Five steps of stagger: the last card in a long row still arrives inside half a second.
        expect(REVEAL_MAX_DELAY_MS).toBe(REVEAL_STEP_MS * 5);
        expect(REVEAL_MAX_DELAY_MS).toBeLessThanOrEqual(400);
    });

    it("renders the time-based attribute by default", () => {
        const html = renderToStaticMarkup(
            createElement(Reveal, null, "content")
        );

        expect(html).toContain('data-reveal="up"');
        expect(html).not.toContain("data-reveal-scroll");
        expect(html).not.toContain("animation-delay");
        expect(html).toContain("content");
    });

    it("renders the scale variant and the scroll variant, and a delay only when asked", () => {
        const scaled = renderToStaticMarkup(
            createElement(Reveal, { variant: "scale" }, "x")
        );
        expect(scaled).toContain('data-reveal="scale"');

        const scrolled = renderToStaticMarkup(
            createElement(Reveal, { scroll: true }, "x")
        );
        expect(scrolled).toContain('data-reveal-scroll="up"');
        expect(scrolled).not.toContain('data-reveal="up"');

        const delayed = renderToStaticMarkup(
            createElement(Reveal, { delay: 180 }, "x")
        );
        expect(delayed).toContain("animation-delay:180ms");
    });

    it("keeps semantics by rendering the requested element", () => {
        const li = renderToStaticMarkup(
            createElement(Reveal, { as: "li" }, "x")
        );
        expect(li.startsWith("<li")).toBe(true);

        const section = renderToStaticMarkup(
            createElement(Reveal, { as: "section", scroll: true }, "x")
        );
        expect(section.startsWith("<section")).toBe(true);
    });
});

/* ==================================================================================
 * 4. THE WIRING — ALL FOUR PAGES, ONE SYSTEM
 * ================================================================================== */

describe("the four customer pages use the shared entrance system", () => {
    it.each(REVEAL_PAGES)("%s imports and uses Reveal", (file) => {
        const code = readCode(file);

        expect(code).toContain('from "@/components/ui/Reveal"');
        expect(code).toContain("<Reveal");
    });

    it.each([
        "app/events/page.tsx",
        "app/ticketing/tickets/page.tsx",
        "app/ticketing/orders/page.tsx",
    ])("%s staggers its list items with the capped helper", (file) => {
        const code = readCode(file);

        expect(code).toContain("revealDelay(");
        // The unit is the list item, not an element nested inside a card.
        expect(code).toContain('as="li"');
    });

    it("the landing page reveals its sections on scroll and its hero on paint", () => {
        const code = readCode("app/page.tsx");

        expect(code).toContain("scroll");
        // The hero shows a four-step cascade, not one element animating forever.
        expect(code).toContain("delay={80}");
        expect(code).toContain("delay={160}");
        expect(code).toContain("delay={240}");
    });
});

/* ==================================================================================
 * 4b. THE FULL LANDING PAGE — EVERY SECTION, ONE CADENCE
 * ==================================================================================
 * The hero was already animated; this block covers the pass that took the motion to the bottom of
 * the page. Each assertion is about COVERAGE (a section has no motion) or about SCOPE (a shared
 * component was animated where it must not be), which are the two ways this kind of change goes
 * wrong.
 */

const EVENT: PublicEventCard = {
    slug: "liga-basket-bandung",
    title: "Liga Basket Bandung",
    bannerUrl: "/uploads/events/banner.jpg",
    sportName: "Basket",
    sportSlug: "basket",
    startAt: "2026-10-03T12:00:00.000Z",
    endAt: "2026-10-03T14:00:00.000Z",
    timezone: "Asia/Jakarta",
    venueName: "GOR Tridharma",
    venueCity: "Bandung",
    priceFrom: 75000,
    priceTo: 150000,
    salesState: "OPEN",
    isSoldOut: false,
    remaining: null,
    shareUrl: "https://tinggalklik.co/e/liga-basket-bandung",
};

const SPORTS: SportOption[] = [
    { id: "s1", name: "Basket", slug: "basket" },
    { id: "s2", name: "Badminton", slug: "badminton" },
    { id: "s3", name: "Lari", slug: "lari" },
];

function renderToString(element: Parameters<typeof renderToStaticMarkup>[0]): string {
    return renderToStaticMarkup(element);
}

describe("the rhythm steps exist for both modes and add no new movement", () => {
    it("declares every step as a token move in both modes", () => {
        for (const step of ["scale", "section", "card", "quiet"]) {
            // The paint-time step…
            expect(CSS).toContain(`[data-reveal="${step}"]`);
            // …and its entry-triggered counterpart, named in the same rhythm block.
            expect(CSS).toContain(`[data-reveal-scroll="${step}"]`);
        }

        for (const token of [
            "--tk-reveal-shift-section",
            "--tk-reveal-shift-card",
            "--tk-reveal-shift-quiet",
        ]) {
            expect(CSS).toContain(token);
        }
    });

    it("declares the steps in ONE block that both modes read", () => {
        /*
         * The steps are declared once, for both attribute names, in a block that comes AFTER the
         * mode rules — because those set the `animation` shorthand, and a shorthand resets
         * `animation-duration`/`animation-name`. A step written before them would silently do
         * nothing, which is the exact failure this asserts against.
         */
        const steps = CSS.indexOf('[data-reveal="scale"],');
        const card = CSS.indexOf('[data-reveal="card"],');

        expect(steps).toBeGreaterThan(-1);
        // The block opens with `scale` and lists every other step after it.
        expect(card).toBeGreaterThan(steps);

        // …and both mode rules — the scroll-linked one and the one-shot one — come before it.
        for (const anchor of [
            "@supports (animation-timeline: view())",
            "html[data-reveal-armed]",
        ]) {
            const at = CSS.indexOf(anchor);

            expect(at).toBeGreaterThan(-1);
            expect(at).toBeLessThan(steps);
        }

        /*
         * TWO rules in the file can hold an element hidden, and both sit behind a `no-preference`
         * guard: the scroll-linked path, which arming removes, and the one-shot path, which is what
         * runs. There is no third "browser without a view timeline" fallback any more, because the
         * one-shot path declares the entrance itself instead of detaching one.
         */
        expect(
            (CSS.slice(0, steps).match(/prefers-reduced-motion: no-preference/g) ?? []).length
        ).toBe(2);
    });

    it("renders each step as its own attribute, and no step above `up` by accident", () => {
        for (const variant of ["up", "scale", "section", "card", "quiet"] as const) {
            expect(renderToString(createElement(Reveal, { variant }, "x"))).toContain(
                `data-reveal="${variant}"`
            );
            expect(renderToString(createElement(Reveal, { variant, scroll: true }, "x"))).toContain(
                `data-reveal-scroll="${variant}"`
            );
        }
    });

    it("names exactly the steps the CSS knows about, and no extras", () => {
        const source = readCode("components/ui/Reveal.tsx");
        const union = source.match(/type Variant = ([^;]+);/)![1];
        const steps = [...union.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);

        expect(steps).toEqual(["up", "scale", "section", "card", "quiet"]);

        // Every named step is a real CSS rule, so a typo cannot render an inert attribute. `up`
        // is the base step and is selected by the bare attribute, not by a step name.
        for (const step of steps.filter((name) => name !== "up")) {
            expect(CSS).toContain(`[data-reveal="${step}"]`);
            expect(CSS).toContain(`[data-reveal-scroll="${step}"]`);
        }

        expect(CSS).toContain("[data-reveal-scroll] {");
    });
});

describe("every landing-page section carries an entrance, at the right intensity", () => {
    it("gives the four real sections the section step, revealed on entry", () => {
        const code = readCode("app/page.tsx");
        // Split on the prop rather than on `<Reveal as="section"`, because a call site may put each
        // prop on its own line — the assertion must not depend on how prettier wrapped it.
        const segments = code.split('as="section"').slice(1);

        // The empty state plus the four real sections.
        expect(segments).toHaveLength(5);

        const tags = segments.map((segment) => segment.slice(0, segment.indexOf(">")));
        const scrollRevealed = tags.filter((tag) => tag.includes("scroll"));

        // The four real sections are the ones that reveal on entry…
        expect(scrollRevealed).toHaveLength(4);
        for (const tag of scrollRevealed) {
            expect(tag).toContain('variant="section"');
        }

        // Four sections arrive with the section treatment…
        expect((code.match(/variant="section"/g) ?? []).length).toBe(4);
        // …and the empty state deliberately does not: a fallback must not out-shout the content.
        expect((code.match(/variant="up"/g) ?? []).length).toBe(1);
    });

    it("keeps the empty state on the subtle step", () => {
        const code = readCode("app/page.tsx");
        /*
         * The `<Reveal` that WRAPS the heading, found by scanning backwards from the heading text so
         * the assertion cannot be satisfied by some earlier call site that happens to sit within a
         * fixed number of characters of it.
         */
        const heading = code.indexOf("Belum ada event yang tayang");
        const opens = code.lastIndexOf("<Reveal", heading);
        const tag = code.slice(opens, code.indexOf(">", opens) + 1);

        expect(opens).toBeGreaterThan(-1);
        expect(tag).toContain('variant="up"');
        expect(tag).not.toContain("variant=\"card\"");
        expect(tag).not.toContain("variant=\"scale\"");
        expect(tag).not.toContain("scroll");

        /*
         * …and it arrives on the clock, one step behind the hero, because it sits inside the first
         * screen at every viewport: the observer would classify it as already on screen and leave it
         * to appear with no motion at all, and "nothing is on sale" is not a message to deliver
         * silently.
         */
        expect(code).toContain("const EMPTY_STATE_DELAY_MS = 360");
        expect(tag).toContain("delay={EMPTY_STATE_DELAY_MS}");
    });

    it("keeps the hero a paint-time cascade — the page's strongest entrance", () => {
        const code = readCode("app/page.tsx");

        // The hero is above the fold, so it reveals on paint (no `scroll`) with a four-step cascade.
        for (const delay of ["delay={80}", "delay={160}", "delay={240}", "delay={300}"]) {
            expect(code).toContain(delay);
        }

        // Exactly one `scale` step remains, and it is the hero's search block.
        expect(code.match(/variant="scale"/g) ?? []).toHaveLength(1);
    });

    it("gives the page a descending rhythm: hero → section → cards → footer", () => {
        // Read from the call sites rather than asserted abstractly, so a future edit that flattens
        // the page back onto one treatment fails here.
        expect(readCode("app/page.tsx")).toContain('variant="section"');
        expect(readCode("components/ticketing/EventRow.tsx")).toContain("revealDelay(");
        expect(readCode("components/ticketing/SiteFooter.tsx")).toContain('variant="quiet"');
    });
});

describe("the section heading cascades instead of arriving as one block", () => {
    it("staggers the heading, its sub-line and its action", () => {
        const code = readCode("components/ticketing/SectionHeader.tsx");

        // Three separate steps…
        expect(code.match(/<Reveal/g) ?? []).toHaveLength(3);
        // …all scroll-driven, so the cascade plays on entry rather than on first paint. The heading
        // also carries `scroll-mt-24` for the sticky header's offset, which is not a reveal.
        expect(code.match(/scroll(?!-mt)/g) ?? []).toHaveLength(3);
    });

    it("renders the heading as the section step with the `id` intact, and the sub-line delayed", () => {
        const html = renderToString(
            createElement(SectionHeader, {
                id: "terdekat",
                title: "Event terdekat",
                subtitle: "Yang paling cepat digelar",
                href: "/events",
            })
        );

        // The heading keeps its semantics AND its anchor id.
        expect(html).toContain('<h2');
        expect(html).toContain('id="terdekat"');
        expect(html).toContain('data-reveal-scroll="section"');

        // The sub-line and the action follow one step behind.
        expect((html.match(/animation-delay:80ms/g) ?? []).length).toBe(2);

        // Exactly one link, and it is still the action's — the wrapper adds no second one.
        expect(html.match(/<a /g) ?? []).toHaveLength(1);
    });
});

describe("event cards stagger as list items, and only on the landing page", () => {
    it("renders ONE <li> per event — the reveal wraps the item, it does not nest it", () => {
        const html = renderToString(
            createElement(EventRow, { events: [EVENT, { ...EVENT, slug: "b" }, { ...EVENT, slug: "c" }] })
        );

        expect((html.match(/<li /g) ?? []).length).toBe(3);
        expect(html).not.toContain("<li><li");
    });

    it("staggers the items with the capped helper, on the card step, revealed on entry", () => {
        const html = renderToString(
            createElement(EventRow, { events: [EVENT, { ...EVENT, slug: "b" }, { ...EVENT, slug: "c" }] })
        );

        // Each item is its own entrance, on the step that carries the small landing scale.
        expect(html).toContain('data-reveal-scroll="card"');
        expect((html.match(/data-reveal-scroll="card"/g) ?? []).length).toBe(3);

        // 70ms apart: card 2 at one step, card 3 at two — real elapsed time in the one-shot mode.
        expect(html).toContain(`animation-delay:${REVEAL_STEP_MS}ms`);
        expect(html).toContain(`animation-delay:${REVEAL_STEP_MS * 2}ms`);

        // The first card is not delayed, so the row is already starting as it enters.
        expect(html).not.toContain("animation-delay:0ms");
    });

    it("keeps a long row from queueing: the delay stops at the cap", () => {
        const many = Array.from({ length: 8 }, (_, index) => ({
            ...EVENT,
            slug: `event-${index}`,
        }));
        const html = renderToString(createElement(EventRow, { events: many }));

        const delays = [
            ...html.matchAll(/animation-delay:(\d+)ms/g),
        ].map((match) => Number(match[1]));

        // Seven delayed cards (the first has none), and the largest delay is the cap.
        expect(delays).toHaveLength(7);
        expect(Math.max(...delays)).toBe(REVEAL_MAX_DELAY_MS);
        expect(delays.filter((delay) => delay === REVEAL_MAX_DELAY_MS)).toHaveLength(3);
    });

    it("keeps the snap-scroll list intact — the reveal adds no wrapper element", () => {
        const html = renderToString(createElement(EventRow, { events: [EVENT] }));

        expect(html).toContain("data-event-row");
        expect(html).toContain("snap-x");
        // One list, one item: no extra box between them.
        expect((html.match(/<ul /g) ?? []).length).toBe(1);
    });
});

/*
 * THE OTHER LAYOUT — opt-in, and used by exactly one section. Keeping it a variant of the LIST (the
 * same `Reveal`-wrapped items, the same capped stagger, the same `EventCard`) rather than a second
 * card or a second row component is what lets "Baru ditambahkan" read as a catalogue while every
 * other row — Event terdekat above all — stays byte-identically the horizontal scroller.
 */
describe("the newest section opts into the vertical card grid, and the other rows do not", () => {
    it("stacks full-width cards instead of a snap-scroller", () => {
        const html = renderToString(
            createElement(EventRow, {
                events: [EVENT, { ...EVENT, slug: "b" }],
                layout: "grid",
            })
        );

        // One column on a phone, two on a tablet, three from `lg` up.
        expect(html).toContain("grid-cols-1");
        expect(html).toContain("sm:grid-cols-2");
        expect(html).toContain("lg:grid-cols-3");

        // No scroller and no fixed card width: the cards are in the page's own flow.
        expect(html).not.toContain("snap-x");
        expect(html).not.toContain("overflow-x-auto");
        expect(html).not.toContain("w-[268px]");

        // Still a list, still one item per event.
        expect(html).toContain("data-event-row");
        expect((html.match(/<ul /g) ?? []).length).toBe(1);
        expect((html.match(/<li /g) ?? []).length).toBe(2);
    });

    it("keeps the shared entrance — the same card step and the same capped stagger", () => {
        const html = renderToString(
            createElement(EventRow, {
                events: [EVENT, { ...EVENT, slug: "b" }, { ...EVENT, slug: "c" }],
                layout: "grid",
            })
        );

        expect(html).toContain('data-reveal-scroll="card"');
        expect((html.match(/data-reveal-scroll="card"/g) ?? []).length).toBe(3);
        expect(html).toContain(`animation-delay:${REVEAL_STEP_MS}ms`);
        expect(html).toContain(`animation-delay:${REVEAL_STEP_MS * 2}ms`);
    });

    it("is opted into by the new-events section only — the protected rows keep the default", () => {
        const code = readCode("app/page.tsx");

        // Exactly one call site asks for the grid…
        expect((code.match(/layout="grid"/g) ?? []).length).toBe(1);

        // …and it is the `sort: newest` section, while Event terdekat (the protected row) and the
        // free-ticket row take no layout prop at all.
        expect(code).toContain('<EventRow events={newest.items} layout="grid" />');
        expect(code).toContain("<EventRow events={upcoming} />");
        expect(code).toContain("<EventRow events={free.items} />");
    });
});

describe("sport tiles stagger on the landing page and the /events filter chips do NOT", () => {
    it("staggers the tile variant, on the card step, revealed on entry", () => {
        const html = renderToString(createElement(SportGrid, { sports: SPORTS }));

        expect(html).toContain('data-reveal-scroll="card"');
        expect((html.match(/data-reveal-scroll="card"/g) ?? []).length).toBe(SPORTS.length);
        expect((html.match(/<li /g) ?? []).length).toBe(SPORTS.length);

        // Every tile carries the pace marker, so the stylesheet's breakpoint rule can match it and
        // nothing else on the page. It leads the class list; the layout classes follow it.
        expect((html.match(/class="reveal-tile[^"]*"/g) ?? []).length).toBe(SPORTS.length);

        // The tile still animates (it is not on the static/`animation: none` path), and the pace
        // arrives as data rather than as an inline `animation-delay`…
        expect(html).not.toContain("animation-delay");

        // The tile is revealed as a whole: one attribute per <li>, none on the link inside it.
        expect(html).not.toMatch(/<a [^>]*data-reveal/);
    });

    it("scrolls horizontally below `lg`, and the page itself never scrolls sideways", () => {
        const html = renderToString(createElement(SportGrid, { sports: SPORTS }));

        /*
         * The tiles ride the same scroller recipe as the event rows: the horizontal overflow belongs
         * to THIS list (`overflow-x-auto`), it bleeds to the container's edge through a negative
         * margin that its own padding cancels out, and the bar is hidden on both engines. That is
         * exactly why the document cannot gain a horizontal scrollbar.
         */
        expect(html).toContain("snap-x");
        expect(html).toContain("snap-mandatory");
        expect(html).toContain("overflow-x-auto");
        expect(html).toContain("-mx-4");
        expect(html).toContain("sm:-mx-6");
        expect(html).toContain("lg:mx-0");
        // Rendered HTML escapes the arbitrary variant's `&`.
        expect(html).toContain("[&amp;::-webkit-scrollbar]:hidden");
        expect(html).toContain("[scrollbar-width:none]");

        // Every tile is a fixed snap target on the scroller and a grid cell from `lg` up, so a wide
        // screen is still the tidy grid it always was rather than one thin row of fourteen.
        expect((html.match(/shrink-0 snap-start/g) ?? []).length).toBe(SPORTS.length);
        expect((html.match(/lg:w-auto/g) ?? []).length).toBe(SPORTS.length);
        expect(html).toContain("lg:grid");
        expect(html).toContain("lg:grid-cols-4");
        expect(html).toContain("xl:grid-cols-7");
    });

    it("keeps the tablet/desktop tile delays on the shared capped helper", () => {
        const many = Array.from({ length: 8 }, (_, index) => ({
            id: `s${index}`,
            name: `Sport ${index}`,
            slug: `sport-${index}`,
        }));
        const html = renderToString(createElement(SportGrid, { sports: many }));

        // `--tk-tile-delay` is the value every width above `md` plays, and it is literally
        // `revealDelay(index)` — the same capped helper the event rows and the footer use.
        for (let index = 0; index < many.length; index += 1) {
            expect(html).toContain(`--tk-tile-delay:${revealDelay(index)}ms`);
        }

        expect(revealDelay(7)).toBe(REVEAL_MAX_DELAY_MS);
        expect(html).toContain(`--tk-tile-delay:${REVEAL_MAX_DELAY_MS}ms`);
        expect(html).toContain(`--tk-tile-delay:${REVEAL_STEP_MS}ms`);
    });

    it("exposes the phone's own pace, and caps it well below the shared one", () => {
        expect(sportTileMobileDelay(0)).toBe(0);
        expect(sportTileMobileDelay(1)).toBe(SPORT_TILE_MOBILE_STEP_MS);
        expect(sportTileMobileDelay(100)).toBe(SPORT_TILE_MOBILE_MAX_DELAY_MS);
        expect(sportTileMobileDelay(1000)).toBe(sportTileMobileDelay(100));

        // A 20-25ms step: below the ~40ms that reads as "simultaneous", and a third of the shared
        // 70ms step, which is what turns fourteen arrivals into one grid.
        expect(SPORT_TILE_MOBILE_STEP_MS).toBeGreaterThanOrEqual(15);
        expect(SPORT_TILE_MOBILE_STEP_MS).toBeLessThanOrEqual(25);
        expect(SPORT_TILE_MOBILE_STEP_MS).toBeLessThan(REVEAL_STEP_MS);

        // The cap keeps the last tile inside ~120-150ms, so a 14-tile phone grid clears in a tenth
        // of a second instead of queueing.
        expect(SPORT_TILE_MOBILE_MAX_DELAY_MS).toBeLessThanOrEqual(150);
        expect(SPORT_TILE_MOBILE_MAX_DELAY_MS).toBeGreaterThanOrEqual(100);
        expect(SPORT_TILE_MOBILE_MAX_DELAY_MS).toBeLessThan(REVEAL_MAX_DELAY_MS);

        // Six steps, then the cap.
        expect(sportTileMobileDelay(6)).toBe(SPORT_TILE_MOBILE_MAX_DELAY_MS);
        expect(sportTileMobileDelay(5)).toBe(SPORT_TILE_MOBILE_STEP_MS * 5);
    });

    it("renders both paces on every tile, so the breakpoint has something to choose", () => {
        const html = renderToString(createElement(SportGrid, { sports: SPORTS }));

        for (let index = 0; index < SPORTS.length; index += 1) {
            expect(html).toContain(`--tk-tile-delay:${revealDelay(index)}ms`);
            expect(html).toContain(
                `--tk-tile-delay-mobile:${sportTileMobileDelay(index)}ms`
            );
        }
    });

    it("leaves the chip variant completely un-animated, so /events is untouched", () => {
        const html = renderToString(
            createElement(SportGrid, { sports: SPORTS, variant: "chip" })
        );

        expect(html).not.toContain("data-reveal");
        expect(html).not.toContain("animation-delay");
        // The pace marker only exists in the tile branch, so no breakpoint rule can reach a chip.
        expect(html).not.toContain("reveal-tile");
        expect(html).not.toContain("--tk-tile-delay");

        // …and the component's source scopes the reveal to the tile branch.
        const code = readCode("components/ticketing/SportGrid.tsx");
        const chipBranch = code.slice(code.indexOf('variant === "chip"'), code.indexOf("return (", code.indexOf('variant === "chip"')));

        expect(chipBranch).not.toContain("<Reveal");
    });
});

/* ==================================================================================
 * 4d. THE SPORT GRID'S MOBILE PACE — FASTER BELOW `md`, IDENTICAL ABOVE IT
 * ==================================================================================
 * A phone shows two columns of fourteen tiles, so the shared card cadence turns the grid into a queue
 * the visitor out-scrolls. The fix is one breakpoint-scoped block; these assertions are the contract
 * that it stays scoped, stays faster, and changes nothing above it.
 */

describe("the sport grid runs faster on a phone and is untouched above it", () => {
    const flat = CSS.replace(/\s+/g, " ");

    /** The declarations of one flattened rule, so an assertion cannot be met by another rule. */
    function rule(selector: string): string {
        const start = flat.indexOf(selector);

        expect(start).toBeGreaterThan(-1);

        const open = flat.indexOf("{", start);

        return flat.slice(open + 1, flat.indexOf("}", open));
    }

    const mobileStart = CSS.indexOf("@media (max-width: 767px)");
    const reduceStart = CSS.indexOf("@media (prefers-reduced-motion: reduce)", mobileStart);
    const mobile = CSS.slice(mobileStart, reduceStart);

    it("scopes the faster pace to BELOW md — 767px, not the tablet's 1023.98px", () => {
        expect(mobileStart).toBeGreaterThan(-1);
        expect(reduceStart).toBeGreaterThan(mobileStart);

        // 767px is Tailwind's `md` boundary: the phone layout ends exactly here, so the tablet
        // (834x1112) and the desktop keep the cadence they had.
        expect(flat).toContain("@media (max-width: 767px)");
        expect(mobile).toContain('[data-reveal="card"].reveal-tile');
        expect(mobile).toContain('[data-reveal-scroll="card"].reveal-tile');
    });

    it("gives the phone a shorter entrance than the card step it replaces", () => {
        const duration = Number(mobile.match(/--tk-reveal-duration-tile:\s*(\d+)ms/)![1]);
        const shift = Number(mobile.match(/--tk-reveal-shift-tile:\s*(\d+)px/)![1]);

        // 300-350ms, the brief's band, and visibly shorter than the 500-580ms card step.
        expect(duration).toBeGreaterThanOrEqual(300);
        expect(duration).toBeLessThanOrEqual(350);

        const cardDuration = Number(CSS.match(/--tk-reveal-duration-card:\s*(\d+)ms/)![1]);

        expect(duration).toBeLessThan(cardDuration);

        // A 6-8px rise: smaller than the tablet's 13px card distance, and the same tiny 0.98 scale
        // the card step already uses (the tile rule introduces no second scale).
        expect(shift).toBeGreaterThanOrEqual(6);
        expect(shift).toBeLessThanOrEqual(8);
        expect(shift).toBeLessThan(
            Number(CSS.match(/--tk-reveal-shift-card:\s*(\d+)px/)![1])
        );

        // …and the tile rule only ever names a duration and a delay: no keyframes, no new movement.
        expect(mobile).toContain("animation-duration: var(--tk-reveal-duration-tile)");
        expect(mobile).not.toContain("animation-name");
        expect(mobile).not.toContain("@keyframes");
    });

    it("plays the phone's delay only BELOW md, and the shared one above it", () => {
        const base = CSS.slice(0, mobileStart);

        // Above the breakpoint the tile's delay is `--tk-tile-delay`, whose value is `revealDelay()`.
        expect(rule('[data-reveal="card"].reveal-tile, [data-reveal-scroll="card"].reveal-tile')).toBe(
            " animation-delay: var(--tk-tile-delay); "
        );

        // Below it, the phone's value plays instead.
        expect(mobile).toContain("animation-delay: var(--tk-tile-delay-mobile)");

        /*
         * …and the phone's tokens do not EXIST above the breakpoint: they are declared inside the
         * media block, so no desktop or tablet rule can reference them even by accident.
         */
        expect(base).not.toContain("--tk-reveal-duration-tile");
        expect(base).not.toContain("--tk-reveal-shift-tile");
        expect(base).not.toContain("--tk-tile-delay-mobile");
        expect((CSS.match(/--tk-reveal-duration-tile/g) ?? []).length).toBe(2);
    });

    it("leaves the card step, and every other step's desktop timing, exactly as it was", () => {
        // The tile still wears the card step wherever it is read…
        const card = rule('[data-reveal="card"], [data-reveal-scroll="card"]');

        expect(card).toContain("--tk-reveal-shift: var(--tk-reveal-shift-card)");
        expect(card).toContain("--tk-reveal-scale-factor: var(--tk-reveal-scale-factor-card)");
        expect(card).toContain("animation-name: tk-reveal-scale");
        expect(card).toContain("animation-duration: var(--tk-reveal-duration-card)");

        // …and the desktop/tablet card tokens themselves are the untouched originals.
        expect(CSS).toMatch(/--tk-reveal-shift-card:\s*16px/);
        expect(CSS).toMatch(/--tk-reveal-duration-card:\s*580ms/);
        expect(CSS).toMatch(/--tk-reveal-shift-section:\s*18px/);
        expect(CSS).toMatch(/--tk-reveal-duration-section:\s*620ms/);
        expect(CSS).toMatch(/--tk-reveal-shift-quiet:\s*8px/);
        expect(CSS).toMatch(/--tk-reveal-duration-quiet:\s*620ms/);

        // The tablet/phone token blocks are unchanged too: the new pace lives in its own block.
        expect(CSS).toMatch(/--tk-reveal-shift-card:\s*13px/);
        expect(CSS).toMatch(/--tk-reveal-duration-card:\s*540ms/);
        expect(CSS).toMatch(/--tk-reveal-shift-card:\s*10px/);
        expect(CSS).toMatch(/--tk-reveal-duration-card:\s*500ms/);
    });

    it("does not change EventRow's or the footer's pacing", () => {
        // The shared step and cap are untouched, and that is what those two call sites read.
        expect(REVEAL_STEP_MS).toBe(70);
        expect(REVEAL_MAX_DELAY_MS).toBe(350);
        expect(readCode("components/ticketing/EventRow.tsx")).toContain("revealDelay(");
        expect(readCode("components/ticketing/SiteFooter.tsx")).toContain("revealDelay(");

        /*
         * The tile class is named exactly four times in the stylesheet — the two card-attribute
         * selectors of the base rule, and the same two in the phone block — so no third rule (and no
         * non-tile element) can pick up either pace.
         */
        expect([...CSS.matchAll(/\[data-reveal(?:-scroll)?="card"\]\.reveal-tile/g)]).toHaveLength(4);
        expect((CSS.match(/reveal-tile/g) ?? []).length).toBe(4);
        // …and in the component it is written once, on the tile branch only.
        expect((readCode("components/ticketing/SportGrid.tsx").match(/reveal-tile/g) ?? []).length).toBe(1);
    });

    it("keeps the phone's pace on the same safe mechanism — no paused state, no timeline swap", () => {
        expect(mobile).not.toContain("animation-play-state");
        expect(mobile).not.toContain("paused");
        expect(mobile).not.toContain("animation-timeline");

        // Reduced motion still wins on a phone: the reduce block is later in the file and forces the
        // resting state with `!important` for both attributes.
        const reduce = CSS.slice(reduceStart);

        expect(reduce).toContain("[data-reveal-scroll]");
        expect(reduce).toMatch(/animation:\s*none\s*!important/);
        expect(reduce).toMatch(/opacity:\s*1\s*!important/);
        expect(reduce).toMatch(/transform:\s*none\s*!important/);
        expect(reduceStart).toBeGreaterThan(mobileStart);
    });
});

describe("the footer reveals quietly and stages every part of itself", () => {
    it("uses the quiet step on the footer itself", () => {
        const code = readCode("components/ticketing/SiteFooter.tsx");

        expect(code).toContain('<Reveal as="footer"');
        expect(code).toContain('variant="quiet"');
        expect(code).toContain("scroll");
        // The <footer> landmark is preserved — `as="footer"` renders the real element.
        expect(code).not.toContain("<footer");
    });

    it("gives every part of the footer the quiet step — it is the quietest block on the page", () => {
        const code = readCode("components/ticketing/SiteFooter.tsx");

        // The container, the brand block, each column and the bottom bar: four reveal sites, one
        // per group, each on the last rhythm step.
        expect((code.match(/<Reveal/g) ?? []).length).toBe(4);
        expect((code.match(/variant="quiet"/g) ?? []).length).toBe(4);
    });

    it("stages the brand, the three columns and the small print, in reading order", () => {
        const code = readCode("components/ticketing/SiteFooter.tsx");

        // One named step per group, so the sequence lives in one place rather than in three
        // hand-written numbers.
        expect(code).toContain("const BRAND_STEP = 0");
        expect(code).toContain("const FIRST_COLUMN_STEP = 1");
        expect(code).toContain("const BOTTOM_BAR_STEP = 4");

        expect(code).toContain("revealDelay(BRAND_STEP)");
        expect(code).toContain("revealDelay(FIRST_COLUMN_STEP + index)");
        expect(code).toContain("revealDelay(BOTTOM_BAR_STEP)");

        for (const index of [0, 1, 2]) {
            expect(code).toContain(`index={${index}}`);
        }
    });

    it("reveals a whole COLUMN, not each anchor, and keeps the landmark", () => {
        const code = readCode("components/ticketing/SiteFooter.tsx");

        // The unit is the column: `as="nav"` carries the reveal and keeps the label…
        expect(code).toContain('as="nav"');
        expect(code).toContain("aria-label={title}");
        // …and no list or anchor inside it is revealed at all.
        expect(code).not.toContain('as="ul"');
        expect(code).not.toMatch(/<Link[\s\S]{0,200}?data-reveal/);
    });
});

/* ==================================================================================
 * 4c. THE ONE-SHOT LAYER — ON THE CLOCK, ONCE, FOR EVERYTHING BELOW THE FOLD
 * ==================================================================================
 * The entrance used to be scroll-LINKED: its progress was the scroll position, so a short
 * element's entire entry passed inside one wheel notch and the page looked static below the hero.
 * `RevealObserver` starts each element once, on the clock. These assertions pin the properties that
 * make that safe and cheap rather than the ones that make it pretty.
 */

describe("one shared observer starts each entrance once, on the clock", () => {
    const observerPath = "components/ui/RevealObserver.tsx";
    const observer = readCode(observerPath);

    it("is a client component and renders nothing at all", () => {
        expect(observer).toContain('"use client"');
        expect(observer).toContain("return null");
        // It must not wrap or clone anything: the page's markup is the page's markup.
        expect(observer).not.toContain("children");
    });

    it("creates exactly ONE intersection observer and ONE mutation observer", () => {
        expect((observer.match(/new IntersectionObserver/g) ?? []).length).toBe(1);
        expect((observer.match(/new MutationObserver/g) ?? []).length).toBe(1);

        // …and disconnects both, so a route change cannot leak them.
        expect((observer.match(/\.disconnect\(\)/g) ?? []).length).toBe(2);
    });

    it("adds no scroll listener and no animation frame loop", () => {
        expect(observer).not.toContain('addEventListener("scroll"');
        expect(observer).not.toContain("addEventListener('scroll'");
        expect(observer).not.toContain("onscroll");
        expect(observer).not.toContain("requestAnimationFrame");
    });

    it("classifies every element BEFORE arming, so arming cannot hide what is on screen", () => {
        const classify = observer.indexOf("scan(document)");
        const arm = observer.indexOf("setAttribute(ARMED_ATTRIBUTE");

        expect(classify).toBeGreaterThan(-1);
        expect(arm).toBeGreaterThan(classify);

        // Anything already on screen is marked static instead of being held paused.
        expect(observer).toContain("STATIC_ATTRIBUTE");
        expect(observer).toContain("ALREADY_VISIBLE_TOP_RATIO");
        // …and a zero-box element can never be stranded invisible.
        expect(observer).toContain("hasBox");
    });

    it("does nothing at all when the visitor asked for reduced motion", () => {
        const guard = observer.indexOf("prefers-reduced-motion: reduce");
        const arm = observer.indexOf("setAttribute(ARMED_ATTRIBUTE");

        expect(guard).toBeGreaterThan(-1);
        // The guard returns before the armed attribute is ever written.
        expect(guard).toBeLessThan(observer.indexOf("const observer = new IntersectionObserver"));
        expect(arm).toBeGreaterThan(guard);
        expect(observer.slice(guard, arm)).toContain("return;");
    });

    it("is mounted once per shell, on every page that uses the reveal system", () => {
        const shell = readCode("components/ticketing/SiteShell.tsx");

        expect(shell).toContain("<RevealObserver />");
        expect((shell.match(/<RevealObserver/g) ?? []).length).toBe(1);

        // Every page that uses `<Reveal>` renders through that shell, so one mount covers them all.
        for (const page of REVEAL_PAGES) {
            expect(readCode(page)).toContain("SiteShell");
        }
    });

    it("keeps a no-JavaScript path that is not scroll-linked into invisibility", () => {
        // Without the observer the CSS still carries the entrance…
        expect(CSS).toContain("@supports (animation-timeline: view())");
        /*
         * …scoped to a page that has NOT been armed, so arming removes the rule instead of
         * overriding the animation it declared. Overriding is what used to put the resumed
         * animation's start time in the future; a rule that stops matching cannot.
         */
        expect(CSS.replace(/\s+/g, " ")).toContain(
            ":where(html:not([data-reveal-armed])) [data-reveal-scroll]"
        );
        // …the attribute alone hides nothing until the observer proves it is alive…
        expect(CSS).toContain("html[data-reveal-armed]");
        // …and the one-shot entrance needs no view-timeline support at all: it is declared, not
        // detached from one, so there is no separate fallback branch for browsers without it.
        expect(CSS).not.toContain("@supports not (animation-timeline: view())");
        expect(renderToString(createElement(Reveal, { scroll: true }, "x"))).toContain(
            'data-reveal-scroll="up"'
        );
    });

    /**
     * The declarations inside one flattened rule, so an assertion about a rule cannot be satisfied
     * by some other rule that happens to contain the same property.
     */
    function ruleFor(selector: string): string {
        const flat = CSS.replace(/\s+/g, " ");
        const start = flat.indexOf(selector);

        expect(start).toBeGreaterThan(-1);

        const open = flat.indexOf("{", start);

        return flat.slice(open + 1, flat.indexOf("}", open));
    }

    it("CREATES each entrance when it is revealed, instead of resuming a paused one", () => {
        /*
         * Three rules, and the shape of them is the fix: an armed element that is still waiting is
         * merely transparent and has NO animation, the entrance is created by the rule that matches
         * once `data-reveal-in` is set, and an element that was already on screen is explicitly
         * un-animated. There is no paused animation anywhere for Chrome to resume into the future.
         */
        const waiting = ruleFor(
            "html[data-reveal-armed] [data-reveal-scroll]:not([data-reveal-in]):not([data-reveal-static])"
        );
        expect(waiting).toContain("opacity: 0");
        expect(waiting).not.toContain("animation");
        expect(waiting).not.toContain("transform");

        const revealed = ruleFor(
            ":where(html[data-reveal-armed]) :where([data-reveal-scroll][data-reveal-in])"
        );
        expect(revealed).toContain(
            "animation: tk-reveal-up var(--tk-reveal-duration) var(--tk-reveal-ease) both"
        );
        // Zero specificity, so the rhythm steps below still own name and duration…
        expect(revealed).not.toContain("!important");
        expect(
            (CSS.match(/:where\(html\[data-reveal-armed\]\) :where\(\[data-reveal-scroll\]/g) ?? [])
                .length
        ).toBe(2);

        const still = ruleFor(
            ":where(html[data-reveal-armed]) :where([data-reveal-scroll][data-reveal-static])"
        );
        expect(still).toContain("animation: none");
        expect(still).toContain("opacity: 1");
    });

    it("triggers on a LENGTH, so the last block on a page is always reachable", () => {
        /*
         * A viewport percentage moves the line with the window, and the deepest block on a page can
         * only be revealed if the line sits above where that block ends up at maximum scroll. At
         * `-10%` that held on a 900px window and failed at 1112px, where the footer's small print
         * could not reach the line and stayed invisible for the whole visit.
         */
        expect(observer).toContain('const TRIGGER_BOTTOM_MARGIN = "-56px"');
        expect(observer).not.toMatch(/TRIGGER_BOTTOM_MARGIN = "-?\d+(\.\d+)?%"/);
        // …and it is the only margin the observer uses, so no rule can reintroduce a percentage.
        expect((observer.match(/TRIGGER_BOTTOM_MARGIN/g) ?? []).length).toBe(2);
    });

    it("releases a block that was scrolled past between two frames", () => {
        // A fast flick can take a block from below the trigger band to above the viewport without
        // ever reporting it as intersecting; releasing it there is what keeps it from being
        // stranded transparent for the rest of the visit.
        expect(observer).toContain("!entry.isIntersecting && entry.boundingClientRect.top >= 0");
        // An element above the viewport is still part of "everything classified on screen", so it
        // is never observed in the first place — this branch only ever sees a block that moved.
        expect(observer).toContain("ALREADY_VISIBLE_TOP_RATIO");
    });
});

describe("the hover micro-interactions are reduced-motion gated", () => {
    it.each(["components/events/EventCard.tsx", "components/ticketing/SportGrid.tsx"])(
        "%s wraps every hover transform in `motion-safe:`",
        (file) => {
            const code = readCode(file);

            const transforms = [
                ...code.matchAll(/[\w:\-\[\].]+(?:scale-|translate-y-)/g),
            ].map((match) => match[0]);

            expect(transforms.length).toBeGreaterThan(0);

            for (const token of transforms) {
                expect(token.startsWith("motion-safe:")).toBe(true);
            }
        }
    );

    it("the image zoom is a transform inside the already-clipped frame", () => {
        const code = readCode("components/events/EventCard.tsx");

        expect(code).toContain("motion-safe:group-hover:scale-[1.02]");
        // Nothing animates a box the hover could reflow.
        expect(code).not.toMatch(/motion-safe:(hover|group-hover):(w|h|p|m)-/);
    });
});

/* ==================================================================================
 * 5. CARDS STAY PURE — ANIMATE THE UNIT, NOT EVERY NESTED ELEMENT
 * ================================================================================== */

describe("the card components carry no animation of their own", () => {
    it.each([
        "components/events/EventCard.tsx",
        "components/ticketing/TicketCard.tsx",
        "components/ticketing/OrderCard.tsx",
    ])("%s is untouched by the reveal system", (file) => {
        const code = readCode(file);

        expect(code).not.toContain("data-reveal");
        expect(code).not.toContain("<Reveal");
        expect(code).not.toContain("animation");
    });
});

/* ==================================================================================
 * 6. NO ANIMATION DEPENDENCY WAS ADDED
 * ================================================================================== */

describe("the motion is CSS-only", () => {
    it("adds no animation library to the project", () => {
        const pkg = JSON.parse(read("package.json")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        const names = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
        ].join(" ");

        expect(names).not.toMatch(
            /framer-motion|\bgsap\b|react-spring|motion-one|auto-animate|@formkit\/auto-animate/i
        );
    });

    it("the reveal primitive imports nothing — not even a UI framework", () => {
        const source = readCode("components/ui/Reveal.tsx");

        expect(source).not.toMatch(
            /(shadcn|@radix-ui|@headlessui|lucide|framer-motion|@tanstack)/i
        );
    });
});
