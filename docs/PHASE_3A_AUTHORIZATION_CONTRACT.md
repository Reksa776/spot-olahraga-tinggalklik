# PHASE 3A — PIC Assignment-Based Authorization Contract

**Status:** implemented (Phase 3A) — authorization foundation only
**Baseline HEAD:** `d0bb0e0dcfa169dad11f1fc3b21fd5b62eb986bd`
**Scope:** the AUTHORIZATION CONTRACT for PIC QR scanning. No QR validation, no API, no UI,
no check-in change, no database change.

This document is the written contract behind `lib/authz/pic-assignment.ts` and
`__tests__/authz/pic-assignment.test.ts`. Where this document and the code disagree, the code
and its tests are authoritative and this document is a defect.

---

## 1. Owner-approved decisions (B-1 … B-6)

| ID | Decision | Effect in Phase 3A |
|---|---|---|
| **B-1** | A PIC may scan tickets **only for events assigned to that PIC**. `PICProfile` must be `ACTIVE`; the `PICEventAssignment` for the exact event must have `isActive = true` and `revokedAt = null`. No assignment for another event grants anything. No organizer-wide or tenant-wide check-in authority is created. | Encoded in `decidePicEventPermission` and pinned by the matrix test. |
| **B-2** | The **public ticket code remains the admission credential** (consistent with D-46 Option A). The guarantee is: the ticket exists, belongs to the requested event, is in an eligible state, is not blocked by a refund, and the operation is authorized. It is **not** a proof of holder identity and **not** cryptographic QR authentication. No new secret token is introduced; no change to QR payload, issuance, wallet or credentials. | Recorded in §11 and in the module's header. No code change: 3A touches no ticket code. |
| **B-3** | The uncommitted `PIC_CHECKIN_SCAN_OWN` permission is **not** an acceptable foundation and is **replaced** by a dedicated assignment-based decider. | Removed from the vocabulary; `lib/authz/pic-assignment.ts` added. |
| **B-4** | A PIC may see the result of the scan **they just performed** (attendee name subject to data availability, ticket type, outcome, minimum necessary). A PIC may NOT see attendance lists, check-in history, other attendees' records, the attendance dashboard, another PIC's scan results, or hold `checkin.log.read`. | Policy only in 3A. No UI, no API, no permission granted. |
| **B-5** | Do **not** add `CheckIn.checkedInByPicProfileId`. Future PIC attribution should use the existing audit JSON mechanism where appropriate. No migration, no schema change, no audit write in 3A. | No schema, migration or audit change. |
| **B-6** | `tinggalklik_test` is approved for a **separately authorized future** DB-writing phase. **This** phase is DB-write-free: pure tests, static tests, read-only inspection, TypeScript checks only. | No database was contacted; the suite initialises no Prisma client. |

The B-1 amendment to the historical Phase 14 decision is recorded separately and
append-only: `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md`.

---

## 2. The PIC authorization predicate

```
ALLOW  iff
         userId is a non-empty string                              (authenticated actor)
     AND eventId is a non-empty string                             (a target event is named)
     AND picProfile exists
     AND picProfile.userId === userId                              (the profile is the actor's)
     AND picProfile.status === "ACTIVE"                            (the PIC is in good standing)
     AND assignment exists
     AND assignment.picProfileId === picProfile.id                 (the assignment is theirs)
     AND assignment.eventId === eventId                            (THE EXACT EVENT)
     AND assignment.isActive === true                              (boolean true, not truthy)
     AND assignment.revokedAt === null                             (not revoked)
```

Checked in that order. The first failing clause returns a deny; there is no clause whose
absence produces an allow.

Signature:

```ts
decidePicEventPermission(
    input: PicScanAuthorizationInput | null | undefined
): PicScanAuthorizationDecision

// allowed:  { allowed: true;  picProfileId: string }
// refused:  { allowed: false; code: AuthzErrorCode; reason: string }   // reason is server-side only
```

`PicScanAuthorizationInput` is `{ userId?, picProfile?, eventId?, assignment? }` — snapshots,
all `readonly`. It deliberately contains **no** organizer id, no membership list, no
`PermissionGrant`, and no `AuthzScope`, so there is no field through which a caller could
widen the answer.

---

## 3. PIC profile requirements

