import { z } from "zod";

/**
 * ==========================================
 * SPORT MASTER-DATA VALIDATION
 * ==========================================
 *
 * `Sport` is platform master data (design §10.2: "controlled master data, not free
 * text — replaces `Product.category`"). It is the category facet of the public
 * catalog, so its values must stay curated: the public filter is a slug, and a
 * free-text category would make the facet unpredictable.
 */

const optionalText = (max: number) =>
    z
        .union([z.string().trim().max(max), z.literal(""), z.null()])
        .optional()
        .transform((value) => (value === "" || value === null ? null : value));

export const createSportSchema = z
    .object({
        name: z.string().trim().min(2, "Nama cabang olahraga minimal 2 karakter.").max(120),
        /**
         * Optional. When omitted the service derives it from the name with the same
         * normalisation used for event slugs, so a sport added through the admin
         * surface cannot produce an un-URL-safe facet value.
         */
        slug: z
            .string()
            .trim()
            .min(2)
            .max(80)
            .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug tidak valid.")
            .optional(),
        iconUrl: optionalText(2000),
        sortOrder: z.coerce.number().int().min(0).max(10_000).optional(),
        isActive: z.coerce.boolean().optional(),
    })
    .strict();

export type CreateSportInput = z.infer<typeof createSportSchema>;

export const updateSportSchema = createSportSchema
    .partial()
    .refine((value) => Object.keys(value).length > 0, {
        message: "Tidak ada perubahan yang dikirim.",
    });

export type UpdateSportInput = z.infer<typeof updateSportSchema>;
