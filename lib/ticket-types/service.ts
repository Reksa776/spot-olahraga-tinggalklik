import { Prisma } from "@prisma/client";

import { AppError } from "@/lib/api/errors";
import {
    PERMISSIONS,
    requireOrganizerAccess,
    type AuthzScope,
} from "@/lib/authz";
import { summarizeSales, type SalesState } from "@/lib/events/sales-state";
import { prisma } from "@/lib/prisma";
import {
    availableInventory,
    committedQuota,
    quotaChangeViolations,
    rawAvailable,
} from "@/lib/ticketing/inventory";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";

import { requireEventAccess, requireTicketTypeAccess } from "./access";
import type { CreateTicketTypeInput, UpdateTicketTypeInput } from "./validation";

/**
 * ==========================================
 * TICKET TYPE SERVICE
 * ==========================================
 *
 * Organizer-scoped management of the sellable tiers of one event. Authority always
 * resolves through the event's organizer and an ACTIVE membership (Phase 3
 * `lib/authz/`), never through a caller-supplied id.
 *
 * PERMISSION SEPARATION (why this file checks three permissions, not one)
 * ---------------------------------------------------------------------
 * The design's narrative names a single `ticket_type.manage`, but Phase 3 implemented
 * the Phase 1 §6.4 vocabulary, which splits the capability so that changing *price* and
 * changing *quota* are independently grantable:
 *
 *   ticket_type.write         name, description, window, ordering, activation
 *   ticket_type.price_change  the price
 *   ticket_type.quota_change  the quota
 *
 * Brief §18 says to reuse the existing vocabulary and not create duplicates, so this
 * service uses the three that exist. The practical effect is a real control: a role can
 * be allowed to run the tier list without being able to reprice it, and a price change
 * cannot ride in on an ordinary edit.
 *
 * INVENTORY COUNTERS ARE NEVER WRITTEN HERE
 * -----------------------------------------
 * `sold`, `reserved` and `version` are not touched by any function in this file. They
 * move only through `lib/ticketing/inventory.ts`'s atomic statements. A ticket type's
 * `quota` is the one inventory-adjacent field an organizer may edit, and it is guarded
 * so it can never fall below `sold + reserved` (design §11.6).
 */

/**
 * Exact decimal string, not a float.
 *
 * The organizer surface is the *editing* surface: the value round-trips into an input
 * and back, so it must survive without float drift (`1234567.89` must not become
 * `1234567.8899999999`). Phase 4's public catalog returns `price` as a display number
 * for a catalog card; that contract is deliberately left alone, and the divergence is
 * intentional here rather than accidental.
 */
type PriceString = string;
type Counters = {
    quota: number;
    sold: number;
    reserved: number;
    /** `quota - sold - reserved`, clamped for display. */
    available: number;
    /** `sold + reserved` — the floor a quota reduction may not cross. */
    committed: number;
};

export type OrganizerTicketType = {
    id: string;
    eventId: string;
    name: string;
    description: string | null;
    price: PriceString;
    currency: string;
    minPerOrder: number;
    maxPerOrder: number | null;
    salesStartAt: string | null;
    salesEndAt: string | null;
    isActive: boolean;
    sortOrder: number;
    version: number;
    createdAt: string;
    updatedAt: string;
    /** Internal, authorised view. Design §2291 permits the counters *here*. */
    inventory: Counters;
    /**
     * `NOT_STARTED | OPEN | CLOSED | SOLD_OUT`, from the canonical Phase 4 classifier.
     *
     * The brief's five distinguishable states fall out of this plus `isActive`; no
     * fifth enum value is invented, because the design's contract is the pair.
     */
    salesState: SalesState;
    isSoldOut: boolean;
};

const TICKET_TYPE_SELECT = {
    id: true,
    eventId: true,
    name: true,
    description: true,
    price: true,
    currency: true,
    quota: true,
    sold: true,
    reserved: true,
    minPerOrder: true,
    maxPerOrder: true,
    salesStartAt: true,
    salesEndAt: true,
    isActive: true,
    sortOrder: true,
    version: true,
    createdAt: true,
    updatedAt: true,
    _count: {
        select: {
            orderItems: true,
            tickets: true,
            reservations: true,
            feeEntries: true,
        },
    },
} satisfies Prisma.TicketTypeSelect;

