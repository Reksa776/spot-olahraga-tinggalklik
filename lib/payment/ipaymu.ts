/**
 * ==========================================
 * iPaymu Payment Provider
 * ==========================================
 *
 * API v2 integration for customer payment.
 * Uses Redirect Payment method.
 *
 * Signature format (from official iPaymu
 * Go/Node.js/PHP/Python libraries):
 *
 *   bodyHash = SHA256(body)
 *   stringToSign = "POST:" + VA + ":" +
 *     lowercase(bodyHash) + ":" + apiKey
 *   signature = HMAC-SHA256(stringToSign, apiKey)
 *
 * Headers required:
 *   va: Virtual Account number
 *   signature: Generated signature
 *   timestamp: YYYYMMDDHHmmss
 *
 * Production: https://my.ipaymu.com
 * Sandbox: https://sandbox.ipaymu.com
 */

import crypto from "crypto";
import { getIpaymuConfig } from "./config";

/* ==========================================
 * CONFIGURATION
 * ==========================================
 *
 * Legacy constant retained for backward compatibility with
 * static config checks. It is NOT the operational source of
 * truth anymore — payment operations resolve configuration
 * through getIpaymuConfig() (lib/payment/config.ts), which is
 * strict/fail-closed and environment-aware.
 *
 * Sandbox: https://sandbox.ipaymu.com
 * Production: https://my.ipaymu.com
 */

export const IPAYMU_CONFIG = {
    apiKey: process.env.IPAYMU_API_KEY || "",
    va: process.env.IPAYMU_VA || "",
    baseUrl:
        process.env.IPAYMU_URL ||
        (process.env.IPAYMU_IS_PRODUCTION === "true"
            ? "https://my.ipaymu.com"
            : "https://sandbox.ipaymu.com"),
};

/* ==========================================
 * SIGNATURE GENERATION
 * ==========================================
 *
 * Matches official iPaymu library behavior:
 * 1. SHA256 hash of the JSON body
 * 2. Build string: "POST:<VA>:<lowercase_hash>:<apiKey>"
 * 3. HMAC-SHA256 with apiKey as secret key
 */

export function generateSignature(
    body: string,
    va: string,
    apiKey: string
): string {
    const bodyHash = crypto
        .createHash("sha256")
        .update(body)
        .digest("hex");

    const stringToSign = `POST:${va}:${bodyHash.toLowerCase()}:${apiKey}`;

    return crypto
        .createHmac("sha256", apiKey)
        .update(stringToSign)
        .digest("hex");
}

export function generateTimestamp(): string {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");
    return `${y}${m}${d}${hh}${mm}${ss}`;
}

/* ==========================================
 * LEGACY SIGNATURE (for tests using old API)
 * ==========================================
 *
 * Kept for backward compatibility with tests
 * that compute the old outgoing signature.
 */
export function computeLegacyWebhookSignature(
    apiKey: string,
    timestamp: string,
    externalId: string,
    rawBody: string
): string {
    const payload = `${timestamp}:${externalId}:${rawBody}`;
    return crypto
        .createHmac("sha256", apiKey)
        .update(payload)
        .digest("hex");
}

/* ==========================================
 * PRODUCT DISPLAY NAME
 * ==========================================
 *
 * Safely format product + variant name.
 * If variantName is empty/null/undefined,
 * return only productName.
 *
 * Prevents trailing " - " which changes the
 * JSON body hash and causes iPaymu 401.
 */

export function formatProductName(
    productName: string,
    variantName?: string | null
): string {
    const trimmedName = productName.trim();
    const trimmedVariant = (variantName ?? "").trim();
    return trimmedVariant
        ? `${trimmedName} - ${trimmedVariant}`
        : trimmedName;
}

/* ==========================================
 * TYPES
 * ========================================== */

export type IpaymuPaymentMethod =
    | "va"
    | "banktransfer"
    | "cstore"
    | "cod"
    | "qris";

export type IpaymuPaymentChannel =
    | "bca"
    | "bni"
    | "mandiri"
    | "bri"
    | "bsi"
    | "permata"
    | "cimb"
    | "danamon"
    | "bmi"
    | "qris"
    // Channel codes the DIRECT endpoint documents and the redirect endpoint does not. They
    // are part of this union because the same channel value travels to whichever endpoint
    // the chosen method uses, and a code that is valid for one is not a type error for the
    // other — the provider, not this union, is what validates it:
    //   va       → bag, bpd_bali
    //   cstore   → alfamart, indomaret
    //   qris     → mpm
    //   cc       → cc
    //   paylater → akulaku
    //   cod      → rpx
    | "bag"
    | "bpd_bali"
    | "alfamart"
    | "indomaret"
    | "mpm"
    | "cc"
    | "akulaku"
    | "rpx";

export type IpaymuCartItem = {
    product: string;
    qty: number;
    price: number;
    description?: string;
    weight?: number;
    length?: number;
    width?: number;
    height?: number;
};

