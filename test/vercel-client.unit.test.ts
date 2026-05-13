import { describe, expect, it, vi } from "vitest";
import {
  VercelApiError,
  createVercelClient,
  type FetchLike,
  type VercelConfig,
} from "../lib/vercel-client.js";

const TOKEN = "vck_unittestfaketokendoesnotleak";
const TEAM = "bible-innovation-lab";

function makeClient(fetchImpl: FetchLike, overrides: Partial<VercelConfig> = {}) {
  return createVercelClient({
    token: TOKEN,
    teamId: TEAM,
    fetch: fetchImpl,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function emptyResponse(status = 204): Response {
  // 204/205/304 require a null body per the Fetch spec / undici.
  const nullBodyStatuses = new Set([204, 205, 304]);
  return new Response(nullBodyStatuses.has(status) ? null : "", { status });
}

describe("createProject", () => {
  it("POSTs name + framework + gitRepository, then PATCHes nodeVersion + gitForkProtection in one call", async () => {
    // Vercel rejects nodeVersion AND gitForkProtection on the create endpoint,
    // so the client splits them into POST /v9/projects + one combined PATCH.
    let call = 0;
    const fetchMock = vi.fn<FetchLike>(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          {
            id: "prj_new123",
            name: "bible-trivia",
            link: { type: "github", repoId: 12345, repo: "bible-trivia" },
          },
          200
        );
      }
      // PATCH response — Vercel echoes the project back, we only need it to
      // be 2xx.
      return jsonResponse(
        { id: "prj_new123", nodeVersion: "22.x", gitForkProtection: false },
        200
      );
    });
    const client = makeClient(fetchMock);

    const result = await client.createProject({
      name: "bible-trivia",
      repo: "Bible-Innovation-Lab/bible-trivia",
      nodeVersion: "22.x",
      framework: "nextjs",
      gitForkProtection: false,
    });

    expect(result).toEqual({
      id: "prj_new123",
      name: "bible-trivia",
      repoId: 12345,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // First call: POST /v9/projects with framework but no nodeVersion/gitForkProtection.
    const [createUrl, createInit] = fetchMock.mock.calls[0];
    expect(String(createUrl)).toBe(
      `https://api.vercel.com/v9/projects?teamId=${TEAM}`
    );
    expect(createInit?.method).toBe("POST");
    expect((createInit?.headers as Record<string, string>)?.authorization).toBe(
      `Bearer ${TOKEN}`
    );
    expect(JSON.parse(createInit?.body as string)).toEqual({
      name: "bible-trivia",
      framework: "nextjs",
      gitRepository: { type: "github", repo: "Bible-Innovation-Lab/bible-trivia" },
    });

    // Second call: ONE PATCH /v9/projects/prj_new123 carrying BOTH settings.
    const [patchUrl, patchInit] = fetchMock.mock.calls[1];
    expect(String(patchUrl)).toBe(
      `https://api.vercel.com/v9/projects/prj_new123?teamId=${TEAM}`
    );
    expect(patchInit?.method).toBe("PATCH");
    expect(JSON.parse(patchInit?.body as string)).toEqual({
      nodeVersion: "22.x",
      gitForkProtection: false,
    });
  });

  it("skips the PATCH when no post-create settings are requested", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { id: "prj_minimal", name: "x", link: { repoId: 1 } },
        200
      )
    );
    const client = makeClient(fetchMock);

    await client.createProject({
      name: "x",
      repo: "Bible-Innovation-Lab/x",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PATCHes only the settings that are provided (gitForkProtection alone)", async () => {
    let call = 0;
    const fetchMock = vi.fn<FetchLike>(async () => {
      call += 1;
      if (call === 1) {
        return jsonResponse(
          { id: "prj_x", name: "x", link: { repoId: 1 } },
          200
        );
      }
      return jsonResponse({ id: "prj_x" }, 200);
    });
    const client = makeClient(fetchMock);

    await client.createProject({
      name: "x",
      repo: "Bible-Innovation-Lab/x",
      gitForkProtection: false,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, patchInit] = fetchMock.mock.calls[1];
    expect(JSON.parse(patchInit?.body as string)).toEqual({
      gitForkProtection: false,
    });
  });

  it("returns repoId: null when Vercel omits the link object", async () => {
    // Belt-and-braces — handler treats this as fatal (cannot trigger deploy
    // without repoId), but the client itself doesn't throw.
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ id: "prj_new", name: "x" }, 200)
    );
    const client = makeClient(fetchMock);

    const result = await client.createProject({
      name: "x",
      repo: "Bible-Innovation-Lab/x",
    });
    expect(result.repoId).toBeNull();
  });

  it("throws VercelApiError with vendor error code on 4xx", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { error: { code: "name_already_taken", message: "Project name taken" } },
        409
      )
    );
    const client = makeClient(fetchMock);

    await expect(
      client.createProject({ name: "x", repo: "Bible-Innovation-Lab/x" })
    ).rejects.toMatchObject({
      name: "VercelApiError",
      status: 409,
      code: "name_already_taken",
    });
  });

  it("redacts the bearer token from any error message", async () => {
    // Vercel sometimes echoes the request back in error bodies. Ensure that
    // the token wouldn't survive if it appeared.
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        {
          error: {
            code: "bad_request",
            message: `Token Bearer ${TOKEN} is malformed`,
          },
        },
        400
      )
    );
    const client = makeClient(fetchMock);

    try {
      await client.createProject({ name: "x", repo: "Bible-Innovation-Lab/x" });
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(VercelApiError);
      expect((e as VercelApiError).message).not.toContain(TOKEN);
      expect((e as VercelApiError).message).toContain("<redacted>");
    }
  });

  it("throws missing_project_id if Vercel returns 200 with no id (defensive)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({ name: "x" }, 200));
    const client = makeClient(fetchMock);

    await expect(
      client.createProject({ name: "x", repo: "Bible-Innovation-Lab/x" })
    ).rejects.toMatchObject({ code: "missing_project_id" });
  });
});

