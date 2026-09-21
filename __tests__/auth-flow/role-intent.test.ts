import { readFileSync } from "node:fs";
import path from "node:path";

import {
    DEFAULT_LOGIN_ROLE_INTENT,
    LOGIN_ROLE_INTENTS,
    LOGIN_ROLE_INTENT_META,
    defaultDestinationForIntent,
    intentForPlatformRole,
    intentMatchesRole,
    isLoginRoleIntent,
    parseLoginRoleIntent,
} from "@/lib/auth/roles";
import {
    DEFAULT_POST_LOGIN_PATH,
    loginUrlFor,
    postLoginDestination,
    resolveSafeCallbackUrl,
} from "@/lib/auth/redirect";

/**
 * ==========================================
 * FOUR ROLES, ONE LOGIN, NO CLIENT-SIDE AUTHORITY
 * ==========================================
 *
 * The role selector is the newest attack surface in the application, and the claim being
 * tested is that it is not one:
 *
 *   1. The vocabulary is EXACTLY the four existing platform roles. No role is invented, and
 *      no retired retail role (`SELLER`, `AFFILIATOR`) is resurrected as an entrance.
 *   2. Every entrance only ever produces a SAFE SAME-ORIGIN PATH. The selector can move a
 *      browser and nothing else.
 *   3. The credentials request carries an identifier and a password — no role, in any
 *      spelling. Asserted against the real source of `LoginForm`, because "we do not send it"
 *      is a property of the code, not of a promise.
 *   4. The SERVER never reads a role from the request. Asserted against `auth.ts`.
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

/* ==================================================================================
 * 1. THE VOCABULARY
 * ================================================================================== */

describe("the login vocabulary is exactly the four platform roles", () => {
    it("lists ADMIN, MANAGER, PIC and CUSTOMER and nothing else", () => {
        expect([...LOGIN_ROLE_INTENTS].sort()).toEqual([
            "ADMIN",
            "CUSTOMER",
            "MANAGER",
            "PIC",
        ]);
    });

    it("does not resurrect a retired retail role as an entrance", () => {
        for (const retired of ["SELLER", "AFFILIATOR", "FINANCE", "CHECKIN_STAFF"]) {
            expect(isLoginRoleIntent(retired)).toBe(false);
        }
    });

    it("parses an unknown value to the default rather than throwing", () => {
        expect(parseLoginRoleIntent("ADMIN")).toBe("ADMIN");
        expect(parseLoginRoleIntent("admin")).toBe(DEFAULT_LOGIN_ROLE_INTENT);
        expect(parseLoginRoleIntent(null)).toBe(DEFAULT_LOGIN_ROLE_INTENT);
        expect(parseLoginRoleIntent(undefined)).toBe(DEFAULT_LOGIN_ROLE_INTENT);
        expect(parseLoginRoleIntent("SUPERUSER")).toBe(DEFAULT_LOGIN_ROLE_INTENT);
        expect(parseLoginRoleIntent(42)).toBe(DEFAULT_LOGIN_ROLE_INTENT);
    });

    it("exposes no `role.manage`-style capability through the intent vocabulary", () => {
        // The meta object describes an ENTRANCE. There is no field here that a server could
        // mistake for a grant.
        for (const intent of LOGIN_ROLE_INTENTS) {
            expect(Object.keys(LOGIN_ROLE_INTENT_META[intent]).sort()).toEqual([
                "caption",
                "destination",
                "label",
            ]);
        }
    });
});

/* ==================================================================================
 * 2. EVERY ENTRANCE RESOLVES TO A SAFE INTERNAL PATH
 * ================================================================================== */

describe("every intent destination is a safe same-origin path", () => {
    it.each(LOGIN_ROLE_INTENTS)("%s resolves to an internal path", (intent) => {
        const destination = defaultDestinationForIntent(intent);

        // The same validator that guards `callbackUrl` accepts it…
        expect(resolveSafeCallbackUrl(destination)).toBe(destination);

        // …and it is genuinely a path.
        expect(destination.startsWith("/")).toBe(true);
        expect(destination.startsWith("//")).toBe(false);
        expect(destination).not.toContain(":");
    });

    it.each(LOGIN_ROLE_INTENTS)("%s does not point at a retired back office", (intent) => {
        const destination = defaultDestinationForIntent(intent);

        for (const retired of ["/platform", "/organizer", "/admin"]) {
            expect(destination.startsWith(retired)).toBe(false);
        }
    });

    it("the two back-office entrances share the one dashboard", () => {
        expect(defaultDestinationForIntent("ADMIN")).toBe("/dashboard");
        expect(defaultDestinationForIntent("MANAGER")).toBe("/dashboard");

        // And each of the four lands somewhere that gates itself server-side.
        expect(defaultDestinationForIntent("PIC")).toBe("/dashboard/pic");
        expect(defaultDestinationForIntent("CUSTOMER")).toBe("/ticketing/tickets");
    });
});

