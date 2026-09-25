import { deflateRawSync } from "node:zlib";

/**
 * ==========================================
 * XLSX SERIALISATION (pure, dependency-free)
 * ==========================================
 *
 * A minimal OOXML SpreadsheetML writer, beside `lib/csv.ts` and for the same reason: the
 * back-office report has to hand an operator a WORKBOOK (several sheets in one file), and the
 * alternative was a large new dependency in a production app whose build has no supply-chain
 * audit in CI.
 *
 * An `.xlsx` is a ZIP of XML parts. Writing one needs exactly three things, and none of them
 * needs a library:
 *
 *   1. a CRC-32 per entry, plus the classic local-header / central-directory / EOCD layout;
 *   2. `deflateRaw` from `node:zlib` (already present — this is Node, not a browser);
 *   3. the handful of XML parts Excel requires: `[Content_Types].xml`, the package and
 *      workbook relationships, `xl/workbook.xml`, one `xl/worksheets/sheetN.xml` per sheet and
 *      a tiny `xl/styles.xml`.
 *
 * ── WHY THERE IS NO FORMULA NEUTRALISATION HERE (unlike CSV) ────────────────────
 * `lib/csv.ts` prefixes a leading `=`/`+`/`-`/`@` with `'` because a CSV cell has no type and a
 * spreadsheet is entitled to interpret it as a formula. An OOXML cell does have a type: text is
 * written as `<c t="inlineStr"><is><t>…</t></is></c>`, which is a literal by construction —
 * only `<f>` is a formula. So a PIC display name of `=HYPERLINK(…)` is inert here and must NOT
 * be quote-prefixed (the quote would be shown). The CSV path keeps its neutralisation; this one
 * keeps the value verbatim. Both are correct for their own format.
 *
 * ── MONEY ──────────────────────────────────────────────────────────────────────
 * Money columns are written as NUMBERS with a `#,##0.00` number format, taken from the exact
 * `Decimal(14,2)` string the caller passes (`Number("125000.00")`). That is a DISPLAY
 * conversion in the export only — nothing is read back, compared or written with it — and it is
 * what lets an accountant sum a column in Excel instead of retyping it. The CSV export remains
 * the byte-exact decimal string, and it is the one to use when the values must be re-imported.
 *
 * ── DETERMINISM ────────────────────────────────────────────────────────────────
 * Every entry is stamped with the DOS epoch (1980-01-01) rather than "now", so two exports of
 * the same data are byte-identical and a test can assert on the archive itself.
 */

/** The MIME type Excel and browsers expect for an `.xlsx` download. */
export const XLSX_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** How a column (or a single cell) is written and formatted. */
export type XlsxCellKind = "text" | "money" | "integer" | "decimal";

export type XlsxColumn = {
    /** Header text. Developer-controlled, so it is escaped but never reinterpreted. */
    header: string;
    /**
     * `text` writes an inline string; `money` / `integer` / `decimal` write a number with the
     * matching built-in number format. Absent means "infer": a `number` value is numeric, a
     * string is text.
     */
    kind?: XlsxCellKind;
    /** Column width in Excel character units. A sensible default is applied when absent. */
    width?: number;
};

/** A cell value. `null`/`undefined` render as an empty cell, never as `"null"`. */
export type XlsxCell = string | number | null | undefined;

export type XlsxSheet = {
    /** Worksheet tab name. Sanitised and truncated to Excel's 31-character limit. */
    name: string;
    columns: readonly XlsxColumn[];
    rows: readonly (readonly XlsxCell[])[];
};

/* ------------------------------------------------------------------------------------------------
 * STYLE INDICES
 * ------------------------------------------------------------------------------------------------
 * The `cellXfs` order in the generated `xl/styles.xml`. Kept as constants so a caller cannot
 * hand-write an index that happens to mean something else.
 */
const STYLE_DEFAULT = 0;
const STYLE_HEADER = 1;
const STYLE_MONEY = 2;
const STYLE_INTEGER = 3;

