/**
 * ==========================================
 * PHASE 32 — MAINTENANCE MODE (PURE DECISION)
 * ==========================================
 *
 * Availability is a decision about a PATH and a ROLE, and the two failure modes the brief
 * names are exactly the two a pure function can be exhaustively tested against:
 *
 *   "Do not create a redirect loop."          → the exempt path set is enumerated below.
 *   "Do not block the ADMIN from turning
 *    maintenance OFF."                        → the dashboard rule is a role rule, not a path rule.
 *
 * Nothing here touches the database or React, so a regression is a failing assertion rather
 * than a manual click-through of a closed site.
 */

import type { PlatformRole } from "@prisma/client";

import type { MaintenanceState } from "@/lib/app-settings";
import {
    MAINTENANCE_EXEMPT_API_PREFIXES,
    MAINTENANCE_EXEMPT_PAGE_PREFIXES,
    MAINTENANCE_PATH,
    assertNotInMaintenance,
    assertPurchasingAvailable,
    isMaintenanceExemptApi,
    isMaintenanceExemptPage,
    maintenanceBlocksPage,
} from "@/lib/maintenance";

/** Every role, so a new one cannot silently escape the matrix. */
const ALL_ROLES: readonly (PlatformRole | null)[] = [
    "ADMIN",
    "MANAGER",
    "PIC",
    "CUSTOMER",
    null,
];

function state(over: Partial<MaintenanceState> = {}): MaintenanceState {
    return {
        enabled: true,
        message: "Website sedang dalam maintenance.",
        etaMessage: null,
        ...over,
    };
}

/* ==================================================================================
 * 1. THE EXEMPT SET — WHAT MAINTENANCE MUST NEVER CLOSE
 * ================================================================================== */

describe("the exempt paths are closed, explicit data", () => {
    test("the block target is exempt, so the redirect cannot re-enter itself", () => {
        expect(MAINTENANCE_PATH).toBe("/maintenance");
        expect(isMaintenanceExemptPage(MAINTENANCE_PATH)).toBe(true);

        // The redirect-loop assertion, stated as the property that matters: for EVERY role,
        // the maintenance page itself is never blocked. A single `true` here would mean the
        // redirect target redirects to itself.
        for (const role of ALL_ROLES) {
            expect({
                role,
                blocked: maintenanceBlocksPage(MAINTENANCE_PATH, role),
            }).toEqual({ role, blocked: false });
        }
    });

    test("/login stays reachable — ADMIN recovery requires a session", () => {
        expect(isMaintenanceExemptPage("/login")).toBe(true);
        expect(maintenanceBlocksPage("/login", null)).toBe(false);
    });

    test("a prefix is not a substring match", () => {
        // `/login-something` is NOT the login page, and treating it as one would let a
        // similarly-named route stay open by accident.
        expect(isMaintenanceExemptPage("/login-history")).toBe(false);
        expect(isMaintenanceExemptPage("/maintenance-report")).toBe(false);
    });

    test("health, auth, jobs and uploads stay reachable on the API side", () => {
        for (const path of [
            "/api/health",
            "/api/health/ready",
            "/api/auth/session",
            "/api/internal/jobs/tick",
            "/api/uploads/branding/1700000000000-abc.png",
            "/api/uploads/events/1700000000000-abc.jpg",
        ]) {
            expect({ path, exempt: isMaintenanceExemptApi(path) }).toEqual({
                path,
                exempt: true,
            });
        }

        // …and nothing else does.
        for (const path of [
            "/api/ticketing/checkout",
            "/api/ticketing/orders/EVT-1/pay",
            "/api/events",
            "/api/sports",
        ]) {
            expect({ path, exempt: isMaintenanceExemptApi(path) }).toEqual({
                path,
                exempt: false,
            });
        }
    });

    test("the exempt lists are exported as data so they cannot drift from the tests", () => {
        expect(MAINTENANCE_EXEMPT_PAGE_PREFIXES).toContain(MAINTENANCE_PATH);
        expect(MAINTENANCE_EXEMPT_PAGE_PREFIXES).toContain("/login");
        expect(MAINTENANCE_EXEMPT_API_PREFIXES).toContain("/api/health");
        expect(MAINTENANCE_EXEMPT_API_PREFIXES).toContain("/api/uploads/");
    });
});

/* ==================================================================================
 * 2. THE PUBLIC SURFACE IS CLOSED TO EVERYONE BUT ADMIN-ON-DASHBOARD
 * ================================================================================== */

