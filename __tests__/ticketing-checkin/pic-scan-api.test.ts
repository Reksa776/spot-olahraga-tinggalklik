import fs from "node:fs";
import path from "node:path";

import { NextRequest } from "next/server";

/**
 * ==========================================
 * PHASE 3D — PIC SCANNER API (ROUTE)
 * ==========================================
 *
 * MOCKED at the service boundary on purpose: this suite is about the ROUTE's contract —
 * CSRF first, session before body, the strict schema, exactly-once invocation of the
 * admission service, and the error envelope. The admission decisions themselves are covered
 * by `pic-scan-authz.test.ts` (real guard/decider) and the Phase 3C transaction suite.
 *
 * What it must prove:
 *   • an unauthenticated or cross-origin request never reaches the service;
 *   • no body field can name an actor, a profile, an assignment, a method or an event;
 *   • the event comes from the route segment;
 *   • service refusals keep their code/status, and unexpected errors become a generic 500;
 *   • nothing the caller sent is echoed back on an error.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));
jest.mock("@/lib/authz", () => ({ requireAuth: jest.fn() }));
jest.mock("@/lib/ticketing/checkin/service", () => ({
    checkInTicket: jest.fn(),
}));

import * as route from "@/app/api/pic/events/[id]/check-in/route";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { AuthzError, AuthzErrorCode } from "@/lib/authz/errors";

const authz = jest.requireMock("@/lib/authz") as { requireAuth: jest.Mock };
const service = jest.requireMock("@/lib/ticketing/checkin/service") as {
    checkInTicket: jest.Mock;
};

const EVENT_ID = "event-1";
const CODE = "EVT-2345-6789";
const PARAMS = { params: Promise.resolve({ id: EVENT_ID }) };

const SUCCESS = {
    result: "SUCCESS",
    event: { id: EVENT_ID, title: "Gate Event" },
    ticket: {
        ticketCode: CODE,
        attendeeName: "Budi",
        status: "CHECKED_IN",
    },
    ticketType: { name: "Reguler" },
    method: "MANUAL",
    gateLabel: null,
    checkedInAt: "2026-09-19T12:00:00.000Z",
};

type ResponseBody = {
    success?: boolean;
    code?: string;
    message?: string;
    correlationId?: string;
    data?: { method?: string; result?: string };
};

function makeRequest(
    body: unknown,
    options: { origin?: string | null } = {}
): NextRequest {
    const headers: Record<string, string> = {
        host: "localhost",
        "content-type": "application/json",
    };

    // `origin: null` deliberately omits both Origin and Referer, which is the CSRF refusal.
    if (options.origin !== null) {
        headers.origin = options.origin ?? "http://localhost";
    }

    return new NextRequest(
        `http://localhost/api/pic/events/${EVENT_ID}/check-in`,
        {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        }
    );
}

async function call(
    body: unknown,
    options: { origin?: string | null } = {}
): Promise<{ status: number; body: ResponseBody; text: string }> {
    const response = await route.POST(makeRequest(body, options), PARAMS);

    // Clone BEFORE reading: a response body can be consumed only once.
    const cloned = response.clone();

    return {
        status: response.status,
        body: (await response.json()) as ResponseBody,
        text: JSON.stringify(await cloned.json()),
    };
}

beforeEach(() => {
    jest.resetAllMocks();
    authz.requireAuth.mockResolvedValue({ userId: "pic-user" });
    service.checkInTicket.mockResolvedValue(SUCCESS);
});

describe("P1 — session and CSRF gate the route", () => {
    test("no session is a 401 and never reaches the service", async () => {
        authz.requireAuth.mockRejectedValue(
            new AuthzError(AuthzErrorCode.UNAUTHORIZED)
        );

        const response = await call({ code: CODE });

        expect(response.status).toBe(401);
        expect(response.body.code).toBe("UNAUTHORIZED");
        expect(service.checkInTicket).not.toHaveBeenCalled();
    });

    test("a cross-origin POST is refused before authentication or parsing", async () => {
        const response = await call({ code: CODE }, { origin: null });

        expect(response.status).toBe(403);
        expect(response.body.code).toBe("FORBIDDEN");
        expect(service.checkInTicket).not.toHaveBeenCalled();
        expect(authz.requireAuth).not.toHaveBeenCalled();
    });
});

describe("P2 — the authorized request is a thin adapter", () => {
    test("invokes the existing service exactly once with the route event and parsed input", async () => {
        const response = await call({ code: `  ${CODE}  ` });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.data?.method).toBe("MANUAL");

        expect(service.checkInTicket).toHaveBeenCalledTimes(1);

        const [args] = service.checkInTicket.mock.calls[0] as [
            {
                eventId: string;
                input: Record<string, unknown>;
                request: Request;
            },
        ];

        expect(args.eventId).toBe(EVENT_ID);
        expect(args.input).toEqual({ code: CODE });
        expect(args.request).toBeInstanceOf(Request);
    });

    test("the response is the service payload unchanged", async () => {
        const response = await call({ code: CODE });

        // Byte-for-byte the service payload: the route is an adapter, not a re-shaper.
        expect(response.body.data).toEqual(SUCCESS);
    });
});

describe("P3 — no client field can widen authority or change scope", () => {
    const overrides: [string, Record<string, unknown>][] = [
        ["a user id", { userId: "someone-else" }],
        ["a PIC profile id", { picProfileId: "pic-2" }],
        ["an assignment id", { assignmentId: "assignment-2" }],
        ["a role", { role: "ADMIN" }],
        ["a permission", { permissions: ["checkin.override"] }],
        ["a check-in method", { method: "QR_SCAN" }],
        ["a method under another name", { checkInMethod: "QR_SCAN" }],
        ["a ticket status", { status: "CHECKED_IN" }],
        ["a checked-in timestamp", { checkedInAt: "2020-01-01T00:00:00.000Z" }],
        ["an actor", { checkedInByUserId: "someone-else" }],
        ["a ticket id", { ticketId: "ticket-2" }],
        ["a result", { result: "SUCCESS" }],
        ["an event id", { eventId: "event-2" }],
        ["an organizer id", { organizerId: "org-2" }],
    ];

    test.each(overrides)(
        "a body carrying %s is a validation error, never an override",
        async (_label, extra) => {
            const response = await call({ code: CODE, ...extra });

            expect(response.status).toBe(400);
            expect(response.body.code).toBe("VALIDATION_ERROR");
            expect(service.checkInTicket).not.toHaveBeenCalled();
        }
    );

    test("a QR_SCAN claim cannot become a check-in", async () => {
        const response = await call({ code: CODE, method: "QR_SCAN" });

        expect(response.status).toBe(400);
        expect(service.checkInTicket).not.toHaveBeenCalled();
    });
});

describe("P4 — service refusals and faults map to the shared envelope", () => {
    test("a duplicate check-in keeps its 409 and code", async () => {
        service.checkInTicket.mockRejectedValue(
            new AppError(ERROR_CODES.TICKET_ALREADY_CHECKED_IN, {
                message: "Tiket ini sudah check-in.",
                details: { reason: "ALREADY_CHECKED_IN" },
            })
        );

        const response = await call({ code: CODE });

        expect(response.status).toBe(409);
        expect(response.body.code).toBe("TICKET_ALREADY_CHECKED_IN");
        expect(response.body.success).toBe(false);
    });

    test("an unexpected failure is a generic 500 with no internals", async () => {
        service.checkInTicket.mockRejectedValue(
            new Error("prisma: mysql://root:hunter2@db.local/toko exploded")
        );

        const response = await call({ code: CODE });

        expect(response.status).toBe(500);
        expect(response.body.code).toBe("INTERNAL_ERROR");
        expect(typeof response.body.correlationId).toBe("string");
        expect(response.text).not.toContain("prisma");
        expect(response.text).not.toContain("hunter2");
        expect(response.text).not.toContain("db.local");
    });

    test("the submitted code is never echoed on an error", async () => {
        service.checkInTicket.mockRejectedValue(
            new AppError(ERROR_CODES.NOT_FOUND, {
                message: "Tiket tidak ditemukan.",
            })
        );

        const raw = "https://evil.test/TICKET:EVT-2345-6789";
        const response = await call({ code: raw });

        expect(response.status).toBe(404);
        expect(response.text).not.toContain("evil.test");
        expect(response.text).not.toContain(raw);
    });
});

describe("P5 — the route exposes no read surface and no second decision", () => {
    /**
     * Comments removed: this file's own prose says "no transaction" and names the attendance
     * service it deliberately does not call, so a raw-text guard would fail on the documentation
     * that explains the rule.
     */
    const source = fs
        .readFileSync(
            path.resolve(
                process.cwd(),
                "app/api/pic/events/[id]/check-in/route.ts"
            ),
            "utf8"
        )
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");

    test("there is no GET (a PIC may not read the attendance log)", () => {
        expect("GET" in route).toBe(false);
        expect(source).not.toContain("listEventCheckIns");
        expect(source).not.toContain("checkin.log.read");
    });

    test("it delegates the decision and the admission instead of reimplementing them", () => {
        expect(source).toContain("requireSameOrigin(request)");
        expect(source).toContain("await requireAuth()");
        expect(source).toContain("checkInRequestSchema");
        expect(source).toContain("checkInTicket({");

        // No transaction, ticket lookup, status write or QR parsing in the route.
        expect(source).not.toContain("$transaction");
        expect(source).not.toContain("ticket.update");
        expect(source).not.toContain("qrTokenHash");
        expect(source).not.toContain("parseCheckInQrPayload");
        expect(source).not.toContain("decidePicEventPermission");
    });
});
