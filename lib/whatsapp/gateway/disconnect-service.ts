import type { AuthzScope } from "@/lib/authz/permissions";
import { AppError } from "@/lib/api/errors";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import { setWhatsAppManualDisconnect } from "@/lib/whatsapp/manual-disconnect";

import type { WhatsAppGateway } from "./gateway";
import {
    inspectWhatsAppGatewayLock,
    toWhatsAppGatewayLockStatus,
    type WhatsAppGatewayLockStatus,
    type WhatsAppLockHolder,
    type WhatsAppLockInspection,
} from "./lock-inspection";
import { forceReleaseStaleWhatsAppGatewayLock } from "./lock-release";
import { clearWhatsAppSessionDirectory } from "./session-cleanup";

export type DisconnectServiceOutcome =
    | {
          kind: "DISCONNECTED";
          alreadyDisconnected: boolean;
          deletedSession: boolean;
          socketClosed: boolean;
          forceReleased: boolean;
      }
    | {
          kind: "LOCK_HELD";
          lockHolder: WhatsAppLockHolder | null;
          lock: WhatsAppGatewayLockStatus;
      };

type DisconnectDependencies = {
    setManualDisconnect?: (value: boolean) => Promise<void>;
    inspectLock?: typeof inspectWhatsAppGatewayLock;
    forceReleaseStaleLock?: (
        sessionDir: string
    ) => Promise<boolean>;
    clearSession?: typeof clearWhatsAppSessionDirectory;
};

function lockStatusFrom(
    inspection: WhatsAppLockInspection
): WhatsAppGatewayLockStatus {
    return toWhatsAppGatewayLockStatus(inspection);
}

function auditHolder(holder: WhatsAppLockHolder | null) {
    return holder
        ? {
              pid: holder.pid,
              host: holder.host,
              startedAt: holder.startedAt,
              processName: holder.processName,
              alive: holder.alive,
              ownerId: holder.ownerId,
              source: holder.source,
          }
        : null;
}

/**
 * Disconnect the gateway and persist the latch.
 *
 * Order is deliberate: the latch is written FIRST so a crash after the socket closes
 * cannot auto-reconnect; then a stale lock may be released only when the caller
 * explicitly asks and a fresh inspection still proves it stale; then the gateway
 * closes the socket and releases both guards; only then is session material touched.
 * Deletion is refused when any lock remains, and the cleanup helper never removes the
 * session directory itself.
 */
