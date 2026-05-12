import { beforeEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "@octokit/request-error";
import type { OctokitRequest } from "../../lib/auth.js";
import {
  handleProvision,
  type ProvisionConfig,
  type ProvisionDeps,
} from "../../lib/handlers/provision.js";
import { VercelApiError, type VercelClient } from "../../lib/vercel-client.js";
import { FakeKv } from "../fake-kv.js";

const CONFIG: ProvisionConfig = {
  org: "Bible-Innovation-Lab",
  adminTeamSlug: "platform-admins",
  subdomainRoot: "bibleinnovationlab.org",
  posthogKey: "phc_testkey",
  posthogHost: "https://us.i.posthog.com",
};

const TOKEN = "Bearer ghu_testtokenvalueokay";

function httpError(status: number): RequestError {
  return new RequestError("synthetic", status, {
    request: { method: "GET", url: "https://api.github.com/x", headers: {} },
  });
}

function makeOctokitOk(login = "student"): OctokitRequest {
  return vi.fn(async (route) => {
    if (route === "GET /user") return { status: 200, data: { login } };
    if (route === "GET /user/memberships/orgs/{org}") {
      return { status: 200, data: { state: "active" } };
    }
    throw new Error(`unexpected route: ${route}`);
  });
}

function makeOctokitNotMember(login = "outsider"): OctokitRequest {
  return vi.fn(async (route) => {
    if (route === "GET /user") return { status: 200, data: { login } };
    if (route === "GET /user/memberships/orgs/{org}") throw httpError(404);
    throw new Error(`unexpected route: ${route}`);
  });
}

function fakeVercelClient(overrides: Partial<VercelClient> = {}): VercelClient {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const record = <T>(method: string, fn: (...args: any[]) => Promise<T>) =>
    async (...args: any[]) => {
      calls.push({ method, args });
      return fn(...args);
    };
  const base: VercelClient = {
    createProject: record("createProject", async ({ name }: { name: string }) => ({
      id: `prj_${name}`,
      name,
      repoId: 12345,
    })),
    addDomain: record("addDomain", async () => undefined),
    setEnv: record("setEnv", async () => undefined),
    deleteProject: record("deleteProject", async () => undefined),
    removeDomain: record("removeDomain", async () => undefined),
    pollCertReady: record("pollCertReady", async () => true),
    createDeployment: record(
      "createDeployment",
      async (input: { projectId: string }) => ({
        id: `dpl_${input.projectId}`,
        url: "preview.vercel.app",
      })
    ),
    pollDeploymentReady: record("pollDeploymentReady", async () => true),
  };
  return { ...base, ...overrides } as VercelClient & { __calls?: typeof calls };
}

function buildDeps(overrides: Partial<ProvisionDeps> = {}): ProvisionDeps {
  return {
    kv: overrides.kv ?? new FakeKv(),
    vercel: overrides.vercel ?? fakeVercelClient(),
    octokit: overrides.octokit ?? makeOctokitOk(),
    config: overrides.config ?? CONFIG,
    requestId: overrides.requestId ?? (() => "req_test_1"),
  };
}

describe("handleProvision — auth gating", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const result = await handleProvision(
      { authorization: null, body: { repo: "x/y", app_id: "ok-app" } },
      buildDeps()
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_token" });
  });

  it("returns 401 when Authorization is malformed", async () => {
    const result = await handleProvision(
      { authorization: "Basic xyz", body: {} },
      buildDeps()
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_token" });
  });

  it("returns 401 when token is rejected by GitHub", async () => {
    const octokit = vi.fn(async () => {
      throw httpError(401);
    });
    const result = await handleProvision(
      { authorization: TOKEN, body: {} },
      buildDeps({ octokit })
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "invalid_token" });
  });

  it("returns 403 when caller is not an org member", async () => {
    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/foo", app_id: "foo" },
      },
      buildDeps({ octokit: makeOctokitNotMember() })
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "not_org_member" });
  });
});

describe("handleProvision — body + app_id validation", () => {
  it("returns 400 malformed_body when body is not an object", async () => {
    const result = await handleProvision(
      { authorization: TOKEN, body: "not-an-object" },
      buildDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "malformed_body" });
  });

  it("returns 400 malformed_body when repo is not owner/name shaped", async () => {
    const result = await handleProvision(
      { authorization: TOKEN, body: { repo: "no-slash", app_id: "foo" } },
      buildDeps()
    );
    expect(result.body).toEqual({ error: "malformed_body" });
  });

  it("returns 400 app_id_invalid for bad app_id format", async () => {
    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/x", app_id: "BadCase" },
      },
      buildDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "app_id_invalid" });
  });

  it("returns 400 denylisted for reserved names", async () => {
    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/admin", app_id: "admin" },
      },
      buildDeps()
    );
    expect(result.body).toEqual({ error: "denylisted" });
  });

  it("returns 400 repo_not_owned when repo prefix isn't the configured org", async () => {
    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "some-other-org/bible-trivia", app_id: "bible-trivia" },
      },
      buildDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "repo_not_owned" });
  });
});

