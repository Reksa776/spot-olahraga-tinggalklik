/**
 * ==========================================
 * iPaymu PRODUCTION AUDIT SCRIPT
 * ==========================================
 *
 * Run: npx tsx scripts/audit-ipaymu.ts
 *
 * Validates all production requirements
 * without exposing secrets.
 */

import {
    validateIpaymuProductionConfig,
    getIpaymuConfigSummary,
    validateCallbackUrl,
} from "@/lib/payment/ipaymu-production";

import {
    generateSignature,
    generateTimestamp,
    verifyWebhookSignature,
    isSuccessNotification,
    isPendingNotification,
    isFailedNotification,
    verifyNotificationAmount,
} from "@/lib/payment/ipaymu";

let passed = 0;
let failed = 0;
let warnings = 0;

function check(name: string, ok: boolean, detail?: string) {
    if (ok) {
        console.log(`  ✅ ${name}`);
        passed++;
    } else {
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
        failed++;
    }
}

function warn(name: string, detail?: string) {
    console.log(`  ⚠️  ${name}${detail ? ` — ${detail}` : ""}`);
    warnings++;
}

// ==========================================
// 1. CONFIGURATION AUDIT
// ==========================================

console.log("\n━━━ 1. PRODUCTION CONFIGURATION ━━━");

validateIpaymuProductionConfig();
const configSummary = getIpaymuConfigSummary();

console.log(`  Mode: ${configSummary.isProduction ? "PRODUCTION" : "SANDBOX"}`);
console.log(`  API Key: ${configSummary.apiKeyPreview}`);
console.log(`  VA: ${configSummary.vaPreview}`);
console.log(`  Base URL: ${configSummary.baseUrl}`);
console.log(`  App URL: ${configSummary.appUrl || "NOT SET"}`);

check(
    "API key exists and is long enough",
    configSummary.hasApiKey && configSummary.apiKeyLength >= 10
);

check("VA exists and is numeric", configSummary.hasVa);

if (configSummary.isProduction) {
    check(
        "Production URL is correct",
        configSummary.baseUrl === "https://my.ipaymu.com",
        `got: ${configSummary.baseUrl}`
    );

    check(
        "No sandbox URL in production",
        !configSummary.isSandbox
    );

    check("App URL is set", configSummary.hasAppUrl);

    if (configSummary.appUrl) {
        check(
            "App URL uses HTTPS",
            configSummary.appUrl.startsWith("https://"),
            `got: ${configSummary.appUrl}`
        );

        check(
            "App URL is not localhost",
            !configSummary.appUrl.includes("localhost")
        );
    }
} else {
    warn("Running in SANDBOX mode — not production");

    check(
        "Sandbox URL is correct",
        configSummary.baseUrl === "https://sandbox.ipaymu.com",
        `got: ${configSummary.baseUrl}`
    );
}

// ==========================================
// 2. CALLBACK URL SECURITY
// ==========================================

console.log("\n━━━ 2. CALLBACK URL SECURITY ━━━");

if (configSummary.appUrl) {
    const notifyUrl = `${configSummary.appUrl}/api/payment/ipaymu/notification`;
    const returnUrl = `${configSummary.appUrl}/checkout/payment-finish?payment=TEST`;
    const cancelUrl = `${configSummary.appUrl}/checkout/payment-finish?payment=TEST`;

    const notifyErrors = validateCallbackUrl(
        notifyUrl,
        configSummary.appUrl,
        "notifyUrl"
    );
    const returnErrors = validateCallbackUrl(
        returnUrl,
        configSummary.appUrl,
        "returnUrl"
    );
    const cancelErrors = validateCallbackUrl(
        cancelUrl,
        configSummary.appUrl,
        "cancelUrl"
    );

    check(
        "notifyUrl passes validation",
        notifyErrors.length === 0,
        notifyErrors.join("; ")
    );

    check(
        "returnUrl passes validation",
        returnErrors.length === 0,
        returnErrors.join("; ")
    );

    check(
        "cancelUrl passes validation",
        cancelErrors.length === 0,
        cancelErrors.join("; ")
    );

    // Test forged URLs
    const forgedNotifyErrors = validateCallbackUrl(
        "https://evil.com/api/payment/ipaymu/notification",
        configSummary.appUrl,
        "forged-notifyUrl"
    );

    check(
        "Forged notifyUrl is rejected",
        forgedNotifyErrors.length > 0,
        "forged URL should fail hostname check"
    );
} else {
    warn("App URL not set — skipping callback URL tests");
}

