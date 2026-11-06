# 03 — PROJECT ARCHITECTURE

---

## 1. High-level diagram

```
                         ┌──────────────────────────────┐
                         │ Browser (React 19 client)    │
                         │ catalog, checkout, wallet,   │
                         │ dashboard, camera scanner    │
                         └──────────────┬───────────────┘
                                        │ HTTPS
                         ┌──────────────▼───────────────┐
                         │ Reverse proxy / TLS          │
                         └──────────────┬───────────────┘
                                        │
                         ┌──────────────▼───────────────┐
                         │ Next.js 16 (App Router)      │
                         │ Server Components + 75 API   │
                         │ route handlers               │
                         └───┬───────────┬───────────┬──┘
                             │           │           │
                  ┌──────────▼──┐  ┌─────▼─────┐  ┌──▼─────────────┐
                  │ lib/authz   │  │ services  │  │ proxy.ts (edge) │
                  │ scope/guard │  │ ticketing │  │ auth-only       │
                  └──────┬──────┘  │ events    │  └────────────────┘
                         │         │ notify    │
                         │         │ storage   │
                         │         └─────┬─────┘
                         │               │ Prisma 6
                  ┌──────▼───────────────▼──────┐
                  │ MySQL / MariaDB              │
                  │ 36 models, 32 migrations     │
                  └──────────────────────────────┘

  External / separate processes:
  ┌──────────────┐   ┌────────────────────┐   ┌──────────────────┐
  │ cron (1 min) │──▶│ POST /api/internal │──▶│ event lifecycle  │
  │              │   │ /jobs/tick (secret)│   │ reservation reaper│
  └──────────────┘   └────────────────────┘   │ h36-reminder     │
                                              └──────────────────┘
  ┌──────────────────────┐   ┌───────────────┐   ┌────────────────┐
  │ notification worker  │──▶│ notification  │──▶│ dry-run ONLY   │
  │ (separate process)   │   │ queue tables  │   │ smtp/baileys   │
  └──────────────────────┘   └───────────────┘   │ stubs refuse   │
                                                └────────────────┘

  iPaymu ── webhook (HMAC) ──▶ /api/ticketing/payment/webhook
  Local disk ── public images / private proofs / refund evidence
```

---

## 2. Layers

| Layer | Responsibility | Key files |
|---|---|---|
| Presentation | Pages, layouts, client components, forms | `app/**/page.tsx`, `components/**` |
| HTTP adapter | Parse/validate request, CSRF, session, call service, map errors | `app/api/**/route.ts`, `lib/api/*` |
| Authorization | Resolve actor scope, tenant/PIC decisions, own-scope | `lib/authz/*`, `lib/events/access.ts` |
| Domain services | Business transactions and invariants | `lib/ticketing/**`, `lib/events/**`, `lib/pic/**` |
| Delivery/outbox | Queue rows, templates, worker, transports | `lib/notifications/**` |
| Persistence | Prisma models and migrations | `prisma/schema.prisma`, `prisma/migrations/` |
| Operations | Tick scheduler, leases, sweeps, health | `lib/jobs/*`, `scripts/*` |
| Realtime | Invalidation signals over SSE | `lib/realtime/*` |

The architecture is a **modular monolith**: one deployable Next.js process plus one optional worker process, with domain boundaries enforced by folders and imports rather than network services.

---

## 3. Request lifecycle

### 3.1 Authenticated page (example: PIC scanner)

1. `proxy.ts` matches `/dashboard` and redirects anonymous users to `/login`.
2. Page Server Component calls `requirePicScanAccess(eventId)`.
3. `requireAuth()` reads the JWT session, then `resolveAuthzScope()` reads the user, memberships and grants from the database.
4. `requirePicCheckInAccess()` loads the event stub, the caller's `PICProfile`, and the `PICEventAssignment` for that exact event.
5. `decidePicEventPermission()` returns allow/deny. Any refusal becomes `notFound()` — no existence oracle.
6. Only after authorization is the event display row fetched.
7. The page mounts `TicketScanner` with `canReadLog={false}` and the PIC endpoint.

### 3.2 State-changing API (example: check-in)

```
POST /api/pic/events/[id]/check-in
  → requireSameOrigin (Origin/Referer host check)
  → requireAuth (401 before body parsing)
  → strict Zod body parse
  → checkInTicket
      → requireEventCheckInAccess (organizer path, then PIC fallback)
      → PIC rate limit (120/min per user+event)
      → gate window / event status
      → QR parse → ticket lookup → refund/status checks
      → conditional ticket update + CheckIn insert (transaction)
      → audit row + realtime event
  → handleApi maps AppError to HTTP
```

No business rule lives in the route; the route is deliberately thin. This pattern repeats across organizer, ticketing, admin and PIC routes.

---

## 4. Route groups

