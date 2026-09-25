-- PIC FEE LEDGER — PROPORTIONAL REVERSALS (PHASE 30, D-R16 revision / BUG-3)
--
-- Additive and non-destructive: one NOT NULL column with a default value, then the
-- unique index on `(orderItemId, type)` is rebuilt to include `reversalRef`. Nothing
-- is dropped except the old unique index; the column, every row and every other index
-- survive. No data is rewritten and no history is mutated.
--
-- Existing rows keep `reversalRef = 'NONE'`, which preserves every pre-existing
-- guarantee the old unique index expressed:
--   * at most one EARNED row per order item,
--   * at most one EARNED_ADJUSTMENT / PAYOUT / ADJUSTMENT row per order item,
--   * at most one REVERSAL row per order item (the legacy full-item reversal shape).
-- New REVERSAL rows posted by the proportional writer set `reversalRef` to their source
-- refund id, so one order item may now carry one incremental reversal per refund event
-- (partial refunds included) and the cumulative sum converges exactly on the original
-- EARNED amount.

ALTER TABLE `picfeeledger`
    ADD COLUMN `reversalRef` VARCHAR(191) NOT NULL DEFAULT 'NONE';

-- The foreign key `picfeeledger_orderItemId_fkey` is backed by the unique index on
-- `(orderItemId, ...)` (MySQL requires an index on the FK column). The new unique index
-- keeps `orderItemId` as its leftmost column and already admits every existing row
-- (all have `reversalRef = 'NONE'` and the old unique held), so it is created BEFORE
-- the old index is dropped.
CREATE UNIQUE INDEX `picfeeledger_orderItemId_type_reversalRef_key`
    ON `picfeeledger`(`orderItemId`, `type`, `reversalRef`);

DROP INDEX `picfeeledger_orderItemId_type_key` ON `picfeeledger`;