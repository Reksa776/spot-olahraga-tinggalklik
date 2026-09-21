/**
 * ==========================================
 * PHASE 27E — PROVIDER TRANSACTION-STATUS CLIENT
 * ==========================================
 *
 * The server-to-server status query that reconciliation depends on, tested against the
 * contract that was verified with ONE live sandbox call in Phase 27D:
 *
 *   POST {baseUrl}/api/v2/transaction
 *   body { "transactionId": "233592", "account": "<merchant VA>" }
 *
 * Three families of assertion, in the order they matter:
 *
 *   1. THE WIRE — endpoint, body, headers and signature. If any of these drifts, every
 *      later green test is meaningless, so they are pinned literally.
 *   2. THE PARSER — `normalizeTransactionStatus` is pure, so the entire malformed-response
 *      matrix is exercised without a socket.
 *   3. FAIL-CLOSED BEHAVIOUR — a transport error, a non-2xx, a non-JSON body, a missing
 *      `Data`, a missing transaction id and a missing amount must all come back as
 *      `{ ok: false }`. Never a partial object, never a throw, never a guess.
 *
 * This suite also guards the REGRESSION the phase exists for: the deleted
 * `verifyPaymentStatus` asked the wrong endpoint with the wrong identifier and compared a
 * NUMERIC status to the strings "paid"/"settlement", so its success predicate could never
 * be true. `IPAYMU_SUCCESS_STATUSES` and the URL below are asserted literally so neither the
 * numeric set nor the path can silently drift back.
 */

import {
    fetchTransactionStatus,
    generateSignature,
    IPAYMU_SUCCESS_STATUSES,
    isIpaymuSuccessStatus,
    normalizeTransactionStatus,
} from "@/lib/payment/ipaymu";
import {
    getIpaymuConfig,
    resetIpaymuConfigCache,
} from "@/lib/payment/config";

/** The real sandbox response shape, from Phase 27D (values verbatim). */
function successPayload(overrides: Record<string, unknown> = {}): unknown {
    return {
        Status: 200,
        Success: true,
        Message: "success",
        Data: {
            TransactionId: 233592,
            Status: 1,
            StatusDesc: "Berhasil",
            PaidStatus: "paid",
            SubTotal: 15000,
            Fee: 3500,
            Amount: 15000,
            Type: 7,
            TypeDesc: "VA & Transfer Bank",
            SessionId: "EVT-1789894187056-ef2c2a78",
            ReferenceId: "EVT-1789894187056-ef2c2a78",
            PaymentMethod: "va",
            PaymentChannel: "BNI",
            ...overrides,
        },
    };
}

describe("iPaymu success statuses", () => {
    test("the numeric success set is exactly {1, 6, 7}", () => {
        expect([...IPAYMU_SUCCESS_STATUSES]).toEqual([1, 6, 7]);
    });

    test("the predicate is numeric, not a string comparison", () => {
        // The deleted client compared `Data.Status` to "paid"/"settlement". The provider
        // returns a NUMBER, so `?.toLowerCase()` was always undefined and the predicate
        // could never be true.
        expect(isIpaymuSuccessStatus(1)).toBe(true);
        expect(isIpaymuSuccessStatus(6)).toBe(true);
        expect(isIpaymuSuccessStatus(7)).toBe(true);

        expect(isIpaymuSuccessStatus(0)).toBe(false);
        expect(isIpaymuSuccessStatus(4)).toBe(false);
        expect(isIpaymuSuccessStatus(200)).toBe(false);
    });
});

