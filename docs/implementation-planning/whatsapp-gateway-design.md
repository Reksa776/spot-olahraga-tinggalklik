# WhatsApp Gateway Design

**Status:** PROPOSED — no gateway, socket, session, dependency or account exists yet.

**Decision basis:** Baileys is approved; one dedicated TinggalKlik.co number; one centralized gateway shared by all organizers and events; existing `Notification` / `NotificationDelivery`, worker and retry infrastructure are reused; SMTP remains the email transport; the gateway runs independently from the Next.js web process.

---

## 1. What exists, and what this design adds

**VERIFIED.** Today `lib/notifications/transports/baileys.ts` is a refusing stub. It does not import `@whiskeysockets/baileys`, does not create a socket, does not read `WA_AUTH_DIR`, and has no pairing flow (`:1-53`). The only instantiable WhatsApp transport is dry-run (`lib/notifications/transports/dry-run.ts:47-66`).

**PROPOSED.** Add two processes around the existing queue:

```
Next.js web (3003)
  └─ writes Notification + NotificationDelivery only

notification worker (separate process)
  └─ claims delivery rows, renders template, calls the gateway over loopback

whatsapp-gateway (separate process, single instance)
  └─ owns exactly one Baileys socket and the encrypted auth state
  └─ serialises sends
  └─ records message id + acknowledgement state
  └─ exposes only a loopback/internal HTTP contract

MySQL/MariaDB
  └─ Notification / NotificationDelivery
  └─ WhatsAppGatewayMessage (new, proposed)
  └─ JobLock (existing lease pattern)
```

The gateway is **not** a second notification queue. It does not decide who should receive a message, does not render templates, does not retry a business notification, and does not know about organizers or events. Those remain in the existing worker/producers.

---

## 2. Non-goals

- No public HTTP endpoint, QR page, dashboard or admin UI for pairing.
- No per-organizer WhatsApp account, per-event socket, group send, broadcast list, newsletter channel or channel messaging.
- No inbound message bot, auto-reply, lead capture or CRM.
- No media library. Document delivery is a separate design (`post-event-document-design.md`); the first release sends a secure link, not an attachment.
- No guarantee of exactly-once delivery.
- No automatic re-pair after logout. A logout is an operator event.

---

## 3. Process and API boundary

### 3.1 Listener

**PROPOSED.**

- Bind to `127.0.0.1` on `WA_GATEWAY_PORT` (default `3100`) **or** a Unix domain socket under `WA_AUTH_DIR`'s parent. Loopback TCP is simpler to operate; nginx must never proxy it.
- `instances: 1`, `exec_mode: "fork"` in PM2. This is a correctness setting, like the web app's single instance in `ecosystem.config.cjs:23-25`.
- The gateway has no Next.js import, no React import and no route handler. It can share pure protocol/validation modules, but must not boot the Next runtime.

### 3.2 Internal API

**PROPOSED.** Authenticated with `Authorization: Bearer <WA_GATEWAY_TOKEN>`; comparison is constant-time and a missing token fails closed. Request bodies are bounded (for example 8 KB for text; no arbitrary file path).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Process liveness; no secrets, no recipient data |
| `GET` | `/readyz` | Socket connected and session usable; `503` otherwise |
| `POST` | `/v1/messages/text` | Send one text to one validated individual JID |
| `POST` | `/v1/messages/document` | **Later phase only**; send one document attachment after approval |
| `GET` | `/v1/messages/:deliveryId` | Resolve the durable state of one dispatch (for timeout recovery) |
| `POST` | `/v1/shutdown` | **Not exposed**; shutdown is a signal, not an HTTP control |

The send request carries:

```json
{
  "deliveryId": "cuid-of-notificationdelivery",
  "notificationId": 123,
  "to": "6281234567890",
  "text": "plain text only"
}
```

`deliveryId` is the stable idempotency key. The gateway never accepts a caller-supplied `messageId`, a JID domain other than `s.whatsapp.net`, a group JID, a broadcast list, or a raw file path.

### 3.3 Why the worker calls HTTP instead of importing Baileys

**PROPOSED rationale.**

- A worker restart must not tear down the WhatsApp socket.
- A gateway restart must not stop email delivery or queue claiming.
- The Next.js build must never contain Baileys or session code.
- The gateway can enforce one-socket ownership independently of how many worker processes an operator accidentally starts.
- The existing worker's `WhatsAppTransport` interface (`lib/notifications/types.ts:56-73`) already isolates the transport; an HTTP client is a natural implementation.

