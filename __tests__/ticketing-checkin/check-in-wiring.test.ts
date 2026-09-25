import { readFileSync } from "node:fs";
import path from "node:path";

// The service resolves its scope through `lib/authz`, which imports the NextAuth
// configuration. Mocking the session module is the same seam every integration suite here
// uses; this suite never calls a service, it only imports the one pure helper beside it.
jest.mock("@/auth", () => ({ auth: jest.fn() }));

import {
    checkInListQuerySchema,
    checkInRequestSchema,
} from "@/lib/ticketing/checkin/validation";
import { normalizeCode } from "@/lib/ticketing/checkin/service";
import { isEventCheckInOpen } from "@/lib/events/sales-state";

/**
 * ==========================================
 * PHASE 13 — CHECK-IN WIRING GUARDS (pure + static)
 * ==========================================
 *
 * The check-in gate was CLOSED through Phase 10 (see the companion suite in
 * `__tests__/ui-consolidation/checkin-gate.test.ts`, which now records why it opened).
 * Phase 13 opens it for the one credential that actually exists — the public `ticketCode`
 * — so these guards pin the properties that make that safe, rather than the absence of a
 * feature:
 *
 *   • the code parser accepts exactly the two shapes a real code arrives in and refuses
 *     everything else;
 *   • the gate predicate fails closed for a cancelled or archived event;
 *   • the request schema cannot carry an organizer, an event, a status or an actor;
 *   • the service is the only writer, and it writes through a conditional update plus a
 *     UNIQUE-backed insert — never a read-then-write;
 *   • no QR-decoding dependency was added, and the raw scanner token is still never read.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * Strip comments, so a comment DESCRIBING a pattern is never mistaken for the pattern
 * itself — the convention Phases 6/7/8/10B established for their static guards.
 */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("P13-1. the presented code parser", () => {
    it("accepts a bare ticket code and the wallet QR payload, case-insensitively", () => {
        expect(normalizeCode("EVT-7K3M-AK9P")).toBe("EVT-7K3M-AK9P");
        expect(normalizeCode("TICKET:EVT-7K3M-AK9P")).toBe("EVT-7K3M-AK9P");
        // A hardware scanner or a human reading aloud may produce either.
        expect(normalizeCode("  evt-7k3m-ak9p  ")).toBe("EVT-7K3M-AK9P");
        expect(normalizeCode("ticket:evt-7k3m-ak9p")).toBe("EVT-7K3M-AK9P");
    });

    it("returns null for anything that cannot be a code", () => {
        // The alphabet deliberately excludes 0/1/I/L/O/U — the characters a person
        // transcribes wrongly. A code containing one is not a code.
        expect(normalizeCode("EVT-0000-1111")).toBeNull();
        expect(normalizeCode("EVT-7K3M-AK9")).toBeNull();
        expect(normalizeCode("TICKET:")).toBeNull();
        expect(normalizeCode("")).toBeNull();
        expect(normalizeCode("../../etc/passwd")).toBeNull();
        expect(normalizeCode("EVT-7K3M-AK9P;DROP TABLE ticket")).toBeNull();
    });

    it("does not treat a malformed code differently from an unknown one", () => {
        // Design §20.2 check 1: both must answer NOT_FOUND, or the error shape becomes an
        // oracle for probing the code space. The parser returns one indistinguishable
        // `null`, and the service maps it to the same NOT_FOUND as a lookup miss.
        const service = code(read("lib/ticketing/checkin/service.ts"));

        expect(service).toContain('reason: "INVALID_TICKET_FORMAT"');
        expect(service).toContain('reason: "TICKET_NOT_FOUND"');
        expect(service).toContain('throw await refuse({\n            result: "INVALID_TICKET"');
        expect(service).toContain('error: AppError.notFound("Tiket tidak ditemukan.")');
    });
});

