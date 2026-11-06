/**
 * ==========================================
 * PHASE 3A / 3A.2 — PIC ASSIGNMENT-BASED SCANNING AUTHORITY
 * ==========================================
 *
 * Pure authorization-matrix tests over `lib/authz/pic-assignment.ts`. No database, no Prisma
 * client, no session, no HTTP — the decider takes already-resolved snapshots, so every row
 * below is the executable statement of owner decision B-1:
 *
 *   ALLOW  an ACTIVE PIC profile + an active, non-revoked assignment for THE EXACT event
 *   DENY   everything else, including every state that is merely *not obviously* refused
 *
 * The matrix is a security contract, not a convenience list. Each denial row exists because
 * getting it wrong would grant cross-event, cross-PIC or tenant-wide scanning: an assignment
 * for another event, an assignment belonging to another PIC, a suspended profile, or a
 * revoked assignment that a stale read still presents as live.
 *
 * ── PHASE 3A.2 HARDENING ────────────────────────────────────────────────────────
 * The independent review (`docs/PHASE_3A_INDEPENDENT_SOURCE_REVIEW.md`) found four test
 * weaknesses, all closed here without touching the implementation:
 *
 *   L-2  three fail-closed guards (`picProfile.id`, `assignment.picProfileId`,
 *        `assignment.eventId`) had no rows of their own            → "L-2" describes.
 *   L-3  unknown/malformed values (`status` outside the enum, `isActive: "true"`,
 *        malformed `revokedAt`) had no rows                         → "L-3" describes.
 *   L-4  seven denial cases asserted the decision but not the refusal code or its HTTP
 *        status, and `expectDenied`'s `code` was a loose `string`  → every denial now asserts
 *        the exact `AuthzErrorCode`, the status that code maps to via the real `AuthzError`,
 *        and the refusal envelope.
 *   I-3  the "no organizer channel" row asserted a literal key list, which would still pass if
 *        the input TYPE gained an optional organizer/grants field → replaced with a
 *        compile-time exactness check over `keyof PicScanAuthorizationInput` plus the runtime
 *        fixture check.
 *
 * `AuthzErrorCode` is imported from `errors` (not the `@/lib/authz` barrel) for the same
 * reason `permission-map.test.ts` does: the barrel pulls in `guards`, which imports `auth.ts`
 * and therefore `next-auth`. Keeping the pure suites off the barrel keeps them runtime-free.
 */

import type { PICStatus } from "@prisma/client";

import { AuthzError, AuthzErrorCode } from "@/lib/authz/errors";
import {
    decidePicEventPermission,
    type PicAssignmentSnapshot,
    type PicProfileSnapshot,
    type PicScanAuthorizationInput,
} from "@/lib/authz/pic-assignment";
import {
    ADMIN_GRANT_REQUIRED,
    PERMISSIONS,
    __maps,
    decideOrganizerPermission,
    type AuthzScope,
} from "@/lib/authz/permissions";

const USER = "user-pic-1";
const OTHER_USER = "user-pic-2";
const PROFILE = "pic-profile-1";
const OTHER_PROFILE = "pic-profile-2";
const EVENT_A = "event-a";
const EVENT_B = "event-b";
const ORGANIZER = "organizer-1";

function profile(over: Partial<PicProfileSnapshot> = {}): PicProfileSnapshot {
    return {
        id: PROFILE,
        userId: USER,
        status: "ACTIVE" as PICStatus,
        ...over,
    };
}

function assignment(
    over: Partial<PicAssignmentSnapshot> = {}
): PicAssignmentSnapshot {
    return {
        picProfileId: PROFILE,
        eventId: EVENT_A,
        isActive: true,
        revokedAt: null,
        ...over,
    };
}

function ctx(
    over: Partial<PicScanAuthorizationInput> = {}
): PicScanAuthorizationInput {
    return {
        userId: USER,
        picProfile: profile(),
        eventId: EVENT_A,
        assignment: assignment(),
        ...over,
    };
}

const allowed = (input: PicScanAuthorizationInput | null | undefined) =>
    decidePicEventPermission(input).allowed;

/** The refusal, typed, so the CODE can be asserted as part of the contract. */
function decision(input: PicScanAuthorizationInput | null | undefined) {
    return decidePicEventPermission(input);
}

