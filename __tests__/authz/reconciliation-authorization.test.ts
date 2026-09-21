/**
 * ==========================================
 * PHASE 27E — WHO MAY RECONCILE A PAYMENT
 * ==========================================
 *
 * Reconciliation settles money, so its authorization is the first thing an auditor should be
 * able to read as a table. The capability already existed (`payment.reconcile`) and this
 * phase did not change the authorization model, so what this suite does is PIN the existing
 * decision: it calls the real decider (`decideOrganizerPermission`) with synthetic scopes
 * and asserts who passes.
 *
 * The contract, derived from the permission map rather than invented here:
 *
 *   ALLOWED   an ACTIVE membership in the payment's organizer whose role is OWNER,
 *             MANAGER or FINANCE; a platform MANAGER with such a membership; a platform
 *             ADMIN with BOTH such a membership AND an active `PermissionGrant` for it
 *   DENIED    the buyer (CUSTOMER), any PIC, and every platform role acting WITHOUT a
 *             membership — `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty, so no platform
 *             role reaches a tenant on its own
 *
 * It is pure: no database, no session, no network.
 */

/*
 * Imported from `permissions` and NOT the `@/lib/authz` barrel on purpose: the barrel pulls
 * in `guards`, which pulls in `auth.ts`, which imports `next-auth` (ESM, untransformed by
 * Jest). The decider itself is pure, so this suite needs no runtime at all — and keeping it
 * that way is a property worth preserving.
 */
import type {
    AuthzScope,
    GrantEntry,
    OrganizerScopeEntry,
} from "@/lib/authz/permissions";
import {
    ADMIN_GRANT_REQUIRED,
    ORGANIZER_SPANNING_PLATFORM_ROLES,
    PERMISSIONS,
    decideOrganizerPermission,
} from "@/lib/authz/permissions";
import type { OrganizerMemberRole, PlatformRole } from "@prisma/client";

const ORGANIZER = "org-reconcile";

function scope(params: {
    platformRole: PlatformRole;
    membership?: { role: OrganizerMemberRole; status: string } | null;
    organizerId?: string;
    grants?: GrantEntry[];
}): AuthzScope {
    const organizerScopes: OrganizerScopeEntry[] = params.membership
        ? [
              {
                  organizerId: params.organizerId ?? ORGANIZER,
                  role: params.membership.role,
                  status: params.membership
                      .status as OrganizerScopeEntry["status"],
              },
          ]
        : [];

    return {
        userId: "user-1",
        platformRole: params.platformRole,
        organizerScopes,
        grants: params.grants ?? [],
    };
}

const allowed = (s: AuthzScope, organizerId = ORGANIZER) =>
    decideOrganizerPermission(s, organizerId, PERMISSIONS.PAYMENT_RECONCILE)
        .allowed;

/** The denial CODE for a scope, so the shape of the refusal is asserted too. */
function decision(s: AuthzScope, organizerId = ORGANIZER) {
    return decideOrganizerPermission(
        s,
        organizerId,
        PERMISSIONS.PAYMENT_RECONCILE
    );
}

describe("payment.reconcile — the capability itself", () => {
    test("the permission exists and is grant-required for a platform ADMIN", () => {
        expect(PERMISSIONS.PAYMENT_RECONCILE).toBe("payment.reconcile");
        expect(ADMIN_GRANT_REQUIRED.has(PERMISSIONS.PAYMENT_RECONCILE)).toBe(
            true
        );
    });

    test("no platform role spans tenants", () => {
        // The single most important assumption behind "resolved from the record": an ADMIN
        // is not a super-tenant.
        expect([...ORGANIZER_SPANNING_PLATFORM_ROLES]).toEqual([]);
    });
});

describe("payment.reconcile — organizer membership roles", () => {
    test.each([
        ["OWNER"],
        ["MANAGER"],
        ["FINANCE"],
    ] as const)("an ACTIVE %s membership is allowed", (role) => {
        expect(
            allowed(scope({ platformRole: "CUSTOMER", membership: { role, status: "ACTIVE" } }))
        ).toBe(true);
    });

    test.each([
        ["CHECKIN_STAFF"],
        ["PIC"],
    ] as const)("an ACTIVE %s membership is NOT allowed", (role) => {
        // Gate staff and PICs operate the door; they do not touch money.
        expect(
            allowed(scope({ platformRole: "CUSTOMER", membership: { role, status: "ACTIVE" } }))
        ).toBe(false);
    });

    test.each([
        ["INVITED"],
        ["SUSPENDED"],
    ] as const)("a %s membership is NOT allowed, whatever its role", (status) => {
        expect(
            allowed(
                scope({
                    platformRole: "MANAGER",
                    membership: { role: "OWNER", status },
                })
            )
        ).toBe(false);
    });

    test("a membership in a DIFFERENT organizer does not help", () => {
        const other = scope({
            platformRole: "MANAGER",
            membership: { role: "OWNER", status: "ACTIVE" },
            organizerId: "some-other-org",
        });

        expect(allowed(other, ORGANIZER)).toBe(false);
    });
});

