/**
 * Security Test: CSP Development-Only unsafe-eval
 *
 * Verifies that 'unsafe-eval' is ONLY included in script-src when
 * NODE_ENV === "development" (required by React 19 dev mode).
 *
 * Production CSP must NEVER contain 'unsafe-eval'.
 */

import nextConfig from "../../next.config";

// Helper to get the CSP value from the async headers function
async function getCspValue(): Promise<string> {
  const config = nextConfig as Record<string, unknown>;
  const headersFn = config.headers as () => Promise<unknown>;
  const result = await headersFn();

  // headers() returns Array<{ source: string; headers: Array<{ key: string; value: string }> }>
  const headersArray = result as Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;

  for (const entry of headersArray) {
    for (const h of entry.headers) {
      if (h.key === "Content-Security-Policy") {
        return h.value;
      }
    }
  }
  return "";
}

// Helper to get ALL headers as a map
async function getAllHeaders(): Promise<Record<string, string>> {
  const config = nextConfig as Record<string, unknown>;
  const headersFn = config.headers as () => Promise<unknown>;
  const result = await headersFn();

  const headersArray = result as Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;

  const allHeaders: Record<string, string> = {};
  for (const entry of headersArray) {
    for (const h of entry.headers) {
      allHeaders[h.key] = h.value;
    }
  }
  return allHeaders;
}

function getScriptSrc(csp: string): string {
  const directives = csp.split(";").map((d) => d.trim());
  for (const dir of directives) {
    if (dir.startsWith("script-src ")) {
      return dir;
    }
  }
  return "";
}

describe("CSP: environment-aware unsafe-eval", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: originalEnv,
      writable: true,
      configurable: true,
    });
  });

  it("production CSP must NOT contain unsafe-eval", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });

    const csp = await getCspValue();
    expect(csp).toBeTruthy();

    const scriptSrc = getScriptSrc(csp);
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("development CSP may contain unsafe-eval", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "development",
      writable: true,
      configurable: true,
    });

    const csp = await getCspValue();
    expect(csp).toBeTruthy();

    const scriptSrc = getScriptSrc(csp);
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it("all existing M4 CSP directives remain intact", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });

    const csp = await getCspValue();

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src");
    expect(csp).toContain("style-src");
    expect(csp).toContain("img-src");
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("all other security headers remain intact", async () => {
    const allHeaders = await getAllHeaders();

    // HSTS (M3)
    expect(allHeaders["Strict-Transport-Security"]).toContain(
      "max-age=31536000"
    );
    expect(allHeaders["Strict-Transport-Security"]).toContain(
      "includeSubDomains"
    );

    // X-Content-Type-Options
    expect(allHeaders["X-Content-Type-Options"]).toBe("nosniff");

    // X-Frame-Options
    expect(allHeaders["X-Frame-Options"]).toBe("DENY");

    // Referrer-Policy
    expect(allHeaders["Referrer-Policy"]).toBe(
      "strict-origin-when-cross-origin"
    );

    // X-XSS-Protection
    expect(allHeaders["X-XSS-Protection"]).toBe("1; mode=block");

    // Permissions-Policy — the camera is delegated to THIS origin for the gate scanner
    // (see next.config.ts); `camera=()` would block it in our own document.
    expect(allHeaders["Permissions-Policy"]).toContain("camera=(self)");
    expect(allHeaders["Permissions-Policy"]).toContain("microphone=()");
    expect(allHeaders["Permissions-Policy"]).toContain("geolocation=()");
  });

  it("production CSP does not introduce wildcard script sources", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });

    const csp = await getCspValue();
    const scriptSrc = getScriptSrc(csp);

    // No wildcards in production script-src
    expect(scriptSrc).not.toMatch(/\s\*\s*$/);
    expect(scriptSrc).not.toMatch(/\s\*$/);
    expect(scriptSrc).not.toContain(" 'unsafe-inline' 'unsafe-eval'");
  });

  it("script-src allows no third-party origin", async () => {
    // This used to assert that the TikTok analytics domain survived the production CSP. The
    // pixel was a retail component and was deleted with it, so the allowance was removed too —
    // and the assertion is now the inverse, which is the stronger property.
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });

    const csp = await getCspValue();
    const scriptSrc = getScriptSrc(csp);

    expect(scriptSrc).not.toContain("analytics.tiktok.com");
    expect(scriptSrc).not.toMatch(/https?:\/\//);
  });

  it("unsafe-inline is preserved in production CSP", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });

    const csp = await getCspValue();
    const scriptSrc = getScriptSrc(csp);

    expect(scriptSrc).toContain("'unsafe-inline'");
  });
});
