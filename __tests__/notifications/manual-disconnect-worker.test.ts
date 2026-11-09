jest.mock("@/lib/notifications/queue", () => ({
    claimDueDeliveries: jest.fn(),
    computeRetryDelayMs: jest.fn(() => 60_000),
    countWhatsAppSendsToday: jest.fn(),
    markDeliverySent: jest.fn(),
    markDeliverySkipped: jest.fn(),
    markDeliverySimulated: jest.fn(),
    recoverExpiredDeliveryLeases: jest.fn(),
    recordDeliveryFailure: jest.fn(),
}));
jest.mock("@/lib/notifications/worker-lock", () => ({
    acquireNotificationWorkerLease: jest.fn(async () => true),
    releaseNotificationWorkerLease: jest.fn(async () => undefined),
    renewNotificationWorkerLease: jest.fn(async () => undefined),
    NOTIFICATION_WORKER_LOCK: "notification-dispatch",
}));

import { resolveNotificationConfig } from "@/lib/notifications/config";
import {
    claimDueDeliveries,
    countWhatsAppSendsToday,
    markDeliverySkipped,
    recoverExpiredDeliveryLeases,
} from "@/lib/notifications/queue";
import { PHASE_1_DRY_RUN_TEMPLATE_KEY } from "@/lib/notifications/templates";
import type { ClaimedDelivery } from "@/lib/notifications/queue";
import { processNotificationBatch } from "@/lib/notifications/worker";

const claimMock = claimDueDeliveries as jest.Mock;
const countMock = countWhatsAppSendsToday as jest.Mock;
const skipMock = markDeliverySkipped as jest.Mock;
const recoverMock = recoverExpiredDeliveryLeases as jest.Mock;

const emailDelivery: ClaimedDelivery = {
    id: "email-1",
    notificationId: 1,
    channel: "EMAIL",
    attemptCount: 1,
    maxAttempts: 3,
    recipient: "ops@example.test",
    templateKey: PHASE_1_DRY_RUN_TEMPLATE_KEY,
    category: "SYSTEM",
    payload: "{}",
};

const whatsappDelivery: ClaimedDelivery = {
    id: "wa-1",
    notificationId: 2,
    channel: "WHATSAPP",
    attemptCount: 1,
    maxAttempts: 3,
    recipient: "08123456789",
    templateKey: "ticket-issued.v1",
    category: "SYSTEM",
    payload: "{}",
};

beforeEach(() => {
    jest.clearAllMocks();
    recoverMock.mockResolvedValue(0);
    claimMock.mockImplementation(async (options: { channels?: string[] }) =>
        options.channels?.includes("WHATSAPP") ? [whatsappDelivery] : [emailDelivery]
    );
});

test("manual disconnect skips WhatsApp as terminal SKIPPED while email still sends", async () => {
    const send = jest.fn(async () => ({
        simulated: false as const,
        providerMessageId: "smtp-1",
    }));
    const transport = {
        name: "test",
        kind: "dry-run" as const,
        send,
    };

    const summary = await processNotificationBatch({
        config: resolveNotificationConfig({ NOTIFICATIONS_ENABLED: "true" }),
        isWhatsAppManuallyDisconnected: async () => true,
        transports: { email: transport, whatsapp: transport },
        log: () => undefined,
        wait: async () => undefined,
    });

    expect(summary).toMatchObject({
        ran: true,
        claimed: 2,
        sent: 1,
        skipped: 1,
        failed: 0,
    });

    expect(skipMock).toHaveBeenCalledWith(
        "wa-1",
        expect.objectContaining({ code: "gateway_disconnected_manual" })
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ to: "ops@example.test" }),
        expect.objectContaining({ deliveryId: "email-1" })
    );
    expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ to: "08123456789" }),
        expect.anything()
    );
    expect(countMock).not.toHaveBeenCalled();
});
