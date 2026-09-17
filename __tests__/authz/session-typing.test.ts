/**
 * ==========================================
 * PHASE 3 — SESSION TYPING & TYPE-SAFETY GUARDS
 * ==========================================
 *
 * Two kinds of assertion, both of which fail the suite if regressed:
 *
 *  1. COMPILE-TIME. The functions below only typecheck if the Auth.js
 *     augmentation actually reaches the interfaces the callbacks use. ts-jest
 *     compiles this file, so a broken augmentation fails the test run rather
 *     than silently degrading to `unknown`. This is deliberate: the bug this
 *     phase fixed was an augmentation that looked correct and did nothing.
 *
 *  2. RUNTIME SOURCE SCAN. Authorization must not be expressed through `any`,
 *     and must not read a role from a client-supplied value. These assertions
 *     read the source so a future edit cannot quietly reintroduce them.
 */

import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";

import type { Session } from "next-auth";
import type { JWT } from "next-auth/jwt";

// ─────────────────────────────────────────────────────────────────────────────
// 1. Compile-time shape assertions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * If `Session.user.platformRole` did not exist, or `role` were still `string`,
 * these assignments would not compile and this file would fail to build.
 */
export function __assertSessionShape(session: Session) {
    const id: string = session.user.id;

    // Exhaustive union — proves `role` is the real Role type, not `string`.
    const role: "ADMIN" | "SELLER" | "CUSTOMER" | "AFFILIATOR" =
        session.user.role;

    // Proves `platformRole` exists and is nullable, mirroring the DB column.
    const platformRole: "CUSTOMER" | "ADMIN" | "MANAGER" | "PIC" | null =
        session.user.platformRole;

    return { id, role, platformRole };
}

/**
 * The regression this locks in: augmenting `"next-auth/jwt"` (the re-export
 * shim) leaves these fields `unknown`, so assigning them to concrete types
 * fails to compile. Only augmenting `"@auth/core/jwt"` — the module the
 * callbacks actually use — compiles.
 */
export function __assertJwtShape(token: JWT) {
    const refreshedAt: number | undefined = token.authzScopeRefreshedAt;

    const platformRole:
        | "CUSTOMER"
        | "ADMIN"
        | "MANAGER"
        | "PIC"
        | null
        | undefined = token.platformRole;

    const id: string | undefined = token.id;

    return { refreshedAt, platformRole, id };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Source scans
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove comments before scanning for banned constructs.
 *
 * Necessary, not cosmetic: the Phase 3 code documents WHY `as any` was removed,
 * and that prose contains the literal text "as any". Scanning raw source would
 * flag a comment that exists precisely to prevent the thing being flagged.
 *
 * The `[^:]` guard keeps `https://` and friends from looking like a line comment.
 */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function readSourceFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);

        if (entry.isDirectory()) {
            readSourceFiles(full, acc);
        } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
            acc.push(full.replace(/\\/g, "/"));
        }
    }

    return acc;
}

const authzFiles = readSourceFiles(resolve(process.cwd(), "lib/authz"));
const appAndLibFiles = [
    ...readSourceFiles(resolve(process.cwd(), "lib")),
    ...readSourceFiles(resolve(process.cwd(), "app")),
];

describe("session typing (compile-time shapes)", () => {
    test("Session and JWT shapes are typed as declared", () => {
        // The real assertion is that this file compiles. These calls exist so the
        // functions are not dead code.
        expect(typeof __assertSessionShape).toBe("function");
        expect(typeof __assertJwtShape).toBe("function");
    });

    test("the JWT augmentation targets the module the callbacks actually use", () => {
        const declaration = readFileSync(
            resolve(process.cwd(), "types/next-auth.d.ts"),
            "utf-8"
        );

        // `next-auth/jwt` is only `export * from "@auth/core/jwt"` in the
        // installed beta. Augmenting the shim is silently ignored — which is the
        // exact failure this phase repaired.
        expect(declaration).toContain('declare module "@auth/core/jwt"');
    });

    test("session `role` is no longer declared as a bare string", () => {
        const declaration = readFileSync(
            resolve(process.cwd(), "types/next-auth.d.ts"),
            "utf-8"
        );

        expect(declaration).not.toMatch(/role:\s*string/);
        expect(declaration).toContain('from "@prisma/client"');
    });
});

describe("authorization must not use `any`", () => {
    test("lib/authz contains no `as any` / `: any` in code", () => {
        const offenders = authzFiles.filter((file) =>
            /\bas\s+any\b|:\s*any\b/.test(
                stripComments(readFileSync(file, "utf-8"))
            )
        );

        expect(offenders).toEqual([]);
    });

    test("no `(session.user as any)` remains anywhere in app/ or lib/", () => {
        const offenders = appAndLibFiles.filter((file) =>
            /\(session\.user as any\)/.test(
                stripComments(readFileSync(file, "utf-8"))
            )
        );

        expect(offenders).toEqual([]);
    });

    test("no `as any` in the files Phase 3 created or modified", () => {
        // Scoped to the phase's own footprint on purpose.
        //
        // An earlier, broader version of this assertion matched any file with
        // "auth"/"admin" in its path and reported ~7 legacy retail `as any`
        // casts. Those are NOT authorization holes and are NOT this phase's to
        // clean up: they narrow values that came from the database (for example
        // `user.role as any` on a Prisma field, or `metadata as any`), not roles
        // taken from a request. Phase 3 brief §22 explicitly excludes global
        // cleanup from this phase, so they are reported in
        // TICKETING_PHASE3_REPORT.md §14 instead of being silently rewritten here.
        const phase3Files = [
            "types/next-auth.d.ts",
            "auth.ts",
            "lib/csrf.ts",
            "lib/admin.ts",
            "proxy.ts",
            ...authzFiles,
        ];

        const offenders = phase3Files.filter((file) =>
            /\bas\s+any\b/.test(
                stripComments(readFileSync(resolve(process.cwd(), file), "utf-8"))
            )
        );

        expect(offenders).toEqual([]);
    });
});
