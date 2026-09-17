"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
    Alert,
    Box,
    Button,
    Group,
    Loader,
    Paper,
    Stack,
    Text,
} from "@mantine/core";

import {
    PageHeader,
    SectionCard,
    StatusBadge,
    type Tone,
} from "@/components/dashboard/primitives";

/**
 * PHASE (Mantine body migration): presentation only.
 *
 * Preserved exactly: every endpoint (`/api/admin/whatsapp/{status,qr,connect,disconnect}`) and its
 * `credentials: "include"` / `cache: "no-store"` options, the `data.success` result checks, the
 * `POLL_INTERVAL_MS = 1500` polling loop with its initial fetch and `clearInterval` teardown, both
 * `console.log` diagnostics (the "safe debug log" that never prints the QR string), the `setQr(null)`
 * on a successful disconnect, the `statusRef` assignment, `canConnect = !isConnected && !isConnecting`,
 * every `setActionError` message branch, and the Asia/Jakarta `connectedAt` formatting.
 *
 * Presentation changes only: the tinted `<span>` status pill became `StatusBadge` with the same six
 * labels, the hand-rolled spinner became a Mantine `Loader` (colour now from the theme rather than a
 * stray rose accent), and the card/rows are `SectionCard`/`Group` + `Text`.
 */

// ==========================================
// TYPES
// ==========================================

type WhatsAppStatus =
    | "DISCONNECTED"
    | "CONNECTING"
    | "CONNECTED"
    | "RECONNECTING"
    | "LOGGED_OUT"
    | "ERROR";

type StatusData = {
    status: WhatsAppStatus;
    phoneNumber: string | null;
    connectedAt: string | null;
    lastDisconnectedAt: string | null;
    lastError: string | null;
    reconnectAttempts: number;
};

// ==========================================
// POLLING INTERVAL
// ==========================================
const POLL_INTERVAL_MS = 1500;

/** The same six labels the previous tinted pills rendered, with their semantic tone. */
const STATUS_TONE: Record<WhatsAppStatus, Tone> = {
    DISCONNECTED: "neutral",
    CONNECTING: "warn",
    CONNECTED: "success",
    RECONNECTING: "warn",
    LOGGED_OUT: "error",
    ERROR: "error",
};

const STATUS_LABEL: Record<WhatsAppStatus, string> = {
    DISCONNECTED: "DISCONNECTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    RECONNECTING: "RECONNECTING",
    LOGGED_OUT: "LOGGED OUT",
    ERROR: "ERROR",
};

function StatusRow({ label, children }: { label: string; children: ReactNode }) {
    return (
        <Group justify="space-between" align="center" gap="md" wrap="nowrap">
            <Text size="sm" fw={500} c="dimmed">
                {label}
            </Text>

            {children}
        </Group>
    );
}

// ==========================================
// COMPONENT
// ==========================================

