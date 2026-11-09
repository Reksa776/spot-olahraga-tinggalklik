/**
 * Operator-facing copy for the WhatsApp gateway.
 *
 * This module is intentionally pure: the API uses it to add `userMessage`, and the
 * dashboard uses the same text when it receives a status snapshot from an older
 * server that predates those fields. Keeping one mapping prevents the API and the
 * panel from describing the same state differently.
 */

export type WhatsAppUserMessageLevel =
    | "success"
    | "info"
    | "warning"
    | "error";

export type WhatsAppStatusCopy = {
    userMessage: string;
    userMessageLevel: WhatsAppUserMessageLevel;
    userMessageDetail: string;
};

const CONNECTED: WhatsAppStatusCopy = {
    userMessage: "WhatsApp terhubung",
    userMessageLevel: "success",
    userMessageDetail: "Pesan otomatis aktif.",
};

const CONNECTING: WhatsAppStatusCopy = {
    userMessage: "Menghubungkan…",
    userMessageLevel: "info",
    userMessageDetail: "Menyiapkan koneksi WhatsApp, tunggu sebentar.",
};

const MANUAL: WhatsAppStatusCopy = {
    userMessage: "WhatsApp terputus",
    userMessageLevel: "info",
    userMessageDetail:
        "Klik 'Hubungkan WhatsApp' untuk scan QR dan mengaktifkan kembali.",
};

const DISCONNECTED: WhatsAppStatusCopy = {
    userMessage: "WhatsApp tidak terhubung",
    userMessageLevel: "warning",
    userMessageDetail:
        "Koneksi terputus. Klik 'Hubungkan WhatsApp' untuk menyambungkan ulang.",
};

const CONFLICT: WhatsAppStatusCopy = {
    userMessage: "Koneksi sedang dipakai proses lain",
    userMessageLevel: "warning",
    userMessageDetail:
        "Tutup tab/dashboard lain yang membuka halaman ini, atau tunggu beberapa saat lalu coba lagi.",
};

const CONFLICT_STALE: WhatsAppStatusCopy = {
    userMessage: "Koneksi tersangkut",
    userMessageLevel: "error",
    userMessageDetail: "Klik 'Perbaiki koneksi' untuk membersihkan.",
};

const NEEDS_ATTENTION: WhatsAppStatusCopy = {
    userMessage: "WhatsApp butuh perhatian",
    userMessageLevel: "error",
    userMessageDetail:
        "Terjadi masalah pada koneksi WhatsApp. Klik 'Hubungkan WhatsApp' untuk scan ulang QR.",
};

export function getWhatsAppStatusCopy(options: {
    state: string;
    manualDisconnect?: boolean;
    stale?: boolean;
}): WhatsAppStatusCopy {
    const state = options.state.trim().toUpperCase();

    // The persisted latch always wins over a stale in-memory socket snapshot.
    if (options.manualDisconnect || state === "MANUAL_DISCONNECT") {
        return MANUAL;
    }

    if (state === "CONFLICT") {
        return options.stale ? CONFLICT_STALE : CONFLICT;
    }

    if (state === "CONNECTED") {
        return CONNECTED;
    }

    if (
        state === "STARTING" ||
        state === "PAIRING" ||
        state === "PAIRING_REQUIRED"
    ) {
        return CONNECTING;
    }

    if (state === "DISCONNECTED" || state === "STOPPED") {
        return DISCONNECTED;
    }

    if (
        state === "ERROR" ||
        state === "LOGGED_OUT" ||
        state === "UNAVAILABLE" ||
        state === "NEEDS_REPAIR"
    ) {
        return NEEDS_ATTENTION;
    }

    // Unknown or not-yet-loaded states stay actionable instead of showing raw
    // internals to the operator.
    return NEEDS_ATTENTION;
}
