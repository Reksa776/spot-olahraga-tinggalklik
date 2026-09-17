/**
 * ============================================================
 * SEED SPORT TAXONOMY — Ticketing Phase 2
 * ============================================================
 *
 * Seeds the controlled `Sport` taxonomy that replaces the free-text
 * `Product.category` field of the legacy retail domain.
 *
 * Design reference: TICKETING_PHASE1_DESIGN.md §10 (Sport replaces
 * `Product.category`, controlled master data) and §39.2 B12 (idempotent
 * seeds).
 *
 * Guarantees:
 *   - DETERMINISTIC : the list below is a fixed constant, no randomness,
 *                     no clock dependency, no network calls.
 *   - IDEMPOTENT    : keyed on the stable unique `slug`, so running it any
 *                     number of times converges to the same rows.
 *   - NO FIXTURES   : it seeds taxonomy only. No events, orders, payments,
 *                     tickets or users are created.
 *
 * The list is intentionally small and extensible: it covers the sports the
 * brief names plus the common community categories, and it is not a closed
 * enum — organizers can add more rows later without a migration.
 *
 * Run:
 *   npx tsx prisma/seed-sports.ts
 *   # or, when the schema under test lives on a scratch database:
 *   DATABASE_URL="mysql://.../scratch" npx tsx prisma/seed-sports.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SportSeed = {
    /** Stable unique key. Never change an existing slug — it is a URL segment. */
    slug: string;
    name: string;
    /** Lower number sorts first on the public catalog filter. */
    sortOrder: number;
};

const SPORTS: readonly SportSeed[] = [
    // --- Named by the TinggalKlik.Co requirement -----------------------
    { slug: "basketball", name: "Basketball", sortOrder: 10 },
    { slug: "badminton", name: "Badminton", sortOrder: 20 },
    { slug: "futsal", name: "Futsal", sortOrder: 30 },
    { slug: "volleyball", name: "Volleyball", sortOrder: 40 },
    { slug: "running", name: "Running", sortOrder: 50 },

    // --- Other sports / community categories ---------------------------
    { slug: "football", name: "Sepak Bola", sortOrder: 60 },
    { slug: "tennis", name: "Tenis", sortOrder: 70 },
    { slug: "table-tennis", name: "Tenis Meja", sortOrder: 80 },
    { slug: "swimming", name: "Renang", sortOrder: 90 },
    { slug: "cycling", name: "Sepeda", sortOrder: 100 },
    { slug: "martial-arts", name: "Bela Diri", sortOrder: 110 },
    { slug: "esports", name: "E-Sports", sortOrder: 120 },
    { slug: "fitness", name: "Yoga & Fitness", sortOrder: 130 },

    // --- Catch-all for community events that are not a single sport ----
    { slug: "other", name: "Lainnya", sortOrder: 999 },
];

async function main() {
    console.log("======================================");
    console.log("SEED SPORT TAXONOMY");
    console.log("======================================");
    console.log("");

    let created = 0;
    let updated = 0;

    for (const sport of SPORTS) {
        /*
         * Idempotency is keyed on `slug` (the only stable unique key).
         *
         * `update` deliberately touches ONLY `name`: `sortOrder` and
         * `isActive` are operator-managed after creation, so re-running this
         * seed must not undo an admin's reordering or a deliberate
         * deactivation. Re-running therefore converges to the same state
         * instead of resetting it.
         */
        const existing = await prisma.sport.findUnique({
            where: { slug: sport.slug },
            select: { id: true },
        });

        await prisma.sport.upsert({
            where: { slug: sport.slug },

            update: {
                name: sport.name,
            },

            create: {
                slug: sport.slug,
                name: sport.name,
                sortOrder: sport.sortOrder,
                isActive: true,
            },
        });

        if (existing) {
            updated++;
        } else {
            created++;
        }
    }

    const total = await prisma.sport.count();

    console.log(`Created : ${created}`);
    console.log(`Updated : ${updated}`);
    console.log(`Total   : ${total}`);
    console.log("");
    console.log("======================================");
    console.log("SEED SPORT TAXONOMY SELESAI");
    console.log("======================================");
}

main()
    .catch((error) => {
        console.error("");
        console.error("SPORT SEED ERROR:");
        console.error(error);

        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