type TicketTypeRow = Prisma.TicketTypeGetPayload<{
    select: typeof TICKET_TYPE_SELECT;
}>;

/** Event lifecycle values that mean "this event is over"; see `assertEventEditable`. */
const TERMINAL_EVENT_STATUSES = ["CANCELLED", "COMPLETED", "ARCHIVED"] as const;

type EventWindow = {
    salesStartAt: Date | null;
    salesEndAt: Date | null;
    startAt: Date;
};

/**
 * Present one row for the organizer surface.
 *
 * `salesState` comes from `summarizeSales` applied to the single row, which is the
 * canonical Phase 4 classifier — reusing it (rather than re-deriving the window rules)
 * is what guarantees the organizer's view of "OPEN" agrees with the buyer's.
 */
function toOrganizerTicketType(
    row: TicketTypeRow,
    event: EventWindow
): OrganizerTicketType {
    const summary = summarizeSales(
        [
            {
                isActive: row.isActive,
                price: row.price,
                quota: row.quota,
                sold: row.sold,
                reserved: row.reserved,
                salesStartAt: row.salesStartAt,
                salesEndAt: row.salesEndAt,
            },
        ],
        event
    );

    return {
        id: row.id,
        eventId: row.eventId,
        name: row.name,
        description: row.description,
        price: row.price.toFixed(2),
        currency: row.currency,
        minPerOrder: row.minPerOrder,
        maxPerOrder: row.maxPerOrder,
        salesStartAt: row.salesStartAt?.toISOString() ?? null,
        salesEndAt: row.salesEndAt?.toISOString() ?? null,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        inventory: {
            quota: row.quota,
            sold: row.sold,
            reserved: row.reserved,
            available: availableInventory(row),
            committed: committedQuota(row),
        },
        salesState: summary.salesState,
        isSoldOut: summary.isSoldOut,
    };
}

async function loadEventWindow(eventId: string): Promise<EventWindow> {
    const event = await prisma.event.findUniqueOrThrow({
        where: { id: eventId },
        select: { salesStartAt: true, salesEndAt: true, startAt: true },
    });

    return event;
}

/**
 * Refuse to add or reshape sellable inventory on an event that is over.
 *
 * Brief §16 requires the ticket-type domain to respect the Phase 4 lifecycle without
 * creating new statuses or touching D-13/D-14. `CANCELLED`, `COMPLETED` and `ARCHIVED`
 * are terminal: pricing or re-quota-ing them is meaningless and, worse, would look like
 * a live sale on a dead event.
 *
 * DEACTIVATION IS ALWAYS ALLOWED (`allowOnTerminal`), because retiring inventory is a
 * safety valve — a cancelled event whose tiers are still `isActive` must be fixable.
 */
async function assertEventEditable(
    eventId: string,
    allowOnTerminal = false
): Promise<void> {
    if (allowOnTerminal) {
        return;
    }

    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { status: true, archivedAt: true },
    });

    if (!event) {
        throw AppError.notFound("Event tidak ditemukan.");
    }

    if (
        event.archivedAt ||
        (TERMINAL_EVENT_STATUSES as readonly string[]).includes(event.status)
    ) {
        throw AppError.conflict(
            "Jenis tiket tidak dapat diubah karena event sudah dibatalkan, selesai, atau diarsipkan."
        );
    }
}

/**
 * List the ticket types of one event.
 *
 * Requires `event.read` on the event, which resolves the actor's membership from the
 * database — so listing another organizer's tiers fails closed with 404.
 *
 * Deactivated tiers ARE returned, unlike the public payload: this is the management
 * surface, and an inactive tier that vanished from it could not be reactivated.
 */
export async function listEventTicketTypes(
    scope: AuthzScope,
    eventId: string
): Promise<{ items: OrganizerTicketType[]; total: number }> {
    const access = await requireEventAccess(eventId, PERMISSIONS.EVENT_READ);

    const [rows, event] = await Promise.all([
        prisma.ticketType.findMany({
            where: { eventId: access.event.id },
            select: TICKET_TYPE_SELECT,
            orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        }),
        loadEventWindow(access.event.id),
    ]);

    return {
        items: rows.map((row) => toOrganizerTicketType(row, event)),
        total: rows.length,
    };
}

