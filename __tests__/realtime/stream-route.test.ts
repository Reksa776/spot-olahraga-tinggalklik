/**
 * ==========================================
 * GET /api/realtime/stream — THE ONE TRANSPORT
 * ==========================================
 *
 * The endpoint is the only place a scope decision is made for delivery, so it is tested as a
 * boundary rather than trusted:
 *
 *   • an anonymous caller gets 401 and NO stream, ever;
 *   • a frame is delivered if and only if the caller's SERVER-RESOLVED audience intersects the
 *     event's, so another tenant's / another buyer's / another PIC's event is silently dropped;
 *   • opening the stream invalidates nothing — a client that just rendered a page must not be
 *     told to re-read it by the mere act of connecting;
 *   • cancelling (tab closed) detaches the bus listener immediately: a stream that leaked a
 *     listener per closed tab would grow forever.
 *
 * The mocked module is `@/lib/realtime/audience` — i.e. exactly the piece that answers \"who is
 * calling\". Everything else (the bus, the framing, the filter) is the real implementation.
 */

jest.mock("@/lib/realtime/audience", () => ({
    resolveRealtimeAudience: jest.fn(),
}));

import { NextRequest } from "next/server";

import { resolveRealtimeAudience } from "@/lib/realtime/audience";
import {
    __resetRealtimeBusForTests,
    publishRealtimeChange,
    realtimeListenerCount,
} from "@/lib/realtime/bus";
import { SSE_HEADERS, SSE_RETRY_MS, encodeSseHeartbeat } from "@/lib/realtime/sse";
import type { RealtimeAudience } from "@/lib/realtime/taxonomy";

import { GET } from "@/app/api/realtime/stream/route";

const audienceMock = resolveRealtimeAudience as jest.MockedFunction<typeof resolveRealtimeAudience>;

function request(): NextRequest {
    return new NextRequest("http://localhost:3000/api/realtime/stream", { method: "GET" });
}

/** Read the next frame as text. Rejects (rather than hanging) if nothing arrives in time. */
async function nextFrame(
    reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<string> {
    const result = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("no frame arrived")), 2_000)
        ),
    ]);

    if (result.done) {
        throw new Error("stream ended unexpectedly");
    }

    return new TextDecoder().decode(result.value);
}

beforeEach(() => {
    __resetRealtimeBusForTests();
    audienceMock.mockReset();
});

afterEach(() => {
    __resetRealtimeBusForTests();
});

describe("authorization is decided before a stream is handed over", () => {
    test("an anonymous caller gets 401 and no stream", async () => {
        audienceMock.mockResolvedValue([]);

        const response = await GET(request());

        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toContain("application/json");

        const payload = (await response.json()) as { success: boolean; code: string };

        expect(payload.success).toBe(false);
        expect(payload.code).toBe("UNAUTHORIZED");

        // And nothing was subscribed on the way in.
        expect(realtimeListenerCount()).toBe(0);
    });

    test("a caller with a scope gets the SSE stream and the documented headers", async () => {
        audienceMock.mockResolvedValue([{ kind: "platform" }]);

        const response = await GET(request());

        expect(response.status).toBe(200);

        for (const [header, value] of Object.entries(SSE_HEADERS)) {
            expect(response.headers.get(header)).toBe(value);
        }
    });
});

describe("opening a stream never invalidates anything", () => {
    test("the first frame is the reconnect hint, not a change", async () => {
        audienceMock.mockResolvedValue([{ kind: "platform" }]);

        const response = await GET(request());
        const reader = response.body!.getReader();

        const frame = await nextFrame(reader);

        expect(frame).toBe(`retry: ${SSE_RETRY_MS}\n\n`);
        expect(frame).not.toContain("event: change");

        await reader.cancel();
    });
});

