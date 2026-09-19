# Phase 9 — Ticketing Transaction Audit Final Report

## Verdict

**PASS (transaction flow correct and secure).** No real bugs found in the
end-to-end ticketing transaction flow during this audit. Residual items are open
design decisions and pre-existing lint debt, none of which affect transaction
correctness, money integrity, or authorization.

- TypeScript: `npx tsc --noEmit` — **0 errors**
- Tests: `npx jest --runInBand` — **45 suites / 1035 tests passed**
- Build: `npm run build` — **succeeds**
- Lint: `npm run lint` — 27 errors, **all pre-existing**, none in the ticketing
  transaction path (predominantly `@typescript-eslint/no-explicit-any` in
  `lib/payment/ipaymu.ts`, `no-require-imports` in Jest harnesses and
  `scripts/*.js`/`server.js`, and React-hooks purity recommendations in two
  components). Unchanged this session.

## Flow trace (verified code paths)

1. **AUTH** — `auth.ts`: JWT sessions; `TIMING_EQUALISATION_HASH` is a real
   cost-12 bcrypt hash (prior timing attack fixed). Scope resolved from DB by
   `lib/authz/scope.ts` (`resolveAuthzScope`), never from client input; ≤60 s
   staleness bound (D-48).
2. **DASHBOARD** — `lib/dashboard/*` re-use `decideOrganizerPermission` /
   `resolveOrganizerFilter`; no unscoped query; client `organizerId` is a
   refusal, not a wider filter.
3. **EVENT (management)** — `/api/organizer/events/**`, ticket-types, images,
   venues, PIC: `requireEventAccess`/`requireTicketTypeAccess` do a narrow
   ownership lookup FIRST then authorize (§29.5); body `organizerId` is data,
   never authority; strict schemas strip `sold/reserved/version/organizerId/status`.
4. **PUBLIC EVENT** — `/api/events`, `/api/events/[slug]`, `/share`:
   `publicVisibilityWhere` hard-coded (PUBLISHED + PUBLIC + not archived + not
   past); DRAFT/UNLISTED/ARCHIVED unreachable; quota/sold/reserved never
   exposed; `remaining = null` (D-15 open).
5. **TICKET SELECTION → CHECKOUT** — `/api/ticketing/checkout/route.ts` +
   `lib/ticketing/checkout.ts`: one `$transaction` (idempotency key row → order →
   per-line atomic quota CAS → reservation → `PENDING_PAYMENT`); Zod strips
   client price/total; quantity never coerced; money recomputed from DB; raw SQL
   CAS because Prisma can't compare column-to-column; reservation transitions
   conditional `updateMany`.
6. **PAYMENT** — `lib/ticketing/payment/`: amounts derived from persisted
   `EventOrder`; only whitelisted method/channel; `paymentReference` =
   `orderNumber`(attempt 1)/`#N`(attempt N) with `@unique` as the
   concurrency mechanism; void maps abandoned attempts to `EXPIRED`; gateway is
   the only seam to `lib/payment/**`; `requireSafeRupiah` blocks non-integer/
   unsafe amounts.
7. **IPAYMU** — `lib/payment/ipaymu.ts`: bodyHash=SHA256(rawBody), HMAC-SHA256
   over `POST:VA:{lowercase(bodyHash)}:{apiKey}`; sandbox/prod allow-listed base
   URLs; fail-closed config.
8. **WEBHOOK** — `/api/ticketing/payment/webhook/route.ts` + `lib/ticketing/
   payment/webhook.ts`: cert-pinning-style ordering — raw body → signature
   (fail-closed 401, header-or-body-field accepted, exactly one checked) →
   amount match (400) → INSERT `WebhookEvent` (unique violation = replay = 200
   no-op) → classify → settle → ledger → 200; `MAX_WEBHOOK_BODY_BYTES`; sole
   settlement trigger (§31.5 rule 3).
9. **SETTLEMENT** — `lib/ticketing/payment/settlement.ts`: ONE transaction, fixed
   order — CAS order PAID → CAS payment PAID + PaymentTransaction → per-item
   quota CAS (`reserved-=q, sold+=q`); `withContentionRetry`; no ticket/PIC/fee
   side effects (later phases).
10. **ORDER** — `/api/ticketing/orders/[orderNumber]` + `/pay` + `/cancel` +
    `/issue` + `lib/ticketing/orders.ts`/`tickets/*`: ownership predicate in
    `where` FIRST → 404 (no IDOR/existence oracle); money serialized as fixed
    2-decimal strings; issuance well-typed in `payload.ts`.
11. **TICKET** — `lib/ticketing/tickets/*`: issuance separate from settlement
    (at-least-once → exactly-once), idempotent via unique ticket code/QR token;
    QR token = 32 random bytes base64url, only SHA-256 persisted, raw shown
    once; wallet list omits QR; single-ticket endpoint is the only QR return
    point and is ownership-gated; no money/organizer/quota in ticket payloads.

## Security properties confirmed

- CSRF `requireSameOrigin` wired into EVERY state-changing route (D-56); retail
  routes deleted.
- Cross-tenant denial is 404 (`ORGANIZER_ACCESS_DENIED`), never 403.
- `ADMIN_GRANT_REQUIRED` — Admin holds no financial power by default; grants
  only unlock `ADMIN_GRANT_REQUIRED` permissions (no privilege-escalation
  primitive).
- `OrganizerMemberRole.ADMIN` deliberately unmapped (D-05); platform role maps
  fail closed.
- No money-handling route answers PATCH/DELETE/POST without origin check; GET is
  exempt by design (navigation).
- Audit log never records secrets; `adminId` = real actor; QR secrets never
  logged.
- Rate limiter reused for uploads, applied before body parse.

## Items this audit deliberately did NOT touch

- **D-15** — `remaining` exposure decision (still open; `null` returned).
- **D-16** — iPaymu `expired` unit (hours vs minutes); window uses
  `reservationTtlMinutes`, direction-safe under both candidates.
- **D-46** — QR as stable public reference vs short-lived token, recorded.
- **D-61** — decimal-string vs integer-rupiah money serialization (open).
- Refund (`refund.completed`) and PIC attribution/fee settlement = Phase 9 work.
- Lint debt (27 errors) predates this session; fixing it is unrelated to
  transaction correctness.

## Next steps

1. Answer D-61 (money representation) before any aggregation/export work.
2. Sandbox-verify iPaymu `expired` unit to close D-16.
3. Phase 9: refunds, PIC fee ledger, check-in scanning, attendance.