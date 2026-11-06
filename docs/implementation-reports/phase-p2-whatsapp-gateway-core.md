# Phase P2 — WhatsApp Gateway Core

**Status:** implemented and verified against the isolated test database. P2 stops here; no P3 work was started.

**Scope:** an isolated WhatsApp gateway process that owns the Baileys socket lifecycle, exposes only a loopback internal HTTP API authenticated with `WA_GATEWAY_TOKEN`, and keeps a durable idempotency/reconciliation ledger keyed by `deliveryId`.

**Explicit non-goals:** no production pairing, no QR exposure, no real message, no worker-to-gateway integration, no live transport selection, no changes to payment or ticket issuance.

---

## 1. Architecture implemented

```
Next.js (tinggalklik)          Notification worker (tinggalklik-worker)
        │                                  │
        │                                  │  owns Notification /
        │                                  │  NotificationDelivery
        │                                  │
        │                         (future P3 client; NOT wired in P2)
        │                                  │
        │                      127.0.0.1 + Bearer token
        │                                  ▼
        │                     WhatsApp gateway (tinggalklik-wa)
        │                       ├─ loopback HTTP API
        │                       ├─ DB lease + local lock
        │                       ├─ WhatsAppGatewayDispatchService
        │                       ├─ encrypted session store
        │                       └─ WhatsAppSocketLike
        │                                  │
        └──────────────────────────────────┴── no public endpoint
```

- `scripts/whatsapp-gateway.ts` is a separate process entrypoint, disabled by default.
- `WhatsAppGateway` owns the lifecycle, lease/lock, HTTP server and at most one socket.
- The gateway never processes `Notification` or `NotificationDelivery`; the P1 worker remains the only queue owner. It writes only `WhatsAppGatewayMessage`, an additive idempotency/reconciliation ledger.
- The HTTP server binds `127.0.0.1` or `::1` only. There is no Next.js route, public port, nginx upstream or QR surface.
- Tests inject `WhatsAppSocketLike` fakes. The real Baileys factory exists for deployment, but it was never invoked against WhatsApp in this phase.

### Internal API

All routes require `Authorization: Bearer <WA_GATEWAY_TOKEN>`.

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness: `state`, `connected` |
| `GET` | `/readyz` | 200 only when `CONNECTED` and ownership is held |
| `POST` | `/v1/messages/text` | Dispatch one text message for a stable `deliveryId` |
| `GET` | `/v1/messages/:deliveryId` | Safe ledger lookup |
| `POST` | `/v1/messages/:deliveryId/reconcile` | Explicit resolution of an `AMBIGUOUS` dispatch |

The body limit defaults to 8 KiB and is enforced while reading. JSON content type is mandatory. Payload validation happens before the ledger is touched or a socket is reached. Group JIDs (`@g.us`), malformed numbers, empty text, oversized text and malformed IDs are refused.

---

## 2. Files changed

### New implementation

- `lib/whatsapp/gateway/config.ts` — fail-closed configuration; disabled default; loopback bind; absolute, repo-external session path; 32-byte session key.
- `lib/whatsapp/gateway/encrypted-store.ts` — AES-256-GCM JSON store, atomic write, `0700` directory / `0600` file, tamper/wrong-key refusal.
- `lib/whatsapp/gateway/baileys-auth.ts` — maps Baileys `AuthenticationState` to the encrypted store; refuses to invent credentials.
- `lib/whatsapp/gateway/lifecycle.ts` — explicit eight-state machine.
- `lib/whatsapp/gateway/reconnect.ts` — bounded pure reconnect policy.
- `lib/whatsapp/gateway/local-lock.ts` — exclusive `O_EXCL` process lock in the session directory.
- `lib/whatsapp/gateway/lease.ts` — `joblock: whatsapp-gateway` lease acquire/renew/release.
- `lib/whatsapp/gateway/protocol.ts` — internal request/response types, validation and safe views.
- `lib/whatsapp/gateway/dispatch.ts` — durable idempotency ledger, serialized sends, timeout/ambiguous handling, receipt monotonicity, reconciliation.
- `lib/whatsapp/gateway/socket.ts` — fakeable socket boundary and the only runtime Baileys import (dynamic); QR payloads are dropped, logger is silent.
- `lib/whatsapp/gateway/server.ts` — loopback HTTP server, bearer auth, body cap, routes.
- `lib/whatsapp/gateway/gateway.ts` — orchestrator: ownership, lifecycle, readiness, dispatch, reconnect/fencing, graceful shutdown.
- `scripts/whatsapp-gateway.ts` — CLI entrypoint with SIGTERM/SIGINT handling; no pairing command.
- `prisma/migrations/20261106000000_add_whatsapp_gateway_message/migration.sql` — additive table/enums.
- `__tests__/whatsapp-gateway/helpers.ts` — temp session dirs, fake socket, test config.
- `__tests__/whatsapp-gateway/config-security.test.ts`
- `__tests__/whatsapp-gateway/server.test.ts`
- `__tests__/whatsapp-gateway/dispatch.integration.test.ts`
- `__tests__/whatsapp-gateway/gateway.test.ts`
- `docs/implementation-reports/phase-p2-whatsapp-gateway-core.md` — this report.

