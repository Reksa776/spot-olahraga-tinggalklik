/**
 * ==========================================
 * PHASE 31 — CSV SERIALISATION (PURE)
 * ==========================================
 *
 * Pins the export contract that the PIC/tenant financial exports depend on:
 *   • RFC 4180 quoting (comma, double-quote, CRLF);
 *   • stable column order;
 *   • spreadsheet formula-injection neutralisation for UNTRUSTED TEXT;
 *   • exact DecimalSTRING preservation for MONEY (a leading minus must survive);
 *   • UTF-8 BOM helper and CRLF line endings.
 */

import {
    UTF8_BOM,
    escapeCsvField,
    neutralizeCsvFormula,
    toCsv,
    withUtf8Bom,
    type CsvColumn,
} from "@/lib/csv";

describe("csv field escaping (RFC 4180)", () => {
    test("plain values are emitted verbatim", () => {
        expect(escapeCsvField("EARNED")).toBe("EARNED");
        expect(escapeCsvField("1500.00")).toBe("1500.00");
    });

    test("commas, quotes, CR and LF force quoting with doubled quotes", () => {
        expect(escapeCsvField("a,b")).toBe('"a,b"');
        expect(escapeCsvField('he said "hi"')).toBe('"he said ""hi"""');
        expect(escapeCsvField("line1\nline2")).toBe('"line1\nline2"');
        expect(escapeCsvField("line1\r\nline2")).toBe('"line1\r\nline2"');
    });
});

describe("csv formula-injection neutralisation", () => {
    test("dangerous prefixes on TEXT are neutralised with a leading apostrophe", () => {
        for (const dangerous of ["=1+1", "+1", "-1", "@SUM(A1)", "\t=cmd", "\r=cmd"]) {
            expect(neutralizeCsvFormula(dangerous)).toBe(`'${dangerous}`);
        }
    });

    test("safe text is untouched", () => {
        expect(neutralizeCsvFormula("Event Reguler")).toBe("Event Reguler");
    });

    test("a text cell with a formula prefix is neutralised AND then quoted if needed", () => {
        const columns: CsvColumn[] = [
            { key: "name", header: "name", kind: "text" },
        ];
        // Contains a comma, so it is both neutralised and quoted.
        const csv = toCsv(columns, [{ name: "=cmd,calc" }]);
        expect(csv).toBe(`name\r\n"'=cmd,calc"\r\n`);
    });
});

describe("money is NEVER mangled", () => {
    test("a negative Decimal value cell survives verbatim (no apostrophe, no Number round-trip)", () => {
        const columns: CsvColumn[] = [
            { key: "amount", header: "amount" }, // default kind = value
        ];
        const csv = toCsv(columns, [{ amount: "-40.00" }, { amount: "1500.00" }]);
        expect(csv).toBe("amount\r\n-40.00\r\n1500.00\r\n");
    });

    test("a value cell beginning with = or + is preserved (only text is neutralised)", () => {
        const columns: CsvColumn[] = [{ key: "v", header: "v" }];
        expect(toCsv(columns, [{ v: "+123" }])).toBe("v\r\n+123\r\n");
    });
});

describe("toCsv document shape", () => {
    test("uses CRLF records and a trailing newline, with the declared column order", () => {
        const columns: CsvColumn[] = [
            { key: "b", header: "B" },
            { key: "a", header: "A" },
        ];
        const csv = toCsv(columns, [
            { a: "1", b: "2" },
            { a: "3", b: "4" },
        ]);
        expect(csv).toBe("B,A\r\n2,1\r\n4,3\r\n");
    });

    test("null and undefined cells become empty fields", () => {
        const columns: CsvColumn[] = [
            { key: "a", header: "A" },
            { key: "b", header: "B" },
        ];
        expect(toCsv(columns, [{ a: null, b: undefined }])).toBe("A,B\r\n,\r\n");
    });

    test("header-only document for zero rows", () => {
        expect(toCsv([{ key: "a", header: "A" }], [])).toBe("A\r\n");
    });
});

describe("withUtf8Bom", () => {
    test("prefixes the byte-order mark", () => {
        expect(withUtf8Bom("A\r\n")).toBe(`${UTF8_BOM}A\r\n`);
        expect(UTF8_BOM).toBe("\uFEFF");
    });
});
