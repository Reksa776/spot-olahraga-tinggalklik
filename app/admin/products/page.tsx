import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

import { FiEdit2, FiImage, FiPlus } from "react-icons/fi";

import { Badge, Box, Group, Image, Stack, Text } from "@mantine/core";

import {
    DataTable,
    EmptyBlock,
    PageHeader,
    PrimaryAction,
    SectionCard,
} from "@/components/dashboard/primitives";

import DeleteProductButton from "./DeleteProductButton";
import RealtimeProductFilter from "./RealtimeProductFilter";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * The page is a server component and stays one. Preserved exactly: the `auth()` gate and both
 * redirects, the `searchParams` shape and defaults, the category `findMany` with `distinct`, the
 * `where`/`orderBy` construction, the in-memory stock filter, the price and stock sorts, and the
 * "lowest variant price" / "total stock" derivations each row displays.
 *
 * Presentation changes: `PageHeader` + `SectionCard` + `DataTable` replace the hand-rolled header
 * and the raw `<table>`; the previous `<table>` had no empty or horizontal-overflow strategy, so the
 * empty state is now the shared `EmptyBlock` and wide rows scroll inside `ScrollArea`. The desktop
 * table and the duplicate mobile card list are now one table: the mobile cards carried the same
 * seven fields in a different arrangement, and `DataTable`'s `ScrollArea` covers the narrow width
 * the cards existed for.
 */

type SearchParams = {
    q?: string;
    category?: string;
    status?: string;
    stock?: string;
    sort?: string;
};

type Props = {
    searchParams: Promise<SearchParams>;
};

