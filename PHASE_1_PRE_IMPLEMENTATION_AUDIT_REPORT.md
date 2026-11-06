# PHASE 1 — EMAIL/WHATSAPP FOUNDATION + DELIVERY QUEUE
## PRE-IMPLEMENTATION AUDIT

**Project:** TinggalKlik.Co
**Date:** 2026-10-31 (WIB)
**Repository:** `/home/reksa/tinggalklik`, branch `main`, HEAD `25cbf0c`
**Mode:** **AUDIT ONLY** — tidak ada implementasi, migration, perubahan schema, database, business logic, atau dependency pada fase ini.
**Scope:** kesiapan implementasi Phase 1 (fondasi Email/WhatsApp + delivery queue). Phase 2/4/5 tidak diimplementasikan dan tidak dirancang sebagai pekerjaan, hanya sebagai batas.

## Rekomendasi akhir

# CONDITIONAL GO

Fondasi yang dibutuhkan Phase 1 **sebagian besar sudah ada di repository** (tabel `notification` + `notificationdelivery`, pola lease `joblock`, endpoint tick yang terautentikasi mesin). Yang belum ada adalah **worker, adapter provider, dan aktivasi pengiriman** — dan tepat di situ terdapat empat blocker yang harus diputuskan owner sebelum implementasi, bukan sesudahnya (§3, §12).

Kondisi GO (semua wajib):

| # | Kondisi | Alasan (bukti di §) |
|---|---|---|
| **C1** | Outbound email **tetap OFF** sampai owner memilih salah satu jalur §2.4, karena 4 High auth/nodemailer **tidak dapat dihapus** dengan upgrade versi saja | §2.2, §2.3 |
| **C2** | **Auth.js Email provider tidak boleh diaktifkan** pada Phase 1 (magic link/verification email) | §2.2, §10 |
| **C3** | Worker berjalan sebagai **proses terpisah yang disupervisi**, bukan bergantung pada cron — cron belum pernah terpasang di environment ini | §1.5, §6 |
| **C4** | WhatsApp (Baileys) berjalan di **belakang flag OFF** dengan keputusan owner atas risiko unofficial API, pairing manual, dan session persistence | §8, §10 |
| **C5** | Phase 1 mengirim **hanya pesan sintetis/dry-run** (`NOTIFICATIONS_ENABLED=false` default); purchase proof tetap milik Phase 2 | §11 |

Yang akan membalik rekomendasi menjadi **NO-GO**: permintaan mengaktifkan email produksi pada Phase 1 sebelum C1 diputuskan, atau menjalankan migration tanpa persetujuan owner (§9).

---

## Metode dan bukti

Audit ini dijalankan read-only. Yang **diukur langsung** pada sesi ini:

| Pemeriksaan | Hasil |
|---|---|
| `npx prisma migrate status` | **Database schema is up to date!** — 32 migration, exit 0 |
| Engine database (`SELECT VERSION()`) | **11.8.8-MariaDB** |
| Baris `notification` / `notificationdelivery` / `joblock` | **44 / 0 / 0** |
| `npm audit --json` (Phase 0C) | 43 = 0 Critical / 7 High / 33 Moderate / 3 Low |
| `npm view nodemailer` | latest **10.3.1**; rentang rentan yang dilaporkan **≤10.1.3** |
| `npm view @auth/core` | 0.41.3, peer `nodemailer: "^7.0.7 \|\| ^8.0.5"` |
| Uji peer (scratch dir, `npm install --package-lock-only`) | `npm warn ERESOLVE overriding peer dependency`; lock memuat **dua** nodemailer (root 10.3.1 + nested 8.0.11) |
| Audit pada pohon percobaan itu | tetap **43**, nodemailer high tetap ada di node nested |
| Node runtime | **24.21.0**; `.nvmrc` = 24; `engines` = `>=20.9.0 <25` |

Yang **tidak** dapat diverifikasi dan tidak diklaim: perilaku provider sungguhan (tidak ada kredensial pada sesi ini), kestabilan Baileys terhadap WhatsApp (tidak ada pairing), dan apakah cron terpasang di VPS produksi (yang dapat dibuktikan hanya: `joblock` kosong di database aplikasi lokal ini, sehingga tick belum pernah berjalan di sini).

---

## 1. Existing architecture

### 1.1 Runtime dan deployment

| Aspek | Kenyataan |
|---|---|
| Framework | Next.js **16.4.3** (Turbopack build), React 19, TypeScript |
| Proses aplikasi | `next start -H 127.0.0.1 -p 3003` via **PM2 fork, `instances: 1`** (`ecosystem.config.cjs`). Cluster **dilarang** oleh komentar dan oleh `__tests__/realtime/emit-points.test.ts` |
| Ingress | nginx → loopback:3003 (`HOSTNAME`/`PORT` bukan sumber kebenaran; CLI flag yang menentukan) |
| Database | MySQL/MariaDB 11.8.8, Prisma 6.19.3, 32 migration, schema up to date |
| Cache/broker | **Tidak ada.** `REDIS_URL` dideklarasikan tetapi tidak dipakai |
| Rate limiter | `lib/rate-limit.ts` **in-memory per proses** — alasan `instances: 1` bersifat *load-bearing* |
| Realtime | SSE dengan **bus in-process** (`lib/realtime/bus.ts`); komentar eksplisit: satu instance = satu transport |
| Storage | `UPLOAD_DIR` (default `./storage/uploads`), harus persisten + di-backup (runbook §6) |
| Auth | NextAuth v5 beta.32, `PrismaAdapter`, JWT session, provider **Google + Credentials** — **tidak ada** Email provider |

### 1.2 Scheduler yang sudah ada (dan statusnya)

`POST /api/internal/jobs/tick` (`app/api/internal/jobs/tick/route.ts`):

