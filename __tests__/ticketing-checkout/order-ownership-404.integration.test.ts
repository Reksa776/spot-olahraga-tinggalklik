/**
 * ==========================================
 * PHASE 23A — ORDER PAGE 404 REGRESSION (ownership)
 * ==========================================
 *
 * Reproduces the reported bug and pins its fix. The report was:
 *
 *   After paying (iPaymu sandbox) the buyer opened
 *   `GET /ticketing/orders/{orderNumber}` and got a Next.js 404 —
 *   even though the order was their own.
 *
 * ── THE ROOT CAUSE THIS SUITE PROVES ────────────────────────────────────────────
 * The order existed, was `PENDING_PAYMENT`, and belonged to the session user. The
 * 404 came from the SECOND authorization gate in `getOwnOrder`: the own-scope
 * capability check (`requireOwnResource(PERMISSIONS.ORDER_READ_OWN, ownUserId)`).
 * `PLATFORM_ROLE_OWN_PERMISSIONS.ADMIN` was an EMPTY set, so an operator who bought
 * a ticket was denied their own order. The page converted that refusal (and every
 * other error) into `notFound()`, so the buyer saw "404 — this page could not be
 * found" rather than a permission problem.
 *
 * ── WHAT IS REAL ────────────────────────────────────────────────────────────────
 * REAL database, REAL services, REAL `lib/authz` guards, REAL Next route handler and
 * REAL page component. Only `@/auth` is mocked (the session), and `global.fetch` for
 * the provider socket — the same seams every other integration suite uses.
 */

jest.mock("@/auth", () => ({
    auth: jest.fn(),
}));

import { AuthzErrorCode, resolveAuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getOwnOrder } from "@/lib/ticketing/orders";
import { createOrderPayment } from "@/lib/ticketing/payment/service";
import { GET as getOrderRoute } from "@/app/api/ticketing/orders/[orderNumber]/route";
import OrderPage from "@/app/ticketing/orders/[orderNumber]/page";

import {
    SUFFIX,
    createOrder,
    gatewayStub,
    installGatewayStub,
    nextRequest,
    setupFixtures,
    signInAs,
    teardownFixtures,
    type Fixtures,
} from "../ticketing-payment/payment-harness";

jest.setTimeout(180_000);

let fixtures: Fixtures;
/** The platform ADMIN who is also a buyer — the reported user. */
let admin: { id: string };
/** The admin's own order — the reported order. */
let adminOrder: { orderNumber: string; orderId: string };
/** An order number that exists nowhere. */
const UNKNOWN_ORDER = "EVT-0000000000000-deadbeef";

/** Call the real API route the way Next.js does. */
async function callOrderApi(orderNumber: string) {
    const response = await getOrderRoute(
        nextRequest(`/api/ticketing/orders/${orderNumber}`),
        { params: Promise.resolve({ orderNumber }) }
    );

    return { status: response.status, body: await response.json() };
}

/** Render the real server component the way Next.js does. */
function renderOrderPage(orderNumber: string) {
    return OrderPage({ params: Promise.resolve({ orderNumber }) });
}

beforeAll(async () => {
    fixtures = await setupFixtures();

    // The reported user: a platform ADMIN, created through the same user table the
    // application uses. The email carries the harness SUFFIX so teardown removes it.
    admin = await prisma.user.create({
        data: {
            name: `Admin ${SUFFIX}`,
            email: `admin-${SUFFIX}@example.test`,
            role: "ADMIN",
            platformRole: "ADMIN",
        },
        select: { id: true },
    });

    // A REAL order, created through the REAL checkout service, owned by the ADMIN.
    adminOrder = await createOrder({
        buyerId: admin.id,
        items: [{ ticketTypeId: fixtures.typeA.id, quantity: 1 }],
        tag: "admin-own-order",
    });
});

afterAll(async () => {
    await teardownFixtures(fixtures);
});

