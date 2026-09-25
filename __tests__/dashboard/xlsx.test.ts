/**
 * ==========================================
 * XLSX WRITER (PURE)
 * ==========================================
 *
 * `lib/xlsx.ts` is a hand-written OOXML writer, so it is tested at the byte level rather than
 * "does a file appear": the archive is parsed back in this suite (local file headers → `inflateRaw`)
 * and the XML parts are asserted directly. Everything here is pure — no database, no route.
 *
 * The properties that matter:
 *
 *   a real ZIP   local-header magic, deflated entries, per-entry CRC-32, a central directory and
 *                an EOCD record — the four things every consumer (Excel, LibreOffice, Numbers)
 *                checks before it will open a file at all;
 *   deterministic every entry is stamped with the ZIP epoch, so two exports of the same data are
 *                byte-identical and this suite can assert on the archive itself;
 *   typed cells  text is an `inlineStr` LITERAL (never a formula, which is why the CSV-style `'`
 *                prefix is deliberately absent) while money is a NUMBER with `#,##0.00`, so a
 *                column can be summed;
 *   valid names  tab names are sanitised to Excel's 31-character / character-set rules and made
 *                unique, because a duplicate or over-long name makes the file unopenable.
 */

import { inflateRawSync } from "node:zlib";

import {
    XLSX_CONTENT_TYPE,
    buildXlsx,
    columnName,
    crc32,
    escapeXml,
    sanitizeSheetName,
    type XlsxSheet,
} from "@/lib/xlsx";

/** Parse every entry out of the archive the writer produced. */
function unzip(archive: Uint8Array): Map<string, string> {
    const buffer = Buffer.from(archive);
    const entries = new Map<string, string>();

    for (let offset = 0; offset + 30 <= buffer.length; offset += 1) {
        if (buffer.readUInt32LE(offset) !== 0x04034b50) continue;

        const compressedSize = buffer.readUInt32LE(offset + 18);
        const nameLength = buffer.readUInt16LE(offset + 26);
        const extraLength = buffer.readUInt16LE(offset + 28);
        const name = buffer
            .subarray(offset + 30, offset + 30 + nameLength)
            .toString("utf8");
        const start = offset + 30 + nameLength + extraLength;

        entries.set(
            name,
            inflateRawSync(buffer.subarray(start, start + compressedSize)).toString("utf8")
        );

        offset = start + compressedSize - 1;
    }

    return entries;
}

const SHEETS: XlsxSheet[] = [
    {
        name: "Ringkasan",
        // Untyped value column, exactly as the Ringkasan sheet is built: a mixed-unit block where
        // money keeps its decimal string and a count does not get a decimal point.
        columns: [
            { header: "Metrik" },
            { header: "Nilai" },
        ],
        rows: [
            ["Pendapatan", "1250000.00"],
            ["Jumlah pesanan", 12],
        ],
    },
    {
        name: "Pesanan",
        columns: [
            { header: "orderNumber" },
            { header: "pembeli", kind: "text" },
            { header: "total", kind: "money" },
            { header: "catatan", kind: "text" },
        ],
        rows: [
            [`TK-0001`, `=SUM(A1:A2), fixture`, "150000.00", `kutip "ganda" & <tag>`],
            ["TK-0002", "Budi", "0.00", null],
        ],
    },
];

describe("crc32", () => {
    it("matches the canonical IEEE vector", () => {
        // The published check value for "123456789" — the one every ZIP implementation quotes.
        expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    });

    it("is empty-safe and order-sensitive", () => {
        expect(crc32(new Uint8Array(0))).toBe(0);
        expect(crc32(new TextEncoder().encode("ab"))).not.toBe(
            crc32(new TextEncoder().encode("ba"))
        );
    });
});

describe("columnName", () => {
    it("walks the alphabet and rolls over correctly", () => {
        expect(columnName(0)).toBe("A");
        expect(columnName(25)).toBe("Z");
        expect(columnName(26)).toBe("AA");
        expect(columnName(27)).toBe("AB");
        expect(columnName(51)).toBe("AZ");
        expect(columnName(52)).toBe("BA");
        expect(columnName(701)).toBe("ZZ");
        expect(columnName(702)).toBe("AAA");
    });
});

describe("escapeXml", () => {
    it("escapes the five XML entities", () => {
        expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
            "a &amp; b &lt; c &gt; d &quot; e &apos; f"
        );
    });

    it("drops the control characters XML 1.0 cannot represent", () => {
        // Escaping is not an option for these — there is no legal representation — so a user-typed
        // value containing one must not be able to produce a file Excel refuses to open.
        expect(escapeXml("a\u0000\u0007\u001Fb")).toBe("ab");
        // Tab, LF and CR are legal and must survive.
        expect(escapeXml("a\tb\nc")).toBe("a\tb\nc");
    });
});