describe("P13-2 / P15-1. the gate predicate fails closed, and is TIME-AWARE", () => {
    /**
     * PHASE 15 (P14-D06). The predicate gained `endAt` and a required `now`, because the
     * grace window is the whole point: a gate that cannot see the clock cannot close itself
     * after the event. The assertions below are the Phase 13 set EXTENDED with the window,
     * not weakened — every status row is still pinned, and the `COMPLETED` row changed from
     * "always open" to "open only inside the grace window", which is the locked contract.
     */
    const now = new Date("2026-09-19T12:00:00.000Z");
    const past = new Date(now.getTime() - 60 * 60_000); // 1 hour ago
    const withinGrace = new Date(now.getTime() - 10 * 60_000); // 10 minutes ago (< 30m)
    const beyondGrace = new Date(now.getTime() - 45 * 60_000); // 45 minutes ago (> 30m)
    const future = new Date(now.getTime() + 60 * 60_000);

    const live = (endAt: Date | null) => ({
        archivedAt: null,
        cancelledAt: null,
        endAt,
    });

    it("opens for a live event whose end has not passed", () => {
        expect(
            isEventCheckInOpen({ status: "PUBLISHED", ...live(future) }, now)
        ).toBe(true);
        expect(
            isEventCheckInOpen({ status: "ONGOING", ...live(future) }, now)
        ).toBe(true);
        expect(
            isEventCheckInOpen({ status: "ONGOING", ...live(withinGrace) }, now)
        ).toBe(true);
    });

    it("opens for a live event with no fixed end (a running/road event)", () => {
        expect(
            isEventCheckInOpen({ status: "PUBLISHED", ...live(null) }, now)
        ).toBe(true);
        expect(
            isEventCheckInOpen({ status: "ONGOING", ...live(null) }, now)
        ).toBe(true);
    });

    it("keeps COMPLETED open ONLY inside the 30-minute grace window", () => {
        // The Phase 13 assertion here was `COMPLETED => true`, unconditionally. That is the
        // behaviour the decision lock replaced: after grace the door must be shut.
        expect(
            isEventCheckInOpen({ status: "COMPLETED", ...live(withinGrace) }, now)
        ).toBe(true);
        expect(
            isEventCheckInOpen({ status: "COMPLETED", ...live(beyondGrace) }, now)
        ).toBe(false);
        expect(
            isEventCheckInOpen({ status: "COMPLETED", ...live(past) }, now)
        ).toBe(false);
    });

    it("closes a live event once the grace window has elapsed", () => {
        expect(
            isEventCheckInOpen({ status: "PUBLISHED", ...live(beyondGrace) }, now)
        ).toBe(false);
        expect(
            isEventCheckInOpen({ status: "ONGOING", ...live(beyondGrace) }, now)
        ).toBe(false);
    });

    it("refuses an endAt-less COMPLETED event — nothing to be inside the window of", () => {
        // P14-D22: an event with no `endAt` can never be completed, so a COMPLETED row with a
        // null end is not a state the lifecycle produces; if one exists it fails closed.
        expect(
            isEventCheckInOpen({ status: "COMPLETED", ...live(null) }, now)
        ).toBe(false);
    });

    it("refuses every status that has no door to open", () => {
        expect(
            isEventCheckInOpen({ status: "DRAFT", ...live(future) }, now)
        ).toBe(false);
        expect(
            isEventCheckInOpen({ status: "PENDING_REVIEW", ...live(future) }, now)
        ).toBe(false);
        expect(
            isEventCheckInOpen({ status: "CANCELLED", ...live(future) }, now)
        ).toBe(false);
        expect(
            isEventCheckInOpen({ status: "ARCHIVED", ...live(future) }, now)
        ).toBe(false);
    });

    it("refuses a cancelled or archived event even when its status still looks live", () => {
        // The schema carries both columns, so relying on `status` alone would be trusting
        // one of two values that can disagree.
        expect(
            isEventCheckInOpen(
                {
                    status: "PUBLISHED",
                    archivedAt: null,
                    cancelledAt: new Date(),
                    endAt: future,
                },
                now
            )
        ).toBe(false);

        expect(
            isEventCheckInOpen(
                {
                    status: "ONGOING",
                    archivedAt: new Date(),
                    cancelledAt: null,
                    endAt: future,
                },
                now
            )
        ).toBe(false);

        // …including inside the grace window, where the event would otherwise be shut anyway.
        expect(
            isEventCheckInOpen(
                {
                    status: "COMPLETED",
                    archivedAt: new Date(),
                    cancelledAt: null,
                    endAt: withinGrace,
                },
                now
            )
        ).toBe(false);
    });

    it("admits BEFORE startAt — the pre-start window is the owned decision, not an oversight", () => {
        // PHASE 20B (D-P19-03 = A, selected by the owner). The predicate takes no `startAt`,
        // so a published event whose start is weeks away has an open gate from the moment it
        // is published until `endAt + 30m`. Phase 20A surfaced this as a business rule (the
        // page's copy claimed the opposite) and the owner chose to KEEP the behaviour and
        // correct the words. This test pins the behaviour so a future change to the rule is a
        // deliberate failing test rather than a silent edit.
        const publishedStartingNextMonth = {
            status: "PUBLISHED" as const,
            ...live(future),
            startAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
        };

        expect(isEventCheckInOpen(publishedStartingNextMonth, now)).toBe(true);

        // The predicate's parameter type does not declare `startAt`, which is what makes the
        // behaviour above unreachable-by-accident: a caller cannot pass the field meaningfully
        // because the function never reads it. (The source-level assertion that the body
        // contains no `startAt` term lives in `lifecycle-ui-wiring.test.ts`.)
        const gate: Parameters<typeof isEventCheckInOpen>[0] =
            publishedStartingNextMonth;

        expect(gate.status).toBe("PUBLISHED");
        expect(gate.endAt).toEqual(future);
    });
});

