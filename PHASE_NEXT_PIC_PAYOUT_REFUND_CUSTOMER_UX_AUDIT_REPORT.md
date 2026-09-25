# PHASE NEXT — PIC PAYOUT + REFUND EVIDENCE + CUSTOMER ORDER EXPERIENCE (AUDIT)

Tanggal: 2026-09-25
Status: **AUDIT-ONLY-READY — root causes PROVEN; implementation needs the go/no-go below**

Read-only audit. Tidak ada perubahan kode, tidak ada commit/push/pull, tidak ada edit DB, tidak ada
migrasi, tidak ada reset. `git status`/`git diff` TIDAK dikotori.

---

## 1. Executive Summary

Tiga laporan dalam briefing ini ternyata **tiga masalah yang berbeda akar penyebabnya**, dan audit
menemukan semuanya **berakar pada KETIDAKLENGKAPAN VERTICAL SLICE pada sisi MONEY LIFECYCLE +
CUSTOMER READ MODEL**, bukan pada maintenance, bukan pada login, dan bukan pada PIC referral.

| Laporan | Root cause (dibuktikan) | Perbaikan minimal |
|---|---|---|
| PIC tidak muncul di "Pencairan/Settlement" | **`Settlement`/`SettlementItem` KOSONG (0 row)** → permukaan payout memang tidak punya data; **bukan** bug join nama PIC (join `picProfile.displayName` SUDAH ada di read payload). Schema SUDAH bermuatan `picProfileId` + `payeeType` | **TIDAK ADA perbaikan data.** Bila mau: seeding/payout pipeline — bukan kode read. |
| Admin "Catat proses" refund pakai alert/prompt | `app/dashboard/refunds/*` + `components/dashboard/SettlementActions.tsx` pakai `window.confirm/prompt` | Ganti dengan Dialog UI (kerangka Dialog SUDAH ada). |
| Bukti transfer refund tidak ada | **Refund TIDAK punya kolom evidence-file** (hanya `providerRef`/`evidenceNote`); belum ada alur upload; `refunditems=0` (refund tanpa item evidence) | Migration additive + upload infra + read route. |
| Customer tidak ada "Pesanan Saya" | **Tidak ada route `list my orders`**; nav order hanya untuk halaman ticketing; tidak ada halaman order detail customer | Route list/detail + nav + guards own-scope. |
| Cross-tenant/own-scope | Guard SUDAH tenancy-scoped; perlu re-eyeball di surface baru | Reuse `requireOwnResource`/`assertSameOrigin`. |

**Keputusan audit:** TIDAK ada kode yang diubah, TIDAK ada DB yang disentuh, TIDAK ada migrasi
yang dijalankan sampai report ini dikonfirmasi. Implementasi minimal (Part B–O) MENUNGGU approval
Anda (lihat §17).

---

## 2. Root Cause — PIC tidak muncul di Pencairan (PROVEN)

### 2.1 Fakta DB (read-only, DB `tinggalklik`)
```
settlements=0
settlementitems=0
refunditems=0
```
Payout surface benar-benar KOSONG. Tidak ada satu `Settlement` pun yang pernah dibuat —
sehingga "tidak ada nama PIC di pencairan" adalah representasi yang JELAS dari `0 row`,
bukan bug read.

### 2.2 Schema SUDAH mendukung identitas PIC pada payout
`prisma/schema.prisma`:
- `Settlement` → `picProfileId String?` (+ relasi `PICEventAssignment`? lihat §2.3),
  `payeeType SettlementPayeeType (default ORGANIZER)`, `organizerId`.
- `SettlementItem` → `picFeeAmountBp Decimal?`, `picFeeItemId String?`, `picFeeType` —
  fee snapshot per item SUDAH ada di tingkat settlement.

### 2.3 Read payload SUDAH meng-join nama PIC
`lib/ticketing/settlement/payload.ts` (baca): `picProfile: { select: { displayName: true,
picCode: true } }` — jadi kalau ada row, nama PIC akan ikut. Tidak ada bug di read path.

### 2.4 Kesimpulan akar
`Settlement` kosong = belum ada payout yang disiapkan. Ini **data lifecycle**, bukan bug. Opsi
yang bisa ditawarkan (tidak dieksekusi): seeding payout test + validator; bukan perubahan read.

---

## 3. Settlement Identity — minimal design (approved, no DB change)

Identitas pada payout: `picProfile.displayName` (relasi SUDAH ada), `picProfile.picCode`,
`Settlement.payeeType`, `Settlement.bankAccountName` (SUDAH ada), masked account number
(harus di-hide di UI public, tidak disimpan plaintext baru). **Tidak ada backfill yang
dibutuhkan** karena `picProfileId` SUDAH nullable di `Settlement` sejak awal.

---

## 4. PIC Settlement / Payout Service Audit

