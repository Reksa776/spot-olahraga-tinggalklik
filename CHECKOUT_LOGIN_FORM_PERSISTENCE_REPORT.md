# CHECKOUT LOGIN FORM PERSISTENCE — REPORT

**Flow:** guest fills the purchase form on `/e/{slug}` → "Pesan tiket" → login → return to the same
event with the form still filled.

**Scope of the change:** 1 file modified, 2 source files added (plus this report). No migration, no
schema change, no new dependency, no change to any server-side pricing/availability/auth rule.

---

## 1. Audit (before coding)

| Question | Finding |
| --- | --- |
| Event detail route/page | `app/e/[slug]/page.tsx` (`dynamic = "force-dynamic"`), renders the sidebar card `#beli` |
| Checkout / purchase form | `components/events/TicketPurchaseForm.tsx` (client component) |
| "Pesan Tiket" handler | `submit()` in that form → `POST /api/ticketing/checkout` with an `Idempotency-Key` |
| Login redirect mechanism | the proxy answers `401` (`code: UNAUTHORIZED`) for `/api/ticketing/**`; the form's `isSessionExpired(response.status, payload)` branch calls `redirectToLoginForExpiredSession()` (`lib/auth/client-session.ts`) → `window.location.assign("/login?callbackUrl=<path>")` |
| Existing `callbackUrl`/`returnUrl` | `callbackUrl` is the only live key. `lib/auth/redirect.ts` (`loginUrlFor`, `postLoginDestination`, `resolveSafeCallbackUrl`) builds and validates it; `app/login/page.tsx` + `components/auth/LoginForm.tsx` read it; `proxy.ts` writes it. `?next=` is dead and documented as ignored. |
| How form state is held today | plain React `useState` inside the client component — destroyed by the full document load to `/login` |
| Existing draft/cart/session mechanism | none. No `sessionStorage`/`localStorage` in application source; the only "dirty form" logic is `lib/realtime/dirty-state.ts`, which defers auto-refresh while editing (unrelated). Nothing to reuse for persistence. |
| Existing hydration-safe client-value pattern | `lib/ui/browser-value.ts` (`useSyncExternalStore`, server snapshot for the first pass) — used because the project's ESLint treats `setState` inside an effect as an error |

**Root cause of the reported problem:** nothing was wrong with the *redirect* — the return path
already worked. The loss was purely client-side state: `/login` is a separate document, and the
purchase form lived only in React state, so every field the buyer had typed was discarded. The
project had no place to put it.

---

## 2. Flow — before

```
guest on /e/{slug}
  → fills nama / email / noHp / jumlah
  → "Pesan tiket"  → POST /api/ticketing/checkout
      → proxy: no session → 401 { code: "UNAUTHORIZED" }
  → isSessionExpired(...) → window.location.assign(/login?callbackUrl=%2Fe%2F{slug})
  → sign in → router.replace("/e/{slug}")        ← return path was already correct
  → form is EMPTY                                ← the bug
```

## 3. Flow — after

```
guest on /e/{slug}
  → fills nama / email / noHp / jumlah
  → "Pesan tiket" → POST → 401
  → saveCheckoutDraft({ eventId, items, buyerName, buyerEmail, buyerPhone, shareToken })
      → sessionStorage["tinggalklik.checkout-draft.v1"]   (same tab, 30 min TTL)
  → redirect /login?callbackUrl=%2Fe%2F{slug}
  → sign in
  → back on /e/{slug}  (callbackUrl wins; NEVER /dashboard for this flow)
  → readCheckoutDraft(eventId)  → re-validate against the catalog this render got
      → contact fields + quantities restored, "Data pembelian Anda dipulihkan…" notice
  → consumeCheckoutDraft(eventId)  → storage entry removed
  → buyer presses "Pesan tiket" again → existing checkout proceeds unchanged
```

**Authenticated buyer** (never interrupted): the page is public and personalises the form from the
session (`defaultBuyer`); no redirect to `/login` and no redirect to `/dashboard` happens. If such a
buyer *does* reach `/login?callbackUrl=/e/{slug}` (second tab, reload during sign-in), the server
gate (`decideSessionGate`) and the form (`postLoginDestination`) both return them to the event.
After "Pesan tiket" a signed-in buyer continues to `/ticketing/orders/{orderNumber}` — the existing
post-order destination, unchanged.

## 4. Files changed

