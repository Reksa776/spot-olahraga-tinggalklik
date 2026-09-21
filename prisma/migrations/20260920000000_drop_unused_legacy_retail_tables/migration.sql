-- ==========================================
-- PHASE 22 — DROP EIGHT UNUSED LEGACY RETAIL TABLES
-- ==========================================
--
-- TinggalKlik removed the retail/e-commerce domain. Its tables survived in the database
-- because nothing ever removed them. These eight are the subset that is provably unused,
-- and only that subset is dropped here.
--
-- ── WHY A MIGRATION RATHER THAN A HAND-RUN `DROP TABLE` ─────────────────────────
-- Every table below was created by an EARLIER migration still present in this history
-- (`0_baseline`, `20260820095404_add_marketing_affiliate_foundation`,
-- `20260909000000_add_shipping_discount_quota`). Deleting them out of band would leave the
-- database disagreeing with its own migration chain, and a fresh `migrate deploy` would
-- simply recreate them. Appending the drop here makes the chain self-consistent: a new
-- database runs create → drop → absent, exactly like this one.
--
-- ── THE EVIDENCE THAT THESE EIGHT ARE UNUSED ────────────────────────────────────
-- Recorded so a later reader does not have to re-derive it:
--
--   1. ROWS: 0 in every one of them, measured against the live database — so nothing is
--      deleted, only empty structures.
--   2. FOREIGN KEYS IN: no table in the schema references any of them. (Checked by
--      scanning information_schema.KEY_COLUMN_USAGE for REFERENCED_TABLE_NAME.) Their own
--      outgoing keys point at `campaign`, `voucher`, `flashsale` and `user`, all of which
--      are retained, so dropping the children removes nothing a parent needs.
--   3. MODELS: none of them has a Prisma model, a `@@map`, or a relation in
--      `prisma/schema.prisma`.
--   4. CODE: `grep` with word boundaries across app/, lib/, components/, scripts/,
--      __tests__/ and types/ returns zero references. The only mentions in the whole
--      repository are the CREATE TABLE statements in the migrations.
--   5. DOMAIN: all eight belong to the retired retail, marketing-voucher, flash-sale and
--      RajaOngkir shipping features. None is reachable from the ticketing domain.
--
-- ── WHAT IS DELIBERATELY *NOT* DROPPED ─────────────────────────────────────────
-- Every other retail-era table holds rows — `order` (149), `orderitem` (141), `product`,
-- `cart`, `voucher`, the affiliate ledger, the spin-wheel ledger, the
-- province/regency/district/village reference data, and `refund_backup_phase10b` (6 rows,
-- a pre-migration snapshot of refund records). Those are historical business and financial
-- data. Storage is not a reason to destroy them, and `order` additionally cannot be
-- dropped while an `orderId` foreign key on the ACTIVE `notification` table still points
-- at it. They are reported for manual review instead.
--
-- Child tables first, so no drop can be blocked by a foreign key. `IF EXISTS` keeps the
-- migration idempotent against a database where a table was already removed by hand.

DROP TABLE IF EXISTS `campaigncategory`;
DROP TABLE IF EXISTS `campaignproduct`;
DROP TABLE IF EXISTS `vouchercategory`;
DROP TABLE IF EXISTS `voucherproduct`;
DROP TABLE IF EXISTS `voucheruserusage`;
DROP TABLE IF EXISTS `flashsalepurchase`;
DROP TABLE IF EXISTS `promotion`;
DROP TABLE IF EXISTS `rajaongkirregion`;
