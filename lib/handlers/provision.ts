// /provision handler. Composes auth + validation + KV claim + Vercel calls
// into one transactional flow. Pure async function — all I/O is injected via
// deps, so tests don't need a Hono context, a real HTTP server, or env vars.
//
// Flow (docs/PRD.md § F1 + docs/implementation-plan.md § Phase 4):
//   1. parse Bearer token
//   2. authenticate (verify token + org member)
//   3. parse + validate body shape
//   4. validate app_id (regex + denylist)
//   5. confirm repo is owned by configured org
//   6. atomically claim app_id in KV (5-min TTL)
//      - on collision: check existing record for idempotency (same repo →
//        return 409 with existing project_id)
//   7. try: createProject → addDomain → setEnv × 3 → createDeployment →
//      pollDeploymentReady → pollCertReady → confirmClaim → 201
//   8. catch: removeDomain (best-effort) → deleteProject (best-effort) →
//      releaseAppId → 500
//   9. log structured event regardless of outcome
//
// Note on step 7: linking a Vercel project to a GitHub repo via createProject
// does NOT auto-trigger a build. Without an explicit createDeployment, the
// project exists with zero deployments and the returned URL resolves to a
// 404 page. Discovered 2026-05-12 during the first real /provision call
// against bible-trivia. The deploy + poll keeps /provision a synchronous,
// converging contract: "201 means the URL really serves your app." On any
// failure after createProject, the catch block deletes the orphan project
// so the next retry starts clean.

import { z } from "zod";
import { AuthError, authenticateOrgMember, parseBearerToken } from "../auth.js";
import type { OctokitRequest } from "../auth.js";
import {
  claimAppId,
  confirmClaim,
  getClaim,
  releaseAppId,
  type KvClient,
} from "../kv.js";
import { log } from "../log.js";
import { validateAppId } from "../validation.js";
import { VercelApiError, type VercelClient } from "../vercel-client.js";

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
  youversionApiKey: string;
  // Shared Upstash Redis (REST) credentials injected into student projects
  // for multiplayer (`@bil/launchpad/realtime`). Optional: when either is
  // empty/undefined, the keys are not injected and apps fall back to a
  // dev-only in-memory store. Inject as a pair or not at all.
  appUpstashRedisRestUrl?: string;
  appUpstashRedisRestToken?: string;
}

