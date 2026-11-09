import fs from "node:fs/promises";
import path from "node:path";

/**
 * ==========================================
 * SESSION DELETION — NARROW AND FAIL-CLOSED
 * ==========================================
 *
 * Only the CONTENTS of the configured session directory are removed, never the
 * directory itself. The directory must already exist, be a real directory (not a
 * symlink), and must not be a filesystem root. Every child is re-resolved through
 * `resolveSessionEntry`, which rejects separators, `..`, absolute names and any
 * result whose parent is not the configured root.
 *
 * `.gateway.lock` is intentionally preserved: it is ownership evidence, not session
 * material. The caller checks the lock first and refuses deletion while it exists.
 */

export class SessionPathError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SessionPathError";
    }
}

export function resolveSessionEntry(rootDir: string, entryName: string): string {
    if (
        !entryName ||
        entryName === "." ||
        entryName === ".." ||
        entryName.includes("/") ||
        entryName.includes("\\") ||
        path.isAbsolute(entryName)
    ) {
        throw new SessionPathError("Session entry name is not a plain basename.");
    }

    const root = path.resolve(/* turbopackIgnore: true */ rootDir);
    const candidate = path.resolve(
        /* turbopackIgnore: true */ root,
        entryName
    );

    if (path.dirname(candidate) !== root) {
        throw new SessionPathError("Session entry escapes the configured directory.");
    }

    return candidate;
}

export async function clearWhatsAppSessionDirectory(
    sessionDir: string
): Promise<{ deletedEntries: number }> {
    const root = path.resolve(/* turbopackIgnore: true */ sessionDir);

    if (root === path.parse(root).root) {
        throw new SessionPathError("Refusing to clear a filesystem root.");
    }

    const stat = await fs.lstat(root);

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new SessionPathError(
            "The WhatsApp session path must be a real directory, not a symlink."
        );
    }

    const entries = await fs.readdir(root, { withFileTypes: true });

    /*
     * Resolve and validate EVERY entry before deleting the first one. A rejected
     * name must not leave a half-cleared session behind.
     */
    const targets = entries
        // Ownership is checked by the caller; never delete the file that proves it.
        .filter((entry) => entry.name !== ".gateway.lock")
        .map((entry) => resolveSessionEntry(root, entry.name));

    for (const target of targets) {
        await fs.rm(target, { recursive: true, force: true });
    }

    return { deletedEntries: targets.length };
}
