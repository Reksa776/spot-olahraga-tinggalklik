"use client";

import { useEffect } from "react";

/**
 * ==========================================
 * REVEAL OBSERVER — ONE OBSERVER FOR THE PAGE
 * ==========================================
 *
 * `Reveal` (the server component) marks an element with `data-reveal-scroll` and an inline
 * `animation-delay`. That markup alone gets a SCROLL-LINKED entrance: the animation's progress is a
 * function of the scroll position (`animation-timeline: view()`), so its speed is the visitor's
 * scroll speed. That reads well for a tall block and badly for everything else — a heading, a tile
 * or a footer column is only ~40-100px tall, so its whole entry range passes inside a single wheel
 * notch and the movement is never actually seen. The page ends up looking static below the hero.
 *
 * This component replaces that with a ONE-SHOT, TIME-BASED entrance:
 *
 *   • It sets `data-reveal-armed` on `<html>`, which REMOVES the scroll-linked rule (that rule is
 *     scoped to `html:not([data-reveal-armed])`) and makes every element that is still waiting
 *     transparent.
 *   • When an element scrolls into view it gets `data-reveal-in`, which CREATES its entrance — a
 *     fresh animation at its own duration and its own inline delay — so the cascade is real
 *     elapsed time, identical for every visitor, and it plays exactly once.
 *   • Anything already on screen when we arm is marked `data-reveal-static` and never animates or
 *     hides. That is what makes arming invisible: the only elements we can hide are the ones that
 *     were off-screen a moment earlier.
 *
 * ── WHY IT CREATES AN ANIMATION AND NEVER UN-PAUSES ONE ─────────────────────────
 * The first version of this file did the obvious thing: it held every element at the first keyframe
 * with `animation-play-state: paused`, pointed its `animation-timeline` back at the document
 * (`auto`), and started each element by switching the play state to `running`. Measured in Chrome
 * 153, that combination resolves the start time of the resumed animation from the progress it had
 * on the OLD timeline — so "started" animations sat with a negative `currentTime` for a start time
 * that had been placed in the FUTURE: 1.6s ahead for the first element, growing by roughly one
 * frame per element in document order, 37s ahead for the last one. A heading reached full opacity
 * 4.7s after entering the viewport, most of a phone's sport grid never appeared, and the footer's
 * bottom line stayed invisible forever — which is exactly what "the page below the hero feels
 * static" looks like. See the note on section 2b of `app/globals.css`.
 *
 * Removing the pause removes the failure: nothing is ever resumed, so there is no progress to carry
 * over. This component's job is now purely to answer ONE question per element — "may it start now?"
 * — and the answer is a fresh animation starting on the next frame.
 *
 * ── WHY ONE OBSERVER AND NOT ONE PER ELEMENT ────────────────────────────────────
 * A single `IntersectionObserver` instance watches every target — that is what the API is for.
 * There is no scroll listener, no `requestAnimationFrame` loop, and no per-element observer. The
 * only other watch is a `MutationObserver`, needed because the App Router replaces the page subtree
 * on client-side navigation (and a Suspense boundary resolving adds nodes): without it, elements
 * rendered after the first arm would keep their paused state and never reveal. It scans only the
 * added nodes, never the document.
 *
 * ── IT IS ALL OPTIONAL ──────────────────────────────────────────────────────────
 * The CSS works without this file: `data-reveal-scroll` still carries the view-timeline entrance as
 * its no-JavaScript path, so a failed or blocked bundle leaves a page that reveals on scroll as
 * before — never a page with hidden content. Under `prefers-reduced-motion: reduce` the component
 * returns before arming anything, and the reduce block in `app/globals.css` is authoritative
 * regardless of what this component does.
 */

/** The step names the CSS understands, mirroring `[data-reveal-scroll="…"]`. */
const TARGET_SELECTOR =
    "[data-reveal-scroll]:not([data-reveal-in]):not([data-reveal-static])";

const ARMED_ATTRIBUTE = "data-reveal-armed";
const IN_ATTRIBUTE = "data-reveal-in";
const STATIC_ATTRIBUTE = "data-reveal-static";

