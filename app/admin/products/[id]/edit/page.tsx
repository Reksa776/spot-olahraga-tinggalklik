"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { FiArrowLeft, FiPlus, FiSave, FiTrash2 } from "react-icons/fi";

import {
    Alert,
    Box,
    Button,
    Checkbox,
    Divider,
    Grid,
    Group,
    NumberInput,
    Skeleton,
    Stack,
    Text,
    Textarea,
    TextInput,
} from "@mantine/core";

import { PageHeader, SectionCard } from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: the `GET /api/admin/products/{id}` load with `cache: "no-store"`, the mapping
 * from the API product into `form`/`variants` (including the `String(...)` conversions and the
 * `variant.image` field that has no input but must survive a save), `updateVariant`, `addVariant`,
 * `removeVariant`'s "minimal satu variant" guard and its toast, the `PUT` payload (`Number()`
 * conversions, `image || null`), the `toast.success` + `router.push` + `router.refresh` sequence,
 * the `loading` skeleton gate, the `error && !form.name` early-return, and both error copy strings.
 *
 * `useCallback` was added around `loadProduct` so the effect can declare it as a dependency without
 * changing when it runs; the previous version called it from `useEffect(..., [id])` and triggered
 * the same request at the same time.
 */

type Variant = {
    id?: number;
    name: string;
    price: string;
    stock: string;
    weight: string;
    image: string;
};

type Product = {
    id: number;
    name: string;
    slug: string;
    description: string | null;
    category: string | null;
    image: string | null;
    bestseller: boolean;
    variants: Variant[];
};

