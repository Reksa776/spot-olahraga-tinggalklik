import type { CheckInMethod, CheckInResult, Prisma } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
    PERMISSIONS,
    decideOrganizerPermission,
    type AuthzScope,
} from "@/lib/authz";
import { requireEventAccess } from "@/lib/events/access";
import { isEventCheckInOpen } from "@/lib/events/sales-state";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";

import { writeTicketingAudit } from "../audit-log";
import { TICKET_QR_PREFIX, isTicketCode } from "../tickets/reference";
import type { CheckInRequestInput } from "./validation";

/**
 * ==========================================
 * PHASE 13 — GATE CHECK-IN / ATTENDANCE
 * ==========================================
 *
 * Admits one ticket at one event, once, and records who did it. What this module can and
 * cannot honour is spelled out below, because two of the design's inputs do not exist in
 * the tree yet.
 *
 * ── THE CREDENTIAL: WHY THIS IS A MANUAL-CODE FLOW, NOT TOKEN VERIFICATION ───────
 *
 * Design §19.3/§20.2 verify the *scanner credential* by hashing the presented `qrToken`
 * against `Ticket.qrTokenHash`. That token is generated at issuance (32 random bytes) and
 * its hash is persisted — but **the raw token has never been delivered to any client**
 * (Phase 8 finding; design §26.6 rejects handing it to a browser, and no delivery channel
 * exists). Decision D-46 (how a scanner obtains the token) is still open.
 *
 * So the only credential that exists end-to-end is `Ticket.ticketCode` — the public,
 * human-readable lookup code the wallet QR encodes (`TICKET:<ticketCode>`) and that the
 * design itself provides a manual path for (`CheckInMethod.MANUAL_CODE`). Phase 13
 * therefore implements **`method = MANUAL`**: an authenticated, event-scoped staff member
 * presents a code, the server resolves it and admits it. It does NOT claim to verify a
 * scanner token, it NEVER reads `qrTokenHash`, and `QR_SCAN` is left unused until D-46 is
 * decided. The controls that make this safe are authorization (below), the one-admission
 * CAS, and the database uniqueness of `CheckIn.ticketId`.
 *
 * ── AUTHORIZATION (design §20.2 check 5, §29) ───────────────────────────────────
 *
 * `requireEventAccess(eventId, checkin.scan)` resolves the actor's ACTIVE membership in the
 * event's own organizer from the database — a forged event id yields 404 and never
 * discloses another tenant's event. On top of that, a member who does NOT hold
 * `checkin.override` (i.e. a `CHECKIN_STAFF`, whose only gate capabilities are
 * `checkin.scan` + `checkin.log.read`) must ALSO have an active `StaffEventAssignment` for
 * this event (design §7.3 rule 4: a staff member with no assignment can scan nothing).
 * Owners/managers/admins hold `checkin.override` and need no assignment.
 *
 * ── IDEMPOTENCY / CONCURRENCY (design §20.2 check 6, brief Part J) ───────────────
 *
 * One transaction: `UPDATE ticket SET status='CHECKED_IN' WHERE id=? AND status='ISSUED'
 * AND checkedInAt IS NULL` (the CAS decides the winner), then insert the `CheckIn` row
 * whose `ticketId` is UNIQUE. Either guard alone is sufficient; together a duplicate is
 * impossible even if one is later refactored away. The loser reads the committed state and
 * gets a deterministic `TICKET_ALREADY_CHECKED_IN` carrying the original timestamp and staff.
 */

/** The one method this phase records. `QR_SCAN` awaits D-46. */
const CHECK_IN_METHOD: CheckInMethod = "MANUAL";

/**
 * Refund states that mean "this ticket is claimed by an open request" (P14-D15 — D-28).
 *
 * The three in-flight values from the shipped `RefundStatus` enum. `REJECTED` and `FAILED`
 * released their claim and therefore do NOT block admission; `REFUNDED` is not here either,
 * because a refunded ticket is refused by the admission CAS itself (`status = 'ISSUED'`).
 */
const OPEN_REFUND_STATUSES = ["PENDING", "APPROVED", "PROCESSING"] as const;

/** How many recent admissions the attendance view returns by default. */
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