const NUM_FMT_MONEY = 164;
const NUM_FMT_INTEGER = 165;

/* ------------------------------------------------------------------------------------------------
 * ZIPPING
 * ------------------------------------------------------------------------------------------------
 * Mirrors PKWARE APPNOTE §4.3.6 (local file header), §4.3.12 (central directory) and §4.3.16
 * (end of central directory). The only non-obvious rules are that sizes/CRC live in BOTH the
 * local header and the central directory, and that the central directory records the offset of
 * each local header.
 */

const CRC_TABLE: Uint32Array = (() => {
    const table = new Uint32Array(256);

    for (let index = 0; index < 256; index += 1) {
        let value = index;

        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }

        table[index] = value >>> 0;
    }

    return table;
})();

/** CRC-32 (IEEE 802.3), as ZIP requires it. */
export function crc32(bytes: Uint8Array): number {
    let crc = 0xffffffff;

    for (let index = 0; index < bytes.length; index += 1) {
        crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

const textEncoder = new TextEncoder();

/** DOS date 1980-01-01 00:00:00 — the ZIP epoch, chosen so output is reproducible. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/** Bit 11: the entry name is UTF-8. All our parts are ASCII, but the flag is honest. */
const FLAG_UTF8 = 0x0800;

/** Deflate. The alternative (0 = stored) would triple a worksheet's size for no benefit. */
const METHOD_DEFLATE = 8;

type ZipEntry = { name: string; data: Uint8Array };

function buildZip(entries: readonly ZipEntry[]): Uint8Array {
    const localChunks: Uint8Array[] = [];
    const centralChunks: Uint8Array[] = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = textEncoder.encode(entry.name);
        const compressed = new Uint8Array(deflateRawSync(entry.data));
        const checksum = crc32(entry.data);
        const localOffset = offset;

        const localHeader = new Uint8Array(30 + nameBytes.length);
        const local = new DataView(localHeader.buffer);
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(4, 20, true); // version needed to extract
        local.setUint16(6, FLAG_UTF8, true);
        local.setUint16(8, METHOD_DEFLATE, true);
        local.setUint16(10, DOS_TIME, true);
        local.setUint16(12, DOS_DATE, true);
        local.setUint32(14, checksum, true);
        local.setUint32(18, compressed.length, true);
        local.setUint32(22, entry.data.length, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true); // extra field length
        localHeader.set(nameBytes, 30);

        localChunks.push(localHeader, compressed);
        offset += localHeader.length + compressed.length;

        const centralHeader = new Uint8Array(46 + nameBytes.length);
        const central = new DataView(centralHeader.buffer);
        central.setUint32(0, 0x02014b50, true);
        central.setUint16(4, 20, true); // version made by
        central.setUint16(6, 20, true); // version needed to extract
        central.setUint16(8, FLAG_UTF8, true);
        central.setUint16(10, METHOD_DEFLATE, true);
        central.setUint16(12, DOS_TIME, true);
        central.setUint16(14, DOS_DATE, true);
        central.setUint32(16, checksum, true);
        central.setUint32(20, compressed.length, true);
        central.setUint32(24, entry.data.length, true);
        central.setUint16(28, nameBytes.length, true);
        central.setUint16(30, 0, true); // extra field length
        central.setUint16(32, 0, true); // comment length
        central.setUint16(34, 0, true); // disk number start
        central.setUint16(36, 0, true); // internal attributes
        central.setUint32(38, 0, true); // external attributes
        central.setUint32(42, localOffset, true);
        centralHeader.set(nameBytes, 46);

        centralChunks.push(centralHeader);
    }

    const centralSize = centralChunks.reduce((total, chunk) => total + chunk.length, 0);

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true); // this disk
    endView.setUint16(6, 0, true); // disk with central directory
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, offset, true);
    endView.setUint16(20, 0, true); // comment length

    const parts = [...localChunks, ...centralChunks, end];
    const total = parts.reduce((sum, part) => sum + part.length, 0);

    const archive = new Uint8Array(total);
    let cursor = 0;

    for (const part of parts) {
        archive.set(part, cursor);
        cursor += part.length;
    }

    return archive;
}

