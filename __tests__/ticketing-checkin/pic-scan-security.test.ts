import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

import { AppError, statusForCode, toAppError } from "@/lib/api/errors";
import {
    PIC_SCAN_MAX_REQUESTS,
    PIC_SCAN_WINDOW_MS,
} from "@/lib/rate-limit";
import { enforcePicScanRateLimit } from "@/lib/ticketing/checkin/pic-rate-limit";

/**
 * PHASE 3F — PIC scanner security boundaries.
 *
 * HONESTY: the limiter itself is a pure/ in-process unit under test, and the source
 * assertions are static regressions. No database is used and no real admission is
 * performed here; the mocked transaction suite remains the behavioural check-in test.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const service = read("lib/ticketing/checkin/service.ts");
const rateLimitSource = read("lib/rate-limit.ts");
const auditSource = read("lib/ticketing/audit-log.ts");
const schema = read("prisma/schema.prisma");

function exhaust(userId: string, eventId: string): void {
    for (let i = 0; i < PIC_SCAN_MAX_REQUESTS; i++) {
        enforcePicScanRateLimit({
            userId,
            eventId,
        });
    }
}

describe("PIC scan rate limiting", () => {
    it("allows requests up to the documented allowance", () => {
        const userId = randomUUID();
        const eventId = randomUUID();

        for (let i = 0; i < PIC_SCAN_MAX_REQUESTS; i++) {
            expect(() =>
                enforcePicScanRateLimit({ userId, eventId })
            ).not.toThrow();
        }
    });

    it("refuses the request after the allowance, with a retry delay", () => {
        const userId = randomUUID();
        const eventId = randomUUID();

        exhaust(userId, eventId);

        let thrown: unknown;

        try {
            enforcePicScanRateLimit({ userId, eventId });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(AppError);

        const error = toAppError(thrown);

        expect(error.code).toBe("RATE_LIMITED");
        expect(statusForCode(error.code)).toBe(429);
        expect(error.details).toMatchObject({
            reason: "PIC_SCAN_RATE_LIMITED",
        });
        expect(error.details?.retryAfterMs).toBeGreaterThan(0);
        expect(error.details?.retryAfterMs).toBeLessThanOrEqual(
            PIC_SCAN_WINDOW_MS
        );
    });

    it("keeps each PIC identity in an independent bucket", () => {
        const eventId = randomUUID();
        const exhaustedUser = randomUUID();
        const otherUser = randomUUID();

        exhaust(exhaustedUser, eventId);

        expect(() =>
            enforcePicScanRateLimit({ userId: exhaustedUser, eventId })
        ).toThrow();

        expect(() =>
            enforcePicScanRateLimit({ userId: otherUser, eventId })
        ).not.toThrow();
    });

    it("keeps each event in an independent bucket for the same PIC", () => {
        const userId = randomUUID();
        const exhaustedEvent = randomUUID();
        const otherEvent = randomUUID();

        exhaust(userId, exhaustedEvent);

        expect(() =>
            enforcePicScanRateLimit({
                userId,
                eventId: exhaustedEvent,
            })
        ).toThrow();

        expect(() =>
            enforcePicScanRateLimit({ userId, eventId: otherEvent })
        ).not.toThrow();
    });

    it("does not read identity or scope from any other key on the object", () => {
        const seen: Array<[string, string]> = [];

        enforcePicScanRateLimit(
            {
                userId: "session-user",
                eventId: "authorized-event",
                // A client-shaped identity must be ignored, not forwarded.
                picProfileId: "attacker-chosen",
                deviceId: "attacker-chosen",
            } as { userId: string; eventId: string },
            (userId, eventId) => {
                seen.push([userId, eventId]);
                return { allowed: true, remaining: 1, retryAfterMs: 0 };
            }
        );

        expect(seen).toEqual([["session-user", "authorized-event"]]);
    });

    it("fails closed, with a 503 and no identifiers, when the backend throws", () => {
        const userId = randomUUID();
        const eventId = randomUUID();

        let thrown: unknown;

        try {
            enforcePicScanRateLimit({ userId, eventId }, () => {
                throw new Error(`backend down for ${userId}/${eventId}`);
            });
        } catch (error) {
            thrown = error;
        }

        const error = toAppError(thrown);

        expect(error.code).toBe("SERVICE_UNAVAILABLE");
        expect(statusForCode(error.code)).toBe(503);

        const serialised = JSON.stringify({
            message: error.message,
            details: error.details,
        });

        expect(serialised).not.toContain(userId);
        expect(serialised).not.toContain(eventId);
        expect(serialised).not.toContain("backend down");
    });

    it("uses a server-derived user id and the authorized event as the bucket key", () => {
        expect(rateLimitSource).toContain(
            "checkin:pic:${userId}:${eventId}"
        );
        expect(rateLimitSource).toContain(
            "checkInScan: (userId: string, eventId: string)"
        );

        // The guard runs after access is resolved and before any ticket/gate query.
        const accessAt = service.indexOf("await requireEventCheckInAccess");
        const guardAt = service.indexOf("enforcePicScanRateLimit({");
        const gateAt = service.indexOf("const gate = await prisma.event");

        expect(accessAt).toBeGreaterThan(-1);
        expect(guardAt).toBeGreaterThan(accessAt);
        expect(gateAt).toBeGreaterThan(guardAt);

        // Only the PIC branch consumes the allowance; the organizer path is untouched.
        expect(service).toContain('if (actorKind === "PIC")');
        expect(service).toContain("userId: scope.userId");
        expect(service).toContain("eventId: event.id");
        expect(service).not.toContain("input.deviceId,\n            eventId");
        expect(service).not.toContain("eventId: params.input");
    });
});

describe("durable PIC attribution", () => {
    it("records the session user as the admitting actor", () => {
        expect(service).toContain("checkedInByUserId: scope.userId");
        // The CLIENT input carries no actor fields; the only `input.actorUserId` is the
        // internal refusal-record parameter, which is fed from `scope.userId` above.
        expect(service).not.toContain("params.input.actor");
        expect(service).not.toContain("params.input.checkedInBy");
        expect(service).not.toContain("checkedInByUserId: params.input");
    });

    it("carries the PIC profile id from the server-side profile lookup into the audit row", () => {
        expect(service).toContain("picProfileId: picProfile.id");
        expect(service).toContain("picProfileId: null");
        expect(service).toContain("actorKind,");
        expect(service).toContain("picProfileId,");
    });

    it("is append-only: the admission service never updates or deletes a check-in", () => {
        expect(service).not.toMatch(/checkIn\.(update|updateMany|delete|deleteMany)/);
        expect(service).toContain("tx.checkIn.create");
    });

    it("needs no migration because both attribution columns already exist", () => {
        expect(schema).toMatch(/model CheckIn \{[\s\S]*checkedInByUserId\s+String/);
        expect(schema).toMatch(/model PICProfile \{[\s\S]*userId\s+String\s+@unique/);
        expect(schema).not.toContain("checkedInByPicProfileId");
    });
});

describe("audit payload privacy and scoping", () => {
    // Both audit payloads are flat objects, so the first closing `},` ends each block.
    const afterStates = Array.from(
        service.matchAll(/afterState:\s*\{([\s\S]*?)\n\s*\},/g)
    ).map((match) => match[1]);

    it("writes both audit outcomes with actor attribution", () => {
        expect(afterStates).toHaveLength(2);

        for (const block of afterStates) {
            expect(block).toContain("actorKind");
            expect(block).toContain("picProfileId");
        }
    });

    it("stores no participant PII, raw QR payload, secret or token", () => {
        const forbidden = [
            "attendeeEmail",
            "attendeePhone",
            "attendeeName",
            "holderPhone",
            "qrToken",
            "qrTokenHash",
            "rawPayload",
            "input.code",
        ];

        for (const block of afterStates) {
            for (const key of forbidden) {
                expect(block).not.toContain(key);
            }
        }
    });

    it("scopes the entity reference to the normalized ticket code, never the raw payload", () => {
        expect(service).toContain("entityRef: ticket.ticketCode");
        expect(service).toContain("entityRef: input.note");
        expect(service).not.toContain("entityRef: params.input.code");
        expect(service).not.toContain("entityRef: input.code");
    });

    it("does not expose authorization internals in refused-audit reasons", () => {
        const refused = afterStates.find((block) =>
            block.includes("checkin.rejected") || block.includes("reason: input.reason")
        );

        expect(refused).toBeDefined();

        for (const reason of [
            "NO_STAFF_ASSIGNMENT",
            "ORGANIZER_ACCESS_DENIED",
            "PIC_ACCESS_DENIED",
            "NO_PIC_PROFILE",
            "NO_PIC_ASSIGNMENT",
        ]) {
            expect(refused).not.toContain(reason);
        }
    });

    it("keeps the audit writer append-only and filters secret-shaped keys", () => {
        expect(auditSource).toContain("qrcode");
        expect(auditSource).toContain("qrtoken");
        expect(auditSource).toContain('"token"');
        expect(auditSource).not.toMatch(/adminAuditLog\.(update|delete)/);
        expect(auditSource).toMatch(/adminAuditLog\.create/);
    });
});
