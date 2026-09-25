import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import type { AuthzScope } from "@/lib/authz/permissions";
import { getClientIp } from "@/lib/rate-limit";

/**
 * ==========================================
 * TICKETING AUDIT LOG
 * ==========================================
 *
 * Brief §22 requires audit entries for event create/update/publish/unpublish/delete,
 * venue create/update/delete and sport administration. Design §32.2 extends
 * `AdminAuditLog` with `actorType`, `actorUserId`, `actorRole`, `actorOrganizerId`,
 * `organizerId`, `entityRef`, `beforeState`, `afterState`, `reason`, `ipAddress`,
 * `userAgent` and `correlationId` — Phase 2 created those columns additively.
 *
 * WHY BOTH THE LEGACY AND NEW COLUMNS ARE WRITTEN
 * -----------------------------------------------
 * `AdminAuditLog.adminId` is `String` NOT NULL and was introduced for the retail code, so
 * it cannot be omitted even though those writers are gone. It is set to the real acting
 * user id here rather than to one of the `"SYSTEM"` / `"PROVIDER"` sentinels the design
 * criticises (§32.1) — the overload is avoided rather than repeated. `actorType` is always
 * `USER` in Phase 4 because
 * every audited operation in this phase is user-initiated; the SYSTEM/PROVIDER/JOB
 * values exist for later phases.
 *
 * `entityId` is an `Int` column inherited from the retail rows and cannot be widened, so —
 * exactly
 * as the Phase 2 comment on the model instructs — the cuid-keyed ticketing entity is
 * recorded in the additive `entityRef` column instead.
 *
 * NEVER LOGGED (brief §22): passwords, authorization headers, tokens, QR secrets,
 * provider secrets, KTP or other documents, and unnecessary buyer PII. Callers pass
 * an explicit `beforeState` / `afterState` containing only the fields that changed;
 * a defensive key filter runs on top so an accidental `password` key cannot reach the
 * table.
 */

