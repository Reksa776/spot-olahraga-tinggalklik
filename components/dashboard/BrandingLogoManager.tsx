"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ImageOff, Upload } from "lucide-react";

import { Button } from "@/components/dashboard/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/dashboard/ui/card";

/**
 * ==========================================
 * PHASE 32 — APPLICATION LOGO MANAGER (ADMIN ONLY)
 * ==========================================
 *
 * Upload, replace and remove the application logo. Deliberately small: one preview, one file
 * picker, one destructive action. The brief explicitly asks not to build a CMS, and this is
 * the whole of the branding scope.
 *
 * ── THE PREVIEW IS THE CONFIGURED ASSET, NOT A LOCAL PICK ───────────────────────
 * `initialLogoUrl` is the persistent URL currently in `PlatformSetting.logoUrl`, i.e. what
 * the landing page, the dashboard lockup and the maintenance page render right now. The
 * component never previews a `URL.createObjectURL(file)` result as if it were saved —
 * a browser object URL dies with the tab and is exactly what the brief forbids storing — so
 * what the operator sees on this page is always the state the database is in.
 *
 * ── THE REMOVAL IS AN EXPLICIT ACTION, AND ITS RESULT IS A FALLBACK ─────────────
 * "Remove" clears the reference; the lockup then renders the built-in brand mark. There is no
 * "broken image" state to design around because the reader resolves `null` to the fallback
 * before anything renders (see `components/Brand.tsx`).
 *
 * The accepted formats are stated rather than implied, and must match what the server
 * validates by CONTENT (JPEG / PNG / WebP magic bytes). SVG is deliberately not listed and
 * not accepted: this codebase has no SVG sanitizer, and an SVG is a scriptable document.
 */

export function BrandingLogoManager({
    initialLogoUrl,
}: {
    initialLogoUrl: string | null;
}) {
    const router = useRouter();
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    // Local, and only used to BUST the browser cache after a replace: the stored path is
    // stable per upload, but the previous asset is deleted, so a stale cache hit would show a
    // 404-ish gap. The value is a counter, never a file path.
    const [cacheBust, setCacheBust] = useState(0);

    const [logoUrl, setLogoUrl] = useState(initialLogoUrl);

    const disabled = busy || pending;

    function onPickFile() {
        setError(null);
        fileInputRef.current?.click();
    }

    function onFileSelected(file: File | null) {
        if (!file) {
            return;
        }

        setError(null);
        setBusy(true);

        void (async () => {
            try {
                const body = new FormData();
                body.append("file", file);

                const response = await fetch("/api/admin/settings/branding", {
                    method: "POST",
                    body,
                });

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    setError(payload?.message ?? "Gagal mengunggah logo.");
                    return;
                }

                const nextUrl =
                    typeof payload?.data?.logoUrl === "string"
                        ? payload.data.logoUrl
                        : null;

                setLogoUrl(nextUrl);
                setCacheBust((value) => value + 1);
                startTransition(() => router.refresh());
            } catch {
                setError("Tidak dapat menghubungi server.");
            } finally {
                setBusy(false);

                // Let the same file be chosen again after an error (the input keeps its value
                // otherwise, so a second `change` would never fire).
                if (fileInputRef.current) {
                    fileInputRef.current.value = "";
                }
            }
        })();
    }

    function onRemove() {
        setError(null);
        setBusy(true);

        void (async () => {
            try {
                const response = await fetch("/api/admin/settings/branding", {
                    method: "DELETE",
                });

                const payload = await response.json().catch(() => null);

                if (!response.ok) {
                    setError(payload?.message ?? "Gagal menghapus logo.");
                    return;
                }

                setLogoUrl(null);
                setCacheBust((value) => value + 1);
                startTransition(() => router.refresh());
            } catch {
                setError("Tidak dapat menghubungi server.");
            } finally {
                setBusy(false);
            }
        })();
    }

    const previewSrc = logoUrl
        ? `${logoUrl}${cacheBust ? `?v=${cacheBust}` : ""}`
        : null;

    return (
        <Card>
            <CardHeader>
                <CardTitle>Logo aplikasi</CardTitle>
                <CardDescription>
                    Logo ini dipakai di landing page publik dan di header dashboard. Jika
                    tidak ada logo, brand bawaan yang dipakai.
                </CardDescription>
            </CardHeader>

            <CardContent className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center gap-5">
                    <div className="grid h-24 w-40 shrink-0 place-items-center rounded-field border border-dashed border-border bg-muted/40 px-3">
                        {previewSrc ? (
                            // Same reasoning as the lockup: an uploaded asset of unknown
                            // intrinsic size, so a plain img with `object-contain`.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                                src={previewSrc}
                                alt="Logo aplikasi saat ini"
                                className="max-h-16 w-auto max-w-full object-contain"
                            />
                        ) : (
                            <span className="flex flex-col items-center gap-1.5 text-muted-foreground">
                                <ImageOff className="size-5" aria-hidden />
                                <span className="text-xs font-semibold">
                                    Belum ada logo
                                </span>
                            </span>
                        )}
                    </div>

                    <div className="flex min-w-0 flex-col gap-2">
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/png,image/jpeg,image/webp"
                            className="hidden"
                            onChange={(event) =>
                                onFileSelected(event.target.files?.[0] ?? null)
                            }
                        />

                        <div className="flex flex-wrap gap-2">
                            <Button onClick={onPickFile} disabled={disabled}>
                                <Upload />
                                {logoUrl ? "Ganti logo" : "Unggah logo"}
                            </Button>

                            {logoUrl ? (
                                <Button
                                    variant="outline"
                                    onClick={onRemove}
                                    disabled={disabled}
                                >
                                    Hapus logo
                                </Button>
                            ) : null}
                        </div>

                        <p className="text-xs text-muted-foreground">
                            Format: PNG / JPEG / WebP. Maksimal 5MB.
                        </p>
                    </div>
                </div>

                {error ? (
                    <p className="text-sm font-semibold text-red-600" role="alert">
                        {error}
                    </p>
                ) : null}

                {busy ? (
                    <p className="text-sm text-muted-foreground">Memproses…</p>
                ) : null}
            </CardContent>
        </Card>
    );
}