- Autentikasi **mesin**, `Authorization: Bearer $JOBS_TICK_SECRET`, perbandingan constant-time, **fail-closed 401** bila secret kosong.
- Menjalankan `runJobsTick()` (`lib/jobs/tick.ts`) → dua job: `event-lifecycle` dan `reservation-reaper`.
- Serialisasi lewat **lease baris database** (`lib/jobs/lock.ts`, tabel `joblock`): `upsert` kosong + `updateMany` kondisional `lockedUntil IS NULL OR lockedUntil < now`.
- Komentar desain eksplisit: **bukan** `setInterval`, **bukan** mutex proses, **bukan** BullMQ/Redis, **bukan** `GET_LOCK` MySQL.
- Komentar desain juga eksplisit: *"TWO jobs, no more (P14-D10). Notification dispatch … are other phases' concerns"* — jadi Phase 1 **memang** fase yang menambahkan dispatch, dan itu konsisten dengan roadmap.

**Temuan penting:** `joblock` berisi **0 baris** dan runbook §10 menyatakan scheduler **belum dipasang**. Artinya di environment ini belum ada tick yang pernah sukses. Fase apa pun yang "mengandalkan cron" akan diam-diam tidak berjalan.

### 1.3 Fondasi notifikasi yang sudah ada tetapi dorman

Schema sudah memiliki (dari migration `20260916000000_ticketing_phase2_foundation`):

- **`notification`** — intent pesan: `channel String`, `recipient`, `idempotencyKey @unique`, `providerMessageId`, `payload`, `errorCode/Message`, `retryCount`, `maxRetries`, `priority`, `templateKey`, plus relasi subjek (`eventOrderId`, `ticketId`, `eventId`, `organizerId`, `picProfileId`) dan enum subjek (`recipientType`, `category`).
- **`notificationdelivery`** — state per kanal: enum `channel(WHATSAPP, EMAIL, IN_APP)`, enum `status(QUEUED, SENDING, SENT, FAILED, SKIPPED)`, `attemptCount`, `maxAttempts`, `providerMessageId`, `queuedAt/sentAt/failedAt`, **`nextRetryAt`**, dan **`UNIQUE (notificationId, channel)`** + **`INDEX (status, nextRetryAt)`**.

Tidak ada satu baris kode pun yang menulis tabel ini (`grep prisma.notification` → nol hasil di `lib/`, `app/`, `scripts/`).

**Isi tabel saat ini:**

| Tabel | Baris | Isi |
|---|---|---|
| `notification` | **44** | Semuanya `channel="whatsapp"` (string lowercase, era retail), `category NULL`, `recipientType NULL`, `templateKey NULL`, dibuat 2026-08-20 |
| `notificationdelivery` | **0** | kosong |
| `joblock` | **0** | tick belum pernah jalan |

Konsekuensi desain: baris legacy itu **tidak boleh** ikut terkirim. Filter yang benar adalah `category IS NOT NULL` (atau `templateKey IS NOT NULL`), bukan "semua baris notification".

### 1.4 Batas transaksi yang sudah disepakati

- Webhook pembayaran adalah **satu-satunya** pemicu settlement + issuance (`lib/ticketing/payment/webhook.ts`), dengan urutan: verifikasi signature → verifikasi amount → INSERT `WebhookEvent` (unique `providerEventId` = replay guard) → settle → mark.
- Issuance berjalan **di dalam** `prisma.$transaction` (`lib/ticketing/tickets/issuance.ts:516`).
- Realtime **dipublikasikan setelah commit**, tidak pernah di dalam transaksi (`lib/realtime/bus.ts:33`, `lib/events/service.ts:1414`).

Ini menetapkan aturan untuk Phase 1: **enqueue tidak boleh berada di dalam transaksi pembayaran/issuance** dan **tidak boleh membuat webhook gagal**.

### 1.5 Inventaris dependency yang relevan

| Paket | Versi terpasang | Dipakai kode? |
|---|---|---|
| `nodemailer` | **8.0.11** (pin eksak) | **Tidak** — tidak ada import di `lib/`/`app/`; hanya muncul di 3 wiring test sebagai *larangan* |
| `@types/nodemailer` | 8.0.2 | dev |
| `@whiskeysockets/baileys` | **6.7.24** | **Tidak** — nol import |
| `next-auth` / `@auth/core` / `@auth/prisma-adapter` | beta.32 / 0.41.3 / 2.11.3 | Ya (auth) |
| `axios` | 1.21.0 | Ya (payment gateway) |
| `qrcode`, `jsqr` | 1.5.4 / 1.4.0 | Ya (QR tiket/check-in) |

**Tidak ada** variabel environment SMTP/WhatsApp di `.env.example`. Tidak ada direktori `data/whatsapp-auth/` (hanya baris `.gitignore` yang dikomentari sebagai "legacy").

---

## 2. Dependency compatibility findings

### 2.1 Matriks kompatibilitas

| Fakta | Nilai | Sumber |
|---|---|---|
| `nodemailer` terpasang | 8.0.11 (pin eksak `"8.0.11"`) | `package.json` |
| `nodemailer` latest | **10.3.1** | `npm view` |
| Lini versi yang ada | 8.x (…8.0.11), 9.x (…9.1.1), 10.x (10.1.7 … 10.3.1) | `npm view versions` |
| Rentang rentan yang dilaporkan audit | **`<=10.1.3`** | `npm audit` |
| Peer `@auth/core@0.41.3` | `nodemailer: "^7.0.7 \|\| ^8.0.5"` (optional) | `node_modules/@auth/core/package.json` |
| `next-auth@5.0.0-beta.32` | beta terbaru; mewarisi `@auth/core@0.41.3` | `npm view next-auth` |
| `@auth/core` latest | **0.41.3** (tidak ada versi lebih baru yang menerima ^10) | `npm view @auth/core` |
| `@auth/prisma-adapter@2.11.3` | peer Prisma `>=2.26 \|\| >=3 … >=6` — kompatibel dengan Prisma 6 | terpasang |
| `@whiskeysockets/baileys` | 6.7.24 terpasang; latest **7.0.0-rc14**; tidak ada advisory di audit | `npm view`, audit |
| Node | project `>=20.9 <25`, runtime 24.21.0; Baileys `engines: >=20.0.0` | `.nvmrc`, `package.json` |
| Prisma | 6.19.3; rantai `@prisma/config`/`deepmerge-ts` High (Phase 0C, dev-only) | Phase 0C |

