import {
    Prisma,
    type PaymentEnvironment,
    type PaymentMethod,
} from "@prisma/client";

import {
    getIpaymuConfig,
    IPAYMU_PRODUCTION_BASE_URL,
    IPAYMU_SANDBOX_BASE_URL,
    type PayEnvironment,
} from "@/lib/payment/config";
import {
    channelIsAllowed,
    findPaymentMethodOption,
} from "./method-catalog";
import {
    classifyIpaymuNotification,
    createDirectPayment,
    createRedirectPayment,
    mapPaymentMethod,
    verifyWebhookSignature,
    type IpaymuNotification,
    type IpaymuPaymentChannel,
    type IpaymuPaymentMethod,
    type IpaymuStatusClass,
} from "@/lib/payment/ipaymu";

/**
 * ==========================================
 * TICKETING PAYMENT GATEWAY SEAM (design §13.5)
 * ==========================================
 *
 * §13.5 asks for exactly this file:
 *
 *   "Phase 0 has `lib/payment/config.ts`, `lib/payment/ipaymu.ts`,
 *    `lib/payment/ipaymu-production.ts`. The design keeps those and adds a thin seam so
 *    ticketing code never imports iPaymu directly:
 *
 *      lib/ticketing/payment/service.ts
 *          createSession(order)        → { paymentUrl, providerSessionId, expiresAt }
 *          settlementFor(webhookEvent) → { verdict: PAID | PENDING | FAILED | UNKNOWN, reference }
 *          ...
 *              implemented by →  lib/payment/ipaymu/ (existing code, adapted)
 *              future        →  another provider, same seam"
 *
 * So this module is the ONLY place under `lib/ticketing/**` allowed to import
 * `lib/payment/**`. Everything else in the ticketing payment path speaks the small
 * vocabulary defined here. That is what makes `D-17`'s answer ("No second provider
 * now, but keep the seam so adding one is not a rewrite") true in the code rather than
 * only in the design document.
 *
 * ── WHAT IS REUSED, AND WHY NOTHING IS REIMPLEMENTED ─────────────────────────────
 * Every cryptographic and classification primitive is the existing, tested one:
 *
 *   raw-body HMAC-SHA256 verification   → `verifyWebhookSignature` (§13.0 row 2)
 *   status → success|pending|failed|unknown → `classifyIpaymuNotification` (§13.0 row 4)
 *   method/channel → internal enum       → `mapPaymentMethod`
 *   environment-aware credentials        → `getIpaymuConfig` (§13.0 row 3)
 *
 * §13.0's table lists these as properties that MUST be preserved, not rewritten:
 * "the design therefore **wraps and extends** the existing chain rather than replacing
 * it". No signature logic, no status table and no credential resolution is duplicated
 * here — that would create a second source of truth for the platform's security
 * behavior.
 *
 * ── FAIL-CLOSED CONFIGURATION ────────────────────────────────────────────────────
 * `getIpaymuConfig()` throws `PaymentConfigError` when `PAYMENT_ENVIRONMENT` is not
 * exactly `sandbox`/`production`, when credentials are missing, or when the base URL is
 * not on the allow-list. `isConfigured()` converts that into a boolean so the payment
 * service can answer `PROVIDER_UNAVAILABLE` (503) instead of leaking a 500 — and so a
 * misconfigured deployment can never silently reach the wrong endpoint.
 *
 * ── THE ONE `Number` COERCION, AND WHY IT IS SAFE ────────────────────────────────
 * `createRedirectPayment` is typed with `amount: number` because the provider's wire
 * format is a JSON number. That is a *transport serialization*, not money arithmetic:
 * the value passed in is the already-rounded decimal STRING that is persisted on the
 * order (design §17.5: "Round once, at the point a monetary value is first persisted"),
 * and `requireSafeRupiah` refuses anything that is not an exact non-negative safe
 * integer. No addition, subtraction or rounding happens on a float anywhere in this
 * phase — brief §16 bans exactly that, and `lib/ticketing/order-payload.ts` keeps every
 * stored amount in `Prisma.Decimal`.
 */