The alternative — Baileys inside the worker — is rejected for this deployment because it couples session custody to queue polling, makes a worker deploy a socket reconnect, and makes a second worker a potential second socket.

---

## 4. Session custody and pairing

### 4.1 Location and permissions

**PROPOSED.**

- `WA_AUTH_DIR` is outside the checkout, for example `/var/lib/tinggalklik/whatsapp-auth`.
- Directory mode `0700`, files `0600`, owner the service account.
- Never in git. The current `.gitignore` has only a commented legacy `#data/whatsapp-auth/` entry (`.gitignore:35-36`), so relying on a repository-relative path is not acceptable. The deployment must use an absolute path outside the tree.
- Backups are encrypted separately and restore-tested. A stolen session is equivalent to control of the WhatsApp account.

### 4.2 Encrypted auth state

**PROPOSED.** Use a custom Baileys `AuthenticationState` wrapper rather than plain `useMultiFileAuthState`:

- Persist credentials and signal keys as one AES-256-GCM envelope per file:
  `{ v: 1, iv, tag, ciphertext }`.
- Key: `WA_SESSION_ENCRYPTION_KEY`, exactly 32 bytes base64/hex, supplied by the host environment or a secret manager. The gateway refuses to start if it is missing or malformed. It is **not** `AUTH_SECRET` and not stored in the repository.
- Serialize with Baileys' `BufferJSON` replacer/reviver so key buffers survive.
- Write to a temporary file in the same directory, `fsync`, `rename`, then `chmod 0600`; never write plaintext credentials to disk.
- Keep a small in-memory cache; a key update is flushed before the next socket operation.
- Provide `npm run wa:rekey` to decrypt and re-encrypt under a new key after an approved rotation. It must not print keys or credentials.

If the operating system already provides full-disk/volume encryption, the application-level envelope is still kept as defence in depth. It is not a substitute for host access control.

### 4.3 Pairing

**PROPOSED.** Pairing is a host-only CLI:

```
npm run wa:pair
```

- Acquires the same single-owner lock as the gateway.
- Prints a QR in the operator's terminal using the already-declared `qrcode` package; never renders it in a web response, log aggregator or chat.
- Waits for `connection.update` with `qr`, then for `open`; writes the encrypted auth state; exits.
- No pairing endpoint exists in Next.js and no route imports the gateway.
- The gateway starts only after a usable session exists. If no session exists, it reports `PAIRING_REQUIRED` and does not spin.

**PROPOSED.** A fresh pairing must be performed for the dedicated number only. The operator must not pair a personal number or an account used for other automation.

---

## 5. Single-instance ownership

Two independent guards are required:

### 5.1 Database lease

**PROPOSED.** Reuse the existing `JobLock` pattern (`lib/jobs/lock.ts:26-119`) with a new row name `whatsapp-gateway`:

```
acquire: upsert row, then UPDATE ... WHERE lockedUntil IS NULL OR lockedUntil < now
renew:   UPDATE ... WHERE name = 'whatsapp-gateway' AND lockedBy = :workerId
release: clear lease, set lastRunAt/lastStatus
```

- Lease 90 seconds, renew every 30 seconds.
- Acquire **before** opening the socket.
- If renewal fails or the lease is lost, close the socket immediately and enter `FENCED`; do not send.
- If the database is unreachable at startup, fail closed: no socket.

### 5.2 Local file lock

**PROPOSED.** Take an exclusive `flock` on `WA_AUTH_DIR/.gateway.lock` before reading the auth state. This protects against two processes on the same host even if they point at different databases, and against a pairing CLI racing a running gateway. A second process exits with a clear operator error.

The database lease handles split ownership across hosts; the file lock handles local mistakes. Neither alone is sufficient.

---

## 6. Connection lifecycle

### 6.1 States

**PROPOSED.**

`STARTING → PAIRING_REQUIRED | CONNECTING → CONNECTED → RECONNECTING → CONNECTED`
with terminal `LOGGED_OUT`, `CONFLICT`, `FENCED`, `STOPPED`, `FATAL`.

Health reports the state, `connectedSince`, `lastDisconnectReason`, `lastMessageAt`, and whether the session is usable. It must not report the phone number in full, auth contents or QR material.

### 6.2 Disconnect matrix