export interface ProvisionDeps {
  kv: KvClient;
  vercel: VercelClient;
  octokit?: OctokitRequest;
  config: ProvisionConfig;
  now?: () => Date;
  requestId?: () => string;
  // Debug-only escape hatch (PROVISION_DEBUG_KEEP_FAILED=1 in service env).
  // When true, the rollback path skips deleteProject so a failed deployment's
  // build log remains inspectable via `vercel inspect --logs`. Orphan Vercel
  // projects must be manually cleaned up after each failed run. The KV claim
  // is still released regardless.
  debugKeepFailed?: boolean;
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
      // 500 carries optional Vercel error context so the caller (setup.sh)
      // can surface the real cause without log-spelunking. Other failure
      // codes stay tight.
      status: 500;
      body: {
        error: string;
        vercel_code?: string;
        vercel_status?: number;
        message?: string;
        project_id?: string;
        deployment_id?: string;
      };
    }
  | {
      status: 400 | 401 | 403 | 502;
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

  // 7. Vercel calls — rollback the claim AND the project on any failure
  // after createProject. Without project rollback the next /provision retry
  // would 409 on the orphan project name.
  let projectId: string | null = null;
  try {
    const project = await deps.vercel.createProject({
      name: app_id,
      repo,
      // Vercel's defaults are wrong for our purposes — see CreateProjectInput
      // in vercel-client.ts. These match the launchpad's build expectations.
      nodeVersion: "22.x",
      framework: "nextjs",
      // Students push to their own forks from their own GitHub identities;
      // bil-provisioning runs on a separate Vercel team they're not members
      // of. Vercel's default gitForkProtection: true would block every
      // student push with TEAM_ACCESS_REQUIRED. Disabling it makes
      // GitHub repo push access the deploy boundary, which is the right
      // model for the BIL setup (private org repos, per-student access).
      gitForkProtection: false,
    });
    projectId = project.id;
    logFields.project_id = projectId;

    if (project.repoId === null) {
      // Should be impossible — we passed gitRepository, Vercel always returns
      // link.repoId on success. Belt-and-braces so the deploy step doesn't
      // silently misfire if Vercel's response shape changes.
      throw new VercelApiError(
        502,
        "missing_repo_id",
        "POST /v9/projects",
        "Vercel project returned without a linked repoId"
      );
    }

    await deps.vercel.enableWebAnalytics(projectId);

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
    await deps.vercel.setEnv(
      projectId,
      "YOUVERSION_API_KEY",
      deps.config.youversionApiKey,
      ["production", "preview"]
    );

    // Multiplayer: inject the shared Upstash Redis credentials so games
    // built on `@bil/launchpad/realtime` get cross-invocation state out of
    // the box. Only when BOTH are configured on the service — a half pair is
    // useless (the store needs url + token together) and is treated as "not
    // configured" so the app cleanly falls back to its dev in-memory store.
    const injectUpstash = Boolean(
      deps.config.appUpstashRedisRestUrl && deps.config.appUpstashRedisRestToken
    );
    if (injectUpstash) {
      await deps.vercel.setEnv(
        projectId,
        "UPSTASH_REDIS_REST_URL",
        deps.config.appUpstashRedisRestUrl as string,
        ["production", "preview"]
      );
      await deps.vercel.setEnv(
        projectId,
        "UPSTASH_REDIS_REST_TOKEN",
        deps.config.appUpstashRedisRestToken as string,
        ["production", "preview"]
      );
    }
    logFields.multiplayer_enabled = injectUpstash;

    // Vercel env-var propagation isn't atomic — setEnv returns before the
    // value is visible to a subsequent build. Poll until all required keys
    // appear before triggering the first deployment, so the build doesn't
    // see stale state.
    await deps.vercel.pollEnvReady(
      projectId,
      [
        "APP_ID",
        "POSTHOG_KEY",
        "POSTHOG_HOST",
        "YOUVERSION_API_KEY",
        ...(injectUpstash
          ? ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]
          : []),
      ],
      { timeoutMs: 10_000 }
    );

    // Trigger the first deployment. createProject + git-link does NOT
    // auto-deploy; the URL stays 404 until something pushes to main or
    // somebody POSTs /v13/deployments. This is the somebody.
    const deployment = await deps.vercel.createDeployment({
      projectId,
      name: app_id,
      repoId: project.repoId,
      ref: "main",
    });
    logFields.deployment_id = deployment.id;
    await deps.vercel.pollDeploymentReady(deployment.id, { timeoutMs: 300_000 });

    // Best-effort: poll for cert readiness. Failure here doesn't fail the
    // provision — Vercel keeps provisioning the cert in the background and
    // the URL becomes serveable within a few seconds after.
    await deps.vercel
      .pollCertReady(domain, { timeoutMs: 60_000 })
      .catch((e) => log("warn", "provision.cert_poll_failed", { ...logFields, error: String(e) }));

    await confirmClaim(app_id, projectId, deps.kv);

    log("info", "provision.success", { ...logFields });
    return { status: 201, body: { url, project_id: projectId } };
  } catch (e) {
    // Project rollback first (best-effort), then claim release. Doing them
    // in this order means a deleteProject failure still results in the claim
    // being freed — students aren't locked out of the app_id by a Vercel
    // hiccup during cleanup. Debug-mode skips the rollback so a failed
    // deployment's build log stays inspectable.
    if (projectId !== null) {
      if (deps.debugKeepFailed) {
        log("warn", "provision.debug_kept_failed_project", {
          ...logFields,
          project_id: projectId,
        });
      } else {
        // Detach the subdomain BEFORE deleting the project. deleteProject
        // alone does not release the team-level claim on a custom subdomain,
        // so without this any failure after addDomain (very commonly: the
        // first deployment's build fails) leaves <app_id>.<root> orphaned
        // in the team's domain pool. The next retry then 409s on addDomain
        // even though the project itself is gone. Best-effort: addDomain
        // may not have actually succeeded yet (e.g. createProject failed),
        // in which case Vercel returns 404 and we just log and continue.
        await deps.vercel.removeDomain(projectId, domain).catch((err) =>
          log("warn", "provision.rollback_remove_domain_failed", {
            ...logFields,
            error: String(err),
          })
        );
        await deps.vercel.deleteProject(projectId).catch((err) =>
          log("warn", "provision.rollback_delete_failed", {
            ...logFields,
            error: String(err),
          })
        );
      }
    }
    await releaseAppId(app_id, deps.kv).catch(() => undefined);
    if (e instanceof VercelApiError) {
      log("error", "provision.vercel_error", {
        ...logFields,
        vercel_status: e.status,
        vercel_code: e.code,
        message: e.message,
      });
      return {
        status: 500,
        body: {
          error: "vercel_api_error",
          vercel_code: e.code,
          vercel_status: e.status,
          message: e.message,
          project_id: projectId ?? undefined,
          deployment_id: (logFields.deployment_id as string | undefined) ?? undefined,
        },
      };
    }
    log("error", "provision.internal_error", { ...logFields, error: String(e) });
    return { status: 500, body: { error: "internal" } };
  }
}
