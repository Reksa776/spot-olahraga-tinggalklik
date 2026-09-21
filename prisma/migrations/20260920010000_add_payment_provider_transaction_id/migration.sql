-- PHASE 27E — PAYMENT RECONCILIATION
--
-- Additive and non-destructive: ONE nullable column on `payment`.
--
-- Operator-triggered reconciliation needs the provider's OWN transaction id in order
-- to address the server-to-server status query (`POST /api/v2/transaction`). iPaymu
-- returns that id as `Data.TransactionId` when it creates a payment instrument, and
-- it is captured at payment creation from that response only.
--
-- NO BACK-FILL. An identity may only ever come from a provider response, so existing
-- rows keep NULL: a REDIRECT session genuinely has no transaction id, and rows written
-- before this column existed have none recorded. Those payments reconcile as BLOCKED
-- rather than acquiring a guessed or operator-entered identity.
--
-- No index is added: every lookup goes from a payment we already hold to the provider,
-- never from a provider id back into this table.

ALTER TABLE `payment`
    ADD COLUMN `providerTransactionId` VARCHAR(191) NULL;
