import type { CheckInMethod } from "@prisma/client";

/**
 * ==========================================
 * PHASE 3B — `CheckInMethod` LABELLING CONTRACT
 * ==========================================
 *
 * `CheckIn.method` is evidence: it tells an operator, a report and an auditor HOW an
 * admission was justified. Two values exist in the shipped schema
 * (`prisma/schema.prisma`, `enum CheckInMethod { QR_SCAN MANUAL }`), and the meaning of each
 * is fixed by decisions taken before this phase:
 *
 *   MANUAL    the admission was resolved from the PUBLIC ticket code — typed by an usher,
 *             pasted, or decoded from the wallet QR by a camera. The QR is a CARRIER of the
 *             public code, not a credential: anyone who has seen `EVT-XXXX-XXXX` can print a
 *             QR that says the same thing.
 *
 *   QR_SCAN   the admission was justified by verifying a SCANNER SECRET against
 *             `Ticket.qrTokenHash`. That value is 32 random bytes minted at issuance; only
 *             its SHA-256 is stored, and the raw token has never been delivered to any
 *             client (decision D-46 / `P14-D17`, `TICKETING_PHASE10_REPORT.md`).
 *
 * ── THE RULE THIS MODULE MAKES EXECUTABLE ───────────────────────────────────────
 * A camera scan of the wallet QR is `MANUAL`, because no secret was verified. Labelling it
 * `QR_SCAN` would put a false statement in an append-only audit table — the audit trail
 * would claim a token check that never happened. `QR_SCAN` is therefore reachable ONLY from
 * the `VERIFIED_SCANNER_SECRET` credential, and nothing in the tree produces one today.
 *
 * This is the Phase 3B security requirement stated in
 * `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md` §3B ("record `CheckInMethod.QR_SCAN` **only**
 * when a genuine secret was verified; otherwise stay `MANUAL`"), and its stop condition
 * ("a `QR_SCAN` label without a verified secret ⇒ STOP"). Writing the rule as a pure
 * function means Phase 3C cannot get it wrong by inlining a ternary beside a camera path.
 *
 * ── NO NEW ENUM MEMBER, NO MIGRATION ────────────────────────────────────────────
 * Design §20.1 named `QR_SCAN | MANUAL_CODE | MANUAL_OVERRIDE`, but the shipped enum is
 * `QR_SCAN | MANUAL` (`PHASE_10_REPORT.md` records the divergence). Phase 3B must not invent
 * values: a new member is an `ALTER` on MariaDB, i.e. a migration, which this phase is
 * forbidden to run. `CheckInMethodValue` aliases Prisma's generated enum instead of
 * re-declaring it, so the day the enum changes, `tsc` fails here rather than the contract
 * drifting silently.
 */

/**
 * The database's own enum, aliased — not a second declaration.
 *
 * A type-only import: Prisma is erased at compile time, so this module has no runtime
 * dependency on the client and no connection is ever opened.
 */
export type CheckInMethodValue = CheckInMethod;

/**
 * Every value the schema allows, in declaration order.
 *
 * `satisfies readonly CheckInMethod[]` rejects an invented member at compile time; the
 * exhaustiveness proof below rejects a *missing* one.
 */
export const CHECK_IN_METHODS = [
    "QR_SCAN",
    "MANUAL",
] as const satisfies readonly CheckInMethod[];

/**
 * Compile-time proof that {@link CHECK_IN_METHODS} lists every `CheckInMethod`.
 *
 * Adding an enum member without listing it leaves the `Exclude` non-`never`, so the type
 * below becomes `never` and any `: CheckInMethodListIsExhaustive = true` assignment fails.
 */
export type CheckInMethodListIsExhaustive = [
    Exclude<CheckInMethod, (typeof CHECK_IN_METHODS)[number]>,
] extends [never]
    ? true
    : never;

/** The two ways an admission can be justified — named so the difference cannot be glossed. */
export type AdmissionCredential =
    /** The public `TICKET:<ticketCode>` / bare code. Not a secret. */
    | "PUBLIC_TICKET_CODE"
    /** A scanner secret verified against `Ticket.qrTokenHash`. No producer exists today. */
    | "VERIFIED_SCANNER_SECRET";

const METHOD_SET: ReadonlySet<string> = new Set<string>(CHECK_IN_METHODS);

/**
 * Is this value one of the schema's methods?
 *
 * Values come from a database column (already constrained) or from a report filter, so the
 * check is about refusing an unknown string rather than about trusting a type.
 */
export function isCheckInMethod(value: unknown): value is CheckInMethodValue {
    return typeof value === "string" && METHOD_SET.has(value);
}

/**
 * Which method justifies an admission performed with this credential?
 *
 * Deliberately fails closed for the LABEL: only the exact `"VERIFIED_SCANNER_SECRET"` may
 * produce `QR_SCAN`. Anything else — `null`, `undefined`, an unknown string, a mis-cased
 * spelling, or the public code — yields `MANUAL`, which is the truth for every admission the
 * system can currently perform.
 */
export function resolveCheckInMethod(
    credential: AdmissionCredential | null | undefined
): CheckInMethodValue {
    return credential === "VERIFIED_SCANNER_SECRET" ? "QR_SCAN" : "MANUAL";
}
