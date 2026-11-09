import { AppError } from "@/lib/api/errors";
import type { AuthzScope } from "@/lib/authz/permissions";
import { writeTicketingAudit } from "@/lib/ticketing/audit-log";
import {
    isWhatsAppManuallyDisconnected,
    setWhatsAppManualDisconnect,
} from "@/lib/whatsapp/manual-disconnect";

import type { WhatsAppGateway } from "./gateway";
import {
    inspectWhatsAppGatewayLock,
    toWhatsAppGatewayLockStatus,
    type WhatsAppGatewayLockStatus,
    type WhatsAppLockHolder,
} from "./lock-inspection";

export type WhatsAppConnectSource = "connect" | "pairing";

export type WhatsAppConnectOutcome = {
    status: "PAIRING_STARTED" | "CONNECTED";
    pairingStarted: boolean;
    manualDisconnect: false;
    qr: string | null;
    expiresAt: string | null;
};

type ConnectDependencies = {
    readManualDisconnect?: () => Promise<boolean>;
    setManualDisconnect?: (value: boolean) => Promise<void>;
    inspectLock?: typeof inspectWhatsAppGatewayLock;
    audit?: typeof writeTicketingAudit;
};

const GATEWAY_NOT_READY_MESSAGE =
    "WhatsApp gateway belum siap. Periksa WA_GATEWAY_ENABLED dan konfigurasi server.";

/*
 * The process name is operator-supplied, not a PM2 app name: the deployment may run the
 * gateway under systemd or a differently named PM2 process. The holder details in the
 * response tell the operator which process to stop.
 */
const LOCK_HELD_MESSAGE =
    "Gateway lain masih memegang koneksi. Hentikan proses gateway lama di host yang ditampilkan, lalu coba lagi.";

async function lockDetails(
    gateway: WhatsAppGateway,
    inspectLock: typeof inspectWhatsAppGatewayLock
): Promise<{
    lock: WhatsAppGatewayLockStatus | null;
    lockHolder: WhatsAppLockHolder | null;
}> {
    try {
        const lock = toWhatsAppGatewayLockStatus(
            await inspectLock(gateway.sessionDirectory)
        );

        return { lock, lockHolder: lock.holder };
    } catch {
        // The conflict is still real when diagnostics cannot be read. The operator
        // gets the stable conflict message and can refresh the status panel.
        return { lock: null, lockHolder: null };
    }
}

/**
 * Clear the persisted manual-disconnect latch and start the QR pairing flow.
 *
 * The latch is cleared BEFORE pairing because the gateway refuses to acquire ownership
 * while it is latched. It is deliberately NOT restored when pairing fails: the operator
 * must be able to retry from the dashboard without editing MySQL, and the gateway's
 * in-memory latch still prevents an unintended automatic reconnect until this action is
 * invoked again. The connect intent is audited before the socket work starts, so a failed
 * start is still attributable.
 */
export async function connectWhatsAppGateway(options: {
    gateway: WhatsAppGateway | null;
    actor: AuthzScope;
    request: Request;
    source?: WhatsAppConnectSource;
    dependencies?: ConnectDependencies;
}): Promise<WhatsAppConnectOutcome> {
    const readManualDisconnect =
        options.dependencies?.readManualDisconnect ??
        isWhatsAppManuallyDisconnected;
    const setManualDisconnect =
        options.dependencies?.setManualDisconnect ?? setWhatsAppManualDisconnect;
    const inspectLock =
        options.dependencies?.inspectLock ?? inspectWhatsAppGatewayLock;
    const audit = options.dependencies?.audit ?? writeTicketingAudit;
    const source = options.source ?? "connect";
    const gateway = options.gateway;

    if (!gateway) {
        throw AppError.conflict(GATEWAY_NOT_READY_MESSAGE);
    }

    const previousLatch = await readManualDisconnect();

    await setManualDisconnect(false);

    await audit({
        action: "whatsapp.connect",
        actor: options.actor,
        entityType: "PlatformSetting",
        entityRef: "whatsapp-gateway",
        description:
            "Operator menghubungkan ulang WhatsApp dan mereset manual disconnect.",
        beforeState: { manualDisconnect: previousLatch },
        afterState: { manualDisconnect: false, source },
        request: options.request,
    });

    try {
        const result = await gateway.beginPairing();
        const snapshot = gateway.snapshot();

        if (snapshot.state === "CONFLICT" || !snapshot.ownershipHeld) {
            throw new AppError("CONFLICT", {
                message: LOCK_HELD_MESSAGE,
                details: await lockDetails(gateway, inspectLock),
            });
        }

        if (snapshot.connected) {
            return {
                status: "CONNECTED",
                pairingStarted: false,
                manualDisconnect: false,
                qr: null,
                expiresAt: null,
            };
        }

        if (!result.started) {
            throw new AppError("SERVICE_UNAVAILABLE", {
                message:
                    "Pairing WhatsApp gagal dimulai. Periksa log gateway lalu coba lagi.",
            });
        }

        const pairing = gateway.pairingStatus();

        return {
            status: "PAIRING_STARTED",
            pairingStarted: true,
            manualDisconnect: false,
            qr: pairing.qr,
            expiresAt: pairing.expiresAt,
        };
    } catch (error) {
        /*
         * Close a partially opened socket, but leave the DB latch false. The next click
         * on "Coba lagi" can therefore retry without any manual database reset.
         */
        await gateway.disconnect().catch(() => undefined);
        throw error;
    }
}

