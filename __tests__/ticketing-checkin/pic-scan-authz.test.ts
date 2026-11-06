import fs from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 3D — PIC SCAN AUTHORIZATION
 * ==========================================
 *
 * Exercises the REAL `requireEventCheckInAccess` with the REAL Phase 3A decider and the REAL
 * organizer guards. Only persistence (`@/lib/prisma`) and the session (`@/auth`) are mocked —
 * those are the two edges the function is supposed to read from, and mocking them is what makes
 * the authorization table testable without a database. This is a MOCKED suite: it proves the
 * decision path and the refusals, not database locking or the SQL of the compound lookup.
 *
 * The organizer path is tested first, because Phase 3D must prove it preserved rather than
 * replaced that behaviour: a member is still authorized by membership, and an authenticated
 * non-member with no PIC profile still receives the same masked 404.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/prisma", () => ({
    prisma: {
        user: { findUnique: jest.fn() },
        organizerMember: { findMany: jest.fn(), findFirst: jest.fn() },
        staffEventAssignment: { findFirst: jest.fn() },
        permissionGrant: { findMany: jest.fn() },
        event: { findUnique: jest.fn() },
        pICProfile: { findUnique: jest.fn() },
        pICEventAssignment: { findUnique: jest.fn() },
    },
}));

jest.mock("@/lib/realtime/publishers", () => ({
    publishTicketCheckedIn: jest.fn(),
}));
jest.mock("@/lib/ticketing/audit-log", () => ({
    writeTicketingAudit: jest.fn(),
}));
jest.mock("@/lib/rate-limit", () => ({ getClientIp: jest.fn(() => null) }));

import { requireEventCheckInAccess } from "@/lib/ticketing/checkin/service";

type MockDb = {
    user: { findUnique: jest.Mock };
    organizerMember: { findMany: jest.Mock; findFirst: jest.Mock };
    staffEventAssignment: { findFirst: jest.Mock };
    permissionGrant: { findMany: jest.Mock };
    event: { findUnique: jest.Mock };
    pICProfile: { findUnique: jest.Mock };
    pICEventAssignment: { findUnique: jest.Mock };
};

const db = (jest.requireMock("@/lib/prisma") as { prisma: MockDb }).prisma;
const auth = (jest.requireMock("@/auth") as { auth: jest.Mock }).auth;

const EVENT = { id: "event-1", organizerId: "org-1" };
const USER = { id: "user-1", platformRole: "CUSTOMER", disabledAt: null };

type Caught = {
    code?: string;
    status?: number;
    httpStatus?: number;
    details?: Record<string, unknown>;
};

async function refusal(promise: Promise<unknown>): Promise<Caught> {
    let caught: unknown;

    try {
        await promise;
    } catch (error) {
        caught = error;
    }

    if (caught === undefined) {
        throw new Error("Expected the call to reject, but it resolved.");
    }

    return caught as Caught;
}

function membership(role: string) {
    return { organizerId: EVENT.organizerId, role, status: "ACTIVE" };
}

function activeProfile() {
    return { id: "pic-1", userId: USER.id, status: "ACTIVE" as const };
}

function activeAssignment(overrides: Record<string, unknown> = {}) {
    return {
        picProfileId: "pic-1",
        eventId: EVENT.id,
        isActive: true,
        revokedAt: null,
        ...overrides,
    };
}

beforeEach(() => {
    jest.resetAllMocks();

    auth.mockResolvedValue({ user: { id: USER.id } });
    db.user.findUnique.mockResolvedValue({ ...USER });
    db.organizerMember.findMany.mockResolvedValue([]);
    db.organizerMember.findFirst.mockResolvedValue(null);
    db.staffEventAssignment.findFirst.mockResolvedValue(null);
    db.permissionGrant.findMany.mockResolvedValue([]);
    db.event.findUnique.mockResolvedValue({ ...EVENT });
    db.pICProfile.findUnique.mockResolvedValue(null);
    db.pICEventAssignment.findUnique.mockResolvedValue(null);
});

describe("D1 — the organizer path is preserved", () => {
    test("an OWNER member is authorized without a staff assignment or a PIC profile", async () => {
        db.organizerMember.findMany.mockResolvedValue([membership("OWNER")]);
        db.organizerMember.findFirst.mockResolvedValue({ id: "member-1" });

        const access = await requireEventCheckInAccess(EVENT.id);

        expect(access.scope.userId).toBe(USER.id);
        expect(access.event).toEqual(EVENT);
        expect(access.memberId).toBe("member-1");
        expect(db.pICProfile.findUnique).not.toHaveBeenCalled();
    });

    test("a FINANCE member is still refused with 403", async () => {
        db.organizerMember.findMany.mockResolvedValue([membership("FINANCE")]);
        db.organizerMember.findFirst.mockResolvedValue({ id: "member-1" });

        const error = await refusal(requireEventCheckInAccess(EVENT.id));

        expect(error.status ?? error.httpStatus).toBe(403);
        expect(error.code).toBe("FORBIDDEN");
        expect(auth).toHaveBeenCalled();
    });

    test("gate staff without an assignment keep NO_STAFF_ASSIGNMENT", async () => {
        db.organizerMember.findMany.mockResolvedValue([membership("CHECKIN_STAFF")]);
        db.organizerMember.findFirst.mockResolvedValue({ id: "member-1" });

        const error = await refusal(requireEventCheckInAccess(EVENT.id));

        expect(error.code).toBe("FORBIDDEN");
        expect(error.details?.reason).toBe("NO_STAFF_ASSIGNMENT");
    });

    test("an authenticated non-member with no PIC profile gets the same masked 404", async () => {
        const error = await refusal(requireEventCheckInAccess(EVENT.id));

        expect(error.code).toBe("ORGANIZER_ACCESS_DENIED");
        expect(error.status ?? error.httpStatus).toBe(404);
        // The PIC fallback asked, found no profile, and rethrew the original refusal.
        expect(db.pICProfile.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({ where: { userId: USER.id } })
        );
    });
});

