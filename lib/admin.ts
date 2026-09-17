import { auth } from "@/auth";

/**
 * ==========================================
 * LEGACY RETAIL ADMIN GUARD
 * ==========================================
 *
 * Requires the **retail** `Role.ADMIN` (`User.role`) — the authority for the
 * existing product / order / affiliate / marketing admin surface. This is used by
 * 22 retail route files and its behaviour is intentionally UNCHANGED.
 *
 * Phase 3 change is type-only: `session.user.role` became
 * `session.user.role`, which `types/next-auth.d.ts` now types as the real
 * `Role` enum from the Prisma schema, so this comparison is compile-checked.
 *
 * NOT migrated to the ticketing `platformRole` model, and deliberately so:
 * `User.platformRole` is nullable and unpopulated, so switching these routes to
 * it would lock every existing admin out of the retail application. The new
 * ticketing authorization layer lives in `lib/authz` and is used by ticketing
 * routes only. See TICKETING_PHASE3_REPORT.md §9 and §14.
 *
 * Known limitation (pre-existing, documented not fixed): this throws bare
 * `Error("UNAUTHORIZED")` strings rather than the `AuthzError` contract, so
 * callers must catch and map. Left as-is to avoid changing the response contract
 * of 22 live retail routes inside an authorization phase.
 */
export async function requireAdmin() {
    const session = await auth();

    if (!session?.user) {
        throw new Error("UNAUTHORIZED");
    }

    if (session.user.role !== "ADMIN") {
        throw new Error("FORBIDDEN");
    }

    return session;
}
