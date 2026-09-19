import { z } from "zod";

/**
 * ==========================================
 * EVENT / VENUE INPUT VALIDATION
 * ==========================================
 *
 * Brief §21: validate title, slug, description, date/time, sport id, venue id,
 * status transitions, image metadata, ownership. Zod is already the project's
 * validation library (`zod ^4`), so this reuses it rather than adding a second one.
 *
 * WHAT IS DELIBERATELY NOT ACCEPTED FROM THE CLIENT
 * -------------------------------------------------
 * There is no `organizerId`, no `status`, no `publishedAt`, no `slug` on create, and
 * no `createdByUserId` field in any schema below. Each of those is either derived
 * server-side from the authorized actor or refused outright, so a crafted payload
 * cannot assert ownership, publication authority, or a public URL. The schemas are
 * strict for that reason: an unknown key is a 400 rather than something silently
 * ignored and later misread as intent.
 *
 * Note the one place `slug` IS accepted — an explicit slug change on update — and
 * that it is structural validation only. Uniqueness is decided by the service against
 * the database, excluding the event being edited (§9 of the brief).
 */

/**
 * ISO date-time, parsed into a `Date`.
 *
 * Accepts the wire format only (an ISO string). A numeric timestamp is rejected so
 * seconds-vs-milliseconds ambiguity cannot silently shift an event by decades.
 */
const isoDateTime = z
    .string()
    .trim()
    .min(1, "Tanggal wajib diisi.")
    .transform((value, ctx) => {
        const parsed = new Date(value);

        if (Number.isNaN(parsed.getTime())) {
            ctx.addIssue({
                code: "custom",
                message: "Format tanggal tidak valid (gunakan ISO 8601).",
            });
            return z.NEVER;
        }

        return parsed;
    });

/**
 * An optional ISO date-time where **both** states must stay distinguishable.
 *
 * PHASE 12 FIX — `null` now means "clear this column", `undefined` still means "do not
 * touch it". Previously both `""` and `null` collapsed to `undefined`, so an organizer
 * could set a sales window but could never clear it: the form's empty input produced
 * `null`, the field was silently dropped by the update whitelist, and the old value
 * survived. Since the event form now exposes `salesStartAt` / `salesEndAt` / `endAt`,
 * that silent no-op had to be corrected. The semantics now match
 * `lib/ticket-types/validation.ts#optionalIsoDateTime`, which already separates the two.
 */
const optionalIsoDateTime = z
    .union([isoDateTime, z.literal(""), z.null()])
    .optional()
    .transform((value) =>
        value === "" || value === null ? null : value
    );

const optionalText = (max: number) =>
    z
        .union([z.string().trim().max(max), z.literal(""), z.null()])
        .optional()
        .transform((value) =>
            value === "" || value === null ? null : value
        );

/**
 * A date filter that accepts either an ISO string (the wire format) or a real `Date`
 * (what an internal caller naturally has). Both normalise to a `Date`, so downstream
 * query building never has to care which arrived.
 */
const filterDateTime = z
    .union([z.date(), isoDateTime, z.literal(""), z.null()])
    .optional()
    .transform((value) => (value === "" || value === null ? undefined : value));

/**
 * Visibility accepted by the API: exactly the two values design §10.2 defines
 * (`PUBLIC | UNLISTED`).
 *
 * `EventVisibility.PRIVATE` also exists in the Phase 2 enum, but the design never
 * defines what it does — is a PRIVATE event reachable by direct link, or not at all?
 * Accepting it would require inventing that answer, so it is refused at the edge and
 * is unreachable. Recorded in the Phase 4 report as an open question.
 */
const eventVisibility = z.enum(["PUBLIC", "UNLISTED"]);

const timezone = z.string().trim().min(1).max(64).optional();

/**
 * Cross-field sales-window rule, applied to both schemas.
 *
 * Design §10.2 defines the event window as the **default** that a ticket type inherits
 * (`null` salesStartAt = immediately after publish; `null` salesEndAt = until event
 * start). A contradictory pair is the only thing that is wrong here — absence is
 * legitimate — so only "end before start" is refused, exactly as the ticket-type schema
 * refuses it. The authoritative check against the *stored* value on update lives in the
 * service (a partial PATCH can move one end of the window without the other).
 */
function checkSalesWindow(
    value: { salesStartAt?: Date | null; salesEndAt?: Date | null },
    ctx: z.RefinementCtx
): void {
    const { salesStartAt, salesEndAt } = value;

    if (
        salesStartAt instanceof Date &&
        salesEndAt instanceof Date &&
        salesEndAt.getTime() < salesStartAt.getTime()
    ) {
        ctx.addIssue({
            code: "custom",
            path: ["salesEndAt"],
            message: "Waktu berakhir penjualan tidak boleh sebelum waktu mulai.",
        });
    }
}

export const createEventSchema = z
    .object({
        title: z.string().trim().min(3, "Judul minimal 3 karakter.").max(200),
        sportId: z.string().trim().min(1, "Cabang olahraga wajib dipilih."),
        venueId: z
            .union([z.string().trim().min(1), z.literal(""), z.null()])
            .optional()
            .transform((value) => (value ? value : null)),
        description: optionalText(20000),
        rules: optionalText(20000),
        bannerUrl: optionalText(2000),
        startAt: isoDateTime,
        endAt: optionalIsoDateTime,
        salesStartAt: optionalIsoDateTime,
        salesEndAt: optionalIsoDateTime,
        timezone,
        maxTicketsPerOrder: z.coerce
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .nullable(),
        requiresCheckIn: z.coerce.boolean().optional(),
        visibility: eventVisibility.optional(),
        contactName: optionalText(120),
        contactPhone: optionalText(40),
    })
    .strict()
    .superRefine(checkSalesWindow);

