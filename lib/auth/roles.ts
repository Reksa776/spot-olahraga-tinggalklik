import type { PlatformRole } from "@prisma/client";

/**
 * ==========================================
 * LOGIN ROLE INTENT
 * ==========================================
 *
 * The four platform roles, as a PRESENTATIONAL vocabulary for the login screen.
 *
 * ── THE ONE THING THIS MODULE IS NOT ────────────────────────────────────────────
 * It is not an authority. Nothing here is sent to the server, stored in a session, or read
 * by any authorization decision. A visitor may click "Admin" and type customer credentials;
 * they will be authenticated as whatever the database says they are, and the destination
 * below is a HINT that the next page's own server-side gate immediately overrules.
 *
 * That is the whole design of the role selector: it exists because four different people
 * land on the same login page and each of them should recognise their own entrance, not
 * because the client gets a say in who it is. The risk this avoids is specific — a form
 * that posts `role: "ADMIN"` and a server that believes it — and the mitigation is
 * structural: `LOGIN_ROLE_INTENTS` never leaves the browser.
 *
 * ── WHY THE DESTINATIONS ARE PATHS AND NOT "ALLOW CLIENT IN" ────────────────────
 * Each destination is a page that re-authenticates and re-authorises on the server:
 *
 *   ADMIN / MANAGER → /dashboard       (`app/dashboard/layout.tsx` gates on real capabilities)
 *   PIC             → /dashboard/pic   (gated by the same layout, then by the PIC service)
 *   CUSTOMER        → /ticketing/tickets (ownership predicate + `ticket.read.own`)
 *
 * So an intent can only ever move a browser; it cannot widen what that browser may see.
 */

export const LOGIN_ROLE_INTENTS = [
    "ADMIN",
    "MANAGER",
    "PIC",
    "CUSTOMER",
] as const;

export type LoginRoleIntent = (typeof LOGIN_ROLE_INTENTS)[number];

/** The default when no intent has been chosen: the buyer, who is the majority visitor. */
export const DEFAULT_LOGIN_ROLE_INTENT: LoginRoleIntent = "CUSTOMER";

export type LoginRoleIntentMeta = {
    /** Chip label. Short, because four of these sit in one row on a phone. */
    label: string;
    /** One line of "who is this for", shown under the selector. */
    caption: string;
    /** Where this entrance leads, absent a `callbackUrl`. Validated again before use. */
    destination: string;
};

export const LOGIN_ROLE_INTENT_META: Record<LoginRoleIntent, LoginRoleIntentMeta> = {
    ADMIN: {
        label: "Admin",
        caption: "Masuk sebagai administrator platform.",
        destination: "/dashboard",
    },
    MANAGER: {
        label: "Manajer",
        caption: "Masuk sebagai manajer penyelenggara.",
        destination: "/dashboard",
    },
    PIC: {
        label: "PIC",
        caption: "Masuk untuk melihat penugasan dan fee Anda.",
        destination: "/dashboard/pic",
    },
    CUSTOMER: {
        label: "Pembeli",
        caption: "Masuk untuk melihat pesanan dan e-tiket Anda.",
        destination: "/ticketing/tickets",
    },
};

export function isLoginRoleIntent(value: unknown): value is LoginRoleIntent {
    return (
        typeof value === "string" &&
        (LOGIN_ROLE_INTENTS as readonly string[]).includes(value)
    );
}

/**
 * Parse an intent from an untrusted source (a URL query, a stored preference).
 *
 * Returns the DEFAULT rather than `null` on garbage: an unrecognised intent is not an error
 * worth showing anyone, and the selector always needs a value to render.
 */
export function parseLoginRoleIntent(value: unknown): LoginRoleIntent {
    return isLoginRoleIntent(value) ? value : DEFAULT_LOGIN_ROLE_INTENT;
}

/** The destination for an intent. Always returns a safe, same-origin path. */
export function defaultDestinationForIntent(intent: LoginRoleIntent): string {
    return LOGIN_ROLE_INTENT_META[intent].destination;
}

/**
 * The intent that corresponds to a role actually resolved by the server.
 *
 * Used only to decide whether to tell the user their account did not match the entrance
 * they picked. It confers nothing: the value comes FROM the server-derived session.
 *
 * A `null` `platformRole` resolves to CUSTOMER, exactly as
 * `resolveAuthzScope` does (`User.platformRole` is nullable, and a null value holds no
 * platform capability). The two must agree, or the notice would contradict the guards.
 */
export function intentForPlatformRole(
    role: PlatformRole | null | undefined
): LoginRoleIntent {
    return isLoginRoleIntent(role) ? role : "CUSTOMER";
}

/**
 * Does the account's real role match the entrance the visitor chose?
 *
 * ADMIN and MANAGER share `/dashboard`, so they are treated as interchangeable: a manager
 * who clicks "Admin" (or vice versa) is choosing a shared entrance, not claiming a
 * different role, and telling them otherwise would be pedantic rather than protective.
 */
export function intentMatchesRole(
    intent: LoginRoleIntent,
    role: PlatformRole | null | undefined
): boolean {
    const actual = intentForPlatformRole(role);

    if (intent === actual) {
        return true;
    }

    const backOffice = new Set<LoginRoleIntent>(["ADMIN", "MANAGER"]);

    return backOffice.has(intent) && backOffice.has(actual);
}