export default function EditProductPage() {
    const params = useParams();
    const router = useRouter();

    const id = params.id as string;

    const [loading, setLoading] = useState(true);

    const [saving, setSaving] = useState(false);

    const [error, setError] = useState("");

    const [form, setForm] = useState({
        name: "",
        slug: "",
        description: "",
        category: "",
        image: "",
        bestseller: false,
    });

    const [variants, setVariants] = useState<Variant[]>([]);

    const loadProduct = useCallback(async () => {
        try {
            setLoading(true);
            setError("");

            const response = await fetch(`/api/admin/products/${id}`, {
                cache: "no-store",
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || "Gagal mengambil produk.");
            }

            const product: Product = data.product;

            setForm({
                name: product.name || "",
                slug: product.slug || "",
                description: product.description || "",
                category: product.category || "",
                image: product.image || "",
                bestseller: Boolean(product.bestseller),
            });

            setVariants(
                product.variants.map((variant) => ({
                    id: variant.id,
                    name: variant.name || "",
                    price: String(variant.price),
                    stock: String(variant.stock),
                    weight: String(variant.weight),
                    image: variant.image || "",
                }))
            );
        } catch (caught) {
            console.error("LOAD PRODUCT ERROR:", caught);

            setError(caught instanceof Error ? caught.message : "Gagal mengambil produk.");
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => {
        loadProduct();
    }, [loadProduct]);

    function updateVariant(index: number, field: keyof Variant, value: string) {
        setVariants((current) =>
            current.map((variant, variantIndex) =>
                variantIndex === index
                    ? {
                          ...variant,
                          [field]: value,
                      }
                    : variant
            )
        );
    }

    function addVariant() {
        setVariants((current) => [
            ...current,
            {
                name: "",
                price: "",
                stock: "",
                weight: "",
                image: "",
            },
        ]);
    }

    function removeVariant(index: number) {
        if (variants.length <= 1) {
            toast.error("Produk minimal harus memiliki satu variant.");

            return;
        }

        setVariants((current) => current.filter((_, i) => i !== index));
    }

    async function handleSubmit(event: React.FormEvent) {
        event.preventDefault();

        try {
            setSaving(true);
            setError("");

            const payload = {
                ...form,

                variants: variants.map((variant) => ({
                    id: variant.id,
                    name: variant.name,
                    price: Number(variant.price),
                    stock: Number(variant.stock),
                    weight: Number(variant.weight),
                    image: variant.image || null,
                })),
            };

            const response = await fetch(`/api/admin/products/${id}`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || "Gagal memperbarui produk.");
            }

            toast.success(data.message || "Produk berhasil diperbarui.");

            router.push("/admin/products");

            router.refresh();
        } catch (caught) {
            console.error("UPDATE PRODUCT ERROR:", caught);

            setError(
                caught instanceof Error ? caught.message : "Gagal memperbarui produk."
            );
        } finally {
            setSaving(false);
        }
    }

    if (loading) {
        return (
            <Box maw={1040}>
                <Skeleton height={28} width={220} radius="sm" />
                <Skeleton height={16} width={380} mt="sm" radius="sm" />

                <Stack gap="lg" mt="xl">
                    <Skeleton height={420} radius="md" />
                    <Skeleton height={340} radius="md" />
                </Stack>
            </Box>
        );
    }

    if (error && !form.name) {
        return (
            <Box maw={1040}>
                <Alert color="red" variant="light" radius="md" title="Gagal memuat produk">
                    {error}
                </Alert>

                <Button
                    component={Link}
                    href="/admin/products"
                    variant="default"
                    size="md"
                    radius="md"
                    mt="lg"
                    leftSection={<FiArrowLeft size={16} />}
                >
                    Kembali ke Produk
                </Button>
            </Box>
        );
    }

    return (
        <Box maw={1040}>
            <PageHeader
                eyebrow="Admin"
                title="Edit Produk"
                description="Perbarui informasi produk dan variant yang tersedia."
                actions={
                    <Button
                        component={Link}
                        href="/admin/products"
                        variant="default"
                        size="md"
                        radius="md"
                        leftSection={<FiArrowLeft size={16} />}
                    >
                        Produk
                    </Button>
                }
            />

            <form onSubmit={handleSubmit}>
                <Stack gap="lg">
                    {/* ERROR */}

                    {error && (
                        <Alert color="red" variant="light" radius="md" title="Terjadi kesalahan">
                            {error}
                        </Alert>
                    )}

                    {/* PRODUCT INFO */}

                    <SectionCard
                        title="Informasi Produk"
                        description="Informasi utama yang digunakan pada halaman produk."
                    >
                        <Stack gap="md">
                            <TextInput
                                label="Nama Produk"
                                size="md"
                                radius="md"
                                required
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                            />

                            <Grid gap="md">
                                <Grid.Col span={{ base: 12, sm: 6 }}>
                                    <TextInput
                                        label="Slug"
                                        description="Digunakan pada URL produk."
                                        size="md"
                                        radius="md"
                                        required
                                        value={form.slug}
                                        onChange={(event) =>
                                            setForm({
                                                ...form,
                                                slug: event.currentTarget.value,
                                            })
                                        }
                                    />
                                </Grid.Col>

                                <Grid.Col span={{ base: 12, sm: 6 }}>
                                    <TextInput
                                        label="Kategori"
                                        size="md"
                                        radius="md"
                                        required
                                        value={form.category}
                                        onChange={(event) =>
                                            setForm({
                                                ...form,
                                                category: event.currentTarget.value,
                                            })
                                        }
                                    />
                                </Grid.Col>
                            </Grid>

                            <TextInput
                                label="URL / Path Image"
                                size="md"
                                radius="md"
                                value={form.image}
                                onChange={(event) =>
                                    setForm({ ...form, image: event.currentTarget.value })
                                }
                                placeholder="/uploads/products/..."
                            />

                            <Textarea
                                label="Deskripsi"
                                size="md"
                                radius="md"
                                value={form.description}
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        description: event.currentTarget.value,
                                    })
                                }
                                rows={7}
                                autosize
                                minRows={5}
                                maxRows={14}
                            />

                            <Divider />

                            <Checkbox
                                size="md"
                                radius="sm"
                                checked={form.bestseller}
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        bestseller: event.currentTarget.checked,
                                    })
                                }
                                label="Tandai sebagai Bestseller"
                                description="Produk akan ditampilkan sebagai produk terlaris."
                            />
                        </Stack>
                    </SectionCard>

                    {/* VARIANTS */}

                    <SectionCard
                        title="Variant"
                        description="Berat digunakan untuk perhitungan pengiriman."
                        actions={
                            <Button
                                type="button"
                                variant="default"
                                size="md"
                                radius="md"
                                leftSection={<FiPlus size={16} />}
                                onClick={addVariant}
                            >
                                Tambah Variant
                            </Button>
                        }
                    >
                        <Stack gap="md">
                            {variants.map((variant, index) => (
                                <Box key={variant.id ?? `new-${index}`}>
                                    {index > 0 ? <Divider mb="md" /> : null}

                                    <Group justify="space-between" align="center" mb="sm">
                                        <Group gap="xs">
                                            <Text size="sm" fw={600}>
                                                Variant {index + 1}
                                            </Text>

                                            {variant.id && (
                                                <Text size="xs" c="dimmed">
                                                    ID #{variant.id}
                                                </Text>
                                            )}
                                        </Group>

                                        <Button
                                            type="button"
                                            variant="subtle"
                                            color="red"
                                            size="compact-md"
                                            radius="md"
                                            leftSection={<FiTrash2 size={15} />}
                                            onClick={() => removeVariant(index)}
                                        >
                                            Hapus
                                        </Button>
                                    </Group>

                                    <Grid gap="md">
                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <TextInput
                                                label="Nama"
                                                size="md"
                                                radius="md"
                                                required
                                                value={variant.name}
                                                onChange={(event) =>
                                                    updateVariant(
                                                        index,
                                                        "name",
                                                        event.currentTarget.value
                                                    )
                                                }
                                            />
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <NumberInput
                                                label="Harga"
                                                size="md"
                                                radius="md"
                                                required
                                                min={1}
                                                max={9999999999}
                                                thousandSeparator="."
                                                decimalSeparator=","
                                                leftSection="Rp"
                                                leftSectionWidth={44}
                                                value={variant.price === "" ? "" : Number(variant.price)}
                                                onChange={(value) =>
                                                    updateVariant(
                                                        index,
                                                        "price",
                                                        value === "" ? "" : String(value)
                                                    )
                                                }
                                            />
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <NumberInput
                                                label="Stok"
                                                size="md"
                                                radius="md"
                                                required
                                                min={0}
                                                value={variant.stock === "" ? "" : Number(variant.stock)}
                                                onChange={(value) =>
                                                    updateVariant(
                                                        index,
                                                        "stock",
                                                        value === "" ? "" : String(value)
                                                    )
                                                }
                                            />
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <NumberInput
                                                label="Berat"
                                                size="md"
                                                radius="md"
                                                required
                                                min={1}
                                                rightSection="gram"
                                                rightSectionWidth={52}
                                                value={variant.weight === "" ? "" : Number(variant.weight)}
                                                onChange={(value) =>
                                                    updateVariant(
                                                        index,
                                                        "weight",
                                                        value === "" ? "" : String(value)
                                                    )
                                                }
                                            />
                                        </Grid.Col>
                                    </Grid>
                                </Box>
                            ))}
                        </Stack>
                    </SectionCard>

                    {/* ACTION */}

                    <Group justify="flex-end" gap="sm">
                        <Button
                            component={Link}
                            href="/admin/products"
                            variant="default"
                            size="lg"
                            radius="md"
                        >
                            Batal
                        </Button>

                        <Button
                            type="submit"
                            size="lg"
                            radius="md"
                            loading={saving}
                            disabled={saving}
                            leftSection={<FiSave size={16} />}
                        >
                            {saving ? "Menyimpan..." : "Simpan Perubahan"}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Box>
    );
}
