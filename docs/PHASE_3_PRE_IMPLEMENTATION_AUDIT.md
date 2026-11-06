# PHASE 3 — PRE-IMPLEMENTATION SECURITY & ARCHITECTURE AUDIT
## PIC QR Scanning

**Repository:** `/home/reksa/tinggalklik`
**Branch:** `main`
**Expected / actual HEAD:** `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd`
**Audit type:** READ-ONLY. No source, schema, migration, database, environment, credential, staging, commit, push, provider or worker change was performed.
**Report status:** complete. Implementation of Phase 3 has NOT begun.

**Evidence labels used throughout** (per §10 of the brief):

- `VERIFIED FACT` — read directly from the file named, in this tree, at this HEAD.
- `INFERENCE` — a reasoned conclusion from verified facts; not itself observed.
- `RECOMMENDATION` — a proposal for the owner to accept or reject.
- `UNRESOLVED` — a question this audit cannot answer from the repository.

---

## 1. Executive summary

### 1.1 What exists today

`VERIFIED FACT` A complete, working organizer-side gate check-in already exists and is **not** the thing Phase 3 has to build. It consists of:

| Layer | Implementation |
|---|---|
| Service | `lib/ticketing/checkin/service.ts` — `checkInTicket`, `requireEventCheckInAccess`, `listEventCheckIns`, `normalizeCode` |
| Input contract | `lib/ticketing/checkin/validation.ts` — `checkInRequestSchema` (`.strict()`) |
| HTTP | `app/api/organizer/events/[id]/check-in/route.ts` (`GET` list, `POST` admit) |
| Hub UI | `app/dashboard/check-in/page.tsx` + `lib/dashboard/gates.ts#listCheckInGateEvents` |
| Scanner UI | `app/dashboard/events/[id]/check-in/page.tsx` + `components/organizer/TicketScanner.tsx` (camera via `BarcodeDetector`/`jsQR`, plus manual field) |
| Data | `Ticket` (status, `checkedInAt`, `qrTokenHash`, `qrVersion`), `CheckIn` (`ticketId @unique`), `CheckInResult`, `CheckInMethod` |
| Audit | `lib/ticketing/audit-log.ts` — `checkin.success`, `checkin.rejected` |

The gate is protected by: tenant-scoped `checkin.scan`, an event-level `StaffEventAssignment` requirement for members without `checkin.override`, the canonical `isEventCheckInOpen` time predicate, a `SELECT … FOR UPDATE` on the ticket row, a CAS `ISSUED → CHECKED_IN`, and a `UNIQUE` `CheckIn.ticketId`. Duplicate admission, wrong-event admission, refund-race admission and closed-gate admission are all already structurally blocked. `VERIFIED FACT` by reading the service; `VERIFIED FACT` by the existing static guard suite `__tests__/ticketing-checkin/check-in-wiring.test.ts`.

### 1.2 What Phase 3 actually has to decide

`VERIFIED FACT` Phase 3 as briefed is **not** an implementation gap — it is an **authorization-model gap plus an unresolved credential gap**:

1. **Authorization.** A PIC is a platform role with *no* organizer capability (`PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC` is empty, `MEMBERSHIP_ROLE_PERMISSIONS.PIC` holds only `pic_attribution.read.all`). The only PIC-scoped capability is an assignment row `PICEventAssignment(picProfileId, eventId, isActive, revokedAt)`. **No decider in `lib/authz` can answer "may this PIC scan at this event?"** — `decideOrganizerPermission` requires an ACTIVE `OrganizerMember`, which a PIC does not have; `decideOwnResourcePermission` compares `scope.userId === ownerUserId`, which cannot express an event.
2. **Credential.** `VERIFIED FACT` The wallet QR encodes `TICKET:<ticketCode>` — the **public lookup code**, not the 256-bit secret whose SHA-256 is `Ticket.qrTokenHash`. The service never reads `qrTokenHash` and records `CheckInMethod.MANUAL` only. Phase 3's stated goal "sistem memvalidasi **keaslian** tiket" is therefore **not met by the current credential**: any person can render a syntactically valid `TICKET:EVT-XXXX-XXXX` QR for any code they have seen. Authenticity today is enforced by *staff authorization*, not by the QR.

### 1.3 The uncommitted permission change

`VERIFIED FACT` `lib/authz/permissions.ts` is modified (+4 lines, unstaged): it adds `PIC_CHECKIN_SCAN_OWN: "pic.checkin.scan.own"`, puts it in `OWN_SCOPE`, and grants it in `PLATFORM_ROLE_OWN_PERMISSIONS.PIC`. `VERIFIED FACT` it has **no consumer anywhere** (repo-wide search: only the three lines in that file).

`VERIFIED FACT` That shape **cannot authorize event check-in even if a consumer were added**:

- `decideOrganizerPermission` explicitly denies ANY permission whose `PERMISSION_SCOPE` is `OWN` (`"requires a record ownership check, not a tenant check"`). So `requireEventAccess(eventId, PIC_CHECKIN_SCAN_OWN)` would always deny.
- `decideOwnResourcePermission` allows only when `scope.userId === ownerUserId`, and additionally requires the permission to be present in `PLATFORM_ROLE_OWN_PERMISSIONS[platformRole]`. Applied to this string, "ownership" would have to mean *the PIC owns the ticket*, which is the opposite of the intent.

**Conclusion (`INFERENCE`):** the change is currently **inert** (no consumer ⇒ no privilege escalation, no behavioural change) but **incorrect for its stated purpose**. It must not be committed as-is and must not be used as the basis of Phase 3.

### 1.4 Decision conflict that must be surfaced before any code

`VERIFIED FACT` `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §17 PIC Access records the design's §6.3 matrix as a **lock**, not a recommendation: `Scan / validate QR` = **PIC NO**, `Manual check-in override` = **PIC NO**, `View check-in log` = **PIC NO**, with the explicit instruction "Phase 15 must not pass a platform `PIC` or a membership `PIC` through the check-in guard. A future reversal would be a deliberate authz design change."

`VERIFIED FACT` `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md` records the owner's D-46 **Option A** approval — which *accepts* public ticket-code exposure for notifications — and explicitly notes that "The **public** code remains the admission credential accepted by the current manual check-in gate; D-46 Option A expressly accepts that exposure. It is a product/security acceptance, not a coding bug."

`INFERENCE` Phase 3 as briefed **reverses a locked decision** (PIC gate access) while **relying on an accepted downgrade** (public code as credential). Both are owner decisions. They cannot be resolved by an implementer, and implementing without resolving them would either (a) silently reverse the lock or (b) silently claim authenticity the credential does not provide.

### 1.5 Recommendation in one line

**CONDITIONAL GO** for Phase 3A (architecture + authorization contract only), **NO-GO** for Phase 3B–3G until the owner resolves three named blockers in §15. No exploitable vulnerability was found in the shipped organizer gate; the gaps are contract, credential and decision gaps.

---

## 2. Baseline Git verification

`VERIFIED FACT` — commands run read-only, output verbatim in substance:

```
git rev-parse --show-toplevel   → /home/reksa/tinggalklik
git rev-parse --abbrev-ref HEAD → main
git rev-parse HEAD              → d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd
git diff --cached --name-only   → (empty)
```

`git log --oneline -6`:

```
d0bb0e0 docs: record notification implementation and audits
dd6d32d feat: add dry-run purchase and ticket notifications
4da6dc5 chore: establish Phase 0B and 0C dependency baseline
89b6717 test: harden Jest database isolation
25cbf0c fix landing paaage
05bb474 revisi flow checkout
```

The four Phase 2 baseline commits are present, in order, on top of `25cbf0c`.

`git status --short`:

```
 M lib/authz/permissions.ts
?? .cloud-attachments/
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md
```

`git diff --stat` → `lib/authz/permissions.ts | 4 ++++`. That is the **entire** uncommitted delta: three working-tree items the brief requires preserved, plus one pre-existing modification. **No concurrent change requiring classification was found.** No file was read, written, staged or removed outside this report.

| Check | Expected | Actual | Result |
|---|---|---|---|
| Repository root | `/home/reksa/tinggalklik` | same | PASS |
| Branch | `main` | `main` | PASS |
| HEAD | `d0bb0e0…` | `d0bb0e0…` | PASS |
| Baseline commits | 4 | 4 | PASS |
| Staging area | empty | empty | PASS |
| `lib/authz/permissions.ts` preserved | `M` | `M`, unmodified | PASS |
| `.cloud-attachments/` preserved | untracked | untracked | PASS |
| `PROJECT_PRE_FEATURE_AUDIT_REPORT.md` preserved | untracked | untracked | PASS |
| `docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md` preserved | untracked | untracked | PASS |

---

## 3. Current architecture (verified)

### 3.1 Ticket issuance

`VERIFIED FACT` `lib/ticketing/tickets/issuance.ts#issueTicketsForOrder` (Phase 8) is the only writer that creates `Ticket` rows. Per order it: locks `eventorder` (`SELECT id FROM eventorder WHERE id = ? FOR UPDATE`), re-evaluates `assertOrderIsFulfillable` **after** the lock, diffs existing `(orderItemId, sequenceNo)` slots, and inserts the missing ones. Uniqueness is enforced by `@@unique([orderItemId, sequenceNo])`, `ticketCode @unique` and `qrTokenHash @unique`; a `P2002` naming the slot is adopted rather than retried, and a random collision is retried up to `TICKET_CODE_ATTEMPTS = 5`.

`VERIFIED FACT` Tickets are created as `status: "ISSUED"` with `issuedAt`, and `qrTokenHash: hashQrToken(generateQrToken())` — the raw token is never bound to a variable, returned, logged or delivered.

`VERIFIED FACT` `title`/`price` snapshots live on `EventOrderItem`; `Ticket` carries no money column.

### 3.2 Ticket database model

`VERIFIED FACT` `prisma/schema.prisma`, `model Ticket` (mapped `ticket`):

- Identity: `id` (cuid), `ticketCode String @unique`, `qrTokenHash String @unique`, `qrVersion Int @default(1)`.
- Ownership: `orderId`, `orderItemId`, `sequenceNo` (unique with `orderItemId`), `ticketTypeId`, **`eventId`**, **`organizerId`**, `holderUserId?`.
- Lifecycle: `status TicketStatus @default(RESERVED)`, `issuedAt?`, `checkedInAt?`, `refundedAt?`, `voidedAt?`, `voidReason?`.
- `checkIn CheckIn?` — a one-to-one from the `UNIQUE` side.

`model CheckIn` (mapped `checkin`): `ticketId String? @unique` (nullable so a *refused* scan can still be recorded), `eventId`, `organizerId`, `checkedInAt`, `checkedInByUserId`, `checkedInByMemberId?`, `method CheckInMethod`, `gateLabel?`, `deviceId?`, `clientScannedAt?`, `ipAddress?`, `result CheckInResult`, `note?`.

Relevant enums: `TicketStatus { RESERVED, ISSUED, CHECKED_IN, VOID, REFUNDED }`; `CheckInMethod { QR_SCAN, MANUAL }`; `CheckInResult { SUCCESS, DUPLICATE, ALREADY_CHECKED_IN, INVALID_TICKET, WRONG_EVENT, UNPAID, TICKET_NOT_FOUND, REFUND_PENDING }`.

### 3.3 QR token generation and hashing

`VERIFIED FACT` `lib/ticketing/tickets/reference.ts`:

- `generateTicketCode()` — `EVT-` + two groups of four characters drawn with `crypto.randomInt` from a 32-symbol Crockford-style alphabet (`23456789ABCDEFGHJKMNPQRSTVWXYZ`, no `0/O/1/I/L/U`). Entropy: **8 × log2(32) = 40 bits**.
- `generateQrToken()` — `crypto.randomBytes(32).toString("base64url")`. Entropy: **256 bits**.
- `hashQrToken(token)` — unsalted SHA-256, hex. Documented rationale: uniform 256-bit input, no dictionary, indexed lookup.
- `buildTicketQrPayload(code)` — `TICKET:<ticketCode>`, validates the code first.
- `assertQrPayloadIsSafe(payload)` — rejects anything that is not exactly a namespaced ticket code, and rejects `@ : + ? & # /`.
- `TICKET_QR_PREFIX = "TICKET:"`.

