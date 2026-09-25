-- PHASE 33 — USER ACCOUNT STATUS (additive, reversible)
--
-- Adds ONE nullable column to `user`: `disabledAt`. NULL = the account is active; a
-- timestamp = an ADMIN deactivated it through the new /dashboard/users surface.
--
-- There was no account-status column before this migration (suspension lived on
-- PICProfile.status and OrganizerMember.status, which are different dimensions and are
-- unchanged). The column is nullable with no default, so no existing row changes value:
-- every existing user stays active. No data is moved, rewritten or deleted.

ALTER TABLE `user` ADD COLUMN `disabledAt` DATETIME(3) NULL;

-- The login path resolves accounts by email or phone and checks `disabledAt` in the
-- process; the dashboard/API guards re-resolve the user per request. An index keeps the
-- disabled-account lookup from scanning as the table grows.
CREATE INDEX `user_disabledAt_idx` ON `user`(`disabledAt`);
