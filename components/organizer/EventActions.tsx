"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Group, List, Modal, Stack, Text } from "@mantine/core";

import { apiFetch, ClientApiError, preconditionsFrom } from "./api";
import { ErrorBlock } from "@/components/dashboard/primitives";

/**
 * ==========================================
 * EVENT PUBLISH / UNPUBLISH / DELETE
 * ==========================================
 *
 * Publication is a dedicated endpoint, not a status field on the edit form, so the
 * design §10.3 preconditions cannot be bypassed — the API re-checks them on every call
 * regardless of what the UI shows.
 *
 * When the API refuses a publish it returns `details.preconditions`, which is rendered
 * verbatim. That matters today: one precondition is "at least one active ticket type",
 * and ticket-type management is Phase 5, so a Phase 4 operator will see exactly that
 * requirement named rather than an unexplained failure.
 *
 * Unpublish is labelled to match decision D-14: it hides the event from listings and
 * preserves the read-only page, and explicitly does not cancel orders or void tickets.
 *
 * PHASE (Mantine body migration): presentation only. Both mutations, the `busy` action key, the
 * `router.refresh()` / `router.push("/organizer/events")` behaviour, `preconditionsFrom(caught)` and
 * the verbatim message rendering are unchanged. The draft-delete confirmation moved from
 * `window.confirm` to a Mantine `Modal` (§13), still gating the same `DELETE` and the same
 * redirect afterwards.
 */

type Props = {
    eventId: string;
    status: string;
};

export default function EventActions({ eventId, status }: Props) {
    const router = useRouter();

    const [busy, setBusy] = useState<null | "publish" | "unpublish" | "delete">(null);
    const [error, setError] = useState<string | null>(null);
    const [unmet, setUnmet] = useState<string[]>([]);
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    async function run(
        action: "publish" | "unpublish" | "delete",
        call: () => Promise<unknown>
    ) {
        setBusy(action);
        setError(null);
        setUnmet([]);

        try {
            await call();
            router.refresh();
        } catch (caught) {
            if (caught instanceof ClientApiError) {
                setError(caught.message);
                setUnmet(preconditionsFrom(caught));
            } else {
                setError("Terjadi kesalahan.");
            }
        } finally {
            setBusy(null);
        }
    }

    async function deleteDraft() {
        setConfirmingDelete(false);

        await run("delete", () =>
            apiFetch(`/api/organizer/events/${eventId}`, { method: "DELETE" })
        ).then(() => router.push("/organizer/events"));
    }

    return (
        <Stack gap="sm">
            <Group gap="sm" wrap="wrap">
                {status === "DRAFT" ? (
                    <Button
                        color="green"
                        size="md"
                        radius="md"
                        loading={busy === "publish"}
                        disabled={busy !== null}
                        onClick={() =>
                            run("publish", () =>
                                apiFetch(`/api/organizer/events/${eventId}/publish`, {
                                    method: "POST",
                                })
                            )
                        }
                    >
                        {busy === "publish" ? "Memproses…" : "Publikasikan"}
                    </Button>
                ) : (
                    <Button
                        variant="default"
                        size="md"
                        radius="md"
                        loading={busy === "unpublish"}
                        disabled={busy !== null || status !== "PUBLISHED"}
                        onClick={() =>
                            run("unpublish", () =>
                                apiFetch(`/api/organizer/events/${eventId}/unpublish`, {
                                    method: "POST",
                                })
                            )
                        }
                        title="Menyembunyikan event dari katalog tanpa menghapus data, membatalkan pesanan, atau membatalkan tiket."
                    >
                        {busy === "unpublish" ? "Memproses…" : "Batalkan publikasi"}
                    </Button>
                )}

                {status === "DRAFT" ? (
                    <Button
                        variant="light"
                        color="red"
                        size="md"
                        radius="md"
                        loading={busy === "delete"}
                        disabled={busy !== null}
                        onClick={() => setConfirmingDelete(true)}
                    >
                        {busy === "delete" ? "Menghapus…" : "Hapus draft"}
                    </Button>
                ) : null}
            </Group>

            {error ? (
                <ErrorBlock
                    title={error}
                    message={
                        unmet.length > 0 ? (
                            <Stack gap={4}>
                                <Text size="xs" fw={600}>
                                    Syarat yang belum terpenuhi:
                                </Text>

                                <List size="xs" withPadding>
                                    {unmet.map((item) => (
                                        <List.Item key={item}>{item}</List.Item>
                                    ))}
                                </List>
                            </Stack>
                        ) : (
                            <Text size="sm">Periksa kembali data event sebelum mencoba lagi.</Text>
                        )
                    }
                />
            ) : null}

            <Modal
                opened={confirmingDelete}
                onClose={() => setConfirmingDelete(false)}
                title="Hapus event draft ini?"
                centered
            >
                <Text size="sm">Tindakan ini tidak dapat dibatalkan.</Text>

                <Group justify="flex-end" mt="lg">
                    <Button
                        variant="default"
                        size="md"
                        onClick={() => setConfirmingDelete(false)}
                    >
                        Batal
                    </Button>

                    <Button color="red" size="md" loading={busy === "delete"} onClick={deleteDraft}>
                        Hapus draft
                    </Button>
                </Group>
            </Modal>
        </Stack>
    );
}