/**
 * Inject a value that the declared type forbids, at the one boundary where such a value can
 * really arrive.
 *
 * `PicProfileSnapshot.status` is `PICStatus` and `isActive` is `boolean` — what a correctly
 * typed caller passes. But the code that will feed this decider is a database `select` or a
 * JSON body, whose values are `unknown` until validated, so the RUNTIME answer for `"active"`
 * or `"true"` is part of the security contract rather than an academic case. This helper
 * confines the unavoidable cast to one place, typed `unknown` (never `any`), instead of
 * scattering `as` through the matrix.
 */
function malformed<T>(value: unknown): T {
    return value as T;
}

/**
 * Assert a refusal: the decision, the exact `AuthzErrorCode`, the HTTP status that code maps
 * to, and the refusal envelope.
 *
 * `code` is the exported `AuthzErrorCode` union, so an invented or misspelled code is a
 * COMPILE error rather than a green test. The status is read from `AuthzError` — the single
 * place the platform maps a code to a response — so this pins the real mapping instead of a
 * copy of it that could drift. `status` is passed explicitly so the expected value is visible
 * at each call site and cannot silently follow the implementation.
 *
 * The envelope assertion is the "no accidental success / no leakage" guard: a refusal must
 * carry `code` and `reason` and must never carry `picProfileId`.
 */