/* ------------------------------------------------------------------------------------------------
 * XML
 * ------------------------------------------------------------------------------------------------
 */

/**
 * Escape a value for XML text content.
 *
 * Also strips the control characters XML 1.0 forbids outright (they cannot be escaped — there is
 * no legal representation), which is the one way a user-typed value could produce a file Excel
 * refuses to open.
 */
export function escapeXml(value: string): string {
    return value
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

/** 0 → `A`, 25 → `Z`, 26 → `AA`. */
export function columnName(index: number): string {
    let remaining = index + 1;
    let name = "";

    while (remaining > 0) {
        const digit = (remaining - 1) % 26;
        name = String.fromCharCode(65 + digit) + name;
        remaining = Math.floor((remaining - 1) / 26);
    }

    return name;
}

/** Excel forbids these in a tab name, caps it at 31 characters and forbids an empty name. */
export function sanitizeSheetName(name: string): string {
    const cleaned = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);

    return cleaned.length > 0 ? cleaned : "Sheet";
}

/** Tab names must be unique within a workbook; Excel refuses to open a duplicate. */
function uniqueSheetNames(sheets: readonly XlsxSheet[]): string[] {
    const used = new Set<string>();

    return sheets.map((sheet, index) => {
        const base = sanitizeSheetName(sheet.name);
        let candidate = base;
        let suffix = 2;

        while (used.has(candidate.toLowerCase())) {
            const tail = ` (${suffix})`;
            candidate = `${base.slice(0, 31 - tail.length)}${tail}`;
            suffix += 1;
        }

        used.add(candidate.toLowerCase());

        return candidate || `Sheet${index + 1}`;
    });
}

function contentTypesPart(sheets: readonly XlsxSheet[]): string {
    const overrides = sheets
        .map(
            (_, index) =>
                `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("");

    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        overrides +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`
    );
}

const PACKAGE_RELS =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

const SPREADSHEET_NS =
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const RELATIONSHIP_NS =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function workbookPart(names: readonly string[]): string {
    const sheets = names
        .map(
            (name, index) =>
                `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
        )
        .join("");

    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="${SPREADSHEET_NS}" xmlns:r="${RELATIONSHIP_NS}">` +
        `<sheets>${sheets}</sheets>` +
        `</workbook>`
    );
}

