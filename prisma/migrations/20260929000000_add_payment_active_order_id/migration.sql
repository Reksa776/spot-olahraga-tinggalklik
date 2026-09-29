-- PHASE: PAYMENT CONCURRENCY HARDENING (BUG-01 / BUG-02) — additive, non-destructive.
--
-- Adds the durable half of the "at most ONE active payment attempt per order" invariant.
--
--   * `activeOrderId` equals `orderId` while an attempt is NON-TERMINAL
--     (`UNPAID`/`PENDING`) and is NULL once the attempt is terminal
--     (`PAID`/`FAILED`/`EXPIRED`/`REFUNDED`/`PARTIALLY_REFUNDED`).
--   * The UNIQUE index below therefore admits AT MOST ONE active attempt per order, while
--     any number of terminal attempts coexist as history (MySQL/MariaDB treat multiple
--     NULLs as distinct, so terminal rows never collide).
--
-- No existing row's STATUS is changed and no history is deleted. Every terminal row keeps
-- its exact status and timestamps; only the new column is populated, and the back-fill
-- writes a value for the newest active attempt per order and NULL for anything else.
--
-- MariaDB/MySQL compatible: window functions require MariaDB 10.2+ / MySQL 8.0+, which the
-- deployed MariaDB 11.8 satisfies. The `UPDATE ... JOIN (derived table)` form is used so
-- the source and target are not the same open table in one statement.

ALTER TABLE `payment` ADD COLUMN `activeOrderId` VARCHAR(191) NULL;

-- Back-fill: the NEWEST active attempt per order claims the active slot. Any pre-existing
-- order that already held more than one active attempt (the BUG-01 state) contributes only
-- its newest row; the older ones are left in their existing status with a NULL pointer, so
-- the unique index can be created. They are not rewritten, and the claim path treats them
-- as active (refusing a new attempt) until the reservation reaper expires them.
UPDATE `payment` p
JOIN (
    SELECT `id`
    FROM (
        SELECT
            `id`,
            ROW_NUMBER() OVER (
                PARTITION BY `orderId`
                ORDER BY `createdAt` DESC, `id` DESC
            ) AS `rn`
        FROM `payment`
        WHERE `status` IN ('UNPAID', 'PENDING')
    ) ranked
    WHERE ranked.`rn` = 1
) newest ON newest.`id` = p.`id`
SET p.`activeOrderId` = p.`orderId`;

CREATE UNIQUE INDEX `payment_activeOrderId_key` ON `payment`(`activeOrderId`);
