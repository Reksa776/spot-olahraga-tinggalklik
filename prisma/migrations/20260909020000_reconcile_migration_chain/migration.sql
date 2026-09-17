-- Phase 2.5 (BLK-1) — reconcile the migration chain with a fresh database.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Until Phase 2 the migration chain could NOT be replayed into an empty
-- database; `prisma migrate deploy` failed part-way through. Three independent
-- defects caused that. This migration plus four one-line corrections in earlier
-- migrations removes all three:
--
--   1. NAME CASING. The chain up to and including
--      `20260909010000_add_order_original_spin` creates PascalCase tables (it
--      predates `@@map`), while the Phase 2 ticketing migration references the
--      lowercase names declared by `schema.prisma`. On a fresh database it could
--      not find `user`, `notification`, `refund` or `adminauditlog`. Section 2
--      renames the 41 PascalCase tables to their `@@map` names.
--
--   2. A TABLE NO MIGRATION CREATED. `adminauditlog` is declared in
--      `schema.prisma` and exists in every real database, but it was introduced
--      with `prisma db push`, so no migration ever created it - and the Phase 2
--      migration ALTERs it. Section 1 creates it when it is absent.
--
--   3. A TABLE NO MIGRATION FINISHED. `affiliatepayout` was created by
--      `20260820095404_add_marketing_affiliate_foundation`, but seven columns
--      and one enum value that `schema.prisma` declares were added to the real
--      database with `prisma db push` and captured by no migration. Section 3
--      completes it.
--
-- SAFETY
-- ------
-- Every statement in this file is conditional or idempotent:
--   * CREATE TABLE IF NOT EXISTS is a no-op where the table exists.
--   * Every rename runs only when the PascalCase source table exists AND the
--     lowercase target does not.
--   * Every column/index addition runs only when the object is absent.
--   * The enum widening runs only when the `FAILED` value is absent.
-- On the existing development/production database all of those conditions are
-- already satisfied, so each statement evaluates to `DO 0` and this migration
-- changes nothing there. That is why the guards - not defensive habit - are
-- load-bearing: the migration is recorded as *pending* on databases created
-- before it existed, because migrations that sort after it were already applied.
--
-- BUSINESS SEMANTICS
-- ------------------
-- None changed. No column, constraint, index, row or business rule is altered:
-- only object names, one missing table, seven missing nullable columns and one
-- missing enum value.

