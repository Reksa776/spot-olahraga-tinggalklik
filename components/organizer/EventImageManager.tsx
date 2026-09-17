"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Group, Image, Paper, SimpleGrid, Stack, Text } from "@mantine/core";

import { apiFetch, ClientApiError } from "./api";
import { ErrorBlock, InfoNote, PrimaryAction } from "@/components/dashboard/primitives";

/**
 * ==========================================
 * EVENT IMAGE MANAGER (decision D-55)
 * ==========================================
 *
 * Uploads through the organizer image endpoint, which validates the real file type by
 * magic bytes and **strips EXIF metadata server-side** before anything is written to
 * storage.
 *
 * The client does nothing security-relevant: the `accept` attribute is a convenience
 * only, the browser's `file.type` is ignored by the server, and the stored filename is
 * generated server-side. Stripping happens on the server because D-55 requires it —
 * "never trust client-side stripping alone".
 *
 * PHASE (Mantine body migration): presentation only. The `FormData` construction, the
 * `inputRef.current.value = ""` reset, the `busy` gate, the notice/error copy, the
 * `maxImages` limit branch and both API calls are unchanged. The file input keeps its
 * `accept` list and gains an accessible label via Mantine's input wrapper, so the control is
 * still reachable and describable by keyboard and screen reader.
 */

type Image = {
    id: string;
    url: string;
    altText: string | null;
    sortOrder: number;
};

type Props = {
    eventId: string;
    images: Image[];
    maxImages: number;
};

export default function EventImageManager({ eventId, images, maxImages }: Props) {
    const router = useRouter();
    const inputRef = useRef<HTMLInputElement>(null);

    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    async function onUpload(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const file = inputRef.current?.files?.[0];

        if (!file) {
            setError("Pilih file gambar terlebih dahulu.");
            return;
        }

        setBusy(true);
        setError(null);
        setNotice(null);

        const formData = new FormData();
        formData.append("file", file);

        try {
            await apiFetch(`/api/organizer/events/${eventId}/images`, {
                method: "POST",
                body: formData,
            });

            if (inputRef.current) {
                inputRef.current.value = "";
            }

            setNotice("Gambar diunggah, dan metadata EXIF sudah dihapus.");
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError
                    ? caught.message
                    : "Gagal mengunggah gambar."
            );
        } finally {
            setBusy(false);
        }
    }

    async function onDelete(imageId: string) {
        setBusy(true);
        setError(null);
        setNotice(null);

        try {
            await apiFetch(`/api/organizer/events/${eventId}/images/${imageId}`, {
                method: "DELETE",
            });
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Gagal menghapus."
            );
        } finally {
            setBusy(false);
        }
    }

    return (
        <Stack gap="md">
            <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
                {images.map((image) => (
                    <Paper key={image.id} withBorder radius="md" style={{ overflow: "hidden" }}>
                        <Image
                            src={image.url}
                            alt={image.altText ?? "Gambar event"}
                            h={112}
                            fit="cover"
                            w="100%"
                        />

                        <Button
                            variant="subtle"
                            color="red"
                            size="sm"
                            radius={0}
                            fullWidth
                            disabled={busy}
                            onClick={() => onDelete(image.id)}
                        >
                            Hapus
                        </Button>
                    </Paper>
                ))}
            </SimpleGrid>

            {images.length < maxImages ? (
                <form onSubmit={onUpload}>
                    <Stack gap="xs">
                        <Text component="label" size="sm" fw={500} htmlFor="event-image-upload">
                            Unggah gambar
                        </Text>

                        <input
                            id="event-image-upload"
                            ref={inputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            style={{ display: "block", width: "100%", fontSize: 14 }}
                        />

                        <Text size="xs" c="dimmed">
                            JPG, PNG, atau WEBP, maksimal 5MB. Metadata EXIF (termasuk
                            lokasi GPS) dihapus otomatis di server.
                        </Text>

                        <Group>
                            <PrimaryAction loading={busy}>
                                {busy ? "Mengunggah…" : "Unggah gambar"}
                            </PrimaryAction>
                        </Group>
                    </Stack>
                </form>
            ) : (
                <Text size="xs" c="dimmed">
                    Batas {maxImages} gambar per event sudah tercapai.
                </Text>
            )}

            {error ? <ErrorBlock message={error} title="Upload gagal" /> : null}

            {notice ? <InfoNote tone="success">{notice}</InfoNote> : null}
        </Stack>
    );
}