| File | Change |
| --- | --- |
| `lib/ticketing/checkout-draft.ts` | **new** — the whole persistence mechanism: save / read / consume / clear, normalisation, TTL, event binding, and `restoreDraftQuantities` re-validation. Pure, no I/O beyond `sessionStorage`, no Prisma, no `@/auth`. |
| `components/events/TicketPurchaseForm.tsx` | **modified** — writes the draft in the existing `401` branch immediately before `redirectToLoginForExpiredSession()`; reads it through `useBrowserValue`; consumes it in a state-free effect; derives the form values (restored underneath the buyer's own edits). Presentation of the request payload, the idempotency model and the navigation on success are untouched. |
| `__tests__/ticketing-checkout/checkout-draft.test.ts` | **new** — 57 tests (sections A–H). |

## 5. Storage mechanism

* **Where:** `sessionStorage`, key `tinggalklik.checkout-draft.v1`.
  *Tab-scoped* (the interruption is a trip in the same tab), *transient* (a `savedAt` stamp + a
  30-minute TTL), and *client-only* — nothing about it is ever sent to the server. A cookie would
  put it on every request; `localStorage` would leak it across tabs and browser sessions.
* **What:** `eventId`, `items[{ticketTypeId, quantity}]`, `buyerName`, `buyerEmail`, `buyerPhone`,
  `shareToken`, `savedAt`. Exactly the fields a restore needs — no password, no session/auth token,
  no payment credential, and **no price, subtotal, total, availability or quota**. An extra key
  passed by a tampered client is dropped by the normaliser (asserted).
* **Event binding:** the record names its `eventId`; `readCheckoutDraft`/`consumeCheckoutDraft`
  refuse any other event, and `consumeCheckoutDraft` removes **only** a record for the event being
  opened — another event's in-flight draft is left alone.
* **One key, not one per event:** a purchase intent is singular; a new save replaces the old one, so
  no trail of abandoned personal data accumulates in the tab.
* **Consume-on-restore:** the draft is read for render and removed by an effect. A refresh, a back
  navigation, a React remount or a client-side navigation to another event therefore cannot re-apply
  it, and a duplicate submit is impossible.
* **Invalid/stale state never throws:** a corrupt entry, a non-object, a wrong-shaped item, a missing
  timestamp, an entry past its TTL, or a `sessionStorage` that throws on access all resolve to
  `null` → the normal empty/default form. Every read is length-capped.
* **Re-validation on restore:** only tiers the current catalog still sells and that are `OPEN` and
  not sold out survive; quantities are clamped to the tier's **current** `maxPerOrder`; a saved
  quantity is never raised to a tier's `minPerOrder` (the form's own submit check says so instead,
  so the buyer is not silently charged for more than they chose).

## 6. Security considerations

* **Open redirect:** unchanged and re-asserted — the return path is produced by
  `loginUrlFor` / `resolveSafeCallbackUrl`, which accept a same-origin **path** only and reject
  absolute URLs, protocol-relative URLs, backslashes, control characters and `/login`/`/register`
  (loop). `callbackUrl` from a query parameter is never navigated to unsanitised. New tests cover
  `https://evil.example`, `//evil.example`, `javascript:`, `/\evil.example`, `/login`, `/register`.
* **No client-side authority:** prices, totals and availability are still recomputed server-side
  from `TicketType.price` in the database (`lib/ticketing/checkout.ts` still does
  `new Prisma.Decimal(type.price)`), the checkout schema still strips `price`/`total`/`subtotal`/
  `quota`/`organizerId`/`userId` from the body, and `/api/ticketing/**` is still session-protected by
  the proxy plus `requireAuth()`. All three are asserted in the new suite.
* **No auth bypass, no new endpoint, no DB change:** the draft is a form prefill. It cannot create,
  reserve, price, pay for or own anything.
* **Data minimisation:** only the buyer's own contact fields + selection are stored; a saved record
  cannot even express a money or availability field.

## 7. Tests

