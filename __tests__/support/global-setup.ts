import fs from "fs";
import path from "path";

import { PrismaClient } from "@prisma/client";

import { testDatabaseUrl } from "./test-database";

/**
 * ==========================================
 * GLOBAL SETUP — THE TEST DATABASE MUST EXIST AND BE MIGRATED
 * ==========================================
 *
 * Phase 22 Part 12. `jest.setup-env.ts` redirects every worker to `<appdb>_test`; this
 * runs once before them and refuses to start a run that would fail 60 suites with a
 * connection error nobody can read.
 *
 * The check is deliberately about MIGRATIONS rather than mere reachability: an empty
 * sibling database is reachable and would still fail every integration suite, on every
 * table. Comparing the applied-migration count against the migrations on disk catches
 * both "not created", "created but not migrated" and "migrated but behind".
 *
 * The failure message names the exact command to fix it, because a broken test
 * environment that does not say how to repair itself is a broken test environment.
 */

/** How many migrations this repository ships (directories containing a `migration.sql`). */
function migrationsOnDisk(): number {
    const dir = path.join(__dirname, "..", "..", "prisma", "migrations");

    return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                fs.existsSync(path.join(dir, entry.name, "migration.sql"))
        ).length;
}

export default async function globalSetup(): Promise<void> {
    const appUrl = process.env.DATABASE_URL;

    if (!appUrl) {
        throw new Error(
            "DATABASE_URL is not set, so the test database cannot be resolved. " +
                "Add it to .env (see .env.example)."
        );
    }

    const url = testDatabaseUrl(appUrl);
    const name = new URL(url).pathname.replace(/^\//, "");
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    const fix = `Run:  npm run test:db:setup   (creates and migrates '${name}')`;

    try {
        const [row] = await prisma.$queryRawUnsafe<{ c: bigint | number }[]>(
            `SELECT COUNT(*) AS c FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_prisma_migrations'`
        );

        if (Number(row?.c ?? 0) === 0) {
            throw new Error(
                `The test database '${name}' exists but is not migrated. ${fix}`
            );
        }

        const [applied] = await prisma.$queryRawUnsafe<{ c: bigint | number }[]>(
            `SELECT COUNT(*) AS c FROM _prisma_migrations WHERE finished_at IS NOT NULL`
        );

        const expected = migrationsOnDisk();

        if (Number(applied?.c ?? 0) < expected) {
            throw new Error(
                `The test database '${name}' is behind: ${Number(applied?.c ?? 0)} of ` +
                    `${expected} migrations applied. ${fix}`
            );
        }

        // Reachability of the APPLICATION database is checked too, but only as a warning:
        // `globalTeardown` and the `test:db:setup` script legitimately need it, and a run
        // that is isolated from it must still be allowed to proceed.
        try {
            const appPrisma = new PrismaClient({
                datasources: { db: { url: appUrl } },
            });
            await appPrisma.$queryRawUnsafe("SELECT 1");
            await appPrisma.$disconnect();
        } catch {
            console.warn(
                "[jest] the application database is not reachable; the test run is " +
                    "isolated from it and will continue."
            );
        }
    } catch (error) {
        // A connection failure (as opposed to a missing/migrated database) is the one case
        // where the database may simply not exist yet, so it gets the same fix hint.
        if (
            error instanceof Error &&
            !error.message.includes("npm run test:db:setup")
        ) {
            throw new Error(
                `${error.message}\n\n` +
                    `The Jest integration suites need a dedicated test database ` +
                    `'${name}' on the same server as DATABASE_URL — they must never run ` +
                    `against development data.\n${fix}`
            );
        }

        throw error;
    } finally {
        await prisma.$disconnect().catch(() => undefined);
    }
}
