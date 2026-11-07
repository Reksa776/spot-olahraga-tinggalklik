import { PageHeader, SectionCard } from "@/components/dashboard/primitives";
import { WhatsAppSettingsPanel } from "@/components/dashboard/WhatsAppSettingsPanel";
import { requirePlatformPermission } from "@/lib/authz";
import { PERMISSIONS } from "@/lib/authz/permissions";

export const dynamic = "force-dynamic";
export const metadata = { title: "WhatsApp dan Email" };

export default async function DashboardWhatsAppSettingsPage() {
  await requirePlatformPermission(PERMISSIONS.APPLICATION_SETTINGS);
  return <main className="space-y-6"><PageHeader eyebrow="Dashboard · Sistem" title="WhatsApp dan email" description="Hubungkan akun WhatsApp bisnis dan periksa konfigurasi pengiriman." /><SectionCard><WhatsAppSettingsPanel /></SectionCard></main>;
}
