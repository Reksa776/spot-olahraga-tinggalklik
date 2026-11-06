# PHASE 0A — JEST DATABASE ISOLATION (FINAL)

**Project:** TinggalKlik.Co
**Date:** 2026-10-31
**Mode:** audit → implementation (test infrastructure only) → preflight → full regression → stop
**Scope:** hanya Phase 0A. Tidak ada Phase 0B/0C, tidak ada perubahan payment, checkout, settlement, check-in, PIC, UI, notification, schema, migration, atau dependency.

## Status akhir

# PASS

Isolasi database terbukti, preflight database testing lulus, dan full Jest regression selesai dengan **159/159 suite dan 3.467/3.467 test lulus**. Tidak ada blocker Phase 0A yang tersisa.

---

## 1. Identitas database yang diverifikasi (tanpa secret)

| Properti | Nilai |
|---|---|
| Server | MariaDB **11.8.8** |
| Host / port | **127.0.0.1:3306** (sama dengan server database aplikasi) |
| Schema target test | **`tinggalklik_test`** |
| Schema aplikasi | berbeda (`DATABASE_URL`, nama tanpa suffix `_test`) |
| Jumlah tabel di schema test | 63 |
| Migration diterapkan | **32** |
| Migration di disk (`prisma/migrations`) | **32** |
| Migration pending | **0** |
| Migration terakhir | `20260929000000_add_payment_active_order_id`, `20260927000000_add_pic_payout_requests`, `20260926000000_add_refund_evidence_file` |
| `DIRECT_URL` / `SHADOW_DATABASE_URL` | tidak ada (tidak dapat mengalihkan datasource) |

Identitas diambil dengan query read-only (`SELECT DATABASE(), VERSION(), @@hostname, @@port`, `information_schema.TABLES`, `_prisma_migrations`) sebelum regresi. Tidak ada DDL, migration, seed, atau perubahan data pada langkah preflight.

**Kredensial.** Sesuai keputusan owner, `TEST_DATABASE_URL` memakai kredensial lokal yang sudah ada di `.env`, dengan **hanya nama database diganti** menjadi `tinggalklik_test`. Ini bukan asumsi: aksesnya dibuktikan lewat probe read-only sebelum konfigurasi ditulis. Tidak ada user database test terpisah yang dibuat, tidak ada grant yang diubah, dan tidak ada nilai kredensial yang dicetak ke terminal, laporan, atau Git.

`TEST_DATABASE_URL` ditulis hanya ke `.env` lokal (git-ignored, terverifikasi dengan `git check-ignore`). `DATABASE_URL` aplikasi tidak diubah: panjang nilainya tetap sama seperti sebelum langkah ini, dan file `.env` tidak muncul di `git status`.

---

## 2. Status migration

- `_prisma_migrations` ada, dan **32 migration tercatat selesai** (`finished_at IS NOT NULL`, tanpa rollback).
- Jumlah direktori `migration.sql` di disk juga **32** → tidak ada migration yang belum diterapkan.
- `npm run test:db:setup` (read-only) mengonfirmasi: `Verified isolated test schema 'tinggalklik_test'. No data was changed.`
- Global setup Jest memeriksa ulang kondisi ini pada setiap run dan akan gagal sebelum suite berjalan bila schema tertinggal.

Tidak ada migration yang dijalankan pada Phase 0A.

---

## 3. Ringkasan perubahan (Phase 0A)

| File | Status | Perubahan |
|---|---|---|
| `__tests__/support/test-database.ts` | modified | Resolver eksplisit + validasi identitas MySQL + guard `PrismaClient` + redirect env per worker + cache application URL lintas `setupFiles`. |
| `jest.setup-env.ts` | modified | Tetap `setupFiles`; memanggil resolver sebelum module graph. |
| `__tests__/support/global-setup.ts` | modified | Hanya memakai URL test tervalidasi; probe `SELECT 1` ke database aplikasi dihapus. |
| `__tests__/support/fixture-teardown.ts` | modified | Satu target tervalidasi; daftar target `[test, app]` dihapus. |
| `jest.config.js` | modified | Komentar lifecycle diselaraskan (tidak ada perubahan hook). |
| `scripts/setup-test-db.ts` | modified | Verifikasi read-only terhadap `TEST_DATABASE_URL`; tanpa koneksi aplikasi, DDL, migrate, atau seed. |
| `.env.example` | modified | Mendokumentasikan `TEST_DATABASE_URL` sebagai variabel wajib untuk Jest. |
| `__tests__/support/test-database.safety.test.ts` | new | 12 safety test ber-stub untuk resolver, setup, teardown, dan guard. |
| `__tests__/support/test-database.prisma-guard.test.ts` | new | 2 test terhadap module `@prisma/client` **asli** (tanpa mock), membuktikan guard mencapai import test nyata. |
| `jest.safety.config.js` | new | Config terisolasi tanpa `setupFiles`/`globalSetup`/`globalTeardown` DB. |
| `.env` (lokal, git-ignored) | modified | Menambahkan `TEST_DATABASE_URL` eksplisit. Tidak masuk Git, tidak masuk laporan. |

