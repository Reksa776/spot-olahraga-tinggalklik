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
 */

export { default, dynamic, metadata } from "@/app/dashboard/pic/scan/[eventId]/page";
