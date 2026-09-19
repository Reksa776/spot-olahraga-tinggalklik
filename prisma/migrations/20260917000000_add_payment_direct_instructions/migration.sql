-- ==========================================
-- PAYMENT: DIRECT-PAYMENT INSTRUCTIONS (QRIS / VIRTUAL ACCOUNT)
-- ==========================================
--
-- ADDITIVE AND NON-DESTRUCTIVE: six nullable columns on `payment`. No existing
-- column is altered, dropped or renamed, no data is migrated, and no constraint is
-- added, so this migration is safe to apply to a database that already holds live
-- payments.
--
-- WHY IT IS NEEDED
-- ----------------
-- The redirect session this platform used until now (`POST /api/v2/payment/`)
-- returns only a hosted-page URL, so everything about the payment instrument —
-- the QRIS payload, the virtual-account number, the bank's display name, the
-- provider's own expiry — lived on iPaymu's page and was never available to this
-- application. Nothing could be shown in-app, and `Payment.paymentUrl` was the
-- only instruction column that existed.
--
-- `POST /api/v2/payment/direct` returns the instrument itself. These columns hold
-- exactly what that endpoint returned, verbatim:
--
--   providerFlow       'DIRECT' | 'REDIRECT' — which endpoint produced the row
--   paymentNumber      response `Data.PaymentNo` (VA number, cstore code, QRIS payload)
--   qrString           response `Data.QrString` (QRIS payload, stored as returned)
--   qrImageUrl         response `Data.QrImage`  (provider-hosted PNG of that payload)
--   paymentName        response `Data.PaymentName` (bank/merchant display name)
--   providerExpiredAt  response `Data.Expired` parsed to an instant
--
-- `qrString` and `qrImageUrl` are TEXT rather than VARCHAR(191): a QRIS payload is
-- a TLV string that routinely exceeds 191 characters (the sample in iPaymu's own
-- collection is 232), and truncating it would produce a QR that no wallet can
-- decode.
--
-- `providerExpiredAt` is deliberately separate from the existing `expiresAt`.
-- `expiresAt` is THIS platform's reservation window; `providerExpiredAt` is the
-- instant the provider stated. Both are kept because only the second is a claim the
-- gateway made, and the payment page shows the gateway's value.

ALTER TABLE `payment`
    ADD COLUMN `providerFlow` VARCHAR(191) NULL,
    ADD COLUMN `paymentNumber` VARCHAR(191) NULL,
    ADD COLUMN `qrString` TEXT NULL,
    ADD COLUMN `qrImageUrl` TEXT NULL,
    ADD COLUMN `paymentName` VARCHAR(191) NULL,
    ADD COLUMN `providerExpiredAt` DATETIME(3) NULL;
