/**
 * Resolve and enforce the only database target allowed for Jest.
 * A `_test` suffix is an additional convention, not the safety check: the URL must be
 * explicit, parseable, point to a test-named MySQL schema, and differ from the application
 * schema on the same normalized server identity.
 */
export const TEST_DATABASE_SUFFIX = "_test";

export type TestDatabaseEnvironment = Record<string, string | undefined>;

type MysqlIdentity = {
    database: string;
    host: string;
    port: number;
};

function mysqlIdentity(rawUrl: string, variableName: string): MysqlIdentity {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`${variableName} must be an absolute MySQL URL.`);
    }

    if (parsed.protocol !== "mysql:" || !parsed.hostname || !parsed.username) {
        throw new Error(`${variableName} must identify a MySQL server and database.`);
    }

    let database: string;
    try {
        database = decodeURIComponent(parsed.pathname.slice(1));
    } catch {
        throw new Error(`${variableName} has an invalid database name.`);
    }

    if (!/^[A-Za-z0-9][A-Za-z0-9_$-]{0,63}$/.test(database)) {
        throw new Error(`${variableName} must contain one unambiguous MySQL database name.`);
    }

    return {
        database: database.toLowerCase(),
        host: parsed.hostname.toLowerCase(),
        port: parsed.port ? Number(parsed.port) : 3306,
    };
}

function sameServerTarget(left: MysqlIdentity, right: MysqlIdentity): boolean {
    return left.host === right.host && left.port === right.port;
}

/** Validate explicit test and application identities without opening a database connection. */
export function resolveTestDatabaseUrl(env: TestDatabaseEnvironment): string {
    const testUrl = env.TEST_DATABASE_URL?.trim();
    const applicationUrl = env.DATABASE_URL?.trim();

    if (!testUrl) {
        throw new Error("TEST_DATABASE_URL is required; Jest will not derive or fall back to DATABASE_URL.");
    }
    if (!applicationUrl) {
        throw new Error("DATABASE_URL is required to prove TEST_DATABASE_URL is not the application database.");
    }

    const test = mysqlIdentity(testUrl, "TEST_DATABASE_URL");
    const application = mysqlIdentity(applicationUrl, "DATABASE_URL");

    if (!sameServerTarget(test, application)) {
        throw new Error("TEST_DATABASE_URL must use the same explicit MySQL host and port as DATABASE_URL; server identity is otherwise ambiguous.");
    }
    if (test.database === application.database) {
        throw new Error("TEST_DATABASE_URL resolves to the application database; refusing to connect.");
    }
    if (!test.database.endsWith(TEST_DATABASE_SUFFIX)) {
        throw new Error(`TEST_DATABASE_URL database name must end in '${TEST_DATABASE_SUFFIX}'.`);
    }
    if (application.database.endsWith(TEST_DATABASE_SUFFIX)) {
        throw new Error("DATABASE_URL is ambiguous because its database name uses the reserved test suffix.");
    }

    for (const alias of ["DIRECT_URL", "SHADOW_DATABASE_URL"] as const) {
        const aliasUrl = env[alias];
        if (!aliasUrl) continue;
        const aliasIdentity = mysqlIdentity(aliasUrl, alias);
        if (!sameServerTarget(aliasIdentity, test) || aliasIdentity.database !== test.database) {
            throw new Error(`${alias} must not override the isolated Jest database target.`);
        }
    }

    return testUrl;
}

/**
 * The original application URL, remembered for the lifetime of a Jest worker.
 *
 * `setupFiles` runs again for every test FILE, and `DATABASE_URL` has already been redirected
 * by the previous file, so the worker must remember what the application URL was rather than
 * re-reading a value it has itself replaced. Without this, the second file would compare the
 * test URL with itself and fail closed for the wrong reason.
 */
const APPLICATION_URL_STATE = Symbol.for("tinggalklik.jest.applicationDatabaseUrl");

type ApplicationUrlState = { applicationUrl: string | undefined };

/** Redirect Prisma's normal datasource to an explicitly validated test URL. */
export function applyTestDatabaseUrl(env: TestDatabaseEnvironment = process.env): string {
    const state = globalThis as unknown as Record<symbol, ApplicationUrlState | undefined>;
    const remembered = state[APPLICATION_URL_STATE];
    const applicationUrl = remembered ? remembered.applicationUrl : env.DATABASE_URL;

    if (!applicationUrl) {
        throw new Error("DATABASE_URL is required to prove Jest is isolated from the application database.");
    }

    const testUrl = resolveTestDatabaseUrl({
        ...env,
        DATABASE_URL: applicationUrl,
        TEST_DATABASE_URL: env.TEST_DATABASE_URL,
    });

    env.DATABASE_URL = testUrl;
    installTestDatabasePrismaGuard(testUrl, applicationUrl);
    installIsolatedProcessEnvironment(testUrl, applicationUrl);
    state[APPLICATION_URL_STATE] = { applicationUrl };

    return testUrl;
}