| Baileys condition | Action |
|---|---|
| `connection.update` with `qr` | Only during the pairing CLI; the gateway reports `PAIRING_REQUIRED` |
| `close` / `DisconnectReason.loggedOut` (401) | `LOGGED_OUT`; stop; quarantine the encrypted auth state; require a new pairing; **never loop** |
| `close` / `DisconnectReason.replaced` or conflict | `CONFLICT`; stop; another session owns the account; do not fight |
| `close` / `DisconnectReason.restartRequired` (515) | Reconnect once with a short delay |
| `close` / connection lost, timeout, 428, 503 | Exponential backoff with jitter: 1s, 5s, 15s, 30s, 60s, then 5m cap |
| Invalid/missing session | `PAIRING_REQUIRED`; no socket loop |
| Malformed auth state/decryption failure | `FATAL`; refuse to delete or overwrite the state; operator investigation |
| Lease lost / file lock lost | `FENCED`; close socket immediately |

**PROPOSED.** Reconnect never opens a second socket alongside the old one. The old socket is ended and awaited before a new one is created. A reconnect storm must be bounded by the backoff and a maximum attempts-per-hour alarm.

### 6.3 Socket options

**PROPOSED.** Minimal-history configuration:

- `syncFullHistory: false`
- `markOnlineOnConnect: false`
- no link previews generated by the gateway
- a fixed, non-secret browser identity
- a Baileys logger adapter that routes to the structured logger and redacts message content, JIDs and keys
- no `getMessage` callback that would persist message history

No message body is written to the gateway's database. Only the delivery id, recipient hash, state, provider message id and ack state are stored.

---

## 7. Safe dispatch

**PROPOSED.**

