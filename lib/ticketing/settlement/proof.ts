import crypto from "crypto";
import fs from "fs/promises";
import path from "path";

import { AppError } from "@/lib/api/errors";
import { detectImageFormat } from "@/lib/images/format";

/**
 * ==========================================
 * SETTLEMENT PROOF STORAGE (protected, non-public)
 * ==========================================
 *
 * A payout's transfer evidence is a FINANCIAL document, so it deliberately does NOT
 * reuse the public event-image pipeline (`app/api/uploads/events/[filename]`, which
 * serves the public catalog). Proof lives in its own
 * `<UPLOAD_DIR>/settlement-proof` tree and is served only through an authenticated,
 * organizer-scoped route that re-checks the settlement's tenant and
 * `SETTLEMENT_PROOF_UPLOAD` permission on every request.
 *
 * The same guarantees as the event pipeline apply, tightened for the stakes:
 *
 *   * the filename is generated entirely server-side (random hex) — a hostile name can
 *     never influence the stored path and path traversal is structurally impossible;
 *   * the bytes are validated by MAGIC (jpeg/png/webp via `detectImageFormat`, PDF via
 *     the `%PDF-` header), never by the client-declared MIME type (brief §16);
 *   * size is capped at 5 MB, re-checked on the actual bytes;
 *   * served with `X-Content-Type-Options: nosniff` and `Content-Disposition` so the
 *     proof cannot be embedded or scripted against.
 *
 * The full account number is never written here; the proof is an image or PDF of a
 * transfer receipt, not a data dump.
 */

/** 5 MB — the same cap as event imagery (D-55). */
export const MAX_SETTLEMENT_PROOF_BYTES = 5 * 1024 * 1024;

const PDF_HEADER = Buffer.from("%PDF-");

export const MIME_BY_EXTENSION: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
};

export function settlementProofDir(): string {
    return process.env.UPLOAD_DIR
        ? path.join(process.env.UPLOAD_DIR, "settlement-proof")
        : path.join(process.cwd(), "storage", "uploads", "settlement-proof");
}

export type StoredProof = {
    fileName: string;
    contentType: string;
    size: number;
};

/**
 * Validate the payload's bytes and store them under a server-generated name.
 *
 * Rejects, rather than repairs: unsupported container, oversize, malformed. A rejection
 * throws and nothing is written.
 */
export async function storeSettlementProof(file: File): Promise<StoredProof> {
    if (!(file instanceof File) || file.size === 0) {
        throw AppError.validation("File bukti transfer wajib diupload.");
    }

    if (file.size > MAX_SETTLEMENT_PROOF_BYTES) {
        throw AppError.validation("Ukuran bukti transfer maksimal 5MB.");
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // The declared size is client-supplied; re-check the actual bytes so a chunked
    // request cannot slip past the limit above.
    if (buffer.length > MAX_SETTLEMENT_PROOF_BYTES) {
        throw AppError.validation("Ukuran bukti transfer maksimal 5MB.");
    }

    let ext: string;
    let contentType: string;

    const imageFormat = detectImageFormat(buffer);

    if (imageFormat) {
        ext = imageFormat === "jpeg" ? ".jpg" : imageFormat === "png" ? ".png" : ".webp";
        contentType = MIME_BY_EXTENSION[ext];
    } else if (buffer.length >= 5 && buffer.subarray(0, 5).equals(PDF_HEADER)) {
        ext = ".pdf";
        contentType = MIME_BY_EXTENSION[ext];
    } else {
        throw AppError.validation(
            "Format bukti transfer harus JPG, PNG, WEBP, atau PDF."
        );
    }

    const uploadDir = settlementProofDir();

    await fs.mkdir(uploadDir, { recursive: true });

    const randomName = crypto.randomBytes(16).toString("hex");
    const fileName = `${Date.now()}-${randomName}${ext}`;

    const filePath = path.join(uploadDir, fileName);

    // Write-then-rename is atomic-ish and avoids a half-written proof ever being
    // served (nothing serves it until the DB row names it anyway).
    const tmpPath = `${filePath}.tmp`;

    await fs.writeFile(tmpPath, buffer);
    await fs.rename(tmpPath, filePath);

    return { fileName, contentType, size: buffer.length };
}

/** Remove a stored proof. Missing files are not an error. */
export async function deleteStoredProof(fileName: string | null): Promise<void> {
    if (!fileName) {
        return;
    }

    // Never trust a caller-supplied path: reduce to a basename first. The stored names
    // are generated, so anything containing a separator is not ours.
    const safeName = path.basename(fileName);

    if (safeName !== fileName) {
        return;
    }

    try {
        await fs.unlink(path.join(settlementProofDir(), safeName));
    } catch {
        // Already gone — deletion is idempotent.
    }
}

export type ProofFile = {
    buffer: Buffer;
    contentType: string;
};

/**
 * Read a stored proof by its server-generated basename, or `null` when missing.
 * Authorization is the CALLER's job — this function only does the path-safe read.
 */
export async function readStoredProof(
    fileName: string
): Promise<ProofFile | null> {
    if (!fileName) {
        return null;
    }

    const safeName = path.basename(fileName);

    if (safeName !== fileName) {
        return null;
    }

    try {
        const buffer = await fs.readFile(path.join(settlementProofDir(), safeName));
        const ext = path.extname(safeName).toLowerCase();

        return {
            buffer,
            contentType: MIME_BY_EXTENSION[ext] ?? "application/octet-stream",
        };
    } catch {
        return null;
    }
}