| Requirement | Refusal if unmet |
|---|---|
| A `PICProfile` exists for the authenticated user | `PIC_ACCESS_DENIED` (403) |
| `picProfile.userId` equals the session user id | `PIC_ACCESS_DENIED` (403) |
| `picProfile.status === "ACTIVE"` (`PENDING`, `SUSPENDED`, `REJECTED` all deny) | `PIC_ACCESS_DENIED` (403) |

Identity and standing are separate clauses on purpose: an account that owns a `PENDING`
profile is authenticated and is a PIC *applicant*, but has no scanning authority. `ACTIVE` is
the only passing value — the enum is compared exactly, never by truthiness.

Account-level deactivation (`User.disabledAt`) is **not** re-checked here. It is enforced
upstream: `resolveAuthzScope` returns `null` for a deactivated account, so no authenticated
`userId` reaches this decider at all. Duplicating it here would create a second, weaker
definition of "active account".

---

## 4. PIC event assignment requirements

| Requirement | Refusal if unmet |
|---|---|
| An assignment exists | `ORGANIZER_ACCESS_DENIED` (404) |
| `assignment.picProfileId` equals the resolved profile id | `ORGANIZER_ACCESS_DENIED` (404) |
| `assignment.eventId` equals the requested event id | `ORGANIZER_ACCESS_DENIED` (404) |
| `assignment.isActive === true` | `ORGANIZER_ACCESS_DENIED` (404) |
| `assignment.revokedAt === null` | `ORGANIZER_ACCESS_DENIED` (404) |

Two notes the schema makes load-bearing:

- `PICEventAssignment` has `@@unique([picProfileId, eventId])`, so "the assignment for this
  PIC and this event" names at most one row. There is no ordering or "most recent wins"
  question, and a re-assignment after revocation is a mutation of that row, not a new one.
- `revokedAt` is compared **strictly** against `null`. An `undefined` arriving from a partial
  `select` is refused rather than read as "not revoked". This is the fail-closed direction:
  a wrong `select` becomes a denial, not a grant.

`isActive` must be the boolean `true`. A truthy `1` or `"true"` is refused, so a JSON body or
an `unknown`-typed value cannot satisfy the clause.

---

## 5. Exact event-scope behaviour

Authority is a **pair** `(picProfileId, eventId)`, never a PIC alone and never an event alone.

- Assignment to event A authorizes event A and nothing else. Passing event B is refused even
  when the same PIC holds both assignments and only one was supplied.
- An assignment for event B never authorizes event A, in either direction of the mistake.
- There is no "assigned to the organizer" shortcut: the organizer id is not an input, so
  being assigned to one event in an organizer cannot be read as coverage of its siblings.
- There is no "any assignment" reading: a single mismatched `picProfileId` or `eventId`
  denies, and the row that fails is the row supplied.
- Scope is per request. The decider is stateless, so a revocation observed on the current
  call takes effect on that call; nothing is memoised between calls.

---

## 6. Deny-by-default rules

An unestablished, missing, partial or malformed state denies. Explicitly:

- no `input` at all → `ORGANIZER_ACCESS_DENIED` (404)
- missing / empty / whitespace-only / non-string `userId` → `UNAUTHORIZED` (401)
- missing / empty / whitespace-only / non-string `eventId` → `NOT_FOUND` (404)
- missing profile or profile without an id → `PIC_ACCESS_DENIED` (403)
- profile with no `userId`, or one that is not the actor's → `PIC_ACCESS_DENIED` (403)
- non-`ACTIVE` profile → `PIC_ACCESS_DENIED` (403)
- any assignment failure → `ORGANIZER_ACCESS_DENIED` (404)

**Why assignment refusals are 404.** `ORGANIZER_ACCESS_DENIED` already maps to HTTP 404 in
`lib/authz/errors.ts`, precisely so a non-member cannot use the response to learn whether a
tenant exists. Reusing it for "you have no assignment for this event" extends the same
masking to events: a PIC cannot distinguish "this event does not exist" from "this event is
not yours". Returning 403 for one and 404 for the other would rebuild the enumeration oracle
the tenant guard was built to remove.

Refusal `reason` strings are server-side detail. They may name a state (`PIC profile status
is SUSPENDED`, `assignment is for a different event`) and must never be rendered to a client
verbatim; the client sees the mapped HTTP status and the generic message.

---

## 7. Organizer authorization isolation

`decideOrganizerPermission` is **unchanged**, and this decider does not call it.

