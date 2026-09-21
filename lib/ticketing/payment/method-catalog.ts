import type { PaymentMethod } from "@prisma/client";

/**
 * ==========================================
 * PAYMENT METHOD CATALOG (ticketing)
 * ==========================================
 *
 * The single answer to "which payment methods may this platform offer a buyer?".
 *
 * ── WHY IT IS ITS OWN MODULE ─────────────────────────────────────────────────────
 * The buyer's method picker is a CLIENT component. `lib/ticketing/payment/gateway.ts`
 * cannot be imported there: it pulls in `@prisma/client` AND `lib/payment/ipaymu.ts`,
 * which imports Node's `crypto`. Both would break the client bundle. Importing the
 * catalog from a module that has neither is what lets the picker be driven by the same
 * list the server validates against, instead of a second hand-written array that can
 * drift away from it. `PaymentMethod` is imported as a TYPE only, so nothing from
 * `@prisma/client` survives into the browser.
 *
 * ── PROVENANCE: iPAYMU'S OWN DOCUMENTED CAPABILITY, NOT MEMORY ───────────────────
 * Every entry is taken from iPaymu's published API v2 collection (the public Postman
 * document "iPaymu Public API v2"), read field by field:
 *
 *   Direct Payment (`POST /api/v2/payment/direct`)
 *     paymentMethod: va | cstore | cod | qris | cc | paylater
 *     paymentChannel:
 *       va       → bag, bca, bpd_bali, bni, cimb, mandiri, bmi, bri, bsi, permata, danamon
 *       cstore   → alfamart, indomaret
 *       cod      → rpx
 *       qris     → mpm
 *       cc       → cc
 *       paylater → akulaku
 *
 *   Redirect Payment (`POST /api/v2/payment`)
 *     paymentMethod (optional, customises the hosted page): va | banktransfer | cstore |
 *     cod | qris | cc
 *
 * ── WHAT IS OFFERED, AND WHAT IS DELIBERATELY NOT ────────────────────────────────
 *
 *   QRIS                DIRECT, channel `mpm`          buyer scans in-app
 *   VIRTUAL_ACCOUNT     DIRECT, 11 documented banks   buyer transfers to a number
 *   RETAIL_OUTLET       DIRECT, alfamart/indomaret    buyer pays a code at a counter
 *   CREDIT_CARD         REDIRECT, method/channel `cc` the provider's page owns the card
 *                                                     form; this application must never
 *                                                     touch card data
 *
 * NOT OFFERED, each for a stated reason:
 *
 *   COD (`cod`, channel rpx)   The provider supports cash on delivery. A digital ticket has
 *                              nothing to deliver, so this product cannot honour it.
 *   PayLater (akulaku)         iPaymu documents it, but neither this platform's
 *                              `PaymentMethod` enum nor its ledger has a paylater bucket, and
 *                              recording a credit product as E_WALLET would be a false entry
 *                              in a financial record. Declaring a bucket is a schema
 *                              decision, so the method is left out rather than mislabelled.
 *   E_WALLET                   Not advertised, and no longer accepted either: an e-wallet pays
 *                              by scanning a QR code, so the provider exposes it as the QRIS
 *                              channel `mpm` and offers no method string this platform can book
 *                              honestly. It used to sit in the request enum "for
 *                              compatibility" while the picker never offered it; that enum now
 *                              derives from this catalog, so the dead value is gone rather than
 *                              lingering as a method a caller could submit but never mean.
 *
 * ── WHAT THIS CATALOG IS NOT ─────────────────────────────────────────────────────
 * It is not a promise that the gateway ACCOUNT has the channel enabled. Feature and health
 * status per channel live behind `GET /api/v2/payment-channels`, which requires credentials
 * this build does not use at request time; a channel the account has not activated is
 * refused by the gateway and surfaces as a failed attempt. Recorded as a configuration item
 * in the report rather than papered over here.
 */

export type PaymentChannelOption = {
    /** The provider's channel code, sent verbatim. */
    code: string;
    /** Indonesian label for the picker. */
    label: string;
};

