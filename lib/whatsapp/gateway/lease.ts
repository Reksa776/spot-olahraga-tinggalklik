import type { PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Database single-owner lease, reusing the existing `joblock` row pattern.
 *
 * It is acquired BEFORE the socket is opened and renewed on a timer. A lost renewal is a
 * fencing event: the gateway closes the socket and stops rather than continue as a second
 * owner. The unique `joblock.name` primary key is what makes the conditional UPDATE a
 * single-winner operation across processes and hosts.
 */
export const WHATSAPP_GATEWAY_LEASE_NAME = "whatsapp-gateway";

export type GatewayLeaseStatus = "OK" | "FAILED" | "CONFLICT";

type LeaseDb = Pick<PrismaClient, "jobLock">;

export async function acquireWhatsAppGatewayLease(options: {
    lockedBy: string;
    now?: Date;
    leaseMs: number;
    db?: LeaseDb;
}): Promise<boolean> {
    const now = options.now ?? new Date();
    const db = options.db ?? prisma;

    await db.jobLock.upsert({
        where: { name: WHATSAPP_GATEWAY_LEASE_NAME },
        create: { name: WHATSAPP_GATEWAY_LEASE_NAME },
        update: {},
    });

    const claimed = await db.jobLock.updateMany({
        where: {
            name: WHATSAPP_GATEWAY_LEASE_NAME,
            OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
        },
        data: {
            lockedUntil: new Date(now.getTime() + options.leaseMs),
            lockedBy: options.lockedBy,
            lastStatus: "OK",
        },
    });

    return claimed.count === 1;
}

export async function renewWhatsAppGatewayLease(options: {
    lockedBy: string;
    now?: Date;
    leaseMs: number;
    db?: LeaseDb;
}): Promise<boolean> {
    const now = options.now ?? new Date();
    const db = options.db ?? prisma;

    const renewed = await db.jobLock.updateMany({
        where: {
            name: WHATSAPP_GATEWAY_LEASE_NAME,
            lockedBy: options.lockedBy,
        },
        data: {
            lockedUntil: new Date(now.getTime() + options.leaseMs),
            lastStatus: "OK",
        },
    });

    return renewed.count === 1;
}

export async function releaseWhatsAppGatewayLease(options: {
    lockedBy: string;
    status?: GatewayLeaseStatus;
    now?: Date;
    db?: LeaseDb;
}): Promise<void> {
    const now = options.now ?? new Date();
    const db = options.db ?? prisma;

    await db.jobLock.updateMany({
        where: {
            name: WHATSAPP_GATEWAY_LEASE_NAME,
            lockedBy: options.lockedBy,
        },
        data: {
            lockedUntil: null,
            lockedBy: null,
            lastRunAt: now,
            lastStatus: options.status ?? "OK",
        },
    });
}

export async function readWhatsAppGatewayLease(
    db: LeaseDb = prisma
) {
    return db.jobLock.findUnique({
        where: { name: WHATSAPP_GATEWAY_LEASE_NAME },
    });
}