1. Validate `deliveryId` is a non-empty opaque id and `notificationId` is an integer.
2. Normalize the recipient using the existing `normalizeIndonesianPhone()` (`lib/notifications/contacts.ts:53-107`); reject anything that does not produce `^628\d{7,10}$`.
3. Build the JID as `<digits>@s.whatsapp.net`. Reject `@g.us`, `@broadcast`, `@newsletter`, status/broadcast JIDs and any input containing `@`, `/`, whitespace or a second `+`.
4. Validate text length (for example 1–4,096 characters) and reject non-string bodies. No HTML interpretation is performed.
5. Serialize sends through a single in-process mutex. WhatsApp limits and Baileys are not designed for parallel sends from one socket; the worker already claims WhatsApp with concurrency 1 (`lib/notifications/config.ts:227-228`), but the gateway must enforce it independently.
6. Apply a configurable minimum inter-message delay (the existing worker's `WHATSAPP_SEND_DELAY_MS` remains the first control; the gateway adds a hard floor).
7. Call `sock.sendMessage(jid, { text })` and return `key.id` when present. Do not report `DELIVERED`; a successful call means **accepted by the socket/provider**, not delivered to a human.
8. Never accept a recipient list. One request = one recipient = one message.

**PROPOSED.** If `sendMessage` returns no message id, treat the outcome as `AMBIGUOUS`, not success. The worker must not update the delivery to `SENT` without a provider id from a live transport.

---

## 8. Dispatch idempotency and acknowledgement

The full reliability policy is in `notification-reliability-design.md`. The gateway-specific contract is:

- `deliveryId` is the idempotency key. The gateway persists a `WhatsAppGatewayMessage` row keyed by `deliveryId` before calling the socket.
- If the same `deliveryId` arrives again:
  - `SENT` with a message id → return the same id; no second send.
  - `FAILED_BEFORE_SEND` → a retry is allowed; increment attempts.
  - `SENDING` within the lease → `409 IN_PROGRESS`; the caller must not start a parallel send.
  - `SENDING` whose lease expired, or any `AMBIGUOUS` → `409 AMBIGUOUS`; **never resend automatically**.
- A worker HTTP timeout is resolved with `GET /v1/messages/:deliveryId`. If the state cannot be proven, the worker records terminal `FAILED/AMBIGUOUS_DELIVERY`.
- Acknowledgements (`messages.update` / receipt events) update the gateway's ack state. A bounded reconciliation job copies them to `NotificationDelivery`; the gateway does not claim a message was read when it was only accepted.

---

## 9. Health, shutdown and observability

**PROPOSED.**

- `GET /healthz`: process is alive; returns only state and uptime.
- `GET /readyz`: `200` only when the lease is held, the file lock is held, the socket is `CONNECTED`, and the session is not `LOGGED_OUT`; otherwise `503`.
- Structured JSON logs: state transitions, disconnect reason code, send attempt, delivery id, notification id, provider message id presence, ack state. Never log the recipient, token, QR, auth file path or message body.
- Metrics/alerts: disconnected > 2 minutes, `LOGGED_OUT`, repeated reconnects, `AMBIGUOUS` count, send failure rate, queue age, lease renewal failure.
- Graceful shutdown on `SIGTERM`/`SIGINT`:
  1. stop accepting new HTTP sends (`503`);
  2. await the current send with a hard deadline (for example 10 seconds);
  3. `sock.end()` and flush encrypted auth state;
  4. release the DB lease and file lock;
  5. exit. PM2 `kill_timeout` must exceed this deadline (for example 20 seconds).

A shutdown must not mark an in-flight message `SENT` unless the socket returned a message id; otherwise the existing ambiguous-recovery path applies.

---

## 10. Security and threat model

| Threat | Control |
|---|---|
| Session theft | Encrypted auth state, `0700/0600`, host-only path, no backup in repo, encrypted backup, least-privilege service user |
| QR theft / account takeover | Pairing only on host TTY; no web route, no screenshot in logs; QR expires |
| Second socket / split brain | DB lease + file lock; `replaced` stops immediately |
| Arbitrary message relay | Loopback bind + bearer token + fixed individual-JID validation; no recipient lists; no public endpoint |
| Token leakage in logs | Structured logger redaction; never log `WA_GATEWAY_TOKEN` or Authorization header |
| Spam / account ban | One-at-a-time send, hard delay, per-day caps, priority for transactional messages, no broadcast primitive |
| Malicious document | Document path is separate; malware scan and link-only MVP; gateway never fetches a URL |
| SSRF | No URL fetch; document bytes, if ever added, are read from the app's private storage, not a caller URL |
| Replay | `deliveryId` idempotency; bounded request bodies; token auth |
| Data retention | Gateway stores only metadata and a hash, purged on a fixed schedule |

**Residual risk (must be stated to the owner).** Baileys is an unofficial client. A number can be banned or logged out despite correct engineering. The design keeps email as an independent channel for purchase proof/ticket issuance, so a WhatsApp ban does not erase the buyer's receipt. H-36 remains WhatsApp-only by product requirement.

---

## 11. Proposed files and interfaces

**PROPOSED only; do not create these as part of this planning task.**

| File | Responsibility |
|---|---|
| `scripts/whatsapp-gateway.ts` | Process entrypoint, config, signal handling |
| `scripts/whatsapp-pair.ts` | Host-only pairing CLI |
| `lib/whatsapp/gateway/config.ts` | Fail-closed env parsing; no secret logging |
| `lib/whatsapp/gateway/server.ts` | Loopback HTTP API, auth, body limits |
| `lib/whatsapp/gateway/session.ts` | Socket lifecycle, reconnect matrix, shutdown |
| `lib/whatsapp/gateway/encrypted-auth-state.ts` | AES-GCM Baileys auth state |
| `lib/whatsapp/gateway/ownership.ts` | JobLock lease + file lock |
| `lib/whatsapp/gateway/dispatch.ts` | Serialized send, JID validation, idempotency |
| `lib/whatsapp/gateway/receipts.ts` | Ack state updates and reconciliation |
| `lib/notifications/transports/whatsapp-gateway.ts` | Worker-side `WhatsAppTransport` HTTP client |
| `prisma/schema.prisma` (proposed migration) | `WhatsAppGatewayMessage` + enums, ack columns |
| `ecosystem.config.cjs` (proposed) | `tinggalklik-wa` and `tinggalklik-worker` apps |
| `__tests__/whatsapp-gateway/*` | Unit/contract tests with a fake socket; no real account |

The worker-side transport must implement the existing interface:

```ts
type WhatsAppTransport = NotificationTransport<OutboundWhatsApp>;
```

and return `{ simulated: false, providerMessageId }` only after the gateway confirms acceptance. It must throw a typed `AmbiguousDeliveryError` on an unknown outcome so the worker can terminate rather than retry.

---

## 12. Decisions still required before implementation

1. **Host and service account** for the gateway, and whether the session volume is LUKS-encrypted as well as app-encrypted.
2. **Pairing operator and recovery procedure** if the phone is lost.
3. **Initial WhatsApp caps** for transactional messages versus document blasts.
4. **Whether document attachments are ever allowed.** The recommended MVP is a secure link.
5. **SMTP provider/credentials** and the nodemailer advisory decision; email remains an independent channel.
6. **Approval to add `tsx` and `dotenv` as direct dependencies** (or to compile the worker/gateway), because the current scripts rely on undeclared packages.
7. **Whether a second host is ever allowed.** If yes, the file lock is insufficient and a distributed session lease plus network policy must be designed before scaling.
