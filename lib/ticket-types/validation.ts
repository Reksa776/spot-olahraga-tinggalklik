import { z } from "zod";

/**
 * ==========================================
 * TICKET TYPE INPUT VALIDATION
 * ==========================================
 *
 * Brief §7 requires price/quota/sales-window validation; §8 requires that money use the
 * repository's existing representation with no floating-point arithmetic and no unsafe
 * coercion; §29 requires "no unsafe numeric coercion" as a security property.
 *
 * THE MONEY PROBLEM
 * -----------------
 * `TicketType.price` is `Decimal(14, 2)` in Prisma. The temptation is
 * `z.coerce.number()`, which is what brief §8's "do not introduce floating-point money
 * arithmetic" rules out: `Number("0.1")` is already inexact, and an amount that round
 * trips through a JS number can come back as `149999.99999999998`. So price is
 * **validated as a decimal STRING** and handed to Prisma as that same string — Prisma
 * binds a string to a `Decimal` column exactly, with no float in the path. `MAX_MONEY`
 * mirrors the column's precision, so a value the database cannot store is refused at
 * the edge with a field-scoped message instead of becoming a Prisma error.
 *
 * WHAT IS DELIBERATELY NOT ACCEPTED FROM THE CLIENT
 * -------------------------------------------------
 *   `sold`, `reserved`, `version`  — inventory counters and the optimistic-lock token.
 *                                    Accepting any of them would let a caller forge or
 *                                    corrupt inventory, which is the exact class of bug
 *                                    brief §11 exists to prevent. They are only ever
 *                                    moved by `lib/ticketing/inventory.ts`'s atomic
 *                                    statements.
 *   `currency`                     — the design marks it "reserved for future
 *                                    multi-currency; single value in MVP". Accepting a
 *                                    value would implement multi-currency by accident,
 *                                    so the column default (IDR) stands.
 *   `eventId`                      — the event comes from the route and is authorized;
 *                                    a body field would be a second, unauthorised path
 *                                    to ownership.
 *   `organizerId`                  — never authority (Phase 3 rule). Absent entirely.
 *
 * Both schemas are `.strict()`: an unknown key is a 400 rather than something ignored
 * and later misread as intent, matching the Phase 4 conventions.
 */

/** DECIMAL(14,2) — 12 integer digits and 2 decimals. */
const MAX_INTEGER_DIGITS = 12;
const MAX_SCALE = 2;

/** `10^12 - 0.01`, expressed as a string to avoid float rounding at the boundary. */
const MAX_MONEY = "999999999999.99";

/** Largest quota accepted. Generous, but bounded so a typo cannot store 2^31. */
const MAX_QUOTA = 10_000_000;

const MONEY_SHAPE = new RegExp(
    `^\\d{1,${MAX_INTEGER_DIGITS}}(\\.\\d{1,${MAX_SCALE}})?$`
);

const INTEGER_SHAPE = /^\d+$/;

function asTrimmedString(value: unknown): string | null {
    if (typeof value === "string") {
        return value.trim();
    }

    if (typeof value === "number") {
        // `Number` -> string is exact for the shapes we accept and produces scientific
        // notation for anything extreme (`1e21`), which the shape check then rejects —
        // precisely the "unsafe coercion" outcome we want rather than a silent accept.
        return Number.isFinite(value) ? String(value) : null;
    }

    return null;
}

/**
 * A non-negative monetary amount, normalised to a canonical decimal string.
 *
 * Rejects: negatives, empty strings, whitespace, grouping separators, comma decimals,
 * scientific notation, more than 2 decimal places, and anything exceeding the column's
 * precision. The rejection messages are field-scoped so the UI can attach them.
 */
