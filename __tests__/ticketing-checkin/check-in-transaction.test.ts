import fs from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * PHASE 3C — CHECK-IN TRANSACTION (PARSER WIRED IN)
 * ==========================================
 *
 * Two kinds of evidence, deliberately kept apart:
 *
 *   • PURE / STATIC — the parser parity matrix, the canonical lookup key, the ordering of the
 *     transaction invariants in the source, and the request schema's refusal of every field
 *     that would let a client choose an outcome.
 *
 *   • MOCKED TRANSACTION — `checkInTicket` executed against an in-memory Prisma double. These
 *     tests prove the BRANCH STRUCTURE and the DATA WRITTEN. They prove nothing about InnoDB
 *     row locking, isolation or rollback; that evidence needs two real connections and belongs
 *     to Phase 3G. The mocked describe blocks say so in their names.
 *
 * Every module the service reaches through is substituted here for one of two reasons: it needs
 * a database (`@/lib/prisma`), it needs a session (`@/lib/authz`, `@/lib/events/access`), or it
 * starts a timer (`@/lib/rate-limit`). The parser, the method resolver and the reference module
 * are the REAL ones — they are the subject.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

jest.mock("@/lib/authz", () => ({
    PERMISSIONS: {
        CHECKIN_SCAN: "checkin.scan",
        CHECKIN_OVERRIDE: "checkin.override",
        CHECKIN_LOG_READ: "checkin.log.read",
    },
    decideOrganizerPermission: jest.fn(),
}));

jest.mock("@/lib/events/access", () => ({ requireEventAccess: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ getClientIp: jest.fn(() => null) }));
jest.mock("@/lib/realtime/publishers", () => ({
    publishTicketCheckedIn: jest.fn(),
}));
jest.mock("@/lib/ticketing/audit-log", () => ({
    writeTicketingAudit: jest.fn(),
}));

jest.mock("@/lib/prisma", () => ({
    prisma: {
        event: { findUniqueOrThrow: jest.fn() },
        organizerMember: { findFirst: jest.fn() },
        staffEventAssignment: { findFirst: jest.fn() },
        ticket: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
        checkIn: { create: jest.fn(), findFirst: jest.fn() },
        $transaction: jest.fn(),
    },
}));

import { checkInTicket, normalizeCode } from "@/lib/ticketing/checkin/service";
import { checkInRequestSchema } from "@/lib/ticketing/checkin/validation";
import { resolveCheckInMethod } from "@/lib/ticketing/checkin/method";
import { parseCheckInQrPayload } from "@/lib/ticketing/checkin/qr-payload";
import { TICKET_QR_PREFIX, isTicketCode } from "@/lib/ticketing/tickets/reference";

// ─────────────────────────────────────────────────────────────────────────────
// The doubles
// ─────────────────────────────────────────────────────────────────────────────

type MockedPrisma = {
    event: { findUniqueOrThrow: jest.Mock };
    organizerMember: { findFirst: jest.Mock };
    staffEventAssignment: { findFirst: jest.Mock };
    ticket: { findUnique: jest.Mock; findUniqueOrThrow: jest.Mock };
    checkIn: { create: jest.Mock; findFirst: jest.Mock };
    $transaction: jest.Mock;
};

type TxDouble = {
    $queryRaw: jest.Mock;
    refundItem: { findFirst: jest.Mock };
    ticket: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    checkIn: { create: jest.Mock };
};

const db = (jest.requireMock("@/lib/prisma") as { prisma: MockedPrisma }).prisma;
const access = jest.requireMock("@/lib/events/access") as {
    requireEventAccess: jest.Mock;
};
const authz = jest.requireMock("@/lib/authz") as {
    decideOrganizerPermission: jest.Mock;
};
const publish = jest.requireMock("@/lib/realtime/publishers") as {
    publishTicketCheckedIn: jest.Mock;
};
const audit = jest.requireMock("@/lib/ticketing/audit-log") as {
    writeTicketingAudit: jest.Mock;
};

const EVENT = {
    id: "event-1",
    title: "Gate Event",
    organizerId: "org-1",
    status: "PUBLISHED" as const,
    // Relative to the REAL clock: `isEventCheckInOpen` compares `endAt` with `new Date()` and a
    // fixed date would silently become "the event is over" once the calendar moved past it.
    endAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
    archivedAt: null,
    cancelledAt: null,
};

const TICKET = {
    id: "ticket-1",
    ticketCode: "EVT-2345-6789",
    status: "ISSUED" as const,
    checkedInAt: null,
    eventId: "event-1",
    attendeeName: "Budi",
    holderUserId: "buyer-1",
    ticketType: { name: "Reguler" },
};

