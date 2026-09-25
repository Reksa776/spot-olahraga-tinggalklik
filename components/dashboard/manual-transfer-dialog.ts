/**
 * ==========================================
 * MANUAL-TRANSFER DIALOG STATE (refunds + settlements)
 * ==========================================
 *
 * The refund and settlement dashboards used to ask the operator for a transfer reference,
 * an evidence note or a failure reason through `window.prompt`. This module is the decision
 * half of what replaced it: a tiny, pure state machine that both action components drive,
 * so the rules that matter (which fields a dialog needs, what "valid" means, what body the
 * API receives, that a second click while a request is in flight cannot start another one)
 * are stated once and tested without a DOM — matching the `lib/ticketing/ui` precedent.
 *
 * It is presentation only. Every rule here mirrors a server rule that still applies:
 *
 *   * a required field needs 3 characters after trimming (every `min(3)` on the reject,
 *     fail, settle and mark-paid schemas), and its maximum is the schema's own maximum;
 *   * an optional note rides along only when it is at least 3 characters — the `min(3)`
 *     the note schemas carry, so a 1–2 character note is omitted exactly as before;
 *   * nothing here decides a status, a role or an amount: the service does all of that,
 *     and an error from the API is surfaced verbatim inside the dialog.
 *
 * The dialog copy is operator-facing Indonesian, and the validation messages are the same
 * strings the components showed inline before, so nothing an operator reads has changed.
 */

export type ManualTransferField = "reference" | "note" | "reason";

export type ManualTransferDialogKind =
    | "reject"
    | "settle"
    | "fail"
    | "paid"
    | "settleFail";

export type ManualTransferInput = Partial<Record<ManualTransferField, string>>;

export type ManualTransferBody = Record<string, string>;

export type ManualTransferDefinition = {
    kind: ManualTransferDialogKind;
    /** The API action the dialog confirms — the POST segment under the row's id. */
    action: "reject" | "settle" | "fail" | "paid";
    title: string;
    description: string;
    fields: readonly ManualTransferField[];
    required: readonly ManualTransferField[];
    labels: Readonly<Partial<Record<ManualTransferField, string>>>;
    hints: Readonly<Partial<Record<ManualTransferField, string>>>;
    placeholders: Readonly<Partial<Record<ManualTransferField, string>>>;
    maxLengths: Readonly<Partial<Record<ManualTransferField, number>>>;
    errors: Readonly<Partial<Record<ManualTransferField, string>>>;
    confirmLabel: string;
    /** A final, irreversible decision is confirmed with the destructive button. */
    destructive: boolean;
};

const REFERENCE_MAX = 120;
const NOTE_MAX = 1000;
const REASON_MAX = 1000;
const SETTLEMENT_REASON_MAX = 500;

export const MANUAL_TRANSFER_DIALOGS: Readonly<
    Record<ManualTransferDialogKind, ManualTransferDefinition>
