module.exports = {
    preset: "ts-jest",
    testEnvironment: "node",
    moduleNameMapper: { "^@/(.*)$": "<rootDir>/$1" },
    testMatch: ["**/__tests__/support/test-database*.test.ts"],
    setupFiles: [],
    setupFilesAfterEnv: [],
    globalSetup: undefined,
    globalTeardown: undefined,
    transform: {
        "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
    },
};
