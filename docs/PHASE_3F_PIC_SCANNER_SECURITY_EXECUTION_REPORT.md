# PHASE 3F — PIC SCANNER SECURITY HARDENING EXECUTION REPORT

**Scope:** scan rate limiting, durable PIC attribution, scanner audit privacy.
**Verdict:** **PASS WITH LIMITATIONS**

---

## 1. Baseline Git state

```
repository /home/reksa/tinggalklik
branch     main
HEAD       9b8fecd99bcc74677c1805c18379241af04fddd1
staged     0
modified   9 tracked
untracked  42 paths (excluding .cloud-attachments/)
```

The 9 tracked modifications were the preserved Phase 3C/3D/3E and Phase 4 work:
`check-in-wiring.test.ts`, `service.ts`, `TicketScanner.tsx`, `app/dashboard/pic/page.tsx`,
`templates.ts`, `lock.ts`, `tick.ts`, `__tests__/jobs/tick.test.ts`,
`__tests__/notifications/purchase-proof-template.test.ts`. All are still present, unmodified
by Phase 3F except `service.ts`, which this phase extends. No reset, stash, checkout, restore,
clean, stage or commit was performed.

## 2. Pre-implementation audit

Read before changing anything: the master audit/roadmap, the Phase 3A–3E reports, the check-in
service, PIC decider, PIC API route, scanner UI, audit writer, rate limiter and schema.

Findings:

| Question | Answer |
|---|---|
| Existing scanner limit? | **None.** `checkInTicket` had no rate check; the PIC route calls it directly. |
| Existing limiter primitive? | `lib/rate-limit.ts` — in-process sliding window, named buckets. Per-instance only. |
| Rate-limit identity available? | `requireAuth()` scope (`userId`) and the authorized event id. No client identity needed. |
| Existing PIC attribution? | `CheckIn.checkedInByUserId` is `NOT NULL` and written from `scope.userId`; `checkedInByMemberId` is null for PIC. |
| Is a schema change needed? | **No.** `PICProfile.userId` is `@unique`, so the user id resolves the PIC profile permanently. |
| Audit writer append-only? | Yes — `db.adminAuditLog.create` only; no update/delete. |
| Existing audit payloads? | Success: status, eventId, method, gateLabel. Refusal: reason, result. No actor kind/profile id. |
| Prior evidence of real DB behaviour? | None in this phase; the earlier reports say the same. |

## 3. Exact files changed

| File | Change |
|---|---|
| `lib/rate-limit.ts` | **M** — exported `PIC_SCAN_MAX_REQUESTS`/`PIC_SCAN_WINDOW_MS` and the named `checkInScan(userId, eventId)` bucket |
| `lib/ticketing/checkin/pic-rate-limit.ts` | **NEW** — fail-closed guard; server-only identity; 429/503 errors with no identifiers |
| `lib/ticketing/checkin/service.ts` | **M** — runs the guard for PIC only, before the first query; adds `picProfileId` to access; adds `actorKind`/`picProfileId` to both audit payloads |
| `__tests__/ticketing-checkin/pic-scan-security.test.ts` | **NEW** — 16 tests (limiter behaviour + attribution/audit static boundaries) |
| `docs/PHASE_3F_PIC_SCANNER_SECURITY_EXECUTION_REPORT.md` | **NEW** — this report |

No route, UI, worker, transport, schema, migration or package change. Phase 4 files are
untouched and its 22 tests still pass.

## 4. Rate-limit design

**Bucket:** `checkin:pic:{session userId}:{authorized eventId}`, 120 requests per rolling
60 seconds (two per second sustained). One PIC's flood at one event cannot exhaust their
allowance at another event, and another PIC is a separate bucket.

**Placement:** inside `checkInTicket`, immediately after
`requireEventCheckInAccess(...)` and before `prisma.event.findUniqueOrThrow` / ticket lookup.
Therefore:

- unauthenticated or unauthorized requests fail in the existing access layer and consume no
  allowance;
- a permitted flood is stopped before it becomes a database probe;
- the organizer path (`actorKind === "ORGANIZER"`) is not rate-limited at all, preserving
  existing operator behaviour.

**Identity cannot be chosen by the client.** The guard accepts only `{ userId, eventId }`;
`userId` is the `requireAuth()` scope and `eventId` is `event.id` from the access decision.
`code`, `gateLabel`, `deviceId`, `clientScannedAt`, a submitted `picProfileId` or any other
body field never reaches the key. A planted extra property is not forwarded (tested).

