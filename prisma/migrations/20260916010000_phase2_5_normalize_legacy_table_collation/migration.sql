-- Phase 2.5 -- make fresh-database provisioning collation-deterministic.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- `prisma migrate deploy` must produce the same database no matter how the
-- empty database it targets was created. It did not.
--
-- Every table in the chain except three gets its character set and collation
-- from an explicit clause in a migration. These three do not:
--
--     broadcast          created by 20260821000000_add_marketing_broadcast
--     bulkdiscount       created by a hand-written migration
--     shippingdiscount   created by a hand-written migration
--
-- (Prisma-generated migrations always emit `DEFAULT CHARACTER SET utf8mb4
-- COLLATE utf8mb4_unicode_ci`; these three came from hand-written SQL that
-- omitted it.) A table created without an explicit collation inherits the
-- *database* default, so those three silently took the value of whatever the
-- database happened to be created with:
--
--   * database created with the server default (MariaDB 11.8: uca1400_ai_ci)
--         -> broadcast / bulkdiscount / shippingdiscount are uca1400_ai_ci
--   * database created with an explicit utf8mb4_unicode_ci default
--         -> the same three tables are utf8mb4_unicode_ci
--
-- Both outcomes were reproduced during Phase 2.5 against the real server.
--
-- The consequence is the same class of defect that broke the Phase 2 live
-- migration: a column cannot be used in a foreign key against a column with a
-- different collation (MySQL errno 150 / ER_FK_INCOMPATIBLE_COLUMNS). These
-- three tables currently have no character-column foreign key, so nothing
-- fails today - but any future migration that adds one would fail on some
-- provisioned databases and not others, depending only on how the database was
-- created. That is the ambiguity this migration removes.
--
-- WHAT IT DOES
-- ------------
-- It pins exactly those three tables to utf8mb4 / utf8mb4_unicode_ci, the
-- collation that 67 of the 70 tables - including every new ticketing table -
-- already use. Nothing else is touched: this is not a database-wide collation
-- conversion, and no other table or column is altered.
--
-- SAFETY
-- ------
-- Each statement is guarded on the table's current collation, so:
--   * On the existing development database - and on any database provisioned
--     with an explicit utf8mb4_unicode_ci default - all three tables already
--     match, every statement evaluates to `DO 0`, and this migration changes
--     nothing. This was verified by comparing the full schema before and after.
--   * On a database where they inherited a different collation, they are
--     normalised to match the other 67 tables.
--   * The guard makes it idempotent; running it twice is a no-op the second
--     time.
-- No column is added, dropped or retyped, and no row is modified or moved.
-- See TICKETING_PHASE2_5_REPORT.md section 9.

-- broadcast
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'broadcast'
      AND TABLE_COLLATION <> 'utf8mb4_unicode_ci') = 1,
  'ALTER TABLE `broadcast` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- bulkdiscount
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bulkdiscount'
      AND TABLE_COLLATION <> 'utf8mb4_unicode_ci') = 1,
  'ALTER TABLE `bulkdiscount` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- shippingdiscount
SET @ddl := IF((SELECT COUNT(*) FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'shippingdiscount'
      AND TABLE_COLLATION <> 'utf8mb4_unicode_ci') = 1,
  'ALTER TABLE `shippingdiscount` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
  'DO 0');
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
