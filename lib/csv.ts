/**
 * ==========================================
 * CSV SERIALISATION (PHASE 31, pure)
 * ==========================================
 *
 * One dependency-free CSV writer for financial exports. It exists so the escaping rules —
 * RFC 4180 quoting AND spreadsheet formula-injection neutralisation — are defined in one
 * place and can be unit-tested without a database, a renderer or a provider.
 *
 * ── WHY `kind` MATTERS (and why money is never mangled) ─────────────────────────
 * A CSV cell holds no type. Excel/Sheets interpret a leading `=`, `+`, `-` or `@` as a
 * formula, which is a real injection vector when the value came from a user-controlled text
 * field (a PIC display name, an event title, an operator note). But the SAME leading `-` is
 * how a legitimate NEGATIVE MONEY value is written (`-40.00`). Neutralising everything would
 * corrupt the ledger's own sign.
 *
 * So columns declare their intent:
 *
 *   kind: "text"   → untrusted free text; a leading `= + - @ TAB CR` is prefixed with `'`
 *                    (the spreadsheet convention for "this is literal text").
 *   kind: "value"  → a machine-generated value (Decimal string, id, date, enum, count); never
 *                    neutralised, so money keeps its exact textual representation.
 *
 * Money, ids, dates, enum names and counts are ALWAYS `value` cells and are additionally
 * NEVER passed through `Number()` — the caller hands us the exact `Decimal(14,2)` string.
 *
 * ── LINE ENDINGS / BOM ──────────────────────────────────────────────────────────
 * Records are joined with CRLF (RFC 4180) and a UTF-8 BOM helper is provided because Excel on
 * Windows needs the BOM to read a UTF-8 file as UTF-8 rather than as the system code page.
 */

export type CsvCellKind = "text" | "value";

export type CsvColumn = {
    /** Key into each row object. */
    key: string;
    /** Header text. Developer-controlled, so it is escaped but never neutralised. */
    header: string;
    /**
     * `text` neutralises spreadsheet formula prefixes; `value` (the default) preserves the
     * exact string. Money/enum/date/id columns MUST be `value`.
     */
    kind?: CsvCellKind;
};

export type CsvRow = Record<string, string | null | undefined>;

/** UTF-8 byte-order mark, so Excel reads the file as UTF-8. */
export const UTF8_BOM = "\uFEFF";

/** A value that a spreadsheet could treat as a formula when it begins with one of these. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/;

/**
 * Neutralise a formula-injection prefix on UNTRUSTED text.
 *
 * Prefixing with a single quote is the spreadsheet convention for "literal text"; the quote is
 * not displayed by Excel/Sheets/LibreOffice once the cell is parsed. It is only applied to
 * `text` cells, never to money/value cells.
 */
export function neutralizeCsvFormula(value: string): string {
    return FORMULA_PREFIX.test(value) ? `'${value}` : value;
}

/**
 * RFC 4180 field quoting: wrap in double quotes when the value contains `,`, `"`, CR or LF,
 * doubling any interior quote.
 */
export function escapeCsvField(value: string): string {
    if (/[",\r\n]/.test(value)) {
        return `"${value.replace(/"/g, '""')}"`;
    }

    return value;
}

/**
 * Serialise rows to a CSV document (CRLF line endings, trailing newline).
 *
 * `columns` fixes the ORDER — the export contract is that columns never reorder between
 * releases. Missing/null cells become empty fields; a `text` cell is neutralised, a `value`
 * cell is emitted verbatim.
 */
export function toCsv(
    columns: readonly CsvColumn[],
    rows: readonly CsvRow[]
): string {
    const lines: string[] = [
        columns.map((column) => escapeCsvField(column.header)).join(","),
    ];

    for (const row of rows) {
        const fields = columns.map((column) => {
            const raw = row[column.key];
            const value = raw === null || raw === undefined ? "" : String(raw);
            const safe = column.kind === "text" ? neutralizeCsvFormula(value) : value;
            return escapeCsvField(safe);
        });

        lines.push(fields.join(","));
    }

    return `${lines.join("\r\n")}\r\n`;
}

/** Prefix a CSV document with the UTF-8 BOM (for `text/csv` downloads). */
export function withUtf8Bom(csv: string): string {
    return `${UTF8_BOM}${csv}`;
}
