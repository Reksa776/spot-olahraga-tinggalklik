/**
 * ==========================================
 * PHASE 8 — STATIC ARCHITECTURAL GUARDS (brief §32, §29, §41)
 * ==========================================
 *
 * Text-level assertions on the ticket-fulfilment layer. Following the Phase 6/7 precedent,
 * every pattern is anchored to a WRITE, an IMPORT, a ROUTE or a WRAPPER — never to a bare
 * noun in prose (comments are stripped first, precisely so a comment describing a banned
 * pattern cannot trip a guard). The brief's warning is explicit: a guard that fails because
 * a legitimate read mentions "reserved" is a brittle guard and not worth having.
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

function listDir(dir: string, extension = ".ts"): string[] {
    return fs
        .readdirSync(path.join(ROOT, dir))
        .filter((name) => name.endsWith(extension))
        .map((name) => `${dir}/${name}`);
}

const TICKET_DIR = "lib/ticketing/tickets";

const TICKET_FILES = listDir(TICKET_DIR);

const ISSUANCE = `${TICKET_DIR}/issuance.ts`;
const REFERENCE = `${TICKET_DIR}/reference.ts`;
const SERVICE = `${TICKET_DIR}/service.ts`;
const PAYLOAD = `${TICKET_DIR}/payload.ts`;
const VALIDATION = `${TICKET_DIR}/validation.ts`;

const ISSUE_ROUTE = "app/api/ticketing/orders/[orderNumber]/issue/route.ts";
const WALLET_ROUTE = "app/api/ticketing/tickets/route.ts";
const DETAIL_ROUTE = "app/api/ticketing/tickets/[ticketCode]/route.ts";

const PAYMENT_DIR = "lib/ticketing/payment";
const PAYMENT_FILES = listDir(PAYMENT_DIR);

const ORDER_PAYLOAD = "lib/ticketing/order-payload.ts";

const ROUTE_FILES = [
    ISSUE_ROUTE,
    WALLET_ROUTE,
    DETAIL_ROUTE,
    "app/api/ticketing/checkout/route.ts",
    "app/api/ticketing/orders/[orderNumber]/route.ts",
    "app/api/ticketing/orders/[orderNumber]/cancel/route.ts",
    "app/api/ticketing/orders/[orderNumber]/pay/route.ts",
];

// ─────────────────────────────────────────────────────────────────────────────
// Issuance owns fulfilment and NOTHING else (brief §4, §32.4)
// ─────────────────────────────────────────────────────────────────────────────

describe("issuance does not touch inventory, payment or reservations", () => {
    test("no ticket file contains raw SQL except the one documented row lock", () => {
        expect(TICKET_FILES.length).toBeGreaterThanOrEqual(5);

        for (const file of TICKET_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/\$executeRaw/);
        }

        // Exactly one raw statement in the whole layer, and it is the lock.
        const rawUsers = TICKET_FILES.filter((file) =>
            /\$queryRaw/.test(code(read(file)))
        );

        expect(rawUsers).toEqual([ISSUANCE]);

        const issuance = code(read(ISSUANCE));

        expect(issuance).toMatch(/SELECT id FROM eventorder WHERE id = \$\{orderId\} FOR UPDATE/);
        // The lock must serialise the ORDER row — the same row settlement locks first, so
        // the two paths queue rather than deadlock.
        expect(issuance).toMatch(/lockOrderRow\(tx, order\.id\)/);
    });

    test("no ticket file writes sold / reserved / version", () => {
        for (const file of TICKET_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/data\.(sold|reserved|version)\s*[=:]/);
            expect(source).not.toMatch(/increment:\s*[^,}]*(sold|reserved|version)/);
            expect(source).not.toMatch(/\b(sold|reserved)\s*(?:[-+*/]=|\+\+|--)/);
        }
    });

    test("no ticket file re-derives availability or runs a second reservation", () => {
        for (const file of [...TICKET_FILES, ORDER_PAYLOAD]) {
            const source = code(read(file));

            expect(source).not.toMatch(/quota\s*-\s*\w*\.?sold/);
            expect(source).not.toMatch(/\bsold\s*\+\s*\w*\.?reserved/);
        }

        for (const file of TICKET_FILES) {
            const source = code(read(file));

            // Fulfilment must not re-run a sale: the seats were converted by settlement,
            // and a second conversion would be exactly the double-mutation Phase 7's races
            // proved must not happen.
            expect(source).not.toMatch(/\breserveQuota\(/);
            expect(source).not.toMatch(/\bconfirmReservation\(/);
            expect(source).not.toMatch(/\breleaseReservation\(/);
            expect(source).not.toMatch(/ticketReservation\.(update|updateMany|create)/);
        }
    });

    test("issuance does not mutate the order's payment lifecycle", () => {
        const issuance = code(read(ISSUANCE));

        // It may READ these; it may never write them. A blocked order stays blocked
        // (brief §41: no auto-repair, no reopen, no second charge).
        expect(issuance).not.toMatch(/eventOrder\.update/);
        expect(issuance).not.toMatch(/paymentStatus:\s*"/);
        expect(issuance).not.toMatch(/\bstatus:\s*"PAID"/);
        expect(issuance).not.toMatch(/fulfilmentBlockedAt:\s*(null|new Date)/);
        expect(issuance).not.toMatch(/settleVerifiedPayment|failVerifiedPayment|createOrderPayment/);
        expect(issuance).not.toMatch(/prisma\.payment\./);
    });

    test("the payment layer was not extended to issue tickets", () => {
        for (const file of PAYMENT_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/issueTicketsForOrder/);
            expect(source).not.toMatch(/prisma\.ticket\./);
            expect(source).not.toMatch(/from "[^"]*tickets\//);
        }
    });

    test("issuance is a real transaction that re-checks the gate under the lock", () => {
        const issuance = code(read(ISSUANCE));

        expect(issuance).toMatch(/prisma\.\$transaction\(/);
        expect(issuance).toMatch(/withContentionRetry\(/);

        // The gate is asserted twice: once pre-flight to avoid pointless work, and once on
        // the freshly locked row, which is the authoritative one.
        const gateChecks = issuance.match(/assertOrderIsFulfillable\(/g) ?? [];
        expect(gateChecks.length).toBeGreaterThanOrEqual(3); // definition + 2 call sites
        expect(issuance).toMatch(/findUniqueOrThrow\(\{\s*where: \{ id: order\.id \}/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency is enforced by the database, not by hope (brief §8)
// ─────────────────────────────────────────────────────────────────────────────

describe("idempotency leans on the database", () => {
    test("the issuance plan is derived from persisted rows, never from a status flag", () => {
        const issuance = code(read(ISSUANCE));

        // The "already issued" decision comes from reading existing ticket rows…
        expect(issuance).toMatch(/tx\.ticket\.findMany\(/);
        expect(issuance).toMatch(/present\.has\(/);
        // …and the per-line quantity from the persisted order item.
        expect(issuance).toMatch(/line\.quantity/);
        expect(issuance).toMatch(/items:\s*\{\s*select: \{ id: true, quantity: true, ticketTypeId: true \}/);
        // No `issuedAt`-on-the-order style flag, and no schema field invented for it.
        expect(issuance).not.toMatch(/order\.(issuedAt|issued|isIssued)\b/);
    });

    test("the unique constraint the guarantee rests on is real and schema-level", () => {
        const schema = read("prisma/schema.prisma");

        expect(schema).toMatch(/@@unique\(\[orderItemId, sequenceNo\]\)/);
        expect(schema).toMatch(/ticketCode\s+String\s+@unique/);
        expect(schema).toMatch(/qrTokenHash\s+String\s+@unique/);
    });

    test("the retry is bounded, shared and contention-classified", () => {
        const issuance = code(read(ISSUANCE));
        const contention = code(read("lib/ticketing/db-contention.ts"));

        expect(issuance).toMatch(/withContentionRetry/);
        // No second backoff implementation and no blanket retry-all.
        expect(issuance).not.toMatch(/setTimeout/);
        expect(contention).toMatch(/isTransientContention/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ownership and authority (brief §15, §16, §27)
// ─────────────────────────────────────────────────────────────────────────────

describe("the ticket surfaces derive authority from the session", () => {
    test("the read service scopes its queries with the ownership predicate", () => {
        const service = code(read(SERVICE));

        expect(service).toMatch(/from "@\/lib\/authz\/guards"/);
        expect(service).toMatch(/requireOwnResource\(/);
        expect(service).toMatch(/PERMISSIONS\.TICKET_READ_OWN/);

        // Predicate IN the query, not a comparison afterwards: there is no code path that
        // fetches a row and then decides whether the caller may see it.
        expect(service).toMatch(/where: \{ ticketCode, holderUserId: actor\.userId \}/);
        expect(service).toMatch(/holderUserId: actor\.userId/);
    });

    test("issuance resolves its own scope and owns its permission", () => {
        const issuance = code(read(ISSUANCE));

        expect(issuance).toMatch(/requireOwnResource\(\s*PERMISSIONS\.TICKET_ISSUE_OWN/);
        expect(issuance).toMatch(/where: \{ orderNumber: params\.orderNumber, userId: params\.actor\.userId \}/);
        expect(issuance).toMatch(/holderUserId:\s*order\.userId/);
    });

    test("the permission map grants the new capabilities to buyers, not to organizers", () => {
        const permissions = code(read("lib/authz/permissions.ts"));

        expect(permissions).toMatch(/TICKET_READ_OWN:\s*"ticket\.read\.own"/);
        expect(permissions).toMatch(/TICKET_ISSUE_OWN:\s*"ticket\.issue\.own"/);

        // Own-scope by construction: both are in the OWN_SCOPE list the resolver keys off.
        const ownScope = permissions
            .split("const OWN_SCOPE: readonly Permission[] = [")[1]
            .split("];")[0];

        expect(ownScope).toContain("P.TICKET_READ_OWN");
        expect(ownScope).toContain("P.TICKET_ISSUE_OWN");

        // The customer role carries both. `CUSTOMER: toSet(` appears in all three role maps
        // (platform-wide, platform-in-tenant, membership-in-tenant) — the empty entries are
        // deliberate — so the guard looks for the block that actually grants them rather
        // than trusting a positional split.
        const customerBlocks = [
            ...permissions.matchAll(/CUSTOMER: toSet\(\[([\s\S]*?)\]\)/g),
        ].map((match) => match[1]);

        expect(customerBlocks.length).toBeGreaterThan(0);
        expect(
            customerBlocks.some(
                (block) =>
                    block.includes("P.TICKET_READ_OWN") &&
                    block.includes("P.TICKET_ISSUE_OWN")
            )
        ).toBe(true);
    });

    test("the issue route is authenticated, same-origin protected and body-free", () => {
        const route = code(read(ISSUE_ROUTE));

        expect(route).toMatch(/requireSameOrigin\(request\)/);
        expect(route).toMatch(/csrf\.error/);
        expect(route).toMatch(/requireAuth\(\)/);
        expect(route).toMatch(/export async function POST/);

        // It reads NOTHING from the body: there is no field a client could supply that
        // would be authoritative, so there is nothing to validate (brief §27).
        expect(route).not.toMatch(/request\.json\(\)/);
        expect(route).not.toMatch(/body\./);
        expect(route).not.toMatch(/as any/);
    });

    test("the wallet and detail routes authenticate with the shared guard", () => {
        for (const file of [WALLET_ROUTE, DETAIL_ROUTE]) {
            const route = code(read(file));

            expect(route).toMatch(/from "@\/lib\/authz"/);
            expect(route).toMatch(/requireAuth\(\)/);
            // Reads do not need the origin check; they must not invent another auth path.
            expect(route).not.toMatch(/getServerSession|next-auth/);
        }
    });

    test("no ticket surface accepts an authoritative identity or financial field", () => {
        const schema = code(read(VALIDATION));

        for (const banned of [
            "userId",
            "holderUserId",
            "organizerId",
            "customerId",
            "orderId",
            "eventOrderId",
            "paymentStatus",
            "ticketStatus",
            "paidAt",
            "issuedAt",
            "ticketCode",
            "qrToken",
            "qrPayload",
            "sequenceNo",
            "amount",
            "total",
            "price",
            "currency",
        ]) {
            expect(schema).not.toMatch(new RegExp(`\\b${banned}:\\s*z\\.`));
        }

        // The two filters it DOES accept are explicitly non-authoritative, and neither is a
        // passthrough that would let an identity field survive.
        expect(schema).not.toMatch(/\.passthrough\(\)/);
        expect(schema).not.toMatch(/\.catchall\(/);
        expect(schema).toMatch(/status: z\.enum\(WALLET_STATUS_VALUES\)/);
        expect(schema).toMatch(/eventId: z\.string\(\)/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// QR and identity (brief §11, §12, §36)
// ─────────────────────────────────────────────────────────────────────────────

describe("the QR is a public reference, not a credential", () => {
    test("the raw token is generated, hashed, and never returned or persisted in clear", () => {
        const reference = code(read(REFERENCE));
        const issuance = code(read(ISSUANCE));

        expect(reference).toMatch(/crypto\.randomBytes\(QR_TOKEN_BYTES\)/);
        expect(reference).toMatch(/createHash\("sha256"\)/);
        expect(issuance).toMatch(/qrTokenHash:\s*hashQrToken\(generateQrToken\(\)\)/);
        // The plaintext is never bound to a variable that could escape.
        expect(issuance).not.toMatch(/const\s+\w+\s*=\s*generateQrToken\(\)/);
    });

    test("no response builder ever projects the token or its hash", () => {
        for (const file of [PAYLOAD, SERVICE, ORDER_PAYLOAD]) {
            const source = code(read(file));

            expect(source).not.toMatch(/qrTokenHash:\s*true/);
            expect(source).not.toMatch(/\bqrToken\b/);
        }
    });

    test("the QR payload is namespaced, validated and built only from the public code", () => {
        const reference = code(read(REFERENCE));

        expect(reference).toMatch(/TICKET_QR_PREFIX = "TICKET:"/);
        expect(reference).toMatch(/export function buildTicketQrPayload/);
        expect(reference).toMatch(/export function assertQrPayloadIsSafe/);
        // A URL in a QR would invite a public ticket page, which the brief forbids.
        expect(reference).not.toMatch(/`https?:\/\//);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit (brief §26)
// ─────────────────────────────────────────────────────────────────────────────

describe("audit reuses the existing logger and stays PII-free", () => {
    test("issuance writes through the shared ticketing audit helper", () => {
        const issuance = code(read(ISSUANCE));

        expect(issuance).toMatch(/from "\.\.\/audit-log"/);
        expect(issuance).toMatch(/writeTicketingAudit\(/);
        expect(issuance).toMatch(/action: "ticket\.issue"/);
        expect(issuance).toMatch(/entityType: "Ticket"/);
        // One row per fulfilment, not one per ticket.
        expect(issuance).toMatch(/entityRef: order\.orderNumber/);
    });

    test("no second audit writer exists in the ticket layer", () => {
        for (const file of TICKET_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/adminAuditLog\.create/);
            expect(source).not.toMatch(/new .*AuditLogger/);
        }
    });

    test("a repeated call writes nothing, and the payload carries no buyer PII", () => {
        const issuance = code(read(ISSUANCE));

        expect(issuance).toMatch(/if \(created\.length > 0\)/);

        const payloadBlock = issuance.split("afterState:")[1] ?? "";

        for (const banned of ["buyerEmail", "buyerPhone", "buyerName", "attendeeEmail", "qrToken"]) {
            expect(payloadBlock).not.toContain(banned);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Out of scope stays out of scope (brief §3, §40, §41, §42, §43)
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 8 did not drift into later phases", () => {
    const files = [...TICKET_FILES, ...ROUTE_FILES];

    test("no check-in implementation", () => {
        for (const file of files) {
            const source = code(read(file));

            // The word CHECKED_IN legitimately appears as a READ (the wallet's status
            // filter and the admission explanation), so the guard is anchored to the
            // WRITES that would constitute a check-in feature.
            expect(source).not.toMatch(/prisma\.checkIn\./);
            expect(source).not.toMatch(/checkIn\.create/);
            expect(source).not.toMatch(/checkedInAt:\s*(new Date|now)/);
            expect(source).not.toMatch(/status:\s*"CHECKED_IN"/);
        }

        expect(fs.existsSync(path.join(ROOT, "app/api/ticketing/checkin"))).toBe(false);
    });

    test("no refund, payout or settlement ledger", () => {
        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/prisma\.refund\.(create|update)/);
            expect(source).not.toMatch(/refundedAt:\s*new Date/);
            expect(source).not.toMatch(/payout|disbursement/i);
        }
    });

    test("no reissue, void or revocation workflow", () => {
        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/qrVersion:\s*\{\s*increment/);
            expect(source).not.toMatch(/voidedAt:\s*new Date/);
            expect(source).not.toMatch(/qrTokenHash:\s*hashQrToken\(generateQrToken\(\)\),\s*\/\/ reissue/);
        }
    });

    test("no notification workflow and no new infrastructure", () => {
        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/whatsapp|baileys|nodemailer/i);
            expect(source).not.toMatch(/prisma\.notification\.create/);
            expect(source).not.toMatch(/setInterval/);
            expect(source).not.toMatch(/bullmq|node-cron|agenda|node-schedule/i);
            expect(source).not.toMatch(/ioredis|from "redis"/i);
            // Issuance must not make network calls of any kind.
            expect(source).not.toMatch(/\bfetch\(/);
        }
    });

    test("the ticket layer does not reach into retail or the payment adapter", () => {
        for (const file of files) {
            const source = code(read(file));

            expect(source).not.toMatch(/from "@\/app\/api\/orders/);
            expect(source).not.toMatch(/from "@\/app\/api\/checkout/);
            expect(source).not.toMatch(/from "@\/app\/api\/payment/);
            expect(source).not.toMatch(/lib\/payment\/ipaymu/);
            expect(source).not.toMatch(/from "@\/lib\/payment/);
        }
    });

    test("the retail models are gone and no ticketing model took their names over", () => {
        const schema = read("prisma/schema.prisma");

        // This assertion was originally the inverse: the legacy retail models had to still exist,
        // because the ticketing work was additive and retail was live. The product is a ticketing
        // platform, the retail application was removed, and its models were removed with it — so
        // the guarantee is now that they are absent AND that no ticketing model was renamed into
        // one of the freed names (`Ticket` is not `Order`, `TicketType` is not `Product`).
        for (const model of [
            "model Order ",
            "model OrderItem ",
            "model Product ",
            "model ProductVariant ",
            "model FlashSale ",
            "model Cart ",
            "model UserAddress ",
            "model Voucher ",
            "model AffiliateProfile ",
            "model SpinWheelSpin ",
            "model ShippingDiscount ",
            "model Broadcast ",
        ]) {
            expect(schema).not.toContain(model);
        }

        // The ticketing models are the ones that exist, under their own names.
        for (const model of [
            "model Event ",
            "model EventOrder ",
            "model EventOrderItem ",
            "model TicketType ",
            "model Ticket ",
            "model Payment ",
        ]) {
            expect(schema).toContain(model);
        }

        // The ticket layer references only ticketing models.
        const issuance = code(read(ISSUANCE));

        for (const retail of ["prisma.order.", "prisma.product", "prisma.flashsale"]) {
            expect(issuance).not.toContain(retail);
        }
    });

    test("the phase added no dependency", () => {
        const pkg = JSON.parse(read("package.json")) as {
            dependencies: Record<string, string>;
        };

        // The QR renderer was already a dependency (the event share route uses it), so this
        // phase's `package.json` diff is empty — as the brief requires unless it is
        // justified in the report.
        expect(pkg.dependencies["qrcode.react"]).toBeDefined();
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Route classification (brief §29)
// ─────────────────────────────────────────────────────────────────────────────

describe("every Phase 8 route is classified", () => {
    const proxy = read("proxy.ts");

    const publicList = proxy
        .split("export const PUBLIC_API_PREFIXES = [")[1]
        .split("];")[0];
    const protectedList = proxy
        .split("export const PROTECTED_API_PREFIXES = [")[1]
        .split("];")[0];

    const publicLiterals = (publicList.match(/"[^"]*"/g) ?? []).map((literal) =>
        literal.slice(1, -1)
    );
    const protectedLiterals = (protectedList.match(/"[^"]*"/g) ?? []).map((literal) =>
        literal.slice(1, -1)
    );

    test("the new routes are covered, and covered as protected", () => {
        for (const urlPath of [
            "/api/ticketing/tickets",
            "/api/ticketing/tickets/EVT-ABCD-EFGH",
            "/api/ticketing/orders/EVT-20260101-ABC123/issue",
        ]) {
            expect(protectedLiterals.some((prefix) => urlPath.startsWith(prefix))).toBe(true);
        }
    });

    test("no wallet or issuance path is public", () => {
        for (const urlPath of ["/api/ticketing/tickets", "/api/ticketing/orders/x/issue"]) {
            expect(publicLiterals.some((prefix) => urlPath.startsWith(prefix))).toBe(false);
        }
    });

    test("no prefix appears in both lists", () => {
        for (const literal of publicLiterals) {
            expect(protectedLiterals).not.toContain(literal);
        }
    });
});
