-- PHASE 21 — PIC SELF-SERVICE PAYOUT REQUEST (additive, non-destructive).
--
-- The existing `Settlement` table already carries the whole money engine a manual
-- payout needs (claim lines with UNIQUE `settlementitem.picFeeLedgerId`, the manual
-- transfer rail, proof evidence). A PIC-initiated request reuses that engine rather
-- than opening a second accounting system, so it needs only:
--
--   * two new lifecycle states, appended to the enum — `REQUESTED` (the PIC created
--     the claim and is waiting for operator review) and `REJECTED` (an operator
--     refused it). Appending keeps every existing row's value and the default
--     `DRAFT` unchanged; nothing is dropped, renamed or rewritten.
--   * three NULLABLE, NULL-by-default columns that record WHO refused a request and
--     WHY, so the PIC can read the reason in their own dashboard. An approval or a
--     paid payout leaves all three NULL — a rejection stamp can never describe a
--     successful payout.
--
-- Additive only: no data back-fill, no index change, no destructive statement. Every
-- pre-existing operator-created settlement row keeps its exact status and payment
-- history, and every read model keeps working unchanged.

ALTER TABLE `settlement`
    MODIFY COLUMN `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PAID', 'FAILED', 'CANCELLED', 'REQUESTED', 'REJECTED') NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN `rejectedByUserId` VARCHAR(191) NULL,
    ADD COLUMN `rejectedAt` DATETIME(3) NULL,
    ADD COLUMN `rejectionReason` TEXT NULL;

ALTER TABLE `settlement`
    ADD CONSTRAINT `settlement_rejectedByUserId_fkey`
        FOREIGN KEY (`rejectedByUserId`) REFERENCES `user`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;
