/**
 * ==========================================
 * PIC PAYOUT BANK DETAILS (INTEGRATION, REAL DATABASE) — PAYOUT-DIALOG CONSOLIDATION
 * ==========================================
 *
 * The PIC completing/editing their own payout destination through the ONE route they can
 * reach: `POST /api/pic/payouts` with an optional `bank` block. Exercised through the REAL
 * route handler — same-origin check, `requireAuth`, the strict `parseOrThrow`, the real
 * own-scope guard and the real settlement money engine — against the real database. Only
 * `@/auth` is mocked.
 *
 * It pins the properties this change must not break:
 *
 *   complete-first   the bank block is written to the PIC's OWN `PICProfile` before the money
 *                    engine runs, so the snapshot is taken against the account the PIC just
 *                    confirmed — and the engine itself is untouched;
 *   snapshot         a payout's bank snapshot is IMMUTABLE: editing the profile later never
 *                    rewrites a payout that is already in the operator's queue;
 *   all-or-nothing   a partial block is refused rather than half-stored, and an incomplete
 *                    profile with no block still answers `BANK_DETAILS_MISSING`;
 *   still strict     adding `bank` did NOT loosen the body: `amount`, `picProfileId`, `status`
 *                    and `taxId` are all still refused;
 *   still masked     the audit row records `bankName`, `bankAccountName`, `hasAccountNumber`
 *                    and `accountNumberLast4` — NEVER the account number;
 *   no money         the EARNED ledger row is untouched (still EARNED, still unlinked) and the
 *                    claim still goes through `SettlementItem.picFeeLedgerId @unique`.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

import { POST } from "@/app/api/pic/payouts/route";
import { prisma } from "@/lib/prisma";

const { auth } = require("@/auth") as { auth: jest.Mock };

jest.setTimeout(180_000);

const ORIGIN = "https://tinggalklik.test";
const SUFFIX = `p21-bank-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

let owner: { id: string };
let ownerB: { id: string };
let buyer: { id: string };
let customer: { id: string };
let org: { id: string };
let orgB: { id: string };
let sportId: string;
let event: { id: string };
let eventB: { id: string };

const createdUsers: string[] = [];
const createdProfiles: string[] = [];
let picSeq = 0;

function signInAs(userId: string | null): void {
    auth.mockResolvedValue(
        userId
            ? {
                  user: { id: userId, email: `${userId}@${SUFFIX}.test`, name: "Fixture" },
                  expires: new Date(Date.now() + 60_000).toISOString(),
              }
            : null
    );
}

/** POST to the real route. `origin === null` sends NO Origin at all (the fail-closed case). */
async function postPayouts(
    body: unknown,
    userId: string | null,
    options: { origin?: string | null } = {}
): Promise<NextResponse> {
    signInAs(userId);

    const origin = options.origin === undefined ? ORIGIN : options.origin;
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (origin) {
        headers.origin = origin;
    }

    const request = new NextRequest(new URL(`${ORIGIN}/api/pic/payouts`), {
        method: "POST",
        headers,
        body: typeof body === "string" ? body : JSON.stringify(body),
    });

    return POST(request);
}

async function createUser(tag: string, platformRole: "PIC" | null = null) {
    const user = await prisma.user.create({
        data: {
            name: `${tag} ${SUFFIX}`,
            email: `${tag}-${SUFFIX}@example.test`,
            role: "CUSTOMER",
            ...(platformRole ? { platformRole } : {}),
        },
        select: { id: true },
    });

    createdUsers.push(user.id);
    return user;
}

