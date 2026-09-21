# PHASE 21B — ORPHAN / GHOST EVENTS (PUBLIC CATALOG vs DASHBOARD)

**Project:** TinggalKlik.Co
**Type:** Audit → root-cause fix → targeted cleanup → verification
**Date:** 2026-09-19
**Status:** Fixed and verified. No commit, no push, no git reset, no DB reset, no destructive migration, no truncation.

---

## 1. Executive summary

The events the user saw on the public landing were **integration-test fixtures** (`P6 …` / `P7 …`)
that leaked into the shared database and were served by the public catalog. They were invisible in
the dashboard because the dashboard scopes by tenant membership and **no real user belongs to those
fixture tenants** — so the dashboard was correct, and the fixtures were the defect.

Root cause: fixture events are created with the schema-default `visibility: PUBLIC` and published
through the **real** `publishEvent`; a test that aborts before its inline cleanup strands them, and
`PUBLISHED + PUBLIC` is exactly what the catalog serves. The same defect leaked fixture **sports**
onto the landing's sport grid.

Fixed at four levels:

1. **Fixture events are now `UNLISTED`** — a stranded fixture can never be *listed* publicly, even on
   an aborted run.
2. **A Jest global teardown** archives any stranded fixture event and deactivates any stranded
   fixture sport after every run — the safety net for the case cleanup cannot cover.
3. **Targeted data cleanup** of the existing leaks: 12 verified-empty fixtures deleted, 8 with
   financial rows archived (nothing destroyed).
4. **A regression guard** that pins all of the above.

---

## 2. Audit — every event in the database, classified

`21` events existed. Every one except `testing` belonged to a `P6` / `P7` fixture tenant (organizer
slug `p6-org-*` / `p7-org-*`, owner e-mail `*@example.test`). Columns: status · visibility ·
publicly listed by the catalog · financial dependencies.

| Event | Status | Listed? | orders / payments / tickets / refunds | Classification |
|---|---|---|---|---|
| `testing` | ARCHIVED | no | 1 / 0 / 0 / 0 | **A — legitimate** (organizer `tinggalklik`, owner `reksa@gmail.com` ADMIN) |
| `p6-capped-at-p6-1789793768238-k251y0` | PUBLISHED | **YES** | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p6-capped-at-p6-1789793782575-b1ahtw` | PUBLISHED | **YES** | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p6-capped-at-p6-1789793812844-0259oz` | PUBLISHED | **YES** | 1 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p6-capped-at-p6-1789793825620-lfph77` | PUBLISHED | **YES** | 1 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789813929086-wh1g8r` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789813929086-wh1g8r` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789813931667-80bgsr` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789813931667-80bgsr` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789832860584-777wjr` | PUBLISHED | **YES** | 1 / 1 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789832860584-777wjr` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789832894322-4fbheh` | PUBLISHED | **YES** | 1 / 1 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789832894322-4fbheh` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789832910448-kz5kdm` | PUBLISHED | **YES** | 2 / 2 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789832910448-kz5kdm` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789834486921-8n6ntu` | PUBLISHED | **YES** | 1 / 1 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789834486921-8n6ntu` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789834644628-zp2cmd` | PUBLISHED | **YES** | 1 / 1 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789834644628-zp2cmd` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-a-p7-1789835188189-3n59yz` | PUBLISHED | **YES** | 1 / 1 / 0 / 0 | **B — orphan/fixture** |
| `p7-event-b-p7-1789835188189-3n59yz` | DRAFT | no | 0 / 0 / 0 / 0 | **B — orphan/fixture** |

A **second** leak surfaced during verification: `20` **sports** existed, `10` of them fixture sports
(`p6-sport-*`, `p7-sport-*`) shown on the landing's sport grid with `isActive: true`.

### Events that appeared publicly but not in the dashboard

All `PUBLISHED + PUBLIC` fixture events. They are invisible in the dashboard because
`listOrganizerEvents` scopes to `readableOrganizerIds` (real memberships) and no real user is a
member of a fixture tenant — **corrent tenant isolation, not a dashboard bug.**

---

## 3. Root cause

1. `createEvent` defaults `visibility` to the schema default **`PUBLIC`**; the ticketing harnesses
   pass no `visibility`.
2. The harnesses call the **real** `publishEvent` (that is the point of those suites), producing
   `PUBLISHED + PUBLIC + archivedAt null`.