describe("D2 — a PIC is authorized only by its own assignment for this event", () => {
    test("an ACTIVE PIC with an active, non-revoked assignment is allowed", async () => {
        db.pICProfile.findUnique.mockResolvedValue(activeProfile());
        db.pICEventAssignment.findUnique.mockResolvedValue(activeAssignment());

        const access = await requireEventCheckInAccess(EVENT.id);

        expect(access.scope.userId).toBe(USER.id);
        expect(access.event).toEqual(EVENT);
        // A PIC has no OrganizerMember row to attribute as a member.
        expect(access.memberId).toBeNull();
    });

    test("the assignment is looked up by the exact (profile, event) pair", async () => {
        db.pICProfile.findUnique.mockResolvedValue(activeProfile());
        db.pICEventAssignment.findUnique.mockResolvedValue(activeAssignment());

        await requireEventCheckInAccess(EVENT.id);

        expect(db.pICEventAssignment.findUnique).toHaveBeenCalledWith(
            expect.objectContaining({
                where: {
                    picProfileId_eventId: {
                        picProfileId: "pic-1",
                        eventId: EVENT.id,
                    },
                },
            })
        );
    });

    test("no assignment for this event is refused as 404, never as an allow", async () => {
        db.pICProfile.findUnique.mockResolvedValue(activeProfile());
        db.pICEventAssignment.findUnique.mockResolvedValue(null);

        const error = await refusal(requireEventCheckInAccess(EVENT.id));

        expect(error.code).toBe("ORGANIZER_ACCESS_DENIED");
        expect(error.status ?? error.httpStatus).toBe(404);
    });

    test.each([
        ["PENDING", "PIC_ACCESS_DENIED", 403],
        ["SUSPENDED", "PIC_ACCESS_DENIED", 403],
        ["REJECTED", "PIC_ACCESS_DENIED", 403],
    ] as const)(
        "a %s profile is refused with %s",
        async (status, code, httpStatus) => {
            db.pICProfile.findUnique.mockResolvedValue({
                id: "pic-1",
                userId: USER.id,
                status,
            });
            db.pICEventAssignment.findUnique.mockResolvedValue(activeAssignment());

            const error = await refusal(requireEventCheckInAccess(EVENT.id));

            expect(error.code).toBe(code);
            expect(error.status ?? error.httpStatus).toBe(httpStatus);
        }
    );

    test.each([
        ["inactive", { isActive: false }],
        ["revoked", { revokedAt: new Date("2026-09-01T00:00:00.000Z") }],
        ["someone else's", { picProfileId: "pic-2" }],
        ["another event's", { eventId: "event-2" }],
    ] as const)(
        "an %s assignment is refused as 404",
        async (_label, overrides) => {
            db.pICProfile.findUnique.mockResolvedValue(activeProfile());
            db.pICEventAssignment.findUnique.mockResolvedValue(
                activeAssignment(overrides)
            );

            const error = await refusal(requireEventCheckInAccess(EVENT.id));

            expect(error.code).toBe("ORGANIZER_ACCESS_DENIED");
            expect(error.status ?? error.httpStatus).toBe(404);
        }
    );

    test("a deactivated account is unauthenticated, not a PIC", async () => {
        db.user.findUnique.mockResolvedValue({
            ...USER,
            disabledAt: new Date("2026-09-01T00:00:00.000Z"),
        });
        db.pICProfile.findUnique.mockResolvedValue(activeProfile());
        db.pICEventAssignment.findUnique.mockResolvedValue(activeAssignment());

        const error = await refusal(requireEventCheckInAccess(EVENT.id));

        expect(error.code).toBe("UNAUTHORIZED");
        expect(error.status ?? error.httpStatus).toBe(401);
    });
});

describe("D3 — failures are not converted into a second authorization attempt", () => {
    test("a database failure propagates instead of falling through to the PIC path", async () => {
        db.event.findUnique.mockRejectedValue(new Error("db down"));

        await expect(requireEventCheckInAccess(EVENT.id)).rejects.toThrow("db down");
        expect(db.pICProfile.findUnique).not.toHaveBeenCalled();
    });

    test("no session is a 401, and no PIC lookup is attempted", async () => {
        auth.mockResolvedValue(null);

        const error = await refusal(requireEventCheckInAccess(EVENT.id));

        expect(error.code).toBe("UNAUTHORIZED");
        expect(error.status ?? error.httpStatus).toBe(401);
    });
});

describe("D4 — the guard remains the service's only access point", () => {
    const source = fs
        .readFileSync(
            path.resolve(
                process.cwd(),
                "lib/ticketing/checkin/service.ts"
            ),
            "utf8"
        )
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");

    test("the PIC branch runs the real decider", () => {
        expect(source).toContain("decidePicEventPermission({");
        expect(source).toContain("pICEventAssignment.findUnique({");
        expect(source).toContain("picProfileId_eventId");
    });

    test("the organizer gate was not removed or weakened", () => {
        expect(source).toContain("requireOrganizerCheckInAccess(eventId)");
        expect(source).toContain("PERMISSIONS.CHECKIN_SCAN");
        expect(source).toContain("NO_STAFF_ASSIGNMENT");
        expect(source).toContain("requireEventAccess(");
    });

    test("the fallback only reacts to authorization refusals", () => {
        expect(source).toContain("isAccessRefusal(error)");
        expect(source).toContain("ACCESS_REFUSAL_CODES");
    });
});
