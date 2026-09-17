import type {
    OrganizerMemberRole,
    OrganizerMemberStatus,
    PlatformRole,
} from "@prisma/client";

import { AuthzErrorCode } from "./errors";

/**
 * ==========================================
 * PHASE 3 — PERMISSION VOCABULARY & DECISION
 * ==========================================
 *
 * Implements design §6.4 **Option B**: permission strings resolved from a static
 * role→permission map plus tenant membership. Option B was the design's
 * recommendation over both hard-coded role checks (Option A — today's pattern,
 * which cannot express SCOPED or approvals) and full RBAC tables (Option C —
 * over-engineered for six roles).
 *
 * This module is PURE. It imports no database, no NextAuth and no `next/server`,
 * so every rule below is unit-testable without a database and cannot perform I/O
 * as a side effect of an authorization check.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE APPROVED DECISIONS THIS FILE ENCODES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * **D-05 = single organizer at launch.**
 *   TinggalKlik.Co is the sole Organizer; PICs are external referrers; there is
 *   no organizer self-onboarding and no tenant-level admin tier. Consequently
 *   `OrganizerMemberRole.ADMIN` — which the brief suggested and Phase 2 created —
 *   is NOT mapped to any capability here. It is deliberately absent from
 *   `MEMBERSHIP_ROLE_PERMISSIONS`, so an actor holding it resolves to **zero**
 *   organizer permissions (fail closed) rather than to an invented privilege.
 *   Changing D-05 to a self-service marketplace is therefore a visible, local
 *   edit to one map plus one migration — not a silent behaviour change.
 *
 * **D-19 = grant-required (Admin holds no financial power by default).**
 *   See `ADMIN_GRANT_REQUIRED`. The brief's constraint — "Admin must not freely
 *   change fees / transaction amounts / settlements / the ledger" — is expressed
 *   structurally: those permissions are absent from `PLATFORM_ROLE_ORGANIZER_
 *   PERMISSIONS.ADMIN` and can only be satisfied by an explicit
 *   `PermissionGrant` row. There is no permission for editing an order's amount
 *   or a ledger entry, for any role, so those actions are unreachable.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INTERSECTION RULE, AS INTERPRETED
 * ─────────────────────────────────────────────────────────────────────────────
 * Design §5.2: "Effective permission = intersection of (platform role capability)
 * and (tenant membership scope), never the union of loose grants."
 *
 * Interpreted as: an organizer-scoped action requires **both** a *capability
 * source* **and** a *scope*, and neither alone is sufficient.
 *
 *   scope      = an ACTIVE `OrganizerMember` row for that organizer.
 *                Without it, no organizer-scoped permission resolves — for every
 *                role, including ADMIN and MANAGER.
 *   capability = the platform role's map, OR the membership role's map, OR an
 *                explicit active grant for that organizer.
 *
 * The strict "membership required for everyone" reading is deliberate. §6.3
 * marks Admin's and Manager's tenant-level rows `SCOPED`, whose legend is
 * "restricted to the actor's assigned tenant", while §5.3 loosely says a platform
 * MANAGER spans "all tenants". The two cannot both hold. Phase 3 adopts the
 * stricter one because it is what §7.4 and §16 state as a hard security
 * requirement ("Organizer A must never access Organizer B", "even if it knows the
 * resource ID"). If the business later wants a role that spans tenants, that is
 * the single documented switch below — `ORGANIZER_SPANNING_PLATFORM_ROLES` — and
 * it is empty today.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Permission strings, `resource.action` per the design's §6.4 naming convention.
 *
 * The design names these examples explicitly: `event.publish`,
 * `ticket_type.update`, `fee.rate.change`, `fee.adjust`, `settlement.prepare`,
 * `settlement.approve`, `report.export.financial`, `user.manage`, `role.manage`,
 * `checkin.scan`, `checkin.override`. The remaining keys follow that same
 * convention for the §6.2/§6.3 rows the design describes but does not spell out.
 *
 * Permissions the design marks `NO` for every role — "Edit order amounts",
 * "Alter payment amount", and every ledger mutation — are deliberately ABSENT.
 * They are unreachable because an unknown permission always denies.
 */
