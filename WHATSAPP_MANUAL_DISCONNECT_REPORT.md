=== MULAI REPORT ===

# WhatsApp Manual Disconnect — Implementation Report

Tanggal: 9 November 2026
Repo: TinggalKlik (Next.js 16 + Prisma + Baileys)

## Ringkasan

Fitur disconnect WhatsApp yang idempoten sudah diimplementasikan:

- `POST /api/admin/settings/whatsapp/disconnect`
- status lock/session di `GET /api/admin/settings/whatsapp/status`
- latch manual disconnect yang bertahan setelah restart
- pelepasan DB lease (`JobLock` name `whatsapp-gateway`) dan file lock `.gateway.lock`
- penghapusan isi session yang fail-closed dan hanya jika `deleteSession=true`
- worker menandai delivery WhatsApp `SKIPPED` dengan alasan `gateway_disconnected_manual`
- UI konfirmasi, checkbox hapus session, status DISCONNECTED, dan tombol “Hubungkan ulang”
- audit `whatsapp.disconnect`

Logika checkout, payment, authz, dan email tidak diubah. Satu-satunya perubahan pada alur email adalah tidak ada; worker email tetap berjalan seperti sebelumnya.

## File yang Diubah / Ditambah

### Schema dan migration
- `prisma/schema.prisma` — field additive `PlatformSetting.whatsappManualDisconnect Boolean @default(false)`.
- `prisma/migrations/20261109000000_add_whatsapp_manual_disconnect/migration.sql` — `ALTER TABLE platformsetting ADD COLUMN ... DEFAULT false`.

### WhatsApp gateway
- `lib/whatsapp/gateway/gateway.ts` — `disconnect()`, `resume()`, `beginPairing()` yang bisa reacquire ownership, guard `connect`/`scheduleReconnect`/`dispatchText`, socket close dengan timeout 5 detik, snapshot `manualDisconnect`.
- `lib/whatsapp/gateway/web-runtime.ts` — membaca latch DB sebelum membuat gateway, sehingga proses yang restart tetap tidak membuka socket.
- `lib/whatsapp/gateway/lifecycle.ts` — transisi `STOPPED → DISCONNECTED`, `ERROR → STARTING/DISCONNECTED`, dan `CONFLICT → STARTING` untuk retry pairing eksplisit setelah proses pesaing dihentikan.
- `lib/whatsapp/gateway/protocol.ts` — `GatewaySnapshot.manualDisconnect`.
- `lib/whatsapp/gateway/local-lock.ts` — `readLocalProcessLock()` read-only untuk inspeksi lock.
- `lib/whatsapp/gateway/lock-inspection.ts` (baru) — menggabungkan local lock dan DB lease menjadi `{ pid, host, startedAt, ownerId, source }`.
- `lib/whatsapp/gateway/session-cleanup.ts` (baru) — validasi path, tolak root/symlink/traversal, pertahankan `.gateway.lock`, jangan hapus direktori session itu sendiri.
- `lib/whatsapp/gateway/disconnect-service.ts` (baru) — urutan latch → socket close → release lock → inspeksi ulang → hapus session (opsional) → audit.
- `lib/whatsapp/gateway/status.ts` (baru) — payload status bersama, termasuk `sessionExists`, `manualDisconnect`, dan `lockHolder`.
- `lib/whatsapp/manual-disconnect.ts` (baru) — baca/tulis latch dan konstanta SKIPPED.
- `lib/whatsapp/gateway/retry-policy.ts` — komentar klasifikasi `GATEWAY_DISCONNECTED` sebagai transient; tidak ada jalur retry baru.
- `lib/notifications/worker.ts` — cek latch sebelum batch WhatsApp; claim lalu `markDeliverySkipped` terminal; daily cap tidak dihitung saat manual; email tidak disentuh.
- `lib/ticketing/audit-log.ts` — action `whatsapp.disconnect`.

