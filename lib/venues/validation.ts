import { z } from "zod";

/**
 * ==========================================
 * VENUE INPUT VALIDATION
 * ==========================================
 *
 * Note what is absent: there is no `organizerId` field. A venue's ownership class is
 * decided by the **route** (the organizer back office always creates a private venue;
 * the platform admin surface creates a global one) and then authorized by
 * `requireVenueCreate`, so a caller cannot choose its own ownership — which is what
 * stops an organizer member from minting a platform-global venue, or from attaching a
 * venue to somebody else's tenant (decision D-64).
 */

const optionalText = (max: number) =>
    z
        .union([z.string().trim().max(max), z.literal(""), z.null()])
        .optional()
        .transform((value) => (value === "" || value === null ? null : value));

export const createVenueSchema = z
    .object({
        name: z
            .string()
            .trim()
            .min(2, "Nama venue minimal 2 karakter.")
            .max(160),
        address: optionalText(600),
        city: optionalText(120),
        province: optionalText(120),
        // Bounded to real coordinates so a typo cannot store an impossible point.
        latitude: z.coerce.number().min(-90).max(90).optional().nullable(),
        longitude: z.coerce.number().min(-180).max(180).optional().nullable(),
        capacity: z.coerce
            .number()
            .int()
            .min(0)
            .max(1_000_000)
            .optional()
            .nullable(),
    })
    .strict();

export type CreateVenueInput = z.infer<typeof createVenueSchema>;

export const updateVenueSchema = createVenueSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
        message: "Tidak ada perubahan yang dikirim.",
    });

export type UpdateVenueInput = z.infer<typeof updateVenueSchema>;
