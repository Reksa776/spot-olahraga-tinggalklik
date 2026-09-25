"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/dashboard/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/dashboard/ui/card";
import { Label, Textarea } from "@/components/dashboard/ui/input";
import { Switch } from "@/components/dashboard/ui/select";

/**
 * ==========================================
 * PHASE 32 — MAINTENANCE MODE FORM (ADMIN ONLY)
 * ==========================================
 *
 * The switch that closes the public application. Four controls and nothing else: an
 * enable/disable toggle, an optional message, an optional "back at …" line, and a save.
 *
 * ── THE FORM IS NOT THE CONTROL ─────────────────────────────────────────────────
 * `PATCH /api/admin/settings/application` is guarded by `maintenance.manage`, which only
 * ADMIN holds, and the page that renders this form is guarded by `application.settings`.
 * This component is therefore a convenience over an endpoint that refuses a MANAGER whether
 * or not this component exists — which is what "hidden UI is not authorization" means in
 * practice.
 *
 * ── WHY THE MESSAGE IS PRE-FILLED WITH THE RESOLVED VALUE ───────────────────────
 * The server passes the CURRENT message after applying the built-in default. An operator who
 * has never typed one therefore sees the sentence visitors will actually read, rather than an
 * empty box that implies the page would be blank. Clearing the field saves `null`, and the
 * default is applied again at render time — so "empty" always means "use the built-in
 * wording" and never "show nothing".
 *
 * The result is re-read from the server response and the route is refreshed, so the header
 * badge on the settings hub and the public page cannot show a stale state.
 */

export type MaintenanceFormState = {
    maintenanceMode: boolean;
    maintenanceMessage: string;
    maintenanceEtaMessage: string;
};

export function MaintenanceSettingsForm({
    initial,
}: {
    initial: MaintenanceFormState;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);

    const [enabled, setEnabled] = useState(initial.maintenanceMode);
    const [message, setMessage] = useState(initial.maintenanceMessage);
    const [etaMessage, setEtaMessage] = useState(initial.maintenanceEtaMessage);

    function onSubmit() {
        setError(null);
        setSaved(false);
        setBusy(true);

        void (async () => {
            try {
                const response = await fetch(
                    "/api/admin/settings/application",
                    {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            maintenanceMode: enabled,
                            maintenanceMessage: message.trim() || null,
                            maintenanceEtaMessage: etaMessage.trim() || null,
                        }),
                    }
                );

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    setError(
                        payload?.message ?? "Gagal menyimpan pengaturan maintenance."
                    );
                    return;
                }

                setSaved(true);
                startTransition(() => router.refresh());
            } catch {
                setError("Tidak dapat menghubungi server.");
            } finally {
                setBusy(false);
            }
        })();
    }

    const disabled = busy || pending;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Maintenance mode</CardTitle>
                <CardDescription>
                    Saat aktif, halaman publik dan alur pembelian ditutup. Dashboard tetap
                    dapat diakses oleh ADMIN, sehingga mode ini selalu bisa dimatikan
                    kembali.
                </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-5">
                <div className="flex items-center justify-between gap-4 rounded-field border border-border bg-muted/40 px-4 py-3">
                    <div className="min-w-0">
                        <p className="text-sm font-semibold">
                            Status: {enabled ? "ON" : "OFF"}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                            {enabled
                                ? "Situs publik ditutup untuk semua pengunjung."
                                : "Situs publik berjalan normal."}
                        </p>
                    </div>

                    <Switch
                        id="maintenance-mode"
                        checked={enabled}
                        onCheckedChange={(next) => {
                            setEnabled(next);
                            setSaved(false);
                        }}
                        aria-label="Aktifkan maintenance mode"
                    />
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="maintenance-message">
                        Pesan maintenance (opsional)
                    </Label>
                    <Textarea
                        id="maintenance-message"
                        value={message}
                        maxLength={500}
                        rows={3}
                        onChange={(event) => {
                            setMessage(event.target.value);
                            setSaved(false);
                        }}
                        placeholder="Website sedang dalam maintenance."
                    />
                    <p className="text-xs text-muted-foreground">
                        Kosongkan untuk memakai pesan bawaan.
                    </p>
                </div>

                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="maintenance-eta">
                        Perkiraan selesai (opsional)
                    </Label>
                    <Textarea
                        id="maintenance-eta"
                        value={etaMessage}
                        maxLength={200}
                        rows={2}
                        onChange={(event) => {
                            setEtaMessage(event.target.value);
                            setSaved(false);
                        }}
                        placeholder="Silakan kembali beberapa saat lagi."
                    />
                </div>

                {error ? (
                    <p className="text-sm font-semibold text-red-600" role="alert">
                        {error}
                    </p>
                ) : null}

                {saved && !error ? (
                    <p className="text-sm font-semibold text-emerald-700" role="status">
                        Pengaturan maintenance tersimpan.
                    </p>
                ) : null}

                <div className="flex justify-end">
                    <Button onClick={onSubmit} disabled={disabled}>
                        {disabled ? "Menyimpan…" : "Simpan pengaturan"}
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
