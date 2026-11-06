import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 3E — PIC SCANNER PAGE GUARDS (static)
 * ==========================================
 *
 * The page is a server component whose rendering needs a session and a database, so this
 * suite pins the properties that do not need either: which guard it calls, where it posts,
 * what it refuses to render, and the one service rule that protects a PIC from seeing
 * another operator's identity.
 *
 * Honest labelling: these are SOURCE GUARDS, not a rendered-DOM test and not database
 * evidence. The request path itself is covered by `pic-scan-api.test.ts` (mocked service)
 * and `pic-scan-authz.test.ts` (real guard + decider, mocked Prisma).
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments so a comment describing a pattern is never mistaken for the pattern. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAGE = "app/dashboard/pic/scan/[eventId]/page.tsx";
const SCANNER = "components/organizer/TicketScanner.tsx";
const SERVICE = "lib/ticketing/checkin/service.ts";
const PIC_DASHBOARD = "app/dashboard/pic/page.tsx";

describe("P3E-1. the PIC page authorizes on the server, fail-closed", () => {
    const page = code(read(PAGE));

    it("uses the PIC-only guard with the route's event id", () => {
        expect(page).toContain("requirePicScanAccess(eventId)");
        // It must not use the organizer/PIC combined API guard: an organizer member should
        // not reach the PIC scanner page, and a non-PIC refusal must be masked.
        expect(page).not.toContain("requireEventCheckInAccess");
    });

    it("maps every authorization refusal to notFound, never to a distinguishing error", () => {
        expect(page).toMatch(/isAuthzError\(error\)[\s\S]{0,80}notFound\(\)/);
        expect(page).not.toContain("AccessDeniedPanel");
    });

    it("derives the gate window from the canonical server predicate", () => {
        expect(page).toContain("isEventCheckInOpen(event, now)");
        expect(page).toContain('"CLOSED"');
        expect(page).toContain('"GRACE"');
    });
});

describe("P3E-2. the page uses the Phase 3D endpoint and hides attendance", () => {
    const page = code(read(PAGE));

    it("posts to the authenticated PIC route through the shared scanner", () => {
        expect(page).toContain("endpoint={`/api/pic/events/${event.id}/check-in`}");
        expect(page).not.toContain("/api/organizer/");
    });

    it("never enables the attendance log for a PIC", () => {
        expect(page).toContain("canReadLog={false}");
        expect(page).toContain("initialItems={[]}");
        expect(page).toContain("initialTotal={0}");
        expect(page).not.toContain("listEventCheckIns");
        expect(page).not.toContain("checkin.log.read");
    });

    it("passes no user, profile, assignment, role or permission to the device", () => {
        // The only identity-bearing input is the event id the guard uses to LOOK UP access.
        expect(page).not.toMatch(/userId=|profileId=|assignmentId=|role=|permission=/);
    });
});

describe("P3E-3. the shared scanner gains an endpoint override, nothing else", () => {
    const scanner = code(read(SCANNER));

    it("keeps the organizer route as the default", () => {
        expect(scanner).toContain("/api/organizer/events/${eventId}/check-in");
        expect(scanner).toContain("endpointProp ??");
    });

    it("declares the override as optional so the staff page is unchanged", () => {
        expect(scanner).toMatch(/endpoint\?: string;/);
    });

    it("keeps the in-flight and duplicate-frame guards", () => {
        expect(scanner).toContain("busyRef.current");
        expect(scanner).toContain("createScanThrottle");
        expect(scanner).toContain("releaseCamera");
    });
});

describe("P3E-4. a PIC response carries no other operator's identity", () => {
    const service = code(read(SERVICE));

    it("marks which gate admitted the request", () => {
        expect(service).toContain('actorKind: "ORGANIZER"');
        expect(service).toContain('actorKind: "PIC"');
    });

    it("nulls firstCheckedInBy for a PIC caller", () => {
        expect(service).toContain(
            'actorKind === "PIC"\n                                ? null'
        );
    });

    it("exports a page guard that still runs through the Phase 3A decider", () => {
        expect(service).toContain(
            "export async function requirePicScanAccess"
        );
        expect(service).toContain("return requirePicCheckInAccess(");
        expect(service).toContain("decidePicEventPermission({");
    });
});

describe("P3E-5. the PIC dashboard offers the scanner only for active assignments", () => {
    const dashboard = code(read(PIC_DASHBOARD));

    it("links to the scan page with the assignment's own event id", () => {
        expect(dashboard).toContain(
            "/dashboard/pic/scan/${assignment.eventId}"
        );
        expect(dashboard).toMatch(/assignment\.isActive \? \(/);
    });
});
