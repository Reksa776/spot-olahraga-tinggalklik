# 12 — SECURITY AUDIT

**Scope:** static review of access control, IDOR, injection, XSS, CSRF, uploads, secrets, webhooks, rate limiting and duplicate processing. No active penetration test, no destructive request, no production contact.

---

## 1. Summary

The application has a mature security foundation for a single-tenant-per-organizer ticketing product:

- authority is resolved from the session and database, never from request identity fields;
- every state-changing API route calls an Origin/Referer check;
- tenant denials are masked as 404;
- payment webhooks are HMAC-verified over raw bytes with a unique replay ledger;
- duplicate admission, issuance, refund and notification effects are backed by unique constraints/CAS;
- private financial files have authenticated read routes;
- CSP/HSTS/frame denial are configured globally.

The largest residual risks are **design-level**, not missing middleware: the public ticket code is the scan credential, live notification transport is disabled, and no private participant-document system exists.

---

## 2. Broken access control / IDOR

| Control | Finding |
|---|---|
| Session identity | `requireAuth()` reads the JWT; no body/query identity is trusted |
| Tenant scope | `requireOrganizerAccess` + event ownership lookup; cross-tenant = 404 |
| Own scope | `requireOwnResource` enforces `scope.userId === ownerUserId` |
| Event-scoped PIC | Active profile + active, non-revoked assignment for the exact event |
| PIC page | Server-side `requirePicScanAccess`; masked 404; no client authorization |
| Admin | Platform permissions + active membership for tenant operations |
| Route classification | Edge proxy authenticates; route-classification test prevents unclassified handlers |
| Direct object references | Event/order/ticket/refund/settlement ids are looked up then authorized |

**Finding:** no confirmed IDOR in the reviewed paths.

**Residual:** `requireAdminSession` still checks the legacy `User.role` for some legacy surfaces; it is not used by ticketing, but it is a second authority model that should be retired. (`lib/csrf.ts`)

---

## 3. Authentication weaknesses

| Area | Assessment |
|---|---|
| Password storage | bcrypt cost 12; unknown-user timing equalised with a real hash |
| User enumeration | Uniform login failure; distinct code only for rate-limit state |
| OAuth takeover | `allowDangerousEmailAccountLinking: false` |
| Session | JWT, `SameSite=Lax` cookie, `AUTH_SECRET` required |
| Disabled account | `disabledAt` nulls scope |
| Scope staleness | ≤60s after revocation (documented decision) |
| Brute force | per-client/per-account/platform throttles; in-memory per process |

**Risk:** the 60-second scope cache is a deliberate trade-off; a revoked staff/PIC may retain cached tenant capabilities for up to a minute. Assignment checks inside check-in are not cached, so scanning revocation is immediate.

---

## 4. SQL injection

- All reviewed data access uses Prisma Client parameterized queries.
- No user-controlled string concatenation into SQL was found in the reviewed payment/check-in/event/auth paths.
- Raw SQL, if present elsewhere, would need separate review; this audit did not exhaustively grep every query.

**Severity:** Low for reviewed paths.

---

## 5. XSS and browser security

`next.config.ts` sets globally:

- `Content-Security-Policy`: `default-src 'self'`, `script-src 'self' 'unsafe-inline'` (dev adds `'unsafe-eval'`), `img-src` only self/data/iPaymu, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`;
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: strict-origin-when-cross-origin`;
- HSTS outside development.

React escapes rendered values by default. `'unsafe-inline'` is required by the theme bootstrap/Next style injection and is a residual XSS weakening; no third-party scripts are allowed.

**Severity:** Low/Medium (inline script allowance is the main trade-off).

---

## 6. CSRF

`lib/csrf.ts`:

