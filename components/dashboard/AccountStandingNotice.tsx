import { EmptyBlock, SectionCard } from "@/components/dashboard/primitives";

/**
 * ==========================================
 * ACCOUNT STANDING NOTICE (PHASE 34)
 * ==========================================
 *
 * A landing state for an account that MAY ENTER the dashboard shell but has no operational
 * surface yet. Phase 33 provisions MANAGER and PIC accounts separately from organizer
 * membership, so two honest states exist that used to fall through to the generic
 * "Akun kamu belum memiliki akses ke dashboard" panel:
 *
 *   · a MANAGER with no OrganizerMember yet — the account is active, no organization has
 *     been assigned;
 *   · a PIC whose profile is PENDING / SUSPENDED / REJECTED — the account may enter, but
 *     the self-service surface (Event Saya, Referral, Pendapatan) depends on an ACTIVE
 *     profile and is therefore not offered.
 *
 * ── WHY A SEPARATE COMPONENT ────────────────────────────────────────────────────
 * The same two states appear on `/dashboard` and on `/dashboard/pic` (the destination the
 * PIC login intent leads to), and both must read identically. One component keeps the copy
 * in one place, and reuses the existing `SectionCard` + `EmptyBlock` vocabulary so the state
 * looks like the rest of the back office rather than a bespoke screen.
 *
 * This is presentational only. It grants nothing: the platform role admits the shell, the
 * profile standing is resolved server-side from the session user, and every protected read
 * still re-checks authority in its service (`requireMyPic` for PIC self-service).
 */

export type AccountStanding =
    | "manager-no-organizer"
    | "pic-pending"
    | "pic-suspended"
    | "pic-rejected"
    | "pic-missing";

const COPY: Record<AccountStanding, { title: string; description: string }> = {
    "manager-no-organizer": {
        title: "Belum Ada Organisasi",
        description:
            "Akun Manager sudah aktif, tetapi belum ditugaskan ke organisasi. Hubungi admin platform untuk mendapatkan akses organisasi.",
    },
    "pic-pending": {
        title: "Profil PIC Menunggu Persetujuan",
        description:
            "Profil PIC kamu sudah dibuat, tetapi masih menunggu persetujuan admin. Setelah disetujui, fitur Event Saya, Referral, dan Pendapatan akan tersedia.",
    },
    "pic-suspended": {
        title: "Profil PIC Ditangguhkan",
        description:
            "Profil PIC kamu sedang ditangguhkan. Fitur Event Saya, Referral, dan Pendapatan tidak tersedia sampai admin platform mengaktifkannya kembali.",
    },
    "pic-rejected": {
        title: "Profil PIC Ditolak",
        description:
            "Pengajuan profil PIC kamu ditolak. Hubungi admin platform jika kamu ingin mengajukan ulang.",
    },
    "pic-missing": {
        title: "Profil PIC Belum Aktif",
        description:
            "Akun PIC kamu belum memiliki profil aktif. Hubungi admin platform untuk melengkapi profil PIC.",
    },
};

/** Map a resolved PIC profile standing (or `null` for none) to its notice. */
export function picStandingNotice(
    standing: "PENDING" | "ACTIVE" | "SUSPENDED" | "REJECTED" | null
): AccountStanding {
    switch (standing) {
        case "PENDING":
            return "pic-pending";
        case "SUSPENDED":
            return "pic-suspended";
        case "REJECTED":
            return "pic-rejected";
        default:
            return "pic-missing";
    }
}

export function AccountStandingNotice({
    standing,
}: {
    standing: AccountStanding;
}) {
    const copy = COPY[standing];

    return (
        <SectionCard>
            <EmptyBlock title={copy.title} description={copy.description} />
        </SectionCard>
    );
}
