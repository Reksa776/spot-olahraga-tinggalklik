import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { matchesDocumentToken, readEventDocument } from "@/lib/events/documents/private-document";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const token = request.nextUrl.searchParams.get("token") ?? "";
  if (token.length < 30 || token.length > 100) return new NextResponse("Not found", { status: 404 });
  const doc = await prisma.eventDocument.findUnique({ where: { id: documentId }, select: { storageKey: true, accessTokenHash: true, expiresAt: true, title: true } });
  if (!doc || doc.expiresAt <= new Date() || !matchesDocumentToken(token, doc.accessTokenHash)) return new NextResponse("Not found", { status: 404 });
  try {
    const bytes = await readEventDocument(doc.storageKey);
    return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${doc.title.replace(/["\\\r\n]/g, "_")}.pdf"`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return new NextResponse("Not found", { status: 404 }); }
}