describe("while maintenance is ON", () => {
    test("the public pages are blocked for every role", () => {
        const publicPages = [
            "/",
            "/events",
            "/events?sort=newest",
            "/e/liga-basket-2026",
            "/faq",
            "/kontak",
            "/register",
            "/refund-policy",
            "/syarat-ketentuan",
            "/ticketing/tickets",
            "/ticketing/orders/EVT-2026-000001",
        ];

        for (const pathname of publicPages) {
            for (const role of ALL_ROLES) {
                expect({ pathname, role, blocked: maintenanceBlocksPage(pathname, role) })
                    .toEqual({ pathname, role, blocked: true });
            }
        }
    });

    test("the ADMIN keeps the dashboard — the only way back to OFF", () => {
        for (const pathname of [
            "/dashboard",
            "/dashboard/settings",
            "/dashboard/settings/application",
            "/dashboard/settings/maintenance",
            "/dashboard/settings/branding",
            "/dashboard/events",
        ]) {
            expect({
                pathname,
                blocked: maintenanceBlocksPage(pathname, "ADMIN"),
            }).toEqual({ pathname, blocked: false });
        }
    });

    test("MANAGER does NOT bypass maintenance (no architectural reason to admit them)", () => {
        // The brief's explicit requirement. A MANAGER holds full operational authority but no
        // application control, so a closed application is closed to them too.
        for (const pathname of [
            "/dashboard",
            "/dashboard/settings",
            "/dashboard/orders",
            "/dashboard/check-in",
        ]) {
            expect({
                pathname,
                blocked: maintenanceBlocksPage(pathname, "MANAGER"),
            }).toEqual({ pathname, blocked: true });
        }
    });

    test("PIC, CUSTOMER and an anonymous visitor are all blocked from the dashboard", () => {
        for (const role of ["PIC", "CUSTOMER", null] as const) {
            expect({
                role,
                blocked: maintenanceBlocksPage("/dashboard", role),
            }).toEqual({ role, blocked: true });
        }
    });

    test("the decision is a function of PATH and ROLE only — never of state", () => {
        // `maintenanceBlocksPage` takes no state argument by design: the caller checks
        // `enabled` first. That keeps the function total (it cannot be "accidentally on")
        // and makes the OFF case a single, greppable guard site.
        expect(maintenanceBlocksPage.length).toBe(2);
    });
});

/* ==================================================================================
 * 3. THE PURCHASE GUARD
 * ================================================================================== */

describe("assertPurchasingAvailable / assertNotInMaintenance", () => {
    test("does nothing while maintenance is OFF", () => {
        expect(() =>
            assertPurchasingAvailable(state({ enabled: false }))
        ).not.toThrow();

        expect(() =>
            assertNotInMaintenance(state({ enabled: false }))
        ).not.toThrow();
    });

    test("the money-path guard IS the general guard — one behaviour, two names", () => {
        // Delegation rather than duplication: the status, the echoed message and the `reason`
        // marker cannot drift between the purchase endpoints and the public read endpoints.
        const capture = (fn: () => void) => {
            try {
                fn();
                return null;
            } catch (error) {
                const appError = error as {
                    code?: string;
                    httpStatus?: number;
                    details?: Record<string, unknown>;
                };

                return {
                    code: appError.code,
                    httpStatus: appError.httpStatus,
                    details: appError.details,
                };
            }
        };

        expect(capture(() => assertPurchasingAvailable(state()))).toEqual(
            capture(() => assertNotInMaintenance(state()))
        );
    });

    test("refuses a purchase while maintenance is ON, with a machine-readable reason", () => {
        try {
            assertPurchasingAvailable(state());
            throw new Error("expected the guard to refuse");
        } catch (error) {
            const appError = error as {
                code?: string;
                httpStatus?: number;
                message?: string;
                details?: Record<string, unknown>;
            };

            // Existing registry code, not a new one: 503 SERVICE_UNAVAILABLE is exactly
            // "a dependency this request needed is not available".
            expect(appError.code).toBe("SERVICE_UNAVAILABLE");
            expect(appError.httpStatus).toBe(503);
            // The operator's own message is echoed: it is public-facing text by construction.
            expect(appError.message).toBe("Website sedang dalam maintenance.");
            // And a stable marker a client can branch on without parsing prose.
            expect(appError.details).toEqual({ reason: "MAINTENANCE_MODE" });
        }
    });
});