**Fail-closed.** If the backing limiter throws, the scan is refused with
`503 SERVICE_UNAVAILABLE` / `RATE_LIMIT_UNAVAILABLE` rather than admitted. This is a
programming-error path, not the normal in-memory behaviour; a retryable 503 cannot be
mistaken for a successful admission, and the error contains no user id, event id, ticket code
or participant data.

**Errors.** `429 RATE_LIMITED` with `details: { reason: "PIC_SCAN_RATE_LIMITED",
retryAfterMs }`. No PII, no event title, no participant reference. `retryAfterMs` is at least
1 and at most the window.

**Known limitation.** The limiter is the repository's existing in-process store, so the
allowance is per Node instance and resets on restart. Multi-instance deployments would need a
shared store (the module already documents this for every bucket). The route layer does not
yet emit a `Retry-After` header; the delay is in the JSON error only.

## 5. PIC attribution implementation

**No migration was required, and none was written.**

- `CheckIn.checkedInByUserId` is `String` (NOT NULL) and is written from `scope.userId` in the
  admission transaction. That value originates in the authenticated session, never in the
  request body.
- `PICProfile.userId` is `@unique`, so `(checkedInByUserId, eventId)` identifies the PIC who
  scanned even after an event assignment is revoked.
- `CheckInAccess` now also carries `picProfileId` (`picProfile.id` for PIC, `null` for
  organizer). It is written into the **immutable** `AdminAuditLog` row for both accepted and
  refused scans.
- `checkedInByMemberId` remains organizer-only (`null` for PIC), so organizer attribution is
  unchanged.
- The admission path has no `checkIn.update` / `delete` call; `CheckIn` rows are append-only.
  Audit rows are likewise create-only. A later request cannot overwrite either.
- The client DTO (`CheckInRequestInput`) contains no actor, staff-member or profile field, and
  the service never reads `params.input.actor*`.

**Compatibility / rollback:** no column, index, enum or constraint changed, so there is
nothing to migrate or roll back. Old rows remain valid; their PIC is recoverable through
`checkedInByUserId` exactly as before, while new rows additionally carry `picProfileId` in
audit metadata.

## 6. Audit payload security review

Accepted admission (`checkin.success`):

```
beforeState: { status: "ISSUED" }
afterState:  { status: "CHECKED_IN", eventId, method, gateLabel, actorKind, picProfileId }
entityRef:   ticket.ticketCode
actor:       session scope (userId + platform role snapshot)
```

Refused scan (`checkin.rejected`):

```
afterState: { reason, result, actorKind, picProfileId }
entityRef:  normalized note (ticket code, or a classification such as
            UNRECOGNIZED_CODE_FORMAT — never the submitted string)
```

Verified boundaries:

- **No participant PII:** no attendee name/email/phone, holder phone, buyer data or document.
  The scanner's response may include the attendee name, but the audit payload does not.
- **No raw QR payload or secret:** the service parses/normalizes first; `entityRef` is the
  normalized ticket code or a fixed classification. `qrToken`, `qrTokenHash`, the raw URL and
  the raw scanned string are absent.
- **Scoped references:** event id, ticket code, session actor, and outcome only. Organizer
  tenant id comes from the resolved event, not from the client.
- **No authorization leakage:** authentication/authorization refusals are thrown before the
  refusal writer, so their reasons (`NO_STAFF_ASSIGNMENT`, `PIC_ACCESS_DENIED`, masked 404s)
  are not written into audit metadata. Recorded refusal reasons are ticket/gate-state codes
  only.
- **Not forgeable from the client:** the audit writer takes `actor` and tenant from resolved
  server state; request input has no actor field. The writer sanitizes secret-shaped keys
  (`token`, `qrcode`, `qrtoken`, `authorization`, `cookie`, …) as a second line of defence.
- **Append-only:** audit and check-in rows are created, never updated or deleted by this path.

## 7. Security threat analysis

| Threat | Control | Evidence |
|---|---|---|
| Scan flood by one PIC at one event | 120/min per (userId, eventId), before DB lookup | limiter tests, source order test |
| Rotating client identity/device fields to reset the bucket | Key uses only session user + authorized event | extra-property test, static assertions |
| Moving to another event to evade the limit | Authorization first; each event has its own bucket | independent-event test |
| One PIC locking out another PIC | Bucket is per user id | independent-identity test |
| Unauthenticated/unauthorized caller consuming allowance or probing tickets | Access resolution precedes the guard | ordering test + existing authz suites |
| Limiter failure silently disabling protection | Fail closed with 503, no identifiers | injected-throw test |
| Forged actor in the scan request | DTO has no actor; writer uses session scope | attribution tests |
| Overwriting attribution after the fact | No update/delete on CheckIn or audit; append-only | source assertions |
| Participant PII in audit | Audit payload carries no PII | payload block tests |
| Raw QR/token in audit | Normalized code/classification only; key filter | payload/source tests |
| Authorization oracle in refusal audit | Authz failures never reach the writer | reason-scope test |
| Multi-instance limit bypass | Not solved here; in-process store is per instance | documented limitation |
| Shared device with two PIC accounts | Distinct sessions → distinct buckets | identity test |
| One PIC using two devices | Shared allowance (intended: it is one actor) | design note |

