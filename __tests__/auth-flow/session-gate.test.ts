import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
    decideSessionGate,
    readCallbackUrlParam,
} from "@/lib/auth/session-gate";
import { resolveAuthzScope } from "@/lib/authz/scope";

/**
 * ==========================================
 * THE AUTH PAGES ARE GATED ON THE SERVER
 * ==========================================
 *
 * `/login` and `/register` are the only two pages whose answer for an already-authenticated
 * visitor is a redirect rather than a render. Both used to decide that in the browser — a
 * `useEffect` session check in each form — which meant a signed-in visitor was sent a full form
 * and then moved away from it a frame later.
 *
 * Two different kinds of claim are pinned here, and they are deliberately separated:
 *
 *   1. THE DECISION is a pure function (`decideSessionGate`), so every role, every hostile
 *      `callbackUrl` and the anonymous/deleted-user case are exercised directly, with no session
 *      and no database.
 *   2. THE WIRING is asserted against the real page sources, because a correct decision nobody
 *      calls is exactly the Phase 23A defect: the classifier was right and the page swallowed
 *      it anyway.
 *
 * The database-backed half — that a token whose user was deleted resolves to `null`, and is
 * therefore shown the form instead of being looped between `/login` and `/dashboard` — runs the
 * REAL `resolveAuthzScope` against the test database at the bottom of this file.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function exists(relativePath: string): boolean {
    return existsSync(path.join(ROOT, relativePath));
}

/** Strip comments, so prose that NAMES a pattern is not mistaken for the pattern. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

const AUTH_PAGES = ["app/login/page.tsx", "app/register/page.tsx"] as const;

/** The path each role's own surface lives at, from the pure intent table. */
const ROLE_DESTINATIONS = [
    ["ADMIN", "/dashboard"],
    ["MANAGER", "/dashboard"],
    ["PIC", "/dashboard/pic"],
    ["CUSTOMER", "/ticketing/tickets"],
] as const;

/* ==================================================================================
 * 1. THE DECISION — EVERY ROLE
 * ================================================================================== */

describe("an authenticated visitor is redirected to their own surface", () => {
    it.each(ROLE_DESTINATIONS)(
        "a %s session is sent to %s",
        (platformRole, destination) => {
            expect(decideSessionGate({ platformRole }, null)).toEqual({
                action: "redirect",
                to: destination,
            });
        }
    );

    it("treats a null platformRole as the buyer surface, exactly as the scope does", () => {
        // `User.platformRole` is nullable; the scope resolver maps null to CUSTOMER. The gate
        // must agree, or it would send an account somewhere its own guards refuse.
        expect(decideSessionGate({ platformRole: null }, null)).toEqual({
            action: "redirect",
            to: "/ticketing/tickets",
        });
    });

    it("never redirects an anonymous visitor", () => {
        // The normal case: no session at all.
        expect(decideSessionGate(null, null)).toEqual({ action: "render-form" });
        expect(decideSessionGate(undefined, null)).toEqual({ action: "render-form" });
    });

    it("never redirects a session whose user no longer exists", () => {
        // `getAuthzScope` returns null for a JWT whose `User` row is gone (the guards are
        // fail-closed on the same value). Redirecting here would bounce the visitor between
        // /login and a gated page forever, so the form — the one screen that can fix it — is
        // what must render. Proven against the real database in section 5.
        expect(decideSessionGate(null, "/ticketing/tickets")).toEqual({
            action: "render-form",
        });
    });

    it("does not consult the login screen's role selector", () => {
        // There is no parameter for it. The role comes from the scope; the entrance a visitor
        // clicked can therefore never widen the destination.
        expect(decideSessionGate({ platformRole: "CUSTOMER" }, null)).toEqual({
            action: "redirect",
            to: "/ticketing/tickets",
        });

        expect(decideSessionGate.length).toBe(2);
    });
});

/* ==================================================================================
 * 2. THE CALLBACK — HONOURED WHEN SAFE, IGNORED WHEN HOSTILE
 * ================================================================================== */

describe("the interrupted destination is preserved, and validated", () => {
    it("returns a signed-in visitor to the page they were bounced from", () => {
        for (const [platformRole] of ROLE_DESTINATIONS) {
            expect(
                decideSessionGate({ platformRole }, "/ticketing/orders/EVT-1789839425778-fec07c44")
            ).toEqual({
                action: "redirect",
                to: "/ticketing/orders/EVT-1789839425778-fec07c44",
            });
        }
    });

    it("preserves a query string on the interrupted path", () => {
        expect(
            decideSessionGate({ platformRole: "ADMIN" }, "/dashboard/payments?status=PAID")
        ).toEqual({ action: "redirect", to: "/dashboard/payments?status=PAID" });
    });

    it.each([
        "https://evil.example",
        "http://evil.example/dashboard",
        "//evil.example",
        "///evil.example",
        "javascript:alert(1)",
        "/\\evil.example",
        "/dashboard\nLocation: https://evil.example",
        "dashboard",
    ])("ignores the unsafe callback %j and uses the role's own surface", (hostile) => {
        expect(decideSessionGate({ platformRole: "PIC" }, hostile)).toEqual({
            action: "redirect",
            to: "/dashboard/pic",
        });
    });

    it("refuses a callback that would loop back to the auth pages", () => {
        for (const loop of ["/login", "/register", "/login?callbackUrl=/dashboard"]) {
            expect(decideSessionGate({ platformRole: "CUSTOMER" }, loop)).toEqual({
                action: "redirect",
                to: "/ticketing/tickets",
            });
        }
    });
});

