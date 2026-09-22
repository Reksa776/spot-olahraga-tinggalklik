// Jest manual mock for `next-auth/react`.
//
// `next-auth/react` ships ESM (untranspiled `import`/`export`), which the ts-jest
// transform policy in `jest.config.js` does not transpile (`node_modules` is
// left to Node's own loader, and Node in a CommonJS test environment rejects the
// `import` statement). Components import from it directly — `SessionProvider`,
// `signIn`, `signOut`, `getSession`, `useSession` — so an ESM→CJS bridge here lets
// any suite that transitively loads a page/component using auth compile.
//
// The stubs are function-shaped so component code that merely references them
// (rather than exercising a logged-in flow) keeps working in isolation tests; SSR
// never calls `signIn`/`signOut` at import time.

// eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS mock, ESM would break `module.exports`.
const { createElement } = require("react");

function SessionProvider({ children, session: _session }) {
    return createElement("div", { "data-testid": "session-provider" }, children);
}

const signIn = jest.fn(async () => ({ ok: true, error: null, status: 200 }));
const signOut = jest.fn(async () => undefined);
const getSession = jest.fn(async () => null);

function useSession() {
    return { data: null, status: "unauthenticated", update: jest.fn() };
}

module.exports = {
    SessionProvider,
    signIn,
    signOut,
    getSession,
    useSession,
};