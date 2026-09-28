/**
 * ==========================================
 * AUDIENCE RESOLUTION — THE CALLER'S HALF OF THE DECISION
 * ==========================================
 *
 * `resolveRealtimeAudience()` decides what a connection may hear, and it must do so from the SESSION
 * and the DATABASE only. This suite pins the four properties that make that true:
 *
 *   1. ANONYMOUS IS MUTE. No scope → an empty set, which intersects nothing.
 *   2. PLATFORM IS `ADMIN` AND ONLY `ADMIN`. A tenant MANAGER is tenant-scoped here exactly as it
 *      is everywhere else; the platform dimension is not a \"staff\" dimension.
 *   3. THE TENANT DIMENSION RUNS THE REAL PERMISSION DECIDER. A suspended or revoked membership row
 *      still EXISTS, and must not make its holder an audience of that tenant's changes.
 *   4. OWN-SCOPE DIMENSIONS ARE THE CALLER'S OWN IDENTITY — the session user id for the buyer side,
 *      and the caller's ACTIVE `PICProfile` for the PIC side. No request value is consulted, because
 *      the endpoint takes no parameters at all.
 */

/**
 * `@/auth` is stubbed because the REAL `@/lib/authz` is loaded (below) to keep the permission
 * decider honest, and `lib/authz/guards.ts` imports it. Only the session entry point is stubbed —
 * every authorization rule under test is the production one.
 */
jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/authz", () => {
    const actual = jest.requireActual("@/lib/authz");

    return { ...actual, getAuthzScope: jest.fn() };
});

jest.mock("@/lib/pic/self-service", () => ({
    findActivePicProfile: jest.fn(),
}));

import { getAuthzScope } from "@/lib/authz";
import { findActivePicProfile } from "@/lib/pic/self-service";
import { realtimeOrganizerIds, resolveRealtimeAudience } from "@/lib/realtime/audience";
import { audienceKey } from "@/lib/realtime/taxonomy";

const scopeMock = getAuthzScope as jest.Mock;
const picMock = findActivePicProfile as jest.Mock;

type Membership = { organizerId: string; role: string; status: string };

function scope(input: {
    userId?: string;
    platformRole?: string;
    memberships?: Membership[];
}) {
    return {
        userId: input.userId ?? "usr_1",
        platformRole: input.platformRole ?? "CUSTOMER",
        organizerScopes: input.memberships ?? [],
        grants: [],
    };
}

beforeEach(() => {
    scopeMock.mockReset();
    picMock.mockReset();
    picMock.mockResolvedValue(null);
});

describe("the caller's audience set", () => {
    test("an anonymous request is mute, and never even probes for a PIC profile", async () => {
        scopeMock.mockResolvedValue(null);

        expect(await resolveRealtimeAudience()).toEqual([]);
        expect(picMock).not.toHaveBeenCalled();
    });

    test("a plain customer is only their own buyer scope — no platform, no tenant", async () => {
        scopeMock.mockResolvedValue(scope({ userId: "usr_buyer" }));

        expect((await resolveRealtimeAudience()).map(audienceKey)).toEqual(["customer:usr_buyer"]);
    });

    test("a platform ADMIN is the platform audience, plus their own identity", async () => {
        scopeMock.mockResolvedValue(scope({ userId: "usr_admin", platformRole: "ADMIN" }));

        expect((await resolveRealtimeAudience()).map(audienceKey)).toEqual([
            "platform",
            "customer:usr_admin",
        ]);
    });

    test("a tenant MANAGER is NOT a platform audience", async () => {
        scopeMock.mockResolvedValue(
            scope({
                userId: "usr_manager",
                platformRole: "MANAGER",
                memberships: [{ organizerId: "org_a", role: "MANAGER", status: "ACTIVE" }],
            })
        );

        const keys = (await resolveRealtimeAudience()).map(audienceKey);

        expect(keys).not.toContain("platform");
        expect(keys).toContain("organizer:org_a");
        expect(keys).toContain("customer:usr_manager");
    });

    test("an ADMIN's platform audience does not confer a tenant they are not a member of", async () => {
        scopeMock.mockResolvedValue(scope({ userId: "usr_admin", platformRole: "ADMIN" }));

        const keys = (await resolveRealtimeAudience()).map(audienceKey);

        expect(keys).toContain("platform");
        expect(keys.some((key) => key.startsWith("organizer:"))).toBe(false);
    });

    test("a PIC's own profile is the PIC dimension, and a suspended profile is nothing", async () => {
        scopeMock.mockResolvedValue(scope({ userId: "usr_pic" }));
        picMock.mockResolvedValue({ id: "pic_1" });

        expect((await resolveRealtimeAudience()).map(audienceKey)).toEqual([
            "customer:usr_pic",
            "pic:pic_1",
        ]);

        // `findActivePicProfile` returns null for a suspended/absent profile, so a suspended PIC
        // receives nothing on this dimension rather than their historical scope.
        picMock.mockResolvedValue(null);

        expect((await resolveRealtimeAudience()).map(audienceKey)).toEqual(["customer:usr_pic"]);
    });
});

describe("the tenant dimension runs the real permission decider, not the membership row", () => {
    test("an ACTIVE OWNER membership is realtime-relevant", () => {
        const ids = realtimeOrganizerIds(
            scope({ memberships: [{ organizerId: "org_a", role: "OWNER", status: "ACTIVE" }] }) as never
        );

        expect(ids).toEqual(["org_a"]);
    });

    test("a SUSPENDED membership grants nothing, even though the row exists", () => {
        const ids = realtimeOrganizerIds(
            scope({
                memberships: [
                    { organizerId: "org_a", role: "OWNER", status: "SUSPENDED" },
                    { organizerId: "org_b", role: "MANAGER", status: "SUSPENDED" },
                ],
            }) as never
        );

        expect(ids).toEqual([]);
    });

    test("only the tenants the actor can actually read are returned, and no others", () => {
        const ids = realtimeOrganizerIds(
            scope({
                memberships: [
                    { organizerId: "org_ok", role: "MANAGER", status: "ACTIVE" },
                    { organizerId: "org_suspended", role: "OWNER", status: "SUSPENDED" },
                ],
            }) as never
        );

        expect(ids).toEqual(["org_ok"]);
        expect(ids).not.toContain("org_suspended");
    });

    test("no membership at all means no tenant audience", () => {
        expect(realtimeOrganizerIds(scope({}) as never)).toEqual([]);
    });
});
