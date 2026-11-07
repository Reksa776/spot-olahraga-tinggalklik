import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSessionKey } from "./config";

/** Load or create the persistent 32-byte key without requiring operators to encode it. */
export async function ensureWhatsAppSessionKey(): Promise<void> {
    if (process.env.WA_GATEWAY_ENABLED?.trim().toLowerCase() !== "true") return;
    if (parseSessionKey(process.env.WA_SESSION_ENCRYPTION_KEY)) return;

    const sessionDir = path.resolve(
        process.cwd(),
        process.env.WA_AUTH_DIR?.trim() || path.join("storage", "whatsapp-gateway")
    );
    await fs.mkdir(sessionDir, { recursive: true, mode: 0o700 });
    const directory = await fs.lstat(sessionDir);
    if (!directory.isDirectory() || directory.isSymbolicLink()) {
        throw new Error("WhatsApp session directory must be a real directory.");
    }
    await fs.chmod(sessionDir, 0o700);

    const keyPath = path.join(sessionDir, ".session-key");
    try {
        const stat = await fs.lstat(keyPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new Error("WhatsApp session key must be a regular file.");
        }
        await fs.chmod(keyPath, 0o600);
        const key = await fs.readFile(keyPath);
        if (key.length !== 32) throw new Error("Stored WhatsApp session key is invalid.");
        process.env.WA_SESSION_ENCRYPTION_KEY = key.toString("base64");
        return;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const key = randomBytes(32);
    try {
        const handle = await fs.open(keyPath, "wx", 0o600);
        try {
            await handle.writeFile(key);
            await handle.sync();
        } finally {
            await handle.close();
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await fs.readFile(keyPath);
        if (existing.length !== 32) throw new Error("Stored WhatsApp session key is invalid.");
        process.env.WA_SESSION_ENCRYPTION_KEY = existing.toString("base64");
        return;
    }
    process.env.WA_SESSION_ENCRYPTION_KEY = key.toString("base64");
}
