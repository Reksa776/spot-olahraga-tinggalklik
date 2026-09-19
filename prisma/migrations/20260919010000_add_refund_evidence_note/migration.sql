-- Phase 18B: manual bank-transfer refund rail — operator evidence note.
--
-- Purely ADDITIVE (brief §18): one nullable column, nothing dropped, no enum reordered,
-- no existing row rewritten, and the 30 orphaned legacy retail tables plus
-- `refund_backup_phase10b` are deliberately LEFT ALONE (that cleanup is a separate
-- decision, not this phase).
--
-- `refund.evidenceNote` is the operator's evidence note for a refund settled by MANUAL
-- BANK TRANSFER (D-P17-04 = B). The rest of the evidence already has a home:
--
--   * the transfer / bank reference  -> `refund.providerRef`
--   * the settlement instant         -> `refund.completedAt`
--   * the operator who moved money   -> `refund.processedByUserId`
--   * the amount that moved          -> `refund.confirmedAmount` (server-derived)
--
-- `PROCESSING` never meant "money definitely moved", and it still does not: only a
-- `PROCESSING -> REFUNDED` transition that carries this evidence makes that claim.
ALTER TABLE `refund`
    ADD COLUMN `evidenceNote` TEXT NULL;