/**
 * Patch the @prisma/client export before test modules are evaluated. Test code may still
 * supply Prisma datasource overrides; those are rejected unless they identify the exact
 * validated test database. The wrapper then pins every instance to that URL.
 */
export function installIsolatedProcessEnvironment(
    testUrl: string,
    applicationUrl = process.env.DATABASE_URL
): void {
    if (!applicationUrl) {
        throw new Error("DATABASE_URL is required to prove Jest is isolated from the application database.");
    }
    resolveTestDatabaseUrl({
        ...process.env,
        DATABASE_URL: applicationUrl,
        TEST_DATABASE_URL: testUrl,
    });
    // Prisma is the only database client used by this project’s tests. Its constructor guard
    // checks DATABASE_URL on every instantiation and pins every datasource override; do not
    // make process.env itself immutable because config tests intentionally replace env objects.
    Object.assign(process.env, {
        DATABASE_URL: testUrl,
        TEST_DATABASE_URL: testUrl,
        ...(process.env.DIRECT_URL ? { DIRECT_URL: testUrl } : {}),
        ...(process.env.SHADOW_DATABASE_URL ? { SHADOW_DATABASE_URL: testUrl } : {}),
    });
}

export function installTestDatabasePrismaGuard(
    testUrl: string,
    applicationUrl = process.env.DATABASE_URL
): void {
    if (!applicationUrl) {
        throw new Error("DATABASE_URL is required to prove Jest is isolated from the application database.");
    }
    const validatedUrl = resolveTestDatabaseUrl({
        ...process.env,
        DATABASE_URL: applicationUrl,
        TEST_DATABASE_URL: testUrl,
    });
    const configuredDatabaseUrl = process.env.DATABASE_URL;
    const configuredTestUrl = process.env.TEST_DATABASE_URL;
    const configuredDirectUrl = process.env.DIRECT_URL;
    const configuredShadowUrl = process.env.SHADOW_DATABASE_URL;
    const prismaModule = requireFromModule();
    const NativePrismaClient = prismaModule.PrismaClient as {
        new (options?: unknown): object;
    };
    type PrismaOptions = ConstructorParameters<typeof NativePrismaClient>[0];

    class IsolatedTestPrismaClient extends (NativePrismaClient as new (options?: PrismaOptions) => object) {
        constructor(options?: PrismaOptions) {
            const supplied = (options ?? {}) as {
                datasourceUrl?: unknown;
                datasources?: { db?: { url?: unknown }; [name: string]: unknown };
                [name: string]: unknown;
            };
            const explicitUrl =
                supplied.datasourceUrl ?? supplied.datasources?.db?.url;
            if (explicitUrl !== undefined && explicitUrl !== validatedUrl) {
                throw new Error("A Jest PrismaClient cannot override TEST_DATABASE_URL.");
            }
            if (
                process.env.DATABASE_URL !== configuredDatabaseUrl ||
                process.env.TEST_DATABASE_URL !== configuredTestUrl ||
                process.env.DIRECT_URL !== configuredDirectUrl ||
                process.env.SHADOW_DATABASE_URL !== configuredShadowUrl
            ) {
                throw new Error("Database environment changed after Jest isolation was established.");
            }

            const { datasourceUrl: _datasourceUrl, ...rest } = supplied;
            const datasources = (rest.datasources ?? {}) as Record<string, unknown>;
            const dbOptions = (datasources.db ?? {}) as Record<string, unknown>;
            super({
                ...rest,
                datasources: {
                    ...datasources,
                    db: { ...dbOptions, url: validatedUrl },
                },
            } as PrismaOptions);
        }
    }

    Object.defineProperty(prismaModule, "PrismaClient", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: IsolatedTestPrismaClient,
    });
}

function requireFromModule(): { PrismaClient: new (...args: never[]) => object } {
    // `@prisma/client` is generated CommonJS; resolve the module through Node’s native loader.
    return createRequireFromHere()("@prisma/client") as { PrismaClient: new (...args: never[]) => object };
}

function createRequireFromHere(): (id: string) => unknown {
    return require("node:module").createRequire(__filename) as (id: string) => unknown;
}