describe("addDomain", () => {
  it("POSTs the domain name to the project's domains endpoint", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ name: "bible-trivia.bibleinnovationlab.org" }, 200)
    );
    const client = makeClient(fetchMock);

    await client.addDomain("prj_abc", "bible-trivia.bibleinnovationlab.org");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.vercel.com/v10/projects/prj_abc/domains?teamId=${TEAM}`
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "bible-trivia.bibleinnovationlab.org",
    });
  });

  it("URL-encodes the project id", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => emptyResponse(200));
    const client = makeClient(fetchMock);

    await client.addDomain("prj/has/slashes", "x.example.com");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v10/projects/prj%2Fhas%2Fslashes/domains");
  });
});

describe("setEnv", () => {
  it("POSTs key/value/type/target with upsert=true", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}, 200));
    const client = makeClient(fetchMock);

    await client.setEnv("prj_abc", "POSTHOG_KEY", "phc_xxxx", ["production", "preview"]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.vercel.com/v10/projects/prj_abc/env?teamId=${TEAM}&upsert=true`
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      key: "POSTHOG_KEY",
      value: "phc_xxxx",
      type: "encrypted",
      target: ["production", "preview"],
    });
  });

  it("respects an overridden type", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}, 200));
    const client = makeClient(fetchMock);

    await client.setEnv("prj_abc", "APP_ID", "bible-trivia", ["production"], "plain");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init?.body as string).type).toBe("plain");
  });
});

describe("deleteProject", () => {
  it("DELETEs /v9/projects/{id}", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => emptyResponse(204));
    const client = makeClient(fetchMock);

    await client.deleteProject("prj_abc");

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://api.vercel.com/v9/projects/prj_abc?teamId=${TEAM}`);
    expect(init?.method).toBe("DELETE");
  });

  it("propagates 404 as VercelApiError", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ error: { code: "not_found", message: "Project not found" } }, 404)
    );
    const client = makeClient(fetchMock);

    await expect(client.deleteProject("prj_missing")).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
  });
});

describe("removeDomain", () => {
  it("DELETEs /v9/projects/{id}/domains/{domain}", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => emptyResponse(204));
    const client = makeClient(fetchMock);

    await client.removeDomain("prj_abc", "bible-trivia.bibleinnovationlab.org");

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.vercel.com/v9/projects/prj_abc/domains/bible-trivia.bibleinnovationlab.org?teamId=${TEAM}`
    );
  });
});

describe("pollCertReady", () => {
  it("returns true immediately if first poll reports misconfigured=false", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ misconfigured: false }, 200)
    );
    const client = makeClient(fetchMock);

    const ok = await client.pollCertReady("ready.bibleinnovationlab.org");
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries while misconfigured=true, succeeds on later poll", async () => {
    vi.useRealTimers();
    const states = [
      { misconfigured: true },
      { misconfigured: true },
      { misconfigured: false },
    ];
    let i = 0;
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(states[i++] ?? { misconfigured: false }, 200)
    );
    const client = makeClient(fetchMock);
    const ok = await client.pollCertReady("retry.example.com", { timeoutMs: 10_000 });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns false on timeout", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ misconfigured: true }, 200)
    );
    const client = makeClient(fetchMock);

    // 100ms deadline — first poll, sleep, second poll, etc., bounded.
    const ok = await client.pollCertReady("never.example.com", { timeoutMs: 100 });
    expect(ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("createDeployment", () => {
  it("POSTs to /v13/deployments with project + gitSource(repoId, ref, type=github)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { id: "dpl_abc123", url: "bible-trivia-x9-bil.vercel.app" },
        200
      )
    );
    const client = makeClient(fetchMock);

    const result = await client.createDeployment({
      projectId: "prj_abc",
      name: "bible-trivia",
      repoId: 12345,
      ref: "main",
    });

    expect(result).toEqual({
      id: "dpl_abc123",
      url: "bible-trivia-x9-bil.vercel.app",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.vercel.com/v13/deployments?teamId=${TEAM}`
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "bible-trivia",
      project: "prj_abc",
      target: "production",
      gitSource: { type: "github", repoId: 12345, ref: "main" },
    });
  });

  it("throws missing_deployment_id when Vercel returns no id", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => jsonResponse({}, 200));
    const client = makeClient(fetchMock);

    await expect(
      client.createDeployment({
        projectId: "prj_abc",
        name: "x",
        repoId: 1,
        ref: "main",
      })
    ).rejects.toMatchObject({ code: "missing_deployment_id" });
  });
});