export async function disconnectWhatsAppGateway(options: {
    gateway: WhatsAppGateway | null;
    sessionDir: string | null;
    input: {
        deleteSession: boolean;
        forceReleaseStale?: boolean;
        reason?: string;
    };
    actor: AuthzScope;
    request: Request;
    dependencies?: DisconnectDependencies;
}): Promise<DisconnectServiceOutcome> {
    const setManualDisconnect =
        options.dependencies?.setManualDisconnect ?? setWhatsAppManualDisconnect;
    const inspectLock =
        options.dependencies?.inspectLock ?? inspectWhatsAppGatewayLock;
    const forceReleaseStaleLock =
        options.dependencies?.forceReleaseStaleLock ??
        forceReleaseStaleWhatsAppGatewayLock;
    const clearSession =
        options.dependencies?.clearSession ?? clearWhatsAppSessionDirectory;

    await setManualDisconnect(true);

    let forceReleased = false;

    if (options.input.forceReleaseStale && options.sessionDir) {
        const initial = await inspectLock(options.sessionDir);

        if (initial.held && !initial.stale) {
            // A live lock is never stolen, regardless of the force flag.
            return {
                kind: "LOCK_HELD",
                lockHolder: initial.holder,
                lock: lockStatusFrom(initial),
            };
        }

        if (initial.held && initial.stale) {
            if (!initial.holder) {
                // Corrupt/unknown holder: fail closed and require manual inspection.
                return {
                    kind: "LOCK_HELD",
                    lockHolder: null,
                    lock: lockStatusFrom(initial),
                };
            }

            const released = await forceReleaseStaleLock(
                options.sessionDir
            );

            if (!released) {
                // The lock was renewed or replaced between inspection and release.
                const latest = await inspectLock(options.sessionDir).catch(
                    () => initial
                );

                return {
                    kind: "LOCK_HELD",
                    lockHolder: latest.holder,
                    lock: lockStatusFrom(latest),
                };
            }

            forceReleased = true;

            await writeTicketingAudit({
                action: "whatsapp.lock.force_release",
                actor: options.actor,
                entityType: "PlatformSetting",
                entityRef: "whatsapp-gateway",
                description:
                    "Operator melepas lock WhatsApp stale secara paksa setelah diagnostik menunjukkan pemegangnya tidak hidup.",
                beforeState: {
                    holder: auditHolder(initial.holder),
                    stale: initial.stale,
                    heartbeatAgeMs: initial.heartbeatAgeMs,
                },
                afterState: {
                    released: true,
                    reason: options.input.reason ?? null,
                },
                reason: options.input.reason ?? null,
                request: options.request,
            });
        }
    }

    const result = options.gateway
        ? await options.gateway.disconnect()
        : {
              status: "DISCONNECTED" as const,
              alreadyDisconnected: true,
              socketClosed: true,
          };

    if (result.status === "LOCK_HELD") {
        return {
            kind: "LOCK_HELD",
            lockHolder: result.lockHolder,
            lock: result.lock,
        };
    }

    /*
     * Fail closed: a timed-out socket close means we cannot prove the old Baileys
     * connection is gone. Never delete credentials while it may still be writing
     * them. A retry after the close settles is safe and idempotent.
     */
    if (options.input.deleteSession && !result.socketClosed) {
        throw new AppError("SERVICE_UNAVAILABLE", {
            message:
                "Socket WhatsApp belum tertutup; session tidak dihapus. Tunggu sebentar lalu coba lagi.",
        });
    }

    /*
     * Re-inspect after release. This also covers the "gateway unavailable" case: the
     * other process may still own the lease/local lock, and deleting its session would
     * be the exact split-brain the guards exist to prevent.
     */
    if (options.sessionDir) {
        const inspection = await inspectLock(options.sessionDir);

        if (inspection.held) {
            return {
                kind: "LOCK_HELD",
                lockHolder: inspection.holder,
                lock: lockStatusFrom(inspection),
            };
        }
    } else if (options.input.deleteSession) {
        throw AppError.conflict(
            "Session WhatsApp tidak dapat dihapus karena direktori session tidak tersedia."
        );
    }

    let deletedSession = false;

    if (options.input.deleteSession && options.sessionDir) {
        try {
            await clearSession(options.sessionDir);
            deletedSession = true;
        } catch {
            throw new AppError("INTERNAL_ERROR", {
                message:
                    "Session WhatsApp tidak dapat dihapus. Operasi dihentikan agar tidak meninggalkan sesi setengah terhapus.",
            });
        }
    }

    await writeTicketingAudit({
        action: "whatsapp.disconnect",
        actor: options.actor,
        entityType: "PlatformSetting",
        entityRef: "whatsapp-gateway",
        description:
            "Operator memutuskan koneksi WhatsApp dan mengaktifkan manual disconnect.",
        afterState: {
            deleteSession: options.input.deleteSession,
            deletedSession,
            alreadyDisconnected: result.alreadyDisconnected,
            socketClosed: result.socketClosed,
            forceReleased,
            reason: options.input.reason ?? null,
        },
        reason: options.input.reason ?? null,
        request: options.request,
    });

    return {
        kind: "DISCONNECTED",
        alreadyDisconnected: result.alreadyDisconnected,
        deletedSession,
        socketClosed: result.socketClosed,
        forceReleased,
    };
}
