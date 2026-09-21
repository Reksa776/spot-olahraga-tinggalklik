import type { ReactNode } from "react";
import { FaExclamationCircle } from "react-icons/fa";

/**
 * ==========================================
 * AUTH ERROR
 * ==========================================
 *
 * The alert shown when authentication itself fails.
 *
 * ── THE SECURITY CONTRACT THIS COMPONENT ENFORCES ───────────────────────────────
 * Authentication failures must be INDISTINGUISHABLE to the person trying:
 *
 *   • a wrong password,
 *   • an account that does not exist,
 *   • a throttled IP,
 *   • a Google-only account with no password,
 *   • a role selector that does not match the account,
 *
 * all resolve to the same sentence. Anything more specific is a user-enumeration oracle:
 * "email belum terdaftar" tells an attacker which addresses to keep guessing and turns a
 * login form into a membership check for the whole platform.
 *
 * That is why this component takes no `code` prop and no field name. There is nothing a
 * caller could pass that would narrow the message, which is the point: the guarantee is
 * structural rather than a rule someone has to remember.
 *
 * The server side of the same contract is in `auth.ts`: the credentials provider runs a
 * real bcrypt comparison against `TIMING_EQUALISATION_HASH` even when the user does not
 * exist, so the response TIME does not leak either.
 *
 * ── WHY IT IS NOT A TOAST ───────────────────────────────────────────────────────
 * A toast vanishes in three seconds. Someone who mistyped a password will look back at the
 * form and needs the reason still there; `role="alert"` announces it once, when it appears.
 */
export function AuthError({ children }: { children: ReactNode }) {
    return (
        <div
            role="alert"
            className="flex items-start gap-3 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3"
        >
            <FaExclamationCircle
                aria-hidden
                className="mt-0.5 shrink-0 text-rose-500"
            />

            <p className="text-sm leading-relaxed text-rose-700">{children}</p>
        </div>
    );
}

export default AuthError;
