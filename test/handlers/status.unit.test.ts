import { describe, expect, it, vi } from "vitest";
import { RequestError } from "@octokit/request-error";
import type { OctokitRequest } from "../../lib/auth";
import {
  handleStatus,
  type StatusConfig,
  type StatusDeps,
} from "../../lib/handlers/status";
import { FakeKv } from "../fake-kv";

const CONFIG: StatusConfig = {
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

function buildDeps(overrides: Partial<StatusDeps> = {}): StatusDeps {
  return {
    kv: overrides.kv ?? new FakeKv(),
    octokit: overrides.octokit ?? makeOctokitAdmin(),
    config: overrides.config ?? CONFIG,
    requestId: overrides.requestId ?? (() => "req_status_1"),
  };
}

describe("handleStatus — auth gating", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const result = await handleStatus(
      { authorization: null, query: { app_id: "bible-trivia" } },
      buildDeps()
    );
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: "missing_token" });
  });

  it("returns 403 when caller is not in the admin team", async () => {
    const result = await handleStatus(
      { authorization: TOKEN, query: { app_id: "bible-trivia" } },
      buildDeps({ octokit: makeOctokitNotAdmin() })
    );
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "not_admin" });
  });

  it("returns 502 when GitHub is unavailable", async () => {
    const octokit = vi.fn(async () => {
      throw httpError(503);
    });
    const result = await handleStatus(
      { authorization: TOKEN, query: { app_id: "bible-trivia" } },
      buildDeps({ octokit })
    );
    expect(result.status).toBe(502);
    expect(result.body).toEqual({ error: "github_unavailable" });
  });
});

describe("handleStatus — query validation", () => {
  it("returns 400 missing_app_id when app_id query param is missing", async () => {
    const result = await handleStatus(
      { authorization: TOKEN, query: {} },
      buildDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "missing_app_id" });
  });

  it("returns 400 missing_app_id when query is null", async () => {
    const result = await handleStatus(
      { authorization: TOKEN, query: null },
      buildDeps()
    );
    expect(result.body).toEqual({ error: "missing_app_id" });
  });

  it("accepts the first value when app_id is repeated as an array", async () => {
    const kv = new FakeKv();
    await kv.set("app_id:bible-trivia", {
      repo: "Bible-Innovation-Lab/bible-trivia",
      claimed_at: "2026-05-12T10:00:00.000Z",
      project_id: "prj_bt",
    });
    const result = await handleStatus(
      {
        authorization: TOKEN,
        query: { app_id: ["bible-trivia", "ignored"] },
      },
      buildDeps({ kv })
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ app_id: "bible-trivia", claimed: true });
  });

  it("returns 400 app_id_invalid for bad format", async () => {
    const result = await handleStatus(
      { authorization: TOKEN, query: { app_id: "BadCase" } },
      buildDeps()
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "app_id_invalid" });
  });

  it("returns 400 denylisted for reserved names", async () => {
    const result = await handleStatus(
      { authorization: TOKEN, query: { app_id: "admin" } },
      buildDeps()
    );
    expect(result.body).toEqual({ error: "denylisted" });
  });
});

describe("handleStatus — KV lookup", () => {
  it("returns claimed: false when no claim row exists", async () => {
    const result = await handleStatus(
      { authorization: TOKEN, query: { app_id: "never-claimed" } },
      buildDeps()
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ app_id: "never-claimed", claimed: false });
  });

  it("returns state=active for a confirmed claim with project_id", async () => {
    const kv = new FakeKv();
    await kv.set("app_id:bible-trivia", {
      repo: "Bible-Innovation-Lab/bible-trivia",
      claimed_at: "2026-05-12T10:00:00.000Z",
      project_id: "prj_bt",
    });
    const result = await handleStatus(
      { authorization: TOKEN, query: { app_id: "bible-trivia" } },
      buildDeps({ kv })
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      app_id: "bible-trivia",
      claimed: true,
      state: "active",
      repo: "Bible-Innovation-Lab/bible-trivia",
      claimed_at: "2026-05-12T10:00:00.000Z",
      project_id: "prj_bt",
      url: "https://bible-trivia.bibleinnovationlab.org",
    });
  });

  it("returns state=pending when claim has no project_id yet", async () => {
    const kv = new FakeKv();
    await kv.set(
      "app_id:in-flight",
      {
        repo: "Bible-Innovation-Lab/in-flight",
        claimed_at: "2026-05-12T10:00:00.000Z",
      },
      { ex: 300 }
    );
    const result = await handleStatus(
      { authorization: TOKEN, query: { app_id: "in-flight" } },
      buildDeps({ kv })
    );
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      app_id: "in-flight",
      claimed: true,
      state: "pending",
      repo: "Bible-Innovation-Lab/in-flight",
      claimed_at: "2026-05-12T10:00:00.000Z",
      project_id: null,
      url: "https://in-flight.bibleinnovationlab.org",
    });
  });
});
