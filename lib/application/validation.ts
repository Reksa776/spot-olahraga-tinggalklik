import { z } from "zod";

/**
 * ==========================================
 * PHASE 32 — APPLICATION CONTROL VALIDATION
 * ==========================================
 *
 * The request contracts for the two ADMIN-only application endpoints. They live here rather
 * than inline in the routes for the same reason every other ticketing surface does: the
 * schema is the ONLY input shape the service may see, so a field the schema does not declare
 * cannot reach a write (zod strips undeclared keys), and the contract can be tested without
 * a route.
 *
 * Deliberately absent: any field naming a storage path, a file name, a MIME type or a URL.
 * The logo's reference is produced server-side from the validated bytes — a client-supplied
 * `logoUrl` would be an arbitrary-content injection into every public page.
 */

/** Bounds are generous but finite: these strings are rendered on a public page. */
export const MAX_MAINTENANCE_MESSAGE_LENGTH = 500;
export const MAX_MAINTENANCE_ETA_LENGTH = 200;

/**
 * `PATCH /api/admin/settings/application`.
 *
 * `maintenanceMode` is REQUIRED (the caller states the availability they want, so an
 * accidental empty body cannot silently mean "off"), while the two message fields are
 * optional and explicitly nullable so an operator can clear a message they previously set.
 * An omitted field means "leave as is"; `null` means "clear"; a string means "set".
 */
export const maintenanceSettingsSchema = z.object({
    maintenanceMode: z.boolean(),
    maintenanceMessage: z
        .string()
        .trim()
        .max(MAX_MAINTENANCE_MESSAGE_LENGTH)
        .nullable()
        .optional(),
    maintenanceEtaMessage: z
        .string()
        .trim()
        .max(MAX_MAINTENANCE_ETA_LENGTH)
        .nullable()
        .optional(),
});

export type MaintenanceSettingsInput = z.infer<
    typeof maintenanceSettingsSchema
>;
