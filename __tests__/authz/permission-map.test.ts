/**
 * ==========================================
 * PHASE 3 — PERMISSION MAP & DECISION RULES
 * ==========================================
 *
 * Pure tests over `lib/authz/permissions.ts`. No database, no NextAuth, no
 * HTTP — so every rule is asserted deterministically and none of these tests can
 * pass for the wrong reason.
 *
 * These tests are the executable statement of the approved decisions:
 *   D-05 → single organizer; membership `ADMIN` is vestigial and grants nothing
 *   D-19 → grant-required; ADMIN has no financial power by default
 */

import type {
    OrganizerMemberRole,
    OrganizerMemberStatus,
} from "@prisma/client";

/*
 * Imported from the submodules rather than the `@/lib/authz` barrel on purpose:
 * the barrel also re-exports `guards.ts`, which imports `@/auth`, which imports
 * `next-auth` — an ESM-only package this jest setup cannot parse. Keeping the pure
 * tests off the barrel keeps them free of NextAuth entirely, which is the point of
 * testing these rules in isolation.
 */
import { AuthzErrorCode } from "@/lib/authz/errors";
import {
    ALL_PERMISSIONS,
    ORGANIZER_SPANNING_PLATFORM_ROLES,
    PERMISSIONS,
    PERMISSION_SCOPE,
    decideOrganizerPermission,
    decideOwnResourcePermission,
    decidePlatformPermission,
    hasActiveMembership,
    type AuthzScope,
    type GrantEntry,
    type OrganizerScopeEntry,
} from "@/lib/authz/permissions";

const ORG_A = "organizer-a";
const ORG_B = "organizer-b";
const USER_1 = "user-1";
const USER_2 = "user-2";

function makeScope(over: Partial<AuthzScope> = {}): AuthzScope {
    return {
        userId: USER_1,
        platformRole: "CUSTOMER",
        organizerScopes: [],
        grants: [],
        ...over,
    };
}

function membership(
    organizerId: string,
    role: OrganizerMemberRole,
    status: OrganizerMemberStatus = "ACTIVE"
): OrganizerScopeEntry {
    return { organizerId, role, status };
}

function grant(organizerId: string | null, permission: string): GrantEntry {
    return { organizerId, permission };
}