/* ==================================================================================
 * 3. THE QUERY PARAMETER IS NORMALISED, NOT ASSUMED
 * ================================================================================== */

describe("readCallbackUrlParam", () => {
    it("passes a single value through, and validates nothing itself", () => {
        // Validation belongs to `resolveSafeCallbackUrl`; this only prevents an array from
        // reaching a helper that takes a string.
        expect(readCallbackUrlParam("/dashboard")).toBe("/dashboard");
        expect(readCallbackUrlParam("https://evil.example")).toBe("https://evil.example");
    });

    it("takes the first value of a repeated parameter", () => {
        expect(readCallbackUrlParam(["/dashboard", "/ticketing/tickets"])).toBe("/dashboard");
    });

    it.each([undefined, null, [], "", 42 as unknown as string])(
        "returns null for %j",
        (value) => {
            expect(readCallbackUrlParam(value as string | string[] | undefined)).toBeNull();
        }
    );

    it("works together with the decision for every shape a query can take", () => {
        expect(
            decideSessionGate({ platformRole: "ADMIN" }, readCallbackUrlParam(["/dashboard/events"]))
        ).toEqual({ action: "redirect", to: "/dashboard/events" });

        expect(decideSessionGate({ platformRole: "ADMIN" }, readCallbackUrlParam([]))).toEqual({
            action: "redirect",
            to: "/dashboard",
        });
    });
});

/* ==================================================================================
 * 4. THE WIRING — BOTH PAGES DECIDE BEFORE THEY RENDER
 * ================================================================================== */

describe("both auth pages gate on the server scope", () => {
    it.each(AUTH_PAGES)("%s exists and is a server component", (file) => {
        expect(exists(file)).toBe(true);

        // A client component cannot read the session cookie on the server, which is the whole
        // point of the gate.
        expect(readCode(file)).not.toContain('"use client"');
    });

    it.each(AUTH_PAGES)("%s resolves the scope, not a client-supplied role", (file) => {
        const code = readCode(file);

        expect(code).toContain("getAuthzScope()");
        expect(code).toContain("decideSessionGate(");
        expect(code).toContain("redirect(decision.to)");

        // The role may only ever come from the resolved scope. No query parameter, header,
        // cookie or body is a source of authority.
        expect(code).not.toMatch(/searchParams\)?\s*\.(role|platformRole|permissions)/);
        expect(code).not.toContain('"role"');
        expect(code).not.toContain("platformRole:");
    });

    it.each(AUTH_PAGES)("%s redirects BEFORE it renders the form", (file) => {
        const code = readCode(file);

        const redirectAt = code.indexOf("redirect(decision.to)");
        const renderAt = code.indexOf("return <");

        expect(redirectAt).toBeGreaterThan(-1);
        expect(renderAt).toBeGreaterThan(-1);

        // The anti-flash guarantee: no path returns the form without having decided first.
        expect(renderAt).toBeGreaterThan(redirectAt);
    });

    it.each(AUTH_PAGES)("%s reads the callback from searchParams, not from a header", (file) => {
        const code = readCode(file);

        expect(code).toContain("readCallbackUrlParam");
        expect(code).toContain("await searchParams");

        // No header sniffing: `x-forwarded-host`/`referer` would make the return path
        // attacker-controlled.
        expect(code).not.toContain("headers()");
        expect(code).not.toContain("x-forwarded-host");
    });

    it("keeps the forms' client-side checks as fallbacks rather than removing them blind", () => {
        // Not a duplication: the server gate cannot cover a session created after this HTML was
        // served. Both paths call the same pure helpers, so they cannot disagree.
        for (const file of [
            "components/auth/LoginForm.tsx",
            "components/auth/RegisterForm.tsx",
        ]) {
            const code = readCode(file);

            expect(code).toContain("getSession()");
            expect(code).toContain('"use client"');
        }
    });
});

/* ==================================================================================
 * 5. THE DELETED-USER CASE, AGAINST THE REAL DATABASE
 * ================================================================================== */

describe("a session whose user is gone falls through to the form", () => {
    jest.setTimeout(60000);

    it("resolves no scope for a user id that does not exist, and therefore renders the form", async () => {
        // This is the exact value `app/login/page.tsx` passes to the gate when the cookie is
        // valid but the row is gone — the case that would otherwise loop.
        const scope = await resolveAuthzScope(
            `deleted-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        );

        expect(scope).toBeNull();
        expect(decideSessionGate(scope, "/dashboard")).toEqual({ action: "render-form" });
    });
});
