import { z } from "zod";

/**
 * ==========================================
 * PIC VALIDATION
 * ==========================================
 *
 * A PIC is a User with a `PICProfile` — that is the model's own documented meaning, and the whole
 * reason this feature does not create accounts. The admin links an EXISTING account by e-mail; an
 * address with no account is a validation error that says so, rather than silently creating a user
 * with no credentials that could never sign in.
 *
 * NO BUSINESS RATE IS ENCODED. `defaultFeeRateBp` defaults to `0`, which the schema defines as
 * "inherit the event/organizer/platform default", not as "a five-percent commission". The previous
 * retail affiliate concept hard-coded a percentage into its profile default; that value is not
 * carried over, because no commercial decision authorises it.
 */

/** Basis points are 0..10000 (100%). 0 means "inherit". */
const feeRateBpSchema = z
    .number()
    .int("Tarif harus bilangan bulat basis poin")
    .min(0, "Tarif tidak boleh negatif")
    .max(10000, "Tarif maksimum 10000 basis poin (100%)");

const accountField = z
    .string()
    .trim()
    .max(64, "Maksimum 64 karakter")
    .optional();

export const createPicSchema = z.object({
    /** The e-mail of the account this PIC profile belongs to. Required. */
    email: z
        .string()
        .trim()
        .min(1, "Email wajib diisi")
        .email("Email tidak valid"),

    displayName: z
        .string()
        .trim()
        .min(2, "Nama minimal 2 karakter")
        .max(120, "Nama maksimum 120 karakter"),

    /** Optional; derived from the display name when omitted. */
    picCode: z
        .string()
        .trim()
        .min(3, "Kode minimal 3 karakter")
        .max(40, "Kode maksimum 40 karakter")
        .regex(/^[A-Za-z0-9-]+$/, "Kode hanya boleh huruf, angka, dan tanda hubung")
        .optional(),

    defaultFeeRateBp: feeRateBpSchema.optional(),

    canSellAllEvents: z.boolean().optional(),

    bankName: accountField,
    bankAccountName: accountField,
    bankAccountNumber: accountField,
    taxId: accountField,

    identityNote: z.string().trim().max(2000, "Catatan maksimum 2000 karakter").optional(),
});

export type CreatePicInput = z.infer<typeof createPicSchema>;

/**
 * Status transitions an operator may perform.
 *
 * `PENDING` is the creation state and is deliberately NOT settable here — re-opening an approved or
 * suspended profile is a different decision that this surface does not make. `APPROVED` records
 * `approvedAt`/`approvedByUserId`; `REJECTED` and `SUSPENDED` do not, so an approval timestamp can
 * never describe a rejection.
 */
export const updatePicStatusSchema = z.object({
    status: z.enum(["ACTIVE", "SUSPENDED", "REJECTED"], {
        message: "Status harus ACTIVE, SUSPENDED, atau REJECTED",
    }),
    reason: z.string().trim().max(500, "Alasan maksimum 500 karakter").optional(),
});

export type UpdatePicStatusInput = z.infer<typeof updatePicStatusSchema>;

export const assignPicSchema = z.object({
    picProfileId: z.string().trim().min(1, "PIC wajib dipilih"),
    eventId: z.string().trim().min(1, "Event wajib dipilih"),

    /** Optional per-event override; omitted means "inherit the PIC default". */
    feeRateBp: feeRateBpSchema.optional(),

    feeTypeOverride: z.enum(["PERCENTAGE", "FIXED", "HYBRID"]).optional(),
});

export type AssignPicInput = z.infer<typeof assignPicSchema>;
