import Link from "next/link";

import EmptyState from "@/components/ticketing/EmptyState";
import SiteShell from "@/components/ticketing/SiteShell";

/**
 * ==========================================
 * 404 — NOT FOUND
 * ==========================================
 *
 * The application's own 404, replacing Next.js's black-and-white default.
 *
 * ── WHY THIS FILE MATTERS BEYOND POLISH ─────────────────────────────────────────
 * During the Phase 23A audit, `notFound()` was the destination of every swallowed failure,
 * so the default Next.js 404 was the face of a database outage, a permission bug and a real
 * missing order alike. It is now reached ONLY when a resource genuinely does not exist or
 * is not the caller's to see — which means this page can afford to be calm and specific.
 *
 * ── WHY IT DOES NOT SAY "NOT FOUND" ─────────────────────────────────────────────
 * "404" and "Not Found" are the server's words. The brief asks for user-facing Indonesian,
 * and it also asks that this page never imply the user did something wrong. It offers the
 * two destinations that actually resolve: the catalog and the wallet.
 *
 * ── WHY IT OFFERS THE CATALOG AND NOT "TIKET SAYA" ──────────────────────────────
 * This page renders for anonymous visitors too (an unknown `/e/{slug}`), and `/ticketing`
 * sits behind the session gate. Offering the wallet here would be a link that bounces to a
 * login screen instead of doing what it says, so the two destinations offered are the ones
 * that resolve for everybody.
 */
export const dynamic = "force-dynamic";

export default function NotFound() {
    return (
        <SiteShell>
            <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6 lg:py-24">
                <p className="text-center font-mono text-xs font-bold tracking-widest text-ink-400 uppercase">
                    404
                </p>

                <div className="mt-6">
                    <EmptyState
                        kind="blocked"
                        title="Halaman atau data yang Anda cari tidak ditemukan"
                        description="Tautan mungkin sudah tidak berlaku, atau data ini bukan milik akun Anda. Periksa kembali alamatnya atau mulai dari katalog event."
                        action={{ href: "/events", label: "Lihat katalog event" }}
                        secondaryAction={{ href: "/", label: "Kembali ke beranda" }}
                    />
                </div>

                <p className="mt-6 text-center text-sm leading-relaxed text-ink-500">
                    Butuh bantuan dengan pesanan tiket Anda?{" "}
                    <Link
                        href="/kontak"
                        className="font-semibold text-brand-700 hover:underline"
                    >
                        Hubungi kami
                    </Link>
                    .
                </p>
            </div>
        </SiteShell>
    );
}