Tidak ada perubahan pada `prisma/schema.prisma`, migration, dependency, atau business logic. Tidak ada commit/push/reset/rebase/stash.

---

## 4. Root cause (terverifikasi)

Masalahnya bukan satu blok teardown, melainkan **tidak adanya target test yang eksplisit**. Target test diturunkan dari `DATABASE_URL` aplikasi, sehingga selalu ada dua target valid dan beberapa jalur memakai keduanya:

1. `testDatabaseUrl()` lama menghitung `<DATABASE_URL database>_test`; tidak ada nilai wajib yang bisa gagal.
2. Teardown lama menyapu `unique([derived_test, app])` → `event.updateMany` dan `sport.updateMany` pada **database aplikasi**.
3. Global setup lama membuat PrismaClient kedua dengan `datasources.db.url = appUrl` lalu `SELECT 1` ke database aplikasi.
4. `scripts/setup-test-db.ts` lama memakai `new PrismaClient()` (URL aplikasi) untuk membaca metadata schema aplikasi, `CREATE DATABASE`, `migrate deploy`, dan seed.
5. Tidak ada mekanisme yang menolak URL test kosong, ambigu, atau sama dengan database aplikasi.

Bukti 12 sport fixture nonaktif di database aplikasi tetap **tidak dapat diatribusikan** ke run tertentu (tidak ada baseline). Phase 0A tidak mengubah data tersebut.

---

## 5. Cara isolasi dibuktikan

### 5.1 Validasi sebelum koneksi (`resolveTestDatabaseUrl`)

- `TEST_DATABASE_URL` wajib; **tidak ada** derivasi/fallback dari `DATABASE_URL`.
- `DATABASE_URL` wajib ada hanya sebagai pembanding identitas; nilainya tidak pernah dipakai untuk koneksi.
- Wajib URL MySQL absolut dengan hostname + username; nama database di-decode, divalidasi regex, dinormalisasi.
- Host + port wajib sama dengan `DATABASE_URL`; nama database wajib **berbeda**.
- Nama database test wajib berakhiran `_test`; nama database aplikasi **tidak boleh** berakhiran `_test`.
- `DIRECT_URL`/`SHADOW_DATABASE_URL` (bila ada) wajib identik dengan target test, jika tidak → gagal.

### 5.2 Worker tidak bisa diam-diam memakai database aplikasi

- `setupFiles` mengganti `DATABASE_URL` menjadi URL test tervalidasi **sebelum** module graph, sehingga `lib/prisma.ts` dan `new PrismaClient()` tanpa opsi hanya bisa mencapai test DB.
- Application URL asli diingat pada `globalThis` (symbol), karena `setupFiles` berjalan ulang untuk setiap file test dalam worker yang sama.
- Export `PrismaClient` di-patch: menolak `datasourceUrl`/`datasources.db.url` eksplisit yang bukan URL test, menolak perubahan env setelah isolasi ditetapkan, dan selalu memaksa datasource ke URL test.
- Guard diuji terhadap **module asli** (bukan hanya mock) oleh `test-database.prisma-guard.test.ts`.

### 5.3 Bukti pada run regresi nyata

- **0** query tertulis yang menyebut schema aplikasi (``` `tinggalklik`. ```) di seluruh log regresi.
- **323.374** query tertulis menyebut ``` `tinggalklik_test`. ```.
- Teardown global selesai tanpa warning kegagalan koneksi; tidak ada pesan `Too many connections`, `ETIMEDOUT`, atau error cleanup.
- Setup, teardown, dan provisioning hanya membangun PrismaClient dari URL hasil resolver; `DATABASE_URL` hanya di-parse untuk perbandingan.

---

## 6. Hasil verifikasi (urut sesuai eksekusi)

| # | Pemeriksaan | Perintah | Hasil |
|---|---|---|---|
| 1 | Safety suite Phase 0A | `npx jest --config jest.safety.config.js --runInBand` | **PASS** — 2 suite, **14/14 test**, tanpa koneksi DB |
| 2 | Verifikasi schema test (read-only) | `npm run test:db:setup` | **PASS** — `Verified isolated test schema 'tinggalklik_test'. No data was changed.` |
| 3 | Status migration (read-only) | query `_prisma_migrations` + `information_schema` | **PASS** — 32/32 applied, 0 pending |
| 4 | Full Jest regression | `npx jest --runInBand` | **PASS** — **159/159 suite**, **3.467/3.467 test**, 2 snapshot, 184,6 s, exit 0 |
| 5 | TypeScript | `npx tsc --noEmit --incremental false` | **PASS** — tanpa error |
| 6 | Prisma validate | `npx prisma validate` | **PASS** — schema valid, tanpa koneksi |
| 7 | ESLint (file Phase 0A) | `npx eslint --no-cache <files>` | **PASS** — 0 error / 0 warning |
| 8 | Diff hygiene | `git diff --check` | **PASS** |