/**
 * Payload for resolving a presented code.
 *
 * Declared as a `satisfies`-checked constant plus `GetPayload`, which is the idiom the
 * ticket wallet (`lib/ticketing/tickets/payload.ts`) already uses, rather than an inline
 * `select` literal — the same reason: one declaration owns the shape, and the derived type
 * cannot drift from the query.
 */
const CHECK_IN_TICKET_SELECT = {
    id: true,
    ticketCode: true,
    status: true,
    checkedInAt: true,
    eventId: true,
    attendeeName: true,
    ticketType: { select: { name: true } },
} as const satisfies Prisma.TicketSelect;

type CheckInTicketRow = Prisma.TicketGetPayload<{
    select: typeof CHECK_IN_TICKET_SELECT;
}>;

/** The original admission of a ticket, for the duplicate-scan response. */
const FIRST_CHECKIN_SELECT = {
    checkedInAt: true,
    gateLabel: true,
    checkedInBy: { select: { name: true } },
} as const satisfies Prisma.CheckInSelect;

type FirstCheckInRow = Prisma.CheckInGetPayload<{
    select: typeof FIRST_CHECKIN_SELECT;
}>;

/** The attendance list rows. */
const EVENT_CHECKIN_SELECT = {
    id: true,
    checkedInAt: true,
    gateLabel: true,
    ticket: {
        select: {
            ticketCode: true,
            attendeeName: true,
            ticketType: { select: { name: true } },
        },
    },
    checkedInBy: { select: { name: true } },
} as const satisfies Prisma.CheckInSelect;

type EventCheckInRow = Prisma.CheckInGetPayload<{
    select: typeof EVENT_CHECKIN_SELECT;
}>;

/**
 * The three ways the admission transaction can end.
 *
 * A discriminated union rather than a loosely-typed object, so the caller cannot reach
 * `fresh` on the refund branch and the narrowing here is real control flow rather than a
 * convention.
 */
type AdmissionOutcome =
    | { accepted: true }
    | { accepted: false; reason: "REFUND_PENDING" }
    | {
          accepted: false;
          reason: "STATE";
          fresh: { status: string; checkedInAt: Date | null };
      };

export type CheckInAccess = {
    scope: AuthzScope;
    event: { id: string; organizerId: string };
    /** The actor's `OrganizerMember` row for the event's organizer, when one exists. */
    memberId: string | null;
};

/**
 * Resolve the actor's authority to admit at one event.
 *
 * Two independent gates, both database-derived:
 *   1. `checkin.scan` inside the event's own organizer (cross-tenant = 404);
 *   2. for a member without `checkin.override`, an active `StaffEventAssignment`.
 */
export async function requireEventCheckInAccess(
    eventId: string
): Promise<CheckInAccess> {
    const { scope, event } = await requireEventAccess(
        eventId,
        PERMISSIONS.CHECKIN_SCAN
    );

    const member = await prisma.organizerMember.findFirst({
        where: {
            organizerId: event.organizerId,
            userId: scope.userId,
            status: "ACTIVE",
        },
        select: { id: true },
    });

    const privileged = decideOrganizerPermission(
        scope,
        event.organizerId,
        PERMISSIONS.CHECKIN_OVERRIDE
    ).allowed;

    if (!privileged) {
        // A pure gate staff: the assignment is what bounds them to specific events.
        const assignment = member
            ? await prisma.staffEventAssignment.findFirst({
                  where: {
                      organizerMemberId: member.id,
                      eventId: event.id,
                      revokedAt: null,
                  },
                  select: { id: true },
              })
            : null;

        if (!assignment) {
            throw new AppError(ERROR_CODES.FORBIDDEN, {
                message: "Akun ini belum ditugaskan untuk event ini.",
                details: { reason: "NO_STAFF_ASSIGNMENT" },
            });
        }
    }

    return { scope, event, memberId: member?.id ?? null };
}

/**
 * Normalise a presented code to its stored form, or `null` when it cannot be one.
 *
 * Accepts either the bare code (`EVT-XXXX-XXXX`) or the wallet QR payload
 * (`TICKET:EVT-XXXX-XXXX`). Anything else is `null`, and the caller answers `NOT_FOUND`
 * so that "malformed" and "unknown" are indistinguishable (design §20.2 check 1).
 */
export function normalizeCode(raw: string): string | null {
    let value = raw.trim();

    if (value.toUpperCase().startsWith(TICKET_QR_PREFIX)) {
        value = value.slice(TICKET_QR_PREFIX.length).trim();
    }

    value = value.toUpperCase();

    return isTicketCode(value) ? value : null;
}

