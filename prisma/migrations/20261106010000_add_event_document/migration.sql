-- Private event document distribution. Apply only after backup and staging verification.
CREATE TABLE `eventdocument` (
  `id` VARCHAR(191) NOT NULL,
  `eventId` VARCHAR(191) NOT NULL,
  `uploadedById` VARCHAR(191) NOT NULL,
  `title` VARCHAR(160) NOT NULL,
  `storageKey` VARCHAR(191) NOT NULL,
  `contentType` VARCHAR(100) NOT NULL,
  `sizeBytes` INTEGER NOT NULL,
  `accessTokenHash` VARCHAR(64) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `eventdocument_storageKey_key` (`storageKey`),
  INDEX `eventdocument_eventId_createdAt_idx` (`eventId`, `createdAt`),
  INDEX `eventdocument_expiresAt_idx` (`expiresAt`),
  PRIMARY KEY (`id`),
  CONSTRAINT `eventdocument_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `eventdocument_uploadedById_fkey` FOREIGN KEY (`uploadedById`) REFERENCES `user` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
