import fs from "fs";
import path from "path";

import {
    CHECK_IN_METHODS,
    isCheckInMethod,
    resolveCheckInMethod,
    type AdmissionCredential,
    type CheckInMethodListIsExhaustive,
} from "@/lib/ticketing/checkin/method";
import {
    MAX_CHECKIN_QR_PAYLOAD_LENGTH,
    parseCheckInQrPayload,
} from "@/lib/ticketing/checkin/qr-payload";
import { buildTicketQrPayload } from "@/lib/ticketing/tickets/reference";

/**
 * ==========================================
 * PHASE 3B — QR PAYLOAD VALIDATION & CheckInMethod
 * ==========================================
 *
 * Pure suite: no database, no Prisma client, no session, no HTTP. Everything below is the
 * executable form of `docs/PHASE_3B_QR_VALIDATION_DESIGN.md`:
 *
 *   ACCEPT  exactly the payload the wallet renders (`TICKET:<code>`) and the bare code the
 *           manual path already accepts, in the casing/whitespace the gate currently tolerates
 *   REFUSE  everything else, with a classification the client never sees
 *   LABEL   `MANUAL` for the public code — camera or keyboard — and `QR_SCAN` only for a
 *           verified scanner secret, which nothing in the tree can produce yet
 *
 * The acceptance rules are pinned against the EXISTING gate normalisation
 * (`lib/ticketing/checkin/service.ts#normalizeCode`): a payload this parser accepts must be
 * one that function would have accepted, because Phase 3C will swap it in.
 */

const QR_SOURCE = path.join(
    process.cwd(),
    "lib/ticketing/checkin/qr-payload.ts"
);
const METHOD_SOURCE = path.join(
    process.cwd(),
    "lib/ticketing/checkin/method.ts"
);
const SERVICE_SOURCE = path.join(
    process.cwd(),
    "lib/ticketing/checkin/service.ts"
);

/** Inject a value the declared type forbids, at a boundary where one can really arrive. */
function malformed<T>(value: unknown): T {
    return value as T;
}

/**
 * Source with comments removed.
 *
 * The static guards below are about the CODE. A doc comment that says "no `@/lib/prisma`",
 * quotes `"TICKET:"` or names `enum CheckInMethod` is documentation — not an import, a literal
 * or a declaration. A guard that cannot tell those apart fails on the very prose that explains
 * the rule, which is a false positive, not a finding.
 */
