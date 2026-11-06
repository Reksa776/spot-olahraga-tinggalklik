import fs from "fs";
import path from "path";

import { PrismaClient } from "@prisma/client";

import { resolveTestDatabaseUrl } from "./test-database";

/**
 * ==========================================
 * GLOBAL SETUP — THE TEST DATABASE MUST EXIST AND BE MIGRATED
 * ==========================================
 *
 * Phase 0A. `jest.setup-env.ts` redirects every worker to the explicitly configured
 * `TEST_DATABASE_URL`; this runs once before them and refuses to start a run that would
 * fail dozens of suites with a connection error nobody can read.
 *
 * The URL is resolved by `resolveTestDatabaseUrl`, which fails closed when the test target is
 * missing, malformed, ambiguous, or equal to the application database. Only that resolved URL
 * is ever used to build a client; the application database is never probed.
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
    const url = resolveTestDatabaseUrl(process.env);
    const name = decodeURIComponent(new URL(url).pathname.slice(1));
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    const fix =
        `Create the isolated schema '${name}', apply migrations to it, then run:  ` +
        `npm run test:db:setup   (verifies it read-only)`;

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

    } catch (error) {
        // A connection failure (as opposed to a missing/migrated database) is the one case
        // where the database may simply not exist yet, so it gets the same fix hint.
        if (
            error instanceof Error &&
            !error.message.includes("npm run test:db:setup")
        ) {
            throw new Error(
                `${error.message}\n\n` +
                    `The Jest integration suites need an explicitly configured isolated ` +
                    `TEST_DATABASE_URL; no application database fallback is allowed.\n${fix}`
            );
        }

        throw error;
    } finally {
        await prisma.$disconnect().catch(() => undefined);
    }
}
