import type { NextConfig } from "next";

/**
 * ==========================================
 * SECURITY RESPONSE HEADERS
 * ==========================================
 *
 * These are applied to EVERY response from one global rule (`source: "/(.*)"`), not per route.
 * A header that only covers `/api` protects the wrong half of the application: the pages that
 * actually run in a browser — login, checkout, the order page — are the ones a document-level
 * attack targets, and they were the ones with no policy at all.
 *
 * ── EVERY SOURCE BELOW WAS AUDITED AGAINST THE CURRENT APPLICATION ──────────────
 * The policy is derived from what the tree actually loads. Nothing is copied from a template or
 * carried over from the deleted retail application, and no origin is whitelisted "in case".
 *
 *   script / style   `'self'` + `'unsafe-inline'`. The only scripts are Next.js's own chunks and
 *                    the inline theme bootstrap in `app/layout.tsx`; the only styles are the
 *                    Tailwind bundle plus Next's inline style injection. NOTHING loads a script
 *                    from a third-party host — the retail pixel and Leaflet bundles were deleted
 *                    with the retail application, and their allowances went with them.
 *                    `'unsafe-eval'` is added in DEVELOPMENT only (React 19's dev build evals to
 *                    reconstruct callstacks), so production can never ship it.
 *   img              `'self'`, `data:`, and the TWO payment-gateway hosts. The gateway serves the
 *                    QRIS code as a PNG on its own domain (`lib/ticketing/payment/gateway.ts`
 *                    maps the provider's `QrImage`), and that bitmap is the payment instrument —
 *                    re-encoding it locally is not an option, which is why it is the one
 *                    third-party exception.
 *                    The Google mark on the login/register buttons used to be a remote image on a
 *                    third-party asset host; it is inline SVG now
 *                    (`components/auth/GoogleMark.tsx`), so a host this product does not control
 *                    no longer renders pixels inside the sign-in page.
 *                    Uploaded event banners and photos are served same-origin from
 *                    `/api/uploads/events/...` (`lib/images/process.ts`), i.e. `'self'`.
 *   fonts            `'self'`. There is no webfont: `app/globals.css` pins the document to a
 *                    system sans stack, and no `@font-face` or font-CDN import exists.
 *   connect          `'self'`. Every browser `fetch` goes to this origin's own API routes; the
 *                    payment gateway is called from the SERVER, never from the browser, so no
 *                    provider host belongs here.
 *   frames / objects `'none'`. The application embeds no iframe, no `<object>` and no plugin
 *                    content. (Google sign-in is a full-page redirect through
 *                    `/api/auth/signin/google`, not an embedded frame, and `next-auth` performs
 *                    it with a same-origin `fetch` followed by a document navigation — verified
 *                    in `node_modules/next-auth/react.js` — so `form-action` is not involved.)
 *   base-uri /       `'self'`. No `<base>` tag is emitted, and every form submits to this origin.
 *   form-action
 *   frame-ancestors  `'none'`, the modern half of the framing decision below.
 *
 * ── FRAMING ─────────────────────────────────────────────────────────────────────
 * Nothing in this product is designed to be embedded, and no legitimate flow depends on it (the
 * venue map link is an `<a>` navigation, not an embed). So both halves are denied:
 * `X-Frame-Options: DENY` for browsers that ignore the directive, and `frame-ancestors 'none'`
 * for browsers that implement it. That combination is what stops clickjacking of the sign-in and
 * payment screens.
 *
 * ── HSTS ────────────────────────────────────────────────────────────────────────
 * Sent everywhere EXCEPT development (see the conditional in the header list). It instructs the
 * browser to refuse plain HTTP to this host for a year, so on a local HTTP dev server it is
 * meaningless noise that is painful to debug, while on any HTTPS-served environment it is the
 * control that prevents an SSL-strip downgrade of the very first request. `includeSubDomains` is
 * set; `preload` is deliberately NOT — submitting to a browser-vendor preload list is
 * effectively permanent and obliges every current and future subdomain to speak HTTPS, which is
 * a decision for a deployment owner rather than a default to bake into the repository.
 *
 * `X-XSS-Protection` is retained because the frozen security contract asserts it
 * (`__tests__/security/`). It is inert in modern browsers and redundant against the policy above,
 * so it stays as belt-and-braces for old clients.
 *
 * `poweredByHeader: false` removes `X-Powered-By`, which advertises the framework version.
 */

const nextConfig: NextConfig = {
    poweredByHeader: false,
    allowedDevOrigins: [
        "192.168.2.49",
        "103.93.132.214",
        "202.73.25.122",
        "demosolusisejalan.my.id",
        "debut-thanks-spray-wine.trycloudflare.com",
        "tinggalklik.demosolusisejalan.my.id"
    ],

    headers: async () => {
        /*
         * Evaluated at CALL time, not at module load, so the value reflects the environment the
         * server was actually started in. (The security suites flip `NODE_ENV` and call
         * `headers()` again, which only works if it is read here.)
         */
        const isDevelopment = process.env.NODE_ENV === "development";

        const scriptSrc = [
            "'self'",
            "'unsafe-inline'",
            ...(isDevelopment ? ["'unsafe-eval'"] : []),
        ].join(" ");

        const contentSecurityPolicy = [
            "default-src 'self'",
            `script-src ${scriptSrc}`,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https://my.ipaymu.com https://sandbox.ipaymu.com",
            "font-src 'self'",
            "connect-src 'self'",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
        ].join("; ");

        const headers = [
            { key: "X-Content-Type-Options", value: "nosniff" },
            { key: "X-Frame-Options", value: "DENY" },
            {
                key: "Referrer-Policy",
                // Sends the origin (but not the path or the query) to other sites. Paths on this
                // application are themselves sensitive — `/ticketing/orders/EVT-...` is somebody's
                // order — so full URLs must not leak to third parties, while withholding the
                // origin entirely would break outbound links that need to recognize us.
                value: "strict-origin-when-cross-origin",
            },
            { key: "X-XSS-Protection", value: "1; mode=block" },
            {
                key: "Permissions-Policy",
                // Denied outright: nothing asks for a camera, a microphone or the visitor's
                // location (the venue map is an outbound link; no component calls
                // `navigator.geolocation`). Clipboard access IS used and is deliberately not
                // restricted: it is not gated by this policy, and both call sites only copy a
                // value the visitor is already looking at.
                value: "camera=(), microphone=(), geolocation=()",
            },
            { key: "Content-Security-Policy", value: contentSecurityPolicy },
        ];

        return [
            {
                source: "/(.*)",
                headers: [
                    ...headers,
                    /*
                     * Omitted only in development: a local server speaks plain HTTP, where the
                     * instruction would do nothing but make the browser remember a rule that
                     * outlives the dev server.
                     */
                    ...(isDevelopment
                        ? []
                        : [
                              {
                                  key: "Strict-Transport-Security",
                                  value: "max-age=31536000; includeSubDomains",
                              },
                          ]),
                ],
            },
        ];
    },
};

export default nextConfig;
