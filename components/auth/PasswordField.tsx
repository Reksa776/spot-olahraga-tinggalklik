"use client";

import { useId, useState } from "react";

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
                <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-ink-400"
                >
                    <rect width="18" height="11" x="3" y="11" rx="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>

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
                            ? "h-12 w-full rounded-xl border border-ink-300 bg-white pr-12 pl-11 text-[15px] text-ink-900 transition-[border-color,box-shadow] duration-150 placeholder:text-ink-400 focus:border-brand-600 focus:ring-4 focus:ring-brand-600/15 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
                            : "h-12 w-full rounded-xl border border-ink-200 bg-white pr-12 pl-11 text-[15px] text-ink-900 transition-[border-color,box-shadow] duration-150 placeholder:text-ink-400 focus:border-brand-500 focus:ring-4 focus:ring-brand-500/15 focus:outline-none disabled:cursor-not-allowed disabled:bg-ink-50"
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
                    {visible ? (
                        <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-4 w-4"
                        >
                            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                            <path d="m1 1 22 22" />
                            <path d="M9.88 14.88a3 3 0 1 1 4.24-4.24" />
                        </svg>
                    ) : (
                        <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.8"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="h-4 w-4"
                        >
                            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
                            <circle cx="12" cy="12" r="3" />
                        </svg>
                    )}
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
