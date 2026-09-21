"use client";

import {
    LOGIN_ROLE_INTENTS,
    LOGIN_ROLE_INTENT_META,
    type LoginRoleIntent,
} from "@/lib/auth/roles";

/**
 * ==========================================
 * ROLE SELECTOR — UI INTENT ONLY
 * ==========================================
 *
 * Four entrances to ONE authentication system. Each chip changes what the page says and
 * where a successful login is sent; none of them is sent to the server, and none of them
 * can make the account they sign into anything other than what the database says it is.
 *
 * ── WHY A RADIO GROUP AND NOT FOUR TABS ─────────────────────────────────────────
 * It IS a radio group, rendered as segmented buttons: `role="radiogroup"` with
 * `role="radio"` children and roving focus, so a screen reader announces "Admin, radio
 * button, 1 of 4" and arrow keys move between the options. Four `<button>` elements that
 * merely look selected announce nothing about which one is chosen.
 *
 * It is not a tab list because there are no panels to swap: the same three fields serve all
 * four roles, and pretending otherwise would add a second navigation model to a form.
 *
 * ── WHY THE CHIPS ARE NOT THE SUBMIT BUTTONS ────────────────────────────────────
 * Picking an entrance must never sign anyone in. `type="button"` on every chip guarantees a
 * chip can only ever call `onChange`, which is why a stray Enter keypress cannot submit the
 * form with a half-filled password.
 */
export function RoleSelector({
    value,
    onChange,
    disabled = false,
    id = "login-role",
}: {
    value: LoginRoleIntent;
    onChange: (intent: LoginRoleIntent) => void;
    disabled?: boolean;
    /** Shared id prefix, so the label and the group stay associated. */
    id?: string;
}) {
    const meta = LOGIN_ROLE_INTENT_META[value];

    function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const index = LOGIN_ROLE_INTENTS.indexOf(value);
        const last = LOGIN_ROLE_INTENTS.length - 1;

        // Roving focus: Left/Right wrap, Home/End jump to the ends. These are the keys a
        // native radio group responds to, which is the behaviour the roles promise.
        let next: number | null = null;

        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            next = index === last ? 0 : index + 1;
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            next = index === 0 ? last : index - 1;
        } else if (event.key === "Home") {
            next = 0;
        } else if (event.key === "End") {
            next = last;
        }

        if (next === null) {
            return;
        }

        event.preventDefault();
        onChange(LOGIN_ROLE_INTENTS[next]);
    }

    return (
        <div className="space-y-3">
            <div
                id={id}
                role="radiogroup"
                aria-label="Masuk sebagai"
                onKeyDown={handleKeyDown}
                className="grid grid-cols-4 gap-1.5 rounded-2xl bg-ink-100/70 p-1.5"
            >
                {LOGIN_ROLE_INTENTS.map((intent) => {
                    const active = intent === value;

                    return (
                        <button
                            key={intent}
                            type="button"
                            role="radio"
                            aria-checked={active}
                            // Only the selected chip is in the tab order; the arrow keys
                            // move within the group. Without this, tabbing through a four
                            // option group costs four stops.
                            tabIndex={active ? 0 : -1}
                            disabled={disabled}
                            onClick={() => onChange(intent)}
                            className={
                                active
                                    ? "rounded-xl bg-white px-2 py-2.5 text-sm font-bold text-ink-900 shadow-sm ring-1 ring-ink-200 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed"
                                    : "rounded-xl px-2 py-2.5 text-sm font-semibold text-ink-500 transition hover:text-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed"
                            }
                        >
                            {LOGIN_ROLE_INTENT_META[intent].label}
                        </button>
                    );
                })}
            </div>

            {/*
             * The caption is `aria-live="polite"`: changing entrance changes what the form
             * is for, and a sighted user sees that instantly. A screen reader user would
             * otherwise get no signal at all that anything happened.
             */}
            <p
                aria-live="polite"
                className="px-1 text-center text-xs leading-relaxed text-ink-500"
            >
                {meta.caption}
            </p>
        </div>
    );
}

export default RoleSelector;
