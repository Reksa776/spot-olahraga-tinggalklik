import { z } from "zod";

/**
 * ==========================================
 * SETTLEMENT VALIDATION (PICO payout / settlement V1)
 * ==========================================
 *
 * The operator API deliberately accepts almost nothing from the client, because a payout
 * is a money movement and every value that determines how much money moves must be
 * derived server-side (brief §17, D-61):
 *
 *   * NO `grossAmount`, `deductionAmount`, `netAmount`, `status` or `method` — the
 *     amounts are the sum of the PIC's EARNED ledger rows in the period (minus the
 *     offsetting REVERSAL rows), computed by the transactional core. `MANUAL_TRANSFER`
 *     is the only method V1 writes (D-P17-04 = B; `GATEWAY_SPLIT` is storage-only,
 *     D-04).
 *   * NO `bankName` / `bankAccountName` / `bankAccountNumber` — the bank snapshot is
 *     copied from the PIC's profile when the settlement is prepared, so the recorded
 *     bank can never be altered by the person preparing their own payout evidence.
 *   * NO `userId`, `paidByUserId`, `approvedByUserId` — actors come from the session.
 *   * Period bounds and the payee are the ONLY client inputs: `organizerId` (the tenant
 *     the operator acts in), `picProfileId` (the payee) and the window.
 *
 * Zod strips unknown keys by default and no schema opts into `passthrough()` /
 * `catchall()`, so a tampered field never reaches the service (the same contract the
 * refund schemas state).
 */

/** The settlement lifecycle statuses a list query may filter on. */
export const SETTLEMENT_STATUSES = [
    "DRAFT",
    "PENDING_APPROVAL",
    "APPROVED",
    "PAID",
    "FAILED",
    "CANCELLED",
    // PHASE 21 — the PIC-initiated payout-request states.
    "REQUESTED",
    "REJECTED",
] as const;

export const settlementStatusSchema = z.enum(SETTLEMENT_STATUSES);

const idSchema = z.string().trim().min(1).max(64);

/**
 * `POST /api/organizer/settlements` — prepare a draft payout for one PIC in one period.
 *
 * The window is the only money-relevant input (which EARNED rows get settled), and
 * `(payeeType, organizerId, periodStart, periodEnd)` is UNIQUE, so a re-prepared window
 * replays the existing draft instead of double-settling it.
 */
export const prepareSettlementSchema = z
    .object({
        organizerId: idSchema,
        picProfileId: idSchema,
        periodStart: z.string().trim().min(1).max(40),
        periodEnd: z.string().trim().min(1).max(40),
        notes: z.string().trim().max(2000).optional(),
    })
    .refine(
        (value) => {
            const start = new Date(value.periodStart).getTime();
            const end = new Date(value.periodEnd).getTime();

            return (
                !Number.isNaN(start) &&
                !Number.isNaN(end) &&
                end > start
            );
        },
        {
            message:
                "Periode harus rentang waktu valid dengan akhir setelah awal.",
            path: ["periodEnd"],
        }
    );

export type PrepareSettlementInput = z.infer<typeof prepareSettlementSchema>;

/**
 * `POST /api/organizer/settlements/[id]/submit` — ask for approval. Empty body;
 * an optional internal `note` rides along.
 */
export const submitSettlementSchema = z
    .object({
        note: z.string().trim().max(1000).optional(),
    })
    .optional()
    .default({});

/**
 * `POST /api/organizer/settlements/[id]/approve` — authorise the transfer.
 */
export const approveSettlementSchema = z
    .object({
        note: z.string().trim().max(1000).optional(),
    })
    .optional()
    .default({});

/**
 * `POST /api/organizer/settlements/[id]/paid` — record the MANUAL BANK TRANSFER and
 * move money (the settlement equivalent of `refund.settle`, D-R12).
 *
 * The body carries EVIDENCE and nothing else:
 *
 *   * `providerReference` — the bank/transfer reference the operator used. REQUIRED,
 *     because a payout may not reach `PAID` without a recorded transfer: that is the
 *     whole point of the manual rail, and it is what makes the payout auditable by a
 *     third party. Persisted on `Settlement.providerReference` (never an iPaymu id).
 *   * `note` — the operator's evidence note, persisted on `Settlement.notes`.
 *
 * No amount, no currency, no status, no actor is accepted.
 */
export const markPaidSchema = z
    .object({
        providerReference: z
            .string()
            .trim()
            .min(3, "Referensi transfer wajib diisi")
            .max(120, "Referensi transfer maksimum 120 karakter"),
        note: z.string().trim().max(2000).optional(),
    })
    .strict();

export type MarkPaidInput = z.infer<typeof markPaidSchema>;

