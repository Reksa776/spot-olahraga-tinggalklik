import type { CheckInMethod, CheckInResult, Prisma } from "@prisma/client";

import { AppError, ERROR_CODES } from "@/lib/api/errors";
import {
    AuthzError,
    AuthzErrorCode,
    PERMISSIONS,
    decideOrganizerPermission,
    isAuthzError,
    requireAuth,
    type AuthzScope,
} from "@/lib/authz";
import { decidePicEventPermission } from "@/lib/authz/pic-assignment";
import { requireEventAccess } from "@/lib/events/access";
import { isEventCheckInOpen } from "@/lib/events/sales-state";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/rate-limit";
import { publishTicketCheckedIn } from "@/lib/realtime/publishers";

import { writeTicketingAudit } from "../audit-log";
import { resolveCheckInMethod } from "./method";
import { enforcePicScanRateLimit } from "./pic-rate-limit";
import { parseCheckInQrPayload } from "./qr-payload";
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

/**
 * The one method this gate records: `MANUAL`.
 *
 * PHASE 3C: chosen by the Phase 3B resolver from the credential that actually exists here —
 * the PUBLIC ticket code, whether it was typed, pasted, or decoded from the wallet QR by a
 * camera. A camera scan proves nothing about a secret, so it must not be labelled `QR_SCAN`.
 * That value is unreachable until a scanner secret is genuinely verified (D-46).
 */
const CHECK_IN_METHOD: CheckInMethod = resolveCheckInMethod("PUBLIC_TICKET_CODE");

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
    /**
     * The ticket's holder, read ONLY to address the realtime announcement to the buyer.
     *
     * It is never returned to the gate: the scanner response carries the ticket code, the
     * attendee name and the ticket type, and nothing about who owns the account. A nullable
     * column, so an unclaimed ticket simply has no customer audience.
     */
    holderUserId: true,
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
    /**
     * Which gate admitted the actor. PIC responses must never disclose another operator's
     * identity (B-4), so this decides whether `firstCheckedInBy` may be populated.
     */
    actorKind: "ORGANIZER" | "PIC";
    /**
     * The PIC profile that admitted, when the actor came through the PIC gate.
     *
     * PHASE 3F: durable attribution already exists in `CheckIn.checkedInByUserId` (always
     * the session user) and `PICProfile.userId` is `@unique`, so the PIC is fully
     * recoverable without a schema change. This field carries the profile id into the
     * immutable audit metadata, where it can be joined to the profile even after an
     * assignment is revoked. `null` for organizers.
     */
    picProfileId: string | null;
};

/**
 * Resolve the actor's authority to admit at one event.
 *
 * Two independent gates, both database-derived:
 *   1. `checkin.scan` inside the event's own organizer (cross-tenant = 404);
 *   2. for a member without `checkin.override`, an active `StaffEventAssignment`.
 */
async function requireOrganizerCheckInAccess(
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

    return {
        scope,
        event,
        memberId: member?.id ?? null,
        actorKind: "ORGANIZER",
        picProfileId: null,
    };
}

/**
 * Refusal codes that mean "this actor is not allowed here", as opposed to "something broke".
 *
 * Only these may trigger the PIC fallback: a database outage or a programming error must keep
 * propagating, so it can never be turned into a second authorization attempt.
 */
const ACCESS_REFUSAL_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.UNAUTHORIZED,
    ERROR_CODES.FORBIDDEN,
    ERROR_CODES.ORGANIZER_ACCESS_DENIED,
    ERROR_CODES.PIC_ACCESS_DENIED,
    ERROR_CODES.NOT_FOUND,
]);

function isAccessRefusal(error: unknown): boolean {
    if (isAuthzError(error)) {
        return true;
    }

    return error instanceof AppError && ACCESS_REFUSAL_CODES.has(error.code);
}

/**
 * ==========================================
 * PHASE 3D — THE PIC FRONT DOOR TO THE SAME ADMISSION
 * ==========================================
 *
 * A PIC is a platform role with NO `OrganizerMember` row, so the tenant guard above can never
 * authorize one — that is structural, not a bug. Duplicating the admission writer instead would
 * split the lock, the refund guard, the CAS and the UNIQUE insert into two implementations, which
 * is exactly what the phase forbids.
 *
 * So the organizer refusal is caught (ONLY when it is an authorization refusal) and the question
 * is asked again the way the Phase 3A contract asks it: an ACTIVE `PICProfile` belonging to the
 * session user, plus an active, non-revoked `PICEventAssignment` for THIS event, decided by
 * `decidePicEventPermission`. An actor who is neither staff nor a PIC gets the ORIGINAL refusal
 * rethrown, so the 404 masking of the tenant guard is preserved exactly.
 */
