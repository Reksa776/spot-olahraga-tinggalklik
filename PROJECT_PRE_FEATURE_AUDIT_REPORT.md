# PROJECT PRE-FEATURE AUDIT REPORT

**Project:** TinggalKlik.Co  
**Mode:** Strict read-only pre-feature audit  
**Audit date:** 2026-10-29  
**Scope:** kesiapan WhatsApp reminder H-36, delivery bukti pembelian via email/WhatsApp, akses scan QR untuk PIC, dan blast dokumen pasca-event dari dashboard PIC.

> Audit ini tidak mengimplementasikan atau memperbaiki fitur. Satu-satunya file baru dari pekerjaan audit ini adalah laporan ini. Workspace sudah berisi perubahan yang ada sebelum audit pada `package.json`, `package-lock.json`, dan `lib/authz/permissions.ts`; perubahan itu tidak diubah dalam audit ini.

## 1. Executive summary

TinggalKlik.Co adalah aplikasi Next.js dengan Prisma/MySQL dan fondasi ticketing, payment, event lifecycle, PIC assignment, serta check-in yang relatif matang. Pembayaran dan check-in mempunyai kontrol concurrency/idempotency yang eksplisit. Event punya satu URL dokumentasi pasca-event, tetapi sistem notifikasi masih dashboard-only: tidak ditemukan dispatcher email/WhatsApp yang mengirim ke peserta. Scheduler saat ini mendaftarkan tepat dua job, yaitu lifecycle event dan reservation reaper.

Fitur scan untuk organizer/staf sudah tersedia; PIC bukan anggota organizer secara otomatis dan layanan check-in yang diperiksa memerlukan izin organizer `checkin.scan`. Ada permission own-scope `pic.checkin.scan.own`, tetapi tidak ada bukti bahwa izin itu sudah dihubungkan ke alur check-in/event assignment. Upload bukti settlement adalah fasilitas yang sudah ada untuk bukti transfer settlement, bukan bukti pembelian peserta.

**Keputusan akhir: NO-GO untuk mulai mengembangkan fitur pesan pada kondisi dependensi saat ini; CONDITIONAL GO untuk rancangan/implementasi setelah blocker database dan dependency security ditangani.** Jangan deploy aplikasi sampai migration tertinggal dan advisori dependency serius sudah ditinjau. Isolasi Jest juga perlu diperbaiki sebelum menganggap tes aman untuk dijalankan dengan database aplikasi.

## 2. Current architecture

### Struktur dan dependency

- App Router Next.js 16, React 19, TypeScript, Prisma 6, MySQL; struktur halaman/API berada di `app/`, business logic di `lib/`, komponen dashboard di `components/`, dan tes Jest di `__tests__/`.
- Dependency relevan yang tersedia di workspace: `@whiskeysockets/baileys` 6.7.24, Nodemailer 8.0.11, `qrcode`, `qrcode.react`, `jsqr`, Prisma, Jest/ts-jest. Kehadiran package bukan bukti provider telah dikonfigurasi atau pesan dapat dikirim.
- Package dan lockfile telah memiliki perubahan lokal sebelum audit, termasuk dependensi; hasil `npm audit` karenanya menggambarkan working tree saat diperiksa, bukan hanya revision bersih.

### Authentication dan authorization

- API menggunakan session melalui `requireAuth()`/authz guards. Mutasi sensitif menerapkan pemeriksaan same-origin/CSRF.
- Authorization berbasis permission dan scope platform/organizer/own. PIC self-service memverifikasi `scope.userId` terhadap user yang diminta, mencari hanya profil PIC aktif, dan menurunkan filter query dari `picProfileId` server-side (`lib/pic/self-service.ts:146-192`).
- `getMyPicOrder` menyaring berdasarkan `orderNumber` serta PIC pemilik dan mengembalikan data order/line tanpa email/telepon peserta (`lib/pic/self-service.ts:895-954`). Ini pola baik untuk menjaga PII.

### Dashboard Admin/PIC dan event assignment

- Dashboard PIC dan layanan self-service menggunakan profil PIC serta assignment event; assignment aktif memerlukan `isActive: true` dan `revokedAt: null` (contoh `lib/pic/self-service.ts:471-515`, `1060-1131`). Assignment direvokasi/diaktifkan sebagai sumber otoritatif untuk akses referral.
- Organizer memiliki halaman manajemen event/dokumentasi. Halaman event PIC saat ini adalah permukaan yang logis untuk penambahan blast, tetapi belum ada jalur pesan di sana.

