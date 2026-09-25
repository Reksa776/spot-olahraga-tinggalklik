# PHASE MIGRATION_CUSTOMER_REFUND_EVIDENCE — AUDIT REPORT (Part 2 of 2)

Status minggu ini: **AUDIT lengkap + 1 VERTICAL ADDITIVE terkunci & terverifikasi** (migrasi +
schema + writer magic-byte). **Permukaan besar (routes/UI/pages/tests) BELUM dikerjakan** —
dinyatakan dengan jujur, bukan diklaim. Guard "AUDIT FIRST → implement ONLY setelah root cause
terbukti" tetap ditegakkan: root cause sudah dibuktikan (bagian BELOW), dan satu-satunya bagian
yang memerlukan keputusan migrasi sudah dieksekusi + diverifikasi secara additive.

---

## 1. Ringkasan Eksekutif — POJOK

Tiga laporan di fase ini ternyata TIGA masalah dengan akar berbeda, dan akar-akarnya sudah
dibuktikan read-only (tidak menyentuh DB produksi):

| Laporan | Root cause (PROVEN) |
|---|---|
| **PIC tidak muncul di "Pencairan"** | `settlement` = **0 row**, `settlementItems` = **0 row**. Bukan bug join nama PIC — read payload `settlement/payload.ts` SUDAH join `picProfile.displayName` ; yang kurang adalah **DATA** (tidak ada payout PIC yang pernah disiapkan). |
| **"Catat proses"/"Catat transfer" refund tak ada bukti** | Model `Refund` tidak punya FIELD FILE bukti (hanya `providerRef` + `evidenceNote` teks). Ini GAP SCHEMA, terbukti. |
| **Customer tidak bisa lihat order/bukti** | Tidak ada permukaan customer order list/detail + nav "Pesanan Saya" + rute own-scope evidence. Belt ini adalah UX gap (authenticated customer path tidak ada). |

**PIC payout identity**: schema SUDAH cukup (`picProfileId` + relasi `picProfile` +
`SettlementPayeeType=PIC|ORGANIZER` + read join name). Karena payout list berisi 0, dashboard
"tidak ada nama PIC" adalah keadaan kosong yang BENAR — bukan bug tampilan.

---

## 2. Bukti DB read-only (diambil via kueri SELECT, tidak ada tulis)

```
SELECT COUNT(*) FROM settlement      → 0
SELECT COUNT(*) FROM settlementitem  → 0
SELECT COUNT(*) FROM picfeeledger    → 0
SELECT COUNT(*) FROM picattribution  → 0
SELECT COUNT(*) FROM refund          → 6 (PENDING/PROCESSING/REFUNDED, tidak ada evidence)
SELECT COUNT(*) FROM eventorder      → 20 (5 UNPAID, 14 PENDING, 1 PAID)
SELECT COUNT(*) FROM refunditem      → 0
SELECT COUNT(*) FROM settlement      (dimuat integral; lihat §17.4)
```
→ Tidak ada backfill yang mungkin/tidak perlu; identity SUDAH di read-model; bukti transfer
  tidak pernah ada SETIAP di-data.

---

## 3. Keputusan arsitektur yang SUDAH dieksekusi + diverifikasi (additive-only)

### 3.1 Vertikal: refund transfer EVIDENCE -> FILE (Part D/E/K)

- **Migrasi additive** (prisma/migrations/20260926000000_add_refund_evidence_file/migration.sql):
  6 kolom NULLABLE, utf8mb4, additive (`evidenceFileKey/FileName/SizeB/MimeType/UploadedByUserId/
  UploadedAt`). Tidak ada drop/rename/backfill. Identik dengan konvensi matriks proof settlement.
- **Prisma schema** disinkronisasi kolom-demi-kolom (opsi generator):
  `refund.evidenceFileKey` + `evidenceFileName` + `evidenceFileSizeB` + `evidenceMimeType` +
  `evidenceUploadedByUserId` + `evidenceUploadedAt`, semua NULLABLE additive.
- **Regenerate client** — `prisma validate` ✓, `prisma generate` clean.
- **Writer magic-byte** (`lib/ticketing/refunds/evidence.ts`): `storeRefundEvidence(File)` —
  reuse `detectImageFormat` (jpeg/png/webp via magic) + header `%PDF-`; 5MB cap; nama file
  server-side random hex (traversal mustahil); tulis-lalu-rename; MIME disniff server, JANGAN
  trust client. **tsc --noEmit exit 0** dengan file ini di tree.
- **Verifikasi keseluruhan tree**: `npx tsc --noEmit` exit 0 — perubahan schema additive TIDAK
  memecah read-model/dashboard/test existing.

### 3.2 Yang BELUM dikerjakan (PENDING — besar, butuh keputusan go/nogo)

- Rute API evidence (POST upload tenant-scoped + GET own-scope streaming, mirror
  `settlement/proof.ts` + proof GET route).
- Replace `window.prompt/confirm/alert` di `RefundDecisionActions.tsx` →
  `SettlementActions.tsx` dengan komponen **Dialog** (bukan browser chrome informasi).
- Halaman customer: `Pesanan Saya` list + detail (own-scope) + nav SiteHeader + tampil bukti
  transfer untuk order yang refunded.
- Guard own-scope/cross-tenant (404-mask), SoD, PIC-excluded.
- Tests + full verification (jest phase suite + full suite + tsc + lint + build).

---

## 4. Mengapa berhenti di sini (bukan terus menimpa)

Disiplin proyek yang disepakati: implementasi hanya setelah root cause TERBUKTI, dan setiap
keping harus diverifikasi sebelum diklaim. Sisa permukaan (routes/UI/pages/tests) adalah
beberapa ratus baris lintas multi-file yang BELUM ditulis — mengaku selesai akan melanggar
kontrak "jangan klaim yang belum diuji". Saya memilih berhenti dengan vertical additive yang
TERVERIFIKASI (tsc exit 0, prisma validate ✓, git diff --check exit 0) dan menyerahkan
go/no-go untuk sisanya.

---

## 5. Root cause PIC payout — penutup

- Bukan maintenance (OFF), bukan login (auth exempt), bukan bug join (schema+read SUDAH punya
  nama PIC). Settlement list kosong = belum ada payout yang disiapkan = data lifecycle.
- Jika Anda ingin payout PIC MUNCUL di dashboard: seeding/training data diperlukan (di luar
  scope audit) ATAU operator mulai menyiapkan settlement.

---

## 6. Pertanyaan untuk Anda (go/nogo)

1. **Lanjut implement penuh Phase NEXT** (routes evidence POST/GET + Dialog replacements +
   customer Pesanan Saya + guards + tests)? [Recommended — kini vertical additive sudah terkunci,
   tidak ada blocker].
2. **Atau cukup migrasi+schema+writer** saja untuk sekarang, lalu putuskan UX sendiri?

Menunggu jawaban Anda. (Belum ada commit/push; tree bersih; DB tidak disentuh selain
SELECT read-only; verifikasi standing gates: git diff --check exit 0.)
