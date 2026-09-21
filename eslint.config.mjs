import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // ── CommonJS contexts ──────────────────────────────────────────────────────
  // Jest integration harnesses and the standalone scripts/custom server are plain
  // CommonJS: `require()` is the correct and only import form there. The base
  // typescript config forbids it, so it is scoped off for exactly those files rather
  // than disabled globally.
  {
    files: [
      "__tests__/**/*.{ts,tsx,js,jsx}",
      "scripts/**/*.{js,cjs}",
      // The PM2 process definition: `module.exports` is the only export form a `.cjs` file
      // has, and it is what `pm2 start` reads.
      "ecosystem.config.cjs",
      "server.js",
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
    // ── `_`-prefixed unused bindings are intentional ──────────────────────────
    // `_target`, `_input`, `_now` etc. mark a value that is deliberately not used
    // (a destructured discriminator, an intentionally-ignored parameter). Honouring
    // the leading underscore is the standard convention the codebase already follows.
  },
  {
    files: ["**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