### Event lifecycle, checkout, ticket issuance, payment

- Event lifecycle mencakup publish/ongoing/completed/cancelled/archived. Job lifecycle memproses batch dan reservation reaper melepas reservation expired (`lib/jobs/tick.ts:128-144`; dokumentasi operasional di `README.md:80-138`).
- Checkout membuat order/tiket melalui model EventOrder dan reservation. Ticket issuance memiliki service transaksi khusus (`lib/ticketing/tickets/issuance.ts:348,469`), dan pembayaran memisahkan claim transaksional dari pemanggilan provider di luar transaksi (`lib/ticketing/payment/service.ts:479-591,660-738`).
- Payment settlement memakai conditional update terhadap order `PENDING_PAYMENT`, dan mengelola pembayaran terlambat tanpa menghidupkan kembali order (`lib/ticketing/payment/settlement.ts:282-404`). Webhook memakai ledger unik `providerEventId` dan conditional transition forward-only (`lib/ticketing/payment/webhook.ts:51-56,157-183,199-257`).

### QR code, check-in, dan akses PIC

- Ticket wallet menghasilkan payload QR `TICKET:<ticketCode>`; kode itu referensi publik, bukan secret. Secret scanner tersimpan sebagai hash, dan desain menolak mengirim plaintext token permanen ke browser (`lib/ticketing/tickets/reference.ts:29-73`).
- Scanner dashboard event dan endpoint organizer menggunakan `requireEventCheckInAccess`; otoritas diturunkan dari organizer event, sedangkan staf check-in harus memiliki `StaffEventAssignment` aktif (`app/dashboard/events/[id]/check-in/page.tsx:22-48`; `lib/ticketing/checkin/service.ts:47-61,170-176`).
- Check-in memakai CAS `status=ISSUED` + `checkedInAt IS NULL`, lalu mencatat CheckIn; database unique `CheckIn.ticketId` menjadi guard tambahan (`lib/ticketing/checkin/service.ts:55-61,447-468`). Mode tercatat saat ini `MANUAL` (`:64-65`), sehingga QR scan aktual belum menjadi metode check-in yang aktif.
- `PIC_CHECKIN_SCAN_OWN` terdaftar pada peta permission dan role PIC (`lib/authz/permissions.ts:212,328,664`), tetapi alur check-in yang ditemukan hanya memanggil permission organizer `CHECKIN_SCAN`. Ini permission belum terpakai pada service scan dan belum cukup untuk memberikan akses PIC.

### Scheduler dan background jobs

- Runner tick dilindungi lease `JobLock` dengan akuisisi kondisional berdasar `lockedUntil` (`lib/jobs/lock.ts:30-76`). Job names saat ini persis `event-lifecycle` dan `reservation-reaper` (`:30-33`).
- Scheduler dipanggil per HTTP tick; tidak ada worker queue/cron terkelola yang mengirim pesan. Tick per menit serta dua job tercantum di `README.md:1-76,80-138`.
- Reminder H-36 butuh job baru atau mekanisme ekuivalen, window waktu yang stabil, claim/idempotency per penerima/channel, serta retry/outbox. Lease job saja tidak mencegah duplikasi per penerima.

### Email, WhatsApp, notifications, post-event docs

- README menyatakan notifikasi dashboard-only dan tidak ada email/WhatsApp/SMS ke pembeli (`README.md:140-145`). Pencarian source atas transport email (`createTransport`/`sendMail`), Baileys socket/pengiriman dan NotificationDelivery tidak menemukan implementasi pengiriman yang aktif. Model `Notification` dan `NotificationDelivery` memang ada (`prisma/schema.prisma:189,1711`), tetapi model bukan provider/dispatcher.
- Baileys/Nodemailer tersedia di dependency, namun tidak ada bukti sesi WhatsApp, penyimpanan auth state yang aman/terpersisten, status koneksi, email SMTP/provider config, atau worker pengiriman. WhatsApp via Baileys bergantung pada proses Node.js persisten dan pengelolaan sesi; konfigurasi serverless tanpa worker persisten tidak memenuhi kebutuhan ini.
- Dokumentasi event yang ada adalah `documentationUrl` yang dapat disimpan pengelola dan ditampilkan ke publik setelah event COMPLETED (`app/dashboard/events/[id]/page.tsx:286-299`; `app/e/[slug]/page.tsx:320-337`). Ini tautan, bukan upload dokumen privat atau blast kepada peserta.

