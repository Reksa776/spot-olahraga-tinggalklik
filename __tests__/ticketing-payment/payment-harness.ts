/**
 * ==========================================
 * PHASE 7 TEST HARNESS (shared, not a suite)
 * ==========================================
 *
 * Fixtures and helpers for the payment suites. Lives in the suite directory but is not
 * named `*.test.ts`, so `testMatch` never runs it as a suite.
 *
 * ── WHAT IS REAL AND WHAT IS STUBBED ─────────────────────────────────────────────
 * REAL: the database (MySQL/InnoDB), every ticketing service, `lib/authz` guards, the
 * `WebhookEvent` ledger, the inventory CAS primitives, the HMAC signature verification,
 * the whole status-classification chain, and the ENTIRE provider adapter — the amount
 * pre-flight guard, the request signing, the config/environment resolution and the error
 * mapping all execute.
 *
 * STUBBED: `global.fetch`, i.e. the socket. Nothing else. Brief §28 group H allows
 * exactly this ("mock only the external adapter boundary, not the internal settlement
 * logic"), and stubbing at the network call is the tightest reading of it: everything the
 * platform itself decides is under test, and only the bytes that would leave the machine
 * are invented. It also means a zero-amount order is genuinely refused by the adapter's
 * own guard rather than by a mock's opinion, which is what makes the `D-26` finding below
 * a real observation instead of a restatement of the stub.
 *
 * ── THE SESSION ──────────────────────────────────────────────────────────────────
 * `@/auth` is mocked by each suite (the mock is per-file), so every ownership and
 * permission decision is made by the real guards against real membership rows in the
 * database — the same approach Phase 6 used, and the reason these tests can prove IDOR
 * denials rather than assert a stub's return value.
 *
 * ── FIXTURES ARE BUILT THROUGH THE REAL SERVICES ─────────────────────────────────
 * Events, ticket types and orders are created via `createEvent` / `createTicketType` /
 * `publishEvent` / `createTicketOrder`, so a fixture can never be in a state the
 * application itself could not produce.
 */

import { NextRequest } from "next/server";

import { computeCanonicalJson, computeWebhookSignature } from "@/lib/payment/ipaymu";
import { getIpaymuConfig } from "@/lib/payment/config";
import { createEvent, publishEvent } from "@/lib/events/service";
import { resolveAuthzScope, requireOrganizerAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createTicketType } from "@/lib/ticket-types/service";
import { createTicketOrder } from "@/lib/ticketing/checkout";

export const SUFFIX = `p7-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;

export const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

/**
 * UNLISTED — the fixture events this harness publishes must never be publicly listed.
 *
 * `publishEvent` runs for real here, and `createEvent` defaults `visibility` to `PUBLIC`, so a
 * PUBLISHED fixture is served to anonymous visitors on the public landing the moment it exists.
 * The suites clean up after themselves, but that cleanup only runs if a test reaches it — an
 * aborted run (or the fixture-setup failure that leaves early) strands the event, and it shows up
 * as a ghost event whose tenant no real user belongs to. `UNLISTED` is the designed "not listed,
 * still sellable" state: publishing, payment creation, settlement and the webhook ledger all behave
 * exactly as before, while the public catalog (which requires `visibility: "PUBLIC"`) ignores it.
 */
export const FIXTURE_VISIBILITY = "UNLISTED" as const;
/**
 * PHASE 20B (D-P19-05 = A): an event needs an `endAt` before it can be published. A fixture
 * that published without one would now be refused by the real service — which is the point of
 * the rule, so the fixture carries a real end time instead of bypassing the precondition.
 */
export const FUTURE_END = new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000);
export const PRICE = "150000.00";

const { auth } = require("@/auth") as { auth: jest.Mock };

/**
 * The fixtures created by `setupFixtures`.
 *
 * Held at module scope so `createOrder` can default `eventId` to the suite's event without
 * every call site threading it through. Set once in `beforeAll`, read-only afterwards.
 */
let current: Fixtures | null = null;

export type Fixtures = {
    ownerA: { id: string };
    ownerB: { id: string };
    buyerA: { id: string };
    buyerB: { id: string };
    orgA: { id: string };
    orgB: { id: string };
    sportId: string;
    eventA: { id: string; slug: string };
    /**
     * The second tenant's event. Recorded — not merely created — because teardown has to
     * delete it: `event.organizerId` is a required FK, so an event left behind blocks the
     * organizer delete and the whole teardown aborts.
     */
    eventB: { id: string; slug: string };
    /** A large-quota active type used by most happy-path tests. */
    typeA: { id: string };
    /** Dedicated to the settlement tests so their counters are unambiguous. */
    typeSettle: { id: string };
    /** Dedicated to the failure-webhook test. */
    typeFail: { id: string };
    /** Dedicated to the cancel-race test. */
    typeRace: { id: string };
    /** Dedicated to the expiry-race test. */
    typeExpire: { id: string };
    /** A zero-price type: `D-26`'s free-ticket path. */
    typeFree: { id: string };
    /** Active, but its sales window has closed — must be refused at checkout. */
    typeClosed: { id: string };
};

export function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: {
                      id: userId,
                      email: `${userId}@${SUFFIX}.test`,
                      name: "Test",
                  },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

export async function customerScope(userId: string) {
    signInAs(userId);

    const scope = await resolveAuthzScope(userId);

    if (!scope) {
        throw new Error(`Fixture error: no authz scope for ${userId}`);
    }

    return scope;
}

async function createUser(tag: string) {
    return prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
        },
        select: { id: true },
    });
}

/** A `NextRequest` whose host resolves through the app-origin allowlist. */
export function nextRequest(path = "/api/ticketing/test"): NextRequest {
    return new NextRequest(new URL(`http://localhost:3000${path}`), {
        method: "POST",
        headers: {
            "x-forwarded-host": "localhost:3000",
            "x-forwarded-proto": "http",
            "content-type": "application/json",
        },
    });
}