describe("handleProvision — KV claim", () => {
  it("returns 400 app_id_taken when a different repo already holds the claim", async () => {
    const kv = new FakeKv();
    // Pre-claim by a different repo.
    await kv.set("app_id:bible-trivia", {
      repo: "Bible-Innovation-Lab/other",
      claimed_at: new Date().toISOString(),
      project_id: "prj_existing",
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/bible-trivia", app_id: "bible-trivia" },
      },
      buildDeps({ kv })
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "app_id_taken" });
  });

  it("returns 409 already_provisioned on idempotent retry (same repo)", async () => {
    const kv = new FakeKv();
    await kv.set("app_id:bible-trivia", {
      repo: "Bible-Innovation-Lab/bible-trivia",
      claimed_at: new Date().toISOString(),
      project_id: "prj_existing",
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/bible-trivia", app_id: "bible-trivia" },
      },
      buildDeps({ kv })
    );
    expect(result.status).toBe(409);
    expect(result.body).toEqual({
      error: "already_provisioned",
      project_id: "prj_existing",
      url: "https://bible-trivia.bibleinnovationlab.org",
    });
  });

  it("returns 400 app_id_taken on collision with a pending (no project_id) claim", async () => {
    // A pending claim from another in-flight provision attempt should be
    // treated as "taken" — not idempotently merged. Same repo or not.
    const kv = new FakeKv();
    await kv.set(
      "app_id:bible-trivia",
      { repo: "Bible-Innovation-Lab/bible-trivia", claimed_at: new Date().toISOString() },
      { ex: 300 }
    );

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/bible-trivia", app_id: "bible-trivia" },
      },
      buildDeps({ kv })
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "app_id_taken" });
  });
});

describe("handleProvision — happy path", () => {
  it("creates project, attaches domain, sets env, triggers + awaits deploy, confirms claim, returns 201", async () => {
    const kv = new FakeKv();
    const setEnvCalls: unknown[][] = [];
    const createProjectCalls: unknown[][] = [];
    const createDeploymentCalls: unknown[][] = [];
    const pollDeploymentCalls: unknown[][] = [];
    const vercel = fakeVercelClient({
      createProject: vi.fn(async (...args: unknown[]) => {
        createProjectCalls.push(args);
        const input = args[0] as { name: string };
        return { id: `prj_${input.name}`, name: input.name, repoId: 12345 };
      }),
      setEnv: vi.fn(async (...args: unknown[]) => {
        setEnvCalls.push(args);
      }),
      createDeployment: vi.fn(async (...args: unknown[]) => {
        createDeploymentCalls.push(args);
        const input = args[0] as { projectId: string };
        return { id: `dpl_${input.projectId}`, url: "preview.vercel.app" };
      }),
      pollDeploymentReady: vi.fn(async (...args: unknown[]) => {
        pollDeploymentCalls.push(args);
        return true;
      }),
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/bible-trivia", app_id: "bible-trivia" },
      },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      url: "https://bible-trivia.bibleinnovationlab.org",
      project_id: "prj_bible-trivia",
    });

    // Claim is confirmed (no TTL, has project_id).
    const claim = await kv.get("app_id:bible-trivia");
    expect(claim).toMatchObject({
      repo: "Bible-Innovation-Lab/bible-trivia",
      project_id: "prj_bible-trivia",
    });
    expect(kv._ttlMs("app_id:bible-trivia")).toBeNull();

    // setEnv was called for APP_ID, POSTHOG_KEY, POSTHOG_HOST.
    const keys = setEnvCalls.map((c) => c[1]);
    expect(keys).toEqual(["APP_ID", "POSTHOG_KEY", "POSTHOG_HOST"]);

    // createProject was called with nodeVersion + framework explicit.
    expect(createProjectCalls[0][0]).toMatchObject({
      name: "bible-trivia",
      repo: "Bible-Innovation-Lab/bible-trivia",
      nodeVersion: "22.x",
      framework: "nextjs",
    });

    // Deployment was triggered against main + repoId from createProject.
    expect(createDeploymentCalls).toHaveLength(1);
    expect(createDeploymentCalls[0][0]).toMatchObject({
      projectId: "prj_bible-trivia",
      name: "bible-trivia",
      repoId: 12345,
      ref: "main",
    });
    // And we waited for it before returning 201.
    expect(pollDeploymentCalls).toHaveLength(1);
    expect(pollDeploymentCalls[0][0]).toBe("dpl_prj_bible-trivia");
  });

  it("cert-poll failure does not fail the request", async () => {
    const vercel = fakeVercelClient({
      pollCertReady: vi.fn(async () => {
        throw new Error("Vercel poll blew up");
      }),
    });
    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/late-cert", app_id: "late-cert" },
      },
      buildDeps({ vercel })
    );
    expect(result.status).toBe(201);
  });
});