export const PERMISSIONS = {
    // Catalog
    EVENT_READ: "event.read",
    EVENT_WRITE: "event.write",
    EVENT_PUBLISH: "event.publish",
    EVENT_BANNER_UPLOAD: "event.banner.upload",
    SPORT_MANAGE: "sport.manage",
    VENUE_MANAGE: "venue.manage",
    /**
     * PHASE 4 (decision D-64). Managing a **platform-global** venue
     * (`Venue.organizerId = null`) is platform master data, like sports, and D-64
     * requires it be "restricted to the appropriate platform-level Admin
     * permission" — which did not exist in the Phase 3 vocabulary.
     *
     * It is deliberately a SEPARATE string from `VENUE_MANAGE` rather than the same
     * permission moved to platform scope. `PERMISSION_SCOPE` maps each permission to
     * exactly one scope, so reusing `venue.manage` would either make tenant venue
     * management platform-only (breaking organizer workflows) or make global venues
     * tenant-scoped (breaking D-64's isolation rule). Two strings keep the two
     * ownership classes independently grantable, which is what D-64's "BOTH" answer
     * requires.
     */
    VENUE_MANAGE_GLOBAL: "venue.manage.global",

    // Ticket inventory
    TICKET_TYPE_WRITE: "ticket_type.write",
    TICKET_TYPE_QUOTA_CHANGE: "ticket_type.quota.change",
    TICKET_TYPE_PRICE_CHANGE: "ticket_type.price.change",

    // Orders
    ORDER_READ_TENANT: "order.read.tenant",
    ORDER_READ_OWN: "order.read.own",
    ORDER_CANCEL: "order.cancel",
    /**
     * PHASE 6. Design §12.3 names this string for the buyer's own cancellation:
     *
     *   `PENDING_PAYMENT → CANCELLED` | Who: "Buyer (`order.cancel.own`),
     *   Manager/Admin"
     *
     * It is a SEPARATE string from `order.cancel` because the two are different
     * authority dimensions, which is the whole point of the own-scope/organizer-scope
     * split: a customer cancels an order **they own**, whereas `order.cancel` lets a
     * tenant member cancel any unpaid order in their organizer. Folding them together
     * would mean either granting every customer tenant-wide cancel rights or granting
     * staff nothing. The Phase 3 own-scope machinery already supports this shape (`OWN`
     * scope + an ownership predicate), so no new mechanism is introduced.
     */
    ORDER_CANCEL_OWN: "order.cancel.own",

    // Payment
    PAYMENT_READ_TENANT: "payment.read.tenant",
    PAYMENT_READ_OWN: "payment.read.own",
    PAYMENT_RECONCILE: "payment.reconcile",

    /**
     * PHASE 8 — the buyer's own tickets.
     *
     * Design §26.5/§26.6 specify both wallet endpoints as \"Ownership enforced
     * (`holderUserId = session.user.id`)\", which is precisely the OWN scope the Phase 3
     * machinery already provides, and the same shape as `order.read.own` /
     * `payment.read.own`. The design's ticket-scoped *vocabulary* (`ticket.reissue`,
     * `ticket.void`, lines 2805-2806) is entirely organiser-side and belongs to later
     * phases; no customer ticket capability was pre-named, so these two strings are added
     * to the centralized map rather than a second authority system being introduced.
     */
    TICKET_READ_OWN: "ticket.read.own",
    /**
     * Materialise the tickets of one's OWN paid, fulfilment-eligible order.
     *
     * Separate from `ticket.read.own` because it is a state-changing fulfilment action,
     * not a read — the same distinction `order.cancel.own` draws against
     * `order.read.own`. It confers no authority over anyone else's order: the ownership
     * predicate is still applied to the resolved row (see `lib/ticketing/tickets/`).
     */
    TICKET_ISSUE_OWN: "ticket.issue.own",

    // Refund
    REFUND_REQUEST: "refund.request",
    REFUND_APPROVE: "refund.approve",
    REFUND_EXECUTE: "refund.execute",

    // PIC
    PIC_MANAGE: "pic.manage",
    PIC_ASSIGN: "pic.assign",
    PIC_ATTRIBUTION_READ_OWN: "pic_attribution.read.own",
    PIC_ATTRIBUTION_READ_ALL: "pic_attribution.read.all",
    PIC_FEE_READ_OWN: "pic_fee.read.own",
    PIC_FEE_READ_ALL: "pic_fee.read.all",
    FEE_RATE_CHANGE: "fee.rate.change",
    FEE_ADJUST: "fee.adjust",
    FEE_MARK_PAID: "fee.mark_paid",

    // Settlement
    SETTLEMENT_PREPARE: "settlement.prepare",
    SETTLEMENT_APPROVE: "settlement.approve",
    SETTLEMENT_PROOF_UPLOAD: "settlement.proof.upload",

    // Check-in
    CHECKIN_SCAN: "checkin.scan",
    CHECKIN_OVERRIDE: "checkin.override",
    CHECKIN_LOG_READ: "checkin.log.read",

    // Reports
    REPORT_TRANSACTION_READ: "report.transaction.read",
    REPORT_EVENT_SALES_READ: "report.event_sales.read",
    REPORT_EXPORT_TRANSACTION: "report.export.transaction",
    REPORT_EXPORT_PIC_FEE: "report.export.pic_fee",
    REPORT_EXPORT_FINANCIAL: "report.export.financial",
    REPORT_EXPORT_OWN_PIC_FEE: "report.export.own_pic_fee",

    // Platform
    USER_MANAGE: "user.manage",
    ROLE_MANAGE: "role.manage",
    PLATFORM_CONFIG: "platform.config",
    AUDIT_LOG_READ: "audit_log.read",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS: ReadonlySet<string> = new Set(
    Object.values(PERMISSIONS)
);

// ─────────────────────────────────────────────────────────────────────────────
// Scope classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What kind of context a permission needs before the question "may this actor do
 * this?" is even meaningful.
 *
 * - `PLATFORM`  — no tenant context. Resolved by `decidePlatformPermission`.
 * - `ORGANIZER` — needs a target organizer. Resolved by `decideOrganizerPermission`.
 * - `OWN`       — needs the owning record's user id. Resolved by
 *                 `decideOwnResourcePermission`. A tenant membership confers
 *                 nothing here: a membership MANAGER must still not read another
 *                 PIC's fees.
 */
export type PermissionScope = "PLATFORM" | "ORGANIZER" | "OWN";

const P = PERMISSIONS;

const PLATFORM_SCOPE: readonly Permission[] = [
    P.SPORT_MANAGE,
    P.VENUE_MANAGE_GLOBAL,
    P.PIC_MANAGE,
    P.USER_MANAGE,
    P.ROLE_MANAGE,
    P.PLATFORM_CONFIG,
    P.AUDIT_LOG_READ,
];

const OWN_SCOPE: readonly Permission[] = [
    P.ORDER_READ_OWN,
    P.ORDER_CANCEL_OWN,
    P.PAYMENT_READ_OWN,
    P.TICKET_READ_OWN,
    P.TICKET_ISSUE_OWN,
    P.PIC_ATTRIBUTION_READ_OWN,
    P.PIC_FEE_READ_OWN,
    P.REPORT_EXPORT_OWN_PIC_FEE,
];

const ORGANIZER_SCOPE: readonly Permission[] = [
    P.EVENT_READ,
    P.EVENT_WRITE,
    P.EVENT_PUBLISH,
    P.EVENT_BANNER_UPLOAD,
    P.VENUE_MANAGE,
    P.CHECKIN_SCAN,
    P.CHECKIN_OVERRIDE,
    P.CHECKIN_LOG_READ,
    P.TICKET_TYPE_WRITE,
    P.TICKET_TYPE_QUOTA_CHANGE,
    P.TICKET_TYPE_PRICE_CHANGE,
    P.ORDER_READ_TENANT,
    P.ORDER_CANCEL,
    P.PAYMENT_READ_TENANT,
    P.REFUND_REQUEST,
    P.REFUND_APPROVE,
    P.REFUND_EXECUTE,
    P.PIC_ASSIGN,
    P.PIC_ATTRIBUTION_READ_ALL,
    P.PIC_FEE_READ_ALL,
];

/** The financial permissions whose *scope* is the tenant they affect. */
const ORGANIZER_SCOPE_FINANCIAL: readonly Permission[] = [
    P.PAYMENT_RECONCILE,
    P.FEE_RATE_CHANGE,
    P.FEE_ADJUST,
    P.FEE_MARK_PAID,
    P.SETTLEMENT_PREPARE,
    P.SETTLEMENT_APPROVE,
    P.SETTLEMENT_PROOF_UPLOAD,
    P.REPORT_TRANSACTION_READ,
    P.REPORT_EVENT_SALES_READ,
    P.REPORT_EXPORT_TRANSACTION,
    P.REPORT_EXPORT_PIC_FEE,
    P.REPORT_EXPORT_FINANCIAL,
];

export const PERMISSION_SCOPE: ReadonlyMap<string, PermissionScope> = new Map([
    ...PLATFORM_SCOPE.map((p) => [p, "PLATFORM"] as const),
    ...OWN_SCOPE.map((p) => [p, "OWN"] as const),
    ...[
        ...ORGANIZER_SCOPE,
        ...ORGANIZER_SCOPE_FINANCIAL,
    ].map((p) => [p, "ORGANIZER"] as const),
]);

// ─────────────────────────────────────────────────────────────────────────────
// Capability maps
// ─────────────────────────────────────────────────────────────────────────────

function toSet(permissions: readonly Permission[]): ReadonlySet<string> {
    return new Set<string>(permissions);
}

/**
 * Platform-wide capability: permissions that need no tenant context.
 * §6.3 "Platform" rows plus "Manage sports master data" and "Create / suspend PIC".
 */
const PLATFORM_ROLE_PLATFORM_PERMISSIONS: Record<
    PlatformRole,
    ReadonlySet<string>
> = {
    // §6.3: sports/venues/PIC/users/roles/config are Admin's; Manager and below are NO.
    ADMIN: toSet([
        P.SPORT_MANAGE,
        P.VENUE_MANAGE_GLOBAL,
        P.PIC_MANAGE,
        P.USER_MANAGE,
        P.ROLE_MANAGE,
        P.PLATFORM_CONFIG,
        P.AUDIT_LOG_READ,
    ]),
    // §6.3: "View audit log" is YES for Manager.
    MANAGER: toSet([P.AUDIT_LOG_READ]),
    PIC: toSet([]),
    CUSTOMER: toSet([]),
};

/**
 * A platform role's capability *inside a tenant it is an active member of*.
 *
 * ADMIN's financial permissions are absent by design — see `ADMIN_GRANT_REQUIRED`.
 */
const PLATFORM_ROLE_ORGANIZER_PERMISSIONS: Record<
    PlatformRole,
    ReadonlySet<string>
> = {
    ADMIN: toSet([
        P.EVENT_READ,
        P.EVENT_WRITE,
        P.EVENT_PUBLISH,
        P.EVENT_BANNER_UPLOAD,
        P.VENUE_MANAGE,
        P.TICKET_TYPE_WRITE,
        P.TICKET_TYPE_QUOTA_CHANGE,
        P.TICKET_TYPE_PRICE_CHANGE,
        P.ORDER_READ_TENANT,
        P.ORDER_CANCEL,
        P.PAYMENT_READ_TENANT,
        P.REFUND_REQUEST,
        P.REFUND_APPROVE,
        P.PIC_ASSIGN,
        P.PIC_ATTRIBUTION_READ_ALL,
        P.PIC_FEE_READ_ALL,
        P.CHECKIN_SCAN,
        P.CHECKIN_OVERRIDE,
        P.CHECKIN_LOG_READ,
        P.REPORT_TRANSACTION_READ,
        P.REPORT_EVENT_SALES_READ,
    ]),
    // D-19: Manager prepares/approves/executes settlement, adjusts fees, exports
    // financials — held BY ROLE, not by grant.
    MANAGER: toSet([
        P.EVENT_READ,
        P.EVENT_WRITE,
        P.EVENT_PUBLISH,
        P.EVENT_BANNER_UPLOAD,
        P.VENUE_MANAGE,
        P.TICKET_TYPE_WRITE,
        P.TICKET_TYPE_QUOTA_CHANGE,
        P.TICKET_TYPE_PRICE_CHANGE,
        P.ORDER_READ_TENANT,
        P.ORDER_CANCEL,
        P.PAYMENT_READ_TENANT,
        P.PAYMENT_RECONCILE,
        P.REFUND_REQUEST,
        P.REFUND_APPROVE,
        P.REFUND_EXECUTE,
        P.PIC_ASSIGN,
        P.PIC_ATTRIBUTION_READ_ALL,
        P.PIC_FEE_READ_ALL,
        P.FEE_RATE_CHANGE,
        P.FEE_ADJUST,
        P.FEE_MARK_PAID,
        P.SETTLEMENT_PREPARE,
        P.SETTLEMENT_APPROVE,
        P.SETTLEMENT_PROOF_UPLOAD,
        P.CHECKIN_SCAN,
        P.CHECKIN_OVERRIDE,
        P.CHECKIN_LOG_READ,
        P.REPORT_TRANSACTION_READ,
        P.REPORT_EVENT_SALES_READ,
        P.REPORT_EXPORT_TRANSACTION,
        P.REPORT_EXPORT_PIC_FEE,
        // §6.3 "Export financial report" is YES for Manager (§6.2).
        P.REPORT_EXPORT_FINANCIAL,
    ]),
    // A platform PIC has no tenant-wide capability at all. Everything a PIC may
    // read is OWN-scoped and resolved against the record's owner.
    PIC: toSet([]),
    CUSTOMER: toSet([]),
};

/**
 * A **membership** role's capability inside its own tenant.
 *
 * `OrganizerMemberRole.ADMIN` is intentionally absent (D-05): the brief's
 * tenant-level admin was collapsed into `OWNER` + platform `ADMIN`, so any
 * membership row carrying `ADMIN` resolves to no permissions rather than to an
 * invented privilege tier.
 */
const MEMBERSHIP_ROLE_PERMISSIONS: Partial<
    Record<OrganizerMemberRole, ReadonlySet<string>>
> = {
    OWNER: toSet([
        P.EVENT_READ,
        P.EVENT_WRITE,
        P.EVENT_PUBLISH,
        P.EVENT_BANNER_UPLOAD,
        P.VENUE_MANAGE,
        P.TICKET_TYPE_WRITE,
        P.TICKET_TYPE_QUOTA_CHANGE,
        P.TICKET_TYPE_PRICE_CHANGE,
        P.ORDER_READ_TENANT,
        P.ORDER_CANCEL,
        P.PAYMENT_READ_TENANT,
        P.PAYMENT_RECONCILE,
        P.REFUND_REQUEST,
        P.REFUND_APPROVE,
        P.REFUND_EXECUTE,
        P.PIC_ASSIGN,
        P.PIC_ATTRIBUTION_READ_ALL,
        P.PIC_FEE_READ_ALL,
        P.FEE_RATE_CHANGE,
        P.FEE_ADJUST,
        P.FEE_MARK_PAID,
        P.SETTLEMENT_PREPARE,
        P.SETTLEMENT_APPROVE,
        P.SETTLEMENT_PROOF_UPLOAD,
        P.CHECKIN_SCAN,
        P.CHECKIN_OVERRIDE,
        P.CHECKIN_LOG_READ,
        P.REPORT_TRANSACTION_READ,
        P.REPORT_EVENT_SALES_READ,
        P.REPORT_EXPORT_TRANSACTION,
        P.REPORT_EXPORT_PIC_FEE,
        P.REPORT_EXPORT_FINANCIAL,
    ]),
    // §6.3 Manager column, minus the platform-only rows.
    MANAGER: toSet([
        P.EVENT_READ,
        P.EVENT_WRITE,
        P.EVENT_PUBLISH,
        P.EVENT_BANNER_UPLOAD,
        P.VENUE_MANAGE,
        P.TICKET_TYPE_WRITE,
        P.TICKET_TYPE_QUOTA_CHANGE,
        P.TICKET_TYPE_PRICE_CHANGE,
        P.ORDER_READ_TENANT,
        P.ORDER_CANCEL,
        P.PAYMENT_READ_TENANT,
        P.PAYMENT_RECONCILE,
        P.REFUND_REQUEST,
        P.REFUND_APPROVE,
        P.REFUND_EXECUTE,
        P.PIC_ASSIGN,
        P.PIC_ATTRIBUTION_READ_ALL,
        P.PIC_FEE_READ_ALL,
        P.FEE_RATE_CHANGE,
        P.FEE_ADJUST,
        P.FEE_MARK_PAID,
        P.SETTLEMENT_PREPARE,
        P.SETTLEMENT_APPROVE,
        P.SETTLEMENT_PROOF_UPLOAD,
        P.CHECKIN_SCAN,
        P.CHECKIN_OVERRIDE,
        P.CHECKIN_LOG_READ,
        P.REPORT_TRANSACTION_READ,
        P.REPORT_EVENT_SALES_READ,
        P.REPORT_EXPORT_TRANSACTION,
        P.REPORT_EXPORT_PIC_FEE,
        P.REPORT_EXPORT_FINANCIAL,
    ]),
    // §6.3 FINANCE column: bookkeeping. Cannot edit or publish events.
    FINANCE: toSet([
        P.EVENT_READ,
        P.ORDER_READ_TENANT,
        P.PAYMENT_READ_TENANT,
        P.PAYMENT_RECONCILE,
        P.REFUND_REQUEST,
        P.REFUND_APPROVE,
        P.REFUND_EXECUTE,
        P.PIC_ATTRIBUTION_READ_ALL,
        P.PIC_FEE_READ_ALL,
        P.FEE_ADJUST,
        P.FEE_MARK_PAID,
        P.SETTLEMENT_PREPARE,
        P.SETTLEMENT_APPROVE,
        P.SETTLEMENT_PROOF_UPLOAD,
        P.REPORT_TRANSACTION_READ,
        P.REPORT_EVENT_SALES_READ,
        P.REPORT_EXPORT_TRANSACTION,
        P.REPORT_EXPORT_PIC_FEE,
        P.REPORT_EXPORT_FINANCIAL,
        P.AUDIT_LOG_READ,
    ]),
    // §5.3 PIC_VIEWER: may see *which* PICs are attributed, without fee access.
    PIC: toSet([P.PIC_ATTRIBUTION_READ_ALL]),
    // Least privilege at the gate. No orders, revenue or fees.
    CHECKIN_STAFF: toSet([
        P.CHECKIN_SCAN,
        P.CHECKIN_LOG_READ,
    ]),
    // `ADMIN` deliberately unmapped — see D-05 note at the top of this file.
};

/** A platform role's OWN-scoped capability. */
const PLATFORM_ROLE_OWN_PERMISSIONS: Record<
    PlatformRole,
    ReadonlySet<string>
> = {
    ADMIN: toSet([]),
    MANAGER: toSet([]),
    PIC: toSet([
        P.ORDER_READ_OWN,
        P.PAYMENT_READ_OWN,
        P.PIC_ATTRIBUTION_READ_OWN,
        P.PIC_FEE_READ_OWN,
        P.REPORT_EXPORT_OWN_PIC_FEE,
        // PHASE 8. A PIC is also a customer and buys tickets through the same flow.
        //
        // NOTE the deliberate divergence from the order map above, which withholds
        // `ORDER_CANCEL_OWN` from PIC: cancelling is destructive and irreversible, whereas
        // issuing the tickets of an order the PIC has already PAID for is the *completion*
        // of that purchase. Withholding it would strand a paying buyer's tickets on a role
        // technicality, which is a functional defect rather than a security posture.
        P.TICKET_READ_OWN,
        P.TICKET_ISSUE_OWN,
    ]),
    CUSTOMER: toSet([
        P.ORDER_READ_OWN,
        P.ORDER_CANCEL_OWN,
        P.PAYMENT_READ_OWN,
        P.TICKET_READ_OWN,
        P.TICKET_ISSUE_OWN,
    ]),
};

/**
 * D-19 — permissions a platform `ADMIN` may exercise **only** with an explicit,
 * active `PermissionGrant`. They are absent from ADMIN's maps above, so the grant
 * is the single way to satisfy them.
 *
 * Manager, FINANCE and membership OWNER/MANAGER hold these by role, which is why
 * the requirement is expressed against the ADMIN platform role and not against
 * the permission itself.
 *
 * Note the asymmetry the brief demands: "Manage users" and "Manage roles"
 * (privilege escalation) are NOT grant-required — they are Admin-only and
 * Manager can never hold them.
 */
export const ADMIN_GRANT_REQUIRED: ReadonlySet<string> = toSet([
    P.PAYMENT_RECONCILE,
    P.REFUND_APPROVE,
    P.FEE_RATE_CHANGE,
    P.FEE_ADJUST,
    P.SETTLEMENT_APPROVE,
    P.REPORT_EXPORT_TRANSACTION,
    P.REPORT_EXPORT_PIC_FEE,
    P.REPORT_EXPORT_FINANCIAL,
]);

/**
 * Platform roles that may act inside an organizer **without** an active
 * membership row.
 *
 * Empty, and that emptiness is the whole isolation guarantee: no role — not
 * ADMIN, not MANAGER — reaches a tenant without a membership. This is the single
 * place to change if the business ever decides a platform role should span all
 * tenants.
 */
export const ORGANIZER_SPANNING_PLATFORM_ROLES: ReadonlySet<PlatformRole> =
    new Set<PlatformRole>([]);

// ─────────────────────────────────────────────────────────────────────────────
// Decision
// ─────────────────────────────────────────────────────────────────────────────

export type OrganizerScopeEntry = {
    organizerId: string;
    role: OrganizerMemberRole;
    status: OrganizerMemberStatus;
};

export type GrantEntry = {
    /** null means a platform-wide grant. */
    organizerId: string | null;
    permission: string;
};

/**
 * The resolved, server-derived authorization scope for one actor.
 * Built only from the database — never from client input.
 */
export type AuthzScope = {
    userId: string;
    platformRole: PlatformRole;
    organizerScopes: readonly OrganizerScopeEntry[];
    grants: readonly GrantEntry[];
};

export type AuthzDecision =
    | { allowed: true }
    | { allowed: false; code: AuthzErrorCode; reason: string };

const ALLOW: AuthzDecision = { allowed: true };

function deny(code: AuthzErrorCode, reason: string): AuthzDecision {
    return { allowed: false, code, reason };
}

/** An unknown permission is never allowed. */
function isKnown(permission: string): boolean {
    return ALL_PERMISSIONS.has(permission);
}

/**
 * A grant only counts for the permissions it is designed to unlock.
 *
 * `PermissionGrant` exists (design §6.4) to satisfy the §6.2/§6.3 cells marked
 * "APPROVE (with explicit grant)" — a specific financial permission given to an
 * Admin deliberately, with an audit record. It is **not** a general privilege
 * channel.
 *
 * Without this restriction a grant row could confer *any* permission, which would
 * make it a privilege-escalation primitive: `role.manage` handed to a Manager
 * would be indistinguishable from a designed capability, and §5.2's rule that
 * effective permission is "never the union of loose grants" would be violated.
 * So a grant is consulted only for `ADMIN_GRANT_REQUIRED` permissions.
 */
function grantApplies(permission: string): boolean {
    return ADMIN_GRANT_REQUIRED.has(permission);
}

function hasGrant(
    scope: AuthzScope,
    permission: string,
    organizerId: string | null
): boolean {
    if (!grantApplies(permission)) {
        return false;
    }

    return scope.grants.some(
        (g) =>
            g.permission === permission &&
            (g.organizerId === organizerId || g.organizerId === null)
    );
}

/**
 * Resolve a permission that needs no tenant context.
 * Used for `user.manage`, `role.manage`, `platform.config`, `sport.manage`,
 * `pic.manage` and `audit_log.read`.
 */
export function decidePlatformPermission(
    scope: AuthzScope,
    permission: string
): AuthzDecision {
    if (!isKnown(permission)) {
        return deny(
            AuthzErrorCode.FORBIDDEN,
            `unknown permission "${permission}"`
        );
    }

    if (PERMISSION_SCOPE.get(permission) !== "PLATFORM") {
        return deny(
            AuthzErrorCode.FORBIDDEN,
            `"${permission}" is not a platform-scope permission`
        );
    }

    const granted = hasGrant(scope, permission, null);

    if (
        scope.platformRole === "ADMIN" &&
        ADMIN_GRANT_REQUIRED.has(permission)
    ) {
        return granted
            ? ALLOW
            : deny(
                  AuthzErrorCode.FORBIDDEN,
                  `"${permission}" requires an explicit grant for ADMIN`
              );
    }

    const held =
        PLATFORM_ROLE_PLATFORM_PERMISSIONS[scope.platformRole].has(permission) ||
        granted;

    return held
        ? ALLOW
        : deny(
              AuthzErrorCode.FORBIDDEN,
              `platform role ${scope.platformRole} lacks "${permission}"`
          );
}

/**
 * Resolve a permission against a specific organizer.
 *
 * Isolation is enforced here and only here: the target organizer is supplied by
 * the caller, but the *authority* to touch it is always derived from
 * `scope.organizerScopes`, which comes from the database. A caller that passes an
 * arbitrary `organizerId` (a URL segment, a query parameter, a request body)
 * cannot thereby obtain access, because the membership lookup is the gate.
 */
export function decideOrganizerPermission(
    scope: AuthzScope,
    organizerId: string,
    permission: string
): AuthzDecision {
    if (!isKnown(permission)) {
        return deny(
            AuthzErrorCode.FORBIDDEN,
            `unknown permission "${permission}"`
        );
    }

    const kind = PERMISSION_SCOPE.get(permission);

    if (kind === "PLATFORM") {
        return deny(
            AuthzErrorCode.FORBIDDEN,
            `"${permission}" is a platform-scope permission, not organizer-scope`
        );
    }

    if (kind === "OWN") {
        return deny(
            AuthzErrorCode.FORBIDDEN,
            `"${permission}" requires a record ownership check, not a tenant check`
        );
    }

    const membership = scope.organizerScopes.find(
        (m) => m.organizerId === organizerId
    );
    const active = membership?.status === "ACTIVE";
    const spans = ORGANIZER_SPANNING_PLATFORM_ROLES.has(scope.platformRole);

    if (!active && !spans) {
        // 404, not 403 — an actor without a membership must not learn that this
        // organizer exists. This is the cross-tenant denial path (§7.4, §16).
        return deny(
            AuthzErrorCode.ORGANIZER_ACCESS_DENIED,
            `no active membership for organizer ${organizerId}`
        );
    }

    const granted = hasGrant(scope, permission, organizerId);

    if (
        scope.platformRole === "ADMIN" &&
        ADMIN_GRANT_REQUIRED.has(permission)
    ) {
        return granted
            ? ALLOW
            : deny(
                  AuthzErrorCode.FORBIDDEN,
                  `"${permission}" requires an explicit grant for ADMIN`
              );
    }

    const fromPlatformRole =
        PLATFORM_ROLE_ORGANIZER_PERMISSIONS[scope.platformRole].has(permission);
    const fromMembership = membership
        ? (MEMBERSHIP_ROLE_PERMISSIONS[membership.role]?.has(permission) ??
          false)
        : false;

    return fromPlatformRole || fromMembership || granted
        ? ALLOW
        : deny(
              AuthzErrorCode.FORBIDDEN,
              `no capability source grants "${permission}" in organizer ${organizerId}`
          );
}

/**
 * Resolve an OWN-scoped permission against the id of the user who owns the
 * record. A tenant membership confers nothing: a membership MANAGER reading a
 * PIC's fee fails here.
 */
export function decideOwnResourcePermission(
    scope: AuthzScope,
    permission: string,
    ownerUserId: string
): AuthzDecision {
    if (!isKnown(permission)) {
        return deny(
            AuthzErrorCode.FORBIDDEN,
            `unknown permission "${permission}"`
        );
    }

    if (PERMISSION_SCOPE.get(permission) !== "OWN") {
        return deny(
            AuthzErrorCode.FORBIDDEN,
            `"${permission}" is not an own-scope permission`
        );
    }

    if (scope.userId !== ownerUserId) {
        return deny(
            AuthzErrorCode.PIC_ACCESS_DENIED,
            `own-scope permission "${permission}" requested for another user's record`
        );
    }

    return PLATFORM_ROLE_OWN_PERMISSIONS[scope.platformRole].has(permission)
        ? ALLOW
        : deny(
              AuthzErrorCode.FORBIDDEN,
              `platform role ${scope.platformRole} lacks own-scope "${permission}"`
          );
}

/** Convenience: does the scope hold an ACTIVE membership in this organizer? */
export function hasActiveMembership(
    scope: AuthzScope,
    organizerId: string
): boolean {
    return scope.organizerScopes.some(
        (m) => m.organizerId === organizerId && m.status === "ACTIVE"
    );
}

/** Exposed for tests and for the report's permission-matrix table. */
export const __maps = {
    PLATFORM_ROLE_PLATFORM_PERMISSIONS,
    PLATFORM_ROLE_ORGANIZER_PERMISSIONS,
    PLATFORM_ROLE_OWN_PERMISSIONS,
    MEMBERSHIP_ROLE_PERMISSIONS,
};
