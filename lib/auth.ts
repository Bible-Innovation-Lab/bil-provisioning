// GitHub auth primitives for bil-provisioning.
// Spec: docs/PRD.md § "Auth model".
//
// The student's bearer token (from device flow in launchpad's setup.sh) is
// used to call GitHub's per-user endpoints. We never use the service's own
// credentials to check user identity — the user proves who they are by
// presenting a token that's valid for their own GitHub account.
//
// Endpoint contract:
//   GET /user                                                 → who is the caller
//   GET /user/memberships/orgs/{org}                          → org membership (self)
//   GET /orgs/{org}/teams/{slug}/memberships/{user}           → team membership of self
//
// All three accept `read:org` scope. A 404 on a membership endpoint is the
// canonical "not a member" signal — GitHub does not 403 on these.

import { request as defaultRequest } from "@octokit/request";
import { RequestError } from "@octokit/request-error";

export type AuthErrorCode =
  | "missing_token"
  | "invalid_token"
  | "not_org_member"
  | "not_admin"
  | "github_unavailable";

export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;

  constructor(code: AuthErrorCode, status: number, message: string) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}

export interface AuthConfig {
  org: string;
  adminTeamSlug: string;
}

export interface AuthedUser {
  login: string;
}

// Minimal subset of @octokit/request we depend on. Tests pass a Vitest mock.
export type OctokitRequest = (
  route: string,
  options?: Record<string, unknown>
) => Promise<{ status: number; data: unknown }>;

function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function isRequestError(e: unknown): e is RequestError {
  return e instanceof Error && (e as { name?: string }).name === "HttpError";
}

/**
 * Verify a GitHub OAuth token and return the user's login. Throws AuthError
 * with status 401 on invalid/expired tokens, 502 on GitHub unavailability.
 */
export async function verifyGitHubToken(
  token: string,
  octokit: OctokitRequest = defaultRequest
): Promise<AuthedUser> {
  if (!token || typeof token !== "string") {
    throw new AuthError("missing_token", 401, "Authorization header missing or malformed");
  }

  try {
    const res = await octokit("GET /user", { headers: bearerHeaders(token) });
    const data = res.data as { login?: unknown };
    if (typeof data.login !== "string" || data.login.length === 0) {
      throw new AuthError("invalid_token", 401, "GitHub returned no login");
    }
    return { login: data.login };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (isRequestError(e)) {
      if (e.status === 401) {
        throw new AuthError("invalid_token", 401, "GitHub rejected the token");
      }
      if (e.status >= 500) {
        throw new AuthError("github_unavailable", 502, `GitHub returned ${e.status}`);
      }
    }
    throw new AuthError("github_unavailable", 502, "Unable to reach GitHub");
  }
}

/**
 * Assert that the authenticated user is an active member of the BIL org.
 * Uses /user/memberships/orgs/{org} so the call works with read:org scope on
 * the user's own token. Throws AuthError(403, "not_org_member") otherwise.
 */
export async function requireOrgMember(
  token: string,
  config: AuthConfig,
  octokit: OctokitRequest = defaultRequest
): Promise<void> {
  try {
    const res = await octokit("GET /user/memberships/orgs/{org}", {
      org: config.org,
      headers: bearerHeaders(token),
    });
    const data = res.data as { state?: unknown };
    if (data.state !== "active") {
      throw new AuthError(
        "not_org_member",
        403,
        `Org membership state is "${String(data.state)}", expected "active"`
      );
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (isRequestError(e)) {
      if (e.status === 404) {
        throw new AuthError("not_org_member", 403, `Not a member of ${config.org}`);
      }
      if (e.status === 401) {
        throw new AuthError("invalid_token", 401, "GitHub rejected the token");
      }
      if (e.status >= 500) {
        throw new AuthError("github_unavailable", 502, `GitHub returned ${e.status}`);
      }
    }
    throw new AuthError("github_unavailable", 502, "Unable to reach GitHub");
  }
}

/**
 * Assert that the authenticated user is an active member of the admin team
 * inside the BIL org. Used to gate /teardown + /status.
 */
export async function requireAdminTeamMember(
  token: string,
  login: string,
  config: AuthConfig,
  octokit: OctokitRequest = defaultRequest
): Promise<void> {
  try {
    const res = await octokit(
      "GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
      {
        org: config.org,
        team_slug: config.adminTeamSlug,
        username: login,
        headers: bearerHeaders(token),
      }
    );
    const data = res.data as { state?: unknown };
    if (data.state !== "active") {
      throw new AuthError(
        "not_admin",
        403,
        `Admin team membership state is "${String(data.state)}", expected "active"`
      );
    }
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (isRequestError(e)) {
      if (e.status === 404) {
        throw new AuthError(
          "not_admin",
          403,
          `${login} is not in ${config.org}/${config.adminTeamSlug}`
        );
      }
      if (e.status === 401) {
        throw new AuthError("invalid_token", 401, "GitHub rejected the token");
      }
      if (e.status >= 500) {
        throw new AuthError("github_unavailable", 502, `GitHub returned ${e.status}`);
      }
    }
    throw new AuthError("github_unavailable", 502, "Unable to reach GitHub");
  }
}

/**
 * Convenience composition: verify token + assert org member. Used by /provision.
 */
export async function authenticateOrgMember(
  token: string,
  config: AuthConfig,
  octokit: OctokitRequest = defaultRequest
): Promise<AuthedUser> {
  const user = await verifyGitHubToken(token, octokit);
  await requireOrgMember(token, config, octokit);
  return user;
}

/**
 * Convenience composition: verify token + assert admin team member.
 * Used by /teardown and /status.
 */
export async function authenticateAdmin(
  token: string,
  config: AuthConfig,
  octokit: OctokitRequest = defaultRequest
): Promise<AuthedUser> {
  const user = await verifyGitHubToken(token, octokit);
  await requireAdminTeamMember(token, user.login, config, octokit);
  return user;
}

/**
 * Extract the Bearer token from an Authorization header value. Returns null
 * if the header is missing or malformed.
 */
export function parseBearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match ? match[1].trim() : null;
}