const moneyAmount = z
    .unknown()
    .superRefine((value, ctx) => {
        const raw = asTrimmedString(value);

        if (raw === null || raw.length === 0) {
            ctx.addIssue({ code: "custom", message: "Harga wajib diisi." });
            return;
        }

        if (raw.startsWith("-")) {
            ctx.addIssue({ code: "custom", message: "Harga tidak boleh negatif." });
            return;
        }

        if (!MONEY_SHAPE.test(raw)) {
            ctx.addIssue({
                code: "custom",
                message: `Harga harus berupa angka dengan maksimal ${MAX_SCALE} desimal.`,
            });
            return;
        }

        // Compare exactly as decimals: pad to a fixed scale so string comparison is
        // a correct numeric comparison (no floats involved).
        const [whole, fraction = ""] = raw.split(".");
        const padded = `${whole.padStart(MAX_INTEGER_DIGITS + 1, "0")}.${fraction.padEnd(
            MAX_SCALE,
            "0"
        )}`;
        const limit = `${MAX_MONEY.split(".")[0].padStart(
            MAX_INTEGER_DIGITS + 1,
            "0"
        )}.${MAX_MONEY.split(".")[1]}`;

        if (padded > limit) {
            ctx.addIssue({
                code: "custom",
                message: "Harga melebihi batas maksimum.",
            });
        }
    })
    .transform((value) => {
        const raw = asTrimmedString(value) as string;
        const [whole, fraction = ""] = raw.split(".");

        // Canonicalise so `1500`, `1500.0` and `1500.00` are the same stored value and
        // the audit log's before/after comparison is not fooled by formatting. The
        // fraction is ALWAYS padded to the column's scale, so a whole amount becomes
        // `150000.00` rather than staying `150000` — otherwise two callers writing the
        // same amount would produce two different strings and a before/after audit
        // diff would report a price change that never happened.
        const normalisedWhole = whole.replace(/^0+(?=\d)/, "");

        return `${normalisedWhole}.${fraction.padEnd(MAX_SCALE, "0")}`;
    });

/**
 * A non-negative integer from a JSON number or a numeric string.
 *
 * `z.coerce.number()` is deliberately NOT used: it maps `""` to `0`, so an empty form
 * field would silently mean "zero quota" instead of failing. Shape-checking the string
 * rejects "", "  ", "1.5", "-1", "1e3", "0x10" and "1,000" explicitly.
 */
const nonNegativeInteger = z
    .unknown()
    .superRefine((value, ctx) => {
        const raw = asTrimmedString(value);

        if (raw === null || raw.length === 0) {
            ctx.addIssue({ code: "custom", message: "Nilai wajib diisi." });
            return;
        }

        if (!INTEGER_SHAPE.test(raw)) {
            ctx.addIssue({
                code: "custom",
                message: "Nilai harus berupa bilangan bulat.",
            });
        }
    })
    .transform((value) => Number(asTrimmedString(value)));

const quotaValue = nonNegativeInteger.refine(
    (value) => value <= MAX_QUOTA,
    `Kuota maksimal ${MAX_QUOTA}.`
);

const optionalText = (max: number) =>
    z
        .union([z.string().trim().max(max), z.literal(""), z.null()])
        .optional()
        .transform((value) => (value === "" || value === null ? null : value));

/**
 * ISO date-time, parsed into a `Date`.
 *
 * Mirrors `lib/events/validation.ts`: the wire format only, so a numeric epoch cannot
 * be silently interpreted in the wrong unit.
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

const optionalIsoDateTime = z
    .union([z.date(), isoDateTime, z.literal(""), z.null()])
    .optional()
    .transform((value) => (value === "" || value === null ? null : value));

/**
 * The same rule for CREATE, where absence is an explicit "inherit the event's window".
 *
 * The distinction matters and is deliberate: on UPDATE, `undefined` means "do not touch
 * this column" and `null` means "clear it", so the two states must stay separable —
 * that is what `optionalIsoDateTime` preserves. On CREATE there is no prior value to
 * preserve, so an omitted window is stated as `null` rather than left ambiguous.
 */
const createIsoDateTime = z
    .union([z.date(), isoDateTime, z.literal(""), z.null()])
    .optional()
    .transform((value) =>
        value === "" || value === null || value === undefined ? null : value
    );

