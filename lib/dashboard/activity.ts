import { PERMISSIONS, type AuthzScope } from "@/lib/authz";
import { hasOrganizerPermission } from "@/lib/dashboard/scope";
import { listDashboardOrders } from "@/lib/dashboard/orders";
import { listDashboardRefunds } from "@/lib/dashboard/refunds";
import { listSettlements } from "@/lib/ticketing/settlement/service";
import { formatEventDateShort, formatIdr } from "@/lib/ticketing/ui/format";

/**
 * ==========================================
 * DASHBOARD RECENT ACTIVITY (tenant-scoped)
 * ==========================================
 *
 * The three "what just happened" panels on the overview. Each one is assembled from the EXISTING
 * service for its vertical — `listDashboardOrders`, `listDashboardRefunds`, `listSettlements` — so
 * this module owns no query, no predicate and no money rule of its own. It only decides which
 * columns are worth showing in a five-row glance.
 *
 * ── WHY `allowed` IS A SEPARATE FIELD FROM `items` ─────────────────────────────
 * "You may not read orders" and "no order was placed this week" are different answers and a
 * dashboard that renders both as an empty list is lying about one of them — the same rule the
 * overview blocks already follow. So each panel reports whether the actor holds the permission
 * (`hasOrganizerPermission`, the same decider the services call) and the page renders an explicit
 * "no access" note for `allowed: false` rather than an empty state.
 *
 * ── WHY THE SERVICES ARE REUSED RATHER THAN RE-IMPLEMENTED ────────────────────
 * Every one of them already re-decides authorization, resolves the organizer filter from the same
 * `resolveOrganizerFilter` and never trusts a client-supplied organizer. A local query here would
 * be a second answer to "which tenants may this actor read", which is precisely the divergence
 * these modules exist to prevent.
 */

export type DashboardActivityItem = {
    id: string;
    /** The headline: an order number, a PIC name, a refund number. */
    title: string;
    /** The supporting line: who / which event. */
    meta: string;
    /** The right-hand value, already formatted for display. */
    amount: string;
    /** The vertical's own status vocabulary, rendered through `StatusBadge`. */
    status: string;
    /** A deep link into the surface that can act on the row, or `null` when none exists. */
    href: string | null;
    at: string;
};

export type DashboardActivityPanel = {
    /** False when the actor holds no permission for this vertical in any organizer. */
    allowed: boolean;
    items: DashboardActivityItem[];
};

export type DashboardActivity = {
    orders: DashboardActivityPanel;
    refunds: DashboardActivityPanel;
    settlements: DashboardActivityPanel;
};

const TIME_FORMAT = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
});

/** `Sab, 20 Sep 2026 · 19.00 WIB` — short enough for a five-row panel. */
function when(iso: string): string {
    return `${formatEventDateShort(iso)} · ${TIME_FORMAT.format(new Date(iso))} WIB`;
}

export async function getDashboardActivity(
    scope: AuthzScope,
    limit = 5
): Promise<DashboardActivity> {
    const take = Math.max(1, Math.min(10, limit));

    const canReadOrders = hasOrganizerPermission(scope, PERMISSIONS.ORDER_READ_TENANT);
    const canReadSettlements = hasOrganizerPermission(
        scope,
        PERMISSIONS.SETTLEMENT_PREPARE
    );

    const [orders, refunds, settlements] = await Promise.all([
        canReadOrders
            ? listDashboardOrders(scope, { limit: take })
            : Promise.resolve({ items: [], pagination: null }),
        // Refunds are a tenant read under `order.read.tenant`, which is the permission the refunds
        // board itself uses — so the panel and the board can never disagree about access.
        canReadOrders
            ? listDashboardRefunds(scope, { limit: take })
            : Promise.resolve({ items: [], pagination: null }),
        canReadSettlements
            ? listSettlements(scope, { page: 1, limit: take })
            : Promise.resolve({ items: [], total: 0 }),
    ]);

    return {
        orders: {
            allowed: canReadOrders,
            items: orders.items.map((order) => ({
                id: order.id,
                title: order.orderNumber,
                meta: `${order.buyerName} · ${order.event.title}`,
                amount: formatIdr(Number(order.total)),
                status: order.status,
                href: `/dashboard/orders/${order.orderNumber}`,
                at: when(order.createdAt.toISOString()),
            })),
        },
        refunds: {
            allowed: canReadOrders,
            items: refunds.items.map((refund) => ({
                id: String(refund.id),
                title: refund.refundNumber ?? `#${refund.id}`,
                meta: `${refund.eventOrder?.buyerName ?? "—"} · ${
                    refund.eventOrder?.orderNumber ?? "—"
                }`,
                // The confirmed amount once the money has moved, the requested amount before that,
                // so a completed refund never appears to have moved a different figure.
                amount: formatIdr(
                    Number(
                        refund.status === "REFUNDED"
                            ? refund.confirmedAmount
                            : refund.requestedAmount
                    )
                ),
                status: refund.status,
                href: "/dashboard/refunds",
                at: when(refund.createdAt.toISOString()),
            })),
        },
        settlements: {
            allowed: canReadSettlements,
            items: settlements.items.map((settlement) => ({
                id: settlement.id,
                title: settlement.settlementNumber,
                meta: `${settlement.picDisplayName ?? "PIC"} · ${
                    settlement.organizerName ?? "—"
                }`,
                amount: formatIdr(Number(settlement.netAmount)),
                status: settlement.status,
                href: `/dashboard/settlements/${settlement.id}`,
                at: when(settlement.createdAt),
            })),
        },
    };
}