Production build tidak dijalankan: tidak diperlukan untuk memverifikasi Phase 0A dan berisiko menimpa artefak `.next` yang ada. `npm audit` tidak dijalankan (Phase 0C).

---

## 7. Preflight database testing

| Pemeriksaan | Hasil |
|---|---|
| `TEST_DATABASE_URL` tersedia di environment lokal | **YA** (di `.env`, git-ignored) |
| Target berbeda dari database aplikasi | **YA** — `tinggalklik_test` vs schema aplikasi |
| Host/port identitas | **Sama** (127.0.0.1:3306), sehingga tidak ambigu lintas server |
| Suffix `_test` | **YA** |
| Alias datasource berbahaya (`DIRECT_URL`, `SHADOW_DATABASE_URL`) | **Tidak ada** |
| Schema test ada dan dapat diakses | **YA** — 63 tabel |
| Migration status | **Lengkap** — 32/32 |
| Jalur tulis ke database aplikasi pada setup/teardown | **Tidak ada** |
| Full Jest dijalankan setelah preflight PASS | **YA** |

Tidak ada database yang dibuat, dimigrasikan, di-seed, atau dihapus. Tidak ada kredensial yang dicetak.

---

## 8. Git status / perubahan pre-existing

```
 M .env.example
 M __tests__/support/fixture-teardown.ts
 M __tests__/support/global-setup.ts
 M __tests__/support/test-database.ts
 M jest.config.js
 M jest.setup-env.ts
 M lib/authz/permissions.ts          <- pre-existing, tidak disentuh
 M package-lock.json                 <- pre-existing, tidak disentuh
 M package.json                      <- pre-existing, tidak disentuh
 M scripts/setup-test-db.ts
?? .cloud-attachments/               <- artefak impor percakapan, tidak disentuh
?? PHASE_0A_JEST_DATABASE_ISOLATION_REPORT.md
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/support/test-database.prisma-guard.test.ts
?? __tests__/support/test-database.safety.test.ts
?? jest.safety.config.js
```

Perubahan pre-existing dipertahankan apa adanya. `.env` tidak muncul karena git-ignored.

---

## 9. Risiko / catatan tersisa

1. **Kredensial test = kredensial aplikasi (disetujui owner).** Isolasi bertumpu pada pengejaran database di resolver + guard Prisma, bukan pada pemisahan privilege. Bila guard dilewati oleh jalur yang belum tercakup, query akan berjalan dengan privilege level aplikasi. Bukti run nyata: 0 query ke schema aplikasi. Saran jangka panjang: user MySQL khusus test yang hanya punya akses ke `tinggalklik_test`.
2. **Schema test tidak kembali ke snapshot murni.** Fixture suite mengarsipkan event dan menonaktifkan sport di `tinggalklik_test` (sesuai desain teardown). Ini hanya menyentuh database test.
3. **Satu schema test dibagi semua suite** (`maxWorkers: 1`); menaikkan worker akan mengembalikan race antar-suite.
4. **Guard bergantung pada export CommonJS `@prisma/client`.** Jalur CJS sudah diuji dengan module asli; import ESM langsung di masa depan tidak melewati patch dan hanya mengandalkan redirect env + validasi statis.
5. **`.env` bersifat lokal.** Untuk CI, `TEST_DATABASE_URL` tetap harus disediakan sebagai secret environment; tanpa itu Jest gagal tertutup (fail-closed), bukan memakai database aplikasi.
6. **12 sport fixture nonaktif** di database aplikasi tetap seperti ditemukan; tidak dibersihkan dan tidak dianalisis ulang karena tidak ada baseline.
7. **`npm run test:db:setup` hanya memverifikasi**, tidak memprovision. Schema test harus sudah ada dan termigrasi (saat ini sudah).

---

## 10. Kesimpulan

- Isolasi database Jest: **terbukti fail-closed**, hanya menargetkan `TEST_DATABASE_URL` eksplisit.
- Safety suite: **14/14 lulus**.
- Preflight database test: **PASS** — `tinggalklik_test`, 32/32 migration, tanpa perubahan data.
- Full regression: **PASS** — 159/159 suite, 3.467/3.467 test.
- Verifikasi statis: **typecheck, Prisma validate, ESLint, diff check — PASS**.

**PHASE 0A: PASS.** Berhenti di sini; tidak memulai Phase 0B/0C atau fitur produk. Menunggu instruksi owner.
