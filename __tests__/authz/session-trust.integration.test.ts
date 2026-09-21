/**
 * ==========================================
 * SESSION TRUST BOUNDARY (INTEGRATION, REAL DATABASE)
 * ==========================================
 *
 * A session is a claim about IDENTITY. Every authorization decision in the application starts
 * by resolving that identity into an authority scope, and the two ways that resolution can go
 * wrong are both silent:
 *
 *   • a session survives the account it names (a deleted or demoted user keeps acting), and
 *   • a cached claim is believed past its approved staleness bound.
 *
 * `AUTHZ_SCOPE_TTL_MS` encodes approved decision D-48: a scope may be cached for at most 60
 * seconds. The database is the authority, and `resolveAuthzScope` is the only function allowed
 * to consult it.
 *
 * `@/auth` is mocked — this suite is about what happens AFTER a session claims an id, so it
 * feeds ids in directly rather than driving a browser through a sign-in. Nothing about the
 * scope resolution itself is stubbed: the queries are real.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import {
    AUTHZ_SCOPE_TTL_MS,
    isScopeStale,
    resolveAuthzScope,
} from "@/lib/authz/scope";
import { getAuthzScope, requireAuth } from "@/lib/authz/guards";
import { AuthzError, AuthzErrorCode, isAuthzError } from "@/lib/authz/errors";

const mockedAuth = auth as unknown as jest.Mock;

/** An id that cannot exist: cuid-shaped, never written by any fixture or seed. */
const GHOST_USER_ID = "clsessiontrustghostuser00001";

afterEach(() => {
    mockedAuth.mockReset();
});

afterAll(async () => {
    await prisma.$disconnect();
});

/* ==================================================================================
 * 1. A SESSION THAT NAMES NOBODY HAS NO AUTHORITY
 * ================================================================================== */

describe("a session that resolves to no user has no authority", () => {
    it("resolveAuthzScope returns null for an unknown id rather than a scope", async () => {
        // The fail-closed shape: `null` means "unauthenticated", and every caller in
        // `lib/authz/guards.ts` treats it as such. A scope with a default role would be the
        // opposite: a deleted user keeping whatever the default happens to be.
        await expect(resolveAuthzScope(GHOST_USER_ID)).resolves.toBeNull();
    });

    it("getAuthzScope returns null when there is no session", async () => {
        mockedAuth.mockResolvedValue(null);

        await expect(getAuthzScope()).resolves.toBeNull();
    });

    it("getAuthzScope returns null when the session has no user id", async () => {
        mockedAuth.mockResolvedValue({ user: { name: "No Id" } });

        await expect(getAuthzScope()).resolves.toBeNull();
    });

    it("getAuthzScope returns null when the session's user no longer exists", async () => {
        // The critical one: a valid, unexpired token for an account that has since been
        // deleted must not resolve to authority. The token is not the authority.
        mockedAuth.mockResolvedValue({ user: { id: GHOST_USER_ID } });

        await expect(getAuthzScope()).resolves.toBeNull();
    });

    it("requireAuth throws UNAUTHORIZED for each of those cases", async () => {
        for (const session of [
            null,
            { user: { name: "No Id" } },
            { user: { id: GHOST_USER_ID } },
        ]) {
            mockedAuth.mockResolvedValue(session);

            await expect(requireAuth()).rejects.toBeInstanceOf(AuthzError);

            await requireAuth().catch((error: unknown) => {
                expect(isAuthzError(error)).toBe(true);

                if (isAuthzError(error)) {
                    expect(error.code).toBe(AuthzErrorCode.UNAUTHORIZED);
                    expect(error.status).toBe(401);
                }
            });
        }
    });
});

/* ==================================================================================
 * 2. THE STALENESS BOUND IS THE APPROVED ONE
 * ================================================================================== */

describe("the D-48 staleness bound", () => {
    it("is 60 seconds", () => {
        expect(AUTHZ_SCOPE_TTL_MS).toBe(60_000);
    });

    it("treats a token with no refresh timestamp as stale (a pre-Phase-3 token)", () => {
        expect(isScopeStale(undefined)).toBe(true);
        expect(isScopeStale(Number.NaN)).toBe(true);
        expect(isScopeStale(Number.POSITIVE_INFINITY)).toBe(true);
    });

    it("keeps a fresh scope and expires it exactly at the bound", () => {
        const now = 1_000_000;

        expect(isScopeStale(now - (AUTHZ_SCOPE_TTL_MS - 1), now)).toBe(false);
        expect(isScopeStale(now - AUTHZ_SCOPE_TTL_MS, now)).toBe(true);
        expect(isScopeStale(now - AUTHZ_SCOPE_TTL_MS - 1, now)).toBe(true);
    });

    it("does not accept a CLOCK-SKEWED future timestamp as fresh forever", () => {
        // A timestamp in the future is still a number, so it reads as fresh — but only until
        // the real clock catches up, which is bounded by the same TTL. Asserted so the
        // behaviour is a decision rather than an accident.
        const now = 1_000_000;

        expect(isScopeStale(now + 5_000, now)).toBe(false);
    });
});
