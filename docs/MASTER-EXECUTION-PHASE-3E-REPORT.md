# MASTER EXECUTION — PHASE 3E REPORT (PIC SCANNER UI)

**Feature:** #3 — move QR check-in scanner access from Manager to PIC (UI phase)
**Baseline:** `main` @ `9b8fecd99bcc74677c1805c18379241af04fddd1`, staged 0
**Verdict:** **PASS WITH LIMITATIONS**

---

## 1. Objective

Give an authorized PIC a phone-usable scan surface for an event they are assigned to, built on
the already-authorized Phase 3D endpoint (`POST /api/pic/events/[id]/check-in`), without
duplicating the camera pipeline, the admission transaction, or any authorization rule.

## 2. Baseline Git state

```
branch main · HEAD 9b8fecd99bcc74677c1805c18379241af04fddd1
staged 0
M lib/ticketing/checkin/service.ts                        (Phase 3C, preserved)
M __tests__/ticketing-checkin/check-in-wiring.test.ts     (Phase 3C, preserved)
untracked: Phase 2–3D reports, 3B/3C modules, 3D route and suites
```

Recorded before editing in `docs/MASTER-BASELINE-MANIFEST.md`. Nothing was reset, stashed,
checked out, restored or cleaned; `.cloud-attachments/` was not touched.

## 3. Scope

**In:** the PIC scanner page, an endpoint override on the existing scanner, a PIC-only page
guard, server-side suppression of another operator's identity in a duplicate response, a scan
entry point on the PIC dashboard, and a focused guard suite.

**Out:** camera/decoder changes, offline mode, rate limiting, audit expansion, schema, live
delivery, document blast, and any Phase 3F/3G work.

## 4. Files inspected

`components/organizer/TicketScanner.tsx`; `components/organizer/api.ts`;
`app/dashboard/events/[id]/check-in/page.tsx`; `app/dashboard/pic/page.tsx`;
`app/dashboard/pic/[id]/page.tsx`; `app/dashboard/layout.tsx`;
`app/api/pic/events/[id]/check-in/route.ts`; `lib/ticketing/checkin/service.ts`
(guard, refusal, success shape, list); `lib/ticketing/checkin/validation.ts`;
`lib/authz/pic-assignment.ts`; `lib/authz/index.ts`; `lib/events/sales-state.ts`;
`lib/pic/self-service.ts` (assignment row shape); `proxy.ts`; existing check-in/scanner suites.

## 5. Files modified

| File | Change |
|---|---|
| `app/dashboard/pic/scan/[eventId]/page.tsx` | **NEW** — server-authorized PIC scanner page (166 lines) |
| `lib/ticketing/checkin/service.ts` | `CheckInAccess.actorKind`, `requirePicScanAccess`, PIC duplicate detail suppression |
| `components/organizer/TicketScanner.tsx` | optional `endpoint` prop; organizer default unchanged |
| `app/dashboard/pic/page.tsx` | "Pindai tiket" link for active assignments |
| `__tests__/ticketing-checkin/pic-scan-page.test.ts` | **NEW** — 13 guards |

No schema, migration, environment, package, or route-classification change.

## 6. Design decisions

1. **Page + prop, not a fork.** `docs/PHASE_3_PRE_IMPLEMENTATION_AUDIT.md:729-751` concluded the
   PIC surface should reuse `TicketScanner`; the only difference is the endpoint. The component
   keeps every camera, throttle and cleanup behaviour, so the staff gate cannot regress.
2. **A PIC-only page guard.** `requireEventCheckInAccess` prefers the organizer path and falls
   back only after a tenant refusal — correct for the API, wrong for a PIC-only page (an
   organizer member would pass). `requirePicScanAccess` asks only the Phase 3A question and
   throws a masked `ORGANIZER_ACCESS_DENIED` (404), which the page maps to `notFound()`.
3. **Denial is 404, not an access panel.** Unassigned, revoked, inactive, foreign and unknown
   events must be indistinguishable, so the page cannot be used to enumerate events.
4. **Window from the server clock.** `isEventCheckInOpen` is the canonical predicate; the page
   passes `OPEN | GRACE | CLOSED` to the device and renders no scanner when closed.
5. **No attendance surface.** `canReadLog={false}` removes the list, its fetch and its refresh;
   `initialItems`/`initialTotal` are empty constants. The page never calls `listEventCheckIns`.
6. **No other operator identity.** The service now tags access as `ORGANIZER` or `PIC` and
   returns `firstCheckedInBy: null` for a PIC on an already-checked-in ticket. Client-side
   hiding alone would still ship the name in the response.
7. **Discoverability without a new hub.** Active assignments in "Event Saya" link to the page;
   revoked ones render no link (and a direct URL still 404s).

## 7. Implementation details

- Page flow: `params.eventId` → `requirePicScanAccess` (session profile + compound assignment
  lookup + `decidePicEventPermission`) → narrow event select → `isEventCheckInOpen` → shared
  scanner with `endpoint={`/api/pic/events/${event.id}/check-in`}`.
- `requirePicScanAccess` delegates to the existing `requirePicCheckInAccess` — the same PIC
  branch the API uses — so there is one authorization implementation, not a page copy.
