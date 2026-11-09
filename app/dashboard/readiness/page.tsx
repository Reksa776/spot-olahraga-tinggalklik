import {
    AccessDeniedPanel,
    InfoNote,
    PageHeader,
    SectionCard,
    StatusBadge,
    TextLink,
} from "@/components/dashboard/primitives";
import {
    PERMISSIONS,
    decidePlatformPermission,
    getAuthzScope,
} from "@/lib/authz";
import { readJobReadiness } from "@/lib/jobs/readiness";
import { resolveNotificationConfig } from "@/lib/notifications/config";

/**
 * ==========================================
 * /dashboard/readiness — SCHEDULER / WORKER HEARTBEAT
 * ==========================================
 *
 * The page that answers the question behind a missing H-36 reminder: "is anything actually
 * running the jobs?" It renders `JobLock.lastRunAt` / `lastStatus` for the three cron jobs and
 * for the separate notification worker, and warns when a heartbeat is older than twice its
 * expected interval.
 *
 * Read-only: no lease is acquired and no job is triggered. Platform-config permission is
 * required because the rows describe the deployment, not a tenant.
 */

export const dynamic = "force-dynamic";

export const metadata = { title: "Readiness" };

const DATE_FORMAT = new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Jakarta",
});

function ageLabel(ms: number | null): string {
    if (ms === null) {
        return "—";
    }

    if (ms < 1_000) {
        return "baru saja";
    }

    if (ms < 60_000) {
        return `${Math.round(ms / 1_000)} detik lalu`;
    }

    if (ms < 3_600_000) {
        return `${Math.round(ms / 60_000)} menit lalu`;
    }

    return `${Math.round(ms / 3_600_000)} jam lalu`;
}

export default async function ReadinessPage() {
    const scope = await getAuthzScope();

    if (!scope) {
        return null;
    }

    if (!decidePlatformPermission(scope, PERMISSIONS.PLATFORM_CONFIG).allowed) {
        return (
            <AccessDeniedPanel
                title="Akses ditolak"
                body={
                    <p className="text-sm leading-relaxed">
                        Hanya admin platform yang dapat melihat status scheduler dan worker.
                    </p>
                }
                actionHref="/dashboard"
                actionLabel="Kembali ke ringkasan"
            />
        );
    }

    const readiness = await readJobReadiness();
    const notifications = resolveNotificationConfig();

    return (
        <div className="flex flex-col gap-6">
            <PageHeader
                eyebrow="Operasional"
                title="Readiness scheduler & worker"
                description="Heartbeat JobLock untuk cron tick dan notification worker. Sebuah baris dianggap basi bila lastRunAt lebih lama dari dua kali interval yang diharapkan."
            />

            {readiness.stale ? (
                <InfoNote tone="warn">
                    <strong>Perhatian:</strong> ada proses yang heartbeat-nya basi. Reminder
                    H-36 hanya akan terkirim bila cron memanggil{" "}
                    <code>POST /api/internal/jobs/tick</code> setiap menit DAN proses{" "}
                    <code>tinggalklik-worker</code> berjalan.
                </InfoNote>
            ) : (
                <InfoNote>
                    Semua heartbeat masih dalam batas. Reminder tetap membutuhkan{" "}
                    <code>NOTIFICATIONS_ENABLED=true</code> (atau fallback session WhatsApp
                    aktif) dan transport WhatsApp yang benar.
                </InfoNote>
            )}

            <SectionCard
                title="Heartbeat"
                description={`Diperiksa pada ${DATE_FORMAT.format(new Date(readiness.now))} (Asia/Jakarta).`}
            >
                <div className="overflow-x-auto">
                    <table className="w-full min-w-[760px] text-sm">
                        <thead>
                            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                                <th className="px-2 py-2">Proses</th>
                                <th className="px-2 py-2">Terakhir jalan</th>
                                <th className="px-2 py-2">Status</th>
                                <th className="px-2 py-2">Interval</th>
                                <th className="px-2 py-2">Hasil</th>
                            </tr>
                        </thead>
                        <tbody>
                            {readiness.jobs.map((job) => (
                                <tr key={job.name} className="border-b last:border-0">
                                    <td className="px-2 py-2">
                                        <p className="font-medium">{job.label}</p>
                                        <code className="text-xs text-muted-foreground">
                                            {job.name}
                                        </code>
                                    </td>
                                    <td className="px-2 py-2">
                                        <p>{ageLabel(job.lastRunAgeMs)}</p>
                                        <p className="text-xs text-muted-foreground">
                                            {job.lastRunAt
                                                ? DATE_FORMAT.format(new Date(job.lastRunAt))
                                                : "belum pernah"}
                                        </p>
                                    </td>
                                    <td className="px-2 py-2">
                                        <StatusBadge
                                            tone={
                                                job.severity === "ok"
                                                    ? "success"
                                                    : job.severity === "never-run"
                                                      ? "error"
                                                      : "warn"
                                            }
                                        >
                                            {job.lastStatus ?? "NO_RUN"}
                                        </StatusBadge>
                                    </td>
                                    <td className="px-2 py-2 tabular-nums">
                                        {Math.round(job.intervalMs / 1_000)} dtk
                                    </td>
                                    <td className="px-2 py-2">
                                        {job.warning ? (
                                            <span className="text-warning">
                                                {job.warning}
                                            </span>
                                        ) : (
                                            <span className="text-muted-foreground">
                                                OK
                                            </span>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </SectionCard>

            <SectionCard
                title="Konfigurasi notifikasi"
                description="Nilai ini dibaca dari environment proses web. Worker memiliki proses sendiri dan membaca environment yang sama."
            >
                <dl className="grid gap-3 text-sm sm:grid-cols-2">
                    <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            NOTIFICATIONS_ENABLED
                        </dt>
                        <dd>
                            <StatusBadge tone={notifications.enabled ? "success" : "error"}>
                                {notifications.enabled ? "AKTIF" : "MATI"}
                            </StatusBadge>
                        </dd>
                    </div>
                    <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            WHATSAPP_TRANSPORT
                        </dt>
                        <dd className="font-mono">{notifications.whatsappTransport}</dd>
                    </div>
                    <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            EMAIL_TRANSPORT
                        </dt>
                        <dd className="font-mono">{notifications.emailTransport}</dd>
                    </div>
                    <div>
                        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                            Worker poll / batch
                        </dt>
                        <dd className="font-mono">
                            {notifications.pollIntervalMs} ms / {notifications.batchSize}
                        </dd>
                    </div>
                </dl>

                {!notifications.enabled ? (
                    <div className="pt-4">
                        <InfoNote tone="warn">
                            Worker tidak akan mengirim apa pun. Set{" "}
                            <code>NOTIFICATIONS_ENABLED=true</code> di environment produksi,
                            atau biarkan fallback mengaktifkannya otomatis ketika{" "}
                            <code>WHATSAPP_TRANSPORT=baileys</code>,{" "}
                            <code>WA_GATEWAY_ENABLED=true</code>, token gateway valid, dan
                            session WhatsApp sudah dipasangkan.
                        </InfoNote>
                    </div>
                ) : null}

                <p className="pt-4 text-xs text-muted-foreground">
                    Detail gateway WhatsApp:{" "}
                    <TextLink href="/dashboard/settings/whatsapp">
                        Pengaturan WhatsApp
                    </TextLink>
                    .
                </p>
            </SectionCard>
        </div>
    );
}
