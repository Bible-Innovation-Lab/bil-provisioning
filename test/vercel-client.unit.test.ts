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
  it("POSTs to /v9/projects with teamId, body, and Bearer auth", async () => {
    const fetchMock = vi.fn<FetchLike>(async () =>
      jsonResponse({ id: "prj_new123", name: "bible-trivia" }, 200)
    );
    const client = makeClient(fetchMock);

    const result = await client.createProject({
      name: "bible-trivia",
      repo: "Bible-Innovation-Lab/bible-trivia",
    });

    expect(result).toEqual({ id: "prj_new123", name: "bible-trivia" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(
      `https://api.vercel.com/v9/projects?teamId=${TEAM}`
    );
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init?.body as string)).toEqual({
      name: "bible-trivia",
      gitRepository: { type: "github", repo: "Bible-Innovation-Lab/bible-trivia" },
    });
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