### API
- `app/api/admin/settings/whatsapp/disconnect/route.ts` (baru) — `requireSameOrigin`, permission `PERMISSIONS.APPLICATION_SETTINGS`, Zod `{ deleteSession?: boolean, reason?: max 200 }`, 200/409, audit.
- `app/api/admin/settings/whatsapp/status/route.ts` (baru) — GET status.
- `app/api/admin/settings/whatsapp/route.ts` — memakai payload status bersama.
- `app/api/admin/settings/whatsapp/pairing/route.ts` — menghapus latch sebelum pairing, mengembalikannya jika flow gagal/konflik, dan memakai `beginPairing()` untuk reacquire ownership.

### UI
- `components/dashboard/WhatsAppSettingsPanel.tsx` — tombol destructive “Putuskan koneksi”, dialog konfirmasi, checkbox “Hapus session (perlu scan QR baru)”, status DISCONNECTED (manual), tombol “Hubungkan ulang”, pesan 409 dari server, dan pesan error di dalam dialog agar 409 terlihat.

### Test
- `__tests__/whatsapp-gateway/disconnect-route.test.ts` (baru) — authz 403, idempoten 200, 409 + lockHolder, reason > 200 ditolak.
- `__tests__/whatsapp-gateway/disconnect-session.test.ts` (baru) — idempoten, lock held, lock muncul lagi, traversal ditolak, root tidak dihapus, `.gateway.lock` dipertahankan, socket timeout menolak deleteSession.
- `__tests__/notifications/manual-disconnect-worker.test.ts` (baru) — WhatsApp SKIPPED `gateway_disconnected_manual`, email tetap terkirim, daily cap tidak dipanggil.
- `__tests__/whatsapp-gateway/server.test.ts` — snapshot fixture ditambah `manualDisconnect: false`.
- `__tests__/notifications/retry-policy.test.ts` — `GATEWAY_DISCONNECTED` masuk daftar transient.

## Pilihan Persistensi Flag

Dipilih **kolom `PlatformSetting.whatsappManualDisconnect`**, bukan file sentinel `.manual-disconnect`.

Alasan:

1. `PlatformSetting` sudah menjadi tempat kontrol aplikasi (maintenance, branding), jadi latch berada di lapisan yang sama dengan config platform.
2. Web dan notification worker membaca database yang sama. File sentinel hanya benar jika keduanya dijamin memakai `WA_AUTH_DIR` yang sama; kontraknya tidak terlihat dari kode.
3. `deleteSession=true` menghapus isi `WA_AUTH_DIR`. Sentinel di dalam direktori itu harus dispesialkan agar tidak ikut terhapus; kolom database tidak punya masalah tersebut.
4. Migration bersifat additive dan default `false`, sehingga deployment lama tetap dapat connect sampai operator memutuskan koneksi.

Konsekuensi: `npx prisma generate` wajib dijalankan setelah migration. Ini adalah langkah deployment normal untuk perubahan schema Prisma.

## Perilaku Disconnect

Urutan:

1. Tulis latch `true`. Jika proses mati setelah ini, restart tetap tidak membuka socket.
2. `gateway.disconnect()`:
   - set `manualDisconnect` in-memory dan batalkan reconnect timer;
   - jika proses ini tidak memiliki ownership, inspeksi lock. Jika lock dipegang proses lain, kembalikan `LOCK_HELD` tanpa mencuri lock;
   - tutup socket dengan timeout 5 detik;
   - lepas DB lease lalu local lock.
3. Inspeksi lock sekali lagi. Jika masih ada holder, return 409.
4. Jika `deleteSession=true` dan socket terbukti tertutup, hapus isi direktori session.
5. Tulis audit `whatsapp.disconnect` dengan `{ deleteSession, deletedSession, socketClosed, alreadyDisconnected, reason }`.

Idempoten: jika tidak ada socket/lock, hasilnya 200 `{ status: "DISCONNECTED", deletedSession: false, alreadyDisconnected: true }`.

