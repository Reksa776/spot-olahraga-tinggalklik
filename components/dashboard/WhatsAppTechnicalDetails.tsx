"use client";

import { useState } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";

import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/dashboard/ui/misc";

export type TechnicalLockHolder = {
    pid: number | null;
    host: string | null;
    startedAt: string | null;
    processName: string | null;
    alive: boolean;
    ownerId: string | null;
    source: string;
};

export type TechnicalGatewayLock = {
    held: boolean;
    holder: TechnicalLockHolder | null;
    stale: boolean;
    heartbeatAgeMs: number | null;
};

function formatAge(ms: number | null): string {
    if (ms === null || !Number.isFinite(ms)) {
        return "Tidak tersedia";
    }

    const seconds = Math.max(0, Math.floor(ms / 1000));

    if (seconds < 60) {
        return `${seconds} detik lalu`;
    }

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60) {
        return `${minutes} menit lalu`;
    }

    const hours = Math.floor(minutes / 60);

    return `${hours} jam ${minutes % 60} menit lalu`;
}

/**
 * Diagnostics for support, kept out of the default operator view.
 *
 * The parent renders this only for CONFLICT or ERROR, so a healthy connection
 * never exposes process IDs, hostnames or heartbeat internals.
 */
export function WhatsAppTechnicalDetails({
    state,
    lock,
    lastErrorCode,
}: {
    state: string;
    lock: TechnicalGatewayLock | null;
    lastErrorCode?: string | null;
}) {
    const [copied, setCopied] = useState(false);
    const [copyFailed, setCopyFailed] = useState(false);

    const holder = lock?.holder ?? null;
    const heartbeat = formatAge(lock?.heartbeatAgeMs ?? null);

    async function copyDetails() {
        const details = [
            `Status: ${state}`,
            `PID: ${holder?.pid ?? "Tidak tersedia"}`,
            `Proses: ${holder?.processName ?? "Tidak tersedia"}`,
            `Host: ${holder?.host ?? "Tidak tersedia"}`,
            `Heartbeat: ${heartbeat}`,
            `Stale: ${lock?.stale ? "ya" : "tidak"}`,
            `Kode error: ${lastErrorCode ?? "Tidak ada"}`,
        ].join("\n");

        try {
            await navigator.clipboard.writeText(details);
            setCopied(true);
            setCopyFailed(false);
            window.setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
            setCopyFailed(true);
        }
    }

    return (
        <div className="rounded-field border border-border/70 bg-muted/30 px-3 py-2">
            <Collapsible>
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left text-sm font-medium">
                    Detail teknis
                    <ChevronDown className="size-4 text-muted-foreground" />
                </CollapsibleTrigger>

                <CollapsibleContent className="space-y-3 pt-3">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                        <dt className="text-muted-foreground">Status</dt>
                        <dd className="font-mono">{state}</dd>
                        <dt className="text-muted-foreground">PID</dt>
                        <dd className="font-mono">
                            {holder?.pid ?? "Tidak tersedia"}
                        </dd>
                        <dt className="text-muted-foreground">Proses</dt>
                        <dd className="break-all font-mono">
                            {holder?.processName ?? "Tidak tersedia"}
                        </dd>
                        <dt className="text-muted-foreground">Host</dt>
                        <dd className="break-all font-mono">
                            {holder?.host ?? "Tidak tersedia"}
                        </dd>
                        <dt className="text-muted-foreground">Heartbeat</dt>
                        <dd>{heartbeat}</dd>
                        <dt className="text-muted-foreground">Stale</dt>
                        <dd>{lock?.stale ? "ya" : "tidak"}</dd>
                        <dt className="text-muted-foreground">Kode error</dt>
                        <dd className="break-all font-mono">
                            {lastErrorCode ?? "Tidak ada"}
                        </dd>
                    </dl>

                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            type="button"
                            onClick={() => void copyDetails()}
                            className="inline-flex items-center gap-1.5 rounded-field border border-border bg-card px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
                        >
                            {copied ? (
                                <Check className="size-3.5" />
                            ) : (
                                <Copy className="size-3.5" />
                            )}
                            {copied ? "Tersalin" : "Salin detail"}
                        </button>

                        {copyFailed ? (
                            <span className="text-xs text-destructive">
                                Gagal menyalin. Salin manual dari detail di atas.
                            </span>
                        ) : null}
                    </div>
                </CollapsibleContent>
            </Collapsible>
        </div>
    );
}