describe("P13-3. what a scanner may and may not send", () => {
    it("accepts a code with optional non-authoritative metadata", () => {
        // A code alone is a complete request: everything else is optional context.
        expect(checkInRequestSchema.parse({ code: "EVT-7K3M-AK9P" })).toEqual({
            code: "EVT-7K3M-AK9P",
        });

        // An empty string means "not provided" — the same value as an explicit null, so the
        // service never stores an empty label where it means "no label".
        expect(
            checkInRequestSchema.parse({ code: "EVT-7K3M-AK9P", gateLabel: "" })
        ).toEqual({ code: "EVT-7K3M-AK9P", gateLabel: null });

        const parsed = checkInRequestSchema.parse({
            code: "EVT-7K3M-AK9P",
            gateLabel: "Pintu Utama",
            deviceId: "gate-1",
            clientScannedAt: "2026-01-01T10:00:00.000Z",
        });

        expect(parsed.gateLabel).toBe("Pintu Utama");
        expect(parsed.deviceId).toBe("gate-1");
        expect(parsed.clientScannedAt).toBeInstanceOf(Date);
    });

    it("rejects every field that would let a client assert authority", () => {
        const forbidden: Record<string, unknown>[] = [
            { code: "EVT-7K3M-AK9P", organizerId: "other-org" },
            { code: "EVT-7K3M-AK9P", eventId: "other-event" },
            { code: "EVT-7K3M-AK9P", ticketId: "other-ticket" },
            { code: "EVT-7K3M-AK9P", status: "CHECKED_IN" },
            { code: "EVT-7K3M-AK9P", checkedInAt: "2020-01-01T00:00:00.000Z" },
            { code: "EVT-7K3M-AK9P", checkedInByUserId: "someone-else" },
            { code: "EVT-7K3M-AK9P", result: "SUCCESS" },
        ];

        for (const body of forbidden) {
            expect(checkInRequestSchema.safeParse(body).success).toBe(false);
        }
    });

    it("requires a code, and bounds it", () => {
        expect(checkInRequestSchema.safeParse({}).success).toBe(false);
        expect(checkInRequestSchema.safeParse({ code: "" }).success).toBe(false);
        expect(
            checkInRequestSchema.safeParse({ code: "x".repeat(200) }).success
        ).toBe(false);
    });

    it("refuses an unparseable client timestamp instead of silently ignoring it", () => {
        expect(
            checkInRequestSchema.safeParse({
                code: "EVT-7K3M-AK9P",
                clientScannedAt: "not-a-date",
            }).success
        ).toBe(false);
    });

    it("bounds the attendance page size", () => {
        expect(checkInListQuerySchema.parse({})).toEqual({ limit: undefined });
        expect(checkInListQuerySchema.parse({ limit: "20" })).toEqual({ limit: 20 });
        expect(checkInListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
        expect(checkInListQuerySchema.safeParse({ limit: "1000" }).success).toBe(false);
    });
});

describe("P13-4. the service is the only writer, and it is CAS-guarded", () => {
    const service = code(read("lib/ticketing/checkin/service.ts"));

    it("transitions with a conditional update inside one transaction", () => {
        // `UPDATE … WHERE id = ? AND status = 'ISSUED'` is what makes two simultaneous
        // scanners resolve to exactly one winner without an application-level lock.
        expect(service).toContain("tx.ticket.updateMany({");
        expect(service).toContain('status: "ISSUED"');
        expect(service).toContain("checkedInAt: null");
        expect(service).toContain('data: { status: "CHECKED_IN", checkedInAt: now }');
        expect(service).toContain("cas.count !== 1");
    });

    it("writes exactly one accepted admission, backed by the UNIQUE ticketId", () => {
        expect(service).toContain("tx.checkIn.create({");
        expect(service).toContain('result: "SUCCESS"');

        // The database's own guarantee, asserted where it lives rather than restated here.
        const schema = read("prisma/schema.prisma");
        expect(schema).toContain("ticketId            String?       @unique");
    });

    it("requires a tenant-scoped scan permission and, for gate staff, an event assignment", () => {
        expect(service).toContain("PERMISSIONS.CHECKIN_SCAN");
        expect(service).toContain("PERMISSIONS.CHECKIN_OVERRIDE");
        expect(service).toContain("prisma.staffEventAssignment.findFirst({");
        expect(service).toContain("revokedAt: null");
        expect(service).toContain("NO_STAFF_ASSIGNMENT");
    });

    it("reads the event's tenant from the row, never from the caller's body", () => {
        expect(service).toContain("requireEventAccess(");

        // The service is handed an `eventId` by the ROUTE (authorized there and again here);
        // what must never happen is reaching for authority on the parsed body. `params.input`
        // is the client payload — `params.eventId` and `params.request` are the route's.
        expect(service).not.toMatch(/params\.input\.(organizerId|eventId|status|ticketId)/);
        expect(service).not.toMatch(/params\.input\.checkedIn/);
    });

    it("never reads the raw scanner token or its hash", () => {
        // D-46 (how a scanner obtains the token) is still open, and Phase 13 implements the
        // manual-code path only. `qrTokenHash` may appear in prose; it must never be a
        // projection field or a comparison operand.
        expect(service).not.toMatch(/qrTokenHash\s*:/);
        expect(service).not.toMatch(/hashQrToken/);
        expect(service).toContain('const CHECK_IN_METHOD: CheckInMethod = "MANUAL"');
        expect(service).not.toContain('"QR_SCAN"');
    });

    it("records both an accepted admission and a refusal", () => {
        const audit = code(read("lib/ticketing/audit-log.ts"));

        expect(audit).toContain('"checkin.success"');
        expect(audit).toContain('"checkin.rejected"');
        expect(service).toContain('action: "checkin.success"');
        expect(service).toContain('action: "checkin.rejected"');
    });

    it("does not move money or inventory", () => {
        // A gate scan is a status change on one ticket. Touching payments, orders, quota or
        // refunds here would be a Phase 10B violation, so the module has no handle on them.
        expect(service).not.toContain("ticketType.update");
        expect(service).not.toContain("receiptSender");
        expect(service).not.toContain("payment");
    });

    it("reads refund CLAIMS to refuse an admission, and writes nothing about money", () => {
        // PHASE 15 (P14-D15 — D-28). The previous form of this guard was
        // `expect(service).not.toContain("refund")`, which was correct while the gate ignored
        // refunds entirely and is now WRONG: the gate must read `RefundItem`/`Refund.status`
        // to refuse a claimed ticket. The guard is therefore replaced, not deleted, by the
        // stronger property it was approximating — the gate may READ a claim, and must not
        // touch a single monetary field or call any refund write path.
        expect(service).toContain("refundItem");
        expect(service).toContain("OPEN_REFUND_STATUSES");
        expect(service).toContain('reason: "REFUND_PENDING"');

        // No refund mutation, no money columns, no refund service import.
        expect(service).not.toMatch(/refund\.(create|update|updateMany|delete)/);
        expect(service).not.toMatch(/refundItem\.(create|update|updateMany|delete)/);
        expect(service).not.toMatch(/requestedAmount|confirmedAmount|refundedAmount/);
        expect(service).not.toContain("refunds/service");
    });
});

describe("P13-5. the API surface", () => {
    it("is under the protected organizer prefix", () => {
        const proxy = read("proxy.ts");

        expect(proxy).toContain('"/api/organizer/"');
    });

    it("authenticates, checks same-origin, and validates before touching the service", () => {
        const route = read("app/api/organizer/events/[id]/check-in/route.ts");

        expect(route).toContain("requireAuth()");
        expect(route).toContain("requireSameOrigin(request)");
        expect(route).toContain("parseOrThrow(checkInRequestSchema");
        expect(route).toContain("checkInTicket({");
        expect(route).toContain("listEventCheckIns(");
    });

    it("exposes no scanner secret in its response", () => {
        const route = read("app/api/organizer/events/[id]/check-in/route.ts");

        expect(route).not.toMatch(/qrTokenHash|qrToken|attendeeEmail|attendeePhone/);
    });
});

describe("P13-6 / PHASE 21. the only scanner dependency is the intentional jsQR decoder", () => {
    it("ships jsQR and no other QR-decoding library", () => {
        const pkg = JSON.parse(read("package.json")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
        };

        const names = [
            ...Object.keys(pkg.dependencies ?? {}),
            ...Object.keys(pkg.devDependencies ?? {}),
        ].join(" ");

        // PHASE 21 — jsQR is the ONE decoder added, deliberately, to give browsers
        // without `BarcodeDetector` (Firefox/Safari/desktop Linux) a working camera scan.
        expect(names).toMatch(/\bjsqr\b/i);
        expect(names).not.toMatch(
            /qr-scanner|zxing|html5-qrcode|instascan|quagga|@zxing/i
        );
    });

    it("uses the wallet QR payload's existing prefix rather than a second encoding", () => {
        expect(code(read("lib/ticketing/checkin/service.ts"))).toContain(
            "TICKET_QR_PREFIX"
        );
        expect(read("lib/ticketing/tickets/reference.ts")).toContain(
            'TICKET_QR_PREFIX = "TICKET:"'
        );
    });
});