/** Raised for a value that cannot be sent to the gateway without losing precision. */
export class UnsafeGatewayAmountError extends Error {
    constructor(value: string) {
        super(
            `Refusing to send a non-integer or unsafe rupiah amount to the gateway: ${value}`
        );
        this.name = "UnsafeGatewayAmountError";
    }
}

/**
 * Convert a persisted decimal-string amount into the wire number the provider expects.
 *
 * Single-currency MVP (design §36.5: currency is `IDR`), and MVP amounts are rounded to
 * whole rupiah at persistence (`roundToRupiah` in `lib/ticketing/checkout.ts`), so a
 * value with a fractional part, a negative sign, or a magnitude beyond `2^53 - 1` is a
 * data problem rather than something to send optimistically.
 */
export function requireSafeRupiah(amount: Prisma.Decimal | string): number {
    const decimal = new Prisma.Decimal(amount);
    const asString = decimal.toFixed(2);

    if (!decimal.isFinite() || decimal.isNegative()) {
        throw new UnsafeGatewayAmountError(asString);
    }

    if (!decimal.isInteger()) {
        throw new UnsafeGatewayAmountError(asString);
    }

    const asNumber = Number(asString);

    if (!Number.isSafeInteger(asNumber)) {
        throw new UnsafeGatewayAmountError(asString);
    }

    return asNumber;
}

/**
 * The Prisma enum snapshot for a `Payment`.
 *
 * Design §13.2: `providerEnvironment` is a **snapshot**, "so a later environment switch
 * cannot mis-explain an old payment". It is captured from the same resolver the gateway
 * call uses, so the row always describes the environment the session was actually
 * created in.
 */
export async function resolvePaymentEnvironment(): Promise<PaymentEnvironment> {
    const config = getIpaymuConfig();

    return config.environment === "production" ? "PRODUCTION" : "SANDBOX";
}

/** Is the gateway usable at all? Never throws. */
export function isConfigured(): boolean {
    try {
        const config = getIpaymuConfig();

        return Boolean(config.va && config.apiKey && config.baseUrl);
    } catch {
        return false;
    }
}

/**
 * The provider's own endpoint for this environment.
 *
 * Exposed for diagnostics and for the report's evidence; the value is already
 * allow-listed by `buildIpaymuConfig`, so it can only ever be one of the two constants.
 */
export function gatewayBaseUrl(): string {
    const config = getIpaymuConfig();

    return config.baseUrl === IPAYMU_PRODUCTION_BASE_URL
        ? IPAYMU_PRODUCTION_BASE_URL
        : IPAYMU_SANDBOX_BASE_URL;
}

/** The environment name as a string, for payloads and the audit trail. */
export function gatewayEnvironmentName(): PayEnvironment {
    return getIpaymuConfig().environment;
}

/**
 * How long the provider should keep the payment session open, in the units the
 * provider uses.
 *
 * ── D-16 — DECISION REQUIRED, AND WHY THIS IS NOT A GUESS ────────────────────────
 * Design §13.2: "`DECISION REQUIRED` (D-16): the legacy route passes `expired: 1` to
 * iPaymu and the unit (hours vs minutes) has never been verified. `Payment.expiresAt`
 * must be derived from the **same** value as the gateway's own expiry ... Verify against
 * sandbox before Phase 7."
 *
 * The repository contains no sandbox evidence that settles the unit: the (since deleted)
 * retail route sent `expired: 1` and two diagnostic scripts still do, and the create
 * response (`IpaymuResponse.Data`) carries only `SessionId` and `Url` — no expiry — so
 * the value cannot be read back either. §31.6 lists the sandbox verification as
 * explicit Phase 7 gate work and it has not been performed (see the report).
 *
 * So the value passed here is OUR OWN window, expressed in the platform's configured
 * unit: `PlatformSetting.reservationTtlMinutes` (design §11.4, LOCKED). Design §11.4
 * also fixes the direction of the relationship:
 *
 *   "TTL is configurable per platform (`PlatformSetting.reservationTtlMinutes`), default
 *    30 minutes, and must be **≤ the gateway session expiry**."
 *
 * Passing the TTL and setting `Payment.expiresAt = EventOrder.expiresAt` therefore
 * satisfies that constraint under BOTH remaining candidates for the unit:
 *
 *   unit = minutes → gateway expiry == our window            (exact alignment)
 *   unit = hours   → gateway expiry >  our window            (still `TTL ≤ expiry`)
 *
 * and it can never produce the one outcome the design forbids — a gateway session that
 * lapses while the platform still considers the order payable. The residual risk is the
 * opposite direction (a provider window longer than ours), which is not a lost sale: it
 * is the documented late-settlement path of design §11.4 / §12.3, which this phase
 * implements and tests. If D-16 is later answered "hours", the only change is this
 * function.
 */
