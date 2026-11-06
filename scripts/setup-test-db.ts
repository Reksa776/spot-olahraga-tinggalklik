/**
 * Read-only verification for the explicitly configured Jest test schema.
 *
 * This script deliberately does not create schemas, apply migrations, seed fixtures, or
 * open DATABASE_URL. Provision the isolated database through an approved operator workflow.
 */
import "dotenv/config";

import fs from "node:fs";

import { PrismaClient } from "@prisma/client";

import { resolveTestDatabaseUrl } from "../__tests__/support/test-database";

async function main(): Promise<void> {
    const url = resolveTestDatabaseUrl(process.env);
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    const prisma = new PrismaClient({ datasources: { db: { url } } });

    try {
        const [migrationTable] = await prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
            `SELECT COUNT(*) AS count FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '_prisma_migrations'`
        );
        if (Number(migrationTable?.count ?? 0) === 0) {
            throw new Error(`TEST_DATABASE_URL '${databaseName}' is not migrated.`);
        }

        const [appliedMigrations] = await prisma.$queryRawUnsafe<{ count: bigint | number }[]>(
            `SELECT COUNT(*) AS count FROM _prisma_migrations WHERE finished_at IS NOT NULL`
        );
        const migrationDirectories = fs
            .readdirSync("prisma/migrations", { withFileTypes: true })
            .filter((entry) =>
                entry.isDirectory() &&
                fs.existsSync(`prisma/migrations/${entry.name}/migration.sql`)
            ).length;
        if (Number(appliedMigrations?.count ?? 0) < migrationDirectories) {
            throw new Error(
                `TEST_DATABASE_URL '${databaseName}' has ${Number(appliedMigrations?.count ?? 0)} of ${migrationDirectories} migrations applied.`
            );
        }

        console.log(`Verified isolated test schema '${databaseName}'. No data was changed.`);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch((error: unknown) => {
    console.error("Test database verification failed:", error);
    process.exitCode = 1;
});
