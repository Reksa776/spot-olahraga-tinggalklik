import fs from "fs";
import path from "path";

/**
 * ==========================================
 * OPERATOR APPROVE & BAYAR — UI CONTRACT
 * ==========================================
 *
 * The operator's PIC-payout review used to be three separate buttons across two states
 * (`Setujui`, then `Upload bukti`, then `Tandai dibayar`). It is now two choices on a
 * `REQUESTED` payout — [Tolak] [Approve & Bayar] — where the second one completes
 * approve → proof → paid from ONE dialog, and one choice on an `APPROVED` one:
 * [Upload Bukti & Bayar].
 *
 * `SettlementActions` is a client component, and this suite has no DOM renderer
 * (no testing-library in the project), so the contract is asserted the way this repo
 * already asserts its other client actions: against the source with comments stripped
 * (see `refund-settlement-dialogs.test.ts`). The BEHAVIOUR behind each control — the three
 * transitions, the authorization, the separation of duties and the money boundary — is
 * covered for real in `__tests__/ticketing-pic/settlement.integration.test.ts`
 * ("operator approve-and-pay — the PIC-request path, end to end").
 *
 * What matters here, and would be a silent regression if it drifted:
 *
 *   * the two controls exist with the agreed labels;
 *   * the combined dialog performs the three transitions IN ORDER, and only reaches the
 *     paid step from the proof step (never straight from approve);
 *   * a terminal state offers no payment action at all;
 *   * the summary is fed from the SERVER payload, whose account number is already masked —
 *     this dialog must never be handed, or render, a raw account number;
 *   * no native browser dialog comes back.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments, so a comment DESCRIBING a pattern is not mistaken for the pattern. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ACTIONS = "components/dashboard/SettlementActions.tsx";
const DETAIL_PAGE = "app/dashboard/settlements/[id]/page.tsx";

describe("operator actions — the REQUESTED review is two choices", () => {
    it("offers exactly [Tolak] and [Approve & Bayar]", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain("Tolak");
        expect(source).toContain("Approve & Bayar");
        expect(source).toContain('status === "REQUESTED"');

        // The old two-step wording is gone: approval and payment are one control now.
        expect(source).not.toContain("Tandai dibayar");
        expect(source).not.toContain("Upload bukti transfer");
    });

    it("rejects a payout through the same required-reason dialog as before", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain("rejectPayout");
        expect(source).toContain("getManualTransferDefinition");
        expect(source).toContain("useManualTransferDialog");
    });

    it("labels the combined dialog and its primary button", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain("Approve Pencairan");
        expect(source).toContain("Upload Bukti & Bayar");
        expect(source).toContain('"Upload & Bayar"');
    });
});

describe("operator actions — an APPROVED payout can still be finished", () => {
    it("shows Upload Bukti & Bayar without re-approving", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain('status === "APPROVED"');
        expect(source).toContain("Upload Bukti & Bayar");

        // The approval step is conditional on the request state, so an already-APPROVED
        // payout never tries to approve itself again.
        expect(source).toContain('const needsApproval = status === "REQUESTED"');
    });

    it("keeps the failure path that releases the claim lines", () => {
        // Gagalkan is not a payment step and it is the ONLY edge that releases an approved
        // payout's claimed fee lines. Removing it would strand those fees forever.
        const source = code(read(ACTIONS));

        expect(source).toContain("Gagalkan");
        expect(source).toContain("settleFail");
    });
});

describe("operator actions — the combined run is ordered and evidence-gated", () => {
    it("performs approve → proof → paid, in that order", () => {
        const source = code(read(ACTIONS));

        const approveAt = source.indexOf('postAction("approve")');
        const proofAt = source.indexOf("postProof(payFile)");
        const paidAt = source.indexOf('postAction("paid"');

        expect(approveAt).toBeGreaterThan(-1);
        expect(proofAt).toBeGreaterThan(-1);
        expect(paidAt).toBeGreaterThan(-1);

        // The order IS the guarantee: paid is only reachable past the proof upload.
        expect(approveAt).toBeLessThan(proofAt);
        expect(proofAt).toBeLessThan(paidAt);

        // …and each step bails out on refusal instead of continuing to the next one.
        expect(source).toContain("if (!approved.ok)");
        expect(source).toContain("if (!uploaded.ok)");
        expect(source).toContain("if (!paid.ok)");
    });

    it("requires the proof file and the transfer reference before it starts", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain('type="file"');
        expect(source).toContain("FormData");
        expect(source).toContain(
            "Bukti transaksi wajib diunggah."
        );
        expect(source).toContain("providerReference");
        // The reference floor the `paid` schema enforces, mirrored in the dialog.
        expect(source).toContain("REFERENCE_MIN = 3");
    });

    it("uses the existing endpoints and never invents a new one", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain(
            "/api/organizer/settlements/${settlementId}/${action}"
        );
        expect(source).toContain(
            "/api/organizer/settlements/${settlementId}/proof"
        );

        // No orchestration endpoint was added: the dialog drives the existing three.
        expect(source).not.toContain("/approve-and-pay");
    });

    it("refreshes the page after a partial run instead of faking success", () => {
        const source = code(read(ACTIONS));

        // The refresh sits in `finally`, so a half-finished run (approved, upload refused)
        // still re-reads the real status.
        expect(source).toContain("startTransition(() => router.refresh())");
        expect(source).toContain("} finally {");
    });
});

describe("operator actions — a terminal payout offers no payment action", () => {
    it("renders no action panel for PAID, REJECTED, FAILED or CANCELLED", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain("Tidak ada tindakan tersisa.");
        expect(source).toContain('status !== "REQUESTED"');

        // There is no PAID branch at all — a paid payout cannot be paid again from here.
        expect(source).not.toContain('status === "PAID"');
        expect(source).not.toContain('status === "REJECTED"');
    });
});

describe("operator actions — the dialog never holds a raw account number", () => {
    it("takes the destination from the server payload, which masks it", () => {
        const page = code(read(DETAIL_PAGE));

        expect(page).toContain("summary={{");
        expect(page).toContain("netAmount: settlement.netAmount");
        expect(page).toContain("bankName: settlement.bankName");
        // `buildSettlementPayload` applies `maskAccountNumber` before this value exists.
        expect(page).toContain(
            "bankAccountNumber: settlement.bankAccountNumber"
        );
    });

    it("says the number is masked and does not present a full one", () => {
        const source = code(read(ACTIONS));

        expect(source).toContain("tersamarkan");
        // It receives ONE already-masked field; it has no accessor for an unmasked one.
        expect(source).not.toContain("maskAccountNumber(");
    });
});

describe("operator actions — no native browser dialogs return", () => {
    it("contains no prompt, confirm or alert", () => {
        const source = code(read(ACTIONS));

        expect(source).not.toMatch(/window\s*\.\s*(prompt|confirm|alert)/);
        expect(source).not.toMatch(/(^|[^.\w])(prompt|confirm)\s*\(/);
        expect(source).toContain("DialogContent");
    });
});