describe("sheet names", () => {
    it("strips the characters Excel forbids and caps the length", () => {
        expect(sanitizeSheetName("Penjualan [Tiket]: 2026/01*?")).toBe(
            "Penjualan  Tiket   2026 01"
        );
        expect(sanitizeSheetName("x".repeat(60))).toHaveLength(31);
    });

    it("never returns an empty name", () => {
        expect(sanitizeSheetName("[]:")).toBe("Sheet");
        expect(sanitizeSheetName("   ")).toBe("Sheet");
    });

    it("makes duplicate tab names unique, because Excel refuses the file otherwise", () => {
        const archive = unzip(
            buildXlsx([
                { name: "Laporan", columns: [{ header: "a" }], rows: [["1"]] },
                { name: "Laporan", columns: [{ header: "a" }], rows: [["2"]] },
            ])
        );

        const workbook = archive.get("xl/workbook.xml") ?? "";

        expect(workbook).toContain(`name="Laporan"`);
        expect(workbook).toContain(`name="Laporan (2)"`);
    });
});

describe("buildXlsx", () => {
    it("refuses to build an empty workbook", () => {
        expect(() => buildXlsx([])).toThrow(/at least one sheet/);
    });

    it("produces a parseable ZIP with the required OOXML parts", () => {
        const bytes = buildXlsx(SHEETS);

        expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

        // EOCD signature at the end of the archive.
        const end = bytes.length - 22;
        expect(new DataView(bytes.buffer, bytes.byteOffset).getUint32(end, true)).toBe(
            0x06054b50
        );

        const archive = unzip(bytes);

        expect([...archive.keys()].sort()).toEqual([
            "[Content_Types].xml",
            "_rels/.rels",
            "xl/_rels/workbook.xml.rels",
            "xl/styles.xml",
            "xl/workbook.xml",
            "xl/worksheets/sheet1.xml",
            "xl/worksheets/sheet2.xml",
        ]);

        // Content types must declare every part the package contains, or Excel rejects it.
        const contentTypes = archive.get("[Content_Types].xml") ?? "";
        expect(contentTypes).toContain("/xl/workbook.xml");
        expect(contentTypes).toContain("/xl/worksheets/sheet1.xml");
        expect(contentTypes).toContain("/xl/worksheets/sheet2.xml");
        expect(contentTypes).toContain("/xl/styles.xml");

        // The relationship file must point at each sheet and at the styles part.
        const rels = archive.get("xl/_rels/workbook.xml.rels") ?? "";
        expect(rels).toContain("worksheets/sheet1.xml");
        expect(rels).toContain("worksheets/sheet2.xml");
        expect(rels).toContain("styles.xml");
    });

    it("is byte-deterministic for the same input", () => {
        const first = buildXlsx(SHEETS);
        const second = buildXlsx(SHEETS);

        expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
    });

    it("writes text as an inline LITERAL and money as a formatted NUMBER", () => {
        const sheet = unzip(buildXlsx(SHEETS)).get("xl/worksheets/sheet2.xml") ?? "";

        // A value a spreadsheet WOULD execute in CSV stays literal here: inlineStr has no formula
        // semantics, so prefixing it with `'` (the CSV rule) would corrupt the cell.
        expect(sheet).toContain(
            `<t xml:space="preserve">=SUM(A1:A2), fixture</t>`
        );
        expect(sheet).not.toContain(`'=SUM`);

        // Money is numeric and carries the money style index (2 → `#,##0.00`).
        expect(sheet).toContain(`<c r="C2" s="2"><v>150000</v></c>`);
        // ...and a zero amount is still written as a value, not dropped.
        expect(sheet).toContain(`<c r="C3" s="2"><v>0</v></c>`);

        // Untrusted text is XML-escaped.
        expect(sheet).toContain(`&quot;ganda&quot; &amp; &lt;tag&gt;`);

        // A null cell is an empty cell, never the string "null".
        expect(sheet).toContain(`<c r="D3"/>`);
        expect(sheet).not.toContain("null");
    });

    it("formats counts and money with different number formats", () => {
        const styles = unzip(buildXlsx(SHEETS)).get("xl/styles.xml") ?? "";

        expect(styles).toContain(`formatCode="#,##0.00"`);
        expect(styles).toContain(`formatCode="#,##0"`);

        const summary = unzip(buildXlsx(SHEETS)).get("xl/worksheets/sheet1.xml") ?? "";

        // The Ringkasan block is untyped, so a decimal point can never land on a count, and its
        // money keeps the exact decimal string rather than a rounded float.
        expect(summary).toContain(`<t xml:space="preserve">1250000.00</t>`);
        expect(summary).toContain(`<c r="B3" s="0"><v>12</v></c>`);
    });

    it("freezes the header row and declares a width per column", () => {
        const sheet = unzip(buildXlsx(SHEETS)).get("xl/worksheets/sheet1.xml") ?? "";

        expect(sheet).toContain(`state="frozen"`);
        expect(sheet).toContain(`<cols>`);
        expect(sheet).toContain(`customWidth="1"`);
    });

    it("exposes the MIME type the download route advertises", () => {
        expect(XLSX_CONTENT_TYPE).toBe(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        );
    });
});