### Upload dan penyimpanan private

- Bukti settlement disimpan di `UPLOAD_DIR/settlement-proof`, ukuran maksimal 5 MiB, validasi magic bytes JPEG/PNG/WEBP/PDF, nama server-generated, dan dibaca melalui route terautentikasi dengan `private, no-store`, `nosniff` (`lib/ticketing/settlement/proof.ts:24-47,69-91`; `app/api/organizer/settlements/[settlementId]/proof/[fileName]/route.ts:20-50`). Ini bukti transfer settlement, bukan bukti pembelian.
- Gambar event di `/api/uploads/events/[filename]` memang publik sesuai kebutuhan banner; route melakukan basename check dan menyajikan hanya tipe image yang diizinkan (`app/api/uploads/events/[filename]/route.ts:1-23,32-70`). Ini bukan storage yang aman untuk dokumen privat peserta.

### Database, concurrency, dan idempotency

- Prisma schema menggunakan provider MySQL. Payment active-attempt diproteksi kolom unique nullable dan claim pada transaksi order (`lib/ticketing/payment/service.ts:479-591`); webhook menggunakan unique key; check-in menggunakan CAS + unique; settlement dan state event memakai conditional updates.
- Invarian concurrency yang ada cukup baik untuk transaksi inti. Pengiriman pesan tetap membutuhkan idempotency terpisah; tidak boleh menyamakan lease scheduler dengan status delivery per penerima.

## 3. Verification results

| Pemeriksaan | Hasil | Catatan |
|---|---|---|
| `npx --no-install prisma validate` | PASS | Dijalankan sebelum laporan; memvalidasi schema lokal. |
| `npx --no-install tsc --noEmit --incremental false` | PASS | TypeScript typecheck lulus. |
| `npx --no-install eslint --no-cache` | PASS dengan warning | Lint lulus dan mengeluarkan 4 warning. Tidak ada warning yang diperbaiki dalam audit. |
| `npx --no-install jest --runInBand --silent` | PASS secara hasil tes, isolasi DB tidak dapat dipercaya | 159 suites dan 3.467 tests lulus pada run tercatat. Namun `jest.config.js:148` menjalankan teardown yang menargetkan `_test` **dan** URL `DATABASE_URL` asal. Maka run tersebut dapat melakukan write ke application DB; laporan tidak menyatakan suite ini aman/terisolasi. Read-only sesudah run menemukan 12 sport dengan prefix fixture nonaktif; tanpa snapshot awal tidak dapat dipastikan apakah perubahan itu berasal dari run ini. Tidak ada query tulis tambahan selama audit. |
| Production build | NOT RUN | `.next` sudah ada ketika audit dimulai (mtime tercatat 2026-10-07). Build berpotensi menulis/menimpa artefak tersebut; dilewati untuk memenuhi batas audit read-only dan menjaga artefak yang ada. Karena itu status build terkini belum diverifikasi. |
| `npm audit --json` | FAIL — advisori | Exit 1; 21 temuan: 2 critical, 13 high, 6 low. Critical termasuk `next` dan `handlebars`; high termasuk `axios`, `nodemailer`, `next-auth`, `prisma`/`@prisma/config`, `zod` dan paket transitif lain. Audit tidak melakukan update. |
| Konsistensi migration | APPLICATION DB: BEHIND; test DB: CURRENT | Pemeriksaan metadata baca-saja: aplikasi 31 migration sampai `20260927000000_add_pic_payout_requests`; test schema 32 sampai `20260929000000_add_payment_active_order_id`. Tidak ada migration yang diterapkan. |

**Peringatan keselamatan test:** `scripts/setup-test-db.ts` melakukan provisioning schema test dan baseline seed; itu tidak dijalankan dalam fase audit. Global teardown yang terpasang justru mengarsipkan event fixture dan menonaktifkan sport fixture pada kedua DB. Sebelum run Jest berikutnya, ubah proses/konfigurasi tersebut setelah approval owner agar teardown hanya menyentuh schema test; jangan jalankan test dengan environment aplikasi/production.

