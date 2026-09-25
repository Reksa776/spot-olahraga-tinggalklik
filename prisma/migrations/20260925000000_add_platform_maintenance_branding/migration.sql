-- PLATFORM SETTINGS — APPLICATION MAINTENANCE MODE (PHASE 32)
--
-- Strictly additive and non-destructive: three new columns on the existing single-row
-- `platformsetting` table. No column, index, row or value is changed or removed, so every
-- existing reader (`lib/ticketing/reservations.ts`, `lib/pic/attribution.ts`) keeps the
-- exact behaviour it has today.
--
-- `maintenanceMode` defaults to FALSE so an unconfigured or freshly migrated deployment
-- serves traffic rather than appearing broken; the brief's "if no custom configuration
-- exists use the existing behaviour" applies to availability exactly as it does to branding.
--
-- Branding reuses the EXISTING `logoUrl` column (created with the table in the Phase 2
-- foundation migration), so no branding column is added here: the logo reference was
-- already modelled, and this phase only wires it up.

ALTER TABLE `platformsetting`
    ADD COLUMN `maintenanceMode` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `maintenanceMessage` TEXT NULL,
    ADD COLUMN `maintenanceEtaMessage` TEXT NULL;
