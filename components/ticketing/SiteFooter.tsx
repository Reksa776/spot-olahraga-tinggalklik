import Link from "next/link";

import Brand from "./Brand";

const EXPLORE = [
    { href: "/events", label: "Semua event" },
    { href: "/events#cabang-olahraga", label: "Cabang olahraga" },
    { href: "/ticketing/tickets", label: "Tiket saya" },
];

const HELP = [
    { href: "/faq", label: "Pertanyaan umum" },
    { href: "/kontak", label: "Hubungi kami" },
    { href: "/refund-policy", label: "Kebijakan pengembalian" },
    { href: "/syarat-ketentuan", label: "Syarat & ketentuan" },
];

const ORGANIZER = [
    { href: "/dashboard/events", label: "Dasbor event" },
    { href: "/dashboard/venues", label: "Kelola venue" },
    { href: "/register", label: "Daftar akun" },
];

/**
 * The footer for the ticketing surface.
 *
 * Scoped to ticketing pages rather than added to `app/layout.tsx`: the retail storefront under
 * `/products`, `/cart`, `/checkout` and `/orders` is live and its own `Footer` is untouched
 * (brief: legacy safety). Every link here points at a page that exists — a footer of dead links
 * is how a "coming soon" platform reads.
 */
export default function SiteFooter() {
    return (
        <footer className="mt-16 bg-ink-950 text-ink-300">
            <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
                <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="sm:col-span-2 lg:col-span-1">
                        <Brand tone="light" />
                        <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-400">
                            Temukan event olahraga dan pertandingan di seluruh
                            Indonesia, lalu simpan e-tiket Anda di satu tempat.
                        </p>
                    </div>

                    <FooterColumn title="Jelajahi" links={EXPLORE} />
                    <FooterColumn title="Bantuan" links={HELP} />
                    <FooterColumn title="Penyelenggara" links={ORGANIZER} />
                </div>

                <div className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-ink-500 sm:flex-row sm:items-center sm:justify-between">
                    <p>
                        &copy; {new Date().getFullYear()} TinggalKlik.Co. Seluruh
                        hak dilindungi.
                    </p>
                    <p>Harga dalam Rupiah (IDR).</p>
                </div>
            </div>
        </footer>
    );
}

function FooterColumn({
    title,
    links,
}: {
    title: string;
    links: { href: string; label: string }[];
}) {
    return (
        <nav aria-label={title}>
            <h2 className="text-xs font-bold tracking-wider text-white uppercase">
                {title}
            </h2>
            <ul className="mt-4 space-y-2.5">
                {links.map((link) => (
                    <li key={link.href}>
                        <Link
                            href={link.href}
                            className="rounded text-sm text-ink-400 transition hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400"
                        >
                            {link.label}
                        </Link>
                    </li>
                ))}
            </ul>
        </nav>
    );
}