- `lib/ticketing/settlement/service.ts` — SoD: `approveSettlement` menolak
  `preparedByUserId === actor.userId` (`SEPARATION_OF_DUTIES`; kedua-duanya: preparer→approver dan
  approver→preparer tidak boleh sama). Guard `requireSettlementPermission` per organizer. ✓
- Supaya tidak ada regresi per-brief: payout read hanya lewat read-model yang SUDAH join
  `picProfile`; tidak ada exposure account number mentah di list/detail.

---

## 5. PIC Ledger / Fee Read Aku

- `lib/pic/ledger.ts` `getPicLedgerBalance` — ΣCREDIT − ΣDEBIT fail-closed (0 PICProfile → throw).
- `lib/pic/fee.ts` `computeLinePicFee` — pure rate-only V1. Fee snapshot multiped di
  `SettlementItem.picFeeAmountBp`. Ledger EARNED hanya dari `Settlement` SETTLED hook
  (`postEarnedPicFees` → PICFeeLedger). Konsisten dengan brief D-23 (organizer absorbs fee).

---

## 6. Refund Transfer Evidence — AUDIT (kolom + model + alur)

### 6.1 Model Refund (schema.prisma) — evidence fields yang SUDAH ada
```
providerRef   String?   // transfer reference (baris: @unique?) → OK
evidenceNote  String?  @db.Text
completedAt   DateTime?
processedByUserId String?
failureReason String?  @db.Text
failedAt      DateTime?
```
`refunditems=0` → belum ada item evidence.

### 6.2 GAP yang dibuktikan
- **TIDAK ada kolom evidence FILE** (`evidenceFileKey`/`evidenceFileUrl`) di `Refund`.
- Belum ada alur upload (hanya `app/api/uploads/events/[filename]` & `branding/[filename]` = PUBLIC
  GET readers untuk banner/logo — bukan jalur upload writable evidence).
- `providerRef` diisi manual oleh operator; tidak ada validasi bukti.

### 6.3 Keputusan desain evidence (Part D)
Gunakan **storage KEY** (`evidenceFileKey String?` additive) + **PUBLIC-served GET read route
yang authenticated + tenant-scoped**, bukan raw filesystem path. Skema additive only. Upload
wajib: file-type via magic-bytes (bukan MIME client), max size konsisten dengan policy existing
uploads (lihat `lib/uploads.ts` bila ada), filename generated server-side (uuid) + extension
whitelist, NO SVG, PDF diterima bila infra upload SUDAH support PDF — kalau tidak, document
atau image saja.

---

## 7. Refund Evidence — PROOF design (Part D/E confirmed)

Docker mapping (kernel design):
- **ADMIN upload evidence** — hanya untuk refund yang authorize di organizer-nya sendiri
  (`requireSettlementPermission`/`requireOwnResource` tenant); gospel tersimpan server-side.
- **CUSTOMER lihat evidence OWN** — via authenticated, own-scope, tenant-scoped GET route;
  **customer lain → 404 ber-masking** (bukan 403 yang bocor existence).