// ==========================================
// 3. SIGNATURE GENERATION
// ==========================================

console.log("\n━━━ 3. SIGNATURE GENERATION ━━━");

const testBody = '{"product":["Test"],"qty":["1"],"price":["100000"],"amount":100000}';
const testVa = "1234567890";
const testApiKey = "test-api-key-1234567890";

const sig1 = generateSignature(testBody, testVa, testApiKey);
check("Signature generates without error", sig1.length > 0);
check("Signature is hex string", /^[a-f0-9]+$/.test(sig1));
check("Signature is 64 chars (SHA256)", sig1.length === 64);

// Body change → signature change
const modifiedBody = '{"product":["Test"],"qty":["1"],"price":["100001"],"amount":100000}';
const sig2 = generateSignature(modifiedBody, testVa, testApiKey);
check("Modified body → different signature", sig1 !== sig2);

// VA change → signature change
const sig3 = generateSignature(testBody, "9999999999", testApiKey);
check("Modified VA → different signature", sig1 !== sig3);

// API key change → signature change
const sig4 = generateSignature(testBody, testVa, "different-api-key-12345");
check("Modified API key → different signature", sig1 !== sig4);

// Same input → same signature (deterministic)
const sig5 = generateSignature(testBody, testVa, testApiKey);
check("Same input → same signature (deterministic)", sig1 === sig5);

// Timestamp generation
const ts = generateTimestamp();
check("Timestamp format YYYYMMDDHHmmss", /^\d{14}$/.test(ts));

// ==========================================
// 4. WEBHOOK SIGNATURE VERIFICATION
// ==========================================

console.log("\n━━━ 4. WEBHOOK SIGNATURE VERIFICATION ━━━");

// Simulate a webhook with form-encoded body
const webhookVa = "1234567890";
const webhookFields: Record<string, string> = {
    reference_id: "PAY-CART-123-abc",
    trx_id: "456",
    sid: "ses_789",
    status_code: "1",
    sub_total: "100000",
    total: "100000",
    amount: "100000",
    fee: "0",
    via: "va",
    channel: "bca",
    payment_no: "1179000899",
    buyer_name: "Test User",
    buyer_email: "test@example.com",
    buyer_phone: "081234567890",
    additional_info: "[]",
};

// Build canonical body and compute expected signature
const {
    computeCanonicalJson,
    computeWebhookSignature: computeWHSig,
} = await import("@/lib/payment/ipaymu");

const canonicalJson = computeCanonicalJson(webhookFields);
const expectedSig = computeWHSig(canonicalJson, webhookVa);

// Build raw body for verification
const rawBody = new URLSearchParams(webhookFields).toString();

// Re-derive canonical from raw body (simulating what verifyWebhookSignature does)
const verified = verifyWebhookSignature(rawBody, expectedSig, webhookVa);
check("Valid webhook signature accepted", verified);

// Tamper with body
const tamperedFields = { ...webhookFields, sub_total: "99999" };
const tamperedRaw = new URLSearchParams(tamperedFields).toString();
const tamperedSig = computeWHSig(
    computeCanonicalJson(tamperedFields),
    webhookVa
);
const tamperedVerify = verifyWebhookSignature(
    tamperedRaw,
    tamperedSig,
    webhookVa
);
check("Tampered body with recomputed sig still verifies (correct behavior)", tamperedVerify);

// Wrong signature
const wrongSigVerify = verifyWebhookSignature(rawBody, "deadbeef", webhookVa);
check("Wrong signature rejected", !wrongSigVerify);

// Empty signature
const emptySigVerify = verifyWebhookSignature(rawBody, "", webhookVa);
check("Empty signature rejected", !emptySigVerify);

// Missing VA (no way to verify)
const noVaVerify = verifyWebhookSignature(rawBody, expectedSig, "");
check("Missing VA → reject (fail-closed)", !noVaVerify);

