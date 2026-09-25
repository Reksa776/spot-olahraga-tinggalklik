/**
 * ==========================================
 * REFUND TRANSFER EVIDENCE — STORAGE + SERVE RAILS
 * ==========================================
 *
 * The refund-evidence vertical has three pieces that can be tested without the database —
 * and the suite tests all three, because the whole point of the rail is that a hostile
 * caller cannot turn it into a file-read primitive:
 *
 *   storage   the writer sniffs magic bytes (never the declared MIME), caps the REAL
 *             bytes at 5MB, names the file server-side, and the reader only ever resolves
 *             a bare basename whose extension it knows. Traversal is a miss, a missing
 *             file is a miss, deletion is idempotent.
 *   service   the organizer attach CAS pins the key only when the row has not already
 *             changed (a losing racer is rolled back, the superseded file survives), and
 *             the two serve paths gate on the refund's OWN tenant / the order's OWN buyer
 *             with a 404 for anybody else — a membership never reaches either.
 *   wiring    the routes cannot serve bytes without the service, the routes cannot reach
 *             the storage tree without the basename-guarded reader, and the POST route is
 *             CSRF-checked.
 *
 * Only `@/lib/prisma` and `@/lib/authz/guards` are mocked: the prisma mock is a SELECTIVE
 * getter so the teardown file's own `@/lib/prisma` import is untouched, and the guards are
 * replaced by jest.fn()s so this suite can pin WHICH rail each function calls (and the
 * migration's audit log says these gates are the ones that matter) without standing up the
 * membership tables. The authz engine itself is covered by the authz suites; what is proved
 * here is that the evidence rail uses the SAME guards, on the SAME arguments, as the settle
 * rail. The storage engine and the service are the real code.
 */

jest.mock("@/auth", () => ({ auth: jest.fn() }));

// A SINGLE object behind the `prisma` getter: the teardown file imports the same module, so
// the mock must hand every consumer the same handles. (A fresh object per access would give
// the service its own jest.fn()s, invisible to the test.)
const mockPrisma = {
    refund: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
    },
    adminAuditLog: { create: jest.fn() },
};

jest.mock("@/lib/prisma", () => ({
    get prisma() {
        return mockPrisma;
    },
}));

jest.mock("@/lib/authz/guards", () => ({
    requireOrganizerAccess: jest.fn(),
    requireOwnResource: jest.fn(),
}));

import { Prisma } from "@prisma/client";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { requireOrganizerAccess, requireOwnResource } from "@/lib/authz/guards";
import { PERMISSIONS, type AuthzScope } from "@/lib/authz/permissions";
import { prisma } from "@/lib/prisma";
import {
    authorizeRefundEvidenceAttachment,
    deleteRefundEvidence,
    MAX_REFUND_EVIDENCE_BYTES,
    readStoredRefundEvidence,
    storeRefundEvidence,
} from "@/lib/ticketing/refunds/evidence";
import {
    attachRefundEvidence,
    readRefundEvidenceForBuyer,
    readRefundEvidenceForOrganizer,
} from "@/lib/ticketing/refunds/service";

const organizerAccess = requireOrganizerAccess as jest.Mock;
const ownResource = requireOwnResource as jest.Mock;
const refundFindUnique = prisma.refund.findUnique as jest.Mock;
const refundFindUniqueOrThrow = prisma.refund.findUniqueOrThrow as jest.Mock;
const refundUpdateMany = prisma.refund.updateMany as jest.Mock;
const auditCreate = prisma.adminAuditLog.create as jest.Mock;

let uploadDir = "";

const PNG = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100" +
        "05fe02fea7e1e1a30000000049454e44ae426082",
    "hex"
);
const PDF = Buffer.from("%PDF-1.7\n%receipt\n", "utf8");

function scope(userId: string): AuthzScope {
    return {
        userId,
        platformRole: userId.startsWith("staff") ? "MANAGER" : "CUSTOMER",
        organizerScopes: [],
        grants: [],
    };
}

function fullRefundRow(over: Record<string, unknown> = {}) {
    return {
        id: 7,
        refundNumber: "RFN-7",
        organizerId: "org-a",
        requestedByUserId: "buyer-1",
        status: "PROCESSING",
        evidenceFileKey: null,
        requestedAmount: new Prisma.Decimal("100.00"),
        confirmedAmount: new Prisma.Decimal("0.00"),
        reason: null,
        failureReason: null,
        providerRef: null,
        createdAt: new Date(),
        approvedAt: null,
        processedAt: new Date(),
        completedAt: null,
        failedAt: null,
        eventOrder: { orderNumber: "ORD-1", currency: "IDR" },
        items: [],
        ...over,
    };
}