describe("payment.reconcile — platform roles", () => {
    test.each([
        ["CUSTOMER"],
        ["PIC"],
        ["MANAGER"],
        ["ADMIN"],
    ] as const)("platform %s with NO membership is denied", (platformRole) => {
        expect(allowed(scope({ platformRole }))).toBe(false);
    });

    /*
     * ADMIN is deliberately absent: it is the one role for which the membership is NOT
     * sufficient (D-19 makes `payment.reconcile` grant-required), and it has its own two
     * tests below. Adding it here would assert the opposite of the rule.
     */
    test.each([
        ["CUSTOMER"],
        ["PIC"],
        ["MANAGER"],
    ] as const)(
        "platform %s with an ACTIVE OWNER membership is allowed",
        (platformRole) => {
            // The membership is the authorization, not the platform role. Even a CUSTOMER
            // who owns an organizer may reconcile that organizer's payments — and nothing
            // else.
            expect(
                allowed(
                    scope({
                        platformRole,
                        membership: { role: "OWNER", status: "ACTIVE" },
                    })
                )
            ).toBe(true);
        }
    );

    test("a platform MANAGER may act through a FINANCE membership", () => {
        expect(
            allowed(
                scope({
                    platformRole: "MANAGER",
                    membership: { role: "FINANCE", status: "ACTIVE" },
                })
            )
        ).toBe(true);
    });

    test("a platform ADMIN with a membership but NO grant is denied", () => {
        // D-19: `payment.reconcile` is grant-required for ADMIN, so the membership alone is
        // not enough even though OWNER/MANAGER/FINANCE hold it by role.
        expect(
            allowed(
                scope({
                    platformRole: "ADMIN",
                    membership: { role: "OWNER", status: "ACTIVE" },
                })
            )
        ).toBe(false);
    });

    test("a platform ADMIN with a membership AND a matching active grant is allowed", () => {
        expect(
            allowed(
                scope({
                    platformRole: "ADMIN",
                    membership: { role: "OWNER", status: "ACTIVE" },
                    grants: [
                        {
                            organizerId: ORGANIZER,
                            permission: PERMISSIONS.PAYMENT_RECONCILE,
                        },
                    ],
                })
            )
        ).toBe(true);
    });

    test("a grant for a DIFFERENT permission does not unlock reconciliation", () => {
        expect(
            allowed(
                scope({
                    platformRole: "ADMIN",
                    membership: { role: "OWNER", status: "ACTIVE" },
                    grants: [
                        {
                            organizerId: ORGANIZER,
                            permission: PERMISSIONS.REFUND_APPROVE,
                        },
                    ],
                })
            )
        ).toBe(false);
    });
});

describe("payment.reconcile — the shape of a refusal", () => {
    test("a missing membership is ORGANIZER_ACCESS_DENIED (404, not 403)", () => {
        const result = decision(scope({ platformRole: "ADMIN" }));

        expect(result.allowed).toBe(false);

        // Design §7.4: a scope failure must not confirm the tenant exists. Phase 3 pinned
        // the 404 and the API layer preserves the authorization layer's status.
        if (!result.allowed) {
            expect(result.code).toBe("ORGANIZER_ACCESS_DENIED");
        }
    });

    test("a present-but-inactive membership is refused too", () => {
        const result = decision(
            scope({
                platformRole: "MANAGER",
                membership: { role: "OWNER", status: "SUSPENDED" },
            })
        );

        expect(result.allowed).toBe(false);
    });
});

describe("the reconciliation surface never offers a buyer path", () => {
    test("reconciliation is not an own-resource capability", () => {
        // Every buyer capability is scoped `*.own`. `payment.reconcile` is not one of them,
        // so an owner of a payment cannot reconcile it as a buyer — the operator route is
        // the only surface, and it is tenant-scoped.
        expect(PERMISSIONS.PAYMENT_RECONCILE).not.toMatch(/\.own$/);
    });
});
