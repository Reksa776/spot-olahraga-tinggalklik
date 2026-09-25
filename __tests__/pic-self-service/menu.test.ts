/**
 * ==========================================
 * PIC SELF-SERVICE — DASHBOARD MENU (UNIT)
 * ==========================================
 *
 * The menu is pinned as pure data (`buildDashboardNav`) rather than a DOM render: the repo has
 * no testing-library/jsdom, and the component's own contract is that the sidebar is a rendering
 * of capability booleans — so the capability→rows mapping IS the behavior worth pinning.
 *
 * The role-matrix integration test already pins the capability OBJECTS each role receives
 * (including "a PIC role without a profile is refused"). This file pins what those booleans
 * BUY on screen:
 *
 *   · a pure PIC sees exactly the four own-scope rows and NOT the generic tenant dashboard,
 *   · an operator sees the generic dashboard row and not the PIC self-service rows,
 *   · a PIC row's presence is driven by the flag alone — never a role string (no role is passed
 *     to the builder to consult),
 *   · the same `Ringkasan` section can never render both the bare `/dashboard` row and the
 *     self-service rows from overlapping capability inputs, because the two are exact opposites
 *     of the SAME boolean.
 */

import { buildDashboardNav } from "@/components/dashboard/DashboardAppShell";
import type { DashboardCapabilities } from "@/lib/dashboard/scope";

type CapabilityOverrides = Partial<DashboardCapabilities>;

/** All falsy. Builders below flip only the booleans the scenario actually owns. */
function caps(overrides: CapabilityOverrides = {}): DashboardCapabilities {
    return {
        canManageSports: false,
        canManageGlobalVenues: false,
        canManagePlatformPic: false,
        canReadEvents: false,
        canManageEvents: false,
        canReadOrders: false,
        canReadPayments: false,
        canAssignPic: false,
        canManageVenues: false,
        canManageSettlements: false,
        canReadReports: false,
        canCheckIn: false,
        hasTenantAccess: false,
        hasActivePicProfile: false,
        // PHASE 34 — the menu is a function of capabilities, and the platform-role entry
        // right only admits the shell; it never adds a row, so it is OFF for every scenario
        // here.
        hasPlatformRoleEntry: false,
        // PHASE 32 — application control is ADMIN-only and OFF for every scenario in this
        // file, so the three ADMIN-only sections never render here; the role matrix owns the
        // positive cases.
        canManageApplicationSettings: false,
        canManageMaintenance: false,
        canManageBranding: false,
        canManageUsers: false,
        ...overrides,
    };
}

function allHrefs(capabilities: DashboardCapabilities): string[] {
    return buildDashboardNav(capabilities)
        .flatMap((group) => group.items)
        .map((item) => item.href);
}

function labels(capabilities: DashboardCapabilities): string[] {
    return buildDashboardNav(capabilities)
        .flatMap((group) => group.items)
        .map((item) => item.label);
}

/* ==================================================================================
 * TESTS 18 & 19 — a pure PIC gets exactly the self-service rows, nothing else
 * ================================================================================== */

describe("a pure PIC (flag only, no tenant/platform capability) is admitted to the self-service menu", () => {
    const purePic = caps({ hasActivePicProfile: true });

    test("the href set is exactly the four own-scope destinations, in section order", () => {
        expect(allHrefs(purePic)).toEqual([
            "/dashboard/pic",
            "/dashboard/pic#events",
            "/dashboard/pic#referrals",
            "/dashboard/pic#earnings",
        ]);
    });

    test("the labelled rows read as the self-service overview", () => {
        expect(labels(purePic)).toEqual([
            "Ringkasan PIC",
            "Event Saya",
            "Referral",
            "Pendapatan",
        ]);
    });

    test("the generic tenant dashboard row is NOT offered to a pure PIC", () => {
        expect(allHrefs(purePic)).not.toContain("/dashboard");
    });

    test("every back-office row still lives under /dashboard", () => {
        expect(allHrefs(purePic).every((href) => href.startsWith("/dashboard"))).toBe(
            true
        );
    });
});

/* ==================================================================================
 * TEST 20 — the flag is the ONLY switch between tenant dashboard and self-service
 * ================================================================================== */