export type IpaymuRedirectRequest = {
    product: string[];
    qty: string[];
    price: string[];
    amount: number;
    buyerName: string;
    buyerEmail: string;
    buyerPhone: string;
    paymentMethod: IpaymuPaymentMethod;
    paymentChannel: IpaymuPaymentChannel;
    notifyUrl: string;
    returnUrl?: string;
    cancelUrl?: string;
    referenceId?: string;
    /**
     * iPaymu requires description as a string
     * array, one entry per product item.
     */
    description?: string[];
    expired?: number;
};

export type IpaymuResponse = {
    Status: number;
    Data: {
        SessionId?: string;
        Url?: string;
    } | null;
    Message: string;
};

/* ==========================================
 * TYPES — DIRECT PAYMENT
 * ========================================== */

/**
 * The methods `POST /api/v2/payment/direct` documents.
 *
 * Copied from iPaymu's published API v2 collection ("Direct Payment" →
 * `paymentMethod`): VA, Convenience Store, COD, QRIS, Credit Card, Pay Later. This
 * is the PROVIDER's vocabulary, not ours — the internal `PaymentMethod` enum is a
 * different set, and `lib/ticketing/payment/gateway.ts` owns the translation.
 *
 * `cod` is declared because the endpoint accepts it, and deliberately NOT used for
 * ticket sales: cash-on-delivery has nothing to deliver for a digital ticket.
 */
export type IpaymuDirectMethod =
    | "va"
    | "cstore"
    | "cod"
    | "qris"
    | "cc"
    | "paylater";

/** Every channel code the direct endpoint documents, per method. */
export type IpaymuDirectChannel =
    // va
    | "bag"
    | "bca"
    | "bpd_bali"
    | "bni"
    | "cimb"
    | "mandiri"
    | "bmi"
    | "bri"
    | "bsi"
    | "permata"
    | "danamon"
    // cstore
    | "alfamart"
    | "indomaret"
    // cod
    | "rpx"
    // qris
    | "mpm"
    // cc
    | "cc"
    // paylater
    | "akulaku";

/**
 * The direct-payment request, field for field as documented.
 *
 * Mandatory per the collection: `name`, `phone`, `email`, `amount`, `notifyUrl`,
 * `referenceId`, `paymentMethod`, `paymentChannel`. Everything after those is
 * optional and is only sent when this application actually has a value for it — a
 * field sent with a guessed value is a field the provider will believe.
 */
export type IpaymuDirectRequest = {
    name: string;
    phone: string;
    email: string;
    /** Whole rupiah. The provider's wire format is a JSON number. */
    amount: number;
    notifyUrl: string;
    referenceId: string;
    paymentMethod: IpaymuDirectMethod;
    paymentChannel: IpaymuDirectChannel;
    /**
     * Lifetime in HOURS. The collection states "Custom expired payment code in
     * hours" and then constrains individual channels (BSI VA max 3h, BRI VA max
     * 2h, BCA VA cannot be customised at all). Because those ceilings are real, this
     * value is advisory: the authoritative expiry is the `Expired` instant the
     * response returns, which is what the platform stores and shows.
     */
    expired?: number;
    comments?: string;
    feeDirection?: "MERCHANT" | "BUYER";
    /**
     * Redirect targets. The collection marks these as used by the redirect-style
     * methods (Akulaku and Credit Card); they are omitted for QR/VA/cstore, which
     * are completed entirely in-app.
     */
    successUrl?: string;
    cancelUrl?: string;
};

/**
 * `Data` of a successful direct payment.
 *
 * Field presence is per-method, taken from the two sample responses in the
 * provider's own collection:
 *
 *   VA   → SessionId, TransactionId, ReferenceId, Via, Channel, PaymentNo,
 *          PaymentName, Total, Fee, Expired
 *   QRIS → the same, plus QrString, QrImage, QrTemplate, SubTotal, FeeDirection,
 *          Terminal, NNSCode
 *
 * Everything is optional here because the shape is method-dependent and this
 * application must not assume a field exists to avoid crashing on a channel that
 * does not return it. Consumers are required to treat a missing instruction as
 * "the provider did not give us one" rather than as an empty value.
 */
export type IpaymuDirectData = {
    SessionId?: string;
    TransactionId?: number | string;
    ReferenceId?: string;
    Via?: string;
    Channel?: string;
    /** VA number, cstore payment code, or the QRIS payload. */
    PaymentNo?: string;
    /** QRIS only: the payload string a wallet decodes. */
    QrString?: string;
    /** QRIS only: provider-hosted PNG of `QrString`. */
    QrImage?: string;
    /** QRIS only: provider-hosted print template image. */
    QrTemplate?: string;
    PaymentName?: string;
    SubTotal?: number | string;
    Fee?: number | string;
    Total?: number | string;
    FeeDirection?: string;
    /** `YYYY-MM-DD HH:mm:ss` in the provider's timezone. */
    Expired?: string;
    Terminal?: string;
    NNSCode?: string;
};

