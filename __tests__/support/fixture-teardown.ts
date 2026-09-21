import { PrismaClient } from "@prisma/client";

import { testDatabaseUrl } from "./test-database";

/**
 * ==========================================
 * GLOBAL FIXTURE TEARDOWN — NO GHOST DATA ON A PUBLIC SURFACE
 * ==========================================
 *
 * The public landing showed `P6 …` / `P7 …` events and sports that no operator could find in the
 * dashboard. They were integration-test fixtures: the suites create real organizers, sports and
 * events, publish them through the REAL services, and clean up in `afterAll` / inline. That is
 * correct — but inline cleanup only runs when a test REACHES it, and this repository's ticketing
 * integration suites currently fail in a plain environment (leftover settlement rows), so tests
 * abort mid-body and their fixtures are stranded. A stranded event is `PUBLISHED + PUBLIC`, which
 * is exactly what the catalog serves to anonymous visitors; a stranded sport is `isActive: true`,
 * which is exactly what the landing's sport grid lists.
 *
 * This teardown is the safety net. It runs ONCE after every Jest run and neutralises any fixture
 * that survived, using the DOMAIN's own "retire" operations — never a delete:
 *
 *   stranded fixture EVENT  -> archived  (status ARCHIVED + archivedAt; hidden from every public
 *                                          surface, financial rows untouched)
 *   stranded fixture SPORT  -> deactivated (`isActive: false`, the documented way to retire a
 *                                          sport; `listPublicSports` excludes it)
 *
 * Identification is deliberately narrow — BOTH a reserved slug prefix AND a reserved email domain
 * for organizers, and only the reserved test-sport prefixes. It cannot touch a real tenant, a real
 * sport, or any financial row. It never deletes, never resets, never truncates.
 *
 * ── WHY IT SWEEPS TWO DATABASES (Phase 22 Part 12) ─────────────────────────────
 * Jest now runs against `<appdb>_test`, so that is where NEW fixtures land. The development
 * database is still swept as well, because it holds residue from every run that predates the
 * isolation — and every one of those stranded events is one careless query away from being
 * listed publicly again. Neutralising both is idempotent and costs one connection.
 *
 * Failures are swallowed: this runs after the tests that matter, and a database hiccup must not
 * turn a passing suite red.
 */

/** Organizer slugs created only by fixtures. */
const FIXTURE_ORGANIZER_PREFIXES = ["p6-org-", "p6c-org-", "p7-org-"] as const;

/** Sport slugs created only by fixtures. */
const FIXTURE_SPORT_PREFIXES = [
    "p6-sport-",
    "p6c-sport-",
    "p7-sport-",
    "catalog-sport-",
    "other-sport-",
] as const;

/** The reserved domain every fixture user (and therefore organizer owner) is given. */
const FIXTURE_EMAIL_DOMAIN = "@example.test";

/** Neutralise stranded fixtures in one database. */
async function neutralize(url: string): Promise<void> {
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        const now = new Date();

        // A fixture organizer must satisfy BOTH signals: a reserved slug prefix and an owner on the
        // reserved test domain. Either alone could in principle collide with real data; together
        // they cannot.
        const organizers = await prisma.organizer.findMany({
            where: {
                OR: FIXTURE_ORGANIZER_PREFIXES.map((prefix) => ({
                    slug: { startsWith: prefix },
                })),
                owner: { email: { endsWith: FIXTURE_EMAIL_DOMAIN } },
            },
            select: { id: true },
        });

        const organizerIds = organizers.map((organizer) => organizer.id);

        if (organizerIds.length > 0) {
            // Archive, never delete: an event with a stranded order or payment keeps its rows.
            await prisma.event.updateMany({
                where: { organizerId: { in: organizerIds }, archivedAt: null },
                data: { status: "ARCHIVED", archivedAt: now },
            });
        }

        await prisma.sport.updateMany({
            where: {
                OR: FIXTURE_SPORT_PREFIXES.map((prefix) => ({ slug: { startsWith: prefix } })),
                isActive: true,
            },
            data: { isActive: false },
        });
    } finally {
        await prisma.$disconnect().catch(() => undefined);
    }
}

export default async function globalTeardown(): Promise<void> {
    const appUrl = process.env.DATABASE_URL;

    if (!appUrl) {
        return;
    }

    // The test database first (where this run's fixtures are), then the application database
    // (where the earlier runs' fixtures are). Deduplicated so pointing Jest at the application
    // database deliberately still sweeps it exactly once.
    const targets = Array.from(
        new Set([testDatabaseUrl(appUrl), appUrl])
    );

    for (const url of targets) {
        const name = new URL(url).pathname.replace(/^\//, "");

        try {
            await neutralize(url);
        } catch (error) {
            // The tests already ran; cleanup must not fail the process.
            console.warn(
                `[fixture-teardown] skipped '${name}': ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }
}