export type CheckInSuccess = {
    result: "SUCCESS";
    event: { id: string; title: string };
    ticket: {
        ticketCode: string;
        attendeeName: string | null;
        status: "CHECKED_IN";
    };
    ticketType: { name: string };
    method: CheckInMethod;
    gateLabel: string | null;
    checkedInAt: string;
};

/** Best-effort append-only record of a refusal. Never changes the caller's response. */
async function recordRejectedAttempt(input: {
    eventId: string;
    organizerId: string;
    actorUserId: string;
    memberId: string | null;
    gateLabel: string | null;
    deviceId: string | null;
    clientScannedAt: Date | null;
    ipAddress: string | null;
    result: CheckInResult;
    note: string | null;
}): Promise<void> {
    try {
        // A rejected attempt cannot carry `ticketId`: it is UNIQUE and belongs to the single
        // accepted admission (design D-32's nullable-unique shape). The code, when known, is
        // kept in `note` so an operator can still trace the attempt.
        await prisma.checkIn.create({
            data: {
                ticketId: null,
                eventId: input.eventId,
                organizerId: input.organizerId,
                checkedInByUserId: input.actorUserId,
                checkedInByMemberId: input.memberId,
                method: CHECK_IN_METHOD,
                gateLabel: input.gateLabel,
                deviceId: input.deviceId,
                clientScannedAt: input.clientScannedAt,
                ipAddress: input.ipAddress,
                result: input.result,
                note: input.note,
            },
        });
    } catch (error) {
        console.error("CHECKIN_REJECTED_RECORD_ERROR:", error);
    }
}

/**
 * Admit one ticket at one event.
 *
 * Every refusal (a) writes an append-only `CheckIn` row, (b) writes a `checkin.rejected`
 * audit row, then (c) throws the `AppError` the route maps to a status. Refusals are
 * returned to the caller by throwing, so the narrowing of `code`/`ticket` here is real
 * control flow rather than a convention.
 */
