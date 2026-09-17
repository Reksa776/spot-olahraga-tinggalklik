-- AddShippingDiscountQuota
-- Migration: Add quota/usage limits to ShippingDiscount (F9) and
--           attribute shipping-discount usage on Order.

-- Phase 2.5 (BLK-1): table names corrected from lowercase (`shippingdiscount`,
-- `order`) to the PascalCase names this chain actually creates (`ShippingDiscount`,
-- `Order`). The Phase-2-era migrations use lowercase because the database was
-- renamed with @@map + db push; the historical chain predates that.

-- 1. ShippingDiscount quota fields
ALTER TABLE `ShippingDiscount`
  ADD COLUMN `quota` INT NULL,
  ADD COLUMN `usedCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `maxUsagePerUser` INT NULL;

-- 2. Order shipping-discount attribution
ALTER TABLE `Order`
  ADD COLUMN `shippingDiscountId` INT NULL,
  ADD COLUMN `shippingDiscountName` VARCHAR(191) NULL,
  ADD COLUMN `shippingDiscountAmount` DECIMAL(12,2) NULL;

ALTER TABLE `Order`
  ADD INDEX `order_shippingDiscountId_idx` (`shippingDiscountId`),
  ADD CONSTRAINT `order_shippingDiscountId_fkey`
    FOREIGN KEY (`shippingDiscountId`) REFERENCES `ShippingDiscount` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;