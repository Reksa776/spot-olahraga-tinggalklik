"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
    DataTable,
    EmptyBlock,
    SectionCard,
    StatusBadge,
} from "@/components/dashboard/primitives";
import { Alert, AlertDescription } from "@/components/dashboard/ui/alert";
import { Button } from "@/components/dashboard/ui/button";
import { Card } from "@/components/dashboard/ui/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/dashboard/ui/dialog";
import { Field, Input, Textarea } from "@/components/dashboard/ui/input";
import { Switch } from "@/components/dashboard/ui/select";

import { apiFetch, ClientApiError } from "./api";

/**
 * ==========================================
 * TICKET TYPE MANAGER (Phase 5)
 * ==========================================
 *
 * The sellable tiers of one event: list, create, edit, activate/deactivate, delete —
 * plus the inventory counters, which the brief allows on this surface specifically
 * ("Internal view — **may** show quota/reserved/sold (this is the authorized surface,
 * unlike the public payload)").
 *
 * BACKEND REMAINS AUTHORITATIVE (brief §27)
 * -----------------------------------------
 * The publish-readiness checklist below is a *preview* computed from the ticket types
 * this page already loaded. It exists so an organizer understands what is missing
 * before pressing Publish, and it is deliberately advisory: the publish endpoint
 * re-evaluates every precondition server-side and its answer is what decides. Nothing
 * here weakens that guard — a stale or crafted client state cannot publish anything.
 *
 * PRICE IS A STRING, ON PURPOSE
 * -----------------------------
 * `price` is never converted with `Number()` in this component. There is no JS
 * arithmetic on money anywhere in the Phase 5 UI — the value is bound straight to the
 * input and posted as the same string it arrived as, so `1234567.89` cannot come back
 * as `1234567.8899999999`. Only the read-only display uses `Number()` for formatting.
 *
 * QUOTA FLOOR
 * -----------
 * When editing, the quota input's `min` is the committed count (`sold + reserved`) that
 * the API returned, and the hint states it. The API enforces the same floor and rejects
 * a reduction below it with `minimumQuota` in `details`, so the client hint is a
 * convenience rather than the control.
 *
 * ---------------------------------------------------------------------------
 * PHASE (shadcn migration): presentation only.
 *
 * Preserved exactly: `toLocalInput` / `toIso`, `formatMoney` (same `Number()` read-only formatting
 * with `minimumFractionDigits: 0` / `maximumFractionDigits: 2`), `EMPTY_FORM` and all of its
 * defaults, the readiness derivation (`activeWithQuota`, `startInFuture`, both condition labels),
 * `reset` / `startEdit` (including `price: type.price` verbatim and the `?? ""` fallbacks),
 * `buildPayload` and its `Object.fromEntries(...filter(...))` undefined-stripping, `submit`
 * (endpoint for create vs edit, the `wasEditing` branch for the notice copy, `reset()` then
 * `router.refresh()`), `setActive` (bare `{ isActive }` PATCH body, `reset()` only when the edited row
 * is the toggled one) and `remove` (the DELETE endpoint, the same reset rule, and the API's verbatim
 * "cannot delete an ordered type" message).
 *
 * `price` stays a **string** in the form state and in the payload, and its field stays a text input
 * with `inputMode="decimal"` — never a number field — precisely so no numeric round trip is
 * introduced.
 *
 * The delete confirmation is the shadcn `Dialog` carrying the identical wording
 * (`Hapus jenis tiket "<name>"?`).
 */

type TicketType = {
    id: string;
    name: string;
    description: string | null;
    price: string;
    currency: string;
    minPerOrder: number;
    maxPerOrder: number | null;
    salesStartAt: string | null;
    salesEndAt: string | null;
    isActive: boolean;
    sortOrder: number;
    salesState: string;
    isSoldOut: boolean;
    inventory: {
        quota: number;
        sold: number;
        reserved: number;
        available: number;
        committed: number;
    };
};

type Props = {
    eventId: string;
    eventStartAt: string;
    /**
     * PHASE 20B (D-P19-05 = A): `publishEvent` refuses an event with no end time, so the
     * readiness preview has to know whether one exists — otherwise the list would report
     * "ready" for an event the server will refuse. `null` means no end time is set.
     */
    eventEndAt: string | null;
    /**
     * The server's "now", passed in so the readiness preview can compare against it
     * without reading the clock during render (which is impure and can make the render
     * non-idempotent). See the component note below.
     */
    serverNow: string;
    ticketTypes: TicketType[];
};