> = {
    reject: {
        kind: "reject",
        action: "reject",
        title: "Tolak permintaan refund ini?",
        description:
            "Permintaan refund ditolak dan tiket yang diklaim dilepaskan agar bisa diminta ulang. Alasan wajib diisi dan disimpan pada jejak audit.",
        fields: ["reason"],
        required: ["reason"],
        labels: { reason: "Alasan penolakan refund" },
        hints: {
            reason: "Wajib, minimal 3 karakter. Ditampilkan sebagai alasan penolakan.",
        },
        placeholders: { reason: "Contoh: pembelian tidak bisa diverifikasi" },
        maxLengths: { reason: REASON_MAX },
        errors: { reason: "Alasan penolakan minimal 3 karakter." },
        confirmLabel: "Tolak refund",
        destructive: true,
    },
    settle: {
        kind: "settle",
        action: "settle",
        title: "Catat transfer refund ini?",
        description:
            "Dana dianggap sudah dikembalikan dan refund menjadi REFUNDED — ini satu-satunya cara refund mencapai status tersebut. Referensi transfer wajib diisi; jumlah yang dicatat selalu dihitung server dari klaim yang tersimpan.",
        fields: ["reference", "note"],
        required: ["reference"],
        labels: {
            reference: "Nomor referensi transfer bank",
            note: "Catatan bukti transfer (opsional)",
        },
        hints: {
            reference: "Wajib, minimal 3 karakter.",
            note: "Opsional — bank pengirim, tanggal, nama penerima. Minimal 3 karakter.",
        },
        placeholders: {
            reference: "Contoh: TRX-20260925-00123",
            note: "Contoh: BCA 1234567890, 25 Sep 2026, atas nama Rina",
        },
        maxLengths: { reference: REFERENCE_MAX, note: NOTE_MAX },
        errors: {
            reference: "Nomor referensi transfer minimal 3 karakter.",
            note: "Catatan minimal 3 karakter atau kosongkan.",
        },
        confirmLabel: "Catat transfer",
        destructive: true,
    },
    fail: {
        kind: "fail",
        action: "fail",
        title: "Gagalkan transfer refund ini?",
        description:
            "Percobaan transfer yang tidak berhasil ditutup sebagai FAILED. Tidak ada uang yang bergerak; tiket yang diklaim dilepaskan agar permintaan yang diperbaiki bisa diajukan. Alasan wajib diisi.",
        fields: ["reason"],
        required: ["reason"],
        labels: { reason: "Alasan kegagalan transfer" },
        hints: {
            reason: "Wajib, minimal 3 karakter. Ditampilkan sebagai alasan kegagalan.",
        },
        placeholders: { reason: "Contoh: rekening tujuan salah" },
        maxLengths: { reason: REASON_MAX },
        errors: { reason: "Alasan kegagalan minimal 3 karakter." },
        confirmLabel: "Gagalkan transfer",
        destructive: true,
    },
    paid: {
        kind: "paid",
        action: "paid",
        title: "Tandai settlement ini dibayar?",
        description:
            "Dana dianggap sudah ditransfer keluar dan settlement menjadi PAID — satu-satunya sisi yang menggerakkan uang. Referensi transfer wajib diisi. Bukti transfer harus sudah diunggah.",
        fields: ["reference", "note"],
        required: ["reference"],
        labels: {
            reference: "Nomor referensi transfer bank",
            note: "Catatan transfer (opsional)",
        },
        hints: {
            reference: "Wajib, minimal 3 karakter.",
            note: "Opsional — bank pengirim, tanggal, nama penerima. Minimal 3 karakter.",
        },
        placeholders: {
            reference: "Contoh: TRX-20260925-00456",
            note: "Contoh: Mandiri 9876543210, 25 Sep 2026, PIC Dita",
        },
        maxLengths: { reference: REFERENCE_MAX, note: 2000 },
        errors: {
            reference: "Nomor referensi transfer minimal 3 karakter.",
            note: "Catatan minimal 3 karakter atau kosongkan.",
        },
        confirmLabel: "Tandai dibayar",
        destructive: true,
    },
    settleFail: {
        kind: "settleFail",
        action: "fail",
        title: "Gagalkan settlement ini?",
        description:
            "Klaim payout dilepaskan dan settlement menjadi FAILED agar dapat disiapkan ulang. Tidak ada uang yang bergerak. Alasan wajib diisi.",
        fields: ["reason"],
        required: ["reason"],
        labels: { reason: "Alasan kegagalan transfer" },
        hints: {
            reason: "Wajib, minimal 3 karakter. Ditimpan pada settlement dan jejak audit.",
        },
        placeholders: { reason: "Contoh: transfer ditolak bank" },
        maxLengths: { reason: SETTLEMENT_REASON_MAX },
        errors: { reason: "Alasan kegagalan minimal 3 karakter." },
        confirmLabel: "Gagalkan settlement",
        destructive: true,
    },
};

export const MIN_MANUAL_TRANSFER_LENGTH = 3;

export function getManualTransferDefinition(
    kind: ManualTransferDialogKind
): ManualTransferDefinition {
    return MANUAL_TRANSFER_DIALOGS[kind];
}

/**
 * The validation view of one dialog: the first invalid field's message, or `null` when
 * every required field is filled and every present optional field is long enough.
 */
export function manualTransferFieldError(
    definition: ManualTransferDefinition,
    input: ManualTransferInput
): string | null {
    for (const field of definition.required) {
        if ((input[field] ?? "").trim().length < MIN_MANUAL_TRANSFER_LENGTH) {
            return definition.errors[field] ?? "Wajib diisi.";
        }
    }

    for (const field of definition.fields) {
        if (definition.required.includes(field)) {
            continue;
        }

        const value = (input[field] ?? "").trim();

        if (value.length > 0 && value.length < MIN_MANUAL_TRANSFER_LENGTH) {
            return definition.errors[field] ?? "Minimal 3 karakter.";
        }
    }

    return null;
}

export function isManualTransferInputValid(
    definition: ManualTransferDefinition,
    input: ManualTransferInput
): boolean {
    return manualTransferFieldError(definition, input) === null;
}