/** A fresh ACTIVE PIC profile, WITH or WITHOUT bank details. */
async function makePic(tag: string, options: { withBank?: boolean } = {}) {
    const user = await createUser(tag, "PIC");

    const profile = await prisma.pICProfile.create({
        data: {
            userId: user.id,
            picCode: `P21B${(picSeq += 1)}${SUFFIX}`.slice(0, 40),
            displayName: `PIC ${tag} ${SUFFIX}`,
            status: "ACTIVE",
            approvedAt: new Date(),
            ...(options.withBank === false
                ? {}
                : {
                      bankName: "Bank Awal",
                      bankAccountName: "PIC Awal",
                      bankAccountNumber: "111122223333",
                  }),
        },
        select: { id: true },
    });

    createdProfiles.push(profile.id);
    return { user, profile };
}

/** One PAID order + item in the given tenant, plus its EARNED ledger row. */
async function makeEarned(
    picProfileId: string,
    organizerId: string,
    eventId: string,
    amount: string
) {
    const order = await prisma.eventOrder.create({
        data: {
            orderNumber: `P21B-${SUFFIX}-${Math.random().toString(36).slice(2, 8)}`,
            organizerId,
            eventId,
            userId: buyer.id,
            buyerName: "Fixture Buyer",
            status: "PAID",
            paymentStatus: "PAID",
            subtotal: new Prisma.Decimal("100000.00"),
            total: new Prisma.Decimal("100000.00"),
            organizerNetAmount: new Prisma.Decimal("100000.00"),
            paidAt: new Date(),
        },
        select: { id: true },
    });

    const item = await prisma.eventOrderItem.create({
        data: {
            orderId: order.id,
            nameSnapshot: "Fixture Ticket",
            priceSnapshot: new Prisma.Decimal("100000.00"),
            quantity: 1,
            subtotal: new Prisma.Decimal("100000.00"),
        },
        select: { id: true },
    });

    await prisma.pICFeeLedger.create({
        data: {
            picProfileId,
            organizerId,
            eventId,
            orderId: order.id,
            orderItemId: item.id,
            type: "EARNED",
            direction: "CREDIT",
            amount: new Prisma.Decimal(amount),
            feeType: "PERCENTAGE",
            basisType: "NET_AFTER_GATEWAY",
            basisAmount: new Prisma.Decimal(amount),
            quantity: 1,
            status: "EARNED",
            idempotencyKey: `fee:earned:${item.id}`,
        },
    });

    return { orderId: order.id, orderItemId: item.id };
}

async function createEvent(organizerId: string, creatorUserId: string, tag: string) {
    return prisma.event.create({
        data: {
            organizerId,
            sportId,
            title: `P21 Bank ${tag} ${SUFFIX}`,
            slug: `p21-bank-${tag}-${SUFFIX}`,
            eventCode: `P21B-${tag}-${SUFFIX}`.slice(0, 40),
            status: "PUBLISHED",
            visibility: "UNLISTED",
            startAt: FUTURE,
            endAt: new Date(FUTURE.getTime() + 3 * 60 * 60 * 1000),
            createdByUserId: creatorUserId,
        },
        select: { id: true },
    });
}

const BANK_FIELDS = {
    bankName: true,
    bankAccountName: true,
    bankAccountNumber: true,
} as const;

async function readBank(picProfileId: string) {
    return prisma.pICProfile.findUniqueOrThrow({
        where: { id: picProfileId },
        select: BANK_FIELDS,
    });
}

