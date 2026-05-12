// /health handler. Unauthenticated liveness check for external pingers
// (Pingdom / Better Stack). Spec: docs/PRD.md § F4.
//
// Intentionally trivial: no KV roundtrip, no GitHub call, no Vercel call.
// If the function cold-starts and runs this, the service is alive enough to
// serve traffic. p99 < 100ms per NF2.

export interface HealthDeps {
  now?: () => Date;
}

export interface HealthResponse {
  status: 200;
  body: { status: "ok"; ts: string };
}

export function handleHealth(deps: HealthDeps = {}): HealthResponse {
  const now = deps.now ? deps.now() : new Date();
  return {
    status: 200,
    body: { status: "ok", ts: now.toISOString() },
  };
}
