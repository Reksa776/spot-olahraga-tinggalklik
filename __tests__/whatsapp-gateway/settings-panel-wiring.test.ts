import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(
    path.resolve(__dirname, "../../components/dashboard/WhatsAppSettingsPanel.tsx"),
    "utf8"
);

test("the reconnect action calls /connect instead of /disconnect", () => {
    const start = source.indexOf("async function connect()");
    const end = source.indexOf("async function disconnect(");

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const connectAction = source.slice(start, end);

    expect(connectAction).toContain(
        '"/api/admin/settings/whatsapp/connect"'
    );
    expect(connectAction).not.toContain(
        '"/api/admin/settings/whatsapp/disconnect"'
    );
});

test("stale lock recovery still uses the disconnect endpoint", () => {
    expect(source).toContain("forceReleaseStale: true");
    expect(source).toContain("deleteSession: false");
});
