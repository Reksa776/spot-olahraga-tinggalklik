import {
    FiCalendar,
    FiCheckCircle,
    FiClock,
    FiCreditCard,
    FiDollarSign,
    FiShoppingBag,
    FiTag,
    FiTrendingUp,
    FiUsers,
} from "react-icons/fi";

import {
    DataRow,
    EmptyBlock,
    PageHeader,
    SectionCard,
    StatCard,
    StatGrid,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { getDashboardOverview } from "@/lib/dashboard/overview";
import { eventStatusTone } from "@/lib/events/status";
import { formatEventSchedule, formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Dashboard overview.
 *
 * Reads `getDashboardOverview`, which is scoped by the same permission decisions the API
 * uses. There are no placeholders: each tile is a query against real rows, and a block the
 * caller has no permission to read renders as an explicit "no access" note rather than as
 * a zero that would read like an empty business.
 */

export const dynamic = "force-dynamic";

export default async function DashboardOverviewPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const overview = await getDashboardOverview(scope);
    const tenant = overview.tenant;

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Ringkasan"
                description="Angka di bawah dihitung langsung dari data transaksi. Cakupannya mengikuti izin akun kamu: penyelenggara melihat event miliknya, admin platform melihat agregat yang diizinkan."
            />

            <StatGrid>
                <StatCard
                    label="Total event"
                    value={tenant?.eventsTotal ?? "—"}
                    icon={<FiCalendar />}
                    hint={
                        tenant
                            ? `${tenant.eventsPublished} dipublikasikan · ${tenant.eventsUpcoming} akan datang`
                            : "Tidak ada akses data event"
                    }
                />
                <StatCard
                    label="Pesanan"
                    value={tenant?.ordersTotal ?? "—"}
                    icon={<FiShoppingBag />}
                    hint={
                        tenant
                            ? `${tenant.ordersPaid} lunas · ${tenant.ordersPendingPayment} menunggu bayar`
                            : "Tidak ada akses data pesanan"
                    }
                />
                <StatCard
                    label="Tiket terjual"
                    value={tenant?.ticketsSold ?? "—"}
                    icon={<FiTag />}
                    tone="info"
                    hint="Tiket terbit dan check-in, tidak termasuk yang void/refund"
                />
                <StatCard
                    label="Pendapatan"
                    value={tenant ? formatIdr(Number(tenant.revenue)) : "—"}
                    icon={<FiDollarSign />}
                    tone="success"
                    hint="Total pesanan berstatus lunas"
                />
            </StatGrid>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                <SectionCard
                    title="Pembayaran"
                    description="Status percobaan pembayaran pada gateway"
                    className="lg:col-span-1"
                >
                    {tenant ? (
                        <div className="flex flex-col">
                            <DataRow
                                leading={<FiClock size={18} />}
                                title="Menunggu"
                                trailing={<span className="font-semibold tabular-nums">{tenant.paymentsPending}</span>}
                                divider={false}
                            />
                            <DataRow
                                leading={<FiCheckCircle size={18} />}
                                title="Berhasil"
                                trailing={<span className="font-semibold tabular-nums">{tenant.paymentsPaid}</span>}
                            />
                            <DataRow
                                leading={<FiCreditCard size={18} />}
                                title="Gagal / kedaluwarsa"
                                trailing={<span className="font-semibold tabular-nums">{tenant.paymentsFailed}</span>}
                            />
                        </div>
                    ) : (
                        <EmptyBlock
                            title="Tidak ada akses pembayaran"
                            description="Peran kamu belum memiliki izin membaca pembayaran."
                        />
                    )}
                </SectionCard>

                <SectionCard
                    title="Event akan datang"
                    description="Event terpublikasi terdekat"
                    className="lg:col-span-2"
                >
                    {overview.upcomingEvents.length > 0 ? (
                        <div className="flex flex-col">
                            {overview.upcomingEvents.map((event, index) => (
                                <DataRow
                                    key={event.id}
                                    divider={index > 0}
                                    title={
                                        <TextLink href={`/dashboard/events/${event.id}`}>
                                            {event.title}
                                        </TextLink>
                                    }
                                    meta={`${formatEventSchedule(event.startAt, null)} · ${event.organizerName}`}
                                    trailing={
                                        // Same tone table as the event list and detail header, so
                                        // a status reads identically on all three surfaces.
                                        <StatusBadge tone={eventStatusTone(event.status)}>
                                            {event.status}
                                        </StatusBadge>
                                    }
                                />
                            ))}
                        </div>
                    ) : (
                        <EmptyBlock
                            icon={<FiTrendingUp size={22} />}
                            title="Belum ada event akan datang"
                            description="Event yang sudah dipublikasikan dan belum mulai akan muncul di sini."
                        />
                    )}
                </SectionCard>
            </div>

            {overview.platform ? (
                <StatGrid className="xl:grid-cols-4">
                    <StatCard
                        label="Cabang olahraga"
                        value={overview.platform.sportsTotal}
                        icon={<FiTrendingUp />}
                        tone="neutral"
                        hint={`${overview.platform.sportsActive} aktif`}
                    />
                    <StatCard
                        label="PIC aktif"
                        value={overview.platform.picActive}
                        icon={<FiUsers />}
                        tone="brand"
                        hint={`${overview.platform.picPending} menunggu persetujuan`}
                    />
                    <StatCard
                        label="Total PIC"
                        value={overview.platform.picTotal}
                        icon={<FiUsers />}
                        tone="neutral"
                    />
                </StatGrid>
            ) : null}
        </div>
    );
}
