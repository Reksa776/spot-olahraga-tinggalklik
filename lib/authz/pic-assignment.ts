import type { PICStatus } from "@prisma/client";

import { AuthzErrorCode } from "./errors";

/**
 * ==========================================
 * PHASE 3A — PIC ASSIGNMENT-BASED SCANNING AUTHORITY
 * ==========================================
 *
 * A PIC may admit tickets at an event **only** while holding an ACTIVE `PICProfile` AND an
 * active, non-revoked `PICEventAssignment` for **that exact event**. This module is that
 * rule and nothing else.
 *
 * ── WHY THIS IS NOT PART OF `decideOrganizerPermission` ─────────────────────────
 * A PIC's authority is not a weaker form of tenant membership; it is a different axis.
 * `decideOrganizerPermission` answers "may this actor act inside this ORGANIZER", derived
 * from an ACTIVE `OrganizerMember` row and the role maps. A PIC has no membership, and an
 * event assignment is not a membership: it is scoped to one event id, it carries its own
 * activation and revocation state, and it must never resolve to anything organizer-wide.
 * Folding it into the organizer decider would make one of the four plausible mistakes in
 * the Phase 3 pre-implementation audit (§4.3) reachable — accepting an `OWN` scope there,
 * adding the capability to a PIC role map, honouring a `PermissionGrant`, or treating "some
 * assignment" as "this event". Keeping the two deciders separate makes each refusal
 * independently provable, and keeps a PIC's authority structurally unable to widen.
 *
 * ── WHY THE INPUT IS SNAPSHOTS, NOT A DATABASE HANDLE ───────────────────────────
 * The decider is PURE by contract: no Prisma client, no session, no network, no filesystem,
 * no environment, no module state, and no mutation of its argument. Loading the profile and
 * the assignment is the caller's job (a later phase), which is what lets this rule be tested
 * as a table without a database and keeps an authorization decision free of I/O.
 *
 * ── FAIL-CLOSED ─────────────────────────────────────────────────────────────────
 * Every branch below ends in an explicit allow or an explicit deny; an unknown, missing,
 * partial or malformed input denies. There is no default-allow path, and `isActive` must be
 * the boolean `true` (not a truthy value) for the assignment to count.
 *
 * ── THE GUARANTEE THIS DOES **NOT** PROVIDE ─────────────────────────────────────
 * This decision authorizes an ACTOR to perform a scan at an event. It says nothing about
 * whether a presented ticket code is authentic: per owner decision B-2, the public ticket
 * code remains the admission LOOKUP credential (D-46 Option A), and it does not prove the
 * identity of its holder. Do not describe this module as QR authenticity validation.
 *
 * The PIC QR scanning row is an owner-approved amendment to
 * `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §17 PIC Access, which locks the
 * design's §6.3 matrix; see
 * `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` §14 and
 * `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md`. PIC manual check-in override
 * and PIC attendance-log access remain NO and are NOT expressible here.
 */

/** An already-resolved `PICProfile` snapshot. Read, never written. */
export type PicProfileSnapshot = {
    readonly id: string;
    readonly userId: string;
    readonly status: PICStatus;
};

/**
 * An already-resolved `PICEventAssignment` snapshot for the requested event.
 *
 * `revokedAt` is `Date | null` and is compared strictly against `null`: an `undefined` that
 * arrives from a partial database select is refused rather than treated as "not revoked".
 */
export type PicAssignmentSnapshot = {
    readonly picProfileId: string;
    readonly eventId: string;
    readonly isActive: boolean;
    readonly revokedAt: Date | null;
};

/**
 * Everything the decision needs, and nothing else — deliberately no organizer id, no
 * membership list, no permission grant, and no `AuthzScope`. A caller therefore cannot
 * widen a PIC's authority by supplying one.
 */
export type PicScanAuthorizationInput = {
    /** The authenticated user id from the server-side session. */
    readonly userId?: string | null;
    /** The caller's own PIC profile, if any. */
    readonly picProfile?: PicProfileSnapshot | null;
    /** The event the scan is being attempted at. */
    readonly eventId?: string | null;
    /** The assignment row for that PIC profile and that event, if any. */
    readonly assignment?: PicAssignmentSnapshot | null;
};

export type PicScanAuthorizationDecision =
    | {
          readonly allowed: true;
          /** The verified PIC profile id, for the caller's own audit/attribution use. */
          readonly picProfileId: string;
      }
    | {
          readonly allowed: false;
          readonly code: AuthzErrorCode;
          /** Server-side detail only. Never rendered to the client. */
          readonly reason: string;
      };

function allow(picProfileId: string): PicScanAuthorizationDecision {
    return { allowed: true, picProfileId };
}

function deny(
    code: AuthzErrorCode,
    reason: string
): PicScanAuthorizationDecision {
    return { allowed: false, code, reason };
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

/**
 * May this PIC scan tickets at this event?
 *
 * Refusal codes, chosen so the refusal shape matches an existing contract:
 *
 *   UNAUTHORIZED (401)            no authenticated actor
 *   NOT_FOUND (404)               the requested event id is missing or empty
 *   PIC_ACCESS_DENIED (403)       no PIC profile, another user's profile, or a profile that
 *                                 is not ACTIVE (PENDING / SUSPENDED / REJECTED)
 *   ORGANIZER_ACCESS_DENIED (404) no assignment for this exact event, an inactive one, a
 *                                 revoked one, or one belonging to a different PIC profile
 *
 * Assignment refusals deliberately reuse `ORGANIZER_ACCESS_DENIED`, which maps to **404**,
 * so a PIC cannot use the response to learn whether an unassigned event exists. That is the
 * same masking the tenant guard applies to a non-member.
 */
export function decidePicEventPermission(
    input: PicScanAuthorizationInput | null | undefined
): PicScanAuthorizationDecision {
    if (!input) {
        return deny(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            "authorization context missing"
        );
    }

    if (!isNonEmptyString(input.userId)) {
        return deny(AuthzErrorCode.UNAUTHORIZED, "no authenticated user");
    }

    if (!isNonEmptyString(input.eventId)) {
        return deny(AuthzErrorCode.NOT_FOUND, "event id missing");
    }

    const profile = input.picProfile;

    if (!profile || !isNonEmptyString(profile.id)) {
        return deny(AuthzErrorCode.PIC_ACCESS_DENIED, "no PIC profile");
    }

    if (!isNonEmptyString(profile.userId) || profile.userId !== input.userId) {
        return deny(
            AuthzErrorCode.PIC_ACCESS_DENIED,
            "PIC profile does not belong to the authenticated user"
        );
    }

    if (profile.status !== "ACTIVE") {
        return deny(
            AuthzErrorCode.PIC_ACCESS_DENIED,
            `PIC profile status is ${String(profile.status)}`
        );
    }

    const assignment = input.assignment;

    if (!assignment) {
        return deny(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            "no PIC assignment for the requested event"
        );
    }

    if (
        !isNonEmptyString(assignment.picProfileId) ||
        assignment.picProfileId !== profile.id
    ) {
        return deny(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            "assignment belongs to a different PIC profile"
        );
    }

    if (assignment.eventId !== input.eventId) {
        return deny(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            "assignment is for a different event"
        );
    }

    if (assignment.isActive !== true) {
        return deny(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            "assignment is not active"
        );
    }

    if (assignment.revokedAt !== null) {
        return deny(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            "assignment has been revoked"
        );
    }

    return allow(profile.id);
}
