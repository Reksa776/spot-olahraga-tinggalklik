"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays } from "lucide-react";

import { apiFetch, ClientApiError } from "./api";
import { Alert, AlertDescription, AlertTitle } from "@/components/dashboard/ui/alert";
import { Button } from "@/components/dashboard/ui/button";
import { Field, Input, Textarea } from "@/components/dashboard/ui/input";
import {
    defaultEventSchedule,
    eventTimingErrors,
    formatWibDateTime,
    toWibInputValue,
    wibDateTimeMin,
    wibInputToIso,
} from "@/lib/events/datetime";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    Switch,
} from "@/components/dashboard/ui/select";

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
 * Datetime inputs are `datetime-local` and are read as WIB (Asia/Jakarta) regardless of
 * the browser's own timezone. The WIB wall clock is converted to a full ISO instant
 * before sending, so the server stores an unambiguous UTC value, and the input is filled
 * from the stored UTC instant in WIB again. A readable WIB preview sits under each field.
 *
 * ---------------------------------------------------------------------------
 * PHASE (shadcn migration): presentation only.
 *
 * Preserved exactly: `EMPTY`, the initial-state spread, `update`, and `onSubmit` in full — the same
 * field list, the same `|| null` optionals, the same required `startAt` vs optional `endAt`, the
 * same WIB ↔ ISO conversion (now `wibInputToIso` / `toWibInputValue`), the create-mode
 * `POST /api/organizer/events` with `{ ...payload, organizerId }` and its
 * `router.push(\`/dashboard/events/${created.id}\`)` early return, the edit-mode
 * `PATCH /api/organizer/events/${eventId}` with `setNotice("Perubahan tersimpan.")` and
 * `router.refresh()`, the `ClientApiError` branch including the `caught.details?.fields` mapping to
 * `"path: message"` strings, and the generic "Terjadi kesalahan." fallback.
 *
 * Native constraint validation is preserved where the browser can enforce it: the title keeps
 * `required`/`minLength={3}`/`maxLength={200}`, the datetime and contact inputs keep their types, and
 * the two required selects pass `required` to the Radix Select root, which is what makes Radix render
 * its hidden native `<select>` and participate in the form's own validation — the same browser-level
 * behaviour Mantine's Select provided.
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
    /** Event-level sales window; a ticket type may override it (design §10.2). */
    salesStartAt: string;
    salesEndAt: string;
    /** Empty string = no event-level ceiling. */
    maxTicketsPerOrder: string;
    bannerUrl: string;
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
    salesStartAt: "",
    salesEndAt: "",
    maxTicketsPerOrder: "",
    bannerUrl: "",
    contactName: "",
    contactPhone: "",
    visibility: "PUBLIC",
    requiresCheckIn: true,
};

