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

export type SessionCleanupFailure = {
    entry: string;
    code: string;
};

/** A cleanup that could not delete every entry; callers must surface the list. */
export class SessionCleanupError extends Error {
    readonly failedEntries: readonly SessionCleanupFailure[];

    constructor(failedEntries: readonly SessionCleanupFailure[]) {
        super("One or more WhatsApp session entries could not be deleted.");
        this.name = "SessionCleanupError";
        this.failedEntries = failedEntries;
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
     * name or symlink must not leave a half-cleared session behind.
     */
    const targets = entries
        // Ownership is checked by the caller; never delete the file that proves it.
        .filter((entry) => entry.name !== ".gateway.lock")
        .map((entry) => {
            if (entry.isSymbolicLink()) {
                throw new SessionPathError(
                    `Session entry "${entry.name}" is a symlink.`
                );
            }

            return {
                entry: entry.name,
                target: resolveSessionEntry(root, entry.name),
            };
        });

    const failedEntries: SessionCleanupFailure[] = [];
    let deletedEntries = 0;

    for (const { entry, target } of targets) {
        try {
            await fs.rm(target, { recursive: true, force: true });
            deletedEntries += 1;
        } catch (error) {
            failedEntries.push({
                entry,
                code:
                    (error as NodeJS.ErrnoException).code ?? "UNKNOWN",
            });
        }
    }

    if (failedEntries.length > 0) {
        throw new SessionCleanupError(failedEntries);
    }

    return { deletedEntries };
}