describe("handleProvision — rollback on Vercel failure", () => {
  it("releases the claim when createProject fails (no project to delete)", async () => {
    const kv = new FakeKv();
    const deleteProject = vi.fn(async () => undefined);
    const vercel = fakeVercelClient({
      createProject: vi.fn(async () => {
        throw new VercelApiError(409, "name_already_taken", "POST /v9/projects", "boom");
      }),
      deleteProject,
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/new-app", app_id: "new-app" },
      },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "vercel_api_error" });
    expect(await kv.get("app_id:new-app")).toBeNull();
    // No project was created, so no deletion should be attempted.
    expect(deleteProject).not.toHaveBeenCalled();
  });

  it("deletes the orphan project AND releases the claim when addDomain fails", async () => {
    const kv = new FakeKv();
    const deleteProject = vi.fn(async () => undefined);
    const vercel = fakeVercelClient({
      addDomain: vi.fn(async () => {
        throw new VercelApiError(503, "service_unavailable", "POST /v10/projects/x/domains", "down");
      }),
      deleteProject,
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/retryable", app_id: "retryable" },
      },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(await kv.get("app_id:retryable")).toBeNull();
    expect(deleteProject).toHaveBeenCalledWith("prj_retryable");
  });

  it("deletes the orphan project AND releases the claim when createDeployment fails", async () => {
    const kv = new FakeKv();
    const deleteProject = vi.fn(async () => undefined);
    const vercel = fakeVercelClient({
      createDeployment: vi.fn(async () => {
        throw new VercelApiError(500, "internal", "POST /v13/deployments", "boom");
      }),
      deleteProject,
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/deploy-fail", app_id: "deploy-fail" },
      },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "vercel_api_error" });
    expect(await kv.get("app_id:deploy-fail")).toBeNull();
    expect(deleteProject).toHaveBeenCalledWith("prj_deploy-fail");
  });

  it("deletes the orphan project AND releases the claim when the deploy ends in ERROR state", async () => {
    const kv = new FakeKv();
    const deleteProject = vi.fn(async () => undefined);
    const vercel = fakeVercelClient({
      pollDeploymentReady: vi.fn(async () => {
        // Mirrors what the real client throws when readyState lands on ERROR.
        throw new VercelApiError(
          502,
          "deployment_error",
          "GET /v13/deployments/dpl_x",
          "Build failed: TypeError in app/page.tsx"
        );
      }),
      deleteProject,
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/build-bad", app_id: "build-bad" },
      },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "vercel_api_error" });
    expect(await kv.get("app_id:build-bad")).toBeNull();
    expect(deleteProject).toHaveBeenCalledWith("prj_build-bad");
  });

  it("still releases the claim when project rollback itself fails (deleteProject 5xx)", async () => {
    // The catch block should swallow deleteProject errors so the KV claim
    // ALWAYS gets released — students must not be locked out of an app_id
    // by a Vercel cleanup hiccup.
    const kv = new FakeKv();
    const vercel = fakeVercelClient({
      addDomain: vi.fn(async () => {
        throw new VercelApiError(503, "service_unavailable", "POST /v10/projects/x/domains", "down");
      }),
      deleteProject: vi.fn(async () => {
        throw new VercelApiError(500, "internal", "DELETE /v9/projects/x", "still broken");
      }),
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/stubborn", app_id: "stubborn" },
      },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(await kv.get("app_id:stubborn")).toBeNull();
  });

  it("returns 500 internal on unexpected (non-VercelApiError) failure", async () => {
    const kv = new FakeKv();
    const vercel = fakeVercelClient({
      addDomain: vi.fn(async () => {
        throw new TypeError("something exploded");
      }),
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/explody", app_id: "explody" },
      },
      buildDeps({ kv, vercel })
    );
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "internal" });
    expect(await kv.get("app_id:explody")).toBeNull();
  });

  it("fails fast if createProject returns no repoId (cannot trigger deploy)", async () => {
    const kv = new FakeKv();
    const deleteProject = vi.fn(async () => undefined);
    const vercel = fakeVercelClient({
      createProject: vi.fn(async ({ name }: { name: string }) => ({
        id: `prj_${name}`,
        name,
        repoId: null,
      })),
      deleteProject,
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/no-repo-id", app_id: "no-repo-id" },
      },
      buildDeps({ kv, vercel })
    );

    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: "vercel_api_error" });
    expect(await kv.get("app_id:no-repo-id")).toBeNull();
    expect(deleteProject).toHaveBeenCalledWith("prj_no-repo-id");
  });
});

describe("handleProvision — log redaction", () => {
  // Sanity check that the handler doesn't blow up if a token leaks into an
  // error message. The log redactor is unit-tested separately; this just
  // makes sure the call path doesn't throw.
  it("survives an error message containing a Bearer token", async () => {
    const vercel = fakeVercelClient({
      createProject: vi.fn(async () => {
        throw new VercelApiError(
          500,
          "internal",
          "POST /v9/projects",
          "fake error mentioning Bearer vck_aaaaaaaaaaaaaaaaaaaa"
        );
      }),
    });

    const result = await handleProvision(
      {
        authorization: TOKEN,
        body: { repo: "Bible-Innovation-Lab/leaky", app_id: "leaky" },
      },
      buildDeps({ vercel })
    );
    expect(result.status).toBe(500);
  });
});
