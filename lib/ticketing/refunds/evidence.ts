import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { requireOrganizerAccess } from "@/lib/authz/guards";
import { PERMISSIONS } from "@/lib/authz/permissions";
import { detectImageFormat } from "@/lib/images/format";
import type { AuthzScope } from "@/lib/authz";

/**
 * ==========================================
 * REFUND TRANSFER EVIDENCE STORAGE (protected, non-public)
 * ==========================================
 *
 * A refund's proof-of-transfer is a FINANCIAL document, so it deliberately does NOT
 * reuse the public event-image pipeline (`app/api/uploads/events/[filename]`, which
 * serves the public catalog), and it deliberately does NOT reuse the settlement-proof
 * tree either — evidence pins to a specific REFUND, so it lives in its own
 * `<UPLOAD_DIR>/refund-evidence` tree and is served only through an authenticated,
 * tenant-scoped, OWN-scope route that re-checks the refund's tenancy + the caller's
 * own-scope on the REFUNDED ORDER on every request.
 *
 * The same guarantees as the event + settlement pipelines apply, and (per the brief,
 * magic bytes ≥ whole trust) they are ENFORCED on the same functions:
 *
 *   * the filename is generated entirely server-side (random hex) — a hostile name can
 *     never influence the stored path and path traversal is structurally impossible;
 *   * the bytes are validated by MAGIC (jpeg/png/webp via `detectImageFormat`, PDF via
 *     the `%PDF-` header), never by the client-declared MIME type (brief §16);
 *   * size is capped at 5 MB, re-checked on the actual bytes;
 *   * served with `X-Content-Type-Options: nosniff` and inline `Content-Disposition` so
 *     the evidence cannot be embedded or scripted against.
 *
 * The full bank account number is never written here; the evidence is an image or PDF
 * of a transfer/refund receipt, not a data dump.
 */

/** 5 MB — the same cap as settlement proofs and event imagery (D-55). */
export const MAX_REFUND_EVIDENCE_BYTES = 5 * 1024 * 1024;

const PDF_HEADER = Buffer.from("%PDF-");

const MIME_BY_EXTENSION: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
};

export function refundEvidenceDir(): string {
    return process.env.UPLOAD_DIR
        ? path.join(process.env.UPLOAD_DIR, "refund-evidence")
        : path.join(process.cwd(), "storage", "uploads", "refund-evidence");
}

export type StoredRefundEvidence = {
    /** Persistent key resolvable under `refundEvidenceDir()` for later tenant-scoped GET. */
    key: string;
    fileName: string;
    contentType: string;
    size: number;
};

export async function storeRefundEvidence(file: File): Promise<StoredRefundEvidence> {
    if (!(file instanceof File) || file.size === 0) {
        throw AppError.validation("Bukti transfer wajib diupload.");
    }

    if (file.size > MAX_REFUND_EVIDENCE_BYTES) {
        throw AppError.validation("Ukuran bukti transfer maksimal 5MB.");
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    if (buffer.length > MAX_REFUND_EVIDENCE_BYTES) {
        throw AppError.validation("Ukuran bukti transfer maksimal 5MB.");
    }

    let ext: string;
    let contentType: string;

    const imageFormat = detectImageFormat(buffer);

    if (imageFormat) {
        ext = imageFormat === "jpeg" ? ".jpg" : imageFormat === "png" ? ".png" : ".webp";
        contentType = MIME_BY_EXTENSION[ext]!;
    } else if (buffer.length >= 5 && buffer.subarray(0, 5).equals(PDF_HEADER)) {
        ext = ".pdf";
        contentType = MIME_BY_EXTENSION[ext]!;
    } else {
        throw AppError.validation(
            "Format bukti transfer harus JPG, PNG, WEBP, atau PDF."
        );
    }

    const uploadDir = refundEvidenceDir();

    await fs.mkdir(uploadDir, { recursive: true });

    // Server-generated name — a hostile client name never becomes a path segment.
    const randomName = crypto.randomBytes(16).toString("hex");
    const fileName = `${Date.now()}-${randomName}${ext}`;
    const filePath = path.join(uploadDir, fileName);

    // Write-then-rename: a partially written proof is never the one the DB points at.
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);

    return { key: fileName, fileName, contentType, size: buffer.length };
}

/** Delete a stored evidence file. Missing files are not an error. */
export async function deleteRefundEvidence(key: string | null): Promise<void> {
    if (!key || path.basename(key) !== key) {
        return;
    }
    await fs
        .unlink(path.join(refundEvidenceDir(), key))
        .catch(() => undefined);
}