export function gatewaySessionExpiryValue(ttlMinutes: number): number {
    return Math.max(1, Math.trunc(ttlMinutes));
}

export type GatewaySessionInput = {
    /** Our reference, stored on `Payment.paymentReference` (design §13.2). */
    referenceId: string;
    /** The authoritative, already-persisted amount. Decimal string. */
    amount: Prisma.Decimal | string;
    currency: string;
    buyerName: string;
    buyerEmail: string;
    buyerPhone: string;
    /** One entry per order line; `qty` and `price` are parallel arrays. */
    items: readonly {
        name: string;
        quantity: number;
        /** Persisted snapshot price, as a decimal string. */
        unitPrice: string;
    }[];
    notifyUrl: string;
    returnUrl: string;
    cancelUrl: string;
    method: PaymentMethod;
    /** Provider channel code, or null to use the method's default. */
    channel: string | null;
    /**
     * Our reservation TTL in minutes. See `gatewaySessionExpiryValue` for why the value
     * is passed as-is and what D-16 governs.
     */
    ttlMinutes: number;
};

export type GatewaySession = {
    paymentUrl: string;
    providerSessionId: string | null;
    environment: PaymentEnvironment;
    /** The method/channel actually sent, after provider mapping. */
    method: PaymentMethod;
    channel: string;
    /** The raw value sent as the provider's own session-expiry parameter. */
    expiryValueSent: number;
    /** Always `REDIRECT`: this result means the buyer finishes on the provider's page. */
    flow: "REDIRECT";
};

/* ==================================================================================
 * PAYMENT METHODS THAT CAN ACTUALLY BE OFFERED
 * ==================================================================================
 *
 * The catalog itself lives in `./method-catalog`, unchanged, and is re-exported here so
 * every server-side consumer keeps importing the payment seam rather than reaching into a
 * leaf module. It is NOT defined in this file because the buyer's method picker is a client
 * component and this file imports `@prisma/client` and Node's `crypto` — importing the
 * catalog from here would drag both into the browser bundle.
 *
 * The catalog's provenance (iPaymu's published API v2 collection, method by method and
 * channel by channel) is documented at its definition, together with what is deliberately
 * NOT offered and why.
 */

export {
    PAYMENT_METHOD_OPTIONS,
    PURCHASABLE_METHOD_VALUES,
    channelIsAllowed,
    findPaymentMethodOption,
    type PaymentChannelOption,
    type PaymentMethodOption,
} from "./method-catalog";

/**
 * What the direct endpoint gave us, in the platform's own vocabulary.
 *
 * `null` on an instruction field means the provider did not return it — never that it
 * returned an empty string that was coerced. The payment page is required to handle a
 * missing instruction explicitly rather than render a blank voucher.
 */
export type GatewayInstruction = {
    flow: "DIRECT";
    method: PaymentMethod;
    channel: string;
    environment: PaymentEnvironment;
    providerSessionId: string | null;
    providerTransactionId: string | null;
    /** VA number, retail-outlet payment code, or the QRIS payload. */
    paymentNumber: string | null;
    /** QRIS payload, verbatim from `QrString`. */
    qrString: string | null;
    /** Provider-hosted QR image for `qrString`. */
    qrImageUrl: string | null;
    /** Provider's display name for the instrument. */
    paymentName: string | null;
    /** The provider's OWN expiry, when it returned a parseable one. */
    providerExpiredAt: Date | null;
};