/** The merchant VA the callbacks are signed with — the same one the verifier uses. */
export function merchantVa(): string {
    return getIpaymuConfig().va;
}

/**
 * Build a form-encoded provider callback and its valid `X-Signature`.
 *
 * The signature is computed with the platform's OWN canonicalisation helpers
 * (`computeCanonicalJson` + `computeWebhookSignature`) and the configured VA, so the
 * fixtures exercise the real verification path rather than a parallel implementation of it.
 */
export function signedCallback(params: {
    referenceId: string;
    /** iPaymu's `status_code`: 1 = success, 0 = pending, >=4 = failed. */
    statusCode: number;
    subTotal?: string | null;
    trxId?: string | null;
    fee?: string | null;
    via?: string;
    channel?: string;
    /** Extra/override fields, e.g. a refund marker. */
    extra?: Record<string, string>;
}): { rawBody: string; signature: string } {
    const fields: Record<string, string> = {
        reference_id: params.referenceId,
        status_code: String(params.statusCode),
    };

    if (params.subTotal !== null && params.subTotal !== undefined) {
        fields.sub_total = params.subTotal;
    }

    if (params.trxId !== null && params.trxId !== undefined) {
        fields.trx_id = params.trxId;
    }

    if (params.fee !== null && params.fee !== undefined) {
        fields.fee = params.fee;
    }

    if (params.via) fields.via = params.via;
    if (params.channel) fields.channel = params.channel;

    Object.assign(fields, params.extra ?? {});

    const rawBody = new URLSearchParams(fields).toString();
    const canonical = computeCanonicalJson(fields);
    const signature = computeWebhookSignature(canonical, merchantVa());

    return { rawBody, signature };
}

/** A provider reply the stub should return, or a transport failure to simulate. */
export type StubReply = {
    status: number;
    payload: unknown;
};

export type GatewayStubCall = {
    url: string;
    body: Record<string, unknown>;
};

const providerUrl = (n: number) =>
    `https://sandbox.ipaymu.com/payment/${SUFFIX}-${n}`;

/** The QRIS PNG the provider hosts for a given transaction (`Data.QrImage`). */
export const providerQrUrl = (n: number) =>
    `https://sandbox.ipaymu.com/qr/${SUFFIX}-${n}`;

/** A QRIS payload that looks like the provider's, and is recognisably NOT generated here. */
export const providerQrPayload = (n: number) =>
    `00020101021226610014ID.CO.QRIS.WWW${SUFFIX}${n}5204549953033605406100${n}5802ID6304ABCD`;

let providerCallCount = 0;

/**
 * The `fetch` stub.
 *
 * `calls` records every outbound provider request (parsed body and all), which is how the
 * suites assert what was actually sent — that the amount is the server's, that the method
 * and channel were mapped, and that a resumed attempt re-uses the live reference. `queue`
 * lets a test script the next reply (`503`, malformed JSON, a 200 with no `Url`) without
 * touching the code under test.
 */
