/**
 * ==========================================
 * PHASE 10B — STATIC ARCHITECTURAL GUARDS
 * ==========================================
 *
 * Text-level assertions on the refund layer, following the Phase 6/7/8 precedent: every
 * pattern is anchored to a WRITE, an IMPORT, a ROUTE or a WRAPPER, and comments are
 * stripped first, so a comment DESCRIBING a banned pattern cannot trip a guard.
 *
 * These guards encode the decisions that a code review would otherwise have to re-derive:
 * the webhook can never create a refund, the transactional core is authz-free so the public
 * webhook can import it, quota is restored only on confirmation, every status move is a CAS,
 * and D-R17's "never fabricate a refund success" holds at the provider seam.
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

const REFUND_DIR = "lib/ticketing/refunds";
const REFUND_FILES = listDir(REFUND_DIR);

const SETTLEMENT = `${REFUND_DIR}/settlement.ts`;
const SERVICE = `${REFUND_DIR}/service.ts`;
const ELIGIBILITY = `${REFUND_DIR}/eligibility.ts`;
const PAYLOAD = `${REFUND_DIR}/payload.ts`;
const VALIDATION = `${REFUND_DIR}/validation.ts`;

const ROOT_ROUTE = "app/api/ticketing/refunds/route.ts";
const APPROVE_ROUTE = "app/api/ticketing/refunds/[refundId]/approve/route.ts";
const REJECT_ROUTE = "app/api/ticketing/refunds/[refundId]/reject/route.ts";
const EXECUTE_ROUTE = "app/api/ticketing/refunds/[refundId]/execute/route.ts";
// PHASE 18B (D-P17-04 = B): the manual bank-transfer rail's two extra edges.
const SETTLE_ROUTE = "app/api/ticketing/refunds/[refundId]/settle/route.ts";
const FAIL_ROUTE = "app/api/ticketing/refunds/[refundId]/fail/route.ts";

const ROUTE_FILES = [
    ROOT_ROUTE,
    APPROVE_ROUTE,
    REJECT_ROUTE,
    EXECUTE_ROUTE,
    SETTLE_ROUTE,
    FAIL_ROUTE,
];

const WEBHOOK = "lib/ticketing/payment/webhook.ts";
const PROVIDER = "lib/ticketing/payment/refund-provider.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The module graph: the webhook can reach settlement, and settlement has no auth
// ─────────────────────────────────────────────────────────────────────────────

describe("the settlement core is authz-free and the webhook cannot reach it", () => {
    test("settlement.ts has no dependency on authz, auth or a session", () => {
        const settlement = code(read(SETTLEMENT));

        // A type-only import of the scope shape is fine (it erases at compile time); the
        // runtime guards, the session package and the session reader are what must not be
        // reachable from the public webhook.
        expect(settlement).not.toMatch(/from "@\/lib\/authz\/guards"/);
        expect(settlement).not.toMatch(/from "@\/auth"/);
        expect(settlement).not.toMatch(/next-auth/);
        expect(settlement).not.toMatch(/requireOrganizerAccess|requireOwnResource/);
        expect(settlement).not.toMatch(/getServerSession/);
    });

    test("service.ts owns the authorization; settlement owns the money", () => {
        const service = code(read(SERVICE));

        expect(service).toMatch(/from "@\/lib\/authz\/guards"/);
        expect(service).toMatch(
            /requireOwnResource\(\s*PERMISSIONS\.REFUND_REQUEST_OWN/
        );
        expect(service).toMatch(/requireOrganizerAccess\(/);
        expect(service).toMatch(/PERMISSIONS\.REFUND_APPROVE/);
        expect(service).toMatch(/PERMISSIONS\.REFUND_EXECUTE/);
        expect(service).toMatch(/from "\.\/settlement"/);
        // Phase 18B: the rail is manual, so there is no provider call anywhere in the
        // actor-facing service. Re-introducing one would need a real endpoint to exist first.
        expect(service).not.toMatch(/getRefundProvider|setRefundProvider/);
        expect(service).not.toMatch(/provider\.refund\(/);
    });

    test("the webhook cannot settle a refund on the manual rail", () => {
        const webhook = code(read(WEBHOOK));

        // Phase 18B: the refund-confirmation entry point was removed, so the webhook no
        // longer reaches the refund settlement core at all — a callback can record a
        // delivery but can never move money.
        expect(webhook).not.toMatch(/refunds\/settlement/);
        expect(webhook).not.toMatch(/confirmInboundRefund/);
        expect(webhook).toMatch(/ignored_refund_rail_is_manual/);
        // Importing the actor-facing service would drag NextAuth into the webhook.
        expect(webhook).not.toMatch(/refunds\/service/);
        expect(webhook).not.toMatch(/requestRefund|approveRefund|executeRefund/);
    });

    test("the webhook never creates or decides a refund itself", () => {
        const webhook = code(read(WEBHOOK));

        expect(webhook).not.toMatch(/refund\.create/);
        expect(webhook).not.toMatch(/refund\.update/);
        expect(webhook).not.toMatch(/refundItem\.create/);
        expect(webhook).not.toMatch(/refundRequestSchema|refundApproveSchema/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-R06: quota returns only after a confirmed refund
// ─────────────────────────────────────────────────────────────────────────────

describe("inventory is restored only by confirmed settlement", () => {
    test("restoreSoldQuota is called from exactly one module, in settlement", () => {
        const callers = REFUND_FILES.filter((file) =>
            /restoreSoldQuota\(/.test(code(read(file)))
        );

        expect(callers).toEqual([SETTLEMENT]);
    });

    test("the restore is gated by the event opt-in and runs inside the transaction", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(/if \(order\.event\?\.returnQuotaOnRefund\)/);
        expect(settlement).toMatch(/restoreSoldQuota\(ticketTypeId, quantity, tx\)/);
    });

    test("request and approve never touch the counters", () => {
        for (const file of [SERVICE, ELIGIBILITY, VALIDATION]) {
            const source = code(read(file));

            expect(source).not.toMatch(/restoreSoldQuota|sold\s*:|reserved\s*:/);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-R11: every lifecycle move is a compare-and-swap
// ─────────────────────────────────────────────────────────────────────────────

describe("the lifecycle transitions are guarded by a status CAS", () => {
    test("approve CASes PENDING -> APPROVED", () => {
        const service = code(read(SERVICE));

        expect(service).toMatch(
            /updateMany\(\{\s*where: \{ id: refundId, status: "PENDING" \}/
        );
    });

    test("execute CASes APPROVED -> PROCESSING before the provider call", () => {
        const service = code(read(SERVICE));

        expect(service).toMatch(
            /updateMany\(\{\s*where: \{ id: refundId, status: "APPROVED" \}/
        );
    });

    test("settlement CASes PROCESSING -> REFUNDED and treats a loss as ALREADY_REFUNDED", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(
            /updateMany\(\{\s*where: \{ id: refundId, status: "PROCESSING" \}/
        );
        expect(settlement).toMatch(/ALREADY_REFUNDED/);
    });

    test("failure CASes PROCESSING -> FAILED", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(
            /updateMany\(\{\s*where: \{ id: refundId, status: "PROCESSING" \}/
        );
        expect(settlement).toMatch(/status: "FAILED"/);
    });

    test("settlement is a single retried transaction", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(/withContentionRetry\(/);
        expect(settlement).toMatch(/prisma\.\$transaction\(/);
        expect(settlement).not.toMatch(/setTimeout/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-R09/D-R10: the amount is server-derived and a ticket is claimed once
// ─────────────────────────────────────────────────────────────────────────────

describe("money and claims are database-authoritative", () => {
    test("no refund module converts money through Number()", () => {
        for (const file of REFUND_FILES) {
            const source = code(read(file));

            expect(source).not.toMatch(/\bNumber\s*\(/);
        }
    });

    test("the payload renders money with moneyString, never toFixed on a Number", () => {
        const payload = code(read(PAYLOAD));

        expect(payload).toMatch(/moneyString\(row\.requestedAmount\)/);
        expect(payload).toMatch(/moneyString\(row\.confirmedAmount\)/);
        expect(payload).not.toMatch(/Number\(/);
    });

    test("the schema makes a double refund impossible, not merely unlikely", () => {
        const schema = read("prisma/schema.prisma");

        expect(schema).toMatch(/ticketId\s+String\s+@unique/);
        // The claim row cascades with its parent refund but RESTRICTS on the ticket, so a
        // claimed ticket cannot be deleted out from under the claim.
        expect(schema).toMatch(/@relation\(fields: \[refundId\], references: \[id\], onDelete: Cascade/);
        expect(schema).toMatch(
            /ticket\s+Ticket\s+@relation\(fields: \[ticketId\], references: \[id\], onDelete: Restrict/
        );
    });

    test("request releases nothing; reject and fail release the claims", () => {
        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(/export async function releaseRefundClaims/);
        expect(settlement).toMatch(/tx\.refundItem\.deleteMany/);

        const service = code(read(SERVICE));

        // reject calls the shared release; request never deletes its own items.
        expect(service).toMatch(/releaseRefundClaims\(tx, refundId\)/);
        expect(service).not.toMatch(/refundItem\.deleteMany/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-R17: an unsupported provider is reported truthfully, never faked
// ─────────────────────────────────────────────────────────────────────────────

describe("the provider seam cannot fabricate a refund", () => {
    test("the default adapter returns UNSUPPORTED and never a success", () => {
        const provider = code(read(PROVIDER));

        expect(provider).toMatch(/reason: "UNSUPPORTED"/);
        expect(provider).toMatch(/getRefundProvider/);
        // No outbound call exists to be made.
        expect(provider).not.toMatch(/\bfetch\(/);
        expect(provider).not.toMatch(/https?:\/\//);
    });

    test("the provider seam is documented but no longer called by production", () => {
        const provider = code(read(PROVIDER));

        // The capability statement survives — it is why the rail is manual.
        expect(provider).toMatch(/reason: "UNSUPPORTED"/);
        expect(provider).toMatch(/getRefundProvider/);

        const service = code(read(SERVICE));

        expect(service).not.toMatch(/getRefundProvider/);
    });

    test("only the settlement core may write REFUNDED, and only from PROCESSING", () => {
        const service = code(read(SERVICE));

        // The lifecycle endpoints never write REFUNDED themselves: `executeRefund` claims,
        // `settleRefund` delegates to the transactional core, and nothing writes REJECTED
        // except the human reject action.
        const between = service
            .split("export async function executeRefund")[1]
            .split("export async function listRefunds")[0];

        expect(between).not.toMatch(/status: "REFUNDED"/);
        expect(between).not.toMatch(/status: "REJECTED"/);
        expect(between).toMatch(/processConfirmedRefund\(/);

        const settlement = code(read(SETTLEMENT));

        expect(settlement).toMatch(
            /updateMany\(\{\s*where: \{ id: refundId, status: "PROCESSING" \}/
        );
        expect(settlement).toMatch(/status: "REFUNDED"/);
    });

    test("a manual settlement requires recorded transfer evidence", () => {
        const validation = code(read(VALIDATION));
        const settle = validation.split("export const refundSettleSchema")[1];

        // The reference is required, and the schema accepts no amount of its own.
        expect(settle).toMatch(/transferRef: z\.string\(\)\.trim\(\)\.min\(3\)/);
        expect(settle).not.toMatch(/confirmedAmount/);
        expect(settle).not.toMatch(/\bamount:\s*z\./);

        const service = code(read(SERVICE));
        const settleFn = service
            .split("export async function settleRefund")[1]
            .split("export async function failRefund")[0];

        // The settled amount is derived from the stored claim, never from the request body.
        expect(settleFn).toMatch(/confirmedAmount: moneyString\(amount\)/);
        expect(settleFn).toMatch(/evidenceNote: input\.note/);
        expect(settleFn).toMatch(/providerRef: input\.transferRef/);
    });

    test("at most one PROCESSING refund per order is enforced under a row lock", () => {
        const service = code(read(SERVICE));
        const execute = service
            .split("export async function executeRefund")[1]
            .split("export async function settleRefund")[0];

        // A plain count outside a transaction is the race this guard exists to prevent.
        expect(execute).toMatch(/SELECT id FROM eventorder WHERE id = \$\{orderId\} FOR UPDATE/);
        expect(execute).toMatch(/status: "PROCESSING"/);
        expect(execute).toMatch(/\$transaction\(/);
        expect(execute).toMatch(/REFUND_ALREADY_PROCESSING/);
    });

    test("no fake provider success and no payout concept was invented", () => {
        for (const file of [...REFUND_FILES, ...ROUTE_FILES, WEBHOOK]) {
            const source = code(read(file));

            expect(source).not.toMatch(/payout|disbursement/i);
        }
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// D-R07: the lifecycle vocabulary is the enum, and the route surface is guarded
// ─────────────────────────────────────────────────────────────────────────────

describe("the lifecycle and the route surface", () => {
    test("the schema enum carries exactly the lifecycle states", () => {
        const schema = read("prisma/schema.prisma");

        const enumBlock = schema
            .split("enum RefundStatus {")[1]
            .split("}")[0];

        for (const status of [
            "PENDING",
            "APPROVED",
            "REJECTED",
            "PROCESSING",
            "REFUNDED",
            "FAILED",
        ]) {
            expect(enumBlock).toMatch(new RegExp(`\\b${status}\\b`));
        }
    });

    test("every write route is authenticated, same-origin protected and validated", () => {
        for (const file of [ROOT_ROUTE, APPROVE_ROUTE, REJECT_ROUTE, EXECUTE_ROUTE]) {
            const route = code(read(file));

            expect(route).toMatch(/requireAuth\(\)/);
            expect(route).toMatch(/export async function POST/);
            expect(route).toMatch(/handleApi\(/);
            expect(route).not.toMatch(/getServerSession|next-auth/);
        }

        for (const file of [ROOT_ROUTE, APPROVE_ROUTE, REJECT_ROUTE, EXECUTE_ROUTE]) {
            const route = code(read(file));

            expect(route).toMatch(/requireSameOrigin\(request\)/);
            expect(route).toMatch(/csrf\.error/);
        }
    });

    test("the list route is authenticated but not origin-checked", () => {
        const route = code(read(ROOT_ROUTE));

        expect(route).toMatch(/export async function GET/);
        expect(route).toMatch(/requireAuth\(\)/);
        expect(route).toMatch(/parseOrThrow\(\s*refundListQuerySchema/);
    });

    test("the refund routes sit behind the protected ticketing prefix", () => {
        const proxy = read("proxy.ts");

        const protectedList = proxy
            .split("export const PROTECTED_API_PREFIXES = [")[1]
            .split("];")[0];
        const protectedLiterals = (protectedList.match(/"[^"]*"/g) ?? []).map(
            (literal) => literal.slice(1, -1)
        );

        for (const urlPath of [
            "/api/ticketing/refunds",
            "/api/ticketing/refunds/42/approve",
            "/api/ticketing/refunds/42/execute",
            "/api/ticketing/refunds/42/settle",
            "/api/ticketing/refunds/42/fail",
        ]) {
            expect(
                protectedLiterals.some((prefix) => urlPath.startsWith(prefix))
            ).toBe(true);
        }
    });

    test("the request route does not accept an amount from the client", () => {
        const validation = code(read(VALIDATION));

        // Scoped to the WRITE schemas: `organizerId` legitimately appears later as a
        // read-only list filter, which is why the guard must not scan the whole file.
        const writeSchemas = validation
            .split("export const refundRequestSchema")[1]
            .split("export const refundListQuerySchema")[0];

        for (const banned of [
            "amount",
            "total",
            "price",
            "currency",
            "organizerId",
            "userId",
            "status",
            "providerRef",
        ]) {
            expect(writeSchemas).not.toMatch(new RegExp(`\\b${banned}:\\s*z\\.`));
        }

        expect(validation).not.toMatch(/\.passthrough\(\)/);
        expect(validation).not.toMatch(/\.catchall\(/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// PHASE MIGRATION_CUSTOMER_REFUND_EVIDENCE: the evidence FILE rails
// ─────────────────────────────────────────────────────────────────────────────

const EVIDENCE = `${REFUND_DIR}/evidence.ts`;
const ORGANIZER_EVIDENCE_POST = "app/api/organizer/refunds/[refundId]/evidence/route.ts";
const ORGANIZER_EVIDENCE_GET = "app/api/organizer/refunds/[refundId]/evidence/[fileName]/route.ts";
const BUYER_EVIDENCE_GET = "app/api/ticketing/refunds/[refundId]/evidence/[fileName]/route.ts";

describe("the evidence file rail is additive: it never settles, it never trusts the client", () => {
    test("the storage engine is the only writer and the only reader of the tree", () => {
        const evidence = code(read(EVIDENCE));

        // Magic bytes, not the declared MIME; server-generated name; 5MB on the REAL bytes.
        expect(evidence).toMatch(/detectImageFormat\(buffer\)/);
        expect(evidence).toMatch(/%PDF-/);
        expect(evidence).toMatch(/crypto\.randomBytes/);
        expect(evidence).toMatch(/buffer\.length > MAX_REFUND_EVIDENCE_BYTES/);
        expect(evidence).toMatch(/MAX_REFUND_EVIDENCE_BYTES = 5 \* 1024 \* 1024/);
        expect(evidence).toMatch(/\.tmp[\s\S]*?fs\.rename/);
        // The reader is basename-guarded, exactly like readStoredProof.
        expect(evidence).toMatch(/path\.basename\(key\)/);
        expect(evidence).toMatch(/safeName !== key/);
        // It never takes a filesystem path from a caller.
        expect(evidence).not.toMatch(/readFile\([^)]*fileName/);

        // No other refund module touches fs — the tree has one owner.
        const others = REFUND_FILES.filter((file) => file !== EVIDENCE && /fs\/promises|node:fs/.test(code(read(file))));
        expect(others).toEqual([]);
    });

    test("the attach rail runs the settle gates, CASes the key and rolls the loser back", () => {
        const service = code(read(SERVICE));
        const attach = service
            .split("export async function attachRefundEvidence")[1]
            .split("export async function readRefundEvidenceForOrganizer")[0];

        // The SAME gates as settleRefund, and no status write of any kind: attaching a file
        // must never become a second way to settle a refund.
        expect(attach).toMatch(/authorizeRefundEvidenceAttachment\(refund, actor\)/);
        expect(attach).toMatch(/storeRefundEvidence\(file\)/);
        expect(attach).toMatch(/where: \{ id: refundId, evidenceFileKey: refund\.evidenceFileKey \}/);
        expect(attach).toMatch(/cas\.count !== 1/);
        expect(attach).toMatch(/await deleteRefundEvidence\(stored\.key\)/);
        expect(attach).toMatch(/await deleteRefundEvidence\(refund\.evidenceFileKey\)/);
        expect(attach).toMatch(/action: "refund\.evidence_upload"/);
        expect(attach).not.toMatch(/status: "REFUNDED"|processConfirmedRefund|confirmedAmount/);

        const evidence = code(read(EVIDENCE));
        const gate = evidence
            .split("export async function authorizeRefundEvidenceAttachment")[1]
            .split("export async function readStoredRefundEvidence")[0];
        expect(gate).toMatch(/requireOrganizerAccess\(refund\.organizerId, PERMISSIONS\.REFUND_EXECUTE\)/);
        expect(gate).toMatch(/scope\.userId === refund\.requestedByUserId/);
    });

    test("the organizer serve route is tenant-gated and the buyer route is own-gated", () => {
        const service = code(read(SERVICE));
        const staff = service
            .split("export async function readRefundEvidenceForOrganizer")[1]
            .split("export async function readRefundEvidenceForBuyer")[0];
        const buyer = service
            .split("export async function readRefundEvidenceForBuyer")[1]
            .split("export async function listRefunds")[0];

        // Staff: the refund's OWN tenant, the settle permission, and the row's exact key.
        expect(staff).toMatch(/requireOrganizerAccess\(refund\.organizerId, PERMISSIONS\.REFUND_EXECUTE\)/);
        expect(staff).toMatch(/refund\.evidenceFileKey !== fileName/);

        // Buyer: the ORDER's own user, ORDER_READ_OWN, and no tenant branch at all.
        expect(buyer).toMatch(/refund\.eventOrder\.userId !== actor\.userId/);
        expect(buyer).toMatch(/requireOwnResource\(PERMISSIONS\.ORDER_READ_OWN, actor\.userId\)/);
        expect(buyer).toMatch(/refund\.evidenceFileKey !== fileName/);
        expect(buyer).not.toMatch(/requireOrganizerAccess/);

        for (const route of [ORGANIZER_EVIDENCE_POST, ORGANIZER_EVIDENCE_GET, BUYER_EVIDENCE_GET]) {
            const source = code(read(route));
            // A route never reaches the storage tree: bytes come from the service.
            expect(source).not.toMatch(/readStoredRefundEvidence|storeRefundEvidence|fs\/promises/);
        }

        // The two SERVE routes are the ones that name a file, and each validates it with
        // the writer's own shape before it ever reaches the service.
        for (const route of [ORGANIZER_EVIDENCE_GET, BUYER_EVIDENCE_GET]) {
            const source = code(read(route));
            expect(source).toMatch(/parseOrThrow\(refundEvidenceFileNameSchema, fileName\)/);
            expect(source).toMatch(/X-Content-Type-Options": "nosniff"/);
            expect(source).toMatch(/Content-Disposition": "inline"/);
        }
    });

    test("the POST rail is CSRF-checked and the file name is validated at the boundary", () => {
        const post = code(read(ORGANIZER_EVIDENCE_POST));
        expect(post).toMatch(/requireSameOrigin\(request\)/);
        expect(post).toMatch(/requireAuth\(\)/);
        expect(post).toMatch(/parseOrThrow\(refundIdParamSchema, refundId\)/);
        expect(post).toMatch(/formData\.get\("file"\)/);
        expect(post).toMatch(/attachRefundEvidence\(parsedId, file, scope, request\)/);
        // The bytes the operator attached must be a real file, not a string field.
        expect(post).not.toMatch(/formData\.get\("evidenceNote"\)|formData\.get\("providerRef"\)/);

        const validation = code(read(VALIDATION));
        const name = validation
            .split("export const refundEvidenceFileNameSchema")[1]
            .split("export const refundListQuerySchema")[0];
        // Only the writer's own shape: separators and `..` cannot match.
        expect(name).toMatch(/\\d\{10,20\}-\[0-9a-f\]\{32\}/);
        expect(name).not.toMatch(/startsWith|endsWith|includes/);
    });
});