export type IpaymuDirectResponse = {
    Status: number;
    Success?: boolean;
    Message: string;
    Data?: IpaymuDirectData | null;
    /** Present on `Status: 400` — field-keyed validation messages. */
    Error?: Record<string, string[]>;
};

/* ==========================================
 * PAYMENT CREATION (Redirect)
 * ==========================================
 *
 * Endpoint: POST /api/v2/payment/
 *
 * Creates a hosted payment page. Customer
 * is redirected to Data.Url to complete
 * payment.
 *
 * NOTE: this returns NO payment instrument — no QR, no VA number, no bank name.
 * Those exist only in the Direct Payment response below. That is why the ticket
 * payment page renders QRIS/VA from `createDirectPayment` rather than trying to
 * derive them from a redirect session.
 */

/* ==========================================
 * REQUEST TIMEOUT (30 seconds)
 * ==========================================
 *
 * Production iPaymu API typically responds
 * within 5-10 seconds. 30s covers slow
 * network without hanging indefinitely.
 */
const IPAYMU_REQUEST_TIMEOUT_MS = 30_000;

export async function createRedirectPayment(
    request: IpaymuRedirectRequest
): Promise<IpaymuResponse> {
    // FAIL-CLOSED: misconfigured servers throw before any request is sent.
    const { apiKey, va, baseUrl } = getIpaymuConfig();

    if (!apiKey || !va) {
        throw new Error(
            "iPaymu credentials belum dikonfigurasi."
        );
    }

    // ==========================================
    // VALIDATE AMOUNT (server-authoritative)
    // ==========================================
    if (
        !Number.isFinite(request.amount) ||
        request.amount <= 0
    ) {
        throw new Error(
            `iPaymu amount tidak valid: ${request.amount}`
        );
    }

    // ==========================================
    // VALIDATE PRODUCT ARRAYS
    // ==========================================
    if (
        !Array.isArray(request.product) ||
        request.product.length === 0
    ) {
        throw new Error("iPaymu product list kosong.");
    }

    if (
        request.product.length !== request.qty.length ||
        request.product.length !== request.price.length
    ) {
        throw new Error(
            "iPaymu product/qty/price array length mismatch."
        );
    }

    const body = JSON.stringify(request);
    const bodyHash = crypto
        .createHash("sha256")
        .update(body)
        .digest("hex");
    const signature = generateSignature(
        body,
        va,
        apiKey
    );
    const timestamp = generateTimestamp();

    // ==========================================
    // SECURITY: Never log API key or full signature
    // ==========================================
    if (process.env.NODE_ENV !== "production") {
        console.log("[iPaymu] CREATE PAYMENT:", {
            url: `${baseUrl}/api/v2/payment/`,
            amount: request.amount,
            referenceId: request.referenceId,
            method: request.paymentMethod,
            channel: request.paymentChannel,
            productCount: request.product.length,
            bodyHash: bodyHash.substring(0, 8) + "...",
            timestamp,
        });
    }

    // ==========================================
    // FETCH WITH TIMEOUT
    // ==========================================
    let response: Response;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            IPAYMU_REQUEST_TIMEOUT_MS
        );

        response = await fetch(
            `${baseUrl}/api/v2/payment/`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    va,
                    signature,
                    timestamp,
                    Accept: "application/json",
                },
                body,
                signal: controller.signal,
            }
        );

        clearTimeout(timeoutId);
    } catch (fetchError: unknown) {
        const error = fetchError as {
            name?: string;
            message?: string;
            cause?: { code?: string };
        };

        // ==========================================
        // NETWORK-LEVEL ERRORS (no HTTP response)
        // ==========================================
        if (error.name === "AbortError") {
            throw new Error(
                "[TIMEOUT] iPaymu request timeout (30s). Pembayaran tidak dapat dibuat saat ini."
            );
        }

        if (error.cause?.code === "ENOTFOUND") {
            throw new Error(
                "[DNS_ERROR] iPaymu domain tidak dapat di-resolve. Periksa koneksi internet."
            );
        }

        if (error.cause?.code === "ECONNREFUSED") {
            throw new Error(
                "[CONNECTION_REFUSED] iPaymu server menolak koneksi."
            );
        }

        if (
            error.cause?.code === "ECONNRESET" ||
            error.message?.includes("socket hang up")
        ) {
            throw new Error(
                "[CONNECTION_RESET] iPaymu connection terputus."
            );
        }

        if (
            error.cause?.code?.startsWith("ERR_TLS") ||
            error.message?.includes("SSL") ||
            error.message?.includes("TLS")
        ) {
            throw new Error(
                "[TLS_ERROR] iPaymu TLS/SSL handshake gagal."
            );
        }

        // Generic network error
        throw new Error(
            `[NETWORK_ERROR] iPaymu: ${error.message}`
        );
    }

    // ==========================================
    // HTTP-LEVEL RESPONSE
    // ==========================================
    let result: IpaymuResponse;

    try {
        result = await response.json();
    } catch {
        throw new Error(
            `[INVALID_JSON] iPaymu returned non-JSON response (HTTP ${response.status})`
        );
    }

    // ==========================================
    // SECURITY: Log safe fields only
    // ==========================================
    if (process.env.NODE_ENV !== "production") {
        console.log("[iPaymu] RESPONSE:", {
            httpStatus: response.status,
            ipaymuStatus: result.Status,
            message: result.Message,
            hasUrl: !!result.Data?.Url,
            sessionId: result.Data?.SessionId,
        });
    }

    // ==========================================
    // HTTP 4XX / 5XX = application-level errors
    // ==========================================
    if (response.status === 401 || response.status === 403) {
        throw new Error(
            `[AUTH_ERROR] iPaymu authentication gagal (HTTP ${response.status}). Periksa API key dan VA.`
        );
    }

    if (response.status >= 500) {
        throw new Error(
            `[IPAYMU_SERVER_ERROR] iPaymu server error (HTTP ${response.status}). Coba lagi nanti.`
        );
    }

    if (response.status !== 200) {
        throw new Error(
            `[IPAYMU_HTTP_ERROR] iPaymu returned HTTP ${response.status}: ${result.Message || "unknown"}`
        );
    }

    // ==========================================
    // IPAYMU BUSINESS-LEVEL VALIDATION
    // ==========================================
    if (result.Status !== 200) {
        const message =
            process.env.NODE_ENV === "production"
                ? "[IPAYMU_API_ERROR] Gagal membuat pembayaran iPaymu."
                : `[IPAYMU_API_ERROR] ${result.Message || "Gagal membuat pembayaran iPaymu."}`;
        throw new Error(message);
    }

    if (!result.Data?.Url) {
        throw new Error(
            "[IPAYMU_API_ERROR] iPaymu returned success but no payment URL."
        );
    }

    return result;
}

