import type { NextRequest } from "next/server";
import { AppError } from "@/lib/api/errors";
import { handleApi, ok } from "@/lib/api/response";
import { requireAuth } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireSameOrigin } from "@/lib/csrf";
import { enqueueNotification } from "@/lib/notifications/enqueue";
import { normalizeEmail, normalizeIndonesianPhone } from "@/lib/notifications/contacts";
import { POST_EVENT_DOCUMENT_TEMPLATE_KEY } from "@/lib/notifications/post-event-document-template";
import { getAppOrigin } from "@/lib/app-origin";
import { hashDocumentToken, newDocumentToken, storeEventDocument } from "@/lib/events/documents/private-document";

export const runtime = "nodejs";

async function requireAssignedPic(userId: string, eventId: string) {
  const profile = await prisma.pICProfile.findUnique({ where: { userId }, select: { id: true, status: true } });
  if (!profile || profile.status !== "ACTIVE") throw AppError.notFound();
  const assignment = await prisma.pICEventAssignment.findUnique({ where: { picProfileId_eventId: { picProfileId: profile.id, eventId } }, select: { isActive: true, revokedAt: true } });
  if (!assignment?.isActive || assignment.revokedAt) throw AppError.notFound();
  return profile;
}

/** Upload one private PDF and enqueue it for paid participants via selected channels. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return handleApi(async () => {
    const csrf = requireSameOrigin(request); if (csrf.error) return csrf.error;
    const scope = await requireAuth();
    const { id: eventId } = await params;
    const profile = await requireAssignedPic(scope.userId, eventId);
    const event = await prisma.event.findUnique({ where: { id: eventId }, select: { id: true, title: true, status: true } });
    if (!event || event.status !== "COMPLETED") throw AppError.conflict("Dokumen hanya dapat dikirim setelah acara selesai.");
    const form = await request.formData();
    const file = form.get("file"); const title = String(form.get("title") ?? "").trim().slice(0, 160);
    const channels = String(form.get("channels") ?? "email,whatsapp").split(",").filter((x) => x === "email" || x === "whatsapp");
    if (!(file instanceof File) || !title || channels.length === 0) throw AppError.validation("Judul, PDF, dan kanal pengiriman wajib diisi.");
    const origin = getAppOrigin(request);
    if (!origin || !origin.startsWith("https://")) throw AppError.conflict("URL aplikasi HTTPS belum dikonfigurasi.");
    let stored: Awaited<ReturnType<typeof storeEventDocument>>;
    try { stored = await storeEventDocument(file); } catch { throw AppError.validation("Dokumen harus berupa PDF maksimal 10MB."); }
    const token = newDocumentToken();
    const doc = await prisma.eventDocument.create({ data: { eventId, uploadedById: scope.userId, title, storageKey: stored.storageKey, contentType: "application/pdf", sizeBytes: stored.size, accessTokenHash: hashDocumentToken(token), expiresAt: new Date(Date.now() + 90 * 86400000) }, select: { id: true } });
    const downloadUrl = `${origin}/api/public/event-documents/${doc.id}?token=${encodeURIComponent(token)}`;
    const orders = await prisma.eventOrder.findMany({ where: { eventId, status: "PAID", paymentStatus: "PAID", tickets: { some: { status: "ISSUED" } } }, select: { id: true, orderNumber: true, buyerName: true, buyerEmail: true, buyerPhone: true }, take: 5000 });
    let enqueued = 0;
    for (const order of orders) for (const channel of channels) {
      const recipient = channel === "email" ? normalizeEmail(order.buyerEmail ?? "") : normalizeIndonesianPhone(order.buyerPhone ?? "");
      if (!recipient) continue;
      const result = await enqueueNotification({ idempotencyKey: `event-doc:${doc.id}:${order.id}:${channel}:v1`, channel: channel === "email" ? "EMAIL" : "WHATSAPP", recipient, category: "SYSTEM", recipientType: "CUSTOMER", templateKey: POST_EVENT_DOCUMENT_TEMPLATE_KEY, payload: { title, eventTitle: event.title, downloadUrl }, eventId, picProfileId: profile.id });
      if (result.created) enqueued++;
    }
    return ok({ documentId: doc.id, eligibleOrders: orders.length, enqueued, expiresAt: new Date(Date.now() + 90 * 86400000).toISOString() });
  });
}
