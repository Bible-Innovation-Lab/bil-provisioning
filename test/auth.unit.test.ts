import { RequestError } from "@octokit/request-error";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  authenticateAdmin,
  authenticateOrgMember,
  parseBearerToken,
  requireAdminTeamMember,
  requireOrgMember,
  verifyGitHubToken,
  type AuthConfig,
  type OctokitRequest,
} from "../lib/auth.js";

const CONFIG: AuthConfig = {
  org: "Bible-Innovation-Lab",
  adminTeamSlug: "platform-admins",
};

const VALID_TOKEN = "ghu_validfake000000000000000000000000";

function httpError(status: number): RequestError {
  // Synthesize the shape octokit throws on non-2xx. We only need .name + .status.
  return new RequestError("synthetic", status, {
    request: {
      method: "GET",
      url: "https://api.github.com/test",
      headers: {},
    },
  });
}

function mockRequest(handler: (route: string, options?: Record<string, unknown>) => unknown) {
  return vi.fn<OctokitRequest>(async (route, options) => {
    const result = handler(route, options);
    if (result instanceof Error) throw result;
    return result as { status: number; data: unknown };
  });
}

describe("parseBearerToken", () => {
  it("extracts the token from a well-formed header", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });
  it("is case-insensitive on the scheme", () => {
    expect(parseBearerToken("bearer xyz")).toBe("xyz");
    expect(parseBearerToken("BEARER xyz")).toBe("xyz");
  });
  it("trims whitespace around the token", () => {
    expect(parseBearerToken("Bearer   spacey   ")).toBe("spacey");
  });
  it("returns null for missing or malformed headers", () => {
    expect(parseBearerToken(null)).toBeNull();
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Basic abc")).toBeNull();
    expect(parseBearerToken("abc")).toBeNull();
  });
});