type FormState = {
    name: string;
    description: string;
    price: string;
    quota: string;
    minPerOrder: string;
    maxPerOrder: string;
    salesStartAt: string;
    salesEndAt: string;
    isActive: boolean;
    sortOrder: string;
};

const EMPTY_FORM: FormState = {
    name: "",
    description: "",
    price: "",
    quota: "",
    minPerOrder: "1",
    maxPerOrder: "",
    salesStartAt: "",
    salesEndAt: "",
    isActive: true,
    sortOrder: "0",
};

/** `datetime-local` value ↔ ISO, matching `EventForm`'s handling. */
function toLocalInput(iso: string | null): string {
    if (!iso) return "";

    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) return "";

    const offsetMs = date.getTimezoneOffset() * 60_000;

    return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function toIso(local: string): string | null {
    if (!local) return null;

    const date = new Date(local);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatMoney(price: string, currency: string): string {
    const amount = Number(price);

    if (!Number.isFinite(amount)) return `${price} ${currency}`;

    return `Rp${amount.toLocaleString("id-ID", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
    })}`;
}

export default function TicketTypeManager({
    eventId,
    eventStartAt,
    eventEndAt,
    serverNow,
    ticketTypes,
}: Props) {
    const router = useRouter();

    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [deleteTarget, setDeleteTarget] = useState<TicketType | null>(null);

    const editing = ticketTypes.find((type) => type.id === editingId) ?? null;

    /**
     * Publish precondition preview — mirrors design §10.3 / Phase 4 `publishEvent`.
     *
     * Only the ticket-type condition is evaluated here; the "start time in the future"
     * condition is shown too because it is one line and is the other common blocker.
     *
     * PHASE 20B (D-P19-05 = A) adds the third: an event needs an `endAt` to be published,
     * because an `endAt`-less event can never complete. The preview is a convenience — the
     * server re-evaluates every condition on publish — but it must not report "ready" for
     * an event the server will refuse, so the new condition is listed here too.
     */
    const activeWithQuota = ticketTypes.filter(
        (type) => type.isActive && type.inventory.quota > 0
    );

    // Compared against the SERVER's clock (passed as `serverNow`), not the browser's:
    // reading `Date.now()` during render is impure and can make this render
    // non-idempotent. The value is advisory anyway — `publishEvent` re-evaluates the
    // precondition server-side, so a slightly stale `serverNow` cannot publish anything.
    const startInFuture = new Date(eventStartAt).getTime() > new Date(serverNow).getTime();

    const readiness = [
        {
            label: "Waktu mulai event sudah di masa depan",
            met: startInFuture,
        },
        {
            label: "Minimal satu jenis tiket aktif dengan kuota lebih dari 0",
            met: activeWithQuota.length > 0,
        },
        {
            label: "Waktu selesai event sudah diisi",
            met: eventEndAt !== null,
        },
    ];

    function reset() {
        setForm(EMPTY_FORM);
        setEditingId(null);
        setError(null);
    }

    function startEdit(type: TicketType) {
        setEditingId(type.id);
        setError(null);
        setNotice(null);
        setForm({
            name: type.name,
            description: type.description ?? "",
            // Kept exactly as the API sent it. No Number() round trip.
            price: type.price,
            quota: String(type.inventory.quota),
            minPerOrder: String(type.minPerOrder),
            maxPerOrder: type.maxPerOrder === null ? "" : String(type.maxPerOrder),
            salesStartAt: toLocalInput(type.salesStartAt),
            salesEndAt: toLocalInput(type.salesEndAt),
            isActive: type.isActive,
            sortOrder: String(type.sortOrder),
        });
    }

    function buildPayload(): Record<string, unknown> {
        const payload: Record<string, unknown> = {
            name: form.name,
            description: form.description || null,
            price: form.price,
            quota: form.quota,
            minPerOrder: form.minPerOrder === "" ? undefined : form.minPerOrder,
            maxPerOrder: form.maxPerOrder === "" ? null : form.maxPerOrder,
            salesStartAt: toIso(form.salesStartAt),
            salesEndAt: toIso(form.salesEndAt),
            isActive: form.isActive,
            sortOrder: form.sortOrder === "" ? undefined : form.sortOrder,
        };

        // Drop undefined so a partial PATCH does not send keys the schema would treat
        // as "no change" in a confusing way.
        return Object.fromEntries(
            Object.entries(payload).filter(([, value]) => value !== undefined)
        );
    }

    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setBusy(true);
        setError(null);
        setNotice(null);

        const payload = buildPayload();

        try {
            if (editingId) {
                await apiFetch(
                    `/api/organizer/events/${eventId}/ticket-types/${editingId}`,
                    { method: "PATCH", body: JSON.stringify(payload) }
                );
            } else {
                await apiFetch(`/api/organizer/events/${eventId}/ticket-types`, {
                    method: "POST",
                    body: JSON.stringify(payload),
                });
            }

            const wasEditing = editingId !== null;

            reset();
            setNotice(
                wasEditing
                    ? "Jenis tiket diperbarui."
                    : "Jenis tiket ditambahkan. Jalankan publikasi bila syarat lain sudah terpenuhi."
            );
            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    async function setActive(type: TicketType, isActive: boolean) {
        setBusy(true);
        setError(null);
        setNotice(null);

        try {
            await apiFetch(
                `/api/organizer/events/${eventId}/ticket-types/${type.id}`,
                { method: "PATCH", body: JSON.stringify({ isActive }) }
            );

            if (editingId === type.id) {
                reset();
            }

            router.refresh();
        } catch (caught) {
            setError(
                caught instanceof ClientApiError ? caught.message : "Terjadi kesalahan."
            );
        } finally {
            setBusy(false);
        }
    }

    async function remove(type: TicketType) {
        setBusy(true);
        setError(null);
        setNotice(null);

        try {
            await apiFetch(
                `/api/organizer/events/${eventId}/ticket-types/${type.id}`,
                { method: "DELETE" }
            );

            if (editingId === type.id) {
                reset();
            }

            router.refresh();
        } catch (caught) {
            // A type that has been ordered cannot be deleted; the API explains why and
            // points at deactivation, so that message is shown verbatim.
            setError(
                caught instanceof ClientApiError
                    ? caught.message
                    : "Gagal menghapus jenis tiket."
            );
        } finally {
            setBusy(false);
        }
    }

    async function confirmDelete() {
        const type = deleteTarget;
        setDeleteTarget(null);
        if (!type) return;
        await remove(type);
    }

    return (
        <div className="flex flex-col gap-6">
            {/* Publish readiness preview (brief §27). Advisory only. */}

            <Card className="bg-muted/40 p-4">
                <ul className="flex flex-col gap-2">
                    {readiness.map((item) => (
                        <li key={item.label}>
                            <div className="flex flex-nowrap items-start gap-2">
                                <span
                                    aria-hidden
                                    className={
                                        item.met
                                            ? "font-bold text-emerald-600 dark:text-emerald-400"
                                            : "font-bold text-destructive"
                                    }
                                >
                                    {item.met ? "✓" : "✗"}
                                </span>

                                <span
                                    className={
                                        item.met
                                            ? "text-sm text-muted-foreground"
                                            : "text-sm"
                                    }
                                >
                                    {item.label}
                                </span>
                            </div>
                        </li>
                    ))}
                </ul>

                <p className="mt-2 text-xs text-muted-foreground">
                    Syarat ini diperiksa ulang oleh server saat publikasi dijalankan.
                </p>
            </Card>

            {/* TICKET TYPES */}

            {ticketTypes.length === 0 ? (
                <EmptyBlock
                    title="Belum ada jenis tiket"
                    description="Event hanya dapat dipublikasikan setelah ada minimal satu jenis tiket aktif dengan kuota lebih dari 0."
                />
            ) : (
                <SectionCard title="Jenis Tiket">
                    <DataTable
                        minWidth={1000}
                        columns={[
                            { header: "Jenis tiket" },
                            { header: "Harga" },
                            { header: "Kuota" },
                            { header: "Terjual" },
                            { header: "Ditahan" },
                            { header: "Tersedia" },
                            { header: "Penjualan" },
                            { header: "Status" },
                            { header: "", align: "right" },
                        ]}
                        rows={ticketTypes.map((type) => ({
                            key: type.id,
                            cells: [
                                <div className="flex flex-col" key="name">
                                    <span className="text-sm font-medium">
                                        {type.name}
                                    </span>

                                    <span className="text-xs text-muted-foreground">
                                        urutan {type.sortOrder} · min {type.minPerOrder}
                                        {type.maxPerOrder === null
                                            ? ""
                                            : ` · maks ${type.maxPerOrder}`}
                                    </span>
                                </div>,

                                <span className="whitespace-nowrap text-sm" key="price">
                                    {formatMoney(type.price, type.currency)}
                                </span>,

                                <span className="text-sm tabular-nums" key="quota">
                                    {type.inventory.quota.toLocaleString("id-ID")}
                                </span>,

                                <span className="text-sm tabular-nums" key="sold">
                                    {type.inventory.sold.toLocaleString("id-ID")}
                                </span>,

                                <span className="text-sm tabular-nums" key="reserved">
                                    {type.inventory.reserved.toLocaleString("id-ID")}
                                </span>,

                                <span
                                    className="text-sm font-medium tabular-nums"
                                    key="available"
                                >
                                    {type.inventory.available.toLocaleString("id-ID")}
                                </span>,

                                <div className="flex flex-col gap-0.5" key="sales">
                                    <span className="text-xs">
                                        {type.salesState}
                                        {type.isSoldOut ? " · habis" : ""}
                                    </span>

                                    <span className="text-xs text-muted-foreground">
                                        {type.salesStartAt
                                            ? new Date(type.salesStartAt).toLocaleString(
                                                  "id-ID"
                                              )
                                            : "mengikuti event"}
                                        {" → "}
                                        {type.salesEndAt
                                            ? new Date(type.salesEndAt).toLocaleString(
                                                  "id-ID"
                                              )
                                            : "mengikuti event"}
                                    </span>
                                </div>,

                                <StatusBadge
                                    key="status"
                                    tone={type.isActive ? "success" : "neutral"}
                                >
                                    {type.isActive ? "Aktif" : "Nonaktif"}
                                </StatusBadge>,

                                <div
                                    className="flex flex-nowrap justify-end gap-1"
                                    key="actions"
                                >
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => startEdit(type)}
                                    >
                                        Ubah
                                    </Button>

                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setActive(type, !type.isActive)}
                                    >
                                        {type.isActive ? "Nonaktifkan" : "Aktifkan"}
                                    </Button>

                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        disabled={busy}
                                        onClick={() => setDeleteTarget(type)}
                                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                    >
                                        Hapus
                                    </Button>
                                </div>,
                            ],
                        }))}
                    />
                </SectionCard>
            )}

            {error ? (
                <Alert variant="danger">
                    <AlertDescription className="text-foreground">{error}</AlertDescription>
                </Alert>
            ) : null}

            {notice ? (
                <Alert variant="info">
                    <AlertDescription className="text-foreground">{notice}</AlertDescription>
                </Alert>
            ) : null}

            {/* FORM */}

            <SectionCard
                title={editingId ? `Ubah "${editing?.name ?? ""}"` : "Tambah jenis tiket"}
            >
                <form onSubmit={submit} className="flex flex-col gap-5">
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                        <Field label="Nama" required htmlFor="ticket-type-name">
                            <Input
                                id="ticket-type-name"
                                required
                                minLength={2}
                                value={form.name}
                                onChange={(event) =>
                                    setForm({ ...form, name: event.currentTarget.value })
                                }
                                placeholder="Tribun, VIP, Early Bird…"
                            />
                        </Field>

                        <Field
                            label="Harga (IDR)"
                            hint="Maksimal 2 angka desimal. Nilai dikirim apa adanya tanpa pembulatan."
                            required
                            htmlFor="ticket-type-price"
                        >
                            <Input
                                id="ticket-type-price"
                                required
                                inputMode="decimal"
                                value={form.price}
                                onChange={(event) =>
                                    setForm({ ...form, price: event.currentTarget.value })
                                }
                                placeholder="150000"
                            />
                        </Field>

                        <Field
                            label="Kuota"
                            hint={
                                editing && editing.inventory.committed > 0
                                    ? `Kuota tidak dapat dikurangi di bawah ${editing.inventory.committed.toLocaleString(
                                          "id-ID"
                                      )} (terjual + ditahan).`
                                    : undefined
                            }
                            required
                            htmlFor="ticket-type-quota"
                        >
                            <Input
                                id="ticket-type-quota"
                                required
                                inputMode="numeric"
                                min={editing ? editing.inventory.committed : 0}
                                value={form.quota}
                                onChange={(event) =>
                                    setForm({ ...form, quota: event.currentTarget.value })
                                }
                            />
                        </Field>

                        <Field label="Urutan tampil" htmlFor="ticket-type-sort">
                            <Input
                                id="ticket-type-sort"
                                inputMode="numeric"
                                value={form.sortOrder}
                                onChange={(event) =>
                                    setForm({ ...form, sortOrder: event.currentTarget.value })
                                }
                            />
                        </Field>

                        <Field label="Minimal per order" htmlFor="ticket-type-min">
                            <Input
                                id="ticket-type-min"
                                inputMode="numeric"
                                value={form.minPerOrder}
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        minPerOrder: event.currentTarget.value,
                                    })
                                }
                            />
                        </Field>

                        <Field label="Maksimal per order" htmlFor="ticket-type-max">
                            <Input
                                id="ticket-type-max"
                                inputMode="numeric"
                                placeholder="kosong = mengikuti batas event"
                                value={form.maxPerOrder}
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        maxPerOrder: event.currentTarget.value,
                                    })
                                }
                            />
                        </Field>

                        <Field
                            label="Mulai penjualan"
                            hint="Kosong = mengikuti jadwal penjualan event."
                            htmlFor="ticket-type-sales-start"
                        >
                            <Input
                                id="ticket-type-sales-start"
                                type="datetime-local"
                                value={form.salesStartAt}
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        salesStartAt: event.currentTarget.value,
                                    })
                                }
                            />
                        </Field>

                        <Field
                            label="Berakhir penjualan"
                            htmlFor="ticket-type-sales-end"
                        >
                            <Input
                                id="ticket-type-sales-end"
                                type="datetime-local"
                                value={form.salesEndAt}
                                onChange={(event) =>
                                    setForm({
                                        ...form,
                                        salesEndAt: event.currentTarget.value,
                                    })
                                }
                            />
                        </Field>
                    </div>

                    <Field label="Deskripsi" htmlFor="ticket-type-description">
                        <Textarea
                            id="ticket-type-description"
                            rows={3}
                            value={form.description}
                            onChange={(event) =>
                                setForm({
                                    ...form,
                                    description: event.currentTarget.value,
                                })
                            }
                        />
                    </Field>

                    <label className="flex cursor-pointer items-center gap-3">
                        <Switch
                            checked={form.isActive}
                            onCheckedChange={(checked) =>
                                setForm({ ...form, isActive: checked })
                            }
                        />

                        <span className="text-[0.8125rem] font-medium leading-tight">
                            Aktif (dapat dibeli)
                        </span>
                    </label>

                    <div className="flex flex-wrap items-center gap-2">
                        <Button type="submit" disabled={busy}>
                            {busy ? (
                                <span
                                    aria-hidden
                                    className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current"
                                />
                            ) : null}
                            {busy
                                ? "Menyimpan…"
                                : editingId
                                  ? "Simpan perubahan"
                                  : "Tambah jenis tiket"}
                        </Button>

                        {editingId ? (
                            <Button type="button" variant="outline" onClick={reset}>
                                Batal
                            </Button>
                        ) : null}
                    </div>
                </form>
            </SectionCard>

            {/* DELETE CONFIRMATION */}

            <Dialog
                open={deleteTarget !== null}
                onOpenChange={(open) => {
                    if (!open) setDeleteTarget(null);
                }}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Hapus Jenis Tiket</DialogTitle>
                        <DialogDescription>
                            Hapus jenis tiket &quot;{deleteTarget?.name}&quot;?
                        </DialogDescription>
                    </DialogHeader>

                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                            Batal
                        </Button>

                        <Button variant="destructive" onClick={confirmDelete}>
                            Hapus
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