/* ==========================================
 * PAYMENT CREATION (Direct)
 * ==========================================
 *
 * Endpoint: POST /api/v2/payment/direct
 *
 * Returns the payment INSTRUMENT itself instead of a hosted-page URL:
 *
 *   VA            -> Data.PaymentNo (virtual-account number) + PaymentName
 *   QRIS          -> Data.QrString (payload) + Data.QrImage (PNG) + PaymentNo
 *   Convenience   -> Data.PaymentNo (payment code)
 *
 * Contract notes that are load-bearing for the caller:
 *
 *   * It THROWS on transport, HTTP and provider-level failure, exactly like
 *     `createRedirectPayment`, so callers keep one failure model. Business-level
 *     refusal (`Status !== 200`) is an exception, never a partially-filled result,
 *     because a caller that received a half-populated `Data` could render an
 *     instruction the provider never issued.
 *   * Unlike the redirect call it does NOT require `Data.Url` — a direct payment has
 *     no URL at all for QR/VA/cstore. It requires that the response carry an
 *     instruction this application can show: either a `PaymentNo` or a `QrString`.
 *     A success without either is a provider contract violation and is refused here
 *     rather than surfaced as an empty payment page.
 *   * `Expired` is returned as `YYYY-MM-DD HH:mm:ss` in the provider's own
 *     timezone. It is returned as a STRING and is not converted here: parsing it is
 *     a decision about which timezone the provider meant, and that decision belongs
 *     to the caller that persists it (see `parseProviderExpiry`), where it is made
 *     once and covered by a test.
 *
 * Signature: identical mechanism to the redirect call —
 * `HMAC-SHA256("POST:<VA>:<sha256(body)>:<apiKey>", apiKey)` with `va`, `signature`
 * and `timestamp` headers — because the provider documents one signature scheme for
 * both endpoints.
 */