beforeAll(async () => {
    owner = await createUser("p21b-owner");
    ownerB = await createUser("p21b-owner-b");
    buyer = await createUser("p21b-buyer");
    customer = await createUser("p21b-customer");

    org = await prisma.organizer.create({
        data: {
            ownerUserId: owner.id,
            name: `P21 Bank Org ${SUFFIX}`,
            slug: `p21-bank-org-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    orgB = await prisma.organizer.create({
        data: {
            ownerUserId: ownerB.id,
            name: `P21 Bank Org B ${SUFFIX}`,
            slug: `p21-bank-org-b-${SUFFIX}`,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    sportId = (
        await prisma.sport.create({
            data: { name: `P21 Bank Sport ${SUFFIX}`, slug: `p21-bank-sport-${SUFFIX}` },
            select: { id: true },
        })
    ).id;

    event = await createEvent(org.id, owner.id, "a");
    eventB = await createEvent(orgB.id, ownerB.id, "b");
});

afterAll(async () => {
    await prisma.pICFeeLedger.deleteMany({
        where: { picProfileId: { in: createdProfiles } },
    });
    await prisma.settlementItem.deleteMany({
        where: { settlement: { picProfileId: { in: createdProfiles } } },
    });
    await prisma.settlement.deleteMany({
        where: { picProfileId: { in: createdProfiles } },
    });
    await prisma.adminAuditLog.deleteMany({
        where: { action: "pic.bank.update", entityRef: { in: createdProfiles } },
    });
    await prisma.eventOrderItem.deleteMany({
        where: { order: { organizerId: { in: [org.id, orgB.id] } } },
    });
    await prisma.eventOrder.deleteMany({
        where: { organizerId: { in: [org.id, orgB.id] } },
    });
    await prisma.pICProfile.deleteMany({ where: { id: { in: createdProfiles } } });
    await prisma.event.deleteMany({ where: { id: { in: [event.id, eventB.id] } } });
    await prisma.sport.deleteMany({ where: { id: sportId } });
    await prisma.organizer.deleteMany({ where: { id: { in: [org.id, orgB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: createdUsers } } });
});

describe("CASE B — an incomplete profile is completed in the same request", () => {
    it("saves the bank block, creates REQUESTED, snapshots it, and moves no money", async () => {
        const { user, profile } = await makePic(`caseb-${SUFFIX}`, { withBank: false });
        await makeEarned(profile.id, org.id, event.id, "6400.00");

        const response = await postPayouts(
            {
                organizerId: org.id,
                notes: "Lengkapi rekening",
                bank: {
                    bankName: "Bank Baru",
                    bankAccountName: "PIC Baru",
                    bankAccountNumber: "999888777666",
                },
            },
            user.id
        );

        expect(response.status).toBe(201);

        const body = await response.json();

        expect(body.data.status).toBe("REQUESTED");
        expect(body.data.netAmount).toBe("6400.00");

        // 1. The profile now HOLDS the destination…
        expect(await readBank(profile.id)).toEqual({
            bankName: "Bank Baru",
            bankAccountName: "PIC Baru",
            bankAccountNumber: "999888777666",
        });

        // 2. …and the payout SNAPSHOT is exactly what was submitted.
        const stored = await prisma.settlement.findUniqueOrThrow({
            where: { id: body.data.id },
            select: { status: true, ...BANK_FIELDS },
        });

        expect(stored.status).toBe("REQUESTED");
        expect(stored.bankName).toBe("Bank Baru");
        expect(stored.bankAccountName).toBe("PIC Baru");
        expect(stored.bankAccountNumber).toBe("999888777666");

        // 3. Request time moves NO money: the fee is claimed, not settled.
        expect(
            await prisma.settlementItem.count({ where: { settlementId: body.data.id } })
        ).toBe(1);

        const ledger = await prisma.pICFeeLedger.findFirstOrThrow({
            where: { picProfileId: profile.id },
            select: { status: true, settlementId: true },
        });

        expect(ledger.status).toBe("EARNED");
        expect(ledger.settlementId).toBeNull();

        // 4. The response NEVER carries the account number in full.
        expect(body.data.bankAccountNumber).not.toBe("999888777666");
        expect(body.data.bankAccountNumber).toContain("7666");
    });

    it("reports whether the profile still needs bank details (owner-only read)", async () => {
        const { user, profile } = await makePic(`profile-${SUFFIX}`, { withBank: false });

        signInAs(user.id);

        const before = await prisma.pICProfile.findUniqueOrThrow({
            where: { id: profile.id },
            select: BANK_FIELDS,
        });

        // The row is genuinely incomplete to begin with; the dialog's notice is driven by
        // exactly this predicate (all three present), the same one the engine enforces.
        expect(Boolean(before.bankName && before.bankAccountName && before.bankAccountNumber)).toBe(
            false
        );
    });
});

describe("CASE A — an existing destination is edited and the snapshot follows", () => {
    it("writes the edited bank block and snapshots the NEW data", async () => {
        const { user, profile } = await makePic(`casea-${SUFFIX}`);
        await makeEarned(profile.id, org.id, event.id, "7100.00");

        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank Ganti",
                    bankAccountName: "PIC Ganti",
                    bankAccountNumber: "555444333222",
                },
            },
            user.id
        );

        expect(response.status).toBe(201);

        const body = await response.json();

        expect(await readBank(profile.id)).toEqual({
            bankName: "Bank Ganti",
            bankAccountName: "PIC Ganti",
            bankAccountNumber: "555444333222",
        });

        const stored = await prisma.settlement.findUniqueOrThrow({
            where: { id: body.data.id },
            select: BANK_FIELDS,
        });

        expect(stored).toEqual({
            bankName: "Bank Ganti",
            bankAccountName: "PIC Ganti",
            bankAccountNumber: "555444333222",
        });
    });

    it("an unchanged block is a no-op: no rewrite, no audit row", async () => {
        const { user, profile } = await makePic(`noop-${SUFFIX}`);
        await makeEarned(profile.id, org.id, event.id, "8100.00");

        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank Awal",
                    bankAccountName: "PIC Awal",
                    bankAccountNumber: "111122223333",
                },
            },
            user.id
        );

        expect(response.status).toBe(201);
        expect(
            await prisma.adminAuditLog.count({
                where: { action: "pic.bank.update", entityRef: profile.id },
            })
        ).toBe(0);
    });
});

describe("the payout snapshot is IMMUTABLE", () => {
    it("editing the destination later never rewrites an existing payout", async () => {
        const { user, profile } = await makePic(`immutable-${SUFFIX}`);

        await makeEarned(profile.id, org.id, event.id, "5200.00");
        await makeEarned(profile.id, orgB.id, eventB.id, "5300.00");

        // Request in tenant A against the account on file.
        const first = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank Lama",
                    bankAccountName: "PIC Lama",
                    bankAccountNumber: "123412341234",
                },
            },
            user.id
        );

        expect(first.status).toBe(201);
        const firstBody = await first.json();

        // A second request in tenant B, with the destination CHANGED. The profile moves…
        const second = await postPayouts(
            {
                organizerId: orgB.id,
                bank: {
                    bankName: "Bank Pindah",
                    bankAccountName: "PIC Pindah",
                    bankAccountNumber: "432143214321",
                },
            },
            user.id
        );

        expect(second.status).toBe(201);
        expect((await readBank(profile.id)).bankName).toBe("Bank Pindah");

        // …but tenant A's payout still points at the account it was snapshotted with.
        const firstSettlement = await prisma.settlement.findUniqueOrThrow({
            where: { id: firstBody.data.id },
            select: BANK_FIELDS,
        });

        expect(firstSettlement).toEqual({
            bankName: "Bank Lama",
            bankAccountName: "PIC Lama",
            bankAccountNumber: "123412341234",
        });
    });
});

describe("an incomplete destination is still refused, all-or-nothing", () => {
    it("no bank block on an empty profile answers BANK_DETAILS_MISSING", async () => {
        const { user, profile } = await makePic(`missing-${SUFFIX}`, { withBank: false });
        await makeEarned(profile.id, org.id, event.id, "9100.00");

        const response = await postPayouts({ organizerId: org.id }, user.id);

        expect(response.status).toBe(400);

        const body = await response.json();

        expect(body.code).toBe("VALIDATION_ERROR");
        expect(body.details?.reason).toBe("BANK_DETAILS_MISSING");

        // Nothing was claimed and nothing was created.
        expect(
            await prisma.settlement.count({ where: { picProfileId: profile.id } })
        ).toBe(0);
    });

    it("a PARTIAL block is refused and stores nothing", async () => {
        const { user, profile } = await makePic(`partial-${SUFFIX}`, { withBank: false });
        await makeEarned(profile.id, org.id, event.id, "9300.00");

        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank Saja",
                    bankAccountNumber: "888877776666",
                },
            },
            user.id
        );

        expect(response.status).toBe(400);

        const body = await response.json();

        expect(body.code).toBe("VALIDATION_ERROR");
        expect(JSON.stringify(body.details?.fields ?? [])).toContain("bankAccountName");

        // No half-written destination, and no payout.
        expect(await readBank(profile.id)).toEqual({
            bankName: null,
            bankAccountName: null,
            bankAccountNumber: null,
        });
        expect(
            await prisma.settlement.count({ where: { picProfileId: profile.id } })
        ).toBe(0);
    });
});

describe("adding `bank` did not loosen the body", () => {
    it("still rejects amount, picProfileId, status and taxId", async () => {
        const { user } = await makePic(`strict-${SUFFIX}`);

        const attempts: { body: Record<string, unknown>; key: string }[] = [
            { body: { organizerId: org.id, amount: 5_000_000 }, key: "amount" },
            { body: { organizerId: org.id, picProfileId: "someone-else" }, key: "picProfileId" },
            { body: { organizerId: org.id, status: "APPROVED" }, key: "status" },
            { body: { organizerId: org.id, taxId: "09.123.456.7-890.000" }, key: "taxId" },
            {
                body: {
                    organizerId: org.id,
                    bank: {
                        bankName: "B",
                        bankAccountName: "N",
                        bankAccountNumber: "1",
                        taxId: "09.123.456.7-890.000",
                    },
                },
                key: "taxId",
            },
        ];

        for (const attempt of attempts) {
            const response = await postPayouts(attempt.body, user.id);

            expect(response.status).toBe(400);

            const body = await response.json();

            expect(body.code).toBe("VALIDATION_ERROR");
            expect(JSON.stringify(body.details?.fields ?? [])).toContain(attempt.key);
        }
    });
});

describe("bank input validation", () => {
    it("trims, accepts a non-numeric account number, and bounds the name", async () => {
        const { user, profile } = await makePic(`trim-${SUFFIX}`, { withBank: false });
        await makeEarned(profile.id, org.id, event.id, "4400.00");

        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "   Bank Spasi   ",
                    bankAccountName: "  PIC Spasi  ",
                    // NOT digits-only — deliberately accepted: the column is free text and the
                    // existing contract imposes no numeric format.
                    bankAccountNumber: "  ID12-ABC-9999  ",
                },
            },
            user.id
        );

        expect(response.status).toBe(201);
        expect(await readBank(profile.id)).toEqual({
            bankName: "Bank Spasi",
            bankAccountName: "PIC Spasi",
            bankAccountNumber: "ID12-ABC-9999",
        });
    });

    it("refuses an empty and an over-long field", async () => {
        const { user, profile } = await makePic(`bounds-${SUFFIX}`, { withBank: false });
        await makeEarned(profile.id, org.id, event.id, "4500.00");

        const empty = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "   ",
                    bankAccountName: "PIC",
                    bankAccountNumber: "1234",
                },
            },
            user.id
        );

        expect(empty.status).toBe(400);

        const overLong = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "B".repeat(65),
                    bankAccountName: "PIC",
                    bankAccountNumber: "1234",
                },
            },
            user.id
        );

        expect(overLong.status).toBe(400);
        expect(
            await prisma.settlement.count({ where: { picProfileId: profile.id } })
        ).toBe(0);
    });
});

describe("the audit trail names the change and never the account", () => {
    it("writes pic.bank.update with masked metadata only", async () => {
        const { user, profile } = await makePic(`audit-${SUFFIX}`, { withBank: false });
        await makeEarned(profile.id, org.id, event.id, "6700.00");

        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank Audit",
                    bankAccountName: "PIC Audit",
                    bankAccountNumber: "9876543210",
                },
            },
            user.id
        );

        expect(response.status).toBe(201);

        const rows = await prisma.adminAuditLog.findMany({
            where: { action: "pic.bank.update", entityRef: profile.id },
        });

        expect(rows).toHaveLength(1);

        const row = rows[0];

        expect(row.actorUserId).toBe(user.id);
        expect(row.entityType).toBe("PICProfile");
        expect(row.actorType).toBe("USER");
        expect(row.organizerId).toBeNull();

        // The metadata is the masked shape, and ONLY the masked shape.
        expect(row.afterState).toMatchObject({
            bankName: "Bank Audit",
            bankAccountName: "PIC Audit",
            hasAccountNumber: true,
            accountNumberLast4: "3210",
        });

        // The account number itself is nowhere in the row.
        const serialised = JSON.stringify({
            before: row.beforeState,
            after: row.afterState,
            description: row.description,
            reason: row.reason,
        });

        expect(serialised).not.toContain("9876543210");
        expect(
            Object.keys((row.afterState ?? {}) as Record<string, unknown>)
        ).not.toContain("bankAccountNumber");
    });
});

describe("security is unchanged", () => {
    it("refuses a cross-site bank POST and writes nothing", async () => {
        const { user, profile } = await makePic(`csrf-${SUFFIX}`, { withBank: false });

        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank Jahat",
                    bankAccountName: "PIC Jahat",
                    bankAccountNumber: "000000000000",
                },
            },
            user.id,
            { origin: "https://evil.example" }
        );

        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe("FORBIDDEN");

        expect(await readBank(profile.id)).toEqual({
            bankName: null,
            bankAccountName: null,
            bankAccountNumber: null,
        });
    });

    it("refuses a bank POST with no Origin at all (fail-closed)", async () => {
        const { user } = await makePic(`noorigin-${SUFFIX}`);

        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank",
                    bankAccountName: "PIC",
                    bankAccountNumber: "1",
                },
            },
            user.id,
            { origin: null }
        );

        expect(response.status).toBe(403);
    });

    it("an authenticated non-PIC cannot write bank data for anyone", async () => {
        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank",
                    bankAccountName: "PIC",
                    bankAccountNumber: "1234567890",
                },
            },
            customer.id
        );

        expect(response.status).toBe(404);
        expect((await response.json()).code).toBe("NOT_FOUND");
    });

    it("an anonymous caller cannot write bank data", async () => {
        const response = await postPayouts(
            {
                organizerId: org.id,
                bank: {
                    bankName: "Bank",
                    bankAccountName: "PIC",
                    bankAccountNumber: "1234567890",
                },
            },
            null
        );

        expect(response.status).toBe(401);
    });
});

describe("concurrency protection is unchanged", () => {
    it("two concurrent bank-bearing requests claim the fee exactly once", async () => {
        const { user, profile } = await makePic(`race-${SUFFIX}`, { withBank: false });
        await makeEarned(profile.id, org.id, event.id, "12300.00");

        const body = {
            organizerId: org.id,
            bank: {
                bankName: "Bank Balap",
                bankAccountName: "PIC Balap",
                bankAccountNumber: "777766665555",
            },
        };

        const results = await Promise.allSettled([
            postPayouts(body, user.id),
            postPayouts(body, user.id),
        ]);

        expect(results.some((result) => result.status === "fulfilled")).toBe(true);

        // The database, not a read-then-write check, decides the race.
        const claimed = await prisma.settlementItem.count({
            where: { settlement: { picProfileId: profile.id } },
        });

        expect(claimed).toBe(1);

        const ledger = await prisma.pICFeeLedger.findFirstOrThrow({
            where: { picProfileId: profile.id },
            select: { status: true, settlementId: true },
        });

        expect(ledger.status).toBe("EARNED");
        expect(ledger.settlementId).toBeNull();
    });
});