### 2.2 Temuan kunci: 4 High tidak dapat dihapus dengan bump versi

Diuji pada salinan `package.json` + `package-lock.json` di direktori scratch (`/tmp`), **bukan** pada repository:

1. `nodemailer` diubah ke `10.3.1` → `npm install --package-lock-only` **berhasil (exit 0)** tetapi mencetak `npm warn ERESOLVE overriding peer dependency` (peer `^7.0.7 || ^8.0.5` dari `next-auth`/`@auth/core` tidak terpenuhi).
2. Lockfile hasilnya memuat **dua** instance: `node_modules/nodemailer@10.3.1` dan **`node_modules/@auth/prisma-adapter/node_modules/nodemailer@8.0.11`** (peer copy yang dibuat npm untuk `@auth/core`).
3. `npm audit --package-lock-only` pada pohon itu **tetap 43**, dengan `nodemailer` High mengarah ke node nested 8.0.11.

Kesimpulan yang dapat dipertanggungjawabkan:

- Satu-satunya versi yang **bebas advisory** adalah **≥10.1.4**, dan **tidak ada** rilis `@auth/core`/`next-auth` hari ini yang menerima `^10`.
- Karena itu, **4 High Auth/Nodemailer** (yaitu `nodemailer` + `@auth/core` + `next-auth` + `@auth/prisma-adapter`) hanya bisa hilang dengan salah satu: (a) Auth.js merilis dukungan nodemailer ≥10, (b) `overrides`/`--legacy-peer-deps` (dilarang: incompatible override), atau (c) **nodemailer dikeluarkan dari jalur kirim** (§2.4 opsi B).
- Menaikkan `nodemailer` ke 10.x **tidak** menurunkan hitungan audit dan **tidak** "menyelesaikan" 4 High — ia hanya memindahkan pemakaian kita ke kode yang patched sambil menyisakan salinan rentan yang tidak kita pakai.

### 2.3 Apakah 4 High itu reachable hari ini?

**Tidak.** `auth.ts` hanya memasang provider **Google** dan **Credentials**. Tidak ada `Nodemailer`/Email provider, tidak ada magic link, tidak ada `sendVerificationRequest`. Tidak ada import `nodemailer` di `lib/` atau `app/`. Jadi saat ini nodemailer adalah dependency **terpasang tetapi tidak terpanggil**.

Risiko berubah menjadi nyata tepat pada dua peristiwa, dan keduanya harus dijaga:
1. kita menambahkan **Auth.js Email provider** (akan memanggil `@auth/core` → nodemailer 8.0.11 rentan), atau
2. worker kita memanggil **nodemailer 8.0.11** dengan masukan yang tidak sepenuhnya dikendalikan server.

### 2.4 Tiga jalur email (keputusan owner)

| | A. Tetap `nodemailer@8.0.11` + kontrol ketat | B. `nodemailer@10.3.1` untuk jalur kirim kita | C. HTTPS API provider (tanpa nodemailer) |
|---|---|---|---|
| Peer Auth.js | **Bersih** (`^8.0.5`) | **Warning** ERESOLVE (tetap terpasang) + salinan nested 8.0.11 | Bersih untuk kode kita; nodemailer tetap ada sebagai peer Auth.js yang tidak dipakai |
| Hitungan audit | 43 (tidak berubah) | **43** (terukur) | 43, tetapi nodemailer **tidak ada di jalur eksekusi** |
| Perbaikan nyata | Tidak ada — hanya pembatasan pemakaian | Ya, untuk kode kita | Ya, dan menghapus seluruh kelas advisory parser/SMTP |
| Kontrol wajib | Tanpa `raw`, tanpa alamat dari user, `disableFileAccess`/`disableUrlAccess`, timeout, TLS verify, template server-side | Sama, tetapi pada kode patched | API key server-side, retry via queue, tidak ada SMTP egress |
| Biaya operasional | SMTP relay sendiri (SPF/DKIM/reputasi jadi tanggung jawab kita) | sama | Vendor + kuota/pricing; katalog Gravity Index pada sesi ini **tidak** memuat provider email transaksional, jadi pemilihan vendor butuh keputusan terpisah |
| Rekomendasi audit | **Boleh sebagai default Phase 1** selama C1/C5 dipatuhi | Boleh **hanya** bila owner menerima peer warning + salinan nested | Paling aman jangka panjang; butuh keputusan vendor |

**Rekomendasi:** Phase 1 mengimplementasikan **abstraksi transport** (`EMAIL_TRANSPORT=disabled|log|smtp|http`) sehingga pilihan A/B/C tidak mengubah queue, worker, atau kontrak. Default Phase 1: **`disabled`**. Aktivasi produksi adalah gerbang owner, bukan keputusan implementasi.

---

## 3. Security blockers

| ID | Blocker | Bukti | Dampak bila diabaikan | Status |
|---|---|---|---|---|
| **B1** | 4 High pada `nodemailer`/`@auth/core`/`next-auth`/`@auth/prisma-adapter` tidak punya fix yang kompatibel | §2.2 (terukur) | Advisory meliputi arbitrary file read + SSRF lewat `raw`/`resolveContent`, IDN allow-list bypass, dan beberapa DoS parser/SMTP | **Blocker aktivasi** — mitigasi §2.4 |
| **B2** | Auth.js Email provider akan memanggil nodemailer rentan | `@auth/core/providers/nodemailer.js` meng-import `nodemailer` | Jalur auth baru yang tidak ada hari ini menjadi vektor | **Larangan** (C2) |
| **B3** | Cron/scheduler belum pernah berjalan; `joblock` kosong | §1.2, pengukuran DB | Queue "aman" yang tidak pernah diproses = tiket tidak terkirim tanpa alarm | **Blocker arsitektur** — worker mandiri (C3) |
| **B4** | Baileys = klien WhatsApp **tidak resmi**; pairing = kontrol penuh atas akun | `@whiskeysockets/baileys` 6.7.24 terpasang, 0 pemakaian | Ban nomor, pelanggaran ToS, kehilangan sesi, pesan bisnis tanpa template resmi | **Blocker keputusan owner** (C4) |
| **B5** | Tidak ada mekanisme propagasi status lintas proses | bus realtime in-process (§1.1) | Status "SENT" tidak muncul di dashboard sampai polling; jika dipaksa, muncul gap arsitektur | **Batasan desain** — polling/out-of-scope |
| **B6** | `.env.example` belum punya kontrak kredensial email/WA | file | Kredensial berpotensi masuk repo atau ke proses yang salah | **Wajib Phase 1** (§8) |