/** Read one ticket type for management. */
export async function getOrganizerTicketType(
    scope: AuthzScope,
    ticketTypeId: string
): Promise<OrganizerTicketType> {
    const access = await requireTicketTypeAccess(
        ticketTypeId,
        PERMISSIONS.EVENT_READ
    );

    const [row, event] = await Promise.all([
        prisma.ticketType.findUniqueOrThrow({
            where: { id: access.ticketType.id },
            select: TICKET_TYPE_SELECT,
        }),
        loadEventWindow(access.ticketType.eventId),
    ]);

    return toOrganizerTicketType(row, event);
}

/**
 * Create a ticket type under one event.
 *
 * A brand-new row starts with `sold = 0`, `reserved = 0` and `version = 0` — the column
 * defaults. They are not settable and are not written here, so a caller cannot
 * pre-load inventory.
 *
 * `price` arrives as a validated decimal string and is passed straight through to the
 * `Decimal(14,2)` column. No float ever holds it.
 */
export async function createTicketType(
    scope: AuthzScope,
    eventId: string,
    input: CreateTicketTypeInput,
    request?: Request
) {
    const access = await requireEventAccess(
        eventId,
        PERMISSIONS.TICKET_TYPE_WRITE
    );

    await assertEventEditable(access.event.id);

    const created = await prisma.ticketType.create({
        data: {
            eventId: access.event.id,
            name: input.name,
            description: input.description ?? null,
            price: input.price,
            quota: input.quota,
            ...(input.minPerOrder === undefined
                ? {}
                : { minPerOrder: input.minPerOrder }),
            maxPerOrder: input.maxPerOrder ?? null,
            salesStartAt: input.salesStartAt ?? null,
            salesEndAt: input.salesEndAt ?? null,
            ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
            ...(input.sortOrder === undefined
                ? {}
                : { sortOrder: input.sortOrder }),
        },
        select: TICKET_TYPE_SELECT,
    });

    await writeTicketingAudit({
        action: "ticket_type.create",
        actor: access.scope,
        actorOrganizerId: access.event.organizerId,
        organizerId: access.event.organizerId,
        entityType: "TicketType",
        entityRef: created.id,
        description: `Jenis tiket dibuat: ${created.name}`,
        afterState: {
            eventId: created.eventId,
            name: created.name,
            price: created.price.toFixed(2),
            quota: created.quota,
            isActive: created.isActive,
            sortOrder: created.sortOrder,
        },
        request,
    });

    return toOrganizerTicketType(created, await loadEventWindow(created.eventId));
}

/**
 * Update a ticket type.
 *
 * Three permissions can be required by a single request, and each is checked only when
 * the corresponding field is actually present — so a role with `ticket_type.write` but
 * not `ticket_type.price_change` can still rename a tier, and cannot smuggle a price
 * change into a rename.
 *
 * QUOTA (design §11.6, the rule the design states outright): a reduction is allowed only
 * down to `sold + reserved`. Below that it is a `CONFLICT` carrying `minimumQuota`, so
 * the UI can say exactly how low it may go. An increase can never violate the invariant
 * and is permitted, audited as its own action.
 *
 * `sold`, `reserved` and `version` are unreachable from here in every case — they are
 * not in the update schema, so no combination of request fields can move them.
 */