export default function WhatsAppDashboard() {
    const [status, setStatus] = useState<StatusData | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    // ==========================================
    // FETCH STATUS
    // ==========================================
    const fetchStatus = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/whatsapp/status", {
                credentials: "include",
                cache: "no-store",
            });
            const data = await res.json();
            if (data.success) {
                setStatus(data.data);
            }
        } catch {
            // Silently fail — polling will retry
        }
    }, []);

    // ==========================================
    // FETCH QR
    // ==========================================
    const fetchQr = useCallback(async () => {
        try {
            const res = await fetch("/api/admin/whatsapp/qr", {
                credentials: "include",
                cache: "no-store",
            });
            const data = await res.json();

            if (data.success) {
                // Set QR — let the backend be the source of truth
                setQr(data.qr ?? null);

                // Safe debug log — never log the actual QR string
                console.log("[WA DASHBOARD QR]", {
                    success: data.success,
                    hasQr: Boolean(data.qr),
                    qrLength: data.qr?.length ?? 0,
                    status: data.status?.status,
                });
            }
        } catch {
            // Silently fail
        }
    }, []);

    // ==========================================
    // DERIVED STATE (before refs/hooks that use it)
    // ==========================================
    const currentStatus = status?.status || "DISCONNECTED";
    const isConnected = currentStatus === "CONNECTED";
    const isConnecting = currentStatus === "CONNECTING";
    const canConnect = !isConnected && !isConnecting;

    // ==========================================
    // POLLING LOOP
    // ==========================================
    const statusRef = useRef(currentStatus);
    statusRef.current = currentStatus;

    useEffect(() => {
        // Initial fetch
        fetchStatus();
        fetchQr();

        const interval = setInterval(() => {
            fetchStatus();
            fetchQr();
        }, POLL_INTERVAL_MS);

        return () => clearInterval(interval);
    }, [fetchStatus, fetchQr]);

    // ==========================================
    // CONNECT
    // ==========================================
    async function handleConnect() {
        setLoading(true);
        setActionError(null);

        try {
            const res = await fetch("/api/admin/whatsapp/connect", {
                method: "POST",
                credentials: "include",
            });
            const data = await res.json();

            if (!data.success) {
                setActionError(data.message || "Gagal menghubungkan.");
            }
        } catch {
            setActionError("Gagal menghubungkan WhatsApp.");
        } finally {
            setLoading(false);
        }
    }

    // ==========================================
    // DISCONNECT
    // ==========================================
    async function handleDisconnect() {
        setLoading(true);
        setActionError(null);

        try {
            const res = await fetch("/api/admin/whatsapp/disconnect", {
                method: "POST",
                credentials: "include",
            });
            const data = await res.json();

            if (!data.success) {
                setActionError(data.message || "Gagal memutus.");
            } else {
                setQr(null);
            }
        } catch {
            setActionError("Gagal memutus WhatsApp.");
        } finally {
            setLoading(false);
        }
    }

    // ==========================================
    // RENDER
    // ==========================================

    // Debug log before render
    console.log("[WA DASHBOARD RENDER]", {
        hasQr: Boolean(qr),
        qrLength: qr?.length ?? 0,
        status: currentStatus,
    });

    return (
        <Stack gap="lg">
            <PageHeader
                eyebrow="Admin"
                title="WhatsApp Integration"
                description="Hubungkan perangkat WhatsApp untuk mengirim notifikasi ke pelanggan."
            />

            <Box maw={720}>
                <SectionCard>
                    <Stack gap="md">
                        {/* STATUS */}
                        <StatusRow label="Status">
                            <StatusBadge
                                tone={STATUS_TONE[currentStatus] ?? "neutral"}
                            >
                                {STATUS_LABEL[currentStatus] ?? currentStatus}
                            </StatusBadge>
                        </StatusRow>

                        {/* PHONE */}
                        <StatusRow label="Phone">
                            <Text size="sm">{status?.phoneNumber || "-"}</Text>
                        </StatusRow>

                        {/* CONNECTED AT */}
                        {isConnected && status?.connectedAt ? (
                            <StatusRow label="Connected">
                                <Text size="sm">
                                    {new Date(status.connectedAt).toLocaleString(
                                        "id-ID",
                                        {
                                            timeZone: "Asia/Jakarta",
                                            day: "numeric",
                                            month: "short",
                                            year: "numeric",
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        }
                                    )}
                                </Text>
                            </StatusRow>
                        ) : null}

                        {/* ERROR */}
                        {status?.lastError || actionError ? (
                            <Alert color="red" variant="light" radius="md">
                                {actionError || status?.lastError}
                            </Alert>
                        ) : null}

                        {/* QR CODE SECTION */}
                        {qr ? (
                            <Stack gap="xs">
                                <Paper
                                    withBorder
                                    radius="md"
                                    p="lg"
                                    style={{
                                        display: "flex",
                                        justifyContent: "center",
                                        backgroundColor:
                                            "var(--mantine-color-gray-0)",
                                    }}
                                >
                                    <QRCodeSVG value={qr} size={280} />
                                </Paper>

                                <Text size="xs" c="dimmed" ta="center">
                                    Scan QR code menggunakan WhatsApp:
                                    <br />
                                    Settings → Linked Devices → Link a Device
                                </Text>
                            </Stack>
                        ) : isConnecting ? (
                            <Paper
                                withBorder
                                radius="md"
                                p="lg"
                                style={{
                                    backgroundColor: "var(--mantine-color-gray-0)",
                                }}
                            >
                                <Stack align="center" gap="sm">
                                    <Loader size="md" />

                                    <Text size="sm" c="dimmed">
                                        Menunggu QR code...
                                    </Text>
                                </Stack>
                            </Paper>
                        ) : null}

                        {/* ACTION BUTTONS */}
                        {/* The `loading` prop is deliberately not used: Mantine renders the label
                            alongside its loader, but the original showed a different label per
                            state, so the exact three-way/binary label copy is kept and the button
                            is only disabled while a request is in flight. */}
                        {canConnect ? (
                            <Button
                                size="md"
                                radius="md"
                                color="green"
                                fullWidth
                                onClick={handleConnect}
                                disabled={loading || isConnecting}
                            >
                                {loading
                                    ? "Menghubungkan..."
                                    : isConnecting
                                      ? "Menunggu QR..."
                                      : "Connect WhatsApp"}
                            </Button>
                        ) : (
                            <Button
                                size="md"
                                radius="md"
                                color="red"
                                fullWidth
                                onClick={handleDisconnect}
                                disabled={loading}
                            >
                                {loading ? "Memutus..." : "Disconnect"}
                            </Button>
                        )}
                    </Stack>
                </SectionCard>
            </Box>
        </Stack>
    );
}
