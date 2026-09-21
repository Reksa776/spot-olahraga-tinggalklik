import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * ==========================================
 * ERROR BOUNDARIES & ERROR UI (STATIC GUARDS)
 * ==========================================
 *
 * The classification suite proves the DECISION is right. This one proves the decision is
 * WIRED — because a correct classifier nobody calls changes nothing, and that is exactly how
 * the Phase 23A defect survived: `getOwnOrder(...).catch(() => null)` looked defensive.
 *
 * Asserted here:
 *
 *   1. Every boundary exists, in the place Next.js looks for it, and is a CLIENT component
 *      (Next.js requires `reset` to be a client function — a server `error.tsx` fails at
 *      runtime, not at compile time, so nothing else would catch it).
 *   2. `global-error.tsx` ships its own `<html>`/`<body>` and the stylesheet. Without those the
 *      last-resort screen is unstyled HTML — the "blank broken page" outcome the brief forbids.
 *   3. No buyer page converts a failure into `notFound()` any more, and the pages that own a
 *      retry render a retryable state instead.
 *   4. No error surface can leak internals: no stack, no Prisma name, no env read.
 *   5. The login-return bug stays fixed: no page builds a `?next=` login link.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
    return existsSync(path.join(ROOT, relativePath));
}

/** Strip comments, so prose that NAMES a bad pattern is not mistaken for the pattern. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

const BOUNDARIES = [
    "app/error.tsx",
    "app/global-error.tsx",
    "app/dashboard/error.tsx",
    "app/ticketing/error.tsx",
];

const ERROR_COMPONENTS = [
    "components/errors/ErrorState.tsx",
    "components/errors/ErrorBoundaryFallback.tsx",
    "components/errors/InlineError.tsx",
    "components/errors/RetryButton.tsx",
    "components/errors/ReloadButton.tsx",
    "components/errors/ServiceUnavailableState.tsx",
];

/* ==================================================================================
 * 1. THE BOUNDARIES EXIST AND ARE CLIENT COMPONENTS
 * ================================================================================== */

describe("every error boundary exists, in the right place, as a client component", () => {
    it.each(BOUNDARIES)("%s exists", (file) => {
        expect(exists(file)).toBe(true);
    });

    it.each(BOUNDARIES)("%s is a client component and takes `reset`", (file) => {
        const code = readCode(file);

        // `reset` is a client function; an `error.tsx` without "use client" throws when it
        // renders, which is a failure mode only reachable during an error.
        expect(code).toContain('"use client"');
        expect(code).toMatch(/reset/);
    });

    it("the root 404 page exists and is a SERVER component", () => {
        expect(exists("app/not-found.tsx")).toBe(true);

        // It renders no handlers, so it must not drag the client runtime in with it.
        expect(readCode("app/not-found.tsx")).not.toContain('"use client"');
    });

    it("global-error ships its own document and stylesheet", () => {
        const code = read("app/global-error.tsx");

        // Next.js replaces the whole document, so these cannot come from the root layout.
        expect(code).toContain("<html");
        expect(code).toContain("<body");
        expect(code).toContain('import "./globals.css"');

        // And the fallback is the SHARED one, not a second implementation.
        expect(code).toContain("ErrorBoundaryFallback");
    });

    it("there is exactly one error fallback implementation", () => {
        // Every boundary delegates. A second implementation is how four surfaces start
        // showing four different products during an incident.
        for (const file of BOUNDARIES) {
            expect(readCode(file)).toContain("ErrorBoundaryFallback");
        }

        const definitions = ERROR_COMPONENTS.filter((file) =>
            read(file).includes("export function ErrorBoundaryFallback")
        );

        expect(definitions).toEqual(["components/errors/ErrorBoundaryFallback.tsx"]);
    });
});

/* ==================================================================================
 * 2. THE REUSABLE ERROR UI EXISTS, WITH THE RIGHT CLIENT BOUNDARY
 * ================================================================================== */

describe("the error component set", () => {
    it.each(ERROR_COMPONENTS)("%s exists", (file) => {
        expect(exists(file)).toBe(true);
    });

    it.each([
        ["components/errors/RetryButton.tsx", "calls the boundary's reset"],
        ["components/errors/ReloadButton.tsx", "re-runs the server render"],
        ["components/errors/ErrorBoundaryFallback.tsx", "renders the fallback"],
    ])("%s is a client component, because it owns a handler (%s)", (file) => {
        expect(readCode(file)).toContain('"use client"');
    });

    it.each([
        "components/errors/ErrorState.tsx",
        "components/errors/InlineError.tsx",
        "components/errors/ServiceUnavailableState.tsx",
    ])("%s stays server-safe (no client directive, no hooks)", (file) => {
        const code = readCode(file);

        expect(code).not.toContain('"use client"');
        expect(code).not.toMatch(/use(State|Effect|Router)\b/);
    });

    /*
     * SESSION EXPIRATION has NO dedicated screen component, on purpose.
     *
     * The brief lists one as optional ("if architecture does not already provide them"). This
     * architecture does: a request whose session no longer resolves is redirected to
     * `/login?callbackUrl=<the page they were on>` by the page itself, and the proxy does the
     * same for a request with no session at all. That lands the user back where they were
     * after one sign-in, whereas a panel would add a second click to reach the same place.
     *
     * What WAS broken is now pinned instead: those pages built `?next=`, which the login form
     * never read (`?callbackUrl` is the key), so an expired session silently dumped the buyer
     * on the dashboard. Asserted in section 5 below.
     */
    it("session expiration is a destination-preserving redirect, not a dead end", () => {
        for (const file of [
            "app/ticketing/orders/[orderNumber]/page.tsx",
            "app/ticketing/tickets/page.tsx",
            "app/ticketing/tickets/[ticketCode]/page.tsx",
            "app/ticketing/refunds/page.tsx",
        ]) {
            const code = readCode(file);

            expect(code).toContain("loginUrlFor(");
            expect(code).toContain("redirect(");
        }
    });

    it("the retry states offer a retry, and the payment variant never implies settlement", () => {
        const service = read("components/errors/ServiceUnavailableState.tsx");

        expect(service).toContain("belum dianggap lunas");

        // Nothing here may claim a payment succeeded.
        expect(service.toLowerCase()).not.toContain("berhasil dibayar");
        expect(service.toLowerCase()).not.toContain("lunas.");
    });
});

