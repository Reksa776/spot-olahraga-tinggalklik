# PHASE 3D — API & AUTHORIZATION AUDIT

**Status:** written before any Phase 3D application-source change (Checkpoint 1).
**Baseline:** `main` @ `9b8fecd99bcc74677c1805c18379241af04fddd1`; Phase 3C's two tracked
modifications and all prior untracked files present; staged 0.
**Scope:** the PIC Scanner API only. No UI, no rate limit, no audit expansion, no schema change.

---

## 1. Evidence table

| Concern | Actual source / symbol | Existing behaviour | Phase 3D decision |
|---|---|---|---|
| Route path | `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:1037` prescribes `app/api/pic/events/[id]/check-in/route.ts` | Does not exist (only `app/api/pic/payouts/route.ts`) | Create exactly that path, POST only |
| Proxy classification | `proxy.ts:134` `"/api/pic/"` in `PROTECTED_API_PREFIXES` | Whole PIC subtree requires a session at the edge | No proxy change; `__tests__/authz/route-classification.test.ts` will see the new file classified |
| Session identity | `lib/authz/guards.ts#requireAuth` → `auth()` → `resolveAuthzScope` | Server-side only; `null` for a missing/deactivated account → 401 | Route calls `requireAuth()`; identity never read from the body |
| Actor scope shape | `lib/authz/scope.ts#resolveAuthzScope` | Returns `userId`, `platformRole`, `organizerScopes`, `grants` | Passed to the decider only as `userId`; no client field reaches it |
| PIC profile | `prisma/schema.prisma:1427` `PICProfile` (`userId @unique`, `status`) | `findActivePicProfile` / `requireMyPic` exist for self-service (ACTIVE only) | Load the row by session `userId` including its status, so the decider can distinguish 403 from 404 |
| Assignment | `prisma/schema.prisma:1470` `PICEventAssignment`, `@@unique([picProfileId, eventId])`, `isActive`, `revokedAt` | No API consumer yet | Load by the compound unique `(picProfileId_eventId)` and pass the snapshot |
| Decider | `lib/authz/pic-assignment.ts#decidePicEventPermission` | Pure; allow ⇒ `{allowed:true,picProfileId}`, deny ⇒ `{allowed:false,code,reason}` | The only PIC authority decision; no second condition in the route |
| Refusal codes | `lib/authz/errors.ts` `STATUS_BY_CODE` | `UNAUTHORIZED` 401, `PIC_ACCESS_DENIED` 403, `ORGANIZER_ACCESS_DENIED`/`NOT_FOUND` 404 | Thrown as `AuthzError`; `toAppError` preserves code + status (`lib/api/errors.ts:237`) |
| Check-in service guard | `lib/ticketing/checkin/service.ts#requireEventCheckInAccess` | Organizer membership + `checkin.scan` (+ assignment for non-override members). A PIC has **no** membership, so this guard can never authorize one | **Audit-approved correction** (`docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:925`): the function gains a PIC branch; the organizer path is unchanged |
| Admission writer | `service.ts#checkInTicket` | Gate window → parse → lookup → event match → `FOR UPDATE` → refund guard → CAS → insert | Reused unchanged; no second transaction, no duplicated admission logic |
| CSRF | `lib/csrf.ts#requireSameOrigin` | Every state-changing route calls it first; missing Origin/Referer ⇒ 403 | POST calls it before body parsing |
| Request schema | `lib/ticketing/checkin/validation.ts#checkInRequestSchema` | `.strict()`; `code` ≤ 120; no `organizerId`/`eventId`/`ticketId`/status/actor/method | Reused unchanged; a body carrying any of those is a 400, not an override |
| Response envelope | `lib/api/response.ts#ok` / `#handleApi` | `{success:true,data}` / `{success:false,code,message,details?}` | Reused unchanged; no bespoke response shape |
| Error mapping | `lib/api/response.ts#apiErrorResponse`, `lib/api/errors.ts#toAppError` | `AuthzError` keeps code/status; unknown ⇒ `INTERNAL_ERROR` 500 + correlation id; internals logged server-side only | Reused; no Prisma/stack leakage |
| Method labelling | Phase 3B `resolveCheckInMethod`, Phase 3C constant | `MANUAL` for the public code; `QR_SCAN` unreachable | Route accepts no method; `checkInRequestSchema` refuses one |
| Rate limiting | `lib/rate-limit.ts` (in-memory sliding window) | No check-in-specific limiter exists | Not implemented (Phase 3F); no new middleware invented |
| Audit | `lib/ticketing/checkin/service.ts` writes `checkin.success` / `checkin.rejected` | Records the actor user via `checkinByUserId`; no PIC-distinct action | Preserved as-is; PIC attribution/durable audit deferred to Phase 3F |