export async function createDirectPayment(
    request: IpaymuDirectRequest
): Promise<IpaymuDirectResponse> {
    // FAIL-CLOSED: misconfigured servers throw before any request is sent.
    const { apiKey, va, baseUrl } = getIpaymuConfig();

    if (!apiKey || !va) {
        throw new Error("iPaymu credentials belum dikonfigurasi.");
    }

    if (!Number.isFinite(request.amount) || request.amount <= 0) {
        throw new Error(`iPaymu amount tidak valid: ${request.amount}`);
    }

    if (!request.referenceId) {
        throw new Error("iPaymu referenceId wajib diisi.");
    }

    if (!request.notifyUrl) {
        throw new Error("iPaymu notifyUrl wajib diisi.");
    }

    const body = JSON.stringify(request);
    const signature = generateSignature(body, va, apiKey);
    const timestamp = generateTimestamp();

    // SECURITY: never log the API key, the signature, or buyer contact details.
    if (process.env.NODE_ENV !== "production") {
        console.log("[iPaymu] CREATE DIRECT PAYMENT:", {
            url: `${baseUrl}/api/v2/payment/direct`,
            amount: request.amount,
            referenceId: request.referenceId,
            method: request.paymentMethod,
            channel: request.paymentChannel,
        });
    }

    let response: Response;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
            () => controller.abort(),
            IPAYMU_REQUEST_TIMEOUT_MS
        );

        response = await fetch(`${baseUrl}/api/v2/payment/direct`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                va,
                signature,
                timestamp,
                Accept: "application/json",
            },
            body,
            signal: controller.signal,
        });

        clearTimeout(timeoutId);
    } catch (fetchError: unknown) {
        const error = fetchError as { name?: string; message?: string };

        if (error?.name === "AbortError") {
            throw new Error(
                "[TIMEOUT] iPaymu direct payment timeout (30s). Pembayaran tidak dapat dibuat saat ini."
            );
        }

        throw new Error(`[NETWORK_ERROR] iPaymu direct: ${error?.message}`);
    }

    let result: IpaymuDirectResponse;

    try {
        result = await response.json();
    } catch {
        throw new Error(
            `[INVALID_JSON] iPaymu returned non-JSON response (HTTP ${response.status})`
        );
    }

    if (response.status === 401) {
        throw new Error(
            "[AUTH_ERROR] iPaymu authentication gagal. Periksa API key dan VA."
        );
    }

    if (response.status >= 500) {
        throw new Error(
            `[IPAYMU_SERVER_ERROR] iPaymu server error (HTTP ${response.status}). Coba lagi nanti.`
        );
    }

    // 400 carries field-keyed validation messages, which are useful in DEVELOPMENT
    // logs only: the message names provider parameters, and echoing it to a buyer
    // would expose the integration's shape.
    if (response.status !== 200 || result.Status !== 200) {
        const detail =
            process.env.NODE_ENV === "production"
                ? ""
                : ` ${result.Message ?? ""} ${JSON.stringify(result.Error ?? {})}`;

        throw new Error(
            `[IPAYMU_API_ERROR] Gagal membuat pembayaran langsung (HTTP ${response.status}/${result.Status}).${detail}`
        );
    }

    // A success must carry an instruction. See the contract note above.
    if (!result.Data?.PaymentNo && !result.Data?.QrString) {
        throw new Error(
            "[IPAYMU_API_ERROR] iPaymu direct payment returned success without a payment instruction."
        );
    }

    return result;
}

/* ==========================================
 * WEBHOOK SIGNATURE VERIFICATION
 * ==========================================
 *
 * iPaymu webhook notification is sent as
 * POST to the notifyUrl.
 *
 * The notification contains payment status
 * information. For security, we verify:
 *
 * 1. The amount matches the order total
 * 2. The signature in the callback (if present)
 *
 * NOTE: iPaymu v2 webhook notification body
 * format (based on official docs and sample
 * code):
 *
 * {
 *   "Status": 200,
 *   "SessionId": "ses_xxx",
 *   "ReferenceId": "ORDER_NUMBER",
 *   "PaymentMethod": "va",
 *   "PaymentChannel": "bca",
 *   "VirtualAccount": "1179000899",
 *   "Amount": "150000",
 *   "Fee": "0",
 *   "SenderBank": "bca",
 *   "SenderAccount": "1234567890",
 *   "BuyerName": "John Doe",
 *   "BuyerEmail": "john@example.com",
 *   "BuyerPhone": "081234567890",
 *   "Status": 200,
 *   "Message": "Payment success"
 * }
 *
 * Status mapping (see classifyIpaymuNotification for the full,
 * fail-safe mapping):
 * - Status 1 (status_code) → success
 * - Status 0 / 100-199 → pending
 * - Status >= 4 / >= 400 → failed/expired
 * - Anything else (including 2 and 3) is EXPLICITLY never success.
 *
 * NOTE: The exact webhook payload varies.
 * We handle multiple possible formats.
 */

export type IpaymuNotification = {
    Status?: number | string;
    SessionId?: string;
    TransactionId?: string;
    ReferenceId?: string;
    PaymentMethod?: string;
    PaymentChannel?: string;
    VirtualAccount?: string;
    Amount?: string | number;
    Fee?: string | number;
    SenderBank?: string;
    SenderAccount?: string;
    BuyerName?: string;
    BuyerEmail?: string;
    BuyerPhone?: string;
    Message?: string;
    PaymentId?: string;
    payment_id?: string;
    trx_id?: string;
    status?: string;
    code?: string;
    /**
     * iPaymu webhook snake_case fields
     * (real sandbox payload)
     */
    reference_id?: string;
    sid?: string;
    status_code?: string | number;
    sub_total?: string | number;
    amount?: string | number;
    fee?: string | number;
    total?: string | number;
    settlement_status?: string;
    transaction_status_code?: string | number;
    via?: string;
    channel?: string;
    payment_no?: string;
    paid_off?: number;
    created_at?: string;
    expired_at?: string;
    paid_at?: string;
    buyer_name?: string;
    buyer_email?: string;
    buyer_phone?: string;
};