Tambahan yang bersifat kebijakan: CSP aplikasi saat ini `connect-src 'self'` (`next.config.ts`). Desain Phase 1 **tidak boleh** menambah panggilan provider dari browser; semua pengiriman server-side. Ini sejalan, bukan konflik.

---

## 4. Proposed Email/WhatsApp provider architecture

### 4.1 Batas tiga pihak

```
┌──────────────────────────┐        ┌──────────────────────────────┐
│ Web app (Next.js, PM2)   │        │ Worker (PM2, proses terpisah)│
│                          │        │                              │
│ • enqueue() setelah      │  DB    │ • claim delivery (CAS/lease) │
│   commit (transaction    │───────▶│ • render template server-side│
│   terpisah, bukan di     │        │ • panggil adapter provider   │
│   dalam tx payment)      │◀───────│ • tulis status + backoff     │
│ • TIDAK memanggil        │        └───────────┬──────────────────┘
│   provider                │                    │
└──────────────────────────┘                    │
        ▲                                       ├── SMTP/HTTPS (email)
        │ baca status (poll / server component)  └── socket (WhatsApp)
        │
┌───────┴──────────────────┐
│ Dashboard / order page   │   (tidak pernah memegang kredensial)
└──────────────────────────┘
```

Aturan yang mengikat:

1. **Hanya worker** yang boleh menyentuh kredensial dan jaringan provider.
2. **Hanya `enqueue()`** yang boleh menulis `notification`/`notificationdelivery`; tidak ada penulisan langsung dari route atau service lain.
3. Enqueue **setelah** commit, tidak pernah di dalam `$transaction` payment/issuance (pola yang sudah dipakai realtime).
4. Route API tidak pernah mengembalikan `payload`, `errorMessage` mentah, recipient lengkap, atau kredensial.

### 4.2 Adapter email

```
interface EmailTransport {
  readonly name: string;                 // "smtp" | "log" | "http"
  send(msg: RenderedEmail): Promise<{ providerMessageId?: string }>;
}
```

- `disabled` — worker menolak claim; tidak ada pengiriman.
- `log` — menulis status `SENT` dengan `provider="log"` (dry-run; dipakai Phase 1 dan test).
- `smtp` — `nodemailer` dengan `disableFileAccess: true`, `disableUrlAccess: true`, tanpa `raw`, `tls.rejectUnauthorized: true`, `connectionTimeout`/`socketTimeout` eksplisit, `from` dari env (bukan dari request).
- `http` — untuk opsi C, cukup satu file tambahan; kontrak queue tidak berubah.

### 4.3 Adapter WhatsApp

- `disabled` (default Phase 1) — tidak ada socket.
- `log` — dry-run.
- `baileys` — satu socket proses, satu sesi, adapter di worker saja.

**Alternatif resmi:** WhatsApp Business **Cloud API** (Meta) — jalur yang patuh kebijakan, tidak butuh QR, tetapi: butuh akun bisnis terverifikasi, pesan bisnis-inisiatif (Phase 4 reminder H-36) **wajib template yang disetujui**, dan ada biaya per percakapan. Katalog Gravity Index pada sesi ini tidak memuat provider WhatsApp, jadi integrasi konkretnya memerlukan keputusan vendor + dokumentasi resmi di fase implementasi — audit ini tidak mengarang langkah instalasi.

---

## 5. Proposed delivery queue schema

### 5.1 Keputusan: **memakai ulang** tabel yang ada, bukan tabel baru

Tabel `notification` + `notificationdelivery` sudah memiliki properti yang justru sulit dibuat ulang dengan benar:

| Properti | Sudah ada |
|---|---|
| Idempotensi enqueue | `notification.idempotencyKey @unique` |
| Idempotensi fan-out per kanal | `UNIQUE (notificationId, channel)` |
| State machine | `QUEUED → SENDING → SENT/FAILED/SKIPPED` |
| Retry | `attemptCount`, `maxAttempts`, `nextRetryAt` |
| Jejak provider | `provider`, `providerMessageId`, `errorCode`, `errorMessage` |
| Subjek/tenant | `eventOrderId`, `ticketId`, `eventId`, `organizerId`, `picProfileId` |
| Antrean | `INDEX (status, nextRetryAt)` |

Membuat tabel baru akan menduplikasi seluruh invariants di atas dan menciptakan dua sumber kebenaran. **Tidak direkomendasikan.**

### 5.2 Tambahan minimal (additive) yang dibutuhkan worker

Yang belum ada dan **wajib** untuk worker yang aman:

| Tabel | Kolom baru | Alasan |
|---|---|---|
| `notificationdelivery` | `lockedUntil DateTime?` | lease per baris; membedakan "sedang dikirim" dari "macet" |
| `notificationdelivery` | `lockedBy String? @db.VarChar(64)` | observability: siapa pemegang klaim |
| `notificationdelivery` | `lastAttemptAt DateTime?` | membedakan retry dari first attempt; metrik |
| `notificationdelivery` | `INDEX (status, lockedUntil)` | reclaim lease kedaluwarsa tanpa full scan |

Tanpa `lockedUntil`, baris `SENDING` yang prosesnya mati akan **macet permanen** — `status=SENDING` bukan kondisi yang bisa dibedakan dari "sedang berjalan". Ini gap nyata pada schema saat ini, bukan preferensi.

