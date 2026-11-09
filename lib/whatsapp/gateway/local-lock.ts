import fs from "node:fs/promises";
import path from "node:path";

/**
 * Local process lock held for the lifetime of the gateway.
 *
 * The DB lease stops split ownership across hosts; this `O_EXCL` file stops two processes on
 * the same host (or a future pairing CLI racing the gateway) even if they point at different
 * databases. It is deliberately not stolen: a stale lock after a crash requires operator
 * inspection, because silently deleting it could let two sockets start.
 */
export type LocalLockRecord = {
    pid: number;
    ownerId: string;
    acquiredAt: string;
};

/**
 * Read a lock file without acquiring it. Used by the operator-facing disconnect/status
 * endpoints so they can name the process that is holding the session.
 *
 * `exists: true` with `record: null` means the file is there but unreadable/corrupt; callers
 * must treat that as HELD (fail closed), never as free.
 */
export async function readLocalProcessLock(
    filePath: string
): Promise<{ exists: boolean; record: LocalLockRecord | null }> {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = JSON.parse(raw) as Partial<LocalLockRecord>;

        if (
            typeof parsed.pid !== "number" ||
            typeof parsed.ownerId !== "string" ||
            typeof parsed.acquiredAt !== "string"
        ) {
            return { exists: true, record: null };
        }

        return {
            exists: true,
            record: {
                pid: parsed.pid,
                ownerId: parsed.ownerId,
                acquiredAt: parsed.acquiredAt,
            },
        };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { exists: false, record: null };
        }

        return { exists: true, record: null };
    }
}

export class LocalLockConflictError extends Error {
    constructor() {
        super(
            "Another WhatsApp gateway process holds the local session lock; refusing to start."
        );
        this.name = "LocalLockConflictError";
    }
}

export class LocalProcessLock {
    private held = false;

    constructor(
        private readonly filePath: string,
        private readonly ownerId: string
    ) {}

    async acquire(): Promise<boolean> {
        const directory = path.dirname(this.filePath);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });

        const directoryStat = await fs.lstat(directory);

        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
            throw new Error(
                "The WhatsApp session path must be a real directory, not a symlink."
            );
        }

        if ((directoryStat.mode & 0o777) !== 0o700) {
            await fs.chmod(directory, 0o700);
        }

        const record: LocalLockRecord = {
            pid: process.pid,
            ownerId: this.ownerId,
            acquiredAt: new Date().toISOString(),
        };

        let handle: fs.FileHandle;

        try {
            handle = await fs.open(this.filePath, "wx", 0o600);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                return false;
            }

            throw error;
        }

        try {
            await handle.writeFile(JSON.stringify(record), "utf8");
            await handle.sync();
        } catch (error) {
            await handle.close().catch(() => undefined);
            await fs.rm(this.filePath, { force: true }).catch(() => undefined);
            throw error;
        }

        await handle.close();
        this.held = true;

        return true;
    }

    async release(): Promise<void> {
        if (!this.held) {
            return;
        }

        try {
            const raw = await fs.readFile(this.filePath, "utf8");
            const record = JSON.parse(raw) as Partial<LocalLockRecord>;

            if (record.ownerId !== this.ownerId) {
                // Never remove a lock that belongs to a replacement owner.
                return;
            }

            await fs.rm(this.filePath, { force: true });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        } finally {
            this.held = false;
        }
    }

    get isHeld(): boolean {
        return this.held;
    }
}