/**
 * Determine if the iPaymu notification indicates
 * a successful payment.
 *
 * iPaymu Status codes:
 * - 200 = Success (berhasil)
 * - Other codes = pending/failed/expired
 *
 * We also handle string-based status formats
 * that some iPaymu webhook versions may use.
 */
export function isSuccessNotification(
    notification: IpaymuNotification
): boolean {
    // Numeric status 200 = success
    if (notification.Status === 200) {
        return true;
    }

    // String status "berhasil" = success
    if (
        typeof notification.status === "string" &&
        notification.status.toLowerCase() ===
            "berhasil"
    ) {
        return true;
    }

    return false;
}

export function isPendingNotification(
    notification: IpaymuNotification
): boolean {
    if (
        typeof notification.Status === "number" &&
        notification.Status >= 100 &&
        notification.Status < 200
    ) {
        return true;
    }

    if (
        typeof notification.status === "string" &&
        notification.status.toLowerCase() ===
            "pending"
    ) {
        return true;
    }

    return false;
}

export function isFailedNotification(
    notification: IpaymuNotification
): boolean {
    if (
        typeof notification.Status === "number" &&
        notification.Status >= 400
    ) {
        return true;
    }

    if (
        typeof notification.status === "string" &&
        (notification.status.toLowerCase() ===
            "gagal" ||
            notification.status.toLowerCase() ===
                "failed" ||
            notification.status.toLowerCase() ===
                "expired")
    ) {
        return true;
    }

    return false;
}

/* ==========================================
 * EXPLICIT STATUS CLASSIFICATION
 * ==========================================
 *
 * F14 FIX: Instead of relying on loose "success/pending/failed"
 * heuristics, classify the notification into an explicit union
 * so an unrecognized status can NEVER be treated as success.
 *
 * iPaymu `status_code` mapping (v2 callback):
 *   1  → success (berhasil)
 *   0  → pending (menunggu pembayaran)
 *   2  → unconfirmed (tidak pernah dianggap sukses)
 *   3  → unconfirmed (tidak pernah dianggap sukses)
 *   >=4 → failed / expired / cancelled
 *
 * String `status` values:
 *   "berhasil" → success
 *   "pending"  → pending
 *   "gagal"/"failed"/"expired"/"canceled" → failed
 *   anything else → unknown (never success)
 */
export type IpaymuStatusClass =
    | "success"
    | "pending"
    | "failed"
    | "unknown";

export function classifyIpaymuNotification(
    notification: IpaymuNotification
): IpaymuStatusClass {
    // 1. String-based status (some webhook versions)
    if (typeof notification.status === "string") {
        const s = notification.status.toLowerCase();
        if (s === "berhasil") return "success";
        if (s === "pending") return "pending";
        if (
            s === "gagal" ||
            s === "failed" ||
            s === "expired" ||
            s === "canceled" ||
            s === "cancelled"
        ) {
            return "failed";
        }
        return "unknown";
    }

    // 2. Numeric Status field (after route normalization)
    if (typeof notification.Status === "number") {
        const code = notification.Status;
        if (code === 200) return "success";
        if (code >= 100 && code < 200) return "pending";
        if (code >= 400) return "failed";
        // 2xx/3xx and anything else: NOT success
        return "unknown";
    }

    // 3. Raw status_code (still present on the notification)
    // NOTE: Number(undefined) → NaN, so Number.isInteger handles
    // the missing-field case without TypeScript narrowing issues.
    const rawCode = Number(notification.status_code);
    if (Number.isInteger(rawCode)) {
        if (rawCode === 1) return "success";
        if (rawCode === 0) return "pending";
        // 2 and 3 are explicitly non-success (unconfirmed)
        if (rawCode === 2 || rawCode === 3) return "pending";
        if (rawCode >= 4) return "failed";
        return "unknown";
    }

    // 4. transaction_status_code / settlement_status fallback
    const txCode = Number(notification.transaction_status_code);
    if (Number.isInteger(txCode)) {
        if (txCode === 1) return "success";
        if (txCode === 0) return "pending";
        if (txCode === 2 || txCode === 3) return "pending";
        if (txCode >= 4) return "failed";
        return "unknown";
    }

    if (typeof notification.settlement_status === "string") {
        const s = notification.settlement_status.toLowerCase();
        if (s === "paid" || s === "settlement") return "success";
        if (s === "refunded" || s === "canceled") return "failed";
        return "unknown";
    }

    // Nothing recognizable → unknown. The route treats unknown as
    // a no-op (acknowledges to iPaymu but makes NO state change),
    // which can never accidentally settle an order.
    return "unknown";
}

