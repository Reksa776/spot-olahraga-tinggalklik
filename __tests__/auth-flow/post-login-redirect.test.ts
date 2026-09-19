import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
    DEFAULT_POST_LOGIN_PATH,
    postLoginDestination,
    resolveSafeCallbackUrl,
} from "@/lib/auth/redirect";
// Imported from the PURE vocabulary module, not the `@/lib/authz` barrel: the barrel pulls in
// the guards, which pull in `@/auth` (and therefore `next-auth`'s ESM entrypoint). This suite
// needs the permission strings, not a session.
import { PERMISSIONS } from "@/lib/authz/permissions";

/**
 * ==========================================
 * LOGIN → DASHBOARD (REDIRECT + OPEN-REDIRECT GUARD)
 * ==========================================
 *
 * Two things are pinned here and they are different kinds of claim:
 *
 *   1. `resolveSafeCallbackUrl` / `postLoginDestination` are PURE, so every malicious
 *      `callbackUrl` shape is exercised directly rather than argued about in a comment.
 *   2. the wiring is asserted against the real sources — the login form navigates with the
 *      sanitised destination, the proxy builds `callbackUrl` from the request PATH (never from
 *      anything the client supplied), and `/dashboard` is the only back office.
 *
 * The database-backed half of the story (who actually HAS dashboard access) lives in
 * `__tests__/auth-flow/dashboard-access.integration.test.ts`.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
    return existsSync(path.join(ROOT, relativePath));
}

/** Strip comments, so a doc comment that NAMES a bad value is not mistaken for code. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

/* ==================================================================================
 * 1. THE DEFAULT DESTINATION
 * ================================================================================== */

describe("login lands on the consolidated dashboard", () => {
    it("defaults to /dashboard when no callback was supplied", () => {
        expect(DEFAULT_POST_LOGIN_PATH).toBe("/dashboard");
        expect(postLoginDestination(null)).toBe("/dashboard");
        expect(postLoginDestination(undefined)).toBe("/dashboard");
        expect(postLoginDestination("")).toBe("/dashboard");
        expect(postLoginDestination("   ")).toBe("/dashboard");
    });

    it("never defaults to a retired or public destination", () => {
        // The retired back offices and the public homepage are not post-login destinations.
        for (const retired of ["/", "/platform", "/organizer", "/admin", "/home"]) {
            expect(postLoginDestination(null)).not.toBe(retired);
        }
    });
});

/* ==================================================================================
 * 2. A VALID CALLBACK IS HONOURED (test 5)
 * ================================================================================== */

describe("a valid callbackUrl is honoured", () => {
    it("returns the interrupted dashboard path", () => {
        expect(postLoginDestination("/dashboard/events")).toBe("/dashboard/events");
        expect(postLoginDestination("/dashboard/orders/ORD-1")).toBe(
            "/dashboard/orders/ORD-1"
        );
        expect(postLoginDestination("/dashboard/pic")).toBe("/dashboard/pic");
    });

    it("preserves the query string", () => {
        expect(postLoginDestination("/dashboard/payments?status=PAID")).toBe(
            "/dashboard/payments?status=PAID"
        );
    });

    it("preserves a hash", () => {
        expect(postLoginDestination("/dashboard/reports#summary")).toBe(
            "/dashboard/reports#summary"
        );
    });

    it("accepts every non-dashboard internal path too, since the guard is origin, not prefix", () => {
        // The ticketing wallet is a legitimate interrupted destination.
        expect(postLoginDestination("/ticketing/tickets")).toBe("/ticketing/tickets");
    });

    it("ignores surrounding whitespace rather than rejecting the value", () => {
        expect(postLoginDestination("  /dashboard/events  ")).toBe("/dashboard/events");
    });
});

/* ==================================================================================
 * 3. THE OPEN-REDIRECT GUARD (test 6)
 * ================================================================================== */

