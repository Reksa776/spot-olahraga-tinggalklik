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
    it("declares the two keyframes and lets the distance come from one token", () => {
        expect(CSS).toContain("@keyframes tk-reveal-up");
        expect(CSS).toContain("@keyframes tk-reveal-scale");
        expect(CSS).toContain("--tk-reveal-shift");
        // A small rise — the brief's 8-16px band.
        expect(CSS).toMatch(/--tk-reveal-shift:\s*1[0-6]px/);
        // Duration inside the brief's 400-600ms band.
        expect(CSS).toMatch(/--tk-reveal-duration:\s*(?:4\d\d|5\d\d)ms/);
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
