"use client";

import Image from "next/image";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch, ClientApiError } from "./api";
import { Button } from "@/components/dashboard/ui/button";
import { Card } from "@/components/dashboard/ui/card";
import { Input, Label } from "@/components/dashboard/ui/input";
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
 * PHASE (shadcn migration): presentation only. The `FormData` construction, the
 * `inputRef.current.value = ""` reset, the `busy` gate, the notice/error copy, the
 * `maxImages` limit branch and both API calls are unchanged. The file input keeps its
 * `accept` list and its label association (`htmlFor`/`id` pair), so the control is still
 * reachable and describable by keyboard and screen reader.
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
        <div className="flex flex-col gap-4">
            {images.length > 0 ? (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                    {images.map((image) => (
                        <Card key={image.id} className="overflow-hidden">
                            <Image
                                src={image.url}
                                alt={image.altText ?? "Gambar event"}
                                width={480}
                                height={224}
                                unoptimized
                                className="h-28 w-full object-cover"
                            />

                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={busy}
                                onClick={() => onDelete(image.id)}
                                className="h-9 w-full rounded-none text-destructive hover:bg-destructive/10 hover:text-destructive"
                            >
                                Hapus
                            </Button>
                        </Card>
                    ))}
                </div>
            ) : (
                <p className="text-sm text-muted-foreground">
                    Belum ada gambar untuk event ini.
                </p>
            )}

            {images.length < maxImages ? (
                <form onSubmit={onUpload} className="flex flex-col gap-3">
                    <Label htmlFor="event-image-upload">Unggah gambar</Label>

                    <Input
                        id="event-image-upload"
                        ref={inputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="h-auto py-2 file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-foreground"
                    />

                    <p className="text-xs leading-relaxed text-muted-foreground">
                        JPG, PNG, atau WEBP, maksimal 5MB. Metadata EXIF (termasuk
                        lokasi GPS) dihapus otomatis di server.
                    </p>

                    <div>
                        <PrimaryAction loading={busy}>
                            {busy ? "Mengunggah…" : "Unggah gambar"}
                        </PrimaryAction>
                    </div>
                </form>
            ) : (
                <p className="text-xs text-muted-foreground">
                    Batas {maxImages} gambar per event sudah tercapai.
                </p>
            )}

            {error ? <ErrorBlock message={error} title="Upload gagal" /> : null}

            {notice ? <InfoNote tone="success">{notice}</InfoNote> : null}
        </div>
    );
}
