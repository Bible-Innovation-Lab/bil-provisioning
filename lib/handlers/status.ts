// /status handler. Admin-only read of the KV claim row for a given app_id.
// Used by ops/admin tools to confirm whether a subdomain is taken and which
// Vercel project owns it.
//
// Spec: docs/PRD.md § F3 + docs/implementation-plan.md § Phase 5.
//
// Flow:
//   1. parse Bearer token
//   2. authenticate (admin team member)
//   3. require app_id query parameter
//   4. validate app_id format (regex; denylisted names are also rejected, as
//      with /teardown — they could never have been claimed)
//   5. read claim from KV
//      - missing → 200 { claimed: false }
//      - pending (no project_id, TTL still active) → 200 { claimed: true,
//        state: "pending", … }
//      - confirmed (has project_id) → 200 { claimed: true, state: "active", … }

import { authenticateAdmin, AuthError, parseBearerToken } from "../auth";
import type { OctokitRequest } from "../auth";
import { getClaim, type KvClient } from "../kv";
import { log } from "../log";
import { validateAppId } from "../validation";

export interface StatusConfig {
  org: string;
  adminTeamSlug: string;
  subdomainRoot: string;
}

export interface StatusDeps {
  kv: KvClient;
  octokit?: OctokitRequest;
  config: StatusConfig;
  requestId?: () => string;
}

export interface StatusRequest {
  authorization: string | null | undefined;
  query: { app_id?: string | string[] | undefined } | null | undefined;
}

export type StatusResponse =
  | {
      status: 200;
      body:
        | { app_id: string; claimed: false }
        | {
            app_id: string;
            claimed: true;
            state: "active" | "pending";
            repo: string;
            claimed_at: string;
            project_id: string | null;
            url: string;
          };
    }
  | {
      status: 400 | 401 | 403 | 502;
      body: { error: string };
    };

function firstQueryValue(
  value: string | string[] | undefined | null
): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

export async function handleStatus(
  req: StatusRequest,
  deps: StatusDeps
): Promise<StatusResponse> {
  const reqId = deps.requestId ? deps.requestId() : crypto.randomUUID();
  const logFields: Record<string, unknown> = { request_id: reqId };

  // 1. Parse Bearer
  const token = parseBearerToken(req.authorization ?? null);
  if (!token) {
    log("warn", "status.rejected", { ...logFields, reason: "missing_token" });
    return { status: 401, body: { error: "missing_token" } };
  }

  // 2. Authenticate as admin
  try {
    const user = await authenticateAdmin(
      token,
      { org: deps.config.org, adminTeamSlug: deps.config.adminTeamSlug },
      deps.octokit
    );
    logFields.github_user = user.login;
  } catch (e) {
    if (e instanceof AuthError) {
      log("warn", "status.rejected", { ...logFields, reason: e.code });
      return { status: e.status as 401 | 403 | 502, body: { error: e.code } };
    }
    log("error", "status.auth_error", { ...logFields, error: String(e) });
    return { status: 502, body: { error: "github_unavailable" } };
  }

  // 3. Require app_id query param
  const appId = firstQueryValue(req.query?.app_id);
  if (!appId) {
    log("warn", "status.rejected", { ...logFields, reason: "missing_app_id" });
    return { status: 400, body: { error: "missing_app_id" } };
  }
  logFields.app_id = appId;

  // 4. Validate app_id format
  const validation = validateAppId(appId);
  if (!validation.valid) {
    log("warn", "status.rejected", { ...logFields, reason: validation.reason });
    return { status: 400, body: { error: validation.reason } };
  }

  // 5. Look up claim
  const claim = await getClaim(appId, deps.kv);
  const url = `https://${appId}.${deps.config.subdomainRoot}`;

  if (!claim) {
    log("info", "status.unclaimed", { ...logFields });
    return { status: 200, body: { app_id: appId, claimed: false } };
  }

  const state: "active" | "pending" = claim.project_id ? "active" : "pending";
  log("info", "status.found", { ...logFields, state });
  return {
    status: 200,
    body: {
      app_id: appId,
      claimed: true,
      state,
      repo: claim.repo,
      claimed_at: claim.claimed_at,
      project_id: claim.project_id ?? null,
      url,
    },
  };
}
