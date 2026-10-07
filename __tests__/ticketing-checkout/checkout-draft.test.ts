import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import TicketPurchaseForm from "@/components/events/TicketPurchaseForm";
import { decideSessionGate } from "@/lib/auth/session-gate";
import { loginUrlForCurrentPage } from "@/lib/auth/client-session";
import { postLoginDestination, resolveSafeCallbackUrl } from "@/lib/auth/redirect";
import { checkoutRequestSchema } from "@/lib/ticketing/checkout-validation";
import {
    CHECKOUT_DRAFT_MAX_ITEMS,
    CHECKOUT_DRAFT_STORAGE_KEY,
    CHECKOUT_DRAFT_TTL_MS,
    clearCheckoutDraft,
    consumeCheckoutDraft,
    readCheckoutDraft,
    restoreDraftQuantities,
    saveCheckoutDraft,
    type CheckoutDraftInput,
    type RestorableTicketType,
} from "@/lib/ticketing/checkout-draft";

/**
 * ==========================================
 * PRESERVE THE CHECKOUT FORM ACROSS LOGIN
 * ==========================================
 *
 * The flow under test, end to end but without a browser:
 *
 *   guest on /e/{slug} → fills the purchase card → "Pesan tiket" → the server answers 401 →
 *   the form is written to sessionStorage → `/login?callbackUrl=%2Fe%2F{slug}` → sign in →
 *   back on /e/{slug} → the form is restored from the draft, re-validated against the catalog
 *   the page just rendered, and the draft is consumed.
 *
 * The suites below pin the seven properties the brief asks for, and they are pinned where the
 * property actually lives: the storage/validation rules against the real module (with a fake
 * `sessionStorage`), the return path against the REAL redirect validator and session gate (so a
 * regression in either is caught here too), the wire contract against the REAL checkout schema
 * (so "a restored draft cannot change what is charged" is proven with the schema the route uses),
 * and the wiring against the form's own source, because the two call sites are the part a
 * refactor can silently drop.
 */

const ROOT = path.resolve(__dirname, "..", "..");

