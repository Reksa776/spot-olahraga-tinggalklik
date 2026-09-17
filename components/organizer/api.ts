"use client";

/**
 * ==========================================
 * CLIENT API HELPER
 * ==========================================
 *
 * Unwraps the ticketing envelope (design §25.0) for the organizer UI.
 *
 * Two deliberate behaviours:
 *
 * 1. It never sends an `organizerId` unless the caller passes one as data. There is no
 *    implicit "current organizer" header or cookie, so the client cannot influence
 *    which tenant a request targets beyond naming it — and the server re-authorizes
 *    every named value.
 * 2. It surfaces the server's `message` (Indonesian, user-facing) rather than a status
 *    code, so a refusal reads as the API phrased it — including the publish
 *    precondition list from `details`.
 *
 * No credentials are handled here: the session cookie is sent by the browser because
 * the request is same-origin, and CSRF is enforced server-side by the origin check.
 */

export type ApiEnvelope<T> = {
    success: boolean;
    data?: T;
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
};

export class ClientApiError extends Error {
    readonly code: string;
    readonly details?: Record<string, unknown>;

    constructor(code: string, message: string, details?: Record<string, unknown>) {
        super(message);
        this.name = "ClientApiError";
        this.code = code;
        this.details = details;
    }
}

export async function apiFetch<T>(
    path: string,
    init: RequestInit = {}
): Promise<T> {
    const isFormData =
        typeof FormData !== "undefined" && init.body instanceof FormData;

    const response = await fetch(path, {
        ...init,
        headers: {
            ...(isFormData ? {} : { "Content-Type": "application/json" }),
            ...(init.headers ?? {}),
        },
    });

    const body = (await response.json().catch(() => null)) as
        | ApiEnvelope<T>
        | null;

    if (!response.ok || !body?.success) {
        throw new ClientApiError(
            body?.code ?? "INTERNAL_ERROR",
            body?.message ?? "Terjadi kesalahan.",
            body?.details
        );
    }

    return body.data as T;
}

/** Flatten an `AppError`'s `details.preconditions` into a readable string. */
export function preconditionsFrom(error: unknown): string[] {
    if (!(error instanceof ClientApiError)) {
        return [];
    }

    const value = error.details?.preconditions;

    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}