export type PaymentMethodOption = {
    /** This platform's bucket, stored on `Payment.method`. */
    method: PaymentMethod;
    /** `DIRECT` = the instrument is rendered here; `REDIRECT` = the buyer leaves for it. */
    flow: "DIRECT" | "REDIRECT";
    label: string;
    description: string;
    /** How the buyer settles: scan a QR, transfer to a number, or finish on a page. */
    kind: "QR" | "NUMBER" | "REDIRECT";
    /** The provider's method string, sent verbatim. */
    providerMethod: string;
    /** Channel used when the buyer does not pick one. `null` only for a method with none. */
    defaultChannel: string | null;
    channels: readonly PaymentChannelOption[];
};

export const PAYMENT_METHOD_OPTIONS: readonly PaymentMethodOption[] = [
    {
        method: "QRIS",
        flow: "DIRECT",
        label: "QRIS",
        description: "Scan sekali, bayar dari aplikasi bank atau e-wallet apa pun.",
        kind: "QR",
        providerMethod: "qris",
        defaultChannel: "mpm",
        channels: [{ code: "mpm", label: "QRIS" }],
    },
    {
        method: "VIRTUAL_ACCOUNT",
        flow: "DIRECT",
        label: "Transfer bank (Virtual Account)",
        description: "Nomor Virtual Account khusus untuk pesanan ini.",
        kind: "NUMBER",
        providerMethod: "va",
        defaultChannel: "bca",
        channels: [
            { code: "bca", label: "BCA" },
            { code: "bni", label: "BNI" },
            { code: "bri", label: "BRI" },
            { code: "mandiri", label: "Mandiri" },
            { code: "bsi", label: "BSI" },
            { code: "cimb", label: "CIMB Niaga" },
            { code: "permata", label: "Permata" },
            { code: "danamon", label: "Danamon" },
            { code: "bmi", label: "Muamalat" },
            { code: "bpd_bali", label: "BPD Bali" },
            { code: "bag", label: "BAG" },
        ],
    },
    {
        method: "RETAIL_OUTLET",
        flow: "DIRECT",
        label: "Gerai retail",
        description: "Bayar dengan kode pembayaran di Alfamart atau Indomaret.",
        kind: "NUMBER",
        providerMethod: "cstore",
        defaultChannel: "alfamart",
        channels: [
            { code: "alfamart", label: "Alfamart" },
            { code: "indomaret", label: "Indomaret" },
        ],
    },
    {
        method: "CREDIT_CARD",
        flow: "REDIRECT",
        label: "Kartu kredit / debit",
        description: "Kamu akan diarahkan ke halaman pembayaran yang aman.",
        kind: "REDIRECT",
        providerMethod: "cc",
        /*
         * The provider documents exactly one channel for `cc` (`cc`), and the provenance
         * block above says so. This entry used to declare none, with `defaultChannel: null`
         * — which made the gateway send an EMPTY `paymentChannel`. iPaymu re-normalises the
         * body it receives and drops an empty field, so the hash it verified no longer
         * matched the one we signed and the request was answered `401 unauthorized
         * signature` (reproduced against sandbox). Declaring the real channel is what makes
         * the REDIRECT path selectable at all.
         *
         * One channel means the buyer's bank picker stays hidden for this method (`PayNowButton`
         * renders it only when a method has more than one), so this changes no UI.
         */
        defaultChannel: "cc",
        channels: [{ code: "cc", label: "Kartu kredit / debit" }],
    },
];

/** Look up an offerable method by this platform's `PaymentMethod` value. */
export function findPaymentMethodOption(
    method: string
): PaymentMethodOption | null {
    return (
        PAYMENT_METHOD_OPTIONS.find((option) => option.method === method) ?? null
    );
}

/** The methods a buyer may submit, in the order the picker shows them. */
export const PURCHASABLE_METHOD_VALUES = PAYMENT_METHOD_OPTIONS.map(
    (option) => option.method
) as readonly PaymentMethod[];

/**
 * The channel codes that exist for a method, or an empty list for a method that takes none.
 *
 * Used to validate a client-supplied channel BEFORE it can reach the wire: an unknown
 * channel is refused, never silently swapped for the default, because a buyer who chose BNI
 * must not be handed a BCA number.
 */
export function channelIsAllowed(method: string, channel: string): boolean {
    const option = findPaymentMethodOption(method);

    return Boolean(option?.channels.some((entry) => entry.code === channel));
}
