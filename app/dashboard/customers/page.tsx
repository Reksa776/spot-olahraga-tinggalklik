import { FilterBar } from "@/components/dashboard/filters/FilterBar";
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
 *
 * ── THE SEARCH THE READ MODEL ALREADY HAD ───────────────────────────────────────
 * `listDashboardCustomers` has always accepted `q` and resolved it through `buildBuyerSearch`
 * (name / email / phone). The page never read the parameter and never forwarded it, so the capability
 * was unreachable from the product. It is now a labelled search box and the parameter is passed
 * through unchanged — which is the whole change: no new filter, no new predicate, no new column.
 *
 * The bar carries no pill row because this list has no status to filter on; the search box IS the
 * complete filter set. Pagination keeps holding the term, so page 3 of a search stays that search.
 */

export const dynamic = "force-dynamic";

/** Browser tab title. The brand suffix is composed by the root layout's `title.template`. */
export const metadata = { title: "Customers" };

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeZone: "Asia/Jakarta",
});

export default async function DashboardCustomersPage({
    searchParams,
}: {
    searchParams: Promise<{ page?: string; q?: string }>;
}) {
    const params = await searchParams;
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    const page = params.page ? Number(params.page) : 1;

    const result = await listDashboardCustomers(scope, {
        q: params.q ?? null,
        page,
        limit: 20,
    });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="Pelanggan"
                description="Pembeli yang pernah memesan tiket dari event yang bisa kamu akses. Belanja dihitung dari pesanan berstatus lunas."
            />

            <FilterBar
                basePath="/dashboard/customers"
                current={{ q: params.q }}
                fields={[]}
                search={{
                    label: "Cari pelanggan",
                    placeholder: "Nama, email, atau nomor telepon",
                    value: params.q,
                }}
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
                        query={{ q: params.q }}
                        label="Halaman"
                    />
                }
            />
        </div>
    );
}
