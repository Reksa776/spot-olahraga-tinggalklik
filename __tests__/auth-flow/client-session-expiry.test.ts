import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import {
    SESSION_EXPIRED_STATUS,
    UNAUTHORIZED_CODE,
    isSessionExpired,
    loginUrlForCurrentPage,
    redirectToLoginForExpiredSession,
} from "@/lib/auth/client-session";

/**
 * ==========================================
 * A 401 IS A SESSION STATE, NOT A FAILED ACTION
 * ==========================================
 *
 * The buyer's order page is a row of client buttons that POST to ownership-scoped API routes.
 * A session can end while that page is open, and every one of those buttons used to render the
 * server's `401` message beside itself as an inline error — "Silakan login terlebih dahulu."
 * The visitor was left on a page that could not work, next to a control that would keep failing,
 * in the same visual slot where a payment refusal appears. It is not hard to read that as "my
 * payment was refused".
 *
 * Three claims are pinned here:
 *
 *   1. CLASSIFICATION. Only 401 (or the explicit `UNAUTHORIZED` code) is an expiry. A 403 is an
 *      authorization decision, a 409 is a business state, a 5xx is a system fault — treating any
 *      of them as "please sign in" would hide a real refusal behind a login screen.
 *   2. THE RETURN PATH. The visitor lands back on the page they were on after signing in, and
 *      the value handed to the login page can only ever be a same-origin path — never an
 *      origin, never `/login` (which would loop).
 *   3. THE WIRING. All four action buttons branch on the expiry BEFORE their error branch, and
 *      the expiry branch neither reports a business failure nor claims a payment succeeded.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Every client control that POSTs to a protected ticketing route and can therefore meet an expired
 * session: the four order/ticket actions (ownership-scoped) plus the checkout form itself
 * (`/api/ticketing/checkout`).
 *
 * The checkout form is listed because it was the one that got this wrong. It was missed by the
 * Phase 24 sweep and kept building `/login?next=<path>` — a parameter nothing reads any more — so an
 * interrupted checkout silently lost its return path while every sibling control preserved one.
 */
const ACTION_COMPONENTS = [
    "components/orders/PayNowButton.tsx",
    "components/orders/CancelOrderButton.tsx",
    "components/orders/RequestRefundButton.tsx",
    "components/tickets/IssueTicketsButton.tsx",
    "components/events/TicketPurchaseForm.tsx",
] as const;

/** Application source that could build a login URL. Documentation and tests are not application source. */
const APPLICATION_SOURCES = ["app", "components", "lib"] as const;

function walkSources(relativeDir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(path.join(ROOT, relativeDir), { withFileTypes: true })) {
        const child = `${relativeDir}/${entry.name}`;

        if (entry.isDirectory()) walkSources(child, out);
        else if (/\.(ts|tsx)$/.test(entry.name)) out.push(child);
    }

    return out;
}

/* ==================================================================================
 * 1. WHAT COUNTS AS AN EXPIRED SESSION
 * ================================================================================== */

describe("only a 401 is treated as an expired session", () => {
    it("recognises the expiry", () => {
        expect(isSessionExpired(SESSION_EXPIRED_STATUS)).toBe(true);
        expect(SESSION_EXPIRED_STATUS).toBe(401);
        expect(isSessionExpired(401, { code: UNAUTHORIZED_CODE })).toBe(true);
    });

    it("recognises the API code even if the status were ever wrong", () => {
        expect(UNAUTHORIZED_CODE).toBe("UNAUTHORIZED");
        expect(isSessionExpired(500, { code: "UNAUTHORIZED" })).toBe(true);
    });

    it.each([403, 404, 409, 402, 429, 500, 503, 504, 200])(
        "%i is NOT a session expiry — it is a refusal, a conflict or a fault",
        (status) => {
            expect(isSessionExpired(status)).toBe(false);
        }
    );

    it("does not treat an unrelated error code as an expiry", () => {
        for (const code of [
            "FORBIDDEN",
            "NOT_FOUND",
            "CONFLICT",
            "PAYMENT_FAILED",
            "DATABASE_UNAVAILABLE",
            "INTERNAL_ERROR",
        ]) {
            expect(isSessionExpired(400, { code })).toBe(false);
        }
    });

    it("handles a missing or malformed payload without throwing", () => {
        expect(isSessionExpired(401, null)).toBe(true);
        expect(isSessionExpired(401, undefined)).toBe(true);
        expect(isSessionExpired(200, null)).toBe(false);
    });
});