export type TicketingAuditAction =
    | "event.create"
    | "event.update"
    | "event.publish"
    | "event.unpublish"
    // ── PHASE 12: the wider event lifecycle ─────────────────────────────────────
    // Cancellation and archival are the two lifecycle actions design §10.3 defines but
    // that no earlier phase wrote. Each gets its own action name rather than reusing
    // `event.unpublish`, because they are materially different events: unpublishing
    // only hides listings (D-14), while cancelling stops sales and expires unpaid
    // orders, and archiving is the soft delete that hides the event from every public
    // surface. An auditor reconstructing "when did this event die, and who did it?"
    // must be able to filter on the exact action.
    | "event.cancel"
    | "event.archive"
    | "event.delete"
    // ── PHASE 15: the two time-driven lifecycle transitions (P14-D21) ─────────────
    // `event.ongoing` and `event.complete` are written by the DB-backed tick (JOB 1) and by
    // the manual completion action. Both are real writers, and they are separate names
    // because they are separate facts an auditor reconstructs "when did this event run, and
    // when was it over?" from — a single `event.status_change` would force that reader to
    // parse a status field instead of filtering by the action.
    //
    // A tick that transitions nothing writes NO audit row (a 1-minute cron would otherwise
    // produce 1440 meaningless rows a day). The run itself is observable through
    // `JobLock.lastRunAt` / `lastStatus` and the tick response.
    | "event.ongoing"
    | "event.complete"
    | "event.image.add"
    | "event.image.remove"
    | "venue.create"
    | "venue.update"
    | "venue.delete"
    | "sport.create"
    | "sport.update"
    | "sport.delete"
    // ── PHASE 5: ticket inventory ─────────────────────────────────────────────
    // Quota, price and activation get their OWN action names rather than folding into
    // `ticket_type.update`, because they are separately permissioned capabilities
    // (`ticket_type.quota.change` / `ticket_type.price.change` / `ticket_type.write`)
    // and are the changes an auditor or a finance reviewer will look for by name. A
    // single request that changes both quota and price therefore writes two rows: the
    // traceability is worth more than the row count.
    | "ticket_type.create"
    | "ticket_type.update"
    | "ticket_type.quota_change"
    | "ticket_type.price_change"
    | "ticket_type.activate"
    | "ticket_type.deactivate"
    | "ticket_type.delete"
    // ── PHASE 6: reservations and orders ─────────────────────────────────────
    // The customer-side counterpart of the organiser actions above. `order.create`
    // records the commercial fact (what was bought, at what price, on whose event) at
    // the moment it becomes true, and `order.cancel` / `order.expire` record the
    // inventory consequence, because those are the two events a reconciliation — or a
    // dispute about whether seats were returned — will be reconstructed from.
    //
    // `reservation.release` is deliberately NOT a separate action: releasing seats is a
    // step *inside* cancelling or expiring an order, and a second row per step would
    // make the audit trail look like more transactions happened than actually did.
    | "order.create"
    | "order.cancel"
    | "order.expire"
    // ── PHASE 7: the payment boundary ────────────────────────────────────────────
    // Design §32.3 does not enumerate payment actions (its table starts at `fee.adjust`
    // and `refund.*`), and §32.2 defines `action` as a *namespaced string* rather than a
    // closed vocabulary. These four follow that convention and are the minimum needed to
    // reconstruct a money trail: a session opened, money confirmed, money refused by the
    // provider, and a session voided. Brief §23 names `payment.create`, `payment.success`,
    // `payment.failed` and `payment.expired` as the candidate set; no further action was
    // invented (there is deliberately no `payment.read`, because reads of one's own order
    // are not privileged financial events).
    //
    // Ticket issuance, refunds, PIC fees and settlement payouts are NOT here: they belong
    // to Phases 8-16 and are out of this phase's scope.
    | "payment.create"
    | "payment.success"
    | "payment.failed"
    | "payment.expired"
    // ── PHASE 27E: operator-triggered reconciliation ─────────────────────────────
    // The sixth payment action, and the only one whose actor is a human who was NOT a
    // party to the payment. It records that an operator asked the provider for the
    // authoritative status of an existing transaction and what came back.
    //
    // It is deliberately NOT `payment.success`. That action is written by settlement
    // itself, once, from the verified evidence — whoever triggered it. If reconciliation
    // also wrote `payment.success` there would be two rows claiming the same money event
    // and no way to tell "the webhook arrived" from "an operator chased it", which is
    // exactly the question an incident review asks first (Phase 27B: the provider was
    // paid, the callback never arrived, and nothing recorded that anyone noticed).
    | "payment.reconcile"
    // ── PHASE 10B: the refund lifecycle ──────────────────────────────────────────
    // Five actions, one per state change that an auditor reconstructs a refund from: the
    // buyer's request, the two staff decisions, the confirmed settlement and the failure.
    // They are separate names rather than a single `refund.update` because they have
    // different actors (buyer, staff, provider) and different money consequences; a reader
    // filtering "who approved this refund?" must not have to parse a state field.
    //
    // A provider-confirmed refund is recorded as `refund.settle` with the `PROVIDER` actor
    // marker, exactly as `payment.success` is (design §32.1), rather than as a second
    // action name for the same fact.
    //
    // ── PHASE 18B: the manual bank-transfer rail (D-P17-04 = B) ──────────────────
    // `refund.process` is the sixth action: the operator's `APPROVED -> PROCESSING`
    // claim, written when a human has taken a refund in hand to make the transfer.
    // It is deliberately NOT folded into `refund.settle`, because under the manual
    // rail PROCESSING must NOT be read as "money moved" — only `refund.settle`, which
    // now requires recorded transfer evidence, may say that.
    | "refund.request"
    | "refund.approve"
    | "refund.reject"
    | "refund.process"
    | "refund.settle"
    | "refund.fail"
    /** The transfer-evidence FILE attached to a refund; no money moves and no status changes. */
    | "refund.evidence_upload"
    // ── PHASE 8: ticket fulfilment ───────────────────────────────────────────────
    // One action, not four. Issuance is the only ticket transition Phase 8 performs:
    // the status stays `ISSUED` afterwards and reissue/void belong to later phases
    // (design §19.5 lists `ticket.reissue` / `ticket.void`, neither of which is built
    // here). Declaration without a writer would be the same \"vocabulary invented for
    // symmetry\" the earlier phases avoided.
    | "ticket.issue"
    // ── PHASE 13: gate admission ─────────────────────────────────────────────────
    // Two actions, both real writers. `checkin.success` records an accepted admission;
    // `checkin.rejected` records a refusal the gate could not record as an accepted
    // `CheckIn` row (a forged/unknown code, a wrong event, a non-issued ticket, or a
    // closed gate). The `CheckIn` table additionally carries accepted rows and duplicate
    // attempts, so a reviewer sees both "who got in" and "what was turned away".
    //
    // There is deliberately NO `checkin.override`: admitting without a valid ticket is a
    // distinct capability (`checkin.override`) that Phase 13 did not implement, and
    // declaring an action with no writer is the "vocabulary invented for symmetry" that
    // earlier phases rejected.
    | "checkin.success"
    | "checkin.rejected"
    // ── PIC management ───────────────────────────────────────────────────────────
    // These belong to the PIC surface that replaces the deleted retail Affiliate
    // programme. They are platform-level (profile lifecycle) and organizer-level
    // (event assignment) actions, and each one is a distinct authority: creating a
    // profile, approving/suspending it, attaching it to an event and taking it off
    // again. `pic.assign.reactivate` is separate from `pic.assign` because the schema
    // makes (picProfileId, eventId) unique, so re-assigning a previously revoked
    // pairing UPDATEs the existing row — an auditor reconstructing "when did this PIC
    // start covering this event?" needs to see that it was a reinstatement rather
    // than a first assignment.
    | "pic.create"
    | "pic.status.update"
    // ── PHASE 33: user management ────────────────────────────────────────────────
    // The ADMIN-only account lifecycle the new /dashboard/users surface writes:
    // creation of the two managed roles (a PIC creation is named distinctly from a
    // MANAGER creation, because it also mints the PICProfile) and the reversible
    // disable/enable pair. There is deliberately no `user.delete`: deactivation is the
    // only removal this product performs, and no action name may promise otherwise.
    // Credentials are never metadata: the audit writer's key filter already drops
    // `password`/`passwordHash`, and the callers pass only ids, emails and role names.
    | "user.created"
    | "pic.user.created"
    | "user.disabled"
    | "user.enabled"
    | "pic.assign"
    | "pic.assign.reactivate"
    | "pic.assign.revoke"
    // ── PICO payout / settlement V1 (manual bank transfer) ───────────────────────
    // Seven actions, one per state change an auditor reconstructs a payout from.
    // They are separate names rather than a single `settlement.update` because they
    // have different actors and different money consequences: `prepare` snapshots the
    // payee bank and claims the fee lines, `submit` asks for approval, `approve`
    // authorises the transfer, `paid` is the ONLY action that moves money out of the
    // system (ledger SETTLED + PAYOUT debit rows), and `failed` / `cancel` are the two
    // ways a claim is released without money moving. `proof_upload` records the
    // transfer evidence — the manual-rail counterpart of `refund.settle`'s
    // `providerRef`.
    //
    // There is deliberately NO `settlement.process`: the method is MANUAL_TRANSFER
    // (D-P17-04 = B), so there is no in-flight processing state to audit.
    | "settlement.prepare"
    | "settlement.submit"
    | "settlement.approve"
    | "settlement.proof_upload"
    | "settlement.paid"
    | "settlement.failed"
    | "settlement.cancel"
    // ── PHASE 31: financial report exports ─────────────────────────────────────
    // An export copies financial rows OUT of the system, which is itself an auditable
    // event ("who downloaded whose fee ledger, and when"). The two scopes get distinct
    // action names so a reviewer can tell a PIC's own download apart from an organizer /
    // platform-side tenant export without parsing metadata.
    | "report.export.pic_fee"
    | "report.export.own_pic_fee"
    // ── PHASE 32: application control (ADMIN only) ───────────────────────────────
    // Maintenance availability and branding are the two things this phase lets an
    // operator change about the APPLICATION rather than about business data, and both
    // are consequential enough (one closes the storefront, the other rewrites the
    // identity every public page renders) that §22 requires an audit entry for each.
    //
    // The enable/disable pair is split from `application.maintenance.updated` for the
    // same reason `settlement.paid` is split from `settlement.prepare`: "when was the
    // site taken down, and by whom?" and "who rewrote the maintenance notice?" are two
    // different incident questions, and folding them into one action would force the
    // reader to parse `afterState`.
    //
    // The logo pair is split into `uploaded` / `replaced` / `removed` rather than being
    // one `branding.logo.changed`, because `replaced` is the only one of the three that
    // implies a previous asset existed — which is exactly what a reviewer asks when a
    // logo changes unexpectedly.
    | "application.maintenance.enabled"
    | "application.maintenance.disabled"
    | "application.maintenance.updated"
    | "application.branding.logo_uploaded"
    | "application.branding.logo_replaced"
    | "application.branding.logo_removed";

