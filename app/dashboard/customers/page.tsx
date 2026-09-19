import {
    DataTable,
    EmptyBlock,
    LinkPagination,
    PageHeader,
} from "@/components/dashboard/primitives";
import { getAuthzScope } from "@/lib/authz";
import { listDashboardCustomers } from "@/lib/dashboard/customers";
import { formatIdr } from "@/lib/ticketing/ui/format";

/**
 * Customers.
 *
 * A customer is a `User` with at least one order in the organizers the actor may read orders
 * in — derived, never a second customer model. The aggregation is done in the database, so
 * the page does not need to load every order to count them.
 */

export const dynamic = "force-dynamic";

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeZone: "Asia/Jakarta",
});

export default async function DashboardCustomersPage({
    searchParams,
}: {
    searchParams: Promise<{ page?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const page = params.page ? Number(params.page) : 1;

    const result = await listDashboardCustomers(scope, { page, limit: 20 });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pelanggan"
                description="Pembeli yang pernah memesan tiket dari event yang bisa kamu akses. Belanja dihitung dari pesanan berstatus lunas."
            />

            <DataTable
                minWidth={900}
                empty={
                    <EmptyBlock
                        title="Belum ada pelanggan"
                        description="Pembeli akan muncul di sini setelah ada pesanan pada event kamu."
                    />
                }
                columns={[
                    { header: "Pelanggan" },
                    { header: "Telepon" },
                    { header: "Pesanan", align: "right" },
                    { header: "Tiket", align: "right" },
                    { header: "Belanja", align: "right" },
                    { header: "Pesanan terakhir" },
                ]}
                rows={result.items.map((customer) => ({
                    key: customer.userId,
                    cells: [
                        <div className="flex flex-col" key="customer">
                            <span className="text-sm font-semibold">
                                {customer.name ?? "Tanpa nama"}
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {customer.email ?? "—"}
                            </span>
                        </div>,
                        <span className="text-sm" key="phone">
                            {customer.phone ?? "—"}
                        </span>,
                        <span className="text-sm tabular-nums" key="orders">
                            {customer.orders}
                        </span>,
                        <span className="text-sm tabular-nums" key="tickets">
                            {customer.tickets}
                        </span>,
                        <span className="text-sm font-semibold tabular-nums" key="spend">
                            {formatIdr(Number(customer.spend))}
                        </span>,
                        <span key="last" className="text-xs text-muted-foreground">
                            {DATE_FORMAT.format(new Date(customer.lastOrderAt))}
                        </span>,
                    ],
                }))}
                footer={
                    <LinkPagination
                        page={page}
                        totalPages={result.pagination.totalPages}
                        basePath="/dashboard/customers"
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