- Scanner: `const endpoint = endpointProp ?? `/api/organizer/events/${eventId}/check-in``.
  Nothing else in the component changed.
- Service duplicate refusal: the details object still carries `ticketCode`, `firstCheckedInAt`
  and `firstGateLabel`; only the actor name is withheld from a PIC.

## 8. Security review

| Question | Result |
|---|---|
| Can a non-PIC reach the page? | No — PIC-only guard; organizer members get 404 |
| Can a PIC scan at an unassigned event? | No — assignment is read by the URL event id; 404 |
| Can the client supply user/assignment/role? | No — the page accepts only the route event id, used for lookup |
| Can the page bypass the API's checks? | No — the POST re-authorizes on every scan (3D) |
| Does a PIC see the attendance log? | No — `canReadLog={false}`, no list call |
| Does a PIC see another operator's name? | No — service nulls `firstCheckedInBy` for PIC |
| Can a scan be replayed by holding the QR? | Only per existing server CAS; the client cooldown is UX only |
| Does the camera release on navigation? | Yes — existing unmount cleanup + `visibilitychange` |
| Is the gate open decided by the browser clock? | No — server predicate; the device only displays the state |
| Any secret/token/contact in the page? | No |

## 9. Tests and exact results

DB-free Jest config (`/tmp/p3e.jest.json`, outside the repo) because the repository's default
setup requires `TEST_DATABASE_URL`, which is not set. `--runInBand --json`:

```
Test Suites: 9 passed, 9 total
Tests:       301 passed, 301 total
```

| Suite | Tests |
|---|---|
| `pic-assignment.test.ts` (3A) | 66 |
| `qr-payload-validation.test.ts` (3B) | 76 |
| `check-in-transaction.test.ts` (3C) | 50 |
| `check-in-wiring.test.ts` (13/3C) | 29 |
| `pic-scan-authz.test.ts` (3D) | 20 |
| `pic-scan-api.test.ts` (3D) | 24 |
| `qr-payload-contract.test.ts` | 17 |
| `route-classification.test.ts` | 6 |
| **`pic-scan-page.test.ts` (3E, new)** | **13** |

The new suite is correctly labelled a **source guard**, not a DOM or database test. The
`pic-scan-api` suite intentionally logs a correlation id and a fake DSN on its 500-path test;
no real credential is involved.

## 10. TypeScript and lint

```
npx tsc --noEmit                 exit 0
npx eslint <5 changed/new files> exit 0
git diff --check                 exit 0
```

No `any`, `@ts-ignore`, lint suppression, or weakened assertion was added.

## 11. Database evidence

**None, deliberately.** No Prisma query was executed; `TEST_DATABASE_URL`/`DATABASE_URL` are not
set. `prisma/schema.prisma` sha256 `0f48e1ce…ac4a99` is unchanged, `git status -- prisma/` is
empty, and no migrate/push/reset/seed/truncate ran. The page's real assignment lookup is
exercised only by mocked Prisma (3D suite); live behaviour is Phase 3G's.

## 12. Limitations

1. **No rendered-DOM test** — the repository has no React testing library; page properties are
   pinned by source guards. Camera behaviour remains covered by the existing scanner suites.
2. **No real-database read** — the compound assignment lookup and masked 404 against MariaDB
   are unverified (3G).
3. **Identity suppression is source-guarded**, not proven through a full transactional PIC
   duplicate scan.
4. **No rate limit** — a PIC can submit as fast as the client allows until Phase 3F.
5. **Window labeling** duplicates five lines of the organizer page's derivation; the canonical
   predicate is shared, but the `OPEN/GRACE` mapping is not extracted (intentionally, to avoid
   touching the working staff page).
6. **No PIC attribution** — `CheckIn` still records the user, not the PIC profile (3F).

## 13. Remaining work

- **3F:** scan rate limit, durable PIC attribution, audit payload review.
- **3G:** disposable MariaDB, real assignment lookups, two-connection race, rollback, masked 404.
- **Feature 1:** H-36 reminder engine (dry-run) — see roadmap.
- **Feature 4:** document blast — needs an approved schema/storage design.
- **OPS:** live SMTP/WhatsApp activation (owner).

## 14. Final Git state

```
HEAD 9b8fecd99bcc74677c1805c18379241af04fddd1   (unchanged)
branch main · staged 0
M lib/ticketing/checkin/service.ts
M components/organizer/TicketScanner.tsx
M app/dashboard/pic/page.tsx
M __tests__/ticketing-checkin/check-in-wiring.test.ts   (baseline 3C)
?? app/dashboard/pic/scan/[eventId]/page.tsx
?? __tests__/ticketing-checkin/pic-scan-page.test.ts
?? docs/MASTER-*.md (manifest, audit, roadmap, this report)
```

No commit, push, deploy, tag, stage, amend, reset, stash, clean, checkout or restore. No
previous phase report was edited; `.cloud-attachments/` was untouched.

## 15. Final verdict

**PASS WITH LIMITATIONS** — the PIC scanner page is server-authorized through the Phase 3A
decider, posts only to the Phase 3D endpoint, reuses the proven device, and exposes neither the
attendance log nor another operator's identity. The limitations are evidence-scope (no DOM test,
no real database), not authorization or product gaps.