export type GatewayInstructionInput = {
    referenceId: string;
    amount: Prisma.Decimal | string;
    buyerName: string;
    buyerEmail: string;
    buyerPhone: string;
    notifyUrl: string;
    method: PaymentMethod;
    /** Provider channel code, or null for the method's default. */
    channel: string | null;
    /** Our reservation window in minutes; advisory to the provider (see the mapper). */
    ttlMinutes: number;
};

export type GatewayInstructionResult =
    | { ok: true; instruction: GatewayInstruction }
    | { ok: false; reason: "NOT_CONFIGURED" | "NOT_DIRECT" | "REJECTED" | "TRANSPORT_ERROR" };

/**
 * Parse the provider's `Expired` value (`"YYYY-MM-DD HH:mm:ss"`) into an instant.
 *
 * ── THE TIMEZONE ASSUMPTION, STATED PLAINLY ─────────────────────────────────────
 * The provider returns a bare local timestamp with no offset. iPaymu is an Indonesian
 * gateway and every timestamp in its own sample payloads (`created_at`, `paid_at`,
 * `expired_at`) is written in WIB, so the value is read as UTC+07:00. That is an
 * inference from the provider's own data, not a verified contract, and it is isolated
 * here so a later correction touches one function.
 *
 * ── WHY AN IMPLAUSIBLE VALUE IS REJECTED ────────────────────────────────────────
 * If the assumption is ever wrong, the failure would be an expiry rendered seven hours
 * away from the truth — and for a QRIS code that defaults to five minutes, in the
 * WRONG direction the code would look already expired while it is actually live,
 * which is worse than showing no countdown at all. So a parsed expiry that is more
 * than an hour in the past is treated as unparseable and `null` is returned; the
 * caller then falls back to its own window and the page shows no provider expiry.
 */
export function parseProviderExpiry(value: string | null | undefined): Date | null {
    if (!value) {
        return null;
    }

    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
        value.trim()
    );

    if (!match) {
        return null;
    }

    const [, year, month, day, hour, minute, second] = match;
    const parsed = new Date(
        `${year}-${month}-${day}T${hour}:${minute}:${second}+07:00`
    );

    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    if (parsed.getTime() < Date.now() - 60 * 60 * 1000) {
        return null;
    }

    return parsed;
}

/**
 * `createInstruction` — ask the provider for the payment instrument itself.
 *
 * Same result-union discipline as `createSession`: a provider failure becomes a typed
 * reason so the caller writes a FAILED payment row and answers 503, rather than letting
 * an opaque throw escape or, far worse, rendering an instruction that was never issued.
 *
 * No database work happens here, and none of the returned values are trusted as money:
 * `amount` is the caller's already-persisted decimal, and the response's `Total`/`Fee`
 * are NOT used to price anything — they are the provider's own arithmetic and are
 * recorded, if at all, only as facts. Settlement still comes from the verified webhook.
 */
export async function createDirectSession(
    input: GatewayInstructionInput
): Promise<GatewayInstructionResult> {
    if (!isConfigured()) {
        return { ok: false, reason: "NOT_CONFIGURED" };
    }

    const option = findPaymentMethodOption(input.method);

    if (!option || option.flow !== "DIRECT") {
        // A method this catalog does not implement as a direct instruction (credit card,
        // or anything unknown). Refused here rather than sent to an endpoint that would
        // answer with a validation error we would then have to interpret.
        return { ok: false, reason: "NOT_DIRECT" };
    }

    // The channel must belong to the chosen method. A caller-supplied channel that does
    // not is refused, not defaulted: see `channelIsAllowed`.
    const channel =
        input.channel ?? option.defaultChannel ?? "";

    if (!channelIsAllowed(input.method, channel)) {
        return { ok: false, reason: "REJECTED" };
    }

    const amount = requireSafeRupiah(input.amount);

    try {
        const response = await createDirectPayment({
            name: input.buyerName,
            phone: input.buyerPhone,
            email: input.buyerEmail,
            amount,
            notifyUrl: input.notifyUrl,
            referenceId: input.referenceId,
            paymentMethod: option.providerMethod as never,
            paymentChannel: channel as never,
            // Hours, and advisory: several channels cap or ignore it (QRIS defaults to
            // five minutes and cannot be customised), so the RESPONSE's `Expired` is what
            // the platform stores and shows.
            expired: Math.max(1, Math.ceil(input.ttlMinutes / 60)),
            comments: `Pembayaran ${input.referenceId}`,
        });

        const data = response.Data ?? null;

        return {
            ok: true,
            instruction: {
                flow: "DIRECT",
                method: input.method,
                channel,
                environment: await resolvePaymentEnvironment(),
                providerSessionId: data?.SessionId ?? null,
                providerTransactionId:
                    data?.TransactionId === undefined ||
                    data?.TransactionId === null
                        ? null
                        : String(data.TransactionId),
                paymentNumber: data?.PaymentNo ?? null,
                qrString: data?.QrString ?? null,
                qrImageUrl: data?.QrImage ?? null,
                paymentName: data?.PaymentName ?? null,
                providerExpiredAt: parseProviderExpiry(data?.Expired),
            },
        };
    } catch {
        return { ok: false, reason: "TRANSPORT_ERROR" };
    }
}

