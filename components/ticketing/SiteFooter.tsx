import Link from "next/link";

import Reveal, { revealDelay } from "@/components/ui/Reveal";
import { getApplicationBranding } from "@/lib/app-settings";

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

/*
 * ==========================================
 * THE FOOTER'S STAGGER, IN STEPS
 * ==========================================
 *
 * The footer is the one place where the ORDER of arrival is a narrative rather than a flourish:
 * the block itself, then the brand and its line, then the three link columns left to right, then the
 * small print. Steps are named here — not milliseconds — so the sequence lives in one place and
 * cannot be flattened by editing a single call site.
 *
 * `revealDelay` still caps the value, so the bottom bar can never drift far behind the columns.
 */
const BRAND_STEP = 0;
const FIRST_COLUMN_STEP = 1;
const BOTTOM_BAR_STEP = 4;

/**
 * The footer for the ticketing surface.
 *
 * Scoped to ticketing pages rather than added to `app/layout.tsx`: the retail storefront under
 * `/products`, `/cart`, `/checkout` and `/orders` is live and its own `Footer` is untouched
 * (brief: legacy safety). Every link here points at a page that exists — a footer of dead links
 * is how a "coming soon" platform reads.
 *
 * PHASE 32: it renders the CONFIGURED logo (`PlatformSetting.logoUrl`) through the shared
 * lockup, so the footer, the header and the dashboard cannot disagree about the brand. The
 * read is request-cached, so a page that already loaded it pays nothing for this one.
 *
 * ── THE QUIET END OF THE MOTION RANGE ───────────────────────────────────────────
 * Every part of the footer uses the `quiet` step: an 8px rise (6px on the narrower viewports) and
 * the least movement anywhere on the page, whatever the order of arrival. Intensity therefore falls
 * off toward the bottom instead of every block landing with the same force — the footer is the last
 * thing a visitor reads, not the last thing that should compete for attention.
 *
 * It is the ONE piece of chrome shared by every ticketing page, so the entrance is written once
 * here rather than duplicated per page; the pages that already reveal their own content simply get
 * a footer that settles with them.
 */
export default async function SiteFooter() {
    const branding = await getApplicationBranding();

    return (
        <Reveal as="footer" scroll variant="quiet" className="mt-16 bg-ink-950 text-ink-300">
            <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
                <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
                    {/*
                     * The reveal IS the grid item — it renders the same `div` the block already was
                     * (with the same span classes), so the layout is untouched and nothing extra
                     * exists between the grid and its content.
                     */}
                    <Reveal
                        scroll
                        variant="quiet"
                        delay={revealDelay(BRAND_STEP)}
                        className="sm:col-span-2 lg:col-span-1"
                    >
                        <Brand tone="light" logoSrc={branding.logoUrl} />
                        <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-400">
                            Temukan event olahraga dan pertandingan di seluruh
                            Indonesia, lalu simpan e-tiket Anda di satu tempat.
                        </p>
                    </Reveal>

                    <FooterColumn title="Jelajahi" links={EXPLORE} index={0} />
                    <FooterColumn title="Bantuan" links={HELP} index={1} />
                    <FooterColumn title="Penyelenggara" links={ORGANIZER} index={2} />
                </div>

                {/*
                 * The small print arrives last. It has a border-top, so revealing it as one block
                 * keeps the rule, the copyright and the currency note in step — a rule that appears
                 * before the text it separates would be the one genuinely broken-looking frame.
                 */}
                <Reveal
                    scroll
                    variant="quiet"
                    delay={revealDelay(BOTTOM_BAR_STEP)}
                    className="mt-12 flex flex-col gap-3 border-t border-white/10 pt-6 text-xs text-ink-500 sm:flex-row sm:items-center sm:justify-between"
                >
                    <p>
                        &copy; {new Date().getFullYear()} TinggalKlik.Co. Seluruh
                        hak dilindungi.
                    </p>
                    <p>Harga dalam Rupiah (IDR).</p>
                </Reveal>
            </div>
        </Reveal>
    );
}

function FooterColumn({
    title,
    links,
    index,
}: {
    title: string;
    links: { href: string; label: string }[];
    /** Position in the footer, so the three columns stagger in reading order. */
    index: number;
}) {
    return (
        /*
         * The COLUMN is the revealed unit — its heading, its rule and all of its links together —
         * not each anchor and not each list. A column of four links arriving one at a time would
         * read as a queue loading, and it would make the footer the busiest motion on the page,
         * which is the opposite of the intended rhythm. `as="nav"` keeps the landmark it already
         * was, and `aria-label` rides through to it, so nothing about the semantics changed.
         */
        <Reveal
            as="nav"
            scroll
            variant="quiet"
            delay={revealDelay(FIRST_COLUMN_STEP + index)}
            aria-label={title}
        >
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
        </Reveal>
    );
}