* **New suite:** `__tests__/ticketing-checkout/checkout-draft.test.ts` — **57 tests, all passing**,
  organised as the brief asked:
  * **A** guest checkout: the record is stored under one key with exactly the expected fields; the
    `401` branch saves **before** it redirects; a storage that throws is a silent no-op.
  * **B** login restoration: return path `/e/{slug}` (not `/dashboard`); name/email/phone and
    quantities restored; the draft is consumed on restore; the form reads it through
    `useBrowserValue` and writes it back for the current catalog.
  * **C** event isolation: Event A's draft is refused for Event B **and left intact**; a second
    event's save replaces the first; a foreign tier id yields no quantity.
  * **D** logged-in flow: `decideSessionGate` returns the event path for CUSTOMER/ADMIN and only an
    absent callback falls back to a role default; the form contains no `/dashboard`.
  * **E** invalid/stale state: TTL, future timestamps, corrupt JSON, scalars, arrays, missing
    `eventId`/`savedAt`/items, non-finite and non-positive quantities, oversized payloads — `null`,
    never a throw. Plus re-validation: clamping, dropped closed/sold-out/removed tiers, no raising to
    a minimum.
  * **F** security: hostile callbacks, a stored record that cannot express money/availability, the
    real `checkoutRequestSchema` stripping a tampered body, no password/token in storage,
    `sessionStorage` (never `localStorage`/cookie), client-safe imports.
  * **G** existing checkout: `/api/ticketing/` still proxy-protected; the request body is still the
    same five/six fields and never carries the draft; the idempotency contract is unchanged
    (`createRequestKey()` called exactly once); no server pricing/availability file touched.
  * **H** server render: the first pass renders the **plain empty** form even while a draft sits in
    storage (so hydration cannot differ), does not consume the draft, and still prefills from the
    signed-in account exactly as before.
* **Full suite — `npx jest --runInBand`:** **157 suites / 3417 tests passed, 0 failed**
  (117 s, serialised against the real test MySQL). No pre-existing suite needed changing.
* **Live browser verification (not part of the repo):** the flow was driven in headless Chrome over
  the DevTools Protocol against the production build on `:3000`, with a throwaway fixture event
  (`UNLISTED`, so never in the public catalog) created and then deleted. **17/17 checks passed:**
  guest 401 → `/login?callbackUrl=%2Fe%2F{slug}`; draft stored with exactly
  `buyerEmail,buyerName,buyerPhone,eventId,items,savedAt,shareToken`; after sign-in back on
  `/e/{slug}` (**not** `/dashboard`) with name `Budi`, `budi@example.com`, `08123456789` and
  quantity `2` restored; notice shown; storage entry gone; a reload did not resurrect it; and
  "Pesan tiket" again created the order (`/ticketing/orders/EVT-…`). The temporary driver script and
  its fixture script were deleted afterwards.

## 8. Validation commands

| Command | Result |
| --- | --- |
| `npx jest --runInBand` | ✅ exit 0 — 157 suites, 3417 tests passed |
| `npx tsc --noEmit --incremental false` | ✅ exit 0 — no output |
| `npm run lint` | ✅ exit 0 — **0 errors**, 4 pre-existing warnings, none in a touched file (`app/e/[slug]/page.tsx` ×2 `<img>`, `components/events/EventCard.tsx` `<img>`, `scripts/verify-phase33-live.js` unused var). The `react-hooks/set-state-in-effect` error raised by a first draft of this change was resolved properly — by using the project's existing `useBrowserValue` hook instead of `setState` inside an effect — not suppressed. |
| `npm run build` | ✅ exit 0 — all routes compiled, `/e/[slug]` and `/login` among them |

## 9. Git status / database

```
 M components/events/TicketPurchaseForm.tsx
?? CHECKOUT_LOGIN_FORM_PERSISTENCE_REPORT.md
?? __tests__/ticketing-checkout/checkout-draft.test.ts
?? lib/ticketing/checkout-draft.ts
```

* No commit, no push, no reset/rebase/stash. No unrelated file and no dependency changed.
* **No DB or schema change at all** — no migration added or run, `prisma/schema.prisma` untouched.
* The only database writes were the temporary browser-verification fixture and the buyer accounts the
  check registered through the real form; all of them (event, ticket type, organizer, sport, owner,
  orders/reservations, buyer accounts) were deleted afterwards with the temporary script, which was
  then removed. No user data or existing event was modified.

## 10. Known limitations

* The repo has no DOM test environment (`jsdom`/`@testing-library` are not installed), so the form's
  *client* render is not unit-testable here; that half was verified in the real browser instead (see
  §7) plus the server-render suite (H).
* The restore cannot recover a selection for a tier that closed, sold out or was removed while the
  buyer was signing in — by design; those lines are dropped and the buyer picks again, and the
  server would have refused them anyway.
