/**
 * ==========================================
 * DIRTY FORMS — REALTIME MUST NEVER ERASE TYPING
 * ==========================================
 *
 * The requirement is blunt: \"Realtime must NOT overwrite user input.\" Two signals implement it, and
 * both are asserted here because both are easy to get subtly wrong:
 *
 *   • the EXPLICIT one (a form that registers itself dirty), and
 *   • the HEURISTIC one (focus inside a control whose value a re-render would destroy).
 *
 * The heuristic is deliberately narrow, and the narrowness is the interesting part: a focused
 * checkbox or submit button is an instantaneous action with nothing to lose, so treating it as
 * \"editing\" would suppress legitimate refreshes on every list with an inline action. The tests below
 * pin both directions — what MUST defer, and what must not.
 */

import {
    anyGuardDirty,
    isEditingTarget,
    shouldHoldRefresh,
} from "@/lib/realtime/dirty-state";

describe("a focused editable control counts as unsaved work", () => {
    test("text-like inputs defer a refresh", () => {
        for (const type of ["text", "email", "password", "search", "number", "date", "tel", "url", undefined]) {
            expect(isEditingTarget({ tagName: "INPUT", type })).toBe(true);
        }
    });

    test("textareas, selects and contentEditable regions defer a refresh", () => {
        expect(isEditingTarget({ tagName: "TEXTAREA" })).toBe(true);
        expect(isEditingTarget({ tagName: "SELECT" })).toBe(true);
        expect(isEditingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    });

    test("instantaneous controls do NOT — they hold no unsaved state", () => {
        for (const type of ["checkbox", "radio", "submit", "button", "reset", "file", "image"]) {
            expect(isEditingTarget({ tagName: "INPUT", type })).toBe(false);
        }
    });

    test("a non-editable element is not editing", () => {
        expect(isEditingTarget(null)).toBe(false);
        expect(isEditingTarget(undefined)).toBe(false);
        expect(isEditingTarget({ tagName: "DIV" })).toBe(false);
        expect(isEditingTarget({ tagName: "BUTTON" })).toBe(false);
        expect(isEditingTarget({ tagName: "A" })).toBe(false);
        expect(isEditingTarget({ tagName: "BODY" })).toBe(false);
    });

    test("the decision does not depend on how the DOM parser cased the tag name", () => {
        expect(isEditingTarget({ tagName: "input", type: "TEXT" })).toBe(true);
        expect(isEditingTarget({ tagName: "textarea" })).toBe(true);
        expect(isEditingTarget({ tagName: "select" })).toBe(true);
    });
});

describe("the hold decision", () => {
    test("either signal holds the refresh — they are OR-ed, not AND-ed", () => {
        expect(shouldHoldRefresh({ focusEditing: true, formDirty: false })).toBe(true);
        expect(shouldHoldRefresh({ focusEditing: false, formDirty: true })).toBe(true);
        expect(shouldHoldRefresh({ focusEditing: true, formDirty: true })).toBe(true);
        expect(shouldHoldRefresh({ focusEditing: false, formDirty: false })).toBe(false);
    });

    test("a dirty form keeps protecting the user after they tab away to read something", () => {
        // The explicit signal outlives focus on purpose: that is exactly the moment a blind refresh
        // is most likely to hurt, because the user is no longer looking at the field.
        expect(shouldHoldRefresh({ focusEditing: false, formDirty: true })).toBe(true);
    });
});

describe("guarded forms", () => {
    test("one dirty guard is enough to hold", () => {
        expect(anyGuardDirty(new Map<number, boolean>())).toBe(false);
        expect(anyGuardDirty(new Map([[1, false]]))).toBe(false);
        expect(
            anyGuardDirty(
                new Map<number, boolean>([
                    [1, false],
                    [2, true],
                    [3, false],
                ])
            )
        ).toBe(true);
    });
});
