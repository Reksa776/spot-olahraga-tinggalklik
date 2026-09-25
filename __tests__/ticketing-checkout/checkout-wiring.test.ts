/**
 * ==========================================
 * PHASE 6 — STATIC ARCHITECTURAL GUARDS (brief §32)
 * ==========================================
 *
 * These tests exist to stop a future developer (or a future me) from quietly bypassing
 * the architecture. They read source text, so they are deliberately **targeted at
 * mutation patterns, imports and boundaries** rather than at words: brief §32 warns that
 * a test which fails because a legitimate read mentions "sold" is a brittle test, and
 * that mistake has already been made twice in this rebuild.
 *
 * No database and no Next.js: this suite must stay runnable when nothing else can.
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../..");

function read(file: string): string {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
}

/** Strip comments so prose about a banned pattern is not mistaken for the pattern. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const RESERVATIONS = "lib/ticketing/reservations.ts";
const CHECKOUT = "lib/ticketing/checkout.ts";
const ORDERS = "lib/ticketing/orders.ts";
const INVENTORY = "lib/ticketing/inventory.ts";
const SALES_STATE = "lib/events/sales-state.ts";

const CHECKOUT_ROUTE = "app/api/ticketing/checkout/route.ts";
const ORDER_ROUTE = "app/api/ticketing/orders/[orderNumber]/route.ts";
const CANCEL_ROUTE =
    "app/api/ticketing/orders/[orderNumber]/cancel/route.ts";

// ─────────────────────────────────────────────────────────────────────────────
// D. Inventory integration — Phase 5 primitives are reused, not re-derived
// ─────────────────────────────────────────────────────────────────────────────

describe("the checkout consumes the canonical inventory primitives", () => {
    test("checkout.ts and reservations.ts import from the inventory module", () => {
        expect(code(read(CHECKOUT))).toMatch(
            /from "\.\/inventory"|from "@\/lib\/ticketing\/inventory"/
        );
        expect(code(read(RESERVATIONS))).toMatch(
            /from "\.\/inventory"|from "@\/lib\/ticketing\/inventory"/
        );
    });

    test("reserve/confirm/release are the ONLY quota mutations called", () => {
        const checkout = code(read(CHECKOUT));
        const reservations = code(read(RESERVATIONS));

        expect(checkout).toMatch(/\breserveQuota\(/);
        expect(reservations).toMatch(/\breleaseReservation\(/);
        expect(reservations).toMatch(/\bconfirmReservation\(/);

        // No hand-rolled `UPDATE tickettype` anywhere outside the inventory module.
        for (const source of [checkout, reservations]) {
            expect(source).not.toMatch(/\$executeRaw/);
            expect(source).not.toMatch(/UPDATE\s+`?tickettype/i);
        }
    });

    test("no service writes sold / reserved / version outside the inventory module", () => {
        // Targeted at real write shapes: `data.sold = …`, `sold: <value>` inside a Prisma
        // write payload, or an atomic `increment`. A bare read (`item.sold`) and audit
        // payloads are legitimate, so a word-scan would be wrong.
        for (const file of [CHECKOUT, ORDERS, RESERVATIONS]) {
            const source = code(read(file));

            expect(source).not.toMatch(
                /data\.(sold|reserved|version)\s*[=:]/
            );
            expect(source).not.toMatch(
                /\b(sold|reserved|version)\s*:\s*(?!true|false|null)[^,}\n]*[+\-*/]/
            );
            expect(source).not.toMatch(
                /increment:\s*[^,}]*(sold|reserved|version)/
            );
            expect(source).not.toMatch(/\b(sold|reserved)\s*(?:[-+*/]=|\+\+|--)/);
        }
    });

    test("the reservation row uses the inventory counters' owner, not its own arithmetic", () => {
        // `quantity` is copied from the request; the counters are never recomputed here.
        const reservations = code(read(RESERVATIONS));

        expect(reservations).toMatch(/reportOnly|quantity/);
        expect(reservations).not.toMatch(/quota\s*[-+]/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// No second availability formula (brief §11)
// ─────────────────────────────────────────────────────────────────────────────

describe("there is exactly one availability formula", () => {
    /**
     * The clamping in `sales-state.ts` is deliberate, and its own header explains why:
     * display availability is `max(0, …)` while `inventory.ts`'s is deliberately
     * unclamped, because the clamped value is correct for a catalogue card but hides the
     * negative that the invariant check exists to catch (design §10.5, §11.6).
     *
     * So the rule is not "one text expression" — it is "exactly two owners, and nobody
     * else re-derives it". The two are proved to agree in
     * __tests__/checkout/reservation-lifecycle.test.ts.
     */
    const OWNERS = new Set([INVENTORY, SALES_STATE]);

    test("no consumer re-derives availability by hand", () => {
        const consumers = [
            CHECKOUT,
            ORDERS,
            RESERVATIONS,
            "lib/ticketing/order-payload.ts",
            "lib/ticketing/checkout-validation.ts",
            "lib/ticketing/idempotency.ts",
            "lib/ticket-types/service.ts",
        ];

        for (const file of consumers) {
            const source = code(read(file));

            expect(source).not.toMatch(/quota\s*-\s*\w*\.?sold/);
            expect(source).not.toMatch(/\bsold\s*\+\s*\w*\.?reserved/);
        }
    });

    test("across the whole codebase, only the two owner modules contain the arithmetic", () => {
        const dirs = ["lib", "app", "components"];
        const offenders: string[] = [];

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
                    /quota\s*-\s*\w*\.?sold\s*-\s*\w*\.?reserved/.test(source) &&
                    !OWNERS.has(rel)
                ) {
                    offenders.push(rel);
                }
            }
        };

        for (const dir of dirs) walk(dir);

        expect(offenders).toEqual([]);
    });

    test("both owners exist and are the ones the code names", () => {
        // Guards the guard: if the module is renamed, this test must fail loudly rather
        // than silently assert nothing.
        expect(code(read(INVENTORY))).toMatch(/quota\s*-\s*snapshot\.sold/);
        expect(code(read(SALES_STATE))).toMatch(
            /type\.quota\s*-\s*type\.sold\s*-\s*type\.reserved/
        );
    });

    test("the checkout delegates the sales verdict instead of deciding it", () => {
        const checkout = code(read(CHECKOUT));

        expect(checkout).toMatch(/classifySalesState/);
        expect(checkout).toMatch(/isEventPurchasable/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reservation lifecycle safety (brief §7)
// ─────────────────────────────────────────────────────────────────────────────

describe("reservation transitions are state-guarded", () => {
    test("no unguarded single-row ticketReservation update exists", () => {
        // `updateMany({ where: { id, status: HELD } })` IS the guard — the affected-row
        // count decides whether the caller won. A singular `update()` cannot express
        // "only if it is still HELD", so it would be a time-of-check/time-of-use race.
        for (const file of [
            RESERVATIONS,
            CHECKOUT,
            ORDERS,
            "lib/ticketing/reservations.ts",
        ]) {
            expect(code(read(file))).not.toMatch(/ticketReservation\.update\(/);
        }
    });

    test("every ticketReservation.updateMany filters on the current status", () => {
        const source = code(read(RESERVATIONS));

        const calls = source.split("ticketReservation.updateMany(").slice(1);

        expect(calls.length).toBeGreaterThanOrEqual(2);

        for (const call of calls) {
            expect(call.slice(0, 200)).toMatch(/status:\s*RESERVATION_INITIAL_STATUS/);
        }
    });

    test("the order status transitions are guarded too", () => {
        // Cancellation and expiry both CAS on PENDING_PAYMENT, so a paid or cancelled
        // order can never be flipped (design §12.3's anti-resurrection rule).
        expect(code(read(ORDERS))).toMatch(
            /eventOrder\.updateMany\(\{[\s\S]{0,120}status:\s*"PENDING_PAYMENT"/
        );
        expect(code(read(RESERVATIONS))).toMatch(
            /eventOrder\.updateMany\(\{[\s\S]{0,120}status:\s*"PENDING_PAYMENT"/
        );
    });

    test("inventory and reservation state change in the SAME transaction (§11.2)", () => {
        // Both release and confirm must be reachable only through a transaction client,
        // so a crash between the two statements cannot leave them differing.
        const reservations = code(read(RESERVATIONS));

        expect(reservations).toMatch(
            /tx:\s*Prisma\.TransactionClient/
        );

        // The primitives accept a client (Phase 5 guarantee) — assert it, because losing
        // it would silently make the paired transaction impossible.
        expect(code(read(INVENTORY))).toMatch(
            /InventoryDb\s*=\s*PrismaClient\s*\|\s*Prisma\.TransactionClient/
        );
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// No scheduler was invented (brief §8)
// ─────────────────────────────────────────────────────────────────────────────

describe("no scheduler infrastructure was introduced", () => {
    const files = fs
        .readdirSync(path.join(ROOT, "lib/ticketing"))
        .filter((name) => name.endsWith(".ts"));

    test("the ticketing library contains no repeating timer, cron or job-queue", () => {
        expect(files.length).toBeGreaterThan(4);

        for (const name of files) {
            const source = code(read(`lib/ticketing/${name}`));

            // `setInterval` is a scheduler in miniature — a reaper, cleaner or poller must
            // not appear as one. Brief §8 assigns the job runner to another phase.
            expect(source).not.toMatch(/setInterval/);
            expect(source).not.toMatch(/bullmq|node-cron|agenda|node-schedule/i);
            expect(source).not.toMatch(/cron\.schedule/i);
            expect(source).not.toMatch(/new Worker\(|Queue\(/);
        }
    });

    test("the only setTimeout is the shared bounded retry backoff", () => {
        // A retry must pause between attempts (design §19: a deadlock victim that retries
        // instantly re-collides). That is a one-shot timer, not a scheduler — so it is
        // allowed exactly once, in one named place, and pinned here so timers cannot
        // spread through the library one convenience at a time.
        //
        // PHASE 7 moved that one place from `checkout.ts` to `db-contention.ts`, because the
        // settlement path needs the identical bounded, jittered retry (brief §18 requires it
        // there by name) and copying it would have created the second implementation the
        // brief forbids. The assertion is not weakened — it is still "exactly one file in
        // the ticketing library may contain a timer, and it is this one" — and it now also
        // proves the copy is gone.
        const withTimer = files.filter((name) =>
            /setTimeout/.test(code(read(`lib/ticketing/${name}`)))
        );

        expect(withTimer).toEqual(["db-contention.ts"]);

        const contention = code(read("lib/ticketing/db-contention.ts"));
        const occurrences = contention.match(/setTimeout/g) ?? [];

        expect(occurrences).toHaveLength(1);
        expect(contention).toMatch(/contentionBackoff/);

        // Both callers delegate to it rather than keeping their own pause.
        expect(code(read(CHECKOUT))).toMatch(/contentionBackoff/);
        expect(code(read(CHECKOUT))).not.toMatch(/setTimeout/);
        expect(
            code(read("lib/ticketing/payment/settlement.ts"))
        ).toMatch(/withContentionRetry/);
    });

    test("no unguarded retry loop exists (every retry re-runs the CAS)", () => {
        const checkout = code(read(CHECKOUT));

        // The retry branches must be the two classified, retryable causes.
        expect(checkout).toMatch(/isTransientContention\(error\)/);
        expect(checkout).toMatch(/isOrderNumberCollision\(error\)/);
        expect(checkout).toMatch(/isIdempotencyCollision\(error\)/);

        // …and the loop must be bounded.
        expect(checkout).toMatch(/CHECKOUT_MAX_ATTEMPTS/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Out-of-scope subsystems are untouched (brief §21/§22)
// ─────────────────────────────────────────────────────────────────────────────

describe("payment, issuance and messaging stay out of Phase 6", () => {
    const phase6Files = [
        RESERVATIONS,
        CHECKOUT,
        ORDERS,
        "lib/ticketing/order-payload.ts",
        "lib/ticketing/checkout-validation.ts",
        "lib/ticketing/idempotency.ts",
        CHECKOUT_ROUTE,
        ORDER_ROUTE,
        CANCEL_ROUTE,
    ];

    test("no iPaymu / payment-module import", () => {
        for (const file of phase6Files) {
            const source = code(read(file));

            expect(source).not.toMatch(/lib\/payment/);
            expect(source).not.toMatch(/ipaymu/i);
            // A raw provider URL still never appears here…
            expect(source).not.toMatch(/paymentUrl:\s*"http/);
            // …and neither does any credential or signing material. The provider's PUBLIC
            // handles (reference, transaction id, session id) ARE now projected onto the
            // customer payment card by design, so they are deliberately allowed — see
            // `__tests__/ticketing-payment/payment-identifiers.test.ts`.
            expect(source).not.toMatch(/apiKey|secretKey|webhookSecret|signature/i);
        }
    });

    test("no ticket issuance, QR generation or check-in", () => {
        for (const file of phase6Files) {
            const source = code(read(file));

            expect(source).not.toMatch(/prisma\.ticket\.create/);
            expect(source).not.toMatch(/qrToken|qrCode|QRCodeSVG/);
            expect(source).not.toMatch(/prisma\.checkIn\./);
        }
    });

    test("no notification / WhatsApp / email workflow", () => {
        for (const file of phase6Files) {
            const source = code(read(file));

            expect(source).not.toMatch(/whatsapp|baileys|nodemailer/i);
            expect(source).not.toMatch(/prisma\.notification\.create/);
        }
    });

    test("the checkout writes PIC attribution only through the shared resolver", () => {
        // PIC VERTICAL SLICE: Phase 6 pinned "no PIC writes" in the checkout path. The
        // slice moves ONE writer into Phase 6 — the `PICAttribution` row (its unique
        // orderId is the "duplicate attribution impossible" guarantee, design §14.6) —
        // and it may ONLY be written from checkout.ts via `resolveReferralAtCheckout`
        // from `lib/pic/attribution.ts`. Everything else stays banned:
        //   • the FEE LEDGER has no writer in any checkout-path file — EARNED rows are
        //     settlement's job (`postEarnedPicFees` in the SETTLED branch);
        //   • no other Phase 6 file touches the attribution row at all.
        const checkout = code(read(CHECKOUT));

        expect(checkout).toMatch(/resolveReferralAtCheckout/);
        // The attribution write is allowed here and only here.
        expect(checkout).toMatch(/pICAttribution\.create/);

        for (const file of phase6Files) {
            const source = file === CHECKOUT ? checkout : code(read(file));

            // The fee ledger never appears in the checkout path.
            expect(source).not.toMatch(/pICFeeLedger\.create/);
            expect(source).not.toMatch(/picFeeLedger\.create/);

            if (file !== CHECKOUT) {
                expect(source).not.toMatch(/pICAttribution\.create/);
            }
        }
    });

    test("the order payload never exposes organizer or inventory internals", () => {
        const payload = code(read("lib/ticketing/order-payload.ts"));

        // `organizerId` is a stored column on the order but must not be projected out.
        expect(payload).not.toMatch(/organizerId/);
        for (const field of ["quota", "sold", "reserved"]) {
            expect(payload).not.toMatch(new RegExp(`\\b${field}:`));
        }
    });

    test("D-60 stays unresolved — no uniqueness was invented", () => {
        const schema = read("prisma/schema.prisma");
        const ticketType = schema
            .split("model TicketType {")[1]
            .split("\n}")[0];

        expect(ticketType).not.toMatch(/@@unique/);
        expect(ticketType).not.toMatch(/name\s+String\s+@unique/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. Route hardening (brief §23, Phase 3 D-56)
// ─────────────────────────────────────────────────────────────────────────────

describe("every Phase 6 route is authenticated and hardened", () => {
    const stateChanging = [CHECKOUT_ROUTE, CANCEL_ROUTE];
    const reads = [ORDER_ROUTE];

    test("state-changing routes call requireSameOrigin(request)", () => {
        for (const file of stateChanging) {
            const source = code(read(file));

            expect(source).toMatch(/requireSameOrigin\(request\)/);
            expect(source).toMatch(/csrf\.error/);
            expect(source).toMatch(/export async function POST/);
        }
    });

    test("every route requires authentication before doing any work", () => {
        for (const file of [...stateChanging, ...reads]) {
            expect(code(read(file))).toMatch(/requireAuth\(\)/);
        }
    });

    test("no route falls back to a client-supplied identity or role", () => {
        for (const file of [...stateChanging, ...reads]) {
            const source = code(read(file));

            expect(source).not.toMatch(/isAdmin\s*\(/);
            expect(source).not.toMatch(/role\s*===\s*["']ADMIN["']/);
            expect(source).not.toMatch(/as any/);
            expect(source).not.toMatch(/body\.(userId|organizerId|customerId)/);
        }
    });

    test("the routes live under a prefix the proxy classifies as protected", () => {
        const proxy = read("proxy.ts");

        expect(proxy).toMatch(/PROTECTED_API_PREFIXES[\s\S]*"\/api\/ticketing\/"/);

        // …and the classification test itself still passes over the new files, which is
        // asserted in __tests__/authz/route-classification.test.ts.
    });
});
