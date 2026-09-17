# TICKETING PHASE 4 REPORT

**TinggalKlik.Co — Event + Venue + Sport + Public Catalog**

| Field | Value |
| --- | --- |
| Repository | `demo-marketplace` |
| Branch | `main` |
| Date | 2026-09-16 |
| Baseline documents | `TICKETING_REBUILD_AUDIT.md`, `TICKETING_PHASE1_DESIGN.md`, `TICKETING_PHASE2_REPORT.md`, `TICKETING_PHASE2_5_REPORT.md`, `TICKETING_PHASE3_REPORT.md` |
| New file this phase | `TICKETING_PHASE4_REPORT.md` (this file) |
| Commit / push | **NONE** |

---

## 1. Status

```text
PHASE 4 STATUS: PASS WITH WARNINGS
```

Phase 4 is complete and verified: the event/venue/sport domain, its tenant-scoped
authorization, the EXIF-stripping image pipeline and the public catalog all work, every
required command was run, and no Phase 4 test fails. The status is "with warnings"
rather than plain PASS for the three items in §14 — the most substantive being that the
**publish precondition depends on `TicketType`, which Phase 5 owns**, so "publish an
event today" is reachable only through the schema foundation, not through any Phase 4
UI. That is the correct phase boundary and not a defect, but it is a real functional
limit on what an operator can do at the end of this phase, so it is stated plainly
rather than buried.

### 1.1 What was actually verified (not assumed)

| Check | Command | Result |
| --- | --- | --- |
| Prisma schema | `npx prisma validate` | ✅ valid |
| Prisma client | `npx prisma generate` | ✅ v6.19.3 generated |
| Migration state | `npx prisma migrate status` | ✅ 18 migrations, "Database schema is up to date!" |
| Migration drift | `npx prisma migrate diff` (DB ⇄ schema) | ✅ only the pre-existing Phase 2.5 cosmetic legacy `voucher*` index/FK-name casing (§5.4) |
| TypeScript | `npx tsc --noEmit` | ✅ exit 0, zero errors |
| Phase 4 tests | `npx jest __tests__/events __tests__/images __tests__/venues --runInBand` | ✅ 8 suites, 206 tests, 206 passed |
| Route classification | `npx jest __tests__/authz/route-classification.test.ts` | ✅ 6 tests passed — 132/132 API routes classified |
| Full suite | `npx jest --runInBand` | ✅ 38 suites, **6 failed**; 903 tests, **2 failed**, 901 passed — same 6 suites and same 2 tests as the Phase 3 baseline |
| Sports seed idempotency | `npx tsx prisma/seed-sports.ts` ×2 | ✅ 14 sports before and after the second run |
| EXIF end-to-end | real GPS-tagged JPEG through `processAndStoreEventImage`, read back from disk | ✅ GPS / EXIF / XMP markers absent from the stored bytes |
| Live DB residue | direct Prisma counts | ✅ 0 events, 0 venues, 0 organizers, 0 ticket types; retail data intact |

---

## 2. Scope

Phase 4 implemented exactly the event/venue/sport domain and its public catalog surface.

**Implemented**

1. **Event CRUD** — organizer-scoped create / read / update / archive, with slug
   generation/validation, Zod input validation and audit logging.
2. **Event lifecycle** — `DRAFT → PUBLISHED → DRAFT` (unpublish), with an enforced set of
   publish preconditions and guarded transitions.
3. **Event images** — validated upload, server-side metadata stripping, server-generated
   filenames, ordering, deletion, and public serving of the *processed* bytes only.
4. **EXIF/GPS stripping** — a dependency-free allow-list metadata stripper for JPEG, PNG
   and WebP (decision D-55).
5. **Event slug + sharing** — unique, normalized, collision-safe public slug, a canonical
   public URL, and a share endpoint returning copy/WhatsApp/social-ready links.
6. **Venue CRUD** — both ownership classes from D-64 (platform-global and organizer-private)
   on genuinely separate authorization paths.
7. **Venue deletion safety** — refused while any event references the venue, so event
   history cannot be silently blanked.
8. **Sport foundation** — reuses the Phase 2 seeded taxonomy (14 rows, no duplication);
   public read only, mutation requires a platform-scope permission.
9. **Public catalog** — paginated, filterable, sortable listing restricted to published
   events, exposing no tenant or commercial internals.
10. **Public detail** — slug-addressed detail with the D-14 unavailable read-only state.
11. **Authorization & tenant isolation** — every organizer-scoped operation resolves
    authority from an ACTIVE `OrganizerMember` row through the Phase 3 `lib/authz/` layer.
12. **Tests** — 206 new tests across 8 suites (pure, integration and source-analysis).
13. **Feature-flag posture** — see §14.3; the repository has no flag mechanism and the
    brief says not to invent one, so the new surfaces are additive new routes/pages and
    nothing on the legacy retail surface was replaced.

**Not implemented (boundary respected)** — see §15 for the explicit confirmation list.

---

## 3. Business decisions

All four decisions were treated as LOCKED.

### 3.1 D-13 — Event approval workflow: **SELF-PUBLISH**

Implemented as self-publish. An actor holding `event.publish` publishes directly; there
is **no** approval queue, **no** admin review step, and **no** `PENDING_REVIEW` state was
added. `EventStatus` still has exactly the values Phase 2 defined — no enum was extended
"because the design mentioned it as a possible future option".

