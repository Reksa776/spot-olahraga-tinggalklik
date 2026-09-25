# PHASE 40 — CROSS-ROLE WORKFLOW AUDIT — ROOT CAUSE REPORT (PIC REFERRAL)

Project: `~/tinggalklik` · Jenis: **AUDIT ONLY** — tidak ada kode diubah, tidak ada DB direset,
tidak ada migrasi, tidak ada commit, tidak ada push. Membaca (read-only) + bukti runtime.

---

## Ringkasan eksekutif (TL;DR)

PIC memang **tidak mendapatkan referral** — tetapi **BUKAN karena maintenance** dan **BUKAN karena
alur login**.

1. **Maintenance SEKARANG OFF** (`platformsetting.maintenanceMode = 0`), dan bahkan bila ON pun
   alur login/authentikasi **sengaja dikecualikan** (lihat §E.2): kode ini tidak bisa mengembalikan
   503 `MAINTENANCE_MODE` dari `POST /api/auth/…` — baik dari halaman maupun dari API. Log 503
   yang tampak adalah **stale** (dari saat maintenance sempat ON) atau dari build lama; bukan kondisi
   kini.
2. **Akar masalah sebenarnya = env secret `PIC_REFERRAL_SECRET` TIDAK ADA** (verifikasi: `grep -c
   '^PIC_REFERRAL_SECRET=' .env` → `0`). Token referral di-mint dengan desain **fail-closed**
   (`mintPicReferralToken` mengembalikan `null` saat secret tak tersedia) sehingga **tidak ada satu
   pun link referral yang pernah dibuat** → attributable rows = 0 dan PIC fee ledger = 0.

Bukti paling tajam: DB punya **2 assignment ACTIVE yang valid** (ke event nyata) dan 3 PICProfile
ACTIVE, tetapi **0 `PicAttribution` dan 0 `PicFeeLedger`** — tidak ada uang yang pernah
mengalir lewat rantai referral, dan tidak ada token yang pernah resolve. Ini persis bentuk
"referral kosong" yang dilaporkan.

---

## A. Current Blocker

| # | Item | Nilai terukur (read-only) |
|---|---|---|
| A1 | `platformsetting.maintenanceMode` | **`0` (OFF)** |
| A2 | `PIC_REFERRAL_SECRET` di `.env`/`.env.local` | **MISSING** (`grep -c` → `0`) |
| A3 | Dangling-ish: PICProfile | 3 ACTIVE (2 yang dipakai smoke-PIC = 1 non-active), 0 revoked |
| A4 | PIC event assignment | **2 ACTIVE** di event nyata (`badminton-star-cirebon` PUBLISHED + 1) |
| A5 | Attributions | **0** |
| A6 | PIC fee ledger (EARNED) | **0** |
| A7 | PIC referral link UI | kosong — empty-state "Belum ada tautan referral aktif." |

**Kesimpulan:** blocker aktif adalah **A2 (secret env tidak diset)**, bukan A1. Maintenance sudah
mati dan tak akan pernah memblokir login (fail-closed hanya diterapkan ke jalur pembelian/toket,
bukan auth — §E.2).

---

## B. Referral Root Cause

### B.1 Mekanisme (dari kode)
`mintPicReferralToken` (`lib/pic/referral.ts:92-107`):

```
const key = secret();            // baca process.env[PIC_REFERRAL_SECRET]
if (!key) { return null; }       // ← FAIL-CLOSED: tanpa secret tidak pernah mint
```

`secret()` (referral.ts:71-74) mengembalikan nilai env hanya bila ada string tak-kosong, selain itu
`null`. Karena `.env` kosong, **setiap mint → `null`**. Konsekuensinya di seluruh pemanggil:

- `listMyReferralLinks` (`lib/pic/self-service.ts:457-487`) → `mintPicReferralToken` → `null` →
  `sharePath: null` → halaman PIC dashboard menampilkan empty-state "Belum ada tautan referral
  aktif." (§F).
- `GET /api/events/[slug]/share` (`app/api/events/[slug]/share/route.ts:91`) →
  `mintPicReferralToken` → null → `trackingToken: null` → `shareUrl = canonicalUrl` (tanpa `?pic=`)
  → bahkan link "berbagi" pun jatuh ke bentuk non-tracked. → tidak ada attribution.
- Checkout resolver (`lib/ticketing/checkout.ts:490`) menerima `shareToken: null` → tidak ada
  resolusi referral (`resolveReferralAtCheckout` fail-closed → `referral = null`) → transaksi normal
  tanpa PIC → **tanpa snapshot fee, tanpa PICFeeLedger**.