### Operational/configuration changes

- `prisma/schema.prisma` — `WhatsAppGatewayMessage`, `WhatsAppGatewayMessageState`, `DeliveryAcknowledgementStatus`; no changes to existing notification models.
- `package.json` — added `gateway:whatsapp` only.
- `jest.config.js` — added `**/__tests__/whatsapp-gateway/*.test.ts`.
- `ecosystem.config.cjs` — added `tinggalklik-wa`, single fork instance, clean-exit stop, 30s kill window.
- `.env.example` — disabled gateway section and key custody guidance.
- `.gitignore` — ignores accidental gateway session material.
- `DEPLOYMENT_RUNBOOK.md` — §7.2 operational section.
- `lib/notifications/logger.ts` — extended existing log sanitization so phone/email-shaped text inside ordinary string fields is redacted too. This is a small defence-in-depth change for gateway logs; it does not alter queue behavior.

No payment, ticket issuance, Prisma version, dependency version, SMTP/Auth.js Email provider, or live transport was changed. `npm audit fix` was not run.

---

## 3. Gateway lifecycle

States are exactly:

`STOPPED`, `STARTING`, `PAIRING_REQUIRED`, `CONNECTED`, `DISCONNECTED`, `LOGGED_OUT`, `CONFLICT`, `ERROR`.

Startup order:

1. Validate config. If disabled, exit without reading a session or opening a socket.
2. `STOPPED → STARTING`.
3. Acquire the `joblock` row named `whatsapp-gateway`. Failure → `CONFLICT` with no socket.
4. Acquire the local `.gateway.lock` (mode `0600`). Failure → release the DB lease, `CONFLICT`.
5. Ensure the session directory exists with `0700`; check for the encrypted `auth.enc`.
6. Start the loopback HTTP server. Failure → release ownership, `ERROR`.
7. If no session → `PAIRING_REQUIRED`, no socket, no QR.
8. If a session exists → construct one socket and wait for its connection event.

Runtime behavior:

- Connection open → `CONNECTED`; reconnect budget reset.
- Lost connection → `DISCONNECTED`, bounded backoff, new socket only after the old one is ended.
- `restartRequired` → `DISCONNECTED` and reconnect.
- `loggedOut` / forbidden → `LOGGED_OUT`, no automatic reconnect.
- `connectionReplaced` → `CONFLICT`: close the socket, release lease/lock, close the server. A replaced owner never keeps competing.
- Lease renewal failure → same fencing path.
- Bad session → `ERROR`; no reconnect loop.
- QR event → the payload is discarded in `socket.ts`; state becomes `PAIRING_REQUIRED` and the socket is closed. There is no way to retrieve the QR via HTTP.
- SIGTERM/SIGINT → stop accepting work, await the in-flight dispatch up to the grace window, close the socket, release lease/lock, `STOPPED`.

`healthz`/`readyz` report only state/readiness/session-presence booleans. They never expose a token, QR, JID, phone number, message body, session path or credential.

---

## 4. Authentication and security

- **Loopback only, twice:** configuration rejects any host other than `127.0.0.1`/`::1`, and `GatewayHttpServer.start` re-checks before `listen`.
- **Token:** `WA_GATEWAY_TOKEN` is mandatory when enabled and must be at least 32 characters. Every route, including health, requires `Authorization: Bearer …`; comparison is timing-safe over SHA-256 digests.
- **Bounded input:** 8 KiB default body cap, mandatory `application/json`, request/header timeouts, and validation before any ledger write.
- **No public surface:** no Next.js route, no nginx upstream, no QR route, no pairing command, no webhook.
- **No PII in logs:** gateway logs carry event/state/code fields only. Socket exceptions are not printed, because a provider/socket error can contain a token, phone, JID or session path. The shared logger masks recipient-named fields and redacts credential/email/phone-shaped text in ordinary string values.
- **No raw recipient in persistence:** the ledger stores a keyed HMAC (`recipientHash`), never the JID or phone number. It stores no message body.
- **Delivery source of truth:** `NotificationDelivery` is untouched by the gateway. A test creates a queued delivery, dispatches through the gateway and proves the delivery remains `QUEUED` with zero attempts.
- **Ack distinction:** gateway acceptance is `ackStatus=ACCEPTED`; `DELIVERED`/`READ` are set only from a real receipt event and only move forward. `SENT` is never presented as `DELIVERED` without a receipt.

