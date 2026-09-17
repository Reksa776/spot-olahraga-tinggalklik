"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { FiArrowLeft, FiSave } from "react-icons/fi";
import toast from "react-hot-toast";

import {
    Box,
    Button,
    Grid,
    Group,
    Select,
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
 * This is the largest form in the dashboard and its semantics are load-bearing, so nothing about
 * the state machine changed. Preserved exactly: `StoreForm` and `initialForm` (every field,
 * including `rajaOngkirDestinationId`), `updateField`, `loadRegions` and its query builder,
 * all four "load wilayah" handlers with their loading flags and toast copy, `loadDestinationId`
 * (both the success `setForm` with `Number(destinationId)` and the failure `setForm` that clears
 * the id, plus the `console.log`), `loadSettings` with its field-by-field `?? null` mapping and the
 * cascade of `loadCities`/`loadDistricts`/`loadSubdistricts` for already-saved values, the
 * `Promise.all([loadProvinces(), loadSettings()])` init (and its eslint-disable), all four
 * `handle*Change` cascades that null out and clear child levels, `handleSubmit`'s five validation
 * branches, and the `PUT /api/admin/settings` body — which is the **whole form object**, not a
 * projection, so `JSON.stringify(form)` is kept verbatim.
 *
 * The five region controls keep their exact `disabled` conditions and the string-id contract with
 * the `handle*Change(value: string)` handlers; `Select` supplies the same empty/placeholder option
 * the native `<select>` had.
 */

type Region = {
    id: number;
    name: string;
    zip_code?: string | null;
    postal_code?: string | null;
    postalCode?: string | null;
};

type StoreForm = {
    storeName: string;
    phone: string;
    email: string;
    logo: string;
    address: string;

    tiktokPixelId: string;

    provinceId: number | null;
    province: string;

    cityId: number | null;
    city: string;

    districtId: number | null;
    district: string;

    subdistrictId: number | null;
    subdistrict: string;

    postalCode: string;

    // WAJIB ADA
    rajaOngkirDestinationId: number | null;

    latitude: string;
    longitude: string;
};

const initialForm: StoreForm = {
    storeName: "",
    phone: "",
    email: "",
    logo: "",
    address: "",

    tiktokPixelId: "",

    provinceId: null,
    province: "",

    cityId: null,
    city: "",

    districtId: null,
    district: "",

    subdistrictId: null,
    subdistrict: "",

    postalCode: "",

    rajaOngkirDestinationId: null,

    latitude: "",
    longitude: "",
};

export default function AdminSettingsForm() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [provinces, setProvinces] = useState<Region[]>([]);
    const [cities, setCities] = useState<Region[]>([]);
    const [districts, setDistricts] = useState<Region[]>([]);
    const [subdistricts, setSubdistricts] = useState<Region[]>([]);

    const [loadingCities, setLoadingCities] = useState(false);
    const [loadingDistricts, setLoadingDistricts] = useState(false);
    const [loadingSubdistricts, setLoadingSubdistricts] = useState(false);

    const [form, setForm] = useState<StoreForm>(initialForm);

    function updateField<K extends keyof StoreForm>(field: K, value: StoreForm[K]) {
        setForm((prev) => ({
            ...prev,
            [field]: value,
        }));
    }

    /**
     * ============================
     * LOAD WILAYAH
     * ============================
     */

    async function loadRegions(type: string, id?: number): Promise<Region[]> {
        const query = id ? `?type=${type}&id=${id}` : `?type=${type}`;

        const response = await fetch(`/api/admin/settings/regions${query}`, {
            cache: "no-store",
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Gagal mengambil data wilayah.");
        }

        return Array.isArray(data.data) ? data.data : [];
    }

    async function loadProvinces() {
        try {
            const data = await loadRegions("provinces");

            setProvinces(data);
        } catch (error) {
            console.error("LOAD PROVINCES ERROR:", error);

            toast.error(
                error instanceof Error ? error.message : "Gagal mengambil provinsi."
            );
        }
    }

    async function loadCities(provinceId: number) {
        try {
            setLoadingCities(true);

            const data = await loadRegions("cities", provinceId);

            setCities(data);
        } catch (error) {
            console.error("LOAD CITIES ERROR:", error);

            toast.error(error instanceof Error ? error.message : "Gagal mengambil kota.");
        } finally {
            setLoadingCities(false);
        }
    }

    async function loadDistricts(cityId: number) {
        try {
            setLoadingDistricts(true);

            const data = await loadRegions("districts", cityId);

            setDistricts(data);
        } catch (error) {
            console.error("LOAD DISTRICTS ERROR:", error);

            toast.error(
                error instanceof Error ? error.message : "Gagal mengambil kecamatan."
            );
        } finally {
            setLoadingDistricts(false);
        }
    }

    async function loadSubdistricts(districtId: number) {
        try {
            setLoadingSubdistricts(true);

            const data = await loadRegions("subdistricts", districtId);

            setSubdistricts(data);
        } catch (error) {
            console.error("LOAD SUBDISTRICTS ERROR:", error);

            toast.error(
                error instanceof Error ? error.message : "Gagal mengambil kelurahan."
            );
        } finally {
            setLoadingSubdistricts(false);
        }
    }

    async function loadDestinationId(subdistrict: string, postalCode: string) {
        try {
            if (!subdistrict && !postalCode) {
                return null;
            }

            const params = new URLSearchParams();

            if (subdistrict) {
                params.set("subdistrict", subdistrict);
            }

            if (postalCode) {
                params.set("postalCode", postalCode);
            }

            const response = await fetch(
                `/api/admin/settings/destination?${params.toString()}`,
                {
                    cache: "no-store",
                }
            );

            const data = await response.json();

            console.log("DESTINATION RESULT:", data);

            if (!response.ok) {
                throw new Error(data.message || "Gagal mendapatkan destination ID.");
            }

            const destinationId = data?.data?.id ?? data?.data?.destinationId;

            if (!destinationId) {
                throw new Error("Destination ID tidak ditemukan.");
            }

            setForm((prev) => ({
                ...prev,

                rajaOngkirDestinationId: Number(destinationId),
            }));

            return Number(destinationId);
        } catch (error) {
            console.error("LOAD DESTINATION ID ERROR:", error);

            setForm((prev) => ({
                ...prev,

                rajaOngkirDestinationId: null,
            }));

            toast.error(
                error instanceof Error
                    ? error.message
                    : "Gagal mendapatkan destination ID."
            );

            return null;
        }
    }

    /**
     * ============================
     * LOAD STORE SETTING
     * ============================
     */

    async function loadSettings() {
        try {
            const response = await fetch("/api/admin/settings", {
                cache: "no-store",
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || "Gagal mengambil pengaturan.");
            }

            if (!data.data) {
                return;
            }

            const nextForm: StoreForm = {
                storeName: data.data.storeName ?? "",

                phone: data.data.phone ?? "",

                email: data.data.email ?? "",

                logo: data.data.logo ?? "",

                address: data.data.address ?? "",
                tiktokPixelId: data.data.tiktokPixelId ?? "",

                provinceId: data.data.provinceId ?? null,

                province: data.data.province ?? "",

                cityId: data.data.cityId ?? null,

                city: data.data.city ?? "",

                districtId: data.data.districtId ?? null,

                district: data.data.district ?? "",

                subdistrictId: data.data.subdistrictId ?? null,

                subdistrict: data.data.subdistrict ?? "",

                postalCode: data.data.postalCode ?? "",

                rajaOngkirDestinationId: data.data.rajaOngkirDestinationId ?? null,

                latitude:
                    data.data.latitude != null ? String(data.data.latitude) : "",

                longitude:
                    data.data.longitude != null ? String(data.data.longitude) : "",
            };

            setForm(nextForm);

            /**
             * Load child wilayah
             * berdasarkan data yang
             * sudah tersimpan.
             */

            if (nextForm.provinceId) {
                await loadCities(nextForm.provinceId);
            }

            if (nextForm.cityId) {
                await loadDistricts(nextForm.cityId);
            }

            if (nextForm.districtId) {
                await loadSubdistricts(nextForm.districtId);
            }
        } catch (error) {
            console.error("LOAD SETTINGS ERROR:", error);

            toast.error(
                error instanceof Error ? error.message : "Gagal mengambil pengaturan."
            );
        }
    }

    /**
     * ============================
     * INITIAL LOAD
     * ============================
     */

    useEffect(() => {
        async function init() {
            setLoading(true);

            await Promise.all([loadProvinces(), loadSettings()]);

            setLoading(false);
        }

        init();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    /**
     * ============================
     * PROVINCE CHANGE
     * ============================
     */

    async function handleProvinceChange(value: string) {
        const provinceId = Number(value);

        if (!provinceId) {
            setForm((prev) => ({
                ...prev,

                provinceId: null,
                province: "",

                cityId: null,
                city: "",

                districtId: null,
                district: "",

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",
            }));

            setCities([]);
            setDistricts([]);
            setSubdistricts([]);

            return;
        }

        const province = provinces.find((item) => item.id === provinceId);

        setForm((prev) => ({
            ...prev,

            provinceId,

            province: province?.name ?? "",

            cityId: null,
            city: "",

            districtId: null,
            district: "",

            subdistrictId: null,
            subdistrict: "",

            postalCode: "",
        }));

        setCities([]);
        setDistricts([]);
        setSubdistricts([]);

        await loadCities(provinceId);
    }

    /**
     * ============================
     * CITY CHANGE
     * ============================
     */

    async function handleCityChange(value: string) {
        const cityId = Number(value);

        if (!cityId) {
            setForm((prev) => ({
                ...prev,

                cityId: null,
                city: "",

                districtId: null,
                district: "",

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",
            }));

            setDistricts([]);
            setSubdistricts([]);

            return;
        }

        const city = cities.find((item) => item.id === cityId);

        setForm((prev) => ({
            ...prev,

            cityId,

            city: city?.name ?? "",

            districtId: null,
            district: "",

            subdistrictId: null,
            subdistrict: "",

            postalCode: "",
        }));

        setDistricts([]);
        setSubdistricts([]);

        await loadDistricts(cityId);
    }

    /**
     * ============================
     * DISTRICT CHANGE
     * ============================
     */

    async function handleDistrictChange(value: string) {
        const districtId = Number(value);

        if (!districtId) {
            setForm((prev) => ({
                ...prev,

                districtId: null,
                district: "",

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",
            }));

            setSubdistricts([]);

            return;
        }

        const district = districts.find((item) => item.id === districtId);

        setForm((prev) => ({
            ...prev,

            districtId,

            district: district?.name ?? "",

            subdistrictId: null,
            subdistrict: "",

            postalCode: "",
        }));

        setSubdistricts([]);

        await loadSubdistricts(districtId);
    }

    /**
     * ============================
     * SUBDISTRICT CHANGE
     * ============================
     */

    async function handleSubdistrictChange(value: string) {
        const subdistrictId = Number(value);

        if (!subdistrictId) {
            setForm((prev) => ({
                ...prev,

                subdistrictId: null,
                subdistrict: "",

                postalCode: "",

                rajaOngkirDestinationId: null,
            }));

            return;
        }

        const subdistrict = subdistricts.find((item) => item.id === subdistrictId);

        const postalCode =
            subdistrict?.zip_code ?? subdistrict?.postal_code ?? subdistrict?.postalCode ?? "";

        const subdistrictName = subdistrict?.name ?? "";

        // Update UI terlebih dahulu
        setForm((prev) => ({
            ...prev,

            subdistrictId,

            subdistrict: subdistrictName,

            postalCode,

            rajaOngkirDestinationId: null,
        }));

        // Ambil RajaOngkir Destination ID
        if (subdistrictName) {
            await loadDestinationId(subdistrictName, postalCode);
        }
    }

    /**
     * ============================
     * SUBMIT
     * ============================
     */

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();

        if (!form.storeName.trim()) {
            toast.error("Nama toko wajib diisi.");
            return;
        }

        if (!form.address.trim()) {
            toast.error("Alamat toko wajib diisi.");
            return;
        }

        if (!form.provinceId) {
            toast.error("Pilih provinsi.");
            return;
        }

        if (!form.cityId) {
            toast.error("Pilih kota/kabupaten.");
            return;
        }

        if (!form.districtId) {
            toast.error("Pilih kecamatan.");
            return;
        }

        if (!form.subdistrictId) {
            toast.error("Pilih kelurahan/desa.");
            return;
        }

        try {
            setSaving(true);

            const response = await fetch("/api/admin/settings", {
                method: "PUT",

                headers: {
                    "Content-Type": "application/json",
                },

                body: JSON.stringify(form),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || "Gagal menyimpan pengaturan.");
            }

            toast.success("Pengaturan toko berhasil disimpan.");

            /**
             * Reload data supaya
             * state benar-benar sama
             * dengan database.
             */

            await loadSettings();
        } catch (error) {
            console.error("SAVE SETTINGS ERROR:", error);

            toast.error(
                error instanceof Error ? error.message : "Gagal menyimpan pengaturan."
            );
        } finally {
            setSaving(false);
        }
    }

    /**
     * ============================
     * LOADING
     * ============================
     */

    if (loading) {
        return (
            <Box maw={1040}>
                <Skeleton height={34} width={280} radius="sm" />
                <Skeleton height={16} width={320} mt="sm" radius="sm" />

                <Stack gap="lg" mt="xl">
                    <Skeleton height={220} radius="md" />
                    <Skeleton height={180} radius="md" />
                    <Skeleton height={420} radius="md" />
                    <Skeleton height={200} radius="md" />
                </Stack>
            </Box>
        );
    }

    return (
        <Box maw={1040}>
            <PageHeader
                eyebrow="Admin"
                title="Pengaturan Toko"
                description="Atur identitas dan lokasi toko."
                actions={
                    <Button
                        component={Link}
                        href="/admin"
                        variant="default"
                        size="md"
                        radius="md"
                        leftSection={<FiArrowLeft size={16} />}
                    >
                        Kembali ke Dashboard
                    </Button>
                }
            />

            <form onSubmit={handleSubmit}>
                <Stack gap="lg">
                    {/* INFORMASI TOKO */}

                    <SectionCard title="Informasi Toko">
                        <Grid gap="md">
                            <Grid.Col span={{ base: 12, md: 6 }}>
                                <TextInput
                                    label="Nama Toko"
                                    size="md"
                                    radius="md"
                                    value={form.storeName}
                                    onChange={(e) =>
                                        updateField("storeName", e.currentTarget.value)
                                    }
                                    placeholder="Nama toko"
                                />
                            </Grid.Col>

                            <Grid.Col span={{ base: 12, md: 6 }}>
                                <TextInput
                                    label="Nomor Telepon"
                                    size="md"
                                    radius="md"
                                    value={form.phone}
                                    onChange={(e) =>
                                        updateField("phone", e.currentTarget.value)
                                    }
                                    placeholder="08xxxxxxxxxx"
                                />
                            </Grid.Col>

                            <Grid.Col span={12}>
                                <TextInput
                                    label="Email"
                                    type="email"
                                    size="md"
                                    radius="md"
                                    value={form.email}
                                    onChange={(e) =>
                                        updateField("email", e.currentTarget.value)
                                    }
                                    placeholder="email@toko.com"
                                />
                            </Grid.Col>
                        </Grid>
                    </SectionCard>

                    {/* TRACKING & PIXEL */}

                    <SectionCard
                        title="Tracking & Pixel"
                        description="Masukkan TikTok Pixel ID untuk melacak aktivitas pengunjung dan pembelian dari TikTok Ads."
                    >
                        <TextInput
                            label="TikTok Pixel ID"
                            size="md"
                            radius="md"
                            ff="monospace"
                            value={form.tiktokPixelId}
                            onChange={(e) =>
                                updateField("tiktokPixelId", e.currentTarget.value.trim())
                            }
                            placeholder="Contoh: DA2N6IBC77U575JEFETG"
                            description="Contoh Pixel ID: DA2N6IBC77U575JEFETG"
                        />
                    </SectionCard>

                    {/* ALAMAT TOKO */}

                    <SectionCard
                        title="Alamat Toko"
                        description="Pilih wilayah dari data RajaOngkir."
                    >
                        <Stack gap="md">
                            <Textarea
                                label="Alamat Lengkap"
                                size="md"
                                radius="md"
                                value={form.address}
                                onChange={(e) =>
                                    updateField("address", e.currentTarget.value)
                                }
                                rows={4}
                                autosize
                                minRows={3}
                                maxRows={8}
                                placeholder="Nama jalan, nomor rumah, RT/RW, patokan..."
                            />

                            <Grid gap="md">
                                {/* PROVINSI */}

                                <Grid.Col span={{ base: 12, md: 6 }}>
                                    <Select
                                        label="Provinsi"
                                        size="md"
                                        radius="md"
                                        searchable
                                        allowDeselect
                                        placeholder="Pilih Provinsi"
                                        value={
                                            form.provinceId ? String(form.provinceId) : null
                                        }
                                        onChange={(value) =>
                                            handleProvinceChange(value ?? "")
                                        }
                                        data={provinces.map((item) => ({
                                            value: String(item.id),
                                            label: item.name,
                                        }))}
                                    />
                                </Grid.Col>

                                {/* KOTA */}

                                <Grid.Col span={{ base: 12, md: 6 }}>
                                    <Select
                                        label="Kota / Kabupaten"
                                        size="md"
                                        radius="md"
                                        searchable
                                        allowDeselect
                                        placeholder={
                                            loadingCities
                                                ? "Memuat kota..."
                                                : "Pilih Kota / Kabupaten"
                                        }
                                        value={form.cityId ? String(form.cityId) : null}
                                        disabled={!form.provinceId || loadingCities}
                                        onChange={(value) => handleCityChange(value ?? "")}
                                        data={cities.map((item) => ({
                                            value: String(item.id),
                                            label: item.name,
                                        }))}
                                    />
                                </Grid.Col>

                                {/* KECAMATAN */}

                                <Grid.Col span={{ base: 12, md: 6 }}>
                                    <Select
                                        label="Kecamatan"
                                        size="md"
                                        radius="md"
                                        searchable
                                        allowDeselect
                                        placeholder={
                                            loadingDistricts
                                                ? "Memuat kecamatan..."
                                                : "Pilih Kecamatan"
                                        }
                                        value={
                                            form.districtId ? String(form.districtId) : null
                                        }
                                        disabled={!form.cityId || loadingDistricts}
                                        onChange={(value) =>
                                            handleDistrictChange(value ?? "")
                                        }
                                        data={districts.map((item) => ({
                                            value: String(item.id),
                                            label: item.name,
                                        }))}
                                    />
                                </Grid.Col>

                                {/* KELURAHAN */}

                                <Grid.Col span={{ base: 12, md: 6 }}>
                                    <Select
                                        label="Kelurahan / Desa"
                                        size="md"
                                        radius="md"
                                        searchable
                                        allowDeselect
                                        placeholder={
                                            loadingSubdistricts
                                                ? "Memuat kelurahan..."
                                                : "Pilih Kelurahan / Desa"
                                        }
                                        value={
                                            form.subdistrictId
                                                ? String(form.subdistrictId)
                                                : null
                                        }
                                        disabled={!form.districtId || loadingSubdistricts}
                                        onChange={(value) =>
                                            handleSubdistrictChange(value ?? "")
                                        }
                                        data={subdistricts.map((item) => ({
                                            value: String(item.id),
                                            label: item.name,
                                        }))}
                                    />
                                </Grid.Col>
                            </Grid>

                            {/* KODE POS */}

                            <TextInput
                                label="Kode Pos"
                                size="md"
                                radius="md"
                                value={form.postalCode}
                                readOnly
                                description="Kode pos diisi otomatis berdasarkan kelurahan/desa yang dipilih."
                            />

                            <TextInput
                                label="RajaOngkir Destination ID"
                                size="md"
                                radius="md"
                                value={form.rajaOngkirDestinationId ?? "-"}
                                readOnly
                                placeholder="Akan terisi otomatis"
                                description="Destination ID dibuat otomatis berdasarkan kelurahan yang dipilih."
                            />
                        </Stack>
                    </SectionCard>

                    {/* KOORDINAT */}

                    <SectionCard
                        title="Koordinat Toko"
                        description="Untuk sementara koordinat dapat diisi manual. Nanti kita sambungkan ke GPS dan map."
                    >
                        <Grid gap="md">
                            <Grid.Col span={{ base: 12, md: 6 }}>
                                <TextInput
                                    label="Latitude"
                                    size="md"
                                    radius="md"
                                    value={form.latitude}
                                    onChange={(e) =>
                                        updateField("latitude", e.currentTarget.value)
                                    }
                                    placeholder="-6.2000000"
                                />
                            </Grid.Col>

                            <Grid.Col span={{ base: 12, md: 6 }}>
                                <TextInput
                                    label="Longitude"
                                    size="md"
                                    radius="md"
                                    value={form.longitude}
                                    onChange={(e) =>
                                        updateField("longitude", e.currentTarget.value)
                                    }
                                    placeholder="106.8166667"
                                />
                            </Grid.Col>
                        </Grid>
                    </SectionCard>

                    {/* SAVE */}

                    <Group justify="flex-end">
                        <Button
                            type="submit"
                            size="lg"
                            radius="md"
                            disabled={saving}
                            loading={saving}
                            leftSection={<FiSave size={17} />}
                        >
                            {saving ? "Menyimpan..." : "Simpan Pengaturan"}
                        </Button>
                    </Group>
                </Stack>
            </form>
        </Box>
    );
}
