import type { PaymentStatus, RefundStatus } from "@prisma/client";

import type { EventStatusFilter } from "@/lib/events/status";
import type { PicAssignmentStatus } from "@/lib/pic/self-service";
import type { SettlementStatus } from "@/lib/ticketing/settlement/validation";
import {
    DASHBOARD_REPORT_ORDER_STATUS_LABELS,
    DASHBOARD_REPORT_PERIODS,
    type DashboardReportPeriod,
} from "@/lib/dashboard/reports";



/**
 * ==========================================
 * DASHBOARD FILTER OPTION VOCABULARY
 * ==========================================
 *
 * The operator-facing NAME of every status the dashboard can filter on, in one place, so the events
 * list, the orders list, the payments list, the refunds board and the settlements board cannot label
 * the same enum member five different ways.
 *
 * ── VALUES ARE THE SCHEMA'S OWN ─────────────────────────────────────────────────
 * Only the LABELS live here. The values stay `EventStatus` / `OrderStatus` / `PaymentStatus` /
 * `RefundStatus` / `SettlementStatus` members, and they are declared against those types, so a
 * status renamed in `prisma/schema.prisma` (or added to it) fails this module at compile time
 * instead of silently rendering as a raw `PARTIALLY_REFUNDED` in a filter row. Nothing is renamed,
 * aliased or invented.
 *
 * ── WHY EACH MAP IS DECLARED `satisfies` AND THEN WIDENED ───────────────────────
 * `satisfies Record<TheEnum, string>` is what proves COMPLETENESS at compile time. The filter
 * builder, however, takes a plain `Record<string, string>` lookup (it is generic over every status
 * vocabulary), and TypeScript will not assign a type with only known keys to an index-signature
 * type. `labelLookup` is that one widening, in one place, so the exhaustiveness proof is kept and
 * no call site needs a cast.
 *
 * ── WHERE THE UNIONS LIVE ───────────────────────────────────────────────────────
 * The three NAMED UNIONS ("Aktif", "Perlu Ditangani", "Menunggu Persetujuan") are NOT repeated here.
 * Each stays in the module that already owns its definition — `EVENT_ACTIVE_STATUSES`,
 * `REFUND_NEEDS_HANDLING_STATUSES`, `SETTLEMENT_AWAITING_APPROVAL_STATUSES` — and each page passes
 * its union to `buildFilterField` by reference, so the label a pill shows and the predicate the
 * read model counts can never disagree.
 */

/** Widen a complete enum label map to the index-signature lookup the generic builder takes. */
export function labelLookup<T extends string>(
    labels: Record<T, string>
): Record<string, string> {
    return labels as Record<string, string>;
}

const EVENT_STATUS_LABELS_MAP = {
    DRAFT: "Draft",
    PUBLISHED: "Dipublikasikan",
    ONGOING: "Sedang berlangsung",
    COMPLETED: "Selesai",
    CANCELLED: "Dibatalkan",
    ARCHIVED: "Diarsipkan",
} satisfies Record<EventStatusFilter, string>;

const PAYMENT_STATUS_LABELS_MAP = {
    UNPAID: "Belum dibayar",
    PENDING: "Menunggu",
    PAID: "Lunas",
    FAILED: "Gagal",
    EXPIRED: "Kedaluwarsa",
    REFUNDED: "Dana dikembalikan",
    PARTIALLY_REFUNDED: "Refund sebagian",
} satisfies Record<PaymentStatus, string>;

const REFUND_STATUS_LABELS_MAP = {
    PENDING: "Menunggu",
    APPROVED: "Disetujui",
    REJECTED: "Ditolak",
    PROCESSING: "Diproses",
    REFUNDED: "Selesai",
    FAILED: "Gagal",
} satisfies Record<RefundStatus, string>;

const SETTLEMENT_STATUS_LABELS_MAP = {
    DRAFT: "Draft",
    PENDING_APPROVAL: "Menunggu approval",
    APPROVED: "Disetujui",
    PAID: "Dibayar",
    FAILED: "Gagal",
    CANCELLED: "Dibatalkan",
    REQUESTED: "Diminta",
    REJECTED: "Ditolak",
} satisfies Record<SettlementStatus, string>;

export const EVENT_STATUS_LABELS = labelLookup(EVENT_STATUS_LABELS_MAP);
export const PAYMENT_STATUS_LABELS = labelLookup(PAYMENT_STATUS_LABELS_MAP);
export const REFUND_STATUS_LABELS = labelLookup(REFUND_STATUS_LABELS_MAP);
export const SETTLEMENT_STATUS_LABELS = labelLookup(SETTLEMENT_STATUS_LABELS_MAP);

/**
 * The two states a `PICEventAssignment` row can hold, as the PIC's own dashboard names them.
 *
 * The VALUES are the read model's own (`PIC_ASSIGNMENT_STATUSES` in `lib/pic/self-service.ts`),
 * declared here only so the label set is proven COMPLETE at compile time and the "Event Saya"
 * filter row cannot label one state two ways. The type import is type-only, so this vocabulary
 * module keeps its no-server-import contract.
 */
const PIC_ASSIGNMENT_STATUS_LABELS_MAP = {
    ACTIVE: "Aktif",
    REVOKED: "Dicabut",
} satisfies Record<PicAssignmentStatus, string>;

export const PIC_ASSIGNMENT_STATUS_LABELS = labelLookup(
    PIC_ASSIGNMENT_STATUS_LABELS_MAP
);

/**
 * The two MANAGED platform roles `listManagedUsers` can filter on, as the operator sees them.
 *
 * Not a Prisma enum: `ManagedRole` (`lib/admin/users.ts`) is the surface's own two-value union — the
 * only roles that management page can create, list or deactivate (ADMIN is provisioned out of band).
 * The VALUES are the service's own, so `?role=MANAGER` is the parameter the read model already
 * expects rather than a translation layer invented by the UI.
 */
export const MANAGED_ROLE_LABELS: Record<string, string> = {
    MANAGER: "Manager",
    PIC: "PIC",
};

/**
 * The order-status vocabulary is the reports module's own, re-exported rather than re-typed: one
 * order-status label set for the whole dashboard.
 */
export const ORDER_STATUS_LABELS: Record<string, string> = {
    ...DASHBOARD_REPORT_ORDER_STATUS_LABELS,
};

/**
 * The window shortcuts' labels, beside the periods they name.
 *
 * There is deliberately NO "all"/"custom" member: the shortcuts are a row of pills where the
 * applicable one is highlighted, and when an explicit `from`/`to` range is in force NO shortcut is
 * active — which is exactly the state the previous period pills expressed, and it keeps the period
 * vocabulary in `lib/dashboard/reports.ts` (which is protected) untouched.
 */
export const REPORT_PERIOD_LABELS: Record<DashboardReportPeriod, string> = {
    "7d": "7 hari",
    "30d": "30 hari",
    "3m": "3 bulan",
};

/** The period shortcuts in the order they are offered, derived from the shared periods object. */
export const REPORT_PERIOD_KEYS = Object.keys(
    DASHBOARD_REPORT_PERIODS
) as DashboardReportPeriod[];