function workbookRelsPart(sheetCount: number): string {
    const sheets = Array.from({ length: sheetCount }, (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="${RELATIONSHIP_NS}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    ).join("");

    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets +
        `<Relationship Id="rId${sheetCount + 1}" Type="${RELATIONSHIP_NS}/styles" Target="styles.xml"/>` +
        `</Relationships>`
    );
}

/**
 * The smallest stylesheet Excel accepts: two fonts (body, bold header), three fills (none,
 * gray125 which the spec mandates at index 1, and the header tint), one border, and four cell
 * formats — default, header, `#,##0.00` and `#,##0`.
 */
const STYLES_PART =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="${SPREADSHEET_NS}">` +
    `<numFmts count="2">` +
    `<numFmt numFmtId="${NUM_FMT_MONEY}" formatCode="#,##0.00"/>` +
    `<numFmt numFmtId="${NUM_FMT_INTEGER}" formatCode="#,##0"/>` +
    `</numFmts>` +
    `<fonts count="2">` +
    `<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>` +
    `</fonts>` +
    `<fills count="3">` +
    `<fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>` +
    `</fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="4">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
    `<xf numFmtId="${NUM_FMT_MONEY}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `<xf numFmtId="${NUM_FMT_INTEGER}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `</styleSheet>`;

function styleFor(kind: XlsxCellKind | undefined, value: XlsxCell): number {
    if (kind === "money") return STYLE_MONEY;
    if (kind === "integer") return STYLE_INTEGER;
    if (kind === "decimal") return STYLE_MONEY;
    if (kind === "text") return STYLE_DEFAULT;

    return typeof value === "number" ? STYLE_DEFAULT : STYLE_DEFAULT;
}

function cellXml(
    reference: string,
    value: XlsxCell,
    kind: XlsxCellKind | undefined
): string {
    if (value === null || value === undefined || value === "") {
        return `<c r="${reference}"/>`;
    }

    const style = styleFor(kind, value);

    if (kind === "text") {
        return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
    }

    const numeric =
        typeof value === "number" ? value : Number(value);

    if (Number.isFinite(numeric) && (kind === "money" || kind === "integer" || kind === "decimal")) {
        return `<c r="${reference}" s="${style}"><v>${numeric}</v></c>`;
    }

    if (typeof value === "number") {
        return `<c r="${reference}" s="${style}"><v>${value}</v></c>`;
    }

    return `<c r="${reference}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
}

function columnsPart(columns: readonly XlsxColumn[]): string {
    if (columns.length === 0) {
        return "";
    }

    const entries = columns
        .map((column, index) => {
            // A fixed default keeps the file readable without measuring every cell; a caller that
            // knows better (an amount column, a free-text note) can say so.
            const width = column.width ?? Math.min(48, Math.max(12, column.header.length + 4));

            return `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`;
        })
        .join("");

    return `<cols>${entries}</cols>`;
}

function sheetPart(sheet: XlsxSheet): string {
    const headerCells = sheet.columns
        .map(
            (column, index) =>
                `<c r="${columnName(index)}1" s="${STYLE_HEADER}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(column.header)}</t></is></c>`
        )
        .join("");

    const headerRow =
        sheet.columns.length > 0 ? `<row r="1">${headerCells}</row>` : "";

    const body = sheet.rows
        .map((row, rowIndex) => {
            const rowNumber = rowIndex + 2;
            const cells = row
                .map((value, columnIndex) =>
                    cellXml(
                        `${columnName(columnIndex)}${rowNumber}`,
                        value,
                        sheet.columns[columnIndex]?.kind
                    )
                )
                .join("");

            return `<row r="${rowNumber}">${cells}</row>`;
        })
        .join("");

    // A frozen header row: the sheets are long enough that scrolling away from the column
    // meaning is the first thing an operator does wrong.
    const sheetViews =
        sheet.columns.length > 0 && sheet.rows.length > 0
            ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
            : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;

    return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<worksheet xmlns="${SPREADSHEET_NS}">` +
        sheetViews +
        columnsPart(sheet.columns) +
        `<sheetData>${headerRow}${body}</sheetData>` +
        `</worksheet>`
    );
}

/**
 * Serialise sheets into an `.xlsx` archive.
 *
 * Returns the raw bytes so a route can hand them straight to a `Response` body; there is no
 * filesystem write anywhere in this module.
 */
export function buildXlsx(sheets: readonly XlsxSheet[]): Uint8Array {
    if (sheets.length === 0) {
        throw new Error("buildXlsx requires at least one sheet.");
    }

    const names = uniqueSheetNames(sheets);

    const entries: ZipEntry[] = [
        { name: "[Content_Types].xml", data: textEncoder.encode(contentTypesPart(sheets)) },
        { name: "_rels/.rels", data: textEncoder.encode(PACKAGE_RELS) },
        { name: "xl/workbook.xml", data: textEncoder.encode(workbookPart(names)) },
        {
            name: "xl/_rels/workbook.xml.rels",
            data: textEncoder.encode(workbookRelsPart(sheets.length)),
        },
        { name: "xl/styles.xml", data: textEncoder.encode(STYLES_PART) },
        ...sheets.map((sheet, index) => ({
            name: `xl/worksheets/sheet${index + 1}.xml`,
            data: textEncoder.encode(sheetPart(sheet)),
        })),
    ];

    return buildZip(entries);
}

export const __xlsxInternals = { buildZip, uniqueSheetNames, cellXml, sheetPart, styleFor };