describe("normalizeTransactionStatus (pure)", () => {
    test("reads the verified sandbox payload completely", () => {
        const result = normalizeTransactionStatus(
            successPayload(),
            "sandbox",
            200
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.status.transactionId).toBe("233592");
        expect(result.status.status).toBe(1);
        expect(result.status.statusDescription).toBe("Berhasil");
        expect(result.status.paidStatus).toBe("paid");
        expect(result.status.amount).toBe(15000);
        expect(result.status.subtotal).toBe(15000);
        expect(result.status.fee).toBe(3500);
        expect(result.status.sessionId).toBe("EVT-1789894187056-ef2c2a78");
        expect(result.status.referenceId).toBe("EVT-1789894187056-ef2c2a78");
        expect(result.status.paymentMethod).toBe("va");
        expect(result.status.paymentChannel).toBe("BNI");
        expect(result.status.environment).toBe("sandbox");
        expect(result.status.httpStatus).toBe(200);
    });

    test("normalises a numeric TransactionId to a string", () => {
        // `233592 === "233592"` is false. The parser is the single place that decides this,
        // so the comparison upstream never has to coerce.
        const numeric = normalizeTransactionStatus(successPayload(), "sandbox", 200);
        const stringy = normalizeTransactionStatus(
            successPayload({ TransactionId: "233592" }),
            "sandbox",
            200
        );

        expect(numeric.ok && numeric.status.transactionId).toBe("233592");
        expect(stringy.ok && stringy.status.transactionId).toBe("233592");
    });

    test.each([[1], [6], [7]])("accepts success status %i", (status) => {
        const result = normalizeTransactionStatus(
            successPayload({ Status: status }),
            "sandbox",
            200
        );

        expect(result.ok).toBe(true);
        expect(result.ok && isIpaymuSuccessStatus(result.status.status)).toBe(true);
    });

    test("a non-success status is still EVIDENCE, not an error", () => {
        // The parser's job is to report what the provider said; deciding that a pending
        // status is not a settlement is the service's job.
        const result = normalizeTransactionStatus(
            successPayload({ Status: 4, PaidStatus: "pending" }),
            "sandbox",
            200
        );

        expect(result.ok).toBe(true);
        expect(result.ok && result.status.status).toBe(4);
        expect(result.ok && isIpaymuSuccessStatus(result.status.status)).toBe(false);
    });

    test("falls back to SubTotal when Amount is absent", () => {
        const result = normalizeTransactionStatus(
            successPayload({ Amount: undefined }),
            "sandbox",
            200
        );

        expect(result.ok && result.status.amount).toBe(15000);
    });

    test("non-2xx is HTTP_ERROR and carries the status", () => {
        expect(
            normalizeTransactionStatus(successPayload(), "sandbox", 500)
        ).toEqual({ ok: false, reason: "HTTP_ERROR", httpStatus: 500 });

        expect(
            normalizeTransactionStatus(successPayload(), "sandbox", 404)
        ).toEqual({ ok: false, reason: "HTTP_ERROR", httpStatus: 404 });
    });

    test("the envelope status must be 200 — `Success` alone is never enough", () => {
        expect(
            normalizeTransactionStatus(
                { Status: 500, Success: true, Data: {} },
                "sandbox",
                200
            )
        ).toEqual({ ok: false, reason: "NOT_SUCCESS_ENVELOPE", httpStatus: 200 });
    });

    test("the `Success` boolean must be true — `Status: 200` alone is never enough", () => {
        const payload = successPayload();
        delete (payload as { Success?: unknown }).Success;

        expect(
            normalizeTransactionStatus(payload, "sandbox", 200)
        ).toEqual({ ok: false, reason: "NOT_SUCCESS_ENVELOPE", httpStatus: 200 });
    });

    test("missing / non-object Data is MALFORMED", () => {
        for (const Data of [undefined, null, "nope", 42]) {
            expect(
                normalizeTransactionStatus({ Status: 200, Success: true, Data }, "sandbox", 200)
            ).toEqual({ ok: false, reason: "MALFORMED", httpStatus: 200 });
        }
    });

    test("a missing TransactionId is MALFORMED", () => {
        expect(
            normalizeTransactionStatus(
                successPayload({ TransactionId: undefined }),
                "sandbox",
                200
            )
        ).toEqual({ ok: false, reason: "MALFORMED", httpStatus: 200 });
    });

    test("a missing amount (Amount AND SubTotal) is MALFORMED, never zero", () => {
        // Never invent a default: an amount is what settlement is gated on. `0` would be a
        // fabricated figure, and MALFORMED is the honest answer.
        expect(
            normalizeTransactionStatus(
                successPayload({ Amount: undefined, SubTotal: undefined }),
                "sandbox",
                200
            )
        ).toEqual({ ok: false, reason: "MALFORMED", httpStatus: 200 });
    });

    test("a non-numeric Status is MALFORMED", () => {
        expect(
            normalizeTransactionStatus(
                successPayload({ Status: "paid" }),
                "sandbox",
                200
            )
        ).toEqual({ ok: false, reason: "MALFORMED", httpStatus: 200 });
    });

    test("a non-object body is MALFORMED", () => {
        for (const raw of [null, "ok", 1, true]) {
            expect(normalizeTransactionStatus(raw, "sandbox", 200)).toEqual({
                ok: false,
                reason: "MALFORMED",
                httpStatus: 200,
            });
        }
    });

    test("an object that is not an envelope is NOT_SUCCESS_ENVELOPE", () => {
        // `[]` and `{}` ARE objects, so they get as far as the envelope check and are
        // refused there — a different reason with the same outcome (no status returned).
        for (const raw of [[], {}]) {
            expect(normalizeTransactionStatus(raw, "sandbox", 200)).toEqual({
                ok: false,
                reason: "NOT_SUCCESS_ENVELOPE",
                httpStatus: 200,
            });
        }
    });
});