Fail-closed:

- socket close timeout + `deleteSession=true` → 503, session tidak dihapus;
- lock masih ada → 409, session tidak dihapus;
- path root, symlink, traversal, atau entry bukan basename → error, tidak menghapus root;
- semua entry divalidasi sebelum entry pertama dihapus;
- `.gateway.lock` tidak dihapus oleh cleanup;
- direktori `WA_AUTH_DIR` tidak pernah dihapus.

## Worker

Saat latch manual aktif:

- worker tetap meng-claim baris WhatsApp agar keluar dari `QUEUED`;
- setiap baris ditandai `SKIPPED` dengan `errorCode = gateway_disconnected_manual`;
- tidak ada render template, tidak ada pemanggilan transport, tidak ada penambahan daily cap;
- email diproses lebih dulu dan tidak berubah.

`GATEWAY_DISCONNECTED` tetap transient di retry-policy untuk jalur dispatch non-manual (misalnya gateway belum siap), tetapi worker manual tidak melakukan retry karena baris langsung `SKIPPED`.

## UI

- Tombol “Putuskan koneksi” hanya tampil saat connected.
- Dialog memakai komponen `Dialog` Radix yang sudah ada. Repo tidak memiliki `AlertDialog`, jadi tidak ada dependency baru.
- Checkbox memakai `Checkbox` dari `components/dashboard/ui/select.tsx`.
- 409 dari server ditampilkan persis, termasuk `pm2 stop tinggalklik-worker`, dan juga dirender di dalam dialog.
- Setelah sukses, status lokal langsung DISCONNECTED dan tombol berubah menjadi “Hubungkan ulang”.
- “Hubungkan ulang” memanggil route pairing existing; route menghapus latch dan memulai QR/ownership flow.

## Verifikasi

### Status: TIDAK DAPAT DIJALANKAN

Semua perintah verifikasi yang diwajibkan gagal dijalankan karena terminal broker Freebuff tidak bisa di-spawn. Ini bukan hasil test; tidak ada klaim lulus.

Error yang berulang:

```text
Terminal command broker failed: ENOENT: no such file or directory,
posix_spawn '/home/reksa/.config/manicode/freebuff'

Restart Freebuff and try again.
```

Pencarian kode juga tidak tersedia:

```text
Failed to execute ripgrep: ENOENT: no such file or directory,
posix_spawn '/home/reksa/.config/manicode/rg'
```

Perintah yang belum dijalankan:

```bash
npx prisma generate
npx tsc --noEmit
npm run build
```

Test yang belum dijalankan:

```bash
npx jest --runInBand \
  __tests__/whatsapp-gateway/disconnect-route.test.ts \
  __tests__/whatsapp-gateway/disconnect-session.test.ts \
  __tests__/notifications/manual-disconnect-worker.test.ts \
  __tests__/notifications/whatsapp-media.test.ts \
  __tests__/notifications/retry-policy.test.ts \
  __tests__/pic-self-service/menu.test.ts
```

Jumlah test lulus **tidak dapat dilaporkan** karena Jest tidak pernah dieksekusi. Yang sudah dilakukan adalah review statis seluruh file yang diubah, termasuk signature `validationError`, `AppError`, `writeTicketingAudit`, `markDeliverySkipped`, `GatewaySnapshot`, dan prop `Checkbox`.

### Perintah yang harus dijalankan setelah Freebuff direstart

```bash
npx prisma generate
npx tsc --noEmit
npm run build
```

Lalu test terisolasi (tanpa `TEST_DATABASE_URL`, dengan konfigurasi Jest inline yang tidak memuat `setupFiles`/`globalSetup`):

```bash
npx jest --runInBand \
  __tests__/whatsapp-gateway/disconnect-route.test.ts \
  __tests__/whatsapp-gateway/disconnect-session.test.ts \
  __tests__/notifications/manual-disconnect-worker.test.ts \
  __tests__/notifications/retry-policy.test.ts
```