## 4. Confirmed bugs / capability gaps

### P2 — Jest global teardown menulis ke application database

- **Bukti:** `jest.config.js:144-148` mengaktifkan `__tests__/support/fixture-teardown.ts`; `__tests__/support/fixture-teardown.ts:98-116` membangun target dari `testDatabaseUrl(appUrl)` dan `appUrl`, kemudian memanggil `neutralize` pada keduanya. `neutralize` melakukan `event.updateMany` dan `sport.updateMany` (`:78-92`).
- **Root cause:** komentar setup/config menyebut database test terisolasi, tetapi teardown secara eksplisit menyertakan database aplikasi.
- **Impact:** run Jest yang berhasil maupun gagal dapat mengarsipkan event fixture dan menonaktifkan sport fixture pada DB aplikasi. Predicate prefix membatasi row yang terkena, namun bukan operasi read-only dan bisa mengubah data fixture lama.
- **Klasifikasi:** bug prosedur test/data safety; bukan bukti perubahan terhadap data produksi. Dampak aktual run terakhir tidak dapat diatribusikan tanpa snapshot pra-run.

### P2 — Sistem outbound notification belum tersedia

- **Bukti:** `README.md:140-145` mendefinisikan dashboard-only; model notifikasi ada di `prisma/schema.prisma:189,1711`, tetapi pencarian source tidak menemukan transport `sendMail`/Baileys atau dispatcher.
- **Root cause:** persistence notifikasi belum disambungkan ke provider/pengiriman.
- **Impact:** tidak ada reminder, delivery bukti pembelian, ataupun blast dokumen yang dapat dikirim sekarang.
- **Klasifikasi:** capability gap terkonfirmasi, bukan klaim bahwa UI notifikasi dashboard rusak.

### P2 — Izin scan PIC tidak tersambung ke jalur check-in

- **Bukti:** PIC permission didefinisikan dan diberikan pada role map (`lib/authz/permissions.ts:212,328,664`); scan route/service memanggil `requireEventCheckInAccess` yang meminta `CHECKIN_SCAN` organizer (`lib/ticketing/checkin/service.ts:170-176,296-303`). PIC assignment tidak otomatis menjadi organizer membership.
- **Root cause:** permission own-scope belum diintegrasikan dengan pemeriksaan event assignment pada check-in.
- **Impact:** tidak ada dasar untuk menyimpulkan PIC dapat membuka scanner/scan tiket saat ini. Menambahkan link UI saja tidak aman.
- **Klasifikasi:** capability gap; belum ditemukan bypass lintas event/tenant pada guard organizer yang ditinjau.

### P2 — `documentationUrl` tidak mengimplementasikan blast/private document

- **Bukti:** dashboard organizer mengelola URL (`app/dashboard/events/[id]/page.tsx:286-299`), halaman publik menampilkannya setelah event selesai (`app/e/[slug]/page.tsx:320-337`).
- **Root cause:** field URL/halaman publik adalah katalog resource, bukan upload private, audience selection, atau delivery channel.
- **Impact:** mengganti/menambah UI tanpa audience scope dapat membocorkan dokumen; status completion saja bukan otorisasi peserta.
- **Klasifikasi:** gap kebutuhan fitur dan risiko desain bila disalahgunakan sebagai dokumen privat.

## 5. Potential risks