function expectDenied(
    input: PicScanAuthorizationInput | null | undefined,
    code: AuthzErrorCode,
    status: number
): void {
    const result = decidePicEventPermission(input);

    expect(result.allowed).toBe(false);

    if (!result.allowed) {
        expect(result.code).toBe(code);
        expect(new AuthzError(result.code).status).toBe(status);
        expect(Object.keys(result).sort()).toEqual(["allowed", "code", "reason"]);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// The allow row, and only the allow row
// ─────────────────────────────────────────────────────────────────────────────

describe("B-1 — an ACTIVE PIC with an active assignment for the exact event", () => {
    test("is allowed", () => {
        expect(allowed(ctx())).toBe(true);
    });

    test("the allow carries the verified PIC profile id and nothing else", () => {
        const result = decision(ctx());

        expect(result.allowed).toBe(true);
        expect(Object.keys(result).sort()).toEqual(["allowed", "picProfileId"]);

        if (result.allowed) {
            expect(result.picProfileId).toBe(PROFILE);
        }
    });

    test("a denied decision never carries the profile id", () => {
        const result = decision(ctx({ assignment: null }));

        expect(result.allowed).toBe(false);
        expect(Object.keys(result).sort()).toEqual(["allowed", "code", "reason"]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The required matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("B-1 — the PIC assignment matrix", () => {
    test("active PIC + active assignment for the requested event → ALLOW", () => {
        expect(allowed(ctx())).toBe(true);
    });

    test("active PIC + assignment for ANOTHER event → DENY", () => {
        // The single most important row: assignment A must never authorize event B, and the
        // refusal stays the masked 404 rather than a 403 that would confirm the event exists.
        expectDenied(
            ctx({ assignment: assignment({ eventId: EVENT_B }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test("active PIC + no assignment → DENY", () => {
        expectDenied(
            ctx({ assignment: null }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test("missing PIC profile → DENY", () => {
        expectDenied(
            ctx({ picProfile: null }),
            AuthzErrorCode.PIC_ACCESS_DENIED,
            403
        );
    });

    test.each([
        ["PENDING"],
        ["SUSPENDED"],
        ["REJECTED"],
    ] as const)("a %s PIC profile → DENY", (status) => {
        expectDenied(
            ctx({ picProfile: profile({ status }) }),
            AuthzErrorCode.PIC_ACCESS_DENIED,
            403
        );
    });

    test("inactive assignment → DENY", () => {
        expectDenied(
            ctx({ assignment: assignment({ isActive: false }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test("revoked assignment → DENY", () => {
        expectDenied(
            ctx({ assignment: assignment({ revokedAt: new Date() }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test.each([
        ["missing", undefined],
        ["null", null],
        ["empty", ""],
        ["whitespace only", "   "],
        ["wrong type", 42 as unknown as string],
    ])("%s event id → DENY", (_label, eventId) => {
        expectDenied(
            ctx({ eventId: eventId as string | null | undefined }),
            AuthzErrorCode.NOT_FOUND,
            404
        );
    });

    test("incomplete authorization context → DENY", () => {
        expectDenied(undefined, AuthzErrorCode.ORGANIZER_ACCESS_DENIED, 404);
        expectDenied(null, AuthzErrorCode.ORGANIZER_ACCESS_DENIED, 404);
    });

    test.each([
        ["missing", undefined],
        ["null", null],
        ["empty", ""],
    ])("an %s authenticated user → DENY", (_label, userId) => {
        expectDenied(
            ctx({ userId: userId as string | null | undefined }),
            AuthzErrorCode.UNAUTHORIZED,
            401
        );
    });

    test("assignment A cannot authorize event B, whichever way the caller names it", () => {
        // Requested B, holding A.
        expectDenied(
            ctx({
                eventId: EVENT_B,
                assignment: assignment({ eventId: EVENT_A }),
            }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );

        // Requested A, holding B.
        expectDenied(
            ctx({
                eventId: EVENT_A,
                assignment: assignment({ eventId: EVENT_B }),
            }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test("an assignment revoked AFTER a prior authorization is denied on the current state", () => {
        const before = ctx();
        expect(allowed(before)).toBe(true);

        expectDenied(
            ctx({ assignment: assignment({ revokedAt: new Date() }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );

        // The earlier decision is not cached into the later one: the decider holds no state.
        expect(allowed(before)).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cross-PIC isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("B-1 — a PIC cannot borrow another PIC's identity or assignment", () => {
    test("a profile owned by another user is denied", () => {
        expectDenied(
            ctx({ picProfile: profile({ userId: OTHER_USER }) }),
            AuthzErrorCode.PIC_ACCESS_DENIED,
            403
        );
    });

    test("a profile with no owner id is denied", () => {
        expectDenied(
            ctx({ picProfile: profile({ userId: "" }) }),
            AuthzErrorCode.PIC_ACCESS_DENIED,
            403
        );
    });

    test("an assignment belonging to another PIC profile is denied", () => {
        expectDenied(
            ctx({ assignment: assignment({ picProfileId: OTHER_PROFILE }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test("the other PIC's profile plus the original assignment is denied", () => {
        // Swapping only the profile must not let profile 2 ride profile 1's assignment.
        expectDenied(
            ctx({
                userId: OTHER_USER,
                picProfile: profile({ id: OTHER_PROFILE, userId: OTHER_USER }),
                assignment: assignment({ picProfileId: PROFILE }),
            }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed on non-boolean / partial state
// ─────────────────────────────────────────────────────────────────────────────

describe("B-1 — fail closed on partial or malformed assignments", () => {
    test("a truthy-but-not-boolean isActive is refused", () => {
        // "1" is truthy; the contract requires the boolean `true`.
        expectDenied(
            ctx({ assignment: assignment({ isActive: 1 as unknown as boolean }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test("an undefined revokedAt is refused, not read as `not revoked`", () => {
        // A partial database select could leave the field undefined; treating that as live is
        // exactly the fail-open this row pins against.
        expectDenied(
            ctx({
                assignment: assignment({ revokedAt: undefined as unknown as null }),
            }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });

    test("an assignment with an empty event id never authorizes a non-empty request", () => {
        expectDenied(
            ctx({ eventId: EVENT_A, assignment: assignment({ eventId: "" }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// L-2 — the three fail-closed guards the Phase 3A review found untested
//
// Each table changes exactly ONE field of the allow baseline (`ctx()`), so a failure names the
// guard rather than the fixture. The refusal CODE matters as much as the denial: it records
// WHICH branch fired, and therefore that the earlier branch answered before any later one
// could have allowed.
// ─────────────────────────────────────────────────────────────────────────────

describe("L-2 — picProfile.id is validated before anything else is trusted", () => {
    test.each([
        ["missing", malformed<string>(undefined)],
        ["empty", ""],
        ["whitespace only", "   "],
        ["a non-string", malformed<string>(42)],
    ])("picProfile.id is refused when it is %s", (_label, id) => {
        // The profile id is the first identity clause, so it answers 403 (profile problem)
        // even though the assignment would also mismatch it later.
        expectDenied(
            ctx({ picProfile: profile({ id }) }),
            AuthzErrorCode.PIC_ACCESS_DENIED,
            403
        );
    });
});

describe("L-2 — assignment.picProfileId must name the same profile", () => {
    test.each([
        ["missing", malformed<string>(undefined)],
        ["empty", ""],
        ["whitespace only", "   "],
        ["a non-string", malformed<string>(7)],
    ])("assignment.picProfileId is refused when it is %s", (_label, picProfileId) => {
        expectDenied(
            ctx({ assignment: assignment({ picProfileId }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });
});

describe("L-2 — assignment.eventId must be the requested event as an exact string", () => {
    test.each([
        ["missing", malformed<string>(undefined)],
        ["null", malformed<string>(null)],
        ["a non-string", malformed<string>(42)],
        ["whitespace-padded", " event-a"],
    ])("assignment.eventId is refused when it is %s", (_label, eventId) => {
        expectDenied(
            ctx({ assignment: assignment({ eventId }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// L-3 — unknown and malformed values
//
// These are the shapes a partial `select` or an untyped body actually produces. The declared
// TypeScript types exclude them, so they arrive through `malformed()` above.
// ─────────────────────────────────────────────────────────────────────────────

describe("L-3 — only the exact ACTIVE status passes", () => {
    test.each([
        ["active (lowercase)", malformed<PICStatus>("active")],
        ["ACTIVE with surrounding spaces", malformed<PICStatus>(" ACTIVE")],
        ["DELETED (outside the enum)", malformed<PICStatus>("DELETED")],
        ["undefined", malformed<PICStatus>(undefined)],
        ["null", malformed<PICStatus>(null)],
    ])("a PIC profile with status %s is refused", (_label, status) => {
        expectDenied(
            ctx({ picProfile: profile({ status }) }),
            AuthzErrorCode.PIC_ACCESS_DENIED,
            403
        );
    });
});

describe("L-3 — isActive must be the boolean true, not a truthy look-alike", () => {
    test.each([
        ['the string "true"', malformed<boolean>("true")],
        ["undefined", malformed<boolean>(undefined)],
        ["null", malformed<boolean>(null)],
    ])("isActive set to %s is refused", (_label, isActive) => {
        expectDenied(
            ctx({ assignment: assignment({ isActive }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });
});

describe("L-3 — a malformed revocation timestamp fails closed", () => {
    test.each([
        ["an empty string", malformed<Date | null>("")],
        ["the number 0", malformed<Date | null>(0)],
        ['the string "null"', malformed<Date | null>("null")],
        ["false", malformed<Date | null>(false)],
    ])("revokedAt set to %s is refused", (_label, revokedAt) => {
        // Only `null` means "not revoked": anything else is treated as a revocation, so a
        // value that merely *looks* empty can never restore authority.
        expectDenied(
            ctx({ assignment: assignment({ revokedAt }) }),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Purity
// ─────────────────────────────────────────────────────────────────────────────

describe("the decider is pure", () => {
    test("the input is never mutated", () => {
        const input = ctx();
        const snapshot = JSON.parse(JSON.stringify(input));

        decidePicEventPermission(input);

        expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    });

    test("the input may be frozen", () => {
        const input = Object.freeze(
            ctx({
                picProfile: Object.freeze(profile()),
                assignment: Object.freeze(assignment()),
            })
        );

        // A write to a frozen object would throw in strict mode — the call must not attempt one.
        expect(() => decidePicEventPermission(input)).not.toThrow();
        expect(allowed(input)).toBe(true);
    });

    test("the same input always yields the same output", () => {
        const input = ctx();

        expect(decision(input)).toEqual(decision(input));
    });

    test("the decider keeps no state between calls", () => {
        expect(allowed(ctx())).toBe(true);
        expect(allowed(ctx({ assignment: null }))).toBe(false);
        expect(allowed(ctx())).toBe(true);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Independence from organizer authorization (B-3)
// ─────────────────────────────────────────────────────────────────────────────

describe("B-3 — PIC authority is independent of organizer authorization", () => {
    test("the input carries no organizer, membership or grant channel", () => {
        // I-3 (Phase 3A.2): the previous version asserted only a literal key list, which would
        // still have passed if the input TYPE grew an optional `organizerId`/`grants`. The
        // compile-time half below fails `tsc` in that case, and the runtime half keeps the
        // fixture honest about the four fields the contract actually names.
        const INPUT_KEYS = ["assignment", "eventId", "picProfile", "userId"] as const;

        type ExpectedInputKeys = (typeof INPUT_KEYS)[number];
        type ActualInputKeys = keyof PicScanAuthorizationInput;

        // Adding ANY field widens `ActualInputKeys` past the expected union and resolves to
        // `never`; removing a field fails the other direction. Either way `= true` stops
        // compiling, so "no authority channel" is enforced by the type, not by a fixture.
        const noExtraInputKey: [ActualInputKeys] extends [ExpectedInputKeys]
            ? true
            : never = true;
        const noMissingInputKey: [ExpectedInputKeys] extends [ActualInputKeys]
            ? true
            : never = true;

        expect(Object.keys(ctx()).sort()).toEqual([...INPUT_KEYS].sort());
        expect([noExtraInputKey, noMissingInputKey]).toEqual([true, true]);
    });

    test("extra organizer state on the object is ignored", () => {
        const widened = {
            ...ctx(),
            platformRole: "ADMIN",
            organizerScopes: [
                { organizerId: ORGANIZER, role: "OWNER", status: "ACTIVE" },
            ],
            grants: [
                { organizerId: ORGANIZER, permission: "checkin.scan" },
                { organizerId: null, permission: "checkin.override" },
            ],
        } as unknown as PicScanAuthorizationInput;

        // Still denied without an assignment...
        expectDenied(
            { ...widened, assignment: null },
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            404
        );

        // ...and unchanged when one exists. Organizer state is not an input to this rule.
        expect(allowed(widened)).toBe(true);
    });

    test("PIC authority never becomes tenant-wide through the organizer decider", () => {
        // A PIC holding an ACTIVE membership in the event's organizer still cannot scan:
        // the capability is absent from every PIC map, and `checkin.scan` is ORGANIZER-scope.
        const picScope: AuthzScope = {
            userId: USER,
            platformRole: "PIC",
            organizerScopes: [
                { organizerId: ORGANIZER, role: "PIC", status: "ACTIVE" },
            ],
            grants: [],
        };

        expect(
            decideOrganizerPermission(picScope, ORGANIZER, PERMISSIONS.CHECKIN_SCAN)
                .allowed
        ).toBe(false);
        expect(
            decideOrganizerPermission(
                picScope,
                ORGANIZER,
                PERMISSIONS.CHECKIN_OVERRIDE
            ).allowed
        ).toBe(false);
        expect(
            decideOrganizerPermission(
                picScope,
                ORGANIZER,
                PERMISSIONS.CHECKIN_LOG_READ
            ).allowed
        ).toBe(false);
    });

    test("the platform PIC map holds no organizer capability at all", () => {
        expect([...__maps.PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC]).toEqual([]);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// No bypass channel, no accidental capability
// ─────────────────────────────────────────────────────────────────────────────

describe("no bypass channel exists", () => {
    test("the obsolete own-scope scan permission is gone from the vocabulary", () => {
        // Owner decision B-3: `pic.checkin.scan.own` was replaced by this decider. Re-adding
        // it would reintroduce a permission whose scope can never express an event assignment.
        const picCheckin = Object.entries(PERMISSIONS).filter(([, value]) =>
            String(value).startsWith("pic.checkin.")
        );

        expect(picCheckin).toEqual([]);
    });

    test("no scan permission is grant-required, so a PermissionGrant cannot satisfy one", () => {
        // `checkin.scan` is a role-held capability, not a grant-required one. If it were added
        // to this set, a `PermissionGrant` row would become a second door into the gate.
        expect(ADMIN_GRANT_REQUIRED.has(PERMISSIONS.CHECKIN_SCAN)).toBe(false);
        expect(
            [...ADMIN_GRANT_REQUIRED].filter((p) => String(p).includes("checkin"))
        ).toEqual([]);
    });

    test("no PIC map holds scan, override or log access", () => {
        const picMaps = [
            __maps.PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC,
            __maps.PLATFORM_ROLE_OWN_PERMISSIONS.PIC,
            __maps.MEMBERSHIP_ROLE_PERMISSIONS.PIC ?? new Set<string>(),
        ];

        for (const map of picMaps) {
            expect(map.has(PERMISSIONS.CHECKIN_SCAN)).toBe(false);
            expect(map.has(PERMISSIONS.CHECKIN_OVERRIDE)).toBe(false);
            expect(map.has(PERMISSIONS.CHECKIN_LOG_READ)).toBe(false);
        }
    });

    test("B-4 — the decision grants no attendance-log capability", () => {
        // Seeing the result of one's OWN scan is a UI policy (B-4), not a permission, and the
        // decider returns no capability string at all — so it cannot have granted one.
        const result = decision(ctx());

        if (result.allowed) {
            expect(Object.keys(result)).not.toContain("permissions");
            expect(JSON.stringify(result)).not.toContain("checkin.log");
        }
    });
});