`VERIFIED FACT` `lib/ticketing/tickets/payload.ts#buildTicketDetail` exposes `qr: { payload, renderer: "qrcode.react", version }` to the **owning buyer only** (the route requires `holderUserId = session.user.id` plus `ticket.read.own`). `buildWalletItem` (the list) deliberately omits the QR.

### 3.4 QR validation

`VERIFIED FACT` **There is no token validation anywhere.** `lib/ticketing/checkin/service.ts` states this in its own header and the claim is correct against the code:

- `normalizeCode()` trims, strips an optional `TICKET:` prefix, upper-cases, and returns the value only if `isTicketCode()` passes. Anything else → `null` → `result: INVALID_TICKET` with `reason: "INVALID_TICKET_FORMAT"`, thrown as `AppError.notFound`.
- The ticket is resolved by `prisma.ticket.findUnique({ where: { ticketCode: code } })`.
- `hashQrToken` is imported by issuance only. The check-in module neither imports it nor selects `qrTokenHash` (pinned by the static guard `expect(service).not.toMatch(/hashQrToken/)`).

`VERIFIED FACT` `CHECK_IN_METHOD: CheckInMethod = "MANUAL"` is the only value written. The string `"QR_SCAN"` does not appear in the check-in service; `CheckInMethod.QR_SCAN` is a database value with **no writer**.

### 3.5 Ticket status lifecycle

`VERIFIED FACT` States reachable from code:

| From | To | Writer | Guard |
|---|---|---|---|
| (none) | `ISSUED` | `issuance.ts` | order `PAID` + not `fulfilmentBlockedAt`, inside transaction after order-row lock |
| `ISSUED` | `CHECKED_IN` | `checkin/service.ts` | `updateMany WHERE status='ISSUED' AND checkedInAt IS NULL` (CAS) |
| `ISSUED` | `REFUNDED` | refund settlement | CAS + ticket-row lock |
| `ISSUED` | `VOID` | (no writer found) | — |

`VERIFIED FACT` `RESERVED` and `VOID` are declared but **no Phase 8–21 writer produces them** (issuance writes `ISSUED` directly; the refund path writes `REFUNDED`). The check-in service still maps `RESERVED → UNPAID` and every other non-`CHECKED_IN` state → `INVALID_TICKET`, which is the correct fail-closed reading of an unreachable state.

`VERIFIED FACT` `Ticket.qrVersion` is read into the buyer's `qr.version` but **never incremented by any code path** (`ticket.reissue` has no implementation). Revocation today is therefore status-based only (`VOID`/`REFUNDED`/`CHECKED_IN` fail the CAS), not token-rotation-based.

### 3.6 Event ownership and PIC assignment

`VERIFIED FACT` `Event.organizerId` → `Organizer` (`Organizer.ownerUserId` → `User`). `OrganizerMember(organizerId, userId, role, status)` with `@@unique([organizerId, userId])`. `StaffEventAssignment(organizerMemberId, eventId, organizerId, revokedAt)` with `@@unique([organizerMemberId, eventId])` — the event-level bound for `CHECKIN_STAFF`.

`VERIFIED FACT` `PICEventAssignment` (`prisma/schema.prisma:1470` region) — `picProfileId`, `eventId`, `organizerId`, `feeRateBp?`, `feeTypeOverride?`, `assignedByUserId`, `assignedAt`, `revokedAt?`, `isActive Boolean @default(true)`, with `@@unique([picProfileId, eventId])` and indexes `[eventId, isActive]`, `[picProfileId, isActive]`, `[organizerId]`.

`VERIFIED FACT` `PICProfile.userId` is `@unique`, and `PICProfile.status` is `PENDING | ACTIVE | SUSPENDED | REJECTED`. A PIC therefore reaches an event through **two** rows: `PICProfile` (by `userId`) → `PICEventAssignment` (by `picProfileId` + `eventId`, `isActive`). There is **no** `OrganizerMember` in that chain.

### 3.7 Existing check-in logic and its authorization chain

`VERIFIED FACT` `requireEventCheckInAccess(eventId)`:

1. `requireEventAccess(eventId, PERMISSIONS.CHECKIN_SCAN)` → narrow `event.findUnique({ select: { id, organizerId } })` → `requireOrganizerAccess(organizerId, "checkin.scan")` → `auth()` session → `resolveAuthzScope(userId)` → `decideOrganizerPermission`.
   - No ACTIVE membership ⇒ `AuthzErrorCode.ORGANIZER_ACCESS_DENIED` ⇒ **HTTP 404** (`lib/authz/errors.ts#STATUS_BY_CODE`), so a foreign event id cannot confirm existence.
2. `prisma.organizerMember.findFirst({ organizerId, userId, status: "ACTIVE" })`.
3. `decideOrganizerPermission(scope, organizerId, PERMISSIONS.CHECKIN_OVERRIDE)`; when **not** privileged, an active `StaffEventAssignment` for this `eventId` is required, else `FORBIDDEN` with `details.reason = "NO_STAFF_ASSIGNMENT"`.

`VERIFIED FACT` Then `checkInTicket`: load the gate row (`status`, `endAt`, `archivedAt`, `cancelledAt`, `title`) → `isEventCheckInOpen(gate, now)` → `normalizeCode` → `findUnique({ ticketCode })` → `ticket.eventId !== gate.id` ⇒ `WRONG_EVENT` → transaction (see §6) → on success `publishTicketCheckedIn` + `writeTicketingAudit("checkin.success")`; every refusal writes a `CheckIn` row with `ticketId: null` plus a `checkin.rejected` audit row.

### 3.8 Existing audit logging

`VERIFIED FACT` `lib/ticketing/audit-log.ts#writeTicketingAudit` writes `AdminAuditLog` (fire-and-forget, errors logged not thrown) with: legacy `adminId` (real actor id, or `"SYSTEM"`/`"PROVIDER"` markers), `action`, `entityType`, `entityRef`, `description`, `actorType`, `actorUserId`, `actorRole`, `actorOrganizerId`, `organizerId`, optional `beforeState`/`afterState`/`reason`, and `ipAddress`/`userAgent` from the request. A `FORBIDDEN_METADATA_KEYS` filter drops `password`, `token`, `secret`, `qrToken`, `ktp`, `bankAccountNumber`, etc. `writeTicketingAuditInTx` is the throw-on-failure variant used by money paths.

`VERIFIED FACT` Check-in actions: `checkin.success` and `checkin.rejected`. There is deliberately no `checkin.override` action, and no action distinguishing a PIC scan from a staff scan.

### 3.9 Existing permission system

`VERIFIED FACT` Pure decision module `lib/authz/permissions.ts`:

- `PERMISSIONS` vocabulary → `PERMISSION_SCOPE: PLATFORM | ORGANIZER | OWN`, built from three lists.
- Capability sources: `PLATFORM_ROLE_PLATFORM_PERMISSIONS`, `PLATFORM_ROLE_ORGANIZER_PERMISSIONS`, `PLATFORM_ROLE_OWN_PERMISSIONS`, `MEMBERSHIP_ROLE_PERMISSIONS`.
- `ADMIN_GRANT_REQUIRED` — grants only ever satisfy these eight financial strings; a grant is **not** a general privilege channel.
- `ORGANIZER_SPANNING_PLATFORM_ROLES` is empty — a platform role reaches no tenant without an ACTIVE membership.
- Guards in `lib/authz/guards.ts` resolve the session (`auth()`) then the scope from the database (`resolveAuthzScope`), never from the request, and **throw** on deny.

`VERIFIED FACT` `scope.ts` re-resolves per request, returns `null` for a missing or `disabledAt` user, and documents a 60 s scope-staleness bound (`AUTHZ_SCOPE_TTL_MS`).

### 3.10 Existing API routes

`VERIFIED FACT` The only check-in HTTP surface is `app/api/organizer/events/[id]/check-in/route.ts`:

- `GET` → `requireAuth()` → `parseOrThrow(checkInListQuerySchema)` → `listEventCheckIns(id, limit)` (which requires `checkin.log.read`).
- `POST` → `requireSameOrigin(request)` (CSRF) → `requireAuth()` → strict body parse → `checkInTicket({ eventId: id, input, request })`.
- `proxy.ts:121-128` lists `/api/organizer/` in `PROTECTED_API_PREFIXES` (401 for no session) as defence in depth; the real control is the service guard.
- `VERIFIED FACT` No `/api/pic/**` check-in or scan route exists. No public ticket or QR route exists.

### 3.11 Existing admin / PIC UI

`VERIFIED FACT` Organizer side: `/dashboard/check-in` (hub) → `/dashboard/events/[id]/check-in` (scanner). `components/organizer/TicketScanner.tsx` (`"use client"`) runs a continuous camera loop, decodes with native `BarcodeDetector` or `jsQR`, sanitises the payload (strips control chars, trims, caps 128), throttles the same payload for `SAME_QR_COOLDOWN_MS = 1500`, and POSTs `{ code, gateLabel }` to the existing route. It also offers a manual code field and a diagnostics panel that never shows the payload.

`VERIFIED FACT` PIC side: `/dashboard/pic`, `/dashboard/pic/[id]`, `/dashboard/pic/orders/[orderNumber]`, and `/api/pic/payouts`. **No PIC scan page, no PIC check-in endpoint, no `checkin.*` capability in any PIC map.**

`VERIFIED FACT` `lib/ui/route-inventory.ts` is a code-level table (40 pages) checked against the filesystem by `__tests__/ui-consolidation/route-inventory.test.ts`; any new page must be added there or that test fails.

### 3.12 Existing transaction and locking strategy

`VERIFIED FACT` Row locks are raw SQL inside interactive transactions (Prisma has no locking read):

| Path | Lock order |
|---|---|
| Ticket issuance | `eventorder` → inserts |
| Payment claim / refund execute / refund settle | `eventorder` (first) → tickets / refund / ledger |
| Refund request (`lib/ticketing/refunds/service.ts:236-241`) | `ticket` rows `WHERE id IN (…) ORDER BY id FOR UPDATE` |
| Check-in (`checkin/service.ts`) | `ticket` row only |
| Event lifecycle transitions | conditional `updateMany` (CAS), no lock |
| Job tick | `joblock` lease row |

`VERIFIED FACT` `PHASE_20B_FINAL_CROSS_VERTICAL_AUDIT.md` records invariant 15 as "Check-in / refund mutual exclusion — ticket-row `FOR UPDATE` in both writers + `OPEN_REFUND_STATUSES`", marked VERIFIED. The check-in side of that pairing is visible in the service; the refund side is visible at `lib/ticketing/refunds/service.ts:236-241`.

`INFERENCE` The lock graph is acyclic under the current writers: refund takes `eventorder` then `ticket`; check-in takes `ticket` only and then inserts (`checkIn.create`) without touching `eventorder`. Nothing takes `ticket` before `eventorder` in a way that could close a cycle with refund.

---

## 4. PIC permission analysis

### 4.1 The exact uncommitted diff

`VERIFIED FACT` `git diff -- lib/authz/permissions.ts` (4 insertions, 0 deletions):

```diff
@@ PERMISSIONS (after CHECKIN_LOG_READ)
+    /** PIC scan authority is limited to events with an active PIC assignment. */
+    PIC_CHECKIN_SCAN_OWN: "pic.checkin.scan.own",
@@ OWN_SCOPE
+    P.PIC_CHECKIN_SCAN_OWN,
@@ PLATFORM_ROLE_OWN_PERMISSIONS.PIC
+        P.PIC_CHECKIN_SCAN_OWN,
```

