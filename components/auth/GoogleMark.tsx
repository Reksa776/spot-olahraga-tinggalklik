/**
 * ==========================================
 * GOOGLE MARK (INLINE)
 * ==========================================
 *
 * The four-colour "G" that sits beside "Lanjutkan dengan Google" on the login and registration
 * screens.
 *
 * ── WHY THIS IS INLINE SVG AND NOT AN IMAGE URL ─────────────────────────────────
 * It used to be `<img src="https://www.svgrepo.com/show/475656/google-color.svg">`, which made a
 * third-party asset host a hard dependency of the two most security-sensitive pages in the
 * application:
 *
 *   • **CSP.** `img-src` would have had to name `www.svgrepo.com`, i.e. a host this product does
 *     not control could serve bytes into our sign-in page — and the frozen header contract
 *     (`__tests__/security/m4-csp.test.ts`) allows exactly two third-party image origins, the
 *     payment gateway's, because the QRIS bitmap cannot be re-encoded locally. A decorative
 *     logo is not that case, so the correct fix is to stop depending on the remote host rather
 *     than to widen the policy for it.
 *   • **Availability.** A blocked, slow or re-hosted asset leaves a broken-image glyph on the
 *     sign-in button — on a page whose entire job is to look trustworthy.
 *   • **Privacy.** A remote image request reports the visitor's IP and referrer to a third
 *     party before they have even signed in.
 *
 * Being inline, it also costs no request, cannot be blocked by an extension, and cannot shift
 * layout. The paths are the standard Google mark geometry; `aria-hidden` is set by the caller's
 * context (the button's own text names the provider), and the mark never carries meaning on its
 * own.
 */
export default function GoogleMark({ className = "h-5 w-5" }: { className?: string }) {
    return (
        <svg
            viewBox="0 0 24 24"
            aria-hidden
            focusable="false"
            className={className}
        >
            <path
                fill="#4285F4"
                d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"
            />
            <path
                fill="#34A853"
                d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
            />
            <path
                fill="#FBBC05"
                d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"
            />
            <path
                fill="#EA4335"
                d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
            />
        </svg>
    );
}