/** Assert a decision is a denial carrying a specific code. */
function expectDenied(
    decision: ReturnType<typeof decideOrganizerPermission>,
    code: string
): void {
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
        expect(decision.code).toBe(code);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fail-closed fundamentals
// ─────────────────────────────────────────────────────────────────────────────

describe("fail-closed fundamentals", () => {
    test("every declared permission has a scope classification", () => {
        for (const permission of ALL_PERMISSIONS) {
            expect(PERMISSION_SCOPE.has(permission)).toBe(true);
        }
        expect(PERMISSION_SCOPE.size).toBe(ALL_PERMISSIONS.size);
    });

    test("an unknown permission is denied by every decider", () => {
        const scope = makeScope({
            platformRole: "ADMIN",
            organizerScopes: [membership(ORG_A, "OWNER")],
            grants: [grant(ORG_A, "anything.goes")],
        });

        expectDenied(
            decideOrganizerPermission(scope, ORG_A, "totally.made.up"),
            AuthzErrorCode.FORBIDDEN
        );
        expect(
            decidePlatformPermission(scope, "totally.made.up").allowed
        ).toBe(false);
        expect(
            decideOwnResourcePermission(scope, "totally.made.up", USER_1).allowed
        ).toBe(false);
    });

    test("permissions the brief forbids for everyone do not exist", () => {
        // §6.3 marks these NO for every role. They are unreachable because no
        // permission string exists for them and unknown strings always deny.
        const forbidden = [
            "order.amount.edit",
            "order.amount.alter",
            "payment.amount.alter",
            "ledger.write",
            "ledger.edit",
            "pic_fee.edit",
        ];

        for (const permission of forbidden) {
            expect(ALL_PERMISSIONS.has(permission)).toBe(false);
        }

        const owner = makeScope({
            platformRole: "MANAGER",
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        for (const permission of forbidden) {
            expectDenied(
                decideOrganizerPermission(owner, ORG_A, permission),
                AuthzErrorCode.FORBIDDEN
            );
        }
    });

    test("no platform role spans organizers without a membership", () => {
        expect(ORGANIZER_SPANNING_PLATFORM_ROLES.size).toBe(0);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-19 — ADMIN holds no financial power by default
// ─────────────────────────────────────────────────────────────────────────────

describe("D-19 — ADMIN financial capability requires an explicit grant", () => {
    const financial = [
        PERMISSIONS.PAYMENT_RECONCILE,
        PERMISSIONS.REFUND_APPROVE,
        PERMISSIONS.FEE_RATE_CHANGE,
        PERMISSIONS.FEE_ADJUST,
        PERMISSIONS.SETTLEMENT_APPROVE,
        PERMISSIONS.REPORT_EXPORT_TRANSACTION,
        PERMISSIONS.REPORT_EXPORT_PIC_FEE,
        PERMISSIONS.REPORT_EXPORT_FINANCIAL,
    ];

    test("an ADMIN who is an active member still cannot touch money without a grant", () => {
        const admin = makeScope({
            platformRole: "ADMIN",
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        for (const permission of financial) {
            expectDenied(
                decideOrganizerPermission(admin, ORG_A, permission),
                AuthzErrorCode.FORBIDDEN
            );
        }
    });

    test("an explicit grant unlocks exactly the granted permission", () => {
        const admin = makeScope({
            platformRole: "ADMIN",
            organizerScopes: [membership(ORG_A, "OWNER")],
            grants: [grant(ORG_A, PERMISSIONS.SETTLEMENT_APPROVE)],
        });

        expect(
            decideOrganizerPermission(admin, ORG_A, PERMISSIONS.SETTLEMENT_APPROVE)
                .allowed
        ).toBe(true);

        // The grant is specific — it does not widen into the other cells.
        expectDenied(
            decideOrganizerPermission(admin, ORG_A, PERMISSIONS.FEE_ADJUST),
            AuthzErrorCode.FORBIDDEN
        );
        expectDenied(
            decideOrganizerPermission(
                admin,
                ORG_A,
                PERMISSIONS.REPORT_EXPORT_FINANCIAL
            ),
            AuthzErrorCode.FORBIDDEN
        );
    });

    test("a platform-wide grant (organizerId null) also satisfies ADMIN", () => {
        const admin = makeScope({
            platformRole: "ADMIN",
            organizerScopes: [membership(ORG_A, "OWNER")],
            grants: [grant(null, PERMISSIONS.FEE_ADJUST)],
        });

        expect(
            decideOrganizerPermission(admin, ORG_A, PERMISSIONS.FEE_ADJUST).allowed
        ).toBe(true);
    });

    test("a grant for a DIFFERENT organizer does not leak across tenants", () => {
        const admin = makeScope({
            platformRole: "ADMIN",
            organizerScopes: [membership(ORG_A, "OWNER"), membership(ORG_B, "OWNER")],
            grants: [grant(ORG_B, PERMISSIONS.FEE_ADJUST)],
        });

        expect(
            decideOrganizerPermission(admin, ORG_B, PERMISSIONS.FEE_ADJUST).allowed
        ).toBe(true);
        expectDenied(
            decideOrganizerPermission(admin, ORG_A, PERMISSIONS.FEE_ADJUST),
            AuthzErrorCode.FORBIDDEN
        );
    });

    test("ADMIN keeps its non-financial capabilities", () => {
        const admin = makeScope({
            platformRole: "ADMIN",
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        expect(
            decideOrganizerPermission(admin, ORG_A, PERMISSIONS.EVENT_WRITE).allowed
        ).toBe(true);
        expect(
            decidePlatformPermission(admin, PERMISSIONS.USER_MANAGE).allowed
        ).toBe(true);
        expect(
            decidePlatformPermission(admin, PERMISSIONS.ROLE_MANAGE).allowed
        ).toBe(true);
        expect(
            decidePlatformPermission(admin, PERMISSIONS.PLATFORM_CONFIG).allowed
        ).toBe(true);
    });

    test("MANAGER holds settlement/fee authority by role, with no grant", () => {
        const manager = makeScope({
            platformRole: "MANAGER",
            organizerScopes: [membership(ORG_A, "MANAGER")],
        });

        for (const permission of [
            PERMISSIONS.SETTLEMENT_PREPARE,
            PERMISSIONS.SETTLEMENT_APPROVE,
            PERMISSIONS.FEE_ADJUST,
            PERMISSIONS.FEE_RATE_CHANGE,
            PERMISSIONS.FEE_MARK_PAID,
            PERMISSIONS.REPORT_EXPORT_FINANCIAL,
        ]) {
            expect(
                decideOrganizerPermission(manager, ORG_A, permission).allowed
            ).toBe(true);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Separation of duties / privilege escalation
// ─────────────────────────────────────────────────────────────────────────────

describe("separation of duties", () => {
    test("MANAGER can never manage users, roles or platform config", () => {
        const manager = makeScope({
            platformRole: "MANAGER",
            organizerScopes: [membership(ORG_A, "MANAGER")],
        });

        for (const permission of [
            PERMISSIONS.USER_MANAGE,
            PERMISSIONS.ROLE_MANAGE,
            PERMISSIONS.PLATFORM_CONFIG,
            PERMISSIONS.SPORT_MANAGE,
            PERMISSIONS.PIC_MANAGE,
        ]) {
            expectDenied(
                decidePlatformPermission(manager, permission),
                AuthzErrorCode.FORBIDDEN
            );
        }
    });

    test("a MANAGER grant cannot manufacture platform authority it lacks", () => {
        // A grant is checked for organizer-scope permissions only. Even holding a
        // grant row for `user.manage` must not satisfy the platform decider,
        // because the decider refuses non-platform-scope permissions outright.
        const manager = makeScope({
            platformRole: "MANAGER",
            organizerScopes: [membership(ORG_A, "MANAGER")],
            grants: [grant(null, PERMISSIONS.USER_MANAGE)],
        });

        // ADMIN_GRANT_REQUIRED applies to ADMIN, so for MANAGER the role map is
        // the real answer: MANAGER has no user.manage.
        expectDenied(
            decidePlatformPermission(manager, PERMISSIONS.USER_MANAGE),
            AuthzErrorCode.FORBIDDEN
        );
    });

    test("platform PIC gets no tenant-wide capability", () => {
        const pic = makeScope({
            platformRole: "PIC",
            organizerScopes: [membership(ORG_A, "PIC")],
        });

        // Membership PIC is the design's PIC_VIEWER: attribution visibility only.
        expect(
            decideOrganizerPermission(
                pic,
                ORG_A,
                PERMISSIONS.PIC_ATTRIBUTION_READ_ALL
            ).allowed
        ).toBe(true);

        for (const permission of [
            PERMISSIONS.EVENT_WRITE,
            PERMISSIONS.ORDER_READ_TENANT,
            PERMISSIONS.PIC_FEE_READ_ALL,
            PERMISSIONS.FEE_ADJUST,
            PERMISSIONS.SETTLEMENT_APPROVE,
        ]) {
            expectDenied(
                decideOrganizerPermission(pic, ORG_A, permission),
                AuthzErrorCode.FORBIDDEN
            );
        }
    });

    test("CHECKIN_STAFF is least privilege", () => {
        const staff = makeScope({
            platformRole: "CUSTOMER",
            organizerScopes: [membership(ORG_A, "CHECKIN_STAFF")],
        });

        expect(
            decideOrganizerPermission(staff, ORG_A, PERMISSIONS.CHECKIN_SCAN).allowed
        ).toBe(true);
        expect(
            decideOrganizerPermission(staff, ORG_A, PERMISSIONS.CHECKIN_LOG_READ)
                .allowed
        ).toBe(true);

        for (const permission of [
            PERMISSIONS.ORDER_READ_TENANT,
            PERMISSIONS.PIC_FEE_READ_ALL,
            PERMISSIONS.EVENT_WRITE,
            PERMISSIONS.CHECKIN_OVERRIDE,
        ]) {
            expectDenied(
                decideOrganizerPermission(staff, ORG_A, permission),
                AuthzErrorCode.FORBIDDEN
            );
        }
    });

    test("FINANCE can prepare settlements but cannot edit events", () => {
        const finance = makeScope({
            platformRole: "CUSTOMER",
            organizerScopes: [membership(ORG_A, "FINANCE")],
        });

        expect(
            decideOrganizerPermission(finance, ORG_A, PERMISSIONS.SETTLEMENT_PREPARE)
                .allowed
        ).toBe(true);
        expectDenied(
            decideOrganizerPermission(finance, ORG_A, PERMISSIONS.EVENT_WRITE),
            AuthzErrorCode.FORBIDDEN
        );
        expectDenied(
            decideOrganizerPermission(finance, ORG_A, PERMISSIONS.EVENT_PUBLISH),
            AuthzErrorCode.FORBIDDEN
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-05 — membership ADMIN is vestigial
// ─────────────────────────────────────────────────────────────────────────────

describe("D-05 — membership ADMIN grants nothing (no invented tier)", () => {
    test("an OrganizerMember carrying role ADMIN resolves to no organizer capability", () => {
        const vestigial = makeScope({
            platformRole: "CUSTOMER",
            organizerScopes: [membership(ORG_A, "ADMIN")],
        });

        // The membership is ACTIVE, so the isolation gate passes...
        expect(hasActiveMembership(vestigial, ORG_A)).toBe(true);

        // ...but no capability source grants anything, so it still denies.
        for (const permission of [
            PERMISSIONS.EVENT_READ,
            PERMISSIONS.EVENT_WRITE,
            PERMISSIONS.ORDER_READ_TENANT,
        ]) {
            expectDenied(
                decideOrganizerPermission(vestigial, ORG_A, permission),
                AuthzErrorCode.FORBIDDEN
            );
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Tenant isolation (cases A, B, C, D, F as pure decisions)
// ─────────────────────────────────────────────────────────────────────────────

describe("tenant isolation", () => {
    test("Case A — an active member may act in their own organizer", () => {
        const owner = makeScope({
            platformRole: "CUSTOMER",
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        expect(
            decideOrganizerPermission(owner, ORG_A, PERMISSIONS.EVENT_WRITE).allowed
        ).toBe(true);
    });

    test("Case B — a member of A cannot reach B, with a 404-shaped denial", () => {
        const ownerA = makeScope({
            platformRole: "CUSTOMER",
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        expectDenied(
            decideOrganizerPermission(ownerA, ORG_B, PERMISSIONS.EVENT_WRITE),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED
        );
    });

    test("Case C — swapping organizerId does not transfer authority", () => {
        const ownerA = makeScope({
            platformRole: "CUSTOMER",
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        // Same actor, same permission, two ids, opposite outcomes. The id is data;
        // the membership list is the authority.
        expect(
            decideOrganizerPermission(ownerA, ORG_A, PERMISSIONS.EVENT_WRITE).allowed
        ).toBe(true);
        expectDenied(
            decideOrganizerPermission(ownerA, ORG_B, PERMISSIONS.EVENT_WRITE),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED
        );
    });

    test("Case D — a PIC cannot escalate to manager/admin capability", () => {
        const pic = makeScope({
            platformRole: "PIC",
            organizerScopes: [membership(ORG_A, "PIC")],
        });

        expectDenied(
            decideOrganizerPermission(pic, ORG_A, PERMISSIONS.EVENT_WRITE),
            AuthzErrorCode.FORBIDDEN
        );
        expectDenied(
            decideOrganizerPermission(pic, ORG_A, PERMISSIONS.SETTLEMENT_APPROVE),
            AuthzErrorCode.FORBIDDEN
        );
        expectDenied(
            decidePlatformPermission(pic, PERMISSIONS.USER_MANAGE),
            AuthzErrorCode.FORBIDDEN
        );
    });

    test("Case F — a non-ACTIVE membership never authorizes", () => {
        for (const status of [
            "INVITED",
            "SUSPENDED",
            "REVOKED",
        ] as OrganizerMemberStatus[]) {
            const suspended = makeScope({
                platformRole: "ADMIN",
                organizerScopes: [membership(ORG_A, "OWNER", status)],
            });

            expect(hasActiveMembership(suspended, ORG_A)).toBe(false);
            expectDenied(
                decideOrganizerPermission(suspended, ORG_A, PERMISSIONS.EVENT_READ),
                AuthzErrorCode.ORGANIZER_ACCESS_DENIED
            );
        }
    });

    test("an actor with no memberships at all is denied", () => {
        const nobody = makeScope({ platformRole: "ADMIN" });

        expectDenied(
            decideOrganizerPermission(nobody, ORG_A, PERMISSIONS.EVENT_READ),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED
        );
    });

    test("organizer-scope and platform-scope permissions do not cross over", () => {
        const admin = makeScope({
            platformRole: "ADMIN",
            organizerScopes: [membership(ORG_A, "OWNER")],
        });

        // A platform permission cannot be satisfied by passing an organizer...
        expectDenied(
            decideOrganizerPermission(admin, ORG_A, PERMISSIONS.USER_MANAGE),
            AuthzErrorCode.FORBIDDEN
        );
        // ...and an organizer permission cannot be satisfied by the platform path.
        expectDenied(
            decidePlatformPermission(admin, PERMISSIONS.EVENT_WRITE),
            AuthzErrorCode.FORBIDDEN
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// OWN scope
// ─────────────────────────────────────────────────────────────────────────────

describe("OWN-scope permissions", () => {
    test("a PIC may read their own records", () => {
        const pic = makeScope({ platformRole: "PIC", userId: USER_1 });

        expect(
            decideOwnResourcePermission(pic, PERMISSIONS.PIC_FEE_READ_OWN, USER_1)
                .allowed
        ).toBe(true);
    });

    test("a PIC may not read another PIC's records", () => {
        const pic = makeScope({ platformRole: "PIC", userId: USER_1 });

        expectDenied(
            decideOwnResourcePermission(pic, PERMISSIONS.PIC_FEE_READ_OWN, USER_2),
            AuthzErrorCode.PIC_ACCESS_DENIED
        );
    });

    test("a tenant membership does not confer access to another user's records", () => {
        const manager = makeScope({
            platformRole: "MANAGER",
            userId: USER_1,
            organizerScopes: [membership(ORG_A, "MANAGER")],
        });

        expectDenied(
            decideOwnResourcePermission(manager, PERMISSIONS.PIC_FEE_READ_OWN, USER_2),
            AuthzErrorCode.PIC_ACCESS_DENIED
        );
    });

    test("an ADMIN has no own-scope fee, matching §6.2", () => {
        const admin = makeScope({ platformRole: "ADMIN", userId: USER_1 });

        expectDenied(
            decideOwnResourcePermission(admin, PERMISSIONS.PIC_FEE_READ_OWN, USER_1),
            AuthzErrorCode.FORBIDDEN
        );
    });

    test("a tenant-scoped permission cannot be resolved through the own-scope path", () => {
        const admin = makeScope({ platformRole: "ADMIN", userId: USER_1 });

        expectDenied(
            decideOwnResourcePermission(admin, PERMISSIONS.EVENT_WRITE, USER_1),
            AuthzErrorCode.FORBIDDEN
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 23A — every role that can buy a ticket can read its own order
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The buyer-facing own-scope capabilities a CUSTOMER holds.
 *
 * Shared here so the assertion is "an operator resolves their own purchase the
 * same way a customer does", rather than a second hand-written list that could
 * drift from `PLATFORM_ROLE_OWN_PERMISSIONS.CUSTOMER`.
 */
const BUYER_OWN_PERMISSIONS = [
    PERMISSIONS.ORDER_READ_OWN,
    PERMISSIONS.ORDER_CANCEL_OWN,
    PERMISSIONS.PAYMENT_READ_OWN,
    PERMISSIONS.TICKET_READ_OWN,
    PERMISSIONS.TICKET_ISSUE_OWN,
    PERMISSIONS.REFUND_REQUEST_OWN,
] as const;

describe("PHASE 23A — an operator can exercise their own buyer capabilities", () => {
    test("CUSTOMER, ADMIN and MANAGER all resolve the same buyer own-scope set", () => {
        for (const role of ["CUSTOMER", "ADMIN", "MANAGER"] as const) {
            const scope = makeScope({ platformRole: role, userId: USER_1 });

            for (const permission of BUYER_OWN_PERMISSIONS) {
                // Named in the message so a regression says WHICH role lost WHICH capability.
                expect({
                    role,
                    permission,
                    own: decideOwnResourcePermission(scope, permission, USER_1)
                        .allowed,
                }).toEqual({ role, permission, own: true });
            }
        }
    });

    test("own-scope is still identity-gated for an ADMIN — never another user's record", () => {
        const admin = makeScope({ platformRole: "ADMIN", userId: USER_1 });

        for (const permission of BUYER_OWN_PERMISSIONS) {
            expectDenied(
                decideOwnResourcePermission(admin, permission, USER_2),
                AuthzErrorCode.PIC_ACCESS_DENIED
            );
        }
    });

    test("granting buyer own-scope to ADMIN grants it no platform or tenant power", () => {
        const admin = makeScope({ platformRole: "ADMIN", userId: USER_1 });

        // The tenant-isolation and D-19 guarantees live in other maps and are unchanged:
        // an ADMIN still needs a membership for tenant data, and still needs an explicit
        // grant for an own-scope FINANCIAL capability.
        expectDenied(
            decideOrganizerPermission(admin, ORG_A, PERMISSIONS.ORDER_READ_TENANT),
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED
        );
        expectDenied(
            decideOwnResourcePermission(admin, PERMISSIONS.PIC_FEE_READ_OWN, USER_1),
            AuthzErrorCode.FORBIDDEN
        );
    });
});