-- ---------------------------------------------------------------------------
-- 1. The table no migration ever created.
-- ---------------------------------------------------------------------------
-- `AdminAuditLog`, in its pre-Phase-2 shape, taken from the real database.
-- Created with `utf8mb4_unicode_ci` to match the other 69 tables rather than
-- reproducing the `utf8mb4_0900_ai_ci` outlier that Phase 2 had to work around.
-- Prisma does not model collation, so this is not drift - it simply means a
-- newly provisioned database is more internally consistent than the existing
-- one. Index names keep their historical form so the provisioned database
-- matches the existing one.
CREATE TABLE IF NOT EXISTS `adminauditlog` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `adminId` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `action` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `entityType` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `entityId` INT NULL,
  `description` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  `createdAt` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  PRIMARY KEY (`id`),
  KEY `AdminAuditLog_adminId_idx` (`adminId`),
  KEY `AdminAuditLog_entityType_entityId_idx` (`entityType`, `entityId`),
  KEY `AdminAuditLog_action_idx` (`action`),
  KEY `AdminAuditLog_createdAt_idx` (`createdAt`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Normalize the 41 PascalCase table names to their `@@map` names.
-- ---------------------------------------------------------------------------
-- Explicit, one table at a time - deliberately not a generic "rename every
-- uppercase table" sweep, so the set of renamed objects stays reviewable.
-- Guard: run only if the source exists and the target does not.
SET @from := 'Account'; SET @to := 'account'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'AffiliateClick'; SET @to := 'affiliateclick'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'AffiliateConversion'; SET @to := 'affiliateconversion'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'AffiliateKyc'; SET @to := 'affiliatekyc'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'AffiliatePayout'; SET @to := 'affiliatepayout'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'AffiliateProfile'; SET @to := 'affiliateprofile'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Broadcast'; SET @to := 'broadcast'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'BulkDiscount'; SET @to := 'bulkdiscount'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Campaign'; SET @to := 'campaign'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'CampaignCategory'; SET @to := 'campaigncategory'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'CampaignProduct'; SET @to := 'campaignproduct'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Cart'; SET @to := 'cart'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'CartItem'; SET @to := 'cartitem'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'District'; SET @to := 'district'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'FlashSale'; SET @to := 'flashsale'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'FlashSalePurchase'; SET @to := 'flashsalepurchase'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Notification'; SET @to := 'notification'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Order'; SET @to := 'order'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'OrderItem'; SET @to := 'orderitem'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Product'; SET @to := 'product'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'ProductDiscount'; SET @to := 'productdiscount'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'ProductVariant'; SET @to := 'productvariant'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Promotion'; SET @to := 'promotion'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Province'; SET @to := 'province'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'RajaOngkirRegion'; SET @to := 'rajaongkirregion'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Refund'; SET @to := 'refund'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Regency'; SET @to := 'regency'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Session'; SET @to := 'session'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'ShippingDiscount'; SET @to := 'shippingdiscount'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'SpinWheelCampaign'; SET @to := 'spinwheelcampaign'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'SpinWheelReward'; SET @to := 'spinwheelreward'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'SpinWheelSpin'; SET @to := 'spinwheelspin'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'StoreSetting'; SET @to := 'storesetting'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'User'; SET @to := 'user'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'UserAddress'; SET @to := 'useraddress'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'VerificationToken'; SET @to := 'verificationtoken'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Village'; SET @to := 'village'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'Voucher'; SET @to := 'voucher'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'VoucherCategory'; SET @to := 'vouchercategory'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'VoucherProduct'; SET @to := 'voucherproduct'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
SET @from := 'VoucherUserUsage'; SET @to := 'voucheruserusage'; SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @from) > 0 AND (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND BINARY TABLE_NAME = @to) = 0, CONCAT('RENAME TABLE `', @from, '` TO `', @to, '`'), 'DO 0'); PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- 3. Complete `affiliatepayout`.
-- ---------------------------------------------------------------------------
-- `AffiliatePayout` was created with only its twelve original columns; the
-- provider/disbursement columns and the `FAILED` status value that
-- `schema.prisma` declares were added to the real database with `prisma db push`
-- and appear in no migration. Without this block a provisioned database would
-- be missing seven columns, and `AffiliatePayoutStatus.FAILED` would be rejected
-- by the enum.
--
-- Column types follow `schema.prisma` (`DateTime` -> DATETIME(3),
-- `String` -> VARCHAR(191)), NOT the existing database, which stores `paidAt`
-- and `failedAt` as DATETIME(0) and `providerStatus` as VARCHAR(50). Those are
-- pre-existing defects of the running database, reported in
-- TICKETING_PHASE2_5_REPORT.md; reproducing them here would copy the defect into
-- every future database.
--
-- Columns first, then the indexes that depend on them.
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliatepayout' AND COLUMN_NAME = 'idempotencyKey') = 0,
  'ALTER TABLE `affiliatepayout` ADD COLUMN `providerTransactionId` VARCHAR(191) NULL, ADD COLUMN `providerReference` VARCHAR(191) NULL, ADD COLUMN `idempotencyKey` VARCHAR(191) NULL, ADD COLUMN `paidAt` DATETIME(3) NULL, ADD COLUMN `failedAt` DATETIME(3) NULL, ADD COLUMN `failureReason` TEXT NULL, ADD COLUMN `providerStatus` VARCHAR(191) NULL',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliatepayout' AND INDEX_NAME = 'AffiliatePayout_idempotencyKey_key') = 0 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliatepayout' AND COLUMN_NAME = 'idempotencyKey') = 1,
  'CREATE UNIQUE INDEX `AffiliatePayout_idempotencyKey_key` ON `affiliatepayout` (`idempotencyKey`)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliatepayout' AND INDEX_NAME = 'AffiliatePayout_providerTransactionId_idx') = 0 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliatepayout' AND COLUMN_NAME = 'providerTransactionId') = 1,
  'CREATE INDEX `AffiliatePayout_providerTransactionId_idx` ON `affiliatepayout` (`providerTransactionId`)',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl := IF(LOCATE('FAILED', (SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'affiliatepayout' AND COLUMN_NAME = 'status')) = 0,
  'ALTER TABLE `affiliatepayout` MODIFY COLUMN `status` ENUM(''PENDING'', ''PROCESSING'', ''PAID'', ''REJECTED'', ''FAILED'', ''CANCELLED'') NOT NULL DEFAULT ''PENDING''',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------------------------------
-- End of Phase 2.5 reconciliation. Migrations that sort after this one
-- (starting with 20260916000000_ticketing_phase2_foundation) can now assume the
-- lowercase table names, the `adminauditlog` table and the complete
-- `affiliatepayout` that `schema.prisma` declares.
-- ---------------------------------------------------------------------------
