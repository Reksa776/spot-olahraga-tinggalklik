import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 15 — LIFECYCLE UI WIRING (static)
 * ==========================================
 *
 * The organizer-facing half of the Phase 14 lock, asserted against the SOURCE rather than
 * rendered: the completion affordance, the gate's window labels, and the two facts the
 * browser must never invent (the clock and the grace duration).
 *
 * WHY STATIC, AND WHAT IT DOES NOT CLAIM
 * --------------------------------------
 * These are architectural assertions — "the ONLY place a grace number exists is
 * `lib/events/lifecycle.ts`", "the completion button is offered exactly where the service
 * accepts it", "the window label is derived from the canonical predicate" — and each is a
 * property of the code, not of one render. Behaviour is covered where it can be executed:
 * `__tests__/events/lifecycle-integration.integration.test.ts` for the service and the real
 * database, `__tests__/jobs/tick.test.ts` for the scheduler, and
 * `__tests__/ticketing-checkin/*` for the gate. Nothing here replaces an execution test.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** The source of one top-level function, from its declaration to the closing brace at col 0. */
function functionBody(relativePath: string, declaration: string): string {
    const lines = read(relativePath).split("\n");
    const start = lines.findIndex((line) => line.startsWith(declaration));

    if (start === -1) {
        throw new Error(`${declaration} not found in ${relativePath}`);
    }

    const end = lines.indexOf("}", start);

    return lines.slice(start, end === -1 ? undefined : end + 1).join("\n");
}

const EVENT_ACTIONS = "components/organizer/EventActions.tsx";
const CHECK_IN_PANEL = "components/organizer/CheckInPanel.tsx";
const EVENT_DETAIL_PAGE = "app/dashboard/events/[id]/page.tsx";
const COMPLETE_ROUTE = "app/api/organizer/events/[id]/complete/route.ts";
const LIFECYCLE = "lib/events/lifecycle.ts";

describe("P15-U1. the grace window is defined once and re-used, never re-typed", () => {
    it("declares the constant in the lifecycle module and nowhere else", () => {
        const lifecycle = read(LIFECYCLE);

        expect(lifecycle).toContain("export const CHECK_IN_GRACE_MINUTES = 30");
        expect(lifecycle).toContain("CHECK_IN_GRACE_MINUTES * 60_000");
    });

    it("has no second numeric definition of the window anywhere in lib, app or components", () => {
        // The completion job and the gate must agree. A second literal — `30 * 60_000`,
        // `1_800_000` — is exactly how the two would silently drift apart.
        const files = [
            EVENT_ACTIONS,
            CHECK_IN_PANEL,
            EVENT_DETAIL_PAGE,
            COMPLETE_ROUTE,
            "lib/events/sales-state.ts",
            "lib/events/service.ts",
            "lib/ticketing/checkin/service.ts",
        ];

        for (const file of files) {
            const source = read(file);

            expect({ file, matches: /1_?800_?000|30 \* 60/.test(source) }).toEqual({
                file,
                matches: false,
            });
        }
    });
});

describe("P15-U2. the completion affordance matches the service's contract", () => {
    it("offers manual completion from PUBLISHED and ONGOING only", () => {
        const source = read(EVENT_ACTIONS);

        // One set, and it is the two source states (P14-D05). `COMPLETED` must not appear.
        expect(source).toMatch(/const COMPLETABLE = new Set\(\["PUBLISHED", "ONGOING"\]\)/);
        expect(source).toContain("Selesaikan event");
    });

    it("posts to the dedicated completion endpoint, not to a status field", () => {
        const source = read(EVENT_ACTIONS);

        expect(source).toContain("`/api/organizer/events/${eventId}/complete`");
        expect(source).toMatch(/completeEvent\(\)[\s\S]{0,400}method: "POST"/);
    });

    it("is disabled, with an explanation, when the event has no endAt", () => {
        const source = read(EVENT_ACTIONS);

        // P14-D22: an `endAt`-less event can never be completed, so the button says so
        // rather than sending a request the server will refuse.
        expect(source).toMatch(/disabled=\{busy !== null \|\| endAt === null\}/);
        expect(source).toContain("tidak dapat diselesaikan");
    });

    it("states the three consequences the Phase 14 lock promised", () => {
        const source = read(EVENT_ACTIONS);

        // Sales stop, nothing is deleted, and in-flight refunds continue. The copy is the
        // contract the operator reads before confirming.
        const dialog = source.slice(source.indexOf("Selesaikan event ini?"));

        expect(dialog).toContain("Penjualan tiket dihentikan");
        expect(dialog).toMatch(/[Tt]idak\s+ada data yang dihapus/);
        expect(dialog).toContain("refund yang sedang berjalan tetap diproses");
    });

    it("keeps the completion route behind the session, CSRF and tenant authorization", () => {
        const route = read(COMPLETE_ROUTE);

        expect(route).toContain("requireSameOrigin(request)");
        expect(route).toContain("requireAuth()");
        expect(route).toContain("completeEvent(scope, id, input, request)");
        // Strict payload: only a note. `status`/`completedAt`/`organizerId` are 400s.
        expect(route).toContain("parseOrThrow(completeEventSchema");
    });
});