---

## 5. Session custody

| Item | Decision |
|---|---|
| Cipher | AES-256-GCM, random 96-bit IV, 128-bit auth tag, versioned envelope, AAD-bound |
| Key | `WA_SESSION_ENCRYPTION_KEY`, exactly 32 bytes encoded base64 or hex |
| Key location | Host environment/secret manager only; never Git, never the repo, never a log |
| Session location | `WA_AUTH_DIR`, absolute and outside the repository/web root; config rejects repo paths |
| Directory mode | `0700`; symlinks refused |
| File mode | `0600`; atomic write via a same-directory temp file and rename |
| Plaintext | None written to disk; the encrypted envelope is the only file |
| Missing/invalid key | Startup refused with a code, not a fallback key |
| Key/session loss | Re-pairing required; P2 has no pairing path |
| Rotation | Not implemented in P2; must be an explicit re-encryption procedure later |
| Backup | Key and session must be backed up separately; either one alone is insufficient |

The Baileys auth state uses `BufferJSON` inside the encrypted envelope. If no session exists, `baileys-auth.ts` refuses to call `initAuthCreds()`; the gateway reports `PAIRING_REQUIRED` without constructing a socket.

---

## 6. Idempotency and reconciliation

`WhatsAppGatewayMessage` is keyed by **unique `deliveryId`** and includes a unique nullable `messageId`, `state`, `ackStatus`, `attemptCount`, `leaseUntil`, safe error code, acknowledgement timestamps and an expiry.

Dispatch flow:

1. Validate the request before touching the ledger.
2. Insert `SENDING` with a 60s dispatch lease, or read the existing row after a unique conflict.
3. `SENT` → replay the same result; **no second socket send**.
4. `SENDING` with a live lease → `IN_PROGRESS`; no second send.
5. `SENDING` with an expired lease → `AMBIGUOUS`; no second send.
6. `FAILED_BEFORE_SEND` → reclaim and retry, because the socket definitively refused before accepting.
7. `AMBIGUOUS` → return it unchanged. Only an explicit reconciliation can resolve it.
8. `SENT` is recorded only after the socket returned a real message id. It implies acceptance, not delivery.
9. A timeout raises `DISPATCH_TIMEOUT` and leaves the row `AMBIGUOUS` with `ackStatus=NONE`. A late socket result cannot overwrite that state.

Reconciliation:

- `POST /v1/messages/:deliveryId/reconcile` accepts only `SENT` (with the real provider `messageId`) or `FAILED_BEFORE_SEND`.
- It refuses rows that are not `AMBIGUOUS`, and refuses missing rows.
- A reconciled `SENT` starts at `ACCEPTED`; it does not fabricate `DELIVERED`.
- Receipt transitions are monotonic: `NONE → ACCEPTED → DELIVERED → READ`; `FAILED` is terminal. A late `DELIVERED` cannot move `READ` backwards.

Retention is represented by `expiresAt`; a purge/sweep is deliberately not introduced in P2.

---

## 7. Tests and actual results

No real WhatsApp account, QR, socket or message was used. All gateway socket behavior is exercised through `FakeSocket`.

### Test coverage

| Requirement | Where |
|---|---|
| Lifecycle transitions, all eight states | `config-security.test.ts`, `gateway.test.ts` |
| Single-owner DB conflict | `gateway.test.ts` |
| Local lock conflict and lease release | `config-security.test.ts`, `gateway.test.ts` |
| Duplicate `deliveryId` / concurrent dispatch | `dispatch.integration.test.ts`, `gateway.test.ts` |
| Unauthorized request | `server.test.ts` |
| Malformed payload before ledger/socket | `server.test.ts`, `config-security.test.ts`, `gateway.test.ts` |
| Timeout → `AMBIGUOUS`, no blind retry | `dispatch.integration.test.ts`, `gateway.test.ts` |
| Exception before send → retryable failure | `dispatch.integration.test.ts` |
| Explicit reconciliation and receipt monotonicity | `dispatch.integration.test.ts` |
| Reconnect with a new socket | `gateway.test.ts` |
| Logout is terminal | `gateway.test.ts` |
| Replaced connection fences ownership | `gateway.test.ts` |
| Graceful shutdown completes in-flight dispatch and releases ownership | `gateway.test.ts` |
| Secret/PII redaction | `config-security.test.ts`, `gateway.test.ts`, existing `logging.test.ts` |
| No public bind | `config-security.test.ts`, `server.test.ts` |
| Session encryption, tamper/wrong-key refusal, `0700`/`0600` | `config-security.test.ts` |
| Gateway does not write `NotificationDelivery` | `dispatch.integration.test.ts` |

### Actual commands and results

