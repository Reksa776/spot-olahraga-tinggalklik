import fs from "node:fs";
import path from "node:path";

const panelSource = fs.readFileSync(
    path.resolve(__dirname, "../../components/dashboard/WhatsAppSettingsPanel.tsx"),
    "utf8"
);
const technicalSource = fs.readFileSync(
    path.resolve(
        __dirname,
        "../../components/dashboard/WhatsAppTechnicalDetails.tsx"
    ),
    "utf8"
);

function sliceBetween(source: string, start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);

    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);

    return source.slice(from, to);
}

test("the reconnect action calls /connect instead of /disconnect", () => {
    const connectAction = sliceBetween(
        panelSource,
        "async function connect()",
        "async function disconnect("
    );

    expect(connectAction).toContain(
        '"/api/admin/settings/whatsapp/connect"'
    );
    expect(connectAction).not.toContain(
        '"/api/admin/settings/whatsapp/disconnect"'
    );
});

test("the default panel render contains no raw process diagnostics", () => {
    const defaultRender = panelSource.slice(
        panelSource.indexOf('return (\n        <div className="space-y-6">')
    );

    expect(defaultRender).not.toMatch(/\bpid\b/i);
    expect(defaultRender).not.toContain("processName");
    expect(defaultRender).not.toContain("heartbeatAgeMs");
    expect(defaultRender).not.toContain("next-server");

    // Diagnostics live in a collapsible component rendered only for conflict/error.
    expect(panelSource).toContain("showTechnicalDetails ? (");
    expect(panelSource).toContain("<WhatsAppTechnicalDetails");
    expect(technicalSource).toContain("<Collapsible");
    expect(technicalSource).toContain("Detail teknis");
    expect(technicalSource).toContain("Salin detail");
});

test("the disconnect checkbox is gone", () => {
    expect(panelSource).not.toContain("Hapus session");
    expect(panelSource).not.toContain("delete-whatsapp-session");
    expect(panelSource).not.toContain("Checkbox");
});

test("Putuskan WhatsApp always deletes the session after confirmation", () => {
    const dialog = sliceBetween(
        panelSource,
        "Putuskan WhatsApp?",
        "Perbaiki koneksi?"
    );

    expect(dialog).toContain("Semua session WhatsApp akan dihapus");
    expect(dialog).toContain("Ya, putuskan");
    expect(dialog).toContain("deleteSession: true");
    expect(dialog).toContain('reason: "user_disconnect"');
});

test("Perbaiki koneksi releases a stale lock without deleting the session", () => {
    const dialog = sliceBetween(
        panelSource,
        "Perbaiki koneksi?",
        "<section className=\"space-y-2 border-t"
    );

    expect(dialog).toContain("forceReleaseStale: true");
    expect(dialog).toContain("deleteSession: false");
    expect(dialog).toContain('reason: "force_release_stale"');
    expect(dialog).not.toContain("deleteSession: true");
});