describe("a malicious callbackUrl can never navigate off-origin", () => {
    const MALICIOUS = [
        // Absolute URLs, with and without a scheme-looking prefix.
        "https://evil.example",
        "http://evil.example",
        "https://evil.example/dashboard",
        // Protocol-relative: resolves to another origin while looking like a path.
        "//evil.example",
        "//evil.example/dashboard",
        "///evil.example",
        // Scheme payloads that are not paths at all.
        "javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        // Backslash: some browsers normalise "\\" to "/", which would turn a "path" into
        // an authority ("/\\evil.example" → "//evil.example").
        "/\\evil.example",
        "/\\/evil.example",
        // Control characters / smuggling.
        "/dashboard\nLocation: https://evil.example",
        "/dashboard\r\nSet-Cookie: x=1",
        "/dashboard\u0000",
        // Not a path at all.
        "dashboard",
        "?next=/dashboard",
        "#/dashboard",
        "mailto:someone@example.com",
    ];

    it.each(MALICIOUS)("rejects %j", (value) => {
        expect(resolveSafeCallbackUrl(value)).toBeNull();
        // And crucially: the rejection FALLS BACK to the dashboard rather than passing the
        // bad value through.
        expect(postLoginDestination(value)).toBe(DEFAULT_POST_LOGIN_PATH);
    });

    it("rejects non-string input", () => {
        expect(resolveSafeCallbackUrl(null)).toBeNull();
        expect(resolveSafeCallbackUrl(undefined)).toBeNull();
        // @ts-expect-error — defending against a non-string runtime value.
        expect(resolveSafeCallbackUrl(42)).toBeNull();
    });

    it("rejects the login pages themselves, which would loop the user", () => {
        for (const loop of [
            "/login",
            "/login?callbackUrl=/dashboard",
            "/register",
            "/register?x=1",
        ]) {
            expect(resolveSafeCallbackUrl(loop)).toBeNull();
        }
    });

    it("does not accept a same-host absolute URL either — only a path", () => {
        // Even an absolute URL to OUR OWN host is refused: the app must not depend on
        // knowing its public origin to decide this, and a path is all it ever needs.
        expect(resolveSafeCallbackUrl("https://internal.invalid/dashboard")).toBeNull();
    });
});

/* ==================================================================================
 * 4. WIRING — THE FORM
 * ================================================================================== */