/** Keys that must never reach the audit table, whatever a caller passes. */
const FORBIDDEN_METADATA_KEYS = new Set([
    "password",
    "passwordhash",
    "token",
    "accesstoken",
    "refreshtoken",
    "secret",
    "apikey",
    "authorization",
    "cookie",
    "qrcode",
    "qrtoken",
    "ktp",
    "ktpimage",
    "ktpimagebase64",
    "bankaccountnumber",
]);

/**
 * Strip forbidden keys, then narrow to the JSON shape Prisma accepts.
 *
 * Callers pass already-serialisable values (strings, numbers, booleans, null, ISO
 * date strings), so the cast is safe and keeps every `beforeState` / `afterState`
 * column to plain JSON rather than a live object graph that could hold a Prisma model.
 */
function sanitize(
    value: Record<string, unknown> | null | undefined
): Prisma.InputJsonObject | undefined {
    if (!value) {
        return undefined;
    }

    const out: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(value)) {
        if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
            continue;
        }

        if (raw === undefined) {
            continue;
        }

        out[key] = raw;
    }

    return Object.keys(out).length > 0
        ? (out as Prisma.InputJsonObject)
        : undefined;
}

export type TicketingAuditParams = {
    action: TicketingAuditAction;
    /**
     * The resolved actor. `platformRole` is snapshotted, since roles change.
     *
     * Omitted ONLY by job-driven actions (§11.4's expiry reaper), which must then declare
     * `actorType: "SYSTEM"`. Passing a sentinel *user* id instead was rejected by the
     * design's own §32.1 criticism of overloading `adminId` with `"SYSTEM"` — so the
     * distinction is an explicit column value here, not a magic string in a USER row.
     */
    actor?: AuthzScope;
    /**
     * Defaults to `USER` when an actor is supplied, and is REQUIRED otherwise.
     *
     * `PROVIDER` was added in Phase 7 for the webhook-driven settlement transitions. The
     * Prisma enum already had the value (design §32.2's `USER | SYSTEM | PROVIDER | JOB`
     * became `USER | SYSTEM | PROVIDER | ADMIN | PIC | MANAGER` in the accepted Phase 2
     * schema); what was missing was the logger's ability to write it. This is precisely the
     * remediation §32.1 asks for — the legacy `adminId = "PROVIDER"` sentinel stays (the
     * column is `NOT NULL` and retail code shares it), and the *reason* it is a sentinel is
     * now recorded in a dedicated column instead of being implied by a magic string.
     */
    actorType?: "USER" | "SYSTEM" | "PROVIDER";
    /** The tenant the actor acted *as*. Null for platform-level operations. */
    actorOrganizerId?: string | null;
    /** The tenant the affected row belongs to. Null for global venues/sports. */
    organizerId?: string | null;
    entityType:
        | "Event"
        | "EventImage"
        | "Venue"
        | "Sport"
        | "TicketType"
        | "EventOrder"
        | "Payment"
        /** Phase 8. `entityRef` carries the ORDER number, since one call issues N rows. */
        | "Ticket"
        /** PIC surface: the profile row and the event-assignment row. */
        | "PICProfile"
        | "PICEventAssignment"
        /** Payout/settlement V1: a `Settlement` row or a `PICFeeLedger` mutation. */
        | "Settlement"
        | "PICFeeLedger"
        /** Phase 31: a financial report/export (a read that leaves the system). */
        | "Report"
        /** Phase 32: the single-row platform configuration (maintenance + branding). */
        | "PlatformSetting"
        /** Phase 33: a User account created or (de)activated by user management. */
        | "User";
    /** cuid of the affected row (goes into `entityRef`). */
    entityRef?: string | null;
    description: string;
    beforeState?: Record<string, unknown> | null;
    afterState?: Record<string, unknown> | null;
    reason?: string | null;
    /** Used only for `ipAddress` / `userAgent`. Never logged wholesale. */
    request?: Request;
};

