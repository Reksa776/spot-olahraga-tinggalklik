-- POST-EVENT DOCUMENTATION LINK (FEATURE REQUEST)
--
-- Additive and non-destructive: ONE nullable column on `event`.
--
-- A COMPLETED event may carry a Google Drive share URL ("Dokumentasi event") that the
-- organizer publishes to buyers after the event ends. NULL means no link has been added
-- yet and is also the value a delete sets; the column is deliberately a plain URL string
-- because every policy about it (the Google Drive host allow-list, https-only, the
-- COMPLETED status gate) lives in application validation rather than in SQL.
--
-- NO BACK-FILL and NO index: every lookup goes from an event we already hold to its own
-- documentation link, never from a link back into a table, so an index would be dead
-- weight.

ALTER TABLE `event`
    ADD COLUMN `documentationUrl` TEXT NULL;