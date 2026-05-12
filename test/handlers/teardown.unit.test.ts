import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@octokit/request-error";
import type { OctokitRequest } from "../../lib/auth.js";
import {
  handleTeardown,
  type TeardownConfig,
  type TeardownDeps,
} from "../../lib/handlers/teardown.js";
import { VercelApiError, type VercelClient } from "../../lib/vercel-client.js";
import { FakeKv } from "../fake-kv.js";

const CONFIG: TeardownConfig = {
  org: "Bible-Innovation-Lab",
  adminTeamSlug: "platform-admins",
  subdomainRoot: "bibleinnovationlab.org",
};

const TOKEN = "Bearer ghu_testadmintokenvalueok";

function httpError(status: number): RequestError {
  return new RequestError("synthetic", status, {
    request: { method: "GET", url: "https://api.github.com/x", headers: {} },
  });
}

function makeOctokitAdmin(login = "admin-user"): OctokitRequest {
  return vi.fn(async (route) => {
    if (route === "GET /user") return { status: 200, data: { login } };
    if (route === "GET /orgs/{org}/teams/{team_slug}/memberships/{username}") {
      return { status: 200, data: { state: "active" } };
    }
    throw new Error(`unexpected route: ${route}`);
  });
}

function makeOctokitNotAdmin(login = "student"): OctokitRequest {
  return vi.fn(async (route) => {
    if (route === "GET /user") return { status: 200, data: { login } };
    if (route === "GET /orgs/{org}/teams/{team_slug}/memberships/{username}") {
      throw httpError(404);
    }
    throw new Error(`unexpected route: ${route}`);
  });
}

function fakeVercelClient(overrides: Partial<VercelClient> = {}): VercelClient {
  const base: VercelClient = {
    createProject: vi.fn(async ({ name }: { name: string }) => ({
      id: `prj_${name}`,
      name,
    })),
    addDomain: vi.fn(async () => undefined),
    setEnv: vi.fn(async () => undefined),
    deleteProject: vi.fn(async () => undefined),
    removeDomain: vi.fn(async () => undefined),
    pollCertReady: vi.fn(async () => true),
  };
  return { ...base, ...overrides } as VercelClient;
}

function buildDeps(overrides: Partial<TeardownDeps> = {}): TeardownDeps {
  return {
    kv: overrides.kv ?? new FakeKv(),
    vercel: overrides.vercel ?? fakeVercelClient(),
    octokit: overrides.octokit ?? makeOctokitAdmin(),
    config: overrides.config ?? CONFIG,
    requestId: overrides.requestId ?? (() => "req_teardown_1"),
  };
}

async function seedClaim(
  kv: FakeKv,
  appId: string,
  opts: { repo: string; projectId?: string; ttlSec?: number }
): Promise<void> {
  await kv.set(
    `app_id:${appId}`,
    {
      repo: opts.repo,
      claimed_at: new Date().toISOString(),
      ...(opts.projectId ? { project_id: opts.projectId } : {}),
    },
    opts.ttlSec ? { ex: opts.ttlSec } : undefined
  );
}

describe("handleTeardown — auth gating", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const result = await handleTeardown(
      { authorization: null, body: { app_id: "bible-trivia" } },
      buildDeps()
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_token" });
  });

  it("returns 401 when Authorization is malformed", async () => {
    const result = await handleTeardown(
      { authorization: "Basic xyz", body: { app_id: "bible-trivia" } },
      buildDeps()
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_token" });
  });

  it("returns 401 when token is rejected by GitHub", async () => {
    const octokit = vi.fn(async () => {
      throw httpError(401);
    });
    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "bible-trivia" } },
      buildDeps({ octokit })
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "invalid_token" });
  });

  it("returns 403 when caller is not in the admin team", async () => {
    // Even a real org member who's not in the admin team must be denied.
    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "bible-trivia" } },
      buildDeps({ octokit: makeOctokitNotAdmin() })
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "not_admin" });
  });

  it("returns 502 when GitHub is unavailable", async () => {
    const octokit = vi.fn(async () => {
      throw httpError(503);
    });
    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "bible-trivia" } },
      buildDeps({ octokit })
    );
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "github_unavailable" });
  });
});

describe("handleTeardown — body + app_id validation", () => {
  it("returns 400 malformed_body when body is not an object", async () => {
    const result = await handleTeardown(
      { authorization: TOKEN, body: "nope" },
      buildDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "malformed_body" });
  });

  it("returns 400 malformed_body when app_id is missing", async () => {
    const result = await handleTeardown(
      { authorization: TOKEN, body: {} },
      buildDeps()
    );
    expect(result.body).toEqual({ error: "malformed_body" });
  });

  it("returns 400 app_id_invalid for bad format", async () => {
    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "BadCase" } },
      buildDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "app_id_invalid" });
  });

  it("returns 400 denylisted for reserved names", async () => {
    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "admin" } },
      buildDeps()
    );
    expect(result.body).toEqual({ error: "denylisted" });
  });
});