export type GatewayCreateResult =
    | { ok: true; session: GatewaySession }
    | { ok: false; reason: "NOT_CONFIGURED" | "REJECTED" | "TRANSPORT_ERROR" };

/**
 * Provider method/channel for an internal `PaymentMethod`.
 *
 * Follows the same QUERY-vs-VA convention the retail integration used, so ticketing
 * behaves the same way at the gateway: `QRIS` and `E_WALLET` both route to QRIS,
 * everything else to a BCA virtual account. A caller may still supply an explicit
 * channel; this is the default. Where a DIRECT instrument is available, the catalog in
 * `method-catalog.ts` supersedes this redirect-era default.
 */
function providerMethodFor(method: PaymentMethod): {
    method: IpaymuPaymentMethod;
    channel: IpaymuPaymentChannel;
} {
    const option = findPaymentMethodOption(method);

    // Catalog-driven first, so the hosted page is opened for the method the buyer chose.
    // The credit-card case is the one that used to be impossible: this function's only two
    // outcomes were QRIS and BCA VA, so a card request would have silently opened a bank
    // transfer on a page that the buyer had every reason to believe was a card form.
    if (option) {
        if (option.flow === "REDIRECT") {
            return {
                method: option.providerMethod as IpaymuPaymentMethod,
                channel: (option.defaultChannel ?? "") as IpaymuPaymentChannel,
            };
        }

        // A DIRECT method routed through the redirect endpoint. The service no longer does
        // this (it asks for the instrument instead), but the mapping is kept truthful for
        // any caller that still opens a hosted page for a QR/VA method.
        if (option.method === "VIRTUAL_ACCOUNT" || option.method === "BANK_TRANSFER") {
            return { method: "va", channel: "bca" };
        }

        if (option.method === "RETAIL_OUTLET") {
            return { method: "cstore", channel: "alfamart" };
        }

        return { method: "qris", channel: "qris" };
    }

    // Unmodelled methods (COD, OTHER, legacy BANK_TRANSFER): the historical mapping, kept
    // unchanged because retail-era callers and their tests depend on it.
    if (method === "QRIS" || method === "E_WALLET") {
        return { method: "qris", channel: "qris" };
    }

    return { method: "va", channel: "bca" };
}

/**
 * The method/channel pair that will actually be stored and sent.
 *
 * Deterministic and pure, so the `Payment` row can be created with the final values
 * *before* the network call runs. That ordering matters: the row is the database-level
 * claim that stops a second concurrent request from opening a second provider session,
 * so it must be written first, and it must not have to be re-written afterwards just to
 * correct its own method.
 */
export function resolvePaymentSelection(
    method: PaymentMethod,
    channel: string | null
): { method: PaymentMethod; channel: IpaymuPaymentChannel } {
    const mapped = providerMethodFor(method);
    const chosen =
        channel && isProviderChannel(channel) ? channel : mapped.channel;

    return {
        method: mapPaymentMethod(mapped.method, chosen) as PaymentMethod,
        channel: chosen,
    };
}