| Property | Status |
|---|---|
| `lib/authz/permissions.ts` permission maps | unchanged, except removal of the obsolete scan key (§14) |
| ADMIN / MANAGER gate behaviour | unchanged; they still authorize through membership + `checkin.scan` |
| PIC in `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC` | still empty (asserted by test) |
| PIC in `MEMBERSHIP_ROLE_PERMISSIONS.PIC` | still only `pic_attribution.read.all` |
| PIC in `PLATFORM_ROLE_OWN_PERMISSIONS.PIC` | no `checkin.scan`, no `checkin.override`, no `checkin.log.read` (asserted) |
| `OWN` scope semantics | unchanged; no new permission was added to `OWN_SCOPE` |
| `PermissionGrant` | not consulted by this decider; `checkin.scan` is not grant-required (asserted) |

A PIC holding an ACTIVE `OrganizerMember` row in the event's organizer **still** cannot scan:
`checkin.scan` is `ORGANIZER`-scope and absent from every PIC map. The test suite asserts
exactly that through the real `decideOrganizerPermission`, so the isolation is proved against
the shipped decider rather than against this decider's own assumptions.

The four wrong shapes the pre-implementation audit listed (§4.3) are therefore all
unreachable: `OWN` scope is not used; no PIC role map gained a capability; no grant path
exists; and "some assignment" is never read as "this event".

---

## 8. Manual override prohibition

PIC may **not** perform a manual check-in override. This is unchanged from Phase 14 and is
not expressible through Phase 3A:

- `checkin.override` is `ORGANIZER`-scope, held by ADMIN/OWNER/MANAGER roles, absent from
  every PIC map.
- The decider returns no capability string; there is no branch that could grant override.
- Phase 3A adds no endpoint, so there is no surface on which an override could be offered.

A manual override is a distinct authority from "the ticket in front of me was valid": it
admits a ticket the normal path refused, which is why it stays with the organizer.

---

## 9. Attendance log prohibition

PIC may **not** see the check-in log, attendance list, check-in history, or another PIC's
scan results. Unchanged from Phase 14.

- `checkin.log.read` is absent from every PIC map, and the test suite asserts the absence in
  `PLATFORM_ROLE_ORGANIZER_PERMISSIONS.PIC`, `PLATFORM_ROLE_OWN_PERMISSIONS.PIC` and
  `MEMBERSHIP_ROLE_PERMISSIONS.PIC`.
- No PIC-facing read surface exists in 3A, and the future surface is constrained by §10.
- `lib/dashboard/gates.ts` resolves gate events through `organizerIdsWith(scope,
  CHECKIN_SCAN)`, which is empty for a PIC by construction — so no PIC entry point appears
  through that path.

---

## 10. Own-scan-result visibility policy (B-4)

| Allowed | Not allowed |
|---|---|
| The scanned ticket's attendee name (subject to existing data availability) | Attendance lists |
| Ticket type | Check-in history |
| The scan outcome (admitted / already checked in / refused + reason) | Other attendees' records, including another PIC's scans |
| The minimum information necessary for the current scan | The organizer attendance dashboard |
| | `checkin.log.read` |

Reading: the policy authorizes the **echo of an action the PIC just took**, not a query. The
future UI may render the result it already has in hand; it may not fetch a list, page history,
or look up a ticket it did not just scan. This is why the policy needs no permission string:
there is no stored collection being read.

