import os from "node:os";
import path from "node:path";

import { readWhatsAppGatewayLease } from "./lease";
import { readLocalProcessLock } from "./local-lock";

/**
 * Read-only view of the two ownership guards. Nothing here acquires or releases a lock;
 * the disconnect flow calls it before deleting session material so it can refuse a
 * deletion while another process may still own the socket.
 */

export type WhatsAppLockHolder = {
    /** OS pid when the local lock file is readable; parsed from the lease otherwise. */
    pid: number | null;
    /** Only known for the local file lock; a DB lease does not store a hostname. */
    host: string | null;
    /** ISO acquisition time when the local lock file is readable. */
    startedAt: string | null;
    ownerId: string | null;
    source: "local" | "lease" | "local+lease";
};

export type WhatsAppLockInspection = {
    lockHolder: WhatsAppLockHolder | null;
    localLock: boolean;
    databaseLease: boolean;
};

function pidFromOwnerId(ownerId: string | null | undefined): number | null {
    const match = ownerId?.match(/^wa-(\d+)-/);
    const pid = match ? Number(match[1]) : NaN;

    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export async function inspectWhatsAppGatewayLock(
    sessionDir: string,
    now: Date = new Date()
): Promise<WhatsAppLockInspection> {
    const lockPath = path.join(
        /* turbopackIgnore: true */ sessionDir,
        ".gateway.lock"
    );

    const local = await readLocalProcessLock(lockPath);
    const lease = await readWhatsAppGatewayLease();
    const databaseLease = Boolean(
        lease?.lockedBy &&
            lease.lockedUntil &&
            lease.lockedUntil.getTime() > now.getTime()
    );

    if (!local.exists && !databaseLease) {
        return { lockHolder: null, localLock: false, databaseLease: false };
    }

    const ownerId = local.record?.ownerId ?? lease?.lockedBy ?? null;

    return {
        lockHolder: {
            pid: local.record?.pid ?? pidFromOwnerId(lease?.lockedBy),
            host: local.exists ? os.hostname() : null,
            startedAt: local.record?.acquiredAt ?? null,
            ownerId,
            source: local.exists
                ? databaseLease
                    ? "local+lease"
                    : "local"
                : "lease",
        },
        localLock: local.exists,
        databaseLease,
    };
}