/**
 * The channel codes the provider accepts (its own `IpaymuPaymentChannel` union).
 *
 * Declared as a value so a client-supplied channel can be validated before it reaches
 * the wire, instead of being forwarded on trust. An unknown value silently falls back to
 * the method's default rather than surfacing a provider error.
 */
const PROVIDER_CHANNELS: readonly string[] = [
    "bca",
    "bni",
    "mandiri",
    "bri",
    "bsi",
    "permata",
    "cimb",
    "danamon",
    "bmi",
    "qris",
    // The remaining channels the provider documents, so a legitimate code from either
    // endpoint is passed through rather than silently replaced by a default. Which codes
    // are valid for which method is enforced separately, by `channelIsAllowed`.
    "bag",
    "bpd_bali",
    "alfamart",
    "indomaret",
    "mpm",
    "cc",
    "akulaku",
    "rpx",
];

function isProviderChannel(value: string): value is IpaymuPaymentChannel {
    return PROVIDER_CHANNELS.includes(value);
}

/**
 * `createSession` (design §13.5) — ask the provider for a hosted payment page.
 *
 * Deliberately returns a result union instead of throwing: the caller must record a
 * FAILED `Payment` row and answer `PROVIDER_UNAVAILABLE` rather than let an opaque
 * provider error escape (design §25.1's `PROVIDER_UNAVAILABLE` = 503).
 *
 * NO DATABASE WORK HAPPENS HERE. Design §13.3's settlement shape bans external calls
 * inside a database transaction, and the same discipline applies in reverse: the
 * network call is made outside any transaction so a slow provider cannot hold row locks.
 */
export async function createSession(
    input: GatewaySessionInput
): Promise<GatewayCreateResult> {
    if (!isConfigured()) {
        return { ok: false, reason: "NOT_CONFIGURED" };
    }

    const mapped = providerMethodFor(input.method);
    const selection = resolvePaymentSelection(input.method, input.channel);
    const channel = selection.channel;

    const amount = requireSafeRupiah(input.amount);
    const expiryValueSent = gatewaySessionExpiryValue(input.ttlMinutes);

    try {
        const response = await createRedirectPayment({
            product: input.items.map((item) => item.name.slice(0, 50)),
            qty: input.items.map((item) => String(item.quantity)),
            price: input.items.map((item) => item.unitPrice),
            amount,
            buyerName: input.buyerName,
            buyerEmail: input.buyerEmail,
            buyerPhone: input.buyerPhone,
            paymentMethod: mapped.method,
            paymentChannel: channel,
            notifyUrl: input.notifyUrl,
            returnUrl: input.returnUrl,
            cancelUrl: input.cancelUrl,
            referenceId: input.referenceId,
            description: input.items.map((item) => item.name.slice(0, 50)),
            // D-16: the platform's own window value. See `gatewaySessionExpiryValue`.
            expired: expiryValueSent,
        });

        const url = response.Data?.Url;

        if (!url) {
            // A 200 with no URL is a provider-side refusal, not a transport failure.
            return { ok: false, reason: "REJECTED" };
        }

        return {
            ok: true,
            session: {
                paymentUrl: url,
                providerSessionId: response.Data?.SessionId ?? null,
                environment: await resolvePaymentEnvironment(),
                // Report the method as the provider actually received it, so the stored
                // row is not a restatement of our intent.
                method: selection.method,
                channel,
                expiryValueSent,
                flow: "REDIRECT",
            },
        };
    } catch {
        return { ok: false, reason: "TRANSPORT_ERROR" };
    }
}

/**
 * The notification, normalized from the provider's wire format.
 *
 * iPaymu posts `application/x-www-form-urlencoded` with snake_case fields
 * (`reference_id`, `trx_id`, `sid`, `status_code`, `sub_total`, `amount`, `fee`, ...).
 * The mapping to `IpaymuNotification` is the same mapping the (since deleted) retail
 * handler performed, read out of it before deletion so the ticketing path shares one
 * interpretation of the provider's payload instead of re-inventing it.
 */
