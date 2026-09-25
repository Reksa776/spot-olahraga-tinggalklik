-- PHASE NEXT — refund TRANSFER EVIDENCE (proof-of-transfer file), additive only.
--
-- Six NULLABLE, NULL-by-default columns on `refund` that pin an ACTUAL proof file
-- (bank receipt / transfer screenshot / PDF — the thing the operator is asked to
-- record when it posts the executed refund) to the refund row, so that:
--
--   * the operator that "mencatat transfer" has a place to attach the real file, not
--     just `providerRef`/`evidenceNote` free text;
--   * the OWNING customer of the refunded order can fetch their OWN evidence through
--     tenant-scoped, own-scope routes (404-masked cross-tenant / other-customer,
--     PIC permanently excluded — Part K);
--   * bytes are validated server-side by MAGIC-jpeg/png/webp (the existing
--     `detectImageFormat`) or `%PDF-` header, capped at 5MB, and the STORAGE KEY is
--     server-generated — client never supplies a path.
--
-- The file NEVER lives in the DB; columns only hold the key under
-- `UPLOAD_DIR/refund-evidence/` plus validated metadata. All NULLABLE + ADDITIVE —
-- no drop, no rename, no index, no back-fill, no backfill flags. Existing rows, read
-- models, dashboards and tests keep working unchanged.
--
-- One compound `ADD COLUMN`, MySQL 8, utf8mb4 — the same charset/collation the
-- existing `add_refund_system` migration gives every `refund` string column.

ALTER TABLE `refund`
    ADD COLUMN `evidenceFileKey` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    ADD COLUMN `evidenceFileName` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    ADD COLUMN `evidenceFileSizeB` int NULL,
    ADD COLUMN `evidenceMimeType` varchar(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    ADD COLUMN `evidenceUploadedByUserId` varchar(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL,
    ADD COLUMN `evidenceUploadedAt` datetime(3) NULL;
