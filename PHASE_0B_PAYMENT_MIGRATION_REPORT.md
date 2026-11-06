# PHASE 0B — PAYMENT MIGRATION PREFLIGHT & SYNCHRONIZATION

**Project:** TinggalKlik.Co
**Date:** 2026-10-31
**Mode:** read-only preflight → backup & restore proof → migration rehearsal → controlled deploy → post-verification → stop
**Scope:** hanya `20260929000000_add_payment_active_order_id`. Tidak ada fitur payment baru, tidak ada perubahan business logic/webhook/issuance, tidak ada dependency update, tidak ada Phase 0C/1.

## Status akhir

# PASS (cakupan Phase 0B)

Satu migration tertinggal pada database aplikasi berhasil diterapkan tanpa kehilangan data, tanpa mengubah status pembayaran apa pun, dan tanpa menyentuh database test. `prisma migrate status` sekarang melaporkan **"Database schema is up to date!"** dan diff Prisma untuk tabel `payment` sudah **nol**.

Satu catatan kejujuran yang harus dibaca bersama status ini: **kesamaan schema aplikasi dengan `prisma/schema.prisma` tercapai untuk domain payment/order, bukan untuk seluruh database.** Sisa `prisma migrate diff` (211 baris) adalah drift legacy yang sudah ada sebelum fase ini (tabel retail/affiliate lama, kolom legacy, dan penamaan index lama). Itu di luar cakupan Phase 0B dan tidak diubah — memperbaikinya memerlukan migration schema baru atau `db push`, keduanya dilarang pada fase ini. Rincian di §10.

---

## 1. Keadaan awal repository dan database

```
 M .env.example
 M __tests__/support/fixture-teardown.ts
 M __tests__/support/global-setup.ts
 M __tests__/support/test-database.ts
 M jest.config.js
 M jest.setup-env.ts
 M lib/authz/permissions.ts          <- pre-existing
 M package-lock.json                 <- pre-existing
 M package.json                      <- pre-existing
 M scripts/setup-test-db.ts
?? .cloud-attachments/               <- artefak impor
?? PHASE_0A_JEST_DATABASE_ISOLATION_REPORT.md
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/support/test-database.prisma-guard.test.ts
?? __tests__/support/test-database.safety.test.ts
?? jest.safety.config.js
```

Branch `main`. Tidak ada perubahan pada `prisma/` di working tree. Jumlah direktori migration di disk: **32** `migration.sql` (termasuk `0_baseline`), lock provider `mysql`.

| Entitas | Sebelum Phase 0B |
|---|---|
| Migration di repo | 32 |
| Migration diterapkan di DB aplikasi | **31** (terakhir `20260927000000_add_pic_payout_requests`) |
| Migration diterapkan di DB test | **32** (termasuk `20260929000000_add_payment_active_order_id`) |
| Migration pending di repo | **1** — `20260929000000_add_payment_active_order_id` |

Temuan historis pada audit sebelumnya (**31 / 32 / 32**) **terkonfirmasi ulang dan masih berlaku** saat fase ini dimulai.

---

## 2. Identitas database (tanpa kredensial)

| Properti | Nilai |
|---|---|
| Schema target | **`tinggalklik`** |
| Engine / versi | **MariaDB 11.8.8** |
| Host / port | `127.0.0.1:3306` (loopback) |
| Server hostname | `webdev` |
| Datadir | `/var/lib/mysql/` (lokal) |
| Proses server | `mariadbd` lokal (system service) berjalan di mesin ini |
| Jumlah tabel | 64 |
| Total baris (semua tabel) | 6.143 |
| Tabel backup legacy | `refund_backup_phase10b` (6 baris, sengaja dipertahankan oleh migration 20260919/20260920) |

**Bukti bahwa ini lokal, bukan staging/production:** koneksi memakai loopback, server MariaDB adalah proses lokal di mesin ini (`/usr/libexec/mariadbd`, datadir `/var/lib/mysql`), tidak ada file deployment (Vercel/Docker/Fly/Procab) di repo, dan schema target bukan `_test`. Skrip backup menolak berjalan bila host bukan loopback atau nama schema berakhiran `_test`, dan penolakan itu diuji secara implisit lewat guard yang berjalan sebelum dump (keluaran: `TARGET_HOST_IS_LOOPBACK true`, `TARGET_IS_TEST_SCHEMA false`).

Tidak ada kredensial atau connection string yang dicetak pada fase ini.