function normalizeNotification(raw: Record<string, string>): IpaymuNotification {
    const numericStatusCode = Number(raw.status_code);

    return {
        ...raw,
        ReferenceId: raw.reference_id || raw.ReferenceId,
        SessionId: raw.sid || raw.SessionId,
        TransactionId: raw.trx_id || raw.TransactionId,
        Amount: raw.amount || raw.Amount,
        Status:
            raw.status_code !== undefined
                ? numericStatusCode === 1
                    ? 200
                    : numericStatusCode === 0
                      ? 150
                      : numericStatusCode >= 4
                        ? 400
                        : numericStatusCode
                : raw.Status !== undefined
                  ? raw.Status
                  : undefined,
        PaymentMethod: raw.via || raw.PaymentMethod,
        PaymentChannel: raw.channel || raw.PaymentChannel,
        status: raw.status,
    };
}

/** The provider's status, in the four-value vocabulary design §13.0 row 4 fixes. */
export type GatewayVerdict = "PAID" | "PENDING" | "FAILED" | "UNKNOWN";

/** §31.2's `eventType` vocabulary. `refund.completed` exists but is Phase 9 work. */
export type GatewayEventType =
    | "payment.success"
    | "payment.pending"
    | "payment.failed"
    | "refund.completed"
    | "unknown";

export type GatewayCallback = {
    /** The provider's status code, verbatim, for the ledger's forensics column. */
    statusCode: string | null;
    verdict: GatewayVerdict;
    eventType: GatewayEventType;
    /** Our reference (== the `Payment.paymentReference` we sent). */
    referenceId: string | null;
    providerSessionId: string | null;
    providerTransactionId: string | null;
    /**
     * The amount AS REPORTED, as a decimal string. Untrusted until compared against the
     * server-side order total (design §31.2: "Amount AS REPORTED BY THE PROVIDER
     * (untrusted until verified)").
     *
     * `sub_total` is preferred over `amount`, preserving the live handler's documented
     * behavior (§31.6 item 5: the provider may add its own fee on top, so `amount` can
     * legitimately exceed the order total). NULL when neither field parsed as a decimal.
     */
    amountReported: string | null;
    /** The provider's own fee, when reported. Facts only — see D-22 in the report. */
    providerFeeReported: string | null;
    /** The provider's channel, when reported. */
    channel: string | null;
    /** The provider's own session-expiry instant, when reported (`expired_at`). */
    providerExpiredAt: string | null;
    /** True when the payload indicates a refund rather than a payment. */
    isRefund: boolean;
};

/** Map the proven four-value classifier onto §31.2's `eventType` strings. */
function eventTypeFor(
    verdict: GatewayVerdict,
    isRefund: boolean
): GatewayEventType {
    if (isRefund) {
        return "refund.completed";
    }

    switch (verdict) {
        case "PAID":
            return "payment.success";
        case "PENDING":
            return "payment.pending";
        case "FAILED":
            return "payment.failed";
        default:
            return "unknown";
    }
}

function toDecimalString(value: unknown): string | null {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    try {
        const decimal = new Prisma.Decimal(String(value));

        return decimal.isFinite() ? decimal.toFixed(2) : null;
    } catch {
        return null;
    }
}

/** Does this payload describe a refund? */
function isRefundNotification(raw: Record<string, string>): boolean {
    const candidates = [raw.status, raw.status_code, raw.settlement_status];

    return candidates.some((value) =>
        typeof value === "string"
            ? value.toLowerCase().includes("refund")
            : false
    );
}

/**
 * Interpret a verified notification.
 *
 * PURE, apart from nothing at all: it reads a raw form body and returns values. That
 * makes the whole classification matrix unit-testable with no database and no provider,
 * which is why the tests can cover more status shapes than a live sandbox would produce
 * on demand.
 */
