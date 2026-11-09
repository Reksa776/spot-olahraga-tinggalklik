import path from "node:path";

/**
 * ==========================================
 * WHATSAPP SESSION DIRECTORY ISOLATION
 * ==========================================
 *
 * The WhatsApp session tree is the ONLY filesystem tree a disconnect may delete, and the
 * application's authentication material must never live in it. This module is the single
 * place that decides whether a configured `WA_AUTH_DIR` is a dedicated directory.
 *
 * The rules are deliberately about the RELATIONSHIP between the session directory and the
 * project, not about the project's own file list:
 *
 *   - a filesystem root is refused;
 *   - the project root is refused;
 *   - any ANCESTOR of the project root is refused — this is the case that matters, because
 *     `WA_AUTH_DIR=.` (or `/`) puts `.env` (and therefore `AUTH_SECRET`) inside the tree
 *     that `deleteSession=true` empties;
 *   - a directory that directly contains application/secret files (`.env`, `package.json`,
 *     `.git`, ...) is refused by `findApplicationEntry`, which the cleanup additionally
 *     checks before deleting anything.
 *
 * A subdirectory of the project (the default `storage/whatsapp-gateway`) and an absolute
 * host path outside the project (the documented production layout) are both accepted.
 */

/** Ownership/key evidence and the session encryption key are not session material. */
export const PRESERVED_SESSION_ENTRIES = [
    ".gateway.lock",
    ".session-key",
] as const;

/**
 * Names that identify a directory as part of the application rather than a session store.
 * `.env` is the critical one: it holds `AUTH_SECRET`, which signs and encrypts every
 * application session cookie.
 */
const APPLICATION_ENTRY_NAMES: readonly string[] = [
    ".env",
    ".env.local",
    ".env.production",
    ".git",
    "package.json",
    "prisma",
    "app",
    "node_modules",
];

export type SessionDirIsolationResult =
    | { ok: true; directory: string }
    | {
          ok: false;
          code: "FILESYSTEM_ROOT" | "PROJECT_ROOT_OR_ANCESTOR";
          message: string;
      };

/** TRUE when `candidate` is `target` itself or one of its ancestors. */
export function isSameOrAncestor(candidate: string, target: string): boolean {
    const relative = path.relative(
        path.resolve(/* turbopackIgnore: true */ candidate),
        path.resolve(/* turbopackIgnore: true */ target)
    );

    return (
        relative === "" ||
        (relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
    );
}

/**
 * Validate a session directory. Pure: no filesystem access, no logging.
 *
 * `projectRoot` defaults to `process.cwd()` because that is what the web server, the
 * notification worker and the pairing CLI all resolve the project against.
 */
export function checkSessionDirIsolation(
    sessionDir: string,
    options: { projectRoot?: string } = {}
): SessionDirIsolationResult {
    const directory = path.resolve(
        /* turbopackIgnore: true */ sessionDir
    );
    const projectRoot = path.resolve(
        /* turbopackIgnore: true */ options.projectRoot ?? process.cwd()
    );

    if (directory === path.parse(directory).root) {
        return {
            ok: false,
            code: "FILESYSTEM_ROOT",
            message: "Refusing to use a filesystem root as the WhatsApp session directory.",
        };
    }

    if (isSameOrAncestor(directory, projectRoot)) {
        return {
            ok: false,
            code: "PROJECT_ROOT_OR_ANCESTOR",
            message:
                "The WhatsApp session directory must not be the project root or an ancestor of it.",
        };
    }

    return { ok: true, directory };
}

/**
 * Return the first entry name that identifies application configuration, or `null`.
 * Used by the cleanup BEFORE the first deletion, so a misconfigured directory is refused
 * with every file still in place.
 */
export function findApplicationEntry(entries: readonly string[]): string | null {
    return (
        entries.find(
            (entry) => APPLICATION_ENTRY_NAMES.includes(entry)
        ) ?? null
    );
}