### 3.2 D-14 — Unpublish behavior: **hide + preserve read-only page**

Implemented exactly:

* Unpublishing sets the event back to `DRAFT` (data preserved, nothing deleted).
* The event disappears from normal catalog listings — the catalog query hard-codes
  `status: "PUBLISHED"` and never reads a caller-supplied status.
* Direct detail **still resolves** by slug and returns the event with
  `isAvailable: false` and an `unavailableReason` ("Event ini sedang tidak
  dipublikasikan."), so the page renders a clearly unavailable read-only state.
* Nothing touches orders, tickets, payments or refunds — Phase 4 added no code path that
  can cancel an order or void a ticket. (Order/ticket counts are only *read*, and only to
  refuse deletion.)
* `CANCELLED` behaves the same way with its own reason ("Event ini telah dibatalkan.").
* `ARCHIVED` is excluded from public detail entirely (`isAvailable` is not even reached) —
  archival is the "gone" state, unpublished is the "temporarily not for sale" state.

### 3.3 D-55 — EXIF stripping: **YES, at MVP**

Implemented in `lib/images/`. Key properties:

* **Server-side and allow-list based.** The stripper keeps only the container-level
  segments that carry image structure (SOI, JFIF/APP0, DQT, SOF, DHT, SOS, scan data,
  EOI for JPEG; IHDR/PLTE/IDAT/IEND for PNG; VP8/VP8L/ALPH/ANIM for WebP) and **drops
  everything else by default** — APP1/Exif, APP1/XMP, COM, PNG `tEXt`/`eXIf`/`tIME`/`gAMA`/`sRGB`,
  WebP `EXIF`/`XMP` chunks. Everything not on the allow-list is removed, so a metadata
  format nobody anticipated is removed too.
* **The original bytes are never written.** Stripping happens in memory and only the
  processed buffer is written, so there is no window in which an unstripped file exists
  at a servable path, and no cleanup step is needed to avoid one.
* **Reject, not repair.** Unsupported containers and malformed structures raise and
  write nothing; a stripped output that no longer parses as its own container is treated
  as an internal error rather than stored.
* **No new dependency.** No image library was added; the stripper is ~430 lines of
  format parsing. `package-lock.json` is unchanged by Phase 4 (its modification
  pre-dates Phase 4).

### 3.4 D-64 — Venue ownership: **BOTH**

Implemented as two genuinely different authorization paths, not a flag:

| Class | Ownership | Create/mutate requires | Who holds it |
| --- | --- | --- | --- |
| Platform-global | `organizerId: null` | `venue.manage.global` (platform scope) | platform `ADMIN` only |
| Organizer-private | `organizerId: <organizerId>` | `venue.manage` for **that** organizer | members of that organizer |

Neither path can do the other's work: the organizer namespace requires an `organizerId`,
so it cannot mint a global venue; the global namespace does not read `organizerId` from
the request at all, so it cannot mint or adopt a private one. Global venues are readable
as a shared catalog (that is their purpose) but are not editable by organizer members.

---

## 4. Files changed

### 4.1 Prisma / schema / migrations

**NONE.**

Phase 4 added **no** schema change and **no** migration. This is the brief's preferred
outcome (§6: "If the existing schema already contains the required Phase 4 models/fields,
do NOT create duplicates"). `git diff --stat -- prisma/schema.prisma` still reports
exactly the Phase 2 `1419 insertions(+)`, and `prisma/migrations/` still holds the same 18
migrations Phase 2.5 verified. The Event, EventImage, Venue and Sport models from Phase 2
already carried every field Phase 4 needed — including `Event.eventCode`, `Event.status`,
`Event.publishedAt`, `Event.archivedAt`, `Event.visibility`, `Venue.province`,
`TicketType.quota/sold/reserved` and the `EventImage` ordering column.

### 4.2 authz / security

| File | Change |
| --- | --- |
| `lib/authz/permissions.ts` | **modified** — added `VENUE_MANAGE_GLOBAL` (`venue.manage.global`) and classified `SPORT_MANAGE` + `VENUE_MANAGE_GLOBAL` as **platform-scope** permissions, granted to `ADMIN` only. This is the D-64 seam: it is the first platform-scope *catalog* permission, so it was declared rather than inferred. |
| `lib/api/errors.ts` | new — `AppError` + the design §25.1 error-code registry |
| `lib/api/response.ts` | new — response envelope + `handleApi` wrapper (maps `AppError` and `AuthzError` to HTTP) |
| `lib/api/validation.ts` | new — `parseOrThrow` Zod helper producing the standard field-error shape |
| `proxy.ts` | **modified** — classified the 17 new API routes (§10) |

### 4.3 Services

| File | Change |
| --- | --- |
| `lib/events/service.ts` | new — organizer event CRUD, publish/unpublish, archive, slug resolution, audit |
| `lib/events/catalog.ts` | new — public catalog + public detail queries, `isAvailable`/`unavailableReason` |
| `lib/events/access.ts` | new — `requireEventAccess`, `requireVenueCreate/Read/Manage`, scoped lookups |
| `lib/events/slug.ts` | new — slugify + uniqueness/collision handling |
| `lib/events/validation.ts` | new — Event Zod schemas (create/update/list/detail) |
| `lib/events/images.ts` | new — per-event image list/add/remove, cap enforcement, audit |
| `lib/events/sales-state.ts` | new — pure `summarizeSales` used by the publish precondition |
| `lib/venues/service.ts` | new — venue list (global + readable private), create/update/delete with D-64 split |
| `lib/venues/validation.ts` | new — Venue Zod schemas |
| `lib/sports/service.ts` | new — public sport list, platform-scoped create/update/delete |
| `lib/sports/validation.ts` | new — Sport Zod schemas |
| `lib/ticketing/audit-log.ts` | new — `writeTicketingAudit`, a Phase-4-local audit writer |
| `lib/organizer/context.ts` | new — server-component organizer context (reuses `getAuthzScope`) |
| `lib/app-origin.server.ts` | new — server-side origin resolution for canonical URLs |

### 4.4 API

17 new route files — enumerated with their guards in §10 and §11.

### 4.5 UI

| File | Change |
| --- | --- |
| `app/events/page.tsx` | new — public catalog (filters, sort, pagination) |
| `app/e/[slug]/page.tsx` | new — public detail incl. D-14 unavailable state + share menu |
| `app/organizer/layout.tsx` | new — organizer back-office shell |
| `app/organizer/events/page.tsx`, `events/new/page.tsx`, `events/[id]/page.tsx` | new — event list / create / manage |
| `app/organizer/venues/page.tsx` | new — organizer venues (global read-only + own private) |
| `app/platform/layout.tsx`, `platform/sports/page.tsx`, `platform/venues/page.tsx` | new — platform admin surfaces |
| `components/events/EventCard.tsx`, `ShareEventMenu.tsx` | new |
| `components/organizer/api.ts`, `EventForm.tsx`, `EventActions.tsx`, `EventImageManager.tsx`, `VenueManager.tsx` | new |
| `components/platform/GlobalVenueManager.tsx`, `SportManager.tsx` | new |

**Why `/platform` and not `/admin`:** the existing `app/admin/layout.tsx` gates on the
*legacy retail* role (`session.user.role !== "ADMIN"`). Phase 3 deliberately wrote no
bridge from that column to a platform privilege, so the ticketing admin surfaces live
under `/platform` and authorize on the platform-scope permissions they actually need. No
retail admin route or page was modified. This is documented in the layout file itself.

### 4.6 Image processing

`lib/images/format.ts`, `lib/images/strip-metadata.ts`, `lib/images/process.ts` — all new.
No new npm dependency. `package-lock.json` was **not** touched by Phase 4.

### 4.7 Tests

| File | Kind | Tests |
| --- | --- | --- |
| `__tests__/events/slug.test.ts` | pure | slugify, normalization, collision |
| `__tests__/events/sales-state.test.ts` | pure | sales window / sellable-quota summary |
| `__tests__/images/fixtures.ts` | fixtures | hand-built JPEG/PNG/WebP with real EXIF/GPS/XMP |
| `__tests__/images/strip-metadata.test.ts` | pure | per-format stripping, spoofed payloads |
| `__tests__/images/process-and-store.test.ts` | **on-disk** | stored bytes have no metadata; rejection writes nothing |
| `__tests__/images/upload-rate-limit.test.ts` | behavioral + source scan | upload bucket policy; the route consults it before parsing the body |
| `__tests__/events/event-service.integration.test.ts` | **real DB** | event CRUD, lifecycle, isolation, delete guards |
| `__tests__/events/catalog.integration.test.ts` | **real DB** | visibility rules, pagination/filter/sort, leak-freedom |
| `__tests__/venues/venue-and-sport.integration.test.ts` | **real DB** | D-64 ownership, cross-tenant denial, sport authorization |
| `jest.config.js` | config | **modified** — `testMatch` extended so the new suite directories actually run |

### 4.8 Documentation

`TICKETING_PHASE4_REPORT.md` (this file).

---

## 5. Database changes

### 5.1 Migration

```text
Migration: NONE
```

### 5.2 Tables / columns / indexes / constraints changed

**NONE.** Additive by definition — nothing was added, so nothing could be destructive.

### 5.3 Why no migration was correct here

Every field Phase 4 needs was already created by the Phase 2 `ticketing_phase2_foundation`
migration:

* `Event` — `organizerId`, `sportId`, `venueId`, `title`, `slug`, `description`,
  `startAt`, `endAt`, `status`, `visibility`, `publishedAt`, `archivedAt`, `bannerUrl`,
  `eventCode`, plus the `organizerId+status`, `organizerId+startAt`, `slug`, and
  public-discovery indexes the catalog uses.
* `EventImage` — event relation, storage URL, alt text, ordering, `isPrimary`.
* `Venue` — nullable `organizerId` (the D-64 seam), name, address, city, province,
  geo, capacity.
* `Sport` — name, unique slug, icon, `sortOrder`, `isActive`.
* `TicketType` — `eventId`, `price`, `quota`, `sold`, `reserved`, `isActive`,
  `salesStartAt`, `salesEndAt` — read (only) by the publish precondition.

Creating a second set of tables for any of these would have violated the brief's explicit
"do not create duplicate models".

### 5.4 Migration verification

```text
npx prisma validate        → The schema at prisma/schema.prisma is valid 🚀
npx prisma generate        → ✔ Generated Prisma Client (v6.19.3)
npx prisma migrate status  → 18 migrations found; Database schema is up to date!
npx prisma migrate diff    → residual drift limited to the pre-existing
                             cosmetic legacy voucher* index/FK-name casing
                             documented in Phase 2.5 §11
```

That residual diff is **not Phase 4's** and is unchanged from the state Phase 2.5 left
behind: it is case-only renames on four legacy retail `voucher*` tables' index and
foreign-key *names*, with identical columns, types, nullability and constraints. It was
classified and accepted in Phase 2.5 and has not been re-opened here.

Confirmation that the live schema really does support what Phase 4 writes: the
integration suites create and read `Event`, `EventImage`, `Venue` and `Sport` rows
against the live database, and they pass.

---

## 6. Event lifecycle

### 6.1 States and transitions

```text
   DRAFT ──publish──► PUBLISHED ──unpublish──► DRAFT
     │                    │
     │                    ├──► CANCELLED   (terminal for public purposes)
     │                    └──► COMPLETED   (terminal for public purposes)
     └──────── archive ───┴──► ARCHIVED    (hidden from public detail entirely)
```

| Transition | Guard/permission | Valid from | Effects |
| --- | --- | --- | --- |
| create | `event.write` on the target organizer | — | `eventCode` + unique slug assigned, status `DRAFT` |
| publish | `event.publish` | `DRAFT` only | preconditions checked, `publishedAt` set (first publish only), becomes catalog-visible |
| unpublish | `event.publish` | `PUBLISHED` only | status → `DRAFT`, leaves the catalog, `publishedAt` preserved |
| update | `event.write` | any non-archived | slug re-resolved if the title changes |
| archive | `event.write` | not `ARCHIVED` | `archivedAt` set; public detail 404s; blocked while orders/tickets exist |
| delete | `event.write` | not `ARCHIVED` | only if no orders **and** no tickets |

### 6.2 Invalid transitions (explicitly refused)

* publish when already `PUBLISHED` → `CONFLICT`
* publish when `CANCELLED`, `COMPLETED` or `ARCHIVED` → `CONFLICT`
* unpublish when not `PUBLISHED` → `CONFLICT`
* update/archive/delete on an archived event → `CONFLICT`

Each refusal is a real test case, not just a branch.

### 6.3 Publish preconditions

| Precondition | Enforced? | Notes |
| --- | --- | --- |
| at least one active `TicketType` with `quota > 0` | **YES** | read through the Phase 2 relation; no Phase 5 ticket logic written |
| `startAt` in the future | **YES** | |
| banner present | **NO** (advisory) | surfaced as `bannerRecommended: !bannerUrl`, never in `preconditions` |

Unmet preconditions return `CONFLICT` with a machine-readable
`details.preconditions: string[]`, so the UI can list exactly what is missing.

**The Phase 5 dependency.** Enforcing "at least one active TicketType with quota > 0" is
only possible because Phase 2 already created the `TicketType` table; the check is a
**read** through a pure `summarizeSales()` helper. Phase 4 did **not** implement ticket
type management, quota mutation, or any reservation/issuance logic — so today an operator
cannot satisfy that precondition through any Phase 4 screen. The consequence is stated in
§14.1: publish is implemented and correct, but not yet reachable in practice until
Phase 5 lands. This is the brief's own instruction ("If enforcing the TicketType
prerequisite would couple Phase 4 to unimplemented Phase 5 logic, document the dependency
and use the minimum architecture-compatible approach") — the minimum compatible approach
is to enforce the invariant against the existing relation and document the seam.

### 6.4 Public visibility

* Catalog listing: hard-coded `status: "PUBLISHED"` + not archived. A caller-supplied
  status is never read, so a query parameter cannot widen the listing.
* Detail by slug: `PUBLISHED`/`ONGOING`/`COMPLETED` → `isAvailable: true`;
  `CANCELLED` → `isAvailable: false` + reason; `DRAFT` → `isAvailable: false` + reason
  (this is D-14's read-only page); `ARCHIVED` → treated as not found.
* `CANCELLED` events therefore cannot appear as active purchasable events anywhere.

---

## 7. Venue ownership

### 7.1 Platform-global (`organizerId = null`)

* Creation/update/delete requires `venue.manage.global` — a **platform-scope**
  permission held by `ADMIN` only.
* Readable by everyone authenticated (shared by design) and returned by the organizer
  venue list so an organizer can pick a global venue for an event.
* An organizer member cannot create, edit or delete a global venue, and cannot enumerate
  them through the platform admin surface.

### 7.2 Organizer-private (`organizerId = <organizerId>`)

* Creation/mutation requires `venue.manage` for **that specific** organizer.
* Authority is an ACTIVE `OrganizerMember` row resolved from the database — never from a
  request parameter.
* Cross-tenant access fails closed: reading or mutating organizer B's private venue from
  an organizer A session is denied, with the Phase 3 semantics (existence is not
  disclosed).

### 7.3 Cross-tenant behavior

| Actor | Global venue | Own private venue | Other organizer's private venue |
| --- | --- | --- | --- |
| Org A OWNER | read | read/write | **denied** |
| Org A CHECKIN_STAFF | read | read | **denied** |
| Platform ADMIN | read/write | **denied** (no membership) | **denied** (no membership) |
| Unauthenticated | public routes only | **denied** | **denied** |

That last row is deliberate and worth calling out: a platform `ADMIN` does **not**
automatically get tenant access. Role and tenant membership are separate dimensions
(Phase 3), and D-64's platform path authorizes *global* venues, not *other people's*
venues. The venue-and-sport suite asserts this.

### 7.4 Deletion

Deletion is **refused while any event references the venue**, returning `CONFLICT` with
`details.eventCount`. The reason is specific: `Event.venue` is `onDelete: SetNull`, so the
database would happily delete the venue and silently blank the location on every event
that took place there — the opposite of §14's "do not cascade-delete commercial event
history". No cascade was introduced, and no destructive path exists.

**Not implemented, by design:** venue *archival*. `Venue` has no status/`archivedAt`
column and the design defines no venue archival model, so inventing one would be an
unauthorised schema change. The safe supported behaviour is refusal. Recorded in §14.2 as
a prerequisite for ever retiring a venue that has history.

---

## 8. Sport

* **Seed unchanged and idempotent.** `prisma/seed-sports.ts` was reused as-is, not
  rewritten. Running it twice leaves exactly **14** sports
  (`badminton, basketball, cycling, esports, fitness, football, futsal, martial-arts,
  other, running, swimming, table-tennis, tennis, volleyball`) — verified by counting
  before and after the second run.
* **No duplication path.** The service does not seed, so the seed remains the single
  source of truth. Creating a sport reuses the API's slug resolution, which refuses an
  existing slug with `CONFLICT` rather than silently suffixing it — so an API call cannot
  manufacture a duplicate of a seeded row.
* **Management path.** `sport.manage` is a **platform-scope** permission (ADMIN only), so
  no organizer membership confers it. An organizer OWNER or MANAGER cannot edit the
  platform taxonomy from inside their tenant; a platform MANAGER is also refused.
* **Public read.** The catalog filter endpoint and service return ACTIVE sports only,
  with public fields only — no usage counts, no timestamps.
* **Retirement.** Deleting a sport still referenced by an event is refused with the usage
  count and an explicit hint to deactivate instead; `listPublicSports` already excludes
  inactive sports, so deactivation is the supported retirement path.

---

## 9. Image security

### 9.1 Order of operations (never reversed)

```text
upload → validate → strip metadata → store processed → serve processed
```

### 9.2 Validation

| Control | Implementation |
| --- | --- |
| declared MIME | only checked to reject an obvious mismatch; **never** used as the decision |
| actual format | magic-byte detection (`FFD8FF` JPEG, `89504E47` PNG, `RIFF…WEBP` WebP) |
| MIME spoofing | a payload whose bytes are not a supported image is rejected even when it declares `image/jpeg` — including HTML, SVG, and a RIFF container that is *not* WebP (which the legacy retail check would have accepted) |
| malformed structure | truncated/inconsistent containers are rejected, not repaired |
| size | 5 MB, checked against the declared size **and** re-checked against the actual bytes so a chunked request cannot slip past |
| empty upload | rejected |
| per-event cap | 10 images |
| path traversal | filename is generated server-side; the serve route reduces to `path.basename` and 404s any name that is not already a bare basename; deletion refuses path-bearing names |
| rate limiting | the upload route calls the repository's existing `rateLimiters.upload` bucket (20/minute, keyed by the authenticated user id), **before** parsing the multipart body |

### 9.3 EXIF stripping — verified on the bytes that get served

Unit tests prove the stripper; `__tests__/images/process-and-store.test.ts` proves the
**pipeline**, by reading the file back off disk and asserting on it. A pipeline that
stripped in memory and then wrote the original buffer would pass every pure-stripper test
and still leak GPS coordinates — which is exactly why the on-disk assertions exist.

An end-to-end probe with a GPS-tagged JPEG produced:

```text
uploaded has GPS marker : true      ← the fixture really carried metadata
uploaded has XMP marker : true
uploaded has 'Exif' tag : true
stored fileName         : 1789544781189-f13e7c9f7156be41e283d5129472c2bd.jpg
on-disk has GPS marker  : false     ← the served bytes do not
on-disk has XMP marker  : false
on-disk has 'Exif' tag  : false
on-disk starts with SOI : true      ← still a complete, valid JPEG
on-disk ends with EOI   : true
```

### 9.4 Storage and public serving

* `storage/uploads/events/` (or `$UPLOAD_DIR/events`), mirroring the retail convention so
  deployment config keeps working; a separate folder keeps Phase 4 files away from the
  retail `products`/`affiliate` trees while legacy cleanup is deferred to Phase 14.
* Served by `GET /api/uploads/events/[filename]` — **public by design**, because an event
  banner appears on the public catalog and in Open Graph cards. This mirrors the existing
  public `app/api/uploads/products/[filename]` route; the *affiliate* upload route is the
  authenticated one because it serves identity documents.
* Because only the processed file is ever written, the bytes at that public path are
  always metadata-free — there is no original to leak.
* Content type is derived from the server-generated extension via an explicit allow-list,
  not from stored client input.

---

## 10. Authorization

Every new route, with the permission the service layer enforces. Route handlers resolve
identity through `requireAuth()` and defer the decision to the service, so the permission
cannot be edited at the route without also changing the service.

### 10.1 Organizer-scoped (tenant)

| Route | Methods | Authority |
| --- | --- | --- |
| `/api/organizer/events` | GET, POST | `requireOrganizerAccess` → ACTIVE membership; `event.read` / `event.write` |
| `/api/organizer/events/[id]` | GET, PATCH, DELETE | `requireEventAccess` → event's organizer + ACTIVE membership; `event.read` / `event.write` |
| `/api/organizer/events/[id]/publish` | POST | `requireEventAccess(..., EVENT_PUBLISH)` |
| `/api/organizer/events/[id]/unpublish` | POST | `requireEventAccess(..., EVENT_PUBLISH)` |
| `/api/organizer/events/[id]/images` | GET, POST, PATCH | `requireEventAccess(..., EVENT_WRITE)` + `event.banner.upload` for the upload |
| `/api/organizer/events/[id]/images/[imageId]` | DELETE, PATCH | `requireEventAccess(..., EVENT_WRITE)` |
| `/api/organizer/venues` | GET, POST | `requireVenueCreate(organizerId)` → `venue.manage` |
| `/api/organizer/venues/[id]` | GET, PATCH, DELETE | `requireVenueRead` / `requireVenueManage` on the venue's owner |

### 10.2 Platform-scoped

| Route | Methods | Authority |
| --- | --- | --- |
| `/api/admin/sports` | GET, POST | `sport.manage` (platform scope, ADMIN only) |
| `/api/admin/sports/[id]` | PATCH, DELETE | `sport.manage` |
| `/api/admin/venues` | GET, POST | `venue.manage.global` (platform scope, ADMIN only) |
| `/api/admin/venues/[id]` | PATCH, DELETE | `venue.manage.global` |

### 10.3 Invariants held

* The caller-supplied `organizerId` is **data, never authority** — every operation
  re-derives membership from the database.
* Cross-tenant denial uses the Phase 3 semantics (no existence disclosure).
* Fail-closed: no session, no membership, or no readable scope → denied.
* No `isAdmin()` helper, no `role === "ADMIN"` shortcut, and **no implicit bridge from
  legacy `Role.ADMIN` to `PlatformRole.ADMIN`** was introduced. `lib/authz/` is the only
  authorization surface.
* State-changing routes keep `requireSameOrigin` (Phase 3 CSRF); public GETs do not
  require it.
* Every privileged mutation writes an audit entry (`event.create/update/publish/unpublish/archive/delete`,
  `venue.create/update/delete`, `sport.create/update/delete`, plus image add/remove),
  carrying before/after state for the fields a reviewer would want. No passwords,
  tokens, provider secrets or buyer PII are logged.

---

## 11. Public API

| Route | Methods | Auth | Returns |
| --- | --- | --- | --- |
| `/api/events` | GET | none | paginated published-event catalog; filters: sport, venue, city, query text, date range; sort options; page/limit |
| `/api/events/[slug]` | GET | none | published (or D-14 unavailable) event detail |
| `/api/events/[slug]/share` | GET | none | canonical public URL + share URLs (copy / WhatsApp / social) |
| `/api/sports` | GET | none | active sports for the catalog filter |
| `/api/uploads/events/[filename]` | GET | none | processed event image bytes |

**Leak-freedom.** Public payloads are built from explicit `select` sets, so they never
contain `PermissionGrant`, organizer membership data, audit rows, `sold`/`reserved`
counters, other organizers' private venue metadata, or financial fields. Internal
identifiers are limited to those the public contract genuinely needs. The catalog suite
asserts this rather than assuming it.

---

## 12. Tests

### 12.1 Baseline vs final

| | Suites | Suites failed | Tests | Tests failed | Tests passed |
| --- | --- | --- | --- | --- | --- |
| Baseline (end of Phase 3) | 30 | 6 | 697 | 2 | 695 |
| After Phase 4 | 38 | 6 | 903 | 2 | 901 |

**The same 6 suites and the same 2 tests fail before and after — zero regressions:**

* `B. Payout PAID consumes commissions` and `E. Admin affiliate detail executes against
  MariaDB`, both in `__tests__/p0/remediation.integration.test.ts`;
* load failures in `__tests__/ipaymu/production-hardening.test.ts` and four
  `__tests__/marketing/*` suites (`address-shipping-ux`, `campaign-optional-audit`,
  `m7-audit-fixes`, `profile-phone-shipping`).

None of these touches event/venue/sport/image code; they are the pre-existing retail
failures recorded in the Phase 0/3 baselines. They were **not** suppressed, skipped or
"fixed" to make this report green.

### 12.2 Phase 4 focused tests — 206 tests across 8 suites, all passing

```text
npx jest __tests__/events __tests__/images __tests__/venues --runInBand
Test Suites: 8 passed, 8 total
Tests:       206 passed, 206 total
```

Coverage against the brief §26 requirement list:

| Required area | Covered by |
| --- | --- |
| create / update / delete-archive event | `event-service.integration.test.ts` |
| publish / unpublish / invalid transition | `event-service.integration.test.ts` |
| duplicate slug / slug collision / slug normalization | `slug.test.ts` + event service suite |
| future start-time validation | event service suite (publish precondition) |
| public visibility (published appears, draft/unpublished excluded) | `catalog.integration.test.ts` |
| D-14 direct unpublished detail | `catalog.integration.test.ts` |
| organizer A cannot read/mutate organizer B event | event service suite |
| organizer A cannot read/modify organizer B private venue | `venue-and-sport.integration.test.ts` |
| unauthorized user denied / inactive membership denied | event service + venue suites |
| authorized Admin creates global venue; organizer member refused | `venue-and-sport.integration.test.ts` |
| global venue shared-readable; private venue tenant-scoped | `venue-and-sport.integration.test.ts` |
| sport authorized path works; unauthorized mutation denied; seeds not duplicated | `venue-and-sport.integration.test.ts` |
| invalid MIME / spoofed magic bytes rejected | `strip-metadata.test.ts`, `process-and-store.test.ts` |
| EXIF removed; GPS does not survive; nothing written on rejection | `process-and-store.test.ts` |
| upload rate limit remains enforced | `upload-rate-limit.test.ts` (policy + route wiring) |
| private organizer information does not leak in public payloads | `catalog.integration.test.ts` |
| every new API route classified | `route-classification.test.ts` |

### 12.3 Route classification

```text
npx jest __tests__/authz/route-classification.test.ts
Tests: 6 passed, 6 total
```

**132/132** API routes are explicitly classified (115 from Phase 3 + 17 new). The
classifier's guard test exists precisely so a new route cannot be added and silently
inherit the wrong default: adding an unclassified route makes the suite fail. Public
attachments this phase: `/api/events`, `/api/events/[slug]`, `/api/events/[slug]/share`,
`/api/sports`, `/api/uploads/events/`. Everything under `/api/organizer/` and the new
`/api/admin/*` routes are protected.

### 12.4 TypeScript

```text
npx tsc --noEmit  → exit 0, zero errors
```

Three real type errors were found and fixed during this phase, all in Phase 4 test code
(a `AuthzScope | null` fixture, a widened fixture type, and one wrong fixture option
name). None was silenced with a cast or a suppression.

### 12.5 Prisma

```text
npx prisma validate        → valid
npx prisma generate        → Generated Prisma Client (v6.19.3)
npx prisma migrate status  → 18 migrations, Database schema is up to date!
```

### 12.6 Migration verification

There is no Phase 4 migration to verify. The equivalent verification was done the other
way round: `prisma migrate diff` shows the live database still matches `schema.prisma`
apart from the Phase 2.5 cosmetic legacy drift, and the integration suites prove the
Phase 2 tables accept everything Phase 4 writes.

---

## 13. Legacy safety

Confirmed untouched:

* `Product`, `Order`, retail order items, `Flashsale`, shipping, marketing, affiliate and
  spin-wheel models — **no deletion, no rename, no rewrite**.
* All retail migrations — no historical migration edited in Phase 4.
* Retail API routes and pages — no retail route was removed or repointed. The 24 retail
  files that appear modified in `git status` are the **Phase 3** type-only
  `(session.user as any).role` → `session.user.role` substitution, unchanged by Phase 4.
* Retail behaviour was verified empirically, not just by inspection: live data still
  reads 5 products and 149 orders, and the retail test suites that passed at baseline
  still pass.
* `app/admin/layout.tsx` still gates on the legacy retail role; it was not altered, which
  is why the new admin surfaces live at `/platform`.
* The retail homepage was **not** replaced. `/events` is a new, additive public surface;
  Phase 4 added no link to it from the retail homepage and no redirect away from it, so
  the flag-free rollout the brief asks for is achieved by construction rather than by a
  flag framework.

---

## 14. Warnings / unresolved issues

### 14.1 Publishing is implemented but not yet reachable in practice (Phase 5 dependency)

`publishEvent` enforces the design's precondition "at least one active TicketType with
`quota > 0`", reading the Phase 2 `TicketType` table. Because Phase 4 is forbidden from
implementing ticket-type management, **no Phase 4 screen can create the ticket type that
satisfies it.** The code, the precondition and its tests are correct; the operator path
becomes usable in Phase 5. This is the intended boundary, reported so it is not mistaken
for a bug when someone tries to publish a demo event.

### 14.2 Venue retirement needs a schema decision before it can work

Deleting a venue referenced by any event is refused (correctly — the FK is `SetNull` and
would blank event history). There is therefore currently no way to retire a venue that has
ever been used. Doing so properly needs a `Venue` status or `archivedAt` column, which the
design does not define. Flagged as a required decision/schema addition; not invented here.

### 14.3 No feature-flag mechanism exists

The brief says to use an existing flag mechanism if there is one and not to introduce a
framework. The repository has none, so none was added, and the new public surface is
purely additive (new routes and pages only). Deployment note: because there is no flag,
"turning the catalog off" means not linking to `/events` — there is no runtime switch.

### 14.4 Pre-existing test-suite gaps (unchanged, not Phase 4's)

* 6 suites / 2 tests fail at baseline (§12.1) — pre-existing retail failures.
* `jest.config.js` previously matched only a subset of test directories, so
  `__tests__/auth/register-rate-limit.test.ts` has never run. Phase 4 extended
  `testMatch` for its own directories; the pre-existing gap was left as found and is
  tracked from the Phase 0 audit.

### 14.5 Residual migration drift (pre-existing, unchanged)

The case-only legacy `voucher*` index/foreign-key-name diff documented in Phase 2.5 §11
is still present and still classified as cosmetic. Phase 4 neither introduced nor
resolved it.

### 14.6 Venue list has no pagination

`listVenues` / `listGlobalVenues` return all matching venues. Acceptable at launch volume
and consistent with the existing retail settings surfaces, but it is an unbounded query
and should get pagination before venue counts grow. The *event* lists and the public
catalog are paginated.

### 14.7 `lib/ticketing/audit-log.ts` is a second audit writer

Phase 4 needed audit entries for ticketing mutations and the existing
`lib/admin/audit-log.ts` is shaped around the retail admin session. The new writer is
deliberately separate and additive rather than a modification of retail audit behaviour;
consolidating the two belongs with the later cleanup phase.

---

## 15. Explicit out-of-scope confirmation

Phase 4 did **NOT** implement or modify:

| Item | Status |
| --- | --- |
| TicketType management / CRUD | **not implemented** (read-only use for the publish precondition) |
| ticket quota / CAS / reservation | **not implemented** |
| checkout / cart | **not implemented** |
| order creation for ticket purchases | **not implemented** |
| payment creation | **not implemented** |
| iPaymu integration / webhook changes | **not modified** |
| payment settlement | **not implemented** |
| refunds | **not implemented** |
| PIC attribution | **not implemented** |
| PIC fee calculation / ledger | **not implemented** |
| settlement ledger | **not implemented** |
| ticket issuance | **not implemented** |
| QR / e-ticket | **not implemented** |
| ticket wallet | **not implemented** |
| check-in | **not implemented** |
| WhatsApp delivery | **not implemented** |
| email delivery | **not implemented** |
| notification business workflows | **not implemented** |
| financial reporting | **not implemented** |
| Excel transaction export | **not implemented** |
| marketing / spinwheel changes | **not modified** |
| coupon business logic | **not modified** |
| retail cleanup | **not performed** |
| Product → Event rename | **not performed** |
| Flashsale → TicketType rename | **not performed** |
| KTP Git-history purge | **not performed** |
| Git history rewrite | **not performed** |
| D-60 (`UNIQUE(eventId, TicketType.name)`) | **still unresolved, not added** |

---

## 16. Migration safety

Not applicable in the "new migration" sense — Phase 4 created no migration and modified no
existing one. The safety properties the brief asks about hold trivially and were still
verified:

* **Additive:** nothing was added, so nothing destructive could be.
* **Deterministic / reviewable:** no new SQL exists to review.
* **Existing history compatible:** `prisma/migrations/` is byte-identical to the state
  Phase 2.5 verified; `migrate status` reports 18 migrations and an up-to-date database.
* **Safe on the current DB:** confirmed by 206 tests running against it.
* **Safe on fresh-DB replay:** unchanged from Phase 2.5, whose remediation made the chain
  replayable from scratch with zero manual SQL. Phase 4 did not touch that chain, so the
  Phase 2.5 replay result still stands.
* **No destructive reset was run.** `prisma migrate reset` was never invoked; the only
  migrations command executed was `migrate status` and `migrate diff` (both read-only).

---

## 17. Git status

```text
Commit created:       NO
Push performed:       NO
History rewritten:    NO
```

`tsconfig.tsbuildinfo` (a build artifact regenerated by running `tsc`) was restored to its
committed state, so the working tree contains only Phase 4 work plus the pre-existing
changes.

**Pre-existing changes preserved and not touched:**

* `next-env.d.ts`, `package-lock.json`, `prisma/seed-regions.js`
* the Phase 2/2.5/3 artifacts (`prisma/schema.prisma` +1419, the four corrected historical
  migration SQL files, the reconcile/collation migrations, `lib/authz/`, `auth.ts`,
  `proxy.ts`, `jest.config.js`, `lib/csrf.ts`, `lib/admin.ts`, `types/next-auth.d.ts`, and
  the 24 type-only retail edits)

**Phase 4 modifications to pre-existing files (2):** `proxy.ts` (route classification for
the 17 new routes) and `jest.config.js` (testMatch for the new suite directories). Plus one
Phase 3 file extended from within an untracked directory: `lib/authz/permissions.ts`
(the D-64 platform-scope permission).

---

## 18. Final summary

Phase 4 delivers the event/venue/sport domain and the public catalog that later ticketing
phases will consume, without touching the legacy retail surface and without a single
schema change — the Phase 2 foundation already carried every field required, so the
correct action was to use it rather than duplicate it.

Three things are worth flagging above the literal checklist:

1. **No migration was the right answer, not a shortcut.** The tempting move was to add a
   migration "for Phase 4"; every needed column already existed. The verification was
   therefore inverted — instead of proving a new migration was additive, `migrate diff`
   and 206 tests (including live integration suites) prove the existing schema already
   supports the domain.

2. **Image security is proven on the bytes that get served, not on the function's return
   value.** The on-disk test exists because a pipeline that strips in memory and writes
   the original buffer would pass a pure-stripper suite while leaking GPS coordinates. The
   end-to-end probe confirms the stored file carries no EXIF, XMP or GPS and is still a
   valid image.

3. **A platform ADMIN deliberately cannot read another organizer's private venue.** That
   follows from Phase 3's separation of role and membership, and D-64 authorizes global
   venues — not other people's. It is asserted by test rather than left implicit, because
   it is exactly the kind of thing that gets "helpfully" relaxed later.

The two honest limitations are that publishing is enforced but not yet reachable until
Phase 5 provides ticket types (§14.1), and that a venue with any event history currently
cannot be retired at all because no archival model exists (§14.2). Both are documented
dependencies, not defects.

```text
PHASE 4 STATUS: PASS WITH WARNINGS
```
