import type { Metadata } from "next";
import Link from "next/link";
import SiteShell from "@/components/ticketing/SiteShell";
import { getPublicStoreSetting } from "@/lib/store-settings";

export const metadata: Metadata = {
    title: "Kebijakan Refund",
    description:
        "Kebijakan pengembalian dana (refund) untuk pembelian tiket di TinggalKlik.Co. Baca syarat, kondisi, dan prosedur pengajuan refund.",
    openGraph: {
        title: "Kebijakan Refund",
        description:
            "Kebijakan pengembalian dana (refund) untuk pembelian tiket di TinggalKlik.Co.",
    },
};

export default async function RefundPolicyPage() {
    const setting = await getPublicStoreSetting();

    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        Kebijakan Pengembalian Dana
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
                    {/* 1. KONDISI PENGAJUAN REFUND */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            1. Kondisi Pengajuan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Anda dapat mengajukan pengembalian dana
                                (refund) untuk tiket event yang sudah dibeli
                                apabila seluruh kondisi berikut terpenuhi:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Pesanan sudah dibayar lunas (status
                                    pembayaran Lunas)
                                </li>

                                <li>
                                    Tiket yang diajukan masih aktif (belum
                                    dilakukan check-in)
                                </li>

                                <li>
                                    Tiket belum pernah diajukan refund
                                    sebelumnya
                                </li>

                                <li>
                                    Pengajuan masih dalam batas waktu refund
                                    event, apabila penyelenggara menetapkan
                                    batas tersebut
                                </li>
                            </ul>

                            <p>
                                Jumlah yang dikembalikan mengikuti harga tiket
                                pada saat pembelian dan tidak melebihi sisa
                                nilai pesanan yang belum dikembalikan.
                            </p>
                        </div>
                    </section>

                    {/* 2. TIKET YANG DAPAT / TIDAK DAPAT DIREFUND */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            2. Tiket yang Dapat dan Tidak Dapat Direfund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                <strong>Dapat direfund:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Tiket aktif (belum check-in) pada pesanan
                                    yang sudah dibayar lunas
                                </li>

                                <li>
                                    Pengembalian sebagian tiket dari satu
                                    pesanan, selama tiket yang dipilih memenuhi
                                    syarat kelayakan
                                </li>
                            </ul>

                            <p className="mt-3">
                                <strong>Tidak dapat direfund:</strong>
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Tiket yang sudah dilakukan check-in di
                                    lokasi event
                                </li>

                                <li>
                                    Tiket yang sudah pernah direfund sebelumnya
                                </li>

                                <li>
                                    Pesanan yang belum dibayar atau tidak
                                    berstatus lunas
                                </li>

                                <li>
                                    Pengajuan yang melewati batas waktu refund
                                    yang ditetapkan penyelenggara
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 3. PROSEDUR PENGAJUAN REFUND */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            3. Prosedur Pengajuan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Untuk mengajukan refund, ikuti langkah-langkah
                                berikut:
                            </p>

                            <ol className="list-inside list-decimal space-y-2 pl-2">
                                <li>
                                    Masuk ke akun yang digunakan saat membeli
                                    tiket
                                </li>

                                <li>
                                    Buka halaman detail pesanan yang sudah
                                    dibayar, lalu tekan tombol{" "}
                                    <strong>Ajukan refund</strong>
                                </li>

                                <li>
                                    Sistem akan memeriksa kelayakan dan
                                    menghitung jumlah yang dikembalikan dari
                                    harga tiket saat pembelian
                                </li>

                                <li>
                                    Pengajuan tercatat dan dapat dipantau
                                    statusnya di halaman{" "}
                                    <strong>Refund saya</strong>
                                </li>
                            </ol>

                            <p>
                                Untuk pesanan yang sebagian tiketnya sudah
                                digunakan, hubungi bantuan melalui halaman{" "}
                                <Link
                                    href="/kontak"
                                    className="font-medium text-brand-700 hover:underline"
                                >
                                    Kontak
                                </Link>{" "}
                                dengan menyertakan nomor pesanan.
                            </p>
                        </div>
                    </section>

                    {/* 4. INFORMASI YANG DIPERLUKAN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            4. Informasi yang Diperlukan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Pengajuan berbasis akun: sistem mengenali
                                pembeli dari akun yang masuk, sehingga pastikan
                                Anda menggunakan akun pemilik pesanan. Informasi
                                yang melengkapi pengajuan:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>Nomor pesanan yang bersangkutan</li>

                                <li>
                                    Status pembayaran pesanan (harus sudah
                                    lunas)
                                </li>

                                <li>
                                    Alasan pengajuan, apabila tersedia pada
                                    proses pengajuan
                                </li>
                            </ul>
                        </div>
                    </section>

                    {/* 5. PROSES PEMERIKSAAN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            5. Proses Pemeriksaan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Setiap pengajuan ditinjau oleh pihak
                                penyelenggara event, yang dapat menyetujui atau
                                menolak pengajuan tersebut. Status pengajuan
                                yang dapat dilihat di halaman Refund saya:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>Menunggu tinjauan</li>

                                <li>Disetujui</li>

                                <li>Sedang diproses</li>

                                <li>Dana dikembalikan</li>

                                <li>Ditolak</li>

                                <li>Gagal</li>
                            </ul>

                            <p>
                                Pemeriksaan memakai aturan kelayakan yang sama
                                untuk semua pengajuan, termasuk status pembayaran
                                dan kondisi tiket yang diajukan.
                            </p>
                        </div>
                    </section>

                    {/* 6. ESTIMASI PROSES REFUND */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            6. Estimasi Proses Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Waktu pemrosesan refund ditentukan oleh pihak
                                penyelenggara event dan dapat berbeda antar
                                event. Kami tidak menjanjikan durasi tertentu;
                                setiap tahap dapat Anda pantau pada halaman
                                Refund saya.
                            </p>

                            <p>
                                Jika pengajuan tidak kunjung berkembang, Anda
                                dapat menghubungi bantuan melalui halaman{" "}
                                <Link
                                    href="/kontak"
                                    className="font-medium text-brand-700 hover:underline"
                                >
                                    Kontak
                                </Link>{" "}
                                dengan menyertakan nomor pesanan dan nomor
                                pengajuan refund.
                            </p>
                        </div>
                    </section>

                    {/* 7. METODE PENGEMBALIAN DANA */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            7. Metode Pengembalian Dana
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Setelah pengajuan disetujui dan tuntas diproses,
                                dana dikembalikan oleh pihak penyelenggara event
                                melalui{" "}
                                <strong>transfer bank</strong>. Pengembalian
                                dilakukan oleh penyelenggara secara manual; kami
                                tidak melakukan pengembalian otomatis ke kanal
                                pembayaran awal.
                            </p>

                            <p>
                                Pastikan informasi rekening yang Anda berikan
                                kepada penyelenggara sudah benar, karena
                                pengembalian dana dilakukan berdasarkan
                                informasi tersebut.
                            </p>
                        </div>
                    </section>

                    {/* 8. REFUND DITOLAK */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            8. Penolakan Refund
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Pengajuan refund dapat ditolak apabila salah
                                satu kondisi berikut berlaku:
                            </p>

                            <ul className="list-inside list-disc space-y-1 pl-2">
                                <li>
                                    Pesanan belum dibayar lunas pada saat
                                    pengajuan
                                </li>

                                <li>
                                    Tiket sudah dilakukan check-in atau tidak
                                    berstatus aktif
                                </li>

                                <li>
                                    Tiket sudah pernah direfund sebelumnya
                                </li>

                                <li>
                                    Pengajuan melewati batas waktu refund yang
                                    ditetapkan penyelenggara
                                </li>

                                <li>
                                    Jumlah pengajuan melebihi sisa nilai pesanan
                                    yang dapat dikembalikan
                                </li>
                            </ul>

                            <p>
                                Jika pengajuan ditolak, alasannya tercatat pada
                                status pengajuan di halaman Refund saya.
                            </p>
                        </div>
                    </section>

                    {/* 9. HUBUNGI BANTUAN */}
                    <section className="rounded-xl border border-ink-100 bg-white p-6">
                        <h2 className="text-lg font-bold text-ink-900">
                            9. Hubungi Bantuan
                        </h2>

                        <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                            <p>
                                Jika Anda memiliki pertanyaan atau ingin
                                mengajukan refund, silakan hubungi kami:
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