**Sengaja TIDAK ditambahkan pada Phase 1:**

- `scheduledFor` untuk reminder H-36 → milik **Phase 4** (additive, tidak menimbulkan rework).
- Nilai enum baru (`REMINDER`, `EVENT_DOCUMENT`) → milik Phase 4/5.
- Tabel dead-letter terpisah → `status=FAILED` + `errorCode` sudah cukup; tabel kedua hanya menambah state yang harus disinkronkan.
- Tabel outbox baru → tidak perlu; `notification` **adalah** outbox-nya.

### 5.3 Bentuk data yang diusulkan

```
notification (intent)
  idempotencyKey = "order:EVT-2026-000123:proof:email:v1"     ← exactly-once enqueue
  category       = ORDER | PAYMENT | TICKET | ...             ← menyaring baris legacy
  templateKey    = "purchase-proof.v1"                        ← versi template eksplisit
  recipientType  = CUSTOMER | PIC | ADMIN | ...
  payload        = JSON ter-render (disimpan untuk audit, TIDAK dikirim mentah ke provider)

notificationdelivery (state per kanal)
  (notificationId, channel) unik                              ← fan-out idempoten
  status/attemptCount/nextRetryAt/lockedUntil/lockedBy
  provider + providerMessageId + errorCode
```

`payload` **bukan** template: template hidup di kode (`lib/notifications/templates/`), sehingga perubahan isi pesan tidak membutuhkan baris database baru dan tidak bisa disuntik dari request.

---

## 6. Worker execution strategy

### 6.1 Perbandingan opsi

| Opsi | Latensi | Keamanan | Baileys | Realtime status | Penilaian |
|---|---|---|---|---|---|
| A. `setInterval` di proses Next | rendah | **dilarang** desain (tanpa lifecycle, mati bersama proses, multi-instance tidak aman) | tidak | ya | **Tolak** |
| B. Menambah job ke `runJobsTick` (cron 1 menit) | ≤60 s | baik (pola lease sudah ada) | tidak mungkin (butuh socket persisten) | ya (satu proses) | **Tidak cukup** untuk Phase 1 |
| C. **Worker PM2 terpisah** (poll DB) | 5 s | baik (lease + CAS) | **ya** | tidak (bus in-process) | **Direkomendasikan** |
| D. BullMQ + Redis | rendah | baik | ya | tidak | **Tolak** — dependency stateful baru; desain Phase 14 sudah menolaknya |

### 6.2 Rekomendasi: worker terpisah + tick tetap sebagai jaring pengaman

```
pm2 app 1: tinggalklik        (Next.js, :3003, instances 1, fork)   ← tidak berubah
pm2 app 2: tinggalklik-worker (Node, tanpa port)                    ← baru, instances 1, fork
cron (bila/ketika dipasang): POST /api/internal/jobs/tick           ← tetap untuk lifecycle+reaper
```

- Worker **tidak** menggantikan tick; `event-lifecycle` dan `reservation-reaper` tetap milik tick.
- Worker **tidak** boleh mengandalkan cron (C3): ia poll sendiri, dan bila cron juga memanggil endpoint dispatch, keduanya serial oleh lease yang sama.
- Worker memakai **lease yang sama** (`joblock` baris `notification-dispatch`) → `instances: 1` ditegakkan oleh database, bukan oleh disiplin operator. Baris `joblock` juga menjadi **heartbeat** (`lastRunAt`, `lastStatus`) untuk health check.
- Concurrency internal: email 3 paralel, WhatsApp **1** (satu socket; pengiriman paralel pada satu socket memicu rate-limit/ban).
- Timeout per pengiriman: koneksi 10 s, socket 20 s; batch 20 baris; `SIGTERM` → berhenti setelah item berjalan (PM2 `kill_timeout` 10 s sudah ada).
- `__tests__/realtime/emit-points.test.ts` meng-assert `instances: 1` + `fork` dan menolak `cluster`; app kedua dengan `fork`/1 **tidak** melanggar assert itu (regex-nya longgar), tetapi konsekuensi realtime harus disadari (B5).

### 6.3 Konsekuensi realtime yang harus diterima eksplisit

Bus realtime bersifat **in-process**. Status pengiriman yang berubah di worker **tidak** akan memicu invalidasi SSE di proses web. Phase 1 harus memilih salah satu, dan **tidak boleh** diam-diam mengabaikannya:

1. **Polling** pada halaman status (paling murah, konsisten dengan fallback poll yang sudah ada), atau
2. membiarkan status hanya terlihat di halaman server-rendered (refresh manual), atau
3. menunda UI status ke fase lain.

Rekomendasi: **(1)**, tanpa menambah mekanisme pub/sub lintas proses.

---

## 7. Retry and idempotency strategy

### 7.1 Klaim baris (mencegah kirim ganda)

```sql
-- CAS, satu statement, tanpa perlu raw SQL
UPDATE notificationdelivery
   SET status='SENDING', lockedUntil=:now+120s, lockedBy=:workerId,
       attemptCount=attemptCount+1, lastAttemptAt=:now
 WHERE id=:id AND status='QUEUED' AND (nextRetryAt IS NULL OR nextRetryAt<=:now);
-- count===1 → klaim sah; count===0 → orang lain/not-yet-due
```

Reclaim baris macet: `status='SENDING' AND lockedUntil < now` → kembali ke `QUEUED` dengan `nextRetryAt=now` dan `errorCode='LEASE_EXPIRED'`. **Ini alasan `lockedUntil` wajib ada.**

### 7.2 Backoff

| Attempt | Jeda sebelum retry | Catatan |
|---|---|---|
| 1 → 2 | **60 s** + jitter ±20% | transient (timeout, 421/450/451, 5xx, ECONNRESET) |
| 2 → 3 | **5 menit** + jitter | transient |
| 3 (habis) | — → `FAILED` | `maxAttempts=3` (default schema) |

