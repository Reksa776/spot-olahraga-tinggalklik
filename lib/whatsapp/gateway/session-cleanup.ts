import fs from "node:fs/promises";
import path from "node:path";

import {
    checkSessionDirIsolation,
    findApplicationEntry,
    PRESERVED_SESSION_ENTRIES,
} from "./session-dir";

/**
 * ==========================================
 * SESSION DELETION — NARROW AND FAIL-CLOSED
 * ==========================================
 *
 * Only the CONTENTS of the configured session directory are removed, never the
 * directory itself. The directory must already exist, be a real directory (not a
 * symlink), and must pass `checkSessionDirIsolation`: a filesystem root, the project
 * root and any ancestor of the project are refused. That last rule is what keeps the
 * application's `.env` — and therefore `AUTH_SECRET`, which protects every sign-in
 * cookie — outside the tree this function can empty.
 *
 * A directory that directly contains an application file is refused BEFORE any
 * deletion, so a misconfigured `WA_AUTH_DIR` cannot half-destroy a deployment.
 *
 * Every child is re-resolved through `resolveSessionEntry`, which rejects separators,
 * `..`, absolute names and any result whose parent is not the configured root.
 *
 * `.gateway.lock` and `.session-key` are intentionally preserved: they are ownership and
 * encryption-key evidence, not session material. Deleting the key would rotate the
 * deployment's WhatsApp encryption key on the next start.
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
    const isolation = checkSessionDirIsolation(sessionDir);

    if (!isolation.ok) {
        throw new SessionPathError(isolation.message);
    }

    const root = isolation.directory;
    const stat = await fs.lstat(root);

    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new SessionPathError(
            "The WhatsApp session path must be a real directory, not a symlink."
        );
    }

    const entries = await fs.readdir(root, { withFileTypes: true });

    /*
     * Refuse a directory that is really part of the application. This is the second
     * boundary after the path check: it catches a session directory that holds `.env`
     * or application files even when its location is otherwise acceptable.
     */
    const applicationEntry = findApplicationEntry(
        entries.map((entry) => entry.name)
    );

    if (applicationEntry) {
        throw new SessionPathError(
            `Refusing to clear a directory that contains application files (${applicationEntry}).`
        );
    }

    /*
     * Resolve and validate EVERY entry before deleting the first one. A rejected
     * name or symlink must not leave a half-cleared session behind.
     */
    const targets = entries
        // Ownership/key evidence is not session material; never delete it.
        .filter(
            (entry) =>
                !(PRESERVED_SESSION_ENTRIES as readonly string[]).includes(
                    entry.name
                )
        )
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
