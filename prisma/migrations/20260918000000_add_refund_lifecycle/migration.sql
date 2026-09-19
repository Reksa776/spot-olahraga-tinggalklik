-- Phase 10B: ticketing refund lifecycle.
--
-- This migration does two things:
--
--   1. Reconciles the legacy retail `refund` columns that were physically left
--      behind when the retail application (and its refund path) were deleted.
--      Prisma had already removed those columns from the schema, but the live
--      table still declared `orderId`, `amount` and `requestedBy` as NOT NULL
--      with no default, so no ticketing `Refund` row could be inserted at all.
--      The retail `Order` model no longer exists, so the FK, the unique key and
--      the four retail columns are dropped. The six legacy rows keep their
--      identity and are re-mapped `COMPLETED` -> `REFUNDED` (the ticketing
--      terminal success state).
--
--   2. Adds the ticketing refund lifecycle columns and statuses (design §18.2,
--      policy D-R07). `REFUNDED` is the only state in which money, quota and
--      ticket status are treated as reversed (D-R06 / D-R14 / D-R15).
--
-- Index names are aligned with the committed schema as part of the same
-- reconciliation (the legacy index names used the old model name `Refund`).

-- 1. Widen `status` to a superset that accepts both the legacy and the
--    ticketing values, so the legacy rows can be re-mapped below.
ALTER TABLE `refund`
    MODIFY COLUMN `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'REFUNDED', 'FAILED') NOT NULL DEFAULT 'PENDING';

-- 2. Re-map the legacy terminal state.
UPDATE `refund` SET `status` = 'REFUNDED' WHERE `status` = 'COMPLETED';

-- 3. Shrink `status` to the ticketing lifecycle.
ALTER TABLE `refund`
    MODIFY COLUMN `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'PROCESSING', 'REFUNDED', 'FAILED') NOT NULL DEFAULT 'PENDING';

-- 4. Drop the retail foreign key, unique key and columns.
ALTER TABLE `refund` DROP FOREIGN KEY `Refund_orderId_fkey`;
ALTER TABLE `refund` DROP INDEX `Refund_orderId_key`;
ALTER TABLE `refund`
    DROP COLUMN `orderId`,
    DROP COLUMN `amount`,
    DROP COLUMN `requestedBy`,
    DROP COLUMN `processedBy`;

-- 5. Ticketing lifecycle columns.
ALTER TABLE `refund`
    ADD COLUMN `requestedAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `confirmedAmount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `processedByUserId` VARCHAR(191) NULL,
    ADD COLUMN `processedAt` DATETIME(3) NULL,
    ADD COLUMN `completedAt` DATETIME(3) NULL,
    ADD COLUMN `failedAt` DATETIME(3) NULL,
    ADD COLUMN `failureReason` TEXT NULL;

-- 6. Align legacy index names with the committed schema, then add the queue index.
ALTER TABLE `refund`
    DROP INDEX `Refund_createdAt_idx`,
    DROP INDEX `Refund_status_idx`;
CREATE INDEX `refund_createdAt_idx` ON `refund`(`createdAt`);
CREATE INDEX `refund_status_idx` ON `refund`(`status`);
CREATE INDEX `refund_organizerId_status_createdAt_idx` ON `refund`(`organizerId`, `status`, `createdAt`);