async function requirePicCheckInAccess(
    eventId: string,
    organizerRefusal: unknown
): Promise<CheckInAccess> {
    const scope = await requireAuth();

    const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { id: true, organizerId: true },
    });

    if (!event) {
        throw organizerRefusal;
    }

    const picProfile = await prisma.pICProfile.findUnique({
        where: { userId: scope.userId },
        select: { id: true, userId: true, status: true },
    });

    if (!picProfile) {
        // Not a PIC either — the organizer refusal is the true, masked answer.
        throw organizerRefusal;
    }

    const assignment = await prisma.pICEventAssignment.findUnique({
        where: {
            picProfileId_eventId: {
                picProfileId: picProfile.id,
                eventId,
            },
        },
        select: {
            picProfileId: true,
            eventId: true,
            isActive: true,
            revokedAt: true,
        },
    });

    const decision = decidePicEventPermission({
        userId: scope.userId,
        eventId,
        picProfile,
        assignment,
    });

    if (!decision.allowed) {
        throw new AuthzError(decision.code, decision.reason);
    }

    return {
        scope,
        event,
        memberId: null,
        actorKind: "PIC",
        picProfileId: picProfile.id,
    };
}

/**
 * Resolve the actor's authority to admit at one event.
 *
 * Two independent gates, both database-derived:
 *   1. the organizer path (unchanged): `checkin.scan` inside the event's own organizer, and for a
 *      member without `checkin.override` an active `StaffEventAssignment`;
 *   2. the PIC path (Phase 3D): only after an authorization refusal above, an ACTIVE PIC profile
 *      with an active, non-revoked assignment for this exact event.
 */
export async function requireEventCheckInAccess(
    eventId: string
): Promise<CheckInAccess> {
    try {
        return await requireOrganizerCheckInAccess(eventId);
    } catch (error) {
        if (!isAccessRefusal(error)) {
            throw error;
        }

        return requirePicCheckInAccess(eventId, error);
    }
}

/**
 * ==========================================
 * PHASE 3E — THE SCANNER PAGE'S SERVER-SIDE GATE
 * ==========================================
 *
 * A page cannot call `requireEventCheckInAccess`: that guard prefers the organizer path and
 * only falls back to PIC after a tenant refusal, which is right for the API but would let an
 * organizer member open the PIC scanner page. This entry point asks ONLY the PIC question —
 * the session user's own ACTIVE profile plus an active, non-revoked assignment for this event,
 * decided by the Phase 3A decider — and answers a masked 404 for every refusal, so the page
 * never reveals whether an event exists.
 */
export async function requirePicScanAccess(
    eventId: string
): Promise<CheckInAccess> {
    return requirePicCheckInAccess(
        eventId,
        new AuthzError(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            "PIC scanner page: no access to this event"
        )
    );
}

/**
 * Normalise a presented code to its stored form, or `null` when it cannot be one.
 *
 * Accepts either the bare code (`EVT-XXXX-XXXX`) or the wallet QR payload
 * (`TICKET:EVT-XXXX-XXXX`). Anything else is `null`, and the caller answers `NOT_FOUND`
 * so that "malformed" and "unknown" are indistinguishable (design §20.2 check 1).
 */
export function normalizeCode(raw: string): string | null {
    // PHASE 3C: the parsing is the Phase 3B parser's — one implementation, so the gate and
    // this compatibility surface cannot disagree about what a ticket reference is. The `null`
    // collapse is kept because that is the contract Phase 13's tests and callers pin.
    const parsed = parseCheckInQrPayload(raw);

    return parsed.valid ? parsed.ticketCode : null;
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
    const { scope, event, memberId, actorKind, picProfileId } =
        await requireEventCheckInAccess(params.eventId);

    /*
     * PHASE 3F: the PIC scan allowance is spent before the first ticket query. The key
     * is the authenticated user and the authorized event only — `params.input` is never
     * part of it, so client-controlled fields cannot choose or reset a bucket. The
     * organizer path is deliberately untouched.
     */
    if (actorKind === "PIC") {
        enforcePicScanRateLimit({
            userId: scope.userId,
            eventId: event.id,
        });
    }

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
            afterState: {
                reason: input.reason,
                result: input.result,
                actorKind,
                picProfileId,
            },
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

    const presented = parseCheckInQrPayload(params.input.code);

    if (!presented.valid) {
        // Every refusal reason gets the SAME answer. The classification exists for operators
        // reading the audit row; the caller must not be able to tell a malformed payload from
        // an unknown ticket (design §20.2 check 1), or the error shape becomes an oracle.
        throw await refuse({
            result: "INVALID_TICKET",
            note: "UNRECOGNIZED_CODE_FORMAT",
            reason: "INVALID_TICKET_FORMAT",
            error: AppError.notFound("Tiket tidak ditemukan."),
        });
    }

    const code = presented.ticketCode;

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
                        firstCheckedInBy:
                            actorKind === "PIC"
                                ? null
                                : (first?.checkedInBy?.name ?? null),
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

    /*
     * REALTIME: announced AFTER the admission transaction resolved, and ONLY for an accepted
     * admission.
     *
     * A REFUSED scan is deliberately silent. The attendance list this invalidates reads
     * `result: "SUCCESS"` rows only, so a refusal changes no page it would tell anyone about — and a
     * busy gate producing hundreds of bad scans per hour would otherwise generate hundreds of
     * useless invalidations. That is the difference between over-invalidating (safe but wasteful)
     * and a storm (wasteful enough to matter).
     */
    publishTicketCheckedIn({
        ticketId: ticket.id,
        eventId: gate.id,
        organizerId: gate.organizerId,
        ticketOwnerUserId: ticket.holderUserId,
    });

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
            // PHASE 3F: durable, server-derived attribution. No participant data, no
            // photo, no raw QR payload and no token is added here.
            actorKind,
            picProfileId,
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