/**
 * The exact JSON body the API receives: every value trimmed, the optional note present
 * only when it is 3+ characters, and the field names each route's schema declares
 * (`transferRef` for a refund, `providerReference` for a settlement).
 */
export function manualTransferBody(
    definition: ManualTransferDefinition,
    input: ManualTransferInput
): ManualTransferBody {
    const body: ManualTransferBody = {};
    const reference = (input.reference ?? "").trim();
    const note = (input.note ?? "").trim();
    const reason = (input.reason ?? "").trim();

    if (definition.action === "settle") {
        body.transferRef = reference;
    } else if (definition.action === "paid") {
        body.providerReference = reference;
    } else {
        body.reason = reason;
    }

    if (definition.fields.includes("note") && note.length >= MIN_MANUAL_TRANSFER_LENGTH) {
        body.note = note;
    }

    return body;
}

export type ManualTransferState = {
    openKind: ManualTransferDialogKind | null;
    input: ManualTransferInput;
    /** The action whose request is in flight, or `null`. */
    pending: string | null;
    /** The server's answer to the in-flight action, shown inside the dialog. */
    error: string | null;
    /** Whether an invalid value has been shown; errors appear on submit or on typing. */
    showErrors: boolean;
};

export const initialManualTransferState: ManualTransferState = {
    openKind: null,
    input: {},
    pending: null,
    error: null,
    showErrors: false,
};

export type ManualTransferAction =
    | { type: "open"; kind: ManualTransferDialogKind }
    | { type: "change"; field: ManualTransferField; value: string }
    | { type: "cancel" }
    | { type: "submit" }
    | { type: "completed"; action: string; ok: boolean; error?: string | null };

export type ManualTransferEffect =
    | {
          type: "start";
          kind: ManualTransferDialogKind;
          action: string;
          body: ManualTransferBody;
      }
    | { type: "finished"; action: string; ok: boolean };

/**
 * One step of the machine. Pure, total, and free of any request: a `start` effect is what
 * the component turns into a `fetch`, and a `completed` action is what it dispatches when
 * that fetch settles.
 */
export function manualTransferReducer(
    state: ManualTransferState,
    action: ManualTransferAction
): { state: ManualTransferState; effects: ManualTransferEffect[] } {
    switch (action.type) {
        case "open":
            return {
                state: {
                    openKind: action.kind,
                    input: initialManualTransferState.input,
                    pending: state.pending,
                    error: null,
                    showErrors: false,
                },
                effects: [],
            };

        case "change":
            return {
                state: {
                    ...state,
                    input: { ...state.input, [action.field]: action.value },
                    // Editing after a refusal clears that refusal: the stale server message
                    // must not sit next to a value the operator has since corrected.
                    error: null,
                    showErrors: true,
                },
                effects: [],
            };

        case "cancel":
            return {
                state: {
                    ...state,
                    openKind: null,
                    error: null,
                    showErrors: false,
                },
                effects: [],
            };

        case "submit": {
            // No dialog, a request already in flight (the double-click), or a different
            // action's request: never start a second one.
            if (state.openKind === null || state.pending !== null) {
                return { state, effects: [] };
            }

            const definition = getManualTransferDefinition(state.openKind);

            if (!isManualTransferInputValid(definition, state.input)) {
                return {
                    state: { ...state, showErrors: true },
                    effects: [],
                };
            }

            return {
                state: {
                    ...state,
                    pending: definition.action,
                    error: null,
                    showErrors: false,
                },
                effects: [
                    {
                        type: "start",
                        kind: definition.kind,
                        action: definition.action,
                        body: manualTransferBody(definition, state.input),
                    },
                ],
            };
        }

        case "completed": {
            // A late answer for an action that is no longer in flight is dropped whole: it
            // must not close whatever dialog is open now, nor clear an error the current
            // one is showing.
            if (state.pending !== action.action) {
                return { state, effects: [] };
            }

            if (action.ok) {
                return {
                    state: {
                        ...state,
                        openKind: null,
                        input: initialManualTransferState.input,
                        pending: null,
                        error: null,
                        showErrors: false,
                    },
                    effects: [{ type: "finished", action: action.action, ok: true }],
                };
            }

            // The dialog stays open on failure, with the server's message, so the
            // operator can correct the value and retry without retyping everything.
            return {
                state: {
                    ...state,
                    pending: null,
                    error: action.error ?? "Tindakan gagal.",
                    showErrors: true,
                },
                effects: [{ type: "finished", action: action.action, ok: false }],
            };
        }
    }
}