/**
 * Verify the notification amount matches the
 * expected order amount.
 */
export function verifyNotificationAmount(
    notification: IpaymuNotification,
    expectedAmount: number
): boolean {
    /*
     * iPaymu webhook sends:
     * - sub_total = product total (matches order.total)
     * - amount/total = product total + fee (does NOT match)
     *
     * We compare sub_total against order.total to avoid
     * fee mismatch rejecting valid payments.
     */
    const notificationAmount = Number(
        notification.sub_total ?? notification.Amount
    );

    if (
        !Number.isFinite(notificationAmount) ||
        notificationAmount !== expectedAmount
    ) {
        return false;
    }

    return true;
}

/* ==========================================
 * CALLBACK SIGNATURE NORMALIZATION
 * ==========================================
 *
 * iPaymu callback signature verification follows
 * these steps (from official docs):
 *
 * 1. Parse form-encoded body into key-value pairs
 * 2. Normalize data types:
 *    - trx_id, status_code, transaction_status_code,
 *      paid_off → Integer
 *    - is_escrow → Boolean
 *    - additional_info → Array ([] if missing)
 *    - All other values → String
 * 3. Remove 'signature' field if present
 * 4. Ensure additional_info exists (add [] if missing)
 * 5. Sort keys alphabetically A-Z (case-sensitive)
 * 6. JSON.stringify the sorted object
 * 7. Escape forward slashes (/ → \/)
 * 8. HMAC-SHA256 with VA Number as secret key
 * 9. Compare with X-Signature header
 */
const INTEGER_KEYS = [
    "trx_id",
    "status_code",
    "transaction_status_code",
    "paid_off",
];

export function normalizeCallbackBody(
    raw: Record<string, string>
): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const key in raw) {
        const val = raw[key];

        if (key === "is_escrow") {
            result[key] = val === "true" || val === "1";
        } else if (INTEGER_KEYS.includes(key)) {
            result[key] = parseInt(val, 10);
        } else if (key === "additional_info") {
            if (val === "[]") {
                result[key] = [];
            } else {
                try {
                    const parsed = JSON.parse(val);
                    result[key] = Array.isArray(parsed) ? parsed : [];
                } catch {
                    result[key] = [];
                }
            }
        } else {
            result[key] = String(val);
        }
    }

    if (!Object.prototype.hasOwnProperty.call(result, "additional_info")) {
        result["additional_info"] = [];
    }

    return result;
}

/**
 * Sort object keys alphabetically (A-Z),
 * matching PHP json_encode behavior.
 */
function phpKsort(
    obj: Record<string, unknown>
): Record<string, unknown> {
    return Object.keys(obj)
        .sort((a, b) => a.localeCompare(b))
        .reduce(
            (sortedObj, key) => {
                sortedObj[key] = obj[key];
                return sortedObj;
            },
            {} as Record<string, unknown>
        );
}

/**
 * Compute the canonical JSON body used for callback
 * signature verification.
 *
 * 1. Normalize types
 * 2. Sort keys A-Z
 * 3. JSON.stringify
 * 4. Escape forward slashes
 */