function read(relativePath: string): string {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/** Strip comments so prose that NAMES a retired or forbidden thing is not read as using it. */
function readCode(relativePath: string): string {
    return read(relativePath)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
}

const FORM = "components/events/TicketPurchaseForm.tsx";
const DRAFT_MODULE = "lib/ticketing/checkout-draft.ts";

/*
 * The form is a client component, but its FIRST pass is the server's: `useSyncExternalStore`
 * resolves `getServerSnapshot` for it. Rendering it with `react-dom/server` therefore exercises the
 * exact path the browser hydrates against, which is the half of the restore that MUST agree with
 * the server's markup. `useRouter` is the only thing needing a breadcrumb.
 */
jest.mock("next/navigation", () => ({
    useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

/* ==================================================================================
 * A fake `sessionStorage`, because the suites run in a node environment
 * ================================================================================== */

class MemoryStorage {
    private readonly entries = new Map<string, string>();

    get length(): number {
        return this.entries.size;
    }

    clear(): void {
        this.entries.clear();
    }

    getItem(key: string): string | null {
        return this.entries.has(key) ? this.entries.get(key)! : null;
    }

    key(index: number): string | null {
        return Array.from(this.entries.keys())[index] ?? null;
    }

    removeItem(key: string): void {
        this.entries.delete(key);
    }

    setItem(key: string, value: string): void {
        this.entries.set(key, value);
    }
}

let store: MemoryStorage;

/** Install a browser-ish global. `sessionStorage` is a real storage unless overridden. */
function installBrowser(sessionStorage: unknown = store): void {
    (globalThis as { window?: unknown }).window = {
        location: { pathname: "/e/liga-basket-bandung", search: "" },
        sessionStorage,
    };
}

function removeBrowser(): void {
    delete (globalThis as { window?: unknown }).window;
}

/** The body the purchase form builds, as the example in the brief describes it. */
const DRAFT_INPUT: CheckoutDraftInput = {
    eventId: "evt_bandung",
    items: [{ ticketTypeId: "tt_tribun", quantity: 2 }],
    buyerName: "Budi",
    buyerEmail: "budi@example.com",
    buyerPhone: "08123456789",
    shareToken: null,
};

beforeEach(() => {
    store = new MemoryStorage();
    installBrowser();
});

afterEach(() => {
    removeBrowser();
    jest.restoreAllMocks();
});

/* ==================================================================================
 * A. GUEST CHECKOUT — the form is written before the redirect
 * ================================================================================== */

describe("A. a guest's form is preserved when the server asks them to sign in", () => {
    it("stores the draft under one known key", () => {
        expect(saveCheckoutDraft(DRAFT_INPUT)).not.toBeNull();

        const raw = store.getItem(CHECKOUT_DRAFT_STORAGE_KEY);

        expect(raw).not.toBeNull();
        expect(JSON.parse(raw!)).toMatchObject({
            eventId: "evt_bandung",
            items: [{ ticketTypeId: "tt_tribun", quantity: 2 }],
            buyerName: "Budi",
            buyerEmail: "budi@example.com",
            buyerPhone: "08123456789",
            shareToken: null,
        });
    });

    it("stores exactly the fields a restore needs — and nothing else", () => {
        saveCheckoutDraft(DRAFT_INPUT);

        const record = JSON.parse(store.getItem(CHECKOUT_DRAFT_STORAGE_KEY)!);

        expect(Object.keys(record).sort()).toEqual([
            "buyerEmail",
            "buyerName",
            "buyerPhone",
            "eventId",
            "items",
            "savedAt",
            "shareToken",
        ]);
    });

    it("stamps the save time, which is the only thing that can expire it", () => {
        const now = 1_760_000_000_000;
        const saved = saveCheckoutDraft(DRAFT_INPUT, now);

        expect(saved?.savedAt).toBe(now);
    });

    it("is a silent no-op without a browser, so a server render cannot throw", () => {
        removeBrowser();

        expect(saveCheckoutDraft(DRAFT_INPUT)).toBeNull();
        expect(readCheckoutDraft("evt_bandung")).toBeNull();
        expect(() => clearCheckoutDraft()).not.toThrow();
    });

    it("survives a storage that throws on access or on write", () => {
        const hostile = {
            get length(): number {
                throw new Error("blocked");
            },
            clear: () => {
                throw new Error("blocked");
            },
            getItem: () => {
                throw new Error("blocked");
            },
            key: () => {
                throw new Error("blocked");
            },
            removeItem: () => {
                throw new Error("blocked");
            },
            setItem: () => {
                throw new Error("blocked");
            },
        };

        installBrowser(hostile);

        expect(() => saveCheckoutDraft(DRAFT_INPUT)).not.toThrow();
        expect(saveCheckoutDraft(DRAFT_INPUT)).toBeNull();
        expect(() => readCheckoutDraft("evt_bandung")).not.toThrow();
        expect(readCheckoutDraft("evt_bandung")).toBeNull();
    });

    it("the 401 branch writes the draft BEFORE it navigates to login", () => {
        const code = readCode(FORM);

        const expiryAt = code.indexOf("isSessionExpired(response.status, payload)");
        const genericAt = code.indexOf("if (!response.ok)");

        expect(expiryAt).toBeGreaterThan(-1);
        expect(genericAt).toBeGreaterThan(expiryAt);

        const branch = code.slice(expiryAt, genericAt);

        const saveAt = branch.indexOf("saveCheckoutDraft(");
        const redirectAt = branch.indexOf("redirectToLoginForExpiredSession();");

        expect(saveAt).toBeGreaterThan(-1);
        expect(redirectAt).toBeGreaterThan(-1);
        // Order matters: the draft has to exist before the document unloads.
        expect(saveAt).toBeLessThan(redirectAt);
    });

    it("preserves only the same five fields the request carries — never money or availability", () => {
        const code = readCode(FORM);

        const expiryAt = code.indexOf("isSessionExpired(response.status, payload)");
        const branch = code.slice(expiryAt, code.indexOf("if (!response.ok)"));

        const saved = branch.slice(
            branch.indexOf("saveCheckoutDraft("),
            branch.indexOf("});", branch.indexOf("saveCheckoutDraft("))
        );

        for (const field of ["eventId", "items", "buyerName", "buyerEmail", "buyerPhone"]) {
            expect(saved).toContain(field);
        }

        for (const forbidden of ["price", "total", "subtotal", "quota", "remaining", "isSoldOut"]) {
            expect(saved).not.toContain(forbidden);
        }
    });
});

/* ==================================================================================
 * B. LOGIN RESTORATION — back to the same event, form repopulated
 * ================================================================================== */

describe("B. signing in returns the buyer to the same event with the form restored", () => {
    const SLUG_PATH = "/e/liga-basket-bandung?pic=share-token-1";

    it("the login URL a guest at /e/{slug} is sent to carries that page as the return path", () => {
        expect(
            loginUrlForCurrentPage({ pathname: "/e/liga-basket-bandung", search: "" })
        ).toBe("/login?callbackUrl=%2Fe%2Fliga-basket-bandung");
    });

    it("after signing in, the destination is the event detail page — not the dashboard", () => {
        expect(postLoginDestination(SLUG_PATH)).toBe(SLUG_PATH);
        expect(postLoginDestination(SLUG_PATH)).not.toBe("/dashboard");
        expect(postLoginDestination("/e/liga-basket-bandung")).not.toBe("/");
    });

    it("gives every saved field back: name, email, phone and the ticket quantities", () => {
        saveCheckoutDraft(DRAFT_INPUT);

        const draft = consumeCheckoutDraft("evt_bandung");

        expect(draft).not.toBeNull();
        expect(draft!.buyerName).toBe("Budi");
        expect(draft!.buyerEmail).toBe("budi@example.com");
        expect(draft!.buyerPhone).toBe("08123456789");

        const ticketTypes: RestorableTicketType[] = [
            {
                id: "tt_tribun",
                minPerOrder: 1,
                maxPerOrder: 4,
                salesState: "OPEN",
                isSoldOut: false,
            },
        ];

        expect(restoreDraftQuantities(draft!.items, ticketTypes, 10)).toEqual({
            tt_tribun: 2,
        });
    });

    it("restores the PIC share token recorded at save time", () => {
        saveCheckoutDraft({ ...DRAFT_INPUT, shareToken: "share-token-1" });

        expect(consumeCheckoutDraft("evt_bandung")?.shareToken).toBe("share-token-1");
    });

    it("consumes the draft on restore, so it can never be applied a second time", () => {
        saveCheckoutDraft(DRAFT_INPUT);

        expect(consumeCheckoutDraft("evt_bandung")).not.toBeNull();
        expect(store.getItem(CHECKOUT_DRAFT_STORAGE_KEY)).toBeNull();

        // A refresh, a back navigation or a remount finds nothing to re-apply.
        expect(consumeCheckoutDraft("evt_bandung")).toBeNull();
    });

    it("the form reads the draft through the hydration-safe external-store hook", () => {
        const code = readCode(FORM);

        // `useBrowserValue` is the project's existing pattern for a client-only value:
        // `useSyncExternalStore` renders the SERVER snapshot first (the server's HTML and the
        // hydrating client therefore agree) and the browser's value in the next commit. A plain
        // `useState` + `setState`-in-effect reading would both hydrate awkwardly and trip the
        // project's lint rules.
        expect(code).toContain('from "@/lib/ui/browser-value"');
        expect(code).toContain("readCheckoutDraft(eventId)");
        expect(code).toContain("useBrowserValue<CheckoutDraft | null>(readDraft, null)");
    });

    it("re-validates the restored selection against the catalog this render received", () => {
        const code = readCode(FORM);

        expect(code).toContain("restoreDraftQuantities(");
        expect(code).toContain("DEFAULT_MAX_PER_SELECTION");
    });

    it("consumes the draft in an effect that sets no state, once per event", () => {
        const code = readCode(FORM);

        const effectAt = code.indexOf("useEffect(");
        const consumeAt = code.indexOf("consumeCheckoutDraft(eventId)");

        expect(effectAt).toBeGreaterThan(-1);
        expect(consumeAt).toBeGreaterThan(effectAt);

        const effect = code.slice(effectAt, code.indexOf("}, [eventId]);", consumeAt));

        // A write to an external system, not a cascading render.
        expect(effect).not.toContain("setState");
        expect(effect).not.toContain("setQuantity");
        expect(effect).not.toContain("setName");
    });

    it("keeps no React state holding the restored values, so a remount cannot re-apply them", () => {
        const code = readCode(FORM);

        expect(code).not.toContain("useState(draft");
        expect(code).not.toContain("setBuyerName(");
        expect(code).not.toContain("setBuyerEmail(");
        expect(code).not.toContain("setBuyerPhone(");
    });
});

/* ==================================================================================
 * C. EVENT ISOLATION — Event A never appears on Event B
 * ================================================================================== */

describe("C. a draft is bound to one event", () => {
    it("refuses to hand Event A's draft to Event B", () => {
        saveCheckoutDraft(DRAFT_INPUT);

        expect(readCheckoutDraft("evt_surabaya")).toBeNull();
        expect(consumeCheckoutDraft("evt_surabaya")).toBeNull();

        // …and does NOT destroy it: the tab may still be mid-purchase on Event A.
        expect(readCheckoutDraft("evt_bandung")).not.toBeNull();
    });

    it("a second event's purchase replaces the first, so there is only ever one intent", () => {
        saveCheckoutDraft(DRAFT_INPUT);
        saveCheckoutDraft({
            ...DRAFT_INPUT,
            eventId: "evt_surabaya",
            buyerName: "Siti",
            items: [{ ticketTypeId: "tt_vip", quantity: 1 }],
        });

        expect(readCheckoutDraft("evt_bandung")).toBeNull();

        const next = consumeCheckoutDraft("evt_surabaya");

        expect(next?.buyerName).toBe("Siti");
        expect(next?.items).toEqual([{ ticketTypeId: "tt_vip", quantity: 1 }]);
    });

    it("a tier id from another event cannot restore a quantity onto this one", () => {
        // Belt and braces behind the eventId check: even if a record were applied to the wrong
        // event, only tiers THAT event actually sells can produce a quantity.
        const restored = restoreDraftQuantities(
            [
                { ticketTypeId: "tt_from_event_a", quantity: 2 },
                { ticketTypeId: "tt_this_event", quantity: 1 },
            ],
            [
                {
                    id: "tt_this_event",
                    minPerOrder: 1,
                    maxPerOrder: 4,
                    salesState: "OPEN",
                    isSoldOut: false,
                },
            ],
            10
        );

        expect(restored).toEqual({ tt_this_event: 1 });
    });
});

/* ==================================================================================
 * D. LOGGED-IN FLOW — a signed-in buyer stays on the event, never on the dashboard
 * ================================================================================== */

describe("D. a buyer who is already signed in stays in the event flow", () => {
    it("an authenticated visitor to /login comes back to the event, not to /dashboard", () => {
        const decision = decideSessionGate(
            { platformRole: "CUSTOMER" },
            "/e/liga-basket-bandung"
        );

        expect(decision).toEqual({
            action: "redirect",
            to: "/e/liga-basket-bandung",
        });
    });

    it("the same holds for a back-office account opening a shared event link", () => {
        expect(
            decideSessionGate({ platformRole: "ADMIN" }, "/e/liga-basket-bandung")
        ).toEqual({ action: "redirect", to: "/e/liga-basket-bandung" });
    });

    it("only an absent callback falls back to a role default", () => {
        // Unchanged behaviour, pinned so this feature cannot silently retarget it.
        expect(decideSessionGate({ platformRole: "CUSTOMER" }, null)).toEqual({
            action: "redirect",
            to: "/",
        });

        expect(decideSessionGate({ platformRole: "ADMIN" }, null)).toEqual({
            action: "redirect",
            to: "/dashboard",
        });
    });

    it("an anonymous visitor still gets the form", () => {
        expect(decideSessionGate(null, "/e/liga-basket-bandung")).toEqual({
            action: "render-form",
        });
    });

    it("the form never navigates to the dashboard after a successful order", () => {
        const code = readCode(FORM);

        expect(code).not.toContain("/dashboard");

        // The buyer continues into their own order — the existing post-order destination.
        expect(code).toContain("router.push(`/ticketing/orders/${orderNumber}`)");
    });
});

/* ==================================================================================
 * E. STALE / INVALID STATE — never a crash, always the normal form
 * ================================================================================== */

describe("E. an expired, corrupted or hostile draft degrades to the empty form", () => {
    it("expires after the TTL", () => {
        const now = 1_760_000_000_000;

        saveCheckoutDraft(DRAFT_INPUT, now);

        expect(readCheckoutDraft("evt_bandung", now + CHECKOUT_DRAFT_TTL_MS - 1)).not.toBeNull();
        expect(readCheckoutDraft("evt_bandung", now + CHECKOUT_DRAFT_TTL_MS + 1)).toBeNull();
        expect(consumeCheckoutDraft("evt_bandung", now + CHECKOUT_DRAFT_TTL_MS + 1)).toBeNull();
    });

    it("rejects a save time in the future beyond clock skew", () => {
        saveCheckoutDraft(DRAFT_INPUT, 1_760_000_000_000);

        expect(readCheckoutDraft("evt_bandung", 1_760_000_000_000 - 5 * 60 * 1000)).toBeNull();
    });

    it.each([
        ["not JSON at all", "}{"],
        ["a JSON scalar", "\"hello\""],
        ["null", "null"],
        ["an array", "[]"],
        ["an empty object", "{}"],
        ["a missing event id", JSON.stringify({ items: DRAFT_INPUT.items, savedAt: 1 })],
        [
            "no usable items",
            JSON.stringify({ eventId: "evt_bandung", items: [], savedAt: Date.now() }),
        ],
        [
            "items of the wrong shape",
            JSON.stringify({
                eventId: "evt_bandung",
                items: [{ ticketTypeId: 12, quantity: "many" }],
                savedAt: Date.now(),
            }),
        ],
        [
            "a missing timestamp",
            JSON.stringify({ eventId: "evt_bandung", items: DRAFT_INPUT.items }),
        ],
    ])("returns null for %s, without throwing", (_label, serialized) => {
        store.setItem(CHECKOUT_DRAFT_STORAGE_KEY, serialized);

        expect(() => consumeCheckoutDraft("evt_bandung")).not.toThrow();
        expect(consumeCheckoutDraft("evt_bandung")).toBeNull();
    });

    it("caps an oversized payload instead of trusting its length", () => {
        const items = Array.from({ length: CHECKOUT_DRAFT_MAX_ITEMS + 25 }, (_, index) => ({
            ticketTypeId: `tt_${index}`,
            quantity: 1,
        }));

        store.setItem(
            CHECKOUT_DRAFT_STORAGE_KEY,
            JSON.stringify({
                eventId: "evt_bandung",
                items,
                buyerName: "B".repeat(5000),
                buyerEmail: "budi@example.com",
                buyerPhone: "08123456789",
                savedAt: Date.now(),
            })
        );

        const draft = consumeCheckoutDraft("evt_bandung");

        expect(draft).not.toBeNull();
        expect(draft!.items).toHaveLength(CHECKOUT_DRAFT_MAX_ITEMS);
        expect(draft!.buyerName.length).toBeLessThanOrEqual(200);
    });

    it("drops non-positive quantities rather than offering to buy nothing", () => {
        store.setItem(
            CHECKOUT_DRAFT_STORAGE_KEY,
            JSON.stringify({
                eventId: "evt_bandung",
                items: [
                    { ticketTypeId: "tt_zero", quantity: 0 },
                    { ticketTypeId: "tt_negative", quantity: -3 },
                    { ticketTypeId: "tt_nan", quantity: Number.NaN },
                    { ticketTypeId: "tt_infinite", quantity: Number.POSITIVE_INFINITY },
                    { ticketTypeId: "tt_ok", quantity: 2 },
                ],
                savedAt: Date.now(),
            })
        );

        expect(consumeCheckoutDraft("evt_bandung")?.items).toEqual([
            { ticketTypeId: "tt_ok", quantity: 2 },
        ]);
    });

    it("is cleared outright on request", () => {
        saveCheckoutDraft(DRAFT_INPUT);
        clearCheckoutDraft();

        expect(store.getItem(CHECKOUT_DRAFT_STORAGE_KEY)).toBeNull();
    });
});

describe("E2. the restore re-validates the selection against the catalog it rendered", () => {
    function type(overrides: Partial<RestorableTicketType>): RestorableTicketType {
        return {
            id: "tt_1",
            minPerOrder: 1,
            maxPerOrder: 4,
            salesState: "OPEN",
            isSoldOut: false,
            ...overrides,
        };
    }

    it("clamps a quantity that exceeds the tier's CURRENT per-order maximum", () => {
        expect(
            restoreDraftQuantities([{ ticketTypeId: "tt_1", quantity: 9 }], [type({})], 10)
        ).toEqual({ tt_1: 4 });
    });

    it("uses the UI fallback ceiling when the tier declares no maximum", () => {
        expect(
            restoreDraftQuantities(
                [{ ticketTypeId: "tt_1", quantity: 50 }],
                [type({ maxPerOrder: null })],
                10
            )
        ).toEqual({ tt_1: 10 });
    });

    it("drops a tier that is no longer on sale, sold out, or gone from the event", () => {
        const ticketTypes = [
            type({ id: "tt_open", salesState: "OPEN" }),
            type({ id: "tt_closed", salesState: "CLOSED" }),
            type({ id: "tt_soon", salesState: "NOT_STARTED" }),
            type({ id: "tt_sold_out", isSoldOut: true }),
        ];

        const restored = restoreDraftQuantities(
            [
                { ticketTypeId: "tt_open", quantity: 2 },
                { ticketTypeId: "tt_closed", quantity: 2 },
                { ticketTypeId: "tt_soon", quantity: 2 },
                { ticketTypeId: "tt_sold_out", quantity: 2 },
                { ticketTypeId: "tt_removed", quantity: 2 },
            ],
            ticketTypes,
            10
        );

        expect(restored).toEqual({ tt_open: 2 });
    });

    it("returns nothing at all when no selection survives", () => {
        expect(
            restoreDraftQuantities(
                [{ ticketTypeId: "tt_gone", quantity: 2 }],
                [type({ id: "tt_other" })],
                10
            )
        ).toEqual({});
    });

    it("never raises a saved quantity to a tier's minimum — that would change what was chosen", () => {
        const restored = restoreDraftQuantities(
            [{ ticketTypeId: "tt_1", quantity: 1 }],
            [type({ minPerOrder: 3 })],
            10
        );

        expect(restored).toEqual({ tt_1: 1 });
    });
});

/* ==================================================================================
 * F. SECURITY — no open redirect, no client-side authority
 * ================================================================================== */

describe("F. the draft is a form prefill and cannot influence what is charged", () => {
    it("the callback cannot become an arbitrary external redirect", () => {
        for (const hostile of [
            "https://evil.example/steal",
            "//evil.example",
            "http://evil.example",
            "/\\evil.example",
            "javascript:alert(1)",
            "/login",
            "/register",
        ]) {
            expect(resolveSafeCallbackUrl(hostile)).toBeNull();
            expect(postLoginDestination(hostile)).not.toContain("evil.example");
            expect(postLoginDestination(hostile)).not.toContain("javascript:");
        }
    });

    it("an accepted callback is always a path on this origin", () => {
        const accepted = postLoginDestination("/e/liga-basket-bandung?pic=abc");

        expect(accepted.startsWith("/")).toBe(true);
        expect(accepted).not.toContain("://");
    });

    it("the stored record cannot even EXPRESS a price or an availability figure", () => {
        // Nothing is stored under those names, so there is no field for a tampered client to
        // carry one in — and the server's recomputation is what prices the order regardless.
        // Cast rather than typed: the point is that an extra key is DROPPED, which the type system
        // would refuse to express at all.
        const record = saveCheckoutDraft({
            ...DRAFT_INPUT,
            price: 1,
            total: 1,
            quota: 999,
        } as unknown as Parameters<typeof saveCheckoutDraft>[0]);

        expect(record).not.toBeNull();

        const stored = JSON.parse(store.getItem(CHECKOUT_DRAFT_STORAGE_KEY)!);

        for (const banned of ["price", "total", "subtotal", "quota", "remaining", "isSoldOut"]) {
            expect(Object.keys(stored)).not.toContain(banned);
        }
    });

    it("the checkout schema still strips money and availability from the request", () => {
        // The REAL schema the route parses with. A restored (or tampered) draft changes the form's
        // starting values at most; the body is still these five fields, and anything else is gone
        // before the pricing code sees it.
        const parsed = checkoutRequestSchema.parse({
            ...DRAFT_INPUT,
            price: 1,
            total: 1,
            subtotal: 1,
            quota: 999,
            organizerId: "org_attacker",
            userId: "user_attacker",
        } as unknown);

        expect(Object.keys(parsed).sort()).toEqual([
            "buyerEmail",
            "buyerName",
            "buyerPhone",
            "eventId",
            "items",
            "shareToken",
        ]);
        expect(parsed).not.toHaveProperty("price");
        expect(parsed).not.toHaveProperty("total");
        expect(parsed).not.toHaveProperty("quota");
    });

    it("keeps no password, token or auth state in the record", () => {
        saveCheckoutDraft({
            ...DRAFT_INPUT,
            password: "hunter2",
            accessToken: "jwt",
        } as unknown as Parameters<typeof saveCheckoutDraft>[0]);

        const serialized = store.getItem(CHECKOUT_DRAFT_STORAGE_KEY)!;

        expect(serialized).not.toContain("hunter2");
        expect(serialized).not.toContain("jwt");
        expect(serialized).not.toContain("password");
    });

    it("uses tab-scoped session storage, never localStorage or a cookie", () => {
        const code = readCode(DRAFT_MODULE);

        expect(code).toContain("sessionStorage");
        expect(code).not.toContain("localStorage");
        expect(code).not.toContain("document.cookie");
    });

    it("pulls in nothing server-only, so it stays a client-safe module", () => {
        const code = readCode(DRAFT_MODULE);

        for (const forbidden of [
            'from "@/auth"',
            "@/lib/prisma",
            "next/server",
            "@/lib/authz",
            "@/lib/events/catalog",
            "@prisma/client",
        ]) {
            expect(code).not.toContain(forbidden);
        }
    });
});

/* ==================================================================================
 * G. EXISTING CHECKOUT — untouched
 * ================================================================================== */

describe("G. the existing checkout contract is not disturbed", () => {
    it("the checkout route is still session-protected by the proxy", () => {
        const proxy = read("proxy.ts");

        expect(proxy).toMatch(/PROTECTED_API_PREFIXES[\s\S]*"\/api\/ticketing\/"/);
    });

    it("the request body is still exactly the five fields it always was", () => {
        const code = readCode(FORM);

        const bodyAt = code.indexOf("body: JSON.stringify({");
        const body = code.slice(bodyAt, code.indexOf("});", bodyAt));

        expect(bodyAt).toBeGreaterThan(-1);

        for (const field of [
            "eventId",
            "items",
            "buyerName",
            "buyerEmail",
            "buyerPhone",
            "shareToken",
        ]) {
            expect(body).toContain(field);
        }

        // The draft is never part of the request: it is a form prefill, not a payload.
        expect(body).not.toContain("draft");
        expect(body).not.toContain("savedAt");
    });

    it("the idempotency contract is unchanged — one key per intent, and a change mints a new one", () => {
        const code = readCode(FORM);

        expect(code.match(/createRequestKey\(\)/g)).toHaveLength(1);
        expect(code).toContain("pendingIntent.current.signature !== signature");
        expect(code).toContain('"Idempotency-Key": pendingIntent.current.key');
    });

    it("no server-side pricing, availability or auth rule was touched", () => {
        // This feature is presentation state only. Asserted against the files the brief forbids
        // changing: the checkout service and the payment surface are not on the diff at all.
        const service = read("lib/ticketing/checkout.ts");

        // The price is still read from the ticket-type ROW and recomputed server-side.
        expect(service).toContain("new Prisma.Decimal(type.price)");
        expect(service).not.toContain("checkout-draft");
        expect(service).not.toContain("sessionStorage");
    });
});

/* ==================================================================================
 * H. THE SERVER PASS STILL RENDERS THE PLAIN FORM (and hydrates cleanly)
 * ================================================================================== */

describe("H. the first render is the server's, so the draft cannot desynchronise hydration", () => {
    const TICKETS = [
        {
            id: "tt_tribun",
            name: "Tribun Utara",
            description: null,
            price: 75_000,
            currency: "IDR",
            minPerOrder: 1,
            maxPerOrder: 4,
            salesState: "OPEN" as const,
            isSoldOut: false,
            remaining: null,
        },
    ];

    function renderForm(defaultBuyer?: { name?: string | null; email?: string | null }) {
        return renderToStaticMarkup(
            createElement(TicketPurchaseForm, {
                eventId: "evt_bandung",
                ticketTypes: TICKETS,
                isAvailable: true,
                shareToken: null,
                defaultBuyer,
            })
        );
    }

    it("renders the empty form even when a draft is sitting in storage", () => {
        saveCheckoutDraft(DRAFT_INPUT);

        const html = renderForm();

        expect(html).toContain('id="buyer-name"');
        expect(html).not.toContain("Budi");
        expect(html).not.toContain("budi@example.com");
        // The restored-value notice is a CLIENT fact; the server snapshot cannot know it.
        expect(html).not.toContain("dipulihkan setelah login");
    });

    it("does not consume the draft during a server render", () => {
        saveCheckoutDraft(DRAFT_INPUT);

        renderForm();

        expect(store.getItem(CHECKOUT_DRAFT_STORAGE_KEY)).not.toBeNull();
        expect(readCheckoutDraft("evt_bandung")).not.toBeNull();
    });

    it("still prefills a signed-in buyer from the account, as it always did", () => {
        const html = renderForm({ name: "Akun Pembeli", email: "akun@example.com" });

        expect(html).toContain('value="Akun Pembeli"');
        expect(html).toContain('value="akun@example.com"');
    });
});

/* ==================================================================================
 * I. PHASE B — THE PURCHASE CARD'S DISABLED STATE AND THE UNTOUCHED FORM
 * ==================================================================================
 *
 * The detail page combines `event.isAvailable` with the catalog's `hasEnded` verdict and hands
 * the result to this form. So these two tests are the CTA half of the phase: `isAvailable: false`
 * is what a passed event renders, and it must be a REFUSAL rather than a form the buyer can press
 * (D). `isAvailable: true` must stay exactly the form it always was (N).
 */

describe("I. a passed event renders a refusal instead of a purchase form", () => {
    const TICKETS = [
        {
            id: "tt_tribun",
            name: "Tribun Utara",
            description: null,
            price: 75_000,
            currency: "IDR",
            minPerOrder: 1,
            maxPerOrder: 4,
            salesState: "OPEN" as const,
            isSoldOut: false,
            remaining: null,
        },
    ];

    function render(props: { isAvailable: boolean; salesState?: "OPEN" | "CLOSED" }) {
        return renderToStaticMarkup(
            createElement(TicketPurchaseForm, {
                eventId: "evt_bandung",
                ticketTypes: TICKETS.map((ticket) => ({
                    ...ticket,
                    salesState: props.salesState ?? ticket.salesState,
                })),
                isAvailable: props.isAvailable,
                shareToken: null,
            })
        );
    }

    it("D. shows the unavailable notice and offers no submit button", () => {
        const html = render({ isAvailable: false });

        expect(html).toContain("Pembelian tiket tidak tersedia untuk event ini.");
        expect(html).not.toContain('type="submit"');
        expect(html).not.toContain("Pesan tiket");
    });

    it("D. does not render the buyer fields or quantity steppers either", () => {
        const html = render({ isAvailable: false });

        expect(html).not.toContain('id="buyer-name"');
        expect(html).not.toContain('id="qty-tt_tribun"');
    });

    it("the disabled CTA is the same refusal this form has always shown for a DRAFT/CANCELLED event", () => {
        // Presentation only: Phase B reuses the existing D-14 refusal rather than inventing a
        // second unavailable state.
        expect(render({ isAvailable: false })).toContain(
            "Pembelian tiket tidak tersedia untuk event ini."
        );
    });

    it("N. an available event still renders the working form — submit button, steppers, fields", () => {
        const html = render({ isAvailable: true });

        expect(html).toContain('type="submit"');
        expect(html).toContain("Pesan tiket");
        expect(html).toContain('id="qty-tt_tribun"');
        expect(html).toContain('id="buyer-name"');
        expect(html).toContain('id="buyer-email"');
        expect(html).toContain('id="buyer-phone"');
        expect(html).not.toContain("Pembelian tiket tidak tersedia");
    });

    it("N. the submit button is disabled when nothing can be bought, without removing the form", () => {
        // A CLOSED tier (the default sales window, i.e. an event past its start with no explicit
        // `salesEndAt`) still renders the tier list, but the action is dead.
        const html = render({ isAvailable: true, salesState: "CLOSED" });

        expect(html).toContain("Penjualan ditutup");
        expect(html).toContain('type="submit"');
        expect(html).toMatch(/disabled/);
    });
});
