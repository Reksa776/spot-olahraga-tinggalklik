import { z } from "zod";

/**
 * ==========================================
 * PHASE 13 — CHECK-IN INPUT VALIDATION
 * ==========================================
 *
 * WHAT THE CLIENT MAY SEND, AND WHAT IT MAY NOT
 * ---------------------------------------------
 * The gate may send only the presented code and non-authoritative scanner metadata
 * (`gateLabel`, `deviceId`, `clientScannedAt`). It may NOT send:
 *
 *   • `organizerId` — the tenant comes from the event row, which is authorized;
 *   • `eventId`     — the event comes from the ROUTE, and the ticket must match it;
 *   • `status`, `checkedInAt`, `checkedInByUserId` — the server decides every one of
 *     these from the CAS transition and the session, never from the body.
 *
 * `code` is bounded free text and deliberately NOT pattern-checked here. Design §20.2
 * check 1 says a malformed code and an unknown code must be INDISTINGUISHABLE, so both
 * are answered as `NOT_FOUND` by the service rather than one as a 400 and the other as a
 * 404 (which would let a caller probe the code space through the error shape).
 *
 * `clientScannedAt` is recorded for offline reconciliation only (design §20.1); it is
 * never used to decide anything — `CheckIn.checkedInAt` is the server clock.
 *
 * WHY AN EMPTY STRING NORMALISES TO `null`
 * ----------------------------------------
 * `z.literal("")` is a member of the unions below rather than an `.optional()` wrapper on
 * its own, so `gateLabel: ""` and `gateLabel: null` mean the same thing — "no label" —
 * and the service never stores an empty string where it means null. A MISSING key stays
 * `undefined` (that is what `.optional()` is for) and the service collapses it with `??
 * null`, so all three spellings of "not provided" end up identical in the database.
 */

/** `null` for an empty string or an explicit null; the value otherwise. */
const nullableMeta = (max: number) =>
    z
        .union([z.string().trim().max(max), z.literal(""), z.null()])
        .transform((value) => (value === "" || value === null ? null : value))
        .optional();

export const checkInRequestSchema = z
    .object({
        /** The presented code: `EVT-XXXX-XXXX`, or the wallet QR payload `TICKET:EVT-…`. */
        code: z.string().trim().min(1, "Kode tiket wajib diisi.").max(120),
        gateLabel: nullableMeta(60),
        deviceId: nullableMeta(120),
        /** Informational only. Accepts the wire format (an ISO string) or a real `Date`. */
        clientScannedAt: z
            .union([
                z.date(),
                z.string().trim().min(1).max(40),
                z.literal(""),
                z.null(),
            ])
            .transform((value, ctx) => {
                if (value === "" || value === null) {
                    return null;
                }

                if (value instanceof Date) {
                    return Number.isNaN(value.getTime()) ? null : value;
                }

                const parsed = new Date(value);

                if (Number.isNaN(parsed.getTime())) {
                    ctx.addIssue({
                        code: "custom",
                        path: ["clientScannedAt"],
                        message: "Format tanggal tidak valid.",
                    });
                    return z.NEVER;
                }

                return parsed;
            })
            .optional(),
    })
    .strict();

export type CheckInRequestInput = z.infer<typeof checkInRequestSchema>;

/** Query for the event's recent check-in list (the attendance view). */
export const checkInListQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
});

export type CheckInListQuery = z.infer<typeof checkInListQuerySchema>;
