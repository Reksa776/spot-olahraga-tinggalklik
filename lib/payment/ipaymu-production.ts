/**
 * ==========================================
 * iPaymu PRODUCTION CONFIGURATION VALIDATOR
 * ==========================================
 *
 * Fail-fast validation that prevents
 * deploying to production with sandbox
 * credentials or misconfiguration.
 *
 * Legacy (IPAYMU_API_KEY/IPAYMU_VA/IPAYMU_IS_PRODUCTION) is
 * still supported for backward compatibility, but the STRICT
 * model (lib/payment/config.ts) is the operational source of
 * truth:
 *
 *   PAYMENT_ENVIRONMENT = sandbox | production
 *   IPAYMU_SANDBOX_*      | IPAYMU_PRODUCTION_*
 *
 * Usage:
 *   import { validateIpaymuProductionConfig } from "@/lib/payment/ipaymu-production";
 *   validateIpaymuProductionConfig(); // throws on failure
 *
 * Run as script:
 *   npx tsx lib/payment/ipaymu-production.ts
 */

import {
    buildIpaymuConfig,
    PaymentConfigError,
} from "./config";

const SANDBOX_URL = "https://sandbox.ipaymu.com";
const PRODUCTION_URL = "https://my.ipaymu.com";

/* ==========================================
 * VALIDATION RESULT
 * ========================================== */

export type ValidationResult = {
    valid: boolean;
    errors: string[];
    warnings: string[];
};

/* ==========================================
 * VALIDATE PRODUCTION CONFIG
 * ========================================== */

