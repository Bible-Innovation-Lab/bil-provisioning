import { describe, expect, it } from "vitest";
import { redact, redactObject } from "../lib/log.js";

describe("redact — known token shapes", () => {
  it("redacts Vercel tokens (vck_)", () => {
    const out = redact("Authorization: Bearer vck_abcdefghijklmnopqrstuvwx");
    expect(out).not.toContain("vck_abcdefghijklmnopqrstuvwx");
    expect(out).toContain("<redacted>");
  });

  it("redacts Vercel personal tokens (vcp_)", () => {
    const out = redact("vcp_aaaaaaaaaaaaaaaaaaaaaa12");
    expect(out).toBe("<redacted>");
  });

  it("redacts PostHog public keys (phc_)", () => {
    const out = redact("phc_examplekeydoesnotleakposthog");
    expect(out).toBe("<redacted>");
  });

  it("redacts PostHog private keys (phx_, phs_)", () => {
    expect(redact("phx_abcdef1234567890abcdef")).toBe("<redacted>");
    expect(redact("phs_abcdef1234567890abcdef")).toBe("<redacted>");
  });

  it("redacts GitHub OAuth tokens", () => {
    const out = redact("token=ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(out).not.toMatch(/ghu_a+/);
  });

  it("redacts bearer values regardless of token shape", () => {
    const out = redact("Authorization: Bearer some-opaque-jwt.payload.signature");
    expect(out).toContain("Bearer <redacted>");
  });
});

describe("redact — does not over-redact normal log content", () => {
  it("leaves app-ids, project ids, and short strings alone", () => {
    const out = redact("provisioned app_id=bible-trivia project_id=prj_abc123");
    expect(out).toBe("provisioned app_id=bible-trivia project_id=prj_abc123");
  });

  it("leaves short alphanumerics alone", () => {
    expect(redact("status=ok count=42")).toBe("status=ok count=42");
  });

  it("returns input unchanged when no patterns match", () => {
    const s = "hello world, all good here";
    expect(redact(s)).toBe(s);
  });
});

describe("redactObject — recursive sanitization", () => {
  it("redacts string fields whose key looks secret-shaped", () => {
    const out = redactObject({
      app_id: "bible-trivia",
      vercelToken: "vck_aaaaaaaaaaaaaaaaaaaaaaaaa",
      api_key: "anything-here-at-all",
      user: { name: "alice", password: "hunter2" },
    });
    expect(out).toEqual({
      app_id: "bible-trivia",
      vercelToken: "<redacted>",
      api_key: "<redacted>",
      user: { name: "alice", password: "<redacted>" },
    });
  });

  it("redacts token values inside non-secret-keyed fields", () => {
    const out = redactObject({
      message: "Bearer ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa expired",
    });
    expect((out as { message: string }).message).toContain("Bearer <redacted>");
  });

  it("walks arrays and nested objects", () => {
    const out = redactObject([
      { authorization: "Bearer vck_xxxxxxxxxxxxxxxxxxxxxx" },
      "phc_aaaaaaaaaaaaaaaaaaaaaa",
    ]);
    expect(out).toEqual([{ authorization: "<redacted>" }, "<redacted>"]);
  });

  it("passes through primitives and null", () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(true)).toBe(true);
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
  });
});