export default async function AdminProductsPage({ searchParams }: Props) {
    const session = await auth();

    if (!session?.user) {
        redirect("/login");
    }

    const role = session.user.role;

    if (role !== "ADMIN") {
        redirect("/home");
    }

    const params = await searchParams;

    const q = params.q?.trim() ?? "";
    const category = params.category ?? "ALL";
    const status = params.status ?? "ALL";
    const stock = params.stock ?? "ALL";
    const sort = params.sort ?? "NEWEST";

    /*
     * ==========================================
     * CATEGORY
     * ==========================================
     */

    const categoryRows = await prisma.product.findMany({
        where: {
            category: {
                not: null,
            },
        },
        select: {
            category: true,
        },
        distinct: ["category"],
        orderBy: {
            category: "asc",
        },
    });

    const categories = categoryRows
        .map((item) => item.category)
        .filter((item): item is string => Boolean(item));

    /*
     * ==========================================
     * WHERE
     * ==========================================
     */

    const where: any = {};

    if (q) {
        where.OR = [
            {
                name: {
                    contains: q,
                },
            },
            {
                slug: {
                    contains: q,
                },
            },
        ];
    }

    if (category !== "ALL" && category) {
        where.category = category;
    }

    if (status === "BESTSELLER") {
        where.bestseller = true;
    }

    if (status === "NORMAL") {
        where.bestseller = false;
    }

    /*
     * ==========================================
     * DEFAULT ORDER
     * ==========================================
     */

    let orderBy: any = {
        createdAt: "desc",
    };

    if (sort === "OLDEST") {
        orderBy = {
            createdAt: "asc",
        };
    }

    /*
     * ==========================================
     * PRODUCTS
     * ==========================================
     */

    const products = await prisma.product.findMany({
        where,
        orderBy,
        include: {
            variants: {
                orderBy: {
                    price: "asc",
                },
            },
        },
    });

    /*
     * ==========================================
     * STOCK FILTER
     * ==========================================
     */

    const filteredProducts = products.filter((product) => {
        const totalStock = product.variants.reduce(
            (total, variant) => total + variant.stock,
            0
        );

        if (stock === "AVAILABLE") {
            return totalStock > 5;
        }

        if (stock === "LOW") {
            return totalStock > 0 && totalStock <= 5;
        }

        if (stock === "EMPTY") {
            return totalStock === 0;
        }

        return true;
    });

    /*
     * ==========================================
     * PRICE SORT
     * ==========================================
     */

    if (sort === "PRICE_LOW" || sort === "PRICE_HIGH") {
        filteredProducts.sort((a, b) => {
            const priceA =
                a.variants.length > 0 ? Number(a.variants[0].price) : Infinity;

            const priceB =
                b.variants.length > 0 ? Number(b.variants[0].price) : Infinity;

            return sort === "PRICE_LOW" ? priceA - priceB : priceB - priceA;
        });
    }

    /*
     * ==========================================
     * STOCK SORT
     * ==========================================
     */

    if (sort === "STOCK_HIGH") {
        filteredProducts.sort((a, b) => {
            const stockA = a.variants.reduce((total, variant) => total + variant.stock, 0);

            const stockB = b.variants.reduce((total, variant) => total + variant.stock, 0);

            return stockB - stockA;
        });
    }

    const sortLabel =
        sort === "NEWEST"
            ? "Terbaru"
            : sort === "OLDEST"
              ? "Terlama"
              : sort === "PRICE_LOW"
                ? "Harga terendah"
                : sort === "PRICE_HIGH"
                  ? "Harga tertinggi"
                  : "Stok terbanyak";

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Produk"
                description="Kelola produk dan variant toko."
                actions={
                    <PrimaryAction
                        href="/admin/products/new"
                        leftSection={<FiPlus size={17} />}
                    >
                        Tambah Produk
                    </PrimaryAction>
                }
            />

            <RealtimeProductFilter categories={categories} />

            <SectionCard
                title="Daftar Produk"
                description={
                    <Group gap="xs">
                        <Text span size="sm" fw={600} c="inherit">
                            {filteredProducts.length}
                        </Text>
                        <Text span size="sm" c="inherit">
                            produk
                        </Text>
                        {q ? (
                            <Text span size="sm" c="inherit">
                                · hasil untuk &quot;{q}&quot;
                            </Text>
                        ) : null}
                    </Group>
                }
                actions={
                    <Text size="sm" c="dimmed">
                        Urut: {sortLabel}
                    </Text>
                }
            >
                <DataTable
                    minWidth={1040}
                    empty={
                        <EmptyBlock
                            icon={<FiImage size={22} />}
                            title="Produk tidak ditemukan"
                            description="Tidak ada produk yang sesuai dengan filter saat ini."
                            action={
                                <PrimaryAction
                                    href="/admin/products"
                                    variant="default"
                                >
                                    Reset Filter
                                </PrimaryAction>
                            }
                        />
                    }
                    columns={[
                        { header: "Produk" },
                        { header: "Kategori" },
                        { header: "Variant" },
                        { header: "Harga" },
                        { header: "Stok" },
                        { header: "Status" },
                        { header: "Aksi", align: "right" },
                    ]}
                    rows={filteredProducts.map((product) => {
                        const lowestPrice =
                            product.variants.length > 0 ? product.variants[0].price : null;

                        const totalStock = product.variants.reduce(
                            (total, variant) => total + variant.stock,
                            0
                        );

                        return {
                            key: String(product.id),
                            cells: [
                                <Group gap="sm" wrap="nowrap" key="product">
                                    <Box
                                        w={44}
                                        h={44}
                                        style={{
                                            borderRadius: 8,
                                            overflow: "hidden",
                                            flexShrink: 0,
                                            background: "var(--mantine-color-gray-1)",
                                        }}
                                    >
                                        {product.image ? (
                                            <Image
                                                src={product.image}
                                                alt={product.name}
                                                w={44}
                                                h={44}
                                                fit="cover"
                                            />
                                        ) : (
                                            <Group justify="center" align="center" h={44}>
                                                <Text size="xs" c="dimmed">
                                                    —
                                                </Text>
                                            </Group>
                                        )}
                                    </Box>

                                    <Box style={{ minWidth: 0 }}>
                                        <Text size="sm" fw={600} lineClamp={1}>
                                            {product.name}
                                        </Text>

                                        <Text size="xs" c="dimmed" lineClamp={1}>
                                            /products/{product.slug}
                                        </Text>
                                    </Box>
                                </Group>,

                                <Text size="sm" key="category">
                                    {product.category ?? "—"}
                                </Text>,

                                <Group gap="xs" key="variants" maw={260}>
                                    {product.variants.map((variant) => (
                                        <Badge
                                            key={variant.id}
                                            variant="default"
                                            size="sm"
                                            radius="sm"
                                        >
                                            {variant.name}
                                        </Badge>
                                    ))}
                                </Group>,

                                <Box key="price">
                                    <Text size="sm" fw={600} style={{ whiteSpace: "nowrap" }}>
                                        {lowestPrice
                                            ? `Rp ${Number(lowestPrice).toLocaleString("id-ID")}`
                                            : "-"}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        harga mulai
                                    </Text>
                                </Box>,

                                <Box key="stock">
                                    <Text
                                        size="sm"
                                        fw={600}
                                        c={
                                            totalStock === 0
                                                ? "red"
                                                : totalStock <= 5
                                                  ? "orange"
                                                  : undefined
                                        }
                                    >
                                        {totalStock}
                                    </Text>

                                    <Text size="xs" c="dimmed">
                                        total stok
                                    </Text>
                                </Box>,

                                product.bestseller ? (
                                    <Badge
                                        key="status"
                                        variant="light"
                                        color="orange"
                                        size="sm"
                                        radius="sm"
                                    >
                                        Bestseller
                                    </Badge>
                                ) : (
                                    <Badge
                                        key="status"
                                        variant="default"
                                        color="gray"
                                        size="sm"
                                        radius="sm"
                                    >
                                        Normal
                                    </Badge>
                                ),

                                <Group justify="flex-end" gap="xs" wrap="nowrap" key="actions">
                                    <PrimaryAction
                                        href={`/admin/products/${product.id}/edit`}
                                        variant="default"
                                        leftSection={<FiEdit2 size={15} />}
                                    >
                                        Edit
                                    </PrimaryAction>

                                    <DeleteProductButton
                                        productId={product.id}
                                        productName={product.name}
                                    />
                                </Group>,
                            ],
                        };
                    })}
                />
            </SectionCard>
        </Stack>
    );
}