## 2. The decider contract (read from source, not inferred from reports)

```ts
decidePicEventPermission(input: {
  userId?: string | null;
  eventId?: string | null;
  picProfile?: { id: string; userId: string; status: PICStatus } | null;
  assignment?: { picProfileId: string; eventId: string; isActive: boolean; revokedAt: Date | null } | null;
}): { allowed: true; picProfileId: string } | { allowed: false; code: AuthzErrorCode; reason: string }
```

Deny order: no input ⇒ `ORGANIZER_ACCESS_DENIED`; missing user ⇒ `UNAUTHORIZED`; missing event
⇒ `NOT_FOUND`; missing/foreign profile ⇒ `PIC_ACCESS_DENIED`; non-`ACTIVE` ⇒
`PIC_ACCESS_DENIED`; any assignment failure ⇒ `ORGANIZER_ACCESS_DENIED`. `isActive` must be
boolean `true`; `revokedAt` must be strictly `null`. The decider performs no I/O; loading is the
caller's job, which is exactly what the route's server-side loader does.

## 3. The reconciliation problem and its approved resolution

A PIC is a platform role with no `OrganizerMember` row (Phase 3 audit §: "No decider in `lib/authz`
can answer 'may this PIC scan at this event?'"). Therefore:

- `checkInTicket`'s existing guard is correct for organizer staff and must not be removed or made
  optional (that would let any caller through).
- Adding a second admission implementation would duplicate the lock, refund guard, CAS and
  UNIQUE insert — explicitly forbidden.
- The Phase 3 audit already records the intended shape: *"`requireEventCheckInAccess` gains a PIC
  branch calling the new decider"* (`docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:925`).

**Decision:** split the guard into `requireOrganizerCheckInAccess` (the existing body, byte-for-byte
semantics) and a `requirePicCheckInAccess` fallback invoked **only** when the organizer path
refused for an authorization reason. The fallback loads the profile and the exact assignment,
runs the real decider, and returns the same `CheckInAccess` shape; `checkInTicket` — the one
transaction — then runs unchanged. A non-PIC actor receives the original refusal unchanged.

## 4. Trust boundary

Accepted from the client: the ticket `code` and the event id **in the URL**, plus the existing
non-authoritative metadata (`gateLabel`, `deviceId`, `clientScannedAt`).

Rejected by the strict schema: `userId`, `picProfileId`, `assignmentId`, `role`, `permissions`,
`method`, `checkInMethod`, `result`, `status`, `checkedInAt`, `checkedInByUserId`, `ticketId`,
`eventId`, `organizerId`. The actor comes from `auth()`; the event is the route segment; the
assignment is loaded from the database by `(profile, event)`.

## 5. Stop-condition check

| Condition | Result |
|---|---|
| Session identity establishable | **No stop** — `requireAuth()` is the existing, server-side path |
| Assignment resolvable | **No stop** — compound unique names exactly one row |
| Decider conflicts with requirements | **No stop** — 66/66 Phase 3A tests pin the contract |
| Schema change needed | **No stop** — no column, table or enum is required |
| Service authorization irreconcilable | **Resolved** by the audit-prescribed PIC branch; no check removed or weakened |