Nothing else in the file changed. `lib/authz/scope.ts`, `guards.ts`, `errors.ts`, `lib/events/access.ts` and the check-in service are **unmodified**.

### 4.2 Role and scope classification as written

| Question | Answer | Evidence |
|---|---|---|
| Declared permission string | `pic.checkin.scan.own` | `permissions.ts:212` |
| `PERMISSION_SCOPE` | **`OWN`** | `permissions.ts:328` (member of `OWN_SCOPE`) |
| Held by | `PLATFORM_ROLE_OWN_PERMISSIONS.PIC` only | `permissions.ts:664` |
| Held by ADMIN / MANAGER / CUSTOMER (own-scope) | **No** | the three other own-scope maps do not list it |
| Held by any `OrganizerMemberRole` | **No** | absent from every `MEMBERSHIP_ROLE_PERMISSIONS` entry |
| Held by any platform role at *organizer* scope | **No** | absent from `PLATFORM_ROLE_ORGANIZER_PERMISSIONS` |
| `ADMIN_GRANT_REQUIRED` (grant-able)? | **No** | not in the eight-string grant set |
| Has a consumer? | **No** | repo-wide search returns only the three lines above |

### 4.3 Can it actually authorize a scan?

`VERIFIED FACT` No. Three independent walls, each sufficient on its own:

1. **Wrong scope kind for the call site.** The only check-in guard is
   `requireEventAccess(eventId, PERMISSIONS.CHECKIN_SCAN)` → `requireOrganizerAccess` →
   `decideOrganizerPermission`. That function contains:
   `if (kind === "OWN") return deny(FORBIDDEN, '"…" requires a record ownership check, not a tenant check')`.
   Passing `pic.checkin.scan.own` there is a guaranteed deny, for every role.
2. **Wrong predicate for an event.** `decideOwnResourcePermission` allows only when
   `scope.userId === ownerUserId`, where `ownerUserId` is the *owning user of a record*.
   A check-in decision is about an **event**, and a PIC is not the owner of the ticket,
   the event, or the organizer. There is no `ownerUserId` value that makes
   "may I scan at event X?" true, because the *assignment* is the fact that matters and
   the own-scope API cannot receive it.
3. **No authority source.** Even if the scope kind were changed to `ORGANIZER`, the
   permission is absent from `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC` (empty set) and
   from `MEMBERSHIP_ROLE_PERMISSIONS.PIC` (only `pic_attribution.read.all`); and
   `decideOrganizerPermission` requires an ACTIVE `OrganizerMember`, which a PIC does not
   have by design (`TICKETING_PHASE1_DESIGN.md`: "PIC is **not** a membership role").

`INFERENCE` The change is therefore an **unfinished first attempt**, consistent with the
pre-Phase-2 audit note ("likely incomplete PIC QR-scanner work"). It is **inert** — no
code reads it, so it grants nothing today — but it is also **not a foundation**: keeping
it would encode a scope classification that Phase 3 must then reverse.

### 4.4 Can a PIC reach another PIC's event today?

`VERIFIED FACT` A PIC cannot check in **anywhere**. Measured against real data, the paths
are:

| Actor | `checkin.scan` in the event's organizer? | `StaffEventAssignment`? | Outcome |
|---|---|---|---|
| Platform `PIC` + `PICProfile ACTIVE` + `PICEventAssignment` for **this** event | No (no membership) | No | **404** at `requireOrganizerAccess` |
| Platform `PIC` + `PICEventAssignment` for **another** event | No | No | **404** — the same answer, so no probing signal |
| `PIC` also holding an `OrganizerMember` row with role `CHECKIN_STAFF` | Yes | Required | Allowed **for assigned events only** |
| `PIC` also holding an `OrganizerMember` row with role `OWNER`/`MANAGER` | Yes | Not required (`checkin.override`) | Allowed for **every** event in that organizer |

`INFERENCE` The second row is the important one for Phase 3: cross-PIC isolation exists
*today only by absence of capability*. The moment a PIC-aware guard is introduced, that
isolation has to be built explicitly from `PICEventAssignment` — nothing in the existing
chain proves it.

### 4.5 Admin / superadmin

`VERIFIED FACT` There is no superadmin tier (`D-05`: single organizer; `PlatformRole` is
`CUSTOMER | ADMIN | MANAGER | PIC`). `ADMIN` holds `checkin.scan`, `checkin.override` and
`checkin.log.read` **inside a tenant it is an ACTIVE member of**
(`PLATFORM_ROLE_ORGANIZER_PERMISSIONS.ADMIN`), and `MANAGER` holds the same three.
`ORGANIZER_SPANNING_PLATFORM_ROLES` is empty, so a platform ADMIN with **no** membership
row gets 404 on the gate — by design, not by omission.

`INFERENCE` Any PIC-scanning design must keep ADMIN/MANAGER reachable through exactly
their existing path (membership + capability), and must **not** route them through the
new PIC assignment check, or an operator would lose gate access the moment a PIC
assignment is absent.

### 4.6 Is the permission change necessary for Phase 3, or separate work?

`RECOMMENDATION` — **separate it, and do not commit it as-is.**

- **As written it is not useful** (§4.3), so committing it would add a permission string
  that permanently denies, and a future reader would reasonably assume PIC scanning is
  "implemented but unused".
- **Its scope classification is the opposite of what Phase 3 needs.** A PIC scan is
  authorized by an *event assignment*, i.e. a **resource-scoped** decision with a fourth
  predicate (`PICProfile.userId = actor` **and** `PICEventAssignment(eventId).isActive`
  **and** `PICProfile.status = ACTIVE`), not by record ownership.
- **The product decision it presupposes is locked the other way** (§1.4). Committing it
  would silently pre-approve a reversal of the §6.3 matrix.

Concretely (`RECOMMENDATION`): leave the modification in the working tree untouched until
the owner decides; if Phase 3 is approved, **replace** it in Phase 3A with a correctly
classified capability rather than extending it.

---

## 5. QR security findings

The ten questions from the brief, answered from code. No raw token, code or credential is
reproduced in this report.

### Q1. Does the QR contain the raw token or the public ticket code?

`VERIFIED FACT` **The public ticket code.** `buildTicketQrPayload()` returns
`"TICKET:" + ticketCode`, and `TicketScanner` posts that string straight to the gate,
where `normalizeCode()` strips the prefix and resolves `findUnique({ ticketCode })`.
The 256-bit `qrToken` is never placed in any payload, page, email, audit row or log.

`INFERENCE` The QR is therefore **not a credential**. It is a pointer to a row. Its only
security property is that the code is hard to *guess* (40 bits) — not that holding it
proves anything.

### Q2. Is the raw scanner token stored in the database?

`VERIFIED FACT` **No.** Only `Ticket.qrTokenHash` (unsalted SHA-256, hex) is persisted.
The plaintext is generated inside a single expression
(`qrTokenHash: hashQrToken(generateQrToken())`), never assigned to a variable, and never
returned by any query.

### Q3. Does the database store only the hash?

`VERIFIED FACT` **Yes**, for the secret. But note the consequence: because the raw token
is not retained anywhere and is not delivered to any client, it is currently
**unrecoverable** — not even the issuing server can present it again. Phase 3 cannot
"switch on token scanning" without a delivery decision, because there is nothing to present.

### Q4. Is the entropy sufficient?

`VERIFIED FACT` Secret token: 256 bits (`crypto.randomBytes(32)`) — ample.
Public code: **40 bits** (8 characters × 5 bits from `crypto.randomInt` over a 32-symbol
alphabet) — adequate as an *identifier*, **weak as a secret**: 2^40 ≈ 1.1 × 10^12, i.e.
enumerable in principle by a determined authenticated attacker with no rate limit.