describe("pollDeploymentReady", () => {
  it("returns true immediately when first poll reports READY", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ readyState: "READY" }, 200)
    );
    const client = makeClient(fetchMock);

    const ok = await client.pollDeploymentReady("dpl_x");
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries while BUILDING, returns true on READY", async () => {
    // Two states only — the production initial poll delay is 2s (exponential),
    // and we don't want the test to take > 5s. The retry path itself is the
    // assertion target; longer chains don't add coverage.
    vi.useRealTimers();
    const states = [{ readyState: "BUILDING" }, { readyState: "READY" }];
    let i = 0;
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(states[i++] ?? { readyState: "READY" }, 200)
    );
    const client = makeClient(fetchMock);
    const ok = await client.pollDeploymentReady("dpl_slow", { timeoutMs: 60_000 });
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws VercelApiError with deployment_error when readyState is ERROR", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { readyState: "ERROR", errorMessage: "Build failed: missing module foo" },
        200
      )
    );
    const client = makeClient(fetchMock);

    await expect(
      client.pollDeploymentReady("dpl_bad")
    ).rejects.toMatchObject({
      name: "VercelApiError",
      code: "deployment_error",
      message: "Build failed: missing module foo",
    });
  });

  it("throws deployment_canceled when readyState is CANCELED", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ readyState: "CANCELED", errorMessage: null }, 200)
    );
    const client = makeClient(fetchMock);

    await expect(
      client.pollDeploymentReady("dpl_cancelled")
    ).rejects.toMatchObject({ code: "deployment_canceled" });
  });

  it("returns false on timeout while still BUILDING", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ readyState: "BUILDING" }, 200)
    );
    const client = makeClient(fetchMock);

    const ok = await client.pollDeploymentReady("dpl_never", { timeoutMs: 100 });
    expect(ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("pollEnvReady", () => {
  it("returns true on first poll when all required keys are present", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(
        { envs: [{ key: "APP_ID" }, { key: "POSTHOG_KEY" }, { key: "YOUVERSION_API_KEY" }] },
        200
      )
    );
    const client = makeClient(fetchMock);

    const ok = await client.pollEnvReady("prj_x", ["APP_ID", "YOUVERSION_API_KEY"]);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://api.vercel.com/v9/projects/prj_x/env?teamId=${TEAM}`);
  });

  it("retries when keys are missing, returns true once they appear", async () => {
    vi.useRealTimers();
    const responses = [
      { envs: [{ key: "APP_ID" }] },                         // missing YOUVERSION
      { envs: [{ key: "APP_ID" }, { key: "YOUVERSION_API_KEY" }] }, // both now present
    ];
    let i = 0;
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse(responses[i++] ?? responses[responses.length - 1], 200)
    );
    const client = makeClient(fetchMock);

    const ok = await client.pollEnvReady(
      "prj_x",
      ["APP_ID", "YOUVERSION_API_KEY"],
      { timeoutMs: 5_000 }
    );
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns false on timeout when keys never appear", async () => {
    vi.useRealTimers();
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ envs: [{ key: "APP_ID" }] }, 200)
    );
    const client = makeClient(fetchMock);

    const ok = await client.pollEnvReady(
      "prj_x",
      ["APP_ID", "YOUVERSION_API_KEY"],
      { timeoutMs: 100 }
    );
    expect(ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("returns true immediately when requiredKeys is empty (degenerate case)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ envs: [] }, 200)
    );
    const client = makeClient(fetchMock);

    const ok = await client.pollEnvReady("prj_x", []);
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("network failures", () => {
  it("converts a thrown fetch into VercelApiError(network_error, status=0)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = makeClient(fetchMock);

    await expect(
      client.createProject({ name: "x", repo: "Bible-Innovation-Lab/x" })
    ).rejects.toMatchObject({
      name: "VercelApiError",
      code: "network_error",
      status: 0,
    });
  });
});

describe("team identifier", () => {
  it("URL-encodes the team identifier (works with slug or team_xxx)", async () => {
    const fetchMock = vi.fn<FetchLike>(async () => emptyResponse(204));
    const client = createVercelClient({
      token: TOKEN,
      teamId: "team with spaces",
      fetch: fetchMock,
    });

    await client.deleteProject("prj_abc");
    const [url] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("teamId=team%20with%20spaces");
  });
});