3. `publicVisibilityWhere` serves exactly that shape to anonymous visitors.
4. The suites clean up **inline**, inside test bodies. This repository's ticketing integration suites
   **fail in a plain environment** (leftover settlement rows, `expected SETTLED, got DUPLICATE`), so
   tests abort mid-body and their fixtures are **stranded**.
5. The `p6-capped-at-*` events come from the last `maxTicketsPerOrder` test: it creates, publishes,
   buys, and cleans up at the end — so an abort before the cleanup leaves a published event **plus its
   order**. Because that stranded order still references the suite's sport, the suite's `afterAll`
   `sport.deleteMany` then fails on the FK, which is why the fixture **sports** leaked too.
6. A stranded event is therefore `PUBLISHED + PUBLIC` → public; and no real user can see it →
   a ghost.

`app/page.tsx` was already `force-dynamic`, so a rebuild was not the issue — the data was.

---

## 4. Fixes (root cause)

### 4.1 Fixtures are UNLISTED (events)
Every `createEvent` in the fixture harnesses now passes `visibility: "UNLISTED"` (via a documented
`FIXTURE_VISIBILITY` constant):

- `__tests__/ticketing-checkout/checkout.integration.test.ts` (6 calls)
- `__tests__/ticketing-checkout/checkout-concurrency.integration.test.ts` (1 call)
- `__tests__/ticketing-payment/payment-harness.ts` (2 calls)

`UNLISTED` is the designed "not listed, still sellable" state: publish, checkout, payment,
settlement, webhook and check-in behaviour are all unchanged (`isEventPurchasable` only excludes
`PRIVATE`), while the catalog (which requires `visibility: "PUBLIC"`) ignores it. So a fixture that a
failed test strands is **invisible on every public listing even if its cleanup never runs**.

### 4.2 Global teardown safety net (events **and** sports)
Because sports have no "unlisted" flag, the systemic net is a Jest `globalTeardown`
(`__tests__/support/fixture-teardown.ts`, registered in `jest.config.js`). After every run it:

- **archives** any non-archived event of a verified fixture tenant (`status: ARCHIVED` + `archivedAt`)
  — never deletes, so stranded orders/payments keep their rows; and
- **deactivates** any fixture-prefixed sport (`isActive: false`, the documented retirement path).

Identification is deliberately narrow — a reserved slug prefix **and** owner e-mail on the reserved
`@example.test` domain for organizers, plus the reserved sport prefixes — so it cannot touch a real
tenant, a real sport, or a financial row. Failures are swallowed so cleanup can never fail a run.

### 4.3 Existing data cleanup (targeted, by verified ID)
- **Deleted — 12 fixtures verified empty** (0 orders, payments, tickets, refunds, check-ins, PIC
  attributions, fee entries):
  `p6-capped-at-p6-1789793768238-k251y0`, `p6-capped-at-p6-1789793782575-b1ahtw`,
  `p7-event-a/b-p7-1789813929086-wh1g8r`, `p7-event-a/b-p7-1789813931667-80bgsr`,
  `p7-event-b-p7-1789832860584-777wjr`, `…-1789832894322-4fbheh`, `…-1789832910448-kz5kdm`,
  `…-1789834486921-8n6ntu`, `…-1789834644628-zp2cmd`, `…-1789835188189-3n59yz`
  (IDs recorded in the run log; children `ticketType` / `ticketReservation` removed first).
- **Archived — 8 fixtures with orders/payments** (preserved, hidden):
  `p6-capped-at-p6-1789793812844-0259oz`, `p6-capped-at-p6-1789793825620-lfph77`,
  `p7-event-a-p7-1789832860584-777wjr`, `…-1789832894322-4fbheh`, `…-1789832910448-kz5kdm`,
  `…-1789834486921-8n6ntu`, `…-1789834644628-zp2cmd`, `…-1789835188189-3n59yz`
  (written exactly as `archiveEvent` writes: `status: "ARCHIVED"`, `archivedAt`; `publishedAt` left
  alone).
- **Deactivated — 10 fixture sports** (`p6-sport-*`, `p7-sport-*`).
- **Retained — `testing`** (the one legitimate event), untouched.

