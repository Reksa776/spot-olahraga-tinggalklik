-- AlterTable
ALTER TABLE `user` ADD COLUMN `platformRole` ENUM('CUSTOMER', 'ADMIN', 'MANAGER', 'PIC') NULL;

-- AlterTable
ALTER TABLE `notification` ADD COLUMN `category` ENUM('ORDER', 'PAYMENT', 'TICKET', 'CHECKIN', 'REFUND', 'PIC_FEE', 'SETTLEMENT', 'SYSTEM') NULL,
    ADD COLUMN `eventId` VARCHAR(191) NULL,
    ADD COLUMN `eventOrderId` VARCHAR(191) NULL,
    ADD COLUMN `organizerId` VARCHAR(191) NULL,
    ADD COLUMN `picProfileId` VARCHAR(191) NULL,
    ADD COLUMN `priority` INTEGER NULL,
    ADD COLUMN `recipientType` ENUM('CUSTOMER', 'PIC', 'ADMIN', 'MANAGER', 'ORGANIZER_STAFF') NULL,
    ADD COLUMN `templateKey` VARCHAR(191) NULL,
    ADD COLUMN `ticketId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `adminauditlog` ADD COLUMN `actorOrganizerId` VARCHAR(191) NULL,
    ADD COLUMN `actorRole` VARCHAR(191) NULL,
    ADD COLUMN `actorType` ENUM('USER', 'SYSTEM', 'PROVIDER', 'ADMIN', 'PIC', 'MANAGER') NULL,
    ADD COLUMN `actorUserId` VARCHAR(191) NULL,
    ADD COLUMN `afterState` JSON NULL,
    ADD COLUMN `beforeState` JSON NULL,
    ADD COLUMN `correlationId` VARCHAR(191) NULL,
    ADD COLUMN `entityRef` VARCHAR(191) NULL,
    ADD COLUMN `ipAddress` VARCHAR(191) NULL,
    ADD COLUMN `organizerId` VARCHAR(191) NULL,
    ADD COLUMN `reason` TEXT NULL,
    ADD COLUMN `userAgent` VARCHAR(191) NULL;

-- Collation alignment for `adminauditlog` (pre-existing environment defect).
--
-- `adminauditlog` is the only table in this database whose collation is not
-- `utf8mb4_unicode_ci` (it is `utf8mb4_0900_ai_ci`), while the database default
-- is `utf8mb4_uca1400_ai_ci` and the other 69 tables are `utf8mb4_unicode_ci`.
-- MySQL requires the referencing and referenced columns of a foreign key to
-- share a character set + collation, so without this the three foreign keys
-- added at the end of this migration fail with errno 150
-- ("Foreign key constraint is incorrectly formed").
--
-- The three columns modified here are NEW, nullable and empty - they were
-- created by the statement immediately above - so this rewrites no existing
-- data, changes no retail behaviour and alters no pre-existing column. The
-- table default is aligned for the same reason, so that future columns added
-- to this table do not reintroduce the mismatch. The JSON columns are
-- deliberately left as `utf8mb4_bin`.
ALTER TABLE `adminauditlog` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `adminauditlog`
    MODIFY COLUMN `actorOrganizerId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    MODIFY COLUMN `actorUserId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    MODIFY COLUMN `organizerId` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL;

-- AlterTable
ALTER TABLE `refund` ADD COLUMN `approvedAt` DATETIME(3) NULL,
    ADD COLUMN `approvedByUserId` VARCHAR(191) NULL,
    ADD COLUMN `eventOrderId` VARCHAR(191) NULL,
    ADD COLUMN `feeTreatment` ENUM('REVERSED', 'RETAINED', 'ADJUSTED') NULL,
    ADD COLUMN `idempotencyKey` VARCHAR(191) NULL,
    ADD COLUMN `organizerId` VARCHAR(191) NULL,
    ADD COLUMN `refundNumber` VARCHAR(191) NULL,
    ADD COLUMN `requestedByRole` VARCHAR(191) NULL,
    ADD COLUMN `requestedByUserId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `organizer` (
    `id` VARCHAR(191) NOT NULL,
    `ownerUserId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `logoUrl` TEXT NULL,
    `phone` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'ARCHIVED') NOT NULL DEFAULT 'PENDING',
    `verifiedAt` DATETIME(3) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `suspendReason` TEXT NULL,
    `commissionRateBp` INTEGER NOT NULL DEFAULT 0,
    `defaultPicFeeRateBp` INTEGER NOT NULL DEFAULT 0,
    `bankName` VARCHAR(191) NULL,
    `bankAccountName` VARCHAR(191) NULL,
    `bankAccountNumber` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `organizer_slug_key`(`slug`),
    INDEX `organizer_status_idx`(`status`),
    INDEX `organizer_ownerUserId_idx`(`ownerUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `organizermember` (
    `id` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'MANAGER', 'FINANCE', 'PIC', 'CHECKIN_STAFF') NOT NULL,
    `status` ENUM('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED') NOT NULL DEFAULT 'INVITED',
    `invitedByUserId` VARCHAR(191) NULL,
    `invitedAt` DATETIME(3) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `organizermember_userId_status_idx`(`userId`, `status`),
    INDEX `organizermember_organizerId_role_idx`(`organizerId`, `role`),
    UNIQUE INDEX `organizermember_organizerId_userId_key`(`organizerId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staffeventassignment` (
    `id` VARCHAR(191) NOT NULL,
    `organizerMemberId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `assignedByUserId` VARCHAR(191) NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `staffeventassignment_eventId_revokedAt_idx`(`eventId`, `revokedAt`),
    INDEX `staffeventassignment_organizerId_idx`(`organizerId`),
    UNIQUE INDEX `staffeventassignment_organizerMemberId_eventId_key`(`organizerMemberId`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissiongrant` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NULL,
    `permission` VARCHAR(191) NOT NULL,
    `grantedByUserId` VARCHAR(191) NOT NULL,
    `grantedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `revokedByUserId` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `permissiongrant_userId_permission_idx`(`userId`, `permission`),
    UNIQUE INDEX `permissiongrant_userId_organizerId_permission_key`(`userId`, `organizerId`, `permission`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sport` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `iconUrl` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sport_slug_key`(`slug`),
    INDEX `sport_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `venue` (
    `id` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `address` TEXT NULL,
    `city` VARCHAR(191) NULL,
    `province` VARCHAR(191) NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `capacity` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `venue_organizerId_idx`(`organizerId`),
    INDEX `venue_city_name_idx`(`city`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event` (
    `id` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `sportId` VARCHAR(191) NOT NULL,
    `venueId` VARCHAR(191) NULL,
    `title` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `shareCode` VARCHAR(191) NULL,
    `eventCode` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `rules` TEXT NULL,
    `bannerUrl` TEXT NULL,
    `status` ENUM('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'ONGOING', 'COMPLETED', 'CANCELLED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `visibility` ENUM('PUBLIC', 'UNLISTED', 'PRIVATE') NOT NULL DEFAULT 'PUBLIC',
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NULL,
    `salesStartAt` DATETIME(3) NULL,
    `salesEndAt` DATETIME(3) NULL,
    `timezone` VARCHAR(191) NOT NULL DEFAULT 'Asia/Jakarta',
    `maxTicketsPerOrder` INTEGER NULL,
    `requiresCheckIn` BOOLEAN NOT NULL DEFAULT true,
    `returnQuotaOnRefund` BOOLEAN NOT NULL DEFAULT false,
    `refundDeadlineAt` DATETIME(3) NULL,
    `contactName` VARCHAR(191) NULL,
    `contactPhone` VARCHAR(191) NULL,
    `publishedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` TEXT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdByUserId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `event_slug_key`(`slug`),
    UNIQUE INDEX `event_shareCode_key`(`shareCode`),
    UNIQUE INDEX `event_eventCode_key`(`eventCode`),
    INDEX `event_status_visibility_startAt_idx`(`status`, `visibility`, `startAt`),
    INDEX `event_organizerId_status_startAt_idx`(`organizerId`, `status`, `startAt`),
    INDEX `event_sportId_status_startAt_idx`(`sportId`, `status`, `startAt`),
    INDEX `event_venueId_idx`(`venueId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `eventimage` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `url` TEXT NOT NULL,
    `altText` VARCHAR(191) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `eventimage_eventId_sortOrder_idx`(`eventId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tickettype` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `price` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `quota` INTEGER NOT NULL,
    `sold` INTEGER NOT NULL DEFAULT 0,
    `reserved` INTEGER NOT NULL DEFAULT 0,
    `minPerOrder` INTEGER NOT NULL DEFAULT 1,
    `maxPerOrder` INTEGER NULL,
    `salesStartAt` DATETIME(3) NULL,
    `salesEndAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `tickettype_eventId_isActive_sortOrder_idx`(`eventId`, `isActive`, `sortOrder`),
    INDEX `tickettype_eventId_salesStartAt_salesEndAt_idx`(`eventId`, `salesStartAt`, `salesEndAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ticketreservation` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `ticketTypeId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `status` ENUM('HELD', 'CONVERTED', 'RELEASED', 'EXPIRED') NOT NULL DEFAULT 'HELD',
    `expiresAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ticketreservation_status_expiresAt_idx`(`status`, `expiresAt`),
    INDEX `ticketreservation_orderId_idx`(`orderId`),
    INDEX `ticketreservation_ticketTypeId_status_idx`(`ticketTypeId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `eventorder` (
    `id` VARCHAR(191) NOT NULL,
    `orderNumber` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `buyerName` VARCHAR(191) NOT NULL,
    `buyerEmail` VARCHAR(191) NULL,
    `buyerPhone` VARCHAR(191) NULL,
    `status` ENUM('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED') NOT NULL DEFAULT 'PENDING_PAYMENT',
    `paymentStatus` ENUM('UNPAID', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED') NOT NULL DEFAULT 'UNPAID',
    `subtotal` DECIMAL(14, 2) NOT NULL,
    `discount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `platformFee` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `gatewayFee` DECIMAL(14, 2) NULL,
    `picFeeTotal` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(14, 2) NOT NULL,
    `organizerNetAmount` DECIMAL(14, 2) NOT NULL,
    `refundedAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `picProfileId` VARCHAR(191) NULL,
    `couponId` VARCHAR(191) NULL,
    `couponCode` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` TEXT NULL,
    `fulfilmentBlockedAt` DATETIME(3) NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `eventorder_orderNumber_key`(`orderNumber`),
    INDEX `eventorder_userId_createdAt_idx`(`userId`, `createdAt`),
    INDEX `eventorder_organizerId_status_createdAt_idx`(`organizerId`, `status`, `createdAt`),
    INDEX `eventorder_eventId_status_idx`(`eventId`, `status`),
    INDEX `eventorder_status_expiresAt_idx`(`status`, `expiresAt`),
    INDEX `eventorder_paymentStatus_idx`(`paymentStatus`),
    INDEX `eventorder_picProfileId_idx`(`picProfileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `eventorderitem` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `ticketTypeId` VARCHAR(191) NULL,
    `nameSnapshot` VARCHAR(191) NOT NULL,
    `priceSnapshot` DECIMAL(14, 2) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `subtotal` DECIMAL(14, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `eventorderitem_orderId_idx`(`orderId`),
    INDEX `eventorderitem_ticketTypeId_idx`(`ticketTypeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ticket` (
    `id` VARCHAR(191) NOT NULL,
    `ticketCode` VARCHAR(191) NOT NULL,
    `qrTokenHash` VARCHAR(191) NOT NULL,
    `qrVersion` INTEGER NOT NULL DEFAULT 1,
    `orderId` VARCHAR(191) NOT NULL,
    `orderItemId` VARCHAR(191) NOT NULL,
    `sequenceNo` INTEGER NOT NULL,
    `ticketTypeId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `holderUserId` VARCHAR(191) NULL,
    `attendeeName` VARCHAR(191) NULL,
    `attendeeEmail` VARCHAR(191) NULL,
    `attendeePhone` VARCHAR(191) NULL,
    `seatLabel` VARCHAR(191) NULL,
    `status` ENUM('RESERVED', 'ISSUED', 'CHECKED_IN', 'VOID', 'REFUNDED') NOT NULL DEFAULT 'RESERVED',
    `issuedAt` DATETIME(3) NULL,
    `checkedInAt` DATETIME(3) NULL,
    `refundedAt` DATETIME(3) NULL,
    `voidedAt` DATETIME(3) NULL,
    `voidReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ticket_ticketCode_key`(`ticketCode`),
    UNIQUE INDEX `ticket_qrTokenHash_key`(`qrTokenHash`),
    INDEX `ticket_eventId_status_idx`(`eventId`, `status`),
    INDEX `ticket_organizerId_status_idx`(`organizerId`, `status`),
    INDEX `ticket_holderUserId_status_idx`(`holderUserId`, `status`),
    INDEX `ticket_ticketTypeId_status_idx`(`ticketTypeId`, `status`),
    INDEX `ticket_eventId_checkedInAt_idx`(`eventId`, `checkedInAt`),
    UNIQUE INDEX `ticket_orderItemId_sequenceNo_key`(`orderItemId`, `sequenceNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checkin` (
    `id` VARCHAR(191) NOT NULL,
    `ticketId` VARCHAR(191) NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `checkedInAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `checkedInByUserId` VARCHAR(191) NOT NULL,
    `checkedInByMemberId` VARCHAR(191) NULL,
    `method` ENUM('QR_SCAN', 'MANUAL') NOT NULL,
    `gateLabel` VARCHAR(191) NULL,
    `deviceId` VARCHAR(191) NULL,
    `clientScannedAt` DATETIME(3) NULL,
    `ipAddress` VARCHAR(191) NULL,
    `result` ENUM('SUCCESS', 'DUPLICATE', 'ALREADY_CHECKED_IN', 'INVALID_TICKET', 'WRONG_EVENT', 'UNPAID', 'TICKET_NOT_FOUND') NOT NULL,
    `note` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `checkin_ticketId_key`(`ticketId`),
    INDEX `checkin_eventId_checkedInAt_idx`(`eventId`, `checkedInAt`),
    INDEX `checkin_checkedInByUserId_checkedInAt_idx`(`checkedInByUserId`, `checkedInAt`),
    INDEX `checkin_organizerId_checkedInAt_idx`(`organizerId`, `checkedInAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL DEFAULT 'ipaymu',
    `providerEnvironment` ENUM('SANDBOX', 'PRODUCTION') NOT NULL,
    `method` ENUM('BANK_TRANSFER', 'VIRTUAL_ACCOUNT', 'QRIS', 'E_WALLET', 'CREDIT_CARD', 'RETAIL_OUTLET', 'COD', 'OTHER') NOT NULL,
    `channel` VARCHAR(191) NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `status` ENUM('UNPAID', 'PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED', 'PARTIALLY_REFUNDED') NOT NULL DEFAULT 'UNPAID',
    `externalSessionId` VARCHAR(191) NULL,
    `paymentReference` VARCHAR(191) NOT NULL,
    `paymentUrl` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payment_paymentReference_key`(`paymentReference`),
    INDEX `payment_orderId_status_idx`(`orderId`, `status`),
    INDEX `payment_organizerId_status_idx`(`organizerId`, `status`),
    INDEX `payment_status_expiresAt_idx`(`status`, `expiresAt`),
    INDEX `payment_externalSessionId_idx`(`externalSessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `paymenttransaction` (
    `id` VARCHAR(191) NOT NULL,
    `paymentId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerTransactionId` VARCHAR(191) NULL,
    `type` ENUM('PAYMENT', 'REFUND', 'CHARGEBACK', 'FEE', 'ADJUSTMENT') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `providerFee` DECIMAL(14, 2) NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `status` VARCHAR(191) NOT NULL,
    `rawSummary` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `paymenttransaction_providerTransactionId_idx`(`providerTransactionId`),
    INDEX `paymenttransaction_paymentId_idx`(`paymentId`),
    INDEX `paymenttransaction_orderId_createdAt_idx`(`orderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhookevent` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(191) NOT NULL,
    `providerEventId` VARCHAR(191) NOT NULL,
    `providerTransactionId` VARCHAR(191) NULL,
    `eventType` VARCHAR(191) NOT NULL,
    `statusCode` VARCHAR(191) NULL,
    `amountReported` DECIMAL(14, 2) NULL,
    `payloadHash` VARCHAR(191) NOT NULL,
    `payloadJson` JSON NULL,
    `signatureValid` BOOLEAN NOT NULL DEFAULT false,
    `orderId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NULL,
    `processingStatus` ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
    `processingResult` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `remoteIp` VARCHAR(191) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `webhookevent_providerEventId_key`(`providerEventId`),
    INDEX `webhookevent_provider_receivedAt_idx`(`provider`, `receivedAt`),
    INDEX `webhookevent_processingStatus_receivedAt_idx`(`processingStatus`, `receivedAt`),
    INDEX `webhookevent_orderId_receivedAt_idx`(`orderId`, `receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `picprofile` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `picCode` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `defaultFeeRateBp` INTEGER NOT NULL DEFAULT 0,
    `canSellAllEvents` BOOLEAN NOT NULL DEFAULT false,
    `bankName` VARCHAR(191) NULL,
    `bankAccountName` VARCHAR(191) NULL,
    `bankAccountNumber` VARCHAR(191) NULL,
    `taxId` VARCHAR(191) NULL,
    `identityNote` TEXT NULL,
    `approvedByUserId` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `suspendReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `picprofile_userId_key`(`userId`),
    UNIQUE INDEX `picprofile_picCode_key`(`picCode`),
    INDEX `picprofile_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `piceventassignment` (
    `id` VARCHAR(191) NOT NULL,
    `picProfileId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `feeRateBp` INTEGER NULL,
    `feeTypeOverride` ENUM('PERCENTAGE', 'FIXED', 'HYBRID') NULL,
    `assignedByUserId` VARCHAR(191) NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `revokedAt` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `piceventassignment_eventId_isActive_idx`(`eventId`, `isActive`),
    INDEX `piceventassignment_picProfileId_isActive_idx`(`picProfileId`, `isActive`),
    INDEX `piceventassignment_organizerId_idx`(`organizerId`),
    UNIQUE INDEX `piceventassignment_picProfileId_eventId_key`(`picProfileId`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `picattribution` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `picProfileId` VARCHAR(191) NOT NULL,
    `source` ENUM('ORGANIC', 'PIC_LINK', 'PIC_CODE', 'EVENT_PAGE_ATTRIBUTED', 'ADMIN_ASSIGNED') NOT NULL,
    `method` ENUM('LINK', 'QR', 'MANUAL') NULL,
    `shareToken` VARCHAR(191) NULL,
    `firstTouchAt` DATETIME(3) NULL,
    `lastTouchAt` DATETIME(3) NULL,
    `capturedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isFinal` BOOLEAN NOT NULL DEFAULT false,
    `finalizedAt` DATETIME(3) NULL,
    `selfReferral` BOOLEAN NOT NULL DEFAULT false,
    `overriddenByUserId` VARCHAR(191) NULL,
    `overrideReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `picattribution_orderId_key`(`orderId`),
    INDEX `picattribution_picProfileId_createdAt_idx`(`picProfileId`, `createdAt`),
    INDEX `picattribution_eventId_createdAt_idx`(`eventId`, `createdAt`),
    INDEX `picattribution_organizerId_createdAt_idx`(`organizerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `picfeeledger` (
    `id` VARCHAR(191) NOT NULL,
    `picProfileId` VARCHAR(191) NOT NULL,
    `organizerId` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `orderItemId` VARCHAR(191) NULL,
    `ticketTypeId` VARCHAR(191) NULL,
    `attributionId` VARCHAR(191) NULL,
    `type` ENUM('EARLY_ACCRUAL', 'EARNED', 'EARNED_ADJUSTMENT', 'REVERSAL', 'PAYOUT', 'ADJUSTMENT') NOT NULL,
    `direction` ENUM('CREDIT', 'DEBIT') NOT NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `feeType` ENUM('PERCENTAGE', 'FIXED', 'HYBRID') NOT NULL,
    `rateBp` INTEGER NULL,
    `fixedAmount` DECIMAL(14, 2) NULL,
    `basisType` ENUM('GROSS_BEFORE_DISCOUNT', 'GROSS_AFTER_DISCOUNT', 'NET_AFTER_GATEWAY') NOT NULL,
    `basisAmount` DECIMAL(14, 2) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `status` ENUM('PENDING', 'EARNED', 'PAYABLE', 'APPROVED', 'SETTLED', 'VOID') NOT NULL DEFAULT 'EARNED',
    `refundId` INTEGER NULL,
    `settlementId` VARCHAR(191) NULL,
    `adjustmentReason` TEXT NULL,
    `createdByUserId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `picfeeledger_idempotencyKey_key`(`idempotencyKey`),
    INDEX `picfeeledger_picProfileId_status_createdAt_idx`(`picProfileId`, `status`, `createdAt`),
    INDEX `picfeeledger_organizerId_createdAt_idx`(`organizerId`, `createdAt`),
    INDEX `picfeeledger_eventId_createdAt_idx`(`eventId`, `createdAt`),
    INDEX `picfeeledger_orderId_idx`(`orderId`),
    INDEX `picfeeledger_settlementId_idx`(`settlementId`),
    UNIQUE INDEX `picfeeledger_orderItemId_type_key`(`orderItemId`, `type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settlement` (
    `id` VARCHAR(191) NOT NULL,
    `settlementNumber` VARCHAR(191) NOT NULL,
    `payeeType` ENUM('PIC', 'ORGANIZER') NOT NULL,
    `picProfileId` VARCHAR(191) NULL,
    `organizerId` VARCHAR(191) NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `grossAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `deductionAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `netAmount` DECIMAL(14, 2) NOT NULL,
    `currency` VARCHAR(191) NOT NULL DEFAULT 'IDR',
    `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `method` ENUM('MANUAL_TRANSFER', 'GATEWAY_SPLIT') NOT NULL,
    `bankName` VARCHAR(191) NULL,
    `bankAccountName` VARCHAR(191) NULL,
    `bankAccountNumber` VARCHAR(191) NULL,
    `providerReference` VARCHAR(191) NULL,
    `providerStatus` VARCHAR(191) NULL,
    `proofFilePath` VARCHAR(191) NULL,
    `preparedByUserId` VARCHAR(191) NOT NULL,
    `preparedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `approvedByUserId` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `paidByUserId` VARCHAR(191) NULL,
    `paidAt` DATETIME(3) NULL,
    `failureReason` TEXT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `settlement_settlementNumber_key`(`settlementNumber`),
    INDEX `settlement_payeeType_picProfileId_status_idx`(`payeeType`, `picProfileId`, `status`),
    INDEX `settlement_organizerId_status_idx`(`organizerId`, `status`),
    INDEX `settlement_status_createdAt_idx`(`status`, `createdAt`),
    UNIQUE INDEX `settlement_payeeType_picProfileId_periodStart_periodEnd_key`(`payeeType`, `picProfileId`, `periodStart`, `periodEnd`),
    UNIQUE INDEX `settlement_payeeType_organizerId_periodStart_periodEnd_key`(`payeeType`, `organizerId`, `periodStart`, `periodEnd`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settlementitem` (
    `id` VARCHAR(191) NOT NULL,
    `settlementId` VARCHAR(191) NOT NULL,
    `picFeeLedgerId` VARCHAR(191) NULL,
    `orderId` VARCHAR(191) NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `direction` ENUM('CREDIT', 'DEBIT') NOT NULL,
    `description` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `settlementitem_picFeeLedgerId_key`(`picFeeLedgerId`),
    INDEX `settlementitem_settlementId_idx`(`settlementId`),
    INDEX `settlementitem_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refunditem` (
    `id` VARCHAR(191) NOT NULL,
    `refundId` INTEGER NOT NULL,
    `ticketId` VARCHAR(191) NOT NULL,
    `orderItemId` VARCHAR(191) NULL,
    `amount` DECIMAL(14, 2) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `refunditem_ticketId_key`(`ticketId`),
    INDEX `refunditem_refundId_idx`(`refundId`),
    INDEX `refunditem_orderItemId_idx`(`orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notificationdelivery` (
    `id` VARCHAR(191) NOT NULL,
    `notificationId` INTEGER NOT NULL,
    `channel` ENUM('WHATSAPP', 'EMAIL', 'IN_APP') NOT NULL,
    `provider` VARCHAR(191) NULL,
    `status` ENUM('QUEUED', 'SENDING', 'SENT', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `providerMessageId` VARCHAR(191) NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `queuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `nextRetryAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `notificationdelivery_status_nextRetryAt_idx`(`status`, `nextRetryAt`),
    UNIQUE INDEX `notificationdelivery_notificationId_channel_key`(`notificationId`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotencykey` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `requestHash` VARCHAR(191) NOT NULL,
    `responseRef` VARCHAR(191) NULL,
    `status` ENUM('IN_PROGRESS', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idempotencykey_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `idempotencykey_userId_scope_key_key`(`userId`, `scope`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platformsetting` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `platformName` VARCHAR(191) NOT NULL DEFAULT 'TinggalKlik.Co',
    `logoUrl` TEXT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `defaultPicFeeRateBp` INTEGER NOT NULL DEFAULT 0,
    `defaultPlatformFeeRateBp` INTEGER NOT NULL DEFAULT 0,
    `reservationTtlMinutes` INTEGER NOT NULL DEFAULT 30,
    `exportSyncMaxRows` INTEGER NOT NULL DEFAULT 5000,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `notification_eventOrderId_idx` ON `notification`(`eventOrderId`);

-- CreateIndex
CREATE INDEX `notification_ticketId_idx` ON `notification`(`ticketId`);

-- CreateIndex
CREATE INDEX `notification_organizerId_idx` ON `notification`(`organizerId`);

-- CreateIndex
CREATE INDEX `adminauditlog_actorUserId_idx` ON `adminauditlog`(`actorUserId`);

-- CreateIndex
CREATE INDEX `adminauditlog_organizerId_createdAt_idx` ON `adminauditlog`(`organizerId`, `createdAt`);

-- CreateIndex
CREATE INDEX `adminauditlog_entityType_entityRef_idx` ON `adminauditlog`(`entityType`, `entityRef`);

-- CreateIndex
CREATE UNIQUE INDEX `refund_refundNumber_key` ON `refund`(`refundNumber`);

-- CreateIndex
CREATE UNIQUE INDEX `refund_idempotencyKey_key` ON `refund`(`idempotencyKey`);

-- CreateIndex
CREATE INDEX `refund_organizerId_idx` ON `refund`(`organizerId`);

-- CreateIndex
CREATE INDEX `refund_eventOrderId_idx` ON `refund`(`eventOrderId`);

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `notification_eventOrderId_fkey` FOREIGN KEY (`eventOrderId`) REFERENCES `eventorder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `notification_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `ticket`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `notification_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `notification_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notification` ADD CONSTRAINT `notification_picProfileId_fkey` FOREIGN KEY (`picProfileId`) REFERENCES `picprofile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adminauditlog` ADD CONSTRAINT `adminauditlog_actorOrganizerId_fkey` FOREIGN KEY (`actorOrganizerId`) REFERENCES `organizer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adminauditlog` ADD CONSTRAINT `adminauditlog_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adminauditlog` ADD CONSTRAINT `adminauditlog_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refund` ADD CONSTRAINT `refund_eventOrderId_fkey` FOREIGN KEY (`eventOrderId`) REFERENCES `eventorder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organizer` ADD CONSTRAINT `organizer_ownerUserId_fkey` FOREIGN KEY (`ownerUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organizermember` ADD CONSTRAINT `organizermember_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organizermember` ADD CONSTRAINT `organizermember_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organizermember` ADD CONSTRAINT `organizermember_invitedByUserId_fkey` FOREIGN KEY (`invitedByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `organizermember` ADD CONSTRAINT `organizermember_revokedByUserId_fkey` FOREIGN KEY (`revokedByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staffeventassignment` ADD CONSTRAINT `staffeventassignment_organizerMemberId_fkey` FOREIGN KEY (`organizerMemberId`) REFERENCES `organizermember`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staffeventassignment` ADD CONSTRAINT `staffeventassignment_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staffeventassignment` ADD CONSTRAINT `staffeventassignment_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `staffeventassignment` ADD CONSTRAINT `staffeventassignment_assignedByUserId_fkey` FOREIGN KEY (`assignedByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `permissiongrant` ADD CONSTRAINT `permissiongrant_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `permissiongrant` ADD CONSTRAINT `permissiongrant_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `permissiongrant` ADD CONSTRAINT `permissiongrant_grantedByUserId_fkey` FOREIGN KEY (`grantedByUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `permissiongrant` ADD CONSTRAINT `permissiongrant_revokedByUserId_fkey` FOREIGN KEY (`revokedByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `venue` ADD CONSTRAINT `venue_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event` ADD CONSTRAINT `event_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event` ADD CONSTRAINT `event_sportId_fkey` FOREIGN KEY (`sportId`) REFERENCES `sport`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event` ADD CONSTRAINT `event_venueId_fkey` FOREIGN KEY (`venueId`) REFERENCES `venue`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event` ADD CONSTRAINT `event_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventimage` ADD CONSTRAINT `eventimage_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tickettype` ADD CONSTRAINT `tickettype_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticketreservation` ADD CONSTRAINT `ticketreservation_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticketreservation` ADD CONSTRAINT `ticketreservation_ticketTypeId_fkey` FOREIGN KEY (`ticketTypeId`) REFERENCES `tickettype`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticketreservation` ADD CONSTRAINT `ticketreservation_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventorder` ADD CONSTRAINT `eventorder_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventorder` ADD CONSTRAINT `eventorder_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventorder` ADD CONSTRAINT `eventorder_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventorder` ADD CONSTRAINT `eventorder_picProfileId_fkey` FOREIGN KEY (`picProfileId`) REFERENCES `picprofile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventorderitem` ADD CONSTRAINT `eventorderitem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `eventorderitem` ADD CONSTRAINT `eventorderitem_ticketTypeId_fkey` FOREIGN KEY (`ticketTypeId`) REFERENCES `tickettype`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket` ADD CONSTRAINT `ticket_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket` ADD CONSTRAINT `ticket_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `eventorderitem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket` ADD CONSTRAINT `ticket_ticketTypeId_fkey` FOREIGN KEY (`ticketTypeId`) REFERENCES `tickettype`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket` ADD CONSTRAINT `ticket_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket` ADD CONSTRAINT `ticket_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ticket` ADD CONSTRAINT `ticket_holderUserId_fkey` FOREIGN KEY (`holderUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkin` ADD CONSTRAINT `checkin_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `ticket`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkin` ADD CONSTRAINT `checkin_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkin` ADD CONSTRAINT `checkin_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkin` ADD CONSTRAINT `checkin_checkedInByUserId_fkey` FOREIGN KEY (`checkedInByUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `checkin` ADD CONSTRAINT `checkin_checkedInByMemberId_fkey` FOREIGN KEY (`checkedInByMemberId`) REFERENCES `organizermember`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment` ADD CONSTRAINT `payment_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `paymenttransaction` ADD CONSTRAINT `paymenttransaction_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `paymenttransaction` ADD CONSTRAINT `paymenttransaction_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `paymenttransaction` ADD CONSTRAINT `paymenttransaction_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhookevent` ADD CONSTRAINT `webhookevent_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `webhookevent` ADD CONSTRAINT `webhookevent_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payment`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picprofile` ADD CONSTRAINT `picprofile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picprofile` ADD CONSTRAINT `picprofile_approvedByUserId_fkey` FOREIGN KEY (`approvedByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piceventassignment` ADD CONSTRAINT `piceventassignment_picProfileId_fkey` FOREIGN KEY (`picProfileId`) REFERENCES `picprofile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piceventassignment` ADD CONSTRAINT `piceventassignment_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piceventassignment` ADD CONSTRAINT `piceventassignment_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piceventassignment` ADD CONSTRAINT `piceventassignment_assignedByUserId_fkey` FOREIGN KEY (`assignedByUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picattribution` ADD CONSTRAINT `picattribution_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picattribution` ADD CONSTRAINT `picattribution_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picattribution` ADD CONSTRAINT `picattribution_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picattribution` ADD CONSTRAINT `picattribution_picProfileId_fkey` FOREIGN KEY (`picProfileId`) REFERENCES `picprofile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picattribution` ADD CONSTRAINT `picattribution_overriddenByUserId_fkey` FOREIGN KEY (`overriddenByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_picProfileId_fkey` FOREIGN KEY (`picProfileId`) REFERENCES `picprofile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `eventorderitem`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_ticketTypeId_fkey` FOREIGN KEY (`ticketTypeId`) REFERENCES `tickettype`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_attributionId_fkey` FOREIGN KEY (`attributionId`) REFERENCES `picattribution`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `refund`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `settlement`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `picfeeledger` ADD CONSTRAINT `picfeeledger_createdByUserId_fkey` FOREIGN KEY (`createdByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement` ADD CONSTRAINT `settlement_picProfileId_fkey` FOREIGN KEY (`picProfileId`) REFERENCES `picprofile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement` ADD CONSTRAINT `settlement_organizerId_fkey` FOREIGN KEY (`organizerId`) REFERENCES `organizer`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement` ADD CONSTRAINT `settlement_preparedByUserId_fkey` FOREIGN KEY (`preparedByUserId`) REFERENCES `user`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement` ADD CONSTRAINT `settlement_approvedByUserId_fkey` FOREIGN KEY (`approvedByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlement` ADD CONSTRAINT `settlement_paidByUserId_fkey` FOREIGN KEY (`paidByUserId`) REFERENCES `user`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlementitem` ADD CONSTRAINT `settlementitem_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `settlement`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlementitem` ADD CONSTRAINT `settlementitem_picFeeLedgerId_fkey` FOREIGN KEY (`picFeeLedgerId`) REFERENCES `picfeeledger`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `settlementitem` ADD CONSTRAINT `settlementitem_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `eventorder`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunditem` ADD CONSTRAINT `refunditem_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `refund`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunditem` ADD CONSTRAINT `refunditem_ticketId_fkey` FOREIGN KEY (`ticketId`) REFERENCES `ticket`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refunditem` ADD CONSTRAINT `refunditem_orderItemId_fkey` FOREIGN KEY (`orderItemId`) REFERENCES `eventorderitem`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notificationdelivery` ADD CONSTRAINT `notificationdelivery_notificationId_fkey` FOREIGN KEY (`notificationId`) REFERENCES `notification`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `idempotencykey` ADD CONSTRAINT `idempotencykey_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