export function computeCanonicalJson(
    raw: Record<string, string>
): string {
    const normalized = normalizeCallbackBody(raw);
    const sorted = phpKsort(normalized);
    let jsonBody = JSON.stringify(sorted);
    // Escape forward slashes to match PHP json_encode
    jsonBody = jsonBody.replace(/\//g, "\\/");
    return jsonBody;
}

/**
 * Compute the HMAC-SHA256 signature for a callback.
 *
 * Uses the VA Number (not API Key) as the secret.
 *
 * @param jsonBody - The canonical JSON string
 * @param merchantVa - The merchant VA number (secret key)
 * @returns hex-encoded HMAC-SHA256 signature
 */
export function computeWebhookSignature(
    jsonBody: string,
    merchantVa: string
): string {
    return crypto
        .createHmac("sha256", merchantVa)
        .update(jsonBody)
        .digest("hex");
}

/**
 * Verify the incoming iPaymu webhook signature.
 *
 * iPaymu callback signature algorithm (from official docs):
 * 1. Parse form body
 * 2. Normalize data types
 * 3. Sort keys A-Z
 * 4. JSON.stringify
 * 5. Escape slashes
 * 6. HMAC-SHA256(VA, canonicalJson)
 * 7. Compare with X-Signature
 *
 * @param rawBody - The exact raw HTTP body
 * @param receivedSignature - The value from X-Signature header
 * @param merchantVa - The VA Number (secret key for callback signature)
 * @returns true if signature is valid, false otherwise
 *
 * Security:
 * - Uses timingSafeEqual to prevent timing attacks
 * - Returns false on any error (fail-closed)
 */
export function verifyWebhookSignature(
    rawBody: string,
    receivedSignature: string,
    merchantVa: string
): boolean {
    // Fail-closed: no VA = cannot verify = reject
    if (!merchantVa) {
        return false;
    }

    // Fail-closed: missing signature = reject
    if (!receivedSignature) {
        return false;
    }

    try {
        // Parse the form-encoded body
        const params = new URLSearchParams(rawBody);
        const raw: Record<string, string> = {};
        params.forEach((value, key) => {
            raw[key] = value;
        });

        /*
         * iPaymu's callback documentation, step 1 of the verification mechanism:
         *
         *   "Remove the `signature` parameter from the received data. Sort the data by keys in
         *    ascending order (ksort). Convert the sorted data to a JSON string. Generate the
         *    HMAC-SHA256 hash using the JSON string and your Secret Key (VA)."
         *
         * So the signature may arrive as a FIELD IN THE BODY, and it must be removed before
         * the canonical JSON is built — otherwise the payload being hashed is not the payload
         * the provider signed, and every legitimate callback fails. It is removed here (rather
         * than only at the call site) so no caller can forget: this is the one place that
         * decides what the provider signed.
         */
        const bodySignature = raw.signature ?? null;
        delete raw.signature;

        // Compute canonical JSON
        const canonicalJson = computeCanonicalJson(raw);

        // Compute expected signature using VA as secret
        const expectedSignature = computeWebhookSignature(
            canonicalJson,
            merchantVa
        );

        // A signature from the body is accepted as well as one from a header, because the
        // provider documents the body field. The header remains first: if both are present and
        // only one verifies, the header is what the caller believed it was checking.
        // Safe comparison using timingSafeEqual
        const receivedBuf = Buffer.from(
            bodySignature ?? receivedSignature,
            "utf8"
        );
        const expectedBuf = Buffer.from(expectedSignature, "utf8");

        if (receivedBuf.length !== expectedBuf.length) {
            return false;
        }

        return crypto.timingSafeEqual(receivedBuf, expectedBuf);
    } catch {
        // Any error → fail-closed
        return false;
    }
}

/**
 * ==========================================
 * SERVER-TO-SERVER PAYMENT VERIFICATION
 * ==========================================
 *
 * Defense-in-depth: query iPaymu directly to
 * verify payment status. Use when:
 * 1. Webhook signature fails but payment looks legit
 * 2. First-time payment confirmation needs
 *    authoritative verification
 * 3. Reconciliation checks
 *
 * Endpoint: POST /api/v2/payment/status
 * Auth: Same headers as outgoing (va, signature, timestamp)
 */
export type PaymentStatusResponse = {
    Status: number;
    Data?: {
        Status?: string;
        Amount?: number;
        ReferenceId?: string;
        SessionId?: string;
    };
    Message?: string;
};

export async function verifyPaymentStatus(
    sessionId: string
): Promise<PaymentStatusResponse> {
    // FAIL-CLOSED: misconfigured servers throw before any request is sent.
    const { apiKey, va, baseUrl } = getIpaymuConfig();

    if (!apiKey || !va) {
        throw new Error("iPaymu credentials belum dikonfigurasi.");
    }

    if (!sessionId) {
        throw new Error("SessionId tidak boleh kosong.");
    }

    const body = JSON.stringify({
        sessionId,
    });
    const signature = generateSignature(body, va, apiKey);
    const timestamp = generateTimestamp();

    const controller = new AbortController();
    const timeoutId = setTimeout(
        () => controller.abort(),
        15_000
    );

    try {
        const response = await fetch(
            `${baseUrl}/api/v2/payment/status`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    va,
                    signature,
                    timestamp,
                    Accept: "application/json",
                },
                body,
                signal: controller.signal,
            }
        );

        clearTimeout(timeoutId);

        const result = await response.json();
        return result;
    } catch (error: unknown) {
        clearTimeout(timeoutId);

        if ((error as { name?: string })?.name === "AbortError") {
            throw new Error("iPaymu status verification timeout.");
        }
        throw error;
    }
}

/**
 * Determine if a payment status response indicates success.
 */
export function isPaymentConfirmed(
    statusResponse: PaymentStatusResponse
): boolean {
    return (
        statusResponse.Status === 200 &&
        (
            statusResponse.Data?.Status?.toLowerCase() === "paid" ||
            statusResponse.Data?.Status?.toLowerCase() === "settlement"
        )
    );
}

/**
 * Map iPaymu payment method/channel to our
 * internal CheckoutPaymentMethod.
 */
export function mapPaymentMethod(
    method?: string,
    channel?: string
): string {
    if (method === "qris" || channel === "qris") {
        return "QRIS";
    }

    if (method === "va" || method === "banktransfer") {
        return "BANK_TRANSFER";
    }

    if (method === "cstore") {
        return "E_WALLET";
    }

    return "BANK_TRANSFER";
}