// ==========================================
// 5. NOTIFICATION STATUS MAPPING
// ==========================================

console.log("\n━━━ 5. NOTIFICATION STATUS MAPPING ━━━");

check(
    "Status 200 = success",
    isSuccessNotification({ Status: 200 })
);

check(
    "Status \"berhasil\" = success",
    isSuccessNotification({ status: "berhasil" })
);

check(
    "Status 150 = pending",
    isPendingNotification({ Status: 150 })
);

check(
    "Status \"pending\" = pending",
    isPendingNotification({ status: "pending" })
);

check(
    "Status 400 = failed",
    isFailedNotification({ Status: 400 })
);

check(
    "Status \"gagal\" = failed",
    isFailedNotification({ status: "gagal" })
);

check(
    "Status \"expired\" = failed",
    isFailedNotification({ status: "expired" })
);

// ==========================================
// 6. AMOUNT VERIFICATION
// ==========================================

console.log("\n━━━ 6. AMOUNT VERIFICATION ━━━");

check(
    "Amount matches (sub_total)",
    verifyNotificationAmount({ sub_total: "100000" }, 100000)
);

check(
    "Amount matches (Amount field)",
    verifyNotificationAmount({ Amount: "100000" }, 100000)
);

check(
    "Amount mismatch rejected",
    !verifyNotificationAmount({ sub_total: "99999" }, 100000)
);

check(
    "NaN amount rejected",
    !verifyNotificationAmount({ sub_total: "abc" }, 100000)
);

check(
    "Empty amount rejected",
    !verifyNotificationAmount({}, 100000)
);

// ==========================================
// 7. SECURITY: NO SECRETS IN LOGS
// ==========================================

console.log("\n━━━ 7. SECURITY: LOG SAFETY ━━━");

const summary = getIpaymuConfigSummary();
check(
    "API key not fully exposed in summary",
    summary.apiKeyPreview.includes("...")
);
check(
    "VA not fully exposed in summary",
    summary.vaPreview.includes("***")
);
check(
    "API key preview has correct length",
    summary.apiKeyPreview.length < summary.apiKeyLength
);

// ==========================================
// 8. ENVIRONMENT FILE AUDIT
// ==========================================

console.log("\n━━━ 8. ENVIRONMENT FILES ━━━");

import { readFileSync, existsSync } from "fs";

const envFiles = [
    ".env",
    ".env.local",
    ".env.production",
];

for (const envFile of envFiles) {
    if (!existsSync(envFile)) {
        warn(`${envFile} does not exist`);
        continue;
    }

    const content = readFileSync(envFile, "utf-8");
    const lines = content.split("\n").filter(
        (l) => l.trim() && !l.startsWith("#")
    );

    const apiKeyLines = lines.filter(
        (l) =>
            l.startsWith("IPAYMU_API_KEY=") &&
            !l.startsWith("IPAYMU_API_KEY=\"\"")
    );
    const vaLines = lines.filter(
        (l) =>
            l.startsWith("IPAYMU_VA=") &&
            !l.startsWith("IPAYMU_VA=\"\"")
    );

    check(
        `${envFile}: API key configured`,
        apiKeyLines.length > 0
    );

    check(
        `${envFile}: VA configured`,
        vaLines.length > 0
    );

    // Check for sandbox URLs in production env
    if (envFile.includes("production")) {
        check(
            `${envFile}: no sandbox URLs`,
            !content.includes("sandbox.ipaymu.com")
        );

        check(
            `${envFile}: production URL present`,
            content.includes("my.ipaymu.com")
        );
    }
}

// ==========================================
// RESULTS
// ==========================================

console.log(`\n${"━".repeat(50)}`);
console.log(
    `\n📊 AUDIT RESULTS: ${passed} passed, ${failed} failed, ${warnings} warnings`
);

if (failed > 0) {
    console.log("\n❌ AUDIT FAILED — Fix issues before production deployment.\n");
    process.exit(1);
} else if (warnings > 0) {
    console.log("\n⚠️  AUDIT PASSED WITH WARNINGS — Review warnings above.\n");
} else {
    console.log("\n✅ ALL AUDIT CHECKS PASSED.\n");
}