Tanpa retry (langsung `FAILED`/`SKIPPED`): alamat tidak valid, opt-out, konfigurasi provider hilang, `loggedOut` WhatsApp, 5xx autentikasi permanen. Mencoba ulang kesalahan permanen hanya memperpanjang antrean dan meningkatkan risiko ban.

### 7.3 Idempotensi berlapis

| Lapis | Mekanisme | Efek |
|---|---|---|
| Enqueue | `notification.idempotencyKey @unique` | dua pemanggilan (mis. webhook direplay) menghasilkan satu intent |
| Fan-out | `UNIQUE (notificationId, channel)` | email+WhatsApp tidak bisa terduplikasi per baris |
| Klaim | CAS `QUEUED → SENDING` | dua worker tidak pernah mengirim baris yang sama |
| Provider | `providerMessageId` disimpan; bila ada tapi status tak pasti → **jangan kirim ulang**, tandai `SENT` setelah verifikasi | mencegah duplikat yang tidak bisa ditarik kembali |
| Replay webhook | `WebhookEvent.providerEventId @unique` (sudah ada) | enqueue tidak pernah dipanggil untuk replay |

**Batas kejujuran:** dengan SMTP, *exactly-once* tidak mungkin. Yang dijamin adalah **at-most-once terhadap baris yang sudah diklaim**, plus dedup enqueue. Bila proses mati setelah provider menerima tetapi sebelum status ditulis, retry dapat menghasilkan pesan ganda — karena itu `providerMessageId` disimpan ASAP dan pesan bertanda `SENT` tidak pernah dikirim ulang.

### 7.4 Status machine final

```
QUEUED ──claim──▶ SENDING ──ok───────────────▶ SENT
                     │
                     ├─transient, attempt<max──▶ QUEUED (nextRetryAt)
                     ├─permanent / attempt=max──▶ FAILED
                     └─lease expired───────────▶ QUEUED (LEASE_EXPIRED)

QUEUED ──tanpa recipient/opt-out/config off──▶ SKIPPED
```

`SKIPPED` **bukan** kegagalan dan tidak boleh diretry; `FAILED` adalah terminal dan butuh tindakan operator (atau fase mendatang).

---

## 8. Session and credential security

### 8.1 Kontrak environment (diusulkan untuk `.env.example`)

```
NOTIFICATIONS_ENABLED="false"          # kill switch; default OFF, dibaca sebagai string ketat
EMAIL_TRANSPORT="disabled"             # disabled | log | smtp | http
SMTP_HOST="" SMTP_PORT="587" SMTP_SECURE="false"
SMTP_USER="" SMTP_PASS=""
EMAIL_FROM=""                          # wajib untuk smtp; TIDAK pernah dari request
WHATSAPP_TRANSPORT="disabled"          # disabled | log | baileys
WA_AUTH_DIR="/var/lib/tinggalklik/whatsapp-auth"
NOTIFICATION_WORKER_POLL_MS="5000"
NOTIFICATION_BATCH_SIZE="20"
```

Aturan parsing mengikuti pola yang sudah terbukti di `lib/payment/config.ts`: nilai yang hilang/salah **melempar**, tidak pernah fallback diam-diam. `NOTIFICATIONS_ENABLED` selain `"true"` = OFF.

### 8.2 Pengelolaan kredensial

| Aspek | Aturan |
|---|---|
| Lokasi | environment proses host / file env yang dimuat host — **bukan** repository (runbook §3.5, `ecosystem.config.cjs` sengaja tanpa `env_file`) |
| Paparan | hanya worker; route web tidak membaca `SMTP_*`/`WA_*` |
| Logging | dilarang mencetak kredensial, token, atau isi pesan; error provider disimpan setelah disanitasi (`errorCode` enum-like + pesan terpotong) |
| Rotasi | ganti env + `pm2 reload tinggalklik-worker`; tidak ada kredensial di database |
| Dev vs prod | kredensial terpisah; **dilarang** memakai kredensial produksi untuk development (pembatasan Phase 0C §12) |
| Fail-closed | transport `smtp` tanpa `SMTP_HOST`/`EMAIL_FROM` → worker menolak start, bukan mengirim tanpa identitas |

### 8.3 WhatsApp/Baileys: pairing, session persistence, reconnect, multi-instance

| Aspek | Rancangan | Alasan |
|---|---|---|
| **Pairing QR** | **CLI di VPS** (`npm run wa:pair`) menulis kredensial ke `WA_AUTH_DIR`; QR **tidak pernah** dirender di web publik | QR = kontrol penuh atas akun WhatsApp; membocorkannya = account takeover |
| Session persistence | `useMultiFileAuthState(WA_AUTH_DIR)`; direktori di luar checkout, `chmod 700`, file `0600`, masuk backup terenkripsi | kredensial setara password; hilang = pairing ulang, bocor = takeover |
| Reconnect | backoff eksponensial 2 s → 5 m, `DisconnectReason.loggedOut` → **berhenti & minta pairing ulang** (tidak loop) | loop reconnect pada sesi invalid memicu ban |
| Multi-instance | satu socket per sesi, ditegakkan **lease database** (`joblock` baris `whatsapp-session`), bukan asumsi operator | dua socket dengan kredensial sama = saling memutus |
| Rate limit | satu pengirim, jeda antar pesan, batas per menit, tanpa broadcast serentak | WhatsApp membatasi pesan bisnis; ban bersifat permanen |
| Compliance | Phase 2 (proof of purchase) transaksional; Phase 4 reminder = **pesan bisnis-inisiatif** yang pada Cloud API **wajib template disetujui** | keputusan produk/legal, bukan teknis |

---

## 9. Migration impact analysis

### 9.1 Apa yang akan berubah (usulan, belum dibuat)

Satu migration additive, nama mengikuti pola yang ada (`YYYYMMDDHHMMSS_add_notification_dispatch_fields`):

