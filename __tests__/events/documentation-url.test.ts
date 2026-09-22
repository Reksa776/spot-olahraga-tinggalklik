/**
 * ==========================================
 * FEATURE — POST-EVENT DOCUMENTATION LINK (VALIDATOR UNIT)
 * ==========================================
 *
 * Pure structural rules for the Google Drive documentation URL, no database:
 *   • https only
 *   • host allow-listed to Drive (drive.google.com / docs.google.com / drive.usercontent.google.com)
 *   • `""` / `null` clears the link; `undefined` leaves it untouched
 *
 * The validator is the server-side policy; an integration suite
 * (`documentation-url.integration.test.ts`) proves it is enforced end-to-end through the
 * update path.
 */

import { updateEventSchema, documentationUrl } from "@/lib/events/validation";

const VALID = [
    "https://drive.google.com/file/d/1a2b3c4d/view?usp=sharing",
    "https://drive.google.com/open?id=1a2b3c4d",
    "https://docs.google.com/spreadsheets/d/1a2b3c4d/edit?usp=sharing",
    "https://drive.usercontent.google.com/download?id=1a2b3c4d&export=view",
];

describe("documentationUrl — accepted values", () => {
    it.each(VALID)("accepts %s", (url) => {
        expect(documentationUrl.parse(url)).toBe(url);
    });

    it("trims surrounding whitespace", () => {
        expect(documentationUrl.parse("  https://drive.google.com/file/d/abc  ")).toBe(
            "https://drive.google.com/file/d/abc"
        );
    });
});

describe("documentationUrl — clear vs leave-untouched", () => {
    it("treats an explicit null as a clear", () => {
        expect(documentationUrl.parse(null)).toBeNull();
    });

    it("treats an empty string as a clear", () => {
        expect(documentationUrl.parse("")).toBeNull();
    });

    it("leaves an omitted value untouched", () => {
        expect(documentationUrl.parse(undefined)).toBeUndefined();
    });
});

describe("documentationUrl — refused values", () => {
    it("refuses plaintext http", () => {
        expect(documentationUrl.safeParse("http://drive.google.com/file/d/abc").success).toBe(false);
    });

    it("refuses other hosts", () => {
        for (const url of [
            "https://imgur.com/gallery/x",
            "https://example.com/docs/x",
            "https://files.google.com/x",
            "https://localhost/drive",
            "https://127.0.0.1/x",
        ]) {
            expect({ url, ok: documentationUrl.safeParse(url).success }).toEqual({
                url,
                ok: false,
            });
        }
    });

    it("refuses a host that only LOOKS like Drive (suffix spoofing)", () => {
        expect(documentationUrl.safeParse("https://drive.google.com.evil.example/x").success).toBe(false);
    });

    it("refuses a userinfo trick that moves the real host away from Drive", () => {
        expect(documentationUrl.safeParse("https://drive.google.com@evil.example/x").success).toBe(false);
    });

    it("refuses non-URL schemes", () => {
        for (const url of ["javascript:alert(1)", "data:text/html,hi", "ftp://drive.google.com/x", "file:///etc/passwd"]) {
            expect({ url, ok: documentationUrl.safeParse(url).success }).toEqual({
                url,
                ok: false,
            });
        }
    });

    it("refuses a malformed URL and a non-string", () => {
        expect(documentationUrl.safeParse("not a url at all").success).toBe(false);
        expect(documentationUrl.safeParse(42).success).toBe(false);
    });

    it("refuses an over-long URL", () => {
        expect(
            documentationUrl.safeParse(`https://drive.google.com/${"a".repeat(2100)}`).success
        ).toBe(false);
    });
});

describe("updateEventSchema accepts the documentation link", () => {
    it("parses a Drive URL through the update contract", () => {
        const parsed = updateEventSchema.parse({
            documentationUrl: "https://docs.google.com/document/d/xyz",
        });

        expect(parsed.documentationUrl).toBe("https://docs.google.com/document/d/xyz");
    });

    it("parses a clear on update", () => {
        expect(updateEventSchema.parse({ documentationUrl: null }).documentationUrl).toBeNull();
    });
});