**Catatan keamanan lingkungan (tidak diubah):** akun MySQL lokal yang dipakai aplikasi tidak memakai password — terdeteksi dari peringatan klien saat backup ("insecure passwordless login"). Ini kondisi lokal yang sudah ada sebelumnya; Phase 0B tidak mengubah user, grant, atau autentikasi.

---

## 3. Discrepancy dan akar masalah (terverifikasi)

**Gejala:** database aplikasi tertinggal satu migration dari repo dan dari database test.

**Akar masalah — terverifikasi, bukan diasumsikan:**

1. `_prisma_migrations` di `tinggalklik` berisi **31 baris**, semuanya `finished_at IS NOT NULL`, **tidak ada** baris `rolled_back_at`, dan **tidak ada baris sama sekali** untuk `20260929000000_add_payment_active_order_id`. Jadi bukan "gagal", bukan "setengah jalan" — migration itu **belum pernah dijalankan** di database ini.
2. Bukti fisik di schema: kolom `payment.activeOrderId` **tidak ada**, dan index `payment_activeOrderId_key` **tidak ada**. Tidak ada objek dari migration tersebut yang sudah terbentuk.
3. Database test (`tinggalklik_test`) memang sudah memilikinya: kolom `activeOrderId` (`varchar(191) NULL`) dan unique index `payment_activeOrderId_key`, dengan checksum baris migration **identik** dengan file di disk (`c627d8fb…`).
4. Tidak ada migration lain yang menunggu. `DIRECT_URL`/`SHADOW_DATABASE_URL` tidak ada, sehingga tidak ada datasource kedua yang bisa mengalihkan target.

Kesimpulan: drift ini murni **"satu migration belum diterapkan"**, bukan history rusak. Itu sebabnya penyelesaian yang benar adalah `prisma migrate deploy` biasa, bukan `resolve`/`db push`/`reset`.

### Temuan tambahan: dua checksum lama tidak cocok (pre-existing)

Membandingkan SHA-256 setiap `migration.sql` dengan checksum yang tercatat di `_prisma_migrations`:

| Migration | Checksum DB | Checksum disk | Status |
|---|---|---|---|
| 29 migration lain | — | — | **cocok** |
| `20260826000000_remove_spin_unique_constraint` | `7281011a…` | `d796bb8d…` | **tidak cocok** (pre-existing) |
| `20260827000000_add_refund_system` | `626faa11…` | `fca06a7e…` | **tidak cocok** (pre-existing) |

`git log` untuk kedua file hanya menunjukkan commit yang **membuat** file tersebut (`715c1fa`, `8100d06`) dan tidak ada commit yang mengubahnya setelahnya. Artinya checksum yang tersimpan berasal dari isi file yang berbeda pada saat migration dijalankan (mis. database pernah di-restore/dipindah antar mesin — repo memuat commit "testing vps"). Ini **tidak dapat dipastikan dari repo** dan **tidak diperbaiki** di fase ini: memperbaikinya berarti memanipulasi history migration (`migrate resolve`), yang dilarang.

Dampak praktis: **tidak memblokir** deploy. `prisma migrate deploy` hanya menerapkan migration yang belum tercatat dan tidak memverifikasi checksum migration yang sudah diterapkan. Migration target sendiri memiliki checksum yang cocok setelah diterapkan (§8).

---

## 4. Analisis SQL dan dampak data

File: `prisma/migrations/20260929000000_add_payment_active_order_id/migration.sql` — dianalisis dari isinya, bukan dari namanya.

| # | Statement | Sifat |
|---|---|---|
| 1 | `ALTER TABLE payment ADD COLUMN activeOrderId VARCHAR(191) NULL` | **Aditif**, nullable, tanpa default → tidak menulis ulang baris |
| 2 | `UPDATE payment p JOIN (SELECT id … ROW_NUMBER() OVER (PARTITION BY orderId ORDER BY createdAt DESC, id DESC) …) newest … SET p.activeOrderId = p.orderId` | Back-fill: **hanya** baris berstatus `UNPAID`/`PENDING`, hanya yang **terbaru per order**; status tidak diubah |
| 3 | `CREATE UNIQUE INDEX payment_activeOrderId_key ON payment(activeOrderId)` | Unique index; NULL berulang diizinkan (MariaDB memperlakukan NULL sebagai distinct) |

