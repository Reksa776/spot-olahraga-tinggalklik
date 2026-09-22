"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { apiFetch, ClientApiError } from "./api";
import { Button } from "@/components/dashboard/ui/button";
import { Input, Label } from "@/components/dashboard/ui/input";
import {
    ErrorBlock,
    InfoNote,
    PrimaryAction,
} from "@/components/dashboard/primitives";

/**
 * ==========================================
 * EVENT DOCUMENTATION MANAGER (FEATURE)
 * ==========================================
 *
 * Add, update or remove the Google Drive documentation link of one event.
 *
 * The component holds the link's current value and sends it back through the SAME
 * `PATCH /api/organizer/events/:id` the rest of the event editor uses, so every policy
 * stays server-side: the strict schema refuses non-Drive/non-https URLs, the actor must
 * hold `event.write` on the event's own organizer (404 for any other tenant), the empty
 * PATCH guard refuses a no-op, and `null` clears the link. `router.refresh()` re-renders
 * the server row so the "current link" block and the public page cannot disagree about
 * what the organizer last saved.
 *
 * Nothing here is security-relevant: the `trim` and `maxLength` are affordances, and the
 * server re-validates structurally from its own allow-list before anything is stored.
 */

type Props = {
    eventId: string;
    /** The currently stored link, or null when none was added yet. */
    documentationUrl: string | null;
};

export default function EventDocumentationManager({
    eventId,
    documentationUrl,
}: Props) {
    const router = useRouter();

    const [value, setValue] = useState(documentationUrl ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    async function save(next: string | null) {
        setBusy(true);
        setError(null);
        setNotice(null);

        try {
            await apiFetch(`/api/organizer/events/${eventId}`, {
                method: "PATCH",
                body: JSON.stringify({ documentationUrl: next }),
            });

            setNotice(
                next === null
                    ? "Link dokumentasi dihapus."
                    : "Link dokumentasi disimpan."
            );
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError
                    ? caught.message
                    : "Gagal menyimpan link dokumentasi."
            );
        } finally {
            setBusy(false);
        }
    }

    async function onSave(event: React.FormEvent<HTMLFormElement>) {
        event.preventDefault();

        const trimmed = value.trim();

        await save(trimmed === "" ? null : trimmed);
    }

    return (
        <div className="flex flex-col gap-4">
            {documentationUrl ? (
                <p className="text-sm">
                    Link aktif:{" "}
                    <a
                        href={documentationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-primary underline underline-offset-4"
                    >
                        Buka dokumentasi
                    </a>
                    <span className="text-muted-foreground">
                        {" "}
                        · Link ini tampil di halaman publik hanya setelah event selesai
                        (COMPLETED).
                    </span>
                </p>
            ) : (
                <p className="text-sm text-muted-foreground">
                    Belum ada link dokumentasi untuk event ini. Link akan tampil di
                    halaman publik setelah event selesai (COMPLETED).
                </p>
            )}

            <form onSubmit={onSave} className="flex flex-col gap-3">
                <Label htmlFor="event-documentation-url">
                    Link Google Drive (dokumentasi event)
                </Label>

                <Input
                    id="event-documentation-url"
                    value={value}
                    onChange={(event) => setValue(event.currentTarget.value)}
                    placeholder="https://drive.google.com/file/d/…"
                    maxLength={2000}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={busy}
                />

                <div>
                    <PrimaryAction loading={busy}>
                        {busy ? "Menyimpan…" : "Simpan link"}
                    </PrimaryAction>
                </div>

                {documentationUrl ? (
                    <div>
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => save(null)}
                            className="bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive"
                        >
                            Hapus link
                        </Button>
                    </div>
                ) : null}
            </form>

            {error ? (
                <ErrorBlock title="Gagal disimpan" message={error} />
            ) : null}

            {notice ? <InfoNote tone="success">{notice}</InfoNote> : null}
        </div>
    );
}