/**
 * ==========================================
 * DIRTY STATE — WHAT "THE USER IS EDITING" MEANS
 * ==========================================
 *
 * The single most damaging thing a realtime mechanism can do to a back office is erase half-typed
 * work. A payment landing in another tab must not replace the event title an operator is halfway
 * through writing.
 *
 * There are two signals, and they are deliberately different in kind:
 *
 *   1. A REGISTERED DIRTY FORM (`useRealtimeFormGuard(true)`). Exact, opt-in, and used where a form
 *      holds real unsaved state — an event editor, a settings dialog. This is the honest signal.
 *
 *   2. FOCUS INSIDE AN EDITABLE CONTROL. A heuristic, and it exists because the exact signal is
 *      unavailable for every input in the product: a search field, a filter, a native `<select>`,
 *      a `contentEditable` cell. Focused typing is, in practice, unsaved work — and a refresh
 *      replaces a `<select>`'s value and blows away an inline filter just as surely as it replaces
 *      a form field.
 *
 * The heuristic is intentionally PESSIMISTIC: it defers a refresh (and shows a banner the user can
 * act on) rather than risking the loss of input. A deferred refresh is never a lost refresh — it is
 * applied the moment the user's hands leave the keyboard, or immediately when they ask for it.
 *
 * It is also deliberately narrow. Checkboxes, radio buttons and submit controls are EXCLUDED:
 * clicking those is an instantaneous action with no unsaved state, and treating a focused radio as
 * "editing" would suppress legitimate refreshes on every list with an inline action.
 */

/** The subset of an element this decision needs. Structural, so a test needs no DOM. */
export type FocusTargetShape = {
    tagName?: string;
    isContentEditable?: boolean;
    type?: string;
};

/** Input types whose value is instantaneous rather than typed, so they are not "editing". */
const INSTANT_INPUT_TYPES: ReadonlySet<string> = new Set([
    "button",
    "submit",
    "reset",
    "image",
    "checkbox",
    "radio",
    "file",
]);

/**
 * Is the user's focus sitting in a control whose value a re-render could destroy?
 *
 * Tags are compared case-insensitively because `tagName` is uppercase in HTML documents and
 * lowercase in XHTML/SVG contexts; the decision must not depend on which parser produced the node.
 */
export function isEditingTarget(target: FocusTargetShape | null | undefined): boolean {
    if (!target) {
        return false;
    }

    if (target.isContentEditable) {
        return true;
    }

    const tag = (target.tagName ?? "").toUpperCase();

    if (tag === "TEXTAREA" || tag === "SELECT") {
        return true;
    }

    if (tag === "INPUT") {
        return !INSTANT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
    }

    return false;
}

/**
 * Should an automatic refresh be held right now?
 *
 * `focusEditing` and `formDirty` are OR-ed on purpose: an explicit dirty form keeps protecting the
 * user even after they tab away to read something, which is exactly when a blind refresh is most
 * likely to hurt.
 */
export function shouldHoldRefresh(input: {
    focusEditing: boolean;
    formDirty: boolean;
}): boolean {
    return input.focusEditing || input.formDirty;
}

/** True when at least one registered guard reports unsaved work. */
export function anyGuardDirty(guards: ReadonlyMap<number | string, boolean>): boolean {
    for (const dirty of guards.values()) {
        if (dirty) {
            return true;
        }
    }

    return false;
}