- `requireSameOrigin` rejects state-changing methods without a parseable `Origin`/`Referer` matching the request `Host`;
- fails closed when neither header is present;
- called by all current state-changing routes (the file's own adoption note says so; checked in the reviewed routes).
- Auth cookie is `SameSite=Lax`, which is the primary browser control.

**Residual:** non-browser clients with a stolen cookie are not stopped by SameSite; the Origin check raises the bar but is not a token. No double-submit anti-CSRF token exists.

**Severity:** Low.

---

## 7. File upload vulnerabilities

| Control | Status |
|---|---|
| Size limit | 5 MB, re-checked on bytes |
| MIME trust | Magic bytes, not client header |
| Filename | Server-generated random |
| Path traversal | `basename` check on read; no user path on write |
| Public/private split | Public images vs private proof/evidence trees |
| Metadata | EXIF stripped for images |
| Malware scan | **Not present** |
| Documents | **No document upload path** |

**Severity:** Medium for future documents; current image/proof paths are well controlled.

---

## 8. Sensitive data exposure

- No credential/secret is logged by the reviewed notification/webhook paths; webhook stores a redacted payload + SHA-256.
- Audit payloads exclude phone/email/name/QR token; check-in audit carries event/ticket/actor/outcome.
- PIC duplicate response nulls `firstCheckedInBy`.
- Public API returns catalog data, not buyer data.
- Private evidence routes require auth and tenant/own scope.
- `Event.documentationUrl` is public by design.

**Residual:** check-in response returns attendee name to an authorized scanner; acceptable for gate operation. `Payment` stores provider instrument data (VA/QR), not card data. No PAN/CVV storage exists.

---

## 9. Webhook security

`lib/ticketing/payment/webhook.ts`:

- HMAC signature over the **raw body** before parsing;
- amount verification against the order;
- unique `WebhookEvent.providerEventId` as replay arbiter;
- only `PROCESSED` blocks reprocessing; rejected rows do not let an attacker squat a real key;
- one forward-only mutation of the ledger row;
- no settlement from browser redirect;
- 401 for invalid signature, 400 for amount mismatch, 200 no-op for duplicate/unknown.

**Residual:** provider secret rotation and clock/URL configuration are deployment concerns; no real callback was exercised in this audit.

**Severity:** Low (design strong), with integration evidence missing.

---

## 10. Rate limiting and abuse

| Surface | Limiter |
|---|---|
| Login | per-client, per-account, platform-wide |
| Registration | 3/hour per client |
| Payment creation | present |
| Upload | present |
| PIC scan | 120/min per (user, event), fail-closed |

All are **in-memory and per process**. On a single VPS this is acceptable; on multiple instances it is bypassable and resets on restart. `REDIS_URL` is declared but unused.

**Severity:** Medium for scale; Low for current single-VPS deployment.

---

## 11. Duplicate processing

| Effect | Guard |
|---|---|
| Webhook replay | unique `providerEventId` |
| Payment attempt | unique `activeOrderId` |
| Ticket per order slot | unique `(orderItemId, sequenceNo)` |
| Check-in | CAS + unique `CheckIn.ticketId` |
| Refund per ticket | unique `RefundItem.ticketId` |
| Fee entry | unique idempotency key + composite unique |
| Notification | unique idempotency key + `(notificationId, channel)` |
| Checkout request | unique `(userId, scope, key)` + request hash |

**Strength:** this is the best-engineered part of the system. Real-DB concurrency remains unverified.

---

## 12. Other findings

| # | Finding | Severity | Recommendation |
|---|---|---|---|
| S-1 | Public ticket code is the scan credential | High (design) | Decide on scanner token; document threat model |
| S-2 | Live notification transport disabled | Blocker (product) | Owner activation, not a security fix |
| S-3 | Per-process rate limits | Medium | Shared store if multi-instance |
| S-4 | No malware scanning for documents | Medium (future) | Add scanning/sanitisation |
| S-5 | No private document model | Critical for feature 4 | Schema + storage + authz |
| S-6 | Legacy `User.role` guard remains | Medium debt | Retire after surface inventory |
| S-7 | No queue/worker alerting | Medium ops | Monitor leases and failed deliveries |
| S-8 | `'unsafe-inline'` in CSP | Low | Nonce-based CSP if feasible |
| S-9 | No real-DB security evidence | High for release claim | Phase 3G |
| S-10 | Public Google Drive documentation link | Medium | Keep separate from private blast |

---

## 13. Conclusion

No critical exploitable access-control or injection defect was found in the reviewed paths. The system is defensively designed, especially around tenant isolation, payment replay and duplicate effects. The unresolved risks are the public-code admission model, the disabled live transport, per-process limits, the absence of private document distribution, and the lack of real-database concurrency evidence.