describe("the generic tenant dashboard row is the exact inverse of hasActivePicProfile", () => {
    test("a bare operator with tenant access sees the generic row and no PIC rows", () => {
        const operator = caps({ hasTenantAccess: true, canReadOrders: true });

        expect(allHrefs(operator)).toContain("/dashboard");
        expect(allHrefs(operator)).not.toContain("/dashboard/pic");
    });

    test("an operator with PIC-management surface keeps their PIC row unreachable to the flag", () => {
        // An ADMIN/ORGANIZER uses the literal `/dashboard/pic` destination (the Orang section
        // row). But when the flag drove the rows, the flag is FALSE for every first-pass-eligible
        // actor — the layout only probes the DB on the way out. This is the exact same complement
        // at the navigational level: manager visibility is `canAssignPic || canManagePlatformPic`,
        // self-service visibility is the flag. The two rows are mutually exclusive inputs because
        // the layout guarantees one never fires with the other.
        const manager = caps({
            canManagePlatformPic: true,
            canAssignPic: false,
            hasActivePicProfile: true, // UNREACHABLE from the layout, but the builder must stay deterministic
        });

        expect(allHrefs(manager)).toContain("/dashboard/pic");

        const picRows = buildDashboardNav(manager)
            .flatMap((group) => group.items)
            .filter((item) => item.href.startsWith("/dashboard/pic"));
        expect(picRows.map((item) => item.href)).toEqual([
            "/dashboard/pic", // self-service Ringkasan PIC
            "/dashboard/pic#events",
            "/dashboard/pic#referrals",
            "/dashboard/pic#earnings",
            "/dashboard/pic", // Orang section management row
        ]);
    });

    test("fully empty capabilities still render exactly the inverse-of-flag row", () => {
        // Nothing is true except `!hasActivePicProfile`, so the ONLY row is the generic tenant
        // dashboard row. (Such an actor never reaches the shell — the layout refuses entry — the
        // point here is the complement holds: the flag row is the exact inverse, never a third
        // option.)
        expect(allHrefs(caps())).toEqual(["/dashboard"]);
        expect(buildDashboardNav(caps())).toHaveLength(1);
    });
});

/* ==================================================================================
 * TEST 21 — operator menus are byte-for-byte unchanged by the flag's introduction
 * ================================================================================== */

describe("the operator menu shape is untouched by the PIC flag", () => {
    function snapshot(capabilities: DashboardCapabilities) {
        return buildDashboardNav(capabilities).map((group) => ({
            label: group.label,
            hrefs: group.items.map((item) => item.href),
        }));
    }

    test("an ADMIN-like capability set produces the same menu it always did (no flag)", () => {
        const adminLike = caps({
            hasTenantAccess: true,
            canManageSports: true,
            canManageGlobalVenues: true,
            canManagePlatformPic: true,
            canReadEvents: true,
            canManageEvents: true,
            canReadOrders: true,
            canReadPayments: true,
            canAssignPic: false,
            canManageVenues: true,
            canReadReports: true,
            canCheckIn: true,
            hasActivePicProfile: false,
        });

        expect(snapshot(adminLike)).toMatchInlineSnapshot(`
[
  {
    "hrefs": [
      "/dashboard",
    ],
    "label": "Ringkasan",
  },
  {
    "hrefs": [
      "/dashboard/events",
      "/dashboard/check-in",
    ],
    "label": "Event & Tiket",
  },
  {
    "hrefs": [
      "/dashboard/orders",
      "/dashboard/customers",
      "/dashboard/payments",
      "/dashboard/refunds",
    ],
    "label": "Penjualan",
  },
  {
    "hrefs": [
      "/dashboard/pic",
    ],
    "label": "Orang",
  },
  {
    "hrefs": [
      "/dashboard/reports",
    ],
    "label": "Laporan",
  },
  {
    "hrefs": [
      "/dashboard/venues",
      "/dashboard/settings",
    ],
    "label": "Venue & Pengaturan",
  },
]
`);
    });

    test("an ORGANIZER-like set sees the same sections as before the feature (no flag)", () => {
        const organizerLike = caps({
            hasTenantAccess: true,
            canReadEvents: true,
            canManageEvents: true,
            canReadOrders: true,
            canReadPayments: true,
            canAssignPic: true,
            canManageVenues: true,
            canReadReports: true,
            canCheckIn: true,
            hasActivePicProfile: false,
        });

        expect(snapshot(organizerLike)).toMatchInlineSnapshot(`
[
  {
    "hrefs": [
      "/dashboard",
    ],
    "label": "Ringkasan",
  },
  {
    "hrefs": [
      "/dashboard/events",
      "/dashboard/check-in",
    ],
    "label": "Event & Tiket",
  },
  {
    "hrefs": [
      "/dashboard/orders",
      "/dashboard/customers",
      "/dashboard/payments",
      "/dashboard/refunds",
    ],
    "label": "Penjualan",
  },
  {
    "hrefs": [
      "/dashboard/pic",
    ],
    "label": "Orang",
  },
  {
    "hrefs": [
      "/dashboard/reports",
    ],
    "label": "Laporan",
  },
  {
    "hrefs": [
      "/dashboard/venues",
      "/dashboard/settings",
    ],
    "label": "Venue & Pengaturan",
  },
]
`);
    });
});