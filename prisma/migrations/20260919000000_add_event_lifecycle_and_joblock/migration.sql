-- Phase 15: event lifecycle automation + job runner lease + the D-28 gate result.
--
-- Purely ADDITIVE, per the Phase 14 decision lock §23.2 (P14-D20). Nothing is dropped,
-- no enum value is reordered, and no existing row is rewritten.
--
--   1. `event.completedAt` — when the platform OBSERVED the transition to COMPLETED
--      (P14-D04 / P14-D05). The scheduled instant stays derivable as `endAt + 30
--      minutes`; this column records the observation, exactly as `Ticket.checkedInAt`
--      records the server clock. There is deliberately no `ongoingAt`: ONGOING is
--      derived from `startAt` and needs no stored trace (P14-D01 / P14-D20).
--
--   2. `checkin.result` gains `REFUND_PENDING` (P14-D15 — decision D-28). Appended at
--      the END of the enum so every existing row keeps its ordinal meaning. A ticket
--      claimed by an open refund (`PENDING | APPROVED | PROCESSING`) is refused at the
--      gate with this result instead of being admitted.
--
--   3. `joblock` — the DB-backed single-flight lease for the tick route
--      (P14-D09 / P14-D10). One row per job; a conditional UPDATE claims it, so a
--      crashed run's lease can be taken over once it expires and two concurrent ticks
--      cannot both own a job. This is what replaces an in-process timer, a process-local
--      mutex or Redis on the single-VPS deployment.

-- 1. Completion observation timestamp.
ALTER TABLE `event`
    ADD COLUMN `completedAt` DATETIME(3) NULL;

-- 2. Append the refund-pending refusal result to the check-in outcome enum.
ALTER TABLE `checkin`
    MODIFY COLUMN `result` ENUM('SUCCESS', 'DUPLICATE', 'ALREADY_CHECKED_IN', 'INVALID_TICKET', 'WRONG_EVENT', 'UNPAID', 'TICKET_NOT_FOUND', 'REFUND_PENDING') NOT NULL;

-- 3. The job runner lease. `name` is `event-lifecycle` or `reservation-reaper`.
CREATE TABLE `joblock` (
    `name` VARCHAR(64) NOT NULL,
    `lockedUntil` DATETIME(3) NULL,
    `lockedBy` VARCHAR(64) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `lastStatus` VARCHAR(32) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