let tx: TxDouble;

function admit(code: unknown) {
    return checkInTicket({
        eventId: EVENT.id,
        input: { code } as never,
    });
}

type CaughtError = {
    code?: string;
    status?: number;
    httpStatus?: number;
    message?: string;
    details?: Record<string, unknown>;
};

/** Await a call that must reject, and return the error without asserting its class. */
async function rejection(promise: Promise<unknown>): Promise<CaughtError> {
    let caught: unknown;

    try {
        await promise;
    } catch (error) {
        caught = error;
    }

    if (caught === undefined) {
        throw new Error("Expected the call to reject, but it resolved.");
    }

    return caught as CaughtError;
}

function recordedRefusal(): Record<string, unknown> {
    const calls = db.checkIn.create.mock.calls;

    if (calls.length === 0) {
        throw new Error("Expected a refusal row to be recorded.");
    }

    return (calls[0][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
    jest.resetAllMocks();

    tx = {
        $queryRaw: jest.fn().mockResolvedValue([{ id: TICKET.id }]),
        refundItem: { findFirst: jest.fn().mockResolvedValue(null) },
        ticket: {
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            findUniqueOrThrow: jest.fn(),
        },
        checkIn: { create: jest.fn().mockResolvedValue({ id: "checkin-1" }) },
    };

    db.$transaction.mockImplementation(
        (callback: (client: TxDouble) => Promise<unknown>) => callback(tx)
    );
    db.event.findUniqueOrThrow.mockResolvedValue({ ...EVENT });
    db.organizerMember.findFirst.mockResolvedValue(null);
    db.staffEventAssignment.findFirst.mockResolvedValue(null);
    db.ticket.findUnique.mockResolvedValue({ ...TICKET });
    db.ticket.findUniqueOrThrow.mockResolvedValue({
        status: "CHECKED_IN",
        checkedInAt: new Date("2026-09-19T11:00:00.000Z"),
    });
    db.checkIn.create.mockResolvedValue({ id: "refusal-1" });
    db.checkIn.findFirst.mockResolvedValue(null);

    access.requireEventAccess.mockResolvedValue({
        scope: { userId: "staff-1" },
        event: { id: EVENT.id, organizerId: EVENT.organizerId },
    });
    authz.decideOrganizerPermission.mockReturnValue({ allowed: true });
    audit.writeTicketingAudit.mockResolvedValue(undefined);
    publish.publishTicketCheckedIn.mockReturnValue(undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// A. The parser is the gate's only parser
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "..", "..");

function readSource(relativePath: string): string {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Comments removed, so prose about a pattern is never mistaken for the code. */
function codeOnly(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * The Phase 13 normaliser, reproduced verbatim as an ORACLE.
 *
 * The point is not that this copy is authoritative — the gate no longer contains it — but that
 * the parser must agree with the formula the gate used to run, on every input, or the swap
 * silently changed who gets through the door.
 */
function legacyNormalizeCode(raw: string): string | null {
    let value = raw.trim();

    if (value.toUpperCase().startsWith(TICKET_QR_PREFIX)) {
        value = value.slice(TICKET_QR_PREFIX.length).trim();
    }

    value = value.toUpperCase();

    return isTicketCode(value) ? value : null;
}

describe("C1 — the parser reproduces the gate's acceptance set exactly", () => {
    const MATRIX: string[] = [
        "EVT-2345-6789",
        "evt-2345-6789",
        "  EVT-2345-6789  ",
        "TICKET:EVT-2345-6789",
        "ticket:evt-2345-6789",
        "Ticket:Evt-2345-6789",
        "  TICKET:EVT-2345-6789  ",
        "TICKET:  EVT-2345-6789  ",
        "TICKET:EVT-2345-6789\n",
        // The row Phase 3B's parser got wrong, and Phase 3C corrected: a space before the
        // colon is not our namespace, so the gate refused it and the parser must too.
        "TICKET :EVT-2345-6789",
        "TICKET : EVT-2345-6789",
        "ticket :evt-2345-6789",
        "TICKET:",
        "ticket:   ",
        "TICKET:TICKET:EVT-2345-6789",
        "EVT-2345-6789:extra",
        "OTHER:EVT-2345-6789",
        "TIKET:EVT-2345-6789",
        "https://example.test/t/EVT-2345-6789",
        "mailto:buyer@example.test",
        "",
        "   ",
        "EVT-0000-0000",
        "EVT-2345",
        "a".repeat(64),
        "EVT-2345-6789;DROP TABLE ticket",
        `TICKET:${"A".repeat(200)}`,
    ];

    test.each(MATRIX)(
        "the parser and the legacy formula agree on %p",
        (input) => {
            const parsed = parseCheckInQrPayload(input);
            const expected = legacyNormalizeCode(input);

            expect(parsed.valid ? parsed.ticketCode : null).toBe(expected);
            // The exported compatibility surface delegates to the parser, so it must agree too.
            expect(normalizeCode(input)).toBe(expected);
        }
    );

    test("the integration is one parser, not two", () => {
        const service = codeOnly(readSource("lib/ticketing/checkin/service.ts"));

        expect(service).toContain("parseCheckInQrPayload(params.input.code)");
        expect(service).toContain("parsed.ticketCode");

        // No second copy of the code pattern, the namespace literal, or the folding rules.
        expect(service).not.toContain("TICKET_QR_PREFIX");
        expect(service).not.toContain("isTicketCode");
        expect(service).not.toMatch(/EVT-\[/);
        expect(service).not.toMatch(/\.toUpperCase\(\)\.startsWith/);
    });

    test("the lookup uses the canonical code, never the submitted text", async () => {
        await admit("  ticket:evt-2345-6789  ");

        expect(db.ticket.findUnique).toHaveBeenCalledTimes(1);

        const [query] = db.ticket.findUnique.mock.calls[0] as [
            { where: { ticketCode: string } },
        ];

        expect(query.where.ticketCode).toBe("EVT-2345-6789");
        expect(JSON.stringify(db.ticket.findUnique.mock.calls)).not.toContain(
            "ticket:evt"
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. MOCKED TRANSACTION — branch structure and data, not locking
// ─────────────────────────────────────────────────────────────────────────────

describe("C2 — MOCKED TRANSACTION: the admission sequence", () => {
    test("locks, guards, CASes, then inserts — in that order, in one transaction", async () => {
        const result = await admit("TICKET:EVT-2345-6789");

        expect(result.result).toBe("SUCCESS");
        expect(result.method).toBe("MANUAL");
        expect(result.ticket.status).toBe("CHECKED_IN");

        expect(db.$transaction).toHaveBeenCalledTimes(1);

        const lock = tx.$queryRaw.mock.invocationCallOrder[0];
        const guard = tx.refundItem.findFirst.mock.invocationCallOrder[0];
        const cas = tx.ticket.updateMany.mock.invocationCallOrder[0];
        const insert = tx.checkIn.create.mock.invocationCallOrder[0];

        expect(lock).toBeLessThan(guard);
        expect(guard).toBeLessThan(cas);
        expect(cas).toBeLessThan(insert);

        const [casArgs] = tx.ticket.updateMany.mock.calls[0] as [
            {
                where: Record<string, unknown>;
                data: Record<string, unknown>;
            },
        ];

        expect(casArgs.where).toMatchObject({
            id: TICKET.id,
            status: "ISSUED",
            checkedInAt: null,
        });
        expect(casArgs.data).toMatchObject({ status: "CHECKED_IN" });

        const [insertArgs] = tx.checkIn.create.mock.calls[0] as [
            { data: Record<string, unknown> },
        ];

        expect(insertArgs.data).toMatchObject({
            ticketId: TICKET.id,
            eventId: EVENT.id,
            organizerId: EVENT.organizerId,
            checkedInByUserId: "staff-1",
            result: "SUCCESS",
            method: "MANUAL",
        });

        // Only the accepted admission is evidence; no refusal row was written.
        expect(db.checkIn.create).not.toHaveBeenCalled();
        expect(publish.publishTicketCheckedIn).toHaveBeenCalledTimes(1);
    });

    test("an open refund claim refuses before the CAS is attempted", async () => {
        tx.refundItem.findFirst.mockResolvedValue({ id: "refund-item-1" });

        const error = await rejection(admit(TICKET.ticketCode));

        expect(error.code).toBe("CONFLICT");
        expect(error.details?.reason).toBe("REFUND_PENDING");

        expect(tx.ticket.updateMany).not.toHaveBeenCalled();
        expect(tx.checkIn.create).not.toHaveBeenCalled();
        expect(recordedRefusal()).toMatchObject({
            result: "REFUND_PENDING",
            ticketId: null,
        });
        expect(publish.publishTicketCheckedIn).not.toHaveBeenCalled();
    });

    test("a lost CAS reports the first admission and writes no accepted row", async () => {
        tx.ticket.updateMany.mockResolvedValue({ count: 0 });
        tx.ticket.findUniqueOrThrow.mockResolvedValue({
            status: "CHECKED_IN",
            checkedInAt: new Date("2026-09-19T10:00:00.000Z"),
        });
        db.checkIn.findFirst.mockResolvedValue({
            checkedInAt: new Date("2026-09-19T10:00:00.000Z"),
            gateLabel: "Pintu A",
            checkedInBy: { name: "Sari" },
        });

        const error = await rejection(admit(TICKET.ticketCode));

        expect(error.code).toBe("TICKET_ALREADY_CHECKED_IN");
        expect(error.details).toMatchObject({
            reason: "ALREADY_CHECKED_IN",
            ticketCode: TICKET.ticketCode,
            firstCheckedInBy: "Sari",
            firstGateLabel: "Pintu A",
        });

        expect(tx.checkIn.create).not.toHaveBeenCalled();
        expect(recordedRefusal()).toMatchObject({
            result: "ALREADY_CHECKED_IN",
            note: TICKET.ticketCode,
        });
        expect(publish.publishTicketCheckedIn).not.toHaveBeenCalled();
    });

    test.each([
        ["VOID", "INVALID_TICKET"],
        ["REFUNDED", "INVALID_TICKET"],
        ["RESERVED", "UNPAID"],
    ] as const)(
        "a %s ticket is refused and recorded as %s",
        async (status, expectedResult) => {
            tx.ticket.updateMany.mockResolvedValue({ count: 0 });
            tx.ticket.findUniqueOrThrow.mockResolvedValue({
                status,
                checkedInAt: null,
            });

            const error = await rejection(admit(TICKET.ticketCode));

            expect(error.code).toBe("CONFLICT");
            expect(error.details?.reason).toBe("TICKET_NOT_ISSUED");
            expect(error.details?.status).toBe(status);
            expect(recordedRefusal()).toMatchObject({ result: expectedResult });
        }
    );

    test("a failing accepted insert produces no success at all", async () => {
        tx.checkIn.create.mockRejectedValue(new Error("insert failed"));

        await expect(admit(TICKET.ticketCode)).rejects.toThrow("insert failed");

        expect(publish.publishTicketCheckedIn).not.toHaveBeenCalled();
        expect(db.checkIn.create).not.toHaveBeenCalled();

        const auditedActions = audit.writeTicketingAudit.mock.calls.map(
            (call) => (call[0] as { action: string }).action
        );

        expect(auditedActions).not.toContain("checkin.success");
    });

    test("the refusal writer never receives the raw submitted payload", async () => {
        const raw = "https://evil.test/TICKET:EVT-2345-6789";

        const error = await rejection(admit(raw));

        expect(error.code).toBe("NOT_FOUND");
        expect(db.ticket.findUnique).not.toHaveBeenCalled();
        expect(recordedRefusal()).toMatchObject({
            result: "INVALID_TICKET",
            note: "UNRECOGNIZED_CODE_FORMAT",
        });

        const everythingWritten = JSON.stringify([
            db.checkIn.create.mock.calls,
            audit.writeTicketingAudit.mock.calls,
        ]);

        expect(everythingWritten).not.toContain("evil.test");
        expect(everythingWritten).not.toContain(raw);
    });

    test("malformed and unsupported payloads are indistinguishable to the caller", async () => {
        const malformed = await rejection(admit("not-a-code"));
        const unsupported = await rejection(admit("https://evil.test/x"));

        expect(malformed.code).toBe(unsupported.code);
        expect(malformed.message).toBe(unsupported.message);
        expect(malformed.status ?? malformed.httpStatus).toBe(
            unsupported.status ?? unsupported.httpStatus
        );
    });

    test("an unknown ticket is refused without opening a transaction", async () => {
        db.ticket.findUnique.mockResolvedValue(null);

        const error = await rejection(admit("EVT-9999-2222"));

        expect(error.code).toBe("NOT_FOUND");
        expect(db.$transaction).not.toHaveBeenCalled();
        expect(recordedRefusal()).toMatchObject({
            result: "TICKET_NOT_FOUND",
            note: "EVT-9999-2222",
        });
    });

    test("another event's ticket is refused and the other event is not disclosed", async () => {
        db.ticket.findUnique.mockResolvedValue({
            ...TICKET,
            eventId: "event-2",
        });

        const error = await rejection(admit(TICKET.ticketCode));

        expect(error.code).toBe("CONFLICT");
        expect(error.details?.reason).toBe("WRONG_EVENT");
        expect(JSON.stringify(error.details)).not.toContain("event-2");
        expect(db.$transaction).not.toHaveBeenCalled();
    });

    test("a closed gate refuses before the parser or the lookup", async () => {
        db.event.findUniqueOrThrow.mockResolvedValue({
            ...EVENT,
            cancelledAt: new Date("2026-09-19T09:00:00.000Z"),
        });

        const error = await rejection(admit(TICKET.ticketCode));

        expect(error.code).toBe("CONFLICT");
        expect(error.details?.reason).toBe("EVENT_NOT_OPEN");
        expect(db.ticket.findUnique).not.toHaveBeenCalled();
        expect(tx.$queryRaw).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. CheckInMethod — evidence, not a label the caller can choose
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 — PUBLIC_TICKET_CODE is always MANUAL", () => {
    test("the resolver's answer is what the gate writes", () => {
        expect(resolveCheckInMethod("PUBLIC_TICKET_CODE")).toBe("MANUAL");

        const service = codeOnly(readSource("lib/ticketing/checkin/service.ts"));

        expect(service).toContain(
            'resolveCheckInMethod("PUBLIC_TICKET_CODE")'
        );
    });

    test("a camera-decoded wallet payload stays MANUAL", async () => {
        // The payload says `TICKET:` and arrives through the scanner path; neither proves a
        // secret was verified, so neither may relabel the admission.
        const result = await admit(`TICKET:${TICKET.ticketCode}`);

        expect(result.method).toBe("MANUAL");

        const [insertArgs] = tx.checkIn.create.mock.calls[0] as [
            { data: { method: string } },
        ];

        expect(insertArgs.data.method).toBe("MANUAL");
    });

    test("no request field can select a method, a result or an actor", () => {
        for (const forbidden of [
            { code: "EVT-2345-6789", method: "QR_SCAN" },
            { code: "EVT-2345-6789", checkInMethod: "QR_SCAN" },
            { code: "EVT-2345-6789", result: "SUCCESS" },
            { code: "EVT-2345-6789", checkedInAt: "2020-01-01T00:00:00.000Z" },
            { code: "EVT-2345-6789", checkedInByUserId: "someone-else" },
            { code: "EVT-2345-6789", ticketId: "other-ticket" },
        ]) {
            expect(checkInRequestSchema.safeParse(forbidden).success).toBe(false);
        }
    });

    test("QR_SCAN is never written by this gate", async () => {
        await admit(TICKET.ticketCode);
        await rejection(admit("nope"));

        const written = JSON.stringify([
            tx.checkIn.create.mock.calls,
            db.checkIn.create.mock.calls,
        ]);

        expect(written).toContain('"MANUAL"');
        expect(written).not.toContain("QR_SCAN");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. The existing protections are still in the source
// ─────────────────────────────────────────────────────────────────────────────

describe("C4 — the transaction's guards survive the integration", () => {
    const service = codeOnly(readSource("lib/ticketing/checkin/service.ts"));

    test("lock → refund guard → CAS → accepted insert, in source order", () => {
        const lock = service.indexOf("FOR UPDATE");
        const guard = service.indexOf("tx.refundItem.findFirst");
        const cas = service.indexOf("tx.ticket.updateMany");
        const insert = service.indexOf("tx.checkIn.create");

        expect(lock).toBeGreaterThan(-1);
        expect(guard).toBeGreaterThan(lock);
        expect(cas).toBeGreaterThan(guard);
        expect(insert).toBeGreaterThan(cas);
    });

    test("the CAS keeps both predicates and detects a lost race", () => {
        expect(service).toContain("cas.count !== 1");
        expect(service).toMatch(/status:\s*"ISSUED"/);
        expect(service).toMatch(/checkedInAt:\s*null/);
    });

    test("the duplicate guarantee is the schema's, not a comment", () => {
        const schema = readSource("prisma/schema.prisma");

        expect(schema).toMatch(/ticketId\s+String\?\s+@unique/);
        expect(schema).toContain("enum CheckInMethod {");
    });

    test("the gate still never reads a scanner token or its hash", () => {
        expect(service).not.toMatch(/qrTokenHash\s*:/);
        expect(service).not.toMatch(/hashQrToken/);
        expect(service).not.toContain('"QR_SCAN"');
    });

    test("no authorization check was removed or moved into the client", () => {
        expect(service).toContain("requireEventCheckInAccess");
        expect(service).toContain("PERMISSIONS.CHECKIN_SCAN");
        expect(service).toContain("PERMISSIONS.CHECKIN_OVERRIDE");
        expect(service).toContain("NO_STAFF_ASSIGNMENT");
        expect(service).not.toMatch(/params\.input\.(organizerId|eventId|ticketId)/);
    });
});