/* ==================================================================================
 * 3. THE SELECTOR CANNOT ROUTE INTO A ROLE THE ACCOUNT DOES NOT HAVE
 * ================================================================================== */

describe("the destination is derived from the SERVER's role", () => {
    it("maps a null platformRole to CUSTOMER, exactly as the scope resolver does", () => {
        // `User.platformRole` is nullable; `resolveAuthzScope` maps null to CUSTOMER because a
        // null role holds no platform capability. The login screen must agree, or it would
        // announce a role the guards do not honour.
        expect(intentForPlatformRole(null)).toBe("CUSTOMER");
        expect(intentForPlatformRole(undefined)).toBe("CUSTOMER");
        expect(intentForPlatformRole("ADMIN")).toBe("ADMIN");
        expect(intentForPlatformRole("PIC")).toBe("PIC");
    });

    it("treats ADMIN and MANAGER as one back-office entrance and nothing more", () => {
        expect(intentMatchesRole("ADMIN", "MANAGER")).toBe(true);
        expect(intentMatchesRole("MANAGER", "ADMIN")).toBe(true);
        expect(intentMatchesRole("ADMIN", "ADMIN")).toBe(true);
    });

    it("reports a mismatch for any real role difference", () => {
        expect(intentMatchesRole("ADMIN", "CUSTOMER")).toBe(false);
        expect(intentMatchesRole("CUSTOMER", "ADMIN")).toBe(false);
        expect(intentMatchesRole("PIC", "CUSTOMER")).toBe(false);
        expect(intentMatchesRole("CUSTOMER", "PIC")).toBe(false);
        expect(intentMatchesRole("ADMIN", null)).toBe(false);
    });

    it("a customer who clicks Admin is routed to the customer surface", () => {
        // This is the escalation attempt, expressed as the navigation decision it actually is.
        const actual = intentForPlatformRole("CUSTOMER");

        expect(
            postLoginDestination(null, { intentDefault: actual })
        ).toBe("/ticketing/tickets");
    });
});

/* ==================================================================================
 * 4. THE DESTINATION HELPER — CALLBACK FIRST, INTENT LAST
 * ================================================================================== */

describe("postLoginDestination", () => {
    it("keeps its original default, so the Phase 9 contract is unbroken", () => {
        expect(DEFAULT_POST_LOGIN_PATH).toBe("/dashboard");
        expect(postLoginDestination(null)).toBe("/dashboard");
        expect(postLoginDestination(undefined)).toBe("/dashboard");
        expect(postLoginDestination("")).toBe("/dashboard");
    });

    it("lets a valid callback win over the chosen entrance", () => {
        expect(
            postLoginDestination("/ticketing/orders/EVT-1", { intentDefault: "ADMIN" })
        ).toBe("/ticketing/orders/EVT-1");
    });

    it("ignores an unsafe callback and still uses only the entrance's own path", () => {
        for (const hostile of [
            "https://evil.example",
            "//evil.example",
            "javascript:alert(1)",
            "/login",
            "/register",
        ]) {
            expect(postLoginDestination(hostile, { intentDefault: "CUSTOMER" })).toBe(
                "/ticketing/tickets"
            );
        }
    });

    it("uses the entrance default only when neither a callback nor a default applies", () => {
        expect(postLoginDestination(null, { intentDefault: "PIC" })).toBe("/dashboard/pic");
        expect(postLoginDestination(null, { intentDefault: "ADMIN" })).toBe("/dashboard");
    });
});

/* ==================================================================================
 * 5. THE LOGIN LINK HELPER (the `?next=` defect)
 * ================================================================================== */

