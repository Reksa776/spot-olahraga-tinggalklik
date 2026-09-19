import PicAssignmentManager from "@/components/organizer/PicAssignmentManager";
import PicManager, { type PicRow } from "@/components/platform/PicManager";
import {
    AccessDeniedPanel,
    EmptyBlock,
    PageHeader,
    SectionCard,
} from "@/components/dashboard/primitives";
import { PERMISSIONS, getAuthzScope } from "@/lib/authz";
import { isAuthzError } from "@/lib/authz/errors";
import { hasOrganizerPermission, hasPlatformPermission } from "@/lib/dashboard/scope";
import { getOrganizerPageContext } from "@/lib/organizer/context";
import { listOrganizerPicAssignments, listPicsForAdmin } from "@/lib/pic/service";

/**
 * ==========================================
 * PIC — ONE PAGE, TWO AUTHORITY DIMENSIONS
 * ==========================================
 *
 * PIC (Penanggung Jawab) is the ticketing referrer domain. It has two surfaces that used to
 * live at `/platform/pic` and `/organizer/pic`:
 *
 *   `pic.manage` (PLATFORM scope)  — create, approve and suspend PIC profiles.
 *   `pic.assign` (TENANT scope)    — attach an already-approved PIC to one of YOUR events.
 *
 * They are the same menu row because they are the same concept, and this page renders
 * whichever one the caller actually holds. That is the whole consolidation: not a merged
 * permission (that would let an organizer approve profiles, or an admin attach a referrer
 * to an event they do not own), but one destination whose body is chosen by authority.
 *
 * A caller holding NEITHER sees the denial panel — not a disabled page, and not an empty
 * one, because "you cannot do this" and "there is nothing here" are different answers.
 *
 * Both services re-check their own permission internally, so the branch below is a routing
 * decision, not the access control.
 */

export const dynamic = "force-dynamic";

export default async function DashboardPicPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    if (hasPlatformPermission(scope, PERMISSIONS.PIC_MANAGE)) {
        return <PlatformPicSection />;
    }

    if (hasOrganizerPermission(scope, PERMISSIONS.PIC_ASSIGN)) {
        return <OrganizerPicSection />;
    }

    return (
        <AccessDeniedPanel
            title="Akses ditolak"
            body={
                <p className="text-sm leading-relaxed">
                    Peran kamu belum memiliki izin mengelola atau menugaskan PIC.
                </p>
            }
            actionHref="/dashboard"
            actionLabel="Kembali ke ringkasan"
        />
    );
}

async function PlatformPicSection() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    let result;

    try {
        result = await listPicsForAdmin(scope);
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Peran platform kamu belum memiliki izin mengelola PIC.
                    </p>
                }
                actionHref="/dashboard"
                actionLabel="Kembali ke ringkasan"
            />
        );
    }

    const pics: PicRow[] = result.items.map((pic) => ({
        id: pic.id,
        picCode: pic.picCode,
        displayName: pic.displayName,
        status: pic.status,
        defaultFeeRateBp: pic.defaultFeeRateBp,
        canSellAllEvents: pic.canSellAllEvents,
        approvedAt: pic.approvedAt,
        suspendedAt: pic.suspendedAt,
        suspendReason: pic.suspendReason,
        createdAt: pic.createdAt,
        account: pic.account,
        counts: pic.counts,
        ledgerTotal: pic.ledgerTotal,
    }));

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="PIC"
                description="Penanggung jawab penjualan tiket. Profil PIC ditautkan ke akun yang sudah terdaftar, disetujui di sini, lalu ditugaskan ke event oleh penyelenggara. Angka fee berasal dari ledger yang sudah diposting."
            />

            <PicManager pics={pics} />
        </div>
    );
}

async function OrganizerPicSection() {
    const context = await getOrganizerPageContext();

    if (!context.currentOrganizerId) {
        return (
            <SectionCard title="PIC">
                <EmptyBlock
                    title="Tidak ada organizer aktif"
                    description="Belum ada organizer yang bisa dipilih, sehingga penugasan PIC belum tersedia."
                />
            </SectionCard>
        );
    }

    let result;

    try {
        result = await listOrganizerPicAssignments(
            context.scope,
            context.currentOrganizerId
        );
    } catch (error) {
        if (!isAuthzError(error)) {
            throw error;
        }

        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Peran kamu di organizer ini belum memiliki izin mengatur penugasan
                        PIC.
                    </p>
                }
                actionHref="/dashboard/events"
                actionLabel="Lihat event"
            />
        );
    }

    const currentOrganizer = context.organizers.find(
        (organizer) => organizer.id === context.currentOrganizerId
    );

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Dashboard"
                title="PIC"
                description={`Atur penanggung jawab penjualan untuk event ${currentOrganizer?.name ?? "organizer ini"}. Hanya PIC yang sudah disetujui admin platform yang dapat ditugaskan, dan penugasan ini yang menentukan siapa yang layak mendapat atribusi penjualan tiket event tersebut.`}
            />

            <PicAssignmentManager
                assignments={result.assignments}
                events={result.events}
                pics={result.pics}
            />
        </div>
    );
}