/* ==================================================================================
 * 1. ROOT CAUSE — an ADMIN's own scope resolves its buyer capabilities
 * ================================================================================== */

describe("PHASE 23A root cause — the session user owns the order", () => {
    test("the ADMIN buyer resolves a scope and can read their OWN order", async () => {
        signInAs(admin.id);
        const scope = await resolveAuthzScope(admin.id);

        expect(scope?.platformRole).toBe("ADMIN");

        // This is the line that used to throw `AuthzError(FORBIDDEN)` — and is the
        // exact reason the page 404'd.
        const payload = await getOwnOrder(adminOrder.orderNumber, scope!);

        expect(payload.orderNumber).toBe(adminOrder.orderNumber);
    });
});

/* ==================================================================================
 * 2. PAGE AND API AGREE — own order is readable by both
 * ================================================================================== */

describe("PHASE 23A — the page and the API agree for the owner", () => {
    test("GET /api/ticketing/orders/{orderNumber} returns 200 for the owner", async () => {
        signInAs(admin.id);

        const { status, body } = await callOrderApi(adminOrder.orderNumber);

        expect(status).toBe(200);
        expect(body).toMatchObject({
            success: true,
            data: { orderNumber: adminOrder.orderNumber },
        });
    });

    test("the page renders (does NOT call notFound) for the owner", async () => {
        signInAs(admin.id);

        // `notFound()` throws; a resolved element proves the page rendered.
        const element = await renderOrderPage(adminOrder.orderNumber);

        expect(element).toBeTruthy();
    });
});

/* ==================================================================================
 * 3. OWNERSHIP IS STILL ENFORCED — another buyer is a 404, never a leak
 * ================================================================================== */

describe("PHASE 23A — ownership remains enforced", () => {
    test("a different signed-in buyer is refused the same order", async () => {
        signInAs(fixtures.buyerB.id);
        const scope = await resolveAuthzScope(fixtures.buyerB.id);

        // The ownership predicate runs FIRST, so the other buyer never even reaches
        // the capability check: the order is simply not theirs, i.e. NOT_FOUND.
        await expect(
            getOwnOrder(adminOrder.orderNumber, scope!)
        ).rejects.toMatchObject({ code: AuthzErrorCode.NOT_FOUND });

        const { status } = await callOrderApi(adminOrder.orderNumber);
        expect(status).toBe(404);

        await expect(
            renderOrderPage(adminOrder.orderNumber)
        ).rejects.toThrow();
    });

    test("an unknown order is refused by both the API and the page", async () => {
        signInAs(admin.id);

        const { status } = await callOrderApi(UNKNOWN_ORDER);
        expect(status).toBe(404);

        await expect(renderOrderPage(UNKNOWN_ORDER)).rejects.toThrow();
    });
});

/* ==================================================================================
 * 4. THE PAYMENT RETURN URL CARRIES THE EXACT ORDER NUMBER
 * ================================================================================== */

describe("PHASE 23A — the iPaymu return URL preserves the order number", () => {
    let fetchSpy: jest.SpyInstance;

    beforeEach(() => {
        fetchSpy = installGatewayStub();
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    test("the provider returnUrl is built from the order's own orderNumber", async () => {
        signInAs(admin.id);
        const scope = await resolveAuthzScope(admin.id);

        // Redirect flow, so the provider is handed a `returnUrl`.
        const payload = await createOrderPayment({
            orderNumber: adminOrder.orderNumber,
            actor: scope!,
            request: { method: "CREDIT_CARD" } as never,
            httpRequest: nextRequest(),
        });

        expect(payload.orderNumber).toBe(adminOrder.orderNumber);

        const sent = gatewayStub.lastCall()?.body as
            | { returnUrl?: string }
            | undefined;

        expect(sent?.returnUrl).toBe(
            `http://localhost:3000/ticketing/orders/${adminOrder.orderNumber}`
        );
    });
});
