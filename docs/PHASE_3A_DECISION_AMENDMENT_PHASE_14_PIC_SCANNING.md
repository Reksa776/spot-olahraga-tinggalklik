# Decision Amendment — Phase 14 Event Lifecycle Lock: PIC QR Scanning

**Amendment ID:** P14-AMEND-01
**Date:** 2026-11-06
**Amends:** `PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` — **§17 PIC Access** (lines 538–551)
and the locked record **`P14-D18`** (line 678). The matrix it reproduces is design **§6.3**
(`TICKETING_PHASE1_DESIGN.md`), quoted at lock line 540.
**Approved by:** Owner (Phase 3A authorization, decision B-1)
**Status:** ACTIVE — narrow, event-scoped exception only

> **This document is append-only.** It does not edit, rewrite or delete the Phase 14 lock.
> The lock stands as written, including the row this amendment qualifies, and this file is
> the record of the single, owner-approved exception to it. Anything not named here as
> changed remains in force.

---

## 1. The historical decision being amended

`PHASE_14_EVENT_LIFECYCLE_DECISION_LOCK.md` **§17 PIC Access** (lines 538–551) records, as a
**locked** decision, that the following capabilities are **NO** for a PIC. The lock states it
by quoting the design matrix — **§6.3** of `TICKETING_PHASE1_DESIGN.md`, reproduced verbatim
at lock line 540 — and captures the outcome as the decision record **`P14-D18`** (line 678):

| Capability (design §6.3 row) | Locked answer |
|---|---|
| Scan / validate QR | **NO** |
| Manual check-in override | **NO** |
| View check-in log | **NO** |

That lock also forbids passing a PIC through the check-in guard without a deliberate design
change (lock line 551). The rationale was that gate operation is organizer staff work, that a
PIC is an external referrer rather than staff, and that the check-in path had no PIC-scoped
authority that could express "this event and no other".

**That text is unchanged and remains the historical record.** Reading lock §17 and `P14-D18`
today, unamended, must still yield the original answer.

---

## 2. What changes (exactly one row)

| Capability (design §6.3 row) | Locked answer | Amended answer |
|---|---|---|
| Scan / validate QR | NO | **YES — only for events assigned to that PIC, and only while the profile and the assignment are both active** |
| Manual check-in override | NO | **NO — unchanged** |
| View check-in log | NO | **NO — unchanged** |

The exception is a **capability**, not a role: it is created by an active PIC assignment to a
specific event, and it disappears when that assignment is deactivated or revoked, or when the
PIC profile stops being `ACTIVE`.

---

## 3. The new rule, stated completely

A PIC may perform a **QR ticket scan** at event *E* if and only if:

1. the actor is authenticated;
2. they hold a `PICProfile` whose `userId` is their own account;
3. that profile's `status` is `ACTIVE` (`PENDING`, `SUSPENDED`, `REJECTED` deny);
4. a `PICEventAssignment` exists for **that profile and event *E***;
5. that assignment has `isActive = true`;
6. that assignment has `revokedAt = null`.

Any other combination denies. The rule is implemented once, purely, in
`lib/authz/pic-assignment.ts#decidePicEventPermission` and is pinned row by row in
`__tests__/authz/pic-assignment.test.ts`. The written contract is
`docs/PHASE_3A_AUTHORIZATION_CONTRACT.md`.

---

## 4. What does NOT change

Every prohibition below survives this amendment intact:

- **Manual check-in override is still NO for a PIC.** Override admits a ticket the normal path
  refused; it stays with organizer staff holding `checkin.override`.
- **Attendance / check-in log access is still NO for a PIC.** No `checkin.log.read`, no
  attendance list, no check-in history, no attendance dashboard, no access to another PIC's
  scan results.
- **Organizer-wide check-in authority is still not granted.** A PIC does not become an
  `OrganizerMember`, gains no `checkin.scan` capability, and gains nothing from membership
  even if one exists.
- **Cross-event scanning is still forbidden.** An assignment for event A authorizes event A
  only. Having *an* assignment is never the same as having *this* assignment.
- **No tenant-wide or platform-wide authority is created.** The PIC role maps remain without
  any check-in capability, and `PermissionGrant` remains irrelevant to this authority.
- **No other row of that locked matrix is touched**, for PIC or for any other role.
- **ADMIN and MANAGER gate behaviour is unchanged.**

---

## 5. What this amendment does NOT decide

- It does **not** decide the credential question (owner decision B-2: the public ticket code
  remains the admission lookup credential, and the QR does not prove holder identity).
- It does **not** authorize Phase 3B–3G. Each later phase needs its own approval.
- It does **not** create a PIC-facing UI, API route or attendance surface.
- It does **not** add a database column, migration or attribution field.

---

## 6. Superseded artifact

The uncommitted permission `pic.checkin.scan.own` (`PIC_CHECKIN_SCAN_OWN`) was an earlier,
rejected attempt to express this capability. It is **removed** (owner decision B-3): it was
classified `OWN`-scope, a scope that cannot express an event assignment, so
`decideOrganizerPermission` denied it unconditionally and no consumer could have used it. It
is replaced — not extended — by the dedicated decider named in §3. It must not be re-added.

---

## 7. Precedence

For PIC QR scanning, this amendment is authoritative and the scan row of lock §17 / `P14-D18`
is read as amended. For every other capability, lock §17 and `P14-D18` govern exactly as
written. If this document and `docs/PHASE_3A_AUTHORIZATION_CONTRACT.md` ever disagree, the
contract governs and this file is corrected by a new amendment — never by editing the lock.
