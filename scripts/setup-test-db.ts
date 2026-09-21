/**
 * ==========================================
 * SET UP THE DEDICATED JEST DATABASE
 * ==========================================
 *
 * Run:  npm run test:db:setup
 *
 * Creates `<DATABASE_URL database>_test` on the same server, with the same charset and
 * collation as the application database, applies every migration to it, and applies the
 * baseline taxonomy seed. After this one command, `npx jest` runs entirely against that
 * database and never writes to development data.
 *
 * Idempotent, at all three steps: `CREATE DATABASE IF NOT EXISTS`, `prisma migrate deploy`,
 * and a seed that is keyed on the stable `Sport.slug`. Running it again brings a behind
 * database up to date and does nothing otherwise. It never drops, truncates or resets
 * anything — on either database.
 *
 * ── WHY THE SEED IS PART OF PROVISIONING ────────────────────────────────────────
 * Several suites assert against the Phase 2 sport taxonomy as BASELINE data (the public
 * catalogue test requires the seeded sports to still be listed). A freshly migrated
 * database has none, so without this step isolation would trade ghost fixtures for broken
 * suites. `prisma/seed-sports.ts` is deterministic, idempotent, and creates taxonomy only
 * — no events, orders, payments, tickets or users — which is exactly the prerequisite the
 * suites assume.
 *
 * ── WHY IT DOES NOT PRINT THE URL ───────────────────────────────────────────────
 * `DATABASE_URL` carries the database password. The name is printed; the credentials are
 * not.
 */

import "dotenv/config";

import { execFileSync } from "node:child_process";

import { PrismaClient } from "@prisma/client";

import { testDatabaseUrl } from "../__tests__/support/test-database";

async function main() {
    const appUrl = process.env.DATABASE_URL;

    if (!appUrl) {
        console.error(
            "DATABASE_URL is not set. Add it to .env before provisioning the test database."
        );
        process.exit(1);
    }

    const url = testDatabaseUrl(appUrl);
    const testDb = new URL(url).pathname.replace(/^\//, "");
    const appDb = new URL(appUrl).pathname.replace(/^\//, "");

    console.log(`application database : ${appDb}`);
    console.log(`test database        : ${testDb}`);

    const prisma = new PrismaClient();

    try {
        // Match the application database's charset/collation exactly. A test schema with a
        // different collation would sort and compare differently, and the suites assert on
        // ordering and on unique-constraint behaviour.
        const [schema] = await prisma.$queryRawUnsafe<
            { cs: string; coll: string }[]
        >(
            `SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS coll
             FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?`,
            appDb
        );

        const cs = schema?.cs ?? "utf8mb4";
        const coll = schema?.coll ?? "utf8mb4_unicode_ci";

        if (!schema) {
            console.error(
                `The application database '${appDb}' does not exist, so its charset cannot ` +
                    `be copied. Create it first (npx prisma migrate deploy).`
            );
            process.exit(1);
        }

        await prisma.$executeRawUnsafe(
            `CREATE DATABASE IF NOT EXISTS \`${testDb}\` ` +
                `CHARACTER SET ${cs} COLLATE ${coll}`
        );

        console.log(`ensured database exists (charset ${cs}, collation ${coll})`);
    } finally {
        await prisma.$disconnect();
    }

    // Migrate it. The CLI is the only supported way to apply the migration history, and it
    // is pointed at the test database through the environment — not by editing .env.
    console.log("\napplying migrations…\n");

    execFileSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["prisma", "migrate", "deploy"],
        {
            stdio: "inherit",
            env: { ...process.env, DATABASE_URL: url },
        }
    );

    // The baseline taxonomy the integration suites assume exists. `prisma/seed-sports.ts`
    // documents this scratch-database invocation itself.
    console.log("\nseeding baseline taxonomy…\n");

    execFileSync(
        process.platform === "win32" ? "npx.cmd" : "npx",
        ["tsx", "prisma/seed-sports.ts"],
        {
            stdio: "inherit",
            env: { ...process.env, DATABASE_URL: url },
        }
    );

    console.log(
        `\nDone. 'npx jest' now runs against '${testDb}'; '${appDb}' is untouched.`
    );
}

main().catch((error) => {
    console.error("Failed to set up the test database:", error);
    process.exit(1);
});