/**
 * Append one audit row, on the given database handle (a transaction or `prisma`).
 *
 * Shared by the fire-and-forget writer and the tx-aware writer so the two cannot
 * drift into different column sets.
 */
async function createAuditRow(
    params: TicketingAuditParams,
    db: Prisma.TransactionClient | typeof prisma
): Promise<void> {
    const beforeState = sanitize(params.beforeState);
    const afterState = sanitize(params.afterState);

    const actorType = params.actorType ?? (params.actor ? "USER" : "SYSTEM");

    if (actorType === "USER" && !params.actor) {
        throw new Error(
            "writeTicketingAudit: a USER action must name its actor"
        );
    }

    await db.adminAuditLog.create({
        data: {
            // Legacy NOT NULL column. Carries the real actor for a user-driven action;
            // for a system or provider action it carries the corresponding explicit
            // marker, because the column cannot be null and the alternative would be
            // inventing a user id. `actorType` below is what makes the marker
            // unambiguous (design §32.1's criticism of the overloaded column).
            adminId:
                params.actor?.userId ??
                (actorType === "PROVIDER" ? "PROVIDER" : "SYSTEM"),
            action: params.action,
            entityType: params.entityType,
            entityRef: params.entityRef ?? null,
            description: params.description,

            actorType,
            actorUserId: params.actor?.userId ?? null,
            actorRole: params.actor?.platformRole ?? null,
            actorOrganizerId: params.actorOrganizerId ?? null,
            organizerId: params.organizerId ?? null,

            ...(beforeState ? { beforeState } : {}),
            ...(afterState ? { afterState } : {}),
            ...(params.reason ? { reason: params.reason } : {}),

            ...(params.request
                ? {
                      ipAddress: getClientIp(params.request),
                      userAgent:
                          params.request.headers.get("user-agent") ?? null,
                  }
                : {}),
        },
    });
}

