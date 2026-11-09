import { notFound } from "next/navigation";
import Link from "next/link";

import {
    EmptyBlock,
    InfoNote,
    PageHeader,
    SectionCard,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import { requireAuth } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/**
 * ==========================================
 * /pic/scanner — PIC SCANNER ENTRY POINT
 * ==========================================
 *
 * The canonical PIC door to the gate. It lists ONLY the events the signed-in PIC is actively
 * assigned to (`PICEventAssignment`, active and not revoked) and links each to the scanner.
 *
 * This page is a routing surface, not the access control: `/pic/scanner/[eventId]` re-runs
 * `requirePicScanAccess` on the server for the exact event, and the POST route re-runs the same
 * decider. A PIC therefore cannot scan an event merely by typing its id in the URL.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Pindai Tiket" };

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Jakarta",
});

export default async function PicScannerIndexPage() {
    const scope = await requireAuth();

    const profile = await prisma.pICProfile.findUnique({
        where: { userId: scope.userId },
        select: { id: true, status: true },
    });

    if (!profile || profile.status !== "ACTIVE") {
        notFound();
    }

    const assignments = await prisma.pICEventAssignment.findMany({
        where: {
            picProfileId: profile.id,
            isActive: true,
            revokedAt: null,
        },
        orderBy: [{ assignedAt: "desc" }],
        select: {
            id: true,
            event: {
                select: {
                    id: true,
                    title: true,
                    slug: true,
                    status: true,
                    startAt: true,
                },
            },
        },
    });

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="PIC"
                title="Pindai tiket"
                description="Pilih event yang ditugaskan kepadamu. Scanner hanya menerima tiket untuk event tersebut; penugasan yang dicabut tidak muncul di sini."
            />

            <InfoNote>
                Setiap pemindaian dicatat sebagai baris audit <code>CheckIn</code> — baik yang
                berhasil maupun yang ditolak. Daftar kehadiran peserta tidak ditampilkan kepada
                PIC.
            </InfoNote>

            <SectionCard title="Event yang ditugaskan">
                {assignments.length === 0 ? (
                    <EmptyBlock
                        title="Belum ada event aktif"
                        description="Hubungi penyelenggara atau admin platform untuk menugaskanmu ke sebuah event."
                    />
                ) : (
                    <ul className="flex flex-col divide-y">
                        {assignments.map((assignment) => (
                            <li
                                key={assignment.id}
                                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                            >
                                <div className="min-w-0">
                                    <Link
                                        href={`/pic/scanner/${assignment.event.id}`}
                                        className="text-sm font-semibold underline-offset-4 hover:underline"
                                    >
                                        {assignment.event.title}
                                    </Link>
                                    <p className="text-xs text-muted-foreground">
                                        {DATE_FORMAT.format(
                                            new Date(assignment.event.startAt)
                                        )}{" "}
                                        · /e/{assignment.event.slug}
                                    </p>
                                </div>
                                <div className="flex items-center gap-3">
                                    <StatusBadge
                                        tone={
                                            assignment.event.status === "ONGOING"
                                                ? "success"
                                                : "neutral"
                                        }
                                    >
                                        {assignment.event.status}
                                    </StatusBadge>
                                    <TextLink
                                        href={`/pic/scanner/${assignment.event.id}`}
                                    >
                                        Buka scanner
                                    </TextLink>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </SectionCard>
        </div>
    );
}
