/**
 * ============================================================
 * SEED ORGANIZER + PLATFORM ADMIN MEMBERSHIP — bootstrap
 * ============================================================
 *
 * TinggalKlik.Co launches with a SINGLE organizer (decision D-05). The
 * authorization layer (`lib/authz`) deliberately requires an **ACTIVE
 * `OrganizerMember` row** before any tenant-scoped capability resolves — a
 * platform role alone confers no tenant data (see `lib/authz/permissions.ts`,
 * "THE INTERSECTION RULE", and the pinned test
 * `__tests__/auth-flow/dashboard-access.integration.test.ts`). The design's
 * Phase 2 deliverable B12 ("one Organizer (TinggalKlik.Co)") was never seeded,
 * so the platform ADMIN had no tenant scope and the dashboard correctly showed
 * only its platform menus.
 *
 * This script closes that gap. It is the documented bootstrap for the
 * single-organizer launch:
 *
 *   1. Ensure the sole organizer (slug `tinggalklik`) exists, owned by the
 *      OLDEST platform `ADMIN` account.
 *   2. Ensure every `platformRole = ADMIN` account has an ACTIVE `OWNER`
 *      `OrganizerMember` row for that organizer — the "scope" half of the
 *      intersection rule. Capability still comes from the existing maps; no
 *      permission is granted here that the maps do not already define.
 *
 * It does NOT touch `User.role` (legacy retail, dormant), does NOT create
 * events/orders/tickets, and does NOT grant financial permissions — those stay
 * behind `ADMIN_GRANT_REQUIRED` and are unaffected by an OWNER membership.
 *
 * Guarantees:
 *   - DETERMINISTIC : no randomness, no clock dependency, no network calls.
 *   - IDEMPOTENT    : keyed on `Organizer.slug` and the
 *                     `OrganizerMember @@unique([organizerId, userId])`. Running
 *                     it any number of times converges to the same rows.
 *   - NON-DESTRUCTIVE: an EXISTING organizer or membership is never modified, so
 *                     an operator's later edits (renamed organizer, changed
 *                     role, deliberate revocation) survive a re-run.
 *
 * Run:
 *   npx tsx prisma/seed-organizer.ts
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** Stable unique key. Never change it — it is a URL segment. */
const ORGANIZER_SLUG = "tinggalklik";
const ORGANIZER_NAME = "TinggalKlik.Co";

async function main() {
    console.log("======================================");
    console.log("SEED ORGANIZER + ADMIN MEMBERSHIP");
    console.log("======================================");
    console.log("");

    /*
     * The owner is the OLDEST platform ADMIN. Ordering by `createdAt` (then
     * `id`, for a total order on ties) makes the choice deterministic, so two
     * operators running this concurrently agree on the same owner.
     */
    const admins = await prisma.user.findMany({
        where: { platformRole: "ADMIN" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, email: true },
    });

    if (admins.length === 0) {
        throw new Error(
            "No user with platformRole = ADMIN was found. Promote an account to " +
                "platformRole ADMIN first, then re-run this seed."
        );
    }

    const owner = admins[0];

    const existingOrganizer = await prisma.organizer.findUnique({
        where: { slug: ORGANIZER_SLUG },
        select: { id: true, name: true },
    });

    const organizer =
        existingOrganizer ??
        (await prisma.organizer.create({
            data: {
                ownerUserId: owner.id,
                name: ORGANIZER_NAME,
                slug: ORGANIZER_SLUG,
                status: "ACTIVE",
                verifiedAt: new Date(),
            },
            select: { id: true, name: true },
        }));

    if (existingOrganizer) {
        console.log(`Organizer : existing (${organizer.name})`);
    } else {
        console.log(`Organizer : created ${organizer.name}`);
    }

    let membershipsCreated = 0;
    let membershipsExisting = 0;

    for (const admin of admins) {
        const existing = await prisma.organizerMember.findUnique({
            where: {
                organizerId_userId: {
                    organizerId: organizer.id,
                    userId: admin.id,
                },
            },
            select: { id: true },
        });

        if (existing) {
            membershipsExisting++;
            continue;
        }

        await prisma.organizerMember.create({
            data: {
                organizerId: organizer.id,
                userId: admin.id,
                role: "OWNER",
                status: "ACTIVE",
                invitedByUserId: owner.id,
                invitedAt: new Date(),
                acceptedAt: new Date(),
            },
        });

        membershipsCreated++;
    }

    console.log(`Admin(s)  : ${admins.length}`);
    console.log(`Memberships created  : ${membershipsCreated}`);
    console.log(`Memberships existing : ${membershipsExisting}`);
    console.log("");
    console.log("======================================");
    console.log("SEED ORGANIZER + ADMIN MEMBERSHIP SELESAI");
    console.log("======================================");
}

main()
    .catch((error) => {
        console.error("");
        console.error("ORGANIZER SEED ERROR:");
        console.error(error);

        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
