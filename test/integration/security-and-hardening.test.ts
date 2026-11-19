import { describe, it, expect, beforeEach, vi } from "vitest";
import worker, {
  SECURITY_HEADERS,
  getConfiguredAuthToken,
  timingSafeEqualStrings,
  type Env,
} from "../../src/index";
import { makeTestEnv, makeTestDb, makeVectorizeMock } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import { D1Mock } from "../helpers/d1-mock";

const ctx = { waitUntil: (_: Promise<any>) => {} } as any;

function expectSecurityHeaders(res: Response) {
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
    expect(res.headers.get(header)).toBe(value);
  }
}

describe("Security, health, and config hardening", () => {
  let db: D1Mock;
  let env: Env;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  describe("GET /healthz (unauthenticated liveness)", () => {
    it("returns 200 ok without auth and leaks no internal diagnostics", async () => {
      const res = await worker.fetch(req("GET", "/healthz", { token: null }), env, ctx);
      expect(res.status).toBe(200);
      expectSecurityHeaders(res);
      const data = await res.json() as any;
      expect(data).toEqual({
        ok: true,
        status: "ok",
        service: "second-brain",
      });
      expect(data.vectorize).toBeUndefined();
      expect(data.bindings).toBeUndefined();
    });
  });

  describe("GET /health (authenticated readiness)", () => {
    it("includes service, status, and binding checks when authenticated", async () => {
      const healthyEnv = makeTestEnv(db, {
        VECTORIZE: makeVectorizeMock({ describe: vi.fn().mockResolvedValue({ dimensions: 384 }) }),
      });
      const res = await worker.fetch(req("GET", "/health"), healthyEnv, ctx);
      expect(res.status).toBe(200);
      expectSecurityHeaders(res);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
      expect(data.status).toBe("ok");
      expect(data.service).toBe("second-brain");
      expect(data.bindings).toEqual({ db: true, ai: true, oauth_kv: true, vectorize: true });
    });

    it("reports degraded cleanly when VECTORIZE binding is missing", async () => {
      const degradedEnv = makeTestEnv(db, { VECTORIZE: undefined as any });
      const res = await worker.fetch(req("GET", "/health"), degradedEnv, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(false);
      expect(data.status).toBe("degraded");
      expect(data.vectorize.ok).toBe(false);
      expect(data.vectorize.error).toContain("VECTORIZE binding is not configured");
      expect(data.bindings.vectorize).toBe(false);
    });
  });

  describe("Auth fail-closed & timing-safe comparison", () => {
    it("timingSafeEqualStrings matches identical strings and rejects mismatches", () => {
      expect(timingSafeEqualStrings("secret-123", "secret-123")).toBe(true);
      expect(timingSafeEqualStrings("secret-123", "secret-124")).toBe(false);
      expect(timingSafeEqualStrings("short", "much-longer-secret")).toBe(false);
      expect(timingSafeEqualStrings("", "")).toBe(true);
    });

    it("getConfiguredAuthToken rejects missing, empty, or whitespace tokens", () => {
      expect(getConfiguredAuthToken(makeTestEnv(db, { AUTH_TOKEN: "" }))).toBeNull();
      expect(getConfiguredAuthToken(makeTestEnv(db, { AUTH_TOKEN: "   " }))).toBeNull();
      expect(getConfiguredAuthToken(makeTestEnv(db, { AUTH_TOKEN: undefined as any }))).toBeNull();
      expect(getConfiguredAuthToken(env)).toBe("test-token");
    });

    it("returns 503 and never authenticates Bearer undefined when AUTH_TOKEN is unset", async () => {
      const brokenEnv = makeTestEnv(db, { AUTH_TOKEN: undefined as any });
      const res = await worker.fetch(
        req("GET", "/count", { token: "undefined" }),
        brokenEnv,
        ctx,
      );
      expect(res.status).toBe(503);
      expectSecurityHeaders(res);
      const data = await res.json() as any;
      expect(data.ok).toBe(false);
      expect(data.error).toContain("AUTH_TOKEN");
    });

    it("returns 503 and never authenticates empty token when AUTH_TOKEN is blank", async () => {
      const brokenEnv = makeTestEnv(db, { AUTH_TOKEN: "" });
      const res = await worker.fetch(
        new Request("http://localhost/count?token="),
        brokenEnv,
        ctx,
      );
      expect(res.status).toBe(503);
    });

    it("rejects /mcp when AUTH_TOKEN is missing", async () => {
      const brokenEnv = makeTestEnv(db, { AUTH_TOKEN: undefined as any });
      const res = await worker.fetch(
        req("POST", "/mcp", { token: "undefined" }),
        brokenEnv,
        ctx,
      );
      expect(res.status).toBe(401);
    });

    it("returns 503 with no-store on /oauth/authorize when AUTH_TOKEN is missing", async () => {
      const brokenEnv = makeTestEnv(db, { AUTH_TOKEN: "" });
      const res = await worker.fetch(
        new Request("http://localhost/oauth/authorize"),
        brokenEnv,
        ctx,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expectSecurityHeaders(res);
    });
  });

  describe("Missing runtime bindings fail fast with 503", () => {
    it("POST /capture returns 503 when DB binding is missing", async () => {
      const noDbEnv = makeTestEnv(db, { DB: undefined as any });
      const res = await worker.fetch(req("POST", "/capture", { body: { content: "hi" } }), noDbEnv, ctx);
      expect(res.status).toBe(503);
      const data = await res.json() as any;
      expect(data.error).toContain("DB binding");
    });

    it("POST /chat returns 503 when AI binding is missing", async () => {
      const noAiEnv = makeTestEnv(db, { AI: undefined as any });
      const res = await worker.fetch(req("POST", "/chat", { body: { query: "hi" } }), noAiEnv, ctx);
      expect(res.status).toBe(503);
      const data = await res.json() as any;
      expect(data.error).toContain("AI binding");
    });

    it("GET /integrations returns 503 when OAUTH_KV binding is missing", async () => {
      const noKvEnv = makeTestEnv(db, { OAUTH_KV: undefined as any });
      const res = await worker.fetch(req("GET", "/integrations"), noKvEnv, ctx);
      expect(res.status).toBe(503);
      const data = await res.json() as any;
      expect(data.error).toContain("OAUTH_KV binding");
    });
  });

  describe("Security headers across HTTP responses", () => {
    it("sets security headers on OPTIONS, 404, 401, and authenticated /mcp responses", async () => {
      const optRes = await worker.fetch(new Request("http://localhost/capture", { method: "OPTIONS" }), env, ctx);
      expectSecurityHeaders(optRes);

      const notFoundRes = await worker.fetch(req("GET", "/does-not-exist"), env, ctx);
      expect(notFoundRes.status).toBe(404);
      expectSecurityHeaders(notFoundRes);

      const unauthRes = await worker.fetch(req("GET", "/count", { token: null }), env, ctx);
      expect(unauthRes.status).toBe(401);
      expectSecurityHeaders(unauthRes);

      const mcpRes = await worker.fetch(req("POST", "/mcp", { body: { jsonrpc: "2.0", method: "ping" } }), env, ctx);
      expectSecurityHeaders(mcpRes);
    });
  });

  describe("Malformed JSON & query parameter resilience", () => {
    for (const payload of ["null", "[]", '"just-a-string"', "42"]) {
      it(`POST /capture rejects non-object JSON payload (${payload}) with 400`, async () => {
        const request = new Request("http://localhost/capture", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: payload,
        });
        const res = await worker.fetch(request, env, ctx);
        expect(res.status).toBe(400);
        const data = await res.json() as any;
        expect(data.ok).toBe(false);
        expect(data.error).toBe("Invalid JSON");
      });
    }

    it("GET /recall accepts the ?q= query parameter alias used by hooks", async () => {
      const res = await worker.fetch(req("GET", "/recall?q=architecture&topK=bad&hops=bad"), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(data.ok).toBe(true);
    });

    it("GET /list falls back to safe default when n is non-numeric", async () => {
      const res = await worker.fetch(req("GET", "/list?n=notanumber"), env, ctx);
      expect(res.status).toBe(200);
      const data = await res.json() as any;
      expect(Array.isArray(data)).toBe(true);
    });
  });
});