/**
 * Where an element counts as "entering": a line this far above the bottom of the viewport, so a block
 * starts moving just before it is fully inside — early enough to be seen while the visitor is
 * scrolling it up the screen, late enough that it has not animated itself out by the time they look
 * at it.
 *
 * A LENGTH, DELIBERATELY NOT A PERCENTAGE. A percentage moves the line with the viewport height, and
 * the deepest block on a page can only ever be revealed if the line sits ABOVE where that block ends
 * up at maximum scroll — which for the footer's last line means a line less than its ~100px of bottom
 * padding and height above the end of the page. At `-10%` that held on a 900px-tall window and broke
 * at 1112px: the line was 111px above the bottom, the footer's small print could only reach 97px, and
 * it stayed at `opacity: 0` for the entire visit on a tablet. Whether a block can be reached is a
 * property of the LAYOUT below it, not of the visitor's window, so the margin is expressed the same
 * way the layout is: in pixels.
 */
const TRIGGER_BOTTOM_MARGIN = "-56px";

/**
 * The horizontal trigger, deliberately enormous: the event rows are horizontal snap scrollers on
 * phones, so the cards to the right of the viewport are off-screen but part of the SAME row. Waiting
 * for them to be swiped in would animate a card while the visitor is looking straight at it; a wide
 * margin reveals the whole row as one staggered group, which is the intended rhythm.
 */
const TRIGGER_SIDE_MARGIN_PX = 800;

/**
 * Anything already on screen when the observer arms is left completely alone: it is never hidden and
 * its entrance is never replayed, because there is at least one painted frame behind it and a visitor
 * would watch it blink out and come back.
 *
 * The line sits a little HIGHER up the viewport than the trigger above, so a block that is visible
 * but still below the trigger — the sliver just above the fold — is classified as static rather than
 * as "about to enter". Without that gap the two rules would disagree about exactly those elements.
 */
const ALREADY_VISIBLE_TOP_RATIO = 0.9;

export default function RevealObserver() {
    useEffect(() => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            return;
        }

        const root = document.documentElement;

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    /*
                     * The element is released when it crosses INTO the trigger band — or when it
                     * is already above the viewport, which is what a flick past a block looks like
                     * from here: the block goes from below the band to above the viewport between
                     * two frames and is never once reported as intersecting. Releasing it then
                     * costs nothing (it plays off-screen and is simply visible on the way back up)
                     * and is the difference between a block that was scrolled past and a block that
                     * would stay transparent for the rest of the visit.
                     */
                    if (!entry.isIntersecting && entry.boundingClientRect.top >= 0) {
                        continue;
                    }

                    entry.target.setAttribute(IN_ATTRIBUTE, "");
                    // Once it has played it is never observed again: the entrance is one-shot.
                    observer.unobserve(entry.target);
                }
            },
            {
                rootMargin: `0px ${TRIGGER_SIDE_MARGIN_PX}px ${TRIGGER_BOTTOM_MARGIN} ${TRIGGER_SIDE_MARGIN_PX}px`,
                threshold: 0,
            }
        );

        const arm = (element: Element) => {
            if (
                element.hasAttribute(IN_ATTRIBUTE) ||
                element.hasAttribute(STATIC_ATTRIBUTE)
            ) {
                return;
            }

            const rect = element.getBoundingClientRect();
            const belowFold = rect.top > window.innerHeight * ALREADY_VISIBLE_TOP_RATIO;
            /*
             * A zero-size element can never intersect, so it would be held hidden forever. It is
             * not visible either way, but marking it static means it reveals itself the moment the
             * layout gives it a box (a responsive breakpoint, an image arriving) instead of
             * depending on a later intersection notification.
             */
            const hasBox = rect.width > 0 || rect.height > 0;

            if (belowFold && hasBox) {
                observer.observe(element);
                return;
            }

            element.setAttribute(STATIC_ATTRIBUTE, "");
        };

        const scan = (scope: ParentNode) => {
            scope.querySelectorAll(TARGET_SELECTOR).forEach(arm);
        };

        /*
         * Everything currently on the page is classified BEFORE the armed attribute exists, so the
         * classify pass never sees a paused (hidden) element.
         */
        scan(document);
        root.setAttribute(ARMED_ATTRIBUTE, "");

        const mutations = new MutationObserver((records) => {
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (!(node instanceof Element)) {
                        continue;
                    }

                    if (node.matches(TARGET_SELECTOR)) {
                        arm(node);
                    }

                    scan(node);
                }
            }
        });

        mutations.observe(document.body, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            mutations.disconnect();
            /*
             * Disarming on teardown is the safe half of the contract: if this component ever goes
             * away while an un-revealed element is still in the DOM, dropping the attribute restores
             * that element to its visible default instead of stranding it hidden.
             */
            root.removeAttribute(ARMED_ATTRIBUTE);
        };
    }, []);

    return null;
}
