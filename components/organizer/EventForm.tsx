"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
    Alert,
    Button,
    List,
    Select,
    SimpleGrid,
    Stack,
    Switch,
    Textarea,
    TextInput,
} from "@mantine/core";

import { apiFetch, ClientApiError } from "./api";

/**
 * ==========================================
 * EVENT FORM (create + edit)
 * ==========================================
 *
 * One component for both modes, because the two payloads differ only by which fields
 * are sent — and the server applies the same validation either way.
 *
 * What this form deliberately does NOT send: `organizerId` (except as the ownership
 * target on create, which the API authorizes rather than trusts), `status`,
 * `publishedAt`, or any price field. Publication goes through the dedicated publish
 * endpoint so the preconditions cannot be bypassed by a crafted PATCH.
 *
 * Datetime inputs are `datetime-local`, which yields a local wall-clock string. It is
 * converted to a full ISO timestamp before sending, so the server receives an
 * unambiguous instant.
 *
 * ---------------------------------------------------------------------------
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: `EMPTY`, `toLocalInput` / `toIso` (and their `NaN` guards), the initial-state
 * spread, `update`, and `onSubmit` in full — the same field list, the same `|| null` optionals, the
 * same `toIso(values.startAt)` vs `toIso(values.endAt) ?? null` asymmetry, the create-mode
 * `POST /api/organizer/events` with `{ ...payload, organizerId }` and its
 * `router.push(\`/organizer/events/${created.id}\`)` early return, the edit-mode
 * `PATCH /api/organizer/events/${eventId}` with `setNotice("Perubahan tersimpan.")` and
 * `router.refresh()`, the `ClientApiError` branch including the `caught.details?.fields` mapping to
 * `"path: message"` strings, and the generic "Terjadi kesalahan." fallback.
 *
 * The `required` / `minLength={3}` / `maxLength={200}` constraints on the title, the required sport
 * select and the optional venue select all carry over as Mantine props, so browser-level validation
 * behaves identically.
 */

type SportOption = { id: string; name: string };
type VenueOption = { id: string; name: string; isGlobal: boolean };

export type EventFormValues = {
    title: string;
    sportId: string;
    venueId: string;
    description: string;
    rules: string;
    startAt: string;
    endAt: string;
    contactName: string;
    contactPhone: string;
    visibility: "PUBLIC" | "UNLISTED";
    requiresCheckIn: boolean;
};

type Props = {
    mode: "create" | "edit";
    organizerId: string;
    sports: SportOption[];
    venues: VenueOption[];
    /** Present in edit mode. */
    eventId?: string;
    initial?: Partial<EventFormValues>;
};

const EMPTY: EventFormValues = {
    title: "",
    sportId: "",
    venueId: "",
    description: "",
    rules: "",
    startAt: "",
    endAt: "",
    contactName: "",
    contactPhone: "",
    visibility: "PUBLIC",
    requiresCheckIn: true,
};