Jalankan juga test existing `whatsapp-media` dan `pic-self-service/menu` sesuai path repo.

## Verifikasi Manual (pm2)

1. Deploy migration dan generate client:
   ```bash
   npx prisma migrate deploy
   npx prisma generate
   npm run build
   pm2 restart tinggalklik tinggalklik-worker
   ```
2. Buka `/dashboard/settings/whatsapp`.
3. Pastikan status connected dan tombol “Putuskan koneksi” tampil.
4. Klik tombol, konfirmasi tanpa checkbox. Hasil yang diharapkan:
   - status menjadi `DISCONNECTED (manual)`;
   - tombol berubah menjadi “Hubungkan ulang”;
   - `GET /api/admin/settings/whatsapp/status` mengembalikan `manualDisconnect: true`, `connected: false`;
   - socket lama tertutup dan `.gateway.lock` hilang.
5. Ulangi dengan checkbox “Hapus session”. Hasil:
   - isi `WA_AUTH_DIR` terhapus;
   - folder `WA_AUTH_DIR` sendiri tetap ada;
   - `sessionExists: false`;
   - pairing berikutnya menampilkan QR baru.
6. Uji 409: jalankan proses gateway/web kedua yang memakai `WA_AUTH_DIR` dan database yang sama, lalu klik disconnect dari proses pertama. Hasil yang diharapkan: HTTP 409 dan pesan persis berisi `pm2 stop tinggalklik-worker`.
7. Hentikan proses pesaing:
   ```bash
   pm2 stop tinggalklik-worker
   pm2 list
   ```
   Jika lock masih ada, pastikan tidak ada proses gateway lain; baru pertimbangkan menghapus `.gateway.lock` secara manual setelah yakin tidak ada proses hidup.
8. Klik “Hubungkan ulang”, scan QR. Pastikan status kembali CONNECTED dan `manualDisconnect: false`.
9. Uji worker: saat manual, enqueue notifikasi WhatsApp. Periksa `NotificationDelivery`:
   - `status = SKIPPED`;
   - `errorCode = gateway_disconnected_manual`;
   - tidak ada retry.
   Enqueue email pada batch yang sama dan pastikan email tetap terkirim.

## Rollback

1. Revert file aplikasi:
   ```bash
   git revert <commit-hash>
   ```
   atau restore file yang tercantum di atas.
2. Hentikan web dan worker:
   ```bash
   pm2 stop tinggalklik tinggalklik-worker
   ```
3. Jalankan `npx prisma generate` dan `npm run build` setelah revert.
4. Kolom `whatsappManualDisconnect` bersifat additive dan aman ditinggalkan. Jika benar-benar harus dihapus, buat migration baru:
   ```sql
   ALTER TABLE platformsetting DROP COLUMN whatsappManualDisconnect;
   ```
   Jangan jalankan `DROP COLUMN` sebelum kode lama benar-benar tidak membaca kolom tersebut.
5. Jika rollback dilakukan saat latch masih `true`, kode lama mengabaikan kolom tersebut. Untuk membersihkan latch sebelum kembali ke versi baru:
   ```sql
   UPDATE platformsetting SET whatsappManualDisconnect = false WHERE id = 1;
   ```
6. Nyalakan kembali:
   ```bash
   pm2 start tinggalklik tinggalklik-worker
   ```

## Deviasi / Catatan

- `AlertDialog` tidak ada di repo; dialog memakai `Dialog` Radix existing.
- `Aside` tidak relevan; tidak ada perubahan checkout/payment/authz/email.
- `prisma generate` belum dijalankan karena broker terminal gagal. Tanpa langkah ini, TypeScript akan melihat client Prisma lama dan field baru belum dikenal.
- Angka test lulus tidak dapat diberikan karena Jest tidak dapat dieksekusi pada sesi ini.

=== AKHIR REPORT ===
