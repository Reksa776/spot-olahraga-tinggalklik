"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";
import { Input, Label } from "@/components/dashboard/ui/input";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/dashboard/ui/select";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/dashboard/ui/card";

/**
 * ==========================================
 * SETTLEMENT PREPARE FORM (PICO payout / settlement V1)
 * ==========================================
 *
 * The ONLY place a payout is created, and deliberately a narrow one: the operator picks the
 * tenant, the PIC payee and the period — and nothing else. No amount is typed anywhere: the
 * gross/deduction/net are the PIC's EARNED ledger rows in the window, computed by the
 * transactional core server-side. The PIC's bank is snapshotted from their profile at
 * prepare time, so it can never be edited into the payout by hand.
 *
 * The form posts to `/api/organizer/settlements` and lands on the settlement it created
 * (or, for an already-prepared window, on the one that already exists — the unique
 * `(payeeType, organizerId, picProfileId, periodStart, periodEnd)` index makes a repeat
 * prepare replay, not a double-settle).
 *
 * Options come from the server page: organizers are the actor's tenants where
 * `settlement.prepare` holds; PIC candidates are ACTIVE profiles that already carry
 * complete bank details (a payee who cannot be paid is not offered).
 */

export type PrepareOption = {
    id: string;
    name: string;
};

export function SettlementPrepareForm({
    organizers,
    pics,
}: {
    organizers: PrepareOption[];
    pics: (PrepareOption & { picCode: string | null })[];
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [organizerId, setOrganizerId] = useState("");
    const [picProfileId, setPicProfileId] = useState("");
    const [periodStart, setPeriodStart] = useState("");
    const [periodEnd, setPeriodEnd] = useState("");
    const [notes, setNotes] = useState("");

    function onSubmit() {
        setError(null);

        if (!organizerId) {
            setError("Pilih penyelenggara terlebih dahulu.");
            return;
        }

        if (!picProfileId) {
            setError("Pilih PIC penerima terlebih dahulu.");
            return;
        }

        const start = periodStart ? new Date(periodStart).getTime() : NaN;
        const end = periodEnd ? new Date(periodEnd).getTime() : NaN;

        if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
            setError("Periode harus valid dengan akhir setelah awal.");
            return;
        }

        setBusy(true);

        void (async () => {
            try {
                const response = await fetch(
                    "/api/organizer/settlements",
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            organizerId,
                            picProfileId,
                            periodStart: new Date(start).toISOString(),
                            periodEnd: new Date(end).toISOString(),
                            ...(notes.trim() ? { notes: notes.trim() } : {}),
                        }),
                    }
                );

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    setError(payload?.message ?? "Gagal menyiapkan settlement.");
                    return;
                }

                const settlementId =
                    typeof payload?.data?.id === "string"
                        ? payload.data.id
                        : null;

                if (!settlementId) {
                    setError("Tanggapan server tidak dikenal.");
                    return;
                }

                startTransition(() =>
                    router.push(`/dashboard/settlements/${settlementId}`)
                );
            } catch {
                setError("Tidak dapat menghubungi server.");
            } finally {
                setBusy(false);
            }
        })();
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>Buat pencairan</CardTitle>
                <CardDescription>
                    Siapkan pembayaran satu PIC untuk satu periode. Jumlah ditentukan dari
                    fee EARNED PIC pada periode tersebut — tidak ada nominal yang diketik.
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="settlement-organizer">Penyelenggara</Label>
                        <Select
                            value={organizerId}
                            onValueChange={(value) => setOrganizerId(value)}
                        >
                            <SelectTrigger id="settlement-organizer">
                                <SelectValue placeholder="Pilih penyelenggara" />
                            </SelectTrigger>
                            <SelectContent>
                                {organizers.map((organizer) => (
                                    <SelectItem
                                        key={organizer.id}
                                        value={organizer.id}
                                    >
                                        {organizer.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="settlement-pic">PIC penerima</Label>
                        <Select
                            value={picProfileId}
                            onValueChange={(value) => setPicProfileId(value)}
                        >
                            <SelectTrigger id="settlement-pic">
                                <SelectValue placeholder="Pilih PIC" />
                            </SelectTrigger>
                            <SelectContent>
                                {pics.map((pic) => (
                                    <SelectItem key={pic.id} value={pic.id}>
                                        {pic.name}
                                        {pic.picCode ? ` · ${pic.picCode}` : ""}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="settlement-period-start">Periode mulai</Label>
                        <Input
                            id="settlement-period-start"
                            type="datetime-local"
                            value={periodStart}
                            onChange={(event) => setPeriodStart(event.target.value)}
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="settlement-period-end">Periode selesai</Label>
                        <Input
                            id="settlement-period-end"
                            type="datetime-local"
                            value={periodEnd}
                            onChange={(event) => setPeriodEnd(event.target.value)}
                        />
                    </div>
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="settlement-notes">Catatan (opsional)</Label>
                    <Input
                        id="settlement-notes"
                        value={notes}
                        placeholder="Catatan internal untuk settlement ini"
                        onChange={(event) => setNotes(event.target.value)}
                    />
                </div>

                {error ? (
                    <span className="text-xs text-destructive">{error}</span>
                ) : null}

                <Button
                    type="button"
                    className="self-start"
                    disabled={busy || pending}
                    onClick={onSubmit}
                >
                    {busy ? "Menyiapkan…" : "Siapkan pencairan"}
                </Button>
            </CardContent>
        </Card>
    );
}