/**
 * ==========================================
 * /pic/scanner/[eventId] — THE PIC SCANNER
 * ==========================================
 *
 * Deliberately a re-export of the proven Phase 3E page: camera permission handling, the
 * BarcodeDetector/jsQR fallback, duplicate-frame throttling and the single in-flight submission
 * guard all live in the shared `TicketScanner`. The page's own server guard
 * (`requirePicScanAccess`) and the API it calls (`POST /api/pic/events/[id]/check-in`) are
 * unchanged — this route only gives the PIC a canonical URL outside `/dashboard`.
 *
 * Route segment config cannot be re-exported: Next.js must see `dynamic` as a literal
 * declaration in THIS module. Keep the value in sync with the source page
 * (`app/dashboard/pic/scan/[eventId]/page.tsx`), which also uses `force-dynamic`.
 */

export { default, metadata } from "@/app/dashboard/pic/scan/[eventId]/page";

export const dynamic = "force-dynamic";