/* ==================================================================================
 * 2. THE RETURN PATH CANNOT BE HOSTILE
 * ================================================================================== */

describe("the login URL points back at the current page, as a path only", () => {
    it("builds /login?callbackUrl=<current path>", () => {
        expect(
            loginUrlForCurrentPage({
                pathname: "/ticketing/orders/EVT-1789839425778-fec07c44",
                search: "",
            })
        ).toBe(
            "/login?callbackUrl=%2Fticketing%2Forders%2FEVT-1789839425778-fec07c44"
        );
    });

    it("preserves the query string of the current page", () => {
        expect(
            loginUrlForCurrentPage({ pathname: "/ticketing/refunds", search: "?page=3" })
        ).toBe(`/login?callbackUrl=${encodeURIComponent("/ticketing/refunds?page=3")}`);
    });

    it("never emits the retired `?next=` key", () => {
        const url = loginUrlForCurrentPage({ pathname: "/ticketing/tickets", search: "" });

        expect(url).toContain("callbackUrl=");
        expect(url).not.toContain("next=");
    });

    it("contains no origin, absolute or protocol-relative value", () => {
        const url = loginUrlForCurrentPage({ pathname: "/ticketing/tickets", search: "" });

        // The login page must not be told where to come back to in absolute form; a path is all
        // it needs, and a path cannot point at another site.
        expect(url.startsWith("/login?")).toBe(true);
        expect(url).not.toMatch(/https?:\/\//);
        expect(url).not.toContain("//evil");

        for (const hostile of ["https://evil.example", "//evil.example", "javascript:alert(1)"]) {
            expect(loginUrlForCurrentPage({ pathname: hostile, search: "" })).toBe("/login");
        }
    });

    it("is built in application source by exactly one shared helper, never by hand", () => {
        /*
         * `?next=` is read by nobody: `app/login/page.tsx` reads `callbackUrl`, `proxy.ts` writes
         * `callbackUrl`, and `lib/auth/redirect.ts` documents `next` as ignored. A call site that
         * still writes it does not fail loudly — it silently drops the return path, which is what
         * `components/events/TicketPurchaseForm.tsx` did on the page a buyer interrupts by signing
         * in. Comments are stripped first, because the modules that explain the retirement name the
         * old parameter on purpose.
         */
        const offenders = APPLICATION_SOURCES.flatMap((dir) => walkSources(dir)).filter((file) =>
            /next=/.test(readCode(file))
        );

        expect(offenders).toEqual([]);
    });

    it("degrades to a bare /login rather than looping", () => {
        // No location at all (a server render, or a test that passes nothing).
        expect(loginUrlForCurrentPage(null)).toBe("/login");

        // The auth pages themselves are never a post-login destination — that would loop.
        expect(loginUrlForCurrentPage({ pathname: "/login", search: "" })).toBe("/login");
        expect(loginUrlForCurrentPage({ pathname: "/register", search: "" })).toBe("/login");
    });
});

/* ==================================================================================
 * 3. THE NAVIGATION ITSELF
 * ================================================================================== */

describe("redirectToLoginForExpiredSession", () => {
    const originalWindow = (globalThis as { window?: unknown }).window;

    afterEach(() => {
        if (originalWindow === undefined) {
            delete (globalThis as { window?: unknown }).window;
        } else {
            (globalThis as { window?: unknown }).window = originalWindow;
        }
    });

    it("is a no-op outside the browser, so an accidental call cannot throw", () => {
        delete (globalThis as { window?: unknown }).window;

        expect(() => redirectToLoginForExpiredSession()).not.toThrow();
    });

    it("assigns the login URL for the current page", () => {
        const assign = jest.fn();

        (globalThis as { window?: unknown }).window = {
            location: {
                pathname: "/ticketing/orders/EVT-1",
                search: "?tab=payment",
                assign,
            },
        };

        redirectToLoginForExpiredSession();

        expect(assign).toHaveBeenCalledTimes(1);
        expect(assign).toHaveBeenCalledWith(
            `/login?callbackUrl=${encodeURIComponent("/ticketing/orders/EVT-1?tab=payment")}`
        );
    });

    it("uses a document navigation, so the fresh session is what the login page reads", () => {
        // `window.location.assign` rather than `router.replace`: the session cookie changed on
        // the server, and a soft navigation would re-use the router cache and the in-memory tree
        // of a page rendered for the previous session.
        const code = readCode("lib/auth/client-session.ts");

        expect(code).toContain("window.location.assign");
        expect(code).not.toContain("router.replace");
    });
});

/* ==================================================================================
 * 4. THE MODULE IS CLIENT-SAFE
 * ================================================================================== */

describe("the client helper pulls in nothing server-only", () => {
    it("imports neither the server session, Prisma nor next/server", () => {
        const code = readCode("lib/auth/client-session.ts");

        for (const forbidden of [
            'from "@/auth"',
            "@/lib/prisma",
            "next/server",
            "@/lib/authz",
            "prisma.",
        ]) {
            expect(code).not.toContain(forbidden);
        }
    });

    it("routes its URL construction through the shared validator", () => {
        const code = readCode("lib/auth/client-session.ts");

        // One validator for both the server pages and the browser: if `loginUrlFor` ever gains a
        // rule, this path gains it too.
        expect(code).toContain('from "./redirect"');
        expect(code).toContain("loginUrlFor(");
    });
});

/* ==================================================================================
 * 5. THE WIRING — THE EXPIRY BRANCH COMES FIRST, AND REPORTS NOTHING
 * ================================================================================== */

describe("every action control handles an expired session before its error branch", () => {
    it.each(ACTION_COMPONENTS)("%s exists", (file) => {
        expect(read(file).length).toBeGreaterThan(0);
    });

    it.each(ACTION_COMPONENTS)("%s branches on the expiry before the generic failure", (file) => {
        const code = readCode(file);

        const expiryAt = code.indexOf("isSessionExpired(response.status, payload)");
        const genericAt = code.indexOf("if (!response.ok)");

        expect(expiryAt).toBeGreaterThan(-1);
        expect(genericAt).toBeGreaterThan(-1);

        // Order matters: a later branch cannot save a response already reported as a failure.
        expect(expiryAt).toBeLessThan(genericAt);
    });

    it.each(ACTION_COMPONENTS)("%s sends the visitor to sign in and returns", (file) => {
        const code = readCode(file);

        const branch = code.slice(
            code.indexOf("isSessionExpired(response.status, payload)"),
            code.indexOf("if (!response.ok)")
        );

        expect(branch).toContain("redirectToLoginForExpiredSession();");
        expect(branch).toContain("return;");

        // Nothing is claimed about the action, and no local state is mutated as if it had
        // permanently failed. A 401 has to leave the page exactly as it was.
        expect(branch).not.toContain("setError(");
        expect(branch).not.toContain("setResult(");
        expect(branch).not.toContain("router.refresh(");
    });

    it.each(ACTION_COMPONENTS)(
        "%s never renders an error in the expiry branch immediately after it",
        (file) => {
            const code = readCode(file);

            // The generic branch (which DOES render the server's message) begins at least one
            // statement after the expiry branch, so the two can never be the same block.
            const expiryAt = code.indexOf("isSessionExpired(response.status, payload)");
            const genericAt = code.indexOf("if (!response.ok)");

            expect(code.slice(expiryAt, genericAt).trim().length).toBeGreaterThan(0);
        }
    );

    it("the payment button cannot imply settlement on an expiry", () => {
        const branch = readCode("components/orders/PayNowButton.tsx");

        const expiryBranch = branch.slice(
            branch.indexOf("isSessionExpired(response.status, payload)"),
            branch.indexOf("if (!response.ok)")
        );

        // No provider call, no navigation to a payment URL, no success path.
        for (const forbidden of [
            "window.location.href = url",
            "paymentUrl",
            "setError(",
            "berhasil",
            "lunas",
        ]) {
            expect(expiryBranch).not.toContain(forbidden);
        }
    });
});