export const gatewayStub = {
    calls: [] as GatewayStubCall[],
    queue: [] as ((call: GatewayStubCall) => StubReply)[],

    reset(): void {
        gatewayStub.calls.length = 0;
        gatewayStub.queue.length = 0;
        providerCallCount = 0;
    },

    /** Fail the next provider request with an HTTP status (e.g. 503). */
    failNext(status: number, payload: unknown = { Status: status }): void {
        gatewayStub.queue.push(() => ({ status, payload }));
    },

    /** Answer the next provider request with an arbitrary reply. */
    replyNext(reply: StubReply): void {
        gatewayStub.queue.push(() => reply);
    },

    /** The last request body sent, or `undefined` if the provider was never called. */
    lastCall(): GatewayStubCall | undefined {
        return gatewayStub.calls[gatewayStub.calls.length - 1];
    },
};

/**
 * Replace the socket for the lifetime of the suite. Returns the spy so it can be restored.
 *
 * The default reply is a well-formed provider success carrying a unique `SessionId` and
 * `Url`, so the happy path goes through the adapter's full success branch. Responses are
 * real `Response` objects (Node 24 provides them), so the adapter reads `status` and
 * `json()` exactly as it would from undici.
 */
export function installGatewayStub(): jest.SpyInstance {
    gatewayStub.reset();

    const spy = jest
        .spyOn(global, "fetch")
        .mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
            const call: GatewayStubCall = {
                url: String(_input),
                body:
                    typeof init?.body === "string"
                        ? (JSON.parse(init.body) as Record<string, unknown>)
                        : {},
            };

            gatewayStub.calls.push(call);

            // A scripted reply is consumed first; the default is a fresh provider session.
            const scripted = gatewayStub.queue.shift();

            const reply: StubReply = scripted
                ? scripted(call)
                : (() => {
                      providerCallCount += 1;

                      /*
                       * The default reply follows the ENDPOINT, because the two provider
                       * endpoints answer with different things and the difference is the whole
                       * point of the direct flow:
                       *
                       *   POST /api/v2/payment        → a hosted page (`Data.Url`)
                       *   POST /api/v2/payment/direct → the instrument itself
                       *
                       * A direct reply is shaped per METHOD, exactly as the provider's own
                       * samples do: QRIS returns `QrString` + `QrImage` + `PaymentNo`;
                       * virtual account and retail outlet return a `PaymentNo` and the
                       * issuer's `PaymentName`. That is what lets the suites assert that the
                       * QR the page renders is the one the gateway sent.
                       */
                      const requestBody = call.body as {
                          paymentMethod?: string;
                          paymentChannel?: string;
                      };

                      const isDirect = call.url.endsWith("/api/v2/payment/direct");

                      if (!isDirect) {
                          return {
                              status: 200,
                              payload: {
                                  Status: 200,
                                  Message: "Success",
                                  Data: {
                                      SessionId: `SES-${SUFFIX}-${providerCallCount}`,
                                      Url: providerUrl(providerCallCount),
                                  },
                              },
                          };
                      }

                      const channel = requestBody.paymentChannel ?? "bca";
                      const isQris = requestBody.paymentMethod === "qris";

                      return {
                          status: 200,
                          payload: {
                              Status: 200,
                              Success: true,
                              Message: "Success",
                              Data: {
                                  SessionId: `SES-${SUFFIX}-${providerCallCount}`,
                                  TransactionId: 100000 + providerCallCount,
                                  ReferenceId: `REF-${SUFFIX}-${providerCallCount}`,
                                  Via: isQris ? "QRIS" : "VA",
                                  Channel: channel.toUpperCase(),
                                  ...(isQris
                                      ? {
                                            QrString: providerQrPayload(
                                                providerCallCount
                                            ),
                                            QrImage: providerQrUrl(providerCallCount),
                                            QrTemplate: `${providerQrUrl(providerCallCount)}/template`,
                                        }
                                      : {}),
                                  PaymentNo: isQris
                                      ? providerQrPayload(providerCallCount)
                                      : `8808${providerCallCount}${SUFFIX.replace(/\D/g, "").slice(0, 8)}`,
                                  PaymentName: isQris
                                      ? "iPaymu"
                                      : `iPaymu ${channel.toUpperCase()}`,
                                  Total: 0,
                                  Fee: 0,
                                  Expired: "2099-12-31 23:59:59",
                              },
                          },
                      };
                  })();

            return new Response(JSON.stringify(reply.payload), {
                status: reply.status,
                headers: { "content-type": "application/json" },
            });
        }) as unknown as typeof fetch);

    return spy;
}

export async function counters(ticketTypeId: string) {
    return prisma.ticketType.findUniqueOrThrow({
        where: { id: ticketTypeId },
        select: { quota: true, sold: true, reserved: true, version: true },
    });
}

