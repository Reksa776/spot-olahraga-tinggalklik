"use client";

import { QRCodeSVG } from "qrcode.react";

/**
 * ==========================================
 * E-TICKET QR
 * ==========================================
 *
 * Renders the QR from a payload the SERVER derived, using the QR renderer already installed
 * in this project (`qrcode.react@^4.2.0`, see `package.json`). No dependency was added.
 *
 * ── WHY THE PAYLOAD IS A PROP AND NOT COMPUTED HERE ─────────────────────────────
 * Brief §23: "The UI must derive ticket availability from the server. Do not trust client
 * state for: ownership, ticket status, payment status, issuance status, QR validity." So the
 * component decides the SIZE and nothing else. It cannot build a payload from a ticket code
 * it happens to have, cannot read a session, and cannot reach the API — the exact string to
 * encode arrives as a prop from a server component.
 *
 * ── WHY `QRCodeSVG` AND NOT A DATA URL ──────────────────────────────────────────
 * Brief §13: "QR should preferably be rendered as SVG or another safe server-generated
 * representation. Avoid base64 data URLs if they create unnecessary payload size." SVG is
 * what this renderer produces, it scales without blurring on a phone, and it keeps the
 * encoded value out of an `<img src>` that a screenshot or a DOM dump would carry.
 *
 * ── WHY `qrcode.react` RENDERS ON THE CLIENT ────────────────────────────────────
 * The library memoises QR generation with `React.useMemo`, so it is a client component and
 * cannot be rendered inside a React Server Component. The security property that the
 * design's §26.6 alternative buys — "Render the QR server-side as an image (no token reaches
 * JS)" — holds here by construction rather than by rendering location: the payload is a
 * PUBLIC lookup code, never the ticket's scanner secret, which is stored only as a SHA-256
 * hash and is not recoverable by this application at all (design §19.1/§19.3).
 *
 * ── LEVEL AND ERROR CORRECTION ──────────────────────────────────────────────────
 * `level="M"` (the library default) balances density against a phone camera's ability to
 * read a printed or screen-held code. The payload is ~17 characters, so the symbol stays
 * small and readable at the size below.
 */

type Props = {
    /** The exact string to encode. Supplied by the server; never assembled here. */
    payload: string;
    /** Rendered edge length in pixels. */
    size?: number;
};

export default function TicketQr({ payload, size = 220 }: Props) {
    return (
        <div
            className="inline-block rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-200"
            // The QR is an image of a code, and the code is also printed as text beside it,
            // so the image is decorative for assistive technology.
            aria-hidden="true"
        >
            <QRCodeSVG value={payload} size={size} level="M" />
        </div>
    );
}