`INFERENCE` No practical brute-force attack exists today (≈10^12 authenticated requests
against a single event's code space, each writing an audit row), but the margin is entirely
dependent on the *absence* of a faster path — see §14 R-03.

### Q5. Can the token be guessed or forged?

| Attack | Result | Evidence |
|---|---|---|
| Guess a secret token | `VERIFIED FACT` not applicable — nothing accepts it | no reader of `qrTokenHash` |
| Forge a wallet QR | `VERIFIED FACT` **trivially possible** — any QR app can encode `TICKET:<eight valid characters>` | format-only validation |
| Use a forged QR | `VERIFIED FACT` **only with staff authority at the matching event**, and only against a live ticket | `requireEventCheckInAccess` + `eventId` match + CAS |
| Guess a ticket code | `VERIFIED FACT` 40-bit space, format-checked, malformed ≡ unknown | `normalizeCode` → same `NOT_FOUND` |

`INFERENCE` "Forgery" here means forging the *payload*, which is worthless without a
valid ticket behind it and staff authority in front of it. The genuine risk is not
forgery of a code — it is **replay of a real code by a different person**, which the
system cannot detect at all (see Q6 and §14 R-01).

### Q6. Can the token be reused?

- Same ticket, twice: `VERIFIED FACT` **no.** The CAS `WHERE status='ISSUED' AND checkedInAt IS NULL` and `CheckIn.ticketId @unique` make a second admission impossible; the loser gets `ALREADY_CHECKED_IN` with the first admission's timestamp and staff.
- Same **code** by a different holder: `VERIFIED FACT` **yes, until the first successful scan.** The QR carries no holder binding; whoever holds the code first can be admitted. Two people holding the same screenshot is resolved by the database (first scan wins), not by identity.
- After `VOID`/`REFUNDED`: `VERIFIED FACT` **no** — the CAS requires `ISSUED`.
- After `CHECKED_IN`: `VERIFIED FACT` **no** for admission; the code still resolves (the ticket is disclosed as already used, with time and staff name).

### Q7. Can a QR be used at another event?

`VERIFIED FACT` **No.** `checkInTicket` compares `ticket.eventId` with the route's event and
refuses `WRONG_EVENT` **before** the transaction. The refusal deliberately does not name
the ticket's real event, so a scanner cannot use the error to map another event.

### Q8. Is there expiry or revocation?

| Control | Status | Evidence |
|---|---|---|
| `qrToken` expiry | `VERIFIED FACT` none — no column, no TTL | schema |
| `qrVersion` rotation | `VERIFIED FACT` column exists, **never incremented** | no writer; `ticket.reissue` unimplemented |
| Ticket revocation | `VERIFIED FACT` **yes**, by status (`VOID` / `REFUNDED` / `CHECKED_IN` all fail the CAS) | `checkin/service.ts` |
| Refund-in-flight claim | `VERIFIED FACT` **yes**, `OPEN_REFUND_STATUSES = [PENDING, APPROVED, PROCESSING]` → `REFUND_PENDING` | `checkin/service.ts` |
| Event window | `VERIFIED FACT` **yes**, `isEventCheckInOpen` (fail-closed on `cancelledAt`/`archivedAt`, closes at `endAt + 30 min`) | `lib/events/sales-state.ts` |
| Ticket-code expiry | `VERIFIED FACT` none. A code is valid for the ticket's lifetime. | — |

`INFERENCE` Revocation is **status-based and therefore sufficient**: revoking the ticket
revokes its QR, because the QR is only a lookup. This is the one place where the
"downgrade" to a public code is actually *stronger* than a signed token — a stateless
signature could not be revoked without rotating a shared secret.

### Q9. Do error responses leak sensitive information?

`VERIFIED FACT` — audited response shapes:

| Case | Body | Leak assessment |
|---|---|---|
| Malformed code | `404` `"Tiket tidak ditemukan."` | identical to unknown code — no oracle |
| Unknown but well-formed code | `404` `"Tiket tidak ditemukan."` | same |
| Wrong event | `409` + `details.reason = "WRONG_EVENT"` | reveals **that** it is a real ticket for some other event, but not which event, nor whose |
| Already used | `409` `TICKET_ALREADY_CHECKED_IN` + `ticketCode`, `firstCheckedInAt`, `firstCheckedInBy` (staff **name**), `firstGateLabel` | discloses the staff member's name to the scanning actor — acceptable for gate staff, but it is a PII disclosure a PIC-scoped surface would widen |
| Not issued | `409` + `details.status` | discloses ticket status only |
| Gate closed | `409` + `details.status` | discloses event status |
| Unauthorized | `404` (`ORGANIZER_ACCESS_DENIED`) | tenant existence is not confirmed |

`INFERENCE` No ticket code, no attendee email/phone, no `qrTokenHash`, no organizer id and
no ticket id is returned by the check-in endpoint. The one genuinely new disclosure a PIC
surface would create is `firstCheckedInBy` (another organizer's staff name) — see §14 R-05.

### Q10. Can the token appear in logs?

`VERIFIED FACT` Two channels were checked:

1. **Application logs.** The check-in path logs only on a failed refusal insert
   (`console.error("CHECKIN_REJECTED_RECORD_ERROR:", error)`), which carries a Prisma
   error, not the presented code. `lib/authz/errors.ts` logs `err.detail`, which contains
   permission names and organizer ids — never a code.
2. **Database.** `CheckIn.note` **does** receive the presented code for several refusal
   kinds (`TICKET_NOT_FOUND`, `WRONG_EVENT`, `ALREADY_CHECKED_IN`, `TICKET_NOT_ISSUED`,
   `REFUND_PENDING`), and `AdminAuditLog.entityRef` receives it too
   (`entityRef: input.note` in the `refuse()` helper). `Ticket.ticketCode` itself is
   recorded on `checkin.success` (`entityRef: ticket.ticketCode`).

`INFERENCE` This is **not** a secret leak in the D-46 Option A sense — the code is
public by product decision, and the audit trail needs it to be useful. It *would* become a
secret leak the day a real scanner token is introduced, because the same helper would
then be writing a secret into `note`/`entityRef`. **Phase 3 must not reuse `refuse()` for
a token-bearing path without changing what it stores.** See §14 R-02.

### 5.1 QR security summary

| Property | Present? |
|---|---|
| QR carries a bearer secret | **No** — carries the public code |
| Secret at rest | SHA-256 only, never plaintext |
| Secret ever delivered | **No** — unrecoverable |
| Sufficient entropy (as identifier) | Yes (40 bits) |
| Forgery of payload possible | Yes, but worthless without a live ticket + staff authority |
| Replay of a real code by another person | **Undetectable before first scan** |
| Reuse after admission | Blocked (CAS + UNIQUE) |
| Cross-event use | Blocked (`WRONG_EVENT`) |
| Expiry | Event-window and ticket-status only |
| Revocation | Yes, per ticket, via status |
| Sensitive data in errors | No code/hash/PII; staff name on duplicate |
| Secret in logs | No secret exists to log; public codes are recorded in audit |

---

## 6. Check-in transaction analysis

### 6.1 The transaction as written

`VERIFIED FACT` `checkInTicket` runs one interactive transaction
(`prisma.$transaction(async (tx) => …, { timeout: 15_000 })`) with exactly this order:

1. `tx.$queryRaw\`SELECT id FROM ticket WHERE id = ${ticket.id} FOR UPDATE\`` — serialization point.
2. `tx.refundItem.findFirst({ where: { ticketId, refund: { status: { in: OPEN_REFUND_STATUSES } } } })` — the open-refund guard, read **after** the lock.
3. `tx.ticket.updateMany({ where: { id, status: "ISSUED", checkedInAt: null }, data: { status: "CHECKED_IN", checkedInAt: now } })` — the CAS.
4. `cas.count !== 1` ⇒ re-read the fresh row inside the transaction and return `STATE` (no rollback needed; nothing was written).
5. `tx.checkIn.create({ ticketId, …, result: "SUCCESS" })` — the accepted evidence, same transaction.

Refusals are recorded **outside** the transaction (`recordRejectedAttempt`) and then thrown.

### 6.2 Does it prevent each listed failure?

| Threat | Prevented? | Mechanism | Residual risk |
|---|---|---|---|
| Double check-in | **Yes** `VERIFIED FACT` | CAS (`status='ISSUED' AND checkedInAt IS NULL`) + `CheckIn.ticketId @unique` | none found |
| Two scanners, same ticket, simultaneously | **Yes** `VERIFIED FACT` | `FOR UPDATE` serializes; the second transaction re-reads committed state and its CAS affects 0 rows | none found |
| Check-in racing a refund | **Yes** `VERIFIED FACT` | both writers take `FOR UPDATE` on the ticket row; the guard is read after the lock | none found; covered by a real-DB race suite |
| Check-in of a `CANCELLED` ticket status | `VERIFIED FACT` there is no `CANCELLED` `TicketStatus`; cancellation is an **order/event** concept | order cancellation is refused once tickets exist; event cancellation closes the gate | see R-06 (order cancelled after issuance) |
| Check-in of a `VOID` ticket | **Yes** `VERIFIED FACT` | CAS requires `ISSUED` | — |
| Check-in of a `REFUNDED` ticket | **Yes** `VERIFIED FACT` | CAS requires `ISSUED` | — |
| Check-in at the wrong event | **Yes** `VERIFIED FACT` | `ticket.eventId !== gate.id` ⇒ `WRONG_EVENT` before the transaction | — |
| PIC accessing an event outside its scope | **Yes, vacuously** `INFERENCE` | PIC has no gate capability at all | **the isolation has never been tested because the capability does not exist** — §4.4 |
| Replay of the request | **Yes (semantically)** `VERIFIED FACT` | the CAS is the idempotency: a replay returns `ALREADY_CHECKED_IN` | see 6.4 |
| Manipulation of order/ticket id | **Yes** `VERIFIED FACT` | the body schema is `.strict()` and has no `ticketId`/`orderId`/`status`/`eventId`/`organizerId`; the ticket is resolved **from the code**, never from a client id | — |
| Guessing a code | **Not rate-limited** `VERIFIED FACT` | 40-bit space + `NOT_FOUND` masking | no `rateLimit` on this route (see R-03) |
| Forged `clientScannedAt` | `VERIFIED FACT` records it, never decides with it | `CheckIn.checkedInAt` is the server clock (`now`) | none |
| Gate label / device id injection | `VERIFIED FACT` bounded (60 / 120 chars), stored as text | — | none |

### 6.3 What the operation requires (brief §6, second half)

| Requirement | Needed? | Status |
|---|---|---|
| Atomic database transaction | **Yes** | `VERIFIED FACT` present |
| Conditional update (CAS) | **Yes** | `VERIFIED FACT` present |
| Row locking | **Yes** | `VERIFIED FACT` present (`FOR UPDATE` on the ticket) |
| Unique constraint | **Yes** | `VERIFIED FACT` present (`CheckIn.ticketId @unique`) |
| Idempotency key | **No, not for this operation** | `RECOMMENDATION`: the CAS is a *state* idempotency, which is stronger than a request key here — a request key would let two different scanners with two different keys both attempt, which the CAS already refuses. Adding one would add a column and a table for no new guarantee. Keep as-is. |
| Schema change | **No** for the admission itself | `VERIFIED FACT` `CheckInMethod.QR_SCAN` already exists |

### 6.4 The one real weakness in the transaction: refusal records are outside it

`VERIFIED FACT` `recordRejectedAttempt` uses the global `prisma` client (not `tx`) and
wraps its insert in `try/catch` + `console.error`. So:

- a refused scan's `CheckIn` row is **not** part of any transaction and may be lost under
  an error, while the audit row (`writeTicketingAudit`, also fire-and-forget with a
  swallowed error) may independently be lost;
- `writeTicketingAudit` is called **after** the refusal row and its failure is silent, so
  "every scan writes a row" (design §20.3) is **best-effort, not guaranteed** for refusals.

`INFERENCE` This is acceptable for accepted admissions (which *are* transactional) and a
real gap for the audit claim. Phase 3F must decide whether a rejected scan is evidence
that must be durable. If yes, the fix is `writeTicketingAuditInTx`-style throw semantics in
the same transaction as the refusal row — a code change in `lib/ticketing/checkin/service.ts`
only, no schema change.

### 6.5 Unbounded refusal rows

`VERIFIED FACT` There is no cap and no rate limit: a script with a `CHECKIN_STAFF` session
can create one `CheckIn` row plus one `AdminAuditLog` row per request, indefinitely, at a
closed or open gate (a closed gate refuses early but still records).
`INFERENCE` Availability/abuse issue, not a confidentiality issue. See R-03.

---

## 7. Database impact

### 7.1 What Phase 3 can reuse with **no schema change**

| Need | Existing column | Note |
|---|---|---|
| Record a QR scan as such | `CheckInMethod.QR_SCAN` | enum value already migrated; currently unused |
| Attribute the acting user | `CheckIn.checkedInByUserId` (NOT NULL) | a PIC can be recorded here today |
| Attribute an organizer seat | `CheckIn.checkedInByMemberId` (nullable) | **NULL for a PIC** — a PIC has no `OrganizerMember` |
| Record the gate/device/ip/time | `gateLabel`, `deviceId`, `clientScannedAt`, `ipAddress`, `checkedInAt` | sufficient |
| Record the outcome | `CheckInResult` (8 values) | sufficient |
| Record which PIC scanned | `AdminAuditLog.afterState` JSON, or `CheckIn.note` | **works, but is not queryable/indexed** |
| Hygiene for a PIC assignment | `PICEventAssignment.isActive` + `revokedAt` | sufficient |

`INFERENCE` The only durable, *indexed* answer to "which PIC admitted this attendee?" would
require a new nullable column on `CheckIn` (e.g. `checkedInByPicProfileId` + FK + index).
That is **additive and backfill-free**, but it is a migration — which this audit is
forbidden to create and which the owner has not approved.

### 7.2 What Phase 3 must **not** change

`RECOMMENDATION`

- `Ticket.qrTokenHash` / `qrVersion`: no change without a token decision.
- `CheckIn.ticketId @unique`: **the** duplicate guarantee. Never relaxed, never made
  composite with an event id.
- `TicketStatus` / `CheckInResult` / `CheckInMethod` values: an enum `ALTER` on MariaDB is a
  destructive migration; nothing in Phase 3 needs a new value.
- `PICEventAssignment` shape: the `@@unique([picProfileId, eventId])` and `isActive`/`revokedAt`
  pair is what makes cross-PIC isolation provable; do not add a "canScan" boolean that can
  drift from `isActive`.

### 7.3 Migration budget

| Subphase | Migration required? |
|---|---|
| 3A Architecture / authorization contract | **No** |
| 3B Secure QR validation (reuse code path, label method) | **No** |
| 3C Atomic check-in / concurrency | **No** (already implemented) |
| 3D PIC scanner API | **No** |
| 3E PIC scanner UI | **No** |
| 3F Audit trail hardening | **No** for transactionality; **optional** additive column for PIC attribution |
| 3G Tests | **No** |

`INFERENCE` Phase 3 is a **code-only** phase under every option except the optional PIC
attribution column. That is a significant de-risking finding: no data migration, no
backfill, no enum change.

---

## 8. API design

### 8.1 The choice

`RECOMMENDATION` — **extend the existing endpoint; do not create a second check-in writer.**

| Option | Verdict |
|---|---|
| A. Reuse `POST /api/organizer/events/[id]/check-in`, generalize the guard | **RECOMMENDED** |
| B. New `POST /api/pic/events/[id]/check-in` delegating to the same service function | acceptable variant of A |
| C. New route with its own transaction/CAS | **rejected** |

Why A: the CAS, the refund guard, the `FOR UPDATE`, the event match, the refusal recording
and the audit rows all live in one function. A second route that re-implemented any of them
would give Phase 3 two admission paths that can drift — exactly the failure mode the
project has avoided everywhere else (one predicate, one writer).

`INFERENCE` Option A also means the PIC scanner UI can reuse the **entire** existing
client component (`TicketScanner`), which already handles camera capability, `jsQR`
fallback, throttling, diagnostics, manual fallback and result classification.

### 8.2 Proposed contract (unchanged request, extended response)

```
POST /api/organizer/events/{eventId}/check-in
Content-Type: application/json
X-Requested-With / Origin: same-origin (requireSameOrigin)

{ "code": "TICKET:EVT-XXXX-XXXX" | "EVT-XXXX-XXXX",
  "gateLabel"?: string(≤60) | "" | null,
  "deviceId"?: string(≤120) | "" | null,
  "clientScannedAt"?: ISO-8601 | "" | null }

200 { success: true, data: { result: "SUCCESS",
      event: { id, title },
      ticket: { ticketCode, attendeeName, status: "CHECKED_IN" },
      ticketType: { name }, method: "MANUAL" | "QR_SCAN",
      gateLabel, checkedInAt } }
409 TICKET_ALREADY_CHECKED_IN  { details: { ticketCode, firstCheckedInAt, firstCheckedInBy, firstGateLabel } }
409 { reason: "REFUND_PENDING" | "WRONG_EVENT" | "TICKET_NOT_ISSUED" }
404 (unknown or malformed code — indistinguishable)
403 { reason: "NO_STAFF_ASSIGNMENT" | "NO_PIC_ASSIGNMENT" }
404 (no access to this event's tenant — never confirms existence)
```

`RECOMMENDATION` — request body **must not** grow a `method` field. The server decides
`MANUAL` vs `QR_SCAN`; a client-supplied method would be a claim, not a fact, and would let
a caller make an audit trail say "QR" when nothing was decoded. This matches the existing
schema's `.strict()` discipline and its documented rationale.

### 8.3 Authorization contract (the actual Phase 3A deliverable)

`RECOMMENDATION` — a **fourth decider**, not a widened existing one:

```ts
// lib/authz/pic-assignment.ts (proposed name; pure decision + one DB read)
decidePicEventPermission(scope, eventId, permission)
  requires: permission ∈ PIC_ASSIGNMENT_SCOPE
  requires: scope.platformRole === "PIC"
  reads:    PICProfile where userId = scope.userId
            and status = "ACTIVE"
            and (suspendedAt is null)
  reads:    PICEventAssignment where picProfileId = profile.id
            and eventId = <event> and isActive = true and revokedAt is null
  allows only if ALL hold; otherwise denies with 404-style reason
```

Properties this must have (`RECOMMENDATION`, each a test in 3G):

1. **Never consult the request body** for `eventId`, `picProfileId` or `userId`.
2. **Never widen** when the actor also holds an `OrganizerMember` row — the organizer path
   stays the organizer path.
3. **Deny on `SUSPENDED`/`REJECTED` `PICProfile`**, and on `isActive = false` **or** a
   non-null `revokedAt` (both must be checked; the schema can hold them out of sync).
4. **Cross-PIC**: a PIC assigned to event A asking for event B gets the same answer as a
   PIC assigned to nothing — never a signal that B exists.
5. **ADMIN/MANAGER unaffected**: they continue to authorize through membership.

`UNRESOLVED` Whether the guard should be reached through the `/api/organizer/**` prefix
(which a PIC can call but which the proxy classifies as organizer traffic) or a new
`/api/pic/**` prefix. The authorization is identical either way; only routing hygiene and
proxy classification differ. Recommend a new `/api/pic/events/[id]/check-in` **thin
re-export** of the same service call if the owner prefers clear namespacing — with a
static guard asserting it contains no transaction, no CAS and no `prisma.ticket.updateMany`.

### 8.4 Response hardening for the PIC surface

`RECOMMENDATION` On a PIC-authorized admission, omit `firstCheckedInBy` (another
organizer's staff name) or reduce it to a non-identifying token. This is the only new
disclosure a PIC surface creates (§5 Q9).

### 8.5 Rate limiting

`VERIFIED FACT` `lib/rate-limit.ts` exists and is used by `/api/auth/register`,
`/api/admin/settings/branding` and `/api/organizer/events/[id]/images` — **not** by the
check-in route.

`RECOMMENDATION` Phase 3D adds a per-actor limit on the check-in `POST` (e.g. a burst
allowance sized for a real gate, not a per-second one). Rationale: it bounds refusal-row
inflation (§6.5) and the code-space probing rate (§5 Q4) without touching the admission
semantics. Any limit must be generous enough that a busy door is never throttled.

---

## 9. UI design

### 9.1 What exists and can be reused

`VERIFIED FACT` `components/organizer/TicketScanner.tsx` is already exactly the device a
PIC needs: continuous camera, two decoders, throttle, network backoff, manual field, and
a result classifier (`scanFeedbackFor`) that reads the server's own `code`/`details.reason`
instead of deciding validity locally. It posts to a route URL built from `eventId` only.

`INFERENCE` A PIC scanner page is therefore a **page + a prop**, not a new component: the
only client change needed is the endpoint it posts to (if a PIC-specific route is chosen)
and the suppression of the attendance list when `checkin.log.read` is absent (already a
prop: `canReadLog`).

### 9.2 The missing PIC entry point

`VERIFIED FACT` `lib/dashboard/gates.ts#listCheckInGateEvents` resolves events with
`organizerIdsWith(scope, PERMISSIONS.CHECKIN_SCAN)`. For a PIC that set is **empty**, so
`/dashboard/check-in` renders "no events accepting check-in" — correct today, and the
exact thing Phase 3E changes.

`RECOMMENDATION` — a PIC-specific hub resolver, not a widened one:

```
/dashboard/pic/scan            → events where an ACTIVE PICEventAssignment exists,
                                 PICProfile ACTIVE, and isEventCheckInOpen(event, now)
/dashboard/pic/scan/[eventId]  → the existing scanner, with canReadLog = false
```

Properties (`RECOMMENDATION`, each testable):

1. The list is derived from `PICProfile.userId = session user`, never from a query param.
2. The page **re-authorizes** with the same decider the API uses (`decidePicEventPermission`)
   so a hand-typed event id yields the same refusal as a forged API call.
3. `checkin.log.read` is **not** granted to PIC (design §6.3); `canReadLog = false`, and the
   page must not render a name list. A PIC may see the result of its own scan (the success
   payload) — that is the scan, not the log.
4. The gate window comes from the server (`isEventCheckInOpen`), never the browser clock.
5. `lib/ui/route-inventory.ts` gains the new routes, or
   `__tests__/ui-consolidation/route-inventory.test.ts` fails.

### 9.3 What the UI must not do

`RECOMMENDATION`

- No client-side validity verdict (already true: `scanFeedbackFor` only classifies server codes).
- No persistence of the payload (`localStorage`/`sessionStorage`) — already satisfied and
  documented in the component; must stay true.
- No QR **display** for the PIC; a PIC is not a buyer surface.
- No "override" or "force admit" control. `checkin.override` is not a PIC capability and
  Phase 3 must not add a UI affordance for a capability the decider refuses.
- No offline mode. Design §19.6 lists it post-MVP; a cached manifest would need a
  `qrTokenHash`-equivalent and is explicitly out of scope.

---

## 10. Race condition analysis

### 10.1 The full interleaving matrix

Rows are the pair of concurrent operations; the cell is the outcome the **database**
decides (not application memory).

| # | Operation A | Operation B | Serialized on | Outcome | Evidence |
|---|---|---|---|---|---|
| 1 | check-in ticket T | check-in ticket T | `ticket` row `FOR UPDATE` | one `SUCCESS`, other `ALREADY_CHECKED_IN` | `VERIFIED FACT` |
| 2 | check-in ticket T | `requestRefund(order)` claiming T | `ticket` row `FOR UPDATE` (both) | refund first ⇒ `REFUND_PENDING`; check-in first ⇒ refund refuses `TICKET_ALREADY_CHECKED_IN`-class reason | `VERIFIED FACT` (`lib/ticketing/refunds/service.ts:236-241`) |
| 3 | check-in ticket T | `executeRefund` (order-level) | `eventorder` then `ticket` (refund) vs `ticket` only (check-in) | check-in wins ⇒ settlement CAS rolls back; refund wins ⇒ `PROCESSING` exists ⇒ check-in `REFUND_PENDING` | `VERIFIED FACT` (lock sets) + `INFERENCE` (combined) |
| 4 | check-in ticket T | `settleRefund` (`PROCESSING → REFUNDED`) | `eventorder` then ticket CAS | whichever commits first wins; the other's CAS affects 0 rows | `VERIFIED FACT` |
| 5 | check-in T | event `cancel` / `archive` | no shared lock; gate re-reads **before** the transaction | a cancel that lands after the gate read does **not** un-admit; the admission stands | `INFERENCE` — see R-06 |
| 6 | check-in T | `issueTicketsForOrder` re-run | different rows; issuance never rewrites status | no interaction | `VERIFIED FACT` |
| 7 | two scanners, different tickets of one order | — | independent ticket rows | both succeed | `VERIFIED FACT` |
| 8 | check-in T | PIC assignment revoked mid-scan | authorization read **before** the transaction | a scan authorized a moment before revocation completes | `INFERENCE` — same 60 s staleness class as `AUTHZ_SCOPE_TTL_MS` |
| 9 | same request replayed (network retry) | — | CAS | second answers `ALREADY_CHECKED_IN`; no second row | `VERIFIED FACT` |
| 10 | two transactions, different tickets, both then touching `tickettype` | — | no `tickettype` write exists in check-in | no deadlock possible | `VERIFIED FACT` |

### 10.2 Deadlock review

`VERIFIED FACT` Lock acquisition per writer:

| Writer | Order |
|---|---|
| check-in | `ticket` (single row) |
| issuance | `eventorder` (single row) → inserts |
| refund request | `ticket` (set, `ORDER BY id`) |
| refund execute / settle | `eventorder` (single row) → `ticket`/`refund`/ledger |
| settlement paid | `eventorder`/`settlement` → ledger |

`INFERENCE` No cycle is constructible: check-in holds exactly one lock and acquires nothing
else, so it cannot be the "waits-for" edge that closes a loop. The refund path's
`ORDER BY id` prevents the classic two-row inversion between two concurrent refund
requests covering overlapping ticket sets.

`RECOMMENDATION` If Phase 3C ever adds a second lock to the check-in transaction (e.g.
locking `piceventassignment`), the order must be **assignment → ticket**, matching
"parent before child", and it must be documented next to the existing note.

### 10.3 The two gaps that are *not* race conditions but are adjacent

1. **Refusal durability** (§6.4): refusal rows and their audit rows are independent
   best-effort writes, so a scan can be refused and leave no evidence if both fail.
2. **Authorization staleness** (§10.1 row 8): the gate resolves authority before the
   transaction and does not re-check inside it. This is consistent with every other guard
   in the codebase and is bounded by a database read per request — not by the 60 s JWT
   window, since `requireEventCheckInAccess` reads `organizerMember` and
   `staffEventAssignment` fresh on every call. For a PIC the equivalent fresh read is
   `PICEventAssignment`, so the same property holds by construction.

---

## 11. Test strategy

`RECOMMENDATION` — three layers, following the project's existing split. **None of this
audit ran any DB-writing test**; the totals below are targets for Phase 3G, not results.

### 11.1 Layer 1 — pure/static (`__tests__/ticketing-checkin/`, no database)

| # | Case | Assertion |
|---|---|---|
| 1 | Valid ticket | `normalizeCode` accepts bare + `TICKET:` + lowercase + surrounding whitespace |
| 2 | Invalid QR | any non-code payload → `null` → identical `NOT_FOUND` |
| 3 | Unknown token/code | well-formed unknown ≡ malformed (same status, same message, same `reason`) |
| 4 | Wrong event | `WRONG_EVENT` before the transaction; response does not name the real event |
| 5 | Unauthorized PIC | no session ⇒ 401; PIC with no assignment ⇒ the never-confirming refusal |
| 6 | PIC outside assigned event | assignment for event A + request for event B ⇒ indistinguishable from "not found" |
| 7 | Admin access | ADMIN + ACTIVE membership still allowed; ADMIN without membership still 404 |
| 8 | Replay | two identical accepted payloads ⇒ one `SUCCESS`, one `ALREADY_CHECKED_IN` |
| 9 | Audit integrity | `checkin.success` and `checkin.rejected` both written; no `qrToken`/`qrTokenHash` in any audit argument |
| 10 | Schema strictness | `method`, `eventId`, `ticketId`, `picProfileId`, `status` all rejected by `.strict()` |
| 11 | No second writer | a new PIC route contains no `$transaction`, no `updateMany`, no `prisma.ticket` |
| 12 | Route inventory | new pages present in `ROUTE_INVENTORY` |

### 11.2 Layer 2 — integration, real MariaDB, `tinggalklik_test` only (Phase 3G, separate authorization)

| # | Case | Shape |
|---|---|---|
| 13 | Cancelled ticket | ticket `VOID` ⇒ `INVALID_TICKET`; `CheckIn` refusal row written |
| 14 | Refunded ticket | ticket `REFUNDED` ⇒ `INVALID_TICKET` |
| 15 | Refund pending | `RefundItem` + `PENDING/APPROVED/PROCESSING` ⇒ `REFUND_PENDING` |
| 16 | Duplicate check-in (sequential) | second call ⇒ `ALREADY_CHECKED_IN` + first timestamp + first staff |
| 17 | Concurrent double scan | `Promise.all` of N scans on one code ⇒ exactly one `SUCCESS` row, `CheckIn.count === 1` |
| 18 | Check-in vs refund race | concurrent `checkInTicket` + `requestRefund` ⇒ exactly one winner, no invalid pair |
| 19 | Database rollback | force the `checkIn.create` to fail ⇒ ticket must remain `ISSUED` with `checkedInAt = null` |
| 20 | PIC scope, positive | ACTIVE profile + ACTIVE assignment ⇒ admitted |
| 21 | PIC scope, negative matrix | suspended profile / inactive assignment / revoked assignment / other PIC's event ⇒ refused |
| 22 | Audit record integrity | exactly one `checkin.success` per admission; `organizerId`/`actorOrganizerId` set; no secret keys |

### 11.3 Layer 3 — cross-phase regression (no DB where possible)

| Target | Check |
|---|---|
| Ticket issuance | `__tests__/ticketing-issuance/*` unchanged and green |
| Ticket wallet / public code | `buildTicketDetail` payload still `TICKET:<code>`; no new field |
| Purchase-proof + ticket-issued notifications | static guards still forbid `qrTokenHash` and `TICKET:` in templates |
| Notification queue / worker | transport stubs untouched; `PHASE_1_DRY_RUN_ONLY` still `true` |
| D-46 Option A | the code list policy is unchanged; a PIC surface must not print codes |
| Existing auth | `resolveAuthzScope` / guards unchanged; no new bridge from legacy `Role` |
| Event PIC permissions | `REPORT_EXPORT_OWN_PIC_FEE`, `PIC_PAYOUT_REQUEST_OWN` etc. unchanged |
| Refund ↔ check-in exclusion | the existing race suite still passes |

### 11.4 Database isolation requirements for 3G

`VERIFIED FACT` The Phase 0A work established `__tests__/support/test-database.ts` with an
explicit `TEST_DATABASE_URL`, a `_test` suffix requirement, a same-server requirement and a
Prisma constructor guard; `npm run test:db:setup` reports "No data was changed."

`RECOMMENDATION` 3G inherits that harness **without modification**. Any new integration
suite must (a) refuse to run without `TEST_DATABASE_URL`, (b) never fall back to the
application `DATABASE_URL`, (c) create and tear down its own fixtures, and (d) never assert
against the production database. This audit ran **no** DB-writing test.

### 11.5 What must not be tested by mock

`RECOMMENDATION` The four properties that only a real database can prove — duplicate
admission, concurrent scan, check-in/refund race, rollback — must be integration tests.
`VERIFIED FACT` The existing suites already follow this rule
(`__tests__/ticketing-checkin/check-in-refund-gate.integration.test.ts` documents why a mock
would only assert SQL text).

---

## 12. Proposed Phase 3A–3G

> **Nothing below is implemented.** Each subphase is a plan with its own stop condition.
> No subphase may begin until the previous one's acceptance criteria are met **and** the
> owner has cleared the blockers in §15.

### Phase 3A — Architecture and authorization contract

**Tujuan.** Resolve, in writing and in a pure module, *how* a PIC is authorized at one
event; settle the credential question; and produce the decision record that 3B–3G obey.
No HTTP, no UI, no database write.

**Files likely to change.**

| File | Change |
|---|---|
| `lib/authz/permissions.ts` | **Replace** the uncommitted `pic.checkin.scan.own` entry with the decided capability (classification per §8.3), or remove it |
| `lib/authz/pic-assignment.ts` *(new)* | the fourth decider + its pure predicate |
| `lib/authz/index.ts` | export |
| `lib/ticketing/checkin/service.ts` | `requireEventCheckInAccess` gains a PIC branch calling the new decider |
| `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` *(new)* | the decision record: who may scan, what credential, what is refused |

**Database impact.** None.

**API contract.** Unchanged (§8.2).

**Security requirements.**

1. Assignment is the only PIC authority source: `PICProfile.userId` → `PICEventAssignment(eventId)`, both ACTIVE. Never a `PermissionGrant`, never a membership, never a request field.
2. Cross-PIC and cross-event refusals are indistinguishable from "no access" (§4.4).
3. ADMIN/MANAGER keep their existing membership path unchanged.
4. The decider is **pure** (no I/O) with a thin async resolver beside it, mirroring `permissions.ts` / `scope.ts`.
5. If the owner instead decides PIC must **not** scan (upholding the §6.3 lock), 3A's output is a **NO-GO record** and 3B–3G do not start.

**Tests required.** The decider matrix as a pure unit suite (no DB): PIC+active assignment allow; suspended profile deny; inactive assignment deny; revoked assignment deny; other event deny; other PIC deny; ADMIN unaffected; unknown permission deny; non-PIC platform role deny.

**Dependencies.** Owner decision on B-1 and B-2 (§15).

**Acceptance criteria.** A written contract exists; every matrix row is a passing pure test; `tsc` clean; the permission change is either correctly reclassified or reverted (still uncommitted either way, per the safety rules).

**Stop conditions.** Owner has not chosen between "PIC may scan" and the §6.3 lock ⇒ **STOP**. Any proposal that widens `decideOrganizerPermission` to accept `OWN`-scope permissions ⇒ **STOP**. Any proposal that grants `checkin.log.read` to PIC ⇒ **STOP**.

---

### Phase 3B — Secure QR validation

**Tujuan.** Make an explicit, honest statement of what a scan proves, and close the gap
between "Phase 3 objective: validate authenticity" and "the QR is a public code".

**Files likely to change.**

| File | Change |
|---|---|
| `lib/ticketing/checkin/service.ts` | record `CheckInMethod.QR_SCAN` **only** when a genuine secret was verified; otherwise stay `MANUAL` |
| `lib/ticketing/checkin/validation.ts` | (only if a token field is added) a distinct field, never overloaded onto `code` |
| `lib/ticketing/tickets/reference.ts` | unchanged unless the token becomes presentable |
| `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` | the credential statement the code implements |

**Database impact.** None. (`CheckInMethod.QR_SCAN` already exists.) A token path would
need a **delivery** mechanism, not a schema change — the column and hash already exist.

**API contract.** Unchanged for the public-code path. A token path would add
`{ token }` and deprecate `code` for scanners — **not** recommended in 3B.

**Security requirements.**

1. **Do not label a public-code scan `QR_SCAN`.** That value must mean "a secret was
   verified", or the audit trail becomes a false statement. (§5 Q1.)
2. The QR must keep carrying `TICKET:<ticketCode>` and nothing else; `assertQrPayloadIsSafe`
   must keep failing closed.
3. No raw token in any response, log, audit argument or client state (§5 Q10).
4. Malformed ≡ unknown, with one status and one message.
5. If the owner decides a real token is required, that is a **Phase 4** decision
   (delivery channel + `qrVersion` rotation), not a 3B side effect.

**Tests required.** Method labelling (a public-code scan writes `MANUAL`); payload builder
rejects a URL/email/PII; `normalizeCode` matrix unchanged; no `qrTokenHash` read anywhere
in the check-in module (static).

**Dependencies.** 3A; owner acceptance of the credential statement.

**Acceptance criteria.** The report, the contract and the code agree on what a scan proves;
static guards assert no `qrTokenHash` read and no `QR_SCAN` write for a public-code scan.

**Stop conditions.** A `QR_SCAN` label without a verified secret ⇒ **STOP**. Any change to
`buildTicketQrPayload`'s shape ⇒ **STOP** (it would break every existing wallet QR).

---

### Phase 3C — Atomic check-in and concurrency protection

**Tujuan.** Prove, and pin by test, that the existing transaction is sufficient for the
PIC path too — **without rewriting it**.

**Files likely to change.** `lib/ticketing/checkin/service.ts` (comments/guards only if a
gap is found); no new writer.

**Database impact.** None.

**API contract.** Unchanged.

**Security requirements.**

1. `FOR UPDATE` on the ticket row, then the refund guard, then the CAS, then the
   `CheckIn` insert — all in one transaction (§6.1). No reordering.
2. `CheckIn.ticketId @unique` stays.
3. If a PIC branch adds any lock, the order is assignment → ticket (§10.2).
4. No idempotency column (§6.3).

**Tests required.** Concurrency suite (§11.2 #17, #18), rollback suite (#19).

**Dependencies.** 3A, 3B.

**Acceptance criteria.** Exactly one `SUCCESS` under N concurrent scans; no invalid
check-in/refund pair; rollback leaves the ticket `ISSUED`.

**Stop conditions.** Any proposal to replace the CAS with a read-then-write ⇒ **STOP**.
Any proposal to relax `CheckIn.ticketId` uniqueness ⇒ **STOP**.

---

### Phase 3D — PIC scanner API

**Tujuan.** Make the authorized admission reachable for a PIC without creating a second
admission path.

**Files likely to change.**

| File | Change |
|---|---|
| `app/api/organizer/events/[id]/check-in/route.ts` | unchanged, **or** |
| `app/api/pic/events/[id]/check-in/route.ts` *(new)* | thin re-export of `checkInTicket` + `requireSameOrigin` + `requireAuth`, no transaction |
| `proxy.ts` | add `/api/pic/` to `PROTECTED_API_PREFIXES` **only** if the new route exists (it is already covered if `/api/pic/` is listed — verify) |
| `lib/rate-limit.ts` usage | a per-actor POST limit |

**Database impact.** None.

**API contract.** §8.2, with §8.4's response hardening for a PIC actor.

**Security requirements.**

1. One writer: the new route may contain **no** `$transaction`, no `updateMany`, no
   `prisma.ticket.*` — only the call. A static guard asserts this.
2. `.strict()` request schema unchanged; no `method`, `picProfileId`, `eventId`, `ticketId`.
3. `requireSameOrigin` on `POST`.
4. Rate limit sized for a real gate (§8.5).
5. 404 (not 403) for an event outside the PIC's scope.

**Tests required.** Route auth + CSRF + schema; no second writer (static); rate-limit
behaviour; PIC 404 masking.

**Dependencies.** 3A, 3C.

**Acceptance criteria.** A PIC with an active assignment admits a valid ticket; a PIC
without one is refused identically to a nonexistent event; no duplicate admission.

**Stop conditions.** A new route that re-implements any part of the transaction ⇒ **STOP**.
A route that accepts `picProfileId` from the body ⇒ **STOP**.

---

### Phase 3E — PIC scanner interface

**Tujuan.** Give the PIC the same physical scanning capability staff have, scoped to its
assigned events, with no attendance log.

**Files likely to change.**

| File | Change |
|---|---|
| `app/dashboard/pic/scan/page.tsx` *(new)* | assigned + open events |
| `app/dashboard/pic/scan/[eventId]/page.tsx` *(new)* | scanner, `canReadLog = false` |
| `lib/dashboard/gates.ts` | a PIC-aware resolver, **not** a widened `listCheckInGateEvents` |
| `components/organizer/TicketScanner.tsx` | at most an endpoint prop; no logic fork |
| `components/dashboard/DashboardAppShell.tsx` | menu entry gated on the PIC capability |
| `lib/ui/route-inventory.ts` | two new entries (or the inventory test fails) |

**Database impact.** None.

**API contract.** Consumes 3D.

**Security requirements.**

1. The page re-authorizes with the **same** decider as the API; a typed event id fails identically.
2. No log, no attendee list (`checkin.log.read` not held).
3. Server-side gate window only.
4. No payload persistence; no QR display; no override control.
5. The list is derived from the session user's `PICProfile`, never a URL parameter.

**Tests required.** Page authorization (server) both ways; list contains only assigned +
open events; no log rendered; route inventory; a static guard that the page does not call
`listOwnTickets`/wallet helpers.

**Dependencies.** 3D. Owner decision on whether a PIC may see *its own* scan result (recommended: yes) vs any attendance history (recommended: no).

**Acceptance criteria.** A PIC scans successfully on a phone; a non-assigned event yields
the universal refusal; nothing in the UI shows another event's attendance.

**Stop conditions.** Any attendance list for a PIC ⇒ **STOP**. Any client-side validity
decision ⇒ **STOP**.

---

### Phase 3F — Audit trail and security hardening

**Tujuan.** Make "every scan is recorded" true (not best-effort), attribute PIC scans
durably, and bound abuse.

**Files likely to change.** `lib/ticketing/checkin/service.ts` (refusal durability),
`lib/ticketing/audit-log.ts` (an action or metadata shape that names the PIC),
`lib/rate-limit.ts` usage, and — **only if approved** — one additive migration for
`CheckIn.checkedInByPicProfileId`.

**Database impact.** None, or **one additive nullable column + FK + index** (owner-approved,
no backfill). This audit created no migration.

**API contract.** Unchanged.

**Security requirements.**

1. A refused scan's evidence is durable: the `CheckIn` refusal row and its audit row are
   written with throw-on-failure semantics (or one is dropped and the other is guaranteed —
   the owner chooses which fact is authoritative).
2. PIC attribution is recorded without storing any token.
3. The refusal path **must not** store a secret if a token path ever exists (§5 Q10).
4. Refusal-row growth is bounded by the rate limit, not by trust.

**Tests required.** Refusal durability under an injected failure; PIC attribution present
and queryable; no `qrToken*` key in any audit argument; rate-limit enforcement.

**Dependencies.** 3C, 3D.

**Acceptance criteria.** An auditor can answer "who admitted this attendee, and was it a
PIC?" from the database alone; a refused scan leaves evidence even when the audit write fails.

**Stop conditions.** A migration that alters/drops an existing column ⇒ **STOP**. Storing a
raw token anywhere ⇒ **STOP**.

---

### Phase 3G — Automated tests and integration verification

**Tujuan.** Turn every claim above into a check, and prove no cross-phase regression.

**Files likely to change.** `__tests__/ticketing-checkin/*` (extend), a new
`__tests__/authz/pic-assignment.test.ts`, a new integration suite using the existing
`tinggalklik_test` harness. **No production file.**

**Database impact.** Test database only, only when separately authorized.

**API contract.** N/A.

**Security requirements.** The harness must refuse to run without `TEST_DATABASE_URL`, must
require a `_test` suffix and the same server, and must never fall back to `DATABASE_URL`.

**Tests required.** §11.1 (12 static/pure), §11.2 (10 integration), §11.3 (cross-phase).

**Dependencies.** 3A–3F.

**Acceptance criteria.** All three layers green; `tsc` clean; cross-phase suites unchanged;
the previously historical full-suite totals are **re-run**, not quoted.

**Stop conditions.** Any test pointing at the application database ⇒ **STOP**. Any suite
weakened to make a check pass ⇒ **STOP**.

---

## 13. File impact inventory

`VERIFIED FACT` status of every file named in this report, at this HEAD. "Unchanged" means
this audit did not touch it and no Phase 3 code exists.

### 13.1 Files Phase 3 would read but not change

| File | Role in Phase 3 |
|---|---|
| `prisma/schema.prisma` | `Ticket`, `CheckIn`, `PICProfile`, `PICEventAssignment` |
| `lib/ticketing/tickets/reference.ts` | `TICKET_QR_PREFIX`, `isTicketCode`, `hashQrToken` |
| `lib/ticketing/tickets/issuance.ts` | the only `Ticket` writer |
| `lib/ticketing/refunds/service.ts` | the other holder of the ticket-row lock |
| `lib/ticketing/refunds/settlement.ts` | order-row lock, refund CAS |
| `lib/events/access.ts` | `requireEventAccess` |
| `lib/events/sales-state.ts` | `isEventCheckInOpen` (the one gate predicate) |
| `lib/authz/scope.ts`, `guards.ts`, `errors.ts` | scope resolution, throws, 404 masking |
| `lib/pic/self-service.ts` | existing pattern for "resolve my own PICProfile" |
| `lib/dashboard/scope.ts` | `organizerIdsWith` |
| `lib/ticketing/audit-log.ts` | `writeTicketingAudit`, key filter |
| `__tests__/support/test-database.ts` | the `tinggalklik_test` guard 3G inherits |

### 13.2 Files Phase 3 would change (by subphase)

| File | 3A | 3B | 3C | 3D | 3E | 3F | 3G | Risk |
|---|---|---|---|---|---|---|---|---|
| `lib/authz/permissions.ts` | ✎ | | | | | | | **high** — the uncommitted change lives here |
| `lib/authz/pic-assignment.ts` *(new)* | + | | | | | | | medium — new authority path |
| `lib/ticketing/checkin/service.ts` | ✎ | ✎ | ✎ | | | ✎ | | **high** — the admission writer |
| `lib/ticketing/checkin/validation.ts` | | ✎ | | | | | | low |
| `app/api/pic/events/[id]/check-in/route.ts` *(new)* | | | | + | | | | medium — a second URL for one writer |
| `proxy.ts` | | | | ✎ | | | | low |
| `lib/rate-limit.ts` usage | | | | ✎ | | ✎ | | low |
| `app/dashboard/pic/scan/page.tsx` *(new)* | | | | | + | | | low |
| `app/dashboard/pic/scan/[eventId]/page.tsx` *(new)* | | | | | + | | | low |
| `lib/dashboard/gates.ts` | | | | | ✎ | | | medium — must not widen staff scope |
| `components/organizer/TicketScanner.tsx` | | | | | ✎ | | | medium — shared with staff UI |
| `components/dashboard/DashboardAppShell.tsx` | | | | | ✎ | | | low |
| `lib/ui/route-inventory.ts` | | | | | ✎ | | | low (test-enforced) |
| `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` *(new)* | + | | | | | | | none |
| `__tests__/ticketing-checkin/*` | | | | | | | ✎ | low |
| `__tests__/authz/pic-assignment.test.ts` *(new)* | | | | | | | + | low |

### 13.3 Files Phase 3 must **not** touch

`RECOMMENDATION` `lib/notifications/**` (Phase 2 stays dry-run), `lib/notifications/config.ts`
(`PHASE_1_DRY_RUN_ONLY = true`), `lib/notifications/transports/smtp.ts` and `baileys.ts`
(fail-closed stubs), `lib/ticketing/payment/**`, `lib/ticketing/tickets/payload.ts`,
`app/ticketing/**`, `prisma/migrations/**`, `.env*`, `.cloud-attachments/**`,
`PROJECT_PRE_FEATURE_AUDIT_REPORT.md`, `docs/PHASE_2_FOUR_COMMIT_BASELINE_EXECUTION_REPORT.md`.

---

## 14. Security risks

Severity is about **this tree**, not about a hypothetical future one.

| ID | Risk | Severity | Evidence | Mitigation |
|---|---|---|---|---|
| **R-01** | **The QR is a public code, not a credential.** Anyone holding a valid code (a forwarded email, a screenshot, a shared wallet list) can be the first admitted at the right event by any authorized scanner. The system cannot distinguish the legitimate holder from a forwarder. | **Medium** (product-accepted by D-46 Option A / P14-D17) | §5 Q1, Q6 | Product acceptance is explicit and documented. Phase 3 must not *describe* the QR as proving authenticity. A real token is a separate, Phase 4 decision. |
| **R-02** | **The refusal path stores the presented code** in `CheckIn.note` and `AdminAuditLog.entityRef`. Safe today (the code is public); becomes a **secret leak** the moment a token is introduced and this helper is reused. | **Low now / High if a token path is added carelessly** | `checkin/service.ts#refuse` | 3F security requirement 3; a static guard forbidding `token` in `note`/`entityRef`. |
| **R-03** | **No rate limit on the check-in POST.** Enables refusal-row/audit inflation and (theoretically) 40-bit code-space probing with an authenticated session. | **Medium** | `lib/rate-limit.ts` is used by register/branding/images, not this route | 3D adds a per-actor limit sized for a gate. |
| **R-04** | **PIC authority has no decider.** If Phase 3 implements the PIC path by widening `decideOrganizerPermission`, any one of four plausible mistakes would grant tenant-wide or cross-event scanning: accepting `OWN` scope there; adding the permission to `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC`; adding a `PermissionGrant` path; or defaulting to "PIC assignment exists for *some* event". | **High (design)** | §4.3 | 3A's fourth decider with a pure matrix test; deny-by-default. |
| **R-05** | **Duplicate-scan response discloses another staff member's name** (`firstCheckedInBy`) — harmless for organizer staff, widened if a PIC surface inherits it. | **Low** | `checkin/service.ts`, `ALREADY_CHECKED_IN` details | 3D §8.4. |
| **R-06** | **A cancelled/archived event that lands after the gate read does not un-admit.** The gate is read before the transaction, and the admission writes no event state. | **Low** | §10.1 row 5 | Accepted: an admission that raced a cancellation is a *past* fact; the ticket is consumed either way. Documented, not "fixed". |
| **R-07** | **Refusal evidence is best-effort.** `recordRejectedAttempt` and `writeTicketingAudit` both swallow errors, so "every scan writes a row" is not guaranteed for refusals. | **Medium (audit claim)** | §6.4 | 3F requirement 1. |
| **R-08** | **`qrVersion` cannot be used for revocation** because nothing increments it and the raw token is unrecoverable. If the owner ever expects "reissue the QR" to work, it does not. | **Low (documentation)** | §5 Q8 | State it plainly; `ticket.reissue` is unimplemented and not in Phase 3 scope. |
| **R-09** | **Scope staleness (≤60 s)** applies to membership/grant changes; the check-in path re-reads membership and `StaffEventAssignment` per request, so the practical window is shorter, but a PIC revocation has the same characteristics by construction. | **Low** | `AUTHZ_SCOPE_TTL_MS`; §10.1 row 8 | Accepted and documented (D-48). Verify with the 3G negative matrix. |
| **R-10** | **`RESERVED`/`VOID` are declared but unwritten ticket states.** A future writer could create a state the gate handles conservatively (it refuses), which is safe but means the lifecycle is wider than the test matrix. | **Informational** | §3.5 | Keep the fail-closed mapping. |

`INFERENCE` No risk above is an **open vulnerability in the shipped gate**. R-01 is an
accepted product decision; R-04 is a *risk of the change*, not of the current code; R-03 and
R-07 are hardening gaps.

---

## 15. Blockers

These are the reasons this audit does **not** return an unconditional GO.

### B-1 — Decision conflict: PIC gate access vs a locked design matrix (`VERIFIED FACT`)

`PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` §17 PIC Access locks `Scan / validate QR` = **PIC NO**,
`Manual check-in override` = **PIC NO**, `View check-in log` = **PIC NO**, and forbids
passing a PIC through the check-in guard without a deliberate design change.

**Needs:** an explicit owner decision that Phase 3 **reverses** that row for scanning only,
recorded as a new decision (with the log and override rows unchanged). Without it, 3A
cannot write a contract that contradicts a lock, and implementers must not pick for the owner.

### B-2 — The credential cannot meet "validasi keaslian" (`VERIFIED FACT`)

The QR is `TICKET:<public code>`; the 256-bit secret is generated, hashed and then
**unrecoverable**. A public code proves *existence*, not *authenticity*.

**Needs:** one of two explicit choices —

- **(a) Accept the code** (consistent with D-46 Option A): restate the objective as
  "validate that the ticket exists, belongs to this event, is `ISSUED`, and is not claimed
  by a refund" — which the system does fully. Phase 3B then only fixes method labelling.
- **(b) Require a real secret**: decide a delivery channel for the token (the per-ticket QR
  the buyer already shows is a *print*, not a secret) and schedule it as a separate phase.

Doing neither would ship a feature whose stated guarantee is false.

### B-3 — The uncommitted permission is unusable and pre-empts B-1 (`VERIFIED FACT`)

`pic.checkin.scan.own` is `OWN`-scope, has no consumer, is denied by
`decideOrganizerPermission`, and cannot express an event assignment (§4.3). Committing it
as-is would (i) record a permission that always denies, and (ii) silently pre-approve B-1.

**Needs:** keep it uncommitted and untouched until B-1 is decided; then replace or revert
it inside 3A. This audit did not modify it.

### B-4 — No PIC attendance-log policy (`UNRESOLVED`)

Design §6.3 says PIC may not view the check-in log, and `checkin.log.read` is not in any PIC
map. But the scanner UI shows the **result of the scan just performed** (attendee name +
ticket type), which is a small slice of the same information.

**Needs:** an owner statement that the scanned ticket's own display is permitted (recommended)
while the attendance *list* is not — otherwise 3E has no defensible `canReadLog` value.

---

## 16. Acceptance criteria for Phase 3 (all must hold before it is called done)

1. A written authorization contract exists, naming the decider and its predicate, and every
   matrix row is a passing pure test.
2. A PIC with `PICProfile ACTIVE` + `PICEventAssignment(isActive, revokedAt null)` for event
   E admits a valid ticket at E.
3. The same PIC is refused for event F, and the refusal is **indistinguishable** from a
   nonexistent event.
4. A suspended/rejected PIC profile, an inactive assignment, or a revoked assignment is refused.
5. ADMIN and MANAGER retain exactly their current gate behaviour (membership-based, no
   assignment needed when holding `checkin.override`).
6. `checkin.log.read` is still not held by any PIC; the PIC surface renders no attendance list.
7. Exactly one `SUCCESS` per ticket under N concurrent scans; a replay returns
   `ALREADY_CHECKED_IN` with the first admission's timestamp.
8. A refund-claimed ticket is refused `REFUND_PENDING`; a check-in and a refund on one
   ticket have exactly one winner.
9. Wrong-event, void, refunded, unpaid and closed-gate scans are refused with the existing
   reason vocabulary; no new `CheckInResult` value is introduced.
10. Every admission writes one `CheckIn` row and one `checkin.success` audit row; every
    refusal writes evidence per 3F's chosen durability rule.
11. No raw token, `qrTokenHash`, or credential appears in any response, log, audit argument
    or client storage.
12. `CheckInMethod.QR_SCAN` is written only where a genuine secret was verified; otherwise
    `MANUAL`.
13. One admission writer: a static guard proves any new PIC route contains no transaction,
    no conditional update and no direct `prisma.ticket` call.
14. No schema migration, or exactly one additive nullable column if 3F's attribution is
    approved — no `ALTER` of an existing column, no backfill.
15. Cross-phase suites green: issuance, wallet, public code, notification templates/queue
    (still dry-run), D-46 Option A, existing auth, existing PIC permissions.
16. `npx tsc --noEmit` clean; new tests pass; no test pointed at the application database.
17. The route inventory test passes with any new page.

---

## 17. Recommendation

### 17.1 Verdict

> **CONDITIONAL GO — Phase 3A only.**
> **NO-GO — Phase 3B through 3G** until B-1, B-2 and B-3 are resolved by the owner.

### 17.2 Why not GO

GO would assert that Phase 3 can be implemented safely from what is on disk. It cannot,
for three evidence-backed reasons:

1. The feature **contradicts a locked decision** (B-1). Proceeding would reverse it silently.
2. The stated objective — *validate authenticity* — is **not achievable with the credential
   that exists** (B-2). Proceeding would ship a false guarantee.
3. The only PIC artifact in the tree **cannot authorize the action it names** (B-3), so there
   is no starting point to build on, only a wrong one to correct.

### 17.3 Why not NO-GO outright

Because the **engineering** is in better shape than the decisions:

- The admission transaction is already correct and already proven (`VERIFIED FACT` + existing
  race suite): duplicate, concurrent, refund-race, wrong-event, void/refunded and closed-gate
  admissions are all refused by the database, not by application memory.
- The audit trail exists and is used for both outcomes.
- The scanner UI exists, works without `BarcodeDetector`, and never decides validity locally.
- Phase 3 needs **no migration** under every option except one optional additive column.

So Phase 3A — a contract, a pure decider and its matrix test — is safe, useful and
reversible regardless of how B-1/B-2 are answered. That is precisely the scope of a
**CONDITIONAL GO**: do the part that cannot be wrong, stop before the part that needs an
owner.

### 17.4 Preconditions for lifting the condition

| # | Owner action | Unblocks |
|---|---|---|
| 1 | Decide B-1: PIC scanning = allowed (reversing only that §6.3 row), or uphold the lock | 3A's contract; 3D/3E |
| 2 | Decide B-2: accept the public code as the credential (restating the guarantee), or schedule a token phase | 3B |
| 3 | Confirm B-3: the uncommitted permission is to be replaced/reverted inside 3A, still uncommitted | 3A |
| 4 | Decide B-4: a PIC may see the result of its own scan, not the attendance log | 3E |
| 5 | Approve (or refuse) the optional `CheckIn.checkedInByPicProfileId` column for 3F | 3F |
| 6 | Approve any DB-writing test run against `tinggalklik_test` | 3G |

### 17.5 What this audit did not do

- Wrote no code, schema, migration or environment change; changed no permission.
- Ran no database write, no migration, no seed, no reset, no cleanup.
- Ran no test (so no test result is claimed), and did not run the full suite.
- Sent no email, no WhatsApp; activated no SMTP or Baileys; started no worker.
- Did not stage, commit, push, deploy, reset, rebase, checkout, clean or stash.
- Created exactly one file: this report (untracked).

---

## Appendix A — Evidence classification

### A.1 Verified facts (read from this tree at `d0bb0e0`)

1. HEAD, branch, staging and working-tree state as recorded in §2.
2. `lib/authz/permissions.ts` differs from `HEAD` by exactly +4 lines (the three
   `PIC_CHECKIN_SCAN_OWN` insertions).
3. `PIC_CHECKIN_SCAN_OWN` has no consumer outside that file.
4. It is classified `OWN`-scope and held only by `PLATFORM_ROLE_OWN_PERMISSIONS.PIC`.
5. `decideOrganizerPermission` denies every `OWN`-scope permission unconditionally.
6. `decideOrganizerPermission` requires an ACTIVE `OrganizerMember` for every role
   (`ORGANIZER_SPANNING_PLATFORM_ROLES` is empty).
7. `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC` is empty; `MEMBERSHIP_ROLE_PERMISSIONS.PIC`
   holds only `pic_attribution.read.all`.
8. The wallet QR payload is `TICKET:<ticketCode>`; the check-in service resolves by
   `ticketCode` and never reads `qrTokenHash` (also pinned by an existing static guard).
9. Only `CheckInMethod.MANUAL` is written by the check-in service.
10. The admission transaction order is lock → refund guard → CAS → `CheckIn` insert.
11. `CheckIn.ticketId` is `@unique`; the CAS requires `status='ISSUED' AND checkedInAt IS NULL`.
12. `CheckInMethod.QR_SCAN`, `CheckInResult.REFUND_PENDING` and `Ticket.qrVersion` exist in
    the schema; `qrVersion` has no writer.
13. `qrTokenHash` is written once at issuance from an expression; the plaintext is never bound.
14. Refusal records and their audit rows are outside the transaction and swallow errors.
15. The check-in route authenticates, checks same-origin, and validates with a `.strict()` schema.
16. No rate limit is applied to the check-in route; three other routes use `lib/rate-limit.ts`.
17. `proxy.ts` protects `/api/organizer/` by prefix (defence in depth).
18. `PICEventAssignment` has `@@unique([picProfileId, eventId])`, `isActive`, `revokedAt`.
19. `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` records PIC gate access as NO, as a lock.
20. `docs/PHASE_2_D46_FINAL_DECISION_READINESS_REPORT.md` records D-46 Option A approval and
    states that the public code remains the admission credential by product acceptance.
21. `lib/ui/route-inventory.ts` is filesystem-checked by a test.

### A.2 Inferences

1. The uncommitted permission is inert today (no consumer ⇒ no behaviour change).
2. It cannot be made to work without a new scope kind or a new decider (§4.3).
3. Cross-PIC isolation currently exists only by absence of capability.
4. The QR is a pointer, not a bearer credential; authenticity is enforced by staff
   authorization, not by the payload.
5. The lock graph is acyclic because check-in holds exactly one lock.
6. A PIC scanner page is a page + a prop, not a new component.
7. Phase 3 is code-only, with one optional additive column.
8. A cancellation that races an admission does not un-admit (and should not).

### A.3 Recommendations

1. Condition Phase 3 on B-1/B-2/B-3; start with 3A only.
2. Replace, not extend, the uncommitted permission; add a fourth decider bound to
   `PICEventAssignment`.
3. Reuse the single admission writer; any PIC route is a thin re-export guarded by a static test.
4. Do not write `QR_SCAN` unless a secret was verified.
5. Add a per-actor rate limit on the check-in POST.
6. Harden refusal durability in 3F; do not store secrets in `note`/`entityRef`.
7. Do not grant `checkin.log.read` to PIC; omit `firstCheckedInBy` on a PIC response.
8. No schema change except an owner-approved nullable PIC attribution column.

### A.4 Unresolved questions

| # | Question | Owner |
|---|---|---|
| U-1 | Does Phase 3 reverse the §6.3 "PIC = NO" row for scanning? | Owner |
| U-2 | Is the public ticket code acceptable as the admission credential (B-2a), or is a token phase required (B-2b)? | Owner |
| U-3 | Should the uncommitted `pic.checkin.scan.own` be reverted or replaced? | Owner |
| U-4 | May a PIC see the result of its own scan (name + ticket type) as distinct from the attendance log? | Owner |
| U-5 | Is a durable, indexed "which PIC scanned" column required, or does audit JSON suffice? | Owner |
| U-6 | Should a PIC route live under `/api/pic/**` or reuse `/api/organizer/**`? | Engineering, after U-1 |
| U-7 | Should refusal evidence become transactional (3F), and which fact is authoritative if only one write succeeds? | Owner |
| U-8 | Is `D-46` to be disambiguated in the decision register (it names two different questions)? | Owner |

---

**End of report.** No Phase 3 work has begun. No permission, schema, database, environment,
notification provider, commit, push or deployment was changed. Awaiting owner review of
§15 (blockers) and §17.4 (preconditions).