describe("handleTeardown — KV lookup", () => {
  it("returns 404 not_found when no claim exists", async () => {
    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "ghost" } },
      buildDeps()
    );
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "not_found" });
  });

  it("releases a pending claim (no project_id) without calling Vercel", async () => {
    const kv = new FakeKv();
    await seedClaim(kv, "pending-app", {
      repo: "Bible-Innovation-Lab/pending-app",
      ttlSec: 300,
    });
    const removeDomain = vi.fn(async () => undefined);
    const deleteProject = vi.fn(async () => undefined);
    const vercel = fakeVercelClient({ removeDomain, deleteProject });

    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "pending-app" } },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      app_id: "pending-app",
      project_id: null,
      released: true,
    });
    expect(removeDomain).not.toHaveBeenCalled();
    expect(deleteProject).not.toHaveBeenCalled();
    expect(await kv.get("app_id:pending-app")).toBeNull();
  });
});

describe("handleTeardown — happy path", () => {
  it("removes domain, deletes project, releases claim, returns 200", async () => {
    const kv = new FakeKv();
    await seedClaim(kv, "bible-trivia", {
      repo: "Bible-Innovation-Lab/bible-trivia",
      projectId: "prj_bible-trivia",
    });
    const removeDomain = vi.fn(async () => undefined);
    const deleteProject = vi.fn(async () => undefined);
    const vercel = fakeVercelClient({ removeDomain, deleteProject });

    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "bible-trivia" } },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      app_id: "bible-trivia",
      project_id: "prj_bible-trivia",
      released: true,
    });
    expect(removeDomain).toHaveBeenCalledWith(
      "prj_bible-trivia",
      "bible-trivia.bibleinnovationlab.org"
    );
    expect(deleteProject).toHaveBeenCalledWith("prj_bible-trivia");
    expect(await kv.get("app_id:bible-trivia")).toBeNull();
  });
});

describe("handleTeardown — Vercel 404 tolerance", () => {
  it("treats removeDomain 404 as already-gone and continues", async () => {
    const kv = new FakeKv();
    await seedClaim(kv, "stale-domain", {
      repo: "Bible-Innovation-Lab/stale-domain",
      projectId: "prj_stale",
    });
    const vercel = fakeVercelClient({
      removeDomain: vi.fn(async () => {
        throw new VercelApiError(
          404,
          "not_found",
          "DELETE /v9/projects/x/domains/y",
          "domain gone"
        );
      }),
    });

    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "stale-domain" } },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(200);
    expect(await kv.get("app_id:stale-domain")).toBeNull();
  });

  it("treats deleteProject 404 as already-gone and continues", async () => {
    const kv = new FakeKv();
    await seedClaim(kv, "stale-project", {
      repo: "Bible-Innovation-Lab/stale-project",
      projectId: "prj_stale_p",
    });
    const vercel = fakeVercelClient({
      deleteProject: vi.fn(async () => {
        throw new VercelApiError(404, "not_found", "DELETE /v9/projects/x", "gone");
      }),
    });

    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "stale-project" } },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(200);
    expect(await kv.get("app_id:stale-project")).toBeNull();
  });
});

describe("handleTeardown — Vercel failure preserves claim for retry", () => {
  it("returns 500 and leaves the KV claim intact when removeDomain 5xxs", async () => {
    const kv = new FakeKv();
    await seedClaim(kv, "flaky", {
      repo: "Bible-Innovation-Lab/flaky",
      projectId: "prj_flaky",
    });
    const vercel = fakeVercelClient({
      removeDomain: vi.fn(async () => {
        throw new VercelApiError(
          503,
          "service_unavailable",
          "DELETE /v9/projects/x/domains/y",
          "down"
        );
      }),
    });

    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "flaky" } },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "vercel_api_error" });
    const claim = await kv.get("app_id:flaky");
    expect(claim).toMatchObject({ project_id: "prj_flaky" });
  });

  it("returns 500 and leaves the KV claim intact when deleteProject 5xxs", async () => {
    const kv = new FakeKv();
    await seedClaim(kv, "flaky-delete", {
      repo: "Bible-Innovation-Lab/flaky-delete",
      projectId: "prj_flaky_d",
    });
    const vercel = fakeVercelClient({
      deleteProject: vi.fn(async () => {
        throw new VercelApiError(500, "internal", "DELETE /v9/projects/x", "boom");
      }),
    });

    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "flaky-delete" } },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(await kv.get("app_id:flaky-delete")).not.toBeNull();
  });

  it("returns 500 internal on non-VercelApiError failure (and keeps claim)", async () => {
    const kv = new FakeKv();
    await seedClaim(kv, "explody", {
      repo: "Bible-Innovation-Lab/explody",
      projectId: "prj_x",
    });
    const vercel = fakeVercelClient({
      removeDomain: vi.fn(async () => {
        throw new TypeError("unexpected");
      }),
    });

    const result = await handleTeardown(
      { authorization: TOKEN, body: { app_id: "explody" } },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "internal" });
    expect(await kv.get("app_id:explody")).not.toBeNull();
  });
});