/** `datetime-local` value ↔ ISO. */
function toLocalInput(iso: string | undefined): string {
    if (!iso) return "";

    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) return "";

    const offsetMs = date.getTimezoneOffset() * 60_000;

    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function toIso(local: string): string | undefined {
    if (!local) return undefined;

    const date = new Date(local);

    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export default function EventForm({
    mode,
    organizerId,
    sports,
    venues,
    eventId,
    initial,
}: Props) {
    const router = useRouter();

    const [values, setValues] = useState<EventFormValues>({
        ...EMPTY,
        ...initial,
        startAt: toLocalInput(initial?.startAt),
        endAt: toLocalInput(initial?.endAt),
    });

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<string[]>([]);
    const [notice, setNotice] = useState<string | null>(null);

    function update<K extends keyof EventFormValues>(
        key: K,
        value: EventFormValues[K]
    ) {
        setValues((current) => ({ ...current, [key]: value }));
    }

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault();

        setSaving(true);
        setError(null);
        setFieldErrors([]);
        setNotice(null);

        const payload: Record<string, unknown> = {
            title: values.title,
            sportId: values.sportId,
            venueId: values.venueId || null,
            description: values.description || null,
            rules: values.rules || null,
            startAt: toIso(values.startAt),
            endAt: toIso(values.endAt) ?? null,
            contactName: values.contactName || null,
            contactPhone: values.contactPhone || null,
            visibility: values.visibility,
            requiresCheckIn: values.requiresCheckIn,
        };

        try {
            if (mode === "create") {
                // The ownership target travels alongside the fields; the API pulls it
                // out before validation and authorizes it separately.
                const created = await apiFetch<{ id: string }>(
                    "/api/organizer/events",
                    {
                        method: "POST",
                        body: JSON.stringify({ ...payload, organizerId }),
                    }
                );

                router.push(`/organizer/events/${created.id}`);
                return;
            }

            await apiFetch(`/api/organizer/events/${eventId}`, {
                method: "PATCH",
                body: JSON.stringify(payload),
            });

            setNotice("Perubahan tersimpan.");
            router.refresh();
        } catch (caught) {
            if (caught instanceof ClientApiError) {
                setError(caught.message);

                const fields = caught.details?.fields;

                if (Array.isArray(fields)) {
                    setFieldErrors(
                        fields.map((field) => {
                            const entry = field as {
                                path?: string;
                                message?: string;
                            };
                            return `${entry.path ?? "?"}: ${entry.message ?? ""}`;
                        })
                    );
                }
            } else {
                setError("Terjadi kesalahan.");
            }
        } finally {
            setSaving(false);
        }
    }

    return (
        <form onSubmit={onSubmit}>
            <Stack gap="lg">
                {error ? (
                    <Alert color="red" variant="light" radius="md" title={error}>
                        {fieldErrors.length > 0 ? (
                            <List size="sm" withPadding>
                                {fieldErrors.map((fieldError) => (
                                    <List.Item key={fieldError}>
                                        {fieldError}
                                    </List.Item>
                                ))}
                            </List>
                        ) : null}
                    </Alert>
                ) : null}

                {notice ? (
                    <Alert color="green" variant="light" radius="md">
                        {notice}
                    </Alert>
                ) : null}

                <TextInput
                    label="Judul event"
                    size="md"
                    radius="md"
                    required
                    minLength={3}
                    maxLength={200}
                    value={values.title}
                    onChange={(event) => update("title", event.currentTarget.value)}
                />

                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <Select
                        label="Cabang olahraga"
                        size="md"
                        radius="md"
                        required
                        allowDeselect={false}
                        placeholder="Pilih cabang olahraga"
                        value={values.sportId === "" ? null : values.sportId}
                        onChange={(value) => update("sportId", value ?? "")}
                        data={sports.map((sport) => ({
                            value: sport.id,
                            label: sport.name,
                        }))}
                    />

                    <Select
                        label="Venue (opsional)"
                        size="md"
                        radius="md"
                        allowDeselect={false}
                        placeholder="Tanpa venue"
                        value={values.venueId === "" ? null : values.venueId}
                        onChange={(value) => update("venueId", value ?? "")}
                        data={venues.map((venue) => ({
                            value: venue.id,
                            label: venue.isGlobal ? `${venue.name} (global)` : venue.name,
                        }))}
                    />
                </SimpleGrid>

                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <TextInput
                        label="Mulai"
                        size="md"
                        radius="md"
                        required
                        type="datetime-local"
                        value={values.startAt}
                        onChange={(event) => update("startAt", event.currentTarget.value)}
                    />

                    <TextInput
                        label="Selesai (opsional)"
                        size="md"
                        radius="md"
                        type="datetime-local"
                        value={values.endAt}
                        onChange={(event) => update("endAt", event.currentTarget.value)}
                    />
                </SimpleGrid>

                <Textarea
                    label="Deskripsi"
                    size="md"
                    radius="md"
                    minRows={5}
                    maxRows={12}
                    autosize
                    value={values.description}
                    onChange={(event) => update("description", event.currentTarget.value)}
                />

                <Textarea
                    label="Peraturan & kebijakan"
                    size="md"
                    radius="md"
                    minRows={3}
                    maxRows={10}
                    autosize
                    value={values.rules}
                    onChange={(event) => update("rules", event.currentTarget.value)}
                />

                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <TextInput
                        label="Nama kontak"
                        size="md"
                        radius="md"
                        value={values.contactName}
                        onChange={(event) => update("contactName", event.currentTarget.value)}
                    />

                    <TextInput
                        label="Nomor kontak"
                        size="md"
                        radius="md"
                        value={values.contactPhone}
                        onChange={(event) => update("contactPhone", event.currentTarget.value)}
                    />
                </SimpleGrid>

                <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
                    <Select
                        label="Visibilitas"
                        size="md"
                        radius="md"
                        allowDeselect={false}
                        value={values.visibility}
                        onChange={(value) =>
                            update(
                                "visibility",
                                (value ?? "PUBLIC") as EventFormValues["visibility"]
                            )
                        }
                        data={[
                            { value: "PUBLIC", label: "Publik (tampil di katalog)" },
                            {
                                value: "UNLISTED",
                                label: "Unlisted (hanya lewat tautan langsung)",
                            },
                        ]}
                    />

                    <Switch
                        label="Wajib check-in di lokasi"
                        size="md"
                        color="green"
                        checked={values.requiresCheckIn}
                        onChange={(event) =>
                            update("requiresCheckIn", event.currentTarget.checked)
                        }
                        style={{ alignSelf: "end" }}
                    />
                </SimpleGrid>

                <Button
                    type="submit"
                    size="md"
                    radius="md"
                    disabled={saving}
                    loading={saving}
                    w={{ base: "100%", sm: "auto" }}
                    style={{ alignSelf: "flex-start" }}
                >
                    {saving ? "Menyimpan…" : mode === "create" ? "Simpan draft" : "Simpan perubahan"}
                </Button>
            </Stack>
        </form>
    );
}