- **P1 — Baileys session/runtime:** Baileys memerlukan koneksi/session yang persisten dan lifecycle koneksi/reconnect yang terjaga. Menaruh socket atau auth state pada request serverless/instance ephemeral dapat menyebabkan login terputus, pesan hilang/duplikat, atau kredensial sesi bocor. Tentukan runtime/worker persisten, penyimpanan secret/session, single-owner socket, reconnect, monitoring, dan rate limit sebelum implementasi.
- **P1 — Dependency vulnerabilities:** hasil `npm audit` menunjukkan critical/high advisories dalam working-tree graph. Build/typecheck sukses tidak menyelesaikan kerentanan runtime/dependency.
- **P1 — Migration drift:** aplikasi tertinggal satu migration dari repository dan schema test. Feature migration baru tidak aman diterapkan sampai keadaan target DB dan prosedur release dipastikan.
- **P2 — Kebenaran satu kali pengiriman:** job lease hanya menahan overlap job; belum ada bukti idempotency delivery per peserta/channel atau durable retry/outbox. Tick ulang dan retry provider dapat menggandakan pesan bila model/outbox tanpa unique business key.
- **P2 — Identitas penerima/order:** PIC order view tidak menampilkan PII. Flow bukti pembelian perlu memakai kontak pemilik order yang tervalidasi server-side, bukan data dari payload PIC atau browser.
- **P2 — QR payload bukan kredensial scan:** QR wallet mengandung `ticketCode`, sedangkan design mencatat scanner token sebagai secret dan `QR_SCAN` belum dipakai. Integrasi PIC harus memakai mekanisme yang mengotorisasi event + assignment dan memutuskan cara memperoleh/merotasi token, bukan melonggarkan endpoint ticket publik.
- **P2 — Dokumen privat:** upload settlement memiliki validasi tipe/ukuran dan serving privat yang dapat dijadikan pola, tetapi berkas event banner memang publik. Tautan dokumentasi event saat ini dapat diakses publik; jangan gunakan untuk file peserta yang harus dibatasi.
- **P3 — Test signal:** hasil Jest pass bernilai, tetapi risiko teardown mengurangi kepercayaan pada isolasi dan side-effect safety. Jangan jalankan ulang sebelum memperbaiki/pemisahan target di fase yang sudah disetujui.

## 6. Security findings

- **Authorization positif:** event check-in organizer menggunakan resource ID untuk memuat event dan izin organizer; foreign tenant dirancang menjadi 404. Staf biasa perlu event assignment aktif. PIC self-service membatasi identitas ke session dan query ke profil/assignment sendiri.
- **PII:** endpoint PIC order yang ditinjau sengaja hanya memberi order/event/item ringkasan, bukan data kontak. Log check-in mengandung nama peserta, tetapi aksesnya dikendalikan permission `checkin.log.read`; blast/scan route baru perlu membatasi field yang dikembalikan.
- **Upload:** settlement proof memeriksa signature byte dan batas 5 MiB, menyimpan dengan nama acak, dan hanya menyajikan melalui authorization + `private, no-store`/`nosniff`. Event imagery yang disajikan publik bukan pola untuk dokumen pasca-event.
- **Dependency audit:** audit dependency menemukan 2 critical dan 13 high; hasil lengkap harus ditinjau per package/advisory sebelum rilis. Audit tidak melakukan perbaikan atau update.
- **Test teardown:** global teardown menyentuh application URL; ini risiko keselamatan data untuk testing lokal dan harus menjadi blocker menjalankan regresi lagi terhadap konfigurasi env sekarang.
- **Belum terkonfirmasi:** pada kode yang ditinjau tidak ditemukan bukti duplicate settlement/ticket issuance, bypass cross-PIC, atau double check-in; conditional settlement, ticket issuance transaction, dan check-in CAS/unique memberikan guard. Ini bukan jaminan seluruh aplikasi bebas bug—hasil merupakan scope audit, bukan pentest penuh.

## 7. Database and migration readiness

- Provider Prisma adalah MySQL (`prisma/migrations/migration_lock.toml`). Inventory berisi baseline dan migration berurutan hingga `20260929000000_add_payment_active_order_id`.
- Metadata schema aplikasi: **31 applied**, terakhir `20260927000000_add_pic_payout_requests`; schema test: **32 applied**, terakhir `20260929000000_add_payment_active_order_id`.
- Dengan demikian development/application DB tidak sinkron dengan tree migration. Tidak ada `migrate deploy`, `db push`, seed, reset atau query write dilakukan dalam fase ini.
- Notification/NotificationDelivery telah memiliki model, tetapi perlu menilai constraints/index/retention sebelum memakai sebagai outbox multi-channel. Kemungkinan migration baru: unique key reminder/order/channel, delivery attempt/status/provider response minimal, dan pilihan status dokumen; keputusan final memerlukan desain fitur serta kondisi database yang disetujui.
- Jangan menyimpulkan aplikasi siap menerima schema baru sebelum drift pada DB target dijelaskan dan rencana migrasi disetujui.

## 8. Existing reusable infrastructure

