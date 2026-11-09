-- Operator-controlled WhatsApp disconnect latch.
-- Additive only: every existing row keeps the default FALSE (gateway may connect).
ALTER TABLE `platformsetting`
    ADD COLUMN `whatsappManualDisconnect` BOOLEAN NOT NULL DEFAULT false;