function codeOnly(filePath: string): string {
    return fs
        .readFileSync(filePath, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

// ─────────────────────────────────────────────────────────────────────────────
// Accepted payloads
// ─────────────────────────────────────────────────────────────────────────────

describe("B1 — a well-formed payload is accepted and canonicalised", () => {
    test("the wallet payload is accepted as the ticket code plus its namespace", () => {
        const result = parseCheckInQrPayload("TICKET:EVT-2345-6789");

        expect(result.valid).toBe(true);

        if (result.valid) {
            expect(result.ticketCode).toBe("EVT-2345-6789");
            expect(result.canonicalPayload).toBe("TICKET:EVT-2345-6789");
            expect(result.presentedAs).toBe("TICKET_PREFIX");
        }
    });

    test("a bare code is accepted — the manual-entry path", () => {
        const result = parseCheckInQrPayload("EVT-2345-6789");

        expect(result.valid).toBe(true);

        if (result.valid) {
            expect(result.ticketCode).toBe("EVT-2345-6789");
            expect(result.canonicalPayload).toBe("TICKET:EVT-2345-6789");
            expect(result.presentedAs).toBe("BARE_CODE");
        }
    });

    test("case is folded exactly as the current gate folds it", () => {
        // `normalizeCode` upper-cases, so a phone that renders the QR in lower case still
        // admits. Both spellings of the namespace are therefore accepted.
        for (const input of [
            "ticket:evt-2345-6789",
            "Ticket:Evt-2345-6789",
            "evt-2345-6789",
        ]) {
            const result = parseCheckInQrPayload(input);

            expect(result.valid).toBe(true);

            if (result.valid) {
                expect(result.ticketCode).toBe("EVT-2345-6789");
            }
        }
    });

    test("surrounding and post-namespace whitespace is trimmed, not encoded", () => {
        for (const input of [
            "  TICKET:EVT-2345-6789  ",
            "\n\tTICKET:EVT-2345-6789\n",
            "TICKET:  EVT-2345-6789  ",
            "  evt-2345-6789\t",
        ]) {
            const result = parseCheckInQrPayload(input);

            expect(result.valid).toBe(true);

            if (result.valid) {
                expect(result.ticketCode).toBe("EVT-2345-6789");
                expect(result.canonicalPayload).toBe("TICKET:EVT-2345-6789");
            }
        }
    });

    test("the canonical payload is exactly what the wallet builder produces", () => {
        // Not "equal by construction" on trust: the parser's output is compared with the
        // locked builder, so the two could not drift without failing here.
        for (const code of [
            "EVT-2345-6789",
            "EVT-ABCD-EFGH",
            "EVT-JKMN-PQRS",
            "EVT-TVWX-YZ23",
            "EVT-9999-2222",
        ]) {
            const result = parseCheckInQrPayload(`TICKET:${code}`);

            expect(result.valid).toBe(true);

            if (result.valid) {
                expect(result.canonicalPayload).toBe(buildTicketQrPayload(code));
            }
        }
    });

    test("an accepted result carries exactly the four contract keys", () => {
        const result = parseCheckInQrPayload("TICKET:EVT-2345-6789");

        expect(Object.keys(result).sort()).toEqual([
            "canonicalPayload",
            "presentedAs",
            "ticketCode",
            "valid",
        ]);
    });

    test("a rejected result carries exactly the two contract keys — and no echo", () => {
        const result = parseCheckInQrPayload("TICKET:buyer@example.test?k=secret");

        expect(Object.keys(result).sort()).toEqual(["reason", "valid"]);
        // The input is never reflected: a refusal must not put a scanned value into a log,
        // an audit row or a UI message.
        expect(JSON.stringify(result)).not.toContain("buyer@example.test");
        expect(JSON.stringify(result)).not.toContain("secret");
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rejections — one row per refusal reason
// ─────────────────────────────────────────────────────────────────────────────

describe("B2 — a payload that is not a ticket reference is refused", () => {
    test.each([
        ["a number", 42],
        ["null", null],
        ["undefined", undefined],
        ["a boolean", true],
        ["an object", { code: "EVT-2345-6789" }],
        ["an array", ["EVT-2345-6789"]],
    ])("a payload that is %s is refused as NOT_A_STRING", (_label, value) => {
        expect(parseCheckInQrPayload(value)).toEqual({
            valid: false,
            reason: "NOT_A_STRING",
        });
    });

    test.each([[""], ["   "], ["\n\t "]])(
        "an empty payload %p is refused as EMPTY_PAYLOAD",
        (value) => {
            expect(parseCheckInQrPayload(value)).toEqual({
                valid: false,
                reason: "EMPTY_PAYLOAD",
            });
        }
    );

    test("a payload beyond the request schema's bound is refused before parsing", () => {
        const oversized = `TICKET:${"A".repeat(
            MAX_CHECKIN_QR_PAYLOAD_LENGTH + 10
        )}`;

        expect(oversized.length).toBeGreaterThan(
            MAX_CHECKIN_QR_PAYLOAD_LENGTH
        );
        expect(parseCheckInQrPayload(oversized)).toEqual({
            valid: false,
            reason: "PAYLOAD_TOO_LONG",
        });
    });

    test.each([
        ["an https URL", "https://example.test/t/EVT-2345-6789"],
        ["an http URL", "http:EVT-2345-6789"],
        ["a mailto URI", "mailto:buyer@example.test"],
        ["another product's namespace", "TIKET:EVT-2345-6789"],
        ["a code followed by a segment", "EVT-2345-6789:extra"],
        ["a URL with a ticket code in the path", "https://x.test/TICKET:EVT-2345-6789"],
    ])("%s is refused as UNSUPPORTED_FORMAT", (_label, value) => {
        expect(parseCheckInQrPayload(value)).toEqual({
            valid: false,
            reason: "UNSUPPORTED_FORMAT",
        });
    });

    test.each([["TICKET:"], ["TICKET:   "], ["ticket:"]])(
        "the namespace with no code (%p) is refused as MISSING_CODE",
        (value) => {
            expect(parseCheckInQrPayload(value)).toEqual({
                valid: false,
                reason: "MISSING_CODE",
            });
        }
    );

    test.each([
        ["too few groups", "EVT-2345"],
        ["too many characters in a group", "EVT-2345-67890"],
        ["the excluded digit 0", "EVT-0000-0000"],
        ["the excluded letters O and I", "EVT-OOOO-IIII"],
        ["a lowercase-only value after folding is still invalid", "evt"],
        ["a token appended as a query parameter", "TICKET:EVT-2345-6789?k=secret"],
        ["an email address", "buyer@example.test"],
        ["a path traversal string", "../../etc/passwd"],
        ["a SQL fragment", "EVT-2345-6789;DROP TABLE ticket"],
        ["a hash of a scanner token", "a".repeat(64)],
        [
            "a base64url scanner token",
            "Zm9vYmFyLXNlY3JldC10b2tlbi0xMjM0NTY3ODkwYWJjZGVm",
        ],
    ])("%s is refused as INVALID_CODE_FORMAT", (_label, value) => {
        expect(parseCheckInQrPayload(value)).toEqual({
            valid: false,
            reason: "INVALID_CODE_FORMAT",
        });
    });
});

describe("B2 — the refusal classification never leaks into a decision", () => {
    test("every rejection is invalid, and no rejection carries a code or payload", () => {
        const rejections = [
            parseCheckInQrPayload(42),
            parseCheckInQrPayload(""),
            parseCheckInQrPayload("x".repeat(200)),
            parseCheckInQrPayload("https://example.test"),
            parseCheckInQrPayload("TICKET:"),
            parseCheckInQrPayload("EVT-2345"),
        ];

        for (const result of rejections) {
            expect(result.valid).toBe(false);

            if (!result.valid) {
                expect(Object.keys(result).sort()).toEqual(["reason", "valid"]);
            }
        }
    });

    test("a valid code in a wrong namespace is never silently repaired", () => {
        // The tempting bug: strip anything before ':' and carry on. A neighbouring product's
        // payload would then be admitted as ours.
        expect(parseCheckInQrPayload("OTHER:EVT-2345-6789").valid).toBe(false);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Purity and isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("B3 — the parser is pure and deterministic", () => {
    test("the same input yields deep-equal results every time", () => {
        for (const input of [
            "TICKET:EVT-2345-6789",
            "EVT-2345-6789",
            "nope",
            "",
        ]) {
            const first = parseCheckInQrPayload(input);

            for (let attempt = 0; attempt < 50; attempt += 1) {
                expect(parseCheckInQrPayload(input)).toEqual(first);
            }
        }
    });

    test("accepting one payload does not affect the next", () => {
        expect(parseCheckInQrPayload("TICKET:EVT-2345-6789").valid).toBe(true);
        expect(parseCheckInQrPayload("TICKET:EVT-9999-2222").valid).toBe(true);
        expect(parseCheckInQrPayload("nope").valid).toBe(false);
        expect(parseCheckInQrPayload("TICKET:EVT-2345-6789").valid).toBe(true);
    });

    test.each([
        ["a null byte", "TICKET:EVT-2345-6789\u0000"],
        ["emoji", "🎟️"],
        ["RTL text", "TICKET:‮EVT-2345-6789"],
        ["a very long junk string", "Z".repeat(120)],
        ["punctuation only", ";;::--__"],
    ])("never throws on %s", (_label, value) => {
        expect(() => parseCheckInQrPayload(value)).not.toThrow();
        expect(parseCheckInQrPayload(value).valid).toBe(false);
    });

    test("the module imports no database, service, clock or network surface", () => {
        const source = codeOnly(QR_SOURCE);

        // The parse must stay usable without a database and without the check-in service
        // (which pulls Prisma, the authz barrel and next-auth).
        expect(source).not.toMatch(/@\/lib\/prisma/);
        expect(source).not.toMatch(/PrismaClient/);
        expect(source).not.toMatch(/from "@prisma\/client"/);
        expect(source).not.toMatch(/from "\.\/service"/);
        expect(source).not.toMatch(/from "\.\.\/checkin\/service"/);
        expect(source).not.toMatch(/fetch\(/);
        expect(source).not.toMatch(/process\.env/);
        expect(source).not.toMatch(/new Date\(/);
        expect(source).not.toMatch(/Math\.random/);
    });

    test("the payload format is imported from the locked reference module, not redefined", () => {
        const source = codeOnly(QR_SOURCE);

        expect(source).toContain('from "@/lib/ticketing/tickets/reference"');
        expect(source).toContain("TICKET_QR_PREFIX");
        expect(source).toContain("isTicketCode");
        expect(source).toContain("buildTicketQrPayload");
        // No second regex, no second prefix, no second grammar.
        expect(source).not.toMatch(/EVT-\[/);
        expect(source).not.toMatch(/"TICKET:"/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// CheckInMethod contract
// ─────────────────────────────────────────────────────────────────────────────

describe("C1 — CheckInMethod lists exactly the schema's values", () => {
    test("the tuple is QR_SCAN then MANUAL, as declared in the enum", () => {
        expect([...CHECK_IN_METHODS]).toEqual(["QR_SCAN", "MANUAL"]);
    });

    test("the tuple is exhaustive — a new enum member would fail to compile", () => {
        // `CheckInMethodListIsExhaustive` resolves to `never` when an enum value is missing
        // from `CHECK_IN_METHODS`; this assignment is a compile-time assertion, and the
        // runtime expectation keeps the intent visible in the test output.
        const exhaustive: CheckInMethodListIsExhaustive = true;

        expect(exhaustive).toBe(true);
    });

    test.each([["QR_SCAN"], ["MANUAL"]])(
        "isCheckInMethod accepts %p",
        (value) => {
            expect(isCheckInMethod(value)).toBe(true);
        }
    );

    test.each([
        ["a design-only value", "MANUAL_CODE"],
        ["another design-only value", "MANUAL_OVERRIDE"],
        ["lower case", "manual"],
        ["a padded value", " MANUAL"],
        ["an empty string", ""],
        ["a number", 1],
        ["null", null],
        ["undefined", undefined],
        ["an object", { method: "MANUAL" }],
    ])("isCheckInMethod refuses %s", (_label, value) => {
        expect(isCheckInMethod(value)).toBe(false);
    });
});

describe("C2 — only a verified secret may be labelled QR_SCAN", () => {
    test("a verified scanner secret resolves to QR_SCAN", () => {
        expect(resolveCheckInMethod("VERIFIED_SCANNER_SECRET")).toBe("QR_SCAN");
    });

    test("the public ticket code resolves to MANUAL — camera or keyboard alike", () => {
        // B-2 / P14-D17: the wallet QR carries the public code, so scanning it proves no
        // secret and must be recorded as MANUAL.
        expect(resolveCheckInMethod("PUBLIC_TICKET_CODE")).toBe("MANUAL");
    });

    test.each([
        ["null", null],
        ["undefined", undefined],
        ["an empty string", ""],
        ["the string QR_SCAN", "QR_SCAN"],
        ["a mis-cased credential", "verified_scanner_secret"],
        ["a padded credential", " VERIFIED_SCANNER_SECRET"],
        ["a credential-shaped code", "TICKET:EVT-2345-6789"],
    ])("%s resolves to MANUAL, never QR_SCAN", (_label, value) => {
        expect(
            resolveCheckInMethod(malformed<AdmissionCredential>(value))
        ).toBe("MANUAL");
    });

    test("every resolved value is a member of the schema's enum", () => {
        const credentials: (AdmissionCredential | null | undefined)[] = [
            "PUBLIC_TICKET_CODE",
            "VERIFIED_SCANNER_SECRET",
            null,
            undefined,
        ];

        for (const credential of credentials) {
            expect(isCheckInMethod(resolveCheckInMethod(credential))).toBe(true);
        }
    });

    test("the module declares no enum of its own and imports the database type only", () => {
        const source = codeOnly(METHOD_SOURCE);

        // A type-only import keeps Prisma out of the runtime and prevents a duplicate enum.
        expect(source).toContain('import type { CheckInMethod } from "@prisma/client"');
        expect(source).not.toMatch(/PrismaClient/);
        expect(source).not.toMatch(/@\/lib\/prisma/);
        expect(source).not.toMatch(/enum CheckInMethod/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// The shipped gate still records MANUAL only
//
// Phase 3B asserted this while the service was untouched. Phase 3C deliberately wires the
// parser in, so the two guards that pinned "the service does not import the new modules" and
// "the constant is a bare literal" were replaced by the properties that still matter — the
// label comes from the resolver, and the service reuses the parser instead of copying it.
// ─────────────────────────────────────────────────────────────────────────────

describe("C3 — the shipped check-in path still records MANUAL only", () => {
    const service = codeOnly(SERVICE_SOURCE);

    test("the service's method constant resolves to MANUAL, not to a chosen literal", () => {
        expect(service).toContain(
            'const CHECK_IN_METHOD: CheckInMethod = resolveCheckInMethod("PUBLIC_TICKET_CODE")'
        );
    });

    test("no code path writes QR_SCAN", () => {
        // Comments discuss the value (that is why this matches a quoted literal only): the
        // contract is that no assignment or data field can carry it.
        expect(service).not.toMatch(/"QR_SCAN"/);
        expect(service).not.toMatch(/'QR_SCAN'/);
    });

    test("the scanner secret hash is never selected or hashed by the gate", () => {
        expect(service).not.toMatch(/qrTokenHash\s*:\s*true/);
        expect(service).not.toMatch(/hashQrToken\s*\(/);
        expect(service).not.toMatch(/\["qrTokenHash"\]/);
    });

    test("the service consumes the parser instead of carrying a second one", () => {
        // Phase 3C is the intended consumer. What must never return is a duplicated
        // implementation: the prefix, the code pattern and the folding live in the Phase 3B
        // module, and the service only calls it.
        expect(service).toContain('from "./qr-payload"');
        expect(service).toContain('from "./method"');
        expect(service).not.toContain("TICKET_QR_PREFIX");
        expect(service).not.toContain("isTicketCode");
    });
});
