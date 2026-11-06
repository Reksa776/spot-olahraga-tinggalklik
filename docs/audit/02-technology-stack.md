# 02 — TECHNOLOGY STACK

**Source of truth:** `package.json`, `package-lock.json`, `next.config.ts`, `prisma/schema.prisma`, `ecosystem.config.cjs`, source imports.

---

## 1. Core stack

| Layer | Technology | Version | Evidence |
|---|---|---|---|
| Runtime | Node.js | `>=20.9.0 <25` | `package.json` `engines` |
| Language | TypeScript | `^5` | `devDependencies` |
| Framework | Next.js (App Router) | `^16.4.3` | `package.json`; `app/` |
| UI runtime | React / React DOM | `^19.2.8` | `package.json` |
| Styling | Tailwind CSS | `^4` | `@tailwindcss/postcss`, `app/globals.css` |
| Components | Radix UI + local shadcn-style primitives | Radix 1.x/2.x | `components/ui`, `components/dashboard/ui` |
| Forms | React Hook Form + Zod | `^7.84.0` / `^4.6.7` | checkout, auth, admin forms |
| Charts | Recharts | `^3.10.1` | dashboard charts |
| Icons | lucide-react, react-icons | `^1.46.0`, `^5.7.0` | UI |
| Database | MySQL/MariaDB | provider `mysql` | `prisma/schema.prisma` datasource |
| ORM | Prisma Client / Prisma CLI | `^6.19.3` | `@prisma/client`, `prisma` |
| Package manager | npm (`package-lock.json`) | lockfile v3 | repository root |
| Tests | Jest + ts-jest | `^30.4.2` / `^29.4.12` | `jest.config.js`, `__tests__/` |
| Lint/format | ESLint 9 + Prettier 3 | `^9`, `^3.9.6` | `eslint.config.mjs` |

No Dockerfile, Kubernetes manifest or serverless configuration was found in the repository. Deployment is a conventional Node process (`next start`) behind a reverse proxy, managed by PM2.

---

## 2. Authentication and security libraries

| Library | Version | Use |
|---|---|---|
| `next-auth` | `^5.0.0-beta.32` | Auth.js v5; JWT sessions, Google + Credentials |
| `@auth/prisma-adapter` | `^2.11.3` | User/Account/Session persistence |
| `bcryptjs` | `^3.0.3` | Password hashing and timing-equalised login |
| `zod` | `^4.6.7` | Request/DTO validation; schemas are strict |
| Built-in `crypto` | Node | HMAC webhook verification, SHA-256, random tokens, constant-time compare |

Session strategy is **JWT**, not database sessions (`auth.ts`). The Prisma `Session` table exists for adapter compatibility but is not the active session mechanism.

---

## 3. Ticketing, payment and QR libraries

| Library | Version | Use |
|---|---|---|
| `qrcode` | `^1.5.4` | Server-side QR rendering (where used) |
| `qrcode.react` | `^4.2.0` | Buyer wallet QR component |
| `jsqr` | `^1.4.0` | Scanner fallback when `BarcodeDetector` is unavailable |
| `axios` | `^1.21.0` | iPaymu HTTP client |
| Native `fetch` | Node/Next | Other server calls |
| `crypto` | Node | Webhook HMAC, QR token hash, random references |

QR payload format is locked to `TICKET:<ticketCode>` (`lib/ticketing/tickets/reference.ts`, `lib/ticketing/checkin/qr-payload.ts`). The scanner prefers the browser `BarcodeDetector` API and falls back to jsQR (`components/organizer/TicketScanner.tsx`).

---

## 4. Notification and file libraries

| Library | Version | Use | Active? |
|---|---|---|---|
| `nodemailer` | `8.0.11` | SMTP adapter | **No** — adapter throws; dry-run clamp |
| `@whiskeysockets/baileys` | `6.7.24` | WhatsApp Web adapter | **No** — adapter throws; dry-run clamp |
| Node `fs/promises` | built-in | Local image/proof/evidence storage | Yes |
| `sharp` (override) | `^0.35.5` | Image processing dependency | Indirect |

No Fonnte, Wablas, Twilio, SendGrid, Mailgun, Resend, Meta WhatsApp Cloud API or WhatsApp Business API client appears in `package.json` or source. A repository-wide search found no such integration.

---

## 5. Application scripts

From `package.json`:

