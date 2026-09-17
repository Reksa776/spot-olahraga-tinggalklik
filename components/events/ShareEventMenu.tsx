"use client";

import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { FiCheck, FiCopy, FiShare2 } from "react-icons/fi";

/**
 * ==========================================
 * EVENT SHARE MENU (requirement §4)
 * ==========================================
 *
 * Implements "Bisa share satu event": copy the canonical link, hand it to WhatsApp
 * (the primary channel for this market, design §10.6) or X, and render the same URL as
 * a QR for print or on-screen scanning.
 *
 * The QR is rendered with `qrcode.react`, which is **already a project dependency**
 * (design §10.6 notes it), so no package was added for this feature. The encoded value
 * is supplied by the server (`/api/events/{slug}/share` → `qr.payload`) rather than
 * built here, so the client cannot encode something different from the canonical URL.
 *
 * No WhatsApp *sending* happens — this only builds a `wa.me` link, which is a URL the
 * user's own client opens. The notification/messaging system is a later phase and is
 * explicitly out of scope (brief §5).
 */

type Props = {
    canonicalUrl: string;
    title: string;
    /** True when the event is not publicly available (D-14). */
    disabled?: boolean;
};

export default function ShareEventMenu({
    canonicalUrl,
    title,
    disabled = false,
}: Props) {
    const [copied, setCopied] = useState(false);
    const [showQr, setShowQr] = useState(false);

    const shareText = `${title}\n${canonicalUrl}`;

    const whatsappHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;
    const xHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
        title
    )}&url=${encodeURIComponent(canonicalUrl)}`;

    async function copyLink() {
        try {
            await navigator.clipboard.writeText(canonicalUrl);

            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Clipboard permission denied (or a non-secure context). The link is still
            // visible in the QR panel, so this is not treated as a failure.
            setShowQr(true);
        }
    }

    if (disabled) {
        return (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Event ini belum dipublikasikan, jadi tautan publiknya belum dapat
                dibagikan.
            </p>
        );
    }

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <button
                    type="button"
                    onClick={copyLink}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                    {copied ? <FiCheck aria-hidden /> : <FiCopy aria-hidden />}
                    {copied ? "Tersalin" : "Salin tautan"}
                </button>

                <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-green-700"
                >
                    <FiShare2 aria-hidden />
                    WhatsApp
                </a>

                <a
                    href={xHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                >
                    Bagikan ke X
                </a>

                <button
                    type="button"
                    onClick={() => setShowQr((value) => !value)}
                    className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
                    aria-expanded={showQr}
                >
                    {showQr ? "Sembunyikan QR" : "Tampilkan QR"}
                </button>
            </div>

            <p className="truncate text-xs text-gray-500">{canonicalUrl}</p>

            {showQr ? (
                <div className="inline-block rounded-lg border border-gray-200 bg-white p-3">
                    <QRCodeSVG value={canonicalUrl} size={160} />
                </div>
            ) : null}
        </div>
    );
}
