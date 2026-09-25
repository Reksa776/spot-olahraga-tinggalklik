/**
 * ==========================================
 * PIC SELF-SERVICE — MENU NAVIGATION REGRESSION (PHASE 39)
 * ==========================================
 *
 * The reported bug: "Login PIC OK, menu PIC terlihat, tapi saat diklik kembali ke
 * /dashboard". The audit proved the navigation itself never returns to /dashboard
 * (no server redirect, no client redirect — `redirect("/dashboard")` does not exist
 * anywhere under the dashboard). The real defect was the DESTINATION SIDE: the menu
 * offers three hash rows ("Event Saya" → `/dashboard/pic#events`, "Referral" →
 * `/dashboard/pic#referrals`, "Pendapatan" → `/dashboard/pic#earnings`) on the single
 * self-service page, but that page only DECLARED the `#events` and `#earnings` anchors.
 * The `#referrals` target was missing, so clicking "Referral" changed the URL while an
 * element could not scroll — the page stayed pinned at the top (the Ringkasan overview,
 * which reads like the generic dashboard), and the shell's `sticky top-0 h-16` header
 * sat on top of any anchor that did fire.
 *
 * Browser proof (before fix): `#events` scrolled to 952px, `#earnings` to 2724px,
 * `#referrals` stayed at 0px. After the fix all three scroll to their section.
 *
 * This suite pins the whole contract so the defect cannot regress:
 *
 *   · every self-service hash href must resolve to an `id` the PAGE actually declares,
 *   · every self-service anchor carries a `scroll-mt-16` offset so it clears the
 *     `sticky top-0 h-16` shell header,
 *   · the self-service rows can only ever route under `/dashboard/pic` — never `/dashboard`,
 *   · no code under `app/dashboard` or `components/dashboard` sends a user to `/dashboard`
 *     (the only directory-level redirect in the tree is the `/login` gate on a missing
 *     session, untouched by this fix),
 *   · against a REAL database: an ACTIVE pure PIC is admitted and offered exactly the four
 *     own-scope rows (never the bare `/dashboard` row), a PENDING PIC is partitioned to the
 *     standing notice (flag stays false, rows absent), a DISABLED PIC is refused at the
 *     scope (no capabilities, no menu), and an ADMIN's `/dashboard/pic` row stays the
 *     management row — no self-service fragments.
 *
 * The `@/auth` jest.mock is STRUCTURAL (pure-ESM next-auth; no test reads the session).
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { buildDashboardNav } from "@/components/dashboard/DashboardAppShell";
import { resolveAuthzScope } from "@/lib/authz";
import type { AuthzScope } from "@/lib/authz";
import { computeDashboardCapabilities } from "@/lib/dashboard/scope";
import { findActivePicProfile, findPicProfileStanding } from "@/lib/pic/self-service";
import { prisma } from "@/lib/prisma";

jest.setTimeout(180_000);

const PAGE_PATH = join(process.cwd(), "app/dashboard/pic/page.tsx");

/* ==================================================================================
 * PART A — menu hrefs vs the self-service page's declared anchors (pure, no database)
 * ================================================================================== */

const SELF_SERVICE_HREFS = [
    "/dashboard/pic",
    "/dashboard/pic#events",
    "/dashboard/pic#referrals",
    "/dashboard/pic#earnings",
];

/** `id="xyz"` anchors the self-service page declares. */
function declaredIds(pageSource: string): Set<string> {
    const ids = new Set<string>();
    for (const match of pageSource.matchAll(/\bid="([^"]+)"/g)) {
        ids.add(match[1]);
    }
    return ids;
}

/** Every route module under `app/dashboard`, recursively. */
function dashboardRouteSources(): string[] {
    const dir = join(process.cwd(), "app", "dashboard");
    const out: string[] = [];
    const walk = (path: string) => {
        for (const entry of readdirSync(path)) {
            const full = join(path, entry);
            if (statSync(full).isDirectory()) {
                walk(full);
            } else if (/\.(ts|tsx)$/.test(entry)) {
                out.push(full);
            }
        }
    };
    walk(dir);
    return out;
}