```sql
ALTER TABLE `notificationdelivery`
  ADD COLUMN `lockedUntil`   DATETIME(3) NULL,
  ADD COLUMN `lockedBy`      VARCHAR(64) NULL,
  ADD COLUMN `lastAttemptAt` DATETIME(3) NULL;

CREATE INDEX `notificationdelivery_status_lockedUntil_idx`
  ON `notificationdelivery`(`status`, `lockedUntil`);
```

Tidak ada `DROP`, tidak ada `MODIFY` enum, tidak ada backfill.

### 9.2 Dampak terukur

| Objek | Kondisi aktual | Dampak |
|---|---|---|
| `notificationdelivery` | **0 baris** | ALTER + CREATE INDEX praktis instan; tidak ada lock contention berarti |
| `notification` | **44 baris legacy** (channel `whatsapp`, category NULL) | **Tidak disentuh** — tidak ada perubahan kolom, tidak ada backfill, tidak ada penghapusan |
| `joblock` | 0 baris | Baris `notification-dispatch`/`whatsapp-session` dibuat saat runtime pertama, bukan oleh migration |
| Schema vs DB | `prisma migrate status` = **up to date** (32 migration) | Baseline bersih; migration baru akan menjadi ke-33 |
| MariaDB 11.8 | mendukung instant ADD COLUMN untuk kolom nullable & index INPLACE | Risiko rebuild kecil, dan tabel kosong |

### 9.3 Prosedur dan gerbang

1. Migration **dibuat sebagai file** pada fase implementasi, **tidak dijalankan** pada fase ini (batasan audit; dan `prisma migrate deploy` adalah tindakan owner).
2. Sebelum apply: backup database (runbook §6.3) + catat hash commit.
3. Apply: `npx prisma migrate deploy` (bukan `db push`), lalu verifikasi `migrate status`.
4. Rollback: kolom/index additive dapat dibuang dengan migration baru; **tidak ada** data yang perlu dipulihkan karena tidak ada penulisan.
5. Larangan yang tetap berlaku: tidak ada `migrate reset`, tidak ada operasi destruktif, tidak ada perubahan pada 44 baris legacy.

### 9.4 Risiko schema yang **tidak** diselesaikan Phase 1

- `notification.channel` masih `String` bebas sementara `notificationdelivery.channel` adalah enum → dua sumber kebenaran. Phase 1 harus **selalu** mengisi keduanya dari satu nilai enum yang sama, tetapi tidak boleh mengubah kolom legacy (perubahan tipe = rewrite tabel berisi data).
- Tidak ada `CANCELLED` pada `NotificationDeliveryStatus`. Pesanan yang direfund sebelum sempat dikirim akan tampil `SKIPPED` — dapat diterima untuk Phase 1, perlu keputusan bila Phase 2 membutuhkannya.

---

## 10. Risks and mitigation

| # | Risiko | Dampak | Mitigasi |
|---|---|---|---|
| R1 | Nodemailer High diaktifkan tanpa kontrol | File read/SSRF/DoS | C1: transport `disabled` default; tanpa `raw`; `disableFileAccess`/`disableUrlAccess`; recipient dari DB; timeout; opsi C menghapus kelas risiko ini |
| R2 | Auth.js Email provider ditambahkan | Memanggil nodemailer rentan lewat `@auth/core` | **C2: dilarang pada Phase 1** |
| R3 | Enqueue di dalam transaksi payment/issuance | Lock lebih lama, webhook timeout, double-settle risk | Enqueue **setelah** commit; kegagalan enqueue tidak boleh menggagalkan webhook (dicatat + disapu worker) |
| R4 | Webhook gagal karena provider email down | Order sudah PAID tetapi callback 500 → provider retry | Worker terpisah; enqueue hanya menulis DB lokal; tidak ada I/O jaringan di jalur webhook |
| R5 | Scheduler tidak terpasang | Pesan tidak pernah terkirim, diam-diam | C3: worker poll sendiri + heartbeat `joblock`; alarm bila `lastRunAt` basi |
| R6 | Baris `SENDING` macet | Pesan hilang permanen | `lockedUntil` + reclaim `LEASE_EXPIRED` |
| R7 | Duplikat pesan pada retry | Pelanggan menerima 2 bukti pembelian | Idempotency berlapis (§7.3); `providerMessageId` disimpan sebelum status |
| R8 | Ban WhatsApp / ToS | Nomor hilang, fitur mati | C4: flag OFF; rate limit; pairing manual; jalur resmi (Cloud API) sebagai alternatif |
| R9 | Kredensial bocor lewat log/API | Account takeover | §8.2; sanitasi error; tidak ada kredensial di response |
| R10 | Worker & web memakai rate limiter in-memory berbeda | Limit login tidak terpengaruh, tetapi limit kirim salah sasaran | Limit pengiriman hidup di DB (queue), **bukan** di `lib/rate-limit.ts` |
| R11 | Realtime status tidak sampai ke UI | Operator mengira pesan tidak terkirim | Polling (§6.3); status juga tercatat di `joblock`/tabel |
| R12 | Static guard test gagal | CI merah | Wiring test melarang `whatsapp|baileys|nodemailer` dan `prisma.notification.create` di file checkout/payment/issuance → enqueue **hanya** lewat `lib/notifications/`; Phase 2 memanggil fungsi itu, bukan menulis tabel |
| R13 | Route baru lupa diklasifikasikan di `proxy.ts` | Route jatuh ke perilaku default | `__tests__/authz/route-classification.test.ts` gagal bila ada `route.ts` tak terklasifikasi — ikuti, jangan matikan |
| R14 | Migration dijalankan tanpa backup | Kehilangan data (walau kecil) | §9.3; gerbang owner |

---

## 11. Implementation plan (tetap di dalam Phase 1)

### 11.1 Yang dibangun

