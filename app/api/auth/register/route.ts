import { NextResponse } from "next/server";

import { prisma } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { registerSchema } from "@/lib/validations/register";
import { clientRateLimitKey, rateLimiters } from "@/lib/rate-limit";
import { requireSameOrigin } from "@/lib/csrf";
import { ERROR_CODES, statusForCode } from "@/lib/api/errors";

/**
 * POST /api/auth/register — create a customer account.
 *
 * The retail affiliate referral block that used to live here was removed with the affiliate
 * system: it resolved a client-supplied `referralCode` against `AffiliateProfile` and stored the
 * result on `User.referredBy`. Neither the model nor those columns exist any more, and ticketing
 * PIC attribution is per-order (`PICAttribution`), never per-account.
 *
 * STATE-CHANGING, SO SAME-ORIGIN IS CHECKED (Phase 3 D-56). This is a mutation reachable
 * without a session, and every other state-changing route in the tree calls `requireSameOrigin`;
 * omitting it here was an inconsistency, not a policy.
 *
 * VALIDATION FAILURES ARE 400, NOT 500. The body is parsed with `safeParse` and mapped onto the
 * platform's error envelope, so a malformed payload (short password, password mismatch, missing
 * email/phone) returns a `VALIDATION_ERROR` with field details instead of falling into the
 * catch-all and being reported as an internal server error.
 *
 * ── PUBLIC REGISTRATION CREATES A CUSTOMER. ALWAYS. ──────────────────────────────
 * This route is reachable without a session, so it is the platform's only unauthenticated
 * write into `User`. That makes it the obvious place to try to sign up as an administrator,
 * and the defence is structural rather than a rule:
 *
 *   1. `registerSchema` is a plain Zod object, so unknown keys are STRIPPED. `platformRole`,
 *      `role`, `permissions`, `organizerId` and `tenantId` never reach the handler at all.
 *   2. The row is built from an explicit allow-list of four fields — `name`, `email`, `phone`,
 *      `password`. Nothing is spread from the request body.
 *   3. `platformRole: "CUSTOMER"` and `role: "CUSTOMER"` are set HERE, on the server. The
 *      created account's authority does not depend on a column default happening to be right,
 *      and it cannot be influenced from outside.
 *   4. A request that carries a privilege-shaped key is logged (key NAMES only, never values)
 *      so an attempt is visible in the operator's logs, then ignored. Ignoring rather than
 *      rejecting is deliberate: a 400 would let a caller enumerate which key names the server
 *      treats as special, and there is nothing to gain by telling them.
 *
 * Back-office access is granted exclusively by an auditable administrative operation against
 * `User.platformRole` — never by this endpoint. See `lib/authz/scope.ts`, which documents why no
 * implicit bridge from any other column to a platform role exists.
 *
 * ── A DUPLICATE ACCOUNT IS 409, NOT 400 (Phase 27A, F1/F2) ───────────────────────
 * This route answered "Email atau nomor HP sudah digunakan." with **HTTP 400**, which the
 * platform's own taxonomy contradicts: `lib/api/errors.ts` maps the code `CONFLICT` to
 * **409**, so a client branching on `code` and a client branching on the status disagreed
 * about the same response. The body is unchanged (the same envelope, the same sentence) —
 * only the status is now the one the registry assigns to the code, read from the registry
 * rather than written out again here.
 *
 * The `findFirst` above it is a read-then-`create` check with no lock, so two concurrent
 * registrations for one email or phone can BOTH pass it; the loser then hits the unique
 * index and Prisma raises `P2002`, which used to fall into the catch-all below and be
 * answered with **500** for what is really the same duplicate. `P2002` is now mapped onto
 * this identical response. Matched on the error code only — no `meta`, no SQL, no model
 * name reaches the client or the log.
 */

/** Key names that would matter if a client could set them. Used for the server-side warning only. */
const PRIVILEGE_SHAPED_KEYS = [
    "platformRole",
    "role",
    "roles",
    "permissions",
    "organizerId",
    "tenantId",
    "memberships",
    "isAdmin",
    "grants",
    "permissionGrants",
] as const;

/**
 * The one response for "this email or phone already has an account".
 *
 * Shared by the pre-check and the `P2002` race handler so the two cannot drift: a client
 * must not be able to tell which of them produced the answer, and the message is the one
 * buyers already see.
 */
function duplicateAccountResponse() {
    return NextResponse.json(
        {
            success: false,
            code: ERROR_CODES.CONFLICT,
            message: "Email atau nomor HP sudah digunakan.",
        },
        { status: statusForCode(ERROR_CODES.CONFLICT) }
    );
}