export async function checkInTicket(params: {
    eventId: string;
    input: CheckInRequestInput;
    request?: Request;
}): Promise<CheckInSuccess> {
    const { scope, event, memberId } = await requireEventCheckInAccess(
        params.eventId
    );

    const gate = await prisma.event.findUniqueOrThrow({
        where: { id: event.id },
        select: {
            id: true,
            title: true,
            organizerId: true,
            status: true,
            // PHASE 15: the gate is a TIME window, so `endAt` and the server clock are part of
            // the predicate (P14-D06). Without them a `COMPLETED` event kept admitting people
            // forever.
            endAt: true,
            archivedAt: true,
            cancelledAt: true,
        },
    });

    const now = new Date();
    const ipAddress = params.request ? getClientIp(params.request) : null;
    const clientScannedAt = params.input.clientScannedAt ?? null;
    const gateLabel = params.input.gateLabel ?? null;
    const deviceId = params.input.deviceId ?? null;

    /** Record the refusal, then hand the error back so the caller can `throw` it. */
    const refuse = async (input: {
        result: CheckInResult;
        note: string | null;
        reason: string;
        error: AppError;
    }): Promise<AppError> => {
        await recordRejectedAttempt({
            eventId: gate.id,
            organizerId: gate.organizerId,
            actorUserId: scope.userId,
            memberId,
            gateLabel,
            deviceId,
            clientScannedAt,
            ipAddress,
            result: input.result,
            note: input.note,
        });

        await writeTicketingAudit({
            action: "checkin.rejected",
            actor: scope,
            actorOrganizerId: gate.organizerId,
            organizerId: gate.organizerId,
            entityType: "Ticket",
            entityRef: input.note,
            description: `Check-in ditolak: ${input.reason}`,
            afterState: { reason: input.reason, result: input.result },
            reason: input.reason,
            request: params.request,
        });

        return input.error;
    };

    // A cancelled or archived event — or one past its grace window — closes its gate
    // (fail-closed). `isEventCheckInOpen` is the ONE canonical predicate, shared with the
    // catalog, the purchase path and the dashboard, so the four cannot drift apart.
    if (!isEventCheckInOpen(gate, now)) {
        throw await refuse({
            result: "INVALID_TICKET",
            note: null,
            reason: "EVENT_NOT_OPEN",
            error: AppError.conflict("Event ini tidak menerima check-in.", {
                reason: "EVENT_NOT_OPEN",
                status: gate.status,
            }),
        });
    }

    const code = normalizeCode(params.input.code);

    if (!code) {
        throw await refuse({
            result: "INVALID_TICKET",
            note: "UNRECOGNIZED_CODE_FORMAT",
            reason: "INVALID_TICKET_FORMAT",
            error: AppError.notFound("Tiket tidak ditemukan."),
        });
    }

    const ticket: CheckInTicketRow | null = await prisma.ticket.findUnique({
        where: { ticketCode: code },
        select: CHECK_IN_TICKET_SELECT,
    });

    if (!ticket) {
        throw await refuse({
            result: "TICKET_NOT_FOUND",
            note: code,
            reason: "TICKET_NOT_FOUND",
            error: AppError.notFound("Tiket tidak ditemukan."),
        });
    }

    if (ticket.eventId !== gate.id) {
        // The ticket's real event is NOT disclosed: revealing it would confirm another
        // event's existence to a scanner who may not be able to see it.
        throw await refuse({
            result: "WRONG_EVENT",
            note: code,
            reason: "WRONG_EVENT",
            error: AppError.conflict("Tiket ini bukan untuk event ini.", {
                reason: "WRONG_EVENT",
            }),
        });
    }

    /**
     * The admission transaction: the open-refund guard and the CAS, serialized on the ticket
     * row (P14-D15's race contract).
     *
     * ORDER, AND WHY:
     *
     *   1. `SELECT … FOR UPDATE` on the ticket. This is the serialization point shared with
     *      `requestRefund`, which takes the same lock before it validates its claims. Whichever
     *      of the two arrives second reads the first one's COMMITTED state and refuses, so the
     *      database — not application memory — decides the race.
     *   2. The open-refund guard, read INSIDE the transaction, after the lock. A guard read
     *      before the lock would be a time-of-check/time-of-use hole.
     *   3. The CAS `ISSUED → CHECKED_IN`, then the accepted evidence in the same transaction.
     *      The UNIQUE `CheckIn.ticketId` is the second, independent duplicate guarantee.
     */
    const outcome = await prisma.$transaction(
        async (tx): Promise<AdmissionOutcome> => {
            await tx.$queryRaw`SELECT id FROM ticket WHERE id = ${ticket.id} FOR UPDATE`;

            const openClaim = await tx.refundItem.findFirst({
                where: {
                    ticketId: ticket.id,
                    refund: { status: { in: [...OPEN_REFUND_STATUSES] } },
                },
                select: { id: true },
            });

            if (openClaim) {
                return { accepted: false, reason: "REFUND_PENDING" };
            }

            // The CAS decides the winner. `checkedInAt: null` is belt-and-braces: a row
            // whose status somehow says ISSUED but carries a timestamp is not admitted twice.
            const cas = await tx.ticket.updateMany({
                where: {
                    id: ticket.id,
                    status: "ISSUED",
                    checkedInAt: null,
                },
                data: { status: "CHECKED_IN", checkedInAt: now },
            });

            if (cas.count !== 1) {
                const fresh = await tx.ticket.findUniqueOrThrow({
                    where: { id: ticket.id },
                    select: { status: true, checkedInAt: true },
                });

                return { accepted: false, reason: "STATE", fresh };
            }

            // The accepted evidence, in the same transaction as the state change. The
            // UNIQUE `ticketId` is the second, independent duplicate guarantee.
            await tx.checkIn.create({
                data: {
                    ticketId: ticket.id,
                    eventId: gate.id,
                    organizerId: gate.organizerId,
                    checkedInByUserId: scope.userId,
                    checkedInByMemberId: memberId,
                    method: CHECK_IN_METHOD,
                    gateLabel,
                    deviceId,
                    clientScannedAt,
                    ipAddress,
                    result: "SUCCESS",
                },
            });

            return { accepted: true };
        },
        { timeout: 15_000 }
    );

    // A ticket claimed by an open refund is refused BEFORE the CAS is considered, and the
    // refusal is recorded exactly like every other one (append-only row + audit) so an
    // operator can see that the door turned someone away over a refund, not over a bad code.
    if (!outcome.accepted && outcome.reason === "REFUND_PENDING") {
        throw await refuse({
            result: "REFUND_PENDING",
            note: code,
            reason: "REFUND_PENDING",
            error: AppError.conflict(
                "Tiket ini sedang dalam proses refund dan belum dapat check-in.",
                { reason: "REFUND_PENDING" }
            ),
        });
    }

    if (!outcome.accepted) {
        if (outcome.fresh.status === "CHECKED_IN") {
            const first: FirstCheckInRow | null = await prisma.checkIn.findFirst({
                where: { ticketId: ticket.id },
                select: FIRST_CHECKIN_SELECT,
            });

            throw await refuse({
                result: "ALREADY_CHECKED_IN",
                note: code,
                reason: "ALREADY_CHECKED_IN",
                error: new AppError(ERROR_CODES.TICKET_ALREADY_CHECKED_IN, {
                    message: "Tiket ini sudah check-in.",
                    details: {
                        reason: "ALREADY_CHECKED_IN",
                        ticketCode: ticket.ticketCode,
                        firstCheckedInAt: first?.checkedInAt?.toISOString() ?? null,
                        firstCheckedInBy: first?.checkedInBy?.name ?? null,
                        firstGateLabel: first?.gateLabel ?? null,
                    },
                }),
            });
        }

        const result: CheckInResult =
            outcome.fresh.status === "RESERVED" ? "UNPAID" : "INVALID_TICKET";

        throw await refuse({
            result,
            note: code,
            reason: "TICKET_NOT_ISSUED",
            error: AppError.conflict(
                "Tiket ini tidak dapat check-in pada statusnya saat ini.",
                { reason: "TICKET_NOT_ISSUED", status: outcome.fresh.status }
            ),
        });
    }

    await writeTicketingAudit({
        action: "checkin.success",
        actor: scope,
        actorOrganizerId: gate.organizerId,
        organizerId: gate.organizerId,
        entityType: "Ticket",
        entityRef: ticket.ticketCode,
        description: "Tiket diterima di pintu masuk (check-in).",
        beforeState: { status: "ISSUED" },
        afterState: {
            status: "CHECKED_IN",
            eventId: gate.id,
            method: CHECK_IN_METHOD,
            gateLabel,
        },
        request: params.request,
    });

    return {
        result: "SUCCESS",
        event: { id: gate.id, title: gate.title },
        ticket: {
            ticketCode: ticket.ticketCode,
            attendeeName: ticket.attendeeName,
            status: "CHECKED_IN",
        },
        ticketType: { name: ticket.ticketType.name },
        method: CHECK_IN_METHOD,
        gateLabel,
        checkedInAt: now.toISOString(),
    };
}