describe("loginUrlFor", () => {
    it("writes the query key the login form actually reads", () => {
        expect(loginUrlFor("/ticketing/orders/EVT-1")).toBe(
            "/login?callbackUrl=%2Fticketing%2Forders%2FEVT-1"
        );
    });

    it("never emits the old, silently-ignored key", () => {
        expect(loginUrlFor("/ticketing/tickets")).not.toContain("next=");
    });

    it("refuses to embed anything that is not a same-origin path", () => {
        for (const hostile of [
            "https://evil.example",
            "//evil.example",
            "javascript:alert(1)",
            "/login",
            "",
            null,
            undefined,
        ]) {
            expect(loginUrlFor(hostile)).toBe("/login");
        }
    });

    it("preserves a query string on the interrupted path", () => {
        expect(loginUrlFor("/ticketing/refunds?page=3")).toBe(
            `/login?callbackUrl=${encodeURIComponent("/ticketing/refunds?page=3")}`
        );
    });
});

/* ==================================================================================
 * 6. WIRING — WHAT THE CLIENT ACTUALLY SENDS
 * ================================================================================== */

describe("the credentials request cannot carry a role", () => {
    const code = readCode("components/auth/LoginForm.tsx");

    it("sends exactly an identifier, a password and `redirect: false`", () => {
        const start = code.indexOf('signIn("credentials"');
        expect(start).toBeGreaterThan(-1);

        const call = code.slice(start, code.indexOf("});", start));

        expect(call).toContain("identifier: trimmedIdentifier");
        expect(call).toContain("password,");
        expect(call).toContain("redirect: false");
    });

    it("names no role field in the credentials call", () => {
        const start = code.indexOf('signIn("credentials"');
        const call = code.slice(start, code.indexOf("});", start));

        // Any spelling that would make the request an authority claim.
        for (const forbidden of ["role", "platformRole", "permissions", "isAdmin", "grant"]) {
            expect(call).not.toContain(forbidden);
        }
    });

    it("documents the invariant where the payload is built", () => {
        // The reasoning must survive the next editor, so it is asserted that the reasoning is
        // still written down next to the call it protects.
        const withComments = read("components/auth/LoginForm.tsx");
        const start = withComments.indexOf('signIn("credentials"');

        expect(withComments.slice(Math.max(0, start - 900), start)).toMatch(
            /not here|NEVER sent|UI INTENT/i
        );
    });

    it("uses the shared destination helper for every navigation", () => {
        const calls = code.match(/postLoginDestination\(/g) ?? [];

        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect(code).toContain('from "@/lib/auth/redirect"');
    });

    it("keeps a failed login on the login page", () => {
        // Phase 27A classified the failure in `lib/auth/sign-in-failure.ts`, so the slice
        // starts where the outcome is decided. The assertions are unchanged and the slice
        // is now strictly wider: it covers every outcome the classifier can return, not
        // only the credential one.
        const branch = code.slice(
            code.indexOf("const failure = classifySignInFailure("),
            code.indexOf("toast.success")
        );

        expect(branch).toContain("return;");
        expect(branch).not.toContain("router.replace");
        expect(branch).not.toContain("router.push");
    });
});

/* ==================================================================================
 * 7. WIRING — WHAT THE SERVER TRUSTS
 * ================================================================================== */

describe("the server cannot be told who the visitor is", () => {
    const auth = readCode("auth.ts");

    it("reads only an identifier and a password from the credentials payload", () => {
        expect(auth).toContain("credentials?.identifier");
        expect(auth).toContain("credentials?.password");

        for (const forbidden of [
            "credentials?.role",
            "credentials?.platformRole",
            "credentials?.permissions",
            "credentials.isAdmin",
        ]) {
            expect(auth).not.toContain(forbidden);
        }
    });

    it("derives the session role from the database row, not from the request", () => {
        // `user` here is the row returned by `prisma.user.findFirst`.
        expect(auth).toMatch(/role:\s*user\.role/);
        expect(auth).toMatch(/await prisma\.user\.findFirst\(/);
    });

    it("refreshes the platform-role mirror from the database, not from the token alone", () => {
        expect(auth).toContain("resolveAuthzScope(token.id)");
        expect(auth).toContain("token.platformRole = scope?.platformRole ?? null");
    });

    it("has no implicit bridge from the legacy role column to a platform role", () => {
        const scope = readCode("lib/authz/scope.ts");

        // The legacy column must not be read here at all: deriving ADMIN from it would be a
        // hidden privilege grant, which Phase 3 forbids explicitly.
        expect(scope).not.toContain("user.role");
        expect(scope).toContain('platformRole: user.platformRole ?? "CUSTOMER"');
    });
});