/**
 * Append one audit row.
 *
 * Fire-and-forget by convention, matching the existing
 * `lib/admin/audit-log.ts#createAuditLog`: an audit write must not fail the business
 * operation it describes, and a thrown audit error in a non-financial path would roll
 * back a legitimate change. The failure is logged loudly instead.
 *
 * MONEY EVENTS USE `writeTicketingAuditInTx` INSTEAD. A payout settlement is a financial
 * action: the design's strong-audit requirement (durable audit in the same transaction
 * as the money movement, brief §22 / §32) is why the in-transaction variant exists and
 * why it does NOT swallow errors — there, a failed audit write rolls the money movement
 * back rather than leaving an unprovable transaction.
 */
export async function writeTicketingAudit(
    params: TicketingAuditParams
): Promise<void> {
    try {
        await createAuditRow(params, prisma);
    } catch (error) {
        console.error("TICKETING_AUDIT_LOG_ERROR:", error);
    }
}

/**
 * Append one audit row inside the caller's transaction, with throw-on-failure
 * semantics — the money equivalent of a double-entry journal, where the audit line is
 * part of the same committed fact as the debit/credit it records.
 *
 * Distinct from the fire-and-forget `writeTicketingAudit`: a financial transition that
 * cannot record itself must not happen. Used exclusively by the payout/settlement V1
 * transactional core for `settlement.paid`, `settlement.failed` and `settlement.cancel`
 * (and by `settlement.prepare` for the claim), where reverting the row change when the
 * audit line fails is the correct failure mode.
 */
export async function writeTicketingAuditInTx(
    params: TicketingAuditParams,
    tx: Prisma.TransactionClient
): Promise<void> {
    await createAuditRow(params, tx);
}