```text
npx jest __tests__/notifications/logging.test.ts __tests__/whatsapp-gateway --runInBand
PASS __tests__/whatsapp-gateway/gateway.test.ts
PASS __tests__/whatsapp-gateway/dispatch.integration.test.ts
PASS __tests__/whatsapp-gateway/config-security.test.ts
PASS __tests__/whatsapp-gateway/server.test.ts
PASS __tests__/notifications/logging.test.ts
Test Suites: 5 passed, 5 total
Tests:       47 passed, 47 total
```

```text
npx tsc --noEmit          # exit 0
npx prisma validate       # schema valid
git diff --check          # exit 0
node -e "require('./ecosystem.config.cjs')"  # three PM2 apps, stop_exit_codes [0]
```

Database preparation:

```text
npx prisma generate
DATABASE_URL="$TEST_DATABASE_URL" npx prisma migrate deploy
# 33 migrations found; 20261106000000_add_whatsapp_gateway_message applied
npm run test:db:setup
# Verified isolated test schema 'tinggalklik_test'. No data was changed.
```

The migration was applied **only** to the isolated `tinggalklik_test` schema. No production migration or deployment was run.

---

## 8. Remaining risks

1. **The real Baileys runtime path is unexercised.** It typechecks and is isolated behind `WhatsAppSocketLike`, but no real account was paired and no real socket was opened. The first live connection, QR/pairing behavior and real receipt status codes must be validated in P3 with an approved account.
2. **No worker integration in P2.** The notification worker does not call the gateway yet, and the live transport remains clamped by Phase 1. Enabling the gateway does not make the queue send WhatsApp messages.
3. **Bearer token only.** The API is loopback-bound and token-authenticated, but has no mTLS, token rotation or per-caller rate limiting. Keep it loopback-only and treat `WA_GATEWAY_TOKEN` as a host secret.
4. **Lease clocks are application clocks.** The DB lease uses the process clock for acquisition/renewal. This is acceptable for the single-VPS deployment; multi-host ownership would need database-time checks or stronger fencing.
5. **A stale local lock after a hard crash requires operator action.** It is intentionally not auto-stolen, because deleting it blindly could allow two sockets.
6. **Key rotation is not implemented.** Losing or rotating `WA_SESSION_ENCRYPTION_KEY` requires an explicit re-pair/re-encryption procedure.
7. **Retention is recorded but not swept.** `expiresAt` exists on every row; a scheduled purge is a later operational task.
8. **Reconciliation notes are operator-supplied.** They are stored in the DB, not logged. Operators should not paste phone numbers or message bodies into them; no note-level PII scrubber is implemented in P2.

---

## 9. Deployment requirements (for a later approved phase)

Do **not** deploy or enable P2 as a live sender without explicit approval.

1. Set host environment:
   - `WA_GATEWAY_ENABLED=true` only when approved.
   - `WA_GATEWAY_TOKEN` ≥32 random characters.
   - `WA_SESSION_ENCRYPTION_KEY` exactly 32 bytes (base64 or hex).
   - `WA_AUTH_DIR` absolute, outside the checkout and web root.
2. Create the session directory with `0700`, owned by the service user. Do not create a session file by hand.
3. Keep the key in the host secret store, separately from session backups.
4. Ensure no nginx/tunnel/public firewall rule exposes the gateway port. It must remain `127.0.0.1`/`::1`.
5. Run `npx prisma migrate deploy` on the production database only in the approved deployment window. The migration is additive.
6. Start `tinggalklik-wa` with PM2; verify the process is `online` and `/readyz` is reachable only with the bearer token.
7. Do not pair an account or expect messages to send until P3/P4 wiring and the owner’s approval.
8. The P1 worker remains the only notification queue owner; do not add a second queue or a second gateway poller.

---

## 10. Rollback procedure

1. `pm2 stop tinggalklik-wa` (graceful; the gateway finishes an in-flight dispatch up to its grace window).
2. Revert the P2 process revision / PM2 entry and run `pm2 save`.
3. Leave `whatsappgatewaymessage` and its enums in place. They are additive and harmless when unused; dropping tables during an incident is unnecessary and destructive.
4. If the process cannot release its lease, confirm it is stopped, then remove only the `joblock` row named `whatsapp-gateway`; do not touch `notification-dispatch`.
5. Keep the encrypted session and key if there is any chance of resuming. Delete them only on an explicit retirement decision; deleting either prevents resumption without re-pairing.
6. Do not roll back by running `prisma migrate reset`, `db push`, or by modifying `Notification`/`NotificationDelivery`.

---

## 11. Confirmation

- **No real WhatsApp account was paired.**
- **No QR was generated, displayed, logged or exposed.**
- **No Baileys socket was connected to WhatsApp.**
- **No real message was sent.**
- The only database migration was applied to the isolated `tinggalklik_test` schema.
- P2 stops here; P3 and later phases were not started.
