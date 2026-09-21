/**
 * ==========================================
 * SIGN-IN FAILURE PRESENTATION (F4)
 * ==========================================
 *
 * `next-auth/react` resolves a `redirect: false` credentials sign-in with
 * `{ error, code }`, where both come from the query string `@auth/core` builds:
 *
 *     const type = isClientSafeErrorType ? error.type : "Configuration";
 *     const params = new URLSearchParams({ error: type });
 *     if (error instanceof CredentialsSignin) params.set("code", error.code);
 *
 * Every credential failure therefore arrives as `error: "CredentialsSignin"` — the CODE is
 * the only thing that separates a locked bucket from a wrong password. This suite pins:
 *
 *   1. the classification, including the value it must fall back to for anything it does
 *      not recognise;
 *   2. the message contract — the credential sentence is unchanged to the byte, the three
 *      sentences are distinct, and the two non-credential ones disclose nothing about any
 *      account;
 *   3. the wiring, so the form cannot drift back to "one message for everything" or start
 *      printing a code it invented.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    CREDENTIALS_FAILED_MESSAGE,
    LOGIN_RATE_LIMITED_CODE,
    LOGIN_RATE_LIMITED_MESSAGE,
    LOGIN_UNAVAILABLE_MESSAGE,
    classifySignInFailure,
} from "@/lib/auth/sign-in-failure";

function read(relativePath: string): string {
    return readFileSync(resolve(process.cwd(), relativePath), "utf-8");
}

/** Comments removed: prose about a message is not the message. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
}

const ALL_MESSAGES = [
    CREDENTIALS_FAILED_MESSAGE,
    LOGIN_RATE_LIMITED_MESSAGE,
    LOGIN_UNAVAILABLE_MESSAGE,
];

/* ==================================================================================
 * 1. CLASSIFICATION
 * ================================================================================== */

describe("classifying what signIn() returned", () => {
    it("treats a successful sign-in as no failure at all", () => {
        expect(classifySignInFailure(undefined)).toBeNull();
        expect(classifySignInFailure(null)).toBeNull();
        expect(classifySignInFailure("")).toBeNull();
        expect(classifySignInFailure(undefined, undefined)).toBeNull();
    });

    it("treats a credential failure as one uniform sentence", () => {
        // Wrong password, unknown account and OAuth-only account all arrive as this.
        for (const code of [undefined, null, "credentials"]) {
            const failure = classifySignInFailure("CredentialsSignin", code);

            expect(failure).toEqual({
                kind: "CREDENTIALS_FAILED",
                message: CREDENTIALS_FAILED_MESSAGE,
            });
        }
    });

    it("separates a throttled sign-in from a credential failure", () => {
        const failure = classifySignInFailure(
            "CredentialsSignin",
            LOGIN_RATE_LIMITED_CODE
        );

        expect(failure).toEqual({
            kind: "RATE_LIMITED",
            message: LOGIN_RATE_LIMITED_MESSAGE,
        });

        // The two must not be confusable: F3's whole point is that a locked visitor is no
        // longer told their password is wrong.
        expect(failure?.message).not.toBe(CREDENTIALS_FAILED_MESSAGE);
    });

    it("reads the code before the type, because the type is always the same", () => {
        // Even if a future Auth.js reports the throttle under a different type, the code
        // wins — the code is the value this application controls.
        expect(
            classifySignInFailure("CallbackRouteError", LOGIN_RATE_LIMITED_CODE)
                ?.kind
        ).toBe("RATE_LIMITED");
    });

    it("does not tell the visitor their password is wrong when Auth.js could not run", () => {
        const failure = classifySignInFailure("Configuration");

        expect(failure).toEqual({
            kind: "UNAVAILABLE",
            message: LOGIN_UNAVAILABLE_MESSAGE,
        });

        expect(failure?.message).not.toBe(CREDENTIALS_FAILED_MESSAGE);
    });

    it("falls back to the credential sentence for anything it does not recognise", () => {
        /*
         * `@auth/core/errors.js` carries a dozen error types. Render each unknown one as
         * "the server is broken" and a visitor whose password was merely wrong is sent to
         * wait — so the default is the generic credential sentence, which is true of every
         * authentication failure that is not already named.
         */
        for (const unknown of [
            "OAuthCallbackError",
            "OAuthAccountNotLinked",
            "AccessDenied",
            "MissingCSRF",
            "some-future-error-type",
        ]) {
            expect(classifySignInFailure(unknown)?.kind).toBe(
                "CREDENTIALS_FAILED"
            );
        }
    });
});