export type EventCheckInListItem = {
    id: string;
    ticketCode: string;
    attendeeName: string | null;
    ticketTypeName: string;
    checkedInAt: string;
    checkedInBy: string | null;
    gateLabel: string | null;
};

export type EventCheckInList = {
    items: EventCheckInListItem[];
    total: number;
};

/**
 * The attendance view: the most recent accepted admissions of one event.
 *
 * Requires `checkin.log.read` inside the event's tenant (held by gate staff and the
 * organizer roles; `FINANCE` and `PIC` do not hold it). Read-only.
 */
export async function listEventCheckIns(
    eventId: string,
    limit?: number
): Promise<EventCheckInList> {
    const { event } = await requireEventAccess(
        eventId,
        PERMISSIONS.CHECKIN_LOG_READ
    );

    const take = Math.min(
        MAX_LIST_LIMIT,
        Math.max(1, limit ?? DEFAULT_LIST_LIMIT)
    );
    const where = { eventId: event.id, result: "SUCCESS" as const };

    const [rows, total]: [EventCheckInRow[], number] = await Promise.all([
        prisma.checkIn.findMany({
            where,
            orderBy: { checkedInAt: "desc" },
            take,
            select: EVENT_CHECKIN_SELECT,
        }),
        prisma.checkIn.count({ where }),
    ]);

    return {
        items: rows.map((row) => ({
            id: row.id,
            ticketCode: row.ticket?.ticketCode ?? "—",
            attendeeName: row.ticket?.attendeeName ?? null,
            ticketTypeName: row.ticket?.ticketType?.name ?? "—",
            checkedInAt: row.checkedInAt.toISOString(),
            checkedInBy: row.checkedInBy?.name ?? null,
            gateLabel: row.gateLabel,
        })),
        total,
    };
}
