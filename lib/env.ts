// Typed env loader. Reads from process.env once at module load, validates
// required vars, and fails fast if any are missing.
//
// Used by api/* Vercel functions to build deps for lib/handlers/*. Tests
// never import this module — they construct ServiceConfig + deps directly.

export interface ServiceConfig {
  // GitHub
  org: string;
  adminTeamSlug: string;
  oauthClientId: string;
  oauthClientSecret: string;

  // Vercel
  vercelApiToken: string;
  vercelTeamId: string;

  // PostHog
  posthogKey: string;
  posthogHost: string;

  // Service
  subdomainRoot: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `Missing required env var: ${name}. See .env.example for the full list.`
    );
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

export function loadServiceConfig(): ServiceConfig {
  const logLevel = optionalEnv("LOG_LEVEL", "info");
  if (!["debug", "info", "warn", "error"].includes(logLevel)) {
    throw new Error(`LOG_LEVEL must be one of debug|info|warn|error, got: ${logLevel}`);
  }

  return {
    org: requireEnv("GITHUB_ORG"),
    adminTeamSlug: requireEnv("GITHUB_ADMIN_TEAM_SLUG"),
    oauthClientId: requireEnv("GITHUB_OAUTH_CLIENT_ID"),
    oauthClientSecret: requireEnv("GITHUB_OAUTH_CLIENT_SECRET"),
    vercelApiToken: requireEnv("VERCEL_API_TOKEN"),
    vercelTeamId: requireEnv("VERCEL_TEAM_ID"),
    posthogKey: requireEnv("POSTHOG_KEY"),
    posthogHost: optionalEnv("POSTHOG_HOST", "https://us.i.posthog.com"),
    subdomainRoot: requireEnv("SUBDOMAIN_ROOT"),
    logLevel: logLevel as ServiceConfig["logLevel"],
  };
}
