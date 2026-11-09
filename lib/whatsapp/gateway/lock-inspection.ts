import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readWhatsAppGatewayLease } from "./lease";
import { readLocalProcessLock } from "./local-lock";

/**
 * Read-only view of the two ownership guards.
 *
 * The local file and the DB lease answer different questions. The file names the OS
 * process on this host, while the lease fences ownership across hosts. This module
 * combines them into one operator-facing snapshot without acquiring or releasing
 * anything. A stale lock is evidence for the recovery path, never permission for this
 * reader to remove it.
 */

export const DEFAULT_LOCK_STALE_MS = 10 * 60 * 1000;

export type WhatsAppLockHolder = {
    /** OS pid when the local lock file is readable; parsed from the lease otherwise. */
    pid: number | null;
    /** The host recorded by the local lock. A DB lease has no host. */
    host: string | null;
    /** ISO acquisition time when the local lock file is readable. */
    startedAt: string | null;
    /** Read from /proc/<pid>/cmdline on Linux; null when unavailable. */
    processName: string | null;
    /** True only when the holder is proven alive, or a remote heartbeat is fresh. */
    alive: boolean;
    ownerId: string | null;
    source: "local" | "lease" | "local+lease";
};

export type WhatsAppGatewayLockStatus = {
    held: boolean;
    holder: WhatsAppLockHolder | null;
    stale: boolean;
    heartbeatAgeMs: number | null;
};

export type WhatsAppLockInspection = WhatsAppGatewayLockStatus & {
    localLock: boolean;
    databaseLease: boolean;
    /** The lease row owner, including an expired row that has not been cleaned up. */
    leaseOwnerId: string | null;
    /** Exact optimistic token used by the force-release path. */
    leaseUpdatedAt: string | null;
};

export function resolveWhatsAppLockStaleMs(
    env: NodeJS.ProcessEnv = process.env
): number {
    const parsed = Number(env.LOCK_STALE_MS?.trim());

    return Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_LOCK_STALE_MS;
}

function pidFromOwnerId(ownerId: string | null | undefined): number | null {
    const match = ownerId?.match(/^wa-(\d+)-/);
    const pid = match ? Number(match[1]) : NaN;

    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function timestampMs(value: string | null | undefined): number | null {
    if (!value) {
        return null;
    }

    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * `process.kill(pid, 0)` is the portable liveness probe. Only ESRCH proves that the
 * process is gone; EPERM means it exists but belongs to another user. Any other error
 * is treated as alive so a diagnostic failure can never authorize a destructive release.
 */
function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

function commandLineName(raw: string): string | null {
    const parts = raw
        .split("\0")
        .map((part) => part.trim())
        .filter(Boolean);

    if (parts.length === 0) {
        return null;
    }

    // Operators need enough context to identify the process without exposing the
    // session path as a separate API field. The result is bounded and never contains
    // the environment block.
    return parts.join(" ").slice(0, 200);
}

/**
 * Best-effort process name. /proc is Linux-only and may be hidden by container or
 * permission policy, so every failure is deliberately downgraded to null.
 */
export async function readProcessNameFromProc(
    pid: number | null
): Promise<string | null> {
    if (
        process.platform !== "linux" ||
        pid === null ||
        !Number.isSafeInteger(pid) ||
        pid <= 0
    ) {
        return null;
    }

    try {
        return commandLineName(
            await fs.readFile(`/proc/${pid}/cmdline`, "utf8")
        );
    } catch {
        return null;
    }
}

function sameHost(left: string | null, right: string): boolean {
    return left?.trim().toLowerCase() === right.trim().toLowerCase();
}

export async function inspectWhatsAppGatewayLock(
    sessionDir: string,
    now: Date = new Date(),
    options: { staleMs?: number } = {}
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
    const held = local.exists || databaseLease;

    if (!held) {
        return {
            held: false,
            holder: null,
            stale: false,
            heartbeatAgeMs: null,
            localLock: false,
            databaseLease: false,
            leaseOwnerId: lease?.lockedBy ?? null,
            leaseUpdatedAt: lease?.updatedAt?.toISOString() ?? null,
        };
    }

    const localHost = local.exists
        ? (local.record?.host ?? os.hostname())
        : null;
    const ownerId = local.record?.ownerId ?? lease?.lockedBy ?? null;
    const pid = local.record?.pid ?? pidFromOwnerId(lease?.lockedBy);
    const localHeartbeat = timestampMs(
        local.record?.heartbeatAt ?? local.record?.acquiredAt
    );
    const leaseHeartbeat = lease?.updatedAt?.getTime() ?? null;
    const heartbeatMs =
        localHeartbeat === null
            ? leaseHeartbeat
            : leaseHeartbeat === null
              ? localHeartbeat
              : Math.max(localHeartbeat, leaseHeartbeat);
    const heartbeatAgeMs =
        heartbeatMs === null
            ? null
            : Math.max(0, now.getTime() - heartbeatMs);
    const staleMs = options.staleMs ?? resolveWhatsAppLockStaleMs();

    let alive: boolean;
    let stale: boolean;

    if (local.exists) {
        if (pid === null) {
            // A corrupt/unreadable record is HELD by definition, but we cannot prove
            // it stale. Fail closed and require a human to inspect the file.
            alive = false;
            stale = false;
        } else if (sameHost(localHost, os.hostname())) {
            alive = isProcessAlive(pid);
            stale = !alive;
        } else if (heartbeatAgeMs === null) {
            // Different host and no heartbeat: do not guess. A wrong stale decision
            // here would allow two live gateways to overlap.
            alive = true;
            stale = false;
        } else {
            alive = heartbeatAgeMs <= staleMs;
            stale = !alive;
        }
    } else if (heartbeatAgeMs === null) {
        // A lease without any readable heartbeat is held but not provably stale.
        alive = true;
        stale = false;
    } else {
        // A DB lease has no host. The heartbeat is the only cross-host evidence.
        alive = heartbeatAgeMs <= staleMs;
        stale = !alive;
    }

    const processName = await readProcessNameFromProc(pid);

    return {
        held: true,
        holder: {
            pid,
            host: localHost,
            startedAt: local.record?.acquiredAt ?? null,
            processName,
            alive,
            ownerId,
            source: local.exists
                ? databaseLease
                    ? "local+lease"
                    : "local"
                : "lease",
        },
        stale,
        heartbeatAgeMs,
        localLock: local.exists,
        databaseLease,
        leaseOwnerId: lease?.lockedBy ?? null,
        leaseUpdatedAt: lease?.updatedAt?.toISOString() ?? null,
    };
}

export function toWhatsAppGatewayLockStatus(
    inspection: WhatsAppLockInspection
): WhatsAppGatewayLockStatus {
    return {
        held: inspection.held,
        holder: inspection.holder,
        stale: inspection.stale,
        heartbeatAgeMs: inspection.heartbeatAgeMs,
    };
}