export async function updateTicketType(
    scope: AuthzScope,
    ticketTypeId: string,
    input: UpdateTicketTypeInput,
    request?: Request
) {
    const access = await requireTicketTypeAccess(
        ticketTypeId,
        PERMISSIONS.TICKET_TYPE_WRITE
    );

    const before = await prisma.ticketType.findUniqueOrThrow({
        where: { id: access.ticketType.id },
        select: TICKET_TYPE_SELECT,
    });

    // Deactivation is the one change permitted on a terminal event (safety valve).
    const onlyDeactivating =
        input.isActive === false &&
        Object.keys(input).every((key) => key === "isActive");

    await assertEventEditable(before.eventId, onlyDeactivating);

    if (input.quota !== undefined) {
        // Separate capability, checked separately — so `ticket_type.write` alone
        // cannot move the quota.
        await requireOrganizerAccess(
            access.organizerId,
            PERMISSIONS.TICKET_TYPE_QUOTA_CHANGE
        );

        const violation = quotaChangeViolations(before, input.quota);

        if (violation) {
            throw AppError.conflict(
                `Kuota tidak dapat dikurangi di bawah jumlah tiket yang sudah terjual dan ditahan (${violation.minimumQuota}).`,
                {
                    quota: before.quota,
                    sold: before.sold,
                    reserved: before.reserved,
                    minimumQuota: violation.minimumQuota,
                }
            );
        }
    }

    if (input.price !== undefined) {
        // Separate capability, checked separately — so `ticket_type.write` alone
        // cannot reprice a tier.
        await requireOrganizerAccess(
            access.organizerId,
            PERMISSIONS.TICKET_TYPE_PRICE_CHANGE
        );
    }

    const data: Prisma.TicketTypeUpdateInput = {};

    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.price !== undefined) data.price = input.price;
    if (input.quota !== undefined) data.quota = input.quota;
    if (input.minPerOrder !== undefined) data.minPerOrder = input.minPerOrder;
    if (input.maxPerOrder !== undefined) data.maxPerOrder = input.maxPerOrder;
    if (input.salesStartAt !== undefined) data.salesStartAt = input.salesStartAt;
    if (input.salesEndAt !== undefined) data.salesEndAt = input.salesEndAt;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    // Defence in depth, and it is not redundant: the ROUTE refuses an empty body via
    // the Zod schema's non-empty refine, but this service is also called directly by
    // the server component that renders the page. Without this guard an empty payload
    // reaches Prisma, which performs a no-op UPDATE and returns 200 — a silent success
    // for a request that asked for nothing.
    if (Object.keys(data).length === 0) {
        throw AppError.validation("Tidak ada perubahan yang dikirim.");
    }

    const updated = await prisma.ticketType.update({
        where: { id: before.id },
        data,
        select: TICKET_TYPE_SELECT,
    });

    const priceChanged = updated.price.toFixed(2) !== before.price.toFixed(2);
    const quotaChanged = updated.quota !== before.quota;
    const activeChanged = updated.isActive !== before.isActive;

    const shared = {
        actor: access.scope,
        actorOrganizerId: access.organizerId,
        organizerId: access.organizerId,
        entityType: "TicketType" as const,
        entityRef: before.id,
        request,
    };

    // One row per distinct change class. Quota and price are separately permissioned
    // and are what a finance reviewer searches for, so they get their own action names
    // rather than being buried in a generic update.
    if (quotaChanged) {
        await writeTicketingAudit({
            ...shared,
            action: "ticket_type.quota_change",
            description: `Kuota jenis tiket diubah: ${before.name} (${before.quota} → ${updated.quota})`,
            beforeState: { quota: before.quota, sold: before.sold, reserved: before.reserved },
            afterState: { quota: updated.quota, sold: updated.sold, reserved: updated.reserved },
        });
    }

    if (priceChanged) {
        await writeTicketingAudit({
            ...shared,
            action: "ticket_type.price_change",
            description: `Harga jenis tiket diubah: ${before.name} (${before.price.toFixed(2)} → ${updated.price.toFixed(2)})`,
            beforeState: { price: before.price.toFixed(2) },
            afterState: { price: updated.price.toFixed(2) },
        });
    }

    if (activeChanged) {
        await writeTicketingAudit({
            ...shared,
            action: updated.isActive
                ? "ticket_type.activate"
                : "ticket_type.deactivate",
            description: updated.isActive
                ? `Jenis tiket diaktifkan: ${updated.name}`
                : `Jenis tiket dinonaktifkan: ${updated.name}`,
            beforeState: { isActive: before.isActive },
            afterState: { isActive: updated.isActive },
        });
    }

    const otherFieldsChanged =
        updated.name !== before.name ||
        updated.description !== before.description ||
        updated.minPerOrder !== before.minPerOrder ||
        updated.maxPerOrder !== before.maxPerOrder ||
        updated.salesStartAt?.getTime() !== before.salesStartAt?.getTime() ||
        updated.salesEndAt?.getTime() !== before.salesEndAt?.getTime() ||
        updated.sortOrder !== before.sortOrder;

    if (otherFieldsChanged) {
        await writeTicketingAudit({
            ...shared,
            action: "ticket_type.update",
            description: `Jenis tiket diperbarui: ${updated.name}`,
            beforeState: {
                name: before.name,
                minPerOrder: before.minPerOrder,
                maxPerOrder: before.maxPerOrder,
                salesStartAt: before.salesStartAt?.toISOString() ?? null,
                salesEndAt: before.salesEndAt?.toISOString() ?? null,
                sortOrder: before.sortOrder,
            },
            afterState: {
                name: updated.name,
                minPerOrder: updated.minPerOrder,
                maxPerOrder: updated.maxPerOrder,
                salesStartAt: updated.salesStartAt?.toISOString() ?? null,
                salesEndAt: updated.salesEndAt?.toISOString() ?? null,
                sortOrder: updated.sortOrder,
            },
        });
    }

    return toOrganizerTicketType(updated, await loadEventWindow(updated.eventId));
}