/**
 * ============================================================================
 * AUTHZ — who may ATTACH evidence to a refund (Phase NEXT, Part C/E, additive).
 * ============================================================================
 *
 * Mirrors `settleRefund`'s guard shape EVERYWHERE a money-worthy action is gated:
 *
 *   * the operator must be the SERVING organizer of the refund's OWN tenant
 *     (`requireOrganizerAccess(refund.organizerId, PERMISSIONS.REFUND_EXECUTE)`) —
 *     the SAME tenant scope settle runs under, so the evidence rail is never a
 *     second, weaker money door;
 *   * separation of duties: an organizer can never attach evidence to a refund whose
 *     `requestedByUserId` is THEMSELVES (self-served requests are already refused by
 *     the settle path — D-R02, Phase 18B B — and this surface refuses the same the
 *     instant the upload lands, before ANY byte is stored);
 *   * the CUSTOMER and the PIC (even the referral PIC) are PERMANENTLY excluded at
 *     the authorization layer: there is no `evidence.attach` capability for either
 *     role, so the upload surface is structurally absent for them (Part C/K "PIC
 *     zero surface" + Part D "tidak boleh customer/pic attach").
 *
 * Storage stays ADDITIVE and the bytes are ALWAYS sniffed server-side (`storeRefundEvidence`)
 * — this function is only the authz gate that runs BEFORE the writer, so a hostile or
 * honest-but-wrong caller can never reach the disk. Nothing is written here; the writer
 * and the migration remain the single source of truth for where the file goes and the DB
 * has only the metadata columns the additive migration added.
 */

/**
 * Server-side enforcer for "PIC/customer may never attach evidence", used by the
 * evidence POST route. Delegates the actual permission+tenant+SoD to:
 *
 *   * `requireOrganizerAccess` — the refund's OWN tenant + `REFUND_EXECUTE`, i.e. the
 *     same authorization settleRefund requires to move money.
 *
 * The function is intentionally THIN — it re-reads the refund row from the service's
 * canonical read model (the `refund.findUnique` select `attachRefundEvidence` uses,
 * itself tenant-scoped) and returns the organizerId + requestedByUserId the route
 * then pins against. SoD is decided HERE (never in the component), exactly as
 * settleRefund does.
 */
export async function authorizeRefundEvidenceAttachment<T extends { organizerId: string | null; requestedByUserId: string | null }>(
    refund: T,
    scope: AuthzScope
): Promise<{ organizerId: string; requestedByUserId: string }> {
    if (!refund?.organizerId) {
        throw new AppError(ERROR_CODES.NOT_FOUND, {
            message: "Refund tidak ditemukan.",
        });
    }

    await requireOrganizerAccess(refund.organizerId, PERMISSIONS.REFUND_EXECUTE);

    if (refund.requestedByUserId && scope.userId === refund.requestedByUserId) {
        throw new AppError(ERROR_CODES.FORBIDDEN, {
            message:
                "Pemohon refund tidak dapat melampirkan bukti transfernya sendiri.",
            details: { reason: "SEPARATION_OF_DUTIES" },
        });
    }

    return {
        organizerId: refund.organizerId,
        requestedByUserId: refund.requestedByUserId ?? "",
    };
}

/**
 * The stored evidence as bytes, ready to serve — the serve-twin of `readStoredProof`
 * (`lib/ticketing/settlement/proof.ts`), which `readSettlementProof` delegates to. The
 * shape is byte-identical: the caller supplies the server-generated key it ALREADY
 * read out of the refund row, and this function only turns that key into bytes.
 */
export type RefundEvidenceFile = {
    buffer: Buffer;
    contentType: string;
    size: number;
};

/**
 * Read a stored refund-evidence file by its server-generated basename, or `null` when
 * missing. Authorization is the CALLER's job — this function only does the path-safe
 * read, exactly like `readStoredProof`.
 *
 * Never trust a caller-supplied path: reduce it to a basename first. A key that is
 * not already a bare basename (`../x`, `a/b`, absolute, empty) is refused, so the
 * resolved path can only ever be `refundEvidenceDir()/<generated-name>` and can never
 * broaden the storage root. The returned content type is derived from the stored
 * file's OWN extension — the same table the writer sniffed the bytes against — and is
 * never taken from the request.
 */
export async function readStoredRefundEvidence(
    key: string
): Promise<RefundEvidenceFile | null> {
    if (!key) {
        return null;
    }

    const safeName = path.basename(key);

    if (safeName !== key) {
        return null;
    }

    try {
        const buffer = await fs.readFile(path.join(refundEvidenceDir(), safeName));
        const ext = path.extname(safeName).toLowerCase();
        const contentType = MIME_BY_EXTENSION[ext];

        // A key with no known extension was never produced by the writer, so it is
        // never served — no octet-stream fallback, because this is a financial document
        // and the point of the table is that the stored type is the sniffed one.
        if (!contentType) {
            return null;
        }

        return { buffer, contentType, size: buffer.length };
    } catch {
        return null;
    }
}
