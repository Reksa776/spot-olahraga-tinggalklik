import { FiBox, FiShoppingBag, FiTrendingUp, FiUsers } from "react-icons/fi";

import { StatCard, StatGrid, type Tone } from "@/components/dashboard/primitives";

export type DashboardSummary = {
    totalProducts: number;
    totalCustomers: number;
    totalOrders: number;
    periodOrderCount: number;
    paidOrderCount: number;
    revenue: number;
    paidSubtotal: number;
    paidShipping: number;
};

/**
 * The four KPI tiles of the admin overview.
 *
 * DATA IS UNCHANGED: the same `summary` fields, the same `Intl.NumberFormat("id-ID", …)` currency
 * formatting that the previous implementation used, and the same labels. Only the presentation
 * moved — from four hand-written `rounded-2xl border … p-5` divs to the shared `StatCard`, which is
 * what makes a fifth tile (or a different dashboard) cost nothing.
 *
 * `totalProducts` was in the props before and is still unused, exactly as before: the previous
 * version declared it and never rendered it. Preserving that is deliberate — inventing a fifth
 * tile would be adding a feature, which this phase does not do.
 */
function formatRupiah(value: number) {
    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
        maximumFractionDigits: 0,
    }).format(value);
}

export default function DashboardStats({
    summary,
}: {
    summary: DashboardSummary;
}) {
    const stats: { title: string; value: string; description: string; icon: React.ReactNode; tone: Tone }[] = [
        {
            title: "Total Penjualan",
            value: formatRupiah(summary.revenue),
            description: "Pesanan yang sudah dibayar",
            icon: <FiTrendingUp size={20} />,
            tone: "brand",
        },
        {
            title: "Pesanan",
            value: summary.totalOrders.toLocaleString("id-ID"),
            description: `${summary.periodOrderCount} pesanan periode ini`,
            icon: <FiShoppingBag size={20} />,
            tone: "info",
        },
        {
            title: "Pesanan Dibayar",
            value: summary.paidOrderCount.toLocaleString("id-ID"),
            description: "Transaksi berhasil dibayar",
            icon: <FiBox size={20} />,
            tone: "success",
        },
        {
            title: "Customer",
            value: summary.totalCustomers.toLocaleString("id-ID"),
            description: "Customer terdaftar",
            icon: <FiUsers size={20} />,
            tone: "pending",
        },
    ];

    return (
        <StatGrid>
            {stats.map((stat) => (
                <StatCard
                    key={stat.title}
                    label={stat.title}
                    value={stat.value}
                    hint={stat.description}
                    icon={stat.icon}
                    tone={stat.tone}
                />
            ))}
        </StatGrid>
    );
}