/**
 * Delete a ticket type — refused once it participates in commercial history.
 *
 * Brief §7: "Do NOT blindly hard-delete a TicketType if it can already participate in
 * commercial history… If the design does not define safe deletion semantics, prefer the
 * existing active/inactive model and document the boundary rather than inventing
 * destructive behavior."
 *
 * The foreign keys make this concrete, and they disagree with each other:
 *
 *   Ticket.ticketType            onDelete: Restrict  → the DB already refuses
 *   TicketReservation.ticketType onDelete: Restrict  → the DB already refuses
 *   EventOrderItem.ticketType    onDelete: SetNull   → the DB would ALLOW it
 *   PICFeeLedger.ticketType      onDelete: SetNull   → the DB would ALLOW it
 *
 * Those last two are the hazard: deleting a type that has been ordered would silently
 * blank `ticketTypeId` on order items and fee-ledger rows, destroying which tier a
 * buyer actually bought — and, later, the basis of a PIC fee. So deletion is refused
 * whenever ANY of the four reference it, with the counts returned so the operator can
 * see what is blocking, and the message points at deactivation, which is the supported
 * retirement path (design §11.6: "Ticket type deactivated mid-sale → no new
 * reservations; existing reservations remain valid and still confirm").
 *
 * A type that has never been ordered, held, ticketed or fee-ledgered is genuinely
 * unused and deletes cleanly — which keeps "I mistyped the tier" fixable.
 */
export async function deleteTicketType(
    scope: AuthzScope,
    ticketTypeId: string,
    request?: Request
) {
    const access = await requireTicketTypeAccess(
        ticketTypeId,
        PERMISSIONS.TICKET_TYPE_WRITE
    );

    const before = await prisma.ticketType.findUniqueOrThrow({
        where: { id: access.ticketType.id },
        select: TICKET_TYPE_SELECT,
    });

    const references = {
        orderItems: before._count.orderItems,
        tickets: before._count.tickets,
        reservations: before._count.reservations,
        feeEntries: before._count.feeEntries,
    };

    const referenced =
        references.orderItems +
            references.tickets +
            references.reservations +
            references.feeEntries >
        0;

    if (referenced) {
        throw AppError.conflict(
            "Jenis tiket tidak dapat dihapus karena sudah dipakai pada transaksi. Nonaktifkan saja agar tidak bisa dibeli lagi.",
            {
                ...references,
                // The machine-readable pointer at the supported alternative.
                supportedAction: "DEACTIVATE",
            }
        );
    }

    await prisma.ticketType.delete({ where: { id: before.id } });

    await writeTicketingAudit({
        action: "ticket_type.delete",
        actor: access.scope,
        actorOrganizerId: access.organizerId,
        organizerId: access.organizerId,
        entityType: "TicketType",
        entityRef: before.id,
        description: `Jenis tiket dihapus: ${before.name}`,
        beforeState: {
            eventId: before.eventId,
            name: before.name,
            price: before.price.toFixed(2),
            quota: before.quota,
            isActive: before.isActive,
        },
        request,
    });

    return { id: before.id };
}

/**
 * Inventory + window snapshot for the organizer readiness panel.
 *
 * Read-only, and derived entirely from the canonical helpers: `rawAvailable` /
 * `committedQuota` from the inventory module and the `salesState` classifier from
 * `lib/events/sales-state.ts`. It exists so the UI can explain *why* a tier is or is
 * not sellable without re-implementing either rule.
 */
export function ticketTypeReadinessSummary(row: {
    isActive: boolean;
    quota: number;
    sold: number;
    reserved: number;
}): {
    active: boolean;
    available: number;
    committed: number;
    hasQuota: boolean;
    sellable: boolean;
} {
    return {
        active: row.isActive,
        available: rawAvailable(row),
        committed: committedQuota(row),
        hasQuota: row.quota > 0,
        sellable: row.isActive && row.quota > 0 && rawAvailable(row) > 0,
    };
}