### 4.4 Regression guard
`__tests__/events/fixture-isolation.test.ts` (9 tests) pins: every fixture event is `UNLISTED`; no
fixture hardcodes `PUBLIC`; the catalog still requires `visibility: "PUBLIC"` + `archivedAt: null`;
the landing/`/events`/API share one catalog; the `globalTeardown` is registered and archives rather
than deletes, touching only reserved fixture identifiers.

---

## 5. Verification

| Check | Result |
|---|---|
| `GET /api/events?limit=50` (live, production build) | `{"items":[],"pagination":{"total":0}}` |
| Landing `/` — any `P6`/`P7` event or sport | **none** |
| `/events` — any `P6`/`P7` event | **none** |
| Real sports still rendered | `Badminton`, `Basketball`, `Futsal`, `Volleyball`, `Tennis` |
| DB after cleanup | `0` publicly-listable events, `0` active fixture sports, `testing` intact |
| DB **after a full `npx jest` run** | `13` events total (new fixtures created by the run), **`0` publicly-listable**, **`0` active fixture sports** — the teardown neutralised them automatically |

### Tests

| Run | Result |
|---|---|
| `__tests__/events` + `__tests__/authz` + `publish-integration` | **16 suites, 323 passed** |
| `__tests__/ticketing-checkout` (with changes) | 2 suites failed / `7` tests — same suites as baseline |
| `__tests__/ticketing-checkout` (stashed baseline, no changes) | 2 suites failed / `8` tests — **no regression** |
| Full `npx jest` | **51 passed / 14 failed suites (65)**; `1302` passed / `95` failed tests |
| Failing suite list | identical to the pre-existing 14 (`security/*` headers, ticketing integration fixtures). **No new failures.** |

### Toolchain

- `npx tsc --noEmit` → **clean**
- `npm run build` → **success** (Next.js 16.3.0)
- `npx eslint` on all changed files → **clean**

---

## 6. Files changed

| File | Change |
|---|---|
| `__tests__/ticketing-checkout/checkout.integration.test.ts` | Fixtures `UNLISTED` (`FIXTURE_VISIBILITY`) |
| `__tests__/ticketing-checkout/checkout-concurrency.integration.test.ts` | Fixture `UNLISTED` |
| `__tests__/ticketing-payment/payment-harness.ts` | Fixture events `UNLISTED` |
| `jest.config.js` | Registered `globalTeardown` |
| `__tests__/support/fixture-teardown.ts` | **New** — archive stranded fixture events, deactivate fixture sports |
| `__tests__/events/fixture-isolation.test.ts` | **New** — regression guard |

## 7. Files intentionally not changed

- `lib/events/catalog.ts` — the visibility contract is correct and already tested.
- `lib/events/service.ts` — `listOrganizerEvents` tenant scoping is correct; `createEvent` /
  `publishEvent` / `archiveEvent` semantics untouched.
- `lib/sports/service.ts` — `listPublicSports` correctly excludes inactive sports.
- `app/page.tsx`, `app/events/page.tsx`, `app/api/events/route.ts` — already one source of truth.
- Prisma schema, migrations, payment/refund/ticket/check-in/QR/scheduler code.

## 8. Remaining known gaps

- **INFO-1:** The 8 archived fixture events and their fixture organizers/users remain in the database
  (by design — deleting them would destroy stranded order/payment rows). They are ARCHIVED and on no
  public surface.
- **INFO-2:** The fixture **organizers** and `@example.test` users are left in place; they are not
  publicly visible. A future "purge test tenants" task can remove them once their financial rows are
  reconciled.
- **INFO-3:** The true long-term fix is running integration suites against an isolated database; the
  teardown is the safety net within the current shared-database setup.
- **INFO-4:** The 14 pre-existing failing suites (security header config, ticketing integration
  fixtures) are unchanged and out of scope for this task.

## 9. Explicit confirmation

- ✅ No database reset, no `migrate reset` / `db push`, no truncation, no full-table delete.
- ✅ Deletions were **targeted by verified ID**, only for events with zero financial dependencies.
- ✅ Every event with a transaction was **preserved** (archived, not deleted).
- ✅ No legitimate event was deleted — `testing` is intact.
- ✅ No business contract changed (Phase 20B/21 preserved); no phase file modified.
- ✅ No commit, no push, no `git reset` / `git clean` / `git checkout -- .`. (A `git stash`/`pop`
  pair was used only to establish the pre-existing-failure baseline and was fully restored.)
