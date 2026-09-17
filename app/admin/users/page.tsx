"use client";

import { useEffect, useState } from "react";
import { FiSearch, FiUsers } from "react-icons/fi";
import { Button, Group, Stack, Text, TextInput } from "@mantine/core";

import {
    DataTable,
    EmptyBlock,
    ErrorBlock,
    PageHeader,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";

type User = {
    id: string; name: string | null; email: string | null; phone: string | null;
    role: string; createdAt: string;
    _count?: { orders: number; addresses: number };
};

async function readJson(r: Response) { const t = await r.text(); if (!t) throw new Error(`Server error ${r.status}`); try { return JSON.parse(t); } catch { throw new Error(`Invalid JSON ${r.status}`); } }

function formatDate(v: string) { return new Date(v).toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric" }); }
function roleLabel(r: string) { switch (r) { case "ADMIN": return "Admin"; case "SELLER": return "Seller"; case "AFFILIATOR": return "Affiliator"; default: return "Customer"; } }

/**
 * Role → tone. The role pills were hand-tinted per role before (`purple` / `blue` / `amber` / grey);
 * those tints are re-expressed in the shared semantic vocabulary so a role reads the same here as
 * every other status in the dashboard. ADMIN stays `brand` on purpose — it is the privileged
 * identity of this very surface, not a status.
 */
function roleTone(r: string): Tone { switch (r) { case "ADMIN": return "brand"; case "SELLER": return "info"; case "AFFILIATOR": return "warn"; default: return "neutral"; } }

export default function AdminUsersPage() {
    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [search, setSearch] = useState("");
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const limit = 20;

    async function load() {
        try {
            setLoading(true);
            const params = new URLSearchParams({ page: String(page), limit: String(limit) });
            if (search.trim()) params.set("search", search.trim());
            const r = await fetch(`/api/admin/users?${params}`, { cache: "no-store" });
            const res = await readJson(r);
            if (!r.ok || !res.success) throw new Error(res.message || "Gagal mengambil data.");
            setUsers(res.data?.items ?? []);
            setTotal(res.data?.pagination?.total ?? 0);
        } catch (e) { setError(e instanceof Error ? e.message : "Gagal memuat."); } finally { setLoading(false); }
    }

    useEffect(() => { load(); }, [page]);

    function handleSearch(e: React.FormEvent) { e.preventDefault(); setPage(1); load(); }

    const totalPages = Math.ceil(total / limit);

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="Pengguna"
                description="Daftar pengguna terdaftar."
            />

            <SectionCard
                title="Daftar Pengguna"
                description={`${total} pengguna`}
                actions={
                    <form onSubmit={handleSearch}>
                        <Group gap="sm" wrap="nowrap">
                            <TextInput
                                value={search}
                                onChange={(e) => setSearch(e.currentTarget.value)}
                                placeholder="Cari nama/email/telepon…"
                                aria-label="Cari pengguna"
                                size="md"
                                w={{ base: 180, sm: 280 }}
                                leftSection={<FiSearch size={16} />}
                            />

                            <Button type="submit" size="md" color="ink" radius="md">
                                Cari
                            </Button>
                        </Group>
                    </form>
                }
            >
                <DataTable
                    minWidth={760}
                    loading={loading}
                    error={error ? <ErrorBlock message={error} /> : undefined}
                    empty={
                        <EmptyBlock
                            icon={<FiUsers size={22} />}
                            title="Tidak ada pengguna ditemukan"
                            description={
                                search
                                    ? "Coba kata kunci lain atau kosongkan pencarian."
                                    : "Belum ada pengguna terdaftar."
                            }
                        />
                    }
                    columns={[
                        { header: "Nama" },
                        { header: "Email" },
                        { header: "Telepon" },
                        { header: "Role" },
                        { header: "Bergabung" },
                        { header: "Orders", align: "right" },
                    ]}
                    rows={users.map((u) => ({
                        key: u.id,
                        cells: [
                            <Stack gap={0} key="name">
                                <Text size="sm" fw={600}>{u.name || "Tanpa nama"}</Text>
                                <Text size="xs" c="dimmed" ff="monospace">{u.id.slice(0, 8)}…</Text>
                            </Stack>,
                            <Text size="sm" key="email">{u.email || "-"}</Text>,
                            <Text size="sm" key="phone">{u.phone || "-"}</Text>,
                            <StatusBadge key="role" tone={roleTone(u.role)}>{roleLabel(u.role)}</StatusBadge>,
                            <Text size="sm" c="dimmed" key="joined">{formatDate(u.createdAt)}</Text>,
                            <Text size="sm" fw={600} key="orders">{u._count?.orders ?? 0}</Text>,
                        ],
                    }))}
                    footer={
                        totalPages > 1 ? (
                            <Group justify="space-between" align="center">
                                <Button
                                    variant="default"
                                    size="md"
                                    radius="md"
                                    disabled={page <= 1}
                                    onClick={() => setPage((p) => p - 1)}
                                >
                                    Sebelumnya
                                </Button>

                                <Text size="sm" c="dimmed">
                                    Halaman {page} / {totalPages}
                                </Text>

                                <Button
                                    variant="default"
                                    size="md"
                                    radius="md"
                                    disabled={page * limit >= total}
                                    onClick={() => setPage((p) => p + 1)}
                                >
                                    Selanjutnya
                                </Button>
                            </Group>
                        ) : undefined
                    }
                />
            </SectionCard>
        </Stack>
    );
}