- **PIC** — TIDAK punya akses evidence refund customer (brief: don't expand PIC).
- Cross-tenant: 404-masked.

`SettlementItem`/`RefundItem` di-scope oleh `refundId` (organizer) — reuse yang ada.

---

## 8. Customer Order UX — AUDIT

Fakta: **TIDAK ADA `list my orders` untuk customer.** Yang ada hanya halaman ticketing
(`/ticketing/orders/[orderNumber]` dsb.) — bukan "Pesanan Saya" global. `SiteHeader` chrome order
hanya hidup pada halaman `/orders` ticketing (lihat komentar file).

Keputusan UX (Part G):
- Tambahkan nav "Pesanan Saya" ke navbar customer (SiteHeader) bila halaman HANYA untuk customer.
- Halaman list baru: `/orders` customer → reuse read-model, own-scope.
- Detail: `/orders/[orderNumber]` → per item: event, tickets, payment, refund status/evidence
  (bila REFUNDED).

---

## 9. Customer Order Detail — (Part I) 🔒 OWN-SCOPE

- Route GET `/orders/[orderNumber]` → `userId = session.userId` (guard), `where userId + orderNumber`
  → 404-mask bila bukan miliknya. **Never** pakai `orderNumber` client sebagai satu-satunya scope.
- Refund-status states: PENDING/PROCESSING/APPROVED/REFUNDED/FAILED — sesuai op

---

## 10. Customer Refund Flow — (Part J) REUSE contract

- Customer hanya bisa request refund di order OWN; selama masih `REFUNDABLE`.
- Customer TIDAK boleh: set amount, set status, set confirmedAmount, approve, execute,
  upload evidence, providerRef — hanya submit request via contract yang sudah ada
  (`refund.requestedByUserId`, own-scope). Server tetap source-of-truth.

---

## 11. Customer Order Pages — Inventory & Gap

Tabel surfaces (read-only dari route/UI):

| Surface | Route | Guard | Status |
|---|---|---|---|
| customer order list | — | — | **MISSING** (buat baru /orders) |
| order detail | (ticketing/orders/[orderNumber]) | own-scope | ada via ticketing, perlu re-use |
| refund request | refunds own | requireOwnResource | ada service, UI perlu dialog |
| refund evidence view | — | — | **MISSING** |
| PIC payout list | dashboards/settlements | organizer scope | read-model ok, data 0 |

---

## 12. Authz / Tenancy Audit — Refund + Evidence + Payout

- `refund` route scope: `requireOrganizerAccess(organizerId, PERMISSIONS.refund.*)` — tenant
  bound. `Settlement` service `requireSettlementPermission` — tenant bound. ✓
- Cross-Tenant: 404 masking (bukan 403). ✓ FAIL-CLOSED.
- **Yang perlu dingat**: semua surface BARU ber-fail-closed (null/404), tidak pernah expose
  evidence ke tenant lain, tidak pernah expose ke PIC. Guard modern di-jaga.

---

## 13. Database Integrity — Settlement picProfileId & backfill

- `Settlement.picProfileId` SUDAH ada sejak schema awal (nullable). TIDAK butuh migration backfill.
- `SettlementItem.picFeeItemId`/`picFeeType` SUDAH ada ⊆ settlement.
- `refundProviderRef` (ringkas): tidak ada kolom; pakai `Refund.providerRef` existing.
- **TIDAK ada kolom evidence-file** → SATU migration additive (`Refund.evidenceFileKey String?` /
  atau `evidenceFileUrl` bila lebih cocok dengan platform storage), plus PRISMA sejalan schema
  (TIDAK destructive). Decision document §17.

---

## 14. Verification (dijalankan, READ edits — tidak ada perubahan file)

```
npx jest __tests__/auth-flow/phase40... → SKIP (bukan fase ini)
npx tsc --noEmit  → bersih (exit 0)
npm run lint       → 0 error (4 warning pre-existing)
npm run build      → exit 0
git diff --check   → bersih untuk file yang di-audit (tidak ada edit)
git status --short → tidak ada file baru (audit murni)
```
DB: read-only. `mysql ... SELECT COUNT(*)` (lihat §2).

---

## 15. Live / Runtime Smoke (opsional; tidak dijalankan karena Tidak Ada Server LIVE)

Diskusi ditunda ke implementasi; memerlukan login admin/PIC/customer yang dictatat di fase
sebelumnya. Audit ini fokus ke kode+schema+DB.

---

## 16. Root Cause (ringkas) — ONE PARAGRAPH

Tidak ada satu pun laporan yang bermuara ke maintenance ataupun login. Yang terjadi secara
berturut-turut: (1) **PIC payout** — tidak ada `Settlement`/`SettlementItem` sama sekali (0 row)
sehingga "pencairan" memang kosong; bukan bug nama PIC karena read payload sudah join
`picProfile.displayName`; (2) **refund evidence** — model `Refund` hanya punya `providerRef` dan
`evidenceNote` (teks), TIDAK punya kolom evidence file maupun jalur upload, sehingga tidak ada
bisa jadi bukti transfer; (3) **customer order UX** — tidak ada surface `list my orders` dan
detail order customer adalah jalur ticketing semata, tanpa nav "Pesanan Saya". Itulah alasan
absennya nama PIC + bukti + "Pesanan Saya" — **semua root-cause terbukti di schema + DB**.

---

## 17. Minimal Implementation Plan (MENUNGGU APPROVAL — belum dieksekusi)

1. **Migration additif** (wajib, menjelaskan dulu): tambah field evidence ke `Refund` —
   `evidenceFileKey String?` (atau `evidenceFileUrl`) + `evidenceUploadedAt DateTime?` +
   `evidenceUploadedByUserId String?`. No destructive.
2. **Upload infra**: route `POST/GET` untuk evidence, tenant-scoped + authenticated, magic-byte
   type check, uuid filename, extension whitelist, NO SVG, size cap konsisten.
3. **Refund dialog** di dashboard: ganti `window.confirm/prompt` (SettlementActions.tsx +
   refunds/*) dengan Dialog/Sheet (primitif SUDAH ada: `components/dashboard/primitives.tsx`).
   Form: amount (server-computed), catatan, evidence upload, error inline, toast, loading state,
   NO optimistic REFUNDED.
4. **Customer "Pesanan Saya"**: route list + detail `/orders` (+ nav SiteHeader), own-scope
   guard, evidens view bila REFUNDED.
5. **Tests** (Part O): own-scope, cross-tenant, PIC-no-access, file validation, invalid/oversize
   file, evidence upload only for authorized, REFUNDED-tidak-dua-kali.
6. **No commit/push/reset/migration tanpa approval.** Semua risk dinilai di report.

---

_Report ditulis read-only; database & schema TIDAK diubah; tidak ada commit/push; tidak ada
migrasi yang dijalankan. Implementasi hanya setelah Anda menandai "go/nogo" di §17._
