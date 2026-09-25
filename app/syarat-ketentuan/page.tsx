import type { Metadata } from "next";
import Link from "next/link";
import SiteShell from "@/components/ticketing/SiteShell";
import { getPublicStoreSetting } from "@/lib/store-settings";

export const metadata: Metadata = {
    title: "Syarat & Ketentuan",
    description:
        "Syarat dan ketentuan penggunaan layanan dan pembelian tiket di TinggalKlik.Co. Baca dengan seksama sebelum melakukan transaksi.",
    openGraph: {
        title: "Syarat & Ketentuan",
        description:
            "Syarat dan ketentuan penggunaan layanan dan pembelian tiket di TinggalKlik.Co.",
    },
};

const PLATFORM_NAME = "TinggalKlik.Co";

export default async function SyaratKetentuanPage() {
    const setting = await getPublicStoreSetting();

    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        Syarat &amp; Ketentuan
                    </h1>
                    <p className="mt-2 text-sm text-ink-500">
                        Terakhir diperbarui:{" "}
                        {new Date().toLocaleDateString("id-ID", {
                            day: "numeric",
                            month: "long",
                            year: "numeric",
                        })}
                    </p>
                </div>
            </div>

            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
                <div className="space-y-8">
                    {/* 1. KETENTUAN UMUM */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            1. Ketentuan Umum
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Syarat dan ketentuan ini berlaku untuk seluruh
                                pengguna layanan dan pembelian tiket di website
                                ini. Dengan mengakses atau menggunakan layanan
                                kami, Anda setuju untuk terikat dengan syarat
                                dan ketentuan ini.
                            </p>

                            <p>
                                Kami berhak untuk mengubah syarat dan ketentuan
                                ini sewaktu-waktu tanpa pemberitahuan terlebih
                                dahulu. Perubahan akan berlaku segera setelah
                                dipublikasikan di halaman ini.
                            </p>
                        </div>
                    </section>

                    {/* 2. DEFINISI */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            2. Definisi
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                <strong>&quot;Kami&quot;</strong> merujuk pada{" "}
                                {PLATFORM_NAME} selaku penyedia layanan
                                penjualan tiket dan pengelola website ini.
                            </p>

                            <p>
                                <strong>&quot;Penyelenggara&quot;</strong>{" "}
                                merujuk pada pihak yang membuat, mengelola, dan
                                menyelenggarakan event di platform kami.
                            </p>

                            <p>
                                <strong>&quot;Anda&quot;/&quot;Customer&quot;</strong>{" "}
                                merujuk pada setiap individu atau badan hukum
                                yang mengakses atau menggunakan layanan kami.
                            </p>

                            <p>
                                <strong>&quot;Event&quot;</strong> merujuk pada
                                kegiatan atau pertandingan yang tiketnya
                                dijual melalui website ini.
                            </p>

                            <p>
                                <strong>&quot;Tiket&quot;</strong> merujuk pada
                                hak masuk ke suatu event yang diperoleh dari
                                pesanan yang sudah dibayar, ditampilkan sebagai
                                e-tiket dengan kode dan QR.
                            </p>

                            <p>
                                <strong>&quot;Pesanan&quot;</strong> merujuk
                                pada transaksi pembelian tiket yang dilakukan
                                melalui website ini.
                            </p>
                        </div>
                    </section>

                    {/* 3. AKUN CUSTOMER */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            3. Akun Customer
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Untuk membeli tiket, Anda diwajibkan membuat
                                akun dengan informasi yang benar dan lengkap.
                                Anda bertanggung jawab untuk menjaga
                                kerahasiaan akun dan kata sandi Anda.
                            </p>

                            <p>
                                Anda tidak diperkenankan menggunakan akun orang
                                lain tanpa izin. Kami berhak menangguhkan atau
                                menghapus akun jika ditemukan aktivitas yang
                                mencurigakan atau melanggar ketentuan ini.
                            </p>
                        </div>
                    </section>

                    {/* 4. EVENT DAN INFORMASI EVENT */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            4. Event dan Informasi Event
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Setiap event menampilkan informasi jadwal,
                                lokasi/venue, jenis tiket, harga, dan kuota.
                                Informasi tersebut disediakan oleh penyelenggara
                                event dan kami berusaha menampilkannya seakurat
                                mungkin.
                            </p>

                            <p>
                                Ketersediaan tiket mengikuti kuota event dan
                                dapat berubah sewaktu-waktu tanpa pemberitahuan
                                terlebih dahulu.
                            </p>
                        </div>
                    </section>

                    {/* 5. HARGA DAN PEMBAYARAN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            5. Harga dan Pembayaran
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Semua harga tiket tercantum dalam Rupiah (IDR)
                                sesuai jenis tiket pada masing-masing event.
                            </p>

                            <p>
                                Pembayaran dilakukan melalui metode yang
                                tersedia pada halaman pembayaran pesanan, antara
                                lain QRIS atau Virtual Account.
                            </p>

                            <p>
                                Pesanan dianggap sah setelah pembayaran berhasil
                                dikonfirmasi lunas. Pesanan yang tidak dibayar
                                dalam waktu yang berlaku akan berstatus
                                kedaluwarsa.
                            </p>
                        </div>
                    </section>

                    {/* 6. PESANAN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            6. Pesanan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Pesanan dianggap sah setelah Anda melakukan
                                pembayaran dan pembayaran berhasil dikonfirmasi
                                oleh sistem. Setelah lunas, e-tiket akan
                                tersedia di halaman Tiket saya.
                            </p>

                            <p>
                                Pesanan yang masih berstatus Menunggu pembayaran
                                dapat dibatalkan dari halaman detail pesanan.
                                Kami berhak menolak atau membatalkan pesanan
                                jika ditemukan indikasi penipuan atau masalah
                                lain yang terkait dengan pesanan tersebut.
                            </p>
                        </div>
                    </section>

                    {/* 7. E-TIKET DAN CHECK-IN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            7. E-Tiket dan Check-in
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Setiap tiket yang diterbitkan terdiri atas kode
                                tiket dan QR yang dapat ditampilkan dari halaman
                                e-tiket. Di lokasi event, petugas akan
                                memverifikasi QR atau kode tiket Anda pada saat
                                check-in.
                            </p>

                            <p>
                                Tiket yang sudah dilakukan check-in dinyatakan
                                telah digunakan dan tidak dapat dikembalikan
                                (refund).
                            </p>
                        </div>
                    </section>

                    {/* 8. PEMBATALAN EVENT */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            8. Pembatalan Event
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Penyelenggara dapat membatalkan event yang
                                dikelolanya. Ketika event dibatalkan, penjualan
                                tiket event tersebut dihentikan.
                            </p>

                            <p>
                                Untuk pesanan event yang sudah dibayar lunas,
                                pengembalian dana dapat diajukan sesuai dengan
                                Kebijakan Pengembalian Dana di halaman{" "}
                                <Link
                                    href="/refund-policy"
                                    className="font-medium text-brand-700 hover:underline"
                                >
                                    Kebijakan Refund
                                </Link>
                                .
                            </p>
                        </div>
                    </section>

                    {/* 9. PENGEMBALIAN DANA (REFUND) */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            9. Pengembalian Dana (Refund)
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Pengembalian dana dapat diajukan untuk tiket
                                pada pesanan yang sudah dibayar lunas, selama
                                tiket masih aktif (belum check-in) dan belum
                                pernah direfund. Jumlah yang dikembalikan
                                mengikuti harga tiket saat pembelian dan
                                ketentuan yang berlaku.
                            </p>

                            <p>
                                Untuk informasi lebih lengkap, silakan kunjungi{" "}
                                <Link
                                    href="/refund-policy"
                                    className="font-medium text-brand-700 hover:underline"
                                >
                                    Kebijakan Refund
                                </Link>{" "}
                                kami.
                            </p>
                        </div>
                    </section>

                    {/* 10. KUOTA DAN KETERSEDIAAN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            10. Kuota dan Ketersediaan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Jumlah tiket yang dijual untuk setiap event
                                mengikuti kuota per jenis tiket yang ditetapkan
                                penyelenggara. Tiket tersedia selama kuota
                                masih ada.
                            </p>

                            <p>
                                Pembuatan pesanan menahan kuota yang dipilih
                                sampai pembayaran diselesaikan atau pesanan
                                berstatus kedaluwarsa. Kuota yang tidak
                                diselesaikan pembayarannya akan kembali tersedia
                                setelah pesanan berakhir.
                            </p>
                        </div>
                    </section>

                    {/* 11. HAK DAN KEWAJIBAN PENGGUNA */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            11. Hak dan Kewajiban Pengguna
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                <strong>Hak Anda:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Mendapatkan tiket sesuai dengan pesanan yang
                                    sudah dibayar
                                </li>

                                <li>
                                    Menampilkan e-tiket dan melakukan check-in
                                    sesuai ketentuan event
                                </li>

                                <li>
                                    Mengajukan pengembalian dana sesuai ketentuan
                                    yang berlaku
                                </li>

                                <li>
                                    Melindungi data pribadi sesuai kebijakan
                                    privasi kami
                                </li>
                            </ul>

                            <p className="mt-3">
                                <strong>Kewajiban Anda:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Memberikan informasi yang benar dan lengkap
                                    saat membuat akun dan melakukan pemesanan
                                </li>

                                <li>
                                    Melakukan pembayaran sesuai dengan total
                                    pesanan
                                </li>

                                <li>
                                    Menunjukkan e-tiket yang valid pada saat
                                    check-in
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 12. HAK DAN KEWAJIBAN KAMI */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            12. Hak dan Kewajiban Kami
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                <strong>Hak Kami:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Menolak atau membatalkan pesanan yang
                                    mencurigakan
                                </li>

                                <li>
                                    Mengubah syarat dan ketentuan sewaktu-waktu
                                </li>
                            </ul>

                            <p className="mt-3">
                                <strong>Kewajiban Kami:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Menyediakan layanan penjualan tiket dan
                                    penerbitan e-tiket sesuai fungsi yang ada di
                                    platform
                                </li>

                                <li>
                                    Menampilkan informasi event secara wajar
                                    sesuai data yang disediakan penyelenggara
                                </li>

                                <li>
                                    Meninjau pengajuan refund sesuai Kebijakan
                                    Refund yang berlaku
                                </li>

                                <li>Melindungi data pribadi customer</li>
                            </ul>
                        </div>
                    </section>

                    {/* 13. PERUBAHAN KETENTUAN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            13. Perubahan Ketentuan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Kami berhak mengubah syarat dan ketentuan ini
                                sewaktu-waktu. Perubahan akan berlaku segera
                                setelah dipublikasikan di halaman ini.
                                Penggunaan layanan kami setelah perubahan
                                dipublikasikan dianggap sebagai persetujuan Anda
                                terhadap perubahan tersebut.
                            </p>
                        </div>
                    </section>

                    {/* 14. KONTAK */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            14. Kontak
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Jika Anda memiliki pertanyaan mengenai syarat
                                dan ketentuan ini, silakan hubungi kami melalui:
                            </p>

                            <ul className="space-y-1 pl-2">
                                <li>
                                    <span className="font-semibold text-ink-900">
                                        Email:
                                    </span>{" "}
                                    {setting.email || (
                                        <span className="text-ink-400">
                                            Belum tersedia
                                        </span>
                                    )}
                                </li>

                                <li>
                                    <span className="font-semibold text-ink-900">
                                        Telepon:
                                    </span>{" "}
                                    {setting.phone || (
                                        <span className="text-ink-400">
                                            Belum tersedia
                                        </span>
                                    )}
                                </li>
                            </ul>

                            <p>
                                Atau kunjungi halaman{" "}
                                <Link
                                    href="/kontak"
                                    className="font-medium text-brand-700 hover:underline"
                                >
                                    Kontak Kami
                                </Link>{" "}
                                untuk informasi lebih lanjut.
                            </p>
                        </div>
                    </section>
                </div>
            </div>
        </SiteShell>
    );
}