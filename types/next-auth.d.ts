import type { PlatformRole, Role } from "@prisma/client";
import type { DefaultSession } from "next-auth";

/**
 * ==========================================
 * PHASE 3 — TYPED SESSION
 * ==========================================
 *
 * Phase 0/1 findings corrected here:
 *
 *  1. `role` was declared as bare `string`. It is now the real `Role` type from
 *     the Prisma schema, so a typo like `role === "ADMN"` is a compile error
 *     instead of a silently-false authorization check.
 *
 *     `Role` is imported from `@prisma/client` rather than redeclared as a local
 *     string union on purpose: Prisma 6 generates enums as string-literal unions
 *     (verified: `export type Role = (typeof Role)[keyof typeof Role]`), not as
 *     TypeScript `enum`s. That matters because ~50 existing retail call sites
 *     compare `session.user.role !== "ADMIN"`. With a real TS `enum` every one of
 *     them would fail to compile (TS2367), and this phase would have had to
 *     rewrite retail authorization — which the phase 3 brief §14 explicitly tells
 *     us to document rather than rewrite. With the Prisma union they keep
 *     compiling AND gain type safety. Verified by probe before choosing.
 *
 *  2. `platformRole` did not exist on the session at all. It is added here as
 *     `PlatformRole | null`, mirroring the nullable `User.platformRole` column
 *     that Phase 2 added additively. It is the authority for the new ticketing
 *     authorization layer (`lib/authz`) and is deliberately separate from the
 *     legacy retail `role` — two independent dimensions, never merged into one
 *     `isAdmin` boolean.
 *
 * Deliberately NOT added to the session: any organizer/membership context or
 * resolved permission list. Caching tenant authority in the token would bake in a
 * shape the approved D-05 answer does not require, and the guards resolve
 * memberships and grants from the database on every call instead (see
 * `lib/authz/scope.ts`).
 */
declare module "next-auth" {
    interface Session {
        user: {
            id: string;
            /** Legacy retail role — `User.role`. Authority for the retail admin surface. */
            role: Role;
            /** Ticketing platform role — `User.platformRole`. Authority for `lib/authz`. */
            platformRole: PlatformRole | null;
        } & DefaultSession["user"];
    }

    interface User {
        role?: Role;
        platformRole?: PlatformRole | null;
    }
}

/**
 * NOTE ON THE MODULE SPECIFIER — verified, not assumed.
 *
 * The Auth.js v5 convention is to augment "next-auth/jwt", and that is what this
 * file originally did. In the installed beta, `node_modules/next-auth/jwt.d.ts`
 * contains nothing but `export * from "@auth/core/jwt";`, and the callbacks on
 * `NextAuth()` type their `token` parameter from the ORIGINAL interface in
 * `@auth/core/jwt`. Augmenting the re-export shim therefore does not reach it:
 * the augmentation is silently ignored and `token.anything` stays `unknown`,
 * because `@auth/core/jwt` declares `interface JWT extends Record<string, unknown>`.
 *
 * That failure mode is exactly the kind this phase exists to remove — a
 * declaration file that looks correct, compiles, and provides no safety. Empirically
 * confirmed: with "next-auth/jwt" the typecheck reported
 * `Argument of type 'unknown' is not assignable to parameter of type 'number | undefined'`
 * at the `isScopeStale(token.authzScopeRefreshedAt)` call. Augmenting the real
 * module fixes it and the re-exported type follows automatically.
 */
declare module "@auth/core/jwt" {
    interface JWT {
        /**
         * Optional: a token exists before these claims are populated (for
         * example between token creation and the first `jwt` callback), so the
         * declarations reflect that rather than claiming a value that may be
         * absent. Every consumer must therefore handle absence.
         */
        id?: string;
        /** Legacy retail role, mirrored from the database. */
        role?: Role;
        /**
         * Platform-role mirror, refreshed from the database when the copy is
         * older than `AUTHZ_SCOPE_TTL_MS` (approved decision D-48: ≤60 s
         * staleness). This mirror is for cheap routing/UI gating only — every
         * authorization guard re-reads authority from the database, so the guards
         * are strictly tighter than the approved bound.
         */
        platformRole?: PlatformRole | null;
        /** Epoch ms of the last database refresh of the platform-role mirror. */
        authzScopeRefreshedAt?: number;
    }
}