## 8. Verification

Commands and exact results:

```
npx tsc --noEmit                          exit 0
npx eslint <4 Phase 3F files>             exit 0
npx jest --config /tmp/p3f.jest.json      exit 0
Test Suites: 11 passed, 11 total
Tests:       339 passed, 339 total
git diff --check                          exit 0
```

| Suite | Tests | Kind |
|---|---|---|
| `pic-scan-security.test.ts` (**new**) | **16** | pure limiter + static source boundaries |
| `pic-assignment` | 66 | pure/unit |
| `qr-payload-validation` | 76 | pure/unit |
| `check-in-transaction` | 50 | mocked Prisma (no DB) |
| `check-in-wiring` | 29 | static/unit |
| `pic-scan-api` | 24 | mocked route/service |
| `pic-scan-authz` | 20 | mocked Prisma |
| `qr-payload-contract` | 17 | static contract |
| `pic-scan-page` | 13 | static/unit |
| `route-classification` | 6 | pure/unit |
| `h36-reminder` (Phase 4 regression) | 22 | mocked/pure |

The new suite is explicitly **not** a real-database test. The limiter tests exercise the real
in-process store; the attribution/audit tests read source and schema to pin security
boundaries. The behavioural admission path is covered by the existing mocked transaction suite.

## 9. Real-database evidence

**None.** `TEST_DATABASE_URL` is not set, so no Prisma query ran and the DB-backed
integration suites were not executed. `prisma/schema.prisma` sha256 is unchanged
(`0f48e1cea685e9e33b87dd411712514b31605c07053fd89a92e0607f59ac4a99`), `prisma/` and
`prisma/migrations/` are clean, and no migrate/push/reset/seed/truncate was run.

Consequences: the real `UNIQUE` insert under concurrency, the real audit row shape and the
real admission transaction remain unproven against MariaDB. Phase 3G is the place for that.

## 10. Remaining work

1. Phase 3G — real-database verification (admission transaction, duplicate scan race, audit
   persistence, PIC attribution round-trip).
2. Distributed rate limiting if the app runs more than one instance (shared store).
3. `Retry-After` response header for 429s, if the scanner UI should honour it explicitly.
4. Rate-limit refusals are intentionally not audited (they would themselves be a write flood);
   revisit only with a sampled counter.
5. Live WhatsApp/email transport remains disabled; Phase 4 behaviour was not changed.
6. Phase 5 document distribution remains unimplemented.

## 11. Final Git state

```
HEAD 9b8fecd99bcc74677c1805c18379241af04fddd1   (unchanged)
branch main · staged 0 · modified 10 tracked · untracked 46 (excl. .cloud-attachments/)

M  lib/rate-limit.ts                                   (Phase 3F)
M  lib/ticketing/checkin/service.ts                    (3C/3D + Phase 3F)
M  __tests__/ticketing-checkin/check-in-wiring.test.ts (baseline 3C)
M  app/dashboard/pic/page.tsx                          (3E)
M  components/organizer/TicketScanner.tsx              (3E)
M  lib/jobs/lock.ts                                    (Phase 4)
M  lib/jobs/tick.ts                                    (Phase 4)
M  lib/notifications/templates.ts                      (Phase 4)
M  __tests__/jobs/tick.test.ts                         (Phase 4)
M  __tests__/notifications/purchase-proof-template.test.ts (Phase 4)

?? lib/ticketing/checkin/pic-rate-limit.ts             (Phase 3F)
?? __tests__/ticketing-checkin/pic-scan-security.test.ts (Phase 3F)
?? docs/PHASE_3F_PIC_SCANNER_SECURITY_EXECUTION_REPORT.md (Phase 3F)
?? … preserved Phase 2–4 reports and 3B–3E artifacts
```

No commit, push, deploy, tag, stage, amend, reset, stash, clean, checkout, restore or
migration. `.cloud-attachments/` was never read or modified.

## 12. Verdict

**PASS WITH LIMITATIONS** — PIC scanning now has a server-keyed, fail-closed rate limit and
durable, unforgeable attribution without a schema change, and the scanner audit payloads carry
no participant PII or QR secrets. The limit is per process (not distributed), and no real
database was available to prove persistence under concurrency; those are the Phase 3G
follow-ups, not defects introduced here.
