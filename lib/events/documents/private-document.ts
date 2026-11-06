import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_EVENT_DOCUMENT_BYTES = 10 * 1024 * 1024;
const PDF = Buffer.from("%PDF-");

export function eventDocumentDir(): string {
  return process.env.UPLOAD_DIR ? path.join(process.env.UPLOAD_DIR, "event-documents") : path.join(process.cwd(), "storage", "uploads", "event-documents");
}

export async function storeEventDocument(file: File): Promise<{ storageKey: string; size: number }> {
  if (!(file instanceof File) || file.size < 5 || file.size > MAX_EVENT_DOCUMENT_BYTES) throw new Error("INVALID_DOCUMENT_SIZE");
  const data = Buffer.from(await file.arrayBuffer());
  if (data.length < 5 || data.length > MAX_EVENT_DOCUMENT_BYTES || !data.subarray(0, 5).equals(PDF)) throw new Error("INVALID_DOCUMENT_TYPE");
  const storageKey = `${randomBytes(24).toString("hex")}.pdf`;
  const dir = eventDocumentDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, storageKey);
  await fs.writeFile(`${target}.tmp`, data, { mode: 0o600, flag: "wx" });
  await fs.rename(`${target}.tmp`, target);
  return { storageKey, size: data.length };
}

export function newDocumentToken(): string { return randomBytes(32).toString("base64url"); }
export function hashDocumentToken(token: string): string { return createHash("sha256").update(token).digest("hex"); }
export function matchesDocumentToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashDocumentToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function readEventDocument(storageKey: string): Promise<Buffer> {
  if (!/^[a-f0-9]{48}\.pdf$/.test(storageKey)) throw new Error("INVALID_STORAGE_KEY");
  return fs.readFile(path.join(eventDocumentDir(), storageKey));
}