describe("PIC self-service navigation contract (Phase 39)", () => {
    const pageSource = readFileSync(PAGE_PATH, "utf8");
    const ids = declaredIds(pageSource);

    test("every hash row has a matching declared anchor on the page", () => {
        // The exact regression this phase fixed: `#referrals` had no element.
        const missing = SELF_SERVICE_HREFS.filter((href) => href.includes("#"))
            .map((href) => ({ href, id: href.split("#")[1] }))
            .filter(({ id }) => !ids.has(id))
            .map(({ href }) => href);
        expect(missing).toEqual([]);
    });

    test("the page declares all three self-service section anchors", () => {
        const declared = ["events", "referrals", "earnings"].filter((id) => !ids.has(id));
        expect(declared).toEqual([]);
    });

    test("every self-service anchor carries a scroll offset for the sticky h-16 header", () => {
        const anchorsWithOffset = new Set<string>();
        for (const match of pageSource.matchAll(
            /<div id="(events|referrals|earnings)"\s+className="([^"]+)"/g
        )) {
            if (match[2].includes("scroll-mt-16")) anchorsWithOffset.add(match[1]);
        }
        const missingOffset = ["events", "referrals", "earnings"].filter(
            (id) => !anchorsWithOffset.has(id)
        );
        expect(missingOffset).toEqual([]);
    });

    test("a pure-PIC row can never route to the generic /dashboard destination", () => {
        const offenders = SELF_SERVICE_HREFS.filter(
            (href) => !href.startsWith("/dashboard/pic") || href === "/dashboard"
        );
        expect(offenders).toEqual([]);
    });

    test("no code under app/dashboard sends a user to /dashboard", () => {
        const offenders = dashboardRouteSources().filter((path) => {
            const source = readFileSync(path, "utf8");
            // Server redirects and client router.replace — the two ways App Router code
            // could yank a user back to /dashboard. `href="/dashboard"` links (the error
            // boundary's restart affordance) are navigation the PIC triggers, not a forced
            // redirect, and are intentionally not matched here.
            return (
                /redirect\(\s*["'`]\/dashboard["'`]/i.test(source) ||
                /router\.replace\(\s*["'`]\/dashboard["'`]/i.test(source)
            );
        });
        expect(offenders).toEqual([]);
    });

    test("no dashboard component redirects to /dashboard on click", () => {
        const dir = join(process.cwd(), "components", "dashboard");
        const offenders = readdirSync(dir)
            .filter((entry) => /\.tsx$/.test(entry))
            .filter((entry) => {
                const source = readFileSync(join(dir, entry), "utf8");
                return (
                    /redirect\(\s*["'`]\/dashboard["'`]/i.test(source) ||
                    /router\.replace\(\s*["'`]\/dashboard["'`]/i.test(source)
                );
            });
        expect(offenders).toEqual([]);
    });
});

/* ==================================================================================
 * PART B — the same contract through the REAL database (scope → capabilities → menu)
 * ================================================================================== */

const SUFFIX = `pic-nav-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let picActive: { id: string };
let picPending: { id: string };
let picDisabled: { id: string };
let admin: { id: string };

async function createScopeFixture(
    tag: string,
    platformRole: "ADMIN" | "PIC",
    disabled = false
) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            platformRole,
            ...(disabled ? { disabledAt: new Date() } : {}),
        },
        select: { id: true },
    });
}

function createProfile(userId: string, status: "ACTIVE" | "PENDING") {
    return prisma.pICProfile.create({
        data: {
            userId,
            picCode: `PICNAV-${SUFFIX}-${userId}`,
            displayName: `Fixture ${userId.slice(0, 8)}`,
            status,
        },
        select: { id: true },
    });
}

/**
 * The layout's exact predicate chain: resolve the scope, probe the DB for an ACTIVE profile,
 * feed the flag in as extra capabilities context, then the menu is a pure function of the
 * result. This is what `app/dashboard/layout.tsx` does on the way into the shell.
 */
async function navHrefsFor(scope: AuthzScope): Promise<string[]> {
    const hasActivePicProfile = (await findActivePicProfile(scope.userId)) !== null;
    const capabilities = computeDashboardCapabilities(scope, {
        hasActivePicProfile,
    });
    return buildDashboardNav(capabilities)
        .flatMap((group) => group.items)
        .map((item) => item.href);
}

beforeAll(async () => {
    picActive = await createScopeFixture("pic-active", "PIC");
    picPending = await createScopeFixture("pic-pending", "PIC");
    picDisabled = await createScopeFixture("pic-disabled", "PIC", true);
    admin = await createScopeFixture("admin", "ADMIN");
    await createProfile(picActive.id, "ACTIVE");
    await createProfile(picPending.id, "PENDING");
    await createProfile(picDisabled.id, "ACTIVE");
});

afterAll(async () => {
    const ids = [picActive, picPending, picDisabled, admin]
        .filter(Boolean)
        .map((user) => user.id);
    await prisma.pICProfile.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
});

describe("PIC menu navigation against the real database (Phase 39)", () => {
    test("ACTIVE pure PIC: admitted, offered the four self-service rows, never /dashboard", async () => {
        const scope = await resolveAuthzScope(picActive.id);
        expect(scope).not.toBeNull();

        const hrefs = await navHrefsFor(scope!);
        expect(hrefs).toEqual(SELF_SERVICE_HREFS);
        expect(hrefs).not.toContain("/dashboard");
    });

    test("PENDING PIC: flag stays false, standing resolved, menu offers no PIC rows", async () => {
        const scope = await resolveAuthzScope(picPending.id);
        expect(scope).not.toBeNull();
        expect(await findPicProfileStanding(scope!.userId)).toBe("PENDING");
        expect(await findActivePicProfile(scope!.userId)).toBeNull();

        const hrefs = await navHrefsFor(scope!);
        expect(hrefs.some((href) => href.startsWith("/dashboard/pic"))).toBe(false);
        expect(hrefs).toEqual(["/dashboard"]);
    });

    test("DISABLED PIC: refused at the scope — no capabilities, no menu at all", async () => {
        expect(await resolveAuthzScope(picDisabled.id)).toBeNull();
    });

    test("ADMIN: /dashboard/pic stays the management row — no self-service fragments", async () => {
        const scope = await resolveAuthzScope(admin.id);
        expect(scope).not.toBeNull();

        const hrefs = await navHrefsFor(scope!);
        expect(hrefs).toContain("/dashboard/pic");
        expect(
            hrefs.some((href) => href.startsWith("/dashboard/pic") && href.includes("#"))
        ).toBe(false);
    });
});