| Group | Auth model | Notes |
|---|---|---|
| `/api/events`, `/api/sports`, `/api/uploads/events` | Public | Catalog and public imagery |
| `/api/auth/*` | Public | Auth.js + registration |
| `/api/ticketing/*` | Session | Checkout/order/wallet; ownership enforced in service |
| `/api/ticketing/payment/webhook` | Public by contract | HMAC over raw body; no session |
| `/api/organizer/*` | Session + tenant permission | Organizer membership |
| `/api/pic/*` | Session + PIC own/assignment | Payout own-scope; check-in assignment |
| `/api/admin/*` | Session + platform permission | ADMIN master data/settings/users |
| `/api/reports/*` | Session + own/tenant/platform | PIC fee reports |
| `/api/internal/*` | Machine bearer secret | Fail closed if unset |
| `/api/health*` | Public | Liveness/readiness |
| `/api/realtime/*` | Session | SSE invalidation |

---

## 5. Key domain modules

### Events
`lib/events/service.ts` (1,541 lines) owns organizer event CRUD and transitions. `lifecycle.ts` owns automatic `PUBLISHED→ONGOING→COMPLETED`; `sales-state.ts` owns purchase and gate windows; `access.ts` owns event/venue authorization; `validation.ts` validates event payloads and the documentation URL.

### Ticketing
`checkout.ts` creates order + reservations. `payment/*` handles iPaymu, webhook ledger and settlement. `tickets/issuance.ts` materializes tickets. `checkin/*` admits. `refunds/*` and `settlement/*` handle manual money movement.

### PIC
`pic/attribution.ts`, `fee.ts`, `ledger.ts`, `payout.ts`, `reporting.ts`. `authz/pic-assignment.ts` is the pure scanning decider; `PICEventAssignment` is the event scope.

### Notifications
`enqueue.ts` writes `Notification` + `NotificationDelivery`; `queue.ts` claims and retries; `worker.ts` renders/sends; `templates.ts` is the registry. Three producers exist: purchase proof, ticket issued, H-36 reminder.

### Jobs
`jobs/lock.ts` is a DB lease (`joblock`); `jobs/tick.ts` runs three isolated jobs with one clock. The HTTP route authenticates a shared bearer secret in constant time.

---

## 6. Data flow: purchase to admission

```
Event catalog ──▶ checkout (order + quota hold)
                        │
                        ▼
                 iPaymu payment attempt
                        │
          ┌─────────────┴─────────────┐
          │ browser redirect          │ signed webhook
          │ (never settles)           ▼
          │                    settleVerifiedPayment
          │                    (order PAID, quota converted)
          │                        │
          │                        ├─▶ enqueue purchase proof (post-commit)
          │                        ▼
          │                    ticket issuance (separate, idempotent)
          │                        ├─▶ Ticket rows + QR payload
          │                        └─▶ enqueue ticket-issued message
          ▼
     buyer wallet (/ticketing) ──▶ QR "TICKET:<code>"
                                        │
                                        ▼
                          organizer/PIC check-in API
                          CAS + unique CheckIn + audit
```

---

## 7. Architectural strengths

1. **Server-derived authority.** No route treats a body `role`, `organizerId` or `userId` as authority.
2. **Explicit transaction boundaries.** Money settlement, quota conversion, issuance and admission each have a documented transaction or CAS.
3. **Database-enforced idempotency.** Unique constraints are used instead of read-then-write checks for replay, duplicate scans and double issuance.
4. **Thin routes.** Validation/auth mapping is centralized; domain logic is testable without HTTP.
5. **Append-only audit.** `AdminAuditLog` is written with actor, tenant, entity ref, before/after state and no update/delete path.
6. **Dry-run safety.** The notification layer cannot accidentally send a live message in this build.

---

## 8. Architectural constraints and risks

| Constraint | Consequence |
|---|---|
| Single process, in-memory rate limits | Multi-instance deployments bypass limits; restart resets them |
| Local filesystem uploads | No horizontal scale; backup/restore is operator-owned |
| External cron required | No tick means no lifecycle transitions, no reservation release, no H-36 enqueue |
| Separate worker not in PM2 | Queue progresses only if the operator starts and supervises it |
| No shared queue/Redis | Mass document delivery needs batching and backpressure design |
| `PHASE_1_DRY_RUN_ONLY` constant | No live WhatsApp/email can be enabled by env alone |
| Public ticket code as scan credential | Admission depends on code secrecy, not cryptographic proof |
| No document domain | Feature 4 cannot be implemented without schema and storage design |

---

## 9. Deployment topology inferred from source

```
VPS
├── PM2: next start (loopback)
├── PM2/optional: notification worker  ← not in ecosystem.config.cjs
├── nginx / reverse proxy (TLS, forwarded headers)
├── cron: POST /api/internal/jobs/tick every minute
├── local disk: $UPLOAD_DIR/{events,branding,settlement-proof,refund-evidence}
└── MySQL/MariaDB
```

The app is not designed for serverless: it uses filesystem writes, in-memory rate limits, a long-lived SSE stream and a polling worker. Any move to a multi-instance platform requires replacing those assumptions, not merely adding replicas.