/**
 * Design §11.6's invariants, asserted against the ROW (never a service's own report):
 * `sold >= 0`, `reserved >= 0`, `sold + reserved <= quota`.
 */
export async function assertInventoryInvariants(
    ticketTypeId: string
): Promise<void> {
    const row = await counters(ticketTypeId);

    expect(row.sold).toBeGreaterThanOrEqual(0);
    expect(row.reserved).toBeGreaterThanOrEqual(0);
    expect(row.sold + row.reserved).toBeLessThanOrEqual(row.quota);
}

/** Create a real `PENDING_PAYMENT` order through the real checkout service. */
export async function createOrder(params: {
    buyerId: string;
    items: { ticketTypeId: string; quantity: number }[];
    tag: string;
    eventId?: string;
}): Promise<{ orderNumber: string; orderId: string; total: string }> {
    const actor = await customerScope(params.buyerId);

    if (!current) {
        throw new Error("Fixture error: call setupFixtures() first");
    }

    const outcome = await createTicketOrder({
        request: {
            eventId: params.eventId ?? current.eventA.id,
            items: params.items,
            buyerName: `Buyer ${SUFFIX}`,
            buyerEmail: `buyer-${SUFFIX}@example.test`,
            buyerPhone: "081234567890",
        } as never,
        actor,
        idempotencyKey: `${params.tag}-${SUFFIX}`,
        httpRequest: nextRequest(),
    });

    return {
        orderNumber: outcome.payload.orderNumber,
        orderId: outcome.payload.orderId,
        total: outcome.payload.totals.total,
    };
}

