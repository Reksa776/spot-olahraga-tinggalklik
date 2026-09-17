"use client";

import { FiSearch, FiSliders, FiX } from "react-icons/fi";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
    ActionIcon,
    Badge,
    Box,
    Button,
    Divider,
    Group,
    Paper,
    Select,
    Stack,
    Text,
    TextInput,
} from "@mantine/core";

type Props = {
    categories: string[];
};

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * This is an URL-driven filter, so the contract that matters is the query string. Preserved
 * exactly: the five states and their defaults, `updateUrl`'s per-key set/delete rules (including
 * that `category`/`status`/`stock` delete on `"ALL"` and `sort` deletes on `"NEWEST"`), the
 * `router.replace(..., { scroll: false })` call, the 350ms search debounce with its
 * `firstRender` skip, `resetFilters()`, and `hasFilter` as the visibility rule.
 *
 * Only the controls changed: `TextInput` with a search section, `Select` for the four dropdowns,
 * `Button` for reset and `Badge` for the active-filter chips.
 */
export default function RealtimeProductFilter({ categories }: Props) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();

    const [q, setQ] = useState(searchParams.get("q") ?? "");

    const [category, setCategory] = useState(searchParams.get("category") ?? "ALL");

    const [status, setStatus] = useState(searchParams.get("status") ?? "ALL");

    const [stock, setStock] = useState(searchParams.get("stock") ?? "ALL");

    const [sort, setSort] = useState(searchParams.get("sort") ?? "NEWEST");

    const firstRender = useRef(true);

    function updateUrl(values: {
        q?: string;
        category?: string;
        status?: string;
        stock?: string;
        sort?: string;
    }) {
        const params = new URLSearchParams(searchParams.toString());

        if (values.q !== undefined) {
            if (values.q.trim()) {
                params.set("q", values.q.trim());
            } else {
                params.delete("q");
            }
        }

        if (values.category !== undefined) {
            if (values.category && values.category !== "ALL") {
                params.set("category", values.category);
            } else {
                params.delete("category");
            }
        }

        if (values.status !== undefined) {
            if (values.status && values.status !== "ALL") {
                params.set("status", values.status);
            } else {
                params.delete("status");
            }
        }

        if (values.stock !== undefined) {
            if (values.stock && values.stock !== "ALL") {
                params.set("stock", values.stock);
            } else {
                params.delete("stock");
            }
        }

        if (values.sort !== undefined) {
            if (values.sort && values.sort !== "NEWEST") {
                params.set("sort", values.sort);
            } else {
                params.delete("sort");
            }
        }

        const query = params.toString();

        router.replace(query ? `${pathname}?${query}` : pathname, {
            scroll: false,
        });
    }

    /*
     * SEARCH DEBOUNCE
     */

    useEffect(() => {
        if (firstRender.current) {
            firstRender.current = false;
            return;
        }

        const timer = setTimeout(() => {
            updateUrl({ q });
        }, 350);

        return () => {
            clearTimeout(timer);
        };
    }, [q]);

    function changeCategory(value: string | null) {
        const next = value ?? "ALL";

        setCategory(next);

        updateUrl({
            category: next,
        });
    }

    function changeStatus(value: string | null) {
        const next = value ?? "ALL";

        setStatus(next);

        updateUrl({
            status: next,
        });
    }

    function changeStock(value: string | null) {
        const next = value ?? "ALL";

        setStock(next);

        updateUrl({
            stock: next,
        });
    }

    function changeSort(value: string | null) {
        const next = value ?? "NEWEST";

        setSort(next);

        updateUrl({
            sort: next,
        });
    }

    function resetFilters() {
        setQ("");
        setCategory("ALL");
        setStatus("ALL");
        setStock("ALL");
        setSort("NEWEST");

        router.replace(pathname, {
            scroll: false,
        });
    }

    const hasFilter =
        q.trim() !== "" ||
        category !== "ALL" ||
        status !== "ALL" ||
        stock !== "ALL" ||
        sort !== "NEWEST";

    return (
        <Paper withBorder radius="md" mb="lg">
            <Group gap="md" align="flex-end" wrap="wrap" p="md">
                {/* SEARCH */}

                <TextInput
                    flex={1}
                    miw={{ base: "100%", sm: 240 }}
                    size="md"
                    radius="md"
                    type="search"
                    value={q}
                    onChange={(event) => setQ(event.currentTarget.value)}
                    placeholder="Cari produk..."
                    aria-label="Cari produk"
                    leftSection={<FiSearch size={16} />}
                    rightSection={
                        q ? (
                            <ActionIcon
                                variant="subtle"
                                color="gray"
                                size="sm"
                                radius="xl"
                                onClick={() => setQ("")}
                                aria-label="Hapus pencarian"
                            >
                                <FiX size={14} />
                            </ActionIcon>
                        ) : undefined
                    }
                />

                <Divider orientation="vertical" visibleFrom="md" my={4} />

                {/* CATEGORY */}

                <Select
                    size="md"
                    radius="md"
                    value={category}
                    onChange={changeCategory}
                    aria-label="Filter kategori"
                    data={[
                        { value: "ALL", label: "Semua kategori" },
                        ...categories.map((item) => ({ value: item, label: item })),
                    ]}
                    w={{ base: "100%", sm: 165 }}
                    allowDeselect={false}
                />

                {/* STATUS */}

                <Select
                    size="md"
                    radius="md"
                    value={status}
                    onChange={changeStatus}
                    aria-label="Filter status"
                    data={[
                        { value: "ALL", label: "Semua status" },
                        { value: "BESTSELLER", label: "Bestseller" },
                        { value: "NORMAL", label: "Normal" },
                    ]}
                    w={{ base: "100%", sm: 145 }}
                    allowDeselect={false}
                />

                {/* STOCK */}

                <Select
                    size="md"
                    radius="md"
                    value={stock}
                    onChange={changeStock}
                    aria-label="Filter stok"
                    data={[
                        { value: "ALL", label: "Semua stok" },
                        { value: "AVAILABLE", label: "Tersedia" },
                        { value: "LOW", label: "Menipis" },
                        { value: "EMPTY", label: "Habis" },
                    ]}
                    w={{ base: "100%", sm: 145 }}
                    allowDeselect={false}
                />

                {/* SORT */}

                <Select
                    size="md"
                    radius="md"
                    value={sort}
                    onChange={changeSort}
                    aria-label="Urutkan"
                    data={[
                        { value: "NEWEST", label: "Terbaru" },
                        { value: "OLDEST", label: "Terlama" },
                        { value: "PRICE_LOW", label: "Harga terendah" },
                        { value: "PRICE_HIGH", label: "Harga tertinggi" },
                        { value: "STOCK_HIGH", label: "Stok terbanyak" },
                    ]}
                    w={{ base: "100%", sm: 160 }}
                    allowDeselect={false}
                />

                {/* RESET */}

                {hasFilter && (
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        leftSection={<FiX size={15} />}
                        onClick={resetFilters}
                    >
                        Reset
                    </Button>
                )}
            </Group>

            {/* ACTIVE FILTER INFO */}

            {hasFilter && (
                <>
                    <Divider />

                    <Group gap="xs" px="md" py="xs">
                        <FiSliders size={13} />

                        <Text size="xs" c="dimmed">
                            Filter aktif
                        </Text>

                        {category !== "ALL" && (
                            <Badge variant="default" size="sm" radius="sm">
                                {category}
                            </Badge>
                        )}

                        {status !== "ALL" && (
                            <Badge variant="default" size="sm" radius="sm">
                                {status === "BESTSELLER" ? "Bestseller" : "Normal"}
                            </Badge>
                        )}

                        {stock !== "ALL" && (
                            <Badge variant="default" size="sm" radius="sm">
                                {stock === "AVAILABLE"
                                    ? "Stok tersedia"
                                    : stock === "LOW"
                                      ? "Stok menipis"
                                      : "Stok habis"}
                            </Badge>
                        )}
                    </Group>
                </>
            )}
        </Paper>
    );
}
