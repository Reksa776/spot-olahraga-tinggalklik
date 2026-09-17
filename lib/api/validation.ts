import { z } from "zod";

import { validationError } from "./response";

/**
 * Parse with a `VALIDATION_ERROR` on failure.
 *
 * Shared by every ticketing route. On failure it raises an `AppError` whose
 * `details.fields` names the offending paths, as design §25.1 requires ("details
 * names the offending fields"), so the UI can highlight the exact input instead of
 * showing one generic message.
 *
 * Living here rather than in a domain module keeps the error contract in one place:
 * a domain schema module should not need to know how validation failures are
 * delivered to a client.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);

    if (!result.success) {
        throw validationError(result.error.issues);
    }

    return result.data;
}