export function validateIpaymuProductionConfig(): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    const isProduction =
        process.env.PAYMENT_ENVIRONMENT === "production" ||
        process.env.IPAYMU_IS_PRODUCTION === "true";

    if (!isProduction) {
        warnings.push(
            "No production environment selected — " +
                "set PAYMENT_ENVIRONMENT=production (or " +
                "IPAYMU_IS_PRODUCTION=true) to enforce production checks"
        );
    }

    const apiKey = process.env.IPAYMU_API_KEY || "";
    const va = process.env.IPAYMU_VA || "";
    const configuredUrl = process.env.IPAYMU_URL || "";
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";

    // New-model credentials take precedence over legacy vars.
    const strictMode =
        !!(
            process.env.IPAYMU_PRODUCTION_API_KEY ||
            process.env.IPAYMU_PRODUCTION_VA ||
            process.env.IPAYMU_SANDBOX_API_KEY ||
            process.env.IPAYMU_SANDBOX_VA
        );

    // ==========================================
    // API KEY (legacy mode only — strict model
    // below validates the per-environment vars)
    // ==========================================

    if (!strictMode) {
        if (!apiKey) {
            errors.push("IPAYMU_API_KEY is not set");
        } else if (apiKey.length < 10) {
            errors.push("IPAYMU_API_KEY appears too short (minimum 10 chars)");
        }

        // ==========================================
        // VA (legacy mode only)
        // ==========================================

        if (!va) {
            errors.push("IPAYMU_VA is not set");
        } else if (!/^\d{10,20}$/.test(va)) {
            errors.push(
                "IPAYMU_VA should be a numeric string of 10-20 digits"
            );
        }

        // ==========================================
        // PRODUCTION URL (legacy mode only)
        // ==========================================

        if (isProduction) {
            // In production, URL must be the production endpoint
            if (configuredUrl && configuredUrl !== PRODUCTION_URL) {
                errors.push(
                    `IPAYMU_URL is '${configuredUrl}' but production requires '${PRODUCTION_URL}'`
                );
            }

            if (configuredUrl.includes("sandbox")) {
                errors.push(
                    "IPAYMU_URL contains 'sandbox' — cannot use sandbox in production"
                );
            }

            // Check for localhost
            if (configuredUrl.includes("localhost")) {
                errors.push(
                    "IPAYMU_URL contains 'localhost' — not valid for production"
                );
            }
        }
    }

    // ==========================================
    // APP URL
    // ==========================================

    if (!appUrl) {
        errors.push("NEXT_PUBLIC_APP_URL is not set");
    } else {
        if (!appUrl.startsWith("https://")) {
            errors.push(
                `NEXT_PUBLIC_APP_URL must use HTTPS in production, got '${appUrl}'`
            );
        }

        if (appUrl.includes("localhost")) {
            errors.push(
                "NEXT_PUBLIC_APP_URL contains 'localhost' — not valid for production"
            );
        }

        if (appUrl.includes("127.0.0.1")) {
            errors.push(
                "NEXT_PUBLIC_APP_URL contains '127.0.0.1' — not valid for production"
            );
        }

        // Check for sandbox URL
        if (appUrl.includes("sandbox.ipaymu.com")) {
            errors.push(
                "NEXT_PUBLIC_APP_URL contains sandbox domain"
            );
        }
    }

    // ==========================================
    // STRICT FAIL-CLOSED VALIDATION (NEW MODEL)
    // ==========================================
    //
    // lib/payment/config.ts is the canonical resolver:
    //  - PAYMENT_ENVIRONMENT must be exactly sandbox|production
    //  - per-environment VA/API key presence & format
    //  - base-URL allowlist (sandbox ⇄ sandbox, prod ⇄ prod),
    //    which is what prevents 'sandbox' from ever being used
    //    in production
    //  - production blocks sandbox-VA reuse & localhost APP_URL
    //
    // The validator folds its strict error into the result so
    // initIpaymuConfig() fails fast instead of letting a broken
    // payment pipeline silently reach users.

    if (strictMode || isProduction) {
        try {
            const resolved = buildIpaymuConfig(process.env);
            if (
                resolved.environment === "production" &&
                !appUrl.startsWith("https://")
            ) {
                errors.push(
                    `NEXT_PUBLIC_APP_URL must use HTTPS in production, got '${appUrl}'`
                );
            }
        } catch (e) {
            const detail =
                e instanceof PaymentConfigError
                    ? e.message
                    : String(e);
            errors.push(`Strict iPaymu config check failed: ${detail}`);
        }
    }

    // ==========================================
    // LOGGING SAFETY
    // ==========================================

    if (isProduction && apiKey) {
        // Ensure production logs don't expose full API key
        // This is a configuration check — we just verify it exists
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/* ==========================================
 * FAIL-FAST ON MODULE LOAD (production only)
 * ==========================================
 *
 * When production is selected (either by
 * PAYMENT_ENVIRONMENT=production or legacy
 * IPAYMU_IS_PRODUCTION=true), validates
 * configuration immediately at call time.
 * In development, validation is opt-in (and
 * deliberately lazy so `next build` can run
 * without PAYMENT_ENVIRONMENT set).
 */

export function initIpaymuConfig() {
    const isProduction =
        process.env.PAYMENT_ENVIRONMENT === "production" ||
        process.env.IPAYMU_IS_PRODUCTION === "true";

    if (isProduction) {
        const result = validateIpaymuProductionConfig();

        if (!result.valid) {
            const errorReport = [
                "╔══════════════════════════════════════════════╗",
                "║  CRITICAL: iPaymu Production Config Error    ║",
                "╚══════════════════════════════════════════════╝",
                "",
                ...result.errors.map((e) => `  ✗ ${e}`),
                "",
                "Fix these issues before deploying to production.",
                "Payments will NOT work with incorrect configuration.",
            ].join("\n");

            console.error(errorReport);
            throw new Error(
                `iPaymu production configuration invalid: ${result.errors.join("; ")}`
            );
        }

        if (result.warnings.length > 0) {
            for (const w of result.warnings) {
                console.warn(`[iPaymu] WARNING: ${w}`);
            }
        }
    }
}

/* ==========================================
 * SAFE CONFIG GETTER
 * ==========================================
 *
 * Returns configuration without exposing secrets.
 * For logging/display purposes only.
 */

export function getIpaymuConfigSummary() {
    const apiKey = process.env.IPAYMU_API_KEY || "";
    const va = process.env.IPAYMU_VA || "";
    const url =
        process.env.IPAYMU_URL ||
        (process.env.IPAYMU_IS_PRODUCTION === "true"
            ? PRODUCTION_URL
            : SANDBOX_URL);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
    const isProduction =
        process.env.PAYMENT_ENVIRONMENT === "production" ||
        process.env.IPAYMU_IS_PRODUCTION === "true";

    // Prefer the strict resolver when it is resolvable.
    let strictBaseUrl = "";
    let strictVa = "";
    let environment: "sandbox" | "production" | "unknown" = "unknown";
    try {
        const cfg = buildIpaymuConfig(process.env);
        environment = cfg.environment;
        strictBaseUrl = cfg.baseUrl;
        strictVa = cfg.va;
    } catch {
        // Not resolvable — summary will fall back to legacy fields.
    }

    return {
        environment,
        isProduction,
        hasApiKey: !!apiKey,
        apiKeyLength: (strictBaseUrl ? "" : apiKey).length || apiKey.length,
        apiKeyPreview: apiKey
            ? `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`
            : "NOT SET",
        hasVa: !!(strictVa || va),
        vaPreview: (strictVa || va)
            ? `${(strictVa || va).substring(0, 3)}***${(strictVa || va).substring((strictVa || va).length - 3)}`
            : "NOT SET",
        baseUrl: strictBaseUrl || url,
        hasAppUrl: !!appUrl,
        appUrl,
        isSandbox: (strictBaseUrl || url).includes("sandbox"),
        isProductionUrl: (strictBaseUrl || url).includes("my.ipaymu.com"),
    };
}

/* ==========================================
 * VALIDATE CALLBACK URLs
 * ==========================================
 *
 * Checks that constructed URLs are safe and
 * not attacker-controlled.
 */

export function validateCallbackUrl(
    url: string,
    appUrl: string,
    label: string
): string[] {
    const errors: string[] = [];

    if (!url) {
        errors.push(`${label}: URL is empty`);
        return errors;
    }

    try {
        const parsed = new URL(url);

        // Must be HTTPS in production
        if (
            (process.env.PAYMENT_ENVIRONMENT === "production" ||
                process.env.IPAYMU_IS_PRODUCTION === "true") &&
            parsed.protocol !== "https:"
        ) {
            errors.push(`${label}: must use HTTPS in production, got ${parsed.protocol}`);
        }

        // Must not be localhost
        if (
            parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1"
        ) {
            errors.push(`${label}: must not use localhost`);
        }

        // Must match app URL hostname
        if (appUrl) {
            try {
                const appParsed = new URL(appUrl);
                if (parsed.hostname !== appParsed.hostname) {
                    errors.push(
                        `${label}: hostname '${parsed.hostname}' does not match APP_URL hostname '${appParsed.hostname}'`
                    );
                }
            } catch {
                // Invalid appUrl — skip hostname check
            }
        }
    } catch {
        errors.push(`${label}: invalid URL format`);
    }

    return errors;
}

/* ==========================================
 * CLI: Run as standalone script
 * ==========================================
 */

if (require.main === module) {
    console.log("\n=== iPaymu Production Configuration Audit ===\n");

    const result = validateIpaymuProductionConfig();
    const summary = getIpaymuConfigSummary();

    console.log("Configuration Summary:");
    console.log(`  Environment: ${summary.environment}`);
    console.log(`  Production Mode: ${summary.isProduction ? "YES" : "NO (sandbox)"}`);
    console.log(`  API Key: ${summary.apiKeyPreview}`);
    console.log(`  VA: ${summary.vaPreview}`);
    console.log(`  Base URL: ${summary.baseUrl}`);
    console.log(`  App URL: ${summary.appUrl || "NOT SET"}`);
    console.log(`  Is Sandbox: ${summary.isSandbox}`);
    console.log(`  Is Production URL: ${summary.isProductionUrl}`);
    console.log("");

    if (result.errors.length > 0) {
        console.log("ERRORS:");
        for (const e of result.errors) {
            console.log(`  ✗ ${e}`);
        }
    }

    if (result.warnings.length > 0) {
        console.log("WARNINGS:");
        for (const w of result.warnings) {
            console.log(`  ⚠ ${w}`);
        }
    }

    if (result.valid) {
        console.log("✅ All checks passed.");
    } else {
        console.log(`\n❌ ${result.errors.length} error(s) found. Fix before production.`);
        process.exit(1);
    }
}