| # | Deliverable | File (usulan) | Kriteria selesai |
|---|---|---|---|
| 1 | Migration additive (file saja, tidak dijalankan) | `prisma/migrations/<ts>_add_notification_dispatch_fields/migration.sql` + `schema.prisma` | `prisma validate` hijau; SQL hanya ADD/INDEX; tidak menyentuh 44 baris legacy |
| 2 | Registry template + renderer | `lib/notifications/templates/*` | template server-side, versi eksplisit (`templateKey`), tanpa input user mentah |
| 3 | Enqueue API | `lib/notifications/enqueue.ts` | idempoten (`idempotencyKey`), membuat fan-out per kanal, **tidak** memanggil provider, aman dipanggil setelah commit |
| 4 | State machine + claim/retry | `lib/notifications/queue.ts` | CAS claim, reclaim lease, backoff §7.2, status final §7.4 |
| 5 | Adapter email | `lib/notifications/email/{log,smtp}.ts` + interface | `disabled` default; kontrak tunggal; tanpa `raw` |
| 6 | Adapter WhatsApp | `lib/notifications/whatsapp/{log,baileys}.ts` | `disabled` default; pairing CLI; reconnect ber-backoff; lease sesi |
| 7 | Worker | `scripts/worker.ts` (+ script npm `worker`) | poll, batch, concurrency, graceful shutdown, heartbeat `joblock` |
| 8 | Definisi proses | `ecosystem.config.cjs` (app kedua) | `instances: 1`, `fork`, tidak menyentuh app web |
| 9 | Kontrak env + dokumentasi | `.env.example`, `README.md`, `DEPLOYMENT_RUNBOOK.md` bagian worker | default OFF; kredensial hanya placeholder; prosedur start/stop/health |
| 10 | Test | unit (backoff, CAS, state machine, renderer), integrasi (drain antrean di DB test), static guard (tidak ada provider call di request path) | seluruh suite hijau; wiring test lama **tidak diubah** |

### 11.2 Urutan kerja yang aman

1. Migration + schema (tanpa apply).
2. Core queue + enqueue + template (tanpa adapter).
3. Adapter `log` + worker `log` → antrean dapat diuji end-to-end **tanpa jaringan**.
4. Adapter `smtp`/`baileys` di belakang flag, tetap default `disabled`.
5. Dokumentasi + runbook + health check.
6. Verifikasi: typecheck, lint, build, targeted test, full Jest.

### 11.3 Di luar Phase 1 (tegas)

- Mengirim **purchase proof** ke pelanggan (Phase 2).
- Reminder H-36 (Phase 4) dan document blast (Phase 5).
- Auth.js Email provider / magic link.
- UI pengelolaan notifikasi yang lengkap, template editor, atau analytics pengiriman.
- BullMQ/Redis, atau perubahan `instances` aplikasi web.

---

## 12. GO / CONDITIONAL GO / NO-GO

### Rekomendasi: **CONDITIONAL GO**

Alasan GO:

- Fondasi data **sudah ada** dan justru dirancang untuk ini (`notification`/`notificationdelivery` dengan idempotensi + retry + index antrean).
- Pola konkurensi yang aman **sudah terbukti** di repository (`joblock` lease, CAS, tick terautentikasi) dan tidak perlu bergantung pada Redis.
- Batas transaksi payment/issuance/real-time sudah terdokumentasi dan dapat dipatuhi.
- Tidak ada perubahan schema destruktif yang dibutuhkan: seluruh tambahan additive pada tabel kosong.

Alasan **CONDITIONAL** (bukan GO penuh):

| Kondisi | Harus dipenuhi sebelum |
|---|---|
| **C1** keputusan jalur email (§2.4 A/B/C) | sebelum transport `smtp`/`http` diaktifkan |
| **C2** Auth.js Email provider dilarang | sebelum ada pekerjaan auth email |
| **C3** worker mandiri, bukan cron | sebelum implementasi worker |
| **C4** keputusan risiko Baileys vs Cloud API | sebelum `WHATSAPP_TRANSPORT` selain `disabled`/`log` |
| **C5** Phase 1 hanya dry-run | sebelum ada pengiriman nyata |

### Kapan menjadi NO-GO

- Owner meminta email produksi aktif di Phase 1 **sebelum** C1 diputuskan → risiko file-read/SSRF/DoS pada jalur yang baru dinyalakan, tanpa mitigasi yang disepakati.
- Ada permintaan menjalankan migration pada fase audit ini.
- Ada permintaan menambahkan Email provider Auth.js untuk "sekalian" pada Phase 1.

---

## 13. Bukti audit, dan apa yang tidak berubah

**Dibaca/diperiksa pada sesi ini (read-only):** `package.json`, `auth.ts`, `server.js`, `ecosystem.config.cjs`, `next.config.ts`, `proxy.ts`, `lib/prisma.ts`, `lib/jobs/{lock,tick}.ts`, `app/api/internal/jobs/tick/route.ts`, `lib/realtime/{bus,taxonomy}.ts`, `lib/ticketing/payment/webhook.ts`, `lib/ticketing/tickets/issuance.ts`, `prisma/schema.prisma`, `prisma/migrations/20260916000000_ticketing_phase2_foundation/migration.sql`, `prisma/migrations/20260929000000_add_payment_active_order_id/migration.sql`, `.env.example`, `.gitignore`, `.nvmrc`, `README.md`, `DEPLOYMENT_RUNBOOK.md`, `__tests__/ticketing-checkout/checkout-wiring.test.ts`, `__tests__/realtime/emit-points.test.ts`, serta `node_modules/@auth/*` dan `next-auth` metadata.

**Query read-only ke database aplikasi:** `SELECT VERSION()`, hitungan baris `notification`/`notificationdelivery`/`joblock`, agregasi `channel`/`category`, dan `prisma migrate status`. Tidak ada INSERT/UPDATE/DELETE/DDL.

**Perubahan pada repository oleh sesi ini:** hanya file laporan ini (`PHASE_1_PRE_IMPLEMENTATION_AUDIT_REPORT.md`). Tidak ada dependency yang diubah, tidak ada migration dibuat/dijalankan, tidak ada business logic disentuh, tidak ada commit/push/reset/rebase/stash, dan **Phase 1 belum diimplementasikan**.

**Menunggu keputusan owner atas C1–C5 sebelum implementasi dimulai.**
