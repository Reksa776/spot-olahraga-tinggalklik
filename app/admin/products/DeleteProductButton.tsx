"use client";

import { useState } from "react";
import { FiTrash2 } from "react-icons/fi";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * The confirmation moved from the shared `components/ui/Dialog` promise helper to a Mantine
 * `Modal`, as the brief requires for dashboard-owned confirmations (§9). That helper is mounted in
 * the root layout and serves the retail/customer graph, so using it here would have kept the
 * dashboard coupled to the customer design system.
 *
 * Preserved exactly: the `DELETE /api/admin/products/{id}` call, its headers and `cache: "no-store"`,
 * the raw-text-then-parse response handling, the `response.ok` check, the `data.message` fallbacks,
 * the success toast, `router.refresh()` and the `loading` gate. The confirmation wording is
 * unchanged — including the archive-not-delete caveat, which describes real server behaviour.
 */
export default function DeleteProductButton({
    productId,
    productName,
}: {
    productId: number;
    productName: string;
}) {
    const router = useRouter();

    const [loading, setLoading] = useState(false);
    const [confirming, setConfirming] = useState(false);

    async function handleDelete() {
        setConfirming(false);

        try {
            setLoading(true);

            const url = `/api/admin/products/${productId}`;

            console.log("DELETE URL:", url);

            const response = await fetch(url, {
                method: "DELETE",
                headers: {
                    "Content-Type": "application/json",
                },
                cache: "no-store",
            });

            console.log("DELETE STATUS:", response.status);

            const text = await response.text();

            console.log("DELETE RESPONSE:", text);

            let data: any = {};

            try {
                data = text ? JSON.parse(text) : {};
            } catch {
                console.error("Response bukan JSON:", text);
            }

            if (!response.ok) {
                throw new Error(
                    data.message || `Gagal menghapus produk. HTTP ${response.status}`
                );
            }

            toast.success(data.message || "Produk berhasil dihapus.");

            router.refresh();
        } catch (error) {
            console.error("DELETE PRODUCT ERROR:", error);

            toast.error(
                error instanceof Error ? error.message : "Gagal menghapus produk."
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <>
            <Button
                variant="light"
                color="red"
                size="md"
                radius="md"
                leftSection={<FiTrash2 size={15} />}
                loading={loading}
                onClick={() => setConfirming(true)}
            >
                Hapus
            </Button>

            <Modal
                opened={confirming}
                onClose={() => setConfirming(false)}
                title="Hapus Produk"
                centered
            >
                <Stack gap="md">
                    <Text size="sm">
                        Hapus produk &quot;{productName}&quot;?
                    </Text>

                    <Text size="sm" c="dimmed">
                        Jika produk ini punya history pesanan, produk akan diarsipkan
                        (disembunyikan dari katalog) alih-alih dihapus permanen.
                    </Text>
                </Stack>

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        onClick={() => setConfirming(false)}
                    >
                        Batal
                    </Button>

                    <Button color="red" size="md" radius="md" onClick={handleDelete}>
                        Hapus
                    </Button>
                </Group>
            </Modal>
        </>
    );
}
