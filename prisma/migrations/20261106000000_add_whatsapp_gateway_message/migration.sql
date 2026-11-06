-- PHASE P2 — WHATSAPP GATEWAY CORE (additive).
--
-- This table is the gateway's durable idempotency/reconciliation ledger. It is NOT a
-- notification queue: NotificationDelivery remains the source of truth for delivery status
-- and the gateway never writes that table. No phone number, JID or message body is stored;
-- `recipientHash` is a keyed SHA-256 used only to correlate one dispatch.
--
-- `deliveryId` is UNIQUE, so a worker retry after a lost HTTP response cannot cause a second
-- socket send. `messageId` is unique when present, so a provider message id can be resolved
-- back to exactly one dispatch. AMBIGUOUS is terminal until an explicit reconciliation.

CREATE TABLE `whatsappgatewaymessage` (
    `id` VARCHAR(191) NOT NULL,
    `deliveryId` VARCHAR(191) NOT NULL,
    `notificationId` INTEGER NOT NULL,
    `recipientHash` VARCHAR(64) NOT NULL,
    `state` ENUM('PENDING', 'SENDING', 'SENT', 'FAILED_BEFORE_SEND', 'AMBIGUOUS') NOT NULL DEFAULT 'PENDING',
    `messageId` VARCHAR(191) NULL,
    `ackStatus` ENUM('NONE', 'ACCEPTED', 'DELIVERED', 'READ', 'FAILED') NOT NULL DEFAULT 'NONE',
    `ackAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `readAt` DATETIME(3) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `leaseUntil` DATETIME(3) NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorMessage` TEXT NULL,
    `reconciledAt` DATETIME(3) NULL,
    `reconciliationNote` VARCHAR(300) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `whatsappgatewaymessage_deliveryId_key` (`deliveryId`),
    UNIQUE INDEX `whatsappgatewaymessage_messageId_key` (`messageId`),
    INDEX `whatsappgatewaymessage_state_leaseUntil_idx` (`state`, `leaseUntil`),
    INDEX `whatsappgatewaymessage_expiresAt_idx` (`expiresAt`),
    INDEX `whatsappgatewaymessage_ackStatus_idx` (`ackStatus`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
