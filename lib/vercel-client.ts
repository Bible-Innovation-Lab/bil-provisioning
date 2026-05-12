// Vercel REST API wrapper for the operations bil-provisioning performs.
// Spec: docs/implementation-plan.md § Phase 3.
//
// All requests:
//   - Auth: Authorization: Bearer ${VERCEL_API_TOKEN}
//   - Team scope: ?teamId=${VERCEL_TEAM_ID} (accepts the team's slug too)
//   - Token redaction on any error path so tokens never reach logs.
//
// We don't pull in @vercel/sdk because (a) we only call 6 endpoints and (b) a
// thin wrapper is easier to audit when this is the service holding the admin
// token.

import { redact } from "./log.js";

const DEFAULT_BASE_URL = "https://api.vercel.com";
const DEFAULT_TIMEOUT_MS = 30_000;

// Narrow signature: we only ever pass string URLs and an init object.
// Avoids depending on the global `RequestInfo` type (which isn't always
// declared in non-DOM tsconfigs).
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<Response>;

export interface VercelConfig {
  token: string;
  teamId: string; // accepts team_xxx OR slug (e.g. "bible-innovation-lab")
  baseUrl?: string;
  fetch?: FetchLike;
}

export type EnvTarget = "production" | "preview" | "development";

export type EnvType = "encrypted" | "plain" | "sensitive";

export interface CreateProjectInput {
  name: string;
  repo: string; // "owner/repo" — Bible-Innovation-Lab/<app-id>
  // Vercel's project-creation defaults are unsuitable for our purposes:
  //   - nodeVersion defaults to "24.x" which Vercel itself rejects at build
  //   - framework defaults to null which prevents framework-specific build
  //     optimizations (next.js cache splits, etc.)
  // Both are settable post-hoc via PATCH /v9/projects/{id}, but doing it at
  // create-time is one less round-trip and one less failure mode.
  nodeVersion?: string;
  framework?: string | null;
}

export interface CreateProjectResult {
  id: string;
  name: string;
  // The link.repoId is required by POST /v13/deployments to identify the
  // git source. We surface it here so the caller doesn't need a second
  // round-trip to look it up.
  repoId: number | null;
}

export interface CreateDeploymentInput {
  projectId: string;
  name: string; // typically the same as the project name (e.g. "bible-trivia")
  repoId: number;
  ref: string; // git ref to deploy, usually "main"
  target?: "production" | "staging";
}

export interface CreateDeploymentResult {
  id: string; // dpl_…
  url: string; // Vercel-assigned hostname (no scheme)
}

export type DeploymentReadyState =
  | "QUEUED"
  | "INITIALIZING"
  | "BUILDING"
  | "READY"
  | "ERROR"
  | "CANCELED";

export interface DeploymentStatus {
  readyState: DeploymentReadyState;
  errorMessage: string | null;
}

export interface VercelDomainConfig {
  configuredBy: string | null;
  misconfigured: boolean;
  acceptedChallenges?: string[];
}

export class VercelApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly endpoint: string;

  constructor(status: number, code: string, endpoint: string, message: string) {
    super(message);
    this.name = "VercelApiError";
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
  }
}

export interface VercelClient {
  createProject(input: CreateProjectInput): Promise<CreateProjectResult>;
  addDomain(projectId: string, domain: string): Promise<void>;
  setEnv(
    projectId: string,
    key: string,
    value: string,
    targets: EnvTarget[],
    type?: EnvType
  ): Promise<void>;
  deleteProject(projectId: string): Promise<void>;
  removeDomain(projectId: string, domain: string): Promise<void>;
  pollCertReady(domain: string, opts?: { timeoutMs?: number }): Promise<boolean>;
  createDeployment(input: CreateDeploymentInput): Promise<CreateDeploymentResult>;
  pollDeploymentReady(
    deploymentId: string,
    opts?: { timeoutMs?: number }
  ): Promise<boolean>;
}