/**
 * `POST /api/organizer/settlements/[id]/fail` — abandon an APPROVED payout whose
 * transfer did not go through. A reason is REQUIRED (D-R13 convention) and persists on
 * `failureReason` for the operator to read later.
 */
export const failSettlementSchema = z.object({
    reason: z
        .string()
        .trim()
        .min(3, "Alasan wajib diisi")
        .max(500, "Alasan maksimum 500 karakter"),
});

export type FailSettlementInput = z.infer<typeof failSettlementSchema>;

/**
 * `POST /api/organizer/settlements/[id]/reject` — refuse a PIC-initiated `REQUESTED`
 * payout.
 *
 * The reason is REQUIRED (min 3 chars, the same floor every rejection/failure note
 * uses) because it is shown to the PIC as `rejectionReason` — a silent refusal would
 * leave the requester unable to fix whatever was wrong. No amount, status or actor is
 * accepted; the server writes the state, the actor and the timestamp.
 */
export const rejectSettlementSchema = z
    .object({
        reason: z
            .string()
            .trim()
            .min(3, "Alasan penolakan wajib diisi")
            .max(500, "Alasan penolakan maksimum 500 karakter"),
    })
    .strict();

export type RejectSettlementInput = z.infer<typeof rejectSettlementSchema>;

/** Fields each capped at 64 like the PIC profile's own account fields. */
const bankField = (label: string) =>
    z
        .string()
        .trim()
        .min(1, `${label} wajib diisi.`)
        .max(64, `${label} maksimum 64 karakter.`);

/**
 * The payee bank block a PIC may send WITH a payout request.
 *
 * This is the destination of the money, so it is deliberately COMPLETE when present:
 * a partially-filled block is refused rather than stored half-written (the money engine's
 * `BANK_DETAILS_MISSING` guard is all-or-nothing — `bankName`, `bankAccountName` and
 * `bankAccountNumber` must all be present for a snapshot to be taken).
 *
 * ── WHAT IS DELIBERATELY NOT VALIDATED ───────────────────────────────────────────
 * There is NO digits-only rule on `bankAccountNumber`. The column is free text and always
 * has been; imposing a numeric format here would invent a business rule that could reject
 * a legitimate account identifier. It is trimmed and length-bounded only.
 *
 * The schema is `.strict()`, so `taxId`, `picProfileId`, `userId` or any future field is a
 * 400 rather than a silent no-op — `taxId` in particular is NOT part of the payout
 * contract (the engine never reads it).
 */
export const picPayoutBankSchema = z
    .object({
        bankName: bankField("Nama bank"),
        bankAccountName: bankField("Nama pemilik rekening"),
        bankAccountNumber: bankField("Nomor rekening"),
    })
    .strict();

export type PicPayoutBankInput = z.infer<typeof picPayoutBankSchema>;

/**
 * `POST /api/pic/payouts` — a PIC requests a payout for ONE organizer (PHASE 21).
 *
 * The body names the tenant, an optional note, and (optionally) the payee bank block.
 * There is NO amount, NO status and NO `picProfileId` — the amount is whatever the PIC's
 * own eligible ledger rows add up to for that tenant, derived server-side by the
 * settlement money engine. A tampered field never reaches the service (the schema is
 * strict).
 *
 * ── THE OPTIONAL `bank` BLOCK ────────────────────────────────────────────────────
 * When present, the service writes it onto the PIC's OWN `PICProfile` before calling the
 * money engine, so the payout is snapshotted against the account the PIC just confirmed
 * (the "consolidate bank details into the payout dialog" flow). When absent, the profile
 * is left alone and the engine uses whatever it already holds — which is why an
 * incomplete profile still answers `BANK_DETAILS_MISSING`.
 *
 * Only the PIC's own profile is ever written: the block carries no id, and the profile is
 * resolved from the SESSION by `requireMyPic`, so it cannot name another payee.
 */
export const picPayoutRequestSchema = z
    .object({
        organizerId: z
            .string()
            .trim()
            .min(1, "Penyelenggara wajib dipilih.")
            .max(64),
        notes: z.string().trim().max(2000).optional(),
        bank: picPayoutBankSchema.optional(),
    })
    .strict();

export type PicPayoutRequestInput = z.infer<typeof picPayoutRequestSchema>;

/** The `[settlementId]` path segment. `Settlement.id` is a cuid string. */
export const settlementIdParamSchema = z.string().trim().min(1).max(64);

/** `GET /api/organizer/settlements` — list, scoped to a tenant the actor may read. */
export const settlementListQuerySchema = z.object({
    organizerId: idSchema.optional(),
    status: settlementStatusSchema.optional(),
    picProfileId: idSchema.optional(),
    page: z.coerce.number().int().positive().max(1000).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
});

export type SettlementListQuery = z.infer<typeof settlementListQuerySchema>;