export async function setupFixtures(): Promise<Fixtures> {
    await assertDatabaseReachable();

    const ownerA = await createUser("p7-owner-a");
    const ownerB = await createUser("p7-owner-b");
    const buyerA = await createUser("p7-buyer-a");
    const buyerB = await createUser("p7-buyer-b");

    const orgA = await prisma.organizer.create({
        data: {
            ownerUserId: ownerA.id,
            name: `P7 Org A ${SUFFIX}`,
            slug: `p7-org-a-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    const orgB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `P7 Org B ${SUFFIX}`,
            slug: `p7-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    await prisma.organizerMember.createMany({
        data: [
            {
                organizerId: orgA.id,
                userId: ownerA.id,
                role: "OWNER",
                status: "ACTIVE",
            },
            {
                organizerId: orgB.id,
                userId: ownerB.id,
                role: "OWNER",
                status: "ACTIVE",
            },
        ],
    });

    const sportId = (
        await prisma.sport.create({
            data: {
                name: `P7 Sport ${SUFFIX}`,
                slug: `p7-sport-${SUFFIX}`,
            },
            select: { id: true },
        })
    ).id;

    const scopeA = await organizerScope(orgA.id, ownerA.id);

    const eventA = await createEvent(scopeA, orgA.id, {
        title: `P7 Event A ${SUFFIX}`,
        sportId,
        startAt: FUTURE,
        endAt: FUTURE_END,
        visibility: FIXTURE_VISIBILITY,
    } as never);

    const eventB = await createEvent(
        await organizerScope(orgB.id, ownerB.id),
        orgB.id,
        {
            title: `P7 Event B ${SUFFIX}`,
            sportId,
            startAt: FUTURE,
            endAt: FUTURE_END,
            visibility: FIXTURE_VISIBILITY,
        } as never
    );

    const type = async (
        name: string,
        data: Record<string, unknown>
    ): Promise<{ id: string }> =>
        createTicketType(await organizerScope(orgA.id, ownerA.id), eventA.id, {
            name,
            price: PRICE,
            quota: 50,
            ...data,
        } as never);

    const typeA = await type("Reguler", { quota: 1000, maxPerOrder: 10 });
    const typeSettle = await type("Settlement", { quota: 20 });
    const typeFail = await type("Gagal", { quota: 20 });
    const typeRace = await type("Balapan", { quota: 20 });
    const typeExpire = await type("Kedaluwarsa", { quota: 20 });
    const typeFree = await type("Gratis", { price: "0.00", quota: 20 });
    const typeClosed = await type("Sudah Tutup", {
        quota: 20,
        salesStartAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        salesEndAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });

    // Publishing needs an active type with quota > 0 — the Phase 4/5 precondition that
    // Phase 6/7 exist to keep reachable.
    await publishEvent(await organizerScope(orgA.id, ownerA.id), eventA.id);

    current = {
        ownerA,
        ownerB,
        buyerA,
        buyerB,
        orgA,
        orgB,
        sportId,
        eventA,
        eventB,
        typeA,
        typeSettle,
        typeFail,
        typeRace,
        typeExpire,
        typeFree,
        typeClosed,
    };

    return current;
}

/**
 * Fail loudly and early with a readable message if the test database is unreachable.
 *
 * Phase 6's suites assume a live MySQL; a silent skip would make a broken environment look
 * like a passing phase. This keeps that failure legible.
 */
async function assertDatabaseReachable(): Promise<void> {
    try {
        await prisma.$queryRaw`SELECT 1`;
    } catch (error) {
        throw new Error(
            `Phase 7 integration tests need a live MySQL (DATABASE_URL). Cause: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
    }
}

/**
 * Remove only what this suite could have created.
 *
 * Ordered children-first, and scoped by the event ids and the `SUFFIX`-tagged users so it
 * cannot touch another phase's fixtures or any retail row. Audit rows are filtered the same
 * way (including the SYSTEM/PROVIDER rows these tests produce), because a test audit row is
 * still residue even though the production table is append-only.
 */
export async function teardownFixtures(f: Fixtures): Promise<void> {
    const eventIds = [f.eventA.id, f.eventB.id];

    await prisma.webhookEvent.deleteMany({
        where: { order: { eventId: { in: eventIds } } },
    });

    // Deliveries the handler REJECTED carry `orderId: null` — they were never attributed to
    // an order — so they are not caught by the query above. They cannot be matched on
    // `providerEventId` either, because that column is a hash. The provider transaction id
    // is the one identifier on those rows the suite controls, and it is suffixed for
    // exactly this purpose.
    await prisma.webhookEvent.deleteMany({
        where: { providerTransactionId: { contains: SUFFIX } },
    });

    const orderIds = (
        await prisma.eventOrder.findMany({
            where: { eventId: { in: eventIds } },
            select: { id: true },
        })
    ).map((row) => row.id);

    await prisma.paymentTransaction.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.ticketReservation.deleteMany({
        where: { eventId: { in: eventIds } },
    });
    await prisma.eventOrderItem.deleteMany({
        where: { orderId: { in: orderIds } },
    });
    await prisma.idempotencyKey.deleteMany({
        where: {
            userId: {
                in: [f.buyerA.id, f.buyerB.id, f.ownerA.id, f.ownerB.id],
            },
        },
    });
    // Every order that names either event, not just the ids collected above: an order for
    // `eventB` is never created by these suites, but scoping to the event keeps teardown
    // correct even if one ever is.
    await prisma.eventOrder.deleteMany({
        where: { eventId: { in: eventIds } },
    });
    await prisma.ticketType.deleteMany({
        where: { eventId: { in: eventIds } },
    });
    await prisma.eventImage.deleteMany({ where: { eventId: { in: eventIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });

    await prisma.adminAuditLog.deleteMany({
        where: {
            OR: [
                {
                    actorUserId: {
                        in: [
                            f.buyerA.id,
                            f.buyerB.id,
                            f.ownerA.id,
                            f.ownerB.id,
                        ],
                    },
                },
                { organizerId: { in: [f.orgA.id, f.orgB.id] } },
                {
                    AND: [
                        { actorType: { in: ["SYSTEM", "PROVIDER"] } },
                        { action: { startsWith: "payment." } },
                    ],
                },
            ],
        },
    });

    await prisma.organizerMember.deleteMany({
        where: { organizerId: { in: [f.orgA.id, f.orgB.id] } },
    });
    await prisma.organizer.deleteMany({
        where: { id: { in: [f.orgA.id, f.orgB.id] } },
    });
    await prisma.sport.deleteMany({ where: { id: f.sportId } });
    await prisma.user.deleteMany({ where: { email: { contains: SUFFIX } } });
}

/** Re-resolve an organizer scope. Never cache one across a sign-in change. */
export async function organizerScope(organizerId: string, userId: string) {
    signInAs(userId);

    return requireOrganizerAccess(organizerId, "event.read");
}

/**
 * A refusal, from either error family: `AppError` (`httpStatus`, `details`) or
 * `AuthzError` (`status`, `code`). Both carry a machine-readable `code`.
 */
export type Rejection = {
    code?: string;
    status?: number;
    httpStatus?: number;
    details?: Record<string, unknown>;
    message?: string;
};

/** Assert an operation is refused, and hand back the error for shape assertions. */
export async function expectRejection(
    run: () => Promise<unknown>
): Promise<Rejection> {
    try {
        await run();
    } catch (error) {
        return error as Rejection;
    }

    throw new Error("Expected the operation to be rejected, but it succeeded");
}