/* ==================================================================================
 * 3. NO ERROR SURFACE LEAKS INTERNALS
 * ================================================================================== */

describe("no error surface can leak internals", () => {
    const SURFACES = [...BOUNDARIES, ...ERROR_COMPONENTS, "app/not-found.tsx"];

    it.each(SURFACES)("%s does not render stack traces or internals", (file) => {
        const code = readCode(file);

        expect(code).not.toMatch(/\.stack\b/);
        expect(code).not.toContain("PrismaClient");
        expect(code).not.toContain("process.env");
        expect(code).not.toContain("AUTH_SECRET");
        expect(code).not.toMatch(/\{error\.message\}/);
    });

    it("the one place an error message is logged is the browser console, with the digest", () => {
        const fallback = readCode("components/errors/ErrorBoundaryFallback.tsx");

        expect(fallback).toContain("console.error");
        expect(fallback).toContain("digest");

        // The message is logged, not RENDERED.
        expect(fallback).not.toMatch(/>\s*\{error\.message\}/);
    });
});

/* ==================================================================================
 * 4. NO PAGE CONVERTS A FAILURE INTO A 404 ANY MORE
 * ================================================================================== */

describe("buyer pages classify failures instead of swallowing them", () => {
    const ORDER_PAGE = "app/ticketing/orders/[orderNumber]/page.tsx";
    const TICKET_PAGE = "app/ticketing/tickets/[ticketCode]/page.tsx";

    it.each([ORDER_PAGE, TICKET_PAGE])("%s no longer swallows the failure", (file) => {
        const code = readCode(file);

        // The old shape, verbatim. This is the defect.
        expect(code).not.toMatch(/\.catch\(\(\) => null\)/);
        expect(code).not.toMatch(/catch\s*\{\s*notFound\(\);\s*\}/);

        // And the replacement is present.
        expect(code).toContain("resolvePageFailure");
    });

    it.each([ORDER_PAGE, TICKET_PAGE])("%s renders a retryable state for an outage", (file) => {
        const code = readCode(file);

        expect(code).toContain('failure.action === "unavailable"');
        expect(code).toContain("ServiceUnavailableState");

        // The 404 branches are explicit and narrow.
        expect(code).toContain('failure.action === "not-found"');
    });

    it.each([
        "app/ticketing/tickets/page.tsx",
        "app/ticketing/refunds/page.tsx",
    ])("%s distinguishes a refusal from a failure", (file) => {
        const code = readCode(file);

        expect(code).not.toMatch(/\.catch\(\(\) => null\)/);
        expect(code).toContain("resolvePageFailure");
        expect(code).toContain('failure.action === "unavailable"');
        expect(code).toContain('failure.action !== "denied"');
    });

    it("the public event page does not report an outage as a missing event", () => {
        const code = readCode("app/e/[slug]/page.tsx");

        expect(code).not.toMatch(/getPublicEventBySlug\(slug, origin\)\.catch\(\(\) => null\)/);
        expect(code).toContain("resolvePageFailure");
        expect(code).toContain("notFound()");
    });
});

/* ==================================================================================
 * 5. THE SESSION-GATED PAGES RETURN THE BUYER WHERE THEY WERE
 * ================================================================================== */

describe("login returns the buyer to the page they were on", () => {
    const GATED_PAGES = [
        "app/ticketing/orders/[orderNumber]/page.tsx",
        "app/ticketing/tickets/page.tsx",
        "app/ticketing/tickets/[ticketCode]/page.tsx",
        "app/ticketing/refunds/page.tsx",
    ];

    it.each(GATED_PAGES)("%s uses the shared login-URL helper", (file) => {
        const code = readCode(file);

        // The bug: these pages built `?next=`, while the form (and the proxy) read
        // `callbackUrl`. Every interrupted buyer silently landed on the dashboard.
        expect(code).not.toContain("login?next=");
        expect(code).toContain("loginUrlFor(");
    });

    it("the helper writes the key the login form actually reads", () => {
        const redirect = readCode("lib/auth/redirect.ts");
        const form = readCode("components/auth/LoginForm.tsx");

        expect(redirect).toContain("`/login?callbackUrl=${encodeURIComponent(safe)}`");
        expect(form).toContain('"callbackUrl"');
    });
});
