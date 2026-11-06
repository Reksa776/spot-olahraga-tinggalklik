import { PrismaClient } from "@prisma/client";

import { applyTestDatabaseUrl } from "./test-database";

/**
 * The other safety suite mocks `@prisma/client` so it can count construction. This suite does
 * the opposite on purpose: it imports the REAL generated client, installs the guard exactly as
 * `jest.setup-env.ts` does, and proves the patched export is the one test modules actually use.
 *
 * No connection is opened: every assertion here is a rejection thrown inside the guard, before
 * `super()` can build an engine, plus a successful construction that never queries.
 */

const APPLICATION_URL = "mysql://guard:guard@127.0.0.1:3306/guard_app";
const TEST_URL = "mysql://guard:guard@127.0.0.1:3306/guard_app_test";

describe("real @prisma/client import", () => {
    beforeAll(() => {
        process.env.DATABASE_URL = APPLICATION_URL;
        process.env.TEST_DATABASE_URL = TEST_URL;
        delete process.env.DIRECT_URL;
        delete process.env.SHADOW_DATABASE_URL;

        expect(applyTestDatabaseUrl()).toBe(TEST_URL);
    });

    afterAll(() => {
        delete process.env.DATABASE_URL;
        delete process.env.TEST_DATABASE_URL;
    });

    it("patches the PrismaClient binding that test files import", () => {
        expect(() => new PrismaClient({ datasourceUrl: APPLICATION_URL })).toThrow(
            /cannot override TEST_DATABASE_URL/
        );

        expect(() =>
            new PrismaClient({ datasources: { db: { url: APPLICATION_URL } } })
        ).toThrow(/cannot override TEST_DATABASE_URL/);
    });

    it("still accepts a client aimed at the validated test database", () => {
        // Construction alone does not query; the guard also rewrites the URL to the test target.
        const client = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
        expect(client).toBeDefined();
    });
});
