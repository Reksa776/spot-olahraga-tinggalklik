"use client";

import { useId, useState } from "react";
import { FaEye, FaEyeSlash, FaLock } from "react-icons/fa";

/**
 * ==========================================
 * PASSWORD FIELD
 * ==========================================
 *
 * A password input with a visibility toggle. Extracted because three screens needed one
 * (login, registration, confirmation) and each had hand-rolled a slightly different version —
 * including two toggles that were icon-only buttons with no accessible name at all.
 *
 * ── TWO WAYS TO USE IT, AND WHY BOTH EXIST ──────────────────────────────────────
 *   1. **Controlled** (`value` + `onChange`) — the login form, which keeps two pieces of
 *      plain React state and nothing else. Simple, and the value never leaves the component
 *      tree.
 *   2. **Registered** (`registration`) — the registration form, which uses react-hook-form.
 *      RHF's field props (`name`, `onChange`, `onBlur`, `ref`) are spread straight onto the
 *      DOM input, so the value lives in an uncontrolled input that RHF reads and validates.
 *
 * The second mode is not a nicety. A registration form that renders a *controlled* styled
 * field while validating an *uncontrolled* hidden one collects nothing: the visible field's
 * onChange is a no-op, so the password is always empty by the time validation runs. Spreading
 * the real registration props onto the real input is what makes one control both visible and
 * authoritative — no twin inputs, no hidden mirror.
 *
 * ── WHY THE TOGGLE IS `aria-pressed`, NOT JUST AN ICON ──────────────────────────
 * A bare eye icon announces as "button" and nothing else. The button carries a label
 * ("Tampilkan password" / "Sembunyikan password"), `aria-pressed` for its state and
 * `aria-controls` pointing at the input, so it is usable without sight.
 *
 * It is `type="button"`: inside a form a bare `<button>` submits, so leaving the type off
 * would make "reveal my password" also mean "submit the sign-up form".
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────
 * It never touches the value: no trimming, no transformation, no "helpful" lowercasing. A
 * password is opaque bytes and the server compares exactly what was typed. `autoComplete` is
 * passed through, so password managers see `current-password` on login and `new-password` on
 * registration.
 */
export function PasswordField({
    label,
    value,
    onChange,
    registration,
    disabled = false,
    autoComplete,
    error,
    placeholder,
    autoFocus = false,
    /** Rendered as a quiet hint under the field when there is no error. */
    hint,
}: {
    label: string;
    /** Controlled mode. Omit when using `registration`. */
    value?: string;
    /** Controlled mode. Omit when using `registration`. */
    onChange?: (value: string) => void;
    /**
     * react-hook-form's `register(name)` result, spread onto the input. Use this OR
     * `value`/`onChange`, never both.
     */
    registration?: Record<string, unknown>;
    disabled?: boolean;
    autoComplete?: string;
    /** Inline validation message, wired via `aria-describedby`. */
    error?: string;
    placeholder?: string;
    autoFocus?: boolean;
    hint?: string;
}) {
    const reactId = useId();
    const inputId = `password-${reactId}`;
    const errorId = `${inputId}-error`;
    const hintId = `${inputId}-hint`;

    const [visible, setVisible] = useState(false);

    const toggleLabel = visible ? "Sembunyikan password" : "Tampilkan password";
    const describedBy = error ? errorId : hint ? hintId : undefined;

    return (
        <div>
            <label
                htmlFor={inputId}
                className="mb-2 block text-sm font-semibold text-ink-700"
            >
                {label}
            </label>

            <div className="relative">
                <FaLock
                    size={16}
                    aria-hidden
                    className="absolute top-1/2 left-4 -translate-y-1/2 text-ink-400"
                />

                <input
                    id={inputId}
                    /*
                     * The controlled props come FIRST so that `registration` (which carries the
                     * authoritative `name`/`onChange`/`ref`) is what wins in registered mode,
                     * and so the two modes can never partially override each other.
                     */
                    {...(onChange
                        ? {
                              value: value ?? "",
                              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                                  onChange(event.target.value),
                          }
                        : null)}
                    {...registration}
                    type={visible ? "text" : "password"}
                    placeholder={placeholder ?? "Masukkan password"}
                    disabled={disabled}
                    autoComplete={autoComplete}
                    autoFocus={autoFocus}
                    // `aria-invalid` + `aria-describedby` are what make an inline error an
                    // ACTUAL error to a screen reader rather than a coloured paragraph.
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy}
                    className={
                        error
                            ? "h-12 w-full rounded-xl border border-ink-300 bg-white pr-12 pl-11 text-[15px] text-ink-900 placeholder:text-ink-400 focus:border-brand-600 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
                            : "h-12 w-full rounded-xl border border-ink-200 bg-white pr-12 pl-11 text-[15px] text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
                    }
                />

                <button
                    type="button"
                    onClick={() => setVisible((current) => !current)}
                    disabled={disabled}
                    aria-pressed={visible}
                    aria-controls={inputId}
                    aria-label={toggleLabel}
                    title={toggleLabel}
                    className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded-lg p-2 text-ink-500 transition hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600 disabled:cursor-not-allowed"
                >
                    {visible ? <FaEyeSlash aria-hidden /> : <FaEye aria-hidden />}
                </button>
            </div>

            {error ? (
                <p id={errorId} role="alert" className="mt-1.5 text-xs text-ink-600">
                    {error}
                </p>
            ) : hint ? (
                <p id={hintId} className="mt-1.5 text-xs text-ink-400">
                    {hint}
                </p>
            ) : null}
        </div>
    );
}

export default PasswordField;
