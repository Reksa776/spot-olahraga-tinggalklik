#!/usr/bin/env node
/**
 * ==========================================
 * LOCAL SANDBOX CALLBACK REPLAY (DEVELOPMENT ONLY)
 * ==========================================
 *
 * Sends a callback request captured from the iPaymu SANDBOX dashboard ("Tes Notify")
 * to the LOCAL webhook, so the sandbox payment flow can be tested end to end without
 * exposing localhost to the internet.
 *
 * ── WHY THIS AND NOT A "MARK AS PAID" ENDPOINT ───────────────────────────────────
 * iPaymu posts its callback server-to-server, so it cannot reach `http://localhost:3000`:
 * the delivery is refused before any HTTP exchange happens and the order stays
 * `PENDING_PAYMENT` even though the sandbox dashboard says paid. The remedy is NOT a
 * development endpoint that accepts a status or an amount — that would be a second
 * settlement authority and a forgery vector. It is to take the provider's OWN request and
 * post it, byte for byte, to the real webhook. Everything then runs exactly as production
 * does: raw-body HMAC verification, the signature/amount/reference gates, the replay
 * ledger, and the settlement transaction. This script only moves bytes; it never signs,
 * never edits the payload, and never writes to the database itself.
 *
 * ── HOW TO CAPTURE THE REQUEST ───────────────────────────────────────────────────
 * 1. In the iPaymu SANDBOX dashboard, open the successful transaction.
 * 2. Use "Tes Notify" and copy the generated callback request.
 * 3. Save the RAW form-urlencoded body to a file, exactly as shown — do not reformat it,
 *    and do not remove the `signature` field if it is present in the body.
 * 4. Run this script:
 *
 *      node scripts/replay-sandbox-callback.cjs --body-file callback.txt
 *
 *    If the signature arrived as the `X-Signature` HEADER rather than a body field, pass
 *    it explicitly (this is the shape the Phase 27B sandbox callback used):
 *
 *      node scripts/replay-sandbox-callback.cjs \
 *        --body-file callback.txt \
 *        --signature 449631ce4bdee77146521514989f70cba5d979a127fb88217c02eec51e50abd2
 *
 *    The body may also be piped in:
 *
 *      cat callback.txt | node scripts/replay-sandbox-callback.cjs
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────────
 * * Refuses to run when `NODE_ENV=production`.
 * * Prints a loud warning when the target is not a loopback address (an optional tunnel
 *   is fine, but it should be a deliberate choice).
 * * Never prints a secret; the signature is a provider-supplied value, not a credential.
 *
 * This file is a developer tool. It is not imported by the application, is not part of the
 * Next.js build, and exposes no route.
 */

"use strict";

const fs = require("node:fs");
const process = require("node:process");

const DEFAULT_URL = "http://localhost:3000/api/ticketing/payment/webhook";

/** Minimal argv parser: `--flag value` and `--flag`. */
function parseArgs(argv) {
    const parsed = { positional: [] };

    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];

        if (!token.startsWith("--")) {
            parsed.positional.push(token);
            continue;
        }

        const key = token.slice(2);
        const next = argv[i + 1];

        if (next === undefined || next.startsWith("--")) {
            parsed[key] = true;
        } else {
            parsed[key] = next;
            i += 1;
        }
    }

    return parsed;
}

function usage() {
    console.log(`
Usage:
  node scripts/replay-sandbox-callback.cjs --body-file <path> [options]
  cat <path> | node scripts/replay-sandbox-callback.cjs [options]

Options:
  --body-file <path>   File holding the RAW form-urlencoded callback body.
  --signature <hex>    Value of the provider's X-Signature header, when the signature is
                       not already a 'signature' field in the body.
  --url <url>          Webhook URL. Defaults to ${DEFAULT_URL}
  -h, --help           Show this message.
`);
}

function isLoopback(hostname) {
    return (
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "0.0.0.0" ||
        hostname === "::1" ||
        hostname === "[::1]"
    );
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help || args.h) {
        usage();
        return;
    }

    if (process.env.NODE_ENV === "production") {
        console.error(
            "Refusing to run: NODE_ENV=production. This helper is for LOCAL sandbox testing only."
        );
        process.exit(1);
    }

    const bodyFile = typeof args["body-file"] === "string" ? args["body-file"] : null;

    let rawBody;
    if (bodyFile) {
        rawBody = fs.readFileSync(bodyFile, "utf8");
    } else {
        rawBody = fs.readFileSync(0, "utf8");
    }

    // Trim only a trailing newline — the body itself is sent byte-for-byte.
    rawBody = rawBody.replace(/\r?\n$/, "");

    if (!rawBody.trim()) {
        console.error(
            "No callback body provided. Pass --body-file <path> or pipe the body on stdin."
        );
        process.exit(1);
    }

    const url = typeof args.url === "string" ? args.url : DEFAULT_URL;
    let parsed;

    try {
        parsed = new URL(url);
    } catch {
        console.error(`Invalid --url: ${url}`);
        process.exit(1);
    }

    if (!isLoopback(parsed.hostname)) {
        console.warn(
            `WARNING: target host "${parsed.hostname}" is not loopback. ` +
                "Make sure this is deliberate — this script performs no authentication of its own; " +
                "the webhook it calls still verifies the provider signature."
        );
    }

    const params = new URLSearchParams(rawBody);
    const bodySignature = params.get("signature");
    const headerSignature = typeof args.signature === "string" ? args.signature : null;

    if (!bodySignature && !headerSignature) {
        console.warn(
            "WARNING: the body has no 'signature' field and no --signature was given.\n" +
                "         The webhook will answer 401 MISSING_SIGNATURE — pass --signature <hex>."
        );
    }

    const headers = {
        "content-type": "application/x-www-form-urlencoded",
    };

    if (headerSignature) {
        headers["x-signature"] = headerSignature;
    }

    console.log(`POST ${url}`);
    console.log(`body: ${rawBody.length} bytes`);
    console.log(
        `signature: ${headerSignature ? "X-Signature header" : bodySignature ? "body 'signature' field" : "NONE"}`
    );

    let response;

    try {
        response = await fetch(url, { method: "POST", headers, body: rawBody });
    } catch (error) {
        console.error(
            `\nNETWORK ERROR: ${error.message}\n` +
                "Is the local server running (npm run dev) and is the URL correct?"
        );
        process.exit(1);
    }

    const text = await response.text();

    console.log(`\nHTTP ${response.status}`);
    console.log(text);

    // A 4xx/5xx is a legitimate outcome (a bad signature, a foreign reference, a transient
    // database error). Exiting non-zero makes that visible in a shell pipeline.
    process.exit(response.status >= 400 ? 1 : 0);
}

main();