/**
 * Is this the unique-constraint violation Prisma raises when two registrations race?
 *
 * `P2002` is Prisma's own code for it. Read defensively (`unknown`, no import of a Prisma
 * error type at the call site) so nothing about the error object is relied on beyond the
 * one field being compared, and nothing about it is exposed.
 */
function isUniqueConstraintError(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        (error as { code?: unknown }).code === "P2002"
    );
}

/**
 * Which privilege-shaped keys a request body carried.
 *
 * Returns NAMES only. The values are never returned, logged or read — a value could be
 * anything, and the fact that the key was present is the entire signal.
 */
function privilegeKeysPresent(body: unknown): string[] {
    if (typeof body !== "object" || body === null) {
        return [];
    }

    const keys = Object.keys(body as Record<string, unknown>);

    return PRIVILEGE_SHAPED_KEYS.filter((key) => keys.includes(key));
}
export async function POST(req: Request) {
    const csrf = requireSameOrigin(req);
    if (csrf.error) {
        return csrf.error;
    }

    try {
        // Rate limiting. `clientRateLimitKey` rather than `getClientIp` for the same
        // reason as the login limiter (see lib/rate-limit.ts): a dev server has no
        // trustworthy peer address, so its bucket is labelled instead of collapsing
        // into the production "untrusted" sentinel. Production is unchanged.
        const clientKey = clientRateLimitKey(req);
        const rateLimit = rateLimiters.register(clientKey);
        if (!rateLimit.allowed) {
            return NextResponse.json(
                {
                    success: false,
                    code: "RATE_LIMITED",
                    message: "Terlalu banyak permintaan. Coba lagi nanti.",
                },
                { status: 429 }
            );
        }

        const body = await req.json();

        /*
         * An escalation attempt is ignored — but it is not silent. The condition is reported
         * for the operator; the values are not, and the request continues to be treated as an
         * ordinary customer sign-up.
         */
        const ignoredKeys = privilegeKeysPresent(body);

        if (ignoredKeys.length > 0) {
            console.warn(
                `[auth/register] ignored privilege-shaped field(s): ${ignoredKeys.join(", ")}`
            );
        }

        const parsed = registerSchema.safeParse(body);

        if (!parsed.success) {
            return NextResponse.json(
                {
                    success: false,
                    code: "VALIDATION_ERROR",
                    message:
                        parsed.error.issues[0]?.message ??
                        "Data yang dikirim tidak valid.",
                    details: {
                        fields: parsed.error.issues.map((issue) => ({
                            path: issue.path.join("."),
                            message: issue.message,
                        })),
                    },
                },
                { status: 400 }
            );
        }

        const data = parsed.data;

        if (!data.email && !data.phone) {
            return NextResponse.json(
                {
                    success: false,
                    code: "VALIDATION_ERROR",
                    message:
                        "Email atau nomor HP wajib diisi.",
                },
                { status: 400 }
            );
        }

        const existing = await prisma.user.findFirst({
            where: {
                OR: [
                    ...(data.email
                        ? [{ email: data.email }]
                        : []),

                    ...(data.phone
                        ? [{ phone: data.phone }]
                        : []),
                ],
            },
        });

        if (existing) {
            return duplicateAccountResponse();
        }

        const hashedPassword =
            await hashPassword(data.password);

        /*
         * The row is built field by field from `parsed.data`, which is the schema's output —
         * not the request body. Both role dimensions are stated explicitly so the account's
         * authority is decided here, in the open, rather than by a column default that a
         * future migration could change.
         */
        const user = await prisma.user.create({
            data: {
                name: data.name,
                email: data.email || null,
                phone: data.phone || null,
                password: hashedPassword,
                // Public registration creates a buyer. There is no path from this route to
                // any other platform role.
                platformRole: "CUSTOMER",
                // The legacy retail column, stated rather than inherited from its default.
                role: "CUSTOMER",
            },
        });

        return NextResponse.json(
            {
                success: true,
                message: "Register berhasil",

                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    phone: user.phone,
                },
            },
            { status: 201 }
        );
    } catch (error: unknown) {
        /*
         * PHASE 27A — F2. The `findFirst` check above has no lock, so a concurrent
         * registration for the same email/phone passes it and loses the race at the
         * unique index. That is a DUPLICATE, not a server failure, and it now gets the
         * same response the pre-check gives.
         *
         * Checked before logging: an expected, benign race must not fill the operator's
         * log with stack traces that look like an outage.
         */
        if (isUniqueConstraintError(error)) {
            return duplicateAccountResponse();
        }

        console.error("REGISTER ERROR:", error);

        return NextResponse.json(
            {
                success: false,
                code: "INTERNAL_ERROR",
                message: "Terjadi kesalahan saat registrasi.",
            },
            { status: 500 }
        );
    }
}