/**
 * Cross-field rules, applied to both schemas so create and update cannot diverge.
 *
 * Design §10.2's window semantics: a null `salesStartAt`/`salesEndAt` inherits the
 * event's window, so an absent value is legitimate and only a *contradictory* pair is
 * an error.
 */
type WindowFields = {
    salesStartAt?: Date | null;
    salesEndAt?: Date | null;
    minPerOrder?: number;
    maxPerOrder?: number | null | undefined;
};

function checkWindowAndOrdering(
    value: WindowFields,
    ctx: z.RefinementCtx
): void {
    const { salesStartAt, salesEndAt, minPerOrder, maxPerOrder } = value;

    if (
        salesStartAt &&
        salesEndAt &&
        salesEndAt.getTime() < salesStartAt.getTime()
    ) {
        ctx.addIssue({
            code: "custom",
            path: ["salesEndAt"],
            message: "Waktu berakhir penjualan tidak boleh sebelum waktu mulai.",
        });
    }

    if (
        typeof minPerOrder === "number" &&
        minPerOrder < 1
    ) {
        ctx.addIssue({
            code: "custom",
            path: ["minPerOrder"],
            message: "Minimal pembelian per order adalah 1.",
        });
    }

    if (
        typeof minPerOrder === "number" &&
        typeof maxPerOrder === "number" &&
        maxPerOrder < minPerOrder
    ) {
        ctx.addIssue({
            code: "custom",
            path: ["maxPerOrder"],
            message: `Maksimal pembelian tidak boleh kurang dari minimal (${minPerOrder}).`,
        });
    }
}

export const createTicketTypeSchema = z
    .object({
        name: z.string().trim().min(2, "Nama jenis tiket minimal 2 karakter.").max(120),
        description: optionalText(5000),
        price: moneyAmount,
        quota: quotaValue,
        minPerOrder: nonNegativeInteger.optional(),
        maxPerOrder: z
            .union([nonNegativeInteger, z.literal(""), z.null()])
            .optional()
            .transform((value) => (value === "" || value === null ? null : value)),
        salesStartAt: createIsoDateTime,
        salesEndAt: createIsoDateTime,
        isActive: z.boolean().optional(),
        sortOrder: nonNegativeInteger.optional(),
    })
    .strict()
    .superRefine(checkWindowAndOrdering);

export type CreateTicketTypeInput = z.infer<typeof createTicketTypeSchema>;

/**
 * Update schema.
 *
 * Every field optional, but at least one must be present — an empty PATCH is far more
 * likely a client bug than an intent, and silently succeeding would hide it.
 *
 * `quota` and `price` are each independently gated by their own permission in the
 * service (`ticket_type.quota.change` / `ticket_type.price.change`), which is the
 * separation of duties Phase 3 encoded. They are accepted here so the request shape is
 * uniform; the *authorization* difference is enforced in one place, not in the schema.
 */
export const updateTicketTypeSchema = z
    .object({
        name: z.string().trim().min(2).max(120).optional(),
        description: optionalText(5000),
        price: moneyAmount.optional(),
        quota: quotaValue.optional(),
        minPerOrder: nonNegativeInteger.optional(),
        maxPerOrder: z
            .union([nonNegativeInteger, z.literal(""), z.null()])
            .optional()
            .transform((value) => (value === "" || value === null ? null : value)),
        salesStartAt: optionalIsoDateTime,
        salesEndAt: optionalIsoDateTime,
        isActive: z.boolean().optional(),
        sortOrder: nonNegativeInteger.optional(),
    })
    .strict()
    .superRefine(checkWindowAndOrdering)
    .refine((value) => Object.keys(value).length > 0, {
        message: "Tidak ada perubahan yang dikirim.",
    });

export type UpdateTicketTypeInput = z.infer<typeof updateTicketTypeSchema>;

export const TICKET_TYPE_LIMITS = {
    MAX_INTEGER_DIGITS,
    MAX_SCALE,
    MAX_MONEY,
    MAX_QUOTA,
} as const;