describe("verifyGitHubToken", () => {
  it("returns { login } on a 200 response", async () => {
    const req = mockRequest(() => ({ status: 200, data: { login: "alice" } }));
    await expect(verifyGitHubToken(VALID_TOKEN, req)).resolves.toEqual({ login: "alice" });
    expect(req).toHaveBeenCalledWith("GET /user", {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
  });

  it("throws AuthError(401, invalid_token) when GitHub returns 401", async () => {
    const req = mockRequest(() => httpError(401));
    await expect(verifyGitHubToken("expired", req)).rejects.toMatchObject({
      name: "AuthError",
      code: "invalid_token",
      status: 401,
    });
  });

  it("throws AuthError(502, github_unavailable) on a 503", async () => {
    const req = mockRequest(() => httpError(503));
    await expect(verifyGitHubToken(VALID_TOKEN, req)).rejects.toMatchObject({
      code: "github_unavailable",
      status: 502,
    });
  });

  it("throws AuthError(401, missing_token) for empty/non-string input", async () => {
    const req = mockRequest(() => ({ status: 200, data: { login: "alice" } }));
    await expect(verifyGitHubToken("", req)).rejects.toMatchObject({
      code: "missing_token",
      status: 401,
    });
    expect(req).not.toHaveBeenCalled();
  });

  it("throws invalid_token if response has no login field", async () => {
    const req = mockRequest(() => ({ status: 200, data: {} }));
    await expect(verifyGitHubToken(VALID_TOKEN, req)).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
  });

  it("wraps a generic network error as github_unavailable", async () => {
    const req = mockRequest(() => new Error("ECONNREFUSED"));
    await expect(verifyGitHubToken(VALID_TOKEN, req)).rejects.toMatchObject({
      code: "github_unavailable",
      status: 502,
    });
  });
});

describe("requireOrgMember", () => {
  it("resolves silently for active members", async () => {
    const req = mockRequest(() => ({ status: 200, data: { state: "active", role: "member" } }));
    await expect(requireOrgMember(VALID_TOKEN, CONFIG, req)).resolves.toBeUndefined();
    expect(req).toHaveBeenCalledWith("GET /user/memberships/orgs/{org}", {
      org: "Bible-Innovation-Lab",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
  });

  it("rejects pending memberships as not_org_member", async () => {
    const req = mockRequest(() => ({ status: 200, data: { state: "pending" } }));
    await expect(requireOrgMember(VALID_TOKEN, CONFIG, req)).rejects.toMatchObject({
      code: "not_org_member",
      status: 403,
    });
  });

  it("converts 404 to not_org_member 403", async () => {
    const req = mockRequest(() => httpError(404));
    await expect(requireOrgMember(VALID_TOKEN, CONFIG, req)).rejects.toMatchObject({
      code: "not_org_member",
      status: 403,
    });
  });

  it("converts 401 to invalid_token (token revoked mid-flow)", async () => {
    const req = mockRequest(() => httpError(401));
    await expect(requireOrgMember(VALID_TOKEN, CONFIG, req)).rejects.toMatchObject({
      code: "invalid_token",
      status: 401,
    });
  });

  it("converts 5xx to github_unavailable 502", async () => {
    const req = mockRequest(() => httpError(502));
    await expect(requireOrgMember(VALID_TOKEN, CONFIG, req)).rejects.toMatchObject({
      code: "github_unavailable",
      status: 502,
    });
  });
});

describe("requireAdminTeamMember", () => {
  it("resolves for active team members", async () => {
    const req = mockRequest(() => ({ status: 200, data: { state: "active", role: "member" } }));
    await expect(requireAdminTeamMember(VALID_TOKEN, "alice", CONFIG, req)).resolves.toBeUndefined();
    expect(req).toHaveBeenCalledWith(
      "GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
      {
        org: "Bible-Innovation-Lab",
        team_slug: "platform-admins",
        username: "alice",
        headers: { authorization: `Bearer ${VALID_TOKEN}` },
      }
    );
  });

  it("rejects pending team membership as not_admin", async () => {
    const req = mockRequest(() => ({ status: 200, data: { state: "pending" } }));
    await expect(requireAdminTeamMember(VALID_TOKEN, "bob", CONFIG, req)).rejects.toMatchObject({
      code: "not_admin",
      status: 403,
    });
  });

  it("converts 404 to not_admin", async () => {
    const req = mockRequest(() => httpError(404));
    await expect(requireAdminTeamMember(VALID_TOKEN, "bob", CONFIG, req)).rejects.toMatchObject({
      code: "not_admin",
      status: 403,
    });
  });
});

describe("authenticateOrgMember composition", () => {
  it("happy path: verifyGitHubToken → requireOrgMember", async () => {
    const req = mockRequest((route) => {
      if (route === "GET /user") return { status: 200, data: { login: "alice" } };
      if (route === "GET /user/memberships/orgs/{org}") {
        return { status: 200, data: { state: "active" } };
      }
      throw new Error(`unexpected route: ${route}`);
    });
    await expect(authenticateOrgMember(VALID_TOKEN, CONFIG, req)).resolves.toEqual({
      login: "alice",
    });
    expect(req).toHaveBeenCalledTimes(2);
  });

  it("short-circuits on invalid token (membership check never runs)", async () => {
    const req = mockRequest((route) => {
      if (route === "GET /user") return httpError(401);
      throw new Error(`unexpected route: ${route}`);
    });
    await expect(authenticateOrgMember("bad", CONFIG, req)).rejects.toMatchObject({
      code: "invalid_token",
    });
    expect(req).toHaveBeenCalledTimes(1);
  });

  it("propagates not_org_member after a valid token", async () => {
    const req = mockRequest((route) => {
      if (route === "GET /user") return { status: 200, data: { login: "outsider" } };
      if (route === "GET /user/memberships/orgs/{org}") return httpError(404);
      throw new Error(`unexpected route: ${route}`);
    });
    await expect(authenticateOrgMember(VALID_TOKEN, CONFIG, req)).rejects.toMatchObject({
      code: "not_org_member",
      status: 403,
    });
  });
});

describe("authenticateAdmin composition", () => {
  it("happy path: verifyGitHubToken → requireAdminTeamMember(login)", async () => {
    const seenUsernames: string[] = [];
    const req = mockRequest((route, options) => {
      if (route === "GET /user") return { status: 200, data: { login: "admin-alice" } };
      if (route === "GET /orgs/{org}/teams/{team_slug}/memberships/{username}") {
        seenUsernames.push((options as { username: string }).username);
        return { status: 200, data: { state: "active" } };
      }
      throw new Error(`unexpected route: ${route}`);
    });
    await expect(authenticateAdmin(VALID_TOKEN, CONFIG, req)).resolves.toEqual({
      login: "admin-alice",
    });
    expect(seenUsernames).toEqual(["admin-alice"]);
  });

  it("an org member who isn't on the admin team is rejected as not_admin", async () => {
    const req = mockRequest((route) => {
      if (route === "GET /user") return { status: 200, data: { login: "regular" } };
      if (route === "GET /orgs/{org}/teams/{team_slug}/memberships/{username}") {
        return httpError(404);
      }
      throw new Error(`unexpected route: ${route}`);
    });
    await expect(authenticateAdmin(VALID_TOKEN, CONFIG, req)).rejects.toMatchObject({
      code: "not_admin",
      status: 403,
    });
  });
});

describe("AuthError shape", () => {
  it("preserves name, code, status, and message", () => {
    const err = new AuthError("not_admin", 403, "test message");
    expect(err.name).toBe("AuthError");
    expect(err.code).toBe("not_admin");
    expect(err.status).toBe(403);
    expect(err.message).toBe("test message");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("integration with defaultRequest (smoke)", () => {
  // Sanity: importing the lib doesn't immediately blow up if env vars are missing.
  // We don't hit real GitHub here.
  beforeEach(() => {
    vi.resetModules();
  });

  it("module loads with no network access", async () => {
    const mod = await import("../lib/auth.js");
    expect(typeof mod.verifyGitHubToken).toBe("function");
    expect(typeof mod.parseBearerToken).toBe("function");
  });
});
