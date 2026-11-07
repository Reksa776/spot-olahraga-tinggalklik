import { AppError } from "@/lib/api/errors";

function gatewayConfig() {
  const token = process.env.WA_GATEWAY_TOKEN?.trim();
  const base = process.env.WA_GATEWAY_URL?.trim() || `http://127.0.0.1:${process.env.WA_GATEWAY_PORT?.trim() || "3100"}`;
  if (!token || token.length < 32 || !/^http:\/\/(127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(base)) throw AppError.conflict("Konfigurasi internal WhatsApp gateway belum siap.");
  return { token, base };
}

export async function gatewayFetch(path: string, init?: RequestInit) {
  const { token, base } = gatewayConfig();
  try {
    const response = await fetch(`${base}${path}`, { ...init, cache: "no-store", signal: AbortSignal.timeout(3000), headers: { authorization: `Bearer ${token}`, ...(init?.headers ?? {}) } });
    const payload = await response.json();
    if (!response.ok) throw AppError.conflict("WhatsApp gateway belum siap.");
    return payload;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.conflict("WhatsApp gateway tidak dapat dijangkau. Pastikan gateway berjalan di server.");
  }
}
