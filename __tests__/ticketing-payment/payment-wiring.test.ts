/**
 * ==========================================
 * PHASE 7 — STATIC ARCHITECTURAL GUARDS (brief §32, §25)
 * ==========================================
 *
 * Text-level assertions on the payment layer, aimed at the boundaries rather than at
 * vocabulary. Brief §32 warns that a guard which fails because a legitimate read mentions
 * "sold" is a brittle guard; every pattern below is therefore anchored to a WRITE, an
 * IMPORT, a ROUTE or a WRAPPER, never to a bare noun inside prose (comments are stripped
 * first, precisely so prose cannot trip them).
 *
 * No database and no Next.js: this suite runs when nothing else can.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

function read(file: string): string {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

/** Strip comments, so a comment DESCRIBING a banned pattern is not mistaken for it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAYMENT_DIR = "lib/ticketing/payment";

const PAYMENT_FILES = fs
    .readdirSync(path.join(ROOT, PAYMENT_DIR))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${PAYMENT_DIR}/${name}`);

const _INVENTORY = "lib/ticketing/inventory.ts";
const RESERVATIONS = "lib/ticketing/reservations.ts";
const DB_CONTENTION = "lib/ticketing/db-contention.ts";
const ORDER_PAYLOAD = "lib/ticketing/order-payload.ts";

const WEBHOOK_MODULE = `${PAYMENT_DIR}/webhook.ts`;
const RECONCILIATION_MODULE = `${PAYMENT_DIR}/reconciliation.ts`;
const SETTLEMENT = `${PAYMENT_DIR}/settlement.ts`;
const SERVICE = `${PAYMENT_DIR}/service.ts`;
const GATEWAY = `${PAYMENT_DIR}/gateway.ts`;

const PAY_ROUTE = "app/api/ticketing/orders/[orderNumber]/pay/route.ts";
const WEBHOOK_ROUTE = "app/api/ticketing/payment/webhook/route.ts";
const ORDER_PAGE = "app/ticketing/orders/[orderNumber]/page.tsx";

// ─────────────────────────────────────────────────────────────────────────────
// The payment layer owns NO inventory
// ─────────────────────────────────────────────────────────────────────────────

describe("the payment layer consumes the canonical inventory primitives", () => {
    test("settlement converts and releases only through the reservations module", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(
            /from "\.\.\/reservations"|from "@\/lib\/ticketing\/reservations"/
        );
        expect(settlement).toMatch(/\bconfirmOrderReservations\(/);
        expect(settlement).toMatch(/\breleaseOrderReservations\(/);

        // It must NOT reach past the reservations module to the inventory primitives: the
        // paired reservation+counter transition is what keeps them consistent.
        expect(settlement).not.toMatch(/\breserveQuota\(/);
        expect(settlement).not.toMatch(/\bconfirmReservation\(/);
        expect(settlement).not.toMatch(/\breleaseReservation\(/);
    });

    test("no payment file contains raw SQL or a hand-rolled counter update", () => {
        expect(PAYMENT_FILES.length).toBeGreaterThanOrEqual(6);

        for (const file of PAYMENT_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/\$executeRaw/);
            expect(source).not.toMatch(/\$queryRaw/);
            expect(source).not.toMatch(/UPDATE\s+`?tickettype/i);
            expect(source).not.toMatch(/UPDATE\s+`?ticketreservation/i);
        }
    });

    test("no payment file writes sold / reserved / version", () => {
        for (const file of PAYMENT_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/data\.(sold|reserved|version)\s*[=:]/);
            expect(source).not.toMatch(
                /increment:\s*[^,}]*(sold|reserved|version)/
            );
            expect(source).not.toMatch(/\b(sold|reserved)\s*(?:[-+*/]=|\+\+|--)/);
        }
    });

    test("no payment file re-derives availability", () => {
        for (const file of [...PAYMENT_FILES, ORDER_PAYLOAD]) {
            const source = code(read(file));

            expect(source).not.toMatch(/quota\s*-\s*\w*\.?sold/);
            expect(source).not.toMatch(/\bsold\s*\+\s*\w*\.?reserved/);
        }
    });

    test("the settlement transaction is a real transaction, not a sequence", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(/prisma\.\$transaction\(/);
        // The conversion must happen INSIDE that transaction (its own call site, on `tx`).
        expect(settlement).toMatch(/confirmOrderReservations\(\s*tx/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settlement is webhook-only (design §31.5 rule 3)
// ─────────────────────────────────────────────────────────────────────────────

describe("the webhook is the only AUTOMATIC settlement trigger", () => {
    test("exactly two modules invoke the settlement primitives, each for a documented reason", () => {
        const importers: string[] = [];

        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(path.join(ROOT, dir), {
                withFileTypes: true,
            })) {
                const rel = `${dir}/${entry.name}`;

                if (entry.isDirectory()) {
                    walk(rel);
                    continue;
                }

                if (!/\.tsx?$/.test(entry.name)) continue;

                const source = code(read(rel));

                if (
                    /\b(settleVerifiedPayment|failVerifiedPayment)\(/.test(source) &&
                    rel !== SETTLEMENT &&
                    !rel.startsWith("__tests__")
                ) {
                    importers.push(rel);
                }
            }
        };

        for (const dir of ["lib", "app", "components"]) walk(dir);

        /*
         * PHASE 27E — THE SET IS NOW TWO, AND THAT IS NOT THE RULE BEING RELAXED.
         *
         * Design §31.5 rule 3 forbids a BROWSER or an operator from declaring a payment
         * paid. It does not, and cannot, say the provider's webhook is the only way to learn
         * what the provider did: Phase 27B proved the callback can be unreachable (the notify
         * URL was a loopback address) while the money is genuinely gone. Reconciliation asks
         * the provider out of band instead.
         *
         * What keeps the rule intact is that BOTH callers are still required to present
         * provider-verified evidence and go through the SAME order CAS — asserted below, so
         * this list cannot grow by quietly adding a name.
         */
        expect(importers.sort()).toEqual(
            [RECONCILIATION_MODULE, WEBHOOK_MODULE].sort()
        );

        // The automatic trigger is still the webhook alone.
        expect(importers).toContain(WEBHOOK_MODULE);
    });

    test("reconciliation is an operator action on VERIFIED provider evidence, never a second authority", () => {
        const reconciliation = code(read(RECONCILIATION_MODULE));

        // It obtains the transaction id from OUR OWN persisted column, and nowhere else —
        // no function parameter, no request body.
        expect(reconciliation).toMatch(/payment\.providerTransactionId/);
        expect(reconciliation).toMatch(
            /queryTransactionStatus\(payment\.providerTransactionId\)/
        );

        // It is authorized, per tenant, with the financial capability — from the record.
        expect(reconciliation).toMatch(/requireOrganizerAccess\(/);
        expect(reconciliation).toMatch(/PERMISSIONS\.PAYMENT_RECONCILE/);

        // A provider that has not reported success never reaches settlement.
        expect(reconciliation).toMatch(/isGatewaySuccessStatus\(/);

        // And it still does not write a paid state itself: the settlement engine owns that.
        expect(reconciliation).not.toMatch(/status\s*:\s*"PAID"/);
        expect(reconciliation).not.toMatch(/paymentStatus\s*[:=]\s*"PAID"/);
    });

    test("the reconcile route accepts no financial input and is CSRF-checked", () => {
        const reconcileRoute = code(
            read(
                "app/api/organizer/payments/[paymentReference]/reconcile/route.ts"
            )
        );

        expect(reconcileRoute).toMatch(/requireSameOrigin\(/);
        expect(reconcileRoute).toMatch(/requireAuth\(/);

        // Nothing is read from the request body: every deciding value comes from the record,
        // the session or the provider.
        expect(reconcileRoute).not.toMatch(/request\.json\(/);
        expect(reconcileRoute).not.toMatch(/transactionId/);
        expect(reconcileRoute).not.toMatch(/amount/);

        // And the route does not reach into the gateway or the settlement engine directly —
        // it goes through the service, so the checks cannot be skipped by a caller.
        expect(reconcileRoute).not.toMatch(/settleVerifiedPayment|queryTransactionStatus/);
    });

    test("the operator surface is gated by the same capability and asks for nothing", () => {
        const page = code(read("app/dashboard/payments/page.tsx"));

        // The action is drawn only where the server-side decider allows it, per tenant.
        expect(page).toMatch(/PERMISSIONS\.PAYMENT_RECONCILE/);
        expect(page).toMatch(/decideOrganizerPermission\(/);

        const button = code(
            read("components/organizer/ReconcilePaymentButton.tsx")
        );

        // No financial input exists at all: no field, no selector, no hidden value.
        expect(button).not.toMatch(/<input|<Input|<select|<Select/);
        expect(button).not.toMatch(/transactionId|providerTransactionId/);
        expect(button).not.toMatch(/amount/i);

        // It never spells a paid state, and it never claims one.
        expect(button).not.toMatch(/"PAID"/);

        // An expired session is a session state, not a failed verification (Phase 24).
        expect(button).toMatch(/UNAUTHORIZED_CODE/);
        expect(button).toMatch(/redirectToLoginForExpiredSession\(/);
    });

    test("the pay route and the order page cannot mark an order paid", () => {
        for (const file of [PAY_ROUTE, ORDER_PAGE]) {
            const source = code(read(file));

            expect(source).not.toMatch(/status\s*:\s*"PAID"/);
            expect(source).not.toMatch(/\bpaymentStatus\s*[:=]\s*"PAID"/);
            expect(source).not.toMatch(/settleVerifiedPayment|failVerifiedPayment/);
            expect(source).not.toMatch(/prisma\.eventOrder\.update/);
        }
    });

    test("the browser return is never treated as proof of payment (brief §22)", () => {
        const page = code(read(ORDER_PAGE));

        // No query-parameter read at all on the confirmation page: the only thing that may
        // tell the buyer they have paid is the order row.
        expect(page).not.toMatch(/searchParams/);
        expect(page).not.toMatch(/useSearchParams/);

        // Case-sensitive on purpose. The hazard is trusting a URL-ish value — the
        // lowercase spellings a redirect would carry. Comparing the ROW's own
        // `paymentStatus === "PAID"` is exactly the correct behaviour and must not trip
        // this guard, which is why the `i` flag is absent.
        expect(page).not.toMatch(/status\s*===?\s*["'](paid|success)["']/);
        expect(page).not.toMatch(/paid\s*===?\s*["']?1/);
    });

    test("the client is never told a payment URL this platform invented", () => {
        const service = code(read(SERVICE));

        // The URL comes from the gateway result, and only that.
        expect(service).toMatch(/created\.session/);
        expect(service).not.toMatch(/paymentUrl:\s*["'`]http/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Money stays server-owned and decimal-safe
// ─────────────────────────────────────────────────────────────────────────────

describe("money is derived from the database and never from the client", () => {
    test("the payment request schema declares no financial or identity field", () => {
        const schema = code(read(`${PAYMENT_DIR}/validation.ts`));

        // The request body type is exactly { method?, channel? }.
        for (const banned of [
            "amount",
            "total",
            "subtotal",
            "currency",
            "price",
            "organizerId",
            "userId",
            "customerId",
            "orderId",
            "paymentStatus",
            "status",
        ]) {
            expect(schema).not.toMatch(new RegExp(`\\b${banned}:\\s*z\\.`));
        }

        // …and it is not a passthrough that would let unknown keys survive.
        expect(schema).not.toMatch(/\.passthrough\(\)/);
        expect(schema).not.toMatch(/\.catchall\(/);
    });

    test("the provider is told the persisted order total", () => {
        const service = code(read(SERVICE));

        expect(service).toMatch(/amount:\s*order\.total/);
        expect(service).toMatch(/currency:\s*order\.currency/);
        // The amount is never recomputed from items or from a request field.
        expect(service).not.toMatch(/amount:\s*(request|body|input)\./);
    });

    test("the only numeric coercion of money is the guard inside the gateway", () => {
        // A decimal → number conversion is unavoidable at the wire boundary (the provider
        // API takes a number), so there is exactly ONE, it is named, it is integer-checked,
        // and it lives in the gateway. Anywhere else would be an unaudited float.
        const coercers: string[] = [];

        for (const file of PAYMENT_FILES) {
            const source = code(read(file));

            if (
                /Number\(\s*(amount|total|orderTotal|value)/.test(source) &&
                file !== GATEWAY
            ) {
                coercers.push(file);
            }
        }

        expect(coercers).toEqual([]);

        const gateway = code(read(GATEWAY));

        expect(gateway).toMatch(/requireSafeRupiah/);
        expect(gateway).toMatch(/isInteger\(\)/);
        expect(gateway).toMatch(/isSafeInteger/);
        expect(gateway).toMatch(/isNegative\(\)/);
    });

    test("no payment file formats money through a JavaScript number", () => {
        for (const file of PAYMENT_FILES) {
            const source = code(read(file));

            // `Number(x).toFixed(2)` is the float round-trip the brief bans.
            expect(source).not.toMatch(/Number\([^)]*\)\.toFixed\(/);
        }
    });

    test("the settlement records what the provider reported, not what it decided", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(/providerFee/);
        // The provider's fee is stored as a fact; no fee arithmetic is invented (D-22).
        expect(settlement).not.toMatch(/platformFee\s*[:=]\s*[^0\s]/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route hardening (brief §25, §26)
// ─────────────────────────────────────────────────────────────────────────────

describe("the payment routes are hardened and classified", () => {
    test("the pay route is same-origin protected and authenticated", () => {
        const route = code(read(PAY_ROUTE));

        expect(route).toMatch(/requireSameOrigin\(request\)/);
        expect(route).toMatch(/csrf\.error/);
        expect(route).toMatch(/requireAuth\(\)/);
        expect(route).toMatch(/export async function POST/);
        // The body is validated through the shared helper, not read by hand.
        expect(route).toMatch(/parseOrThrow\(paymentCreateRequestSchema/);
    });

    test("the pay route derives no authority from the body", () => {
        const route = code(read(PAY_ROUTE));

        expect(route).not.toMatch(/isAdmin\s*\(/);
        expect(route).not.toMatch(/role\s*===\s*["']ADMIN["']/);
        expect(route).not.toMatch(/body\.(userId|organizerId|customerId|amount|total)/);
        expect(route).not.toMatch(/as any/);
    });

    test("the webhook route trusts the signature, not a session (§25)", () => {
        const route = code(read(WEBHOOK_ROUTE));

        // It must read the RAW body: the signature covers the bytes as sent.
        expect(route).toMatch(/await request\.text\(\)/);

        // It must NOT use the customer session as its trust boundary.
        expect(route).not.toMatch(/requireAuth\(\)/);
        expect(route).not.toMatch(/requireSameOrigin\(/);
        expect(route).not.toMatch(/getAuthzScope\(\)/);

        // …and it must hand the signature to the verifier rather than checking it itself.
        expect(route).toMatch(/handleGatewayWebhook\(/);
        expect(route).toMatch(/signature/i);
    });

    test("the webhook is classified public, and public-by-contract", () => {
        const proxy = read("proxy.ts");

        const publicList = proxy
            .split("export const PUBLIC_API_PREFIXES = [")[1]
            .split("];")[0];

        expect(publicList).toContain('"/api/ticketing/payment/webhook"');
    });

    test("the pay route stays behind the protected ticketing prefix", () => {
        const proxy = read("proxy.ts");

        const protectedList = proxy
            .split("export const PROTECTED_API_PREFIXES = [")[1]
            .split("];")[0];

        expect(protectedList).toContain('"/api/ticketing/"');

        // No prefix may appear in both lists: public is matched first, so a duplicate would
        // silently open a protected subtree.
        const publicList = proxy
            .split("export const PUBLIC_API_PREFIXES = [")[1]
            .split("];")[0];
        const publicLiterals = publicList.match(/"\/[^"]*"/g) ?? [];
        const protectedLiterals = protectedList.match(/"\/[^"]*"/g) ?? [];

        for (const literal of publicLiterals) {
            expect(protectedLiterals).not.toContain(literal);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// No infrastructure was invented (brief §33)
// ─────────────────────────────────────────────────────────────────────────────

describe("no scheduler, queue or new dependency was introduced", () => {
    test("no payment file adds Redis, BullMQ, cron or a worker", () => {
        for (const file of [...PAYMENT_FILES, PAY_ROUTE, WEBHOOK_ROUTE]) {
            const source = code(read(file));

            expect(source).not.toMatch(/setInterval/);
            expect(source).not.toMatch(/bullmq|node-cron|agenda|node-schedule/i);
            expect(source).not.toMatch(/ioredis|from "redis"|require\("redis"\)/i);
            expect(source).not.toMatch(/new Worker\(|new Queue\(/);
        }
    });

    test("the reaper mechanism is untouched and still has no runner", () => {
        const reservations = code(read(RESERVATIONS));

        // The mechanism still exists (the brief forbids removing it)…
        expect(reservations).toMatch(/export async function expireDueReservations/);
        // …and Phase 7 did not schedule it: no timer, no queue anywhere in the library
        // except the single documented backoff.
        const files = fs
            .readdirSync(path.join(ROOT, "lib/ticketing"))
            .filter((name) => name.endsWith(".ts"));
        const withTimer = files.filter((name) =>
            /setTimeout/.test(code(read(`lib/ticketing/${name}`)))
        );

        expect(withTimer).toEqual(["db-contention.ts"]);
        expect(code(read(DB_CONTENTION))).not.toMatch(/setInterval/);
    });

    test("payment settlement reuses the shared bounded retry rather than its own", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(/withContentionRetry/);
        expect(settlement).not.toMatch(/setTimeout/);
        // Only genuinely transient contention is retried (brief §18).
        expect(code(read(DB_CONTENTION))).toMatch(/isTransientContention/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Out of scope stays out of scope (brief §34)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 7 did not drift into later phases", () => {
    const files = [...PAYMENT_FILES, PAY_ROUTE, WEBHOOK_ROUTE, ORDER_PAGE];

    /*
     * The QRIS-instruction renderer is the ONE payment-layer file allowed to touch a QR
     * library: it turns the DIRECT (QRIS) instruction's `QrString` into the scan image the
     * payment page itself shows. Renders bytes, issues nothing — it must never create a
     * ticket or a check-in, and that is asserted below instead of exempted. The exemption
     * is pinned to this exact basename so a second QR-aware file would fail the suite.
     */
    const QRIS_RENDERER = `${PAYMENT_DIR}/qr-render.ts`;

    test("no ticket issuance, QR or check-in", () => {
        expect(
            PAYMENT_FILES.filter((file) => file === QRIS_RENDERER)
        ).toHaveLength(1);

        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/prisma\.ticket\.create/);
            expect(source).not.toMatch(/prisma\.checkIn\./);

            if (file === QRIS_RENDERER) {
                continue;
            }

            expect(source).not.toMatch(/qrToken|qrCode|QRCodeSVG/);
        }
    });

    test("no refund execution, payout or settlement ledger", () => {
        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/prisma\.refund\.create/);
            expect(source).not.toMatch(/prisma\.settlement\.create/);
            expect(source).not.toMatch(/payout|disbursement/i);
        }
    });

    test("no PIC attribution, fee ledger or financial reporting", () => {
        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/picAttribution\.create/);
            expect(source).not.toMatch(/picFeeLedger\.create/);
            expect(source).not.toMatch(/exceljs|xlsx|writeFile.*\.xlsx/i);
        }
    });

    test("no notification workflows and no buyer PII in the audit payloads", () => {
        for (const file of PAYMENT_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/whatsapp|baileys|nodemailer/i);
            expect(source).not.toMatch(/prisma\.notification\.create/);
            // The audit payloads may name the ORDER, never the buyer's contact details.
            expect(source).not.toMatch(/afterState:[\s\S]{0,400}buyerEmail/);
            expect(source).not.toMatch(/afterState:[\s\S]{0,400}buyerPhone/);
            expect(source).not.toMatch(/afterState:[\s\S]{0,400}buyerName/);
        }
    });

    test("the retail payment and order trees were not modified for ticketing", () => {
        // The ticketing surface must not import the retail handlers, and vice versa: the
        // two order models are deliberately separate (design §35.7).
        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/from "@\/app\/api\/payment\/ipaymu/);
            expect(source).not.toMatch(/from "@\/app\/api\/orders/);
            expect(source).not.toMatch(/from "@\/app\/api\/checkout/);
        }

        // Only the ticketing adapter may name the provider's SDK-level module.
        for (const file of PAYMENT_FILES) {
            if (file === GATEWAY) continue;

            expect(code(read(file))).not.toMatch(/lib\/payment\/ipaymu/);
        }
    });

    test("provider-driven audit rows carry the PROVIDER actor, never a fake user id", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(/actorType:\s*"PROVIDER"/);
        expect(settlement).not.toMatch(/actorUserId:\s*"(SYSTEM|PROVIDER)"/);
        expect(settlement).not.toMatch(/adminId:\s*"(SYSTEM|PROVIDER)"/);
    });
});