1. Permission/scope system dan event/PIC assignment aktif/revoked.
2. Order, payment, settlement, dan ticket data model; ticket issuance service; webhook ledger idempotent.
3. Job tick HTTP endpoint, leases, batch processing, `JobLock` observability.
4. Notification/NotificationDelivery schema sebagai kemungkinan persistence/outbox (belum sender).
5. Nodemailer dan Baileys packages terpasang (belum provider integration).
6. Event docs URL dan PIC/organizer dashboards (bukan document blast).
7. QR generation/reference, browser camera scanner component, organizer check-in service; current check-in writes `MANUAL`.
8. Server-side file handling patterns: `UPLOAD_DIR`, magic-byte checks, size caps, private authenticated file serving for settlement proofs.
9. Existing Jest tests around permissions, jobs, ticket issuance, payment, check-in, and docs provide reusable regression coverage—setelah safety issue teardown ditangani.

## 9. Readiness matrix

| Fitur | Komponen tersedia | Belum tersedia / dependency | Migration? | Risiko existing flow | Status |
|---|---|---|---|---|---|
| WhatsApp Blast Reminder H-36 jam | Event start time, event lifecycle tick, JobLock, notification models, Baileys dependency | Scheduler job/recipient query, queue/outbox, per-ticket/contact policy, unique idempotency, Baileys persistent runtime/session, retry/opt-out/rate limit/monitoring | Kemungkinan ya untuk dedupe/delivery state; schema delivery perlu audit lebih dahulu | Job overlap/retry dapat mengirim pesan berulang; sinkronisasi langsung dalam settlement/order transaction tidak aman | **BLOCKED** sampai deployment Baileys runtime dan DB drift/security dibahas; lalu conditional go |
| Bukti pembelian via WhatsApp dan email | Order/ticket data, buyer contact fields, payment settlement, Nodemailer/Baileys dependencies, ticket QR payload | Mail transport/config, WhatsApp runtime, definisi artefak bukti (receipt vs ticket/e-ticket), trigger setelah state committed, secure link/file, retries/dedupe | Mungkin; tergantung delivery ledger dan kebutuhan menyimpan bukti | Trigger dalam payment/webhook dapat mengganggu settlement; side effect wajib setelah commit/outbox | **CONDITIONAL GO** setelah provider/runtime dan outbox/idempotency diputuskan |
| Akses scan QR Code untuk PIC | PIC assignment, `PIC_CHECKIN_SCAN_OWN` permission, wallet QR, scanner UI, check-in CAS service | Integrasi authorization PIC+assignment pada page/API, desain metode QR/token, tests lintas PIC dan event, audit log | Tidak pasti; jika ticket secret/check-in method baru diperlukan, iya | Perubahan guard dapat membuka event PIC lain atau menurunkan keamanan token; check-in state harus tetap CAS | **CONDITIONAL GO** setelah kontrak authorization/token disepakati; jangan memakai permission saja |
| WhatsApp/Email Blast dokumen pasca-event pada halaman PIC | PIC page/assignment, event docs URL, notification models, file upload/serving patterns | PIC event-level audience authorization, file/private document lifecycle, recipient selection, sender providers, delivery status/idempotency, URL expiry/access control | Kemungkinan ya untuk dokumen/delivery jobs | URL publik saat ini dapat membocorkan file; penerima/PII dan blast massal perlu pembatasan | **BLOCKED** sampai model dokumen privat + recipient authorization/provider disepakati |

## 10. Blockers sebelum implementasi

1. Dapatkan keputusan owner tentang target runtime untuk Baileys yang persisten (bukan asumsi Next.js request/serverless) dan pengelolaan sesi/secret/reconnect.
2. Tinjau dan rencanakan mitigasi 2 critical + 13 high advisories. Jangan lakukan dependency update tanpa approval terpisah dan regression/build.
3. Rekonsiliasi migration drift aplikasi (`20260929000000` belum applied) melalui prosedur release yang disetujui; jangan migrasikan diam-diam.
4. Perbaiki keamanan isolation pada Jest global teardown agar hanya schema test yang dapat ditulis, kemudian verifikasi test DB yang jelas terisolasi sebelum menjalankan test lagi.
5. Definisikan sumber nomor WA/email, persetujuan/opt-out, event/timezone untuk H-36, semantik receipt, retensi/akses dokumen, batas batch, dan retry/idempotency.
6. Putuskan model outbox/NotificationDelivery serta unique delivery identity sebelum mengirim pesan eksternal.
7. Tetapkan policy PIC scanner: assignment aktif, cakupan event, izin membaca data peserta minimum, QR payload/token, audit scan, dan revocation.
8. Production build belum diverifikasi dalam audit ini. Tentukan penanganan artefak `.next` yang sudah ada sebelum menjalankan build; jangan klaim build sehat berdasarkan typecheck/lint.

