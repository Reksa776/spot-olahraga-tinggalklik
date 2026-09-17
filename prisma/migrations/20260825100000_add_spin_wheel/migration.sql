-- CreateTable
CREATE TABLE `SpinWheelCampaign` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `minimumSpend` DECIMAL(12,2) NOT NULL DEFAULT 0,
    `maxSpinsPerUser` INTEGER NOT NULL DEFAULT 1,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SpinWheelCampaign_slug_key`(`slug`),
    INDEX `SpinWheelCampaign_isActive_idx`(`isActive`),
    INDEX `SpinWheelCampaign_startAt_endAt_idx`(`startAt`, `endAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SpinWheelReward` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `campaignId` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('PERCENTAGE', 'FIXED', 'FREE_SHIPPING', 'CASHBACK', 'ZONK') NOT NULL,
    `value` DECIMAL(12,2) NOT NULL,
    `maxDiscount` DECIMAL(12,2) NULL,
    `weight` INTEGER NOT NULL DEFAULT 1,
    `totalQuantity` INTEGER NULL,
    `usedQuantity` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SpinWheelReward_campaignId_idx`(`campaignId`),
    INDEX `SpinWheelReward_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SpinWheelSpin` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `campaignId` INTEGER NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `rewardId` INTEGER NOT NULL,
    `status` ENUM('AVAILABLE', 'USED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'AVAILABLE',
    `expiresAt` DATETIME(3) NULL,
    `usedAt` DATETIME(3) NULL,
    -- Phase 2.5 (BLK-1): the inline `UNIQUE` was removed from this column.
    -- It created a second, auto-named unique index (`orderId`) alongside the
    -- explicit `UNIQUE INDEX SpinWheelSpin_orderId_key` below, so a replayed
    -- database carried two redundant unique indexes that the real database
    -- (and schema.prisma) do not have. Uniqueness is still enforced by the
    -- named index; the column definition is otherwise unchanged.
    `orderId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SpinWheelSpin_campaignId_userId_key`(`campaignId`, `userId`),
    UNIQUE INDEX `SpinWheelSpin_orderId_key`(`orderId`),
    INDEX `SpinWheelSpin_campaignId_idx`(`campaignId`),
    INDEX `SpinWheelSpin_userId_idx`(`userId`),
    INDEX `SpinWheelSpin_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `SpinWheelReward` ADD CONSTRAINT `SpinWheelReward_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `SpinWheelCampaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SpinWheelSpin` ADD CONSTRAINT `SpinWheelSpin_campaignId_fkey` FOREIGN KEY (`campaignId`) REFERENCES `SpinWheelCampaign`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SpinWheelSpin` ADD CONSTRAINT `SpinWheelSpin_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SpinWheelSpin` ADD CONSTRAINT `SpinWheelSpin_rewardId_fkey` FOREIGN KEY (`rewardId`) REFERENCES `SpinWheelReward`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SpinWheelSpin` ADD CONSTRAINT `SpinWheelSpin_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
