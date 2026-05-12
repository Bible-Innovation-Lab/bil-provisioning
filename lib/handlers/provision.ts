// /provision handler. Composes auth + validation + KV claim + Vercel calls
// into one transactional flow. Pure async function — all I/O is injected via
// deps, so tests don't need a Hono context, a real HTTP server, or env vars.
//
// Flow (matches docs/PRD.md § F1 + docs/implementation-plan.md § Phase 4):
//   1. parse Bearer token
//   2. authenticate (verify token + org member)
//   3. parse + validate body shape
//   4. validate app_id (regex + denylist)
//   5. confirm repo is owned by configured org
//   6. atomically claim app_id in KV (5-min TTL)
//      - on collision: check existing record for idempotency (same repo →
//        return 409 with existing project_id)
//   7. try: createProject → addDomain → setEnv × 2 → pollCertReady →
//      confirmClaim → 201
//   8. catch: releaseAppId → 500 with provider error code
//   9. log structured event regardless of outcome

import { z } from "zod";
import { AuthError, authenticateOrgMember, parseBearerToken } from "../auth";
import type { OctokitRequest } from "../auth";
import {
  claimAppId,
  confirmClaim,
  getClaim,
  releaseAppId,
  type KvClient,
} from "../kv";
import { log } from "../log";
import { validateAppId } from "../validation";
import { VercelApiError, type VercelClient } from "../vercel-client";

const BodySchema = z.object({
  repo: z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, {
    message: "repo must be of form owner/name",
  }),
  app_id: z.string(),
});

export interface ProvisionConfig {
  org: string;
  adminTeamSlug: string;
  subdomainRoot: string;
  posthogKey: string;
  posthogHost: string;
}

export interface ProvisionDeps {
  kv: KvClient;
  vercel: VercelClient;
  octokit?: OctokitRequest;
  config: ProvisionConfig;
  now?: () => Date;
  requestId?: () => string;
}

export interface ProvisionRequest {
  authorization: string | null | undefined;
  body: unknown;
}

export type ProvisionResponse =
  | {
      status: 201;
      body: { url: string; project_id: string };
    }
  | {
      status: 409;
      body: { error: "already_provisioned"; project_id: string; url: string };
    }
  | {
      status: 400 | 401 | 403 | 500 | 502;
      body: { error: string };
    };

export async function handleProvision(
  req: ProvisionRequest,
  deps: ProvisionDeps
): Promise<ProvisionResponse> {
  const reqId = deps.requestId ? deps.requestId() : crypto.randomUUID();
  const logFields: Record<string, unknown> = { request_id: reqId };

  // 1. Parse Bearer
  const token = parseBearerToken(req.authorization ?? null);
  if (!token) {
    log("warn", "provision.rejected", { ...logFields, reason: "missing_token" });
    return { status: 401, body: { error: "missing_token" } };
  }

  // 2. Authenticate
  let user;
  try {
    user = await authenticateOrgMember(
      token,
      { org: deps.config.org, adminTeamSlug: deps.config.adminTeamSlug },
      deps.octokit
    );
    logFields.github_user = user.login;
  } catch (e) {
    if (e instanceof AuthError) {
      log("warn", "provision.rejected", { ...logFields, reason: e.code });
      return { status: e.status as 401 | 403 | 502, body: { error: e.code } };
    }
    log("error", "provision.auth_error", { ...logFields, error: String(e) });
    return { status: 502, body: { error: "github_unavailable" } };
  }

  // 3. Parse body shape
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    log("warn", "provision.rejected", {
      ...logFields,
      reason: "malformed_body",
      details: parsed.error.flatten(),
    });
    return { status: 400, body: { error: "malformed_body" } };
  }
  const { repo, app_id } = parsed.data;
  logFields.app_id = app_id;
  logFields.repo = repo;

  // 4. Validate app_id
  const validation = validateAppId(app_id);
  if (!validation.valid) {
    log("warn", "provision.rejected", { ...logFields, reason: validation.reason });
    return { status: 400, body: { error: validation.reason } };
  }

  // 5. Repo ownership check
  const [owner] = repo.split("/");
  if (owner !== deps.config.org) {
    log("warn", "provision.rejected", { ...logFields, reason: "repo_not_owned" });
    return { status: 400, body: { error: "repo_not_owned" } };
  }

  // 6. Atomic claim
  const domain = `${app_id}.${deps.config.subdomainRoot}`;
  const url = `https://${domain}`;

  const won = await claimAppId(app_id, repo, deps.kv);
  if (!won) {
    // Idempotency: if the same repo already owns this app_id, return 409 with
    // the existing project_id. Otherwise it's a real collision → 400.
    const existing = await getClaim(app_id, deps.kv);
    if (existing && existing.project_id && existing.repo === repo) {
      log("info", "provision.idempotent_hit", {
        ...logFields,
        project_id: existing.project_id,
      });
      return {
        status: 409,
        body: {
          error: "already_provisioned",
          project_id: existing.project_id,
          url,
        },
      };
    }
    log("warn", "provision.rejected", { ...logFields, reason: "app_id_taken" });
    return { status: 400, body: { error: "app_id_taken" } };
  }

  // 7. Vercel calls — rollback the claim on any failure.
  let projectId: string;
  try {
    const project = await deps.vercel.createProject({ name: app_id, repo });
    projectId = project.id;
    logFields.project_id = projectId;

    await deps.vercel.addDomain(projectId, domain);
    await deps.vercel.setEnv(projectId, "APP_ID", app_id, ["production", "preview"], "plain");
    await deps.vercel.setEnv(
      projectId,
      "POSTHOG_KEY",
      deps.config.posthogKey,
      ["production", "preview"]
    );
    await deps.vercel.setEnv(
      projectId,
      "POSTHOG_HOST",
      deps.config.posthogHost,
      ["production", "preview"],
      "plain"
    );

    // Best-effort: poll for cert readiness. Failure here doesn't fail the
    // provision — Vercel will continue provisioning the cert in the background.
    await deps.vercel
      .pollCertReady(domain, { timeoutMs: 60_000 })
      .catch((e) => log("warn", "provision.cert_poll_failed", { ...logFields, error: String(e) }));

    await confirmClaim(app_id, projectId, deps.kv);

    log("info", "provision.success", { ...logFields });
    return { status: 201, body: { url, project_id: projectId } };
  } catch (e) {
    await releaseAppId(app_id, deps.kv).catch(() => undefined);
    if (e instanceof VercelApiError) {
      log("error", "provision.vercel_error", {
        ...logFields,
        vercel_status: e.status,
        vercel_code: e.code,
        message: e.message,
      });
      return { status: 500, body: { error: "vercel_api_error" } };
    }
    log("error", "provision.internal_error", { ...logFields, error: String(e) });
    return { status: 500, body: { error: "internal" } };
  }
}