### B.2 Urutan kausal (chain)
```
PIC_REFERRAL_SECRET missing
   → mintPicReferralToken() = null
      → tidak ada token pada /share (trackingToken null) DAN listMyReferralLinks sharePath null
         → PIC tak punya link untuk disebar
            → attributions = 0
               → fee snapshot / PicFeeLedger = 0
                  → "PIC tidak mendapatkan (fee dari) referral"
```

### B.3 Jawaban langsung pertanyaan audit soal perilaku
- **A. Otomatis saat PIC login?** Tidak ada mint saat login. Login/authentikasi tidak menyentuh
  referral sama sekali (authorize hanya verifikasi kredensial, `auth.ts:107-256`).
- **B. Saat PIC membuka halaman Referral UI?** Ya — `listMyReferralLinks` dijalankan setiap
  dashboard PIC di-render (`app/dashboard/pic/page.tsx`), dan di situlah mint terjadi. Bila secret
  diset, link muncul di sini. (Sekarang null karena secret kosong.)
- **C. Setelah event di-assign?** Ya, mint juga bisa dari `requireMyPic` + assignment aktif
  (`getMyReferralLink`, self-service.ts:497 dst). Jadi "harus ADANYA assignment" TIDAK jadi
  penghalang: 2 assignment ACTIVE sudah ada.
- ✓ Kesepakatan: referral di-mint **fail-closed dan lazily** (saat UI/API diminta), mensyaratkan
  kombinasi **PICProfile ACTIVE + assignment ACTIVE + secret env**. Semua syarat terpenuhi KECUALI
  secret env.

---

## C. Evidence

### C.1 Database (read-only, `tinggalklik`)
```
SELECT maintenanceMode FROM platformsetting;                 → 0
SELECT COUNT(*) FROM piceventassignment WHERE isActive=1;    → 2   (aktif, valid)
SELECT COUNT(*) FROM picattribution;                         → 0   (tidak pernah ada atribusi)
SELECT COUNT(*) FROM picfeeledger;                           → 0   (tidak pernah ada fee)
SELECT id,status,defaultFeeRateBp FROM picprofile;           → 3 ACTIVE (1 revoked/never)
```

### C.2 Environment
```
grep -c '^PIC_REFERRAL_SECRET=' .env        → 0   (MISSING)
grep -c '^PIC_REFERRAL_SECRET=' .env.local  → 0   (MISSING)
```
Nilai tidak pernah ditampilkan (audit tidak membocorkan secret).

### C.3 Runtime (verifikasi fase 40)
- `npx jest __tests__/auth-flow/phase40-cross-role-workflow.integration.test.ts` → **22 passed/22**
  (suite rantai lintas-role: event→order→pay→ticket→attribution→fee→refund→settlement). Rantai
  **berfungsi penuh ketika secret tersedia** (test memakai secret test sendiri; nyata)
- Full suite: **2306 passed / 2306** (119 suites)
- `npx tsc --noEmit` → exit 0 · `npm run lint` → 0 errors · `npm run build` → exit 0
- `git diff --check` pada file fase-40 → bersih (error whitespace hanya `auth.ts` fase-33 yang
  belum di-commit, bukan bagian audit ini)

---

## D. Exact Files / Functions Involved

| File | Fungsi | Peran |
|---|---|---|
| `lib/pic/referral.ts` | `secret()` :71, `mintPicReferralToken` :92, `verifyPicReferralToken` :115 | Mint MAC-token; **fail-closed tanpa secret** |
| `lib/pic/self-service.ts` | `listMyReferralLinks` :457, `getMyReferralLink` :497 | Membangun link per assignment aktif; null saat secret kosong |
| `app/api/events/[slug]/share/route.ts` | `GET` :94, `resolveTrackedShareToken` :65, mint :91 | Sisi publik yang mengekspos tracking token |
| `lib/ticketing/checkout.ts` | `resolveReferralAtCheckout` :490 | Resolve token → attribution + fee snapshot (dalam txn) |
| `lib/pic/attribution.ts` | `resolveReferralAtCheckout` :86 | Verifikasi ulang ACTIVE PIC (status-char) |
| `lib/pic/fee.ts` | `computeLinePicFee`, `resolvePicFeeConfig` | Murni; fee = rate-only V1 |
| `lib/pic/ledger.ts` | `getPicLedgerBalance` | ΣCREDIT − ΣDEBIT |
| `lib/admin/users.ts` | `createManagedUser` dst | Hanya MANAGER/PIC; tak pernah ADMIN |
| `lib/maintenance.ts` | `maintenanceBlocksPage` :128, `assertNotInMaintenance` :172 | Gagal tertutup; **auth/login exempt** |
| `auth.ts` | `authorize` :107 | Tidak pernah menyentuh maintenance/referral |

---

## E. Ya/Tidak: Apakah maintenance memblokir login?

