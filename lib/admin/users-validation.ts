import { z } from "zod";

/**
 * ==========================================
 * USER MANAGEMENT VALIDATION (PHASE 33)
 * ==========================================
 *
 * The request contract for `/api/admin/users`. Deliberately minimal: the fields the schema
 * needs, and nothing the database does not (brief §V — "Do not request fields that the
 * database does not need").
 *
 * ── THE PASSWORD POLICY IS THE REGISTRATION POLICY ─────────────────────────────
 * The exact rules `app/api/auth/register` enforces (min 8, upper + lower + digit), so an
 * account created by an ADMIN is no weaker than one created by its owner. The email is
 * lowercased in the service, not here, so the Zod error message keeps pointing at the
 * field the caller sent.
 */

/** Basis points are 0..10000 (100%). 0 means "inherit" — same contract as the PIC flow. */
const feeRateBpSchema = z
    .number()
    .int("Tarif harus bilangan bulat basis poin")
    .min(0, "Tarif tidak boleh negatif")
    .max(10000, "Tarif maksimum 10000 basis poin (100%)");

export const createManagedUserSchema = z.object({
    name: z
        .string()
        .trim()
        .min(2, "Nama minimal 2 karakter")
        .max(120, "Nama maksimum 120 karakter"),

    email: z.string().trim().min(1, "Email wajib diisi").email("Email tidak valid"),

    password: z
        .string()
        .min(8, "Password minimal 8 karakter")
        .regex(/[A-Z]/, "Password harus mengandung minimal 1 huruf besar")
        .regex(/[a-z]/, "Password harus mengandung minimal 1 huruf kecil")
        .regex(/[0-9]/, "Password harus mengandung minimal 1 angka"),

    /**
     * THE FIXED CHOICE. `z.enum` is what makes the privilege boundary structural: a body
     * carrying `"role": "ADMIN"` fails validation before the service ever runs. There is
     * no passthrough, no catch-all, no optional extra role field.
     */
    role: z.enum(["MANAGER", "PIC"], {
        message: "Peran harus MANAGER atau PIC",
    }),

    phone: z
        .string()
        .trim()
        .max(32, "Nomor HP maksimum 32 karakter")
        .optional(),

    /** PIC-only profile fields. Ignored for MANAGER (the service never reads them there). */
    pic: z
        .object({
            displayName: z
                .string()
                .trim()
                .min(2, "Nama tampilan minimal 2 karakter")
                .max(120, "Nama tampilan maksimum 120 karakter")
                .optional(),
            picCode: z
                .string()
                .trim()
                .min(3, "Kode minimal 3 karakter")
                .max(40, "Kode maksimum 40 karakter")
                .regex(
                    /^[A-Za-z0-9-]+$/,
                    "Kode hanya boleh huruf, angka, dan tanda hubung"
                )
                .optional(),
            defaultFeeRateBp: feeRateBpSchema.optional(),
        })
        .optional(),
});

export type CreateManagedUserInput = z.infer<typeof createManagedUserSchema>;

/** The PATCH /users/[id] contract: status only, in Phase 33. */
export const updateManagedUserSchema = z.object({
    disabled: z.boolean({ message: "Status aktif wajib diisi" }),
});

export type UpdateManagedUserInput = z.infer<typeof updateManagedUserSchema>;

/** The list contract for GET /users. */
export const listManagedUsersQuerySchema = z.object({
    role: z.enum(["MANAGER", "PIC"]).optional(),
    search: z.string().trim().max(120).optional(),
    page: z.coerce.number().int().min(1).optional(),
});

export type ListManagedUsersQuery = z.infer<typeof listManagedUsersQuerySchema>;
