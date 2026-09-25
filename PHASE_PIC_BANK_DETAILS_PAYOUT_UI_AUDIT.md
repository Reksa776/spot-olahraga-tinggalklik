# PHASE — CONSOLIDATE PIC BANK DETAILS INTO THE PAYOUT REQUEST UI

**AUDIT ONLY — NOTHING WAS MODIFIED.**

No source file, no schema, no migration, no dependency and no data was changed while producing this
report. The only actions taken were file reads, `grep`/`glob` searches and `git status`. The
deliverable is this document.

---

## Answer to the explicit question

> **"Can this be implemented without changing the Settlement/PICFeeLedger accounting engine?"**

# YES.

The current architecture already supports it **because the bank snapshot is read from `PICProfile` at
request/prepare time, inside `createPreparedSettlement`, on every call**. Making the PIC's bank data
writable therefore requires **no change to the engine at all** — the engine will simply copy whatever
the profile holds at the moment the request is created.

Evidence, read from source:

| Guarantee | Where it lives | Changes needed |
|---|---|---|
| Bank snapshot copied from `PICProfile` → `Settlement` | `lib/ticketing/settlement/settlement.ts:406–462` — `tx.pICProfile.findUnique({ select: { bankName, bankAccountName, bankAccountNumber }})` then `tx.settlement.create({ data: { bankName: profile.bankName, ... } })` | **none** |
| Incomplete bank refused at request time | `settlement.ts:419–428` — `VALIDATION_ERROR` / `reason: "BANK_DETAILS_MISSING"` | **none** (it simply stops firing once the data exists) |
| Amount derived server-side | `settlement.ts#selectSettlementItems` → `previewSettleable` | **none** |
| Claim uniqueness | `SettlementItem.picFeeLedgerId @unique` | **none** |
| `PICFeeLedger` money movement | written **only** by `markSettlementPaid` | **none** |
| State machine (`REQUESTED → APPROVED → PAID`) | `lib/ticketing/settlement/service.ts` | **none** |
| SoD (`preparedByUserId ≠ actor`) | `service.ts` | **none** |
| Tenant isolation / own-scope authorization | `lib/pic/self-service.ts#requireMyPic` | **none** |

The change is strictly additive surface: an **own-scope write to four already-existing nullable
columns on `PICProfile`**, plus a read that feeds the dialog and a UI block.

---

## A. Current bank-data architecture

```
PICProfile (4 nullable columns)
   bankName · bankAccountName · bankAccountNumber · taxId
        │
        │  WRITTEN ONLY AT PROFILE CREATION
        ▼
   lib/pic/service.ts#createPic          (POST /api/admin/pic, platform `pic.manage`)
   lib/admin/users.ts:235                (POST /api/admin/users, role = PIC — writes NO bank fields)
        │
        │  READ (never written) at payout time
        ▼
   createPreparedSettlement (origin: "PIC_REQUEST" | "OPERATOR")
        │   • refuses if any of the 3 bank fields is falsy → BANK_DETAILS_MISSING
        │   • copies the 3 fields onto the new Settlement row  ← THE SNAPSHOT
        ▼
   Settlement.bankName / bankAccountName / bankAccountNumber
        │
        │  read by operators + the PIC, always MASKED
        ▼
   maskAccountNumber() → "••••" + last 4
```

Three distinct facts on the same data, and each is a different surface:

1. **`PICProfile.bank*` — the mutable *destination profile*.** Currently write-once at creation.
2. **`Settlement.bank*` — the immutable *per-payout snapshot*.** Written once per payout, never
   updated. This is what the operator actually pays.
3. **`Settlement.proofFilePath` / `providerReference` — the *evidence* the transfer happened.**

**There is no bank-update writer anywhere in the application.** Confirmed by enumerating every
non-test `pICProfile.update`/`create`/`upsert`: only `lib/pic/service.ts#createPic` (create),
`lib/pic/service.ts#updatePicStatus` (writes `status`/`approvedAt`/`approvedByUserId`/`suspendedAt`/
`suspendReason` — **no bank field**), and `lib/admin/users.ts:235` (create; **no bank field**).
`scripts/verify-phase33-live.js` only flips `status`.

### Consequence that makes this feature necessary, not cosmetic

- `POST /api/admin/pic` **can** accept `bankName`/`bankAccountName`/`bankAccountNumber`/`taxId`
  (`lib/pic/validation.ts`, `createPicSchema`).
- But `components/platform/PicManager.tsx` — the only PIC-creation UI — posts **only**
  `{ email, displayName?, picCode?, defaultFeeRateBp? }`. It has **no bank inputs at all**.
- And `POST /api/admin/users` with `role: "PIC"` writes a profile with **no bank fields**.