export function readCallback(rawBody: string): GatewayCallback {
    const params = new URLSearchParams(rawBody);
    const raw: Record<string, string> = {};

    params.forEach((value, key) => {
        raw[key] = value;
    });

    const notification = normalizeNotification(raw);
    const statusClass: IpaymuStatusClass =
        classifyIpaymuNotification(notification);
    const isRefund = isRefundNotification(raw);

    const verdict: GatewayVerdict =
        statusClass === "success"
            ? "PAID"
            : statusClass === "pending"
              ? "PENDING"
              : statusClass === "failed"
                ? "FAILED"
                : "UNKNOWN";

    return {
        statusCode: raw.status_code ?? null,
        verdict,
        eventType: eventTypeFor(verdict, isRefund),
        referenceId:
            notification.ReferenceId ?? notification.SessionId ?? null,
        providerSessionId: notification.SessionId ?? null,
        providerTransactionId:
            notification.TransactionId ??
            raw.trx_id ??
            raw.payment_id ??
            null,
        amountReported: toDecimalString(
            notification.sub_total ?? notification.Amount
        ),
        providerFeeReported: toDecimalString(
            raw.fee ?? notification.Fee ?? null
        ),
        channel: raw.channel ?? raw.via ?? null,
        providerExpiredAt: raw.expired_at ?? null,
        isRefund,
    };
}

export type SignatureVerification =
    | { ok: true }
    | {
          ok: false;
          reason: "MISSING_SIGNATURE" | "NOT_CONFIGURED" | "INVALID_SIGNATURE";
      };

/**
 * Verify the provider's signature over the EXACT raw bytes (design §13.0 row 1 / §31.5
 * rule 1 and 2).
 *
 * Fail-closed in every branch: no signature header, no configured VA, or a failed
 * comparison all refuse. There is no fall-through path that processes an unverified
 * payload — that is the single most important property of this route, and it is why the
 * verification helper is the existing tested one rather than a re-implementation.
 *
 * ── §31.6 item 1 — THE CALLBACK HEADER SET ───────────────────────────────────────
 * The (since deleted) retail route required `X-Signature` **and** `X-Timestamp` **and**
 * `X-External-ID`, but only `X-Signature` was cryptographically verified, and its own
 * comment recorded the open question:
 *
 *   "the exact header set iPaymu sends (X-Signature only vs X-Signature + X-Timestamp +
 *    X-External-ID) must be confirmed against a real sandbox transaction. ... If sandbox
 *    testing shows iPaymu omits X-Timestamp/X-External-ID, relax only the
 *    non-cryptographic header checks here — never weaken signature verification."
 *
 * That sandbox confirmation has not been performed, so requiring two headers whose
 * presence is unverified risks rejecting every legitimate callback — the failure mode
 * §31.6 item 1 warns about. This verifier therefore requires the **cryptographically
 * meaningful** credential (`X-Signature`) and does not gate on the two non-cryptographic
 * headers. That is the repo's own sanctioned relaxation, and it weakens nothing: the
 * signature is still mandatory and still fail-closed.
 */
export function verifyCallbackSignature(
    rawBody: string,
    signatureHeader: string | null
): SignatureVerification {
    /*
     * Where the signature may be, and why BOTH places are accepted.
     *
     * The provider posts its signature as a `signature` FIELD in the body and says so in its
     * own callback documentation ("remove the `signature` parameter from the received data ...
     * validate the `signature` parameter"). An earlier reading of §31.6 item 1 assumed a
     * header-only credential, which would have refused every real callback as
     * `MISSING_SIGNATURE` and left every paid order unsettled.
     *
     * Accepting both is not a weakening. Exactly ONE value is ever checked — the header when
     * present, otherwise the body field — and the comparison is the same fail-closed
     * HMAC over the same canonical payload. There is still no path that processes an
     * unverified delivery, which is the property that matters.
     */
    let bodySignature: string | null = null;

    try {
        bodySignature = new URLSearchParams(rawBody).get("signature");
    } catch {
        bodySignature = null;
    }

    const provided = signatureHeader ?? bodySignature;

    if (!provided) {
        return { ok: false, reason: "MISSING_SIGNATURE" };
    }

    let va: string;

    try {
        va = getIpaymuConfig().va;
    } catch {
        return { ok: false, reason: "NOT_CONFIGURED" };
    }

    if (!va) {
        return { ok: false, reason: "NOT_CONFIGURED" };
    }

    if (!verifyWebhookSignature(rawBody, provided, va)) {
        return { ok: false, reason: "INVALID_SIGNATURE" };
    }

    return { ok: true };
}

/** Kept so the seam exposes the provider's method mapping without leaking the import. */
export { mapPaymentMethod };
