import { AppError } from "@/lib/api/errors";
import { PERMISSIONS, requirePlatformPermission, type AuthzScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import { slugify } from "@/lib/events/slug";

import type { CreateSportInput, UpdateSportInput } from "./validation";

/**
 * ==========================================
 * SPORT SERVICE
 * ==========================================
 *
 * `Sport` is the catalog's category facet. Brief §15 requires that the Phase 2 seeded
 * taxonomy be reused rather than duplicated, that `prisma/seed-sports.ts` keep its
 * deterministic/idempotent behaviour, and that arbitrary users not be able to mutate
 * platform master data.
 *
 * Management therefore requires the **platform-scope** `sport.manage` permission,
 * which only `ADMIN` holds (design §6.3). No organizer membership grants it, so an
 * organizer MANAGER or OWNER cannot edit the platform taxonomy from inside their
 * tenant — a deliberate separation between tenant operations and platform master data.
 *
 * This service does not seed. Seeding stays in `prisma/seed-sports.ts`, exactly as the
 * brief requires, so there is no second source of truth for the taxonomy.
 */

const SPORT_SELECT = {
    id: true,
    name: true,
    slug: true,
    iconUrl: true,
    isActive: true,
    sortOrder: true,
    createdAt: true,
    updatedAt: true,
    _count: { select: { events: true } },
} as const;

/**
 * Public sport list for the catalog filter.
 *
 * Unauthenticated. Returns ACTIVE sports only — a deactivated sport must not appear as
 * a selectable facet — and only public-facing fields, so internal counters
 * (`_count.events`) and timestamps do not leak.
 */
export async function listPublicSports() {
    const sports = await prisma.sport.findMany({
        where: { isActive: true },
        select: { id: true, name: true, slug: true, iconUrl: true, sortOrder: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    return { items: sports };
}

/** Admin view: every sport, including deactivated ones, with usage counts. */
export async function listSportsForAdmin(scope: AuthzScope) {
    await requirePlatformPermission(PERMISSIONS.SPORT_MANAGE);

    const sports = await prisma.sport.findMany({
        select: SPORT_SELECT,
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    return {
        items: sports.map((sport) => ({
            ...sport,
            eventCount: sport._count.events,
        })),
    };
}

/** Derive a slug from the name, or validate the supplied one, then ensure uniqueness. */
async function resolveSportSlug(
    name: string,
    requested: string | undefined,
    excludeSportId?: string
): Promise<string> {
    const candidate = requested ?? slugify(name);

    if (candidate.length === 0) {
        throw AppError.validation("Slug cabang olahraga tidak valid.");
    }

    const clash = await prisma.sport.findUnique({
        where: { slug: candidate },
        select: { id: true },
    });

    if (clash && clash.id !== excludeSportId) {
        throw AppError.conflict("Slug cabang olahraga sudah digunakan.", {
            fields: [{ path: "slug", message: "Sudah digunakan." }],
        });
    }

    return candidate;
}

export async function createSport(
    scope: AuthzScope,
    input: CreateSportInput,
    request?: Request
) {
    const authorized = await requirePlatformPermission(PERMISSIONS.SPORT_MANAGE);

    const slug = await resolveSportSlug(input.name, input.slug);

    const sport = await prisma.sport.create({
        data: {
            name: input.name,
            slug,
            iconUrl: input.iconUrl ?? null,
            ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        },
        select: SPORT_SELECT,
    });

    await writeTicketingAudit({
        action: "sport.create",
        actor: authorized,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "Sport",
        entityRef: sport.id,
        description: `Cabang olahraga dibuat: ${sport.name}`,
        afterState: { name: sport.name, slug: sport.slug, isActive: sport.isActive },
        request,
    });

    return { ...sport, eventCount: sport._count.events };
}

export async function updateSport(
    scope: AuthzScope,
    sportId: string,
    input: UpdateSportInput,
    request?: Request
) {
    const authorized = await requirePlatformPermission(PERMISSIONS.SPORT_MANAGE);

    const before = await prisma.sport.findUnique({
        where: { id: sportId },
        select: SPORT_SELECT,
    });

    if (!before) {
        throw AppError.notFound("Cabang olahraga tidak ditemukan.");
    }

    const data: Record<string, unknown> = {};

    if (input.name !== undefined) {
        data.name = input.name;
    }

    if (input.slug !== undefined || input.name !== undefined) {
        data.slug = await resolveSportSlug(
            input.name ?? before.name,
            input.slug,
            before.id
        );
    }

    if (input.iconUrl !== undefined) {
        data.iconUrl = input.iconUrl;
    }

    if (input.sortOrder !== undefined) {
        data.sortOrder = input.sortOrder;
    }

    if (input.isActive !== undefined) {
        data.isActive = input.isActive;
    }

    const updated = await prisma.sport.update({
        where: { id: before.id },
        data,
        select: SPORT_SELECT,
    });

    await writeTicketingAudit({
        action: "sport.update",
        actor: authorized,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "Sport",
        entityRef: before.id,
        description: `Cabang olahraga diperbarui: ${updated.name}`,
        beforeState: { name: before.name, slug: before.slug, isActive: before.isActive },
        afterState: { name: updated.name, slug: updated.slug, isActive: updated.isActive },
        request,
    });

    return { ...updated, eventCount: updated._count.events };
}

/**
 * Delete a sport.
 *
 * Refused while any event references it (`Event.sport` is `onDelete: Restrict`, so the
 * database would reject it anyway — this turns a raw FK error into a readable conflict
 * that names the obstacle). The error deliberately points at deactivation
 * (`isActive: false`), which is the supported way to retire a sport without breaking
 * historical events: `listPublicSports` already excludes inactive sports from the
 * catalog filter.
 */
export async function deleteSport(
    scope: AuthzScope,
    sportId: string,
    request?: Request
) {
    const authorized = await requirePlatformPermission(PERMISSIONS.SPORT_MANAGE);

    const sport = await prisma.sport.findUnique({
        where: { id: sportId },
        select: SPORT_SELECT,
    });

    if (!sport) {
        throw AppError.notFound("Cabang olahraga tidak ditemukan.");
    }

    if (sport._count.events > 0) {
        throw AppError.conflict(
            `Cabang olahraga tidak dapat dihapus karena masih digunakan oleh ${sport._count.events} event. Nonaktifkan saja.`,
            { eventCount: sport._count.events }
        );
    }

    await prisma.sport.delete({ where: { id: sport.id } });

    await writeTicketingAudit({
        action: "sport.delete",
        actor: authorized,
        actorOrganizerId: null,
        organizerId: null,
        entityType: "Sport",
        entityRef: sport.id,
        description: `Cabang olahraga dihapus: ${sport.name}`,
        beforeState: { name: sport.name, slug: sport.slug },
        request,
    });

    return { id: sport.id };
}