So **every PIC created through any user-facing surface today has an empty bank profile**, and
therefore every payout request they make fails with `BANK_DETAILS_MISSING`. The only way bank data
exists today is a raw API call or a script. This is finding **B4** in its operational form.

---

## B. Existing PICProfile fields

`prisma/schema.prisma:1402–1445` (`@@map("picprofile")`):

| Field | Type | Notes relevant to this feature |
|---|---|---|
| `bankName` | `String?` | **free text**, `VARCHAR(191)` in MySQL; validated to ≤ 64 chars at create |
| `bankAccountName` | `String?` | free text, ≤ 64 |
| `bankAccountNumber` | `String?` | free text, ≤ 64. `maskAccountNumber` strips whitespace before masking |
| `taxId` | `String?` | **stored only — see §"taxId" below** |
| `status` | `PICStatus` | `PENDING｜ACTIVE｜SUSPENDED｜REJECTED` — gates self-service |
| `identityNote` | `String? @db.Text` | human-review note; explicitly **not** a KYC document (no KTP file exists, by design) |

`Settlement` mirrors the same three bank fields (`schema.prisma:1602–1604`) plus
`providerReference`, `proofFilePath`.

**The fields already exist. This feature adds no column** (see §M).

### `taxId` — is it required by the payout contract?

**No. It is merely stored.** Evidence: the only references to `taxId` in the entire codebase are
`createPicSchema` (input), `PIC_SELECT`/`toPicPayload` (read-through), the schema column, one
migration line, the admin detail page rendering it as `NPWP`, and narrative documents.
`createPreparedSettlement` requires exactly `bankName`, `bankAccountName`, `bankAccountNumber` — it
never reads `taxId`. Nothing in the settlement, ledger, reporting, export or reconciliation path
consults it.

**Therefore, per the brief's own conditional ("Tax ID if currently required by the existing payout
contract"), `taxId` may be OMITTED from the dialog.** Including it is optional cosmetics; if
included it must never gate submit. Recommendation: omit in V1 (see K, decision D-3).

---

## C. Existing authorization

### Who can currently touch a PICProfile at all

| Surface | Guard | Can write bank data? |
|---|---|---|
| `POST /api/admin/pic` | `PIC_MANAGE` (PLATFORM; ADMIN only) | ✅ at create, by raw API only |
| `PATCH /api/admin/pic/[id]` | `PIC_MANAGE` + `updatePicStatusSchema` | ❌ status/reason only |
| `POST /api/admin/users` | `USER_MANAGE` (ADMIN only) | ❌ profile created without bank fields |
| PIC self-service (`lib/pic/self-service.ts`) | `requireMyPic` | ❌ **module is read-only by construction** |

`updatePicStatusSchema` is `z.object({ status, reason? })` with **no** bank field, and the route's own
comment states the limitation is deliberate ("Payout details are not editable through this route").

### The own-scope write pattern that already exists

`REFUND_REQUEST_OWN`, `ORDER_CANCEL_OWN` and `TICKET_ISSUE_OWN` are own-scope **write** capabilities
resolved by `decideOwnResourcePermission(scope, permission, ownerUserId)` — which denies unless
`scope.userId === ownerUserId` (throwing `PIC_ACCESS_DENIED` otherwise). A PIC-side bank write reuses
that exact machinery; no new authorization mechanism is needed.

`requireMyPic` (`lib/pic/self-service.ts`) already establishes, in order:

1. `requireAuth()` → else `UNAUTHORIZED`;
2. `scope.userId === userId` → else `PIC_ACCESS_DENIED` (a forged id is a denial, not a wider filter);
3. an **ACTIVE** `PICProfile` on a **non-disabled** `User` → else `NOT_FOUND` (never-confirming 404);
4. `decideOwnResourcePermission` for each required permission → else `FORBIDDEN`.

So a SUSPENDED/PENDING PIC or a disabled account can never edit bank data — for free.

