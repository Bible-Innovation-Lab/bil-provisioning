// /teardown handler. Admin-only reverse of /provision: remove the Vercel
// domain, delete the Vercel project, release the KV claim, log it.
//
// Spec: docs/PRD.md § F2 + docs/implementation-plan.md § Phase 5.
//
// Flow:
//   1. parse Bearer token
//   2. authenticate (admin team member)
//   3. parse + validate body shape
//   4. validate app_id format (regex; denylisted names are also rejected since
//      they could never have been claimed — saves an unnecessary KV round-trip)
//   5. read claim from KV
//      - missing claim → 404 not_found
//      - pending claim (no project_id, still within TTL) → release KV row and
//        return 200; nothing was ever fully provisioned, so there's no Vercel
//        state to clean up
//   6. removeDomain → deleteProject (treat Vercel 404 as already-gone, continue)
//   7. releaseAppId
//   8. on any non-404 Vercel error: leave the KV claim in place so the admin
//      can retry; surface the provider error code

import { z } from "zod";
import { AuthError, authenticateAdmin, parseBearerToken } from "../auth.js";
import type { OctokitRequest } from "../auth.js";
import { getClaim, releaseAppId, type KvClient } from "../kv.js";
import { log } from "../log.js";
import { validateAppId } from "../validation.js";
import { VercelApiError, type VercelClient } from "../vercel-client.js";

const BodySchema = z.object({
  app_id: z.string(),
});

export interface TeardownConfig {
  org: string;
  adminTeamSlug: string;
  subdomainRoot: string;
}

export interface TeardownDeps {
  kv: KvClient;
  vercel: VercelClient;
  octokit?: OctokitRequest;
  config: TeardownConfig;
  requestId?: () => string;
}

export interface TeardownRequest {
  authorization: string | null | undefined;
  body: unknown;
}

export type TeardownResponse =
  | {
      status: 200;
      body: { app_id: string; project_id: string | null; released: true };
    }
  | {
      status: 400 | 401 | 403 | 404 | 500 | 502;
      body: { error: string };
    };

export async function handleTeardown(
  req: TeardownRequest,
  deps: TeardownDeps
): Promise<TeardownResponse> {
  const reqId = deps.requestId ? deps.requestId() : crypto.randomUUID();
  const logFields: Record<string, unknown> = { request_id: reqId };

  // 1. Parse Bearer
  const token = parseBearerToken(req.authorization ?? null);
  if (!token) {
    log("warn", "teardown.rejected", { ...logFields, reason: "missing_token" });
    return { status: 401, body: { error: "missing_token" } };
  }

  // 2. Authenticate as admin
  let user;
  try {
    user = await authenticateAdmin(
      token,
      { org: deps.config.org, adminTeamSlug: deps.config.adminTeamSlug },
      deps.octokit
    );
    logFields.github_user = user.login;
  } catch (e) {
    if (e instanceof AuthError) {
      log("warn", "teardown.rejected", { ...logFields, reason: e.code });
      return { status: e.status as 401 | 403 | 502, body: { error: e.code } };
    }
    log("error", "teardown.auth_error", { ...logFields, error: String(e) });
    return { status: 502, body: { error: "github_unavailable" } };
  }

  // 3. Parse body shape
  const parsed = BodySchema.safeParse(req.body);
  if (!parsed.success) {
    log("warn", "teardown.rejected", {
      ...logFields,
      reason: "malformed_body",
      details: parsed.error.flatten(),
    });
    return { status: 400, body: { error: "malformed_body" } };
  }
  const { app_id } = parsed.data;
  logFields.app_id = app_id;

  // 4. Validate app_id (cheap pre-check; rejects garbage before KV)
  const validation = validateAppId(app_id);
  if (!validation.valid) {
    log("warn", "teardown.rejected", { ...logFields, reason: validation.reason });
    return { status: 400, body: { error: validation.reason } };
  }

  // 5. Look up claim
  const claim = await getClaim(app_id, deps.kv);
  if (!claim) {
    log("info", "teardown.not_found", { ...logFields });
    return { status: 404, body: { error: "not_found" } };
  }
  logFields.repo = claim.repo;

  // Pending claim (no project_id yet): nothing on Vercel to clean up. Just
  // drop the KV row so the app_id is freed.
  if (!claim.project_id) {
    await releaseAppId(app_id, deps.kv).catch(() => undefined);
    log("info", "teardown.released_pending", { ...logFields });
    return { status: 200, body: { app_id, project_id: null, released: true } };
  }

  const projectId = claim.project_id;
  logFields.project_id = projectId;
  const domain = `${app_id}.${deps.config.subdomainRoot}`;

  // 6. Remove domain, then delete project. 404s are treated as "already gone"
  // and don't block the rest of the cleanup — teardown is meant to converge to
  // "nothing left" regardless of partial prior state.
  try {
    try {
      await deps.vercel.removeDomain(projectId, domain);
    } catch (e) {
      if (e instanceof VercelApiError && e.status === 404) {
        log("info", "teardown.domain_already_gone", { ...logFields });
      } else {
        throw e;
      }
    }

    try {
      await deps.vercel.deleteProject(projectId);
    } catch (e) {
      if (e instanceof VercelApiError && e.status === 404) {
        log("info", "teardown.project_already_gone", { ...logFields });
      } else {
        throw e;
      }
    }
  } catch (e) {
    if (e instanceof VercelApiError) {
      log("error", "teardown.vercel_error", {
        ...logFields,
        vercel_status: e.status,
        vercel_code: e.code,
        message: e.message,
      });
      return { status: 500, body: { error: "vercel_api_error" } };
    }
    log("error", "teardown.internal_error", { ...logFields, error: String(e) });
    return { status: 500, body: { error: "internal" } };
  }

  // 7. Release the KV claim only after the Vercel cleanup succeeded.
  await releaseAppId(app_id, deps.kv).catch(() => undefined);

  log("info", "teardown.success", { ...logFields });
  return { status: 200, body: { app_id, project_id: projectId, released: true } };
}
