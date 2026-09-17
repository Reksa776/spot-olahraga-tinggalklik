"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from "react";

/* ==========================================
 * TYPES
 * ========================================== */

type DialogType = "alert" | "confirm" | "prompt";

interface DialogState {
    open: boolean;
    type: DialogType;
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    variant: "danger" | "warning" | "info";
    inputValue: string;
    inputPlaceholder: string;
    inputRequired: boolean;
    resolve: ((value: boolean | string | null) => void) | null;
}

interface DialogContextValue {
    alert: (opts: {
        title?: string;
        message: string;
        variant?: "danger" | "warning" | "info";
        confirmText?: string;
    }) => Promise<void>;
    confirm: (opts: {
        title?: string;
        message: string;
        variant?: "danger" | "warning" | "info";
        confirmText?: string;
        cancelText?: string;
    }) => Promise<boolean>;
    prompt: (opts: {
        title?: string;
        message: string;
        placeholder?: string;
        defaultValue?: string;
        required?: boolean;
        variant?: "danger" | "warning" | "info";
        confirmText?: string;
        cancelText?: string;
    }) => Promise<string | null>;
}

/* ==========================================
 * CONTEXT
 * ========================================== */

const DialogContext = createContext<DialogContextValue | null>(null);

const initialState: DialogState = {
    open: false,
    type: "confirm",
    title: "",
    message: "",
    confirmText: "Ya",
    cancelText: "Batal",
    variant: "warning",
    inputValue: "",
    inputPlaceholder: "",
    inputRequired: false,
    resolve: null,
};

/* ==========================================
 * PROVIDER
 * ========================================== */