- **Tidak ada** `DROP`, `TRUNCATE`, `DELETE`, perubahan tipe kolom, atau perubahan nilai `status`/timestamp.
- **Tidak ada foreign key** baru. FK yang ada pada `payment` (`orderId`, `organizerId`, `createdByUserId`) tidak disentuh.
- **Kompatibilitas engine:** window function memerlukan MariaDB ≥10.2 / MySQL ≥8.0; server adalah **MariaDB 11.8.8** → didukung. Bentuk `UPDATE … JOIN (derived table)` legal karena derived table dimaterialisasi. Bukti kuat: SQL yang sama **sudah berhasil diterapkan** di `tinggalklik_test` pada engine yang sama, dan berhasil lagi pada rehearsal (§6).
- **Objek sudah ada di target?** Tidak — kolom dan index belum ada sebelum fase ini.
- **Apakah baris lama melanggar unique index?** Tidak. Syarat pelanggaran adalah ≥2 baris `UNPAID`/`PENDING` untuk `orderId` yang sama.

### Hasil pemeriksaan data (read-only, sebelum mutasi)

| Pemeriksaan | Hasil |
|---|---|
| Total `payment` | **15** baris |
| Distribusi status | `PENDING` 6, `PAID` 1, `EXPIRED` 8 |
| `eventorder` | 20 baris |
| `paymenttransaction` | 1 baris |
| `webhookevent` | 1 baris |
| Order dengan >1 payment aktif (`UNPAID`/`PENDING`) | **0** (maksimum 1 per order) |
| Payment yatim (orderId tanpa order) | **0** |
| Baris yang akan di-back-fill | **6** (semua `PENDING`, masing-masing order unik) |
| Baris terminal (tetap NULL) | **9** (`PAID`/`EXPIRED`) |
| Ukuran tabel `payment` | ±16 KB data, ±96 KB index, InnoDB |
| Transaksi/statement aktif lain saat preflight | **0** |

**Dampak operasional:** tabel 15 baris; `ADD COLUMN` aditif, `UPDATE` 6 baris, `CREATE UNIQUE INDEX` atas 15 nilai. Tidak ada rewrite tabel besar, tidak ada lock berkepanjangan. Risiko yang tersisa hanyalah metadata lock singkat saat DDL, dan itu terukur (deploy selesai dalam ~71 ms menurut selisih `started_at`→`finished_at`).

**Transformasi data:** tidak ada baris yang perlu diubah manual. Migration sendiri yang mengisi kolom baru; tidak ada record yang dimodifikasi "agar migration lolos".

---

## 5. Backup dan bukti recovery

| Properti | Nilai |
|---|---|
| Tool | `mariadb-dump` (`--single-transaction --quick --triggers --routines --events --no-tablespaces`) |
| Lokasi | `/tmp/phase0b-backup/tinggalklik-pre-0b-20261031T032734.sql` |
| Ukuran | **932.067 byte** |
| SHA-256 | `28cc3b66e75b5f94b12ea296e584ef562df524f03fa25b56bc4c1dd936503651` |
| Permission | file `600`, direktori `700` |
| Isi | **64** `CREATE TABLE`, 53 `INSERT INTO`, marker `-- Dump completed` ada |
| Metadata | `/tmp/phase0b-backup/backup-meta.json` (identitas target tanpa kredensial) |
| Waktu ambil | 2026-10-31T03:27:34Z |

**Nama file saja tidak dianggap bukti.** Backup diverifikasi dengan **restore penuh** ke schema scratch `tinggalklik_0b_rehearsal`:

| Verifikasi setelah restore | Hasil |
|---|---|
| Restore exit code | **0** |
| Jumlah tabel | **64** (sama dengan sumber) |
| `payment` / `eventorder` / `_prisma_migrations` / `refund_backup_phase10b` | **15 / 20 / 31 / 6** (sama dengan sumber) |
| Kolom `activeOrderId` sebelum migration | **tidak ada** (sesuai kondisi pra-migrasi) |

Schema scratch tersebut kemudian dipakai untuk **rehearsal** migration (§6) dan setelah itu **dihapus**. Satu-satunya statement destruktif yang dijalankan pada seluruh fase ini adalah `DROP DATABASE tinggalklik_0b_rehearsal` — objek yang dibuat oleh fase ini sendiri, berisi salinan, bukan data asli. Tidak ada restore ke database aplikasi.