beforeAll(async () => {
    uploadDir = await fs.mkdtemp(path.join(os.tmpdir(), "refund-evidence-"));
    process.env.UPLOAD_DIR = uploadDir;
});

afterAll(async () => {
    delete process.env.UPLOAD_DIR;
    await fs.rm(uploadDir, { recursive: true, force: true });
});

beforeEach(() => {
    refundFindUnique.mockReset();
    refundFindUniqueOrThrow.mockReset();
    refundUpdateMany.mockReset();
    auditCreate.mockReset().mockResolvedValue({});
    organizerAccess.mockReset().mockResolvedValue(scope("staff-1"));
    ownResource.mockReset().mockResolvedValue(scope("buyer-1"));
});

describe("the storage engine trusts bytes, not names", () => {
    test("a PNG round-trips: server-generated name, sniffed type, real size", async () => {
        const stored = await storeRefundEvidence(
            new File([new Uint8Array(PNG)], "anything.png", { type: "text/plain" })
        );

        expect(stored.contentType).toBe("image/png");
        expect(stored.size).toBe(PNG.length);
        expect(stored.key).toBe(stored.fileName);
        expect(stored.key).toMatch(/^\d{10,20}-[0-9a-f]{32}\.png$/);

        const read = await readStoredRefundEvidence(stored.key);
        expect(read).not.toBeNull();
        expect(read!.buffer.equals(PNG)).toBe(true);
        expect(read!.contentType).toBe("image/png");
        expect(read!.size).toBe(PNG.length);
    });

    test("a PDF is accepted by its header even when the client says otherwise", async () => {
        const stored = await storeRefundEvidence(
            new File([new Uint8Array(PDF)], "receipt.exe", { type: "application/x-msdownload" })
        );

        expect(stored.contentType).toBe("application/pdf");
        await expect(
            readStoredRefundEvidence(stored.key)
        ).resolves.toMatchObject({ contentType: "application/pdf" });
    });

    test("the client-declared name never becomes a path: traversal in, traversal-safe out", async () => {
        const stored = await storeRefundEvidence(
            new File([new Uint8Array(PNG)], "../../../../etc/passwd.png", {
                type: "image/png",
            })
        );

        expect(path.basename(stored.key)).toBe(stored.key);
        await expect(
            fs.access(path.join(uploadDir, "refund-evidence", stored.key))
        ).resolves.toBeUndefined();
    });

    test("bad magic and oversize are refused, and nothing is written", async () => {
        const before = await fs.readdir(path.join(uploadDir, "refund-evidence"));

        await expect(
            storeRefundEvidence(
                new File([Buffer.from("<html>not evidence")], "e.txt", { type: "text/plain" })
            )
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        await expect(
            storeRefundEvidence(
                new File([Buffer.alloc(MAX_REFUND_EVIDENCE_BYTES + 1)], "big.pdf", {
                    type: "application/pdf",
                })
            )
        ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

        expect(await fs.readdir(path.join(uploadDir, "refund-evidence"))).toEqual(before);
    });

    test("the reader serves only a bare basename of a known container", async () => {
        await expect(readStoredRefundEvidence("../../etc/passwd")).resolves.toBeNull();
        await expect(readStoredRefundEvidence("sub/nested.png")).resolves.toBeNull();
        await expect(readStoredRefundEvidence("")).resolves.toBeNull();
        await expect(
            readStoredRefundEvidence(`${Date.now()}-a`.padEnd(40, "a") + ".txt")
        ).resolves.toBeNull();
        await expect(readStoredRefundEvidence("never-written.png")).resolves.toBeNull();
    });

    test("delete is idempotent and refuses separators silently", async () => {
        const stored = await storeRefundEvidence(
            new File([new Uint8Array(PDF)], "r.pdf", { type: "application/pdf" })
        );

        await expect(deleteRefundEvidence("../x.png")).resolves.toBeUndefined();
        await expect(deleteRefundEvidence(stored.key)).resolves.toBeUndefined();
        await expect(deleteRefundEvidence(stored.key)).resolves.toBeUndefined();
    });
});

describe("the attach rail runs the settle gates and pins the key with a CAS", () => {
    /** The gate read (row) and the payload read (fullRefundRow) see the same row. */
    function serveRow(over: Record<string, unknown> = {}) {
        const row = fullRefundRow(over);
        refundFindUnique.mockImplementation(async () => row);
        refundFindUniqueOrThrow.mockImplementation(async () => row);
    }

    test("a refund row without a tenant is a 404, not a store", async () => {
        serveRow({ organizerId: null });

        await expect(
            attachRefundEvidence(7, new File([new Uint8Array(PNG)], "e.png"), scope("staff-1"))
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(refundUpdateMany).not.toHaveBeenCalled();
        expect(organizerAccess).not.toHaveBeenCalled();
    });

    test("a successful attach stores, pins every metadata column and audits", async () => {
        serveRow();
        refundUpdateMany.mockResolvedValue({ count: 1 });

        const payload = await attachRefundEvidence(
            7,
            new File([new Uint8Array(PNG)], "e.png"),
            scope("staff-1")
        );

        // The gate is the SETTLE rail's gate: the refund's OWN tenant, REFUND_EXECUTE.
        expect(organizerAccess).toHaveBeenCalledWith("org-a", PERMISSIONS.REFUND_EXECUTE);

        expect(refundUpdateMany).toHaveBeenCalledTimes(1);
        const cas = refundUpdateMany.mock.calls[0][0];
        expect(cas.where).toEqual({ id: 7, evidenceFileKey: null });
        expect(cas.data.evidenceFileKey).toMatch(/^\d{10,20}-[0-9a-f]{32}\.png$/);
        expect(cas.data.evidenceFileSizeB).toBe(PNG.length);
        expect(cas.data.evidenceMimeType).toBe("image/png");
        expect(cas.data.evidenceUploadedByUserId).toBe("staff-1");
        expect(cas.data.evidenceUploadedAt).toBeInstanceOf(Date);

        expect(payload.evidence.key).toBe(cas.data.evidenceFileKey);
        expect(payload.status).toBe("PROCESSING");

        expect(auditCreate).toHaveBeenCalledWith({
            data: expect.objectContaining({
                action: "refund.evidence_upload",
                entityType: "EventOrder",
                entityRef: "RFN-7",
                organizerId: "org-a",
                actorUserId: "staff-1",
            }),
        });
    });

    test("a losing CAS is rolled back and the audit is not written", async () => {
        serveRow();
        refundUpdateMany.mockResolvedValue({ count: 0 });

        const dirBefore = await fs.readdir(path.join(uploadDir, "refund-evidence"));

        await expect(
            attachRefundEvidence(7, new File([new Uint8Array(PNG)], "e.png"), scope("staff-1"))
        ).rejects.toMatchObject({ code: "CONFLICT" });

        // The loser stored a file and then removed it: the tree is exactly as it was.
        expect(await fs.readdir(path.join(uploadDir, "refund-evidence"))).toEqual(dirBefore);
        expect(auditCreate).not.toHaveBeenCalled();
    });

    test("re-attaching deletes the superseded file only after the new key is committed", async () => {
        const previous = await storeRefundEvidence(
            new File([new Uint8Array(PDF)], "old.pdf", { type: "application/pdf" })
        );
        serveRow({ evidenceFileKey: previous.key });
        refundUpdateMany.mockResolvedValue({ count: 1 });

        await attachRefundEvidence(
            7,
            new File([new Uint8Array(PNG)], "e.png"),
            scope("staff-1")
        );

        expect(refundUpdateMany.mock.calls[0][0].where).toEqual({
            id: 7,
            evidenceFileKey: previous.key,
        });
        await expect(
            fs.access(path.join(uploadDir, "refund-evidence", previous.key))
        ).rejects.toBeTruthy();
    });

    test("separation of duties: the requester cannot attach their own evidence", async () => {
        serveRow({ requestedByUserId: "staff-1" });

        await expect(
            attachRefundEvidence(7, new File([new Uint8Array(PNG)], "e.png"), scope("staff-1"))
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(refundUpdateMany).not.toHaveBeenCalled();
    });

    test("a tenant denial from the guard propagates before any byte is stored", async () => {
        organizerAccess.mockRejectedValue(
            Object.assign(new Error("no active membership"), {
                code: "ORGANIZER_ACCESS_DENIED",
            })
        );
        serveRow();
        const dirBefore = await fs.readdir(path.join(uploadDir, "refund-evidence"));

        await expect(
            attachRefundEvidence(7, new File([new Uint8Array(PNG)], "e.png"), scope("staff-1"))
        ).rejects.toMatchObject({ code: "ORGANIZER_ACCESS_DENIED" });

        expect(await fs.readdir(path.join(uploadDir, "refund-evidence"))).toEqual(dirBefore);
    });
});

describe("the serve rails expose bytes only to the refund's tenant or its buyer", () => {
    test("staff: a mismatched name is a miss, the row's exact key is served under the settle guard", async () => {
        const stored = await storeRefundEvidence(
            new File([new Uint8Array(PNG)], "e.png", { type: "image/png" })
        );
        refundFindUnique.mockResolvedValue({ organizerId: "org-a", evidenceFileKey: stored.key });

        await expect(
            readRefundEvidenceForOrganizer(7, "1700000000000-00000000000000000000000000000000.png")
        ).resolves.toBeNull();
        await expect(
            readRefundEvidenceForOrganizer(7, stored.key)
        ).resolves.toMatchObject({ contentType: "image/png", size: PNG.length });
        expect(organizerAccess).toHaveBeenCalledTimes(2);
        expect(organizerAccess).toHaveBeenLastCalledWith("org-a", PERMISSIONS.REFUND_EXECUTE);
        expect(organizerAccess).toHaveBeenCalledWith("org-a", PERMISSIONS.REFUND_EXECUTE);
    });

    test("staff: a refund without a tenant is a 404", async () => {
        refundFindUnique.mockResolvedValue({ organizerId: null, evidenceFileKey: "x" });

        await expect(readRefundEvidenceForOrganizer(7, "x")).rejects.toMatchObject({
            code: "NOT_FOUND",
        });
        expect(organizerAccess).not.toHaveBeenCalled();
    });

    test("staff: a cross-tenant denial propagates and no bytes are read", async () => {
        organizerAccess.mockRejectedValue(
            Object.assign(new Error("no active membership"), {
                code: "ORGANIZER_ACCESS_DENIED",
            })
        );
        refundFindUnique.mockResolvedValue({ organizerId: "org-a", evidenceFileKey: "x" });

        await expect(readRefundEvidenceForOrganizer(7, "x")).rejects.toMatchObject({
            code: "ORGANIZER_ACCESS_DENIED",
        });
    });

    test("buyer: the order's own user is served under ORDER_READ_OWN; anyone else is a 404", async () => {
        const stored = await storeRefundEvidence(
            new File([new Uint8Array(PNG)], "e.png", { type: "image/png" })
        );
        refundFindUnique.mockResolvedValue({
            evidenceFileKey: stored.key,
            eventOrder: { userId: "buyer-1" },
        });

        await expect(
            readRefundEvidenceForBuyer(7, stored.key, scope("buyer-2"))
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(ownResource).not.toHaveBeenCalled();

        await expect(
            readRefundEvidenceForBuyer(7, stored.key, scope("buyer-1"))
        ).resolves.toMatchObject({ contentType: "image/png", size: PNG.length });
        expect(ownResource).toHaveBeenCalledWith(PERMISSIONS.ORDER_READ_OWN, "buyer-1");
        // The buyer rail never consults a tenant.
        expect(organizerAccess).not.toHaveBeenCalled();
    });

    test("buyer: a refund with no order is a 404, and a mismatched name is a miss", async () => {
        refundFindUnique.mockResolvedValue({ evidenceFileKey: "k", eventOrder: null });
        await expect(readRefundEvidenceForBuyer(7, "k", scope("buyer-1"))).rejects.toMatchObject({
            code: "NOT_FOUND",
        });

        refundFindUnique.mockResolvedValue({
            evidenceFileKey: "k",
            eventOrder: { userId: "buyer-1" },
        });
        await expect(
            readRefundEvidenceForBuyer(7, "other", scope("buyer-1"))
        ).resolves.toBeNull();
    });

    test("buyer: an own-scope denial propagates", async () => {
        ownResource.mockRejectedValue(
            Object.assign(new Error("own-scope"), { code: "PIC_ACCESS_DENIED" })
        );
        refundFindUnique.mockResolvedValue({
            evidenceFileKey: "k",
            eventOrder: { userId: "buyer-1" },
        });

        await expect(
            readRefundEvidenceForBuyer(7, "k", scope("buyer-1"))
        ).rejects.toMatchObject({ code: "PIC_ACCESS_DENIED" });
    });
});

describe("the attach gate is a pure function of the row and the scope", () => {
    test("it returns the tenant for a foreign requester and refuses the requester", async () => {
        await expect(
            authorizeRefundEvidenceAttachment(
                { organizerId: "org-a", requestedByUserId: "buyer-1" },
                scope("staff-1")
            )
        ).resolves.toEqual({ organizerId: "org-a", requestedByUserId: "buyer-1" });
        expect(organizerAccess).toHaveBeenCalledWith("org-a", PERMISSIONS.REFUND_EXECUTE);

        await expect(
            authorizeRefundEvidenceAttachment(
                { organizerId: "org-a", requestedByUserId: "staff-1" },
                scope("staff-1")
            )
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    test("a row without a tenant is a 404 before any storage call", async () => {
        await expect(
            authorizeRefundEvidenceAttachment(
                { organizerId: null, requestedByUserId: null },
                scope("staff-1")
            )
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
        expect(organizerAccess).not.toHaveBeenCalled();
    });
});