### E.1 Status saat ini: TIDAK
- DB: `maintenanceMode = 0`.
- Bahkan di DB test pun OFF.

### E.2 Secara desain: TIDAK (login selalu exempt)
`lib/maintenance.ts`:
- `MAINTENANCE_EXEMPT_PAGE_PREFIXES` (baris 65-68) memuat `MAINTENANCE_PATH` dan `LOGIN_PATH` —
  halaman `/login` tidak pernah diblokir.
- `MAINTENANCE_EXEMPT_API_PREFIXES` (baris 76-81) memuat `/api/auth/` (login credentials) dan
  `/api/internal/` + `/api/health` — permintaan ke NextAuth (path `/api/auth/*`) selalu lolos.
- `assertNotInMaintenance` (172) hanya dipanggil dari jalur **pembelian/toket**: events, sports,
  share, checkout, pay (lihat `grep assertNotInMaintenance` → hanya `lib/maintenance.ts` +
  route events/sports/checkout/pay). **Tidak pernah dari authorize login.**

Karena itu kode ini **tidak mungkin** menghasilkan log `POST … maintenanceMode → SERVICE_UNAVAILABLE
MAINTENANCE_MODE` pada alur login saat kondisi DB sekarang. Log tersebut berasal dari saat
maintenance sempat ON (riwayat fase sebelumnya) atau build/DB yang lebih lama — **stale evidence**,
bukan penyebab referral kosong saat ini.

### E.3 Jadi apa penyebab log itu?
Bila operator melihat 503 `MAINTENANCE_MODE` pada POST login, ia melihat artefak lama/state
maintenance yang sudah dimatikan. Untuk menghilangkan kebingungan: pastikan `maintenanceMode=0`
persisten (sudah terverifikasi) dan sekaligus set `PIC_REFERRAL_SECRET` (penyebab asli).

---

## F. UI / Referral (verifikasi permukaan)

- Halaman: `app/dashboard/pic/page.tsx` — seksi "Tautan Referral" (id `referrals`, baris ~474).
- Impor & pemanggil: `listMyReferralLinks` dari `lib/pic/self-service.ts` (dikonfirmasi).
- Kosong → empty-state **"Belum ada tautan referral aktif."** (bukan error, bukan 503).
- PIC tanpa link melihat eksplisit: segmen referral benar-benar tidak ada link disebar.

Jadi "referral kosong" adalah **hasil fail-closed yang benar** — bukan bug tampilan, bukan
maintenance. Ini konsekuensi dari secret env yang tidak diset → **konfigurasi**, bukan kode.

---

## G. Minimal Safe Fix Plan (TIDAK dieksekusi — hanya rekomendasi)

> Baris ini adalah rencana. Audit ini TIDAK mengubah apa pun (lihat persyaratan). Eksekusi hanya
> setelah approval.

1. **Set env secret (PRIMARY)**
   - Generate nilai acak: `openssl rand -base64 32` (setidaknya 32 byte, >16 byte kebutuhan MAC).
   - Tambahkan ke **semua** env prod yang dipakai VPS + `.env` dev testimonial:
     `PIC_REFERRAL_SECRET=<random>`.
   - Tanpa ini, tidak ada perubahan kode lain yang akan menghasilkan referral — mint tetap null.
2. **Restart runtime** (VPS: `pm2 restart all` / unit service) agar `process.env` baru terbaca.
3. **Verifikasi** (read-only, cepat):
   - Buka dashboard PIC → seksi "Tautan Referral" kini menampilkan link `?pic=<token>` per
     assignment aktif.
   - Tambahkan check-test: mint linkage `listMyReferralLinks` → `sharePath` non-null.
   - Buat satu order via link tersebut → atribusi `PicAttribution` + `PicFeeLedger` bertambah 1
     (D-P17: snapshot di txn checkout, fee EARNED saat SETTLED).
4. **Fixture/tidak merusak:** tidak ada query DROP/TRUNCATE; tidak ada migrasi; reset TEST DB saja
   bila diperlukan (bukan DB prod).
5. Tidak ada perubahan schema. Tidak ada commit/push tanpa persetujuan.

---

## Persiapan untuk Verifikasi Akhir (sudah dijalankan, selesai)
- [x] `npx jest` → **2306 passed / 2306** (119 suites)
- [x] `npx jest __tests__/auth-flow/phase40-cross-role-workflow.integration.test.ts` → **22 passed**
- [x] `npx tsc --noEmit` → exit 0 (bersih)
- [x] `npm run lint` → 0 errors (hanya warning img/cosmetik pre-existing)
- [x] `npm run build` → exit 0
- [x] `git diff --check` → bersih untuk file audit (hanya auth.ts fase-33 yang belum di-commit)
- [x] `git status --short` → tidak ada komit/push selama audit
