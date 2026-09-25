"use client";

import { useState } from "react";

type FaqItem = {
    question: string;
    answer: string;
};

const faqData: FaqItem[] = [
    {
        question: "Bagaimana cara membeli tiket?",
        answer:
            "Masuk ke akun Anda, pilih event yang tersedia di laman Event, lalu pilih jenis tiket dan jumlah yang diinginkan. Lanjutkan ke pembayaran melalui halaman pesanan. Setelah pembayaran dikonfirmasi lunas, e-tiket beserta QR-nya tersedia di halaman Tiket saya.",
    },
    {
        question: "Metode pembayaran apa saja yang tersedia?",
        answer:
            "Pembayaran dapat dilakukan melalui QRIS atau Virtual Account. Metode yang tersedia untuk pesanan Anda akan ditampilkan pada halaman pembayaran pesanan tersebut.",
    },
    {
        question: "Bagaimana cara mengetahui status pesanan dan pembayaran?",
        answer:
            "Status pesanan (Menunggu pembayaran, Sudah dibayar, Dibatalkan, Kedaluwarsa, atau Dana dikembalikan) beserta status pembayaran (Belum dibayar, Menunggu konfirmasi, Lunas, atau Gagal) dapat dilihat di halaman detail pesanan. Ketika pembayaran sudah Lunas, e-tiket tersedia di halaman Tiket saya.",
    },
    {
        question: "Bagaimana cara menggunakan e-tiket?",
        answer:
            "Buka halaman Tiket saya, lalu pilih tiket yang akan digunakan. Tunjukkan QR pada halaman e-tiket kepada petugas di pintu masuk untuk di-scan. Kode tiket yang tertera juga dapat disebutkan atau diketik sebagai alternatif.",
    },
    {
        question: "Apakah saya perlu akun untuk membeli tiket?",
        answer:
            "Ya. Pembelian tiket memerlukan akun yang masuk (login). Anda dapat mendaftar terlebih dahulu menggunakan email dan kata sandi di laman Daftar.",
    },
    {
        question: "Bisakah saya membatalkan pesanan?",
        answer:
            "Pesanan yang masih berstatus Menunggu pembayaran dapat dibatalkan melalui halaman detail pesanan. Pesanan yang sudah dibayar tidak dapat dibatalkan, tetapi Anda dapat mengajukan pengembalian dana sesuai Kebijakan Pengembalian Dana.",
    },
    {
        question: "Bagaimana cara mengajukan pengembalian dana (refund)?",
        answer:
            "Pengajuan refund dapat dilakukan dari halaman detail pesanan yang sudah dibayar lunas selama tiketnya masih aktif dan belum dilakukan check-in. Tekan tombol Ajukan refund pada halaman tersebut; sistem akan memeriksa kelayakan dan menghitung jumlah yang dikembalikan sesuai kebijakan. Perkembangan pengajuan dapat dipantau di halaman Refund saya.",
    },
    {
        question: "Berapa lama refund diproses?",
        answer:
            "Setiap pengajuan mengikuti alur status yang dapat dilihat di halaman Refund saya: Menunggu tinjauan, Disetujui, Sedang diproses, hingga Dana dikembalikan. Setelah disetujui, dana dikembalikan oleh pihak penyelenggara event melalui transfer bank. Jika pengajuan Anda tertunda, silakan hubungi bantuan melalui halaman Kontak.",
    },
    {
        question: "Apakah tiket yang sudah check-in bisa direfund?",
        answer:
            "Tidak. Tiket yang sudah dilakukan check-in tidak dapat dikembalikan. Tiket juga hanya dapat diajukan refund satu kali. Selengkapnya dapat dibaca pada Kebijakan Pengembalian Dana.",
    },
    {
        question: "Apa yang terjadi jika event dibatalkan penyelenggara?",
        answer:
            "Ketika event dibatalkan penyelenggara, penjualan tiket event tersebut dihentikan. Untuk pesanan yang sudah dibayar lunas, Anda dapat mengajukan pengembalian dana melalui halaman detail pesanan sesuai Kebijakan Pengembalian Dana.",
    },
    {
        question: "Bagaimana cara menghubungi bantuan?",
        answer:
            "Kunjungi halaman Kontak untuk melihat email dan nomor telepon yang tersedia. Cantumkan nomor pesanan Anda agar tim kami dapat membantu dengan lebih cepat.",
    },
];

function FaqAccordionItem({
    item,
    isOpen,
    onToggle,
}: {
    item: FaqItem;
    isOpen: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="rounded-xl border border-ink-100 bg-white">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left sm:px-6"
            >
                <span className="text-sm font-semibold text-ink-900 sm:text-base">
                    {item.question}
                </span>

                <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className={`h-4 w-4 shrink-0 text-ink-400 transition-transform duration-200 ${
                        isOpen ? "rotate-180" : ""
                    }`}
                >
                    <path d="m6 9 6 6 6-6" />
                </svg>
            </button>

            {isOpen && (
                <div className="border-t border-ink-100 px-5 pb-5 pt-4 sm:px-6">
                    <p className="text-sm leading-7 text-ink-600">
                        {item.answer}
                    </p>
                </div>
            )}
        </div>
    );
}

export default function FaqContent() {
    const [openIndex, setOpenIndex] = useState<number | null>(null);

    return (
        <div className="space-y-3">
            {faqData.map((item, index) => (
                <FaqAccordionItem
                    key={item.question}
                    item={item}
                    isOpen={openIndex === index}
                    onToggle={() =>
                        setOpenIndex(
                            openIndex === index ? null : index
                        )
                    }
                />
            ))}
        </div>
    );
}