/* ==================================================================================
 * 2. THE MESSAGE CONTRACT
 * ================================================================================== */

describe("what the visitor is allowed to read", () => {
    it("keeps the uniform credential sentence unchanged", () => {
        // Byte-for-byte the sentence the form showed before Phase 27A. Any change here is
        // a change to the platform's credentials-failure contract, not a copy edit.
        expect(CREDENTIALS_FAILED_MESSAGE).toBe(
            "Email / Nomor HP atau password salah. Periksa kembali dan coba lagi."
        );
    });

    it("keeps the throttle code from colliding with Auth.js's own default", () => {
        // `CredentialsSignin.code` defaults to "credentials"; a collision would make the
        // throttle indistinguishable from a plain credential failure.
        expect(LOGIN_RATE_LIMITED_CODE).toBe("rate_limited");
        expect(LOGIN_RATE_LIMITED_CODE).not.toBe("credentials");
    });

    it("gives each outcome its own sentence", () => {
        expect(new Set(ALL_MESSAGES).size).toBe(3);
    });

    it("never reveals whether an account, an email or a password exists", () => {
        const forbidden = [
            "tidak terdaftar",
            "belum terdaftar",
            "sudah terdaftar",
            "tidak ditemukan",
            "akun tidak",
            "belum punya password",
            "google",
            "ADMIN",
            "MANAGER",
            "PIC",
        ];

        for (const message of ALL_MESSAGES) {
            for (const phrase of forbidden) {
                expect(message.toLowerCase()).not.toContain(phrase.toLowerCase());
            }
        }
    });

    it("never renders a raw code, a status or an internal value", () => {
        for (const message of ALL_MESSAGES) {
            expect(message).not.toMatch(/[A-Z_]{4,}/); // RATE_LIMITED, Configuration, …
            expect(message).not.toMatch(/\b(?:4\d\d|5\d\d)\b/);
            expect(message).not.toMatch(/prisma|database|sql|stack/i);
        }
    });
});

/* ==================================================================================
 * 3. WIRING — THE FORM
 * ================================================================================== */

describe("the login form renders the classified outcome", () => {
    const code = readCode("components/auth/LoginForm.tsx");
    const withComments = read("components/auth/LoginForm.tsx");

    it("imports the shared classifier instead of owning a message", () => {
        expect(code).toContain('from "@/lib/auth/sign-in-failure"');
        expect(code).toContain("classifySignInFailure(");
    });

    it("passes both the error and the code, and renders what it returned", () => {
        expect(code).toContain("classifySignInFailure(");
        expect(code).toContain("result?.error");
        expect(code).toContain("result?.code");
        expect(code).toContain("setAuthError(failure.message)");
    });

    it("keeps no copy of any sentence it could drift from", () => {
        expect(withComments).not.toContain(CREDENTIALS_FAILED_MESSAGE);
        expect(withComments).not.toContain(LOGIN_RATE_LIMITED_MESSAGE);
        expect(withComments).not.toContain(LOGIN_UNAVAILABLE_MESSAGE);
    });

    it("does not turn a missing session into a failed sign-in", () => {
        /*
         * The session read runs AFTER a success and can fail softly. `.catch(() => null)`
         * keeps such a failure inside the success path — the destination helper already
         * handles a null session — instead of letting it reach the catch that renders a
         * transport error to someone who has just signed in correctly.
         */
        expect(code).toContain("getSession().catch(() => null)");

        const betweenSuccessAndSession = code.slice(
            code.indexOf("toast.success"),
            code.indexOf("getSession()")
        );

        expect(betweenSuccessAndSession).not.toContain("setAuthError");
    });
});

describe("the server and the client agree on the throttle code", () => {
    it("auth.ts reads the code from the shared module rather than writing it out", () => {
        const auth = readCode("auth.ts");

        expect(auth).toContain("code = LOGIN_RATE_LIMITED_CODE");
        expect(auth).not.toContain('"rate_limited"');
    });
});
