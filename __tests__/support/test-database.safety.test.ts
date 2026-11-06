import { PrismaClient } from "@prisma/client";

import globalSetup from "./global-setup";
import globalTeardown from "./fixture-teardown";
import {
    applyTestDatabaseUrl,
    resolveTestDatabaseUrl,
} from "./test-database";

jest.mock("@prisma/client", () => ({
    PrismaClient: jest.fn().mockImplementation((options) => ({
        options,
        $queryRawUnsafe: jest.fn().mockResolvedValue([{ c: 999 }]),
        $disconnect: jest.fn().mockResolvedValue(undefined),
        organizer: { findMany: jest.fn().mockResolvedValue([]) },
        event: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
        sport: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    })),
}));

const applicationUrl = "mysql://app:secret@localhost:3306/tinggalklik";
const testUrl = "mysql://app:secret@localhost:3306/tinggalklik_test";
const prismaMock = PrismaClient as jest.Mock;

function setUrls(test?: string, app = applicationUrl): void {
    process.env.DATABASE_URL = app;
    if (test === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = test;
    delete process.env.DIRECT_URL;
    delete process.env.SHADOW_DATABASE_URL;
}

beforeEach(() => {
    jest.clearAllMocks();
    setUrls();
});

afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
});

describe("Jest database isolation safety", () => {
    it("accepts an explicit isolated test URL", () => {
        expect(resolveTestDatabaseUrl({ DATABASE_URL: applicationUrl, TEST_DATABASE_URL: testUrl })).toBe(testUrl);
    });

    it("rejects an empty test URL without falling back to the application URL", () => {
        expect(() => resolveTestDatabaseUrl({ DATABASE_URL: applicationUrl })).toThrow("TEST_DATABASE_URL is required");
        expect(prismaMock).not.toHaveBeenCalled();
    });

    it("rejects the application database even when the test variable is explicitly set", () => {
        expect(() => resolveTestDatabaseUrl({ DATABASE_URL: applicationUrl, TEST_DATABASE_URL: applicationUrl })).toThrow("resolves to the application database");
        expect(prismaMock).not.toHaveBeenCalled();
    });

    it("rejects an equal database target with normalized host and case", () => {
        expect(() => resolveTestDatabaseUrl({
            DATABASE_URL: "mysql://app:secret@LOCALHOST/tinggalklik",
            TEST_DATABASE_URL: "mysql://app:secret@localhost:3306/TINGGALKLIK",
        })).toThrow("resolves to the application database");
    });

    it("rejects unsafe alternate Prisma datasource environment variables", () => {
        expect(() => resolveTestDatabaseUrl({
            DATABASE_URL: applicationUrl,
            TEST_DATABASE_URL: testUrl,
            DIRECT_URL: applicationUrl,
        })).toThrow("DIRECT_URL must not override");
    });

    it("fails global setup closed before creating Prisma when TEST_DATABASE_URL is empty", async () => {
        setUrls();
        await expect(globalSetup()).rejects.toThrow("TEST_DATABASE_URL is required");
        expect(prismaMock).not.toHaveBeenCalled();
    });

    it("fails global setup closed before querying when TEST_DATABASE_URL equals the app database", async () => {
        setUrls(applicationUrl);
        await expect(globalSetup()).rejects.toThrow("resolves to the application database");
        expect(prismaMock).not.toHaveBeenCalled();
    });

    it("fails teardown closed before creating Prisma when TEST_DATABASE_URL is empty", async () => {
        setUrls();
        await expect(globalTeardown()).rejects.toThrow("TEST_DATABASE_URL is required");
        expect(prismaMock).not.toHaveBeenCalled();
    });

    it("fails teardown closed before querying when TEST_DATABASE_URL equals the app database", async () => {
        setUrls(applicationUrl);
        await expect(globalTeardown()).rejects.toThrow("resolves to the application database");
        expect(prismaMock).not.toHaveBeenCalled();
    });

    it("pins setup and cleanup Prisma clients to the validated test URL only", async () => {
        setUrls(testUrl);
        await globalSetup();
        await globalTeardown();

        const constructedTargets = prismaMock.mock.calls.map(([options]) => options.datasources.db.url);
        expect(constructedTargets).toEqual([testUrl, testUrl]);
        expect(constructedTargets).not.toContain(applicationUrl);
    });

    it("stays isolated when setupFiles runs again for the next file in the same worker", () => {
        setUrls(testUrl);
        expect(applyTestDatabaseUrl()).toBe(testUrl);

        // The worker now holds the test URL in DATABASE_URL; the next test file's setupFiles
        // sees that same value. It must not mistake it for the application database.
        expect(process.env.DATABASE_URL).toBe(testUrl);
        expect(applyTestDatabaseUrl()).toBe(testUrl);
        expect(process.env.DATABASE_URL).toBe(testUrl);
    });

    it("rewrites worker DATABASE_URL and rejects direct application datasource overrides", () => {
        setUrls(testUrl);
        expect(applyTestDatabaseUrl()).toBe(testUrl);
        expect(process.env.DATABASE_URL).toBe(testUrl);

        const guardedClient = new PrismaClient({ datasources: { db: { url: testUrl } } });
        expect(guardedClient).toBeDefined();
        expect(() => new PrismaClient({ datasources: { db: { url: applicationUrl } } })).toThrow("cannot override TEST_DATABASE_URL");
        process.env.DATABASE_URL = applicationUrl;
        expect(() => new PrismaClient()).toThrow("Database environment changed after Jest isolation was established");
    });
});