## 11. Recommended implementation order (setelah approval)

1. Bersihkan blockers platform/security/DB/test safety dan dapatkan keputusan owner untuk Baileys runtime dan batasan dokumen/PII.
2. Rancang serta uji outbox/delivery identity, retensi, status retry, dan migrasi schema tanpa mengirim ke provider.
3. Implementasikan delivery layer provider terisolasi beserta test mock dan secret/session handling; jangan menempatkan network call di transaksi payment.
4. Implementasikan bukti pembelian setelah payment commit, lalu verifikasi idempotency/retry.
5. Implementasikan reminder H-36 dengan satu claim delivery per penerima/channel, time boundary dan recovery tests.
6. Implementasikan PIC QR scan dengan event assignment authorization dan tests untuk PIC lain/unassigned/revoked/double scan.
7. Implementasikan document upload/access/blast pada PIC dashboard, dengan private file access dan recipient authorization; lalu tes isolasi dan redaction PII.
8. Jalankan isolated Jest, lint/typecheck, Prisma validation, production build setelah strategi `.next` disetujui, dan verifikasi migration status di target non-production yang disetujui.

Urutan 4–7 dapat disesuaikan owner, tetapi database, idempotency, security policy, serta isolation test harus mendahului blast eksternal.

## 12. File-level implementation impact (perkiraan, bukan perubahan audit)

- `prisma/schema.prisma`, migration baru, model `Notification`/`NotificationDelivery`, mungkin dokumen event dan indeks delivery idempotency.
- `lib/jobs/lock.ts`, `lib/jobs/tick.ts`, `app/api/internal/jobs/tick/route.ts`, dan tes jobs untuk reminder scheduler.
- Modul baru/terpisah untuk adapter WhatsApp Baileys dan email Nodemailer; config/session storage/runtime deployment, env template dan dokumentasi operasional.
- Payment/order flow di `lib/ticketing/payment/settlement.ts`, webhook dan/atau `lib/ticketing/tickets/issuance.ts` hanya untuk enqueue side-effect setelah commit—hindari pemanggilan provider dari transaction.
- `lib/authz/permissions.ts`, `lib/pic/self-service.ts`, `lib/ticketing/checkin/service.ts`, route `/api/organizer/events/[id]/check-in` (atau endpoint scope PIC khusus), serta PIC dashboard/scanner UI.
- Event documentation route/service, `components/organizer/EventDocumentationManager.tsx` atau UI PIC, private upload/view route, validasi, akses file dan blast target query.
- Jest tests di `__tests__/jobs`, `__tests__/ticketing-payment`, `__tests__/ticketing-checkin`, authz/tenant isolation, serta test baru untuk notification delivery. Perbaiki dahulu `__tests__/support/fixture-teardown.ts`/`jest.config.js` di fase yang diizinkan.

## 13. Final decision

# NO-GO untuk pengiriman fitur blast pada keadaan saat ini.

Alasan penentu: (1) dua critical dan 13 high advisories pada dependency graph; (2) application DB tertinggal migration; (3) Jest teardown menulis ke application DB sehingga regresi tidak dapat diklaim terisolasi; (4) tidak ada outbound sender/runtime, dan Baileys memerlukan runtime persisten yang belum ditetapkan; (5) PIC check-in authorization dan private post-event document access belum terhubung.

Setelah blocker 1–3 dan keputusan runtime/security dibereskan dengan persetujuan owner, status dapat ditinjau kembali menjadi **CONDITIONAL GO**. Komponen transaksi ticket/payment dan check-in yang sudah ada memberi fondasi yang dapat digunakan, tetapi bukan bukti bahwa fitur baru aman tanpa tambahan outbox, authorization, migration, dan tes.

---

**Audit berhenti di sini sesuai instruksi. Tidak ada implementasi atau perbaikan yang dilakukan; menunggu persetujuan owner untuk fase berikutnya.**