| Script | Purpose |
|---|---|
| `npm run dev` | Next development server |
| `npm run build` / `start` | Production build / start |
| `npm run lint` | ESLint |
| `npm test` | Jest |
| `npm run test:db:setup` | Read-only verification of a separate `_test` database |
| `npm run worker:notifications` | Separate notification worker process |
| `npm run sweep:purchase-proof` | Operator recovery enqueue (no send) |
| `npm run sweep:ticket-issued` | Operator recovery enqueue (no send) |
| `npm run audit:ipaymu` | Manual provider audit script |
| `npm run seed:organizer` | Seed script |

There is **no** script for a document blast, no H-36 manual sweep script (it runs inside the tick), and no queue framework command.

---

## 6. Folder structure

```
app/                     Next.js App Router
  api/                   75 route handlers (see §7)
  dashboard/             authenticated back office (27 pages)
  events/, e/[slug]/     public catalog and event detail
  ticketing/             buyer orders and ticket wallet
  login/, register/      auth pages
components/              UI by domain (organizer, dashboard, ticketing, tickets…)
lib/
  authz/                 scope, guards, permission maps, PIC decider
  events/                access, lifecycle, catalog, validation, sales state
  ticketing/             checkout, orders, payment, tickets, check-in, refunds, settlement
  notifications/         config, templates, queue, worker, transports, features
  jobs/                  DB-leased tick scheduler
  images/                validation, EXIF stripping, storage
  dashboard/             scoped reporting queries
  pic/                   attribution, fees, payouts, reporting
  realtime/              SSE bus and audience
prisma/                  schema + 32 migration directories
scripts/                 operator/worker entry points
__tests__/               184 test files in 27 directories
docs/                    phase reports (this audit adds docs/audit/)
```

---

## 7. Routing and API architecture

- **App Router** file-system routing. Server Components fetch through service modules; API routes are thin adapters.
- **75 route handlers** under `app/api`, grouped as:
  - public catalog/event/share: `/api/events*`, `/api/sports`;
  - auth/register: `/api/auth/*`;
  - admin master data/settings/users: `/api/admin/*`;
  - organizer events, ticket types, check-in, venues, PIC, settlements, refunds, reports: `/api/organizer/*`;
  - buyer checkout/orders/tickets/refunds: `/api/ticketing/*`;
  - PIC payout and check-in: `/api/pic/*`;
  - reports: `/api/reports/*`;
  - machine: `/api/internal/jobs/tick`, `/api/health*`, `/api/realtime/stream`;
  - public image/branding: `/api/uploads/events/*`, `/api/uploads/branding/*`.
- **`proxy.ts`** (not `middleware.ts`) performs coarse authentication and public/protected classification at the Edge. It is auth-only by design; real authorization is in `lib/authz`.
- **`__tests__/authz/route-classification.test.ts`** enumerates every route and fails if a handler is unclassified.

No GraphQL, tRPC, separate backend service or API gateway exists.

---

## 8. Rendering and realtime

- Server Components by default; client components only for forms, scanner, charts, dialogs and realtime banners.
- Realtime uses **Server-Sent Events** at `GET /api/realtime/stream`; events are invalidation signals, not data payloads. Audience is derived server-side from the caller's scope (`lib/realtime/audience.ts`).
- No WebSocket server.

---

## 9. Deployment architecture (from source)

| Component | Evidence |
|---|---|
| Process manager | `ecosystem.config.cjs` (PM2) |
| App server | `next start`, loopback binding configured in PM2 |
| Reverse proxy | Runbook documents nginx/trusted proxy; `TRUSTED_PROXY` controls forwarded IP trust |
| Scheduler | External cron calls `POST /api/internal/jobs/tick` every minute |
| Notification worker | Separate `npm run worker:notifications` process; **not declared in PM2** |
| Files | Local `UPLOAD_DIR` (persistent VPS disk) |
| Database | External/co-located MySQL/MariaDB |
| Payments | iPaymu sandbox/production selected by `PAYMENT_ENVIRONMENT` |

**NOT FOUND:** Docker, Kubernetes, CI/CD pipeline definition, object storage (S3/GCS), Redis, BullMQ, and a hosted queue.

---

## 10. Technology risks

1. **Single-VPS assumptions are embedded.** Rate limiting is in-process; the scheduler relies on external cron; files are local disk. Horizontal scaling would require shared rate limit, shared storage and a real queue.
2. **Beta authentication dependency.** `next-auth@5.0.0-beta` is production-used; upgrades must be treated as breaking.
3. **Notification worker is not supervised by default.** If the operator does not start it, queued messages never progress.
4. **No database test environment in this session.** Framework versions are verified from the lock/package files, not from a running stack.
