-- F18: persist the exact original spin per order so repayment can
-- re-reserve the SAME spin (orderId on SpinWheelSpin is cleared on
-- cancel, so it cannot be used to recover the identity).

-- Phase 2.5 (BLK-1): table names corrected from lowercase (`order`,
-- `spinwheelspin`) to the PascalCase names this chain creates (`Order`,
-- `SpinWheelSpin`). See TICKETING_PHASE2_5_REPORT.md.
ALTER TABLE `Order`
  ADD COLUMN `originalSpinWheelSpinId` INT NULL,
  ADD INDEX `order_originalSpinWheelSpinId_idx` (`originalSpinWheelSpinId`),
  ADD CONSTRAINT `order_originalSpinWheelSpinId_fkey`
    FOREIGN KEY (`originalSpinWheelSpinId`) REFERENCES `SpinWheelSpin` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;