describe("the login form navigates to the sanitised destination", () => {
    const form = read("components/auth/LoginForm.tsx");
    const code = readCode("components/auth/LoginForm.tsx");

    it("uses the shared helper for every navigation", () => {
        expect(form).toContain('from "@/lib/auth/redirect"');
        expect(form).toContain("postLoginDestination(");

        // Credentials path, already-authenticated path, and the Google path all funnel
        // through the helper — three call sites.
        const calls = code.match(/postLoginDestination\(/g) ?? [];
        expect(calls.length).toBeGreaterThanOrEqual(3);
    });

    it("never reads the callback into a navigation unchecked", () => {
        // The raw value may only appear as the ARGUMENT to the helper, never as the
        // argument of router.replace / signIn callbackUrl directly.
        expect(code).not.toMatch(/router\.replace\(\s*(?:readCallbackUrl\(\)|callbackUrl)/);
        expect(code).not.toMatch(/callbackUrl:\s*(?:readCallbackUrl\(\)|callbackUrl)\b/);
    });

    it("no longer redirects to the homepage or a retired back office after login", () => {
        expect(code).not.toContain('router.replace("/")');
        expect(code).not.toContain('router.push("/")');
        expect(code).not.toContain('callbackUrl: "/"');

        for (const retired of ["/platform", "/organizer", "/admin"]) {
            expect(code).not.toContain(`"${retired}`);
        }
    });

    it("keeps a failed login on the login page", () => {
        // The error branch must return before any navigation.
        const errorBranch = code.slice(
            code.indexOf("if (result?.error)"),
            code.indexOf("toast.success")
        );

        expect(errorBranch).toContain("return;");
        expect(errorBranch).not.toContain("router.replace");
    });

    it("does not print session contents to the console", () => {
        // A `console.log(session)` leaks the token-bearing session object into the browser
        // console and any log-capturing extension.
        expect(code).not.toMatch(/console\.log\(\s*[^)]*session/i);
    });

    it("reads the callback from the URL, not from a suspicious source", () => {
        // No localStorage / sessionStorage / cookie-based redirect decision.
        expect(code).not.toContain("localStorage");
        expect(code).not.toContain("sessionStorage");
        expect(code).not.toMatch(/document\.cookie/);
    });
});

/* ==================================================================================
 * 5. WIRING — THE PROXY
 * ================================================================================== */

describe("the proxy protects the dashboard and builds an internal callbackUrl", () => {
    const proxy = read("proxy.ts");

    it("lists /dashboard as a protected page route", () => {
        const match = proxy.match(/PROTECTED_PAGE_ROUTES[^=]*=\s*\[([\s\S]*?)\]/);

        expect(match).not.toBeNull();

        const routes = [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);

        expect(routes).toContain("/dashboard");
        expect(routes).toContain("/ticketing");
    });

    it("matchers cover the whole dashboard subtree", () => {
        expect(proxy).toContain('"/dashboard/:path*"');
    });

    it("builds callbackUrl from the request PATH only", () => {
        // `pathname` is derived from the request URL, never from a query parameter, a body
        // or a header — so a client cannot choose where login returns them.
        expect(proxy).toMatch(/searchParams\.set\(\s*"callbackUrl"\s*,\s*pathname\s*\)/);

        // The value is set from the local variable, not read from the incoming search.
        expect(proxy).not.toMatch(/searchParams\.get\(\s*"callbackUrl"\s*\)/);
    });

    it("redirects an anonymous visitor with an ABSOLUTE Location", () => {
        // Not a style preference — a constraint of the runtime. Next.js parses this header
        // with `new URL()`, so emitting a relative Location throws `ERR_INVALID_URL` and
        // every gated page answers 500 instead of redirecting. Verified by running a
        // production build and curling an anonymous `/dashboard`.
        //
        // The consequence is that the origin here comes from AUTH_URL (next-auth overwrites
        // `req.url` with it), so AUTH_URL has to be correct per environment. Rebuilding the
        // origin from Host / x-forwarded-host instead would introduce host-header-injection
        // redirects, which is worse.
        expect(proxy).toContain('new URL("/login", req.url)');

        // And nothing READS a forwarded host to rebuild the origin (prose in the comment
        // above may name the header; an actual read is what would open host-header
        // injection).
        expect(proxy).not.toMatch(/headers\.get\(\s*["']x-forwarded-host/);
    });
});

/* ==================================================================================
 * 6. THE DASHBOARD IS THE ONLY BACK OFFICE (test 16 / architecture rule)
 * ================================================================================== */

describe("there is exactly one dashboard", () => {
    it("has a dashboard layout, and no second back office", () => {
        expect(exists("app/dashboard/layout.tsx")).toBe(true);

        // The architecture rule from the brief: no `/admin/dashboard`,
        // `/platform/dashboard` or `/organizer/dashboard`.
        for (const forbidden of [
            "app/admin/dashboard",
            "app/platform/dashboard",
            "app/organizer/dashboard",
            "app/admin",
            "app/platform",
            "app/organizer",
        ]) {
            expect(exists(forbidden)).toBe(false);
        }
    });

    it("the guarded permissions are the ones the dashboard layout uses", () => {
        // The permission names this suite reasons about must be the real ones, so a rename
        // cannot silently make these assertions vacuous.
        expect(PERMISSIONS.EVENT_READ).toBe("event.read");
        expect(PERMISSIONS.ORDER_READ_TENANT).toBe("order.read.tenant");
        expect(PERMISSIONS.PIC_MANAGE).toBe("pic.manage");
    });

    it("logout still invalidates the session and re-requires login for /dashboard", () => {
        // The shells sign out to the public site; the session cookie is cleared by Auth.js.
        // Re-opening /dashboard then hits the proxy, which has no session and redirects.
        for (const shell of [
            "components/dashboard/DashboardShell.tsx",
            "components/dashboard/DashboardNav.tsx",
        ]) {
            expect(read(shell)).toContain('signOut({ callbackUrl: "/" })');
        }

        // And the dashboard is still in the protected page list, so the "login required"
        // outcome does not depend on the browser or on any cached render.
        expect(read("proxy.ts")).toMatch(/PROTECTED_PAGE_ROUTES[\s\S]*?"\/dashboard"/);
    });
});
