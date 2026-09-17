"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import toast from "react-hot-toast";

import { FiArrowLeft, FiPlus, FiTrash2 } from "react-icons/fi";

import {
    Box,
    Button,
    Checkbox,
    Divider,
    Grid,
    Group,
    NumberInput,
    Stack,
    Text,
    Textarea,
    TextInput,
} from "@mantine/core";

import { PageHeader, SectionCard } from "@/components/dashboard/primitives";
import ProductImageUpload from "@/components/admin/ProductImageUpload";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: every state value, `handleNameChange`'s auto-slug, `updateVariant`,
 * `addVariant`, `removeVariant`'s last-row guard, all five validation branches and their toast
 * copy, the `POST /api/admin/products` payload shape (`Number()` conversions, `|| null` fallbacks,
 * `variants` array) and the `router.push` + `router.refresh` pair.
 *
 * The variant fields intentionally stay **strings** in state, as they were: the original
 * `<input type="number">` held text and only converted at submit. `NumberInput` is bound through
 * `String(value)` so the payload is byte-identical to before — converting the state to numbers here
 * would have silently changed the truthiness tests in the validation (`!variant.price`).
 */

type Variant = {
    name: string;
    price: string;
    stock: string;
    weight: string;
};

function createSlug(value: string) {
    return value
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");
}