describe("delivery is an audience intersection, evaluated per frame", () => {
    test("a matching event is forwarded and a foreign one is silently dropped", async () => {
        audienceMock.mockResolvedValue([
            { kind: "organizer", organizerId: "org_a" },
            { kind: "customer", userId: "usr_buyer" },
        ]);

        const response = await GET(request());
        const reader = response.body!.getReader();

        await nextFrame(reader); // the open frame

        // A different tenant's change: dropped.
        publishRealtimeChange({
            type: "PAYMENT_PAID",
            entityType: "EventOrder",
            entityId: "ord_foreign",
            audiences: [{ kind: "organizer", organizerId: "org_b" }],
        });

        // The caller's own change.
        const mine = publishRealtimeChange({
            type: "PAYMENT_PAID",
            entityType: "EventOrder",
            entityId: "ord_mine",
            audiences: [
                { kind: "platform" },
                { kind: "organizer", organizerId: "org_a" },
                { kind: "pic", picProfileId: "pic_9" },
            ],
        });

        // Because the foreign frame was dropped, the NEXT frame is ours — which is the whole
        // assertion, and it needs no timer to prove the negative.
        const frame = await nextFrame(reader);

        expect(frame).toContain("event: change");
        expect(frame).toContain(mine.envelope.id);
        expect(frame).not.toContain("ord_foreign");

        await reader.cancel();
    });

    test("a PIC's dashboard stream never receives another PIC's event", async () => {
        audienceMock.mockResolvedValue([{ kind: "pic", picProfileId: "pic_1" }]);

        const response = await GET(request());
        const reader = response.body!.getReader();

        await nextFrame(reader);

        publishRealtimeChange({
            type: "PIC_LEDGER_UPDATED",
            entityType: "PICFeeLedger",
            audiences: [{ kind: "pic", picProfileId: "pic_2" }],
        });

        const mine = publishRealtimeChange({
            type: "PIC_LEDGER_UPDATED",
            entityType: "PICFeeLedger",
            audiences: [{ kind: "platform" }, { kind: "pic", picProfileId: "pic_1" }],
        });

        const frame = await nextFrame(reader);

        expect(frame).toContain(mine.envelope.id);
        expect(frame).not.toContain("pic_2");

        await reader.cancel();
    });

    test("a whole-tenant event reaches every member of that tenant", async () => {
        audienceMock.mockResolvedValue([{ kind: "organizer", organizerId: "org_a" }]);

        const response = await GET(request());
        const reader = response.body!.getReader();

        await nextFrame(reader);

        const event = publishRealtimeChange({
            type: "EVENT_PUBLISHED",
            entityType: "Event",
            audiences: [{ kind: "platform" }, { kind: "organizer", organizerId: "org_a" }],
        });

        expect(await nextFrame(reader)).toContain(event.envelope.id);

        await reader.cancel();
    });

    test("THREE events in one burst are all delivered — coalescing is the CLIENT's job", async () => {
        // The server must not silently drop frames: a client that received only the last of three
        // would still refresh correctly, but an operator debugging the stream would be misled. The
        // server sends every relevant frame; the ONE-refresh-per-window guarantee lives in
        // `client-core.ts` and is asserted there.
        audienceMock.mockResolvedValue([{ kind: "platform" }]);

        const response = await GET(request());
        const reader = response.body!.getReader();

        await nextFrame(reader);

        const ids: string[] = [];

        for (const type of ["PAYMENT_PAID", "TICKET_ISSUED", "PIC_LEDGER_UPDATED"] as const) {
            ids.push(
                publishRealtimeChange({
                    type,
                    entityType: "EventOrder",
                    audiences: [{ kind: "platform" }],
                }).envelope.id
            );
        }

        for (const id of ids) {
            expect(await nextFrame(reader)).toContain(id);
        }

        await reader.cancel();
    });
});

describe("cleanup", () => {
    test("cancelling the stream detaches the listener", async () => {
        audienceMock.mockResolvedValue([{ kind: "platform" }]);

        const response = await GET(request());
        const reader = response.body!.getReader();

        await nextFrame(reader);
        expect(realtimeListenerCount()).toBe(1);

        await reader.cancel();
        await Promise.resolve();

        expect(realtimeListenerCount()).toBe(0);
    });

    test("two streams are two listeners, and closing one leaves the other working", async () => {
        audienceMock.mockResolvedValue([{ kind: "platform" }] as RealtimeAudience[]);

        const first = await GET(request());
        const second = await GET(request());

        const firstReader = first.body!.getReader();
        const secondReader = second.body!.getReader();

        await nextFrame(firstReader);
        await nextFrame(secondReader);

        expect(realtimeListenerCount()).toBe(2);

        await firstReader.cancel();
        await Promise.resolve();

        expect(realtimeListenerCount()).toBe(1);

        const change = publishRealtimeChange({
            type: "ORDER_CREATED",
            entityType: "EventOrder",
            audiences: [{ kind: "platform" }],
        });

        // The surviving stream still receives frames: one closed tab cannot take out the others.
        expect(await nextFrame(secondReader)).toContain(change.envelope.id);

        await secondReader.cancel();
    });
});

describe("SSE framing", () => {
    test("a heartbeat is a NAMED event carrying only a timestamp", () => {
        const frame = encodeSseHeartbeat(new Date("2026-09-28T00:00:00.000Z"));

        expect(frame).toBe('event: heartbeat\ndata: {"at":"2026-09-28T00:00:00.000Z"}\n\n');
    });
});