**Prosedur recovery (terdokumentasi, belum dijalankan):**
1. Hentikan proses aplikasi yang menulis ke database.
2. Pulihkan dari dump: `mariadb --host=<loopback> --user=<user> --database=tinggalklik < /tmp/phase0b-backup/tinggalklik-pre-0b-20261031T032734.sql`.
3. Verifikasi: jumlah tabel 64, `payment` 15 baris, `_prisma_migrations` 31 baris, lalu `SELECT COUNT(*) FROM payment WHERE activeOrderId IS NOT NULL` harus gagal (kolom tidak ada) — menandakan snapshot pra-migrasi.
4. Restore **hanya** atas persetujuan owner; tidak dilakukan otomatis.

**Batas:** backup berada di `/tmp` (tmpfs, hilang saat reboot). Ini cukup untuk rollback jangka pendek Phase 0B, tetapi bukan retensi jangka panjang — keputusan lokasi retensi ada pada owner.

---

## 6. Rehearsal pada salinan data asli (sebelum menyentuh DB aplikasi)

Pada schema scratch hasil restore, SQL migration dijalankan **apa adanya** (file tidak diubah):

| Pemeriksaan | Hasil |
|---|---|
| Exit code SQL | **0** |
| Baris ter-back-fill | **6** (sesuai perkiraan) |
| Baris NULL (terminal) | **9** |
| Baris yang melanggar invariant | **0** |
| Unique index `payment_activeOrderId_key` | ada, `NON_UNIQUE=0` |
| Jumlah baris `payment` / `eventorder` / `paymenttransaction` | **15 / 20 / 1** (tidak berubah) |

Rehearsal ini membuktikan tiga hal sekaligus: backup dapat direstore, SQL valid pada engine ini, dan hasilnya sesuai invariant — sebelum database aplikasi disentuh.

---

## 7. Operasi yang benar-benar dijalankan

**Read-only (tidak mengubah state):** query `_prisma_migrations`, `information_schema`, agregasi baris `payment`/`eventorder`, `prisma migrate diff`, `prisma migrate status`, `prisma validate`, `git log`, `mariadb-dump` (membaca), dan seluruh pemeriksaan pasca-migrasi.

**Mengubah state — daftar lengkap:**

| # | Operasi | Target | Hasil |
|---|---|---|---|
| 1 | `CREATE DATABASE tinggalklik_0b_rehearsal` | schema scratch baru | dibuat |
| 2 | Restore dump ke schema scratch | schema scratch | exit 0 |
| 3 | Jalankan SQL migration (rehearsal) | schema scratch | exit 0 |
| 4 | `DROP DATABASE tinggalklik_0b_rehearsal` | schema scratch milik fase ini | terhapus, terverifikasi |
| 5 | `npx prisma migrate deploy` | **`tinggalklik`** | menerapkan **tepat 1** migration, exit 0 |

Tidak ada `migrate reset`, `db push`, `migrate dev`, `migrate resolve`, flag force, seed, atau edit history. Database test **tidak** dimigrasikan dan tidak ditulis pada fase ini.

Sebelum eksekusi, target dikonfirmasi ulang tepat sebelum deploy:

```
{"db":"tinggalklik","port":"3306","version":"11.8.8-MariaDB","applied":31,
 "last":"20260927000000_add_pic_payout_requests","activeColumnPresent":0,
 "otherActiveStatements":0}
```

Keluaran deploy: `32 migrations found` → `Applying migration 20260929000000_add_payment_active_order_id` → `All migrations have been successfully applied.` (exit 0). Tidak ada migration tak terduga yang muncul.

---

## 8. Status migration sebelum vs sesudah

| Properti | Sebelum | Sesudah |
|---|---|---|
| `prisma migrate status` | 1 migration belum diterapkan | **"Database schema is up to date!"** |
| Baris `_prisma_migrations` | 31 | **32** |
| `finished_at IS NOT NULL` | 31 | **32** |
| `rolled_back_at IS NOT NULL` | 0 | **0** |
| `applied_steps_count` migration target | — | **1** |
| Checksum migration target vs disk | — | **cocok** (`c627d8fb…`) |
| Kolom `payment.activeOrderId` | tidak ada | `varchar(191) NULL`, default NULL |
| Unique index `payment_activeOrderId_key` | tidak ada | ada, `NON_UNIQUE=0` |
| Diff Prisma untuk `payment` | 2 statement (ADD COLUMN + CREATE UNIQUE INDEX) | **tidak ada** |
| `CHECK TABLE payment` | — | **OK** |
| Migration pending | 1 | **0** |

---

## 9. Jumlah baris sebelum vs sesudah (bukti data utuh)

Fingerprint diambil atas seluruh 24 kolom `payment` yang sudah ada sebelumnya (kolom baru tidak disertakan), diurutkan per `id`:

| Item | Sebelum | Sesudah |
|---|---|---|
| Tabel | 64 | **64** |
| Total baris seluruh database | 6.143 | **6.144** |
| `payment` | 15 | **15** |
| `eventorder` | 20 | **20** |
| `paymenttransaction` | 1 | **1** |
| `webhookevent` | 1 | **1** |
| **Fingerprint `payment` (SHA-256)** | `4276ab26a517fd4b…` | `4276ab26a517fd4b…` → **identik** |
| Satu-satunya tabel yang berubah jumlah baris | — | `_prisma_migrations` 31 → 32 |

Distribusi status tidak berubah: `PENDING` 6, `PAID` 1, `EXPIRED` 8. Dari 6 baris `PENDING`, **keenamnya** mendapat `activeOrderId = orderId`; 9 baris terminal tetap `NULL`. Invariant "maksimal satu attempt aktif per order" diverifikasi: **0 pelanggaran, 0 duplikat**.

Artinya: tidak ada pembayaran, order, atau riwayat yang hilang, berubah status, atau bertambah selain satu baris ledger migration.

---

## 10. Hasil verifikasi test dan statis

| # | Pemeriksaan | Perintah | Hasil |
|---|---|---|---|
| 1 | Migration status | `npx prisma migrate status` | **PASS** — up to date, 32 migration |
| 2 | Diff Prisma (payment) | `prisma migrate diff` | **PASS** — tidak ada diff `payment` |
| 3 | Prisma validate | `npx prisma validate` | **PASS** |
| 4 | TypeScript | `npx tsc --noEmit --incremental false` | **PASS** — tanpa error |
| 5 | Test payment/checkout/refund | `npx jest __tests__/ticketing-payment __tests__/ticketing-checkout __tests__/ticketing-refunds --runInBand` | 482 test: **481 lulus, 1 gagal** (lihat di bawah) |
| 6 | Ulang test yang gagal | `npx jest __tests__/ticketing-payment/payment-races.integration.test.ts --runInBand` | **PASS** — 8/8 |
| 7 | Full regression | `npx jest --runInBand` | **PASS** — **159/159 suite, 3.467/3.467 test**, 2 snapshot, 179,1 s, exit 0 |
| 8 | Bukti isolasi DB test | grep log regresi | **0** query menyebut schema aplikasi, **43.690** menyebut `tinggalklik_test` |
| 9 | DB aplikasi tidak tersentuh test | fingerprint ulang setelah regresi | **identik** (15 payment, 6.144 baris, 32 migration) |
| 10 | Schema test tetap valid | `npm run test:db:setup` | **PASS** — `Verified isolated test schema 'tinggalklik_test'. No data was changed.` |
| 11 | ESLint file yang berubah | — | **N/A** — tidak ada file source yang diubah pada fase ini |
| 12 | Diff hygiene | `git diff --check` | **PASS** |

**Tentang satu kegagalan test:** `__tests__/ticketing-payment/payment-races.integration.test.ts` › *"G1. expiry and settlement cannot both win (4 rounds)"* gagal pada run gabungan pertama (`expected sold 0, received 2`), lalu **lulus saat dijalankan ulang sendiri (8/8)** dan **lulus pada full regression**. Fase ini tidak mengubah kode aplikasi maupun schema test (schema test sudah memiliki kolom/index sebelum fase dimulai), sehingga kegagalan itu adalah flake sensitif beban pada test balapan waktu, bukan regresi akibat migration. Assertion **tidak** diubah atau dilemahkan.

**Catatan penting:** keberhasilan test **bukan** bukti sinkronisasi database. Bukti sinkronisasi ada di §8 dan §9 (status migration, kolom/index, fingerprint data), yang diperiksa langsung ke database.

---

## 11. Risiko dan blocker yang tersisa