export default function NewProductPage() {
    const router = useRouter();

    const [name, setName] = useState("");
    const [slug, setSlug] = useState("");
    const [description, setDescription] = useState("");
    const [category, setCategory] = useState("");

    const [image, setImage] = useState("");

    const [bestseller, setBestseller] = useState(false);

    const [variants, setVariants] = useState<Variant[]>([
        {
            name: "",
            price: "",
            stock: "",
            weight: "",
        },
    ]);

    const [loading, setLoading] = useState(false);

    function handleNameChange(value: string) {
        setName(value);
        setSlug(createSlug(value));
    }

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
            },
        ]);
    }

    function removeVariant(index: number) {
        if (variants.length === 1) {
            return;
        }

        setVariants((current) =>
            current.filter((_, variantIndex) => variantIndex !== index)
        );
    }

    async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!name.trim()) {
            toast.error("Nama produk wajib diisi.");
            return;
        }

        if (!slug.trim()) {
            toast.error("Slug produk wajib diisi.");
            return;
        }

        if (!category.trim()) {
            toast.error("Kategori wajib diisi.");
            return;
        }

        if (variants.length === 0) {
            toast.error("Produk minimal memiliki satu variant.");
            return;
        }

        const invalidVariant = variants.some(
            (variant) =>
                !variant.name.trim() || !variant.price || !variant.stock || !variant.weight
        );

        if (invalidVariant) {
            toast.error("Lengkapi nama, harga, stok, dan berat semua variant.");
            return;
        }

        try {
            setLoading(true);

            const response = await fetch("/api/admin/products", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    name: name.trim(),
                    slug: slug.trim(),
                    description: description.trim() || null,
                    category: category.trim(),
                    image: image.trim() || null,
                    bestseller,
                    variants: variants.map((variant) => ({
                        name: variant.name,
                        price: Number(variant.price),
                        stock: Number(variant.stock),
                        weight: Number(variant.weight),
                    })),
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || "Gagal membuat produk.");
            }

            toast.success("Produk berhasil dibuat.");

            router.push("/admin/products");

            router.refresh();
        } catch (error) {
            console.error(error);

            toast.error(
                error instanceof Error ? error.message : "Gagal membuat produk."
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <Box maw={1040}>
            <PageHeader
                eyebrow="Admin"
                title="Tambah Produk"
                description="Isi informasi produk dan variant yang akan dijual."
                actions={
                    <Button
                        component={Link}
                        href="/admin/products"
                        variant="default"
                        size="md"
                        radius="md"
                        leftSection={<FiArrowLeft size={16} />}
                    >
                        Kembali ke Produk
                    </Button>
                }
            />

            <form onSubmit={handleSubmit}>
                <Stack gap="lg">
                    {/* INFORMASI PRODUK */}

                    <SectionCard
                        title="Informasi Produk"
                        description="Informasi dasar yang akan digunakan pada halaman produk."
                    >
                        <Stack gap="md">
                            <TextInput
                                id="name"
                                label="Nama Produk"
                                size="md"
                                radius="md"
                                value={name}
                                onChange={(event) => handleNameChange(event.currentTarget.value)}
                                placeholder="Contoh: Keripik Singkong Bumbu Rujak"
                            />

                            <Grid gap="md">
                                <Grid.Col span={{ base: 12, md: 6 }}>
                                    <TextInput
                                        id="slug"
                                        label="Slug"
                                        description="Digunakan sebagai URL produk."
                                        size="md"
                                        radius="md"
                                        value={slug}
                                        onChange={(event) => setSlug(event.currentTarget.value)}
                                        placeholder="keripik-singkong-bumbu-rujak"
                                    />
                                </Grid.Col>

                                <Grid.Col span={{ base: 12, md: 6 }}>
                                    <TextInput
                                        id="category"
                                        label="Kategori"
                                        size="md"
                                        radius="md"
                                        value={category}
                                        onChange={(event) => setCategory(event.currentTarget.value)}
                                        placeholder="Contoh: Keripik"
                                    />
                                </Grid.Col>
                            </Grid>

                            <Textarea
                                id="description"
                                label="Deskripsi Produk"
                                size="md"
                                radius="md"
                                value={description}
                                onChange={(event) => setDescription(event.currentTarget.value)}
                                rows={5}
                                autosize
                                minRows={5}
                                maxRows={12}
                                placeholder="Jelaskan detail produk, bahan, ukuran, rasa, dan informasi lainnya..."
                            />

                            <Divider />

                            <Checkbox
                                size="md"
                                radius="sm"
                                checked={bestseller}
                                onChange={(event) => setBestseller(event.currentTarget.checked)}
                                label="Tandai sebagai Best Seller"
                                description="Produk akan ditampilkan sebagai produk terlaris."
                            />
                        </Stack>
                    </SectionCard>

                    {/* GAMBAR */}

                    <SectionCard
                        title="Gambar Produk"
                        description="Gunakan gambar utama produk."
                    >
                        <ProductImageUpload value={image} onChange={setImage} />
                    </SectionCard>

                    {/* VARIANTS */}

                    <SectionCard
                        title="Variant Produk"
                        description="Atur harga, stok, dan berat untuk setiap variant."
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
                                <Box key={index}>
                                    {index > 0 ? <Divider mb="md" /> : null}

                                    <Group justify="space-between" align="center" mb="sm">
                                        <Text size="sm" fw={600}>
                                            Variant {index + 1}
                                        </Text>

                                        {variants.length > 1 && (
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
                                        )}
                                    </Group>

                                    <Grid gap="md">
                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <TextInput
                                                label="Nama Variant"
                                                size="md"
                                                radius="md"
                                                value={variant.name}
                                                onChange={(event) =>
                                                    updateVariant(
                                                        index,
                                                        "name",
                                                        event.currentTarget.value
                                                    )
                                                }
                                                placeholder="Contoh: 1 Kg"
                                            />
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <NumberInput
                                                label="Harga"
                                                size="md"
                                                radius="md"
                                                min={0}
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
                                                placeholder="28900"
                                            />
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <NumberInput
                                                label="Stok"
                                                size="md"
                                                radius="md"
                                                min={0}
                                                value={variant.stock === "" ? "" : Number(variant.stock)}
                                                onChange={(value) =>
                                                    updateVariant(
                                                        index,
                                                        "stock",
                                                        value === "" ? "" : String(value)
                                                    )
                                                }
                                                placeholder="100"
                                            />
                                        </Grid.Col>

                                        <Grid.Col span={{ base: 12, sm: 6, lg: 3 }}>
                                            <NumberInput
                                                label="Berat"
                                                size="md"
                                                radius="md"
                                                min={1}
                                                rightSection="gram"
                                                rightSectionWidth={52}
                                                description="1 Kg = 1000 gram"
                                                value={variant.weight === "" ? "" : Number(variant.weight)}
                                                onChange={(value) =>
                                                    updateVariant(
                                                        index,
                                                        "weight",
                                                        value === "" ? "" : String(value)
                                                    )
                                                }
                                                placeholder="1000"
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
                            loading={loading}
                            disabled={loading}
                        >
                            {loading ? "Menyimpan..." : "Simpan Produk"}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Box>
    );
}