`ALREADY_CHECKED_IN` deserves one note: the existing gate response includes
`firstCheckedInBy` (another staff member's name). When a PIC surface is built (Phase 3E),
that field must be omitted for a PIC — B-4 permits seeing the outcome of one's own scan, not
who else scanned the ticket. This is a Phase 3E requirement, recorded here so it is not
rediscovered late.

---

## 11. Public ticket code: the guarantee, stated accurately (B-2)

**What the system validates** (today, and after Phase 3B):

1. the ticket exists;
2. it belongs to the requested event;
3. it is in an eligible state (`ISSUED`, not cancelled/void/refunded);
4. it is not blocked by a refund condition;
5. the operation is authorized (this contract, for a PIC; membership for staff).

**What it does NOT validate:**

- that the person presenting the code is its holder;
- that the QR is authentic or unforgeable;
- that the code was not copied from an email, a screenshot, or a shared wallet list.

The admission credential is `TICKET:<ticketCode>` — the public ticket code, per
`lib/ticketing/tickets/reference.ts` and the wallet QR built from it. The 256-bit secret is
generated at issuance, hashed into `Ticket.qrTokenHash`, and is never delivered to the buyer,
so it cannot be presented and is not compared at the gate. A public code proves *existence*,
not *authenticity*.

Owner decision B-2 accepts this (consistent with D-46 Option A). Consequences that must be
documented rather than hidden:

- Replay by someone else before the first scan is undetectable — the first presenter wins.
- `Ticket.qrVersion` cannot act as a revocation counter: nothing increments it and the raw
  token is unrecoverable. Only the first scan and the refund/void state protect admission.
- Phase 3A introduces no secret and changes no payload, issuance, wallet or credential code.
- Any later phase must not describe the QR as proving holder identity. If a real secret is
  ever required, it is a separate decision with a delivery mechanism, not a tweak here.

---

## 12. PIC attribution policy (B-5)

Phase 3A adds **no** attribution column and writes **no** audit record.

- No `CheckIn.checkedInByPicProfileId`; no migration; `prisma/schema.prisma` untouched.
- `CheckIn.checkedInByUserId` already records the actor, so a PIC's scan is attributable to a
  user today through the existing column plus `lib/ticketing/audit-log.ts`.
- Where a PIC-specific attribution is needed later, the owner's direction is the **existing
  audit JSON** mechanism, not a new column. Any future audit write must respect
  `FORBIDDEN_METADATA_KEYS` (no `qrtoken`, no `token`).
- The decider returns `picProfileId` on an allow so a future caller can attribute the scan
  without a second profile lookup — that is the whole reason it is in the result.

---

## 13. Future database test boundary (B-6)

- **Phase 3A:** no database contact of any kind. The suite imports no Prisma client and
  constructs no `AuthzScope` from a query; it is pure and asserts on snapshots.
- `tinggalklik_test` is approved for a **separately authorized** future phase. That approval
  does not extend to 3A, and 3A ran no migration, seed, reset, cleanup or DB-writing test.
- Any future integration test inherits the existing guard in
  `__tests__/support/test-database.ts` (explicit `TEST_DATABASE_URL`, application database
  refused) and the one-writer-per-database rule in `jest.config.js`.

---

## 14. Explicit exclusions from Phase 3A

Not done, and not authorized by this contract:

- QR payload, token, issuance, wallet or credential changes (B-2 keeps the current code);
- ticket validation, `CheckInMethod`, `CheckInResult`, or any check-in service logic;
- any PIC API route, scanner page or component;
- rate limiting, refund interaction, audit durability;
- a database column, migration, seed or DB-writing test;
- any change to organizer authorization semantics or to another role's permissions;
- any notification, payment or environment change.

One edit to `lib/authz/permissions.ts` **was** made, and it is a removal: the uncommitted
`PIC_CHECKIN_SCAN_OWN` key, its `OWN_SCOPE` entry, and its `PLATFORM_ROLE_OWN_PERMISSIONS.PIC`
entry were deleted (owner decision B-3). No other line in that file changed; the file is back
to its committed state. No replacement permission string was invented — the replacement is
the decider, which needs no string because it is not a tenant capability and cannot be
expressed by the scope machinery.

---

## 15. Future phase dependencies

| Phase | Depends on this contract for | Still needs owner input |
|---|---|---|
| 3B — validation/method labelling | the predicate that authorizes a PIC's scan | how `CheckInMethod.QR_SCAN` is labelled given B-2 (the code is not a secret) |
| 3C — check-in transaction | nothing new: the admission writer is unchanged and single | — |
| 3D — PIC scanner API | the decider's input/output and its refusal codes | where the PIC route lives and how the assignment is loaded |
| 3E — PIC scanner UI | §10 visibility, and the `canReadLog = false` decision | none beyond the UI itself |
| 3F — audit durability / rate limit | §12 attribution policy | whether audit JSON suffices, and the refusal-durability rule |
| 3G — integration tests | §13 boundary | explicit authorization to write to `tinggalklik_test` |

Phase 3A completion does **not** authorize Phase 3B. Each later phase starts from its own
explicit approval.

---

**Related documents**

- `docs/PHASE_3A_DECISION_AMENDMENT_PHASE_14_PIC_SCANNING.md` — the append-only amendment
- `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` — the historical decision being amended
  (§17 PIC Access, lines 538–551; decision record `P14-D18`, line 678)
- `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md` — the audit that produced B-1 … B-6
- `docs/PHASE_3A_EXECUTION_REPORT.md` — what was built and verified
