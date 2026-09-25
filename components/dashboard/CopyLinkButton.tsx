"use client";

import { useState } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";

import { Button } from "@/components/dashboard/ui/button";

/**
 * Copy one PIC referral link to the clipboard.
 *
 * A server component builds the *relative* `sharePath` (`/e/{slug}?pic=<token>`); the full
 * URL is assembled here with `window.location.origin` because only the client knows the
 * origin it is actually served from — the server has no business guessing a hostname for a
 * link a browser will paste into WhatsApp. The token itself is pre-signed server-side; this
 * component only copies bytes, so it cannot fabricate or weaken a link.
 *
 * The pattern mirrors `components/events/ShareEventMenu.tsx`: an optimistic "Tersalin"
 * confirmation for two seconds, and a clipboard failure (permission denied / non-secure
 * context) is not treated as fatal.
 */
export default function CopyLinkButton({ sharePath }: { sharePath: string }) {
    const [copied, setCopied] = useState(false);

    async function copyLink() {
        try {
            await navigator.clipboard.writeText(
                `${window.location.origin}${sharePath}`
            );

            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setCopied(false);
        }
    }

    return (
        <Button type="button" variant="outline" size="sm" onClick={copyLink}>
            {copied ? (
                <FiCheck size={14} />
            ) : (
                <FiCopy size={14} />
            )}
            {copied ? "Tersalin" : "Salin tautan"}
        </Button>
    );
}