function DateTimeField({
    id,
    label,
    required,
    hint,
    error,
    value,
    min,
    max,
    onChange,
}: {
    id: string;
    label: string;
    required?: boolean;
    hint?: React.ReactNode;
    error?: string;
    value: string;
    min?: string;
    max?: string;
    onChange: (value: string) => void;
}) {
    return (
        <Field
            label={`${label} (WIB)`}
            required={required}
            htmlFor={id}
            hint={hint}
            error={error}
        >
            <div className="flex items-stretch gap-2">
                <Input
                    id={id}
                    type="datetime-local"
                    step={60}
                    required={required}
                    min={min}
                    max={max}
                    value={value}
                    aria-invalid={error ? true : undefined}
                    className="[color-scheme:light] [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:opacity-70 dark:[color-scheme:dark]"
                    onChange={(event) => onChange(event.currentTarget.value)}
                />

                {/* A visible affordance for the native picker: the indicator alone is
                 * easy to miss at this height, and `showPicker` is the documented way
                 * to open the calendar from a button. */}
                <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="shrink-0"
                    aria-label={`Buka kalender ${label.toLowerCase()}`}
                    onClick={() => {
                        const input = document.getElementById(
                            id
                        ) as HTMLInputElement | null;

                        try {
                            input?.showPicker();
                        } catch {
                            input?.focus();
                        }
                    }}
                >
                    <CalendarDays aria-hidden />
                </Button>
            </div>

            {value ? (
                <p className="text-xs font-medium text-muted-foreground">
                    {formatWibDateTime(value)}
                </p>
            ) : (
                <p className="text-xs text-muted-foreground">
                    Klik ikon kalender atau ketik langsung, contoh 19:30.
                </p>
            )}
        </Field>
    );
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
        startAt: toWibInputValue(initial?.startAt),
        endAt: toWibInputValue(initial?.endAt),
        salesStartAt: toWibInputValue(initial?.salesStartAt),
        salesEndAt: toWibInputValue(initial?.salesEndAt),
        maxTicketsPerOrder:
            initial?.maxTicketsPerOrder === undefined ||
            initial?.maxTicketsPerOrder === null
                ? ""
                : String(initial.maxTicketsPerOrder),
    });

    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [fieldErrors, setFieldErrors] = useState<string[]>([]);
    const [notice, setNotice] = useState<string | null>(null);

    /**
     * Create mode starts from a usable slot (a week ahead, 19:00–22:00 WIB) instead of
     * four empty inputs. Seeded after mount so the server and the browser cannot disagree
     * about "today" during hydration.
     */
    useEffect(() => {
        if (mode !== "create" || initial?.startAt) return;

        setValues((current) => {
            if (current.startAt || current.endAt) return current;

            const schedule = defaultEventSchedule();

            return {
                ...current,
                startAt: schedule.startAt,
                endAt: schedule.endAt,
            };
        });
    }, [mode, initial?.startAt]);

    const originalStartAt = initial?.startAt
        ? toWibInputValue(initial.startAt)
        : undefined;

    // Live, field-level schedule errors. The submit path re-checks the same function.
    const timingErrors = eventTimingErrors(
        {
            startAt: values.startAt,
            endAt: values.endAt,
            salesStartAt: values.salesStartAt,
            salesEndAt: values.salesEndAt,
        },
        { mode, originalStartAt }
    );

    function update<K extends keyof EventFormValues>(
        key: K,
        value: EventFormValues[K]
    ) {
        setValues((current) => ({ ...current, [key]: value }));
    }

    async function onSubmit(event: React.FormEvent) {
        event.preventDefault();

        setError(null);
        setFieldErrors([]);
        setNotice(null);

        // The same rules the fields already show under each input. The server re-validates
        // (and against the stored values), so this is convenience, never the control.
        if (Object.keys(timingErrors).length > 0) {
            setError("Periksa kembali tanggal dan jam event.");
            return;
        }

        const maxTickets = values.maxTicketsPerOrder.trim();

        setSaving(true);

        const payload: Record<string, unknown> = {
            title: values.title,
            sportId: values.sportId,
            venueId: values.venueId || null,
            description: values.description || null,
            rules: values.rules || null,
            bannerUrl: values.bannerUrl.trim() || null,
            startAt: wibInputToIso(values.startAt),
            endAt: wibInputToIso(values.endAt) ?? null,
            // `null` clears the column, `undefined` would leave it untouched; the form
            // always sends an explicit value so clearing works (see event validation).
            salesStartAt: wibInputToIso(values.salesStartAt) ?? null,
            salesEndAt: wibInputToIso(values.salesEndAt) ?? null,
            maxTicketsPerOrder: maxTickets === "" ? null : Number(maxTickets),
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

                router.push(`/dashboard/events/${created.id}`);
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
        <form onSubmit={onSubmit} className="flex flex-col gap-6">
            {error ? (
                <Alert variant="danger">
                    <div className="flex min-w-0 flex-1 flex-col gap-2">
                        <AlertTitle>{error}</AlertTitle>

                        {fieldErrors.length > 0 ? (
                            <AlertDescription>
                                <ul className="list-disc space-y-1 pl-5 text-xs">
                                    {fieldErrors.map((fieldError) => (
                                        <li key={fieldError}>{fieldError}</li>
                                    ))}
                                </ul>
                            </AlertDescription>
                        ) : null}
                    </div>
                </Alert>
            ) : null}

            {notice ? (
                <Alert variant="success">
                    <AlertDescription className="text-foreground">
                        {notice}
                    </AlertDescription>
                </Alert>
            ) : null}

            <Field label="Judul event" required htmlFor="event-title">
                <Input
                    id="event-title"
                    required
                    minLength={3}
                    maxLength={200}
                    value={values.title}
                    onChange={(event) => update("title", event.currentTarget.value)}
                />
            </Field>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <span className="text-[0.8125rem] font-medium leading-none">
                        Cabang olahraga <span className="text-destructive">*</span>
                    </span>

                    <Select
                        required
                        value={values.sportId === "" ? undefined : values.sportId}
                        onValueChange={(value) => update("sportId", value)}
                    >
                        <SelectTrigger aria-label="Cabang olahraga">
                            <SelectValue placeholder="Pilih cabang olahraga" />
                        </SelectTrigger>

                        <SelectContent>
                            {sports.map((sport) => (
                                <SelectItem key={sport.id} value={sport.id}>
                                    {sport.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex flex-col gap-2">
                    <span className="text-[0.8125rem] font-medium leading-none">
                        Venue (opsional)
                    </span>

                    <Select
                        value={values.venueId === "" ? undefined : values.venueId}
                        onValueChange={(value) => update("venueId", value)}
                    >
                        <SelectTrigger aria-label="Venue (opsional)">
                            <SelectValue placeholder="Tanpa venue" />
                        </SelectTrigger>

                        <SelectContent>
                            {venues.map((venue) => (
                                <SelectItem key={venue.id} value={venue.id}>
                                    {venue.isGlobal ? `${venue.name} (global)` : venue.name}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <DateTimeField
                    id="event-start"
                    label="Mulai"
                    required
                    value={values.startAt}
                    min={mode === "create" ? wibDateTimeMin() : undefined}
                    error={timingErrors.startAt}
                    hint="Tidak boleh di masa lalu. Pilih tanggal dan jam, atau ketik langsung."
                    onChange={(value) => update("startAt", value)}
                />

                {/*
                 * PHASE 20B (D-P19-05 = A): `endAt` is what makes the event completable, and
                 * publication is refused without it (`publishEvent`'s preconditions, the
                 * readiness checklist, and the disabled publish button all enforce the same
                 * rule). The field itself stays optional for a draft — a schedule is often not
                 * settled when the draft is first saved — so the label must not claim the field
                 * is required while the copy still says when it becomes required.
                 */}
                <DateTimeField
                    id="event-end"
                    label="Selesai"
                    value={values.endAt}
                    min={values.startAt || undefined}
                    error={timingErrors.endAt}
                    hint="Opsional saat masih draft, tetapi wajib diisi sebelum publikasi: event tanpa waktu selesai tidak dapat diselesaikan."
                    onChange={(value) => update("endAt", value)}
                />
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <DateTimeField
                    id="event-sales-start"
                    label="Mulai penjualan"
                    value={values.salesStartAt}
                    min={mode === "create" ? wibDateTimeMin() : undefined}
                    max={values.startAt || undefined}
                    error={timingErrors.salesStartAt}
                    hint="Opsional. Kosong = langsung dibuka setelah event dipublikasikan."
                    onChange={(value) => update("salesStartAt", value)}
                />

                <DateTimeField
                    id="event-sales-end"
                    label="Akhir penjualan"
                    value={values.salesEndAt}
                    min={values.salesStartAt || undefined}
                    max={values.startAt || undefined}
                    error={timingErrors.salesEndAt}
                    hint="Opsional. Kosong = penjualan berhenti saat event dimulai."
                    onChange={(value) => update("salesEndAt", value)}
                />
            </div>

            <p className="text-xs text-muted-foreground">
                Semua waktu di atas dalam WIB (Asia/Jakarta, UTC+7), berapa pun zona waktu
                perangkatmu. Jendela ini berlaku sebagai bawaan untuk semua jenis tiket.
                Jenis tiket dapat menimpa jendela ini dengan jendela miliknya sendiri.
            </p>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field
                    label="Maks tiket per pesanan (opsional)"
                    htmlFor="event-max-per-order"
                    hint="Batas untuk seluruh pesanan, di atas batas per jenis tiket. Kosong = tanpa batas."
                >
                    <Input
                        id="event-max-per-order"
                        type="number"
                        min={1}
                        max={50}
                        inputMode="numeric"
                        disabled={saving}
                        value={values.maxTicketsPerOrder}
                        onChange={(event) =>
                            update(
                                "maxTicketsPerOrder",
                                event.currentTarget.value
                            )
                        }
                    />
                </Field>

                <Field
                    label="URL banner (opsional)"
                    htmlFor="event-banner-url"
                    hint="Dipakai untuk kartu katalog dan Open Graph. Jika kosong, gambar pertama yang diunggah dipakai."
                >
                    <Input
                        id="event-banner-url"
                        type="url"
                        inputMode="url"
                        maxLength={2000}
                        placeholder="https://…"
                        disabled={saving}
                        value={values.bannerUrl}
                        onChange={(event) =>
                            update("bannerUrl", event.currentTarget.value)
                        }
                    />
                </Field>
            </div>

            <Field label="Deskripsi" htmlFor="event-description">
                <Textarea
                    id="event-description"
                    rows={5}
                    value={values.description}
                    onChange={(event) => update("description", event.currentTarget.value)}
                />
            </Field>

            <Field label="Peraturan & kebijakan" htmlFor="event-rules">
                <Textarea
                    id="event-rules"
                    rows={3}
                    value={values.rules}
                    onChange={(event) => update("rules", event.currentTarget.value)}
                />
            </Field>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <Field label="Nama kontak" htmlFor="event-contact-name">
                    <Input
                        id="event-contact-name"
                        value={values.contactName}
                        onChange={(event) =>
                            update("contactName", event.currentTarget.value)
                        }
                    />
                </Field>

                <Field label="Nomor kontak" htmlFor="event-contact-phone">
                    <Input
                        id="event-contact-phone"
                        value={values.contactPhone}
                        onChange={(event) =>
                            update("contactPhone", event.currentTarget.value)
                        }
                    />
                </Field>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                    <span className="text-[0.8125rem] font-medium leading-none">
                        Visibilitas
                    </span>

                    <Select
                        value={values.visibility}
                        onValueChange={(value) =>
                            update("visibility", value as EventFormValues["visibility"])
                        }
                    >
                        <SelectTrigger aria-label="Visibilitas">
                            <SelectValue />
                        </SelectTrigger>

                        <SelectContent>
                            <SelectItem value="PUBLIC">
                                Publik (tampil di katalog)
                            </SelectItem>
                            <SelectItem value="UNLISTED">
                                Unlisted (hanya lewat tautan langsung)
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <label className="flex cursor-pointer items-center gap-3 self-end pb-2">
                    <Switch
                        checked={values.requiresCheckIn}
                        onCheckedChange={(checked) => update("requiresCheckIn", checked)}
                    />

                    <span className="text-[0.8125rem] font-medium leading-tight">
                        Wajib check-in di lokasi
                    </span>
                </label>
            </div>

            <div className="flex self-start">
                <Button
                    type="submit"
                    disabled={saving}
                    className="w-full sm:w-auto"
                >
                    {saving ? (
                        <span
                            aria-hidden
                            className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current"
                        />
                    ) : null}
                    {saving
                        ? "Menyimpan…"
                        : mode === "create"
                          ? "Simpan draft"
                          : "Simpan perubahan"}
                </Button>
            </div>
        </form>
    );
}
