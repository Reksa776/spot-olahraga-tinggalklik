import type { Metadata } from "next";
import SiteShell from "@/components/ticketing/SiteShell";
import { getPublicStoreSetting } from "@/lib/store-settings";

export const metadata: Metadata = {
    title: "Kontak Kami",
    description:
        "Hubungi kami melalui email atau telepon. Kami siap membantu Anda mengenai tiket, event, pesanan, dan layanan lainnya.",
    openGraph: {
        title: "Kontak Kami",
        description:
            "Hubungi kami melalui email atau telepon. Kami siap membantu Anda.",
    },
};

export default async function KontakPage() {
    const setting = await getPublicStoreSetting();

    return (
        <SiteShell>
            <div className="border-b border-ink-100 bg-ink-50/50">
                <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6 sm:py-14">
                    <h1 className="text-2xl font-extrabold tracking-tight text-ink-900 sm:text-3xl">
                        Kontak Kami
                    </h1>
                    <p className="mt-2 max-w-2xl text-sm text-ink-500">
                        Kami siap membantu Anda. Jangan ragu untuk menghubungi
                        kami melalui informasi di bawah ini.
                    </p>
                </div>
            </div>

            <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
                <div className="space-y-4">
                    <ContactCard
                        icon="M4 7h16v13H4zM4 11h16M9 4v4M15 4v4"
                        label="Email"
                    >
                        {setting.email ? (
                            <a
                                href={`mailto:${setting.email}`}
                                className="text-base font-medium text-brand-700 hover:underline"
                            >
                                {setting.email}
                            </a>
                        ) : (
                            <p className="text-base text-ink-400">
                                Belum tersedia
                            </p>
                        )}
                    </ContactCard>

                    <ContactCard
                        icon="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 2 .7 2.9a2 2 0 0 1-.4 2.1L8.1 10a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.9.6 2.9.7a2 2 0 0 1 1.6 2Z"
                        label="Nomor Telepon"
                    >
                        {setting.phone ? (
                            <a
                                href={`tel:${setting.phone}`}
                                className="text-base font-medium text-brand-700 hover:underline"
                            >
                                {setting.phone}
                            </a>
                        ) : (
                            <p className="text-base text-ink-400">
                                Belum tersedia
                            </p>
                        )}
                    </ContactCard>
                </div>

                <div className="mt-8 rounded-xl border border-ink-100 bg-white p-6">
                    <h2 className="text-lg font-bold text-ink-900">
                        Informasi Tambahan
                    </h2>

                    <div className="mt-4 space-y-3 text-sm leading-7 text-ink-600">
                        <p>
                            Untuk pertanyaan mengenai tiket, event, pesanan,
                            atau layanan kami, silakan hubungi melalui email
                            atau nomor telepon di atas. Kami akan berusaha
                            merespons sesegera mungkin.
                        </p>

                        <p>
                            Pastikan Anda mencantumkan nomor pesanan (jika ada)
                            agar kami dapat membantu dengan lebih cepat.
                        </p>
                    </div>
                </div>
            </div>
        </SiteShell>
    );
}

function ContactCard({
    icon,
    label,
    children,
}: {
    icon: string;
    label: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex items-start gap-4 rounded-xl border border-ink-100 bg-white p-6">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-ink-100 text-ink-500">
                <svg
                    aria-hidden
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-5 w-5"
                >
                    <path d={icon} />
                </svg>
            </span>

            <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink-500">{label}</h2>
                <div className="mt-1">{children}</div>
            </div>
        </div>
    );
}