describe("fetchTransactionStatus (wire contract)", () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    function stubFetch(handler: (url: string, init: RequestInit) => Response) {
        const calls: { url: string; init: RequestInit }[] = [];

        global.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
            calls.push({ url: String(url), init: init ?? {} });

            return handler(String(url), init ?? {});
        }) as unknown as typeof fetch;

        return calls;
    }

    test("posts to /api/v2/transaction with the documented body, signed the documented way", async () => {
        const config = getIpaymuConfig();

        const calls = stubFetch(
            () =>
                new Response(JSON.stringify(successPayload()), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                })
        );

        const result = await fetchTransactionStatus("233592");

        expect(result.ok).toBe(true);
        expect(calls).toHaveLength(1);

        // ── THE ENDPOINT AND THE ENVIRONMENT ────────────────────────────────────
        expect(calls[0].url).toBe(`${config.baseUrl}/api/v2/transaction`);
        expect(calls[0].url).toContain("sandbox.ipaymu.com");

        // ── THE REQUEST BODY ────────────────────────────────────────────────────
        const body = calls[0].init.body as string;
        expect(JSON.parse(body)).toEqual({
            transactionId: "233592",
            account: config.va,
        });

        // ── THE HEADERS, AND THAT THE SIGNATURE IS THE PLATFORM'S OWN ───────────
        const headers = calls[0].init.headers as Record<string, string>;

        expect(headers["Content-Type"]).toBe("application/json");
        expect(headers.va).toBe(config.va);
        expect(headers.signature).toBe(
            generateSignature(body, config.va, config.apiKey)
        );
        expect(headers.timestamp).toMatch(/^\d{14}$/);

        // ── AND NOTHING ELSE: no credential ever travels in a body/query ────────
        expect(body).not.toContain(config.apiKey);
        expect(calls[0].url).not.toContain(config.apiKey);
        expect(calls[0].url).not.toContain(config.va);
    });

    test("an empty transaction id never reaches the socket", async () => {
        const calls = stubFetch(() => new Response("{}", { status: 200 }));

        expect(await fetchTransactionStatus("")).toEqual({
            ok: false,
            reason: "MALFORMED",
        });
        expect(await fetchTransactionStatus("   ")).toEqual({
            ok: false,
            reason: "MALFORMED",
        });

        expect(calls).toHaveLength(0);
    });

    test("a transport failure is TRANSPORT_ERROR, not a throw and not a success", async () => {
        stubFetch(() => {
            throw new Error("ECONNREFUSED");
        });

        expect(await fetchTransactionStatus("233592")).toEqual({
            ok: false,
            reason: "TRANSPORT_ERROR",
        });
    });

    test("a timeout (abort) is TRANSPORT_ERROR", async () => {
        stubFetch(() => {
            const error = new Error("aborted");
            error.name = "AbortError";
            throw error;
        });

        expect(await fetchTransactionStatus("233592")).toEqual({
            ok: false,
            reason: "TRANSPORT_ERROR",
        });
    });

    test("a non-JSON body on a 2xx is MALFORMED; on a 5xx it is HTTP_ERROR", async () => {
        stubFetch(() => new Response("<html>nope</html>", { status: 200 }));

        expect(await fetchTransactionStatus("233592")).toEqual({
            ok: false,
            reason: "MALFORMED",
            httpStatus: 200,
        });

        stubFetch(() => new Response("<html>gateway</html>", { status: 502 }));

        expect(await fetchTransactionStatus("233592")).toEqual({
            ok: false,
            reason: "HTTP_ERROR",
            httpStatus: 502,
        });
    });

    test("a malformed 200 body fails closed rather than returning a partial status", async () => {
        stubFetch(() =>
            new Response(JSON.stringify(successPayload({ TransactionId: undefined })), {
                status: 200,
                headers: { "content-type": "application/json" },
            })
        );

        expect(await fetchTransactionStatus("233592")).toEqual({
            ok: false,
            reason: "MALFORMED",
            httpStatus: 200,
        });
    });

    test("unusable credentials produce NOT_CONFIGURED and no request", async () => {
        const calls = stubFetch(() => new Response("{}", { status: 200 }));

        const saved = process.env.PAYMENT_ENVIRONMENT;
        delete process.env.PAYMENT_ENVIRONMENT;
        resetIpaymuConfigCache();

        try {
            expect(await fetchTransactionStatus("233592")).toEqual({
                ok: false,
                reason: "NOT_CONFIGURED",
            });
            expect(calls).toHaveLength(0);
        } finally {
            if (saved === undefined) {
                delete process.env.PAYMENT_ENVIRONMENT;
            } else {
                process.env.PAYMENT_ENVIRONMENT = saved;
            }
            resetIpaymuConfigCache();
        }
    });
});