1. **Drift legacy di luar cakupan (tidak diperbaiki).** `prisma migrate diff` setelah migrasi masih menghasilkan 211 baris: 27 `DROP TABLE` (tabel retail/affiliate/spin lama dan `refund_backup_phase10b`), 43 `DropForeignKey`, 3 `AlterTable` (kolom legacy di `notification`, `storesetting`, `user`), 5 `DropIndex`, dan 13 `RedefineIndex` (perbedaan kapitalisasi nama index). Semua ini **sudah ada sebelum Phase 0B**. Karena itu klaim "application schema identik dengan `prisma/schema.prisma`" **tidak** dibuat; yang dicapai adalah: seluruh migration repo teraplikasi dan domain payment/order konsisten. Menutup sisa drift memerlukan migration baru atau `db push` — di luar izin fase ini.
2. **Dua checksum migration lama tidak cocok** (`20260826000000`, `20260827000000`). Tidak memblokir `migrate deploy`, tetapi berarti isi file di repo berbeda dari yang pernah dijalankan. Jangan "diperbaiki" dengan `migrate resolve`; perlu keputusan owner (mis. mencatatnya sebagai fakta historis atau membekukan file).
3. **Database test menyimpan satu baris migration gagal historis** (`20260923000000_add_pic_fee_snapshots`, `rolled_back_at` 2026-09-23, `applied_steps_count=0`). Ini **sudah ada sebelum fase ini** dan tidak diubah; schema test tetap berfungsi (63 tabel, 32 migration selesai, index `activeOrderId` ada). Jangan dibersihkan tanpa rencana tersendiri.
4. **Backup bersifat sementara** di `/tmp` (tmpfs). Untuk rollback jangka pendek cukup, tetapi bukan retensi. Perlu keputusan owner soal lokasi penyimpanan jangka panjang.
5. **Akun MySQL lokal tanpa password** (kondisi lama). Tidak diubah di fase ini; layak ditinjau bersama pemisahan user test.
6. **Data historis `EXPIRED` dengan `order.paymentStatus = PENDING`.** Delapan order berstatus `EXPIRED` tetapi `paymentStatus` order-nya masih `PENDING`. Migration hanya menyentuh `payment.activeOrderId` dan tidak memperbaiki ketidaksesuaian ini; **tidak diubah** karena di luar cakupan dan tidak boleh "merapikan data agar migration lolos".
7. **Flake test balapan waktu** (`payment-races` G1) dapat muncul lagi pada mesin dengan beban tinggi. Bukan efek migrasi, tetapi mengurangi keandalan sinyal CI.
8. **`prisma migrate deploy` tidak memverifikasi checksum** migration yang sudah diterapkan, sehingga drift checksum tidak akan terdeteksi otomatis oleh deploy.

Tidak ada blocker yang menghalangi penggunaan database aplikasi saat ini.

---

## 12. Perubahan pre-existing yang dipertahankan

Tidak ada commit, push, reset, rebase, atau stash. `git status` sesudah fase ini **identik** dengan sebelum fase ini, ditambah laporan ini:

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
?? .cloud-attachments/               <- artefak impor, tidak disentuh
?? PHASE_0A_JEST_DATABASE_ISOLATION_REPORT.md
?? PHASE_0B_PAYMENT_MIGRATION_REPORT.md
?? PROJECT_PRE_FEATURE_AUDIT_REPORT.md
?? __tests__/support/test-database.prisma-guard.test.ts
?? __tests__/support/test-database.safety.test.ts
?? jest.safety.config.js
```

`prisma/` tidak berubah; skrip probe sementara yang dipakai untuk preflight/backup/rehearsal sudah dihapus dari working tree.

---

## 13. Kesimpulan

- Identitas target: **`tinggalklik`** di MariaDB 11.8.8 lokal (loopback) — terkonfirmasi, bukan asumsi.
- Akar masalah terverifikasi: migration `20260929000000_add_payment_active_order_id` **belum pernah diterapkan**; tidak ada history gagal pada migration itu.
- SQL bersifat aditif; 0 baris berpotensi melanggar unique index; 0 orphan.
- Backup dibuat (932.067 byte, SHA-256 tercatat) dan **diverifikasi dengan restore penuh**, lalu migration direhearsal pada salinan tersebut sebelum menyentuh database aplikasi.
- Sinkronisasi dilakukan **satu kali** lewat `prisma migrate deploy` (tanpa force/resolve/push/reset): 31 → **32** migration, 0 pending, 0 rolled back.
- Data terbukti utuh: fingerprint `payment` identik, 15 payment / 20 order tidak berubah, hanya `_prisma_migrations` +1.
- Full regression **159/159 suite, 3.467/3.467 test** lulus dengan isolasi DB test; database aplikasi tidak tersentuh test.
- Sisa risiko terdokumentasi: drift legacy di luar cakupan, dua checksum lama tidak cocok, satu baris migration gagal historis di DB test, backup sementara.

**PHASE 0B: PASS (cakupan payment migration).** Berhenti di sini; tidak memulai Phase 0C, tidak mengimplementasikan fitur, tidak commit/push. Menunggu review dan persetujuan owner.