export type CreateEventInput = z.infer<typeof createEventSchema>;

/**
 * Update schema.
 *
 * Every field is optional, but at least one must be present — an empty PATCH is a
 * likely client bug and silently succeeding would make it invisible. `slug` is the
 * only caller-supplied identifier accepted, and only as a *request*: the service
 * re-checks it against the database excluding this event.
 */
export const updateEventSchema = z
    .object({
        title: z.string().trim().min(3).max(200).optional(),
        sportId: z.string().trim().min(1).optional(),
        venueId: z
            .union([z.string().trim().min(1), z.literal(""), z.null()])
            .optional()
            .transform((value) => (value === undefined ? undefined : value ? value : null)),
        description: optionalText(20000),
        rules: optionalText(20000),
        bannerUrl: optionalText(2000),
        startAt: isoDateTime.optional(),
        endAt: optionalIsoDateTime,
        salesStartAt: optionalIsoDateTime,
        salesEndAt: optionalIsoDateTime,
        timezone,
        maxTicketsPerOrder: z.coerce
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .nullable(),
        requiresCheckIn: z.coerce.boolean().optional(),
        visibility: eventVisibility.optional(),
        contactName: optionalText(120),
        contactPhone: optionalText(40),
        slug: z.string().trim().min(3).max(80).optional(),
    })
    .strict()
    .superRefine(checkSalesWindow)
    .refine((value) => Object.keys(value).length > 0, {
        message: "Tidak ada perubahan yang dikirim.",
    });

export type UpdateEventInput = z.infer<typeof updateEventSchema>;

/**
 * Event cancellation body.
 *
 * Only a reason is accepted. Nothing else about a cancellation is client-controlled:
 * the actor comes from the session, the tenant from the event row, and the timestamp
 * from the server. The reason is bounded free text so it can be shown to buyers on the
 * public page and recorded in the audit trail, and is optional because the design's
 * transition does not require one.
 */
export const cancelEventSchema = z
    .object({
        reason: z
            .union([z.string().trim().min(3).max(500), z.literal(""), z.null()])
            .optional()
            .transform((value) => (value ? value : null)),
    })
    .strict();

export type CancelEventInput = z.infer<typeof cancelEventSchema>;

/**
 * Manual completion body (Phase 15, P14-D05).
 *
 * Only an optional note is accepted. Nothing about the transition is client-controlled:
 * the actor comes from the session, the tenant from the event row, and `completedAt` from
 * the server clock. The note is bounded free text so it can be recorded in the audit
 * trail as the reason a human closed the event ("acara selesai lebih awal", "koreksi
 * jadwal", …). Strict, like every other mutation schema here, so an unknown key —
 * `status`, `completedAt`, `organizerId` — is a 400 rather than something silently read.
 */
export const completeEventSchema = z
    .object({
        note: z
            .union([z.string().trim().min(3).max(500), z.literal(""), z.null()])
            .optional()
            .transform((value) => (value ? value : null)),
    })
    .strict();

export type CompleteEventInput = z.infer<typeof completeEventSchema>;

/**
 * Catalog query parameters (design §25.2).
 *
 * `sort` is an enum, not a free string. Phase 0 finding S-8 was exactly this: a
 * client-supplied `sortBy` interpolated into SQL. An allow-list is the fix, and it is
 * enforced here as well as in the query builder.
 */
export const CATALOG_SORT_VALUES = [
    "startAt_asc",
    "price_asc",
    "price_desc",
    "newest",
] as const;

/**
 * NOTE: this schema is intentionally NOT `.strict()`.
 *
 * It validates query strings on a **public** endpoint, and share links legitimately
 * carry extra parameters (`?ref=`, `?pic=`, `utm_*` — design §10.6). Zod strips
 * unknown keys by default, so tracking parameters are ignored rather than producing a
 * 400 on a public catalog request. The security-relevant keys (`sort`, `limit`) are
 * still enumerated, and no query parameter can influence the hard-coded visibility
 * filter. Request bodies elsewhere remain strict.
 */
export const catalogQuerySchema = z
    .object({
        q: z.string().trim().max(120).optional(),
        sport: z.string().trim().max(80).optional(),
        city: z.string().trim().max(120).optional(),
        // Accepts a real `Date` as well as the wire-format string, so an internal
        // caller (a server component, a test) can pass either. The route always
        // supplies strings from the query string.
        dateFrom: filterDateTime,
        dateTo: filterDateTime,
        priceMax: z.coerce.number().min(0).optional(),
        /**
         * Accepts a real boolean as well as the query-string forms. A plain
         * `z.coerce.boolean()` would be wrong here: `Boolean("false")` is `true`, so
         * the string "false" would silently mean the opposite of what it says.
         */
        hasTickets: z
            .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
            .optional()
            .transform((value) =>
                value === undefined
                    ? undefined
                    : typeof value === "boolean"
                      ? value
                      : value === "true" || value === "1"
            ),
        sort: z.enum(CATALOG_SORT_VALUES).optional(),
        page: z.coerce.number().int().min(1).max(10_000).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
    });

export type CatalogQuery = z.infer<typeof catalogQuerySchema>;
