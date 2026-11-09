import path from "node:path";

import {
    readWhatsAppGatewayLease,
    releaseStaleWhatsAppGatewayLease,
} from "./lease";
import { inspectWhatsAppGatewayLock } from "./lock-inspection";
import { removeLocalProcessLockIfOwned } from "./local-lock";

/**
 * Remove a lock only after re-inspecting it and proving it is stale.
 *
 * Safety rules:
 * - A live lock is never released, even if the caller asked to force it.
 * - A replacement owner is never removed: the local file is compared by ownerId/pid,
 *   and the DB lease by lockedBy + the exact updatedAt snapshot.
 * - If any guard remains afterwards, the result is false and the disconnect flow
 *   continues to refuse.
 */
export async function forceReleaseStaleWhatsAppGatewayLock(
    sessionDir: string,
    options: { now?: Date } = {}
): Promise<boolean> {
    const before = await inspectWhatsAppGatewayLock(sessionDir, options.now);

    if (!before.held || !before.stale || !before.holder) {
        return false;
    }

    const holder = before.holder;

    // A live lease owned by someone else means the local file is not the only owner.
    // Removing it would not free the gateway, so fail closed without mutating anything.
    if (
        before.databaseLease &&
        before.leaseOwnerId !== holder.ownerId
    ) {
        return false;
    }

    let leaseToRelease:
        | { lockedBy: string; updatedAt: Date }
        | null = null;

    if (
        before.leaseOwnerId &&
        before.leaseUpdatedAt &&
        before.leaseOwnerId === holder.ownerId
    ) {
        const currentLease = await readWhatsAppGatewayLease();

        if (
            !currentLease?.lockedBy ||
            currentLease.lockedBy !== before.leaseOwnerId ||
            currentLease.updatedAt.toISOString() !== before.leaseUpdatedAt
        ) {
            // The owner renewed or was replaced after inspection. Do not release.
            return false;
        }

        leaseToRelease = {
            lockedBy: before.leaseOwnerId,
            updatedAt: currentLease.updatedAt,
        };
    }

    if (before.localLock) {
        const removed = await removeLocalProcessLockIfOwned(
            path.join(
                /* turbopackIgnore: true */ sessionDir,
                ".gateway.lock"
            ),
            { ownerId: holder.ownerId, pid: holder.pid }
        );

        if (!removed) {
            return false;
        }
    }

    if (leaseToRelease) {
        const released = await releaseStaleWhatsAppGatewayLease({
            lockedBy: leaseToRelease.lockedBy,
            updatedAt: leaseToRelease.updatedAt,
            now: options.now,
        });

        if (!released) {
            return false;
        }
    }

    const after = await inspectWhatsAppGatewayLock(sessionDir, options.now);
    return !after.held;
}
