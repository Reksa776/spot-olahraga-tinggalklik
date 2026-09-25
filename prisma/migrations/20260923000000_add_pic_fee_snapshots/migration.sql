-- PIC FEE SNAPSHOTS ON EVENT ORDER ITEMS (PIC VERTICAL SLICE, DESIGN §15.1 / D-23)
--
-- Additive and non-destructive: six NULLABLE columns on `eventOrderItem`, no drops,
-- no back-fill and no index.
--
-- Why: the PIC fee engine prices every line inside the checkout transaction, and these
-- columns exist so that settlement can REPLAY the EARNED ledger rows exactly as priced
-- (never recompute): a later rate change cannot rewrite past earnings. They are the same
-- shape as `EventOrderItemPicFeeSnapshot` in the ticketing module.
--
-- All are NULL for a non-PIC order (per item), which is byte-identical to the pre-PIC
-- shape: no order scans by PIC fee, lookups always walk order -> items, so an index
-- would be dead weight.

ALTER TABLE `eventorderitem`
    ADD COLUMN `picFeeAmount` DECIMAL(14, 2) NULL,
    ADD COLUMN `picFeeType` ENUM('PERCENTAGE', 'FIXED', 'HYBRID') NULL,
    ADD COLUMN `basisType` ENUM(
        'GROSS_BEFORE_DISCOUNT',
        'GROSS_AFTER_DISCOUNT',
        'NET_AFTER_GATEWAY'
    ) NULL,
    ADD COLUMN `rateBp` INT NULL,
    ADD COLUMN `fixedAmount` DECIMAL(14, 2) NULL,
    ADD COLUMN `basisAmount` DECIMAL(14, 2) NULL;