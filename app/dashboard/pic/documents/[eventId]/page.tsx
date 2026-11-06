import { notFound } from "next/navigation";
import { PageHeader, SectionCard } from "@/components/dashboard/primitives";
import { PicEventDocumentForm } from "@/components/dashboard/PicEventDocumentForm";
import { requireAuth } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function PicEventDocumentsPage({ params }: { params: Promise<{ eventId: string }> }) {
  const scope = await requireAuth();
  const { eventId } = await params;
  const profile = await prisma.pICProfile.findUnique({ where: { userId: scope.userId }, select: { id: true, status: true } });
  if (!profile || profile.status !== "ACTIVE") notFound();
  const assignment = await prisma.pICEventAssignment.findUnique({ where: { picProfileId_eventId: { picProfileId: profile.id, eventId } }, select: { isActive: true, revokedAt: true } });
  if (!assignment?.isActive || assignment.revokedAt) notFound();
  const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, status: true } });
  if (!event || event.status !== "COMPLETED") notFound();
  return <main className="space-y-6"><PageHeader title="Kirim dokumen peserta" description={event.title} /><SectionCard><PicEventDocumentForm eventId={event.id} eventTitle={event.title} /></SectionCard></main>;
}