| Role | Holds `pic_payout.request.own`? | Can reach a PIC bank write? |
|---|---|---|
| `PIC` | ✅ (own map) | ✅ only their own profile |
| `CUSTOMER` (even with an ACTIVE profile) | ❌ | ❌ `FORBIDDEN` |
| `ADMIN` | ❌ | ❌ `FORBIDDEN` (D-19: ADMIN's own map withholds PIC financial capability) |
| `MANAGER` | ❌ | ❌ `FORBIDDEN` |
| Membership roles | confer nothing at own scope | ❌ |

### Two authorization side-effects to respect

- **`proxy.ts`** already lists `/api/pic/` in `PROTECTED_API_PREFIXES` — defence in depth for any
  route under that prefix. No proxy change needed.
- **`__tests__/pic-self-service/reporting.integration.test.ts:479`** asserts
  `expect(picRoutes).toEqual([path.join("pic", "payouts", "route.ts")])` with the comment *"It is the
  ONLY top-level `/api/pic` route; nothing else may be added there without updating this assertion."*
  → **Adding a new route under `app/api/pic/` breaks an intentional assertion.** This is a strong
  argument for extending the existing endpoint rather than minting a second one (see §G).

---

## D. Existing validation

`lib/pic/validation.ts`:

```ts
const accountField = z.string().trim().max(64, "Maksimum 64 karakter").optional();
// createPicSchema: bankName / bankAccountName / bankAccountNumber / taxId = accountField
```

`lib/ticketing/settlement/validation.ts`:

```ts
export const picPayoutRequestSchema = z.object({
    organizerId: z.string().trim().min(1, ...).max(64),
    notes: z.string().trim().max(2000).optional(),
}).strict();   // ← unknown keys are a hard 400
```

Observations that shape the implementation:

| Finding | Consequence |
|---|---|
| `accountField` has **no `min(1)`** | `""` parses and is stored; `!profile.bankName` then treats it as missing. Any new bank block must require a non-empty value. |
| `accountField` validates **no format** | No digits-only rule for an account number. Adding one would be a *behaviour change* that could reject legitimate identifiers — do **not** add it in V1. |
| Max length is **64**, column is `VARCHAR(191)` | Reuse 64; no migration implication. |
| `createPicSchema` is **not** `.strict()` | Unrelated to this feature; do not tighten it here (it would change admin behaviour). |
| `picPayoutRequestSchema` **is** `.strict()` | Adding a `bank` object makes it a *known* key — existing tests asserting `amount`/`picProfileId`/`status` rejection stay valid and must keep passing. |
| `markPaidSchema` / `rejectSettlementSchema` are `.strict()` | The established convention: a money body rejects anything it does not name. |

---

## E. Existing payout snapshot behavior

`createPreparedSettlement` (verbatim order, `settlement.ts:356+`):

1. Re-read an existing `(payeeType, organizerId, picProfileId, periodStart, periodEnd)` row —
   replays `EXISTS`, or throws `PERIOD_ALREADY_CLOSED` for `CANCELLED`/`FAILED`/`REJECTED`.
2. **Fetch `PICProfile { bankName, bankAccountName, bankAccountNumber }`.**
3. **Refuse with `VALIDATION_ERROR` / `BANK_DETAILS_MISSING` if any of the three is falsy.**
   *This throw happens BEFORE any row is written* — so a `BANK_DETAILS_MISSING` failure leaves **no**
   `Settlement` and claims nothing, and a retry is unblocked.
4. `selectSettlementItems` → refuse `NOTHING_SETTLEABLE` when empty or `net ≤ 0`.
5. `tx.settlement.create({ …, status: isPicRequest ? "REQUESTED" : "DRAFT", bankName: profile.bankName, bankAccountName: profile.bankAccountName, bankAccountNumber: profile.bankAccountNumber, preparedByUserId: actor.userId })`.
6. `settlementItem.createMany` — the claim, guarded by `picFeeLedgerId @unique`.
7. `writeTicketingAuditInTx` — action `settlement.request` (PIC) / `settlement.prepare` (operator).

**Key property:** the snapshot is taken from the profile **at the instant of the request**, inside
the same transaction that creates the claim. Writing newer bank data to `PICProfile` *before* calling
this function is therefore sufficient — and is exactly the brief's prescribed order.

`taxId` is not part of the snapshot and not part of the `PIC_PAYOUT_SELECT` payload either.

**Snapshot immutability:** nothing updates `Settlement.bank*` after creation. A later profile edit
therefore **cannot** retroactively change an existing payout (see §J, edge case 1 — this is a
feature, but it has a UX consequence that must be designed for).

---

## F. Exact UI integration point

```
app/dashboard/pic/page.tsx
   └─ DashboardPicPage()                     ← three-branch router
        └─ PicSelfServiceSection({ userId }) ← loads profile/overview/…/settleable
             └─ <SectionCard title="Pencairan"
                    actions={<PicPayoutRequestDialog organizers={settleable} />} />
                                             ↑ line ≈696 — THE INTEGRATION POINT
components/dashboard/PicPayoutRequestDialog.tsx
   └─ Dialog: [Penyelenggara Select] [Jumlah read-only] [Catatan] [Batal] [Ajukan Pencairan]
        → POST /api/pic/payouts  { organizerId, notes? }
```

The dialog today receives **only** `organizers: SettleableOrganizer[]`. It renders:

- `Penyelenggara` — `Select` over tenants with a strictly positive settleable net;
- `Jumlah diajukan` — **read-only, disabled** `Input` showing `selected.settleableNet` (the dialog's
  own docblock is explicit: *"It decides NOTHING about money… no amount, no status, no bank"*);
- `Catatan` — optional `Textarea`, `maxLength=2000`, sent as `notes`.

The dialog is a client component using the shared dashboard `Dialog`/`Field`/`Input`/`Select`
primitives — no `window.prompt`. It surfaces server messages verbatim and calls `router.refresh()` on
success.

**CASE B is already reachable:** `listMyPicSettleableOrganizers` filters only on a **positive
settleable net** — it does **not** check bank completeness. So a PIC with no bank data still sees the
button enabled, opens the dialog, and only on submit receives `BANK_DETAILS_MISSING`. Placing the
bank fields in this same dialog is therefore the correct fix point for both cases, and the brief's
`"Data rekening belum lengkap"` state can be driven from the profile data the page will pass down.

**Two small server-side prerequisites for the dialog:**

1. `app/dashboard/pic/page.tsx` must pass the current bank values into the dialog
   (new prop, e.g. `bank`), because **`getMyPicProfile` deliberately does not select them today**
   (`lib/pic/self-service.ts:179` selects `id, displayName, picCode, status, approvedAt, createdAt`).
2. Therefore one small read must be added or extended (see §G).

---

## G. Required API/service changes

### Recommended shape: extend `POST /api/pic/payouts` with an optional `bank` block

```jsonc
// CURRENT (unchanged, still valid)
{ "organizerId": "org_x", "notes": "…" }

// NEW — bank block is optional; when present it must be COMPLETE
{ "organizerId": "org_x", "notes": "…",
  "bank": { "bankName": "BCA", "bankAccountName": "Budi", "bankAccountNumber": "1234567890" } }
```

Why this shape and not a second endpoint:

- **One submit, one round trip** — matches the brief's CASE A/B behaviour exactly
  ("save PICProfile first **and then** create REQUESTED payout").
- **Keeps the intentional single-route guard intact** — no update to the
  `reporting.integration.test.ts` assertion that `pic/payouts/route.ts` is the only `/api/pic` route.
- **Reuses one authorization path** — `requireMyPic(userId, [PIC_PAYOUT_REQUEST_OWN])`, unchanged.
- **The `amount` prohibition is untouched** — the client still cannot send an amount; it is derived
  by `selectSettlementItems`.

The write is confined to the fields it names. The endpoint must **never** accept `userId`,
`picProfileId`, `status`, `amount`, `netAmount`, `method` or `preparedByUserId` — the strict schema
enforces this and the existing regression tests already pin three of them.

Order of operations inside the service (all before `createPreparedSettlement`):

1. `requireMyPic(userId, [PIC_PAYOUT_REQUEST_OWN])` → `{ scope, picProfileId }` (unchanged).
2. Validate `organizerId` (unchanged).
3. **If `bank` is present:** `prisma.pICProfile.update({ where: { id: picProfileId }, data: { bankName, bankAccountName, bankAccountNumber } })`, then `writeTicketingAudit({ action: "pic.bank.update", entityType: "PICProfile", entityRef: picProfileId, beforeState: { bankNameChanged, bankAccountNameChanged, bankAccountNumberChanged }, afterState: { …, bankAccountNumberLast4: "••••1234" } })`.
4. `settleableWindowStart(...)` → `NOTHING_SETTLEABLE` (unchanged).
5. `createPreparedSettlement({ …, origin: "PIC_REQUEST" })` — **UNCHANGED**, now snapshotting the
   just-written values.

The bank update and the settlement creation **cannot share one transaction**: `createPreparedSettlement`
opens and owns its own `prisma.$transaction` and accepts no `tx` handle, and giving it one would mean
editing the engine — which is out of scope. Sequential-but-unguaranteed is acceptable here because
the failure mode is benign and recoverable (see §J, edge case 3).

### The exact files this touches

| Change | File |
|---|---|
| `bank` sub-schema (strict, min 1, max 64, `.optional()`) + extend `picPayoutRequestSchema` | `lib/ticketing/settlement/validation.ts` |
| Accept `bank`, update the profile, audit it, before calling the engine | `lib/pic/payout.ts#createMyPicPayoutRequest` |
| Pass `bank` through | `app/api/pic/payouts/route.ts` (`parseOrThrow` already forwards the parsed input) |
| New audit action name (string union — **no migration**) | `lib/ticketing/audit-log.ts` |
| Return the caller's own bank values so the dialog can pre-fill | `lib/pic/self-service.ts` (extend `getMyPicProfile`) **or** a new `getMyPicBankDetails(userId)` |
| Pass bank values into the dialog | `app/dashboard/pic/page.tsx` |
| Bank fields + "Data rekening belum lengkap" state + edit payload | `components/dashboard/PicPayoutRequestDialog.tsx` |

### Alternative shape (documented, not recommended)

A dedicated `PATCH /api/pic/profile` (or `PUT /api/pic/me/bank`) that saves bank data, with the
dialog calling it and then the existing payouts endpoint. Cleaner separation of concerns and per-field
error granularity, but: **a new `/api/pic` route breaks the intentional `reporting.integration.test.ts`
assertion**, costs a second round trip, and introduces a "bank saved, request failed" state visible to
the user. Only worth it if the owner later wants bank editing *without* a payout request.

### Permission decision

**Recommended: reuse the existing own-scope `PIC_PAYOUT_REQUEST_OWN`.** The bank destination is
configured as part of asking to be paid, the permission already means "act on my own payout", and
reuse costs zero changes to `PERMISSIONS`, `OWN_SCOPE`, `PLATFORM_ROLE_OWN_PERMISSIONS` or the
`permission-map` test (which asserts `PERMISSION_SCOPE.size === ALL_PERMISSIONS.size`).

**Alternative:** a new `pic_profile.bank.update.own` key — more honest naming and independently
revocable later, but it must be added in three places (`PERMISSIONS`, `OWN_SCOPE`,
`PLATFORM_ROLE_OWN_PERMISSIONS.PIC`) and carries no other benefit in V1.

---

## H. Required tests

Existing infrastructure to reuse — no new framework: the `jest.mock("@/auth")` + real-route +
real-test-DB pattern from `__tests__/pic-self-service/payouts-route.integration.test.ts`, and the
service-level pattern from `payout-request.integration.test.ts`, both of which self-clean in `afterAll`.

| # | Test | Asserts |
|---|---|---|
| 1 | **CASE B — request with bank block on an empty profile** | 201; `PICProfile.bank*` persisted; `Settlement.status = REQUESTED`; **snapshot equals the submitted values**; ledger still `EARNED` / `settlementId null` |
| 2 | **CASE A — edit existing bank, then request** | `PICProfile.bank*` updated; the **new** `Settlement` snapshot carries the **new** values (proves `createPreparedSettlement` reads latest, i.e. the whole point) |
| 3 | **Snapshot immutability** | Edit bank **after** a `REQUESTED` row exists → that row's `Settlement.bank*` is byte-identical to what it was |
| 4 | **No `bank` block on an empty profile** | Still `400 VALIDATION_ERROR` / `reason: "BANK_DETAILS_MISSING"` (regression guard on the engine's own contract) |
| 5 | **Partial bank block** | e.g. only `bankName` → 400 with `details.fields` naming the missing fields; **nothing persisted** |
| 6 | **`amount` / `picProfileId` / `status` still rejected** | The three existing strict-body tests must keep passing after `bank` is added |
| 7 | **`taxId` not required** | A submit without `taxId` succeeds (documents the "stored only" finding) |
| 8 | **Same-origin** | A bank-bearing POST with a cross-site `Origin` (and with none) → 403 before parsing |
| 9 | **Authn / authz** | anonymous → 401; authenticated **non-PIC** → 404; `CUSTOMER` with an ACTIVE profile → `FORBIDDEN`; a forged/foreign caller cannot reach another PIC's profile (structural: no id is accepted) |
| 10 | **SUSPENDED profile** | `requireMyPic`'s `NOT_FOUND` still applies → a suspended PIC cannot edit bank data |
| 11 | **Audit** | A `pic.bank.update` row is written, and **no audit metadata contains the full account number** (the `bankaccountnumber` key filter in `audit-log.ts` must hold, and the caller must not pass it either) |
| 12 | **Concurrency / no double-claim** | Unchanged `SettlementItem.picFeeLedgerId @unique` behaviour still holds with a bank block present |
| 13 | **Schema unit test** | `bank` is strict (unknown keys rejected), each field trimmed, non-empty, ≤ 64 |
| 14 | *(optional)* **Component/pure-logic** | `isBankComplete(...)` → the "Data rekening belum lengkap" state renders for CASE B and hides for CASE A |

Note: `taxId` must be absent from the required set, and no test may assert digits-only account
numbers (no such rule exists).

---

## I. Security / privacy considerations

1. **Full account number exposure — the one deliberate exception (DECIDED, see K/D-1).**
   `maskAccountNumber` (`••••`+last 4) is the convention in `lib/ticketing/settlement/payload.ts`,
   `lib/pic/payout.ts` (PIC history) and `app/dashboard/pic/[id]/page.tsx` (admin detail). Pre-filling
   an *editable* field requires the raw value, so **the raw value is returned only to the
   authenticated owner of that profile**, which is the same trust level as the ability to change it.
   The risk delta is negligible — an actor with the PIC's session can already redirect the destination
   and request a payout — but the exception must be **documented in the service docblock** and must
   **not** leak into the history payload, the operator views or any log. Binding constraints and the
   tests that enforce them are listed in K under D-1.
2. **Never log the account number.** `lib/ticketing/audit-log.ts` already filters the
   `bankaccountnumber` key defensively; the caller must additionally pass only booleans / last-4.
   The route must not log its body.
3. **CSRF is mandatory.** The endpoint is state-changing; `requireSameOrigin` must stay first, exactly
   as today. No `GET` variant may carry bank data.
4. **Account-takeover blast radius is real.** Bank details are the *destination of money*. A
   compromised PIC session can now redirect a payout. This is inherent to the owner's chosen UX. The
   structural mitigations already in place: an operator reviews every request, the amount is
   server-derived, the ledger does not move at request time, and SoD blocks self-approval. An
   **audit row on every change** is the minimum additional control, and the operator already sees the
   (masked) destination they are about to pay (see §J, edge case 2 for the optional visibility aid).
5. **No KYC/verification step exists** (decision D-52; `PICProfile.identityNote` is explicitly a note,
   not a document). This feature does **not** introduce one and must not pretend to — a bank change is
   therefore unverified by definition.
6. **Own-scope + identity gating.** No function may accept `picProfileId`/`userId`; the profile must
   come from `requireMyPic`'s session-derived `picProfileId`. Tenant membership must confer nothing.
7. **PII surface unchanged.** `taxId` (NPWP) is already displayed unmasked on the admin PIC detail
   page; leaving it out of the dialog keeps the PIC-facing PII surface from growing.
8. **Rate limiting is optional but worth considering** for an authenticated bank-change write
   (`lib/rate-limit.ts` exists and is used for uploads). Not required for V1 correctness.
9. **Non-disclosure is preserved.** A non-PIC still gets `NOT_FOUND` from `requireMyPic`, so the
   endpoint cannot be used to probe whether an account is a PIC.

---

## J. Potential edge cases

| # | Edge case | Behaviour (and why it is acceptable) |
|---|---|---|
| 1 | **PIC edits bank while a request is `REQUESTED`/`APPROVED`** | The existing `Settlement` **keeps the old snapshot** — `Settlement.bank*` is never updated. The operator will transfer to the **old** account. The UI must say so explicitly: the current request still pays the previously recorded account; to use the new one, the operator must **reject** and the PIC must **re-request**. Editing does not and must not mutate an in-flight payout. |
| 2 | **Operator cannot tell the bank changed** | Recommendation: on the operator's `REQUESTED` detail, compare the snapshot against the current profile and show an informational note ("rekening profil berbeda dari snapshot") — a **zero-schema** aid, since both values are already available. Optional; the audit row is the fallback. |
| 3 | **Bank saved, then the request fails** (`NOTHING_SETTLEABLE`, `ALREADY_CLAIMED`, `PERIOD_ALREADY_CLOSED`, contention) | The profile update stands; the response is the request's error. Benign and recoverable: the PIC retries and the change is not repeated (the values already match). Must NOT be reported as a success. |
| 4 | **Partial / whitespace-only bank block** | `""`-after-trim must be treated as **missing**, never stored as `""` (today's `accountField` allows `""`, which the engine then treats as missing via `!profile.bankName`). The new sub-schema requires `min(1)`. |
| 5 | **No `bank` block sent, profile incomplete** | Unchanged: the engine returns `BANK_DETAILS_MISSING`. The dialog must map that specific `details.reason` to the visible `"Data rekening belum lengkap"` state rather than a generic error line. |
| 6 | **SUSPENDED / PENDING profile or disabled account** | `requireMyPic` → `NOT_FOUND` before any write. No bank edit, no request. |
| 7 | **Concurrent submits from two tabs** | Last write wins on `PICProfile`; whichever request wins the claim runs the engine. `SettlementItem.picFeeLedgerId @unique` still guarantees no fee is consumed twice. A bank value written by the losing submit is harmless. |
| 8 | **Multi-tenant PIC submits per tenant** | Each request snapshots the profile independently. Set the bank once, then request per tenant — no conflict. |
| 9 | **Re-request after `REJECTED`** | Allowed (claims were released). `periodEnd = now` differs, so the `(payeeType, picProfileId, periodStart, periodEnd)` unique key does not collide — verified by the existing reject → re-request test. A fresh snapshot is taken, so the corrected bank is used. This is the intended recovery path for edge case 1. |
| 10 | **Free-text `bankName`** | e.g. "BCA", "Bank Central Asia", "bca". No list exists and none should be invented (see K, decision D-2). Keep free text ≤ 64; do not normalise case. |
| 11 | **Account number with spaces/dashes** | `maskAccountNumber` strips whitespace for masking. Trim on input; do **not** strip internal characters — altering an identifier is worse than displaying it verbatim. |
| 12 | **`REQUESTED` row exists for that tenant and the PIC tries again** | `CONFLICT` (`ALREADY_CLAIMED` / period collision). Not a bug: the fee is already claimed. UI copy must point the PIC at the existing request. |
| 13 | **Amount tampering** | Still impossible: `picPayoutRequestSchema` is `.strict()` and has no amount key; the figure comes from `selectSettlementItems`. Regression tests already pin `amount` rejection. |
| 14 | **`bankName` complete but account number empty at create time** | Already treated as incomplete by the engine (any of the three falsy). The dialog should surface all three as required whenever any is missing. |

---

## K. Minimal implementation plan

1. **Validation** — `lib/ticketing/settlement/validation.ts`: add a strict `picPayoutBankSchema`
   (`bankName`/`bankAccountName`/`bankAccountNumber`, each `.trim().min(1).max(64)`) and add
   `bank: picPayoutBankSchema.optional()` to `picPayoutRequestSchema`. `taxId` deliberately absent.
2. **Read** — `lib/pic/self-service.ts`: extend `getMyPicProfile` to also select and return
   `bankName`, `bankAccountName`, `bankAccountNumber` (raw — owner-only, see D-1). No new function, no
   new permission.
3. **Write** — `lib/pic/payout.ts#createMyPicPayoutRequest`: accept `bank`; when present, `update` the
   profile's three fields and write a `pic.bank.update` audit row with masked/boolean metadata only;
   then continue to the **unchanged** `createPreparedSettlement` call.
4. **Audit vocabulary** — `lib/ticketing/audit-log.ts`: add `| "pic.bank.update"` to
   `TicketingAuditAction` (a string union — **no schema change, no migration**).
5. **Page** — `app/dashboard/pic/page.tsx`: pass the profile's bank values to the dialog (adds
   `getMyPicProfile`'s new fields to the existing `Promise.all` — no extra query).
6. **Dialog** — `components/dashboard/PicPayoutRequestDialog.tsx`: new "Data rekening" block (3
   `Input`s) pre-filled; a `"Data rekening belum lengkap"` notice when any field is empty; include
   `bank` in the POST body **only when non-empty/changed**; map `details.reason ===
   "BANK_DETAILS_MISSING"` to that notice; keep the amount field read-only and disabled.
7. **Route docblock** — `app/api/pic/payouts/route.ts`: update the "no bank" wording to describe the
   new optional block (comment only).
8. **Tests** — the 13–14 cases in §H.
9. **Verify** — targeted suites → `npx tsc --noEmit` → `npx eslint .` → full Jest → `npm run build`.

**Explicitly out of scope:** the accounting engine, `PICFeeLedger`, amount derivation, settleable
calculation, claim uniqueness, the state machine, the authorization model, SoD, proof/PAID, the
operator flow, and the admin PIC surface.

### Decisions — LOCKED (owner confirmed before implementation)

| # | Decision | Outcome |
|---|---|---|
| **D-1** | Does the dialog show the **raw** account number (pre-filled & editable) or a masked value with "leave blank to keep"? | ✅ **DECIDED — RAW NUMBER, OWNER ONLY.** The dialog pre-fills the real `bankAccountNumber` so the PIC can review and correct it. This is a **deliberate, single-scope exception** to the mask-everywhere convention: the raw value is returned *only* to the authenticated owner of that profile, *only* through the own-scope (`requireMyPic`) read. Masking (`maskAccountNumber`) remains mandatory in the PIC payout history, the operator settlement list/detail and the admin PIC detail page. The account number must never be logged, never audited verbatim and never placed in a URL. |
| **D-2** | Free-text `bankName` or a `Select` from a bank list? | ✅ **DECIDED — FREE TEXT.** No payout-bank list exists anywhere in the codebase (the only bank-like catalogues are iPaymu *payment channels* for checkout — a different domain). Free text ≤ 64 chars, trimmed, no case normalisation. |
| **D-3** | Include `taxId` in the dialog? | ✅ **DECIDED — OMIT.** Not part of the payout contract (verified: the engine never reads it) and already visible to ADMIN. The PIC-facing PII surface does not grow. |
| **D-4** | New permission `pic_profile.bank.update.own`, or reuse `pic_payout.request.own`? | ✅ **DECIDED — REUSE `pic_payout.request.own`.** Zero permission-map churn: `lib/authz/permissions.ts` (`PERMISSIONS`, `OWN_SCOPE`, `PLATFORM_ROLE_OWN_PERMISSIONS.PIC`) and `__tests__/authz/permission-map.test.ts` are **all unchanged**, and the `reporting.integration.test.ts` single-route assertion is **unchanged**. |
| **D-5** | Should the operator see a "bank changed since snapshot" signal? | ⏳ **DEFERRED (not part of this phase).** Zero-schema (compare snapshot vs profile), but UI work beyond the minimum. The `pic.bank.update` audit row is the minimum control for now. |

**Consequences of D-1 for the implementation (binding):**

- The raw value travels **only** in `getMyPicProfile` (own-scope, identity-gated) → the dialog. It must **not** be added to `PicPayoutRequestPayload`/`PIC_PAYOUT_SELECT`, the operator settlement payload (`buildSettlementPayload`), or any admin payload.
- The `pic.bank.update` audit metadata carries **booleans + last-4 only** — never the account number (the `bankaccountnumber` key filter in `audit-log.ts` is a backstop, not the design).
- A test must assert the account number is **absent** from audit metadata and from the PIC history payload.

---

## L. Files expected to change

| File | Change | Risk |
|---|---|---|
| `lib/ticketing/settlement/validation.ts` | add strict bank sub-schema; extend `picPayoutRequestSchema` | low |
| `lib/pic/payout.ts` | accept + persist `bank`; audit; delegate unchanged | low–medium (new write path) |
| `lib/pic/self-service.ts` | `getMyPicProfile` returns bank fields | low |
| `lib/ticketing/audit-log.ts` | add one action name to a string union | very low |
| `app/dashboard/pic/page.tsx` | pass bank values to the dialog | very low |
| `components/dashboard/PicPayoutRequestDialog.tsx` | bank fields + incomplete-data state + payload | low |
| `app/api/pic/payouts/route.ts` | docblock only | none |
| `__tests__/pic-self-service/payouts-route.integration.test.ts` | extend with bank cases | none (test) |
| `__tests__/pic-self-service/payout-request.integration.test.ts` | add CASE A/B + snapshot-immutability cases | none (test) |
| `__tests__/authz/*`, `__tests__/pic-self-service/reporting.integration.test.ts` | **UNCHANGED** (reuse recommendation avoids them) | — |
| `prisma/schema.prisma`, `prisma/migrations/**` | **UNCHANGED** | — |

**Not touched:** `lib/ticketing/settlement/{service,settlement,payload,proof}.ts`,
`lib/pic/{ledger,reporting,reconciliation,attribution}.ts`, `lib/authz/**`, `proxy.ts`,
`lib/admin/**`, `components/platform/PicManager.tsx`, any operator settlement UI.

---

## M. Is a migration actually required?

# NO.

- All four fields already exist on `PICProfile` and are already nullable — `bankName String?`,
  `bankAccountName String?`, `bankAccountNumber String?`, `taxId String?`
  (`prisma/schema.prisma:1414–1417`), present since
  `migrations/20260916000000_ticketing_phase2_foundation`.
- The settlement snapshot columns already exist on `Settlement` (same migration).
- A new **audit action name** is an application-level string (`AdminAuditLog.action` is a `String`,
  and `TicketingAuditAction` is a TypeScript union) — no enum change, no DDL.
- A new **permission string** would likewise be an application-level constant.
- No new table, no new column, no new index, no new enum value, no new relation.

**The only thing that would require a migration** is a *denormalised* column such as
`PICProfile.bankChangedAt` / `bankChangedByUserId` (to surface "recently changed" without reading the
audit log). That is **not required** — `AdminAuditLog` already records actor, timestamp and entity for
every change — so it is explicitly **not** part of this plan.

---

## Appendix — Scope, method and guarantees

- **Method:** read-only inspection plus `grep`/`glob`/`git status`. No `prisma` command, no migration,
  no dependency install, no test run, no application or database write.
- **Files inspected:** `prisma/schema.prisma`; `prisma/migrations/20260916000000_ticketing_phase2_foundation/migration.sql`;
  `lib/ticketing/settlement/{settlement,validation,payload}.ts`; `lib/pic/{service,validation,payout,self-service}.ts`;
  `lib/ticketing/audit-log.ts`; `lib/authz/{permissions,errors}.ts`; `lib/admin/users.ts`; `proxy.ts`;
  `app/api/pic/payouts/route.ts`; `app/api/admin/pic/route.ts`; `app/api/admin/pic/[id]/route.ts`;
  `app/dashboard/pic/page.tsx`; `app/dashboard/pic/[id]/page.tsx`;
  `components/dashboard/PicPayoutRequestDialog.tsx`; `components/platform/PicManager.tsx`;
  `__tests__/authz/permission-map.test.ts`; `__tests__/pic-self-service/{payout-request,payouts-route,reporting}.integration.test.ts`.
- **Prior reports cross-checked:** `PHASE_PIC_PAYOUT_SELF_SERVICE_AUDIT.md`,
  `PHASE_PIC_PAYOUT_FLOW_VERIFICATION.md` (verdict: FLOW VERIFIED — NO IMPLEMENTATION REQUIRED),
  `PHASE_21_PIC_PAYOUT_AND_QR_SCANNER_{AUDIT,IMPLEMENTATION_REPORT}.md`,
  `PIC_PAYOUT_SETTLEMENT_{V1_IMPLEMENTATION,DEEP_AUDIT}_REPORT.md`, `PIC_BUSINESS_FLOW_AUDIT_REPORT.md`.
- **Report created:** `PHASE_PIC_BANK_DETAILS_PAYOUT_UI_AUDIT.md` (this document — no source change).