describe("P15-U3. the gate's window is display-derived from the canonical predicate", () => {
    it("computes the window state on the server, from one `now` and the shared predicate", () => {
        const page = read(EVENT_DETAIL_PAGE);

        expect(page).toContain("isEventCheckInOpen(event, now)");
        expect(page).toContain("CHECK_IN_GRACE_MS");
        expect(page).toMatch(/const gateState: "OPEN" \| "GRACE" \| "CLOSED"/);
    });

    it("passes the window state and the soft flag into the panel instead of recomputing them", () => {
        const page = read(EVENT_DETAIL_PAGE);

        expect(page).toContain("gateState={gateState}");
        expect(page).toContain("requiresCheckIn={event.requiresCheckIn}");
    });

    it("labels each window honestly, and never as a security bypass", () => {
        const panel = read(CHECK_IN_PANEL);

        expect(panel).toContain('export type GateState = "OPEN" | "GRACE" | "CLOSED"');
        expect(panel).toContain('gateState === "GRACE"');
        expect(panel).toContain("Masa tenggang check-in");
        // P14-D13: `requiresCheckIn === false` is declared as OPTIONAL, and the panel keeps
        // working — the flag is a product statement, not an authorization switch, so the
        // scanner stays mounted and the copy says exactly that.
        expect(panel).toContain("Event ini tidak mewajibkan check-in.");
        expect(panel).toContain("Pemindai tetap dapat dipakai");
        expect(panel).toContain("tidak memengaruhi penyelesaian atau refund");

        // The soft state is a NOTICE, not a gate: nothing returns early before the form.
        expect(panel).not.toMatch(/if \(!requiresCheckIn\)\s*(return|throw)/);
    });

    it("does not let the browser's clock decide the window", () => {
        const panel = read(CHECK_IN_PANEL);

        // The panel receives the state; it must not derive it (no `Date.now()` in the
        // component that decides whether the door is open).
        expect(panel).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    });
});

describe("P15-U4. no lifecycle affordance was added for actors who must not have one", () => {
    it("keeps completion authority on `event.publish` — no new permission key", () => {
        const service = read("lib/events/service.ts");

        expect(service).toMatch(/export async function completeEvent\(/);
        expect(service).toContain("PERMISSIONS.EVENT_PUBLISH");
    });

    it("offers the buyer no completion or check-in control", () => {
        const wallet = read("app/ticketing/tickets/page.tsx");

        expect(wallet).not.toContain("Selesaikan event");
        expect(wallet).not.toContain("check-in");
    });
});

/* ==============================================================
 * PHASE 20B — the owner's Option A decisions
 * ============================================================== */

describe("P20B-U1. the gate predicate has no start-time term (D-P19-03 = A)", () => {
    /**
     * PHASE 20A §6 found the code and its own copy disagreeing: admission is possible from
     * publication, while the event page claimed the gate opened only for an event in
     * progress. The owner chose Option A — keep the behaviour, correct the words — so this
     * suite pins BOTH halves: the predicate must not grow a `startAt` term (that would be
     * Option B, a different decision), and the page must not describe one.
     */
    it("never reads `startAt` inside the predicate body", () => {
        const predicate = functionBody("lib/events/sales-state.ts", "export function isEventCheckInOpen");

        // It is the grace window that governs the closing side…
        expect(predicate).toContain("CHECK_IN_GRACE_MS");
        // …and nothing governs an opening side, which is Option A.
        expect(predicate).not.toMatch(/startAt/);
    });

    it("describes the real rule on the event page, not a start-time gate", () => {
        const page = read(EVENT_DETAIL_PAGE);

        // The corrected copy: admission opens at PUBLICATION and closes after the grace window.
        expect(page).toContain("Pintu masuk dibuka sejak event dipublikasikan");
        // The claim the code never implemented is gone.
        expect(page).not.toContain("hanya dibuka untuk event yang sedang berjalan");
    });
});

describe("P20B-U2. an event without an end time cannot be published (D-P19-05 = A)", () => {
    it("refuses an `endAt`-less event in the service, as a named precondition", () => {
        const service = read("lib/events/service.ts");

        // Enforced server-side only. The UI explanation below is a courtesy, never the rule.
        expect(service).toMatch(/if \(current\.endAt === null\) \{[\s\S]{0,200}unmet\.push\(/);
        expect(service).toContain("endAt: true");
    });

    it("disables the publish control, with an explanation, when there is no end time", () => {
        const source = read(EVENT_ACTIONS);

        expect(source).toMatch(/status === "DRAFT"[\s\S]{0,120}disabled=\{busy !== null \|\| endAt === null\}/);
        expect(source).toContain("tidak dapat dipublikasikan");
    });

    it("lists the new precondition in the readiness preview, so it cannot report 'ready'", () => {
        const manager = read("components/organizer/TicketTypeManager.tsx");
        const page = read(EVENT_DETAIL_PAGE);

        // The preview mirrors `publishEvent`'s preconditions. A third server-side condition
        // that the list does not know about would let the UI claim an event is ready when the
        // server refuses it — the exact class of drift Phase 20A flagged.
        expect(manager).toContain("Waktu selesai event sudah diisi");
        expect(manager).toContain("eventEndAt");
        expect(page).toContain("eventEndAt={event.endAt ? event.endAt.toISOString() : null}");
    });
});
