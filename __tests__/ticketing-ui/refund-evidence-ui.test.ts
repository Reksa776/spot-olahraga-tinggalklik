import fs from "fs";
import path from "path";

import { refundStaffEvidenceUrl } from "@/lib/ticketing/refunds/payload";

/**
 * ==========================================
 * REFUND TRANSFER-EVIDENCE — STAFF SURFACE (Phase 20B)
 * ==========================================
 *
 * The refund-evidence rail has two halves: the buyer's read-only view (covered by the
 * customer-orders suite) and the OPERATOR's attach/review control. This suite pins the
 * operator half, which is the only writer of the evidence file:
 *
 *   * the dashboard read model selects the storage key it needs to build the staff href —
 *     and nothing else (`evidenceFileName`/`SizeB`/`MimeType` stay out of the page's world);
 *   * the board renders the control, with the href BUILT SERVER-SIDE from the row;
 *   * the control posts multipart to the EXISTING organizer evidence route, reuses the
 *     settlement proof-upload discipline (a hidden file input, an in-flight guard, the
 *     server's message verbatim) and adds no native browser dialog;
 *   * it can never settle: `REFUNDED` remains reachable only through `settleRefund`.
 *
 * Static source assertions are used for the wiring, exactly as the dialog and customer
 * suites do, because the property under test is the SHAPE of the call (which route, which
 * body, which guard) rather than a rendered pixel; the one pure function is exercised
 * directly.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments, so prose that NAMES a banned pattern is not mistaken for it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const PAGE = "app/dashboard/refunds/page.tsx";
const COMPONENT = "components/dashboard/RefundEvidenceActions.tsx";
const READ_MODEL = "lib/dashboard/refunds.ts";
const PAYLOAD = "lib/ticketing/refunds/payload.ts";

const STORED_KEY = "1760000000000-deadbeefdeadbeefdeadbeefdeadbeef.png";

describe("Phase 20B — refund evidence: the staff href is built from the row", () => {
    test("the helper points at the EXISTING organizer route, and encodes the name", () => {
        expect(refundStaffEvidenceUrl(7, STORED_KEY)).toBe(
            `/api/organizer/refunds/7/evidence/${STORED_KEY}`
        );

        // Not a new file route, and not the buyer one.
        const payload = code(read(PAYLOAD));
        expect(payload).toContain(
            "/api/organizer/refunds/${refundId}/evidence/"
        );
        expect(payload).toContain(
            "/api/ticketing/refunds/${refundId}/evidence/"
        );
        expect(payload).toMatch(/encodeURIComponent\(fileName\)/);
    });

    test("the dashboard read model selects the key, and only the key", () => {
        const model = code(read(READ_MODEL));

        expect(model).toMatch(/evidenceFileKey: true/);
        // The other evidence columns are not part of the dashboard's world.
        expect(model).not.toMatch(/evidenceFileName: true/);
        expect(model).not.toMatch(/evidenceFileSizeB: true/);
        expect(model).not.toMatch(/evidenceMimeType: true/);
    });
});

describe("Phase 20B — refund evidence: the board renders the operator control", () => {
    test("the page builds the href server-side and passes it to the control", () => {
        const page = code(read(PAGE));

        expect(page).toContain("RefundEvidenceActions");
        expect(page).toContain("refundStaffEvidenceUrl(");
        expect(page).toContain("refund.evidenceFileKey");
        // The page never assembles an evidence path by hand.
        expect(page).not.toMatch(/\/api\/organizer\/refunds/);
    });

    test("the control is the only writer, and it posts to the organizer route", () => {
        const component = code(read(COMPONENT));

        expect(component).toContain(
            "`/api/organizer/refunds/${refundId}/evidence`"
        );
        expect(component).toContain("new FormData()");
        expect(component).toContain('formData.append("file", file)');
        // The file input accepts only what the storage engine will sniff.
        expect(component).toContain('type="file"');
        expect(component).toContain(
            "image/jpeg,image/png,image/webp,application/pdf"
        );
        // A second click while a request is in flight starts nothing.
        expect(component).toMatch(/if \(busy\) \{\s*return;\s*\}/);
        // A successful upload refreshes the server component; a failure keeps the server
        // message verbatim.
        expect(component).toContain("router.refresh()");
        expect(component).toContain("payload?.message");
    });

    test("it never settles and never uses a native browser dialog", () => {
        const component = code(read(COMPONENT));

        expect(component).not.toMatch(/status:\s*"REFUNDED"|confirmAmount/);
        expect(component).not.toMatch(/settleRefund|processConfirmedRefund/);
        expect(component).not.toMatch(/window\s*\.\s*(prompt|confirm|alert)/);
        expect(component).not.toMatch(/(^|[^.\w])(prompt|confirm)\s*\(/);
    });

    test("attach is offered only while the refund is still open", () => {
        const component = code(read(COMPONENT));

        expect(component).toContain(
            'new Set(["PENDING", "APPROVED", "PROCESSING"])'
        );
        expect(component).toContain("ATTACHABLE.has(status)");
    });
});
