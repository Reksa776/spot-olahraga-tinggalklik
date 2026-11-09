import {
    createCipheriv,
    createDecipheriv,
    randomBytes,
    randomUUID,
} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * AES-256-GCM encrypted JSON storage for Baileys auth state.
 *
 * The encrypted file lives in the private session directory (`WA_AUTH_DIR`), the directory is `0700`
 * and the file is `0600`. Writes are atomic: a freshly-created `0600` temp file in the same
 * directory is fsynced and renamed over the target. No plaintext auth material is ever
 * written to disk.
 *
 * The key is supplied by the host environment (`WA_SESSION_ENCRYPTION_KEY`) or generated once
 * by the gateway and stored as a private file beside the session. Loss of the key
 * is equivalent to losing the session and requires re-pairing; the key must not be committed
 * or copied into the repository.
 */

const VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from("tinggalklik.whatsapp.session.v1", "utf8");

export class SessionStorageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SessionStorageError";
    }
}

export class SessionDecryptionError extends SessionStorageError {
    constructor() {
        // Deliberately generic: do not echo key material, ciphertext or auth contents.
        super("The encrypted WhatsApp session could not be decrypted.");
        this.name = "SessionDecryptionError";
    }
}

type Envelope = {
    v: number;
    iv: string;
    tag: string;
    data: string;
};

type StoreOptions<T> = {
    directory: string;
    key: Buffer;
    fileName?: string;
    serialize?: (value: T) => string;
    deserialize?: (raw: string) => T;
};

function assertKey(key: Buffer): void {
    if (!Buffer.isBuffer(key) || key.length !== 32) {
        throw new SessionStorageError(
            "The session encryption key must be exactly 32 bytes."
        );
    }
}

function encrypt(value: unknown, key: Buffer, serialize: (value: unknown) => string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    cipher.setAAD(AAD);

    const plaintext = Buffer.from(serialize(value), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const envelope: Envelope = {
        v: VERSION,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        data: ciphertext.toString("base64"),
    };

    return JSON.stringify(envelope);
}

function parseEnvelope(raw: string): Envelope {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new SessionDecryptionError();
    }

    if (
        typeof parsed !== "object" ||
        parsed === null ||
        (parsed as Envelope).v !== VERSION ||
        typeof (parsed as Envelope).iv !== "string" ||
        typeof (parsed as Envelope).tag !== "string" ||
        typeof (parsed as Envelope).data !== "string"
    ) {
        throw new SessionDecryptionError();
    }

    return parsed as Envelope;
}

function decrypt(
    raw: string,
    key: Buffer,
    deserialize: (raw: string) => unknown
): unknown {
    const envelope = parseEnvelope(raw);
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.data, "base64");

    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new SessionDecryptionError();
    }

    try {
        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(AAD);
        decipher.setAuthTag(tag);

        const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
        ]);

        return deserialize(plaintext.toString("utf8"));
    } catch {
        throw new SessionDecryptionError();
    }
}

export class EncryptedJsonStore<T> {
    private readonly directory: string;
    private readonly filePath: string;
    private readonly key: Buffer;
    private readonly serialize: (value: T) => string;
    private readonly deserialize: (raw: string) => T;

    constructor(options: StoreOptions<T>) {
        assertKey(options.key);

        this.directory = path.resolve(
            /* turbopackIgnore: true */ options.directory
        );
        this.filePath = path.join(
            /* turbopackIgnore: true */ this.directory,
            options.fileName ?? "auth.enc"
        );
        this.key = options.key;
        this.serialize = options.serialize ?? ((value) => JSON.stringify(value) ?? "null");
        this.deserialize =
            options.deserialize ?? ((raw) => JSON.parse(raw) as T);
    }

    get path(): string {
        return this.filePath;
    }

    async ensureDirectory(): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });

        const stat = await fs.lstat(this.directory);

        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new SessionStorageError(
                "The WhatsApp session path must be a real directory, not a symlink."
            );
        }

        if ((stat.mode & 0o777) !== 0o700) {
            await fs.chmod(this.directory, 0o700);
        }
    }

    async exists(): Promise<boolean> {
        await this.ensureDirectory();

        try {
            const stat = await fs.lstat(this.filePath);

            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new SessionStorageError(
                    "The WhatsApp session file must be a regular file, not a symlink."
                );
            }

            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return false;
            }

            throw error;
        }
    }

    async read(): Promise<T | null> {
        if (!(await this.exists())) {
            return null;
        }

        const stat = await fs.lstat(this.filePath);

        if ((stat.mode & 0o077) !== 0) {
            await fs.chmod(this.filePath, 0o600);
        }

        const raw = await fs.readFile(this.filePath, "utf8");

        return decrypt(raw, this.key, this.deserialize) as T;
    }

    async write(value: T): Promise<void> {
        await this.ensureDirectory();

        const payload = encrypt(value, this.key, (unknownValue) =>
            this.serialize(unknownValue as T)
        );
        const tempPath = path.join(
            /* turbopackIgnore: true */ this.directory,
            `.${path.basename(this.filePath)}.${process.pid}.${randomUUID()}.tmp`
        );
        const handle = await fs.open(tempPath, "wx", 0o600);

        try {
            await handle.writeFile(payload, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }

        try {
            await fs.rename(tempPath, this.filePath);
            await fs.chmod(this.filePath, 0o600);
        } catch (error) {
            await fs.rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    async remove(): Promise<void> {
        await this.ensureDirectory();

        try {
            const stat = await fs.lstat(this.filePath);

            if (!stat.isFile() || stat.isSymbolicLink()) {
                throw new SessionStorageError(
                    "The WhatsApp session file must be a regular file, not a symlink."
                );
            }

            await fs.unlink(this.filePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    }
}