export function createVercelClient(config: VercelConfig): VercelClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const doFetch: FetchLike = config.fetch ?? fetch;

  function teamQuery(): string {
    return `teamId=${encodeURIComponent(config.teamId)}`;
  }

  function buildUrl(path: string, extraParams?: Record<string, string>): string {
    const sep = path.includes("?") ? "&" : "?";
    const extra = extraParams
      ? "&" +
        Object.entries(extraParams)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&")
      : "";
    return `${baseUrl}${path}${sep}${teamQuery()}${extra}`;
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraParams?: Record<string, string>
  ): Promise<{ status: number; data: T | null }> {
    const url = buildUrl(path, extraParams);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${config.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (e) {
      throw new VercelApiError(
        0,
        "network_error",
        `${method} ${path}`,
        redact((e as Error).message ?? "network failure")
      );
    } finally {
      clearTimeout(timer);
    }

    // 204 / empty body case
    let parsed: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const errCode =
        (parsed as { error?: { code?: string } } | null)?.error?.code ??
        `http_${response.status}`;
      const errMsg =
        (parsed as { error?: { message?: string } } | null)?.error?.message ??
        (typeof parsed === "string" ? parsed : `Vercel ${method} ${path} failed`);
      throw new VercelApiError(
        response.status,
        errCode,
        `${method} ${path}`,
        redact(errMsg)
      );
    }

    return { status: response.status, data: parsed as T | null };
  }

  return {
    async createProject({ name, repo, nodeVersion, framework }) {
      // Raw Vercel response shape — wider than CreateProjectResult.
      type ApiResp = {
        id?: string;
        name?: string;
        link?: { repoId?: number } | null;
      };
      // POST /v9/projects accepts framework + gitRepository but NOT
      // nodeVersion ("Invalid request: should NOT have additional property
      // nodeVersion"). nodeVersion is settable only via PATCH after creation.
      // We do create + PATCH inside this method so the handler stays simple
      // and the failure mode is uniform.
      const { data } = await request<ApiResp>("POST", "/v9/projects", {
        name,
        framework,
        gitRepository: {
          type: "github",
          repo,
        },
      });
      if (!data?.id) {
        throw new VercelApiError(
          502,
          "missing_project_id",
          "POST /v9/projects",
          "Vercel returned no project id"
        );
      }

      // Apply post-create settings that the create endpoint rejects. If the
      // PATCH fails, the caller's catch block will delete the half-configured
      // project — same recovery as any other vercel call failing mid-flow.
      if (nodeVersion !== undefined) {
        await request<unknown>(
          "PATCH",
          `/v9/projects/${encodeURIComponent(data.id)}`,
          { nodeVersion }
        );
      }

      return {
        id: data.id,
        name: data.name ?? name,
        repoId: data.link?.repoId ?? null,
      };
    },

    async addDomain(projectId, domain) {
      await request<unknown>(
        "POST",
        `/v10/projects/${encodeURIComponent(projectId)}/domains`,
        { name: domain }
      );
    },

    async setEnv(projectId, key, value, targets, type = "encrypted") {
      await request<unknown>(
        "POST",
        `/v10/projects/${encodeURIComponent(projectId)}/env`,
        {
          key,
          value,
          type,
          target: targets,
        },
        { upsert: "true" }
      );
    },

    async deleteProject(projectId) {
      await request<unknown>(
        "DELETE",
        `/v9/projects/${encodeURIComponent(projectId)}`
      );
    },

    async removeDomain(projectId, domain) {
      await request<unknown>(
        "DELETE",
        `/v9/projects/${encodeURIComponent(projectId)}/domains/${encodeURIComponent(domain)}`
      );
    },

    async pollCertReady(domain, opts = {}) {
      const timeoutMs = opts.timeoutMs ?? 60_000;
      const deadline = Date.now() + timeoutMs;
      let delayMs = 1_000;
      while (Date.now() < deadline) {
        const { data } = await request<VercelDomainConfig>(
          "GET",
          `/v6/domains/${encodeURIComponent(domain)}/config`
        );
        if (data && data.misconfigured === false) return true;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
        delayMs = Math.min(delayMs * 2, 8_000);
      }
      return false;
    },

    async createDeployment({ projectId, name, repoId, ref, target = "production" }) {
      type ApiResp = { id?: string; url?: string };
      const { data } = await request<ApiResp>("POST", "/v13/deployments", {
        name,
        project: projectId,
        target,
        gitSource: { type: "github", repoId, ref },
      });
      if (!data?.id) {
        throw new VercelApiError(
          502,
          "missing_deployment_id",
          "POST /v13/deployments",
          "Vercel returned no deployment id"
        );
      }
      return { id: data.id, url: data.url ?? "" };
    },

    async pollDeploymentReady(deploymentId, opts = {}) {
      // Build time for a small Next.js app is typically 30-90s. 5 min covers
      // cold caches and queueing. Throw on ERROR/CANCELED so the handler can
      // roll back; return false only on timeout.
      const timeoutMs = opts.timeoutMs ?? 300_000;
      const deadline = Date.now() + timeoutMs;
      let delayMs = 2_000;
      while (Date.now() < deadline) {
        const { data } = await request<DeploymentStatus>(
          "GET",
          `/v13/deployments/${encodeURIComponent(deploymentId)}`
        );
        const state = data?.readyState;
        if (state === "READY") return true;
        if (state === "ERROR" || state === "CANCELED") {
          throw new VercelApiError(
            502,
            `deployment_${state.toLowerCase()}`,
            `GET /v13/deployments/${deploymentId}`,
            data?.errorMessage ?? `Deployment ${deploymentId} ended in ${state}`
          );
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remaining)));
        delayMs = Math.min(delayMs * 2, 10_000);
      }
      return false;
    },
  };
}