export function DialogProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<DialogState>(initialState);
    const inputRef = useRef<HTMLInputElement>(null);
    const cancelRef = useRef<HTMLButtonElement>(null);
    const backdropRef = useRef<HTMLDivElement>(null);

    // Focus management: focus input or confirm button when dialog opens
    useEffect(() => {
        if (state.open) {
            // Small delay to ensure DOM is ready
            const timer = setTimeout(() => {
                if (state.type === "prompt" && inputRef.current) {
                    inputRef.current.focus();
                    inputRef.current.select();
                } else if (cancelRef.current) {
                    cancelRef.current.focus();
                }
            }, 50);
            return () => clearTimeout(timer);
        }
    }, [state.open, state.type]);

    // Escape key handler
    useEffect(() => {
        if (!state.open) return;

        function handleKeyDown(e: KeyboardEvent) {
            if (e.key === "Escape") {
                e.preventDefault();
                handleCancel();
            }
        }

        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [state.open, state.resolve]);

    // Prevent body scroll when dialog is open
    useEffect(() => {
        if (state.open) {
            document.body.style.overflow = "hidden";
            return () => {
                document.body.style.overflow = "";
            };
        }
    }, [state.open]);

    const resolve = state.resolve;

    const handleConfirm = useCallback(() => {
        if (!resolve) return;

        if (state.type === "prompt") {
            if (state.inputRequired && !state.inputValue.trim()) {
                // Don't close — let user enter a value
                return;
            }
            resolve(state.inputValue || null);
        } else {
            resolve(true);
        }
        setState(initialState);
    }, [resolve, state.type, state.inputValue, state.inputRequired]);

    const handleCancel = useCallback(() => {
        if (!resolve) return;
        resolve(state.type === "prompt" ? null : false);
        setState(initialState);
    }, [resolve, state.type]);

    const handleBackdropClick = useCallback(
        (e: React.MouseEvent) => {
            if (e.target === backdropRef.current) {
                handleCancel();
            }
        },
        [handleCancel]
    );

    const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        setState((prev) => ({ ...prev, inputValue: e.target.value }));
    }, []);

    const handleInputKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                handleConfirm();
            }
        },
        [handleConfirm]
    );

    const openDialog = useCallback(
        (
            type: DialogType,
            opts: {
                title?: string;
                message: string;
                confirmText?: string;
                cancelText?: string;
                variant?: "danger" | "warning" | "info";
                placeholder?: string;
                defaultValue?: string;
                inputRequired?: boolean;
            }
        ): Promise<boolean | string | null> => {
            return new Promise((res) => {
                setState({
                    open: true,
                    type,
                    title:
                        opts.title ||
                        (type === "alert"
                            ? "Informasi"
                            : type === "confirm"
                              ? "Konfirmasi"
                              : "Masukkan Data"),
                    message: opts.message,
                    confirmText: opts.confirmText || (type === "alert" ? "OK" : "Ya"),
                    cancelText: opts.cancelText || "Batal",
                    variant: opts.variant || "warning",
                    inputValue: opts.defaultValue || "",
                    inputPlaceholder: opts.placeholder || "",
                    inputRequired: opts.inputRequired || false,
                    resolve: res,
                });
            });
        },
        []
    );

    const ctx = useMemo<DialogContextValue>(
        () => ({
            alert: async (opts) => {
                await openDialog("alert", {
                    ...opts,
                    confirmText: opts.confirmText || "OK",
                });
            },
            confirm: (opts) =>
                openDialog("confirm", opts) as Promise<boolean>,
            prompt: (opts) =>
                openDialog("prompt", {
                    ...opts,
                    placeholder: opts.placeholder,
                    defaultValue: opts.defaultValue,
                    inputRequired: opts.required,
                }) as Promise<string | null>,
        }),
        [openDialog]
    );

    /* ==========================================
     * VARIANT STYLES
     * ========================================== */

    const variantStyles = {
        danger: {
            icon: "🗑️",
            iconBg: "bg-red-100",
            confirmBtn:
                "bg-red-600 hover:bg-red-700 focus:ring-red-500 text-white",
        },
        warning: {
            icon: "⚠️",
            iconBg: "bg-amber-100",
            confirmBtn:
                "bg-amber-600 hover:bg-amber-700 focus:ring-amber-500 text-white",
        },
        info: {
            icon: "ℹ️",
            iconBg: "bg-blue-100",
            confirmBtn:
                "bg-blue-600 hover:bg-blue-700 focus:ring-blue-500 text-white",
        },
    };

    const vs = variantStyles[state.variant];

    return (
        <DialogContext.Provider value={ctx}>
            {children}

            {/* DIALOG MODAL — only renders when open */}
            {state.open && (
                <div
                    ref={backdropRef}
                    onClick={handleBackdropClick}
                    className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="dialog-title"
                    aria-describedby="dialog-message"
                >
                    <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl">
                        {/* HEADER */}
                        <div className="flex items-start gap-4 p-6 pb-0">
                            <div
                                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${vs.iconBg}`}
                            >
                                <span className="text-lg">{vs.icon}</span>
                            </div>
                            <div className="min-w-0 flex-1">
                                <h2
                                    id="dialog-title"
                                    className="text-base font-semibold text-gray-900"
                                >
                                    {state.title}
                                </h2>
                                <p
                                    id="dialog-message"
                                    className="mt-1 text-sm text-gray-600"
                                >
                                    {state.message}
                                </p>
                            </div>
                        </div>

                        {/* INPUT (prompt only) */}
                        {state.type === "prompt" && (
                            <div className="px-6 pt-4">
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={state.inputValue}
                                    onChange={handleInputChange}
                                    onKeyDown={handleInputKeyDown}
                                    placeholder={state.inputPlaceholder}
                                    className="w-full rounded-xl border border-gray-300 px-4 py-2.5 text-sm text-gray-900 placeholder-gray-400 transition focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                                />
                            </div>
                        )}

                        {/* BUTTONS */}
                        <div className="flex justify-end gap-3 p-6 pt-4">
                            <button
                                ref={cancelRef}
                                type="button"
                                onClick={handleCancel}
                                className={`rounded-xl px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 ${state.type === "alert" ? vs.confirmBtn : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50 focus:ring-gray-400"}`}
                            >
                                {state.type === "alert" ? state.confirmText : state.cancelText}
                            </button>
                            {state.type !== "alert" && (
                                <button
                                    type="button"
                                    onClick={handleConfirm}
                                    className={`rounded-xl px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 ${vs.confirmBtn}`}
                                >
                                    {state.confirmText}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </DialogContext.Provider>
    );
}

/* ==========================================
 * HOOK
 * ========================================== */

export function useDialog(): DialogContextValue {
    const ctx = useContext(DialogContext);
    if (!ctx) {
        // During SSR/SSG, context may be null because client components
        // are rendered without the full provider tree. Return a fallback
        // that opens native browser dialogs as a safety net.
        // On the client, DialogProvider provides the real context.
        if (typeof window === "undefined") {
            return {
                alert: async (opts) => {
                    window.alert(opts.message);
                },
                confirm: async (opts) => {
                    return window.confirm(opts.message);
                },
                prompt: async (opts) => {
                    return window.prompt(opts.message, opts.defaultValue);
                },
            };
        }
        // On the client, this means DialogProvider is missing — error clearly
        console.error(
            "useDialog() called on client but DialogContext is null. " +
                "Ensure <DialogProvider> wraps this component in app/layout.tsx."
        );
        return {
            alert: async () => {},
            confirm: async () => false,
            prompt: async () => null,
        };
    }
    return ctx;
}
